/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// Channel Grid Strategy (Dow Market Structure Driven):
//
// ── The Channel Structure ──────────────────────────────────────────────────
// - 0% Lower Bound (Support / Floor): Cut-Loss / Stop-Loss trigger.
// - 0% to 50% Buy Zone: Stepped accumulation zone (buy dips toward floor).
// - 50% Channel Center: Neutral equilibrium midpoint.
// - 50% to 100% Sell Zone: Stepped profit taking zone (sell rallies).
// - 100% Upper Bound (Resistance / Ceiling): 100% Full Take-Profit exit.
//
// All bounds and zones are calculated directly from Market Structure,
// not arbitrary ATR offsets.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BinanceClient, type BinanceSymbolInfo, roundToStep, roundToTick } from "./exchange/binance/client.js";
import type { BookTickerData, BinanceExecutionReport, BinanceAccountUpdate } from "./exchange/binance/feed.js";
import type { IExchangeClient, ExchangeSymbolInfo } from "./exchange/types.js";
import { ORDER_TYPE, shiftBps, spreadBps, createStatusLogger } from "./utils.js";
import type { Config } from "./config.js";
import type { AtrSource } from "./types.js";
import type { DowStructureEngine, DowStructure } from "./market-structure.js";
import { BotDatabase, getDatabase, type StrategyStateRecord, type TradeRecord, type OrderActivityRecord, type GasLogRecord, type LockedChannel } from "./db.js";

export interface Lot {
  price: number; // entry price
  qty: number;   // base remaining
  time: number;  // timestamp entry
}

export interface OpenOrder {
  id: string;
  onChainOrderId?: string;
  isBid: boolean; // true = BUY, false = SELL
  price: number;
  qty: number;
  targetFraction: number;
  notional?: number;
  notionalQuote: number;
  notionalUsdso: number;
  levelDesc: string;
  placedTime: number;
  expireTime?: number;
  txHash?: string;
}

export interface StrategyEvent {
  type: "tick" | "order" | "order_gas";
  data: any;
}

export type GridPersistedState = StrategyStateRecord;

export class DynamicGrid {
  private db: BotDatabase;
  private lots: Lot[] = [];
  private openOrders: OpenOrder[] = [];
  private cancelledOrderIds = new Map<string, number>(); // orderId → timestamp of cancellation
  private handledExitOrderIds = new Map<string, number>(); // orderId → timestamp of exit/IOC execution
  private inFlightOrders = new Set<string>();
  private orderCooldowns = new Map<string, number>();
  private realizedPnl = 0;
  private tradeRealizedPnl = 0;
  private totalGasDeductedBase = 0;
  private totalGasDeductedQuote = 0;
  private accumulatedGasBase = 0;
  private accumulatedGasQuote = 0;
  private totalGasSpentBase = 0;
  private totalGasSpentQuote = 0;
  public get totalGasDeductedSomi(): number { return this.totalGasDeductedBase; }
  public set totalGasDeductedSomi(v: number) { this.totalGasDeductedBase = v; }
  public get totalGasDeductedUsdso(): number { return this.totalGasDeductedQuote; }
  public set totalGasDeductedUsdso(v: number) { this.totalGasDeductedQuote = v; }
  public get accumulatedGasSomi(): number { return this.accumulatedGasBase; }
  public set accumulatedGasSomi(v: number) { this.accumulatedGasBase = v; }
  public get accumulatedGasUsdso(): number { return this.accumulatedGasQuote; }
  public set accumulatedGasUsdso(v: number) { this.accumulatedGasQuote = v; }
  public get totalGasSpentSomi(): number { return this.totalGasSpentBase; }
  public set totalGasSpentSomi(v: number) { this.totalGasSpentBase = v; }
  public get totalGasSpentUsdso(): number { return this.totalGasSpentQuote; }
  public set totalGasSpentUsdso(v: number) { this.totalGasSpentQuote = v; }
  private totalTxCount = 0;
  private lastRefPrice = 0.2;
  private stuckSince?: number;
  private waitingForHigherLow = false;
  private breakdownFloorPrice?: number;
  private breakdownLowPrice?: number;
  private breakdownTime?: number;
  private breakdownCandleTimes = new Set<number>();
  private sellOrdersActive = true;
  private sellZoneTransitionCandleTime?: number;
  private buyOrdersActive = true;
  private needsSellRebalance = true;
  private needsBuyRebalance = true;
  private lastDynamicBounds?: {
    lowerBound: number;
    upperBound: number;
    centerPrice: number;
    buyLevels: number[];
    sellLevels: number[];
  };
  private lockedChannel?: LockedChannel;
  /** State machine for IOC Bracket Sell distribution cycle */
  private iocBracketSellCycle?: {
    baselineHeldQuote: number;
    baselineHeldQty: number;
    numSellTranches: number;
    soldStepNums: Set<number>;
  };
  private lastTelemetryData?: any;
  private lastHudLogTime = 0;
  private readonly hudLogIntervalMs = 5_000;
  private tickCount = 0;
  private isPaused = true;
  private isSqueezePaused = false;
  private stepBps: number;
  private recentOrders: any[] = [];
  private recentTrades: any[] = [];
  private eventListeners: ((event: StrategyEvent) => void)[] = [];

  /** Spot exchange and symbol specifications */
  public symbol: string;
  public baseAsset: string;
  public quoteAsset: string;
  public minQty: number;
  public stepSize: number;
  public tickSize: number;
  public minNotional: number;

  /** On-chain / exchange wallet balance state */
  private walletAddress = "";
  public walletBaseBalance = 0;
  public walletQuoteBalance = 0;
  public get walletSomiBalance(): number { return this.walletBaseBalance; }
  public set walletSomiBalance(v: number) { this.walletBaseBalance = v; }
  public get walletUsdsoBalance(): number { return this.walletQuoteBalance; }
  public set walletUsdsoBalance(v: number) { this.walletQuoteBalance = v; }
  private lastObservedBaseBalance = 0;
  private lastObservedQuoteBalance = 0;
  private get lastObservedSomiBalance(): number { return this.lastObservedBaseBalance; }
  private set lastObservedSomiBalance(v: number) { this.lastObservedBaseBalance = v; }
  private get lastObservedUsdsoBalance(): number { return this.lastObservedQuoteBalance; }
  private set lastObservedUsdsoBalance(v: number) { this.lastObservedQuoteBalance = v; }

  /** Real-time WebSocket Book Ticker cache */
  private wsBookTicker?: BookTickerData;
  private lastPeriodicSyncTs = 0;
  private readonly periodicSyncIntervalMs = 30_000; // Background sanity check every 30s instead of 200ms!

  /** Throttled status logger */
  private readonly status: (msg: string) => void;

  constructor(
    private binance: IExchangeClient,
    private symbolInfo: ExchangeSymbolInfo,
    private readonly cfg: Config,
    private readonly atrSource: AtrSource,
    private readonly log: (msg: string, extra?: unknown) => void,
    private readonly dowEngine?: DowStructureEngine,
    private readonly localTrendEngine?: DowStructureEngine,
  ) {
    this.symbol = symbolInfo.symbol;
    this.baseAsset = symbolInfo.baseAsset;
    this.quoteAsset = symbolInfo.quoteAsset;
    this.minQty = symbolInfo.minQty;
    this.stepSize = symbolInfo.stepSize;
    this.tickSize = symbolInfo.tickSize;
    this.minNotional = symbolInfo.minNotional;

    this.status = createStatusLogger(log);
    this.stepBps = cfg.warmupStepBps;
    this.isPaused = cfg.startPaused ?? true;
    this.db = getDatabase({
      dbPath: cfg.dbPath,
      legacyStateFile: cfg.stateFile,
      log: (msg) => this.log(msg),
    });
    // Restore dynamic settings from database as the single source of truth
    const savedSettings = this.db.getAllSettings();
    if (savedSettings && Object.keys(savedSettings).length > 0) {
      for (const [k, v] of Object.entries(savedSettings)) {
        if (k in this.cfg && v !== undefined) {
          (this.cfg as any)[k] = v;
        }
      }
      this.syncDowEngineSettings();
    } else {
      // Initialize database with initial configuration so all future changes live 100% in DB
      this.db.setSettings(this.getRuntimeConfig());
    }
    this.loadState();
  }

  public updateExchangeClient(newClient: IExchangeClient, info?: ExchangeSymbolInfo): void {
    if (this.cfg.persistState) {
      this.saveState(true);
    }
    this.binance = newClient;
    this.cfg.exchange = newClient.exchangeName as "binance" | "dreamdex";
    if (info) {
      this.updateSymbolInfo(info);
    } else {
      this.loadState();
    }
    this.log(`🔄 [strategy] Switched exchange client to: ${newClient.exchangeName.toUpperCase()}`);
  }

  public updateSymbolInfo(info: ExchangeSymbolInfo): void {
    if (this.cfg.persistState) {
      this.saveState(true);
    }
    this.symbolInfo = info;
    this.symbol = info.symbol;
    this.cfg.symbol = info.symbol;
    this.baseAsset = info.baseAsset;
    this.quoteAsset = info.quoteAsset;
    this.minQty = info.minQty;
    this.stepSize = info.stepSize;
    this.tickSize = info.tickSize;
    this.minNotional = info.minNotional;
    this.loadState();
    this.log(`🔄 [strategy] Updated trading pair to ${this.symbol} (${this.baseAsset}/${this.quoteAsset})`);
  }

  /**
   * Handle real-time Book Ticker from WebSocket stream (<symbol>@bookTicker).
   * Provides 0-weight instantaneous bestBid and bestAsk updates.
   */
  public handleWsBookTicker(book: BookTickerData): void {
    this.wsBookTicker = book;
  }

  /**
   * Handle real-time outboundAccountPosition event from Binance User Data Stream.
   * Updates walletBaseBalance and walletQuoteBalance directly without REST /account polling!
   */
  public handleWsAccountUpdate(update: BinanceAccountUpdate): void {
    let updated = false;
    for (const b of update.balances) {
      if (b.asset.toUpperCase() === this.baseAsset.toUpperCase()) {
        this.walletBaseBalance = b.free;
        this.lastObservedBaseBalance = b.free;
        updated = true;
      } else if (b.asset.toUpperCase() === this.quoteAsset.toUpperCase()) {
        this.walletQuoteBalance = b.free;
        this.lastObservedQuoteBalance = b.free;
        updated = true;
      }
    }
    if (updated) {
      this.saveState();
    }
  }

  /**
   * Handle real-time executionReport event from Binance User Data Stream.
   * Catches FILLED, PARTIALLY_FILLED, CANCELED immediately without polling /openOrders!
   */
  public handleWsExecutionReport(report: BinanceExecutionReport): void {
    if (report.symbol.toUpperCase() !== this.symbol.toUpperCase()) return;

    const idStr = String(report.orderId);
    const isBid = report.side === "BUY";
    const status = report.orderStatus;
    const lastFilledQty = report.lastExecutedQty;
    const lastFilledPrice = report.lastExecutedPrice > 0 ? report.lastExecutedPrice : report.price;

    this.log(
      `⚡ [WS EXEC] ${report.side} Order #${idStr} -> status: ${status} (lastQty: ${lastFilledQty}, price: $${lastFilledPrice})`,
    );

    // 🔒 Exit / IOC Order De-duplication:
    // If this order was already processed synchronously by sellAll / sellTrancheIOC / buyTrancheIOC,
    // do not create a duplicate fill record!
    if (this.handledExitOrderIds.has(idStr)) {
      this.log(`⚡ [WS EXEC] Order #${idStr} was already handled synchronously (${status}) — skipping duplicate fill processing`);
      return;
    }

    // 1. Partial or Full Fill
    if (status === "FILLED" || status === "PARTIALLY_FILLED") {
      const existing = this.openOrders.find((o) => o.onChainOrderId === idStr);
      const levelDesc = existing?.levelDesc ?? `${report.side} Order #${idStr}`;

      if (isBid) {
        this.processBuyFill({
          price: lastFilledPrice,
          qty: lastFilledQty > 0 ? lastFilledQty : report.cumulativeFilledQty,
          levelDesc,
          orderId: idStr,
          logPrefix: "[WS] BINANCE ",
          dryRun: false,
        });
      } else {
        this.processSellFill({
          price: lastFilledPrice,
          qty: lastFilledQty > 0 ? lastFilledQty : report.cumulativeFilledQty,
          levelDesc,
          orderId: idStr,
          logPrefix: "[WS] BINANCE ",
          dryRun: false,
        });
      }

      if (status === "FILLED") {
        this.openOrders = this.openOrders.filter((o) => o.onChainOrderId !== idStr);
        this.saveState();
      } else if (existing) {
        existing.qty = Math.max(0, report.origQty - report.cumulativeFilledQty);
        existing.notionalQuote = existing.qty * existing.price;
        existing.notionalUsdso = existing.notionalQuote;
        this.saveState();
      }
    } else if (status === "CANCELED" || status === "EXPIRED" || status === "REJECTED") {
      // 2. Canceled / Rejected
      this.cancelledOrderIds.set(idStr, Date.now());
      this.openOrders = this.openOrders.filter((o) => o.onChainOrderId !== idStr);
      this.saveState();
    }
  }

  private syncDowEngineSettings(): void {
    if (this.dowEngine) {
      if (this.cfg.wickThresholdPct !== undefined) this.dowEngine.setWickThresholdPct(this.cfg.wickThresholdPct);
      if (this.cfg.useTrueWick !== undefined) this.dowEngine.setUseTrueWick(this.cfg.useTrueWick);
      if (this.cfg.maxCandleCount !== undefined) this.dowEngine.setMaxCandles(this.cfg.maxCandleCount);
    }
    if (this.localTrendEngine) {
      if (this.cfg.wickThresholdPct !== undefined) this.localTrendEngine.setWickThresholdPct(this.cfg.wickThresholdPct);
      if (this.cfg.useTrueWick !== undefined) this.localTrendEngine.setUseTrueWick(this.cfg.useTrueWick);
      if (this.cfg.maxCandleCount !== undefined) this.localTrendEngine.setMaxCandles(this.cfg.maxCandleCount);
    }
  }

  public getDatabase(): BotDatabase {
    return this.db;
  }

  public getRuntimeConfig(): Record<string, any> {
    return {
      maxInventoryQuote: this.cfg.maxInventoryQuote,
      maxInventoryUsdso: this.cfg.maxInventoryQuote,
      floorBufferPct: this.cfg.floorBufferPct,
      cutLossAtLowerBound: this.cfg.cutLossAtLowerBound,
      takeProfitAtUpperBound: this.cfg.takeProfitAtUpperBound,
      dowTrendFilter: this.cfg.dowTrendFilter,
      trendlineFilter: this.cfg.trendlineFilter,
      enableBuyLevel2Recovery: this.cfg.enableBuyLevel2Recovery,
      enableBuyBelowSellLevel1: this.cfg.enableBuyBelowSellLevel1 !== false,
      enableSellAboveBuyLevel1: this.cfg.enableSellAboveBuyLevel1 !== false,
      orderExecutionMode: this.cfg.orderExecutionMode ?? "IOC_BRACKET",
      iocSlippagePct: this.cfg.iocSlippagePct ?? 0.35,
      enableBuyAboveTrendSupport: this.cfg.enableBuyAboveTrendSupport !== false,
      enableSellBelowTrendResistance: this.cfg.enableSellBelowTrendResistance !== false,
      sellProfitMode: this.cfg.sellProfitMode || (this.cfg.requireProfitAboveAvgEntry ? "PORTFOLIO_AVG_PROFIT" : "GRID_CASHFLOW"),
      requireProfitAboveAvgEntry: this.cfg.requireProfitAboveAvgEntry === true,
      enableLaggardSnipe: this.cfg.enableLaggardSnipe,
      enableLaggardGuard: this.cfg.enableLaggardGuard,
      laggardThresholdPct: this.cfg.laggardThresholdPct,
      channelMode: this.cfg.channelMode,
      minChannelWidthPct: this.cfg.minChannelWidthPct,
      maxChannelWidthPct: this.cfg.maxChannelWidthPct,
      lockChannelInPosition: this.cfg.lockChannelInPosition !== false,
      srMinTouchCount: this.cfg.srMinTouchCount ?? 2,
      srTouchTolerancePct: this.cfg.srTouchTolerancePct ?? 0.35,
      srLookbackCandles: this.cfg.srLookbackCandles ?? 300,
      initialCandleCount: this.cfg.initialCandleCount ?? 300,
      maxCandleCount: this.cfg.maxCandleCount ?? 600,
      minChannelShiftPct: this.cfg.minChannelShiftPct,
      orderPriceTolerancePct: this.cfg.orderPriceTolerancePct,
      orderQtyTolerancePct: this.cfg.orderQtyTolerancePct,
      orderExpireHours: this.cfg.orderExpireHours,
      cutLossMaxBidDiscountPct: this.cfg.cutLossMaxBidDiscountPct,
      enableTriangleSqueezeExit: this.cfg.enableTriangleSqueezeExit,
      triangleSqueezeSpreadPct: this.cfg.triangleSqueezeSpreadPct,
      minTradeableChannelWidthPct: this.cfg.minTradeableChannelWidthPct,
      useTrueWick: this.cfg.useTrueWick,
      wickThresholdPct: this.cfg.wickThresholdPct,
      intervalMs: this.cfg.intervalMs ?? 2000,
      dryRun: this.cfg.dryRun,
      symbol: this.symbol,
      exchange: this.cfg.exchange || "binance",
      binanceApiKey: this.cfg.binanceApiKey || "",
      binanceApiSecret: this.cfg.binanceApiSecret ? "******" : "",
      binanceBaseUrl: this.cfg.binanceBaseUrl || "https://api.binance.com",
      binanceWsBase: this.cfg.binanceWsBase || "wss://stream.binance.com:9443",
      dreamdexPrivateKey: this.cfg.dreamdexPrivateKey ? "******" : "",
      dreamdexRpcUrl: this.cfg.dreamdexRpcUrl || "https://api.infra.mainnet.somnia.network",
      minGasReserveSomi: this.cfg.minGasReserveSomi ?? 2.0,
      timezone: this.cfg.timezone || "Asia/Bangkok",
      dashboardPort: this.cfg.dashboardPort ?? 3333,
    };
  }

  public getRealDreamdexPrivateKey(): string | undefined {
    return this.cfg.dreamdexPrivateKey;
  }

  public getRealBinanceApiSecret(): string | undefined {
    return this.cfg.binanceApiSecret;
  }

  public getIntervalMs(): number {
    return this.cfg.intervalMs ?? 2000;
  }

  public updateRuntimeSettings(newSettings: Record<string, any>): Record<string, any> {
    for (const [key, val] of Object.entries(newSettings)) {
      if (key in this.cfg && val !== undefined) {
        // If updating secret/key and user kept the masked placeholder, do not overwrite
        if ((key === "binanceApiSecret" || key === "dreamdexPrivateKey") && val === "******") continue;
        (this.cfg as any)[key] = val;
      }
    }
    if (this.binance.exchangeName === "binance") {
      if (newSettings.binanceApiKey !== undefined || newSettings.binanceApiSecret !== undefined || newSettings.binanceBaseUrl !== undefined) {
        const newKey = newSettings.binanceApiKey !== undefined ? newSettings.binanceApiKey : this.cfg.binanceApiKey;
        const newSecret = (newSettings.binanceApiSecret !== undefined && newSettings.binanceApiSecret !== "******")
          ? newSettings.binanceApiSecret
          : this.cfg.binanceApiSecret;
        const newBase = newSettings.binanceBaseUrl !== undefined ? newSettings.binanceBaseUrl : this.cfg.binanceBaseUrl;
        this.binance.updateCredentials(newKey, newSecret, newBase);
      }
    } else if (this.binance.exchangeName === "dreamdex") {
      if (newSettings.dreamdexPrivateKey !== undefined || newSettings.dreamdexRpcUrl !== undefined) {
        const privKey = (newSettings.dreamdexPrivateKey !== undefined && newSettings.dreamdexPrivateKey !== "******")
          ? newSettings.dreamdexPrivateKey
          : this.cfg.dreamdexPrivateKey;
        const rpc = newSettings.dreamdexRpcUrl !== undefined ? newSettings.dreamdexRpcUrl : this.cfg.dreamdexRpcUrl;
        this.binance.updateCredentials(privKey, "", rpc);
      }
    }
    if (newSettings.maxCandleCount !== undefined) {
      this.cfg.maxCandleCount = Math.max(50, Math.round(Number(newSettings.maxCandleCount)));
    }
    if (newSettings.initialCandleCount !== undefined) {
      this.cfg.initialCandleCount = Math.max(10, Math.min(1000, Math.round(Number(newSettings.initialCandleCount))));
    }
    if (newSettings.sellProfitMode !== undefined) {
      this.cfg.sellProfitMode = newSettings.sellProfitMode;
      this.cfg.requireProfitAboveAvgEntry = newSettings.sellProfitMode === "PORTFOLIO_AVG_PROFIT";
    } else if (newSettings.requireProfitAboveAvgEntry !== undefined) {
      this.cfg.sellProfitMode = newSettings.requireProfitAboveAvgEntry ? "PORTFOLIO_AVG_PROFIT" : "GRID_CASHFLOW";
    }
    if (newSettings.minGasReserveSomi !== undefined) {
      this.cfg.minGasReserveSomi = Math.max(0, Number(newSettings.minGasReserveSomi));
    }
    this.syncDowEngineSettings();
    const configToPersist = {
      ...this.getRuntimeConfig(),
      // Ensure real secrets are persisted in DB if provided
      binanceApiSecret: this.cfg.binanceApiSecret,
      dreamdexPrivateKey: this.cfg.dreamdexPrivateKey,
    };
    this.db.setSettings(configToPersist);
    const sanitizedLog = { ...newSettings };
    if (sanitizedLog.binanceApiSecret) sanitizedLog.binanceApiSecret = "******";
    if (sanitizedLog.dreamdexPrivateKey) sanitizedLog.dreamdexPrivateKey = "******";
    this.log(`⚙️ [settings] updated runtime configuration in database: ${JSON.stringify(sanitizedLog)}`);
    return this.getRuntimeConfig();
  }

  /** Fetch current live balances for base asset and quote asset from Exchange */
  public async refreshWalletBalances(): Promise<{ base: number; quote: number; somi: number; usdso: number; address: string }> {
    let somiBal = 0;
    try {
      if (this.binance.hasCredentials()) {
        const b = await this.binance.getAccountBalances(this.symbol);
        this.walletBaseBalance = b.baseFree;
        this.walletQuoteBalance = b.quoteFree;
        somiBal = b.allBalances?.SOMI?.free ?? (this.baseAsset === "SOMI" ? b.baseFree : 0);
        this.walletAddress = `${this.baseAsset}/${this.quoteAsset}`;
        this.lastObservedBaseBalance = this.walletBaseBalance;
        this.lastObservedQuoteBalance = this.walletQuoteBalance;
      } else {
        this.walletAddress = `${this.binance.exchangeName}-Public`;
      }
    } catch {
      // Retain last known balances on transient errors
    }
    return {
      base: this.walletBaseBalance,
      quote: this.walletQuoteBalance,
      somi: somiBal,
      usdso: this.walletQuoteBalance,
      address: this.walletAddress,
    };
  }

  /**
   * Reconcile on-chain resting orders with in-memory state
   * Ensures the bot never places duplicate orders on restart or across ticks
   */
  public async syncOnChainOrders(): Promise<void> {
    if (this.cfg.dryRun || !this.binance.hasCredentials()) return;
    try {
      const prevBase = this.lastObservedBaseBalance > 0 ? this.lastObservedBaseBalance : this.walletBaseBalance;
      const prevQuote = this.lastObservedQuoteBalance > 0 ? this.lastObservedQuoteBalance : this.walletQuoteBalance;

      await this.refreshWalletBalances();
      const curBase = this.walletBaseBalance;
      const curQuote = this.walletQuoteBalance;

      const deltaBase = curBase - prevBase;
      const deltaQuote = curQuote - prevQuote;

      // 1. Query active open orders directly from Binance Spot API
      const liveOrders = await this.binance.getOpenOrders(this.symbol);
      const onChainIdSet = new Set<string>(liveOrders.map((o) => o.orderId.toString()));

      // If Binance confirms 0 open orders, purge phantom in-memory orders
      if (onChainIdSet.size === 0 && this.openOrders.length > 0) {
        this.log(`🧹 [sync] Binance confirms 0 open orders — cleared ${this.openOrders.length} stale in-memory order(s)`);
        this.openOrders = [];
        this.saveState();
      }

      // In IOC_BRACKET mode, resting BUY maker orders should never exist on the book
      if (this.cfg.orderExecutionMode === "IOC_BRACKET") {
        const lingeringBuys = this.openOrders.filter((o) => o.isBid);
        if (lingeringBuys.length > 0) {
          this.log(`🧹 [IOC_BRACKET] Sweeping & clearing ${lingeringBuys.length} resting buy orders`);
          for (const lb of lingeringBuys) {
            if (lb.onChainOrderId) {
              this.cancelledOrderIds.set(lb.onChainOrderId, Date.now());
              try {
                await this.binance.cancelOrder(this.symbol, lb.onChainOrderId);
              } catch {}
            }
            this.emit({
              type: "order",
              data: {
                action: "CANCEL_BUY",
                price: lb.price,
                qty: lb.qty,
                notionalQuote: lb.notionalQuote !== undefined ? lb.notionalQuote : lb.notionalUsdso,
                notionalUsdso: lb.notionalUsdso,
                levelDesc: lb.levelDesc,
                orderId: lb.onChainOrderId,
                reason: "IOC_BRACKET mode active — swept resting buy order",
                time: Date.now(),
                dryRun: this.cfg.dryRun,
              },
            });
          }
          this.openOrders = this.openOrders.filter((o) => !o.isBid);
          this.saveState();
        }
      }

      // Check details of all open orders from Binance & detect Partial Fills in real-time
      for (const liveOrder of liveOrders) {
        const idStr = liveOrder.orderId.toString();
        const isBid = liveOrder.side === "BUY";
        const price = liveOrder.price;
        const remainingQty = liveOrder.origQty - liveOrder.executedQty;
        const alreadyTracked = this.openOrders.find((o) => o.onChainOrderId === idStr);

        if (alreadyTracked) {
          const prevRemaining = alreadyTracked.qty;
          if (liveOrder.executedQty > 0 && remainingQty < prevRemaining - 1e-8) {
            const filledQty = prevRemaining - remainingQty;
            alreadyTracked.qty = remainingQty;
            alreadyTracked.notionalQuote = remainingQty * alreadyTracked.price;
            alreadyTracked.notionalUsdso = alreadyTracked.notionalQuote;

            const sideStr = isBid ? "BUY" : "SELL";
            this.log(
              `⚡ [sync] PARTIAL BINANCE ${sideStr} MATCH for Order #${idStr} (Filled: ${filledQty} ${this.baseAsset} @ $${alreadyTracked.price} | Remaining: ${remainingQty} ${this.baseAsset}).`,
            );

            if (isBid) {
              this.processBuyFill({
                price: alreadyTracked.price,
                qty: filledQty,
                levelDesc: `${alreadyTracked.levelDesc} [Partial]`,
                orderId: idStr,
                logPrefix: "[sync] PARTIAL ",
                dryRun: false,
              });
            } else {
              this.processSellFill({
                price: alreadyTracked.price,
                qty: filledQty,
                levelDesc: `${alreadyTracked.levelDesc} [Partial]`,
                orderId: idStr,
                logPrefix: "[sync] PARTIAL ",
                dryRun: false,
              });
            }
          }
        } else {
          // New open order on Binance: link or record
          if (remainingQty > 0 && price > 0) {
            if (this.cfg.orderExecutionMode === "IOC_BRACKET") {
              this.cancelledOrderIds.set(idStr, Date.now());
              try {
                await this.binance.cancelOrder(this.symbol, idStr);
                this.log(`🧹 [IOC_BRACKET] Cancelled unmanaged resting ${isBid ? "buy" : "sell"} order #${idStr} on Binance`);
              } catch {}
              continue;
            }
            const matchByPrice = this.openOrders.find(
              (o) => o.isBid === isBid && !o.onChainOrderId &&
                Math.abs(o.price - price) / price < 0.0005 &&
                Math.abs(o.qty - remainingQty) / (remainingQty || 1) < 0.15,
            );
            if (matchByPrice) {
              matchByPrice.onChainOrderId = idStr;
              matchByPrice.qty = remainingQty;
            } else {
              const notionalQuote = price * remainingQty;
              const notionalUsdso = notionalQuote;
              const sideStr = isBid ? "BUY" : "SELL";

              // Attempt to match with existing known grid levels by closest price (within 0.15%)
              let matchedLevelDesc: string | undefined;
              let matchedTargetFraction = 0;
              const currentBounds = this.lockedChannel || this.lastDynamicBounds;
              if (currentBounds) {
                if (isBid && currentBounds.buyLevels) {
                  const isSingleBuy = currentBounds.buyLevels.length === 1;
                  const buyNames = isSingleBuy
                    ? ["Buy Edge Floor (+0.2%)"]
                    : ["Buy Level 1 (40%)", "Buy Level 2 (30%)", "Buy Level 3 (20%)", "Buy Level 4 (10%)"];
                  const buyTargets = isSingleBuy
                    ? [1.0]
                    : [0.25, 0.50, 0.75, 1.0];
                  let bestBuyIdx = -1;
                  let minBuyDiff = Infinity;
                  for (let i = 0; i < currentBounds.buyLevels.length; i++) {
                    const bPrice = currentBounds.buyLevels[i];
                    if (bPrice) {
                      const diff = Math.abs(bPrice - price) / price;
                      if (diff < minBuyDiff) {
                        minBuyDiff = diff;
                        bestBuyIdx = i;
                      }
                    }
                  }
                  if (bestBuyIdx >= 0 && minBuyDiff <= 0.0015) {
                    matchedLevelDesc = buyNames[bestBuyIdx] || `Buy Level ${bestBuyIdx + 1}`;
                    matchedTargetFraction = buyTargets[bestBuyIdx] || 1.0;
                  }
                } else if (!isBid && currentBounds.sellLevels) {
                  const isSingleSell = currentBounds.sellLevels.length === 1;
                  const sellNames = isSingleSell
                    ? ["Sell Edge Ceil (-0.2%)"]
                    : ["Sell Target 1 (60%)", "Sell Target 2 (70%)", "Sell Target 3 (80%)", "Sell Target 4 (90%)"];
                  const sellTargets = isSingleSell
                    ? [0.0]
                    : [0.75, 0.50, 0.25, 0.0];
                  let bestSellIdx = -1;
                  let minSellDiff = Infinity;
                  for (let i = 0; i < currentBounds.sellLevels.length; i++) {
                    const sPrice = currentBounds.sellLevels[i];
                    if (sPrice) {
                      const diff = Math.abs(sPrice - price) / price;
                      if (diff < minSellDiff) {
                        minSellDiff = diff;
                        bestSellIdx = i;
                      }
                    }
                  }
                  if (bestSellIdx >= 0 && minSellDiff <= 0.0015) {
                    matchedLevelDesc = sellNames[bestSellIdx] || `Sell Target ${bestSellIdx + 1}`;
                    matchedTargetFraction = sellTargets[bestSellIdx] ?? 0.0;
                  } else if (
                    this.dowEngine?.getStructure()?.downtrendLine &&
                    !this.dowEngine.getStructure().downtrendLine.isBroken
                  ) {
                    const tlPrice = this.dowEngine.getStructure().downtrendLine.currentLinePrice;
                    if (tlPrice > 0 && Math.abs(tlPrice - price) / tlPrice <= 0.005) {
                      matchedLevelDesc = "Sell TL Exit (Trendline)";
                      matchedTargetFraction = 0.0;
                    }
                  }
                }
              }

              const finalLevelDesc = matchedLevelDesc || `${sideStr} Order #${idStr}`;
              this.log(
                `[sync] 🔗 Reconciled active Binance ${sideStr} order #${idStr} @ $${price} (${remainingQty} ${this.baseAsset} | $${notionalQuote.toFixed(2)} ${this.quoteAsset}) • ${finalLevelDesc}`,
              );
              this.openOrders.push({
                id: `order_${isBid ? "buy" : "sell"}_${idStr}`,
                onChainOrderId: idStr,
                isBid,
                price,
                qty: remainingQty,
                targetFraction: matchedTargetFraction,
                notional: notionalQuote,
                notionalQuote,
                notionalUsdso,
                levelDesc: finalLevelDesc,
                placedTime: liveOrder.time || Date.now(),
              });
            }
          }
        }
      }

      // 4. Periodic cleanup: remove cancelled/handled order IDs older than 1 hour
      const cleanupThreshold = Date.now() - 3600_000;
      for (const [id, ts] of this.cancelledOrderIds) {
        if (ts < cleanupThreshold) this.cancelledOrderIds.delete(id);
      }
      for (const [id, ts] of this.handledExitOrderIds) {
        if (ts < cleanupThreshold) this.handledExitOrderIds.delete(id);
      }

      // 5. Pillar 2: Process in-memory orders whose ID is no longer open on Binance
      const staleTracked = this.openOrders.filter(
        (o) => !o.onChainOrderId || !onChainIdSet.has(o.onChainOrderId),
      );

      for (const stale of staleTracked) {
        if (!stale.onChainOrderId) {
          this.log(`ℹ️ [sync] Leftover virtual order removed: ${stale.levelDesc}`);
          continue;
        }

        try {
          const binanceOrder = await this.binance.getOrder(this.symbol, stale.onChainOrderId);
          const wasFilled = binanceOrder.status === "FILLED" || binanceOrder.executedQty > 0;

          if (wasFilled) {
            const filledQty = binanceOrder.executedQty || stale.qty;
            const fillPrice = binanceOrder.cummulativeQuoteQty > 0 && binanceOrder.executedQty > 0
              ? binanceOrder.cummulativeQuoteQty / binanceOrder.executedQty
              : stale.price;

            if (stale.isBid) {
              this.log(
                `⚡ [sync] Confirmed BINANCE BUY MATCH for Order #${stale.onChainOrderId} (${filledQty} ${this.baseAsset} @ $${fillPrice}).`,
              );
              this.processBuyFill({
                price: fillPrice,
                qty: filledQty,
                levelDesc: stale.levelDesc,
                orderId: stale.onChainOrderId,
                logPrefix: "[sync] BINANCE ",
                dryRun: false,
              });
            } else {
              this.log(
                `⚡ [sync] Confirmed BINANCE SELL MATCH for Order #${stale.onChainOrderId} (${filledQty} ${this.baseAsset} @ $${fillPrice}).`,
              );
              this.processSellFill({
                price: fillPrice,
                qty: filledQty,
                levelDesc: stale.levelDesc,
                orderId: stale.onChainOrderId,
                logPrefix: "[sync] BINANCE ",
                dryRun: false,
              });
            }
          } else {
            const sideStr = stale.isBid ? "BUY" : "SELL";
            this.log(
              `ℹ️ [sync] Confirmed CANCEL ${sideStr} for Order #${stale.onChainOrderId} (${stale.qty} ${this.baseAsset} @ $${stale.price}) [${binanceOrder.status}].`,
            );
            this.emit({
              type: "order",
              data: {
                side: stale.isBid ? "BUY" : "SELL",
                action: stale.isBid ? "CANCEL_BUY" : "CANCEL_SELL",
                price: stale.price,
                qty: stale.qty,
                notionalQuote: stale.notionalQuote !== undefined ? stale.notionalQuote : stale.notionalUsdso,
                notionalUsdso: stale.notionalUsdso,
                levelDesc: stale.levelDesc,
                orderId: stale.onChainOrderId,
                reason: `Binance ${binanceOrder.status}`,
                time: Date.now(),
                dryRun: false,
              },
            });
          }
        } catch (err) {
          this.log(`⚠️ [sync] Could not query order #${stale.onChainOrderId}: ${(err as Error).message}`);
        }
      }

      this.openOrders = this.openOrders.filter((o) => !staleTracked.includes(o));

      // 6. Pillar 3: On-Chain History Sync & Database Reconciliation (Supports DreamDEX Indexer & Binance)
      try {
        if (typeof (this.binance as any).getIndexer === "function" && typeof (this.binance as any).getWalletAddress === "function") {
          const indexer = (this.binance as any).getIndexer();
          const owner = (this.binance as any).getWalletAddress();
          if (indexer && owner) {
            const synced = await this.db.syncRecentOrdersFromIndexer(indexer, owner, undefined, 50);
            if (synced > 0) {
              this.recentOrders = this.db.getOrders(5000);
            }
          }
        } else if (typeof this.binance.getRecentOrders === "function") {
          const recents = await this.binance.getRecentOrders(this.symbol, 50);
          if (recents && recents.length > 0) {
            let modified = false;
            for (const ro of recents) {
              const idStr = String(ro.orderId);
              const existing = this.db.getOrders(5000).find((o) => String(o.orderId) === idStr);
              if (!existing) {
                const isFilled = ro.status === "FILLED";
                const isCancelled = ro.status === "CANCELED" || ro.status === "EXPIRED";
                const status = isFilled ? "FILLED" : isCancelled ? "CANCELLED" : "OPEN";
                const action = isFilled
                  ? (ro.side === "BUY" ? "BUY_FILL" : "SELL_FILL")
                  : isCancelled
                  ? (ro.side === "BUY" ? "CANCEL_BUY" : "CANCEL_SELL")
                  : (ro.side === "BUY" ? "CREATE_BUY" : "CREATE_SELL");
                const time = ro.time || Date.now();
                this.db.recordEvent({
                  orderId: idStr,
                  side: ro.side,
                  price: ro.price,
                  qty: ro.executedQty || ro.origQty,
                  notionalQuote: (ro.executedQty || ro.origQty) * ro.price,
                  notionalUsdso: (ro.executedQty || ro.origQty) * ro.price,
                  levelDesc: `${ro.side} ${ro.type}`,
                  status,
                  action,
                  time,
                  dryRun: false,
                });
                modified = true;
              }
            }
            if (modified) {
              this.recentOrders = this.db.getOrders(5000);
            }
          }
        }
      } catch (err) {
        this.log(`⚠️ [sync] History reconciliation error: ${(err as Error).message}`);
      }

      // Always update last observed balances at end of sync
      this.lastObservedSomiBalance = this.walletSomiBalance;
      this.lastObservedBaseBalance = this.walletBaseBalance;
      this.lastObservedQuoteBalance = this.walletQuoteBalance;
      this.saveState();
    } catch (err) {
      this.log(`[sync] warning: failed to sync on-chain open orders: ${(err as Error).message}`);
    }
  }

