import fs from "fs";
import path from "path";
import { BacktestService } from "../src/backtest-service.js";
import { Candle } from "../src/types.js";
import { calcEMA } from "../src/strategy/ma-fan/ribbon.js";

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

// Resample 5m to 4h
function resample4h(candles5m: Candle[]): Candle[] {
  const sec = 14400;
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

// Resample 5m to 1d
function resample1d(candles5m: Candle[]): Candle[] {
  const sec = 86400;
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

function runAnalysis() {
  const { universe: uni68, btcCandles } = loadUniverse(9000);
  const { universe: uni19 } = loadUniverse(30000);

  const btc4h = resample4h(btcCandles);
  const btc4hCloses = btc4h.map((c) => c.close);
  const ema75_4h = calcEMA(btc4hCloses, 75);

  const btc1d = resample1d(btcCandles);
  const btc1dCloses = btc1d.map((c) => c.close);
  const ema25_1d = calcEMA(btc1dCloses, 25);

  console.log("Universe 68 (33 days):", uni68.length);
  console.log("Universe 19 (122 days):", uni19.length);

  // Let's test different parameter combinations for BacktestService
  const testConfigs = [
    {
      name: "1. Baseline (No Sit-Out, No Breadth)",
      params: { minBreadth25Pct: 0, requireBtcNotDumping: false },
    },
    {
      name: "2. Breadth >= 40% Gate",
      params: { minBreadth25Pct: 40, requireBtcNotDumping: false },
    },
    {
      name: "3. Breadth >= 50% Gate",
      params: { minBreadth25Pct: 50, requireBtcNotDumping: false },
    },
    {
      name: "4. Breadth >= 55% Gate",
      params: { minBreadth25Pct: 55, requireBtcNotDumping: false },
    },
    {
      name: "5. Breadth >= 50% + BTC Not Dumping (24h)",
      params: { minBreadth25Pct: 50, requireBtcNotDumping: true },
    },
    {
      name: "6. Breadth >= 55% + BTC Not Dumping (24h)",
      params: { minBreadth25Pct: 55, requireBtcNotDumping: true },
    },
  ];

  console.log("\n====================================================================================================");
  console.log("DATASET A: RECENT 33 DAYS (DOWNTREND SLUMP, BTC -7.71%)");
  console.log("====================================================================================================");
  for (const tc of testConfigs) {
    const res = BacktestService.runMaFanPortfolioSimulation({
      universe: uni68,
      btcCandles,
      maxSlots: 3,
      requireCoin1hRsi40: true,
      minBuyVolRatio12: 1.3,
      minRelStrengthVsBtc24h: -1.0,
      rankBy: "COMPOSITE_QUALITY",
      tp1TargetMode: "EMA25",
      lockBreakevenAtEma200: true,
      partialTpAtEma200: true,
      ...tc.params,
    });
    console.log(
      `${tc.name.padEnd(46)} | Ret: ${(res.netPnlPct >= 0 ? "+" : "") + res.netPnlPct.toFixed(2)}% | MaxDD: -${res.maxDrawdownPct.toFixed(2)}% | Trades: ${res.totalTrades} | WR: ${res.winRate.toFixed(1)}% | PF: ${res.profitFactor.toFixed(2)}`
    );
  }

  console.log("\n====================================================================================================");
  console.log("DATASET B: FULL 122 DAYS (BULL + RANGING + DOWNTREND, BTC +23.18%)");
  console.log("====================================================================================================");
  for (const tc of testConfigs) {
    const res = BacktestService.runMaFanPortfolioSimulation({
      universe: uni19,
      btcCandles,
      maxSlots: 3,
      requireCoin1hRsi40: true,
      minBuyVolRatio12: 1.3,
      minRelStrengthVsBtc24h: -1.0,
      rankBy: "COMPOSITE_QUALITY",
      tp1TargetMode: "EMA25",
      lockBreakevenAtEma200: true,
      partialTpAtEma200: true,
      ...tc.params,
    });
    console.log(
      `${tc.name.padEnd(46)} | Ret: ${(res.netPnlPct >= 0 ? "+" : "") + res.netPnlPct.toFixed(2)}% | MaxDD: -${res.maxDrawdownPct.toFixed(2)}% | Trades: ${res.totalTrades} | WR: ${res.winRate.toFixed(1)}% | PF: ${res.profitFactor.toFixed(2)} | Alpha: +${res.alphaVsBtcPct.toFixed(2)}%`
    );
  }
}

runAnalysis();
