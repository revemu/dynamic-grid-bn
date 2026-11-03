import { BacktestService } from "../src/backtest-service.js";

async function testPositiveStrategies() {
  console.log("=== Testing Strategies for Real Alpha / Positive Profit ===");

  const simLimit = 34560; // 120 days
  const quote = "USDT";
  const universeCandlesMap = await BacktestService.fetchTopUniverseCandles({
    quoteAsset: quote,
    maxPairs: 50,
    limit: simLimit,
  });

  const btcSym = "BTCUSDT";
  let btcCandles = universeCandlesMap.get(btcSym)!;
  if (!btcCandles || btcCandles.length < 500) {
    btcCandles = await BacktestService.fetchBinanceCandles("BTCUSDT", "5m", simLimit + 600);
  }

  // Filter out meme/penny tokens
  const qualityPairs: { symbol: string; candles: any[] }[] = [];
  for (const [symbol, candles] of universeCandlesMap.entries()) {
    if (candles && candles.length >= 500) {
      const isMemePenny = ["1000CATUSDT", "PEPEUSDT", "MARSCOINUSDT", "HAEDALUSDT", "TRUMPUSDT", "BMTUSDT", "MEGAUSDT"].includes(symbol);
      if (!isMemePenny) {
        qualityPairs.push({ symbol, candles });
      }
    }
  }
  console.log(`Quality pairs: ${qualityPairs.length}`);

  // 1. Let's test MA-Fan with HTF Governor (Coin 1H close must be ABOVE 1H EMA200 at entry!)
  console.log("\n--- TEST: MA-Fan with Coin 1H Trend Confirmation (Close > 1H EMA200) ---");
  // Let's modify or test simulation with trend filter
  // Let's check how many trades and what PnL happens if we only buy coins whose 1H close > 1H EMA200
  
  // Let's also test Dynamic Grid Rotation on this 120-day dataset!
  console.log("\n--- TEST: Dynamic Grid Rotation on 120 days (Sequential Rotation) ---");
  try {
    const gridRes = await BacktestService.runMultiPairRotationBacktest({
      portfolioMode: "sequential_grid",
      quoteAsset: "USDT",
      maxUniversePairs: 50,
      limit: 34560,
      initialCapital: 200,
      downtrendSitOutMode: "dual",
      rotationCooldownMinutes: 15,
      // Default uses 1H EMA200 Governor and posRatio <= 0.35!
    });
    console.log(`[Grid Rotation]: Net PnL = ${gridRes.summary.netPnlPct >= 0 ? "+" : ""}${gridRes.summary.netPnlPct.toFixed(2)}% ($${gridRes.summary.netPnlQuote.toFixed(2)}), WR = ${gridRes.summary.tradeWinRate.toFixed(1)}%, MaxDD = -${gridRes.summary.maxPortfolioDrawdownPct.toFixed(2)}%, PF = ${gridRes.summary.profitFactor.toFixed(2)}, Trades = ${gridRes.summary.totalTrades}`);
  } catch (e: any) {
    console.error("Grid rotation error:", e.message);
  }
}

testPositiveStrategies().catch(console.error);
