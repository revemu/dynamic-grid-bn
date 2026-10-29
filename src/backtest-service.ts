/**
 * Backtest Service & Dedicated Simulation Engine
 * Runs historical simulations for MA Fan Sniper & Dynamic Strategies,
 * persists backtest runs, and generates TradingView chart markers.
 */

import fs from "fs";
import path from "path";
import { Candle, RibbonEngine, ExhaustionEngine, AutoCalibrator, MaFanCoreRules, RegimeSupervisor, CushionMode, RibbonState, ExhaustionState, WaterfallGuardMode } from "./strategy/ma-fan/index.js";
import { calcATR } from "./strategy/ma-fan/ribbon.js";

export const STABLE_TOKENS = new Set([
  "USDC", "FDUSD", "TUSD", "BUSD", "EUR", "DAI", "AEUR", "USDP", "USD1", "RLUSD", "EURI", "USTC", "WBTC", "WBETH",
]);

export interface BacktestTrade {
  id: number;
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
  exitType: "TP1+TP2" | "TP1+SL_BE" | "RATCHET_SL" | "SL" | "OPEN" | "TP1+OPEN";
  pnlQuote: number;
  pnlPct: number;
  holdingBars: number;
  cushionApplied?: boolean;
  costQuote?: number;
  rewardRiskAtEntry?: number;
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
  isOversoldExhaustion: boolean;
  ema4: number;
  ema8: number;
  ema16: number;
  ema25: number;
  ema75: number;
  ema200: number;
  requiredSpreadPct?: number;
  spreadMultiplier?: number;
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
  summary: BacktestSummary;
  tradeCount: number;
}

