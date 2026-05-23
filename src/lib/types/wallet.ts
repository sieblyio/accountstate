export interface BybitCoinData {
    coin: string;
    equity: string;
    usdValue: string;
    walletBalance: string;
    availableToWithdraw: string;
    availableToBorrow: string;
    borrowAmount: string;
    accruedInterest: string;
    totalOrderIM: string;
    totalPositionIM: string;
    totalPositionMM: string;
    unrealisedPnl: string;
    cumRealisedPnl: string;
    bonus: string;
    collateralSwitch: boolean;
    marginCollateral: boolean;
    locked: string;
    spotHedgingQty: string;
}

export interface BybitWalletData  {
    accountIMRate: string;
    accountMMRate: string;
    totalEquity: string;
    totalWalletBalance: string;
    totalMarginBalance: string;
    totalAvailableBalance: string;
    totalPerpUPL: string;
    totalInitialMargin: string;
    totalMaintenanceMargin: string;
    coin: BybitCoinData[];
    accountLTV: string;
    accountType: string;
}

export interface AbstractAssetBalance {
    // Common properties
    asset: string;           // Asset symbol (e.g., "BTC", "ETH")
    free: string;            // Available balance for trading
    locked: string;          // Balance locked in open orders
    
    // Optional properties that may be available in some exchanges
    borrowed?: string;       // Amount borrowed (margin trading)
    interest?: string;       // Interest on borrowed amount
    netAsset?: string;       // Net asset value (free + locked - borrowed)
    unrealizedPnl?: string;  // Unrealized profit/loss
    marginBalance?: string;  // Margin balance
    initialMargin?: string;  // Initial margin
    maintenanceMargin?: string; // Maintenance margin
    positionInitialMargin?: string; // Position initial margin
    openOrderInitialMargin?: string; // Open order initial margin
    walletBalance?: string;  // Total wallet balance
    unrealisedPnl?: string;  // Alternative spelling for unrealizedPnl
    cumRealisedPnl?: string; // Cumulative realized profit/loss
    availableToWithdraw?: string; // Available for withdrawal
    availableToBorrow?: string;   // Available for borrowing
    borrowAmount?: string;        // Current borrow amount
    accruedInterest?: string;     // Accrued interest
    totalOrderIM?: string;        // Total order initial margin
    totalPositionIM?: string;     // Total position initial margin
    totalPositionMM?: string;     // Total position maintenance margin
    bonus?: string;               // Bonus amount
    collateralSwitch?: boolean;   // Whether asset can be used as collateral
    marginCollateral?: boolean;   // Whether asset is used as margin collateral
    spotHedgingQty?: string;      // Spot hedging quantity
  }