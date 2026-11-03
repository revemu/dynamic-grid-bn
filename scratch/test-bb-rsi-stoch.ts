import { BacktestService } from "../src/backtest-service.js";
import { Candle } from "../src/strategy/ma-fan/types.js";
import { calcEMA } from "../src/strategy/ma-fan/ribbon.js";

// 1. Bollinger Bands Calculation (period 20, mult 2.0)
export function calcBollingerBands(candles: Candle[], period: number = 20, mult: number = 2.0) {
  const n = candles.length;
  const upper: number[] = new Array(n).fill(0);
  const middle: number[] = new Array(n).fill(0);
  const lower: number[] = new Array(n).fill(0);
  const bandwidth: number[] = new Array(n).fill(0); // (Upper - Lower) / Middle * 100
  const percentB: number[] = new Array(n).fill(0);  // (Close - Lower) / (Upper - Lower)

  for (let i = period - 1; i < n; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sum += candles[j].close;
    }
    const sma = sum / period;
    middle[i] = sma;

    let varSum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      varSum += Math.pow(candles[j].close - sma, 2);
    }
    const stdDev = Math.sqrt(varSum / period);
    upper[i] = sma + mult * stdDev;
    lower[i] = sma - mult * stdDev;

    const span = upper[i] - lower[i];
    bandwidth[i] = sma > 0 ? (span / sma) * 100 : 0;
    percentB[i] = span > 0 ? (candles[i].close - lower[i]) / span : 0.5;
  }

  return { upper, middle, lower, bandwidth, percentB };
}

// 2. RSI Calculation (period 14)
export function calcRSI(candles: Candle[], period: number = 14): number[] {
  const n = candles.length;
  const rsi: number[] = new Array(n).fill(50);
  if (n <= period) return rsi;

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));

  for (let i = period + 1; i < n; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    const curGain = diff > 0 ? diff : 0;
    const curLoss = diff < 0 ? Math.abs(diff) : 0;

    avgGain = (avgGain * (period - 1) + curGain) / period;
    avgLoss = (avgLoss * (period - 1) + curLoss) / period;

    if (avgLoss === 0) {
      rsi[i] = 100;
    } else {
      const rs = avgGain / avgLoss;
      rsi[i] = 100 - (100 / (1 + rs));
    }
  }

  return rsi;
}

// 3. Stochastic Oscillator (%K period 14, %D period 3)
export function calcStochastic(candles: Candle[], kPeriod: number = 14, dPeriod: number = 3) {
  const n = candles.length;
  const rawK: number[] = new Array(n).fill(50);
  const stochD: number[] = new Array(n).fill(50);

  for (let i = kPeriod - 1; i < n; i++) {
    let highest = -Infinity;
    let lowest = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      if (candles[j].high > highest) highest = candles[j].high;
      if (candles[j].low < lowest) lowest = candles[j].low;
    }
    const range = highest - lowest;
    rawK[i] = range > 0 ? ((candles[i].close - lowest) / range) * 100 : 50;
  }

  // Smooth %K with 3-SMA to get Fast Stoch %K / Slow Stoch
  const stochK: number[] = new Array(n).fill(50);
  for (let i = kPeriod + 1; i < n; i++) {
    stochK[i] = (rawK[i] + rawK[i - 1] + rawK[i - 2]) / 3;
  }

  for (let i = kPeriod + dPeriod; i < n; i++) {
    stochD[i] = (stochK[i] + stochK[i - 1] + stochK[i - 2]) / 3;
  }

  return { stochK, stochD };
}

async function testBollingerRsiStoch() {
  console.log("=== Testing Bollinger Bands + RSI / Stochastic on Dynamic Grid ===");
  const tickers = ["ETHUSDT", "SOLUSDT", "PEPEUSDT", "NEARUSDT", "DOGEUSDT", "XRPUSDT", "BNBUSDT", "SUIUSDT"];
  for (const sym of tickers) {
    try {
      const c = await BacktestService.fetchBinanceCandles(sym, "5m", 1000);
      const bb = calcBollingerBands(c, 20, 2.0);
      const rsi = calcRSI(c, 14);
      const stoch = calcStochastic(c, 14, 3);
      const lastIdx = c.length - 1;

      console.log(`[${sym}] Close: ${c[lastIdx].close} | BB Middle: ${bb.middle[lastIdx].toFixed(4)}, Bandwidth: ${bb.bandwidth[lastIdx].toFixed(2)}%, %B: ${bb.percentB[lastIdx].toFixed(2)} | RSI(14): ${rsi[lastIdx].toFixed(1)} | Stoch: K=${stoch.stochK[lastIdx].toFixed(1)}, D=${stoch.stochD[lastIdx].toFixed(1)}`);
    } catch (e) {}
  }
}

testBollingerRsiStoch().catch(console.error);
