import { BacktestService } from "../src/backtest-service.js";
import { Candle } from "../src/strategy/ma-fan/types.js";
import { calcADXSingle } from "./test-adx-val.js";

async function runTest() {
  console.log("Testing Dynamic Grid with ADX Filter...");
  const limit = 8640;
  
  const tickerRes = await fetch("https://api.binance.com/api/v3/ticker/24hr");
  const allTickers = await tickerRes.json();
  const usdt = allTickers.filter((t: any) => t.symbol.endsWith("USDT") && !t.symbol.includes("UP") && !t.symbol.includes("DOWN"));
  usdt.sort((a: any, b: any) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume));
  const universe = usdt.slice(0, 25);
  
  const universeCandles = new Map<string, Candle[]>();
  for (const t of universe) {
    try {
      const c = await BacktestService.fetchBinanceCandles(t.symbol, "5m", limit);
      if (c && c.length >= limit - 500) {
        universeCandles.set(t.symbol, c);
      }
    } catch (e) {}
  }
  console.log(`Loaded ${universeCandles.size} pairs.`);

  let countAdxLow = 0;
  let countAdxHigh = 0;
  const sampleTimes = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000];

  for (const [sym, candles] of universeCandles.entries()) {
    for (const idx of sampleTimes) {
      if (idx < candles.length) {
        const adx = calcADXSingle(candles, idx, 14);
        if (adx < 25) countAdxLow++;
        else countAdxHigh++;
      }
    }
  }

  console.log(`Sampled ADX across top pairs: ADX < 25 (Sideways) = ${countAdxLow} (${((countAdxLow / (countAdxLow + countAdxHigh)) * 100).toFixed(1)}%), ADX >= 25 (Trending) = ${countAdxHigh} (${((countAdxHigh / (countAdxLow + countAdxHigh)) * 100).toFixed(1)}%)`);
}

runTest().catch(console.error);
