import { EngineSimplePosition } from '../lib/types/position';
import { toFixedNumber } from './math';
import { DepthSummary, PositionDepthState } from './position.types';

/** Return the sum the unrealised profit/loss across all active positions */
export function getUnrealisedPnl(
  activePositions: EngineSimplePosition[],
): number {
  return activePositions.reduce((acc, position) => {
    return acc + Number(position.valueUpnl);
  }, 0);
}

/** Return the */
export function getUnrealsedPnlPct(
  activePositions: EngineSimplePosition[],
  walletBalance: number,
): number {
  const estimatedUnrealisedPnl = getUnrealisedPnl(activePositions);
  const estimatedPct = (estimatedUnrealisedPnl / walletBalance) * 100;
  return Number(estimatedPct.toFixed(2));
}

export function calculateDepthForPosition(
  asset: string,
  symbol: string,
  baseAssetBalance: number,
  positionAmount: number,
  entryPrice: number,
  unrealisedPnl: number,
  totalNetUnrealisedPnl: number,
  leverage: number,
): PositionDepthState {
  const estimatedValue = Math.abs(Number(positionAmount) * Number(entryPrice));
  const estimatedValueWithLeverage = Math.abs(estimatedValue / (leverage || 1));
  const positionDepth = (estimatedValueWithLeverage / baseAssetBalance) * 100;
  const positionDepthUnrealised =
    ((estimatedValueWithLeverage - totalNetUnrealisedPnl) / baseAssetBalance) *
    100;
  const balanceRemaining = baseAssetBalance - estimatedValueWithLeverage;

  const estimatedPnlPct =
    (Number(unrealisedPnl) / estimatedValueWithLeverage) * 100;
  return {
    asset,
    symbol,
    positionAmount,
    estimatedValue: toFixedNumber(estimatedValue),
    estimatedValueWithLeverage: toFixedNumber(estimatedValueWithLeverage),
    positionDepth: toFixedNumber(positionDepth),
    positionDepthUnrealised: toFixedNumber(positionDepthUnrealised),
    balanceRemaining: toFixedNumber(balanceRemaining),
    unrealisedPnL: toFixedNumber(unrealisedPnl),
    estimatedPnlPct: toFixedNumber(estimatedPnlPct),
  };
}

/**
 * Aggregate total depth use per position
 */
export function calculateDepthForPositions(
  balanceAvailable: number,
  symbolLeverageCache: Record<string, number>,
  positions: EngineSimplePosition[] | undefined,
  quoteBalanceAsset = 'USDT',
): PositionDepthState[] {
  if (!positions) {
    return [];
  }

  // console.log(`balance: `, { crossWalletBalance, walletBalance, isSame: crossWalletBalance == walletBalance });
  const totalNetUnrealisedPnl = getUnrealisedPnl(positions);

  return positions.map(({ assetQty, positionPrice, symbol, valueUpnl }) =>
    calculateDepthForPosition(
      quoteBalanceAsset,
      symbol,
      balanceAvailable,
      Number(assetQty),
      Number(positionPrice),
      Number(valueUpnl),
      totalNetUnrealisedPnl,
      symbolLeverageCache[symbol] || 1,
    ),
  );
}

export function calulateDepthSummaryForAllPositions(
  balance: number,
  symbolLeverageCache: Record<string, number>,
  positions: EngineSimplePosition[] | undefined,
  quoteBalanceAsset = 'USDT',
  leverageType: 'cross' | 'isolated',
): DepthSummary {
  const depthByPosition = calculateDepthForPositions(
    balance,
    symbolLeverageCache,
    positions,
    quoteBalanceAsset,
  );

  const sums = depthByPosition.reduce(
    (acc, pos) => {
      acc.rawDepthSum += pos.positionDepth;
      acc.estimatedValueWithLeverage += pos.estimatedValueWithLeverage;
      acc.unrealisedPnL += leverageType ? pos.unrealisedPnL : 0;
      return acc;
    },
    {
      rawDepthSum: 0,
      estimatedValueWithLeverage: 0,
      unrealisedPnL: 0,
    },
  );

  const crossBalance = balance + sums.unrealisedPnL;

  const depthWithoutPnL = (sums.estimatedValueWithLeverage / balance) * 100;
  const depthWithPnL = (sums.estimatedValueWithLeverage / crossBalance) * 100;

  return {
    ...sums,
    crossBalance: toFixedNumber(crossBalance),
    depthWithoutPnL: toFixedNumber(depthWithoutPnL),
    depthWithPnL: toFixedNumber(depthWithPnL >= 100 ? 100 : depthWithPnL),
  };
}

export function getDepthPercentForAllPositions(
  positions: EngineSimplePosition[],
  walletBalance: number,
  symbolLeverageCache: Record<string, number>,
  quoteBalanceAsset = 'USDT',
): number {
  const balanceUsageSummary = calulateDepthSummaryForAllPositions(
    walletBalance,
    symbolLeverageCache,
    positions,
    quoteBalanceAsset,
    'cross',
  );
  return balanceUsageSummary.depthWithPnL;
}
