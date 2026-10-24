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
  signalType?: "HL_BASE" | "TL_BREAKOUT" | "SUPPORT_RETEST";
  entryPrice: number;
  stopLossPrice: number;
  tp1Price: number;
  tp2Price: number;
  riskRewardRatio: number;
  reason: string;
}

export class SwingSignalDetector {
  /**
   * Scans Dow Structure and Market Conditions for an asymmetric Risk:Reward Swing Setup.
   */
  public static evaluateSetup(
    price: number,
    structure: DowStructure | undefined,
    config: SwingStrategyConfig,
  ): SwingSignalResult {
    if (!structure || price <= 0) {
      return { hasSignal: false, entryPrice: 0, stopLossPrice: 0, tp1Price: 0, tp2Price: 0, riskRewardRatio: 0, reason: "No market structure" };
    }

    const {
      bottomBound,
      upperBound,
      centerPrice,
      activeValley,
      activePeak,
      downtrendLine,
      waveCycle,
      gridZone,
    } = structure;

    // Reject entry if market is in active falling knife or breaking lows
    if (gridZone?.gateStatus === "WAITING_FOR_BASE_CONFIRMATION" || gridZone?.gateStatus === "DOWNTREND_NO_CHANNEL") {
      return {
        hasSignal: false,
        entryPrice: 0,
        stopLossPrice: 0,
        tp1Price: 0,
        tp2Price: 0,
        riskRewardRatio: 0,
        reason: `Market gated (${gridZone.gateStatus}) — Waiting for confirmed base formation`,
      };
    }

    const slBuffer = Math.max(0.2, config.stopLossBufferPct) / 100;

    // ── Setup 1: Confirmed Higher Low (HL) Base Formation ───────────────────
    if (config.enableHlBaseEntry && waveCycle?.lastHl) {
      const hl = waveCycle.lastHl;
      const isRecentHl = waveCycle.annotatedSwings?.slice(-3).some((s) => s.index === hl.index);
      if (isRecentHl && price >= hl.price) {
        const stopLoss = hl.price * (1 - slBuffer);
        const risk = price - stopLoss;
        const tp1 = centerPrice > price ? centerPrice : price * 1.025;
        const tp2 = activePeak?.price && activePeak.price > price ? activePeak.price : (upperBound > price ? upperBound : price * 1.05);
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
            reason: `Confirmed Higher Low (HL) at $${hl.price.toFixed(4)} with ${rr.toFixed(2)} R:R`,
          };
        }
      }
    }

    // ── Setup 2: Descending Trendline Breakout ──────────────────────────────
    if (config.enableTrendlineBreakoutEntry && downtrendLine) {
      const isBreakout = downtrendLine.isBroken || price > downtrendLine.currentLinePrice;
      if (isBreakout && activeValley && price > activeValley.price) {
        const stopLoss = activeValley.price * (1 - slBuffer);
        const risk = price - stopLoss;
        const tp1 = centerPrice > price ? centerPrice : price * 1.025;
        const tp2 = activePeak?.price && activePeak.price > price ? activePeak.price : price * 1.05;
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
          };
        }
      }
    }

    // ── Setup 3: Structural Support Retest (Double Bottom) ──────────────────
    if (config.enableSupportRetestEntry && bottomBound > 0 && price > bottomBound) {
      const distFromFloorPct = ((price - bottomBound) / price) * 100;
      if (distFromFloorPct <= 2.5) {
        const stopLoss = bottomBound * (1 - slBuffer);
        const risk = price - stopLoss;
        const tp1 = centerPrice > price ? centerPrice : price * 1.03;
        const tp2 = upperBound > price ? upperBound : price * 1.06;
        const averageReward = (tp1 * config.tp1CloseRatio) + (tp2 * (1 - config.tp1CloseRatio)) - price;
        const rr = risk > 0 ? averageReward / risk : 0;

        if (rr >= config.minRiskReward) {
          return {
            hasSignal: true,
            signalType: "SUPPORT_RETEST",
            entryPrice: price,
            stopLossPrice: stopLoss,
            tp1Price: tp1,
            tp2Price: tp2,
            riskRewardRatio: rr,
            reason: `Support Retest at Floor $${bottomBound.toFixed(4)} (${distFromFloorPct.toFixed(1)}% proximity) with ${rr.toFixed(2)} R:R`,
          };
        }
      }
    }

    return {
      hasSignal: false,
      entryPrice: 0,
      stopLossPrice: 0,
      tp1Price: 0,
      tp2Price: 0,
      riskRewardRatio: 0,
      reason: "No qualified R:R setup found",
    };
  }
}
