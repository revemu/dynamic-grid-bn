import { BacktestService } from "../src/backtest-service.js";

async function testGridRotation() {
  console.log("=== Testing Dynamic Grid Sequential Rotation (120 Days / 34,560 bars 5m) ===");
  try {
    const gridRes = await BacktestService.runMultiPairRotationSimulation({
      portfolioMode: "sequential_grid",
      quoteAsset: "USDT",
      maxUniversePairs: 50,
      limit: 34560,
      initialCapital: 200,
      downtrendSitOutMode: "dual",
      rotationCooldownMinutes: 15,
      gridHtfGovernor: "1h_ema200",
      gridMaxChannelPos: 0.35,
    });
    console.log(`[Grid Rotation]: Net PnL = ${gridRes.summary.netPnlPct >= 0 ? "+" : ""}${gridRes.summary.netPnlPct.toFixed(2)}% ($${gridRes.summary.netPnlQuote.toFixed(2)}), WR = ${gridRes.summary.tradeWinRate.toFixed(1)}%, MaxDD = -${gridRes.summary.maxPortfolioDrawdownPct.toFixed(2)}%, PF = ${gridRes.summary.profitFactor.toFixed(2)}, Trades = ${gridRes.summary.totalTrades}, Legs = ${gridRes.legs.length}`);
  } catch (e: any) {
    console.error("Grid rotation error:", e.message);
  }
}

testGridRotation().catch(console.error);
