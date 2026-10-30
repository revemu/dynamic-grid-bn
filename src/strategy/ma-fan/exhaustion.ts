/**
 * Momentum Exhaustion & Divergence Engine
 * Computes RSI, MACD Histogram, and identifies momentum inflection points.
 */

import { Candle } from "./types.js";
import { calcEMA } from "./ribbon.js";

export function calcRSI(candles: Candle[], period: number = 14): number[] {
  const rsi: number[] = new Array(candles.length).fill(50);
  if (candles.length <= period) return rsi;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = candles[i]!.close - candles[i - 1]!.close;
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  rsi[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));

  for (let i = period + 1; i < candles.length; i++) {
    const diff = candles[i]!.close - candles[i - 1]!.close;
    const gain = diff >= 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    rsi[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + rs));
  }
  return rsi;
}

export function calcMACD(candles: Candle[], fast = 12, slow = 26, signal = 9) {
  const closes = candles.map((c) => c.close);
  const emaFast = calcEMA(closes, fast);
  const emaSlow = calcEMA(closes, slow);
  const macdLine = closes.map((_, i) => emaFast[i]! - emaSlow[i]!);
  const signalLine = calcEMA(macdLine, signal);
  const hist = macdLine.map((m, i) => m - signalLine[i]!);
  return { macd: macdLine, signal: signalLine, hist };
}

/**
 * Simple Moving Average (SMA) of numerical series (e.g. RSI Signal Line, matching TradingView RSI-based MA)
 */
export function calcSMA(values: number[], period: number = 14): number[] {
  const n = values.length;
  const sma: number[] = new Array(n).fill(values[0] ?? 50);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += values[i]!;
    if (i >= period) {
      sum -= values[i - period]!;
      sma[i] = sum / period;
    } else {
      sma[i] = sum / (i + 1);
    }
  }
  return sma;
}

export interface ExhaustionState {
  rsi: number;
  prevRsi: number;
  rsiSma?: number;
  isRsiAboveSma?: boolean;
  macd: {
    macd: number;
    signal: number;
    hist: number;
    isTurningUp: boolean;
    isTurningDown: boolean;
  };
  isOversoldExhaustion: boolean;
  isOverboughtExhaustion: boolean;
}

export class ExhaustionEngine {
  public static computeAllExhaustion(candles: Candle[]): ExhaustionState[] {
    const n = candles.length;
    if (n === 0) return [];

    const rsiList = calcRSI(candles, 14);
    const rsiSmaList = calcSMA(rsiList, 14);
    const { macd, signal, hist } = calcMACD(candles, 12, 26, 9);
    const results: ExhaustionState[] = new Array(n);

    for (let idx = 0; idx < n; idx++) {
      const prevIdx = Math.max(0, idx - 1);
      const curRsi = rsiList[idx]!;
      const prevRsi = rsiList[prevIdx]!;
      const curRsiSma = rsiSmaList[idx]!;
      const curHist = hist[idx]!;
      const prevHist = hist[prevIdx]!;

      const isTurningUp = curHist > prevHist;
      const isTurningDown = curHist < prevHist;
      const isRsiAboveSma = curRsi > curRsiSma;

      // 4 Pillars Confluence:
      // 1. Crash Floor: curRsi >= 28 (avoid catching falling knife panic dumps)
      // 2. Oversold Zone: (prevRsi <= 42 || curRsi <= 42 || (isTurningUp && prevRsi <= 45)) && curRsi < 55
      // 3. Momentum Deceleration / RSI-SMA cross: (isRsiAboveSma || (isTurningUp && curRsi >= curRsiSma * 0.99))
      const isCrashKnife = curRsi < 28;
      const inOversoldZone = (prevRsi <= 42 || curRsi <= 42 || (isTurningUp && prevRsi <= 45)) && curRsi < 55;
      const hasMomentumReversal = isRsiAboveSma || (isTurningUp && curRsi >= curRsiSma * 0.99);

      const isOversoldExhaustion = !isCrashKnife && inOversoldZone && hasMomentumReversal;
      const isOverboughtExhaustion = curRsi >= 70 || (isTurningDown && curRsi >= 55);

      results[idx] = {
        rsi: curRsi,
        prevRsi,
        rsiSma: curRsiSma,
        isRsiAboveSma,
        macd: {
          macd: macd[idx]!,
          signal: signal[idx]!,
          hist: curHist,
          isTurningUp,
          isTurningDown,
        },
        isOversoldExhaustion,
        isOverboughtExhaustion,
      };
    }

    return results;
  }

