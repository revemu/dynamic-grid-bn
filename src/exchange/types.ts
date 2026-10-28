/**
 * Universal Exchange Specification and Interface Layer
 * Allows dynamic-grid to trade across Binance, Bybit, OKX, Bitget, etc.
 */

export interface ExchangeSymbolInfo {
  symbol: string;
  status: string;
  baseAsset: string;
  quoteAsset: string;
  baseAssetPrecision: number;
  quotePrecision: number;
  minQty: number;
  maxQty: number;
  stepSize: number;
  qtyPrecision: number;
  minPrice: number;
  maxPrice: number;
  tickSize: number;
  pricePrecision: number;
  minNotional: number;
}

export interface ExchangeTopOfBook {
  bestBid: number;
  bestAsk: number;
  mid: number;
  bidQty: number;
  askQty: number;
  time: number;
}

export interface ExchangeOrderResult {
  symbol: string;
  orderId: number | string;
  clientOrderId: string;
  transactTime: number;
  price: number;
  origQty: number;
  executedQty: number;
  cummulativeQuoteQty: number;
  status: "NEW" | "PARTIALLY_FILLED" | "FILLED" | "CANCELED" | "REJECTED" | "EXPIRED";
  timeInForce: string;
  type: string;
  side: "BUY" | "SELL";
  txHash?: string;
  gasFee?: number;
  fills?: Array<{
    price: string;
    qty: string;
    commission: string;
    commissionAsset: string;
    tradeId: number | string;
  }>;
}

export interface ExchangeOpenOrder {
  symbol: string;
  orderId: number | string;
  clientOrderId: string;
  price: number;
  origQty: number;
  executedQty: number;
  cummulativeQuoteQty: number;
  status: string;
  timeInForce: string;
  type: string;
  side: "BUY" | "SELL";
  time: number;
  updateTime: number;
  isWorking?: boolean;
  txHash?: string;
}

export interface ExchangeAccountBalances {
  baseAsset: string;
  quoteAsset: string;
  baseFree: number;
  baseLocked: number;
  baseTotal: number;
  quoteFree: number;
  quoteLocked: number;
  quoteTotal: number;
  allBalances: Record<string, { free: number; locked: number }>;
}

export interface PlaceOrderParams {
  symbol: string;
  side: "BUY" | "SELL";
  type: "LIMIT" | "MARKET" | "IOC" | "LIMIT_MAKER";
  price?: number;
  qty: number;
  clientOrderId?: string;
  expireHours?: number;
}

export interface ExchangeTrade {
  symbol: string;
  id: number | string;
  orderId: number | string;
  price: number;
  qty: number;
  quoteQty: number;
  commission: number;
  commissionAsset: string;
  time: number;
  isBuyer: boolean;
  isMaker?: boolean;
}

export interface IExchangeClient {
  readonly exchangeName: string;
  readonly isDex: boolean;
  readonly hasGasFees: boolean;
  readonly nativeGasAsset?: string;
  readonly supportsOrderExpiry?: boolean;
  onGasSpent?: (fee: number, label: string, txHash?: string) => void;
  hasCredentials(): boolean;
  syncTime(): Promise<number>;
  getTimeOffset?(): number;
  destroy?(): void;
  getExchangeInfo(symbol: string): Promise<ExchangeSymbolInfo>;
  getAccountBalances(symbol: string): Promise<ExchangeAccountBalances>;
  getOpenOrders(symbol?: string): Promise<ExchangeOpenOrder[]>;
  getOrder(symbol: string, orderId: string | number): Promise<ExchangeOpenOrder | ExchangeOrderResult>;
  getTopOfBook(symbol: string, forceFresh?: boolean): Promise<ExchangeTopOfBook | undefined>;
  placeOrder(params: PlaceOrderParams): Promise<ExchangeOrderResult>;
  cancelOrder(symbol: string, orderId: string | number): Promise<any>;
  cancelAllOpenOrders(symbol: string): Promise<any>;
  updateCredentials(apiKey: string, apiSecret: string, baseUrl?: string): void;
  getCredentials?(): { apiKey: string; apiSecret: string };
  getTransactionFee?(txHash: string): Promise<number | undefined>;
  getRecentOrders?(symbol: string, limit?: number): Promise<ExchangeOpenOrder[]>;
  getMyTrades?(symbol: string, limit?: number): Promise<ExchangeTrade[]>;
  createUserDataStream?(): Promise<string>;
  keepAliveUserDataStream?(listenKey: string): Promise<void>;
  closeUserDataStream?(listenKey: string): Promise<void>;
}
