import fs from "fs";
import path from "path";
import { Candle } from "../src/types.js";
import { calcEMA } from "../src/strategy/ma-fan/ribbon.js";
import { calcRSI } from "../src/strategy/ma-fan/exhaustion.js";

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

interface GridTestOptions {
  label: string;
  useHtf1hEma75?: boolean;
  useHtf4hEma75?: boolean;
  useBtcMacroDefense?: boolean;
  maxChannelPos?: number; // e.g. 0.35 (bottom 35% of channel)
  minSpanPct?: number;    // e.g. 4.0%
  maxSpanPct?: number;    // e.g. 10.0%
  maxSlots?: number;      // 1 (Sequential) or 3 (Multi-Slot)
  gridCutLossPct?: number; // e.g. 5.0%
  gridTakeProfitPct?: number; // e.g. 3.5%
}

function runGridSimulationSuite(
  universe: { symbol: string; candles: Candle[] }[],
  btcCandles: Candle[],
  opts: GridTestOptions
) {
  const costPerFill = 0.00085; // 0.075% fee + 0.01% slippage
  const maxSlots = opts.maxSlots ?? 1;
  const initialCapital = 100;
  let cash = initialCapital;

  // Precompute 15m, 1H, 4H for all coins
  interface Precalc {
    symbol: string;
    c15: Candle[];
    timeMap15: Map<number, number>;
    c1h: Candle[];
    c1hEma75: number[];
    c1hRsi: number[];
    c4h: Candle[];
    c4hEma75: number[];
  }

  const precalc: Precalc[] = [];
  for (const u of universe) {
    if (u.candles.length < 500) continue;
    const c15 = resample(u.candles, 900);
    if (c15.length < 220) continue;
    const timeMap15 = new Map<number, number>();
    c15.forEach((c, idx) => timeMap15.set(c.time, idx));

    const c1h = resample(u.candles, 3600);
    const c1hCloses = c1h.map((c) => c.close);
    const c1hEma75 = calcEMA(c1hCloses, 75);
    const c1hRsi = calcRSI(c1h, 14);

    const c4h = resample(u.candles, 14400);
    const c4hCloses = c4h.map((c) => c.close);
    const c4hEma75 = calcEMA(c4hCloses, 75);

    precalc.push({
      symbol: u.symbol,
      c15,
      timeMap15,
      c1h,
      c1hEma75,
      c1hRsi,
      c4h,
      c4hEma75,
    });
  }

  // BTC Macro Precalc
  const btc4h = resample(btcCandles, 14400);
  const btc4hEma75 = calcEMA(btc4h.map((c) => c.close), 75);
  const btc1d = resample(btcCandles, 86400);
  const btc1dEma25 = calcEMA(btc1d.map((c) => c.close), 25);

  const startT = Math.max(...precalc.map((c) => c.c15[220]?.time ?? 0));
  const endT = Math.min(...precalc.map((c) => c.c15[c.c15.length - 1]?.time ?? Infinity));

  interface ActiveGridPos {
    symbol: string;
    entryTime: number;
    entryPrice: number;
    allocatedCapital: number;
    qty: number;
    tpPrice: number;
    slPrice: number;
    lastPrice: number;
  }

  let activePositions: ActiveGridPos[] = [];
  const completedTrades: {
    symbol: string;
    holdHours: number;
    pnlPct: number;
    isWin: boolean;
    reason: string;
  }[] = [];

  let peakEquity = initialCapital;
  let maxDdPct = 0;

  for (let t = startT; t <= endT; t += 900) {
    // 1. Update active positions
    const surviving: ActiveGridPos[] = [];
    for (const pos of activePositions) {
      const coin = precalc.find((c) => c.symbol === pos.symbol)!;
      const idx = coin.timeMap15.get(t);
      if (idx === undefined) {
        surviving.push(pos);
        continue;
      }
      const c = coin.c15[idx];
      pos.lastPrice = c.close;

      let exitPrice = 0;
      let exitReason = "";
      if (c.high >= pos.tpPrice) {
        exitPrice = pos.tpPrice;
        exitReason = "GRID_TP";
      } else if (c.low <= pos.slPrice) {
        exitPrice = pos.slPrice;
        exitReason = "GRID_SL";
      }

      if (exitPrice > 0) {
        const proceeds = pos.qty * exitPrice * (1 - costPerFill);
        cash += proceeds;
        const netPnlPct = ((proceeds - pos.allocatedCapital) / pos.allocatedCapital) * 100;
        completedTrades.push({
          symbol: pos.symbol,
          holdHours: (t - pos.entryTime) / 3600,
          pnlPct: netPnlPct,
          isWin: netPnlPct > 0,
          reason: exitReason,
        });
      } else {
        surviving.push(pos);
      }
    }
    activePositions = surviving;

    // 2. Check BTC Macro Defense (if enabled)
    let isBtcDowntrend = false;
    if (opts.useBtcMacroDefense) {
      const idx4h = getClosedIdx(btc4h, 14400, t);
      const idx1d = getClosedIdx(btc1d, 86400, t);
      const pass4h = idx4h >= 75 ? btc4h[idx4h].close >= btc4hEma75[idx4h] : true;
      const pass1d = idx1d >= 25 ? btc1d[idx1d].close >= btc1dEma25[idx1d] : true;
      isBtcDowntrend = !pass4h || !pass1d;
    }

    // 3. Scan candidate coins for Grid Entry
    const freeSlots = maxSlots - activePositions.length;
    if (freeSlots > 0 && !isBtcDowntrend) {
      interface Candidate {
        symbol: string;
        price: number;
        tpPrice: number;
        slPrice: number;
        score: number;
      }
      const candidates: Candidate[] = [];

      for (const coin of precalc) {
        if (activePositions.some((p) => p.symbol === coin.symbol)) continue;
        const idx = coin.timeMap15.get(t);
        if (idx === undefined || idx < 96) continue;
        const prev = idx - 1;

        // HTF Checks (strictly closed bars)
        if (opts.useHtf1hEma75) {
          const idx1h = getClosedIdx(coin.c1h, 3600, t);
          if (idx1h < 75 || coin.c1h[idx1h].close < coin.c1hEma75[idx1h]) continue;
        }

        if (opts.useHtf4hEma75) {
          const idx4h = getClosedIdx(coin.c4h, 14400, t);
          if (idx4h < 75 || coin.c4h[idx4h].close < coin.c4hEma75[idx4h]) continue;
        }

        // LTF 15m Donchian Channel (last 48 bars = 12 hours)
        let donHigh = -Infinity, donLow = Infinity;
        for (let k = Math.max(0, prev - 47); k <= prev; k++) {
          if (coin.c15[k].high > donHigh) donHigh = coin.c15[k].high;
          if (coin.c15[k].low < donLow) donLow = coin.c15[k].low;
        }
        if (donLow <= 0 || donHigh <= donLow) continue;

        const spanPct = ((donHigh - donLow) / donLow) * 100;
        const minSpan = opts.minSpanPct ?? 4.0;
        const maxSpan = opts.maxSpanPct ?? 12.0;
        if (spanPct < minSpan || spanPct > maxSpan) continue;

        const curClose = coin.c15[prev].close;
        const posRatio = (curClose - donLow) / (donHigh - donLow);

        const maxPos = opts.maxChannelPos ?? 0.35; // Default bottom 35% of channel
        if (posRatio > maxPos) continue;

        // Sweet spot entry found!
        const tpPct = opts.gridTakeProfitPct ?? 3.5;
        const slPct = opts.gridCutLossPct ?? 5.0;

        // Score: prefers tighter position in channel (closest to floor) and wider profitable span
        const score = (1.0 - posRatio) * 50 + spanPct * 2;
        candidates.push({
          symbol: coin.symbol,
          price: coin.c15[idx].open,
          tpPrice: coin.c15[idx].open * (1 + tpPct / 100),
          slPrice: coin.c15[idx].open * (1 - slPct / 100),
          score,
        });
      }

      // Fill best candidates
      if (candidates.length > 0) {
        candidates.sort((a, b) => b.score - a.score);
        const chosen = candidates.slice(0, freeSlots);
        for (const ch of chosen) {
          const currentFree = maxSlots - activePositions.length;
          const alloc = cash / currentFree;
          if (alloc < 1.0) continue;
          cash -= alloc;
          const qty = (alloc * (1 - costPerFill)) / ch.price;
          activePositions.push({
            symbol: ch.symbol,
            entryTime: t,
            entryPrice: ch.price,
            allocatedCapital: alloc,
            qty,
            tpPrice: ch.tpPrice,
            slPrice: ch.slPrice,
            lastPrice: ch.price,
          });
        }
      }
    }

    // 4. Mark to market
    let openVal = 0;
    for (const p of activePositions) openVal += p.qty * p.lastPrice;
    const currentEquity = cash + openVal;
    if (currentEquity > peakEquity) peakEquity = currentEquity;
    const dd = ((peakEquity - currentEquity) / peakEquity) * 100;
    if (dd > maxDdPct) maxDdPct = dd;
  }

  // Force close remaining at end
  for (const pos of activePositions) {
    const proceeds = pos.qty * pos.lastPrice * (1 - costPerFill);
    cash += proceeds;
    const netPnlPct = ((proceeds - pos.allocatedCapital) / pos.allocatedCapital) * 100;
    completedTrades.push({
      symbol: pos.symbol,
      holdHours: (endT - pos.entryTime) / 3600,
      pnlPct: netPnlPct,
      isWin: netPnlPct > 0,
      reason: "END_PERIOD",
    });
  }

  const netPnlQuote = cash - initialCapital;
  const netPnlPct = (netPnlQuote / initialCapital) * 100;
  const wins = completedTrades.filter((t) => t.isWin);
  const losses = completedTrades.filter((t) => !t.isWin);
  const winRate = completedTrades.length > 0 ? (wins.length / completedTrades.length) * 100 : 0;
  const sumW = wins.reduce((s, t) => s + t.pnlPct, 0);
  const sumL = Math.abs(losses.reduce((s, t) => s + t.pnlPct, 0));
  const profitFactor = sumL > 0 ? sumW / sumL : (sumW > 0 ? 99 : 0);

  return {
    label: opts.label,
    trades: completedTrades.length,
    winRate: Number(winRate.toFixed(1)),
    netPnlPct: Number(netPnlPct.toFixed(2)),
    maxDrawdownPct: Number(maxDdPct.toFixed(2)),
    profitFactor: Number(profitFactor.toFixed(2)),
  };
}

