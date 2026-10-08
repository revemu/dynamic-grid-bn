/**
 * Streams closed 1-minute (or configurable) klines for a symbol from
 * Binance's public WebSocket market-data API and maintains a rolling ATR —
 * expressed as a percentage of price, see AtrSource — from CLOSED candles
 * only.
 *
 * This is an EXTERNAL, cross-exchange read used purely to size the grid
 * step. It is never used as an execution price: buy/sell triggers and order
 * prices always come from DreamDEX's own `pool.topOfBook()`. Binance is a
 * different exchange with its own order book (SOMI/USDT), so its price can
 * and will differ slightly from DreamDEX's (SOMI/USDso) — that basis risk is
 * why this feed is used only for *relative* sizing (ATR as % of price), and
 * why the DreamDEX book, not this feed, always decides what the bot actually
 * pays or receives.
 *
 * No API key required — Binance's kline stream is public market data.
 * Docs: https://developers.binance.com/docs/binance-spot-api-docs/web-socket-streams
 */

import WebSocket from "ws";
import type { AtrSource } from "./types.js";
import type { Candle } from "./market-structure.js";

export interface BinanceFeedConfig {
  /** Lowercase Binance symbol, e.g. "somiusdt". */
  symbol: string;
  /** Kline interval, e.g. "1m", "5m". */
  interval: string;
  /** Override for testing / using Binance.US or the futures stream host. */
  wsBase?: string;
  /** Feed is considered stale (and ATR treated as unavailable) after this long with no message. */
  staleMs?: number;
  /** Optional REST API base to fetch historical candles on startup (default: https://api.binance.com). */
  restBase?: string;
  /** Number of historical candles to fetch upon startup (default: 300, max: 1000). */
  initialCandleCount?: number;
}

export class BinanceAtrFeed implements AtrSource {
  private ws?: WebSocket;
  private trPctHistory: number[] = [];
  private prevClose?: number;
  private latestPrice?: number;
  private reconnectDelayMs = 1_000;
  private stopped = false;
  private connected = false;
  private lastMessageAt = 0;
  private candleListeners: ((candle: Candle, isClosed: boolean) => void)[] = [];

  constructor(
    private readonly cfg: BinanceFeedConfig,
    private readonly lookback: number,
    private readonly log: (msg: string) => void,
  ) {}

  onCandle(fn: (candle: Candle, isClosed: boolean) => void): void {
    this.candleListeners.push(fn);
  }

  start(): void {
    this.stopped = false;
    this.fetchHistoricalKlines().finally(() => {
      if (!this.stopped) {
        this.connect();
      }
    });
  }

