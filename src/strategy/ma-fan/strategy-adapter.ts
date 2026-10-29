/**
 * Pluggable IStrategy Adapter for MA Fan Strategy
 * Connects MaFanStrategy to the bot's universal lifecycle, dashboard server,
 * exchange adapters, and settings persistence.
 */

import type { IExchangeClient, ExchangeSymbolInfo } from "../../exchange/types.js";
import type { Config } from "../../config.js";
import type { AtrSource } from "../../types.js";
import { type Candle } from "../../market-structure.js";
import { BotDatabase, getDatabase } from "../../db.js";
import type {
  IStrategy,
  StrategyType,
  StrategyContext,
  StrategyEvent,
  Lot,
  OpenOrder,
} from "../types.js";
import { MaFanStrategy } from "./strategy.js";
import { MaFanConfig } from "./types.js";

export class MaFanTradingStrategy implements IStrategy {
  public readonly name = "MA-FOLD-FAN Reversion Trader";
  public readonly strategyType: StrategyType = "ma_fan";

  public atrSource: AtrSource;
  private exchange: IExchangeClient;
  private symbolInfo: ExchangeSymbolInfo;
  private cfg: Config;
  private log: (msg: string) => void;
  private db: BotDatabase = getDatabase();

  private eventListeners: ((event: StrategyEvent) => void)[] = [];
  private maFan: MaFanStrategy;
  private isSwitchingSymbol: boolean = false;
  private context: StrategyContext;

  private walletBase: number = 0;
  private walletQuote: number = 0;
  private walletBaseLocked: number = 0;
  private walletQuoteLocked: number = 0;
  private walletBaseTotal: number = 0;
  private walletQuoteTotal: number = 0;
  private currentMid: number = 0;
  private bestBid: number = 0;
  private bestAsk: number = 0;
  private lastBalanceSyncTs: number = 0;
  private lastTelemetryEmitTs: number = 0;

  constructor(context: StrategyContext) {
    this.context = context;
    this.exchange = context.exchange;
    this.symbolInfo = context.symbolInfo;
    this.cfg = context.config;
    this.atrSource = context.atrSource;
    this.log = context.log ?? ((msg) => console.log(`[ma-fan-trader] ${msg}`));

    const maFanConfig: MaFanConfig = {
      executionTimeframe: (this.cfg.maFanExecutionTimeframe as "5m" | "15m") || "5m",
      supervisorTimeframe: (this.cfg.maFanSupervisorTimeframe as "15m" | "1h") || "15m",
      autoCalibrateSpreadOnSwitch: this.cfg.maFanAutoCalibrateSpreadOnSwitch ?? true,
      manualSpreadPct: this.cfg.maFanManualSpreadPct ?? 0.40,
      useAtrAdaptiveSpread: this.cfg.maFanUseAtrAdaptiveSpread ?? true,
      atrMultiplier: this.cfg.maFanAtrMultiplier ?? 1.25,
      tp1Ratio: this.cfg.maFanTp1Ratio ?? 0.50,
      tp1Target: "EMA25",
      tp2Target: "MACRO_OR_TRAILING",
      trailingPullbackPct: this.cfg.maFanTrailingPullbackPct ?? 0.45,
      breakevenFeeBufferPct: this.cfg.maFanBreakevenFeeBufferPct ?? 0.05,
      slBufferPct: this.cfg.maFanSlBufferPct ?? 0.25,
      useRatchetSl: this.cfg.maFanUseRatchetSl !== false,
      bullCushionEnabled: this.cfg.maFanBullCushion === true,
      waterfallGuardEnabled: this.cfg.maFanWaterfallGuard !== false,
      entryOnClosedOnly: this.cfg.maFanEntryOnClosedOnly ?? true,
      maxPositionBudgetUsd: this.cfg.maFanMaxBudgetUsd ?? 200,
      isDryRun: this.cfg.dryRun ?? false,
      startPaused: this.cfg.startPaused ?? true,
    };

    this.maFan = new MaFanStrategy({
      symbol: this.symbolInfo.symbol,
      config: maFanConfig,
      client: this.exchange,
      onLog: this.log,
      onTrade: (t) => {
        this.emit({ type: "order", data: t });
        this.saveState(true);
        this.emitTelemetryTick(true);
      },
      onStateUpdate: () => {
        this.saveState(true);
        this.emitTelemetryTick(true);
      },
    });

    // 💾 Restore persisted active position if exists in database
    const savedState = this.db.getState();
    if (savedState?.maFanPosition) {
      this.maFan.restorePosition(savedState.maFanPosition);
    }

    if (context.htfDowEngine) {
      const htfCandles = context.htfDowEngine.getCandles();
      if (htfCandles && htfCandles.length > 0) {
        this.maFan.setInitialHtfCandles(htfCandles);
      }
    }
    if (context.macroDowEngine) {
      const candles = context.macroDowEngine.getCandles();
      if (candles && candles.length > 0) {
        this.maFan.setInitialCandles(candles);
        const lastC = candles[candles.length - 1];
        if (lastC && lastC.close > 0) this.currentMid = lastC.close;
      }
    }

    this.maFan.init().catch((err) => this.log(`⚠️ MaFan init error: ${err.message}`));
    this.refreshWalletBalances().catch((err) => {
      this.log(`⚠️ Initial balance query failed: ${err?.message || err}`);
    });
  }

