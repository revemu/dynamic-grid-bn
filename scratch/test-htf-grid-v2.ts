import fs from "fs";
import path from "path";
import { Candle } from "../src/types.js";
import { calcEMA } from "../src/strategy/ma-fan/ribbon.js";
import { BacktestService } from "../src/backtest-service.js";

const CACHE_DIR = path.join(process.cwd(), "data", "cache", "klines");
const BLACKLIST = new Set([
  "BFUSDUSDT", "USDEUSDT", "RWUSDUSDT", "UUSDT", "??USDT",
  "GOOGLBUSDT", "INTCBUSDT", "MSTRBUSDT", "QQQBUSDT", "SKHYBUSDT",
  "SNDKBUSDT", "SOXLBUSDT", "SPCXBUSDT", "TQQQBUSDT", "CRCLBUSDT", "PAXGUSDT", "XAUTUSDT"
]);

function loadUniverse(minBars: number) {
  const files = fs.readdirSync(CACHE_DIR).filter((f) => f.endsWith("USDT_5m.json"));
  const universe: { symbol: string; candles: Candle[] }[] = [];
  let btcCandles: Candle[] = [];

  for (const file of files) {
    const symbol = file.replace("_5m.json", "");
    if (BLACKLIST.has(symbol)) continue;
    const parsed = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, file), "utf8"));
    const raw: Candle[] = Array.isArray(parsed) ? parsed : parsed.candles;
    if (!raw || raw.length < minBars) continue;

    if (symbol === "BTCUSDT") btcCandles = raw;
    universe.push({ symbol, candles: raw });
  }

  return { universe, btcCandles };
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

