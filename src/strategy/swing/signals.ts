/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import type { DowStructure, Candle, SwingPoint } from "../../market-structure.js";
import type { SwingStrategyConfig } from "./config.js";

export interface SwingSignalResult {
  hasSignal: boolean;
  signalType?: "LL_RETEST_BOUNCE" | "HL_BASE" | "TL_BREAKOUT" | "SUPPORT_RETEST";
  entryPrice: number;
  stopLossPrice: number;
  tp1Price: number;
  tp2Price: number;
  riskRewardRatio: number;
  reason: string;
  // Planned levels for display and visualization even when waiting for setup:
  plannedEntryPrice?: number;
  plannedSlPrice?: number;
  plannedTp1Price?: number;
  plannedTp2Price?: number;
  plannedRrRatio?: number;
}

export class SwingSignalDetector {
  /**
   * Helper to inspect recent candles for a confirmed bullish reversal pattern at support.
   * Strictly evaluates only fully closed candles and requires genuine buyer dominance (green close).
   */
  private static checkBullishReversal(candles: Candle[]): { isReversal: boolean; pattern: string } {
    const closedCandles = candles.filter((c) => c.isClosed !== false);
    if (!closedCandles || closedCandles.length < 2) {
      return { isReversal: false, pattern: "Insufficient closed candle history" };
    }

    const curr = closedCandles[closedCandles.length - 1];
    const prev = closedCandles[closedCandles.length - 2];
    if (!curr || !prev) return { isReversal: false, pattern: "No candle data" };

    const currRange = curr.high - curr.low;
    const currBody = curr.close - curr.open;
    const prevRange = prev.high - prev.low;
    const prevBody = prev.close - prev.open;

    // Minimum meaningful candle range (>= 0.18% of price) to eliminate micro tick / illiquidity noise
    if (currRange <= 0 || curr.close <= 0 || (currRange / curr.close) < 0.0018) {
      return { isReversal: false, pattern: "Candle range too narrow (noise/doji)" };
    }

    // 🛑 Absolute Requirement: A reversal MUST close as a bullish candle (close > open)!
    // Red candles (close <= open) can NEVER be a bullish reversal.
    if (curr.close <= curr.open) {
      return { isReversal: false, pattern: "Current closed candle is red/bearish" };
    }

    // 1. Bullish Hammer / Pinbar Rejection: Long lower wick >= 50%, closes in upper 30% of range, small upper wick <= 25%
    const lowerWick = curr.open - curr.low;
    const upperWick = curr.high - curr.close;
    const lowerWickRatio = lowerWick / currRange;
    const upperWickRatio = upperWick / currRange;
    if (
      lowerWickRatio >= 0.50 &&
      curr.close >= curr.low + currRange * 0.70 &&
      upperWickRatio <= 0.25
    ) {
      return { isReversal: true, pattern: `Bullish Hammer (Lower wick ${(lowerWickRatio * 100).toFixed(0)}%, Upper wick ${(upperWickRatio * 100).toFixed(0)}%)` };
    }

    // 2. Bullish Engulfing or Piercing Line Reversal:
    // Previous candle was red, current candle is solid green and pierces >= 50% into previous body or engulfs
    if (prev.close < prev.open) {
      const prevRedBody = prev.open - prev.close;
      // Piercing line: closes above 50% of previous red body
      const piercingThreshold = prev.close + (prevRedBody * 0.50);
      const isPiercingOrEngulfing = curr.close >= piercingThreshold;
      const hasSolidBody = (currBody / currRange) >= 0.40;

      if (isPiercingOrEngulfing && hasSolidBody) {
        const isEngulfing = curr.close >= prev.open && curr.open <= prev.close;
        return {
          isReversal: true,
          pattern: isEngulfing ? "Bullish Engulfing Candle" : "Bullish Piercing Line Reversal",
        };
      }
    }

    // 3. Strong Momentum Close: Green candle closing above previous high with solid body
    if (curr.close > prev.high && (currBody / currRange) >= 0.45) {
      return { isReversal: true, pattern: "Bullish Breakout Above Previous Bar High" };
    }

    // 4. Consecutive Higher Low & Higher Close on solid green bar
    if (curr.low > prev.low && curr.close > prev.close && (currBody / currRange) >= 0.40 && curr.close >= curr.low + currRange * 0.65) {
      return { isReversal: true, pattern: "Bullish Micro Bounce (HL Bar)" };
    }

    return { isReversal: false, pattern: "No reversal pattern" };
  }

