/**
 * Instant In-Memory Auto-Calibrator
 * Unifies single-shot and rolling calibration through RollingSpreadCalibrator.
 */

import { Candle, CalibrationResult } from "./types.js";
import { CushionMode, WaterfallGuardMode } from "./core-rules.js";
import {
  RollingSpreadCalibrator,
  RollingCalibratorOptions,
  DEFAULT_CALIBRATION_LOOKBACK,
  CANDIDATE_SPREADS,
} from "./rolling-calibrator.js";

export interface CalibrateOptions extends RollingCalibratorOptions {
  slBufferPct?: number;
  trailingPullbackPct?: number;
  breakevenFeeBufferPct?: number;
  tp1Ratio?: number;
  initialCapital?: number;
  supervisorTimeframe?: "15m" | "1h";
  executionTimeframe?: "5m" | "15m";
  useRatchetSl?: boolean;
  cushionMode?: CushionMode;
  costModel?: { feePctPerSide?: number; slippagePctPerFill?: number };
  macroGateMode?: "off" | "noDeepBear" | "bullOnly";
  enableUpsideFloor?: boolean;
  waterfallGuardMode?: WaterfallGuardMode;
  lookbackBars?: number;
  tieBreakMarginPct?: number;
  defensiveOnLossRegime?: boolean;
}

export class AutoCalibrator {
  public static calibrate(
    symbol: string,
    candles: Candle[],
    _candidateSpreads?: number[],
    candlesHtf?: Candle[],
    opts?: CalibrateOptions
  ): CalibrationResult {
    if (candles.length === 0) {
      return {
        symbol,
        bestSpreadPct: 0.25,
        winRate: 0,
        profitFactor: 0,
        netPnlPct: 0,
        tradeCount: 0,
        evaluatedAt: Date.now(),
        candidates: [],
      };
    }

    const rollingCal = new RollingSpreadCalibrator(symbol, candles, candlesHtf, opts);
    const endIdx = candles.length - 1;
    return rollingCal.getCalibrationResultAt(endIdx, opts?.lookbackBars ?? DEFAULT_CALIBRATION_LOOKBACK);
  }
}
