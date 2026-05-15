import { toDecimalString } from '../../core/decimal.js';
import { fingerprintExactPayload } from '../../core/fingerprint.js';
import type {
  AccountFact,
  NormalizedPrivateEvent,
  RestSnapshotFact,
} from '../../core/facts.js';
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
  BinanceSpotExecutionReportEvent,
  BinanceSpotOpenOrderRow,
  BinanceUsdmAccountAssetRow,
  BinanceUsdmAccountTradeRow,
  BinanceUsdmAccountUpdateEvent,
  BinanceUsdmAlgoUpdateEvent,
  BinanceUsdmOpenAlgoOrderRow,
  BinanceUsdmOrderTradeUpdateEvent,
  BinanceUsdmPositionRow,
  BinanceUsdmRegularOpenOrderRow,
  BinanceUsdmTradeLiteEvent,
  BinanceUsdmPrivateEvent,
} from './types.js';
import { binanceSubmission } from './submission.js';

export interface BinanceRestSnapshotOptions {
  asOfMs?: TimestampMs;
  mode?: SnapshotMode;
  coverage?: SnapshotCoverage;
  snapshotId?: string;
  receivedAtMs?: TimestampMs;
}

export interface BinanceStreamEventOptions {
  receivedAtMs?: TimestampMs;
  eventId?: string;
  sequence?: string | number;
}

export type BinancePrivateEventSubject =
  | 'positions'
  | 'openOrders'
  | 'balances'
  | 'fills';

export interface BinancePrivateEventSummary {
  eventType: BinanceUsdmPrivateEvent['eventType'] | string;
  subjects: BinancePrivateEventSubject[];
  symbols: string[];
  assets: string[];
  exchangeOrderIds: string[];
  customOrderIds: string[];
  exchangeTriggerOrderIds: string[];
  customTriggerOrderIds: string[];
  exchangePositionSides: string[];
  orderStatuses: string[];
  executionTypes: string[];
  algoStatuses: string[];
  eventTimeMs?: TimestampMs;
  transactionTimeMs?: TimestampMs;
}

export type BinancePrivateEventRouteDecision =
  | {
      kind: 'activeOrder';
      source: 'ws';
      eventType: 'ORDER_TRADE_UPDATE' | 'ALGO_UPDATE';
      symbol: string;
      customOrderId?: string;
      customTriggerOrderId?: string;
      exchangeOrderId?: string;
      exchangeTriggerOrderId?: string;
      orderStatus: string;
      exchangePositionSide?: string;
      strategySide?: OrderStrategySide;
      raw: unknown;
    }
  | {
      kind: 'terminalOrder';
      source: 'ws';
      eventType: 'ORDER_TRADE_UPDATE' | 'ALGO_UPDATE';
      symbol: string;
      customOrderId?: string;
      customTriggerOrderId?: string;
      exchangeOrderId?: string;
      exchangeTriggerOrderId?: string;
      orderStatus: string;
      reason: TerminalReason;
      exchangePositionSide?: string;
      strategySide?: OrderStrategySide;
      raw: unknown;
    }
  | {
      kind: 'executionFill';
      source: 'ws';
      eventType: 'ORDER_TRADE_UPDATE' | 'TRADE_LITE';
      symbol: string;
      customOrderId?: string;
      exchangeOrderId?: string;
      exchangeTradeId?: string;
      executionType?: string;
      exchangePositionSide?: string;
      strategySide?: OrderStrategySide;
      raw: unknown;
    }
  | {
      kind: 'position';
      source: 'ws';
      eventType: 'ACCOUNT_UPDATE';
      symbol: string;
      exchangePositionSide?: string;
      strategySide?: StrategySide;
      raw: unknown;
    }
  | {
      kind: 'balance';
      source: 'ws';
      eventType: 'ACCOUNT_UPDATE';
      asset?: string;
      raw: unknown;
    };

/**
 * Normalize one USD-M position row from `USDMClient.getPositionsV3()`.
 */
export function normalizeBinanceUsdmPosition(
  row: BinanceUsdmPositionRow,
  scope: AccountScope,
): NormalizedPosition {
  return normalizeUsdmPositionRow(
    {
      symbol: row.symbol,
      positionSide: row.positionSide,
      positionAmount: row.positionAmt,
      entryPrice: row.entryPrice,
      markPrice: row.markPrice,
      liquidationPrice: row.liquidationPrice,
      updatedAtMs: row.updateTime,
    },
    scope,
    'rest',
    row,
  );
}

/**
 * Normalize one USD-M regular open-order row from `getAllOpenOrders()`.
 */
export function normalizeBinanceUsdmRegularOpenOrder(
  row: BinanceUsdmRegularOpenOrderRow,
  scope: AccountScope,
): NormalizedOrder {
  return {
    ...scope,
    symbol: row.symbol,
    kind: 'regular',
    exchangeOrderId: String(row.orderId),
    customOrderId: readClientOrderId(row),
    side: row.side,
    type: row.type,
    status: normalizeBinanceOrderStatus(row.status),
    exchangePositionSide: row.positionSide,
    strategySide: strategySideFromPositionSide(row.positionSide),
    quantity: decimal(row.origQty),
    executedQuantity: decimal(row.executedQty),
    price: decimal(row.price),
    averagePrice: decimal(row.avgPrice),
    triggerPrice: decimal(row.stopPrice),
    reduceOnly: row.reduceOnly,
    closePosition: row.closePosition,
    timeInForce: row.timeInForce,
    workingType: row.workingType,
    priceProtect: row.priceProtect,
    owner: 'unknown',
    createdAtMs: row.time,
    updatedAtMs: row.updateTime || row.time,
    source: 'rest',
    raw: row,
  };
}

