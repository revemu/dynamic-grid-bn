import { BacktestService } from "../src/backtest-service.js";

async function runExactComparison() {
  console.log("=== Testing TP1 Modes and SL on Exact Same Top 50 Universe ===");

  // 1. tp1TargetMode = "none" (Full Bullish Fan Trend Ride) with SL 3%
  const resFull3 = await BacktestService.runMaFanPortfolioRotationWrapper({
    portfolioMode: "mafan_portfolio",
    quoteAsset: "USDT",
    maxUniversePairs: 50,
    limit: 34560,
    initialCapital: 200,
    maxSlots: 3,
    tp1TargetMode: "none",
    lockBreakevenAtEma200: false,
    partialTpAtEma200: false,
    maxDisasterSlPct: 3,
    downtrendSitOutMode: "dual",
    rankBy: "COMPOSITE_QUALITY",
  });

  console.log(`[Full Fan, SL 3%]: Net PnL = ${resFull3.summary.netPnlPct >= 0 ? "+" : ""}${resFull3.summary.netPnlPct.toFixed(2)}% ($${resFull3.summary.netPnlQuote.toFixed(2)}), WinRate = ${resFull3.summary.tradeWinRate.toFixed(1)}%, MaxDD = -${resFull3.summary.maxPortfolioDrawdownPct.toFixed(2)}%, PF = ${resFull3.summary.profitFactor.toFixed(2)}, Trades = ${resFull3.summary.totalTrades}`);

  // 2. tp1TargetMode = "none" with SL 4%
  const resFull4 = await BacktestService.runMaFanPortfolioRotationWrapper({
    portfolioMode: "mafan_portfolio",
    quoteAsset: "USDT",
    maxUniversePairs: 50,
    limit: 34560,
    initialCapital: 200,
    maxSlots: 3,
    tp1TargetMode: "none",
    lockBreakevenAtEma200: false,
    partialTpAtEma200: false,
    maxDisasterSlPct: 4,
    downtrendSitOutMode: "dual",
    rankBy: "COMPOSITE_QUALITY",
  });

  console.log(`[Full Fan, SL 4%]: Net PnL = ${resFull4.summary.netPnlPct >= 0 ? "+" : ""}${resFull4.summary.netPnlPct.toFixed(2)}% ($${resFull4.summary.netPnlQuote.toFixed(2)}), WinRate = ${resFull4.summary.tradeWinRate.toFixed(1)}%, MaxDD = -${resFull4.summary.maxPortfolioDrawdownPct.toFixed(2)}%, PF = ${resFull4.summary.profitFactor.toFixed(2)}, Trades = ${resFull4.summary.totalTrades}`);
}

runExactComparison().catch(console.error);
