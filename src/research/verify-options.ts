import fs from "fs";
import path from "path";
import assert from "assert";
import { BacktestService } from "../backtest-service.js";
import { Candle } from "../strategy/ma-fan/types.js";
import { SnapshotManifest } from "./types.js";

const CACHE_DIR = path.resolve(process.cwd(), "data", "research-cache");

async function main() {
  const manifestPath = path.join(CACHE_DIR, "manifest_15d.json");
  const manifest: SnapshotManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const sym = "HAEDALUSDT";

  const meta5m = manifest.files[`${sym}_5m`]!;
  const meta15m = manifest.files[`${sym}_15m`]!;
  const candles5m: Candle[] = JSON.parse(fs.readFileSync(meta5m.filePath, "utf8"));
  const candles15m: Candle[] = JSON.parse(fs.readFileSync(meta15m.filePath, "utf8"));

  console.log("=== Testing Engine Options & Edge Behaviors ===");

  // 1. Cost model test: {0,0} must equal default, and {0.075, 0.03} must reduce net PnL
  {
    const base = BacktestService.runMaFanSimulation(candles5m, {
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
      breakevenFeeBufferPct: 0.05,
      supervisorTimeframe: "15m",
      candlesHtf: candles15m,
      saveToHistory: false,
      cushionMode: "htfBull",
    });

    const costZero = BacktestService.runMaFanSimulation(candles5m, {
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
      breakevenFeeBufferPct: 0.05,
      supervisorTimeframe: "15m",
      candlesHtf: candles15m,
      saveToHistory: false,
      cushionMode: "htfBull",
      costModel: { feePctPerSide: 0, slippagePctPerFill: 0 },
    });

    assert.ok(
      Math.abs(base.summary.netPnlQuote - costZero.summary.netPnlQuote) < 1e-6,
      `Cost model {0,0} should match base exactly (base: ${base.summary.netPnlQuote}, costZero: ${costZero.summary.netPnlQuote})`
    );

    const costC1 = BacktestService.runMaFanSimulation(candles5m, {
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
      breakevenFeeBufferPct: 0.05,
      supervisorTimeframe: "15m",
      candlesHtf: candles15m,
      saveToHistory: false,
      cushionMode: "htfBull",
      costModel: { feePctPerSide: 0.075, slippagePctPerFill: 0.03 },
    });

    assert.ok(
      costC1.summary.netPnlPct < base.summary.netPnlPct,
      `Cost model C1 must produce strictly lower net PnL (C1: ${costC1.summary.netPnlPct}%, base: ${base.summary.netPnlPct}%)`
    );
    console.log(`✓ Cost model verified: {0,0} matches base, C1 reduces net PnL from ${base.summary.netPnlPct}% to ${costC1.summary.netPnlPct}%`);
  }

  // 2. onlyEntryIdx test
  {
    // Find the entry index of the first trade from base simulation
    const base = BacktestService.runMaFanSimulation(candles5m, {
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
      breakevenFeeBufferPct: 0.05,
      supervisorTimeframe: "15m",
      candlesHtf: candles15m,
      saveToHistory: false,
      cushionMode: "htfBull",
    });

    const firstTrade = base.trades[0]!;
    const entryBarIdx = candles5m.findIndex((c) => c.time === firstTrade.entryTime);
    assert.ok(entryBarIdx >= 0, "Could not locate first trade entry candle");

    const singleRun = BacktestService.runMaFanSimulation(candles5m, {
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
      breakevenFeeBufferPct: 0.05,
      supervisorTimeframe: "15m",
      candlesHtf: candles15m,
      saveToHistory: false,
      cushionMode: "htfBull",
      onlyEntryIdx: entryBarIdx,
    });

    assert.strictEqual(singleRun.trades.length, 1, `onlyEntryIdx should produce exactly 1 trade, got ${singleRun.trades.length}`);
    assert.strictEqual(singleRun.trades[0]!.entryTime, firstTrade.entryTime, "Single trade entry time must match first trade");
    assert.strictEqual(singleRun.trades[0]!.exitTime, firstTrade.exitTime, "Single trade exit time must match first trade");
    console.log(`✓ onlyEntryIdx verified: successfully executed isolated trade at bar ${entryBarIdx}`);
  }

  // 3. exitInfoLag test
  {
    const lag0 = BacktestService.runMaFanSimulation(candles5m, {
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
      breakevenFeeBufferPct: 0.05,
      supervisorTimeframe: "15m",
      candlesHtf: candles15m,
      saveToHistory: false,
      cushionMode: "htfBull",
      exitInfoLag: 0,
    });

    const lag1 = BacktestService.runMaFanSimulation(candles5m, {
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
      breakevenFeeBufferPct: 0.05,
      supervisorTimeframe: "15m",
      candlesHtf: candles15m,
      saveToHistory: false,
      cushionMode: "htfBull",
      exitInfoLag: 1,
    });

    console.log(`✓ exitInfoLag=0 trades: ${lag0.trades.length}, NetPnL: ${lag0.summary.netPnlPct}%`);
    console.log(`✓ exitInfoLag=1 trades: ${lag1.trades.length}, NetPnL: ${lag1.summary.netPnlPct}%`);
  }

  console.log("🎉 ALL OPTIONS TESTS PASSED!");
}

main().catch((err) => {
  console.error("Options verification failed:", err);
  process.exit(1);
});
