/**
 * Instant In-Memory Auto-Calibrator
 * Simulates recent historical candles in milliseconds to determine the optimal
 * fan spread threshold for a specific symbol and market regime.
 */

import { Candle, CalibrationResult } from "./types.js";
import { RibbonEngine, calcATR } from "./ribbon.js";
import { ExhaustionEngine } from "./exhaustion.js";
import { CushionMode, MaFanCoreRules } from "./core-rules.js";
import { RegimeSupervisor } from "./regime.js";

function aggregateTo15m(candles: Candle[], targetMinutes = 15): Candle[] {
  const targetSeconds = targetMinutes * 60;
  const groups = new Map<number, Candle>();
  for (const c of candles) {
    const bucket = Math.floor(c.time / targetSeconds) * targetSeconds;
    const existing = groups.get(bucket);
    if (!existing) {
      groups.set(bucket, { time: bucket, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 });
    } else {
      existing.high = Math.max(existing.high, c.high);
      existing.low = Math.min(existing.low, c.low);
      existing.close = c.close;
      existing.volume = (existing.volume || 0) + (c.volume || 0);
    }
  }
  return Array.from(groups.values()).sort((a, b) => a.time - b.time);
}

export interface CalibrateOptions {
  slBufferPct?: number;
  trailingPullbackPct?: number;
  breakevenFeeBufferPct?: number;
  tp1Ratio?: number;
  initialCapital?: number;
  supervisorTimeframe?: "15m" | "1h";
  useRatchetSl?: boolean;
  cushionMode?: CushionMode;
  costModel?: { feePctPerSide?: number; slippagePctPerFill?: number };
  macroGateMode?: "off" | "noDeepBear" | "bullOnly";
  enableUpsideFloor?: boolean;
}

