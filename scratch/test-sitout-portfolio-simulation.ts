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

function testSitOutGates() {
  const { universe: uni68, btcCandles } = loadUniverse(9000);
  const { universe: uni19 } = loadUniverse(30000);

  const btc4h = resample4h(btcCandles);
  const btc4hCloses = btc4h.map((c) => c.close);
  const ema75_4h = calcEMA(btc4hCloses, 75);

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

  // Pre-filter universe candles by tagging when BTC 4H is below EMA 75
  // If sitOutGate is active, we simulate sitting out in 100% Cash when BTC 4H < EMA 75!
  console.log(`\n====================================================================================================`);
  console.log(`TESTING SIT-OUT GATE: "BTC 4H Trend Defense" (Sit out 100% Cash when BTC 4H < EMA 75)`);
  console.log(`====================================================================================================`);

  // We can test this by running simulation with a custom universe where candles during sitout are blocked,
  // or by using BacktestService.runMaFanPortfolioSimulation!
  // In BacktestService.runMaFanPortfolioSimulation:
  // requireBtcNotDumping already checks BTC 4H return and 24h SMA.
  // What if we add a strict BTC 4H EMA 75 gate option?
  // Let's test via direct simulation!

  // Let's test on 68 coins (Recent 33 Days - Downtrend)
  console.log(`\n--- DATASET A: 68 COINS (Past 33 Days Downtrend, BTC: -7.71%) ---`);
  const r1_33 = BacktestService.runMaFanPortfolioSimulation({
    universe: uni68,
    btcCandles,
    maxSlots: 3,
    requireCoin1hRsi40: true,
    minBuyVolRatio12: 1.3,
    minRelStrengthVsBtc24h: -1.0,
    rankBy: "COMPOSITE_QUALITY",
  });
  console.log(`1. MA-FAN PRO A (No Sit-Out):        Ret: ${r1_33.netPnlPct}% | MaxDD: -${r1_33.maxDrawdownPct}% | Trades: ${r1_33.totalTrades} | WR: ${r1_33.winRate}%`);

  const r2_33 = BacktestService.runMaFanPortfolioSimulation({
    universe: uni68,
    btcCandles,
    maxSlots: 3,
    requireCoin1hRsi40: true,
    minBreadth25Pct: 50,
    requireBtcNotDumping: true,
    minBuyVolRatio12: 1.3,
    minRelStrengthVsBtc24h: -1.0,
    rankBy: "COMPOSITE_QUALITY",
  });
  console.log(`2. MA-FAN PRO B (Macro Breadth Gate): Ret: ${r2_33.netPnlPct}% | MaxDD: -${r2_33.maxDrawdownPct}% | Trades: ${r2_33.totalTrades} | WR: ${r2_33.winRate}%`);

  // Let's filter uni68 by zeroing or skipping when BTC 4H < EMA 75
  const uni68_btc4hFiltered = uni68.map((u) => {
    return {
      symbol: u.symbol,
      candles: u.candles.filter((c) => {
        const idx = getClosedIdx(btc4h, 14400, c.time);
        if (idx < 75) return true;
        return btc4h[idx].close >= ema75_4h[idx];
      }),
    };
  });

  const r3_33 = BacktestService.runMaFanPortfolioSimulation({
    universe: uni68_btc4hFiltered,
    btcCandles,
    maxSlots: 3,
    requireCoin1hRsi40: true,
    minBuyVolRatio12: 1.3,
    minRelStrengthVsBtc24h: -1.0,
    rankBy: "COMPOSITE_QUALITY",
  });
  console.log(`3. ★ SIT-OUT DEFENSE (BTC 4H >= EMA75): Ret: ${r3_33.netPnlPct >= 0 ? "+" : ""}${r3_33.netPnlPct}% | MaxDD: -${r3_33.maxDrawdownPct}% | Trades: ${r3_33.totalTrades} | WR: ${r3_33.winRate}%`);

  // Let's test on 19 coins (Full 122.1 Days - Bull + Ranging + Drop)
  console.log(`\n--- DATASET B: 19 CORE COINS (Full 122.1 Days, BTC: +23.18%) ---`);
  const r1_122 = BacktestService.runMaFanPortfolioSimulation({
    universe: uni19,
    btcCandles,
    maxSlots: 3,
    requireCoin1hRsi40: true,
    minBuyVolRatio12: 1.3,
    minRelStrengthVsBtc24h: -1.0,
    rankBy: "COMPOSITE_QUALITY",
  });
  console.log(`1. MA-FAN PRO A (No Sit-Out):        Ret: +${r1_122.netPnlPct}% | MaxDD: -${r1_122.maxDrawdownPct}% | Trades: ${r1_122.totalTrades} | WR: ${r1_122.winRate}% | Alpha: +${r1_122.alphaVsBtcPct}%`);

  const uni19_btc4hFiltered = uni19.map((u) => {
    return {
      symbol: u.symbol,
      candles: u.candles.filter((c) => {
        const idx = getClosedIdx(btc4h, 14400, c.time);
        if (idx < 75) return true;
        return btc4h[idx].close >= ema75_4h[idx];
      }),
    };
  });

  const r3_122 = BacktestService.runMaFanPortfolioSimulation({
    universe: uni19_btc4hFiltered,
    btcCandles,
    maxSlots: 3,
    requireCoin1hRsi40: true,
    minBuyVolRatio12: 1.3,
    minRelStrengthVsBtc24h: -1.0,
    rankBy: "COMPOSITE_QUALITY",
  });
  console.log(`3. ★ SIT-OUT DEFENSE (BTC 4H >= EMA75): Ret: +${r3_122.netPnlPct}% | MaxDD: -${r3_122.maxDrawdownPct}% | Trades: ${r3_122.totalTrades} | WR: ${r3_122.winRate}% | Alpha: +${r3_122.alphaVsBtcPct}%`);
}

testSitOutGates();
