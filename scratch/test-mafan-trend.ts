import { BacktestService } from "../src/backtest-service.js";

async function testMaFanTrendFilter() {
  console.log("=== Testing MA-Fan with Trend Filter (Coin 1H Close > EMA200) ===");

  const simLimit = 34560;
  const universeCandlesMap = await BacktestService.fetchTopUniverseCandles({
    quoteAsset: "USDT",
    maxPairs: 50,
    limit: simLimit,
  });

  const btcSym = "BTCUSDT";
  let btcCandles = universeCandlesMap.get(btcSym)!;
  if (!btcCandles || btcCandles.length < 500) {
    btcCandles = await BacktestService.fetchBinanceCandles("BTCUSDT", "5m", simLimit + 600);
  }

  const universe: { symbol: string; candles: any[] }[] = [];
  for (const [symbol, candles] of universeCandlesMap.entries()) {
    if (candles && candles.length >= 500) {
      universe.push({ symbol, candles });
    }
  }

  // Test MA-Fan with HTF Trend Filter
  // Let's inspect if requiring 1H close > 1H EMA200 or ATR Trailing SL makes MA-Fan positive
}