/**
 * Normalize one USD-M Algo open-order row from `getOpenAlgoOrders()`.
 */
export function normalizeBinanceUsdmOpenAlgoOrder(
  row: BinanceUsdmOpenAlgoOrderRow,
  scope: AccountScope,
): NormalizedOrder {
  return {
    ...scope,
    symbol: row.symbol,
    kind: 'algo',
    exchangeTriggerOrderId: String(row.algoId),
    customTriggerOrderId: row.clientAlgoId,
    side: row.side,
    type: row.orderType,
    status: normalizeBinanceAlgoStatus(row.algoStatus),
    exchangePositionSide: row.positionSide,
    strategySide: strategySideFromPositionSide(row.positionSide),
    quantity: decimal(row.quantity),
    price: decimal(row.price),
    triggerPrice: decimal(row.triggerPrice),
    reduceOnly: row.reduceOnly,
    closePosition: row.closePosition,
    timeInForce: row.timeInForce,
    workingType: row.workingType,
    priceProtect: row.priceProtect,
    owner: 'unknown',
    createdAtMs: row.createTime,
    updatedAtMs: row.updateTime || row.createTime,
    source: 'rest',
    raw: row,
  };
}

/**
 * Normalize one USD-M account-trade row from `getAccountTrades()`.
 */
export function normalizeBinanceUsdmAccountTrade(
  row: BinanceUsdmAccountTradeRow,
  scope: AccountScope,
): NormalizedFill {
  return {
    ...scope,
    symbol: row.symbol,
    exchangeTradeId: String(row.id),
    exchangeOrderId: String(row.orderId),
    side: row.side,
    price: requiredDecimal(row.price),
    quantity: requiredDecimal(row.qty),
    quoteQuantity: decimal(row.quoteQty),
    fee: decimal(row.commission),
    feeAsset: row.commissionAsset,
    realizedPnl: decimal(row.realizedPnl),
    exchangePositionSide: row.positionSide,
    strategySide: strategySideFromPositionSide(row.positionSide),
    executedAtMs: row.time,
    updatedAtMs: row.time,
    source: 'rest',
    raw: row,
  };
}

/**
 * Normalize one USD-M account asset row from `USDMClient.getAccountInformationV3()`.
 */
export function normalizeBinanceUsdmAccountAsset(
  row: BinanceUsdmAccountAssetRow,
  scope: AccountScope,
): NormalizedBalance {
  return {
    ...scope,
    asset: row.asset,
    walletBalance: decimal(row.walletBalance),
    availableBalance: decimal(row.availableBalance),
    unrealizedPnl: decimal(row.unrealizedProfit),
    updatedAtMs: Number(row.updateTime) || 0,
    source: 'rest',
    raw: row,
  };
}

/**
 * Normalize one formatted USD-M private WebSocket event into store-ingestable
 * facts.
 */
export function normalizeBinanceUsdmPrivateEvent(
  event: BinanceUsdmPrivateEvent,
  scope: AccountScope,
  options: BinanceStreamEventOptions = {},
): AccountFact[] {
  switch (event.eventType) {
    case 'ACCOUNT_UPDATE':
      return normalizeBinanceUsdmAccountUpdate(event, scope, options);
    case 'ORDER_TRADE_UPDATE':
      return normalizeBinanceUsdmOrderTradeUpdate(event, scope, options);
    case 'ALGO_UPDATE':
      return normalizeBinanceUsdmAlgoUpdate(event, scope, options);
    case 'TRADE_LITE':
      return normalizeBinanceUsdmTradeLite(event, scope, options);
    default:
      return [];
  }
}

/**
 * Summarize one formatted USD-M private WebSocket event without changing store
 * state. Use this for logging, metrics, and application-owned coalescing.
 */
export function summarizeBinanceUsdmPrivateEvent(
  event: BinanceUsdmPrivateEvent,
): BinancePrivateEventSummary {
  switch (event.eventType) {
    case 'ACCOUNT_UPDATE':
      return summarizeBinanceAccountUpdate(event);
    case 'ORDER_TRADE_UPDATE':
      return summarizeBinanceOrderTradeUpdate(event);
    case 'ALGO_UPDATE':
      return summarizeBinanceAlgoUpdate(event);
    case 'TRADE_LITE':
      return summarizeBinanceTradeLite(event);
    default:
      return createBinancePrivateEventSummary(event);
  }
}

/**
 * Route one formatted USD-M private WebSocket event into row-level workflow
 * hints. Ingest `ws.privateEvent()` into the store first, then use these pure
 * decisions to queue app-owned scopes, clear pending confirmations, or log
 * fills. `TRADE_LITE` is fill evidence only, never active-order confirmation.
 */
