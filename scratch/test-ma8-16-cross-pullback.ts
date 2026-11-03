import fs from "fs";
import path from "path";
import { Candle } from "../src/strategy/ma-fan/types.js";
import { calcEMA } from "../src/strategy/ma-fan/ribbon.js";
import { calcRSI, calcMACD } from "../src/strategy/ma-fan/exhaustion.js";

function loadCandles(symbol: string, targetTf: "15m" | "1h"): Candle[] {
  const cacheDir = path.resolve(process.cwd(), "data/cache/klines");
  const f5m = path.join(cacheDir, `${symbol}_5m.json`);
  if (!fs.existsSync(f5m)) return [];
  const raw = JSON.parse(fs.readFileSync(f5m, "utf8"));
  const candles5m: Candle[] = raw.candles || raw;

  const bucketSec = targetTf === "15m" ? 900 : 3600;
  const aggregated: Candle[] = [];
  let curBucket = -1;
  let curCandle: Candle | null = null;

  for (const c of candles5m) {
    const b = Math.floor(c.time / bucketSec) * bucketSec;
    if (b !== curBucket) {
      if (curCandle) aggregated.push(curCandle);
      curBucket = b;
      curCandle = {
        time: b,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        isClosed: true,
      };
    } else if (curCandle) {
      curCandle.high = Math.max(curCandle.high, c.high);
      curCandle.low = Math.min(curCandle.low, c.low);
      curCandle.close = c.close;
      curCandle.volume += c.volume;
    }
  }
  if (curCandle) aggregated.push(curCandle);
  return aggregated;
}

interface Trade {
  symbol: string;
  entryIdx: number;
  entryTime: string;
  entryPrice: number;
  exitIdx: number;
  exitTime: string;
  exitPrice: number;
  pnlPct: number;
  holdingHours: number;
  maxAdverseExcursionPct: number;
  maxFavorableExcursionPct: number;
  exitReason: string;
}

interface StrategyTestParams {
  name: string;
  stopLossMode: "NONE" | "SWING_LOW" | "MA8_CROSS_MA16_DOWN" | "FIXED_3PCT";
  exitMode: "PURE_BULLISH_FAN" | "STAGED_TP" | "BULLISH_FAN_OR_RSI70";
}

