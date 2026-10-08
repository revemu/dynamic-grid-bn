/**
 * Native Binance Spot Trading Client
 * Provides signed REST endpoints for account balances, order placement,
 * order cancellations, top-of-book market data, and exchange symbol specifications.
 */

import crypto from "node:crypto";

export interface SymbolFilterLotSize {
  minQty: number;
  maxQty: number;
  stepSize: number;
  precision: number;
}

export interface SymbolFilterPrice {
  minPrice: number;
  maxPrice: number;
  tickSize: number;
  precision: number;
}

export interface SymbolFilterNotional {
  minNotional: number;
}

export interface BinanceSymbolInfo {
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

export interface BinanceTopOfBook {
  bestBid: number;
  bestAsk: number;
  mid: number;
  bidQty: number;
  askQty: number;
  time: number;
}

export interface BinanceOrderResult {
  symbol: string;
  orderId: number;
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
  fills?: Array<{
    price: string;
    qty: string;
    commission: string;
    commissionAsset: string;
    tradeId: number;
  }>;
}

export interface BinanceOpenOrder {
  symbol: string;
  orderId: number;
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
  isWorking: boolean;
}

export interface BinanceTrade {
  symbol: string;
  id: number;
  orderId: number;
  price: number;
  qty: number;
  quoteQty: number;
  commission: number;
  commissionAsset: string;
  time: number;
  isBuyer: boolean;
  isMaker: boolean;
}

export interface BinanceAccountBalances {
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
}

export interface BinanceClientOptions {
  apiKey?: string;
  apiSecret?: string;
  baseUrl?: string;
  recvWindow?: number;
  log?: (msg: string) => void;
}

/**
 * Calculates decimal precision (number of decimal places) from a step or tick size.
 */
export function getPrecision(val: number): number {
  if (!val || val >= 1) return 0;
  const str = val.toString();
  if (str.includes("e-")) {
    const parts = str.split("e-");
    return parseInt(parts[1], 10);
  }
  const decimalPart = str.split(".")[1];
  return decimalPart ? decimalPart.length : 0;
}

/**
 * Formats a quantity down to stepSize and precision without exponential notation.
 */
export function roundToStep(qty: number, stepSize: number, precision?: number): number {
  if (!stepSize || stepSize <= 0) return qty;
  const p = precision ?? getPrecision(stepSize);
  const steps = Math.floor(qty / stepSize + 1e-12);
  const stepped = steps * stepSize;
  return Number(stepped.toFixed(p));
}

/**
 * Formats a price to tickSize and precision without exponential notation.
 */
export function roundToTick(price: number, tickSize: number, precision?: number): number {
  if (!tickSize || tickSize <= 0) return price;
  const p = precision ?? getPrecision(tickSize);
  const ticks = Math.round(price / tickSize);
  const ticked = ticks * tickSize;
  return Number(ticked.toFixed(p));
}

/**
 * Formats a number to a string with exact precision, avoiding scientific notation (e.g. 1e-7).
 */
export function formatPrecisionString(val: number, precision: number): string {
  return val.toFixed(precision);
}

export class BinanceClient {
  private apiKey: string;
  private apiSecret: string;
  private baseUrl: string;
  private recvWindow: number;
  private readonly log: (msg: string) => void;
  private timeOffset = 0;
  private symbolInfoCache = new Map<string, BinanceSymbolInfo>();

  constructor(opts: BinanceClientOptions = {}) {
    this.apiKey = opts.apiKey || process.env.BINANCE_API_KEY || "";
    this.apiSecret = opts.apiSecret || process.env.BINANCE_API_SECRET || "";
    this.baseUrl = (opts.baseUrl || process.env.BINANCE_BASE_URL || "https://api.binance.com").replace(/\/+$/, "");
    this.recvWindow = opts.recvWindow ?? 5000;
    this.log = opts.log ?? ((msg: string) => console.log(`[binance-client] ${msg}`));
  }

  public updateCredentials(apiKey?: string, apiSecret?: string, baseUrl?: string): void {
    if (apiKey !== undefined) this.apiKey = apiKey.trim();
    if (apiSecret !== undefined) this.apiSecret = apiSecret.trim();
    if (baseUrl !== undefined) this.baseUrl = baseUrl.trim().replace(/\/+$/, "");
  }

  public getApiKey(): string {
    return this.apiKey;
  }

  public hasCredentials(): boolean {
    return Boolean(this.apiKey && this.apiSecret);
  }

  public getBaseUrl(): string {
    return this.baseUrl;
  }

  /**
   * Synchronize clock with Binance server to avoid recvWindow errors.
   */
  public async syncTime(): Promise<number> {
    try {
      const res = await this.publicRequest<{ serverTime: number }>("GET", "/api/v3/time");
      if (res && res.serverTime) {
        this.timeOffset = res.serverTime - Date.now();
        this.log(`🕒 Server time synchronized: offset=${this.timeOffset}ms`);
      }
    } catch (err) {
      this.log(`⚠️ Time synchronization warning: ${(err as Error).message}`);
    }
    return this.timeOffset;
  }

