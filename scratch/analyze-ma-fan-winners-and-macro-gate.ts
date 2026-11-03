import fs from "fs";
import path from "path";
import { Candle } from "../src/strategy/ma-fan/types.js";
import { calcEMA } from "../src/strategy/ma-fan/ribbon.js";
import { calcRSI, calcMACD } from "../src/strategy/ma-fan/exhaustion.js";

const BLACKLIST = new Set([
  "BFUSDUSDT", "USDEUSDT", "RWUSDUSDT", "UUSDT", "??USDT",
  "GOOGLBUSDT", "INTCBUSDT", "MSTRBUSDT", "QQQBUSDT", "SKHYBUSDT",
  "SNDKBUSDT", "SOXLBUSDT", "SPCXBUSDT", "TQQQBUSDT", "CRCLBUSDT", "PAXGUSDT", "XAUTUSDT"
]);

const cache: Record<string, Candle[]> = {};
function loadCandles(symbol: string, minutes: number): Candle[] {
  const key = `${symbol}_${minutes}`;
  if (cache[key]) return cache[key]!;
  const f = path.resolve(process.cwd(), "data/cache/klines", `${symbol}_5m.json`);
  if (!fs.existsSync(f)) return [];
  const raw = JSON.parse(fs.readFileSync(f, "utf8"));
  const c5: Candle[] = raw.candles || raw;
  const sec = minutes * 60;
  const out: Candle[] = [];
  let b = -1;
  let cur: Candle | null = null;
  for (const c of c5) {
    const bk = Math.floor(c.time / sec) * sec;
    if (bk !== b) {
      if (cur) out.push(cur);
      b = bk;
      cur = { ...c, time: bk, isClosed: true };
    } else if (cur) {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      cur.volume += c.volume;
    }
  }
  if (cur) out.push(cur);
  cache[key] = out;
  return out;
}

interface TradeSample {
  symbol: string;
  entryTime: number;
  exitTime: number;
  pnlPct: number;
  maePct: number;
  holdHours: number;
  // Strictly prior-bar features (idx - 1) at entry:
  marketBreadthPct: number;
  btcAboveSma24h: boolean;
  btcRet4hPct: number;
  btc4hAboveEma75: boolean;
  ema200Slope4hPct: number;      // 4h slope of 15m EMA200
  upperRibbonSpreadPct: number;  // (EMA200 - EMA75) / EMA200 * 100
  fanDropDepthPct: number;       // (EMA200 - bottomLow) / EMA200 * 100
  buyVolRatio12: number;         // UpVol / DnVol over prior 12 bars (3h)
  rsiReboundDelta: number;       // rsi[idx-1] - minRsiDuringFan
  minRsiDuringFan: number;
  coin1hRsi: number;
  relStrength24h: number;
}

