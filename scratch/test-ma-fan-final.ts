import fs from "fs";
import path from "path";
import { Candle } from "../src/strategy/ma-fan/types.js";
import { calcEMA } from "../src/strategy/ma-fan/ribbon.js";
import { calcRSI, calcMACD } from "../src/strategy/ma-fan/exhaustion.js";

const cache: Record<string, Candle[]> = {};
function load(symbol: string, minutes: number): Candle[] {
  const key = `${symbol}_${minutes}`;
  if (cache[key]) return cache[key]!;
  const f = path.resolve(process.cwd(), "data/cache/klines", `${symbol}_5m.json`);
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

interface Variant {
  name: string;
  entry: "CROSS48_IMMEDIATE" | "CROSS816_PULLBACK4";
  coin1hAboveEma75?: boolean;
  coin1hRsi40?: boolean;
  btc4hAboveEma75?: boolean;
}
interface Trade { entryTime: number; pnl: number; mae: number; holdH: number; }

const btc4h = load("BTCUSDT", 240);
const btc4hEma75 = calcEMA(btc4h.map((c) => c.close), 75);

function sim(sym: string, v: Variant): Trade[] {
  const c15 = load(sym, 15);
  const c1h = load(sym, 60);
  const ema75_1h = calcEMA(c1h.map((c) => c.close), 75);
  const rsi1h = calcRSI(c1h, 14);
  const cl = c15.map((c) => c.close);
  const m4 = calcEMA(cl, 4), m8 = calcEMA(cl, 8), m16 = calcEMA(cl, 16);
  const m25 = calcEMA(cl, 25), m75 = calcEMA(cl, 75), m200 = calcEMA(cl, 200);
  const rsi = calcRSI(c15, 14);
  const macd = calcMACD(c15, 12, 26, 9);
  const cost = (0.075 + 0.01) / 100;
  const startTime = c15[0]!.time + 320 * 3600; // same warm-up window for all variants

  let p1 = 0, pb = 0;
  const trades: Trade[] = [];
  let inPos = false, eIdx = -1, ePrice = 0, trough = Infinity;
  let fan = false, fanExp = 0, waiting = false, waitExp = 0, waitFrom = 0;

  for (let i = 200; i < c15.length; i++) {
    const c = c15[i]!;
    if (c.time < startTime) continue;
    const closeT = c.time + 900; // decision made at close of this 15m bar
    // last fully CLOSED HTF bars at closeT
    while (p1 + 1 < c1h.length && c1h[p1 + 1]!.time + 3600 <= closeT) p1++;
    while (pb + 1 < btc4h.length && btc4h[pb + 1]!.time + 14400 <= closeT) pb++;

    const bottom = m4[i]! < m8[i]! && m8[i]! < m16[i]! && m16[i]! < m25[i]! && m25[i]! < m75[i]! && m75[i]! < m200[i]!;
    if (bottom) { fan = true; fanExp = i + 20; }
    if (i > fanExp && !waiting && !inPos) fan = false;

    const htfOk = () => {
      if (v.coin1hAboveEma75 && !(c1h[p1]!.close >= ema75_1h[p1]!)) return false;
      if (v.coin1hRsi40 && !(rsi1h[p1]! >= 40)) return false;
      if (v.btc4hAboveEma75 && !(btc4h[pb]!.close >= btc4hEma75[pb]!)) return false;
      return true;
    };

    if (inPos) {
      trough = Math.min(trough, c.low);
      const bull = m4[i]! > m8[i]! && m8[i]! > m16[i]! && m16[i]! > m25[i]! && m25[i]! > m75[i]! && m75[i]! > m200[i]!;
      if (bull) {
        trades.push({
          entryTime: c15[eIdx]!.time,
          pnl: ((c.close - ePrice) / ePrice) * 100 - cost * 200,
          mae: ((trough - ePrice) / ePrice) * 100,
          holdH: (c.time - c15[eIdx]!.time) / 3600,
        });
        inPos = false; fan = false; waiting = false;
        continue;
      }
    }

    if (!inPos && fan) {
      if (v.entry === "CROSS48_IMMEDIATE") {
        const cross = m4[i - 1]! <= m8[i - 1]! && m4[i]! > m8[i]!;
        if (cross && rsi[i]! >= 30 && rsi[i]! > rsi[i - 1]! && macd.hist[i]! > macd.hist[i - 1]! && htfOk()) {
          inPos = true; eIdx = i; ePrice = c.close * 1.0001; trough = c.low;
        }
      } else {
        // pullback entry: only on bars AFTER the signal bar
        if (waiting && i > waitFrom && i <= waitExp && c.low <= m4[i]! && m8[i]! >= m16[i]!) {
          inPos = true; waiting = false; eIdx = i;
          ePrice = Math.min(c.open, m4[i]!) * 1.0001; trough = c.low;
          continue;
        }
        if (waiting && i > waitExp) waiting = false;
        const cross = m8[i - 1]! <= m16[i - 1]! && m8[i]! > m16[i]!;
        if (!waiting && cross && rsi[i]! >= 35 && rsi[i]! > rsi[i - 1]! && macd.hist[i]! > macd.hist[i - 1]! && htfOk()) {
          waiting = true; waitFrom = i; waitExp = i + 12;
        }
      }
    }
  }
  return trades;
}

const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "SUIUSDT", "PEPEUSDT", "DOGEUSDT", "AVAXUSDT", "NEARUSDT"];
const variants: Variant[] = [
  { name: "A. 4x8 cross, immediate entry, no HTF", entry: "CROSS48_IMMEDIATE" },
  { name: "B. 8x16 cross + MA4 pullback, no HTF", entry: "CROSS816_PULLBACK4" },
  { name: "C. B + coin 1H close>=EMA75", entry: "CROSS816_PULLBACK4", coin1hAboveEma75: true },
  { name: "D. B + coin 1H RSI>=40", entry: "CROSS816_PULLBACK4", coin1hRsi40: true },
  { name: "E. B + BTC 4H close>=EMA75", entry: "CROSS816_PULLBACK4", btc4hAboveEma75: true },
  { name: "F. B + 1H RSI>=40 + BTC 4H", entry: "CROSS816_PULLBACK4", coin1hRsi40: true, btc4hAboveEma75: true },
  { name: "G. B + coin 1H>=EMA75 + BTC 4H", entry: "CROSS816_PULLBACK4", coin1hAboveEma75: true, btc4hAboveEma75: true },
];

