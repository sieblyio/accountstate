import type { StateInvariant } from './plugins.js';
import type {
  AccountView,
  ConfidenceState,
  DecimalString,
  InvariantViolation,
  NormalizedBalance,
  NormalizedFill,
  NormalizedOrder,
  NormalizedPosition,
  PositionLifecycle,
  TimestampMs,
} from './types.js';

export const DEFAULT_PROVISIONAL_ORDER_STALE_MS = 30_000;

/**
 * Runtime options for built-in account-state invariants.
 */
export interface InvariantRuntimeOptions {
  /**
   * Maximum age for provisional orders before `checkInvariants` warns. Set to
   * `false` to disable the built-in stale provisional order check.
   */
  provisionalOrderStaleMs?: TimestampMs | false;
  /**
   * Enable a best-effort check for decimal strings that look like binary
   * floating-point artifacts.
   */
  validateDecimalStrings?: boolean;
}

/**
 * Per-run overrides for `checkInvariants`.
 */
export interface CheckInvariantsOptions extends InvariantRuntimeOptions {
  /**
   * Timestamp used for stale-order checks. Defaults to the store clock.
   */
  nowMs?: TimestampMs;
}

interface InvariantContext {
  nowMs: TimestampMs;
  provisionalOrderStaleMs: TimestampMs | false;
  validateDecimalStrings: boolean;
}

/**
 * Run the built-in account-state health checks against one account view.
 */
export function getBuiltInInvariantViolations(
  view: AccountView,
  options: CheckInvariantsOptions = {},
): InvariantViolation[] {
  const context: InvariantContext = {
    nowMs: options.nowMs ?? Date.now(),
    provisionalOrderStaleMs:
      options.provisionalOrderStaleMs ?? DEFAULT_PROVISIONAL_ORDER_STALE_MS,
    validateDecimalStrings: options.validateDecimalStrings ?? false,
  };

  return [
    ...findDuplicateActiveCustomOrderIds(view),
    ...findAppOrdersWithoutLifecycle(view),
    ...findActiveLifecyclesWithoutPosition(view),
    ...findStaleProvisionalOrders(view, context),
    ...findUnsafeReadyView(view),
    ...findBinaryFloatDecimalStrings(view, context),
  ];
}

/**
 * Run project-provided invariants and clone their result array.
 */
export function runCustomInvariants(
  view: AccountView,
  invariants: StateInvariant[],
): InvariantViolation[] {
  return invariants.flatMap((invariant) =>
    invariant.check(view).map((violation) => ({
      name: violation.name ?? invariant.name,
      severity: violation.severity ?? invariant.severity ?? 'error',
      scope: violation.scope ?? view.scope,
      message: violation.message,
      context: violation.context ? { ...violation.context } : undefined,
    })),
  );
}

function findDuplicateActiveCustomOrderIds(
  view: AccountView,
): InvariantViolation[] {
  const ordersByCustomId = new Map<string, NormalizedOrder[]>();
  for (const order of view.openOrders) {
    if (!order.customOrderId || !isActiveOrder(order)) {
      continue;
    }

    const existing = ordersByCustomId.get(order.customOrderId) ?? [];
    existing.push(order);
    ordersByCustomId.set(order.customOrderId, existing);
  }

  return Array.from(ordersByCustomId.entries())
    .filter(([, orders]) => orders.length > 1)
    .map(([customOrderId, orders]) => ({
      name: 'duplicate_active_custom_order_id',
      severity: 'error',
      scope: view.scope,
      message:
        'Multiple active open orders share the same custom order id.',
      context: {
        customOrderId,
        orderCount: orders.length,
        exchangeOrderIds: orders.map((order) => order.exchangeOrderId),
      },
    }));
}