  /**
   * Fetch exchange information and parse filters for a specific symbol.
   */
  public async getExchangeInfo(symbol: string): Promise<BinanceSymbolInfo> {
    const sym = symbol.toUpperCase().replace(/[\/\-_:]/g, "");
    const cached = this.symbolInfoCache.get(sym);
    if (cached) return cached;

    const data = await this.publicRequest<{ symbols: any[] }>(
      "GET",
      `/api/v3/exchangeInfo?symbol=${sym}`,
    );

    if (!data.symbols || data.symbols.length === 0) {
      throw new Error(`Symbol ${sym} not found on Binance`);
    }

    const s = data.symbols[0];
    let minQty = 0.0001;
    let maxQty = 9000000;
    let stepSize = 0.0001;
    let minPrice = 0.01;
    let maxPrice = 1000000;
    let tickSize = 0.01;
    let minNotional = 5;

    for (const filter of s.filters || []) {
      if (filter.filterType === "LOT_SIZE") {
        minQty = Number(filter.minQty);
        maxQty = Number(filter.maxQty);
        stepSize = Number(filter.stepSize);
      } else if (filter.filterType === "PRICE_FILTER") {
        minPrice = Number(filter.minPrice);
        maxPrice = Number(filter.maxPrice);
        tickSize = Number(filter.tickSize);
      } else if (filter.filterType === "NOTIONAL" || filter.filterType === "MIN_NOTIONAL") {
        minNotional = Number(filter.minNotional ?? filter.notional ?? 5);
      }
    }

    const qtyPrecision = getPrecision(stepSize);
    const pricePrecision = getPrecision(tickSize);

    const info: BinanceSymbolInfo = {
      symbol: sym,
      status: s.status,
      baseAsset: s.baseAsset,
      quoteAsset: s.quoteAsset,
      baseAssetPrecision: Number(s.baseAssetPrecision ?? qtyPrecision),
      quotePrecision: Number(s.quotePrecision ?? pricePrecision),
      minQty,
      maxQty,
      stepSize,
      qtyPrecision,
      minPrice,
      maxPrice,
      tickSize,
      pricePrecision,
      minNotional,
    };

    this.symbolInfoCache.set(sym, info);
    return info;
  }

  /**
   * Fetch best bid, ask, and mid price from Binance order book ticker.
   */
  public async getTopOfBook(symbol: string): Promise<BinanceTopOfBook> {
    const sym = symbol.toUpperCase().replace(/[\/\-_:]/g, "");
    const data = await this.publicRequest<{
      symbol: string;
      bidPrice: string;
      bidQty: string;
      askPrice: string;
      askQty: string;
    }>("GET", `/api/v3/ticker/bookTicker?symbol=${sym}`);

    const bestBid = Number(data.bidPrice);
    const bestAsk = Number(data.askPrice);
    const mid = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : bestBid || bestAsk;

    return {
      bestBid,
      bestAsk,
      mid,
      bidQty: Number(data.bidQty),
      askQty: Number(data.askQty),
      time: Date.now(),
    };
  }

  /**
   * Fetch account balances for the base and quote asset of a given symbol.
   */
  public async getAccountBalances(symbol?: string): Promise<BinanceAccountBalances> {
    let baseAsset = "BTC";
    let quoteAsset = "USDT";

    if (symbol) {
      try {
        const info = await this.getExchangeInfo(symbol);
        baseAsset = info.baseAsset;
        quoteAsset = info.quoteAsset;
      } catch {
        // Fallback guess from string e.g. BTCUSDT
        const clean = symbol.toUpperCase().replace(/[\/\-_:]/g, "");
        if (clean.endsWith("USDT")) {
          baseAsset = clean.slice(0, -4);
          quoteAsset = "USDT";
        } else if (clean.endsWith("USDC")) {
          baseAsset = clean.slice(0, -4);
          quoteAsset = "USDC";
        }
      }
    }

    const account = await this.signedRequest<{
      balances: Array<{ asset: string; free: string; locked: string }>;
    }>("GET", "/api/v3/account");

    const allBalances: Record<string, { free: number; locked: number }> = {};
    for (const b of account.balances || []) {
      const free = Number(b.free);
      const locked = Number(b.locked);
      if (free > 0 || locked > 0) {
        allBalances[b.asset] = { free, locked };
      }
    }

    const baseBal = allBalances[baseAsset] || { free: 0, locked: 0 };
    const quoteBal = allBalances[quoteAsset] || { free: 0, locked: 0 };

    return {
      baseAsset,
      quoteAsset,
      baseFree: baseBal.free,
      baseLocked: baseBal.locked,
      baseTotal: baseBal.free + baseBal.locked,
      quoteFree: quoteBal.free,
      quoteLocked: quoteBal.locked,
      quoteTotal: quoteBal.free + quoteBal.locked,
      allBalances,
    };
  }

