import { BacktestService } from "../src/backtest-service.js";

async function testUniverseAndTp() {
  console.log("=== Testing Universe Size (Top 20 vs Top 50) and TP/SL configurations ===");
  
  // 1. Top 20 with 3 slots, 120 days
  const res20 = await BacktestService.runMaFanPortfolioRotationWrapper({
    portfolioMode: "mafan_portfolio",
    quoteAsset: "USDT",
    maxUniversePairs: 20,
    limit: 34560,
    initialCapital: 200,
    maxSlots: 3,
    tp1TargetMode: "EMA200",
    lockBreakevenAtEma200: true,
    partialTpAtEma200: true,
    maxDisasterSlPct: 4,
    downtrendSitOutMode: "dual",
    rankBy: "COMPOSITE_QUALITY",
  });

  console.log(`Top 20 (SL 4%): Net PnL = ${res20.summary.netPnlPct >= 0 ? "+" : ""}${res20.summary.netPnlPct.toFixed(2)}% ($${res20.summary.netPnlQuote.toFixed(2)}), WinRate = ${res20.summary.tradeWinRate.toFixed(1)}%, MaxDD = -${res20.summary.maxPortfolioDrawdownPct.toFixed(2)}%, PF = ${res20.summary.profitFactor.toFixed(2)}, Trades = ${res20.summary.totalTrades}`);

  // 2. Top 20 with TP1 = none (let full position ride to Full Bullish Fan!)
  const res20Ride = await BacktestService.runMaFanPortfolioRotationWrapper({
    portfolioMode: "mafan_portfolio",
    quoteAsset: "USDT",
    maxUniversePairs: 20,
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

  console.log(`Top 20 (Full Trend Ride, SL 4%): Net PnL = ${res20Ride.summary.netPnlPct >= 0 ? "+" : ""}${res20Ride.summary.netPnlPct.toFixed(2)}% ($${res20Ride.summary.netPnlQuote.toFixed(2)}), WinRate = ${res20Ride.summary.tradeWinRate.toFixed(1)}%, MaxDD = -${res20Ride.summary.maxPortfolioDrawdownPct.toFixed(2)}%, PF = ${res20Ride.summary.profitFactor.toFixed(2)}, Trades = ${res20Ride.summary.totalTrades}`);
}

testUniverseAndTp().catch(console.error);
