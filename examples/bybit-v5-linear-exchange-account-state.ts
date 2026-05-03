import { DefaultLogger, RestClientV5, WebsocketClient } from 'bybit-api';
import 'dotenv/config';

import {
  ExchangeAccountStateStore,
  type AccountScope,
  type ExchangeAccount,
  type NormalizedOrder,
} from 'accountstate';
import {
  bybit,
  classifyBybitSubmissionError,
  isBybitUnknownOrderError,
  type BybitV5PrivateEvent,
} from 'accountstate/bybit';

const key = process.env.BYBIT_API_KEY || '';
const secret = process.env.BYBIT_API_SECRET || '';
const useDemoTrading = process.env.BYBIT_DEMO_TRADING === 'true';
const useTestnet = !useDemoTrading && process.env.BYBIT_TESTNET === 'true';
const enableLiveSubmissions =
  process.env.ACCOUNTSTATE_EXAMPLE_LIVE_SUBMISSIONS === 'true';

if (!key || !secret) {
  console.error(
    'Set BYBIT_API_KEY and BYBIT_API_SECRET before running this example.',
  );
  process.exit(1);
}

const scope: AccountScope = {
  exchange: 'bybit',
  accountId: 'primary',
  product: 'linear',
  environment: useDemoTrading ? 'demo' : useTestnet ? 'testnet' : 'mainnet',
};

const clientOptions = {
  key,
  secret,
  testnet: useTestnet,
  demoTrading: useDemoTrading,
};

const rest = new RestClientV5(clientOptions);
const state = new ExchangeAccountStateStore();
const logger = {
  ...DefaultLogger,
  silly: () => undefined,
};
const ws = new WebsocketClient(clientOptions, logger);

let pendingPlannerPass: ReturnType<typeof setTimeout> | undefined;

async function refreshFromRest(reason: string): Promise<void> {
  const [positions, activeOrders, walletBalances, executions] =
    await Promise.all([
      rest.getPositionInfo({ category: 'linear', settleCoin: 'USDT' }),
      rest.getActiveOrders({ category: 'linear', settleCoin: 'USDT' }),
      rest.getWalletBalance({ accountType: 'UNIFIED' }),
      rest.getExecutionList({
        category: 'linear',
        settleCoin: 'USDT',
        limit: 50,
      }),
    ]);

  state.ingest(bybit.rest.positions(scope, positions.result.list));
  state.ingest(bybit.rest.activeOrders(scope, activeOrders.result.list));
  state.ingest(bybit.rest.walletBalances(scope, walletBalances.result.list));
  state.ingest(bybit.rest.executions(scope, executions.result.list));

  logProjection(reason, state.getAccount(scope));
}

async function checkStateFromRest(): Promise<void> {
  const account = state.getAccount(scope, {
    requiredSubjects: ['positions', 'openOrders', 'balances'],
  });
  const subjects = new Set(account.stateChecks.map((check) => check.subject));

  if (subjects.has('positions')) {
    const response = await rest.getPositionInfo({
      category: 'linear',
      settleCoin: 'USDT',
    });
    state.ingest(bybit.rest.positions(scope, response.result.list));
  }

  if (subjects.has('openOrders')) {
    const response = await rest.getActiveOrders({
      category: 'linear',
      settleCoin: 'USDT',
    });
    state.ingest(bybit.rest.activeOrders(scope, response.result.list));
  }

  if (subjects.has('balances')) {
    const response = await rest.getWalletBalance({ accountType: 'UNIFIED' });
    state.ingest(bybit.rest.walletBalances(scope, response.result.list));
  }

  if (subjects.has('fills')) {
    const response = await rest.getExecutionList({
      category: 'linear',
      settleCoin: 'USDT',
      limit: 50,
    });
    state.ingest(bybit.rest.executions(scope, response.result.list));
  }
}

function onPrivateEvent(event: BybitV5PrivateEvent): void {
  const facts = bybit.ws.privateEvent(scope, event);
  if (facts.length === 0) {
    return;
  }

  const changes = state.ingest(facts);
  const changeSets = Array.isArray(changes) ? changes : [changes];
  const shouldPlan = changeSets.some((change) =>
    change.changedSubjects.some(
      (subject) =>
        subject === 'positions' ||
        subject === 'openOrders',
    ),
  );

  if (shouldPlan) {
    schedulePlannerPass('private_ws');
  }
}

