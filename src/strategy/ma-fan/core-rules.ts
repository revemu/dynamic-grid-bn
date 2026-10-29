/**
 * MA Fan Sniper - Universal Core Decision Rules
 * Single Source of Truth for Live Trading, Backtest Studio, and Auto-Calibrator.
 * All mathematical calculations and trade decisions are unified here.
 */

import { Candle, RibbonState } from "./types.js";
import { ExhaustionState } from "./exhaustion.js";

export interface EntryDecision {
  shouldEnter: boolean;
  entryPrice: number;
  stopLossPrice: number;
  swingLow: number;
  fanSpreadPct: number;
  riskPct?: number;
  rewardPct?: number;
  rewardRisk?: number;
  blockedBy?: "REWARD_RISK";
  reason?: string;
}

export type ExitActionType = "NONE" | "TP1" | "TP2" | "SL";

export type CushionMode = "off" | "htfBull" | "always";

export interface ExitDecision {
  action: ExitActionType;
  exitPrice: number;
  newStopLossPrice?: number;
  cushionApplied?: boolean;
  reason?: string;
}

export class MaFanCoreRules {
  /**
   * 1. Compute Effective Spread Threshold
   * Unifies Auto-Calibrated spread and manual ATR adaptive scaling.
   */
  public static computeEffectiveSpread(opts: {
    baseSpread: number;
    useAtrAdaptiveSpread: boolean;
    isAutoCalibrated: boolean;
    curAtr: number;
    closePrice: number;
    atrMultiplier: number;
  }): number {
    if (!opts.useAtrAdaptiveSpread || opts.isAutoCalibrated) {
      return Math.max(0.20, opts.baseSpread);
    }
    const close = opts.closePrice > 0 ? opts.closePrice : 1;
    const atrPct = (opts.curAtr / close) * 100;
    // Ribbon spread is ~1/4 of single candle high-low range, capped at 0.85%
    const rawAdaptive = Math.max(opts.baseSpread, (atrPct * 0.25) * opts.atrMultiplier);
    return Math.min(0.85, Math.max(0.20, rawAdaptive));
  }

  /**
   * Helper: Compute Reward:Risk Ratio relative to TP1 (EMA 25)
   * riskPct = distance to SL (%)
   * rewardPct = distance to EMA 25 (%)
   * rr = rewardPct / riskPct (capped at 99 if risk <= 0)
   */
  public static computeRewardRisk(opts: {
    entryPrice: number;
    ema25: number;
    stopLossPrice: number;
  }): { riskPct: number; rewardPct: number; rr: number } {
    const { entryPrice, ema25, stopLossPrice } = opts;
    const riskPct = entryPrice > 0 ? ((entryPrice - stopLossPrice) / entryPrice) * 100 : 0;
    const rewardPct = entryPrice > 0 ? ((ema25 - entryPrice) / entryPrice) * 100 : 0;
    const rr = riskPct > 0 ? Math.min(99, rewardPct / riskPct) : 99;
    return {
      riskPct,
      rewardPct,
      rr,
    };
  }

