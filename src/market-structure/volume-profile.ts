import type { Candle } from "./types.js";

export interface VolumeProfileBin {
  price: number;
  volume: number;
  isPoc: boolean;
  inValueArea: boolean;
}

export interface VolumeProfileResult {
  poc: number;
  vah: number;
  val: number;
  totalVolume: number;
  valueAreaVolume: number;
  bins: VolumeProfileBin[];
  highestPrice: number;
  lowestPrice: number;
  calculatedAt: number;
}

export class VolumeProfileEngine {
  /**
   * Calculates Volume Profile (POC, VAH, VAL) from an array of historical candles.
   * @param candles Historical candles with volume
   * @param lookbackBars Number of bars to include (e.g. 192 bars = 48h on 15m)
   * @param numBins Number of price steps/bins to divide range into (default 60)
   * @param valueAreaPct Percentage of volume enclosed in Value Area (default 0.70 = 70%)
   */
  public static calculate(
    candles: Candle[],
    lookbackBars = 192,
    numBins = 60,
    valueAreaPct = 0.70,
  ): VolumeProfileResult | undefined {
    if (!candles || candles.length < 5) return undefined;

    const slice = candles.slice(-Math.max(5, lookbackBars));
    let highestPrice = -Infinity;
    let lowestPrice = Infinity;
    let totalVolume = 0;

    for (const c of slice) {
      if (!c || !Number.isFinite(c.close)) continue;
      if (c.high > highestPrice) highestPrice = c.high;
      if (c.low < lowestPrice) lowestPrice = c.low;
      totalVolume += c.volume || 0;
    }

    if (!Number.isFinite(highestPrice) || !Number.isFinite(lowestPrice) || highestPrice <= lowestPrice || lowestPrice <= 0) {
      return undefined;
    }

    const priceSpan = highestPrice - lowestPrice;
    const binCount = Math.max(20, Math.min(120, numBins));
    const binSize = priceSpan / binCount;

    const binVolumes = new Array(binCount).fill(0);

    for (const c of slice) {
      const vol = c.volume || 1.0;
      const cLow = Math.max(lowestPrice, c.low);
      const cHigh = Math.min(highestPrice, c.high);
      const cSpan = cHigh - cLow;

      if (cSpan <= 0) {
        const binIdx = Math.min(binCount - 1, Math.max(0, Math.floor((c.close - lowestPrice) / binSize)));
        binVolumes[binIdx] += vol;
      } else {
        const startBin = Math.min(binCount - 1, Math.max(0, Math.floor((cLow - lowestPrice) / binSize)));
        const endBin = Math.min(binCount - 1, Math.max(0, Math.floor((cHigh - lowestPrice) / binSize)));
        const binsTouched = Math.max(1, endBin - startBin + 1);
        const volPerBin = vol / binsTouched;

        for (let b = startBin; b <= endBin; b++) {
          binVolumes[b] += volPerBin;
        }
      }
    }

    // 1. Point of Control (POC): Bin with highest volume
    let maxVol = -1;
    let pocIdx = 0;
    for (let i = 0; i < binCount; i++) {
      if (binVolumes[i] > maxVol) {
        maxVol = binVolumes[i];
        pocIdx = i;
      }
    }
    const poc = lowestPrice + (pocIdx + 0.5) * binSize;

    // 2. Value Area (VAH & VAL): Expand outward from POC until 70% of total volume is captured
    const targetVolume = (totalVolume > 0 ? totalVolume : binVolumes.reduce((a, b) => a + b, 0)) * valueAreaPct;
    let accumulatedVolume = binVolumes[pocIdx];
    let lowerIdx = pocIdx;
    let upperIdx = pocIdx;
    const inValueArea = new Array(binCount).fill(false);
    inValueArea[pocIdx] = true;

    while (accumulatedVolume < targetVolume && (lowerIdx > 0 || upperIdx < binCount - 1)) {
      const nextLowerVol = lowerIdx > 0 ? binVolumes[lowerIdx - 1] : -1;
      const nextUpperVol = upperIdx < binCount - 1 ? binVolumes[upperIdx + 1] : -1;

      if (nextUpperVol >= nextLowerVol && upperIdx < binCount - 1) {
        upperIdx++;
        accumulatedVolume += binVolumes[upperIdx];
        inValueArea[upperIdx] = true;
      } else if (lowerIdx > 0) {
        lowerIdx--;
        accumulatedVolume += binVolumes[lowerIdx];
        inValueArea[lowerIdx] = true;
      } else if (upperIdx < binCount - 1) {
        upperIdx++;
        accumulatedVolume += binVolumes[upperIdx];
        inValueArea[upperIdx] = true;
      } else {
        break;
      }
    }

    const val = lowestPrice + lowerIdx * binSize;
    const vah = lowestPrice + (upperIdx + 1) * binSize;

    const bins: VolumeProfileBin[] = binVolumes.map((vol, idx) => ({
      price: Number((lowestPrice + (idx + 0.5) * binSize).toFixed(6)),
      volume: Number(vol.toFixed(4)),
      isPoc: idx === pocIdx,
      inValueArea: inValueArea[idx] || false,
    }));

    return {
      poc: Number(poc.toFixed(6)),
      vah: Number(vah.toFixed(6)),
      val: Number(val.toFixed(6)),
      totalVolume: Number(totalVolume.toFixed(2)),
      valueAreaVolume: Number(accumulatedVolume.toFixed(2)),
      bins,
      highestPrice: Number(highestPrice.toFixed(6)),
      lowestPrice: Number(lowestPrice.toFixed(6)),
      calculatedAt: Date.now(),
    };
  }
}