  /**
   * Helper to inspect recent candles for a confirmed bearish reversal pattern at resistance.
   * Strictly evaluates only fully closed candles and requires genuine seller dominance (red close).
   */
  public static checkBearishReversal(candles: Candle[]): { isReversal: boolean; pattern: string } {
    const closedCandles = candles.filter((c) => c.isClosed !== false);
    if (!closedCandles || closedCandles.length < 2) {
      return { isReversal: false, pattern: "Insufficient closed candle history" };
    }

    const curr = closedCandles[closedCandles.length - 1];
    const prev = closedCandles[closedCandles.length - 2];
    if (!curr || !prev) return { isReversal: false, pattern: "No candle data" };

    const currRange = curr.high - curr.low;
    const currBody = curr.close - curr.open;
    const prevRange = prev.high - prev.low;
    const prevBody = prev.close - prev.open;

    // Minimum meaningful candle range (>= 0.18% of price) to eliminate micro tick / illiquidity noise
    if (currRange <= 0 || curr.close <= 0 || (currRange / curr.close) < 0.0018) {
      return { isReversal: false, pattern: "Candle range too narrow (noise/doji)" };
    }

    // 🛑 Absolute Requirement: A bearish reversal MUST close as a bearish candle (close < open)!
    // Green candles (close >= open) can NEVER be a bearish reversal.
    if (curr.close >= curr.open) {
      return { isReversal: false, pattern: "Current closed candle is green/bullish" };
    }

    // 1. Shooting Star / Bearish Pinbar Rejection: Long upper wick >= 50%, closes in lower 30% of range, small lower wick <= 25%
    const upperWick = curr.high - curr.open;
    const lowerWick = curr.close - curr.low;
    const upperWickRatio = upperWick / currRange;
    const lowerWickRatio = lowerWick / currRange;
    if (
      upperWickRatio >= 0.50 &&
      curr.close <= curr.low + currRange * 0.30 &&
      lowerWickRatio <= 0.25
    ) {
      return {
        isReversal: true,
        pattern: `Shooting Star / Bearish Pinbar (Upper wick ${(upperWickRatio * 100).toFixed(0)}%, Lower wick ${(lowerWickRatio * 100).toFixed(0)}%)`,
      };
    }

    // 2. Bearish Engulfing or Dark Cloud Cover:
    // Previous candle was green, current candle is solid red and pierces >= 50% into previous body or engulfs
    if (prev.close > prev.open) {
      const prevGreenBody = prev.close - prev.open;
      const cloudThreshold = prev.close - (prevGreenBody * 0.50);
      const isCloudOrEngulfing = curr.close <= cloudThreshold;
      const hasSolidRedBody = (Math.abs(currBody) / currRange) >= 0.40;

      if (isCloudOrEngulfing && hasSolidRedBody) {
        const isEngulfing = curr.open >= prev.close && curr.close <= prev.open;
        return {
          isReversal: true,
          pattern: isEngulfing ? "Bearish Engulfing Candle" : "Dark Cloud Cover Reversal",
        };
      }
    }

    // 3. Strong Bearish Momentum Breakdown: Red candle closing below previous low with solid body
    if (curr.close < prev.low && (Math.abs(currBody) / currRange) >= 0.45) {
      return { isReversal: true, pattern: "Bearish Breakdown Below Previous Bar Low" };
    }

    // 4. Consecutive Lower High & Lower Close on solid red bar
    if (curr.high < prev.high && curr.close < prev.close && (Math.abs(currBody) / currRange) >= 0.40 && curr.close <= curr.low + currRange * 0.35) {
      return { isReversal: true, pattern: "Bearish Micro Rejection (LH Bar)" };
    }

    return { isReversal: false, pattern: "No reversal pattern" };
  }

