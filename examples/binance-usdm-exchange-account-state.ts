import { DefaultLogger, USDMClient, WebsocketClient } from 'binance';

import {
  ExchangeAccountStateStore,
  type AccountScope,
  type ChangeSet,
  type NormalizedPosition,
  type PositionEntityChange,
} from '../dist/mjs/index.js';
import {
  binance,
  type BinanceUsdmPrivateEvent,
} from '../dist/mjs/adapters/binance/index.js';

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

async function refreshFromRest(
  reason: string,
  options: { emitEntityChanges?: 'default' | 'none' } = {},
): Promise<void> {
  const [positions, regularOrders, algoOrders, account] = await Promise.all([
    usdm.getPositionsV3(),
    usdm.getAllOpenOrders(),
    usdm.getOpenAlgoOrders(),
    usdm.getAccountInformationV3(),
  ]);

  // emitEntityChanges is optional. Use 'none' for startup hydration or another
  // REST overwrite/sync that should not look like live position activity.
  logPositionEntityChanges(
    reason,
    state.ingest(
      binance.rest.positions(scope, positions, {
        emitEntityChanges: options.emitEntityChanges,
      }),
    ),
  );
  state.ingest(binance.rest.openOrders(scope, regularOrders));
  state.ingest(binance.rest.openAlgoOrders(scope, algoOrders));
  state.ingest(binance.rest.accountBalances(scope, account.assets));

  console.log(new Date(), 'rest_sync_complete', {
    reason,
    positions: state.getPositions(scope).length,
    openOrders: state.getOpenOrders(scope).length,
    balances: state.getBalances(scope).length,
  });
}

function onPrivateEvent(event: BinanceUsdmPrivateEvent): void {
  logPositionEntityChanges(
    `ws:${event.eventType}`,
    state.ingest(binance.ws.privateEvent(scope, event)),
  );
}

function logPositionEntityChanges(
  reason: string,
  changeOrChanges: ChangeSet | ChangeSet[],
): void {
  const changes = Array.isArray(changeOrChanges)
    ? changeOrChanges
    : [changeOrChanges];

  for (const change of changes) {
    for (const event of change.entityChanges) {
      logPositionEntityChange(reason, event);
    }
  }
}

function logPositionEntityChange(
  reason: string,
  event: PositionEntityChange,
): void {
  console.log(new Date(), 'position_entity_event', {
    reason,
    type: event.type,
    key: event.key,
    changedFields: event.changedFields,
    quantityDelta: 'quantityDelta' in event ? event.quantityDelta : undefined,
    previous: summarizePosition(event.previous),
    current: summarizePosition(event.current),
    sequence: event.sequence,
  });
}

function summarizePosition(
  position: NormalizedPosition | undefined,
): object | undefined {
  if (!position) {
    return undefined;
  }

  return {
    symbol: position.symbol,
    side: position.exchangePositionSide,
    strategySide: position.strategySide,
    quantity: position.quantity,
    signedQuantity: position.signedQuantity,
    entry: position.averageEntry,
    mark: position.markPrice,
    leverage: position.leverage,
    updatedAtMs: position.updatedAtMs,
    source: position.source,
  };
}

async function main(): Promise<void> {
  await refreshFromRest('startup', { emitEntityChanges: 'none' });

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
    await refreshFromRest('reconnected');
  });

  ws.on('exception', (error: unknown) => {
    console.error(new Date(), 'Binance websocket error:', error);
  });

  await ws.subscribeUsdFuturesUserDataStream();
  console.log(new Date(), 'listening_for_binance_usdm_private_events');
}

void main().catch((error) => {
  console.error(new Date(), 'example failed:', error);
  process.exit(1);
});
