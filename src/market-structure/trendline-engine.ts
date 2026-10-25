import type { Candle, SwingPoint, TrendLine, TrendLinePoint, DowSwingPoint } from "./types.js";
import { getEffectiveHigh, getEffectiveLow } from "./candle-manager.js";

export class TrendlineEngine {
  public static calculateTrendlines(
    candles: Candle[],
    swingHighs: SwingPoint[],
    swingLows: SwingPoint[],
    structureLookback: number,
    currentPrice: number,
    activeValley?: SwingPoint,
    activePeak?: SwingPoint,
    _lastHh?: SwingPoint,
    _lastLl?: SwingPoint,
    _annotatedSwings?: DowSwingPoint[],
    useTrueWick = true,
    wickThresholdPct = 0.20,
  ): {
    downtrendLine?: TrendLine;
    uptrendLine?: TrendLine;
    downtrendBreakoutConfirmed?: boolean;
    uptrendBreakdownConfirmed?: boolean;
  } {
    const n = candles.length;
    if (n < 4) return {};

    // Look within the same structural history window as Peak/Valley & S/R (srLookbackCandles)
    const lookback = Math.min(n, structureLookback);
    const minIndex = Math.max(0, n - lookback);

    const confirmedHighs = swingHighs.filter((s) => s.index >= minIndex).sort((a, b) => a.index - b.index);
    const confirmedLows = swingLows.filter((s) => s.index >= minIndex).sort((a, b) => a.index - b.index);

    let downtrendLine: TrendLine | undefined;
    let uptrendLine: TrendLine | undefined;
    let downtrendBreakoutConfirmed = false;
    let uptrendBreakdownConfirmed = false;

    const latestCandle = candles[n - 1];
    const latestTime = latestCandle?.time ?? 0;

    const macroPeak = confirmedHighs.length > 0
      ? confirmedHighs.reduce((max, h) => (h.price >= max.price ? h : max), confirmedHighs[0]!)
      : undefined;
    const macroLow = confirmedLows.length > 0
      ? confirmedLows.reduce((min, l) => (l.price <= min.price ? l : min), confirmedLows[0]!)
      : undefined;

    // ── 1. Downtrend Resistance Line: Strict Outer Envelope & Active Wave Priority ──
    if (confirmedHighs.length >= 2) {
      // P1 must not be broken upward by any subsequent confirmed swing high
      const downWaveStartIdx = (macroLow && macroPeak && macroPeak.index > macroLow.index) ? macroLow.index : minIndex;
      const p1Candidates = confirmedHighs.filter(
        (h) =>
          h.index >= downWaveStartIdx &&
          !confirmedHighs.some((later) => later.index > h.index && later.price > h.price)
      );

      let bestP1: SwingPoint | undefined;
      let bestP2: SwingPoint | undefined;
      let bestSlope = -Infinity;
      let bestScore = -Infinity;

      for (const p1 of p1Candidates) {
        const allLaterHighs = confirmedHighs.filter((h) => h.index > p1.index && h.time > p1.time);
        const candidateSubHighs = allLaterHighs.filter((h) => h.price < p1.price);

        for (const p2 of candidateSubHighs) {
          // 🛡️ Structural Wave Integrity (Dow Theory):
          // A downtrend line tracks a specific descending wave and CANNOT span across the bottom trough (activeValley).
          // Both P1 and P2 must either be pre-trough (forming the drop to the valley), OR post-trough (forming a new pullback).
          if (activeValley) {
            const isP1BeforeValley = p1.time < activeValley.time;
            const isP2BeforeValley = p2.time <= activeValley.time;
            if (isP1BeforeValley !== isP2BeforeValley) {
              continue; // Reject lines spanning across the bottom trough
            }
          }

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

          // Check ALL subsequent confirmed swing highs (including any high >= p1.price)
          for (const midHigh of allLaterHighs) {
            const lineVal = p1.price + slope * (midHigh.time - p1.time);
            if (midHigh.price > lineVal * 1.001) {
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
            const c = candles[i];
            if (!c) continue;
            // Ignore live unclosed candle during envelope & touch scoring to prevent jitter
            if (i === n - 1 && c.isClosed !== true) continue;
            const lineVal = p1.price + slope * (c.time - p1.time);
            const effHigh = getEffectiveHigh(c, useTrueWick, wickThresholdPct);
            // Between P1 and P2, no candle close or effective high may pierce above the resistance envelope
            if (i <= p2.index && (c.close > lineVal * 1.0015 || effHigh > lineVal * 1.002)) {
              violates = true;
              break;
            }
            if (c.high >= lineVal * 0.997 && c.close <= lineVal * 1.0015) {
              candleTouches++;
            }
            if (i > p2.index) {
              if (c.close > lineVal * 1.0005) {
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
          const isActiveWaveAnchor = Boolean(
            (activePeak && p1.index >= activePeak.index) ||
            (activeValley && p1.time >= activeValley.time && p2.time > p1.time)
          );
          // Prioritize unbroken active lines, active channel wave alignment, recency of P2/P1, and touches
          const score =
            (isUnbroken ? 1000 : 0) +
            (isActiveWaveAnchor ? 250 : 0) +
            swingTouches * 120 +
            Math.min(candleTouches, 8) * 25 +
            (p2.index / Math.max(1, n)) * 200 +
            (p1.index / Math.max(1, n)) * 100;

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
            const c = candles[cIdx];
            if (!c) continue;
            const val = bestP1.price + bestSlope * (c.time - bestP1.time);
            points.push({ time: c.time, value: Number(val.toFixed(6)) });
          }

          let totalBrokenCandles = 0;
          let consecutiveBrokenCandles = 0;
          let maxConsecutiveBroken = 0;

          for (let i = bestP2.index + 1; i < n; i++) {
            const c = candles[i];
            if (!c) continue;
            // Strict Confirmed Candle Breakout: Only count fully closed candles as confirmed broken candles!
            if (i === n - 1 && c.isClosed !== true) continue;
            const lineVal = bestP1.price + bestSlope * (c.time - bestP1.time);
            if (c.close > lineVal * 1.0005) {
              totalBrokenCandles++;
              consecutiveBrokenCandles++;
              if (consecutiveBrokenCandles > maxConsecutiveBroken) {
                maxConsecutiveBroken = consecutiveBrokenCandles;
              }
            } else {
              consecutiveBrokenCandles = 0;
            }
          }

          const confirmedLastCandle = candles[n - 1]?.isClosed === true ? candles[n - 1] : candles[n - 2];
          const isConfirmedAbove = Boolean(confirmedLastCandle && confirmedLastCandle.close > currentLinePrice * 1.0005);
          const breakoutConfirmed = (maxConsecutiveBroken >= 2 || totalBrokenCandles >= 2) && isConfirmedAbove;

          if (breakoutConfirmed) {
            downtrendBreakoutConfirmed = true;
          }
          downtrendLine = {
            type: "DOWNTREND",
            p1: bestP1,
            p2: bestP2,
            slope: bestSlope,
            currentLinePrice,
            isBroken: breakoutConfirmed,
            breakoutPct: ((currentPrice - currentLinePrice) / currentLinePrice) * 100,
            brokenCandleCount: totalBrokenCandles,
            breakoutConfirmed,
            points,
          };
        }
      }
    }

    // ── 2. Uptrend Support Line: Active Wave Base Scoping & Strict Outer Envelope ──
    if (confirmedLows.length >= 2) {
      const postPeakLows = macroPeak ? confirmedLows.filter((l) => l.index > macroPeak.index) : [];
      const postPeakLowest = postPeakLows.length > 0
        ? postPeakLows.reduce((min, l) => (l.price <= min.price ? l : min), postPeakLows[0]!)
        : undefined;
      const upWaveStartIdx = activeValley
        ? activeValley.index
        : (postPeakLowest ? postPeakLowest.index : minIndex);

      // V1 must be within the active wave and must not be broken downward by any subsequent confirmed swing low
      const v1Candidates = confirmedLows.filter(
        (l) =>
          l.index >= upWaveStartIdx &&
          !confirmedLows.some((later) => later.index > l.index && later.price < l.price)
      );

      let bestV1: SwingPoint | undefined;
      let bestV2: SwingPoint | undefined;
      let bestSlope = Infinity;
      let bestScore = -Infinity;

      for (const v1 of v1Candidates) {
        const allLaterLows = confirmedLows.filter((l) => l.index > v1.index && l.time > v1.time);
        const candidateSubLows = allLaterLows.filter((l) => l.price > v1.price);

        for (const v2 of candidateSubLows) {
          // 🛡️ Structural Wave Integrity (Dow Theory):
          // An uptrend line tracks a specific ascending wave and CANNOT span across the top peak (activePeak).
          // Both V1 and V2 must either be pre-peak (forming the rally to the peak), OR post-peak (forming a new recovery).
          if (activePeak) {
            const isV1BeforePeak = v1.time < activePeak.time;
            const isV2BeforePeak = v2.time <= activePeak.time;
            if (isV1BeforePeak !== isV2BeforePeak) {
              continue; // Reject lines spanning across the top peak
            }
          }

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

          // Check ALL subsequent confirmed swing lows (including any low <= v1.price)
          for (const midLow of allLaterLows) {
            const lineVal = v1.price + slope * (midLow.time - v1.time);
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
            const c = candles[i];
            if (!c) continue;
            // Ignore live unclosed candle during envelope & touch scoring to prevent jitter
            if (i === n - 1 && c.isClosed !== true) continue;
            const lineVal = v1.price + slope * (c.time - v1.time);
            const effLow = getEffectiveLow(c, useTrueWick, wickThresholdPct);
            // Between V1 and V2, no candle close or effective low may deeply violate the support envelope
            if (i <= v2.index && (c.close < lineVal * 0.9985 || effLow < lineVal * 0.998)) {
              violates = true;
              break;
            }
            if (c.low <= lineVal * 1.003 && c.close >= lineVal * 0.9985) {
              candleTouches++;
            }
            if (i > v2.index) {
              if (c.close < lineVal * 0.9995) {
                postV2BrokenCandles++;
                consecutiveBroken++;
                if (consecutiveBroken > maxConsecutiveBroken) maxConsecutiveBroken = consecutiveBroken;
              } else {
                consecutiveBroken = 0;
              }
            }
          }
          if (violates) continue;

          const isUnbroken = maxConsecutiveBroken < 2 && postV2BrokenCandles < 2;
          const isActiveFloorAnchor = Boolean(activeValley && (v1.time === activeValley.time || v1.index === activeValley.index));
          // Prioritize unbroken active lines, activeValley anchor, recent v2, swing touches, and candle touches
          const score =
            (isUnbroken ? 1000 : 0) +
            (isActiveFloorAnchor ? 250 : 0) +
            swingTouches * 120 +
            Math.min(candleTouches, 8) * 30 +
            (v2.index / Math.max(1, n)) * 200 +
            (v1.index / Math.max(1, n)) * 120;

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
            const c = candles[cIdx];
            if (!c) continue;
            const val = bestV1.price + bestSlope * (c.time - bestV1.time);
            points.push({ time: c.time, value: Number(val.toFixed(6)) });
          }

          let totalBrokenCandles = 0;
          let consecutiveBrokenCandles = 0;
          let maxConsecutiveBroken = 0;

          for (let i = bestV2.index + 1; i < n; i++) {
            const c = candles[i];
            if (!c) continue;
            // Strict Confirmed Candle Breakout: Only count fully closed candles as confirmed broken candles!
            if (i === n - 1 && c.isClosed !== true) continue;
            const lineVal = bestV1.price + bestSlope * (c.time - bestV1.time);
            if (c.close < lineVal * 0.9995) {
              totalBrokenCandles++;
              consecutiveBrokenCandles++;
              if (consecutiveBrokenCandles > maxConsecutiveBroken) {
                maxConsecutiveBroken = consecutiveBrokenCandles;
              }
            } else {
              consecutiveBrokenCandles = 0;
            }
          }

          const confirmedLastCandle = candles[n - 1]?.isClosed === true ? candles[n - 1] : candles[n - 2];
          const isConfirmedBelow = Boolean(confirmedLastCandle && confirmedLastCandle.close < currentLinePrice * 0.9995);
          const breakoutConfirmed = (maxConsecutiveBroken >= 2 || totalBrokenCandles >= 2) && isConfirmedBelow;

          if (breakoutConfirmed) {
            uptrendBreakdownConfirmed = true;
          }
          uptrendLine = {
            type: "UPTREND",
            p1: bestV1,
            p2: bestV2,
            slope: bestSlope,
            currentLinePrice,
            isBroken: breakoutConfirmed,
            breakoutPct: ((currentLinePrice - currentPrice) / currentLinePrice) * 100,
            brokenCandleCount: totalBrokenCandles,
            breakoutConfirmed,
            points,
          };
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
}
