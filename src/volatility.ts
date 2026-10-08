/**
 * Volatility engine for the dynamic grid strategy.
 *
 * DreamDEX's REST API (as shipped in @dreamdex-bot-kit/core / docs.dreamdex.io
 * at the time this was written) does not expose a klines/candles endpoint, so
 * we build our own OHLC bars by sampling `pool.topOfBook().mid` on every
 * strategy tick and bucketing samples into fixed-duration bars. This is a
 * reasonable proxy for ATR as long as `intervalMs` (how often the strategy
 * ticks) is meaningfully smaller than `barMs` (how long each bar is), so each
 * bar actually contains several samples.
 *
 * If DreamDEX later ships a candles endpoint, swap this out for real OHLC
 * data — it will converge faster and be less sensitive to the polling
 * interval than sampled-mid bars.
 */

import type { Candle } from "./market-structure.js";

export interface Bar {
  open: number;
  high: number;
  low: number;
  close: number;
}

export class VolatilityEngine {
  private current?: Bar;
  private currentBarStart = 0;
  private prevClose?: number;
  private trHistory: number[] = [];
  private closedBars = 0;
  private candleListeners: ((candle: Candle, isClosed: boolean) => void)[] = [];

  /**
   * @param barMs     Duration of each OHLC bar, in ms.
   * @param lookback  Number of bars to average True Range over (classic ATR
   *                  uses 14).
   */
  constructor(
    private readonly barMs: number,
    private readonly lookback: number,
  ) {}

  onCandle(fn: (candle: Candle, isClosed: boolean) => void): void {
    this.candleListeners.push(fn);
  }

  /** Feed one mid-price sample. Call this every strategy tick. */
  sample(mid: number, now: number = Date.now()): void {
    if (!Number.isFinite(mid) || mid <= 0) return;

    if (!this.current || now - this.currentBarStart >= this.barMs) {
      if (this.current) this.closeBar(this.current);
      this.current = { open: mid, high: mid, low: mid, close: mid };
      this.currentBarStart = now;
      this.emitCurrentCandle(false);
      return;
    }

    this.current.high = Math.max(this.current.high, mid);
    this.current.low = Math.min(this.current.low, mid);
    this.current.close = mid;
    this.emitCurrentCandle(false);
  }

  private emitCurrentCandle(isClosed: boolean): void {
    if (!this.current) return;
    const candle: Candle = {
      time: Math.floor(this.currentBarStart / 1000),
      open: this.current.open,
      high: this.current.high,
      low: this.current.low,
      close: this.current.close,
      isClosed,
    };
    for (const listener of this.candleListeners) {
      listener(candle, isClosed);
    }
  }

  private closeBar(bar: Bar): void {
    this.emitCurrentCandle(true);
    const tr =
      this.prevClose === undefined
        ? bar.high - bar.low
        : Math.max(
            bar.high - bar.low,
            Math.abs(bar.high - this.prevClose),
            Math.abs(bar.low - this.prevClose),
          );

    this.trHistory.push(tr);
    if (this.trHistory.length > this.lookback) this.trHistory.shift();

    this.prevClose = bar.close;
    this.closedBars++;
  }

  /**
   * Average True Range over the lookback window, in price (quote) units.
   * Returns undefined until at least 3 bars have closed, so the strategy can
   * fall back to a fixed warmup step instead of trading on a noisy 1-bar ATR.
   */
  atr(): number | undefined {
    if (this.trHistory.length < Math.min(this.lookback, 3)) return undefined;
    const sum = this.trHistory.reduce((a, b) => a + b, 0);
    return sum / this.trHistory.length;
  }

  /** How many closed bars have fed the current ATR (for status logging). */
  barsReady(): number {
    return this.trHistory.length;
  }

  /** ATR expressed as a fraction of the last closed price. Satisfies AtrSource. */
  atrPct(): number | undefined {
    const atr = this.atr();
    if (atr === undefined || this.prevClose === undefined || this.prevClose <= 0) return undefined;
    return atr / this.prevClose;
  }
}
