import type {
  NormalizedBalance,
  NormalizedFill,
  NormalizedOrder,
  NormalizedPosition,
} from './types.js';

/**
 * Identity for an exchange position slot within a scope.
 *
 * A symbol can have more than one active slot in hedge mode, so the exchange
 * position side is part of the key.
 */
export function getPositionKey(position: NormalizedPosition): string {
  return `${position.symbol}:${position.exchangePositionSide}`;
}

/**
 * Identity for a balance row within a scope.
 */
export function getBalanceKey(balance: NormalizedBalance): string {
  return balance.asset;
}

/**
 * Prefer stable exchange/client/algo ids for order identity.
 *
 * The synthetic fallback is only for rows without any exchange-provided or
 * app-provided identity; adapters should supply one of the real id fields when
 * possible.
 */
export function getOrderKey(order: NormalizedOrder): string {
  if (order.exchangeOrderId) {
    return `exchangeOrderId:${order.exchangeOrderId}`;
  }
  if (order.customClientOrderId) {
    return `customClientOrderId:${order.customClientOrderId}`;
  }
  if (order.exchangeAlgoId) {
    return `exchangeAlgoId:${order.exchangeAlgoId}`;
  }
  if (order.clientAlgoId) {
    return `clientAlgoId:${order.clientAlgoId}`;
  }

  return [
    'synthetic',
    order.symbol,
    order.kind,
    order.side,
    order.type,
    order.exchangePositionSide ?? '',
    order.price ?? '',
    order.triggerPrice ?? '',
    order.quantity ?? '',
    order.createdAtMs ?? order.updatedAtMs,
  ].join(':');
}

/**
 * Prefer exchange trade ids for fill identity, then fall back to order identity
 * plus execution time for exchanges that do not expose a trade id.
 */
export function getFillKey(fill: NormalizedFill): string {
  if (fill.exchangeTradeId) {
    return `exchangeTradeId:${fill.exchangeTradeId}`;
  }
  if (fill.exchangeOrderId) {
    return `exchangeOrderId:${fill.exchangeOrderId}:${fill.executedAtMs}`;
  }
  if (fill.customClientOrderId) {
    return `customClientOrderId:${fill.customClientOrderId}:${fill.executedAtMs}`;
  }
  if (fill.clientAlgoId) {
    return `clientAlgoId:${fill.clientAlgoId}:${fill.executedAtMs}`;
  }

  return [
    'synthetic',
    fill.symbol,
    fill.side,
    fill.price,
    fill.quantity,
    fill.executedAtMs,
  ].join(':');
}

/**
 * Return true when two order rows carry any shared strong identity.
 *
 * Used to converge local client-id-only orders with later exchange-confirmed
 * rows without creating duplicates.
 */
export function ordersShareIdentity(
  a: NormalizedOrder,
  b: NormalizedOrder,
): boolean {
  return (
    sharesDefinedValue(a.exchangeOrderId, b.exchangeOrderId) ||
    sharesDefinedValue(a.customClientOrderId, b.customClientOrderId) ||
    sharesDefinedValue(a.exchangeAlgoId, b.exchangeAlgoId) ||
    sharesDefinedValue(a.clientAlgoId, b.clientAlgoId)
  );
}

/**
 * Compare optional identifiers while treating two missing values as no match.
 */
function sharesDefinedValue(
  a: string | undefined,
  b: string | undefined,
): boolean {
  return a !== undefined && b !== undefined && a === b;
}