export class AutoCalibrator {
  public static calibrate(
    symbol: string,
    candles: Candle[],
    candidateSpreads: number[] = [0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.65, 0.80, 1.00, 1.25, 1.50, 1.80],
    candlesHtf?: Candle[],
    opts?: CalibrateOptions
  ): CalibrationResult {
    const slBufferPct = opts?.slBufferPct ?? 0.25;
    const trailingPullbackPct = opts?.trailingPullbackPct ?? 0.45;
    const breakevenFeeBufferPct = opts?.breakevenFeeBufferPct ?? 0.05;
    const tp1Ratio = Math.max(0.1, Math.min(0.9, opts?.tp1Ratio ?? 0.50));
    const initialCapital = opts?.initialCapital ?? 200;
    const supervisorTimeframe = opts?.supervisorTimeframe ?? "15m";
    const useRatchetSl = opts?.useRatchetSl !== false;
    const cm = opts?.costModel;
    const costPerFill = cm ? ((cm.feePctPerSide ?? 0.075) + (cm.slippagePctPerFill ?? 0.01)) / 100 : 0;

    const candidatesResults: {
      spreadPct: number;
      netPnlPct: number;
      winRate: number;
      tradeCount: number;
      profitFactor: number;
    }[] = [];

    const targetMinutes = supervisorTimeframe === "1h" ? 60 : 15;
    const htfList = candlesHtf && candlesHtf.length > 0 ? candlesHtf : aggregateTo15m(candles, targetMinutes);
    const warmup = Math.min(100, Math.floor(candles.length / 4));

    // Precompute Ribbon and Exhaustion arrays once in O(N)
    const ribbonStates = RibbonEngine.computeAllRibbonStates(candles);
    const exhaustionStates = ExhaustionEngine.computeAllExhaustion(candles);

    // Precompute 14-period ATR array via standard calcATR (aligns 100% with BacktestService & Strategy)
    const atrs = calcATR(candles, 14);

    for (const spread of candidateSpreads) {
      let cash = initialCapital;
      let heldQty = 0;
      let entryPrice = 0;
      let entryIdx = 0;
      let stopLossPrice = 0;
      let tp1Filled = false;
      let tp1Price = 0;
      let tp1Qty = 0;
      let highestSinceTp1 = 0;
      let tradeInvest = 0;
      let tradeProceeds = 0;

      let grossProfit = 0;
      let grossLoss = 0;
      let wins = 0;
      let losses = 0;

      for (let i = warmup; i < candles.length; i++) {
        const c = candles[i]!;
        const ribbon = ribbonStates[i]!;

        // Position Exits
        if (heldQty > 0) {
          if (c.high > highestSinceTp1) highestSinceTp1 = c.high;
          const barsHeld = i - entryIdx;
          const curAtr = atrs[i] || c.close * 0.003;

          // Dynamic Ratchet SL via Universal MaFanCoreRules
          const liftedSl = MaFanCoreRules.evaluateRatchetSl({
            candles,
            currentIndex: i,
            barsHeld,
            currentSlPrice: stopLossPrice,
            currentPrice: c.close,
            curAtr,
            slBufferPct,
            useRatchetSl,
          });
          if (liftedSl !== null && liftedSl > stopLossPrice) {
            stopLossPrice = liftedSl;
          }

          // Evaluate Exits (Priority: TP2 -> SL -> TP1) via Universal MaFanCoreRules
          const htfRegime = RegimeSupervisor.evaluateHtfRegime(htfList, supervisorTimeframe, c.time, tp1Ratio);
          const exitDecision = MaFanCoreRules.evaluateExits({
            highPrice: c.high,
            lowPrice: c.low,
            closePrice: c.close,
            entryPrice,
            stopLossPrice,
            tp1Filled,
            highestPriceSinceTp1: highestSinceTp1,
            ribbon,
            trailingPullbackPct,
            breakevenFeeBufferPct,
            isOverbought: exhaustionStates[i]?.isOverboughtExhaustion,
            barsHeld,
            isHtfBull: !!htfRegime.isBullish,
            cushionMode: opts?.cushionMode ?? "off",
          });

          if (exitDecision.action === "TP2") {
            const exitP = exitDecision.exitPrice;
            const proceeds2 = heldQty * exitP * (1 - costPerFill);
            cash += proceeds2;
            tradeProceeds += proceeds2;
            const totalPnl = tradeProceeds - tradeInvest;
            if (totalPnl >= 0) { grossProfit += totalPnl; wins++; }
            else { grossLoss += Math.abs(totalPnl); losses++; }
            heldQty = 0;
            continue;
          }

          if (exitDecision.action === "SL") {
            const exitP = exitDecision.exitPrice;
            const proceeds2 = heldQty * exitP * (1 - costPerFill);
            cash += proceeds2;
            tradeProceeds += proceeds2;
            const totalPnl = tradeProceeds - tradeInvest;
            if (totalPnl >= 0) { grossProfit += totalPnl; wins++; }
            else { grossLoss += Math.abs(totalPnl); losses++; }
            heldQty = 0;
            continue;
          }

          if (exitDecision.action === "TP1") {
            const activeTp1Ratio = htfRegime.recommendedTp1Ratio ?? tp1Ratio;
            tp1Price = exitDecision.exitPrice;
            tp1Qty = heldQty * activeTp1Ratio;
            const proceeds1 = tp1Qty * tp1Price * (1 - costPerFill);
            cash += proceeds1;
            tradeProceeds += proceeds1;
            heldQty -= tp1Qty;
            tp1Filled = true;
            highestSinceTp1 = c.high;
            if (exitDecision.newStopLossPrice) {
              stopLossPrice = Math.max(stopLossPrice, exitDecision.newStopLossPrice);
            }
            // Intra-candle Breakeven SL check
            if (exitDecision.newStopLossPrice && exitDecision.newStopLossPrice > entryPrice && c.close <= stopLossPrice) {
              const exitP = stopLossPrice;
              const proceeds2 = heldQty * exitP * (1 - costPerFill);
              cash += proceeds2;
              tradeProceeds += proceeds2;
              const totalPnl = tradeProceeds - tradeInvest;
              if (totalPnl >= 0) { grossProfit += totalPnl; wins++; }
              else { grossLoss += Math.abs(totalPnl); losses++; }
              heldQty = 0;
              continue;
            }
          }
        }

        // Position Entry
        if (heldQty === 0 && cash >= 10) {
          const htfRegime = RegimeSupervisor.evaluateHtfRegime(htfList, supervisorTimeframe, c.time, tp1Ratio);
          const requiredSpread = spread * htfRegime.spreadMultiplier;
          const exhaustion = exhaustionStates[i]!;
          const curAtr = atrs[i] || c.close * 0.003;

          const entryDecision = MaFanCoreRules.evaluateEntry({
            candles,
            currentIndex: i,
            closePrice: c.close,
            ribbon,
            exhaustion,
            requiredSpreadPct: requiredSpread,
            curAtr,
            slBufferPct,
            isHtfBull: htfRegime.isBullish,
            macroGateMode: opts?.macroGateMode ?? "off",
            htfRegime,
            enableUpsideFloor: opts?.enableUpsideFloor !== false,
          });

          if (entryDecision.shouldEnter) {
            entryIdx = i;
            entryPrice = entryDecision.entryPrice;
            stopLossPrice = entryDecision.stopLossPrice;

            const invest = cash * 0.98;
            heldQty = (invest / entryPrice) * (1 - costPerFill);
            tradeInvest = invest;
            tradeProceeds = 0;
            tp1Qty = 0;
            cash -= invest;
            tp1Filled = false;
            highestSinceTp1 = entryPrice;
          }
        }
      }

      const totalTrades = wins + losses;
      const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
      const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99.9 : 0;
      const finalEquity = cash + (heldQty > 0 ? heldQty * candles[candles.length - 1]!.close * (1 - costPerFill) : 0);
      const netPnlPct = ((finalEquity - initialCapital) / initialCapital) * 100;

      candidatesResults.push({
        spreadPct: spread,
        netPnlPct,
        winRate,
        tradeCount: totalTrades,
        profitFactor,
      });
    }

    // Rank candidates by composite score: Win Rate * Profit Factor (if trades > 0)
    let best = candidatesResults[0]!;
    let bestScore = -999;

    // Minimum expected trades to prevent overfitting on 1-2 fluke trades during abnormal spikes
    const minRequiredTrades = Math.max(3, Math.floor(candles.length / 300));

    for (const cand of candidatesResults) {
      if (cand.tradeCount === 0) continue;
      // Cap profit factor to prevent division-by-zero distortion (e.g. 1 win 0 loss = infinite PF)
      const cappedPF = Math.min(6.0, cand.profitFactor);
      // Sample size confidence scaling (requires sufficient sample size for high score)
      const tradeConfidence = Math.min(1.0, cand.tradeCount / minRequiredTrades);
      // Score formula: (Capped PF * Win Rate * 10 + NetPnL% * 0.5) * confidence
      const score = ((cappedPF * (cand.winRate / 100) * 10) + (cand.netPnlPct * 0.5)) * tradeConfidence;
      if (score > bestScore) {
        bestScore = score;
        best = cand;
      }
    }

    return {
      symbol,
      bestSpreadPct: best.spreadPct,
      winRate: best.winRate,
      profitFactor: best.profitFactor,
      netPnlPct: best.netPnlPct,
      tradeCount: best.tradeCount,
      evaluatedAt: Date.now(),
      candidates: candidatesResults,
    };
  }
}
