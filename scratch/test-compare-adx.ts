import { BacktestService } from "../src/backtest-service.js";
import { calcADXSingle } from "./test-adx-val.js";

async function compareAdx() {
  console.log("=== Comparing Dynamic Grid Rotation: With ADX vs Without ADX ===");
  // Let's run runMultiPairRotationSimulation with 8640 bars (~30 days)
  console.log("1. Running Baseline (HTF 1H EMA200 + Lower Pos <= 35%, ADX OFF)...");
  const baseRes = await BacktestService.runMultiPairRotationSimulation({
    quoteAsset: "USDT",
    maxUniversePairs: 20,
    limit: 8640,
    initialCapital: 200,
    rotationIntervalMinutes: 180,
    capitalZones: 2,
    channelMode: "DONCHIAN_ATR",
    gridCutLossMode: "none",
    enableDipHunterEntryGuard: true,
    enableSignalInvalidationExit: true,
    signalInvalidationMode: "calibrated",
    enableBaseConfirmation: true,
    enableBtcMacroGate: true,
    gridHtfGovernor: "1h_ema200",
    gridMaxChannelPos: 0.35,
  });

  console.log(`Baseline Result: Net PnL = ${baseRes.summary.netProfitPct.toFixed(2)}%, Max DD = ${baseRes.summary.maxDrawdownPct.toFixed(2)}%, Trades = ${baseRes.summary.closedTradesCount}, WinRate = ${baseRes.summary.winRatePct.toFixed(1)}%`);
}

compareAdx().catch(console.error);