function schedulePlannerPass(reason: string): void {
  if (pendingPlannerPass) {
    clearTimeout(pendingPlannerPass);
  }

  pendingPlannerPass = setTimeout(() => {
    pendingPlannerPass = undefined;
    void plannerPass(reason).catch((error) => {
      console.error(new Date(), 'planner pass failed:', error);
    });
  }, 25);
}

async function plannerPass(reason: string): Promise<void> {
  const account = state.getAccount(scope, {
    requiredSubjects: ['positions', 'openOrders', 'balances'],
  });
  logProjection(reason, account);

  if (!account.readyToTrade) {
    await checkStateFromRest();
    return;
  }

  const intents = plan(account);
  for (const intent of intents) {
    await submitAndRecord(intent);
  }
}

function plan(_account: ExchangeAccount): OrderIntent[] {
  return [];
}

async function submitAndRecord(intent: OrderIntent): Promise<void> {
  if (!enableLiveSubmissions) {
    console.log(
      new Date(),
      'Live submissions disabled. Set ACCOUNTSTATE_EXAMPLE_LIVE_SUBMISSIONS=true to wire real submit/cancel calls.',
    );
    return;
  }

  try {
    const response = await submitToExchange(intent);

    if (intent.action === 'place') {
      state.recordOrderAccepted({
        scope,
        intentId: intent.intentId,
        customOrderId: intent.order.customOrderId,
        order: intent.order,
        responseSummary: response,
      });
      return;
    }

    state.recordOrderCancelled({
      scope,
      intentId: intent.intentId,
      identity: intent.identity,
      responseSummary: response,
    });
  } catch (error) {
    if (intent.action === 'cancel' && isBybitUnknownOrderError(error)) {
      state.recordOrderNotFound({
        scope,
        identity: intent.identity,
      });
      return;
    }

    state.recordOrderRejected({
      scope,
      intentId: intent.intentId,
      customOrderId:
        intent.action === 'place' ? intent.order.customOrderId : undefined,
      error: classifyBybitSubmissionError(error),
    });

    throw error;
  }
}

async function submitToExchange(_intent: OrderIntent): Promise<unknown> {
  throw new Error('Wire this function to your Bybit submit/cancel code.');
}

function logProjection(reason: string, account: ExchangeAccount): void {
  console.log(new Date(), 'account_state_projected', {
    reason,
    product: account.scope.product,
    positions: account.positions.length,
    openOrders: account.openOrders.length,
    balances: account.balances.length,
    readyToTrade: account.readyToTrade,
    stateChecks: account.stateChecks.map((check) => ({
      subject: check.subject,
      reason: check.reason,
      priority: check.priority,
    })),
  });
}

async function main(): Promise<void> {
  await refreshFromRest('startup');
  await plannerPass('startup');

  ws.on('update', (event) => {
    onPrivateEvent(event as BybitV5PrivateEvent);
  });

  ws.on('reconnect', () => {
    state.recordStreamDisconnected(scope, {
      reason: 'Bybit private WebSocket stream reconnecting',
    });
  });

  ws.on('reconnected', async () => {
    state.recordStreamReconnected(scope, {
      reason: 'Bybit private WebSocket stream reconnected',
    });
    await checkStateFromRest();
    await plannerPass('reconnected');
  });

  ws.on('exception', (error: unknown) => {
    console.error(new Date(), 'Bybit websocket error:', error);
  });

  ws.subscribeV5(['position', 'order', 'execution', 'wallet'], 'linear', true);
}

type OrderIntent =
  | {
      action: 'place';
      intentId: string;
      order: NormalizedOrder;
    }
  | {
      action: 'cancel';
      intentId: string;
      identity:
        | { exchangeOrderId: string }
        | { customOrderId: string }
        | { exchangeTriggerOrderId: string }
        | { customTriggerOrderId: string };
    };

void main().catch((error) => {
  console.error(new Date(), 'example failed:', error);
  process.exit(1);
});