function simulateCross816Pullback4(candles: Candle[], sym: string, params: StrategyTestParams): Trade[] {
  if (candles.length < 250) return [];

  const closes = candles.map((c) => c.close);
  const ma4 = calcEMA(closes, 4);
  const ma8 = calcEMA(closes, 8);
  const ma16 = calcEMA(closes, 16);
  const ma25 = calcEMA(closes, 25);
  const ma75 = calcEMA(closes, 75);
  const ma200 = calcEMA(closes, 200);

  const rsi = calcRSI(candles, 14);
  const macdData = calcMACD(candles, 12, 26, 9);

  const costPerSide = (0.075 + 0.01) / 100;

  const trades: Trade[] = [];
  let inPosition = false;
  let entryIdx = -1;
  let entryPrice = 0;
  let stopLossPrice = 0;
  let peakSinceEntry = 0;
  let troughSinceEntry = Infinity;

  // State machine variables:
  // 0: Idle, 1: Bottom fan seen, 2: MA8 crossed above MA16 (waiting for pullback to MA4)
  let hadBottomFan = false;
  let bottomFanExpiry = 0;
  let recentBottomLow = Infinity;

  let waitingForPullback = false;
  let pullbackExpiry = 0;
  let pullbackSwingLow = Infinity;

  for (let i = 200; i < candles.length; i++) {
    const c = candles[i]!;
    const prevC = candles[i - 1]!;

    const cur4 = ma4[i]!;
    const cur8 = ma8[i]!;
    const cur16 = ma16[i]!;
    const cur25 = ma25[i]!;
    const cur75 = ma75[i]!;
    const cur200 = ma200[i]!;

    const prev4 = ma4[i - 1]!;
    const prev8 = ma8[i - 1]!;
    const prev16 = ma16[i - 1]!;

    // ── 1. BOTTOM FAN DETECTION ──
    // Bottom Fan: MA4 < MA8 < MA16 < MA25 < MA75 < MA200
    const isBottomFan = cur4 < cur8 && cur8 < cur16 && cur16 < cur25 && cur25 < cur75 && cur75 < cur200;

    if (isBottomFan) {
      hadBottomFan = true;
      bottomFanExpiry = i + 20; // Fan memory holds for 20 bars
      recentBottomLow = Math.min(recentBottomLow, c.low, prevC.low);
    }

    if (i > bottomFanExpiry && !waitingForPullback && !inPosition) {
      hadBottomFan = false;
      recentBottomLow = Infinity;
    }

    // ── 2. REVERSAL CONFIRMATION: MA8 CROSSES ABOVE MA16 ──
    const is8Cross16Up = prev8 <= prev16 && cur8 > cur16;
    if (hadBottomFan && is8Cross16Up && !inPosition && !waitingForPullback) {
      // Reversal is confirmed!
      // Check RSI & MACD filters:
      const rsiOk = rsi[i]! >= 35 && rsi[i]! > rsi[i - 1]!;
      const macdOk = macdData.hist[i]! > macdData.hist[i - 1]!;

      if (rsiOk && macdOk) {
        waitingForPullback = true;
        pullbackExpiry = i + 12; // Wait up to 12 bars for pullback to MA4
        pullbackSwingLow = recentBottomLow;
      }
    }

    if (i > pullbackExpiry && waitingForPullback && !inPosition) {
      waitingForPullback = false;
    }

    // ── 3. PULLBACK ENTRY AT MA4 ──
    if (waitingForPullback && !inPosition) {
      // Did price pull back to touch or dip below MA4?
      const touchedMa4 = c.low <= cur4;
      // Ensure MA8 is still above MA16 (uptrend momentum hasn't broken)
      const momentumStillBullish = cur8 >= cur16;

      if (touchedMa4 && momentumStillBullish) {
        // Filled at MA4 (or Open if candle opened below MA4)
        inPosition = true;
        waitingForPullback = false;
        hadBottomFan = false;
        entryIdx = i;
        entryPrice = Math.min(c.open, cur4) * (1 + 0.0001); // Limit fill at MA4
        peakSinceEntry = c.high;
        troughSinceEntry = c.low;

        // Establish stop loss
        if (params.stopLossMode === "SWING_LOW") {
          stopLossPrice = Math.min(pullbackSwingLow, c.low * 0.985);
        } else if (params.stopLossMode === "FIXED_3PCT") {
          stopLossPrice = entryPrice * 0.97;
        } else {
          stopLossPrice = 0;
        }
      }
    }

    // ── 4. POSITION MANAGEMENT & EXITS ──
    if (inPosition) {
      peakSinceEntry = Math.max(peakSinceEntry, c.high);
      troughSinceEntry = Math.min(troughSinceEntry, c.low);

      let shouldExit = false;
      let exitReason = "";
      let exitPrice = c.close;

      // Check Stop Loss
      if (params.stopLossMode !== "NONE" && stopLossPrice > 0) {
        if (c.low <= stopLossPrice) {
          shouldExit = true;
          exitPrice = Math.min(c.open, stopLossPrice);
          exitReason = `SL (${params.stopLossMode})`;
        }
      }

      // Check Dynamic Invalidation: MA8 crosses back below MA16
      if (!shouldExit && params.stopLossMode === "MA8_CROSS_MA16_DOWN") {
        if (prev8 >= prev16 && cur8 < cur16) {
          shouldExit = true;
          exitPrice = c.close;
          exitReason = "MA8_CROSS_MA16_DOWN";
        }
      }

      // Check Exit: Full Bullish Fan (MA4 > MA8 > MA16 > MA25 > MA75 > MA200)
      const isBullishFan = cur4 > cur8 && cur8 > cur16 && cur16 > cur25 && cur25 > cur75 && cur75 > cur200;
      if (!shouldExit && isBullishFan) {
        shouldExit = true;
        exitPrice = c.close;
        exitReason = "FULL_BULLISH_FAN";
      }

      // Check Alternative Exit: Bullish Fan OR RSI Overbought > 70 + MA4 Hook Down
      if (!shouldExit && params.exitMode === "BULLISH_FAN_OR_RSI70") {
        if (cur4 > cur75 && rsi[i]! >= 70 && cur4 < prev4) {
          shouldExit = true;
          exitPrice = c.close;
          exitReason = "RSI_OB_PEAK_EXIT";
        }
      }

      if (shouldExit) {
        const rawPnl = ((exitPrice - entryPrice) / entryPrice) * 100;
        const netPnl = rawPnl - (costPerSide * 2 * 100);
        const holdingH = ((c.time - candles[entryIdx]!.time) / 3600);

        trades.push({
          symbol: sym,
          entryIdx,
          entryTime: new Date(candles[entryIdx]!.time * 1000).toISOString().replace("T", " ").slice(0, 16),
          entryPrice,
          exitIdx: i,
          exitTime: new Date(c.time * 1000).toISOString().replace("T", " ").slice(0, 16),
          exitPrice,
          pnlPct: netPnl,
          holdingHours: Number(holdingH.toFixed(1)),
          maxAdverseExcursionPct: Number((((troughSinceEntry - entryPrice) / entryPrice) * 100).toFixed(2)),
          maxFavorableExcursionPct: Number((((peakSinceEntry - entryPrice) / entryPrice) * 100).toFixed(2)),
          exitReason,
        });

        inPosition = false;
        waitingForPullback = false;
        hadBottomFan = false;
        recentBottomLow = Infinity;
        continue;
      }
    }
  }

  return trades;
}

