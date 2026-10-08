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