  private async fetchHistoricalKlines(): Promise<void> {
    const restBase = this.cfg.restBase ?? "https://api.binance.com";
    const symbol = this.cfg.symbol.toUpperCase();
    const interval = this.cfg.interval;
    const limit = Math.min(1000, Math.max(10, this.cfg.initialCandleCount ?? 300));
    const url = `${restBase}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;

    try {
      this.log(`fetching historical klines for warmup: ${url}`);
      const res = await fetch(url);
      if (!res.ok) {
        this.log(`warning: could not fetch historical klines (status ${res.status}), will warm up from live stream`);
        return;
      }
      const rawKlines = (await res.json()) as any[];
      if (!Array.isArray(rawKlines)) return;

      this.log(`loaded ${rawKlines.length} historical candles from Binance for immediate warmup`);
      for (const k of rawKlines) {
        const time = Math.floor(Number(k[0]) / 1000); // open time in seconds
        const open = Number(k[1]);
        const high = Number(k[2]);
        const low = Number(k[3]);
        const close = Number(k[4]);

        if ([time, open, high, low, close].every(Number.isFinite) && close > 0) {
          this.latestPrice = close;
          const candle: Candle = { time, open, high, low, close };
          this.onClosedBar(high, low, close);
          for (const listener of this.candleListeners) {
            listener(candle, true);
          }
        }
      }
    } catch (err) {
      this.log(`warning: historical klines fetch error (${(err as Error).message}), continuing with live stream`);
    }
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
  }

  private connect(): void {
    const base = this.cfg.wsBase ?? "wss://stream.binance.com:9443";
    const url = `${base}/ws/${this.cfg.symbol.toLowerCase()}@kline_${this.cfg.interval}`;
    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      this.connected = true;
      this.lastMessageAt = Date.now();
      this.reconnectDelayMs = 1_000;
      this.log(`binance ATR feed connected: ${url}`);
    });

    this.ws.on("message", (raw: Buffer) => {
      this.lastMessageAt = Date.now();
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return; // malformed frame — ignore, next message will come
      }
      const k = msg?.k;
      if (!k) return;
      const time = Math.floor(Number(k.t) / 1000);
      const open = Number(k.o);
      const high = Number(k.h);
      const low = Number(k.l);
      const close = Number(k.c);
      const isClosed = k.x === true;

      if ([time, open, high, low, close].every(Number.isFinite) && close > 0) {
        this.latestPrice = close;
        const candle: Candle = { time, open, high, low, close };
        for (const listener of this.candleListeners) {
          listener(candle, isClosed);
        }
        if (isClosed) {
          this.onClosedBar(high, low, close);
        }
      }
    });

    this.ws.on("close", () => {
      this.connected = false;
      if (this.stopped) return;
      this.log(`binance ATR feed disconnected — reconnecting in ${this.reconnectDelayMs}ms`);
      setTimeout(() => this.connect(), this.reconnectDelayMs);
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
    });

    this.ws.on("error", (err: Error) => {
      this.log(`binance ATR feed error: ${err.message}`);
    });
  }

  private onClosedBar(high: number, low: number, close: number): void {
    const tr =
      this.prevClose === undefined
        ? high - low
        : Math.max(high - low, Math.abs(high - this.prevClose), Math.abs(low - this.prevClose));

    // Store TR as a fraction of price immediately — this is what makes the
    // feed safe to use across a different market than the one it samples.
    const trPct = tr / close;
    this.trPctHistory.push(trPct);
    if (this.trPctHistory.length > this.lookback) this.trPctHistory.shift();

    this.prevClose = close;
  }

  atrPct(): number | undefined {
    if (this.trPctHistory.length < Math.min(this.lookback, 3)) return undefined;
    const sum = this.trPctHistory.reduce((a, b) => a + b, 0);
    return sum / this.trPctHistory.length;
  }

  barsReady(): number {
    return this.trPctHistory.length;
  }

  getLatestPrice(): number | undefined {
    return this.latestPrice;
  }

  /** False if never connected, or no message received within staleMs (default 20s). */
  isFresh(): boolean {
    const staleMs = this.cfg.staleMs ?? 20_000;
    return this.connected && Date.now() - this.lastMessageAt < staleMs;
  }
}

/**
 * Streams real-time top-of-book (bestBid, bestAsk) from Binance public WebSocket.
 * Stream: <symbol>@bookTicker
 * Zero REST weight!
 */
export interface BookTickerData {
  bestBid: number;
  bestAsk: number;
  mid: number;
  bidQty: number;
  askQty: number;
  time: number;
}

export class BinanceBookTickerFeed {
  private ws?: WebSocket;
  private stopped = false;
  private connected = false;
  private reconnectDelayMs = 1_000;
  private latestBook?: BookTickerData;
  private listeners: ((book: BookTickerData) => void)[] = [];

  constructor(
    private readonly symbol: string,
    private readonly wsBase = "wss://stream.binance.com:9443",
    private readonly log: (msg: string) => void = () => {},
  ) {}

  onBook(fn: (book: BookTickerData) => void): void {
    this.listeners.push(fn);
  }

  getLatest(): BookTickerData | undefined {
    return this.latestBook;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
  }

  private connect(): void {
    const url = `${this.wsBase}/ws/${this.symbol.toLowerCase()}@bookTicker`;
    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      this.connected = true;
      this.reconnectDelayMs = 1_000;
      this.log(`Binance bookTicker feed connected: ${url}`);
    });

    this.ws.on("message", (raw: Buffer) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      // Format: { u: 400900217, s: "BNBUSDT", b: "25.35190000", B: "31.21000000", a: "25.36520000", A: "40.66000000" }
      const bestBid = Number(msg.b);
      const bestAsk = Number(msg.a);
      const bidQty = Number(msg.B);
      const askQty = Number(msg.A);

      if (bestBid > 0 && bestAsk > 0) {
        const mid = (bestBid + bestAsk) / 2;
        const book: BookTickerData = {
          bestBid,
          bestAsk,
          mid,
          bidQty,
          askQty,
          time: Date.now(),
        };
        this.latestBook = book;
        for (const fn of this.listeners) {
          fn(book);
        }
      }
    });

    this.ws.on("close", () => {
      this.connected = false;
      if (this.stopped) return;
      this.log(`Binance bookTicker disconnected — reconnecting in ${this.reconnectDelayMs}ms`);
      setTimeout(() => this.connect(), this.reconnectDelayMs);
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
    });

    this.ws.on("error", (err: Error) => {
      this.log(`Binance bookTicker feed error: ${err.message}`);
    });
  }
}

/**
 * Real-time User Data Stream WebSocket client.
 * Receives executionReport (order match/fill/cancel) and outboundAccountPosition (balances)
 * via listenKey without REST API polling!
 */
export interface BinanceExecutionReport {
  symbol: string;
  clientOrderId: string;
  side: "BUY" | "SELL";
  orderType: string;
  timeInForce: string;
  origQty: number;
  price: number;
  executionType: "NEW" | "CANCELED" | "REPLACED" | "REJECTED" | "TRADE" | "EXPIRED";
  orderStatus: "NEW" | "PARTIALLY_FILLED" | "FILLED" | "CANCELED" | "REJECTED" | "EXPIRED";
  orderRejectReason: string;
  orderId: number;
  lastExecutedQty: number;
  cumulativeFilledQty: number;
  lastExecutedPrice: number;
  commissionAmount: number;
  commissionAsset: string | null;
  transactionTime: number;
  tradeId: number;
  cummulativeQuoteQty: number;
}

export interface BinanceAccountUpdate {
  balances: Array<{
    asset: string;
    free: number;
    locked: number;
  }>;
  eventTime: number;
}

export class BinanceUserDataFeed {
  private ws?: WebSocket;
  private stopped = false;
  private connected = false;
  private listenKey?: string;
  private keepAliveTimer?: NodeJS.Timeout;
  private reconnectDelayMs = 1_000;

  private executionListeners: ((report: BinanceExecutionReport) => void)[] = [];
  private balanceListeners: ((update: BinanceAccountUpdate) => void)[] = [];

  constructor(
    private readonly client: {
      createUserDataStream: () => Promise<string>;
      keepAliveUserDataStream: (key: string) => Promise<void>;
      closeUserDataStream: (key: string) => Promise<void>;
    },
    private readonly wsBase = "wss://stream.binance.com:9443",
    private readonly log: (msg: string) => void = () => {},
  ) {}

  onExecutionReport(fn: (report: BinanceExecutionReport) => void): void {
    this.executionListeners.push(fn);
  }

  onAccountUpdate(fn: (update: BinanceAccountUpdate) => void): void {
    this.balanceListeners.push(fn);
  }

  async start(): Promise<void> {
    this.stopped = false;
    try {
      this.listenKey = await this.client.createUserDataStream();
      this.log(`Binance User Data Stream acquired listenKey: ${this.listenKey.slice(0, 8)}...`);
      this.connect();
      this.scheduleKeepAlive();
    } catch (err: any) {
      const msg = String(err?.message || "");
      const cleanMsg = msg.includes("<html>") ? (msg.match(/<title>(.*?)<\/title>/i)?.[1] || "HTTP Error") : msg;
      this.log(`⚠️ User Data Stream unavailable (${cleanMsg}). Bot continues using standard REST order tracking.`);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = undefined;
    }
    this.ws?.close();
    if (this.listenKey) {
      this.client.closeUserDataStream(this.listenKey).catch(() => {});
      this.listenKey = undefined;
    }
  }

  private scheduleKeepAlive(): void {
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    // Binance requires keep-alive ping every 30-60 mins; ping every 20 minutes
    this.keepAliveTimer = setInterval(async () => {
      if (this.stopped || !this.listenKey) return;
      try {
        await this.client.keepAliveUserDataStream(this.listenKey);
        this.log(`🔄 User Data Stream listenKey keep-alive sent`);
      } catch (err) {
        this.log(`⚠️ User Data Stream keep-alive failed: ${(err as Error).message}`);
      }
    }, 20 * 60 * 1000);
  }

  private connect(): void {
    if (!this.listenKey || this.stopped) return;
    const url = `${this.wsBase}/ws/${this.listenKey}`;
    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      this.connected = true;
      this.reconnectDelayMs = 1_000;
      this.log(`Binance User Data Stream WebSocket connected`);
    });

    this.ws.on("message", (raw: Buffer) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      const eventType = msg.e;
      if (eventType === "executionReport") {
        const report: BinanceExecutionReport = {
          symbol: msg.s,
          clientOrderId: msg.c,
          side: msg.S,
          orderType: msg.o,
          timeInForce: msg.f,
          origQty: Number(msg.q),
          price: Number(msg.p),
          executionType: msg.x,
          orderStatus: msg.X,
          orderRejectReason: msg.r,
          orderId: Number(msg.i),
          lastExecutedQty: Number(msg.l),
          cumulativeFilledQty: Number(msg.z),
          lastExecutedPrice: Number(msg.L),
          commissionAmount: Number(msg.n ?? 0),
          commissionAsset: msg.N ?? null,
          transactionTime: Number(msg.T ?? msg.E),
          tradeId: Number(msg.t),
          cummulativeQuoteQty: Number(msg.Z ?? 0),
        };
        for (const fn of this.executionListeners) {
          fn(report);
        }
      } else if (eventType === "outboundAccountPosition") {
        // Balances updated: msg.B is array of { a: asset, f: free, l: locked }
        const balances = Array.isArray(msg.B)
          ? msg.B.map((b: any) => ({
              asset: String(b.a),
              free: Number(b.f),
              locked: Number(b.l),
            }))
          : [];
        const update: BinanceAccountUpdate = {
          balances,
          eventTime: Number(msg.E),
        };
        for (const fn of this.balanceListeners) {
          fn(update);
        }
      }
    });

    this.ws.on("close", () => {
      this.connected = false;
      if (this.stopped) return;
      this.log(`Binance User Data Stream disconnected — reconnecting in ${this.reconnectDelayMs}ms`);
      setTimeout(async () => {
        if (!this.stopped) {
          try {
            // Refresh listenKey on reconnect
            this.listenKey = await this.client.createUserDataStream();
          } catch {}
          this.connect();
        }
      }, this.reconnectDelayMs);
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
    });

    this.ws.on("error", (err: Error) => {
      this.log(`Binance User Data Stream error: ${err.message}`);
    });
  }
}
