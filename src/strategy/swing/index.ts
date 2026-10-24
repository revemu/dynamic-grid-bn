/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import type { IExchangeClient, ExchangeSymbolInfo } from "../../exchange/types.js";
import type { Config } from "../../config.js";
import type { AtrSource } from "../../types.js";
import { type DowStructureEngine, type Candle } from "../../market-structure.js";
import { BotDatabase, getDatabase } from "../../db.js";
import type {
  IStrategy,
  StrategyType,
  StrategyContext,
  StrategyEvent,
  Lot,
  OpenOrder,
} from "../types.js";
import type { SwingStrategyConfig } from "./config.js";
import { SwingSignalDetector, type SwingSignalResult } from "./signals.js";

export type SwingTradeState = "WAITING_SETUP" | "IN_POSITION" | "TP1_REACHED" | "EXITING";

export interface ActiveSwingPosition {
  entryTime: number;
  entryPrice: number;
  qty: number;
  notionalQuote: number;
  stopLossPrice: number;
  tp1Price: number;
  tp2Price: number;
  tp1Executed: boolean;
  highestPriceSinceEntry: number;
  trailingStopActive: boolean;
  trailingStopPrice?: number;
  signalType: string;
  reason: string;
}

export class SwingTraderStrategy implements IStrategy {
  public readonly name = "Swing Trader";
  public readonly strategyType: StrategyType = "swing_trade";

  public binance: IExchangeClient;
  private symbolInfo: ExchangeSymbolInfo;
  public cfg: Config;
  public atrSource: AtrSource;
  public readonly log: (msg: string, extra?: unknown) => void;
  public dowEngine?: DowStructureEngine;
  public localTrendEngine?: DowStructureEngine;
  public htfDowEngine?: DowStructureEngine;

  public db: BotDatabase;
  public lots: Lot[] = [];
  public openOrders: OpenOrder[] = [];
  public isPaused = false;
  public isSwitchingSymbol = false;

  public walletBaseBalance = 0;
  public walletQuoteBalance = 0;

  // Swing Strategy Specific State
  public swingState: SwingTradeState = "WAITING_SETUP";
  public activePosition?: ActiveSwingPosition;
  public lastSignal?: SwingSignalResult;
  public lastRefPrice = 0;
  public realizedPnl = 0;

  private eventListeners: ((event: StrategyEvent) => void)[] = [];

  constructor(ctx: StrategyContext) {
    this.binance = ctx.exchange;
    this.symbolInfo = ctx.symbolInfo;
    this.cfg = ctx.config;
    this.atrSource = ctx.atrSource;
    this.log = ctx.log;
    this.dowEngine = ctx.macroDowEngine;
    this.localTrendEngine = ctx.localTrendEngine;
    this.htfDowEngine = ctx.htfDowEngine;

    this.db = getDatabase({ dbPath: this.cfg.dbPath });
    this.isPaused = this.cfg.startPaused ?? false;

    // 🛡️ Recover persisted state from database across reboots
    const savedState = this.db.getState(this.symbolInfo.symbol);
    if (savedState) {
      if (Array.isArray(savedState.lots) && savedState.lots.length > 0) {
        this.lots = [...savedState.lots];
      }
      if ((savedState as any).activeSwingPosition) {
        this.activePosition = (savedState as any).activeSwingPosition;
        this.swingState = (savedState as any).swingState || "IN_POSITION";
        this.log(
          `[SwingTrader] 🔄 Recovered active swing position for ${this.symbolInfo.symbol} from database (Entry: $${this.activePosition?.entryPrice.toFixed(4)}, Qty: ${this.activePosition?.qty})`,
        );
      }
      if (typeof savedState.realizedPnl === "number") {
        this.realizedPnl = savedState.realizedPnl;
      }
    }
  }

  public getIntervalMs(): number {
    return this.cfg.intervalMs || 1000;
  }

  public getDatabase(): BotDatabase {
    return this.db;
  }

  public getRealDreamdexPrivateKey(): string | undefined {
    return this.cfg.dreamdexPrivateKey;
  }

  public getRealBinanceApiKey(): string | undefined {
    return this.cfg.binanceApiKey;
  }

  public getRealBinanceApiSecret(): string | undefined {
    return this.cfg.binanceApiSecret;
  }

  public getRuntimeConfig(): any {
    return { ...this.cfg };
  }

