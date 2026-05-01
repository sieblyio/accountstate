import type { EnginePositionSide } from '../lib/types/position.js';

export interface PositionAgeState {
  symbol: string;
  hours: number;
  minutes: number;
  seconds: number;
}

/** Primary used for logging purposes, determined using state */
export interface PositionStateSummary extends PositionAgeState {
  ECLeader: number;
  ECHedge: number;
  leadingSide: EnginePositionSide;
  size: number;
  price: number;
  valWithLev: number;
  valMargin: number;
  upnl: number;
  depthPct: number;
  reason: string;
  isHedged: boolean;
}

/** A summary on how much of the account is exposed to current positions (and any upnl) */
export interface PositionDepthState {
  asset: string;
  symbol: string;
  positionAmount: number;
  estimatedValue: number;
  estimatedValueWithLeverage: number;
  positionDepth: number;
  positionDepthUnrealised: number;
  balanceRemaining: number;
  unrealisedPnL: number;
  estimatedPnlPct: number;
}

/** A summary on how much of the account is exposed to current positions (and any upnl) */
export interface DepthSummary {
  rawDepthSum: number;
  estimatedValueWithLeverage: number;
  unrealisedPnL: number;
  crossBalance: number;
  depthWithoutPnL: number;
  depthWithPnL: number;
}
