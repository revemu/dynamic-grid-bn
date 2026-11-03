import fs from "fs";
import path from "path";
import { Candle } from "../src/strategy/ma-fan/types.js";
import { calcEMA } from "../src/strategy/ma-fan/ribbon.js";
import { calcRSI, calcMACD, calcSMA } from "../src/strategy/ma-fan/exhaustion.js";

// Helper to load or aggregate candles
function loadCandles(symbol: string, targetTf: "5m" | "15m" | "1h"): Candle[] {
  const cacheDir = path.resolve(process.cwd(), "data/cache/klines");
  const f5m = path.join(cacheDir, `${symbol}_5m.json`);
  const f15m = path.join(cacheDir, `${symbol}_15m.json`);

  let candles5m: Candle[] = [];
  if (targetTf === "15m" && fs.existsSync(f15m)) {
    const raw = JSON.parse(fs.readFileSync(f15m, "utf8"));
    return raw.candles || raw;
  }
  if (fs.existsSync(f5m)) {
    const raw = JSON.parse(fs.readFileSync(f5m, "utf8"));
    candles5m = raw.candles || raw;
  }

  if (candles5m.length === 0) return [];

  if (targetTf === "5m") return candles5m;

  // Aggregate 5m into 15m or 1h
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
  entryIdx: number;
  entryTime: number;
  entryPrice: number;
  exitIdx: number;
  exitTime: number;
  exitPrice: number;
  exitReason: string;
  pnlPct: number;
  holdingBars: number;
  maxFavorableExcursionPct: number;
  maxAdverseExcursionPct: number;
}

interface StrategyConfig {
  maType: "EMA" | "SMA";
  reversalTrigger: "MA4_CROSS_MA8" | "MA4_HOOK_UP" | "CLOSE_ABOVE_MA4";
  rsiMinOversold: number; // e.g. RSI had to be < 35 during the bottom fan
  rsiTriggerLevel: number; // e.g. RSI crossing above 30 or 35
  requireMacdHistTurn: boolean; // MACD Histogram turning up
  stopLossMode: "NONE" | "SWING_LOW" | "PCT_STOP" | "ATR_STOP";
  stopLossPct?: number; // e.g. 3% or 5%
  exitMode: "PURE_BULLISH_FAN" | "BULLISH_FAN_OR_RSI_OVERBOUGHT";
  feePerSidePct: number;
  slippagePct: number;
}

