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
   * Helper to inspect recent candles for a bullish reversal pattern at support.
   */
  private static checkBullishReversal(candles: Candle[]): { isReversal: boolean; pattern: string } {
    if (!candles || candles.length < 2) {
      return { isReversal: false, pattern: "Insufficient candle history" };
    }

    const curr = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    if (!curr || !prev) return { isReversal: false, pattern: "No candle data" };

    const currRange = curr.high - curr.low;
    const currBody = curr.close - curr.open;
    const prevRange = prev.high - prev.low;
    const prevBody = prev.close - prev.open;

    if (currRange <= 0) return { isReversal: false, pattern: "Zero range" };

    // 1. Bullish Hammer / Pinbar Rejection: Long lower wick >= 38% and close near high
    const lowerWick = Math.min(curr.open, curr.close) - curr.low;
    const lowerWickRatio = lowerWick / currRange;
    if (lowerWickRatio >= 0.38 && curr.close >= curr.low + currRange * 0.45) {
      return { isReversal: true, pattern: `Pinbar Rejection (Lower wick ${(lowerWickRatio * 100).toFixed(0)}%)` };
    }

    // 2. Bullish Engulfing: Current green candle engulfs previous red candle
    if (curr.close > curr.open && prev.close <= prev.open && curr.close >= prev.open && curr.open <= prev.close) {
      return { isReversal: true, pattern: "Bullish Engulfing Candle" };
    }

    // 3. Strong Momentum Close: Green candle closing above previous high with good body
    if (curr.close > curr.open && curr.close > prev.high && (curr.close - curr.low) / currRange >= 0.60) {
      return { isReversal: true, pattern: "Bullish Breakout Above Previous Bar" };
    }

    // 4. Consecutive Higher Lows on green candle
    if (curr.close > curr.open && curr.low > prev.low && curr.close > prev.close) {
      return { isReversal: true, pattern: "Bullish Micro Bounce (HL Bar)" };
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
    let majorFloor = bottomBound > 0 ? bottomBound : price * 0.95;
    let majorFloorTime = activeValley?.time ?? 0;

    const recentLows = Array.isArray(swingLows) ? swingLows.slice(-20) : [];
    const candidateLows: { price: number; time: number }[] = [];
    if (waveCycle?.lastLl?.price && waveCycle.lastLl.price > 0 && waveCycle.lastLl.price <= price * 1.03) {
      candidateLows.push({ price: waveCycle.lastLl.price, time: waveCycle.lastLl.time });
    }
    if (activeValley?.price && activeValley.price > 0 && activeValley.price <= price * 1.03) {
      candidateLows.push({ price: activeValley.price, time: activeValley.time });
    }
    for (const s of recentLows) {
      if (s.price > 0 && s.price <= price * 1.03) {
        candidateLows.push({ price: s.price, time: s.time });
      }
    }
    if (waveCycle?.annotatedSwings) {
      for (const s of waveCycle.annotatedSwings.slice(-24)) {
        if (s.type === "LOW" && s.price > 0 && s.price <= price * 1.03) {
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

    // If an unbroken descending trendline is active, anchor the wave ceiling to the trendline structure
    if (hasActiveDowntrendTl && downtrendLine) {
      const tlAnchorHigh = Math.max(
        tlResistancePrice,
        downtrendLine.p2?.price ?? 0,
        postBottomHighs.length > 0 ? Math.max(...postBottomHighs) : 0,
      );
      if (tlAnchorHigh > majorFloor && tlAnchorHigh < majorCeil) {
        majorCeil = tlAnchorHigh;
      }
    }

    // Ensure minimum healthy swing width (>= 2.0% span to avoid micro-channels)
    let majorSpan = majorCeil - majorFloor;
    if (majorSpan / majorFloor < 0.02) {
      majorCeil = majorFloor * 1.035;
      majorSpan = majorCeil - majorFloor;
    }

    // ── 3. Calculate Planned Levels & Trendline-Aware Risk:Reward ─────────────
    const slBuffer = Math.max(0.3, config.stopLossBufferPct) / 100;
    const plannedSl = majorFloor * (1 - slBuffer);

    // Strict Near-LL Planned Entry: ~5-6% of wave span above Major LL (or max +0.4% above LL)
    const plannedEntry = majorFloor + Math.min(majorSpan * 0.06, majorFloor * 0.004);

    // Raw TP1 is Mid-Wave (~50% retracement) or POC if within wave
    const midWavePrice = majorFloor + (majorSpan * 0.50);
    const pocPrice = gridZone?.poc ?? 0;
    let rawTp1 = (pocPrice > plannedEntry * 1.012 && pocPrice < majorCeil * 0.98)
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
      // When capped by a descending trendline, anchor TP2 to the recent LH / post-bottom peak
      const postPeakTarget = Math.max(downtrendLine.p2.price, postBottomHighs.length > 0 ? Math.max(...postBottomHighs) : 0) * 0.996;
      if (postPeakTarget > plannedTp1 && postPeakTarget < plannedTp2) {
        plannedTp2 = postPeakTarget;
      }
    }
    if (plannedTp2 <= plannedTp1) {
      plannedTp2 = plannedTp1 * 1.015;
    }

    const plannedRisk = plannedEntry - plannedSl;
    const plannedAvgReward = (plannedTp1 * config.tp1CloseRatio) + (plannedTp2 * (1 - config.tp1CloseRatio)) - plannedEntry;
    const plannedRr = plannedRisk > 0 ? plannedAvgReward / plannedRisk : 0;

    // 🎯 Strict Near-LL Retest Zone Threshold:
    // Must be within bottom 15% of the active wave span OR within +1.0% of Major LL (whichever is tighter)
    const maxNearLlSpan = Math.min(majorSpan * 0.15, majorFloor * 0.010);
    const retestZoneMax = majorFloor + maxNearLlSpan;

    // Reject entry if market is in active falling knife or breaking below floor
    if (gridZone?.gateStatus === "WAITING_FOR_BASE_CONFIRMATION" || gridZone?.gateStatus === "DOWNTREND_NO_CHANNEL") {
      return {
        hasSignal: false,
        entryPrice: 0,
        stopLossPrice: plannedSl,
        tp1Price: plannedTp1,
        tp2Price: plannedTp2,
        riskRewardRatio: plannedRr,
        reason: `Market gated (${gridZone.gateStatus}) — Waiting for confirmed base near LL $${majorFloor.toFixed(4)}`,
        plannedEntryPrice: plannedEntry,
        plannedSlPrice: plannedSl,
        plannedTp1Price: plannedTp1,
        plannedTp2Price: plannedTp2,
        plannedRrRatio: plannedRr,
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

    // ── Setup 1: Major LL Retest & Bullish Reversal Bounce (Strict Near-LL) ───
    if (config.enableSupportRetestEntry) {
      // Strictly require price to be inside the Near-LL Retest Zone (no * 1.01 price inflation!)
      const isPriceInRetestZone = price >= plannedSl && price <= retestZoneMax;

      if (isPriceInRetestZone) {
        const reversalCheck = this.checkBullishReversal(candles);
        // Only count micro HL if it also formed inside the Near-LL zone
        const hasNearLlMicroHl = Boolean(
          waveCycle?.lastHl &&
          waveCycle.lastHl.price >= majorFloor &&
          waveCycle.lastHl.price <= retestZoneMax,
        );

        if ((reversalCheck.isReversal || hasNearLlMicroHl) && hasTrendlineHeadroom(price, plannedSl)) {
          const actualRisk = price - plannedSl;
          const actualAvgReward = (plannedTp1 * config.tp1CloseRatio) + (plannedTp2 * (1 - config.tp1CloseRatio)) - price;
          const actualRr = actualRisk > 0 ? actualAvgReward / actualRisk : 0;

          if (actualRr >= config.minRiskReward) {
            const patternDesc = reversalCheck.isReversal ? reversalCheck.pattern : "Confirmed Near-LL Micro HL";
            const tlNote = hasActiveDowntrendTl ? ` | TL TP1: $${plannedTp1.toFixed(4)}` : "";
            return {
              hasSignal: true,
              signalType: "LL_RETEST_BOUNCE",
              entryPrice: price,
              stopLossPrice: plannedSl,
              tp1Price: plannedTp1,
              tp2Price: plannedTp2,
              riskRewardRatio: actualRr,
              reason: `Near Major LL ($${majorFloor.toFixed(4)}) held with ${patternDesc}! Risk: -${((actualRisk / price) * 100).toFixed(2)}%, Target: +${(((plannedTp2 - price) / price) * 100).toFixed(2)}%, R:R: ${actualRr.toFixed(2)}x${tlNote}`,
              plannedEntryPrice: price,
              plannedSlPrice: plannedSl,
              plannedTp1Price: plannedTp1,
              plannedTp2Price: plannedTp2,
              plannedRrRatio: actualRr,
            };
          }
        } else {
          const blockReason = !hasTrendlineHeadroom(price, plannedSl)
            ? `Capped by Descending Trendline at $${tlResistancePrice.toFixed(4)} (insufficient R:R to trendline)`
            : `Price in Near-LL zone ($${majorFloor.toFixed(4)} - $${retestZoneMax.toFixed(4)}). Waiting for Bullish Reversal candle confirmation`;
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

    // ── Setup 2: Confirmed Descending Trendline Breakout (Near Base Only) ────
    if (config.enableTrendlineBreakoutEntry && downtrendLine) {
      // Strictly require confirmed multi-candle breakout (not unconfirmed intrabar tick) and near lower base
      const isConfirmedBreakout = Boolean(downtrendLine.breakoutConfirmed || downtrendBreakoutConfirmed);
      const maxBreakoutZone = majorFloor + (majorSpan * 0.28);
      if (isConfirmedBreakout && price > downtrendLine.currentLinePrice && price <= maxBreakoutZone) {
        const stopLoss = majorFloor * (1 - slBuffer);
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

    // ── Setup 3: Confirmed Higher Low (HL) Base (Strictly Near Major LL Only) ─
    if (config.enableHlBaseEntry && waveCycle?.lastHl) {
      const hl = waveCycle.lastHl;
      const isRecentHl = waveCycle.annotatedSwings?.slice(-4).some((s) => s.index === hl.index);
      const maxHlBasePrice = majorFloor + Math.min(majorSpan * 0.18, majorFloor * 0.012);
      const isUptrendSupportBroken = Boolean(uptrendLine?.isBroken && uptrendLine?.breakoutConfirmed);

      // Strictly require HL to be anchored near Major LL, current price inside Near-LL zone, and uptrend support intact
      if (
        isRecentHl &&
        !isUptrendSupportBroken &&
        hl.price >= majorFloor &&
        hl.price <= maxHlBasePrice &&
        price >= hl.price &&
        price <= retestZoneMax * 1.002 &&
        hasTrendlineHeadroom(price, hl.price * (1 - slBuffer))
      ) {
        const stopLoss = hl.price * (1 - slBuffer);
        const risk = price - stopLoss;
        const tp1 = plannedTp1 > price * 1.008 ? plannedTp1 : midWavePrice;
        const tp2 = plannedTp2 > tp1 ? plannedTp2 : majorCeil * 0.996;
        const averageReward = (tp1 * config.tp1CloseRatio) + (tp2 * (1 - config.tp1CloseRatio)) - price;
        const rr = risk > 0 ? averageReward / risk : 0;

        if (rr >= config.minRiskReward) {
          return {
            hasSignal: true,
            signalType: "HL_BASE",
            entryPrice: price,
            stopLossPrice: stopLoss,
            tp1Price: tp1,
            tp2Price: tp2,
            riskRewardRatio: rr,
            reason: `Confirmed Near-LL Higher Low (HL) base at $${hl.price.toFixed(4)} with ${rr.toFixed(2)} R:R`,
            plannedEntryPrice: price,
            plannedSlPrice: stopLoss,
            plannedTp1Price: tp1,
            plannedTp2Price: tp2,
            plannedRrRatio: rr,
          };
        }
      }
    }

    // ── Standby Mode: Waiting for Pullback to Near-LL Zone ────────────────────
    const tlStatusSuffix = hasActiveDowntrendTl
      ? ` | TL Res: $${tlResistancePrice.toFixed(4)} (TP1 capped at TL)`
      : (uptrendLine?.isBroken ? ` | Uptrend Support Broken ($${uptrendLine.currentLinePrice.toFixed(4)})` : "");

    return {
      hasSignal: false,
      entryPrice: 0,
      stopLossPrice: plannedSl,
      tp1Price: plannedTp1,
      tp2Price: plannedTp2,
      riskRewardRatio: plannedRr,
      reason: `Price ($${price.toFixed(4)}) is above Near-LL zone. Waiting for pullback near Major LL ($${majorFloor.toFixed(4)} - $${retestZoneMax.toFixed(4)})${tlStatusSuffix}`,
      plannedEntryPrice: plannedEntry,
      plannedSlPrice: plannedSl,
      plannedTp1Price: plannedTp1,
      plannedTp2Price: plannedTp2,
      plannedRrRatio: plannedRr,
    };
  }
}
