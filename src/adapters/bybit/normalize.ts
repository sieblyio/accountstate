import { toDecimalString } from '../../core/decimal.js';
import type { AccountFact, RestSnapshotFact } from '../../core/facts.js';
import type {
  AccountScope,
  NormalizedBalance,
  NormalizedFill,
  NormalizedOrder,
  NormalizedOrderStatus,
  NormalizedPosition,
  OrderIdentity,
  OrderStrategySide,
  Provenance,
  SnapshotSubject,
  SnapshotCoverage,
  SnapshotMode,
  TerminalReason,
  TimestampMs,
} from '../../core/types.js';
import type {
  BybitV5LinearExecutionRow,
  BybitV5LinearOrderRow,
  BybitV5LinearPositionRow,
  BybitV5PrivateEvent,
  BybitV5WalletBalanceRow,
  BybitV5WsExecutionRow,
  BybitV5WsOrderRow,
  BybitV5WsPositionRow,
  BybitV5WsWalletRow,
} from './types.js';
import { bybitSubmission } from './submission.js';

export interface BybitRestSnapshotOptions {
  asOfMs?: TimestampMs;
  mode?: SnapshotMode;
  coverage?: SnapshotCoverage;
  snapshotId?: string;
  receivedAtMs?: TimestampMs;
}

export interface BybitStreamEventOptions {
  receivedAtMs?: TimestampMs;
  eventId?: string;
  sequence?: string | number;
}

type BybitPositionRow = BybitV5LinearPositionRow | BybitV5WsPositionRow;
type BybitOrderRow = BybitV5LinearOrderRow | BybitV5WsOrderRow;
type BybitExecutionRow = BybitV5LinearExecutionRow | BybitV5WsExecutionRow;
type BybitWalletRow = BybitV5WalletBalanceRow | BybitV5WsWalletRow;

/**
 * Normalize one Bybit V5 linear position row from REST or private WebSocket.
 */
export function normalizeBybitV5LinearPosition(
  row: BybitPositionRow,
  scope: AccountScope,
  source: 'rest' | 'ws' = 'rest',
  provenance?: Provenance,
): NormalizedPosition {
  const quantity = requiredDecimal(row.size);
  const signedQuantity = signedPositionQuantity(row);
  return {
    ...scope,
    symbol: row.symbol,
    exchangePositionSide: exchangePositionSideFromPositionIdx(row.positionIdx),
    strategySide: strategySideFromPosition(row),
    quantity,
    signedQuantity,
    averageEntry: decimal(
      readString(row, 'avgPrice') ?? readString(row, 'entryPrice'),
    ),
    markPrice: decimal(row.markPrice),
    liquidationPrice: decimal(row.liqPrice),
    leverage: decimal(row.leverage),
    marginMode: String(row.tradeMode),
    updatedAtMs: timestamp(row.updatedTime),
    source,
    provenance,
    raw: row,
  };
}

/**
 * Normalize one Bybit V5 active/history order row.
 */
export function normalizeBybitV5LinearOrder(
  row: BybitOrderRow,
  scope: AccountScope,
  source: 'rest' | 'ws' = 'rest',
  provenance?: Provenance,
): NormalizedOrder {
  return {
    ...scope,
    symbol: row.symbol,
    kind: orderKindFromBybitOrder(row),
    exchangeOrderId: nonEmptyString(row.orderId),
    customOrderId: nonEmptyString(row.orderLinkId),
    side: normalizeSide(row.side),
    type: row.orderType,
    status: normalizeBybitOrderStatus(row.orderStatus),
    exchangePositionSide: exchangePositionSideFromPositionIdx(row.positionIdx),
    strategySide: orderStrategySideFromPositionIdx(row.positionIdx),
    quantity: decimal(row.qty),
    executedQuantity: decimal(row.cumExecQty),
    remainingQuantity: decimal(row.leavesQty),
    price: decimal(row.price),
    averagePrice: decimal(row.avgPrice),
    triggerPrice: decimal(row.triggerPrice),
    reduceOnly: row.reduceOnly,
    closePosition: row.closeOnTrigger,
    timeInForce: row.timeInForce,
    workingType: nonEmptyString(row.triggerBy),
    owner: 'unknown',
    createdAtMs: timestamp(row.createdTime),
    updatedAtMs: timestamp(row.updatedTime),
    source,
    provenance,
    raw: row,
  };
}

