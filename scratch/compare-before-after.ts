// Same simulation as analyze-losing-trades.ts, but selectable implementation.
// Run: npx tsx scratch/compare-before-after.ts before|after
import fs from "fs";
import path from "path";
import { MASTER_PLAN_GRID_CONFIG, TARGET_BENCHMARK_ASSETS } from "../src/backtest";
import { BacktestService } from "../src/backtest-service";

const which = process.argv[2] === "before" ? "before" : "after";
// "pure" = experimental pure dynamic grid: all cut-loss/cap/escape/trailing/anti-climax/regime gates off.
// Sub-modes: pure-regime (keep regime filter), pure-escape (keep time-decay escape), pure-both.
const modeArg = process.argv[3] ?? "";
const pure = modeArg.startsWith("pure");
const keepRegime = modeArg === "pure-regime" || modeArg === "pure-both";
const keepEscape = modeArg === "pure-escape" || modeArg === "pure-both";
// "before" mode needs the baseline copy in src/ (see scratch note); this run uses "after" only.

const cacheDir = path.resolve(process.cwd(), "data", "cache", "klines");
const byType: Record<string, { n: number; pnl: number }> = {};

for (const item of TARGET_BENCHMARK_ASSETS) {
  const filePath = path.join(cacheDir, item.file);
  if (!fs.existsSync(filePath)) continue;
  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  const candles = Array.isArray(raw) ? raw : raw.candles || [];
  const minWidth = item.assetClass === "STOCK" ? 1.2 : 2.0;
  const res = BacktestService.runDynamicGridSimulation(candles, {
    ...MASTER_PLAN_GRID_CONFIG,
    symbol: item.symbol,
    initialCapital: 200,
    minChannelWidthPct: minWidth,
    ...(pure ? { pureGridMode: true, gridCutLossMode: "none", pureKeepRegimeFilter: keepRegime, pureKeepEscape: keepEscape } : {}),
  } as any);
  for (const t of res.trades) {
    const type = String(t.exitType);
    byType[type] ??= { n: 0, pnl: 0 };
    byType[type].n++;
    byType[type].pnl += t.pnlPct ?? 0;
  }
}

console.log(`== ${which}${pure ? " " + modeArg : ""} ==`);
for (const [k, v] of Object.entries(byType)) {
  console.log(`${k.padEnd(16)} n=${String(v.n).padStart(4)}  sumPnl%=${v.pnl.toFixed(2)}`);
}
