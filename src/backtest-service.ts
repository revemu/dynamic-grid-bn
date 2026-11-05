/**
 * Backtest Service & Dedicated Simulation Engine
 * Runs historical simulations for MA Fan Sniper & Dynamic Strategies,
 * persists backtest runs, and generates TradingView chart markers.
 */

import fs from "fs";
import path from "path";
import { Candle, RibbonEngine, ExhaustionEngine, AutoCalibrator, RollingSpreadCalibrator, MaFanCoreRules, RegimeSupervisor, CushionMode, RibbonState, ExhaustionState, WaterfallGuardMode } from "./strategy/ma-fan/index.js";
import { calcATR, calcEMA } from "./strategy/ma-fan/ribbon.js";
import { calcRSI, calcMACD } from "./strategy/ma-fan/exhaustion.js";
import { DowStructureEngine } from "./market-structure.js";
import { getActiveBinanceTradingSymbols } from "./exchange/binance/client.js";
import { isSyntheticOrStock } from "./pair-rotator.js";

export const STABLE_TOKENS = new Set([
  "USDC", "FDUSD", "TUSD", "BUSD", "EUR", "DAI", "AEUR", "USDP", "USD1", "RLUSD", "EURI", "USTC", "WBTC", "WBETH",
  "U", "RWUSD", "BFUSD", "USDE", "XAUT",
]);

export const TOXIC_MEME_PENNY_TOKENS = new Set([
  "1000CATUSDT",
  "MARSCOINUSDT",
  "HAEDALUSDT",
  "TRUMPUSDT",
  "BMTUSDT",
  "MEGAUSDT",
  "PENGUUSDT",
  "REDUSDT",
  "ERAUSDT",
  "PUMPUSDT",
]);

export const TOP_US_STOCK_UNIVERSE = [
  // Mega-Cap Benchmarks & Core ETFs
  "SPY", "QQQ", "DIA", "IWM", "SCHD", "VYM", "VTI", "VOO",
  // Mega-Cap Tech & Semis
  "AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA", "AVGO", "AMD", "QCOM", "ORCL", "IBM", "CSCO",
  // Dividend Aristocrats & Defensive Consumer
  "KO", "PEP", "MCD", "WMT", "COST", "PG", "JNJ", "ABBV", "MRK", "PFE", "UNH",
  // Financial & Payment Giants
  "JPM", "BAC", "WFC", "V", "MA",
  // Industrial, Energy & Real Estate
  "CAT", "HON", "GE", "RTX", "CVX", "XOM", "O", "HD", "LOW", "T", "VZ", "NEE",
];

export function isToxicMemeOrPenny(symbol: string, lastPrice?: number): boolean {
  if (TOXIC_MEME_PENNY_TOKENS.has(symbol)) return true;
  if (lastPrice !== undefined && lastPrice > 0 && lastPrice < 0.005) return true;
  return false;
}

export interface BacktestTrade {
  id: number;
  subsystem?: "GRID" | "SNIPER";
  side?: "LONG" | "SHORT";
  entryTime: number; // Unix seconds
  entryPrice: number;
  stopLossPrice: number;
  fanSpreadAtEntry: number;
  tp1Time?: number;
  tp1Price?: number;
  tp1PnlPct?: number;
  tp2Time?: number;
  tp2Price?: number;
  tp2PnlPct?: number;
  slTime?: number;
  slPrice?: number;
  slPnlPct?: number;
  exitTime: number;
  exitPrice: number;
  exitType: "TP1+TP2" | "TP1+SL_BE" | "RATCHET_SL" | "SL" | "TECH_FAST_CUT" | "OPEN" | "TP1+OPEN" | "GRID_TP" | "GRID_CUT" | string;
  pnlQuote: number;
  pnlPct: number;
  holdingBars: number;
  cushionApplied?: boolean;
  costQuote?: number;
  rewardRiskAtEntry?: number;
  channelFloor?: number;
  channelCeil?: number;
  channelMid?: number;
  channelSpanPct?: number;
  zoneIndex?: number;
}

export interface MarketScanResultItem {
  rank: number;
  symbol: string;
  quoteVolume: number;
  candlesCount: number;
  timeframe: string;
  tradesCount: number;
  winTrades: number;
  lossTrades: number;
  winRate: number;
  netPnlPct: number;
  netPnlQuote: number;
  profitFactor: number;
  maxDrawdownPct: number;
  avgBarsHeld: number;
  bestTradePct: number;
  worstTradePct: number;
  spreadThreshold: number;
  dnaScore?: number;
  dnaGrade?: "S" | "A" | "B" | "AVOID";
  bounce52Rate?: number;
  dipWickPct?: number;
  span48Pct?: number;
  er48?: number;
  upDownSymmetry?: number;
  posInChannelPct?: number;
  gridStage?: string;
  recentDnaScore?: number;
  baselineDnaScore?: number;
  trendRegime?: "BULL_UPTREND" | "ACCUMULATION_RANGE" | "BEAR_DOWNTREND";
  trendLabel?: string;
  trendScore?: number;
  rsVsBtc24hPct?: number;
}

export type MaFanStage = "READY_BUY" | "DIP_RETEST" | "WATCHING_BOTTOM" | "BULLISH_TREND" | "NEUTRAL";

export interface MaFanLiveSetupItem {
  rank: number;
  symbol: string;
  stage: MaFanStage;
  stageLabel: string;
  stageBadgeColor: string;
  readyScore: number;
  lastPrice: number;
  fanSpreadPct: number;
  minSpreadRecentPct: number;
  rsi: number;
  reversalTriggers: string[];
  upsideTp1Pct: number;
  upsideTp2Pct: number;
  upsideTp3Pct: number;
  quoteVolume: number;
  timeframe: string;
}

export interface MarketScanOptions {
  scanType?: "mafan_setups" | "backtest_leaderboard";
  stageFilter?: string;
  minSpreadThreshold?: number;
  scope?: "top20" | "top30" | "top50" | "top100" | "fdusd" | "usdt" | "all" | "alpaca_stocks";
  quoteAsset?: "FDUSD" | "USDT" | "USD";
  exchange?: "binance" | "dreamdex" | "alpaca";
  timeframe?: string;
  limit?: number;
  spreadThreshold?: number | "auto";
  initialCapital?: number;
  slBufferPct?: number;
  useRatchetSl?: boolean;
  useAtrAdaptiveSpread?: boolean;
  atrMultiplier?: number;
  trailingPullbackPct?: number;
  tp1Ratio?: number;
  breakevenFeeBufferPct?: number;
  supervisorTimeframe?: "15m" | "1h";
  cushionMode?: CushionMode;
  waterfallGuardMode?: WaterfallGuardMode;
  costModel?: { feePctPerSide: number; slippagePctPerFill: number };
  macroGateMode?: "off" | "noDeepBear" | "bullOnly";
  enableUpsideFloor?: boolean;
  enableCircuitBreaker?: boolean;
  enableFastCut?: boolean;
  fastCutThresholdPct?: number;
  stagnationBars?: number;
  maxSlPct?: number;
  tradeMode?: "dip_hunter" | "trend_rider" | "dual" | "dynamic_grid" | "dual_hybrid";
  tradeDirection?: "long" | "short" | "both";
  enableBaseConfirmationFilter?: boolean;
  lockChannelInPosition?: boolean;
  capitalZones?: number;
  gridCutLossMode?: "none" | "entry_floor" | "final_zone_floor";
  channelMode?: "DOW_SWINGS" | "DOW_ATR_CLAMP" | "FIXED_PCT_CLAMP" | "DONCHIAN_ATR" | "VOLUME_PROFILE_HTF";
  donchianPeriod?: number;
  minChannelWidthPct?: number;
  maxChannelWidthPct?: number;
  zoneMinDropPct?: number;
  zoneStabilizeCandles?: number;
  downtrendSitOutMode?: "off" | "btc1d" | "btc4h" | "dual";
  gridHtfGovernor?: "off" | "1h_ema200" | "4h_ema75";
  maxChannelPos?: number;
  onProgress?: (info: { index: number; total: number; symbol: string; candlesCount: number; pnlPct?: number; winRate?: number; tradesCount?: number }) => void;
}

export interface BacktestMarker {
  time: number;
  position: "aboveBar" | "belowBar";
  color: string;
  shape: "arrowUp" | "arrowDown" | "circle" | "square";
  text: string;
  size?: number;
}

export interface BacktestSummary {
  initialCapital: number;
  finalCapital: number;
  netPnlQuote: number;
  netPnlPct: number;
  totalTrades: number;
  winTrades: number;
  lossTrades: number;
  winRate: number;
  profitFactor: number;
  maxDrawdownPct: number;
  avgBarsHeld: number;
  bestTradePct: number;
  worstTradePct: number;
  totalFeesQuote?: number;
  grossPnlQuote?: number;
}

export interface BacktestEvaluationItem {
  time: number;
  fanSpreadPct: number;
  isFanningDown: boolean;
  isHookUp: boolean;
  rsi: number;
  rsiSma?: number;
  isOversoldExhaustion: boolean;
  ema4: number;
  ema8: number;
  ema16: number;
  ema25: number;
  ema75: number;
  ema200: number;
  requiredSpreadPct?: number;
  spreadMultiplier?: number;
  isDeepBear?: boolean;
  isMacroBlocked?: boolean;
  isCircuitBreakerActive?: boolean;
}

export interface BacktestRecord {
  id: string;
  createdAt: string;
  symbol: string;
  timeframe: string;
  candleCount: number;
  spreadThreshold: number;
  isAutoCalibrated?: boolean;
  useRatchetSl?: boolean;
  macroGateMode?: "off" | "noDeepBear" | "bullOnly";
  enableUpsideFloor?: boolean;
  enableCircuitBreaker?: boolean;
  lockChannelInPosition?: boolean;
  summary: BacktestSummary;
  trades: BacktestTrade[];
  markers: BacktestMarker[];
  candles: Candle[];
  evaluations?: BacktestEvaluationItem[];
  equityCurve?: Array<{ time: number; equity: number }>;
}

export interface BacktestHistoryItem {
  id: string;
  createdAt: string;
  symbol: string;
  timeframe: string;
  candleCount: number;
  spreadThreshold: number;
  isAutoCalibrated?: boolean;
  useRatchetSl?: boolean;
  lockChannelInPosition?: boolean;
  summary: BacktestSummary;
  tradeCount: number;
}

export interface MarketScanPersistence {
  timestamp: number;
  options: MarketScanOptions;
  results: MarketScanResultItem[];
  setupResults?: MaFanLiveSetupItem[];
}

export interface MultiPairRotationOptions {
  quoteAsset: "FDUSD" | "USDT" | "USD";
  maxUniversePairs?: number;
  customWhitelist?: string[];
  blacklist?: string[];
  timeframe?: string;
  limit?: number;
  initialCapital?: number;
  portfolioMode?: "mafan_portfolio" | "grid_sequential";
  maxSlots?: number;
  tp1TargetMode?: "EMA25" | "EMA75" | "EMA200" | "none";
  lockBreakevenAtEma200?: boolean;
  partialTpAtEma200?: boolean;
  maxDisasterSlPct?: number;
  excludeToxicMemes?: boolean;
  downtrendSitOutMode?: "off" | "btc1d" | "btc4h" | "dual";
  rankBy?: "RSI15" | "COMPOSITE_QUALITY";
  rotationIntervalMinutes?: number;
  rotationIdleCashMinutes?: number;
  rotationScoreMarginPct?: number;
  minVolumeUsd?: number;
  capitalZones?: number;
  channelMode?: "DOW_SWINGS" | "DOW_ATR_CLAMP" | "FIXED_PCT_CLAMP" | "DONCHIAN_ATR" | "VOLUME_PROFILE_HTF";
  donchianPeriod?: number;
  minChannelWidthPct?: number;
  maxChannelWidthPct?: number;
  zoneMinDropPct?: number;
  zoneStabilizeCandles?: number;
  lockChannelInPosition?: boolean;
  enableBaseConfirmation?: boolean;
  enableDipHunterEntryGuard?: boolean;
  enableSignalInvalidationExit?: boolean;
  signalInvalidationMode?: "calibrated" | "strict_floor" | "off";
  enableBtcMacroGate?: boolean;
  gridCutLossMode?: "none" | "entry_floor" | "final_zone_floor";
  gridHtfGovernor?: "off" | "1h_ema200" | "4h_ema75";
  gridMaxChannelPos?: number;
}

export interface RotationLegRecord {
  legIndex: number;
  symbol: string;
  startTime: number;
  endTime: number;
  durationHours: number;
  triggerReason: "INITIAL_SELECTION" | "POST_ROUND_EXIT" | "IDLE_CASH_TIMEOUT" | "SIGNAL_DISQUALIFIED";
  entryScore: number;
  dnaGrade?: "S" | "A" | "B" | "AVOID";
  dnaScore?: number;
  recentDnaScore?: number;
  trendRegime?: "BULL_UPTREND" | "ACCUMULATION_RANGE" | "BEAR_DOWNTREND";
  trendLabel?: string;
  entryPosRatio?: number;
  previousSymbol?: string;
  previousSymbolScore?: number;
  startingCapital: number;
  endingCapital: number;
  netPnlQuote: number;
  netPnlPct: number;
  tradesCount: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  maxDrawdownPct: number;
  topCandidatesSnapshot: Array<{
    symbol: string;
    compositeScore: number;
    dnaGrade?: string;
    dnaScore?: number;
    recentDnaScore?: number;
    trendLabel?: string;
    netPnlPct: number;
    winRate: number;
    range24hPct: number;
    posRatio?: number;
  }>;
  trades: BacktestTrade[];
  candles: Candle[];
  markers: BacktestMarker[];
}

export interface PairContributionItem {
  symbol: string;
  legsCount: number;
  totalHoursHeld: number;
  tradesCount: number;
  winRate: number;
  totalNetPnlQuote: number;
  totalNetPnlPct: number;
  bestDnaGrade?: string;
  avgDnaScore?: number;
}

export interface MultiPairRotationResult {
  id: string;
  createdAt: number;
  options: MultiPairRotationOptions;
  summary: {
    quoteAsset: "FDUSD" | "USDT" | "USD";
    universeScannedCount: number;
    initialCapital: number;
    finalEquity: number;
    netPnlQuote: number;
    netPnlPct: number;
    totalRotations: number;
    totalLegs: number;
    profitableLegs: number;
    legWinRate: number;
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    tradeWinRate: number;
    maxPortfolioDrawdownPct: number;
    profitFactor: number;
    totalFeesPaid: number;
    bestPairSymbol: string;
    bestPairPnlPct: number;
    benchmarkSinglePairSymbol: string;
    benchmarkSinglePairPnlPct: number;
    benchmarkBtcBuyHoldPct?: number;
    benchmarkEqualWeightBuyHoldPct?: number;
    alphaVsBenchmarkPct: number;
    alphaVsBtcBuyHoldPct?: number;
    alphaVsEqualWeightPct?: number;
  };
  legs: RotationLegRecord[];
  pairContributions: PairContributionItem[];
  equityCurve: Array<{ time: number; equity: number; symbol: string; drawdownPct: number }>;
  allTrades: Array<BacktestTrade & { symbol: string; legIndex: number }>;
}

export interface GridDnaMetrics {
  bounce52Rate: number;      // % of touches at <=20% that hit 52% of box before -20%
  cleanBounceRate: number;   // % of touches that bounce cleanly to 52%
  bounce35Rate: number;      // % of touches that hit 35% of box (Step 1 early lock)
  fastKnifeRate: number;     // % of touches that slice straight down to -20% within <=8 bars
  bounceToKnifeRatio: number;
  avgDipWickPct: number;     // Average lower wick ratio on dip bars
  avgSpan48Pct: number;      // Average 48-bar Donchian channel span %
  avgEr48: number;           // Average Kaufman Efficiency Ratio over 48 bars
  vr16: number;              // Variance Ratio (4H vs 15m)
  upDownSymmetry: number;    // Up body sum vs Down body sum
  dnaScore: number;          // 0 - 100 composite score
  grade: "S" | "A" | "B" | "AVOID";
  isGridFit: boolean;
  reasons: string[];
  recentDnaScore?: number;
  baselineDnaScore?: number;
  trendRegime?: "BULL_UPTREND" | "ACCUMULATION_RANGE" | "BEAR_DOWNTREND";
  trendLabel?: string;
  trendScore?: number;
  ema1hSlopePct?: number;
  isDegrading?: boolean;
}

const DB_PATH = path.resolve(process.cwd(), "data", "backtest-history.db.json");
const SCAN_DB_PATH = path.resolve(process.cwd(), "data", "market-scan.db.json");

function ensureDbFile(): void {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify({ records: [] }, null, 2), "utf8");
  }
}

export class BacktestService {
  public static readonly KLINE_CACHE_DIR = path.resolve(process.cwd(), "data", "cache", "klines");
  private static candleCache = new Map<string, { timestamp: number; candles: Candle[] }>();
  private static rotationBtProgress = { phase: "idle", completed: 0, total: 0, currentSymbol: "", message: "" };
  private static latestRotationResult: MultiPairRotationResult | null = null;

  public static getRotationBtProgress() {
    return this.rotationBtProgress;
  }

  public static getLatestRotationResult(): MultiPairRotationResult | null {
    return this.latestRotationResult;
  }

  /**
   * 🧬 Market DNA Evaluator for Dynamic Grid Suitability
   * Evaluates intrinsic structural price-action characteristics via Dual-Window Recency:
   * - Baseline Window (up to 1,000 bars): Base demand absorption, liquidity, pinbar wick
   * - Recent Window (last 240 bars ~60h): Recent bounce vitality, span sweet spot, symmetry
   * - Live Trend Alignment: 4H & 1H EMA alignment & slope at current state
   */
  public static evaluateGridDna(
    candles: Candle[],
    assetClass: "CRYPTO" | "STOCK" = "CRYPTO",
    evalEndIndex?: number
  ): GridDnaMetrics {
    const endIdx = evalEndIndex !== undefined ? Math.min(candles.length, evalEndIndex + 1) : candles.length;
    const targetCandles = candles.slice(0, endIdx);
    const n = targetCandles.length;

    if (n < 60) {
      return {
        bounce52Rate: 0,
        cleanBounceRate: 0,
        bounce35Rate: 0,
        fastKnifeRate: 0,
        bounceToKnifeRatio: 0,
        avgDipWickPct: 0,
        avgSpan48Pct: 0,
        avgEr48: 1.0,
        vr16: 1.0,
        upDownSymmetry: 1.0,
        dnaScore: 0,
        grade: "AVOID",
        isGridFit: false,
        reasons: ["Insufficient candle history (< 60 bars)"],
        recentDnaScore: 0,
        baselineDnaScore: 0,
        trendRegime: "ACCUMULATION_RANGE",
        trendLabel: "รวบรวมข้อมูลแท่งเทียน (<60 แท่ง)",
        trendScore: 0,
        ema1hSlopePct: 0,
      };
    }

    // Helper for computing DNA metrics on any slice of candles
    const computeSliceDna = (slice: Candle[]) => {
      const sn = slice.length;
      let dipTouches = 0;
      let bounce52 = 0;
      let cleanBounces = 0;
      let bounce35 = 0;
      let fastKnife = 0;
      const spans: number[] = [];
      const dipWicks: number[] = [];
      const er48s: number[] = [];
      const r1: number[] = [];
      const r16: number[] = [];
      let upRangeSum = 0;
      let downRangeSum = 0;

      for (let i = 1; i < sn; i++) {
        const prev = slice[i - 1]!;
        const cur = slice[i]!;
        r1.push(Math.log(cur.close / prev.close));
        if (i >= 16) {
          r16.push(Math.log(cur.close / slice[i - 16]!.close));
        }
        if (cur.close >= cur.open) upRangeSum += (cur.high - cur.low) / cur.open;
        else downRangeSum += (cur.high - cur.low) / cur.open;
      }

      for (let i = 48; i < sn - 16; i++) {
        let hi = -Infinity;
        let lo = Infinity;
        let pathSum = 0;
        for (let j = i - 48; j < i; j++) {
          const b = slice[j]!;
          if (b.high > hi) hi = b.high;
          if (b.low < lo) lo = b.low;
          if (j > i - 48) pathSum += Math.abs(b.close - slice[j - 1]!.close);
        }
        const span = hi - lo;
        if (lo <= 0 || span <= 0) continue;
        spans.push((span / lo) * 100);
        if (pathSum > 0) {
          er48s.push(Math.abs(slice[i - 1]!.close - slice[i - 48]!.close) / pathSum);
        }

        const cur = slice[i]!;
        const lvl20 = lo + 0.20 * span;
        const lvl35 = lo + 0.35 * span;
        const lvl52 = lo + 0.52 * span;
        const cutLvl = lo - 0.20 * span;

        if (cur.low <= lvl20 && slice[i - 1]!.close > lvl20) {
          const rng = cur.high - cur.low;
          if (rng > 0) {
            dipWicks.push(((Math.min(cur.open, cur.close) - cur.low) / rng) * 100);
          }

          let outcome = 0;
          let hit35 = false;
          let knife = false;
          let bouncedClean = false;

          for (let k = i + 1; k < Math.min(sn, i + 32); k++) {
            if (slice[k]!.high >= lvl35) hit35 = true;
            if (slice[k]!.low <= cutLvl) {
              outcome = -1;
              if (k - i <= 8) knife = true;
              break;
            }
            if (slice[k]!.high >= lvl52) {
              outcome = 1;
              bouncedClean = true;
              break;
            }
          }
          if (outcome !== 0) {
            dipTouches++;
            if (outcome === 1) bounce52++;
            if (hit35) bounce35++;
            if (knife) fastKnife++;
            if (bouncedClean) cleanBounces++;
          }
        }
      }

      const mean = (arr: number[]) => (arr.length > 0 ? arr.reduce((s, x) => s + x, 0) / arr.length : 0);
      const variance = (arr: number[]) => {
        if (arr.length < 2) return 0;
        const m = mean(arr);
        return arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1);
      };

      const var1 = variance(r1);
      const var16 = variance(r16);
      const vr16 = var1 > 0 ? var16 / (16 * var1) : 1.0;

      const bounce52Rate = dipTouches > 0 ? (bounce52 / dipTouches) * 100 : 0;
      const cleanBounceRate = dipTouches > 0 ? (cleanBounces / dipTouches) * 100 : 0;
      const bounce35Rate = dipTouches > 0 ? (bounce35 / dipTouches) * 100 : 0;
      const fastKnifeRate = dipTouches > 0 ? (fastKnife / dipTouches) * 100 : 0;
      const bounceToKnifeRatio = fastKnife > 0 ? bounce52 / fastKnife : bounce52;
      const avgDipWickPct = mean(dipWicks);
      const avgSpan48Pct = mean(spans);
      const avgEr48 = mean(er48s);
      const upDownSymmetry = downRangeSum > 0 ? upRangeSum / downRangeSum : 1.0;

      // Component score calculation (0 - 100)
      let bounceScore = 0;
      if (bounce52Rate >= 58) bounceScore = 35;
      else if (bounce52Rate >= 54) bounceScore = 28;
      else if (bounce52Rate >= 50) bounceScore = 18;
      else bounceScore = 5;

      let wickScore = 0;
      const wickThreshold = assetClass === "STOCK" ? 27.0 : 32.0;
      if (avgDipWickPct >= wickThreshold + 3) wickScore = 20;
      else if (avgDipWickPct >= wickThreshold) wickScore = 15;
      else if (avgDipWickPct >= wickThreshold - 4) wickScore = 10;
      else wickScore = 3;

      let spanScore = 0;
      const minSpan = assetClass === "STOCK" ? 2.2 : 2.8;
      const maxSpan = assetClass === "STOCK" ? 6.0 : 5.8;
      if (avgSpan48Pct >= minSpan && avgSpan48Pct <= maxSpan) spanScore = 20;
      else if (avgSpan48Pct >= minSpan * 0.8 && avgSpan48Pct <= maxSpan * 1.2) spanScore = 10;
      else spanScore = 0;

      let erScore = 0;
      const maxEr = assetClass === "STOCK" ? 0.20 : 0.148;
      if (avgEr48 <= maxEr && vr16 <= 1.05) erScore = 15;
      else if (avgEr48 <= maxEr * 1.15) erScore = 9;
      else erScore = 2;

      let symScore = 0;
      if (upDownSymmetry >= 1.03) symScore = 10;
      else if (upDownSymmetry >= 0.98) symScore = 6;
      else symScore = 1;

      const rawScore = Math.min(100, Math.round(bounceScore + wickScore + spanScore + erScore + symScore));

      return {
        dipTouches,
        bounce52Rate,
        cleanBounceRate,
        bounce35Rate,
        fastKnifeRate,
        bounceToKnifeRatio,
        avgDipWickPct,
        avgSpan48Pct,
        avgEr48,
        vr16,
        upDownSymmetry,
        rawScore,
      };
    };

    // 1. Calculate Baseline Window (up to 1,000 bars)
    const baselineSlice = targetCandles.slice(Math.max(0, n - 1000));
    const baseMetrics = computeSliceDna(baselineSlice);

    // 2. Calculate Recent Form Window (last 240 bars ~60h)
    let recentMetrics = baseMetrics;
    if (n >= 240) {
      const recentSlice = targetCandles.slice(n - 240);
      recentMetrics = computeSliceDna(recentSlice);
    }

    // 3. Dynamic Rolling Weighted DNA Score: 60% Recent Form + 40% Baseline (or 100% baseline if history < 240)
    const baselineDnaScore = baseMetrics.rawScore;
    const recentDnaScore = recentMetrics.rawScore;
    const weightedDnaScore = n >= 240
      ? Math.round(recentDnaScore * 0.60 + baselineDnaScore * 0.40)
      : baselineDnaScore;

    // 4. Live Forward Trend Alignment (4H and 1H EMAs on 15m candles: 1H=80 bars, 4H=320 bars)
    const lastC = targetCandles[n - 1]!;
    let trendRegime: "BULL_UPTREND" | "ACCUMULATION_RANGE" | "BEAR_DOWNTREND" = "ACCUMULATION_RANGE";
    let trendLabel = "🔄 ไซด์เวย์สะสมพลัง (Range)";
    let trendScore = 15;
    let ema1hSlopePct = 0;

    if (n >= 120) {
      // Calculate 1H EMA20 (equivalent to EMA80 on 15m) & 1H EMA50 (equivalent to EMA200 on 15m)
      const k80 = 2 / (80 + 1);
      const k200 = 2 / (200 + 1);
      let ema80 = targetCandles[0]!.close;
      let ema200 = targetCandles[0]!.close;
      const ema200History: number[] = [];

      for (let i = 1; i < n; i++) {
        const cPrice = targetCandles[i]!.close;
        ema80 = cPrice * k80 + ema80 * (1 - k80);
        ema200 = cPrice * k200 + ema200 * (1 - k200);
        ema200History.push(ema200);
      }

      const prevEma200 = ema200History[Math.max(0, ema200History.length - 16)] ?? ema200;
      ema1hSlopePct = prevEma200 > 0 ? ((ema200 - prevEma200) / prevEma200) * 100 : 0;

      // 4H Trend estimation (last 60h High/Low mid)
      const last60hBars = targetCandles.slice(Math.max(0, n - 240));
      const htfHigh = Math.max(...last60hBars.map((b) => b.high));
      const htfLow = Math.min(...last60hBars.map((b) => b.low));
      const htfCenter = (htfHigh + htfLow) * 0.5;

      const isBullAlignment = lastC.close >= ema200 && ema80 >= ema200 * 0.998 && ema1hSlopePct >= -0.05;
      const isBearAlignment = lastC.close < ema200 && ema80 < ema200 * 0.995 && lastC.close < htfCenter && ema1hSlopePct < -0.10;

      if (isBullAlignment) {
        trendRegime = "BULL_UPTREND";
        trendLabel = "🐂 ขาขึ้นยกฐาน (4H+1H Bull)";
        trendScore = 35;
      } else if (isBearAlignment) {
        trendRegime = "BEAR_DOWNTREND";
        trendLabel = "🐻 ขาลง (4H Bear Flow)";
        trendScore = 0;
      } else {
        trendRegime = "ACCUMULATION_RANGE";
        trendLabel = "🔄 ไซด์เวย์สะสมพลัง (Range)";
        trendScore = 18;
      }
    }

    // Degradation & Protection Checks
    const reasons: string[] = [];
    const isCrypto = assetClass === "CRYPTO";

    // Hard Gate Verification
    const isCryptoFit =
      isCrypto &&
      baseMetrics.bounce52Rate >= 52.0 &&
      baseMetrics.bounceToKnifeRatio >= 1.60 &&
      baseMetrics.avgDipWickPct >= 28.0 &&
      baseMetrics.avgSpan48Pct >= 2.5 &&
      baseMetrics.avgSpan48Pct <= 6.5 &&
      baseMetrics.avgEr48 <= 0.160 &&
      baseMetrics.upDownSymmetry >= 0.95;

    const isStockFit =
      !isCrypto &&
      baseMetrics.bounce52Rate >= 52.0 &&
      baseMetrics.bounceToKnifeRatio >= 2.00 &&
      baseMetrics.avgDipWickPct >= 24.0 &&
      baseMetrics.avgSpan48Pct >= 2.4 &&
      baseMetrics.avgSpan48Pct <= 6.2 &&
      baseMetrics.upDownSymmetry >= 0.98;

    const isGridFit = (isCryptoFit || isStockFit) && trendRegime !== "BEAR_DOWNTREND";

    // Dynamic Degradation: If recent 60h shows heavy one-way bleed, degrade to B or AVOID
    const isRecentBleeding = n >= 240 && (recentMetrics.fastKnifeRate >= 50 && recentMetrics.bounce52Rate < 45 && recentMetrics.avgEr48 > 0.16);

    let grade: "S" | "A" | "B" | "AVOID";
    if (trendRegime === "BEAR_DOWNTREND") {
      grade = "AVOID";
      reasons.push("Active 4H/1H Downtrend Flow");
    } else if (isRecentBleeding) {
      grade = "B";
      reasons.push("Recent 60h one-way bleeding momentum");
    } else if (weightedDnaScore >= 75 && isGridFit) {
      grade = "S";
    } else if (weightedDnaScore >= 64 && isGridFit) {
      grade = "A";
    } else if (weightedDnaScore >= 50) {
      grade = "B";
    } else {
      grade = "AVOID";
    }

    if (!isGridFit && grade !== "AVOID") {
      if (baseMetrics.bounce52Rate < 54.0) reasons.push(`Low midline bounce rate (${baseMetrics.bounce52Rate.toFixed(1)}% < 54%)`);
      if (baseMetrics.avgDipWickPct < (isCrypto ? 30.0 : 24.0)) reasons.push(`Lack of demand absorption wick (${baseMetrics.avgDipWickPct.toFixed(1)}%)`);
      if (baseMetrics.avgSpan48Pct < (isCrypto ? 2.6 : 2.4)) reasons.push(`Channel span too narrow (${baseMetrics.avgSpan48Pct.toFixed(2)}%)`);
      if (baseMetrics.avgSpan48Pct > 6.2) reasons.push(`Channel span too erratic/wide (${baseMetrics.avgSpan48Pct.toFixed(2)}% > 6.2%)`);
    } else if (isGridFit) {
      reasons.push(`Rolling DNA OK: Bounce=${baseMetrics.bounce52Rate.toFixed(1)}%, DipWick=${baseMetrics.avgDipWickPct.toFixed(1)}%, Span=${baseMetrics.avgSpan48Pct.toFixed(2)}%, Trend=${trendLabel}`);
    }

