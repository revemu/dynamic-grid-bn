/**
 * Backtest Service & Dedicated Simulation Engine
 * Runs historical simulations for MA Fan Sniper & Dynamic Strategies,
 * persists backtest runs, and generates TradingView chart markers.
 */

import fs from "fs";
import path from "path";
import { Candle, RibbonEngine, ExhaustionEngine, AutoCalibrator, RollingSpreadCalibrator, MaFanCoreRules, RegimeSupervisor, CushionMode, RibbonState, ExhaustionState, WaterfallGuardMode } from "./strategy/ma-fan/index.js";
import { calcATR } from "./strategy/ma-fan/ribbon.js";
import { DowStructureEngine } from "./market-structure.js";

export const STABLE_TOKENS = new Set([
  "USDC", "FDUSD", "TUSD", "BUSD", "EUR", "DAI", "AEUR", "USDP", "USD1", "RLUSD", "EURI", "USTC", "WBTC", "WBETH",
]);

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
  exitType: "TP1+TP2" | "TP1+SL_BE" | "RATCHET_SL" | "SL" | "TECH_FAST_CUT" | "OPEN" | "TP1+OPEN" | "GRID_TP" | "GRID_CUT";
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
}

export interface MarketScanOptions {
  scope?: "top20" | "top30" | "top50" | "top100" | "fdusd" | "usdt" | "all";
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
}

export interface MultiPairRotationOptions {
  quoteAsset: "FDUSD" | "USDT";
  maxUniversePairs?: number;
  customWhitelist?: string[];
  blacklist?: string[];
  timeframe?: string;
  limit?: number;
  initialCapital?: number;
  rotationIntervalMinutes?: number;
  rotationIdleCashMinutes?: number;
  rotationScoreMarginPct?: number;
  minVolumeUsd?: number;
  capitalZones?: number;
  channelMode?: "DOW_SWINGS" | "DOW_ATR_CLAMP" | "FIXED_PCT_CLAMP" | "DONCHIAN_ATR" | "VOLUME_PROFILE_HTF";
  minChannelWidthPct?: number;
  maxChannelWidthPct?: number;
  zoneMinDropPct?: number;
  zoneStabilizeCandles?: number;
  lockChannelInPosition?: boolean;
  enableBaseConfirmation?: boolean;
  enableDipHunterEntryGuard?: boolean;
  enableSignalInvalidationExit?: boolean;
  gridCutLossMode?: "none" | "entry_floor" | "final_zone_floor";
}

export interface RotationLegRecord {
  legIndex: number;
  symbol: string;
  startTime: number;
  endTime: number;
  durationHours: number;
  triggerReason: "INITIAL_SELECTION" | "POST_ROUND_EXIT" | "IDLE_CASH_TIMEOUT" | "SIGNAL_DISQUALIFIED";
  entryScore: number;
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
    netPnlPct: number;
    winRate: number;
    range24hPct: number;
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
}

export interface MultiPairRotationResult {
  id: string;
  createdAt: number;
  options: MultiPairRotationOptions;
  summary: {
    quoteAsset: "FDUSD" | "USDT";
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
    alphaVsBenchmarkPct: number;
  };
  legs: RotationLegRecord[];
  pairContributions: PairContributionItem[];
  equityCurve: Array<{ time: number; equity: number; symbol: string; drawdownPct: number }>;
  allTrades: Array<BacktestTrade & { symbol: string; legIndex: number }>;
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
          const age = nowMs - (parsed.timestamp || 0);
          if (age < 900_000) { // Fresh within 15 minutes
            console.log(`[CandleFeed] 💾 Disk Cache HIT for ${cleanSym} (${interval}) -> using ${parsed.candles.length} candles`);
            this.candleCache.set(cacheKey, { timestamp: parsed.timestamp, candles: parsed.candles });
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
        fs.writeFileSync(diskPath, JSON.stringify({ timestamp: nowMs, candles: sorted }), "utf8");
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
  lockChannelInPosition?: boolean;
      channelMode?: "DOW_SWINGS" | "DOW_ATR_CLAMP" | "FIXED_PCT_CLAMP" | "DONCHIAN_ATR" | "VOLUME_PROFILE_HTF";
      donchianPeriod?: number;
      minChannelWidthPct?: number;
      maxChannelWidthPct?: number;
      floorBufferPct?: number;
      capitalZones?: number;
      zoneStabilizeCandles?: number;
      zoneMinDropPct?: number;
      gridCutLossMode?: "none" | "entry_floor" | "final_zone_floor";
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
    const cm = opts.costModel ?? { feePctPerSide: 0.075, slippagePctPerFill: 0.01 };
    const costPerFill = (cm.feePctPerSide + cm.slippagePctPerFill) / 100;

    const totalZones = Math.max(1, Math.min(5, opts.capitalZones ?? 2));
    const zoneStabilizeCandles = Math.max(1, opts.zoneStabilizeCandles ?? 3);
    const zoneMinDropPct = Math.max(0.5, opts.zoneMinDropPct ?? 2.5);
    const gridCutLossMode = opts.gridCutLossMode ?? "none";
    const zoneExitMode = opts.zoneExitMode ?? "PORTFOLIO_AVG";
    const minNetProfitPct = Math.max(0.15, opts.minNetProfitPct ?? 0.25);
    const roundtripFeePct = costPerFill * 2 * 100;
    const effectiveMinProfitPct = Math.max(minNetProfitPct, roundtripFeePct + 0.20);
    const zoneBudgetQuote = maxInventory / totalZones;

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
      targetPrice: number;
      costQuote: number;
      floorAtEntry?: number;
      ceilingAtEntry?: number;
      centerAtEntry?: number;
    }> = [];

    const trades: BacktestTrade[] = [];
    const markers: BacktestMarker[] = [];
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

