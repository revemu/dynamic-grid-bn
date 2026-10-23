/**
 * Market structure analysis using Dow Theory principles.
 * Establishes the Channel Grid Zone:
 * - 0% Lower Bound (Support / Floor): Cut Loss / Stop Loss boundary.
 * - 0% to 50% Buy Zone: Stepped accumulation zone.
 * - 50% Center (Midpoint): Neutral equilibrium price.
 * - 50% to 100% Sell Zone: Stepped profit taking zone.
 * - 100% Upper Bound (Resistance / Ceiling): 100% Full Take-Profit exit.
 */

import type {
  Candle,
  MarketRegime,
  SwingPoint,
  CandidatePoint,
  GridZone,
  TrendLinePoint,
  TrendLine,
  DowLabel,
  DowSwingPoint,
  WaveLeg,
  WaveCycleData,
  DowStructure,
  ChannelOptions,
} from "./types.js";
import { getEffectiveHigh, getEffectiveLow, CandleManager } from "./candle-manager.js";
import { SwingDetector } from "./swing-detector.js";
import { DowEngine } from "./dow-engine.js";
import { TrendlineEngine } from "./trendline-engine.js";
import { ChannelEngine } from "./channel-engine.js";

export * from "./types.js";
export { getEffectiveHigh, getEffectiveLow, CandleManager } from "./candle-manager.js";
export { SwingDetector } from "./swing-detector.js";
export { DowEngine } from "./dow-engine.js";
export { TrendlineEngine } from "./trendline-engine.js";
export { ChannelEngine } from "./channel-engine.js";

export class DowStructureEngine {
  private candleManager: CandleManager;
  private swingHighs: SwingPoint[] = [];
  private swingLows: SwingPoint[] = [];

  constructor(
    private pivotWindow: number = 3,
    private useTrueWick: boolean = true,
    wickThresholdPct: number = 20.0,
    maxCandles: number = 600,
  ) {
    this.candleManager = new CandleManager(pivotWindow, useTrueWick, wickThresholdPct, maxCandles);
  }

  public setMaxCandles(val: number): void {
    this.candleManager.setMaxCandles(val, () => this.recalculateSwings());
  }

  public getMaxCandles(): number {
    return this.candleManager.getMaxCandles();
  }

  public setPivotWindow(val: number): void {
    const k = Math.max(2, Math.round(val));
    if (this.pivotWindow !== k) {
      this.pivotWindow = k;
      this.candleManager.setPivotWindow(k);
      this.recalculateSwings();
    }
  }

  public getPivotWindow(): number {
    return this.pivotWindow;
  }

  public setUseTrueWick(val: boolean): void {
    if (this.useTrueWick !== val) {
      this.useTrueWick = val;
      this.candleManager.setUseTrueWick(val);
      this.recalculateSwings();
    }
  }

  public getUseTrueWick(): boolean {
    return this.useTrueWick;
  }

  public setWickThresholdPct(val: number): void {
    this.candleManager.setWickThresholdPct(val, () => this.recalculateSwings());
  }

  public getWickThresholdPct(): number {
    return this.candleManager.getWickThresholdPct();
  }

  public addCandle(candle: Candle): void {
    this.candleManager.addCandle(candle, () => this.recalculateSwings());
  }

  public getCandles(): Candle[] {
    return this.candleManager.getCandles();
  }

  public getClosedCandles(): Candle[] {
    return this.candleManager.getClosedCandles();
  }

  public getLastClosedCandle(): Candle | undefined {
    return this.candleManager.getLastClosedCandle();
  }

  public getSwingLows(): SwingPoint[] {
    return this.swingLows;
  }

  public getSwingHighs(): SwingPoint[] {
    return this.swingHighs;
  }

  public checkForHigherLow(
    sinceTime: number,
    referenceFloor: number,
    lowestDumpPrice: number,
    currentPrice?: number,
  ): { confirmed: boolean; higherLow?: SwingPoint; reason?: string } {
    return DowEngine.checkForHigherLow(
      this.candleManager.getCandles(),
      this.swingHighs,
      this.swingLows,
      sinceTime,
      referenceFloor,
      lowestDumpPrice,
      currentPrice,
      this.useTrueWick,
      this.candleManager.getWickThresholdFraction(),
      this.candleManager.getStructureLookback(),
    );
  }