    return {
      bounce52Rate: baseMetrics.bounce52Rate,
      cleanBounceRate: baseMetrics.cleanBounceRate,
      bounce35Rate: baseMetrics.bounce35Rate,
      fastKnifeRate: baseMetrics.fastKnifeRate,
      bounceToKnifeRatio: baseMetrics.bounceToKnifeRatio,
      avgDipWickPct: baseMetrics.avgDipWickPct,
      avgSpan48Pct: baseMetrics.avgSpan48Pct,
      avgEr48: baseMetrics.avgEr48,
      vr16: baseMetrics.vr16,
      upDownSymmetry: baseMetrics.upDownSymmetry,
      dnaScore: weightedDnaScore,
      grade,
      isGridFit,
      reasons,
      recentDnaScore,
      baselineDnaScore,
      trendRegime,
      trendLabel,
      trendScore,
      ema1hSlopePct,
      isDegrading: Boolean(recentDnaScore < baselineDnaScore - 12 || (recentDnaScore < 45 && baselineDnaScore >= 60)),
    };
  }

  /**
   * Fetch historical candles from Alpaca Market Data API v2 (US Equities & ETFs)
   * Supports 1m, 5m, 15m, 1h, 1d timeframes with RAM & Disk Caching
   */
  public static async fetchAlpacaCandles(
    symbol: string,
    interval: string = "15m",
    limit: number = 2000
  ): Promise<Candle[]> {
    const cleanSym = symbol.toUpperCase().replace(/[\/\-_:]/g, "").replace(/USD$/, "");
    const cacheKey = `ALPACA_${cleanSym}_${interval}`;
    const cached = this.candleCache.get(cacheKey);
    const nowMs = Date.now();

    // 1. In-memory candle cache: if we already fetched >= limit candles within 5 minutes, reuse instantly
    if (cached && cached.candles.length >= limit && (nowMs - cached.timestamp < 300_000)) {
      console.log(`[CandleFeed] ⚡ RAM Cache HIT for Alpaca ${cleanSym} (${interval}) -> using ${cached.candles.length} cached candles`);
      return cached.candles.slice(-limit);
    }

    // 2. Persistent Disk Cache: check data/cache/klines/ for previously saved historical bars
    const diskPath = path.join(BacktestService.KLINE_CACHE_DIR, `alpaca_${cleanSym}_${interval}.json`);
    if (!cached && fs.existsSync(diskPath)) {
      try {
        const raw = fs.readFileSync(diskPath, "utf8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.candles) && parsed.candles.length >= limit) {
          const lastCandleTime = parsed.candles[parsed.candles.length - 1]?.time || 0;
          const ageSec = Math.floor(nowMs / 1000) - lastCandleTime;
          if (ageSec < 7200 || !cached) {
            console.log(`[CandleFeed] 💾 Disk Cache HIT for Alpaca ${cleanSym} (${interval}) -> using ${parsed.candles.length} candles`);
            this.candleCache.set(cacheKey, { timestamp: parsed.timestamp || nowMs, candles: parsed.candles });
            return parsed.candles.slice(-limit);
          }
        }
      } catch {}
    }

    // Map timeframe
    let tf = "15Min";
    let intervalMinutes = 15;
    if (interval === "1m") { tf = "1Min"; intervalMinutes = 1; }
    else if (interval === "5m") { tf = "5Min"; intervalMinutes = 5; }
    else if (interval === "15m") { tf = "15Min"; intervalMinutes = 15; }
    else if (interval === "1h") { tf = "1Hour"; intervalMinutes = 60; }
    else if (interval === "1d") { tf = "1Day"; intervalMinutes = 1440; }

    // In US Equities: 6.5 trading hours/day (390 mins), 5 days/week.
    // 5m: 78 bars/trading day -> ~55 bars/calendar day.
    // 15m: 26 bars/trading day -> ~18 bars/calendar day.
    // 1h: 6.5 bars/trading day -> ~4.6 bars/calendar day.
    // 1d: 1 bar/trading day -> ~0.71 bars/calendar day.
    let barsPerCalendarDay = 55;
    if (interval === "1m") barsPerCalendarDay = 270;
    else if (interval === "5m") barsPerCalendarDay = 55;
    else if (interval === "15m") barsPerCalendarDay = 18;
    else if (interval === "1h") barsPerCalendarDay = 4.6;
    else if (interval === "1d") barsPerCalendarDay = 0.71;

    // For US stocks, clamp excessive limit (e.g. 34,560 bars of 5m is ~1.7 years) to max 8,000 bars (~145 calendar days)
    // so all pairs fetch recent live history fast and remain synchronized!
    const effectiveLimit = Math.min(8000, limit);
    const daysBack = Math.max(30, Math.ceil(effectiveLimit / barsPerCalendarDay) + 14);
    const startDate = new Date(nowMs - daysBack * 86400 * 1000);
    const startIso = startDate.toISOString().split(".")[0] + "Z";

    const apiKey = process.env.ALPACA_API_KEY || "PKYAVG2YEWF3SWIPPJT3C42TVG";
    const apiSecret = process.env.ALPACA_API_SECRET || "2boZiaaqiLDfDEM9XSULbXq2iW69B9WcAEPu234MeuN2";
    const dataUrl = process.env.ALPACA_DATA_URL || "https://data.alpaca.markets";

    console.log(`[CandleFeed] 📥 Alpaca ${cleanSym} (${interval}): Fetching up to ${effectiveLimit} bars from ${startIso}...`);

    let candles: Candle[] = [];
    let pageToken: string | undefined = undefined;
    let attempts = 0;

    do {
      let url = `${dataUrl}/v2/stocks/${cleanSym}/bars?timeframe=${tf}&start=${startIso}&adjustment=all&feed=iex&limit=10000`;
      if (pageToken) url += `&page_token=${encodeURIComponent(pageToken)}`;

      const res = await fetch(url, {
        headers: {
          "APCA-API-KEY-ID": apiKey,
          "APCA-API-SECRET-KEY": apiSecret,
        },
      });

      if (!res.ok) {
        console.warn(`[CandleFeed] ⚠️ Alpaca bar request failed for ${cleanSym} (HTTP ${res.status})`);
        break;
      }

      const d: any = await res.json();
      const rawBars: any[] = d.bars || [];
      for (const b of rawBars) {
        const time = Math.floor(new Date(b.t).getTime() / 1000);
        const open = Number(b.o);
        const high = Number(b.h);
        const low = Number(b.l);
        const close = Number(b.c);
        const volume = Number(b.v) || 0;
        if ([time, open, high, low, close].every(Number.isFinite) && close > 0) {
          candles.push({ time, open, high, low, close, volume, isClosed: true });
        }
      }

      pageToken = d.next_page_token;
      attempts++;
    } while (pageToken && candles.length < effectiveLimit && attempts < 15);

    const map = new Map<number, Candle>();
    for (const c of candles) map.set(c.time, c);
    const sorted = Array.from(map.values()).sort((a, b) => a.time - b.time);

    if (sorted.length > 0) {
      this.candleCache.set(cacheKey, { timestamp: nowMs, candles: sorted });
      try {
        if (!fs.existsSync(BacktestService.KLINE_CACHE_DIR)) {
          fs.mkdirSync(BacktestService.KLINE_CACHE_DIR, { recursive: true });
        }
        fs.writeFileSync(diskPath, JSON.stringify({ timestamp: nowMs, candles: sorted }), "utf8");
      } catch {}
    }

    return sorted.slice(-limit);
  }

  /**
   * Fetch historical candles from Binance Spot REST API
   */
  public static async fetchBinanceCandles(
    symbol: string,
    interval: string = "5m",
    limit: number = 1000
  ): Promise<Candle[]> {
    const cleanSym = symbol.toUpperCase().replace(/[\/\-_:]/g, "");
    const cacheKey = `${cleanSym}_${interval}`;
    const cached = this.candleCache.get(cacheKey);
    const nowMs = Date.now();

    // 1. In-memory candle cache: if we already fetched >= limit candles within 5 minutes, reuse instantly
    if (cached && cached.candles.length >= limit && (nowMs - cached.timestamp < 300_000)) {
      console.log(`[CandleFeed] ⚡ RAM Cache HIT for ${cleanSym} (${interval}) -> using ${cached.candles.length} cached candles`);
      return cached.candles.slice(-limit);
    }

    // 2. Persistent Disk Cache: check data/cache/klines/ for previously saved historical bars
    const diskPath = path.join(BacktestService.KLINE_CACHE_DIR, `${cleanSym}_${interval}.json`);
    if (!cached && fs.existsSync(diskPath)) {
      try {
        const raw = fs.readFileSync(diskPath, "utf8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.candles) && parsed.candles.length >= limit) {
          const lastCandleTime = parsed.candles[parsed.candles.length - 1]?.time || 0;
          const ageSec = Math.floor(nowMs / 1000) - lastCandleTime;
          if (ageSec < 7200 || !cached) {
            console.log(`[CandleFeed] 💾 Disk Cache HIT for ${cleanSym} (${interval}) -> using ${parsed.candles.length} candles`);
            this.candleCache.set(cacheKey, { timestamp: parsed.timestamp || nowMs, candles: parsed.candles });
            return parsed.candles.slice(-limit);
          }
        }
      } catch {}
    }

    // Quick single fetch if limit <= 1000
    if (limit <= 1000) {
      const clampedLimit = Math.min(1000, Math.max(50, limit));
      const url = `https://api.binance.com/api/v3/klines?symbol=${cleanSym}&interval=${interval}&limit=${clampedLimit}`;

      console.log(`[CandleFeed] 📥 ${cleanSym} (${interval}): Fetching ${clampedLimit} candles from Binance...`);
      const res = await fetch(url, { headers: { "User-Agent": "dynamic-grid-bn/backtest" } });
      if (!res.ok) {
        throw new Error(`Failed to fetch historical candles from Binance (HTTP ${res.status})`);
      }

      const raw = (await res.json()) as any[];
      if (!Array.isArray(raw) || raw.length === 0) {
        throw new Error(`No historical candles returned for ${cleanSym} on ${interval}`);
      }

      const candles: Candle[] = [];
      for (const k of raw) {
        const time = Math.floor(Number(k[0]) / 1000);
        const closeTimeMs = Number(k[6]);
        // Filter out live forming unclosed bar to ensure backtest evaluates strictly closed bars
        if (Number.isFinite(closeTimeMs) && closeTimeMs > nowMs) continue;
        const open = Number(k[1]);
        const high = Number(k[2]);
        const low = Number(k[3]);
        const close = Number(k[4]);
        const volume = Number(k[5]) || 0;

        if ([time, open, high, low, close].every(Number.isFinite) && close > 0) {
          candles.push({ time, open, high, low, close, volume, isClosed: true });
        }
      }

      const sorted = candles.sort((a, b) => a.time - b.time);
      this.candleCache.set(cacheKey, { timestamp: nowMs, candles: sorted });
      try {
        if (!fs.existsSync(BacktestService.KLINE_CACHE_DIR)) {
          fs.mkdirSync(BacktestService.KLINE_CACHE_DIR, { recursive: true });
        }
        let shouldWrite = true;
        if (fs.existsSync(diskPath)) {
          try {
            const existing = JSON.parse(fs.readFileSync(diskPath, "utf8"));
            if (Array.isArray(existing?.candles) && existing.candles.length > sorted.length) {
              shouldWrite = false;
            }
          } catch {}
        }
        if (shouldWrite) {
          fs.writeFileSync(diskPath, JSON.stringify({ timestamp: nowMs, candles: sorted }), "utf8");
        }
      } catch {}
      console.log(`[CandleFeed] ✅ ${cleanSym} (${interval}): Loaded ${sorted.length} candles (saved to disk cache).`);
      return sorted;
    }

    // Extended Multi-page fetch for up to 120+ days (up to 60,000 candles)
    const candlesMap = new Map<number, Candle>();
    let currentEndTime: number | undefined = undefined;
    const maxCandles = Math.min(60000, Math.max(50, limit));
    const maxBatches = Math.ceil(maxCandles / 1000) + 3;

    console.log(`[CandleFeed] 📥 ${cleanSym} (${interval}): Fetching ${maxCandles} candles from Binance (${maxBatches} batches max)...`);

    for (let batch = 0; batch < maxBatches && candlesMap.size < maxCandles; batch++) {
      if (batch % 5 === 0 || batch === maxBatches - 1) {
        console.log(`[CandleFeed] ${cleanSym} [Batch ${batch + 1}/${maxBatches}] Loaded ${candlesMap.size}/${maxCandles} candles...`);
      }

      let url = `https://api.binance.com/api/v3/klines?symbol=${cleanSym}&interval=${interval}&limit=1000`;
      if (currentEndTime) {
        url += `&endTime=${currentEndTime}`;
      }

      let res = await fetch(url, { headers: { "User-Agent": "dynamic-grid-bn/backtest" } });
      if (res.status === 429) {
        console.warn(`[CandleFeed] ⚠️ Binance 429 Rate Limit for ${cleanSym}, pausing 1.8s before retry...`);
        await new Promise((r) => setTimeout(r, 1800));
        res = await fetch(url, { headers: { "User-Agent": "dynamic-grid-bn/backtest" } });
      }
      if (!res.ok) {
        if (candlesMap.size >= limit * 0.9) break; // Graceful fallback if we already got >= 90% of requested candles
        console.warn(`[CandleFeed] ⚠️ Binance returned HTTP ${res.status} for ${cleanSym} (got ${candlesMap.size} candles)`);
        if (candlesMap.size > 0) break;
        throw new Error(`Failed to fetch historical candles from Binance (HTTP ${res.status})`);
      }

      const raw = (await res.json()) as any[];
      if (!Array.isArray(raw) || raw.length === 0) break;

      let earliestOpenMs = Infinity;

      for (const k of raw) {
        const openTimeMs = Number(k[0]);
        const closeTimeMs = Number(k[6]);
        if (Number.isFinite(closeTimeMs) && closeTimeMs > nowMs) continue;
        const time = Math.floor(openTimeMs / 1000);
        const open = Number(k[1]);
        const high = Number(k[2]);
        const low = Number(k[3]);
        const close = Number(k[4]);
        const volume = Number(k[5]) || 0;

        if ([time, open, high, low, close].every(Number.isFinite) && close > 0) {
          candlesMap.set(time, { time, open, high, low, close, volume, isClosed: true });
        }
        if (openTimeMs < earliestOpenMs) {
          earliestOpenMs = openTimeMs;
        }
      }

      if (earliestOpenMs === Infinity || earliestOpenMs === currentEndTime) {
        break;
      }
      currentEndTime = earliestOpenMs - 1;

      // Gentle rate pacing to avoid hitting Binance 1200 weight/min limit
      await new Promise((r) => setTimeout(r, 35));
    }

    if (candlesMap.size === 0) {
      throw new Error(`No historical candles returned for ${cleanSym} on ${interval}`);
    }

    const sorted = Array.from(candlesMap.values()).sort((a, b) => a.time - b.time);
    const resultCandles = sorted.slice(-maxCandles);
    this.candleCache.set(cacheKey, { timestamp: Date.now(), candles: resultCandles });
    try {
      if (!fs.existsSync(BacktestService.KLINE_CACHE_DIR)) {
        fs.mkdirSync(BacktestService.KLINE_CACHE_DIR, { recursive: true });
      }
      fs.writeFileSync(diskPath, JSON.stringify({ timestamp: Date.now(), candles: resultCandles }), "utf8");
    } catch {}
    console.log(`[CandleFeed] ✅ ${cleanSym} (${interval}): Successfully loaded ${resultCandles.length} candles (saved to disk cache).`);
    return resultCandles;
  }

  /**
   * Aggregates lower timeframe candles (e.g. 5m) into higher timeframe candles (e.g. 15m).
   */
  public static aggregateCandles(candles: Candle[], targetMinutes = 15): Candle[] {
    const targetSeconds = targetMinutes * 60;
    const groups = new Map<number, Candle>();
    for (const c of candles) {
      const bucket = Math.floor(c.time / targetSeconds) * targetSeconds;
      const existing = groups.get(bucket);
      if (!existing) {
        groups.set(bucket, { time: bucket, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 });
      } else {
        existing.high = Math.max(existing.high, c.high);
        existing.low = Math.min(existing.low, c.low);
        existing.close = c.close;
        existing.volume = (existing.volume || 0) + (c.volume || 0);
      }
    }
    return Array.from(groups.values()).sort((a, b) => a.time - b.time);
  }

  /**
   * Run full-fidelity simulation for Dynamic Grid (Dow Market Structure 4-Channel Grid)
   */
  public static runDynamicGridSimulation(
    candles: Candle[],
    opts: {
      symbol: string;
      timeframe?: string;
      initialCapital?: number;
      maxInventoryQuote?: number;
      costModel?: { feePctPerSide: number; slippagePctPerFill: number };
      saveToHistory?: boolean;
      enableBaseConfirmationFilter?: boolean;
      regimeFilterMode?: "SIDEWAY_ONLY" | "NO_DOWNTREND" | "UPTREND_AND_SIDEWAY" | "OFF";
      lockChannelInPosition?: boolean;
      channelMode?: "DOW_SWINGS" | "DOW_ATR_CLAMP" | "FIXED_PCT_CLAMP" | "DONCHIAN_ATR" | "VOLUME_PROFILE_HTF";
      donchianPeriod?: number;
      minChannelWidthPct?: number;
      maxChannelWidthPct?: number;
      floorBufferPct?: number;
      capitalZones?: number;
      zoneStabilizeCandles?: number;
      zoneMinDropPct?: number;
      zoneRequireReversal?: boolean;
      gridCutLossMode?: "none" | "entry_floor" | "final_zone_floor";
      enableGridTrailingStop?: boolean;
      gridTrailingBreakevenRatio?: number;
      gridTrailingProfitLockRatio?: number;
      gridTrailingProfitLockTargetRatio?: number;
      buyLevelPcts?: number[];
      sellLevelPcts?: number[];
      buyWeights?: number[];
      zoneExitMode?: "PORTFOLIO_AVG" | "ORIGINAL_TARGETS" | "PER_ZONE";
      minNetProfitPct?: number;
      startTradingBarIndex?: number;
      enableDipHunterEntryGuard?: boolean;
      onFlatCheckStop?: (state: {
        barIndex: number;
        time: number;
        cash: number;
        trigger: "POST_ROUND_EXIT" | "IDLE_CASH_TIMEOUT";
      }) => boolean;
      onSignalInvalidationCheck?: (state: {
        barIndex: number;
        time: number;
        closePrice: number;
        floorPrice: number;
        change24hPct: number;
        posRatio24h: number;
        heldLotsCount: number;
        unrealizedPnlPct: number;
      }) => boolean;
    }
  ): BacktestRecord {
    const symbol = opts.symbol.toUpperCase().replace(/[\/\-_:]/g, "");
    const timeframe = opts.timeframe || "5m";
    const initialCapital = opts.initialCapital ?? 200;
    const maxInventory = opts.maxInventoryQuote ?? initialCapital;
    const cm = opts.costModel ?? { feePctPerSide: 0, slippagePctPerFill: 0 };
    const makerFeePct = cm.feePctPerSide ?? 0;
    const makerSlippagePct = cm.slippagePctPerFill ?? 0;
    const makerCostPerFill = (makerFeePct + makerSlippagePct) / 100;

    // Realistic Institutional Taker Costs for Emergency Exits (Stop Loss / Trailing Stop)
    const takerFeePct = makerFeePct > 0 ? makerFeePct : 0.075;
    const takerSlippagePct = 0.10;
    const takerCostPerFill = (takerFeePct + takerSlippagePct) / 100;
    const costPerFill = makerCostPerFill;

    const atrs = calcATR(candles, 14);

    // คำนวณ Multi-Timeframe EMAs บนฐาน 15m (O(N) Zero-Lookahead):
    // - 15m EMA50  = 50 bars
    // - 1H  EMA20  = 80 bars  | 1H EMA50  = 200 bars
    // - 4H  EMA20  = 320 bars | 4H EMA50  = 800 bars
    const ema50s: number[] = new Array(candles.length).fill(0);
    const ema80s: number[] = new Array(candles.length).fill(0);
    const ema200s: number[] = new Array(candles.length).fill(0);
    const ema320s: number[] = new Array(candles.length).fill(0);
    const ema800s: number[] = new Array(candles.length).fill(0);
    if (candles.length > 0) {
      const k50 = 2 / (50 + 1);
      const k80 = 2 / (80 + 1);
      const k200 = 2 / (200 + 1);
      const k320 = 2 / (320 + 1);
      const k800 = 2 / (800 + 1);
      const c0 = candles[0].close;
      ema50s[0] = c0;
      ema80s[0] = c0;
      ema200s[0] = c0;
      ema320s[0] = c0;
      ema800s[0] = c0;
      for (let idx = 1; idx < candles.length; idx++) {
        const cl = candles[idx].close;
        ema50s[idx] = cl * k50 + ema50s[idx - 1] * (1 - k50);
        ema80s[idx] = cl * k80 + ema80s[idx - 1] * (1 - k80);
        ema200s[idx] = cl * k200 + ema200s[idx - 1] * (1 - k200);
        ema320s[idx] = cl * k320 + ema320s[idx - 1] * (1 - k320);
        ema800s[idx] = cl * k800 + ema800s[idx - 1] * (1 - k800);
      }
    }

    const totalZones = Math.max(1, Math.min(5, opts.capitalZones ?? 1));
    const zoneStabilizeCandles = Math.max(1, opts.zoneStabilizeCandles ?? 3);
    const zoneMinDropPct = Math.max(0.5, opts.zoneMinDropPct ?? 2.5);
    const gridCutLossMode = opts.gridCutLossMode ?? "entry_floor";
    const enableGridTrailingStop = opts.enableGridTrailingStop ?? true;
    const gridTrailingBreakevenRatio = opts.gridTrailingBreakevenRatio ?? 0.50;
    const gridTrailingProfitLockRatio = opts.gridTrailingProfitLockRatio ?? 0.70;
    const gridTrailingProfitLockTargetRatio = opts.gridTrailingProfitLockTargetRatio ?? 0.50;
    const zoneExitMode = opts.zoneExitMode ?? "PORTFOLIO_AVG";
    const minNetProfitPct = Math.max(0.15, opts.minNetProfitPct ?? 0.25);
    const makerRoundtripFeePct = makerCostPerFill * 2 * 100;
    const effectiveMinProfitPct = Math.max(minNetProfitPct, makerRoundtripFeePct + 0.20);
    const curBuys = opts.buyLevelPcts ?? [20, 12];
    const curSells = opts.sellLevelPcts ?? [52, 72];
    const curBuyWeights = opts.buyWeights ?? [55, 45];
    const totalBuyWeight = curBuyWeights.reduce((s, w) => s + w, 0) || 100;
    const regimeFilterMode = opts.regimeFilterMode ?? "UPTREND_AND_SIDEWAY";
    const zoneBudgetQuote = maxInventory / totalZones;
    const zoneRequireReversal = opts.zoneRequireReversal !== false;
    let isZoneReversalConfirmed = true;
    let zoneDumpLowPrice = 0;
    let zoneUnlockCandleIdx = 0;

    let unlockedCapitalZones = 1;
    let stableFloorCandleCount = 0;
    let prevCandidateFloor: number | undefined = undefined;
    let lastZoneUnlockFloor: number | undefined = undefined;
    let activeChannel: {
      floor: number;
      ceiling: number;
      center: number;
      channelSpan: number;
      buyLevels: number[];
      sellTargets: number[];
    } | null = null;

    const dow = new DowStructureEngine(3, true, 20.0, 300);
    const warmup = Math.min(100, Math.floor(candles.length / 4));
    for (let k = 0; k < warmup; k++) {
      dow.addCandle(candles[k]);
    }

    const lockChannelInPosition = opts.lockChannelInPosition !== false;
    let lockedChannel: {
      floor: number;
      ceiling: number;
      center: number;
      channelSpan: number;
      buyLevels: number[];
      sellTargets: number[];
    } | null = null;

    let cash = initialCapital;
    let heldLots: Array<{
      id: number;
      index: number;
      zoneIndex?: number;
      qty: number;
      buyPrice: number;
      entryTime: number;
      entryIdx: number;
      targetPrice: number;
      costQuote: number;
      floorAtEntry?: number;
      ceilingAtEntry?: number;
      centerAtEntry?: number;
      peakPrice?: number;
      stopLossPrice?: number;
      beLocked?: boolean;
      profitLocked?: boolean;
      isTimeDecayEscape?: boolean;
      enteredInUptrend?: boolean;
    }> = [];

    const trades: BacktestTrade[] = [];
    const markers: BacktestMarker[] = [];
    const gridEquityCurve: Array<{ time: number; equity: number }> = [];
    let grossProfit = 0;
    let grossLoss = 0;
    let wins = 0;
    let losses = 0;
    let peakEquity = initialCapital;
    let maxDrawdownPct = 0;
    let tradeCounter = 0;
    let totalFeesQuote = 0;

    const startIdx = opts.startTradingBarIndex !== undefined ? Math.max(warmup, opts.startTradingBarIndex) : warmup;
    let lastFlatTime = candles.length > startIdx ? candles[startIdx].time : Date.now();
    let wasHolding = false;
    let lastProcessedBar = candles.length > 0 ? candles.length - 1 : 0;
    let consecutiveReds = 0;

    for (let i = warmup; i < candles.length; i++) {
      lastProcessedBar = i;
      const c = candles[i];
      if (c.close < c.open) {
        consecutiveReds++;
      } else {
        consecutiveReds = 0;
      }
      dow.addCandle(c);

      const isTradingActive = i >= startIdx;

      const curAtr = atrs[i] ?? (c.close * 0.005);
      const atrPct = c.close > 0 ? (curAtr / c.close) * 100 : 0.5;
      const configuredMinWidth = opts.minChannelWidthPct ?? 2.0;
      // สำหรับสินทรัพย์ความผันผวนต่ำ (เช่น หุ้นสหรัฐฯ KO, SPY ที่ atrPct < 0.25%) อนุญาตให้บีบกรอบลงมาได้ถึง 1.0% ตาม ATR จริง
      const effectiveMinWidthFloor = atrPct < 0.25 ? Math.max(1.0, atrPct * 6.0) : configuredMinWidth;
      const dynamicMinWidth = Math.max(effectiveMinWidthFloor, Math.min(4.5, atrPct * 4.0));

      const structure = dow.getStructure(c.close, undefined, {
        useOnlyClosedCandles: true,
        mode: opts.channelMode ?? "DONCHIAN_ATR",
        donchianLookback: opts.donchianPeriod ?? 48,
        minChannelWidthPct: dynamicMinWidth,
        maxChannelWidthPct: opts.maxChannelWidthPct ?? 25.0,
        floorBufferPct: opts.floorBufferPct ?? 0.0,
      });

      // 🌐 Multi-Timeframe (4H & 1H) Macro Governor & Structural Floor Calculation:
      const curEma50 = ema50s[i] ?? c.close;
      const cur1hEma20 = ema80s[i] ?? c.close;
      const prev1hEma20 = ema80s[Math.max(0, i - 4)] ?? cur1hEma20;
      const cur1hEma50 = ema200s[i] ?? c.close;
      const prev1hEma50 = ema200s[Math.max(0, i - 8)] ?? cur1hEma50;
      const cur4hEma20 = ema320s[i] ?? c.close;
      const prev4hEma20 = ema320s[Math.max(0, i - 16)] ?? cur4hEma20;
      const cur4hEma50 = ema800s[i] ?? c.close;
      const prev4hEma50 = ema800s[Math.max(0, i - 16)] ?? cur4hEma50;

      // คำนวณกรอบราคา 4H (240 แท่ง = 60 ชม.), 36h (144 แท่ง), และ 24h (96 แท่ง) แบบใช้เฉพาะแท่งที่ปิดแล้ว (i - 1) เพื่อป้องกัน Lookahead
      const closedEndIdx = Math.max(0, i - 1);
      let htf4hHigh = candles[closedEndIdx].high;
      let htf4hLow = candles[closedEndIdx].low;
      let htf36hLow = candles[closedEndIdx].low;
      let htf24hLow = candles[closedEndIdx].low;
      const start240 = Math.max(0, closedEndIdx - 240);
      const start144 = Math.max(0, closedEndIdx - 144);
      const start96 = Math.max(0, closedEndIdx - 96);
      for (let k = start240; k <= closedEndIdx; k++) {
        const ck = candles[k];
        if (ck.high > htf4hHigh) htf4hHigh = ck.high;
        if (ck.low < htf4hLow) htf4hLow = ck.low;
        if (k >= start144 && ck.low < htf36hLow) htf36hLow = ck.low;
        if (k >= start96 && ck.low < htf24hLow) htf24hLow = ck.low;
      }
      const htf4hSpan = Math.max(0, htf4hHigh - htf4hLow);
      const htf4hPosRatio = htf4hSpan > 0 ? (c.close - htf4hLow) / htf4hSpan : 0.5;

      // วิเคราะห์ทิศทาง 4H และ 1H
      const is4hBull =
        c.close > cur4hEma50 &&
        cur4hEma20 >= cur4hEma50 * 0.999 &&
        cur4hEma50 >= prev4hEma50 * 0.9998;
      const is4hBear =
        c.close < cur4hEma50 &&
        cur4hEma20 < cur4hEma50 * 0.999 &&
        cur4hEma20 < prev4hEma20;
      const is1hBull =
        c.close > cur1hEma50 &&
        cur1hEma20 >= cur1hEma50 * 0.999;
      const is1hBearFlow =
        c.close < cur1hEma20 &&
        cur1hEma20 < cur1hEma50 &&
        cur1hEma20 < prev1hEma20;
      const is1hStabilized =
        c.close >= (candles[Math.max(0, i - 3)]?.open ?? c.open) ||
        c.close >= cur1hEma20 * 0.998 ||
        cur1hEma20 >= prev1hEma20;

      const isMacroUptrend =
        (structure.regime === "UPTREND" || is4hBull) &&
        c.close > cur1hEma50 &&
        curEma50 >= cur1hEma50 * 0.999 &&
        cur1hEma50 >= prev1hEma50;
      const isUptrend = isMacroUptrend;

      let floor: number;
      let ceiling: number;
      let center: number;
      let channelSpan: number;
      let buyLevels: number[];
      let sellTargets: number[];

      const isHoldingPosition = heldLots.length > 0;

      if (!isHoldingPosition) {
        unlockedCapitalZones = 1;
        isZoneReversalConfirmed = true;
        zoneDumpLowPrice = 0;
        stableFloorCandleCount = 0;
        prevCandidateFloor = undefined;
        lastZoneUnlockFloor = undefined;
        lockedChannel = null;

        const ltfFloor = structure.bottomBound;
        const ltfCeiling = structure.upperBound;
        const ltfSpan = ltfCeiling - ltfFloor;
        if (ltfSpan <= 0) continue;

        // 🌟 Scoped Asymmetric MTF Channel (Master Plan v14.0):
        // - เมื่อตลาดไม่ได้อยู่ในขาลงใหญ่ 4H (!is4hBear): ใช้กรอบ 15m/1H มาตรฐาน 100% (รักษาไม้ทำเงินของ ETH, AVAX, DOGE, PEPE ครบถ้วน)
        // - เมื่อตลาดอยู่ในขาลงใหญ่ 4H (is4hBear): ถอยแนวรับ Floor ลงไปยึดค่าเฉลี่ยฐาน 24 ชั่วโมง (htf24hLow) เพื่อป้องกันการรับตื้นกลางอากาศ
        if (is4hBear && ltfFloor > htf24hLow) {
          floor = (ltfFloor + htf24hLow) * 0.5;
          channelSpan = Math.min(ltfSpan, floor * 0.045);
          ceiling = floor + channelSpan;
          center = floor + channelSpan * 0.5;
        } else {
          floor = ltfFloor;
          ceiling = ltfCeiling;
          center = structure.centerPrice;
          channelSpan = ltfSpan;
        }

        buyLevels = curBuys.map((pct) => floor + channelSpan * (pct / 100));
        sellTargets = curSells.map((pct) => floor + channelSpan * (pct / 100));
        activeChannel = { floor, ceiling, center, channelSpan, buyLevels: [...buyLevels], sellTargets: [...sellTargets] };
      } else if (lockChannelInPosition && lockedChannel && (totalZones <= 1 || structure.bottomBound >= (activeChannel?.floor ?? 0) * 0.999)) {
        // Position Lock: Freeze channel until all lots exit
        floor = lockedChannel.floor;
        ceiling = lockedChannel.ceiling;
        center = lockedChannel.center;
        channelSpan = lockedChannel.channelSpan;
        buyLevels = lockedChannel.buyLevels;
        sellTargets = lockedChannel.sellTargets;
      } else {
        const candidateFloor = structure.bottomBound;
        const currentActiveFloor = activeChannel?.floor ?? candidateFloor;

        // Channel Shift Gate when candidate floor is lower than active channel
        if (candidateFloor < currentActiveFloor * 0.999 && activeChannel) {
          // Pillar 1: Stability count
          if (prevCandidateFloor !== undefined && Math.abs(candidateFloor - prevCandidateFloor) / prevCandidateFloor <= 0.005) {
            stableFloorCandleCount++;
          } else {
            stableFloorCandleCount = 1;
          }
          prevCandidateFloor = candidateFloor;

          // Pillar 2: Not in dump
          const isPillar2Ok = !structure.isDowntrendDropActive && (c.close >= c.open || structure.gridZone?.canEstablishChannel !== false);

          // Pillar 3: Min drop % from active floor or lowest held lot
          const dropFromActiveFloorPct = currentActiveFloor > 0 ? ((currentActiveFloor - candidateFloor) / currentActiveFloor) * 100 : 0;
          const lowestHeldLotPrice = heldLots.length > 0 ? Math.min(...heldLots.map((l) => l.buyPrice)) : 0;
          const dropFromLowestLotPct = lowestHeldLotPrice > 0 ? ((lowestHeldLotPrice - candidateFloor) / lowestHeldLotPrice) * 100 : 0;
          const isPillar3Ok =
            totalZones <= 1 ||
            dropFromActiveFloorPct >= (zoneMinDropPct - 0.1) ||
            (lowestHeldLotPrice > 0 && lowestHeldLotPrice <= candidateFloor) ||
            dropFromLowestLotPct >= (zoneMinDropPct - 0.1);

          const isStabilizedGatePassed = isPillar2Ok && isPillar3Ok && (stableFloorCandleCount >= zoneStabilizeCandles);

          if (isStabilizedGatePassed) {
            if (unlockedCapitalZones < totalZones) {
              unlockedCapitalZones++;
              if (zoneRequireReversal) {
                isZoneReversalConfirmed = false;
                zoneDumpLowPrice = Math.min(c.low, candidateFloor);
                zoneUnlockCandleIdx = i;
              }
            }
            floor = candidateFloor;
            ceiling = structure.upperBound;
            center = structure.centerPrice;
            channelSpan = ceiling - floor;
            buyLevels = curBuys.map((pct) => floor + channelSpan * (pct / 100));
            sellTargets = curSells.map((pct) => floor + channelSpan * (pct / 100));
            activeChannel = { floor, ceiling, center, channelSpan, buyLevels: [...buyLevels], sellTargets: [...sellTargets] };
            lastZoneUnlockFloor = floor;
            stableFloorCandleCount = 0;
          } else {
            // Channel frozen waiting for stabilization
            floor = activeChannel.floor;
            ceiling = activeChannel.ceiling;
            center = activeChannel.center;
            channelSpan = activeChannel.channelSpan;
            buyLevels = activeChannel.buyLevels;
            sellTargets = activeChannel.sellTargets;
          }
        } else {
          floor = candidateFloor;
          ceiling = structure.upperBound;
          center = structure.centerPrice;
          channelSpan = ceiling - floor;
          if (channelSpan <= 0) continue;
          buyLevels = curBuys.map((pct) => floor + channelSpan * (pct / 100));
          sellTargets = curSells.map((pct) => floor + channelSpan * (pct / 100));
          activeChannel = { floor, ceiling, center, channelSpan, buyLevels: [...buyLevels], sellTargets: [...sellTargets] };
          stableFloorCandleCount = 0;
        }

        // Dynamic Trailing: when channel moves while holding lots, update sell targets ensuring min profit hurdle!
        if (isHoldingPosition) {
          const totalHeldQty = heldLots.reduce((sum, l) => sum + l.qty, 0);
          const totalInvestQuote = heldLots.reduce((sum, l) => sum + (l.qty * l.buyPrice), 0);
          const avgEntry = totalHeldQty > 0 ? (totalInvestQuote / totalHeldQty) : 0;

          const hasL2Held = heldLots.some((l) => l.index === 1);
          for (const lot of heldLots) {
            if (zoneExitMode === "ORIGINAL_TARGETS" && lot.targetPrice > 0) {
              continue;
            }
            const lotSafeBase = Math.max(avgEntry, lot.buyPrice);
            const lotMinProfitTarget = lotSafeBase * (1 + effectiveMinProfitPct / 100);
            let dynamicTarget = sellTargets[0] ?? (lotSafeBase * 1.015);
            if ((hasL2Held || (sellTargets.length > 1 && lot.targetPrice >= (sellTargets[1] ?? 0) * 0.999)) && lot.index === 0 && sellTargets.length > 1) {
              dynamicTarget = sellTargets[1]!;
            }
            lot.targetPrice = Math.max(dynamicTarget, lotMinProfitTarget);
          }
        }
      }

      // Span-Relative 2-Tier Hybrid Cut Loss:
      // - Tier 1 (Confirmed Close): 20% of channelSpan below floor
      // - Tier 2 (Bounded Hard Stop): 32% of channelSpan below floor (caps maximum loss on long breakdown candles)
      const closeCutLossPrice = channelSpan > 0
        ? floor - channelSpan * 0.20
        : floor * (1 - (opts.floorBufferPct ?? 0.6) / 100);
      const emergencyWickCutPrice = channelSpan > 0
        ? floor - channelSpan * 0.32
        : floor * (1 - ((opts.floorBufferPct ?? 0.6) * 1.6) / 100);
      const cutLossPrice = closeCutLossPrice;

      // ขอบเขต Cut Loss พิเศษสำหรับไม้ในเทรนด์ขาขึ้น (4H/Macro Bull ถ่างระยะกันสะบัดเป็น -38% / -48% ของกรอบ)
      const uptrendCloseCutPrice = channelSpan > 0
        ? floor - channelSpan * 0.38
        : closeCutLossPrice * 0.995;
      const uptrendWickCutPrice = channelSpan > 0
        ? floor - channelSpan * 0.48
        : emergencyWickCutPrice * 0.995;

      const baseCanTriggerCutLoss =
        gridCutLossMode !== "none" &&
        (gridCutLossMode === "entry_floor" || unlockedCapitalZones >= totalZones);

      const remainingLots: typeof heldLots = [];
      for (const lot of heldLots) {
        const holdingBars = lot.entryIdx !== undefined ? i - lot.entryIdx : 0;
        const isLotUptrendProtected = Boolean(
          lot.enteredInUptrend &&
          c.close >= cur1hEma50 * 0.996 &&
          !is4hBear
        );

        // ปรับเวลาถือครอง (Time-Decay Escape) ตามกระแสน้ำของ 4H:
        // - 4H Bear: รีบออกที่จุดคุ้มทุนภายใน 12 แท่ง (3 ชม.) ก่อนที่คลื่น 4H จะทุบซ้ำ
        // - 4H Bull: ให้เวลาถือรันเทรนด์ 22 แท่ง (5.5 ชม.)
        // - 4H Range / 1H Bull: 18 แท่ง (4.5 ชม.)
        const isDippedBelowNormalFloor = isLotUptrendProtected && c.low <= closeCutLossPrice;
        const escapeBarThreshold = isLotUptrendProtected ? 22 : (is4hBear && !is1hBull ? 12 : 18);

        if ((holdingBars >= escapeBarThreshold || isDippedBelowNormalFloor) && !lot.isTimeDecayEscape) {
          const escapeTarget = lot.buyPrice * (1 + effectiveMinProfitPct / 100);
          if (escapeTarget < lot.targetPrice) {
            lot.targetPrice = escapeTarget;
            lot.isTimeDecayEscape = true;
          }
        }

        const effectiveCloseCut = isLotUptrendProtected
          ? Math.max(uptrendCloseCutPrice, lot.buyPrice * 0.982)
          : closeCutLossPrice;
        const effectiveWickCut = isLotUptrendProtected
          ? Math.max(uptrendWickCutPrice, lot.buyPrice * 0.978)
          : emergencyWickCutPrice;

        const isEmergencyWickHit = baseCanTriggerCutLoss && c.low <= effectiveWickCut;
        const isConfirmedCloseCutHit = baseCanTriggerCutLoss && c.close <= effectiveCloseCut;

        // 1) Cut Loss Hit (Taker Execution with Taker Fee + Taker Slippage, capped at effectiveWickCut)
        if (isEmergencyWickHit || isConfirmedCloseCutHit) {
          const rawCutExit = isEmergencyWickHit
            ? effectiveWickCut
            : Math.max(c.close, effectiveWickCut);
          const exitPrice = rawCutExit * (1 - takerSlippagePct / 100);
          const proceeds = lot.qty * exitPrice * (1 - takerFeePct / 100);
          const invest = lot.qty * lot.buyPrice;
          const pnlQuote = proceeds - invest;
          const pnlPct = invest > 0 ? (pnlQuote / invest) * 100 : 0;
          cash += proceeds;
          const exitCost = lot.qty * exitPrice * takerCostPerFill;
          totalFeesQuote += lot.costQuote + exitCost;

          grossLoss += Math.abs(pnlQuote);
          losses++;

          trades.push({
            id: lot.id,
            subsystem: "GRID",
            side: "LONG",
            entryTime: lot.entryTime,
            entryPrice: lot.buyPrice,
            stopLossPrice: rawCutExit,
            fanSpreadAtEntry: 0,
            exitTime: c.time,
            exitPrice,
            exitType: "GRID_CUT",
            pnlQuote,
            pnlPct,
            holdingBars,
            costQuote: lot.costQuote + exitCost,
            channelFloor: lot.floorAtEntry,
            channelCeil: lot.ceilingAtEntry,
            channelMid: lot.centerAtEntry,
            channelSpanPct: lot.floorAtEntry && lot.ceilingAtEntry ? Number((((lot.ceilingAtEntry - lot.floorAtEntry) / lot.floorAtEntry) * 100).toFixed(2)) : undefined,
            zoneIndex: lot.zoneIndex,
          });

          markers.push({
            time: c.time,
            position: "belowBar",
            color: "#ef4444",
            shape: "arrowDown",
            text: `🔴 GRID CUT #${lot.id} (L${lot.index + 1}${lot.zoneIndex ? ` Z${lot.zoneIndex}` : ''}) @ $${exitPrice.toFixed(4)} (${pnlPct.toFixed(2)}%)`,
          });
          continue;
        }

        // 2) Trailing Stop Hit (Only if already armed on a previous candle: lot.beLocked || lot.profitLocked)
        if (enableGridTrailingStop && (lot.beLocked || lot.profitLocked) && lot.stopLossPrice && lot.stopLossPrice > cutLossPrice && c.low <= lot.stopLossPrice) {
          const rawExit = Math.min(lot.stopLossPrice, c.high);
          const exitPrice = Math.max(c.low, rawExit * (1 - takerSlippagePct / 100));
          const proceeds = lot.qty * exitPrice * (1 - takerFeePct / 100);
          const invest = lot.qty * lot.buyPrice;
          const pnlQuote = proceeds - invest;
          const pnlPct = invest > 0 ? (pnlQuote / invest) * 100 : 0;
          cash += proceeds;
          const exitCost = lot.qty * exitPrice * takerCostPerFill;
          totalFeesQuote += lot.costQuote + exitCost;

          if (pnlQuote >= 0) {
            grossProfit += pnlQuote;
            wins++;
          } else {
            grossLoss += Math.abs(pnlQuote);
            losses++;
          }

          const trailLabel = lot.profitLocked ? "PROFIT_LOCK" : "BE_LOCK";
          trades.push({
            id: lot.id,
            subsystem: "GRID",
            side: "LONG",
            entryTime: lot.entryTime,
            entryPrice: lot.buyPrice,
            stopLossPrice: lot.stopLossPrice,
            fanSpreadAtEntry: 0,
            exitTime: c.time,
            exitPrice,
            exitType: "GRID_TRAIL_TP",
            pnlQuote,
            pnlPct,
            holdingBars,
            costQuote: lot.costQuote + exitCost,
            channelFloor: lot.floorAtEntry,
            channelCeil: lot.ceilingAtEntry,
            channelMid: lot.centerAtEntry,
            channelSpanPct: lot.floorAtEntry && lot.ceilingAtEntry ? Number((((lot.ceilingAtEntry - lot.floorAtEntry) / lot.floorAtEntry) * 100).toFixed(2)) : undefined,
            zoneIndex: lot.zoneIndex,
          });

          markers.push({
            time: c.time,
            position: "aboveBar",
            color: "#3b82f6",
            shape: "circle",
            text: `🎯 GRID TRAIL #${lot.id} (${trailLabel}) @ $${exitPrice.toFixed(4)} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%)`,
          });
          continue;
        }

        // 3) Take Profit Hit (Maker Resting Order with 0.05% Queue Penetration)
        if (c.high >= lot.targetPrice * 1.0005) {
          const exitPrice = lot.targetPrice;
          const proceeds = lot.qty * exitPrice * (1 - makerCostPerFill);
          const invest = lot.qty * lot.buyPrice;
          const pnlQuote = proceeds - invest;
          const pnlPct = invest > 0 ? (pnlQuote / invest) * 100 : 0;
          cash += proceeds;
          const exitCost = lot.qty * exitPrice * makerCostPerFill;
          totalFeesQuote += lot.costQuote + exitCost;

          if (pnlQuote >= 0) {
            grossProfit += pnlQuote;
            wins++;
          } else {
            grossLoss += Math.abs(pnlQuote);
            losses++;
          }

          // Tranche Hand-off: เมื่อไม้แรกขาย TP สำเร็จ ยก Stop ของไม้ Runner ที่เหลือขึ้นมาล็อกกำไรที่ 26% ของกรอบ (มีพื้นที่ให้ย่อกลางกรอบได้)
          for (const rem of heldLots) {
            if (rem.id !== lot.id) {
              rem.beLocked = true;
              const handoffStop = Math.max(
                rem.buyPrice * (1 + makerCostPerFill * 2 + 0.0020),
                floor + channelSpan * 0.26
              );
              rem.stopLossPrice = Math.max(rem.stopLossPrice ?? cutLossPrice, handoffStop);
            }
          }

          const exitType: BacktestTrade["exitType"] = lot.isTimeDecayEscape ? "GRID_BE_ESCAPE" : "GRID_TP";

          trades.push({
            id: lot.id,
            subsystem: "GRID",
            side: "LONG",
            entryTime: lot.entryTime,
            entryPrice: lot.buyPrice,
            stopLossPrice: cutLossPrice,
            fanSpreadAtEntry: 0,
            exitTime: c.time,
            exitPrice,
            exitType,
            pnlQuote,
            pnlPct,
            holdingBars,
            costQuote: lot.costQuote + exitCost,
            channelFloor: lot.floorAtEntry,
            channelCeil: lot.ceilingAtEntry,
            channelMid: lot.centerAtEntry,
            channelSpanPct: lot.floorAtEntry && lot.ceilingAtEntry ? Number((((lot.ceilingAtEntry - lot.floorAtEntry) / lot.floorAtEntry) * 100).toFixed(2)) : undefined,
            zoneIndex: lot.zoneIndex,
          });

          markers.push({
            time: c.time,
            position: "aboveBar",
            color: lot.isTimeDecayEscape ? "#06b6d4" : "#a855f7",
            shape: "arrowDown",
            text: lot.isTimeDecayEscape
              ? `⏱️ GRID BE ESCAPE #${lot.id} (L${lot.index + 1}${lot.zoneIndex ? ` Z${lot.zoneIndex}` : ''}) @ $${exitPrice.toFixed(4)} (+${pnlPct.toFixed(2)}%)`
              : `🟣 GRID SELL #${lot.id} (L${lot.index + 1}${lot.zoneIndex ? ` Z${lot.zoneIndex}` : ''}) @ $${exitPrice.toFixed(4)} (+${pnlPct.toFixed(2)}%)`,
          });
          continue;
        }

        // 4) Update peakPrice & Ratchet Trailing Stop for subsequent candles
        // Must be driven by actual market price higher than entry price (cannot ratchet on a depressed market)
        lot.peakPrice = Math.max(lot.peakPrice ?? lot.buyPrice, c.high);
        const refEntryFloor = lot.floorAtEntry ?? floor;
        const refEntrySpan = (lot.ceilingAtEntry && lot.floorAtEntry) ? (lot.ceilingAtEntry - lot.floorAtEntry) : channelSpan;
        if (enableGridTrailingStop && refEntrySpan > 0 && lot.peakPrice > lot.buyPrice) {
          const roundtripTakerCost = makerCostPerFill + takerCostPerFill;
          // ขั้นที่ 1 (Early Breakeven Shield): ราคาแตะ 44% ของกรอบ (หรือบวก >= +0.65% จากทุน) และราคาปิดยืนเหนือจุดล็อกทุน
          const lockEarly = lot.buyPrice * (1 + roundtripTakerCost + 0.0020);
          if (
            (lot.peakPrice >= refEntryFloor + refEntrySpan * 0.44 || lot.peakPrice >= lot.buyPrice * 1.0065) &&
            c.close > lockEarly
          ) {
            lot.beLocked = true;
            lot.stopLossPrice = Math.max(lot.stopLossPrice ?? cutLossPrice, lockEarly);
          }
          // ขั้นที่ 2 (Mid-Box Profit Lock): ราคาแตะ 52% ของกรอบ -> ล็อกกำไรที่ 32% ของกรอบ
          const lock32 = Math.max(
            lot.buyPrice * (1 + roundtripTakerCost + 0.0035),
            refEntryFloor + refEntrySpan * 0.32
          );
          if (lot.peakPrice >= refEntryFloor + refEntrySpan * 0.52 && c.close > lock32) {
            lot.beLocked = true;
            lot.stopLossPrice = Math.max(lot.stopLossPrice ?? cutLossPrice, lock32);
          }
          // ขั้นที่ 3 (Upper-Box Runner Lock): ราคาแตะ 65% ของกรอบ -> ล็อกกำไรที่ 50% ของกรอบ
          const lock50 = Math.max(
            lot.buyPrice * (1 + roundtripTakerCost + 0.0055),
            refEntryFloor + refEntrySpan * 0.50
          );
          if (lot.peakPrice >= refEntryFloor + refEntrySpan * 0.65 && c.close > lock50) {
            lot.profitLocked = true;
            lot.stopLossPrice = Math.max(lot.stopLossPrice ?? cutLossPrice, lock50);
          }
        }

        remainingLots.push(lot);
      }
      heldLots = remainingLots;
      const justBecameFlat = wasHolding && heldLots.length === 0;
      wasHolding = heldLots.length > 0;

      if (heldLots.length === 0) {
        lockedChannel = null;
        unlockedCapitalZones = 1;
        stableFloorCandleCount = 0;
      }

      if (justBecameFlat) {
        lastFlatTime = c.time;
      }

      if (isTradingActive && opts.onFlatCheckStop && heldLots.length === 0) {
        if (justBecameFlat) {
          const shouldStop = opts.onFlatCheckStop({
            barIndex: i,
            time: c.time,
            cash,
            trigger: "POST_ROUND_EXIT",
          });
          if (shouldStop) break;
        } else if (c.time - lastFlatTime >= 7200) { // 2 hours idle cash
          const shouldStop = opts.onFlatCheckStop({
            barIndex: i,
            time: c.time,
            cash,
            trigger: "IDLE_CASH_TIMEOUT",
          });
          if (shouldStop) break;
          lastFlatTime = c.time; // Reset so next check is after another interval, NOT on every 5m bar!
        }
      }

      // 1.5 Evaluate Signal Invalidation Check while holding lots (Checked every bar for disaster prevention)
      if (isTradingActive && opts.onSignalInvalidationCheck && heldLots.length > 0) {
        let change24hPct = 0;
        let posRatio24h = 0.5;
        if (i >= 288) {
          const c24 = candles[i - 288];
          change24hPct = ((c.close - c24.open) / c24.open) * 100;
          const slice24 = candles.slice(i - 288, i + 1);
          let h24 = -Infinity;
          let l24 = Infinity;
          for (const sc of slice24) {
            if (sc.high > h24) h24 = sc.high;
            if (sc.low < l24) l24 = sc.low;
          }
          if (h24 > l24) {
            posRatio24h = (c.close - l24) / (h24 - l24);
          }
        }

        const totalHeldQty = heldLots.reduce((sum, l) => sum + l.qty, 0);
        const totalInvestQuote = heldLots.reduce((sum, l) => sum + (l.qty * l.buyPrice), 0);
        const currentPosVal = totalHeldQty * c.close * (1 - costPerFill);
        const unrealizedPnlPct = totalInvestQuote > 0 ? ((currentPosVal - totalInvestQuote) / totalInvestQuote) * 100 : 0;

        // 🛡️ Structural Floor Breakdown Check:
        // Dynamic Grid accumulates on dips towards the floor. Dips are normal, NOT emergencies.
        // We invoke onSignalInvalidationCheck if price structurally breaks below the channel floor (1.8% buffer),
        // or suffers catastrophic collapse below 24h rock bottom, or breaches max loss threshold (-3.8%).
        const isFloorBreak = c.close < floor * 0.982;
        const isCatastrophicDump = posRatio24h < 0.05 && unrealizedPnlPct < -5.0;
        const isLossBreach = unrealizedPnlPct <= -3.8;
        const isDanger = isFloorBreak || isCatastrophicDump || isLossBreach;
        if (isDanger) {
          const shouldExitDisqualified = opts.onSignalInvalidationCheck({
            barIndex: i,
            time: c.time,
            closePrice: c.close,
            floorPrice: floor,
            change24hPct,
            posRatio24h,
            heldLotsCount: heldLots.length,
            unrealizedPnlPct,
          });

          if (shouldExitDisqualified) {
            for (const lot of heldLots) {
              const exitPrice = c.close;
              const proceeds = lot.qty * exitPrice * (1 - costPerFill);
              const invest = lot.qty * lot.buyPrice;
              const pnlQuote = proceeds - invest;
              const pnlPct = invest > 0 ? (pnlQuote / invest) * 100 : 0;
              cash += proceeds;
              const exitCost = lot.qty * exitPrice * costPerFill;
              totalFeesQuote += lot.costQuote + exitCost;

              if (pnlQuote >= 0) {
                grossProfit += pnlQuote;
                wins++;
              } else {
                grossLoss += Math.abs(pnlQuote);
                losses++;
              }

              trades.push({
                id: lot.id,
                subsystem: "GRID",
                side: "LONG",
                entryTime: lot.entryTime,
                entryPrice: lot.buyPrice,
                stopLossPrice: floor,
                fanSpreadAtEntry: 0,
                exitTime: c.time,
                exitPrice,
                exitType: "GRID_CUT",
                pnlQuote,
                pnlPct,
                holdingBars: i - (candles.findIndex((x) => x.time === lot.entryTime) || i),
                costQuote: lot.costQuote + exitCost,
                channelFloor: lot.floorAtEntry,
                channelCeil: lot.ceilingAtEntry,
                channelMid: lot.centerAtEntry,
                zoneIndex: lot.zoneIndex,
              });
            }

            markers.push({
              time: c.time,
              position: "aboveBar",
              color: "#f43f5e",
              shape: "arrowDown",
              text: `🚨 SIGNAL DISQUALIFIED EXIT (${heldLots.length} lots @ $${c.close.toFixed(4)})`,
            });

            heldLots = [];
            break;
          }
        }
      }

      // 2. Evaluate Grid Buys (Tranche Size = 25% of current zone quota)
      if (unlockedCapitalZones > 1) {
        if (c.low < zoneDumpLowPrice * 0.9995) {
          if (isZoneReversalConfirmed) {
            isZoneReversalConfirmed = false;
            zoneUnlockCandleIdx = i;
          }
          zoneDumpLowPrice = c.low;
        }
      }

      if (unlockedCapitalZones > 1 && !isZoneReversalConfirmed) {
        const isBreakout = Boolean(structure.downtrendBreakoutConfirmed);
        const lastLl = structure.waveCycle?.lastLl;
        const lastHl = structure.waveCycle?.lastHl;
        const isHlAfterLl = Boolean(
          lastHl &&
          (lastHl.index ?? 0) >= zoneUnlockCandleIdx &&
          (!lastLl || (lastHl.index ?? 0) > (lastLl.index ?? 0)) &&
          lastHl.price > zoneDumpLowPrice * 1.002
        );
        const choChPrice = structure.gridZone?.choChLevel ?? structure.waveCycle?.lastLh?.price;
        const isChoChBreakout = Boolean(
          choChPrice &&
          choChPrice > zoneDumpLowPrice &&
          c.close > choChPrice * 1.0005
        );
        if (isBreakout || isHlAfterLl || isChoChBreakout) {
          isZoneReversalConfirmed = true;
        }
      }

      const effectiveMaxInventory = zoneBudgetQuote * unlockedCapitalZones;
      const currentInventory = heldLots.reduce((sum, l) => sum + (l.qty * l.buyPrice), 0);
      const trancheQuote = zoneBudgetQuote / Math.max(1, curBuys.length);

      // ตรวจสอบว่าแนวรับ Floor ปัจจุบัน (ทั้งกรณี LTF และ HTF 24h/36h Floor) เป็นฐานแนวนอนที่ตั้งตัวแล้ว (ไม่ได้เพิ่งทุบทำจุดต่ำสุดใหม่ใน 4 แท่งล่าสุด)
      const recent4Lows = candles.slice(Math.max(0, i - 3), i + 1).map((x) => x.low);
      const minRecent4Low = recent4Lows.length > 0 ? Math.min(...recent4Lows) : c.low;
      const isEstablishedHorizontalFloor = floor > 0 && minRecent4Low > floor * 1.0005;

      // 🌐 Scoped 4H Bear Gate (แทรกแซงเฉพาะเมื่อกราฟ 4H เป็นขาลงชัดเจน เพื่อไม่ให้ไปตัดไม้ทำกำไรของ ETH/AVAX ในช่วง Sideway/Bull):
      let isHtfBlocked = false;
      if (is4hBear) {
        if (htf4hPosRatio > 0.52 || (is1hBearFlow && !is1hStabilized)) {
          isHtfBlocked = true;
        }
      }

      let isRegimeBlocked = !structure.isSwingConfirmed;
      if (heldLots.length > 0 && lockedChannel !== null) {
        // เมื่อเปิดไม้ L1 และล็อกกรอบแล้ว อนุญาตให้รับไม้ L2 (65%) ในกรอบเดิมได้เสมอตราบใดที่ยังไม่หลุด Cut Loss
        isRegimeBlocked = false;
      } else if (regimeFilterMode === "UPTREND_AND_SIDEWAY") {
        const isRange = structure.regime === "RANGE";
        const isBullishRegime = structure.regime === "UPTREND" || isUptrend;
        const isDonchianMode = (opts.channelMode ?? "DONCHIAN_ATR") === "DONCHIAN_ATR";
        if (isDonchianMode) {
          const isBearSpike = (structure.regimeMetrics?.minusDI ?? 0) - (structure.regimeMetrics?.plusDI ?? 0) > 12;
          if (
            isHtfBlocked ||
            (!isRange && !isBullishRegime) ||
            !isEstablishedHorizontalFloor ||
            consecutiveReds >= 4 ||
            isBearSpike
          ) {
            isRegimeBlocked = true;
          }
        } else {
          const canEstablish = structure.gridZone?.canEstablishChannel !== false;
          const notDropping = !structure.isDowntrendDropActive;
          if (isHtfBlocked || (!isRange && !isBullishRegime) || !canEstablish || !notDropping) {
            isRegimeBlocked = true;
          }
        }
      } else if (regimeFilterMode === "SIDEWAY_ONLY") {
        const isRange = structure.regime === "RANGE";
        const isDonchianMode = (opts.channelMode ?? "DONCHIAN_ATR") === "DONCHIAN_ATR";
        if (isDonchianMode) {
          const isBearSpike = (structure.regimeMetrics?.minusDI ?? 0) - (structure.regimeMetrics?.plusDI ?? 0) > 12;
          if (!isRange || !isEstablishedHorizontalFloor || consecutiveReds >= 4 || isBearSpike) {
            isRegimeBlocked = true;
          }
        } else {
          const canEstablish = structure.gridZone?.canEstablishChannel !== false;
          const notDropping = !structure.isDowntrendDropActive;
          if (!isRange || !canEstablish || !notDropping) {
            isRegimeBlocked = true;
          }
        }
      } else if (regimeFilterMode === "NO_DOWNTREND") {
        const isDowntrend = structure.regime === "DOWNTREND" || Boolean(structure.isDowntrendDropActive);
        const canEstablish = structure.gridZone?.canEstablishChannel !== false;
        if (isDowntrend || !canEstablish) {
          isRegimeBlocked = true;
        }
      } else if (opts.enableBaseConfirmationFilter === true) {
        if (structure.gridZone?.canEstablishChannel === false || Boolean(structure.isDowntrendDropActive)) {
          isRegimeBlocked = true;
        }
      }
      const isHlWaiting = isRegimeBlocked;
      const isZoneWaiting = zoneRequireReversal && unlockedCapitalZones > 1 && !isZoneReversalConfirmed;

      // Dip Hunter Entry Absorption Guard (Active when explicitly requested)
      let passesDipHunterGuard = true;
      if (opts.enableDipHunterEntryGuard === true) {
        const isWaterfall = consecutiveReds >= 4;
        const prevCandle = i > 0 ? candles[i - 1] : c;
        const prevRange = prevCandle.high - prevCandle.low;
        const prevLowerWick = Math.min(prevCandle.open, prevCandle.close) - prevCandle.low;
        const prevLowerWickPct = prevRange > 0 ? (prevLowerWick / prevRange) * 100 : 0;
        const isGreenCandle = prevCandle.close >= prevCandle.open;
        const prevPrevCandle = i > 1 ? candles[i - 2] : prevCandle;
        const isNoFallingKnife = prevCandle.low >= prevPrevCandle.low;

        let isBad24hDrop = false;
        if (i >= 288) {
          const c24 = candles[i - 288];
          const change24hPct = ((c.close - c24.open) / c24.open) * 100;
          if (change24hPct < -5.5) isBad24hDrop = true;
        }

        const hasAbsorption = isGreenCandle || prevLowerWickPct >= 15 || (isNoFallingKnife && prevLowerWickPct >= 8);
        if (isWaterfall || isBad24hDrop || !hasAbsorption) {
          passesDipHunterGuard = false;
        }
      }

      const maxLotsForUnlockedZones = unlockedCapitalZones * Math.max(1, curBuys.length);
      if (isTradingActive && !isHlWaiting && !isZoneWaiting && passesDipHunterGuard) {
        for (let lvlIdx = 0; lvlIdx < buyLevels.length; lvlIdx++) {
          if (heldLots.length >= maxLotsForUnlockedZones) break;
          const levelWeight = curBuyWeights[lvlIdx] ?? (100 / Math.max(1, buyLevels.length));
          const weightedTrancheQuote = zoneBudgetQuote * (levelWeight / totalBuyWeight);
          const currentInv = heldLots.reduce((sum, l) => sum + (l.qty * l.buyPrice), 0);
          if (currentInv + weightedTrancheQuote > effectiveMaxInventory * 1.001 || cash < weightedTrancheQuote * 0.999) continue;

          const bl = buyLevels[lvlIdx];
          const alreadyFilledInCurrentZone = heldLots.some((l) => (l.zoneIndex ?? 1) === unlockedCapitalZones && l.index === lvlIdx);
          // Queue Penetration: Price must trade through Limit Buy by 0.05%
          // And candle high must reach or exceed the limit price (must physically overlap bar range)
          // Also verify bar does not trigger cut loss on the entry candle
          if (!alreadyFilledInCurrentZone && c.low <= bl * 0.9995 && c.high >= bl && (!baseCanTriggerCutLoss || (c.close > closeCutLossPrice && c.low > emergencyWickCutPrice))) {
            tradeCounter++;
            const buyPrice = bl;
            const invest = Math.min(cash, weightedTrancheQuote);
            const fillQty = (invest / buyPrice) * (1 - makerCostPerFill);
            cash -= invest;

            // Target Pairing Strategy:
            // L2 (deep lot, 65% weight at 10% span) takes profit at sellTargets[0] (60% span).
            // When L2 is filled, promote L1 (runner lot, 35% weight at 18% span) to sellTargets[1] (80% span).
            const minProfitHurdle = buyPrice * (1 + effectiveMinProfitPct / 100);
            const primaryTarget = sellTargets[0] ?? (buyPrice * 1.015);
            const targetPrice = Math.max(primaryTarget, minProfitHurdle);

            if (lvlIdx === 1 && sellTargets.length > 1) {
              const promotedTarget = isUptrend
                ? Math.max(sellTargets[1]!, floor + channelSpan * 0.88)
                : sellTargets[1]!;
              for (const existingLot of heldLots) {
                if (existingLot.index === 0 && (existingLot.zoneIndex ?? 1) === unlockedCapitalZones) {
                  existingLot.targetPrice = Math.max(promotedTarget, existingLot.buyPrice * (1 + effectiveMinProfitPct / 100));
                }
              }
            }

            heldLots.push({
              id: tradeCounter,
              index: lvlIdx,
              zoneIndex: unlockedCapitalZones,
              qty: fillQty,
              buyPrice,
              entryTime: c.time,
              entryIdx: i,
              targetPrice,
              costQuote: invest * makerCostPerFill,
              floorAtEntry: floor,
              ceilingAtEntry: ceiling,
              centerAtEntry: center,
              peakPrice: buyPrice,
              stopLossPrice: cutLossPrice,
              enteredInUptrend: isUptrend,
            });

            if (!lockedChannel) {
              lockedChannel = {
                floor,
                ceiling,
                center,
                channelSpan,
                buyLevels: [...buyLevels],
                sellTargets: [...sellTargets],
              };
            }

            markers.push({
              time: c.time,
              position: "belowBar",
              color: "#10b981",
              shape: "arrowUp",
              text: `🟢 GRID BUY #${tradeCounter} (L${lvlIdx + 1} Z${unlockedCapitalZones}) @ $${buyPrice.toFixed(4)}`,
            });
          }
        }
      }

      // Equity curve & drawdown (Mark-to-Market including exit fee)
      const currentInvVal = heldLots.reduce((sum, l) => sum + (l.qty * c.close * (1 - costPerFill)), 0);
      const curEquity = cash + currentInvVal;
      if (curEquity > peakEquity) peakEquity = curEquity;
      const dd = peakEquity > 0 ? ((peakEquity - curEquity) / peakEquity) * 100 : 0;
      if (dd > maxDrawdownPct) maxDrawdownPct = dd;

      if (isTradingActive && (i % 6 === 0 || i === candles.length - 1)) {
        gridEquityCurve.push({ time: c.time, equity: Number(curEquity.toFixed(2)) });
      }
    }

    // End of simulation - settle any open remaining lots to align Net PnL, Win Rate, and Loss Trades
    const processedCandles = candles.slice(0, lastProcessedBar + 1);
    const lastPrice = processedCandles.length > 0 ? processedCandles[processedCandles.length - 1].close : 0;
    const lastTime = processedCandles.length > 0 ? processedCandles[processedCandles.length - 1].time : Date.now();
    for (const lot of heldLots) {
      const exitPrice = lastPrice;
      const proceeds = lot.qty * exitPrice * (1 - costPerFill);
      const invest = lot.qty * lot.buyPrice;
      const pnlQuote = proceeds - invest;
      const pnlPct = invest > 0 ? (pnlQuote / invest) * 100 : 0;
      cash += proceeds;
      const exitCost = lot.qty * exitPrice * costPerFill;
      totalFeesQuote += lot.costQuote + exitCost;

      if (pnlQuote >= 0) {
        grossProfit += pnlQuote;
        wins++;
      } else {
        grossLoss += Math.abs(pnlQuote);
        losses++;
      }

      trades.push({
        id: lot.id,
        subsystem: "GRID",
        side: "LONG",
        entryTime: lot.entryTime,
        entryPrice: lot.buyPrice,
        stopLossPrice: lot.buyPrice * 0.985,
        fanSpreadAtEntry: 0,
        exitTime: lastTime,
        exitPrice,
        exitType: "OPEN",
        pnlQuote,
        pnlPct,
        holdingBars: lot.entryIdx !== undefined ? processedCandles.length - 1 - lot.entryIdx : 0,
        costQuote: lot.costQuote + exitCost,
        channelFloor: lot.floorAtEntry,
        channelCeil: lot.ceilingAtEntry,
        channelMid: lot.centerAtEntry,
        channelSpanPct: lot.floorAtEntry && lot.ceilingAtEntry ? Number((((lot.ceilingAtEntry - lot.floorAtEntry) / lot.floorAtEntry) * 100).toFixed(2)) : undefined,
        zoneIndex: lot.zoneIndex,
      });

      markers.push({
        time: lastTime,
        position: "aboveBar",
        color: pnlQuote >= 0 ? "#10b981" : "#ef4444",
        shape: "circle",
        text: `📦 [OPEN POSITION] #${lot.id} (L${lot.index + 1}) @ $${exitPrice.toFixed(4)} (${pnlQuote >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%)`,
      });
    }

    const finalCapital = cash;
    const netPnlQuote = finalCapital - initialCapital;
    const netPnlPct = (netPnlQuote / initialCapital) * 100;
    const winRate = trades.length > 0 ? (wins / trades.length) * 100 : 0;
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : 0;
    const avgBarsHeld = trades.length > 0 ? Math.round(trades.reduce((a, b) => a + b.holdingBars, 0) / trades.length) : 0;
    const pnlPcts = trades.map((t) => t.pnlPct);
    const bestTradePct = pnlPcts.length > 0 ? Math.max(...pnlPcts) : 0;
    const worstTradePct = pnlPcts.length > 0 ? Math.min(...pnlPcts) : 0;

    const summary: BacktestSummary = {
      initialCapital,
      finalCapital: Number(finalCapital.toFixed(2)),
      netPnlQuote: Number(netPnlQuote.toFixed(2)),
      netPnlPct: Number(netPnlPct.toFixed(2)),
      totalTrades: trades.length,
      winTrades: wins,
      lossTrades: losses,
      winRate: Number(winRate.toFixed(1)),
      profitFactor: Number(profitFactor.toFixed(2)),
      maxDrawdownPct: Number(maxDrawdownPct.toFixed(2)),
      avgBarsHeld,
      bestTradePct: Number(bestTradePct.toFixed(2)),
      worstTradePct: Number(worstTradePct.toFixed(2)),
      totalFeesQuote: Number(totalFeesQuote.toFixed(2)),
      grossPnlQuote: Number((netPnlQuote + totalFeesQuote).toFixed(2)),
    };

    const record: BacktestRecord = {
      id: `bt_grid_${Date.now()}`,
      createdAt: new Date().toISOString(),
      symbol,
      timeframe,
      candleCount: processedCandles.length,
      spreadThreshold: 0,
      isAutoCalibrated: false,
      useRatchetSl: false,
      macroGateMode: "off",
      enableUpsideFloor: false,
      enableCircuitBreaker: false,
      lockChannelInPosition,
      summary,
      trades,
      markers: markers.sort((a, b) => a.time - b.time),
      candles: processedCandles,
      equityCurve: gridEquityCurve,
    };

    if (opts.saveToHistory !== false) {
      this.saveRecord(record);
    }

    return record;
  }

  /**
   * Run full-fidelity simulation for Dual Hybrid Engine (Dynamic Grid + MA-Fan Sniper)
   * Allocates capital between Dynamic Grid (continuous micro-cashflow) and MA-Fan Sniper (momentum expansion)
   */
  public static runDualHybridSimulation(
    candles: Candle[],
    opts: {
      symbol: string;
      timeframe?: string;
      initialCapital?: number;
      gridCapitalPct?: number;
      sniperCapitalPct?: number;
      spreadThreshold?: number | "auto";
      useAtrAdaptiveSpread?: boolean;
      useRatchetSl?: boolean;
      slBufferPct?: number;
      atrMultiplier?: number;
      trailingPullbackPct?: number;
      tp1Ratio?: number;
      supervisorTimeframe?: "15m" | "1h";
      stagnationBars?: number;
      tradeDirection?: "long" | "short" | "both";
      macroGateMode?: "off" | "noDeepBear" | "bullOnly";
      enableUpsideFloor?: boolean;
      enableCircuitBreaker?: boolean;
      enableFastCut?: boolean;
      fastCutThresholdPct?: number;
      maxSlPct?: number;
      costModel?: { feePctPerSide: number; slippagePctPerFill: number };
      saveToHistory?: boolean;
      precomputed?: {
        ribbonStates: RibbonState[];
        exhaustionStates: ExhaustionState[];
        atrs: number[];
      };
      candlesHtf?: Candle[];
      enableBaseConfirmationFilter?: boolean;
      regimeFilterMode?: "SIDEWAY_ONLY" | "NO_DOWNTREND" | "UPTREND_AND_SIDEWAY" | "OFF";
      lockChannelInPosition?: boolean;
      channelMode?: "DOW_SWINGS" | "DOW_ATR_CLAMP" | "FIXED_PCT_CLAMP" | "DONCHIAN_ATR" | "VOLUME_PROFILE_HTF";
      donchianPeriod?: number;
      minChannelWidthPct?: number;
      maxChannelWidthPct?: number;
      floorBufferPct?: number;
      capitalZones?: number;
      zoneStabilizeCandles?: number;
      zoneMinDropPct?: number;
      zoneRequireReversal?: boolean;
      gridCutLossMode?: "none" | "entry_floor" | "final_zone_floor";
      enableGridTrailingStop?: boolean;
      buyLevelPcts?: number[];
      sellLevelPcts?: number[];
      buyWeights?: number[];
      zoneExitMode?: "PORTFOLIO_AVG" | "ORIGINAL_TARGETS" | "PER_ZONE";
      minNetProfitPct?: number;
      tp1TargetMode?: "EMA25" | "EMA75" | "EMA200";
      lockBreakevenAtEma200?: boolean;
      maxDisasterSlPct?: number;
      minBuyVolRatio12?: number;
      maxUpperRibbonSpreadPct?: number;
      minRelStrengthVsBtc24h?: number;
      btcCandles?: Candle[];
      downtrendSitOutMode?: "off" | "btc1d" | "btc4h" | "dual";
    }
  ): BacktestRecord {
    const symbol = opts.symbol.toUpperCase().replace(/[\/\-_:]/g, "");
    const timeframe = opts.timeframe || "5m";
    const initialCapital = opts.initialCapital ?? 200;
    const gridCapPct = opts.gridCapitalPct ?? 60;
    const sniperCapPct = opts.sniperCapitalPct ?? 40;
    const gridInitialCap = initialCapital * (gridCapPct / 100);
    const sniperInitialCap = initialCapital * (sniperCapPct / 100);

    const cm = opts.costModel ?? { feePctPerSide: 0, slippagePctPerFill: 0 };
    const costPerFill = (cm.feePctPerSide + cm.slippagePctPerFill) / 100;
    const tradeDirection = opts.tradeDirection ?? "both";

    const totalZones = Math.max(1, Math.min(5, opts.capitalZones ?? 2));
    const zoneStabilizeCandles = Math.max(1, opts.zoneStabilizeCandles ?? 3);
    const zoneMinDropPct = Math.max(0.5, opts.zoneMinDropPct ?? 2.5);
    const gridCutLossMode = opts.gridCutLossMode ?? "none";
    const zoneExitMode = opts.zoneExitMode ?? "PORTFOLIO_AVG";
    const minNetProfitPct = Math.max(0.15, opts.minNetProfitPct ?? 0.25);
    const zoneBudgetQuote = gridInitialCap / totalZones;
    const curBuys = opts.buyLevelPcts ?? [20, 12];
    const curSells = opts.sellLevelPcts ?? [52, 72];
    const curBuyWeights = opts.buyWeights ?? [55, 45];
    const totalBuyWeight = curBuyWeights.reduce((s, w) => s + w, 0) || 100;
    const regimeFilterMode = opts.regimeFilterMode ?? "UPTREND_AND_SIDEWAY";
    const zoneRequireReversal = opts.zoneRequireReversal !== false;
    let isZoneReversalConfirmed = true;
    let zoneDumpLowPrice = 0;
    let zoneUnlockCandleIdx = 0;

    let unlockedCapitalZones = 1;
    let stableFloorCandleCount = 0;
    let prevCandidateFloor: number | undefined = undefined;
    let lastZoneUnlockFloor: number | undefined = undefined;
    let activeChannel: {
      floor: number;
      ceiling: number;
      center: number;
      channelSpan: number;
      buyLevels: number[];
      sellTargets: number[];
    } | null = null;
    const macroGateMode = opts.macroGateMode ?? "noDeepBear";
    const enableUpsideFloor = opts.enableUpsideFloor !== false;
    const enableCircuitBreaker = opts.enableCircuitBreaker !== false;
    const enableFastCut = opts.enableFastCut !== false;
    const fastCutThresholdPct = opts.fastCutThresholdPct ?? -0.80;
    const maxSlPct = opts.maxSlPct ?? 1.80;
    const slBufferPct = opts.slBufferPct ?? 0.25;
    const useRatchetSl = opts.useRatchetSl !== false;
    const useAtrAdaptive = opts.useAtrAdaptiveSpread ?? true;
    const atrMultiplier = opts.atrMultiplier ?? 1.25;
    const trailingPullbackPct = opts.trailingPullbackPct ?? 0.45;
    const tp1Ratio = Math.max(0.1, Math.min(0.9, opts.tp1Ratio ?? 0.50));
    const supervisorTf = opts.supervisorTimeframe ?? "15m";
    const stagnationBars = opts.stagnationBars ?? 6;

    // Precompute indicators for Sniper Engine
    const ribbonStates = opts.precomputed?.ribbonStates ?? RibbonEngine.computeAllRibbonStates(candles);
    const exhaustionStates = opts.precomputed?.exhaustionStates ?? ExhaustionEngine.computeAllExhaustion(candles);
    const atrs = opts.precomputed?.atrs ?? calcATR(candles, 14);
    const candlesHtf = opts.candlesHtf && opts.candlesHtf.length > 0
      ? opts.candlesHtf
      : BacktestService.aggregateCandles(candles, 15);

    const lockChannelInPosition = opts.lockChannelInPosition !== false;
    let lockedChannel: {
      floor: number;
      ceiling: number;
      center: number;
      channelSpan: number;
      buyLevels: number[];
      sellTargets: number[];
    } | null = null;

    // Dow Structure Engine for Dynamic Grid
    const dow = new DowStructureEngine(3, true, 20.0, 300);
    const warmup = Math.min(100, Math.floor(candles.length / 4));
    for (let k = 0; k < warmup; k++) {
      dow.addCandle(candles[k]);
    }

    // Grid Subsystem State
    let gridCash = gridInitialCap;
    let heldLots: Array<{
      id: number;
      index: number;
      zoneIndex?: number;
      qty: number;
      buyPrice: number;
      entryTime: number;
      entryIdx: number;
      targetPrice: number;
      costQuote: number;
      floorAtEntry?: number;
      ceilingAtEntry?: number;
      centerAtEntry?: number;
      peakPrice?: number;
      stopLossPrice?: number;
      beLocked?: boolean;
      profitLocked?: boolean;
      isTimeDecayEscape?: boolean;
      enteredInUptrend?: boolean;
    }> = [];

    // Sniper Subsystem State
    let sniperCash = sniperInitialCap;
    let sniperHeldQty = 0;
    let sniperInitialInvest = 0;
    let sniperEntryPrice = 0;
    let sniperInitialSlPrice = 0;
    let sniperStopLossPrice = 0;
    let sniperActiveSide: "LONG" | "SHORT" = "LONG";
    let sniperTp1Hit = false;
    let sniperTp1Price = 0;
    let sniperTp1Time = 0;
    let sniperTp1PnlPct = 0;
    let sniperTp1Proceeds = 0;
    let sniperTp1Cost = 0;
    let sniperEntryIdx = 0;
    let highestSinceEntry = 0;
    let highestSinceTp1 = 0;
    let lowestSinceEntry = 0;
    let lowestSinceTp1 = 0;
    let sniperTradeCost = 0;
    let recentSlTimes: number[] = [];
    let cooldownUntilTs = 0;
    let lastSniperExitBar = -1;

    // Setup Rolling Spread Calibrator if spread === "auto"
    const isAuto = opts.spreadThreshold === "auto" || opts.spreadThreshold === undefined;
    let rollingCal: RollingSpreadCalibrator | null = null;
    let spread = 0.45;
    let rollingSpreadSum = 0;
    let rollingSpreadCount = 0;
    if (isAuto) {
      rollingCal = new RollingSpreadCalibrator(symbol, candles, candlesHtf, {
        slBufferPct,
        trailingPullbackPct,
        tp1Ratio,
        initialCapital: sniperInitialCap,
        useRatchetSl,
        costModel: opts.costModel,
        macroGateMode,
        enableUpsideFloor,
      });
    } else {
      spread = Number(opts.spreadThreshold) || 0.45;
    }

    const trades: BacktestTrade[] = [];
    const markers: BacktestMarker[] = [];
    const evaluations: BacktestEvaluationItem[] = new Array(candles.length);
    let grossProfit = 0;
    let grossLoss = 0;
    let wins = 0;
    let losses = 0;
    let peakEquity = initialCapital;
    let maxDrawdownPct = 0;
    let tradeCounter = 0;
    let totalFeesQuote = 0;

    for (let i = warmup; i < candles.length; i++) {
      const c = candles[i];
      dow.addCandle(c);

      const structure = dow.getStructure(c.close, undefined, {
        useOnlyClosedCandles: true,
        mode: opts.channelMode ?? "DONCHIAN_ATR",
        donchianLookback: opts.donchianPeriod ?? 48,
        minChannelWidthPct: opts.minChannelWidthPct ?? 6.0,
        maxChannelWidthPct: opts.maxChannelWidthPct ?? 25.0,
        floorBufferPct: opts.floorBufferPct ?? 0.0,
      });
      let floor: number;
      let ceiling: number;
      let center: number;
      let channelSpan: number;
      let buyLevels: number[];
      let sellTargets: number[];

      const isHoldingPosition = heldLots.length > 0;
      if (!isHoldingPosition) {
        unlockedCapitalZones = 1;
        isZoneReversalConfirmed = true;
        zoneDumpLowPrice = 0;
        stableFloorCandleCount = 0;
        prevCandidateFloor = undefined;
        lastZoneUnlockFloor = undefined;
        lockedChannel = null;

        floor = structure.bottomBound;
        ceiling = structure.upperBound;
        center = structure.centerPrice;
        channelSpan = ceiling - floor;
        buyLevels = curBuys.map((pct) => floor + channelSpan * (pct / 100));
        sellTargets = curSells.map((pct) => floor + channelSpan * (pct / 100));
        activeChannel = { floor, ceiling, center, channelSpan, buyLevels: [...buyLevels], sellTargets: [...sellTargets] };
      } else if (lockChannelInPosition && lockedChannel) {
        floor = lockedChannel.floor;
        ceiling = lockedChannel.ceiling;
        center = lockedChannel.center;
        channelSpan = lockedChannel.channelSpan;
        buyLevels = lockedChannel.buyLevels;
        sellTargets = lockedChannel.sellTargets;
      } else {
        const candidateFloor = structure.bottomBound;
        const currentActiveFloor = activeChannel?.floor ?? candidateFloor;

        if (candidateFloor < currentActiveFloor * 0.999 && activeChannel) {
          if (prevCandidateFloor !== undefined && Math.abs(candidateFloor - prevCandidateFloor) / prevCandidateFloor <= 0.005) {
            stableFloorCandleCount++;
          } else {
            stableFloorCandleCount = 1;
          }
          prevCandidateFloor = candidateFloor;

          const isPillar2Ok = !structure.isDowntrendDropActive && (c.close >= c.open || structure.gridZone?.canEstablishChannel !== false);
          // Pillar 3: Min drop % from active floor or lowest held lot
          const dropFromActiveFloorPct = currentActiveFloor > 0 ? ((currentActiveFloor - candidateFloor) / currentActiveFloor) * 100 : 0;
          const lowestHeldLotPrice = heldLots.length > 0 ? Math.min(...heldLots.map((l) => l.buyPrice)) : 0;
          const dropFromLowestLotPct = lowestHeldLotPrice > 0 ? ((lowestHeldLotPrice - candidateFloor) / lowestHeldLotPrice) * 100 : 0;
          const isPillar3Ok =
            totalZones <= 1 ||
            dropFromActiveFloorPct >= (zoneMinDropPct - 0.1) ||
            (lowestHeldLotPrice > 0 && lowestHeldLotPrice <= candidateFloor) ||
            dropFromLowestLotPct >= (zoneMinDropPct - 0.1);

          const isStabilizedGatePassed = isPillar2Ok && isPillar3Ok && (stableFloorCandleCount >= zoneStabilizeCandles);

          if (isStabilizedGatePassed) {
            if (unlockedCapitalZones < totalZones) {
              unlockedCapitalZones++;
              if (zoneRequireReversal) {
                isZoneReversalConfirmed = false;
                zoneDumpLowPrice = Math.min(c.low, candidateFloor);
                zoneUnlockCandleIdx = i;
              }
            }
            floor = candidateFloor;
            ceiling = structure.upperBound;
            center = structure.centerPrice;
            channelSpan = ceiling - floor;
            buyLevels = curBuys.map((pct) => floor + channelSpan * (pct / 100));
            sellTargets = curSells.map((pct) => floor + channelSpan * (pct / 100));
            activeChannel = { floor, ceiling, center, channelSpan, buyLevels: [...buyLevels], sellTargets: [...sellTargets] };
            lastZoneUnlockFloor = floor;
            stableFloorCandleCount = 0;
          } else {
            floor = activeChannel.floor;
            ceiling = activeChannel.ceiling;
            center = activeChannel.center;
            channelSpan = activeChannel.channelSpan;
            buyLevels = activeChannel.buyLevels;
            sellTargets = activeChannel.sellTargets;
          }
        } else {
          floor = candidateFloor;
          ceiling = structure.upperBound;
          center = structure.centerPrice;
          channelSpan = ceiling - floor;
          buyLevels = curBuys.map((pct) => floor + channelSpan * (pct / 100));
          sellTargets = curSells.map((pct) => floor + channelSpan * (pct / 100));
          activeChannel = { floor, ceiling, center, channelSpan, buyLevels: [...buyLevels], sellTargets: [...sellTargets] };
          stableFloorCandleCount = 0;
        }

        if (isHoldingPosition) {
          const totalHeldQty = heldLots.reduce((sum, l) => sum + l.qty, 0);
          const totalInvestQuote = heldLots.reduce((sum, l) => sum + (l.qty * l.buyPrice), 0);
          const avgEntry = totalHeldQty > 0 ? (totalInvestQuote / totalHeldQty) : 0;
          const minProfitTarget = avgEntry > 0 ? avgEntry * (1 + minNetProfitPct / 100) : 0;

          for (const lot of heldLots) {
            if (zoneExitMode === "ORIGINAL_TARGETS" && lot.targetPrice > 0) {
              continue;
            }
            const dynamicTarget = sellTargets[lot.index] ?? (avgEntry * 1.015);
            lot.targetPrice = Math.max(dynamicTarget, minProfitTarget);
          }
        }
      }

      // HTF Regime & Ribbon Evaluation for Sniper
      const htfRegime = RegimeSupervisor.evaluateHtfRegime(candlesHtf, supervisorTf, c.time, tp1Ratio);
      const ribbon = ribbonStates[i]!;
      const exhaustion = exhaustionStates[i]!;
      const curAtr = atrs[i] ?? (c.close * 0.003);

      let currentRollingSpread = spread;
      if (rollingCal) {
        currentRollingSpread = rollingCal.bestSpreadAt(i);
        // Minimum spread floor 0.40% to prevent fee erosion from micro-spreads
        if (currentRollingSpread < 0.40) currentRollingSpread = 0.40;
        rollingSpreadSum += currentRollingSpread;
        rollingSpreadCount++;
      }
      const activeBaseSpread = isAuto ? currentRollingSpread : spread;
      const currentSpread = MaFanCoreRules.computeEffectiveSpread({
        baseSpread: activeBaseSpread,
        useAtrAdaptiveSpread: useAtrAdaptive,
        isAutoCalibrated: isAuto,
        curAtr,
        closePrice: c.close,
        atrMultiplier,
      });
      const reqSpread = currentSpread * htfRegime.spreadMultiplier;
      const isCircuitActive = enableCircuitBreaker && c.time < cooldownUntilTs;

      evaluations[i] = {
        time: c.time,
        fanSpreadPct: ribbon.fanSpreadPct,
        isFanningDown: ribbon.isFanningDown,
        isHookUp: ribbon.isHookUp,
        rsi: exhaustion.rsi,
        rsiSma: exhaustion.rsiSma,
        isOversoldExhaustion: exhaustion.isOversoldExhaustion,
        ema4: ribbon.ema4,
        ema8: ribbon.ema8,
        ema16: ribbon.ema16,
        ema25: ribbon.ema25,
        ema75: ribbon.ema75,
        ema200: ribbon.ema200,
        requiredSpreadPct: Number(reqSpread.toFixed(2)),
        spreadMultiplier: htfRegime.spreadMultiplier,
        isDeepBear: htfRegime.isDeepBear,
        isMacroBlocked: false,
        isCircuitBreakerActive: isCircuitActive,
      };

      // ── 1. EVALUATE GRID EXITS (TP & Cut Loss) ──
      if (channelSpan > 0) {
        const floorBuf = opts.slBufferPct ?? 0.0;
        const cutLossPrice = floorBuf > 0 ? floor * (1 - floorBuf / 100) : floor * 0.985;
        const canTriggerCutLoss =
          gridCutLossMode !== "none" &&
          (gridCutLossMode === "entry_floor" || unlockedCapitalZones >= totalZones);

        const remainingLots: typeof heldLots = [];
        for (const lot of heldLots) {
          if (c.high >= lot.targetPrice) {
            const exitPrice = lot.targetPrice;
            const proceeds = lot.qty * exitPrice * (1 - costPerFill);
            const invest = lot.qty * lot.buyPrice;
            const pnlQuote = proceeds - invest;
            const pnlPct = invest > 0 ? (pnlQuote / invest) * 100 : 0;
            gridCash += proceeds;
            const exitCost = lot.qty * exitPrice * costPerFill;
            totalFeesQuote += lot.costQuote + exitCost;

            if (pnlQuote >= 0) { grossProfit += pnlQuote; wins++; }
            else { grossLoss += Math.abs(pnlQuote); losses++; }

            trades.push({
              id: lot.id,
              subsystem: "GRID",
              side: "LONG",
              entryTime: lot.entryTime,
              entryPrice: lot.buyPrice,
              stopLossPrice: cutLossPrice,
              fanSpreadAtEntry: 0,
              exitTime: c.time,
              exitPrice,
              exitType: "GRID_TP",
              pnlQuote,
              pnlPct,
              holdingBars: i - lot.entryIdx,
              costQuote: lot.costQuote + exitCost,
              channelFloor: lot.floorAtEntry,
              channelCeil: lot.ceilingAtEntry,
              channelMid: lot.centerAtEntry,
              channelSpanPct: lot.floorAtEntry && lot.ceilingAtEntry ? Number((((lot.ceilingAtEntry - lot.floorAtEntry) / lot.floorAtEntry) * 100).toFixed(2)) : undefined,
              zoneIndex: lot.zoneIndex,
            });

            markers.push({
              time: c.time,
              position: "aboveBar",
              color: "#3b82f6",
              shape: "circle",
              text: `🔵 GRID TP #${lot.id} (L${lot.index + 1}${lot.zoneIndex ? ` Z${lot.zoneIndex}` : ''}) @ $${exitPrice.toFixed(4)} (+${pnlPct.toFixed(2)}%)`,
            });
            continue;
          }

          if (canTriggerCutLoss && c.low <= cutLossPrice) {
            const exitPrice = cutLossPrice;
            const proceeds = lot.qty * exitPrice * (1 - costPerFill);
            const invest = lot.qty * lot.buyPrice;
            const pnlQuote = proceeds - invest;
            const pnlPct = invest > 0 ? (pnlQuote / invest) * 100 : 0;
            gridCash += proceeds;
            const exitCost = lot.qty * exitPrice * costPerFill;
            totalFeesQuote += lot.costQuote + exitCost;

            grossLoss += Math.abs(pnlQuote);
            losses++;

            trades.push({
              id: lot.id,
              subsystem: "GRID",
              side: "LONG",
              entryTime: lot.entryTime,
              entryPrice: lot.buyPrice,
              stopLossPrice: cutLossPrice,
              fanSpreadAtEntry: 0,
              exitTime: c.time,
              exitPrice,
              exitType: "GRID_CUT",
              pnlQuote,
              pnlPct,
              holdingBars: i - lot.entryIdx,
              costQuote: lot.costQuote + exitCost,
              channelFloor: lot.floorAtEntry,
              channelCeil: lot.ceilingAtEntry,
              channelMid: lot.centerAtEntry,
              channelSpanPct: lot.floorAtEntry && lot.ceilingAtEntry ? Number((((lot.ceilingAtEntry - lot.floorAtEntry) / lot.floorAtEntry) * 100).toFixed(2)) : undefined,
              zoneIndex: lot.zoneIndex,
            });

            markers.push({
              time: c.time,
              position: "belowBar",
              color: "#ef4444",
              shape: "arrowDown",
              text: `🔴 GRID CUT #${lot.id} (L${lot.index + 1}${lot.zoneIndex ? ` Z${lot.zoneIndex}` : ''}) @ $${exitPrice.toFixed(4)} (${pnlPct.toFixed(2)}%)`,
            });
            continue;
          }
          remainingLots.push(lot);
        }
        heldLots = remainingLots;

        if (unlockedCapitalZones > 1) {
          if (c.low < zoneDumpLowPrice * 0.9995) {
            if (isZoneReversalConfirmed) {
              isZoneReversalConfirmed = false;
              zoneUnlockCandleIdx = i;
            }
            zoneDumpLowPrice = c.low;
          }
        }

        if (unlockedCapitalZones > 1 && !isZoneReversalConfirmed) {
          const isBreakout = Boolean(structure.downtrendBreakoutConfirmed);
          const lastLl = structure.waveCycle?.lastLl;
          const lastHl = structure.waveCycle?.lastHl;
          const isHlAfterLl = Boolean(
            lastHl &&
            (lastHl.index ?? 0) >= zoneUnlockCandleIdx &&
            (!lastLl || (lastHl.index ?? 0) > (lastLl.index ?? 0)) &&
            lastHl.price > zoneDumpLowPrice * 1.002
          );
          const choChPrice = structure.gridZone?.choChLevel ?? structure.waveCycle?.lastLh?.price;
          const isChoChBreakout = Boolean(
            choChPrice &&
            choChPrice > zoneDumpLowPrice &&
            c.close > choChPrice * 1.0005
          );
          if (isBreakout || isHlAfterLl || isChoChBreakout) {
            isZoneReversalConfirmed = true;
          }
        }

        // ── 2. EVALUATE GRID BUYS ──
        const effectiveMaxInventory = zoneBudgetQuote * unlockedCapitalZones;
        const trancheQuote = zoneBudgetQuote / Math.max(1, curBuys.length);
        const currentGridInv = heldLots.reduce((s, l) => s + (l.qty * l.buyPrice), 0);

        let isRegimeBlocked = !structure.isSwingConfirmed;
        if (regimeFilterMode === "UPTREND_AND_SIDEWAY" || regimeFilterMode === "NO_DOWNTREND") {
          const isDowntrend = structure.regime === "DOWNTREND" || Boolean(structure.isDowntrendDropActive);
          const isBearSpike = (structure.regimeMetrics?.minusDI ?? 0) - (structure.regimeMetrics?.plusDI ?? 0) > 12;
          const isWaterfall = i >= 3 && candles.slice(i - 3, i + 1).every((b) => b.close < b.open);
          if (isDowntrend || isBearSpike || isWaterfall) {
            isRegimeBlocked = true;
          }
        } else if (regimeFilterMode === "SIDEWAY_ONLY") {
          const isRange = structure.regime === "RANGE";
          const canEstablish = structure.gridZone?.canEstablishChannel !== false;
          const notDropping = !structure.isDowntrendDropActive;
          if (!isRange || !canEstablish || !notDropping) {
            isRegimeBlocked = true;
          }
        } else if (opts.enableBaseConfirmationFilter === true) {
          if (structure.gridZone?.canEstablishChannel === false || Boolean(structure.isDowntrendDropActive)) {
            isRegimeBlocked = true;
          }
        }
        const isHlWaiting = isRegimeBlocked;
        const isZoneWaiting = zoneRequireReversal && unlockedCapitalZones > 1 && !isZoneReversalConfirmed;

        if (heldLots.length === 0) {
          lockedChannel = null;
          unlockedCapitalZones = 1;
          isZoneReversalConfirmed = true;
          zoneDumpLowPrice = 0;
          stableFloorCandleCount = 0;
        }

        const maxLotsForUnlockedZones = unlockedCapitalZones * Math.max(1, curBuys.length);
        if (!isHlWaiting && !isZoneWaiting && currentGridInv + trancheQuote <= effectiveMaxInventory && gridCash >= trancheQuote && heldLots.length < maxLotsForUnlockedZones) {

          for (let lvlIdx = 0; lvlIdx < buyLevels.length; lvlIdx++) {
            const bl = buyLevels[lvlIdx];
            const alreadyFilled = heldLots.some((l) => (l.zoneIndex ?? 1) === unlockedCapitalZones && l.index === lvlIdx);
            if (!alreadyFilled && c.low <= bl && (!canTriggerCutLoss || c.close >= cutLossPrice)) {
              tradeCounter++;
              const buyPrice = bl;
              const invest = trancheQuote;
              const fillQty = (invest / buyPrice) * (1 - costPerFill);
              gridCash -= invest;

              const totalHeldQtyBefore = heldLots.reduce((sum, l) => sum + l.qty, 0);
              const totalInvestBefore = heldLots.reduce((sum, l) => sum + (l.qty * l.buyPrice), 0);
              const newAvgEntry = (totalInvestBefore + invest) / (totalHeldQtyBefore + fillQty);
              const minProfitHurdle = newAvgEntry * (1 + minNetProfitPct / 100);

              const rawTarget = sellTargets[lvlIdx] ?? (buyPrice * 1.015);
              const targetPrice = Math.max(rawTarget, minProfitHurdle);

              heldLots.push({
                id: tradeCounter,
                index: lvlIdx,
                zoneIndex: unlockedCapitalZones,
                qty: fillQty,
                buyPrice,
                entryTime: c.time,
                entryIdx: i,
                targetPrice,
                costQuote: invest * costPerFill,
                floorAtEntry: floor,
                ceilingAtEntry: ceiling,
                centerAtEntry: center,
                peakPrice: buyPrice,
                stopLossPrice: cutLossPrice,
              });

              if (!lockedChannel) {
                lockedChannel = {
                  floor,
                  ceiling,
                  center,
                  channelSpan,
                  buyLevels: [...buyLevels],
                  sellTargets: [...sellTargets],
                };
              }

              markers.push({
                time: c.time,
                position: "belowBar",
                color: "#10b981",
                shape: "circle",
                text: `🟢 GRID BUY #${tradeCounter} (L${lvlIdx + 1} Z${unlockedCapitalZones}) @ $${buyPrice.toFixed(4)}`,
              });
              break;
            }
          }
        }
      }

      // ── 3. EVALUATE SNIPER EXITS ──
      if (sniperHeldQty > 0) {
        if (c.high > highestSinceEntry) highestSinceEntry = c.high;
        if (c.high > highestSinceTp1) highestSinceTp1 = c.high;
        if (lowestSinceEntry === 0 || c.low < lowestSinceEntry) lowestSinceEntry = c.low;
        if (lowestSinceTp1 === 0 || c.low < lowestSinceTp1) lowestSinceTp1 = c.low;

        const barsHeld = i - sniperEntryIdx;

        // Ratchet SL
        const liftedSl = MaFanCoreRules.evaluateRatchetSl({
          candles,
          currentIndex: i,
          barsHeld,
          currentSlPrice: sniperStopLossPrice,
          currentPrice: c.close,
          curAtr,
          slBufferPct,
          useRatchetSl,
          positionSide: sniperActiveSide,
        });
        if (liftedSl !== null) {
          if (sniperActiveSide === "LONG" && liftedSl > sniperStopLossPrice) sniperStopLossPrice = liftedSl;
          else if (sniperActiveSide === "SHORT" && liftedSl < sniperStopLossPrice) sniperStopLossPrice = liftedSl;
        }

        const exitDecision = MaFanCoreRules.evaluateExits({
          highPrice: c.high,
          lowPrice: c.low,
          closePrice: c.close,
          positionSide: sniperActiveSide,
          entryPrice: sniperEntryPrice,
          tp1Filled: sniperTp1Hit,
          stopLossPrice: sniperStopLossPrice,
          highestPriceSinceTp1: highestSinceTp1,
          lowestPriceSinceTp1: lowestSinceTp1,
          highestPriceSinceEntry: highestSinceEntry,
          lowestPriceSinceEntry: lowestSinceEntry,
          ribbon,
          exhaustion,
          trailingPullbackPct,
          isOverbought: exhaustion.isOverboughtExhaustion,
          isOversold: exhaustion.isOversoldExhaustion,
          barsHeld,
          isHtfBull: !!htfRegime.isBullish,
          tp1MinProfitPct: 0.65,
          enableFastCut,
          fastCutThresholdPct,
          stagnationBars,
        });

        if (exitDecision.action === "TP2" || exitDecision.action === "SL") {
          const exitPrice = exitDecision.exitPrice;
          tradeCounter++;
          let secondHalfProceeds = 0;
          const exitCost = sniperHeldQty * exitPrice * costPerFill;

          if (sniperActiveSide === "LONG") {
            secondHalfProceeds = sniperHeldQty * exitPrice * (1 - costPerFill);
          } else {
            secondHalfProceeds = (sniperHeldQty * sniperEntryPrice) + (sniperHeldQty * (sniperEntryPrice - exitPrice) * (1 - costPerFill));
          }

          const totalProceeds = sniperTp1Proceeds + secondHalfProceeds;
          const totalInvest = sniperInitialInvest;
          const pnlQuote = totalProceeds - totalInvest;
          const pnlPct = totalInvest > 0 ? (pnlQuote / totalInvest) * 100 : 0;
          sniperCash += secondHalfProceeds;
          const tradeTotalCost = sniperTradeCost + sniperTp1Cost + exitCost;
          totalFeesQuote += tradeTotalCost;

          if (pnlQuote >= 0) { grossProfit += pnlQuote; wins++; }
          else { grossLoss += Math.abs(pnlQuote); losses++; }

          const isFastCut = exitDecision.reason?.startsWith("Fast Technical Cut") || exitDecision.reason?.startsWith("Fast Stagnation Cut");
          const isRatchet = !sniperTp1Hit && (sniperActiveSide === "LONG" ? sniperStopLossPrice > sniperInitialSlPrice : sniperStopLossPrice < sniperInitialSlPrice);
          const exitType: BacktestTrade["exitType"] = exitDecision.action === "TP2" ? "TP1+TP2" : isFastCut ? "TECH_FAST_CUT" : sniperTp1Hit ? "TP1+SL_BE" : isRatchet ? "RATCHET_SL" : "SL";

          trades.push({
            id: tradeCounter,
            subsystem: "SNIPER",
            side: sniperActiveSide,
            entryTime: candles[sniperEntryIdx].time,
            entryPrice: sniperEntryPrice,
            stopLossPrice: sniperStopLossPrice,
            fanSpreadAtEntry: ribbonStates[sniperEntryIdx].fanSpreadPct,
            tp1Time: sniperTp1Hit ? sniperTp1Time : undefined,
            tp1Price: sniperTp1Hit ? sniperTp1Price : undefined,
            tp1PnlPct: sniperTp1Hit ? sniperTp1PnlPct : undefined,
            exitTime: c.time,
            exitPrice,
            exitType,
            pnlQuote,
            pnlPct,
            holdingBars: barsHeld,
            costQuote: tradeTotalCost,
          });

          markers.push({
            time: c.time,
            position: sniperActiveSide === "LONG" ? "aboveBar" : "belowBar",
            color: pnlQuote >= 0 ? "#8b5cf6" : "#ef4444",
            shape: pnlQuote >= 0 ? "arrowDown" : "square",
            text: `🎯 SNIPER ${exitType} #${tradeCounter} @ $${exitPrice.toFixed(4)} (${pnlPct.toFixed(2)}%)`,
          });

          if (pnlQuote < 0) {
            recentSlTimes.push(c.time);
            if (enableCircuitBreaker) {
              recentSlTimes = recentSlTimes.filter((t) => t >= c.time - 12 * 3600);
              if (recentSlTimes.length >= 2) {
                cooldownUntilTs = c.time + 6 * 3600;
              }
            }
          }
          lastSniperExitBar = i;
          sniperHeldQty = 0;
          sniperTp1Hit = false;
          sniperTp1Proceeds = 0;
          sniperTp1Cost = 0;
        } else if (exitDecision.action === "TP1" && !sniperTp1Hit) {
          sniperTp1Hit = true;
          sniperTp1Price = exitDecision.exitPrice;
          sniperTp1Time = c.time;
          const halfQty = sniperHeldQty * tp1Ratio;
          let tp1Proceeds = 0;
          let partialPnl = 0;
          if (sniperActiveSide === "LONG") {
            tp1Proceeds = halfQty * sniperTp1Price * (1 - costPerFill);
            partialPnl = tp1Proceeds - (halfQty * sniperEntryPrice);
          } else {
            tp1Proceeds = (halfQty * sniperEntryPrice) + (halfQty * (sniperEntryPrice - sniperTp1Price) * (1 - costPerFill));
            partialPnl = tp1Proceeds - (halfQty * sniperEntryPrice);
          }
          sniperTp1Proceeds = tp1Proceeds;
          sniperTp1Cost = halfQty * sniperTp1Price * costPerFill;
          sniperTp1PnlPct = (partialPnl / (halfQty * sniperEntryPrice)) * 100;
          sniperCash += tp1Proceeds;
          sniperHeldQty -= halfQty;
          highestSinceTp1 = c.high;
          lowestSinceTp1 = c.low;
          sniperStopLossPrice = sniperEntryPrice;

          markers.push({
            time: c.time,
            position: sniperActiveSide === "LONG" ? "aboveBar" : "belowBar",
            color: "#06b6d4",
            shape: "circle",
            text: `🎯 SNIPER TP1 (${Math.round(tp1Ratio * 100)}%) @ $${sniperTp1Price.toFixed(4)} (+${sniperTp1PnlPct.toFixed(2)}%)`,
          });
        }
      }

      // ── 4. EVALUATE SNIPER ENTRY ──
      if (sniperHeldQty === 0 && sniperCash >= sniperInitialCap * 0.8 && !isCircuitActive && i > lastSniperExitBar) {
        const modularDecision = MaFanCoreRules.evaluateModularEntry({
          tradeMode: "dual",
          tradeDirection,
          candles,
          closePrice: c.close,
          currentIndex: i,
          ribbon,
          exhaustion,
          curAtr,
          requiredSpreadPct: reqSpread,
          slBufferPct,
          macroGateMode,
          isHtfBull: !!htfRegime.isBullish,
          htfRegime,
          enableUpsideFloor,
          circuitBreakerActive: isCircuitActive,
          maxSlPct,
        });

        if (modularDecision.shouldEnter) {
          sniperActiveSide = modularDecision.positionSide ?? "LONG";
          sniperEntryPrice = modularDecision.entryPrice;
          sniperInitialSlPrice = modularDecision.stopLossPrice;
          sniperStopLossPrice = modularDecision.stopLossPrice;
          sniperEntryIdx = i;
          const invest = sniperInitialCap;
          sniperInitialInvest = invest;
          sniperHeldQty = (invest / sniperEntryPrice) * (1 - costPerFill);
          sniperCash -= invest;
          sniperTradeCost = invest * costPerFill;
          sniperTp1Proceeds = 0;
          sniperTp1Cost = 0;
          highestSinceEntry = c.high;
          lowestSinceEntry = c.low;
          highestSinceTp1 = 0;
          lowestSinceTp1 = 0;
          sniperTp1Hit = false;

          markers.push({
            time: c.time,
            position: sniperActiveSide === "LONG" ? "belowBar" : "aboveBar",
            color: "#f59e0b",
            shape: sniperActiveSide === "LONG" ? "arrowUp" : "arrowDown",
            text: `🎯 SNIPER ${sniperActiveSide} @ $${sniperEntryPrice.toFixed(4)}`,
          });
        }
      }

      // ── 5. COMBINED EQUITY CURVE & MAX DD ──
      const gridInvVal = heldLots.reduce((s, l) => s + (l.qty * c.close), 0);
      const sniperPosVal = sniperHeldQty > 0
        ? (sniperActiveSide === "LONG"
            ? sniperHeldQty * c.close
            : (sniperHeldQty * sniperEntryPrice) + (sniperHeldQty * (sniperEntryPrice - c.close)))
        : 0;
      const curEquity = gridCash + gridInvVal + sniperCash + sniperPosVal;
      if (curEquity > peakEquity) peakEquity = curEquity;
      const dd = peakEquity > 0 ? ((peakEquity - curEquity) / peakEquity) * 100 : 0;
      if (dd > maxDrawdownPct) maxDrawdownPct = dd;
    }

    // End of simulation liquidation & open positions settlement
    const lastPrice = candles.length > 0 ? candles[candles.length - 1].close : 0;
    const lastTime = candles.length > 0 ? candles[candles.length - 1].time : Date.now();

    if (sniperHeldQty > 0) {
      const exitPrice = lastPrice;
      const proceeds = sniperActiveSide === "LONG"
        ? sniperHeldQty * exitPrice * (1 - costPerFill)
        : (sniperHeldQty * sniperEntryPrice) + (sniperHeldQty * (sniperEntryPrice - lastPrice) * (1 - costPerFill));
      const invest = sniperHeldQty * sniperEntryPrice;
      const pnlQuote = proceeds - invest;
      const pnlPct = invest > 0 ? (pnlQuote / invest) * 100 : 0;
      sniperCash += proceeds;
      const exitCost = sniperHeldQty * exitPrice * costPerFill;
      totalFeesQuote += (sniperHeldQty * sniperEntryPrice * costPerFill) + exitCost;

      if (pnlQuote >= 0) {
        grossProfit += pnlQuote;
        wins++;
      } else {
        grossLoss += Math.abs(pnlQuote);
        losses++;
      }

      const entryTime = candles[sniperEntryIdx]?.time || candles[0].time;
      trades.push({
        id: ++tradeCounter,
        subsystem: "SNIPER",
        side: sniperActiveSide,
        entryTime,
        entryPrice: sniperEntryPrice,
        stopLossPrice: sniperStopLossPrice,
        fanSpreadAtEntry: 0,
        exitTime: lastTime,
        exitPrice,
        exitType: "OPEN",
        pnlQuote,
        pnlPct,
        holdingBars: candles.length - 1 - sniperEntryIdx,
        costQuote: (sniperHeldQty * sniperEntryPrice * costPerFill) + exitCost,
      });
    }

    for (const lot of heldLots) {
      const exitPrice = lastPrice;
      const proceeds = lot.qty * exitPrice * (1 - costPerFill);
      const invest = lot.qty * lot.buyPrice;
      const pnlQuote = proceeds - invest;
      const pnlPct = invest > 0 ? (pnlQuote / invest) * 100 : 0;
      gridCash += proceeds;
      const exitCost = lot.qty * exitPrice * costPerFill;
      totalFeesQuote += lot.costQuote + exitCost;

      if (pnlQuote >= 0) {
        grossProfit += pnlQuote;
        wins++;
      } else {
        grossLoss += Math.abs(pnlQuote);
        losses++;
      }

      trades.push({
        id: lot.id,
        subsystem: "GRID",
        side: "LONG",
        entryTime: lot.entryTime,
        entryPrice: lot.buyPrice,
        stopLossPrice: lot.buyPrice * 0.985,
        fanSpreadAtEntry: 0,
        exitTime: lastTime,
        exitPrice,
        exitType: "OPEN",
        pnlQuote,
        pnlPct,
        holdingBars: candles.length - 1 - (candles.findIndex((x) => x.time === lot.entryTime) || 0),
        costQuote: lot.costQuote + exitCost,
        channelFloor: lot.floorAtEntry,
        channelCeil: lot.ceilingAtEntry,
        channelMid: lot.centerAtEntry,
        channelSpanPct: lot.floorAtEntry && lot.ceilingAtEntry ? Number((((lot.ceilingAtEntry - lot.floorAtEntry) / lot.floorAtEntry) * 100).toFixed(2)) : undefined,
        zoneIndex: lot.zoneIndex,
      });
    }

    const finalCapital = gridCash + sniperCash;
    const netPnlQuote = finalCapital - initialCapital;
    const netPnlPct = (netPnlQuote / initialCapital) * 100;
    const winRate = trades.length > 0 ? (wins / trades.length) * 100 : 0;
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : 0;
    const avgBarsHeld = trades.length > 0 ? Math.round(trades.reduce((a, b) => a + b.holdingBars, 0) / trades.length) : 0;
    const pnlPcts = trades.map((t) => t.pnlPct);
    const bestTradePct = pnlPcts.length > 0 ? Math.max(...pnlPcts) : 0;
    const worstTradePct = pnlPcts.length > 0 ? Math.min(...pnlPcts) : 0;

    const summary: BacktestSummary = {
      initialCapital,
      finalCapital: Number(finalCapital.toFixed(2)),
      netPnlQuote: Number(netPnlQuote.toFixed(2)),
      netPnlPct: Number(netPnlPct.toFixed(2)),
      totalTrades: trades.length,
      winTrades: wins,
      lossTrades: losses,
      winRate: Number(winRate.toFixed(1)),
      profitFactor: Number(profitFactor.toFixed(2)),
      maxDrawdownPct: Number(maxDrawdownPct.toFixed(2)),
      avgBarsHeld,
      bestTradePct: Number(bestTradePct.toFixed(2)),
      worstTradePct: Number(worstTradePct.toFixed(2)),
      totalFeesQuote: Number(totalFeesQuote.toFixed(2)),
      grossPnlQuote: Number((netPnlQuote + totalFeesQuote).toFixed(2)),
    };

    const record: BacktestRecord = {
      id: `bt_dual_${Date.now()}`,
      createdAt: new Date().toISOString(),
      symbol,
      timeframe,
      candleCount: candles.length,
      spreadThreshold: isAuto
        ? (rollingSpreadCount > 0 ? Number((rollingSpreadSum / rollingSpreadCount).toFixed(2)) : spread)
        : spread,
      isAutoCalibrated: isAuto,
      useRatchetSl,
      macroGateMode,
      enableUpsideFloor,
      enableCircuitBreaker,
      lockChannelInPosition,
      summary,
      trades,
      markers: markers.sort((a, b) => a.time - b.time),
      candles,
      evaluations,
    };

    if (opts.saveToHistory !== false) {
      this.saveRecord(record);
    }

    return record;
  }

  /**
   * Run full-fidelity simulation for MA Fan Sniper Strategy
   */
  public static runMaFanSimulation(
    candles: Candle[],
    opts: {
      symbol: string;
      timeframe: string;
      spreadThreshold?: number | "auto";
      initialCapital?: number;
      slBufferPct?: number;
      useRatchetSl?: boolean;
      useAtrAdaptiveSpread?: boolean;
      atrMultiplier?: number;
      trailingPullbackPct?: number;
      tp1Ratio?: number;
      breakevenFeeBufferPct?: number;
      supervisorTimeframe?: "15m" | "1h";
      saveToHistory?: boolean;
      candlesHtf?: Candle[];
      cushionMode?: CushionMode;
      costModel?: { feePctPerSide: number; slippagePctPerFill: number };
      intrabarMode?: "optimistic" | "closeBased" | "pessimistic";
      cushionThresholdPct?: number;
      tp1MinProfitPct?: number;
      minRewardRiskRatio?: number;
      waterfallGuardMode?: WaterfallGuardMode;
      macroGateMode?: "off" | "noDeepBear" | "bullOnly";
      enableUpsideFloor?: boolean;
      enableCircuitBreaker?: boolean;
      enableFastCut?: boolean;
      fastCutThresholdPct?: number;
      stagnationBars?: number;
      maxSlPct?: number;
      tradeMode?: "dip_hunter" | "trend_rider" | "dual" | "dynamic_grid" | "dual_hybrid";
      tradeDirection?: "long" | "short" | "both";
      exitInfoLag?: 0 | 1;
      warmupBars?: number;
      precomputed?: {
        ribbonStates: RibbonState[];
        exhaustionStates: ExhaustionState[];
        atrs: number[];
      };
      onlyEntryIdx?: number;
      trimWarmupPrefix?: boolean;
      enableBaseConfirmationFilter?: boolean;
      regimeFilterMode?: "SIDEWAY_ONLY" | "NO_DOWNTREND" | "UPTREND_AND_SIDEWAY" | "OFF";
      lockChannelInPosition?: boolean;
      channelMode?: "DOW_SWINGS" | "DOW_ATR_CLAMP" | "FIXED_PCT_CLAMP" | "DONCHIAN_ATR" | "VOLUME_PROFILE_HTF";
      donchianPeriod?: number;
      minChannelWidthPct?: number;
      maxChannelWidthPct?: number;
      floorBufferPct?: number;
      maxInventoryQuote?: number;
      capitalZones?: number;
      zoneStabilizeCandles?: number;
      zoneMinDropPct?: number;
      zoneRequireReversal?: boolean;
      gridCutLossMode?: "none" | "entry_floor" | "final_zone_floor";
      enableGridTrailingStop?: boolean;
      buyLevelPcts?: number[];
      sellLevelPcts?: number[];
      buyWeights?: number[];
      zoneExitMode?: "PORTFOLIO_AVG" | "ORIGINAL_TARGETS" | "PER_ZONE";
      minNetProfitPct?: number;
      tp1TargetMode?: "EMA25" | "EMA75" | "EMA200";
      lockBreakevenAtEma200?: boolean;
      maxDisasterSlPct?: number;
      minBuyVolRatio12?: number;
      maxUpperRibbonSpreadPct?: number;
      minRelStrengthVsBtc24h?: number;
      btcCandles?: Candle[];
      downtrendSitOutMode?: "off" | "btc1d" | "btc4h" | "dual";
    }
  ): BacktestRecord {
    if (opts.tradeMode === "dynamic_grid") {
      return BacktestService.runDynamicGridSimulation(candles, {
        symbol: opts.symbol,
        timeframe: opts.timeframe,
        initialCapital: opts.initialCapital,
        maxInventoryQuote: opts.maxInventoryQuote ?? opts.initialCapital,
        costModel: opts.costModel,
        saveToHistory: opts.saveToHistory,
        enableBaseConfirmationFilter: opts.enableBaseConfirmationFilter,
        channelMode: opts.channelMode,
        donchianPeriod: opts.donchianPeriod,
        minChannelWidthPct: opts.minChannelWidthPct,
        maxChannelWidthPct: opts.maxChannelWidthPct,
        floorBufferPct: opts.floorBufferPct,
        lockChannelInPosition: opts.lockChannelInPosition,
        capitalZones: opts.capitalZones,
        zoneStabilizeCandles: opts.zoneStabilizeCandles,
        zoneMinDropPct: opts.zoneMinDropPct,
        zoneRequireReversal: opts.zoneRequireReversal,
        gridCutLossMode: opts.gridCutLossMode,
        zoneExitMode: opts.zoneExitMode,
        minNetProfitPct: opts.minNetProfitPct,
        buyLevelPcts: opts.buyLevelPcts,
        sellLevelPcts: opts.sellLevelPcts,
        buyWeights: opts.buyWeights,
        regimeFilterMode: opts.regimeFilterMode,
        enableGridTrailingStop: opts.enableGridTrailingStop,
      });
    }

    if (opts.tradeMode === "dual_hybrid") {
      return BacktestService.runDualHybridSimulation(candles, {
        symbol: opts.symbol,
        timeframe: opts.timeframe,
        initialCapital: opts.initialCapital,
        spreadThreshold: opts.spreadThreshold,
        useAtrAdaptiveSpread: opts.useAtrAdaptiveSpread,
        useRatchetSl: opts.useRatchetSl,
        slBufferPct: opts.slBufferPct,
        atrMultiplier: opts.atrMultiplier,
        trailingPullbackPct: opts.trailingPullbackPct,
        tp1Ratio: opts.tp1Ratio,
        supervisorTimeframe: opts.supervisorTimeframe,
        stagnationBars: opts.stagnationBars,
        costModel: opts.costModel,
        saveToHistory: opts.saveToHistory,
        tradeDirection: opts.tradeDirection,
        macroGateMode: opts.macroGateMode,
        enableUpsideFloor: opts.enableUpsideFloor,
        enableCircuitBreaker: opts.enableCircuitBreaker,
        enableFastCut: opts.enableFastCut,
        fastCutThresholdPct: opts.fastCutThresholdPct,
        maxSlPct: opts.maxSlPct,
        precomputed: opts.precomputed,
        candlesHtf: opts.candlesHtf,
        enableBaseConfirmationFilter: opts.enableBaseConfirmationFilter,
        lockChannelInPosition: opts.lockChannelInPosition,
        channelMode: opts.channelMode,
        donchianPeriod: opts.donchianPeriod,
        minChannelWidthPct: opts.minChannelWidthPct,
        maxChannelWidthPct: opts.maxChannelWidthPct,
        floorBufferPct: opts.floorBufferPct,
        capitalZones: opts.capitalZones,
        zoneStabilizeCandles: opts.zoneStabilizeCandles,
        zoneMinDropPct: opts.zoneMinDropPct,
        zoneRequireReversal: opts.zoneRequireReversal,
        gridCutLossMode: opts.gridCutLossMode,
        zoneExitMode: opts.zoneExitMode,
        minNetProfitPct: opts.minNetProfitPct,
        buyLevelPcts: opts.buyLevelPcts,
        sellLevelPcts: opts.sellLevelPcts,
        buyWeights: opts.buyWeights,
        regimeFilterMode: opts.regimeFilterMode,
        enableGridTrailingStop: opts.enableGridTrailingStop,
      });
    }

    const symbol = opts.symbol.toUpperCase().replace(/[\/\-_:]/g, "");
    const timeframe = opts.timeframe || "5m";
    const initialCapital = opts.initialCapital ?? 200;
    const slBufferPct = opts.slBufferPct ?? 0.25;
    const useRatchetSl = opts.useRatchetSl !== false;
    const useAtrAdaptive = opts.useAtrAdaptiveSpread ?? true;
    const atrMultiplier = opts.atrMultiplier ?? 1.25;
    const trailingPullbackPct = opts.trailingPullbackPct ?? 0.45;
    const tp1Ratio = Math.max(0.1, Math.min(0.9, opts.tp1Ratio ?? 0.50));
    const supervisorTf = opts.supervisorTimeframe ?? "15m";
    const targetMinutes = supervisorTf === "1h" ? 60 : 15;
    const macroGateMode = opts.macroGateMode ?? "off";
    const enableUpsideFloor = opts.enableUpsideFloor !== false;
    const enableCircuitBreaker = opts.enableCircuitBreaker !== false;

    // HTF candles: use provided or aggregate from candles
    const candlesHtf = opts.candlesHtf && opts.candlesHtf.length > 0
      ? opts.candlesHtf
      : BacktestService.aggregateCandles(candles, targetMinutes);

    const isAuto = opts.spreadThreshold === "auto" || !opts.spreadThreshold;
    let spread = typeof opts.spreadThreshold === "number" && opts.spreadThreshold > 0 ? opts.spreadThreshold : 0.25;

    // Instantiate Causal RollingSpreadCalibrator for 100% lookahead-free walk-forward calibration
    const rollingCal = isAuto
      ? new RollingSpreadCalibrator(symbol, candles, candlesHtf, {
          slBufferPct,
          trailingPullbackPct,
          breakevenFeeBufferPct: opts.breakevenFeeBufferPct,
          tp1Ratio,
          initialCapital,
          supervisorTimeframe: supervisorTf,
          executionTimeframe: timeframe === "15m" ? "15m" : "5m",
          useRatchetSl,
          cushionMode: opts.cushionMode ?? "off",
          costModel: opts.costModel,
          macroGateMode,
          enableUpsideFloor,
          waterfallGuardMode: opts.waterfallGuardMode ?? "combined",
          lookbackBars: 1000,
          tieBreakMarginPct: 0.02,
          defensiveOnLossRegime: true,
        })
      : null;

    if (rollingCal && candles.length > 0) {
      spread = rollingCal.bestSpreadAt(candles.length - 1);
    }

    let currentRollingSpread = spread;
    let rollingSpreadSum = 0;
    let rollingSpreadCount = 0;

    const cm = opts.costModel ?? { feePctPerSide: 0, slippagePctPerFill: 0 };
    const costPerFill = (cm.feePctPerSide + cm.slippagePctPerFill) / 100;
    const intrabarMode = opts.intrabarMode ?? "closeBased";
    const warmup = opts.warmupBars !== undefined ? opts.warmupBars : Math.min(100, Math.floor(candles.length / 4));

    let recentSlTimes: number[] = [];
    let cooldownUntilTs = 0;

    let cash = initialCapital;
    let heldQty = 0;
    let entryPrice = 0;
    let entryIdx = 0;
    let initialSlPrice = 0;
    let stopLossPrice = 0;
    let tp1Filled = false;
    let tp1Price = 0;
    let tp1Time = 0;
    let tp1Qty = 0;
    let activeSide: "LONG" | "SHORT" = "LONG";
    let highestSinceTp1 = 0;
    let highestSinceEntry = 0;
    let lowestSinceTp1 = 0;
    let lowestSinceEntry = 0;
    let activeTradeId = 0;
    let spreadAtEntry = 0;
    let tradeInvest = 0;
    let tradeProceeds = 0;
    let lastCushionApplied = false;
    let rrAtEntry: number | undefined = undefined;
    const tradeMode = opts.tradeMode ?? "dip_hunter";
    const tradeDirection = opts.tradeDirection ?? "long";

    const trades: BacktestTrade[] = [];
    const markers: BacktestMarker[] = [];

    let grossProfit = 0;
    let grossLoss = 0;
    let wins = 0;
    let losses = 0;
    let peakEquity = initialCapital;
    let maxDrawdownPct = 0;

    // Precompute indicators in single pass for fast simulation (or use precomputed)
    const ribbonStates = opts.precomputed?.ribbonStates ?? RibbonEngine.computeAllRibbonStates(candles);
    const exhaustionStates = opts.precomputed?.exhaustionStates ?? ExhaustionEngine.computeAllExhaustion(candles);
    const atrs = opts.precomputed?.atrs ?? calcATR(candles, 14);

    const startIdx = opts.onlyEntryIdx !== undefined ? opts.onlyEntryIdx : warmup;

    // Pre-initialize evaluations array to stay 100% in sync with exact rolling calibrations per candle
    const evaluations: BacktestEvaluationItem[] = opts.onlyEntryIdx !== undefined ? [] : new Array(candles.length);
    if (opts.onlyEntryIdx === undefined) {
      for (let k = 0; k < startIdx; k++) {
        const cK = candles[k]!;
        const ribK = ribbonStates[k]!;
        const exhK = exhaustionStates[k]!;
        const htfK = RegimeSupervisor.evaluateHtfRegime(candlesHtf, supervisorTf, cK.time, tp1Ratio);
        const curAtrK = atrs[k] ?? (cK.close * 0.003);
        const activeSpK = rollingCal ? rollingCal.bestSpreadAt(k) : spread;
        const baseSpK = MaFanCoreRules.computeEffectiveSpread({
          baseSpread: activeSpK,
          useAtrAdaptiveSpread: useAtrAdaptive,
          isAutoCalibrated: isAuto,
          curAtr: curAtrK,
          closePrice: cK.close,
          atrMultiplier,
        });
        evaluations[k] = {
          time: cK.time,
          fanSpreadPct: ribK.fanSpreadPct,
          isFanningDown: ribK.isFanningDown,
          isHookUp: ribK.isHookUp,
          rsi: exhK.rsi,
          rsiSma: exhK.rsiSma,
          isOversoldExhaustion: exhK.isOversoldExhaustion,
          ema4: ribK.ema4,
          ema8: ribK.ema8,
          ema16: ribK.ema16,
          ema25: ribK.ema25,
          ema75: ribK.ema75,
          ema200: ribK.ema200,
          requiredSpreadPct: Number((baseSpK * (htfK.spreadMultiplier ?? 1.0)).toFixed(2)),
          spreadMultiplier: htfK.spreadMultiplier,
        };
      }
    }

    const btcTimeMap = new Map<number, number>();
    if (opts.btcCandles && opts.btcCandles.length > 0) {
      for (let bi = 0; bi < opts.btcCandles.length; bi++) {
        btcTimeMap.set(opts.btcCandles[bi]!.time, bi);
      }
    }

    const btc4h = (opts.btcCandles && opts.btcCandles.length > 0) ? BacktestService.aggregateCandles(opts.btcCandles, 240) : [];
    const btc4hCloses = btc4h.map((c) => c.close);
    const btc4hEma75 = calcEMA(btc4hCloses, 75);

    const btc1d = (opts.btcCandles && opts.btcCandles.length > 0) ? BacktestService.aggregateCandles(opts.btcCandles, 1440) : [];
    const btc1dCloses = btc1d.map((c) => c.close);
    const btc1dEma25 = calcEMA(btc1dCloses, 25);

    function getClosedHtfIdx(arr: Candle[], durationSec: number, targetSec: number) {
      let lo = 0, hi = arr.length - 1, ans = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid].time + durationSec <= targetSec) {
          ans = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      return ans;
    }

    for (let i = startIdx; i < candles.length; i++) {
      const c = candles[i]!;
      const ribbon = ribbonStates[i]!;
      const curAtr = atrs[i] ?? (c.close * 0.003);

      let btc24hReturnPct: number | undefined;
      if (btcTimeMap.size > 0 && opts.btcCandles) {
        const bIdx = btcTimeMap.get(c.time);
        if (bIdx !== undefined && bIdx >= 96) {
          const bClose = opts.btcCandles[bIdx]!.close;
          const bOpen24 = opts.btcCandles[bIdx - 96]!.open;
          if (bOpen24 > 0) {
            btc24hReturnPct = ((bClose - bOpen24) / bOpen24) * 100;
          }
        }
      }

      // Evaluate Higher Timeframe Regime (aligns with Live Bot)
      const htfRegime = RegimeSupervisor.evaluateHtfRegime(candlesHtf, supervisorTf, c.time, tp1Ratio);
      const activeTp1Ratio = Math.max(0.1, Math.min(0.9, htfRegime.recommendedTp1Ratio ?? tp1Ratio));

      // Current portfolio equity
      // Dynamic Rolling Auto-Calibration on every single bar (100% Causal Walk-Forward)
      if (rollingCal) {
        currentRollingSpread = rollingCal.bestSpreadAt(i);
        rollingSpreadSum += currentRollingSpread;
        rollingSpreadCount++;
      }

      const activeBaseSpread = isAuto ? currentRollingSpread : spread;
      const currentSpread = MaFanCoreRules.computeEffectiveSpread({
        baseSpread: activeBaseSpread,
        useAtrAdaptiveSpread: useAtrAdaptive,
        isAutoCalibrated: isAuto,
        curAtr,
        closePrice: c.close,
        atrMultiplier,
      });

      // Apply Higher Timeframe (HTF 15m) Spread Multiplier (aligns with Live Bot)
      const requiredSpread = currentSpread * htfRegime.spreadMultiplier;
      const exhaustion = exhaustionStates[i]!;
      const isCircuitActive = enableCircuitBreaker && c.time < cooldownUntilTs;

      // Populate evaluations unconditionally for EVERY candle so chart lines & inspector never have null holes
      if (opts.onlyEntryIdx === undefined) {
        evaluations[i] = {
          time: c.time,
          fanSpreadPct: ribbon.fanSpreadPct,
          isFanningDown: ribbon.isFanningDown,
          isHookUp: ribbon.isHookUp,
          rsi: exhaustion.rsi,
          rsiSma: exhaustion.rsiSma,
          isOversoldExhaustion: exhaustion.isOversoldExhaustion,
          ema4: ribbon.ema4,
          ema8: ribbon.ema8,
          ema16: ribbon.ema16,
          ema25: ribbon.ema25,
          ema75: ribbon.ema75,
          ema200: ribbon.ema200,
          requiredSpreadPct: Number(requiredSpread.toFixed(2)),
          spreadMultiplier: htfRegime.spreadMultiplier,
          isDeepBear: htfRegime.isDeepBear,
          isMacroBlocked: false,
          isCircuitBreakerActive: isCircuitActive,
        };
      }

      const posVal = heldQty > 0
        ? (activeSide === "LONG"
            ? heldQty * c.close
            : (heldQty * entryPrice) + (heldQty * (entryPrice - c.close)))
        : 0;
      const currentEquity = cash + posVal;
      if (currentEquity > peakEquity) peakEquity = currentEquity;
      const dd = peakEquity > 0 ? ((peakEquity - currentEquity) / peakEquity) * 100 : 0;
      if (dd > maxDrawdownPct) maxDrawdownPct = dd;

      // ─── POSITION EXITS ──────────────────────────────────────────────
      if (heldQty > 0) {
        if (c.high > highestSinceTp1) highestSinceTp1 = c.high;
        if (c.high > highestSinceEntry) highestSinceEntry = c.high;
        if (lowestSinceTp1 === 0 || c.low < lowestSinceTp1) lowestSinceTp1 = c.low;
        if (lowestSinceEntry === 0 || c.low < lowestSinceEntry) lowestSinceEntry = c.low;

        const ei = (opts.exitInfoLag === 1) ? i - 1 : i;
        const ribbonX = ribbonStates[ei]!;
        const prevRibbonX = ei > 0 ? ribbonStates[ei - 1] : undefined;
        const curAtrX = atrs[ei] ?? (candles[ei]!.close * 0.003);
        const exhX = exhaustionStates[ei]!;
        const prevExhX = ei > 0 ? exhaustionStates[ei - 1] : undefined;
        const htfRegimeX = (ei === i)
          ? htfRegime
          : RegimeSupervisor.evaluateHtfRegime(candlesHtf, supervisorTf, candles[ei]!.time, tp1Ratio);
        const activeTp1RatioX = Math.max(0.1, Math.min(0.9, htfRegimeX.recommendedTp1Ratio ?? tp1Ratio));
        const barsHeld = ei - entryIdx;

        // Dynamic Ratchet SL via Universal MaFanCoreRules
        const liftedSl = MaFanCoreRules.evaluateRatchetSl({
          candles,
          currentIndex: ei,
          barsHeld,
          currentSlPrice: stopLossPrice,
          currentPrice: candles[ei]!.close,
          curAtr: curAtrX,
          slBufferPct,
          useRatchetSl,
          positionSide: activeSide,
        });
        if (liftedSl !== null) {
          if (activeSide === "LONG" && liftedSl > stopLossPrice) {
            stopLossPrice = liftedSl;
          } else if (activeSide === "SHORT" && liftedSl < stopLossPrice) {
            stopLossPrice = liftedSl;
          }
        }

        // Evaluate Exits (Priority: TP2 -> SL / Fast Cut -> TP1) via Universal MaFanCoreRules
        const exitDecision = MaFanCoreRules.evaluateExits({
          highPrice: c.high,
          lowPrice: c.low,
          closePrice: c.close,
          entryPrice,
          stopLossPrice,
          tp1Filled,
          highestPriceSinceTp1: highestSinceTp1,
          highestPriceSinceEntry: highestSinceEntry,
          lowestPriceSinceTp1: lowestSinceTp1,
          lowestPriceSinceEntry: lowestSinceEntry,
          positionSide: activeSide,
          ribbon: ribbonX,
          prevRibbon: prevRibbonX,
          exhaustion: exhX,
          prevExhaustion: prevExhX,
          trailingPullbackPct,
          breakevenFeeBufferPct: opts.breakevenFeeBufferPct,
          isOverbought: exhX.isOverboughtExhaustion,
          isOversold: exhX.isOversoldExhaustion,
          barsHeld,
          isHtfBull: !!htfRegimeX.isBullish,
          cushionMode: opts.cushionMode ?? "off",
          cushionThresholdPct: opts.cushionThresholdPct,
          tp1MinProfitPct: opts.tp1MinProfitPct,
          enableFastCut: opts.enableFastCut !== false,
          fastCutThresholdPct: opts.fastCutThresholdPct ?? -0.80,
          stagnationBars: opts.stagnationBars ?? 6,
          tp1TargetMode: opts.tp1TargetMode,
          lockBreakevenAtEma200: opts.lockBreakevenAtEma200,
          maxDisasterSlPct: opts.maxDisasterSlPct,
        });

        if (exitDecision.action === "NONE" && exitDecision.newStopLossPrice) {
          if (activeSide === "LONG" && exitDecision.newStopLossPrice > stopLossPrice) {
            stopLossPrice = exitDecision.newStopLossPrice;
          } else if (activeSide === "SHORT" && exitDecision.newStopLossPrice < stopLossPrice) {
            stopLossPrice = exitDecision.newStopLossPrice;
          }
        }

        // 1. TP2 Exit (Macro Runner / Trailing Stop)
        if (exitDecision.action === "TP2") {
          const exitP = exitDecision.exitPrice;
          const proceeds = activeSide === "LONG"
            ? heldQty * exitP * (1 - costPerFill)
            : (heldQty * entryPrice) + (heldQty * (entryPrice - exitP) * (1 - costPerFill));
          cash += proceeds;
          tradeProceeds += proceeds;

          const totalPnlQuote = tradeProceeds - tradeInvest;
          const tradePnlPct = tradeInvest > 0 ? (totalPnlQuote / tradeInvest) * 100 : 0;
          const costQuote = (tradeInvest * costPerFill) + (tp1Qty * tp1Price * costPerFill) + (heldQty * exitP * costPerFill);

          if (totalPnlQuote >= 0) {
            grossProfit += totalPnlQuote;
            wins++;
          } else {
            grossLoss += Math.abs(totalPnlQuote);
            losses++;
          }

          const tp1PnlCalc = activeSide === "LONG" ? ((tp1Price - entryPrice) / entryPrice) * 100 : ((entryPrice - tp1Price) / entryPrice) * 100;
          const tp2PnlCalc = activeSide === "LONG" ? ((exitP - entryPrice) / entryPrice) * 100 : ((entryPrice - exitP) / entryPrice) * 100;

          trades.push({
            id: activeTradeId,
            subsystem: "SNIPER",
            side: activeSide,
            entryTime: candles[entryIdx]!.time,
            entryPrice,
            stopLossPrice,
            fanSpreadAtEntry: spreadAtEntry,
            tp1Time,
            tp1Price,
            tp1PnlPct: tp1PnlCalc,
            tp2Time: c.time,
            tp2Price: exitP,
            tp2PnlPct: tp2PnlCalc,
            exitTime: c.time,
            exitPrice: exitP,
            exitType: "TP1+TP2",
            pnlQuote: totalPnlQuote,
            pnlPct: tradePnlPct,
            holdingBars: barsHeld,
            cushionApplied: lastCushionApplied,
            costQuote,
            rewardRiskAtEntry: rrAtEntry,
          });

          // TP2 Marker
          markers.push({
            time: c.time,
            position: activeSide === "LONG" ? "aboveBar" : "belowBar",
            color: "#a855f7",
            shape: activeSide === "LONG" ? "arrowDown" : "arrowUp",
            text: `🟣 TP2 #${activeTradeId} (${activeSide}) @ $${exitP.toFixed(2)} (+${tp2PnlCalc.toFixed(2)}%)`,
          });

          heldQty = 0;
          if (opts.onlyEntryIdx !== undefined) break;
          continue;
        }

        // 2. Stop Loss Exit
        if (exitDecision.action === "SL") {
          const exitP = exitDecision.exitPrice;
          const proceeds = activeSide === "LONG"
            ? heldQty * exitP * (1 - costPerFill)
            : (heldQty * entryPrice) + (heldQty * (entryPrice - exitP) * (1 - costPerFill));
          cash += proceeds;
          tradeProceeds += proceeds;

          const isFastCut = exitDecision.reason?.startsWith("Fast Technical Cut") || exitDecision.reason?.startsWith("Fast Stagnation Cut");
          const isRatchet = !tp1Filled && (activeSide === "LONG" ? stopLossPrice > initialSlPrice : stopLossPrice < initialSlPrice);
          const exitType: BacktestTrade["exitType"] = isFastCut ? "TECH_FAST_CUT" : tp1Filled ? "TP1+SL_BE" : isRatchet ? "RATCHET_SL" : "SL";
          const totalPnlQuote = tradeProceeds - tradeInvest;
          const tradePnlPct = tradeInvest > 0 ? (totalPnlQuote / tradeInvest) * 100 : 0;
          const costQuote = (tradeInvest * costPerFill) + (tp1Filled ? tp1Qty * tp1Price * costPerFill : 0) + (heldQty * exitP * costPerFill);

          if (totalPnlQuote >= 0) {
            grossProfit += totalPnlQuote;
            wins++;
          } else {
            grossLoss += Math.abs(totalPnlQuote);
            losses++;
            recentSlTimes.push(c.time);
            if (enableCircuitBreaker) {
              recentSlTimes = recentSlTimes.filter((t) => t >= c.time - 12 * 3600);
              if (recentSlTimes.length >= 2) {
                cooldownUntilTs = c.time + 6 * 3600;
              }
            }
          }

          const tp1PnlCalc = tp1Filled ? (activeSide === "LONG" ? ((tp1Price - entryPrice) / entryPrice) * 100 : ((entryPrice - tp1Price) / entryPrice) * 100) : undefined;
          const slPnlCalc = activeSide === "LONG" ? ((exitP - entryPrice) / entryPrice) * 100 : ((entryPrice - exitP) / entryPrice) * 100;

          trades.push({
            id: activeTradeId,
            subsystem: "SNIPER",
            side: activeSide,
            entryTime: candles[entryIdx]!.time,
            entryPrice,
            stopLossPrice,
            fanSpreadAtEntry: spreadAtEntry,
            tp1Time: tp1Filled ? tp1Time : undefined,
            tp1Price: tp1Filled ? tp1Price : undefined,
            tp1PnlPct: tp1PnlCalc,
            slTime: c.time,
            slPrice: exitP,
            slPnlPct: slPnlCalc,
            exitTime: c.time,
            exitPrice: exitP,
            exitType,
            pnlQuote: totalPnlQuote,
            pnlPct: tradePnlPct,
            holdingBars: barsHeld,
            cushionApplied: lastCushionApplied,
            costQuote,
            rewardRiskAtEntry: rrAtEntry,
          });

          // SL Marker
          const markerColor = exitType === "TP1+SL_BE" ? "#f59e0b" : exitType === "TECH_FAST_CUT" ? "#f43f5e" : exitType === "RATCHET_SL" ? "#f97316" : "#ef4444";
          const markerText = exitType === "TP1+SL_BE"
            ? `🟡 SL BE #${activeTradeId} (${activeSide}) @ $${exitP.toFixed(2)}`
            : exitType === "TECH_FAST_CUT"
            ? `⚡ FAST CUT #${activeTradeId} (${activeSide}) @ $${exitP.toFixed(2)} (${slPnlCalc.toFixed(2)}%)`
            : exitType === "RATCHET_SL"
            ? `🟠 RATCHET SL #${activeTradeId} (${activeSide}) @ $${exitP.toFixed(2)} (${slPnlCalc.toFixed(2)}%)`
            : `🔴 SL #${activeTradeId} (${activeSide}) @ $${exitP.toFixed(2)} (${slPnlCalc.toFixed(2)}%)`;

          markers.push({
            time: c.time,
            position: activeSide === "LONG" ? "belowBar" : "aboveBar",
            color: markerColor,
            shape: activeSide === "LONG" ? "arrowDown" : "arrowUp",
            text: markerText,
          });

          heldQty = 0;
          if (opts.onlyEntryIdx !== undefined) break;
          continue;
        }

        // 3. Take Profit 1 (Mean Reversion at EMA 25 & Trapped Breakeven Rescue)
        if (exitDecision.action === "TP1") {
          tp1Price = exitDecision.exitPrice;
          tp1Time = c.time;
          tp1Qty = heldQty * activeTp1RatioX;
          const tp1Proceeds = activeSide === "LONG"
            ? tp1Qty * tp1Price * (1 - costPerFill)
            : (tp1Qty * entryPrice) + (tp1Qty * (entryPrice - tp1Price) * (1 - costPerFill));
          cash += tp1Proceeds;
          tradeProceeds += tp1Proceeds;
          heldQty -= tp1Qty;
          tp1Filled = true;
          highestSinceTp1 = c.high;
          lowestSinceTp1 = c.low;
          if (exitDecision.cushionApplied) {
            lastCushionApplied = true;
          }
          if (exitDecision.newStopLossPrice) {
            stopLossPrice = activeSide === "LONG"
              ? Math.max(stopLossPrice, exitDecision.newStopLossPrice)
              : Math.min(stopLossPrice, exitDecision.newStopLossPrice);
          }

          const tp1PnlCalc = activeSide === "LONG" ? ((tp1Price - entryPrice) / entryPrice) * 100 : ((entryPrice - tp1Price) / entryPrice) * 100;

          // TP1 Marker
          markers.push({
            time: c.time,
            position: activeSide === "LONG" ? "aboveBar" : "belowBar",
            color: "#38bdf8",
            shape: "circle",
            text: `🔵 TP1 (${(activeTp1RatioX * 100).toFixed(0)}%) #${activeTradeId} (${activeSide}) @ $${tp1Price.toFixed(2)} (+${tp1PnlCalc.toFixed(2)}%)`,
          });

          // Intra-candle Breakeven SL check:
          let hitIntrabarBe = false;
          if (activeSide === "LONG") {
            hitIntrabarBe = intrabarMode === "closeBased" ? c.close <= stopLossPrice : intrabarMode === "pessimistic" ? c.low <= stopLossPrice : false;
          } else {
            hitIntrabarBe = intrabarMode === "closeBased" ? c.close >= stopLossPrice : intrabarMode === "pessimistic" ? c.high >= stopLossPrice : false;
          }

          const isBeTrigger = exitDecision.newStopLossPrice && (activeSide === "LONG" ? exitDecision.newStopLossPrice > entryPrice : exitDecision.newStopLossPrice < entryPrice) && hitIntrabarBe;

          if (isBeTrigger) {
            const exitP = stopLossPrice;
            const beProceeds = activeSide === "LONG"
              ? heldQty * exitP * (1 - costPerFill)
              : (heldQty * entryPrice) + (heldQty * (entryPrice - exitP) * (1 - costPerFill));
            cash += beProceeds;
            tradeProceeds += beProceeds;

            const exitType: BacktestTrade["exitType"] = "TP1+SL_BE";
            const totalPnlQuote = tradeProceeds - tradeInvest;
            const tradePnlPct = tradeInvest > 0 ? (totalPnlQuote / tradeInvest) * 100 : 0;
            const costQuote = (tradeInvest * costPerFill) + (tp1Qty * tp1Price * costPerFill) + (heldQty * exitP * costPerFill);

            if (totalPnlQuote >= 0) {
              grossProfit += totalPnlQuote;
              wins++;
            } else {
              grossLoss += Math.abs(totalPnlQuote);
              losses++;
            }

            const slPnlCalc = activeSide === "LONG" ? ((exitP - entryPrice) / entryPrice) * 100 : ((entryPrice - exitP) / entryPrice) * 100;

            trades.push({
              id: activeTradeId,
              subsystem: "SNIPER",
              side: activeSide,
              entryTime: candles[entryIdx]!.time,
              entryPrice,
              stopLossPrice,
              fanSpreadAtEntry: spreadAtEntry,
              tp1Time,
              tp1Price,
              tp1PnlPct: tp1PnlCalc,
              slTime: c.time,
              slPrice: exitP,
              slPnlPct: slPnlCalc,
              exitTime: c.time,
              exitPrice: exitP,
              exitType,
              pnlQuote: totalPnlQuote,
              pnlPct: tradePnlPct,
              holdingBars: barsHeld,
              cushionApplied: lastCushionApplied,
              costQuote,
              rewardRiskAtEntry: rrAtEntry,
            });

            markers.push({
              time: c.time,
              position: activeSide === "LONG" ? "belowBar" : "aboveBar",
              color: "#f59e0b",
              shape: activeSide === "LONG" ? "arrowDown" : "arrowUp",
              text: `🟡 SL BE #${activeTradeId} (${activeSide}) @ $${exitP.toFixed(2)}`,
            });

            heldQty = 0;
            if (opts.onlyEntryIdx !== undefined) break;
            continue;
          }
        }
      }

      // ─── POSITION ENTRY (MODULAR TWO-WAY ENGINE) ──────────────────────
      let isBtcDowntrend = false;
      if (opts.downtrendSitOutMode && opts.downtrendSitOutMode !== "off" && opts.btcCandles && opts.btcCandles.length > 0) {
        const idx4h = getClosedHtfIdx(btc4h, 14400, c.time);
        const idx1d = getClosedHtfIdx(btc1d, 86400, c.time);
        const pass4h = idx4h >= 75 ? btc4h[idx4h].close >= btc4hEma75[idx4h] : true;
        const pass1d = idx1d >= 25 ? btc1d[idx1d].close >= btc1dEma25[idx1d] : true;

        if (opts.downtrendSitOutMode === "dual") {
          isBtcDowntrend = !pass4h || !pass1d;
        } else if (opts.downtrendSitOutMode === "btc1d") {
          isBtcDowntrend = !pass1d;
        } else if (opts.downtrendSitOutMode === "btc4h") {
          isBtcDowntrend = !pass4h;
        }
      }

      if (heldQty === 0 && cash >= 10) {
        if (opts.onlyEntryIdx !== undefined && i !== opts.onlyEntryIdx) {
          continue;
        }

        if (isBtcDowntrend) {
          if (opts.onlyEntryIdx === undefined && evaluations[i]) {
            evaluations[i]!.isMacroBlocked = true;
          }
          continue; // Sit out 100% in cash!
        }

        const entryDecision = MaFanCoreRules.evaluateModularEntry({
          candles,
          currentIndex: i,
          closePrice: c.close,
          ribbon,
          exhaustion,
          requiredSpreadPct: requiredSpread,
          curAtr,
          slBufferPct,
          minRewardRiskRatio: opts.minRewardRiskRatio,
          waterfallGuardMode: opts.waterfallGuardMode,
          isHtfBull: !!htfRegime.isBullish,
          macroGateMode,
          htfRegime,
          enableUpsideFloor,
          circuitBreakerActive: isCircuitActive,
          maxSlPct: opts.maxSlPct,
          tradeMode,
          tradeDirection,
          minBuyVolRatio12: opts.minBuyVolRatio12,
          maxUpperRibbonSpreadPct: opts.maxUpperRibbonSpreadPct,
          minRelStrengthVsBtc24h: opts.minRelStrengthVsBtc24h,
          btc24hReturnPct,
        });

        if (opts.onlyEntryIdx === undefined && evaluations[i]) {
          evaluations[i]!.isMacroBlocked = entryDecision.blockedBy === "MACRO_GATE";
        }

        if (entryDecision.shouldEnter) {
          activeTradeId++;
          entryIdx = i;
          entryPrice = entryDecision.entryPrice;
          spreadAtEntry = entryDecision.fanSpreadPct;
          initialSlPrice = entryDecision.stopLossPrice;
          stopLossPrice = initialSlPrice;
          rrAtEntry = entryDecision.rewardRisk;
          activeSide = entryDecision.positionSide ?? "LONG";

          const invest = cash * 0.98;
          heldQty = (invest / entryPrice) * (1 - costPerFill);
          tradeInvest = invest;
          tradeProceeds = 0;
          cash -= invest;
          tp1Qty = 0;
          tp1Filled = false;
          highestSinceTp1 = entryPrice;
          highestSinceEntry = c.high;
          lowestSinceTp1 = entryPrice;
          lowestSinceEntry = c.low;
          lastCushionApplied = false;

          // Buy / Short Marker
          const isShort = activeSide === "SHORT";
          const markerColor = isShort ? "#ef4444" : "#10b981";
          const markerShape = isShort ? "arrowDown" : "arrowUp";
          const markerPos = isShort ? "aboveBar" : "belowBar";
          const markerPrefix = isShort
            ? (entryDecision.engineType === "TREND_RIDER_SHORT" ? "📉 TREND SHORT" : "🔴 PEAK SHORT")
            : (entryDecision.engineType === "TREND_RIDER_LONG" ? "📈 TREND LONG" : "🟢 BUY");

          markers.push({
            time: c.time,
            position: markerPos,
            color: markerColor,
            shape: markerShape,
            text: `${markerPrefix} #${activeTradeId} @ $${entryPrice.toFixed(2)} (Spread: ${spreadAtEntry.toFixed(2)}%)`,
          });
        } else if (opts.onlyEntryIdx !== undefined && i === opts.onlyEntryIdx) {
          break;
        }
      }
    }

    // If a position is still open at the end of the simulation, record as OPEN trade
    if (heldQty > 0 && entryIdx >= 0 && candles.length > 0) {
      const lastCandle = candles[candles.length - 1]!;
      const currentPrice = lastCandle.close;
      const unrealizedProceeds = activeSide === "LONG"
        ? heldQty * currentPrice * (1 - costPerFill)
        : (heldQty * entryPrice) + (heldQty * (entryPrice - currentPrice) * (1 - costPerFill));
      const totalPnlQuote = (tradeProceeds + unrealizedProceeds) - tradeInvest;
      const tradePnlPct = tradeInvest > 0 ? (totalPnlQuote / tradeInvest) * 100 : 0;
      const barsHeld = candles.length - 1 - entryIdx;
      const costQuote = (tradeInvest * costPerFill) + (tp1Filled ? tp1Qty * tp1Price * costPerFill : 0) + (heldQty * currentPrice * costPerFill);
      const tp1PnlCalc = tp1Filled ? (activeSide === "LONG" ? ((tp1Price - entryPrice) / entryPrice) * 100 : ((entryPrice - tp1Price) / entryPrice) * 100) : undefined;

      trades.push({
        id: activeTradeId,
        subsystem: "SNIPER",
        side: activeSide,
        entryTime: candles[entryIdx]!.time,
        entryPrice,
        stopLossPrice,
        fanSpreadAtEntry: spreadAtEntry,
        tp1Time: tp1Filled ? tp1Time : undefined,
        tp1Price: tp1Filled ? tp1Price : undefined,
        tp1PnlPct: tp1PnlCalc,
        exitTime: lastCandle.time,
        exitPrice: currentPrice,
        exitType: tp1Filled ? "TP1+OPEN" : "OPEN",
        pnlQuote: totalPnlQuote,
        pnlPct: tradePnlPct,
        holdingBars: barsHeld,
        cushionApplied: lastCushionApplied,
        costQuote,
        rewardRiskAtEntry: rrAtEntry,
      });
    }

    // Performance Summary Calculations
    const lastPrice = candles.length > 0 ? candles[candles.length - 1]!.close : 0;
    const endPositionVal = heldQty > 0
      ? (activeSide === "LONG"
          ? heldQty * lastPrice * (1 - costPerFill)
          : (heldQty * entryPrice) + (heldQty * (entryPrice - lastPrice) * (1 - costPerFill)))
      : 0;
    const finalCapital = cash + endPositionVal;
    const netPnlQuote = finalCapital - initialCapital;
    const netPnlPct = (netPnlQuote / initialCapital) * 100;
    const closedTrades = trades.filter((t) => t.exitType !== "OPEN" && t.exitType !== "TP1+OPEN");
    const totalClosed = closedTrades.length;
    const winRate = totalClosed > 0 ? (wins / totalClosed) * 100 : 0;
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99.9 : 0;
    const avgBarsHeld = trades.length > 0 ? Math.round(trades.reduce((a, b) => a + b.holdingBars, 0) / trades.length) : 0;

    const pnlPcts = trades.map((t) => t.pnlPct);
    const bestTradePct = pnlPcts.length > 0 ? Math.max(...pnlPcts) : 0;
    const worstTradePct = pnlPcts.length > 0 ? Math.min(...pnlPcts) : 0;

    const totalFeesQuote = Number(trades.reduce((sum, t) => sum + (t.costQuote || 0), 0).toFixed(2));
    const grossPnlQuote = Number((netPnlQuote + totalFeesQuote).toFixed(2));

    const summary: BacktestSummary = {
      initialCapital,
      finalCapital: Number(finalCapital.toFixed(2)),
      netPnlQuote: Number(netPnlQuote.toFixed(2)),
      netPnlPct: Number(netPnlPct.toFixed(2)),
      totalTrades: trades.length,
      winTrades: wins,
      lossTrades: losses,
      winRate: Number(winRate.toFixed(1)),
      profitFactor: Number(profitFactor.toFixed(2)),
      maxDrawdownPct: Number(maxDrawdownPct.toFixed(2)),
      avgBarsHeld,
      bestTradePct: Number(bestTradePct.toFixed(2)),
      worstTradePct: Number(worstTradePct.toFixed(2)),
      totalFeesQuote,
      grossPnlQuote,
    };

    const finalEffectiveSpread = isAuto && rollingSpreadCount > 0
      ? Number((rollingSpreadSum / rollingSpreadCount).toFixed(2))
      : spread;

    const finalCandles = (opts.trimWarmupPrefix && warmup > 0) ? candles.slice(warmup) : candles;
    const finalEvaluations = (opts.trimWarmupPrefix && warmup > 0) ? evaluations.slice(warmup) : evaluations;

    const id = `bt_${Date.now()}`;
    const record: BacktestRecord = {
      id,
      createdAt: new Date().toISOString(),
      symbol,
      timeframe,
      candleCount: finalCandles.length,
      spreadThreshold: finalEffectiveSpread,
      isAutoCalibrated: isAuto,
      useRatchetSl,
      macroGateMode,
      enableUpsideFloor,
      enableCircuitBreaker,
      summary,
      trades,
      markers: markers.sort((a, b) => a.time - b.time),
      candles: finalCandles,
      evaluations: finalEvaluations,
    };

    // Save to persistent database
    if (opts.saveToHistory !== false) {
      this.saveRecord(record);
    }

    return record;
  }

  /**
   * Save a backtest record to data/backtest-history.db.json
   */
  public static saveRecord(record: BacktestRecord): void {
    ensureDbFile();
    try {
      const data = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
      if (!Array.isArray(data.records)) data.records = [];

      // For persistent history storage, cap stored candles to latest 3,000 bars
      // to prevent file explosion and V8 string length exhaustion on deep 120-day runs
      let recordToSave = record;
      if (record.candles && record.candles.length > 3000) {
        const trimmedCandles = record.candles.slice(-3000);
        const trimmedEvaluations = record.evaluations ? record.evaluations.slice(-3000) : undefined;
        recordToSave = {
          ...record,
          candles: trimmedCandles,
          evaluations: trimmedEvaluations,
        };
      }

      // Prepend newest run, limit stored history to last 20 runs
      data.records.unshift(recordToSave);
      if (data.records.length > 20) {
        data.records = data.records.slice(0, 20);
      }

      fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), "utf8");
    } catch (err: any) {
      console.warn(`[backtest-service] Could not save backtest record: ${err?.message || err}`);
    }
  }

  /**
   * List all saved backtests (lightweight items without full candle arrays)
   */
  public static getHistoryList(): BacktestHistoryItem[] {
    ensureDbFile();
    try {
      const data = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
      if (!Array.isArray(data.records)) return [];

      return data.records.map((r: BacktestRecord) => ({
        id: r.id,
        createdAt: r.createdAt,
        symbol: r.symbol,
        timeframe: r.timeframe,
        candleCount: r.candleCount,
        spreadThreshold: r.spreadThreshold,
        isAutoCalibrated: r.isAutoCalibrated,
        useRatchetSl: r.useRatchetSl,
        summary: r.summary,
        tradeCount: r.trades?.length || 0,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Get full backtest record by ID
   */
  public static getRecordById(id: string): BacktestRecord | null {
    ensureDbFile();
    try {
      const data = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
      if (!Array.isArray(data.records)) return null;
      return data.records.find((r: BacktestRecord) => r.id === id) || null;
    } catch {
      return null;
    }
  }

  /**
   * Delete a backtest record by ID
   */
  public static deleteRecordById(id: string): boolean {
    ensureDbFile();
    try {
      const data = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
      if (!Array.isArray(data.records)) return false;
      const initialLen = data.records.length;
      data.records = data.records.filter((r: BacktestRecord) => r.id !== id);
      fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), "utf8");
      return data.records.length < initialLen;
    } catch {
      return false;
    }
  }

  /**
   * Scan market pairs and rank by performance metrics
   */
  public static async scanMarket(opts: MarketScanOptions): Promise<MarketScanResultItem[]> {
    const scope = opts.scope || "top20";
    const timeframe = opts.timeframe || "15m";
    const limit = Math.min(60000, Math.max(100, opts.limit || 1000));
    const isAlpaca = scope === "alpaca_stocks" || opts.exchange === "alpaca" || opts.quoteAsset === "USD";

    let candidates: Array<{ symbol: string; quoteVolume: string; count: number }> = [];

    if (isAlpaca) {
      candidates = TOP_US_STOCK_UNIVERSE.map((sym) => ({
        symbol: sym,
        quoteVolume: "10000000",
        count: 10000,
      }));
    } else {
      // 1. Fetch 24h ticker to get liquid symbols
      const tickerRes = await fetch("https://api.binance.com/api/v3/ticker/24hr", {
        headers: { "User-Agent": "dynamic-grid-bn/scanner" },
      });
      if (!tickerRes.ok) {
        throw new Error(`Failed to fetch 24h market ticker from Binance (HTTP ${tickerRes.status})`);
      }

      const tickers = (await tickerRes.json()) as Array<{
        symbol: string;
        quoteVolume: string;
        count: number;
      }>;

      const activeTradingSymbols = await getActiveBinanceTradingSymbols();

      let targetTickers = tickers.filter((t) => {
        const sym = t.symbol.toUpperCase();
        if (activeTradingSymbols.size > 0 && !activeTradingSymbols.has(sym)) return false;
        return Number(t.quoteVolume) > 10_000 && Number(t.count) > 100;
      });

      if (scope === "fdusd") {
        targetTickers = targetTickers.filter((t) => t.symbol.endsWith("FDUSD") && !STABLE_TOKENS.has(t.symbol.slice(0, -5)));
      } else {
        // Default or USDT scopes
        targetTickers = targetTickers.filter((t) => t.symbol.endsWith("USDT") && !STABLE_TOKENS.has(t.symbol.slice(0, -4)));
      }

      // Sort descending by 24h quote volume
      targetTickers.sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume));

      let maxPairs = 20;
      if (scope === "top30") maxPairs = 30;
      else if (scope === "top50") maxPairs = 50;
      else if (scope === "top100" || scope === "all" || scope === "usdt") maxPairs = 100;
      else if (scope === "fdusd") maxPairs = Math.min(50, targetTickers.length);

      candidates = targetTickers.slice(0, maxPairs);
    }

    // Fetch BTC/SPY candles once upfront for Downtrend Defense if enabled
    let btcCandles: Candle[] | undefined = undefined;
    if (opts.downtrendSitOutMode && opts.downtrendSitOutMode !== "off") {
      try {
        const fetchLimit = limit + 1200;
        btcCandles = isAlpaca
          ? await this.fetchAlpacaCandles("SPY", timeframe, fetchLimit)
          : await this.fetchBinanceCandles("BTCUSDT", "5m", fetchLimit);
      } catch (err: any) {
        console.warn(`[MarketScanner] ⚠️ Could not fetch benchmark candles for Macro Defense: ${err?.message}`);
      }
    }

    // 2. Run simulation in concurrent chunks of 3 (gentle pacing to avoid Binance 429)
    const results: MarketScanResultItem[] = [];
    const chunkSize = 3;

    for (let i = 0; i < candidates.length; i += chunkSize) {
      const chunk = candidates.slice(i, i + chunkSize);
      await Promise.all(
        chunk.map(async (cand) => {
          try {
            const sym = cand.symbol;
            const supTf = opts.supervisorTimeframe ?? "15m";
            const isAutoSpread = opts.spreadThreshold === "auto" || !opts.spreadThreshold;
            const warmupPrefixBars = isAutoSpread ? 1200 : 0;
            const fetchLimit = limit + warmupPrefixBars;
            const tfMinutes = timeframe === "1m" ? 1 : timeframe === "5m" ? 5 : timeframe === "15m" ? 15 : 60;
            const htfMinutes = supTf === "1h" ? 60 : 15;
            const htfLimit = Math.max(300, Math.ceil((fetchLimit * tfMinutes) / htfMinutes) + 50);

            const [candles, candlesHtf] = await Promise.all([
              isAlpaca ? this.fetchAlpacaCandles(sym, timeframe, fetchLimit) : this.fetchBinanceCandles(sym, timeframe, fetchLimit),
              isAlpaca ? this.fetchAlpacaCandles(sym, supTf, htfLimit).catch(() => []) : this.fetchBinanceCandles(sym, supTf, htfLimit).catch(() => []),
            ]);
            if (!candles || candles.length < 50) return;
            const actualWarmup = isAutoSpread ? Math.max(0, candles.length - limit) : 0;

            const symCostModel = opts.costModel ?? (
              isAlpaca
                ? { feePctPerSide: 0, slippagePctPerFill: 0.01 }
                : sym.endsWith("FDUSD")
                ? { feePctPerSide: 0, slippagePctPerFill: 0.01 }
                : { feePctPerSide: 0.075, slippagePctPerFill: 0.01 }
            );

            const rec = this.runMaFanSimulation(candles, {
              symbol: sym,
              timeframe,
              btcCandles,
              downtrendSitOutMode: opts.downtrendSitOutMode,
              spreadThreshold: opts.spreadThreshold ?? "auto",
              initialCapital: opts.initialCapital ?? 200,
              slBufferPct: opts.slBufferPct ?? 0.25,
              useRatchetSl: opts.useRatchetSl !== false,
              useAtrAdaptiveSpread: opts.useAtrAdaptiveSpread ?? true,
              atrMultiplier: opts.atrMultiplier ?? 1.25,
              trailingPullbackPct: opts.trailingPullbackPct ?? 0.45,
              tp1Ratio: opts.tp1Ratio ?? 0.5,
              breakevenFeeBufferPct: opts.breakevenFeeBufferPct ?? 0.05,
              supervisorTimeframe: supTf,
              candlesHtf: candlesHtf.length > 0 ? candlesHtf : undefined,
              saveToHistory: false, // Don't pollute persistent history database
              cushionMode: opts.cushionMode ?? "off",
              waterfallGuardMode: opts.waterfallGuardMode ?? "off",
              costModel: symCostModel,
              macroGateMode: opts.macroGateMode ?? "off",
              enableUpsideFloor: opts.enableUpsideFloor !== false,
              enableCircuitBreaker: opts.enableCircuitBreaker !== false,
              enableFastCut: opts.enableFastCut !== false,
              fastCutThresholdPct: opts.fastCutThresholdPct ?? -0.80,
              stagnationBars: opts.stagnationBars ?? 6,
              maxSlPct: opts.maxSlPct ?? 1.80,
              tradeMode: opts.tradeMode ?? "dip_hunter",
              tradeDirection: opts.tradeDirection ?? "long",
              warmupBars: actualWarmup,
              trimWarmupPrefix: isAutoSpread && actualWarmup > 0,
              enableBaseConfirmationFilter: opts.enableBaseConfirmationFilter,
              lockChannelInPosition: opts.lockChannelInPosition,
              capitalZones: opts.capitalZones ?? 2,
              gridCutLossMode: opts.gridCutLossMode ?? "none",
              channelMode: opts.channelMode ?? "DONCHIAN_ATR",
              donchianPeriod: opts.donchianPeriod ?? 48,
              minChannelWidthPct: opts.minChannelWidthPct ?? 2.0,
              maxChannelWidthPct: opts.maxChannelWidthPct ?? 25.0,
              zoneMinDropPct: opts.zoneMinDropPct ?? 2.5,
              zoneStabilizeCandles: opts.zoneStabilizeCandles ?? 3,
            });

            let dna: any = undefined;
            try {
              dna = this.evaluateGridDna(candles, isAlpaca ? "STOCK" : "CRYPTO");
            } catch (err) {}

            let posInChannelPct: number | undefined = undefined;
            let gridStage: string | undefined = undefined;
            if (candles.length >= 48) {
              const last48 = candles.slice(-48);
              const hh48 = Math.max(...last48.map((c) => c.high));
              const ll48 = Math.min(...last48.map((c) => c.low));
              const span48 = hh48 - ll48;
              const lastC = candles[candles.length - 1]!;
              if (span48 > 0) {
                posInChannelPct = Math.round(((lastC.close - ll48) / span48) * 100);
                if (dna && (dna.grade === "AVOID")) {
                  gridStage = "🔴 AVOID";
                } else if (posInChannelPct <= 22) {
                  gridStage = "🟢 โซนซื้อ (Buy L1/L2)";
                } else if (posInChannelPct <= 52) {
                  gridStage = "⏳ รอย่อตัว (Mid-Box)";
                } else {
                  gridStage = "🚀 โซนทำกำไร (Upper TP)";
                }
              }
            }

            results.push({
              rank: 0,
              symbol: sym,
              quoteVolume: Math.round(Number(cand.quoteVolume)),
              candlesCount: candles.length,
              timeframe,
              tradesCount: rec.summary.totalTrades,
              winTrades: rec.summary.winTrades,
              lossTrades: rec.summary.lossTrades,
              winRate: rec.summary.winRate,
              netPnlPct: rec.summary.netPnlPct,
              netPnlQuote: rec.summary.netPnlQuote,
              profitFactor: rec.summary.profitFactor,
              maxDrawdownPct: rec.summary.maxDrawdownPct,
              avgBarsHeld: rec.summary.avgBarsHeld,
              bestTradePct: rec.summary.bestTradePct,
              worstTradePct: rec.summary.worstTradePct,
              spreadThreshold: rec.spreadThreshold,
              dnaScore: dna?.dnaScore,
              dnaGrade: dna?.grade,
              bounce52Rate: dna?.bounce52Rate,
              dipWickPct: dna?.dipWickPct,
              span48Pct: dna?.span48Pct,
              er48: dna?.er48,
              upDownSymmetry: dna?.upDownSymmetry,
              posInChannelPct,
              gridStage,
              recentDnaScore: dna?.recentDnaScore,
              baselineDnaScore: dna?.baselineDnaScore,
              trendRegime: dna?.trendRegime,
              trendLabel: dna?.trendLabel,
              trendScore: dna?.trendScore,
            });

            console.log(`[MarketScanner] [${results.length}/${candidates.length}] ✅ ${sym}: Net PnL ${(rec.summary.netPnlPct >= 0 ? '+' : '')}${rec.summary.netPnlPct.toFixed(2)}% (${rec.summary.totalTrades} trades, WR ${rec.summary.winRate.toFixed(1)}%)`);
            opts.onProgress?.({
              index: results.length,
              total: candidates.length,
              symbol: sym,
              candlesCount: candles.length,
              pnlPct: rec.summary.netPnlPct,
              winRate: rec.summary.winRate,
              tradesCount: rec.summary.totalTrades,
            });
          } catch (err: any) {
            console.warn(`[MarketScanner] ⚠️ Error scanning ${cand.symbol}:`, err?.message || err);
          }
        })
      );
      if (i + chunkSize < candidates.length) {
        await new Promise((r) => setTimeout(r, 60));
      }
    }

    // 3. Sort by Net PnL % descending, then assign rank
    results.sort((a, b) => b.netPnlPct - a.netPnlPct);
    results.forEach((item, idx) => {
      item.rank = idx + 1;
    });

    // 4. Persist latest market scan to database
    this.saveLatestScan({
      timestamp: Date.now(),
      options: opts,
      results,
    });

    return results;
  }

  /**
   * Scan current market candles to detect real-time MA-Fan setups ("ตัวพร้อมเล่น")
   * Focuses on Bottom Fan Exhaustion and Reversal Inflection points.
   */
  public static async scanMaFanSetups(opts: MarketScanOptions): Promise<MaFanLiveSetupItem[]> {
    const scope = opts.scope || "top20";
    const timeframe = opts.timeframe || "5m";
    const isAlpaca = scope === "alpaca_stocks" || opts.exchange === "alpaca" || opts.quoteAsset === "USD";

    let candidates: Array<{ symbol: string; quoteVolume: string; count: number }> = [];

    if (isAlpaca) {
      candidates = TOP_US_STOCK_UNIVERSE.map((sym) => ({
        symbol: sym,
        quoteVolume: "10000000",
        count: 10000,
      }));
    } else {
      const tickerRes = await fetch("https://api.binance.com/api/v3/ticker/24hr", {
        headers: { "User-Agent": "dynamic-grid-bn/scanner" },
      });
      if (!tickerRes.ok) {
        throw new Error(`Failed to fetch 24h market ticker from Binance (HTTP ${tickerRes.status})`);
      }

      const tickers = (await tickerRes.json()) as Array<{
        symbol: string;
        quoteVolume: string;
        count: number;
      }>;

      const activeTradingSymbols = await getActiveBinanceTradingSymbols();

      let targetTickers = tickers.filter((t) => {
        const sym = t.symbol.toUpperCase();
        if (activeTradingSymbols.size > 0 && !activeTradingSymbols.has(sym)) return false;
        return Number(t.quoteVolume) > 10_000 && Number(t.count) > 100;
      });

      if (scope === "fdusd") {
        targetTickers = targetTickers.filter((t) => t.symbol.endsWith("FDUSD") && !STABLE_TOKENS.has(t.symbol.slice(0, -5)));
      } else {
        targetTickers = targetTickers.filter((t) => t.symbol.endsWith("USDT") && !STABLE_TOKENS.has(t.symbol.slice(0, -4)));
      }

      targetTickers.sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume));

      let maxPairs = 20;
      if (scope === "top30") maxPairs = 30;
      else if (scope === "top50") maxPairs = 50;
      else if (scope === "top100" || scope === "all" || scope === "usdt") maxPairs = 100;
      else if (scope === "fdusd") maxPairs = Math.min(50, targetTickers.length);

      candidates = targetTickers.slice(0, maxPairs);
    }

    // Macro gate check (SPY vs BTC)
    let isMacroBear = false;
    if (opts.downtrendSitOutMode && opts.downtrendSitOutMode !== "off") {
      try {
        const macroCandles = isAlpaca
          ? await this.fetchAlpacaCandles("SPY", "1h", 250)
          : await this.fetchBinanceCandles("BTCUSDT", "1h", 250);
        if (macroCandles && macroCandles.length >= 200) {
          const mCloses = macroCandles.map((c) => c.close);
          const ema200 = calcEMA(mCloses, 200);
          const lastC = mCloses[mCloses.length - 1];
          const lastEma = ema200[ema200.length - 1];
          if (lastC < lastEma) {
            isMacroBear = true;
          }
        }
      } catch (err: any) {
        console.warn(`[MaFanScanner] Macro benchmark check warning: ${err?.message}`);
      }
    }

    const setupItems: MaFanLiveSetupItem[] = [];
    const chunkSize = 4;
    const fetchLimit = 250; // 250 bars is sufficient to accurately compute EMA 200, RSI 14, MACD

    for (let i = 0; i < candidates.length; i += chunkSize) {
      const chunk = candidates.slice(i, i + chunkSize);
      await Promise.all(
        chunk.map(async (cand) => {
          try {
            const sym = cand.symbol;
            const candles = isAlpaca
              ? await this.fetchAlpacaCandles(sym, timeframe, fetchLimit)
              : await this.fetchBinanceCandles(sym, timeframe, fetchLimit);

            if (!candles || candles.length < 50) return;

            const closes = candles.map((c) => c.close);
            const ema4 = calcEMA(closes, 4);
            const ema8 = calcEMA(closes, 8);
            const ema16 = calcEMA(closes, 16);
            const ema25 = calcEMA(closes, 25);
            const ema75 = calcEMA(closes, 75);
            const ema200 = calcEMA(closes, 200);
            const rsiList = calcRSI(candles, 14);
            const macdObj = calcMACD(candles, 12, 26, 9);

            const n = closes.length - 1;
            const lastPrice = closes[n];
            const e4 = ema4[n];
            const e8 = ema8[n];
            const e16 = ema16[n];
            const e25 = ema25[n];
            const e75 = ema75[n];
            const e200 = ema200[n];

            const prev4 = ema4[n - 1] ?? e4;
            const prev8 = ema8[n - 1] ?? e8;
            const prev16 = ema16[n - 1] ?? e16;

            const fanSpreadPct = ((e4 - e25) / e25) * 100;
            const curRsi = rsiList[n] ?? 50;
            const prevRsi = rsiList[n - 1] ?? 50;
            const prevRsi2 = rsiList[n - 2] ?? 50;

            // Track recent 15 bars for bottom fan condition
            let hadBottomFanRecently = false;
            let minSpreadRecentPct = 0;
            for (let idx = Math.max(0, n - 15); idx <= n; idx++) {
              const sp = ((ema4[idx] - ema25[idx]) / ema25[idx]) * 100;
              if (sp < minSpreadRecentPct) minSpreadRecentPct = sp;
              if (ema4[idx] < ema8[idx] && ema8[idx] < ema16[idx] && ema16[idx] < ema25[idx]) {
                hadBottomFanRecently = true;
              }
            }

            // Reversal triggers
            const is8Cross16Up = prev8 <= prev16 && e8 > e16;
            const is4Cross8Up = prev4 <= prev8 && e4 > e8;
            const isPriceAbove8 = lastPrice > e8;
            const isPriceAbove16 = lastPrice > e16;
            const isPriceAbove25 = lastPrice > e25;
            const isRsiHook = curRsi > prevRsi && (prevRsi < 42 || prevRsi2 < 38);
            const curHist = macdObj.hist[n] ?? 0;
            const prevHist = macdObj.hist[n - 1] ?? 0;
            const isMacdHistUp = curHist > prevHist;

            const triggers: string[] = [];
            if (is8Cross16Up) triggers.push("EMA 8x16 Cross ⭐");
            else if (is4Cross8Up) triggers.push("EMA 4x8 Hook");
            if (isPriceAbove16) triggers.push("Price > EMA16");
            else if (isPriceAbove8) triggers.push("Price > EMA8");
            if (isRsiHook) triggers.push(`RSI Hook ${curRsi.toFixed(0)}`);
            if (isMacdHistUp) triggers.push("MACD +Hist");
            if (minSpreadRecentPct <= -0.20) triggers.push(`Spread ${minSpreadRecentPct.toFixed(2)}%`);

            let stage: MaFanStage = "NEUTRAL";
            let stageLabel = "⚪ ปกติ (Neutral)";
            let stageBadgeColor = "#64748b";
            let readyScore = 30;

            const isBottomExhaustion =
              hadBottomFanRecently || minSpreadRecentPct <= -0.15 || (e4 < e8 && e8 < e16 && e16 < e25);

            if (
              isBottomExhaustion &&
              (is8Cross16Up ||
                (is4Cross8Up && isPriceAbove16) ||
                (e8 > e16 && isPriceAbove16 && minSpreadRecentPct <= -0.12))
            ) {
              stage = "READY_BUY";
              stageLabel = "🔥 พร้อมเข้าเล่น (Bottom Fan Reversal)";
              stageBadgeColor = "#10b981";
              readyScore = 80;
            } else if (hadBottomFanRecently && e8 > e16 && lastPrice >= e16 * 0.997 && lastPrice <= e8 * 1.003) {
              stage = "DIP_RETEST";
              stageLabel = "⏳ รอย่อตัว (Dip Re-test)";
              stageBadgeColor = "#f59e0b";
              readyScore = 72;
            } else if (e4 < e8 && e8 < e16 && e16 < e25 && fanSpreadPct <= -0.18) {
              stage = "WATCHING_BOTTOM";
              stageLabel = "👀 เฝ้าระวังพัดกางล่าง (Bottom Exhaustion)";
              stageBadgeColor = "#06b6d4";
              readyScore = 55;
            } else if (e4 > e8 && e8 > e16 && e16 > e25 && e25 > e75) {
              stage = "BULLISH_TREND";
              stageLabel = "🚀 พัดกางบน (Bullish Fan Trend)";
              stageBadgeColor = "#8b5cf6";
              readyScore = 65;
            }

            // Score adjustments
            if (is8Cross16Up) readyScore += 10;
            if (isPriceAbove16) readyScore += 5;
            if (isRsiHook) readyScore += 5;
            if (isMacdHistUp) readyScore += 5;
            if (!isMacroBear) readyScore += 5;
            readyScore = Math.min(100, Math.max(0, readyScore));

            // Upside targets (TP1: EMA25, TP2: EMA75, TP3: EMA200)
            const upsideTp1Pct = ((e25 - lastPrice) / lastPrice) * 100;
            const upsideTp2Pct = ((e75 - lastPrice) / lastPrice) * 100;
            const upsideTp3Pct = ((e200 - lastPrice) / lastPrice) * 100;

            setupItems.push({
              rank: 0,
              symbol: sym,
              stage,
              stageLabel,
              stageBadgeColor,
              readyScore,
              lastPrice,
              fanSpreadPct,
              minSpreadRecentPct,
              rsi: curRsi,
              reversalTriggers: triggers,
              upsideTp1Pct,
              upsideTp2Pct,
              upsideTp3Pct,
              quoteVolume: Math.round(Number(cand.quoteVolume)),
              timeframe,
            });

            opts.onProgress?.({
              index: setupItems.length,
              total: candidates.length,
              symbol: sym,
              candlesCount: candles.length,
              pnlPct: readyScore,
              winRate: readyScore,
              tradesCount: triggers.length,
            });
          } catch (err: any) {
            console.warn(`[MaFanScanner] ⚠️ Error scanning ${cand.symbol}:`, err?.message || err);
          }
        })
      );
      if (i + chunkSize < candidates.length) {
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    // Sort priority: READY_BUY > DIP_RETEST > WATCHING_BOTTOM > BULLISH_TREND > NEUTRAL, then readyScore desc
    const stagePriority: Record<MaFanStage, number> = {
      READY_BUY: 5,
      DIP_RETEST: 4,
      WATCHING_BOTTOM: 3,
      BULLISH_TREND: 2,
      NEUTRAL: 1,
    };

    setupItems.sort((a, b) => {
      const pA = stagePriority[a.stage] || 0;
      const pB = stagePriority[b.stage] || 0;
      if (pB !== pA) return pB - pA;
      if (b.readyScore !== a.readyScore) return b.readyScore - a.readyScore;
      return b.quoteVolume - a.quoteVolume;
    });

    setupItems.forEach((item, idx) => {
      item.rank = idx + 1;
    });

    // Save latest setup scan to database
    this.saveLatestScan({
      timestamp: Date.now(),
      options: opts,
      results: [],
      setupResults: setupItems,
    });

    return setupItems;
  }

  public static saveLatestScan(data: MarketScanPersistence): void {
    try {
      const dir = path.dirname(SCAN_DB_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(SCAN_DB_PATH, JSON.stringify(data, null, 2), "utf8");
    } catch (err: any) {
      console.error(`[backtest-service] Failed to save market scan: ${err.message}`);
    }
  }

  public static getLatestScan(): MarketScanPersistence | null {
    try {
      if (!fs.existsSync(SCAN_DB_PATH)) return null;
      const raw = fs.readFileSync(SCAN_DB_PATH, "utf8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /**
   * Fetch historical candles for Top N liquid pairs in FDUSD, USDT, or Alpaca USD universe
   */
  public static async fetchTopUniverseCandles(opts: {
    quoteAsset: "FDUSD" | "USDT" | "USD";
    timeframe?: string;
    maxPairs?: number;
    limit?: number;
    customWhitelist?: string[];
    blacklist?: string[];
    onProgress?: (p: { completed: number; total: number; currentSymbol: string; message: string }) => void;
  }): Promise<Map<string, Candle[]>> {
    const quote = opts.quoteAsset;
    const isAlpaca = quote === "USD";
    const tf = opts.timeframe || "15m";
    const maxPairs = Math.max(5, Math.min(100, opts.maxPairs ?? 50));
    const candlesLimit = Math.max(500, (opts.limit ?? 2000) + 400);
    const blacklistSet = new Set((opts.blacklist ?? []).map((s) => s.toUpperCase().trim()));

    let targetSymbols: string[] = [];

    if (isAlpaca) {
      if (Array.isArray(opts.customWhitelist) && opts.customWhitelist.length > 0) {
        targetSymbols = opts.customWhitelist
          .map((s) => s.toUpperCase().trim().replace(/USD$/, ""))
          .filter((s) => !blacklistSet.has(s))
          .slice(0, maxPairs);
      } else {
        targetSymbols = TOP_US_STOCK_UNIVERSE
          .filter((s) => !blacklistSet.has(s))
          .slice(0, maxPairs);
      }
    } else if (Array.isArray(opts.customWhitelist) && opts.customWhitelist.length > 0) {
      targetSymbols = opts.customWhitelist
        .map((s) => s.toUpperCase().trim())
        .filter((s) => s.endsWith(quote) && !blacklistSet.has(s))
        .slice(0, maxPairs);
    } else {
      this.rotationBtProgress = { phase: "fetching_tickers", completed: 0, total: 0, currentSymbol: "", message: `Fetching 24h ticker for ${quote} universe...` };
      opts.onProgress?.(this.rotationBtProgress);

      const tickerRes = await fetch("https://api.binance.com/api/v3/ticker/24hr", {
        headers: { "User-Agent": "dynamic-grid-bn/rotation-backtest" },
      });
      if (!tickerRes.ok) throw new Error(`Failed to fetch 24h market ticker (HTTP ${tickerRes.status})`);

      const tickers = (await tickerRes.json()) as Array<{ symbol: string; quoteVolume: string; count: number }>;
      const minVol = quote === "FDUSD" ? 500_000 : 2_000_000;
      const activeTradingSymbols = await getActiveBinanceTradingSymbols();

      let filtered = tickers.filter((t) => {
        const sym = t.symbol.toUpperCase();
        if (activeTradingSymbols.size > 0 && !activeTradingSymbols.has(sym)) return false;
        if (!sym.endsWith(quote)) return false;
        const base = sym.slice(0, -quote.length);
        if (STABLE_TOKENS.has(base)) return false;
        if (blacklistSet.has(sym)) return false;
        if (isSyntheticOrStock(sym)) return false;
        if (Number(t.quoteVolume) < minVol) return false;
        return true;
      });

      filtered.sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume));
      targetSymbols = filtered.slice(0, maxPairs).map((t) => t.symbol);
    }

    if (targetSymbols.length === 0) {
      throw new Error(`No eligible pairs found for ${quote} universe (check volume threshold or whitelist)`);
    }

    const universeMap = new Map<string, Candle[]>();
    const total = targetSymbols.length;
    let completed = 0;
    const chunkSize = 4;

    for (let i = 0; i < targetSymbols.length; i += chunkSize) {
      const chunk = targetSymbols.slice(i, i + chunkSize);
      await Promise.all(
        chunk.map(async (sym) => {
          try {
            this.rotationBtProgress = {
              phase: "fetching_candles",
              completed,
              total,
              currentSymbol: sym,
              message: `Loading candles for ${sym} (${completed + 1}/${total})...`,
            };
            opts.onProgress?.(this.rotationBtProgress);

            const candles = isAlpaca
              ? await this.fetchAlpacaCandles(sym, tf, candlesLimit)
              : await this.fetchBinanceCandles(sym, tf, candlesLimit);
            if (candles && candles.length >= 100) {
              universeMap.set(sym, candles);
            }
          } catch (err: any) {
            console.warn(`[RotationBacktest] ⚠️ Failed to fetch candles for ${sym}: ${err.message}`);
          } finally {
            completed++;
          }
        })
      );
      await new Promise((r) => setTimeout(r, 80));
    }

    console.log(`[RotationBacktest] 🌐 Universe candles loaded: ${universeMap.size}/${targetSymbols.length} pairs ready for ${quote}`);
    return universeMap;
  }

  /**
   * Evaluate the 3-Layer Dynamic DNA & Live Trend Funnel Point-in-Time at a specific timestamp in history.
   * Completely eliminates look-ahead bias by only evaluating candles up to targetTime (Zero Look-Ahead).
   */
  public static evaluateHistoricalFunnelAtTime(opts: {
    targetTime: number;
    universeCandles: Map<string, Candle[]>;
    activeSymbol?: string;
    quoteAsset: "FDUSD" | "USDT" | "USD";
    gridOpts?: any;
  }): Array<{
    symbol: string;
    compositeScore: number;
    dnaGrade: "S" | "A" | "B" | "AVOID";
    dnaScore: number;
    recentDnaScore: number;
    trendRegime: "BULL_UPTREND" | "ACCUMULATION_RANGE" | "BEAR_DOWNTREND";
    trendLabel: string;
    simScore: number;
    structureScore: number;
    positionScore: number;
    liquidityScore: number;
    netPnlPct: number;
    winRate: number;
    range24hPct: number;
    quoteVol24h: number;
    posRatio: number;
    isDipPullback: boolean;
  }> {
    const { targetTime, universeCandles, activeSymbol, quoteAsset, gridOpts } = opts;
    const isAlpaca = quoteAsset === "USD";

    const SYNTHETIC_BLACKLIST = new Set([
      "RWUSDUSDT", "UUSDT", "XAUTUSDT", "USDCUSDT", "FDUSDUSDT", "TUSDUSDT",
      "牛来USDT", "CRCLBUSDT", "SNDKBUSDT", "SPCXBUSDT", "BEAMXUSDT", "BFUSDUSDT", "USDEUSDT"
    ]);

    const calcEmaLocal = (candles: Candle[], endIdx: number, period: number): number => {
      const start = Math.max(0, endIdx - period * 3);
      let ema = candles[start].close;
      const k = 2 / (period + 1);
      for (let i = start + 1; i <= endIdx; i++) {
        ema = candles[i].close * k + ema * (1 - k);
      }
      return ema;
    };

    // 🛡️ 1. Point-in-Time Market Breadth (% of Top Universe pairs above 5h EMA60):
    let aboveEma60Count = 0;
    let totalBreadthPairs = 0;
    const maxStaleSec = isAlpaca ? 86400 * 5 : 3600;

    for (const [sym, candles] of universeCandles.entries()) {
      if (isAlpaca) {
        if (sym === "SPY" || !candles || candles.length < 50) continue;
      } else {
        if (sym.startsWith("BTC") || SYNTHETIC_BLACKLIST.has(sym) || isSyntheticOrStock(sym) || !candles || candles.length < 50) continue;
      }
      let low = 0;
      let high = candles.length - 1;
      let idx = -1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (candles[mid].time <= targetTime) {
          idx = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      if (idx >= 20 && targetTime - candles[idx].time <= maxStaleSec) {
        totalBreadthPairs++;
        const curClose = candles[idx].close;
        const ema60 = calcEmaLocal(candles, idx, 60);
        if (curClose > ema60) aboveEma60Count++;
      }
    }
    const marketBreadthPct = totalBreadthPairs > 0 ? (aboveEma60Count / totalBreadthPairs) * 100 : 50;

    // 🛡️ 2. Calculate BTC/SPY 24h Return and check Macro Gate:
    let btcChange24hPct = 0;
    const btcCandles = isAlpaca
      ? (universeCandles.get("SPY") || universeCandles.get("SPYUSD"))
      : (universeCandles.get(`BTC${quoteAsset}`) || universeCandles.get("BTCUSDT"));
    const btcMinBars = isAlpaca ? 50 : 60;

    if (btcCandles && btcCandles.length >= btcMinBars) {
      let low = 0;
      let high = btcCandles.length - 1;
      let bIdx = -1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (btcCandles[mid].time <= targetTime) {
          bIdx = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      if (bIdx >= btcMinBars - 1) {
        const btcClose = btcCandles[bIdx].close;
        const btcIntervalSec = btcCandles.length >= 2 ? (btcCandles[1].time - btcCandles[0].time) : 900;
        const btcBars24h = Math.max(16, Math.min(bIdx, Math.round(86400 / btcIntervalSec)));
        const btcOpen24h = btcCandles[bIdx - btcBars24h].open;
        if (btcOpen24h > 0) {
          btcChange24hPct = ((btcClose - btcOpen24h) / btcOpen24h) * 100;
        }

        if (gridOpts?.enableBtcMacroGate !== false) {
          // A. Market-wide Breadth Dump Guard: If < 25-35% of pairs are above 5h EMA, sit out in 100% Cash!
          if (totalBreadthPairs >= 5 && marketBreadthPct < (isAlpaca ? 25 : 35)) {
            return [];
          }

          // B. Bitcoin / S&P 500 Macro Gate:
          const sliceBtc = btcCandles.slice(Math.max(0, bIdx - btcBars24h), bIdx + 1);
          const smaBtc = sliceBtc.reduce((s: number, c: Candle) => s + c.close, 0) / sliceBtc.length;
          const btcBars4h = Math.max(4, Math.round(14400 / btcIntervalSec));
          const btcOpen4h = btcCandles[Math.max(0, bIdx - btcBars4h)].open;
          const ret4hPct = ((btcClose - btcOpen4h) / btcOpen4h) * 100;

          const smaFactor = isAlpaca ? 0.985 : 0.990;
          const retFactor = isAlpaca ? -2.5 : -1.5;
          if (btcClose < smaBtc * smaFactor || ret4hPct < retFactor) {
            return []; // Macro breakdown: zero candidates allowed -> stay in Cash!
          }
        }
      }
    }

    const minVol = isAlpaca ? 0 : (quoteAsset === "FDUSD" ? 250_000 : 500_000);
    const scoredCandidates: Array<{
      symbol: string;
      compositeScore: number;
      dnaGrade: "S" | "A" | "B" | "AVOID";
      dnaScore: number;
      recentDnaScore: number;
      trendRegime: "BULL_UPTREND" | "ACCUMULATION_RANGE" | "BEAR_DOWNTREND";
      trendLabel: string;
      simScore: number;
      structureScore: number;
      positionScore: number;
      liquidityScore: number;
      netPnlPct: number;
      winRate: number;
      range24hPct: number;
      quoteVol24h: number;
      posRatio: number;
      isDipPullback: boolean;
    }> = [];

    const symCostModel = isAlpaca
      ? { feePctPerSide: 0, slippagePctPerFill: 0.01 }
      : (quoteAsset === "FDUSD"
          ? { feePctPerSide: 0, slippagePctPerFill: 0.01 }
          : { feePctPerSide: 0.075, slippagePctPerFill: 0.01 });

    // Stage 1 & 2: Point-in-Time Rolling DNA + Live Trend Funnel
    for (const [sym, candles] of universeCandles.entries()) {
      if (!candles || candles.length < 50) continue;
      if (!isAlpaca && (SYNTHETIC_BLACKLIST.has(sym) || isSyntheticOrStock(sym))) continue;

      let low = 0;
      let high = candles.length - 1;
      let idx = -1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (candles[mid].time <= targetTime) {
          idx = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }

      if (idx < 40) continue;

      // Stale candle check: candle time should be within maxStaleSec of targetTime
      if (targetTime - candles[idx].time > maxStaleSec) continue;

      const candleIntervalSec = candles.length >= 2 ? (candles[1].time - candles[0].time) : 900;
      const bars24h = Math.max(16, Math.min(idx, Math.round(86400 / candleIntervalSec)));
      const slice24h = candles.slice(idx - bars24h, idx + 1);
      let high24h = -Infinity;
      let low24h = Infinity;
      let quoteVol24h = 0;

      for (const c of slice24h) {
        if (c.high > high24h) high24h = c.high;
        if (c.low < low24h) low24h = c.low;
        quoteVol24h += c.volume * c.close;
      }

      if (low24h <= 0 || high24h <= low24h) continue;

      const open24h = slice24h[0].open;
      const lastPrice = slice24h[slice24h.length - 1].close;
      const range24hPct = ((high24h - low24h) / low24h) * 100;
      const change24hPct = open24h > 0 ? ((lastPrice - open24h) / open24h) * 100 : 0;
      const posRatio = (lastPrice - low24h) / (high24h - low24h);

      const bars4h = Math.max(4, Math.round(14400 / candleIntervalSec));
      const open4h = slice24h[Math.max(0, slice24h.length - bars4h)]?.open ?? open24h;
      const return4hPct = open4h > 0 ? ((lastPrice - open4h) / open4h) * 100 : 0;

      if (quoteVol24h < minVol && sym !== activeSymbol) continue;
      const minRange = isAlpaca ? 0.2 : 2.0;
      const maxRange = isAlpaca ? 30.0 : 35.0;
      if ((range24hPct < minRange || range24hPct > maxRange) && sym !== activeSymbol) continue;

      const defaultMaxPos = isAlpaca ? 0.65 : 0.38;
      const maxAllowedPos = gridOpts?.gridMaxChannelPos !== undefined ? Number(gridOpts.gridMaxChannelPos) : defaultMaxPos;
      if (sym !== activeSymbol) {
        if (posRatio < 0.05 || (posRatio > maxAllowedPos && (!isAlpaca || posRatio > 0.65))) continue;
        if (return4hPct < (isAlpaca ? -2.0 : -1.0)) continue;
      }

      // 🧬 1. Point-in-Time Rolling DNA Evaluation (Zero Look-Ahead)
      const evalCandles = candles.slice(Math.max(0, idx - 999), idx + 1);
      const dna = this.evaluateGridDna(evalCandles, isAlpaca ? "STOCK" : "CRYPTO");

      if (sym !== activeSymbol) {
        // Hard Gate: Reject AVOID or Degrading assets
        if (dna.grade === "AVOID" || dna.isDegrading) continue;
        // Hard Gate: Reject confirmed bear downtrend
        if (dna.trendRegime === "BEAR_DOWNTREND") continue;
        // Strict Grade Gate: S or A (or solid B with score >= 58)
        if (dna.grade !== "S" && dna.grade !== "A" && !(dna.grade === "B" && dna.dnaScore >= 58)) continue;
      }

      // 2. Production Dynamic Grid Simulation with MASTER_PLAN_GRID_CONFIG (Core v14.0)
      const simRes = this.runDynamicGridSimulation(evalCandles, {
        symbol: sym,
        timeframe: gridOpts?.timeframe || (candleIntervalSec >= 900 ? "15m" : "5m"),
        initialCapital: 200,
        maxInventoryQuote: 200,
        channelMode: "DONCHIAN_ATR",
        donchianPeriod: 48,
        minChannelWidthPct: 2.0,
        maxChannelWidthPct: 25.0,
        lockChannelInPosition: true,
        regimeFilterMode: "UPTREND_AND_SIDEWAY",
        buyLevelPcts: [20, 12],
        buyWeights: [55, 45],
        sellLevelPcts: [52, 72],
        capitalZones: 1,
        zoneMinDropPct: 2.5,
        floorBufferPct: 0.6,
        gridCutLossMode: "entry_floor",
        enableGridTrailingStop: true,
        costModel: symCostModel,
        saveToHistory: false,
      });

      const summary = simRes.summary;

      // ── 3-Layer Composite Scoring (Total 100) ──
      // Layer 1: Market DNA Points (up to 40 pts, weighted by 60% recent form + 40% baseline)
      const dnaPoints = Math.round(dna.dnaScore * 0.40);

      // Layer 2: Forward Trend & Relative Strength (up to 35 pts)
      let trendScore = 0;
      if (dna.trendRegime === "BULL_UPTREND") {
        trendScore = 20;
      } else if (dna.trendRegime === "ACCUMULATION_RANGE") {
        trendScore = 12;
      } else {
        trendScore = 0;
      }

      const relativeStrengthPct = change24hPct - btcChange24hPct;
      if (relativeStrengthPct >= 0.5 && change24hPct <= 12.0) {
        trendScore += 7;
      } else if (relativeStrengthPct >= -1.0) {
        trendScore += 3;
      }

      if (summary.netPnlPct > 0 && summary.winRate >= 70) {
        trendScore += 8;
      } else if (summary.netPnlPct > 0) {
        trendScore += 4;
      }
      trendScore = Math.min(35, trendScore);

      // Layer 3: Tactical Pullback Entry Position (up to 20 pts) + Liquidity (up to 5 pts)
      let positionScore = 0;
      if (posRatio >= 0.10 && posRatio <= 0.38) {
        positionScore = 20; // Prime bottom pullback accumulation
      } else if (posRatio > 0.38 && posRatio <= 0.55) {
        positionScore = 12;
      } else if (posRatio < 0.10) {
        positionScore = 6;
      } else {
        positionScore = 2;
      }

      const liquidityScore = Math.min(5, Math.max(0, (Math.log10(quoteVol24h) - 5.5) * 2));

      // Penalties for lower quality/degradation
      let penalty = 0;
      if (dna.grade === "AVOID" || dna.trendRegime === "BEAR_DOWNTREND") penalty = -40;
      else if (dna.grade === "B") penalty = -10;
      else if (dna.isDegrading) penalty = -15;

      const compositeScore = Math.max(0, Math.min(100, dnaPoints + trendScore + positionScore + liquidityScore + penalty));

      const isDipPullback = posRatio >= 0.10 && posRatio <= 0.55;

      scoredCandidates.push({
        symbol: sym,
        compositeScore,
        dnaGrade: dna.grade,
        dnaScore: dna.dnaScore,
        recentDnaScore: dna.recentDnaScore,
        trendRegime: dna.trendRegime,
        trendLabel: dna.trendLabel,
        simScore: Math.round(dnaPoints),
        structureScore: Math.round(trendScore),
        positionScore: Math.round(positionScore),
        liquidityScore: Math.round(liquidityScore),
        netPnlPct: Number(summary.netPnlPct.toFixed(2)),
        winRate: Number(summary.winRate.toFixed(1)),
        range24hPct: Number(range24hPct.toFixed(1)),
        quoteVol24h,
        posRatio: Number(posRatio.toFixed(3)),
        isDipPullback,
      });
    }

    scoredCandidates.sort((a, b) => b.compositeScore - a.compositeScore);
    const minScore = gridOpts?.compositeMinScore ?? 50;
    const viableCandidates = scoredCandidates.filter((c) => c.compositeScore >= minScore);

    return viableCandidates;
  }

  /**
   * Run full-fidelity Autonomous Multi-Pair Rotation Backtest Simulation
   * Walks the timeline bar-by-bar across candidate pairs in FDUSD or USDT universe.
   */
  public static async runMultiPairRotationSimulation(opts: MultiPairRotationOptions): Promise<MultiPairRotationResult> {
    const quote = opts.quoteAsset === "USD" ? "USD" : (opts.quoteAsset === "FDUSD" ? "FDUSD" : "USDT");
    const timeframe = opts.timeframe || "15m";
    const simLimit = Math.max(500, opts.limit || 2000);
    const initialCapital = Math.max(10, opts.initialCapital || 200);
    const cooldownSec = (opts.rotationIntervalMinutes || 180) * 60;
    const scoreMarginPct = opts.rotationScoreMarginPct || 12;

    // 1. Fetch Top Universe Candles
    const universeCandles = await this.fetchTopUniverseCandles({
      quoteAsset: quote,
      timeframe,
      maxPairs: opts.maxUniversePairs || 50,
      limit: simLimit,
      customWhitelist: opts.customWhitelist,
      blacklist: opts.blacklist,
    });

    if (universeCandles.size === 0) {
      throw new Error(`Failed to load candles for ${quote} universe`);
    }

    // 2. Compute timeline boundaries across major pairs with full history
    let minCandleTime = Infinity;
    let maxCandleTime = 0;
    for (const candles of universeCandles.values()) {
      if (candles.length >= 60) {
        const firstTime = candles[0].time;
        const lastTime = candles[candles.length - 1].time;
        if (firstTime < minCandleTime) minCandleTime = firstTime;
        if (lastTime > maxCandleTime) maxCandleTime = lastTime;
      }
    }

    const barSec = timeframe === "15m" ? 900 : (timeframe === "1h" ? 3600 : 300);
    const simEndTime = maxCandleTime > 0 ? maxCandleTime : Math.floor(Date.now() / 1000);
    const warmupSec = (quote === "USD" ? 78 : 240) * barSec;
    const requestedStart = simEndTime - simLimit * barSec;
    const simStartTime = Number.isFinite(minCandleTime)
      ? Math.max(minCandleTime + warmupSec, requestedStart)
      : requestedStart;

    console.log(`[RotationBacktest] 🚀 Starting simulation: quote=${quote}, timeframe=${timeframe}, simLimit=${simLimit} bars (${((simLimit * barSec) / 86400).toFixed(1)} days), universeLoaded=${universeCandles.size} pairs`);
    console.log(`[RotationBacktest] 📅 Timeline bounds: start=${new Date(simStartTime * 1000).toISOString()} (${simStartTime}) ➔ end=${new Date(simEndTime * 1000).toISOString()} (${simEndTime})`);

    this.rotationBtProgress = {
      phase: "simulating",
      completed: 0,
      total: 100,
      currentSymbol: "",
      message: `Starting Walk-Forward simulation from ${new Date(simStartTime * 1000).toISOString().slice(0, 10)}...`,
    };

    // 3. Evaluate initial symbol at simStartTime
    const initialCandidates = this.evaluateHistoricalFunnelAtTime({
      targetTime: simStartTime,
      universeCandles,
      quoteAsset: quote,
      gridOpts: opts,
    });

    console.log(`[RotationBacktest] 🔎 Initial funnel at ${new Date(simStartTime * 1000).toISOString()} found ${initialCandidates.length} eligible candidates: ` +
      (initialCandidates.length > 0 ? initialCandidates.slice(0, 5).map(c => `${c.symbol}(grade=${c.dnaGrade},score=${c.compositeScore},pos=${c.posRatio})`).join(", ") : "none")
    );

    const initialStrongCandidate = initialCandidates.find((c) => (c.dnaGrade === "S" || c.dnaGrade === "A") && c.compositeScore >= 60 && c.posRatio <= 0.55);
    let activeCandidate = initialStrongCandidate || (initialCandidates[0]?.compositeScore >= 50 ? initialCandidates[0] : undefined);
    let activeSymbol = activeCandidate ? activeCandidate.symbol : "";
    if (!activeCandidate && !opts.enableBtcMacroGate) {
      const fallbackSym = quote === "FDUSD" ? "BTCFDUSD" : "BTCUSDT";
      console.warn(`[RotationBacktest] ⚠️ No initial candidate passed full funnel criteria at simStartTime. Falling back to ${fallbackSym}`);
      activeCandidate = {
        symbol: fallbackSym,
        compositeScore: 70,
        dnaGrade: "A",
        dnaScore: 75,
        recentDnaScore: 78,
        trendRegime: "BULL_UPTREND",
        trendLabel: "Fallback BTC",
        simScore: 30,
        structureScore: 20,
        positionScore: 10,
        liquidityScore: 10,
        netPnlPct: 0,
        winRate: 0,
        range24hPct: 5,
        quoteVol24h: 10_000_000,
        posRatio: 0.35,
        isDipPullback: true,
      };
      activeSymbol = activeCandidate.symbol;
    }
    let currentCash = initialCapital;
    let currentTime = simStartTime;
    let lastRotationTime = currentTime;
    let previousSymbol: string | undefined = undefined;
    let previousSymbolScore: number | undefined = undefined;

    const legs: RotationLegRecord[] = [];
    const allTrades: Array<BacktestTrade & { symbol: string; legIndex: number }> = [];
    const equityCurve: Array<{ time: number; equity: number; symbol: string; drawdownPct: number }> = [];
    let peakEquity = currentCash;
    let maxPortfolioDrawdownPct = 0;
    let legIndex = 0;

    // 24-hour Ban for coins that suffered a Stop-Loss / Disqualification
    const symbolCooldownUntil = new Map<string, number>();
    const isBanned = (sym: string) => (symbolCooldownUntil.get(sym) || 0) > currentTime;

    // 4. Walk-forward simulation loop across legs
    while (currentTime < simEndTime - 3600 && legs.length < 300) {
      const currentLegStartTime = currentTime;

      let symCandles = activeSymbol ? universeCandles.get(activeSymbol) : undefined;
      let startBarIdx = symCandles ? symCandles.findIndex((c) => c.time >= currentTime) : -1;

      // If activeSymbol doesn't have sufficient bars or has reached end of data, find alternative viable pair
      if (!symCandles || startBarIdx < 0 || startBarIdx >= symCandles.length - 10) {
        if (activeSymbol) {
          console.warn(`[RotationBacktest] ⚠️ Pair ${activeSymbol} is not viable at ${new Date(currentTime * 1000).toISOString()} (startBarIdx=${startBarIdx}, total=${symCandles?.length || 0})`);
        }
        const altCandidates = this.evaluateHistoricalFunnelAtTime({
          targetTime: currentTime,
          universeCandles,
          quoteAsset: quote,
          gridOpts: opts,
        });

        const viable = altCandidates.find((c) => {
          if (c.compositeScore < 50) return false;
          if (isBanned(c.symbol)) return false;
          const cCandles = universeCandles.get(c.symbol);
          if (!cCandles) return false;
          const maxPos = opts.gridMaxChannelPos !== undefined ? Number(opts.gridMaxChannelPos) : 0.38;
          if (c.posRatio > maxPos) return false;
          const idx = cCandles.findIndex((cd) => cd.time >= currentTime);
          return idx >= 0 && idx < cCandles.length - 10;
        }) || altCandidates.find((c) => {
          if (c.compositeScore < 50) return false;
          if (isBanned(c.symbol)) return false;
          const cCandles = universeCandles.get(c.symbol);
          if (!cCandles) return false;
          const idx = cCandles.findIndex((cd) => cd.time >= currentTime);
          return idx >= 0 && idx < cCandles.length - 10;
        });

        if (viable) {
          console.log(`[RotationBacktest] 🔄 Swapping to viable alternative candidate: ${viable.symbol} (grade=${viable.dnaGrade}, score=${viable.compositeScore}, pos=${viable.posRatio})`);
          activeCandidate = viable;
          activeSymbol = viable.symbol;
          symCandles = universeCandles.get(activeSymbol);
          startBarIdx = symCandles ? symCandles.findIndex((c) => c.time >= currentTime) : -1;
          if (!symCandles || startBarIdx < 0 || startBarIdx >= symCandles.length - 10) {
            console.warn(`[RotationBacktest] 🛑 Alternative candidate ${activeSymbol} also lacks candles. Holding 100% cash.`);
            currentTime += 3600;
            equityCurve.push({
              time: currentTime,
              equity: currentCash,
              symbol: "CASH",
              drawdownPct: peakEquity > 0 ? ((peakEquity - currentCash) / peakEquity) * 100 : 0,
            });
            continue;
          }
        } else {
          console.warn(`[RotationBacktest] 🛡️ No viable pairs found at ${new Date(currentTime * 1000).toISOString()} (Macro Gate active or bear regime). Holding 100% cash.`);
          currentTime += 3600;
          equityCurve.push({
            time: currentTime,
            equity: currentCash,
            symbol: "CASH",
            drawdownPct: peakEquity > 0 ? ((peakEquity - currentCash) / peakEquity) * 100 : 0,
          });
          continue;
        }
      }

      const warmupBars = Math.min(200, startBarIdx);
      const legCandles = symCandles.slice(startBarIdx - warmupBars);
      const simStartIdx = warmupBars;

      legIndex++;
      console.log(`[RotationBacktest] ▶️ [Leg #${legIndex}] Starting on ${activeSymbol} at ${new Date(currentLegStartTime * 1000).toISOString()} (cash=$${currentCash.toFixed(2)}, grade=${activeCandidate?.dnaGrade || "A"}, score=${activeCandidate?.compositeScore || 65})`);

      let legStopReason: "INITIAL_SELECTION" | "POST_ROUND_EXIT" | "IDLE_CASH_TIMEOUT" | "SIGNAL_DISQUALIFIED" = "POST_ROUND_EXIT";
      let nextCandidate: any = undefined;
      let nextSymbol: string | undefined = undefined;
      let nextSymbolScore = 0;
      let currentScoreAtExit = activeCandidate?.compositeScore || 65;
      let scoresSnapshot: any[] = [];

      const legRecord = this.runDynamicGridSimulation(legCandles, {
        symbol: activeSymbol,
        timeframe,
        initialCapital: currentCash,
        maxInventoryQuote: currentCash,
        capitalZones: opts.capitalZones ?? 1,
        channelMode: opts.channelMode ?? "DONCHIAN_ATR",
        donchianPeriod: opts.donchianPeriod ?? 48,
        minChannelWidthPct: opts.minChannelWidthPct ?? 2.0,
        maxChannelWidthPct: opts.maxChannelWidthPct ?? 25.0,
        zoneMinDropPct: opts.zoneMinDropPct ?? 2.5,
        zoneStabilizeCandles: opts.zoneStabilizeCandles ?? 3,
        floorBufferPct: 0.6,
        lockChannelInPosition: opts.lockChannelInPosition ?? true,
        regimeFilterMode: "UPTREND_AND_SIDEWAY",
        buyLevelPcts: [20, 12],
        buyWeights: [55, 45],
        sellLevelPcts: [52, 72],
        enableBaseConfirmationFilter: opts.enableBaseConfirmation ?? false,
        enableDipHunterEntryGuard: opts.enableDipHunterEntryGuard ?? true,
        gridCutLossMode: opts.gridCutLossMode ?? "entry_floor",
        enableGridTrailingStop: true,
        costModel: (quote === "FDUSD" || quote === "USD")
          ? { feePctPerSide: 0, slippagePctPerFill: 0.01 }
          : { feePctPerSide: 0.075, slippagePctPerFill: 0.01 },
        saveToHistory: false,
        startTradingBarIndex: simStartIdx,
        onFlatCheckStop: (state) => {
          const candidates = this.evaluateHistoricalFunnelAtTime({
            targetTime: state.time,
            universeCandles,
            activeSymbol,
            quoteAsset: quote,
            gridOpts: opts,
          });

          if (candidates.length === 0) {
            if (quote === "USD") {
              return false;
            }
            console.log(
              `[RotationBacktest] 🛡️ [Leg #${legIndex}] Macro Gate / Market breakdown active at ${new Date(
                state.time * 1000
              ).toISOString()}: Exiting ${activeSymbol} to 100% CASH`
            );
            legStopReason = "SIGNAL_DISQUALIFIED";
            nextSymbol = undefined;
            nextCandidate = undefined;
            return true;
          }
          scoresSnapshot = candidates.slice(0, 5);

          const curItem = candidates.find((c) => c.symbol === activeSymbol);
          const curScore = curItem ? curItem.compositeScore : 0;
          currentScoreAtExit = curScore;

          // Actionable candidates: grade S/A or solid B, posRatio <= 0.55, not banned
          const pullbackCandidates = candidates.filter(
            (c) => c.symbol !== activeSymbol && c.compositeScore >= 50 && c.posRatio <= 0.55 && !isBanned(c.symbol)
          );

          // 1. If current coin has degraded (AVOID, bear downtrend, or score < 42):
          const isCurrentDisqualified = !curItem || curScore < 42 || curItem.dnaGrade === "AVOID" || curItem.trendRegime === "BEAR_DOWNTREND";
          if (isCurrentDisqualified) {
            const bestPullback = pullbackCandidates[0];
            if (bestPullback && bestPullback.compositeScore >= 50) {
              console.log(
                `[RotationBacktest] 🚨 [Leg #${legIndex}] Flat rotation triggered by SIGNAL_DISQUALIFIED at ${new Date(
                  state.time * 1000
                ).toISOString()}: ${activeSymbol} (score=${curScore}) ➔ ${bestPullback.symbol} (grade=${bestPullback.dnaGrade}, score=${
                  bestPullback.compositeScore
                }, posRatio=${bestPullback.posRatio})`
              );
              legStopReason = "SIGNAL_DISQUALIFIED";
              nextCandidate = bestPullback;
              nextSymbol = bestPullback.symbol;
              nextSymbolScore = bestPullback.compositeScore;
              return true;
            } else {
              console.log(
                `[RotationBacktest] 🚨 [Leg #${legIndex}] Disqualified exit to cash at ${new Date(
                  state.time * 1000
                ).toISOString()}: ${activeSymbol} (score=${curScore}) ➔ 100% CASH`
              );
              legStopReason = "SIGNAL_DISQUALIFIED";
              nextCandidate = undefined;
              nextSymbol = undefined;
              return true;
            }
          }

          const timeSinceRot = state.time - lastRotationTime;
          if (timeSinceRot < cooldownSec) {
            return false;
          }

          // 2. Winning Horse Loyalty Policy:
          // Require score margin to rotate into an eligible Grade S/A candidate in the pullback sweet spot!
          const requiredScore = curScore * (1 + scoreMarginPct / 100);
          const eligibleRotationCandidate = pullbackCandidates.find(
            (c) => c.compositeScore >= 55 && c.compositeScore >= requiredScore && (c.dnaGrade === "S" || c.dnaGrade === "A")
          );

          if (eligibleRotationCandidate) {
            console.log(
              `[RotationBacktest] 🔀 [Leg #${legIndex}] Pullback rotation triggered by ${state.trigger} at ${new Date(
                state.time * 1000
              ).toISOString()}: ${activeSymbol} (${curScore}) ➔ ${eligibleRotationCandidate.symbol} (grade=${eligibleRotationCandidate.dnaGrade}, score=${
                eligibleRotationCandidate.compositeScore
              }, posRatio=${eligibleRotationCandidate.posRatio}, required >= ${requiredScore.toFixed(1)})`
            );
            legStopReason = state.trigger;
            nextCandidate = eligibleRotationCandidate;
            nextSymbol = eligibleRotationCandidate.symbol;
            nextSymbolScore = eligibleRotationCandidate.compositeScore;
            return true;
          }

          return false;
        },
        onSignalInvalidationCheck: (state) => {
          if (opts.enableSignalInvalidationExit === false || opts.signalInvalidationMode === "off") return false;

          const mode = opts.signalInvalidationMode || "calibrated";
          let isDanger = false;

          if (mode === "strict_floor") {
            const isFloorBreak = state.closePrice < state.floorPrice * 0.982;
            const isCatastrophicDump = state.posRatio24h < 0.05 && state.unrealizedPnlPct < -5.0;
            isDanger = isFloorBreak || isCatastrophicDump;
          } else {
            const isSevereFloorBreak = state.closePrice < state.floorPrice * 0.955 && state.unrealizedPnlPct < -2.5;
            const isMaxLossBreach = state.unrealizedPnlPct <= -4.0;
            const isCatastrophicDump = state.posRatio24h < 0.05 && state.unrealizedPnlPct < -5.0;
            isDanger = isSevereFloorBreak || isMaxLossBreach || isCatastrophicDump;
          }

          if (!isDanger) {
            return false;
          }

          console.log(
            `[RotationBacktest] 🚨 [Leg #${legIndex}] ${mode === "strict_floor" ? "STRUCTURAL FLOOR BREAKDOWN" : "CALIBRATED STOP LOSS"}: ${activeSymbol} loss=${state.unrealizedPnlPct.toFixed(2)}%, price=$${state.closePrice.toFixed(
              4
            )} ➔ Liquidating ${state.heldLotsCount} lots to protect capital`
          );
          legStopReason = "SIGNAL_DISQUALIFIED";
          nextCandidate = undefined;
          nextSymbol = undefined;
          return true;
        },
      });

      const legEndTime = legRecord.candles.length > simStartIdx
        ? legRecord.candles[legRecord.candles.length - 1].time
        : currentTime + 3600;

      const startingCapital = currentCash;
      const endingCapital = legRecord.summary.finalCapital;
      const legNetPnlQuote = endingCapital - startingCapital;
      const legNetPnlPct = startingCapital > 0 ? (legNetPnlQuote / startingCapital) * 100 : 0;

      for (const t of legRecord.trades) {
        allTrades.push({ ...t, symbol: activeSymbol, legIndex });
      }

      const legCandlesActive = legRecord.candles.slice(simStartIdx);

      if (Array.isArray(legRecord.equityCurve) && legRecord.equityCurve.length > 0) {
        for (const pt of legRecord.equityCurve) {
          const eq = pt.equity;
          if (eq > peakEquity) peakEquity = eq;
          const dd = peakEquity > 0 ? ((peakEquity - eq) / peakEquity) * 100 : 0;
          if (dd > maxPortfolioDrawdownPct) maxPortfolioDrawdownPct = dd;
          equityCurve.push({
            time: pt.time,
            equity: Number(eq.toFixed(2)),
            symbol: activeSymbol,
            drawdownPct: Number(dd.toFixed(2)),
          });
        }
      } else {
        const sampleStep = Math.max(1, Math.floor(legCandlesActive.length / 50));
        for (let ci = 0; ci < legCandlesActive.length; ci += sampleStep) {
          const c = legCandlesActive[ci];
          const matchingTrades = legRecord.trades.filter((t) => t.exitTime <= c.time);
          const closedPnl = matchingTrades.reduce((sum, t) => sum + t.pnlQuote, 0);
          const eq = startingCapital + closedPnl;
          if (eq > peakEquity) peakEquity = eq;
          const dd = peakEquity > 0 ? ((peakEquity - eq) / peakEquity) * 100 : 0;
          if (dd > maxPortfolioDrawdownPct) maxPortfolioDrawdownPct = dd;
          equityCurve.push({
            time: c.time,
            equity: Number(eq.toFixed(2)),
            symbol: activeSymbol,
            drawdownPct: Number(dd.toFixed(2)),
          });
        }
      }

      const legItem: RotationLegRecord = {
        legIndex,
        symbol: activeSymbol,
        startTime: currentLegStartTime,
        endTime: legEndTime,
        durationHours: Number(((legEndTime - currentLegStartTime) / 3600).toFixed(1)),
        triggerReason: legIndex === 1 ? "INITIAL_SELECTION" : legStopReason,
        entryScore: activeCandidate?.compositeScore || 65,
        dnaGrade: activeCandidate?.dnaGrade,
        dnaScore: activeCandidate?.dnaScore,
        recentDnaScore: activeCandidate?.recentDnaScore,
        trendRegime: activeCandidate?.trendRegime,
        trendLabel: activeCandidate?.trendLabel,
        entryPosRatio: activeCandidate?.posRatio,
        previousSymbol,
        previousSymbolScore,
        startingCapital: Number(startingCapital.toFixed(2)),
        endingCapital: Number(endingCapital.toFixed(2)),
        netPnlQuote: Number(legNetPnlQuote.toFixed(2)),
        netPnlPct: Number(legNetPnlPct.toFixed(2)),
        tradesCount: legRecord.trades.length,
        winCount: legRecord.summary.winTrades,
        lossCount: legRecord.summary.lossTrades,
        winRate: Number(legRecord.summary.winRate.toFixed(1)),
        maxDrawdownPct: Number(legRecord.summary.maxDrawdownPct.toFixed(1)),
        topCandidatesSnapshot: scoresSnapshot.map((c) => ({
          symbol: c.symbol,
          compositeScore: c.compositeScore,
          dnaGrade: c.dnaGrade,
          dnaScore: c.dnaScore,
          recentDnaScore: c.recentDnaScore,
          trendLabel: c.trendLabel,
          netPnlPct: c.netPnlPct,
          winRate: c.winRate,
          range24hPct: c.range24hPct,
          posRatio: c.posRatio,
        })),
        trades: legRecord.trades,
        candles: legCandlesActive,
        markers: legRecord.markers.filter((m) => m.time >= currentLegStartTime),
      };

      legs.push(legItem);

      console.log(`[RotationBacktest] ⏹️ [Leg #${legIndex}] Finished on ${activeSymbol}: duration=${legItem.durationHours}h, pnl=${legItem.netPnlPct >= 0 ? '+' : ''}${legItem.netPnlPct}% ($${legItem.netPnlQuote}), trades=${legItem.tradesCount} (win=${legItem.winCount}), trigger=${legItem.triggerReason}`);

      currentCash = endingCapital;
      currentTime = legEndTime;
      lastRotationTime = currentTime;
      previousSymbol = activeSymbol;
      previousSymbolScore = currentScoreAtExit;

      // 🛡️ If leg lost money or was disqualified by Stop Loss, ban it for 24h to avoid catching falling knives!
      if (legItem.triggerReason === "SIGNAL_DISQUALIFIED" || legItem.netPnlPct < 0) {
        symbolCooldownUntil.set(activeSymbol, currentTime + 24 * 3600);
      }

      if (nextSymbol && nextSymbol !== activeSymbol) {
        activeCandidate = nextCandidate || ({ symbol: nextSymbol, compositeScore: nextSymbolScore } as any);
        activeSymbol = nextSymbol;
      } else {
        const candidates = this.evaluateHistoricalFunnelAtTime({
          targetTime: currentTime,
          universeCandles,
          quoteAsset: quote,
          gridOpts: opts,
        });
        const viable = candidates.find((c) => {
          if (c.compositeScore < 50) return false;
          if (c.symbol === activeSymbol || isBanned(c.symbol)) return false;
          const maxPos = opts.gridMaxChannelPos !== undefined ? Number(opts.gridMaxChannelPos) : 0.38;
          if (c.posRatio > maxPos) return false;
          const cCandles = universeCandles.get(c.symbol);
          if (!cCandles) return false;
          const idx = cCandles.findIndex((cd) => cd.time >= currentTime);
          return idx >= 0 && idx < cCandles.length - 10;
        }) || candidates.find((c) => {
          if (c.compositeScore < 50) return false;
          if (c.symbol === activeSymbol || isBanned(c.symbol)) return false;
          const cCandles = universeCandles.get(c.symbol);
          if (!cCandles) return false;
          const idx = cCandles.findIndex((cd) => cd.time >= currentTime);
          return idx >= 0 && idx < cCandles.length - 10;
        });
        if (viable) {
          console.log(`[RotationBacktest] 🔄 Rotating to next top viable candidate: ${viable.symbol} (grade=${viable.dnaGrade}, score=${viable.compositeScore}, pos=${viable.posRatio})`);
          activeCandidate = viable;
          activeSymbol = viable.symbol;
        } else {
          // If no candidate is viable right now, hold 100% Cash and advance by 1 hour instead of aborting the simulation!
          activeSymbol = "";
          activeCandidate = undefined;
          if (currentTime < simEndTime - 3600) {
            currentTime += 3600;
            const cashDd = peakEquity > 0 ? ((peakEquity - currentCash) / peakEquity) * 100 : 0;
            equityCurve.push({
              time: currentTime,
              equity: Number(currentCash.toFixed(2)),
              symbol: "CASH",
              drawdownPct: Number(cashDd.toFixed(2)),
            });
            continue;
          } else {
            console.log(`[RotationBacktest] ⏹️ Simulation reached timeline boundary at ${new Date(currentTime * 1000).toISOString()}. Simulation loop completed.`);
            break;
          }
        }
      }
    }

    console.log(`[RotationBacktest] 🎉 Simulation finished: totalLegs=${legs.length}, totalTrades=${allTrades.length}, finalEquity=$${currentCash.toFixed(2)} (Net: ${(((currentCash - initialCapital) / initialCapital) * 100).toFixed(2)}%), maxDD=-${maxPortfolioDrawdownPct.toFixed(2)}%`);

    // 5. Per-Pair Contribution Breakdown
    const pairMap = new Map<string, PairContributionItem>();
    for (const leg of legs) {
      const existing = pairMap.get(leg.symbol) || {
        symbol: leg.symbol,
        legsCount: 0,
        totalHoursHeld: 0,
        tradesCount: 0,
        winRate: 0,
        totalNetPnlQuote: 0,
        totalNetPnlPct: 0,
      };
      existing.legsCount += 1;
      existing.totalHoursHeld = Number((existing.totalHoursHeld + leg.durationHours).toFixed(1));
      existing.tradesCount += leg.tradesCount;
      existing.totalNetPnlQuote = Number((existing.totalNetPnlQuote + leg.netPnlQuote).toFixed(2));
      pairMap.set(leg.symbol, existing);
    }

    const pairContributions = Array.from(pairMap.values()).map((p) => {
      const legMatches = legs.filter((l) => l.symbol === p.symbol);
      const totalWins = legMatches.reduce((sum, l) => sum + l.winCount, 0);
      const winRate = p.tradesCount > 0 ? Number(((totalWins / p.tradesCount) * 100).toFixed(1)) : 0;
      const netPct = initialCapital > 0 ? Number(((p.totalNetPnlQuote / initialCapital) * 100).toFixed(2)) : 0;
      const grades = legMatches.map((l) => l.dnaGrade).filter(Boolean) as string[];
      const bestDnaGrade = grades.includes("S") ? "S" : (grades.includes("A") ? "A" : (grades.includes("B") ? "B" : undefined));
      const dnaScores = legMatches.map((l) => l.dnaScore).filter((s): s is number => typeof s === "number");
      const avgDnaScore = dnaScores.length > 0 ? Math.round(dnaScores.reduce((a, b) => a + b, 0) / dnaScores.length) : undefined;
      return { ...p, winRate, totalNetPnlPct: netPct, bestDnaGrade, avgDnaScore };
    });

    pairContributions.sort((a, b) => b.totalNetPnlQuote - a.totalNetPnlQuote);

    // 6. Benchmark Comparison (True Buy & Hold vs Grid)
    const isAlpaca = quote === "USD";
    const defaultBtc = isAlpaca ? "SPY" : (quote === "FDUSD" ? "BTCFDUSD" : "BTCUSDT");
    let btcBuyHoldPct = 0;
    const btcCandles = universeCandles.get(defaultBtc);
    if (btcCandles && btcCandles.length > 0) {
      const b0 = btcCandles.find((c) => c.time >= simStartTime);
      const b1 = btcCandles[btcCandles.length - 1];
      if (b0 && b1 && b0.open > 0) {
        btcBuyHoldPct = Number((((b1.close - b0.open) / b0.open) * 100).toFixed(2));
      }
    }

    let sumEw = 0;
    let countEw = 0;
    for (const [sym, cList] of universeCandles.entries()) {
      const c0 = cList.find((c) => c.time >= simStartTime);
      const c1 = cList[cList.length - 1];
      if (c0 && c1 && c0.open > 0) {
        sumEw += ((c1.close - c0.open) / c0.open) * 100;
        countEw++;
      }
    }
    const equalWeightBuyHoldPct = countEw > 0 ? Number((sumEw / countEw).toFixed(2)) : 0;

    const benchmarkSymbol = universeCandles.has(defaultBtc) ? defaultBtc : (legs.length > 0 ? legs[0].symbol : defaultBtc);
    let benchmarkPnlPct = 0;
    try {
      const bCandles = universeCandles.get(benchmarkSymbol);
      if (bCandles && bCandles.length > 100) {
        const bStartIdx = bCandles.findIndex((c) => c.time >= simStartTime);
        if (bStartIdx >= 0) {
          const bWarmup = Math.min(200, bStartIdx);
          const bRec = this.runDynamicGridSimulation(bCandles.slice(bStartIdx - bWarmup), {
            symbol: benchmarkSymbol,
            timeframe,
            initialCapital,
            maxInventoryQuote: initialCapital,
            startTradingBarIndex: bWarmup,
            capitalZones: 1,
            channelMode: "DONCHIAN_ATR",
            donchianPeriod: 48,
            minChannelWidthPct: 2.0,
            maxChannelWidthPct: 25.0,
            buyLevelPcts: [20, 12],
            buyWeights: [55, 45],
            sellLevelPcts: [52, 72],
            gridCutLossMode: "entry_floor",
            enableGridTrailingStop: true,
            lockChannelInPosition: true,
            saveToHistory: false,
          });
          benchmarkPnlPct = bRec.summary.netPnlPct;
        }
      }
    } catch {}

    const totalNetPnlQuote = currentCash - initialCapital;
    const totalNetPnlPct = initialCapital > 0 ? (totalNetPnlQuote / initialCapital) * 100 : 0;
    const winningTrades = allTrades.filter((t) => t.pnlQuote > 0).length;
    const losingTrades = allTrades.filter((t) => t.pnlQuote <= 0).length;
    const tradeWinRate = allTrades.length > 0 ? (winningTrades / allTrades.length) * 100 : 0;
    const profitableLegs = legs.filter((l) => l.netPnlQuote > 0).length;
    const legWinRate = legs.length > 0 ? (profitableLegs / legs.length) * 100 : 0;

    const grossProfit = allTrades.filter((t) => t.pnlQuote > 0).reduce((sum, t) => sum + t.pnlQuote, 0);
    const grossLoss = allTrades.filter((t) => t.pnlQuote < 0).reduce((sum, t) => sum + Math.abs(t.pnlQuote), 0);
    const profitFactor = grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(2)) : (grossProfit > 0 ? 99 : 0);
    const totalFeesPaid = allTrades.reduce((sum, t) => sum + (t.costQuote || 0), 0);

    const result: MultiPairRotationResult = {
      id: `rot_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      createdAt: Date.now(),
      options: opts,
      summary: {
        quoteAsset: quote,
        universeScannedCount: universeCandles.size,
        initialCapital: Number(initialCapital.toFixed(2)),
        finalEquity: Number(currentCash.toFixed(2)),
        netPnlQuote: Number(totalNetPnlQuote.toFixed(2)),
        netPnlPct: Number(totalNetPnlPct.toFixed(2)),
        totalRotations: Math.max(0, legs.length - 1),
        totalLegs: legs.length,
        profitableLegs,
        legWinRate: Number(legWinRate.toFixed(1)),
        totalTrades: allTrades.length,
        winningTrades,
        losingTrades,
        tradeWinRate: Number(tradeWinRate.toFixed(1)),
        maxPortfolioDrawdownPct: Number(maxPortfolioDrawdownPct.toFixed(1)),
        profitFactor,
        totalFeesPaid: Number(totalFeesPaid.toFixed(2)),
        bestPairSymbol: pairContributions.length > 0 ? pairContributions[0].symbol : benchmarkSymbol,
        bestPairPnlPct: pairContributions.length > 0 ? pairContributions[0].totalNetPnlPct : 0,
        benchmarkSinglePairSymbol: benchmarkSymbol,
        benchmarkSinglePairPnlPct: Number(benchmarkPnlPct.toFixed(2)),
        benchmarkBtcBuyHoldPct: btcBuyHoldPct,
        benchmarkEqualWeightBuyHoldPct: equalWeightBuyHoldPct,
        alphaVsBenchmarkPct: Number((totalNetPnlPct - btcBuyHoldPct).toFixed(2)),
        alphaVsBtcBuyHoldPct: Number((totalNetPnlPct - btcBuyHoldPct).toFixed(2)),
        alphaVsEqualWeightPct: Number((totalNetPnlPct - equalWeightBuyHoldPct).toFixed(2)),
      },
      legs,
      pairContributions,
      equityCurve,
      allTrades,
    };

    this.latestRotationResult = result;
    this.rotationBtProgress = { phase: "complete", completed: 100, total: 100, currentSymbol: "", message: "Simulation completed successfully!" };
    return result;
  }

  /**
   * Run full-fidelity Autonomous Multi-Pair MA-Fan Reversal Portfolio Simulation
   * Evaluates Bottom Fan -> 8/16 Cross -> MA4 Pullback entries across a portfolio with strictly 0 look-ahead.
   */
  public static runMaFanPortfolioSimulation(opts: {
    universe: { symbol: string; candles: Candle[] }[];
    btcCandles: Candle[];
    maxSlots?: number;
    initialCapital?: number;
    limitPenetrationPct?: number;
    minBreadth25Pct?: number;
    requireBtcNotDumping?: boolean;
    requireCoin1hRsi40?: boolean;
    minBuyVolRatio12?: number;
    minRelStrengthVsBtc24h?: number;
    maxUpperRibbonSpreadPct?: number;
    rankBy?: "RSI15" | "COMPOSITE_QUALITY";
    tp1TargetMode?: "EMA25" | "EMA75" | "EMA200";
    lockBreakevenAtEma200?: boolean;
    partialTpAtEma200?: boolean;
    maxDisasterSlPct?: number;
    maxHoldHours?: number;
    downtrendSitOutMode?: "off" | "btc1d" | "btc4h" | "dual";
  }): {
    initialCapital: number;
    finalEquity: number;
    netPnlQuote: number;
    netPnlPct: number;
    maxDrawdownPct: number;
    calmarRatio: number;
    profitFactor: number;
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    winRate: number;
    avgHoldHours: number;
    avgMaePct: number;
    btcBuyHoldPct: number;
    alphaVsBtcPct: number;
    trades: {
      symbol: string;
      entryTime: number;
      exitTime: number;
      entryPrice: number;
      exitPrice: number;
      pnlPct: number;
      maePct: number;
      holdHours: number;
      isWin: boolean;
      exitReason: string;
    }[];
  } {
    const costPerFill = (0.075 + 0.01) / 100;
    const penetration = (opts.limitPenetrationPct ?? 0.10) / 100;
    const maxSlots = Math.max(1, opts.maxSlots ?? 3);
    const initialCapital = Math.max(10, opts.initialCapital ?? 100);
    let cash = initialCapital;

    interface CoinPrecalc {
      symbol: string;
      c15: Candle[];
      timeMap15: Map<number, number>;
      m4: number[];
      m8: number[];
      m16: number[];
      m25: number[];
      m75: number[];
      m200: number[];
      rsi15: number[];
      macdHist15: number[];
      c1h: Candle[];
      m200_1h: number[];
      rsi1h: number[];
    }

    const precalc: CoinPrecalc[] = [];
    for (const u of opts.universe) {
      if (!u.candles || u.candles.length < 500) continue;
      const c15 = BacktestService.aggregateCandles(u.candles, 15);
      if (c15.length < 220) continue;
      const closes15 = c15.map((c) => c.close);
      const timeMap15 = new Map<number, number>();
      c15.forEach((c, idx) => timeMap15.set(c.time, idx));

      const c1h = BacktestService.aggregateCandles(u.candles, 60);
      const closes1h = c1h.map((c) => c.close);

      precalc.push({
        symbol: u.symbol,
        c15,
        timeMap15,
        m4: calcEMA(closes15, 4),
        m8: calcEMA(closes15, 8),
        m16: calcEMA(closes15, 16),
        m25: calcEMA(closes15, 25),
        m75: calcEMA(closes15, 75),
        m200: calcEMA(closes15, 200),
        rsi15: calcRSI(c15, 14),
        macdHist15: calcMACD(c15).hist,
        c1h,
        m200_1h: calcEMA(closes1h, 200),
        rsi1h: calcRSI(c1h, 14),
      });
    }

    if (precalc.length === 0) {
      throw new Error("No eligible coins with sufficient history for MA-Fan Portfolio simulation");
    }

    const btc15 = BacktestService.aggregateCandles(opts.btcCandles, 15);
    const btcTimeMap = new Map<number, number>();
    btc15.forEach((c, idx) => btcTimeMap.set(c.time, idx));

    const startT = Math.max(...precalc.map((c) => c.c15[220]?.time ?? 0), btc15[220]?.time ?? 0);
    const endT = Math.min(...precalc.map((c) => c.c15[c.c15.length - 1]?.time ?? Infinity), btc15[btc15.length - 1]?.time ?? Infinity);

    const btcStart = btc15.find((c) => c.time >= startT)?.close ?? 1;
    const btcEnd = btc15.filter((c) => c.time <= endT).at(-1)?.close ?? btcStart;
    const btcBuyHoldPct = btcStart > 0 ? ((btcEnd - btcStart) / btcStart) * 100 : 0;

    const btc4h = (opts.btcCandles && opts.btcCandles.length > 0) ? BacktestService.aggregateCandles(opts.btcCandles, 240) : [];
    const btc4hCloses = btc4h.map((c) => c.close);
    const btc4hEma75 = calcEMA(btc4hCloses, 75);

    const btc1d = (opts.btcCandles && opts.btcCandles.length > 0) ? BacktestService.aggregateCandles(opts.btcCandles, 1440) : [];
    const btc1dCloses = btc1d.map((c) => c.close);
    const btc1dEma25 = calcEMA(btc1dCloses, 25);

    function getClosedHtfIdx(arr: Candle[], durationSec: number, targetSec: number) {
      let lo = 0, hi = arr.length - 1, ans = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid].time + durationSec <= targetSec) {
          ans = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      return ans;
    }

    // Precompute Breadth & BTC Macro at each 15m step (strictly known at idx - 1)
    const macroMap = new Map<number, { b25: number; btcNotDumping: boolean; btcRet24h: number; isBtcDowntrend: boolean }>();
    for (let t = startT; t <= endT; t += 900) {
      let a25 = 0, tot = 0;
      for (const c of precalc) {
        if (c.symbol === "BTCUSDT") continue;
        const idx = c.timeMap15.get(t);
        if (idx !== undefined && idx > 200) {
          tot++;
          if (c.c15[idx - 1].close > c.m25[idx - 1]) a25++;
        }
      }
      const bIdx = btcTimeMap.get(t) ?? 200;
      const prev = bIdx - 1;
      let sma96 = btc15[prev]?.close ?? 1;
      if (prev >= 96) {
        let s = 0;
        for (let k = prev - 95; k <= prev; k++) s += btc15[k]?.close ?? 0;
        sma96 = s / 96;
      }
      const btcClose = btc15[prev]?.close ?? 1;
      const btcRet4h = prev >= 16 ? ((btcClose - btc15[prev - 16].open) / btc15[prev - 16].open) * 100 : 0;
      const btcRet24h = prev >= 96 ? ((btcClose - btc15[prev - 96].open) / btc15[prev - 96].open) * 100 : 0;

      let isBtcDowntrend = false;
      const sitMode = opts.downtrendSitOutMode ?? "dual";
      if (sitMode !== "off" && opts.btcCandles && opts.btcCandles.length > 0) {
        const idx4h = getClosedHtfIdx(btc4h, 14400, t);
        const idx1d = getClosedHtfIdx(btc1d, 86400, t);
        const pass4h = idx4h >= 75 ? btc4h[idx4h].close >= btc4hEma75[idx4h] : true;
        const pass1d = idx1d >= 25 ? btc1d[idx1d].close >= btc1dEma25[idx1d] : true;

        if (sitMode === "dual") {
          isBtcDowntrend = !pass4h || !pass1d;
        } else if (sitMode === "btc1d") {
          isBtcDowntrend = !pass1d;
        } else if (sitMode === "btc4h") {
          isBtcDowntrend = !pass4h;
        }
      }

      macroMap.set(t, {
        b25: tot > 0 ? (a25 / tot) * 100 : 50,
        btcNotDumping: btcClose >= sma96 * 0.99 && btcRet4h >= -1.2,
        btcRet24h,
        isBtcDowntrend,
      });
    }

    interface ActivePos {
      symbol: string;
      entryTime: number;
      entryPrice: number;
      allocatedCapital: number;
      qty: number;
      troughPrice: number;
      peakPrice: number;
      lastKnownPrice: number;
      beLocked: boolean;
      tp1Done: boolean;
      realizedProceeds: number;
    }

    let activePositions: ActivePos[] = [];
    const completedTrades: {
      symbol: string;
      entryTime: number;
      exitTime: number;
      entryPrice: number;
      exitPrice: number;
      pnlPct: number;
      maePct: number;
      holdHours: number;
      isWin: boolean;
      exitReason: string;
    }[] = [];

    let peakEquity = initialCapital;
    let maxDdPct = 0;

    interface CoinSetupState {
      hadBottomFan: boolean;
      fanExpiryTime: number;
      waitingPullback: boolean;
      pullbackExpiryTime: number;
      waitFromTime: number;
      bottomLow: number;
    }

    const states = new Map<string, CoinSetupState>();
    const p1Map = new Map<string, number>();
    for (const c of precalc) {
      states.set(c.symbol, {
        hadBottomFan: false,
        fanExpiryTime: 0,
        waitingPullback: false,
        pullbackExpiryTime: 0,
        waitFromTime: 0,
        bottomLow: Infinity,
      });
      p1Map.set(c.symbol, 0);
    }

    for (let t = startT; t <= endT; t += 900) {
      const closeT = t + 900;

      // 1. Update Active Positions & Exits
      const surviving: ActivePos[] = [];
      for (const pos of activePositions) {
        const coin = precalc.find((c) => c.symbol === pos.symbol)!;
        const idx = coin.timeMap15.get(t);
        if (idx === undefined) {
          surviving.push(pos);
          continue;
        }
        const c = coin.c15[idx];
        pos.lastKnownPrice = c.close;
        pos.troughPrice = Math.min(pos.troughPrice, c.low);
        pos.peakPrice = Math.max(pos.peakPrice, c.high);

        let shouldCloseAll = false;
        let exitPrice = c.close;
        let exitReason = "TIME_STOP";

        // Check Disaster SL (Default calibrated stop: 3.5%)
        const disasterSl = opts.maxDisasterSlPct !== undefined ? opts.maxDisasterSlPct : 3.5;
        if (disasterSl > 0 && c.low <= pos.entryPrice * (1 - disasterSl / 100)) {
          shouldCloseAll = true;
          exitPrice = Math.min(c.open, pos.entryPrice * (1 - disasterSl / 100));
          exitReason = `SL_CALIBRATED_${disasterSl}%`;
        }

        // Check Locked Breakeven Stop
        if (!shouldCloseAll && pos.beLocked && c.low <= pos.entryPrice * 1.0025) {
          shouldCloseAll = true;
          exitPrice = Math.min(c.open, pos.entryPrice * 1.0025);
          exitReason = "SL_BREAKEVEN";
        }

        // Check EMA200 touch in profit (>= +0.8%)
        if (opts.tp1TargetMode) {
          const targetEma = opts.tp1TargetMode === "EMA75" ? coin.m75[idx] : coin.m200[idx];
          const emaTargetPx = Math.max(targetEma, pos.entryPrice * 1.008);
          if (!shouldCloseAll && c.high >= emaTargetPx) {
            if (opts.lockBreakevenAtEma200) {
              pos.beLocked = true;
            }
            if (opts.partialTpAtEma200 && !pos.tp1Done) {
              pos.tp1Done = true;
              pos.beLocked = true;
              const halfQty = pos.qty * 0.5;
              const proceedsHalf = halfQty * emaTargetPx * (1 - costPerFill);
              cash += proceedsHalf;
              pos.realizedProceeds += proceedsHalf;
              pos.qty -= halfQty;
            }
          }
        }

        // Check Full Bullish Fan (4 > 8 > 16 > 25 > 75 > 200)
        const isBullishFan =
          coin.m4[idx] > coin.m8[idx] &&
          coin.m8[idx] > coin.m16[idx] &&
          coin.m16[idx] > coin.m25[idx] &&
          coin.m25[idx] > coin.m75[idx] &&
          coin.m75[idx] > coin.m200[idx];

        if (!shouldCloseAll && isBullishFan) {
          shouldCloseAll = true;
          exitPrice = c.close;
          exitReason = "FULL_BULLISH_FAN";
        }

        const holdHours = (t - pos.entryTime) / 3600;
        if (!shouldCloseAll && opts.maxHoldHours && holdHours >= opts.maxHoldHours) {
          shouldCloseAll = true;
          exitPrice = c.close;
          exitReason = "MAX_HOLD_HOURS";
        }

        if (shouldCloseAll) {
          const finalProceeds = pos.qty * exitPrice * (1 - costPerFill);
          cash += finalProceeds;
          const totalProceeds = pos.realizedProceeds + finalProceeds;
          const netPnlPct = ((totalProceeds - pos.allocatedCapital) / pos.allocatedCapital) * 100;
          const maePct = ((pos.troughPrice - pos.entryPrice) / pos.entryPrice) * 100;
          completedTrades.push({
            symbol: pos.symbol,
            entryTime: pos.entryTime,
            exitTime: t,
            entryPrice: pos.entryPrice,
            exitPrice,
            pnlPct: netPnlPct,
            maePct,
            holdHours,
            isWin: netPnlPct > 0,
            exitReason,
          });
          const st = states.get(pos.symbol)!;
          st.hadBottomFan = false;
          st.waitingPullback = false;
          st.bottomLow = Infinity;
        } else {
          surviving.push(pos);
        }
      }
      activePositions = surviving;

      // 2. Scan for Candidate Fills (strictly prior-bar idx - 1)
      const macro = macroMap.get(t) ?? { b25: 50, btcNotDumping: true, btcRet24h: 0, isBtcDowntrend: false };
      const isMacroOk =
        !macro.isBtcDowntrend &&
        (opts.minBreadth25Pct === undefined || macro.b25 >= opts.minBreadth25Pct) &&
        (!opts.requireBtcNotDumping || macro.btcNotDumping);

      interface Cand {
        symbol: string;
        entryPrice: number;
        barLow: number;
        barHigh: number;
        barClose: number;
        score: number;
      }
      const candidates: Cand[] = [];

      for (const coin of precalc) {
        const idx = coin.timeMap15.get(t);
        if (idx === undefined || idx < 200) continue;
        const st = states.get(coin.symbol)!;
        const c = coin.c15[idx];
        const isHeld = activePositions.some((p) => p.symbol === coin.symbol);

        let p1 = p1Map.get(coin.symbol)!;
        while (p1 + 1 < coin.c1h.length && coin.c1h[p1 + 1].time + 3600 <= closeT) p1++;
        p1Map.set(coin.symbol, p1);

        if (!isHeld && isMacroOk && st.waitingPullback && t > st.waitFromTime && t <= st.pullbackExpiryTime) {
          const prev = idx - 1;
          const limitP = coin.m4[prev];
          if (coin.m8[prev] >= coin.m16[prev] && c.low <= limitP * (1 - penetration)) {
            let pass = true;
            if (opts.requireCoin1hRsi40 && coin.rsi1h[p1] < 40) pass = false;

            let buyVolRatio12 = 1.0;
            if (pass) {
              let upV = 0, dnV = 0;
              for (let k = Math.max(0, prev - 11); k <= prev; k++) {
                const b = coin.c15[k];
                const qv = b.volume * b.close;
                if (b.close >= b.open) upV += qv;
                else dnV += qv;
              }
              buyVolRatio12 = dnV > 0 ? upV / dnV : 2.0;
              if (opts.minBuyVolRatio12 !== undefined && buyVolRatio12 < opts.minBuyVolRatio12) pass = false;
            }

            let relStrength24h = 0;
            if (pass) {
              const coinRet24h = ((coin.c15[prev].close - coin.c15[Math.max(0, prev - 96)].open) / coin.c15[Math.max(0, prev - 96)].open) * 100;
              relStrength24h = coinRet24h - macro.btcRet24h;
              if (opts.minRelStrengthVsBtc24h !== undefined && relStrength24h < opts.minRelStrengthVsBtc24h) pass = false;
            }

            let upperSpreadPct = 0;
            if (pass) {
              upperSpreadPct = ((coin.m200[prev] - coin.m75[prev]) / coin.m200[prev]) * 100;
              if (opts.maxUpperRibbonSpreadPct !== undefined && upperSpreadPct > opts.maxUpperRibbonSpreadPct) pass = false;
            }

            if (pass) {
              const fillPrice = Math.min(c.open, limitP);
              const score =
                opts.rankBy === "COMPOSITE_QUALITY"
                  ? Math.min(3, buyVolRatio12) * 20 + Math.max(-5, Math.min(10, relStrength24h)) * 3 - upperSpreadPct * 10
                  : coin.rsi15[prev];
              candidates.push({
                symbol: coin.symbol,
                entryPrice: fillPrice,
                barLow: c.low,
                barHigh: c.high,
                barClose: c.close,
                score,
              });
            }
          }
        }

        if (st.waitingPullback && (t >= st.pullbackExpiryTime || coin.m8[idx] < coin.m16[idx])) {
          st.waitingPullback = false;
        }

        const isBottomFan =
          coin.m4[idx] < coin.m8[idx] &&
          coin.m8[idx] < coin.m16[idx] &&
          coin.m16[idx] < coin.m25[idx] &&
          coin.m25[idx] < coin.m75[idx] &&
          coin.m75[idx] < coin.m200[idx];

        if (isBottomFan) {
          st.hadBottomFan = true;
          st.fanExpiryTime = t + 20 * 900;
          st.bottomLow = Math.min(st.bottomLow, c.low);
        }
        if (t > st.fanExpiryTime && !st.waitingPullback && !isHeld) {
          st.hadBottomFan = false;
          st.bottomLow = Infinity;
        }

        const is8Cross16Up = coin.m8[idx - 1] <= coin.m16[idx - 1] && coin.m8[idx] > coin.m16[idx];
        if (!isHeld && !st.waitingPullback && st.hadBottomFan && is8Cross16Up) {
          const rsiOk = coin.rsi15[idx] >= 35 && coin.rsi15[idx] > coin.rsi15[idx - 1];
          const macdOk = coin.macdHist15[idx] > coin.macdHist15[idx - 1];
          if (rsiOk && macdOk) {
            st.waitingPullback = true;
            st.waitFromTime = t;
            st.pullbackExpiryTime = t + 12 * 900;
          }
        }
      }

      // 3. Allocate free slots
      const freeSlots = maxSlots - activePositions.length;
      if (freeSlots > 0 && candidates.length > 0) {
        candidates.sort((a, b) => b.score - a.score);
        const chosen = candidates.slice(0, freeSlots);
        for (const ch of chosen) {
          const currentFree = maxSlots - activePositions.length;
          const alloc = cash / currentFree;
          if (alloc < 1.0) continue;
          cash -= alloc;
          const qty = (alloc * (1 - costPerFill)) / ch.entryPrice;
          activePositions.push({
            symbol: ch.symbol,
            entryTime: t,
            entryPrice: ch.entryPrice,
            allocatedCapital: alloc,
            qty,
            troughPrice: Math.min(ch.entryPrice, ch.barLow),
            peakPrice: Math.max(ch.entryPrice, ch.barHigh),
            lastKnownPrice: ch.barClose,
            beLocked: false,
            tp1Done: false,
            realizedProceeds: 0,
          });
          const st = states.get(ch.symbol)!;
          st.waitingPullback = false;
          st.hadBottomFan = false;
        }
      }

      // 4. Mark to market
      let openVal = 0;
      for (const pos of activePositions) {
        openVal += pos.qty * pos.lastKnownPrice;
      }
      const eq = cash + openVal;
      if (eq > peakEquity) peakEquity = eq;
      const dd = ((peakEquity - eq) / peakEquity) * 100;
      if (dd > maxDdPct) maxDdPct = dd;
    }

    // Force MTM at end
    for (const pos of activePositions) {
      const finalProceeds = pos.qty * pos.lastKnownPrice * (1 - costPerFill);
      cash += finalProceeds;
      const totalProceeds = pos.realizedProceeds + finalProceeds;
      const netPnlPct = ((totalProceeds - pos.allocatedCapital) / pos.allocatedCapital) * 100;
      const maePct = ((pos.troughPrice - pos.entryPrice) / pos.entryPrice) * 100;
      completedTrades.push({
        symbol: pos.symbol,
        entryTime: pos.entryTime,
        exitTime: endT,
        entryPrice: pos.entryPrice,
        exitPrice: pos.lastKnownPrice,
        pnlPct: netPnlPct,
        maePct,
        holdHours: (endT - pos.entryTime) / 3600,
        isWin: netPnlPct > 0,
        exitReason: "END_OF_PERIOD_MTM",
      });
    }

    const netPnlQuote = cash - initialCapital;
    const netPnlPct = (netPnlQuote / initialCapital) * 100;
    const wins = completedTrades.filter((x) => x.isWin);
    const losses = completedTrades.filter((x) => !x.isWin);
    const sumW = wins.reduce((s, x) => s + x.pnlPct, 0);
    const sumL = Math.abs(losses.reduce((s, x) => s + x.pnlPct, 0));
    const profitFactor = sumL > 0 ? Number((sumW / sumL).toFixed(2)) : (sumW > 0 ? 99 : 0);
    const winRate = completedTrades.length > 0 ? Number(((wins.length / completedTrades.length) * 100).toFixed(1)) : 0;
    const avgHoldHours = completedTrades.length > 0 ? Number((completedTrades.reduce((s, x) => s + x.holdHours, 0) / completedTrades.length).toFixed(1)) : 0;
    const avgMaePct = completedTrades.length > 0 ? Number((completedTrades.reduce((s, x) => s + x.maePct, 0) / completedTrades.length).toFixed(2)) : 0;
    const calmarRatio = maxDdPct > 0 ? Number((netPnlPct / maxDdPct).toFixed(2)) : 0;

    return {
      initialCapital,
      finalEquity: Number(cash.toFixed(2)),
      netPnlQuote: Number(netPnlQuote.toFixed(2)),
      netPnlPct: Number(netPnlPct.toFixed(2)),
      maxDrawdownPct: Number(maxDdPct.toFixed(2)),
      calmarRatio,
      profitFactor,
      totalTrades: completedTrades.length,
      winningTrades: wins.length,
      losingTrades: losses.length,
      winRate,
      avgHoldHours,
      avgMaePct,
      btcBuyHoldPct: Number(btcBuyHoldPct.toFixed(2)),
      alphaVsBtcPct: Number((netPnlPct - btcBuyHoldPct).toFixed(2)),
      trades: completedTrades,
    };
  }

  /**
   * Universal Wrapper: Runs Multi-Slot MA-Fan Portfolio simulation and formats the results into
   * a standardized MultiPairRotationResult for seamless display in the Rotation Backtest Studio.
   */
  public static async runMaFanPortfolioRotationWrapper(
    opts: MultiPairRotationOptions
  ): Promise<MultiPairRotationResult> {
    const quote = opts.quoteAsset === "USD" ? "USD" : (opts.quoteAsset === "FDUSD" ? "FDUSD" : "USDT");
    const simLimit = Math.max(500, opts.limit || 4000);
    const initialCapital = Math.max(10, opts.initialCapital || 200);
    const maxSlots = Math.max(1, opts.maxSlots || 3);

    this.rotationBtProgress = {
      phase: "fetching_universe",
      completed: 5,
      total: 100,
      currentSymbol: "",
      message: `กำลังโหลดข้อมูลตลาดสำหรับ Universe ${quote} (Top ${opts.maxUniversePairs || 50})...`,
    };

    const universeCandlesMap = await this.fetchTopUniverseCandles({
      quoteAsset: quote,
      maxPairs: opts.maxUniversePairs || 50,
      limit: simLimit,
      customWhitelist: opts.customWhitelist,
      blacklist: opts.blacklist,
      onProgress: (p) => {
        this.rotationBtProgress = { phase: "fetching_universe", ...p };
      },
    });

    if (universeCandlesMap.size === 0) {
      throw new Error(`Failed to load universe candles for ${quote}`);
    }

    const isAlpaca = quote === "USD";
    const btcSym = isAlpaca ? "SPY" : (quote === "FDUSD" ? "BTCFDUSD" : "BTCUSDT");
    let btcCandles = universeCandlesMap.get(btcSym);
    if (!btcCandles || btcCandles.length < 500) {
      btcCandles = isAlpaca
        ? await this.fetchAlpacaCandles("SPY", "5m", simLimit + 600)
        : await this.fetchBinanceCandles("BTCUSDT", "5m", simLimit + 600);
    }

    const excludeMemes = opts.excludeToxicMemes !== false;
    const universe: { symbol: string; candles: Candle[] }[] = [];
    for (const [symbol, candles] of universeCandlesMap.entries()) {
      if (candles && candles.length >= 500) {
        if (excludeMemes) {
          const lastClose = candles[candles.length - 1]?.close || 1;
          if (isToxicMemeOrPenny(symbol, lastClose)) {
            continue;
          }
        }
        universe.push({ symbol, candles });
      }
    }

    this.rotationBtProgress = {
      phase: "simulating",
      completed: 60,
      total: 100,
      currentSymbol: "PORTFOLIO",
      message: `กำลังจำลองพอร์ต MA-Fan Sniper (${universe.length} เหรียญ, ${maxSlots} ช่อง)...`,
    };

    const isNoTp1 = opts.tp1TargetMode === "none";
    const tp1Target = isNoTp1 ? undefined : (opts.tp1TargetMode === "EMA75" ? "EMA75" : "EMA200");
    const disasterSl = opts.maxDisasterSlPct !== undefined && !isNaN(Number(opts.maxDisasterSlPct))
      ? Number(opts.maxDisasterSlPct)
      : 3.5;

    const simResult = this.runMaFanPortfolioSimulation({
      universe,
      btcCandles,
      maxSlots,
      initialCapital,
      requireCoin1hRsi40: true,
      minBuyVolRatio12: 1.3,
      minRelStrengthVsBtc24h: -1.0,
      rankBy: opts.rankBy || "COMPOSITE_QUALITY",
      tp1TargetMode: tp1Target,
      lockBreakevenAtEma200: isNoTp1 ? false : (opts.lockBreakevenAtEma200 !== false),
      partialTpAtEma200: isNoTp1 ? false : (opts.partialTpAtEma200 !== false),
      maxDisasterSlPct: disasterSl,
      downtrendSitOutMode: opts.downtrendSitOutMode ?? "dual",
    });

    this.rotationBtProgress = {
      phase: "formatting",
      completed: 90,
      total: 100,
      currentSymbol: "",
      message: "กำลังประมวลผลสถิติและไทม์ไลน์พอร์ต...",
    };

    // Convert trades to legs
    const legs: RotationLegRecord[] = [];
    const allTrades: Array<BacktestTrade & { symbol: string; legIndex: number }> = [];

    const slotCapital = initialCapital / maxSlots;

    for (let i = 0; i < simResult.trades.length; i++) {
      const t = simResult.trades[i];
      const legIndex = i + 1;
      const coinCandles = universeCandlesMap.get(t.symbol) || [];
      const legCandles = coinCandles.filter((c) => c.time >= t.entryTime - 3600 * 4 && c.time <= t.exitTime + 3600 * 2);

      const netPnlQuote = Number(((t.pnlPct / 100) * slotCapital).toFixed(2));
      const bTrade: BacktestTrade = {
        id: legIndex,
        entryTime: t.entryTime,
        entryPrice: t.entryPrice,
        stopLossPrice: t.entryPrice * 0.88,
        fanSpreadAtEntry: 0.5,
        exitTime: t.exitTime,
        exitPrice: t.exitPrice,
        exitType: t.exitReason,
        pnlQuote: netPnlQuote,
        pnlPct: Number(t.pnlPct.toFixed(2)),
        holdingBars: Math.round(t.holdHours * 12),
        costQuote: Number((slotCapital * 0.0017).toFixed(2)),
      };

      allTrades.push({ ...bTrade, symbol: t.symbol, legIndex });

      const markers: BacktestMarker[] = [
        {
          time: t.entryTime,
          position: "belowBar",
          color: "#10b981",
          shape: "arrowUp",
          text: `🟢 BUY @ $${t.entryPrice.toFixed(4)}`,
        },
        {
          time: t.exitTime,
          position: "aboveBar",
          color: t.isWin ? "#38bdf8" : "#f43f5e",
          shape: "arrowDown",
          text: `${t.isWin ? "🎯" : "🛑"} ${t.exitReason} @ $${t.exitPrice.toFixed(4)} (${t.pnlPct >= 0 ? "+" : ""}${t.pnlPct.toFixed(2)}%)`,
        },
      ];

      legs.push({
        legIndex,
        symbol: t.symbol,
        startTime: t.entryTime,
        endTime: t.exitTime,
        durationHours: Number(t.holdHours.toFixed(1)),
        triggerReason: i === 0 ? "INITIAL_SELECTION" : "POST_ROUND_EXIT",
        entryScore: 85,
        startingCapital: Number(slotCapital.toFixed(2)),
        endingCapital: Number((slotCapital + netPnlQuote).toFixed(2)),
        netPnlQuote,
        netPnlPct: Number(t.pnlPct.toFixed(2)),
        tradesCount: 1,
        winCount: t.isWin ? 1 : 0,
        lossCount: t.isWin ? 0 : 1,
        winRate: t.isWin ? 100 : 0,
        maxDrawdownPct: Number(Math.abs(Math.min(0, t.maePct)).toFixed(2)),
        topCandidatesSnapshot: [],
        trades: [bTrade],
        candles: legCandles,
        markers,
      });
    }

    // Per-pair contribution
    const pairMap = new Map<string, { legsCount: number; hours: number; tradesCount: number; wins: number; pnlQuote: number; pnlPctSum: number }>();
    for (const t of simResult.trades) {
      let p = pairMap.get(t.symbol);
      if (!p) {
        p = { legsCount: 0, hours: 0, tradesCount: 0, wins: 0, pnlQuote: 0, pnlPctSum: 0 };
        pairMap.set(t.symbol, p);
      }
      p.legsCount++;
      p.hours += t.holdHours;
      p.tradesCount++;
      if (t.isWin) p.wins++;
      p.pnlPctSum += t.pnlPct;
      p.pnlQuote += (t.pnlPct / 100) * slotCapital;
    }

    const pairContributions: PairContributionItem[] = Array.from(pairMap.entries()).map(([symbol, d]) => ({
      symbol,
      legsCount: d.legsCount,
      totalHoursHeld: Number(d.hours.toFixed(1)),
      tradesCount: d.tradesCount,
      winRate: Number(((d.wins / d.tradesCount) * 100).toFixed(1)),
      totalNetPnlQuote: Number(d.pnlQuote.toFixed(2)),
      totalNetPnlPct: Number(d.pnlPctSum.toFixed(2)),
    })).sort((a, b) => b.totalNetPnlQuote - a.totalNetPnlQuote);

    // Build equity curve
    let runningEquity = initialCapital;
    let peakEq = initialCapital;
    const sortedTrades = [...simResult.trades].sort((a, b) => a.exitTime - b.exitTime);
    const equityCurve: Array<{ time: number; equity: number; symbol: string; drawdownPct: number }> = [
      {
        time: sortedTrades[0]?.entryTime ? sortedTrades[0].entryTime - 900 : Math.floor(Date.now() / 1000) - simLimit * 300,
        equity: initialCapital,
        symbol: "PORTFOLIO",
        drawdownPct: 0,
      },
    ];

    for (const st of sortedTrades) {
      runningEquity += (st.pnlPct / 100) * slotCapital;
      if (runningEquity > peakEq) peakEq = runningEquity;
      const dd = ((peakEq - runningEquity) / peakEq) * 100;
      equityCurve.push({
        time: st.exitTime,
        equity: Number(runningEquity.toFixed(2)),
        symbol: st.symbol,
        drawdownPct: Number(dd.toFixed(2)),
      });
    }

    const result: MultiPairRotationResult = {
      id: `mafan_rot_${Date.now()}`,
      createdAt: Date.now(),
      options: { ...opts, portfolioMode: "mafan_portfolio" },
      summary: {
        quoteAsset: quote,
        universeScannedCount: universe.length,
        initialCapital: simResult.initialCapital,
        finalEquity: simResult.finalEquity,
        netPnlQuote: simResult.netPnlQuote,
        netPnlPct: simResult.netPnlPct,
        totalRotations: simResult.trades.length,
        totalLegs: simResult.trades.length,
        profitableLegs: simResult.winningTrades,
        legWinRate: simResult.winRate,
        totalTrades: simResult.totalTrades,
        winningTrades: simResult.winningTrades,
        losingTrades: simResult.losingTrades,
        tradeWinRate: simResult.winRate,
        maxPortfolioDrawdownPct: simResult.maxDrawdownPct,
        profitFactor: simResult.profitFactor,
        totalFeesPaid: Number((simResult.totalTrades * 2 * slotCapital * 0.00075).toFixed(2)),
        bestPairSymbol: pairContributions[0]?.symbol ?? "-",
        bestPairPnlPct: pairContributions[0]?.totalNetPnlPct ?? 0,
        benchmarkSinglePairSymbol: quote === "USD" ? "SPY" : "BTC",
        benchmarkSinglePairPnlPct: simResult.btcBuyHoldPct,
        benchmarkBtcBuyHoldPct: simResult.btcBuyHoldPct,
        alphaVsBenchmarkPct: simResult.alphaVsBtcPct,
      },
      legs,
      pairContributions,
      equityCurve,
      allTrades,
    };

    this.latestRotationResult = result;
    this.rotationBtProgress = {
      phase: "idle",
      completed: 100,
      total: 100,
      currentSymbol: "",
      message: `MA-Fan Portfolio Simulation complete: +${simResult.netPnlPct.toFixed(2)}% net profit`,
    };

    return result;
  }
}
