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
      waveCycle,
      gridZone,
    } = structure;

    // ── 1. Identify Major Support Floor (Previous Major LL) ───────────────────
    const validLows: number[] = [];
    if (bottomBound > 0) validLows.push(bottomBound);
    if (activeValley?.price && activeValley.price > 0) validLows.push(activeValley.price);
    if (Array.isArray(swingLows)) {
      for (const s of swingLows) {
        if (s.price > 0 && s.price <= price * 1.05) validLows.push(s.price);
      }
    }
    if (waveCycle?.annotatedSwings) {
      for (const s of waveCycle.annotatedSwings) {
        if (s.type === "LOW" && s.price > 0 && s.price <= price * 1.05) {
          validLows.push(s.price);
        }
      }
    }
    const majorFloor = validLows.length > 0 ? Math.min(...validLows) : (bottomBound > 0 ? bottomBound : price * 0.95);

    // ── 2. Identify Major Resistance Ceiling (Post-Bottom HH / High) ──────────
    const validHighs: number[] = [];
    if (upperBound > 0) validHighs.push(upperBound);
    if (activePeak?.price && activePeak.price > 0) validHighs.push(activePeak.price);
    if (Array.isArray(swingHighs)) {
      for (const s of swingHighs) {
        if (s.price > majorFloor) validHighs.push(s.price);
      }
    }
    if (waveCycle?.annotatedSwings) {
      for (const s of waveCycle.annotatedSwings) {
        if (s.type === "HIGH" && s.price > majorFloor) {
          validHighs.push(s.price);
        }
      }
    }
    let majorCeil = validHighs.length > 0 ? Math.max(...validHighs) : (upperBound > 0 ? upperBound : majorFloor * 1.08);

    // Ensure minimum healthy swing width (>= 3.0% span to avoid peanut micro-channels)
    let majorSpan = majorCeil - majorFloor;
    if (majorSpan / majorFloor < 0.03) {
      majorCeil = majorFloor * 1.05;
      majorSpan = majorCeil - majorFloor;
    }

    // ── 3. Calculate Planned Levels & Risk:Reward ─────────────────────────────
    const slBuffer = Math.max(0.3, config.stopLossBufferPct) / 100;
    const plannedSl = majorFloor * (1 - slBuffer);
    // Planned entry is just above the LL floor (~0.8% - 1.2% above floor)
    const plannedEntry = majorFloor + (majorSpan * 0.08);
    // TP1 is Mid-Wave (POC / Center / ~50% - 55% retracement)
    const plannedTp1 = centerPrice > plannedEntry && centerPrice < majorCeil
      ? centerPrice
      : majorFloor + (majorSpan * 0.52);
    // TP2 is Retest of Major High / HH
    const plannedTp2 = majorCeil * 0.995;

    const plannedRisk = plannedEntry - plannedSl;
    const plannedAvgReward = (plannedTp1 * config.tp1CloseRatio) + (plannedTp2 * (1 - config.tp1CloseRatio)) - plannedEntry;
    const plannedRr = plannedRisk > 0 ? plannedAvgReward / plannedRisk : 0;

    // Retest Zone Threshold: Bottom 30% of the Major Wave
    const retestZoneMax = majorFloor + (majorSpan * 0.30);

    // Reject entry if market is in active falling knife or breaking below floor
    if (gridZone?.gateStatus === "WAITING_FOR_BASE_CONFIRMATION" || gridZone?.gateStatus === "DOWNTREND_NO_CHANNEL") {
      return {
        hasSignal: false,
        entryPrice: 0,
        stopLossPrice: plannedSl,
        tp1Price: plannedTp1,
        tp2Price: plannedTp2,
        riskRewardRatio: plannedRr,
        reason: `Market gated (${gridZone.gateStatus}) — Waiting for confirmed base above $${majorFloor.toFixed(4)}`,
        plannedEntryPrice: plannedEntry,
        plannedSlPrice: plannedSl,
        plannedTp1Price: plannedTp1,
        plannedTp2Price: plannedTp2,
        plannedRrRatio: plannedRr,
      };
    }

    // ── Setup 1: Major LL Retest & Bullish Reversal Bounce ───────────────────
    if (config.enableSupportRetestEntry) {
      // Check if price is within the LL Retest Zone
      const isPriceInRetestZone = price >= plannedSl && price <= retestZoneMax * 1.01;

      if (isPriceInRetestZone) {
        // Price held above Stop Loss! Check for Bullish Reversal pattern:
        const reversalCheck = this.checkBullishReversal(candles);
        const hasMicroHl = Boolean(waveCycle?.lastHl && waveCycle.lastHl.price >= majorFloor);

        if (reversalCheck.isReversal || hasMicroHl) {
          const actualRisk = price - plannedSl;
          const actualAvgReward = (plannedTp1 * config.tp1CloseRatio) + (plannedTp2 * (1 - config.tp1CloseRatio)) - price;
          const actualRr = actualRisk > 0 ? actualAvgReward / actualRisk : 0;

          if (actualRr >= config.minRiskReward) {
            const patternDesc = reversalCheck.isReversal ? reversalCheck.pattern : "Confirmed Micro HL";
            return {
              hasSignal: true,
              signalType: "LL_RETEST_BOUNCE",
              entryPrice: price,
              stopLossPrice: plannedSl,
              tp1Price: plannedTp1,
              tp2Price: plannedTp2,
              riskRewardRatio: actualRr,
              reason: `Major LL ($${majorFloor.toFixed(4)}) held with ${patternDesc}! Risk: -${((actualRisk / price) * 100).toFixed(2)}%, Target: +${(((plannedTp2 - price) / price) * 100).toFixed(2)}%, R:R: ${actualRr.toFixed(2)}x`,
              plannedEntryPrice: price,
              plannedSlPrice: plannedSl,
              plannedTp1Price: plannedTp1,
              plannedTp2Price: plannedTp2,
              plannedRrRatio: actualRr,
            };
          }
        } else {
          return {
            hasSignal: false,
            entryPrice: 0,
            stopLossPrice: plannedSl,
            tp1Price: plannedTp1,
            tp2Price: plannedTp2,
            riskRewardRatio: plannedRr,
            reason: `Price at Major LL support zone ($${majorFloor.toFixed(4)} - $${retestZoneMax.toFixed(4)}). Waiting for Bullish Reversal candle confirmation`,
            plannedEntryPrice: plannedEntry,
            plannedSlPrice: plannedSl,
            plannedTp1Price: plannedTp1,
            plannedTp2Price: plannedTp2,
            plannedRrRatio: plannedRr,
          };
        }
      }
    }

    // ── Setup 2: Descending Trendline Breakout ──────────────────────────────
    if (config.enableTrendlineBreakoutEntry && downtrendLine) {
      const isBreakout = downtrendLine.isBroken || price > downtrendLine.currentLinePrice;
      if (isBreakout && activeValley && price > activeValley.price && price <= majorCeil * 0.90) {
        const stopLoss = activeValley.price * (1 - slBuffer);
        const risk = price - stopLoss;
        const tp1 = plannedTp1 > price ? plannedTp1 : price * 1.025;
        const tp2 = majorCeil > price ? majorCeil : price * 1.05;
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
            reason: `Descending Trendline Breakout above $${downtrendLine.currentLinePrice.toFixed(4)} with ${rr.toFixed(2)} R:R`,
            plannedEntryPrice: price,
            plannedSlPrice: stopLoss,
            plannedTp1Price: tp1,
            plannedTp2Price: tp2,
            plannedRrRatio: rr,
          };
        }
      }
    }

    // ── Setup 3: Confirmed Higher Low (HL) Base Formation (Lower Half Only) ──
    if (config.enableHlBaseEntry && waveCycle?.lastHl) {
      const hl = waveCycle.lastHl;
      const isRecentHl = waveCycle.annotatedSwings?.slice(-4).some((s) => s.index === hl.index);
      // Only take HL base if in the lower half to avoid buying near the top
      if (isRecentHl && price >= hl.price && price <= retestZoneMax * 1.25) {
        const stopLoss = hl.price * (1 - slBuffer);
        const risk = price - stopLoss;
        const tp1 = plannedTp1 > price ? plannedTp1 : price * 1.025;
        const tp2 = majorCeil > price ? majorCeil : price * 1.05;
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
            reason: `Confirmed Higher Low (HL) base at $${hl.price.toFixed(4)} with ${rr.toFixed(2)} R:R`,
            plannedEntryPrice: price,
            plannedSlPrice: stopLoss,
            plannedTp1Price: tp1,
            plannedTp2Price: tp2,
            plannedRrRatio: rr,
          };
        }
      }
    }

    // ── Standby Mode: Waiting for Pullback to Major LL ────────────────────────
    return {
      hasSignal: false,
      entryPrice: 0,
      stopLossPrice: plannedSl,
      tp1Price: plannedTp1,
      tp2Price: plannedTp2,
      riskRewardRatio: plannedRr,
      reason: `Price ($${price.toFixed(4)}) is mid-air. Waiting for pullback to test Major LL ($${majorFloor.toFixed(4)} - $${retestZoneMax.toFixed(4)})`,
      plannedEntryPrice: plannedEntry,
      plannedSlPrice: plannedSl,
      plannedTp1Price: plannedTp1,
      plannedTp2Price: plannedTp2,
      plannedRrRatio: plannedRr,
    };
  }
}