  // ── Lifecycle & Execution ──────────────────────────────────────────────────

  public async tick(): Promise<void> {
    if (this.isSwitchingSymbol) return;

    const now = Date.now();
    // Auto-sync balance periodically: every 15s, or every 3s if balances are still zero
    const syncInterval = (this.walletBase === 0 && this.walletQuote === 0) ? 3000 : 15000;
    if (now - this.lastBalanceSyncTs >= syncInterval) {
      this.lastBalanceSyncTs = now;
      this.refreshWalletBalances().catch(() => {});
    }

    try {
      const top = await this.exchange.getTopOfBook(this.symbolInfo.symbol);
      const refPrice = top.mid > 0 ? top.mid : (top.bestAsk + top.bestBid) / 2;
      if (refPrice > 0) {
        this.currentMid = refPrice;
        if (top.bestBid > 0) this.bestBid = top.bestBid;
        if (top.bestAsk > 0) this.bestAsk = top.bestAsk;
        await this.maFan.step(refPrice);
      }
    } catch (err: any) {
      // In dryRun or offline, fallback to last candle close
      const candles = (this.maFan as any).candles;
      if (candles && candles.length > 0) {
        const lastP = candles[candles.length - 1].close;
        this.currentMid = lastP;
        await this.maFan.step(lastP);
      }
    }

    this.emitTelemetryTick(false);
  }

  public getIntervalMs(): number {
    return this.cfg.intervalMs || 1000;
  }

  // ── Real-time Feeds & Events ──────────────────────────────────────────────

  public onCandleClosed(candle: Candle): void {
    if (candle && candle.close > 0) this.currentMid = candle.close;
    this.maFan.onCandle(candle, true);
    this.emitTelemetryTick(true);
  }

  public onHtfCandleClosed(candle: Candle): void {
    this.maFan.onHtfCandle(candle, true);
    this.emitTelemetryTick(true);
  }

  public onEvent(cb: (event: StrategyEvent) => void): void {
    this.eventListeners.push(cb);
  }

