import type { OrderComparisonPolicy } from '../../core/plugins.js';
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

export const binanceDefaultComparisonPolicies: OrderComparisonPolicy[] = [
  binanceUsdmClosePositionStopComparisonPolicy,
];

function compareOrdersIgnoring(
  desired: NormalizedOrder,
  active: NormalizedOrder,
  ignoredFields: Set<keyof NormalizedOrder>,
): string[] {
  const differences: string[] = [];
  for (const field of COMPARED_FIELDS) {
    if (ignoredFields.has(field)) {
      continue;
    }
    if (!orderFieldValuesMatch(field, desired[field], active[field])) {
      differences.push(field);
    }
  }

  return differences;
}

function orderFieldValuesMatch(
  field: keyof NormalizedOrder,
  desiredValue: NormalizedOrder[keyof NormalizedOrder],
  activeValue: NormalizedOrder[keyof NormalizedOrder],
): boolean {
  if (
    field === 'triggerPrice' &&
    typeof desiredValue === 'string' &&
    typeof activeValue === 'string'
  ) {
    return (
      normalizeDecimalForCompare(desiredValue) ===
      normalizeDecimalForCompare(activeValue)
    );
  }

  return Object.is(desiredValue, activeValue);
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
