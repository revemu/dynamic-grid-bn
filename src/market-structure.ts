/**
 * Market structure analysis using Dow Theory principles.
 * Establishes the Channel Grid Zone:
 * - 0% Lower Bound (Support / Floor): Cut Loss / Stop Loss boundary.
 * - 0% to 50% Buy Zone: Stepped accumulation zone.
 * - 50% Center (Midpoint): Neutral equilibrium price.
 * - 50% to 100% Sell Zone: Stepped profit taking zone.
 * - 100% Upper Bound (Resistance / Ceiling): 100% Full Take-Profit exit.
 */

export interface Candle {
  time: number; // Unix timestamp in seconds
  open: number;
  high: number;
  low: number;
  close: number;
  isClosed?: boolean;
}

export type MarketRegime = "RANGE" | "UPTREND" | "DOWNTREND" | "WARMUP";

export interface SwingPoint {
  index: number;
  time: number;
  price: number;
  type: "HIGH" | "LOW";
}

export interface CandidatePoint extends SwingPoint {
  confirmationCandles: number; // 0, 1, 2 candles formed after candidate (confirmed once reaching 3)
  requiredCandles: number;     // 3
  isConfirmed: boolean;
}

export interface GridZone {
  upperBound: number;       // 100% Ceiling (Full Take-Profit)
  bottomBound: number;      // 0% Floor (Structural Base / Valley)
  cutLossBound: number;     // Cut Loss Trigger Floor (0% Floor - Safety Buffer)
  floorBuffer: number;      // Buffer amount ($)
  floorBufferPct: number;   // Buffer %
  centerPrice: number;      // 50% Neutral Center
  positionPct: number;      // Price position in channel: 0% to 100%
  zoneType: "BUY_ZONE" | "SELL_ZONE" | "BELOW_FLOOR_CUTLOSS" | "ABOVE_CEILING_FULL_EXIT";
  buyLevels: number[];      // Grid levels in 0%..50% zone (e.g. 10%, 20%, 30%, 40%)
  sellLevels: number[];     // Target levels in 50%..100% zone (e.g. 60%, 70%, 80%, 90%)
  isBelowFloor: boolean;    // Price < cutLossBound (Trigger cut loss)
  isAboveCeiling: boolean;  // Price >= 100% (Trigger 100% take profit)
  zoneWidthPct: number;     // Width of channel in percentage
  channelMode?: string;     // Mode: "DOW_SWINGS" | "DOW_ATR_CLAMP" | "FIXED_PCT_CLAMP" | "DONCHIAN_ATR"
  clampStatus?: "NATURAL_SWING" | "CLAMPED_MIN" | "CLAMPED_MAX";
  rawWidthPct?: number;     // Unclamped swing width in %
  minWidthPct?: number;     // Minimum width % limit
  maxWidthPct?: number;     // Maximum width % limit
  anchorSide?: "LOWER_FLOOR" | "UPPER_CEILING" | "NONE";
}

export interface TrendLinePoint {
  time: number;
  value: number;
}

export interface TrendLine {
  type: "DOWNTREND" | "UPTREND";
  p1: SwingPoint;
  p2: SwingPoint;
  slope: number; // price per second
  currentLinePrice: number; // projected price at current candle time
  isBroken: boolean; // true if breakout is confirmed (>= 2 candles)
  breakoutPct: number; // % above or below the trendline
  brokenCandleCount: number; // number of consecutive candles breaking the line
  breakoutConfirmed: boolean; // true if brokenCandleCount >= 2
  points: TrendLinePoint[]; // all points for chart rendering
}

export type DowLabel = "HH" | "LH" | "HL" | "LL";

export interface DowSwingPoint extends SwingPoint {
  dowLabel: DowLabel;
  isTransitionStart: boolean;
  transitionType?: "START_HL" | "START_LH" | "START_HH" | "START_LL";
  prevPrice?: number;
  changePct?: number;
  labelDescription?: string;
}

export interface WaveLeg {
  from: SwingPoint;
  to: SwingPoint;
  direction: "UP" | "DOWN";
  changePct: number;
  barCount: number;
  durationSec: number;
  description: string;
}

export interface WaveCycleData {
  legs: WaveLeg[];
  currentLeg?: WaveLeg;
  wavePoints: TrendLinePoint[];
  annotatedSwings: DowSwingPoint[];
  lastHh?: DowSwingPoint;
  lastHl?: DowSwingPoint;
  lastLh?: DowSwingPoint;
  lastLl?: DowSwingPoint;
  activeCycleSummary?: string;
}

export interface DowStructure {
  upperBound: number;
  bottomBound: number;
  cutLossBound: number;
  floorBuffer: number;
  floorBufferPct: number;
  centerPrice: number;
  isSwingConfirmed: boolean;
  regime: MarketRegime;
  gridZone: GridZone;
  lastSwingHigh?: SwingPoint;
  lastSwingLow?: SwingPoint;
  activePeak?: SwingPoint;
  activeValley?: SwingPoint;
  candidatePeak?: CandidatePoint;
  candidateValley?: CandidatePoint;
  downtrendLine?: TrendLine;
  uptrendLine?: TrendLine;
  downtrendBreakoutConfirmed?: boolean;
  uptrendBreakdownConfirmed?: boolean;
  swingHighs: SwingPoint[];
  swingLows: SwingPoint[];
  waveCycle?: WaveCycleData;
  isDowntrendDropActive?: boolean;
  downtrendDropLow?: number;
}

export interface ChannelOptions {
  mode?: "DOW_SWINGS" | "DOW_ATR_CLAMP" | "FIXED_PCT_CLAMP" | "DONCHIAN_ATR";
  minChannelWidthPct?: number; // for DOW_SWINGS & FIXED_PCT_CLAMP (e.g. 1.8%)
  maxChannelWidthPct?: number; // for DOW_SWINGS & FIXED_PCT_CLAMP (e.g. 4.0%)
  atrMinMultiplier?: number;   // for DOW_ATR_CLAMP (default 2.5x ATR)
  atrMaxMultiplier?: number;   // for DOW_ATR_CLAMP (default 5.0x ATR)
  donchianLookback?: number;   // for DONCHIAN_ATR (default 20 bars)
  floorBufferPct?: number;     // safety buffer below floor (e.g. 0.15%)
  atrPct?: number;             // external ATR % if available
  useTrueWick?: boolean;       // use true candle wick instead of body clipping (default true)
  wickThresholdPct?: number;   // rejection wick % threshold before clipping to candle body (default 20.0%)
  srLookbackCandles?: number;  // candles lookback for swing scanning (default 100)
  enableNarrowChannelCollapse?: boolean; // collapse to edge brackets in narrow channels (default true)
  narrowChannelThresholdPct?: number;   // narrow channel threshold % (default 1.2%)
  narrowChannelBuyBufferPct?: number;   // buffer % above floor for buy edge (default 0.05%)
  narrowChannelSellBufferPct?: number;  // buffer % below ceiling for sell edge (default 0.05%)
  buyLevelPcts?: number[];              // percentage allocations for buy levels (default [42, 32, 22, 12, 2])
  sellLevelPcts?: number[];             // percentage allocations for sell levels (default [52, 62, 72, 82, 92])
  useOnlyClosedCandles?: boolean;       // calculate structure and channel bounds strictly on closed candles
}

/**
 * Calculate effective high price of a candle (for peak / upper bound).
 * If useTrueWick is true, returns actual c.high.
 * Otherwise, if upper wick is > wickThresholdPct (e.g. 20%) of candle range, snaps to upper body.
 */
export function getEffectiveHigh(c: Candle, useTrueWick = true, wickThresholdPct = 0.20): number {
  if (useTrueWick) return c.high;
  const range = c.high - c.low;
  if (range <= 0) return c.high;
  const upperBody = Math.max(c.open, c.close);
  const upperWick = c.high - upperBody;
  if (upperWick / range > wickThresholdPct) {
    return upperBody;
  }
  return c.high;
}

/**
 * Calculate effective low price of a candle (for valley / floor / lower bound).
 * If useTrueWick is true, returns actual c.low (preventing false floor cut loss).
 * Otherwise, if lower wick is > wickThresholdPct (e.g. 20%) of candle range, snaps to lower body.
 */
export function getEffectiveLow(c: Candle, useTrueWick = true, wickThresholdPct = 0.20): number {
  if (useTrueWick) return c.low;
  const range = c.high - c.low;
  if (range <= 0) return c.low;
  const lowerBody = Math.min(c.open, c.close);
  const lowerWick = lowerBody - c.low;
  if (lowerWick / range > wickThresholdPct) {
    return lowerBody;
  }
  return c.low;
}

export class DowStructureEngine {
  private candles: Candle[] = [];
  private swingHighs: SwingPoint[] = [];
  private swingLows: SwingPoint[] = [];
  private maxCandles = 600;
  /** Shared lookback window (bars) for Peak/Valley wave cycles, trendlines and S/R clustering. Synced from srLookbackCandles. */
  private structureLookback = 120;
  private wickThresholdPct: number = 0.20;

  constructor(
    private pivotWindow: number = 3,
    private useTrueWick: boolean = true,
    wickThresholdPct: number = 20.0,
    maxCandles: number = 600,
  ) {
    this.wickThresholdPct = (wickThresholdPct ?? 20.0) / 100;
    this.maxCandles = Math.max(50, maxCandles ?? 600);
  }

  public setMaxCandles(val: number): void {
    const k = Math.max(50, Math.round(val));
    if (this.maxCandles !== k) {
      this.maxCandles = k;
      if (this.candles.length > this.maxCandles) {
        this.candles.splice(0, this.candles.length - this.maxCandles);
        this.recalculateSwings();
      }
    }
  }

  public getMaxCandles(): number {
    return this.maxCandles;
  }

  public setPivotWindow(val: number): void {
    const k = Math.max(2, Math.round(val));
    if (this.pivotWindow !== k) {
      this.pivotWindow = k;
      this.recalculateSwings();
    }
  }

  public getPivotWindow(): number {
    return this.pivotWindow;
  }

  public setUseTrueWick(val: boolean): void {
    if (this.useTrueWick !== val) {
      this.useTrueWick = val;
      this.recalculateSwings();
    }
  }

  public getUseTrueWick(): boolean {
    return this.useTrueWick;
  }

  public setWickThresholdPct(val: number): void {
    const fraction = val > 1.0 ? val / 100 : val;
    if (this.wickThresholdPct !== fraction) {
      this.wickThresholdPct = fraction;
      this.recalculateSwings();
    }
  }

  public getWickThresholdPct(): number {
    return this.wickThresholdPct * 100;
  }