      const structure = dow.getStructure(c.close, undefined, {
        useOnlyClosedCandles: true,
        mode: opts.channelMode ?? "DONCHIAN_ATR",
        donchianLookback: opts.donchianPeriod ?? 48,
        minChannelWidthPct: opts.minChannelWidthPct ?? 6.0,
        maxChannelWidthPct: opts.maxChannelWidthPct ?? 20.0,
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
        stableFloorCandleCount = 0;
        prevCandidateFloor = undefined;
        lastZoneUnlockFloor = undefined;
        lockedChannel = null;

        floor = structure.bottomBound;
        ceiling = structure.upperBound;
        center = structure.centerPrice;
        channelSpan = ceiling - floor;
        if (channelSpan <= 0) continue;

        buyLevels = [
          floor + channelSpan * 0.45,
          floor + channelSpan * 0.33,
          floor + channelSpan * 0.20,
          floor + channelSpan * 0.08,
        ];
        sellTargets = [
          floor + channelSpan * 0.55,
          floor + channelSpan * 0.68,
          floor + channelSpan * 0.80,
          floor + channelSpan * 0.92,
        ];
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
            }
            floor = candidateFloor;
            ceiling = structure.upperBound;
            center = structure.centerPrice;
            channelSpan = ceiling - floor;
            buyLevels = [
              floor + channelSpan * 0.45,
              floor + channelSpan * 0.33,
              floor + channelSpan * 0.20,
              floor + channelSpan * 0.08,
            ];
            sellTargets = [
              floor + channelSpan * 0.55,
              floor + channelSpan * 0.68,
              floor + channelSpan * 0.80,
              floor + channelSpan * 0.92,
            ];
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
          buyLevels = [
            floor + channelSpan * 0.45,
            floor + channelSpan * 0.33,
            floor + channelSpan * 0.20,
            floor + channelSpan * 0.08,
          ];
          sellTargets = [
            floor + channelSpan * 0.55,
            floor + channelSpan * 0.68,
            floor + channelSpan * 0.80,
            floor + channelSpan * 0.92,
          ];
          activeChannel = { floor, ceiling, center, channelSpan, buyLevels: [...buyLevels], sellTargets: [...sellTargets] };
          stableFloorCandleCount = 0;
        }

