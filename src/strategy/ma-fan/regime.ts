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
    const isBullish = isAboveEma200 || isEmaAlignedUp;

    // Asymmetric risk rules:
    // If Bullish: Standard spread (1.0x), user configured baseTp1Ratio (e.g. 50%)
    // If Bearish: Deeper spread required (1.25x), higher TP1 ratio to derisk faster (at least 75%)
    const spreadMultiplier = isBullish ? 1.0 : 1.25;
    const recommendedTp1Ratio = isBullish ? cleanBaseTp1 : Math.max(cleanBaseTp1, 0.75);

    return {
      timeframe,
      isBullish,
      isAboveEma200,
      spreadMultiplier,
      recommendedTp1Ratio,
    };
  }
}
