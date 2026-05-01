import {
  DefaultLogger,
  RestClientV5,
  WebsocketClient,
  WSAccountOrderV5,
  WSPositionV5,
} from 'bybit-api';
import 'dotenv/config';

// Legacy example for the lightweight AccountStateStore API.

import {
  AccountStateStore,
} from '../src/AccountStateStore.js';
import { EngineOrder } from '../src/lib/types/order.js';
import {
  EngineSimplePosition,
} from '../src/lib/types/position.js';

const key = process.env.BYBIT_API_KEY || '';
const secret = process.env.BYBIT_API_SECRET || '';

if (!key || !secret) {
  console.error('API key and secret are required. Set BYBIT_API_KEY and BYBIT_API_SECRET environment variables.');
  process.exit(1);
}

// Create REST client
const restClient = new RestClientV5({
  key: key,
  secret: secret,
});

// Create account state store
const state = new AccountStateStore();

// Configure logger
const logger = {
  ...DefaultLogger,
  silly: (msg:any, context: any) => {
    // Uncomment to see more detailed logs
    // console.log(JSON.stringify({ msg, context }));
  },
};

// Create WebSocket client
const wsClient = new WebsocketClient(
  {
    key: key,
    secret: secret,
  },
  logger
);



/**
 * Syncs the account state by fetching positions and orders from REST API
 */
async function syncPositionsFromREST() {
  try {
    console.log(new Date(), 'Syncing positions and orders from REST API...');
    
    // Clear existing positions and orders from state
    state.getAllPositions().forEach(pos => {
      state.deleteActivePosition(pos.symbol, pos.positionSide);
    });
    state.clearAllOrders();
    
    // Fetch wallet balance
    const walletBalance = await restClient.getWalletBalance({
      accountType: 'UNIFIED',
    });
    
    if (walletBalance && walletBalance.result.list.length > 0) {
      const usdtBalance = walletBalance.result.list[0].coin.find(b => b.coin === 'USDT');
      if (usdtBalance) {
        state.setWalletBalance(Number(usdtBalance.walletBalance));
        console.log(new Date(), `Updated wallet balance: ${usdtBalance.walletBalance} USDT`);
      }
    }
    
    // Fetch all positions
    const positions = await restClient.getPositionInfo({
      category: 'linear',
      settleCoin: 'USDT',
    });

    console.log("Positions:", positions);
    
     // Filter active positions (non-zero position amount)
    const activePositions = positions.result.list.filter(pos => Number(pos.size) !== 0); 
    
    // Update state with active positions
    activePositions.forEach(pos => {
      const enginePos = mapBybitRestPositionToEnginePosition(pos);
      state.setActivePosition(pos.symbol, enginePos.positionSide, enginePos);
      console.log(new Date(), `Position updated for ${pos.symbol} ${enginePos.positionSide}: ${pos.size} @ ${pos.avgPrice} (UPNL: ${pos.unrealisedPnl})`);
    }); 

    // Fetch all open orders
    const openOrders = await restClient.getActiveOrders({
      category: 'linear',
      settleCoin: 'USDT',
    });
    
    // Update state with open orders
    openOrders.result.list.forEach(order => {
      const engineOrder = mapBybitRestOrderToEngineOrder(order);
      state.upsertActiveOrder(engineOrder);
      console.log(new Date(), `Order synced: ${engineOrder.symbol} ${engineOrder.orderSide} ${engineOrder.orderType} ${engineOrder.status}`);
    });
    
    // Summary of active positions and orders
    const activePositionCount = state.getTotalActivePositions();
    const activeOrders = state.getActiveOrders();
    console.log(new Date(), `Sync complete. Positions: ${activePositionCount.total}, Active Orders: ${activeOrders.length}`);
    
    return true;
  } catch (error) {
    console.error(new Date(), 'Error syncing from REST API:', error);
    return false;
  }
}

/**
 * Main function to start the application
 */