export interface MarketScanPersistence {
  timestamp: number;
  options: MarketScanOptions;
  results: MarketScanResultItem[];
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
  /**
   * Fetch historical candles from Binance Spot REST API
   */
  public static async fetchBinanceCandles(
    symbol: string,
    interval: string = "5m",
    limit: number = 1000
  ): Promise<Candle[]> {
    const cleanSym = symbol.toUpperCase().replace(/[\/\-_:]/g, "");

    // Quick single fetch if limit <= 1000
    if (limit <= 1000) {
      const clampedLimit = Math.min(1000, Math.max(50, limit));
      const url = `https://api.binance.com/api/v3/klines?symbol=${cleanSym}&interval=${interval}&limit=${clampedLimit}`;

      const res = await fetch(url, { headers: { "User-Agent": "dynamic-grid-bn/backtest" } });
      if (!res.ok) {
        throw new Error(`Failed to fetch historical candles from Binance (HTTP ${res.status})`);
      }

      const raw = (await res.json()) as any[];
      if (!Array.isArray(raw) || raw.length === 0) {
        throw new Error(`No historical candles returned for ${cleanSym} on ${interval}`);
      }

      const nowMs = Date.now();
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

      return candles.sort((a, b) => a.time - b.time);
    }

    // Extended Multi-page fetch for 7, 15, 30 days (up to 15,000 candles)
    const candlesMap = new Map<number, Candle>();
    let currentEndTime: number | undefined = undefined;
    const maxCandles = Math.min(15000, Math.max(50, limit));
    const maxBatches = Math.ceil(maxCandles / 1000) + 3;

    for (let batch = 0; batch < maxBatches && candlesMap.size < maxCandles; batch++) {
      let url = `https://api.binance.com/api/v3/klines?symbol=${cleanSym}&interval=${interval}&limit=1000`;
      if (currentEndTime) {
        url += `&endTime=${currentEndTime}`;
      }

      const res = await fetch(url, { headers: { "User-Agent": "dynamic-grid-bn/backtest" } });
      if (!res.ok) {
        if (candlesMap.size > 0) break; // Graceful fallback if we already got candles
        throw new Error(`Failed to fetch historical candles from Binance (HTTP ${res.status})`);
      }

      const raw = (await res.json()) as any[];
      if (!Array.isArray(raw) || raw.length === 0) break;

      const nowMs = Date.now();
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
    }

    if (candlesMap.size === 0) {
      throw new Error(`No historical candles returned for ${cleanSym} on ${interval}`);
    }

    const sorted = Array.from(candlesMap.values()).sort((a, b) => a.time - b.time);
    return sorted.slice(-maxCandles);
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
      exitInfoLag?: 0 | 1;
      warmupBars?: number;
      precomputed?: {
        ribbonStates: RibbonState[];
        exhaustionStates: ExhaustionState[];
        atrs: number[];
      };
      onlyEntryIdx?: number;
    }
  ): BacktestRecord {
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

    // HTF candles: use provided or aggregate from candles
    const candlesHtf = opts.candlesHtf && opts.candlesHtf.length > 0
      ? opts.candlesHtf
      : BacktestService.aggregateCandles(candles, targetMinutes);

    const isAuto = opts.spreadThreshold === "auto" || !opts.spreadThreshold;
    const isLongBacktest = candles.length > 1000;
    const rollingLookback = Math.min(1000, Math.max(300, Math.floor(candles.length / 3)));
    const rollingCadence = 144; // Re-calibrate every 144 bars (~12 hours on 5m)

    // Resolve spread threshold (auto calibrate if requested or <= 0)
    let spread = typeof opts.spreadThreshold === "number" && opts.spreadThreshold > 0 ? opts.spreadThreshold : 0.25;
    if (isAuto) {
      const initialWindow = isLongBacktest ? candles.slice(0, Math.max(rollingLookback, 500)) : candles;
      const initialHtf = candlesHtf.filter((h) => h.time <= initialWindow[initialWindow.length - 1].time);
      const cal = AutoCalibrator.calibrate(symbol, initialWindow, undefined, initialHtf.length > 0 ? initialHtf : candlesHtf, {
        slBufferPct,
        trailingPullbackPct,
        breakevenFeeBufferPct: opts.breakevenFeeBufferPct,
        tp1Ratio,
        initialCapital,
        supervisorTimeframe: supervisorTf,
        useRatchetSl,
        cushionMode: opts.cushionMode ?? "off",
        costModel: opts.costModel,
      });
      spread = cal.bestSpreadPct || 0.25;
    }

    let currentRollingSpread = spread;
    let lastRollingCalibratedBar = -999;
    let rollingSpreadSum = 0;
    let rollingSpreadCount = 0;

    const cm = opts.costModel ?? { feePctPerSide: 0, slippagePctPerFill: 0 };
    const costPerFill = (cm.feePctPerSide + cm.slippagePctPerFill) / 100;
    const intrabarMode = opts.intrabarMode ?? "closeBased";
    const warmup = opts.warmupBars !== undefined ? opts.warmupBars : Math.min(100, Math.floor(candles.length / 4));

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
    let highestSinceTp1 = 0;
    let activeTradeId = 0;
    let spreadAtEntry = 0;
    let tradeInvest = 0;
    let tradeProceeds = 0;
    let lastCushionApplied = false;
    let rrAtEntry: number | undefined = undefined;

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
        const baseSpK = MaFanCoreRules.computeEffectiveSpread({
          baseSpread: spread,
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
      const currentEquity = cash + (heldQty > 0 ? heldQty * c.close : 0);
      if (currentEquity > peakEquity) peakEquity = currentEquity;
      const dd = peakEquity > 0 ? ((peakEquity - currentEquity) / peakEquity) * 100 : 0;
      if (dd > maxDrawdownPct) maxDrawdownPct = dd;

      // ─── POSITION EXITS ──────────────────────────────────────────────
      if (heldQty > 0) {
        if (c.high > highestSinceTp1) highestSinceTp1 = c.high;

        const ei = (opts.exitInfoLag === 1) ? i - 1 : i;
        const ribbonX = ribbonStates[ei]!;
        const curAtrX = atrs[ei] ?? (candles[ei]!.close * 0.003);
        const exhX = exhaustionStates[ei]!;
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
        });
        if (liftedSl !== null && liftedSl > stopLossPrice) {
          stopLossPrice = liftedSl;
        }

        // Evaluate Exits (Priority: TP2 -> SL -> TP1) via Universal MaFanCoreRules
        const exitDecision = MaFanCoreRules.evaluateExits({
          highPrice: c.high,
          lowPrice: c.low,
          closePrice: c.close,
          entryPrice,
          stopLossPrice,
          tp1Filled,
          highestPriceSinceTp1: highestSinceTp1,
          ribbon: ribbonX,
          trailingPullbackPct,
          breakevenFeeBufferPct: opts.breakevenFeeBufferPct,
          isOverbought: exhX.isOverboughtExhaustion,
          barsHeld,
          isHtfBull: !!htfRegimeX.isBullish,
          cushionMode: opts.cushionMode ?? "off",
          cushionThresholdPct: opts.cushionThresholdPct,
          tp1MinProfitPct: opts.tp1MinProfitPct,
        });

        // 1. TP2 Exit (Macro Runner / Trailing Stop)
        if (exitDecision.action === "TP2") {
          const exitP = exitDecision.exitPrice;
          const proceeds = heldQty * exitP * (1 - costPerFill);
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

          trades.push({
            id: activeTradeId,
            entryTime: candles[entryIdx]!.time,
            entryPrice,
            stopLossPrice,
            fanSpreadAtEntry: spreadAtEntry,
            tp1Time,
            tp1Price,
            tp1PnlPct: ((tp1Price - entryPrice) / entryPrice) * 100,
            tp2Time: c.time,
            tp2Price: exitP,
            tp2PnlPct: ((exitP - entryPrice) / entryPrice) * 100,
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
            position: "aboveBar",
            color: "#a855f7",
            shape: "arrowDown",
            text: `🟣 TP2 #${activeTradeId} @ $${exitP.toFixed(2)} (+${(((exitP - entryPrice) / entryPrice) * 100).toFixed(2)}%)`,
          });

          heldQty = 0;
          if (opts.onlyEntryIdx !== undefined) break;
          continue;
        }

        // 2. Stop Loss Exit
        if (exitDecision.action === "SL") {
          const exitP = exitDecision.exitPrice;
          const proceeds = heldQty * exitP * (1 - costPerFill);
          cash += proceeds;
          tradeProceeds += proceeds;

          const isRatchet = !tp1Filled && stopLossPrice > initialSlPrice;
          const exitType: BacktestTrade["exitType"] = tp1Filled ? "TP1+SL_BE" : isRatchet ? "RATCHET_SL" : "SL";
          const totalPnlQuote = tradeProceeds - tradeInvest;
          const tradePnlPct = tradeInvest > 0 ? (totalPnlQuote / tradeInvest) * 100 : 0;
          const costQuote = (tradeInvest * costPerFill) + (tp1Filled ? tp1Qty * tp1Price * costPerFill : 0) + (heldQty * exitP * costPerFill);

          if (totalPnlQuote >= 0) {
            grossProfit += totalPnlQuote;
            wins++;
          } else {
            grossLoss += Math.abs(totalPnlQuote);
            losses++;
          }

          trades.push({
            id: activeTradeId,
            entryTime: candles[entryIdx]!.time,
            entryPrice,
            stopLossPrice,
            fanSpreadAtEntry: spreadAtEntry,
            tp1Time: tp1Filled ? tp1Time : undefined,
            tp1Price: tp1Filled ? tp1Price : undefined,
            tp1PnlPct: tp1Filled ? ((tp1Price - entryPrice) / entryPrice) * 100 : undefined,
            slTime: c.time,
            slPrice: exitP,
            slPnlPct: ((exitP - entryPrice) / entryPrice) * 100,
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
          const markerColor = exitType === "TP1+SL_BE" ? "#f59e0b" : exitType === "RATCHET_SL" ? "#f97316" : "#ef4444";
          const markerText = exitType === "TP1+SL_BE"
            ? `🟡 SL BE #${activeTradeId} @ $${exitP.toFixed(2)}`
            : exitType === "RATCHET_SL"
            ? `🟠 RATCHET SL #${activeTradeId} @ $${exitP.toFixed(2)} (${(((exitP - entryPrice) / entryPrice) * 100).toFixed(2)}%)`
            : `🔴 SL #${activeTradeId} @ $${exitP.toFixed(2)} (${(((exitP - entryPrice) / entryPrice) * 100).toFixed(2)}%)`;

          markers.push({
            time: c.time,
            position: "belowBar",
            color: markerColor,
            shape: "arrowDown",
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
          const tp1Proceeds = tp1Qty * tp1Price * (1 - costPerFill);
          cash += tp1Proceeds;
          tradeProceeds += tp1Proceeds;
          heldQty -= tp1Qty;
          tp1Filled = true;
          highestSinceTp1 = c.high;
          if (exitDecision.cushionApplied) {
            lastCushionApplied = true;
          }
          if (exitDecision.newStopLossPrice) {
            stopLossPrice = Math.max(stopLossPrice, exitDecision.newStopLossPrice);
          }

          // TP1 Marker
          markers.push({
            time: c.time,
            position: "aboveBar",
            color: "#38bdf8",
            shape: "circle",
            text: `🔵 TP1 (${(activeTp1RatioX * 100).toFixed(0)}%) #${activeTradeId} @ $${tp1Price.toFixed(2)} (+${(((tp1Price - entryPrice) / entryPrice) * 100).toFixed(2)}%)`,
          });

          // Intra-candle Breakeven SL check:
          // Controlled by intrabarMode ("closeBased" | "pessimistic" | "optimistic")
          let hitIntrabarBe = false;
          if (intrabarMode === "closeBased") {
            hitIntrabarBe = c.close <= stopLossPrice;
          } else if (intrabarMode === "pessimistic") {
            hitIntrabarBe = c.low <= stopLossPrice;
          }

          if (exitDecision.newStopLossPrice && exitDecision.newStopLossPrice > entryPrice && hitIntrabarBe) {
            const exitP = stopLossPrice;
            const beProceeds = heldQty * exitP * (1 - costPerFill);
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

            trades.push({
              id: activeTradeId,
              entryTime: candles[entryIdx]!.time,
              entryPrice,
              stopLossPrice,
              fanSpreadAtEntry: spreadAtEntry,
              tp1Time,
              tp1Price,
              tp1PnlPct: ((tp1Price - entryPrice) / entryPrice) * 100,
              slTime: c.time,
              slPrice: exitP,
              slPnlPct: ((exitP - entryPrice) / entryPrice) * 100,
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
              position: "belowBar",
              color: "#f59e0b",
              shape: "arrowDown",
              text: `🟡 SL BE #${activeTradeId} @ $${exitP.toFixed(2)}`,
            });

            heldQty = 0;
            if (opts.onlyEntryIdx !== undefined) break;
            continue;
          }
        }
      }

      // Dynamic Rolling Auto-Calibration on multi-day backtests
      if (isAuto && isLongBacktest && (i - lastRollingCalibratedBar >= rollingCadence)) {
        const windowCandles = candles.slice(Math.max(0, i - rollingLookback), i);
        if (windowCandles.length >= 200) {
          const windowHtf = candlesHtf.filter((h) => h.time <= c.time && h.time >= windowCandles[0].time);
          const cal = AutoCalibrator.calibrate(symbol, windowCandles, undefined, windowHtf.length > 0 ? windowHtf : undefined, {
            slBufferPct,
            trailingPullbackPct,
            breakevenFeeBufferPct: opts.breakevenFeeBufferPct,
            tp1Ratio,
            initialCapital,
            supervisorTimeframe: supervisorTf,
            useRatchetSl,
            cushionMode: opts.cushionMode ?? "off",
            costModel: opts.costModel,
          });
          if (cal.bestSpreadPct) {
            currentRollingSpread = cal.bestSpreadPct;
          }
        }
        lastRollingCalibratedBar = i;
      }

      if (isAuto) {
        rollingSpreadSum += currentRollingSpread;
        rollingSpreadCount++;
      }

      // ─── POSITION ENTRY (SNIPER HOOK) ────────────────────────────────
      if (heldQty === 0 && cash >= 10) {
        if (opts.onlyEntryIdx !== undefined && i !== opts.onlyEntryIdx) {
          continue;
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
        if (opts.onlyEntryIdx === undefined) {
          evaluations[i] = {
            time: c.time,
            fanSpreadPct: ribbon.fanSpreadPct,
            isFanningDown: ribbon.isFanningDown,
            isHookUp: ribbon.isHookUp,
            rsi: exhaustion.rsi,
            isOversoldExhaustion: exhaustion.isOversoldExhaustion,
            ema4: ribbon.ema4,
            ema8: ribbon.ema8,
            ema16: ribbon.ema16,
            ema25: ribbon.ema25,
            ema75: ribbon.ema75,
            ema200: ribbon.ema200,
            requiredSpreadPct: Number(requiredSpread.toFixed(2)),
            spreadMultiplier: htfRegime.spreadMultiplier,
          };
        }
        const entryDecision = MaFanCoreRules.evaluateEntry({
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
        });

        if (entryDecision.shouldEnter) {
          activeTradeId++;
          entryIdx = i;
          entryPrice = entryDecision.entryPrice;
          spreadAtEntry = entryDecision.fanSpreadPct;
          initialSlPrice = entryDecision.stopLossPrice;
          stopLossPrice = initialSlPrice;
          rrAtEntry = entryDecision.rewardRisk;

          const invest = cash * 0.98;
          heldQty = (invest / entryPrice) * (1 - costPerFill);
          tradeInvest = invest;
          tradeProceeds = 0;
          cash -= invest;
          tp1Qty = 0;
          tp1Filled = false;
          highestSinceTp1 = entryPrice;
          lastCushionApplied = false;

          // Buy Marker
          markers.push({
            time: c.time,
            position: "belowBar",
            color: "#10b981",
            shape: "arrowUp",
            text: `🟢 BUY #${activeTradeId} @ $${entryPrice.toFixed(2)} (Spread: ${spreadAtEntry.toFixed(2)}%)`,
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
      const unrealizedProceeds = heldQty * currentPrice * (1 - costPerFill);
      const totalPnlQuote = (tradeProceeds + unrealizedProceeds) - tradeInvest;
      const tradePnlPct = tradeInvest > 0 ? (totalPnlQuote / tradeInvest) * 100 : 0;
      const barsHeld = candles.length - 1 - entryIdx;
      const costQuote = (tradeInvest * costPerFill) + (tp1Filled ? tp1Qty * tp1Price * costPerFill : 0) + (heldQty * currentPrice * costPerFill);

      trades.push({
        id: activeTradeId,
        entryTime: candles[entryIdx]!.time,
        entryPrice,
        stopLossPrice,
        fanSpreadAtEntry: spreadAtEntry,
        tp1Time: tp1Filled ? tp1Time : undefined,
        tp1Price: tp1Filled ? tp1Price : undefined,
        tp1PnlPct: tp1Filled ? ((tp1Price - entryPrice) / entryPrice) * 100 : undefined,
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
    const finalCapital = cash + (heldQty > 0 ? heldQty * candles[candles.length - 1]!.close * (1 - costPerFill) : 0);
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

    const id = `bt_${Date.now()}`;
    const record: BacktestRecord = {
      id,
      createdAt: new Date().toISOString(),
      symbol,
      timeframe,
      candleCount: candles.length,
      spreadThreshold: finalEffectiveSpread,
      isAutoCalibrated: isAuto,
      useRatchetSl,
      summary,
      trades,
      markers: markers.sort((a, b) => a.time - b.time),
      candles,
      evaluations,
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

      // Prepend newest run, limit stored history to last 30 runs
      data.records.unshift(record);
      if (data.records.length > 30) {
        data.records = data.records.slice(0, 30);
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
    const limit = Math.min(1000, Math.max(100, opts.limit || 500));

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

    // 2. Run simulation in concurrent chunks of 5
    const results: MarketScanResultItem[] = [];
    const chunkSize = 5;

    for (let i = 0; i < candidates.length; i += chunkSize) {
      const chunk = candidates.slice(i, i + chunkSize);
      await Promise.all(
        chunk.map(async (cand) => {
          try {
            const sym = cand.symbol;
            const supTf = opts.supervisorTimeframe ?? "15m";
            const [candles, candlesHtf] = await Promise.all([
              this.fetchBinanceCandles(sym, timeframe, limit),
              this.fetchBinanceCandles(sym, supTf, 300).catch(() => []),
            ]);
            if (!candles || candles.length < 50) return;

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
          } catch {
            // Ignore individual pair fetch error during batch scan
          }
        })
      );
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
}
