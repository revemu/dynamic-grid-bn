/**
 * Higher Timeframe (HTF) Regime Supervisor
 * Analyzes HTF candles (15m or 1h) to dynamically adjust risk, spread thresholds,
 * and take-profit ratios (Asymmetric Risk Management).
 */

import { Candle, HtfRegime } from "./types.js";
import { calcEMA } from "./ribbon.js";

export class RegimeSupervisor {
  private static htfEmaCache = new WeakMap<
    Candle[],
    { ema25: number[]; ema75: number[]; ema200: number[]; length: number; lastTime: number }
  >();

  public static evaluateHtfRegime(
    candlesHtf: Candle[],
    timeframe: "15m" | "1h" = "15m",
    targetTime?: number,
    baseTp1Ratio: number = 0.50,
    execTimeframe: string = "5m"
  ): HtfRegime {
    const cleanBaseTp1 = Math.max(0.1, Math.min(0.9, baseTp1Ratio));
    if (candlesHtf.length === 0) {
      return {
        timeframe,
        isBullish: true,
        isAboveEma200: true,
        spreadMultiplier: 1.0,
        recommendedTp1Ratio: cleanBaseTp1,
      };
    }

    const htfSec = timeframe === "1h" ? 3600 : 900;
    const execSec = execTimeframe === "1h" ? 3600 : execTimeframe === "15m" ? 900 : execTimeframe === "1m" ? 60 : 300;
    let idx = candlesHtf.length - 1;
    if (targetTime !== undefined) {
      // targetTime is the lower timeframe candle open time. It closes at targetTime + execSec.
      // An HTF candle is confirmed closed only if: htf.time + htfSec <= targetTime + execSec.
      const maxAllowedHtfOpen = targetTime + execSec - htfSec;
      const found = candlesHtf.findIndex((c) => c.time > maxAllowedHtfOpen);
      if (found !== -1) {
        idx = Math.max(0, found - 1);
      }
    }

    let cache = this.htfEmaCache.get(candlesHtf);
    const lastC = candlesHtf[candlesHtf.length - 1]!;
    if (!cache || cache.length !== candlesHtf.length || cache.lastTime !== lastC.time) {
      const closes = candlesHtf.map((c) => c.close);
      cache = {
        ema25: calcEMA(closes, 25),
        ema75: calcEMA(closes, 75),
        ema200: calcEMA(closes, 200),
        length: candlesHtf.length,
        lastTime: lastC.time,
      };
      this.htfEmaCache.set(candlesHtf, cache);
    }

    const c = candlesHtf[idx]!;
    const curEma25 = cache.ema25[idx]!;
    const curEma75 = cache.ema75[idx]!;
    const curEma200 = cache.ema200[idx]!;

    const isAboveEma200 = c.close >= curEma200 * 0.998;
    const isEmaAlignedUp = curEma25 >= curEma75;
    // HTF is Bullish only when price has not broken below EMA 200 AND either EMAs are aligned up or price is above EMA 25
    const isBullish = isAboveEma200 && (isEmaAlignedUp || c.close >= curEma25);

    // Asymmetric risk rules:
    // If Bullish: Standard spread (1.0x), user configured baseTp1Ratio (e.g. 50%)
    // If Bearish: Deeper spread required (1.25x), higher TP1 ratio to derisk faster (at least 75%)
    const spreadMultiplier = isBullish ? 1.0 : 1.25;
    const recommendedTp1Ratio = isBullish ? cleanBaseTp1 : Math.max(cleanBaseTp1, 0.75);

    const distToEma200Pct = curEma200 > 0 ? ((c.close - curEma200) / curEma200) * 100 : 0;
    const prevEma200 = idx >= 5 ? cache.ema200[idx - 5]! : curEma200;
    const ema200Slope = prevEma200 > 0 ? ((curEma200 - prevEma200) / prevEma200) * 100 : 0;

    // Deep Bear regime: price is below EMA200 by more than 2.0% OR EMA200 is sloping down sharply
    const isDeepBear = distToEma200Pct < -2.0 || ema200Slope < -0.15;

    return {
      timeframe,
      isBullish,
      isAboveEma200,
      spreadMultiplier,
      recommendedTp1Ratio,
      isDeepBear,
      distToEma200Pct: Number(distToEma200Pct.toFixed(2)),
      ema200Slope: Number(ema200Slope.toFixed(3)),
    };
  }
}
