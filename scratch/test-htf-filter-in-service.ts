import fs from "fs";
import path from "path";
import { Candle } from "../src/types.js";
import { calcEMA } from "../src/strategy/ma-fan/ribbon.js";

const CACHE_DIR = path.join(process.cwd(), "data", "cache", "klines");

function loadBtc(): Candle[] {
  const parsed = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, "BTCUSDT_5m.json"), "utf8"));
  return Array.isArray(parsed) ? parsed : parsed.candles;
}

function resample(candles5m: Candle[], sec: number): Candle[] {
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

function runExperiment() {
  const btcCandles = loadBtc();
  const btc4h = resample(btcCandles, 14400);
  const btc4hCloses = btc4h.map((c) => c.close);
  const btc4hEma75 = calcEMA(btc4hCloses, 75);
  const btc4hEma200 = calcEMA(btc4hCloses, 200);

  const btc1d = resample(btcCandles, 86400);
  const btc1dCloses = btc1d.map((c) => c.close);
  const btc1dEma25 = calcEMA(btc1dCloses, 25);

  const endT = btcCandles.at(-1)!.time;
  const splitT = endT - 33 * 86400;
  const startT = btcCandles[200].time;

  function measure(fromT: number, toT: number, label: string) {
    let tot = 0;
    let btc4h75 = 0;
    let btc4h200 = 0;
    let btc1d25 = 0;
    let dual4h75_1d25 = 0;

    for (let t = fromT; t <= toT; t += 900) {
      tot++;
      const idx4h = getClosedIdx(btc4h, 14400, t);
      const idx1d = getClosedIdx(btc1d, 86400, t);

      const pass4h75 = idx4h >= 75 && btc4h[idx4h].close >= btc4hEma75[idx4h];
      const pass4h200 = idx4h >= 200 && btc4h[idx4h].close >= btc4hEma200[idx4h];
      const pass1d25 = idx1d >= 25 && btc1d[idx1d].close >= btc1dEma25[idx1d];

      if (pass4h75) btc4h75++;
      if (pass4h200) btc4h200++;
      if (pass1d25) btc1d25++;
      if (pass4h75 && pass1d25) dual4h75_1d25++;
    }

    console.log(`\n--- ${label} (${tot} bars, ~${(tot * 15 / 1440).toFixed(1)} days) ---`);
    console.log(`BTC 4H >= EMA 75:  Active: ${((btc4h75 / tot) * 100).toFixed(1)}% | Sit Out: ${(100 - (btc4h75 / tot) * 100).toFixed(1)}%`);
    console.log(`BTC 4H >= EMA 200: Active: ${((btc4h200 / tot) * 100).toFixed(1)}% | Sit Out: ${(100 - (btc4h200 / tot) * 100).toFixed(1)}%`);
    console.log(`BTC 1D >= EMA 25:  Active: ${((btc1d25 / tot) * 100).toFixed(1)}% | Sit Out: ${(100 - (btc1d25 / tot) * 100).toFixed(1)}%`);
    console.log(`Dual (4H75 + 1D25): Active: ${((dual4h75_1d25 / tot) * 100).toFixed(1)}% | Sit Out: ${(100 - (dual4h75_1d25 / tot) * 100).toFixed(1)}%`);
  }

  measure(splitT, endT, "PAST 33 DAYS (DOWNTREND SLUMP, BTC -7.71%)");
  measure(startT, splitT, "EARLIER 89 DAYS (BULL + RANGING, BTC +33.5%)");
}

runExperiment();