  /**
   * Fetch all resting open orders for a symbol.
   */
  public async getOpenOrders(symbol: string): Promise<BinanceOpenOrder[]> {
    const sym = symbol.toUpperCase().replace(/[\/\-_:]/g, "");
    const rawOrders = await this.signedRequest<any[]>("GET", "/api/v3/openOrders", { symbol: sym });
    return (rawOrders || []).map((o) => ({
      symbol: o.symbol,
      orderId: Number(o.orderId),
      clientOrderId: o.clientOrderId,
      price: Number(o.price),
      origQty: Number(o.origQty),
      executedQty: Number(o.executedQty),
      cummulativeQuoteQty: Number(o.cummulativeQuoteQty),
      status: o.status,
      timeInForce: o.timeInForce,
      type: o.type,
      side: o.side,
      time: Number(o.time),
      updateTime: Number(o.updateTime),
      isWorking: Boolean(o.isWorking),
    }));
  }

  /**
   * Query a single order by orderId.
   */
  public async getOrder(symbol: string, orderId: number | string): Promise<BinanceOpenOrder> {
    const sym = symbol.toUpperCase().replace(/[\/\-_:]/g, "");
    const o = await this.signedRequest<any>("GET", "/api/v3/order", {
      symbol: sym,
      orderId: String(orderId),
    });
    return {
      symbol: o.symbol,
      orderId: Number(o.orderId),
      clientOrderId: o.clientOrderId,
      price: Number(o.price),
      origQty: Number(o.origQty),
      executedQty: Number(o.executedQty),
      cummulativeQuoteQty: Number(o.cummulativeQuoteQty),
      status: o.status,
      timeInForce: o.timeInForce,
      type: o.type,
      side: o.side,
      time: Number(o.time),
      updateTime: Number(o.updateTime),
      isWorking: Boolean(o.isWorking),
    };
  }

  /**
   * Fetch recent trade executions for a symbol.
   */
  public async getMyTrades(symbol: string, limit = 50): Promise<BinanceTrade[]> {
    const sym = symbol.toUpperCase().replace(/[\/\-_:]/g, "");
    const trades = await this.signedRequest<any[]>("GET", "/api/v3/myTrades", {
      symbol: sym,
      limit: Math.min(500, Math.max(1, limit)),
    });
    return (trades || []).map((t) => ({
      symbol: t.symbol,
      id: Number(t.id),
      orderId: Number(t.orderId),
      price: Number(t.price),
      qty: Number(t.qty),
      quoteQty: Number(t.quoteQty),
      commission: Number(t.commission),
      commissionAsset: t.commissionAsset,
      time: Number(t.time),
      isBuyer: Boolean(t.isBuyer),
      isMaker: Boolean(t.isMaker),
    }));
  }

  /**
   * Place an order (LIMIT, LIMIT_MAKER, IOC, or MARKET).
   */
  public async placeOrder(params: PlaceOrderParams): Promise<BinanceOrderResult> {
    const info = await this.getExchangeInfo(params.symbol);
    const sym = info.symbol;

    // Format quantity according to stepSize
    const cleanQty = roundToStep(params.qty, info.stepSize, info.qtyPrecision);
    if (cleanQty < info.minQty) {
      throw new Error(
        `Order quantity ${cleanQty} is below minimum allowed quantity ${info.minQty} for ${sym}`,
      );
    }
    const qtyStr = formatPrecisionString(cleanQty, info.qtyPrecision);

    const bodyParams: Record<string, any> = {
      symbol: sym,
      side: params.side,
      quantity: qtyStr,
    };

    if (params.clientOrderId) {
      bodyParams.newClientOrderId = params.clientOrderId;
    }

    if (params.type === "MARKET") {
      bodyParams.type = "MARKET";
    } else if (params.type === "IOC") {
      if (!params.price || params.price <= 0) {
        throw new Error("Price is required for IOC orders");
      }
      const cleanPrice = roundToTick(params.price, info.tickSize, info.pricePrecision);
      bodyParams.type = "LIMIT";
      bodyParams.timeInForce = "IOC";
      bodyParams.price = formatPrecisionString(cleanPrice, info.pricePrecision);
    } else if (params.type === "LIMIT_MAKER") {
      if (!params.price || params.price <= 0) {
        throw new Error("Price is required for LIMIT_MAKER orders");
      }
      const cleanPrice = roundToTick(params.price, info.tickSize, info.pricePrecision);
      bodyParams.type = "LIMIT_MAKER";
      bodyParams.price = formatPrecisionString(cleanPrice, info.pricePrecision);
    } else {
      // Standard LIMIT (GTC)
      if (!params.price || params.price <= 0) {
        throw new Error("Price is required for LIMIT orders");
      }
      const cleanPrice = roundToTick(params.price, info.tickSize, info.pricePrecision);
      bodyParams.type = "LIMIT";
      bodyParams.timeInForce = "GTC";
      bodyParams.price = formatPrecisionString(cleanPrice, info.pricePrecision);
    }

    // Verify minNotional
    if (bodyParams.price) {
      const notional = Number(bodyParams.price) * cleanQty;
      if (notional < info.minNotional) {
        throw new Error(
          `Order notional value $${notional.toFixed(2)} is below minimum notional $${info.minNotional.toFixed(2)} for ${sym}`,
        );
      }
    }

    const raw = await this.signedRequest<any>("POST", "/api/v3/order", bodyParams);

    return {
      symbol: raw.symbol,
      orderId: Number(raw.orderId),
      txHash: String(raw.orderId),
      clientOrderId: raw.clientOrderId,
      transactTime: Number(raw.transactTime),
      price: Number(raw.price || params.price || 0),
      origQty: Number(raw.origQty),
      executedQty: Number(raw.executedQty),
      cummulativeQuoteQty: Number(raw.cummulativeQuoteQty),
      status: raw.status,
      timeInForce: raw.timeInForce,
      type: raw.type,
      side: raw.side,
      fills: raw.fills,
    };
  }

