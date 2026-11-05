// Diagnose OPEN trades in pure dynamic grid mode (read-only analysis, no src changes).
// Run: npx tsx scratch/pure-open-lots.ts
import fs from "fs";
import path from "path";
import { MASTER_PLAN_GRID_CONFIG, TARGET_BENCHMARK_ASSETS } from "../src/backtest";
import { BacktestService } from "../src/backtest-service";

const cacheDir = path.resolve(process.cwd(), "data", "cache", "klines");

for (const item of TARGET_BENCHMARK_ASSETS) {
  const filePath = path.join(cacheDir, item.file);
  if (!fs.existsSync(filePath)) continue;
  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  const candles = Array.isArray(raw) ? raw : raw.candles || [];
  if (candles.length === 0) continue;
  const lastClose = Number(candles[candles.length - 1].close);
  const minWidth = item.assetClass === "STOCK" ? 1.2 : 2.0;
  const res = BacktestService.runDynamicGridSimulation(candles, {
    ...MASTER_PLAN_GRID_CONFIG,
    symbol: item.symbol,
    initialCapital: 200,
    minChannelWidthPct: minWidth,
    pureGridMode: true,
    gridCutLossMode: "none",
  } as any);
  const opens = res.trades.filter((t: any) => t.exitType === "OPEN");
  for (const t of opens as any[]) {
    const entry = Number(t.entryPrice);
    const sellTarget = t.channelCeil && t.channelFloor
      ? Number(t.channelFloor) + (Number(t.channelCeil) - Number(t.channelFloor)) * 0.52
      : NaN;
    const pct = Number(t.pnlPct ?? 0);
    console.log(
      [
        item.symbol.padEnd(12),
        String(t.entryTime ?? "").slice(0, 19).padEnd(20),
        `buy=${entry.toFixed(4)}`,
        `last=${lastClose.toFixed(4)}`,
        `sell52~${Number.isFinite(sellTarget) ? sellTarget.toFixed(4) : "n/a"}`,
        `bars=${t.holdingBars}`,
        `pnl%=${pct.toFixed(2)}`,
        `span%=${t.channelSpanPct ?? "n/a"}`,
      ].join(" | ")
    );
  }
}
