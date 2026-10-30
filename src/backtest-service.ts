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
  exitType: "TP1+TP2" | "TP1+SL_BE" | "RATCHET_SL" | "SL" | "TECH_FAST_CUT" | "OPEN" | "TP1+OPEN";
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
  macroGateMode?: "off" | "noDeepBear" | "bullOnly";
  enableUpsideFloor?: boolean;
  enableCircuitBreaker?: boolean;
  enableFastCut?: boolean;
  fastCutThresholdPct?: number;
  stagnationBars?: number;
  maxSlPct?: number;
  tradeMode?: "dip_hunter" | "trend_rider" | "dual" | "dynamic_grid" | "dual_hybrid";
  tradeDirection?: "long" | "short" | "both";
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

    // Extended Multi-page fetch for up to 120+ days (up to 60,000 candles)
    const candlesMap = new Map<number, Candle>();
    let currentEndTime: number | undefined = undefined;
    const maxCandles = Math.min(60000, Math.max(50, limit));
    const maxBatches = Math.ceil(maxCandles / 1000) + 3;

    for (let batch = 0; batch < maxBatches && candlesMap.size < maxCandles; batch++) {
      let url = `https://api.binance.com/api/v3/klines?symbol=${cleanSym}&interval=${interval}&limit=1000`;
      if (currentEndTime) {
        url += `&endTime=${currentEndTime}`;
      }

      let res = await fetch(url, { headers: { "User-Agent": "dynamic-grid-bn/backtest" } });
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 1500));
        res = await fetch(url, { headers: { "User-Agent": "dynamic-grid-bn/backtest" } });
      }
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
    }
  ): BacktestRecord {
    const symbol = opts.symbol.toUpperCase().replace(/[\/\-_:]/g, "");
    const timeframe = opts.timeframe || "5m";
    const initialCapital = opts.initialCapital ?? 200;
    const maxInventory = opts.maxInventoryQuote ?? initialCapital;
    const cm = opts.costModel ?? { feePctPerSide: 0.075, slippagePctPerFill: 0.01 };
    const costPerFill = (cm.feePctPerSide + cm.slippagePctPerFill) / 100;

    const dow = new DowStructureEngine(3, true, 20.0, 300);
    const warmup = Math.min(100, Math.floor(candles.length / 4));
    for (let k = 0; k < warmup; k++) {
      dow.addCandle(candles[k]);
    }

    let cash = initialCapital;
    let heldLots: Array<{
      id: number;
      index: number;
      qty: number;
      buyPrice: number;
      entryTime: number;
      targetPrice: number;
      costQuote: number;
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

    for (let i = warmup; i < candles.length; i++) {
      const c = candles[i];
      dow.addCandle(c);

      const structure = dow.getStructure(c.close, undefined, { useOnlyClosedCandles: true });
      const floor = structure.bottomBound;
      const ceiling = structure.upperBound;
      const center = structure.centerPrice;
      const channelSpan = ceiling - floor;
      if (channelSpan <= 0) continue;

      // 4 Buy Levels: Level 1 (45%), Level 2 (33%), Level 3 (20%), Level 4 (8% above floor)
      const buyLevels = [
        floor + channelSpan * 0.45,
        floor + channelSpan * 0.33,
        floor + channelSpan * 0.20,
        floor + channelSpan * 0.08,
      ];

      // 4 Sell Targets: Target 1 (55%), Target 2 (68%), Target 3 (80%), Target 4 (92% above floor)
      const sellTargets = [
        floor + channelSpan * 0.55,
        floor + channelSpan * 0.68,
        floor + channelSpan * 0.80,
        floor + channelSpan * 0.92,
      ];

      const cutLossPrice = floor * 0.985; // 1.5% below floor

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
            side: "LONG",
            entryTime: lot.entryTime,
            entryPrice: lot.buyPrice,
            stopLossPrice: cutLossPrice,
            fanSpreadAtEntry: 0,
            tp1Time: c.time,
            tp1Price: exitPrice,
            tp1PnlPct: pnlPct,
            exitTime: c.time,
            exitPrice,
            exitType: "TP1+TP2",
            pnlQuote,
            pnlPct,
            holdingBars: i - (candles.findIndex((x) => x.time === lot.entryTime) || i),
            costQuote: lot.costQuote + exitCost,
          });

          markers.push({
            time: c.time,
            position: "aboveBar",
            color: "#a855f7",
            shape: "arrowDown",
            text: `🟣 GRID SELL #${lot.id} (L${lot.index + 1}) @ $${exitPrice.toFixed(4)} (+${pnlPct.toFixed(2)}%)`,
          });
          continue;
        }

        // Cut Loss Hit
        if (c.low <= cutLossPrice) {
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
            side: "LONG",
            entryTime: lot.entryTime,
            entryPrice: lot.buyPrice,
            stopLossPrice: cutLossPrice,
            fanSpreadAtEntry: 0,
            exitTime: c.time,
            exitPrice,
            exitType: "SL",
            pnlQuote,
            pnlPct,
            holdingBars: i - (candles.findIndex((x) => x.time === lot.entryTime) || i),
            costQuote: lot.costQuote + exitCost,
          });

          markers.push({
            time: c.time,
            position: "belowBar",
            color: "#ef4444",
            shape: "arrowDown",
            text: `🔴 GRID CUT #${lot.id} (L${lot.index + 1}) @ $${exitPrice.toFixed(4)} (${pnlPct.toFixed(2)}%)`,
          });
          continue;
        }

        remainingLots.push(lot);
      }
      heldLots = remainingLots;

      // 2. Evaluate Grid Buys (Tranche Size = 25% of Max Inventory)
      const currentInventory = heldLots.reduce((sum, l) => sum + (l.qty * l.buyPrice), 0);
      const trancheQuote = maxInventory / 4;

      if (currentInventory + trancheQuote <= maxInventory && cash >= trancheQuote && heldLots.length < 4) {
        for (let lvlIdx = 0; lvlIdx < buyLevels.length; lvlIdx++) {
          const bl = buyLevels[lvlIdx];
          const alreadyFilledLevel = heldLots.some((l) => l.index === lvlIdx);
          if (!alreadyFilledLevel && c.low <= bl && c.close >= cutLossPrice) {
            tradeCounter++;
            const buyPrice = bl;
            const invest = trancheQuote;
            const fillQty = (invest / buyPrice) * (1 - costPerFill);
            cash -= invest;

            heldLots.push({
              id: tradeCounter,
              index: lvlIdx,
              qty: fillQty,
              buyPrice,
              entryTime: c.time,
              targetPrice: sellTargets[lvlIdx] ?? (buyPrice * 1.015),
              costQuote: invest * costPerFill,
            });

            markers.push({
              time: c.time,
              position: "belowBar",
              color: "#10b981",
              shape: "arrowUp",
              text: `🟢 GRID BUY #${tradeCounter} (L${lvlIdx + 1}) @ $${buyPrice.toFixed(4)}`,
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

    // End of simulation
    const lastPrice = candles.length > 0 ? candles[candles.length - 1].close : 0;
    const endPositionVal = heldLots.reduce((sum, l) => sum + (l.qty * lastPrice * (1 - costPerFill)), 0);
    const finalCapital = cash + endPositionVal;
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
      candleCount: candles.length,
      spreadThreshold: 0,
      isAutoCalibrated: false,
      useRatchetSl: false,
      macroGateMode: "off",
      enableUpsideFloor: false,
      enableCircuitBreaker: false,
      summary,
      trades,
      markers: markers.sort((a, b) => a.time - b.time),
      candles,
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
      qty: number;
      buyPrice: number;
      entryTime: number;
      entryIdx: number;
      targetPrice: number;
      costQuote: number;
    }> = [];

    // Sniper Subsystem State
    let sniperCash = sniperInitialCap;
    let sniperHeldQty = 0;
    let sniperEntryPrice = 0;
    let sniperInitialSlPrice = 0;
    let sniperStopLossPrice = 0;
    let sniperActiveSide: "LONG" | "SHORT" = "LONG";
    let sniperTp1Hit = false;
    let sniperTp1Price = 0;
    let sniperTp1Time = 0;
    let sniperTp1PnlPct = 0;
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

      const structure = dow.getStructure(c.close, undefined, { useOnlyClosedCandles: true });
      const floor = structure.bottomBound;
      const ceiling = structure.upperBound;
      const center = structure.centerPrice;
      const channelSpan = ceiling - floor;

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
        const cutLossPrice = floor * 0.985;
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
              side: "LONG",
              entryTime: lot.entryTime,
              entryPrice: lot.buyPrice,
              stopLossPrice: cutLossPrice,
              fanSpreadAtEntry: 0,
              tp1Time: c.time,
              tp1Price: exitPrice,
              tp1PnlPct: pnlPct,
              exitTime: c.time,
              exitPrice,
              exitType: "TP1+TP2",
              pnlQuote,
              pnlPct,
              holdingBars: i - lot.entryIdx,
              costQuote: lot.costQuote + exitCost,
            });

            markers.push({
              time: c.time,
              position: "aboveBar",
              color: "#3b82f6",
              shape: "circle",
              text: `🔵 GRID TP #${lot.id} (L${lot.index + 1}) @ $${exitPrice.toFixed(4)} (+${pnlPct.toFixed(2)}%)`,
            });
            continue;
          }

          if (c.low <= cutLossPrice) {
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
              side: "LONG",
              entryTime: lot.entryTime,
              entryPrice: lot.buyPrice,
              stopLossPrice: cutLossPrice,
              fanSpreadAtEntry: 0,
              exitTime: c.time,
              exitPrice,
              exitType: "SL",
              pnlQuote,
              pnlPct,
              holdingBars: i - lot.entryIdx,
              costQuote: lot.costQuote + exitCost,
            });

            markers.push({
              time: c.time,
              position: "belowBar",
              color: "#ef4444",
              shape: "arrowDown",
              text: `🔴 GRID CUT #${lot.id} (L${lot.index + 1}) @ $${exitPrice.toFixed(4)} (${pnlPct.toFixed(2)}%)`,
            });
            continue;
          }
          remainingLots.push(lot);
        }
        heldLots = remainingLots;

        // ── 2. EVALUATE GRID BUYS ──
        const trancheQuote = gridInitialCap / 4;
        const currentGridInv = heldLots.reduce((s, l) => s + (l.qty * l.buyPrice), 0);
        if (currentGridInv + trancheQuote <= gridInitialCap && gridCash >= trancheQuote && heldLots.length < 4) {
          const buyLevels = [
            floor + channelSpan * 0.45,
            floor + channelSpan * 0.33,
            floor + channelSpan * 0.20,
            floor + channelSpan * 0.08,
          ];
          const sellTargets = [
            floor + channelSpan * 0.55,
            floor + channelSpan * 0.68,
            floor + channelSpan * 0.80,
            floor + channelSpan * 0.92,
          ];

          for (let lvlIdx = 0; lvlIdx < buyLevels.length; lvlIdx++) {
            const bl = buyLevels[lvlIdx];
            const alreadyFilled = heldLots.some((l) => l.index === lvlIdx);
            if (!alreadyFilled && c.low <= bl && c.close >= cutLossPrice) {
              tradeCounter++;
              const buyPrice = bl;
              const invest = trancheQuote;
              const fillQty = (invest / buyPrice) * (1 - costPerFill);
              gridCash -= invest;

              heldLots.push({
                id: tradeCounter,
                index: lvlIdx,
                qty: fillQty,
                buyPrice,
                entryTime: c.time,
                entryIdx: i,
                targetPrice: sellTargets[lvlIdx] ?? (buyPrice * 1.015),
                costQuote: invest * costPerFill,
              });

              markers.push({
                time: c.time,
                position: "belowBar",
                color: "#10b981",
                shape: "circle",
                text: `🟢 GRID BUY #${tradeCounter} (L${lvlIdx + 1}) @ $${buyPrice.toFixed(4)}`,
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
          let pnlQuote = 0;
          if (sniperActiveSide === "LONG") {
            pnlQuote = (sniperHeldQty * exitPrice * (1 - costPerFill)) - (sniperHeldQty * sniperEntryPrice);
          } else {
            pnlQuote = (sniperHeldQty * sniperEntryPrice) - (sniperHeldQty * exitPrice * (1 + costPerFill));
          }
          const invest = sniperHeldQty * sniperEntryPrice;
          const pnlPct = invest > 0 ? (pnlQuote / invest) * 100 : 0;
          sniperCash += (invest + pnlQuote);
          const exitCost = sniperHeldQty * exitPrice * costPerFill;
          totalFeesQuote += sniperTradeCost + exitCost;

          if (pnlQuote >= 0) { grossProfit += pnlQuote; wins++; }
          else { grossLoss += Math.abs(pnlQuote); losses++; }

          const isFastCut = exitDecision.reason?.startsWith("Fast Technical Cut") || exitDecision.reason?.startsWith("Fast Stagnation Cut");
          const isRatchet = !sniperTp1Hit && (sniperActiveSide === "LONG" ? sniperStopLossPrice > sniperInitialSlPrice : sniperStopLossPrice < sniperInitialSlPrice);
          const exitType: BacktestTrade["exitType"] = exitDecision.action === "TP2" ? "TP1+TP2" : isFastCut ? "TECH_FAST_CUT" : sniperTp1Hit ? "TP1+SL_BE" : isRatchet ? "RATCHET_SL" : "SL";

          trades.push({
            id: tradeCounter,
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
            costQuote: sniperTradeCost + exitCost,
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
        } else if (exitDecision.action === "TP1" && !sniperTp1Hit) {
          sniperTp1Hit = true;
          sniperTp1Price = exitDecision.exitPrice;
          sniperTp1Time = c.time;
          const halfQty = sniperHeldQty * tp1Ratio;
          let partialPnl = 0;
          if (sniperActiveSide === "LONG") {
            partialPnl = (halfQty * sniperTp1Price * (1 - costPerFill)) - (halfQty * sniperEntryPrice);
          } else {
            partialPnl = (halfQty * sniperEntryPrice) - (halfQty * sniperTp1Price * (1 + costPerFill));
          }
          sniperTp1PnlPct = (partialPnl / (halfQty * sniperEntryPrice)) * 100;
          sniperCash += (halfQty * sniperEntryPrice + partialPnl);
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
          sniperEntryPrice = modularDecision.entryPrice;
          sniperStopLossPrice = modularDecision.stopLossPrice;
          sniperEntryIdx = i;
          const invest = sniperInitialCap;
          sniperHeldQty = (invest / sniperEntryPrice) * (1 - costPerFill);
          sniperCash -= invest;
          sniperTradeCost = invest * costPerFill;
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

    // End of simulation liquidation
    const lastPrice = candles.length > 0 ? candles[candles.length - 1].close : 0;
    const endGridVal = heldLots.reduce((s, l) => s + (l.qty * lastPrice * (1 - costPerFill)), 0);
    const endSniperVal = sniperHeldQty > 0 ? sniperHeldQty * lastPrice * (1 - costPerFill) : 0;
    const finalCapital = gridCash + endGridVal + sniperCash + endSniperVal;
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
    }
  ): BacktestRecord {
    if (opts.tradeMode === "dynamic_grid") {
      return BacktestService.runDynamicGridSimulation(candles, {
        symbol: opts.symbol,
        timeframe: opts.timeframe,
        initialCapital: opts.initialCapital,
        costModel: opts.costModel,
        saveToHistory: opts.saveToHistory,
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
}