  private recalculateSwings(): void {
    const { swingHighs, swingLows } = SwingDetector.findSwings(
      this.candleManager.getCandles(),
      this.pivotWindow,
      this.useTrueWick,
      this.candleManager.getWickThresholdFraction(),
    );
    this.swingHighs = swingHighs;
    this.swingLows = swingLows;
  }

  public calculateTrendlines(
    currentPrice: number,
    activeValley?: SwingPoint,
    activePeak?: SwingPoint,
    lastHh?: SwingPoint,
    lastLl?: SwingPoint,
    annotatedSwings?: DowSwingPoint[],
    customCandles?: Candle[],
  ): {
    downtrendLine?: TrendLine;
    uptrendLine?: TrendLine;
    downtrendBreakoutConfirmed?: boolean;
    uptrendBreakdownConfirmed?: boolean;
  } {
    const candlesToUse = customCandles ?? this.candleManager.getCandles();
    return TrendlineEngine.calculateTrendlines(
      candlesToUse,
      this.swingHighs,
      this.swingLows,
      this.candleManager.getStructureLookback(),
      currentPrice,
      activeValley,
      activePeak,
      lastHh,
      lastLl,
      annotatedSwings,
      this.useTrueWick,
      this.candleManager.getWickThresholdFraction(),
    );
  }

  public calculateWaveCycles(activeValley?: SwingPoint, activePeak?: SwingPoint): WaveCycleData {
    return DowEngine.calculateWaveCycles(
      this.candleManager.getCandles(),
      this.swingHighs,
      this.swingLows,
      this.candleManager.getStructureLookback(),
      activeValley,
      activePeak,
    );
  }

  public getAtrPct(period = 14): number {
    return this.candleManager.getAtrPct(period);
  }