export function routeBinanceUsdmPrivateEvent(
  event: BinanceUsdmPrivateEvent,
): BinancePrivateEventRouteDecision[] {
  switch (event.eventType) {
    case 'ACCOUNT_UPDATE':
      return routeBinanceAccountUpdate(event);
    case 'ORDER_TRADE_UPDATE':
      return routeBinanceOrderTradeUpdate(event);
    case 'ALGO_UPDATE':
      return routeBinanceAlgoUpdate(event);
    case 'TRADE_LITE':
      return routeBinanceTradeLite(event);
    default:
      return [];
  }
}

/**
 * Return a stable exact-payload fingerprint for replay protection outside the
 * reducer. This does not collapse raw one-letter and SDK-formatted variants of
 * the same Binance event; choose one private event format and feed only that
 * format into accountstate.
 */
export function fingerprintBinanceUsdmPrivateEvent(event: unknown): string {
  return fingerprintExactPayload(event);
}

/**
 * Return true when a regular Binance order status should not be treated as an
 * active open-order confirmation.
 */
export function isBinanceTerminalOrderStatus(status: string): boolean {
  return (
    status === 'FILLED' ||
    status === 'CANCELED' ||
    status === 'EXPIRED' ||
    status === 'EXPIRED_IN_MATCH' ||
    status === 'REJECTED'
  );
}

/**
 * Return true when a Binance Algo status means the trigger-order row is no
 * longer an active open Algo order. `TRIGGERED` is terminal for the Algo row;
 * the resulting regular order is tracked by its own order events.
 */
export function isBinanceTerminalAlgoStatus(status: string): boolean {
  return (
    status === 'TRIGGERED' ||
    status === 'FINISHED' ||
    status === 'CANCELED' ||
    status === 'EXPIRED' ||
    status === 'REJECTED'
  );
}

/**
 * Normalize a USD-M account update into position and balance update facts.
 */
export function normalizeBinanceUsdmAccountUpdate(
  event: BinanceUsdmAccountUpdateEvent,
  scope: AccountScope,
  options: BinanceStreamEventOptions = {},
): NormalizedPrivateEvent[] {
  const provenance = createStreamProvenance(event, options);
  return [
    ...event.updateData.updatedBalances.map((balance) => ({
      type: 'balance_updated' as const,
      scope,
      balance: {
        ...scope,
        asset: balance.asset,
        walletBalance: decimal(balance.walletBalance),
        availableBalance: decimal(balance.crossWalletBalance),
        updatedAtMs: event.transactionTime,
        source: 'ws' as const,
        provenance,
        raw: balance,
      } satisfies NormalizedBalance,
      provenance,
    })),
    ...event.updateData.updatedPositions.map((position) => ({
      type: 'position_updated' as const,
      scope,
      position: normalizeUsdmPositionRow(
        {
          symbol: position.symbol,
          positionSide: position.positionSide,
          positionAmount: position.positionAmount,
          entryPrice: position.entryPrice,
          updatedAtMs: event.transactionTime,
        },
        scope,
        'ws',
        position,
        provenance,
      ),
      provenance,
    })),
  ];
}

/**
 * Normalize a USD-M order-trade update. Terminal order statuses become terminal
 * evidence so the store does not keep closed exchange orders in open state.
 */
export function normalizeBinanceUsdmOrderTradeUpdate(
  event: BinanceUsdmOrderTradeUpdateEvent,
  scope: AccountScope,
  options: BinanceStreamEventOptions = {},
): AccountFact[] {
  const order = event.order;
  const provenance = createStreamProvenance(event, options);
  const facts: AccountFact[] = [];
  const status = normalizeBinanceOrderStatus(order.orderStatus);

  if (isTerminalOrderStatus(status)) {
    facts.push(
      createTerminalEvidenceFact(
        scope,
        {
          exchangeOrderId: String(order.orderId),
          customOrderId: order.clientOrderId,
        },
        terminalReasonFromOrderStatus(status),
        event.transactionTime,
      ),
    );
  } else {
    facts.push({
      type: 'order_updated',
      scope,
      order: {
        ...scope,
        symbol: order.symbol,
        kind: 'regular',
        exchangeOrderId: String(order.orderId),
        customOrderId: order.clientOrderId,
        side: order.orderSide,
        type: order.orderType,
        status,
        exchangePositionSide: order.positionSide,
        strategySide: strategySideFromPositionSide(order.positionSide),
        quantity: decimal(order.originalQuantity),
        executedQuantity: decimal(order.orderFilledAccumulatedQuantity),
        price: decimal(order.originalPrice),
        averagePrice: decimal(order.averagePrice),
        triggerPrice: decimal(order.stopPrice),
        reduceOnly: order.isReduceOnly,
        closePosition: order.isCloseAll,
        timeInForce: order.timeInForce,
        workingType: order.stopPriceWorkingType,
        priceProtect: order.pP,
        owner: 'unknown',
        updatedAtMs: event.transactionTime,
        source: 'ws',
        provenance,
        raw: order,
      },
      provenance,
    });
  }

  if (hasBinanceFillEvidence(order)) {
    facts.push({
      type: 'trade_executed',
      scope,
      fill: {
        ...scope,
        symbol: order.symbol,
        exchangeTradeId:
          order.tradeId && order.tradeId > 0
            ? String(order.tradeId)
            : undefined,
        exchangeOrderId: String(order.orderId),
        customOrderId: order.clientOrderId,
        side: order.orderSide,
        price: requiredDecimal(order.lastFilledPrice),
        quantity: requiredDecimal(order.lastFilledQuantity),
        fee: decimal(order.commissionAmount),
        feeAsset: order.commissionAsset || undefined,
        realizedPnl: decimal(order.realisedProfit),
        exchangePositionSide: order.positionSide,
        strategySide: strategySideFromPositionSide(order.positionSide),
        executedAtMs: order.orderTradeTime || event.transactionTime,
        updatedAtMs: event.transactionTime,
        source: 'ws',
        provenance,
        raw: order,
      },
      provenance,
    });
  }

  return facts;
}