        // Dynamic Trailing: when channel moves while holding lots, update sell targets ensuring min profit hurdle!
        if (isHoldingPosition) {
          const totalHeldQty = heldLots.reduce((sum, l) => sum + l.qty, 0);
          const totalInvestQuote = heldLots.reduce((sum, l) => sum + (l.qty * l.buyPrice), 0);
          const avgEntry = totalHeldQty > 0 ? (totalInvestQuote / totalHeldQty) : 0;

          for (const lot of heldLots) {
            if (zoneExitMode === "ORIGINAL_TARGETS" && lot.targetPrice > 0) {
              continue;
            }
            const lotSafeBase = Math.max(avgEntry, lot.buyPrice);
            const lotMinProfitTarget = lotSafeBase * (1 + effectiveMinProfitPct / 100);
            const dynamicTarget = sellTargets[lot.index] ?? (lotSafeBase * 1.015);
            lot.targetPrice = Math.max(dynamicTarget, lotMinProfitTarget);
          }
        }
      }

      const floorBuf = opts.floorBufferPct ?? 0.0;
      const cutLossPrice = floorBuf > 0 ? floor * (1 - floorBuf / 100) : floor * 0.985;
      const canTriggerCutLoss =
        gridCutLossMode !== "none" &&
        (gridCutLossMode === "entry_floor" || unlockedCapitalZones >= totalZones);

      // 1. Evaluate Sells & Cut Losses for Open Lots
      const remainingLots: typeof heldLots = [];
      for (const lot of heldLots) {
        // Take Profit Hit
        if (c.high >= lot.targetPrice) {
          const exitPrice = lot.targetPrice;
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
            stopLossPrice: cutLossPrice,
            fanSpreadAtEntry: 0,
            exitTime: c.time,
            exitPrice,
            exitType: "GRID_TP",
            pnlQuote,
            pnlPct,
            holdingBars: i - (candles.findIndex((x) => x.time === lot.entryTime) || i),
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
            color: "#a855f7",
            shape: "arrowDown",
            text: `🟣 GRID SELL #${lot.id} (L${lot.index + 1}${lot.zoneIndex ? ` Z${lot.zoneIndex}` : ''}) @ $${exitPrice.toFixed(4)} (+${pnlPct.toFixed(2)}%)`,
          });
          continue;
        }

        // Cut Loss Hit
        if (canTriggerCutLoss && c.low <= cutLossPrice) {
          const exitPrice = cutLossPrice;
          const proceeds = lot.qty * exitPrice * (1 - costPerFill);
          const invest = lot.qty * lot.buyPrice;
          const pnlQuote = proceeds - invest;
          const pnlPct = invest > 0 ? (pnlQuote / invest) * 100 : 0;
          cash += proceeds;
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
            holdingBars: i - (candles.findIndex((x) => x.time === lot.entryTime) || i),
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

      // 1.5 Evaluate Signal Invalidation Check while holding lots (Checked every 12 bars = 1 hour)
      if (isTradingActive && opts.onSignalInvalidationCheck && heldLots.length > 0 && i % 12 === 0) {
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
        // We ONLY invoke onSignalInvalidationCheck if price structurally breaks below the channel floor (1.8% buffer)
        // or suffers catastrophic collapse below 24h rock bottom (posRatio < 0.05 and unrealizedPnl < -5.0%).
        const isFloorBreak = c.close < floor * 0.982;
        const isCatastrophicDump = posRatio24h < 0.05 && unrealizedPnlPct < -5.0;
        const isDanger = isFloorBreak || isCatastrophicDump;
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
      const effectiveMaxInventory = zoneBudgetQuote * unlockedCapitalZones;
      const currentInventory = heldLots.reduce((sum, l) => sum + (l.qty * l.buyPrice), 0);
      const trancheQuote = zoneBudgetQuote / 4;
      const isHlWaiting = opts.enableBaseConfirmationFilter === true && (
        structure.gridZone?.canEstablishChannel === false ||
        Boolean(structure.isDowntrendDropActive)
      );

      // Dip Hunter Entry Absorption Guard
      let passesDipHunterGuard = true;
      if (opts.enableDipHunterEntryGuard !== false) {
        const isWaterfall = consecutiveReds >= 4;
        const candleRange = c.high - c.low;
        const lowerWick = Math.min(c.open, c.close) - c.low;
        const lowerWickPct = candleRange > 0 ? (lowerWick / candleRange) * 100 : 0;
        const isGreenCandle = c.close >= c.open;
        const prevCandle = i > 0 ? candles[i - 1] : c;
        const isNoFallingKnife = c.low >= prevCandle.low;

        let isBad24hDrop = false;
        if (i >= 288) {
          const c24 = candles[i - 288];
          const change24hPct = ((c.close - c24.open) / c24.open) * 100;
          if (change24hPct < -5.5) isBad24hDrop = true;
        }

        const hasAbsorption = isGreenCandle || lowerWickPct >= 15 || (isNoFallingKnife && lowerWickPct >= 8);
        if (isWaterfall || isBad24hDrop || !hasAbsorption) {
          passesDipHunterGuard = false;
        }
      }

      const maxLotsForUnlockedZones = unlockedCapitalZones * 4;
      if (isTradingActive && !isHlWaiting && passesDipHunterGuard && currentInventory + trancheQuote <= effectiveMaxInventory && cash >= trancheQuote && heldLots.length < maxLotsForUnlockedZones) {
        for (let lvlIdx = 0; lvlIdx < buyLevels.length; lvlIdx++) {
          const bl = buyLevels[lvlIdx];
          const alreadyFilledInCurrentZone = heldLots.some((l) => (l.zoneIndex ?? 1) === unlockedCapitalZones && l.index === lvlIdx);
          if (!alreadyFilledInCurrentZone && c.low <= bl && (!canTriggerCutLoss || c.close >= cutLossPrice)) {
            tradeCounter++;
            const buyPrice = bl;
            const invest = trancheQuote;
            const fillQty = (invest / buyPrice) * (1 - costPerFill);
            cash -= invest;

            const totalHeldQtyBefore = heldLots.reduce((sum, l) => sum + l.qty, 0);
            const totalInvestBefore = heldLots.reduce((sum, l) => sum + (l.qty * l.buyPrice), 0);
            const newAvgEntry = (totalInvestBefore + invest) / (totalHeldQtyBefore + fillQty);
            const lotSafeBase = Math.max(newAvgEntry, buyPrice);
            const minProfitHurdle = lotSafeBase * (1 + effectiveMinProfitPct / 100);

            const rawTarget = sellTargets[lvlIdx] ?? (buyPrice * 1.015);
            const targetPrice = Math.max(rawTarget, minProfitHurdle);

            heldLots.push({
              id: tradeCounter,
              index: lvlIdx,
              zoneIndex: unlockedCapitalZones,
              qty: fillQty,
              buyPrice,
              entryTime: c.time,
              targetPrice,
              costQuote: invest * costPerFill,
              floorAtEntry: floor,
              ceilingAtEntry: ceiling,
              centerAtEntry: center,
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
            break;
          }
        }
      }

      // Equity curve & drawdown
      const currentInvVal = heldLots.reduce((sum, l) => sum + (l.qty * c.close), 0);
      const curEquity = cash + currentInvVal;
      if (curEquity > peakEquity) peakEquity = curEquity;
      const dd = peakEquity > 0 ? ((peakEquity - curEquity) / peakEquity) * 100 : 0;
      if (dd > maxDrawdownPct) maxDrawdownPct = dd;
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
        holdingBars: processedCandles.length - 1 - (processedCandles.findIndex((x) => x.time === lot.entryTime) || 0),
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
      lockChannelInPosition?: boolean;
      channelMode?: "DOW_SWINGS" | "DOW_ATR_CLAMP" | "FIXED_PCT_CLAMP" | "DONCHIAN_ATR" | "VOLUME_PROFILE_HTF";
      donchianPeriod?: number;
      minChannelWidthPct?: number;
      maxChannelWidthPct?: number;
      floorBufferPct?: number;
      capitalZones?: number;
      zoneStabilizeCandles?: number;
      zoneMinDropPct?: number;
      gridCutLossMode?: "none" | "entry_floor" | "final_zone_floor";
      zoneExitMode?: "PORTFOLIO_AVG" | "ORIGINAL_TARGETS" | "PER_ZONE";
      minNetProfitPct?: number;
    }
  ): BacktestRecord {
    const symbol = opts.symbol.toUpperCase().replace(/[\/\-_:]/g, "");
    const timeframe = opts.timeframe || "5m";
    const initialCapital = opts.initialCapital ?? 200;
    const gridCapPct = opts.gridCapitalPct ?? 60;
    const sniperCapPct = opts.sniperCapitalPct ?? 40;
    const gridInitialCap = initialCapital * (gridCapPct / 100);
    const sniperInitialCap = initialCapital * (sniperCapPct / 100);

    const cm = opts.costModel ?? { feePctPerSide: 0.075, slippagePctPerFill: 0.01 };
    const costPerFill = (cm.feePctPerSide + cm.slippagePctPerFill) / 100;
    const tradeDirection = opts.tradeDirection ?? "both";

    const totalZones = Math.max(1, Math.min(5, opts.capitalZones ?? 2));
    const zoneStabilizeCandles = Math.max(1, opts.zoneStabilizeCandles ?? 3);
    const zoneMinDropPct = Math.max(0.5, opts.zoneMinDropPct ?? 2.5);
    const gridCutLossMode = opts.gridCutLossMode ?? "none";
    const zoneExitMode = opts.zoneExitMode ?? "PORTFOLIO_AVG";
    const minNetProfitPct = Math.max(0.15, opts.minNetProfitPct ?? 0.25);
    const zoneBudgetQuote = gridInitialCap / totalZones;

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
        stableFloorCandleCount = 0;
        prevCandidateFloor = undefined;
        lastZoneUnlockFloor = undefined;
        lockedChannel = null;

        floor = structure.bottomBound;
        ceiling = structure.upperBound;
        center = structure.centerPrice;
        channelSpan = ceiling - floor;
        buyLevels = [
          floor + channelSpan * 0.45,
          floor + channelSpan * 0.33,
          floor + channelSpan * 0.20,
          floor + channelSpan * 0.08,
        ];
        sellTargets = [
          floor + channelSpan * 0.55,
          floor + channelSpan * 0.68,
          floor + channelSpan * 0.80,
          floor + channelSpan * 0.92,
        ];
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
            }
            floor = candidateFloor;
            ceiling = structure.upperBound;
            center = structure.centerPrice;
            channelSpan = ceiling - floor;
            buyLevels = [
              floor + channelSpan * 0.45,
              floor + channelSpan * 0.33,
              floor + channelSpan * 0.20,
              floor + channelSpan * 0.08,
            ];
            sellTargets = [
              floor + channelSpan * 0.55,
              floor + channelSpan * 0.68,
              floor + channelSpan * 0.80,
              floor + channelSpan * 0.92,
            ];
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
          buyLevels = [
            floor + channelSpan * 0.45,
            floor + channelSpan * 0.33,
            floor + channelSpan * 0.20,
            floor + channelSpan * 0.08,
          ];
          sellTargets = [
            floor + channelSpan * 0.55,
            floor + channelSpan * 0.68,
            floor + channelSpan * 0.80,
            floor + channelSpan * 0.92,
          ];
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

        // ── 2. EVALUATE GRID BUYS ──
        const effectiveMaxInventory = zoneBudgetQuote * unlockedCapitalZones;
        const trancheQuote = zoneBudgetQuote / 4;
        const currentGridInv = heldLots.reduce((s, l) => s + (l.qty * l.buyPrice), 0);
        const isHlWaiting = opts.enableBaseConfirmationFilter === true && (
          structure.gridZone?.canEstablishChannel === false ||
          Boolean(structure.isDowntrendDropActive)
        );

        if (heldLots.length === 0) {
          lockedChannel = null;
          unlockedCapitalZones = 1;
          stableFloorCandleCount = 0;
        }

        const maxLotsForUnlockedZones = unlockedCapitalZones * 4;
        if (!isHlWaiting && currentGridInv + trancheQuote <= effectiveMaxInventory && gridCash >= trancheQuote && heldLots.length < maxLotsForUnlockedZones) {

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
      gridCutLossMode?: "none" | "entry_floor" | "final_zone_floor";
      zoneExitMode?: "PORTFOLIO_AVG" | "ORIGINAL_TARGETS" | "PER_ZONE";
      minNetProfitPct?: number;
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
        gridCutLossMode: opts.gridCutLossMode,
        zoneExitMode: opts.zoneExitMode,
        minNetProfitPct: opts.minNetProfitPct,
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
        gridCutLossMode: opts.gridCutLossMode,
        zoneExitMode: opts.zoneExitMode,
        minNetProfitPct: opts.minNetProfitPct,
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

    for (let i = startIdx; i < candles.length; i++) {
      const c = candles[i]!;
      const ribbon = ribbonStates[i]!;
      const curAtr = atrs[i] ?? (c.close * 0.003);

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
        });

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
      if (heldQty === 0 && cash >= 10) {
        if (opts.onlyEntryIdx !== undefined && i !== opts.onlyEntryIdx) {
          continue;
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
    const timeframe = opts.timeframe || "5m";
    const limit = Math.min(60000, Math.max(100, opts.limit || 1000));

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

    let targetTickers = tickers.filter((t) => Number(t.quoteVolume) > 10_000 && Number(t.count) > 100);

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

    const candidates = targetTickers.slice(0, maxPairs);

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
              this.fetchBinanceCandles(sym, timeframe, fetchLimit),
              this.fetchBinanceCandles(sym, supTf, htfLimit).catch(() => []),
            ]);
            if (!candles || candles.length < 50) return;
            const actualWarmup = isAutoSpread ? Math.max(0, candles.length - limit) : 0;

            const symCostModel = opts.costModel ?? (
              sym.endsWith("FDUSD")
                ? { feePctPerSide: 0, slippagePctPerFill: 0.01 }
                : { feePctPerSide: 0.075, slippagePctPerFill: 0.01 }
            );

            const rec = this.runMaFanSimulation(candles, {
              symbol: sym,
              timeframe,
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
              minChannelWidthPct: opts.minChannelWidthPct ?? 6.0,
              maxChannelWidthPct: opts.maxChannelWidthPct ?? 25.0,
              zoneMinDropPct: opts.zoneMinDropPct ?? 2.5,
              zoneStabilizeCandles: opts.zoneStabilizeCandles ?? 3,
            });

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
   * Fetch historical 5m candles for Top N liquid pairs in FDUSD or USDT universe
   */
  public static async fetchTopUniverseCandles(opts: {
    quoteAsset: "FDUSD" | "USDT";
    maxPairs?: number;
    limit?: number;
    customWhitelist?: string[];
    blacklist?: string[];
    onProgress?: (p: { completed: number; total: number; currentSymbol: string; message: string }) => void;
  }): Promise<Map<string, Candle[]>> {
    const quote = opts.quoteAsset;
    const maxPairs = Math.max(5, Math.min(100, opts.maxPairs ?? 50));
    const candlesLimit = Math.max(500, (opts.limit ?? 4000) + 600);
    const blacklistSet = new Set((opts.blacklist ?? []).map((s) => s.toUpperCase().trim()));

    let targetSymbols: string[] = [];

    if (Array.isArray(opts.customWhitelist) && opts.customWhitelist.length > 0) {
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

      let filtered = tickers.filter((t) => {
        const sym = t.symbol.toUpperCase();
        if (!sym.endsWith(quote)) return false;
        const base = sym.slice(0, -quote.length);
        if (STABLE_TOKENS.has(base)) return false;
        if (blacklistSet.has(sym)) return false;
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

            const candles = await this.fetchBinanceCandles(sym, "5m", candlesLimit);
            if (candles && candles.length >= 300) {
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
   * Evaluate the 2-Stage Market Funnel Point-in-Time at a specific timestamp in history.
   * Completely eliminates look-ahead bias by only evaluating candles up to targetTime.
   */
  public static evaluateHistoricalFunnelAtTime(opts: {
    targetTime: number;
    universeCandles: Map<string, Candle[]>;
    activeSymbol?: string;
    quoteAsset: "FDUSD" | "USDT";
    gridOpts?: any;
  }): Array<{
    symbol: string;
    compositeScore: number;
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
    const minVol = quoteAsset === "FDUSD" ? 500_000 : 2_000_000;
    const stage1Candidates: Array<{
      symbol: string;
      idx: number;
      quoteVol24h: number;
      range24hPct: number;
      change24hPct: number;
      posRatio: number;
      activityScore: number;
    }> = [];

    // Stage 1: Point-in-Time 24h rolling window filter
    for (const [sym, candles] of universeCandles.entries()) {
      if (!candles || candles.length < 288) continue;

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

      if (idx < 287) continue;

      // Stale candle check: candle time should be within 1 hour of targetTime
      if (targetTime - candles[idx].time > 3600) continue;

      // Ensure there are at least 5 candles ahead to actually simulate
      if (candles.length - 1 - idx < 5) continue;

      const slice24h = candles.slice(idx - 287, idx + 1);
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

      // Check 4-hour return (recent 48 bars): avoid catching falling knives currently dumping
      const open4h = slice24h[Math.max(0, slice24h.length - 48)]?.open ?? open24h;
      const return4hPct = open4h > 0 ? ((lastPrice - open4h) / open4h) * 100 : 0;

      if (quoteVol24h < minVol) continue;
      if (range24hPct < 4.0 || range24hPct > 22.0) continue;
      if (change24hPct < -5.5 || change24hPct > 9.0) continue; // Capped at 9.0% to prevent buying blow-off tops
      if (posRatio < 0.10 || posRatio > 0.65) continue;
      if (return4hPct < -3.5) continue; // Reject coins in active waterfall dump over past 4 hours

      const activityScore = quoteVol24h * (range24hPct / 100);
      stage1Candidates.push({
        symbol: sym,
        idx,
        quoteVol24h,
        range24hPct,
        change24hPct,
        posRatio,
        activityScore,
      });
    }

    stage1Candidates.sort((a, b) => b.activityScore - a.activityScore);
    const topCandidates = stage1Candidates.slice(0, 6);

    if (activeSymbol && !topCandidates.some((c) => c.symbol === activeSymbol)) {
      const activeCandles = universeCandles.get(activeSymbol);
      if (activeCandles && activeCandles.length >= 288) {
        let idx = activeCandles.findIndex((c) => c.time > targetTime);
        idx = idx >= 0 ? idx - 1 : activeCandles.length - 1;
        if (idx >= 287) {
          const slice24h = activeCandles.slice(idx - 287, idx + 1);
          let high24h = -Infinity;
          let low24h = Infinity;
          let quoteVol24h = 0;
          for (const c of slice24h) {
            if (c.high > high24h) high24h = c.high;
            if (c.low < low24h) low24h = c.low;
            quoteVol24h += c.volume * c.close;
          }
          if (high24h > low24h && low24h > 0) {
            const open24h = slice24h[0].open;
            const lastPrice = slice24h[slice24h.length - 1].close;
            topCandidates.push({
              symbol: activeSymbol,
              idx,
              quoteVol24h,
              range24hPct: ((high24h - low24h) / low24h) * 100,
              change24hPct: ((lastPrice - open24h) / open24h) * 100,
              posRatio: (lastPrice - low24h) / (high24h - low24h),
              activityScore: 0,
            });
          }
        }
      }
    }

    if (topCandidates.length === 0) return [];

    const scoredCandidates: Array<{
      symbol: string;
      compositeScore: number;
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

    const symCostModel = quoteAsset === "FDUSD"
      ? { feePctPerSide: 0, slippagePctPerFill: 0.01 }
      : { feePctPerSide: 0.075, slippagePctPerFill: 0.01 };

    for (const cand of topCandidates) {
      try {
        const allSymCandles = universeCandles.get(cand.symbol);
        if (!allSymCandles) continue;

        const slice500 = allSymCandles.slice(Math.max(0, cand.idx - 499), cand.idx + 1);
        if (slice500.length < 150) continue;

        const lastBar = slice500[slice500.length - 1];

        // 🌟 RULE 1: Dow Theory Regime Filter
        // Dynamic Grid thrives in RANGE or UPTREND, but gets destroyed in DOWNTREND!
        const dow = new DowStructureEngine(3, true, 20.0, 300);
        for (const sc of slice500) {
          dow.addCandle(sc);
        }
        const struct = dow.getStructure(lastBar.close, undefined, {
          useOnlyClosedCandles: true,
          mode: gridOpts?.channelMode ?? "DONCHIAN_ATR",
        });
        if (struct.regime === "DOWNTREND") {
          continue; // Disqualify coins in confirmed Dow Theory Downtrend!
        }

        // 🌟 RULE 2: HTF Overextension Guard
        // If price is > 10% above its 24h SMA (288 bars), skip overbought blow-off tops
        const slice288 = slice500.slice(-288);
        const sma288 = slice288.reduce((s, c) => s + c.close, 0) / slice288.length;
        const distSma24hPct = ((lastBar.close - sma288) / sma288) * 100;
        if (distSma24hPct > 10.0) {
          continue;
        }

        const rec = this.runDynamicGridSimulation(slice500, {
          symbol: cand.symbol,
          timeframe: "5m",
          initialCapital: 200,
          maxInventoryQuote: 200,
          costModel: symCostModel,
          saveToHistory: false,
          capitalZones: gridOpts?.capitalZones ?? 2,
          channelMode: gridOpts?.channelMode ?? "DONCHIAN_ATR",
          minChannelWidthPct: gridOpts?.minChannelWidthPct ?? 6.0,
          maxChannelWidthPct: gridOpts?.maxChannelWidthPct ?? 25.0,
          zoneMinDropPct: gridOpts?.zoneMinDropPct ?? 2.5,
          zoneStabilizeCandles: gridOpts?.zoneStabilizeCandles ?? 3,
        });

        const summary = rec.summary;
        let simScore = 0;
        if (summary.netPnlPct > 0 && summary.maxDrawdownPct <= 22 && summary.totalTrades >= 2) {
          const pnlComponent = Math.min(25, summary.netPnlPct * 3.5 + summary.totalTrades * 1.5);
          const wrComponent = Math.min(20, Math.max(0, (summary.winRate - 50) * 0.4) + Math.max(0, 16 - summary.maxDrawdownPct));
          simScore = Math.min(45, Math.max(0, pnlComponent + wrComponent));
        }

        let structureScore = 0;
        const recentCandles = slice500.slice(-48);
        const donchianHigh = Math.max(...recentCandles.map((c) => c.high));
        const donchianLow = Math.min(...recentCandles.map((c) => c.low));
        const channelWidthPct = donchianLow > 0 ? ((donchianHigh - donchianLow) / donchianLow) * 100 : 0;

        if (channelWidthPct >= 5.5 && channelWidthPct <= 16.0) {
          structureScore += 20;
        } else if (channelWidthPct >= 16.0 && channelWidthPct <= 22.0) {
          structureScore += 10;
        }
        if (recentCandles.length >= 2 && recentCandles[recentCandles.length - 1].close > donchianLow * 1.005) {
          structureScore += 10;
        }

        let positionScore = 0;
        if (cand.posRatio >= 0.15 && cand.posRatio <= 0.40) {
          positionScore = 15; // Sweet spot for pullback accumulation!
        } else if (cand.posRatio > 0.40 && cand.posRatio <= 0.50) {
          positionScore = 5;
        } else if (cand.posRatio > 0.65) {
          positionScore = -10; // Overbought climax penalty
        }

        const prevBar = slice500.length >= 2 ? slice500[slice500.length - 2] : lastBar;
        const barRange = lastBar.high - lastBar.low;
        const lowerWick = Math.min(lastBar.open, lastBar.close) - lastBar.low;
        const hasAbsorption = barRange > 0 ? (lowerWick / barRange) >= 0.15 : false;
        const isGreen = lastBar.close >= lastBar.open;
        const isDipPullback = cand.posRatio >= 0.12 && cand.posRatio <= 0.42 && (hasAbsorption || isGreen || lastBar.close >= prevBar.close);

        const liquidityScore = Math.min(10, Math.max(0, (Math.log10(cand.quoteVol24h) - 6) * 4));
        const compositeScore = Math.round(simScore + structureScore + positionScore + liquidityScore);

        scoredCandidates.push({
          symbol: cand.symbol,
          compositeScore,
          simScore: Math.round(simScore),
          structureScore: Math.round(structureScore),
          positionScore: Math.round(positionScore),
          liquidityScore: Math.round(liquidityScore),
          netPnlPct: Number(summary.netPnlPct.toFixed(2)),
          winRate: Number(summary.winRate.toFixed(1)),
          range24hPct: Number(cand.range24hPct.toFixed(1)),
          quoteVol24h: cand.quoteVol24h,
          posRatio: Number(cand.posRatio.toFixed(3)),
          isDipPullback,
        });
      } catch (err: any) {
        console.warn(`[RotationBacktest] Failed scoring candidate ${cand.symbol}: ${err.message}`);
      }
    }

    scoredCandidates.sort((a, b) => b.compositeScore - a.compositeScore);
    return scoredCandidates;
  }

  /**
   * Run full-fidelity Autonomous Multi-Pair Rotation Backtest Simulation
   * Walks the timeline bar-by-bar across candidate pairs in FDUSD or USDT universe.
   */
  public static async runMultiPairRotationSimulation(opts: MultiPairRotationOptions): Promise<MultiPairRotationResult> {
    const quote = opts.quoteAsset === "FDUSD" ? "FDUSD" : "USDT";
    const timeframe = opts.timeframe || "5m";
    const simLimit = Math.max(500, opts.limit || 4000);
    const initialCapital = Math.max(10, opts.initialCapital || 200);
    const cooldownSec = (opts.rotationIntervalMinutes || 180) * 60;
    const scoreMarginPct = opts.rotationScoreMarginPct || 15;

    // 1. Fetch Top 50 Universe Candles
    const universeCandles = await this.fetchTopUniverseCandles({
      quoteAsset: quote,
      maxPairs: opts.maxUniversePairs || 50,
      limit: simLimit,
      customWhitelist: opts.customWhitelist,
      blacklist: opts.blacklist,
    });

    if (universeCandles.size === 0) {
      throw new Error(`Failed to load candles for ${quote} universe`);
    }

    // 2. Compute timeline boundaries across major pairs with full history
    let maxCandleTime = 0;
    for (const candles of universeCandles.values()) {
      if (candles.length > 0) {
        const lastTime = candles[candles.length - 1].time;
        if (lastTime > maxCandleTime) maxCandleTime = lastTime;
      }
    }

    const simEndTime = maxCandleTime > 0 ? maxCandleTime : Math.floor(Date.now() / 1000);
    const simStartTime = simEndTime - simLimit * 300;

    console.log(`[RotationBacktest] 🚀 Starting simulation: quote=${quote}, simLimit=${simLimit} bars (${((simLimit * 300) / 86400).toFixed(1)} days), universeLoaded=${universeCandles.size} pairs`);
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
      (initialCandidates.length > 0 ? initialCandidates.slice(0, 5).map(c => `${c.symbol}(score=${c.compositeScore},pos=${c.posRatio})`).join(", ") : "none")
    );

    const initialPullback = initialCandidates.find((c) => c.compositeScore >= 40 && c.posRatio <= 0.45);
    let activeCandidate = initialPullback || initialCandidates[0];
    if (!activeCandidate) {
      const fallbackSym = quote === "FDUSD" ? "BTCFDUSD" : "BTCUSDT";
      console.warn(`[RotationBacktest] ⚠️ No initial candidate passed full funnel criteria at simStartTime. Falling back to ${fallbackSym}`);
      activeCandidate = {
        symbol: fallbackSym,
        compositeScore: 70,
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
    }
    let activeSymbol = activeCandidate.symbol;
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

    // 4. Walk-forward simulation loop across legs
    while (currentTime < simEndTime - 3600 && legIndex < 50) {
      legIndex++;
      const currentLegStartTime = currentTime;

      let symCandles = universeCandles.get(activeSymbol);
      let startBarIdx = symCandles ? symCandles.findIndex((c) => c.time >= currentTime) : -1;

      // If activeSymbol doesn't have sufficient bars or has reached end of data, find alternative viable pair
      if (!symCandles || startBarIdx < 0 || startBarIdx >= symCandles.length - 10) {
        console.warn(`[RotationBacktest] ⚠️ Pair ${activeSymbol} is not viable at ${new Date(currentTime * 1000).toISOString()} (startBarIdx=${startBarIdx}, total=${symCandles?.length || 0})`);
        const altCandidates = this.evaluateHistoricalFunnelAtTime({
          targetTime: currentTime,
          universeCandles,
          quoteAsset: quote,
          gridOpts: opts,
        });

        const viable = altCandidates.find((c) => {
          const cCandles = universeCandles.get(c.symbol);
          if (!cCandles) return false;
          if (c.posRatio > 0.45) return false;
          const idx = cCandles.findIndex((cd) => cd.time >= currentTime);
          return idx >= 0 && idx < cCandles.length - 10;
        }) || altCandidates.find((c) => {
          const cCandles = universeCandles.get(c.symbol);
          if (!cCandles) return false;
          const idx = cCandles.findIndex((cd) => cd.time >= currentTime);
          return idx >= 0 && idx < cCandles.length - 10;
        });

        if (viable) {
          console.log(`[RotationBacktest] 🔄 Swapping to viable alternative candidate: ${viable.symbol} (score=${viable.compositeScore}, pos=${viable.posRatio})`);
          activeCandidate = viable;
          activeSymbol = viable.symbol;
          symCandles = universeCandles.get(activeSymbol);
          startBarIdx = symCandles ? symCandles.findIndex((c) => c.time >= currentTime) : -1;
          if (!symCandles || startBarIdx < 0 || startBarIdx >= symCandles.length - 10) {
            console.warn(`[RotationBacktest] 🛑 Alternative candidate ${activeSymbol} also lacks candles. Ending simulation loop.`);
            break;
          }
        } else {
          console.warn(`[RotationBacktest] 🛑 No viable pairs found with active candles at ${new Date(currentTime * 1000).toISOString()}. Ending simulation loop.`);
          break;
        }
      }

      const warmupBars = Math.min(200, startBarIdx);
      const legCandles = symCandles.slice(startBarIdx - warmupBars);
      const simStartIdx = warmupBars;

      console.log(`[RotationBacktest] ▶️ [Leg #${legIndex}] Starting on ${activeSymbol} at ${new Date(currentLegStartTime * 1000).toISOString()} (cash=$${currentCash.toFixed(2)}, entryScore=${activeCandidate?.compositeScore || 65})`);

      let legStopReason: "INITIAL_SELECTION" | "POST_ROUND_EXIT" | "IDLE_CASH_TIMEOUT" | "SIGNAL_DISQUALIFIED" = "POST_ROUND_EXIT";
      let nextSymbol: string | undefined = undefined;
      let nextSymbolScore = 0;
      let currentScoreAtExit = activeCandidate?.compositeScore || 65;
      let scoresSnapshot: any[] = [];

      const legRecord = this.runDynamicGridSimulation(legCandles, {
        symbol: activeSymbol,
        timeframe,
        initialCapital: currentCash,
        maxInventoryQuote: currentCash,
        capitalZones: opts.capitalZones ?? 2,
        channelMode: opts.channelMode ?? "DONCHIAN_ATR",
        minChannelWidthPct: opts.minChannelWidthPct ?? 6.0,
        maxChannelWidthPct: opts.maxChannelWidthPct ?? 25.0,
        zoneMinDropPct: opts.zoneMinDropPct ?? 2.5,
        zoneStabilizeCandles: opts.zoneStabilizeCandles ?? 3,
        lockChannelInPosition: opts.lockChannelInPosition ?? false,
        enableBaseConfirmationFilter: opts.enableBaseConfirmation ?? true,
        enableDipHunterEntryGuard: opts.enableDipHunterEntryGuard ?? true,
        gridCutLossMode: opts.gridCutLossMode ?? "none",
        costModel: quote === "FDUSD"
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

          if (candidates.length === 0) return false;
          scoresSnapshot = candidates.slice(0, 5);

          const curItem = candidates.find((c) => c.symbol === activeSymbol);
          const curScore = curItem ? curItem.compositeScore : 0;
          currentScoreAtExit = curScore;

          // 🌟 WATCHLIST & PULLBACK SWEET SPOT LOGIC:
          // A candidate on the watchlist is ONLY actionable if its price has pulled back into support (posRatio <= 0.42).
          // If a candidate is pumping (posRatio > 0.42), it stays on the Watchlist; we do NOT buy at the top!
          const pullbackCandidates = candidates.filter(
            (c) => c.symbol !== activeSymbol && c.compositeScore >= 45 && c.posRatio <= 0.42
          );

          // 1. If current coin has become disqualified (fell out of funnel or score < 40):
          const isCurrentDisqualified = !curItem || curScore < 40;
          if (isCurrentDisqualified) {
            const bestPullback = pullbackCandidates[0];
            if (bestPullback && bestPullback.compositeScore >= 45) {
              console.log(
                `[RotationBacktest] 🚨 [Leg #${legIndex}] Flat rotation triggered by SIGNAL_DISQUALIFIED at ${new Date(
                  state.time * 1000
                ).toISOString()}: ${activeSymbol} (score=${curScore}) ➔ ${bestPullback.symbol} (score=${
                  bestPullback.compositeScore
                }, posRatio=${bestPullback.posRatio})`
              );
              legStopReason = "SIGNAL_DISQUALIFIED";
              nextSymbol = bestPullback.symbol;
              nextSymbolScore = bestPullback.compositeScore;
              return true;
            }
          }

          const timeSinceRot = state.time - lastRotationTime;
          if (timeSinceRot < cooldownSec) {
            return false;
          }

          // 2. Winning Horse Loyalty Policy:
          // If the current coin is still performing well (curScore >= 45), require a substantial score margin
          // to justify switching out, AND the new coin must be in the Pullback Retracement Sweet Spot!
          const requiredScore = curScore * (1 + scoreMarginPct / 100);
          const eligibleRotationCandidate = pullbackCandidates.find(
            (c) => c.compositeScore >= 55 && c.compositeScore >= requiredScore
          );

          if (eligibleRotationCandidate) {
            console.log(
              `[RotationBacktest] 🔀 [Leg #${legIndex}] Pullback rotation triggered by ${state.trigger} at ${new Date(
                state.time * 1000
              ).toISOString()}: ${activeSymbol} (${curScore}) ➔ ${eligibleRotationCandidate.symbol} (${
                eligibleRotationCandidate.compositeScore
              }, posRatio=${eligibleRotationCandidate.posRatio}, required >= ${requiredScore.toFixed(1)})`
            );
            legStopReason = state.trigger;
            nextSymbol = eligibleRotationCandidate.symbol;
            nextSymbolScore = eligibleRotationCandidate.compositeScore;
            return true;
          }

          return false;
        },
        onSignalInvalidationCheck: (state) => {
          if (opts.enableSignalInvalidationExit === false) return false;

          // 🛡️ ONLY trigger Emergency Liquidate if price structurally breaks below the channel floor!
          // Normal 24h dips within the channel are standard grid accumulation opportunities, NOT emergencies!
          const isFloorBreak = state.closePrice < state.floorPrice * 0.982;
          const isCatastrophicDump = state.posRatio24h < 0.05 && state.unrealizedPnlPct < -5.0;

          if (!isFloorBreak && !isCatastrophicDump) {
            return false;
          }

          console.log(
            `[RotationBacktest] 🚨 [Leg #${legIndex}] STRUCTURAL FLOOR BREAKDOWN: ${activeSymbol} broke below floor ($${state.closePrice.toFixed(
              4
            )} < $${(state.floorPrice * 0.982).toFixed(4)}) ➔ Liquidating ${state.heldLotsCount} lots to protect capital`
          );
          legStopReason = "SIGNAL_DISQUALIFIED";
          nextSymbol = undefined; // Will evaluate clean on flat
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

      const legItem: RotationLegRecord = {
        legIndex,
        symbol: activeSymbol,
        startTime: currentLegStartTime,
        endTime: legEndTime,
        durationHours: Number(((legEndTime - currentLegStartTime) / 3600).toFixed(1)),
        triggerReason: legIndex === 1 ? "INITIAL_SELECTION" : legStopReason,
        entryScore: activeCandidate?.compositeScore || 65,
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
        topCandidatesSnapshot: scoresSnapshot,
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

      if (nextSymbol && nextSymbol !== activeSymbol) {
        activeCandidate = { symbol: nextSymbol, compositeScore: nextSymbolScore } as any;
        activeSymbol = nextSymbol;
      } else {
        const candidates = this.evaluateHistoricalFunnelAtTime({
          targetTime: currentTime,
          universeCandles,
          quoteAsset: quote,
          gridOpts: opts,
        });
        const viable = candidates.find((c) => {
          if (c.symbol === activeSymbol) return false;
          if (c.posRatio > 0.45) return false;
          const cCandles = universeCandles.get(c.symbol);
          if (!cCandles) return false;
          const idx = cCandles.findIndex((cd) => cd.time >= currentTime);
          return idx >= 0 && idx < cCandles.length - 10;
        }) || candidates.find((c) => {
          if (c.symbol === activeSymbol) return false;
          const cCandles = universeCandles.get(c.symbol);
          if (!cCandles) return false;
          const idx = cCandles.findIndex((cd) => cd.time >= currentTime);
          return idx >= 0 && idx < cCandles.length - 10;
        });
        if (viable) {
          console.log(`[RotationBacktest] 🔄 Rotating to next top viable candidate: ${viable.symbol} (score=${viable.compositeScore}, pos=${viable.posRatio})`);
          activeCandidate = viable;
          activeSymbol = viable.symbol;
        } else {
          console.log(`[RotationBacktest] ⏹️ No more alternative viable candidates at ${new Date(currentTime * 1000).toISOString()}. Simulation loop completed.`);
          break;
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
      return { ...p, winRate, totalNetPnlPct: netPct };
    });

    pairContributions.sort((a, b) => b.totalNetPnlQuote - a.totalNetPnlQuote);

    // 6. Benchmark Single-Pair Comparison
    const defaultBtc = quote === "FDUSD" ? "BTCFDUSD" : "BTCUSDT";
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
            capitalZones: opts.capitalZones ?? 2,
            channelMode: opts.channelMode ?? "DONCHIAN_ATR",
            gridCutLossMode: opts.gridCutLossMode ?? "none",
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
        alphaVsBenchmarkPct: Number((totalNetPnlPct - benchmarkPnlPct).toFixed(2)),
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
}
