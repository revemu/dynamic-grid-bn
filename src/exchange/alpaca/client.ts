/**
 * Alpaca US Equities Adapter (Paper & Live Trading)
 * Implements IExchangeClient for US Stocks and ETFs via Alpaca API v2.
 */

import {
  IExchangeClient,
  ExchangeSymbolInfo,
  ExchangeAccountBalances,
  ExchangeOpenOrder,
  ExchangeOrderResult,
  ExchangeTopOfBook,
  PlaceOrderParams,
  ExchangeTrade,
} from "../types.js";

export interface AlpacaClientOptions {
  apiKey?: string;
  apiSecret?: string;
  baseUrl?: string;
  dataUrl?: string;
}

export class AlpacaClient implements IExchangeClient {
  public readonly exchangeName = "alpaca";
  public readonly isDex = false;
  public readonly hasGasFees = false;
  public readonly nativeGasAsset = "USD";
  public readonly supportsOrderExpiry = false;

  private apiKey: string;
  private apiSecret: string;
  private baseUrl: string;
  private dataUrl: string;

  constructor(opts: AlpacaClientOptions = {}) {
    this.apiKey = opts.apiKey || process.env.ALPACA_API_KEY || "PKYAVG2YEWF3SWIPPJT3C42TVG";
    this.apiSecret = opts.apiSecret || process.env.ALPACA_API_SECRET || "2boZiaaqiLDfDEM9XSULbXq2iW69B9WcAEPu234MeuN2";
    this.baseUrl = opts.baseUrl || process.env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets";
    this.dataUrl = opts.dataUrl || process.env.ALPACA_DATA_URL || "https://data.alpaca.markets";
  }

  public hasCredentials(): boolean {
    return Boolean(this.apiKey && this.apiSecret);
  }

  public updateCredentials(apiKey: string, apiSecret: string, baseUrl?: string): void {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    if (baseUrl) this.baseUrl = baseUrl;
  }

  public getCredentials(): { apiKey: string; apiSecret: string } {
    return { apiKey: this.apiKey, apiSecret: this.apiSecret };
  }

  public async syncTime(): Promise<number> {
    return Date.now();
  }

  private getHeaders(): Record<string, string> {
    return {
      "APCA-API-KEY-ID": this.apiKey,
      "APCA-API-SECRET-KEY": this.apiSecret,
      "Content-Type": "application/json",
    };
  }