  /**
   * Cancel an open order by orderId or clientOrderId.
   */
  public async cancelOrder(symbol: string, orderId: number | string): Promise<any> {
    const sym = symbol.toUpperCase().replace(/[\/\-_:]/g, "");
    return await this.signedRequest<any>("DELETE", "/api/v3/order", {
      symbol: sym,
      orderId: String(orderId),
    });
  }

  /**
   * Cancel all open orders for a given symbol.
   */
  public async cancelAllOpenOrders(symbol: string): Promise<any> {
    const sym = symbol.toUpperCase().replace(/[\/\-_:]/g, "");
    return await this.signedRequest<any>("DELETE", "/api/v3/openOrders", {
      symbol: sym,
    });
  }

  // ── HTTP Request Core ─────────────────────────────────────────────────────

  private async publicRequest<T = any>(
    method: "GET" | "POST",
    path: string,
    params: Record<string, any> = {},
  ): Promise<T> {
    return this.rawRequest<T>(method, path, params, false);
  }

  private async signedRequest<T = any>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    params: Record<string, any> = {},
  ): Promise<T> {
    return this.rawRequest<T>(method, path, params, true);
  }

  private async rawRequest<T = any>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    params: Record<string, any> = {},
    signed = false,
    retryCount = 0,
  ): Promise<T> {
    const cleanParams: Record<string, string> = {};
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) {
        cleanParams[k] = String(v);
      }
    }

    if (signed) {
      if (!this.apiKey || !this.apiSecret) {
        throw new Error(
          `Binance API Key and Secret are required for signed endpoint: ${path}. Please configure BINANCE_API_KEY and BINANCE_API_SECRET in .env`,
        );
      }
      cleanParams.timestamp = String(Date.now() + this.timeOffset);
      cleanParams.recvWindow = String(this.recvWindow);

      const queryString = new URLSearchParams(cleanParams).toString();
      const signature = crypto
        .createHmac("sha256", this.apiSecret)
        .update(queryString)
        .digest("hex");
      cleanParams.signature = signature;
    }

    const query = new URLSearchParams(cleanParams).toString();
    const url = `${this.baseUrl}${path}${query ? (path.includes("?") ? "&" : "?") + query : ""}`;

    const headers: Record<string, string> = {
      "User-Agent": "dynamic-grid-binance/1.0",
      Accept: "application/json",
    };
    if (this.apiKey) {
      headers["X-MBX-APIKEY"] = this.apiKey;
    }

    try {
      const res = await fetch(url, {
        method,
        headers,
      });

      const text = await res.text();
      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`Binance HTTP ${res.status}: ${text}`);
      }

      if (!res.ok || (data && typeof data.code === "number" && data.code < 0)) {
        // If timestamp outside recvWindow (-1021), resync time and retry once
        if (data?.code === -1021 && retryCount === 0) {
          this.log(`⚠️ Timestamp error (-1021) encountered. Re-syncing time with Binance server...`);
          await this.syncTime();
          return this.rawRequest<T>(method, path, params, signed, retryCount + 1);
        }

        const code = data?.code ?? res.status;
        const msg = data?.msg ?? text;
        throw new Error(`Binance Error [${code}]: ${msg}`);
      }

      return data as T;
    } catch (err) {
      throw err;
    }
  }
}
