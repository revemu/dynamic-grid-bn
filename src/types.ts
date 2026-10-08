/**
 * A pluggable source of volatility for the dynamic grid. Implementations may
 * be pushed to (an external WebSocket feed) or pulled from (sampling
 * DreamDEX's own top-of-book) — the strategy only cares about `atrPct()`.
 */
export interface AtrSource {
  /**
   * ATR expressed as a fraction of price (dimensionless), e.g. 0.004 = 0.4%.
   * Using a relative figure — instead of an absolute price — means it's safe
   * to compute ATR on one market (e.g. SOMI/USDT on Binance) and apply it to
   * the step size on a *different* market (SOMI/USDso on DreamDEX): both are
   * "percent of price," so the quote-currency scale difference washes out.
   * Returns undefined until the source has enough data to be meaningful.
   */
  atrPct(): number | undefined;

  /** How many bars have fed the current ATR estimate (for status logging). */
  barsReady(): number;

  /**
   * Optional: feed a price sample every strategy tick. Self-sampled sources
   * (e.g. VolatilityEngine, which builds bars from DreamDEX's own mid price)
   * need this; push-based external feeds (e.g. BinanceAtrFeed) ignore it.
   */
  sample?(price: number, now?: number): void;

  /**
   * Optional freshness check for push-based feeds. If present and it returns
   * false, the strategy treats atrPct() as unavailable and holds the last
   * known step rather than sizing off stale data.
   */
  isFresh?(): boolean;

  /** Optional callback for streaming candles to UI and market structure engine. */
  onCandle?(fn: (candle: any, isClosed: boolean) => void): void;

  /** Optional: get latest live price from feed (e.g. Binance CEX reference price). */
  getLatestPrice?(): number | undefined;
}
