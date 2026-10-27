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
  public readonly name = "MA Fan Elastic Reversion Trader";
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

  private walletBase: number = 0;
  private walletQuote: number = 0;

  constructor(context: StrategyContext) {
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
      maxPositionBudgetUsd: this.cfg.maFanMaxBudgetUsd ?? 200,
      isDryRun: this.cfg.dryRun ?? false,
    };

    this.maFan = new MaFanStrategy({
      symbol: this.symbolInfo.symbol,
      config: maFanConfig,
      client: this.exchange,
      onLog: this.log,
      onTrade: (t) => {
        this.emit({ type: "order", data: t });
        this.emitTelemetryTick();
      },
    });

    if (context.macroDowEngine) {
      const candles = context.macroDowEngine.getCandles();
      if (candles && candles.length > 0) {
        this.maFan.setInitialCandles(candles);
      }
    }
    if (context.htfDowEngine) {
      const htfCandles = context.htfDowEngine.getCandles();
      if (htfCandles && htfCandles.length > 0) {
        this.maFan.setInitialHtfCandles(htfCandles);
      }
    }

    this.maFan.init().catch((err) => this.log(`⚠️ MaFan init error: ${err.message}`));
  }

  // ── Lifecycle & Execution ──────────────────────────────────────────────────

  public async tick(): Promise<void> {
    if (this.isSwitchingSymbol) return;

    try {
      const top = await this.exchange.getTopOfBook(this.symbolInfo.symbol);
      const refPrice = top.mid > 0 ? top.mid : (top.bestAsk + top.bestBid) / 2;
      if (refPrice > 0) {
        await this.maFan.step(refPrice);
      }
    } catch (err: any) {
      // In dryRun or offline, fallback to last candle close
      const candles = (this.maFan as any).candles;
      if (candles && candles.length > 0) {
        const lastP = candles[candles.length - 1].close;
        await this.maFan.step(lastP);
      }
    }

    this.emitTelemetryTick();
  }

  public getIntervalMs(): number {
    return this.cfg.intervalMs || 1000;
  }

  // ── Real-time Feeds & Events ──────────────────────────────────────────────

  public onCandleClosed(candle: Candle): void {
    this.maFan.onCandle(candle, true);
    this.emitTelemetryTick();
  }

  public onHtfCandleClosed(candle: Candle): void {
    this.maFan.onHtfCandle(candle, true);
    this.emitTelemetryTick();
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

  public emitTelemetryTick(): void {
    const state = this.maFan.getState();
    const tickData = {
      ...state,
      strategyType: "ma_fan",
      strategyMode: "ma_fan",
      symbol: this.symbolInfo.symbol,
      baseAsset: this.symbolInfo.baseAsset,
      quoteAsset: this.symbolInfo.quoteAsset,
      walletBaseBalance: this.walletBase,
      walletQuoteBalance: this.walletQuote,
      dryRun: this.cfg.dryRun,
      time: Date.now(),
    };

    this.emit({ type: "tick", data: tickData });
  }

  public handleWsBookTicker(b: any): void {
    if (b && b.bestBid && b.bestAsk) {
      const mid = (parseFloat(b.bestBid) + parseFloat(b.bestAsk)) / 2;
      if (mid > 0) {
        this.maFan.step(mid).catch((err) => this.log(`⚠️ step error: ${err.message}`));
      }
    }
  }

  public handleWsExecutionReport(rep: any): void {
    this.log(`📥 WS execution report received in MA Fan adapter: ${rep?.s} ${rep?.S} ${rep?.X}`);
  }

  public handleWsAccountUpdate(acc: any): void {
    if (acc && acc.B) {
      for (const b of acc.B) {
        if (b.a === this.symbolInfo.baseAsset) this.walletBase = parseFloat(b.f);
        if (b.a === this.symbolInfo.quoteAsset) this.walletQuote = parseFloat(b.f);
      }
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
    if (s.maFanManualSpreadPct !== undefined) this.cfg.maFanManualSpreadPct = s.maFanManualSpreadPct;
    if (s.maFanAutoCalibrateSpreadOnSwitch !== undefined) this.cfg.maFanAutoCalibrateSpreadOnSwitch = s.maFanAutoCalibrateSpreadOnSwitch;
    if (s.maFanUseAtrAdaptiveSpread !== undefined) this.cfg.maFanUseAtrAdaptiveSpread = s.maFanUseAtrAdaptiveSpread;
    if (s.maFanTp1Ratio !== undefined) this.cfg.maFanTp1Ratio = s.maFanTp1Ratio;
    if (s.maFanMaxBudgetUsd !== undefined) this.cfg.maFanMaxBudgetUsd = s.maFanMaxBudgetUsd;

    this.maFan.config.manualSpreadPct = this.cfg.maFanManualSpreadPct;
    this.maFan.config.autoCalibrateSpreadOnSwitch = this.cfg.maFanAutoCalibrateSpreadOnSwitch;
    this.maFan.config.useAtrAdaptiveSpread = this.cfg.maFanUseAtrAdaptiveSpread;
    this.maFan.config.tp1Ratio = this.cfg.maFanTp1Ratio;
    this.maFan.config.maxPositionBudgetUsd = this.cfg.maFanMaxBudgetUsd;

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
    return { success: true, clearedLots: 1 };
  }

  public reloadState(): void {
    this.emitTelemetryTick();
  }

  public getRecentOrders(): any[] {
    return this.db.getOrders(100);
  }

  public saveState(immediate?: boolean): void {
    // DB state is automatically recorded on trades
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
      this.walletBase = b.baseFree;
      this.walletQuote = b.quoteFree;
      return { base: b.baseFree, quote: b.quoteFree, somi: b.baseFree, usdso: b.quoteFree, address: "" };
    } catch {
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
    this.maFan.executor = new (this.maFan.executor as any).constructor({
      client: newExchange,
      dryRun: this.cfg.dryRun,
    });
    this.isSwitchingSymbol = false;
  }

  public updateSymbolInfo(nextInfo: ExchangeSymbolInfo, atrSource: AtrSource): void {
    this.symbolInfo = nextInfo;
    this.atrSource = atrSource;
    this.maFan.symbol = nextInfo.symbol;
    this.isSwitchingSymbol = false;
  }
}