/**
 * Normalize a USD-M Algo update into an open-order update or terminal evidence.
 */
export function normalizeBinanceUsdmAlgoUpdate(
  event: BinanceUsdmAlgoUpdateEvent,
  scope: AccountScope,
  options: BinanceStreamEventOptions = {},
): AccountFact[] {
  const algoOrder = event.algoOrder;
  const provenance = createStreamProvenance(event, options);
  const status = normalizeBinanceAlgoStatus(algoOrder.algoStatus);

  if (algoOrder.algoStatus === 'TRIGGERED') {
    return [
      createTerminalEvidenceFact(
        scope,
        {
          customTriggerOrderId: algoOrder.clientAlgoId,
          exchangeTriggerOrderId: String(algoOrder.algoId),
        },
        'triggered',
        event.transactionTime,
      ),
    ];
  }

  if (isTerminalOrderStatus(status)) {
    return [
      createTerminalEvidenceFact(
        scope,
        {
          customTriggerOrderId: algoOrder.clientAlgoId,
          exchangeTriggerOrderId: String(algoOrder.algoId),
        },
        terminalReasonFromOrderStatus(status),
        event.transactionTime,
      ),
    ];
  }

  return [
    {
      type: 'order_updated',
      scope,
      order: {
        ...scope,
        symbol: algoOrder.symbol,
        kind: 'algo',
        exchangeOrderId: nonZeroString(algoOrder.orderId),
        exchangeTriggerOrderId: String(algoOrder.algoId),
        customTriggerOrderId: algoOrder.clientAlgoId,
        side: algoOrder.side,
        type: algoOrder.orderType,
        status,
        exchangePositionSide: algoOrder.positionSide,
        strategySide: strategySideFromPositionSide(algoOrder.positionSide),
        quantity: decimal(algoOrder.quantity),
        executedQuantity: decimal(algoOrder.executedQty),
        price: decimal(algoOrder.price),
        averagePrice: decimal(algoOrder.averagePrice),
        triggerPrice: decimal(algoOrder.triggerPrice),
        reduceOnly: algoOrder.reduceOnly,
        closePosition: algoOrder.closePosition,
        timeInForce: algoOrder.timeInForce,
        workingType: algoOrder.workingType,
        priceProtect: algoOrder.priceProtect,
        owner: 'unknown',
        updatedAtMs: event.transactionTime,
        source: 'ws',
        provenance,
        raw: algoOrder,
      },
      provenance,
    },
  ];
}

/**
 * Normalize a USD-M TRADE_LITE event into a fill fact.
 */
export function normalizeBinanceUsdmTradeLite(
  event: BinanceUsdmTradeLiteEvent,
  scope: AccountScope,
  options: BinanceStreamEventOptions = {},
): AccountFact[] {
  const provenance = createStreamProvenance(event, options);
  return [
    {
      type: 'trade_executed',
      scope,
      fill: {
        ...scope,
        symbol: event.symbol,
        exchangeTradeId: String(event.tradeId),
        exchangeOrderId: String(event.orderId),
        customOrderId: event.clientOrderId,
        side: event.side,
        price: requiredDecimal(event.lastFilledPrice),
        quantity: requiredDecimal(event.lastFilledQuantity),
        executedAtMs: event.transactionTime,
        updatedAtMs: event.eventTime,
        source: 'ws',
        provenance,
        raw: event,
      },
      provenance,
    },
  ];
}

/**
 * Normalize one Spot open-order row from `MainClient.getOpenOrders()`.
 */
export function normalizeBinanceSpotOpenOrder(
  row: BinanceSpotOpenOrderRow,
  scope: AccountScope,
): NormalizedOrder {
  return {
    ...scope,
    symbol: row.symbol,
    kind: 'regular',
    exchangeOrderId: String(row.orderId),
    customOrderId: readClientOrderId(row),
    side: row.side,
    type: row.type,
    status: normalizeBinanceOrderStatus(row.status),
    quantity: decimal(row.origQty),
    executedQuantity: decimal(row.executedQty),
    price: decimal(row.price),
    triggerPrice: decimal(row.stopPrice),
    timeInForce: row.timeInForce,
    owner: 'unknown',
    createdAtMs: row.time,
    updatedAtMs: row.updateTime || row.time,
    source: 'rest',
    raw: row,
  };
}

/**
 * Normalize one Spot executionReport event into store-ingestable facts.
 */