  /**
   * Gas Reserve Management:
   * - On DreamDEX (Somnia DEX): Every on-chain transaction consumes native SOMI for gas.
   *   If trading SOMI:USDSO, SOMI is the Base Asset itself, so minGasReserveSomi MUST be reserved
   *   and excluded from sellable trading capacity to prevent the wallet from running out of gas.
   * - On Binance Spot (CEX): Ledger balances & standard trading fees apply; 100% of base asset is tradeable.
   */
  public getEffectiveGasReserveSomi(): number {
    if (this.binance.exchangeName === "dreamdex") {
      return this.cfg.minGasReserveSomi ?? 2.0;
    }
    return 0;
  }
  public getEffectiveGasReserveBase(): number {
    if (this.binance.exchangeName === "dreamdex" && this.baseAsset === "SOMI") {
      return this.cfg.minGasReserveSomi ?? 2.0;
    }
    return 0;
  }

  /**
   * Multi-Pillar Active Inventory Reconcile.
   * Compares physical assets (wallet balance + resting limit sells) with strategy lots.
   */
  public async reconcileInventory(): Promise<void> {
    if (this.cfg.dryRun) return;
    try {
      const minReserveBase = this.getEffectiveGasReserveBase();
      const baseInOpenSells = this.openOrders
        .filter((o) => !o.isBid)
        .reduce((sum, o) => sum + (o.qty || 0), 0);

      const totalOwnedBase = this.walletBaseBalance + baseInOpenSells;
      const maxAllowedTradingBase = Math.max(0, totalOwnedBase - minReserveBase);
      const memoryHeld = this.baseHeld();
      const tolerance = Math.max(0.5, (this.minQty || 1) * 0.5);

      // 1. Auto-compensate from lots: smoothly clamp lots to available trading capacity
      if (memoryHeld > maxAllowedTradingBase && maxAllowedTradingBase >= 0) {
        const diff = memoryHeld - maxAllowedTradingBase;
        if (diff > (this.minQty || 0.0001)) {
          this.clampLotsTo(maxAllowedTradingBase);
          this.saveState();
        }
      } else if (maxAllowedTradingBase > memoryHeld + Math.max(this.minQty || 0.0001, 0.0001)) {
        // 2. Adopt Unallocated Trading Inventory: If physical trading capacity exceeds memory lots, adopt difference into lots
        // SAFETY GUARD: NEVER adopt unallocated inventory when price is below floor / cut-loss zone or waiting for Higher Low!
        // This prevents re-adopting wallet balance and triggering repetitive 30s cut-loss dump loops.
        if (this.waitingForHigherLow) {
          // Skip adopting during breakdown recovery to protect remaining wallet assets
          return;
        }
        const rawUnallocated = maxAllowedTradingBase - memoryHeld;
        const unallocatedQty = roundToStep(rawUnallocated, this.stepSize || 0.0001, 4);
        if (unallocatedQty >= this.minQty) {
          const recentOrders = this.db.getOrders(10);
          const lastBuyFill = recentOrders.find((o) => o.action === "BUY_FILL" && o.price > 0);
          const adoptPrice = lastBuyFill?.price || this.lastRefPrice || (this.lots.length > 0 ? this.getAvgEntryPrice() : 0.21);
          this.log(
            `📥 [INVENTORY RECONCILE] Detected unallocated trading inventory in wallet (${unallocatedQty.toFixed(4)} ${this.baseAsset} > memory ${memoryHeld.toFixed(4)} ${this.baseAsset}). Adopting into lots at $${adoptPrice.toFixed(6)} to enable full grid turnover / take-profit!`,
          );
          this.lots.push({
            price: adoptPrice,
            qty: unallocatedQty,
            time: Date.now(),
          });
          this.saveState();
        }
      }

      // 3. Guard against Excess Resting Sells: If resting sell orders exceed allowed trading base, cancel sell orders to refund balance to wallet
      if (baseInOpenSells > maxAllowedTradingBase + tolerance) {
        this.log(
          `🛑 [INVENTORY RECONCILE] Open sell orders (${baseInOpenSells.toFixed(4)} ${this.baseAsset}) exceed trading capacity (${maxAllowedTradingBase.toFixed(4)} ${this.baseAsset}). Cancelling resting sell orders to return balance to wallet!`,
        );
        await this.cancelAllRestingOrders("SELL", "Reconciling sell orders to protect initial wallet balance");
        await this.refreshWalletBalances();
        this.saveState();
      }
    } catch {
      // Ignore transient audit errors
    }
  }

  public getSymbolKey(): string {
    const ex = (this.binance?.exchangeName || this.cfg.exchange || "binance").toLowerCase();
    const sym = (this.symbol || this.cfg.symbol || "unknown").toUpperCase().replace(/[\/\-_:]/g, "");
    return `${ex}:${sym}`;
  }

  private clampLotsTo(maxAllowedQty: number): void {
    if (maxAllowedQty <= 1e-6) {
      this.lots = [];
      this.lockedChannel = undefined;
      this.lastDynamicBounds = undefined;
      this.db.saveLockedChannel(this.getSymbolKey(), undefined);
      return;
    }
    let accumulated = 0;
    const clampedLots: Lot[] = [];
    for (const lot of this.lots) {
      if (accumulated + lot.qty <= maxAllowedQty) {
        clampedLots.push(lot);
        accumulated += lot.qty;
      } else {
        const remaining = maxAllowedQty - accumulated;
        if (remaining > 1e-6) {
          clampedLots.push({ ...lot, qty: remaining });
          accumulated += remaining;
        }
        break;
      }
    }
    this.lots = clampedLots;
  }

  private getStateFilePath(): string {
    const filename = this.cfg.stateFile || ".grid-state.json";
    if (path.isAbsolute(filename)) return filename;
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const localDir = path.resolve(moduleDir, "..");
    const localPath = path.resolve(localDir, filename);
    const cwdPath = path.resolve(process.cwd(), filename);

    if (fs.existsSync(localPath)) return localPath;
    if (fs.existsSync(cwdPath)) return cwdPath;
    return localPath;
  }

  public reloadState(): void {
    this.loadState();
  }

  public loadState(): void {
    if (!this.cfg.persistState) return;
    try {
      const symbolKey = this.getSymbolKey();
      const data = this.db.getState(symbolKey);
      if (Array.isArray(data.lots)) {
        this.lots = data.lots.filter((l) => Number.isFinite(l.price) && Number.isFinite(l.qty) && l.qty > 1e-6);
      }
      // 🔒 Absolute Single Source of Truth: NEVER restore openOrders from offline file on boot!
      // On production, local files may contain stale or ghost orders from prior crashes or sessions.
      // Active resting orders must strictly and authoritatively be queried from Somnia Markets GraphQL Indexer & contract.
      this.openOrders = [];
      if (typeof data.tradeRealizedPnl === "number" && Number.isFinite(data.tradeRealizedPnl)) {
        this.tradeRealizedPnl = data.tradeRealizedPnl;
      } else if (typeof data.realizedPnl === "number" && Number.isFinite(data.realizedPnl)) {
        this.tradeRealizedPnl = data.realizedPnl;
      }
      const gasDeductedBase = data.totalGasDeductedBase ?? data.totalGasDeductedSomi;
      if (typeof gasDeductedBase === "number" && Number.isFinite(gasDeductedBase)) {
        this.totalGasDeductedBase = gasDeductedBase;
      }
      const gasDeductedQuote = data.totalGasDeductedQuote ?? data.totalGasDeductedUsdso;
      if (typeof gasDeductedQuote === "number" && Number.isFinite(gasDeductedQuote)) {
        this.totalGasDeductedQuote = gasDeductedQuote;
      }
      const accGasBase = data.accumulatedGasBase ?? data.accumulatedGasSomi;
      if (typeof accGasBase === "number" && Number.isFinite(accGasBase)) {
        this.accumulatedGasBase = accGasBase;
      }
      const accGasQuote = data.accumulatedGasQuote ?? data.accumulatedGasUsdso;
      if (typeof accGasQuote === "number" && Number.isFinite(accGasQuote)) {
        this.accumulatedGasQuote = accGasQuote;
      }
      if (typeof data.realizedPnl === "number" && Number.isFinite(data.realizedPnl)) {
        this.realizedPnl = data.realizedPnl;
      } else {
        this.realizedPnl = this.tradeRealizedPnl - this.totalGasDeductedQuote;
      }
      const gasSpentBase = data.totalGasSpentBase ?? data.totalGasSpentSomi;
      if (typeof gasSpentBase === "number" && Number.isFinite(gasSpentBase)) {
        this.totalGasSpentBase = gasSpentBase;
      }
      const gasSpentQuote = data.totalGasSpentQuote ?? data.totalGasSpentUsdso;
      if (typeof gasSpentQuote === "number" && Number.isFinite(gasSpentQuote)) {
        this.totalGasSpentQuote = gasSpentQuote;
      }
      if (typeof data.totalTxCount === "number") {
        this.totalTxCount = data.totalTxCount;
      }
      if (typeof data.stuckSince === "number") {
        this.stuckSince = data.stuckSince;
      }
      if (typeof data.waitingForHigherLow === "boolean") {
        this.waitingForHigherLow = data.waitingForHigherLow;
      } else if (typeof data.brokenValleyPrice === "number") {
        this.waitingForHigherLow = true;
        this.breakdownFloorPrice = data.brokenValleyPrice;
      }
      if (typeof data.breakdownFloorPrice === "number") {
        this.breakdownFloorPrice = data.breakdownFloorPrice;
      }
      if (typeof data.breakdownLowPrice === "number") {
        this.breakdownLowPrice = data.breakdownLowPrice;
      }
      if (typeof data.breakdownTime === "number") {
        this.breakdownTime = data.breakdownTime;
      } else if (typeof data.brokenValleyTime === "number") {
        this.breakdownTime = data.brokenValleyTime;
      }
      // Restore unified orders from database (up to 5000 items)
      const dbOrders = this.db.getOrders(5000);
      if (dbOrders.length > 0) {
        this.recentOrders = dbOrders;
      } else if (Array.isArray(data.recentOrders)) {
        this.recentOrders = data.recentOrders;
      }

      if (typeof data.sellOrdersActive === "boolean") {
        this.sellOrdersActive = data.sellOrdersActive;
      }
      if (typeof data.buyOrdersActive === "boolean") {
        this.buyOrdersActive = data.buyOrdersActive;
      }
      if (typeof data.isSqueezePaused === "boolean") {
        this.isSqueezePaused = data.isSqueezePaused;
      }
      if (this.cfg.startPaused !== false) {
        this.isPaused = true;
      } else if (typeof data.isPaused === "boolean") {
        this.isPaused = data.isPaused;
      }
      // 🔒 Persistent Multi-Symbol Channel Lock Restoration:
      // Look up locked channel for this exact exchange:symbol pair from dedicated storage
      const persistentLockedChannel = this.db.getLockedChannel(symbolKey) || data.lockedChannel;

      if (
        persistentLockedChannel &&
        typeof persistentLockedChannel.lowerBound === "number" &&
        typeof persistentLockedChannel.upperBound === "number" &&
        Array.isArray(persistentLockedChannel.buyLevels) &&
        persistentLockedChannel.buyLevels.length >= 4 &&
        Array.isArray(persistentLockedChannel.sellLevels) &&
        persistentLockedChannel.sellLevels.length >= 4
      ) {
        const hasInventory = this.lots.length > 0 && this.baseHeld() >= (this.minQty || 0.001);
        const hasOpenSells = this.openOrders.some((o) => !o.isBid);

        // As long as the bot holds inventory or resting sell orders, this locked channel represents
        // the original structural entry and profit-taking bounds! Never wipe it arbitrarily.
        if (hasInventory || hasOpenSells) {
          this.lockedChannel = persistentLockedChannel;
          this.lastDynamicBounds = {
            lowerBound: persistentLockedChannel.lowerBound,
            upperBound: persistentLockedChannel.upperBound,
            centerPrice: persistentLockedChannel.centerPrice,
            buyLevels: [...persistentLockedChannel.buyLevels],
            sellLevels: [...persistentLockedChannel.sellLevels],
          };
          this.log(
            `🔒 [state] Restored persistent locked channel bounds for ${symbolKey}: [$${this.lastDynamicBounds.lowerBound.toFixed(6)} .. $${this.lastDynamicBounds.upperBound.toFixed(6)}] (Center: $${this.lastDynamicBounds.centerPrice.toFixed(6)}) with ${this.lots.length} lots held`,
          );
        } else {
          this.lockedChannel = undefined;
          this.lastDynamicBounds = undefined;
          this.db.saveLockedChannel(symbolKey, undefined);
        }
      }

      const totalHeld = this.baseHeld();
      if (totalHeld < this.minQty && totalHeld > 0) {
        // Clean up dust lots on startup
        this.lots = [];
      }
      const avgEntry = this.getAvgEntryPrice();
      this.log(
        `[state] restored ${this.lots.length} open lots (${this.baseHeld().toFixed(4)} SOMI | Avg: $${avgEntry.toFixed(6)}) and ${this.openOrders.length} open resting orders | Realized PnL: ${this.realizedPnl >= 0 ? "+$" : "-$"}${Math.abs(this.realizedPnl).toFixed(4)} from database ${this.cfg.dbPath} (${this.recentOrders.length} unified orders)${this.waitingForHigherLow ? " (Waiting for Higher Low)" : ""}${this.isPaused ? " [PAUSED ⏸️]" : " [ACTIVE ▶️]"}`,
      );
    } catch (err) {
      this.log(`warning: could not load state from database: ${(err as Error).message}`);
    }
  }

  public saveState(immediate = false): void {
    if (!this.cfg.persistState) return;
    try {
      const data: StrategyStateRecord = {
        lots: this.lots,
        openOrders: this.openOrders,
        realizedPnl: this.realizedPnl,
        tradeRealizedPnl: this.tradeRealizedPnl,
        netPnl: this.realizedPnl,
        walletBaseBalance: this.walletBaseBalance,
        walletQuoteBalance: this.walletQuoteBalance,
        baseAsset: this.baseAsset,
        quoteAsset: this.quoteAsset,
        totalGasDeductedBase: this.totalGasDeductedBase,
        totalGasDeductedQuote: this.totalGasDeductedQuote,
        totalGasDeductedSomi: this.totalGasDeductedBase,
        totalGasDeductedUsdso: this.totalGasDeductedQuote,
        accumulatedGasBase: this.accumulatedGasBase,
        accumulatedGasQuote: this.accumulatedGasQuote,
        accumulatedGasSomi: this.accumulatedGasBase,
        accumulatedGasUsdso: this.accumulatedGasQuote,
        totalGasSpentBase: this.totalGasSpentBase,
        totalGasSpentQuote: this.totalGasSpentQuote,
        totalGasSpentSomi: this.totalGasSpentBase,
        totalGasSpentUsdso: this.totalGasSpentQuote,
        totalTxCount: this.totalTxCount,
        stuckSince: this.stuckSince,
        waitingForHigherLow: this.waitingForHigherLow,
        breakdownFloorPrice: this.breakdownFloorPrice,
        breakdownLowPrice: this.breakdownLowPrice,
        breakdownTime: this.breakdownTime,
        sellOrdersActive: this.sellOrdersActive,
        buyOrdersActive: this.buyOrdersActive,
        isSqueezePaused: this.isSqueezePaused,
        isPaused: this.isPaused,
        recentOrders: this.recentOrders.slice(-500),
        lockedChannel: this.lockedChannel,
        lastUpdated: Date.now(),
      };
      const symbolKey = this.getSymbolKey();
      this.db.saveState(data, immediate, symbolKey);
      this.db.saveLockedChannel(symbolKey, this.lockedChannel);
    } catch (err) {
      this.log(`warning: could not save state to database: ${(err as Error).message}`);
    }
  }

  onEvent(fn: (event: StrategyEvent) => void): void {
    this.eventListeners.push(fn);
  }

  private emit(event: StrategyEvent): void {
    if (event.type === "order") {
      this.db.recordEvent(event.data);
      this.recentOrders = this.db.getOrders(5000);
      this.saveState();
    }
    for (const listener of this.eventListeners) {
      listener(event);
    }
  }

  getRecentTrades(): any[] {
    return this.db.getTrades(5000);
  }

  getRecentOrders(): any[] {
    return this.db.getOrders(5000);
  }

  getLots(): Lot[] {
    return [...this.lots];
  }

  getRealizedPnl(): number {
    return this.realizedPnl;
  }

  public setPaused(paused: boolean): boolean {
    this.isPaused = paused;
    if (!paused) {
      this.needsBuyRebalance = true;
      this.needsSellRebalance = true;
    }
    this.log(`🕹️ Bot operation ${paused ? "PAUSED ⏸️" : "RESUMED ▶️"} by user.`);
    this.saveState();
    this.emitTelemetryTick();
    return this.isPaused;
  }

  public getIsPaused(): boolean {
    return this.isPaused;
  }

  public async cancelAllOrdersUser(): Promise<{ cancelledCount: number }> {
    this.log(`🛑 User triggered MANUAL EMERGENCY CANCEL ALL ORDERS.`);
    // Automatically pause bot so it does not immediately re-place orders on the next tick
    this.isPaused = true;

    const toCancel = [...this.openOrders];
    const count = toCancel.length;

    // Immediately remember all order IDs as cancelled for 2 hours
    const now = Date.now();
    for (const o of toCancel) {
      if (o.onChainOrderId) this.cancelledOrderIds.set(o.onChainOrderId, now);
    }

    // Immediately clear in-memory openOrders so background tick()/syncOnChainOrders() never sees them as stale/filled!
    this.openOrders = [];
    this.inFlightOrders.clear();
    this.orderCooldowns.clear();
    this.saveState(true);

    // Cancel resting orders on-chain
    if (count > 0) {
      for (const order of toCancel) {
        await this.cancelOrderInternal(order, "User requested Cancel All Orders");
      }
    }

    // Direct Purge: cancel all open orders on Binance
    if (!this.cfg.dryRun && this.binance.hasCredentials()) {
      try {
        await this.binance.cancelAllOpenOrders(this.symbol);
        this.log(`🗑️ Directly cancelled all open orders on Binance for ${this.symbol}`);
      } catch (err) {
        this.log(`⚠️ Binance cancel all orders error: ${(err as Error).message}`);
      }
    }

    await this.refreshWalletBalances();
    await this.reconcileInventory();
    this.saveState(true);
    this.emitTelemetryTick();
    return { cancelledCount: count };
  }

  public async resetBotState(opts?: { resetPnl?: boolean; clearTrades?: boolean }): Promise<{ success: boolean }> {
    this.log(`🔄 User triggered MANUAL BOT RESET.`);
    // Automatically pause bot so it starts clean
    this.isPaused = true;

    for (const o of this.openOrders) {
      if (o.onChainOrderId) this.cancelledOrderIds.set(o.onChainOrderId, Date.now());
    }

    // 1. Cancel all resting orders
    if (this.openOrders.length > 0) {
      await this.cancelAllRestingOrders(undefined, "Manual Bot Reset");
    }

    // Direct Purge: cancel all open orders on Binance
    if (!this.cfg.dryRun && this.binance.hasCredentials()) {
      try {
        await this.binance.cancelAllOpenOrders(this.symbol);
        this.log(`🗑️ Directly cancelled all open orders on Binance for ${this.symbol}`);
      } catch (err) {
        this.log(`⚠️ Binance cancel all orders error: ${(err as Error).message}`);
      }
    }

    // 2. Clear memory lots & orders completely
    this.lots = [];
    this.openOrders = [];
    this.inFlightOrders.clear();
    this.orderCooldowns.clear();
    this.waitingForHigherLow = false;
    this.breakdownFloorPrice = undefined;
    this.breakdownLowPrice = undefined;
    this.breakdownTime = undefined;
    this.breakdownCandleTimes.clear();
    this.sellOrdersActive = true;
    this.buyOrdersActive = true;
    this.stuckSince = undefined;
    this.lockedChannel = undefined;
    this.lastDynamicBounds = undefined;
    this.db.saveLockedChannel(this.getSymbolKey(), undefined);

    // 4. Reset PnL & Gas if requested
    if (opts?.resetPnl) {
      this.realizedPnl = 0;
      this.tradeRealizedPnl = 0;
      this.totalGasDeductedBase = 0;
      this.totalGasDeductedQuote = 0;
      this.accumulatedGasBase = 0;
      this.accumulatedGasQuote = 0;
      this.totalGasSpentBase = 0;
      this.totalGasSpentQuote = 0;
      this.totalTxCount = 0;
    }

    // 5. Clear DB history if requested
    if (opts?.clearTrades) {
      this.db.clearTradesAndActivity();
      this.recentOrders = [];
      this.recentTrades = [];
    }

    await this.refreshWalletBalances();
    this.saveState(true);
    this.emitTelemetryTick();
    this.log(`✅ Bot state completely reset and memory cleared!`);
    return { success: true };
  }

  public async resetPosition(): Promise<{ success: boolean; clearedLots: number }> {
    this.log(`🎯 User triggered RESET POSITION.`);
    const count = this.lots.length;
    this.lots = [];

    // Cancel all resting SELL orders since we no longer hold a position to sell
    await this.cancelAllRestingOrders("SELL", "User Reset Position");

    this.waitingForHigherLow = false;
    this.breakdownFloorPrice = undefined;
    this.breakdownLowPrice = undefined;
    this.breakdownTime = undefined;
    this.breakdownCandleTimes.clear();
    this.sellOrdersActive = true;
    this.buyOrdersActive = true;
    this.stuckSince = undefined;
    this.lockedChannel = undefined;
    this.lastDynamicBounds = undefined;
    this.db.saveLockedChannel(this.getSymbolKey(), undefined);

    this.saveState(true);
    this.emitTelemetryTick();
    this.log(`✅ Position successfully reset to 0.00 ${this.baseAsset} (Ready for fresh trading from level 1).`);
    return { success: true, clearedLots: count };
  }

