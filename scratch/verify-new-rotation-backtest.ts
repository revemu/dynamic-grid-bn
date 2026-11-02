import { BacktestService } from "../src/backtest-service.js";

const BS: any = BacktestService;

async function run() {
  console.log("🚀 Running 30-Day Autonomous Multi-Pair Rotation Backtest on Top 50 Universe...");
  console.log("Settings: Quote=USDT, Universe=50, Bars=8640 (30 Days), Cooldown=180m, ScoreMargin=15%, Zones=1, Gate=ON, Calibrated Exit\n");

  const startTime = Date.now();
  const res = await BS.runMultiPairRotationSimulation({
    quoteAsset: "USDT",
    maxUniversePairs: 50,
    limit: 8640,
    initialCapital: 100,
    rotationIntervalMinutes: 180,
    rotationScoreMarginPct: 15,
    capitalZones: 1,
    signalInvalidationMode: "calibrated",
    enableBtcMacroGate: true,
  });
  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`\n✅ Simulation finished in ${elapsedSec}s!\n`);
  console.log("================== SUMMARY KPI ==================");
  console.log(`Portfolio Net PnL   : ${res.summary.netPnlPct >= 0 ? "+" : ""}${res.summary.netPnlPct.toFixed(2)}% ($${res.summary.netPnlQuote >= 0 ? "+" : ""}${res.summary.netPnlQuote.toFixed(2)})`);
  console.log(`Initial ➔ Final     : $${res.summary.initialCapital.toFixed(2)} ➔ $${res.summary.finalEquity.toFixed(2)}`);
  console.log(`Max Portfolio DD    : -${res.summary.maxPortfolioDrawdownPct.toFixed(2)}%`);
  console.log(`Rotations / Legs    : ${res.summary.totalRotations} rotations (${res.summary.totalLegs} legs), Leg Win Rate: ${res.summary.legWinRate.toFixed(1)}%`);
  console.log(`Total Trades        : ${res.summary.totalTrades} trades, Win Rate: ${res.summary.tradeWinRate.toFixed(1)}%`);
  console.log(`Alpha vs BTC B&H    : ${res.summary.alphaVsBenchmarkPct >= 0 ? "+" : ""}${res.summary.alphaVsBenchmarkPct.toFixed(2)}% (BTC B&H: ${res.summary.benchmarkBtcBuyHoldPct?.toFixed(2)}%)`);
  if (res.summary.benchmarkEqualWeightBuyHoldPct !== undefined) {
    console.log(`Alpha vs Market B&H : ${(res.summary.netPnlPct - res.summary.benchmarkEqualWeightBuyHoldPct).toFixed(2)}% (Market B&H: ${res.summary.benchmarkEqualWeightBuyHoldPct.toFixed(2)}%)`);
  }

  console.log("\n================== ROTATION LEGS JOURNEY ==================");
  const legTable = res.legs.map((l: any) => ({
    leg: `#${l.legIndex}`,
    symbol: l.symbol,
    duration: `${l.durationHours}h`,
    trigger: l.triggerReason,
    score: `${l.entryScore}/100`,
    pnlPct: `${l.netPnlPct >= 0 ? "+" : ""}${l.netPnlPct.toFixed(2)}%`,
    pnlQuote: `${l.netPnlQuote >= 0 ? "+$" : "-$"}${Math.abs(l.netPnlQuote).toFixed(2)}`,
    trades: `${l.winCount}/${l.tradesCount} (${l.winRate.toFixed(0)}%)`,
  }));
  console.table(legTable);
}

run().catch(console.error);
