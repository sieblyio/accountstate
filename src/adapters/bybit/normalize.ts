import { toDecimalString } from '../../core/decimal.js';
import { fingerprintExactPayload } from '../../core/fingerprint.js';
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
  StrategySide,
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
  /**
   * Optional. Use 'none' to suppress entity-change events when applying a REST
   * overwrite/sync that should not look like live account activity.
   */
  emitEntityChanges?: 'default' | 'none';
}

export interface BybitStreamEventOptions {
  receivedAtMs?: TimestampMs;
  eventId?: string;
  sequence?: string | number;
}

export type BybitPrivateEventSubject =
  | 'positions'
  | 'openOrders'
  | 'balances'
  | 'fills';

export interface BybitPrivateEventSummary {
  topic: BybitV5PrivateEvent['topic'] | string;
  subjects: BybitPrivateEventSubject[];
  symbols: string[];
  assets: string[];
  exchangeOrderIds: string[];
  customOrderIds: string[];
  exchangePositionSides: string[];
  orderStatuses: string[];
  executionTypes: string[];
  eventTimeMs?: TimestampMs;
}

export type BybitPrivateEventRouteDecision =
  | {
      kind: 'activeOrder';
      source: 'ws';
      topic: 'order';
      symbol: string;
      customOrderId?: string;
      exchangeOrderId?: string;
      orderStatus: string;
      exchangePositionSide?: string;
      strategySide?: OrderStrategySide;
      positionIdx?: 0 | 1 | 2;
      raw: unknown;
    }
  | {
      kind: 'terminalOrder';
      source: 'ws';
      topic: 'order';
      symbol: string;
      customOrderId?: string;
      exchangeOrderId?: string;
      orderStatus: string;
      reason: TerminalReason;
      exchangePositionSide?: string;
      strategySide?: OrderStrategySide;
      positionIdx?: 0 | 1 | 2;
      raw: unknown;
    }
  | {
      kind: 'executionFill';
      source: 'ws';
      topic: 'execution';
      symbol: string;
      customOrderId?: string;
      exchangeOrderId?: string;
      exchangeTradeId?: string;
      executionType?: string;
      positionIdx?: 0 | 1 | 2;
      raw: unknown;
    }
  | {
      kind: 'position';
      source: 'ws';
      topic: 'position';
      symbol: string;
      exchangePositionSide?: string;
      strategySide?: StrategySide;
      positionIdx?: 0 | 1 | 2;
      raw: unknown;
    }
  | {
      kind: 'balance';
      source: 'ws';
      topic: 'wallet';
      asset?: string;
      raw: unknown;
    };

export interface BybitPositionIdxInput {
  raw?: unknown;
  positionIdx?: unknown;
  exchangePositionSide?: unknown;
  metadata?: {
    exchangePositionSide?: unknown;
  };
}

type BybitPositionRow = BybitV5LinearPositionRow | BybitV5WsPositionRow;
type BybitOrderRow = BybitV5LinearOrderRow | BybitV5WsOrderRow;
type BybitExecutionRow = BybitV5LinearExecutionRow | BybitV5WsExecutionRow;
type BybitWalletRow = BybitV5WalletBalanceRow | BybitV5WsWalletRow;

/**
 * Return the Bybit V5 request `positionIdx` for a normalized position/order or
 * raw Bybit row. Hedge LONG maps to `1`, hedge SHORT maps to `2`, and one-way
 * or unknown position sides map to `0`.
 */
export function getBybitPositionIdx(input: BybitPositionIdxInput): 0 | 1 | 2 {
  const directIdx = normalizePositionIdx(input.positionIdx);
  if (directIdx !== undefined) {
    return directIdx;
  }

  const rawIdx = isRecord(input.raw)
    ? normalizePositionIdx(input.raw['positionIdx'])
    : undefined;
  if (rawIdx !== undefined) {
    return rawIdx;
  }

  const positionSide = String(
    input.exchangePositionSide ??
      input.metadata?.exchangePositionSide ??
      '',
  ).toUpperCase();

  if (positionSide === 'LONG' || positionSide === 'HEDGE_LONG') {
    return 1;
  }
  if (positionSide === 'SHORT' || positionSide === 'HEDGE_SHORT') {
    return 2;
  }

  return 0;
}

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