async function run() {
  console.log("================================================================================");
  console.log("   NEW REVERSAL PATTERN: MA 8/16 CROSS + PULLBACK AT MA 4 ENTRY");
  console.log("   Step 1: Wait for Bottom Fan Climax (4 < 8 < 16 < 25 < 75 < 200)");
  console.log("   Step 2: Confirm Trend Reversal via MA8 crossing above MA16");
  console.log("   Step 3: Wait for Pullback / Retest to MA4 for optimal limit entry");
  console.log("   Step 4: Exit at Full Bullish Fan (4 > 8 > 16 > 25 > 75 > 200)");
  console.log("================================================================================\n");

  const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "SUIUSDT", "PEPEUSDT", "DOGEUSDT", "AVAXUSDT", "NEARUSDT"];
  const timeframes: Array<"15m" | "1h"> = ["15m", "1h"];

  const variants: StrategyTestParams[] = [
    {
      name: "V1: Pure Bullish Fan Exit (No SL)",
      stopLossMode: "NONE",
      exitMode: "PURE_BULLISH_FAN",
    },
    {
      name: "V2: Dynamic MA8 < MA16 Cut (Break of structure)",
      stopLossMode: "MA8_CROSS_MA16_DOWN",
      exitMode: "PURE_BULLISH_FAN",
    },
    {
      name: "V3: Bottom Swing Low SL (Cut if lower low)",
      stopLossMode: "SWING_LOW",
      exitMode: "PURE_BULLISH_FAN",
    },
    {
      name: "V4: Dual Exit (Bullish Fan OR RSI > 70 Peak)",
      stopLossMode: "NONE",
      exitMode: "BULLISH_FAN_OR_RSI70",
    },
  ];

  for (const tf of timeframes) {
    console.log(`\n>>>>>>>>>>>>>>>>>> TIMEFRAME: ${tf.toUpperCase()} <<<<<<<<<<<<<<<<<<`);

    for (const v of variants) {
      console.log(`\n--- [Variant] ${v.name} ---`);
      const results: any[] = [];
      let totalTrades = 0;
      let totalWins = 0;
      let sumPnl = 0;
      let worstDd = 0;
      let sumHold = 0;
      let sumMae = 0;

      for (const sym of symbols) {
        const candles = loadCandles(sym, tf);
        if (candles.length < 300) continue;

        const trades = simulateCross816Pullback4(candles, sym, v);
        totalTrades += trades.length;
        const wins = trades.filter((t) => t.pnlPct > 0).length;
        totalWins += wins;
        const coinPnl = trades.reduce((a, b) => a + b.pnlPct, 0);
        sumPnl += coinPnl;

        let eq = 100, peak = 100, maxDd = 0;
        for (const t of trades) {
          eq *= (1 + t.pnlPct / 100);
          if (eq > peak) peak = eq;
          const dd = ((peak - eq) / peak) * 100;
          if (dd > maxDd) maxDd = dd;
        }
        worstDd = Math.max(worstDd, maxDd);

        const avgPnl = trades.length > 0 ? (coinPnl / trades.length).toFixed(2) : "0.00";
        const avgHold = trades.length > 0 ? (trades.reduce((a, b) => a + b.holdingHours, 0) / trades.length).toFixed(1) : "0";
        const avgMae = trades.length > 0 ? (trades.reduce((a, b) => a + b.maxAdverseExcursionPct, 0) / trades.length).toFixed(2) : "0.00";

        if (trades.length > 0) {
          sumHold += Number(avgHold) * trades.length;
          sumMae += Number(avgMae) * trades.length;
        }

        results.push({
          Symbol: sym,
          Trades: trades.length,
          WinRate: trades.length > 0 ? `${((wins / trades.length) * 100).toFixed(1)}%` : "N/A",
          TotalPnL: `${coinPnl >= 0 ? "+" : ""}${coinPnl.toFixed(2)}%`,
          AvgTradePnL: `${Number(avgPnl) >= 0 ? "+" : ""}${avgPnl}%`,
          AvgHoldHours: `${avgHold}h`,
          AvgFloatingDD: `${avgMae}%`,
          MaxDrawdown: `-${maxDd.toFixed(1)}%`,
        });
      }

      console.table(results);
      const overallWinRate = totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(1) : "0.0";
      const avgCoinPnl = results.length > 0 ? (sumPnl / results.length).toFixed(2) : "0.00";
      const grandAvgHold = totalTrades > 0 ? (sumHold / totalTrades).toFixed(1) : "0";
      const grandAvgMae = totalTrades > 0 ? (sumMae / totalTrades).toFixed(2) : "0.00";

      console.log(`>> SUMMARY ${v.name}: Trades = ${totalTrades}, Win Rate = ${overallWinRate}%, Avg Coin PnL = ${avgCoinPnl}%, Worst MaxDD = -${worstDd.toFixed(1)}%, Avg Hold = ${grandAvgHold}h, Avg FloatDD = ${grandAvgMae}%`);
    }
  }

  // Sample trades inspection
  console.log("\n================================================================================");
  console.log("   SAMPLE TRADES: 8/16 CROSS + MA4 PULLBACK (BTCUSDT & SOLUSDT 1H)");
  console.log("================================================================================");

  for (const sampleSym of ["BTCUSDT", "SOLUSDT"]) {
    const candles = loadCandles(sampleSym, "1h");
    const trades = simulateCross816Pullback4(candles, sampleSym, {
      name: "V1",
      stopLossMode: "NONE",
      exitMode: "PURE_BULLISH_FAN",
    });

    console.log(`\nSample Trades for ${sampleSym} (1H): Total ${trades.length} trades`);
    const table = trades.slice(0, 10).map((t, idx) => ({
      "#": idx + 1,
      Entry: `${t.entryTime} ($${t.entryPrice.toFixed(2)})`,
      Exit: `${t.exitTime} ($${t.exitPrice.toFixed(2)})`,
      Reason: t.exitReason,
      Holding: `${t.holdingHours}h (${(t.holdingHours / 24).toFixed(1)}d)`,
      NetPnL: `${t.pnlPct >= 0 ? "+" : ""}${t.pnlPct.toFixed(2)}%`,
      FloatDD: `${t.maxAdverseExcursionPct.toFixed(2)}%`,
      ProfitPeak: `+${t.maxFavorableExcursionPct.toFixed(2)}%`,
    }));
    console.table(table);
  }
}

run().catch(console.error);
