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

function testCombo() {
  const { universe: uni68, btcCandles } = loadUniverse(9000);
  const { universe: uni19 } = loadUniverse(30000);

  const btc1d = resample1d(btcCandles);
  const btc1dCloses = btc1d.map((c) => c.close);
  const ema25_1d = calcEMA(btc1dCloses, 25);

  // Filter universe by BTC 1D >= EMA 25 gate
  // To avoid cutting candle series (which breaks EMAs), we pass full candles into a custom test or portfolio test.
  // In BacktestService.runMaFanPortfolioSimulation:
  // Let's see: what if we test BacktestService with minBreadth25Pct: 50 vs 0?
  console.log("\n====================================================================================================");
  console.log("BACKTEST SERVICE SIMULATION: DOWNTREND REGIME (RECENT 33 DAYS)");
  console.log("====================================================================================================");

  const r1 = BacktestService.runMaFanPortfolioSimulation({
    universe: uni68,
    btcCandles,
    maxSlots: 3,
    requireCoin1hRsi40: true,
    minBuyVolRatio12: 1.3,
    minRelStrengthVsBtc24h: -1.0,
    rankBy: "COMPOSITE_QUALITY",
    // No breadth gate
  });
  console.log(`1. No Market Breadth Gate:   Ret: ${r1.netPnlPct.toFixed(2)}% | MaxDD: -${r1.maxDrawdownPct.toFixed(2)}% | Trades: ${r1.totalTrades} | WR: ${r1.winRate.toFixed(1)}% | PF: ${r1.profitFactor.toFixed(2)}`);

  const r2 = BacktestService.runMaFanPortfolioSimulation({
    universe: uni68,
    btcCandles,
    maxSlots: 3,
    requireCoin1hRsi40: true,
    minBuyVolRatio12: 1.3,
    minRelStrengthVsBtc24h: -1.0,
    rankBy: "COMPOSITE_QUALITY",
    minBreadth25Pct: 40,
  });
  console.log(`2. Market Breadth >= 40% Gate: Ret: ${r2.netPnlPct.toFixed(2)}% | MaxDD: -${r2.maxDrawdownPct.toFixed(2)}% | Trades: ${r2.totalTrades} | WR: ${r2.winRate.toFixed(1)}% | PF: ${r2.profitFactor.toFixed(2)}`);

  const r3 = BacktestService.runMaFanPortfolioSimulation({
    universe: uni68,
    btcCandles,
    maxSlots: 3,
    requireCoin1hRsi40: true,
    minBuyVolRatio12: 1.3,
    minRelStrengthVsBtc24h: -1.0,
    rankBy: "COMPOSITE_QUALITY",
    minBreadth25Pct: 40,
    requireBtcNotDumping: true,
  });
  console.log(`3. Breadth >= 40% + BTC Guard: Ret: ${r3.netPnlPct.toFixed(2)}% | MaxDD: -${r3.maxDrawdownPct.toFixed(2)}% | Trades: ${r3.totalTrades} | WR: ${r3.winRate.toFixed(1)}% | PF: ${r3.profitFactor.toFixed(2)}`);

  console.log("\n====================================================================================================");
  console.log("BACKTEST SERVICE SIMULATION: FULL 122 DAYS (BULL + RANGING + DOWNTREND)");
  console.log("====================================================================================================");

  const r1_122 = BacktestService.runMaFanPortfolioSimulation({
    universe: uni19,
    btcCandles,
    maxSlots: 3,
    requireCoin1hRsi40: true,
    minBuyVolRatio12: 1.3,
    minRelStrengthVsBtc24h: -1.0,
    rankBy: "COMPOSITE_QUALITY",
  });
  console.log(`1. No Market Breadth Gate:   Ret: +${r1_122.netPnlPct.toFixed(2)}% | MaxDD: -${r1_122.maxDrawdownPct.toFixed(2)}% | Trades: ${r1_122.totalTrades} | WR: ${r1_122.winRate.toFixed(1)}% | PF: ${r1_122.profitFactor.toFixed(2)} | Alpha: +${r1_122.alphaVsBtcPct.toFixed(2)}%`);

  const r2_122 = BacktestService.runMaFanPortfolioSimulation({
    universe: uni19,
    btcCandles,
    maxSlots: 3,
    requireCoin1hRsi40: true,
    minBuyVolRatio12: 1.3,
    minRelStrengthVsBtc24h: -1.0,
    rankBy: "COMPOSITE_QUALITY",
    minBreadth25Pct: 40,
  });
  console.log(`2. Market Breadth >= 40% Gate: Ret: +${r2_122.netPnlPct.toFixed(2)}% | MaxDD: -${r2_122.maxDrawdownPct.toFixed(2)}% | Trades: ${r2_122.totalTrades} | WR: ${r2_122.winRate.toFixed(1)}% | PF: ${r2_122.profitFactor.toFixed(2)} | Alpha: +${r2_122.alphaVsBtcPct.toFixed(2)}%`);

  const r3_122 = BacktestService.runMaFanPortfolioSimulation({
    universe: uni19,
    btcCandles,
    maxSlots: 3,
    requireCoin1hRsi40: true,
    minBuyVolRatio12: 1.3,
    minRelStrengthVsBtc24h: -1.0,
    rankBy: "COMPOSITE_QUALITY",
    minBreadth25Pct: 40,
    requireBtcNotDumping: true,
  });
  console.log(`3. Breadth >= 40% + BTC Guard: Ret: +${r3_122.netPnlPct.toFixed(2)}% | MaxDD: -${r3_122.maxDrawdownPct.toFixed(2)}% | Trades: ${r3_122.totalTrades} | WR: ${r3_122.winRate.toFixed(1)}% | PF: ${r3_122.profitFactor.toFixed(2)} | Alpha: +${r3_122.alphaVsBtcPct.toFixed(2)}%`);
}

testCombo();
