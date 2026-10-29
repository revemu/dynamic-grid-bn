import fs from "fs";
import path from "path";
import { BacktestService } from "../backtest-service.js";
import { Candle } from "../strategy/ma-fan/types.js";
import { SnapshotManifest } from "./types.js";

const GOLDEN_COINS = ["HAEDALUSDT", "ETHUSDT", "SOLUSDT", "SUIUSDT", "NEARUSDT", "BNBUSDT"];
const CACHE_DIR = path.resolve(process.cwd(), "data", "research-cache");

async function main() {
  const manifestPath = path.join(CACHE_DIR, "manifest_15d.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Manifest not found at ${manifestPath}. Run Phase 1 snapshot first.`);
  }

  const manifest: SnapshotManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const goldenOutput: Record<string, any> = {};

  console.log("=== Generating Golden Reference Test Baseline ===");

  for (const sym of GOLDEN_COINS) {
    const meta5m = manifest.files[`${sym}_5m`];
    const meta15m = manifest.files[`${sym}_15m`];

    if (!meta5m || !meta15m || !fs.existsSync(meta5m.filePath) || !fs.existsSync(meta15m.filePath)) {
      throw new Error(`Missing candle cache files for ${sym}`);
    }

    const candles5m: Candle[] = JSON.parse(fs.readFileSync(meta5m.filePath, "utf8"));
    const candles15m: Candle[] = JSON.parse(fs.readFileSync(meta15m.filePath, "utf8"));

    // Run baseline simulation matching Section 4.1 parameters
    // Note: saveToHistory: false, spreadThreshold: 0.25, cushionMode: "htfBull"
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

    const strippedTrades = rec.trades.map((t) => ({
      id: t.id,
      entryTime: t.entryTime,
      entryPrice: t.entryPrice,
      exitTime: t.exitTime,
      exitPrice: t.exitPrice,
      exitType: t.exitType,
      pnlPct: Number(t.pnlPct.toFixed(6)),
      pnlQuote: Number(t.pnlQuote.toFixed(6)),
      holdingBars: t.holdingBars,
    }));

    goldenOutput[sym] = {
      symbol: sym,
      summary: rec.summary,
      trades: strippedTrades,
    };

    console.log(`✓ ${sym}: ${rec.trades.length} trades, WinRate ${rec.summary.winRate.toFixed(1)}%, NetPnL ${rec.summary.netPnlPct.toFixed(2)}%`);
  }

  const goldenPath = path.join(CACHE_DIR, "golden.json");
  fs.writeFileSync(goldenPath, JSON.stringify(goldenOutput, null, 2), "utf8");
  console.log(`🎉 Golden Reference successfully created at ${goldenPath}`);
}

main().catch((err) => {
  console.error("Fatal error creating golden reference:", err);
  process.exit(1);
});