  public emitTelemetryTick(): void {
    const mid = this.lastRefPrice || 0.2;
    const avgEntry = this.getAvgEntryPrice();
    const held = this.baseHeld();
    const unrealizedPnl = held > 0 && avgEntry > 0 ? (mid - avgEntry) * held : 0;

    if (this.lastTelemetryData) {
      const merged = {
        ...this.lastTelemetryData,
        time: Date.now(),
        mid,
        isPaused: this.isPaused,
        waitingForHigherLow: this.waitingForHigherLow,
        breakdownFloorPrice: this.breakdownFloorPrice,
        breakdownLowPrice: this.breakdownLowPrice,
        unrealizedPnl,
        realizedPnl: this.realizedPnl,
        tradeRealizedPnl: this.tradeRealizedPnl,
        totalGasDeductedBase: this.totalGasDeductedBase,
        totalGasDeductedQuote: this.totalGasDeductedQuote,
        totalGasDeductedSomi: this.totalGasDeductedBase,
        totalGasDeductedUsdso: this.totalGasDeductedQuote,
        accumulatedGasBase: this.accumulatedGasBase,
        accumulatedGasQuote: this.accumulatedGasQuote,
        accumulatedGasSomi: this.accumulatedGasBase,
        accumulatedGasUsdso: this.accumulatedGasQuote,
        totalGasSpentBase: this.totalGasSpentBase,
        totalGasSpentQuote: this.totalGasSpentQuote,
        totalGasSpentSomi: this.totalGasSpentBase,
        totalGasSpentUsdso: this.totalGasSpentQuote,
        totalTxCount: this.totalTxCount,
        netPnlQuote: this.realizedPnl,
        netPnlUsdso: this.realizedPnl,
        avgEntryPrice: avgEntry,
        lots: this.lots.map((l) => ({ price: l.price, qty: l.qty, time: l.time })),
        openOrders: this.openOrders.map((o) => ({
          id: o.id,
          onChainOrderId: o.onChainOrderId,
          isBid: o.isBid,
          price: o.price,
          qty: o.qty,
          notional: o.notionalQuote !== undefined ? o.notionalQuote : o.notionalUsdso,
          notionalQuote: o.notionalQuote !== undefined ? o.notionalQuote : o.notionalUsdso,
          notionalUsdso: o.notionalUsdso,
          levelDesc: o.levelDesc,
          placedTime: o.placedTime,
          expireTime: o.expireTime,
        })),
        baseAsset: this.symbolInfo.baseAsset,
        quoteAsset: this.symbolInfo.quoteAsset,
        symbol: this.symbol,
        walletAddress: this.walletAddress,
        walletBaseBalance: this.walletBaseBalance,
        walletQuoteBalance: this.walletQuoteBalance,
        walletSomiBalance: this.walletBaseBalance,
        walletUsdsoBalance: this.walletQuoteBalance,
        walletBaseValueQuote: this.walletBaseBalance * mid,
        walletTotalValueQuote: (this.walletBaseBalance * mid) + this.walletQuoteBalance,
        walletSomiValueUsdso: this.walletBaseBalance * mid,
        walletTotalValueUsdso: (this.walletBaseBalance * mid) + this.walletQuoteBalance,
        tradingBaseBalance: Math.max(0, (this.walletBaseBalance + this.openOrders.filter((o) => !o.isBid).reduce((sum, o) => sum + (o.qty || 0), 0)) - this.getEffectiveGasReserveBase()),
        freeTradingBaseBalance: Math.max(0, this.walletBaseBalance - this.getEffectiveGasReserveBase()),
        tradingSomiBalance: Math.max(0, (this.walletBaseBalance + this.openOrders.filter((o) => !o.isBid).reduce((sum, o) => sum + (o.qty || 0), 0)) - this.getEffectiveGasReserveBase()),
        freeTradingSomiBalance: Math.max(0, this.walletBaseBalance - this.getEffectiveGasReserveBase()),
        gasReserveSomi: this.getEffectiveGasReserveBase(),
        minGasReserveSomi: this.getEffectiveGasReserveSomi(),
        dryRun: this.cfg.dryRun,
      };
      this.lastTelemetryData = merged;
      this.emit({ type: "tick", data: merged });
      return;
    }

    this.emit({
      type: "tick",
      data: {
        time: Date.now(),
        mid,
        isPaused: this.isPaused,
        waitingForHigherLow: this.waitingForHigherLow,
        breakdownFloorPrice: this.breakdownFloorPrice,
        breakdownLowPrice: this.breakdownLowPrice,
        unrealizedPnl,
        realizedPnl: this.realizedPnl,
        tradeRealizedPnl: this.tradeRealizedPnl,
        totalGasDeductedBase: this.totalGasDeductedBase,
        totalGasDeductedQuote: this.totalGasDeductedQuote,
        totalGasDeductedSomi: this.totalGasDeductedBase,
        totalGasDeductedUsdso: this.totalGasDeductedQuote,
        accumulatedGasBase: this.accumulatedGasBase,
        accumulatedGasQuote: this.accumulatedGasQuote,
        accumulatedGasSomi: this.accumulatedGasBase,
        accumulatedGasUsdso: this.accumulatedGasQuote,
        totalGasSpentBase: this.totalGasSpentBase,
        totalGasSpentQuote: this.totalGasSpentQuote,
        totalGasSpentSomi: this.totalGasSpentBase,
        totalGasSpentUsdso: this.totalGasSpentQuote,
        totalTxCount: this.totalTxCount,
        netPnlQuote: this.realizedPnl,
        netPnlUsdso: this.realizedPnl,
        avgEntry,
        lots: this.lots,
        openOrders: this.openOrders,
        walletAddress: this.walletAddress,
        walletBaseBalance: this.walletBaseBalance,
        walletQuoteBalance: this.walletQuoteBalance,
        walletSomiBalance: this.walletBaseBalance,
        walletUsdsoBalance: this.walletQuoteBalance,
        walletBaseValueQuote: this.walletBaseBalance * mid,
        walletTotalValueQuote: (this.walletBaseBalance * mid) + this.walletQuoteBalance,
        walletSomiValueUsdso: this.walletBaseBalance * mid,
        walletTotalValueUsdso: (this.walletBaseBalance * mid) + this.walletQuoteBalance,
        tradingBaseBalance: Math.max(0, (this.walletBaseBalance + this.openOrders.filter((o) => !o.isBid).reduce((sum, o) => sum + (o.qty || 0), 0)) - this.getEffectiveGasReserveBase()),
        freeTradingBaseBalance: Math.max(0, this.walletBaseBalance - this.getEffectiveGasReserveBase()),
        tradingSomiBalance: Math.max(0, (this.walletBaseBalance + this.openOrders.filter((o) => !o.isBid).reduce((sum, o) => sum + (o.qty || 0), 0)) - this.getEffectiveGasReserveBase()),
        freeTradingSomiBalance: Math.max(0, this.walletBaseBalance - this.getEffectiveGasReserveBase()),
        gasReserveSomi: this.getEffectiveGasReserveBase(),
        minGasReserveSomi: this.getEffectiveGasReserveSomi(),
        dryRun: this.cfg.dryRun,
      },
    });
  }