async function main() {
  console.log(new Date(), 'Starting Bybit Futures position tracking...');
  
  // Initial sync from REST API
  await syncPositionsFromREST();
  
  // Setup WebSocket event handlers
  wsClient.on('open', (data) => {
    console.log(new Date(), `WebSocket connection opened: ${data.wsKey}`);
  });
  
  wsClient.on('update', (data) => {
    //console.log(new Date(), 'Update:', data.topic);
    
    // Handle position updates
    if (data.topic?.startsWith('position')) {
      handlePositionUpdate(data);
      return;
    }
    
    // Handle order updates
    if (data.topic?.startsWith('order')) {
      handleOrderUpdate(data);
      return;
    }
    
    // Handle wallet updates
    if (data.topic?.startsWith('wallet')) {
      handleWalletUpdate(data);
      return;
    }
    
    console.log(new Date(), 'Other update:', data);
  });
  
  wsClient.on('reconnected', async (data) => {
    console.log(new Date(), `WebSocket reconnected: ${data?.wsKey}`);
    
    // After reconnection, re-sync state from REST API to ensure it's up to date
    if (data?.wsKey && data?.wsKey.includes('private')) {
      console.log(new Date(), 'Re-syncing position state after reconnection...');
      await syncPositionsFromREST();
    }
  });
  
  wsClient.on('exception', (error) => {
    console.error(new Date(), 'WebSocket error:', error);
  });
  
  // Subscribe to private topics for linear perpetual futures
  console.log(new Date(), 'Subscribing to private topics...');
  wsClient.subscribeV5(['position', 'order', 'wallet'], 'linear');
  
  // Setup periodic sync (as a backup to ensure state consistency)
  const syncIntervalMinutes = 10;
  console.log(new Date(), `Setting up periodic sync every ${syncIntervalMinutes} minutes`);
  setInterval(syncPositionsFromREST, syncIntervalMinutes * 60 * 1000);
}

/**
 * Handle position update events from WebSocket
 */
function handlePositionUpdate(data: BybitWebSocketPosition) {
  const { data: positionData } = data;
  
  if (!positionData || !Array.isArray(positionData) || positionData.length === 0) return;
  
  const position = positionData[0];
  
  // Handle position close
  if (!position.side || Number(position.size) === 0) {
    const positionSide = position.side === 'Buy' ? 'LONG' : 'SHORT';
    state.deleteActivePosition(position.symbol, positionSide);
    //console.log(new Date(), `Position closed for ${position.symbol} ${positionSide}`);
    return;
  }
  
  // Handle position update
  const enginePos = mapBybitWsPositionToEnginePosition(position);
  state.setActivePosition(position.symbol, enginePos.positionSide, enginePos);
  console.log(new Date(), `Position updated from WS for ${position.symbol} ${enginePos.positionSide}: ${position.size} @ ${position.entryPrice} (UPNL: ${position.unrealisedPnl})`);
}

/**
 * Handle order update events from WebSocket
 */
function handleOrderUpdate(data: BybitWebSocketOrder) {
  const { data: orderData } = data;
  
  if (!orderData || !Array.isArray(orderData) || orderData.length === 0) return;
  
  const order = orderData[0];
  
  console.log(
    new Date(),
    `Order update: ${order.symbol} ${order.side} ${order.orderType} ${order.orderStatus} - Qty: ${order.qty}, Price: ${order.price}`
  );
  
  // Update order in state
  const engineOrder = mapBybitWsOrderToEngineOrder(order);
  state.upsertActiveOrder(engineOrder);
}

/**
 * Handle wallet update events from WebSocket
 */