export function normalizeBinanceSpotExecutionReport(
  event: BinanceSpotExecutionReportEvent,
  scope: AccountScope,
  options: BinanceStreamEventOptions = {},
): AccountFact[] {
  const provenance = createStreamProvenance(event, options);
  const status = normalizeBinanceOrderStatus(event.orderStatus);
  const facts: AccountFact[] = [];

  if (isTerminalOrderStatus(status)) {
    facts.push(
      createTerminalEvidenceFact(
        scope,
        {
          exchangeOrderId: String(event.orderId),
          customOrderId: event.newClientOrderId,
        },
        terminalReasonFromOrderStatus(status),
        event.eventTime,
      ),
    );
  } else {
    facts.push({
      type: 'order_updated',
      scope,
      order: {
        ...scope,
        symbol: event.symbol,
        kind: 'regular',
        exchangeOrderId: String(event.orderId),
        customOrderId: event.newClientOrderId,
        side: event.side,
        type: event.orderType,
        status,
        quantity: decimal(event.quantity),
        executedQuantity: decimal(event.accumulatedQuantity),
        price: decimal(event.price),
        triggerPrice: decimal(event.stopPrice),
        timeInForce: event.cancelType,
        owner: 'unknown',
        createdAtMs: event.orderCreationTime,
        updatedAtMs: event.eventTime,
        source: 'ws',
        provenance,
        raw: event,
      },
      provenance,
    });
  }

  if (event.executionType === 'TRADE' && Number(event.lastTradeQuantity) > 0) {
    facts.push({
      type: 'trade_executed',
      scope,
      fill: {
        ...scope,
        symbol: event.symbol,
        exchangeTradeId:
          event.tradeId && event.tradeId > 0
            ? String(event.tradeId)
            : undefined,
        exchangeOrderId: String(event.orderId),
        customOrderId: event.newClientOrderId,
        side: event.side,
        price: requiredDecimal(event.lastTradePrice),
        quantity: requiredDecimal(event.lastTradeQuantity),
        quoteQuantity: decimal(event.lastQuoteAssetTransactedQty),
        fee: decimal(event.commission),
        feeAsset: event.commissionAsset ?? undefined,
        executedAtMs: event.tradeTime || event.eventTime,
        updatedAtMs: event.eventTime,
        source: 'ws',
        provenance,
        raw: event,
      },
      provenance,
    });
  }

  return facts;
}

export const binance = {
  rest: {
    positions(
      scope: AccountScope,
      rows: BinanceUsdmPositionRow[],
      options?: BinanceRestSnapshotOptions,
    ) {
      const normalizedRows = rows
        .map((row) => normalizeBinanceUsdmPosition(row, scope))
        .filter((position) => !isFlatPosition(position));

      return createRestSnapshot(
        scope,
        'positions',
        normalizedRows,
        options,
        'replace-scope',
      );
    },
    openOrders(
      scope: AccountScope,
      rows: BinanceUsdmRegularOpenOrderRow[],
      options?: BinanceRestSnapshotOptions,
    ) {
      return createRestSnapshot(
        scope,
        'openOrders',
        rows.map((row) => normalizeBinanceUsdmRegularOpenOrder(row, scope)),
        withOrderKindCoverage(options, ['regular']),
        'replace-scope',
      );
    },
    openAlgoOrders(
      scope: AccountScope,
      rows: BinanceUsdmOpenAlgoOrderRow[],
      options?: BinanceRestSnapshotOptions,
    ) {
      return createRestSnapshot(
        scope,
        'openOrders',
        rows.map((row) => normalizeBinanceUsdmOpenAlgoOrder(row, scope)),
        withOrderKindCoverage(options, ['algo']),
        'replace-scope',
      );
    },
    accountTrades(
      scope: AccountScope,
      rows: BinanceUsdmAccountTradeRow[],
      options?: BinanceRestSnapshotOptions,
    ) {
      return createRestSnapshot(
        scope,
        'fills',
        rows.map((row) => normalizeBinanceUsdmAccountTrade(row, scope)),
        options,
        'upsert-only',
      );
    },
    accountBalances(
      scope: AccountScope,
      rows: BinanceUsdmAccountAssetRow[],
      options?: BinanceRestSnapshotOptions,
    ) {
      return createRestSnapshot(
        scope,
        'balances',
        rows.map((row) => normalizeBinanceUsdmAccountAsset(row, scope)),
        options,
        'replace-scope',
      );
    },
    spotOpenOrders(
      scope: AccountScope,
      rows: BinanceSpotOpenOrderRow[],
      options?: BinanceRestSnapshotOptions,
    ) {
      return createRestSnapshot(
        scope,
        'openOrders',
        rows.map((row) => normalizeBinanceSpotOpenOrder(row, scope)),
        withOrderKindCoverage(options, ['regular']),
        'replace-scope',
      );
    },
  },
  ws: {
    privateEvent(
      scope: AccountScope,
      event: BinanceUsdmPrivateEvent,
      options?: BinanceStreamEventOptions,
    ) {
      return normalizeBinanceUsdmPrivateEvent(event, scope, options);
    },
    summarizePrivateEvent(event: BinanceUsdmPrivateEvent) {
      return summarizeBinanceUsdmPrivateEvent(event);
    },
    routePrivateEvent(event: BinanceUsdmPrivateEvent) {
      return routeBinanceUsdmPrivateEvent(event);
    },
    fingerprintPrivateEvent(event: unknown) {
      return fingerprintBinanceUsdmPrivateEvent(event);
    },
    isTerminalOrderStatus(status: string) {
      return isBinanceTerminalOrderStatus(status);
    },
    isTerminalAlgoStatus(status: string) {
      return isBinanceTerminalAlgoStatus(status);
    },
    spotExecutionReport(
      scope: AccountScope,
      event: BinanceSpotExecutionReportEvent,
      options?: BinanceStreamEventOptions,
    ) {
      return normalizeBinanceSpotExecutionReport(event, scope, options);
    },
  },
  submission: binanceSubmission,
} as const;

