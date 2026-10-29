/**
 * EMA Ribbon & Spread Engine
 * Computes moving averages (4, 8, 16, 25, 75, 200), measures fan spread expansion,
 * and detects momentum hooks.
 */

import { Candle, RibbonState } from "./types.js";

export function calcEMA(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const ema: number[] = new Array(values.length).fill(0);
  if (values.length === 0) return ema;

  let sum = 0;
  const initial = Math.min(period, values.length);
  for (let i = 0; i < initial; i++) sum += values[i]!;
  ema[initial - 1] = sum / initial;

  for (let i = initial; i < values.length; i++) {
    ema[i] = values[i]! * k + ema[i - 1]! * (1 - k);
  }
  for (let i = 0; i < initial - 1; i++) {
    ema[i] = ema[initial - 1]!;
  }
  return ema;
}

export function calcATR(candles: Candle[], period: number = 14): number[] {
  const atr: number[] = new Array(candles.length).fill(0);
  if (candles.length <= 1) return atr;

  const trs: number[] = [candles[0]!.high - candles[0]!.low];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i]!.high;
    const l = candles[i]!.low;
    const prevC = candles[i - 1]!.close;
    trs.push(Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC)));
  }

  let sum = 0;
  for (let i = 0; i < Math.min(period, trs.length); i++) sum += trs[i]!;
  atr[period - 1] = sum / period;

  for (let i = period; i < trs.length; i++) {
    atr[i] = (atr[i - 1]! * (period - 1) + trs[i]!) / period;
  }
  return atr;
}

export class RibbonEngine {
  public static computeRibbonState(candles: Candle[], targetIdx?: number): RibbonState {
    const closes = candles.map((c) => c.close);
    const idx = targetIdx !== undefined ? targetIdx : closes.length - 1;

    if (idx < 25) {
      // Not enough data for full ribbon
      const p = closes[idx] ?? 0;
      return {
        ema4: p,
        ema8: p,
        ema16: p,
        ema25: p,
        ema75: p,
        ema200: p,
        fanSpreadPct: 0,
        isFanningDown: false,
        isFanningUp: false,
        isHookUp: false,
        isHookDown: false,
      };
    }

    const ema4 = calcEMA(closes, 4);
    const ema8 = calcEMA(closes, 8);
    const ema16 = calcEMA(closes, 16);
    const ema25 = calcEMA(closes, 25);
    const ema75 = calcEMA(closes, 75);
    const ema200 = calcEMA(closes, 200);

    const prevIdx = Math.max(0, idx - 1);
    const curEma4 = ema4[idx]!;
    const curEma8 = ema8[idx]!;
    const curEma16 = ema16[idx]!;
    const curEma25 = ema25[idx]!;
    const curEma75 = ema75[idx]!;
    const curEma200 = ema200[idx]!;

    const prevEma4 = ema4[prevIdx]!;
    const prevEma8 = ema8[prevIdx]!;
    const prevEma16 = ema16[prevIdx]!;
    const prevEma25 = ema25[prevIdx]!;

    // Fan spread expansion: percentage distance between EMA 4 and EMA 25
    const fanSpreadPct = curEma25 > 0 ? (Math.abs(curEma25 - curEma4) / curEma25) * 100 : 0;

    // Strict alignment checks
    const curFanningDown = curEma4 < curEma8 && curEma8 < curEma16 && curEma16 < curEma25;
    const prevFanningDown = prevEma4 < prevEma8 && prevEma8 < prevEma16 && prevEma16 < prevEma25;
    const isCurBullish = curEma4 > curEma8 && curEma8 > curEma16 && curEma16 > curEma25;

    // Check fan alignment: must be below EMA 25 and not actively a bullish ribbon
    const isFanningDown =
      !isCurBullish &&
      curEma4 <= curEma25 &&
      (curFanningDown || (prevFanningDown && curEma4 <= curEma16));

    const isFanningUp =
      (prevEma4 > prevEma8 && prevEma8 > prevEma16 && prevEma16 > prevEma25) ||
      isCurBullish;

    const curCandle = candles[idx]!;

    // Momentum Hook Up: EMA 4 crosses above EMA 8 OR green candle closes above EMA 4 (while curling/flattening out and staying below EMA 25)
    const isHookUp =
      curEma4 <= curEma25 * 1.002 &&
      curCandle.close < curEma25 &&
      ((curEma4 >= curEma8 && prevEma4 < prevEma8) ||
        (curCandle.close > curEma4 && curCandle.close > curCandle.open && curEma4 >= prevEma4 * 0.9992));

    // Momentum Hook Down (for Bearish exhaustion / Top exit)
    const isHookDown =
      (curEma4 <= curEma8 && prevEma4 > prevEma8) ||
      (curCandle.close < curEma4 && curCandle.close < curCandle.open);

    return {
      ema4: curEma4,
      ema8: curEma8,
      ema16: curEma16,
      ema25: curEma25,
      ema75: curEma75,
      ema200: curEma200,
      fanSpreadPct,
      isFanningDown,
      isFanningUp,
      isHookUp,
      isHookDown,
    };
  }

