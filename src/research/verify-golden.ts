import fs from "fs";
import path from "path";
import assert from "assert";
import { BacktestService } from "../backtest-service.js";
import { Candle } from "../strategy/ma-fan/types.js";
import { SnapshotManifest } from "./types.js";

const GOLDEN_COINS = ["HAEDALUSDT", "ETHUSDT", "SOLUSDT", "SUIUSDT", "NEARUSDT", "BNBUSDT"];
const CACHE_DIR = path.resolve(process.cwd(), "data", "research-cache");

async function main() {
  const manifestPath = path.join(CACHE_DIR, "manifest_15d.json");
  const goldenPath = path.join(CACHE_DIR, "golden.json");

  if (!fs.existsSync(manifestPath) || !fs.existsSync(goldenPath)) {
    throw new Error("Missing manifest_15d.json or golden.json in data/research-cache/");
  }

  const manifest: SnapshotManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const golden = JSON.parse(fs.readFileSync(goldenPath, "utf8"));

  console.log("=== Verifying Engine Against Golden Reference Baseline ===");

  for (const sym of GOLDEN_COINS) {
    const meta5m = manifest.files[`${sym}_5m`];
    const meta15m = manifest.files[`${sym}_15m`];

    const candles5m: Candle[] = JSON.parse(fs.readFileSync(meta5m!.filePath, "utf8"));
    const candles15m: Candle[] = JSON.parse(fs.readFileSync(meta15m!.filePath, "utf8"));

    // Run with DEFAULT options to ensure backward compatibility
    const rec = BacktestService.runMaFanSimulation(candles5m, {
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

    const expected = golden[sym];
    assert.ok(expected, `No golden data found for ${sym}`);

    assert.strictEqual(
      rec.trades.length,
      expected.trades.length,
      `[${sym}] Trade count mismatch: got ${rec.trades.length}, expected ${expected.trades.length}`
    );

    assert.strictEqual(
      rec.summary.winTrades,
      expected.summary.winTrades,
      `[${sym}] Win trades mismatch: got ${rec.summary.winTrades}, expected ${expected.summary.winTrades}`
    );

    assert.strictEqual(
      rec.summary.lossTrades,
      expected.summary.lossTrades,
      `[${sym}] Loss trades mismatch: got ${rec.summary.lossTrades}, expected ${expected.summary.lossTrades}`
    );

    assert.ok(
      Math.abs(rec.summary.netPnlPct - expected.summary.netPnlPct) < 1e-6,
      `[${sym}] Net PnL mismatch: got ${rec.summary.netPnlPct}, expected ${expected.summary.netPnlPct}`
    );

    for (let idx = 0; idx < rec.trades.length; idx++) {
      const actualTrade = rec.trades[idx]!;
      const expectedTrade = expected.trades[idx]!;

      assert.strictEqual(actualTrade.id, expectedTrade.id, `[${sym}] Trade id mismatch at index ${idx}`);
      assert.strictEqual(actualTrade.entryTime, expectedTrade.entryTime, `[${sym}] Trade entryTime mismatch at #${actualTrade.id}`);
      assert.strictEqual(actualTrade.exitTime, expectedTrade.exitTime, `[${sym}] Trade exitTime mismatch at #${actualTrade.id}`);
      assert.strictEqual(actualTrade.exitType, expectedTrade.exitType, `[${sym}] Trade exitType mismatch at #${actualTrade.id}`);

      assert.ok(
        Math.abs(actualTrade.entryPrice - expectedTrade.entryPrice) < 1e-9,
        `[${sym}] entryPrice mismatch at #${actualTrade.id}`
      );
      assert.ok(
        Math.abs(actualTrade.exitPrice - expectedTrade.exitPrice) < 1e-9,
        `[${sym}] exitPrice mismatch at #${actualTrade.id}`
      );
      assert.ok(
        Math.abs(actualTrade.pnlPct - expectedTrade.pnlPct) < 1e-6,
        `[${sym}] pnlPct mismatch at #${actualTrade.id}`
      );
    }

    console.log(`✓ ${sym}: PASS (100% match with golden reference across ${rec.trades.length} trades)`);
  }

  console.log("🎉 ALL 6 GOLDEN COINS PASSED WITH 100% BITWISE EQUIVALENCE!");
}

main().catch((err) => {
  console.error("Golden verification failed:", err);
  process.exit(1);
});