/**
 * Normalize one Bybit V5 execution row into a fill.
 */
export function normalizeBybitV5LinearExecution(
  row: BybitExecutionRow,
  scope: AccountScope,
  source: 'rest' | 'ws' = 'rest',
  provenance?: Provenance,
): NormalizedFill {
  return {
    ...scope,
    symbol: row.symbol,
    exchangeTradeId: row.execId,
    exchangeOrderId: row.orderId,
    customOrderId: nonEmptyString(row.orderLinkId),
    side: normalizeSide(row.side),
    price: requiredDecimal(row.execPrice),
    quantity: requiredDecimal(row.execQty),
    quoteQuantity: decimal(row.execValue),
    fee: decimal(row.execFee),
    feeAsset: nonEmptyString(row.feeCurrency),
    realizedPnl: decimal(readString(row, 'execPnl')),
    executedAtMs: timestamp(row.execTime),
    updatedAtMs: timestamp(row.execTime),
    source,
    provenance,
    raw: row,
  };
}

/**
 * Normalize one Bybit V5 wallet row into per-coin balances.
 */
export function normalizeBybitV5WalletBalances(
  row: BybitWalletRow,
  scope: AccountScope,
  updatedAtMs: TimestampMs = 0,
  source: 'rest' | 'ws' = 'rest',
  provenance?: Provenance,
): NormalizedBalance[] {
  return row.coin.map((coin) => ({
    ...scope,
    asset: coin.coin,
    walletBalance: decimal(coin.walletBalance),
    availableBalance: decimal(coin.availableToWithdraw),
    lockedBalance: decimal(coin.locked),
    unrealizedPnl: decimal(coin.unrealisedPnl),
    updatedAtMs,
    source,
    provenance,
    raw: coin,
  }));
}

/**
 * Normalize a Bybit V5 private WebSocket event into store-ingestable facts.
 */
export function normalizeBybitV5PrivateEvent(
  event: BybitV5PrivateEvent,
  scope: AccountScope,
  options: BybitStreamEventOptions = {},
): AccountFact[] {
  switch (event.topic) {
    case 'position':
      return event.data.map((position) => {
        const provenance = createStreamProvenance(event, options, position.seq);
        return {
          type: 'position_updated',
          scope,
          position: normalizeBybitV5LinearPosition(
            position,
            scope,
            'ws',
            provenance,
          ),
          provenance,
        };
      });
    case 'order':
      return event.data.map((order) => {
        const provenance = createStreamProvenance(event, options);
        if (isTerminalBybitOrderStatus(order.orderStatus)) {
          return createTerminalEvidenceFact(
            scope,
            orderIdentity(order),
            terminalReasonFromBybitStatus(order.orderStatus),
            timestamp(order.updatedTime) || event.creationTime,
          );
        }

        return {
          type: 'order_updated',
          scope,
          order: normalizeBybitV5LinearOrder(order, scope, 'ws', provenance),
          provenance,
        };
      });
    case 'execution':
      return event.data.filter(isTradeExecution).map((execution) => {
        const provenance = createStreamProvenance(
          event,
          options,
          execution.seq,
        );
        return {
          type: 'trade_executed',
          scope,
          fill: normalizeBybitV5LinearExecution(
            execution,
            scope,
            'ws',
            provenance,
          ),
          provenance,
        };
      });
    case 'wallet':
      return event.data.flatMap((wallet) => {
        const provenance = createStreamProvenance(event, options);
        return normalizeBybitV5WalletBalances(
          wallet,
          scope,
          event.creationTime,
          'ws',
          provenance,
        ).map((balance) => ({
          type: 'balance_updated' as const,
          scope,
          balance,
          provenance,
        }));
      });
    default:
      return [];
  }
}