  /**
   * 2. Evaluate Sniper Entry
   * Unifies all 5 entry qualification checks and initial stop loss calculation.
   */
  public static evaluateEntry(opts: {
    candles: Candle[];
    currentIndex?: number;
    closePrice: number;
    ribbon: RibbonState;
    exhaustion: ExhaustionState;
    requiredSpreadPct: number;
    curAtr: number;
    slBufferPct: number;
    minRewardRiskRatio?: number;
  }): EntryDecision {
    const { candles, closePrice, ribbon, exhaustion, requiredSpreadPct, curAtr, slBufferPct, minRewardRiskRatio } = opts;
    const currentIndex = opts.currentIndex ?? (candles.length - 1);

    const isStretched = ribbon.fanSpreadPct >= requiredSpreadPct;
    // Require adequate upside room from closePrice to EMA25 (at least 0.20%) to avoid entering when price is already touching EMA25
    const hasUpsideRoomToEma25 = closePrice <= ribbon.ema25 * (1 - 0.0020);
    const isDownside = ribbon.ema4 <= ribbon.ema25 && closePrice < ribbon.ema25 && hasUpsideRoomToEma25;

    // Minimum lower wick absorption check (at least 15% lower shadow rejection to filter out waterfall dumps)
    const curCandle = candles[currentIndex];
    const range = curCandle ? curCandle.high - curCandle.low : 0;
    const lowerWick = curCandle ? Math.min(curCandle.open, curCandle.close) - curCandle.low : 0;
    const lowerWickPct = range > 0 ? (lowerWick / range) * 100 : 0;
    const hasLowerWickAbsorption = lowerWickPct >= 15;

    const qualified =
      ribbon.isFanningDown &&
      isStretched &&
      ribbon.isHookUp &&
      exhaustion.isOversoldExhaustion &&
      isDownside &&
      hasLowerWickAbsorption;

    if (!qualified) {
      return {
        shouldEnter: false,
        entryPrice: 0,
        stopLossPrice: 0,
        swingLow: 0,
        fanSpreadPct: ribbon.fanSpreadPct,
      };
    }

    // Dynamic SL: Look back 11 bars (idx - 10 to idx) for lowest point
    const recentLows = candles.slice(Math.max(0, currentIndex - 10), currentIndex + 1).map((x) => x.low);
    const swingLow = Math.min(...recentLows);
    const slDist = Math.max(swingLow * (slBufferPct / 100), curAtr * 1.0);
    const stopLossPrice = swingLow - slDist;

    const rrCalc = MaFanCoreRules.computeRewardRisk({
      entryPrice: closePrice,
      ema25: ribbon.ema25,
      stopLossPrice,
    });

    if (minRewardRiskRatio !== undefined && minRewardRiskRatio > 0 && rrCalc.rr < minRewardRiskRatio) {
      return {
        shouldEnter: false,
        entryPrice: closePrice,
        stopLossPrice,
        swingLow,
        fanSpreadPct: ribbon.fanSpreadPct,
        riskPct: rrCalc.riskPct,
        rewardPct: rrCalc.rewardPct,
        rewardRisk: rrCalc.rr,
        blockedBy: "REWARD_RISK",
        reason: `Filtered by RR (${rrCalc.rr.toFixed(2)} < ${minRewardRiskRatio.toFixed(2)})`,
      };
    }

    return {
      shouldEnter: true,
      entryPrice: closePrice,
      stopLossPrice,
      swingLow,
      fanSpreadPct: ribbon.fanSpreadPct,
      riskPct: rrCalc.riskPct,
      rewardPct: rrCalc.rewardPct,
      rewardRisk: rrCalc.rr,
      reason: `Spread ${ribbon.fanSpreadPct.toFixed(2)}% >= ${requiredSpreadPct.toFixed(2)}%, Hook, Oversold, Wick ${lowerWickPct.toFixed(1)}%`,
    };
  }

  /**
   * 3. Evaluate Dynamic Ratchet SL
   * Lifts Stop Loss when price forms a higher local base after holding for >= 3 bars.
   */
  public static evaluateRatchetSl(opts: {
    candles: Candle[];
    currentIndex?: number;
    barsHeld: number;
    currentSlPrice: number;
    currentPrice: number;
    curAtr: number;
    slBufferPct: number;
    useRatchetSl?: boolean;
  }): number | null {
    const { candles, barsHeld, currentSlPrice, currentPrice, curAtr, slBufferPct } = opts;
    const useRatchetSl = opts.useRatchetSl !== false;
    if (!useRatchetSl || barsHeld < 3 || candles.length === 0) return null;

    const currentIndex = opts.currentIndex ?? (candles.length - 1);
    // Look back 5 bars (idx - 4 to idx) for local base
    const recentLows = candles.slice(Math.max(0, currentIndex - 4), currentIndex + 1).map((x) => x.low);
    const localMin = Math.min(...recentLows);
    const localSlDist = Math.max(localMin * (slBufferPct / 100), curAtr * 1.0);
    const localLow = localMin - localSlDist;

    if (localLow > currentSlPrice && localLow < currentPrice) {
      return localLow;
    }
    return null;
  }

