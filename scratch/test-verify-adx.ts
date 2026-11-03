import { BacktestService } from "../src/backtest-service.js";
import { Candle } from "../src/strategy/ma-fan/types.js";
import { calcEMA } from "../src/strategy/ma-fan/ribbon.js";
import { calcADXSingle } from "./test-adx-val.js";

async function verifyHypothesis() {
  console.log("=== Testing Why Low ADX Failed & Comparing 1H EMA200 vs ADX ===");
  const tickers = ["SOXLBUSDT", "INTCBUSDT", "SNDKBUSDT", "PEPEUSDT", "NEARUSDT"];
  for (const sym of tickers) {
    try {
      const c = await BacktestService.fetchBinanceCandles(sym, "5m", 8640);
      const c1h = BacktestService.aggregateCandles(c, 60);
      const closes1h = c1h.map(x => x.close);
      const ema200_1h = calcEMA(closes1h, 200);
      const last1h = c1h[c1h.length - 1];
      const lastEma = ema200_1h[ema200_1h.length - 1];
      const isAboveEma200 = last1h.close >= lastEma;
      const adx5m = calcADXSingle(c, c.length - 1, 14);
      const adx1h = calcADXSingle(c1h, c1h.length - 1, 14);

      console.log(`Coin: ${sym}`);
      console.log(`   1H Close: ${last1h.close}, 1H EMA200: ${lastEma.toFixed(4)} -> ${isAboveEma200 ? "🟢 ABOVE EMA200 (Uptrend)" : "🔴 BELOW EMA200 (Macro Downtrend)"}`);
      console.log(`   5m ADX: ${adx5m.toFixed(1)}, 1H ADX: ${adx1h.toFixed(1)}`);
    } catch (e) {}
  }
}

verifyHypothesis().catch(console.error);