  public static evaluate(candles: Candle[], targetIdx?: number): ExhaustionState {
    const idx = targetIdx !== undefined ? targetIdx : candles.length - 1;
    const rsiList = calcRSI(candles, 14);
    const rsiSmaList = calcSMA(rsiList, 14);
    const { macd, signal, hist } = calcMACD(candles, 12, 26, 9);

    const prevIdx = Math.max(0, idx - 1);
    const curRsi = rsiList[idx]!;
    const prevRsi = rsiList[prevIdx]!;
    const curRsiSma = rsiSmaList[idx]!;
    const curHist = hist[idx]!;
    const prevHist = hist[prevIdx]!;

    const isTurningUp = curHist > prevHist;
    const isTurningDown = curHist < prevHist;
    const isRsiAboveSma = curRsi > curRsiSma;

    // 4 Pillars Confluence:
    // 1. Crash Floor: curRsi >= 28 (avoid catching falling knife panic dumps)
    // 2. Oversold Zone: (prevRsi <= 42 || curRsi <= 42 || (isTurningUp && prevRsi <= 45)) && curRsi < 55
    // 3. Momentum Deceleration / RSI-SMA cross: (isRsiAboveSma || (isTurningUp && curRsi >= curRsiSma * 0.99))
    const isCrashKnife = curRsi < 28;
    const inOversoldZone = (prevRsi <= 42 || curRsi <= 42 || (isTurningUp && prevRsi <= 45)) && curRsi < 55;
    const hasMomentumReversal = isRsiAboveSma || (isTurningUp && curRsi >= curRsiSma * 0.99);

    const isOversoldExhaustion = !isCrashKnife && inOversoldZone && hasMomentumReversal;
    const isOverboughtExhaustion = curRsi >= 70 || (isTurningDown && curRsi >= 55);

    return {
      rsi: curRsi,
      prevRsi,
      rsiSma: curRsiSma,
      isRsiAboveSma,
      macd: {
        macd: macd[idx]!,
        signal: signal[idx]!,
        hist: curHist,
        isTurningUp,
        isTurningDown,
      },
      isOversoldExhaustion,
      isOverboughtExhaustion,
    };
  }

  public static detectBullishDivergence(candles: Candle[], rsi: number[], hist: number[], lookback = 30): boolean {
    const end = candles.length - 1;
    const start = Math.max(0, end - lookback);

    const swingLows: { idx: number; price: number; rsi: number; hist: number }[] = [];
    for (let i = start + 2; i < end - 1; i++) {
      if (
        candles[i]!.low <= candles[i - 1]!.low &&
        candles[i]!.low <= candles[i - 2]!.low &&
        candles[i]!.low <= candles[i + 1]!.low
      ) {
        swingLows.push({
          idx: i,
          price: candles[i]!.low,
          rsi: rsi[i]!,
          hist: hist[i]!,
        });
      }
    }

    if (swingLows.length < 2) return false;
    const lastLow = swingLows[swingLows.length - 1]!;
    const prevLow = swingLows[swingLows.length - 2]!;

    // Price makes lower low, but RSI or MACD makes higher low
    const priceLower = lastLow.price < prevLow.price * 0.999;
    const rsiHigher = lastLow.rsi > prevLow.rsi && lastLow.rsi <= 45;
    const histHigher = lastLow.hist > prevLow.hist && lastLow.hist < 0;

    return priceLower && (rsiHigher || histHigher);
  }
}
