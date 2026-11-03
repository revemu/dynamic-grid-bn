import fs from "fs";
import path from "path";
import { Candle } from "../src/types.js";
import { calcEMA } from "../src/strategy/ma-fan/ribbon.js";
import { calcRSI } from "../src/strategy/ma-fan/exhaustion.js";

const CACHE_DIR = path.join(process.cwd(), "data", "cache", "klines");

function resample(candles5m: Candle[], min: number): Candle[] {
  const sec = min * 60;
  const out: Candle[] = [];
  let cur: Candle | null = null;
  for (const c of candles5m) {
    const bk = Math.floor(c.time / sec) * sec;
    if (!cur || cur.time !== bk) {
      if (cur) out.push(cur);
      cur = { time: bk, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
    } else {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      cur.volume += c.volume;
    }
  }
  if (cur) out.push(cur);
  return out;
}

const btcRaw = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, "BTCUSDT_5m.json"), "utf8"));
const btc5m: Candle[] = Array.isArray(btcRaw) ? btcRaw : btcRaw.candles;

const btc15m = resample(btc5m, 15);
const btc1h = resample(btc5m, 60);
const btc4h = resample(btc5m, 240);
const btc1d = resample(btc5m, 1440);

const btc15Closes = btc15m.map((c) => c.close);
const btc1hCloses = btc1h.map((c) => c.close);
const btc4hCloses = btc4h.map((c) => c.close);
const btc1dCloses = btc1d.map((c) => c.close);

const ema200_15m = calcEMA(btc15Closes, 200);
const ema75_1h = calcEMA(btc1hCloses, 75);
const ema200_1h = calcEMA(btc1hCloses, 200);
const ema25_4h = calcEMA(btc4hCloses, 25);
const ema75_4h = calcEMA(btc4hCloses, 75);
const ema200_4h = calcEMA(btc4hCloses, 200);
const ema25_1d = calcEMA(btc1dCloses, 25);
const ema75_1d = calcEMA(btc1dCloses, 75);

// Let's inspect the timeline for:
// Period 1: Recent 33 days (2026-10-01 to 2026-11-03)
// Period 2: Previous 90 days (2026-07-03 to 2026-10-01)
const endT = btc15m[btc15m.length - 1].time;
const splitT = endT - 33 * 86400;
const startT = btc15m[220].time;

console.log(`Analyzing BTC Macro Regimes:`);
console.log(`- Full Window: ${new Date(startT * 1000).toISOString().slice(0, 10)} -> ${new Date(endT * 1000).toISOString().slice(0, 10)}`);
console.log(`- Split Point (Recent 33d Downtrend): ${new Date(splitT * 1000).toISOString().slice(0, 10)}`);

// Load Market Breadth from all 68 coins
const files = fs.readdirSync(CACHE_DIR).filter((f) => f.endsWith("USDT_5m.json"));
interface Coin15m {
  symbol: string;
  c15: Candle[];
  timeMap: Map<number, number>;
  m25: number[];
  m200: number[];
}
const coins: Coin15m[] = [];
for (const file of files) {
  const symbol = file.replace("_5m.json", "");
  const p = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, file), "utf8"));
  const raw: Candle[] = Array.isArray(p) ? p : p.candles;
  if (!raw || raw.length < 9000) continue;
  const c15 = resample(raw, 15);
  const closes = c15.map((c) => c.close);
  const timeMap = new Map<number, number>();
  c15.forEach((c, idx) => timeMap.set(c.time, idx));
  coins.push({
    symbol,
    c15,
    timeMap,
    m25: calcEMA(closes, 25),
    m200: calcEMA(closes, 200),
  });
}

console.log(`Loaded ${coins.length} coins for Market Breadth.`);

// Let's test various Sit-Out Gate conditions bar-by-bar across 15m steps
interface GateDef {
  name: string;
  isAllowed: (t: number) => boolean;
}

const btc15TimeMap = new Map<number, number>();
btc15m.forEach((c, idx) => btc15TimeMap.set(c.time, idx));

function getClosedIdx(arr: Candle[], durationSec: number, targetSec: number) {
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].time + durationSec <= targetSec) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