  public updateRuntimeSettings(s: any): Record<string, any> {
    this.cfg = { ...this.cfg, ...s };
    try {
      this.db.setSettings(this.cfg);
    } catch (e: any) {
      this.log(`[SwingTrader] Save settings error: ${e}`);
    }
    return { ...this.cfg };
  }

  public setPaused(paused: boolean): boolean {
    this.isPaused = paused;
    this.log(`[SwingTrader] Bot paused state set to: ${paused}`);
    this.emitTelemetryTick();
    return this.isPaused;
  }

  public getIsPaused(): boolean {
    return this.isPaused;
  }

  public baseHeld(): number {
    return this.walletBaseBalance + this.lots.reduce((sum, l) => sum + (l.qty || 0), 0);
  }

  public getLots(): Lot[] {
    return [...this.lots];
  }

  public getRecentOrders(): any[] {
    return [...this.openOrders];
  }

  public onEvent(cb: (event: StrategyEvent) => void): void {
    this.eventListeners.push(cb);
  }

  public emit(event: StrategyEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (e) {
        this.log(`[SwingTrader] Event listener error: ${e}`);
      }
    }
  }

  public roundPrice(price: number): number {
    const tick = this.symbolInfo.tickSize || 0.0001;
    const precision = this.symbolInfo.pricePrecision ?? 4;
    const stepped = Math.round(price / tick) * tick;
    return parseFloat(stepped.toFixed(precision));
  }

  public roundQty(qty: number): number {
    const step = this.symbolInfo.stepSize || 0.0001;
    const precision = this.symbolInfo.qtyPrecision ?? 4;
    const stepped = Math.floor(qty / step) * step;
    return parseFloat(stepped.toFixed(precision));
  }

  public async refreshWalletBalances(): Promise<any> {
    try {
      const b = await this.binance.getAccountBalances(this.symbolInfo.symbol);
      this.walletBaseBalance = b.baseFree;
      this.walletQuoteBalance = b.quoteFree;
      return {
        base: b.baseFree,
        quote: b.quoteFree,
        somi: b.baseFree,
        usdso: b.quoteFree,
        address: "",
      };
    } catch (e) {
      this.log(`[SwingTrader] Failed to fetch balances: ${e}`);
      return { base: 0, quote: 0, somi: 0, usdso: 0, address: "" };
    }
  }

  public async syncOnChainOrders(): Promise<void> {
    try {
      const orders = await this.binance.getOpenOrders(this.symbolInfo.symbol);
      this.openOrders = orders.map((o) => ({
        id: String(o.orderId),
        isBid: o.side === "BUY",
        price: o.price,
        qty: o.origQty,
        targetFraction: 0,
        notionalQuote: o.price * o.origQty,
        notionalUsdso: o.price * o.origQty,
        levelDesc: "Swing Order",
        placedTime: o.time || Date.now(),
      }));
    } catch (e) {
      this.log(`[SwingTrader] Failed to sync open orders: ${e}`);
    }
  }

  public onCandleClosed(candle: Candle): void {
    this.log(`[SwingTrader] Confirmed candle closed at $${candle.close.toFixed(4)} (Time: ${new Date(candle.time * 1000).toLocaleTimeString()})`);
    this.emitTelemetryTick();
  }

  public setSwitchingSymbol(val: boolean): void {
    this.isSwitchingSymbol = val;
  }

  public async prepareForSymbolSwitch(targetSymbol: string): Promise<void> {
    this.log(`[SwingTrader] Preparing for symbol switch to ${targetSymbol}`);
    await this.cancelAllOrdersUser();
  }

  public updateExchangeClient(newExchange: IExchangeClient, nextInfo: ExchangeSymbolInfo, atrSource: AtrSource): void {
    this.binance = newExchange;
    this.symbolInfo = nextInfo;
    this.atrSource = atrSource;
  }

  public updateSymbolInfo(nextInfo: ExchangeSymbolInfo, atrSource: AtrSource): void {
    this.symbolInfo = nextInfo;
    this.atrSource = atrSource;
  }

  public async cancelAllOrdersUser(): Promise<{ cancelledCount: number; }> {
    let count = 0;
    try {
      await this.binance.cancelAllOpenOrders(this.symbolInfo.symbol);
      count = this.openOrders.length;
      this.openOrders = [];
      this.saveState(true);
      this.log(`[SwingTrader] All open orders cancelled by user`);
    } catch (e) {
      this.log(`[SwingTrader] Cancel all orders error: ${e}`);
    }
    return { cancelledCount: count };
  }

  public async sellAllUser(): Promise<{ success: boolean; soldQty: number; price: number; error?: string; }> {
    this.log(`[SwingTrader] Emergency market sell requested by user`);
    const held = this.baseHeld();
    const qty = this.roundQty(held);
    if (qty >= (this.symbolInfo.minQty || 0.0001)) {
      try {
        const res = await this.binance.placeOrder({
          symbol: this.symbolInfo.symbol,
          side: "SELL",
          type: "MARKET",
          qty,
        });
        this.lots = [];
        this.activePosition = undefined;
        this.swingState = "WAITING_SETUP";
        this.saveState(true);
        await this.refreshWalletBalances();
        return { success: true, soldQty: qty, price: res.price || this.lastRefPrice };
      } catch (e: any) {
        this.log(`[SwingTrader] Emergency sell failed: ${e}`);
        return { success: false, soldQty: 0, price: 0, error: e?.message };
      }
    }
    return { success: true, soldQty: 0, price: 0 };
  }

  public async resetBotState(opts?: any): Promise<{ success: boolean; }> {
    this.lots = [];
    this.activePosition = undefined;
    this.swingState = "WAITING_SETUP";
    this.openOrders = [];
    if (opts?.resetPnl) {
      this.realizedPnl = 0;
    }
    this.saveState(true);
    this.log(`[SwingTrader] Bot state reset`);
    return { success: true };
  }

  public async resetPosition(): Promise<{ success: boolean; clearedLots: number; }> {
    const count = this.lots.length;
    this.lots = [];
    this.activePosition = undefined;
    this.swingState = "WAITING_SETUP";
    this.saveState(true);
    this.log(`[SwingTrader] Position state reset`);
    return { success: true, clearedLots: count };
  }

  public reloadState(): void {
    const saved = this.db.getState(this.symbolInfo.symbol);
    if (saved) {
      this.lots = saved.lots || [];
      this.activePosition = (saved as any).activeSwingPosition;
      this.swingState = (saved as any).swingState || "WAITING_SETUP";
    }
    this.log(`[SwingTrader] State reloaded from database`);
  }

  public saveState(immediate = false): void {
    try {
      this.db.saveState({
        symbol: this.symbolInfo.symbol,
        lots: this.lots,
        openOrders: this.openOrders,
        realizedPnl: this.realizedPnl,
        tradeRealizedPnl: this.realizedPnl,
        activeSwingPosition: this.activePosition,
        swingState: this.swingState,
      } as any);
    } catch (e) {
      this.log(`[SwingTrader] Failed to persist state: ${e}`);
    }
  }

  // ── Main Execution Loop ──────────────────────────────────────────────────
  public async tick(): Promise<void> {
    if (this.isPaused || this.isSwitchingSymbol) return;

    try {
      const tob = await this.binance.getTopOfBook(this.symbolInfo.symbol);
      // 🛡️ Bug 1 Fix: TopOfBook safety guard
      if (!tob || !tob.bestBid || !tob.bestAsk) return;

      const refPrice = (tob.bestBid + tob.bestAsk) / 2;
      this.lastRefPrice = refPrice;

      // Extract market structure
      const structure = this.dowEngine?.getStructure(refPrice, undefined, {
        useTrueWick: this.cfg.useTrueWick,
        wickThresholdPct: this.cfg.wickThresholdPct,
        srLookbackCandles: this.cfg.srLookbackCandles,
      });

      const swingCfg: SwingStrategyConfig = {
        minRiskReward: this.cfg.swingMinRiskReward ?? 2.0,
        stopLossBufferPct: this.cfg.swingStopLossBufferPct ?? 0.5,
        maxPositionPct: this.cfg.swingMaxPositionPct ?? 60.0,
        tp1CloseRatio: this.cfg.swingTp1CloseRatio ?? 0.5,
        tp1TargetType: this.cfg.swingTp1TargetType ?? "CENTER_POC",
        tp2TargetType: this.cfg.swingTp2TargetType ?? "SWING_HIGH_HH",
        trailingActivationPct: this.cfg.swingTrailingActivationPct ?? 1.5,
        trailingPullbackPct: this.cfg.swingTrailingPullbackPct ?? 0.8,
        enableHlBaseEntry: this.cfg.swingEnableHlBaseEntry ?? true,
        enableTrendlineBreakoutEntry: this.cfg.swingEnableTrendlineBreakoutEntry ?? true,
        enableSupportRetestEntry: this.cfg.swingEnableSupportRetestEntry ?? true,
      };

      // 1. Manage Active Position (SL / TP / Trailing Stop)
      if (this.activePosition) {
        await this.manageActivePosition(refPrice, swingCfg);
      } else {
        // 2. Scan for New Entry Setup
        const signal = SwingSignalDetector.evaluateSetup(refPrice, structure, swingCfg);
        this.lastSignal = signal;
        if (signal.hasSignal && this.swingState === "WAITING_SETUP") {
          await this.executeSwingEntry(signal, refPrice, swingCfg);
        }
      }

      this.emitTelemetryTick();
    } catch (e) {
      this.log(`[SwingTrader] Tick error: ${e}`);
    }
  }

  private async manageActivePosition(refPrice: number, cfg: SwingStrategyConfig): Promise<void> {
    if (!this.activePosition) return;
    const pos = this.activePosition;

    // Track highest price seen since entry
    if (refPrice > pos.highestPriceSinceEntry) {
      pos.highestPriceSinceEntry = refPrice;
    }

    const currentGainPct = ((refPrice - pos.entryPrice) / pos.entryPrice) * 100;

    // Trailing Stop Activation after TP1
    if (pos.tp1Executed && currentGainPct >= cfg.trailingActivationPct) {
      pos.trailingStopActive = true;
      const trailingFloor = pos.highestPriceSinceEntry * (1 - cfg.trailingPullbackPct / 100);
      if (!pos.trailingStopPrice || trailingFloor > pos.trailingStopPrice) {
        pos.trailingStopPrice = this.roundPrice(trailingFloor);
      }
    }

    // ── Check Stop Loss Invalidation ─────────────────────────────────────────
    const effectiveSl = pos.trailingStopActive && pos.trailingStopPrice
      ? Math.max(pos.stopLossPrice, pos.trailingStopPrice)
      : pos.stopLossPrice;

    if (refPrice <= effectiveSl) {
      this.log(`[SwingTrader] 🛑 Stop Loss / Trailing Stop triggered at $${refPrice.toFixed(4)} <= $${effectiveSl.toFixed(4)}`);
      await this.sellAllUser();
      return;
    }

    // ── Check Take Profit 1 ──────────────────────────────────────────────────
    if (!pos.tp1Executed && refPrice >= pos.tp1Price) {
      const exitQty = this.roundQty(pos.qty * cfg.tp1CloseRatio);
      if (exitQty >= (this.symbolInfo.minQty || 0.0001)) {
        this.log(
          `[SwingTrader] 🎯 TP1 Target reached ($${refPrice.toFixed(4)} >= $${pos.tp1Price.toFixed(4)}) — Closing ${(cfg.tp1CloseRatio * 100).toFixed(0)}% (${exitQty.toFixed(4)})`,
        );
        try {
          await this.binance.placeOrder({
            symbol: this.symbolInfo.symbol,
            side: "SELL",
            type: "MARKET",
            qty: exitQty,
          });
          pos.tp1Executed = true;
          pos.qty = this.roundQty(pos.qty - exitQty);
          // 🛡️ Raise Stop Loss to Breakeven to guarantee risk-free trade!
          pos.stopLossPrice = pos.entryPrice;
          this.swingState = "TP1_REACHED";
          this.saveState(true);
          this.log(`[SwingTrader] 🛡️ Stop Loss moved to Breakeven ($${pos.entryPrice.toFixed(4)}) — Trade is now 100% Risk-Free!`);
          await this.refreshWalletBalances();
        } catch (e) {
          this.log(`[SwingTrader] TP1 execution failed: ${e}`);
        }
        return;
      }
    }

    // ── Check Take Profit 2 ──────────────────────────────────────────────────
    if (pos.tp1Executed && refPrice >= pos.tp2Price) {
      this.log(`[SwingTrader] 🚀 TP2 Final Target reached ($${refPrice.toFixed(4)} >= $${pos.tp2Price.toFixed(4)}) — Closing remaining position`);
      await this.sellAllUser();
    }
  }

  private async executeSwingEntry(signal: SwingSignalResult, price: number, cfg: SwingStrategyConfig): Promise<void> {
    await this.refreshWalletBalances();
    const availableQuote = this.walletQuoteBalance;
    const maxBudget = availableQuote * (cfg.maxPositionPct / 100);

    if (maxBudget < (this.symbolInfo.minNotional || 5)) {
      this.log(`[SwingTrader] Insufficient quote balance for swing trade ($${availableQuote.toFixed(2)} available)`);
      return;
    }

    // 🛡️ Bug 2 Fix: Apply roundQty to satisfy lot size & precision filters
    const rawQty = maxBudget / price;
    const qty = this.roundQty(rawQty);

    if (qty < (this.symbolInfo.minQty || 0.0001)) {
      this.log(`[SwingTrader] Computed qty ${qty} is less than exchange minQty ${this.symbolInfo.minQty}`);
      return;
    }

    this.log(
      `[SwingTrader] 🚀 Executing Swing Entry (${signal.signalType}) at $${price.toFixed(4)} | Budget: $${maxBudget.toFixed(2)} | Qty: ${qty} | SL: $${signal.stopLossPrice.toFixed(4)} | TP1: $${signal.tp1Price.toFixed(4)} | TP2: $${signal.tp2Price.toFixed(4)} | R:R: ${signal.riskRewardRatio.toFixed(2)}`,
    );

    try {
      await this.binance.placeOrder({
        symbol: this.symbolInfo.symbol,
        side: "BUY",
        type: "MARKET",
        qty,
      });

      this.activePosition = {
        entryTime: Date.now(),
        entryPrice: price,
        qty,
        notionalQuote: maxBudget,
        stopLossPrice: this.roundPrice(signal.stopLossPrice),
        tp1Price: this.roundPrice(signal.tp1Price),
        tp2Price: this.roundPrice(signal.tp2Price),
        tp1Executed: false,
        highestPriceSinceEntry: price,
        trailingStopActive: false,
        signalType: signal.signalType || "SWING",
        reason: signal.reason,
      };

      this.lots.push({
        price,
        qty,
        time: Date.now(),
      });

      this.swingState = "IN_POSITION";
      this.saveState(true);
      await this.refreshWalletBalances();
    } catch (e) {
      this.log(`[SwingTrader] Swing Entry failed: ${e}`);
    }
  }

  public emitTelemetryTick(): void {
    const structure = this.dowEngine?.getStructure(this.lastRefPrice, undefined);
    const telemetry = {
      symbol: this.symbolInfo.symbol,
      refPrice: this.lastRefPrice,
      isPaused: this.isPaused,
      strategyType: this.strategyType,
      strategyName: this.name,
      swingState: this.swingState,
      activePosition: this.activePosition,
      lastSignal: this.lastSignal,
      walletBaseBalance: this.walletBaseBalance,
      walletQuoteBalance: this.walletQuoteBalance,
      openOrders: this.openOrders,
      regime: structure?.regime ?? "RANGE",
      channel: structure
        ? {
            floor: structure.bottomBound,
            center: structure.centerPrice,
            ceiling: structure.upperBound,
          }
        : undefined,
      // 🛡️ Bug 5: Supply SL, TP1, and TP2 lines for TradingView Lightweight Charts rendering
      buyLevels: this.activePosition ? [this.activePosition.entryPrice] : [],
      sellLevels: this.activePosition ? [this.activePosition.tp1Price, this.activePosition.tp2Price] : [],
      cutLossBound: this.activePosition ? this.activePosition.stopLossPrice : (structure?.cutLossBound ?? 0),
      botAction: {
        code: this.activePosition ? "IN_SWING_TRADE" : "WAITING_SWING_SETUP",
        title: this.activePosition
          ? this.activePosition.tp1Executed
            ? "🚀 TP1 Done — Trailing Trend"
            : "📈 Swing Position Active"
          : "🔍 Scanning for Swing Setup",
        reason: this.activePosition
          ? `Holding ${this.activePosition.qty.toFixed(4)} from $${this.activePosition.entryPrice.toFixed(4)} (SL: $${this.activePosition.stopLossPrice.toFixed(4)} | TP1: $${this.activePosition.tp1Price.toFixed(4)} | TP2: $${this.activePosition.tp2Price.toFixed(4)})`
          : this.lastSignal?.reason || "Waiting for confirmed Higher Low or Trendline Breakout",
        nextTrigger: this.activePosition
          ? this.activePosition.tp1Executed
            ? `TP2: >$${this.activePosition.tp2Price.toFixed(4)}`
            : `TP1: >$${this.activePosition.tp1Price.toFixed(4)}`
          : "Wait HL Base Confirm",
        severity: this.activePosition ? "info" : "warning",
      },
      time: Math.floor(Date.now() / 1000),
    };

    this.emit({
      type: "tick",
      data: telemetry,
    });
  }
}
