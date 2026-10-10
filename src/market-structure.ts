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
  channelMode?: string;     // Mode: "DOW_ATR_CLAMP" | "FIXED_PCT_CLAMP" | "DONCHIAN_ATR" | "MULTI_TOUCH_SR"
  clampStatus?: "NATURAL_SWING" | "CLAMPED_MIN" | "CLAMPED_MAX";
  rawWidthPct?: number;     // Unclamped swing width in %
  minWidthPct?: number;     // Minimum width % limit
  maxWidthPct?: number;     // Maximum width % limit
  anchorSide?: "LOWER_FLOOR" | "UPPER_CEILING" | "NONE";
  resistanceTouchCount?: number;
  supportTouchCount?: number;
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
  resistanceCluster?: { price: number; touchCount: number; points: SwingPoint[] };
  supportCluster?: { price: number; touchCount: number; points: SwingPoint[] };
  allResistanceClusters?: { price: number; touchCount: number; points: SwingPoint[] }[];
  allSupportClusters?: { price: number; touchCount: number; points: SwingPoint[] }[];
}

export interface ChannelOptions {
  mode?: "DOW_ATR_CLAMP" | "FIXED_PCT_CLAMP" | "DONCHIAN_ATR" | "MULTI_TOUCH_SR";
  minChannelWidthPct?: number; // for FIXED_PCT_CLAMP & MULTI_TOUCH_SR (e.g. 1.8%)
  maxChannelWidthPct?: number; // for FIXED_PCT_CLAMP & MULTI_TOUCH_SR (e.g. 4.0%)
  atrMinMultiplier?: number;   // for DOW_ATR_CLAMP (default 2.5x ATR)
  atrMaxMultiplier?: number;   // for DOW_ATR_CLAMP (default 5.0x ATR)
  donchianLookback?: number;   // for DONCHIAN_ATR (default 20 bars)
  floorBufferPct?: number;     // safety buffer below floor (e.g. 0.15%)
  atrPct?: number;             // external ATR % if available
  useTrueWick?: boolean;       // use true candle wick instead of body clipping (default true)
  wickThresholdPct?: number;   // rejection wick % threshold before clipping to candle body (default 20.0%)
  srMinTouchCount?: number;    // minimum touches for S/R in MULTI_TOUCH_SR mode (default 2)
  srTouchTolerancePct?: number;// tolerance % to group touches (default 0.35%)
  srLookbackCandles?: number;  // candles lookback for S/R scanning (default 100)
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
   * Find Horizontal Support & Resistance levels where price tested and was rejected >= minTouchCount times.
   *
   * @param currentPrice Current market price
   * @param lookbackBars Number of recent candles to inspect (default 100)
   * @param minTouchCount Minimum number of rejections/touches required (default 2)
   * @param tolerancePct Tolerance % to group nearby swing points into the same level (default 0.35%)
   * @param minSpanPct Minimum channel width % between Support and Resistance
   */
  public findMultiTouchSR(
    currentPrice: number,
    lookbackBars = 100,
    minTouchCount = 2,
    tolerancePct = 1.0,
    minSpanPct = 1.8,
    maxSpanPct = 6.0,
    activeWaveHigh?: number,
    activeWaveLow?: number,
    isConfirmedLowerHigh = false,
  ): {
    resistance?: { price: number; touchCount: number; points: SwingPoint[] };
    support?: { price: number; touchCount: number; points: SwingPoint[] };
    allResistanceClusters: { price: number; touchCount: number; points: SwingPoint[] }[];
    allSupportClusters: { price: number; touchCount: number; points: SwingPoint[] }[];
  } {
    const n = this.candles.length;
    const minIdx = Math.max(0, n - lookbackBars);
    const tol = Math.max(0.001, (tolerancePct ?? 1.0) / 100);

    // 1. Gather ONLY genuine structural alternating swings (from canonical wave swings)
    // to strictly prevent minor intra-leg pullback candles from being falsely treated as peaks/valleys:
    const waveCycle = this.calculateWaveCycles();
    const canonicalHighs = waveCycle.annotatedSwings.filter((s) => s.type === "HIGH");
    const canonicalLows = waveCycle.annotatedSwings.filter((s) => s.type === "LOW");
    const recentCanonicalHighs = canonicalHighs.slice(-4);
    const recentCanonicalLows = canonicalLows.slice(-4);
    const macroPeak = canonicalHighs.length > 0
      ? canonicalHighs.reduce((max, h) => (!max || h.price > max.price ? h : max), canonicalHighs[0]!)
      : undefined;
    const macroLow = canonicalLows.length > 0
      ? canonicalLows.reduce((min, l) => (!min || l.price < min.price ? l : min), canonicalLows[0]!)
      : undefined;

    // Detect if market bottomed at macroLow and is in an active recovery / new wave cycle:
    // (trough occurred after macroPeak, and swings formed at or after macroLow)
    const isNewCycleFromLow = Boolean(
      macroLow &&
      macroPeak &&
      macroLow.index > macroPeak.index &&
      canonicalHighs.some((h) => h.index > macroLow.index)
    );

    let candidateHighSwings = canonicalHighs;
    if (isNewCycleFromLow && macroLow) {
      const postLowHighs = canonicalHighs.filter((h) => h.index > macroLow.index);
      const maxPostLow = postLowHighs.length > 0 ? Math.max(...postLowHighs.map((h) => h.price)) : 0;
      if (postLowHighs.length > 0 && currentPrice <= maxPostLow * 1.002) {
        candidateHighSwings = postLowHighs;
      }
    } else if (macroPeak && currentPrice < macroPeak.price * 0.999) {
      const postPeakHighs = canonicalHighs.filter((h) => h.index >= macroPeak.index);
      if (postPeakHighs.length > 0) {
        candidateHighSwings = postPeakHighs;
      }
    }

    const peakPoints: SwingPoint[] = (candidateHighSwings.length > 0 ? candidateHighSwings : (canonicalHighs.length > 0 ? canonicalHighs : this.swingHighs)).filter((s) => s.index >= minIdx);
    const valleyPoints: SwingPoint[] = (canonicalLows.length > 0 ? canonicalLows : this.swingLows).filter((s) => s.index >= minIdx);

    // Cluster all structural points within tolerance to capture genuine multi-touch levels
    // Requires distinct touches separated by time (>= 3 bars) and intervening pullbacks/bounces
    const clusterPoints = (
      points: SwingPoint[],
      isHigh: boolean,
    ): { price: number; touchCount: number; points: SwingPoint[] }[] => {
      const clusters: { price: number; touchCount: number; points: SwingPoint[] }[] = [];
      const used = new Set<number>();

      // Helper: filter a group of points to distinct touches separated by time & intervening movement
      const getDistinctTouches = (group: SwingPoint[]): SwingPoint[] => {
        const distinct: SwingPoint[] = [];
        const sortedByTime = [...group].sort((a, b) => a.index - b.index);

        for (const pt of sortedByTime) {
          if (distinct.length === 0) {
            distinct.push(pt);
            continue;
          }
          const prevPt = distinct[distinct.length - 1]!;
          const barGap = Math.abs(pt.index - prevPt.index);

          // Must be separated by at least 2 candles
          if (barGap < 2) continue;

          // Check if there was an intervening pullback (for highs) or bounce (for lows) between the two touches
          const startIdx = Math.min(prevPt.index, pt.index) + 1;
          const endIdx = Math.max(prevPt.index, pt.index) - 1;
          let hadInterveningSeparation = false;

          const clusterAvg = group.reduce((s, p) => s + p.price, 0) / group.length;
          const separationPct = 0.0015; // At least 0.15% separation dip/bounce

          if (isHigh) {
            // Highs require a dip between them
            let minBetween = Infinity;
            for (let b = startIdx; b <= endIdx; b++) {
              const candle = this.candles[b];
              if (candle && candle.low < minBetween) minBetween = candle.low;
            }
            if (minBetween <= clusterAvg * (1 - separationPct)) {
              hadInterveningSeparation = true;
            }
          } else {
            // Lows require a bounce between them
            let maxBetween = -Infinity;
            for (let b = startIdx; b <= endIdx; b++) {
              const candle = this.candles[b];
              if (candle && candle.high > maxBetween) maxBetween = candle.high;
            }
            if (maxBetween >= clusterAvg * (1 + separationPct)) {
              hadInterveningSeparation = true;
            }
          }

          if (hadInterveningSeparation) {
            distinct.push(pt);
          }
        }
        return distinct;
      };

      // Density-First Clustering:
      // Evaluate candidate clusters for each unused point to prioritize dense horizontal levels (most touches)
      // over isolated outlier spikes.
      while (used.size < points.length) {
        let bestCandidate: {
          seedIdx: number;
          clusterPrice: number;
          touchingPoints: SwingPoint[];
          consumedIndices: number[];
        } | undefined;

        for (let i = 0; i < points.length; i++) {
          if (used.has(i)) continue;
          const p1 = points[i]!;
          const candidateGroup: SwingPoint[] = [p1];
          const candidateIndices: number[] = [i];

          for (let j = 0; j < points.length; j++) {
            if (i === j || used.has(j)) continue;
            const p2 = points[j]!;
            if (Math.abs(p2.price - p1.price) / p1.price <= tol) {
              candidateGroup.push(p2);
              candidateIndices.push(j);
            }
          }

          const distinct = getDistinctTouches(candidateGroup);
          if (distinct.length === 0) continue;

          // For Resistance: Strictly use min peak price so every peak reaches and touches the resistance line
          // For Support: Strictly use min valley price so the support floor line sits at the bottom of the valleys
          const cPrice = isHigh
            ? Math.min(...distinct.map((p) => p.price))
            : Math.min(...distinct.map((p) => p.price));

          // Strict Touch Verification:
          // Only points that genuinely touch cPrice within tight tolerance (<= 0.20%) count as touches of this line!
          // Outlier spikes that overshot/undershot the line are excluded from touching this level.
          const lineTouchTol = Math.min(tol, 0.002);
          const touchingPts = distinct.filter(
            (p) => Math.abs(p.price - cPrice) / cPrice <= lineTouchTol,
          );
          if (touchingPts.length === 0) continue;

          const consumed = candidateIndices.filter((idx) => {
            const pt = points[idx]!;
            return touchingPts.some((tp) => tp.time === pt.time && tp.price === pt.price);
          });

          // Score candidate:
          // 1. More genuine touches wins (Density first!)
          // 2. Tie-break: Resistance closer to currentPrice, or Support closer to currentPrice
          const isBetter = !bestCandidate ||
            touchingPts.length > bestCandidate.touchingPoints.length ||
            (touchingPts.length === bestCandidate.touchingPoints.length &&
              Math.abs(cPrice - currentPrice) < Math.abs(bestCandidate.clusterPrice - currentPrice));

          if (isBetter) {
            bestCandidate = {
              seedIdx: i,
              clusterPrice: cPrice,
              touchingPoints: touchingPts,
              consumedIndices: consumed,
            };
          }
        }

        if (!bestCandidate) {
          // Mark remaining points as used so loop terminates
          for (let i = 0; i < points.length; i++) used.add(i);
          break;
        }

        clusters.push({
          price: bestCandidate.clusterPrice,
          touchCount: bestCandidate.touchingPoints.length,
          points: bestCandidate.touchingPoints,
        });

        // Mark consumed points as used
        for (const idx of bestCandidate.consumedIndices) {
          used.add(idx);
        }
        // Always mark at least the seed to ensure progress
        used.add(bestCandidate.seedIdx);
      }
      return clusters;
    };

    // 2. Cluster Peaks (Swing Highs only) for Resistance
    const resClusters = clusterPoints(peakPoints, true);

    // 3. Cluster Valleys (Swing Lows only) for Support
    const supClusters = clusterPoints(valleyPoints, false);

    const validResClusters = resClusters.filter((c) => c.touchCount >= minTouchCount);
    const validSupClusters = supClusters.filter((c) => c.touchCount >= minTouchCount);

    // ── User S/R Logic ────────────────────────────────────────────────────────
    // "ดูจากราคาปัจจุบัน หายอดที่อยู่ทางซ้ายที่สูงพอ ถ้าพบว่ามีจุดสัมผัสมากกว่า 1 จุด ให้ใช้เป็นแนวต้านได้
    //  หรือ ถ้าไม่มีให้หาต่อไป ถ้าไม่มีเลย ให้ใช้แนวต้านสูงสุดของรอบคลื่นตัวเอง ในส่วนของ แนวรับก็เช่นกัน"
    // "รวมถึงกรอบบนด้วยนะ ไม่ใช่เส้นกรอบมาลอยๆ โดยไม่อิงกับยอดอะไรเลย อย่างน้อยต้องมี 1 จุด
    //  ถ้ามี สองจุดที่ต่ำกว่า ถือให้ใช้กรอบนั้น อย่างในรูปไม่รู้กรอบมาจากจุดยอดหรือเหวไหน"

    // ── Structural Candidate Pool (Confirmed Swings Only) ──────────────────────
    // 🔒 Dow Theory Rule: เน้นยืนยัน เหว หรือ ยอด เท่านั้น! ไม่นับแท่งเทียนหรือราคาแลบ
    // Candidates must be strictly within reachable span of maxChannelWidthPct from the wave low or price
    const anchorWaveLow = activeWaveLow ?? currentPrice;
    const anchorWaveHigh = activeWaveHigh ?? currentPrice;
    const maxResPrice = anchorWaveLow * (1 + (maxSpanPct / 100));
    const minSupPrice = anchorWaveHigh * (1 - (maxSpanPct / 100));

    // 1. Confirmed Resistance Candidates (sorted ascending by price)
    const resCandidates: { price: number; touchCount: number; points: SwingPoint[] }[] = [];
    for (const c of validResClusters.filter((c) => c.price <= maxResPrice)) {
      resCandidates.push(c);
    }
    for (const c of resClusters.filter((c) => c.touchCount < minTouchCount && c.price <= maxResPrice)) {
      // Skip sub-clusters whose points are already covered by a valid multi-touch cluster
      if (resCandidates.some((r) => r.touchCount >= minTouchCount && c.points.some((pt) => r.points.some((rpt) => rpt.time === pt.time)))) {
        continue;
      }
      if (!resCandidates.some((r) => Math.abs(r.price - c.price) / c.price < 0.001)) {
        resCandidates.push(c);
      }
    }
    for (const p of peakPoints.filter((s) => s.price <= maxResPrice)) {
      if (resCandidates.some((r) => r.points.some((pt) => pt.index === p.index || pt.time === p.time))) {
        continue;
      }
      if (!resCandidates.some((r) => Math.abs(r.price - p.price) / p.price < 0.001)) {
        resCandidates.push({ price: p.price, touchCount: 1, points: [p] });
      }
    }
    // Always ensure activeWaveHigh / activeCeiling is represented in resCandidates
    if (activeWaveHigh && !resCandidates.some((r) => Math.abs(r.price - activeWaveHigh) / activeWaveHigh < 0.001)) {
      const matchPeak = this.swingHighs.find((s) => Math.abs(s.price - activeWaveHigh) / activeWaveHigh < 0.001);
      resCandidates.push(matchPeak ? { price: matchPeak.price, touchCount: 1, points: [matchPeak] } : { price: activeWaveHigh, touchCount: 1, points: [] });
    }
    if (resCandidates.length === 0 && validResClusters.length > 0) {
      const nearestMulti = [...validResClusters].sort((a, b) => b.price - a.price)[0]!;
      resCandidates.push(nearestMulti);
    }
    if (resCandidates.length === 0 && this.swingHighs.length > 0) {
      const lastH = this.swingHighs[this.swingHighs.length - 1]!;
      resCandidates.push({ price: lastH.price, touchCount: 1, points: [lastH] });
    }
    // Strictly sort resistance candidates ascending by price
    resCandidates.sort((a, b) => a.price - b.price);

    // 2. Confirmed Support Candidates (sorted descending by price)
    const supCandidates: { price: number; touchCount: number; points: SwingPoint[] }[] = [];
    for (const c of validSupClusters.filter((c) => c.price >= minSupPrice)) {
      supCandidates.push(c);
    }
    for (const c of supClusters.filter((c) => c.touchCount < minTouchCount && c.price >= minSupPrice)) {
      if (supCandidates.some((s) => s.touchCount >= minTouchCount && c.points.some((pt) => s.points.some((spt) => spt.time === pt.time)))) {
        continue;
      }
      if (!supCandidates.some((s) => Math.abs(s.price - c.price) / c.price < 0.001)) {
        supCandidates.push(c);
      }
    }
    for (const l of this.swingLows.filter((s) => s.price >= minSupPrice)) {
      if (supCandidates.some((s) => s.points.some((pt) => pt.index === l.index || pt.time === l.time))) {
        continue;
      }
      if (!supCandidates.some((s) => Math.abs(s.price - l.price) / l.price < 0.001)) {
        supCandidates.push({ price: l.price, touchCount: 1, points: [l] });
      }
    }
    // Always ensure activeWaveLow / activeValley is represented in supCandidates
    if (activeWaveLow && !supCandidates.some((s) => Math.abs(s.price - activeWaveLow) / activeWaveLow < 0.001)) {
      const matchLow = this.swingLows.find((s) => Math.abs(s.price - activeWaveLow) / activeWaveLow < 0.001);
      supCandidates.push(matchLow ? { price: matchLow.price, touchCount: 1, points: [matchLow] } : { price: activeWaveLow, touchCount: 1, points: [] });
    }
    if (supCandidates.length === 0 && this.swingLows.length > 0) {
      const lastL = this.swingLows[this.swingLows.length - 1]!;
      supCandidates.push({ price: lastL.price, touchCount: 1, points: [lastL] });
    }
    // Strictly sort support candidates descending by price
    supCandidates.sort((a, b) => b.price - a.price);

    // ── 3. Find Optimal Structural Pair Fitting [minSpanPct, maxSpanPct] ─────────
    // Primary anchor: Active wave structure (activeWaveHigh & activeWaveLow)
    const targetAnchorRes = activeWaveHigh
      ? resCandidates.find((r) => Math.abs(r.price - activeWaveHigh) / activeWaveHigh <= tol)
      : undefined;
    const targetAnchorSup = activeWaveLow
      ? supCandidates.find((s) => Math.abs(s.price - activeWaveLow) / activeWaveLow <= tol)
      : undefined;

    // Baseline tradeable span floor: Strictly honor user's configured minSpanPct (e.g. 3.0%)
    const effectiveTradeableMinSpan = minSpanPct;

    let bestPair: {
      res: { price: number; touchCount: number; points: SwingPoint[] };
      sup: { price: number; touchCount: number; points: SwingPoint[] };
      score: number;
    } | undefined;

    for (let j = 0; j < resCandidates.length; j++) {
      const r = resCandidates[j]!;
      for (let i = 0; i < supCandidates.length; i++) {
        const s = supCandidates[i]!;
        if (r.price <= s.price) continue;

        const widthPct = ((r.price - s.price) / s.price) * 100;
        const isTradeableWidth = widthPct >= effectiveTradeableMinSpan && widthPct <= maxSpanPct;
        const meetsUserMinSpan = widthPct >= minSpanPct;

        let score: number;
        if (isTradeableWidth) {
          // 1. Multi-touch cluster bonus (touchCount >= 2): Top priority for structural multi-touch levels!
          const touchBonus = (r.touchCount >= 2 ? 3000 : 0) + (s.touchCount >= 2 ? 3000 : 0);

          // 2. Structural Anchor Bonus: Strongest affinity for the confirmed Active Wave High & Low
          const isTargetRes = Boolean(targetAnchorRes && Math.abs(r.price - targetAnchorRes.price) / r.price <= tol);
          const isTargetSup = Boolean(targetAnchorSup && Math.abs(s.price - targetAnchorSup.price) / s.price <= tol);
          const anchorBonus = (isTargetRes ? 4000 : 0) + (isTargetSup ? 4000 : 0);

          // 3. Bonus for meeting full user minSpanPct target
          const spanTargetBonus = meetsUserMinSpan ? 500 : 0;

          // 4. Priority for confirmed Lower High (LH) or Higher Low (HL) in wave structure
          const isAtWaveHigh = Boolean(activeWaveHigh && Math.abs(r.price - activeWaveHigh) / activeWaveHigh <= tol);
          const isAtWaveLow = Boolean(activeWaveLow && Math.abs(s.price - activeWaveLow) / activeWaveLow <= tol);
          const waveHighBonus = isAtWaveHigh ? (isConfirmedLowerHigh && r.touchCount >= 2 ? 1500 : 500) : 0;
          const waveLowBonus = isAtWaveLow ? 500 : 0;

          // 5. Heavy penalty for ancient lows that sit far below the active Higher Low / recent base valley
          const isRecentCanonicalLow = recentCanonicalLows.some((l) => Math.abs(l.price - s.price) / s.price <= tol);
          const ancientLowPenalty = (activeWaveLow && s.price < activeWaveLow * (1 - tol * 2) && !isRecentCanonicalLow) ? 6000 : 0;

          // 6. Prefer pairs where support matches the current active wave base/valley
          const currentBaseBonus = (activeWaveLow && Math.abs(s.price - activeWaveLow) / activeWaveLow <= tol) ? 2000 : 0;

          // 7. Absolute Structural Swing Stability:
          // Strictly anchor to confirmed peaks & valleys. Zero tick price penalties/bonuses!
          score = 10000 + touchBonus + anchorBonus + spanTargetBonus + waveHighBonus + waveLowBonus + currentBaseBonus - ancientLowPenalty;
        } else if (widthPct < effectiveTradeableMinSpan) {
          // Narrow structural pair: Score by touches, active wave alignment, and proximity to tradeable span
          const touchBonus = (r.touchCount >= 2 ? 1500 : 0) + (s.touchCount >= 2 ? 1500 : 0);
          const isTargetRes = Boolean(targetAnchorRes && Math.abs(r.price - targetAnchorRes.price) / r.price <= tol);
          const isTargetSup = Boolean(targetAnchorSup && Math.abs(s.price - targetAnchorSup.price) / s.price <= tol);
          const anchorBonus = (isTargetRes ? 2000 : 0) + (isTargetSup ? 2000 : 0);
          const currentBaseBonus = (activeWaveLow && Math.abs(s.price - activeWaveLow) / activeWaveLow <= tol) ? 1000 : 0;
          score = 5000 + (widthPct * 50) + touchBonus + anchorBonus + currentBaseBonus;
        } else {
          // Too wide (> maxSpanPct): VIOLATES MAX CHANNEL WIDTH!
          const excessWidth = widthPct - maxSpanPct;
          score = Math.max(0, 50 - excessWidth * 10);
        }

        if (!bestPair || score > bestPair.score) {
          bestPair = { res: r, sup: s, score };
        }
      }
    }

    const bestRes = bestPair?.res;
    const bestSup = bestPair?.sup;

    return {
      resistance: bestRes,
      support: bestSup,
      allResistanceClusters: resClusters.filter((c) => c.touchCount >= minTouchCount),
      allSupportClusters: supClusters.filter((c) => c.touchCount >= minTouchCount),
    };
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

    // 1. Check annotated structural wave swings (if the wave cycle already labeled a confirmed "HL" after the lowest dump)
    const wave = this.calculateWaveCycles();
    if (wave && wave.annotatedSwings.length > 0) {
      const postDumpSwings = wave.annotatedSwings.filter(
        (s) => s.type === "LOW" && s.price > lowestDumpPrice * 1.0005 && (s.time >= sinceTime - 1800 || s.dowLabel === "HL")
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

    // 2. Check confirmed swing lows formed at or after the breakdown (with 30-minute leeway)
    const recentConfirmedLows = this.swingLows.filter((s) => s.time >= sinceTime - 1800);

    if (recentConfirmedLows.length === 0) {
      const lastLow = this.swingLows[this.swingLows.length - 1];
      const prevLow = this.swingLows.length >= 2 ? this.swingLows[this.swingLows.length - 2] : undefined;

      if (lastLow) {
        const isHigherThanDump = lastLow.price > lowestDumpPrice * 1.0005;
        const isHigherThanPrev = prevLow ? lastLow.price > prevLow.price : false;
        const isPriceAboveLow = currentPrice ? currentPrice >= lastLow.price : true;

        if (isHigherThanDump && (isHigherThanPrev || lastLow.price >= referenceFloor) && isPriceAboveLow) {
          return {
            confirmed: true,
            higherLow: lastLow,
            reason: `Confirmed Swing Low at $${lastLow.price.toFixed(6)} > lowest dump $${lowestDumpPrice.toFixed(6)}`,
          };
        }
      }
      return { confirmed: false, reason: "Waiting for confirmed swing low pivot" };
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

    // ── 1. Downtrend Resistance Line: Requires at least 3 touch points (P1 + at least 2 LHs) ──
    // ตามทฤษฎี Dow Theory:
    // P1: ต้องเริ่มจากจุดยอด (The Major High) ของรอบคลื่นที่ส่งราคาลงมาทำจุดต่ำสุด (LL ล่าสุด)
    // เงื่อนไขเข้มงวด: ต้องมีจุดสัมผัส (Touches) ลากผ่านอย่างน้อย 3 จุดขึ้นไป (P1 + 2 LHs ที่อยู่บนหรือใกล้เส้นมาก <= 0.25%)
    // เพื่อป้องกันเส้นลากจาก 2 จุดที่มักจะชันเกินไป หากมีไม่ถึง 3 จุด ให้ถือว่ายังไม่มีเส้นกด (downtrendLine = undefined)
    if (confirmedHighs.length >= 3 && confirmedLows.length > 0) {
      const latestLlCandidate = lastLl ?? confirmedLows.reduce((min, l) => (l.price < min.price ? l : min), confirmedLows[confirmedLows.length - 1]!);
      const highsBeforeLl = confirmedHighs.filter((h) => h.index < latestLlCandidate.index);
      
      let p1: SwingPoint | undefined;
      if (highsBeforeLl.length > 0) {
        p1 = highsBeforeLl.reduce((max, h) => (h.price > max.price ? h : max), highsBeforeLl[0]!);
      } else if (lastHh) {
        p1 = confirmedHighs.find((h) => h.index === lastHh.index) ?? lastHh;
      } else if (activePeak) {
        p1 = confirmedHighs.find((h) => h.index === activePeak.index) ?? activePeak;
      }

      if (p1) {
        const candidateSubHighs = confirmedHighs.filter(
          (h) => h.index > p1!.index && h.price < p1!.price && h.time > p1!.time
        );

        // ต้องมี Sub Highs อย่างน้อย 2 จุดขึ้นไป (เพื่อรวมกับ P1 แล้วได้ >= 3 จุด)
        if (candidateSubHighs.length >= 2) {
          let bestP2: SwingPoint | undefined;
          let bestSlope = -Infinity;
          let bestTouchCount = 0;

          // ทดสอบคู่เส้นที่ลากจาก P1 ไปยังแต่ละ candidate P2
          for (const p2 of candidateSubHighs) {
            const timeDiff = p2.time - p1.time;
            const priceDiff = p2.price - p1.price;
            const slope = priceDiff / timeDiff;
            if (slope >= 0) continue; // ต้องเป็นเส้นกดขาลงเท่านั้น

            let violates = false;
            let touchCount = 1; // นับ P1 เป็นจุดที่ 1

            for (const midHigh of candidateSubHighs) {
              const lineVal = p1.price + slope * (midHigh.time - p1.time);
              // หากมียอดใดทะลุเหนือเส้นเกิน 0.05% ถือว่าเส้นผิด (ถูกทะลุ)
              if (midHigh.price > lineVal * 1.0005) {
                violates = true;
                break;
              }
              // ถ้ายอดอยู่ใกล้เส้นในระยะ tolerance <= 0.25% ให้นับเป็นจุดสัมผัส
              if (Math.abs(midHigh.price - lineVal) / lineVal <= 0.0025) {
                touchCount++;
              }
            }

            if (!violates && touchCount >= 3) {
              // เลือกเส้นที่มีจุดสัมผัสมากที่สุด หรือถ้าเท่ากันให้เลือก slope ที่ดีที่สุด (outermost)
              if (touchCount > bestTouchCount || (touchCount === bestTouchCount && slope > bestSlope)) {
                bestSlope = slope;
                bestP2 = p2;
                bestTouchCount = touchCount;
              }
            }
          }

          // การันตีว่าต้องมีอย่างน้อย 3 จุดสัมผัสจริงๆ ถึงจะยอมรับเป็น Downtrend Line
          if (bestP2 && Number.isFinite(bestSlope) && bestSlope < 0 && bestTouchCount >= 3) {
            const currentLinePrice = p1.price + bestSlope * (latestTime - p1.time);
            if (currentLinePrice > 0) {
              const points: TrendLinePoint[] = [];
              for (let cIdx = p1.index; cIdx < n; cIdx++) {
                const c = this.candles[cIdx];
                if (!c) continue;
                const val = p1.price + bestSlope * (c.time - p1.time);
                points.push({ time: c.time, value: Number(val.toFixed(6)) });
              }

              // ตรวจสอบการเบรคทะลุเส้นกด (Close > TrendLine)
              let brokenCandleCount = 0;
              for (let i = n - 1; i >= p1.index; i--) {
                const c = this.candles[i];
                if (!c) break;
                const lineVal = p1.price + bestSlope * (c.time - p1.time);
                const testPrice = i === n - 1 ? Math.max(currentPrice, c.close) : c.close;
                if (testPrice > lineVal) {
                  brokenCandleCount++;
                } else {
                  break;
                }
              }

              const breakoutConfirmed = brokenCandleCount >= 2;
              if (breakoutConfirmed) {
                downtrendBreakoutConfirmed = true;
              } else {
                downtrendLine = {
                  type: "DOWNTREND",
                  p1,
                  p2: bestP2,
                  slope: bestSlope,
                  currentLinePrice,
                  isBroken: false,
                  breakoutPct: ((currentPrice - currentLinePrice) / currentLinePrice) * 100,
                  brokenCandleCount,
                  breakoutConfirmed: false,
                  points,
                };
              }
            }
          }
        }
      }
    }

    // ── 2. Uptrend Support Line: Requires at least 3 touch points (V1 + at least 2 HLs) ──
    // ตามทฤษฎี Dow Theory:
    // V1: ต้องเริ่มจากจุดต่ำสุดของรอบทุบ (The Lowest Low / LL) ล่าสุด
    // เงื่อนไขเข้มงวด: ต้องมีจุดสัมผัส (Touches) ลากผ่านอย่างน้อย 3 จุดขึ้นไป (V1 + 2 HLs ที่อยู่บนหรือใกล้เส้นมาก <= 0.25%)
    // หากมีไม่ถึง 3 จุด ให้ถือว่ายังไม่มีเส้นรับ (uptrendLine = undefined) ป้องกันเส้นชันเกินไป
    if (confirmedLows.length >= 3) {
      const v1 = lastLl ?? confirmedLows.reduce((min, l) => (l.price < min.price ? l : min), confirmedLows[confirmedLows.length - 1]!);

      if (v1) {
        const candidateSubLows = confirmedLows.filter(
          (l) => l.index > v1.index && l.price > v1.price && l.time > v1.time
        );

        // ต้องมี Sub Lows อย่างน้อย 2 จุดขึ้นไป (เพื่อรวมกับ V1 แล้วได้ >= 3 จุด)
        if (candidateSubLows.length >= 2) {
          let bestV2: SwingPoint | undefined;
          let bestSlope = Infinity;
          let bestTouchCount = 0;

          // ทดสอบคู่เส้นที่ลากจาก V1 ไปยังแต่ละ candidate V2
          for (const v2 of candidateSubLows) {
            const timeDiff = v2.time - v1.time;
            const priceDiff = v2.price - v1.price;
            const slope = priceDiff / timeDiff;
            if (slope <= 0) continue; // ต้องเป็นเส้นรับขาขึ้นเท่านั้น

            let violates = false;
            let touchCount = 1; // นับ V1 เป็นจุดที่ 1

            for (const midLow of candidateSubLows) {
              const lineVal = v1.price + slope * (midLow.time - v1.time);
              // หากมีเหวใดหลุดต่ำกว่าเส้นเกิน 0.05% ถือว่าเส้นผิด (ถูกหลุด)
              if (midLow.price < lineVal * 0.9995) {
                violates = true;
                break;
              }
              // ถ้าเหวอยู่ใกล้เส้นในระยะ tolerance <= 0.25% ให้นับเป็นจุดสัมผัส
              if (Math.abs(midLow.price - lineVal) / lineVal <= 0.0025) {
                touchCount++;
              }
            }

            if (!violates && touchCount >= 3) {
              // เลือกเส้นที่มีจุดสัมผัสมากที่สุด หรือถ้าเท่ากันให้เลือก slope ที่ดีที่สุด (outermost)
              if (touchCount > bestTouchCount || (touchCount === bestTouchCount && slope < bestSlope)) {
                bestSlope = slope;
                bestV2 = v2;
                bestTouchCount = touchCount;
              }
            }
          }

          // การันตีว่าต้องมีอย่างน้อย 3 จุดสัมผัสจริงๆ ถึงจะยอมรับเป็น Uptrend Line
          if (bestV2 && Number.isFinite(bestSlope) && bestSlope > 0 && bestTouchCount >= 3) {
            const currentLinePrice = v1.price + bestSlope * (latestTime - v1.time);
            if (currentLinePrice > 0) {
              const points: TrendLinePoint[] = [];
              for (let cIdx = v1.index; cIdx < n; cIdx++) {
                const c = this.candles[cIdx];
                if (!c) continue;
                const val = v1.price + bestSlope * (c.time - v1.time);
                points.push({ time: c.time, value: Number(val.toFixed(6)) });
              }

              // ตรวจสอบการหลุดเส้นรับ (Close < TrendLine)
              let brokenCandleCount = 0;
              for (let i = n - 1; i >= v1.index; i--) {
                const c = this.candles[i];
                if (!c) break;
                const lineVal = v1.price + bestSlope * (c.time - v1.time);
                const testPrice = i === n - 1 ? Math.min(currentPrice, c.close) : c.close;
                if (testPrice < lineVal) {
                  brokenCandleCount++;
                } else {
                  break;
                }
              }

              const breakoutConfirmed = brokenCandleCount >= 2;
              if (breakoutConfirmed) {
                uptrendBreakdownConfirmed = true;
              } else {
                uptrendLine = {
                  type: "UPTREND",
                  p1: v1,
                  p2: bestV2,
                  slope: bestSlope,
                  currentLinePrice,
                  isBroken: false,
                  breakoutPct: ((currentLinePrice - currentPrice) / currentLinePrice) * 100,
                  brokenCandleCount,
                  breakoutConfirmed: false,
                  points,
                };
              }
            }
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

        if (!lastLow) {
          dowLabel = "LL";
          lastLowLabel = "LL";
        } else {
          changePct = ((s.price - lastLow.price) / lastLow.price) * 100;
          if (s.price > lastLow.price) {
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

    const price = currentPrice ?? fallbackPrice;
    const n = this.candles.length;
    const k = Math.max(2, this.pivotWindow || 3);
    const mode = options?.mode ?? "DOW_ATR_CLAMP";
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
        const c = this.candles[idx];
        if (!c) continue;

        // Number of fully closed candles formed strictly after idx (candle n - 1 is currently open/live)
        const followingClosedCandles = Math.max(0, (n - 2) - idx);
        const candEffHigh = getEffectiveHigh(c, useTrueWick, this.wickThresholdPct);
        const candEffLow = getEffectiveLow(c, useTrueWick, this.wickThresholdPct);

        let isCandHigh = true;
        for (let j = idx - k; j < idx; j++) {
          const prev = this.candles[j];
          if (prev && getEffectiveHigh(prev, useTrueWick, this.wickThresholdPct) > candEffHigh) {
            isCandHigh = false;
            break;
          }
        }
        if (isCandHigh) {
          for (let j = idx + 1; j <= Math.min(n - 2, idx + k); j++) {
            const next = this.candles[j];
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
          const prev = this.candles[j];
          if (prev && getEffectiveLow(prev, useTrueWick, this.wickThresholdPct) < candEffLow) {
            isCandLow = false;
            break;
          }
        }
        if (isCandLow) {
          for (let j = idx + 1; j <= Math.min(n - 2, idx + k); j++) {
            const next = this.candles[j];
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

    // Detect if market bottomed at macroLow and is in an active recovery / new wave cycle:
    // (trough occurred after macroPeak, and swings formed at or after macroLow)
    const isNewCycleFromLow = Boolean(
      macroLow &&
      macroPeak &&
      macroLow.index > macroPeak.index &&
      canonicalHighs.some((h) => h.index > macroLow.index)
    );

    // Active cycle swings: When in new cycle from bottom, candidate swings MUST be formed at or after macroLow!
    const activeCycleHighs = (isNewCycleFromLow && macroLow)
      ? canonicalHighs.filter((h) => h.index > macroLow.index)
      : (macroPeak && price < macroPeak.price * 0.999 ? canonicalHighs.filter((h) => h.index >= macroPeak.index) : canonicalHighs);
    const activeCycleLows = (isNewCycleFromLow && macroLow)
      ? canonicalLows.filter((l) => l.index >= macroLow.index)
      : canonicalLows;

    const recentCanonicalLows = activeCycleLows.slice(-4);
    const recentCanonicalHighs = activeCycleHighs.slice(-4);

    let baseValley: SwingPoint | undefined;
    if (recentCanonicalLows.length > 0) {
      // Check if there is a confirmed Higher Low (HL) that price is actively respecting (price >= hl.price * 0.995).
      // Since canonicalLows are strictly alternating with peaks, any candLow with candLow.price > priorLow.price
      // is a genuine structural Higher Low with an intervening peak to its left!
      let confirmedHl: SwingPoint | undefined;
      for (let i = recentCanonicalLows.length - 1; i >= 1; i--) {
        const candLow = recentCanonicalLows[i]!;
        const priorLow = recentCanonicalLows[i - 1]!;
        if (candLow.price > priorLow.price && price >= candLow.price * 0.995) {
          confirmedHl = candLow;
          break;
        }
      }

      if (confirmedHl) {
        baseValley = confirmedHl;
      } else {
        let minLow = recentCanonicalLows[0]!;
        for (const l of recentCanonicalLows) {
          if (l.price < minLow.price) minLow = l;
        }
        baseValley = minLow;
      }
    } else if (activeCycleLows.length > 0) {
      baseValley = activeCycleLows[activeCycleLows.length - 1];
    } else if (canonicalLows.length > 0) {
      baseValley = canonicalLows[canonicalLows.length - 1];
    } else if (confirmedLows.length > 0) {
      baseValley = confirmedLows[confirmedLows.length - 1];
    }

    activeValley = baseValley;
    const waveStartIndex = (isNewCycleFromLow && macroLow)
      ? macroLow.index
      : (baseValley ? baseValley.index : (recentCanonicalLows[0]?.index ?? 0));

    // Highs formed in the active wave (post-valley or post-macroLow)
    const highsInActiveWave = canonicalHighs.filter((s) => s.index >= waveStartIndex);

    // 🔒 Dow Theory Rule ("ถ้ายอดในราคาปัจจุบันทำ Lower high สามารถปรับลดกรอบลงมาได้"):
    // Check if the latest confirmed canonical swing high is a Lower High (LH) that price is actively respecting (price <= lh.price * 1.005).
    // If so, the active wave ceiling should step down to this Lower High!
    // Otherwise, if the market made an HH or hasn't formed an LH, maintain the peak at the major high ("ถ้ายังไม่ทำ LH ไม่ควรปรับลดกรอบลงมา").
    const lastCanonicalHigh = activeCycleHighs.length > 0 ? activeCycleHighs[activeCycleHighs.length - 1] : undefined;
    const minSpanRequired = (options?.minChannelWidthPct ?? 1.8) / 100;
    const isLatestHighLh = Boolean(
      lastCanonicalHigh &&
      (lastCanonicalHigh.dowLabel === "LH" || (activeCycleHighs.length >= 2 && lastCanonicalHigh.price < activeCycleHighs[activeCycleHighs.length - 2]!.price)) &&
      price <= lastCanonicalHigh.price * 1.0005 &&
      (!baseValley || (lastCanonicalHigh.price - baseValley.price) / baseValley.price >= minSpanRequired)
    );

    if (isLatestHighLh && lastCanonicalHigh) {
      activePeak = lastCanonicalHigh;
    } else if (highsInActiveWave.length > 0) {
      let maxHigh = highsInActiveWave[0]!;
      for (const h of highsInActiveWave) {
        if (h.price > maxHigh.price) maxHigh = h;
      }
      activePeak = maxHigh;
    } else if (recentCanonicalHighs.length > 0) {
      let maxHigh = recentCanonicalHighs[0]!;
      for (const h of recentCanonicalHighs) {
        if (h.price > maxHigh.price) maxHigh = h;
      }
      activePeak = maxHigh;
    } else if (activeCycleHighs.length > 0) {
      activePeak = activeCycleHighs[activeCycleHighs.length - 1];
    } else if (canonicalHighs.length > 0) {
      activePeak = canonicalHighs[canonicalHighs.length - 1];
    } else if (confirmedHighs.length > 0) {
      activePeak = confirmedHighs[confirmedHighs.length - 1];
    }

    let recentMajorHigh: SwingPoint | undefined;
    if (isLatestHighLh && lastCanonicalHigh) {
      recentMajorHigh = lastCanonicalHigh;
    } else if (recentCanonicalHighs.length > 0) {
      let maxHigh = recentCanonicalHighs[0]!;
      for (const h of recentCanonicalHighs) {
        if (h.price > maxHigh.price) maxHigh = h;
      }
      recentMajorHigh = maxHigh;
    } else if (activeCycleHighs.length > 0) {
      let maxHigh = activeCycleHighs[0]!;
      for (const h of activeCycleHighs) {
        if (h.price > maxHigh.price) maxHigh = h;
      }
      recentMajorHigh = maxHigh;
    }
    const activeCeilingPoint = (recentMajorHigh && (!activePeak || recentMajorHigh.price > activePeak.price))
      ? recentMajorHigh
      : activePeak;

    let clampStatus: GridZone["clampStatus"] = "NATURAL_SWING";
    let anchorSide: GridZone["anchorSide"] = "NONE";
    let rawWidthPct: number | undefined;
    let minWidthPct: number | undefined;
    let maxWidthPct: number | undefined;
    let srResult: ReturnType<typeof this.findMultiTouchSR> | undefined;

    // Always run Multi-Touch S/R analysis from the calculated swings
    const srLookback = options?.srLookbackCandles ?? 300;
    const srMinTouches = options?.srMinTouchCount ?? 2;
    const srTol = options?.srTouchTolerancePct ?? 1.0;
    const minPct = (options?.minChannelWidthPct ?? 1.8) / 100;
    const maxPct = (options?.maxChannelWidthPct ?? 6.0) / 100;
    const minSpan = price * minPct;
    const maxSpan = price * maxPct;

    srResult = this.findMultiTouchSR(
      price,
      srLookback,
      srMinTouches,
      srTol,
      options?.minChannelWidthPct ?? 1.8,
      options?.maxChannelWidthPct ?? 6.0,
      activeCeilingPoint?.price,
      activeValley?.price,
      isLatestHighLh,
    );

    // ── 4. Calculate Final Bounds by Selected Channel Mode ────────────────────
    if (mode === "MULTI_TOUCH_SR") {
      let foundFloor = false;
      let foundCeiling = false;

      if (srResult.support && srResult.resistance) {
        bottomBound = srResult.support.price;
        upperBound = srResult.resistance.price;
        foundFloor = true;
        foundCeiling = true;
      } else if (srResult.support && !srResult.resistance) {
        bottomBound = srResult.support.price;
        foundFloor = true;
        const peakCeil = (activeCeilingPoint && activeCeilingPoint.price > price)
          ? activeCeilingPoint.price
          : (activePeak && activePeak.price > price)
            ? activePeak.price
            : this.swingHighs.filter((s) => s.price > price * 1.001).pop()?.price;
        upperBound = (peakCeil !== undefined && peakCeil > bottomBound)
          ? peakCeil
          : Math.max(price * (1 + minPct / 2), bottomBound + minSpan);
      } else if (!srResult.support && srResult.resistance) {
        upperBound = srResult.resistance.price;
        foundCeiling = true;
        // If no multi-touch support below price, check recent confirmed swing low first (Higher Low / local base), fallback to active wave valley or nearest valid swing low
        const recentLowsBelowPrice = this.swingLows.filter((l) => l.price < Math.min(price * 0.999, upperBound * 0.999)).sort((a, b) => b.price - a.price);
        const recentConfirmedLow = recentLowsBelowPrice.length > 0 ? recentLowsBelowPrice[0]?.price : undefined;
        const lowestWaveValley = (activeValley && activeValley.price < upperBound) ? activeValley.price : recentConfirmedLow;
        bottomBound = lowestWaveValley ?? (recentConfirmedLow ?? Math.min(price * (1 - minPct / 2), upperBound - minSpan));
        foundFloor = lowestWaveValley !== undefined || recentConfirmedLow !== undefined;
      } else {
        // Neither side has multi-touch: use recent confirmed swings
        const recentLowsBelowPrice = this.swingLows.filter((l) => l.price < price * 0.999);
        const recentConfirmedLow = recentLowsBelowPrice.length > 0 ? recentLowsBelowPrice[recentLowsBelowPrice.length - 1]?.price : undefined;
        const lowestWaveValley = recentConfirmedLow ?? activeValley?.price;
        const highestWavePeak = (activeCeilingPoint && activeCeilingPoint.price > price)
          ? activeCeilingPoint.price
          : (activePeak && activePeak.price > price)
            ? activePeak.price
            : this.swingHighs.filter((s) => s.price > price * 1.001).pop()?.price;
        bottomBound = lowestWaveValley ?? price * (1 - minPct / 2);
        upperBound = highestWavePeak ?? price * (1 + minPct / 2);
        foundFloor = lowestWaveValley !== undefined;
        foundCeiling = highestWavePeak !== undefined;
      }

      isSwingConfirmed = true;

      // Handle channel clamping:
      const minSpanFromPct = price * minPct;
      const maxSpanFromPct = price * maxPct;

      if (srResult.support && srResult.resistance) {
        // 🔒 BOTH bounds are confirmed structural touch levels fitting [minPct, maxPct]!
        // Lock 100% onto the structural touch levels without artificial dilation.
        bottomBound = srResult.support.price;
        upperBound = srResult.resistance.price;

        // 🔒 Enforce MAX CHANNEL WIDTH (maxSpanFromPct):
        // If the multi-touch span exceeds maxSpanFromPct (e.g. 8.24% > 6.0%):
        if (upperBound - bottomBound > maxSpanFromPct) {
          const isDowntrendWave = waveCycle.currentLeg?.direction === "DOWN" || Boolean(waveCycle.lastLh) || (lastCanonicalHigh && lastCanonicalHigh.dowLabel === "LH") || price < (bottomBound + upperBound) / 2;
          if (isDowntrendWave) {
            const validHighs = (activeCycleHighs.length > 0 ? activeCycleHighs : canonicalHighs)
              .filter((h) => h.price > price && h.price - bottomBound >= minSpanFromPct && h.price - bottomBound <= maxSpanFromPct)
              .sort((a, b) => b.price - a.price);

            if (validHighs.length > 0) {
              upperBound = validHighs[0]!.price;
              clampStatus = "NATURAL_SWING";
            } else {
              upperBound = bottomBound + maxSpanFromPct;
              clampStatus = "CLAMPED_MAX";
            }
          } else {
            // In Uptrend: Lift floor up to the lowest confirmed Higher Low within maxSpanFromPct!
            const validLows = canonicalLows
              .filter((l) => l.price < price && upperBound - l.price >= minSpanFromPct && upperBound - l.price <= maxSpanFromPct)
              .sort((a, b) => a.price - b.price);

            if (validLows.length > 0) {
              bottomBound = validLows[0]!.price;
              clampStatus = "NATURAL_SWING";
            } else {
              bottomBound = upperBound - maxSpanFromPct;
              clampStatus = "CLAMPED_MAX";
            }
          }
        } else {
          clampStatus = "NATURAL_SWING";
          anchorSide = "NONE";
        }
      } else if (srResult.resistance && !srResult.support) {
        // 🔒 Resistance is confirmed! Ceiling strictly locked to resistance peaks.
        upperBound = srResult.resistance.price;
        if (upperBound - bottomBound > maxSpanFromPct) {
          bottomBound = upperBound - maxSpanFromPct;
          clampStatus = "CLAMPED_MAX";
        } else {
          clampStatus = "NATURAL_SWING";
        }
        anchorSide = "UPPER_CEILING";
      } else if (!srResult.resistance && srResult.support) {
        // 🔒 Support is confirmed! Floor strictly locked to support valleys.
        bottomBound = srResult.support.price;
        if (upperBound - bottomBound > maxSpanFromPct) {
          upperBound = bottomBound + maxSpanFromPct;
          clampStatus = "CLAMPED_MAX";
        } else {
          clampStatus = "NATURAL_SWING";
        }
        anchorSide = "LOWER_FLOOR";
      } else {
        // Neither side has multi-touch: keep bounds locked to genuine structural swings without dilation
        if (foundFloor && foundCeiling) {
          if (upperBound - bottomBound > maxSpanFromPct) {
            const isDowntrendWave = waveCycle.currentLeg?.direction === "DOWN" || Boolean(waveCycle.lastLh) || (lastCanonicalHigh && lastCanonicalHigh.dowLabel === "LH") || price < (bottomBound + upperBound) / 2;
            if (isDowntrendWave) {
              upperBound = bottomBound + maxSpanFromPct;
            } else {
              bottomBound = upperBound - maxSpanFromPct;
            }
            clampStatus = "CLAMPED_MAX";
          } else {
            clampStatus = "NATURAL_SWING";
            anchorSide = "NONE";
          }
        } else if (foundFloor && !foundCeiling) {
          clampStatus = "NATURAL_SWING";
          anchorSide = "LOWER_FLOOR";
        } else if (!foundFloor && foundCeiling) {
          clampStatus = "NATURAL_SWING";
          anchorSide = "UPPER_CEILING";
        }
      }

      rawWidthPct = bottomBound > 0 ? ((upperBound - bottomBound) / bottomBound) * 100 : 0;
      minWidthPct = (minSpan / price) * 100;
      maxWidthPct = (maxSpan / price) * 100;
    } else if (mode === "DONCHIAN_ATR") {
      const lookback = Math.min(n, options?.donchianLookback ?? 20);
      const donchianCandles = this.candles.slice(Math.max(0, n - lookback));
      const allLows = donchianCandles.map((c) => (useTrueWick ? c.low : getEffectiveLow(c, false))).filter(Number.isFinite);
      const allHighs = donchianCandles.map((c) => (useTrueWick ? c.high : getEffectiveHigh(c, false))).filter(Number.isFinite);

      const rawBottom = allLows.length > 0 ? Math.min(...allLows) : price * 0.985;
      const rawUpper = allHighs.length > 0 ? Math.max(...allHighs) : price * 1.015;

      const minDonchianSpan = Math.max(price * 0.015, price * effAtrPct * 2.0);

      if (srResult?.support && srResult?.resistance) {
        bottomBound = srResult.support.price;
        upperBound = srResult.resistance.price;
      } else if (srResult?.resistance) {
        upperBound = srResult.resistance.price;
        bottomBound = upperBound - minDonchianSpan;
      } else if (srResult?.support) {
        bottomBound = srResult.support.price;
        upperBound = bottomBound + minDonchianSpan;
      } else {
        bottomBound = price * (1 - minPct / 2);
        upperBound = price * (1 + minPct / 2);
      }
      isSwingConfirmed = true;

      if (upperBound - bottomBound < minDonchianSpan) {
        upperBound = bottomBound + minDonchianSpan;
      }
    } else {
      let rawBottom: number;
      let rawUpper: number;

      if (activeValley) {
        rawBottom = activeValley.price;
        isSwingConfirmed = true;
      } else {
        const closedCandles = this.candles.slice(0, Math.max(1, n - k));
        const allLows = closedCandles.map((c) => getEffectiveLow(c, useTrueWick)).filter(Number.isFinite);
        rawBottom = allLows.length > 0 ? Math.min(...allLows) : price * 0.985;
      }

      if (activePeak) {
        rawUpper = activePeak.price;
        isSwingConfirmed = true;
      } else {
        const closedCandles = this.candles.slice(0, Math.max(1, n - k));
        const allHighs = closedCandles.map((c) => getEffectiveHigh(c, useTrueWick)).filter(Number.isFinite);
        rawUpper = allHighs.length > 0 ? Math.max(...allHighs) : price * 1.015;
      }

      let minSpan: number;
      let maxSpan: number;

      if (mode === "FIXED_PCT_CLAMP") {
        const minPct = (options?.minChannelWidthPct ?? 1.8) / 100;
        const maxPct = (options?.maxChannelWidthPct ?? 4.0) / 100;
        minSpan = price * minPct;
        maxSpan = price * maxPct;
      } else {
        // Default: DOW_ATR_CLAMP (Dynamic ATR min/max width clamping & true wick support)
        const minMult = options?.atrMinMultiplier ?? 2.5;
        const maxMult = options?.atrMaxMultiplier ?? 5.0;
        const minFromPct = (options?.minChannelWidthPct && options.minChannelWidthPct > 0) ? price * (options.minChannelWidthPct / 100) : price * 0.015;
        const maxFromPct = (options?.maxChannelWidthPct && options.maxChannelWidthPct > 0) ? price * (options.maxChannelWidthPct / 100) : price * 0.05;

        // ATR-scaled spans
        minSpan = Math.max(minFromPct, Math.min(price * effAtrPct * minMult, maxFromPct * 0.5));
        maxSpan = Math.max(minSpan * 1.5, Math.max(maxFromPct, price * effAtrPct * maxMult));
      }

      rawWidthPct = rawBottom > 0 ? ((rawUpper - rawBottom) / rawBottom) * 100 : 0;
      minWidthPct = price > 0 ? (minSpan / price) * 100 : 0;
      maxWidthPct = Number.isFinite(maxSpan) && price > 0 ? (maxSpan / price) * 100 : undefined;

      if (srResult?.support && srResult?.resistance) {
        // Both multi-touch levels confirmed from calculated swings! Lock onto exact structural levels
        bottomBound = srResult.support.price;
        upperBound = srResult.resistance.price;
        clampStatus = "NATURAL_SWING";
        anchorSide = "NONE";
      } else if (srResult?.resistance && !srResult?.support) {
        // Resistance has confirmed multi-touches! Anchor ceiling to resistance.
        // For floor, use active wave valley (เหวที่ต่ำสุดของรอบคลื่นตัวเอง)
        upperBound = srResult.resistance.price;
        const candidateFloor = activeValley?.price
          ?? (this.swingLows.length > 0 ? this.swingLows[this.swingLows.length - 1]?.price : undefined);
        bottomBound = (candidateFloor !== undefined && candidateFloor < upperBound)
          ? candidateFloor
          : upperBound - minSpan;
        if (candidateFloor !== undefined && candidateFloor < upperBound) {
          clampStatus = "NATURAL_SWING";
          anchorSide = "NONE";
        } else {
          clampStatus = "CLAMPED_MIN";
          anchorSide = "UPPER_CEILING";
        }
      } else if (!srResult?.resistance && srResult?.support) {
        // Support has confirmed multi-touches! Anchor floor to support.
        // For ceiling, use active ceiling so it strictly aligns with the major calculated swing peak on the chart!
        bottomBound = srResult.support.price;
        const candidateCeil = activeCeilingPoint?.price
          ?? activePeak?.price
          ?? (this.swingHighs.length > 0 ? this.swingHighs[this.swingHighs.length - 1]?.price : undefined);
        upperBound = (candidateCeil !== undefined && candidateCeil > bottomBound)
          ? candidateCeil
          : bottomBound + minSpan;
        if (candidateCeil !== undefined && candidateCeil > bottomBound) {
          clampStatus = "NATURAL_SWING";
          anchorSide = "NONE";
        } else {
          clampStatus = "CLAMPED_MIN";
          anchorSide = "LOWER_FLOOR";
        }
      } else {
        // Neither side has confirmed multi-touch swings; anchor to calculated active wave swings
        // "ถ้าไม่มีเลย ให้ใช้แนวต้านสูงสุดของรอบคลื่นตัวเอง ในส่วนของ แนวรับก็เช่นกัน"
        const candidateFloor = activeValley?.price
          ?? (this.swingLows.length > 0 ? this.swingLows[this.swingLows.length - 1]?.price : undefined);
        const candidateCeil = activeCeilingPoint?.price
          ?? activePeak?.price
          ?? (this.swingHighs.length > 0 ? this.swingHighs[this.swingHighs.length - 1]?.price : undefined);
        bottomBound = candidateFloor ?? price * (1 - minPct / 2);
        upperBound = candidateCeil ?? price * (1 + minPct / 2);
        if (candidateFloor !== undefined && candidateCeil !== undefined && candidateCeil > candidateFloor) {
          clampStatus = "NATURAL_SWING";
          anchorSide = "NONE";
        } else {
          clampStatus = "CLAMPED_MIN";
          anchorSide = "NONE";
        }
      }

      // Enforce minSpan
      const minSpanFromPct = (options?.minChannelWidthPct && options.minChannelWidthPct > 0)
        ? price * (options.minChannelWidthPct / 100)
        : price * 0.018;

      if (clampStatus === "NATURAL_SWING" || (srResult?.support && srResult?.resistance)) {
        // Both bounds anchored to genuine structural points: keep bounds locked without dilation!
        clampStatus = "NATURAL_SWING";
        anchorSide = "NONE";
      } else if (anchorSide === "UPPER_CEILING") {
        clampStatus = "NATURAL_SWING";
      } else if (anchorSide === "LOWER_FLOOR") {
        clampStatus = "NATURAL_SWING";
      } else {
        clampStatus = "NATURAL_SWING";
      }
    }

    // 🔒 Dow Theory overrides for DOW_ATR_CLAMP / FIXED_PCT_CLAMP modes only.
    // In MULTI_TOUCH_SR mode, boundaries are strictly and cleanly determined by structural clusters above.
    if (mode !== "MULTI_TOUCH_SR") {
      const macroPeak = canonicalHighs.length > 0
        ? canonicalHighs.reduce((max, h) => (!max || h.price > max.price ? h : max), canonicalHighs[0]!)
        : undefined;
      const postPeakHighs = canonicalHighs.filter((h) => macroPeak && h.index >= macroPeak.index);

      // 🔒 Dow Theory Rule ("ถ้ายังไม่ทำ LH ไม่ควรปรับลดกรอบบนลงมา"):
      const hasConfirmedMultiTouchRes = Boolean(srResult?.resistance && srResult.resistance.touchCount >= 2);
      const isLatestHighHh = lastCanonicalHigh?.dowLabel === "HH";
      if (!hasConfirmedMultiTouchRes && isLatestHighHh && lastCanonicalHigh && upperBound < lastCanonicalHigh.price) {
        upperBound = lastCanonicalHigh.price;
        clampStatus = "NATURAL_SWING";
      }

      // 🔒 Dow Theory Rule ("ถ้ายอดในราคาปัจจุบันทำ Lower high สามารถปรับลดกรอบลงมาได้"):
      if (upperBound > bottomBound + minSpan) {
        const candidateLhs = (postPeakHighs.length > 0 ? postPeakHighs : canonicalHighs)
          .filter((h) => (h.dowLabel === "LH" || (lastCanonicalHigh && h.price < (canonicalHighs[0]?.price ?? Infinity))) && h.price > price)
          .filter((h) => h.price - bottomBound >= minSpan && h.price - bottomBound <= maxSpan)
          .sort((a, b) => b.price - a.price);

        if (candidateLhs.length > 0 && (isLatestHighLh || waveCycle.currentLeg?.direction === "DOWN" || Boolean(waveCycle.lastLh) || upperBound - bottomBound > maxSpan)) {
          const targetLh = candidateLhs[0]!;
          if (targetLh.price < upperBound) {
            upperBound = targetLh.price;
            clampStatus = "NATURAL_SWING";
          }
        } else if (isLatestHighLh && lastCanonicalHigh && upperBound > lastCanonicalHigh.price && lastCanonicalHigh.price - bottomBound >= minSpan) {
          upperBound = lastCanonicalHigh.price;
          clampStatus = "NATURAL_SWING";
        }
      }
    }

    // 🔒 Dow Theory Symmetrical Rule ("ถ้าราคาทำ Lower Low (LL) กรอบล่างต้องปรับลดลงมารับ New Low"):
    // When price establishes a confirmed Lower Low (LL) below the active bottom bound,
    // the previous support level was broken by the market dump. The floor must adjust down to this confirmed LL!
    const lastCanonicalLow = canonicalLows.length > 0 ? canonicalLows[canonicalLows.length - 1] : undefined;
    const isLatestLowLl = lastCanonicalLow?.dowLabel === "LL";
    if (isLatestLowLl && lastCanonicalLow && bottomBound > lastCanonicalLow.price) {
      bottomBound = lastCanonicalLow.price;
      clampStatus = "NATURAL_SWING";
    }

    // Ensure sensible minimum channel width (at least 0.5%)
    if (upperBound <= bottomBound || (upperBound - bottomBound) / bottomBound < 0.005) {
      const midEst2 = (upperBound + bottomBound) / 2 || price;
      upperBound = midEst2 * 1.01;
      bottomBound = midEst2 * 0.99;
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

    // Check channel width: In narrow channels (e.g. < 1.2%), adapt grid levels towards edges (Floor + 0.2% / Ceil - 0.2%)
    // to preserve tradeable edge swings and avoid clustering dust orders in the middle.
    const isNarrowChannel = bottomBound > 0 && ((finalSpan / bottomBound) * 100) < 1.20;

    // Grid Levels in 10% to 50% (Buy Zone): 40%, 30%, 20%, 10% (0%-5% is safe buffer above floor)
    const buyLevels = isNarrowChannel
      ? [
          Math.min(bottomBound + finalSpan * 0.40, bottomBound * 1.006),
          Math.min(bottomBound + finalSpan * 0.30, bottomBound * 1.004),
          Math.max(bottomBound + finalSpan * 0.20, bottomBound * 1.003),
          Math.max(bottomBound + finalSpan * 0.10, bottomBound * 1.002), // Bottom edge: Floor + 0.2%
        ]
      : [
          bottomBound + finalSpan * 0.40,
          bottomBound + finalSpan * 0.30,
          bottomBound + finalSpan * 0.20,
          bottomBound + finalSpan * 0.10,
        ];

    // Grid Levels in 50% to 100% (Sell Zone): 60%, 70%, 80%, 90% (Hold 0% near 100% Upper Bound)
    const sellLevels = isNarrowChannel
      ? [
          Math.min(bottomBound + finalSpan * 0.60, upperBound * 0.994),
          Math.min(bottomBound + finalSpan * 0.70, upperBound * 0.996),
          Math.max(bottomBound + finalSpan * 0.80, upperBound * 0.997),
          Math.max(bottomBound + finalSpan * 0.90, upperBound * 0.998), // Top edge: Ceiling - 0.2%
        ]
      : [
          bottomBound + finalSpan * 0.60,
          bottomBound + finalSpan * 0.70,
          bottomBound + finalSpan * 0.80,
          bottomBound + finalSpan * 0.90,
        ];

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
      resistanceTouchCount: srResult?.resistance?.touchCount,
      supportTouchCount: srResult?.support?.touchCount,
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

    // ── Sync cluster to the final upperBound / bottomBound after all Dow Theory overrides ──────────
    // After overrides (HH protection, LH adaptation, LL floor drop, min-width enforcement),
    // upperBound and bottomBound may differ from srResult.resistance/support.price.
    // We must build effective clusters whose .price AND .points both reflect the actual bound source
    // so that the 🎯 touch badges on the dashboard AND the channel border line sit at the same position.

    // Determine the source of upperBound:
    //   a) srResult.resistance exists AND its price equals upperBound within tolerance → use original cluster
    //   b) An existing cluster in allResistanceClusters matches upperBound → use that cluster
    //   c) A canonical high or swing high matches upperBound → use that swing high
    //   d) Points from srResult.resistance genuinely touch upperBound → filter to those points
    //   e) Never leak points from a far-away cluster (e.g. 0.2210) to a different upper bound level (e.g. 0.2097)!
    const clusterToleranceRatio = Math.max(0.001, (srTol ?? 1.0) / 100);
    const upperMatchesSR = srResult?.resistance && Math.abs(upperBound - srResult.resistance.price) / srResult.resistance.price <= clusterToleranceRatio;

    let effectiveResCluster: { price: number; touchCount: number; points: SwingPoint[] } | undefined;
    if (upperMatchesSR && srResult?.resistance) {
      const tightTol = Math.min(clusterToleranceRatio, 0.0025);
      const pointsAtCeiling = srResult.resistance.points.filter(
        (pt) => Math.abs(pt.price - upperBound) / upperBound <= tightTol,
      );
      effectiveResCluster = {
        ...srResult.resistance,
        price: upperBound,
        touchCount: pointsAtCeiling.length > 0 ? pointsAtCeiling.length : srResult.resistance.touchCount,
        points: pointsAtCeiling.length > 0 ? pointsAtCeiling : srResult.resistance.points,
      };
    } else {
      const matchCluster = srResult?.allResistanceClusters?.find(
        (c) => Math.abs(c.price - upperBound) / upperBound <= clusterToleranceRatio,
      );
      if (matchCluster) {
        effectiveResCluster = { ...matchCluster, price: upperBound };
      } else {
        const matchingHighs = (canonicalHighs.length > 0 ? canonicalHighs : this.swingHighs).filter(
          (h) => Math.abs(h.price - upperBound) / upperBound <= clusterToleranceRatio,
        );
        if (matchingHighs.length > 0) {
          effectiveResCluster = {
            price: upperBound,
            touchCount: matchingHighs.length,
            points: matchingHighs,
          };
        } else if (srResult?.resistance) {
          const pointsAtCeiling = srResult.resistance.points.filter(
            (pt) => Math.abs(pt.price - upperBound) / upperBound <= clusterToleranceRatio,
          );
          if (pointsAtCeiling.length > 0) {
            effectiveResCluster = {
              price: upperBound,
              touchCount: pointsAtCeiling.length,
              points: pointsAtCeiling,
            };
          } else {
            effectiveResCluster = undefined;
          }
        } else {
          effectiveResCluster = undefined;
        }
      }
    }

    // Determine the source of bottomBound:
    //   a) srResult.support price equals bottomBound within tolerance → use original cluster
    //   b) An existing cluster in allSupportClusters matches bottomBound → use that cluster
    //   c) A canonical low or swing low matches bottomBound → use that swing low
    //   d) Points from srResult.support genuinely touch bottomBound → filter to those points
    //   e) Never leak points from a far-away cluster to a different floor level!
    const bottomMatchesSR = srResult?.support && Math.abs(bottomBound - srResult.support.price) / srResult.support.price <= clusterToleranceRatio;

    let effectiveSupCluster: { price: number; touchCount: number; points: SwingPoint[] } | undefined;
    if (bottomMatchesSR && srResult?.support) {
      const tightTol = Math.min(clusterToleranceRatio, 0.0025);
      const pointsAtFloor = srResult.support.points.filter(
        (pt) => Math.abs(pt.price - bottomBound) / bottomBound <= tightTol,
      );
      effectiveSupCluster = {
        ...srResult.support,
        price: bottomBound,
        touchCount: pointsAtFloor.length > 0 ? pointsAtFloor.length : srResult.support.touchCount,
        points: pointsAtFloor.length > 0 ? pointsAtFloor : srResult.support.points,
      };
    } else {
      const matchCluster = srResult?.allSupportClusters?.find(
        (c) => Math.abs(c.price - bottomBound) / bottomBound <= clusterToleranceRatio,
      );
      if (matchCluster) {
        effectiveSupCluster = { ...matchCluster, price: bottomBound };
      } else {
        const matchingLows = (canonicalLows.length > 0 ? canonicalLows : this.swingLows).filter(
          (l) => Math.abs(l.price - bottomBound) / bottomBound <= clusterToleranceRatio,
        );
        if (matchingLows.length > 0) {
          effectiveSupCluster = {
            price: bottomBound,
            touchCount: matchingLows.length,
            points: matchingLows,
          };
        } else if (srResult?.support) {
          const pointsAtFloor = srResult.support.points.filter(
            (pt) => Math.abs(pt.price - bottomBound) / bottomBound <= clusterToleranceRatio,
          );
          if (pointsAtFloor.length > 0) {
            effectiveSupCluster = {
              price: bottomBound,
              touchCount: pointsAtFloor.length,
              points: pointsAtFloor,
            };
          } else {
            effectiveSupCluster = undefined;
          }
        } else {
          effectiveSupCluster = undefined;
        }
      }
    }

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
      resistanceCluster: effectiveResCluster,
      supportCluster: effectiveSupCluster,
      allResistanceClusters: srResult?.allResistanceClusters,
      allSupportClusters: srResult?.allSupportClusters,
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