function handleWalletUpdate(data: BybitWebSocketWallet) {
  const { data: walletData } = data;
  
  if (!walletData || !Array.isArray(walletData) || walletData.length === 0) return;
  
  const wallet = walletData[0];
  
  // Update total wallet balance
  if (wallet.totalWalletBalance) {
    state.setWalletBalance(Number(wallet.totalWalletBalance));
    console.log(new Date(), `Updated total wallet balance from WS: ${wallet.totalWalletBalance} USD`);
  }
  
  // Log additional wallet information
  console.log(new Date(), `Wallet Update:
    Total Equity: ${wallet.totalEquity} USD
    Total Margin Balance: ${wallet.totalMarginBalance} USD
    Total Available Balance: ${wallet.totalAvailableBalance} USD
    Total Perp UPL: ${wallet.totalPerpUPL} USD
    Account Type: ${wallet.accountType}
  `);
  
  // Log coin-specific information if available
  if (wallet.coin && Array.isArray(wallet.coin)) {
    wallet.coin.forEach((coin: BybitCoinInfo) => {
      if (coin.coin === 'USDT') {
        console.log(new Date(), `USDT Balance:
          Wallet Balance: ${coin.walletBalance}
          Available to Withdraw: ${coin.availableToWithdraw}
          Unrealized PNL: ${coin.unrealisedPnl}
          Cumulative Realized PNL: ${coin.cumRealisedPnl}
        `);
      }
    });
  }
}

/**
 * Maps Bybit REST order to internal EngineOrder format
 */
function mapBybitRestOrderToEngineOrder(order: any): EngineOrder {
  return {
    exchangeOrderId: order.orderId,
    customOrderId: order.orderLinkId,
    symbol: order.symbol,
    orderSide: order.side === 'Buy' ? 'BUY' : 'SELL',
    orderType: order.orderType === 'Market' ? 'MARKET' : 'LIMIT',
    positionSide: order.side === 'Buy' ? 'LONG' : 'SHORT',
    status: mapBybitOrderStatusToEngineStatus(order.orderStatus),
    price: Number(order.price),
    originalQuantity: Number(order.qty),
    executedQuantity: Number(order.cumExecQty),
    averagePrice: Number(order.avgPrice),
    createdAtMs: Number(order.createdTime),
    updatedAtMs: Number(order.updatedTime),
    isreduceOnly: order.reduceOnly,
  };
}

/**
 * Maps Bybit order status to Engine order status
 */
function mapBybitOrderStatusToEngineStatus(bybitStatus: string): EngineOrder['status'] {
  switch (bybitStatus) {
    case 'New':
      return 'NEW';
    case 'PartiallyFilled':
      return 'PARTIALLY_FILLED';
    case 'Untriggered':
      return 'NEW'; // Untriggered orders are treated as NEW in our system
    case 'Rejected':
      return 'REJECTED';
    case 'PartiallyFilledCanceled':
      return 'CANCELLED'; // We don't have a specific status for partially filled canceled
    case 'Filled':
      return 'FILLED';
    case 'Cancelled':
      return 'CANCELLED';
    case 'Triggered':
      return 'NEW'; // Triggered orders become NEW orders
    case 'Deactivated':
      return 'CANCELLED';
    default:
      return 'REJECTED'; // Default to REJECTED for unknown statuses
  }
}

/**
 * Maps Bybit WebSocket order to internal EngineOrder format
 */
function mapBybitWsOrderToEngineOrder(order: WSAccountOrderV5): EngineOrder {
  return {
    exchangeOrderId: order.orderId,
    customOrderId: order.orderLinkId,
    symbol: order.symbol,
    orderSide: order.side === 'Buy' ? 'BUY' : 'SELL',
    orderType: order.orderType === 'Market' ? 'MARKET' : 'LIMIT',
    positionSide: order.side === 'Buy' ? 'LONG' : 'SHORT',
    status: mapBybitOrderStatusToEngineStatus(order.orderStatus),
    price: Number(order.price),
    originalQuantity: Number(order.qty),
    executedQuantity: Number(order.cumExecQty),
    averagePrice: Number(order.avgPrice),
    createdAtMs: Number(order.createdTime),
    updatedAtMs: Number(order.updatedTime),
    isreduceOnly: order.reduceOnly,
  };
}

/**
 * Maps Bybit REST position to internal EngineSimplePosition format
 */
function mapBybitRestPositionToEnginePosition(pos: any): EngineSimplePosition {
  const positionSide = pos.side === 'Buy' ? 'LONG' : 'SHORT';
  
  return {
    symbol: pos.symbol,
    timestampMs: Date.now(),
    positionSide: positionSide,
    orderPositionSide: positionSide,
    positionPrice: Number(pos.entryPrice),
    assetQty: Number(pos.size),
    value: Number(pos.size) * Number(pos.entryPrice),
    valueUpnl: Number(pos.unrealisedPnl),
    liquidationPrice: Number(pos.liqPrice || 0),
    stopLossPrice: undefined,
    takeProfitPrice: undefined,
    marginValue: (Number(pos.size) * Number(pos.entryPrice)),
  };
}

