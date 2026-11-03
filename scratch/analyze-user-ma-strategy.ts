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

function runDetailedAnalysis(tf: "15m" | "1h") {
  const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "SUIUSDT", "PEPEUSDT", "DOGEUSDT", "AVAXUSDT", "NEARUSDT"];
  const allTrades: Trade[] = [];

  for (const sym of symbols) {
    const candles = loadCandles(sym, tf);
    if (candles.length < 300) continue;

    const closes = candles.map((c) => c.close);
    const ma4 = calcEMA(closes, 4);
    const ma8 = calcEMA(closes, 8);
    const ma16 = calcEMA(closes, 16);
    const ma25 = calcEMA(closes, 25);
    const ma75 = calcEMA(closes, 75);
    const ma200 = calcEMA(closes, 200);

    const rsi = calcRSI(candles, 14);
    const macdData = calcMACD(candles, 12, 26, 9);

    let inPosition = false;
    let entryIdx = -1;
    let entryPrice = 0;
    let hadBottomFanRecently = false;
    let bottomFanExpiry = 0;
    let peakSinceEntry = 0;
    let troughSinceEntry = Infinity;

    for (let i = 200; i < candles.length; i++) {
      const c = candles[i]!;
      const cur4 = ma4[i]!;
      const cur8 = ma8[i]!;
      const cur16 = ma16[i]!;
      const cur25 = ma25[i]!;
      const cur75 = ma75[i]!;
      const cur200 = ma200[i]!;

      const prev4 = ma4[i - 1]!;
      const prev8 = ma8[i - 1]!;

      // 1. Bottom Fan Climax: MA4 < MA8 < MA16 < MA25 < MA75 < MA200
      const isBottomFan = cur4 < cur8 && cur8 < cur16 && cur16 < cur25 && cur25 < cur75 && cur75 < cur200;
      if (isBottomFan) {
        hadBottomFanRecently = true;
        bottomFanExpiry = i + (tf === "15m" ? 12 : 6);
      }
      if (i > bottomFanExpiry && !inPosition) {
        hadBottomFanRecently = false;
      }

      // 2. Position Management
      if (inPosition) {
        peakSinceEntry = Math.max(peakSinceEntry, c.high);
        troughSinceEntry = Math.min(troughSinceEntry, c.low);

        // Exit: Full Bullish Fan (MA4 > MA8 > MA16 > MA25 > MA75 > MA200)
        const isBullishFan = cur4 > cur8 && cur8 > cur16 && cur16 > cur25 && cur25 > cur75 && cur75 > cur200;

        if (isBullishFan) {
          const cost = (0.075 + 0.01) * 2;
          const rawPnl = ((c.close - entryPrice) / entryPrice) * 100;
          const netPnl = rawPnl - cost;
          const holdingH = (c.time - candles[entryIdx]!.time) / 3600;

          allTrades.push({
            symbol: sym,
            entryIdx,
            entryTime: new Date(candles[entryIdx]!.time * 1000).toISOString().replace("T", " ").slice(0, 16),
            entryPrice,
            exitIdx: i,
            exitTime: new Date(c.time * 1000).toISOString().replace("T", " ").slice(0, 16),
            exitPrice: c.close,
            pnlPct: netPnl,
            holdingHours: Number(holdingH.toFixed(1)),
            maxAdverseExcursionPct: Number((((troughSinceEntry - entryPrice) / entryPrice) * 100).toFixed(2)),
            maxFavorableExcursionPct: Number((((peakSinceEntry - entryPrice) / entryPrice) * 100).toFixed(2)),
            exitReason: "FULL_BULLISH_FAN",
          });

          inPosition = false;
          hadBottomFanRecently = false;
          continue;
        }
      }

      // 3. Entry Trigger: Reversal + RSI bounce + MACD Histogram turn
      if (!inPosition && hadBottomFanRecently) {
        const maHook = prev4 <= prev8 && cur4 > cur8; // MA4 crosses above MA8
        const rsiOk = rsi[i]! >= 30 && rsi[i]! > rsi[i - 1]!;
        const macdOk = macdData.hist[i]! > macdData.hist[i - 1]!;

        if (maHook && rsiOk && macdOk) {
          inPosition = true;
          entryIdx = i;
          entryPrice = c.close * 1.0001; // slippage
          peakSinceEntry = c.high;
          troughSinceEntry = c.low;
        }
      }
    }
  }

  return allTrades;
}

console.log("\n================================================================================");
console.log("   DEEP-DIVE ANALYSIS: PURE MA-FAN STRATEGY (1H TIMEFRAME)");
console.log("================================================================================");

const trades1h = runDetailedAnalysis("1h");
console.log(`Total 1H Trades across 8 major coins: ${trades1h.length}`);

// Group by symbol
const bySym: Record<string, Trade[]> = {};
for (const t of trades1h) {
  if (!bySym[t.symbol]) bySym[t.symbol] = [];
  bySym[t.symbol]!.push(t);
}

const summaryTable = Object.entries(bySym).map(([sym, list]) => {
  const wins = list.filter((t) => t.pnlPct > 0).length;
  const totalPnl = list.reduce((a, b) => a + b.pnlPct, 0);
  const avgPnl = totalPnl / list.length;
  const avgHold = list.reduce((a, b) => a + b.holdingHours, 0) / list.length;
  const worstMae = Math.min(...list.map((t) => t.maxAdverseExcursionPct));
  const bestMfe = Math.max(...list.map((t) => t.maxFavorableExcursionPct));

  return {
    Symbol: sym,
    Trades: list.length,
    WinRate: `${((wins / list.length) * 100).toFixed(1)}%`,
    TotalPnL: `${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}%`,
    AvgPnL: `${avgPnl >= 0 ? "+" : ""}${avgPnl.toFixed(2)}%`,
    AvgHoldTime: `${avgHold.toFixed(1)} hrs`,
    WorstFloatingDrawdown: `${worstMae.toFixed(2)}%`,
    BestProfitPeak: `+${bestMfe.toFixed(2)}%`,
  };
});

console.table(summaryTable);

console.log("\n================================================================================");
console.log("   INDIVIDUAL TRADE SAMPLES ON 1H (Examining Float Drawdowns & Profit Peaks)");
console.log("================================================================================");

const sampleTable = trades1h.slice(0, 15).map((t, idx) => ({
  "#": idx + 1,
  Coin: t.symbol,
  Entry: `${t.entryTime} ($${t.entryPrice.toFixed(2)})`,
  Exit: `${t.exitTime} ($${t.exitPrice.toFixed(2)})`,
  Hold: `${t.holdingHours}h`,
  NetPnL: `${t.pnlPct >= 0 ? "+" : ""}${t.pnlPct.toFixed(2)}%`,
  FloatDD_MAE: `${t.maxAdverseExcursionPct.toFixed(2)}%`,
  PeakProfit_MFE: `+${t.maxFavorableExcursionPct.toFixed(2)}%`,
}));
console.table(sampleTable);