function summarizeBinanceAccountUpdate(
  event: BinanceUsdmAccountUpdateEvent,
): BinancePrivateEventSummary {
  return createBinancePrivateEventSummary(event, {
    subjects: [
      event.updateData.updatedBalances.length > 0 ? 'balances' : undefined,
      event.updateData.updatedPositions.length > 0 ? 'positions' : undefined,
    ],
    symbols: event.updateData.updatedPositions.map(
      (position) => position.symbol,
    ),
    assets: event.updateData.updatedBalances.map((balance) => balance.asset),
    exchangePositionSides: event.updateData.updatedPositions.map(
      (position) => position.positionSide,
    ),
  });
}

function summarizeBinanceOrderTradeUpdate(
  event: BinanceUsdmOrderTradeUpdateEvent,
): BinancePrivateEventSummary {
  const order = event.order;
  return createBinancePrivateEventSummary(event, {
    subjects: [
      'openOrders',
      order.executionType === 'TRADE' && Number(order.lastFilledQuantity) > 0
        ? 'fills'
        : undefined,
    ],
    symbols: [order.symbol],
    exchangeOrderIds: [String(order.orderId)],
    customOrderIds: [order.clientOrderId],
    exchangePositionSides: [order.positionSide],
    orderStatuses: [order.orderStatus],
    executionTypes: [order.executionType],
  });
}

function summarizeBinanceAlgoUpdate(
  event: BinanceUsdmAlgoUpdateEvent,
): BinancePrivateEventSummary {
  const order = event.algoOrder;
  return createBinancePrivateEventSummary(event, {
    subjects: ['openOrders'],
    symbols: [order.symbol],
    exchangeOrderIds: [nonZeroString(order.orderId)],
    exchangeTriggerOrderIds: [String(order.algoId)],
    customTriggerOrderIds: [order.clientAlgoId],
    exchangePositionSides: [order.positionSide],
    orderStatuses: [order.algoStatus],
    algoStatuses: [order.algoStatus],
  });
}

function summarizeBinanceTradeLite(
  event: BinanceUsdmTradeLiteEvent,
): BinancePrivateEventSummary {
  return createBinancePrivateEventSummary(event, {
    subjects: ['fills'],
    symbols: [event.symbol],
    exchangeOrderIds: [String(event.orderId)],
    customOrderIds: [event.clientOrderId],
  });
}

function routeBinanceAccountUpdate(
  event: BinanceUsdmAccountUpdateEvent,
): BinancePrivateEventRouteDecision[] {
  return [
    ...event.updateData.updatedBalances.map(
      (balance): BinancePrivateEventRouteDecision => ({
        kind: 'balance',
        source: 'ws',
        eventType: 'ACCOUNT_UPDATE',
        asset: balance.asset,
        raw: balance,
      }),
    ),
    ...event.updateData.updatedPositions.map(
      (position): BinancePrivateEventRouteDecision => ({
        kind: 'position',
        source: 'ws',
        eventType: 'ACCOUNT_UPDATE',
        symbol: position.symbol,
        exchangePositionSide: position.positionSide,
        strategySide: strategySideFromPosition(
          position.positionSide,
          toDecimalString(position.positionAmount),
        ),
        raw: position,
      }),
    ),
  ];
}

function routeBinanceOrderTradeUpdate(
  event: BinanceUsdmOrderTradeUpdateEvent,
): BinancePrivateEventRouteDecision[] {
  const order = event.order;
  const strategySide = strategySideFromPositionSide(order.positionSide);
  const orderDecision: BinancePrivateEventRouteDecision =
    isBinanceTerminalOrderStatus(order.orderStatus)
      ? {
          kind: 'terminalOrder',
          source: 'ws',
          eventType: 'ORDER_TRADE_UPDATE',
          symbol: order.symbol,
          exchangeOrderId: String(order.orderId),
          customOrderId: order.clientOrderId,
          orderStatus: order.orderStatus,
          reason: terminalReasonFromOrderStatus(
            normalizeBinanceOrderStatus(order.orderStatus),
          ),
          exchangePositionSide: order.positionSide,
          strategySide,
          raw: order,
        }
      : {
          kind: 'activeOrder',
          source: 'ws',
          eventType: 'ORDER_TRADE_UPDATE',
          symbol: order.symbol,
          exchangeOrderId: String(order.orderId),
          customOrderId: order.clientOrderId,
          orderStatus: order.orderStatus,
          exchangePositionSide: order.positionSide,
          strategySide,
          raw: order,
        };

  const decisions: BinancePrivateEventRouteDecision[] = [orderDecision];

  if (hasBinanceFillEvidence(order)) {
    decisions.push({
      kind: 'executionFill',
      source: 'ws',
      eventType: 'ORDER_TRADE_UPDATE',
      symbol: order.symbol,
      exchangeOrderId: String(order.orderId),
      customOrderId: order.clientOrderId,
      exchangeTradeId:
        order.tradeId && order.tradeId > 0 ? String(order.tradeId) : undefined,
      executionType: order.executionType,
      exchangePositionSide: order.positionSide,
      strategySide,
      raw: order,
    });
  }

  return decisions;
}