  addCandle(candle: Candle): void {
    if (!candle || typeof candle.time !== "number" || !Number.isFinite(candle.close)) return;

    const idx = this.candles.findIndex((c) => c.time === candle.time);
    if (idx >= 0) {
      this.candles[idx] = candle;
    } else {
      if (this.candles.length > 0) {
        this.candles[this.candles.length - 1].isClosed = true;
      }
      this.candles.push(candle);
      this.candles.sort((a, b) => a.time - b.time);
    }

    if (this.candles.length > this.maxCandles) {
      this.candles.splice(0, this.candles.length - this.maxCandles);
    }

    this.recalculateSwings();
  }

  getCandles(): Candle[] {
    return this.candles;
  }

  getClosedCandles(): Candle[] {
    if (this.candles.length === 0) return [];
    const last = this.candles[this.candles.length - 1];
    if (last.isClosed === true) {
      return this.candles;
    }
    return this.candles.slice(0, -1);
  }

  getLastClosedCandle(): Candle | undefined {
    const closed = this.getClosedCandles();
    return closed.length > 0 ? closed[closed.length - 1] : undefined;
  }

  getSwingLows(): SwingPoint[] {
    return this.swingLows;
  }

  getSwingHighs(): SwingPoint[] {
    return this.swingHighs;
  }

  /**
   * Check if a valid Dow Theory Higher Low (HL) has formed after a floor breakdown.
   *
   * @param sinceTime Timestamp (seconds) of the breakdown event
   * @param referenceFloor The floor price that was broken
   * @param lowestDumpPrice The lowest price reached during/after breakdown
   * @param currentPrice Current live mid price
   */
  checkForHigherLow(
    sinceTime: number,
    referenceFloor: number,
    lowestDumpPrice: number,
    currentPrice?: number,
  ): { confirmed: boolean; higherLow?: SwingPoint; reason?: string } {
    if (this.swingLows.length === 0) {
      return { confirmed: false, reason: "No confirmed swing lows in memory" };
    }

    // Find the actual timestamp of the lowest dump trough in candles so a pre-dump swing is never mistaken for a post-dump HL
    let effectiveSinceTime = sinceTime;
    for (const c of this.candles) {
      const effLow = getEffectiveLow(c, this.useTrueWick, this.wickThresholdPct);
      if (c.time >= sinceTime - 3600 && (c.low <= lowestDumpPrice * 1.0005 || effLow <= lowestDumpPrice * 1.0005)) {
        if (c.time > effectiveSinceTime) {
          effectiveSinceTime = c.time;
        }
      }
    }

    // Helper: A swing low is only valid as a Higher Low if no subsequent candle has broken below it
    const isSwingLowUnbroken = (s: SwingPoint): boolean =>
      !this.candles.some(
        (c) => c.time > s.time && getEffectiveLow(c, this.useTrueWick, this.wickThresholdPct) < s.price,
      );

    // 1. Check annotated structural wave swings (if the wave cycle already labeled a confirmed unbroken "HL" after the lowest dump)
    const wave = this.calculateWaveCycles();
    if (wave && wave.annotatedSwings.length > 0) {
      const postDumpSwings = wave.annotatedSwings.filter(
        (s) =>
          s.type === "LOW" &&
          s.dowLabel === "HL" &&
          s.time >= effectiveSinceTime &&
          s.price > lowestDumpPrice * 1.0005 &&
          isSwingLowUnbroken(s),
      );
      if (postDumpSwings.length > 0) {
        const lastHl = postDumpSwings[postDumpSwings.length - 1]!;
        if (!currentPrice || currentPrice >= lastHl.price * 0.999) {
          return {
            confirmed: true,
            higherLow: lastHl,
            reason: `Structural Wave labeled ${lastHl.dowLabel} at $${lastHl.price.toFixed(6)} > lowest dump $${lowestDumpPrice.toFixed(6)}`,
          };
        }
      }
    }

    // 2. Check confirmed unbroken swing lows formed strictly at/after the dump trough
    const recentConfirmedLows = this.swingLows.filter(
      (s) => s.time >= effectiveSinceTime && isSwingLowUnbroken(s),
    );

    if (recentConfirmedLows.length === 0) {
      return { confirmed: false, reason: "Waiting for confirmed unbroken swing low pivot after dump trough" };
    }

    for (let i = recentConfirmedLows.length - 1; i >= 0; i--) {
      const candidateLow = recentConfirmedLows[i];
      if (!candidateLow) continue;

      const isHigherThanDump = candidateLow.price > lowestDumpPrice * 1.0005;
      const priorLow = this.swingLows.find((s) => s.index < candidateLow.index && s.price < candidateLow.price);
      const isHigherThanPriorLow = Boolean(priorLow);
      const isPriceHoldingAbove = currentPrice ? currentPrice >= candidateLow.price : true;

      if (isHigherThanDump && (isHigherThanPriorLow || candidateLow.price >= referenceFloor) && isPriceHoldingAbove) {
        return {
          confirmed: true,
          higherLow: candidateLow,
          reason: `Confirmed Higher Low at $${candidateLow.price.toFixed(6)} > Lowest $${lowestDumpPrice.toFixed(6)}`,
        };
      }
    }

    return { confirmed: false, reason: "Recent swing lows are not higher than the dump trough" };
  }

  private recalculateSwings(): void {
    const n = this.candles.length;
    const k = Math.max(2, this.pivotWindow || 3);
    // Need at least k preceding closed bars + pivot bar + k following closed bars + 1 live bar
    if (n < k * 2 + 2) return;

    this.swingHighs = [];
    this.swingLows = [];

    // Scan for true structural swing pivots with k-bar window
    // Candle n - 1 is the currently open/live candle; fully closed candles are 0 .. n - 2.
    // For candle i to have k closed candles strictly AFTER it, i + k <= n - 2 => i <= n - 2 - k.
    const maxConfirmedIdx = n - 2 - k;

    for (let i = k; i <= maxConfirmedIdx; i++) {
      const c = this.candles[i];
      if (!c) continue;

      const cEffHigh = getEffectiveHigh(c, this.useTrueWick, this.wickThresholdPct);
      const cEffLow = getEffectiveLow(c, this.useTrueWick, this.wickThresholdPct);

      let isHigh = true;
      let isLow = true;

      // Check left side (k preceding closed candles: i - k .. i - 1)
      for (let j = i - k; j < i; j++) {
        const other = this.candles[j];
        if (!other) continue;
        if (getEffectiveHigh(other, this.useTrueWick, this.wickThresholdPct) > cEffHigh) isHigh = false;
        if (getEffectiveLow(other, this.useTrueWick, this.wickThresholdPct) < cEffLow) isLow = false;
      }

      // Check right side (strictly k following CLOSED candles: i + 1 .. i + k <= n - 2)
      if (isHigh || isLow) {
        for (let j = i + 1; j <= i + k; j++) {
          const other = this.candles[j];
          if (!other) continue;
          if (getEffectiveHigh(other, this.useTrueWick, this.wickThresholdPct) >= cEffHigh) isHigh = false;
          if (getEffectiveLow(other, this.useTrueWick, this.wickThresholdPct) <= cEffLow) isLow = false;
        }
      }

      // 🔒 Outside-Bar Dedup: a single candle can NEVER be both a swing peak and a swing valley.
      // If an engulfing/outside bar qualifies on both sides, keep only the side matching its close direction:
      // bearish close (close < open) -> valley (LOW), bullish close -> peak (HIGH).
      if (isHigh && isLow) {
        if (c.close < c.open) {
          isHigh = false;
        } else {
          isLow = false;
        }
      }

      if (isHigh) {
        this.swingHighs.push({
          index: i,
          time: c.time,
          price: cEffHigh,
          type: "HIGH",
        });
      }
      if (isLow) {
        this.swingLows.push({
          index: i,
          time: c.time,
          price: cEffLow,
          type: "LOW",
        });
      }
    }
  }