export const bybit = {
  rest: {
    positions(
      scope: AccountScope,
      rows: BybitV5LinearPositionRow[],
      options?: BybitRestSnapshotOptions,
    ) {
      const normalizedRows = rows.map((row) =>
        normalizeBybitV5LinearPosition(row, scope),
      );
      const snapshot = preparePositionSnapshotOptions(options, normalizedRows);

      return createRestSnapshot(
        scope,
        'positions',
        normalizedRows,
        snapshot.options,
        snapshot.defaultMode,
      );
    },
    activeOrders(
      scope: AccountScope,
      rows: BybitV5LinearOrderRow[],
      options?: BybitRestSnapshotOptions,
    ) {
      return createRestSnapshot(
        scope,
        'openOrders',
        rows
          .filter((row) => !isTerminalBybitOrderStatus(row.orderStatus))
          .map((row) => normalizeBybitV5LinearOrder(row, scope)),
        options,
        'replace-scope',
      );
    },
    walletBalances(
      scope: AccountScope,
      rows: BybitV5WalletBalanceRow[],
      options?: BybitRestSnapshotOptions,
    ) {
      const asOfMs = options?.asOfMs ?? 0;
      return createRestSnapshot(
        scope,
        'balances',
        rows.flatMap((row) =>
          normalizeBybitV5WalletBalances(row, scope, asOfMs),
        ),
        options,
        'replace-scope',
      );
    },
    executions(
      scope: AccountScope,
      rows: BybitV5LinearExecutionRow[],
      options?: BybitRestSnapshotOptions,
    ) {
      return createRestSnapshot(
        scope,
        'fills',
        rows
          .filter(isTradeExecution)
          .map((row) => normalizeBybitV5LinearExecution(row, scope)),
        options,
        'upsert-only',
      );
    },
  },
  ws: {
    privateEvent(
      scope: AccountScope,
      event: BybitV5PrivateEvent,
      options?: BybitStreamEventOptions,
    ) {
      return normalizeBybitV5PrivateEvent(event, scope, options);
    },
  },
  submission: bybitSubmission,
} as const;

function preparePositionSnapshotOptions(
  options: BybitRestSnapshotOptions | undefined,
  rows: NormalizedPosition[],
): {
  options: BybitRestSnapshotOptions | undefined;
  defaultMode: SnapshotMode;
} {
  const flatSymbols = inferSingleSymbolFromFlatPositionRows(rows);
  if (!flatSymbols || options?.coverage?.symbols?.length) {
    return { options, defaultMode: 'replace-scope' };
  }

  return {
    options: {
      ...options,
      coverage: {
        ...options?.coverage,
        symbols: flatSymbols,
      },
    },
    defaultMode: 'replace-symbols',
  };
}

function inferSingleSymbolFromFlatPositionRows(
  rows: NormalizedPosition[],
): string[] | undefined {
  if (!rows.some(isFlatPosition)) {
    return undefined;
  }

  const symbols = Array.from(new Set(rows.map((row) => row.symbol)));
  return symbols.length === 1 ? symbols : undefined;
}

function createRestSnapshot<T>(
  scope: AccountScope,
  subject: SnapshotSubject,
  rows: T[],
  options: BybitRestSnapshotOptions | undefined,
  defaultMode: SnapshotMode,
): RestSnapshotFact<T> {
  const asOfMs = options?.asOfMs ?? inferRowsAsOfMs(rows);
  return {
    type: 'rest_snapshot',
    scope,
    subject,
    mode: options?.mode ?? defaultMode,
    rows,
    source: 'rest',
    asOfMs,
    coverage: options?.coverage,
    provenance: {
      source: 'rest',
      receivedAtMs: options?.receivedAtMs ?? asOfMs,
      snapshotId: options?.snapshotId,
    },
  };
}

function createStreamProvenance(
  event: BybitV5PrivateEvent,
  options: BybitStreamEventOptions,
  sequence?: string | number,
): Provenance {
  return {
    source: 'ws',
    receivedAtMs: options.receivedAtMs ?? event.creationTime,
    exchangeEventTimeMs: event.creationTime,
    eventId: options.eventId ?? event.id ?? event.topic,
    sequence: options.sequence ?? sequence,
  };
}

function createTerminalEvidenceFact(
  scope: AccountScope,
  identity: OrderIdentity,
  reason: TerminalReason,
  atMs: TimestampMs,
): AccountFact {
  return {
    type: 'terminal_evidence',
    scope,
    identity,
    reason,
    atMs,
  };
}