  async tick(): Promise<void> {
    const now = Date.now();
    // 1. Periodic background sync (every 30s) as sanity check only, eliminating aggressive 200ms REST polling!
    if (now - this.lastPeriodicSyncTs >= this.periodicSyncIntervalMs) {
      this.lastPeriodicSyncTs = now;
      await this.refreshWalletBalances();
      if (!this.cfg.dryRun) {
        await this.syncOnChainOrders();
        await this.reconcileInventory();
      }
    }

    let bestBid: number | undefined;
    let bestAsk: number | undefined;
    let mid: number | undefined;

    // 2. Real-time Book Ticker: Prioritize WebSocket stream (0 REST weight)
    if (this.wsBookTicker && now - this.wsBookTicker.time < 10_000) {
      bestBid = this.wsBookTicker.bestBid;
      bestAsk = this.wsBookTicker.bestAsk;
      mid = this.wsBookTicker.mid;
    } else {
      // Fallback: poll REST only if WebSocket is unavailable or stale (>10s)
      try {
        const top = await this.binance.getTopOfBook(this.symbol);
        if (top) {
          bestBid = top.bestBid;
          bestAsk = top.bestAsk;
          mid = top.mid;
        }
      } catch (err) {
        this.status(`Binance bookTicker fallback error: ${(err as Error).message}`);
      }
    }

    const binancePrice = this.atrSource.getLatestPrice?.();
    const effectiveMid = (mid !== undefined && mid > 0) ? mid : (binancePrice ?? 0);

    if (effectiveMid === undefined || effectiveMid <= 0) {
      this.status("empty book and no Binance price — waiting for price feed");
      return;
    }

    // Sample mid-price for synthetic bars if self-sampled
    if (mid !== undefined && mid > 0) {
      this.atrSource.sample?.(mid);
    }

    this.tickCount++;
    if (this.tickCount % this.cfg.recalcEveryTicks === 0) this.recalcStep();

    let isSpreadDislocated = false;
    let spreadDislocationReason = "";

    const isDex = this.binance.exchangeName === "dreamdex";
    const currentSpreadPct = bestBid !== undefined && bestAsk !== undefined && bestBid > 0 && bestAsk > 0
      ? spreadBps(bestBid, bestAsk) / 100
      : 0;
    const maxSpreadPct = this.cfg.maxSpreadBps / 100;

    // Spread & orderbook depth gate: sit out order execution if orderbook is one-sided or spread is dislocated
    if (bestBid === undefined || bestAsk === undefined || bestBid <= 0 || bestAsk <= 0 || mid === undefined || mid <= 0) {
      if (isDex && binancePrice && binancePrice > 0) {
        // On DreamDEX (on-chain AMM / CLOB), if orderbook is shallow or one-sided, we can safely fallback to CEX reference price
        isSpreadDislocated = false;
      } else {
        isSpreadDislocated = true;
        spreadDislocationReason = "one-sided or empty book";
      }
    } else {
      const currentSpreadBps = spreadBps(bestBid, bestAsk);

      if (currentSpreadBps > this.cfg.maxSpreadBps) {
        isSpreadDislocated = true;
        spreadDislocationReason = `Spread ${currentSpreadPct.toFixed(2)}% > Max Allowed ${maxSpreadPct.toFixed(2)}% (Bid: $${bestBid.toFixed(6)}, Ask: $${bestAsk.toFixed(6)})`;
      } else {
        const bidDiscountPct = ((mid - bestBid) / mid) * 100;
        if (bidDiscountPct > maxSpreadPct * 2) {
          isSpreadDislocated = true;
          spreadDislocationReason = `Bid $${bestBid.toFixed(6)} dislocated ${bidDiscountPct.toFixed(2)}% from Mid $${mid.toFixed(6)}`;
        }
      }
    }

    // Price Anchor: Anchor all Market Structure, Grid Zones, and Trendlines strictly to Binance Reference Price
    const refPrice = binancePrice ?? effectiveMid;
    this.lastRefPrice = refPrice;

    // 1. Evaluate order fills against current market price (Dry-Run Simulation only)
    if (this.cfg.dryRun && !isSpreadDislocated && bestBid !== undefined && bestAsk !== undefined) {
      await this.checkOrderFills(bestBid, bestAsk, refPrice);
    }

    // Market structure channel: 0% Floor, 50% Center, 100% Ceiling (Calculated from Binance price)
    const dow: DowStructure | undefined = this.dowEngine?.getStructure(refPrice, undefined, {
      mode: this.cfg.channelMode,
      minChannelWidthPct: this.cfg.minChannelWidthPct,
      maxChannelWidthPct: this.cfg.maxChannelWidthPct,
      atrMinMultiplier: this.cfg.atrMinMultiplier,
      atrMaxMultiplier: this.cfg.atrMaxMultiplier,
      donchianLookback: this.cfg.donchianLookback,
      floorBufferPct: this.cfg.floorBufferPct,
      atrPct: this.atrSource.atrPct?.(),
      useTrueWick: this.cfg.useTrueWick,
      wickThresholdPct: this.cfg.wickThresholdPct,
      srMinTouchCount: this.cfg.srMinTouchCount,
      srTouchTolerancePct: this.cfg.srTouchTolerancePct,
      srLookbackCandles: this.cfg.srLookbackCandles,
    });
    const gridZone = dow?.gridZone;

    const currentFloorBufferPct = this.cfg.floorBufferPct ?? 0.0;

    let lowerBound = dow?.bottomBound ?? refPrice * 0.98;
    let upperBound = dow?.upperBound ?? refPrice * 1.02;
    let centerPrice = dow?.centerPrice ?? (lowerBound + upperBound) / 2;
    const rawSpan = Math.max(0.000001, upperBound - lowerBound);

    let cutLossBound = dow?.cutLossBound ?? (lowerBound - (currentFloorBufferPct / 100) * lowerBound);
    let rawFloorPrice = dow?.activeValley?.price ?? lowerBound;

    let buyLevels: number[] = gridZone?.buyLevels && gridZone.buyLevels.length > 0
      ? gridZone.buyLevels
      : [lowerBound + rawSpan * 0.40, lowerBound + rawSpan * 0.30, lowerBound + rawSpan * 0.20, lowerBound + rawSpan * 0.10];

    let sellLevels: number[] = gridZone?.sellLevels && gridZone.sellLevels.length > 0
      ? gridZone.sellLevels
      : [lowerBound + rawSpan * 0.60, lowerBound + rawSpan * 0.70, lowerBound + rawSpan * 0.80, lowerBound + rawSpan * 0.90];

    // ── Position Dust Cleanup ──────────────────────────────────────────
    const totalHeldBase = this.baseHeld();
    const totalHeldUsdso = totalHeldBase * refPrice;
    const isDustPosition = totalHeldBase < this.minQty || totalHeldUsdso < 0.05;
    if (this.lots.length > 0 && isDustPosition) {
      this.log(
        `🧹 Auto-cleared residual dust position (${totalHeldBase.toFixed(4)} ${this.baseAsset} | $${totalHeldUsdso.toFixed(4)})`,
      );
      this.lots = [];
    }

    // ── Dynamic Channel Hysteresis & Position Lock ──────────────────────────
    const lockChannelInPosition = this.cfg.lockChannelInPosition !== false;
    const isHoldingPosition = totalHeldBase >= (this.minQty || 0.001) && !isDustPosition;

    const symbolKey = this.getSymbolKey();

    if ((this.lastDynamicBounds || this.lockedChannel) && lockChannelInPosition && isHoldingPosition) {
      if (!this.lastDynamicBounds && this.lockedChannel) {
        this.lastDynamicBounds = {
          lowerBound: this.lockedChannel.lowerBound,
          upperBound: this.lockedChannel.upperBound,
          centerPrice: this.lockedChannel.centerPrice,
          buyLevels: [...this.lockedChannel.buyLevels],
          sellLevels: [...this.lockedChannel.sellLevels],
        };
      }
      // 🔒 Position Lock (Option B: 100% Strict Freeze):
      // When holding inventory, freeze existing channel levels 100% solid to protect entry basis & targets.
      // Zero sliding down of lowerBound or upperBound!
      const avgEntry = this.getAvgEntryPrice();

      // Ensure upperBound stays above average entry price so sell targets remain profitable
      if (avgEntry > 0 && this.lastDynamicBounds.upperBound < avgEntry * 1.002) {
        const minProfitTarget = avgEntry * 1.01;
        const currentFloor = this.lastDynamicBounds.lowerBound;
        const newCeiling = Math.max(this.lastDynamicBounds.upperBound, minProfitTarget);
        if (newCeiling > this.lastDynamicBounds.upperBound) {
          this.log(`🔒 [LOCKED CHANNEL ENTRY SHIELD] Adjusted locked ceiling from $${this.lastDynamicBounds.upperBound.toFixed(6)} to $${newCeiling.toFixed(6)} (Entry: $${avgEntry.toFixed(6)})`);
          this.lastDynamicBounds.upperBound = newCeiling;
          this.lastDynamicBounds.centerPrice = (currentFloor + newCeiling) / 2;
          const dSpan = newCeiling - currentFloor;
          this.lastDynamicBounds.sellLevels = [
            currentFloor + dSpan * 0.60,
            currentFloor + dSpan * 0.70,
            currentFloor + dSpan * 0.80,
            currentFloor + dSpan * 0.90,
          ];
          this.lastDynamicBounds.buyLevels = [
            currentFloor + dSpan * 0.40,
            currentFloor + dSpan * 0.30,
            currentFloor + dSpan * 0.20,
            currentFloor + dSpan * 0.10,
          ];
        }
      }

      lowerBound = this.lastDynamicBounds.lowerBound;
      upperBound = this.lastDynamicBounds.upperBound;
      centerPrice = this.lastDynamicBounds.centerPrice;
      buyLevels = this.lastDynamicBounds.buyLevels;
      sellLevels = this.lastDynamicBounds.sellLevels;

      this.lockedChannel = {
        lowerBound,
        upperBound,
        centerPrice,
        buyLevels: [...buyLevels],
        sellLevels: [...sellLevels],
        rawFloorPrice,
        lockedAt: this.lockedChannel?.lockedAt || Date.now(),
      };
      this.db.saveLockedChannel(symbolKey, this.lockedChannel);
    } else {
      // Position is flat/closed: unlock channel so it can adapt to current price for the next accumulation cycle
      if (!isHoldingPosition && this.lockedChannel) {
        this.log(`🔓 [POSITION UNLOCKED] Position returned to 100% cash — channel unfrozen for fresh accumulation (${symbolKey})`);
        this.lockedChannel = undefined;
        this.db.saveLockedChannel(symbolKey, undefined);
      }

      const minShiftPct = (this.cfg.minChannelShiftPct ?? 1.0) / 100;
      // Do not retain previous bounds if a confirmed structural swing pivot or S/R cluster has changed to a new level!
      // NOTE: When holding a position, new support is ONLY accepted if it is LOWER, never higher!
      const hasNewSupportLevel = Boolean(
        dow?.supportCluster &&
        this.lastDynamicBounds &&
        (!isHoldingPosition
          ? Math.abs(dow.supportCluster.price - this.lastDynamicBounds.lowerBound) / this.lastDynamicBounds.lowerBound >= 0.002
          : dow.supportCluster.price < this.lastDynamicBounds.lowerBound * 0.998)
      );
      const hasNewResistanceLevel = Boolean(
        dow?.resistanceCluster &&
        this.lastDynamicBounds &&
        Math.abs(dow.resistanceCluster.price - this.lastDynamicBounds.upperBound) / this.lastDynamicBounds.upperBound >= 0.002
      );

      // 🔒 Ironclad Floor Protection while holding position:
      // When holding position, lowerBound must NEVER be raised above previous locked floor!
      if (isHoldingPosition && this.lastDynamicBounds && lowerBound > this.lastDynamicBounds.lowerBound) {
        lowerBound = this.lastDynamicBounds.lowerBound;
      }

      if (this.lastDynamicBounds && !hasNewSupportLevel && !hasNewResistanceLevel) {
        const lowerShift = Math.abs(lowerBound - this.lastDynamicBounds.lowerBound) / this.lastDynamicBounds.lowerBound;
        const upperShift = Math.abs(upperBound - this.lastDynamicBounds.upperBound) / this.lastDynamicBounds.upperBound;
        if (lowerShift < minShiftPct && upperShift < minShiftPct) {
          // Change is smaller than threshold -> retain previous channel levels to prevent churning orders & gas fees
          lowerBound = this.lastDynamicBounds.lowerBound;
          upperBound = this.lastDynamicBounds.upperBound;
          centerPrice = this.lastDynamicBounds.centerPrice;
          const dSpan = upperBound - lowerBound;
          if (!Array.isArray(this.lastDynamicBounds.buyLevels) || this.lastDynamicBounds.buyLevels.length < 4) {
            this.lastDynamicBounds.buyLevels = [
              lowerBound + dSpan * 0.40,
              lowerBound + dSpan * 0.30,
              lowerBound + dSpan * 0.20,
              lowerBound + dSpan * 0.10,
            ];
          }
          buyLevels = this.lastDynamicBounds.buyLevels;
          sellLevels = this.lastDynamicBounds.sellLevels;
        } else {
          this.lastDynamicBounds = { lowerBound, upperBound, centerPrice, buyLevels: [...buyLevels], sellLevels: [...sellLevels] };
        }
      } else {
        this.lastDynamicBounds = { lowerBound, upperBound, centerPrice, buyLevels: [...buyLevels], sellLevels: [...sellLevels] };
      }

      if (isHoldingPosition && lockChannelInPosition) {
        this.lockedChannel = {
          lowerBound,
          upperBound,
          centerPrice,
          buyLevels: [...buyLevels],
          sellLevels: [...sellLevels],
          rawFloorPrice,
          lockedAt: Date.now(),
        };
        this.db.saveLockedChannel(symbolKey, this.lockedChannel);
      }
    }

    // Dynamic Floor Buffer for cut loss trigger
    const bufferAmount = (currentFloorBufferPct / 100) * lowerBound;
    cutLossBound = lowerBound - bufferAmount;

    const span = Math.max(0.000001, upperBound - lowerBound);
    const positionPct = Math.max(-5, Math.min(105, ((refPrice - lowerBound) / span) * 100));



    const isChannelReady = dow?.gridZone !== undefined && lowerBound > 0 && upperBound > lowerBound;
    const isBelowFloor = isChannelReady && (refPrice < cutLossBound || (this.waitingForHigherLow && this.breakdownFloorPrice !== undefined && refPrice < this.breakdownFloorPrice));
    const isAboveCeiling = isChannelReady && refPrice >= upperBound;

    // ── Broken Floor Tracking & Recovery via:
    // 1. Reclaiming & standing above Buy Level 2 (30% Zone) for >= 1 candle bar
    // 2. Trendline Breakout (2-candle confirmation)
    // 3. Confirmed Higher Low (HL)
    const buyLevel2Price = buyLevels[1] ?? (lowerBound + span * 0.30);

    if (this.waitingForHigherLow) {
      if (this.breakdownLowPrice === undefined || refPrice < this.breakdownLowPrice) {
        this.breakdownLowPrice = refPrice;
        this.saveState();
      }

      const candles = this.dowEngine?.getCandles() ?? [];
      const lastClosedCandle = candles.length >= 2 ? candles[candles.length - 2] : undefined;
      const currentCandle = candles.length >= 1 ? candles[candles.length - 1] : undefined;

      // 1. Resolve via standing above Buy Level 2 (30% Zone) for at least 1 candle bar
      const isCandleStandingAboveBuy2 =
        (lastClosedCandle && lastClosedCandle.close >= buyLevel2Price * 0.9995 && refPrice >= buyLevel2Price * 0.999) ||
        (currentCandle && currentCandle.close >= buyLevel2Price && refPrice >= buyLevel2Price);

      if (this.cfg.enableBuyLevel2Recovery && isCandleStandingAboveBuy2) {
        this.log(
          `🚀 BUY LEVEL 2 RECOVERY CONFIRMED @ $${refPrice.toFixed(6)} (Stood above Buy Level 2 $${buyLevel2Price.toFixed(6)} | 30% Zone for at least 1 candle) — Floor breakdown resolved, resuming grid accumulation!`,
        );
        this.waitingForHigherLow = false;
        this.breakdownTime = undefined;
        this.breakdownFloorPrice = undefined;
        this.breakdownLowPrice = undefined;
        this.saveState();
      } else if (this.cfg.trendlineFilter && (dow?.downtrendBreakoutConfirmed || (dow?.downtrendLine && (dow.downtrendLine.isBroken || dow.downtrendLine.breakoutConfirmed)))) {
        // 2. Resolve via Trendline Breakout if TRENDLINE_FILTER is active (requires 2-candle confirmation)
        const brokenCount = dow.downtrendLine?.brokenCandleCount ?? 2;
        const linePriceStr = dow.downtrendLine ? `TL $${dow.downtrendLine.currentLinePrice.toFixed(6)}` : "downtrend line";
        this.log(
          `🚀 TRENDLINE BREAKOUT CONFIRMED (${brokenCount} candles) @ $${refPrice.toFixed(6)} (Broke above ${linePriceStr}) — Floor breakdown resolved via 2-candle breakout, resuming grid accumulation!`,
        );
        this.waitingForHigherLow = false;
        this.breakdownTime = undefined;
        this.breakdownFloorPrice = undefined;
        this.breakdownLowPrice = undefined;
        this.saveState();
      } else if (this.breakdownFloorPrice || this.breakdownLowPrice || lowerBound > 0) {
        // 3. Resolve via Confirmed Higher Low (HL)
        const checkTime = this.breakdownTime ?? (Math.floor(Date.now() / 1000) - 3600);
        const checkFloor = this.breakdownFloorPrice ?? lowerBound;
        const checkLow = this.breakdownLowPrice ?? (lowerBound * 0.98);

        const hlCheck =
          this.localTrendEngine?.checkForHigherLow(checkTime, checkFloor, checkLow, refPrice) ??
          this.dowEngine?.checkForHigherLow(checkTime, checkFloor, checkLow, refPrice);

        if (hlCheck && hlCheck.confirmed && hlCheck.higherLow) {
          this.log(
            `✅ HIGHER LOW (HL) CONFIRMED @ $${hlCheck.higherLow.price.toFixed(6)} (${hlCheck.reason}) — Floor breakdown resolved, establishing new floor & resuming grid accumulation!`,
          );
          this.waitingForHigherLow = false;
          this.breakdownTime = undefined;
          this.breakdownFloorPrice = undefined;
          this.breakdownLowPrice = undefined;
          this.saveState();
        } else if (
          isChannelReady &&
          this.breakdownFloorPrice !== undefined &&
          lowerBound >= this.breakdownFloorPrice * 0.998 &&
          refPrice >= this.breakdownFloorPrice * 1.002 &&
          (lastClosedCandle && lastClosedCandle.close >= this.breakdownFloorPrice)
        ) {
          // If price has cleanly re-entered and closed above the ORIGINAL broken floor
          // Note: If channel shifted DOWNWARDS after cut loss, it does NOT qualify as a reclaim! It MUST wait for Higher Low (HL)!
          this.log(
            `🚀 CHANNEL FLOOR RECLAIMED @ $${refPrice.toFixed(6)} >= Original Breakdown Floor $${this.breakdownFloorPrice.toFixed(6)} — Floor breakdown resolved, resuming normal grid operation!`,
          );
          this.waitingForHigherLow = false;
          this.breakdownTime = undefined;
          this.breakdownFloorPrice = undefined;
          this.breakdownLowPrice = undefined;
          this.saveState();
        }
      }
    }

    const inBuyZone = positionPct >= 18 && positionPct < 50 && !isBelowFloor && !this.waitingForHigherLow;
    const inSellZone = positionPct >= 50 && !isAboveCeiling;
    const offloadOnly = this.realizedPnl <= -this.cfg.maxSessionLossUsdso;

    // ── 0% LOWER BOUND: CUT LOSS / STOP LOSS ─────────────────────────────────
    // Cut loss ONLY when the Binance reference price breaks below the Cut-Loss Buffer!
    // SAFETY: Wait for confirmed candle period(s) below buffer before executing Cut Loss (default 1 candle).
    const requiredCutLossCandles = this.cfg.cutLossConfirmCandles ?? 1;

    if (
      this.cfg.cutLossAtLowerBound &&
      isBelowFloor
    ) {
      const isInitialBreakdown = !this.waitingForHigherLow;
      this.waitingForHigherLow = true;
      this.breakdownFloorPrice = this.breakdownFloorPrice ?? cutLossBound;
      this.breakdownTime = this.breakdownTime ?? Math.floor(Date.now() / 1000);
      this.breakdownLowPrice = this.breakdownLowPrice !== undefined ? Math.min(this.breakdownLowPrice, refPrice) : refPrice;

      // Track confirmed CLOSED candle bars whose CLOSE price is strictly below Cut-Loss Buffer
      // Intra-bar wicks (unclosed live candles) DO NOT count towards cut-loss confirmation.
      const closedCandles = this.dowEngine?.getClosedCandles() ?? [];
      let confirmedCandlesCount = 0;
      this.breakdownCandleTimes.clear();
      for (let i = closedCandles.length - 1; i >= 0; i--) {
        if (closedCandles[i].close < cutLossBound) {
          confirmedCandlesCount++;
          this.breakdownCandleTimes.add(closedCandles[i].time);
        } else {
          break; // unbroken streak of closed candles below buffer
        }
      }

      if (!this.isPaused && this.lots.length > 0) {
        const dexBid = bestBid ?? effectiveMid;
        const maxAllowedBidDiscount = this.cfg.cutLossMaxBidDiscountPct ?? 2.5;
        const bidDiscountPct = binancePrice && binancePrice > 0 ? ((binancePrice - dexBid) / binancePrice) * 100 : 0;
        const isBidTooDepressed = bidDiscountPct > maxAllowedBidDiscount;

        // Cancel resting buy orders immediately so we never buy more while below floor
        await this.cancelAllRestingOrders("BUY");

        if (isBidTooDepressed) {
          this.status(
            `⚠️ CUT LOSS PAUSED: Price broken below Cut-Loss Buffer ($${refPrice.toFixed(6)} < $${cutLossBound.toFixed(6)} | 0% Floor: $${lowerBound.toFixed(6)}) but DEX Bid $${dexBid.toFixed(6)} is discounted ${bidDiscountPct.toFixed(2)}% below Binance (Limit: ${maxAllowedBidDiscount.toFixed(1)}%) — Holding off fire-sale dump until DEX Bid liquidity normalizes.`,
          );
        } else if (confirmedCandlesCount < requiredCutLossCandles) {
          this.status(
            `⏳ CUT LOSS PENDING CONFIRMATION: Price $${refPrice.toFixed(6)} broke below Cut-Loss Buffer ($${cutLossBound.toFixed(6)} | 0% Floor: $${lowerBound.toFixed(6)}) — waiting for ${requiredCutLossCandles} confirmed CLOSED candle(s) (Current: ${confirmedCandlesCount}/${requiredCutLossCandles} closed bar${requiredCutLossCandles > 1 ? "s" : ""} with close < buffer)`,
          );
        } else {
          const lastClosed = closedCandles[closedCandles.length - 1];
          const lastClosedStr = lastClosed ? `Last Closed Bar: $${lastClosed.close.toFixed(6)} | ` : "";
          const exitActionDesc = this.openOrders.length > 0 ? "cancelling resting orders & executing clean exit" : "executing clean exit";
          this.log(
            `🚨 CUT LOSS TRIGGERED (${requiredCutLossCandles} CLOSED CANDLE${requiredCutLossCandles > 1 ? "S" : ""} CONFIRMED): ${lastClosedStr}Binance Price $${refPrice.toFixed(6)} (DEX Bid: $${dexBid.toFixed(6)} | Dislocation: ${bidDiscountPct >= 0 ? `-${bidDiscountPct.toFixed(2)}%` : `+${Math.abs(bidDiscountPct).toFixed(2)}%`}) confirmed ${confirmedCandlesCount} closed bar(s) below Cut-Loss Buffer ($${cutLossBound.toFixed(6)} | 0% Floor: $${lowerBound.toFixed(6)}) — ${exitActionDesc}`,
          );
          if (this.openOrders.length > 0) {
            await this.cancelAllRestingOrders();
          }
          await this.sellAll(dexBid, "CUT");
          this.stuckSince = undefined;
          this.breakdownCandleTimes.clear();
          this.saveState();
        }
      } else if (!this.isPaused && isInitialBreakdown) {
        // Price fell below floor while holding 0 lots: cancel any open resting buy orders to prevent buying a falling knife
        await this.cancelAllRestingOrders("BUY");
        this.saveState();
      }
    } else {
      // If price is back above floor, reset candle confirmation counter
      if (!this.waitingForHigherLow && this.breakdownCandleTimes.size > 0) {
        this.breakdownCandleTimes.clear();
      }
    }

    // ── 100% UPPER BOUND: 100% FULL TAKE PROFIT EXIT ─────────────────────────
    // Take profit when the Binance reference price reaches or crosses the 100% Ceiling!
    // SAFETY: Take Profit must NEVER sell at a loss! It must be strictly profitable above avgEntry.
    const avgEntryPrice = this.getAvgEntryPrice();
    const requireAvgProfit = (this.cfg.sellProfitMode || (this.cfg.requireProfitAboveAvgEntry ? "PORTFOLIO_AVG_PROFIT" : "GRID_CASHFLOW")) === "PORTFOLIO_AVG_PROFIT";
    const isProfitableExit = !requireAvgProfit || avgEntryPrice <= 0 || refPrice >= avgEntryPrice * 1.001;
    if (
      !this.isPaused &&
      this.cfg.takeProfitAtUpperBound &&
      this.lots.length > 0 &&
      isProfitableExit &&
      (isAboveCeiling || refPrice >= upperBound || (bestBid !== undefined && bestBid >= upperBound))
    ) {
      this.log(
        `🎯 100% TAKE PROFIT: Binance Price $${refPrice.toFixed(6)} reached 100% Upper Bound ($${upperBound.toFixed(6)}) with profit (Avg Entry: $${avgEntryPrice.toFixed(6)}) — cancelling resting orders & full exit`,
      );
      await this.cancelAllRestingOrders();
      await this.sellAll(bestBid ?? effectiveMid, "SELL");
      this.stuckSince = undefined;
      this.saveState();
    }

    // ── Target Holding % Rebalancing Model based on Ladder Zone ───────────────
    let targetHoldingFraction = 0;
    let activeLevelName = "";

    if (isBelowFloor || positionPct <= 0) {
      targetHoldingFraction = 0.0;
      activeLevelName = this.baseHeld() > 0 ? "0% Floor (Cut Loss)" : "0% Floor (Protected in Cash)";
    } else if (positionPct <= 10) {
      targetHoldingFraction = 1.0;
      activeLevelName = positionPct < 5 ? "Safe Buffer (0-5%)" : "10% Buy Level 4";
    } else if (positionPct <= 20) {
      targetHoldingFraction = 0.75;
      activeLevelName = "20% Buy Level 3";
    } else if (positionPct <= 30) {
      targetHoldingFraction = 0.50;
      activeLevelName = "30% Buy Level 2";
    } else if (positionPct <= 40) {
      targetHoldingFraction = 0.25;
      activeLevelName = "40% Buy Level 1";
    } else if (positionPct < 50) {
      targetHoldingFraction = 0.0;
      activeLevelName = "Accumulation Midline (40-50%)";
    } else if (positionPct <= 55) {
      targetHoldingFraction = 1.0;
      activeLevelName = "50% Center Midline (Hold 100%)";
    } else if (positionPct <= 65) {
      targetHoldingFraction = 0.75;
      activeLevelName = "60% Sell Target 1";
    } else if (positionPct <= 75) {
      targetHoldingFraction = 0.50;
      activeLevelName = "70% Sell Target 2";
    } else if (positionPct <= 85) {
      targetHoldingFraction = 0.25;
      activeLevelName = "80% Sell Target 3";
    } else if (positionPct < 100 && !isAboveCeiling) {
      targetHoldingFraction = 0.0;
      activeLevelName = "90% Sell Target 4";
    } else {
      targetHoldingFraction = 0.0;
      activeLevelName = "100% Ceiling (Exit All)";
    }

    const targetInventoryQuote = targetHoldingFraction * this.cfg.maxInventoryQuote;
    const targetInventoryUsdso = targetInventoryQuote;
    const currentBestBid = bestBid ?? effectiveMid;
    const currentBestAsk = bestAsk ?? effectiveMid;
    const inventoryQuote = this.baseHeld() * refPrice;
    const inventoryUsdso = inventoryQuote;
    const currentHoldPct = this.cfg.maxInventoryQuote > 0 ? (inventoryQuote / this.cfg.maxInventoryQuote) * 100 : 0;
    const avgEntry = this.getAvgEntryPrice();
    const unrealizedPnl = this.baseHeld() > 0 && avgEntry > 0 ? (refPrice - avgEntry) * this.baseHeld() : 0;

    // Active Buy Trigger in Buy Zone
    let buyTrigger: number;
    if (inventoryQuote < targetInventoryQuote - 1.0) {
      const activeZoneCeiling = buyLevels.find((lvl) => lvl >= refPrice * 0.9995) ?? buyLevels[0] ?? (lowerBound + span * 0.40);
      buyTrigger = activeZoneCeiling;
    } else {
      const nextBuyLevel = buyLevels.find((lvl) => lvl < refPrice * 0.999);
      buyTrigger = nextBuyLevel ?? (buyLevels[buyLevels.length - 1] ?? (lowerBound + span * 0.20));
    }

    let sellTrigger: number;
    const nextSellLevel = sellLevels.find((lvl) => lvl > refPrice * 1.0001);
    sellTrigger = nextSellLevel ?? sellLevels[sellLevels.length - 1] ?? (lowerBound + span * 0.90);

    // Grid spacing per zone step in %
    const gridStepPct = span > 0 && lowerBound > 0 ? ((span * 0.10) / lowerBound) * 100 : (this.stepBps / 100);
    this.stepBps = Math.round(gridStepPct * 100);

    // ── Cross-Exchange Laggard / Dislocation Detection (DreamDEX vs Binance) ──
    let dislocationPct = 0;
    let askDiscountPct = 0;
    let bidPremiumPct = 0;
    let isCheapAskOpportunity = false;
    let isHighBidOpportunity = false;
    let laggardState: "PARITY" | "CHEAP_ASK" | "HIGH_BID" | "LAGGING_OVERPRICED" | "LAGGING_UNDERPRICED" = "PARITY";

    if (binancePrice !== undefined && binancePrice > 0) {
      dislocationPct = mid !== undefined ? ((mid - binancePrice) / binancePrice) * 100 : 0;
      if (bestAsk !== undefined) {
        askDiscountPct = ((binancePrice - bestAsk) / binancePrice) * 100;
      }
      if (bestBid !== undefined) {
        bidPremiumPct = ((bestBid - binancePrice) / binancePrice) * 100;
      }

      isCheapAskOpportunity = askDiscountPct >= this.cfg.laggardThresholdPct;
      isHighBidOpportunity = bidPremiumPct >= this.cfg.laggardThresholdPct;

      if (isCheapAskOpportunity) {
        laggardState = "CHEAP_ASK";
      } else if (isHighBidOpportunity) {
        laggardState = "HIGH_BID";
      } else if (dislocationPct > this.cfg.laggardThresholdPct) {
        laggardState = "LAGGING_OVERPRICED";
      } else if (dislocationPct < -this.cfg.laggardThresholdPct) {
        laggardState = "LAGGING_UNDERPRICED";
      }
    }

    // Laggard Guard: Pause standard ladder accumulation if DreamDEX is significantly overpriced vs Binance during a drop
    const laggardGuardActive = this.cfg.enableLaggardGuard && dislocationPct > this.cfg.laggardThresholdPct * 1.5;

    // Local 15m Dow Theory trend filter (pauses buys only during active 15m drop)
    const localStructure = this.localTrendEngine?.getStructure(refPrice, undefined, {
      useTrueWick: this.cfg.useTrueWick,
      wickThresholdPct: this.cfg.wickThresholdPct,
      srLookbackCandles: this.cfg.srLookbackCandles,
    });
    const activeRegime = localStructure?.regime ?? dow?.regime ?? "WARMUP";
    const isDowntrend = activeRegime === "DOWNTREND";
    const trendFiltered = this.cfg.dowTrendFilter && isDowntrend;

    // Trendline Filter: Active during breakdown recovery until confirmed breakout occurs
    const downtrendLine = dow?.downtrendLine;
    const uptrendLine = dow?.uptrendLine;
    const trendlineFiltered = Boolean(this.cfg.trendlineFilter && this.waitingForHigherLow && downtrendLine && !downtrendLine.isBroken);
    const uptrendBroken = Boolean(
      (this.cfg.enableBuyAboveTrendSupport !== false) &&
      ((uptrendLine && (uptrendLine.isBroken || refPrice < uptrendLine.currentLinePrice)) ||
      dow?.uptrendBreakdownConfirmed)
    );

    // ── Trendline Sell Trigger Override ──────────────────────────────────────
    let isTlSellTrigger = false;
    let tlSellPrice: number | undefined;
    if (
      (this.cfg.enableSellBelowTrendResistance !== false) &&
      downtrendLine &&
      !downtrendLine.isBroken &&
      downtrendLine.currentLinePrice > refPrice
    ) {
      const tlPrice = downtrendLine.currentLinePrice;
      const levelsUnderTL = sellLevels.filter((lvl) => lvl < tlPrice);
      if (levelsUnderTL.length === 0 || tlPrice < sellTrigger) {
        sellTrigger = tlPrice;
        isTlSellTrigger = true;
        tlSellPrice = tlPrice;
      }
    }

    // ── Trendline Buy Trigger Override ───────────────────────────────────────
    let isTlBuyTrigger = false;
    let tlBuyPrice: number | undefined;
    if (
      (this.cfg.enableBuyAboveTrendSupport !== false) &&
      uptrendLine &&
      !uptrendLine.isBroken &&
      refPrice >= uptrendLine.currentLinePrice * 0.995
    ) {
      const tlPrice = uptrendLine.currentLinePrice;
      // If trendline support sits above standard buyTrigger (i.e. "ถ้าเลย buy target"),
      // the trendline becomes the active primary buy entry!
      if (tlPrice > buyTrigger) {
        buyTrigger = tlPrice;
        isTlBuyTrigger = true;
        tlBuyPrice = tlPrice;
      }
    }

    // ── Triangle Squeeze / Trendline Convergence Detection ────────────────────
    const enableSqueezeExit = this.cfg.enableTriangleSqueezeExit ?? true;
    const squeezeSpreadThreshold = this.cfg.triangleSqueezeSpreadPct ?? 1.0;
    const minTradeableWidth = this.cfg.minTradeableChannelWidthPct ?? this.cfg.minChannelWidthPct ?? 2.0;
    const currentChannelWidthPct = gridZone?.zoneWidthPct ?? (lowerBound > 0 ? ((upperBound - lowerBound) / lowerBound) * 100 : 0);

    let isConverging = false;
    let tlSpreadPct = Infinity;
    // Both lines must be present, active, unbroken (< 2 broken candles), and forming a valid corridor with Resistance > Support
    if (
      downtrendLine &&
      uptrendLine &&
      !downtrendLine.isBroken &&
      !uptrendLine.isBroken &&
      (downtrendLine.brokenCandleCount ?? 0) < 2 &&
      (uptrendLine.brokenCandleCount ?? 0) < 2
    ) {
      const tlResPrice = downtrendLine.currentLinePrice;
      const tlSupPrice = uptrendLine.currentLinePrice;
      // Valid triangle: resistance is strictly above support
      if (tlResPrice > tlSupPrice) {
        const tlSpread = tlResPrice - tlSupPrice;
        tlSpreadPct = refPrice > 0 ? (tlSpread / refPrice) * 100 : 0;
        // If spread narrows below threshold
        if (tlSpreadPct <= squeezeSpreadThreshold) {
          isConverging = true;
        }
      }
    }

    // 1. Trigger Squeeze Exit: Liquidate position to cash & enter squeeze standby
    if (!this.isPaused && enableSqueezeExit && isConverging && !this.isSqueezePaused) {
      this.isSqueezePaused = true;
      this.log(
        `🔺 [TRIANGLE SQUEEZE] Support ($${uptrendLine!.currentLinePrice.toFixed(6)}) & Resistance ($${downtrendLine!.currentLinePrice.toFixed(6)}) converging (Spread ${tlSpreadPct.toFixed(2)}% <= ${squeezeSpreadThreshold.toFixed(1)}%) — Liquidating all ${this.baseHeld().toFixed(4)} SOMI to cash and standing by for channel expansion!`,
      );
      await this.cancelAllRestingOrders(undefined, "Triangle squeeze: trendlines converging — liquidating and pausing");
      if (this.baseHeld() > 0 && !isBelowFloor) {
        await this.sellAll(refPrice, "SELL");
      }
      this.saveState();
    }

    // 2. Check Recovery / Re-entry from Squeeze Standby
    if (this.isSqueezePaused) {
      // Re-entry requires:
      // (a) Old squeeze is resolved: Breakout occurred OR trendlines no longer converging tightly
      // (b) Channel has expanded: currentChannelWidthPct >= minTradeableWidth
      // (c) Swing structure is confirmed: dow?.isSwingConfirmed !== false
      const breakoutOccurred = Boolean(
        dow?.downtrendBreakoutConfirmed ||
        dow?.uptrendBreakdownConfirmed ||
        downtrendLine?.isBroken ||
        uptrendLine?.isBroken ||
        !isConverging
      );
      const channelExpanded = currentChannelWidthPct >= minTradeableWidth;
      const isStructureConfirmed = dow?.isSwingConfirmed ?? true;

      if (breakoutOccurred && channelExpanded && isStructureConfirmed) {
        this.isSqueezePaused = false;
        this.log(
          `🟢 [TRIANGLE RESOLVED] Breakout confirmed & channel expanded to ${currentChannelWidthPct.toFixed(2)}% (>= ${minTradeableWidth.toFixed(1)}%) — resuming dynamic grid accumulation!`,
        );
        this.saveState();
      }
    }

    // ── Compute Bot Action State & Why Bot is Waiting ────────────────────────
    let botActionState: {
      code: string;
      title: string;
      reason: string;
      nextTrigger: string;
      severity: "success" | "warning" | "alert" | "info";
    };

    if (isBelowFloor) {
      if (this.baseHeld() > 0) {
        const candlesCount = this.breakdownCandleTimes.size;
        const requiredCandles = this.cfg.cutLossConfirmCandles ?? 1;
        botActionState = {
          code: "BELOW_FLOOR_CUTLOSS",
          title: candlesCount < requiredCandles ? "⏳ Cut Loss Confirming (Waiting Closed Bar)" : "🚨 Cut Loss Triggered",
          reason: `Price < 0% Floor ($${lowerBound.toFixed(4)}) • Holding $${inventoryQuote.toFixed(1)}`,
          nextTrigger: `Liquidating to ${this.quoteAsset} / Waiting Closed Bar (${candlesCount}/${requiredCandles} bar${requiredCandles > 1 ? "s" : ""})`,
          severity: "alert",
        };
      } else {
        botActionState = {
          code: "BELOW_FLOOR_PROTECTED",
          title: "🛡️ Capital Protected (Below Floor)",
          reason: `Price < 0% Floor ($${lowerBound.toFixed(4)}) • Holding $0.00 (100% Cash)`,
          nextTrigger: `Paused: Waiting Bottom / Higher Low > $${(this.breakdownLowPrice ?? refPrice).toFixed(4)}`,
          severity: "info",
        };
      }
    } else if (this.waitingForHigherLow) {
      const dumpFloor = this.breakdownFloorPrice ?? lowerBound;
      const dumpLow = this.breakdownLowPrice ?? effectiveMid;
      if (this.cfg.trendlineFilter && downtrendLine && !downtrendLine.isBroken) {
        const count = downtrendLine.brokenCandleCount;
        botActionState = {
          code: "WAITING_TRENDLINE_BREAKOUT",
          title: count === 1 ? "⏳ TL Breakout (1/2 bars)" : "📉 Under Trendline",
          reason: `Floor broke • Under TL ($${downtrendLine.currentLinePrice.toFixed(4)})${count === 1 ? " [1/2 bars breaking]" : ""}`,
          nextTrigger: count === 1
            ? `Wait 2nd candle confirm > $${downtrendLine.currentLinePrice.toFixed(4)}`
            : `Wait breakout > $${downtrendLine.currentLinePrice.toFixed(4)} or Stand above Buy 2 ($${buyLevel2Price.toFixed(4)})`,
          severity: "warning",
        };
      } else {
        botActionState = {
          code: "WAITING_HIGHER_LOW",
          title: "⏳ Wait Higher Low",
          reason: `Floor broke ($${dumpFloor.toFixed(4)})`,
          nextTrigger: `Wait HL > $${dumpLow.toFixed(4)} or Stand above Buy 2 ($${buyLevel2Price.toFixed(4)})`,
          severity: "warning",
        };
      }
    } else if (isAboveCeiling) {
      botActionState = {
        code: "ABOVE_CEILING_FULL_EXIT",
        title: "🚀 100% Ceiling",
        reason: `Take-profit reached ($${upperBound.toFixed(4)})`,
        nextTrigger: `Wait pullback < 90% ($${sellTrigger.toFixed(4)})`,
        severity: "info",
      };
    } else if (offloadOnly) {
      botActionState = {
        code: "OFFLOAD_ONLY",
        title: "🛑 Offload Only",
        reason: `Max session loss reached`,
        nextTrigger: `Selling open inventory only`,
        severity: "alert",
      };
    } else if (trendFiltered) {
      botActionState = {
        code: "DOWNTREND_FILTERED",
        title: "📉 Downtrend Guard",
        reason: `15m Downtrend active`,
        nextTrigger: `Wait trend reversal or Higher Low`,
        severity: "warning",
      };
    } else if (this.isSqueezePaused) {
      botActionState = {
        code: "TRIANGLE_SQUEEZE_STANDBY",
        title: "🔺 Triangle Squeeze Standby",
        reason: isConverging
          ? `Trendlines converging (Spread ${tlSpreadPct.toFixed(2)}% <= ${squeezeSpreadThreshold.toFixed(1)}%)`
          : `Channel width ${currentChannelWidthPct.toFixed(2)}% < ${minTradeableWidth.toFixed(1)}% tradeable threshold`,
        nextTrigger: `Waiting channel expansion >= ${minTradeableWidth.toFixed(1)}%`,
        severity: "warning",
      };
    } else if (isTlBuyTrigger && tlBuyPrice !== undefined) {
      botActionState = {
        code: "UPTREND_SUPPORT_ACTIVE",
        title: "📈 TL Support Buy Active",
        reason: `Price ($${refPrice.toFixed(4)}) near Support TL ($${tlBuyPrice.toFixed(4)}) • Ready to buy at trendline`,
        nextTrigger: `Buy @ Trendline ($${tlBuyPrice.toFixed(4)})`,
        severity: "info",
      };
    } else if (uptrendBroken) {
      const supPriceStr = uptrendLine ? `$${uptrendLine.currentLinePrice.toFixed(4)}` : "previous support TL";
      botActionState = {
        code: "UPTREND_SUPPORT_BROKEN",
        title: "🟢 Grid Buy (Below TL)",
        reason: `Price ($${refPrice.toFixed(4)}) < Support TL (${supPriceStr}) • Accumulating at grid levels based on held position`,
        nextTrigger: `Wait to buy at Buy Level $${buyTrigger.toFixed(4)}`,
        severity: "info",
      };
    } else if (trendlineFiltered && downtrendLine) {
      const count = downtrendLine.brokenCandleCount;
      botActionState = {
        code: "TRENDLINE_DESCENDING_ACTIVE",
        title: count === 1 ? "⏳ TL Breakout (1/2 bars)" : "📉 Under Trendline",
        reason: `Under TL ($${downtrendLine.currentLinePrice.toFixed(4)})${count === 1 ? " [1/2 bars breaking]" : ""}`,
        nextTrigger: count === 1
          ? `Wait 2nd candle confirm > $${downtrendLine.currentLinePrice.toFixed(4)}`
          : `Wait breakout > $${downtrendLine.currentLinePrice.toFixed(4)}`,
        severity: "warning",
      };
    } else if (laggardGuardActive) {
      botActionState = {
        code: "LAGGARD_GUARD_ACTIVE",
        title: "🛡️ Lag Guard",
        reason: `DEX +${dislocationPct.toFixed(1)}% > Binance`,
        nextTrigger: `Wait price basis normalization`,
        severity: "warning",
      };
    } else if (isCheapAskOpportunity) {
      botActionState = {
        code: "SNIPE_CHEAP_ASK",
        title: "⚡ Cheap Ask",
        reason: `DEX Ask ${askDiscountPct.toFixed(1)}% < Binance`,
        nextTrigger: `Executing snipe buy`,
        severity: "success",
      };
    } else if (isHighBidOpportunity && this.baseHeld() > 0) {
      botActionState = {
        code: "EXIT_HIGH_BID",
        title: "🔥 High Bid",
        reason: `DEX Bid +${bidPremiumPct.toFixed(1)}% > Binance`,
        nextTrigger: `Executing premium exit`,
        severity: "success",
      };
    } else if (inBuyZone) {
      const openBuys = this.openOrders.filter((o) => o.isBid);
      const isCapacityFull = currentHoldPct >= 95 || inventoryQuote >= this.cfg.maxInventoryQuote - 1.0;

      if (isCapacityFull) {
        botActionState = {
          code: "CAPACITY_FULL",
          title: `📦 Capacity Full (${currentHoldPct.toFixed(0)}%)`,
          reason: `Holding $${inventoryQuote.toFixed(1)} / $${this.cfg.maxInventoryQuote.toFixed(0)} • Buying full`,
          nextTrigger: isTlSellTrigger
            ? `IOC Sell @ Trendline ($${sellTrigger.toFixed(4)})`
            : `Sell target: >$${sellTrigger.toFixed(4)}`,
          severity: "info",
        };
      } else if (isTlSellTrigger && this.baseHeld() > 0 && openBuys.length === 0) {
        botActionState = {
          code: "WAITING_TRENDLINE_EXIT",
          title: "📉 Waiting TL Sell Exit",
          reason: `Sells paused below TL ($${sellTrigger.toFixed(4)}) • Holding $${inventoryQuote.toFixed(1)}`,
          nextTrigger: `IOC Sell when price touches TL ($${sellTrigger.toFixed(4)})`,
          severity: "info",
        };
      } else if (openBuys.length > 0) {
        botActionState = {
          code: "MAKER_BUY_RESTING",
          title: `📋 ${openBuys.length} Buys Resting`,
          reason: openBuys.map((o) => `$${o.price.toFixed(4)}`).join(", "),
          nextTrigger: `Fills on flash dip <$${buyTrigger.toFixed(4)} • Sell: >$${sellTrigger.toFixed(4)}`,
          severity: "success",
        };
      } else {
        botActionState = {
          code: "BUY_ZONE_TARGET_MET",
          title: "🎯 Level Target Met",
          reason: `Holding $${inventoryQuote.toFixed(1)} (Target $${targetInventoryQuote.toFixed(0)} for ${activeLevelName})`,
          nextTrigger: `Buy next dip: <$${buyTrigger.toFixed(4)} • Sell: >$${sellTrigger.toFixed(4)}`,
          severity: "info",
        };
      }
    } else {
      // In Sell Zone (50% - 100%)
      const openSells = this.openOrders.filter((o) => !o.isBid);
      const isCapacityFull = currentHoldPct >= 95 || inventoryQuote >= this.cfg.maxInventoryQuote - 1.0;

      if (openSells.length > 0) {
        botActionState = {
          code: "MAKER_SELL_RESTING",
          title: `💎 ${openSells.length} Sells Resting`,
          reason: openSells.map((o) => `$${o.price.toFixed(4)}`).join(", "),
          nextTrigger: `Fills on upside rally >$${sellTrigger.toFixed(4)}`,
          severity: "success",
        };
      } else if (isTlSellTrigger && this.baseHeld() > 0) {
        botActionState = {
          code: "WAITING_TRENDLINE_EXIT",
          title: "📉 Waiting TL Sell Exit",
          reason: `Sells suppressed by TL ($${sellTrigger.toFixed(4)}) • Holding $${inventoryQuote.toFixed(1)}`,
          nextTrigger: `IOC Sell when price touches TL ($${sellTrigger.toFixed(4)})`,
          severity: "info",
        };
      } else {
        botActionState = {
          code: isCapacityFull ? "CAPACITY_FULL" : "WAITING_FOR_DIP",
          title: isCapacityFull ? `📦 Capacity Full (${currentHoldPct.toFixed(0)}%)` : "⏸️ Waiting for Dip",
          reason: `Holding $${inventoryQuote.toFixed(1)} (Zone ${positionPct.toFixed(0)}%)`,
          nextTrigger: `Buy: <$${centerPrice.toFixed(4)} • Sell: >$${sellTrigger.toFixed(4)}`,
          severity: "info",
        };
      }
    }

    // Human-readable zone description
    const zoneName = isBelowFloor
      ? (this.baseHeld() > 0 ? "BELOW FLOOR (CUT LOSS ZONE)" : "BELOW FLOOR (CAPITAL PROTECTED • 100% CASH)")
      : this.waitingForHigherLow
        ? `BROKEN FLOOR (WAITING HIGHER LOW > $${(this.breakdownLowPrice ?? effectiveMid).toFixed(6)})`
        : isAboveCeiling
          ? "ABOVE CEILING (FULL EXIT ZONE)"
          : inBuyZone
            ? `Buy Zone (${positionPct.toFixed(1)}% | ${activeLevelName} | Target: ${(targetHoldingFraction * 100).toFixed(0)}%)`
            : `Sell Zone (${positionPct.toFixed(1)}% | ${activeLevelName} | Target: ${(targetHoldingFraction * 100).toFixed(0)}%)`;

    // Emit live telemetry to dashboard
    const telemetryData = {
      time: Date.now(),
      mid: effectiveMid,
        isPaused: this.isPaused,
        bestBid,
        bestAsk,
        binancePrice,
        dislocationPct,
        askDiscountPct,
        bidPremiumPct,
        isCheapAskOpportunity,
        isHighBidOpportunity,
        laggardState,
        laggardThresholdPct: this.cfg.laggardThresholdPct,
        enableLaggardSnipe: this.cfg.enableLaggardSnipe,
        enableLaggardGuard: this.cfg.enableLaggardGuard,
        laggardGuardActive,
        waitingForHigherLow: this.waitingForHigherLow,
        waitingForNewValley: this.waitingForHigherLow,
        breakdownFloorPrice: this.breakdownFloorPrice,
        breakdownLowPrice: this.breakdownLowPrice,
        botAction: botActionState,
        centerPrice,
        stepPct: this.stepBps / 100,
        spreadPct: currentSpreadPct,
        buyTrigger,
        sellTrigger,
        isTlSellTrigger,
        tlSellPrice,
        upperBound,
        bottomBound: lowerBound,
        cutLossBound,
        rawFloorPrice,
        floorBufferPct: currentFloorBufferPct,
        activeValleyPrice: dow?.activeValley?.price,
        activePeakPrice: dow?.activePeak?.price,
        positionPct,
        activeLevelName,
        targetHoldingPct: targetHoldingFraction * 100,
        targetInventoryQuote,
        targetInventoryUsdso: targetInventoryQuote,
        currentHoldPct,
        inventoryQuote,
        inventoryUsdso: inventoryQuote,
        baseHeld: this.baseHeld(),
        walletAddress: this.walletAddress,
        walletBaseBalance: this.walletBaseBalance,
        walletQuoteBalance: this.walletQuoteBalance,
        walletSomiBalance: this.walletBaseBalance,
        walletUsdsoBalance: this.walletQuoteBalance,
        tradingBaseBalance: Math.max(0, (this.walletBaseBalance + this.openOrders.filter((o) => !o.isBid).reduce((sum, o) => sum + (o.qty || 0), 0)) - this.getEffectiveGasReserveBase()),
        freeTradingBaseBalance: Math.max(0, this.walletBaseBalance - this.getEffectiveGasReserveBase()),
        tradingSomiBalance: Math.max(0, (this.walletBaseBalance + this.openOrders.filter((o) => !o.isBid).reduce((sum, o) => sum + (o.qty || 0), 0)) - this.getEffectiveGasReserveBase()),
        freeTradingSomiBalance: Math.max(0, this.walletBaseBalance - this.getEffectiveGasReserveBase()),
        gasReserveSomi: this.getEffectiveGasReserveBase(),
        minGasReserveSomi: this.getEffectiveGasReserveSomi(),
        walletBaseValueQuote: this.walletBaseBalance * refPrice,
        walletTotalValueQuote: (this.walletBaseBalance * refPrice) + this.walletQuoteBalance,
        walletSomiValueUsdso: this.walletBaseBalance * refPrice,
        walletTotalValueUsdso: (this.walletBaseBalance * refPrice) + this.walletQuoteBalance,
        avgEntryPrice: avgEntry,
        unrealizedPnl,
        realizedPnl: this.realizedPnl,
        tradeRealizedPnl: this.tradeRealizedPnl,
        totalGasDeductedBase: this.totalGasDeductedBase,
        totalGasDeductedQuote: this.totalGasDeductedQuote,
        totalGasDeductedSomi: this.totalGasDeductedBase,
        totalGasDeductedUsdso: this.totalGasDeductedQuote,
        accumulatedGasBase: this.accumulatedGasBase,
        accumulatedGasQuote: this.accumulatedGasQuote,
        accumulatedGasSomi: this.accumulatedGasBase,
        accumulatedGasUsdso: this.accumulatedGasQuote,
        totalGasSpentBase: this.totalGasSpentBase,
        totalGasSpentQuote: this.totalGasSpentQuote,
        totalGasSpentSomi: this.totalGasSpentBase,
        totalGasSpentUsdso: this.totalGasSpentQuote,
        totalTxCount: this.totalTxCount,
        netPnlQuote: this.realizedPnl,
        netPnlUsdso: this.realizedPnl,
        zoneType: gridZone?.zoneType ?? (inBuyZone ? "BUY_ZONE" : "SELL_ZONE"),
        buyOrdersActive: this.buyOrdersActive,
        sellOrdersActive: this.sellOrdersActive,
        buyLevels: buyLevels,
        sellLevels: sellLevels,
        openOrders: this.openOrders.map((o) => ({
          id: o.id,
          onChainOrderId: o.onChainOrderId,
          isBid: o.isBid,
          price: o.price,
          qty: o.qty,
          notional: o.notionalQuote !== undefined ? o.notionalQuote : o.notionalUsdso,
          notionalQuote: o.notionalQuote !== undefined ? o.notionalQuote : o.notionalUsdso,
          notionalUsdso: o.notionalUsdso,
          levelDesc: o.levelDesc,
          placedTime: o.placedTime,
          expireTime: o.expireTime,
        })),
        isBelowFloor,
        isAboveCeiling,
        zoneWidthPct: gridZone?.zoneWidthPct ?? 0,
        channelMode: this.cfg.channelMode,
        clampStatus: gridZone?.clampStatus ?? "NATURAL_SWING",
        rawWidthPct: gridZone?.rawWidthPct,
        minWidthPct: gridZone?.minWidthPct,
        maxWidthPct: gridZone?.maxWidthPct,
        anchorSide: gridZone?.anchorSide ?? "NONE",
        resistanceTouchCount: gridZone?.resistanceTouchCount,
        supportTouchCount: gridZone?.supportTouchCount,
        resistanceCluster: (() => {
          if (!dow?.resistanceCluster) return undefined;
          // If active upperBound matches dow.resistanceCluster price within tolerance (0.5%)
          if (Math.abs(dow.resistanceCluster.price - upperBound) / upperBound <= 0.005) {
            const validPts = (dow.resistanceCluster.points || []).filter(
              (p) => Math.abs(p.price - upperBound) / upperBound <= 0.0025,
            );
            return {
              price: upperBound,
              touchCount: validPts.length > 0 ? validPts.length : dow.resistanceCluster.touchCount,
              points: (validPts.length > 0 ? validPts : dow.resistanceCluster.points || []).map((p) => ({
                time: p.time,
                price: p.price,
                index: p.index,
                type: p.type,
              })),
            };
          }
          // If upperBound was locked in position or adapted, find cluster or point matching upperBound
          const matchCluster = dow.allResistanceClusters?.find(
            (c) => Math.abs(c.price - upperBound) / upperBound <= 0.005,
          );
          if (matchCluster) {
            const validPts = (matchCluster.points || []).filter(
              (p) => Math.abs(p.price - upperBound) / upperBound <= 0.0025,
            );
            return {
              price: upperBound,
              touchCount: validPts.length > 0 ? validPts.length : matchCluster.touchCount,
              points: (validPts.length > 0 ? validPts : matchCluster.points).map((p) => ({ time: p.time, price: p.price, index: p.index, type: p.type })),
            };
          }
          const matchHigh = dow.waveCycle?.annotatedSwings?.find(
            (s) => s.type === "HIGH" && Math.abs(s.price - upperBound) / upperBound <= 0.005,
          );
          if (matchHigh) {
            return {
              price: upperBound,
              touchCount: 1,
              points: [{ time: matchHigh.time, price: matchHigh.price, index: matchHigh.index, type: matchHigh.type }],
            };
          }
          const validPoints = (dow.resistanceCluster.points || []).filter(
            (p) => Math.abs(p.price - upperBound) / upperBound <= 0.0025,
          );
          if (validPoints.length > 0) {
            return {
              price: upperBound,
              touchCount: validPoints.length,
              points: validPoints.map((p) => ({ time: p.time, price: p.price, index: p.index, type: p.type })),
            };
          }
          return undefined;
        })(),
        supportCluster: (() => {
          if (!dow?.supportCluster) return undefined;
          if (Math.abs(dow.supportCluster.price - lowerBound) / lowerBound <= 0.005) {
            const validPts = (dow.supportCluster.points || []).filter(
              (p) => Math.abs(p.price - lowerBound) / lowerBound <= 0.0025,
            );
            return {
              price: lowerBound,
              touchCount: validPts.length > 0 ? validPts.length : dow.supportCluster.touchCount,
              points: (validPts.length > 0 ? validPts : dow.supportCluster.points || []).map((p) => ({
                time: p.time,
                price: p.price,
                index: p.index,
                type: p.type,
              })),
            };
          }
          const matchCluster = dow.allSupportClusters?.find(
            (c) => Math.abs(c.price - lowerBound) / lowerBound <= 0.005,
          );
          if (matchCluster) {
            const validPts = (matchCluster.points || []).filter(
              (p) => Math.abs(p.price - lowerBound) / lowerBound <= 0.0025,
            );
            return {
              price: lowerBound,
              touchCount: validPts.length > 0 ? validPts.length : matchCluster.touchCount,
              points: (validPts.length > 0 ? validPts : matchCluster.points).map((p) => ({ time: p.time, price: p.price, index: p.index, type: p.type })),
            };
          }
          const matchLow = dow.waveCycle?.annotatedSwings?.find(
            (s) => s.type === "LOW" && Math.abs(s.price - lowerBound) / lowerBound <= 0.005,
          );
          if (matchLow) {
            return {
              price: lowerBound,
              touchCount: 1,
              points: [{ time: matchLow.time, price: matchLow.price, index: matchLow.index, type: matchLow.type }],
            };
          }
          const validPoints = (dow.supportCluster.points || []).filter(
            (p) => Math.abs(p.price - lowerBound) / lowerBound <= 0.005,
          );
          if (validPoints.length > 0) {
            return {
              price: lowerBound,
              touchCount: validPoints.length,
              points: validPoints.map((p) => ({ time: p.time, price: p.price, index: p.index, type: p.type })),
            };
          }
          return undefined;
        })(),
        allResistanceClusters: (dow?.allResistanceClusters || []).map((c) => ({
          price: c.price,
          touchCount: c.touchCount,
          points: (c.points || []).map((p) => ({ time: p.time, price: p.price, index: p.index, type: p.type })),
        })),
        allSupportClusters: (dow?.allSupportClusters || []).map((c) => ({
          price: c.price,
          touchCount: c.touchCount,
          points: (c.points || []).map((p) => ({ time: p.time, price: p.price, index: p.index, type: p.type })),
        })),
        isChannelLocked: Boolean(isHoldingPosition && lockChannelInPosition && this.lockedChannel),
        liveCalculatedUpperBound: dow?.gridZone?.upperBound ?? dow?.upperBound,
        liveCalculatedBottomBound: dow?.gridZone?.bottomBound ?? dow?.bottomBound,
        liveResistanceCluster: dow?.resistanceCluster ? {
          price: dow.resistanceCluster.price,
          touchCount: dow.resistanceCluster.touchCount,
          points: (dow.resistanceCluster.points || [])
            .filter((p) => Math.abs(p.price - dow.resistanceCluster!.price) / dow.resistanceCluster!.price <= 0.0025)
            .map((p) => ({ time: p.time, price: p.price, index: p.index, type: p.type })),
        } : undefined,
        liveSupportCluster: dow?.supportCluster ? {
          price: dow.supportCluster.price,
          touchCount: dow.supportCluster.touchCount,
          points: (dow.supportCluster.points || [])
            .filter((p) => Math.abs(p.price - dow.supportCluster!.price) / dow.supportCluster!.price <= 0.0025)
            .map((p) => ({ time: p.time, price: p.price, index: p.index, type: p.type })),
        } : undefined,
        regime: activeRegime,
        isSwingConfirmed: dow?.isSwingConfirmed ?? false,
        maxInventoryQuote: this.cfg.maxInventoryQuote,
        maxInventoryUsdso: this.cfg.maxInventoryQuote,
        intervalMs: this.cfg.intervalMs ?? 2000,
        stuckSince: this.stuckSince,
        stuckTimeoutMs: this.cfg.stuckTimeoutMs,
        lots: this.lots.map((l) => ({ price: l.price, qty: l.qty, time: l.time })),
        offloadOnly,
        trendFiltered,
        trendlineFilter: this.cfg.trendlineFilter,
        trendlineFiltered,
        enableBuyLevel2Recovery: this.cfg.enableBuyLevel2Recovery,
        downtrendLine: downtrendLine ? {
          type: downtrendLine.type,
          slope: downtrendLine.slope,
          currentLinePrice: downtrendLine.currentLinePrice,
          isBroken: downtrendLine.isBroken,
          breakoutPct: downtrendLine.breakoutPct,
          brokenCandleCount: downtrendLine.brokenCandleCount,
          breakoutConfirmed: downtrendLine.breakoutConfirmed,
          points: downtrendLine.points,
          p1: { time: downtrendLine.p1.time, price: downtrendLine.p1.price },
          p2: { time: downtrendLine.p2.time, price: downtrendLine.p2.price },
        } : undefined,
        uptrendLine: uptrendLine ? {
          type: uptrendLine.type,
          slope: uptrendLine.slope,
          currentLinePrice: uptrendLine.currentLinePrice,
          isBroken: uptrendLine.isBroken,
          breakoutPct: uptrendLine.breakoutPct,
          brokenCandleCount: uptrendLine.brokenCandleCount,
          breakoutConfirmed: uptrendLine.breakoutConfirmed,
          points: uptrendLine.points,
          p1: { time: uptrendLine.p1.time, price: uptrendLine.p1.price },
          p2: { time: uptrendLine.p2.time, price: uptrendLine.p2.price },
        } : undefined,
        symbol: this.symbol,
        exchange: this.binance.exchangeName,
        binanceSymbol: this.cfg.binanceSymbol,
        baseAsset: this.symbolInfo.baseAsset,
        quoteAsset: this.symbolInfo.quoteAsset,
        dowTimeframe: this.cfg.dowTimeframe,
        tradingTimeframe: this.cfg.tradingTimeframe,
        trendTimeframe: this.cfg.trendTimeframe,
        activePeak: dow?.activePeak ? { time: dow.activePeak.time, price: dow.activePeak.price } : undefined,
        activeValley: dow?.activeValley ? { time: dow.activeValley.time, price: dow.activeValley.price } : undefined,
        candidatePeak: dow?.candidatePeak
          ? {
              time: dow.candidatePeak.time,
              price: dow.candidatePeak.price,
              confirmationCandles: dow.candidatePeak.confirmationCandles,
              requiredCandles: dow.candidatePeak.requiredCandles,
            }
          : undefined,
        candidateValley: dow?.candidateValley
          ? {
              time: dow.candidateValley.time,
              price: dow.candidateValley.price,
              confirmationCandles: dow.candidateValley.confirmationCandles,
              requiredCandles: dow.candidateValley.requiredCandles,
            }
          : undefined,
        swingHighs: (dow?.swingHighs ?? []).map((s) => ({ time: s.time, price: s.price, type: s.type })),
        swingLows: (dow?.swingLows ?? []).map((s) => ({ time: s.time, price: s.price, type: s.type })),
        waveCycle: dow?.waveCycle,
      };
    this.lastTelemetryData = telemetryData;
    this.emit({
      type: "tick",
      data: telemetryData,
    });

    const stuckRemainingMin =
      this.stuckSince && this.cfg.stuckTimeoutMs > 0
        ? Math.max(0, Math.round((this.cfg.stuckTimeoutMs - (Date.now() - this.stuckSince)) / 60_000))
        : undefined;

    // Human-readable status line in % target holding terms
    const positionSummary = this.baseHeld() > 0
      ? `$${inventoryQuote.toFixed(2)}/$${this.cfg.maxInventoryQuote} (${currentHoldPct.toFixed(0)}% Held | Avg: $${avgEntry.toFixed(6)})`
      : `$0.00/$${this.cfg.maxInventoryQuote} (0% Held)`;

    const openOrdersSummary = this.cfg.orderExecutionMode === "IOC_BRACKET"
      ? " | Mode: ⚡ IOC (Zero resting orders)"
      : this.openOrders.length > 0
        ? ` | Open Orders: ${this.openOrders.filter((o) => o.isBid).length} Buys, ${this.openOrders.filter((o) => !o.isBid).length} Sells`
        : "";

    const laggardSummary = binancePrice
      ? ` | CEX: $${binancePrice.toFixed(6)} (${dislocationPct >= 0 ? "+" : ""}${dislocationPct.toFixed(2)}%${isCheapAskOpportunity ? " 🔥 Cheap Ask!" : isHighBidOpportunity ? " ⚡ Premium Bid!" : ""})`
      : "";

    const candidateSummary = [
      dow?.candidatePeak
        ? `[⛰️ Cand. Peak: $${dow.candidatePeak.price.toFixed(6)} (${dow.candidatePeak.confirmationCandles}/${dow.candidatePeak.requiredCandles})]`
        : "",
      dow?.candidateValley
        ? `[🌊 Cand. Valley: $${dow.candidateValley.price.toFixed(6)} (${dow.candidateValley.confirmationCandles}/${dow.candidateValley.requiredCandles})]`
        : "",
    ]
      .filter(Boolean)
      .join(" ");

    const trendlineSummary = downtrendLine
      ? ` | TL Res: $${downtrendLine.currentLinePrice.toFixed(6)} (${downtrendLine.isBroken ? `Broken 🟢 (${downtrendLine.brokenCandleCount} bars)` : downtrendLine.brokenCandleCount > 0 ? `Break 1/2 bars ⏳` : "Active 🔴"})`
      : "";
    const uptrendSummary = uptrendLine
      ? ` | TL Supp: $${uptrendLine.currentLinePrice.toFixed(6)} (${uptrendLine.isBroken ? `Broken 🔴 (${uptrendLine.brokenCandleCount} bars)` : uptrendLine.brokenCandleCount > 0 ? `Break 1/2 bars ⏳` : "Active 🟢"})`
      : "";

    if (now - this.lastHudLogTime >= this.hudLogIntervalMs) {
      this.lastHudLogTime = now;
      this.log(
        `Price: $${effectiveMid.toFixed(6)} | Channel: [$${lowerBound.toFixed(6)} .. $${upperBound.toFixed(6)}] ` +
          `| Zone: ${zoneName} | Position: ${positionSummary}${openOrdersSummary}` +
          ` | Wallet: ${this.walletBaseBalance.toFixed(2)} ${this.baseAsset} / $${this.walletQuoteBalance.toFixed(2)} ${this.quoteAsset}` +
          ` | Speed: ${((this.cfg.intervalMs ?? 2000) / 1000).toFixed(1)}s` +
          ` | Next Buy: $${buyTrigger.toFixed(6)}${this.waitingForHigherLow ? ` [Paused: Wait Higher Low > $${(this.breakdownLowPrice ?? effectiveMid).toFixed(6)}]` : !inBuyZone ? " [Wait <50%]" : ""}${trendFiltered ? " [Paused: Downtrend]" : ""}${trendlineFiltered && downtrendLine ? ` [Paused: Under TL $${downtrendLine.currentLinePrice.toFixed(6)}]` : ""}${uptrendBroken && uptrendLine ? ` [Below TL Support $${uptrendLine.currentLinePrice.toFixed(6)} → Grid Buy]` : ""}${this.isSqueezePaused ? " [Paused: Triangle Squeeze Standby]" : ""}${laggardGuardActive ? " [Paused: Lag Guard]" : ""}` +
          ` | Next Sell: $${sellTrigger.toFixed(6)}` +
          trendlineSummary +
          uptrendSummary +
          (tlSpreadPct !== Infinity ? ` | TL Squeeze: ${tlSpreadPct.toFixed(2)}%` : "") +
          laggardSummary +
          (candidateSummary ? ` | ${candidateSummary}` : "") +
          (stuckRemainingMin !== undefined ? ` (Hold timeout in ${stuckRemainingMin}m)` : "") +
          ` | Realized PnL: ${this.realizedPnl >= 0 ? "+$" : "-$"}${Math.abs(this.realizedPnl).toFixed(2)}` +
          (offloadOnly ? " | Stop-loss reached: Offload only" : "") +
          (this.isPaused ? " | ⏸️ [PAUSED - MONITORING ONLY]" : ""),
      );
    }

    // ── Trading Gate: When strategy is paused or spread is dislocated, all order placements, cancellations, and exits are strictly suspended ──
    if (this.isPaused || isSpreadDislocated) {
      if (isSpreadDislocated && !this.isPaused) {
        this.status(`${spreadDislocationReason} — sitting out order execution`);
      }
      return;
    }

    // ── 2a. Trendline IOC Exit: If price is ABOVE the active downtrend trendline, sell immediately ──
    // ราคาปัจจุบันสูงกว่าเส้นกดแล้ว → ขาย IOC ทันทีที่ราคา trendline แทนการรอ resting order
    // NOTE: Do NOT gate on isBroken — isBroken is only for buy-side breakout detection.
    //       For sell-side, the TL always governs placement regardless of temporary breakouts.
    if ((this.cfg.enableSellBelowTrendResistance !== false) && downtrendLine) {
      const tlPrice = downtrendLine.currentLinePrice;
      const tlState = downtrendLine.isBroken
        ? `BROKEN (${downtrendLine.brokenCandleCount} bars above)`
        : downtrendLine.brokenCandleCount > 0
        ? `Break 1/2 bars`
        : "Active 🔴";
      // Debug log every ~30s (avoid spamming every tick)
      const debugCooldownKey = "tl_debug_log";
      const lastDebug = this.orderCooldowns.get(debugCooldownKey) ?? 0;
      if (Date.now() - lastDebug > 30_000) {
        this.orderCooldowns.set(debugCooldownKey, Date.now());
        this.log(
          `📉 [TL DEBUG] TL @ $${tlPrice.toFixed(6)} | State: ${tlState} | Price: $${refPrice.toFixed(6)} | ${refPrice > tlPrice ? "ABOVE TL → IOC candidate" : "Below TL → resting orders below TL"}`,
        );
      }

      if (this.baseHeld() > 0 && !isBelowFloor) {
        const priceAboveTL = refPrice > tlPrice;
        if (priceAboveTL) {
          const iocCooldownKey = `tl_ioc_sell`;
          const lastIocTime = this.orderCooldowns.get(iocCooldownKey) ?? 0;
          const iocCooldownMs = 30_000; // 30-second cooldown to prevent rapid re-triggers
          if (Date.now() - lastIocTime > iocCooldownMs) {
            this.orderCooldowns.set(iocCooldownKey, Date.now());
            this.log(
              `📉 [TL IOC] Price $${refPrice.toFixed(6)} > TL $${tlPrice.toFixed(6)} (${tlState}) — executing IOC sell at TL price for all ${this.baseHeld().toFixed(4)} ${this.baseAsset}`,
            );
            await this.cancelAllRestingOrders(undefined, "Trendline IOC sell: cancelling resting orders before IOC execution");
            await this.sellAll(tlPrice, "SELL");
          }
        }
      }
    }

    // ── 2b. Sync Maker / Resting Limit Orders for Buy and Sell Levels ─────────
    const sellLevel1Price = sellLevels[0] ?? (lowerBound + span * 0.60);
    const buyLevel1Price = buyLevels[0] ?? (lowerBound + span * 0.40);

    // Rule: Hysteresis for Buy Orders / IOC Buy Trigger
    // On Binance (CEX): No gas or fee concerns, orders remain active continuously across the grid.
    // On DreamDEX (DEX): Apply hysteresis to reduce on-chain gas churn.
    const isCexExchange = this.binance.exchangeName === "binance";
    const buyActionTerm = this.cfg.orderExecutionMode === "IOC_BRACKET" ? "IOC buy trigger" : "buy orders";
    if (!isCexExchange && this.cfg.enableBuyBelowSellLevel1 !== false) {
      if (this.buyOrdersActive && (positionPct > 60.5 || refPrice > sellLevel1Price * 1.001)) {
        this.buyOrdersActive = false;
        this.log(`🛑 Price ($${refPrice.toFixed(6)} | ${positionPct.toFixed(1)}%) above Sell Level 1 ($${sellLevel1Price.toFixed(6)}) — pausing ${buyActionTerm} to prevent churn in upper profit zone`);
        this.saveState();
      } else if (!this.buyOrdersActive && (positionPct <= 60.0 || refPrice <= sellLevel1Price)) {
        this.buyOrdersActive = true;
        this.needsBuyRebalance = true;
        this.log(`🟢 Price ($${refPrice.toFixed(6)} | ${positionPct.toFixed(1)}%) returned below Sell Level 1 ($${sellLevel1Price.toFixed(6)}) — reactivating ${buyActionTerm}`);
        this.saveState();
      }
    } else {
      this.buyOrdersActive = true;
    }

    // Rule: Hysteresis for Sell Orders / IOC Sell Trigger
    const sellActionTerm = this.cfg.orderExecutionMode === "IOC_BRACKET" ? "IOC sell trigger" : "resting sell orders";
    if (!isCexExchange && this.cfg.enableSellAboveBuyLevel1 !== false) {
      if (this.sellOrdersActive && (positionPct < 39.5 || refPrice < buyLevel1Price * 0.999)) {
        this.sellOrdersActive = false;
        this.log(`🛑 Price ($${refPrice.toFixed(6)} | ${positionPct.toFixed(1)}%) below Buy Level 1 ($${buyLevel1Price.toFixed(6)}) — pausing ${sellActionTerm} to prevent churn in lower accumulation zone`);
        this.saveState();
      } else if (!this.sellOrdersActive && (positionPct >= 40.0 || refPrice >= buyLevel1Price)) {
        this.sellOrdersActive = true;
        this.needsSellRebalance = true;
        this.log(`🟢 Price ($${refPrice.toFixed(6)} | ${positionPct.toFixed(1)}%) returned above Buy Level 1 ($${buyLevel1Price.toFixed(6)}) — reactivating ${sellActionTerm}`);
        this.saveState();
      }
    } else {
      this.sellOrdersActive = true;
    }

    const canBuy = !offloadOnly && !trendFiltered && !trendlineFiltered && !this.isSqueezePaused && !laggardGuardActive && !this.waitingForHigherLow && !isBelowFloor && this.buyOrdersActive;

    if (this.cfg.orderExecutionMode === "IOC_BRACKET") {
      await this.executeIocBracketGrid(
        buyLevels,
        sellLevels,
        lowerBound,
        upperBound,
        span,
        positionPct,
        inBuyZone,
        canBuy,
        currentBestAsk,
        currentBestBid,
        refPrice,
        downtrendLine ?? undefined,
        uptrendLine ?? undefined,
        uptrendBroken,
      );
    } else {
      await this.syncRestingOrders(
        buyLevels,
        sellLevels,
        lowerBound,
        upperBound,
        span,
        positionPct,
        inBuyZone,
        canBuy,
        currentBestAsk,
        currentBestBid,
        refPrice,
        downtrendLine ?? undefined,
        uptrendLine ?? undefined,
        uptrendBroken,
      );
    }

    // ── STUCK TIMEOUT: unhit position after configured timeout ────────────────
    if (this.lots.length > 0 && this.cfg.stuckTimeoutMs > 0 && bestBid !== undefined) {
      const now = Date.now();
      this.stuckSince ??= now;
      if (now - this.stuckSince >= this.cfg.stuckTimeoutMs) {
        this.log(
          `hold timeout reached (${Math.round((now - this.stuckSince) / 60_000)}m) — unwinding inventory at bid $${bestBid.toFixed(6)}`,
        );
        await this.cancelAllRestingOrders();
        await this.sellAll(bestBid, "CUT");
        this.stuckSince = undefined;
      }
    } else if (this.lots.length === 0) {
      this.stuckSince = undefined;
    }
  }