function findAppOrdersWithoutLifecycle(
  view: AccountView,
): InvariantViolation[] {
  return view.openOrders
    .filter((order) => order.owner === 'app' && isActiveOrder(order))
    .filter((order) => !hasKnownLifecycle(order, view.lifecycles))
    .map((order) => ({
      name: 'active_app_order_without_lifecycle',
      severity: 'error',
      scope: view.scope,
      message:
        'Active app-owned order is not linked to a known position lifecycle.',
      context: {
        symbol: order.symbol,
        exchangePositionSide: order.exchangePositionSide,
        strategySide: order.strategySide,
        customOrderId: order.customOrderId,
        lifecycleEpoch: order.metadata?.lifecycleEpoch,
      },
    }));
}

function findActiveLifecyclesWithoutPosition(
  view: AccountView,
): InvariantViolation[] {
  return view.lifecycles
    .filter(
      (lifecycle) =>
        lifecycle.status !== 'cleanup_pending' &&
        lifecycle.status !== 'settled' &&
        !hasMatchingOpenPosition(lifecycle, view.positions),
    )
    .map((lifecycle) => ({
      name: 'active_lifecycle_without_position',
      severity: 'error',
      scope: view.scope,
      message: 'Lifecycle is active but no matching open position is present.',
      context: {
        symbol: lifecycle.symbol,
        exchangePositionSide: lifecycle.exchangePositionSide,
        strategySide: lifecycle.strategySide,
        lifecycleEpoch: lifecycle.lifecycleEpoch,
        status: lifecycle.status,
      },
    }));
}

function findStaleProvisionalOrders(
  view: AccountView,
  context: InvariantContext,
): InvariantViolation[] {
  if (context.provisionalOrderStaleMs === false) {
    return [];
  }

  const provisionalOrderStaleMs = context.provisionalOrderStaleMs;
  return view.openOrders
    .filter((order) => order.status === 'provisional')
    .filter((order) => {
      const sinceMs =
        order.acceptedAtMs ?? order.createdAtMs ?? order.updatedAtMs;
      return context.nowMs - sinceMs > provisionalOrderStaleMs;
    })
    .map((order) => ({
      name: 'stale_provisional_order',
      severity: 'warn',
      scope: view.scope,
      message:
        'Provisional order has exceeded the configured confirmation grace period.',
      context: {
        customOrderId: order.customOrderId,
        acceptedAtMs: order.acceptedAtMs,
        updatedAtMs: order.updatedAtMs,
        nowMs: context.nowMs,
        provisionalOrderStaleMs: context.provisionalOrderStaleMs,
      },
    }));
}

function findUnsafeReadyView(view: AccountView): InvariantViolation[] {
  const unsafeSubjects = Object.entries({
    positions: view.confidence.positions,
    openOrders: view.confidence.openOrders,
    balances: view.confidence.balances,
  }).filter(([, confidence]) => isUnsafeRequiredConfidence(confidence));

  if (view.hasStateChecks || unsafeSubjects.length === 0) {
    return [];
  }

  return [
    {
      name: 'unsafe_ready_account_view',
      severity: 'error',
      scope: view.scope,
      message:
        'Account view has no state checks while required subjects are unsafe.',
      context: {
        unsafeSubjects: unsafeSubjects.map(([subject, confidence]) => ({
          subject,
          confidence,
        })),
      },
    },
  ];
}

