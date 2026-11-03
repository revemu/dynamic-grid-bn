import { BacktestService } from "../src/backtest-service.js";

async function exploreMaFanOptimization() {
  console.log("=== Finding Optimal MA-Fan Portfolio Settings ===");

  const simLimit = 34560;
  const quote = "USDT";
  const universeCandlesMap = await BacktestService.fetchTopUniverseCandles({
    quoteAsset: quote,
    maxPairs: 50,
    limit: simLimit,
  });

  const btcSym = "BTCUSDT";
  let btcCandles = universeCandlesMap.get(btcSym);
  if (!btcCandles || btcCandles.length < 500) {
    btcCandles = await BacktestService.fetchBinanceCandles("BTCUSDT", "5m", simLimit + 600);
  }

  const universe: { symbol: string; candles: any[] }[] = [];
  for (const [symbol, candles] of universeCandlesMap.entries()) {
    if (candles && candles.length >= 500) {
      universe.push({ symbol, candles });
    }
  }
  console.log(`Loaded ${universe.length} universe pairs`);

  console.log("\n--- TEST 1: Baseline & Calibrated SL with EMA200 TP1 ---");
  for (const sl of [2.5, 3.0, 3.5, 4.0, 5.0, 8.0, 12.0]) {
    const res = BacktestService.runMaFanPortfolioSimulation({
      universe,
      btcCandles,
      maxSlots: 3,
      initialCapital: 200,
      requireCoin1hRsi40: true,
      minBuyVolRatio12: 1.3,
      minRelStrengthVsBtc24h: -1.0,
      rankBy: "COMPOSITE_QUALITY",
      tp1TargetMode: "EMA200",
      lockBreakevenAtEma200: true,
      partialTpAtEma200: true,
      maxDisasterSlPct: sl,
      downtrendSitOutMode: "dual",
    });
    console.log(`SL ${sl}%: PnL = ${res.netPnlPct >= 0 ? "+" : ""}${res.netPnlPct.toFixed(2)}% ($${res.netPnlQuote.toFixed(2)}), WR = ${res.winRate}%, MaxDD = ${res.maxDrawdownPct.toFixed(2)}%, PF = ${res.profitFactor}, Trades = ${res.totalTrades}`);
  }

  console.log("\n--- TEST 2: Filter Universe (Exclude Ultra-Volatile Meme / Penny Tokens) ---");
  // Let's identify which coins contributed to the biggest losses in the 12% baseline run
  const resBase = BacktestService.runMaFanPortfolioSimulation({
    universe,
    btcCandles,
    maxSlots: 3,
    initialCapital: 200,
    requireCoin1hRsi40: true,
    minBuyVolRatio12: 1.3,
    minRelStrengthVsBtc24h: -1.0,
    rankBy: "COMPOSITE_QUALITY",
    tp1TargetMode: "EMA200",
    lockBreakevenAtEma200: true,
    partialTpAtEma200: true,
    maxDisasterSlPct: 12,
    downtrendSitOutMode: "dual",
  });

  const pairPnl = new Map<string, { trades: number; pnlPctSum: number; wins: number; losses: number }>();
  for (const t of resBase.trades) {
    const p = pairPnl.get(t.symbol) || { trades: 0, pnlPctSum: 0, wins: 0, losses: 0 };
    p.trades++;
    p.pnlPctSum += t.pnlPct;
    if (t.isWin) p.wins++; else p.losses++;
    pairPnl.set(t.symbol, p);
  }

  const sortedPairs = Array.from(pairPnl.entries()).sort((a, b) => a[1].pnlPctSum - b[1].pnlPctSum);
  console.log("Worst 10 coins by cumulative PnL:");
  for (const [sym, p] of sortedPairs.slice(0, 10)) {
    console.log(`  ${sym}: ${p.pnlPctSum >= 0 ? "+" : ""}${p.pnlPctSum.toFixed(2)}% (${p.trades} trades: ${p.wins}W / ${p.losses}L)`);
  }

  console.log("\nTop 10 coins by cumulative PnL:");
  for (const [sym, p] of sortedPairs.slice(-10).reverse()) {
    console.log(`  ${sym}: +${p.pnlPctSum.toFixed(2)}% (${p.trades} trades: ${p.wins}W / ${p.losses}L)`);
  }
}

exploreMaFanOptimization().catch(console.error);
