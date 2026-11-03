import fs from "fs";
import path from "path";
import { loadCandles, runPortfolioSimulation, PortfolioConfig } from "./test-portfolio-ma-fan.js";

const BLACKLIST = new Set([
  "BFUSDUSDT", "USDEUSDT", "RWUSDUSDT", "UUSDT", "??USDT",
  "GOOGLBUSDT", "INTCBUSDT", "MSTRBUSDT", "QQQBUSDT", "SKHYBUSDT",
  "SNDKBUSDT", "SOXLBUSDT", "SPCXBUSDT", "TQQQBUSDT", "CRCLBUSDT", "PAXGUSDT", "XAUTUSDT"
]);

async function run() {
  const files = fs.readdirSync(path.resolve(process.cwd(), "data/cache/klines"))
    .filter((f) => f.endsWith("USDT_5m.json"))
    .map((f) => f.replace("_5m.json", ""))
    .filter((s) => !BLACKLIST.has(s));

  const btc15 = loadCandles("BTCUSDT", 15);
  const startT = btc15[0]!.time + 320 * 3600;
  const endT = btc15.at(-1)!.time;

  const slVariants: PortfolioConfig[] = [
    { name: "Formula F (3 Slots) - No Stop Loss", maxSlots: 3, btc4hAboveEma75: true, coin1hRsi40: true, stopLossMode: "NONE" },
    { name: "Formula F (3 Slots) - Swing Low SL", maxSlots: 3, btc4hAboveEma75: true, coin1hRsi40: true, stopLossMode: "SWING_LOW" },
    { name: "Formula F (3 Slots) - Fixed 5% SL", maxSlots: 3, btc4hAboveEma75: true, coin1hRsi40: true, stopLossMode: "FIXED_5PCT" },
    { name: "Formula F (3 Slots) - Dynamic Cut (MA8 < MA16)", maxSlots: 3, btc4hAboveEma75: true, coin1hRsi40: true, stopLossMode: "MA8_CROSS_MA16_DOWN" },
    { name: "Formula F (3 Slots) - 72h Time Stop", maxSlots: 3, btc4hAboveEma75: true, coin1hRsi40: true, stopLossMode: "NONE", maxHoldHours: 72 },
  ];

  const rows = slVariants.map((v) => {
    const r = runPortfolioSimulation(v, files, startT, endT);
    return {
      Variant: r.configName,
      "Trades (Stuck)": `${r.tradesCount} (${r.stuckCount})`,
      WinRate: `${r.winRate.toFixed(1)}%`,
      NetPnL: `${r.netPnlPct >= 0 ? "+" : ""}${r.netPnlPct.toFixed(2)}%`,
      MaxDD: `-${r.maxPortfolioDdPct.toFixed(1)}%`,
      PF: r.profitFactor.toFixed(2),
      WorstMAE: `${r.worstMaePct.toFixed(2)}%`,
      AvgHold: `${r.avgHoldHours.toFixed(1)}h`,
    };
  });
  console.table(rows);
}

run().catch(console.error);
