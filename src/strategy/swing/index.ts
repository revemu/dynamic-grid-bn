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

export type SwingTradeState = "WAITING_SETUP" | "PENDING_ENTRY" | "IN_POSITION" | "TP1_REACHED" | "EXITING";

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
  entryOrderId?: string;
  tp1OrderId?: string;
  tp2OrderId?: string;
}

export interface PendingSwingEntry {
  orderId: string;
  price: number;
  qty: number;
  placedTime: number;
  stopLossPrice: number;
  tp1Price: number;
  tp2Price: number;
  signalType: string;
  reason: string;
  riskRewardRatio: number;
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
  public pendingEntryOrder?: PendingSwingEntry;
  public lastSignal?: SwingSignalResult;
  public lastRefPrice = 0;
  public realizedPnl = 0;
  public bid = 0;
  public ask = 0;
  public mid = 0;
  private lastBalanceRefreshTime = 0;
  private lastOrderSyncTime = 0;

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
      if ((savedState as any).pendingEntryOrder) {
        this.pendingEntryOrder = (savedState as any).pendingEntryOrder;
        this.swingState = "PENDING_ENTRY";
        this.log(
          `[SwingTrader] 🔄 Recovered pending maker entry for ${this.symbolInfo.symbol} from database (Price: $${this.pendingEntryOrder?.price.toFixed(4)}, Qty: ${this.pendingEntryOrder?.qty})`,
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

  public getEffectiveGasReserveBase(): number {
    if (this.binance.exchangeName === "dreamdex" && this.symbolInfo.baseAsset === "SOMI") {
      return this.cfg.minGasReserveSomi ?? 2.0;
    }
    return 0;
  }

  public baseHeld(): number {
    if (this.activePosition) {
      return this.activePosition.qty;
    }
    return this.lots.reduce((sum, l) => sum + (l.qty || 0), 0);
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
    const orderId = String(rep.orderId);
    const status = rep.orderStatus;
    const lastPrice = Number(rep.lastFilledPrice || 0);

    this.log(`⚡ [SwingTrader WS] Execution report: order ${orderId} ${status} @ ${lastPrice}`);

    if (status === "FILLED" || status === "PARTIALLY_FILLED") {
      // Check if this report is for pendingEntryOrder
      if (this.pendingEntryOrder && String(this.pendingEntryOrder.orderId) === orderId) {
        if (status === "FILLED") {
          const p = this.pendingEntryOrder;
          const execPrice = lastPrice > 0 ? lastPrice : p.price;
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
          this.onSwingEntryFilled(orderId, execPrice, p.qty, execPrice * p.qty, p, swingCfg).catch(() => {});
        }
      } else if (this.activePosition) {
        const pos = this.activePosition;
        if (pos.tp1OrderId && String(pos.tp1OrderId) === orderId && status === "FILLED") {
          const execPrice = lastPrice > 0 ? lastPrice : pos.tp1Price;
          const exitQty = this.roundQty(pos.qty * (this.cfg.swingTp1CloseRatio ?? 0.5));
          const pnl = (execPrice - pos.entryPrice) * exitQty;
          this.realizedPnl += pnl;
          pos.tp1Executed = true;
          pos.qty = this.roundQty(pos.qty - exitQty);
          pos.stopLossPrice = pos.entryPrice;
          pos.tp1OrderId = undefined;
          this.swingState = "TP1_REACHED";
          this.saveState(true);
          this.log(`[SwingTrader] 🎯 WS: TP1 Filled at $${execPrice.toFixed(4)}! SL moved to Breakeven ($${pos.entryPrice.toFixed(4)}) — 100% Risk-Free!`);
          this.emit({
            type: "order",
            data: {
              id: `ord_${Date.now()}_tp1`,
              orderId,
              symbol: this.symbolInfo.symbol,
              side: "SELL",
              price: execPrice,
              qty: exitQty,
              notionalQuote: execPrice * exitQty,
              levelDesc: "Swing TP1 Target (Maker)",
              status: "FILLED",
              realizedPnl: pnl,
              placedTime: Date.now(),
              fillTime: Date.now(),
            },
          });
        } else if (pos.tp2OrderId && String(pos.tp2OrderId) === orderId && status === "FILLED") {
          const execPrice = lastPrice > 0 ? lastPrice : pos.tp2Price;
          const exitQty = pos.qty;
          const pnl = (execPrice - pos.entryPrice) * exitQty;
          this.realizedPnl += pnl;
          this.emit({
            type: "order",
            data: {
              id: `ord_${Date.now()}_tp2`,
              orderId,
              symbol: this.symbolInfo.symbol,
              side: "SELL",
              price: execPrice,
              qty: exitQty,
              notionalQuote: execPrice * exitQty,
              levelDesc: "Swing TP2 Target (Maker)",
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
          this.log(`[SwingTrader] 🚀 WS: TP2 Filled at $${execPrice.toFixed(4)}! Position closed.`);
        }
      }
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
      this.openOrders = orders.map((o) => {
        let desc = "Swing Order";
        const oIdStr = String(o.orderId);
        if (this.pendingEntryOrder && String(this.pendingEntryOrder.orderId) === oIdStr) {
          desc = "Swing Entry (Maker Limit)";
        } else if (this.activePosition?.tp1OrderId && String(this.activePosition.tp1OrderId) === oIdStr) {
          desc = "Swing TP1 (Maker Limit)";
        } else if (this.activePosition?.tp2OrderId && String(this.activePosition.tp2OrderId) === oIdStr) {
          desc = "Swing TP2 (Maker Limit)";
        }
        return {
          id: oIdStr,
          isBid: o.side === "BUY",
          price: o.price,
          qty: o.origQty,
          targetFraction: 0,
          notionalQuote: o.price * o.origQty,
          notionalUsdso: o.price * o.origQty,
          levelDesc: desc,
          placedTime: o.time || Date.now(),
        };
      });
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
      this.pendingEntryOrder = undefined;
      if (this.activePosition) {
        this.activePosition.tp1OrderId = undefined;
        this.activePosition.tp2OrderId = undefined;
      }
      this.saveState(true);
      this.log(`[SwingTrader] All open orders cancelled by user`);
    } catch (e) {
      this.log(`[SwingTrader] Cancel all orders error: ${e}`);
    }
    return { cancelledCount: count };
  }

  public async sellAllUser(reason?: string): Promise<{ success: boolean; soldQty: number; price: number; error?: string; }> {
    this.log(`[SwingTrader] Market sell requested: ${reason || "Emergency market sell by user"}`);
    
    // First, cancel any resting entry or TP orders
    if (this.pendingEntryOrder) {
      try {
        await this.binance.cancelOrder(this.symbolInfo.symbol, this.pendingEntryOrder.orderId);
      } catch {}
      this.pendingEntryOrder = undefined;
    }
    if (this.activePosition) {
      if (this.activePosition.tp1OrderId) {
        try { await this.binance.cancelOrder(this.symbolInfo.symbol, this.activePosition.tp1OrderId); } catch {}
        this.activePosition.tp1OrderId = undefined;
      }
      if (this.activePosition.tp2OrderId) {
        try { await this.binance.cancelOrder(this.symbolInfo.symbol, this.activePosition.tp2OrderId); } catch {}
        this.activePosition.tp2OrderId = undefined;
      }
    }

    // Refresh wallet balances from exchange now that resting orders are cancelled
    await this.refreshWalletBalances().catch(() => {});

    const gasReserve = this.getEffectiveGasReserveBase();
    const availableBase = Math.max(0, this.walletBaseBalance - gasReserve);
    const targetQty = this.activePosition ? this.activePosition.qty : this.baseHeld();
    let qty = targetQty;
    if (availableBase > 0) {
      qty = Math.min(targetQty, availableBase);
    }
    qty = this.roundQty(qty);

    if (qty >= (this.symbolInfo.minQty || 0.0001)) {
      try {
        const isDreamdex = this.binance.exchangeName === "dreamdex";
        const sellPrice = this.bid > 0 ? this.bid : this.lastRefPrice;
        // On DreamDEX, use IOC order with 1% slippage buffer to ensure instant match without price=0 revert
        const dreamdexIocPrice = this.roundPrice(sellPrice * (1 - (this.cfg.iocSlippagePct ?? 1.0) / 100));

        const res = await this.binance.placeOrder({
          symbol: this.symbolInfo.symbol,
          side: "SELL",
          type: isDreamdex ? "IOC" : "MARKET",
          price: isDreamdex ? dreamdexIocPrice : undefined,
          qty,
        });
        const execPrice = res.price || sellPrice;
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
        await this.syncOnChainOrders();
        return { success: true, soldQty: qty, price: execPrice };
      } catch (e: any) {
        this.log(`[SwingTrader] Sell execution failed: ${e}`);
        return { success: false, soldQty: 0, price: 0, error: e?.message };
      }
    } else {
      // Cleanly reset position state if remaining quantity is dust or zero
      this.lots = [];
      this.activePosition = undefined;
      this.swingState = "WAITING_SETUP";
      this.saveState(true);
      await this.refreshWalletBalances();
      return { success: true, soldQty: 0, price: 0 };
    }
  }

  public async resetBotState(opts?: any): Promise<{ success: boolean; }> {
    if (this.pendingEntryOrder) {
      try { await this.binance.cancelOrder(this.symbolInfo.symbol, this.pendingEntryOrder.orderId); } catch {}
      this.pendingEntryOrder = undefined;
    }
    if (this.activePosition) {
      if (this.activePosition.tp1OrderId) {
        try { await this.binance.cancelOrder(this.symbolInfo.symbol, this.activePosition.tp1OrderId); } catch {}
      }
      if (this.activePosition.tp2OrderId) {
        try { await this.binance.cancelOrder(this.symbolInfo.symbol, this.activePosition.tp2OrderId); } catch {}
      }
    }
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
    if (this.pendingEntryOrder) {
      try { await this.binance.cancelOrder(this.symbolInfo.symbol, this.pendingEntryOrder.orderId); } catch {}
      this.pendingEntryOrder = undefined;
    }
    if (this.activePosition) {
      if (this.activePosition.tp1OrderId) {
        try { await this.binance.cancelOrder(this.symbolInfo.symbol, this.activePosition.tp1OrderId); } catch {}
      }
      if (this.activePosition.tp2OrderId) {
        try { await this.binance.cancelOrder(this.symbolInfo.symbol, this.activePosition.tp2OrderId); } catch {}
      }
    }
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
      this.pendingEntryOrder = (saved as any).pendingEntryOrder;
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
        pendingEntryOrder: this.pendingEntryOrder,
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

      // Periodically refresh wallet balances from exchange (every 10s)
      const now = Date.now();
      if (now - this.lastBalanceRefreshTime > 10_000) {
        this.lastBalanceRefreshTime = now;
        await this.refreshWalletBalances().catch(() => {});
      }

      // Periodically sync open orders from exchange (every 4s)
      if (now - this.lastOrderSyncTime > 4000) {
        this.lastOrderSyncTime = now;
        await this.syncOnChainOrders().catch(() => {});
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
        if (this.activePosition) {
          // 1. Manage Active Position (SL / TP / Trailing Stop)
          await this.manageActivePosition(refPrice, swingCfg);
        } else if (this.pendingEntryOrder) {
          // 2. Manage Pending Maker Entry Order
          await this.managePendingEntryOrder(refPrice, swingCfg);
        } else {
          // 3. Scan for New Entry Setup
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

  private async managePendingEntryOrder(refPrice: number, cfg: SwingStrategyConfig): Promise<void> {
    if (!this.pendingEntryOrder) return;
    const p = this.pendingEntryOrder;

    // 1. Check if price dropped below stop loss level -> setup is broken, cancel immediately!
    if (refPrice <= p.stopLossPrice) {
      this.log(
        `[SwingTrader] 🛑 Cancelling pending entry order ${p.orderId}: Price broke below Stop Loss ($${refPrice.toFixed(4)} <= $${p.stopLossPrice.toFixed(4)})`,
      );
      try {
        await this.binance.cancelOrder(this.symbolInfo.symbol, p.orderId);
      } catch (e) {
        this.log(`[SwingTrader] Cancel pending order failed: ${e}`);
      }
      this.pendingEntryOrder = undefined;
      this.swingState = "WAITING_SETUP";
      this.saveState(true);
      await this.syncOnChainOrders();
      return;
    }

    // 2. Check if price surged away upwards (>1.5% from entry) -> train left, cancel and wait for another setup
    if (refPrice > p.price * 1.015) {
      this.log(
        `[SwingTrader] ⚠️ Cancelling pending entry order ${p.orderId}: Price surged away (+${(((refPrice - p.price) / p.price) * 100).toFixed(2)}%) without fill`,
      );
      try {
        await this.binance.cancelOrder(this.symbolInfo.symbol, p.orderId);
      } catch (e) {
        this.log(`[SwingTrader] Cancel pending order failed: ${e}`);
      }
      this.pendingEntryOrder = undefined;
      this.swingState = "WAITING_SETUP";
      this.saveState(true);
      await this.syncOnChainOrders();
      return;
    }

    // 3. Check order fill status via exchange if placed > 2 seconds ago
    const ageMs = Date.now() - p.placedTime;
    if (ageMs > 2000) {
      try {
        const orderInfo = await this.binance.getOrder(this.symbolInfo.symbol, p.orderId);
        if (orderInfo.status === "FILLED") {
          const fillPrice = orderInfo.price || p.price;
          const execQty = orderInfo.executedQty || p.qty;
          this.log(`[SwingTrader] 🎯 Pending Maker Limit Entry FILLED @ $${fillPrice.toFixed(4)} (Qty: ${execQty})`);
          await this.onSwingEntryFilled(p.orderId, fillPrice, execQty, fillPrice * execQty, p, cfg);
        } else if (orderInfo.status === "CANCELED" || orderInfo.status === "EXPIRED" || orderInfo.status === "REJECTED") {
          this.log(`[SwingTrader] Pending Maker Limit Entry was ${orderInfo.status} on exchange`);
          this.pendingEntryOrder = undefined;
          this.swingState = "WAITING_SETUP";
          this.saveState(true);
          await this.syncOnChainOrders();
        }
      } catch (e) {
        // Query error ignored or order still open
      }
    }
  }

  private async placeMakerTakeProfitOrders(pos: ActiveSwingPosition, cfg: SwingStrategyConfig): Promise<void> {
    const gasReserve = this.getEffectiveGasReserveBase();
    const availableBase = Math.max(0, this.walletBaseBalance - gasReserve);
    let totalPositionQty = pos.qty;
    if (availableBase > 0 && availableBase < totalPositionQty) {
      totalPositionQty = availableBase;
    }
    totalPositionQty = this.roundQty(totalPositionQty);

    const minQty = this.symbolInfo.minQty || 0.0001;
    const minNotional = this.symbolInfo.minNotional || 5;

    // Calculate TP1 and TP2 quantities
    const tp1Ratio = cfg.tp1CloseRatio > 0 && cfg.tp1CloseRatio < 1 ? cfg.tp1CloseRatio : 0.5;
    const tp1Qty = this.roundQty(totalPositionQty * tp1Ratio);
    const tp2Qty = this.roundQty(totalPositionQty - tp1Qty);

    const tp1Notional = tp1Qty * pos.tp1Price;
    const tp2Notional = tp2Qty * pos.tp2Price;

    // If split is too small for minQty or minNotional, place single full TP at TP1
    if (tp1Qty < minQty || tp1Notional < minNotional || tp2Qty < minQty || tp2Notional < minNotional) {
      if (!pos.tp1OrderId && totalPositionQty >= minQty) {
        try {
          const res = await this.binance.placeOrder({
            symbol: this.symbolInfo.symbol,
            side: "SELL",
            type: "LIMIT",
            price: pos.tp1Price,
            qty: totalPositionQty,
          });
          pos.tp1OrderId = String(res.orderId);
          this.log(`[SwingTrader] 🎯 Resting Maker Limit TP placed at $${pos.tp1Price.toFixed(4)} (100% Qty: ${totalPositionQty}, OrderId: ${res.orderId})`);
        } catch (e) {
          this.log(`[SwingTrader] Failed to place resting TP limit order: ${e}`);
        }
      }
      await this.syncOnChainOrders();
      this.saveState(true);
      return;
    }

    // Place TP1 limit order
    if (!pos.tp1OrderId && !pos.tp1Executed) {
      try {
        const res = await this.binance.placeOrder({
          symbol: this.symbolInfo.symbol,
          side: "SELL",
          type: "LIMIT",
          price: pos.tp1Price,
          qty: tp1Qty,
        });
        pos.tp1OrderId = String(res.orderId);
        this.log(`[SwingTrader] 🎯 Resting Maker Limit TP1 placed at $${pos.tp1Price.toFixed(4)} (Qty: ${tp1Qty}, OrderId: ${res.orderId})`);
      } catch (e) {
        this.log(`[SwingTrader] Failed to place resting TP1 limit order: ${e}`);
      }
    }

    // Place TP2 limit order
    if (!pos.tp2OrderId) {
      try {
        const res = await this.binance.placeOrder({
          symbol: this.symbolInfo.symbol,
          side: "SELL",
          type: "LIMIT",
          price: pos.tp2Price,
          qty: tp2Qty,
        });
        pos.tp2OrderId = String(res.orderId);
        this.log(`[SwingTrader] 🚀 Resting Maker Limit TP2 placed at $${pos.tp2Price.toFixed(4)} (Qty: ${tp2Qty}, OrderId: ${res.orderId})`);
      } catch (e) {
        this.log(`[SwingTrader] Failed to place resting TP2 limit order: ${e}`);
      }
    }

    await this.syncOnChainOrders();
    this.saveState(true);
  }

  private async onSwingEntryFilled(
    orderId: string,
    fillPrice: number,
    qty: number,
    notionalQuote: number,
    signal: { stopLossPrice: number; tp1Price: number; tp2Price: number; signalType?: string; reason?: string },
    cfg: SwingStrategyConfig,
  ): Promise<void> {
    this.activePosition = {
      entryTime: Date.now(),
      entryPrice: fillPrice,
      qty,
      notionalQuote,
      stopLossPrice: this.roundPrice(signal.stopLossPrice),
      tp1Price: this.roundPrice(signal.tp1Price),
      tp2Price: this.roundPrice(signal.tp2Price),
      tp1Executed: false,
      highestPriceSinceEntry: fillPrice,
      trailingStopActive: false,
      signalType: signal.signalType || "SWING",
      reason: signal.reason || "",
      entryOrderId: orderId,
    };

    this.lots.push({
      price: fillPrice,
      qty,
      time: Date.now(),
    });

    this.pendingEntryOrder = undefined;
    this.swingState = "IN_POSITION";
    this.saveState(true);

    this.emit({
      type: "order",
      data: {
        id: `ord_${Date.now()}_buy`,
        orderId,
        symbol: this.symbolInfo.symbol,
        side: "BUY",
        price: fillPrice,
        qty,
        notionalQuote,
        levelDesc: `Swing Entry (${signal.signalType || "SWING"})`,
        status: "FILLED",
        placedTime: Date.now(),
        fillTime: Date.now(),
      },
    });

    this.log(`[SwingTrader] 🚀 Swing Position Opened @ $${fillPrice.toFixed(4)} (Qty: ${qty})`);
    await this.refreshWalletBalances();

    // In MAKER_LIMIT mode: immediately place resting TP1 & TP2 limit sell orders!
    if (this.cfg.orderExecutionMode === "MAKER_LIMIT") {
      await this.placeMakerTakeProfitOrders(this.activePosition, cfg);
    }
  }

  private async manageActivePosition(refPrice: number, cfg: SwingStrategyConfig): Promise<void> {
    if (!this.activePosition) return;
    const pos = this.activePosition;
    const isMakerMode = this.cfg.orderExecutionMode === "MAKER_LIMIT";

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
      // First cancel any resting TP orders
      if (pos.tp1OrderId) {
        try { await this.binance.cancelOrder(this.symbolInfo.symbol, pos.tp1OrderId); } catch {}
        pos.tp1OrderId = undefined;
      }
      if (pos.tp2OrderId) {
        try { await this.binance.cancelOrder(this.symbolInfo.symbol, pos.tp2OrderId); } catch {}
        pos.tp2OrderId = undefined;
      }
      await this.sellAllUser("Swing Stop Loss Triggered");
      return;
    }

    // ── If MAKER_LIMIT Mode: Place or verify resting Limit TP orders ─────────
    if (isMakerMode) {
      if (!pos.tp1Executed && !pos.tp1OrderId && !pos.tp2OrderId) {
        await this.placeMakerTakeProfitOrders(pos, cfg);
      }

      // Check TP1 resting order fill
      if (!pos.tp1Executed && pos.tp1OrderId) {
        try {
          const o1 = await this.binance.getOrder(this.symbolInfo.symbol, pos.tp1OrderId);
          if (o1.status === "FILLED") {
            const execPrice = o1.price || pos.tp1Price;
            const exitQty = o1.executedQty || this.roundQty(pos.qty * cfg.tp1CloseRatio);
            const pnl = (execPrice - pos.entryPrice) * exitQty;
            this.realizedPnl += pnl;

            pos.tp1Executed = true;
            pos.qty = this.roundQty(pos.qty - exitQty);
            // 🛡️ Move Stop Loss to Breakeven
            pos.stopLossPrice = pos.entryPrice;
            pos.tp1OrderId = undefined;
            this.swingState = "TP1_REACHED";
            this.saveState(true);
            this.log(`[SwingTrader] 🎯 Resting Maker TP1 FILLED @ $${execPrice.toFixed(4)}! SL moved to Breakeven ($${pos.entryPrice.toFixed(4)}) — 100% Risk-Free!`);

            this.emit({
              type: "order",
              data: {
                id: `ord_${Date.now()}_tp1`,
                orderId: String(o1.orderId),
                symbol: this.symbolInfo.symbol,
                side: "SELL",
                price: execPrice,
                qty: exitQty,
                notionalQuote: execPrice * exitQty,
                levelDesc: `Swing TP1 Target (Maker)`,
                status: "FILLED",
                realizedPnl: pnl,
                placedTime: (o1 as any).time || (o1 as any).transactTime || Date.now(),
                fillTime: Date.now(),
              },
            });

            await this.refreshWalletBalances();
            await this.syncOnChainOrders();
            return;
          }
        } catch {}
      }

      // Check TP2 resting order fill
      if (pos.tp2OrderId) {
        try {
          const o2 = await this.binance.getOrder(this.symbolInfo.symbol, pos.tp2OrderId);
          if (o2.status === "FILLED") {
            const execPrice = o2.price || pos.tp2Price;
            const exitQty = o2.executedQty || pos.qty;
            const pnl = (execPrice - pos.entryPrice) * exitQty;
            this.realizedPnl += pnl;

            this.emit({
              type: "order",
              data: {
                id: `ord_${Date.now()}_tp2`,
                orderId: String(o2.orderId),
                symbol: this.symbolInfo.symbol,
                side: "SELL",
                price: execPrice,
                qty: exitQty,
                notionalQuote: execPrice * exitQty,
                levelDesc: `Swing TP2 Target (Maker)`,
                status: "FILLED",
                realizedPnl: pnl,
                placedTime: (o2 as any).time || (o2 as any).transactTime || Date.now(),
                fillTime: Date.now(),
              },
            });

            this.lots = [];
            this.activePosition = undefined;
            this.swingState = "WAITING_SETUP";
            this.saveState(true);
            this.log(`[SwingTrader] 🚀 Resting Maker TP2 FILLED @ $${execPrice.toFixed(4)}! Trade cycle complete.`);
            await this.refreshWalletBalances();
            await this.syncOnChainOrders();
            return;
          }
        } catch {}
      }

      return;
    }

    // ── If IOC_BRACKET Mode: Execute reactive Market/IOC orders ──────────────
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

    const isMakerMode = this.cfg.orderExecutionMode === "MAKER_LIMIT";

    // Determine entry limit price:
    // If MAKER_LIMIT: buy at bestBid (or signal price if lower/equal) to ensure resting on book as maker
    let entryPrice = price;
    if (isMakerMode && this.bid && this.bid > 0) {
      entryPrice = Math.min(this.bid, price);
    }
    entryPrice = this.roundPrice(entryPrice);

    // Apply roundQty to satisfy lot size & precision filters
    const rawQty = maxBudget / entryPrice;
    const qty = this.roundQty(rawQty);

    if (qty < (this.symbolInfo.minQty || 0.0001)) {
      this.log(`[SwingTrader] Computed qty ${qty} is less than exchange minQty ${this.symbolInfo.minQty}`);
      return;
    }

    if (isMakerMode) {
      this.log(
        `[SwingTrader] ⏳ Placing Maker Limit Entry Buy at $${entryPrice.toFixed(4)} | Budget: $${maxBudget.toFixed(2)} | Qty: ${qty} | SL: $${signal.stopLossPrice.toFixed(4)} | TP1: $${signal.tp1Price.toFixed(4)} | TP2: $${signal.tp2Price.toFixed(4)}`,
      );
      try {
        const res = await this.binance.placeOrder({
          symbol: this.symbolInfo.symbol,
          side: "BUY",
          type: "LIMIT",
          price: entryPrice,
          qty,
        });

        const orderIdStr = String(res.orderId);

        // Check if filled immediately (some exchanges or dryRun fill limit immediately)
        if (res.status === "FILLED") {
          await this.onSwingEntryFilled(orderIdStr, entryPrice, qty, maxBudget, signal, cfg);
        } else {
          // Resting on orderbook
          this.pendingEntryOrder = {
            orderId: orderIdStr,
            price: entryPrice,
            qty,
            placedTime: Date.now(),
            stopLossPrice: this.roundPrice(signal.stopLossPrice),
            tp1Price: this.roundPrice(signal.tp1Price),
            tp2Price: this.roundPrice(signal.tp2Price),
            signalType: signal.signalType || "SWING",
            reason: signal.reason,
            riskRewardRatio: signal.riskRewardRatio,
          };
          this.swingState = "PENDING_ENTRY";
          this.saveState(true);
          await this.syncOnChainOrders();
          this.log(`[SwingTrader] 📌 Resting Maker Limit Buy active (OrderId: ${orderIdStr}). Waiting for fill.`);
        }
      } catch (e) {
        this.log(`[SwingTrader] Maker Limit Entry placement failed: ${e}`);
      }
    } else {
      // IOC_BRACKET mode (MARKET / IOC execution)
      this.log(
        `[SwingTrader] 🚀 Executing Swing Entry (${signal.signalType}) at $${price.toFixed(4)} | Budget: $${maxBudget.toFixed(2)} | Qty: ${qty} | SL: $${signal.stopLossPrice.toFixed(4)} | TP1: $${signal.tp1Price.toFixed(4)} | TP2: $${signal.tp2Price.toFixed(4)} | R:R: ${signal.riskRewardRatio.toFixed(2)}`,
      );
      try {
        const isDreamdex = this.binance.exchangeName === "dreamdex";
        const entryBuyPrice = this.ask > 0 ? this.ask : price;
        const iocPrice = this.roundPrice(entryBuyPrice * (1 + (this.cfg.iocSlippagePct ?? 0.15) / 100));

        const res = await this.binance.placeOrder({
          symbol: this.symbolInfo.symbol,
          side: "BUY",
          type: isDreamdex ? "IOC" : "MARKET",
          price: isDreamdex ? iocPrice : undefined,
          qty,
        });
        const execPrice = res.price || price;
        await this.onSwingEntryFilled(String(res.orderId || Date.now()), execPrice, qty, maxBudget, signal, cfg);
      } catch (e) {
        this.log(`[SwingTrader] Swing Entry failed: ${e}`);
      }
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
    const invUsd = this.activePosition ? this.activePosition.qty * currentMid : (this.lots.length > 0 ? baseHeldVal * currentMid : 0);
    const somiVal = this.walletBaseBalance * currentMid;
    const totalVal = somiVal + this.walletQuoteBalance;
    const maxInv = this.activePosition
      ? Math.max(this.cfg.maxInventoryQuote ?? 50, this.activePosition.notionalQuote)
      : (this.walletQuoteBalance > 0 ? this.walletQuoteBalance * ((this.cfg.swingMaxPositionPct ?? 60) / 100) : (this.cfg.maxInventoryQuote ?? 50));

    // Calculate Real-time Unrealized PnL and Average Entry Price
    let unrealizedPnl = 0;
    let avgEntryPrice = 0;
    let unrealizedPnlPct = 0;
    if (this.activePosition && this.activePosition.entryPrice > 0 && this.activePosition.qty > 0) {
      avgEntryPrice = this.activePosition.entryPrice;
      unrealizedPnl = (currentMid - this.activePosition.entryPrice) * this.activePosition.qty;
      unrealizedPnlPct = ((currentMid - this.activePosition.entryPrice) / this.activePosition.entryPrice) * 100;
    } else if (this.lots.length > 0 && baseHeldVal > 0) {
      const totalCost = this.lots.reduce((sum, l) => sum + (l.price * l.qty), 0);
      avgEntryPrice = totalCost / baseHeldVal;
      unrealizedPnl = (currentMid - avgEntryPrice) * baseHeldVal;
      unrealizedPnlPct = avgEntryPrice > 0 ? ((currentMid - avgEntryPrice) / avgEntryPrice) * 100 : 0;
    }

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
      bestBid: this.bid || currentMid,
      bestAsk: this.ask || currentMid,
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
      gasReserveSomi: this.getEffectiveGasReserveBase(),
      minGasReserveSomi: this.getEffectiveGasReserveBase(),
      baseHeld: baseHeldVal,
      lots: this.lots,
      positionUsdso: invUsd,
      positionQuote: invUsd,
      inventoryUsdso: invUsd,
      inventoryQuote: invUsd,
      maxInventoryQuote: maxInv,
      maxInventoryUsdso: maxInv,
      currentHoldPct: maxInv > 0 ? Math.min(100, (invUsd / maxInv) * 100) : 0,
      targetHoldingPct,
      targetInventoryQuote,
      targetInventoryUsdso: targetInventoryQuote,
      unrealizedPnl,
      unrealizedPnlPct,
      avgEntryPrice,
      realizedPnl: this.realizedPnl,
      tradeRealizedPnl: this.realizedPnl,
      dryRun: Boolean(this.cfg.dryRun),
      isPaused: this.isPaused,
      strategyType: this.strategyType,
      strategyName: this.name,
      swingState: this.swingState,
      activePosition: this.activePosition,
      pendingEntryOrder: this.pendingEntryOrder,
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
        : this.pendingEntryOrder
        ? {
            code: "PENDING_ENTRY",
            title: "⏳ Maker Limit Entry Placed",
            reason: `Resting limit buy at $${this.pendingEntryOrder.price.toFixed(4)} (${this.pendingEntryOrder.qty} ${this.symbolInfo.baseAsset}). SL: $${this.pendingEntryOrder.stopLossPrice.toFixed(4)}`,
            nextTrigger: `Wait dip to $${this.pendingEntryOrder.price.toFixed(4)}`,
            severity: "info",
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