function normalizeBybitOrderStatus(status: string): NormalizedOrderStatus {
  switch (status) {
    case 'Created':
    case 'New':
    case 'Active':
    case 'Untriggered':
      return 'new';
    case 'PartiallyFilled':
      return 'partially_filled';
    case 'Filled':
    case 'Triggered':
      return 'filled';
    case 'Cancelled':
    case 'Deactivated':
    case 'PartiallyFilledCanceled':
      return 'cancelled';
    case 'Rejected':
      return 'rejected';
    default:
      return 'unknown';
  }
}

function isTerminalBybitOrderStatus(status: string): boolean {
  return (
    status === 'Filled' ||
    status === 'Cancelled' ||
    status === 'Deactivated' ||
    status === 'PartiallyFilledCanceled' ||
    status === 'Rejected' ||
    status === 'Triggered'
  );
}

function terminalReasonFromBybitStatus(status: string): TerminalReason {
  switch (status) {
    case 'Filled':
      return 'filled';
    case 'Triggered':
      return 'triggered';
    case 'Cancelled':
    case 'Deactivated':
    case 'PartiallyFilledCanceled':
      return 'cancelled';
    case 'Rejected':
      return 'rejected';
    default:
      return 'manual_operator_terminal';
  }
}

function orderIdentity(row: BybitOrderRow): OrderIdentity {
  const exchangeOrderId = nonEmptyString(row.orderId);
  if (exchangeOrderId) {
    return {
      exchangeOrderId,
      customOrderId: nonEmptyString(row.orderLinkId),
    };
  }

  return { customOrderId: row.orderLinkId };
}

function orderKindFromBybitOrder(row: BybitOrderRow): NormalizedOrder['kind'] {
  const stopOrderType = nonEmptyString(row.stopOrderType);
  return stopOrderType && stopOrderType !== 'UNKNOWN'
    ? 'conditional'
    : 'regular';
}

function exchangePositionSideFromPositionIdx(positionIdx: number): string {
  switch (positionIdx) {
    case 1:
      return 'LONG';
    case 2:
      return 'SHORT';
    default:
      return 'BOTH';
  }
}

function orderStrategySideFromPositionIdx(
  positionIdx: number,
): OrderStrategySide | undefined {
  switch (positionIdx) {
    case 1:
      return 'LONG';
    case 2:
      return 'SHORT';
    default:
      return undefined;
  }
}

function strategySideFromPosition(
  row: BybitPositionRow,
): 'LONG' | 'SHORT' | 'FLAT' {
  if (isZeroDecimal(row.size) || !row.side) {
    return 'FLAT';
  }
  if (row.positionIdx === 1) {
    return 'LONG';
  }
  if (row.positionIdx === 2) {
    return 'SHORT';
  }
  return row.side === 'Sell' ? 'SHORT' : 'LONG';
}

function signedPositionQuantity(row: BybitPositionRow): string {
  const quantity = requiredDecimal(row.size);
  if (isZeroDecimal(quantity)) {
    return '0';
  }
  return strategySideFromPosition(row) === 'SHORT' ? `-${quantity}` : quantity;
}

function normalizeSide(side: string): 'BUY' | 'SELL' {
  return side === 'Sell' ? 'SELL' : 'BUY';
}

function isTradeExecution(row: BybitExecutionRow): boolean {
  return row.execType === 'Trade' && Number(row.execQty) > 0;
}

function inferRowsAsOfMs(rows: unknown[]): TimestampMs {
  const timestamps = rows
    .map((row) => (isRecord(row) ? row['updatedAtMs'] : undefined))
    .filter((value): value is number => typeof value === 'number');
  return timestamps.length > 0 ? Math.max(...timestamps) : 0;
}

function timestamp(value: string | number | undefined): TimestampMs {
  if (value === undefined || value === '') {
    return 0;
  }
  return Number(value);
}

function decimal(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    return toDecimalString(value);
  }
  return undefined;
}

function requiredDecimal(value: string | number): string {
  return toDecimalString(value);
}

function isZeroDecimal(value: string): boolean {
  return Number(value) === 0;
}

function isFlatPosition(position: NormalizedPosition): boolean {
  return position.strategySide === 'FLAT' || isZeroDecimal(position.quantity);
}

function readString(row: unknown, key: string): string | undefined {
  if (!isRecord(row)) {
    return undefined;
  }
  const value = row[key];
  return typeof value === 'string' && value ? value : undefined;
}

function nonEmptyString(value: string | undefined): string | undefined {
  return value ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