function routeBinanceAlgoUpdate(
  event: BinanceUsdmAlgoUpdateEvent,
): BinancePrivateEventRouteDecision[] {
  const order = event.algoOrder;
  const strategySide = strategySideFromPositionSide(order.positionSide);

  return [
    isBinanceTerminalAlgoStatus(order.algoStatus)
      ? {
          kind: 'terminalOrder',
          source: 'ws',
          eventType: 'ALGO_UPDATE',
          symbol: order.symbol,
          exchangeOrderId: nonZeroString(order.orderId),
          exchangeTriggerOrderId: String(order.algoId),
          customTriggerOrderId: order.clientAlgoId,
          orderStatus: order.algoStatus,
          reason:
            order.algoStatus === 'TRIGGERED'
              ? 'triggered'
              : terminalReasonFromOrderStatus(
                  normalizeBinanceAlgoStatus(order.algoStatus),
                ),
          exchangePositionSide: order.positionSide,
          strategySide,
          raw: order,
        }
      : {
          kind: 'activeOrder',
          source: 'ws',
          eventType: 'ALGO_UPDATE',
          symbol: order.symbol,
          exchangeOrderId: nonZeroString(order.orderId),
          exchangeTriggerOrderId: String(order.algoId),
          customTriggerOrderId: order.clientAlgoId,
          orderStatus: order.algoStatus,
          exchangePositionSide: order.positionSide,
          strategySide,
          raw: order,
        },
  ];
}

function routeBinanceTradeLite(
  event: BinanceUsdmTradeLiteEvent,
): BinancePrivateEventRouteDecision[] {
  return [
    {
      kind: 'executionFill',
      source: 'ws',
      eventType: 'TRADE_LITE',
      symbol: event.symbol,
      exchangeOrderId: String(event.orderId),
      customOrderId: event.clientOrderId,
      exchangeTradeId: String(event.tradeId),
      raw: event,
    },
  ];
}

function createBinancePrivateEventSummary(
  event: BinanceUsdmPrivateEvent,
  overrides: BinancePrivateEventSummaryInput = {},
): BinancePrivateEventSummary {
  return {
    eventType: event.eventType,
    subjects: uniqueStrings(overrides.subjects ?? []),
    symbols: uniqueStrings(overrides.symbols ?? []),
    assets: uniqueStrings(overrides.assets ?? []),
    exchangeOrderIds: uniqueStrings(overrides.exchangeOrderIds ?? []),
    customOrderIds: uniqueStrings(overrides.customOrderIds ?? []),
    exchangeTriggerOrderIds: uniqueStrings(
      overrides.exchangeTriggerOrderIds ?? [],
    ),
    customTriggerOrderIds: uniqueStrings(overrides.customTriggerOrderIds ?? []),
    exchangePositionSides: uniqueStrings(overrides.exchangePositionSides ?? []),
    orderStatuses: uniqueStrings(overrides.orderStatuses ?? []),
    executionTypes: uniqueStrings(overrides.executionTypes ?? []),
    algoStatuses: uniqueStrings(overrides.algoStatuses ?? []),
    eventTimeMs: event.eventTime,
    transactionTimeMs: readTimestamp(event, 'transactionTime'),
  };
}

interface BinancePrivateEventSummaryInput {
  subjects?: readonly (BinancePrivateEventSubject | undefined)[];
  symbols?: readonly (string | undefined)[];
  assets?: readonly (string | undefined)[];
  exchangeOrderIds?: readonly (string | undefined)[];
  customOrderIds?: readonly (string | undefined)[];
  exchangeTriggerOrderIds?: readonly (string | undefined)[];
  customTriggerOrderIds?: readonly (string | undefined)[];
  exchangePositionSides?: readonly (string | undefined)[];
  orderStatuses?: readonly (string | undefined)[];
  executionTypes?: readonly (string | undefined)[];
  algoStatuses?: readonly (string | undefined)[];
}

function normalizeUsdmPositionRow(
  row: {
    symbol: string;
    positionSide: string;
    positionAmount: string | number;
    entryPrice: string | number;
    markPrice?: string | number;
    liquidationPrice?: string | number;
    updatedAtMs: number;
  },
  scope: AccountScope,
  source: 'rest' | 'ws',
  raw: unknown,
  provenance?: Provenance,
): NormalizedPosition {
  const signedQuantity = requiredDecimal(row.positionAmount);
  return {
    ...scope,
    symbol: row.symbol,
    exchangePositionSide: row.positionSide,
    strategySide: strategySideFromPosition(row.positionSide, signedQuantity),
    quantity: absDecimal(signedQuantity),
    signedQuantity,
    averageEntry: decimal(row.entryPrice),
    markPrice: decimal(row.markPrice),
    liquidationPrice: decimal(row.liquidationPrice),
    updatedAtMs: row.updatedAtMs,
    source,
    provenance,
    raw,
  };
}

