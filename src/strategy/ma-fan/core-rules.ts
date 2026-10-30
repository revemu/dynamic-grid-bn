/**
 * MA Fan Sniper - Universal Core Decision Rules
 * Single Source of Truth for Live Trading, Backtest Studio, and Auto-Calibrator.
 * All mathematical calculations and trade decisions are unified here.
 */

import { Candle, RibbonState, HtfRegime } from "./types.js";
import { ExhaustionState } from "./exhaustion.js";

export type WaterfallGuardMode = "off" | "consecutiveReds" | "bearCrash" | "volCapitulation" | "combined";

export interface WaterfallMetrics {
  consecutiveReds: number;
  dropPct12: number;
  volRatio: number;
  isHtfBull: boolean;
}

export interface EntryChecklistItem {
  id: "spread" | "order" | "hook" | "oversold" | "noFallingKnife" | "upside" | "wick" | "waterfall" | "rr" | "macroGate" | "circuitBreaker";
  name: string;
  passed: boolean;
  actualText: string;
  requiredText: string;
}

export interface EntryChecklist {
  passedCount: number;
  totalCount: number;
  allPassed: boolean;
  items: EntryChecklistItem[];
  passedLabels: string[];
  waitingLabels: string[];
}

export interface EntryDecision {
  shouldEnter: boolean;
  side?: "BUY" | "SELL";
  positionSide?: "LONG" | "SHORT";
  entryPrice: number;
  stopLossPrice: number;
  swingLow?: number;
  swingHigh?: number;
  fanSpreadPct: number;
  riskPct?: number;
  rewardPct?: number;
  rewardRisk?: number;
  blockedBy?: "REWARD_RISK" | "WATERFALL_GUARD" | "MACRO_GATE" | "CIRCUIT_BREAKER" | "UPSIDE_FLOOR";
  waterfallMetrics?: WaterfallMetrics;
  checklist?: EntryChecklist;
  reason?: string;
  engineType?: "DIP_HUNTER" | "PEAK_HUNTER" | "TREND_RIDER_LONG" | "TREND_RIDER_SHORT";
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
    positionSide?: "LONG" | "SHORT";
  }): { riskPct: number; rewardPct: number; rr: number } {
    const { entryPrice, ema25, stopLossPrice, positionSide = "LONG" } = opts;
    let riskPct = 0;
    let rewardPct = 0;
    if (positionSide === "LONG") {
      riskPct = entryPrice > 0 ? ((entryPrice - stopLossPrice) / entryPrice) * 100 : 0;
      rewardPct = entryPrice > 0 ? ((ema25 - entryPrice) / entryPrice) * 100 : 0;
    } else {
      riskPct = entryPrice > 0 ? ((stopLossPrice - entryPrice) / entryPrice) * 100 : 0;
      rewardPct = entryPrice > 0 ? ((entryPrice - ema25) / entryPrice) * 100 : 0;
    }
    const rr = riskPct > 0 ? Math.min(99, rewardPct / riskPct) : 99;
    return {
      riskPct,
      rewardPct,
      rr,
    };
  }

  /**
   * Helper: Compute Waterfall Crash Metrics
   * - consecutiveReds: consecutive red candles (close < open) immediately preceding current bar
   * - dropPct12: price drop from 12-bar highest high to current close (%)
   * - volRatio: current candle volume vs 20-bar average preceding volume
   */
  public static computeWaterfallMetrics(opts: {
    candles: Candle[];
    currentIndex?: number;
    closePrice: number;
    isHtfBull?: boolean;
  }): WaterfallMetrics {
    const { candles, closePrice, isHtfBull = false } = opts;
    const currentIndex = opts.currentIndex ?? (candles.length - 1);

    // 1. Consecutive red dump candles immediately preceding this bar
    let consecutiveReds = 0;
    for (let b = currentIndex - 1; b >= Math.max(0, currentIndex - 15); b--) {
      const bar = candles[b];
      if (bar && bar.close < bar.open) {
        consecutiveReds++;
      } else {
        break;
      }
    }

    // 2. Drop depth across last 12 bars (from peak high to closePrice)
    const drop12Slice = candles.slice(Math.max(0, currentIndex - 11), currentIndex + 1).map((x) => x.high);
    const maxHigh12 = drop12Slice.length > 0 ? Math.max(...drop12Slice) : closePrice;
    const dropPct12 = maxHigh12 > 0 ? ((maxHigh12 - closePrice) / maxHigh12) * 100 : 0;

    // 3. Volume ratio: curCandle volume / 20-bar average preceding volume
    const curCandle = candles[currentIndex];
    const volSlice = candles.slice(Math.max(0, currentIndex - 20), currentIndex).map((x) => x.volume);
    const avgVol = volSlice.length > 0 ? volSlice.reduce((a, b) => a + b, 0) / volSlice.length : (curCandle?.volume ?? 1);
    const volRatio = avgVol > 0 && curCandle ? curCandle.volume / avgVol : 1.0;

    return {
      consecutiveReds,
      dropPct12: Number(dropPct12.toFixed(4)),
      volRatio: Number(volRatio.toFixed(2)),
      isHtfBull,
    };
  }

  /**
   * 2. Evaluate Sniper Entry
   * Unifies all entry qualification checks and initial stop loss calculation.
   * Supports both LONG (Dip Hunter) and SHORT (Peak Hunter).
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
    side?: "LONG" | "SHORT";
    minRewardRiskRatio?: number;
    waterfallGuardMode?: WaterfallGuardMode;
    isHtfBull?: boolean;
    macroGateMode?: "off" | "noDeepBear" | "bullOnly";
    htfRegime?: HtfRegime;
    enableUpsideFloor?: boolean;
    enableNoFallingKnife?: boolean;
    circuitBreakerActive?: boolean;
    maxSlPct?: number;
  }): EntryDecision {
    const {
      candles,
      closePrice,
      ribbon,
      exhaustion,
      requiredSpreadPct,
      curAtr,
      slBufferPct,
      side = "LONG",
      minRewardRiskRatio,
      waterfallGuardMode,
      isHtfBull,
    } = opts;
    const currentIndex = opts.currentIndex ?? (candles.length - 1);
    const curCandle = candles[currentIndex];
    const prevCandle = currentIndex > 0 ? candles[currentIndex - 1] : undefined;
    const range = curCandle ? curCandle.high - curCandle.low : 0;
    const isStretched = ribbon.fanSpreadPct >= requiredSpreadPct;
    const enableUpsideFloor = opts.enableUpsideFloor !== false;
    const enableNoFallingKnife = opts.enableNoFallingKnife !== false;
    const maxSlPct = opts.maxSlPct ?? 1.80;
    const macroMode = opts.macroGateMode ?? "off";
    const isCircuitBlocked = !!opts.circuitBreakerActive;
    const circuitBlockReason = isCircuitBlocked ? "⏸️ Risk Circuit Breaker Active (SL 2 ไม้ติด)" : "";

    // ─── SHORT PEAK HUNTER & BEARISH RETEST LOGIC ───────────────────────
    if (side === "SHORT") {
      const downsideRequiredPct = enableUpsideFloor ? 0.50 : 0.30;
      const downsidePct = closePrice > 0 ? ((closePrice - ribbon.ema25) / closePrice) * 100 : 0;
      const hasDownsideRoomToEma25 = closePrice >= ribbon.ema25 * (1 + (downsideRequiredPct / 100));
      const passesSpreadFloor = !enableUpsideFloor || ribbon.fanSpreadPct >= 0.35;
      const isUpside = ribbon.ema4 >= ribbon.ema25 && closePrice > ribbon.ema25 && hasDownsideRoomToEma25 && passesSpreadFloor;

      // Upper wick rejection (rejection of high, sellers pressing down)
      const upperWick = curCandle ? curCandle.high - Math.max(curCandle.open, curCandle.close) : 0;
      const upperWickPct = range > 0 ? (upperWick / range) * 100 : 0;
      const hasUpperWickAbsorption = upperWickPct >= 15;

      // No Rising Knife: When price is above EMA75/200, current High must be <= previous High
      const isAboveMajorEma = (ribbon.ema75 > 0 && closePrice > ribbon.ema75) || (ribbon.ema200 > 0 && closePrice > ribbon.ema200);
      const passesNoRisingKnife = !enableNoFallingKnife || !isAboveMajorEma || !prevCandle || (curCandle !== undefined && curCandle.high <= prevCandle.high);

      // 1. Peak Hunter Qualification (Counter-Trend Spike on Pumps)
      const isPeakHunterQualified =
        ribbon.isFanningUp &&
        isStretched &&
        ribbon.isHookDown &&
        exhaustion.isOverboughtExhaustion &&
        isUpside &&
        hasUpperWickAbsorption &&
        passesNoRisingKnife;

      // 2. Bearish Retest Short Qualification (Downtrend dynamic resistance rejection)
      // Strictly require Macro Downtrend alignment (prevent shorting into HTF bull runs)
      const isDowntrend =
        (opts.htfRegime?.isDeepBear ?? false) ||
        (!isHtfBull && closePrice < ribbon.ema75 && (ribbon.ema75 < ribbon.ema200 || ribbon.ema200 === 0));
      const last3Highs = candles.slice(Math.max(0, currentIndex - 2), currentIndex + 1).map((c) => c.high);
      const maxHigh3 = Math.max(...last3Highs);
      const touchedDynamicResistance = maxHigh3 >= ribbon.ema16 * 0.998 || maxHigh3 >= ribbon.ema25 * 0.996;
      const isRedCandle = curCandle ? curCandle.close < curCandle.open : false;
      const closesBelowEma4 = curCandle ? closePrice < ribbon.ema4 : false;
      const healthyRetestRsi = exhaustion.rsi >= 35 && exhaustion.rsi <= 60;
      const isBearishRetestQualified =
        isDowntrend &&
        touchedDynamicResistance &&
        isRedCandle &&
        closesBelowEma4 &&
        hasUpperWickAbsorption &&
        healthyRetestRsi &&
        ribbon.fanSpreadPct >= 0.35;

      const qualified = isPeakHunterQualified || isBearishRetestQualified;
      const engineType = isBearishRetestQualified ? "TREND_RIDER_SHORT" : "PEAK_HUNTER";

      // Dynamic SL for SHORT: Look back 6-8 bars for swing high
      const lookbackSl = isBearishRetestQualified ? 6 : 10;
      const recentHighs = candles.slice(Math.max(0, currentIndex - lookbackSl), currentIndex + 1).map((x) => x.high);
      const swingHigh = recentHighs.length > 0 ? Math.max(...recentHighs) : closePrice;
      const slDist = Math.max(swingHigh * (slBufferPct / 100), curAtr * 0.85);
      const rawStopLossPrice = swingHigh + slDist;
      const stopLossCeiling = closePrice * (1 + maxSlPct / 100);
      const stopLossPrice = Math.min(rawStopLossPrice, stopLossCeiling);

      // Target Price for R:R computation
      const targetPrice = isBearishRetestQualified
        ? Math.min(ribbon.ema75, closePrice * 0.990)
        : ribbon.ema25;

      const rrCalc = MaFanCoreRules.computeRewardRisk({
        entryPrice: closePrice,
        ema25: targetPrice,
        stopLossPrice,
        positionSide: "SHORT",
      });

      // Macro Gate for Short: In bullOnly mode or when HTF is Bullish (unless Bearish Retest in local downtrend)
      let isMacroBlocked = false;
      let macroBlockReason = "";
      if (macroMode === "bullOnly" || (macroMode !== "off" && isHtfBull && !isBearishRetestQualified)) {
        isMacroBlocked = true;
        macroBlockReason = "ตลาด HTF เป็นกระทิง (ห้าม Short สวนแนวโน้มใหญ่)";
      }

      if (!qualified) {
        return {
          shouldEnter: false,
          side: "SELL",
          positionSide: "SHORT",
          engineType,
          entryPrice: 0,
          stopLossPrice: 0,
          swingHigh,
          fanSpreadPct: ribbon.fanSpreadPct,
          reason: "รอเงื่อนไข Short (Peak Hunter หรือ Bearish Retest)",
        };
      }

      if (minRewardRiskRatio !== undefined && minRewardRiskRatio > 0 && rrCalc.rr < minRewardRiskRatio) {
        return {
          shouldEnter: false,
          side: "SELL",
          positionSide: "SHORT",
          engineType,
          entryPrice: closePrice,
          stopLossPrice,
          swingHigh,
          fanSpreadPct: ribbon.fanSpreadPct,
          riskPct: rrCalc.riskPct,
          rewardPct: rrCalc.rewardPct,
          rewardRisk: rrCalc.rr,
          blockedBy: "REWARD_RISK",
          reason: `Filtered by RR (${rrCalc.rr.toFixed(2)} < ${minRewardRiskRatio.toFixed(2)})`,
        };
      }

      if (isMacroBlocked) {
        return {
          shouldEnter: false,
          side: "SELL",
          positionSide: "SHORT",
          engineType,
          entryPrice: closePrice,
          stopLossPrice,
          swingHigh,
          fanSpreadPct: ribbon.fanSpreadPct,
          riskPct: rrCalc.riskPct,
          rewardPct: rrCalc.rewardPct,
          rewardRisk: rrCalc.rr,
          blockedBy: "MACRO_GATE",
          reason: `Filtered by Macro Gate: ${macroBlockReason}`,
        };
      }

      if (isCircuitBlocked) {
        return {
          shouldEnter: false,
          side: "SELL",
          positionSide: "SHORT",
          engineType,
          entryPrice: closePrice,
          stopLossPrice,
          swingHigh,
          fanSpreadPct: ribbon.fanSpreadPct,
          riskPct: rrCalc.riskPct,
          rewardPct: rrCalc.rewardPct,
          rewardRisk: rrCalc.rr,
          blockedBy: "CIRCUIT_BREAKER",
          reason: `Filtered by Circuit Breaker: ${circuitBlockReason}`,
        };
      }

      return {
        shouldEnter: true,
        side: "SELL",
        positionSide: "SHORT",
        engineType,
        entryPrice: closePrice,
        stopLossPrice,
        swingHigh,
        fanSpreadPct: ribbon.fanSpreadPct,
        riskPct: rrCalc.riskPct,
        rewardPct: rrCalc.rewardPct,
        rewardRisk: rrCalc.rr,
        reason: isBearishRetestQualified
          ? `Bearish Retest Short: Retest EMA16/25 rejected, Red Candle, Upper Wick ${upperWickPct.toFixed(1)}%, RSI ${exhaustion.rsi.toFixed(1)}`
          : `Peak Hunter Short: Spread ${ribbon.fanSpreadPct.toFixed(2)}% >= ${requiredSpreadPct.toFixed(2)}%, Overbought RSI, Upper Wick ${upperWickPct.toFixed(1)}%`,
      };
    }

    // ─── LONG DIP HUNTER LOGIC (DEFAULT) ─────────────────────────────────
    const upsideRequiredPct = enableUpsideFloor ? 0.50 : 0.30;
    const upsidePct = closePrice > 0 ? ((ribbon.ema25 - closePrice) / ribbon.ema25) * 100 : 0;
    const hasUpsideRoomToEma25 = closePrice <= ribbon.ema25 * (1 - (upsideRequiredPct / 100));
    const passesSpreadFloor = !enableUpsideFloor || ribbon.fanSpreadPct >= 0.35;
    const isDownside = ribbon.ema4 <= ribbon.ema25 && closePrice < ribbon.ema25 && hasUpsideRoomToEma25 && passesSpreadFloor;

    // Minimum lower wick absorption check (at least 15% lower shadow rejection)
    const lowerWick = curCandle ? Math.min(curCandle.open, curCandle.close) - curCandle.low : 0;
    const lowerWickPct = range > 0 ? (lowerWick / range) * 100 : 0;
    const hasLowerWickAbsorption = lowerWickPct >= 15;

    // No Falling Knife Check: When price is below EMA75/200, current Low >= previous Low
    const isBelowMajorEma = (ribbon.ema75 > 0 && closePrice < ribbon.ema75) || (ribbon.ema200 > 0 && closePrice < ribbon.ema200);
    const passesNoFallingKnife = !enableNoFallingKnife || !isBelowMajorEma || !prevCandle || (curCandle !== undefined && curCandle.low >= prevCandle.low);

    // Dynamic SL: Look back 11 bars (idx - 10 to idx) for lowest point
    const recentLows = candles.slice(Math.max(0, currentIndex - 10), currentIndex + 1).map((x) => x.low);
    const swingLow = recentLows.length > 0 ? Math.min(...recentLows) : closePrice;
    const slDist = Math.max(swingLow * (slBufferPct / 100), curAtr * 1.0);
    const rawStopLossPrice = swingLow - slDist;
    const stopLossFloor = closePrice * (1 - maxSlPct / 100);
    const stopLossPrice = Math.max(rawStopLossPrice, stopLossFloor);

    const rrCalc = MaFanCoreRules.computeRewardRisk({
      entryPrice: closePrice,
      ema25: ribbon.ema25,
      stopLossPrice,
      positionSide: "LONG",
    });

    // Waterfall Guard Filter
    const waterfallMetrics = MaFanCoreRules.computeWaterfallMetrics({
      candles,
      currentIndex,
      closePrice,
      isHtfBull,
    });

    let isBlocked = false;
    let blockReason = "";

    if (waterfallGuardMode && waterfallGuardMode !== "off") {
      switch (waterfallGuardMode) {
        case "consecutiveReds":
          if (waterfallMetrics.consecutiveReds >= 4) {
            isBlocked = true;
            blockReason = `Consecutive Red Bars (${waterfallMetrics.consecutiveReds} >= 4)`;
          }
          break;
        case "bearCrash":
          if (!waterfallMetrics.isHtfBull && waterfallMetrics.dropPct12 >= 2.5) {
            isBlocked = true;
            blockReason = `Bear Crash Drop (${waterfallMetrics.dropPct12.toFixed(2)}% >= 2.5% in HTF BEAR)`;
          }
          break;
        case "volCapitulation":
          if (waterfallMetrics.volRatio >= 2.5) {
            isBlocked = true;
            blockReason = `Volume Capitulation Spike (${waterfallMetrics.volRatio.toFixed(1)}x >= 2.5x)`;
          }
          break;
        case "combined":
          if (
            (!waterfallMetrics.isHtfBull && waterfallMetrics.dropPct12 >= 2.0) ||
            waterfallMetrics.volRatio >= 2.5 ||
            waterfallMetrics.consecutiveReds >= 4
          ) {
            isBlocked = true;
            blockReason = `Waterfall Crash ((Drop ${waterfallMetrics.dropPct12.toFixed(2)}% in ${waterfallMetrics.isHtfBull ? "BULL" : "BEAR"}) | Vol ${waterfallMetrics.volRatio.toFixed(1)}x | Reds ${waterfallMetrics.consecutiveReds})`;
          }
          break;
      }
    }

    // Macro Gate Check
    let isMacroBlocked = false;
    let macroBlockReason = "";
    if (macroMode === "bullOnly" && !isHtfBull) {
      isMacroBlocked = true;
      macroBlockReason = "ตลาด HTF ไม่ใช่กระทิง (Bull Only Mode)";
    } else if (macroMode === "noDeepBear" && opts.htfRegime?.isDeepBear) {
      isMacroBlocked = true;
      const d = opts.htfRegime.distToEma200Pct ?? 0;
      macroBlockReason = `ขาลงลึกใต้ EMA200 1H (${d.toFixed(1)}% หรือเส้นชันลง)`;
    }

    // Circuit Breaker Check

    const items: EntryChecklistItem[] = [
      {
        id: "spread",
        name: "พัดกางตึง (Spread)",
        passed: isStretched,
        actualText: `${ribbon.fanSpreadPct.toFixed(2)}%`,
        requiredText: `≥ ${requiredSpreadPct.toFixed(2)}%`,
      },
      {
        id: "order",
        name: "พัดเรียงขาลง (Ribbon Down)",
        passed: ribbon.isFanningDown,
        actualText: ribbon.isFanningDown ? "เรียง 4≤8≤16≤25" : (ribbon.isFanningUp ? "เรียงทิศขึ้น" : "ยังไม่เรียง"),
        requiredText: "EMA 4 ≤ 8 ≤ 16 ≤ 25",
      },
      {
        id: "hook",
        name: "ปลายม้วนขึ้น (Hook Up)",
        passed: ribbon.isHookUp,
        actualText: ribbon.isHookUp ? "ม้วนขึ้นแล้ว" : "ยังไม่งัดขึ้น",
        requiredText: "EMA4 เลี้ยวขึ้น / ปิดเหนือ EMA4",
      },
      {
        id: "oversold",
        name: "แรงขายหมด (Oversold)",
        passed: exhaustion.isOversoldExhaustion,
        actualText: `RSI ${typeof exhaustion.rsi === "number" ? exhaustion.rsi.toFixed(1) : "--"}${exhaustion.rsiSma ? ` (SMA ${exhaustion.rsiSma.toFixed(1)})` : ""}${exhaustion.isOversoldExhaustion ? " (ตัดขึ้น/หมดแรง ✅)" : ""}`,
        requiredText: "RSI 28-45 & เหนือ RSI-SMA/MACD งัด",
      },
      {
        id: "noFallingKnife",
        name: "ไม่รับมีดหล่น (No Falling Knife)",
        passed: passesNoFallingKnife,
        actualText: isBelowMajorEma
          ? (passesNoFallingKnife ? "ยกฐาน (Low ≥ แท่งก่อน)" : "ทำ New Low ต่ำกว่าแท่งก่อน")
          : "อยู่เหนือเส้น EMA 75/200",
        requiredText: isBelowMajorEma ? "ใต้เส้นใหญ่: Low ≥ แท่งก่อน" : "ผ่านอัตโนมัติ",
      },
      {
        id: "upside",
        name: "ระยะวิ่งถึง EMA25 (Upside Room)",
        passed: isDownside,
        actualText: closePrice < ribbon.ema25
          ? `ต่ำกว่า EMA25 ${upsidePct.toFixed(2)}%${enableUpsideFloor && upsidePct < 0.45 ? " (แคบไป)" : ""}`
          : "อยู่เหนือ EMA25",
        requiredText: enableUpsideFloor ? "ต่ำกว่า EMA25 ≥ 0.45%" : "ต่ำกว่า EMA25 ≥ 0.30%",
      },
      {
        id: "wick",
        name: "ไส้ล่างซึมซับ (Lower Wick)",
        passed: hasLowerWickAbsorption,
        actualText: `${lowerWickPct.toFixed(1)}%`,
        requiredText: "≥ 15.0%",
      },
      {
        id: "waterfall",
        name: "Waterfall Guard",
        passed: !isBlocked,
        actualText: isBlocked ? blockReason : "ปลอดภัย (ไม่ติด Dump)",
        requiredText: "ไม่ติด Crash / แดง < 4 แท่ง",
      },
    ];

    if (macroMode !== "off") {
      items.push({
        id: "macroGate",
        name: "Macro Trend Gate",
        passed: !isMacroBlocked,
        actualText: isMacroBlocked ? macroBlockReason : (isHtfBull ? "ตลาดกระทิง / ปลอดภัย" : "ไม่ติด Deep Bear"),
        requiredText: macroMode === "bullOnly" ? "HTF Bull Only" : "ไม่หลุดลึกใต้ 1H EMA200",
      });
    }

    if (opts.circuitBreakerActive !== undefined) {
      items.push({
        id: "circuitBreaker",
        name: "Risk Circuit Breaker",
        passed: !isCircuitBlocked,
        actualText: isCircuitBlocked ? circuitBlockReason : "ปกติ (ไม่ติด Cooldown)",
        requiredText: "ไม่มี SL ติดกัน 2 ไม้ใน 12 ชม.",
      });
    }

    if (minRewardRiskRatio !== undefined && minRewardRiskRatio > 0) {
      items.push({
        id: "rr",
        name: "Reward:Risk Gate",
        passed: rrCalc.rr >= minRewardRiskRatio,
        actualText: `R:R ${rrCalc.rr.toFixed(2)}`,
        requiredText: `≥ ${minRewardRiskRatio.toFixed(2)}`,
      });
    }

    const passedCount = items.filter((it) => it.passed).length;
    const totalCount = items.length;
    const allPassed = passedCount === totalCount;
    const passedLabels = items.filter((it) => it.passed).map((it) => it.name);
    const waitingLabels = items.filter((it) => !it.passed).map((it) => it.name);

    const checklist: EntryChecklist = {
      passedCount,
      totalCount,
      allPassed,
      items,
      passedLabels,
      waitingLabels,
    };

    const qualified =
      ribbon.isFanningDown &&
      isStretched &&
      ribbon.isHookUp &&
      exhaustion.isOversoldExhaustion &&
      isDownside &&
      hasLowerWickAbsorption &&
      passesNoFallingKnife;

    if (!qualified) {
      return {
        shouldEnter: false,
        entryPrice: 0,
        stopLossPrice: 0,
        swingLow: 0,
        fanSpreadPct: ribbon.fanSpreadPct,
        checklist,
        reason: `รอเงื่อนไข: ${waitingLabels.join(", ")}`,
      };
    }

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
        checklist,
        reason: `Filtered by RR (${rrCalc.rr.toFixed(2)} < ${minRewardRiskRatio.toFixed(2)})`,
      };
    }

    if (isBlocked) {
      return {
        shouldEnter: false,
        entryPrice: closePrice,
        stopLossPrice,
        swingLow,
        fanSpreadPct: ribbon.fanSpreadPct,
        riskPct: rrCalc.riskPct,
        rewardPct: rrCalc.rewardPct,
        rewardRisk: rrCalc.rr,
        blockedBy: "WATERFALL_GUARD",
        waterfallMetrics,
        checklist,
        reason: `Filtered by Waterfall Guard [${waterfallGuardMode}]: ${blockReason}`,
      };
    }

    if (isMacroBlocked) {
      return {
        shouldEnter: false,
        entryPrice: closePrice,
        stopLossPrice,
        swingLow,
        fanSpreadPct: ribbon.fanSpreadPct,
        riskPct: rrCalc.riskPct,
        rewardPct: rrCalc.rewardPct,
        rewardRisk: rrCalc.rr,
        blockedBy: "MACRO_GATE",
        waterfallMetrics,
        checklist,
        reason: `Filtered by Macro Gate [${macroMode}]: ${macroBlockReason}`,
      };
    }

    if (isCircuitBlocked) {
      return {
        shouldEnter: false,
        entryPrice: closePrice,
        stopLossPrice,
        swingLow,
        fanSpreadPct: ribbon.fanSpreadPct,
        riskPct: rrCalc.riskPct,
        rewardPct: rrCalc.rewardPct,
        rewardRisk: rrCalc.rr,
        blockedBy: "CIRCUIT_BREAKER",
        waterfallMetrics,
        checklist,
        reason: `Filtered by Risk Circuit Breaker: ${circuitBlockReason}`,
      };
    }

    return {
      shouldEnter: true,
      side: "BUY",
      positionSide: "LONG",
      engineType: "DIP_HUNTER",
      entryPrice: closePrice,
      stopLossPrice,
      swingLow,
      fanSpreadPct: ribbon.fanSpreadPct,
      riskPct: rrCalc.riskPct,
      rewardPct: rrCalc.rewardPct,
      rewardRisk: rrCalc.rr,
      waterfallMetrics,
      checklist,
      reason: `Spread ${ribbon.fanSpreadPct.toFixed(2)}% >= ${requiredSpreadPct.toFixed(2)}%, Hook, Oversold, Wick ${lowerWickPct.toFixed(1)}%`,
    };
  }

  /**
   * 2.1 Evaluate Trend Rider Entry
   * Rides established trends on healthy dynamic pullbacks/retests to EMA 16/25.
   */
  public static evaluateTrendRiderEntry(opts: {
    candles: Candle[];
    currentIndex?: number;
    closePrice: number;
    ribbon: RibbonState;
    exhaustion: ExhaustionState;
    curAtr: number;
    slBufferPct: number;
    side?: "LONG" | "SHORT";
    isHtfBull?: boolean;
    macroGateMode?: "off" | "noDeepBear" | "bullOnly";
    htfRegime?: HtfRegime;
    circuitBreakerActive?: boolean;
    maxSlPct?: number;
    minRewardRiskRatio?: number;
  }): EntryDecision {
    const {
      candles,
      closePrice,
      ribbon,
      exhaustion,
      curAtr,
      slBufferPct,
      side = "LONG",
      isHtfBull = false,
      macroGateMode = "off",
      circuitBreakerActive = false,
      maxSlPct = 1.80,
      minRewardRiskRatio,
    } = opts;

    if (circuitBreakerActive) {
      return {
        shouldEnter: false,
        entryPrice: closePrice,
        stopLossPrice: 0,
        fanSpreadPct: ribbon.fanSpreadPct,
        blockedBy: "CIRCUIT_BREAKER",
        reason: "Circuit Breaker Active",
      };
    }

    const currentIndex = opts.currentIndex ?? (candles.length - 1);
    const curCandle = candles[currentIndex];
    if (!curCandle) {
      return { shouldEnter: false, entryPrice: 0, stopLossPrice: 0, fanSpreadPct: 0 };
    }

    if (side === "LONG") {
      // 1. Macro Trend Bullish check
      const passesMacro = isHtfBull || (closePrice > ribbon.ema75 && ribbon.ema75 > ribbon.ema200);
      if (!passesMacro || (macroGateMode === "noDeepBear" && opts.htfRegime?.isDeepBear)) {
        return {
          shouldEnter: false,
          side: "BUY",
          positionSide: "LONG",
          engineType: "TREND_RIDER_LONG",
          entryPrice: closePrice,
          stopLossPrice: 0,
          fanSpreadPct: ribbon.fanSpreadPct,
          blockedBy: "MACRO_GATE",
          reason: "Trend Rider Long requires HTF Bullish alignment",
        };
      }

      // 2. Trend Alignment (Fast above Mid, Mid above Slow)
      const isTrendAligned = ribbon.ema4 > ribbon.ema16 && ribbon.ema16 > ribbon.ema75;

      // 3. Dynamic Support Pullback (Touched near EMA 16 or EMA 25 within last 3 bars)
      const last3Lows = candles.slice(Math.max(0, currentIndex - 2), currentIndex + 1).map((c) => c.low);
      const minLow3 = Math.min(...last3Lows);
      const touchedDynamicSupport = minLow3 <= ribbon.ema16 * 1.002 || minLow3 <= ribbon.ema25 * 1.003;

      // 4. Momentum Resumption Confirmation
      const isGreenCandle = curCandle.close > curCandle.open;
      const closesAboveEma4 = closePrice > ribbon.ema4;
      const healthyRsi = exhaustion.rsi >= 46 && exhaustion.rsi <= 68;
      const momentumUp = exhaustion.macd.isTurningUp || exhaustion.macd.hist > 0;

      const qualified = isTrendAligned && touchedDynamicSupport && isGreenCandle && closesAboveEma4 && healthyRsi && momentumUp;

      // SL: Local swing low base of last 6 bars
      const recentLows = candles.slice(Math.max(0, currentIndex - 5), currentIndex + 1).map((c) => c.low);
      const swingLow = Math.min(...recentLows);
      const slDist = Math.max(swingLow * (slBufferPct / 100), curAtr * 1.0);
      const rawSl = swingLow - slDist;
      const stopLossPrice = Math.max(rawSl, closePrice * (1 - maxSlPct / 100));

      // TP Target: Recent 15-bar swing high or 1.2x Risk
      const recentHighs = candles.slice(Math.max(0, currentIndex - 14), currentIndex + 1).map((c) => c.high);
      const swingHigh15 = recentHighs.length > 0 ? Math.max(...recentHighs) : closePrice * 1.01;
      const targetPrice = Math.max(swingHigh15, closePrice * 1.0075);

      const rrCalc = MaFanCoreRules.computeRewardRisk({
        entryPrice: closePrice,
        ema25: targetPrice,
        stopLossPrice,
        positionSide: "LONG",
      });

      if (!qualified) {
        return {
          shouldEnter: false,
          side: "BUY",
          positionSide: "LONG",
          engineType: "TREND_RIDER_LONG",
          entryPrice: 0,
          stopLossPrice: 0,
          swingLow,
          fanSpreadPct: ribbon.fanSpreadPct,
          reason: "Waiting for Bullish Pullback Bounce to EMA 16/25",
        };
      }

      if (minRewardRiskRatio !== undefined && minRewardRiskRatio > 0 && rrCalc.rr < minRewardRiskRatio) {
        return {
          shouldEnter: false,
          side: "BUY",
          positionSide: "LONG",
          engineType: "TREND_RIDER_LONG",
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
        side: "BUY",
        positionSide: "LONG",
        engineType: "TREND_RIDER_LONG",
        entryPrice: closePrice,
        stopLossPrice,
        swingLow,
        fanSpreadPct: ribbon.fanSpreadPct,
        riskPct: rrCalc.riskPct,
        rewardPct: rrCalc.rewardPct,
        rewardRisk: rrCalc.rr,
        reason: `Trend Rider Long: Retest EMA 16/25 bounced, Close > EMA4, RSI ${exhaustion.rsi.toFixed(1)}`,
      };
    } else {
      // SHORT Trend Rider
      // 1. Macro Trend Bearish check
      const passesMacro = !isHtfBull || (opts.htfRegime?.isDeepBear ?? false) || (closePrice < ribbon.ema75 && ribbon.ema75 < ribbon.ema200);
      if (!passesMacro || macroGateMode === "bullOnly") {
        return {
          shouldEnter: false,
          side: "SELL",
          positionSide: "SHORT",
          engineType: "TREND_RIDER_SHORT",
          entryPrice: closePrice,
          stopLossPrice: 0,
          fanSpreadPct: ribbon.fanSpreadPct,
          blockedBy: "MACRO_GATE",
          reason: "Trend Rider Short requires Bearish alignment",
        };
      }

      // 2. Trend Alignment (Fast below Mid, Mid below Slow)
      const isTrendAligned = ribbon.ema4 < ribbon.ema16 && ribbon.ema16 < ribbon.ema75;

      // 3. Dynamic Resistance Retest (Touched near EMA 16 or EMA 25 within last 3 bars)
      const last3Highs = candles.slice(Math.max(0, currentIndex - 2), currentIndex + 1).map((c) => c.high);
      const maxHigh3 = Math.max(...last3Highs);
      const touchedDynamicResistance = maxHigh3 >= ribbon.ema16 * 0.998 || maxHigh3 >= ribbon.ema25 * 0.997;

      // 4. Momentum Breakdown Confirmation
      const isRedCandle = curCandle.close < curCandle.open;
      const closesBelowEma4 = closePrice < ribbon.ema4;
      const healthyRsi = exhaustion.rsi >= 32 && exhaustion.rsi <= 54;
      const momentumDown = exhaustion.macd.isTurningDown || exhaustion.macd.hist < 0;

      const qualified = isTrendAligned && touchedDynamicResistance && isRedCandle && closesBelowEma4 && healthyRsi && momentumDown;

      // SL: Local swing high of last 6 bars
      const recentHighs = candles.slice(Math.max(0, currentIndex - 5), currentIndex + 1).map((c) => c.high);
      const swingHigh = Math.max(...recentHighs);
      const slDist = Math.max(swingHigh * (slBufferPct / 100), curAtr * 1.0);
      const rawSl = swingHigh + slDist;
      const stopLossPrice = Math.min(rawSl, closePrice * (1 + maxSlPct / 100));

      // TP Target: Recent 15-bar swing low or 1.2x Risk downwards
      const recentLows = candles.slice(Math.max(0, currentIndex - 14), currentIndex + 1).map((c) => c.low);
      const swingLow15 = recentLows.length > 0 ? Math.min(...recentLows) : closePrice * 0.99;
      const targetPrice = Math.min(swingLow15, closePrice * 0.9925);

      const rrCalc = MaFanCoreRules.computeRewardRisk({
        entryPrice: closePrice,
        ema25: targetPrice,
        stopLossPrice,
        positionSide: "SHORT",
      });

      if (!qualified) {
        return {
          shouldEnter: false,
          side: "SELL",
          positionSide: "SHORT",
          engineType: "TREND_RIDER_SHORT",
          entryPrice: 0,
          stopLossPrice: 0,
          swingHigh,
          fanSpreadPct: ribbon.fanSpreadPct,
          reason: "Waiting for Bearish Pullback Rejection at EMA 16/25",
        };
      }

      if (minRewardRiskRatio !== undefined && minRewardRiskRatio > 0 && rrCalc.rr < minRewardRiskRatio) {
        return {
          shouldEnter: false,
          side: "SELL",
          positionSide: "SHORT",
          engineType: "TREND_RIDER_SHORT",
          entryPrice: closePrice,
          stopLossPrice,
          swingHigh,
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
        side: "SELL",
        positionSide: "SHORT",
        engineType: "TREND_RIDER_SHORT",
        entryPrice: closePrice,
        stopLossPrice,
        swingHigh,
        fanSpreadPct: ribbon.fanSpreadPct,
        riskPct: rrCalc.riskPct,
        rewardPct: rrCalc.rewardPct,
        rewardRisk: rrCalc.rr,
        reason: `Trend Rider Short: Retest EMA 16/25 rejected, Close < EMA4, RSI ${exhaustion.rsi.toFixed(1)}`,
      };
    }
  }

  /**
   * 2.2 Universal Modular Entry Dispatcher
   * Routes evaluation to Dip/Peak Hunter, Trend Rider, or Dual Mode.
   */
  public static evaluateModularEntry(opts: {
    candles: Candle[];
    currentIndex?: number;
    closePrice: number;
    ribbon: RibbonState;
    exhaustion: ExhaustionState;
    requiredSpreadPct: number;
    curAtr: number;
    slBufferPct: number;
    minRewardRiskRatio?: number;
    waterfallGuardMode?: WaterfallGuardMode;
    isHtfBull?: boolean;
    macroGateMode?: "off" | "noDeepBear" | "bullOnly";
    htfRegime?: HtfRegime;
    enableUpsideFloor?: boolean;
    enableNoFallingKnife?: boolean;
    circuitBreakerActive?: boolean;
    maxSlPct?: number;
    tradeMode?: "dip_hunter" | "trend_rider" | "dual" | "dynamic_grid";
    tradeDirection?: "long" | "short" | "both";
  }): EntryDecision {
    const tradeMode = opts.tradeMode ?? "dip_hunter";
    const tradeDirection = opts.tradeDirection ?? "long";

    // A. Trend Rider Mode Only
    if (tradeMode === "trend_rider") {
      if (tradeDirection === "long") {
        return MaFanCoreRules.evaluateTrendRiderEntry({ ...opts, side: "LONG" });
      } else if (tradeDirection === "short") {
        return MaFanCoreRules.evaluateTrendRiderEntry({ ...opts, side: "SHORT" });
      } else {
        // Both: Prioritize based on HTF trend
        const firstSide = opts.isHtfBull ? "LONG" : "SHORT";
        const secondSide = opts.isHtfBull ? "SHORT" : "LONG";
        const first = MaFanCoreRules.evaluateTrendRiderEntry({ ...opts, side: firstSide });
        if (first.shouldEnter) return first;
        const second = MaFanCoreRules.evaluateTrendRiderEntry({ ...opts, side: secondSide });
        if (second.shouldEnter) return second;
        return first;
      }
    }

    // B. Dual Mode: Trend Rider during strong trending markets, Dip/Peak Hunter during stretched exhaustion!
    if (tradeMode === "dual") {
      const isExtremeExhaustion = opts.ribbon.fanSpreadPct >= opts.requiredSpreadPct * 1.15 || opts.exhaustion.rsi <= 32 || opts.exhaustion.rsi >= 68;

      if (isExtremeExhaustion) {
        // Exhaustion priority: evaluate Dip / Peak Hunter first
        if (tradeDirection === "long" || tradeDirection === "both") {
          const hunterLong = MaFanCoreRules.evaluateEntry({ ...opts, side: "LONG" });
          if (hunterLong.shouldEnter) return hunterLong;
        }
        if (tradeDirection === "short" || tradeDirection === "both") {
          const hunterShort = MaFanCoreRules.evaluateEntry({ ...opts, side: "SHORT" });
          if (hunterShort.shouldEnter) return hunterShort;
        }
        // Fallback to Trend Rider
        if (tradeDirection === "long" || tradeDirection === "both") {
          const riderLong = MaFanCoreRules.evaluateTrendRiderEntry({ ...opts, side: "LONG" });
          if (riderLong.shouldEnter) return riderLong;
        }
        if (tradeDirection === "short" || tradeDirection === "both") {
          const riderShort = MaFanCoreRules.evaluateTrendRiderEntry({ ...opts, side: "SHORT" });
          if (riderShort.shouldEnter) return riderShort;
        }
      } else {
        // Trend continuation priority: evaluate Trend Rider first
        if (tradeDirection === "long" || tradeDirection === "both") {
          if (opts.isHtfBull) {
            const riderLong = MaFanCoreRules.evaluateTrendRiderEntry({ ...opts, side: "LONG" });
            if (riderLong.shouldEnter) return riderLong;
          }
        }
        if (tradeDirection === "short" || tradeDirection === "both") {
          if (!opts.isHtfBull || opts.htfRegime?.isDeepBear) {
            const riderShort = MaFanCoreRules.evaluateTrendRiderEntry({ ...opts, side: "SHORT" });
            if (riderShort.shouldEnter) return riderShort;
          }
        }
        // Fallback to Hunter
        if (tradeDirection === "long" || tradeDirection === "both") {
          const hunterLong = MaFanCoreRules.evaluateEntry({ ...opts, side: "LONG" });
          if (hunterLong.shouldEnter) return hunterLong;
        }
        if (tradeDirection === "short" || tradeDirection === "both") {
          const hunterShort = MaFanCoreRules.evaluateEntry({ ...opts, side: "SHORT" });
          if (hunterShort.shouldEnter) return hunterShort;
        }
      }

      // Default waiting return
      return tradeDirection === "short"
        ? MaFanCoreRules.evaluateEntry({ ...opts, side: "SHORT" })
        : MaFanCoreRules.evaluateEntry({ ...opts, side: "LONG" });
    }

    // C. Dip Hunter Mode (Default)
    if (tradeDirection === "long") {
      return MaFanCoreRules.evaluateEntry({ ...opts, side: "LONG" });
    } else if (tradeDirection === "short") {
      return MaFanCoreRules.evaluateEntry({ ...opts, side: "SHORT" });
    } else {
      // Both: Check Long first, then Short
      const hunterLong = MaFanCoreRules.evaluateEntry({ ...opts, side: "LONG" });
      if (hunterLong.shouldEnter) return hunterLong;
      const hunterShort = MaFanCoreRules.evaluateEntry({ ...opts, side: "SHORT" });
      if (hunterShort.shouldEnter) return hunterShort;
      return hunterLong;
    }
  }

  /**
   * 3. Evaluate Dynamic Ratchet SL
   * Lifts Stop Loss (Long) or Lowers Stop Loss (Short) when price forms a higher local base / lower local ceiling.
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
    positionSide?: "LONG" | "SHORT";
  }): number | null {
    const { candles, barsHeld, currentSlPrice, currentPrice, curAtr, slBufferPct, positionSide = "LONG" } = opts;
    const useRatchetSl = opts.useRatchetSl !== false;
    if (!useRatchetSl || barsHeld < 3 || candles.length === 0) return null;

    const currentIndex = opts.currentIndex ?? (candles.length - 1);

    if (positionSide === "LONG") {
      // Look back 5 bars (idx - 4 to idx) for local base
      const recentLows = candles.slice(Math.max(0, currentIndex - 4), currentIndex + 1).map((x) => x.low);
      const localMin = Math.min(...recentLows);
      const localSlDist = Math.max(localMin * (slBufferPct / 100), curAtr * 1.0);
      const localLow = localMin - localSlDist;

      if (localLow > currentSlPrice && localLow < currentPrice) {
        return localLow;
      }
    } else {
      // SHORT: Look back 5 bars for local resistance ceiling
      const recentHighs = candles.slice(Math.max(0, currentIndex - 4), currentIndex + 1).map((x) => x.high);
      const localMax = Math.max(...recentHighs);
      const localSlDist = Math.max(localMax * (slBufferPct / 100), curAtr * 1.0);
      const localHigh = localMax + localSlDist;

      if (localHigh < currentSlPrice && localHigh > currentPrice) {
        return localHigh;
      }
    }
    return null;
  }

  /**
   * 4. Evaluate Position Exits (Priority: TP2 -> SL -> TP1)
   * Unifies TP1, Trapped Breakeven Rescue, SL, and TP2 Trailing for both LONG and SHORT.
   */
  public static evaluateExits(opts: {
    highPrice: number;
    lowPrice: number;
    closePrice: number;
    entryPrice: number;
    stopLossPrice: number;
    tp1Filled: boolean;
    highestPriceSinceTp1: number;
    highestPriceSinceEntry?: number;
    lowestPriceSinceTp1?: number;
    lowestPriceSinceEntry?: number;
    positionSide?: "LONG" | "SHORT";
    ribbon: RibbonState;
    prevRibbon?: RibbonState;
    exhaustion?: ExhaustionState;
    prevExhaustion?: ExhaustionState;
    trailingPullbackPct: number;
    breakevenFeeBufferPct?: number;
    isOverbought?: boolean;
    isOversold?: boolean;
    barsHeld?: number;
    isHtfBull?: boolean;
    cushionMode?: CushionMode;
    cushionThresholdPct?: number;
    tp1MinProfitPct?: number;
    enableFastCut?: boolean;
    fastCutThresholdPct?: number;
    stagnationBars?: number;
  }): ExitDecision {
    const {
      highPrice,
      lowPrice,
      closePrice,
      entryPrice,
      stopLossPrice,
      tp1Filled,
      highestPriceSinceTp1,
      highestPriceSinceEntry,
      positionSide = "LONG",
      ribbon,
      prevRibbon,
      exhaustion,
      prevExhaustion,
      trailingPullbackPct,
      breakevenFeeBufferPct,
      isOverbought,
      barsHeld,
      enableFastCut,
      fastCutThresholdPct,
      stagnationBars,
    } = opts;

    const beFeeBuffer = (breakevenFeeBufferPct ?? 0.05) / 100;

    // ─── SHORT POSITION EXITS ────────────────────────────────────────────
    if (positionSide === "SHORT") {
      // ── Priority 1: Stop Loss / Breakeven Stop Check (SHORT) ───────────────
      // If price rises to or above stopLossPrice, SL triggers
      if (highPrice >= stopLossPrice) {
        return {
          action: "SL",
          exitPrice: stopLossPrice,
          reason: tp1Filled ? "Breakeven Stop Loss Triggered (SHORT)" : "Stop Loss Triggered (SHORT)",
        };
      }

      // ── Priority 1.5: Fast Technical Invalidation & Stagnation Cut (SHORT) ──
      if (!tp1Filled && enableFastCut !== false && barsHeld !== undefined && barsHeld >= 3) {
        const curPnl = entryPrice > 0 ? ((entryPrice - closePrice) / entryPrice) * 100 : 0;
        const hookUp = prevRibbon && ribbon.ema4 > prevRibbon.ema4;
        const closeAboveEma4 = closePrice > ribbon.ema4;
        const macdHistUp = exhaustion && prevExhaustion && exhaustion.macd.hist > prevExhaustion.macd.hist;
        const fastCutThreshold = fastCutThresholdPct ?? -0.80;

        // Rule A: Momentum Collapse Cut (Rapid upside reversal against short)
        if (closeAboveEma4 && hookUp && macdHistUp && curPnl <= fastCutThreshold) {
          return {
            action: "SL",
            exitPrice: closePrice,
            reason: `Fast Technical Cut: Momentum Collapse (Close > EMA4 & Hook Up & MACD Green @ ${curPnl.toFixed(2)}%)`,
          };
        }

        // Rule B: Stagnation Cut (Held >= 6 bars, never dropped to +0.70%, closed above EMA4, negative PnL)
        const lowestEntry = opts.lowestPriceSinceEntry ?? closePrice;
        const maxDrop = entryPrice > 0 ? ((entryPrice - lowestEntry) / entryPrice) * 100 : 0;
        if (
          barsHeld >= (stagnationBars ?? 6) &&
          maxDrop < 0.70 &&
          closeAboveEma4 &&
          curPnl < 0
        ) {
          return {
            action: "SL",
            exitPrice: closePrice,
            reason: `Fast Stagnation Cut: Failed to drop +0.70% in ${barsHeld} bars (Close > EMA4 @ ${curPnl.toFixed(2)}%)`,
          };
        }
      }

      // ── Priority 2: TP2 Check (SHORT) ──────────────────────────────────────
      if (tp1Filled) {
        const target = Math.min(ribbon.ema75, ribbon.ema200);
        const hitTarget = lowPrice <= target && lowPrice < entryPrice * 0.9965;
        const lowestSince = opts.lowestPriceSinceTp1 ?? lowPrice;
        const trailingExitRatio = 1 + trailingPullbackPct / 100;
        const hitTrailing = lowestSince < entryPrice * 0.995 && highPrice >= lowestSince * trailingExitRatio;
        const hitOversold = !!opts.isOversold && lowPrice < entryPrice * 0.992;

        if (hitTarget || hitTrailing || hitOversold) {
          const rawExitPrice = hitTarget
            ? Math.max(lowPrice, Math.min(target, closePrice))
            : hitTrailing
            ? lowestSince * trailingExitRatio
            : closePrice;
          // Never allow TP2 to exit above the locked stopLossPrice (Breakeven for short)
          const exitPrice = Math.min(stopLossPrice, rawExitPrice);
          return {
            action: "TP2",
            exitPrice,
            reason: hitTrailing
              ? `Trailing Pullback (${trailingPullbackPct}%) from bottom $${lowestSince.toFixed(4)}`
              : hitTarget
              ? `EMA Macro Target ($${target.toFixed(4)})`
              : "Oversold Exhaustion Exit",
          };
        }
      }

      // ── Priority 3: TP1 at EMA 25 & Asymmetric Profit Target (SHORT) ────────
      if (!tp1Filled) {
        const isTrapped = (barsHeld !== undefined && barsHeld >= 5) && (ribbon.ema25 >= entryPrice * 0.9985);
        const minProfitFrac = Math.max((opts.tp1MinProfitPct ?? 0.85) / 100, beFeeBuffer);
        const minProfitPrice = isTrapped
          ? entryPrice * (1 - beFeeBuffer)
          : entryPrice * (1 - minProfitFrac);
        const tp1Target = Math.min(ribbon.ema25, minProfitPrice);

        if (lowPrice <= tp1Target) {
          const tp1ProfitPct = ((entryPrice - tp1Target) / entryPrice) * 100;
          const mode = opts.cushionMode ?? "off";
          const threshold = opts.cushionThresholdPct ?? 0.35;
          const cushionApplied =
            (mode === "always" || (mode === "htfBull" && !opts.isHtfBull)) && tp1ProfitPct < threshold;
          const newStopLossPrice = cushionApplied
            ? stopLossPrice
            : Math.min(stopLossPrice, entryPrice * (1 - beFeeBuffer));

          return {
            action: "TP1",
            exitPrice: tp1Target,
            newStopLossPrice,
            cushionApplied,
            reason: isTrapped
              ? "Trapped Short Breakeven Rescue"
              : cushionApplied
              ? "TP1 Mean Reversion (Bear Cushion Active)"
              : `TP1 Profit Target (+${tp1ProfitPct.toFixed(2)}%)`,
          };
        }
      }

      return {
        action: "NONE",
        exitPrice: 0,
      };
    }

    // ─── LONG POSITION EXITS (DEFAULT) ───────────────────────────────────
    // ── Priority 1: Stop Loss / Breakeven Stop Check ────────────────────────
    // If price falls to or below stopLossPrice, SL takes absolute precedence
    if (lowPrice <= stopLossPrice) {
      return {
        action: "SL",
        exitPrice: stopLossPrice,
        reason: tp1Filled ? "Breakeven Stop Loss Triggered" : "Stop Loss Triggered",
      };
    }

    // ── Priority 1.5: Fast Technical Invalidation & Stagnation Cut (Before TP1) ──
    // Asymmetric Risk:Reward protection: cut fast when short-term momentum breaks down
    if (!tp1Filled && enableFastCut !== false && barsHeld !== undefined && barsHeld >= 3) {
      const curPnl = entryPrice > 0 ? ((closePrice - entryPrice) / entryPrice) * 100 : 0;
      const hookDown = prevRibbon && ribbon.ema4 < prevRibbon.ema4;
      const closeBelowEma4 = closePrice < ribbon.ema4;
      const macdHistDown = exhaustion && prevExhaustion && exhaustion.macd.hist < prevExhaustion.macd.hist;
      const fastCutThreshold = fastCutThresholdPct ?? -0.80;

      // Rule A: Momentum Collapse Cut
      if (closeBelowEma4 && hookDown && macdHistDown && curPnl <= fastCutThreshold) {
        return {
          action: "SL",
          exitPrice: closePrice,
          reason: `Fast Technical Cut: Momentum Collapse (Close < EMA4 & Hook Down & MACD Red @ ${curPnl.toFixed(2)}%)`,
        };
      }

      // Rule B: Stagnation Cut (Held >= 6 bars, never popped to +0.70%, closed below EMA4, negative PnL)
      const maxPop = highestPriceSinceEntry ? ((highestPriceSinceEntry - entryPrice) / entryPrice) * 100 : 0;
      if (
        barsHeld >= (stagnationBars ?? 6) &&
        maxPop < 0.70 &&
        closeBelowEma4 &&
        curPnl < 0
      ) {
        return {
          action: "SL",
          exitPrice: closePrice,
          reason: `Fast Stagnation Cut: Failed to pop +0.70% in ${barsHeld} bars (Close < EMA4 @ ${curPnl.toFixed(2)}%)`,
        };
      }
    }

    // ── Priority 2: TP2 Check (if TP1 was already filled) ───────────────────
    if (tp1Filled) {
      const target = Math.max(ribbon.ema75, ribbon.ema200);
      const hitTarget = highPrice >= target && highPrice > entryPrice * 1.0035;
      const trailingExitRatio = 1 - trailingPullbackPct / 100;
      const hitTrailing = highestPriceSinceTp1 > entryPrice * 1.005 && lowPrice <= highestPriceSinceTp1 * trailingExitRatio;
      const hitOverbought = !!isOverbought && highPrice > entryPrice * 1.008;

      if (hitTarget || hitTrailing || hitOverbought) {
        const rawExitPrice = hitTarget
          ? Math.min(highPrice, Math.max(target, closePrice))
          : hitTrailing
          ? highestPriceSinceTp1 * trailingExitRatio
          : closePrice;
        // Never allow TP2 to exit below the locked stopLossPrice (Breakeven)
        const exitPrice = Math.max(stopLossPrice, rawExitPrice);
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

    // ── Priority 3: TP1 at EMA 25 & Trapped Breakeven Rescue ────────────────
    if (!tp1Filled) {
      // Trapped Position Rescue only activates if held for >= 3 bars and EMA25 drifted below entry
      const isTrapped = (barsHeld !== undefined && barsHeld >= 3) && (ribbon.ema25 <= entryPrice * 1.0015);
      const minProfitFrac = Math.max((opts.tp1MinProfitPct ?? 0.20) / 100, beFeeBuffer);
      const minProfitPrice = isTrapped
        ? entryPrice * (1 + beFeeBuffer)
        : entryPrice * (1 - minProfitFrac);
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
