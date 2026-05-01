import type {
  AccountOrderV5,
  ExecutionV5,
  PositionV5,
  WalletBalanceV5,
  WSAccountOrderEventV5,
  WSAccountOrderV5,
  WSExecutionEventV5,
  WSExecutionV5,
  WSPositionEventV5,
  WSPositionV5,
  WSWalletEventV5,
  WSWalletV5,
} from 'bybit-api';

export type BybitV5LinearPositionRow = PositionV5;
export type BybitV5LinearOrderRow = AccountOrderV5;
export type BybitV5LinearExecutionRow = ExecutionV5;
export type BybitV5WalletBalanceRow = WalletBalanceV5;

export type BybitV5WsPositionRow = WSPositionV5;
export type BybitV5WsOrderRow = WSAccountOrderV5;
export type BybitV5WsExecutionRow = WSExecutionV5;
export type BybitV5WsWalletRow = WSWalletV5;

export type BybitV5PrivateEvent =
  | WSPositionEventV5
  | WSAccountOrderEventV5
  | WSExecutionEventV5
  | WSWalletEventV5;
