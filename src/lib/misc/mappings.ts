import { AbstractAssetBalance, BybitCoinData, BybitWalletData } from "lib/types/wallet";

    /**
     * Maps BybitWalletData to AbstractWalletData
     * @param bybitWalletData The Bybit wallet data to map
     * @returns AbstractWalletData
     */
    export function mapBybitWalletToAbstract(bybitWalletData: BybitWalletData): AbstractWalletData {
        return {
            accountType: bybitWalletData.accountType,
            updateTime: Date.now(),
            balances: bybitWalletData.coin.map((coin: any) => mapBybitCoinToAbstractAsset(coin)),
            accountIMRate: bybitWalletData.accountIMRate,
            accountMMRate: bybitWalletData.accountMMRate,
            totalEquity: bybitWalletData.totalEquity,
            totalWalletBalance: bybitWalletData.totalWalletBalance,
            totalMarginBalance: bybitWalletData.totalMarginBalance,
            totalAvailableBalance: bybitWalletData.totalAvailableBalance,
            totalPerpUPL: bybitWalletData.totalPerpUPL,
            totalInitialMargin: bybitWalletData.totalInitialMargin,
            totalMaintenanceMargin: bybitWalletData.totalMaintenanceMargin,
            accountLTV: bybitWalletData.accountLTV
        };
    }

    /**
     * Maps BybitCoinData to AbstractAssetBalance
     * @param bybitCoinData The Bybit coin data to map
     * @returns AbstractAssetBalance
     */
    export function mapBybitCoinToAbstractAsset(bybitCoinData: BybitCoinData): AbstractAssetBalance {
        return {
            asset: bybitCoinData.coin,
            free: bybitCoinData.walletBalance,
            locked: bybitCoinData.locked || "0",
            walletBalance: bybitCoinData.walletBalance,
            unrealisedPnl: bybitCoinData.unrealisedPnl,
            cumRealisedPnl: bybitCoinData.cumRealisedPnl,
            availableToWithdraw: bybitCoinData.availableToWithdraw,
            availableToBorrow: bybitCoinData.availableToBorrow,
            borrowAmount: bybitCoinData.borrowAmount,
            accruedInterest: bybitCoinData.accruedInterest,
            totalOrderIM: bybitCoinData.totalOrderIM,
            totalPositionIM: bybitCoinData.totalPositionIM,
            totalPositionMM: bybitCoinData.totalPositionMM,
            bonus: bybitCoinData.bonus,
            collateralSwitch: bybitCoinData.collateralSwitch,
            marginCollateral: bybitCoinData.marginCollateral,
            spotHedgingQty: bybitCoinData.spotHedgingQty
        };
    }