async function main() {
  const cacheDir = path.resolve(process.cwd(), "data/cache/klines");
  const symbols = fs.readdirSync(cacheDir)
    .filter((f) => f.endsWith("USDT_5m.json"))
    .map((f) => f.replace("_5m.json", ""))
    .filter((s) => !BLACKLIST.has(s));

  const btc15 = loadCandles("BTCUSDT", 15);
  const btc4h = loadCandles("BTCUSDT", 240);
  const btc4hEma75 = calcEMA(btc4h.map((c) => c.close), 75);
  const btc15Ema20 = calcEMA(btc15.map((c) => c.close), 20);

  // Common 28-day window where all 60+ coins have complete 15m data + 200-bar warmup
  const endT = btc15.at(-1)!.time;
  const startT = endT - 28 * 86400;

  // Precompute 15m & 1h series for all symbols
  interface CoinSeries {
    symbol: string;
    c15: Candle[];
    c1h: Candle[];
    m4: number[];
    m8: number[];
    m16: number[];
    m25: number[];
    m75: number[];
    m200: number[];
    rsi15: number[];
    macd15: { hist: number[] };
    rsi1h: number[];
    timeMap: Map<number, number>;
  }

  const coins: CoinSeries[] = [];
  for (const sym of symbols) {
    const c15 = loadCandles(sym, 15);
    const c1h = loadCandles(sym, 60);
    if (c15.length < 500 || c1h.length < 100) continue;
    if (c15[0]!.time > startT - 200 * 900 || c15.at(-1)!.time < endT - 86400) continue;

    const cl = c15.map((c) => c.close);
    const tm = new Map<number, number>();
    for (let i = 0; i < c15.length; i++) tm.set(c15[i]!.time, i);

    coins.push({
      symbol: sym,
      c15,
      c1h,
      m4: calcEMA(cl, 4),
      m8: calcEMA(cl, 8),
      m16: calcEMA(cl, 16),
      m25: calcEMA(cl, 25),
      m75: calcEMA(cl, 75),
      m200: calcEMA(cl, 200),
      rsi15: calcRSI(c15, 14),
      macd15: calcMACD(c15, 12, 26, 9),
      rsi1h: calcRSI(c1h, 14),
      timeMap: tm,
    });
  }

  console.log(`Loaded ${coins.length} uniform USDT coins over 28 days (${new Date(startT * 1000).toISOString().slice(0, 10)} -> ${new Date(endT * 1000).toISOString().slice(0, 10)})`);

  // Precompute Point-in-Time Market Breadth (% of coins above 15m EMA20 = 5h EMA) and BTC Macro state at each 15m timestamp
  const breadthByTime = new Map<number, { breadthPct: number; btcAboveSma24h: boolean; btcRet4hPct: number; btcRet24hPct: number; btc4hAboveEma75: boolean }>();
  const btcTimeMap = new Map<number, number>();
  for (let i = 0; i < btc15.length; i++) btcTimeMap.set(btc15[i]!.time, i);

  let pb4h = 0;
  for (let t = startT - 3600; t <= endT; t += 900) {
    while (pb4h + 1 < btc4h.length && btc4h[pb4h + 1]!.time + 14400 <= t + 900) pb4h++;
    let above = 0, total = 0;
    for (const c of coins) {
      if (c.symbol === "BTCUSDT") continue;
      const idx = c.timeMap.get(t);
      if (idx !== undefined && idx >= 25) {
        total++;
        if (c.c15[idx]!.close > c.m25[idx]!) above++;
      }
    }
    const breadthPct = total > 0 ? (above / total) * 100 : 50;
    const bIdx = btcTimeMap.get(t) ?? 0;
    let sma96 = btc15[bIdx]!.close;
    if (bIdx >= 96) {
      let s = 0;
      for (let k = bIdx - 95; k <= bIdx; k++) s += btc15[k]!.close;
      sma96 = s / 96;
    }
    const btcClose = btc15[bIdx]!.close;
    const btcOpen4h = btc15[Math.max(0, bIdx - 16)]!.open;
    const btcOpen24h = btc15[Math.max(0, bIdx - 96)]!.open;
    const btcRet4hPct = ((btcClose - btcOpen4h) / btcOpen4h) * 100;
    const btcRet24hPct = ((btcClose - btcOpen24h) / btcOpen24h) * 100;

    breadthByTime.set(t, {
      breadthPct,
      btcAboveSma24h: btcClose >= sma96 * 0.990 && btcRet4hPct >= -1.0,
      btcRet4hPct,
      btcRet24hPct,
      btc4hAboveEma75: btc4h[pb4h]!.close >= btc4hEma75[pb4h]!,
    });
  }

  // Collect all candidate trades across all 60 coins (unfiltered by macro, so we can compare Winners vs Losers!)
  const costPerFill = (0.075 + 0.01) / 100;
  const allSamples: TradeSample[] = [];

  for (const coin of coins) {
    let inPos = false;
    let entryIdx = -1;
    let entryPrice = 0;
    let troughPrice = Infinity;
    let entryFeatures: Omit<TradeSample, "symbol" | "entryTime" | "exitTime" | "pnlPct" | "maePct" | "holdHours"> | null = null;

    let hadBottomFan = false;
    let fanExpiry = 0;
    let bottomLow = Infinity;
    let minRsiFan = 100;
    let waitingPullback = false;
    let waitFrom = 0;
    let waitExpiry = 0;
    let p1 = 0;

    for (let i = 200; i < coin.c15.length; i++) {
      const c = coin.c15[i]!;
      if (c.time < startT || c.time > endT) continue;
      const closeT = c.time + 900;
      while (p1 + 1 < coin.c1h.length && coin.c1h[p1 + 1]!.time + 3600 <= closeT) p1++;

      if (inPos) {
        troughPrice = Math.min(troughPrice, c.low);
        const isBullishFan =
          coin.m4[i]! > coin.m8[i]! &&
          coin.m8[i]! > coin.m16[i]! &&
          coin.m16[i]! > coin.m25[i]! &&
          coin.m25[i]! > coin.m75[i]! &&
          coin.m75[i]! > coin.m200[i]!;

        // Also force MTM at endT
        const isEnd = c.time >= endT - 900;
        if (isBullishFan || isEnd) {
          const rawPnl = ((c.close - entryPrice) / entryPrice) * 100;
          const netPnl = rawPnl - costPerFill * 200;
          const maePct = ((troughPrice - entryPrice) / entryPrice) * 100;
          const holdHours = (c.time - coin.c15[entryIdx]!.time) / 3600;

          allSamples.push({
            symbol: coin.symbol,
            entryTime: coin.c15[entryIdx]!.time,
            exitTime: c.time,
            pnlPct: netPnl,
            maePct,
            holdHours,
            ...entryFeatures!,
          });
          inPos = false;
          hadBottomFan = false;
          waitingPullback = false;
          bottomLow = Infinity;
          minRsiFan = 100;
          continue;
        }
      }

      // Check pullback fill using strictly prior bar (i - 1)
      if (!inPos && waitingPullback && i > waitFrom && i <= waitExpiry) {
        const limitP = coin.m4[i - 1]!;
        if (coin.m8[i - 1]! >= coin.m16[i - 1]! && c.low <= limitP * (1 - 0.001)) {
          inPos = true;
          waitingPullback = false;
          hadBottomFan = false;
          entryIdx = i;
          entryPrice = Math.min(c.open, limitP);
          troughPrice = Math.min(entryPrice, c.low);

          // Compute strictly prior-bar (i - 1) features!
          const prevIdx = i - 1;
          const macro = breadthByTime.get(coin.c15[prevIdx]!.time) ?? {
            breadthPct: 50, btcAboveSma24h: true, btcRet4hPct: 0, btcRet24hPct: 0, btc4hAboveEma75: true,
          };

          const ema200Now = coin.m200[prevIdx]!;
          const ema200Prev4h = coin.m200[Math.max(0, prevIdx - 16)]!;
          const ema200Slope4hPct = ((ema200Now - ema200Prev4h) / ema200Prev4h) * 100;
          const upperRibbonSpreadPct = ((ema200Now - coin.m75[prevIdx]!) / ema200Now) * 100;
          const fanDropDepthPct = ((ema200Now - bottomLow) / ema200Now) * 100;

          let upVol = 0, dnVol = 0;
          for (let k = Math.max(0, prevIdx - 11); k <= prevIdx; k++) {
            const bar = coin.c15[k]!;
            const qv = bar.volume * bar.close;
            if (bar.close >= bar.open) upVol += qv;
            else dnVol += qv;
          }
          const buyVolRatio12 = dnVol > 0 ? upVol / dnVol : 2.0;

          const closeNow = coin.c15[prevIdx]!.close;
          const open24h = coin.c15[Math.max(0, prevIdx - 96)]!.open;
          const coinRet24h = ((closeNow - open24h) / open24h) * 100;

          entryFeatures = {
            marketBreadthPct: macro.breadthPct,
            btcAboveSma24h: macro.btcAboveSma24h,
            btcRet4hPct: macro.btcRet4hPct,
            btc4hAboveEma75: macro.btc4hAboveEma75,
            ema200Slope4hPct,
            upperRibbonSpreadPct,
            fanDropDepthPct,
            buyVolRatio12,
            rsiReboundDelta: coin.rsi15[prevIdx]! - minRsiFan,
            minRsiDuringFan: minRsiFan,
            coin1hRsi: coin.rsi1h[p1]!,
            relStrength24h: coinRet24h - macro.btcRet24hPct,
          };
          continue;
        }
      }

      if (waitingPullback && (i >= waitExpiry || coin.m8[i]! < coin.m16[i]!)) {
        waitingPullback = false;
      }

      const isBottomFan =
        coin.m4[i]! < coin.m8[i]! &&
        coin.m8[i]! < coin.m16[i]! &&
        coin.m16[i]! < coin.m25[i]! &&
        coin.m25[i]! < coin.m75[i]! &&
        coin.m75[i]! < coin.m200[i]!;

      if (isBottomFan) {
        hadBottomFan = true;
        fanExpiry = i + 20;
        bottomLow = Math.min(bottomLow, c.low);
        minRsiFan = Math.min(minRsiFan, coin.rsi15[i]!);
      }
      if (i > fanExpiry && !waitingPullback && !inPos) {
        hadBottomFan = false;
        bottomLow = Infinity;
        minRsiFan = 100;
      }

      const is8Cross16Up = coin.m8[i - 1]! <= coin.m16[i - 1]! && coin.m8[i]! > coin.m16[i]!;
      if (!inPos && !waitingPullback && hadBottomFan && is8Cross16Up) {
        const rsiOk = coin.rsi15[i]! >= 35 && coin.rsi15[i]! > coin.rsi15[i - 1]!;
        const macdOk = coin.macd15.hist[i]! > coin.macd15.hist[i - 1]!;
        if (rsiOk && macdOk) {
          waitingPullback = true;
          waitFrom = i;
          waitExpiry = i + 12;
        }
      }
    }
  }

  const winners = allSamples.filter((s) => s.pnlPct > 0);
  const losers = allSamples.filter((s) => s.pnlPct <= 0);
  const bigWinners = allSamples.filter((s) => s.pnlPct >= 2.5);
  const bigLosers = allSamples.filter((s) => s.pnlPct <= -3.0);

  const avg = (arr: TradeSample[], fn: (x: TradeSample) => number) =>
    arr.length > 0 ? arr.reduce((a, b) => a + fn(b), 0) / arr.length : 0;

  console.log("\n================================================================================");
  console.log(`   FORENSIC FEATURE COMPARISON: WINNERS (${winners.length}) vs LOSERS (${losers.length})`);
  console.log("================================================================================");
  console.table([
    {
      Feature: "Market Breadth (% > 5h EMA)",
      "All Trades": `${avg(allSamples, (x) => x.marketBreadthPct).toFixed(1)}%`,
      "Winners (>0%)": `${avg(winners, (x) => x.marketBreadthPct).toFixed(1)}%`,
      "Losers (<=0%)": `${avg(losers, (x) => x.marketBreadthPct).toFixed(1)}%`,
      "Big Winners (>=+2.5%)": `${avg(bigWinners, (x) => x.marketBreadthPct).toFixed(1)}%`,
      "Big Losers (<=-3%)": `${avg(bigLosers, (x) => x.marketBreadthPct).toFixed(1)}%`,
    },
    {
      Feature: "15m EMA200 4h Slope (%)",
      "All Trades": `${avg(allSamples, (x) => x.ema200Slope4hPct).toFixed(2)}%`,
      "Winners (>0%)": `${avg(winners, (x) => x.ema200Slope4hPct).toFixed(2)}%`,
      "Losers (<=0%)": `${avg(losers, (x) => x.ema200Slope4hPct).toFixed(2)}%`,
      "Big Winners (>=+2.5%)": `${avg(bigWinners, (x) => x.ema200Slope4hPct).toFixed(2)}%`,
      "Big Losers (<=-3%)": `${avg(bigLosers, (x) => x.ema200Slope4hPct).toFixed(2)}%`,
    },
    {
      Feature: "Upper Ribbon Spread (EMA200-EMA75 %)",
      "All Trades": `${avg(allSamples, (x) => x.upperRibbonSpreadPct).toFixed(2)}%`,
      "Winners (>0%)": `${avg(winners, (x) => x.upperRibbonSpreadPct).toFixed(2)}%`,
      "Losers (<=0%)": `${avg(losers, (x) => x.upperRibbonSpreadPct).toFixed(2)}%`,
      "Big Winners (>=+2.5%)": `${avg(bigWinners, (x) => x.upperRibbonSpreadPct).toFixed(2)}%`,
      "Big Losers (<=-3%)": `${avg(bigLosers, (x) => x.upperRibbonSpreadPct).toFixed(2)}%`,
    },
    {
      Feature: "Bottom Fan Drop Depth (% below EMA200)",
      "All Trades": `${avg(allSamples, (x) => x.fanDropDepthPct).toFixed(2)}%`,
      "Winners (>0%)": `${avg(winners, (x) => x.fanDropDepthPct).toFixed(2)}%`,
      "Losers (<=0%)": `${avg(losers, (x) => x.fanDropDepthPct).toFixed(2)}%`,
      "Big Winners (>=+2.5%)": `${avg(bigWinners, (x) => x.fanDropDepthPct).toFixed(2)}%`,
      "Big Losers (<=-3%)": `${avg(bigLosers, (x) => x.fanDropDepthPct).toFixed(2)}%`,
    },
    {
      Feature: "Buyer Volume Ratio (UpVol / DnVol 3h)",
      "All Trades": avg(allSamples, (x) => x.buyVolRatio12).toFixed(2),
      "Winners (>0%)": avg(winners, (x) => x.buyVolRatio12).toFixed(2),
      "Losers (<=0%)": avg(losers, (x) => x.buyVolRatio12).toFixed(2),
      "Big Winners (>=+2.5%)": avg(bigWinners, (x) => x.buyVolRatio12).toFixed(2),
      "Big Losers (<=-3%)": avg(bigLosers, (x) => x.buyVolRatio12).toFixed(2),
    },
    {
      Feature: "Min RSI During Bottom Fan",
      "All Trades": avg(allSamples, (x) => x.minRsiDuringFan).toFixed(1),
      "Winners (>0%)": avg(winners, (x) => x.minRsiDuringFan).toFixed(1),
      "Losers (<=0%)": avg(losers, (x) => x.minRsiDuringFan).toFixed(1),
      "Big Winners (>=+2.5%)": avg(bigWinners, (x) => x.minRsiDuringFan).toFixed(1),
      "Big Losers (<=-3%)": avg(bigLosers, (x) => x.minRsiDuringFan).toFixed(1),
    },
    {
      Feature: "RSI Rebound Strength (+pts from low)",
      "All Trades": `+${avg(allSamples, (x) => x.rsiReboundDelta).toFixed(1)}`,
      "Winners (>0%)": `+${avg(winners, (x) => x.rsiReboundDelta).toFixed(1)}`,
      "Losers (<=0%)": `+${avg(losers, (x) => x.rsiReboundDelta).toFixed(1)}`,
      "Big Winners (>=+2.5%)": `+${avg(bigWinners, (x) => x.rsiReboundDelta).toFixed(1)}`,
      "Big Losers (<=-3%)": `+${avg(bigLosers, (x) => x.rsiReboundDelta).toFixed(1)}`,
    },
    {
      Feature: "Coin 1H RSI at Entry",
      "All Trades": avg(allSamples, (x) => x.coin1hRsi).toFixed(1),
      "Winners (>0%)": avg(winners, (x) => x.coin1hRsi).toFixed(1),
      "Losers (<=0%)": avg(losers, (x) => x.coin1hRsi).toFixed(1),
      "Big Winners (>=+2.5%)": avg(bigWinners, (x) => x.coin1hRsi).toFixed(1),
      "Big Losers (<=-3%)": avg(bigLosers, (x) => x.coin1hRsi).toFixed(1),
    },
    {
      Feature: "Relative Strength vs BTC (24h %)",
      "All Trades": `${avg(allSamples, (x) => x.relStrength24h).toFixed(2)}%`,
      "Winners (>0%)": `${avg(winners, (x) => x.relStrength24h).toFixed(2)}%`,
      "Losers (<=0%)": `${avg(losers, (x) => x.relStrength24h).toFixed(2)}%`,
      "Big Winners (>=+2.5%)": `${avg(bigWinners, (x) => x.relStrength24h).toFixed(2)}%`,
      "Big Losers (<=-3%)": `${avg(bigLosers, (x) => x.relStrength24h).toFixed(2)}%`,
    },
  ]);

  // Now evaluate single-feature & combined-feature filters on allSamples (split into H1 and H2 to check out-of-sample stability!)
  const midT = (startT + endT) / 2;
  const filters: Array<{ name: string; fn: (s: TradeSample) => boolean }> = [
    { name: "0. Unfiltered All Bottom Fans (8>16 + MA4 Pullback)", fn: () => true },
    { name: "1. + BTC 4H >= EMA75 only", fn: (s) => s.btc4hAboveEma75 },
    { name: "2. + Bot Macro Gate (Breadth >= 35% & BTC >= SMA24h)", fn: (s) => s.marketBreadthPct >= 35 && s.btcAboveSma24h },
    { name: "3. + Strong Breadth Gate (Breadth >= 50% & BTC >= SMA24h)", fn: (s) => s.marketBreadthPct >= 50 && s.btcAboveSma24h },
    { name: "4. + Shallow/Flat EMA200 Slope (ema200Slope >= -0.40%)", fn: (s) => s.ema200Slope4hPct >= -0.40 },
    { name: "5. + Tight Upper Ribbon (EMA200-EMA75 <= 1.2%)", fn: (s) => s.upperRibbonSpreadPct <= 1.2 },
    { name: "6. + Strong Buyer Absorption (UpVol/DnVol >= 1.3)", fn: (s) => s.buyVolRatio12 >= 1.3 },
    { name: "7. + Deep Climax Rebound (minRSI <= 28 & Rebound >= +12)", fn: (s) => s.minRsiDuringFan <= 28 && s.rsiReboundDelta >= 12 },
    { name: "8. + Relative Strength Leader (RelStrength24h >= -1.0%)", fn: (s) => s.relStrength24h >= -1.0 },
    {
      name: "9. COMBO A: Macro Gate (Breadth>=35%) + Flat EMA200 (>=-0.4%) + Buyers (>=1.2)",
      fn: (s) => s.marketBreadthPct >= 35 && s.btcAboveSma24h && s.ema200Slope4hPct >= -0.40 && s.buyVolRatio12 >= 1.2,
    },
    {
      name: "10. COMBO B: Macro Gate (Breadth>=45%) + Tight Upper Ribbon (<=1.2%) + RelStr (>=-1%)",
      fn: (s) => s.marketBreadthPct >= 45 && s.btcAboveSma24h && s.upperRibbonSpreadPct <= 1.2 && s.relStrength24h >= -1.0,
    },
  ];

  console.log("\n================================================================================");
  console.log("   FILTER DISCOVERY & OUT-OF-SAMPLE SPLIT (H1 vs H2) ACROSS 60 COINS");
  console.log("================================================================================");

  const filterRows = filters.map((f) => {
    const sub = allSamples.filter(f.fn);
    const wins = sub.filter((s) => s.pnlPct > 0);
    const losses = sub.filter((s) => s.pnlPct <= 0);
    const gw = wins.reduce((a, b) => a + b.pnlPct, 0);
    const gl = Math.abs(losses.reduce((a, b) => a + b.pnlPct, 0));
    const pf = gl > 0 ? gw / gl : gw > 0 ? 99 : 0;
    const h1 = sub.filter((s) => s.entryTime < midT);
    const h2 = sub.filter((s) => s.entryTime >= midT);
    const avgPnl = (arr: TradeSample[]) => (arr.length ? arr.reduce((a, b) => a + b.pnlPct, 0) / arr.length : 0);
    const wr = (arr: TradeSample[]) => (arr.length ? (arr.filter((x) => x.pnlPct > 0).length / arr.length) * 100 : 0);

    return {
      Filter: f.name,
      Trades: sub.length,
      WinRate: `${wr(sub).toFixed(1)}%`,
      AvgPnL: `${avgPnl(sub) >= 0 ? "+" : ""}${avgPnl(sub).toFixed(2)}%`,
      PF: pf.toFixed(2),
      AvgMAE: `${avg(sub, (x) => x.maePct).toFixed(2)}%`,
      "H1 (n / WR / Avg)": `${h1.length} / ${wr(h1).toFixed(0)}% / ${avgPnl(h1).toFixed(2)}%`,
      "H2 (n / WR / Avg)": `${h2.length} / ${wr(h2).toFixed(0)}% / ${avgPnl(h2).toFixed(2)}%`,
    };
  });
  console.table(filterRows);
}

main().catch(console.error);