function simulateStrategy(candles: Candle[], cfg: StrategyConfig) {
  if (candles.length < 250) return { trades: [], netPnlPct: 0, winRate: 0, profitFactor: 0, maxDrawdownPct: 0 };

  const closes = candles.map((c) => c.close);
  const costPerFill = (cfg.feePerSidePct + cfg.slippagePct) / 100;

  // Calculate MAs
  const calcMa = cfg.maType === "EMA" ? calcEMA : calcSMA;
  const ma4 = calcMa(closes, 4);
  const ma8 = calcMa(closes, 8);
  const ma16 = calcMa(closes, 16);
  const ma25 = calcMa(closes, 25);
  const ma75 = calcMa(closes, 75);
  const ma200 = calcMa(closes, 200);

  // Calculate RSI & MACD
  const rsi = calcRSI(candles, 14);
  const macdData = calcMACD(candles, 12, 26, 9);

  const trades: Trade[] = [];
  let inPosition = false;
  let entryIdx = -1;
  let entryPrice = 0;
  let stopLossPrice = 0;
  let bottomSwingLow = Infinity;
  let hadBottomFanRecently = false;
  let bottomFanExpiry = 0;
  let peakPriceSinceEntry = 0;
  let troughPriceSinceEntry = Infinity;

  // Loop through candles starting after warmup (200 bars)
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

    // 1. Detect Bottom Fan: MA4 < MA8 < MA16 < MA25 < MA75 < MA200 (all stacked downwards)
    const isBottomFan = cur4 < cur8 && cur8 < cur16 && cur16 < cur25 && cur25 < cur75 && cur75 < cur200;

    if (isBottomFan) {
      hadBottomFanRecently = true;
      bottomFanExpiry = i + 10; // Setup remains valid for 10 bars after fan is established
      bottomSwingLow = Math.min(bottomSwingLow, c.low, prevC.low);
    }

    if (i > bottomFanExpiry && !inPosition) {
      hadBottomFanRecently = false;
      bottomSwingLow = Infinity;
    }

    // 2. Position Management & Exit Evaluation
    if (inPosition) {
      peakPriceSinceEntry = Math.max(peakPriceSinceEntry, c.high);
      troughPriceSinceEntry = Math.min(troughPriceSinceEntry, c.low);

      let shouldExit = false;
      let exitReason = "";
      let exitPrice = c.close;

      // Check Stop Loss
      if (cfg.stopLossMode !== "NONE") {
        if (c.low <= stopLossPrice) {
          shouldExit = true;
          exitPrice = Math.min(c.open, stopLossPrice);
          exitReason = `SL (${cfg.stopLossMode})`;
        }
      }

      // Check Target Exit: "และจะขายเมื่อพัดกางออกจนสุด ทุกเส้นเหนือกว่าเส้น 200"
      // Full Bullish Fan: MA4 > MA8 > MA16 > MA25 > MA75 > MA200
      const isBullishFan = cur4 > cur8 && cur8 > cur16 && cur16 > cur25 && cur25 > cur75 && cur75 > cur200;

      if (!shouldExit && isBullishFan) {
        shouldExit = true;
        exitPrice = c.close;
        exitReason = "BULLISH_FAN_EXIT";
      }

      // Optional Momentum Take Profit: Bullish fan above 200 OR RSI Overbought > 70 + MA4 hooking down
      if (!shouldExit && cfg.exitMode === "BULLISH_FAN_OR_RSI_OVERBOUGHT") {
        if (cur4 > cur200 && cur8 > cur200 && rsi[i]! >= 70 && cur4 < prev4) {
          shouldExit = true;
          exitPrice = c.close;
          exitReason = "RSI_OB_HOOK_EXIT";
        }
      }

      if (shouldExit) {
        // Calculate PnL with fees & slippage
        const rawPnlPct = ((exitPrice - entryPrice) / entryPrice) * 100;
        const netPnlPct = rawPnlPct - (costPerFill * 2 * 100);

        const mfePct = ((peakPriceSinceEntry - entryPrice) / entryPrice) * 100;
        const maePct = ((troughPriceSinceEntry - entryPrice) / entryPrice) * 100;

        trades.push({
          entryIdx,
          entryTime: candles[entryIdx]!.time,
          entryPrice,
          exitIdx: i,
          exitTime: c.time,
          exitPrice,
          exitReason,
          pnlPct: netPnlPct,
          holdingBars: i - entryIdx,
          maxFavorableExcursionPct: mfePct,
          maxAdverseExcursionPct: maePct,
        });

        inPosition = false;
        hadBottomFanRecently = false;
        bottomSwingLow = Infinity;
        continue;
      }
    }

    // 3. Entry Evaluation:
    // Only enter if NOT currently in position, bottom fan was confirmed recently, and reversal triggers occur
    if (!inPosition && hadBottomFanRecently) {
      // Reversal trigger check:
      let isReversalTriggered = false;
      if (cfg.reversalTrigger === "MA4_CROSS_MA8") {
        isReversalTriggered = prev4 <= prev8 && cur4 > cur8;
      } else if (cfg.reversalTrigger === "MA4_HOOK_UP") {
        isReversalTriggered = cur4 > prev4 && prev4 <= ma4[i - 2]!;
      } else if (cfg.reversalTrigger === "CLOSE_ABOVE_MA4") {
        isReversalTriggered = prevC.close <= prev4 && c.close > cur4;
      }

      // RSI Confluence:
      const rsiVal = rsi[i]!;
      const prevRsiVal = rsi[i - 1]!;
      const rsiOk = rsiVal >= cfg.rsiTriggerLevel && (rsiVal > prevRsiVal || rsiVal >= 35);

      // MACD Confluence:
      const curHist = macdData.hist[i]!;
      const prevHist = macdData.hist[i - 1]!;
      const macdOk = !cfg.requireMacdHistTurn || (curHist > prevHist);

      if (isReversalTriggered && rsiOk && macdOk) {
        inPosition = true;
        entryIdx = i;
        entryPrice = c.close * (1 + cfg.slippagePct / 100);
        peakPriceSinceEntry = c.high;
        troughPriceSinceEntry = c.low;

        // Establish Stop Loss
        if (cfg.stopLossMode === "SWING_LOW") {
          stopLossPrice = Math.min(bottomSwingLow, c.low * 0.99);
        } else if (cfg.stopLossMode === "PCT_STOP") {
          stopLossPrice = entryPrice * (1 - (cfg.stopLossPct ?? 4) / 100);
        } else {
          stopLossPrice = 0;
        }
      }
    }
  }

  // Calculate metrics
  let equity = 100;
  let peakEquity = 100;
  let maxDd = 0;
  let grossWin = 0;
  let grossLoss = 0;
  let winCount = 0;

  for (const t of trades) {
    const tradePnlFactor = 1 + t.pnlPct / 100;
    equity *= tradePnlFactor;
    if (equity > peakEquity) peakEquity = equity;
    const curDd = ((peakEquity - equity) / peakEquity) * 100;
    if (curDd > maxDd) maxDd = curDd;

    if (t.pnlPct > 0) {
      winCount++;
      grossWin += t.pnlPct;
    } else {
      grossLoss += Math.abs(t.pnlPct);
    }
  }

  const netPnlPct = equity - 100;
  const winRate = trades.length > 0 ? (winCount / trades.length) * 100 : 0;
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : 0;

  return {
    trades,
    netPnlPct,
    winRate,
    profitFactor,
    maxDrawdownPct: maxDd,
  };
}

