/**
 * Instant In-Memory Auto-Calibrator
 * Simulates recent historical candles in milliseconds to determine the optimal
 * fan spread threshold for a specific symbol and market regime.
 */

import { Candle, CalibrationResult } from "./types.js";
import { RibbonEngine } from "./ribbon.js";
import { ExhaustionEngine } from "./exhaustion.js";

export class AutoCalibrator {
  public static calibrate(
    symbol: string,
    candles: Candle[],
    candidateSpreads: number[] = [0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.65]
  ): CalibrationResult {
    const candidatesResults: {
      spreadPct: number;
      netPnlPct: number;
      winRate: number;
      tradeCount: number;
      profitFactor: number;
    }[] = [];

    const warmup = Math.min(100, Math.floor(candles.length / 3));

    // Precompute Ribbon and Exhaustion arrays once in O(N)
    const ribbonStates = RibbonEngine.computeAllRibbonStates(candles);
    const exhaustionStates = ExhaustionEngine.computeAllExhaustion(candles);

    // Precompute 14-period ATR array for Dynamic SL buffer
    const atrs: number[] = new Array(candles.length).fill(0);
    let trSum = 0;
    for (let i = 1; i < candles.length; i++) {
      const prevC = candles[i - 1]!.close;
      const c = candles[i]!;
      const tr = Math.max(c.high - c.low, Math.abs(c.high - prevC), Math.abs(c.low - prevC));
      if (i <= 14) {
        trSum += tr;
        if (i === 14) atrs[i] = trSum / 14;
      } else {
        atrs[i] = (atrs[i - 1]! * 13 + tr) / 14;
      }
    }

    for (const spread of candidateSpreads) {
      let cash = 200;
      let heldQty = 0;
      let entryPrice = 0;
      let stopLossPrice = 0;
      let tp1Filled = false;
      let highestSinceTp1 = 0;

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

          // Stop Loss
          if (c.low <= stopLossPrice) {
            const pnl = (stopLossPrice - entryPrice) * heldQty;
            cash += heldQty * stopLossPrice;
            if (pnl >= 0) { grossProfit += pnl; wins++; }
            else { grossLoss += Math.abs(pnl); losses++; }
            heldQty = 0;
            continue;
          }

          // TP1 at EMA 25
          if (!tp1Filled && c.high >= ribbon.ema25 && ribbon.ema25 > entryPrice * 1.0015) {
            const exitP = ribbon.ema25;
            const sellQty = heldQty * 0.5;
            const pnl = (exitP - entryPrice) * sellQty;
            cash += sellQty * exitP;
            heldQty -= sellQty;
            if (pnl >= 0) { grossProfit += pnl; wins++; }
            else { grossLoss += Math.abs(pnl); losses++; }
            tp1Filled = true;
            highestSinceTp1 = exitP;
            stopLossPrice = Math.max(stopLossPrice, entryPrice * 1.0005);
          }

          // TP2 at EMA 75/200 or Trailing
          if (tp1Filled && heldQty > 0) {
            const target = Math.max(ribbon.ema75, ribbon.ema200);
            const hitTarget = c.high >= target && target > entryPrice * 1.004;
            const hitTrailing = highestSinceTp1 > entryPrice * 1.005 && c.low <= highestSinceTp1 * 0.9955;

            if (hitTarget || hitTrailing) {
              const exitP = hitTrailing ? highestSinceTp1 * 0.9955 : Math.min(c.high, Math.max(target, c.close));
              const pnl = (exitP - entryPrice) * heldQty;
              cash += heldQty * exitP;
              if (pnl >= 0) { grossProfit += pnl; wins++; }
              else { grossLoss += Math.abs(pnl); losses++; }
              heldQty = 0;
              continue;
            }
          }
        }

        // Position Entry
        if (heldQty === 0 && cash >= 10) {
          const exhaustion = exhaustionStates[i]!;
          const isStretched = ribbon.fanSpreadPct >= spread;

          const isDownside = ribbon.ema4 <= ribbon.ema25 && c.close < ribbon.ema25;

          if (ribbon.isFanningDown && isStretched && ribbon.isHookUp && exhaustion.isOversoldExhaustion && isDownside) {
            entryPrice = c.close;
            const recentLows = candles.slice(Math.max(0, i - 10), i + 1).map((x) => x.low);
            const lowestPoint = Math.min(...recentLows);
            const curAtr = atrs[i] || c.close * 0.003;
            const slDist = Math.max(lowestPoint * 0.0025, curAtr * 1.0);
            stopLossPrice = lowestPoint - slDist;

            const invest = cash * 0.98;
            heldQty = invest / entryPrice;
            cash -= invest;
            tp1Filled = false;
            highestSinceTp1 = entryPrice;
          }
        }
      }

      const totalTrades = wins + losses;
      const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
      const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99.9 : 0;
      const finalEquity = cash + heldQty * candles[candles.length - 1]!.close;
      const netPnlPct = ((finalEquity - 200) / 200) * 100;

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

    for (const cand of candidatesResults) {
      if (cand.tradeCount === 0) continue;
      // Score formula: Profit Factor * (Win Rate / 100) + NetPnL%
      const score = (cand.profitFactor * (cand.winRate / 100)) + (cand.netPnlPct * 0.5);
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
