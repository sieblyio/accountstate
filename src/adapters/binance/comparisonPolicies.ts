import type {
  ComparisonContext,
  ComparisonResult,
  OrderComparisonPolicy,
} from '../../core/plugins.js';
import type { NormalizedOrder } from '../../core/types.js';

const CLOSE_POSITION_IGNORED_FIELDS = new Set<keyof NormalizedOrder>([
  'quantity',
  'price',
  'closePosition',
  'reduceOnly',
  'timeInForce',
]);

const COMPARED_FIELDS: (keyof NormalizedOrder)[] = [
  'exchange',
  'accountId',
  'product',
  'environment',
  'symbol',
  'kind',
  'side',
  'type',
  'status',
  'exchangePositionSide',
  'strategySide',
  'triggerPrice',
  'timeInForce',
  'workingType',
  'priceProtect',
  'quantity',
  'price',
  'closePosition',
  'reduceOnly',
];

const DECIMAL_FIELDS = new Set<keyof NormalizedOrder>([
  'triggerPrice',
  'quantity',
  'executedQuantity',
  'remainingQuantity',
  'price',
  'averagePrice',
]);

const FALSE_DEFAULT_FIELDS = new Set<keyof NormalizedOrder>([
  'closePosition',
  'reduceOnly',
  'priceProtect',
]);

interface OrderComparisonOptions {
  binanceDefaults?: boolean;
}

/**
 * Treat Binance USD-M close-position stop defaults as equivalent once identity
 * and trigger fields match. Binance may echo quantity, price, reduceOnly, and
 * timeInForce defaults that were not present in the desired request.
 */
export const binanceUsdmClosePositionStopComparisonPolicy: OrderComparisonPolicy =
  {
    name: 'binance_usdm_close_position_stop_defaults',
    applies(desired, active) {
      return (
        desired.exchange === 'binance' &&
        active.exchange === 'binance' &&
        desired.product === 'usdm' &&
        active.product === 'usdm' &&
        desired.kind === 'algo' &&
        active.kind === 'algo' &&
        (desired.closePosition === true || active.closePosition === true) &&
        isStopLike(desired.type) &&
        isStopLike(active.type)
      );
    },
    equivalent(desired, active) {
      const differences = compareOrdersIgnoring(
        desired,
        active,
        CLOSE_POSITION_IGNORED_FIELDS,
        { binanceDefaults: true },
      );
      if (!ordersShareAnyIdentity(desired, active)) {
        differences.unshift('identity');
      }

      return differences.length === 0
        ? { equivalent: true }
        : {
            equivalent: false,
            reason: 'orders differ outside Binance close-position defaults',
            differences,
          };
    },
  };

/**
 * Treat common Binance USD-M REST/WebSocket echo defaults as equivalent to
 * omitted request fields. This is for managed-order desired-vs-active checks,
 * not for validating raw exchange requests.
 */
export const binanceUsdmOrderDefaultsComparisonPolicy: OrderComparisonPolicy = {
  name: 'binance_usdm_order_defaults',
  applies(desired, active) {
    return (
      desired.exchange === 'binance' &&
      active.exchange === 'binance' &&
      desired.product === 'usdm' &&
      active.product === 'usdm'
    );
  },
  equivalent(desired, active) {
    const differences = compareOrdersIgnoring(desired, active, new Set(), {
      binanceDefaults: true,
    });
    if (!ordersShareAnyIdentity(desired, active)) {
      differences.unshift('identity');
    }

    return differences.length === 0
      ? { equivalent: true }
      : {
          equivalent: false,
          reason: 'orders differ outside Binance exchange defaults',
          differences,
        };
  },
};

export const binanceDefaultComparisonPolicies: OrderComparisonPolicy[] = [
  binanceUsdmClosePositionStopComparisonPolicy,
  binanceUsdmOrderDefaultsComparisonPolicy,
];

export interface BinanceManagedOrderComparisonInput {
  desired: NormalizedOrder;
  active: NormalizedOrder;
  product?: 'usdm' | string;
  positionMode?: 'one-way' | 'hedge' | string;
  context?: ComparisonContext;
  policies?: OrderComparisonPolicy[];
}

/**
 * Compare desired and active Binance-managed orders using the default adapter
 * policies for exchange echo/default fields.
 */
export function areBinanceManagedOrdersEquivalent(
  input: BinanceManagedOrderComparisonInput,
): boolean {
  return explainBinanceManagedOrderDiff(input).equivalent;
}

/**
 * Explain whether a desired Binance-managed order already matches an active
 * exchange row after applying Binance-specific comparison policies.
 */
export function explainBinanceManagedOrderDiff(
  input: BinanceManagedOrderComparisonInput,
): ComparisonResult {
  const policies = input.policies ?? binanceDefaultComparisonPolicies;
  for (const policy of policies) {
    if (policy.applies(input.desired, input.active)) {
      return policy.equivalent(
        input.desired,
        input.active,
        input.context ?? {},
      );
    }
  }

  const differences = compareOrdersIgnoring(
    input.desired,
    input.active,
    new Set(),
  );
  if (!ordersShareAnyIdentity(input.desired, input.active)) {
    differences.unshift('identity');
  }

  return differences.length === 0
    ? { equivalent: true }
    : {
        equivalent: false,
        reason: 'orders differ',
        differences,
      };
}

function compareOrdersIgnoring(
  desired: NormalizedOrder,
  active: NormalizedOrder,
  ignoredFields: Set<keyof NormalizedOrder>,
  options: OrderComparisonOptions = {},
): string[] {
  const differences: string[] = [];
  for (const field of COMPARED_FIELDS) {
    if (ignoredFields.has(field)) {
      continue;
    }
    if (!orderFieldValuesMatch(field, desired, active, options)) {
      differences.push(field);
    }
  }

  return differences;
}