  private emit(event: StrategyEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (err) {
        this.log(`⚠️ Error in event listener: ${(err as Error).message}`);
      }
    }
  }

  public emitTelemetryTick(force = false): void {
    const now = Date.now();
    // Throttle SSE tick events to once every 2.5 seconds unless forced (trade/order/position change)
    if (!force && now - this.lastTelemetryEmitTs < 2500) {
      return;
    }
    this.lastTelemetryEmitTs = now;

    const state = this.maFan.getState();
    const lots = this.getLots();
    const baseHeld = this.baseHeld();
    const totalBaseBal = this.walletBaseTotal > 0 ? this.walletBaseTotal : this.walletBase;
    const totalQuoteBal = this.walletQuoteTotal > 0 ? this.walletQuoteTotal : this.walletQuote;
    const totalWalletValQuote = (totalBaseBal * (this.currentMid || 0)) + totalQuoteBal;

    const pos = state.activePosition;
    const ribbon = state.ribbon;
    const curSpread = ribbon?.fanSpreadPct ?? 0;
    const reqSpread = state.effectiveSpreadThreshold ?? 0.25;

    // Compact lastCalibration for telemetry ticks to save bandwidth (candidates table is 1.1 KB)
    let compactCalibration = undefined;
    if (state.lastCalibration) {
      const { candidates, ...rest } = state.lastCalibration;
      compactCalibration = rest;
    }

    let botAction = {
      title: "🪭 MA-FOLD-FAN Scanning",
      reason: `กำลังสแกนพัด (ปัจจุบัน: ${curSpread.toFixed(2)}% / ต้องการ ≥ ${reqSpread.toFixed(2)}%)`,
      nextTrigger: "รอพัดกางตึงสุด + ปลายพัดม้วนกลับ (Hook)",
      severity: "info",
    };

    if (pos) {
      if (pos.tp1Filled) {
        botAction = {
          title: "🚀 TP2 Runner Active",
          reason: `แตะ TP1 แล้ว (ล็อกทุน $${pos.stopLossPrice.toFixed(2)}) ถือรันเทรนด์`,
          nextTrigger: `เป้าหมาย TP2: EMA 75/200 (~$${Math.max(ribbon?.ema75 || 0, ribbon?.ema200 || 0).toFixed(2)})`,
          severity: "success",
        };
      } else {
        botAction = {
          title: "🎯 Position Active",
          reason: `ถือ ${pos.remainingQty} @ $${pos.entryPrice.toFixed(2)} | SL: $${pos.stopLossPrice.toFixed(2)}`,
          nextTrigger: `รอเด้งแตะ TP1: EMA 25 (~$${(ribbon?.ema25 || 0).toFixed(2)})`,
          severity: "success",
        };
      }
    } else if (ribbon?.isFanningDown && curSpread >= reqSpread) {
      botAction = {
        title: "⚡ Stretched Fan Alert",
        reason: `พัดกางตึงแล้ว (${curSpread.toFixed(2)}% ≥ ${reqSpread.toFixed(2)}%)`,
        nextTrigger: "รอดักจังหวะม้วนหัว Hook เพื่อเข้าซื้อทันที",
        severity: "warning",
      };
    }

    const regimeStr = state.htfRegime
      ? `HTF: ${state.htfRegime.isBullish ? "BULL" : "BEAR"}`
      : "ACTIVE";

    const tickData = {
      ...state,
      lastCalibration: compactCalibration,
      strategyType: "ma_fan",
      strategyMode: "ma_fan",
      symbol: this.symbolInfo.symbol,
      executionTimeframe: this.cfg.maFanExecutionTimeframe || "5m",
      supervisorTimeframe: this.cfg.maFanSupervisorTimeframe || "15m",
      baseAsset: this.symbolInfo.baseAsset,
      quoteAsset: this.symbolInfo.quoteAsset,
      mid: this.currentMid,
      valuationPrice: this.currentMid,
      bestBid: this.bestBid || this.currentMid,
      bestAsk: this.bestAsk || this.currentMid,
      regime: regimeStr,
      botAction,
      walletBaseBalance: this.walletBase,
      walletQuoteBalance: this.walletQuote,
      walletBaseLocked: this.walletBaseLocked,
      walletQuoteLocked: this.walletQuoteLocked,
      walletBaseTotal: totalBaseBal,
      walletQuoteTotal: totalQuoteBal,
      walletTotalValueQuote: totalWalletValQuote,
      walletSomiBalance: this.walletBase,
      walletUsdsoBalance: this.walletQuote,
      maxInventoryQuote: this.cfg.maFanMaxBudgetUsd ?? this.cfg.maxInventoryQuote ?? 200,
      realizedPnl: state.metrics?.realizedPnl ?? 0,
      tradeRealizedPnl: state.metrics?.realizedPnl ?? 0,
      lots,
      baseHeld,
      inventoryUsdso: baseHeld * (this.currentMid || 0),
      dryRun: this.cfg.dryRun,
      time: Date.now(),
    };

    this.emit({ type: "tick", data: tickData });
  }

  public handleWsBookTicker(b: any): void {
    if (b && b.bestBid && b.bestAsk) {
      const bid = parseFloat(b.bestBid);
      const ask = parseFloat(b.bestAsk);
      if (bid > 0) this.bestBid = bid;
      if (ask > 0) this.bestAsk = ask;
      const mid = (bid + ask) / 2;
      if (mid > 0) {
        this.currentMid = mid;
        this.maFan.step(mid).catch((err) => this.log(`⚠️ step error: ${err.message}`));
      }
    }
  }

  public handleWsExecutionReport(rep: any): void {
    const sym = rep?.symbol || rep?.s || "";
    const side = rep?.side || rep?.S || "";
    const status = rep?.orderStatus || rep?.X || "";
    this.log(`📥 WS execution report received in MA Fan adapter: ${sym} ${side} ${status}`);
    if (status === "FILLED" || status === "PARTIALLY_FILLED" || status === "CANCELED" || status === "EXPIRED") {
      this.refreshWalletBalances().catch(() => {});
    }
  }

  public handleWsAccountUpdate(acc: any): void {
    if (!acc) return;
    const baseAsset = (this.symbolInfo?.baseAsset || "").toUpperCase();
    const quoteAsset = (this.symbolInfo?.quoteAsset || "").toUpperCase();
    let updated = false;

    if (acc.balances && Array.isArray(acc.balances)) {
      for (const b of acc.balances) {
        const asset = (b.asset || "").toUpperCase();
        if (asset === baseAsset) {
          this.walletBase = Number(b.free);
          this.walletBaseLocked = Number(b.locked || 0);
          this.walletBaseTotal = this.walletBase + this.walletBaseLocked;
          updated = true;
        } else if (asset === quoteAsset) {
          this.walletQuote = Number(b.free);
          this.walletQuoteLocked = Number(b.locked || 0);
          this.walletQuoteTotal = this.walletQuote + this.walletQuoteLocked;
          updated = true;
        }
      }
    } else if (acc.B && Array.isArray(acc.B)) {
      for (const b of acc.B) {
        const asset = (b.a || "").toUpperCase();
        if (asset === baseAsset) {
          this.walletBase = parseFloat(b.f);
          this.walletBaseLocked = parseFloat(b.l || 0);
          this.walletBaseTotal = this.walletBase + this.walletBaseLocked;
          updated = true;
        } else if (asset === quoteAsset) {
          this.walletQuote = parseFloat(b.f);
          this.walletQuoteLocked = parseFloat(b.l || 0);
          this.walletQuoteTotal = this.walletQuote + this.walletQuoteLocked;
          updated = true;
        }
      }
    }

    if (updated) {
      this.emitTelemetryTick();
    }
  }

  // ── Controls & Settings ────────────────────────────────────────────────────

  public getRealDreamdexPrivateKey(): string | undefined {
    return this.cfg.dreamdexPrivateKey;
  }

  public getRealBinanceApiKey(): string | undefined {
    return this.cfg.binanceApiKey;
  }

  public getRealBinanceApiSecret(): string | undefined {
    return this.cfg.binanceApiSecret;
  }

  public getDatabase(): BotDatabase {
    return this.db;
  }

  public getRuntimeConfig(): any {
    return {
      ...this.cfg,
      strategyType: "ma_fan",
      strategyMode: "ma_fan",
    };
  }

  public updateRuntimeSettings(s: any): any {
    if (s.strategyType) this.cfg.strategyType = s.strategyType;
    if (s.symbol) {
      const clean = String(s.symbol).toUpperCase().replace(/[\/\-_:]/g, "");
      this.cfg.symbol = clean;
      this.cfg.binanceSymbol = clean.toLowerCase();
      this.maFan.symbol = clean;
    }
    if (s.exchange) this.cfg.exchange = s.exchange;
    if (s.dryRun !== undefined) {
      this.cfg.dryRun = s.dryRun;
      this.maFan.config.isDryRun = s.dryRun;
    }
    if (s.maFanManualSpreadPct !== undefined) this.cfg.maFanManualSpreadPct = s.maFanManualSpreadPct;
    if (s.maFanAutoCalibrateSpreadOnSwitch !== undefined) this.cfg.maFanAutoCalibrateSpreadOnSwitch = s.maFanAutoCalibrateSpreadOnSwitch;
    if (s.maFanUseAtrAdaptiveSpread !== undefined) this.cfg.maFanUseAtrAdaptiveSpread = s.maFanUseAtrAdaptiveSpread;
    if (s.maFanExecutionTimeframe) {
      this.cfg.maFanExecutionTimeframe = s.maFanExecutionTimeframe;
      this.maFan.config.executionTimeframe = s.maFanExecutionTimeframe;
    }
    if (s.maFanSupervisorTimeframe) {
      this.cfg.maFanSupervisorTimeframe = s.maFanSupervisorTimeframe;
      this.maFan.config.supervisorTimeframe = s.maFanSupervisorTimeframe;
    }
    if (s.maFanTp1Ratio !== undefined) this.cfg.maFanTp1Ratio = s.maFanTp1Ratio;
    if (s.maFanMaxBudgetUsd !== undefined) this.cfg.maFanMaxBudgetUsd = s.maFanMaxBudgetUsd;
    if (s.maFanSlBufferPct !== undefined) {
      this.cfg.maFanSlBufferPct = s.maFanSlBufferPct;
      this.maFan.config.slBufferPct = s.maFanSlBufferPct;
    }
    if (s.maFanUseRatchetSl !== undefined) {
      this.cfg.maFanUseRatchetSl = Boolean(s.maFanUseRatchetSl);
      this.maFan.config.useRatchetSl = this.cfg.maFanUseRatchetSl;
    }
    if (s.maFanBullCushion !== undefined) {
      this.cfg.maFanBullCushion = Boolean(s.maFanBullCushion);
      this.maFan.config.bullCushionEnabled = this.cfg.maFanBullCushion;
    }
    if (s.maFanWaterfallGuard !== undefined) {
      this.cfg.maFanWaterfallGuard = Boolean(s.maFanWaterfallGuard);
      this.maFan.config.waterfallGuardEnabled = this.cfg.maFanWaterfallGuard;
    }
    if (s.maFanAtrMultiplier !== undefined) {
      this.cfg.maFanAtrMultiplier = s.maFanAtrMultiplier;
      this.maFan.config.atrMultiplier = s.maFanAtrMultiplier;
    }
    if (s.maFanTrailingPullbackPct !== undefined) {
      this.cfg.maFanTrailingPullbackPct = s.maFanTrailingPullbackPct;
      this.maFan.config.trailingPullbackPct = s.maFanTrailingPullbackPct;
    }
    if (s.maFanBreakevenFeeBufferPct !== undefined) {
      this.cfg.maFanBreakevenFeeBufferPct = s.maFanBreakevenFeeBufferPct;
      this.maFan.config.breakevenFeeBufferPct = s.maFanBreakevenFeeBufferPct;
    }
    if (s.maFanEntryOnClosedOnly !== undefined) {
      this.cfg.maFanEntryOnClosedOnly = s.maFanEntryOnClosedOnly;
      this.maFan.config.entryOnClosedOnly = s.maFanEntryOnClosedOnly;
    }

    this.maFan.config.manualSpreadPct = this.cfg.maFanManualSpreadPct;
    this.maFan.config.autoCalibrateSpreadOnSwitch = this.cfg.maFanAutoCalibrateSpreadOnSwitch;
    this.maFan.config.useAtrAdaptiveSpread = this.cfg.maFanUseAtrAdaptiveSpread;
    this.maFan.config.tp1Ratio = this.cfg.maFanTp1Ratio;
    this.maFan.config.maxPositionBudgetUsd = this.cfg.maFanMaxBudgetUsd;

    this.maFan.getExecutor().updateOptions({
      dryRun: this.cfg.dryRun,
      breakevenFeeBufferPct: this.cfg.maFanBreakevenFeeBufferPct,
      slBufferPct: this.cfg.maFanSlBufferPct,
    });
    this.maFan.refreshConfig();

    this.db.setSettings(this.cfg);
    this.emitTelemetryTick();
    return this.getRuntimeConfig();
  }

  public setPaused(paused: boolean): boolean {
    return this.maFan.setPaused(paused);
  }

  public getIsPaused(): boolean {
    return this.maFan.getIsPaused();
  }

  public async cancelAllOrdersUser(): Promise<{ cancelledCount: number }> {
    return this.maFan.cancelAll();
  }

  public async sellAllUser(): Promise<{ success: boolean; soldQty: number; price: number; error?: string }> {
    return this.maFan.sellAll();
  }

  public async resetBotState(opts?: any): Promise<{ success: boolean }> {
    return { success: true };
  }

  public async resetPosition(): Promise<{ success: boolean; clearedLots: number }> {
    await this.maFan.sellAll();
    this.saveState(true);
    return { success: true, clearedLots: 1 };
  }

  public reloadState(): void {
    const saved = this.db.getState();
    this.maFan.restorePosition(saved?.maFanPosition || null);
    this.emitTelemetryTick();
  }

  public getRecentOrders(): any[] {
    return this.db.getOrders(100);
  }

  public saveState(immediate?: boolean): void {
    try {
      const pos = this.maFan.getActivePosition();
      this.db.saveState({
        lots: this.getLots(),
        openOrders: [],
        realizedPnl: this.maFan.getState()?.metrics?.realizedPnl ?? 0,
        walletBaseBalance: this.walletBase,
        walletQuoteBalance: this.walletQuote,
        baseAsset: this.symbolInfo.baseAsset,
        quoteAsset: this.symbolInfo.quoteAsset,
        isPaused: this.maFan.getIsPaused(),
        maFanPosition: pos ?? undefined,
        lastUpdated: Date.now(),
      });
    } catch (err: any) {
      this.log(`⚠️ Failed to persist MA Fan state: ${err.message}`);
    }
  }

  // ── Portfolio & Balances ───────────────────────────────────────────────────

  public baseHeld(): number {
    const pos = this.maFan.getState().activePosition;
    return pos ? pos.remainingQty : 0;
  }

  public getLots(): Lot[] {
    const pos = this.maFan.getState().activePosition;
    if (!pos) return [];
    return [{
      price: pos.entryPrice,
      qty: pos.remainingQty,
      time: pos.entryTime,
    }];
  }

  public async refreshWalletBalances(): Promise<any> {
    try {
      const b = await this.exchange.getAccountBalances(this.symbolInfo.symbol);
      this.walletBase = b.baseFree ?? 0;
      this.walletBaseLocked = b.baseLocked ?? 0;
      this.walletBaseTotal = b.baseTotal ?? (this.walletBase + this.walletBaseLocked);
      this.walletQuote = b.quoteFree ?? 0;
      this.walletQuoteLocked = b.quoteLocked ?? 0;
      this.walletQuoteTotal = b.quoteTotal ?? (this.walletQuote + this.walletQuoteLocked);
      this.lastBalanceSyncTs = Date.now();
      return {
        base: this.walletBase,
        quote: this.walletQuote,
        baseLocked: this.walletBaseLocked,
        baseTotal: this.walletBaseTotal,
        quoteLocked: this.walletQuoteLocked,
        quoteTotal: this.walletQuoteTotal,
        somi: this.walletBase,
        usdso: this.walletQuote,
        address: "Binance Spot",
      };
    } catch (err: any) {
      const errMsg = (err?.message || String(err)).replace(/[\r\n]+/g, " ").trim();
      this.log(`⚠️ [BALANCE QUERY] Failed to fetch balances for ${this.symbolInfo.symbol}: ${errMsg}`);
      return { base: this.walletBase, quote: this.walletQuote, somi: 0, usdso: 0, address: "" };
    }
  }

  public async syncOnChainOrders(): Promise<void> {
    // No resting grid orders to sync in MA Fan Sniper mode
  }

  // ── Symbol & Exchange Switching ────────────────────────────────────────────

  public setSwitchingSymbol(val: boolean): void {
    this.isSwitchingSymbol = val;
  }

  public async prepareForSymbolSwitch(targetSymbol: string): Promise<void> {
    this.isSwitchingSymbol = true;
    this.log(`🔄 Preparing MA Fan Strategy for switch to ${targetSymbol}...`);
  }

  public updateExchangeClient(newExchange: IExchangeClient, nextInfo: ExchangeSymbolInfo, atrSource: AtrSource): void {
    this.exchange = newExchange;
    this.symbolInfo = nextInfo;
    this.atrSource = atrSource;
    this.maFan.client = newExchange;
    this.maFan.symbol = nextInfo.symbol;
    const clean = nextInfo.symbol.toUpperCase().replace(/[\/\-_:]/g, "");
    this.cfg.symbol = clean;
    this.cfg.binanceSymbol = clean.toLowerCase();
    this.cfg.exchange = newExchange.exchangeName;
    this.db.setSettings(this.cfg);
    this.maFan.executor = new (this.maFan.executor as any).constructor({
      client: newExchange,
      dryRun: this.cfg.dryRun,
      breakevenFeeBufferPct: this.cfg.maFanBreakevenFeeBufferPct,
      slBufferPct: this.cfg.maFanSlBufferPct,
      onTrade: (t: any) => {
        this.emit({ type: "order", data: t });
        this.saveState(true);
        this.emitTelemetryTick(true);
      },
      onLog: this.log,
    });
    this.maFan.executor.setSymbolInfo(nextInfo);
    if (this.context.htfDowEngine) {
      const htfCandles = this.context.htfDowEngine.getCandles();
      if (htfCandles.length > 0) {
        this.maFan.setInitialHtfCandles(htfCandles);
      }
    }
    if (this.context.macroDowEngine) {
      const candles = this.context.macroDowEngine.getCandles();
      if (candles.length > 0) {
        this.maFan.setInitialCandles(candles);
      }
    }
    this.isSwitchingSymbol = false;
  }

  public updateSymbolInfo(nextInfo: ExchangeSymbolInfo, atrSource: AtrSource): void {
    this.symbolInfo = nextInfo;
    this.atrSource = atrSource;
    this.maFan.symbol = nextInfo.symbol;
    this.maFan.executor.setSymbolInfo(nextInfo);
    const clean = nextInfo.symbol.toUpperCase().replace(/[\/\-_:]/g, "");
    this.cfg.symbol = clean;
    this.cfg.binanceSymbol = clean.toLowerCase();
    this.db.setSettings(this.cfg);
    if (this.context.htfDowEngine) {
      const htfCandles = this.context.htfDowEngine.getCandles();
      if (htfCandles.length > 0) {
        this.maFan.setInitialHtfCandles(htfCandles);
      }
    }
    if (this.context.macroDowEngine) {
      const candles = this.context.macroDowEngine.getCandles();
      if (candles.length > 0) {
        this.maFan.setInitialCandles(candles);
      }
    }
    this.isSwitchingSymbol = false;
  }
}
