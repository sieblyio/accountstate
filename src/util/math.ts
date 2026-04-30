/**
 * toFixed() for numbers
 */
export function toFixedNumber(
  stringNumber: string | number,
  decimalPlaces = 2,
): number {
  return Number(Number(stringNumber).toFixed(decimalPlaces));
}

/**
 * Account for last seen price to determine upnl of a position
 *
 * For a SHORT position, the asset quantity should be NEGATIVE
 */
export function getUnrealisedPNL(
  lastSeenPrice: number,
  positionAssetQuantity: number,
  positionAvgEntryPrice: number,
): number {
  const priceDiff = lastSeenPrice - positionAvgEntryPrice;
  return positionAssetQuantity * priceDiff;
}