  /**
   * Shared helper: Process a confirmed BUY fill (gas compensation, lot creation, emit, log)
   */
  private processBuyFill(opts: {
    price: number;
    qty: number;
    levelDesc: string;
    orderId?: string;
    txHash?: string;
    logPrefix?: string;
    dryRun: boolean;
    isIoc?: boolean;
  }): void {
    const { price, qty, levelDesc, orderId, txHash, logPrefix = "", dryRun, isIoc = false } = opts;
    const fillNotional = price * qty;
    const now = Date.now();

    // ── Instant Gas/Fee Compensation & Binance Spot Trading Fee ───────────────
    // On Binance Spot:
    // If quote is FDUSD and Maker order: 0.0% fee
    // Otherwise standard taker/maker spot fee (default 0.075% with BNB or 0.1% without)
    const isZeroFeeMaker = this.quoteAsset.toUpperCase() === "FDUSD" && !isIoc;
    const spotFeeRate = isZeroFeeMaker ? 0.0 : (this.cfg.dryRun ? 0.0 : 0.00075);
    const spotTradingFeeBase = qty * spotFeeRate;

    let compBase = 0;
    let gasLossQuote = 0;
    const uncompensatedGas = Math.max(this.accumulatedGasBase, this.totalGasSpentBase - this.totalGasDeductedBase);
    if (uncompensatedGas > 0) {
      const maxComp = Math.max(0, qty * 0.5);
      compBase = Math.min(uncompensatedGas, maxComp);
      if (compBase > 0) {
        gasLossQuote = compBase * price;
        this.accumulatedGasBase = Math.max(0, this.accumulatedGasBase - compBase);
        this.accumulatedGasQuote = Math.max(0, this.accumulatedGasQuote - gasLossQuote);
        this.totalGasDeductedBase += compBase;
        this.totalGasDeductedQuote += gasLossQuote;
        this.realizedPnl = this.tradeRealizedPnl - this.totalGasDeductedQuote;
      }
    }
    const rawNetQty = Math.max(0, qty - compBase - spotTradingFeeBase);
    // Align lot qty with exchange stepSize and precision (4 decimals for ETH)
    const netQty = roundToStep(rawNetQty, this.stepSize || 0.0001, 4);
    this.lots.push({ price, qty: netQty, time: now });
    this.needsSellRebalance = true;
    // Reset IOC Bracket Sell Cycle whenever a buy order fills to re-partition lots with new baseline
    this.iocBracketSellCycle = undefined;

    const feeLog = spotTradingFeeBase > 0
      ? ` | 🏷️ Spot Fee: ${spotTradingFeeBase.toFixed(6)} ${this.baseAsset}`
      : isZeroFeeMaker
      ? " | 🎁 0% Maker Fee (FDUSD)"
      : "";
    const gasCompLog = compBase > 0
      ? ` | ⛽ Fee Compensated: ${compBase.toFixed(4)} ${this.baseAsset} (-$${gasLossQuote.toFixed(4)}) returned to wallet`
      : "";
    const fillLabel = isIoc ? "IOC BUY FILLED" : "MAKER BUY FILLED";
    this.log(
      `⚡ ${logPrefix}${fillLabel}: ${qty.toFixed(4)} ${this.baseAsset} ($${fillNotional.toFixed(2)} ${this.quoteAsset}) @ $${price.toFixed(6)} • ${levelDesc}${orderId ? ` #${orderId}` : ""}${gasCompLog}`,
    );
    this.emit({
      type: "order",
      data: {
        action: "BUY_FILL",
        price,
        qty,
        netQty,
        gasCompBase: compBase,
        gasCompSomi: compBase,
        gasLossQuote,
        gasLossUsdso: gasLossQuote,
        notional: fillNotional,
        notionalQuote: fillNotional,
        notionalUsdso: fillNotional,
        levelDesc,
        orderId,
        txHash,
        reason: isIoc
          ? `IOC Fill${compBase > 0 ? ` (Comp: ${compBase.toFixed(4)} ${this.baseAsset})` : ""}`
          : `Maker Buy Filled${orderId ? ` #${orderId}` : ""}${compBase > 0 ? ` (Comp: ${compBase.toFixed(4)} ${this.baseAsset})` : ""}`,
        time: now,
        dryRun,
        maker: !isIoc,
      },
    });
  }

  /**
   * Shared helper: Process a confirmed SELL fill (close lots, PnL calc, emit, log)
   */
  private processSellFill(opts: {
    price: number;
    qty: number;
    levelDesc: string;
    orderId?: string;
    txHash?: string;
    logPrefix?: string;
    dryRun: boolean;
  }): void {
    const { price, qty, levelDesc, orderId, txHash, logPrefix = "", dryRun } = opts;
    const fillNotional = price * qty;
    const now = Date.now();

    const oldTradePnl = this.tradeRealizedPnl;
    this.closeLots(qty, price);
    const roundPnl = this.tradeRealizedPnl - oldTradePnl;
    this.needsBuyRebalance = true;

    this.log(
      `🔥 ${logPrefix}MAKER SELL FILLED: ${qty.toFixed(4)} ${this.baseAsset} ($${fillNotional.toFixed(2)} ${this.quoteAsset}) @ $${price.toFixed(6)} • ${levelDesc}${orderId ? ` #${orderId}` : ""} (Trade PnL: ${roundPnl >= 0 ? "+$" : "-$"}${Math.abs(roundPnl).toFixed(4)} | Net Total: ${this.realizedPnl >= 0 ? "+$" : "-$"}${Math.abs(this.realizedPnl).toFixed(4)})`,
    );
    this.emit({
      type: "order",
      data: {
        action: "SELL_FILL",
        price,
        qty,
        notional: fillNotional,
        notionalQuote: fillNotional,
        notionalUsdso: fillNotional,
        levelDesc,
        orderId,
        txHash,
        pnl: roundPnl,
        pnlQuote: roundPnl,
        pnlUsdso: roundPnl,
        reason: `Maker Sell Filled${orderId ? ` #${orderId}` : ""}`,
        time: now,
        dryRun,
        maker: true,
      },
    });
    this.stuckSince = undefined;
  }

  /**
   * Evaluate fills on active resting limit orders against real-time market price and candle range
   */
  private async checkOrderFills(bestBid: number, bestAsk: number, mid: number): Promise<void> {
    const remainingOpenOrders: OpenOrder[] = [];
    const binancePrice = this.atrSource.getLatestPrice?.();
    const candles = this.dowEngine?.getCandles() ?? [];
    const latestCandle = candles.length > 0 ? candles[candles.length - 1] : undefined;
    const candleLow = latestCandle ? latestCandle.low : mid;
    const candleHigh = latestCandle ? latestCandle.high : mid;

    for (const order of this.openOrders) {
      if (order.isBid) {
        // BUY limit order fills when market price or candle wick drops down to touch or cross order.price
        const effectiveLowPrice = binancePrice !== undefined ? Math.min(mid, binancePrice, candleLow) : Math.min(mid, candleLow);
        const isFilled = (bestAsk !== undefined && bestAsk <= order.price) || (effectiveLowPrice <= order.price);
        if (isFilled) {
          this.processBuyFill({
            price: order.price,
            qty: order.qty,
            levelDesc: `${order.levelDesc} (${(order.targetFraction * 100).toFixed(0)}% Target)`,
            dryRun: this.cfg.dryRun,
          });
          continue;
        }
      } else {
        // SELL limit order fills when market price or candle wick rises up to touch or cross order.price
        const effectiveHighPrice = binancePrice !== undefined ? Math.max(mid, binancePrice, candleHigh) : Math.max(mid, candleHigh);
        const isFilled = (bestBid !== undefined && bestBid >= order.price) || (effectiveHighPrice >= order.price);
        if (isFilled && this.baseHeld() > 0) {
          const isFullClose = order.targetFraction === 0 || order.qty >= this.baseHeld() * 0.98;
          const fillQty = isFullClose ? this.baseHeld() : Math.min(order.qty, this.baseHeld());
          this.processSellFill({
            price: order.price,
            qty: fillQty,
            levelDesc: `${order.levelDesc} (${(order.targetFraction * 100).toFixed(0)}% Target)`,
            dryRun: this.cfg.dryRun,
          });
          continue;
        }
      }
      remainingOpenOrders.push(order);
    }

    if (remainingOpenOrders.length !== this.openOrders.length) {
      this.openOrders = remainingOpenOrders;
      this.saveState();
    }
  }

