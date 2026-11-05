// Per-trade loss forensics. Read-only: reuses the same simulation as src/backtest.ts runMasterBenchmark.
// Run: npm install && npx tsx scratch/analyze-losing-trades.ts
import fs from "fs";
import path from "path";
import { BacktestService } from "../src/backtest-service";
import { MASTER_PLAN_GRID_CONFIG, TARGET_BENCHMARK_ASSETS } from "../src/backtest";

const cacheDir = path.resolve(process.cwd(), "data", "cache", "klines");
const fmtTime = (s?: number) => (s ? new Date(s * 1000).toISOString().slice(0, 16) : "-");

const rows: string[] = [];
const byType: Record<string, { n: number; pnl: number }> = {};

for (const item of TARGET_BENCHMARK_ASSETS) {
  const filePath = path.join(cacheDir, item.file);
  if (!fs.existsSync(filePath)) {
    console.warn(`skip ${item.symbol}: cache missing`);
    continue;
  }
  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  const candles = Array.isArray(raw) ? raw : raw.candles || [];
  const minWidth = item.assetClass === "STOCK" ? 1.2 : 2.0;
  const res = BacktestService.runDynamicGridSimulation(candles, {
    ...MASTER_PLAN_GRID_CONFIG,
    symbol: item.symbol,
    initialCapital: 200,
    minChannelWidthPct: minWidth,
  } as any);

  for (const t of res.trades) {
    const pnl = t.pnlPct ?? 0;
    const type = String(t.exitType);
    byType[type] ??= { n: 0, pnl: 0 };
    byType[type].n++;
    byType[type].pnl += pnl;
    if (pnl >= 0) continue;
    rows.push(
      [
        item.symbol.padEnd(9),
        String(t.id).padStart(4),
        (t.side ?? "LONG").padEnd(5),
        fmtTime(t.entryTime),
        fmtTime(t.exitTime),
        `${t.holdingBars}`.padStart(5),
        type.padEnd(14),
        t.entryPrice?.toFixed(4).padStart(12),
        t.exitPrice?.toFixed(4).padStart(12),
        `${pnl.toFixed(2)}%`.padStart(8),
        `${(t.pnlQuote ?? 0).toFixed(2)}`.padStart(8),
        `span=${t.channelSpanPct?.toFixed(2) ?? "-"}`.padEnd(12),
        `fan=${t.fanSpreadAtEntry?.toFixed(2) ?? "-"}`.padEnd(10),
        `rr=${t.rewardRiskAtEntry?.toFixed(2) ?? "-"}`,
      ].join(" | ")
    );
  }
}

console.log("\n== Losing trades ==");
console.log("symbol    |   id | side  | entry            | exit             | bars | exitType       |   entryPx |    exitPx |   pnl% | pnl$ | ...");
rows.forEach((r) => console.log(r));

console.log("\n== Exit type summary (all trades) ==");
for (const [k, v] of Object.entries(byType)) {
  console.log(`${k.padEnd(16)} n=${String(v.n).padStart(4)}  sumPnl%=${v.pnl.toFixed(2)}`);
}