const gates: GateDef[] = [
  {
    name: "0. Always Active (No Sit-Out)",
    isAllowed: () => true,
  },
  {
    name: "1. BTC 4H Trend: Close >= 4H EMA 75",
    isAllowed: (t) => {
      const idx = getClosedIdx(btc4h, 14400, t);
      if (idx < 75) return true;
      return btc4h[idx].close >= ema75_4h[idx];
    },
  },
  {
    name: "2. BTC 4H Trend: Close >= 4H EMA 25",
    isAllowed: (t) => {
      const idx = getClosedIdx(btc4h, 14400, t);
      if (idx < 25) return true;
      return btc4h[idx].close >= ema25_4h[idx];
    },
  },
  {
    name: "3. BTC 1D Trend: Close >= 1D EMA 25",
    isAllowed: (t) => {
      const idx = getClosedIdx(btc1d, 86400, t);
      if (idx < 25) return true;
      return btc1d[idx].close >= ema25_1d[idx];
    },
  },
  {
    name: "4. BTC 1H EMA 200: Close >= 1H EMA 200 & Slope >= 0",
    isAllowed: (t) => {
      const idx = getClosedIdx(btc1h, 3600, t);
      if (idx < 200) return true;
      const slope = ema200_1h[idx - 4] > 0 ? (ema200_1h[idx] - ema200_1h[idx - 4]) / ema200_1h[idx - 4] : 0;
      return btc1h[idx].close >= ema200_1h[idx] && slope >= 0;
    },
  },
  {
    name: "5. Market Breadth: >= 50% Coins > 15m EMA 25",
    isAllowed: (t) => {
      let a = 0, tot = 0;
      for (const c of coins) {
        if (c.symbol === "BTCUSDT") continue;
        const idx = c.timeMap.get(t);
        if (idx !== undefined && idx > 25) {
          tot++;
          if (c.c15[idx - 1].close > c.m25[idx - 1]) a++;
        }
      }
      return tot > 0 ? (a / tot) * 100 >= 50 : true;
    },
  },
  {
    name: "6. Market Breadth: >= 40% Coins > 15m EMA 200",
    isAllowed: (t) => {
      let a = 0, tot = 0;
      for (const c of coins) {
        if (c.symbol === "BTCUSDT") continue;
        const idx = c.timeMap.get(t);
        if (idx !== undefined && idx > 200) {
          tot++;
          if (c.c15[idx - 1].close > c.m200[idx - 1]) a++;
        }
      }
      return tot > 0 ? (a / tot) * 100 >= 40 : true;
    },
  },
  {
    name: "7. Dual Gate: BTC 4H Close >= EMA75 AND Breadth25 >= 45%",
    isAllowed: (t) => {
      const idx4h = getClosedIdx(btc4h, 14400, t);
      const btcOk = idx4h >= 75 ? btc4h[idx4h].close >= ema75_4h[idx4h] : true;
      let a = 0, tot = 0;
      for (const c of coins) {
        if (c.symbol === "BTCUSDT") continue;
        const idx = c.timeMap.get(t);
        if (idx !== undefined && idx > 25) {
          tot++;
          if (c.c15[idx - 1].close > c.m25[idx - 1]) a++;
        }
      }
      const breadthOk = tot > 0 ? (a / tot) * 100 >= 45 : true;
      return btcOk && breadthOk;
    },
  },
  {
    name: "8. Bull Trend Gate: BTC 1D >= EMA25 AND BTC 4H >= EMA75",
    isAllowed: (t) => {
      const idx1d = getClosedIdx(btc1d, 86400, t);
      const idx4h = getClosedIdx(btc4h, 14400, t);
      const dOk = idx1d >= 25 ? btc1d[idx1d].close >= ema25_1d[idx1d] : true;
      const hOk = idx4h >= 75 ? btc4h[idx4h].close >= ema75_4h[idx4h] : true;
      return dOk && hOk;
    },
  },
];

console.log("\n====================================================================================================");
console.log("SIT-OUT GATE PASSAGE ANALYSIS: Past 33 Days (Downtrend) vs Earlier 89 Days (Bull/Range)");
console.log("====================================================================================================");
console.log("Gate Name".padEnd(58) + " | Recent 33d Allowed % | Earlier 89d Allowed % | Sit-Out Efficiency");
console.log("-".repeat(110));

for (const g of gates) {
  let allowRecent = 0, totRecent = 0;
  let allowEarly = 0, totEarly = 0;

  for (let t = startT; t <= endT; t += 900) {
    if (t >= splitT) {
      totRecent++;
      if (g.isAllowed(t)) allowRecent++;
    } else {
      totEarly++;
      if (g.isAllowed(t)) allowEarly++;
    }
  }

  const pRecent = (allowRecent / totRecent) * 100;
  const pEarly = (allowEarly / totEarly) * 100;
  let verdict = "Neutral";
  if (pRecent <= 25 && pEarly >= 70) verdict = "🔥 EXCELLENT (Sits out 75%+ in drop, active 70%+ in bull)";
  else if (pRecent <= 40 && pEarly >= 60) verdict = "✅ GOOD (Sits out 60%+ in drop)";
  else if (pRecent >= 60) verdict = "❌ POOR (Still trades 60%+ in drop)";

  console.log(
    g.name.padEnd(58) +
      ` | ${pRecent.toFixed(1).padStart(5)}% (${String(allowRecent).padStart(4)}/${totRecent})` +
      ` | ${pEarly.toFixed(1).padStart(5)}% (${String(allowEarly).padStart(4)}/${totEarly})` +
      ` | ${verdict}`
  );
}
