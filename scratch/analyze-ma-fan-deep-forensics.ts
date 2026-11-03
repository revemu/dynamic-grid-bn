import fs from "fs";
import path from "path";
import { Candle } from "../src/types.js";
import { calcEMA } from "../src/strategy/ma-fan/ribbon.js";
import { calcRSI, calcMACD } from "../src/strategy/ma-fan/exhaustion.js";

const CACHE_DIR = path.join(process.cwd(), "data", "cache", "klines");
const BLACKLIST = new Set([
  "BFUSDUSDT", "USDEUSDT", "RWUSDUSDT", "UUSDT", "??USDT",
  "GOOGLBUSDT", "INTCBUSDT", "MSTRBUSDT", "QQQBUSDT", "SKHYBUSDT",
  "SNDKBUSDT", "SOXLBUSDT", "SPCXBUSDT", "TQQQBUSDT", "CRCLBUSDT", "PAXGUSDT", "XAUTUSDT"
]);
const COST_PCT = (0.075 + 0.01) * 2; // 0.17% round-trip

function resampleCandles(candles5m: Candle[], intervalMinutes: number): Candle[] {
  const bucketSec = intervalMinutes * 60;
  const out: Candle[] = [];
  let cur: Candle | null = null;
  for (const c of candles5m) {
    const bucketTime = Math.floor(c.time / bucketSec) * bucketSec;
    if (!cur || cur.time !== bucketTime) {
      if (cur) out.push(cur);
      cur = { time: bucketTime, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
    } else {
      if (c.high > cur.high) cur.high = c.high;
      if (c.low < cur.low) cur.low = c.low;
      cur.close = c.close;
      cur.volume += c.volume;
    }
  }
  if (cur) out.push(cur);
  return out;
}

interface CoinData {
  symbol: string;
  c15: Candle[];
  timeMap15: Map<number, number>;
  m4: number[];
  m8: number[];
  m16: number[];
  m25: number[];
  m75: number[];
  m200: number[];
  rsi15: number[];
  macdHist15: number[];
  c1h: Candle[];
  m25_1h: number[];
  m75_1h: number[];
  m200_1h: number[];
  rsi1h: number[];
}

function loadUniverse(min5mBars: number) {
  const files = fs.readdirSync(CACHE_DIR).filter((f) => f.endsWith("USDT_5m.json"));
  const coins: CoinData[] = [];

  for (const file of files) {
    const symbol = file.replace("_5m.json", "");
    if (BLACKLIST.has(symbol)) continue;
    const parsed = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, file), "utf8"));
    const raw: Candle[] = Array.isArray(parsed) ? parsed : parsed.candles;
    if (!raw || raw.length < min5mBars) continue;

    const c15 = resampleCandles(raw, 15);
    const closes15 = c15.map((c) => c.close);
    const timeMap15 = new Map<number, number>();
    c15.forEach((c, idx) => timeMap15.set(c.time, idx));

    const c1h = resampleCandles(raw, 60);
    const closes1h = c1h.map((c) => c.close);

    coins.push({
      symbol,
      c15,
      timeMap15,
      m4: calcEMA(closes15, 4),
      m8: calcEMA(closes15, 8),
      m16: calcEMA(closes15, 16),
      m25: calcEMA(closes15, 25),
      m75: calcEMA(closes15, 75),
      m200: calcEMA(closes15, 200),
      rsi15: calcRSI(c15, 14),
      macdHist15: calcMACD(c15).hist,
      c1h,
      m25_1h: calcEMA(closes1h, 25),
      m75_1h: calcEMA(closes1h, 75),
      m200_1h: calcEMA(closes1h, 200),
      rsi1h: calcRSI(c1h, 14),
    });
  }

  const startT = Math.max(...coins.map((c) => c.c15[220].time));
  const endT = Math.min(...coins.map((c) => c.c15[c.c15.length - 1].time));
  return { coins, startT, endT };
}