async function run() {
  console.log("================================================================================");
  console.log("   MA RAINBOW FAN STRATEGY RESEARCH & BACKTEST (MA 4, 8, 16, 25, 75, 200)");
  console.log("   Setup: Perfect Bottom Fan (MA4 < MA8 < MA16 < MA25 < MA75 < MA200)");
  console.log("   Entry Trigger: Reversal + RSI bounce + MACD Histogram tick up");
  console.log("   Exit Trigger: Full Bullish Fan (MA4 > MA8 > MA16 > MA25 > MA75 > MA200)");
  console.log("================================================================================\n");

  const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "SUIUSDT", "PEPEUSDT", "DOGEUSDT", "AVAXUSDT", "NEARUSDT"];
  const timeframes: Array<"15m" | "1h"> = ["15m", "1h"];

  for (const tf of timeframes) {
    console.log(`\n>>>>>>>>>>>>>>>>>> TIMEFRAME: ${tf.toUpperCase()} <<<<<<<<<<<<<<<<<<`);

    // We will test 4 key strategy variants:
    // Variant 1: Pure User Strategy (No SL, Wait strictly for Bullish Fan Exit)
    // Variant 2: User Strategy + Swing Low SL (Cut if bottom low breaks)
    // Variant 3: User Strategy + 4% Risk Stop Loss
    // Variant 4: User Strategy + Dual Exit (Bullish Fan OR RSI Overbought > 70 + Hook)

    const variants: Array<{ name: string; cfg: StrategyConfig }> = [
      {
        name: "1. Pure User Strategy (No SL, Bullish Fan Exit)",
        cfg: {
          maType: "EMA",
          reversalTrigger: "MA4_CROSS_MA8",
          rsiMinOversold: 35,
          rsiTriggerLevel: 30,
          requireMacdHistTurn: true,
          stopLossMode: "NONE",
          exitMode: "PURE_BULLISH_FAN",
          feePerSidePct: 0.075,
          slippagePct: 0.01,
        },
      },
      {
        name: "2. User Strategy + Swing Low Stop Loss",
        cfg: {
          maType: "EMA",
          reversalTrigger: "MA4_CROSS_MA8",
          rsiMinOversold: 35,
          rsiTriggerLevel: 30,
          requireMacdHistTurn: true,
          stopLossMode: "SWING_LOW",
          exitMode: "PURE_BULLISH_FAN",
          feePerSidePct: 0.075,
          slippagePct: 0.01,
        },
      },
      {
        name: "3. User Strategy + Fixed 4% Stop Loss",
        cfg: {
          maType: "EMA",
          reversalTrigger: "MA4_CROSS_MA8",
          rsiMinOversold: 35,
          rsiTriggerLevel: 30,
          requireMacdHistTurn: true,
          stopLossMode: "PCT_STOP",
          stopLossPct: 4.0,
          exitMode: "PURE_BULLISH_FAN",
          feePerSidePct: 0.075,
          slippagePct: 0.01,
        },
      },
      {
        name: "4. User Strategy + Momentum TP (Fan OR RSI>70 Peak)",
        cfg: {
          maType: "EMA",
          reversalTrigger: "MA4_CROSS_MA8",
          rsiMinOversold: 35,
          rsiTriggerLevel: 30,
          requireMacdHistTurn: true,
          stopLossMode: "SWING_LOW",
          exitMode: "BULLISH_FAN_OR_RSI_OVERBOUGHT",
          feePerSidePct: 0.075,
          slippagePct: 0.01,
        },
      },
      {
        name: "5. SMA Variant (SMA instead of EMA, Swing Low SL)",
        cfg: {
          maType: "SMA",
          reversalTrigger: "MA4_CROSS_MA8",
          rsiMinOversold: 35,
          rsiTriggerLevel: 30,
          requireMacdHistTurn: true,
          stopLossMode: "SWING_LOW",
          exitMode: "PURE_BULLISH_FAN",
          feePerSidePct: 0.075,
          slippagePct: 0.01,
        },
      },
    ];

    for (const v of variants) {
      console.log(`\n--- [Variant] ${v.name} ---`);
      const results: any[] = [];
      let totalTradesAll = 0;
      let totalWinsAll = 0;
      let sumPnlPct = 0;
      let maxDdAll = 0;

      for (const sym of symbols) {
        const candles = loadCandles(sym, tf);
        if (candles.length < 300) continue;

        const res = simulateStrategy(candles, v.cfg);
        totalTradesAll += res.trades.length;
        totalWinsAll += res.trades.filter((t) => t.pnlPct > 0).length;
        sumPnlPct += res.netPnlPct;
        maxDdAll = Math.max(maxDdAll, res.maxDrawdownPct);

        const avgPnl = res.trades.length > 0 ? (res.trades.reduce((a, b) => a + b.pnlPct, 0) / res.trades.length).toFixed(2) : "0.00";
        const avgHolding = res.trades.length > 0 ? (res.trades.reduce((a, b) => a + b.holdingBars, 0) / res.trades.length).toFixed(1) : "0";

        results.push({
          Symbol: sym,
          Bars: candles.length,
          Trades: res.trades.length,
          WinRate: `${res.winRate.toFixed(1)}%`,
          NetPnL: `${res.netPnlPct >= 0 ? "+" : ""}${res.netPnlPct.toFixed(2)}%`,
          ProfitFactor: res.profitFactor > 50 ? ">50" : res.profitFactor.toFixed(2),
          MaxDrawdown: `-${res.maxDrawdownPct.toFixed(1)}%`,
          AvgTradePnL: `${Number(avgPnl) >= 0 ? "+" : ""}${avgPnl}%`,
          AvgHoldingBars: avgHolding,
        });
      }

      console.table(results);
      const overallWinRate = totalTradesAll > 0 ? ((totalWinsAll / totalTradesAll) * 100).toFixed(1) : "0.0";
      const avgCoinPnl = results.length > 0 ? (sumPnlPct / results.length).toFixed(2) : "0.00";
      console.log(`>> SUMMARY ${v.name}: Total Trades = ${totalTradesAll}, Win Rate = ${overallWinRate}%, Avg Coin PnL = ${avgCoinPnl}%, Worst MaxDD = -${maxDdAll.toFixed(1)}%`);
    }
  }

  // Print Sample Trade Log from BTCUSDT & SOLUSDT to inspect how trades actually unfold
  console.log("\n================================================================================");
  console.log("   SAMPLE TRADE JOURNEY INSPECTION (BTCUSDT & SOLUSDT 15m)");
  console.log("================================================================================");

  for (const sampleSym of ["BTCUSDT", "SOLUSDT"]) {
    const candles = loadCandles(sampleSym, "15m");
    const res = simulateStrategy(candles, {
      maType: "EMA",
      reversalTrigger: "MA4_CROSS_MA8",
      rsiMinOversold: 35,
      rsiTriggerLevel: 30,
      requireMacdHistTurn: true,
      stopLossMode: "SWING_LOW",
      exitMode: "PURE_BULLISH_FAN",
      feePerSidePct: 0.075,
      slippagePct: 0.01,
    });

    console.log(`\nTrades for ${sampleSym} (15m): Total ${res.trades.length} trades`);
    const table = res.trades.slice(0, 8).map((t, idx) => ({
      "#": idx + 1,
      EntryTime: new Date(t.entryTime * 1000).toISOString().replace("T", " ").slice(0, 16),
      Entry: t.entryPrice.toFixed(2),
      ExitTime: new Date(t.exitTime * 1000).toISOString().replace("T", " ").slice(0, 16),
      Exit: t.exitPrice.toFixed(2),
      Reason: t.exitReason,
      Holding: `${t.holdingBars} bars (${(t.holdingBars * 15 / 60).toFixed(1)}h)`,
      PnL: `${t.pnlPct >= 0 ? "+" : ""}${t.pnlPct.toFixed(2)}%`,
      MFE: `+${t.maxFavorableExcursionPct.toFixed(2)}%`,
      MAE: `${t.maxAdverseExcursionPct.toFixed(2)}%`,
    }));
    console.table(table);
  }
}

run().catch(console.error);
