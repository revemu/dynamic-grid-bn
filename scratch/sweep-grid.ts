import fs from "fs";
import path from "path";
import { BacktestService } from "../src/backtest-service.js";

// Parameter sweep over options that already exist in runDynamicGridSimulation.
// Does NOT change any src default. Writes scratch/sweep-out.json only.

const BASE = {
  channelMode: "DONCHIAN_ATR" as const,
  donchianPeriod: 48,
  maxChannelWidthPct: 25.0,
  lockChannelInPosition: true,
  regimeFilterMode: "UPTREND_AND_SIDEWAY" as const,
  buyLevelPcts: [20, 12],
  buyWeights: [55, 45],
  capitalZones: 1,
  zoneMinDropPct: 2.5,
  floorBufferPct: 0.6,
  gridCutLossMode: "entry_floor" as const,
  enableGridTrailingStop: true,
  costModel: { feePctPerSide: 0.075, slippagePctPerFill: 0.01 },
};

const ASSETS = [
  { symbol: "BTCUSDT", file: "BTCUSDT_15m.json", cls: "CRYPTO", minW: 2.0 },
  { symbol: "ETHUSDT", file: "ETHUSDT_15m.json", cls: "CRYPTO", minW: 2.0 },
  { symbol: "SOLUSDT", file: "SOLUSDT_15m.json", cls: "CRYPTO", minW: 2.0 },
  { symbol: "AVAXUSDT", file: "AVAXUSDT_15m.json", cls: "CRYPTO", minW: 2.0 },
  { symbol: "LINKUSDT", file: "LINKUSDT_15m.json", cls: "CRYPTO", minW: 2.0 },
  { symbol: "ADAUSDT", file: "ADAUSDT_15m.json", cls: "CRYPTO", minW: 2.0 },
  { symbol: "SPY", file: "alpaca_SPY_15m.json", cls: "STOCK", minW: 1.2 },
  { symbol: "AAPL", file: "alpaca_AAPL_15m.json", cls: "STOCK", minW: 1.2 },
  { symbol: "KO", file: "alpaca_KO_15m.json", cls: "STOCK", minW: 1.2 },
];

// Sell-level ladders (TP location within the channel) and minimum net profit target.
const SELLS: number[][] = [[52, 72], [60, 80], [70, 90]];
const MIN_NET: number[] = [0.2, 0.5, 0.8];

const klinesDir = path.resolve(process.cwd(), "data", "cache", "klines");
const out: any[] = [];

for (const sell of SELLS) {
  for (const minNet of MIN_NET) {
    const perAsset: any[] = [];
    for (const a of ASSETS) {
      const fp = path.join(klinesDir, a.file);
      if (!fs.existsSync(fp)) {
        console.warn(`missing ${fp}`);
        continue;
      }
      const raw = JSON.parse(fs.readFileSync(fp, "utf-8"));
      const candles = Array.isArray(raw) ? raw : raw.candles || [];
      const res = BacktestService.runDynamicGridSimulation(candles, {
        ...BASE,
        symbol: a.symbol,
        initialCapital: 200,
        minChannelWidthPct: a.minW,
        sellLevelPcts: sell,
        minNetProfitPct: minNet,
      } as any);
      const s = res.summary as any;
      const trades = res.trades as any[];
      const wins = trades.filter((t) => (t.pnlPct ?? 0) >= 0);
      const losses = trades.filter((t) => (t.pnlPct ?? 0) < 0);
      const avg = (xs: any[]) => (xs.length ? xs.reduce((x, t) => x + t.pnlPct, 0) / xs.length : 0);
      perAsset.push({
        symbol: a.symbol,
        cls: a.cls,
        netPnlPct: +s.netPnlPct.toFixed(2),
        winRate: +s.winRate.toFixed(1),
        pf: +s.profitFactor.toFixed(2),
        maxDD: +s.maxDrawdownPct.toFixed(2),
        trades: trades.length,
        avgWinPct: +avg(wins).toFixed(3),
        avgLossPct: +avg(losses).toFixed(3),
      });
      console.log(`[sweep] sell=${sell.join("/")} minNet=${minNet} ${a.symbol} net=${s.netPnlPct.toFixed(2)}% PF=${s.profitFactor.toFixed(2)}`);
    }
    const net = perAsset.reduce((x, r) => x + r.netPnlPct, 0) / Math.max(1, perAsset.length);
    const pfAbove1 = perAsset.filter((r) => r.pf >= 1).length;
    out.push({ sell, minNet, avgNetPct: +net.toFixed(2), pfAbove1, perAsset });
  }
}

const outPath = path.resolve(process.cwd(), "scratch", "sweep-out.json");
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`\nwrote ${outPath}`);
for (const o of out) {
  console.log(`sell=${o.sell.join("/")} minNet=${o.minNet} avgNet=${o.avgNetPct}% PF>=1: ${o.pfAbove1}/${o.perAsset.length}`);
}
