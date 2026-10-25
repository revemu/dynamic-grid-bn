import type { Candle, SwingPoint, CandidatePoint } from "./types.js";
import { getEffectiveHigh, getEffectiveLow } from "./candle-manager.js";

export class SwingDetector {
  /**
   * Recalculates confirmed structural swing pivots with a k-bar window.
   */
  public static findSwings(
    candles: Candle[],
    pivotWindow: number,
    useTrueWick: boolean,
    wickThresholdPct: number,
  ): { swingHighs: SwingPoint[]; swingLows: SwingPoint[] } {
    const n = candles.length;
    const k = Math.max(2, pivotWindow || 3);
    // Need at least k preceding closed bars + pivot bar + k following closed bars
    if (n < k * 2 + 1) {
      return { swingHighs: [], swingLows: [] };
    }

    const swingHighs: SwingPoint[] = [];
    const swingLows: SwingPoint[] = [];

    // Scan for true structural swing pivots with k-bar window
    // Determine the last fully closed candle index:
    // If candle n - 1 is already closed, lastClosedIdx is n - 1. Otherwise candle n - 1 is live/open, so lastClosedIdx is n - 2.
    const lastClosedIdx = candles[n - 1]?.isClosed === true
      ? n - 1
      : n - 2;

    // For candle i to have k closed candles strictly AFTER it, i + k <= lastClosedIdx => i <= lastClosedIdx - k.
    const maxConfirmedIdx = lastClosedIdx - k;

    for (let i = k; i <= maxConfirmedIdx; i++) {
      const c = candles[i];
      if (!c) continue;

      const cEffHigh = getEffectiveHigh(c, useTrueWick, wickThresholdPct);
      const cEffLow = getEffectiveLow(c, useTrueWick, wickThresholdPct);

      let isHigh = true;
      let isLow = true;

      // Check left side (k preceding closed candles: i - k .. i - 1)
      for (let j = i - k; j < i; j++) {
        const other = candles[j];
        if (!other) continue;
        if (getEffectiveHigh(other, useTrueWick, wickThresholdPct) > cEffHigh) isHigh = false;
        if (getEffectiveLow(other, useTrueWick, wickThresholdPct) < cEffLow) isLow = false;
      }

      // Check right side (strictly k following CLOSED candles: i + 1 .. i + k <= lastClosedIdx)
      if (isHigh || isLow) {
        for (let j = i + 1; j <= i + k; j++) {
          const other = candles[j];
          if (!other) continue;
          if (getEffectiveHigh(other, useTrueWick, wickThresholdPct) >= cEffHigh) isHigh = false;
          if (getEffectiveLow(other, useTrueWick, wickThresholdPct) <= cEffLow) isLow = false;
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
        swingHighs.push({
          index: i,
          time: c.time,
          price: cEffHigh,
          type: "HIGH",
        });
      }
      if (isLow) {
        swingLows.push({
          index: i,
          time: c.time,
          price: cEffLow,
          type: "LOW",
        });
      }
    }

    return { swingHighs, swingLows };
  }

  /**
   * Detect Candidate Peaks & Valleys in the unconfirmed tail (last candles)
   */
  public static findCandidatePoints(
    candles: Candle[],
    pivotWindow: number,
    useTrueWick: boolean,
    wickThresholdPct: number,
    useOnlyClosedCandles?: boolean,
    liveCandle?: Candle,
  ): { candidatePeak?: CandidatePoint; candidateValley?: CandidatePoint } {
    const n = candles.length;
    const k = Math.max(2, pivotWindow || 3);
    if (n < k + 1) return {};

    const lastClosedIdx = (useOnlyClosedCandles || candles[n - 1]?.isClosed === true)
      ? n - 1
      : n - 2;

    let candidatePeak: CandidatePoint | undefined;
    let candidateValley: CandidatePoint | undefined;

    if (lastClosedIdx >= k) {
      const startCandidateIdx = Math.max(k, (lastClosedIdx + 1) - k);
      for (let idx = startCandidateIdx; idx <= lastClosedIdx; idx++) {
        const c = candles[idx];
        if (!c) continue;

        // Number of fully closed candles formed strictly after idx
        const followingClosedCandles = Math.max(0, lastClosedIdx - idx);
        const candEffHigh = getEffectiveHigh(c, useTrueWick, wickThresholdPct);
        const candEffLow = getEffectiveLow(c, useTrueWick, wickThresholdPct);

        let isCandHigh = true;
        for (let j = idx - k; j < idx; j++) {
          const prev = candles[j];
          if (prev && getEffectiveHigh(prev, useTrueWick, wickThresholdPct) > candEffHigh) {
            isCandHigh = false;
            break;
          }
        }
        if (isCandHigh) {
          for (let j = idx + 1; j <= Math.min(lastClosedIdx, idx + k); j++) {
            const next = candles[j];
            if (next && getEffectiveHigh(next, useTrueWick, wickThresholdPct) > candEffHigh) {
              isCandHigh = false;
              break;
            }
          }
          if (isCandHigh && liveCandle && getEffectiveHigh(liveCandle, useTrueWick, wickThresholdPct) > candEffHigh) {
            isCandHigh = false;
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
          if (prev && getEffectiveLow(prev, useTrueWick, wickThresholdPct) < candEffLow) {
            isCandLow = false;
            break;
          }
        }
        if (isCandLow) {
          for (let j = idx + 1; j <= Math.min(lastClosedIdx, idx + k); j++) {
            const next = candles[j];
            if (next && getEffectiveLow(next, useTrueWick, wickThresholdPct) < candEffLow) {
              isCandLow = false;
              break;
            }
          }
          if (isCandLow && liveCandle && getEffectiveLow(liveCandle, useTrueWick, wickThresholdPct) < candEffLow) {
            isCandLow = false;
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

    return { candidatePeak, candidateValley };
  }

  /**
   * Helper: A confirmed valley is unbroken if no subsequent confirmed swing low,
   * no candidate valley, and no candle formed after it has broken below its price.
   */
  public static isUnbrokenValley(
    v: SwingPoint,
    confirmedLows: SwingPoint[],
    candles: Candle[],
    candidateValley?: CandidatePoint,
    useTrueWick = true,
    wickThresholdPct = 0.20,
  ): boolean {
    return (
      !confirmedLows.some((later) => (later.index > v.index || later.time > v.time) && later.price < v.price) &&
      !(candidateValley && candidateValley.time > v.time && candidateValley.price < v.price * 0.996) &&
      !candles.some((c) => c.time > v.time && (
        (c.isClosed !== false && c.close < v.price * 0.997) ||
        getEffectiveLow(c, useTrueWick, wickThresholdPct) < v.price * 0.995
      ))
    );
  }

  /**
   * Helper: A confirmed peak is unbroken if no subsequent confirmed swing high,
   * no candidate peak, and no candle formed after it has broken above its price.
   */
  public static isUnbrokenPeak(
    p: SwingPoint,
    confirmedHighs: SwingPoint[],
    candles: Candle[],
    candidatePeak?: CandidatePoint,
    useTrueWick = true,
    wickThresholdPct = 0.20,
  ): boolean {
    return (
      !confirmedHighs.some((later) => (later.index > p.index || later.time > p.time) && later.price > p.price) &&
      !(candidatePeak && candidatePeak.time > p.time && candidatePeak.price > p.price) &&
      !candles.some((c) => c.time > p.time && getEffectiveHigh(c, useTrueWick, wickThresholdPct) > p.price)
    );
  }

  /**
   * Helper: A swing low is only valid as a Higher Low if no subsequent candle has broken below it.
   */
  public static isSwingLowUnbroken(
    s: SwingPoint,
    candles: Candle[],
    useTrueWick = true,
    wickThresholdPct = 0.20,
  ): boolean {
    return !candles.some(
      (c) => c.time > s.time && (
        (c.isClosed !== false && c.close < s.price * 0.997) ||
        getEffectiveLow(c, useTrueWick, wickThresholdPct) < s.price * 0.995
      ),
    );
  }
}