  /**
   * 4. Evaluate Position Exits (Priority: TP2 -> SL -> TP1)
   * Unifies TP1, Trapped Breakeven Rescue, SL, and TP2 Trailing.
   */
  public static evaluateExits(opts: {
    highPrice: number;
    lowPrice: number;
    closePrice: number;
    entryPrice: number;
    stopLossPrice: number;
    tp1Filled: boolean;
    highestPriceSinceTp1: number;
    ribbon: RibbonState;
    trailingPullbackPct: number;
    breakevenFeeBufferPct?: number;
    isOverbought?: boolean;
    barsHeld?: number;
    isHtfBull?: boolean;
    cushionMode?: CushionMode;
    cushionThresholdPct?: number;
    tp1MinProfitPct?: number;
  }): ExitDecision {
    const {
      highPrice,
      lowPrice,
      closePrice,
      entryPrice,
      stopLossPrice,
      tp1Filled,
      highestPriceSinceTp1,
      ribbon,
      trailingPullbackPct,
      breakevenFeeBufferPct,
      isOverbought,
      barsHeld,
    } = opts;

    const beFeeBuffer = (breakevenFeeBufferPct ?? 0.05) / 100;

    // ── Priority 1: TP2 Check (if TP1 was already filled) ───────────────────
    if (tp1Filled) {
      const target = Math.max(ribbon.ema75, ribbon.ema200);
      const hitTarget = highPrice >= target && highPrice > entryPrice * 1.0035;
      const trailingExitRatio = 1 - trailingPullbackPct / 100;
      const hitTrailing = highestPriceSinceTp1 > entryPrice * 1.005 && lowPrice <= highestPriceSinceTp1 * trailingExitRatio;
      const hitOverbought = !!isOverbought && highPrice > entryPrice * 1.008;

      if (hitTarget || hitTrailing || hitOverbought) {
        const exitPrice = hitTarget
          ? Math.min(highPrice, Math.max(target, closePrice))
          : hitTrailing
          ? highestPriceSinceTp1 * trailingExitRatio
          : closePrice;
        return {
          action: "TP2",
          exitPrice,
          reason: hitTrailing
            ? `Trailing Pullback (${trailingPullbackPct}%) from peak $${highestPriceSinceTp1.toFixed(4)}`
            : hitTarget
            ? `EMA Macro Target ($${target.toFixed(4)})`
            : "Overbought Exhaustion Exit",
        };
      }
    }

    // ── Priority 2: Stop Loss Check ─────────────────────────────────────────
    if (lowPrice <= stopLossPrice) {
      return {
        action: "SL",
        exitPrice: stopLossPrice,
        reason: "Stop Loss Triggered",
      };
    }

    // ── Priority 3: TP1 at EMA 25 & Trapped Breakeven Rescue ────────────────
    if (!tp1Filled) {
      // Trapped Position Rescue only activates if held for >= 3 bars and EMA25 drifted below entry
      const isTrapped = (barsHeld !== undefined && barsHeld >= 3) && (ribbon.ema25 <= entryPrice * 1.0015);
      const minProfitFrac = Math.max((opts.tp1MinProfitPct ?? 0.20) / 100, beFeeBuffer);
      const minProfitPrice = isTrapped
        ? entryPrice * (1 + beFeeBuffer)
        : entryPrice * (1 + minProfitFrac);
      const tp1Target = Math.max(ribbon.ema25, minProfitPrice);

      if (highPrice >= tp1Target) {
        // Trend-Aware Breathing Cushion for Breakeven SL:
        // If Cushion is active (mode === "always" or mode === "htfBull" with HTF Bull) and TP1 profit is tight (< threshold),
        // allow the TP2 Runner to breathe using the Dynamic Ratchet SL / swing low base instead of choking it with immediate Breakeven SL!
        // If mode === "off" (or profit is already >= threshold), strictly raise SL to Breakeven immediately.
        const tp1ProfitPct = ((tp1Target - entryPrice) / entryPrice) * 100;
        const mode = opts.cushionMode ?? "off";
        const threshold = opts.cushionThresholdPct ?? 0.35;
        const cushionApplied =
          (mode === "always" || (mode === "htfBull" && !!opts.isHtfBull)) && tp1ProfitPct < threshold;
        const newStopLossPrice = cushionApplied
          ? stopLossPrice
          : Math.max(stopLossPrice, entryPrice * (1 + beFeeBuffer));

        return {
          action: "TP1",
          exitPrice: tp1Target,
          newStopLossPrice,
          cushionApplied,
          reason: isTrapped
            ? "Trapped Position Breakeven Rescue"
            : cushionApplied
            ? "TP1 Mean Reversion (HTF Bull Cushion Active)"
            : "TP1 Mean Reversion at EMA 25",
        };
      }
    }

    return {
      action: "NONE",
      exitPrice: 0,
    };
  }
}