/**
 * Summarize one Bybit V5 private WebSocket event without changing store state.
 * Use this for logging, metrics, and application-owned coalescing.
 */
export function summarizeBybitV5PrivateEvent(
  event: BybitV5PrivateEvent,
): BybitPrivateEventSummary {
  switch (event.topic) {
    case 'position':
      return createBybitPrivateEventSummary(event, {
        subjects: event.data.length > 0 ? ['positions'] : [],
        symbols: event.data.map((position) => position.symbol),
        exchangePositionSides: event.data.map((position) =>
          exchangePositionSideFromPositionIdx(position.positionIdx),
        ),
      });
    case 'order':
      return createBybitPrivateEventSummary(event, {
        subjects: event.data.length > 0 ? ['openOrders'] : [],
        symbols: event.data.map((order) => order.symbol),
        exchangeOrderIds: event.data.map((order) =>
          nonEmptyString(order.orderId),
        ),
        customOrderIds: event.data.map((order) =>
          nonEmptyString(order.orderLinkId),
        ),
        exchangePositionSides: event.data.map((order) =>
          exchangePositionSideFromPositionIdx(order.positionIdx),
        ),
        orderStatuses: event.data.map((order) => order.orderStatus),
      });
    case 'execution': {
      const tradeExecutions = event.data.filter(isTradeExecution);
      return createBybitPrivateEventSummary(event, {
        subjects: tradeExecutions.length > 0 ? ['fills'] : [],
        symbols: tradeExecutions.map((execution) => execution.symbol),
        exchangeOrderIds: tradeExecutions.map((execution) =>
          nonEmptyString(execution.orderId),
        ),
        customOrderIds: tradeExecutions.map((execution) =>
          nonEmptyString(execution.orderLinkId),
        ),
        executionTypes: event.data.map((execution) => execution.execType),
      });
    }
    case 'wallet':
      return createBybitPrivateEventSummary(event, {
        subjects: event.data.length > 0 ? ['balances'] : [],
        assets: event.data.flatMap((wallet) =>
          wallet.coin.map((coin) => coin.coin),
        ),
      });
    default:
      return createBybitPrivateEventSummary(event);
  }
}

/**
 * Route one Bybit V5 private WebSocket event into row-level workflow hints.
 * Ingest `ws.privateEvent()` into the store first, then use these pure
 * decisions to schedule app-owned work. Execution rows are fill evidence and
 * terminal order rows are not active open-order confirmations.
 */
export function routeBybitV5PrivateEvent(
  event: BybitV5PrivateEvent,
): BybitPrivateEventRouteDecision[] {
  switch (event.topic) {
    case 'position':
      return event.data.map(
        (position): BybitPrivateEventRouteDecision => ({
          kind: 'position',
          source: 'ws',
          topic: 'position',
          symbol: position.symbol,
          exchangePositionSide: exchangePositionSideFromPositionIdx(
            position.positionIdx,
          ),
          strategySide: strategySideFromPosition(position),
          positionIdx: normalizePositionIdx(position.positionIdx),
          raw: position,
        }),
      );
    case 'order':
      return event.data.map((order): BybitPrivateEventRouteDecision => {
        const exchangePositionSide = exchangePositionSideFromPositionIdx(
          order.positionIdx,
        );
        const strategySide = orderStrategySideFromPositionIdx(
          order.positionIdx,
        );
        const positionIdx = normalizePositionIdx(order.positionIdx);

        if (isBybitTerminalOrderStatus(order.orderStatus)) {
          return {
            kind: 'terminalOrder',
            source: 'ws',
            topic: 'order',
            symbol: order.symbol,
            exchangeOrderId: nonEmptyString(order.orderId),
            customOrderId: nonEmptyString(order.orderLinkId),
            orderStatus: order.orderStatus,
            reason: terminalReasonFromBybitStatus(order.orderStatus),
            exchangePositionSide,
            strategySide,
            positionIdx,
            raw: order,
          };
        }

        return {
          kind: 'activeOrder',
          source: 'ws',
          topic: 'order',
          symbol: order.symbol,
          exchangeOrderId: nonEmptyString(order.orderId),
          customOrderId: nonEmptyString(order.orderLinkId),
          orderStatus: order.orderStatus,
          exchangePositionSide,
          strategySide,
          positionIdx,
          raw: order,
        };
      });
    case 'execution':
      return event.data
        .filter(isTradeExecution)
        .map(
          (execution): BybitPrivateEventRouteDecision => ({
            kind: 'executionFill',
            source: 'ws',
            topic: 'execution',
            symbol: execution.symbol,
            exchangeOrderId: nonEmptyString(execution.orderId),
            customOrderId: nonEmptyString(execution.orderLinkId),
            exchangeTradeId: nonEmptyString(execution.execId),
            executionType: execution.execType,
            positionIdx: normalizePositionIdx(
              readUnknown(execution, 'positionIdx'),
            ),
            raw: execution,
          }),
        );
    case 'wallet':
      return event.data.flatMap((wallet) =>
        wallet.coin.map(
          (coin): BybitPrivateEventRouteDecision => ({
            kind: 'balance',
            source: 'ws',
            topic: 'wallet',
            asset: coin.coin,
            raw: coin,
          }),
        ),
      );
    default:
      return [];
  }
}