const t0 = load("BTCUSDT", 15)[0]!.time + 320 * 3600;
const tEnd = load("BTCUSDT", 15).at(-1)!.time;
const mid = (t0 + tEnd) / 2;
console.log(`Window: ${new Date(t0 * 1000).toISOString().slice(0, 10)} -> ${new Date(tEnd * 1000).toISOString().slice(0, 10)} (${((tEnd - t0) / 86400).toFixed(0)} days), split at ${new Date(mid * 1000).toISOString().slice(0, 10)}`);

const rows: any[] = [];
for (const v of variants) {
  const all: Trade[] = [];
  let worstDd = 0;
  for (const s of symbols) {
    const t = sim(s, v);
    all.push(...t);
    let eq = 100, pk = 100;
    for (const x of t) { eq *= 1 + x.pnl / 100; pk = Math.max(pk, eq); worstDd = Math.max(worstDd, ((pk - eq) / pk) * 100); }
  }
  const stat = (arr: Trade[]) => ({
    n: arr.length,
    wr: arr.length ? (arr.filter((x) => x.pnl > 0).length / arr.length) * 100 : 0,
    avg: arr.length ? arr.reduce((a, b) => a + b.pnl, 0) / arr.length : 0,
  });
  const s = stat(all), h1 = stat(all.filter((x) => x.entryTime < mid)), h2 = stat(all.filter((x) => x.entryTime >= mid));
  const losers = all.filter((x) => x.pnl <= 0);
  rows.push({
    Variant: v.name,
    Trades: s.n,
    WinRate: `${s.wr.toFixed(1)}%`,
    "Avg/trade": `${s.avg.toFixed(2)}%`,
    "SumPnL/coin": `${(all.reduce((a, b) => a + b.pnl, 0) / symbols.length).toFixed(1)}%`,
    "Avg loss": losers.length ? `${(losers.reduce((a, b) => a + b.pnl, 0) / losers.length).toFixed(2)}%` : "-",
    "Avg MAE": `${(all.reduce((a, b) => a + b.mae, 0) / Math.max(1, all.length)).toFixed(2)}%`,
    "Avg hold": `${(all.reduce((a, b) => a + b.holdH, 0) / Math.max(1, all.length)).toFixed(0)}h`,
    WorstDD: `-${worstDd.toFixed(1)}%`,
    "H1 n/wr/avg": `${h1.n}/${h1.wr.toFixed(0)}%/${h1.avg.toFixed(2)}`,
    "H2 n/wr/avg": `${h2.n}/${h2.wr.toFixed(0)}%/${h2.avg.toFixed(2)}`,
  });
}
console.table(rows);