function normalizeBinanceOrderStatus(status: string): NormalizedOrderStatus {
  switch (status) {
    case 'NEW':
      return 'new';
    case 'PARTIALLY_FILLED':
      return 'partially_filled';
    case 'FILLED':
      return 'filled';
    case 'CANCELED':
      return 'cancelled';
    case 'EXPIRED':
    case 'EXPIRED_IN_MATCH':
      return 'expired';
    case 'REJECTED':
      return 'rejected';
    case 'PENDING_CANCEL':
      return 'pending_cancel';
    default:
      return 'unknown';
  }
}

function hasBinanceFillEvidence(
  order: BinanceUsdmOrderTradeUpdateEvent['order'],
): boolean {
  return order.executionType === 'TRADE' && Number(order.lastFilledQuantity) > 0;
}

function normalizeBinanceAlgoStatus(status: string): NormalizedOrderStatus {
  switch (status) {
    case 'NEW':
    case 'TRIGGERING':
      return 'new';
    case 'FINISHED':
      return 'filled';
    case 'CANCELED':
      return 'cancelled';
    case 'EXPIRED':
      return 'expired';
    case 'REJECTED':
      return 'rejected';
    default:
      return 'unknown';
  }
}

function strategySideFromPosition(
  positionSide: string,
  signedQuantity: string,
): 'LONG' | 'SHORT' | 'FLAT' {
  if (positionSide === 'LONG' || positionSide === 'SHORT') {
    return positionSide;
  }
  if (isZeroDecimal(signedQuantity)) {
    return 'FLAT';
  }
  return signedQuantity.startsWith('-') ? 'SHORT' : 'LONG';
}

function strategySideFromPositionSide(
  positionSide: string,
): OrderStrategySide | undefined {
  return positionSide === 'LONG' || positionSide === 'SHORT'
    ? positionSide
    : undefined;
}

function createRestSnapshot<T>(
  scope: AccountScope,
  subject: SnapshotSubject,
  rows: T[],
  options: BinanceRestSnapshotOptions | undefined,
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
  event: { eventType: string; eventTime: number; transactionTime?: number },
  options: BinanceStreamEventOptions,
): Provenance {
  return {
    source: 'ws',
    receivedAtMs:
      options.receivedAtMs ?? event.transactionTime ?? event.eventTime,
    exchangeEventTimeMs: event.eventTime,
    eventId: options.eventId ?? event.eventType,
    sequence: options.sequence,
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

function terminalReasonFromOrderStatus(
  status: NormalizedOrderStatus,
): TerminalReason {
  switch (status) {
    case 'filled':
      return 'filled';
    case 'cancelled':
      return 'cancelled';
    case 'expired':
      return 'expired';
    case 'rejected':
      return 'rejected';
    default:
      return 'manual_operator_terminal';
  }
}

function isTerminalOrderStatus(status: NormalizedOrderStatus): boolean {
  return (
    status === 'filled' ||
    status === 'cancelled' ||
    status === 'expired' ||
    status === 'rejected'
  );
}

function withOrderKindCoverage(
  options: BinanceRestSnapshotOptions | undefined,
  orderKinds: SnapshotCoverage['orderKinds'],
): BinanceRestSnapshotOptions | undefined {
  return {
    ...options,
    coverage: {
      ...options?.coverage,
      orderKinds: options?.coverage?.orderKinds ?? orderKinds,
    },
  };
}

function inferRowsAsOfMs(rows: unknown[]): TimestampMs {
  const timestamps = rows
    .map((row) => (isRecord(row) ? row['updatedAtMs'] : undefined))
    .filter((value): value is number => typeof value === 'number');
  return timestamps.length > 0 ? Math.max(...timestamps) : 0;
}

function readClientOrderId(row: unknown): string | undefined {
  if (!isRecord(row)) {
    return undefined;
  }

  const clientOrderId = row['clientOrderId'] ?? row['newClientOrderId'];
  return typeof clientOrderId === 'string' && clientOrderId
    ? clientOrderId
    : undefined;
}

function decimal(
  value: string | number | null | undefined,
): string | undefined {
  return value === undefined || value === null
    ? undefined
    : toDecimalString(value);
}

function requiredDecimal(value: string | number): string {
  return toDecimalString(value);
}

function absDecimal(value: string): string {
  return value.startsWith('-') ? value.slice(1) : value;
}

function isZeroDecimal(value: string): boolean {
  return Number(value) === 0;
}

function isFlatPosition(position: NormalizedPosition): boolean {
  return position.strategySide === 'FLAT' || isZeroDecimal(position.quantity);
}

function nonZeroString(value: string | number | undefined): string | undefined {
  if (value === undefined || value === '' || Number(value) === 0) {
    return undefined;
  }

  return String(value);
}

function uniqueStrings<T extends string>(
  values: readonly (T | undefined)[],
): T[] {
  return Array.from(new Set(values.filter(isNonEmptyString))) as T[];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function readTimestamp(row: unknown, key: string): TimestampMs | undefined {
  if (!isRecord(row)) {
    return undefined;
  }

  const value = row[key];
  return typeof value === 'number' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
