/**
 * Backtest Service & Dedicated Simulation Engine
 * Runs historical simulations for MA Fan Sniper & Dynamic Strategies,
 * persists backtest runs, and generates TradingView chart markers.
 */

import fs from "fs";
import path from "path";
import { Candle, RibbonEngine, ExhaustionEngine, AutoCalibrator } from "./strategy/ma-fan/index.js";

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
  exitType: "TP1+TP2" | "TP1+SL_BE" | "RATCHET_SL" | "SL";
  pnlQuote: number;
  pnlPct: number;
  holdingBars: number;
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
}

export interface BacktestRecord {
  id: string;
  createdAt: string;
  symbol: string;
  timeframe: string;
  candleCount: number;
  spreadThreshold: number;
  useRatchetSl?: boolean;
  summary: BacktestSummary;
  trades: BacktestTrade[];
  markers: BacktestMarker[];
  candles: Candle[];
}

export interface BacktestHistoryItem {
  id: string;
  createdAt: string;
  symbol: string;
  timeframe: string;
  candleCount: number;
  spreadThreshold: number;
  useRatchetSl?: boolean;
  summary: BacktestSummary;
  tradeCount: number;
}

const DB_PATH = path.resolve(process.cwd(), "data", "backtest-history.db.json");

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

    const candles: Candle[] = [];
    for (const k of raw) {
      const time = Math.floor(Number(k[0]) / 1000);
      const open = Number(k[1]);
      const high = Number(k[2]);
      const low = Number(k[3]);
      const close = Number(k[4]);
      const volume = Number(k[5]) || 0;

      if ([time, open, high, low, close].every(Number.isFinite) && close > 0) {
        candles.push({ time, open, high, low, close, volume });
      }
    }

    return candles.sort((a, b) => a.time - b.time);
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
    }
  ): BacktestRecord {
    const symbol = opts.symbol.toUpperCase().replace(/[\/\-_:]/g, "");
    const timeframe = opts.timeframe || "5m";
    const initialCapital = opts.initialCapital ?? 200;
    const slBufferPct = opts.slBufferPct ?? 0.25;
    const useRatchetSl = opts.useRatchetSl !== false;

    // Resolve spread threshold (auto calibrate if requested or <= 0)
    let spread = typeof opts.spreadThreshold === "number" && opts.spreadThreshold > 0 ? opts.spreadThreshold : 0.25;
    if (opts.spreadThreshold === "auto" || !opts.spreadThreshold) {
      const cal = AutoCalibrator.calibrate(symbol, candles);
      spread = cal.bestSpreadPct || 0.25;
    }

    const warmup = Math.min(100, Math.floor(candles.length / 4));
    let cash = initialCapital;
    let heldQty = 0;
    let entryPrice = 0;
    let entryIdx = 0;
    let initialSlPrice = 0;
    let stopLossPrice = 0;
    let tp1Filled = false;
    let tp1Price = 0;
    let tp1Time = 0;
    let highestSinceTp1 = 0;
    let activeTradeId = 0;
    let spreadAtEntry = 0;

    const trades: BacktestTrade[] = [];
    const markers: BacktestMarker[] = [];

    let grossProfit = 0;
    let grossLoss = 0;
    let wins = 0;
    let losses = 0;
    let peakEquity = initialCapital;
    let maxDrawdownPct = 0;

    for (let i = warmup; i < candles.length; i++) {
      const c = candles[i]!;
      const ribbon = RibbonEngine.computeRibbonState(candles, i);

      // Current portfolio equity
      const currentEquity = cash + (heldQty > 0 ? heldQty * c.close : 0);
      if (currentEquity > peakEquity) peakEquity = currentEquity;
      const dd = peakEquity > 0 ? ((peakEquity - currentEquity) / peakEquity) * 100 : 0;
      if (dd > maxDrawdownPct) maxDrawdownPct = dd;

      // ─── POSITION EXITS ──────────────────────────────────────────────
      if (heldQty > 0) {
        if (c.high > highestSinceTp1) highestSinceTp1 = c.high;
        const barsHeld = i - entryIdx;

        // Dynamic Ratchet SL: After entry, if price forms higher local base, lift SL
        // Works both before TP1 (risk reduction) and after TP1 (profit lock)
        if (useRatchetSl && barsHeld >= 3) {
          const recent3Lows = candles.slice(Math.max(0, i - 4), i + 1).map((x) => x.low);
          const localLow = Math.min(...recent3Lows) * (1 - slBufferPct / 100);
          if (localLow > stopLossPrice && localLow < c.close) {
            stopLossPrice = localLow;
          }
        }

        // 1. Check TP2 first if TP1 was already filled (Macro Target or Trailing Stop)
        if (tp1Filled && heldQty > 0) {
          const target = Math.max(ribbon.ema75, ribbon.ema200);
          const hitTarget = c.high >= target && c.high > entryPrice * 1.0035;
          const hitTrailing = highestSinceTp1 > entryPrice * 1.005 && c.low <= highestSinceTp1 * 0.9965;

          if (hitTarget || hitTrailing) {
            const exitP = hitTarget ? Math.min(c.high, Math.max(target, c.close)) : highestSinceTp1 * 0.9965;
            const pnl2 = (exitP - entryPrice) * heldQty;
            cash += heldQty * exitP;

            const totalPnlQuote = (tp1Price - entryPrice) * heldQty + pnl2;
            const totalInvest = initialCapital * 0.98;
            const tradePnlPct = (totalPnlQuote / totalInvest) * 100;

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
            continue;
          }
        }

        // 2. Stop Loss check
        if (c.low <= stopLossPrice) {
          const exitP = stopLossPrice;
          const pnl = (exitP - entryPrice) * heldQty;
          cash += heldQty * exitP;

          const isRatchet = !tp1Filled && stopLossPrice > initialSlPrice;
          const exitType: BacktestTrade["exitType"] = tp1Filled ? "TP1+SL_BE" : isRatchet ? "RATCHET_SL" : "SL";
          const totalPnlQuote = pnl + (tp1Filled ? (tp1Price - entryPrice) * (heldQty) : 0);
          const totalInvest = initialCapital * 0.98;
          const tradePnlPct = (totalPnlQuote / totalInvest) * 100;

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
          continue;
        }

        // 3. TP1 at EMA 25 (Sell 50%)
        if (!tp1Filled && c.high >= ribbon.ema25 && ribbon.ema25 > entryPrice * 1.0015) {
          tp1Price = ribbon.ema25;
          tp1Time = c.time;
          const sellQty = heldQty * 0.5;
          cash += sellQty * tp1Price;
          heldQty -= sellQty;
          tp1Filled = true;
          highestSinceTp1 = tp1Price;
          // Move SL to Breakeven (+0.05% fee buffer)
          stopLossPrice = Math.max(stopLossPrice, entryPrice * 1.0005);

          // TP1 Marker
          markers.push({
            time: c.time,
            position: "aboveBar",
            color: "#38bdf8",
            shape: "circle",
            text: `🔵 TP1 (50%) #${activeTradeId} @ $${tp1Price.toFixed(2)} (+${(((tp1Price - entryPrice) / entryPrice) * 100).toFixed(2)}%)`,
          });
        }
      }

      // ─── POSITION ENTRY (SNIPER HOOK) ────────────────────────────────
      if (heldQty === 0 && cash >= 10) {
        const exhaustion = ExhaustionEngine.evaluate(candles, i);
        const isStretched = ribbon.fanSpreadPct >= spread;

        if (ribbon.isFanningDown && isStretched && ribbon.isHookUp && exhaustion.isOversoldExhaustion) {
          activeTradeId++;
          entryIdx = i;
          entryPrice = c.close;
          spreadAtEntry = ribbon.fanSpreadPct;

          const recentLows = candles.slice(Math.max(0, i - 10), i + 1).map((x) => x.low);
          const lowestPoint = Math.min(...recentLows);
          initialSlPrice = lowestPoint * (1 - slBufferPct / 100);
          stopLossPrice = initialSlPrice;

          const invest = cash * 0.98;
          heldQty = invest / entryPrice;
          cash -= invest;
          tp1Filled = false;
          highestSinceTp1 = entryPrice;

          // Buy Marker
          markers.push({
            time: c.time,
            position: "belowBar",
            color: "#10b981",
            shape: "arrowUp",
            text: `🟢 BUY #${activeTradeId} @ $${entryPrice.toFixed(2)} (Spread: ${spreadAtEntry.toFixed(2)}%)`,
          });
        }
      }
    }

    // Performance Summary Calculations
    const finalCapital = cash + (heldQty > 0 ? heldQty * candles[candles.length - 1]!.close : 0);
    const netPnlQuote = finalCapital - initialCapital;
    const netPnlPct = (netPnlQuote / initialCapital) * 100;
    const totalTrades = trades.length;
    const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99.9 : 0;
    const avgBarsHeld = totalTrades > 0 ? Math.round(trades.reduce((a, b) => a + b.holdingBars, 0) / totalTrades) : 0;

    const pnlPcts = trades.map((t) => t.pnlPct);
    const bestTradePct = pnlPcts.length > 0 ? Math.max(...pnlPcts) : 0;
    const worstTradePct = pnlPcts.length > 0 ? Math.min(...pnlPcts) : 0;

    const summary: BacktestSummary = {
      initialCapital,
      finalCapital: Number(finalCapital.toFixed(2)),
      netPnlQuote: Number(netPnlQuote.toFixed(2)),
      netPnlPct: Number(netPnlPct.toFixed(2)),
      totalTrades,
      winTrades: wins,
      lossTrades: losses,
      winRate: Number(winRate.toFixed(1)),
      profitFactor: Number(profitFactor.toFixed(2)),
      maxDrawdownPct: Number(maxDrawdownPct.toFixed(2)),
      avgBarsHeld,
      bestTradePct: Number(bestTradePct.toFixed(2)),
      worstTradePct: Number(worstTradePct.toFixed(2)),
    };

    const id = `bt_${Date.now()}`;
    const record: BacktestRecord = {
      id,
      createdAt: new Date().toISOString(),
      symbol,
      timeframe,
      candleCount: candles.length,
      spreadThreshold: spread,
      useRatchetSl,
      summary,
      trades,
      markers: markers.sort((a, b) => a.time - b.time),
      candles,
    };

    // Save to persistent database
    this.saveRecord(record);

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
}
