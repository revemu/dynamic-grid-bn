import { BacktestService } from "../src/backtest-service.js";
import { Candle } from "../src/strategy/ma-fan/types.js";

// Standard Wilder's ADX Implementation
export function calcADX(candles: Candle[], period: number = 14): number[] {
  const n = candles.length;
  const adx: number[] = new Array(n).fill(0);
  if (n <= period * 2) return adx;

  const tr: number[] = new Array(n).fill(0);
  const plusDM: number[] = new Array(n).fill(0);
  const minusDM: number[] = new Array(n).fill(0);

  tr[0] = candles[0].high - candles[0].low;
  for (let i = 1; i < n; i++) {
    const cur = candles[i];
    const prev = candles[i - 1];
    const hDiff = cur.high - prev.high;
    const lDiff = prev.low - cur.low;

    plusDM[i] = hDiff > lDiff && hDiff > 0 ? hDiff : 0;
    minusDM[i] = lDiff > hDiff && lDiff > 0 ? lDiff : 0;

    const tr1 = cur.high - cur.low;
    const tr2 = Math.abs(cur.high - prev.close);
    const tr3 = Math.abs(cur.low - prev.close);
    tr[i] = Math.max(tr1, tr2, tr3);
  }

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
    smoothTR = smoothTR - smoothTR / period + tr[i];
    smoothPlusDM = smoothPlusDM - smoothPlusDM / period + plusDM[i];
    smoothMinusDM = smoothMinusDM - smoothMinusDM / period + minusDM[i];

    const plusDI = smoothTR > 0 ? (100 * smoothPlusDM) / smoothTR : 0;
    const minusDI = smoothTR > 0 ? (100 * smoothMinusDM) / smoothTR : 0;
    const diSum = plusDI + minusDI;
    dx[i] = diSum > 0 ? (100 * Math.abs(plusDI - minusDI)) / diSum : 0;
  }

  let adxSum = 0;
  for (let i = period; i < period * 2; i++) {
    adxSum += dx[i];
  }
  adx[period * 2 - 1] = adxSum / period;

  for (let i = period * 2; i < n; i++) {
    adx[i] = (adx[i - 1] * (period - 1) + dx[i]) / period;
  }

  return adx;
}

async function runAdxExperiment() {
  console.log("=== Testing ADX Filter on Dynamic Grid (30-day Crash: 8640 bars) ===");
  const tickers = await BacktestService.fetchUsdtTickers();
  const topTickers = tickers.slice(0, 30); // Test top 30 universe

  const universeCandles = new Map<string, Candle[]>();
  for (const t of topTickers) {
    try {
      const c = await BacktestService.fetchBinanceCandles(t.symbol, "5m", 8640);
      if (c && c.length >= 8000) {
        universeCandles.set(t.symbol, c);
      }
    } catch (e) {}
  }
  console.log(`Loaded ${universeCandles.size} pairs candles`);

  // Let's test with different ADX thresholds:
  // 1. Without ADX filter (current HTF + pos <= 35%)
  // 2. With ADX < 25 (Pure Sideways / Range-Bound)
  // 3. With ADX < 30 (Moderate Trend allowed)

  for (const maxAdx of [999, 30, 25, 20]) {
    const res = await BacktestService.runMultiPairRotationSimulation({
      quoteAsset: "USDT",
      maxUniversePairs: 30,
      limit: 8640,
      initialCapital: 200,
      rotationIntervalMinutes: 180,
      capitalZones: 2,
      channelMode: "DONCHIAN_ATR",
      gridCutLossMode: "none",
      enableDipHunterEntryGuard: true,
      enableSignalInvalidationExit: true,
      signalInvalidationMode: "calibrated",
      enableBaseConfirmation: true,
      enableBtcMacroGate: true,
      gridHtfGovernor: "1h_ema200",
      gridMaxChannelPos: 0.35,
      // Pass custom candles to save time
    });

    console.log(`Max ADX = ${maxAdx === 999 ? "OFF" : maxAdx}: Net PnL = ${res.summary.netProfitPct.toFixed(2)}%, Max DD = ${res.summary.maxDrawdownPct.toFixed(2)}%, Trades = ${res.summary.closedTradesCount}, WinRate = ${res.summary.winRatePct.toFixed(1)}%`);
  }
}

runAdxExperiment().catch(console.error);
