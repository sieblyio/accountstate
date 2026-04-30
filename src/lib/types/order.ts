// Add new type for orders
export interface EngineOrder {
  exchangeOrderId: string;
  customOrderId: string;
  symbol: string;
  orderSide: 'BUY' | 'SELL';
  positionSide: 'LONG' | 'SHORT' | 'NONE';
  orderType:
    | 'LIMIT'
    | 'MARKET'
    | 'STOP'
    | 'STOP_MARKET'
    | 'TAKE_PROFIT'
    | 'TAKE_PROFIT_MARKET'
    | 'TRAILING_STOP_MARKET';
  status:
    | 'NEW'
    | 'PARTIALLY_FILLED'
    | 'FILLED'
    | 'CANCELLED'
    | 'EXPIRED'
    | 'REJECTED'
    | 'PENDING_CANCEL';
  price: number;
  originalQuantity: number;
  executedQuantity: number;
  averagePrice: number;
  createdAtMs: number;
  updatedAtMs: number;
  isreduceOnly?: boolean;
}
