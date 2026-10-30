/**
 * MA Fan Elastic Exhaustion & Reversion Strategy - Type Definitions
 * Standalone Strategy Mode for dynamic-grid-bn
 */

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  isClosed?: boolean;
}

export interface RibbonState {
  ema4: number;
  ema8: number;
  ema16: number;
  ema25: number;
  ema75: number;
  ema200: number;
  fanSpreadPct: number;
  isFanningDown: boolean;
  isFanningUp: boolean;
  isHookUp: boolean;
  isHookDown: boolean;
}

export interface IndicatorSnapshot {
  time: number;
  close: number;
  ribbon: RibbonState;
  rsi: number;
  macd: {
    macd: number;
    signal: number;
    hist: number;
    isTurningUp: boolean;
    isTurningDown: boolean;
  };
  atr: number;
  atrPct: number;
}

export interface HtfRegime {
  timeframe: string;
  isBullish: boolean;
  isAboveEma200: boolean;
  spreadMultiplier: number;
  recommendedTp1Ratio: number;
  isDeepBear?: boolean;
  distToEma200Pct?: number;
  ema200Slope?: number;
}

export interface MaFanConfig {
  executionTimeframe: "5m" | "15m";
  supervisorTimeframe: "15m" | "1h";
  autoCalibrateSpreadOnSwitch: boolean;
  manualSpreadPct: number;
  useAtrAdaptiveSpread: boolean;
  atrMultiplier: number;
  tp1Ratio: number; // e.g. 0.50 (50%)
  tp1Target: "EMA25";
  tp2Target: "MACRO_OR_TRAILING";
  trailingPullbackPct: number; // e.g. 0.45%
  breakevenFeeBufferPct: number; // e.g. 0.05%
  slBufferPct: number; // e.g. 0.25%
  useRatchetSl?: boolean; // dynamic ratchet stop loss lift
  bullCushionEnabled?: boolean; // lenient breakeven SL when HTF is Bullish
  waterfallGuardEnabled?: boolean; // blocks entry on sudden vertical crashes (4+ reds, HTF drop >=2%, or vol >=2.5x)
  entryOnClosedOnly?: boolean; // evaluate entries on confirmed closed candles only (aligns with Backtest)
  macroGateMode?: "off" | "noDeepBear" | "bullOnly"; // Macro HTF Trend Gate
  upsideFloorEnabled?: boolean; // Require Spread >= 0.35% and Upside to EMA25 >= 0.45%
  circuitBreakerEnabled?: boolean; // 2 SLs within 12 hours -> 6-hour pause
  maxSlPct?: number; // Hard cap on initial SL distance (default: 1.80%)
  fastTechnicalCutEnabled?: boolean; // Early exit on momentum breakdown (default: true)
  fastCutThresholdPct?: number; // PnL threshold for fast cut (default: -0.80%)
  stagnationBars?: number; // Bars held without reaching +0.70% (default: 6)
  tradeMode?: "dip_hunter" | "trend_rider" | "dual"; // Trade mode (default: "dip_hunter")
  tradeDirection?: "long" | "short" | "both"; // Trade direction (default: "long" for spot, "both" for perp)
  maxPositionBudgetUsd: number;
  isDryRun?: boolean;
  startPaused?: boolean;
}

export interface CalibrationResult {
  symbol: string;
  bestSpreadPct: number;
  winRate: number;
  profitFactor: number;
  netPnlPct: number;
  tradeCount: number;
  evaluatedAt: number;
  candidates: {
    spreadPct: number;
    netPnlPct: number;
    winRate: number;
    tradeCount: number;
    profitFactor: number;
  }[];
}

export interface MaFanPosition {
  symbol: string;
  positionSide?: "LONG" | "SHORT";
  entryPrice: number;
  entryTime: number;
  totalQty: number;
  remainingQty: number;
  stopLossPrice: number;
  isBreakevenLocked: boolean;
  tp1Filled: boolean;
  tp1Price?: number;
  tp1Time?: number;
  highestPriceSinceTp1: number;
  highestPriceSinceEntry?: number;
  lowestPriceSinceTp1?: number;
  lowestPriceSinceEntry?: number;
  htfRegimeAtEntry: HtfRegime;
  fanSpreadAtEntry: number;
}

export interface MaFanTradeLog {
  id: string;
  type: "BUY_HOOK" | "SELL_PEAK" | "TREND_LONG" | "TREND_SHORT" | "TP1_EMA25" | "TP2_RUNNER" | "STOP_LOSS" | "TECH_FAST_CUT";
  side?: "LONG" | "SHORT";
  symbol: string;
  price: number;
  qty: number;
  pnl?: number;
  pnlPct?: number;
  reason?: string;
  time: number;
}
