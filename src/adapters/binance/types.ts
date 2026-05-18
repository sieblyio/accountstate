import type {
  MainClient,
  USDMClient,
  WsMessageFuturesUserDataAccountUpdateFormatted,
  WsMessageFuturesUserDataAlgoUpdateFormatted,
  WsMessageFuturesUserDataEventFormatted,
  WsMessageFuturesUserDataTradeLiteEventFormatted,
  WsMessageFuturesUserDataTradeUpdateEventFormatted,
  WsMessageSpotUserDataExecutionReportEventFormatted,
} from 'binance';

type AwaitedReturn<TFunction extends (...args: never[]) => unknown> = Awaited<
  ReturnType<TFunction>
>;

type ArrayItem<TValue> = TValue extends readonly (infer TItem)[]
  ? TItem
  : never;

export type BinanceUsdmPositionRow = ArrayItem<
  AwaitedReturn<USDMClient['getPositionsV3']>
>;

export type BinanceUsdmRegularOpenOrderRow = ArrayItem<
  AwaitedReturn<USDMClient['getAllOpenOrders']>
>;

export type BinanceUsdmOpenAlgoOrderRow = ArrayItem<
  AwaitedReturn<USDMClient['getOpenAlgoOrders']>
>;

export type BinanceUsdmAccountTradeRow = ArrayItem<
  AwaitedReturn<USDMClient['getAccountTrades']>
>;

export type BinanceUsdmAccountAssetRow = ArrayItem<
  AwaitedReturn<USDMClient['getAccountInformationV3']>['assets']
>;

export type BinanceSpotOpenOrderRow = ArrayItem<
  AwaitedReturn<MainClient['getOpenOrders']>
>;

export type BinanceUsdmPrivateEvent = WsMessageFuturesUserDataEventFormatted;

export type BinanceUsdmAccountUpdateEvent =
  WsMessageFuturesUserDataAccountUpdateFormatted;

export type BinanceUsdmOrderTradeUpdateEvent =
  WsMessageFuturesUserDataTradeUpdateEventFormatted;

export type BinanceUsdmTradeLiteEvent =
  WsMessageFuturesUserDataTradeLiteEventFormatted;

export type BinanceUsdmAlgoUpdateEvent =
  WsMessageFuturesUserDataAlgoUpdateFormatted;

export type BinanceSpotExecutionReportEvent =
  WsMessageSpotUserDataExecutionReportEventFormatted;
