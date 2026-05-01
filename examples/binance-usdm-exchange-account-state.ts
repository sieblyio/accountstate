import {
  DefaultLogger,
  USDMClient,
  WebsocketClient,
} from 'binance';
import 'dotenv/config';

import {
  ExchangeAccountStateStore,
  type AccountScope,
  type ExchangeAccount,
  type NormalizedOrder,
} from '../src/index.js';
import {
  binance,
  classifyBinanceSubmissionError,
  isBinanceUnknownOrderError,
} from '../src/adapters/binance/index.js';

const key = process.env.BINANCE_API_KEY || '';
const secret = process.env.BINANCE_API_SECRET || '';
const enableLiveSubmissions =
  process.env.ACCOUNTSTATE_EXAMPLE_LIVE_SUBMISSIONS === 'true';

if (!key || !secret) {
  console.error(
    'Set BINANCE_API_KEY and BINANCE_API_SECRET before running this example.',
  );
  process.exit(1);
}

const scope: AccountScope = {
  exchange: 'binance',
  accountId: 'primary',
  product: 'usdm',
  environment: 'mainnet',
};

const usdm = new USDMClient({
  api_key: key,
  api_secret: secret,
  beautifyResponses: true,
});

const state = new ExchangeAccountStateStore();
const logger = {
  ...DefaultLogger,
  silly: () => undefined,
};
const ws = new WebsocketClient(
  {
    api_key: key,
    api_secret: secret,
    beautify: true,
  },
  logger,
);

let pendingPlannerPass: ReturnType<typeof setTimeout> | undefined;

async function syncFromRest(reason: string): Promise<void> {
  state.ingest(binance.rest.positions(scope, await usdm.getPositionsV3()));
  state.ingest(binance.rest.openOrders(scope, await usdm.getAllOpenOrders()));
  state.ingest(
    binance.rest.openAlgoOrders(scope, await usdm.getOpenAlgoOrders()),
  );

  logProjection(reason, state.getAccount(scope));
}

async function syncRequestedStateFromRest(): Promise<void> {
  const account = state.getAccount(scope, {
    requiredSubjects: ['positions', 'openOrders'],
  });
  const subjects = new Set(account.syncRequests.map((request) => request.subject));

  if (subjects.has('positions')) {
    state.ingest(binance.rest.positions(scope, await usdm.getPositionsV3()));
  }

  if (subjects.has('openOrders')) {
    state.ingest(binance.rest.openOrders(scope, await usdm.getAllOpenOrders()));
    state.ingest(
      binance.rest.openAlgoOrders(scope, await usdm.getOpenAlgoOrders()),
    );
  }
}

function onUserDataEvent(event: unknown): void {
  const changes = state.ingest(binance.ws.userDataEvent(scope, event as never));
  const changeSets = Array.isArray(changes) ? changes : [changes];
  const shouldPlan = changeSets.some((change) =>
    change.changedSubjects.some(
      (subject) =>
        subject === 'positions' ||
        subject === 'openOrders' ||
        subject === 'lifecycles',
    ),
  );

  if (shouldPlan) {
    schedulePlannerPass('user_data');
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
    requiredSubjects: ['positions', 'openOrders'],
  });
  logProjection(reason, account);

  if (!account.readyToTrade) {
    await syncRequestedStateFromRest();
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
      state.orderAccepted({
        scope,
        intentId: intent.intentId,
        clientOrderId: intent.order.customClientOrderId,
        order: intent.order,
        responseSummary: response,
      });
      return;
    }

    state.orderCancelled({
      scope,
      intentId: intent.intentId,
      identity: intent.identity,
      responseSummary: response,
    });
  } catch (error) {
    if (intent.action === 'cancel' && isBinanceUnknownOrderError(error)) {
      state.orderNotFound({
        scope,
        identity: intent.identity,
      });
      return;
    }

    state.orderRejected({
      scope,
      intentId: intent.intentId,
      clientOrderId:
        intent.action === 'place' ? intent.order.customClientOrderId : undefined,
      error: classifyBinanceSubmissionError(error),
    });

    throw error;
  }
}

async function submitToExchange(_intent: OrderIntent): Promise<unknown> {
  throw new Error('Wire this function to your Binance submit/cancel code.');
}

function logProjection(reason: string, account: ExchangeAccount): void {
  console.log(new Date(), 'account_state_projected', {
    reason,
    product: account.scope.product,
    positions: account.positions.length,
    openOrders: account.openOrders.length,
    lifecycles: account.lifecycles.length,
    readyToTrade: account.readyToTrade,
    syncRequests: account.syncRequests.map((request) => ({
      subject: request.subject,
      reason: request.reason,
      priority: request.priority,
    })),
  });
}

async function main(): Promise<void> {
  await syncFromRest('startup');
  await plannerPass('startup');

  ws.on('formattedMessage', (event) => {
    onUserDataEvent(event);
  });

  ws.on('reconnecting', () => {
    state.streamDisconnected(scope, { reason: 'Binance user data reconnecting' });
  });

  ws.on('reconnected', async (data) => {
    state.streamReconnected(scope, { reason: 'Binance user data reconnected' });

    if (data?.wsKey && String(data.wsKey).includes('userData')) {
      await syncRequestedStateFromRest();
      await plannerPass('reconnected');
    }
  });

  ws.on('exception', (error: unknown) => {
    console.error(new Date(), 'Binance websocket error:', error);
  });

  ws.subscribeUsdFuturesUserDataStream();
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
        | { customClientOrderId: string }
        | { exchangeTriggerOrderId: string }
        | { customTriggerOrderId: string };
    };

void main().catch((error) => {
  console.error(new Date(), 'example failed:', error);
  process.exit(1);
});