  /**
   * Get current Dow structure and percentage-based Grid Zone.
   */
  public getStructure(currentPrice?: number, centerFallback?: number, options?: ChannelOptions): DowStructure {
    const fallbackPrice = currentPrice ?? centerFallback ?? 0.2;
    const candles = options?.useOnlyClosedCandles ? this.candleManager.getClosedCandles() : this.candleManager.getCandles();
    const n = candles.length;
    const lastCandle = n > 0 ? candles[n - 1] : undefined;
    const price = (options?.useOnlyClosedCandles && lastCandle) ? (currentPrice ?? lastCandle.close) : (currentPrice ?? fallbackPrice);
    const k = Math.max(2, this.pivotWindow || 3);
    const mode = options?.mode ?? "DOW_SWINGS";
    const useTrueWick = options?.useTrueWick ?? this.useTrueWick ?? true;
    const wickThreshFraction = options?.wickThresholdPct !== undefined
      ? (options.wickThresholdPct > 1.0 ? options.wickThresholdPct / 100 : options.wickThresholdPct)
      : this.candleManager.getWickThresholdFraction();

    if (
      (options?.useTrueWick !== undefined && options.useTrueWick !== this.useTrueWick) ||
      (options?.wickThresholdPct !== undefined && Math.abs(wickThreshFraction - this.candleManager.getWickThresholdFraction()) > 1e-6)
    ) {
      this.useTrueWick = useTrueWick;
      this.candleManager.setUseTrueWick(useTrueWick);
      this.candleManager.setWickThresholdPct(options?.wickThresholdPct ?? 20.0);
      this.recalculateSwings();
    }

    if (options?.srLookbackCandles !== undefined) {
      this.candleManager.setStructureLookback(options.srLookbackCandles);
    }
    const effAtrPct = options?.atrPct ?? this.getAtrPct() ?? 0.008;

    const confirmedLows = this.swingLows
      .filter((s) => s.index < n)
      .sort((a, b) => a.index - b.index);

    const confirmedHighs = this.swingHighs
      .filter((s) => s.index < n)
      .sort((a, b) => a.index - b.index);

    // 1. Detect candidate points in unconfirmed tail
    const liveCandle = (candles[n - 1] && candles[n - 1].isClosed === false)
      ? candles[n - 1]
      : (this.candleManager.getCandles()[this.candleManager.getCandles().length - 1]?.isClosed === false
          ? this.candleManager.getCandles()[this.candleManager.getCandles().length - 1]
          : undefined);

    const { candidatePeak, candidateValley } = SwingDetector.findCandidatePoints(
      candles,
      k,
      useTrueWick,
      wickThreshFraction,
      options?.useOnlyClosedCandles,
      liveCandle,
    );

    // 2. Wave cycles
    const waveCycle = this.calculateWaveCycles();
    const canonicalLows = waveCycle.annotatedSwings.filter((s) => s.type === "LOW");
    const canonicalHighs = waveCycle.annotatedSwings.filter((s) => s.type === "HIGH");
    const lastCanonicalHigh = canonicalHighs.length > 0 ? canonicalHighs[canonicalHighs.length - 1] : undefined;
    const lastCanonicalLow = canonicalLows.length > 0 ? canonicalLows[canonicalLows.length - 1] : undefined;

    // 3. Channel Bounds
    const {
      upperBound,
      bottomBound,
      activePeak,
      activeValley,
      isSwingConfirmed,
      clampStatus,
      anchorSide,
      rawWidthPct,
      minWidthPct,
      maxWidthPct,
    } = ChannelEngine.calculateBounds(
      candles,
      price,
      confirmedHighs,
      confirmedLows,
      candidatePeak,
      candidateValley,
      options,
      effAtrPct,
      useTrueWick,
      wickThreshFraction,
    );

    // 4. Dow Theory Market Regime
    const regime = DowEngine.determineMarketRegime(this.swingHighs, this.swingLows, isSwingConfirmed);

    // 5. Grid Zone
    const { gridZone, finalSpan, centerPrice, floorBuffer, cutLossBound } = ChannelEngine.buildGridZone(
      upperBound,
      bottomBound,
      price,
      isSwingConfirmed,
      mode,
      clampStatus,
      anchorSide,
      rawWidthPct,
      minWidthPct,
      maxWidthPct,
      options,
    );

    // 6. Trendlines
    const lastHh = waveCycle.lastHh;
    const lastLl = waveCycle.lastLl;
    const {
      downtrendLine,
      uptrendLine,
      downtrendBreakoutConfirmed,
      uptrendBreakdownConfirmed,
    } = this.calculateTrendlines(
      price,
      activeValley,
      activePeak,
      lastHh,
      lastLl,
      waveCycle.annotatedSwings,
      candles,
    );

    // 7. Downtrend Drop Detection
    const hasValidChannel = isSwingConfirmed && bottomBound > 0 && upperBound > 0;
    const { isDowntrendDropActive, downtrendDropLow } = DowEngine.detectDowntrendDrop(
      candles,
      lastCanonicalHigh,
      lastCanonicalLow,
      candidateValley,
      activePeak,
      activeValley,
      bottomBound,
      upperBound,
      finalSpan,
      price,
      hasValidChannel,
      useTrueWick,
      wickThreshFraction,
      downtrendBreakoutConfirmed,
    );

    const lastHigh = this.swingHighs[this.swingHighs.length - 1];
    const lastLow = this.swingLows[this.swingLows.length - 1];

    return {
      upperBound,
      bottomBound,
      cutLossBound,
      floorBuffer,
      floorBufferPct: price > 0 ? (floorBuffer / price) * 100 : 0,
      centerPrice,
      isSwingConfirmed,
      regime,
      gridZone,
      lastSwingHigh: lastHigh,
      lastSwingLow: lastLow,
      activePeak,
      activeValley,
      candidatePeak,
      candidateValley,
      downtrendLine,
      uptrendLine,
      downtrendBreakoutConfirmed,
      uptrendBreakdownConfirmed,
      swingHighs: this.swingHighs,
      swingLows: this.swingLows,
      waveCycle,
      isDowntrendDropActive,
      downtrendDropLow,
    };
  }

  public clearCandles(): void {
    this.candleManager.clearCandles(() => {
      this.swingHighs = [];
      this.swingLows = [];
    });
  }

  public async loadHigherTimeframeCandles(
    symbol: string,
    timeframe: string = "1h",
    restBase: string = "https://api.binance.com",
    log?: (msg: string) => void,
    limit: number = 300,
    clearExisting = true,
  ): Promise<void> {
    await this.candleManager.loadHigherTimeframeCandles(
      symbol,
      timeframe,
      restBase,
      log,
      limit,
      clearExisting,
      () => this.recalculateSwings(),
    );
  }
}
