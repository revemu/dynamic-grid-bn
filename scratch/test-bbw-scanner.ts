import { BacktestService } from "../src/backtest-service.js";
import { Candle } from "../src/strategy/ma-fan/types.js";
import { calcBollingerBands, calcStochastic } from "./test-bb-rsi-stoch.js";

async function testBbBandwidthScanner() {
  console.log("=== Testing Bollinger Bandwidth & Stoch Hook in Market Scanner ===");
  // Let's test on 30 pairs
  const tickerRes = await fetch("https://api.binance.com/api/v3/ticker/24hr");
  const allTickers = await tickerRes.json();
  const usdt = allTickers
    .filter((t: any) => t.symbol.endsWith("USDT") && !t.symbol.includes("UP") && !t.symbol.includes("DOWN"))
    .sort((a: any, b: any) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, 30);

  let passedCoins = 0;
  for (const t of usdt) {
    try {
      const c = await BacktestService.fetchBinanceCandles(t.symbol, "5m", 1000);
      if (!c || c.length < 500) continue;

      const c1h = BacktestService.aggregateCandles(c, 60);
      const bb1h = calcBollingerBands(c1h, 20, 2.0);
      const bb5m = calcBollingerBands(c, 20, 2.0);
      const stoch5m = calcStochastic(c, 14, 3);

      const last1h = c1h.length - 1;
      const last5m = c.length - 1;

      const bw1h = bb1h.bandwidth[last1h];
      const percentB5m = bb5m.percentB[last5m];
      const stochK = stoch5m.stochK[last5m];
      const stochD = stoch5m.stochD[last5m];
      const isHook = stochK >= stochD && stochK <= 35;

      const isHealthyRange = bw1h >= 2.0 && bw1h <= 10.0;
      const isDiscountZone = percentB5m <= 0.35;

      if (isHealthyRange && isDiscountZone && isHook) {
        console.log(`🎯 [QUALIFIED] ${t.symbol}: 1H BBW=${bw1h.toFixed(2)}%, 5m %B=${percentB5m.toFixed(2)}, Stoch K=${stochK.toFixed(1)}, D=${stochD.toFixed(1)}`);
        passedCoins++;
      }
    } catch (e) {}
  }
  console.log(`Total qualified coins right now: ${passedCoins}/30`);
}

testBbBandwidthScanner().catch(console.error);
