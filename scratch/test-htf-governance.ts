import fs from "fs";
import path from "path";
import { Candle } from "../src/strategy/ma-fan/types.js";
import { calcEMA } from "../src/strategy/ma-fan/ribbon.js";
import { calcRSI, calcMACD } from "../src/strategy/ma-fan/exhaustion.js";

// Helper to load 5m and aggregate into arbitrary timeframe
function loadAndAggregate(symbol: string, targetMinutes: number): Candle[] {
  const cacheDir = path.resolve(process.cwd(), "data/cache/klines");
  const f5m = path.join(cacheDir, `${symbol}_5m.json`);
  if (!fs.existsSync(f5m)) return [];
  const raw = JSON.parse(fs.readFileSync(f5m, "utf8"));
  const candles5m: Candle[] = raw.candles || raw;

  const bucketSec = targetMinutes * 60;
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

type HtfFilterMode = 
  | "NONE" 
  | "COIN_1H_ABOVE_EMA200" 
  | "COIN_1H_ABOVE_EMA75" 
  | "COIN_1H_MACD_BULLISH" 
  | "COIN_1H_RSI_GT_40" 
  | "BTC_1H_ABOVE_EMA200" 
  | "BTC_4H_ABOVE_EMA75";

interface TestVariant {
  name: string;
  htfFilter: HtfFilterMode;
}

function simulateMultiTimeframe(
  candles15m: Candle[],
  candles1h: Candle[],
  candles4h: Candle[],
  btcCandles1h: Candle[],
  btcCandles4h: Candle[],
  sym: string,
  variant: TestVariant
): Trade[] {
  if (candles15m.length < 300 || candles1h.length < 200) return [];

  // 15m Indicators
  const closes15m = candles15m.map((c) => c.close);
  const ma4_15m = calcEMA(closes15m, 4);
  const ma8_15m = calcEMA(closes15m, 8);
  const ma16_15m = calcEMA(closes15m, 16);
  const ma25_15m = calcEMA(closes15m, 25);
  const ma75_15m = calcEMA(closes15m, 75);
  const ma200_15m = calcEMA(closes15m, 200);
  const rsi15m = calcRSI(candles15m, 14);
  const macd15m = calcMACD(candles15m, 12, 26, 9);

  // 1H Coin Indicators
  const closes1h = candles1h.map((c) => c.close);
  const ema75_1h = calcEMA(closes1h, 75);
  const ema200_1h = calcEMA(closes1h, 200);
  const rsi1h = calcRSI(candles1h, 14);
  const macd1h = calcMACD(candles1h, 12, 26, 9);

  // BTC Indicators
  const btcCloses1h = btcCandles1h.map((c) => c.close);
  const btcEma200_1h = calcEMA(btcCloses1h, 200);
  const btcCloses4h = btcCandles4h.map((c) => c.close);
  const btcEma75_4h = calcEMA(btcCloses4h, 75);

  // Fast HTF lookup helpers (binary search or pointer)
  let ptr1h = 0;
  let ptr4h = 0;
  let ptrBtc1h = 0;
  let ptrBtc4h = 0;

  const costPerSide = (0.075 + 0.01) / 100;

  const trades: Trade[] = [];
  let inPosition = false;
  let entryIdx = -1;
  let entryPrice = 0;
  let peakSinceEntry = 0;
  let troughSinceEntry = Infinity;

  let hadBottomFan = false;
  let bottomFanExpiry = 0;
  let waitingForPullback = false;
  let pullbackExpiry = 0;

  for (let i = 200; i < candles15m.length; i++) {
    const c15 = candles15m[i]!;
    const curTime = c15.time;

    // Advance 1h pointer to latest CLOSED 1h bar before curTime
    while (ptr1h + 1 < candles1h.length && candles1h[ptr1h + 1]!.time <= curTime) ptr1h++;
    while (ptrBtc1h + 1 < btcCandles1h.length && btcCandles1h[ptrBtc1h + 1]!.time <= curTime) ptrBtc1h++;
    while (ptrBtc4h + 1 < btcCandles4h.length && btcCandles4h[ptrBtc4h + 1]!.time <= curTime) ptrBtc4h++;

    const cur4 = ma4_15m[i]!;
    const cur8 = ma8_15m[i]!;
    const cur16 = ma16_15m[i]!;
    const cur25 = ma25_15m[i]!;
    const cur75 = ma75_15m[i]!;
    const cur200 = ma200_15m[i]!;

    const prev4 = ma4_15m[i - 1]!;
    const prev8 = ma8_15m[i - 1]!;
    const prev16 = ma16_15m[i - 1]!;

    // 1. Bottom Fan Detection (15m): 4 < 8 < 16 < 25 < 75 < 200
    const isBottomFan = cur4 < cur8 && cur8 < cur16 && cur16 < cur25 && cur25 < cur75 && cur75 < cur200;
    if (isBottomFan) {
      hadBottomFan = true;
      bottomFanExpiry = i + 20;
    }
    if (i > bottomFanExpiry && !waitingForPullback && !inPosition) {
      hadBottomFan = false;
    }

    // 2. Reversal Confirmation (MA8 cross MA16)
    const is8Cross16Up = prev8 <= prev16 && cur8 > cur16;
    if (hadBottomFan && is8Cross16Up && !inPosition && !waitingForPullback) {
      const rsiOk = rsi15m[i]! >= 35 && rsi15m[i]! > rsi15m[i - 1]!;
      const macdOk = macd15m.hist[i]! > macd15m.hist[i - 1]!;

      // ── EVALUATE HTF FILTER ──
      let htfFilterPassed = true;
      if (variant.htfFilter === "COIN_1H_ABOVE_EMA200") {
        htfFilterPassed = candles1h[ptr1h]!.close >= ema200_1h[ptr1h]!;
      } else if (variant.htfFilter === "COIN_1H_ABOVE_EMA75") {
        htfFilterPassed = candles1h[ptr1h]!.close >= ema75_1h[ptr1h]!;
      } else if (variant.htfFilter === "COIN_1H_MACD_BULLISH") {
        htfFilterPassed = macd1h.hist[ptr1h]! > 0 || macd1h.hist[ptr1h]! > (macd1h.hist[ptr1h - 1] ?? 0);
      } else if (variant.htfFilter === "COIN_1H_RSI_GT_40") {
        htfFilterPassed = rsi1h[ptr1h]! >= 40;
      } else if (variant.htfFilter === "BTC_1H_ABOVE_EMA200") {
        htfFilterPassed = btcCandles1h[ptrBtc1h]!.close >= btcEma200_1h[ptrBtc1h]!;
      } else if (variant.htfFilter === "BTC_4H_ABOVE_EMA75") {
        htfFilterPassed = btcCandles4h[ptrBtc4h]!.close >= btcEma75_4h[ptrBtc4h]!;
      }

      if (rsiOk && macdOk && htfFilterPassed) {
        waitingForPullback = true;
        pullbackExpiry = i + 12;
      }
    }

    if (i > pullbackExpiry && waitingForPullback && !inPosition) {
      waitingForPullback = false;
    }

    // 3. Pullback Entry at MA4
    if (waitingForPullback && !inPosition) {
      const touchedMa4 = c15.low <= cur4;
      const momentumStillBullish = cur8 >= cur16;

      if (touchedMa4 && momentumStillBullish) {
        inPosition = true;
        waitingForPullback = false;
        hadBottomFan = false;
        entryIdx = i;
        entryPrice = Math.min(c15.open, cur4) * 1.0001; // Limit fill at MA4
        peakSinceEntry = c15.high;
        troughSinceEntry = c15.low;
      }
    }

    // 4. Position Management & Exit
    if (inPosition) {
      peakSinceEntry = Math.max(peakSinceEntry, c15.high);
      troughSinceEntry = Math.min(troughSinceEntry, c15.low);

      // Exit: Full Bullish Fan (4 > 8 > 16 > 25 > 75 > 200)
      const isBullishFan = cur4 > cur8 && cur8 > cur16 && cur16 > cur25 && cur25 > cur75 && cur75 > cur200;

      if (isBullishFan) {
        const rawPnl = ((c15.close - entryPrice) / entryPrice) * 100;
        const netPnl = rawPnl - (costPerSide * 2 * 100);
        const holdingH = (c15.time - candles15m[entryIdx]!.time) / 3600;

        trades.push({
          symbol: sym,
          entryIdx,
          entryTime: new Date(candles15m[entryIdx]!.time * 1000).toISOString().replace("T", " ").slice(0, 16),
          entryPrice,
          exitIdx: i,
          exitTime: new Date(c15.time * 1000).toISOString().replace("T", " ").slice(0, 16),
          exitPrice: c15.close,
          pnlPct: netPnl,
          holdingHours: Number(holdingH.toFixed(1)),
          maxAdverseExcursionPct: Number((((troughSinceEntry - entryPrice) / entryPrice) * 100).toFixed(2)),
          maxFavorableExcursionPct: Number((((peakSinceEntry - entryPrice) / entryPrice) * 100).toFixed(2)),
          exitReason: "FULL_BULLISH_FAN",
        });

        inPosition = false;
        waitingForPullback = false;
        hadBottomFan = false;
        continue;
      }
    }
  }

  return trades;
}

async function run() {
  console.log("================================================================================");
  console.log("   MULTI-TIMEFRAME (HTF) GOVERNANCE BACKTEST FOR MA RAINBOW FAN");
  console.log("   LTF Execution: 15m (Setup: Bottom Fan -> 8/16 Cross -> Pullback at MA4)");
  console.log("   HTF Governed by: 1H / 4H Coin Structure & BTC Macro Regime");
  console.log("================================================================================\n");

  const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "SUIUSDT", "PEPEUSDT", "DOGEUSDT", "AVAXUSDT", "NEARUSDT"];

  // Pre-load BTC HTF candles
  const btc1h = loadAndAggregate("BTCUSDT", 60);
  const btc4h = loadAndAggregate("BTCUSDT", 240);

  const variants: TestVariant[] = [
    {
      name: "1. Baseline (No HTF Filter)",
      htfFilter: "NONE",
    },
    {
      name: "2. BTC 1H Macro Gate (BTC 1H Close >= EMA 200)",
      htfFilter: "BTC_1H_ABOVE_EMA200",
    },
    {
      name: "3. BTC 4H Macro Gate (BTC 4H Close >= EMA 75)",
      htfFilter: "BTC_4H_ABOVE_EMA75",
    },
    {
      name: "4. Coin 1H Trend Alignment (Coin 1H Close >= EMA 75)",
      htfFilter: "COIN_1H_ABOVE_EMA75",
    },
    {
      name: "5. Coin 1H Trend Alignment (Coin 1H Close >= EMA 200)",
      htfFilter: "COIN_1H_ABOVE_EMA200",
    },
    {
      name: "6. Coin 1H Momentum Gate (Coin 1H RSI >= 40)",
      htfFilter: "COIN_1H_RSI_GT_40",
    },
    {
      name: "7. Coin 1H MACD Deceleration (1H MACD Hist ticking up / > 0)",
      htfFilter: "COIN_1H_MACD_BULLISH",
    },
  ];

  const comparisonTable: any[] = [];

  for (const v of variants) {
    let totalTrades = 0;
    let totalWins = 0;
    let sumCoinPnl = 0;
    let worstMaxDd = 0;
    let sumHold = 0;
    let sumMae = 0;

    for (const sym of symbols) {
      const c15m = loadAndAggregate(sym, 15);
      const c1h = loadAndAggregate(sym, 60);
      const c4h = loadAndAggregate(sym, 240);

      const trades = simulateMultiTimeframe(c15m, c1h, c4h, btc1h, btc4h, sym, v);
      totalTrades += trades.length;
      const wins = trades.filter((t) => t.pnlPct > 0).length;
      totalWins += wins;

      const coinPnl = trades.reduce((a, b) => a + b.pnlPct, 0);
      sumCoinPnl += coinPnl;

      let eq = 100, peak = 100, maxDd = 0;
      for (const t of trades) {
        eq *= (1 + t.pnlPct / 100);
        if (eq > peak) peak = eq;
        const dd = ((peak - eq) / peak) * 100;
        if (dd > maxDd) maxDd = dd;
      }
      worstMaxDd = Math.max(worstMaxDd, maxDd);

      for (const t of trades) {
        sumHold += t.holdingHours;
        sumMae += t.maxAdverseExcursionPct;
      }
    }

    const avgPnl = (sumCoinPnl / symbols.length).toFixed(2);
    const winRate = totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(1) : "0.0";
    const avgHold = totalTrades > 0 ? (sumHold / totalTrades).toFixed(1) : "0";
    const avgMae = totalTrades > 0 ? (sumMae / totalTrades).toFixed(2) : "0.00";

    comparisonTable.push({
      "HTF Governance Strategy": v.name,
      "Total Trades": totalTrades,
      "Win Rate": `${winRate}%`,
      "Avg Coin PnL": `${Number(avgPnl) >= 0 ? "+" : ""}${avgPnl}%`,
      "Worst MaxDD": `-${worstMaxDd.toFixed(1)}%`,
      "Avg Floating DD (MAE)": `${avgMae}%`,
      "Avg Hold Time": `${avgHold}h`,
    });
  }

  console.table(comparisonTable);

  // Now let's inspect the best variant's detailed breakdown per symbol
  console.log("\n================================================================================");
  console.log("   DETAILED PER-SYMBOL BREAKDOWN: BTC 4H MACRO GATE vs BASELINE");
  console.log("================================================================================");

  for (const v of [variants[0]!, variants[2]!, variants[6]!]) {
    console.log(`\n--- Breakdown: ${v.name} ---`);
    const symBreakdown: any[] = [];
    for (const sym of symbols) {
      const c15m = loadAndAggregate(sym, 15);
      const c1h = loadAndAggregate(sym, 60);
      const c4h = loadAndAggregate(sym, 240);

      const trades = simulateMultiTimeframe(c15m, c1h, c4h, btc1h, btc4h, sym, v);
      const wins = trades.filter((t) => t.pnlPct > 0).length;
      const coinPnl = trades.reduce((a, b) => a + b.pnlPct, 0);

      let eq = 100, peak = 100, maxDd = 0;
      for (const t of trades) {
        eq *= (1 + t.pnlPct / 100);
        if (eq > peak) peak = eq;
        const dd = ((peak - eq) / peak) * 100;
        if (dd > maxDd) maxDd = dd;
      }

      symBreakdown.push({
        Symbol: sym,
        Trades: trades.length,
        WinRate: trades.length > 0 ? `${((wins / trades.length) * 100).toFixed(1)}%` : "N/A",
        NetPnL: `${coinPnl >= 0 ? "+" : ""}${coinPnl.toFixed(2)}%`,
        AvgTradePnL: trades.length > 0 ? `${(coinPnl / trades.length).toFixed(2)}%` : "0.00%",
        MaxDD: `-${maxDd.toFixed(1)}%`,
      });
    }
    console.table(symBreakdown);
  }
}

run().catch(console.error);