function getClosed1hIdx(c1h: Candle[], current15mTime: number): number {
  let lo = 0;
  let hi = c1h.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (c1h[mid].time + 3600 <= current15mTime) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

interface TradeRecord {
  symbol: string;
  entryTime: number;
  entryPrice: number;
  // Different exit outcomes on the EXACT same entry
  pnlNoSlFullFan: number;      // Hold until Full Bullish Fan (4>8>16>25>75>200), no SL
  pnlSl35FullFan: number;      // Hold until Full Bullish Fan, with -3.5% SL & 8<16 cut
  pnlHybridMaFan: number;      // TP1 (50%) at EMA75/EMA200 + Breakeven SL + TP2 (50%) at Full Bullish Fan
  pnlFastSwingMaFan: number;   // Hold until Close > EMA75 & RSI>65 or Close < EMA16 after touching EMA75, with Swing Low SL
  // Milestones reached before -3.5% SL
  reachedEma25InProfit: boolean;
  reachedEma75InProfit: boolean;
  reachedEma200InProfit: boolean;
  reachedFullBullFanBeforeSl: boolean;
  mfeBeforeSl: number;
  maeNoSl: number;
  // Strictly prior-bar (idx - 1) features
  buyVolRatio12: number;
  relStrengthVsBtc24h: number;
  upperRibbonSpreadPct: number; // (EMA200 - EMA75) / EMA200 * 100
  fanSpread25_200Pct: number;   // (EMA200 - EMA25) / EMA200 * 100
  roomToEma75Pct: number;
  roomToEma200Pct: number;
  ema200Slope4hPct: number;
  isHigherLowVsBottom: boolean;
  passingWaterfallGuard: boolean;
  isNoDeepBear1h: boolean;
  isHtfBull1h: boolean;
  breadth25Pct: number;
  breadth200Pct: number;
  btcAboveEma200_15m: boolean;
  btcRet4hPct: number;
  rsiReboundDelta: number;
  minRsiFan: number;
  swingRiskPct: number;         // Distance from entry to bottomLow (%)
}

function analyzeDataset(label: string, min5mBars: number) {
  const { coins, startT, endT } = loadUniverse(min5mBars);
  const btc = coins.find((c) => c.symbol === "BTCUSDT")!;
  const timeline = btc.c15.filter((c) => c.time >= startT && c.time <= endT).map((c) => c.time);
  const midT = timeline[Math.floor(timeline.length / 2)];

  console.log(`\n################################################################################`);
  console.log(`DATASET: ${label} | ${coins.length} coins | ${new Date(startT * 1000).toISOString().slice(0, 10)} -> ${new Date(endT * 1000).toISOString().slice(0, 10)} (${(timeline.length / 96).toFixed(1)} days)`);
  console.log(`################################################################################`);

  // Precompute Breadth & BTC Macro at idx - 1
  const macroMap = new Map<number, { b25: number; b200: number; btcBull15: boolean; btcRet4h: number; btcRet24h: number }>();
  for (const t of timeline) {
    let a25 = 0, a200 = 0, tot = 0;
    for (const c of coins) {
      if (c.symbol === "BTCUSDT") continue;
      const idx = c.timeMap15.get(t);
      if (idx !== undefined && idx > 200) {
        tot++;
        const prev = idx - 1;
        if (c.c15[prev].close > c.m25[prev]) a25++;
        if (c.c15[prev].close > c.m200[prev]) a200++;
      }
    }
    const bIdx = btc.timeMap15.get(t) ?? 200;
    const bPrev = bIdx - 1;
    const btcClose = btc.c15[bPrev].close;
    const btcBull15 = btcClose > btc.m200[bPrev];
    const btcRet4h = ((btcClose - btc.c15[Math.max(0, bPrev - 16)].open) / btc.c15[Math.max(0, bPrev - 16)].open) * 100;
    const btcRet24h = ((btcClose - btc.c15[Math.max(0, bPrev - 96)].open) / btc.c15[Math.max(0, bPrev - 96)].open) * 100;
    macroMap.set(t, {
      b25: tot > 0 ? (a25 / tot) * 100 : 50,
      b200: tot > 0 ? (a200 / tot) * 100 : 50,
      btcBull15,
      btcRet4h,
      btcRet24h,
    });
  }

  const trades: TradeRecord[] = [];

  for (const coin of coins) {
    let hadBottomFan = false;
    let fanExpiry = 0;
    let bottomLow = Infinity;
    let minRsiFan = 100;
    let waitingPullback = false;
    let waitFrom = 0;
    let waitExpiry = 0;
    let busyUntilIdx = -1;

    for (let i = 205; i < coin.c15.length; i++) {
      const c = coin.c15[i];
      if (c.time < startT || c.time > endT) continue;
      if (i <= busyUntilIdx) continue;

      if (waitingPullback && i > waitFrom && i <= waitExpiry) {
        const prev = i - 1;
        const limitP = coin.m4[prev];
        if (coin.m8[prev] >= coin.m16[prev] && c.low <= limitP * (1 - 0.001)) {
          const entryPrice = Math.min(c.open, limitP);
          waitingPullback = false;
          hadBottomFan = false;

          // Prior-bar features (strictly at `prev = i - 1`)
          const macro = macroMap.get(c.time)!;
          let upVol = 0, dnVol = 0, sumVol20 = 0, consecutiveReds = 0, countingReds = true;
          for (let k = prev; k >= Math.max(0, prev - 19); k--) {
            const bar = coin.c15[k];
            const qv = bar.volume * bar.close;
            sumVol20 += bar.volume;
            if (k >= prev - 11) {
              if (bar.close >= bar.open) upVol += qv;
              else dnVol += qv;
            }
          }
          for (let k = prev; k >= Math.max(0, prev - 8); k--) {
            if (countingReds && coin.c15[k].close < coin.c15[k].open) consecutiveReds++;
            else countingReds = false;
          }
          const buyVolRatio12 = dnVol > 0 ? upVol / dnVol : 2.0;
          const volRatio = (sumVol20 / 20) > 0 ? coin.c15[prev].volume / (sumVol20 / 20) : 1;
          const dropPct12 = ((coin.c15[prev - 12].close - coin.c15[prev].close) / coin.c15[prev - 12].close) * 100;

          const idx1h = getClosed1hIdx(coin.c1h, c.time);
          let isHtfBull1h = false;
          let isNoDeepBear1h = true;
          if (idx1h >= 10) {
            const c1hClose = coin.c1h[idx1h].close;
            const e200 = coin.m200_1h[idx1h];
            const e200Prev = coin.m200_1h[idx1h - 4];
            const slope1h = e200Prev > 0 ? ((e200 - e200Prev) / e200Prev) * 100 : 0;
            const dist1h = e200 > 0 ? ((c1hClose - e200) / e200) * 100 : 0;
            isHtfBull1h = c1hClose > e200 && slope1h >= -0.05;
            isNoDeepBear1h = !(dist1h < -2.0 && slope1h < -0.20);
          }

          const passingWaterfallGuard = consecutiveReds < 4 && volRatio < 2.5 && (isHtfBull1h || dropPct12 < 2.0);
          const coinRet24h = ((coin.c15[prev].close - coin.c15[Math.max(0, prev - 96)].open) / coin.c15[Math.max(0, prev - 96)].open) * 100;
          const relStrengthVsBtc24h = coinRet24h - macro.btcRet24h;

          const ema200Now = coin.m200[prev];
          const ema200Prev4h = coin.m200[Math.max(0, prev - 16)];
          const ema200Slope4hPct = ((ema200Now - ema200Prev4h) / ema200Prev4h) * 100;
          const upperRibbonSpreadPct = ((ema200Now - coin.m75[prev]) / ema200Now) * 100;
          const fanSpread25_200Pct = ((ema200Now - coin.m25[prev]) / ema200Now) * 100;
          const roomToEma75Pct = ((coin.m75[prev] - entryPrice) / entryPrice) * 100;
          const roomToEma200Pct = ((coin.m200[prev] - entryPrice) / entryPrice) * 100;

          const recent3Low = Math.min(coin.c15[prev].low, coin.c15[prev - 1].low, coin.c15[prev - 2].low);
          const isHigherLowVsBottom = recent3Low > bottomLow * 1.001;
          const swingRiskPct = Math.max(0.5, ((entryPrice - bottomLow) / entryPrice) * 100 + 0.25);

          // 1. Outcome A: Hold until Full Bullish Fan (no SL, same as winners/losers script)
          let pnlNoSlFullFan = 0;
          let maeNoSl = 0;
          let nextFreeIdx = i + 10;
          for (let j = i; j < coin.c15.length; j++) {
            const cj = coin.c15[j];
            if (cj.time > endT) break;
            const loPct = ((cj.low - entryPrice) / entryPrice) * 100;
            if (loPct < maeNoSl) maeNoSl = loPct;
            const isBullFan =
              coin.m4[j] > coin.m8[j] &&
              coin.m8[j] > coin.m16[j] &&
              coin.m16[j] > coin.m25[j] &&
              coin.m25[j] > coin.m75[j] &&
              coin.m75[j] > coin.m200[j];
            if (isBullFan || cj.time >= endT - 900) {
              pnlNoSlFullFan = ((cj.close - entryPrice) / entryPrice) * 100 - COST_PCT;
              nextFreeIdx = j;
              break;
            }
          }

          // 2. Outcome B: Hold for Full Bullish Fan with -3.5% SL & milestones tracking
          let pnlSl35FullFan = 0;
          let reachedEma25InProfit = false;
          let reachedEma75InProfit = false;
          let reachedEma200InProfit = false;
          let reachedFullBullFanBeforeSl = false;
          let mfeBeforeSl = 0;
          let armedBullFanB = false;

          for (let j = i; j < coin.c15.length; j++) {
            const cj = coin.c15[j];
            if (cj.time > endT) break;
            const hiPct = ((cj.high - entryPrice) / entryPrice) * 100;
            if (hiPct > mfeBeforeSl) mfeBeforeSl = hiPct;

            if (cj.high >= coin.m25[j] && cj.high > entryPrice * 1.003) reachedEma25InProfit = true;
            if (cj.high >= coin.m75[j] && cj.high > entryPrice * 1.004) reachedEma75InProfit = true;
            if (cj.high >= coin.m200[j] && cj.high > entryPrice * 1.005) reachedEma200InProfit = true;

            const isBullFan =
              coin.m4[j] > coin.m8[j] &&
              coin.m8[j] > coin.m16[j] &&
              coin.m16[j] > coin.m25[j] &&
              coin.m25[j] > coin.m75[j] &&
              coin.m75[j] > coin.m200[j];
            if (isBullFan) {
              reachedFullBullFanBeforeSl = true;
              armedBullFanB = true;
            }

            if (cj.low <= entryPrice * (1 - 0.035)) {
              pnlSl35FullFan = -3.5 - COST_PCT;
              break;
            }
            if (armedBullFanB && (cj.close < coin.m8[j] || coin.rsi15[j] > 74)) {
              pnlSl35FullFan = ((cj.close - entryPrice) / entryPrice) * 100 - COST_PCT;
              break;
            }
            if (cj.time >= endT - 900 || j >= i + 192) {
              pnlSl35FullFan = ((cj.close - entryPrice) / entryPrice) * 100 - COST_PCT;
              break;
            }
          }

          // 3. Outcome C: Hybrid Staged MA Fan (TP1 50% at EMA 75 / +1.2% min -> Breakeven + Ratchet SL -> TP2 50% at EMA200 / Full Bull Fan)
          let tp1Filled = false;
          let tp1Pnl = 0;
          let tp2Pnl = 0;
          const slPctC = Math.min(3.2, Math.max(1.0, swingRiskPct));
          let curSlC = entryPrice * (1 - slPctC / 100);
          let highestC = entryPrice;
          let armedBullC = false;

          for (let j = i; j < coin.c15.length; j++) {
            const cj = coin.c15[j];
            if (cj.time > endT) break;

            if (cj.low <= curSlC) {
              const slPnl = ((curSlC - entryPrice) / entryPrice) * 100 - COST_PCT;
              if (!tp1Filled) {
                tp1Pnl = slPnl;
                tp2Pnl = slPnl;
              } else {
                tp2Pnl = slPnl;
              }
              break;
            }

            const tp1Target = Math.max(coin.m75[j], entryPrice * 1.012);
            if (!tp1Filled && cj.high >= tp1Target) {
              tp1Filled = true;
              tp1Pnl = ((tp1Target - entryPrice) / entryPrice) * 100 - COST_PCT;
              curSlC = Math.max(curSlC, entryPrice * 1.002); // Lock Breakeven
              highestC = cj.high;
            }

            if (tp1Filled) {
              if (cj.high > highestC) highestC = cj.high;
              const isBullFan =
                coin.m4[j] > coin.m8[j] &&
                coin.m8[j] > coin.m16[j] &&
                coin.m16[j] > coin.m25[j] &&
                coin.m25[j] > coin.m75[j] &&
                coin.m75[j] > coin.m200[j];
              if (isBullFan) armedBullC = true;

              const hitBullExit = armedBullC && (cj.close < coin.m8[j] || coin.rsi15[j] > 74);
              const hit200Trail = highestC >= coin.m200[j] && highestC > entryPrice * 1.02 && cj.low <= highestC * 0.988;
              if (hitBullExit || hit200Trail) {
                const exPx = hit200Trail ? highestC * 0.988 : cj.close;
                tp2Pnl = ((exPx - entryPrice) / entryPrice) * 100 - COST_PCT;
                break;
              }
            }

            if (cj.time >= endT - 900 || j >= i + 192) {
              const endPnl = ((cj.close - entryPrice) / entryPrice) * 100 - COST_PCT;
              if (!tp1Filled) {
                tp1Pnl = endPnl;
                tp2Pnl = endPnl;
              } else {
                tp2Pnl = endPnl;
              }
              break;
            }
          }
          const pnlHybridMaFan = 0.5 * tp1Pnl + 0.5 * tp2Pnl;

          // 4. Outcome D: Mean Reversion / Swing to EMA75/EMA200 with Swing SL
          let pnlFastSwingMaFan = 0;
          let touched75D = false;
          const slPriceD = entryPrice * (1 - slPctC / 100);
          for (let j = i; j < coin.c15.length; j++) {
            const cj = coin.c15[j];
            if (cj.time > endT) break;
            if (cj.low <= slPriceD) {
              pnlFastSwingMaFan = -slPctC - COST_PCT;
              break;
            }
            if (cj.high >= Math.max(coin.m75[j], entryPrice * 1.012)) {
              touched75D = true;
            }
            if (touched75D && (cj.close < coin.m8[j] || cj.high >= coin.m200[j] || coin.rsi15[j] >= 68)) {
              const exPx = cj.high >= coin.m200[j] ? Math.max(cj.close, coin.m200[j]) : cj.close;
              pnlFastSwingMaFan = ((exPx - entryPrice) / entryPrice) * 100 - COST_PCT;
              break;
            }
            if (cj.time >= endT - 900 || j >= i + 96) {
              pnlFastSwingMaFan = ((cj.close - entryPrice) / entryPrice) * 100 - COST_PCT;
              break;
            }
          }

          trades.push({
            symbol: coin.symbol,
            entryTime: c.time,
            entryPrice,
            pnlNoSlFullFan,
            pnlSl35FullFan,
            pnlHybridMaFan,
            pnlFastSwingMaFan,
            reachedEma25InProfit,
            reachedEma75InProfit,
            reachedEma200InProfit,
            reachedFullBullFanBeforeSl,
            mfeBeforeSl,
            maeNoSl,
            buyVolRatio12,
            relStrengthVsBtc24h,
            upperRibbonSpreadPct,
            fanSpread25_200Pct,
            roomToEma75Pct,
            roomToEma200Pct,
            ema200Slope4hPct,
            isHigherLowVsBottom,
            passingWaterfallGuard,
            isNoDeepBear1h,
            isHtfBull1h,
            breadth25Pct: macro.b25,
            breadth200Pct: macro.b200,
            btcAboveEma200_15m: macro.btcBull15,
            btcRet4hPct: macro.btcRet4h,
            rsiReboundDelta: coin.rsi15[prev] - minRsiFan,
            minRsiFan,
            swingRiskPct,
          });

          busyUntilIdx = nextFreeIdx;
          bottomLow = Infinity;
          minRsiFan = 100;
          continue;
        }
      }

      if (waitingPullback && (i >= waitExpiry || coin.m8[i] < coin.m16[i])) {
        waitingPullback = false;
      }

      const isBottomFan =
        coin.m4[i] < coin.m8[i] &&
        coin.m8[i] < coin.m16[i] &&
        coin.m16[i] < coin.m25[i] &&
        coin.m25[i] < coin.m75[i] &&
        coin.m75[i] < coin.m200[i];

      if (isBottomFan) {
        hadBottomFan = true;
        fanExpiry = i + 20;
        bottomLow = Math.min(bottomLow, c.low);
        minRsiFan = Math.min(minRsiFan, coin.rsi15[i]);
      }
      if (i > fanExpiry && !waitingPullback) {
        hadBottomFan = false;
        bottomLow = Infinity;
        minRsiFan = 100;
      }

      const is8Cross16Up = coin.m8[i - 1] <= coin.m16[i - 1] && coin.m8[i] > coin.m16[i];
      if (!waitingPullback && hadBottomFan && is8Cross16Up) {
        const rsiOk = coin.rsi15[i] >= 35 && coin.rsi15[i] > coin.rsi15[i - 1];
        const macdOk = coin.macdHist15[i] > coin.macdHist15[i - 1];
        if (rsiOk && macdOk) {
          waitingPullback = true;
          waitFrom = i;
          waitExpiry = i + 12;
        }
      }
    }
  }

  const pct = (n: number, d: number) => ((n / Math.max(1, d)) * 100).toFixed(1) + "%";
  console.log(`\n--- A. MILESTONE REACHABILITY BEFORE -3.5% SL (Total Trades: ${trades.length}) ---`);
  console.log(`1. Reached EMA 25 in profit:          ${trades.filter((t) => t.reachedEma25InProfit).length}/${trades.length} (${pct(trades.filter((t) => t.reachedEma25InProfit).length, trades.length)})`);
  console.log(`2. Reached EMA 75 in profit:          ${trades.filter((t) => t.reachedEma75InProfit).length}/${trades.length} (${pct(trades.filter((t) => t.reachedEma75InProfit).length, trades.length)})`);
  console.log(`3. Reached EMA 200 in profit:         ${trades.filter((t) => t.reachedEma200InProfit).length}/${trades.length} (${pct(trades.filter((t) => t.reachedEma200InProfit).length, trades.length)})`);
  console.log(`4. Reached Full Bull Fan before SL:   ${trades.filter((t) => t.reachedFullBullFanBeforeSl).length}/${trades.length} (${pct(trades.filter((t) => t.reachedFullBullFanBeforeSl).length, trades.length)})`);

  // Compare features of trades that DO reach Full Bull Fan before SL vs those that don't!
  const trueBullReversals = trades.filter((t) => t.reachedFullBullFanBeforeSl && t.pnlSl35FullFan > 0);
  const failedReversals = trades.filter((t) => !t.reachedFullBullFanBeforeSl || t.pnlSl35FullFan <= 0);
  const avg = (arr: TradeRecord[], fn: (t: TradeRecord) => number) =>
    arr.length > 0 ? arr.reduce((s, x) => s + fn(x), 0) / arr.length : 0;

  console.log(`\n--- B. TRUE BULLISH FAN REVERSALS (N=${trueBullReversals.length}) vs FAILED REVERSALS (N=${failedReversals.length}) ---`);
  console.log(`Feature (strictly at bar idx-1)         | True Bull Fan Winners | Failed / Stopped Out`);
  console.log(`----------------------------------------+-----------------------+---------------------`);
  console.log(`Upper Ribbon Spread (EMA200-EMA75)%     | ${avg(trueBullReversals, (t) => t.upperRibbonSpreadPct).toFixed(2)}%                 | ${avg(failedReversals, (t) => t.upperRibbonSpreadPct).toFixed(2)}%`);
  console.log(`EMA200 4h Slope (%)                     | ${avg(trueBullReversals, (t) => t.ema200Slope4hPct).toFixed(2)}%                | ${avg(failedReversals, (t) => t.ema200Slope4hPct).toFixed(2)}%`);
  console.log(`Room to EMA200 (%)                      | ${avg(trueBullReversals, (t) => t.roomToEma200Pct).toFixed(2)}%                 | ${avg(failedReversals, (t) => t.roomToEma200Pct).toFixed(2)}%`);
  console.log(`Swing Risk to Bottom Low (%)            | ${avg(trueBullReversals, (t) => t.swingRiskPct).toFixed(2)}%                 | ${avg(failedReversals, (t) => t.swingRiskPct).toFixed(2)}%`);
  console.log(`Buyer Volume Ratio (Up/Dn 12 bars)      | ${avg(trueBullReversals, (t) => t.buyVolRatio12).toFixed(2)}x                 | ${avg(failedReversals, (t) => t.buyVolRatio12).toFixed(2)}x`);
  console.log(`Relative Strength vs BTC (24h %)        | ${avg(trueBullReversals, (t) => t.relStrengthVsBtc24h).toFixed(2)}%                | ${avg(failedReversals, (t) => t.relStrengthVsBtc24h).toFixed(2)}%`);
  console.log(`Market Breadth (% > EMA25)              | ${avg(trueBullReversals, (t) => t.breadth25Pct).toFixed(1)}%                 | ${avg(failedReversals, (t) => t.breadth25Pct).toFixed(1)}%`);
  console.log(`Market Breadth (% > EMA200)             | ${avg(trueBullReversals, (t) => t.breadth200Pct).toFixed(1)}%                 | ${avg(failedReversals, (t) => t.breadth200Pct).toFixed(1)}%`);

  // Test filters across the exit modes
  const filters: { name: string; fn: (t: TradeRecord) => boolean }[] = [
    { name: "0. Unfiltered (8>16 + RSI/MACD + MA4)", fn: () => true },
    { name: "1. Tight Upper Ribbon (EMA200-EMA75 <= 1.2%)", fn: (t) => t.upperRibbonSpreadPct <= 1.2 },
    { name: "2. Shallow EMA200 Slope (4h Slope >= -0.35%)", fn: (t) => t.ema200Slope4hPct >= -0.35 },
    { name: "3. Tight Swing Risk (BottomLow <= 2.2%)", fn: (t) => t.swingRiskPct <= 2.2 },
    { name: "4. Buyer Vol Absorption (Up/Dn >= 1.3x)", fn: (t) => t.buyVolRatio12 >= 1.3 },
    { name: "5. Rel Strength vs BTC (24h >= -1.0%)", fn: (t) => t.relStrengthVsBtc24h >= -1.0 },
    { name: "6. Macro Gate: Breadth25 >= 50% & BTC 4h >= -1%", fn: (t) => t.breadth25Pct >= 50 && t.btcRet4hPct >= -1.0 },
    { name: "7. Macro Gate: No Deep Bear 1H + Waterfall Guard", fn: (t) => t.isNoDeepBear1h && t.passingWaterfallGuard },
    {
      name: "8. ★ COMBO A: Tight Upper Ribbon (<=1.2%) + Vol>=1.25 + RelBTC>=-1%",
      fn: (t) => t.upperRibbonSpreadPct <= 1.2 && t.buyVolRatio12 >= 1.25 && t.relStrengthVsBtc24h >= -1.0,
    },
    {
      name: "9. ★ COMBO B: Slope>=-0.35% + SwingRisk<=2.2% + Vol>=1.25 + NoDeepBear",
      fn: (t) => t.ema200Slope4hPct >= -0.35 && t.swingRiskPct <= 2.2 && t.buyVolRatio12 >= 1.25 && t.isNoDeepBear1h,
    },
    {
      name: "10. ★ COMBO C: Macro(Breadth>=50%) + Vol>=1.3 + RelBTC>=-1% + NoDeepBear",
      fn: (t) => t.breadth25Pct >= 50 && t.buyVolRatio12 >= 1.3 && t.relStrengthVsBtc24h >= -1.0 && t.isNoDeepBear1h,
    },
  ];

  function stats(arr: TradeRecord[], sel: (t: TradeRecord) => number) {
    if (arr.length === 0) return "  0 |   0.0% |  +0.00% | 0.00";
    const vals = arr.map(sel);
    const w = vals.filter((v) => v > 0);
    const l = vals.filter((v) => v <= 0);
    const wr = (w.length / vals.length) * 100;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const pf = l.length > 0 ? w.reduce((a, b) => a + b, 0) / Math.abs(l.reduce((a, b) => a + b, 0)) : 99;
    return `${String(arr.length).padStart(3)} | ${wr.toFixed(1).padStart(5)}% | ${(mean >= 0 ? "+" : "") + mean.toFixed(2)}% | ${pf.toFixed(2)}`;
  }

  console.log(`\n--- C. FILTER COMPARISON ACROSS EXIT ARCHITECTURES ---`);
  console.log(
    `Filter`.padEnd(73) +
      ` | NoSL FullFan (N/WR/Avg/PF) | SL3.5% FullFan (N/WR/Avg/PF) | Hybrid TP1+TP2 (N/WR/Avg/PF)`
  );
  console.log("-".repeat(165));
  for (const f of filters) {
    const sub = trades.filter(f.fn);
    console.log(
      f.name.padEnd(73) +
        ` | ${stats(sub, (t) => t.pnlNoSlFullFan)} | ${stats(sub, (t) => t.pnlSl35FullFan)}   | ${stats(sub, (t) => t.pnlHybridMaFan)}`
    );
  }
}

analyzeDataset("UNIFORM 68 COINS (29.5 DAYS)", 9000);
analyzeDataset("CORE 19 COINS (124 DAYS)", 30000);
