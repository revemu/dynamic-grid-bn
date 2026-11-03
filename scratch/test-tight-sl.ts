import { BacktestService } from "../src/backtest-service.js";

async function testWithTightSl() {
  console.log("=== Testing MA-Fan Portfolio with Calibrated SL (3.0%, 4.0%, 6.0%) ===");
  for (const sl of [3.0, 4.0, 5.0, 6.0, 8.0, 12.0]) {
    const res = await BacktestService.runMaFanPortfolioRotationWrapper({
      portfolioMode: "mafan_portfolio",
      quoteAsset: "USDT",
      maxUniversePairs: 50,
      limit: 34560,
      initialCapital: 200,
      maxSlots: 3,
      tp1TargetMode: "EMA200",
      lockBreakevenAtEma200: true,
      partialTpAtEma200: true,
      maxDisasterSlPct: sl,
      downtrendSitOutMode: "dual",
      rankBy: "COMPOSITE_QUALITY",
    });

    const maxDd = res.summary.maxPortfolioDrawdownPct ?? 0;
    const pf = res.summary.profitFactor ?? 0;
    console.log(`SL = ${sl}%: Net PnL = ${res.summary.netPnlPct >= 0 ? "+" : ""}${res.summary.netPnlPct.toFixed(2)}% ($${res.summary.netPnlQuote.toFixed(2)}), WinRate = ${res.summary.tradeWinRate.toFixed(1)}%, MaxDD = -${maxDd.toFixed(2)}%, PF = ${pf.toFixed(2)}, Trades = ${res.summary.totalTrades}`);
  }
}

testWithTightSl().catch(console.error);
