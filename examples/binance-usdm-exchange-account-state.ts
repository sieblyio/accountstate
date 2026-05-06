import { DefaultLogger, USDMClient, WebsocketClient } from 'binance';
import 'dotenv/config';

import {
  ExchangeAccountStateStore,
  type AccountScope,
  type ExchangeAccount,
  type StateCheck,
} from 'accountstate';
import { binance, type BinanceUsdmPrivateEvent } from 'accountstate/binance';

const key = process.env.BINANCE_API_KEY || '';
const secret = process.env.BINANCE_API_SECRET || '';

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
    // Use formatted events for accountstate. Raw one-letter events may also be
    // emitted on another event name; do not feed both shapes into the store.
    beautify: true,
  },
  logger,
);

async function refreshFromRest(reason: string): Promise<void> {
  const [positions, regularOrders, algoOrders, account] = await Promise.all([
    usdm.getPositionsV3(),
    usdm.getAllOpenOrders(),
    usdm.getOpenAlgoOrders(),
    usdm.getAccountInformationV3(),
  ]);

  state.ingest(binance.rest.positions(scope, positions));
  state.ingest(binance.rest.openOrders(scope, regularOrders));
  state.ingest(binance.rest.openAlgoOrders(scope, algoOrders));
  state.ingest(binance.rest.accountBalances(scope, account.assets));

  logAccountState(reason);
}

async function checkStateFromRest(reason: string): Promise<void> {
  const checks = state.getAccount(scope).stateChecks;

  if (checks.length === 0) {
    return;
  }

  const subjects = new Set(checks.map((check) => check.subject));

  if (subjects.has('positions')) {
    state.ingest(binance.rest.positions(scope, await usdm.getPositionsV3()));
  }

  if (subjects.has('openOrders')) {
    state.ingest(binance.rest.openOrders(scope, await usdm.getAllOpenOrders()));
    state.ingest(
      binance.rest.openAlgoOrders(scope, await usdm.getOpenAlgoOrders()),
    );
  }

  if (subjects.has('balances')) {
    const account = await usdm.getAccountInformationV3();
    state.ingest(binance.rest.accountBalances(scope, account.assets));
  }

  logStateChecks(`${reason}:rest_checked`, checks);
  logAccountState(`${reason}:rest_checked`);
}

function onPrivateEvent(event: BinanceUsdmPrivateEvent): void {
  state.ingest(binance.ws.privateEvent(scope, event));

  const routes = binance.ws.routePrivateEvent(event);
  if (routes.length > 0) {
    console.log(new Date(), 'binance_private_routes', {
      fingerprint: binance.ws.fingerprintPrivateEvent(event),
      routes: routes.map((route) => ({
        kind: route.kind,
        symbol: 'symbol' in route ? route.symbol : undefined,
        customOrderId: 'customOrderId' in route ? route.customOrderId : undefined,
        customTriggerOrderId:
          'customTriggerOrderId' in route
            ? route.customTriggerOrderId
            : undefined,
        status: 'orderStatus' in route ? route.orderStatus : undefined,
      })),
    });
  }
}

function logStateChecks(reason: string, checks: StateCheck[]): void {
  console.log(new Date(), 'state_checks', {
    reason,
    checks: checks.map((check) => ({
      subject: check.subject,
      reason: check.reason,
      priority: check.priority,
    })),
  });
}

function logAccountState(reason: string): void {
  const account = state.getAccount(scope);
  console.log(new Date(), 'account_state', projectAccount(account, reason));
}

function projectAccount(account: ExchangeAccount, reason: string): object {
  return {
    reason,
    readyToTrade: account.readyToTrade,
    positions: account.positions.map((position) => ({
      symbol: position.symbol,
      side: position.exchangePositionSide,
      strategySide: position.strategySide,
      quantity: position.quantity,
      entry: position.averageEntry,
    })),
    openOrders: account.openOrders.map((order) => ({
      symbol: order.symbol,
      kind: order.kind,
      side: order.side,
      status: order.status,
      customOrderId: order.customOrderId,
      customTriggerOrderId: order.customTriggerOrderId,
      quantity: order.quantity,
      price: order.price,
      triggerPrice: order.triggerPrice,
    })),
    balances: account.balances.map((balance) => ({
      asset: balance.asset,
      wallet: balance.walletBalance,
      available: balance.availableBalance,
    })),
    stateChecks: account.stateChecks.map((check) => ({
      subject: check.subject,
      reason: check.reason,
      priority: check.priority,
    })),
  };
}

async function main(): Promise<void> {
  await refreshFromRest('startup');

  ws.on('formattedMessage', (event) => {
    onPrivateEvent(event as BinanceUsdmPrivateEvent);
  });

  ws.on('reconnecting', () => {
    state.recordStreamDisconnected(scope, {
      reason: 'Binance private WebSocket stream reconnecting',
    });
  });

  ws.on('reconnected', async () => {
    state.recordStreamReconnected(scope, {
      reason: 'Binance private WebSocket stream reconnected',
    });
    await checkStateFromRest('reconnected');
  });

  ws.on('exception', (error: unknown) => {
    console.error(new Date(), 'Binance websocket error:', error);
  });

  ws.subscribeUsdFuturesUserDataStream();

  setInterval(() => {
    logAccountState('interval');
  }, 10_000);
}

void main().catch((error) => {
  console.error(new Date(), 'example failed:', error);
  process.exit(1);
});
