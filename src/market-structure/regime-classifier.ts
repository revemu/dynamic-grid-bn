/**
 * Triple-Check Market Regime Classifier Module
 * 
 * Accurately classifies market state into:
 * 1. RANGE (Sideway / Consolidation): ADX < 21 OR CHOP >= 53 OR low Efficiency Ratio (< 0.32).
 *    -> Safest zone for Dynamic Grid cashflow harvesting.
 * 2. UPTREND (Strong Bullish Trend): ADX >= 23 AND CHOP <= 48 AND +DI > -DI AND price > EMA25/75.
 *    -> Zone for Trend Rider.
 * 3. DOWNTREND (Strong Bearish Trend): ADX >= 23 AND CHOP <= 48 AND -DI > +DI AND price < EMA25/75.
 *    -> Zone for 100% Cash Sit-Out or Bearish Short.
 */

import type { Candle, MarketRegime } from "./types.js";

export interface RegimeMetrics {
  adx: number;
  plusDI: number;
  minusDI: number;
  chop: number;
  er: number; // Kaufman Efficiency Ratio
  confidencePct: number;
  isTrendStrong: boolean;
  isSidewayChop: boolean;
  regime: MarketRegime;
  reasons: string[];
}

export class RegimeClassifier {
  /**
   * Calculate Choppiness Index (CHOP)
   * CHOP = 100 * LOG10(Sum(TR, n) / (MaxHigh(n) - MinLow(n))) / LOG10(n)
   * CHOP >= 61.8 -> Deep Consolidation
   * CHOP <= 38.2 -> Strong Directional Trend
   */
  public static calcChoppinessIndex(candles: Candle[], period: number = 14): number[] {
    const n = candles.length;
    const chop: number[] = new Array(n).fill(50);
    if (n < period + 1) return chop;

    const trs: number[] = [candles[0].high - candles[0].low];
    for (let i = 1; i < n; i++) {
      const h = candles[i].high;
      const l = candles[i].low;
      const prevC = candles[i - 1].close;
      trs.push(Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC)));
    }

    const log10n = Math.log10(period);

    for (let i = period - 1; i < n; i++) {
      let sumTr = 0;
      let maxH = -Infinity;
      let minL = Infinity;
      for (let j = i - period + 1; j <= i; j++) {
        sumTr += trs[j];
        if (candles[j].high > maxH) maxH = candles[j].high;
        if (candles[j].low < minL) minL = candles[j].low;
      }
      const range = maxH - minL;
      if (range > 0 && sumTr > 0) {
        const val = 100 * (Math.log10(sumTr / range) / log10n);
        chop[i] = Math.max(0, Math.min(100, val));
      }
    }
    return chop;
  }

  /**
   * Calculate ADX and Directional Indicators (+DI, -DI) via Wilder's Smoothing
   */
  public static calcADX(candles: Candle[], period: number = 14): { adx: number[]; plusDI: number[]; minusDI: number[] } {
    const n = candles.length;
    const adx = new Array(n).fill(0);
    const plusDI = new Array(n).fill(0);
    const minusDI = new Array(n).fill(0);

    if (n < period * 2) return { adx, plusDI, minusDI };

    const tr: number[] = [];
    const plusDM: number[] = [];
    const minusDM: number[] = [];

    for (let i = 0; i < n; i++) {
      if (i === 0) {
        tr.push(candles[0].high - candles[0].low);
        plusDM.push(0);
        minusDM.push(0);
        continue;
      }

      const h = candles[i].high, l = candles[i].low;
      const prevH = candles[i - 1].high, prevL = candles[i - 1].low, prevC = candles[i - 1].close;

      tr.push(Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC)));

      const upMove = h - prevH;
      const downMove = prevL - l;

      if (upMove > downMove && upMove > 0) plusDM.push(upMove);
      else plusDM.push(0);

      if (downMove > upMove && downMove > 0) minusDM.push(downMove);
      else minusDM.push(0);
    }

    let smoothTR = 0, smoothPlusDM = 0, smoothMinusDM = 0;
    for (let i = 0; i < period; i++) {
      smoothTR += tr[i];
      smoothPlusDM += plusDM[i];
      smoothMinusDM += minusDM[i];
    }

    const dx: number[] = new Array(n).fill(0);

    for (let i = period - 1; i < n; i++) {
      if (i > period - 1) {
        smoothTR = smoothTR - (smoothTR / period) + tr[i];
        smoothPlusDM = smoothPlusDM - (smoothPlusDM / period) + plusDM[i];
        smoothMinusDM = smoothMinusDM - (smoothMinusDM / period) + minusDM[i];
      }

      const pDI = smoothTR > 0 ? (smoothPlusDM / smoothTR) * 100 : 0;
      const mDI = smoothTR > 0 ? (smoothMinusDM / smoothTR) * 100 : 0;
      plusDI[i] = pDI;
      minusDI[i] = mDI;

      const diDiff = Math.abs(pDI - mDI);
      const diSum = pDI + mDI;
      dx[i] = diSum > 0 ? (diDiff / diSum) * 100 : 0;
    }

    let sumDX = 0;
    const startIdx = period * 2 - 1;
    for (let i = period - 1; i < startIdx; i++) {
      sumDX += dx[i];
    }
    adx[startIdx - 1] = sumDX / period;

    for (let i = startIdx; i < n; i++) {
      adx[i] = (adx[i - 1] * (period - 1) + dx[i]) / period;
    }

    return { adx, plusDI, minusDI };
  }

  /**
   * Kaufman Efficiency Ratio (ER)
   * ER = Change over period / Sum of individual bar changes
   * ER near 1.0 -> perfectly smooth directional trend
   * ER near 0.0 -> noisy back-and-forth sideways chop
   */
  public static calcEfficiencyRatio(closes: number[], period: number = 14): number[] {
    const er = new Array(closes.length).fill(0.5);
    for (let i = period; i < closes.length; i++) {
      const direction = Math.abs(closes[i] - closes[i - period]);
      let volatility = 0;
      for (let j = i - period + 1; j <= i; j++) {
        volatility += Math.abs(closes[j] - closes[j - 1]);
      }
      er[i] = volatility > 0 ? direction / volatility : 0;
    }
    return er;
  }

  /**
   * Classify Market Regime using Triple-Confirmation Engine
   */
  public static classify(
    candles: Candle[],
    candlesHtf?: Candle[],
    currentIndex?: number
  ): RegimeMetrics {
    const n = candles.length;
    if (n < 28) {
      return {
        adx: 0,
        plusDI: 0,
        minusDI: 0,
        chop: 50,
        er: 0.5,
        confidencePct: 50,
        isTrendStrong: false,
        isSidewayChop: true,
        regime: "WARMUP",
        reasons: ["ข้อมูลแท่งเทียนไม่เพียงพอ (ต้องการอย่างน้อย 28 แท่ง)"],
      };
    }

    const idx = currentIndex !== undefined ? currentIndex : n - 1;
    const closes = candles.map((c) => c.close);
    const chopArr = this.calcChoppinessIndex(candles, 14);
    const { adx: adxArr, plusDI: pDIArr, minusDI: mDIArr } = this.calcADX(candles, 14);
    const erArr = this.calcEfficiencyRatio(closes, 14);

    const calcEMAArray = (arr: number[], p: number) => {
      const k = 2 / (p + 1);
      const res = new Array(arr.length).fill(arr[0]);
      for (let i = 1; i < arr.length; i++) res[i] = arr[i] * k + res[i - 1] * (1 - k);
      return res;
    };

    const ema25 = calcEMAArray(closes, 25);
    const ema75 = calcEMAArray(closes, 75);

    const c = closes[idx];
    const curChop = chopArr[idx] ?? 50;
    const curAdx = adxArr[idx] ?? 0;
    const pDI = pDIArr[idx] ?? 0;
    const mDI = mDIArr[idx] ?? 0;
    const curEr = erArr[idx] ?? 0.5;

    const isAboveEma75 = c > ema75[idx];
    const isEma75Up = idx >= 5 ? ema75[idx] > ema75[idx - 5] : true;

    // HTF Alignment
    let htfBull = true;
    let htfBear = false;
    if (candlesHtf && candlesHtf.length >= 50) {
      const htfCloses = candlesHtf.map((x) => x.close);
      const htfEma = calcEMAArray(htfCloses, Math.min(75, candlesHtf.length - 1));
      const lastHtfC = htfCloses[htfCloses.length - 1];
      const lastHtfE = htfEma[htfEma.length - 1];
      const prevHtfE = htfEma[Math.max(0, htfEma.length - 4)];
      htfBull = lastHtfC >= lastHtfE && lastHtfE >= prevHtfE;
      htfBear = lastHtfC < lastHtfE && lastHtfE <= prevHtfE;
    }

    // 1. Sideway Check
    const isChopHigh = curChop >= 53;
    const isAdxLow = curAdx < 21;
    const isErLow = curEr < 0.32;
    const isSidewayChop = (isChopHigh && isAdxLow) || (isChopHigh && isErLow) || (curAdx < 18);

    // 2. Trend Check
    const isTrendStrong = curAdx >= 23 && curChop <= 48;

    let regime: MarketRegime = "RANGE";
    let confidencePct = 50;
    const reasons: string[] = [];

    if (isSidewayChop && !isTrendStrong) {
      regime = "RANGE";
      confidencePct = Math.round(Math.min(95, 50 + (curChop - 50) + (25 - curAdx) * 1.5));
      reasons.push(
        `CHOP ${curChop.toFixed(1)} ≥ 53 (อัดตัวในกรอบ)`,
        `ADX ${curAdx.toFixed(1)} < 21 (ไร้เทรนด์)`,
        `ER ${curEr.toFixed(2)} (แกว่งสับสน)`
      );
    } else {
      const isBullMomentum = pDI > mDI + 3 && c > ema25[idx] && isAboveEma75 && htfBull;
      const isBearMomentum = mDI > pDI + 3 && c < ema25[idx] && !isAboveEma75 && htfBear;

      if (isBullMomentum && (isTrendStrong || curEr >= 0.40 || isEma75Up)) {
        regime = "UPTREND";
        confidencePct = Math.round(Math.min(95, 60 + (curAdx - 20) + (pDI - mDI) * 0.8));
        reasons.push(
          `ADX ${curAdx.toFixed(1)} ≥ 23 (เทรนด์แกร่ง)`,
          `+DI (${pDI.toFixed(1)}) > -DI (${mDI.toFixed(1)})`,
          `ราคาและ HTF ยืนเหนือ EMA75`
        );
      } else if (isBearMomentum && (isTrendStrong || curEr >= 0.40 || !isEma75Up)) {
        regime = "DOWNTREND";
        confidencePct = Math.round(Math.min(95, 60 + (curAdx - 20) + (mDI - pDI) * 0.8));
        reasons.push(
          `ADX ${curAdx.toFixed(1)} ≥ 23 (เทรนด์ลงแกร่ง)`,
          `-DI (${mDI.toFixed(1)}) > +DI (${pDI.toFixed(1)})`,
          `ราคาและ HTF หลุดต่ำกว่า EMA75`
        );
      } else {
        // Transition or conflicted signals -> Safely classify as RANGE (Sideway)
        regime = "RANGE";
        confidencePct = 60;
        reasons.push(
          `สัญญาณผสมผสาน/ไร้ความชัดเจน (ADX ${curAdx.toFixed(1)}, CHOP ${curChop.toFixed(1)}) -> ป้องกันความเสี่ยงจัดเป็นไซด์เวย์`
        );
      }
    }

    return {
      adx: Number(curAdx.toFixed(1)),
      plusDI: Number(pDI.toFixed(1)),
      minusDI: Number(mDI.toFixed(1)),
      chop: Number(curChop.toFixed(1)),
      er: Number(curEr.toFixed(2)),
      confidencePct,
      isTrendStrong,
      isSidewayChop: regime === "RANGE",
      regime,
      reasons,
    };
  }
}
