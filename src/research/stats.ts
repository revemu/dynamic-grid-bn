/**
 * Statistical utilities for research backtest evaluation
 * Seeded PRNG, Cluster Bootstrap CI (by coin), and Sign Test.
 */

export function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((acc, v) => acc + v, 0) / arr.length;
}

export function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Cluster bootstrap confidence interval across clusters (coins)
 */
export function clusterBootstrapMeanCI(
  valuesByCluster: Map<string, number[]>,
  B = 10000,
  level = 0.90,
  seed = 42
): { mean: number; lower: number; upper: number } {
  const clusters = Array.from(valuesByCluster.keys());
  const allValues: number[] = [];
  for (const vals of valuesByCluster.values()) {
    allValues.push(...vals);
  }

  const sampleMean = mean(allValues);
  if (clusters.length === 0 || allValues.length === 0) {
    return { mean: sampleMean, lower: 0, upper: 0 };
  }

  const rng = mulberry32(seed);
  const nClusters = clusters.length;
  const bootstrapMeans: number[] = new Array(B);

  for (let b = 0; b < B; b++) {
    let sum = 0;
    let count = 0;
    for (let c = 0; c < nClusters; c++) {
      const randomIdx = Math.floor(rng() * nClusters);
      const chosenCluster = clusters[randomIdx]!;
      const clusterVals = valuesByCluster.get(chosenCluster)!;
      for (let i = 0; i < clusterVals.length; i++) {
        sum += clusterVals[i]!;
        count++;
      }
    }
    bootstrapMeans[b] = count > 0 ? sum / count : 0;
  }

  bootstrapMeans.sort((a, b) => a - b);
  const alpha = 1 - level;
  const lowerIdx = Math.floor(B * (alpha / 2));
  const upperIdx = Math.min(B - 1, Math.floor(B * (1 - alpha / 2)));

  return {
    mean: Number(sampleMean.toFixed(4)),
    lower: Number((bootstrapMeans[lowerIdx] ?? 0).toFixed(4)),
    upper: Number((bootstrapMeans[upperIdx] ?? 0).toFixed(4)),
  };
}

/**
 * Two-sided Binomial test p-value for p = 0.5
 */
export function binomialPValueTwoSided(k: number, n: number): number {
  if (n === 0) return 1.0;
  // Exact calculation of two-sided binomial p-value using combination symmetry
  const minK = Math.min(k, n - k);
  let cumulativeProb = 0;
  for (let i = 0; i <= minK; i++) {
    cumulativeProb += combinations(n, i) * Math.pow(0.5, n);
  }
  const pVal = Math.min(1.0, 2 * cumulativeProb);
  return Number(pVal.toFixed(6));
}

function combinations(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  const c = Math.min(k, n - k);
  let res = 1;
  for (let i = 1; i <= c; i++) {
    res = (res * (n - (c - i))) / i;
  }
  return res;
}

export function signTest(deltas: number[]): {
  positive: number;
  negative: number;
  zero: number;
  total: number;
  pValue: number;
} {
  let positive = 0;
  let negative = 0;
  let zero = 0;

  for (const d of deltas) {
    if (d > 1e-6) positive++;
    else if (d < -1e-6) negative++;
    else zero++;
  }

  const effectiveN = positive + negative;
  const pValue = binomialPValueTwoSided(positive, effectiveN);

  return {
    positive,
    negative,
    zero,
    total: deltas.length,
    pValue,
  };
}

export function top3ProfitShare(pnls: number[]): number {
  const gains = pnls.filter((p) => p > 0);
  if (gains.length === 0) return 0;
  const totalGain = gains.reduce((a, b) => a + b, 0);
  if (totalGain <= 0) return 0;
  gains.sort((a, b) => b - a);
  const top3 = gains.slice(0, 3).reduce((a, b) => a + b, 0);
  return Number(((top3 / totalGain) * 100).toFixed(1));
}
