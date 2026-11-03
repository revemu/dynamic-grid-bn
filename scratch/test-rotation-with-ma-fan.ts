import fs from "fs";
import path from "path";
import { BacktestService } from "../src/backtest-service.js";
import { Candle } from "../src/strategy/ma-fan/types.js";
import { calcEMA } from "../src/strategy/ma-fan/ribbon.js";

const BLACKLIST = new Set([
  "BFUSDUSDT", "USDEUSDT", "RWUSDUSDT", "UUSDT", "??USDT",
  "GOOGLBUSDT", "INTCBUSDT", "MSTRBUSDT", "QQQBUSDT", "SKHYBUSDT",
  "SNDKBUSDT", "SOXLBUSDT", "SPCXBUSDT", "TQQQBUSDT", "CRCLBUSDT", "PAXGUSDT", "XAUTUSDT", "BEAMXUSDT"
]);

const BS: any = BacktestService;
const origEval = BS.evaluateHistoricalFunnelAtTime.bind(BS);

// Load 50 cached USDT pairs directly from disk (last 8640 5m bars = 30 days)
const cacheDir = path.resolve(process.cwd(), "data/cache/klines");
const allFiles = fs.readdirSync(cacheDir)
  .filter((f) => f.endsWith("USDT_5m.json"))
  .map((f) => f.replace("_5m.json", ""))
  .filter((s) => !BLACKLIST.has(s));

const cachedUniverse = new Map<string, Candle[]>();
for (const sym of allFiles) {
  const raw = JSON.parse(fs.readFileSync(path.join(cacheDir, `${sym}_5m.json`), "utf8"));
  const c5: Candle[] = raw.candles || raw;
  if (c5.length >= 8000) {
    cachedUniverse.set(sym, c5.slice(-8640));
  }
}

// Precompute 15m EMA ribbons per symbol for fast lookup
const ribbon15mBySym = new Map<string, { times: number[]; m4: number[]; m8: number[]; m16: number[]; m25: number[]; m75: number[]; m200: number[] }>();
for (const [sym, c5] of cachedUniverse.entries()) {
  const c15: Candle[] = [];
  let b = -1, cur: Candle | null = null;
  for (const c of c5) {
    const bk = Math.floor(c.time / 900) * 900;
    if (bk !== b) {
      if (cur) c15.push(cur);
      b = bk;
      cur = { ...c, time: bk, isClosed: true };
    } else if (cur) {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      cur.volume += c.volume;
    }
  }
  if (cur) c15.push(cur);
  const closes = c15.map((x) => x.close);
  ribbon15mBySym.set(sym, {
    times: c15.map((x) => x.time),
    m4: calcEMA(closes, 4),
    m8: calcEMA(closes, 8),
    m16: calcEMA(closes, 16),
    m25: calcEMA(closes, 25),
    m75: calcEMA(closes, 75),
    m200: calcEMA(closes, 200),
  });
}

function checkMaFan15m(sym: string, targetTime: number, mode: "STRICT_BOTTOM_FAN_REVERSAL" | "EMA8_ABOVE_EMA16"): boolean {
  const r = ribbon15mBySym.get(sym);
  if (!r) return false;
  // Find latest CLOSED 15m candle (time + 900 <= targetTime)
  let idx = -1;
  for (let i = r.times.length - 1; i >= 0; i--) {
    if (r.times[i]! + 900 <= targetTime) { idx = i; break; }
  }
  if (idx < 200) return false;

  if (mode === "EMA8_ABOVE_EMA16") {
    return r.m8[idx]! > r.m16[idx]!;
  }

  // STRICT_BOTTOM_FAN_REVERSAL: m8 > m16 currently, AND had a 6-line bottom fan within last 24 bars (6h)
  if (!(r.m8[idx]! > r.m16[idx]!)) return false;
  for (let k = Math.max(0, idx - 24); k < idx; k++) {
    if (r.m4[k]! < r.m8[k]! && r.m8[k]! < r.m16[k]! && r.m16[k]! < r.m25[k]! && r.m25[k]! < r.m75[k]! && r.m75[k]! < r.m200[k]!) {
      return true;
    }
  }
  return false;
}

async function run() {
  // Stub fetchTopUniverseCandles to return offline cached universe
  BS.fetchTopUniverseCandles = async () => cachedUniverse;

  const modes: Array<{ label: string; filter: "NONE" | "STRICT_BOTTOM_FAN_REVERSAL" | "EMA8_ABOVE_EMA16" | "BONUS_BOTTOM_FAN" }> = [
    { label: "1. Current Production Bot (v0.3.0.22 Baseline)", filter: "NONE" },
    { label: "2. + Hard Gate: Require 15m Bottom Fan -> 8>16 Reversal", filter: "STRICT_BOTTOM_FAN_REVERSAL" },
    { label: "3. + Hard Gate: Require 15m EMA8 > EMA16", filter: "EMA8_ABOVE_EMA16" },
    { label: "4. + Soft Score Bonus (+15 pts) for Bottom Fan -> 8>16", filter: "BONUS_BOTTOM_FAN" },
  ];

  const summaryRows = [];
  for (const m of modes) {
    BS.evaluateHistoricalFunnelAtTime = (opts: any) => {
      const base = origEval(opts);
      if (m.filter === "NONE" || base.length === 0) return base;

      if (m.filter === "BONUS_BOTTOM_FAN") {
        const boosted = base.map((cand: any) => {
          const hasFan = checkMaFan15m(cand.symbol, opts.targetTime, "STRICT_BOTTOM_FAN_REVERSAL");
          return hasFan ? { ...cand, compositeScore: Math.min(100, cand.compositeScore + 15) } : cand;
        });
        boosted.sort((a: any, b: any) => b.compositeScore - a.compositeScore);
        return boosted;
      }

      const filtered = base.filter((cand: any) => {
        if (cand.symbol === opts.activeSymbol) return true;
        return checkMaFan15m(cand.symbol, opts.targetTime, m.filter as any);
      });
      return filtered.length >= 2 ? filtered : [];
    };

    const origLog = console.log;
    const origWarn = console.warn;
    console.log = () => {};
    console.warn = () => {};
    const res = await BS.runMultiPairRotationSimulation({
      quoteAsset: "USDT",
      maxUniversePairs: 50,
      limit: 8640,
      initialCapital: 100,
      rotationIntervalMinutes: 180,
      rotationScoreMarginPct: 15,
      capitalZones: 1,
      signalInvalidationMode: "calibrated",
      enableBtcMacroGate: true,
    });
    console.log = origLog;
    console.warn = origWarn;

    summaryRows.push({
      Strategy: m.label,
      Pairs: cachedUniverse.size,
      Legs: res.summary.totalLegs,
      Trades: res.summary.totalTrades,
      WinRate: `${res.summary.tradeWinRate.toFixed(1)}%`,
      NetPnL: `${res.summary.netPnlPct >= 0 ? "+" : ""}${res.summary.netPnlPct.toFixed(2)}%`,
      MaxDD: `-${res.summary.maxPortfolioDrawdownPct.toFixed(2)}%`,
      "Alpha vs BTC": `${res.summary.alphaVsBenchmarkPct >= 0 ? "+" : ""}${res.summary.alphaVsBenchmarkPct.toFixed(2)}%`,
    });
  }

  console.log("================================================================================");
  console.log("   PART 3: TESTING MA FAN AS ENTRY FILTER / SCORE BONUS IN DYNAMIC GRID ROTATION");
  console.log("================================================================================");
  console.table(summaryRows);
}

run().catch(console.error);