  calculateTrendlines(
    currentPrice: number,
    activeValley?: SwingPoint,
    activePeak?: SwingPoint,
    lastHh?: SwingPoint,
    lastLl?: SwingPoint,
    annotatedSwings?: DowSwingPoint[],
  ): {
    downtrendLine?: TrendLine;
    uptrendLine?: TrendLine;
    downtrendBreakoutConfirmed?: boolean;
    uptrendBreakdownConfirmed?: boolean;
  } {
    const n = this.candles.length;
    if (n < 4) return {};

    // Look within the same structural history window as Peak/Valley & S/R (srLookbackCandles)
    const lookback = Math.min(n, this.structureLookback);
    const minIndex = Math.max(0, n - lookback);

    const confirmedHighs = this.swingHighs.filter((s) => s.index >= minIndex).sort((a, b) => a.index - b.index);
    const confirmedLows = this.swingLows.filter((s) => s.index >= minIndex).sort((a, b) => a.index - b.index);

    let downtrendLine: TrendLine | undefined;
    let uptrendLine: TrendLine | undefined;
    let downtrendBreakoutConfirmed = false;
    let uptrendBreakdownConfirmed = false;

    const latestCandle = this.candles[n - 1];
    const latestTime = latestCandle?.time ?? 0;

    // ── 1. Downtrend Resistance Line: Supports 2+ confirmed swing highs (P1 -> LH) with candle touch scoring ──
    if (confirmedHighs.length >= 2) {
      // Candidate P1 anchors: top 3 highest swings in the lookback window + activePeak/lastHh
      const sortedByPriceDesc = [...confirmedHighs].sort((a, b) => b.price - a.price);
      const p1Candidates = sortedByPriceDesc.slice(0, 4);

      let bestP1: SwingPoint | undefined;
      let bestP2: SwingPoint | undefined;
      let bestSlope = -Infinity;
      let bestScore = -Infinity;

      for (const p1 of p1Candidates) {
        const candidateSubHighs = confirmedHighs.filter(
          (h) => h.index > p1.index && h.price < p1.price && h.time > p1.time
        );

        for (const p2 of candidateSubHighs) {
          const timeDiff = p2.time - p1.time;
          if (timeDiff <= 0) continue;
          const priceDiff = p2.price - p1.price;
          const slope = priceDiff / timeDiff;
          if (slope >= 0) continue; // Strictly descending

          // Sanity check slope: between 0.015%/hr and 2.5%/hr
          const pctPerHour = Math.abs((slope * 3600) / p1.price) * 100;
          if (pctPerHour < 0.015 || pctPerHour > 2.5) continue;

          const currentLinePrice = p1.price + slope * (latestTime - p1.time);
          if (currentLinePrice <= 0) continue;

          let violates = false;
          let swingTouches = 0;

          for (const midHigh of candidateSubHighs) {
            const lineVal = p1.price + slope * (midHigh.time - p1.time);
            // Any subsequent swing high exceeding the line by > 0.12% violates the outer envelope
            if (midHigh.price > lineVal * 1.0012) {
              violates = true;
              break;
            }
            if (Math.abs(midHigh.price - lineVal) / lineVal <= 0.0035) {
              swingTouches++;
            }
          }
          if (violates) continue;

          // Count candle touches & check breakout status from p2 onwards
          let candleTouches = 0;
          let postP2BrokenCandles = 0;
          let consecutiveBroken = 0;
          let maxConsecutiveBroken = 0;

          for (let i = p1.index; i < n; i++) {
            const c = this.candles[i];
            if (!c) continue;
            const lineVal = p1.price + slope * (c.time - p1.time);
            // Before p2, no candle close should deeply violate the line (> 0.20%)
            if (i <= p2.index && c.close > lineVal * 1.002) {
              violates = true;
              break;
            }
            if (c.high >= lineVal * 0.997 && c.close <= lineVal * 1.0015) {
              candleTouches++;
            }
            if (i > p2.index) {
              const testPrice = i === n - 1 ? Math.max(currentPrice, c.close) : c.close;
              if (testPrice > lineVal * 1.0005) {
                postP2BrokenCandles++;
                consecutiveBroken++;
                if (consecutiveBroken > maxConsecutiveBroken) maxConsecutiveBroken = consecutiveBroken;
              } else {
                consecutiveBroken = 0;
              }
            }
          }
          if (violates) continue;

          const isUnbroken = maxConsecutiveBroken < 2 && postP2BrokenCandles < 2;
          // Prioritize unbroken active lines, more swing touches, candle touches, and recency
          const score =
            (isUnbroken ? 1000 : 0) +
            swingTouches * 120 +
            Math.min(candleTouches, 8) * 25 +
            (p2.index / Math.max(1, n)) * 80;

          if (score > bestScore) {
            bestScore = score;
            bestP1 = p1;
            bestP2 = p2;
            bestSlope = slope;
          }
        }
      }

      if (bestP1 && bestP2 && Number.isFinite(bestSlope) && bestSlope < 0) {
        const currentLinePrice = bestP1.price + bestSlope * (latestTime - bestP1.time);
        if (currentLinePrice > 0) {
          const points: TrendLinePoint[] = [];
          for (let cIdx = bestP1.index; cIdx < n; cIdx++) {
            const c = this.candles[cIdx];
            if (!c) continue;
            const val = bestP1.price + bestSlope * (c.time - bestP1.time);
            points.push({ time: c.time, value: Number(val.toFixed(6)) });
          }

          let totalBrokenCandles = 0;
          let consecutiveBrokenCandles = 0;
          let maxConsecutiveBroken = 0;

          for (let i = bestP2.index + 1; i < n; i++) {
            const c = this.candles[i];
            if (!c) continue;
            const lineVal = bestP1.price + bestSlope * (c.time - bestP1.time);
            const testPrice = i === n - 1 ? Math.max(currentPrice, c.close) : c.close;
            if (testPrice > lineVal * 1.0005) {
              totalBrokenCandles++;
              consecutiveBrokenCandles++;
              if (consecutiveBrokenCandles > maxConsecutiveBroken) {
                maxConsecutiveBroken = consecutiveBrokenCandles;
              }
            } else {
              consecutiveBrokenCandles = 0;
            }
          }

          const latestCandleTestPrice = Math.max(currentPrice, this.candles[n - 1]?.close ?? currentPrice);
          const isCurrentlyAbove = latestCandleTestPrice > currentLinePrice * 1.0005;
          const breakoutConfirmed = maxConsecutiveBroken >= 2 || totalBrokenCandles >= 2;

          if (breakoutConfirmed) {
            downtrendBreakoutConfirmed = true;
            downtrendLine = undefined;
          } else {
            downtrendLine = {
              type: "DOWNTREND",
              p1: bestP1,
              p2: bestP2,
              slope: bestSlope,
              currentLinePrice,
              isBroken: isCurrentlyAbove || totalBrokenCandles > 0,
              breakoutPct: ((currentPrice - currentLinePrice) / currentLinePrice) * 100,
              brokenCandleCount: totalBrokenCandles,
              breakoutConfirmed: false,
              points,
            };
          }
        }
      }
    }

    // ── 2. Uptrend Support Line: Supports 2+ confirmed swing lows (V1 -> HL) with candle touch scoring ──
    if (confirmedLows.length >= 2) {
      // Candidate V1 anchors: lowest swings in the lookback window + recent major valleys
      const sortedByPriceAsc = [...confirmedLows].sort((a, b) => a.price - b.price);
      const recentLows = confirmedLows.slice(-6);
      const v1Map = new Map<number, SwingPoint>();
      for (const l of [...sortedByPriceAsc.slice(0, 4), ...recentLows]) {
        v1Map.set(l.index, l);
      }
      const v1Candidates = Array.from(v1Map.values()).sort((a, b) => a.index - b.index);

      let bestV1: SwingPoint | undefined;
      let bestV2: SwingPoint | undefined;
      let bestSlope = Infinity;
      let bestScore = -Infinity;

      for (const v1 of v1Candidates) {
        const candidateSubLows = confirmedLows.filter(
          (l) => l.index > v1.index && l.price > v1.price && l.time > v1.time
        );

        for (const v2 of candidateSubLows) {
          const timeDiff = v2.time - v1.time;
          if (timeDiff <= 0) continue;
          const priceDiff = v2.price - v1.price;
          const slope = priceDiff / timeDiff;
          if (slope <= 0) continue; // Strictly ascending

          // Sanity check slope: between 0.015%/hr and 2.5%/hr
          const pctPerHour = ((slope * 3600) / v1.price) * 100;
          if (pctPerHour < 0.015 || pctPerHour > 2.5) continue;

          const currentLinePrice = v1.price + slope * (latestTime - v1.time);
          if (currentLinePrice <= 0) continue;

          let violates = false;
          let swingTouches = 0;

          for (const midLow of candidateSubLows) {
            const lineVal = v1.price + slope * (midLow.time - v1.time);
            // Any subsequent confirmed swing low breaking below the line by > 0.12% violates the support envelope
            if (midLow.price < lineVal * 0.9988) {
              violates = true;
              break;
            }
            if (Math.abs(midLow.price - lineVal) / lineVal <= 0.0035) {
              swingTouches++;
            }
          }
          if (violates) continue;

          // Count candle touches & check breakdown status
          let candleTouches = 0;
          let postV2BrokenCandles = 0;
          let consecutiveBroken = 0;
          let maxConsecutiveBroken = 0;

          for (let i = v1.index; i < n; i++) {
            const c = this.candles[i];
            if (!c) continue;
            const lineVal = v1.price + slope * (c.time - v1.time);
            // Allow minor intra-bar wick pierces if candle closes above line, but reject deep close violations before v2
            if (i <= v2.index && c.close < lineVal * 0.998) {
              violates = true;
              break;
            }
            if (c.low <= lineVal * 1.003 && c.close >= lineVal * 0.9985) {
              candleTouches++;
            }
            if (i > v2.index) {
              const testPrice = i === n - 1 ? Math.min(currentPrice, c.close) : c.close;
              if (testPrice < lineVal * 0.9995) {
                postV2BrokenCandles++;
                consecutiveBroken++;
                if (consecutiveBroken > maxConsecutiveBroken) maxConsecutiveBroken = consecutiveBroken;
              } else {
                consecutiveBroken = 0;
              }
            }
          }
          if (violates) continue;

          const isUnbroken = maxConsecutiveBroken < 2 && postV2BrokenCandles < 2 && currentPrice >= currentLinePrice * 0.998;
          // Prioritize unbroken active lines, recent active wave (v2 recency), swing touches, and candle touches
          const score =
            (isUnbroken ? 1000 : 0) +
            swingTouches * 120 +
            Math.min(candleTouches, 8) * 30 +
            (v2.index / Math.max(1, n)) * 150 +
            (v1.index / Math.max(1, n)) * 80;

          if (score > bestScore) {
            bestScore = score;
            bestV1 = v1;
            bestV2 = v2;
            bestSlope = slope;
          }
        }
      }

      if (bestV1 && bestV2 && Number.isFinite(bestSlope) && bestSlope > 0) {
        const currentLinePrice = bestV1.price + bestSlope * (latestTime - bestV1.time);
        if (currentLinePrice > 0) {
          const points: TrendLinePoint[] = [];
          for (let cIdx = bestV1.index; cIdx < n; cIdx++) {
            const c = this.candles[cIdx];
            if (!c) continue;
            const val = bestV1.price + bestSlope * (c.time - bestV1.time);
            points.push({ time: c.time, value: Number(val.toFixed(6)) });
          }

          let totalBrokenCandles = 0;
          let consecutiveBrokenCandles = 0;
          let maxConsecutiveBroken = 0;

          for (let i = bestV2.index + 1; i < n; i++) {
            const c = this.candles[i];
            if (!c) continue;
            const lineVal = bestV1.price + bestSlope * (c.time - bestV1.time);
            const testPrice = i === n - 1 ? Math.min(currentPrice, c.close) : c.close;
            if (testPrice < lineVal * 0.9995) {
              totalBrokenCandles++;
              consecutiveBrokenCandles++;
              if (consecutiveBrokenCandles > maxConsecutiveBroken) {
                maxConsecutiveBroken = consecutiveBrokenCandles;
              }
            } else {
              consecutiveBrokenCandles = 0;
            }
          }

          const latestCandleTestPrice = Math.min(currentPrice, this.candles[n - 1]?.close ?? currentPrice);
          const isCurrentlyBelow = latestCandleTestPrice < currentLinePrice * 0.9995;
          const breakoutConfirmed = maxConsecutiveBroken >= 2 || totalBrokenCandles >= 2;

          if (breakoutConfirmed) {
            uptrendBreakdownConfirmed = true;
            uptrendLine = undefined;
          } else {
            uptrendLine = {
              type: "UPTREND",
              p1: bestV1,
              p2: bestV2,
              slope: bestSlope,
              currentLinePrice,
              isBroken: isCurrentlyBelow || totalBrokenCandles > 0,
              breakoutPct: ((currentLinePrice - currentPrice) / currentLinePrice) * 100,
              brokenCandleCount: totalBrokenCandles,
              breakoutConfirmed: false,
              points,
            };
          }
        }
      }
    }

    return {
      downtrendLine,
      uptrendLine,
      downtrendBreakoutConfirmed,
      uptrendBreakdownConfirmed,
    };
  }