  public async getExchangeInfo(symbol: string): Promise<ExchangeSymbolInfo> {
    const cleanSym = symbol.toUpperCase().replace(/USD$/, "");
    try {
      const res = await fetch(`${this.baseUrl}/v2/assets/${cleanSym}`, {
        headers: this.getHeaders(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const asset = await res.json();
      return {
        symbol: cleanSym,
        status: asset.status === "active" ? "TRADING" : "HALTED",
        baseAsset: cleanSym,
        quoteAsset: "USD",
        baseAssetPrecision: 4,
        quotePrecision: 2,
        minQty: asset.fractionable ? 0.0001 : 1,
        maxQty: 1000000,
        stepSize: asset.fractionable ? 0.0001 : 1,
        qtyPrecision: asset.fractionable ? 4 : 0,
        minPrice: 0.01,
        maxPrice: 1000000,
        tickSize: 0.01,
        pricePrecision: 2,
        minNotional: 1.0,
      };
    } catch {
      return {
        symbol: cleanSym,
        status: "TRADING",
        baseAsset: cleanSym,
        quoteAsset: "USD",
        baseAssetPrecision: 4,
        quotePrecision: 2,
        minQty: 0.0001,
        maxQty: 1000000,
        stepSize: 0.0001,
        qtyPrecision: 4,
        minPrice: 0.01,
        maxPrice: 1000000,
        tickSize: 0.01,
        pricePrecision: 2,
        minNotional: 1.0,
      };
    }
  }

  public async getAccountBalances(symbol: string): Promise<ExchangeAccountBalances> {
    const cleanSym = symbol.toUpperCase().replace(/USD$/, "");

    // 1. Fetch cash & equity from Account
    const accRes = await fetch(`${this.baseUrl}/v2/account`, { headers: this.getHeaders() });
    if (!accRes.ok) throw new Error(`Failed to fetch Alpaca account: HTTP ${accRes.status}`);
    const acc = await accRes.json();
    const quoteCash = parseFloat(acc.cash) || 0;
    const quoteEquity = parseFloat(acc.equity) || 0;

    // 2. Fetch position for base asset
    let baseQty = 0;
    const allBalances: Record<string, { free: number; locked: number }> = {
      USD: { free: quoteCash, locked: Math.max(0, quoteEquity - quoteCash) },
    };

    try {
      const posRes = await fetch(`${this.baseUrl}/v2/positions/${cleanSym}`, { headers: this.getHeaders() });
      if (posRes.ok) {
        const pos = await posRes.json();
        baseQty = parseFloat(pos.qty) || 0;
        allBalances[cleanSym] = { free: baseQty, locked: 0 };
      }
    } catch {}

    return {
      baseAsset: cleanSym,
      quoteAsset: "USD",
      baseFree: baseQty,
      baseLocked: 0,
      baseTotal: baseQty,
      quoteFree: quoteCash,
      quoteLocked: Math.max(0, quoteEquity - quoteCash),
      quoteTotal: quoteEquity,
      allBalances,
    };
  }

  public async getOpenOrders(symbol?: string): Promise<ExchangeOpenOrder[]> {
    let url = `${this.baseUrl}/v2/orders?status=open&limit=100`;
    if (symbol) {
      const cleanSym = symbol.toUpperCase().replace(/USD$/, "");
      url += `&symbols=${cleanSym}`;
    }

    const res = await fetch(url, { headers: this.getHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch open orders: HTTP ${res.status}`);
    const orders = await res.json();

    return orders.map((o: any) => ({
      symbol: o.symbol,
      orderId: o.id,
      clientOrderId: o.client_order_id,
      price: parseFloat(o.limit_price) || 0,
      origQty: parseFloat(o.qty) || 0,
      executedQty: parseFloat(o.filled_qty) || 0,
      cummulativeQuoteQty: parseFloat(o.filled_avg_price || 0) * parseFloat(o.filled_qty || 0),
      status: o.status === "new" ? "NEW" : (o.status === "partially_filled" ? "PARTIALLY_FILLED" : o.status.toUpperCase()),
      timeInForce: o.time_in_force?.toUpperCase() || "DAY",
      type: o.type?.toUpperCase() || "LIMIT",
      side: o.side?.toUpperCase() === "BUY" ? "BUY" : "SELL",
      time: Math.floor(new Date(o.submitted_at).getTime() / 1000),
      updateTime: Math.floor(new Date(o.updated_at || o.submitted_at).getTime() / 1000),
      isWorking: true,
    }));
  }

  public async getOrder(symbol: string, orderId: string | number): Promise<ExchangeOpenOrder | ExchangeOrderResult> {
    const res = await fetch(`${this.baseUrl}/v2/orders/${orderId}`, { headers: this.getHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch order ${orderId}: HTTP ${res.status}`);
    const o = await res.json();

    return {
      symbol: o.symbol,
      orderId: o.id,
      clientOrderId: o.client_order_id,
      transactTime: Math.floor(new Date(o.submitted_at).getTime() / 1000),
      price: parseFloat(o.limit_price) || 0,
      origQty: parseFloat(o.qty) || 0,
      executedQty: parseFloat(o.filled_qty) || 0,
      cummulativeQuoteQty: parseFloat(o.filled_avg_price || 0) * parseFloat(o.filled_qty || 0),
      status: o.status === "filled" ? "FILLED" : (o.status === "canceled" ? "CANCELED" : o.status.toUpperCase()),
      timeInForce: o.time_in_force?.toUpperCase() || "DAY",
      type: o.type?.toUpperCase() || "LIMIT",
      side: o.side?.toUpperCase() === "BUY" ? "BUY" : "SELL",
    };
  }

  public async getTopOfBook(symbol: string): Promise<ExchangeTopOfBook | undefined> {
    const cleanSym = symbol.toUpperCase().replace(/USD$/, "");
    try {
      const res = await fetch(`${this.dataUrl}/v2/stocks/${cleanSym}/quotes/latest?feed=iex`, {
        headers: this.getHeaders(),
      });
      if (!res.ok) return undefined;
      const data = await res.json();
      const q = data.quote;
      if (!q) return undefined;

      const bestBid = q.bp ?? 0;
      const bestAsk = q.ap ?? 0;
      const mid = (bestBid > 0 && bestAsk > 0) ? (bestBid + bestAsk) / 2 : (bestBid || bestAsk);

      return {
        bestBid,
        bestAsk,
        mid,
        bidQty: q.bs ?? 100,
        askQty: q.as ?? 100,
        time: Math.floor(new Date(q.t).getTime() / 1000),
      };
    } catch {
      return undefined;
    }
  }

  public async placeOrder(params: PlaceOrderParams): Promise<ExchangeOrderResult> {
    const cleanSym = params.symbol.toUpperCase().replace(/USD$/, "");
    const side = params.side.toLowerCase();
    const type = params.type.toLowerCase().includes("limit") ? "limit" : "market";

    const body: Record<string, any> = {
      symbol: cleanSym,
      qty: String(params.qty),
      side,
      type,
      time_in_force: "day",
    };

    if (type === "limit" && params.price) {
      body.limit_price = String(params.price);
    }
    if (params.clientOrderId) {
      body.client_order_id = params.clientOrderId;
    }

    const res = await fetch(`${this.baseUrl}/v2/orders`, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errTxt = await res.text();
      throw new Error(`Alpaca placeOrder failed: HTTP ${res.status} - ${errTxt}`);
    }

    const o = await res.json();
    return {
      symbol: o.symbol,
      orderId: o.id,
      clientOrderId: o.client_order_id,
      transactTime: Math.floor(new Date(o.submitted_at).getTime() / 1000),
      price: parseFloat(o.limit_price) || params.price || 0,
      origQty: parseFloat(o.qty) || params.qty,
      executedQty: parseFloat(o.filled_qty) || 0,
      cummulativeQuoteQty: parseFloat(o.filled_avg_price || 0) * parseFloat(o.filled_qty || 0),
      status: o.status === "filled" ? "FILLED" : (o.status === "new" ? "NEW" : o.status.toUpperCase()),
      timeInForce: o.time_in_force?.toUpperCase() || "DAY",
      type: o.type?.toUpperCase() || "LIMIT",
      side: params.side,
    };
  }

  public async cancelOrder(_symbol: string, orderId: string | number): Promise<any> {
    const res = await fetch(`${this.baseUrl}/v2/orders/${orderId}`, {
      method: "DELETE",
      headers: this.getHeaders(),
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`Alpaca cancelOrder failed: HTTP ${res.status}`);
    }
    return { success: true };
  }

  public async cancelAllOpenOrders(symbol?: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}/v2/orders`, {
      method: "DELETE",
      headers: this.getHeaders(),
    });
    return { success: res.ok };
  }

  public async getMyTrades(symbol?: string, limit = 50): Promise<ExchangeTrade[]> {
    let url = `${this.baseUrl}/v2/account/activities/FILL?direction=desc&page_size=${limit}`;
    const res = await fetch(url, { headers: this.getHeaders() });
    if (!res.ok) return [];
    const activities = await res.json();

    return activities
      .filter((a: any) => (!symbol || a.symbol === symbol.toUpperCase().replace(/USD$/, "")))
      .map((a: any, idx: number) => ({
        symbol: a.symbol,
        id: a.id || idx,
        orderId: a.order_id,
        price: parseFloat(a.price) || 0,
        qty: parseFloat(a.qty) || 0,
        quoteQty: (parseFloat(a.price) || 0) * (parseFloat(a.qty) || 0),
        commission: 0,
        commissionAsset: "USD",
        time: Math.floor(new Date(a.transaction_time).getTime() / 1000),
        isBuyer: a.side === "buy",
      }));
  }
}
