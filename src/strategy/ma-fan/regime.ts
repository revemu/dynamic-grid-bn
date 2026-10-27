/**
 * Higher Timeframe (HTF) Regime Supervisor
 * Analyzes HTF candles (15m or 1h) to dynamically adjust risk, spread thresholds,
 * and take-profit ratios (Asymmetric Risk Management).
 */

import { Candle, HtfRegime } from "./types.js";
import { calcEMA } from "./ribbon.js";

export class RegimeSupervisor {
  public static evaluateHtfRegime(
    candlesHtf: Candle[],
    timeframe: "15m" | "1h" = "15m",
    targetTime?: number
  ): HtfRegime {
    if (candlesHtf.length === 0) {
      return {
        timeframe,
        isBullish: true,
        isAboveEma200: true,
        spreadMultiplier: 1.0,
        recommendedTp1Ratio: 0.50,
      };
    }

    let idx = candlesHtf.length - 1;
    if (targetTime !== undefined) {
      const found = candlesHtf.findIndex((c) => c.time > targetTime);
      if (found !== -1) {
        idx = Math.max(0, found - 1);
      }
    }

    const closes = candlesHtf.map((c) => c.close);
    const ema25 = calcEMA(closes, 25);
    const ema75 = calcEMA(closes, 75);
    const ema200 = calcEMA(closes, 200);

    const c = candlesHtf[idx]!;
    const curEma25 = ema25[idx]!;
    const curEma75 = ema75[idx]!;
    const curEma200 = ema200[idx]!;

    const isAboveEma200 = c.close >= curEma200 * 0.998;
    const isEmaAlignedUp = curEma25 >= curEma75;
    const isBullish = isAboveEma200 || isEmaAlignedUp;

    // Asymmetric risk rules:
    // If Bullish: Standard spread (1.0x), 50% TP1 / 50% Runner
    // If Bearish: Deeper spread required (1.25x), 75% TP1 fast / 25% Runner
    const spreadMultiplier = isBullish ? 1.0 : 1.25;
    const recommendedTp1Ratio = isBullish ? 0.50 : 0.75;

    return {
      timeframe,
      isBullish,
      isAboveEma200,
      spreadMultiplier,
      recommendedTp1Ratio,
    };
  }
}