function orderFieldValuesMatch(
  field: keyof NormalizedOrder,
  desired: NormalizedOrder,
  active: NormalizedOrder,
  options: OrderComparisonOptions,
): boolean {
  const desiredValue = comparableOrderValue(field, desired);
  const activeValue = comparableOrderValue(field, active);

  if (Object.is(desiredValue, activeValue)) {
    return true;
  }

  if (DECIMAL_FIELDS.has(field)) {
    if (decimalValuesMatch(desiredValue, activeValue)) {
      return true;
    }
    if (
      options.binanceDefaults &&
      isUndefinedVsExchangeZeroDefault(field, desired, active)
    ) {
      return true;
    }
  }

  if (!options.binanceDefaults) {
    return false;
  }

  if (
    field === 'status' &&
    isNewOrProvisionalStatus(desired.status) &&
    isNewOrProvisionalStatus(active.status)
  ) {
    return true;
  }

  if (
    FALSE_DEFAULT_FIELDS.has(field) &&
    isUndefinedFalseDefault(desiredValue, activeValue)
  ) {
    return true;
  }

  if (
    field === 'reduceOnly' &&
    isHedgeAlgoReduceOnlyEchoDefault(desired, active)
  ) {
    return true;
  }

  if (
    field === 'workingType' &&
    desiredValue === undefined &&
    activeValue === 'CONTRACT_PRICE'
  ) {
    return true;
  }

  if (
    field === 'timeInForce' &&
    desiredValue === undefined &&
    isDefaultBinanceTimeInForce(activeValue)
  ) {
    return true;
  }

  return false;
}

function comparableOrderValue(
  field: keyof NormalizedOrder,
  order: NormalizedOrder,
): unknown {
  if (field === 'exchangePositionSide') {
    return order.exchangePositionSide ?? order.metadata?.exchangePositionSide;
  }
  if (field === 'strategySide') {
    return order.strategySide ?? order.metadata?.strategySide;
  }

  return order[field];
}

function decimalValuesMatch(
  desiredValue: unknown,
  activeValue: unknown,
): boolean {
  if (typeof desiredValue === 'string' && typeof activeValue === 'string') {
    return (
      normalizeDecimalForCompare(desiredValue) ===
      normalizeDecimalForCompare(activeValue)
    );
  }

  return false;
}

function isUndefinedVsExchangeZeroDefault(
  field: keyof NormalizedOrder,
  desired: NormalizedOrder,
  active: NormalizedOrder,
): boolean {
  if (desired[field] !== undefined || !isZeroDecimal(active[field])) {
    return false;
  }

  if (field === 'price') {
    return true;
  }

  if (field === 'triggerPrice') {
    return !requiresTriggerPrice(desired) && !requiresTriggerPrice(active);
  }

  return false;
}

function isUndefinedFalseDefault(
  desiredValue: unknown,
  activeValue: unknown,
): boolean {
  return (
    (desiredValue === undefined && activeValue === false) ||
    (desiredValue === false && activeValue === undefined)
  );
}

function isHedgeAlgoReduceOnlyEchoDefault(
  desired: NormalizedOrder,
  active: NormalizedOrder,
): boolean {
  return (
    desired.kind === 'algo' &&
    active.kind === 'algo' &&
    desired.reduceOnly === undefined &&
    active.reduceOnly === true &&
    isHedgePositionSide(
      desired.exchangePositionSide ??
        desired.metadata?.exchangePositionSide ??
        active.exchangePositionSide ??
        active.metadata?.exchangePositionSide,
    )
  );
}

function isDefaultBinanceTimeInForce(value: unknown): boolean {
  return value === 'GTC' || value === 'GTE_GTC';
}

function isNewOrProvisionalStatus(value: NormalizedOrder['status']): boolean {
  return value === 'new' || value === 'provisional';
}

function isZeroDecimal(value: unknown): boolean {
  return typeof value === 'string' && normalizeDecimalForCompare(value) === '0';
}

function requiresTriggerPrice(order: NormalizedOrder): boolean {
  return (
    isStopLike(order.type) ||
    order.type.includes('TAKE_PROFIT') ||
    order.type.includes('TRAILING_STOP')
  );
}

function isHedgePositionSide(value: unknown): boolean {
  return value === 'LONG' || value === 'SHORT';
}

function ordersShareAnyIdentity(
  desired: NormalizedOrder,
  active: NormalizedOrder,
): boolean {
  return (
    sharesDefinedValue(desired.exchangeOrderId, active.exchangeOrderId) ||
    sharesDefinedValue(
      desired.customOrderId,
      active.customOrderId,
    ) ||
    sharesDefinedValue(
      desired.customTriggerOrderId,
      active.customTriggerOrderId,
    ) ||
    sharesDefinedValue(
      desired.exchangeTriggerOrderId,
      active.exchangeTriggerOrderId,
    )
  );
}

function sharesDefinedValue(
  desiredValue: string | undefined,
  activeValue: string | undefined,
): boolean {
  return desiredValue !== undefined && desiredValue === activeValue;
}

function normalizeDecimalForCompare(value: string): string {
  const sign = value.startsWith('-') ? '-' : '';
  const unsigned = value.replace(/^[+-]/, '');
  const [rawWhole = '0', rawFraction = ''] = unsigned.split('.');
  const whole = rawWhole.replace(/^0+(?=\d)/, '') || '0';
  const fraction = rawFraction.replace(/0+$/, '');
  const normalized = fraction ? `${whole}.${fraction}` : whole;

  return normalized === '0' ? '0' : `${sign}${normalized}`;
}

function isStopLike(type: string): boolean {
  return type.includes('STOP');
}