  /**
   * Synchronize active resting Maker limit orders according to current Channel grid levels
   */
  private async syncRestingOrders(
    buyLevels: number[],
    sellLevels: number[],
    lowerBound: number,
    upperBound: number,
    span: number,
    positionPct: number,
    inBuyZone: boolean,
    canBuy: boolean,
    currentBestAsk: number,
    currentBestBid: number,
    refPrice: number,
    activeDowntrendLine?: import("./market-structure.js").TrendLine,
    activeUptrendLine?: import("./market-structure.js").TrendLine,
    uptrendBroken?: boolean,
  ): Promise<void> {
    const currentHeldQuote = this.baseHeld() * refPrice;
    const currentHeldUsdso = currentHeldQuote;
    const maxInv = this.cfg.maxInventoryQuote;
    const isCexExchange = this.binance.exchangeName === "binance";

    const priceTol = (this.cfg.orderPriceTolerancePct ?? 0.8) / 100;
    const qtyTol = (this.cfg.orderQtyTolerancePct ?? 20) / 100;

    // ── 1. Maintain Resting Buy Limit Orders ──────────────────────────────────
    const isBelowFloor = refPrice < lowerBound;
    if (isBelowFloor) {
      const openBuys = this.openOrders.filter((o) => o.isBid);
      if (openBuys.length > 0) {
        await this.cancelAllRestingOrders("BUY", "Price dropped below floor / Cut loss active");
      }
    } else if (!canBuy) {
      // If buying is disallowed (e.g. Wait Higher Low, Downtrend, Trendline Guard, Broken Trend Support, Lag Guard, Offload Only),
      // cancel all active resting buys on-chain immediately to prevent unexpected fills!
      const openBuys = this.openOrders.filter((o) => o.isBid);
      if (openBuys.length > 0) {
        const sellLevel1Price = sellLevels[0] ?? (lowerBound + span * 0.60);
        const pauseReason = !this.buyOrdersActive
          ? `Price ($${refPrice.toFixed(6)} | ${positionPct.toFixed(1)}%) above Sell Level 1 ($${sellLevel1Price.toFixed(6)}) — buying paused to prevent churn in upper profit zone`
          : uptrendBroken
          ? `Trend support broken ($${activeUptrendLine?.currentLinePrice.toFixed(6)}) — buying paused, waiting to sell or cut loss`
          : this.waitingForHigherLow
          ? "Waiting for Higher Low — cancelled resting buy orders"
          : "Buying paused by filters (Downtrend/Trendline/Lag Guard/Offload)";
        await this.cancelAllRestingOrders("BUY", pauseReason);
      }
    } else {
      const isSingleBuyLevel = buyLevels.length === 1;
      const levelNames = isSingleBuyLevel
        ? ["Buy Edge Floor (+0.2%)"]
        : ["Buy Level 1 (40%)", "Buy Level 2 (30%)", "Buy Level 3 (20%)", "Buy Level 4 (10%)"];

      // Check if Uptrend Support Line is active and sits above standard buy targets ("ถ้าเลย buy target")
      const isTlAboveBuyTarget = Boolean(
        (this.cfg.enableBuyAboveTrendSupport !== false) &&
        activeUptrendLine &&
        !activeUptrendLine.isBroken &&
        refPrice >= activeUptrendLine.currentLinePrice * 0.995 &&
        activeUptrendLine.currentLinePrice > (buyLevels[0] ?? 0)
      );

      const effectiveBuyLevels = [...buyLevels];
      const effectiveLevelNames = [...levelNames];

      if (isTlAboveBuyTarget && activeUptrendLine) {
        // If trendline sits above standard buy targets, float top buy level to trendline support price
        effectiveBuyLevels[0] = activeUptrendLine.currentLinePrice;
        effectiveLevelNames[0] = `Buy TL Support ($${activeUptrendLine.currentLinePrice.toFixed(4)})`;
      }

      const buyTargets = isSingleBuyLevel
        ? [1.0]
        : [0.25, 0.50, 0.75, 1.0];

      // Clean up stale resting buy orders or correct mislabeled levelDesc to closest buyLevel
      const remainingStaleBuys: OpenOrder[] = [];
      for (const o of this.openOrders) {
        if (!o.isBid) continue;

        // Find the closest buy level by price
        let closestIdx = -1;
        let minDiff = Infinity;
        for (let idx = 0; idx < effectiveBuyLevels.length; idx++) {
          const lvl = effectiveBuyLevels[idx];
          if (lvl) {
            const diff = Math.abs(lvl - o.price) / o.price;
            if (diff < minDiff) {
              minDiff = diff;
              closestIdx = idx;
            }
          }
        }

        if (closestIdx >= 0 && minDiff <= 0.0015) {
          const expectedName = effectiveLevelNames[closestIdx];
          if (o.levelDesc !== expectedName) {
            const oldName = o.levelDesc || "unlabeled";
            o.levelDesc = expectedName;
            o.targetFraction = buyTargets[closestIdx] || 1.0;
            this.log(`🔗 [sync] Re-linked resting BUY order #${o.onChainOrderId || o.id} (${oldName} -> ${o.levelDesc}) @ $${o.price.toFixed(6)}`);
          }
        } else if (!o.levelDesc || !effectiveLevelNames.includes(o.levelDesc)) {
          remainingStaleBuys.push(o);
        }
      }

      if (remainingStaleBuys.length > 0) {
        for (const o of remainingStaleBuys) {
          await this.cancelOrderInternal(o, "Channel shifted / Level no longer in buy zone");
        }
        this.openOrders = this.openOrders.filter((o) => !remainingStaleBuys.includes(o));
        this.saveState();
      }

      // Maintain resting Buy Limit orders at Eligible Buy Levels with automatic rebalancing
      const maxAllowedBuyPrice = Math.min(currentBestBid, refPrice);

      // Rebalance Buy side: track available capacity across all buy levels
      const openBuys = this.openOrders.filter((o) => o.isBid);
      const currentAvailableCapacity = Math.max(0, maxInv - currentHeldQuote);
      const currentHoldFraction = maxInv > 0 ? (currentHeldQuote / maxInv) : 0;
      const minOrderNotional = Math.max(this.minNotional || 5.0, 5.0);

      // Determine which buy levels are actually eligible for placing/holding orders
      // (not suppressed by Holding Fraction Guard, Trendline filter, or above current bid)
      const eligibleBuyIndices = effectiveBuyLevels
        .map((lvl, idx) => ({ lvl, idx }))
        .filter(({ lvl, idx }) => {
          if (!lvl) return false;
          // Holding Fraction Guard
          const lvlTargetFraction = buyTargets[idx] ?? ((idx + 1) / (effectiveBuyLevels.length || 4));
          if (currentHoldFraction >= (lvlTargetFraction - 0.05) && idx < effectiveBuyLevels.length - 1) {
            return false;
          }
          // Downtrend Trendline filter
          if (activeDowntrendLine && !activeDowntrendLine.isBroken && lvl >= activeDowntrendLine.currentLinePrice) {
            return false;
          }
          // Uptrend Support filter
          if (this.cfg.enableBuyAboveTrendSupport !== false && isTlAboveBuyTarget && idx > 0 && activeUptrendLine && lvl < activeUptrendLine.currentLinePrice * 0.995) {
            return false;
          }
          return true;
        })
        .map(({ idx }) => idx);

      const numBuyLevels = effectiveBuyLevels.length || 4;
      const numEligibleBuyLevels = eligibleBuyIndices.length > 0 ? eligibleBuyIndices.length : numBuyLevels;
      // Dynamic equal tranche sizing across remaining eligible levels (no static / 4 dilution!)
      let rawTrancheQuote = numEligibleBuyLevels > 0 ? (currentAvailableCapacity / numEligibleBuyLevels) : 0;
      // If dividing evenly drops below minNotional ($5.00), consolidate capacity to satisfy exchange minNotional
      if (rawTrancheQuote < minOrderNotional && currentAvailableCapacity >= minOrderNotional) {
        rawTrancheQuote = Math.min(currentAvailableCapacity, minOrderNotional);
      }
      const trancheQuote = rawTrancheQuote;
      const trancheUsdso = trancheQuote;
      const doBuyRebalance = this.needsBuyRebalance;
      this.needsBuyRebalance = false;

      if (!canBuy) {
        if (openBuys.length > 0) {
          const reason = !this.buyOrdersActive
            ? "Price above Sell Level 1 (> 60%) — cancelling buy orders to avoid churn in profit zone"
            : "Buying paused by strategy filters";
          for (const o of openBuys) {
            await this.cancelOrderInternal(o, reason);
          }
          this.openOrders = this.openOrders.filter((o) => !openBuys.includes(o));
          this.saveState();
        }
      } else {
        // If capacity is full (held inventory >= maxInv), cancel resting buy orders
        if (currentAvailableCapacity < (this.minQty * (refPrice || 0.2))) {
          if (openBuys.length > 0) {
            for (const o of openBuys) {
              await this.cancelOrderInternal(o, "Inventory capacity full — canceling resting buy orders");
            }
            this.openOrders = this.openOrders.filter((o) => !openBuys.includes(o));
            this.saveState();
          }
        }

        // If open buys exceed the number of active buy levels, only trim orders that are unmapped or excess
        const activeLevelNamesSet = new Set(effectiveLevelNames.slice(0, numBuyLevels));
        const unmappedBuys = openBuys.filter((o) => !o.levelDesc || !activeLevelNamesSet.has(o.levelDesc));
        if (unmappedBuys.length > 0) {
          for (const o of unmappedBuys) {
            await this.cancelOrderInternal(o, "Excess buy orders beyond grid levels — removing unmapped");
          }
          this.openOrders = this.openOrders.filter((o) => !unmappedBuys.includes(o));
          this.saveState();
        } else if (openBuys.length > numBuyLevels) {
          const excessCount = openBuys.length - numBuyLevels;
          // Sort descending by price to trim from highest
          const excessBuys = [...openBuys].sort((a, b) => b.price - a.price).slice(0, excessCount);
          for (const o of excessBuys) {
            await this.cancelOrderInternal(o, "Excess buy orders beyond grid levels — removing");
          }
          this.openOrders = this.openOrders.filter((o) => !excessBuys.includes(o));
          this.saveState();
        }

        for (let i = 0; i < effectiveBuyLevels.length; i++) {
          const lvlPrice = effectiveBuyLevels[i];
          if (!lvlPrice) continue;

          // ── Downtrend Trendline Buy Filter ────────────────────────────────────
          // When a descending trendline (เส้นกด) is active, only place buy orders
          // at levels strictly BELOW the trendline. Buying at or above TL is buying
          // into resistance — cancel any existing order there and skip.
          if (activeDowntrendLine && !activeDowntrendLine.isBroken && lvlPrice >= activeDowntrendLine.currentLinePrice) {
            const existingBuyAboveTL = this.openOrders.find(
              (o) => o.isBid && (o.levelDesc === effectiveLevelNames[i] || (!o.levelDesc && Math.abs(o.price - lvlPrice) / lvlPrice <= 0.001)),
            );
            if (existingBuyAboveTL) {
              await this.cancelOrderInternal(
                existingBuyAboveTL,
                `Trendline resistance filter: buy @ $${existingBuyAboveTL.price.toFixed(6)} >= TL $${activeDowntrendLine.currentLinePrice.toFixed(6)} — suppressed`,
              );
              this.openOrders = this.openOrders.filter((o) => o !== existingBuyAboveTL);
              this.saveState();
            }
            continue;
          }

          // ── Uptrend Support Buy Filter ────────────────────────────────────────
          // When an ascending trend support line (เส้นรับ / เส้นหนุน) is active:
          // If price is above trendline and TL sits above grid targets (isTlAboveBuyTarget),
          // Level 0 is placed at the trendline (effectiveBuyLevels[0]).
          // Lower levels (i > 0) are suppressed while price rides above the trendline.
          // IF price breaks below the trendline ("ถ้าหลุดไป"), we DO NOT suppress:
          // the bot immediately places buy orders at grid levels based on held inventory.
          if (
            this.cfg.enableBuyAboveTrendSupport !== false &&
            isTlAboveBuyTarget &&
            i > 0 &&
            activeUptrendLine &&
            lvlPrice < activeUptrendLine.currentLinePrice * 0.995
          ) {
            const existingBuyBelowTL = this.openOrders.find(
              (o) => o.isBid && (o.levelDesc === effectiveLevelNames[i] || (!o.levelDesc && Math.abs(o.price - lvlPrice) / lvlPrice <= 0.001)),
            );
            if (existingBuyBelowTL) {
              await this.cancelOrderInternal(
                existingBuyBelowTL,
                `Trend support filter: buy @ $${existingBuyBelowTL.price.toFixed(6)} < Support TL $${activeUptrendLine.currentLinePrice.toFixed(6)} — suppressed while above TL`,
              );
              this.openOrders = this.openOrders.filter((o) => o !== existingBuyBelowTL);
              this.saveState();
            }
            continue;
          }
          // ─────────────────────────────────────────────────────────────────────

          // Strictly match by level name to prevent adjacent grid levels from stealing/cancelling each other's orders
          const currentOpenBuyAtLvl = this.openOrders.find(
            (o) => o.isBid && (o.levelDesc === effectiveLevelNames[i] || (!o.levelDesc && Math.abs(o.price - lvlPrice) / lvlPrice <= 0.001)),
          );

          if (currentOpenBuyAtLvl) {
            // Preserve resting buy order! Only re-align price if channel shifted significantly OR if rebalancing to equal 4-level tranche
            const priceDiffRatio = Math.abs(currentOpenBuyAtLvl.price - lvlPrice) / lvlPrice;
            const priceTolerance = priceTol;
            const currentOrderNotional = currentOpenBuyAtLvl.notionalQuote !== undefined ? currentOpenBuyAtLvl.notionalQuote : currentOpenBuyAtLvl.notionalUsdso;
            const notionalDiffRatio = Math.abs(currentOrderNotional - trancheQuote) / Math.max(0.01, trancheQuote);
            // Rebalance tranche if explicitly requested (sell filled, startup, resume) OR if deviation is large (>15%) when orders are incomplete
            const needsResize = (doBuyRebalance || (notionalDiffRatio > 0.15 && openBuys.length < numBuyLevels)) && notionalDiffRatio > 0.05;

            if (priceDiffRatio > priceTolerance || needsResize) {
              const reason = priceDiffRatio > priceTolerance
                ? `Channel shifted: aligning buy price ($${currentOpenBuyAtLvl.price.toFixed(6)} -> $${lvlPrice.toFixed(6)})`
                : `Rebalancing buy quantity to equal 4-level tranche ($${currentOrderNotional.toFixed(2)} -> $${trancheQuote.toFixed(2)})`;
              await this.cancelOrderInternal(currentOpenBuyAtLvl, reason);
              this.openOrders = this.openOrders.filter((o) => o !== currentOpenBuyAtLvl);

              // Equal tranche sizing for replaced order
              const maxPossibleBudget = this.cfg.dryRun
                ? trancheQuote
                : Math.min(trancheQuote, this.walletQuoteBalance + currentOrderNotional);
              const effectiveBuyQty = maxPossibleBudget / lvlPrice;
              if (effectiveBuyQty >= this.minQty) {
                await this.placeRestingOrder(
                  true,
                  lvlPrice,
                  effectiveBuyQty,
                  buyTargets[i] || 1.0,
                  maxPossibleBudget,
                  effectiveLevelNames[i] || `Buy Level ${i + 1}`,
                );
              }
            }
            // Preserve resting buy order on book without churning quantity!
            continue;
          }

          // ── Holding Fraction Guard (No Repeating Buy Fills on already filled levels) ──
          // In a 4-level accumulation ladder, each level represents a target holding threshold:
          // Level 1: up to 25% (buyTargets[0] = 0.25)
          // Level 2: up to 50% (buyTargets[1] = 0.50)
          // Level 3: up to 75% (buyTargets[2] = 0.75)
          // Level 4: up to 100% (buyTargets[3] = 1.00)
          // If current portfolio holding already satisfies or exceeds this level's target fraction,
          // do NOT re-place a buy order at this level while holding that inventory!
          // (Only allow subsequent lower levels, or wait until inventory is sold).
          const currentHoldFraction = maxInv > 0 ? (currentHeldQuote / maxInv) : 0;
          const levelTargetFraction = buyTargets[i] ?? ((i + 1) / numBuyLevels);
          if (currentHoldFraction >= (levelTargetFraction - 0.05) && i < effectiveBuyLevels.length - 1) {
            continue;
          }

          const isEligibleForNewOrder = lvlPrice < maxAllowedBuyPrice && canBuy;
          if (isEligibleForNewOrder && trancheQuote > 0) {
            // Place new equal tranche buy order (proportional 4-level average of remaining capacity)
            const availableBudget = this.cfg.dryRun
              ? trancheQuote
              : Math.min(trancheQuote, currentAvailableCapacity, this.walletQuoteBalance);
            const desiredBuyQty = availableBudget / lvlPrice;
            if (desiredBuyQty >= this.minQty) {
              await this.placeRestingOrder(
                true,
                lvlPrice,
                desiredBuyQty,
                buyTargets[i] || 1.0,
                availableBudget,
                effectiveLevelNames[i] || `Buy Level ${i + 1}`,
              );
            }
          }
        }
      }
    }

    // ── 2. Maintain Resting Sell Limit Orders when holding inventory ──────────
    const minReserveBase = this.getEffectiveGasReserveBase();
    const totalBaseInOpenSellsInit = this.openOrders.filter((o) => !o.isBid).reduce((sum, o) => sum + (o.qty || 0), 0);
    const totalTradingCapacity = Math.max(0, (this.walletBaseBalance + totalBaseInOpenSellsInit) - minReserveBase);
    const held = this.cfg.dryRun ? this.baseHeld() : Math.min(this.baseHeld(), totalTradingCapacity);
    const isDustPosition = held < this.minQty || currentHeldQuote < 0.05;

    // Rule: Legacy Fallback Hysteresis Band (only if enableSellAboveBuyLevel1 is false, and on DEX only)
    if (!isCexExchange && this.cfg.enableSellAboveBuyLevel1 === false) {
      const isBelowSafetyBuffer = positionPct < 5;
      const isAtOrAboveBuyRecovery = positionPct >= 15;
      const candles = this.dowEngine?.getCandles() ?? [];
      const currentCandle = candles.length > 0 ? candles[candles.length - 1] : undefined;
      const currentCandleTime = currentCandle ? currentCandle.time : Math.floor(Date.now() / (5 * 60 * 1000));

      if (this.sellOrdersActive) {
        if (isBelowSafetyBuffer) {
          if (this.sellZoneTransitionCandleTime === undefined) {
            this.sellZoneTransitionCandleTime = currentCandleTime;
            this.status(
              `⏳ Sell orders pause pending: 1 bar confirmation below 5% Safe Buffer ($${refPrice.toFixed(6)} | ${positionPct.toFixed(1)}% < 5%)`,
            );
          } else if (currentCandleTime !== this.sellZoneTransitionCandleTime) {
            this.sellOrdersActive = false;
            this.sellZoneTransitionCandleTime = undefined;
            this.log(
              `🛑 Safe Buffer breach confirmed (1 candle < 5% @ $${refPrice.toFixed(6)}) — cancelling resting sell orders to free inventory`,
            );
            const openSells = this.openOrders.filter((o) => !o.isBid);
            if (openSells.length > 0) {
              await this.cancelAllRestingOrders("SELL", "Below 5% Safe Buffer confirmed (1 candle) — cancelling sell orders");
            }
            this.saveState();
          }
        } else {
          this.sellZoneTransitionCandleTime = undefined;
        }
      } else {
        if (isAtOrAboveBuyRecovery) {
          if (this.sellZoneTransitionCandleTime === undefined) {
            this.sellZoneTransitionCandleTime = currentCandleTime;
            this.status(
              `⏳ Sell orders reactivation pending: 1 bar confirmation at Buy Level 3+ ($${refPrice.toFixed(6)} | ${positionPct.toFixed(1)}% >= 15%)`,
            );
          } else if (currentCandleTime !== this.sellZoneTransitionCandleTime) {
            this.sellOrdersActive = true;
            this.sellZoneTransitionCandleTime = undefined;
            this.log(
              `🟢 Buy Level 3+ confirmed (1 candle >= 15% @ $${refPrice.toFixed(6)}) — reactivating resting sell orders`,
            );
            this.saveState();
          }
        } else {
          this.sellZoneTransitionCandleTime = undefined;
        }
      }
    }

    if (isDustPosition) {
      const openSells = this.openOrders.filter((o) => !o.isBid);
      if (openSells.length > 0) {
        await this.cancelAllRestingOrders("SELL", "Inventory empty or dust only (no base to sell)");
      }
      if (this.lots.length > 0) {
        this.lots = [];
        this.saveState();
      }
    } else if (!this.sellOrdersActive) {
      // Sell orders are paused/deactivated while below Buy Level 1 (< 40%)
      const openSells = this.openOrders.filter((o) => !o.isBid);
      if (openSells.length > 0) {
        await this.cancelAllRestingOrders("SELL", "Price below Buy Level 1 (< 40%) — cancelling sell orders to avoid churn while accumulating");
      }
    } else {
      const isSingleSellLevel = sellLevels.length === 1;
      const sellNames = isSingleSellLevel
        ? ["Sell Edge Ceil (-0.2%)"]
        : ["Sell Target 1 (60%)", "Sell Target 2 (70%)", "Sell Target 3 (80%)", "Sell Target 4 (90%)"];

      // ── Downtrend Trendline Sell Override ──────────────────────────────────────
      // When an active descending trendline (เส้นกด) is present (not broken), only sell at targets that are
      // BELOW the trendline. If no target is below the trendline, wait for IOC sell at TL price.
      // NOTE: In IOC_BRACKET mode, we never place resting maker orders at the trendline — we let IOC triggers execute instead.
      const isIocMode = this.cfg.orderExecutionMode === "IOC_BRACKET";
      if ((this.cfg.enableSellBelowTrendResistance !== false) && activeDowntrendLine && !activeDowntrendLine.isBroken) {
        const tlPrice = activeDowntrendLine.currentLinePrice;
        // All standard sell names that should be cancelled when trendline override is active
        const allSellNames = [...sellNames, "Sell TL Exit (Trendline)"];

        // Determine which standard sell levels are below the trendline
        const levelsUnderTL = sellLevels.filter((lvl) => lvl < tlPrice);

        if (levelsUnderTL.length === 0) {
          if (isIocMode) {
            // In IOC_BRACKET mode: do NOT place resting orders at the trendline.
            // Cancel any leftover resting TL sell orders and standard sell orders, then wait for IOC trigger.
            const leftoverSells = this.openOrders.filter(
              (o) => !o.isBid && o.levelDesc && allSellNames.includes(o.levelDesc),
            );
            if (leftoverSells.length > 0) {
              for (const o of leftoverSells) {
                await this.cancelOrderInternal(o, "IOC mode active: cancelling resting sell at trendline — waiting for IOC trigger");
              }
              this.openOrders = this.openOrders.filter((o) => !leftoverSells.includes(o));
              this.saveState();
            }
            return;
          }

          // No standard sell target is below the trendline (MAKER_LIMIT mode).
          // Place or maintain a resting Maker Limit Sell order at the trendline price for 100% exit.
          // When the trendline price shifts, automatically cancel and replace the order at the new TL price.
          const tlSellName = "Sell TL Exit (Trendline)";
          // Match existing TL sell by exact levelDesc OR by proximity to trendline price OR generic Binance order when no grid targets exist
          let existingTlSell = this.openOrders.find((o) => !o.isBid && (
            o.levelDesc === tlSellName ||
            (o.levelDesc && o.levelDesc.startsWith("SELL Order #") && o.price >= refPrice * 0.999) ||
            Math.abs(o.price - tlPrice) / tlPrice <= 0.005
          ));

          if (existingTlSell && existingTlSell.levelDesc !== tlSellName) {
            existingTlSell.levelDesc = tlSellName;
            existingTlSell.targetFraction = 0.0;
            this.log(`🔗 [TL SELL] Re-linked resting SELL order #${existingTlSell.onChainOrderId || existingTlSell.id} @ $${existingTlSell.price.toFixed(6)} to ${tlSellName}`);
          }

          // Cancel any standard grid sell orders that might still be resting
          const staleStandardSells = this.openOrders.filter(
            (o) => !o.isBid && o !== existingTlSell && o.levelDesc && sellNames.includes(o.levelDesc),
          );
          if (staleStandardSells.length > 0) {
            for (const o of staleStandardSells) {
              await this.cancelOrderInternal(o, "Trendline override: cancelling standard grid sells — switching to TL sell");
            }
            this.openOrders = this.openOrders.filter((o) => !staleStandardSells.includes(o));
            this.saveState();
          }

          // Set resting sell price slightly below trendline by ~0.08% to ensure front-running and reliable maker fill
          const frontRunRatio = 0.0008; // 0.08% below trendline
          const rawTargetSellPrice = tlPrice * (1 - frontRunRatio);
          const effectiveTlSellPrice = roundToTick(Math.max(refPrice * 1.0005, rawTargetSellPrice), this.tickSize || 0.0001);

          const mode = this.cfg.sellProfitMode || (this.cfg.requireProfitAboveAvgEntry ? "PORTFOLIO_AVG_PROFIT" : "GRID_CASHFLOW");
          const avgEntry = this.getAvgEntryPrice();
          const isProfitOk = mode !== "PORTFOLIO_AVG_PROFIT" || avgEntry <= 0 || effectiveTlSellPrice >= avgEntry * 1.001;

          // Only place resting sell if price is comfortably below the trendline (not in immediate IOC execution range)
          const isNearTL = refPrice >= effectiveTlSellPrice * 0.9995;

          if (isProfitOk && !isNearTL && held >= this.minQty) {
            const minOrderNotional = Math.max(this.minNotional || 5.0, 5.0);
            const targetSellQty = roundToStep(held, this.stepSize || 0.0001, 4);
            const orderNotional = targetSellQty * effectiveTlSellPrice;

            if (targetSellQty >= this.minQty && orderNotional >= minOrderNotional) {
              if (existingTlSell) {
                // If trendline price has drifted beyond tolerance (e.g. >0.1%), update the order to match the new TL price!
                const tlPriceDiffRatio = Math.abs(existingTlSell.price - effectiveTlSellPrice) / effectiveTlSellPrice;
                const qtyDiffRatio = Math.abs(existingTlSell.qty - targetSellQty) / targetSellQty;

                if (tlPriceDiffRatio > 0.001 || qtyDiffRatio > 0.05) {
                  await this.cancelOrderInternal(
                    existingTlSell,
                    `Trendline slope updated: moving resting sell ($${existingTlSell.price.toFixed(6)} -> $${effectiveTlSellPrice.toFixed(6)})`,
                  );
                  this.openOrders = this.openOrders.filter((o) => o !== existingTlSell);
                  this.saveState();

                  await this.placeRestingOrder(
                    false,
                    effectiveTlSellPrice,
                    targetSellQty,
                    0.0,
                    orderNotional,
                    tlSellName,
                  );
                }
              } else {
                // Place new resting sell order right slightly below the trendline price
                await this.placeRestingOrder(
                  false,
                  effectiveTlSellPrice,
                  targetSellQty,
                  0.0,
                  orderNotional,
                  tlSellName,
                );
              }
            }
          } else if (isNearTL && existingTlSell) {
            // Price reached within immediate touch distance of TL: cancel resting order so block 2a can execute IOC sell cleanly
            await this.cancelOrderInternal(existingTlSell, "Price touching trendline: cancelling resting sell for immediate IOC exit");
            this.openOrders = this.openOrders.filter((o) => o !== existingTlSell);
            this.saveState();
          }
        } else {
          // Some sell levels are below the trendline.
          // IMPORTANT: ALL inventory must be covered by sell orders.
          // The LAST eligible level below TL is treated as a full-exit level (targetFraction = 0),
          // so the remaining inventory not sold by earlier tranches is fully captured there.
          const tlSellName = "Sell TL Exit (Trendline)";
          const tlExitOrders = this.openOrders.filter((o) => !o.isBid && o.levelDesc === tlSellName);
          if (tlExitOrders.length > 0) {
            for (const o of tlExitOrders) {
              await this.cancelOrderInternal(o, "Trendline override: valid targets below TL now exist — reverting to grid levels");
            }
            this.openOrders = this.openOrders.filter((o) => !tlExitOrders.includes(o));
            this.saveState();
          }

          // Cancel sell orders that sit AT or ABOVE the trendline (price >= TL)
          const suppressedSells = this.openOrders.filter(
            (o) => !o.isBid && o.levelDesc && sellNames.includes(o.levelDesc) && o.price >= tlPrice,
          );
          if (suppressedSells.length > 0) {
            for (const o of suppressedSells) {
              await this.cancelOrderInternal(
                o,
                `Trendline suppressed: sell @ $${o.price.toFixed(6)} >= TL $${tlPrice.toFixed(6)}`,
              );
            }
            this.openOrders = this.openOrders.filter((o) => !suppressedSells.includes(o));
            this.saveState();
          }

          const mode = this.cfg.sellProfitMode || (this.cfg.requireProfitAboveAvgEntry ? "PORTFOLIO_AVG_PROFIT" : "GRID_CASHFLOW");
          const avgEntry = this.getAvgEntryPrice();
          let minAllowedSellPrice = Math.max(currentBestBid, refPrice);
          if (mode === "PORTFOLIO_AVG_PROFIT" && avgEntry > 0) {
            minAllowedSellPrice = Math.max(minAllowedSellPrice, avgEntry * 1.001);
          }

          // Identify eligible levels (strictly below TL and strictly above minAllowedSellPrice)
          const eligibleIndices = sellLevels
            .map((lvl, idx) => ({ lvl, idx }))
            .filter(({ lvl }) => lvl < tlPrice && lvl > minAllowedSellPrice)
            .map(({ idx }) => idx);

          const minOrderNotional = Math.max(this.minNotional || 5.0, 5.0);
          let targetTrancheCount = eligibleIndices.length;

          // If dividing evenly across all eligible levels drops below exchange minimum notional,
          // consolidate into 2 tranches (Target 1 & 2 for fast exit), or 1 tranche if 2 is still below minNotional:
          if (targetTrancheCount > 0 && (held / targetTrancheCount) * minAllowedSellPrice < minOrderNotional) {
            if (targetTrancheCount >= 2 && (held / 2) * minAllowedSellPrice >= minOrderNotional) {
              targetTrancheCount = 2;
            } else {
              targetTrancheCount = 1;
            }
          }

          const activeSellIndices = eligibleIndices.slice(0, targetTrancheCount);
          const numActive = activeSellIndices.length > 0 ? activeSellIndices.length : 1;
          const trancheQty = held / numActive;

          // Check if any active levels below TL are missing an open sell order
          const hasMissingEligibleSellOrders = activeSellIndices.some((idx) => {
            const lvlPrice = sellLevels[idx];
            return !this.openOrders.some(
              (o) => !o.isBid && (o.levelDesc === sellNames[idx] || (lvlPrice && Math.abs(o.price - lvlPrice) / lvlPrice <= 0.001)),
            );
          });

          // Rebalance Sell side: trigger rebalance on BUY fills or when order sizes deviate on CEX
          const doSellRebalance = this.needsSellRebalance;
          this.needsSellRebalance = false;

          const totalBaseInOpenSells = this.openOrders
            .filter((o) => !o.isBid)
            .reduce((sum, o) => sum + o.qty, 0);
          const isInventoryFullyCovered =
            !hasMissingEligibleSellOrders &&
            (totalBaseInOpenSells >= held * 0.98 || Math.abs(totalBaseInOpenSells - held) <= Math.max(0.01, (this.minQty || 1) * 0.5));

          for (let i = 0; i < sellLevels.length; i++) {
            const lvlPrice = sellLevels[i];
            if (!lvlPrice) continue;

            // Skip levels that are at or above the trendline
            if (lvlPrice >= tlPrice) {
              continue;
            }

            const currentOpenSellAtLvl = this.openOrders.find(
              (o) => !o.isBid && (o.levelDesc === sellNames[i] || (!o.levelDesc && Math.abs(o.price - lvlPrice) / lvlPrice <= 0.001)),
            );

            // If this level is not in activeSellIndices (consolidated into Target 1 & 2 for speed/minNotional):
            if (!activeSellIndices.includes(i)) {
              if (currentOpenSellAtLvl) {
                await this.cancelOrderInternal(currentOpenSellAtLvl, "Consolidating sell tranches into faster levels (Target 1 & 2) to satisfy min notional");
                this.openOrders = this.openOrders.filter((o) => o !== currentOpenSellAtLvl);
                this.saveState();
              }
              continue;
            }

            const isLastActive = i === activeSellIndices[activeSellIndices.length - 1];
            const activeRank = activeSellIndices.indexOf(i);
            const targetHoldingFraction = isLastActive
              ? 0.0
              : (activeSellIndices.length - 1 - activeRank) / activeSellIndices.length;

            // ── IOC Sell when market price has reached or exceeded this sell target under TL ──
            if (!currentOpenSellAtLvl) {
              const isPriceExceeded = (currentBestBid > 0 && currentBestBid >= lvlPrice) || (refPrice >= lvlPrice && currentBestBid >= lvlPrice * 0.998);
              if (isPriceExceeded && (this.cfg.enableIocSellWhenExceeded !== false)) {
                const currentHoldFraction = maxInv > 0 ? (currentHeldQuote / maxInv) : 0;
                const isLevelAlreadyFulfilled = currentHoldFraction <= targetHoldingFraction || isInventoryFullyCovered;
                if (isLevelAlreadyFulfilled) {
                  continue; // Level already sold / satisfied. Do not IOC sell again!
                }
                const heldNow = this.baseHeld();
                if (heldNow >= this.minQty) {
                  const maxBidDiscount = (this.cfg.cutLossMaxBidDiscountPct ?? 2.5) / 100;
                  const isBidHealthy = currentBestBid > 0 && ((refPrice - currentBestBid) / refPrice) <= maxBidDiscount;
                  const isProfitOk = mode !== "PORTFOLIO_AVG_PROFIT" || avgEntry <= 0 || currentBestBid >= avgEntry * 1.001;

                  if (isBidHealthy && isProfitOk) {
                    const iocCooldownKey = `ioc_sell_${sellNames[i]}`;
                    const lastIoc = this.orderCooldowns.get(iocCooldownKey) ?? 0;
                    if (Date.now() - lastIoc > 15_000) {
                      let desiredSellQty = trancheQty;
                      if (isLastActive && mode !== "LOT_BASED_PROFIT") {
                        desiredSellQty = Math.max(trancheQty, heldNow - (trancheQty * (numActive - 1)));
                      }
                      desiredSellQty = Math.min(this.baseHeld(), desiredSellQty);

                      if (desiredSellQty >= this.minQty) {
                        this.orderCooldowns.set(iocCooldownKey, Date.now());
                        const success = await this.sellTrancheIOC(
                          desiredSellQty,
                          currentBestBid,
                          sellNames[i] || `Sell Target ${i + 1}`,
                          lvlPrice,
                        );
                        if (success) {
                          continue;
                        }
                      }
                    }
                  }
                }
              }
            }

            const isEligibleForNewOrder = lvlPrice > minAllowedSellPrice;
            if (!currentOpenSellAtLvl && !isEligibleForNewOrder) continue;

            let desiredSellQty = trancheQty;

            // In LOT_BASED_PROFIT mode: only sell inventory from lots bought below lvlPrice
            if (mode === "LOT_BASED_PROFIT") {
              const profitableLots = this.lots.filter((l) => l.price * 1.001 <= lvlPrice);
              const totalProfitableQty = profitableLots.reduce((sum, l) => sum + l.qty, 0);
              const lowerSellsQty = this.openOrders
                .filter((o) => !o.isBid && o !== currentOpenSellAtLvl && o.price < lvlPrice)
                .reduce((sum, o) => sum + o.qty, 0);
              const availableProfitableQty = Math.max(0, totalProfitableQty - lowerSellsQty);

              if (availableProfitableQty < (this.minQty || 1)) {
                if (currentOpenSellAtLvl) {
                  await this.cancelOrderInternal(currentOpenSellAtLvl, "Lot-based mode: no profitable lots available for this sell level");
                  this.openOrders = this.openOrders.filter((o) => o !== currentOpenSellAtLvl);
                  this.saveState();
                }
                continue;
              }
              desiredSellQty = Math.min(desiredSellQty, availableProfitableQty);
            }

            // For the last active level: equal tranche + dust cleanup (no huge inventory dumps)
            if (isLastActive && mode !== "LOT_BASED_PROFIT") {
              desiredSellQty = Math.max(trancheQty, this.baseHeld() - (trancheQty * (numActive - 1)));
            }

            if (desiredSellQty < this.minQty) continue;

            let effLvlPrice = lvlPrice;
            const minMakerPrice = Math.max(currentBestAsk, refPrice * 1.0005);
            if (effLvlPrice <= currentBestBid) {
              effLvlPrice = Math.max(effLvlPrice, minMakerPrice);
            }

            if (currentOpenSellAtLvl) {
              const qtyDiffRatio = Math.abs(currentOpenSellAtLvl.qty - desiredSellQty) / desiredSellQty;
              const priceDiffRatio = Math.abs(currentOpenSellAtLvl.price - effLvlPrice) / effLvlPrice;
              const shiftTol = this.cfg.minChannelShiftPct ? this.cfg.minChannelShiftPct / 100 : 0.008;
              const isCexExchange = this.binance.exchangeName !== "dreamdex";
              const needsQtyResize = (doSellRebalance || hasMissingEligibleSellOrders || (isCexExchange && qtyDiffRatio > 0.10)) && qtyDiffRatio > qtyTol;
              if (needsQtyResize || priceDiffRatio > shiftTol) {
                const reason = priceDiffRatio > shiftTol
                  ? `Channel shifted: aligning sell price ($${currentOpenSellAtLvl.price.toFixed(6)} -> $${effLvlPrice.toFixed(6)})`
                  : "Rebalancing sell quantity to match inventory tranche";
                await this.cancelOrderInternal(currentOpenSellAtLvl, reason);
                this.openOrders = this.openOrders.filter((o) => o !== currentOpenSellAtLvl);
                await this.placeRestingOrder(
                  false,
                  effLvlPrice,
                  desiredSellQty,
                  targetHoldingFraction,
                  desiredSellQty * effLvlPrice,
                  sellNames[i] || `Sell Target ${i + 1}`,
                );
              }
              continue;
            } else if (isEligibleForNewOrder) {
              await this.placeRestingOrder(
                false,
                effLvlPrice,
                desiredSellQty,
                targetHoldingFraction,
                desiredSellQty * effLvlPrice,
                sellNames[i] || `Sell Target ${i + 1}`,
              );
            }
          }
        }

        // Done with trendline-override sell logic — return early from sell section
        return;
      }

      // ── Standard Sell Order Logic (no active trendline) ────────────────────────
      const sellHoldingTargets = isSingleSellLevel
        ? [0.0]
        : [0.75, 0.50, 0.25, 0.0];

      // Clean up stale resting sell orders or correct mislabeled levelDesc to closest sellLevel
      const remainingStaleSells: OpenOrder[] = [];
      for (const o of this.openOrders) {
        if (o.isBid) continue;

        // Find the closest sell level by price
        let closestIdx = -1;
        let minDiff = Infinity;
        for (let idx = 0; idx < sellLevels.length; idx++) {
          const lvl = sellLevels[idx];
          if (lvl) {
            const diff = Math.abs(lvl - o.price) / o.price;
            if (diff < minDiff) {
              minDiff = diff;
              closestIdx = idx;
            }
          }
        }

        if (closestIdx >= 0 && minDiff <= 0.0015) {
          const expectedName = sellNames[closestIdx];
          if (o.levelDesc !== expectedName) {
            const oldName = o.levelDesc || "unlabeled";
            o.levelDesc = expectedName;
            o.targetFraction = sellHoldingTargets[closestIdx] ?? 0.0;
            this.log(`🔗 [sync] Re-linked resting SELL order #${o.onChainOrderId || o.id} (${oldName} -> ${o.levelDesc}) @ $${o.price.toFixed(6)}`);
          }
        } else if (!o.levelDesc || !sellNames.includes(o.levelDesc)) {
          remainingStaleSells.push(o);
        }
      }

      if (remainingStaleSells.length > 0) {
        for (const o of remainingStaleSells) {
          await this.cancelOrderInternal(o, "Channel shifted / Level no longer in sell zone");
        }
        this.openOrders = this.openOrders.filter((o) => !remainingStaleSells.includes(o));
        this.saveState();
      }

      // Only place/maintain sell orders at levels strictly ABOVE the current market price AND (if required) above average entry
      const mode = this.cfg.sellProfitMode || (this.cfg.requireProfitAboveAvgEntry ? "PORTFOLIO_AVG_PROFIT" : "GRID_CASHFLOW");
      const avgEntry = this.getAvgEntryPrice();
      let minAllowedSellPrice = Math.max(currentBestBid, refPrice);
      if (mode === "PORTFOLIO_AVG_PROFIT" && avgEntry > 0) {
        minAllowedSellPrice = Math.max(minAllowedSellPrice, avgEntry * 1.001);
      }

      // Determine eligible sell levels strictly ABOVE minAllowedSellPrice
      const eligibleSellIndices = sellLevels
        .map((lvl, idx) => ({ lvl, idx }))
        .filter(({ lvl }) => lvl > minAllowedSellPrice)
        .map(({ idx }) => idx);

      const minOrderNotional = Math.max(this.minNotional || 5.0, 5.0);
      let targetTrancheCount = eligibleSellIndices.length;

      // If dividing evenly across all eligible levels drops below exchange minimum notional,
      // consolidate into 2 tranches (Target 1 & 2 for fast exit), or 1 tranche if 2 is still below minNotional:
      if (targetTrancheCount > 0 && (held / targetTrancheCount) * minAllowedSellPrice < minOrderNotional) {
        if (targetTrancheCount >= 2 && (held / 2) * minAllowedSellPrice >= minOrderNotional) {
          targetTrancheCount = 2;
        } else {
          targetTrancheCount = 1;
        }
      }

      // Pick active sell levels:
      // When consolidated, pick the first 2 eligible levels (Target 1 & 2) for maximum exit speed!
      const activeSellIndices = eligibleSellIndices.slice(0, targetTrancheCount);
      const numActiveLevels = activeSellIndices.length > 0 ? activeSellIndices.length : (sellLevels.length || 4);
      const trancheQty = held / numActiveLevels;

      // Check if any active levels are missing an open sell order
      const hasMissingEligibleSellOrders = activeSellIndices.some((idx) => {
        const lvlPrice = sellLevels[idx];
        return !this.openOrders.some(
          (o) => !o.isBid && (o.levelDesc === sellNames[idx] || (lvlPrice && Math.abs(o.price - lvlPrice) / lvlPrice <= 0.001)),
        );
      });

      // Rebalance Sell side: trigger rebalance on BUY fills or when order sizes deviate on CEX
      const doSellRebalance = this.needsSellRebalance;
      this.needsSellRebalance = false;

      // Check if existing resting sell orders already fully cover the held inventory
      const totalBaseInOpenSells = this.openOrders
        .filter((o) => !o.isBid)
        .reduce((sum, o) => sum + o.qty, 0);

      // If existing resting sells cover the held inventory, NO NEW BUYS have occurred.
      // Inventory is ONLY considered fully covered if:
      // 1. Total open sell quantity matches held inventory, AND
      // 2. NO active sell levels are missing their orders! (If an active level has no order, we MUST place it!)
      const isInventoryFullyCovered =
        !hasMissingEligibleSellOrders &&
        (totalBaseInOpenSells >= held * 0.98 || Math.abs(totalBaseInOpenSells - held) <= Math.max(0.01, (this.minQty || 1) * 0.5));

      for (let i = 0; i < sellLevels.length; i++) {
        const originalLvlPrice = sellLevels[i];
        if (!originalLvlPrice) continue;

        // Strictly match by level name to prevent adjacent grid levels from stealing/cancelling each other's orders
        const currentOpenSellAtLvl = this.openOrders.find(
          (o) => !o.isBid && (o.levelDesc === sellNames[i] || (!o.levelDesc && Math.abs(o.price - originalLvlPrice) / originalLvlPrice <= 0.001)),
        );

        // If this level is not in activeSellIndices (consolidated into Target 1 & 2 for speed/minNotional):
        if (!activeSellIndices.includes(i)) {
          if (currentOpenSellAtLvl) {
            await this.cancelOrderInternal(currentOpenSellAtLvl, "Consolidating sell tranches into faster levels (Target 1 & 2) to satisfy min notional");
            this.openOrders = this.openOrders.filter((o) => o !== currentOpenSellAtLvl);
            this.saveState();
          }
          continue;
        }

        const isFinalExitLevel = i === activeSellIndices[activeSellIndices.length - 1];
        const activeRank = activeSellIndices.indexOf(i);
        const targetHoldingFraction = isFinalExitLevel
          ? 0.0
          : (activeSellIndices.length - 1 - activeRank) / activeSellIndices.length;

        // ── IOC Sell when market price has reached or exceeded this sell target ──
        if (!currentOpenSellAtLvl) {
          const isPriceExceeded = (currentBestBid > 0 && currentBestBid >= originalLvlPrice) || (refPrice >= originalLvlPrice && currentBestBid >= originalLvlPrice * 0.998);
          if (isPriceExceeded && (this.cfg.enableIocSellWhenExceeded !== false)) {
            const currentHoldFraction = maxInv > 0 ? (currentHeldQuote / maxInv) : 0;
            const isLevelAlreadyFulfilled = currentHoldFraction <= targetHoldingFraction || isInventoryFullyCovered;
            if (isLevelAlreadyFulfilled) {
              continue; // Level already sold / satisfied. Do not IOC sell again!
            }
            const heldNow = this.baseHeld();
            if (heldNow >= this.minQty) {
              const maxBidDiscount = (this.cfg.cutLossMaxBidDiscountPct ?? 2.5) / 100;
              const isBidHealthy = currentBestBid > 0 && ((refPrice - currentBestBid) / refPrice) <= maxBidDiscount;
              const isProfitOk = mode !== "PORTFOLIO_AVG_PROFIT" || avgEntry <= 0 || currentBestBid >= avgEntry * 1.001;

              if (isBidHealthy && isProfitOk) {
                const iocCooldownKey = `ioc_sell_${sellNames[i]}`;
                const lastIoc = this.orderCooldowns.get(iocCooldownKey) ?? 0;
                if (Date.now() - lastIoc > 15_000) {
                  // Determine tranche quantity to sell
                  let desiredSellQty = trancheQty;
                  if (isFinalExitLevel && mode !== "LOT_BASED_PROFIT") {
                    desiredSellQty = Math.max(trancheQty, heldNow - (trancheQty * (numActiveLevels - 1)));
                  }
                  desiredSellQty = Math.min(this.baseHeld(), desiredSellQty);

                  if (desiredSellQty >= this.minQty) {
                    this.orderCooldowns.set(iocCooldownKey, Date.now());
                    const success = await this.sellTrancheIOC(
                      desiredSellQty,
                      currentBestBid,
                      sellNames[i] || `Sell Target ${i + 1}`,
                      originalLvlPrice,
                    );
                    if (success) {
                      continue;
                    }
                  }
                }
              }
            }
          }
        }

        // Standard resting limit order placement (price < originalLvlPrice)
        let lvlPrice = originalLvlPrice;
        const minMakerPrice = Math.max(currentBestAsk, refPrice * 1.0005);
        if (lvlPrice <= currentBestBid) {
          lvlPrice = Math.max(lvlPrice, minMakerPrice);
        }

        // Calculate equal tranche quantity for this level
        let desiredSellQty = trancheQty;

        // For final active level: clean up any sub-cent rounding dust (satoshis/wei) without hoarding missing tranches
        if (isFinalExitLevel && mode !== "LOT_BASED_PROFIT") {
          desiredSellQty = Math.max(trancheQty, this.baseHeld() - (trancheQty * (numActiveLevels - 1)));
        }

        // If this level already has an active sell order:
        if (currentOpenSellAtLvl) {
          const priceDiffRatio = Math.abs(currentOpenSellAtLvl.price - lvlPrice) / lvlPrice;
          const shiftTol = this.cfg.minChannelShiftPct ? this.cfg.minChannelShiftPct / 100 : 0.008;
          const isPriceShifted = priceDiffRatio > shiftTol;

          const isCexExchange = this.binance.exchangeName !== "dreamdex";
          const targetSellQty = desiredSellQty >= (this.minQty || 0.001) ? desiredSellQty : trancheQty;
          const qtyDiffRatio = Math.abs(currentOpenSellAtLvl.qty - targetSellQty) / Math.max(0.000001, targetSellQty);
          const qtyTol = this.cfg.orderQtyTolerancePct ? this.cfg.orderQtyTolerancePct / 100 : 0.05;
          // Rebalance sell quantity if explicitly requested (BUY filled, startup, resume) OR if missing eligible levels exist OR on CEX if deviation is large (>10%)
          const needsQtyResize = (doSellRebalance || hasMissingEligibleSellOrders || (isCexExchange && qtyDiffRatio > 0.10)) && qtyDiffRatio > qtyTol;

          if (isPriceShifted || needsQtyResize) {
            const reason = isPriceShifted
              ? `Channel shifted: aligning sell price ($${currentOpenSellAtLvl.price.toFixed(6)} -> $${lvlPrice.toFixed(6)})`
              : `Rebalancing sell quantity to equal tranche (${currentOpenSellAtLvl.qty.toFixed(4)} -> ${targetSellQty.toFixed(4)} ${this.baseAsset})`;
            await this.cancelOrderInternal(currentOpenSellAtLvl, reason);
            this.openOrders = this.openOrders.filter((o) => o !== currentOpenSellAtLvl);
            await this.placeRestingOrder(
              false,
              lvlPrice,
              targetSellQty,
              targetHoldingFraction,
              targetSellQty * lvlPrice,
              sellNames[i] || `Sell Target ${i + 1}`,
            );
          }
          continue;
        }

        // Only place a new sell order if we have unallocated inventory (or rebalancing)
        if (isInventoryFullyCovered && !doSellRebalance) {
          continue;
        }

        if (desiredSellQty < (this.minQty || 0.001)) continue;

        const isEligibleForNewOrder = lvlPrice > minAllowedSellPrice;
        if (isEligibleForNewOrder) {
          await this.placeRestingOrder(
            false,
            lvlPrice,
            desiredSellQty,
            targetHoldingFraction,
            desiredSellQty * lvlPrice,
            sellNames[i] || `Sell Target ${i + 1}`,
          );
        }
      }
    }
  }

