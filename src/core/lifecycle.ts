import type { ManagedOrderParser } from './plugins.js';
import type {
  AccountScope,
  NormalizedOrder,
  NormalizedPosition,
  OrderStrategySide,
  PositionLifecycle,
} from './types.js';
import { copyScope } from './utils.js';

interface LifecycleReconciliationInput {
  scope: AccountScope;
  lifecycles: PositionLifecycle[];
  positions: NormalizedPosition[];
  openOrders: NormalizedOrder[];
}

interface LifecycleReconciliationResult {
  lifecycles: PositionLifecycle[];
  changed: boolean;
}

/**
 * Apply project-owned managed order parsers to one order row.
 */
export function applyManagedOrderParsers(
  order: NormalizedOrder,
  parsers: ManagedOrderParser[],
): NormalizedOrder {
  const metadata = order.metadata ?? parseManagedOrder(order, parsers);
  if (!metadata) {
    return order;
  }

  return {
    ...order,
    owner: order.owner === 'manual' ? order.owner : 'app',
    metadata: { ...metadata },
  };
}

/**
 * Reconcile lifecycle rows from the current position and open-order state.
 */
export function reconcilePositionLifecycles(
  input: LifecycleReconciliationInput,
): LifecycleReconciliationResult {
  const activePositions = new Map(
    input.positions
      .filter(isOpenStrategyPosition)
      .map((position) => [getPositionLifecycleKey(position), position]),
  );
  const nextLifecycles: PositionLifecycle[] = [];
  const handledActiveKeys = new Set<string>();
  let changed = false;

  for (const lifecycle of input.lifecycles) {
    const key = getLifecycleKey(lifecycle);
    const activePosition = activePositions.get(key);
    if (activePosition) {
      handledActiveKeys.add(key);
      const { lifecycle: updated, change } = updateOpenLifecycle(
        lifecycle,
        activePosition,
      );
      nextLifecycles.push(updated);
      changed = changed || change;
      continue;
    }

    if (hasBlockingAppOrder(input.openOrders, lifecycle)) {
      const cleanup = { ...lifecycle, status: 'cleanup_pending' as const };
      nextLifecycles.push(cleanup);
      if (lifecycle.status !== 'cleanup_pending') {
        changed = true;
      }
      continue;
    }

    changed = true;
  }

  for (const [key, position] of activePositions.entries()) {
    if (handledActiveKeys.has(key)) {
      continue;
    }

    const created = createPositionLifecycle(input.scope, position);
    nextLifecycles.push(created);
    changed = true;
  }

  return { lifecycles: nextLifecycles, changed };
}

function parseManagedOrder(
  order: NormalizedOrder,
  parsers: ManagedOrderParser[],
) {
  for (const parser of parsers) {
    const metadata = parser.parse(order);
    if (metadata) {
      return metadata;
    }
  }

  return undefined;
}

function updateOpenLifecycle(
  lifecycle: PositionLifecycle,
  position: NormalizedPosition,
): {
  lifecycle: PositionLifecycle;
  change: boolean;
} {
  const quantityChanged = lifecycle.lastQuantity !== position.quantity;
  const averageEntryChanged =
    lifecycle.lastAverageEntry !== position.averageEntry;
  const changed = quantityChanged || averageEntryChanged;
  const reopened = lifecycle.status !== 'open';

  const updated: PositionLifecycle = {
    ...lifecycle,
    lastQuantity: position.quantity,
    lastAverageEntry: position.averageEntry,
    status: 'open',
  };

  if (changed || reopened) {
    return { lifecycle: updated, change: true };
  }

  return { lifecycle: updated, change: false };
}

function createPositionLifecycle(
  scope: AccountScope,
  position: NormalizedPosition,
): PositionLifecycle {
  return {
    ...copyScope(scope),
    symbol: position.symbol,
    exchangePositionSide: position.exchangePositionSide,
    strategySide: position.strategySide as OrderStrategySide,
    lifecycleEpoch: [
      position.symbol,
      position.exchangePositionSide,
      position.strategySide,
      position.updatedAtMs,
    ].join(':'),
    openedAtMs: position.updatedAtMs,
    lastQuantity: position.quantity,
    lastAverageEntry: position.averageEntry,
    status: 'open',
  };
}

function hasBlockingAppOrder(
  orders: NormalizedOrder[],
  lifecycle: PositionLifecycle,
): boolean {
  return orders.some(
    (order) =>
      isBlockingAppOrder(order) && orderMatchesLifecycle(order, lifecycle),
  );
}

function isBlockingAppOrder(order: NormalizedOrder): boolean {
  return (
    order.owner === 'app' &&
    order.status !== 'filled' &&
    order.status !== 'cancelled' &&
    order.status !== 'expired' &&
    order.status !== 'rejected'
  );
}

function orderMatchesLifecycle(
  order: NormalizedOrder,
  lifecycle: PositionLifecycle,
): boolean {
  if (order.symbol !== lifecycle.symbol) {
    return false;
  }

  const orderPositionSide =
    order.metadata?.exchangePositionSide ?? order.exchangePositionSide;
  const orderStrategySide = order.metadata?.strategySide ?? order.strategySide;

  return (
    matchesOptional(lifecycle.exchangePositionSide, orderPositionSide) &&
    matchesOptional(lifecycle.strategySide, orderStrategySide)
  );
}

function isOpenStrategyPosition(
  position: NormalizedPosition,
): position is NormalizedPosition & { strategySide: OrderStrategySide } {
  return (
    position.strategySide !== 'FLAT' && !isZeroDecimalString(position.quantity)
  );
}

function getPositionLifecycleKey(position: NormalizedPosition): string {
  return [
    position.symbol,
    position.exchangePositionSide,
    position.strategySide,
  ].join(':');
}

function getLifecycleKey(lifecycle: PositionLifecycle): string {
  return [
    lifecycle.symbol,
    lifecycle.exchangePositionSide,
    lifecycle.strategySide,
  ].join(':');
}

function isZeroDecimalString(value: string): boolean {
  const digits = value.trim().replace(/^[+-]/, '').replace('.', '');
  return digits.length > 0 && /^0+$/.test(digits);
}

function matchesOptional<T>(
  value: T | undefined,
  expected: T | undefined,
): boolean {
  return expected === undefined || value === expected;
}