  /**
   * High-Performance Pre-computation:
   * Computes all RibbonStates for all candles in O(N) single pass.
   */
  public static computeAllRibbonStates(candles: Candle[]): RibbonState[] {
    const closes = candles.map((c) => c.close);
    const n = closes.length;
    if (n === 0) return [];

    const ema4 = calcEMA(closes, 4);
    const ema8 = calcEMA(closes, 8);
    const ema16 = calcEMA(closes, 16);
    const ema25 = calcEMA(closes, 25);
    const ema75 = calcEMA(closes, 75);
    const ema200 = calcEMA(closes, 200);

    const states: RibbonState[] = new Array(n);
    for (let idx = 0; idx < n; idx++) {
      if (idx < 25) {
        const p = closes[idx] ?? 0;
        states[idx] = {
          ema4: p,
          ema8: p,
          ema16: p,
          ema25: p,
          ema75: p,
          ema200: p,
          fanSpreadPct: 0,
          isFanningDown: false,
          isFanningUp: false,
          isHookUp: false,
          isHookDown: false,
        };
        continue;
      }

      const prevIdx = Math.max(0, idx - 1);
      const curEma4 = ema4[idx]!;
      const curEma8 = ema8[idx]!;
      const curEma16 = ema16[idx]!;
      const curEma25 = ema25[idx]!;
      const curEma75 = ema75[idx]!;
      const curEma200 = ema200[idx]!;

      const prevEma4 = ema4[prevIdx]!;
      const prevEma8 = ema8[prevIdx]!;
      const prevEma16 = ema16[prevIdx]!;
      const prevEma25 = ema25[prevIdx]!;

      const fanSpreadPct = curEma25 > 0 ? (Math.abs(curEma25 - curEma4) / curEma25) * 100 : 0;
      const curFanningDown = curEma4 < curEma8 && curEma8 < curEma16 && curEma16 < curEma25;
      const prevFanningDown = prevEma4 < prevEma8 && prevEma8 < prevEma16 && prevEma16 < prevEma25;
      const isCurBullish = curEma4 > curEma8 && curEma8 > curEma16 && curEma16 > curEma25;

      const isFanningDown =
        !isCurBullish &&
        curEma4 <= curEma25 &&
        (curFanningDown || (prevFanningDown && curEma4 <= curEma16));

      const isFanningUp =
        (prevEma4 > prevEma8 && prevEma8 > prevEma16 && prevEma16 > prevEma25) ||
        isCurBullish;

      const curCandle = candles[idx]!;
      const isHookUp =
        curEma4 <= curEma25 * 1.002 &&
        curCandle.close < curEma25 &&
        ((curEma4 >= curEma8 && prevEma4 < prevEma8) ||
          (curCandle.close > curEma4 && curCandle.close > curCandle.open && curEma4 >= prevEma4 * 0.9992));

      const isHookDown =
        (curEma4 <= curEma8 && prevEma4 > prevEma8) ||
        (curCandle.close < curEma4 && curCandle.close < curCandle.open);

      states[idx] = {
        ema4: curEma4,
        ema8: curEma8,
        ema16: curEma16,
        ema25: curEma25,
        ema75: curEma75,
        ema200: curEma200,
        fanSpreadPct,
        isFanningDown,
        isFanningUp,
        isHookUp,
        isHookDown,
      };
    }
    return states;
  }
}