  /**
   * Cancel a single open order with explicit on-chain & dry-run logging
   */
  private async cancelOrderInternal(order: OpenOrder, reason: string): Promise<void> {
    const sideStr = order.isBid ? "BUY" : "SELL";
    const orderNotional = (order.notionalQuote !== undefined ? order.notionalQuote : order.notionalUsdso) || (order.price * order.qty);
    if (this.cfg.dryRun) {
      const dryGasBase = 0.001;
      const dryGasQuote = dryGasBase * order.price;
      this.accumulatedGasBase += dryGasBase;
      this.accumulatedGasQuote += dryGasQuote;
      this.totalGasSpentBase += dryGasBase;
      this.totalGasSpentQuote += dryGasQuote;
      this.totalTxCount++;

      this.log(
        `[dry-run] 🗑️ CANCELLED ${sideStr} LIMIT @ $${order.price.toFixed(6)} (${order.qty.toFixed(4)} ${this.baseAsset} | $${orderNotional.toFixed(2)} ${this.quoteAsset}) • ${order.levelDesc} [${reason}]`,
      );
      this.emit({
        type: "order",
        data: {
          side: order.isBid ? "BUY" : "SELL",
          action: order.isBid ? "CANCEL_BUY" : "CANCEL_SELL",
          price: order.price,
          qty: order.qty,
          notional: orderNotional,
          notionalQuote: orderNotional,
          notionalUsdso: orderNotional,
          levelDesc: order.levelDesc,
          reason,
          time: Date.now(),
          dryRun: true,
        },
      });
      return;
    }

    if (order.onChainOrderId) {
      this.cancelledOrderIds.set(order.onChainOrderId, Date.now());
      try {
        const res = await this.binance.cancelOrder(this.symbol, order.onChainOrderId);
        const txHash = typeof res === "string" ? res : ((res as any)?.txHash || (res as any)?.hash || undefined);
        const txStr = txHash ? ` (tx: ${txHash})` : "";
        this.log(
          `🗑️ ON-CHAIN CANCELLED ${sideStr} LIMIT #${order.onChainOrderId} @ $${order.price.toFixed(6)} (${order.qty.toFixed(4)} ${this.baseAsset} | $${orderNotional.toFixed(2)} ${this.quoteAsset}) • ${order.levelDesc} [${reason}]${txStr}`,
        );
        this.emit({
          type: "order",
          data: {
            side: order.isBid ? "BUY" : "SELL",
            action: order.isBid ? "CANCEL_BUY" : "CANCEL_SELL",
            price: order.price,
            qty: order.qty,
            notional: orderNotional,
            notionalQuote: orderNotional,
            notionalUsdso: orderNotional,
            levelDesc: order.levelDesc,
            orderId: order.onChainOrderId,
            reason,
            time: Date.now(),
            dryRun: false,
            txHash,
          },
        });
        if (txHash) {
          this.trackTxGas(txHash, `Cancel ${sideStr} #${order.onChainOrderId}`);
        }
        await this.refreshWalletBalances();
      } catch (err) {
        this.log(
          `⚠️ On-chain cancel order #${order.onChainOrderId} failed: ${(err as Error).message}`,
        );
      }
    }
  }

