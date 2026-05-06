import { DefaultLogger, RestClientV5, WebsocketClient } from 'bybit-api';
import 'dotenv/config';

import {
  ExchangeAccountStateStore,
  type AccountScope,
  type ExchangeAccount,
  type StateCheck,
} from 'accountstate';
import { bybit, type BybitV5PrivateEvent } from 'accountstate/bybit';

const key = process.env.BYBIT_API_KEY || '';
const secret = process.env.BYBIT_API_SECRET || '';
const useDemoTrading = process.env.BYBIT_DEMO_TRADING === 'true';
const useTestnet = !useDemoTrading && process.env.BYBIT_TESTNET === 'true';

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

  logAccountState(reason);
}

async function checkStateFromRest(reason: string): Promise<void> {
  const checks = state.getAccount(scope).stateChecks;

  if (checks.length === 0) {
    return;
  }

  const subjects = new Set(checks.map((check) => check.subject));

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

  logStateChecks(`${reason}:rest_checked`, checks);
  logAccountState(`${reason}:rest_checked`);
}

function onPrivateEvent(event: BybitV5PrivateEvent): void {
  state.ingest(bybit.ws.privateEvent(scope, event));

  const routes = bybit.ws.routePrivateEvent(event);
  if (routes.length > 0) {
    console.log(new Date(), 'bybit_private_routes', {
      fingerprint: bybit.ws.fingerprintPrivateEvent(event),
      routes: routes.map((route) => ({
        kind: route.kind,
        symbol: 'symbol' in route ? route.symbol : undefined,
        customOrderId: 'customOrderId' in route ? route.customOrderId : undefined,
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
    await checkStateFromRest('reconnected');
  });

  ws.on('exception', (error: unknown) => {
    console.error(new Date(), 'Bybit websocket error:', error);
  });

  ws.subscribeV5(['position', 'order', 'execution', 'wallet'], 'linear', true);

  setInterval(() => {
    logAccountState('interval');
  }, 10_000);
}

void main().catch((error) => {
  console.error(new Date(), 'example failed:', error);
  process.exit(1);
});