/**
 * Maps Bybit WebSocket position to internal EngineSimplePosition format
 */
function mapBybitWsPositionToEnginePosition(pos: WSPositionV5): EngineSimplePosition {
  const positionSide = pos.side === 'Buy' ? 'LONG' : 'SHORT';
  
  return {
    symbol: pos.symbol,
    timestampMs: Date.now(),
    positionSide: positionSide,
    orderPositionSide: positionSide,
    positionPrice: Number(pos.entryPrice),
    assetQty: Number(pos.size),
    value: Number(pos.positionValue),
    valueUpnl: Number(pos.unrealisedPnl),
    liquidationPrice: Number(pos.liqPrice || 0),
    stopLossPrice: Number(pos.stopLoss || 0),
    takeProfitPrice: Number(pos.takeProfit || 0),
    marginValue: Number(pos.positionBalance),
  };
}

/**
 * Print account state summary
 */
function printAccountSummary() {
  const summary = state.getSessionSummary(0);
  const activeOrders = state.getOrdersSortedByPrice();
  
  console.log('\n=== Account Summary ===');
  console.log(`Total Wallet Balance: ${state.getWalletBalance()} USD`);
  console.log(`Total Positions: ${state.getTotalActivePositions().total}`);
  console.log(`Unrealized PNL: ${summary.activePositionUpnlSum.toFixed(2)} USD`);
  console.log(`Active Orders: ${activeOrders.length}`);
  
  if (summary.activePositions.length > 0) {
    console.log('\nActive Positions:');
    summary.activePositions.forEach(pos => {
      console.log(`${pos.symbol} ${pos.positionSide}: ${pos.assetQty} @ ${pos.positionPrice} (UPNL: ${pos.valueUpnl.toFixed(2)})`);
    });
  }
  
  if (activeOrders.length > 0) {
    console.log('\nActive Orders:');
    activeOrders.forEach(order => {
      console.log(`${order.symbol} ${order.orderSide} ${order.orderType} ${order.status} - Qty: ${order.originalQuantity-order.executedQuantity}, Price: ${order.price}`);
    });
  }
  
  console.log('======================\n');
}

// Command to print summary when requested
process.on('SIGINT', () => {
  printAccountSummary();
  process.exit();
});

// Start the application
main().catch(error => {
  console.error('Application error:', error);
  process.exit(1);
}); 


// Bybit websocket types
interface BybitWebSocketBase {
  id: string;
  topic: string;
  creationTime: number;
}

interface BybitCoinInfo {
  coin: string;
  equity: string;
  usdValue: string;
  walletBalance: string;
  free?: string;
  locked?: string;
  spotHedgingQty?: string;
  borrowAmount: string;
  availableToBorrow: string;
  availableToWithdraw: string;
  accruedInterest: string;
  totalOrderIM: string;
  totalPositionIM: string;
  totalPositionMM: string;
  unrealisedPnl: string;
  cumRealisedPnl: string;
  bonus?: string;
  collateralSwitch?: boolean;
  marginCollateral?: boolean;
}

interface BybitWalletData {
  accountType: string;
  accountLTV: string;
  accountIMRate: string;
  accountMMRate: string;
  totalEquity: string;
  totalWalletBalance: string;
  totalMarginBalance: string;
  totalAvailableBalance: string;
  totalPerpUPL: string;
  totalInitialMargin: string;
  totalMaintenanceMargin: string;
  coin: BybitCoinInfo[];
}


interface BybitWebSocketPosition extends BybitWebSocketBase {
  data: WSPositionV5[];
}

interface BybitWebSocketOrder extends BybitWebSocketBase {
  data: WSAccountOrderV5[];
}

interface BybitWebSocketWallet extends BybitWebSocketBase {
  data: BybitWalletData[];
}