  /**
   * Place a Maker / Resting Limit Order (Virtual in Dry-Run, On-Chain in Live)
   */
  private async placeRestingOrder(
    isBid: boolean,
    price: number,
    qty: number,
    targetFraction: number,
    notionalQuote: number,
    levelDesc: string,
  ): Promise<void> {
    if (qty < this.minQty) return;
    // Align price to tickSize and precision
    price = roundToTick(price, this.tickSize || 0.0001);
    let notionalUsdso = notionalQuote;
    const now = Date.now();
    const sideStr = isBid ? "BUY" : "SELL";
    const orderKey = `${sideStr}_${price.toFixed(6)}`;

    // 1. Guard: Cooldown check (prevent rapid retries after an error)
    const cooldownUntil = this.orderCooldowns.get(orderKey) ?? 0;
    if (now < cooldownUntil) {
      return;
    }

    // 2. Guard: Check if identical order is already currently being placed in-flight
    if (this.inFlightOrders.has(orderKey)) {
      return;
    }

    // 3. Guard: Check if an active order at this exact price/side already exists in memory
    const existing = this.openOrders.find(
      (o) => o.isBid === isBid && Math.abs(o.price - price) / price < 0.0005,
    );
    if (existing) {
      return;
    }

    // 4. Guard: Live Wallet Balance Verification before submitting transaction
    if (!this.cfg.dryRun) {
      await this.refreshWalletBalances();
      if (isBid) {
        // ── BUY Order Guard: Ensure sufficient Quote balance ─────────────
        if (this.walletQuoteBalance < notionalQuote) {
          if (this.walletQuoteBalance >= this.minQty * price) {
            const adjustedQty = this.walletQuoteBalance / price;
            this.log(
              `ℹ️ Auto-adjusting BUY budget from $${notionalQuote.toFixed(2)} to $${this.walletQuoteBalance.toFixed(2)} to fit available ${this.quoteAsset} balance`,
            );
            qty = adjustedQty;
            notionalQuote = this.walletQuoteBalance;
            notionalUsdso = notionalQuote;
          } else {
            this.log(
              `⚠️ Insufficient ${this.quoteAsset} balance for BUY order (Wallet: $${this.walletQuoteBalance.toFixed(2)} | Needed: $${notionalQuote.toFixed(2)}). Skipping placement.`,
            );
            this.orderCooldowns.set(orderKey, now + 15000);
            return;
          }
        }
      } else {
        // ── SELL Order Guards: Inventory + Balance Reserve ────────────────────
        const minReserveBase = this.getEffectiveGasReserveBase();
        const availableBaseInWallet = Math.max(0, this.walletBaseBalance - minReserveBase);

        if (availableBaseInWallet < this.minQty) {
          this.log(
            `🛑 [BALANCE GUARD] Skipping SELL order: Wallet has ${this.walletBaseBalance.toFixed(4)} ${this.baseAsset}, which is below minimum trading size.`,
          );
          this.orderCooldowns.set(orderKey, now + 15000);
          return;
        }

        // Strict Trading Inventory Guard: Never sell more than what is held in trading inventory (this.baseHeld())
        const tradingHeld = this.baseHeld();
        const otherSellOrdersQty = this.openOrders
          .filter((o) => !o.isBid && o.levelDesc !== levelDesc)
          .reduce((sum, o) => sum + o.qty, 0);
        const remainingTradingQty = Math.max(0, Math.min(tradingHeld - otherSellOrdersQty, availableBaseInWallet));

        if (remainingTradingQty < this.minQty) {
          this.log(
            `🛑 [INVENTORY GUARD] Skipping SELL order: Strategy trading inventory is ${tradingHeld.toFixed(4)} ${this.baseAsset} (Active sells: ${otherSellOrdersQty.toFixed(4)} ${this.baseAsset} | Safe wallet available: ${availableBaseInWallet.toFixed(4)} ${this.baseAsset}). Protected wallet balance from non-trading dilution (Wallet: ${this.walletBaseBalance.toFixed(4)} ${this.baseAsset}).`,
          );
          this.orderCooldowns.set(orderKey, now + 15000);
          return;
        }

        if (qty > remainingTradingQty) {
          this.log(
            `ℹ️ [INVENTORY GUARD] Clamping SELL order qty from ${qty.toFixed(4)} to ${remainingTradingQty.toFixed(4)} ${this.baseAsset} to protect wallet balance and inventory.`,
          );
          qty = remainingTradingQty;
          notionalQuote = qty * price;
          notionalUsdso = notionalQuote;
        }
      }
    }

    // Strictly round order quantity to exchange stepSize and precision (4 decimal places for ETH)
    qty = roundToStep(qty, this.stepSize || 0.0001, 4);
    if (qty < this.minQty) {
      return;
    }
    notionalQuote = qty * price;
    notionalUsdso = notionalQuote;

    const minNotional = Math.max(this.minNotional || 5.0, 5.0);
    if (notionalQuote < minNotional) {
      this.log(
        `⚠️ [MIN NOTIONAL GUARD] Skipping ${sideStr} order placement @ $${price.toFixed(6)}: Order notional $${notionalQuote.toFixed(2)} is below minimum requirement ($${minNotional.toFixed(2)}).`,
      );
      this.orderCooldowns.set(orderKey, now + 15000);
      return;
    }

    // Acquire in-flight lock for this order level
    this.inFlightOrders.add(orderKey);

    const id = `order_${isBid ? "buy" : "sell"}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    const supportsExpiry = Boolean(this.binance.supportsOrderExpiry);
    const expireHours = supportsExpiry ? (this.cfg.orderExpireHours ?? 24) : undefined;
    const expireTime = (supportsExpiry && expireHours) ? (now + expireHours * 3600 * 1000) : undefined;
    const expireLogSuffix = (supportsExpiry && expireHours) ? ` [Expires in ${expireHours}h]` : "";

    if (this.cfg.dryRun) {
      try {
        const dryGasBase = 0.002;
        const dryGasQuote = dryGasBase * price;
        this.accumulatedGasBase += dryGasBase;
        this.accumulatedGasQuote += dryGasQuote;
        this.totalGasSpentBase += dryGasBase;
        this.totalGasSpentQuote += dryGasQuote;
        this.totalTxCount++;

        this.openOrders.push({
          id,
          isBid,
          price,
          qty,
          targetFraction,
          notional: notionalQuote,
          notionalQuote,
          notionalUsdso,
          levelDesc,
          placedTime: now,
          expireTime,
        });
        this.log(
          `[dry-run] 📋 CREATED ${sideStr} LIMIT @ $${price.toFixed(6)} (${qty.toFixed(4)} ${this.baseAsset} | $${notionalQuote.toFixed(2)} ${this.quoteAsset}) • ${levelDesc}${expireLogSuffix}`,
        );
        this.emit({
          type: "order",
          data: {
            action: isBid ? "CREATE_BUY" : "CREATE_SELL",
            price,
            qty,
            notional: notionalQuote,
            notionalQuote,
            notionalUsdso,
            levelDesc,
            time: now,
            expireTime,
            expireHours,
            dryRun: true,
          },
        });
        this.saveState();
      } finally {
        this.inFlightOrders.delete(orderKey);
      }
      return;
    }

    try {
      const res = await this.binance.placeOrder({
        symbol: this.symbol,
        side: isBid ? "BUY" : "SELL",
        type: "LIMIT",
        price,
        qty,
        clientOrderId: id,
        expireHours,
      });
      const orderIdStr = res.orderId ? res.orderId.toString() : undefined;
      this.openOrders.push({
        id,
        onChainOrderId: orderIdStr,
        isBid,
        price,
        qty,
        targetFraction,
        notional: notionalQuote,
        notionalQuote,
        notionalUsdso,
        levelDesc,
        placedTime: now,
        expireTime,
        txHash: res.txHash,
      });
      const txDesc = res.txHash ? ` (tx: ${res.txHash})` : "";
      this.log(
        `🚀 CREATED ${sideStr} LIMIT ${orderIdStr ? `#${orderIdStr} ` : ""}@ $${price.toFixed(6)} (${qty.toFixed(4)} ${this.baseAsset} | $${notionalQuote.toFixed(2)} ${this.quoteAsset}) • ${levelDesc}${expireLogSuffix}${txDesc}`,
      );
      this.emit({
        type: "order",
        data: {
          action: isBid ? "CREATE_BUY" : "CREATE_SELL",
          price,
          qty,
          notional: notionalQuote,
          notionalQuote,
          notionalUsdso,
          levelDesc,
          orderId: orderIdStr,
          txHash: res.txHash,
          time: now,
          expireTime,
          expireHours,
          dryRun: false,
        },
      });
      if (res.txHash) {
        this.trackTxGas(res.txHash, `Create ${sideStr} Limit`);
      }
      this.saveState();
      await this.refreshWalletBalances();
    } catch (err) {
      this.log(`⚠️ Place on-chain ${sideStr} order failed: ${(err as Error).message}`);
      // Cooldown level to prevent rapid loops and immediately verify on-chain status
      this.orderCooldowns.set(orderKey, now + 15000);
      await this.syncOnChainOrders();
    } finally {
      this.inFlightOrders.delete(orderKey);
    }
  }

  /**
   * Cancel resting Maker limit orders (virtual in Dry-Run, on-chain in Live)
   */
  private async cancelAllRestingOrders(side?: "BUY" | "SELL", reason = "Strategy reset / Channel shifted"): Promise<void> {
    const toCancel = this.openOrders.filter((o) => (side ? (side === "BUY" ? o.isBid : !o.isBid) : true));
    // Immediately remove from this.openOrders so background tick()/syncOnChainOrders() never sees them as stale/filled!
    this.openOrders = this.openOrders.filter((o) => (side ? (side === "BUY" ? !o.isBid : o.isBid) : false));
    const now = Date.now();
    for (const order of toCancel) {
      if (order.onChainOrderId) this.cancelledOrderIds.set(order.onChainOrderId, now);
    }
    this.saveState();

    for (const order of toCancel) {
      await this.cancelOrderInternal(order, reason);
    }

    if (!this.cfg.dryRun && this.binance.hasCredentials()) {
      try {
        if (!side) {
          await this.binance.cancelAllOpenOrders(this.symbol);
        } else {
          const live = await this.binance.getOpenOrders(this.symbol);
          for (const o of live) {
            const matches = (side === "BUY" && o.side === "BUY") || (side === "SELL" && o.side === "SELL");
            if (matches) {
              await this.binance.cancelOrder(this.symbol, o.orderId);
            }
          }
        }
      } catch (err) {
        this.log(`⚠️ Binance cancel sweep error: ${(err as Error).message}`);
      }
      await this.refreshWalletBalances();
    }
    this.saveState();
  }

  /**
   * IOC Bracket Grid Execution Engine
   * Eliminates resting order placement and cancellation churn by executing immediate IOC orders
   * when price enters level brackets. Aggregates multiple tranches into a single IOC transaction
   * on fast market movements (flash dumps / pumps) to maximize gas efficiency.
   */
  private async executeIocBracketGrid(
    buyLevels: number[],
    sellLevels: number[],
    lowerBound: number,
    upperBound: number,
    span: number,
    positionPct: number,
    inBuyZone: boolean,
    canBuy: boolean,
    currentBestAsk: number,
    currentBestBid: number,
    refPrice: number,
    activeDowntrendLine?: any,
    activeUptrendLine?: any,
    uptrendBroken?: boolean,
  ): Promise<void> {
    // 1. Cancel any existing resting orders if switching from MAKER_LIMIT to IOC_BRACKET
    if (this.openOrders.length > 0) {
      await this.cancelAllRestingOrders(undefined, "IOC_BRACKET mode active — clearing resting maker orders");
    }

    const maxInv = this.cfg.maxInventoryQuote ?? 40;
    const currentHeldQuote = this.baseHeld() * refPrice;
    const currentHeldUsdso = currentHeldQuote;
    const numBuyLevels = buyLevels.length || 4;
    const baseTrancheQuote = maxInv / numBuyLevels; // e.g. $10 per tranche
    const baseTrancheUsdso = baseTrancheQuote;

    // ── BUY SIDE (IOC Accumulation with Tranche Aggregation) ──────────────────
    // Safety Guard: Check that currentBestAsk is sane and not an outlier/phantom order
    const isAskPriceSane = refPrice > 0 && currentBestAsk > 0 && Math.abs(currentBestAsk - refPrice) / refPrice <= 0.05;

    if (canBuy && this.buyOrdersActive && currentBestAsk > 0 && isAskPriceSane) {
      // Determine which buy band the market price has reached
      // Band 1: currentBestAsk <= buyLevels[0] (40%) -> target tranches = 1
      // Band 2: currentBestAsk <= buyLevels[1] (30%) -> target tranches = 2
      // Band 3: currentBestAsk <= buyLevels[2] (20%) -> target tranches = 3
      // Band 4: currentBestAsk <= buyLevels[3] (10%) -> target tranches = 4
      let targetTranches = 0;
      let matchedLevelIndex = -1;
      let isTlBuy = false;
      let matchedBuyPrice: number | undefined;

      const tlPrice = (activeUptrendLine && !activeUptrendLine.isBroken) ? activeUptrendLine.currentLinePrice : undefined;

      // 1. Trendline Support Entry ("ถ้าเลย buy target สามารถเข้าซื้อได้ที่เส้น trend")
      // When ascending trendline is active and sits above standard Buy Level 1:
      // If ask price tests or reaches the trendline, trigger entry at the trendline support!
      if (
        (this.cfg.enableBuyAboveTrendSupport !== false) &&
        tlPrice !== undefined &&
        tlPrice > (buyLevels[0] ?? 0) &&
        currentBestAsk <= tlPrice * 1.002 &&
        currentBestAsk >= tlPrice * 0.990
      ) {
        targetTranches = 1;
        matchedLevelIndex = 0;
        isTlBuy = true;
        matchedBuyPrice = tlPrice;
      } else {
        // 2. Standard Grid Buy Levels or Breakdown Entry ("ถ้าหลุดไปรอซื้อที่ level ตาม position การถือครอง")
        // Require both currentBestAsk AND refPrice to confirm entry into buy level zone
        for (let i = 0; i < buyLevels.length; i++) {
          const lvlPrice = buyLevels[i];
          if (lvlPrice !== undefined && currentBestAsk <= lvlPrice && refPrice <= lvlPrice * 1.001) {
            targetTranches = i + 1;
            matchedLevelIndex = i;
          }
        }
        matchedBuyPrice = matchedLevelIndex >= 0 ? buyLevels[matchedLevelIndex] : undefined;
      }

      // Check trendline resistance filter (if descending trendline is active, cannot buy at or above TL)
      if (activeDowntrendLine && !activeDowntrendLine.isBroken && currentBestAsk >= activeDowntrendLine.currentLinePrice) {
        targetTranches = 0;
      }

      if (targetTranches > 0 && matchedLevelIndex >= 0 && matchedBuyPrice !== undefined) {
        const targetCapacityQuote = targetTranches * baseTrancheQuote;
        const deficitQuote = targetCapacityQuote - currentHeldQuote;

        // Only trigger if deficit is significant (at least 70% of a tranche, avoiding micro-dust churn)
        if (deficitQuote >= (baseTrancheQuote * 0.70)) {
          const cooldownKey = isTlBuy ? `ioc_bracket_buy_tl` : `ioc_bracket_buy_level_${matchedLevelIndex}`;
          const lastBuyTime = this.orderCooldowns.get(cooldownKey) ?? 0;
          const globalBuyCooldown = this.orderCooldowns.get("ioc_bracket_buy_global") ?? 0;
          const now = Date.now();

          // 10s cooldown per level, 3s global debounce
          if (now - lastBuyTime > 10_000 && now - globalBuyCooldown > 3_000) {
            const availableWalletQuote = this.cfg.dryRun ? maxInv : this.walletQuoteBalance;
            let toSpendQuote = Math.min(deficitQuote, Math.max(0, maxInv - currentHeldQuote), availableWalletQuote);
            const minNotional = Math.max(this.minNotional || 5.0, 5.0);

            // If toSpendQuote is below minNotional, try to expand to minNotional if wallet & maxInv headroom allow
            if (toSpendQuote < minNotional) {
              const maxPossibleSpend = Math.min(Math.max(0, maxInv - currentHeldQuote), availableWalletQuote);
              if (maxPossibleSpend >= minNotional) {
                toSpendQuote = minNotional;
              }
            }

            if (toSpendQuote >= minNotional && toSpendQuote >= (this.minQty * currentBestAsk)) {
              this.orderCooldowns.set(cooldownKey, now);
              this.orderCooldowns.set("ioc_bracket_buy_global", now);

              // Calculate how many tranches are being aggregated
              const tranchesAggregated = Math.max(1, Math.round(toSpendQuote / baseTrancheQuote));
              const buyQty = toSpendQuote / currentBestAsk;
              const actionLabel = isTlBuy
                ? `IOC Buy @ Trendline Support ($${matchedBuyPrice.toFixed(6)})`
                : tranchesAggregated > 1
                ? `IOC Buy L1-L${matchedLevelIndex + 1} (${tranchesAggregated}x)`
                : `IOC Buy Level ${matchedLevelIndex + 1}`;

              this.log(
                `🎯 [IOC BRACKET] Ask $${currentBestAsk.toFixed(6)} <= ${isTlBuy ? "TL Support" : `Buy Band ${matchedLevelIndex + 1}`} ($${matchedBuyPrice.toFixed(6)}) — executing ${actionLabel} for $${toSpendQuote.toFixed(2)} ${this.quoteAsset}`,
              );
              await this.buyTrancheIOC(buyQty, currentBestAsk, actionLabel, matchedBuyPrice, toSpendQuote);
            }
          }
        }
      }
    }

    // ── SELL SIDE (Adaptive IOC Distribution with Dynamic Tranches & minNotional) ──
    const minReserveBase = this.getEffectiveGasReserveBase();
    const availableTradingBase = Math.max(0, this.walletBaseBalance - minReserveBase);
    const held = this.cfg.dryRun ? this.baseHeld() : Math.min(this.baseHeld(), availableTradingBase);
    const minNotional = Math.max(this.minNotional || 5.0, 5.0);
    const totalHeldQuote = held * currentBestBid;

    if (this.sellOrdersActive && held >= this.minQty && totalHeldQuote >= minNotional && currentBestBid > 0) {
      // 1. Maintain or initialize sell distribution cycle
      // If no active cycle, or position grew significantly (new buy filled), establish new baseline
      if (
        !this.iocBracketSellCycle ||
        held > this.iocBracketSellCycle.baselineHeldQty * 1.05
      ) {
        let numSellTranches = Math.min(4, Math.max(1, sellLevels.length));
        while (numSellTranches > 1 && (totalHeldQuote / numSellTranches) < minNotional) {
          numSellTranches--;
        }
        this.iocBracketSellCycle = {
          baselineHeldQuote: totalHeldQuote,
          baselineHeldQty: held,
          numSellTranches,
          soldStepNums: new Set<number>(),
        };
      }

      const cycle = this.iocBracketSellCycle;
      const numSellTranches = cycle.numSellTranches;

      // 2. Map number of active sell tranches to target remaining inventory fractions
      // Each tranche corresponds to a step index (0 to numSellTranches - 1)
      // For 1 tranche:  Target 1 -> remaining 0.0 (100% full exit)
      // For 2 tranches: Target 1 -> remaining 0.50, Target 4 -> remaining 0.0
      // For 3 tranches: Target 1 -> remaining 0.67, Target 2 -> remaining 0.33, Target 4 -> remaining 0.0
      // For 4 tranches: Target 1 -> remaining 0.75, Target 2 -> remaining 0.50, Target 3 -> remaining 0.25, Target 4 -> remaining 0.0
      interface SellStep {
        levelIndex: number;
        targetRemainingFraction: number;
        stepNum: number;
      }
      const activeSteps: SellStep[] = [];
      if (numSellTranches === 1) {
        activeSteps.push({ levelIndex: 0, targetRemainingFraction: 0.0, stepNum: 1 });
      } else if (numSellTranches === 2) {
        activeSteps.push({ levelIndex: 0, targetRemainingFraction: 0.50, stepNum: 1 });
        activeSteps.push({ levelIndex: 3, targetRemainingFraction: 0.00, stepNum: 2 });
      } else if (numSellTranches === 3) {
        activeSteps.push({ levelIndex: 0, targetRemainingFraction: 2 / 3, stepNum: 1 });
        activeSteps.push({ levelIndex: 1, targetRemainingFraction: 1 / 3, stepNum: 2 });
        activeSteps.push({ levelIndex: 3, targetRemainingFraction: 0.00, stepNum: 3 });
      } else {
        activeSteps.push({ levelIndex: 0, targetRemainingFraction: 0.75, stepNum: 1 });
        activeSteps.push({ levelIndex: 1, targetRemainingFraction: 0.50, stepNum: 2 });
        activeSteps.push({ levelIndex: 2, targetRemainingFraction: 0.25, stepNum: 3 });
        activeSteps.push({ levelIndex: 3, targetRemainingFraction: 0.00, stepNum: 4 });
      }

      // 3. Find candidate sell steps that have been reached by market bid but NOT yet sold in this cycle
      let matchedStep: SellStep | undefined;
      for (const step of activeSteps) {
        const lvlPrice = sellLevels[step.levelIndex];
        if (lvlPrice !== undefined && currentBestBid >= lvlPrice) {
          if (!cycle.soldStepNums.has(step.stepNum)) {
            matchedStep = step;
            // Pick the lowest unsold reached step (ladder upwards)
            break;
          }
        }
      }

      if (matchedStep !== undefined) {
        const matchedSellPrice = sellLevels[matchedStep.levelIndex];
        if (matchedSellPrice !== undefined) {
          const avgEntry = this.getAvgEntryPrice();
          const meetsProfitRequirement = !this.cfg.requireProfitAboveAvgEntry || (avgEntry <= 0 || currentBestBid >= avgEntry * 1.001);

          if (meetsProfitRequirement) {
            const targetRemainingQty = matchedStep.targetRemainingFraction * cycle.baselineHeldQty;
            const excessQty = Math.max(0, held - targetRemainingQty);
            const excessQuote = excessQty * currentBestBid;

            // Trigger if excess quote meets minimum notional or final full-exit
            if (excessQuote >= minNotional || (matchedStep.targetRemainingFraction === 0 && totalHeldQuote >= minNotional)) {
              const cooldownKey = `ioc_bracket_sell_step_${matchedStep.stepNum}`;
              const lastSellTime = this.orderCooldowns.get(cooldownKey) ?? 0;
              const globalSellCooldown = this.orderCooldowns.get("ioc_bracket_sell_global") ?? 0;
              const now = Date.now();

              // 10s cooldown per step, 3s global debounce
              if (now - lastSellTime > 10_000 && now - globalSellCooldown > 3_000) {
                this.orderCooldowns.set(cooldownKey, now);
                this.orderCooldowns.set("ioc_bracket_sell_global", now);

                let sellQty = matchedStep.targetRemainingFraction === 0
                  ? held
                  : Math.min(held, excessQty);

                const sellNotional = sellQty * currentBestBid;
                if (sellQty >= this.minQty && sellNotional >= minNotional) {
                  const actionLabel = numSellTranches === 1
                    ? `IOC Sell 100% Exit ($${sellNotional.toFixed(2)})`
                    : `IOC Sell Step ${matchedStep.stepNum}/${numSellTranches} ($${sellNotional.toFixed(2)})`;

                  this.log(
                    `🎯 [IOC BRACKET] Bid $${currentBestBid.toFixed(6)} >= Sell Target ${matchedStep.levelIndex + 1} ($${matchedSellPrice.toFixed(6)}) — executing ${actionLabel} for ${sellQty.toFixed(4)} ${this.baseAsset}`,
                  );
                  const ok = await this.sellTrancheIOC(sellQty, currentBestBid, actionLabel, matchedSellPrice);
                  if (ok) {
                    cycle.soldStepNums.add(matchedStep.stepNum);
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  private recalcStep(): void {
    const fresh = this.atrSource.isFresh?.() ?? true;
    if (!fresh) return;

    const atrPct = this.atrSource.atrPct();
    if (atrPct === undefined) return;

    const raw = atrPct * 10_000 * this.cfg.atrMultiplier;
    const clamped = Math.min(this.cfg.maxStepBps, Math.max(this.cfg.minStepBps, raw));
    this.stepBps = clamped;
  }

  /**
   * Execute an immediate IOC sell for a specific tranche / grid level whose target price was exceeded by market price.
   */
  private async sellTrancheIOC(
    qty: number,
    execPrice: number,
    levelName: string,
    targetPrice: number,
  ): Promise<boolean> {
    const actionLabel = levelName.startsWith("IOC") ? levelName : `IOC ${levelName}`;
    const held = this.baseHeld();
    if (held < this.minQty || qty < this.minQty) {
      return false;
    }
    const executeQty = roundToStep(Math.min(held, qty), this.stepSize || 0.0001, 4);
    if (executeQty < this.minQty) {
      return false;
    }
    const now = Date.now();
    // In IOC sell: price must NEVER be below targetPrice (Sell Level)
    const effectivePrice = Math.max(execPrice, targetPrice);
    const minNotional = Math.max(this.minNotional || 5.0, 5.0);
    const orderNotional = executeQty * effectivePrice;

    if (orderNotional < minNotional) {
      this.log(
        `⚠️ [MIN NOTIONAL GUARD] Cannot execute ${actionLabel}: Order value $${orderNotional.toFixed(2)} is below Binance minimum ($${minNotional.toFixed(2)}).`,
      );
      return false;
    }

    if (this.cfg.dryRun) {
      const oldTradePnl = this.tradeRealizedPnl;
      this.closeLots(executeQty, effectivePrice);
      const roundPnl = this.tradeRealizedPnl - oldTradePnl;
      this.log(
        `[dry-run] ⚡ ${actionLabel}: Sold ${executeQty.toFixed(4)} ${this.baseAsset} @ $${effectivePrice.toFixed(6)} (Target: $${targetPrice.toFixed(6)}) • Trade PnL: ${roundPnl >= 0 ? "+$" : "-$"}${Math.abs(roundPnl).toFixed(4)} | Net: ${this.realizedPnl >= 0 ? "+$" : "-$"}${Math.abs(this.realizedPnl).toFixed(4)}`,
      );
      this.emit({
        type: "order",
        data: {
          action: "SELL_FILL",
          price: effectivePrice,
          qty: executeQty,
          notional: executeQty * effectivePrice,
          notionalQuote: executeQty * effectivePrice,
          notionalUsdso: executeQty * effectivePrice,
          pnl: roundPnl,
          pnlQuote: roundPnl,
          pnlUsdso: roundPnl,
          levelDesc: actionLabel,
          reason: actionLabel,
          time: now,
          dryRun: true,
          maker: false,
          isIoc: true,
        },
      });
      this.saveState();
      this.emitTelemetryTick();
      return true;
    }

    // In live mode: Refresh wallet balance to ensure 100% accurate available balance
    await this.refreshWalletBalances();

    const minGasReserveBase = this.getEffectiveGasReserveBase();
    const availableBase = Math.max(0, this.walletBaseBalance - minGasReserveBase);

    if (availableBase < this.minQty) {
      this.log(
        `⚠️ [GAS GUARD] Cannot execute ${actionLabel}: Wallet has ${this.walletBaseBalance.toFixed(4)} ${this.baseAsset}, which is within the ${minGasReserveBase.toFixed(4)} ${this.baseAsset} gas safety reserve.`,
      );
      return false;
    }

    const finalQty = roundToStep(Math.min(executeQty, availableBase), this.stepSize || 0.0001, 4);
    if (finalQty < this.minQty) return false;

    try {
      // In CLOB IOC sell: limit price is targetPrice so it matches any bid >= targetPrice down to the target level
      // Setting limitPrice = targetPrice ensures on-chain CLOB will NEVER fill below the target price
      const limitPrice = targetPrice;
      const res = await this.binance.placeOrder({
        symbol: this.symbol,
        side: "SELL",
        type: "IOC",
        price: limitPrice,
        qty: finalQty,
      });

      const orderIdStr = res.orderId ? String(res.orderId) : (res.txHash ? String(res.txHash) : undefined);
      if (orderIdStr) {
        this.handledExitOrderIds.set(orderIdStr, Date.now());
      }

      // Check real executed fill quantity from Exchange
      const isConfirmedSuccess = res.status === "FILLED" || (res.txHash && res.status !== "CANCELED" && res.status !== "EXPIRED");
      const filledQty = typeof res.executedQty === "number" && !isNaN(res.executedQty) && res.executedQty > 0
        ? res.executedQty
        : (isConfirmedSuccess ? finalQty : 0);

      if (filledQty <= 0 && !isConfirmedSuccess) {
        this.log(
          `⚠️ [IOC UNFILLED] ${actionLabel} order #${orderIdStr || "N/A"} was not filled on exchange (status: ${res.status || "UNFILLED"}, executedQty: ${filledQty}/${finalQty}).`,
        );
        return false;
      }

      const actualQty = Math.min(finalQty, filledQty > 0 ? filledQty : finalQty);
      const oldTradePnl = this.tradeRealizedPnl;
      this.closeLots(actualQty, effectivePrice);
      const roundPnl = this.tradeRealizedPnl - oldTradePnl;

      this.log(
        `⚡ ON-CHAIN ${actionLabel}: Sold ${actualQty.toFixed(4)} ${this.baseAsset} @ $${effectivePrice.toFixed(6)} (Target: $${targetPrice.toFixed(6)}) • Trade PnL: ${roundPnl >= 0 ? "+$" : "-$"}${Math.abs(roundPnl).toFixed(4)} | Net: ${this.realizedPnl >= 0 ? "+$" : "-$"}${Math.abs(this.realizedPnl).toFixed(4)} (tx: ${res.txHash})`,
      );
      this.emit({
        type: "order",
        data: {
          action: "SELL_FILL",
          price: effectivePrice,
          qty: actualQty,
          notional: actualQty * effectivePrice,
          notionalQuote: actualQty * effectivePrice,
          notionalUsdso: actualQty * effectivePrice,
          pnl: roundPnl,
          pnlQuote: roundPnl,
          pnlUsdso: roundPnl,
          levelDesc: actionLabel,
          reason: actionLabel,
          time: now,
          dryRun: false,
          txHash: res.txHash,
          orderId: orderIdStr,
          maker: false,
          isIoc: true,
        },
      });
      if (res.txHash) {
        this.trackTxGas(res.txHash, actionLabel);
      }
      await this.refreshWalletBalances();
      this.lastObservedBaseBalance = this.walletBaseBalance;
      this.lastObservedQuoteBalance = this.walletQuoteBalance;
      this.saveState();
      this.emitTelemetryTick();
      return true;
    } catch (err) {
      this.log(`❌ ${actionLabel} failed: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Execute an immediate IOC buy for a specific tranche / grid level or aggregated tranches.
   */
  private async buyTrancheIOC(
    qty: number,
    execPrice: number,
    levelName: string,
    targetPrice: number,
    notionalQuote: number,
  ): Promise<boolean> {
    const actionLabel = levelName.startsWith("IOC") ? levelName : `IOC ${levelName}`;
    const minNotional = Math.max(this.minNotional || 5.0, 5.0);
    if (qty < this.minQty || notionalQuote < minNotional) {
      if (notionalQuote < minNotional) {
        this.log(
          `⚠️ [MIN NOTIONAL GUARD] Cannot execute ${actionLabel}: Buy budget $${notionalQuote.toFixed(2)} is below Binance minimum ($${minNotional.toFixed(2)}).`,
        );
      }
      return false;
    }
    const notionalUsdso = notionalQuote;
    const now = Date.now();
    // In IOC buy: effective price is strictly capped to targetPrice so cost NEVER exceeds Buy Level
    const effectivePrice = Math.min(execPrice, targetPrice);

    if (this.cfg.dryRun) {
      const rawBuyQty = notionalQuote / effectivePrice;
      const buyQty = roundToStep(rawBuyQty, this.stepSize || 0.0001, 4);
      if (buyQty < this.minQty) return false;
      this.processBuyFill({
        price: effectivePrice,
        qty: buyQty,
        levelDesc: actionLabel,
        logPrefix: "[dry-run] ",
        dryRun: true,
        isIoc: true,
      });
      this.saveState();
      this.emitTelemetryTick();
      return true;
    }

    // In live mode: Refresh wallet balance to ensure 100% accurate available balance
    await this.refreshWalletBalances();

    const availableBudgetQuote = Math.min(notionalQuote, this.walletQuoteBalance);
    const rawFinalQty = availableBudgetQuote / effectivePrice;
    const finalQty = roundToStep(rawFinalQty, this.stepSize || 0.0001, 4);
    if (finalQty < this.minQty) {
      this.log(`⚠️ [IOC BUY] Insufficient ${this.quoteAsset} balance ($${this.walletQuoteBalance.toFixed(2)} < $${notionalQuote.toFixed(2)})`);
      return false;
    }

    try {
      // In CLOB IOC buy: limit price is targetPrice so it matches any ask <= targetPrice
      // Setting limitPrice = targetPrice ensures on-chain CLOB will NEVER fill above the target buy level
      const limitPrice = targetPrice;
      const res = await this.binance.placeOrder({
        symbol: this.symbol,
        side: "BUY",
        type: "IOC",
        price: limitPrice,
        qty: finalQty,
      });

      const orderIdStr = res.orderId ? String(res.orderId) : (res.txHash ? String(res.txHash) : undefined);
      if (orderIdStr) {
        this.handledExitOrderIds.set(orderIdStr, Date.now());
      }

      // Check real executed fill quantity from Exchange
      const isConfirmedSuccess = res.status === "FILLED" || (res.txHash && res.status !== "CANCELED" && res.status !== "EXPIRED");
      const filledQty = typeof res.executedQty === "number" && !isNaN(res.executedQty) && res.executedQty > 0
        ? res.executedQty
        : (isConfirmedSuccess ? finalQty : 0);

      if (filledQty <= 0 && !isConfirmedSuccess) {
        this.log(
          `⚠️ [IOC UNFILLED] ${actionLabel} order #${orderIdStr || "N/A"} was not filled on exchange (status: ${res.status || "UNFILLED"}, executedQty: ${filledQty}/${finalQty}).`,
        );
        return false;
      }

      const actualQty = Math.min(finalQty, filledQty > 0 ? filledQty : finalQty);
      this.processBuyFill({
        price: effectivePrice,
        qty: actualQty,
        levelDesc: actionLabel,
        orderId: orderIdStr,
        txHash: res?.txHash,
        logPrefix: "⚡ ",
        dryRun: false,
        isIoc: true,
      });
      if (res?.txHash) {
        this.trackTxGas(res.txHash, actionLabel);
      }
      await this.refreshWalletBalances();
      this.lastObservedBaseBalance = this.walletBaseBalance;
      this.lastObservedQuoteBalance = this.walletQuoteBalance;
      this.saveState();
      this.emitTelemetryTick();
      return true;
    } catch (err) {
      this.log(`❌ ${actionLabel} failed: ${(err as Error).message}`);
      return false;
    }
  }

  private async sellAll(price: number, action: "SELL" | "CUT"): Promise<void> {
    const actionLabel = action === "CUT" ? "CUT LOSS (SELL ALL)" : "100% FULL EXIT (TAKE PROFIT)";

    // 1. Always cancel ALL resting open orders first so base asset is unlocked from limit sells and no buys occur
    if (this.openOrders.length > 0) {
      await this.cancelAllRestingOrders(undefined, `Cancelling open orders before ${actionLabel}`);
    }

    const held = this.baseHeld();
    if (held < this.minQty) {
      this.lots = [];
      this.saveState();
      return;
    }
    const now = Date.now();

    if (this.cfg.dryRun) {
      const oldTradePnl = this.tradeRealizedPnl;
      this.closeLots(held, price);
      const roundPnl = this.tradeRealizedPnl - oldTradePnl;
      this.log(
        `[dry-run] 🚨 ${actionLabel}: ${held.toFixed(4)} ${this.baseAsset} @ $${price.toFixed(6)} (Trade PnL: ${roundPnl >= 0 ? "+$" : "-$"}${Math.abs(roundPnl).toFixed(4)} | Net Total: ${this.realizedPnl >= 0 ? "+$" : "-$"}${Math.abs(this.realizedPnl).toFixed(4)})`,
      );
      this.emit({
        type: "order",
        data: {
          action: action === "CUT" ? "CUT" : "TAKE_PROFIT",
          price,
          qty: held,
          notional: held * price,
          notionalQuote: held * price,
          notionalUsdso: held * price,
          pnl: roundPnl,
          pnlQuote: roundPnl,
          pnlUsdso: roundPnl,
          levelDesc: actionLabel,
          reason: actionLabel,
          time: now,
          dryRun: true,
          maker: false,
          isIoc: true,
        },
      });
      this.saveState();
      this.emitTelemetryTick();
      return;
    }

    // 2. In live mode: Refresh wallet balance to ensure 100% accurate available balance
    await this.refreshWalletBalances();

    const minGasReserveBase = this.getEffectiveGasReserveBase();
    const availableBase = Math.max(0, this.walletBaseBalance - minGasReserveBase);

    if (held < this.minQty) {
      this.log(
        `🛑 [INVENTORY GUARD] ${actionLabel} aborted: Trading inventory is empty (${held.toFixed(4)} ${this.baseAsset}). Refusing to sell wallet gas balance (${this.walletBaseBalance.toFixed(4)} ${this.baseAsset}).`,
      );
      this.lots = [];
      this.saveState();
      return;
    }

    if (availableBase < this.minQty) {
      this.log(
        `⚠️ [GAS GUARD] Cannot execute ${actionLabel}: Wallet has ${this.walletBaseBalance.toFixed(4)} ${this.baseAsset}, which is within the ${minGasReserveBase.toFixed(4)} ${this.baseAsset} gas safety reserve. Standing by for balance.`,
      );
      return;
    }

    // Liquidate trading inventory: physical available trading balance above gas safety reserve
    // Cap at availableBase so on-chain transactions never attempt to spend non-existent tokens
    const rawExecuteQty = Math.min(held, availableBase > 0 ? availableBase : held);
    const executeQty = roundToStep(rawExecuteQty, this.stepSize || 0.0001, 4);
    const minNotional = Math.max(this.minNotional || 5.0, 5.0);
    const orderNotional = executeQty * price;

    if (executeQty < this.minQty || orderNotional < minNotional) {
      this.log(
        `⚠️ [MIN NOTIONAL GUARD] Cannot execute ${actionLabel}: Order quantity ${executeQty.toFixed(4)} or value $${orderNotional.toFixed(2)} is below exchange minimum.`,
      );
      this.lots = [];
      this.lockedChannel = undefined;
      this.saveState();
      return;
    }

    try {
      const res = await this.binance.placeOrder({
        symbol: this.symbol,
        side: "SELL",
        type: "IOC",
        price,
        qty: executeQty,
      });
      const orderIdStr = res.orderId ? String(res.orderId) : (res.txHash ? String(res.txHash) : undefined);
      if (orderIdStr) {
        this.handledExitOrderIds.set(orderIdStr, Date.now());
      }

      // Check real executed fill quantity from Exchange
      // Supports both Binance Spot response and On-Chain EVM (DreamDEX) receipts
      const isConfirmedSuccess = res.status === "FILLED" || (res.txHash && res.status !== "CANCELED" && res.status !== "EXPIRED");
      const filledQty = typeof res.executedQty === "number" && !isNaN(res.executedQty) && res.executedQty > 0
        ? res.executedQty
        : (isConfirmedSuccess ? executeQty : 0);

      if (filledQty <= 0 && !isConfirmedSuccess) {
        this.log(
          `⚠️ [IOC UNFILLED] ${actionLabel} order #${orderIdStr || "N/A"} was not filled on exchange (status: ${res.status || "UNFILLED"}, executedQty: ${filledQty}/${executeQty}). Keeping inventory lots intact.`,
        );
        await this.refreshWalletBalances();
        this.saveState();
        return;
      }

      const actualQty = Math.min(executeQty, filledQty > 0 ? filledQty : executeQty);
      const oldTradePnl = this.tradeRealizedPnl;
      this.closeLots(actualQty, price);
      const roundPnl = this.tradeRealizedPnl - oldTradePnl;
      this.log(
        `🚨 ON-CHAIN ${actionLabel}: ${actualQty.toFixed(4)} ${this.baseAsset} @ $${price.toFixed(6)} (Trade PnL: ${roundPnl >= 0 ? "+$" : "-$"}${Math.abs(roundPnl).toFixed(4)} | Net Total: ${this.realizedPnl >= 0 ? "+$" : "-$"}${Math.abs(this.realizedPnl).toFixed(4)}) (tx: ${res.txHash || orderIdStr || "N/A"})`,
      );
      this.emit({
        type: "order",
        data: {
          action: action === "CUT" ? "CUT" : "TAKE_PROFIT",
          price,
          qty: actualQty,
          notional: actualQty * price,
          notionalQuote: actualQty * price,
          notionalUsdso: actualQty * price,
          pnl: roundPnl,
          pnlQuote: roundPnl,
          pnlUsdso: roundPnl,
          levelDesc: actionLabel,
          reason: actionLabel,
          time: now,
          dryRun: false,
          txHash: res.txHash,
          orderId: orderIdStr,
          maker: false,
          isIoc: true,
        },
      });
      if (res.txHash) {
        this.trackTxGas(res.txHash, actionLabel);
      }
      await this.refreshWalletBalances();
      if (this.walletBaseBalance - minGasReserveBase <= (this.minQty || 0.0001)) {
        this.lots = [];
        this.lockedChannel = undefined;
      }
      this.saveState();
    } catch (err) {
      this.log(`⚠️ On-chain ${actionLabel} failed: ${(err as Error).message}`);
      await this.refreshWalletBalances();
      // If balance is already depleted after an on-chain cut loss attempt, clear lots to avoid infinite loop
      if (this.walletBaseBalance - minGasReserveBase <= (this.minQty || 0.0001)) {
        this.lots = [];
        this.lockedChannel = undefined;
        this.saveState();
      }
    }
  }

  public getAvgEntryPrice(): number {
    const totalQty = this.baseHeld();
    if (totalQty <= 0) return 0;
    const totalCost = this.lots.reduce((s, l) => s + l.price * l.qty, 0);
    return totalCost / totalQty;
  }

  private closeLots(qty: number, exitPrice: number): void {
    let remaining = qty;
    const mode = this.cfg.sellProfitMode || (this.cfg.requireProfitAboveAvgEntry ? "PORTFOLIO_AVG_PROFIT" : "GRID_CASHFLOW");

    if (mode === "LOT_BASED_PROFIT") {
      // In LOT_BASED_PROFIT: close lots that are in profit first (lowest entry price first)
      const profitableLots = this.lots
        .filter((l) => l.price <= exitPrice)
        .sort((a, b) => a.price - b.price);

      for (const lot of profitableLots) {
        if (remaining <= 1e-12) break;
        const take = Math.min(lot.qty, remaining);
        this.tradeRealizedPnl += (exitPrice - lot.price) * take;
        this.realizedPnl = this.tradeRealizedPnl - this.totalGasDeductedQuote;
        lot.qty -= take;
        remaining -= take;
      }
      this.lots = this.lots.filter((l) => l.qty > 1e-12);
    }

    // Close remaining with standard FIFO
    while (remaining > 1e-12 && this.lots.length > 0) {
      const lot = this.lots[0]!;
      const take = Math.min(lot.qty, remaining);
      this.tradeRealizedPnl += (exitPrice - lot.price) * take;
      this.realizedPnl = this.tradeRealizedPnl - this.totalGasDeductedQuote;
      lot.qty -= take;
      remaining -= take;
      if (lot.qty <= 1e-12) this.lots.shift();
    }
    // If remaining inventory is less than minQty (e.g. 0.0001 ETH) or 1e-5, treat position as completely flat/closed
    const dustThreshold = Math.max(this.minQty || 0.0001, 0.0001);
    if (this.baseHeld() < dustThreshold) {
      this.lots = [];
      this.lockedChannel = undefined;
      this.iocBracketSellCycle = undefined;
    }
  }

  private baseHeld(): number {
    return this.lots.reduce((s, l) => s + l.qty, 0);
  }

  /**
   * Asynchronously fetch transaction receipt to track gas fee spent
   */
  public async trackTxGas(txHash?: string, label?: string): Promise<void> {
    return;
  }
}