  /**
   * Calculate Dow Theory Wave Cycles and annotate swings (HH, LH, HL, LL),
   * identifying structural trend transitions (จุดที่เริ่มทำ HL, HH, LH, LL).
   */
  public calculateWaveCycles(activeValley?: SwingPoint, activePeak?: SwingPoint): WaveCycleData {
    const n = this.candles.length;
    if (n < 4) {
      return {
        legs: [],
        wavePoints: [],
        annotatedSwings: [],
      };
    }

    const lookback = Math.min(n, this.structureLookback);
    const minIndex = Math.max(0, n - lookback);

    // Collect all confirmed swings within the lookback window, strictly ordered by time
    const rawSwings: SwingPoint[] = [
      ...this.swingHighs.filter((s) => s.index >= minIndex),
      ...this.swingLows.filter((s) => s.index >= minIndex),
    ].sort((a, b) => a.time - b.time);

    if (rawSwings.length === 0) {
      return {
        legs: [],
        wavePoints: [],
        annotatedSwings: [],
      };
    }

    // 1. Filter into canonical alternating ZigZag swings (Peak -> Valley -> Peak -> Valley...)
    const alternatingSwings: SwingPoint[] = [];
    for (const s of rawSwings) {
      if (alternatingSwings.length === 0) {
        alternatingSwings.push({ ...s });
        continue;
      }
      const prev = alternatingSwings[alternatingSwings.length - 1];
      if (!prev) {
        alternatingSwings.push({ ...s });
        continue;
      }
      if (s.type === prev.type) {
        if (s.type === "HIGH" && s.price >= prev.price) {
          alternatingSwings[alternatingSwings.length - 1] = { ...s };
        } else if (s.type === "LOW" && s.price <= prev.price) {
          alternatingSwings[alternatingSwings.length - 1] = { ...s };
        }
      } else {
        alternatingSwings.push({ ...s });
      }
    }

    // 2. Annotate each swing with Dow Theory structure (HH, LH, HL, LL)
    // and identify transition starts (จุดที่เริ่มทำ HL, HH, LH, LL)
    const annotatedSwings: DowSwingPoint[] = [];
    let lastHigh: SwingPoint | undefined;
    let lastLow: SwingPoint | undefined;
    let lastHighLabel: DowLabel | undefined;
    let lastLowLabel: DowLabel | undefined;

    let lastHh: DowSwingPoint | undefined;
    let lastHl: DowSwingPoint | undefined;
    let lastLh: DowSwingPoint | undefined;
    let lastLl: DowSwingPoint | undefined;

    for (const s of alternatingSwings) {
      if (s.type === "HIGH") {
        let dowLabel: DowLabel = "HH";
        let isTransitionStart = false;
        let transitionType: DowSwingPoint["transitionType"];
        let changePct: number | undefined;

        if (!lastHigh) {
          dowLabel = "HH";
          lastHighLabel = "HH";
        } else {
          changePct = ((s.price - lastHigh.price) / lastHigh.price) * 100;
          if (s.price > lastHigh.price) {
            dowLabel = "HH";
            if (lastHighLabel === "LH") {
              isTransitionStart = true;
              transitionType = "START_HH";
            }
            lastHighLabel = "HH";
          } else {
            dowLabel = "LH";
            if (lastHighLabel === "HH") {
              isTransitionStart = true;
              transitionType = "START_LH";
            }
            lastHighLabel = "LH";
          }
        }

        const annotated: DowSwingPoint = {
          ...s,
          dowLabel,
          isTransitionStart,
          transitionType,
          prevPrice: lastHigh?.price,
          changePct,
          labelDescription: isTransitionStart
            ? (transitionType === "START_HH" ? "เริ่มทำ Higher High (HH)" : "เริ่มทำ Lower High (LH)")
            : (dowLabel === "HH" ? "Higher High (HH)" : "Lower High (LH)"),
        };

        if (dowLabel === "HH") lastHh = annotated;
        else lastLh = annotated;

        lastHigh = s;
        annotatedSwings.push(annotated);
      } else {
        let dowLabel: DowLabel = "LL";
        let isTransitionStart = false;
        let transitionType: DowSwingPoint["transitionType"];
        let changePct: number | undefined;

        // ค้นหาจุดต่ำสุดของสวิงโลว์ที่ยืนยันแล้ว (alternatingSwings) ก่อนหน้านับตั้งแต่ยอด High ล่าสุด (lastHigh)
        // หากอยู่ในช่วงขาลงหลังจากยอด High (s.time > lastHigh.time):
        // เหวที่ยืนยันแล้วซึ่งเกิดขึ้นระหว่างรอบทุบ หากราคาต่ำกว่าเหวยืนยันก่อนหน้า ต้องเป็น LL เสมอ!
        const priorLowsInDownwave = annotatedSwings.filter(
          (l) => l.type === "LOW" && lastHigh && l.time > lastHigh.time && l.time < s.time
        );
        const hasHigherPriorLowInWave = priorLowsInDownwave.some((l) => l.price > s.price);

        if (!lastLow) {
          dowLabel = "LL";
          lastLowLabel = "LL";
        } else {
          changePct = ((s.price - lastLow.price) / lastLow.price) * 100;
          // ถ้ามีเหวก่อนหน้าในรอบทุบนี้ที่สูงกว่าจุดนี้ แปลว่าจุดนี้รูดลงมาทำนิวโลว์ -> ต้องเป็น LL!
          if (hasHigherPriorLowInWave) {
            dowLabel = "LL";
            if (lastLowLabel === "HL") {
              isTransitionStart = true;
              transitionType = "START_LL";
            }
            lastLowLabel = "LL";
          } else if (s.price > lastLow.price) {
            dowLabel = "HL";
            if (lastLowLabel === "LL") {
              isTransitionStart = true;
              transitionType = "START_HL";
            }
            lastLowLabel = "HL";
          } else {
            dowLabel = "LL";
            if (lastLowLabel === "HL") {
              isTransitionStart = true;
              transitionType = "START_LL";
            }
            lastLowLabel = "LL";
          }
        }

        const annotated: DowSwingPoint = {
          ...s,
          dowLabel,
          isTransitionStart,
          transitionType,
          prevPrice: lastLow?.price,
          changePct,
          labelDescription: isTransitionStart
            ? (transitionType === "START_HL" ? "เริ่มทำ Higher Low (HL) ยกฐานกลับตัว" : "เริ่มทำ Lower Low (LL) หลุดฐาน")
            : (dowLabel === "HL" ? "Higher Low (HL) ยกฐาน" : "Lower Low (LL) หลุดฐาน"),
        };

        if (dowLabel === "HL") lastHl = annotated;
        else lastLl = annotated;

        lastLow = s;
        annotatedSwings.push(annotated);
      }
    }

    // 2.1 Invalidate False HLs: หากมีจุดสวิง Low ใดที่เคยถูกมองว่าเป็น HL ชั่วคราว
    // แต่ในเวลาต่อมามีสวิง Low ถัดมา (หรือสวิง Low ในรอบทุบ) ที่กดตัวต่ำกว่ามัน (New Low ต่ำกว่า HL นั้น)
    // โครงสร้าง Higher Low นั้นถือว่าถูกทำลาย (Broken/Invalidated) ทันที -> ต้องเปลี่ยนป้ายเป็น LL
    for (let i = 0; i < annotatedSwings.length; i++) {
      const sw = annotatedSwings[i]!;
      if (sw.type === "LOW" && sw.dowLabel === "HL") {
        // ค้นหาว่ามี Low ใดในอนาคตหลังจากจุดนี้ ที่ราคาต่ำกว่ามันหรือไม่
        const futureLows = annotatedSwings.slice(i + 1).filter((next) => next.type === "LOW");
        const brokenByFutureLow = futureLows.some((next) => next.price < sw.price);
        if (brokenByFutureLow) {
          sw.dowLabel = "LL";
          sw.labelDescription = "Lower Low (LL) หลุดฐาน";
          sw.isTransitionStart = false;
          sw.transitionType = undefined;
        }
      }
    }

    // Re-evaluate lastHl / lastLl after invalidation
    lastHl = undefined;
    lastLl = undefined;
    for (const sw of annotatedSwings) {
      if (sw.type === "LOW") {
        if (sw.dowLabel === "HL") lastHl = sw;
        else if (sw.dowLabel === "LL") lastLl = sw;
      }
    }
    lastLowLabel = annotatedSwings.filter((s) => s.type === "LOW").pop()?.dowLabel ?? "LL";

    // 3. Build wave legs and interpolated continuous wave points
    const legs: WaveLeg[] = [];
    const wavePoints: TrendLinePoint[] = [];

    for (let i = 1; i < annotatedSwings.length; i++) {
      const from = annotatedSwings[i - 1];
      const to = annotatedSwings[i];
      if (!from || !to) continue;

      const direction: "UP" | "DOWN" = to.type === "HIGH" ? "UP" : "DOWN";
      const changePct = ((to.price - from.price) / from.price) * 100;
      const barCount = Math.abs(to.index - from.index);
      const durationSec = Math.abs(to.time - from.time);
      const description = `${direction === "UP" ? "คลื่นขึ้น ↗" : "คลื่นลง ↘"} ${from.dowLabel} ➔ ${to.dowLabel} (${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%)`;

      legs.push({
        from,
        to,
        direction,
        changePct,
        barCount,
        durationSec,
        description,
      });

      const minIdx = Math.min(from.index, to.index);
      const maxIdx = Math.max(from.index, to.index);
      const idxSpan = Math.max(1, maxIdx - minIdx);

      for (let cIdx = minIdx; cIdx <= maxIdx; cIdx++) {
        const c = this.candles[cIdx];
        if (!c) continue;
        const progress = (cIdx - minIdx) / idxSpan;
        const interpPrice = from.index < to.index
          ? from.price + progress * (to.price - from.price)
          : to.price + (1 - progress) * (from.price - to.price);

        const lastPt = wavePoints[wavePoints.length - 1];
        if (lastPt && lastPt.time === c.time) {
          lastPt.value = Number(interpPrice.toFixed(6));
        } else {
          wavePoints.push({
            time: c.time,
            value: Number(interpPrice.toFixed(6)),
          });
        }
      }
    }

    // 4. Current active forming leg (informational metadata only; wave line stops at the last confirmed swing)
    const currentLeg: WaveLeg | undefined = legs.length > 0 ? legs[legs.length - 1] : undefined;

    let activeCycleSummary = "รอบคลื่น: ก่อตัว (Warmup)";
    if (annotatedSwings.length >= 2) {
      const isBull = lastHighLabel === "HH" && lastLowLabel === "HL";
      const isBear = lastHighLabel === "LH" && lastLowLabel === "LL";
      if (isBull) {
        activeCycleSummary = "รอบคลื่น: ขาขึ้น (HH + HL ยกตัว)";
      } else if (isBear) {
        activeCycleSummary = "รอบคลื่น: ขาลง (LH + LL กดตัว)";
      } else if (lastLowLabel === "HL") {
        activeCycleSummary = "รอบคลื่น: ฟื้นตัว (ยก HL ฐานสูงขึ้น)";
      } else if (lastHighLabel === "LH") {
        activeCycleSummary = "รอบคลื่น: ชะลอตัว (ติด LH ยอดต่ำลง)";
      } else {
        const lastTwo = annotatedSwings.slice(-2);
        activeCycleSummary = `รอบคลื่น: ไซด์เวย์ (${lastTwo.map((s) => s.dowLabel).join(" ➔ ")})`;
      }
    }

    // Deduplicate wave points and ensure strictly ascending by time for Lightweight Charts
    const wavePtMap = new Map<number, TrendLinePoint>();
    for (const pt of wavePoints) {
      if (pt && typeof pt.time === "number" && Number.isFinite(pt.time) && Number.isFinite(pt.value)) {
        wavePtMap.set(pt.time, pt);
      }
    }
    const cleanWavePoints = Array.from(wavePtMap.values()).sort((a, b) => a.time - b.time);

    return {
      legs,
      currentLeg,
      wavePoints: cleanWavePoints,
      annotatedSwings,
      lastHh,
      lastHl,
      lastLh,
      lastLl,
      activeCycleSummary,
    };
  }