async function testHtfGrid(days: number) {
  const minBars = days * 288;
  const { universe, btcCandles } = loadUniverse(minBars);
  console.log(`\n========================================================================================`);
  console.log(` 🚀 TESTING HTF-GOVERNED DYNAMIC GRID ON ${days} DAYS (${universe.length} COINS)`);
  console.log(`========================================================================================`);

  const btc4h = resample(btcCandles, 14400);
  const btc4hEma75 = calcEMA(btc4h.map((c) => c.close), 75);
  const btc1d = resample(btcCandles, 86400);
  const btc1dEma25 = calcEMA(btc1d.map((c) => c.close), 25);

  interface Precalc {
    symbol: string;
    c5: Candle[];
    c1h: Candle[];
    c1hEma200: number[];
    c1hEma75: number[];
    c4h: Candle[];
    c4hEma75: number[];
  }

  const precalc: Precalc[] = [];
  for (const u of universe) {
    const c1h = resample(u.candles, 3600);
    const c4h = resample(u.candles, 14400);
    precalc.push({
      symbol: u.symbol,
      c5: u.candles,
      c1h,
      c1hEma200: calcEMA(c1h.map((c) => c.close), 200),
      c1hEma75: calcEMA(c1h.map((c) => c.close), 75),
      c4h,
      c4hEma75: calcEMA(c4h.map((c) => c.close), 75),
    });
  }

  // Check 4 different candidate selection criteria
  const scenarios = [
    {
      name: "A. Naive Grid Scanner (No HTF, Any Pos <= 0.88, No BTC Defense)",
      filter: (p: Precalc, t: number, posRatio: number, span: number) => posRatio <= 0.88 && span >= 4,
      useBtcDefense: false,
    },
    {
      name: "B. Bottom-Channel Only (Pos <= 0.30, Span 5-15%, No HTF)",
      filter: (p: Precalc, t: number, posRatio: number, span: number) => posRatio <= 0.30 && span >= 5 && span <= 15,
      useBtcDefense: false,
    },
    {
      name: "C. HTF 1H EMA200 + Bottom-Channel (Coin 1H > EMA200 + Pos <= 0.30)",
      filter: (p: Precalc, t: number, posRatio: number, span: number) => {
        const i1h = getClosedIdx(p.c1h, 3600, t);
        if (i1h < 200 || p.c1h[i1h].close < p.c1hEma200[i1h]) return false;
        return posRatio <= 0.30 && span >= 5 && span <= 15;
      },
      useBtcDefense: false,
    },
    {
      name: "D. Dual HTF: BTC 1D/4H Defense + Coin 1H > EMA200 + Pos <= 0.30",
      filter: (p: Precalc, t: number, posRatio: number, span: number) => {
        const i1h = getClosedIdx(p.c1h, 3600, t);
        if (i1h < 200 || p.c1h[i1h].close < p.c1hEma200[i1h]) return false;
        return posRatio <= 0.30 && span >= 5 && span <= 15;
      },
      useBtcDefense: true,
    },
  ];

  const summary = [];

  for (const sc of scenarios) {
    // Run Walk-Forward rotation test with 3 Slots
    const maxSlots = 3;
    const initialCapital = 100;
    let cash = initialCapital;

    interface ActiveSlot {
      symbol: string;
      entryTime: number;
      entryPrice: number;
      capital: number;
      qty: number;
      targetP: number;
      floorP: number;
    }
    let slots: ActiveSlot[] = [];
    const trades: { pnlPct: number; isWin: boolean; holdH: number }[] = [];
    let peakEq = initialCapital;
    let maxDd = 0;

    const startT = Math.max(...precalc.map((p) => p.c5[288 * 5]?.time ?? 0));
    const endT = Math.min(...precalc.map((p) => p.c5[p.c5.length - 1]?.time ?? Infinity));

    for (let t = startT; t <= endT; t += 3600) {
      // 1. Update active slots
      const surviving: ActiveSlot[] = [];
      for (const sl of slots) {
        const p = precalc.find((x) => x.symbol === sl.symbol)!;
        const c5Idx = p.c5.findIndex((c) => c.time >= t);
        if (c5Idx < 0) { surviving.push(sl); continue; }
        const curC = p.c5[c5Idx];

        let closed = false;
        let exitPrice = curC.close;
        if (curC.high >= sl.targetP) {
          closed = true;
          exitPrice = sl.targetP;
        } else if (curC.low <= sl.floorP * 0.96) { // 4% below floor = cut loss
          closed = true;
          exitPrice = sl.floorP * 0.96;
        }

        if (closed) {
          const proceeds = sl.qty * exitPrice * (1 - 0.00085);
          cash += proceeds;
          const pnlPct = ((proceeds - sl.capital) / sl.capital) * 100;
          trades.push({ pnlPct, isWin: pnlPct > 0, holdH: (t - sl.entryTime) / 3600 });
        } else {
          surviving.push(sl);
        }
      }
      slots = surviving;

      // 2. Check BTC Defense
      let btcDumping = false;
      if (sc.useBtcDefense) {
        const i4 = getClosedIdx(btc4h, 14400, t);
        const i1 = getClosedIdx(btc1d, 86400, t);
        btcDumping = (i4 >= 75 && btc4h[i4].close < btc4hEma75[i4]) || (i1 >= 25 && btc1d[i1].close < btc1dEma25[i1]);
      }

      // 3. Fill free slots
      const free = maxSlots - slots.length;
      if (free > 0 && !btcDumping) {
        const cands: { symbol: string; curPrice: number; targetP: number; floorP: number; score: number }[] = [];
        for (const p of precalc) {
          if (slots.some((s) => s.symbol === p.symbol)) continue;
          const idx = p.c5.findIndex((c) => c.time >= t);
          if (idx < 288) continue;
          const prev = idx - 1;

          // Donchian 48 bars on 15m (12h)
          let donH = -Infinity, donL = Infinity;
          for (let k = Math.max(0, prev - 144); k <= prev; k++) {
            if (p.c5[k].high > donH) donH = p.c5[k].high;
            if (p.c5[k].low < donL) donL = p.c5[k].low;
          }
          if (donL <= 0 || donH <= donL) continue;
          const span = ((donH - donL) / donL) * 100;
          const posRatio = (p.c5[prev].close - donL) / (donH - donL);

          if (sc.filter(p, t, posRatio, span)) {
            // Target is Center Line or High
            const targetP = (donH + donL) / 2 * 1.01;
            cands.push({
              symbol: p.symbol,
              curPrice: p.c5[idx].open,
              targetP: Math.max(p.c5[idx].open * 1.03, targetP),
              floorP: donL,
              score: (1 - posRatio) * 50 + span,
            });
          }
        }

        if (cands.length > 0) {
          cands.sort((a, b) => b.score - a.score);
          for (const ch of cands.slice(0, free)) {
            const currentFree = maxSlots - slots.length;
            const alloc = cash / currentFree;
            if (alloc < 1) continue;
            cash -= alloc;
            const qty = (alloc * (1 - 0.00085)) / ch.curPrice;
            slots.push({
              symbol: ch.symbol,
              entryTime: t,
              entryPrice: ch.curPrice,
              capital: alloc,
              qty,
              targetP: ch.targetP,
              floorP: ch.floorP,
            });
          }
        }
      }

      // Mark equity
      let curVal = cash;
      for (const sl of slots) {
        const p = precalc.find((x) => x.symbol === sl.symbol)!;
        const c5Idx = p.c5.findIndex((c) => c.time >= t);
        const px = c5Idx >= 0 ? p.c5[c5Idx].close : sl.entryPrice;
        curVal += sl.qty * px;
      }
      if (curVal > peakEq) peakEq = curVal;
      const dd = ((peakEq - curVal) / peakEq) * 100;
      if (dd > maxDd) maxDd = dd;
    }

    // Close remaining
    for (const sl of slots) {
      const p = precalc.find((x) => x.symbol === sl.symbol)!;
      const px = p.c5[p.c5.length - 1].close;
      const proceeds = sl.qty * px * (1 - 0.00085);
      cash += proceeds;
      const pnlPct = ((proceeds - sl.capital) / sl.capital) * 100;
      trades.push({ pnlPct, isWin: pnlPct > 0, holdH: (endT - sl.entryTime) / 3600 });
    }

    const netPnlPct = ((cash - initialCapital) / initialCapital) * 100;
    const wins = trades.filter((x) => x.isWin);
    const losses = trades.filter((x) => !x.isWin);
    const sumW = wins.reduce((s, x) => s + x.pnlPct, 0);
    const sumL = Math.abs(losses.reduce((s, x) => s + x.pnlPct, 0));
    const pf = sumL > 0 ? sumW / sumL : 99;

    summary.push({
      Scenario: sc.name,
      Trades: trades.length,
      WinRate: trades.length > 0 ? `${((wins.length / trades.length) * 100).toFixed(1)}%` : "0%",
      NetPnL: `${netPnlPct >= 0 ? "+" : ""}${netPnlPct.toFixed(2)}%`,
      MaxDD: `-${maxDd.toFixed(2)}%`,
      ProfitFactor: pf.toFixed(2),
    });
  }

  console.table(summary);
}

async function main() {
  await testHtfGrid(30);
  await testHtfGrid(120);
}

main().catch(console.error);