/**
 * Return a stable exact-payload fingerprint for replay protection outside the
 * reducer. It is not a semantic exchange event id.
 */
export function fingerprintBybitV5PrivateEvent(event: unknown): string {
  return fingerprintExactPayload(event);
}

/**
 * Return true when a Bybit order status should not be treated as an active
 * open-order confirmation. `Triggered` is non-active for the stop-order row.
 */
export function isBybitTerminalOrderStatus(status: string): boolean {
  return isTerminalBybitOrderStatus(status);
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
    summarizePrivateEvent(event: BybitV5PrivateEvent) {
      return summarizeBybitV5PrivateEvent(event);
    },
    routePrivateEvent(event: BybitV5PrivateEvent) {
      return routeBybitV5PrivateEvent(event);
    },
    fingerprintPrivateEvent(event: unknown) {
      return fingerprintBybitV5PrivateEvent(event);
    },
    isTerminalOrderStatus(status: string) {
      return isBybitTerminalOrderStatus(status);
    },
  },
  submission: bybitSubmission,
} as const;

function createBybitPrivateEventSummary(
  event: BybitV5PrivateEvent,
  overrides: BybitPrivateEventSummaryInput = {},
): BybitPrivateEventSummary {
  return {
    topic: event.topic,
    subjects: uniqueStrings(overrides.subjects ?? []),
    symbols: uniqueStrings(overrides.symbols ?? []),
    assets: uniqueStrings(overrides.assets ?? []),
    exchangeOrderIds: uniqueStrings(overrides.exchangeOrderIds ?? []),
    customOrderIds: uniqueStrings(overrides.customOrderIds ?? []),
    exchangePositionSides: uniqueStrings(overrides.exchangePositionSides ?? []),
    orderStatuses: uniqueStrings(overrides.orderStatuses ?? []),
    executionTypes: uniqueStrings(overrides.executionTypes ?? []),
    eventTimeMs: event.creationTime,
  };
}

interface BybitPrivateEventSummaryInput {
  subjects?: readonly (BybitPrivateEventSubject | undefined)[];
  symbols?: readonly (string | undefined)[];
  assets?: readonly (string | undefined)[];
  exchangeOrderIds?: readonly (string | undefined)[];
  customOrderIds?: readonly (string | undefined)[];
  exchangePositionSides?: readonly (string | undefined)[];
  orderStatuses?: readonly (string | undefined)[];
  executionTypes?: readonly (string | undefined)[];
}

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
    emitEntityChanges: options?.emitEntityChanges,
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
    case 'Expired':
      return 'expired';
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
    status === 'Expired' ||
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
    case 'Expired':
      return 'expired';
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

function normalizePositionIdx(value: unknown): 0 | 1 | 2 | undefined {
  const positionIdx =
    typeof value === 'number' || typeof value === 'string'
      ? Number(value)
      : Number.NaN;

  return positionIdx === 0 || positionIdx === 1 || positionIdx === 2
    ? positionIdx
    : undefined;
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

function readUnknown(row: unknown, key: string): unknown {
  return isRecord(row) ? row[key] : undefined;
}

function nonEmptyString(value: string | undefined): string | undefined {
  return value ? value : undefined;
}

function uniqueStrings<T extends string>(
  values: readonly (T | undefined)[],
): T[] {
  return Array.from(new Set(values.filter(isNonEmptyString))) as T[];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
