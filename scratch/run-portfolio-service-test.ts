import fs from "fs";
import path from "path";
import { BacktestService } from "../src/backtest-service.js";
import { Candle } from "../src/types.js";

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

    if (symbol === "BTCUSDT") {
      btcCandles = raw;
    }
    universe.push({ symbol, candles: raw });
  }

  return { universe, btcCandles };
}

function runSuite(label: string, minBars: number) {
  const { universe, btcCandles } = loadUniverse(minBars);
  console.log(`\n====================================================================================================`);
  console.log(`TESTING BacktestService.runMaFanPortfolioSimulation on ${label} (${universe.length} coins)`);
  console.log(`====================================================================================================`);

  const configs = [
    {
      name: "1. Baseline (Hold Full Bullish Fan 100%)",
      options: {
        universe,
        btcCandles,
        maxSlots: 3,
        requireCoin1hRsi40: true,
      },
    },
    {
      name: "2. + Macro Gate (Breadth >= 50% & BTC Not Dumping)",
      options: {
        universe,
        btcCandles,
        maxSlots: 3,
        requireCoin1hRsi40: true,
        minBreadth25Pct: 50,
        requireBtcNotDumping: true,
      },
    },
    {
      name: "3. ★ MA-FAN PRO A (Vol>=1.3 + RelBTC>=-1% + CompositeRank)",
      options: {
        universe,
        btcCandles,
        maxSlots: 3,
        requireCoin1hRsi40: true,
        minBuyVolRatio12: 1.3,
        minRelStrengthVsBtc24h: -1.0,
        rankBy: "COMPOSITE_QUALITY" as const,
      },
    },
    {
      name: "4. ★ MA-FAN PRO B (MacroGate + Pro A)",
      options: {
        universe,
        btcCandles,
        maxSlots: 3,
        requireCoin1hRsi40: true,
        minBreadth25Pct: 50,
        requireBtcNotDumping: true,
        minBuyVolRatio12: 1.3,
        minRelStrengthVsBtc24h: -1.0,
        rankBy: "COMPOSITE_QUALITY" as const,
      },
    },
    {
      name: "5. ★ MA-FAN PRO D (Pro B + TP1 50% at EMA200 + BE SL + 8% Disaster SL)",
      options: {
        universe,
        btcCandles,
        maxSlots: 3,
        requireCoin1hRsi40: true,
        minBreadth25Pct: 50,
        requireBtcNotDumping: true,
        minBuyVolRatio12: 1.3,
        minRelStrengthVsBtc24h: -1.0,
        rankBy: "COMPOSITE_QUALITY" as const,
        tp1TargetMode: "EMA200" as const,
        partialTpAtEma200: true,
        maxDisasterSlPct: 8.0,
      },
    },
  ];

  console.log(`Strategy Variant                                                        | Trd |  WR%  |  PF  | NetRet% | MaxDD% | Calmar | AlphaBTC | AvgMAE`);
  console.log(`------------------------------------------------------------------------+-----+-------+------+---------+--------+--------+----------+-------`);

  for (const c of configs) {
    const res = BacktestService.runMaFanPortfolioSimulation(c.options);
    console.log(
      `${c.name.padEnd(71)} | ${String(res.totalTrades).padStart(3)} | ${res.winRate.toFixed(1).padStart(5)}% | ${res.profitFactor.toFixed(2).padStart(4)} | ${((res.netPnlPct >= 0 ? "+" : "") + res.netPnlPct.toFixed(2) + "%").padStart(7)} | ${("-" + res.maxDrawdownPct.toFixed(2) + "%").padStart(6)} | ${res.calmarRatio.toFixed(2).padStart(6)} | ${((res.alphaVsBtcPct >= 0 ? "+" : "") + res.alphaVsBtcPct.toFixed(2) + "%").padStart(8)} | ${res.avgMaePct.toFixed(2)}%`
    );
  }
}

runSuite("19 CORE COINS (122.1 DAYS - Market Bull/Ranging)", 30000);
runSuite("68 UNIFORM COINS (32.7 DAYS - Market Downtrend)", 9000);