  getAtrPct(period = 14): number {
    if (this.candles.length < 2) return 0.008;
    const count = Math.min(this.candles.length - 1, period);
    let sumTr = 0;
    for (let i = this.candles.length - count; i < this.candles.length; i++) {
      const curr = this.candles[i];
      const prev = this.candles[i - 1];
      if (!curr || !prev) continue;
      const tr = Math.max(
        curr.high - curr.low,
        Math.abs(curr.high - prev.close),
        Math.abs(curr.low - prev.close),
      );
      sumTr += tr;
    }
    const avgTr = sumTr / count;
    const lastClose = this.candles[this.candles.length - 1]?.close || 1;
    return avgTr / lastClose;
  }

  /**
   * Get current Dow structure and percentage-based Grid Zone.
   * Supports:
   * - "DOW_ATR_CLAMP": Dow Swings with dynamic ATR min/max clamping and true wick support.
   * - "FIXED_PCT_CLAMP": Dow Swings clamped to fixed percentage width (e.g. 1.8% - 4.0%).
   * - "DONCHIAN_ATR": Adaptive Donchian Channel (Highest High & Lowest Low of lookback bars) with buffer.
   */
  getStructure(currentPrice?: number, centerFallback?: number, options?: ChannelOptions): DowStructure {
    const fallbackPrice = currentPrice ?? centerFallback ?? 0.2;
    let upperBound: number;
    let bottomBound: number;
    let isSwingConfirmed = false;
    let activeValley: SwingPoint | undefined;
    let activePeak: SwingPoint | undefined;
    let candidatePeak: CandidatePoint | undefined;
    let candidateValley: CandidatePoint | undefined;

    const candles = options?.useOnlyClosedCandles ? this.getClosedCandles() : this.candles;
    const n = candles.length;
    const lastCandle = n > 0 ? candles[n - 1] : undefined;
    const price = (options?.useOnlyClosedCandles && lastCandle) ? (currentPrice ?? lastCandle.close) : (currentPrice ?? fallbackPrice);
    const k = Math.max(2, this.pivotWindow || 3);
    const mode = options?.mode ?? "DOW_SWINGS";
    const useTrueWick = options?.useTrueWick ?? this.useTrueWick ?? true;
    const wickThreshFraction = options?.wickThresholdPct !== undefined
      ? (options.wickThresholdPct > 1.0 ? options.wickThresholdPct / 100 : options.wickThresholdPct)
      : this.wickThresholdPct;

    if (
      (options?.useTrueWick !== undefined && options.useTrueWick !== this.useTrueWick) ||
      (options?.wickThresholdPct !== undefined && Math.abs(wickThreshFraction - this.wickThresholdPct) > 1e-6)
    ) {
      this.useTrueWick = useTrueWick;
      this.wickThresholdPct = wickThreshFraction;
      this.recalculateSwings();
    }
    // Peak/Valley (wave cycle), trendline and S/R scanning all share ONE lookback window
    if (options?.srLookbackCandles !== undefined) {
      this.structureLookback = Math.max(20, Math.round(options.srLookbackCandles));
    }
    const effAtrPct = options?.atrPct ?? this.getAtrPct() ?? 0.008;

    // Filter confirmed swing points (pivots with at least k following closed bars)
    const confirmedLows = this.swingLows
      .filter((s) => s.index < n - 1)
      .sort((a, b) => a.index - b.index); // chronological order

    const confirmedHighs = this.swingHighs
      .filter((s) => s.index < n - 1)
      .sort((a, b) => a.index - b.index); // chronological order

    // ── 1. Detect Candidate Peaks & Valleys in the unconfirmed tail (last candles) ──
    if (n >= k + 1) {
      const startCandidateIdx = Math.max(k, n - 1 - k);
      for (let idx = startCandidateIdx; idx < n; idx++) {
        const c = candles[idx];
        if (!c) continue;

        // Number of fully closed candles formed strictly after idx (candle n - 1 is currently open/live)
        const followingClosedCandles = Math.max(0, (n - 2) - idx);
        const candEffHigh = getEffectiveHigh(c, useTrueWick, this.wickThresholdPct);
        const candEffLow = getEffectiveLow(c, useTrueWick, this.wickThresholdPct);

        let isCandHigh = true;
        for (let j = idx - k; j < idx; j++) {
          const prev = candles[j];
          if (prev && getEffectiveHigh(prev, useTrueWick, this.wickThresholdPct) > candEffHigh) {
            isCandHigh = false;
            break;
          }
        }
        if (isCandHigh) {
          for (let j = idx + 1; j <= Math.min(n - 2, idx + k); j++) {
            const next = candles[j];
            if (next && getEffectiveHigh(next, useTrueWick, this.wickThresholdPct) > candEffHigh) {
              isCandHigh = false;
              break;
            }
          }
        }

        if (isCandHigh && followingClosedCandles < k) {
          if (!candidatePeak || candEffHigh >= candidatePeak.price) {
            candidatePeak = {
              index: idx,
              time: c.time,
              price: candEffHigh,
              type: "HIGH",
              confirmationCandles: followingClosedCandles,
              requiredCandles: k,
              isConfirmed: false,
            };
          }
        }

        let isCandLow = true;
        for (let j = idx - k; j < idx; j++) {
          const prev = candles[j];
          if (prev && getEffectiveLow(prev, useTrueWick, this.wickThresholdPct) < candEffLow) {
            isCandLow = false;
            break;
          }
        }
        if (isCandLow) {
          for (let j = idx + 1; j <= Math.min(n - 2, idx + k); j++) {
            const next = candles[j];
            if (next && getEffectiveLow(next, useTrueWick, this.wickThresholdPct) < candEffLow) {
              isCandLow = false;
              break;
            }
          }
        }

        if (isCandLow && followingClosedCandles < k) {
          if (!candidateValley || candEffLow <= candidateValley.price) {
            candidateValley = {
              index: idx,
              time: c.time,
              price: candEffLow,
              type: "LOW",
              confirmationCandles: followingClosedCandles,
              requiredCandles: k,
              isConfirmed: false,
            };
          }
        }
      }
    }

    // ── 2. Determine Active Wave Key Swings (Active Valley & Active Peak) ──
    // The active wave represents the current price cycle / consolidation structure.
    // Swings MUST strictly alternate (Peak -> Valley -> Peak -> Valley) per Dow Theory!
    // A valley can ONLY exist if there is a preceding peak to the left.
    const waveCycle = this.calculateWaveCycles();
    const canonicalLows = waveCycle.annotatedSwings.filter((s) => s.type === "LOW");
    const canonicalHighs = waveCycle.annotatedSwings.filter((s) => s.type === "HIGH");

    const macroPeak = canonicalHighs.length > 0
      ? canonicalHighs.reduce((max, h) => (!max || h.price > max.price ? h : max), canonicalHighs[0]!)
      : undefined;
    const macroLow = canonicalLows.length > 0
      ? canonicalLows.reduce((min, l) => (!min || l.price < min.price ? l : min), canonicalLows[0]!)
      : undefined;

    // Detect active wave cycle base index:
    // If macroPeak occurred after macroLow, the market launched from a base valley up to macroPeak,
    // and is currently in a downwave/correction.
    // In a downwave after macroPeak:
    // If post-peak lows exist (canonicalLows after macroPeak.index), the true floor of the active downwave
    // is the lowest confirmed valley of this downwave (postPeakLows), provided the channel width meets minSpanRequired!
    // If no post-peak low exists yet or postPeakLows width is insufficient, fallback to prePeak launchpad base.
    let activeWaveBaseIndex = 0;
    const postPeakLows = macroPeak ? canonicalLows.filter((l) => l.index > macroPeak.index) : [];

    if (macroPeak && macroLow) {
      if (macroPeak.index > macroLow.index) {
        if (postPeakLows.length > 0) {
          // มีเหวที่เกิดขึ้นหลังยอด macroPeak ในรอบคลื่นทุบปัจจุบัน
          // ให้ยึดจุดต่ำสุดของรอบทุบนี้เป็น activeWaveBaseIndex
          const lowestPostPeak = postPeakLows.reduce((min, l) => (l.price < min.price ? l : min), postPeakLows[0]!);
          activeWaveBaseIndex = lowestPostPeak.index;
        } else {
          const prePeakLows = canonicalLows.filter((l) => l.index < macroPeak.index);
          const launchpadLow = prePeakLows.length > 0 ? prePeakLows[prePeakLows.length - 1]! : macroLow;
          const baseClusterLows = prePeakLows.filter((l) => l.index >= launchpadLow.index - 10);
          const lowestLaunchpad = baseClusterLows.length > 0
            ? baseClusterLows.reduce((min, l) => (l.price < min.price ? l : min), launchpadLow)
            : launchpadLow;
          activeWaveBaseIndex = lowestLaunchpad.index;
        }
      } else {
        // macroPeak เกิดก่อน macroLow: ตลาดทุบลงมาทำ macroLow แล้ว
        // ยึด macroLow.index เป็นจุดเริ่มต้นของคลื่นเสมอ เพื่อให้ activeCycleLows มีทั้งฐาน macroLow (LL)
        // และเหว HL ถัดมาครบถ้วน โดยเหว HL จะยกฐานได้ต่อเมื่อผ่านเกณฑ์ isValleyEligibleForFloor (เบรกยอดก่อนหน้า) แล้วเท่านั้น
        activeWaveBaseIndex = macroLow.index;
      }
    } else if (macroLow) {
      activeWaveBaseIndex = macroLow.index;
    } else if (macroPeak) {
      if (postPeakLows.length > 0) {
        const lowestPostPeak = postPeakLows.reduce((min, l) => (l.price < min.price ? l : min), postPeakLows[0]!);
        activeWaveBaseIndex = lowestPostPeak.index;
      } else {
        const prePeakLows = canonicalLows.filter((l) => l.index < macroPeak.index);
        activeWaveBaseIndex = prePeakLows.length > 0 ? prePeakLows[prePeakLows.length - 1]!.index : macroPeak.index;
      }
    }

    const cycleHighsStartIndex = (macroPeak && macroLow && macroPeak.index < macroLow.index)
      ? macroLow.index
      : activeWaveBaseIndex;
    const activeCycleHighs = canonicalHighs.filter((h) => h.index >= cycleHighsStartIndex);
    const activeCycleLows = canonicalLows.filter((l) => l.index >= activeWaveBaseIndex);

    let baseValley: SwingPoint | undefined;
    // Helper: A confirmed valley is unbroken if no subsequent confirmed valley, candidate valley, or subsequent candle dropped below it
    const isUnbrokenValley = (v: SwingPoint, pool: SwingPoint[]) =>
      !pool.some((later) => (later.index > v.index || later.time > v.time) && later.price < v.price) &&
      !(candidateValley && candidateValley.time > v.time && candidateValley.price < v.price) &&
      !candles.some((c) => c.time > v.time && getEffectiveLow(c, useTrueWick, this.wickThresholdPct) < v.price);

    // Helper: A confirmed peak is unbroken if no subsequent confirmed peak, candidate peak, or subsequent candle rose above it
    const isUnbrokenPeak = (p: SwingPoint, pool: SwingPoint[]) =>
      !pool.some((later) => (later.index > p.index || later.time > p.time) && later.price > p.price) &&
      !(candidatePeak && candidatePeak.time > p.time && candidatePeak.price > p.price) &&
      !candles.some((c) => c.time > p.time && getEffectiveHigh(c, useTrueWick, this.wickThresholdPct) > p.price);

    // Helper (Dow Theory Recovery & Breakout HL Confirmation):
    // 1) A wave base / Lower Low (LL) is immediately eligible.
    // 2) An unbroken confirmed Higher Low (HL) in the active cycle is eligible to lift the Floor immediately
    //    if price is holding above it (in recovery wave 'ฟื้นตัว (ยก HL ฐานสูงขึ้น)'), OR
    // 3) Price (or a subsequent candle/peak) breaks above the preceding peak (classic trend continuation).
    const isValleyEligibleForFloor = (v: SwingPoint): boolean => {
      const vPos = canonicalLows.findIndex((l) => l.index === v.index && l.time === v.time);
      const prevValley = vPos > 0 ? canonicalLows[vPos - 1] : canonicalLows.filter((l) => l.index < v.index).pop();
      if (!prevValley || v.price <= prevValley.price || (v as DowSwingPoint).dowLabel === "LL") {
        return true;
      }

      // In active wave recovery, an unbroken confirmed Higher Low that price is currently holding above
      // serves as the immediate higher support floor without waiting for HH breakout:
      if (v.index >= activeWaveBaseIndex && price >= v.price && isUnbrokenValley(v, canonicalLows)) {
        return true;
      }

      const interveningPeaks = canonicalHighs.filter((h) => h.index > prevValley.index && h.index < v.index);
      const precedingPeak = interveningPeaks.length > 0
        ? interveningPeaks.reduce((max, h) => (h.price >= max.price ? h : max), interveningPeaks[0]!)
        : canonicalHighs.filter((h) => h.index < v.index).pop();
      if (!precedingPeak) return true;

      const brokenByPrice = price > precedingPeak.price;
      const brokenByPeak = canonicalHighs.some((h) => h.index > v.index && h.price > precedingPeak.price);
      const brokenByCandidate = Boolean(
        candidatePeak && candidatePeak.time > v.time && candidatePeak.price > precedingPeak.price
      );
      const brokenByCandle = candles.some(
        (c) => c.time > v.time && getEffectiveHigh(c, useTrueWick, this.wickThresholdPct) > precedingPeak.price
      );
      return brokenByPrice || brokenByPeak || brokenByCandidate || brokenByCandle;
    };

    const lowsPool = activeCycleLows.length > 0 ? activeCycleLows : canonicalLows;
    const eligibleLowsBelowPrice = lowsPool
      .filter((l) => l.price <= price && isUnbrokenValley(l, canonicalLows) && isValleyEligibleForFloor(l))
      .sort((a, b) => b.price - a.price);
    const unbrokenLowsBelowPrice = eligibleLowsBelowPrice.length > 0
      ? eligibleLowsBelowPrice
      : lowsPool
          .filter((l) => l.price <= price && isUnbrokenValley(l, canonicalLows))
          .sort((a, b) => b.price - a.price); // Nearest (highest) unbroken confirmed valley below price first

    if (unbrokenLowsBelowPrice.length > 0) {
      baseValley = unbrokenLowsBelowPrice[0]!;
    } else if (postPeakLows.length > 0 && macroPeak && macroLow && macroPeak.index > macroLow.index) {
      baseValley = postPeakLows.reduce((min, l) => (l.price < min.price ? l : min), postPeakLows[0]!);
    } else if (activeCycleLows.length > 0) {
      baseValley = activeCycleLows.reduce((min, l) => (l.price < min.price ? l : min), activeCycleLows[0]!);
    } else if (canonicalLows.length > 0) {
      baseValley = canonicalLows.reduce((min, l) => (l.price < min.price ? l : min), canonicalLows[0]!);
    }

    activeValley = baseValley;
    const waveStartIndex = activeWaveBaseIndex > 0 ? activeWaveBaseIndex : (baseValley?.index ?? 0);

    // Highs formed in the active wave (post-valley or post-macroLow)
    const highsInActiveWave = canonicalHighs.filter((s) => s.index >= waveStartIndex);

    // 🔒 Dow Theory Rule ("ถ้ายอดในราคาปัจจุบันทำ Lower high สามารถปรับลดกรอบลงมาได้" / "ถ้าทำ HH ปรับขึ้นตามยอดใหม่"):
    const lastCanonicalHigh = activeCycleHighs.length > 0
      ? activeCycleHighs[activeCycleHighs.length - 1]
      : (canonicalHighs.length > 0 ? canonicalHighs[canonicalHighs.length - 1] : undefined);
    const lastCanonicalLow = activeCycleLows.length > 0
      ? activeCycleLows[activeCycleLows.length - 1]
      : (canonicalLows.length > 0 ? canonicalLows[canonicalLows.length - 1] : undefined);

    const isLatestHighHh = Boolean(
      lastCanonicalHigh &&
      (lastCanonicalHigh.dowLabel === "HH" || (activeCycleHighs.length >= 2 && lastCanonicalHigh.price >= activeCycleHighs[activeCycleHighs.length - 2]!.price))
    );
    const isLatestHighLh = Boolean(
      lastCanonicalHigh &&
      (lastCanonicalHigh.dowLabel === "LH" || (activeCycleHighs.length >= 2 && lastCanonicalHigh.price < activeCycleHighs[activeCycleHighs.length - 2]!.price)) &&
      price <= lastCanonicalHigh.price * 1.0005
    );

    const highsPool = activeCycleHighs.length > 0 ? activeCycleHighs : highsInActiveWave;

    // 🔒 Pure Dow Theory Rule:
    // Anchor activePeak to the highest confirmed structural swing peak (maxHigh) of the active cycle!
    // NEVER collapse activePeak down to an unconfirmed candle or a prior high that was already broken upward.
    if (highsPool.length > 0) {
      let maxHigh = highsPool[0]!;
      for (const h of highsPool) {
        if (h.price >= maxHigh.price) maxHigh = h;
      }
      activePeak = maxHigh;
    } else if (canonicalHighs.length > 0) {
      activePeak = canonicalHighs.reduce((max, h) => (h.price >= max.price ? h : max), canonicalHighs[0]!);
    }

    // 🔒 ยึดยอดสวิงสูงสุดที่ยืนยันแล้วของคลื่นปัจจุบัน (activePeak) เป็นแนวต้าน (activeCeilingPoint) โดยตรง
    const activeCeilingPoint = activePeak;

    let clampStatus: GridZone["clampStatus"] = "NATURAL_SWING";
    let anchorSide: GridZone["anchorSide"] = "NONE";
    let rawWidthPct: number | undefined;
    let minWidthPct: number | undefined;
    let maxWidthPct: number | undefined;

    const minPct = (options?.minChannelWidthPct ?? 1.8) / 100;
    const maxPct = (options?.maxChannelWidthPct ?? 6.0) / 100;
    const minSpan = price * minPct;
    const maxSpan = price * maxPct;

    // ── 4. Calculate Final Bounds by Selected Channel Mode ────────────────────
    if (mode === "DONCHIAN_ATR") {
      const lookback = Math.min(n, options?.donchianLookback ?? 20);
      const donchianCandles = candles.slice(Math.max(0, n - lookback));
      const allLows = donchianCandles.map((c) => (useTrueWick ? c.low : getEffectiveLow(c, false))).filter(Number.isFinite);
      const allHighs = donchianCandles.map((c) => (useTrueWick ? c.high : getEffectiveHigh(c, false))).filter(Number.isFinite);

      const rawBottom = allLows.length > 0 ? Math.min(...allLows) : price * 0.985;
      const rawUpper = allHighs.length > 0 ? Math.max(...allHighs) : price * 1.015;

      const minDonchianSpan = Math.max(price * 0.015, price * effAtrPct * 2.0);
      bottomBound = rawBottom;
      upperBound = rawUpper;
      isSwingConfirmed = true;

      if (upperBound - bottomBound < minDonchianSpan) {
        upperBound = bottomBound + minDonchianSpan;
      }

      rawWidthPct = bottomBound > 0 ? ((upperBound - bottomBound) / bottomBound) * 100 : 0;
      minWidthPct = (minSpan / price) * 100;
      maxWidthPct = (maxSpan / price) * 100;
    } else {
      // 🔒 Proximity-First & Minimum-Width Anchoring:
      // เกณฑ์ Dow Theory: คำนวณจากยอดและเหวที่ยืนยันแล้วที่ยังไม่ถูกทำลาย (Unbroken Confirmed Swings)
      const minSpanFromPct = minSpan;
      const maxSpanFromPct = maxSpan;

      // 1. ค้นหาเหวแนวรับที่ยืนยันแล้วและยังไม่ถูกทำลาย ซึ่งอยู่ต่ำกว่าหรือเท่ากับราคาปัจจุบัน
      const allEligibleValleysBelow = canonicalLows
        .filter((l) => l.price <= price && isUnbrokenValley(l, canonicalLows) && isValleyEligibleForFloor(l))
        .sort((a, b) => b.price - a.price); // เรียงจากใกล้ราคาลงไป (ราคาสูงไปต่ำ)
      const unbrokenValleysBelow = allEligibleValleysBelow.length > 0
        ? allEligibleValleysBelow
        : canonicalLows
            .filter((l) => l.price <= price && isUnbrokenValley(l, canonicalLows))
            .sort((a, b) => b.price - a.price);

      // 2. ค้นหายอดแนวต้านที่ยืนยันแล้วและยังไม่ถูกทำลาย ซึ่งอยู่สูงกว่าหรือเท่ากับราคาปัจจุบัน
      const unbrokenPeaksAbove = canonicalHighs
        .filter((h) => h.price >= price && isUnbrokenPeak(h, canonicalHighs))
        .sort((a, b) => a.price - b.price); // เรียงจากใกล้ราคาขึ้นไป (ราคาต่ำไปสูง)

      const nearestPeak = unbrokenPeaksAbove[0];
      const nearestValley = unbrokenValleysBelow[0];

      // Effective reference prices for proximity distance comparison
      const effPeakPrice = nearestPeak?.price ?? candidatePeak?.price ?? (lastCandle ? getEffectiveHigh(lastCandle, useTrueWick, this.wickThresholdPct) : price * (1 + minPct / 2));
      const effValleyPrice = nearestValley?.price ?? candidateValley?.price ?? (lastCandle ? getEffectiveLow(lastCandle, useTrueWick, this.wickThresholdPct) : price * (1 - minPct / 2));

      const distToPeak = Math.max(0, effPeakPrice - price);
      const distToValley = Math.max(0, price - effValleyPrice);

      // ตรวจสอบว่าราคาปัจจุบันอยู่ใกล้ยอด หรือ ใกล้เหว ทางซ้ายมากกว่ากัน
      const isCloserToPeak = distToPeak < distToValley;

      let curCeil: number;
      let curFloor: number;

      if (isCloserToPeak && (nearestPeak || unbrokenPeaksAbove.length > 0)) {
        // ── Case A: ใกล้ยอดมากกว่า -> เลือกล็อก "ยอด (Peak)" เป็นแนวต้านหลักก่อน (Ceiling) ──
        const pAnchor = nearestPeak ?? unbrokenPeaksAbove[0]!;
        curCeil = pAnchor.price;
        activePeak = pAnchor;
        anchorSide = "UPPER_CEILING";

        // ค้นหาเหว (Valley) ที่เป็นไปได้มาประกบคู่ (จะไกลแค่ไหนก็ได้ แต่เลือกที่ใกล้ก่อน แต่ที่ไกลกว่า ใกล้กับความกว้างขั้นต่ำมากกว่า ก็เลือกได้)
        if (unbrokenValleysBelow.length > 0) {
          // กลุ่มที่ให้ความกว้างอยู่ในเกณฑ์ [minSpan, maxSpan]
          const validValleys = unbrokenValleysBelow.filter((v) => {
            const w = curCeil - v.price;
            return w >= minSpanFromPct && w <= maxSpanFromPct;
          });

          if (validValleys.length > 0) {
            // เลือกเหวที่ให้ความกว้างใกล้เคียงกับ minSpanFromPct ที่สุด
            let chosen = validValleys[0]!;
            let bestDiff = (curCeil - chosen.price) - minSpanFromPct;
            for (let i = 1; i < validValleys.length; i++) {
              const v = validValleys[i]!;
              const diffNext = (curCeil - v.price) - minSpanFromPct;
              if (diffNext < bestDiff) {
                bestDiff = diffNext;
                chosen = v;
              }
            }
            curFloor = chosen.price;
            activeValley = chosen;
          } else {
            // หากไม่มีเหวใดที่กว้างถึง minSpanFromPct:
            // เลือกเหวที่ให้ความกว้างใกล้ minSpanFromPct ที่สุด (เหวที่ลึกที่สุดที่ไม่เกิน maxSpanFromPct)
            let chosen = unbrokenValleysBelow[0]!;
            let bestDiff = Math.abs((curCeil - chosen.price) - minSpanFromPct);
            for (let i = 1; i < unbrokenValleysBelow.length; i++) {
              const v = unbrokenValleysBelow[i]!;
              const w = curCeil - v.price;
              if (w > maxSpanFromPct) continue;
              const diff = Math.abs(w - minSpanFromPct);
              if (diff < bestDiff) {
                bestDiff = diff;
                chosen = v;
              }
            }
            curFloor = chosen.price;
            activeValley = chosen;

            // หากยังแคบกว่า minSpanFromPct ให้ขยาย Floor ลงไปให้ได้ minSpanFromPct พอดี
            if (curCeil - curFloor < minSpanFromPct) {
              curFloor = curCeil - minSpanFromPct;
              clampStatus = "CLAMPED_MIN";
            }
          }
        } else {
          // ไม่มีเหวยืนยันใต้ราคา: ใช้ candidateValley หรือปรับตาม minSpanFromPct
          const candFloor = candidateValley && candidateValley.price <= price
            ? candidateValley.price
            : curCeil - minSpanFromPct;
          curFloor = candFloor;
          if (candidateValley && candidateValley.price <= price) {
            activeValley = candidateValley;
          }
        }

        // ตรวจสอบความกว้างขั้นต่ำ (Min Channel Width Guarantee)
        if (curCeil - curFloor < minSpanFromPct) {
          const deeperValley = canonicalLows.find(
            (l) => l.price < curFloor && isUnbrokenValley(l, canonicalLows) && (curCeil - l.price) <= maxSpanFromPct
          );
          if (deeperValley && curCeil - deeperValley.price >= minSpanFromPct) {
            curFloor = deeperValley.price;
            activeValley = deeperValley;
          } else {
            curFloor = curCeil - minSpanFromPct;
          }
          clampStatus = "CLAMPED_MIN";
        }

        // ตรวจสอบความกว้างสูงสุด (Max Channel Width Guarantee)
        if (curCeil - curFloor > maxSpanFromPct) {
          curFloor = curCeil - maxSpanFromPct;
          clampStatus = "CLAMPED_MAX";
        }
      } else if (nearestValley || unbrokenValleysBelow.length > 0) {
        // ── Case B: ใกล้เหวมากกว่า -> เลือกล็อก "เหว (Valley)" เป็นแนวรับหลักก่อน (Floor) ──
        const vAnchor = nearestValley ?? unbrokenValleysBelow[0]!;
        curFloor = vAnchor.price;
        activeValley = vAnchor;
        anchorSide = "LOWER_FLOOR";

        // ค้นหายอด (Peak) ที่เป็นไปได้มาประกบคู่ (จะไกลแค่ไหนก็ได้ แต่เลือกที่ใกล้ก่อน แต่ที่ไกลกว่า ใกล้กับความกว้างขั้นต่ำมากกว่า ก็เลือกได้)
        if (unbrokenPeaksAbove.length > 0) {
          // กลุ่มที่ให้ความกว้างอยู่ในเกณฑ์ [minSpan, maxSpan]
          const validPeaks = unbrokenPeaksAbove.filter((p) => {
            const w = p.price - curFloor;
            return w >= minSpanFromPct && w <= maxSpanFromPct;
          });

          if (validPeaks.length > 0) {
            // เลือกยอดที่ให้ความกว้างใกล้เคียงกับ minSpanFromPct ที่สุด
            let chosen = validPeaks[0]!;
            let bestDiff = (chosen.price - curFloor) - minSpanFromPct;
            for (let i = 1; i < validPeaks.length; i++) {
              const p = validPeaks[i]!;
              const diffNext = (p.price - curFloor) - minSpanFromPct;
              if (diffNext < bestDiff) {
                bestDiff = diffNext;
                chosen = p;
              }
            }
            curCeil = chosen.price;
            activePeak = chosen;
          } else {
            // หากไม่มียอดใดที่กว้างถึง minSpanFromPct:
            // เลือกยอดที่ให้ความกว้างใกล้ minSpanFromPct ที่สุด (ยอดที่สูงที่สุดที่ไม่เกิน maxSpanFromPct)
            let chosen = unbrokenPeaksAbove[0]!;
            let bestDiff = Math.abs((chosen.price - curFloor) - minSpanFromPct);
            for (let i = 1; i < unbrokenPeaksAbove.length; i++) {
              const p = unbrokenPeaksAbove[i]!;
              const w = p.price - curFloor;
              if (w > maxSpanFromPct) continue;
              const diff = Math.abs(w - minSpanFromPct);
              if (diff < bestDiff) {
                bestDiff = diff;
                chosen = p;
              }
            }
            curCeil = chosen.price;
            activePeak = chosen;

            // หากยังแคบกว่า minSpanFromPct ให้ขยาย Ceiling ขึ้นไปให้ได้ minSpanFromPct พอดี
            if (curCeil - curFloor < minSpanFromPct) {
              curCeil = curFloor + minSpanFromPct;
              clampStatus = "CLAMPED_MIN";
            }
          }
        } else {
          // ไม่มียอดยืนยันเหนือราคา: ใช้ candidatePeak หรือปรับตาม minSpanFromPct
          const candCeil = candidatePeak && candidatePeak.price >= price
            ? candidatePeak.price
            : curFloor + minSpanFromPct;
          curCeil = candCeil;
          if (candidatePeak && candidatePeak.price >= price) {
            activePeak = candidatePeak;
          }
        }

        // ตรวจสอบความกว้างขั้นต่ำ (Min Channel Width Guarantee)
        if (curCeil - curFloor < minSpanFromPct) {
          const higherPeak = canonicalHighs.find(
            (h) => h.price > curCeil && isUnbrokenPeak(h, canonicalHighs) && (h.price - curFloor) <= maxSpanFromPct
          );
          if (higherPeak && higherPeak.price - curFloor >= minSpanFromPct) {
            curCeil = higherPeak.price;
            activePeak = higherPeak;
          } else {
            curCeil = curFloor + minSpanFromPct;
          }
          clampStatus = "CLAMPED_MIN";
        }

        // ตรวจสอบความกว้างสูงสุด (Max Channel Width Guarantee)
        if (curCeil - curFloor > maxSpanFromPct) {
          curCeil = curFloor + maxSpanFromPct;
          clampStatus = "CLAMPED_MAX";
        }
      } else {
        // Fallback หากไม่มีทั้งยอดและเหว
        curCeil = price * (1 + minPct / 2);
        curFloor = price * (1 - minPct / 2);
      }

      // ป้องกันราคาหลุดกรอบ (Price Containment Guarantee)
      if (price > curCeil) curCeil = price * 1.0005;
      if (price < curFloor) curFloor = price * 0.9995;

      upperBound = curCeil;
      bottomBound = curFloor;
      isSwingConfirmed = true;

      rawWidthPct = bottomBound > 0 ? ((upperBound - bottomBound) / bottomBound) * 100 : 0;
      minWidthPct = (minSpan / price) * 100;
      maxWidthPct = (maxSpan / price) * 100;
    }

    const lastHigh = this.swingHighs[this.swingHighs.length - 1];
    const lastLow = this.swingLows[this.swingLows.length - 1];

    // Dow Theory Market Regime
    const prevHigh = this.swingHighs.length >= 2 ? this.swingHighs[this.swingHighs.length - 2] : undefined;
    const prevLow = this.swingLows.length >= 2 ? this.swingLows[this.swingLows.length - 2] : undefined;

    let regime: MarketRegime = isSwingConfirmed ? "RANGE" : "WARMUP";

    if (isSwingConfirmed && lastHigh && lastLow && prevHigh && prevLow) {
      const higherHigh = lastHigh.price > prevHigh.price;
      const higherLow = lastLow.price > prevLow.price;
      const lowerHigh = lastHigh.price < prevHigh.price;
      const lowerLow = lastLow.price < prevLow.price;

      if (higherHigh && higherLow) {
        regime = "UPTREND";
      } else if (lowerHigh && lowerLow) {
        regime = "DOWNTREND";
      } else {
        regime = "RANGE";
      }
    }

    // Channel span & center
    const floorBuffer = ((options?.floorBufferPct ?? 0.0) / 100) * bottomBound;
    const cutLossBound = bottomBound - floorBuffer;
    const finalSpan = upperBound - bottomBound;
    const centerPrice = bottomBound + finalSpan * 0.5; // 50% level

    // Position percentage in channel: 0% at floor, 50% at center, 100% at ceiling
    const positionPct = finalSpan > 0 ? ((price - bottomBound) / finalSpan) * 100 : 50;

    const isBelowFloor = price < cutLossBound;
    const isAboveCeiling = price >= upperBound;

    let zoneType: GridZone["zoneType"] = "BUY_ZONE";
    if (isBelowFloor) {
      zoneType = "BELOW_FLOOR_CUTLOSS";
    } else if (isAboveCeiling) {
      zoneType = "ABOVE_CEILING_FULL_EXIT";
    } else if (positionPct >= 50) {
      zoneType = "SELL_ZONE";
    } else {
      zoneType = "BUY_ZONE";
    }

    // Check channel width: In narrow channels (e.g. < narrowChannelThresholdPct%), adapt grid levels towards edges
    // to preserve tradeable edge swings and avoid clustering dust orders in the middle.
    const enableCollapse = options?.enableNarrowChannelCollapse !== false;
    const narrowThresh = options?.narrowChannelThresholdPct ?? 1.20;
    const channelWidthPct = bottomBound > 0 ? ((finalSpan / bottomBound) * 100) : 0;
    const isNarrowChannel = enableCollapse && bottomBound > 0 && channelWidthPct < narrowThresh;

    const buyBufferFrac = (options?.narrowChannelBuyBufferPct ?? 0.05) / 100;
    const sellBufferFrac = (options?.narrowChannelSellBufferPct ?? 0.05) / 100;

    const defaultBuyPcts = [42, 32, 22, 12, 2];
    const defaultSellPcts = [52, 62, 72, 82, 92];
    const buyPcts = options?.buyLevelPcts && options.buyLevelPcts.length > 0 ? options.buyLevelPcts : defaultBuyPcts;
    const sellPcts = options?.sellLevelPcts && options.sellLevelPcts.length > 0 ? options.sellLevelPcts : defaultSellPcts;

    // Grid Levels in Buy Zone (e.g. 42%, 32%, 22%, 12%, 2%)
    // In narrow channels (< threshold), collapse to a single edge-bracket level: Buy at Floor + Buffer%
    const buyLevels = isNarrowChannel
      ? [bottomBound * (1 + buyBufferFrac)]
      : buyPcts.map((pct) => bottomBound + finalSpan * (pct / 100));

    // Grid Levels in Sell Zone (e.g. 52%, 62%, 72%, 82%, 92%)
    // In narrow channels (< threshold), collapse to a single edge-bracket level: Sell at Ceiling - Buffer%
    const sellLevels = isNarrowChannel
      ? [upperBound * (1 - sellBufferFrac)]
      : sellPcts.map((pct) => bottomBound + finalSpan * (pct / 100));

    const zoneWidthPct = bottomBound > 0 ? (finalSpan / bottomBound) * 100 : 0;

    const gridZone: GridZone = {
      upperBound,
      bottomBound,
      cutLossBound,
      floorBuffer,
      floorBufferPct: price > 0 ? (floorBuffer / price) * 100 : 0,
      centerPrice,
      positionPct,
      zoneType,
      buyLevels,
      sellLevels,
      isBelowFloor,
      isAboveCeiling,
      zoneWidthPct,
      channelMode: mode,
      clampStatus,
      rawWidthPct,
      minWidthPct,
      maxWidthPct,
      anchorSide,
    };

    // Wave cycles were computed earlier and used to determine canonical activeValley/activePeak
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
    );
    // Active downtrend drop detection:
    // 1) Confirmed LH + LL wave sequence (รอบคลื่นกดตัว), OR
    // 2) Real-time breakdown below the active channel floor / confirmed support valley (หลุดฐานกรอบ):
    //    NOTE: A normal pullback inside the channel (price >= bottomBound) when the wave peak is HH
    //    must NOT be flagged as a breakdown, otherwise it blocks Buy Levels inside the channel!
    const activeFloorPrice = activeValley?.price ?? bottomBound;
    const isBreakingBelowChannelFloor = Boolean(
      price < bottomBound ||
      price < activeFloorPrice ||
      (candidateValley && candidateValley.price < bottomBound)
    );
    // ตรวจจับขาลงทั้ง 2 รูปแบบ:
    // A) ขาลงมาตรฐาน: LH + LL กดตัว
    // B) ขาลงฉับพลันหลังทำยอด HH: ยอดล่าสุดเป็น HH แต่ตามด้วยสวิง Low ที่รูดทำ LL หลุดฐานเหวก่อนหน้า (HH + LL breakdown)
    const isHhThenLlBreakdown = Boolean(
      lastCanonicalHigh?.dowLabel === "HH" &&
      lastCanonicalLow?.dowLabel === "LL" &&
      lastCanonicalLow.index > lastCanonicalHigh.index &&
      price < (activePeak?.price ?? upperBound)
    );
    const isConfirmedDowntrendWave = Boolean(
      (waveCycle.activeCycleSummary?.includes("LH + LL") ||
       (lastCanonicalHigh?.dowLabel === "LH" && lastCanonicalLow?.dowLabel === "LL") ||
       isHhThenLlBreakdown) &&
      price < (activePeak?.price ?? upperBound)
    );
    const isDowntrendDropActive = isConfirmedDowntrendWave || isBreakingBelowChannelFloor;