function findBinaryFloatDecimalStrings(
  view: AccountView,
  context: InvariantContext,
): InvariantViolation[] {
  if (!context.validateDecimalStrings) {
    return [];
  }

  return [
    ...view.positions.flatMap((position) =>
      decimalFieldViolations(view, 'position', position, {
        quantity: position.quantity,
        signedQuantity: position.signedQuantity,
        averageEntry: position.averageEntry,
        markPrice: position.markPrice,
        liquidationPrice: position.liquidationPrice,
        leverage: position.leverage,
      }),
    ),
    ...view.openOrders.flatMap((order) =>
      decimalFieldViolations(view, 'openOrder', order, {
        quantity: order.quantity,
        executedQuantity: order.executedQuantity,
        remainingQuantity: order.remainingQuantity,
        price: order.price,
        averagePrice: order.averagePrice,
        triggerPrice: order.triggerPrice,
      }),
    ),
    ...view.balances.flatMap((balance) =>
      decimalFieldViolations(view, 'balance', balance, {
        walletBalance: balance.walletBalance,
        availableBalance: balance.availableBalance,
        lockedBalance: balance.lockedBalance,
        unrealizedPnl: balance.unrealizedPnl,
      }),
    ),
    ...view.fills.flatMap((fill) =>
      decimalFieldViolations(view, 'fill', fill, {
        price: fill.price,
        quantity: fill.quantity,
        quoteQuantity: fill.quoteQuantity,
        fee: fill.fee,
        realizedPnl: fill.realizedPnl,
      }),
    ),
  ];
}

function decimalFieldViolations(
  view: AccountView,
  rowType: string,
  row:
    | NormalizedPosition
    | NormalizedOrder
    | NormalizedBalance
    | NormalizedFill,
  fields: Record<string, DecimalString | undefined>,
): InvariantViolation[] {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined && isBinaryFloatTail(value))
    .map(([field, value]) => ({
      name: 'binary_float_decimal_string',
      severity: 'warn',
      scope: view.scope,
      message: 'Decimal string looks like a JavaScript binary-float artifact.',
      context: {
        rowType,
        field,
        value,
        symbol: 'symbol' in row ? row.symbol : undefined,
        asset: 'asset' in row ? row.asset : undefined,
      },
    }));
}

function hasKnownLifecycle(
  order: NormalizedOrder,
  lifecycles: PositionLifecycle[],
): boolean {
  if (order.metadata?.lifecycleEpoch) {
    return lifecycles.some(
      (lifecycle) =>
        lifecycle.lifecycleEpoch === order.metadata?.lifecycleEpoch &&
        lifecycle.status !== 'settled',
    );
  }

  let candidates = lifecycles.filter(
    (lifecycle) =>
      lifecycle.status !== 'settled' && lifecycle.symbol === order.symbol,
  );
  if (order.exchangePositionSide) {
    candidates = candidates.filter(
      (lifecycle) =>
        lifecycle.exchangePositionSide === order.exchangePositionSide,
    );
  }
  if (order.strategySide) {
    candidates = candidates.filter(
      (lifecycle) => lifecycle.strategySide === order.strategySide,
    );
  }

  return candidates.length === 1;
}

function hasMatchingOpenPosition(
  lifecycle: PositionLifecycle,
  positions: NormalizedPosition[],
): boolean {
  return positions.some(
    (position) =>
      position.symbol === lifecycle.symbol &&
      position.exchangePositionSide === lifecycle.exchangePositionSide &&
      position.strategySide === lifecycle.strategySide &&
      !isZeroDecimalString(position.quantity),
  );
}

function isActiveOrder(order: NormalizedOrder): boolean {
  return (
    order.status !== 'filled' &&
    order.status !== 'cancelled' &&
    order.status !== 'expired' &&
    order.status !== 'rejected' &&
    order.status !== 'stale'
  );
}

function isUnsafeRequiredConfidence(value: ConfidenceState): boolean {
  return (
    value === 'unknown' ||
    value === 'stale' ||
    value === 'conflicted' ||
    value === 'paused'
  );
}

function isBinaryFloatTail(value: string): boolean {
  const fractional = value.split('.')[1];
  return Boolean(
    fractional &&
    fractional.length >= 15 &&
    /(0{10,}\d{1,4}|9{10,}\d{0,4})$/.test(fractional),
  );
}

function isZeroDecimalString(value: string): boolean {
  const digits = value.trim().replace(/^[+-]/, '').replace('.', '');
  return digits.length > 0 && /^0+$/.test(digits);
}
