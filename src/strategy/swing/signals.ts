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

    // 1. Bullish Hammer / Pinbar / Sweep Rejection:
    // - Classic Pinbar: Lower wick >= 45%, closes in upper 30% of range, small upper wick <= 25%
    // - Strong Sweep Rejection: Lower wick >= 28% + solid green body >= 38%, closes in upper 25% of range
    const lowerWick = curr.open - curr.low;
    const upperWick = curr.high - curr.close;
    const lowerWickRatio = lowerWick / currRange;
    const upperWickRatio = upperWick / currRange;
    const bodyRatio = currBody / currRange;
    if (
      (lowerWickRatio >= 0.45 && curr.close >= curr.low + currRange * 0.70 && upperWickRatio <= 0.25) ||
      (lowerWickRatio >= 0.28 && bodyRatio >= 0.38 && curr.close >= curr.low + currRange * 0.75 && upperWickRatio <= 0.25)
    ) {
      return { isReversal: true, pattern: `Bullish Hammer / Rejection (Lower wick ${(lowerWickRatio * 100).toFixed(0)}%, Body ${(bodyRatio * 100).toFixed(0)}%)` };
    }

    // 2. Bullish Engulfing or Piercing Line Reversal:
    // Previous candle was red, current candle is solid green and pierces >= 45% into previous body or engulfs
    if (prev.close < prev.open) {
      const prevRedBody = prev.open - prev.close;
      // Piercing line: closes above 45% of previous red body
      const piercingThreshold = prev.close + (prevRedBody * 0.45);
      const isPiercingOrEngulfing = curr.close >= piercingThreshold;
      const hasSolidBody = bodyRatio >= 0.40 && upperWickRatio <= 0.30;

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
   * Detects a Multi-Bar Secondary Retest / Higher-Low Base Hold in the Near-LL / ATL zone.
   * Captures the classic 2-step bottoming structure where an initial rejection bar establishes a floor
   * and subsequent bar(s) retest the zone while defending a Higher Low above the anchor low.
   */
  private static checkSecondaryRetestHold(
    candles: Candle[],
    floorPrice: number,
    retestZoneTop: number,
    slPrice: number,
  ): { isReversal: boolean; pattern: string; anchorLow: number } {
    const closedCandles = candles.filter((c) => c.isClosed !== false);
    if (!closedCandles || closedCandles.length < 3 || floorPrice <= 0) {
      return { isReversal: false, pattern: "Insufficient history for secondary retest", anchorLow: 0 };
    }

    const curr = closedCandles[closedCandles.length - 1]!;
    const prev = closedCandles[closedCandles.length - 2]!;
    const currRange = curr.high - curr.low;
    if (currRange <= 0 || curr.close <= 0) {
      return { isReversal: false, pattern: "Invalid candle range", anchorLow: 0 };
    }

    // Scan up to 6 closed candles prior to `curr` for the primary rejection anchor in the retest zone
    const lookbackStart = Math.max(0, closedCandles.length - 7);
    const priorBars = closedCandles.slice(lookbackStart, closedCandles.length - 1);
    let anchorBar: Candle | undefined;

    for (const bar of priorBars) {
      const barRange = bar.high - bar.low;
      const touchedZone = bar.low <= retestZoneTop && bar.low >= slPrice;
      const showedRejection =
        barRange > 0 &&
        (bar.close > bar.open || (bar.close - bar.low) / barRange >= 0.45);
      if (touchedZone && showedRejection) {
        if (!anchorBar || bar.low < anchorBar.low) {
          anchorBar = bar;
        }
      }
    }

    if (!anchorBar) {
      return { isReversal: false, pattern: "No prior rejection anchor in zone", anchorLow: 0 };
    }

    // Ensure no candle after the anchor bar broke below the anchor low or closed below the floor
    const anchorIdx = closedCandles.findIndex((c) => c.time === anchorBar!.time);
    if (anchorIdx < 0 || anchorIdx >= closedCandles.length - 1) {
      return { isReversal: false, pattern: "Anchor bar index invalid", anchorLow: 0 };
    }
    for (let i = anchorIdx + 1; i < closedCandles.length; i++) {
      const c = closedCandles[i]!;
      if (c.low < anchorBar.low * 0.9995 || c.close < floorPrice * 0.9985) {
        return { isReversal: false, pattern: "Anchor low broken on subsequent bar", anchorLow: anchorBar.low };
      }
    }

    // Verify that `curr` (or `prev` + `curr`) dipped back into the retest zone and held a Higher Low >= anchorBar.low
    const currOrPrevTestedZone = curr.low <= retestZoneTop * 1.001 || prev.low <= retestZoneTop * 1.001;
    const retestLow = Math.min(curr.low, prev.low);
    const heldHigherLow = retestLow >= anchorBar.low * 0.9998 && retestLow >= floorPrice * 0.999;

    // Require buyer defense on `curr`: green/doji-green close in upper half of range or closing above `prev.close`
    const closePositionInRange = (curr.close - curr.low) / currRange;
    const lowerWickRatio = (Math.min(curr.open, curr.close) - curr.low) / currRange;
    const hasBuyerDefense =
      (curr.close >= curr.open && (closePositionInRange >= 0.45 || curr.close > prev.close)) ||
      (lowerWickRatio >= 0.35 && closePositionInRange >= 0.50 && curr.close >= prev.close * 0.9995);

    if (currOrPrevTestedZone && heldHigherLow && hasBuyerDefense) {
      return {
        isReversal: true,
        pattern: `Secondary Retest Higher-Low Hold ($${retestLow.toFixed(2)} >= $${anchorBar.low.toFixed(2)})`,
        anchorLow: anchorBar.low,
      };
    }

    return { isReversal: false, pattern: "No secondary retest hold", anchorLow: anchorBar.low };
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
    consumedBreakoutTlKey?: string,
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

    const slBuffer = Math.max(0.3, config.stopLossBufferPct) / 100;
    const floorSweepTolerance = Math.max(0.004, slBuffer);
    const closedCandles = candles.filter((c) => c.isClosed !== false);
    const lastClosedBar = closedCandles.length > 0 ? closedCandles[closedCandles.length - 1] : undefined;
    const prevClosedBar = closedCandles.length > 1 ? closedCandles[closedCandles.length - 2] : undefined;

    // ── 1. Identify Major Support Floor (Previous Major LL of Current Wave) ───
    let majorFloor = (bottomBound > 0 && bottomBound <= price * (1 + floorSweepTolerance)) ? bottomBound : 0;
    let majorFloorTime = activeValley?.time ?? 0;

    const recentLows = Array.isArray(swingLows) ? swingLows.slice(-20) : [];
    const candidateLows: { price: number; time: number }[] = [];
    if (waveCycle?.lastLl?.price && waveCycle.lastLl.price > 0 && waveCycle.lastLl.price <= price * (1 + floorSweepTolerance)) {
      candidateLows.push({ price: waveCycle.lastLl.price, time: waveCycle.lastLl.time });
    }
    if (activeValley?.price && activeValley.price > 0 && activeValley.price <= price * (1 + floorSweepTolerance)) {
      candidateLows.push({ price: activeValley.price, time: activeValley.time });
    }
    for (const s of recentLows) {
      if (s.price > 0 && s.price <= price * (1 + floorSweepTolerance)) {
        candidateLows.push({ price: s.price, time: s.time });
      }
    }
    if (waveCycle?.annotatedSwings) {
      for (const s of waveCycle.annotatedSwings.slice(-24)) {
        if (s.type === "LOW" && s.price > 0 && s.price <= price * (1 + floorSweepTolerance)) {
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

    // Prefer post-bottom structural highs so pre-dump peaks do not inflate the target frame,
    // but include activePeak / upperBound if post-bottom bounce highs are still narrow (< 2.0% above floor)
    let majorCeil = 0;
    if (postBottomHighs.length > 0) {
      majorCeil = Math.max(...postBottomHighs);
      if ((majorCeil - majorFloor) / majorFloor < 0.020) {
        if (upperBound > majorCeil && (upperBound - majorFloor) / majorFloor <= 0.045) {
          majorCeil = upperBound;
        } else if (activePeak?.price && activePeak.price > majorCeil && (activePeak.price - majorFloor) / majorFloor <= 0.045) {
          majorCeil = activePeak.price;
        }
      }
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

    // Check active unbroken Ascending Trendline (Uptrend Support Line)
    const hasActiveUptrendTl = Boolean(
      uptrendLine &&
      !uptrendLine.isBroken &&
      !uptrendLine.breakoutConfirmed &&
      uptrendLine.currentLinePrice > majorFloor &&
      uptrendLine.currentLinePrice <= price * 1.015,
    );
    const tlSupportPrice = hasActiveUptrendTl ? uptrendLine!.currentLinePrice : 0;

    // Check confirmed Higher Low (HL) after the floor (must be unbroken and not superseded by a newer LL)
    const isHlUnbroken = Boolean(
      waveCycle?.lastHl &&
      !waveCycle.lastHl.isBroken &&
      (!waveCycle.lastLl || waveCycle.lastLl.time < waveCycle.lastHl.time) &&
      waveCycle.lastHl.price > majorFloor &&
      (majorFloorTime === 0 || waveCycle.lastHl.time >= majorFloorTime) &&
      price >= waveCycle.lastHl.price * (1 - slBuffer) &&
      (!lastClosedBar || lastClosedBar.time <= waveCycle.lastHl.time || lastClosedBar.close >= waveCycle.lastHl.price * 0.998),
    );
    const recentHl = isHlUnbroken ? waveCycle!.lastHl : undefined;
    const hlSupportPrice = (recentHl && recentHl.price <= price * 1.005) ? recentHl.price : 0;

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
    const llSl = majorFloor * (1 - slBuffer);
    const hlSl = hlSupportPrice > 0 ? hlSupportPrice * (1 - slBuffer) : llSl;
    const tlSl = tlSupportPrice > 0
      ? Math.min(tlSupportPrice, hlSupportPrice > 0 ? hlSupportPrice : tlSupportPrice) * (1 - slBuffer)
      : llSl;

    // 🎯 Strict Retest Zone Thresholds:
    const maxNearLlSpan = Math.max(majorFloor * 0.004, Math.min(majorSpan * 0.20, majorFloor * 0.010));
    const retestZoneMax = majorFloor + maxNearLlSpan;

    let plannedSl = llSl;
    let plannedEntry = majorFloor + Math.min(majorSpan * 0.06, majorFloor * 0.004);

    // If a confirmed secondary higher-low valley / recent LL is holding inside the Near-LL retest zone,
    // anchor the default planned entry to that active base rather than the historical extreme wick.
    const secondaryZoneLowCandidates: number[] = [];
    if (
      waveCycle?.lastLl?.price &&
      waveCycle.lastLl.price > majorFloor &&
      waveCycle.lastLl.price <= retestZoneMax &&
      waveCycle.lastLl.price <= price * 1.002
    ) {
      secondaryZoneLowCandidates.push(waveCycle.lastLl.price);
    }
    if (
      structure.candidateValley?.price &&
      structure.candidateValley.price > majorFloor &&
      structure.candidateValley.price <= retestZoneMax &&
      structure.candidateValley.price <= price * 1.002
    ) {
      secondaryZoneLowCandidates.push(structure.candidateValley.price);
    }
    if (secondaryZoneLowCandidates.length > 0) {
      const highestHeldBase = Math.max(...secondaryZoneLowCandidates);
      plannedEntry = Math.max(plannedEntry, highestHeldBase);
    }

    if (activeSupportType === "TRENDLINE") {
      plannedSl = tlSl;
      plannedEntry = tlSupportPrice;
    } else if (activeSupportType === "HL_BASE") {
      plannedSl = hlSl;
      plannedEntry = hlSupportPrice;
    }

    // Raw TP1 is Mid-Wave (~50% retracement) or POC if within wave
    const midWavePrice = activeSupportPrice + (majorSpan * 0.50);
    const pocPrice = gridZone?.poc ?? 0;
    let rawTp1 = (pocPrice > plannedEntry * 1.006 && pocPrice < majorCeil * 0.996)
      ? Math.max(midWavePrice, pocPrice)
      : midWavePrice;

    // 📐 Trendline Target Integration:
    // If an unbroken descending trendline is pressing down below rawTp1 (and above plannedEntry),
    // set TP1 right under the descending trendline (-0.15% buffer) to take profit at the trendline!
    let plannedTp1 = rawTp1;
    let isTp1CappedByTl = false;
    if (hasActiveDowntrendTl && tlResistancePrice > plannedEntry * 1.004) {
      const tlTargetPrice = tlResistancePrice * 0.9985;
      if (tlTargetPrice < plannedTp1) {
        plannedTp1 = tlTargetPrice;
        isTp1CappedByTl = true;
      }
    }

    // TP2 is Retest of Post-Bottom Major High / Wave Origin Peak (Runner Target)
    let plannedTp2 = majorCeil * 0.996;
    if (plannedTp2 <= plannedTp1) {
      plannedTp2 = plannedTp1 * 1.012;
    }

    // Ensure plannedEntry for MAJOR_LL never exceeds the maximum price that still yields valid R:R
    if (activeSupportType === "MAJOR_LL") {
      const avgTp = (plannedTp1 * config.tp1CloseRatio) + (plannedTp2 * (1 - config.tp1CloseRatio));
      const plannedTp2Rr = (plannedTp2 - plannedEntry) / Math.max(1e-8, plannedEntry - llSl);
      const effectivePlannedMinRr = (plannedTp2Rr >= config.minRiskReward * 0.75 || isTp1CappedByTl)
        ? Math.min(config.minRiskReward, 1.15)
        : config.minRiskReward;
      const maxValidEntry = (avgTp + (effectivePlannedMinRr * llSl)) / (1 + effectivePlannedMinRr);
      if (maxValidEntry > majorFloor) {
        plannedEntry = Math.min(plannedEntry, maxValidEntry);
      }
    }

    const plannedRisk = Math.max(1e-8, plannedEntry - plannedSl);
    const plannedAvgReward = (plannedTp1 * config.tp1CloseRatio) + (plannedTp2 * (1 - config.tp1CloseRatio)) - plannedEntry;
    const plannedRr = plannedRisk > 0 ? plannedAvgReward / plannedRisk : 0;

    // Reject entry if market is breaking below Major LL Stop Loss, confirmed breakdown below floor, or structure in WARMUP
    const isConfirmedBreakdown = Boolean(
      lastClosedBar &&
      majorFloorTime > 0 &&
      lastClosedBar.time > majorFloorTime &&
      lastClosedBar.close < majorFloor * 0.997,
    );
    const isSupportBroken = majorFloor <= 0 || price < llSl || isConfirmedBreakdown;
    const isStructureUnstable =
      structure.regime === "WARMUP" ||
      !structure.isSwingConfirmed ||
      (bottomBound <= 0 && majorFloor <= 0) ||
      isSupportBroken;

    if (isStructureUnstable) {
      const gateMsg = isSupportBroken
        ? "SUPPORT_BROKEN_NEW_LOW"
        : (structure.regime === "WARMUP" ? "WARMUP_UNCONFIRMED_BASE" : "UNCONFIRMED_SWING_BASE");

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
      // Do not buy right into an unbroken descending trendline (need >= 0.8% room and >= 1.15x R:R to trendline)
      const roomToTl = tlResistancePrice * 0.9985 - entryCandidate;
      const roomPct = (roomToTl / entryCandidate) * 100;
      const riskToSl = Math.max(1e-8, entryCandidate - slCandidate);
      const rrToTl = roomToTl / riskToSl;
      return roomPct >= 0.8 && rrToTl >= 1.15;
    };

    // ── Setup 1: Uptrend Line Support Retest & Bounce (SUPPORT_RETEST) ───────
    if (config.enableSupportRetestEntry && hasActiveUptrendTl && tlSupportPrice > majorFloor) {
      const isPriceInTlRetestZone = price >= tlSl && price <= tlSupportPrice * 1.010;

      if (isPriceInTlRetestZone) {
        const reversalCheck = this.checkBullishReversal(candles);

        const isLivePriceHoldingReversal = !lastClosedBar || price >= lastClosedBar.open * 0.9995;
        const liveCandle = candles[candles.length - 1]?.isClosed === false ? candles[candles.length - 1] : undefined;
        const isLiveDumping = Boolean(
          liveCandle &&
          lastClosedBar &&
          liveCandle.close < liveCandle.open &&
          (liveCandle.open - liveCandle.close) > (lastClosedBar.close - lastClosedBar.open) * 0.6,
        );

        if (reversalCheck.isReversal && isLivePriceHoldingReversal && !isLiveDumping && hasTrendlineHeadroom(price, tlSl)) {
          const actualRisk = price - tlSl;
          const actualAvgReward = (plannedTp1 * config.tp1CloseRatio) + (plannedTp2 * (1 - config.tp1CloseRatio)) - price;
          const actualRr = actualRisk > 0 ? actualAvgReward / actualRisk : 0;

          if (actualRr >= config.minRiskReward) {
            const tlNote = hasActiveDowntrendTl ? ` | TL TP1: $${plannedTp1.toFixed(4)}` : "";
            return {
              hasSignal: true,
              signalType: "SUPPORT_RETEST",
              entryPrice: price,
              stopLossPrice: tlSl,
              tp1Price: plannedTp1,
              tp2Price: plannedTp2,
              riskRewardRatio: actualRr,
              reason: `Uptrend Line Support Retest at $${tlSupportPrice.toFixed(4)} confirmed with ${reversalCheck.pattern}! Risk: -${((actualRisk / price) * 100).toFixed(2)}%, Target: +${(((plannedTp2 - price) / price) * 100).toFixed(2)}%, R:R: ${actualRr.toFixed(2)}x${tlNote}`,
              plannedEntryPrice: price,
              plannedSlPrice: tlSl,
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
      const isPriceInHlRetestZone = price >= hlSl && price <= hlSupportPrice * 1.010;

      if (isPriceInHlRetestZone) {
        const reversalCheck = this.checkBullishReversal(candles);

        const isLivePriceHoldingReversal = !lastClosedBar || price >= lastClosedBar.open * 0.9995;
        const liveCandle = candles[candles.length - 1]?.isClosed === false ? candles[candles.length - 1] : undefined;
        const isLiveDumping = Boolean(
          liveCandle &&
          lastClosedBar &&
          liveCandle.close < liveCandle.open &&
          (liveCandle.open - liveCandle.close) > (lastClosedBar.close - lastClosedBar.open) * 0.6,
        );

        if (reversalCheck.isReversal && isLivePriceHoldingReversal && !isLiveDumping && hasTrendlineHeadroom(price, hlSl)) {
          const actualRisk = price - hlSl;
          const actualAvgReward = (plannedTp1 * config.tp1CloseRatio) + (plannedTp2 * (1 - config.tp1CloseRatio)) - price;
          const actualRr = actualRisk > 0 ? actualAvgReward / actualRisk : 0;

          if (actualRr >= config.minRiskReward) {
            const tlNote = hasActiveDowntrendTl ? ` | TL TP1: $${plannedTp1.toFixed(4)}` : "";
            return {
              hasSignal: true,
              signalType: "HL_BASE",
              entryPrice: price,
              stopLossPrice: hlSl,
              tp1Price: plannedTp1,
              tp2Price: plannedTp2,
              riskRewardRatio: actualRr,
              reason: `Higher Low (HL) Support Retest at $${hlSupportPrice.toFixed(4)} confirmed with ${reversalCheck.pattern}! Risk: -${((actualRisk / price) * 100).toFixed(2)}%, Target: +${(((plannedTp2 - price) / price) * 100).toFixed(2)}%, R:R: ${actualRr.toFixed(2)}x${tlNote}`,
              plannedEntryPrice: price,
              plannedSlPrice: hlSl,
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
      // Check if current price or the reversal bar(s) tested the Near-LL Retest Zone without breaking SL
      const lastBarTouchedZone = Boolean(
        lastClosedBar &&
        (majorFloorTime === 0 || lastClosedBar.time >= majorFloorTime) &&
        lastClosedBar.low <= retestZoneMax &&
        lastClosedBar.low >= llSl,
      );
      const prevBarTouchedZone = Boolean(
        prevClosedBar &&
        (majorFloorTime === 0 || prevClosedBar.time >= majorFloorTime) &&
        prevClosedBar.low <= retestZoneMax &&
        prevClosedBar.low >= llSl,
      );
      const secondaryRetest = this.checkSecondaryRetestHold(candles, majorFloor, retestZoneMax, llSl);
      const isPriceInRetestZone = price >= llSl && price <= retestZoneMax;
      const isPriceInLowerWave = price >= llSl && price <= majorFloor + (majorSpan * 0.35);

      if (isPriceInRetestZone || ((lastBarTouchedZone || prevBarTouchedZone || secondaryRetest.isReversal) && isPriceInLowerWave)) {
        const singleBarReversal = this.checkBullishReversal(candles);
        const reversalCheck = singleBarReversal.isReversal
          ? singleBarReversal
          : (secondaryRetest.isReversal
              ? { isReversal: true, pattern: secondaryRetest.pattern }
              : singleBarReversal);

        // Anti-Falling Knife: Live tick price check against the reversal bar or secondary retest base low
        const reversalLowThreshold = reversalCheck.isReversal && secondaryRetest.anchorLow > 0
          ? Math.min(secondaryRetest.anchorLow, lastClosedBar?.low ?? majorFloor)
          : (lastClosedBar?.low ?? majorFloor);
        const isLivePriceHoldingReversal = !lastClosedBar || price >= reversalLowThreshold * 0.9995;

        // Check if there is an unclosed live candle currently dumping hard
        const liveCandle = candles[candles.length - 1]?.isClosed === false ? candles[candles.length - 1] : undefined;
        const isLiveDumping = Boolean(
          liveCandle &&
          lastClosedBar &&
          liveCandle.close < liveCandle.open &&
          (liveCandle.open - liveCandle.close) > Math.max(20, Math.abs(lastClosedBar.close - lastClosedBar.open) * 0.6),
        );

        // Since TP1 is already capped right under the descending trendline, only require >= 0.25% room below trendline target
        const hasFloorTlRoom = !hasActiveDowntrendTl || tlResistancePrice <= 0 || (tlResistancePrice * 0.9985) > price * 1.0025;

        const actualRisk = price - llSl;
        const actualAvgReward = (plannedTp1 * config.tp1CloseRatio) + (plannedTp2 * (1 - config.tp1CloseRatio)) - price;
        const actualRr = actualRisk > 0 ? actualAvgReward / actualRisk : 0;
        const tp2Rr = actualRisk > 0 ? (plannedTp2 - price) / actualRisk : 0;
        const effectiveMinRr = (tp2Rr >= config.minRiskReward * 0.75 || isTp1CappedByTl)
          ? Math.min(config.minRiskReward, 1.15)
          : config.minRiskReward;

        if (reversalCheck.isReversal && isLivePriceHoldingReversal && !isLiveDumping && hasFloorTlRoom) {
          if (actualRr >= effectiveMinRr) {
            const tlNote = hasActiveDowntrendTl ? ` | TL TP1: $${plannedTp1.toFixed(4)}` : "";
            return {
              hasSignal: true,
              signalType: "LL_RETEST_BOUNCE",
              entryPrice: price,
              stopLossPrice: llSl,
              tp1Price: plannedTp1,
              tp2Price: plannedTp2,
              riskRewardRatio: actualRr,
              reason: `Near Major LL ($${majorFloor.toFixed(4)}) confirmed with ${reversalCheck.pattern}! Risk: -${((actualRisk / price) * 100).toFixed(2)}%, Target: +${(((plannedTp2 - price) / price) * 100).toFixed(2)}%, R:R: ${actualRr.toFixed(2)}x${tlNote}`,
              plannedEntryPrice: price,
              plannedSlPrice: llSl,
              plannedTp1Price: plannedTp1,
              plannedTp2Price: plannedTp2,
              plannedRrRatio: actualRr,
            };
          } else {
            // Reversal confirmed, but current price jumped slightly too high for effectiveMinRr; calculate max entry price for min R:R
            const avgTp = (plannedTp1 * config.tp1CloseRatio) + (plannedTp2 * (1 - config.tp1CloseRatio));
            const maxEntryForMinRr = (avgTp + (effectiveMinRr * llSl)) / (1 + effectiveMinRr);
            const targetDipEntry = Math.max(majorFloor, Math.min(price, maxEntryForMinRr));
            return {
              hasSignal: false,
              entryPrice: 0,
              stopLossPrice: llSl,
              tp1Price: plannedTp1,
              tp2Price: plannedTp2,
              riskRewardRatio: effectiveMinRr,
              reason: `Major LL ($${majorFloor.toFixed(4)}) bounce confirmed (${reversalCheck.pattern}), waiting for minor pullback <= $${targetDipEntry.toFixed(4)} to achieve ${effectiveMinRr.toFixed(2)}x R:R (current: ${actualRr.toFixed(2)}x)`,
              plannedEntryPrice: targetDipEntry,
              plannedSlPrice: llSl,
              plannedTp1Price: plannedTp1,
              plannedTp2Price: plannedTp2,
              plannedRrRatio: effectiveMinRr,
            };
          }
        } else {
          let blockReason = `Price in Near-LL zone ($${majorFloor.toFixed(4)} - $${retestZoneMax.toFixed(4)}). Waiting for Bullish Reversal candle confirmation`;
          if (!hasFloorTlRoom) {
            blockReason = `Capped by Descending Trendline at $${tlResistancePrice.toFixed(4)} (price too close to trendline resistance)`;
          } else if (reversalCheck.isReversal && (!isLivePriceHoldingReversal || isLiveDumping)) {
            blockReason = `Reversal formed (${reversalCheck.pattern}), but live candle is currently pulling back/dumping. Waiting for price to stabilize above $${Math.min(lastClosedBar?.open ?? price, lastClosedBar?.close ?? price).toFixed(4)}`;
          } else if (!reversalCheck.isReversal) {
            blockReason = `Price near Major LL zone ($${majorFloor.toFixed(4)} - $${retestZoneMax.toFixed(4)}). Waiting for Bullish Reversal candle confirmation (${reversalCheck.pattern})`;
          }
          return {
            hasSignal: false,
            entryPrice: 0,
            stopLossPrice: llSl,
            tp1Price: plannedTp1,
            tp2Price: plannedTp2,
            riskRewardRatio: plannedRr,
            reason: blockReason,
            plannedEntryPrice: plannedEntry,
            plannedSlPrice: llSl,
            plannedTp1Price: plannedTp1,
            plannedTp2Price: plannedTp2,
            plannedRrRatio: plannedRr,
          };
        }
      }
    }

    // ── Setup 4: Fresh Confirmed Descending Trendline Breakout (Near Line Only) ────
    if (config.enableTrendlineBreakoutEntry && downtrendLine) {
      const currentTlKey = downtrendLine.p1 && downtrendLine.p2 ? `${downtrendLine.p1.time}_${downtrendLine.p2.time}` : undefined;
      const isConsumed = Boolean(currentTlKey && consumedBreakoutTlKey === currentTlKey);

      // 1. Strictly require fresh breakout (must be confirmed on 2nd or 3rd bar only, never stale 4+ bars)
      const brokenCandles = downtrendLine.brokenCandleCount ?? (downtrendLine.breakoutConfirmed ? 2 : 0);
      const isFreshBreakout = Boolean((downtrendLine.breakoutConfirmed || downtrendBreakoutConfirmed) && brokenCandles >= 2 && brokenCandles <= 3);

      // 2. Strictly require price to be hugging the trendline (max 0.20% above the broken line), NOT chasing a multi-candle rally
      const maxBreakoutPrice = downtrendLine.currentLinePrice * 1.0020;
      const isNearLine = price > downtrendLine.currentLinePrice && price <= maxBreakoutPrice;

      // 3. Reject entry if price is extended near a candidate peak or in the upper portion of the wave
      const isNearPeak = Boolean(structure?.candidatePeak?.price && price >= structure.candidatePeak.price * 0.995);
      const isOverExtended = majorSpan > 0 && ((price - majorFloor) / majorSpan) > 0.40;

      if (!isConsumed && isFreshBreakout && isNearLine && !isNearPeak && !isOverExtended) {
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
            reason: `Confirmed Fresh Trendline Breakout above $${downtrendLine.currentLinePrice.toFixed(4)} with ${rr.toFixed(2)} R:R`,
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
    } else if (downtrendLine?.breakoutConfirmed && price > downtrendLine.currentLinePrice) {
      standbyReason = `Trendline Breakout confirmed. Waiting for pullback/retest near support ($${activeSupportPrice.toFixed(4)})${tlStatusSuffix}`;
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