    const dropAnchorPeak = activePeak ?? macroPeak;
    const dropPostPeakLows = canonicalLows.filter((l) => dropAnchorPeak && l.index > dropAnchorPeak.index);
    const postPeakPrices = dropPostPeakLows.map((l) => l.price);
    if (candidateValley && (!dropAnchorPeak || candidateValley.index > dropAnchorPeak.index)) {
      postPeakPrices.push(candidateValley.price);
    }
    postPeakPrices.push(price);
    const downtrendDropLow = postPeakPrices.length > 0
      ? Math.min(...postPeakPrices)
      : (lastCanonicalLow?.price ?? bottomBound);

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
    this.candles = [];
    this.swingHighs = [];
    this.swingLows = [];
    this.recalculateSwings();
  }

  /**
   * Fetch higher-timeframe candles (e.g. 1h) from Binance REST API to establish
   * macro Dow Theory Swing Highs and Lows.
   */
  async loadHigherTimeframeCandles(
    symbol: string,
    timeframe: string = "1h",
    restBase: string = "https://api.binance.com",
    log?: (msg: string) => void,
    limit: number = 300,
    clearExisting = true,
  ): Promise<void> {
    const sym = symbol.toUpperCase();
    const clampedLimit = Math.min(1000, Math.max(10, limit));
    const url = `${restBase}/api/v3/klines?symbol=${sym}&interval=${timeframe}&limit=${clampedLimit}`;

    try {
      log?.(`fetching ${timeframe} macro candles for Dow Theory bounds: ${url}`);
      const res = await fetch(url);
      if (!res.ok) {
        log?.(`warning: could not fetch ${timeframe} macro candles (status ${res.status})`);
        return;
      }
      const rawKlines = (await res.json()) as any[];
      if (!Array.isArray(rawKlines) || rawKlines.length === 0) return;

      log?.(`loaded ${rawKlines.length} macro candles on ${timeframe} timeframe for Dow Theory bounds`);
      const candleMap = new Map<number, Candle>();
      if (!clearExisting) {
        for (const c of this.candles) {
          candleMap.set(c.time, c);
        }
      }
      const nowSec = Math.floor(Date.now() / 1000);
      for (const k of rawKlines) {
        const time = Math.floor(Number(k[0]) / 1000);
        const closeTime = Math.floor(Number(k[6]) / 1000);
        const open = Number(k[1]);
        const high = Number(k[2]);
        const low = Number(k[3]);
        const close = Number(k[4]);

        if ([time, open, high, low, close].every(Number.isFinite) && close > 0) {
          const isClosed = closeTime <= nowSec;
          candleMap.set(time, { time, open, high, low, close, isClosed });
        }
      }
      this.candles = Array.from(candleMap.values()).sort((a, b) => a.time - b.time);
      if (this.candles.length > this.maxCandles) {
        this.candles.splice(0, this.candles.length - this.maxCandles);
      }
      this.recalculateSwings();
    } catch (err) {
      log?.(`warning: error fetching ${timeframe} Dow candles: ${(err as Error).message}`);
    }
  }
}
