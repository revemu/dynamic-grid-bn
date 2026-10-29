import fs from "fs";
import path from "path";
import assert from "assert";
import { BacktestService } from "../backtest-service.js";
import { Candle } from "../strategy/ma-fan/types.js";
import { SnapshotManifest } from "./types.js";

async function main() {
  console.log("=== Checking Runner Sanity (R3.7) ===");
  const cacheDir = path.resolve(process.cwd(), "data", "research-cache");
  const manifestPath = path.join(cacheDir, "manifest_30d.json");
  const manifest: SnapshotManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  const sym = "HAEDALUSDT";
  const meta5m = manifest.files[`${sym}_5m`]!;
  const meta15m = manifest.files[`${sym}_15m`]!;
  const c5m: Candle[] = JSON.parse(fs.readFileSync(meta5m.filePath, "utf8"));
  const c15m: Candle[] = JSON.parse(fs.readFileSync(meta15m.filePath, "utf8"));

  // Check 1: identity of R0 vs undefined
  const recNoGate = BacktestService.runMaFanSimulation(c5m, {
    symbol: sym,
    timeframe: "5m",
    spreadThreshold: 0.25,
    initialCapital: 200,
    slBufferPct: 0.25,
    useRatchetSl: true,
    useAtrAdaptiveSpread: true,
    atrMultiplier: 1.25,
    trailingPullbackPct: 0.45,
    tp1Ratio: 0.5,
    breakevenFeeBufferPct: 0.15,
    supervisorTimeframe: "15m",
    candlesHtf: c15m,
    saveToHistory: false,
    cushionMode: "off",
  });

  const recGate0 = BacktestService.runMaFanSimulation(c5m, {
    symbol: sym,
    timeframe: "5m",
    spreadThreshold: 0.25,
    initialCapital: 200,
    slBufferPct: 0.25,
    useRatchetSl: true,
    useAtrAdaptiveSpread: true,
    atrMultiplier: 1.25,
    trailingPullbackPct: 0.45,
    tp1Ratio: 0.5,
    breakevenFeeBufferPct: 0.15,
    supervisorTimeframe: "15m",
    candlesHtf: c15m,
    saveToHistory: false,
    cushionMode: "off",
    minRewardRiskRatio: 0,
  });

  assert.strictEqual(recNoGate.trades.length, recGate0.trades.length, "Trade counts should match");
  assert.ok(Math.abs(recNoGate.summary.netPnlPct - recGate0.summary.netPnlPct) < 1e-6, "Net PnL should match");
  console.log(`✓ Check 1 Passed: minRewardRiskRatio=0 matches undefined perfectly (${recNoGate.trades.length} trades)`);

  // Check 2: gate=99 blocks all trades
  const recGate99 = BacktestService.runMaFanSimulation(c5m, {
    symbol: sym,
    timeframe: "5m",
    spreadThreshold: 0.25,
    initialCapital: 200,
    slBufferPct: 0.25,
    useRatchetSl: true,
    useAtrAdaptiveSpread: true,
    atrMultiplier: 1.25,
    trailingPullbackPct: 0.45,
    tp1Ratio: 0.5,
    breakevenFeeBufferPct: 0.15,
    supervisorTimeframe: "15m",
    candlesHtf: c15m,
    saveToHistory: false,
    cushionMode: "off",
    minRewardRiskRatio: 99,
  });

  assert.strictEqual(recGate99.trades.length, 0, "Trade count should be 0 with gate=99");
  console.log(`✓ Check 2 Passed: minRewardRiskRatio=99 produces 0 trades as expected`);
  console.log("🎉 ALL R3.7 SANITY CHECKS PASSED!");
}

main().catch((err) => {
  console.error("Sanity check failed:", err);
  process.exit(1);
});
