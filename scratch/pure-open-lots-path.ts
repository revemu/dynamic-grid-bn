// For each OPEN lot in pure dynamic grid mode: how fast was it underwater, and did price ever
// reach the real sell-target levels? Read-only analysis, no src changes.
// Run: npx tsx scratch/pure-open-lots-path.ts
//
// Target model (from src/backtest-service.ts, not the old sell52-only approximation):
//  - At entry, every lot gets targetPrice = max(sellTargets[0], buy*(1+minProfit)) (:2173-2175)
//    → sellTargets[0] = floor + span*52% (config sellLevelPcts [52,72]) → 52% is the FLOOR of any lot's target.
//  - When a second buy level (lvlIdx 1) fills, the index-0 lot is promoted to sellTargets[1] = span*72% (:2177-2186)
//    and per-bar refresh at :1576-1579 does the same while hasL2Held.
//  - Exit check: high >= targetPrice * 1.0005 (:1758).
// So for each OPEN lot we test: did any bar reach 52%-level (lower bound of any target) and 72%-level (promoted target).
// Trade records do not carry targetPrice or lot index, so the exact per-lot target is NOT recoverable here.
import fs from "fs";
import path from "path";
import { MASTER_PLAN_GRID_CONFIG, TARGET_BENCHMARK_ASSETS } from "../src/backtest";
import { BacktestService } from "../src/backtest-service";

const cacheDir = path.resolve(process.cwd(), "data", "cache", "klines");
const EXIT_TOUCH_FACTOR = 1.0005; // :1758

for (const item of TARGET_BENCHMARK_ASSETS) {
  const filePath = path.join(cacheDir, item.file);
  if (!fs.existsSync(filePath)) continue;
  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  const candles: any[] = Array.isArray(raw) ? raw : raw.candles || [];
  if (candles.length === 0) continue;
  const minWidth = item.assetClass === "STOCK" ? 1.2 : 2.0;
  const res = BacktestService.runDynamicGridSimulation(candles, {
    ...MASTER_PLAN_GRID_CONFIG,
    symbol: item.symbol,
    initialCapital: 200,
    minChannelWidthPct: minWidth,
    pureGridMode: true,
    gridCutLossMode: "none",
  } as any);
  const opens = (res.trades as any[]).filter((t) => t.exitType === "OPEN");
  for (const t of opens) {
    const entryIdx = candles.findIndex((c) => Number(c.time) === Number(t.entryTime));
    if (entryIdx < 0) {
      console.log(`${item.symbol} entry ${t.entryTime} not matched`);
      continue;
    }
    const buy = Number(t.entryPrice);
    const floor = Number(t.channelFloor);
    const span = Number(t.channelCeil) - floor;
    const lvl52 = floor + span * 0.52;
    const lvl72 = floor + span * 0.72;
    const hurdle = buy * (1 + (MASTER_PLAN_GRID_CONFIG as any).effectiveMinProfitPct / 100 || 0);
    let underwaterBars = 0;
    let firstCloseBelowBuy = -1;
    let minLow = Infinity;
    let minLowIdx = -1;
    let maxHigh = -Infinity;
    let touched52 = false;
    let touched72 = false;
    for (let i = entryIdx + 1; i < candles.length; i++) {
      const c = candles[i];
      const low = Number(c.low);
      const high = Number(c.high);
      const close = Number(c.close);
      if (close < buy) {
        underwaterBars++;
        if (firstCloseBelowBuy < 0) firstCloseBelowBuy = i - entryIdx;
      }
      if (low < minLow) { minLow = low; minLowIdx = i; }
      if (high > maxHigh) maxHigh = high;
      if (high >= lvl52 * EXIT_TOUCH_FACTOR) touched52 = true;
      if (high >= lvl72 * EXIT_TOUCH_FACTOR) touched72 = true;
    }
    const pctMin = ((minLow - buy) / buy) * 100;
    const pctMax = ((maxHigh - buy) / buy) * 100;
    console.log(
      [
        item.symbol.padEnd(10),
        `entryBar=${entryIdx}/${candles.length}`,
        `firstCloseBelowBuy=${firstCloseBelowBuy < 0 ? "none" : firstCloseBelowBuy + "bars"}`,
        `underwaterBars=${underwaterBars}`,
        `maxDD%=${pctMin.toFixed(2)} @bar${minLowIdx}`,
        `maxUp%=${pctMax.toFixed(2)}`,
        `lvl52=${lvl52.toFixed(4)} touched52=${touched52}`,
        `lvl72=${lvl72.toFixed(4)} touched72=${touched72}`,
      ].join(" | ")
    );
  }
}
