import { IncomingPriceEvent } from './lib/types/events.js';
import { EngineOrder } from './lib/types/order.js';
import {
  EnginePositionSide,
  EngineSimplePosition,
} from './lib/types/position.js';
import { AbstractAssetBalance } from './lib/types/wallet.js';
import { getUnrealisedPNL } from './util/math.js';



/**
 * This abstraction layer is a state cache for account state (so we know what changed when an event comes in).
 *
 * Since it's mostly a cache of information also available on the exchange (via a REST API call), none of it needs to be persisted.
 *
 * EXCEPT the following, which cannot be derived from the exchange:
 * - accountPositionMetadata - an object representing information about a position, per symbol
 *
 * This "accountPositionMetadata" can be any additional info to store about this symbol's position(s). A good place to store custom info.
 */
export class AccountStateStore<
  TEnginePositionMetadata extends object = Record<string, unknown>,
> {
  private isPendingPersistPositionMetadata = false;

  // symbol:buyLeverageValue,sellLeverageValue
  private accountLeverageState: Record<string, { buy: number, sell: number }> = {};

  // per symbol, per side, cache a copy of the position state
  private accountPositionState: Record<
    string,
    Record<EnginePositionSide, EngineSimplePosition | undefined>
  > = {};

  // per symbol, store some state related to this position (e.g. which leader caused this pos to open)
  // if a leader opens any position on any side on a symbol,
  // only that leader can do anything on that symbol until the position is closed again
  private accountPositionMetadata: Record<
    string,
    TEnginePositionMetadata | undefined
  > = {};

  // Store all active orders, keyed by "endineOrder.exchangeOrderId"
  private accountOrders: Map<string, EngineOrder> = new Map();

  // Store asset balances by asset symbol
  private accountAssetBalances: Map<string, AbstractAssetBalance> = new Map();

  private accountOtherState = {
    balance: 0,
    previousBalance: 0,
    hedgedPositions: 0,
  };

  dumpLogState(): string | void {
    try {
      // Using string concatenation instead of console.log
      const stateString = JSON.stringify(
        {
          accountLeverageState: this.accountLeverageState,
          acconutPositionState: this.accountPositionState,
          accountOtherState: this.accountOtherState,
        },
        null,
        2,
      );
      // Handle in a way that doesn't require console
      return stateString;
    } catch (error) {
      // Silently handle errors
    }
  }

  /**
   * Pass a price update event to recalculate price-sensitive position state (such as UPNL)
   */
  public processPriceEvent(event: IncomingPriceEvent): void {
    const { symbol, price } = event;
    const longPos = this.getActivePosition(symbol, 'LONG');
    if (longPos) {
      longPos.valueUpnl = getUnrealisedPNL(
        price,
        longPos.assetQty,
        longPos.positionPrice,
      );
    }

    const shortPos = this.getActivePosition(symbol, 'SHORT');
    if (shortPos) {
      shortPos.valueUpnl = getUnrealisedPNL(
        price,
        shortPos.assetQty,
        shortPos.positionPrice,
      );
    }
  }

  /**
   * Return some loggable summary state. Takes the last seen price event into account, when looking at position upnl.
   *
   * Don't rely on this too much, it's a rushed implementation
   */
  public getSessionSummary(startingBalance: number) {
    const balanceNow = this.getWalletBalance();

    const positions = this.getAllPositions().map((pos) => {
      const leverageData = this.getSymbolLeverage(pos.symbol);
      return {
        ...pos,
        leverage: pos.positionSide === 'LONG' ? leverageData?.buy : leverageData?.sell,
      };
    });

    let activePositionUpnlSum = 0;
    let quoteMarginLockedSum = 0;
    for (const position of positions) {
      activePositionUpnlSum += position.valueUpnl;
      quoteMarginLockedSum += position.marginValue;
    }

    const realisedPnl = balanceNow - startingBalance;

    const summary = {
      activePositions: positions,
      activePositionUpnlSum,
      account: {
        quoteBalanceState: {
          startedWith: startingBalance,
          now: balanceNow,
          quoteMarginLockedSum: quoteMarginLockedSum,
          nowInclLocked: startingBalance - quoteMarginLockedSum,
          nowIfEverythingClosedAtMarket:
            startingBalance + activePositionUpnlSum,
        },
        pnlState: {
          realisedPnl,
          unrealisedPnl: activePositionUpnlSum,
        },
      },
    };

    return summary;
  }

  /**
   * Utility method to check if metadata was recently changed (and hasn't been persisted yet)
   */
  isPendingPersist() {
    return this.isPendingPersistPositionMetadata;
  }

  /**
   * Internally mark that metadata recently changed (and should be persisted)
   *
   * After you've persisted it somewhere, you should set this back to "false".
   */
  setIsPendingPersist(value: boolean): void {
    this.isPendingPersistPositionMetadata = value;
  }

  setWalletBalance(bal: number): void {
    this.accountOtherState.balance = bal;
  }

  getWalletBalance(): number {
    return this.accountOtherState.balance;
  }

  /**
   * Overwrites "previous balance" with current balance. Can be used to track balance changes before/after events
   */
  storePreviousBalance(): void {
    this.accountOtherState.previousBalance = this.getWalletBalance();
  }

  getPreviousBalance(): number {
    return this.accountOtherState.previousBalance;
  }

  getAllPositions(): EngineSimplePosition[] {
    const positions: EngineSimplePosition[] = [];

    for (const symbol in this.accountPositionState) {
      for (const posSide in this.accountPositionState[symbol]) {
        const position =
          this.accountPositionState[symbol][posSide as EnginePositionSide];

        if (position?.assetQty) {
          positions.push(position);
        }
      }
    }

    return positions;
  }

  /**
   * Recalculate and return counters for the total number of positions opened (hedged positions count as 2)
   * @returns
   */
  getTotalActivePositions(): { total: number; totalHedged: number } {
    let total = 0;
    let totalHedged = 0;

    for (const symbol in this.accountPositionState) {
      let positionsForSymbol = 0;
      for (const posSide in this.accountPositionState[symbol]) {
        const position =
          this.accountPositionState[symbol][posSide as EnginePositionSide];
        if (position?.assetQty) {
          total++;
          positionsForSymbol++;
        }

        if (positionsForSymbol === 2) {
          console.log(`${symbol} has a long and short position!`);
          totalHedged++;
        }
      }
    }

    this.accountOtherState.hedgedPositions = totalHedged;
    return {
      total,
      totalHedged,
    };
  }

  /**
   * @returns a cached count on the total number of positions that have both a long and a short open
   */
  getTotalHedgedPositions(): number {
    return this.accountOtherState.hedgedPositions;
  }

  isSymbolSideInPosition(
    symbol: string,
    positionSide: EnginePositionSide,
  ): boolean {
    const symbolStore = this.getActivePosition(symbol, positionSide);
    return !!symbolStore?.assetQty && symbolStore?.assetQty !== 0;
  }

  /** Returns true if any side has a position for this symbol */
  isSymbolInAnyPosition(symbol: string): boolean {
    return (
      this.isSymbolSideInPosition(symbol, 'LONG') ||
      this.isSymbolSideInPosition(symbol, 'SHORT')
    );
  }

  isDualPositionMode() {
    return true;
  }
  setSymbolLeverage(symbol: string, leverage: number): void {
    this.accountLeverageState[symbol] = { buy: leverage, sell: leverage };
  }

  setSymbolSideLeverage(symbol: string, side: 'buy' | 'sell', leverage: number): void {
    if (!this.accountLeverageState[symbol]) {
      this.accountLeverageState[symbol] = { buy: leverage, sell: leverage };
    } else {
      this.accountLeverageState[symbol][side] = leverage;
    }
  }

  getSymbolLeverage(symbol: string): { buy: number, sell: number } | undefined {
    return this.accountLeverageState[symbol];
  }

  getSymbolSideLeverage(symbol: string, side: 'buy' | 'sell'): number | undefined {
    return this.accountLeverageState[symbol]?.[side];
  }

  getSymbolLeverageCache() {
    return this.accountLeverageState;
  }

  private assertInitialStateActivePosition(symbol: string): void {
    if (!this.accountPositionState[symbol]) {
      this.accountPositionState[symbol] = {
        LONG: undefined,
        SHORT: undefined,
        NONE: undefined,
      };
    }
  }
  getActivePosition(
    symbol: string,
    side: EnginePositionSide,
  ): EngineSimplePosition | undefined {
    this.assertInitialStateActivePosition(symbol);
    return this.accountPositionState[symbol][side];
  }

  setActivePosition(
    symbol: string,
    side: EnginePositionSide,
    newState: EngineSimplePosition,
  ): void {
    this.assertInitialStateActivePosition(symbol);
    this.accountPositionState[symbol][side] = newState;
  }

  deleteActivePosition(symbol: string, side: EnginePositionSide): void {
    this.assertInitialStateActivePosition(symbol);
    delete this.accountPositionState[symbol][side];
  }

  /** Overwrite the full metadata store. This should be keyed by symbol! */
  setAllSymbolMetadata(data: typeof this.accountPositionMetadata): void {
    this.accountPositionMetadata = data;
  }

  /** Return position metadata for all symbols */
  getAllSymbolMetadata(): typeof this.accountPositionMetadata {
    return this.accountPositionMetadata;
  }

  /** Return a list of symbols with any metadata stored */
  getSymbolsWithMetadata(): string[] {
    return Object.keys(this.accountPositionMetadata);
  }

  /** Return metadata for one symbol */
  getSymbolMetadata(symbol: string): TEnginePositionMetadata | undefined {
    return this.accountPositionMetadata[symbol];
  }

  /** Overwrite the full state for a symbol's metadata */
  setSymbolMetadata(
    symbol: string,
    data: TEnginePositionMetadata,
  ): TEnginePositionMetadata {
    this.accountPositionMetadata[symbol] = data;
    this.isPendingPersistPositionMetadata = true;
    return data;
  }

  deletePositionMetadata(symbol: string): void {
    delete this.accountPositionMetadata[symbol];
    this.isPendingPersistPositionMetadata = true;
  }

  /**
   * Set one value in this symbol's metadata state.
   *
   * Warning: make sure to set initial metadata (via setSymbolMetadata()) before trying to use this, or it will throw an error!
   */
  setSymbolMetadataValue<TMetadataKey extends keyof TEnginePositionMetadata>(
    symbol: string,
    key: TMetadataKey,
    newValue: TEnginePositionMetadata[TMetadataKey],
  ): TEnginePositionMetadata {
    const symbolMetadata = this.getSymbolMetadata(symbol);

    if (!symbolMetadata) {
      throw new Error(
        `Symbol metadata not initilised. Prepare full metadata state via setSymbolMetadata() before using the setSymbolMetadataValue() method!`,
      );
    }

    symbolMetadata[key] = newValue;
    this.isPendingPersistPositionMetadata = true;

    return symbolMetadata;
  }

  /**
   * Get all orders
   */
  getOrders(): EngineOrder[] {
    return Array.from(this.accountOrders.values());
  }

  /**
   * Get all active orders
   */
  getActiveOrders(): EngineOrder[] {
    return this.getOrders().filter(order => order.status === 'NEW' || order.status === 'PARTIALLY_FILLED');
  }

  /**
   * Get orders for a specific symbol
   */
  getOrdersForSymbol(symbol: string): EngineOrder[] {
    return this.getOrders().filter(order => order.symbol === symbol);
  }

  /**
   * Get orders for a specific symbol and side
   */
  getOrdersForSymbolSide(symbol: string, side: 'BUY' | 'SELL'): EngineOrder[] {
    return this.getOrders().filter(order => order.symbol === symbol && order.orderSide === side);
  }

  /**
   * Get a specific order by ID
   */
  getOrder(orderId: string): EngineOrder | undefined {
    return this.accountOrders.get(orderId);
  }

  /**
   * Upsert an active order into the state store
   * Main entry point for order state updates
   * Only keeps active and partially filled orders in state
   * Deletes orders if they are not longer active(cancelled, filled, expired, etc)
   */
  upsertActiveOrder(order: EngineOrder): void {
    // Only store active or partially filled orders
    if (order.status === 'NEW' || order.status === 'PARTIALLY_FILLED') {
      this.accountOrders.set(order.exchangeOrderId, order);
    } else {
      // Remove order if it's no longer active
      this.deleteOrder(order.exchangeOrderId);
    }
  }

  /**
   * Remove an order from tracking 
   */
  deleteOrder(orderId: string): void {
    this.accountOrders.delete(orderId);
  }

  /**
   * Clear all orders
   */
  clearAllOrders(): void {
    this.accountOrders.clear();
  }

  /**
   * Get orders by status
   */
  getOrdersByStatus(status: EngineOrder['status']): EngineOrder[] {
    return this.getOrders().filter(order => order.status === status);
  }

  /**
   * Get orders by type
   */
  getOrdersByType(orderType: EngineOrder['orderType']): EngineOrder[] {
    return this.getOrders().filter(order => order.orderType === orderType);
  }

  /**
   * Get all orders sorted by orderId
   * @param ascending - true for ascending order, false for descending
   */
  getOrdersSortedById(ascending: boolean = true): EngineOrder[] {
    return this.getOrders().sort((a, b) => {
      const comparison = a.exchangeOrderId.localeCompare(b.exchangeOrderId);
      return ascending ? comparison : -comparison;
    });
  }

  /**
   * Get all orders sorted by symbol
   * @param ascending - true for ascending order, false for descending
   */
  getOrdersSortedBySymbol(ascending: boolean = true): EngineOrder[] {
    return this.getOrders().sort((a, b) => {
      const comparison = a.symbol.localeCompare(b.symbol);
      return ascending ? comparison : -comparison;
    });
  }

  /**
   * Get all orders sorted by price
   * @param ascending - true for ascending order, false for descending
   */
  getOrdersSortedByPrice(ascending: boolean = true): EngineOrder[] {
    return this.getOrders().sort((a, b) => {
      const comparison = a.price - b.price;
      return ascending ? comparison : -comparison;
    });
  }

  /**
   * Get orders for a specific symbol sorted by price
   * @param symbol - The symbol to filter orders for
   * @param ascending - true for ascending order, false for descending
   */
  getOrdersForSymbolSortedByPrice(symbol: string, ascending: boolean = true): EngineOrder[] {
    return this.getOrdersForSymbol(symbol).sort((a, b) => {
      const comparison = a.price - b.price;
      return ascending ? comparison : -comparison;
    });
  }

  /**
   * Get orders for a specific symbol and side sorted by price
   * @param symbol - The symbol to filter orders for
   * @param side - The side to filter orders for (BUY/SELL)
   * @param ascending - true for ascending order, false for descending
   */
  getOrdersForSymbolSideSortedByPrice(
    symbol: string, 
    side: 'BUY' | 'SELL',
    ascending: boolean = true
  ): EngineOrder[] {
    return this.getOrdersForSymbolSide(symbol, side).sort((a, b) => {
      const comparison = a.price - b.price;
      return ascending ? comparison : -comparison;
    });
  }

  /**
   * Get orders sorted by timestamp
   * @param ascending - true for ascending order (oldest first), false for descending (newest first)
   */
  getOrdersSortedByTimestamp(ascending: boolean = true): EngineOrder[] {
    return this.getOrders().sort((a, b) => {
      const comparison = a.createdAtMs - b.createdAtMs;
      return ascending ? comparison : -comparison;
    });
  }

  /**
   * Get all stored asset balances
   */
  getAllAssetBalances(): AbstractAssetBalance[] {
    return Array.from(this.accountAssetBalances.values());
  }

  /**
   * Get balance for a specific asset
   */
  getAssetBalance(asset: string): AbstractAssetBalance | undefined {
    return this.accountAssetBalances.get(asset);
  }

  /**
   * Update or add an asset balance
   */
  upsertAssetBalance(assetBalance: AbstractAssetBalance): void {
    this.accountAssetBalances.set(assetBalance.asset, assetBalance);
  }

  /**
   * Update or add multiple asset balances at once
   */
  upsertAssetBalances(assetBalances: AbstractAssetBalance[]): void {
    for (const balance of assetBalances) {
      this.upsertAssetBalance(balance);
    }
  }

  /**
   * Remove an asset balance
   */
  deleteAssetBalance(asset: string): boolean {
    return this.accountAssetBalances.delete(asset);
  }

  /**
   * Clear all asset balances
   */
  clearAssetBalances(): void {
    this.accountAssetBalances.clear();
  }

  /**
   * Get total free balance value across all assets
   * This assumes the 'free' property is already in the same denomination
   */
  getTotalFreeBalance(): number {
    let total = 0;
    for (const balance of this.accountAssetBalances.values()) {
      total += parseFloat(balance.free) || 0;
    }
    return total;
  }

  /**
   * Get asset balances filtered by a predicate
   */
  filterAssetBalances(predicate: (balance: AbstractAssetBalance) => boolean): AbstractAssetBalance[] {
    return this.getAllAssetBalances().filter(predicate);
  }

  /**
   * Get a list of all asset symbols
   */
  getAssetSymbols(): string[] {
    return Array.from(this.accountAssetBalances.keys());
  }
}