async function run() {
  console.log("==========================================================================================");
  console.log(" 🔬 FORENSIC EXPERIMENT: DYNAMIC GRID SCANNER WITH HTF GOVERNOR & BOTTOM-CHANNEL ENTRY");
  console.log("==========================================================================================");

  // 1. Load 30-Day Bearish Window (last 8,640 bars = Oct-Nov 2026, BTC dumped -7.5%)
  console.log("\n>>> TEST SUITE 1: 30-DAY BEARISH PERIOD (October - November 2026)...");
  const { universe: uni30, btcCandles: btc30 } = loadUniverse(8640);
  console.log(`Loaded ${uni30.length} coins for 30-day window.`);

  const configs: GridTestOptions[] = [
    {
      label: "1. Baseline Single-Coin (No HTF, Any Pos <= 0.88, No Macro)",
      maxSlots: 1,
      maxChannelPos: 0.88,
      useHtf1hEma75: false,
      useHtf4hEma75: false,
      useBtcMacroDefense: false,
    },
    {
      label: "2. + Bottom Channel Entry Only (Pos <= 0.35, Span 4-10%)",
      maxSlots: 1,
      maxChannelPos: 0.35,
      minSpanPct: 4.0,
      maxSpanPct: 10.0,
      useHtf1hEma75: false,
      useHtf4hEma75: false,
      useBtcMacroDefense: false,
    },
    {
      label: "3. + HTF 1H EMA75 Governor (Coin Price > 1H EMA75)",
      maxSlots: 1,
      maxChannelPos: 0.35,
      minSpanPct: 4.0,
      maxSpanPct: 10.0,
      useHtf1hEma75: true,
      useHtf4hEma75: false,
      useBtcMacroDefense: false,
    },
    {
      label: "4. + HTF 4H EMA75 Governor (Coin Price > 4H EMA75)",
      maxSlots: 1,
      maxChannelPos: 0.35,
      minSpanPct: 4.0,
      maxSpanPct: 10.0,
      useHtf1hEma75: false,
      useHtf4hEma75: true,
      useBtcMacroDefense: false,
    },
    {
      label: "5. ★ Dual HTF (BTC Macro Sit-Out + Coin 4H EMA75 + Pos <= 0.35)",
      maxSlots: 1,
      maxChannelPos: 0.35,
      minSpanPct: 4.0,
      maxSpanPct: 10.0,
      useHtf1hEma75: false,
      useHtf4hEma75: true,
      useBtcMacroDefense: true,
    },
    {
      label: "6. ★ Multi-Slot 3 Slots (Dual HTF + Pos <= 0.35)",
      maxSlots: 3,
      maxChannelPos: 0.35,
      minSpanPct: 4.0,
      maxSpanPct: 10.0,
      useHtf1hEma75: false,
      useHtf4hEma75: true,
      useBtcMacroDefense: true,
    },
  ];

  const results30 = configs.map((cfg) => runGridSimulationSuite(uni30, btc30, cfg));
  console.table(results30);

  // 2. Load 120-Day Full History Window
  console.log("\n>>> TEST SUITE 2: 120-DAY FULL PERIOD (July - November 2026, 34,560 bars)...");
  const { universe: uni120, btcCandles: btc120 } = loadUniverse(30000);
  console.log(`Loaded ${uni120.length} coins for 120-day window.`);

  const results120 = configs.map((cfg) => runGridSimulationSuite(uni120, btc120, cfg));
  console.table(results120);
}

run().catch(console.error);
