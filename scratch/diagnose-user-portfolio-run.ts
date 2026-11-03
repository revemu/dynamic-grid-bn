import { BacktestService } from "../src/backtest-service.js";

async function diagnose() {
  console.log("=== Running exact user backtest to diagnose why PnL is -11.80% with 70.8% Win Rate ===");
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
    maxDisasterSlPct: 12,
    downtrendSitOutMode: "dual",
    rankBy: "COMPOSITE_QUALITY",
  });

  console.log("\nSummary:");
  console.log(`Initial: $${res.summary.initialCapital}, Final: $${res.summary.finalEquity}`);
  console.log(`Net PnL: ${res.summary.netPnlPct.toFixed(2)}%, Trades: ${res.summary.totalTrades}, WinRate: ${res.summary.tradeWinRate.toFixed(1)}%, PF: ${res.summary.profitFactor.toFixed(2)}`);

  console.log("\nInspecting all trades by PnL:");
  const trades = res.legs.map(l => ({
    symbol: l.symbol,
    pnlPct: l.netPnlPct,
    pnlQuote: l.netPnlQuote,
    exitType: l.trades[0]?.exitType ?? "UNKNOWN",
    holdingBars: l.trades[0]?.holdingBars ?? 0,
  }));

  const wins = trades.filter(t => t.pnlPct > 0);
  const losses = trades.filter(t => t.pnlPct <= 0);

  const avgWinPct = wins.reduce((a, b) => a + b.pnlPct, 0) / (wins.length || 1);
  const avgLossPct = losses.reduce((a, b) => a + b.pnlPct, 0) / (losses.length || 1);
  const totalWinQuote = wins.reduce((a, b) => a + b.pnlQuote, 0);
  const totalLossQuote = losses.reduce((a, b) => a + b.pnlQuote, 0);

  console.log(`\nWins (${wins.length}): Total +$${totalWinQuote.toFixed(2)}, Avg +${avgWinPct.toFixed(2)}%`);
  console.log(`Losses (${losses.length}): Total -$${Math.abs(totalLossQuote).toFixed(2)}, Avg ${avgLossPct.toFixed(2)}%`);

  console.log("\nTop 10 Biggest Losses:");
  const sortedLosses = [...losses].sort((a, b) => a.pnlPct - b.pnlPct);
  sortedLosses.slice(0, 10).forEach((t, i) => {
    console.log(`   ${i + 1}. ${t.symbol}: PnL=${t.pnlPct.toFixed(2)}% (-$${Math.abs(t.pnlQuote).toFixed(2)}), Reason=${t.exitType}, Bars=${t.holdingBars}`);
  });

  console.log("\nTop 10 Biggest Wins:");
  const sortedWins = [...wins].sort((a, b) => b.pnlPct - a.pnlPct);
  sortedWins.slice(0, 10).forEach((t, i) => {
    console.log(`   ${i + 1}. ${t.symbol}: PnL=+${t.pnlPct.toFixed(2)}% (+$${t.pnlQuote.toFixed(2)}), Reason=${t.exitType}, Bars=${t.holdingBars}`);
  });
}

diagnose().catch(console.error);
