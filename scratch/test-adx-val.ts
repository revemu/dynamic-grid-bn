import { BacktestService } from "../src/backtest-service.js";
import { Candle } from "../src/strategy/ma-fan/types.js";

// Wilder's ADX calculation for candles
export function calcADXSingle(candles: Candle[], idx: number, period: number = 14): number {
  if (idx < period * 2) return 0;
  
  // Calculate TR and DMs for the slice
  const start = idx - (period * 3);
  const slice = candles.slice(Math.max(0, start), idx + 1);
  const n = slice.length;
  if (n < period * 2) return 0;

  const tr: number[] = new Array(n).fill(0);
  const plusDM: number[] = new Array(n).fill(0);
  const minusDM: number[] = new Array(n).fill(0);

  tr[0] = slice[0].high - slice[0].low;
  for (let i = 1; i < n; i++) {
    const cur = slice[i];
    const prev = slice[i - 1];
    const hDiff = cur.high - prev.high;
    const lDiff = prev.low - cur.low;

    plusDM[i] = hDiff > lDiff && hDiff > 0 ? hDiff : 0;
    minusDM[i] = lDiff > hDiff && lDiff > 0 ? lDiff : 0;

    const tr1 = cur.high - cur.low;
    const tr2 = Math.abs(cur.high - prev.close);
    const tr3 = Math.abs(cur.low - prev.close);
    tr[i] = Math.max(tr1, tr2, tr3);
  }

  // Wilder's smoothing
  let smoothTR = 0;
  let smoothPlusDM = 0;
  let smoothMinusDM = 0;
  for (let i = 0; i < period; i++) {
    smoothTR += tr[i];
    smoothPlusDM += plusDM[i];
    smoothMinusDM += minusDM[i];
  }

  const dx: number[] = new Array(n).fill(0);
  for (let i = period; i < n; i++) {
    smoothTR = smoothTR - (smoothTR / period) + tr[i];
    smoothPlusDM = smoothPlusDM - (smoothPlusDM / period) + plusDM[i];
    smoothMinusDM = smoothMinusDM - (smoothMinusDM / period) + minusDM[i];

    const plusDI = smoothTR > 0 ? (100 * smoothPlusDM) / smoothTR : 0;
    const minusDI = smoothTR > 0 ? (100 * smoothMinusDM) / smoothTR : 0;
    const sum = plusDI + minusDI;
    dx[i] = sum > 0 ? (100 * Math.abs(plusDI - minusDI)) / sum : 0;
  }

  let adx = 0;
  for (let i = period; i < period * 2; i++) {
    adx += dx[i];
  }
  adx /= period;

  for (let i = period * 2; i < n; i++) {
    adx = (adx * (period - 1) + dx[i]) / period;
  }

  return adx;
}

async function test() {
  const c = await BacktestService.fetchBinanceCandles("ETHUSDT", "5m", 500);
  const adxVal = calcADXSingle(c, c.length - 1, 14);
  console.log("Current ETH 5m ADX(14):", adxVal.toFixed(2));
  
  // Aggregate to 1h
  const c1h = BacktestService.aggregateCandles(c, 60);
  const adx1h = calcADXSingle(c1h, c1h.length - 1, 14);
  console.log("Current ETH 1H ADX(14):", adx1h.toFixed(2));
}

test().catch(console.error);
