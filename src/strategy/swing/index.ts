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
import { VolumeProfileEngine, type VolumeProfileResult } from "../../market-structure/volume-profile.js";
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
  public bid = 0;
  public ask = 0;
  public mid = 0;
  private lastBalanceRefreshTime = 0;

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
    this.refreshWalletBalances().catch(() => {});
  }

  public getIntervalMs(): number {
    return this.cfg.intervalMs || 1000;
  }

  public getDatabase(): BotDatabase {
    return this.db;
  }

  public getRealDreamdexPrivateKey(): string | undefined {
    const k = this.cfg.dreamdexPrivateKey;
    return (k && k !== "******") ? k : (process.env.DREAMDEX_PRIVATE_KEY || process.env.PRIVATE_KEY);
  }

  public getRealBinanceApiKey(): string | undefined {
    const k = this.cfg.binanceApiKey;
    return (k && k !== "******") ? k : process.env.BINANCE_API_KEY;
  }

  public getRealBinanceApiSecret(): string | undefined {
    const s = this.cfg.binanceApiSecret;
    return (s && s !== "******") ? s : process.env.BINANCE_API_SECRET;
  }

  public getRuntimeConfig(): any {
    return {
      ...this.cfg,
      strategyType: "swing_trade",
      binanceApiKey: this.cfg.binanceApiKey ? "******" : "",
      binanceApiSecret: this.cfg.binanceApiSecret ? "******" : "",
      dreamdexPrivateKey: this.cfg.dreamdexPrivateKey ? "******" : "",
      swingMinRiskReward: this.cfg.swingMinRiskReward ?? 2.0,
      swingStopLossBufferPct: this.cfg.swingStopLossBufferPct ?? 0.5,
      swingMaxPositionPct: this.cfg.swingMaxPositionPct ?? 60.0,
      swingTp1CloseRatio: this.cfg.swingTp1CloseRatio ?? 0.5,
      swingTp1TargetType: this.cfg.swingTp1TargetType ?? "CENTER_POC",
      swingTp2TargetType: this.cfg.swingTp2TargetType ?? "SWING_HIGH_HH",
      swingTrailingActivationPct: this.cfg.swingTrailingActivationPct ?? 1.5,
      swingTrailingPullbackPct: this.cfg.swingTrailingPullbackPct ?? 0.8,
      swingEnableHlBaseEntry: this.cfg.swingEnableHlBaseEntry !== false,
      swingEnableTrendlineBreakoutEntry: this.cfg.swingEnableTrendlineBreakoutEntry !== false,
      swingEnableSupportRetestEntry: this.cfg.swingEnableSupportRetestEntry !== false,
    };
  }

  public updateRuntimeSettings(s: any): Record<string, any> {
    const cleanSettings = { ...s };
    if (cleanSettings.binanceApiKey === "******") delete cleanSettings.binanceApiKey;
    if (cleanSettings.binanceApiSecret === "******") delete cleanSettings.binanceApiSecret;
    if (cleanSettings.dreamdexPrivateKey === "******") delete cleanSettings.dreamdexPrivateKey;
    this.cfg = { ...this.cfg, ...cleanSettings, strategyType: "swing_trade" };
    try {
      const toPersist: Record<string, any> = { ...this.db.getAllSettings(), ...this.cfg };
      if (toPersist.binanceApiKey === "******") delete toPersist.binanceApiKey;
      if (toPersist.binanceApiSecret === "******") delete toPersist.binanceApiSecret;
      if (toPersist.dreamdexPrivateKey === "******") delete toPersist.dreamdexPrivateKey;
      this.db.setSettings(toPersist);
    } catch (e: any) {
      this.log(`[SwingTrader] Save settings error: ${e}`);
    }
    return this.getRuntimeConfig();
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
    if (event.type === "order") {
      event.data = {
        ...event.data,
        symbol: event.data.symbol || this.symbolInfo.symbol,
        baseAsset: event.data.baseAsset || this.symbolInfo.baseAsset,
        quoteAsset: event.data.quoteAsset || this.symbolInfo.quoteAsset,
      };
      try {
        this.db.recordEvent(event.data);
        this.saveState();
      } catch (e) {
        this.log(`[SwingTrader] Failed to persist order event: ${e}`);
      }
    }
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (e) {
        this.log(`[SwingTrader] Event listener error: ${e}`);
      }
    }
  }

  public handleWsBookTicker(b: any): void {
    if (!b) return;
    if (b.bid) this.bid = b.bid;
    if (b.ask) this.ask = b.ask;
    if (b.bid && b.ask) {
      this.mid = (b.bid + b.ask) / 2;
      this.lastRefPrice = this.mid;
    }
  }

  public handleWsExecutionReport(rep: any): void {
    if (!rep) return;
    if (rep.orderStatus === "FILLED" || rep.orderStatus === "PARTIALLY_FILLED") {
      this.log(`⚡ [SwingTrader WS] Execution report: order ${rep.orderId} ${rep.orderStatus} @ ${rep.lastFilledPrice}`);
      this.syncOnChainOrders().catch(() => {});
    }
  }

  public handleWsAccountUpdate(acc: any): void {
    if (!acc) return;
    if (acc.balances && Array.isArray(acc.balances)) {
      const baseAsset = (this.symbolInfo?.baseAsset || "").toUpperCase();
      const quoteAsset = (this.symbolInfo?.quoteAsset || "").toUpperCase();
      for (const b of acc.balances) {
        if (b.asset === baseAsset) this.walletBaseBalance = b.free;
        if (b.asset === quoteAsset) this.walletQuoteBalance = b.free;
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
      this.walletBaseBalance = b.baseFree ?? 0;
      this.walletQuoteBalance = b.quoteFree ?? 0;
      const addr = (this.binance as any).getWalletAddress?.() || `${this.symbolInfo.baseAsset}/${this.symbolInfo.quoteAsset}`;
      return {
        base: this.walletBaseBalance,
        quote: this.walletQuoteBalance,
        somi: this.walletBaseBalance,
        usdso: this.walletQuoteBalance,
        address: addr,
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

  public async sellAllUser(reason?: string): Promise<{ success: boolean; soldQty: number; price: number; error?: string; }> {
    this.log(`[SwingTrader] Market sell requested: ${reason || "Emergency market sell by user"}`);
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
        const execPrice = res.price || this.lastRefPrice;
        let pnl = 0;
        if (this.activePosition) {
          pnl = (execPrice - this.activePosition.entryPrice) * qty;
          this.realizedPnl += pnl;
        }

        this.emit({
          type: "order",
          data: {
            id: `ord_${Date.now()}_exit`,
            orderId: String(res.orderId || Date.now()),
            symbol: this.symbolInfo.symbol,
            side: "SELL",
            price: execPrice,
            qty,
            notionalQuote: execPrice * qty,
            levelDesc: reason || (this.activePosition?.tp1Executed ? "Swing TP2 Target" : "Swing Exit / Stop Loss"),
            status: "FILLED",
            realizedPnl: pnl,
            placedTime: Date.now(),
            fillTime: Date.now(),
          },
        });

        this.lots = [];
        this.activePosition = undefined;
        this.swingState = "WAITING_SETUP";
        this.saveState(true);
        await this.refreshWalletBalances();
        return { success: true, soldQty: qty, price: execPrice };
      } catch (e: any) {
        this.log(`[SwingTrader] Sell execution failed: ${e}`);
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

  private getVolumeProfile(): VolumeProfileResult | undefined {
    if (this.cfg.channelMode === "VOLUME_PROFILE_HTF") {
      const macroCandles = this.dowEngine?.getCandles() ?? [];
      return VolumeProfileEngine.calculate(macroCandles, this.cfg.vpLookbackBars ?? 192);
    }
    return undefined;
  }

  private getHtfStructure(refPrice: number): { floor: number; ceiling: number; swings?: any[] } | undefined {
    if (this.htfDowEngine) {
      const htfDow = this.htfDowEngine.getStructure(refPrice, undefined, {
        mode: "DOW_SWINGS",
        minChannelWidthPct: 3.0,
        maxChannelWidthPct: 25.0,
      });
      if (htfDow && htfDow.bottomBound > 0 && htfDow.upperBound > 0) {
        return {
          floor: htfDow.bottomBound,
          ceiling: htfDow.upperBound,
          swings: htfDow.swingLows,
        };
      }
    }
    return undefined;
  }

  // ── Main Execution Loop ──────────────────────────────────────────────────
  public async tick(): Promise<void> {
    if (this.isSwitchingSymbol) return;

    try {
      const tob = await this.binance.getTopOfBook(this.symbolInfo.symbol);
      // 🛡️ Bug 1 Fix: TopOfBook safety guard
      if (!tob || !tob.bestBid || !tob.bestAsk) return;

      const refPrice = (tob.bestBid + tob.bestAsk) / 2;
      this.lastRefPrice = refPrice;
      this.mid = refPrice;
      this.bid = tob.bestBid;
      this.ask = tob.bestAsk;

      // Periodically refresh wallet balances from exchange
      const now = Date.now();
      if (now - this.lastBalanceRefreshTime > 10_000) {
        this.lastBalanceRefreshTime = now;
        await this.refreshWalletBalances().catch(() => {});
      }

      const volumeProfile = this.getVolumeProfile();
      const htfStructure = this.getHtfStructure(refPrice);

      // Extract market structure
      const structure = this.dowEngine?.getStructure(refPrice, undefined, {
        mode: (this.cfg.channelMode as any) || "DOW_SWINGS",
        minChannelWidthPct: this.cfg.minChannelWidthPct,
        maxChannelWidthPct: this.cfg.maxChannelWidthPct,
        atrMinMultiplier: this.cfg.atrMinMultiplier,
        atrMaxMultiplier: this.cfg.atrMaxMultiplier,
        useTrueWick: this.cfg.useTrueWick,
        wickThresholdPct: this.cfg.wickThresholdPct,
        srLookbackCandles: this.cfg.srLookbackCandles,
        useOnlyClosedCandles: this.cfg.adjustChannelOnClosedOnly,
        volumeProfile,
        htfStructure,
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

      // Only execute entries/exits if bot is NOT paused
      const candles = this.dowEngine?.getCandles() ?? [];

      if (!this.isPaused) {
        // 1. Manage Active Position (SL / TP / Trailing Stop)
        if (this.activePosition) {
          await this.manageActivePosition(refPrice, swingCfg);
        } else {
          // 2. Scan for New Entry Setup
          const signal = SwingSignalDetector.evaluateSetup(refPrice, structure, swingCfg, candles);
          this.lastSignal = signal;
          if (signal.hasSignal && this.swingState === "WAITING_SETUP") {
            await this.executeSwingEntry(signal, refPrice, swingCfg);
          }
        }
      } else {
        // In paused mode, scan for signals for UI preview
        const signal = SwingSignalDetector.evaluateSetup(refPrice, structure, swingCfg, candles);
        this.lastSignal = signal;
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
      await this.sellAllUser("Swing Stop Loss Triggered");
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
          const res = await this.binance.placeOrder({
            symbol: this.symbolInfo.symbol,
            side: "SELL",
            type: "MARKET",
            qty: exitQty,
          });
          const execPrice = res.price || refPrice;
          const pnl = (execPrice - pos.entryPrice) * exitQty;
          this.realizedPnl += pnl;

          this.emit({
            type: "order",
            data: {
              id: `ord_${Date.now()}_tp1`,
              orderId: String(res.orderId || Date.now()),
              symbol: this.symbolInfo.symbol,
              side: "SELL",
              price: execPrice,
              qty: exitQty,
              notionalQuote: execPrice * exitQty,
              levelDesc: `Swing TP1 Target (${(cfg.tp1CloseRatio * 100).toFixed(0)}%)`,
              status: "FILLED",
              realizedPnl: pnl,
              placedTime: Date.now(),
              fillTime: Date.now(),
            },
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
      await this.sellAllUser("Swing TP2 Target Reached");
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

      this.emit({
        type: "order",
        data: {
          id: `ord_${Date.now()}_buy`,
          orderId: String(Date.now()),
          symbol: this.symbolInfo.symbol,
          side: "BUY",
          price,
          qty,
          notionalQuote: maxBudget,
          levelDesc: `Swing Entry (${signal.signalType || "SWING"})`,
          status: "FILLED",
          placedTime: Date.now(),
          fillTime: Date.now(),
        },
      });

      await this.refreshWalletBalances();
    } catch (e) {
      this.log(`[SwingTrader] Swing Entry failed: ${e}`);
    }
  }

  public emitTelemetryTick(): void {
    const volumeProfile = this.getVolumeProfile();
    const htfStructure = this.getHtfStructure(this.lastRefPrice);

    const structure = this.dowEngine?.getStructure(this.lastRefPrice, undefined, {
      mode: (this.cfg.channelMode as any) || "DOW_SWINGS",
      minChannelWidthPct: this.cfg.minChannelWidthPct,
      maxChannelWidthPct: this.cfg.maxChannelWidthPct,
      atrMinMultiplier: this.cfg.atrMinMultiplier,
      atrMaxMultiplier: this.cfg.atrMaxMultiplier,
      useTrueWick: this.cfg.useTrueWick,
      wickThresholdPct: this.cfg.wickThresholdPct,
      srLookbackCandles: this.cfg.srLookbackCandles,
      useOnlyClosedCandles: this.cfg.adjustChannelOnClosedOnly,
      volumeProfile,
      htfStructure,
    });
    const currentMid = this.mid || this.lastRefPrice;
    const baseHeldVal = this.baseHeld();
    const invUsd = this.activePosition ? this.activePosition.qty * currentMid : (baseHeldVal * currentMid);
    const somiVal = this.walletBaseBalance * currentMid;
    const totalVal = somiVal + this.walletQuoteBalance;
    const maxInv = this.cfg.maxInventoryQuote ?? 50;

    const floor = structure?.bottomBound ?? 0;
    const ceil = structure?.upperBound ?? 0;
    const center = structure?.centerPrice ?? (floor > 0 && ceil > 0 ? (floor + ceil) / 2 : 0);
    const zoneWidthPct = floor > 0 && ceil > floor ? ((ceil - floor) / floor) * 100 : 0;
    const positionPct = (floor > 0 && ceil > floor)
      ? Math.min(100, Math.max(0, ((currentMid - floor) / (ceil - floor)) * 100))
      : 50;

    // Targets and lines
    let entryPrice = 0;
    let slPrice = 0;
    let tp1Price = 0;
    let tp2Price = 0;
    let rrRatio = 0;

    if (this.activePosition) {
      entryPrice = this.activePosition.entryPrice;
      slPrice = this.activePosition.trailingStopActive && this.activePosition.trailingStopPrice
        ? Math.max(this.activePosition.stopLossPrice, this.activePosition.trailingStopPrice)
        : this.activePosition.stopLossPrice;
      tp1Price = this.activePosition.tp1Price;
      tp2Price = this.activePosition.tp2Price;
      const risk = entryPrice - slPrice;
      const reward = tp2Price - entryPrice;
      rrRatio = risk > 0 ? reward / risk : 0;
    } else if (this.lastSignal && this.lastSignal.hasSignal && this.lastSignal.entryPrice > 0) {
      entryPrice = this.lastSignal.entryPrice;
      slPrice = this.lastSignal.stopLossPrice;
      tp1Price = this.lastSignal.tp1Price;
      tp2Price = this.lastSignal.tp2Price;
      rrRatio = this.lastSignal.riskRewardRatio;
    } else if (this.lastSignal && (this.lastSignal.plannedEntryPrice ?? 0) > 0) {
      // Standby / Pullback mode: Display planned battle plan levels so UI & chart are never blank!
      entryPrice = this.lastSignal.plannedEntryPrice!;
      slPrice = this.lastSignal.plannedSlPrice || floor;
      tp1Price = this.lastSignal.plannedTp1Price || center;
      tp2Price = this.lastSignal.plannedTp2Price || ceil;
      rrRatio = this.lastSignal.plannedRrRatio || 0;
    }

    const buyLevels = entryPrice > 0 ? [entryPrice] : [];
    const sellLevels = (tp1Price > 0 && tp2Price > 0) ? [tp1Price, tp2Price] : [];
    const cutLossBound = slPrice > 0 ? slPrice : floor;

    const currentHoldPct = maxInv > 0 ? (invUsd / maxInv) * 100 : 0;
    const targetInventoryQuote = this.activePosition
      ? this.activePosition.notionalQuote
      : (this.lastSignal?.hasSignal ? (this.walletQuoteBalance * ((this.cfg.swingMaxPositionPct ?? 60) / 100)) : 0);
    const targetHoldingPct = maxInv > 0 ? (targetInventoryQuote / maxInv) * 100 : 0;

    const telemetry = {
      time: Math.floor(Date.now() / 1000),
      mid: currentMid,
      refPrice: currentMid,
      symbol: this.symbolInfo.symbol,
      baseAsset: this.symbolInfo.baseAsset,
      quoteAsset: this.symbolInfo.quoteAsset,
      walletAddress: (this.binance as any).walletAddress || (this.binance as any).getAddress?.() || "",
      walletBaseBalance: this.walletBaseBalance,
      walletQuoteBalance: this.walletQuoteBalance,
      walletSomiBalance: this.walletBaseBalance,
      walletUsdsoBalance: this.walletQuoteBalance,
      walletTotalValueQuote: totalVal,
      walletTotalValueUsdso: totalVal,
      baseHeld: baseHeldVal,
      lots: this.lots,
      positionUsdso: invUsd,
      positionQuote: invUsd,
      maxInventoryQuote: maxInv,
      maxInventoryUsdso: maxInv,
      currentHoldPct,
      targetHoldingPct,
      targetInventoryQuote,
      targetInventoryUsdso: targetInventoryQuote,
      realizedPnl: this.realizedPnl,
      tradeRealizedPnl: this.realizedPnl,
      dryRun: Boolean(this.cfg.dryRun),
      isPaused: this.isPaused,
      strategyType: this.strategyType,
      strategyName: this.name,
      swingState: this.swingState,
      activePosition: this.activePosition,
      lastSignal: this.lastSignal,
      openOrders: this.openOrders,
      regime: structure?.regime ?? "RANGE",
      channel: {
        floor,
        center,
        ceiling: ceil,
      },
      // Root Channel & Dow Structure fields expected by Dashboard & Lightweight Charts
      bottomBound: floor,
      upperBound: ceil,
      centerPrice: center,
      cutLossBound,
      zoneWidthPct,
      positionPct,
      channelMode: this.cfg.channelMode || "DOW_SWINGS",
      clampStatus: structure?.gridZone?.clampStatus ?? "NATURAL_SWING",
      isSwingConfirmed: structure?.isSwingConfirmed ?? false,
      poc: structure?.gridZone?.poc,
      vah: structure?.gridZone?.vah,
      val: structure?.gridZone?.val,
      htfFloor: structure?.gridZone?.htfFloor ?? htfStructure?.floor,
      htfCeil: structure?.gridZone?.htfCeil ?? htfStructure?.ceiling,
      canEstablishChannel: true,
      isChannelLocked: false,
      activePeak: structure?.activePeak ? { time: structure.activePeak.time, price: structure.activePeak.price } : undefined,
      activeValley: structure?.activeValley ? { time: structure.activeValley.time, price: structure.activeValley.price } : undefined,
      candidatePeak: structure?.candidatePeak ? {
        time: structure.candidatePeak.time,
        price: structure.candidatePeak.price,
        confirmationCandles: structure.candidatePeak.confirmationCandles,
        requiredCandles: structure.candidatePeak.requiredCandles,
      } : undefined,
      candidateValley: structure?.candidateValley ? {
        time: structure.candidateValley.time,
        price: structure.candidateValley.price,
        confirmationCandles: structure.candidateValley.confirmationCandles,
        requiredCandles: structure.candidateValley.requiredCandles,
      } : undefined,
      swingHighs: (structure?.swingHighs ?? []).map((s) => ({ time: s.time, price: s.price, type: s.type })),
      swingLows: (structure?.swingLows ?? []).map((s) => ({ time: s.time, price: s.price, type: s.type })),
      waveCycle: structure?.waveCycle,
      downtrendLine: structure?.downtrendLine ? {
        type: structure.downtrendLine.type,
        slope: structure.downtrendLine.slope,
        currentLinePrice: structure.downtrendLine.currentLinePrice,
        isBroken: structure.downtrendLine.isBroken,
        breakoutPct: structure.downtrendLine.breakoutPct,
        brokenCandleCount: structure.downtrendLine.brokenCandleCount,
        breakoutConfirmed: structure.downtrendLine.breakoutConfirmed,
        points: structure.downtrendLine.points,
        p1: { time: structure.downtrendLine.p1.time, price: structure.downtrendLine.p1.price },
        p2: { time: structure.downtrendLine.p2.time, price: structure.downtrendLine.p2.price },
      } : undefined,
      uptrendLine: structure?.uptrendLine ? {
        type: structure.uptrendLine.type,
        slope: structure.uptrendLine.slope,
        currentLinePrice: structure.uptrendLine.currentLinePrice,
        isBroken: structure.uptrendLine.isBroken,
        breakoutPct: structure.uptrendLine.breakoutPct,
        brokenCandleCount: structure.uptrendLine.brokenCandleCount,
        breakoutConfirmed: structure.uptrendLine.breakoutConfirmed,
        points: structure.uptrendLine.points,
        p1: { time: structure.uptrendLine.p1.time, price: structure.uptrendLine.p1.price },
        p2: { time: structure.uptrendLine.p2.time, price: structure.uptrendLine.p2.price },
      } : undefined,
      // Target price lines for Swing Setup
      buyLevels,
      sellLevels,
      swingPlan: {
        entryPrice,
        stopLossPrice: slPrice,
        tp1Price,
        tp2Price,
        riskRewardRatio: rrRatio,
        signalType: this.activePosition?.signalType || this.lastSignal?.signalType || (this.lastSignal?.hasSignal ? "READY" : "WAITING_LL_RETEST"),
        reason: this.activePosition?.reason || this.lastSignal?.reason || "Waiting for dip to test Major LL",
        state: this.swingState,
        isPlannedOnly: !this.activePosition && !this.lastSignal?.hasSignal,
      },
      botAction: this.isPaused
        ? {
            code: "PAUSED",
            title: "⏸️ Strategy Paused (Monitoring Mode)",
            reason: "Live chart, market structure & wallet active. Order execution suspended.",
            nextTrigger: "Click 'Resume' button to activate live trading",
            severity: "warning",
          }
        : {
            code: this.activePosition ? "IN_SWING_TRADE" : "WAITING_SWING_SETUP",
            title: this.activePosition
              ? this.activePosition.tp1Executed
                ? "🚀 TP1 Done — Trailing Trend"
                : "📈 Swing Position Active"
              : (this.lastSignal?.hasSignal ? "🎯 Swing Setup Ready" : "⏳ Waiting LL Retest"),
            reason: this.activePosition
              ? `Holding ${this.activePosition.qty.toFixed(4)} from $${this.activePosition.entryPrice.toFixed(4)} (SL: $${this.activePosition.stopLossPrice.toFixed(4)} | TP1: $${this.activePosition.tp1Price.toFixed(4)} | TP2: $${this.activePosition.tp2Price.toFixed(4)})`
              : this.lastSignal?.reason || "Waiting for pullback to Major LL zone",
            nextTrigger: this.activePosition
              ? this.activePosition.tp1Executed
                ? `TP2: >$${this.activePosition.tp2Price.toFixed(4)}`
                : `TP1: >$${this.activePosition.tp1Price.toFixed(4)}`
              : (this.lastSignal?.hasSignal ? "Awaiting Execution" : (entryPrice > 0 ? `Wait Dip to $${entryPrice.toFixed(4)}` : "Wait Base Confirm")),
            severity: this.activePosition ? "info" : "warning",
          },
    };

    this.emit({
      type: "tick",
      data: telemetry,
    });
  }
}