  /**
   * Scans Dow Structure and Market Conditions for an asymmetric Risk:Reward Major LL Retest Swing Setup.
   */
  public static evaluateSetup(
    price: number,
    structure: DowStructure | undefined,
    config: SwingStrategyConfig,
    candles: Candle[] = [],
  ): SwingSignalResult {
    if (!structure || price <= 0) {
      return {
        hasSignal: false,
        entryPrice: 0,
        stopLossPrice: 0,
        tp1Price: 0,
        tp2Price: 0,
        riskRewardRatio: 0,
        reason: "No market structure available",
      };
    }

    const {
      bottomBound,
      upperBound,
      centerPrice,
      activeValley,
      activePeak,
      swingLows,
      swingHighs,
      downtrendLine,
      uptrendLine,
      downtrendBreakoutConfirmed,
      waveCycle,
      gridZone,
    } = structure;

    // ── 1. Identify Major Support Floor (Previous Major LL of Current Wave) ───
    let majorFloor = (bottomBound > 0 && bottomBound <= price * 1.002) ? bottomBound : 0;
    let majorFloorTime = activeValley?.time ?? 0;

    const recentLows = Array.isArray(swingLows) ? swingLows.slice(-20) : [];
    const candidateLows: { price: number; time: number }[] = [];
    if (waveCycle?.lastLl?.price && waveCycle.lastLl.price > 0 && waveCycle.lastLl.price <= price * 1.002) {
      candidateLows.push({ price: waveCycle.lastLl.price, time: waveCycle.lastLl.time });
    }
    if (activeValley?.price && activeValley.price > 0 && activeValley.price <= price * 1.002) {
      candidateLows.push({ price: activeValley.price, time: activeValley.time });
    }
    for (const s of recentLows) {
      if (s.price > 0 && s.price <= price * 1.002) {
        candidateLows.push({ price: s.price, time: s.time });
      }
    }
    if (waveCycle?.annotatedSwings) {
      for (const s of waveCycle.annotatedSwings.slice(-24)) {
        if (s.type === "LOW" && s.price > 0 && s.price <= price * 1.002) {
          candidateLows.push({ price: s.price, time: s.time });
        }
      }
    }
    if (candidateLows.length > 0) {
      let lowest = candidateLows[0]!;
      for (const c of candidateLows) {
        if (c.price < lowest.price) lowest = c;
      }
      majorFloor = lowest.price;
      majorFloorTime = lowest.time;
    } else if (majorFloor <= 0) {
      majorFloor = price * 0.95;
    }

    // ── 2. Identify Major Resistance Ceiling (Post-Bottom HH / LH + Trendline) ─
    const postBottomHighs: number[] = [];
    if (Array.isArray(swingHighs)) {
      for (const s of swingHighs.slice(-16)) {
        if (s.price > majorFloor && (majorFloorTime === 0 || s.time >= majorFloorTime)) {
          postBottomHighs.push(s.price);
        }
      }
    }
    if (waveCycle?.lastHh && waveCycle.lastHh.price > majorFloor && waveCycle.lastHh.time >= majorFloorTime) {
      postBottomHighs.push(waveCycle.lastHh.price);
    }
    if (waveCycle?.lastLh && waveCycle.lastLh.price > majorFloor && waveCycle.lastLh.time >= majorFloorTime) {
      postBottomHighs.push(waveCycle.lastLh.price);
    }

    // Prefer post-bottom structural highs so pre-dump peaks do not inflate the target frame
    let majorCeil = 0;
    if (postBottomHighs.length > 0) {
      majorCeil = Math.max(...postBottomHighs);
    } else if (upperBound > majorFloor) {
      majorCeil = upperBound;
    } else if (activePeak?.price && activePeak.price > majorFloor) {
      majorCeil = activePeak.price;
    } else {
      majorCeil = majorFloor * 1.05;
    }

    // Check active unbroken Descending Trendline (Downtrend Resistance Line)
    const hasActiveDowntrendTl = Boolean(
      downtrendLine &&
      !downtrendLine.isBroken &&
      !downtrendBreakoutConfirmed &&
      downtrendLine.currentLinePrice > majorFloor,
    );
    const tlResistancePrice = hasActiveDowntrendTl ? downtrendLine!.currentLinePrice : 0;

    // If an unbroken descending trendline is active, anchor the wave ceiling to the trendline structure (P2 / latest LH)
    if (hasActiveDowntrendTl && downtrendLine) {
      const p2Price = downtrendLine.p2?.price ?? 0;
      const latestLhPrice = (waveCycle?.lastLh?.price && waveCycle.lastLh.price > majorFloor && waveCycle.lastLh.time >= majorFloorTime)
        ? waveCycle.lastLh.price
        : 0;
      const trendlineCeilAnchor = Math.max(tlResistancePrice, p2Price, latestLhPrice);
      if (trendlineCeilAnchor > majorFloor && trendlineCeilAnchor < majorCeil) {
        majorCeil = trendlineCeilAnchor;
      }
    }

    // Check active unbroken Ascending Trendline (Uptrend Support Line)
    const hasActiveUptrendTl = Boolean(
      uptrendLine &&
      !uptrendLine.isBroken &&
      !uptrendLine.breakoutConfirmed &&
      uptrendLine.currentLinePrice > majorFloor &&
      uptrendLine.currentLinePrice <= price * 1.015,
    );
    const tlSupportPrice = hasActiveUptrendTl ? uptrendLine!.currentLinePrice : 0;

    // Check confirmed Higher Low (HL) after the floor
    const recentHl = (waveCycle?.lastHl && waveCycle.lastHl.price > majorFloor && (majorFloorTime === 0 || waveCycle.lastHl.time >= majorFloorTime))
      ? waveCycle.lastHl
      : undefined;
    const hlSupportPrice = (recentHl && recentHl.price <= price * 1.015) ? recentHl.price : 0;

    // 🎯 Determine Active Support Floor (Trendline Support > HL Base > Major LL)
    let activeSupportPrice = majorFloor;
    let activeSupportType: "TRENDLINE" | "HL_BASE" | "MAJOR_LL" = "MAJOR_LL";

    if (hasActiveUptrendTl && tlSupportPrice > majorFloor) {
      activeSupportPrice = tlSupportPrice;
      activeSupportType = "TRENDLINE";
    } else if (hlSupportPrice > majorFloor) {
      activeSupportPrice = hlSupportPrice;
      activeSupportType = "HL_BASE";
    }

    // Ensure minimum healthy swing width (>= 1.5% span to avoid micro-channels)
    let majorSpan = majorCeil - activeSupportPrice;
    if (majorSpan / activeSupportPrice < 0.015) {
      majorCeil = activeSupportPrice * 1.030;
      majorSpan = majorCeil - activeSupportPrice;
    }

    // ── 3. Calculate Planned Levels & Trendline-Aware Risk:Reward ─────────────
    const slBuffer = Math.max(0.3, config.stopLossBufferPct) / 100;
    let plannedSl = majorFloor * (1 - slBuffer);
    let plannedEntry = majorFloor + Math.min(majorSpan * 0.06, majorFloor * 0.004);

    if (activeSupportType === "TRENDLINE") {
      plannedSl = Math.min(tlSupportPrice, hlSupportPrice > 0 ? hlSupportPrice : tlSupportPrice) * (1 - slBuffer);
      plannedEntry = tlSupportPrice;
    } else if (activeSupportType === "HL_BASE") {
      plannedSl = hlSupportPrice * (1 - slBuffer);
      plannedEntry = hlSupportPrice;
    }

    // Raw TP1 is Mid-Wave (~50% retracement) or POC if within wave
    const midWavePrice = activeSupportPrice + (majorSpan * 0.50);
    const pocPrice = gridZone?.poc ?? 0;
    let rawTp1 = (pocPrice > plannedEntry * 1.008 && pocPrice < majorCeil * 0.98)
      ? pocPrice
      : midWavePrice;

    // 📐 Trendline Target Integration:
    // If an unbroken descending trendline is pressing down below rawTp1 (and above plannedEntry),
    // set TP1 right under the descending trendline (-0.15% buffer) to take profit at the trendline!
    let plannedTp1 = rawTp1;
    if (hasActiveDowntrendTl && tlResistancePrice > plannedEntry * 1.006) {
      const tlTargetPrice = tlResistancePrice * 0.9985;
      if (tlTargetPrice < plannedTp1) {
        plannedTp1 = tlTargetPrice;
      }
    }

    // TP2 is Retest of Post-Bottom Major High / Trendline P2-P1 Anchor
    let plannedTp2 = majorCeil * 0.996;
    if (hasActiveDowntrendTl && downtrendLine?.p2?.price && downtrendLine.p2.price > plannedTp1 * 1.008) {
      // When capped by a descending trendline, anchor TP2 to the recent LH / trendline anchor
      const postPeakTarget = downtrendLine.p2.price * 0.996;
      if (postPeakTarget > plannedTp1 && postPeakTarget < plannedTp2) {
        plannedTp2 = postPeakTarget;
      }
    }
    if (plannedTp2 <= plannedTp1) {
      plannedTp2 = plannedTp1 * 1.015;
    }

    const plannedRisk = Math.max(1e-8, plannedEntry - plannedSl);
    const plannedAvgReward = (plannedTp1 * config.tp1CloseRatio) + (plannedTp2 * (1 - config.tp1CloseRatio)) - plannedEntry;
    const plannedRr = plannedRisk > 0 ? plannedAvgReward / plannedRisk : 0;

    // 🎯 Strict Retest Zone Thresholds:
    const maxNearLlSpan = Math.min(majorSpan * 0.15, majorFloor * 0.010);
    const retestZoneMax = majorFloor + maxNearLlSpan;

    // Reject entry if market is in active falling knife, breaking below floor, or structure in WARMUP
    const isSupportBroken = majorFloor <= 0 || price < majorFloor * 0.998;
    const isStructureUnstable =
      gridZone?.gateStatus === "WAITING_FOR_BASE_CONFIRMATION" ||
      gridZone?.gateStatus === "DOWNTREND_NO_CHANNEL" ||
      structure.regime === "WARMUP" ||
      !structure.isSwingConfirmed ||
      bottomBound <= 0 ||
      isSupportBroken;

    if (isStructureUnstable) {
      const gateMsg = isSupportBroken
        ? "SUPPORT_BROKEN_NEW_LOW"
        : (gridZone?.gateStatus || (structure.regime === "WARMUP" ? "WARMUP_UNCONFIRMED_BASE" : "UNCONFIRMED_SWING_BASE"));

      return {
        hasSignal: false,
        entryPrice: 0,
        stopLossPrice: 0,
        tp1Price: 0,
        tp2Price: 0,
        riskRewardRatio: 0,
        reason: isSupportBroken
          ? (majorFloor > 0
              ? `Support broken below $${majorFloor.toFixed(4)} (New Low forming) — Waiting for new base`
              : "Support broken to New Low — Waiting for new base formation")
          : `Market gated (${gateMsg}) — Waiting for confirmed base near LL $${majorFloor.toFixed(4)}`,
        plannedEntryPrice: 0,
        plannedSlPrice: 0,
        plannedTp1Price: 0,
        plannedTp2Price: 0,
        plannedRrRatio: 0,
      };
    }

    // Helper to check if current price has enough room below an active descending trendline
    const hasTrendlineHeadroom = (entryCandidate: number, slCandidate: number): boolean => {
      if (!hasActiveDowntrendTl || tlResistancePrice <= 0) return true;
      // Do not buy right into an unbroken descending trendline (need >= 0.8% room and >= 1.2x R:R to trendline)
      const roomToTl = tlResistancePrice * 0.9985 - entryCandidate;
      const roomPct = (roomToTl / entryCandidate) * 100;
      const riskToSl = Math.max(1e-8, entryCandidate - slCandidate);
      const rrToTl = roomToTl / riskToSl;
      return roomPct >= 0.8 && rrToTl >= 1.15;
    };

    // ── Setup 1: Uptrend Line Support Retest & Bounce (SUPPORT_RETEST) ───────
    if (config.enableSupportRetestEntry && hasActiveUptrendTl && tlSupportPrice > majorFloor) {
      const isPriceInTlRetestZone = price >= plannedSl && price <= tlSupportPrice * 1.010;

      if (isPriceInTlRetestZone) {
        const reversalCheck = this.checkBullishReversal(candles);
        const closedCandles = candles.filter((c) => c.isClosed !== false);
        const lastClosedBar = closedCandles.length > 0 ? closedCandles[closedCandles.length - 1] : undefined;

        const isLivePriceHoldingReversal = !lastClosedBar || price >= lastClosedBar.open * 0.9995;
        const liveCandle = candles[candles.length - 1]?.isClosed === false ? candles[candles.length - 1] : undefined;
        const isLiveDumping = Boolean(
          liveCandle &&
          lastClosedBar &&
          liveCandle.close < liveCandle.open &&
          (liveCandle.open - liveCandle.close) > (lastClosedBar.close - lastClosedBar.open) * 0.6,
        );

        if (reversalCheck.isReversal && isLivePriceHoldingReversal && !isLiveDumping && hasTrendlineHeadroom(price, plannedSl)) {
          const actualRisk = price - plannedSl;
          const actualAvgReward = (plannedTp1 * config.tp1CloseRatio) + (plannedTp2 * (1 - config.tp1CloseRatio)) - price;
          const actualRr = actualRisk > 0 ? actualAvgReward / actualRisk : 0;

          if (actualRr >= config.minRiskReward) {
            const tlNote = hasActiveDowntrendTl ? ` | TL TP1: $${plannedTp1.toFixed(4)}` : "";
            return {
              hasSignal: true,
              signalType: "SUPPORT_RETEST",
              entryPrice: price,
              stopLossPrice: plannedSl,
              tp1Price: plannedTp1,
              tp2Price: plannedTp2,
              riskRewardRatio: actualRr,
              reason: `Uptrend Line Support Retest at $${tlSupportPrice.toFixed(4)} confirmed with ${reversalCheck.pattern}! Risk: -${((actualRisk / price) * 100).toFixed(2)}%, Target: +${(((plannedTp2 - price) / price) * 100).toFixed(2)}%, R:R: ${actualRr.toFixed(2)}x${tlNote}`,
              plannedEntryPrice: price,
              plannedSlPrice: plannedSl,
              plannedTp1Price: plannedTp1,
              plannedTp2Price: plannedTp2,
              plannedRrRatio: actualRr,
            };
          }
        }
      }
    }

    // ── Setup 2: Higher Low (HL) Support Retest & Bounce (HL_BASE) ───────────
    if (config.enableHlBaseEntry && hlSupportPrice > majorFloor) {
      const isPriceInHlRetestZone = price >= plannedSl && price <= hlSupportPrice * 1.010;

      if (isPriceInHlRetestZone) {
        const reversalCheck = this.checkBullishReversal(candles);
        const closedCandles = candles.filter((c) => c.isClosed !== false);
        const lastClosedBar = closedCandles.length > 0 ? closedCandles[closedCandles.length - 1] : undefined;

        const isLivePriceHoldingReversal = !lastClosedBar || price >= lastClosedBar.open * 0.9995;
        const liveCandle = candles[candles.length - 1]?.isClosed === false ? candles[candles.length - 1] : undefined;
        const isLiveDumping = Boolean(
          liveCandle &&
          lastClosedBar &&
          liveCandle.close < liveCandle.open &&
          (liveCandle.open - liveCandle.close) > (lastClosedBar.close - lastClosedBar.open) * 0.6,
        );

        if (reversalCheck.isReversal && isLivePriceHoldingReversal && !isLiveDumping && hasTrendlineHeadroom(price, plannedSl)) {
          const actualRisk = price - plannedSl;
          const actualAvgReward = (plannedTp1 * config.tp1CloseRatio) + (plannedTp2 * (1 - config.tp1CloseRatio)) - price;
          const actualRr = actualRisk > 0 ? actualAvgReward / actualRisk : 0;

          if (actualRr >= config.minRiskReward) {
            const tlNote = hasActiveDowntrendTl ? ` | TL TP1: $${plannedTp1.toFixed(4)}` : "";
            return {
              hasSignal: true,
              signalType: "HL_BASE",
              entryPrice: price,
              stopLossPrice: plannedSl,
              tp1Price: plannedTp1,
              tp2Price: plannedTp2,
              riskRewardRatio: actualRr,
              reason: `Higher Low (HL) Support Retest at $${hlSupportPrice.toFixed(4)} confirmed with ${reversalCheck.pattern}! Risk: -${((actualRisk / price) * 100).toFixed(2)}%, Target: +${(((plannedTp2 - price) / price) * 100).toFixed(2)}%, R:R: ${actualRr.toFixed(2)}x${tlNote}`,
              plannedEntryPrice: price,
              plannedSlPrice: plannedSl,
              plannedTp1Price: plannedTp1,
              plannedTp2Price: plannedTp2,
              plannedRrRatio: actualRr,
            };
          }
        }
      }
    }

    // ── Setup 3: Major LL Retest & Bullish Reversal Bounce (LL_RETEST_BOUNCE) ─
    if (config.enableSupportRetestEntry) {
      // Strictly require price to be inside the Near-LL Retest Zone
      const isPriceInRetestZone = price >= plannedSl && price <= retestZoneMax;

      if (isPriceInRetestZone) {
        const reversalCheck = this.checkBullishReversal(candles);
        const closedCandles = candles.filter((c) => c.isClosed !== false);
        const lastClosedBar = closedCandles.length > 0 ? closedCandles[closedCandles.length - 1] : undefined;

        // Anti-Falling Knife: Live tick price check against the reversal bar
        const isLivePriceHoldingReversal = !lastClosedBar || price >= lastClosedBar.open * 0.9995;

        // Check if there is an unclosed live candle currently dumping hard
        const liveCandle = candles[candles.length - 1]?.isClosed === false ? candles[candles.length - 1] : undefined;
        const isLiveDumping = Boolean(
          liveCandle &&
          lastClosedBar &&
          liveCandle.close < liveCandle.open &&
          (liveCandle.open - liveCandle.close) > (lastClosedBar.close - lastClosedBar.open) * 0.6,
        );

        if (reversalCheck.isReversal && isLivePriceHoldingReversal && !isLiveDumping && hasTrendlineHeadroom(price, plannedSl)) {
          const actualRisk = price - plannedSl;
          const actualAvgReward = (plannedTp1 * config.tp1CloseRatio) + (plannedTp2 * (1 - config.tp1CloseRatio)) - price;
          const actualRr = actualRisk > 0 ? actualAvgReward / actualRisk : 0;

          if (actualRr >= config.minRiskReward) {
            const tlNote = hasActiveDowntrendTl ? ` | TL TP1: $${plannedTp1.toFixed(4)}` : "";
            return {
              hasSignal: true,
              signalType: "LL_RETEST_BOUNCE",
              entryPrice: price,
              stopLossPrice: plannedSl,
              tp1Price: plannedTp1,
              tp2Price: plannedTp2,
              riskRewardRatio: actualRr,
              reason: `Near Major LL ($${majorFloor.toFixed(4)}) confirmed with ${reversalCheck.pattern}! Risk: -${((actualRisk / price) * 100).toFixed(2)}%, Target: +${(((plannedTp2 - price) / price) * 100).toFixed(2)}%, R:R: ${actualRr.toFixed(2)}x${tlNote}`,
              plannedEntryPrice: price,
              plannedSlPrice: plannedSl,
              plannedTp1Price: plannedTp1,
              plannedTp2Price: plannedTp2,
              plannedRrRatio: actualRr,
            };
          }
        } else {
          let blockReason = `Price in Near-LL zone ($${majorFloor.toFixed(4)} - $${retestZoneMax.toFixed(4)}). Waiting for Bullish Reversal candle confirmation`;
          if (!hasTrendlineHeadroom(price, plannedSl)) {
            blockReason = `Capped by Descending Trendline at $${tlResistancePrice.toFixed(4)} (insufficient R:R to trendline)`;
          } else if (reversalCheck.isReversal && (!isLivePriceHoldingReversal || isLiveDumping)) {
            blockReason = `Reversal formed, but live candle is currently pulling back/dumping. Waiting for price to stabilize above $${lastClosedBar?.open.toFixed(4)}`;
          } else if (!reversalCheck.isReversal) {
            blockReason = `Price in Near-LL zone ($${majorFloor.toFixed(4)} - $${retestZoneMax.toFixed(4)}). Waiting for Bullish Reversal candle confirmation (${reversalCheck.pattern})`;
          }
          return {
            hasSignal: false,
            entryPrice: 0,
            stopLossPrice: plannedSl,
            tp1Price: plannedTp1,
            tp2Price: plannedTp2,
            riskRewardRatio: plannedRr,
            reason: blockReason,
            plannedEntryPrice: plannedEntry,
            plannedSlPrice: plannedSl,
            plannedTp1Price: plannedTp1,
            plannedTp2Price: plannedTp2,
            plannedRrRatio: plannedRr,
          };
        }
      }
    }

    // ── Setup 4: Confirmed Descending Trendline Breakout (Near Base Only) ────
    if (config.enableTrendlineBreakoutEntry && downtrendLine) {
      // Strictly require confirmed multi-candle breakout (not unconfirmed intrabar tick) and near lower base
      const isConfirmedBreakout = Boolean(downtrendLine.breakoutConfirmed || downtrendBreakoutConfirmed);
      const maxBreakoutZone = activeSupportPrice + (majorSpan * 0.28);
      if (isConfirmedBreakout && price > downtrendLine.currentLinePrice && price <= maxBreakoutZone) {
        const stopLoss = activeSupportPrice * (1 - slBuffer);
        const risk = price - stopLoss;
        const tp1 = plannedTp1 > price * 1.01 ? plannedTp1 : midWavePrice;
        const tp2 = majorCeil > tp1 ? majorCeil * 0.996 : price * 1.04;
        const averageReward = (tp1 * config.tp1CloseRatio) + (tp2 * (1 - config.tp1CloseRatio)) - price;
        const rr = risk > 0 ? averageReward / risk : 0;

        if (rr >= config.minRiskReward) {
          return {
            hasSignal: true,
            signalType: "TL_BREAKOUT",
            entryPrice: price,
            stopLossPrice: stopLoss,
            tp1Price: tp1,
            tp2Price: tp2,
            riskRewardRatio: rr,
            reason: `Confirmed Descending Trendline Breakout above $${downtrendLine.currentLinePrice.toFixed(4)} with ${rr.toFixed(2)} R:R`,
            plannedEntryPrice: price,
            plannedSlPrice: stopLoss,
            plannedTp1Price: tp1,
            plannedTp2Price: tp2,
            plannedRrRatio: rr,
          };
        }
      }
    }

    // ── Standby Mode: Waiting for Pullback to Active Support Zone ─────────────
    const tlStatusSuffix = hasActiveDowntrendTl
      ? ` | TL Res: $${tlResistancePrice.toFixed(4)} (TP1 capped at TL)`
      : (uptrendLine?.isBroken ? ` | Uptrend Support Broken ($${uptrendLine.currentLinePrice.toFixed(4)})` : "");

    let standbyReason = `Price ($${price.toFixed(4)}) is above Near-LL zone. Waiting for pullback near Major LL ($${majorFloor.toFixed(4)} - $${retestZoneMax.toFixed(4)})${tlStatusSuffix}`;
    if (activeSupportType === "TRENDLINE") {
      standbyReason = `Price ($${price.toFixed(4)}) is above Trendline Support. Waiting for pullback near Trendline Support ($${tlSupportPrice.toFixed(4)})${tlStatusSuffix}`;
    } else if (activeSupportType === "HL_BASE") {
      standbyReason = `Price ($${price.toFixed(4)}) is above HL Support. Waiting for pullback near HL Support ($${hlSupportPrice.toFixed(4)})${tlStatusSuffix}`;
    }

    return {
      hasSignal: false,
      entryPrice: 0,
      stopLossPrice: plannedSl,
      tp1Price: plannedTp1,
      tp2Price: plannedTp2,
      riskRewardRatio: plannedRr,
      reason: standbyReason,
      plannedEntryPrice: plannedEntry,
      plannedSlPrice: plannedSl,
      plannedTp1Price: plannedTp1,
      plannedTp2Price: plannedTp2,
      plannedRrRatio: plannedRr,
    };
  }
}
