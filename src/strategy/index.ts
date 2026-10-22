/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// Channel Grid Strategy (Dow Market Structure Driven):
// Modular Strategy Orchestrator Engine

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BinanceClient, type BinanceSymbolInfo, roundToStep, roundToTick } from "../exchange/binance/client.js";
import type { BookTickerData, BinanceExecutionReport, BinanceAccountUpdate } from "../exchange/binance/feed.js";
import type { IExchangeClient, ExchangeSymbolInfo } from "../exchange/types.js";
import { ORDER_TYPE, shiftBps, spreadBps, createStatusLogger } from "../utils.js";
import type { Config } from "../config.js";
import type { AtrSource } from "../types.js";
import type { DowStructureEngine, DowStructure, GridZone, Candle } from "../market-structure.js";
import { BotDatabase, getDatabase, type StrategyStateRecord, type TradeRecord, type OrderActivityRecord, type GasLogRecord, type LockedChannel } from "../db.js";

import type { Lot, OpenOrder, StrategyEvent, GridPersistedState, ConfirmedChannelState, IStrategyHost } from "./types.js";
import { LotTracker } from "./lot-tracker.js";
import { RiskManager } from "./risk-manager.js";
import { BuyOrderSynchronizer } from "./buy-sync.js";
import { SellOrderSynchronizer } from "./sell-sync.js";
import { OrderExecutor } from "./order-executor.js";

export type { Lot, OpenOrder, StrategyEvent, GridPersistedState };

export class DynamicGrid implements IStrategyHost {
  public readonly lotTracker: LotTracker;
  public readonly orderExecutor: OrderExecutor;
  public readonly riskManager: RiskManager;
  public readonly buySync: BuyOrderSynchronizer;
  public readonly sellSync: SellOrderSynchronizer;

  public db: BotDatabase;
  public lots: Lot[] = [];
  public openOrders: OpenOrder[] = [];
  public cancelledOrderIds = new Map<string, number>(); // orderId → timestamp of cancellation
  public handledExitOrderIds = new Map<string, number>(); // orderId → timestamp of exit/IOC execution
  public inFlightOrders = new Set<string>();
  public orderCooldowns = new Map<string, number>();
  public processedGasTxHashes = new Set<string>();
  public realizedPnl = 0;
  public tradeRealizedPnl = 0;
  public totalGasDeductedBase = 0;
  public totalGasDeductedQuote = 0;
  public accumulatedGasBase = 0;
  public accumulatedGasQuote = 0;
  public totalGasSpentBase = 0;
  public totalGasSpentQuote = 0;
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
  public totalTxCount = 0;
  public lastRefPrice = 0.2;
  public lastBestBid?: number;
  public lastBestAsk?: number;
  public stuckSince?: number;
  public waitingForHigherLow = false;
  public isFlatChannelShiftWaiting = false;
  public isTrendSupportExitActive = false;
  public trendSupportBreakPrice?: number;
  public lastTrendSupportBreakKey?: string;
  public wasFlatCashLastTick = true;
  public lastEvaluatedFloor?: number;
  public lastEvaluatedCeil?: number;
  public breakdownFloorPrice?: number;
  public breakdownLowPrice?: number;
  public breakdownBuyLevel2Price?: number;
  public breakdownTime?: number;
  public lastResolvedDumpLowPrice?: number;
  public breakdownCandleTimes = new Set<number>();
  public lastCutLossTime?: number;
  public bufferBreakStartTime?: number;
  public cutLossStage1Executed = false;
  public cutLossStage1Price?: number;
  public cutLossStage1CandleTime?: number;
  public lastBuyFillTime = 0;
  public lastBuyFillPrice = 0;
  public lastBuyFillCandleTime = 0;
  public postCutSingleTrancheOnly = false;
  public sellOrdersActive = true;
  private sellZoneTransitionCandleTime?: number;
  public buyOrdersActive = true;
  public needsSellRebalance = true;
  public needsBuyRebalance = true;
  public lastDynamicBounds?: {
    lowerBound: number;
    upperBound: number;
    centerPrice: number;
    buyLevels: number[];
    sellLevels: number[];
  };
  public confirmedChannel?: {
    candleTime: number;
    lowerBound: number;
    upperBound: number;
    centerPrice: number;
    cutLossBound: number;
    rawFloorPrice: number;
    buyLevels: number[];
    sellLevels: number[];
    dow?: DowStructure;
    gridZone?: GridZone;
    calculatedAt: number;
  };
  public pendingConfirmedChannelUpdate = false;
  public lockedChannel?: LockedChannel;
  private lastActivePeakTime?: number;
  private lastActivePeakPrice?: number;
  private lastActiveValleyTime?: number;
  private lastActiveValleyPrice?: number;
  /** State machine for IOC Bracket Sell distribution cycle */
  public iocBracketSellCycle?: {
    baselineHeldQuote: number;
    baselineHeldQty: number;
    numSellTranches: number;
    soldStepNums: Set<number>;
  };
  /** Indices of Sell Targets (0..4) that have already been executed/sold in the current inventory wave */
  public soldSellIndices = new Set<number>();
  private lastTelemetryData?: any;
  private lastHudLogTime = 0;
  private readonly hudLogIntervalMs = 5_000;
  private tickCount = 0;
  public isPaused = true;
  public isSqueezePaused = false;
  public isDowntrendDropPaused = false;
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
  public qtyPrecision: number;
  public pricePrecision: number;
  public minNotional: number;

  /** On-chain / exchange wallet balance state */
  private walletAddress = "";
  public walletBaseBalance = 0;
  public walletQuoteBalance = 0;
  public walletBaseLocked = 0;
  public walletQuoteLocked = 0;
  public walletBaseTotal = 0;
  public walletQuoteTotal = 0;
  public get walletSomiBalance(): number { return this.walletBaseBalance; }
  public set walletSomiBalance(v: number) { this.walletBaseBalance = v; }
  public get walletUsdsoBalance(): number { return this.walletQuoteBalance; }
  public set walletUsdsoBalance(v: number) { this.walletQuoteBalance = v; }
  public lastObservedBaseBalance = 0;
  public lastObservedQuoteBalance = 0;
  private get lastObservedSomiBalance(): number { return this.lastObservedBaseBalance; }
  private set lastObservedSomiBalance(v: number) { this.lastObservedBaseBalance = v; }
  private get lastObservedUsdsoBalance(): number { return this.lastObservedQuoteBalance; }
  private set lastObservedUsdsoBalance(v: number) { this.lastObservedQuoteBalance = v; }

  /**
   * Helper to compute total portfolio equity (Quote value), combining free + locked balances
   */
  public getTotalPortfolioValueQuote(refP: number): number {
    const totalBaseQty = this.walletBaseTotal > 0
      ? this.walletBaseTotal
      : (this.walletBaseBalance + this.openOrders.filter((o) => !o.isBid).reduce((sum, o) => sum + (o.qty || 0), 0));
    const totalQuoteVal = this.walletQuoteTotal > 0
      ? this.walletQuoteTotal
      : (this.walletQuoteBalance + this.openOrders.filter((o) => o.isBid).reduce((sum, o) => sum + (o.notionalQuote || (o.price * o.qty) || 0), 0));
    return (totalBaseQty * refP) + totalQuoteVal;
  }

  /** Real-time WebSocket Book Ticker cache */
  public wsBookTicker?: BookTickerData;
  private lastPeriodicSyncTs = 0;
  private readonly periodicSyncIntervalMs = 30_000; // Background sanity check every 30s instead of 200ms!

  /** Throttled status logger */
  public readonly status: (msg: string) => void;

  constructor(
    public binance: IExchangeClient,
    private symbolInfo: ExchangeSymbolInfo,
    public readonly cfg: Config,
    public atrSource: AtrSource,
    public readonly log: (msg: string, extra?: unknown) => void,
    public readonly dowEngine?: DowStructureEngine,
    public readonly localTrendEngine?: DowStructureEngine,
  ) {
    this.symbol = symbolInfo.symbol;
    this.baseAsset = symbolInfo.baseAsset;
    this.quoteAsset = symbolInfo.quoteAsset;
    this.minQty = symbolInfo.minQty;
    this.stepSize = symbolInfo.stepSize;
    this.tickSize = symbolInfo.tickSize;
    this.qtyPrecision = symbolInfo.qtyPrecision ?? 4;
    this.pricePrecision = symbolInfo.pricePrecision ?? 6;
    this.minNotional = symbolInfo.minNotional;

    this.status = createStatusLogger(log);
    this.lotTracker = new LotTracker(this);
    this.orderExecutor = new OrderExecutor(this, this.lotTracker);
    this.riskManager = new RiskManager(this);
    this.buySync = new BuyOrderSynchronizer(this, this.lotTracker);
    this.sellSync = new SellOrderSynchronizer(this, this.lotTracker);
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
    this.wireExchangeGasListener(this.binance);
  }

  private wireExchangeGasListener(client: IExchangeClient): void {
    // Strictly isolate CEX vs DEX:
    // Binance (CEX): No on-chain gas fees, no gas compensation, no gas listener.
    if (!client || !client.hasGasFees) {
      return;
    }

    // DreamDEX (DEX): Wire authoritative gas listener for all on-chain transactions
    client.onGasSpent = (feeSomi: number, label: string, txHash?: string) => {
      if (!feeSomi || feeSomi <= 0) return;

      const normTx = (txHash || "").trim().toLowerCase();
      if (normTx && this.processedGasTxHashes.has(normTx)) {
        return;
      }
      if (normTx) {
        this.processedGasTxHashes.add(normTx);
        if (this.processedGasTxHashes.size > 2000) {
          const first = this.processedGasTxHashes.values().next().value;
          if (first) this.processedGasTxHashes.delete(first);
        }
      }

      const isSomiBase = this.baseAsset.toUpperCase() === "SOMI";
      if (isSomiBase) {
        this.accumulatedGasBase += feeSomi;
        this.totalGasSpentBase += feeSomi;
      }
      // For non-SOMI base assets (e.g. WBTC, WETH, USDC.e), gas is paid in SOMI, not base asset.
      // Use SOMI price (~$0.20) rather than multiplying SOMI fee by base asset price ($65,000 for WBTC).
      const somiPrice = isSomiBase ? (this.lastRefPrice || this.getAvgEntryPrice() || 0.20) : 0.20;
      const feeQuote = feeSomi * somiPrice;
      this.accumulatedGasQuote += feeQuote;
      this.totalGasSpentQuote += feeQuote;
      this.totalTxCount++;

      this.log(
        `⛽ [DEX GAS TRACKED] ${label || "On-Chain Op"}${txHash ? ` (${txHash.slice(0, 10)}...)` : ""}: Spent ${feeSomi.toFixed(5)} SOMI (~$${feeQuote.toFixed(4)}) | Total uncompensated gas: ${this.accumulatedGasBase.toFixed(5)} ${isSomiBase ? "SOMI" : this.baseAsset}`,
      );
      if (txHash && typeof (this.db as any).updateTxGas === "function") {
        try {
          (this.db as any).updateTxGas(txHash, {
            gasUsed: 0,
            gasSomi: feeSomi,
            gasUsdso: feeQuote,
          });
        } catch {}
      }
      this.saveState();
      this.emitTelemetryTick();
      if (txHash) {
        this.emit({
          type: "order_gas",
          data: {
            txHash,
            gasFeeBase: isSomiBase ? feeSomi : 0,
            gasFeeQuote: feeQuote,
            gasFeeSomi: feeSomi,
            gasFeeUsdso: feeQuote,
          },
        });
      }
    };
  }

  public isSwitchingSymbol = false;

  public setSwitchingSymbol(switching: boolean): void {
    this.isSwitchingSymbol = switching;
  }

  /**
   * Sweeps and cancels any orphan open BUY orders on other Binance symbols that lock the current quoteAsset (e.g. FDUSD/USDT).
   */
  public async sweepOrphanQuoteOrders(): Promise<number> {
    if (this.cfg.dryRun || !this.binance.hasCredentials() || this.binance.exchangeName !== "binance") {
      return 0;
    }
    try {
      const allOpen = await this.binance.getOpenOrders("");
      const activeSymUpper = (this.symbol || "").toUpperCase();
      const quoteUpper = (this.quoteAsset || "").toUpperCase();
      if (!quoteUpper) return 0;

      const orphanOrders = allOpen.filter((o) => {
        const sym = (o.symbol || "").toUpperCase();
        return sym && sym !== activeSymUpper && o.side === "BUY" && sym.endsWith(quoteUpper);
      });

      if (orphanOrders.length === 0) return 0;

      let cancelled = 0;
      const now = Date.now();
      for (const ord of orphanOrders) {
        const idStr = String(ord.orderId);
        this.cancelledOrderIds.set(idStr, now);
        try {
          await this.binance.cancelOrder(ord.symbol, idStr);
          cancelled++;
          const lockedVal = Math.max(0, ord.origQty - ord.executedQty) * ord.price;
          this.log(
            `🧹 [ORPHAN ORDER SWEEP] Cancelled lingering BUY order #${idStr} on ${ord.symbol} ($${lockedVal.toFixed(2)} ${quoteUpper}) to free locked ${quoteUpper} balance!`,
          );
        } catch (err) {
          this.log(`⚠️ [ORPHAN ORDER SWEEP] Failed to cancel order #${idStr} on ${ord.symbol}: ${(err as Error).message}`);
        }
      }
      return cancelled;
    } catch (err) {
      this.log(`⚠️ [ORPHAN ORDER SWEEP] Could not query cross-symbol open orders: ${(err as Error).message}`);
      return 0;
    }
  }

  /**
   * Cancels all resting orders on the current symbol (and sweeps any orphan quote-locking orders)
   * BEFORE switching to a new trading pair or exchange.
   */
  public async prepareForSymbolSwitch(nextSymbolLabel?: string): Promise<void> {
    const prevSymbol = this.symbol;
    const reason = `Switching trading pair from ${prevSymbol} to ${nextSymbolLabel || "new pair"}`;
    this.log(`🧹 [PAIR SWITCH] Preparing to switch ${prevSymbol} -> ${nextSymbolLabel || "new pair"}: cancelling all open orders...`);

    const now = Date.now();
    for (const o of this.openOrders) {
      if (o.onChainOrderId) this.cancelledOrderIds.set(o.onChainOrderId, now);
    }

    if (this.openOrders.length > 0) {
      await this.cancelAllRestingOrders(undefined, reason);
    }

    if (!this.cfg.dryRun && this.binance.hasCredentials()) {
      try {
        await this.binance.cancelAllOpenOrders(prevSymbol);
        this.log(`🗑️ [PAIR SWITCH] Purged all open exchange orders on ${prevSymbol}`);
      } catch (err) {
        this.log(`⚠️ [PAIR SWITCH] Exchange cancelAllOpenOrders(${prevSymbol}) notice: ${(err as Error).message}`);
      }
      await this.sweepOrphanQuoteOrders();
    }

    this.openOrders = [];
    this.inFlightOrders.clear();
    this.orderCooldowns.clear();
    this.saveState(true);
  }

  public updateExchangeClient(newClient: IExchangeClient, info?: ExchangeSymbolInfo, newAtrSource?: AtrSource): void {
    if (this.cfg.persistState) {
      this.saveState(true);
    }
    this.binance = newClient;
    this.cfg.exchange = newClient.exchangeName as "binance" | "dreamdex";
    this.db.setSetting("exchange", this.cfg.exchange);
    this.wireExchangeGasListener(newClient);
    if (info) {
      this.updateSymbolInfo(info, newAtrSource);
    } else {
      if (newAtrSource) {
        this.atrSource = newAtrSource;
      }
      this.loadState();
    }
    this.log(`🔄 [strategy] Switched exchange client to: ${newClient.exchangeName.toUpperCase()}`);
  }

  public updateSymbolInfo(info: ExchangeSymbolInfo, newAtrSource?: AtrSource): void {
    if (this.cfg.persistState) {
      this.saveState(true);
    }
    if (newAtrSource) {
      this.atrSource = newAtrSource;
    }
    this.lastRefPrice = undefined;
    this.lastBestBid = undefined;
    this.lastBestAsk = undefined;
    this.wsBookTicker = undefined;
    this.lastPeriodicSyncTs = 0;
    this.lastDynamicBounds = undefined;
    this.confirmedChannel = undefined;
    this.pendingConfirmedChannelUpdate = true;
    this.lockedChannel = undefined;
    this.waitingForHigherLow = false;
    this.isFlatChannelShiftWaiting = false;
    this.lastEvaluatedFloor = undefined;
    this.lastEvaluatedCeil = undefined;
    this.breakdownFloorPrice = undefined;
    this.breakdownLowPrice = undefined;
    this.breakdownBuyLevel2Price = undefined;
    this.breakdownTime = undefined;
    this.lastResolvedDumpLowPrice = undefined;
    this.iocBracketSellCycle = undefined;
    this.bufferBreakStartTime = undefined;
    this.cutLossStage1Executed = false;
    this.cutLossStage1Price = undefined;
    this.cutLossStage1CandleTime = undefined;
    this.needsBuyRebalance = true;
    this.needsSellRebalance = true;
    this.inFlightOrders.clear();
    this.orderCooldowns.clear();

    this.symbolInfo = info;
    this.symbol = info.symbol;
    this.cfg.symbol = info.symbol;
    this.cfg.binanceSymbol = info.symbol.toLowerCase().replace(/[\/\-_:]/g, "");
    this.baseAsset = info.baseAsset;
    this.quoteAsset = info.quoteAsset;
    this.minQty = info.minQty;
    this.stepSize = info.stepSize;
    this.tickSize = info.tickSize;
    this.qtyPrecision = info.qtyPrecision ?? 4;
    this.pricePrecision = info.pricePrecision ?? 6;
    this.minNotional = info.minNotional;
    this.db.setSetting("symbol", this.symbol);
    this.loadState();
    this.log(`🔄 [strategy] Updated trading pair to ${this.symbol} (${this.baseAsset}/${this.quoteAsset})`);
  }

  /**
   * Handle confirmed candle close from WebSocket Kline stream.
   * Prompts recalculation of confirmed channel bounds when adjustChannelOnClosedOnly is enabled.
   */
  public onCandleClosed(candle: Candle): void {
    this.pendingConfirmedChannelUpdate = true;
  }

  /**
   * Handle real-time Book Ticker from WebSocket stream (<symbol>@bookTicker).
   * Provides 0-weight instantaneous bestBid and bestAsk updates.
   */
  public handleWsBookTicker(book: BookTickerData): void {
    this.wsBookTicker = book;
    if (book.bestBid > 0) this.lastBestBid = book.bestBid;
    if (book.bestAsk > 0) this.lastBestAsk = book.bestAsk;
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
    const clientOrderId = report.clientOrderId ? String(report.clientOrderId) : "";
    if (this.handledExitOrderIds.has(idStr) || (clientOrderId && this.handledExitOrderIds.has(clientOrderId))) {
      this.log(`⚡ [WS EXEC] Order #${idStr} (${clientOrderId}) was already handled synchronously (${status}) — skipping duplicate fill processing`);
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
      cutLossOnBufferOnly: this.cfg.cutLossOnBufferOnly !== false,
      cutLossBufferDelaySeconds: this.cfg.cutLossBufferDelaySeconds ?? 60,
      takeProfitAtUpperBound: this.cfg.takeProfitAtUpperBound,
      dowTrendFilter: this.cfg.dowTrendFilter,
      trendlineFilter: this.cfg.trendlineFilter,
      enableBuyLevel2Recovery: this.cfg.enableBuyLevel2Recovery,
      enableBuyBelowSellLevel1: this.cfg.enableBuyBelowSellLevel1 !== false,
      enableSellAboveBuyLevel1: this.cfg.enableSellAboveBuyLevel1 !== false,
      orderExecutionMode: this.cfg.orderExecutionMode ?? "IOC_BRACKET",
      iocSlippagePct: this.cfg.iocSlippagePct ?? 0.35,
      enableBuyAboveTrendSupport: this.cfg.enableBuyAboveTrendSupport !== false,
      enableExitOnTrendSupportBreak: this.cfg.enableExitOnTrendSupportBreak !== false,
      enableSellBelowTrendResistance: this.cfg.enableSellBelowTrendResistance !== false,
      enableSellAtRealCeiling: this.cfg.enableSellAtRealCeiling !== false,
      sellProfitMode: this.cfg.sellProfitMode || (this.cfg.requireProfitAboveAvgEntry ? "PORTFOLIO_AVG_PROFIT" : "GRID_CASHFLOW"),
      requireProfitAboveAvgEntry: this.cfg.requireProfitAboveAvgEntry === true,
      enableLaggardSnipe: this.cfg.enableLaggardSnipe,
      enableLaggardGuard: this.cfg.enableLaggardGuard,
      laggardThresholdPct: this.cfg.laggardThresholdPct,
      channelMode: this.cfg.channelMode,
      minChannelWidthPct: this.cfg.minChannelWidthPct,
      maxChannelWidthPct: this.cfg.maxChannelWidthPct,
      enableNarrowChannelCollapse: this.cfg.enableNarrowChannelCollapse !== false,
      narrowChannelThresholdPct: this.cfg.narrowChannelThresholdPct ?? 1.2,
      narrowChannelBuyBufferPct: this.cfg.narrowChannelBuyBufferPct ?? 0.05,
      narrowChannelSellBufferPct: this.cfg.narrowChannelSellBufferPct ?? 0.05,
      lockChannelInPosition: this.cfg.lockChannelInPosition !== false,
      adjustChannelOnClosedOnly: this.cfg.adjustChannelOnClosedOnly !== false,
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
      binanceApiKey: this.cfg.binanceApiKey ? "******" : "",
      binanceApiSecret: this.cfg.binanceApiSecret ? "******" : "",
      binanceBaseUrl: this.cfg.binanceBaseUrl || "https://api.binance.com",
      binanceWsBase: this.cfg.binanceWsBase || "wss://stream.binance.com:9443",
      dreamdexPrivateKey: this.cfg.dreamdexPrivateKey ? "******" : "",
      dreamdexRpcUrl: this.cfg.dreamdexRpcUrl || "https://api.infra.mainnet.somnia.network",
      minGasReserveSomi: this.cfg.minGasReserveSomi ?? 2.0,
      timezone: this.cfg.timezone || "Asia/Bangkok",
      dashboardPort: this.cfg.dashboardPort ?? 3333,
      enabledBuyLevels: Array.isArray(this.cfg.enabledBuyLevels) ? this.cfg.enabledBuyLevels : [true, true, true, true, true],
      enabledSellTargets: Array.isArray(this.cfg.enabledSellTargets) ? this.cfg.enabledSellTargets : [true, true, true, true, true],
      buyLevelPcts: Array.isArray(this.cfg.buyLevelPcts) ? this.cfg.buyLevelPcts : [42, 32, 22, 12, 2],
      sellLevelPcts: Array.isArray(this.cfg.sellLevelPcts) ? this.cfg.sellLevelPcts : [52, 62, 72, 82, 92],
      buySizingMode: this.cfg.buySizingMode ?? "PYRAMID",
      buyLevelWeights: Array.isArray(this.cfg.buyLevelWeights) ? this.cfg.buyLevelWeights : [10, 15, 20, 25, 30],
      minNetProfitPct: this.cfg.minNetProfitPct ?? 0.25,
      breakevenEscapeProfitPct: this.cfg.breakevenEscapeProfitPct ?? 0.06,
      maxActiveMakerBuys: this.cfg.maxActiveMakerBuys ?? 2,
      enableLhDynamicEscape: this.cfg.enableLhDynamicEscape !== false,
      enableTwoStageCutLoss: this.cfg.enableTwoStageCutLoss !== false,
      cutLossStage2Multiplier: this.cfg.cutLossStage2Multiplier ?? 2.0,
    };
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

  public getIntervalMs(): number {
    return this.cfg.intervalMs ?? 2000;
  }

  /**
   * Returns the normalized fraction (0..1) of maxInventoryQuote allocated to each buy level (0..4).
   * Disabled levels receive 0. Active levels sum to 1.0.
   */
  public getBuyLevelWeightFractions(enabledBuys?: boolean[], numLevels = 5, forceFirstActive = false): number[] {
    const enabled = Array.isArray(enabledBuys)
      ? enabledBuys
      : (Array.isArray(this.cfg.enabledBuyLevels) ? this.cfg.enabledBuyLevels : [true, true, true, true, true]);
    if (numLevels === 1) {
      return enabled.some(Boolean) ? [1.0] : [0.0];
    }
    const isPyramid = (this.cfg.buySizingMode ?? "PYRAMID") === "PYRAMID";
    const rawWeights = Array.isArray(this.cfg.buyLevelWeights) && this.cfg.buyLevelWeights.length >= 5
      ? this.cfg.buyLevelWeights
      : [10, 15, 20, 25, 30];
    const weights: number[] = [];
    let totalWeight = 0;
    for (let i = 0; i < numLevels; i++) {
      const isEnabled = (i === 0 && forceFirstActive) ? enabled.some(Boolean) : (enabled[i] !== false);
      const w = isEnabled ? (isPyramid ? Math.max(1, Number(rawWeights[i]) || 10) : 1) : 0;
      weights.push(w);
      totalWeight += w;
    }
    if (totalWeight <= 0) return weights.map(() => 0);
    return weights.map((w) => w / totalWeight);
  }

  /**
   * Returns the cumulative holding fraction (0..1) of maxInventoryQuote when price reaches down to buy level `upToIdx`.
   */
  public getCumulativeBuyTargetFraction(upToIdx: number, enabledBuys?: boolean[], numLevels = 5, forceFirstActive = false): number {
    const fractions = this.getBuyLevelWeightFractions(enabledBuys, numLevels, forceFirstActive);
    let sum = 0;
    for (let i = 0; i <= Math.min(upToIdx, fractions.length - 1); i++) {
      sum += fractions[i] ?? 0;
    }
    return Math.min(1.0, sum);
  }

  /**
   * Returns the minimum net profit multiplier (e.g. 1.0025 for 0.25% minNetProfitPct) required for profitable exits.
   */
  public getMinProfitMultiplier(): number {
    const pct = Math.max(0.05, Number(this.cfg.minNetProfitPct ?? 0.25));
    return 1 + pct / 100;
  }

  /**
   * Checks if an open lot is already held near this grid level.
   * Proximity tolerance is dynamically calculated to be well below half the distance to the nearest
   * adjacent grid level (max 35% of adjacent step, capped at 0.15%), preventing adjacent levels from falsely blocking each other.
   * If expectedTrancheQty is provided, allows re-buying if the lot has been mostly liquidated (remaining < 40% of tranche).
   */
  public hasLotNearLevel(levelPrice: number, levelIdx: number, levels: number[], expectedTrancheQty?: number): boolean {
    return this.lotTracker.hasLotNearLevel(levelPrice, levelIdx, levels, expectedTrancheQty);
  }

  /**
   * Helper: Match levelDesc or price to find which sell target index (0..4) is being executed.
   */
  private findSellLevelIndex(levelDesc?: string, price?: number): number {
    if (levelDesc) {
      for (let i = 0; i < 5; i++) {
        if (
          levelDesc.includes(`Sell Target ${i + 1}`) ||
          levelDesc.includes(`Target ${i + 1}`) ||
          levelDesc.includes(`Sell Level ${i + 1}`)
        ) {
          return i;
        }
      }
    }
    const bounds = this.confirmedChannel || this.lastDynamicBounds;
    const sellLevels = bounds?.sellLevels ?? [];
    if (price && sellLevels.length > 0) {
      let closestIdx = -1;
      let minDiff = Infinity;
      for (let i = 0; i < sellLevels.length; i++) {
        const diff = Math.abs(sellLevels[i] - price) / price;
        if (diff < minDiff) {
          minDiff = diff;
          closestIdx = i;
        }
      }
      if (closestIdx >= 0 && minDiff <= 0.0025) {
        return closestIdx;
      }
    }
    return -1;
  }

  /**
   * Rounds a price to exchange tickSize and pricePrecision.
   */
  public roundPrice(price: number): number {
    if (!price || !Number.isFinite(price)) return 0;
    const tick = this.tickSize && this.tickSize > 0 ? this.tickSize : (1 / Math.pow(10, this.pricePrecision || 2));
    return roundToTick(price, tick, this.pricePrecision);
  }

  /**
   * Rounds a quantity to exchange stepSize and qtyPrecision.
   */
  public roundQty(qty: number): number {
    if (!qty || !Number.isFinite(qty)) return 0;
    const step = this.stepSize && this.stepSize > 0 ? this.stepSize : (1 / Math.pow(10, this.qtyPrecision || 4));
    return roundToStep(qty, step, this.qtyPrecision);
  }

  /**
   * Formats a price to exchange pricePrecision string.
   */
  public formatPrice(price: number): string {
    return this.roundPrice(price).toFixed(this.pricePrecision);
  }

  /**
   * Formats a quantity to exchange qtyPrecision string.
   */
  public formatQty(qty: number): string {
    return this.roundQty(qty).toFixed(this.qtyPrecision);
  }

  public updateRuntimeSettings(newSettings: Record<string, any>): Record<string, any> {
    for (const [key, val] of Object.entries(newSettings)) {
      if (key in this.cfg && val !== undefined) {
        // If updating secret/key and user kept the masked placeholder, do not overwrite
        if ((key === "binanceApiKey" || key === "binanceApiSecret" || key === "dreamdexPrivateKey") && val === "******") continue;
        if (key === "enabledBuyLevels" && Array.isArray(val)) {
          this.cfg.enabledBuyLevels = val.map(Boolean);
          while (this.cfg.enabledBuyLevels.length < 5) this.cfg.enabledBuyLevels.push(true);
          this.needsBuyRebalance = true;
          continue;
        }
        if (key === "enabledSellTargets" && Array.isArray(val)) {
          this.cfg.enabledSellTargets = val.map(Boolean);
          while (this.cfg.enabledSellTargets.length < 5) this.cfg.enabledSellTargets.push(true);
          this.needsSellRebalance = true;
          this.iocBracketSellCycle = undefined;
          this.soldSellIndices.clear();
          continue;
        }
        if (key === "buySizingMode") {
          this.cfg.buySizingMode = val === "EQUAL" ? "EQUAL" : "PYRAMID";
          this.needsBuyRebalance = true;
          continue;
        }
        if (key === "buyLevelWeights" && Array.isArray(val)) {
          this.cfg.buyLevelWeights = val.map((v: any) => Math.max(1, Number(v) || 10));
          const defaultWeights = [10, 15, 20, 25, 30];
          while (this.cfg.buyLevelWeights.length < 5) {
            this.cfg.buyLevelWeights.push(defaultWeights[this.cfg.buyLevelWeights.length] ?? 20);
          }
          this.needsBuyRebalance = true;
          continue;
        }
        if (key === "minNetProfitPct") {
          this.cfg.minNetProfitPct = Math.max(0.05, Number(val) || 0.25);
          this.needsSellRebalance = true;
          continue;
        }
        if (key === "breakevenEscapeProfitPct") {
          this.cfg.breakevenEscapeProfitPct = Math.max(0.01, Number(val) || 0.06);
          this.needsSellRebalance = true;
          continue;
        }
        if (key === "maxActiveMakerBuys") {
          this.cfg.maxActiveMakerBuys = Math.max(1, Math.min(5, parseInt(val, 10) || 2));
          this.needsBuyRebalance = true;
          continue;
        }
        if (key === "buyLevelPcts" && Array.isArray(val)) {
          this.cfg.buyLevelPcts = val.map(Number);
          const defaultBuys = [42, 32, 22, 12, 2];
          while (this.cfg.buyLevelPcts.length < 5) this.cfg.buyLevelPcts.push(defaultBuys[this.cfg.buyLevelPcts.length] ?? 2);
          this.confirmedChannel = undefined;
          this.pendingConfirmedChannelUpdate = true;
          this.needsBuyRebalance = true;
          if (this.lastDynamicBounds && this.lastDynamicBounds.buyLevels.length > 1) {
            const dSpan = this.lastDynamicBounds.upperBound - this.lastDynamicBounds.lowerBound;
            this.lastDynamicBounds.buyLevels = this.cfg.buyLevelPcts.map((pct) => this.lastDynamicBounds!.lowerBound + dSpan * (pct / 100));
          }
          if (this.lockedChannel && this.lockedChannel.buyLevels.length > 1) {
            const dSpan = this.lockedChannel.upperBound - this.lockedChannel.lowerBound;
            this.lockedChannel.buyLevels = this.cfg.buyLevelPcts.map((pct) => this.lockedChannel!.lowerBound + dSpan * (pct / 100));
          }
          continue;
        }
        if (key === "sellLevelPcts" && Array.isArray(val)) {
          this.cfg.sellLevelPcts = val.map(Number);
          const defaultSells = [52, 62, 72, 82, 92];
          while (this.cfg.sellLevelPcts.length < 5) this.cfg.sellLevelPcts.push(defaultSells[this.cfg.sellLevelPcts.length] ?? 92);
          this.confirmedChannel = undefined;
          this.pendingConfirmedChannelUpdate = true;
          this.needsSellRebalance = true;
          this.iocBracketSellCycle = undefined;
          this.soldSellIndices.clear();
          if (this.lastDynamicBounds && this.lastDynamicBounds.sellLevels.length > 1) {
            const dSpan = this.lastDynamicBounds.upperBound - this.lastDynamicBounds.lowerBound;
            this.lastDynamicBounds.sellLevels = this.cfg.sellLevelPcts.map((pct) => this.lastDynamicBounds!.lowerBound + dSpan * (pct / 100));
          }
          if (this.lockedChannel && this.lockedChannel.sellLevels.length > 1) {
            const dSpan = this.lockedChannel.upperBound - this.lockedChannel.lowerBound;
            this.lockedChannel.sellLevels = this.cfg.sellLevelPcts.map((pct) => this.lockedChannel!.lowerBound + dSpan * (pct / 100));
          }
          continue;
        }
        if (key === "maxInventoryQuote" || key === "maxInventoryUsdso") {
          const num = Math.max(5, Number(val) || 200);
          this.cfg.maxInventoryQuote = num;
          this.cfg.maxInventoryUsdso = num;
          this.needsBuyRebalance = true;
          this.needsSellRebalance = true;
          continue;
        }
        if (key === "symbol" && typeof val === "string" && val.trim().length > 0) {
          const cleanSym = val.trim().toUpperCase().replace(/[\/\-_]/g, "");
          this.symbol = cleanSym;
          this.cfg.symbol = cleanSym;
          this.cfg.binanceSymbol = cleanSym.toLowerCase().replace(/:/g, "");
          continue;
        }
        (this.cfg as any)[key] = val;
      }
    }
    if (this.binance.exchangeName === "binance") {
      if (newSettings.binanceApiKey !== undefined || newSettings.binanceApiSecret !== undefined || newSettings.binanceBaseUrl !== undefined) {
        const newKey = (newSettings.binanceApiKey !== undefined && newSettings.binanceApiKey !== "******")
          ? newSettings.binanceApiKey
          : this.cfg.binanceApiKey;
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
    if (newSettings.enableNarrowChannelCollapse !== undefined) {
      this.cfg.enableNarrowChannelCollapse = Boolean(newSettings.enableNarrowChannelCollapse);
    }
    if (newSettings.narrowChannelThresholdPct !== undefined) {
      this.cfg.narrowChannelThresholdPct = Math.max(0, Number(newSettings.narrowChannelThresholdPct));
    }
    if (newSettings.narrowChannelBuyBufferPct !== undefined) {
      this.cfg.narrowChannelBuyBufferPct = Math.max(0, Number(newSettings.narrowChannelBuyBufferPct));
    }
    if (newSettings.narrowChannelSellBufferPct !== undefined) {
      this.cfg.narrowChannelSellBufferPct = Math.max(0, Number(newSettings.narrowChannelSellBufferPct));
    }
    if (newSettings.adjustChannelOnClosedOnly !== undefined) {
      this.cfg.adjustChannelOnClosedOnly = Boolean(newSettings.adjustChannelOnClosedOnly);
    }
    if (
      newSettings.adjustChannelOnClosedOnly !== undefined ||
      newSettings.channelMode !== undefined ||
      newSettings.minChannelWidthPct !== undefined ||
      newSettings.maxChannelWidthPct !== undefined ||
      newSettings.floorBufferPct !== undefined ||
      newSettings.srLookbackCandles !== undefined ||
      newSettings.useTrueWick !== undefined ||
      newSettings.wickThresholdPct !== undefined ||
      newSettings.enableNarrowChannelCollapse !== undefined ||
      newSettings.narrowChannelThresholdPct !== undefined ||
      newSettings.narrowChannelBuyBufferPct !== undefined ||
      newSettings.narrowChannelSellBufferPct !== undefined ||
      newSettings.buyLevelPcts !== undefined ||
      newSettings.sellLevelPcts !== undefined
    ) {
      this.confirmedChannel = undefined;
      this.pendingConfirmedChannelUpdate = true;
    }
    this.syncDowEngineSettings();
    const configToPersist = {
      ...this.getRuntimeConfig(),
      // Ensure real secrets are persisted in DB if provided
      binanceApiKey: this.cfg.binanceApiKey,
      binanceApiSecret: this.cfg.binanceApiSecret,
      dreamdexPrivateKey: this.cfg.dreamdexPrivateKey,
    };
    this.db.setSettings(configToPersist);
    const sanitizedLog = { ...newSettings };
    if (sanitizedLog.binanceApiKey) sanitizedLog.binanceApiKey = "******";
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
        this.walletBaseLocked = b.baseLocked ?? 0;
        this.walletQuoteLocked = b.quoteLocked ?? 0;
        this.walletBaseTotal = b.baseTotal ?? (b.baseFree + (b.baseLocked ?? 0));
        this.walletQuoteTotal = b.quoteTotal ?? (b.quoteFree + (b.quoteLocked ?? 0));
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

      // 1. Query active open orders directly from Binance Spot API / DreamDEX
      const liveOrders = await this.binance.getOpenOrders(this.symbol);
      const onChainIdSet = new Set<string>(liveOrders.map((o) => o.orderId.toString()));

      // 1b. Detect & sweep orphan BUY orders on other Binance symbols that lock our quoteAsset (FDUSD/USDT)
      if (this.binance.exchangeName === "binance") {
        const activeBuyLockedQuote = liveOrders
          .filter((o) => o.side === "BUY")
          .reduce((sum, o) => sum + Math.max(0, o.origQty - o.executedQty) * o.price, 0);
        if (this.walletQuoteLocked > activeBuyLockedQuote + 1.0) {
          const swept = await this.sweepOrphanQuoteOrders();
          if (swept > 0) {
            await this.refreshWalletBalances();
            this.needsBuyRebalance = true;
          }
        }
      }

      // Reconcile database OPEN order records against live exchange state
      if (typeof (this.db as any).reconcileOpenOrdersWithExchange === "function") {
        const reconciledCount = (this.db as any).reconcileOpenOrdersWithExchange(onChainIdSet, this.symbol);
        if (reconciledCount > 0) {
          this.recentOrders = this.db.getOrders(5000);
          this.log(`🧹 [sync] Reconciled ${reconciledCount} stale OPEN order record(s) in database`);
        }
      }

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
                  const buyBufPct = this.cfg.narrowChannelBuyBufferPct ?? 0.05;
                  const buyPcts = this.cfg.buyLevelPcts ?? [42, 32, 22, 12, 2];
                  const buyNames = isSingleBuy
                    ? [`Buy Edge Floor (+${buyBufPct.toFixed(2)}%)`]
                    : currentBounds.buyLevels.map((_, idx) => `Buy Level ${idx + 1} (${buyPcts[idx] ?? Math.round(42 - idx * 10)}%)`);
                  const enabledBuys = Array.isArray(this.cfg.enabledBuyLevels) ? this.cfg.enabledBuyLevels : [true, true, true, true, true];
                  const buyTargets = currentBounds.buyLevels.map((_, i) =>
                    this.getCumulativeBuyTargetFraction(i, enabledBuys, currentBounds.buyLevels.length, false)
                  );
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
                  const sellBufPct = this.cfg.narrowChannelSellBufferPct ?? 0.05;
                  const sellPcts = this.cfg.sellLevelPcts ?? [52, 62, 72, 82, 92];
                  const sellNames = isSingleSell
                    ? [`Sell Edge Ceil (-${sellBufPct.toFixed(2)}%)`]
                    : currentBounds.sellLevels.map((_, idx) => `Sell Target ${idx + 1} (${sellPcts[idx] ?? Math.round(52 + idx * 10)}%)`);
                  const enabledSells = Array.isArray(this.cfg.enabledSellTargets) ? this.cfg.enabledSellTargets : [true, true, true, true, true];
                  const activeSellCount = enabledSells.filter(Boolean).length || 5;
                  let activeSellRank = 0;
                  const sellTargets = currentBounds.sellLevels.map((_, i) => {
                    if (isSingleSell) return 0.0;
                    if (enabledSells[i]) {
                      activeSellRank++;
                      return Math.max(0.0, 1.0 - (activeSellRank / activeSellCount));
                    }
                    return 0.0;
                  });
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
      const baseReserve = this.cfg.minGasReserveSomi ?? 2.0;
      const compensatedGas = this.baseAsset === "SOMI" ? (this.totalGasDeductedBase || 0) : 0;
      return baseReserve + compensatedGas;
    }
    return 0;
  }
  public getEffectiveGasReserveBase(): number {
    if (this.binance.exchangeName === "dreamdex" && this.baseAsset === "SOMI") {
      const baseReserve = this.cfg.minGasReserveSomi ?? 2.0;
      const compensatedGas = this.totalGasDeductedBase || 0;
      return baseReserve + compensatedGas;
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
        const unallocatedQty = roundToStep(rawUnallocated, this.stepSize || 0.0001, this.qtyPrecision);
        if (unallocatedQty >= this.minQty) {
          const recentOrders = this.db.getOrders(50);
          const currentSymNorm = (this.symbol || "").toUpperCase().replace(/[\/\-_:]/g, "");
          const currentBaseNorm = (this.baseAsset || "").toUpperCase();
          const lastBuyFill = recentOrders.find((o) => {
            if (o.action !== "BUY_FILL" || !o.price || o.price <= 0) return false;
            if (o.baseAsset && o.baseAsset.toUpperCase() !== currentBaseNorm) return false;
            if (o.symbol && o.symbol.toUpperCase().replace(/[\/\-_:]/g, "") !== currentSymNorm) return false;
            return true;
          });
          const adoptPrice = lastBuyFill?.price || this.lastRefPrice || (this.lots.length > 0 ? this.getAvgEntryPrice() : (this.lastBestBid || this.lastBestAsk || 0));
          if (adoptPrice <= 0) {
            this.log(
              `⚠️ [INVENTORY RECONCILE] Skipped adopting ${unallocatedQty.toFixed(4)} ${this.baseAsset}: Market price cannot be reliably determined.`,
            );
            return;
          }
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

  public clampLotsTo(maxAllowedQty: number): void {
    this.lotTracker.clampLotsTo(maxAllowedQty);
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
    this.confirmedChannel = undefined;
    this.pendingConfirmedChannelUpdate = true;
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

      // ── Resilient Gas Compensation Recovery from Order Ledger ───────────
      // If totalGasDeductedBase in state was wiped or is 0 on DEX (SOMI base),
      // restore it from the authoritative order history in DB!
      const isDex = this.binance?.hasGasFees || this.binance?.isDex || this.binance?.exchangeName === "dreamdex";
      const isSomiBase = isDex && (this.baseAsset || "").toUpperCase() === "SOMI";
      if (this.totalGasDeductedBase <= 0 && isSomiBase) {
        const histComp = this.db.getOrders(5000).reduce((sum, o) => sum + (o.gasCompSomi || o.gasCompBase || 0), 0);
        if (histComp > 0) {
          this.totalGasDeductedBase = histComp;
          this.totalGasDeductedQuote = histComp * (this.lastRefPrice || this.getAvgEntryPrice() || 0.2);
          this.realizedPnl = this.tradeRealizedPnl - this.totalGasDeductedQuote;
          this.log(`⛽ [STATE SYNC] Restored totalGasDeductedBase = ${histComp.toFixed(4)} SOMI from historical orders ledger.`);
        }
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
      } else {
        this.waitingForHigherLow = false;
        this.breakdownFloorPrice = undefined;
        this.breakdownLowPrice = undefined;
        this.breakdownTime = undefined;
      }
      if (typeof data.isFlatChannelShiftWaiting === "boolean") {
        this.isFlatChannelShiftWaiting = data.isFlatChannelShiftWaiting;
      }
      if (typeof (data as any).isTrendSupportExitActive === "boolean") {
        this.isTrendSupportExitActive = (data as any).isTrendSupportExitActive;
      }
      if (typeof (data as any).trendSupportBreakPrice === "number") {
        this.trendSupportBreakPrice = (data as any).trendSupportBreakPrice;
      }
      if (typeof data.breakdownFloorPrice === "number") {
        this.breakdownFloorPrice = data.breakdownFloorPrice;
      }
      if (typeof data.breakdownLowPrice === "number") {
        this.breakdownLowPrice = data.breakdownLowPrice;
      }
      if (typeof data.breakdownBuyLevel2Price === "number" && data.breakdownBuyLevel2Price > 0.0001) {
        this.breakdownBuyLevel2Price = data.breakdownBuyLevel2Price;
      }
      if (typeof data.breakdownTime === "number") {
        this.breakdownTime = data.breakdownTime;
      } else if (typeof data.brokenValleyTime === "number") {
        this.breakdownTime = data.brokenValleyTime;
      }
      if (typeof data.lastCutLossTime === "number") {
        this.lastCutLossTime = data.lastCutLossTime;
      } else {
        this.lastCutLossTime = 0;
      }
      if (typeof data.postCutSingleTrancheOnly === "boolean") {
        this.postCutSingleTrancheOnly = data.postCutSingleTrancheOnly;
      } else {
        this.postCutSingleTrancheOnly = false;
      }
      if (typeof data.lastResolvedDumpLowPrice === "number") {
        this.lastResolvedDumpLowPrice = data.lastResolvedDumpLowPrice;
      }
      if (
        data.iocBracketSellCycle &&
        typeof data.iocBracketSellCycle.baselineHeldQty === "number" &&
        data.iocBracketSellCycle.baselineHeldQty > 0 &&
        this.lots.length > 0
      ) {
        this.iocBracketSellCycle = {
          baselineHeldQuote: data.iocBracketSellCycle.baselineHeldQuote || 0,
          baselineHeldQty: data.iocBracketSellCycle.baselineHeldQty,
          numSellTranches: data.iocBracketSellCycle.numSellTranches || 1,
          soldStepNums: new Set<number>(Array.isArray(data.iocBracketSellCycle.soldStepNums) ? data.iocBracketSellCycle.soldStepNums : []),
        };
      } else {
        this.iocBracketSellCycle = undefined;
      }
      if (Array.isArray(data.soldSellIndices)) {
        this.soldSellIndices = new Set<number>(data.soldSellIndices.map(Number));
      } else {
        this.soldSellIndices = new Set<number>();
      }
      // Restore unified orders from database (up to 5000 items)
      const dbOrders = this.db.getOrders(5000);
      if (dbOrders.length > 0) {
        this.recentOrders = dbOrders;
      } else if (Array.isArray(data.recentOrders)) {
        this.recentOrders = data.recentOrders;
      }

      // Seed soldSellIndices from recent orders if empty (e.g. on new version startup after sell fill)
      // Note: recentOrders is ordered newest first (index 0 = most recent)
      if (this.soldSellIndices.size === 0 && this.recentOrders.length > 0 && this.lots.length > 0) {
        const currentSymNorm = (this.symbol || "").toUpperCase().replace(/[\/\-_:]/g, "");
        for (let i = 0; i < this.recentOrders.length; i++) {
          const ord = this.recentOrders[i];
          if (!ord) continue;
          if (ord.symbol && ord.symbol.toUpperCase().replace(/[\/\-_:]/g, "") !== currentSymNorm) {
            continue;
          }
          if (ord.action === "BUY_FILL" || ord.isBid) break;
          if (ord.action === "SELL_FILL" || (!ord.isBid && ord.status === "FILLED")) {
            const soldIdx = this.findSellLevelIndex(ord.levelDesc, ord.price);
            if (soldIdx >= 0) {
              this.soldSellIndices.add(soldIdx);
            }
          }
        }
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
      const persistentLockedChannel = this.db.getLockedChannel(symbolKey);

      if (
        persistentLockedChannel &&
        typeof persistentLockedChannel.lowerBound === "number" &&
        typeof persistentLockedChannel.upperBound === "number" &&
        Array.isArray(persistentLockedChannel.buyLevels) &&
        persistentLockedChannel.buyLevels.length >= 1 &&
        Array.isArray(persistentLockedChannel.sellLevels) &&
        persistentLockedChannel.sellLevels.length >= 1
      ) {
        const hasInventory = this.lots.length > 0 && this.baseHeld() >= (this.minQty || 0.001);
        const hasOpenSells = this.openOrders.some((o) => !o.isBid);

        // As long as the bot holds inventory or resting sell orders, this locked channel represents
        // the original structural entry and profit-taking bounds! Never wipe it arbitrarily.
        if (hasInventory || hasOpenSells) {
          const dSpan = persistentLockedChannel.upperBound - persistentLockedChannel.lowerBound;
          const isNarrowRestored = persistentLockedChannel.buyLevels.length === 1;
          const curBuyPcts = this.cfg.buyLevelPcts ?? [42, 32, 22, 12, 2];
          const curSellPcts = this.cfg.sellLevelPcts ?? [52, 62, 72, 82, 92];
          const restoredBuyLevels = isNarrowRestored
            ? [...persistentLockedChannel.buyLevels]
            : curBuyPcts.map((pct) => persistentLockedChannel.lowerBound + dSpan * (pct / 100));
          const restoredSellLevels = isNarrowRestored
            ? [...persistentLockedChannel.sellLevels]
            : curSellPcts.map((pct) => persistentLockedChannel.lowerBound + dSpan * (pct / 100));

          this.lockedChannel = {
            ...persistentLockedChannel,
            buyLevels: restoredBuyLevels,
            sellLevels: restoredSellLevels,
          };
          this.lastDynamicBounds = {
            lowerBound: persistentLockedChannel.lowerBound,
            upperBound: persistentLockedChannel.upperBound,
            centerPrice: persistentLockedChannel.centerPrice,
            buyLevels: [...restoredBuyLevels],
            sellLevels: [...restoredSellLevels],
          };
          this.log(
            `🔒 [state] Restored persistent locked channel bounds for ${symbolKey}: [$${this.lastDynamicBounds.lowerBound.toFixed(6)} .. $${this.lastDynamicBounds.upperBound.toFixed(6)}] (Center: $${this.lastDynamicBounds.centerPrice.toFixed(6)}) with ${this.lots.length} lots held`,
          );
        } else {
          this.lockedChannel = undefined;
          this.lastDynamicBounds = undefined;
          this.db.saveLockedChannel(symbolKey, undefined);
        }
      } else {
        this.lockedChannel = undefined;
        this.lastDynamicBounds = undefined;
      }

      const totalHeld = this.baseHeld();
      if (totalHeld < this.minQty && totalHeld > 0) {
        // Clean up dust lots on startup
        this.lots = [];
      }
      const avgEntry = this.getAvgEntryPrice();
      this.log(
        `[state] restored ${this.lots.length} open lots (${this.baseHeld().toFixed(4)} ${this.baseAsset} | Avg: $${avgEntry.toFixed(6)}) and ${this.openOrders.length} open resting orders | Realized PnL: ${this.realizedPnl >= 0 ? "+$" : "-$"}${Math.abs(this.realizedPnl).toFixed(4)} from database ${this.cfg.dbPath} (${this.recentOrders.length} unified orders)${this.waitingForHigherLow ? " (Waiting for Higher Low)" : ""}${this.isPaused ? " [PAUSED ⏸️]" : " [ACTIVE ▶️]"}`,
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
        isFlatChannelShiftWaiting: this.isFlatChannelShiftWaiting,
        isTrendSupportExitActive: this.isTrendSupportExitActive,
        trendSupportBreakPrice: this.trendSupportBreakPrice,
        breakdownFloorPrice: this.breakdownFloorPrice,
        breakdownLowPrice: this.breakdownLowPrice,
        breakdownBuyLevel2Price: this.breakdownBuyLevel2Price,
        breakdownTime: this.breakdownTime,
        lastCutLossTime: this.lastCutLossTime,
        postCutSingleTrancheOnly: this.postCutSingleTrancheOnly,
        lastResolvedDumpLowPrice: this.lastResolvedDumpLowPrice,
        iocBracketSellCycle: this.iocBracketSellCycle
          ? {
              baselineHeldQuote: this.iocBracketSellCycle.baselineHeldQuote,
              baselineHeldQty: this.iocBracketSellCycle.baselineHeldQty,
              numSellTranches: this.iocBracketSellCycle.numSellTranches,
              soldStepNums: Array.from(this.iocBracketSellCycle.soldStepNums),
            }
          : undefined,
        soldSellIndices: Array.from(this.soldSellIndices),
        sellOrdersActive: this.sellOrdersActive,
        buyOrdersActive: this.buyOrdersActive,
        isSqueezePaused: this.isSqueezePaused,
        isPaused: this.isPaused,
        recentOrders: this.recentOrders.slice(0, 500),
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

  public emit(event: StrategyEvent): void {
    if (event.type === "order") {
      event.data = {
        ...event.data,
        symbol: event.data.symbol || this.symbol,
        baseAsset: event.data.baseAsset || this.baseAsset,
        quoteAsset: event.data.quoteAsset || this.quoteAsset,
      };
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

    // Direct Purge: cancel all open orders on exchange
    if (!this.cfg.dryRun && this.binance.hasCredentials()) {
      try {
        await this.binance.cancelAllOpenOrders(this.symbol);
        this.log(`🗑️ Directly cancelled all open orders on ${this.binance.exchangeName.toUpperCase()} for ${this.symbol}`);
      } catch (err) {
        this.log(`⚠️ ${this.binance.exchangeName.toUpperCase()} cancel all orders error: ${(err as Error).message}`);
      }
      await this.sweepOrphanQuoteOrders();
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

    // Direct Purge: cancel all open orders on exchange
    if (!this.cfg.dryRun && this.binance.hasCredentials()) {
      try {
        await this.binance.cancelAllOpenOrders(this.symbol);
        this.log(`🗑️ Directly cancelled all open orders on ${this.binance.exchangeName.toUpperCase()} for ${this.symbol}`);
      } catch (err) {
        this.log(`⚠️ ${this.binance.exchangeName.toUpperCase()} cancel all orders error: ${(err as Error).message}`);
      }
      await this.sweepOrphanQuoteOrders();
    }

    // 2. Clear memory lots & orders completely
    this.lots = [];
    this.openOrders = [];
    this.inFlightOrders.clear();
    this.orderCooldowns.clear();
    this.waitingForHigherLow = false;
    this.isFlatChannelShiftWaiting = false;
    this.isTrendSupportExitActive = false;
    this.trendSupportBreakPrice = undefined;
    this.lastTrendSupportBreakKey = undefined;
    this.breakdownFloorPrice = undefined;
    this.breakdownLowPrice = undefined;
    this.breakdownBuyLevel2Price = undefined;
    this.breakdownTime = undefined;
    this.lastResolvedDumpLowPrice = undefined;
    this.breakdownCandleTimes.clear();
    this.sellOrdersActive = true;
    this.buyOrdersActive = true;
    this.stuckSince = undefined;
    this.lastBuyFillTime = 0;
    this.lastBuyFillPrice = 0;
    this.lastBuyFillCandleTime = 0;
    this.lockedChannel = undefined;
    this.lastDynamicBounds = undefined;
    this.confirmedChannel = undefined;
    this.pendingConfirmedChannelUpdate = true;
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
    this.isFlatChannelShiftWaiting = false;
    this.isTrendSupportExitActive = false;
    this.trendSupportBreakPrice = undefined;
    this.lastTrendSupportBreakKey = undefined;
    this.breakdownFloorPrice = undefined;
    this.breakdownLowPrice = undefined;
    this.breakdownBuyLevel2Price = undefined;
    this.breakdownTime = undefined;
    this.lastResolvedDumpLowPrice = undefined;
    this.breakdownCandleTimes.clear();
    this.sellOrdersActive = true;
    this.buyOrdersActive = true;
    this.stuckSince = undefined;
    this.lastBuyFillTime = 0;
    this.lastBuyFillPrice = 0;
    this.lastBuyFillCandleTime = 0;
    this.lockedChannel = undefined;
    this.lastDynamicBounds = undefined;
    this.confirmedChannel = undefined;
    this.pendingConfirmedChannelUpdate = true;
    this.db.saveLockedChannel(this.getSymbolKey(), undefined);

    this.saveState(true);
    this.emitTelemetryTick();
    this.log(`✅ Position successfully reset to 0.00 ${this.baseAsset} (Ready for fresh trading from level 1).`);
    return { success: true, clearedLots: count };
  }

  public async sellAllUser(): Promise<{ success: boolean; soldQty: number; price: number; error?: string }> {
    this.log(`💥 User triggered MANUAL SELL ALL.`);

    // 1. Cancel resting orders ONLY if resting orders actually exist (skip in IOC mode when openOrders is empty)
    if (this.openOrders.length > 0) {
      await this.cancelAllOrdersUser();
      await this.refreshWalletBalances();
    }

    // Determine current best execution price directly from the active exchange orderbook
    let execPrice = 0;
    try {
      if (this.binance.exchangeName === "dreamdex") {
        // Authoritative: Query DreamDEX indexer/pool directly with forceFresh=true to bypass 1.5s cache
        const top = await this.binance.getTopOfBook(this.symbol, true);
        if (top?.bestBid && top.bestBid > 0) {
          execPrice = top.bestBid;
        }
      } else if (this.wsBookTicker && Date.now() - this.wsBookTicker.time < 10_000 && this.wsBookTicker.bestBid > 0) {
        execPrice = this.wsBookTicker.bestBid;
      } else {
        const top = await this.binance.getTopOfBook(this.symbol, true);
        if (top?.bestBid && top.bestBid > 0) {
          execPrice = top.bestBid;
        }
      }
    } catch (e) {
      this.log(`⚠️ Failed to query orderbook for Sell All: ${(e as Error).message}`);
    }

    if (!execPrice || execPrice <= 0) {
      execPrice = this.lastRefPrice || this.atrSource.getLatestPrice?.() || 0;
    }

    if (execPrice <= 0) {
      return { success: false, soldQty: 0, price: 0, error: "Unable to determine current market price" };
    }

    const minGasReserveBase = this.getEffectiveGasReserveBase();
    const availableBase = Math.max(0, this.walletBaseBalance - minGasReserveBase);
    let held = this.cfg.dryRun ? this.baseHeld() : Math.min(this.baseHeld(), availableBase > 0 ? availableBase : this.baseHeld());

    // Fallback: If memory held is 0 or below minQty, but actual wallet base balance is available, use availableBase
    if (held < this.minQty && availableBase >= this.minQty) {
      held = availableBase;
    }

    if (held < this.minQty) {
      return { success: false, soldQty: 0, price: execPrice, error: `Position quantity (${held.toFixed(4)} ${this.baseAsset}) is below minimum order size (${this.minQty})` };
    }

    const prevHeld = held;
    await this.sellAll(execPrice, "MANUAL");

    // Automatically pause bot to prevent immediate re-accumulation
    this.isPaused = true;
    this.saveState(true);
    this.emitTelemetryTick();

    const remaining = this.baseHeld();
    const soldQty = Math.max(0, prevHeld - remaining);

    if (soldQty <= 0 && !this.cfg.dryRun) {
      return {
        success: false,
        soldQty: 0,
        price: execPrice,
        error: "Sell order was not filled on exchange. Lots kept intact.",
      };
    }

    return {
      success: true,
      soldQty: soldQty > 0 ? soldQty : prevHeld,
      price: execPrice,
    };
  }

  public emitTelemetryTick(): void {
    const mid = this.lastRefPrice || 0.2;
    const valuationPrice = (this.lastBestBid && this.lastBestBid > 0) ? this.lastBestBid : mid;
    const avgEntry = this.getAvgEntryPrice();
    const held = this.baseHeld();
    const unrealizedPnl = held > 0 && avgEntry > 0 ? (valuationPrice - avgEntry) * held : 0;

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
        soldSellIndices: Array.from(this.soldSellIndices),
        orderExecutionMode: this.cfg.orderExecutionMode ?? "IOC_BRACKET",
        iocBracketSellCycle: this.iocBracketSellCycle
          ? {
              baselineHeldQuote: this.iocBracketSellCycle.baselineHeldQuote,
              baselineHeldQty: this.iocBracketSellCycle.baselineHeldQty,
              numSellTranches: this.iocBracketSellCycle.numSellTranches,
              soldStepNums: Array.from(this.iocBracketSellCycle.soldStepNums),
            }
          : undefined,
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
        pricePrecision: this.pricePrecision,
        qtyPrecision: this.qtyPrecision,
        tickSize: this.tickSize && this.tickSize > 0 ? this.tickSize : (1 / Math.pow(10, this.pricePrecision || 2)),
        stepSize: this.stepSize && this.stepSize > 0 ? this.stepSize : (1 / Math.pow(10, this.qtyPrecision || 4)),
        minQty: this.minQty,
        minNotional: this.minNotional,
        symbol: this.symbol,
        walletAddress: this.walletAddress,
        walletBaseBalance: this.walletBaseBalance,
        walletQuoteBalance: this.walletQuoteBalance,
        walletSomiBalance: this.walletBaseBalance,
        walletUsdsoBalance: this.walletQuoteBalance,
        walletBaseValueQuote: (this.walletBaseTotal > 0 ? this.walletBaseTotal : this.walletBaseBalance) * valuationPrice,
        walletTotalValueQuote: this.getTotalPortfolioValueQuote(valuationPrice),
        walletSomiValueUsdso: (this.walletBaseTotal > 0 ? this.walletBaseTotal : this.walletBaseBalance) * valuationPrice,
        walletTotalValueUsdso: this.getTotalPortfolioValueQuote(valuationPrice),
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
        walletBaseValueQuote: (this.walletBaseTotal > 0 ? this.walletBaseTotal : this.walletBaseBalance) * valuationPrice,
        walletTotalValueQuote: this.getTotalPortfolioValueQuote(valuationPrice),
        walletSomiValueUsdso: (this.walletBaseTotal > 0 ? this.walletBaseTotal : this.walletBaseBalance) * valuationPrice,
        walletTotalValueUsdso: this.getTotalPortfolioValueQuote(valuationPrice),
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
    if (this.isSwitchingSymbol) return;
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

    if (bestBid !== undefined && bestBid > 0) {
      this.lastBestBid = bestBid;
    }
    if (bestAsk !== undefined && bestAsk > 0) {
      this.lastBestAsk = bestAsk;
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
    const adjustOnClosedOnly = this.cfg.adjustChannelOnClosedOnly !== false;
    const lastClosedCandle = this.dowEngine?.getLastClosedCandle();
    const lastClosedTime = lastClosedCandle?.time ?? 0;

    const needChannelRecalc =
      !adjustOnClosedOnly ||
      !this.confirmedChannel ||
      this.pendingConfirmedChannelUpdate ||
      (lastClosedTime > 0 && this.confirmedChannel.candleTime !== lastClosedTime);

    let dow: DowStructure | undefined;
    let gridZone: GridZone | undefined;
    const currentFloorBufferPct = this.cfg.floorBufferPct ?? 0.0;
    let lowerBound: number;
    let upperBound: number;
    let centerPrice: number;
    let cutLossBound: number;
    let rawFloorPrice: number;
    let buyLevels: number[];
    let sellLevels: number[];

    if (needChannelRecalc) {
      const calculationPrice = (adjustOnClosedOnly && lastClosedCandle) ? lastClosedCandle.close : refPrice;

      dow = this.dowEngine?.getStructure(calculationPrice, undefined, {
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
        srLookbackCandles: this.cfg.srLookbackCandles,
        enableNarrowChannelCollapse: this.cfg.enableNarrowChannelCollapse,
        narrowChannelThresholdPct: this.cfg.narrowChannelThresholdPct,
        narrowChannelBuyBufferPct: this.cfg.narrowChannelBuyBufferPct,
        narrowChannelSellBufferPct: this.cfg.narrowChannelSellBufferPct,
        buyLevelPcts: this.cfg.buyLevelPcts ?? [42, 32, 22, 12, 2],
        sellLevelPcts: this.cfg.sellLevelPcts ?? [52, 62, 72, 82, 92],
        useOnlyClosedCandles: adjustOnClosedOnly,
      });
      gridZone = dow?.gridZone;

      lowerBound = dow?.bottomBound ?? calculationPrice * 0.98;
      upperBound = dow?.upperBound ?? calculationPrice * 1.02;
      centerPrice = dow?.centerPrice ?? (lowerBound + upperBound) / 2;
      const rawSpan = Math.max(0.000001, upperBound - lowerBound);

      cutLossBound = dow?.cutLossBound ?? (lowerBound - (currentFloorBufferPct / 100) * lowerBound);
      rawFloorPrice = dow?.activeValley?.price ?? lowerBound;

      const buyPcts = this.cfg.buyLevelPcts ?? [42, 32, 22, 12, 2];
      const sellPcts = this.cfg.sellLevelPcts ?? [52, 62, 72, 82, 92];

      const hasRealChannel = Boolean(dow?.isSwingConfirmed && lowerBound > 0 && upperBound > lowerBound);
      buyLevels = gridZone?.buyLevels && gridZone.buyLevels.length > 0
        ? [...gridZone.buyLevels]
        : (hasRealChannel ? buyPcts.map((pct) => lowerBound + rawSpan * (pct / 100)) : []);

      sellLevels = gridZone?.sellLevels && gridZone.sellLevels.length > 0
        ? [...gridZone.sellLevels]
        : (hasRealChannel ? sellPcts.map((pct) => lowerBound + rawSpan * (pct / 100)) : []);

      lowerBound = this.roundPrice(lowerBound);
      upperBound = this.roundPrice(upperBound);
      centerPrice = this.roundPrice(centerPrice);
      cutLossBound = this.roundPrice(cutLossBound);
      rawFloorPrice = this.roundPrice(rawFloorPrice);
      buyLevels = buyLevels.map((p) => this.roundPrice(p));
      sellLevels = sellLevels.map((p) => this.roundPrice(p));

      if (this.waitingForHigherLow && hasRealChannel && buyLevels.length > 1 && buyLevels[1] > 0.0001) {
        if (!this.breakdownBuyLevel2Price || Math.abs(this.breakdownBuyLevel2Price - buyLevels[1]) > 0.0001) {
          this.breakdownBuyLevel2Price = buyLevels[1];
        }
      }

      if (adjustOnClosedOnly && lastClosedTime > 0) {
        if (this.confirmedChannel && this.confirmedChannel.candleTime !== lastClosedTime) {
          this.log(
            `📊 [CONFIRMED CHANNEL] Candle closed @ $${calculationPrice.toFixed(6)} — Adjusted channel bounds: [$${lowerBound.toFixed(6)} .. $${upperBound.toFixed(6)}] (Center: $${centerPrice.toFixed(6)})`,
          );
          if (this.waitingForHigherLow && hasRealChannel && buyLevels.length > 1 && buyLevels[1] > 0.0001) {
            this.log(
              `🔄 [CHANNEL SHIFT] Updated recovery Buy Level 2 to new channel L2: $${buyLevels[1].toFixed(4)} (Floor: $${lowerBound.toFixed(4)})`,
            );
            this.breakdownBuyLevel2Price = buyLevels[1];
            this.saveState();
          }
        }
        this.confirmedChannel = {
          candleTime: lastClosedTime,
          lowerBound,
          upperBound,
          centerPrice,
          cutLossBound,
          rawFloorPrice,
          buyLevels: [...buyLevels],
          sellLevels: [...sellLevels],
          dow,
          gridZone,
          calculatedAt: Date.now(),
        };
        this.pendingConfirmedChannelUpdate = false;
      }
    } else {
      // Retain frozen channel grid bounds from confirmed closed candle,
      // but obtain live real-time market structure indicators (trendlines, candidates, crash drops) with refPrice:
      const liveDow = this.dowEngine?.getStructure(refPrice, undefined, {
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
        srLookbackCandles: this.cfg.srLookbackCandles,
        enableNarrowChannelCollapse: this.cfg.enableNarrowChannelCollapse,
        narrowChannelThresholdPct: this.cfg.narrowChannelThresholdPct,
        narrowChannelBuyBufferPct: this.cfg.narrowChannelBuyBufferPct,
        narrowChannelSellBufferPct: this.cfg.narrowChannelSellBufferPct,
        buyLevelPcts: this.cfg.buyLevelPcts ?? [42, 32, 22, 12, 2],
        sellLevelPcts: this.cfg.sellLevelPcts ?? [52, 62, 72, 82, 92],
        useOnlyClosedCandles: false,
      });

      dow = liveDow ?? this.confirmedChannel!.dow;
      gridZone = this.confirmedChannel!.gridZone;
      lowerBound = this.confirmedChannel!.lowerBound;
      upperBound = this.confirmedChannel!.upperBound;
      centerPrice = this.confirmedChannel!.centerPrice;
      cutLossBound = this.confirmedChannel!.cutLossBound;
      rawFloorPrice = this.confirmedChannel!.rawFloorPrice;
      buyLevels = [...this.confirmedChannel!.buyLevels];
      sellLevels = [...this.confirmedChannel!.sellLevels];
    }

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
          const enableCollapse = this.cfg.enableNarrowChannelCollapse !== false;
          const narrowThresh = this.cfg.narrowChannelThresholdPct ?? 1.20;
          const isNarrowChannel = enableCollapse && currentFloor > 0 && ((dSpan / currentFloor) * 100) < narrowThresh;
          const buyBufferFrac = (this.cfg.narrowChannelBuyBufferPct ?? 0.05) / 100;
          const sellBufferFrac = (this.cfg.narrowChannelSellBufferPct ?? 0.05) / 100;
          const curBuyPcts = this.cfg.buyLevelPcts ?? [42, 32, 22, 12, 2];
          const curSellPcts = this.cfg.sellLevelPcts ?? [52, 62, 72, 82, 92];
          this.lastDynamicBounds.sellLevels = isNarrowChannel
            ? [newCeiling * (1 - sellBufferFrac)]
            : curSellPcts.map((pct) => currentFloor + dSpan * (pct / 100));
          this.lastDynamicBounds.buyLevels = isNarrowChannel
            ? [currentFloor * (1 + buyBufferFrac)]
            : curBuyPcts.map((pct) => currentFloor + dSpan * (pct / 100));
        }
      }

      // Enforce max channel width ceiling on locked channel so it never exceeds maxChannelWidthPct
      const maxChannelWidthPct = this.cfg.maxChannelWidthPct ?? 5.0;
      const currentFloor = this.lastDynamicBounds.lowerBound;
      const maxAllowedSpan = currentFloor * (maxChannelWidthPct / 100);
      if (currentFloor > 0 && this.lastDynamicBounds.upperBound - currentFloor > maxAllowedSpan) {
        const clampedCeiling = currentFloor + maxAllowedSpan;
        this.log(
          `🔒 [LOCKED CHANNEL MAX CLAMP] Clamping locked ceiling from $${this.lastDynamicBounds.upperBound.toFixed(6)} down to $${clampedCeiling.toFixed(6)} (Max width: ${maxChannelWidthPct}%)`,
        );
        this.lastDynamicBounds.upperBound = clampedCeiling;
        this.lastDynamicBounds.centerPrice = (currentFloor + clampedCeiling) / 2;
        const dSpan = clampedCeiling - currentFloor;
        const enableCollapse = this.cfg.enableNarrowChannelCollapse !== false;
        const narrowThresh = this.cfg.narrowChannelThresholdPct ?? 1.20;
        const isNarrowChannel = enableCollapse && currentFloor > 0 && ((dSpan / currentFloor) * 100) < narrowThresh;
        const buyBufferFrac = (this.cfg.narrowChannelBuyBufferPct ?? 0.05) / 100;
        const sellBufferFrac = (this.cfg.narrowChannelSellBufferPct ?? 0.05) / 100;
        const curBuyPcts = this.cfg.buyLevelPcts ?? [42, 32, 22, 12, 2];
        const curSellPcts = this.cfg.sellLevelPcts ?? [52, 62, 72, 82, 92];
        this.lastDynamicBounds.sellLevels = isNarrowChannel
          ? [clampedCeiling * (1 - sellBufferFrac)]
          : curSellPcts.map((pct) => currentFloor + dSpan * (pct / 100));
        this.lastDynamicBounds.buyLevels = isNarrowChannel
          ? [currentFloor * (1 + buyBufferFrac)]
          : curBuyPcts.map((pct) => currentFloor + dSpan * (pct / 100));
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
        this.lastDynamicBounds = undefined;
        this.db.saveLockedChannel(symbolKey, undefined);
      }

      const curPeakTime = dow?.activePeak?.time;
      const curPeakPrice = dow?.activePeak?.price;
      const curValleyTime = dow?.activeValley?.time;
      const curValleyPrice = dow?.activeValley?.price;

      const swingChanged = Boolean(
        (curPeakTime !== undefined && (curPeakTime !== this.lastActivePeakTime || curPeakPrice !== this.lastActivePeakPrice)) ||
        (curValleyTime !== undefined && (curValleyTime !== this.lastActiveValleyTime || curValleyPrice !== this.lastActiveValleyPrice))
      );

      if (swingChanged) {
        this.lastActivePeakTime = curPeakTime;
        this.lastActivePeakPrice = curPeakPrice;
        this.lastActiveValleyTime = curValleyTime;
        this.lastActiveValleyPrice = curValleyPrice;
      }

      const minShiftPct = (this.cfg.minChannelShiftPct ?? 1.0) / 100;

      // 🔒 Ironclad Floor Protection while holding position:
      // When holding position, lowerBound must NEVER be raised above previous locked floor!
      if (isHoldingPosition && this.lastDynamicBounds && lowerBound > this.lastDynamicBounds.lowerBound) {
        lowerBound = this.lastDynamicBounds.lowerBound;
      }

      // Hysteresis smoothing: Only retain previous bounds when holding position AND within the same swing pivot.
      // When flat (100% cash / !isHoldingPosition) or when a new confirmed Dow swing forms, channel adapts dynamically.
      const shouldApplyHysteresis = Boolean(
        isHoldingPosition &&
        !swingChanged &&
        this.lastDynamicBounds
      );

      if (shouldApplyHysteresis && this.lastDynamicBounds) {
        const lowerShift = Math.abs(lowerBound - this.lastDynamicBounds.lowerBound) / this.lastDynamicBounds.lowerBound;
        const upperShift = Math.abs(upperBound - this.lastDynamicBounds.upperBound) / this.lastDynamicBounds.upperBound;
        if (lowerShift < minShiftPct && upperShift < minShiftPct) {
          // Change is smaller than threshold -> retain previous channel levels to prevent churning orders & gas fees
          lowerBound = this.lastDynamicBounds.lowerBound;
          upperBound = this.lastDynamicBounds.upperBound;
          centerPrice = this.lastDynamicBounds.centerPrice;
          const dSpan = upperBound - lowerBound;
          const enableCollapse = this.cfg.enableNarrowChannelCollapse !== false;
          const narrowThresh = this.cfg.narrowChannelThresholdPct ?? 1.20;
          const isNarrowChannel = enableCollapse && lowerBound > 0 && ((dSpan / lowerBound) * 100) < narrowThresh;
          const buyBufferFrac = (this.cfg.narrowChannelBuyBufferPct ?? 0.05) / 100;
          const sellBufferFrac = (this.cfg.narrowChannelSellBufferPct ?? 0.05) / 100;

          const curBuyPcts = this.cfg.buyLevelPcts ?? [42, 32, 22, 12, 2];
          const curSellPcts = this.cfg.sellLevelPcts ?? [52, 62, 72, 82, 92];
          if (!Array.isArray(this.lastDynamicBounds.buyLevels) || this.lastDynamicBounds.buyLevels.length === 0) {
            this.lastDynamicBounds.buyLevels = isNarrowChannel
              ? [lowerBound * (1 + buyBufferFrac)]
              : curBuyPcts.map((pct) => lowerBound + dSpan * (pct / 100));
          }
          if (!Array.isArray(this.lastDynamicBounds.sellLevels) || this.lastDynamicBounds.sellLevels.length === 0) {
            this.lastDynamicBounds.sellLevels = isNarrowChannel
              ? [upperBound * (1 - sellBufferFrac)]
              : curSellPcts.map((pct) => lowerBound + dSpan * (pct / 100));
          }

          // If channel mode changed between narrow and normal, adapt buyLevels/sellLevels accordingly
          if (isNarrowChannel && this.lastDynamicBounds.buyLevels.length > 1) {
            this.lastDynamicBounds.buyLevels = [lowerBound * (1 + buyBufferFrac)];
            this.lastDynamicBounds.sellLevels = [upperBound * (1 - sellBufferFrac)];
          } else if (!isNarrowChannel && this.lastDynamicBounds.buyLevels.length === 1) {
            this.lastDynamicBounds.buyLevels = curBuyPcts.map((pct) => lowerBound + dSpan * (pct / 100));
            this.lastDynamicBounds.sellLevels = curSellPcts.map((pct) => lowerBound + dSpan * (pct / 100));
          }

          buyLevels = this.lastDynamicBounds.buyLevels.map((p) => this.roundPrice(p));
          sellLevels = this.lastDynamicBounds.sellLevels.map((p) => this.roundPrice(p));
          this.lastDynamicBounds.buyLevels = buyLevels;
          this.lastDynamicBounds.sellLevels = sellLevels;
        } else {
          buyLevels = buyLevels.map((p) => this.roundPrice(p));
          sellLevels = sellLevels.map((p) => this.roundPrice(p));
          this.lastDynamicBounds = { lowerBound, upperBound, centerPrice, buyLevels: [...buyLevels], sellLevels: [...sellLevels] };
        }
      } else {
        buyLevels = buyLevels.map((p) => this.roundPrice(p));
        sellLevels = sellLevels.map((p) => this.roundPrice(p));
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

    // ── Unified Breakdown & Downtrend Recovery Engine ────────────────────────
    // Single unified state machine replacing the old conflicting waitingForHigherLow +
    // downtrendDropPaused + Flat Cash LL Guard blocks.
    const isFlatCash = !isHoldingPosition && this.lots.length === 0;
    this.wasFlatCashLastTick = isFlatCash;

    this.lastEvaluatedFloor = lowerBound;
    this.lastEvaluatedCeil = upperBound;
    const isBelowFloor = isChannelReady && refPrice < lowerBound;
    const isAboveCeiling = isChannelReady && refPrice >= upperBound;

    const currentBuyLevel2 = isChannelReady && buyLevels.length > 1 && buyLevels[1] > 0.0001 ? buyLevels[1] : undefined;
    const effectiveBuyLevel2Target =
      currentBuyLevel2 ??
      (this.breakdownBuyLevel2Price && this.breakdownBuyLevel2Price > 0.0001 ? this.breakdownBuyLevel2Price : undefined) ??
      (this.breakdownFloorPrice && this.breakdownFloorPrice > 0.0001 ? this.breakdownFloorPrice : undefined) ??
      (lowerBound > 0 ? lowerBound + span * 0.32 : refPrice);

    // If a new active downtrend drop (LH + LL or fresh LL breakdown) is detected and its trough
    // has NOT already been resolved, enter the unified waitingForHigherLow state.
    if (Boolean(dow?.isDowntrendDropActive) && !this.waitingForHigherLow && isChannelReady) {
      const activeDumpLow = dow?.downtrendDropLow ?? lowerBound;
      const isNewUnresolvedDrop =
        this.lastResolvedDumpLowPrice === undefined ||
        activeDumpLow < this.lastResolvedDumpLowPrice * 0.9985 ||
        isBelowFloor;

      if (isNewUnresolvedDrop) {
        const lastLl = dow?.waveCycle?.lastLl;
        const lastHl = dow?.waveCycle?.lastHl;
        const dumpLowTime =
          Math.max(
            lastLl?.time ?? 0,
            dow?.candidateValley && dow.candidateValley.price <= activeDumpLow * 1.0005 ? dow.candidateValley.time : 0,
          ) || (Math.floor(Date.now() / 1000) - 3600);

        const isHlAfterLl = Boolean(
          lastHl &&
          lastLl &&
          lastHl.index > lastLl.index &&
          lastHl.time >= dumpLowTime &&
          lastHl.price > activeDumpLow * 1.0005,
        );
        const tlBreakout = Boolean(
          dow?.downtrendBreakoutConfirmed ||
          (dow?.downtrendLine?.isBroken && (dow.downtrendLine.brokenCandleCount ?? 0) >= 2),
        );

        if (!isHlAfterLl && !tlBreakout) {
          this.waitingForHigherLow = true;
          this.isFlatChannelShiftWaiting = false;
          this.breakdownFloorPrice = lowerBound;
          this.breakdownBuyLevel2Price = effectiveBuyLevel2Target;
          this.breakdownLowPrice = Math.min(refPrice, activeDumpLow);
          this.breakdownTime = dumpLowTime;
          this.log(
            `🛡️ [UNIFIED DOWNTREND GUARD] Active bear wave / floor break detected (Low: $${this.breakdownLowPrice.toFixed(6)} | Floor: $${lowerBound.toFixed(6)}) — pausing buys until Higher Low, Micro-HL, or Buy Level 2 Reclaim ($${effectiveBuyLevel2Target.toFixed(6)})!`,
          );
          this.saveState();
        }
      }
    }


    this.riskManager.evaluateHigherLowRecovery({
      dow,
      refPrice,
      lowerBound,
      effectiveBuyLevel2Target,
      isBelowFloor,
      isChannelReady,
    });

    const inBuyZone = positionPct >= 0 && positionPct < 50 && !isBelowFloor && !this.waitingForHigherLow;
    const inSellZone = positionPct >= 50 && !isAboveCeiling;
    const offloadOnly = this.realizedPnl <= -this.cfg.maxSessionLossUsdso;

    // ── 0% LOWER BOUND: CUT LOSS / STOP LOSS ─────────────────────────────────
    // DUAL-SPEED CUT LOSS:
    // 1. Buffer Breakdown: Price below Cut-Loss Buffer (cutLossBound).
    //    - If cutLossBufferDelaySeconds <= 0: Instant real-time cut loss on buffer break!
    //    - If cutLossBufferDelaySeconds > 0: Cut loss if price stays below buffer for >= delaySeconds (default 60s) OR 1 confirmed closed candle below buffer.
    // 2. Floor Breakdown (Optional / Configurable via cutLossOnBufferOnly):
    //    - When cutLossOnBufferOnly is true (default): Breaking below Floor (lowerBound) pauses buys (waitingForHigherLow = true), but NEVER executes cut loss.
    //    - When cutLossOnBufferOnly is false: 1 confirmed closed candle whose body (close) is below Channel Floor also triggers cut loss.

    const isBelowBuffer = isChannelReady && refPrice < cutLossBound;
    if (isBelowBuffer) {
      if (!this.bufferBreakStartTime) {
        this.bufferBreakStartTime = Date.now();
      }
    } else {
      this.bufferBreakStartTime = undefined;
    }

    const bufferDelayMs = Math.max(0, (this.cfg.cutLossBufferDelaySeconds ?? 60) * 1000);
    const bufferBreakElapsedMs = this.bufferBreakStartTime ? (Date.now() - this.bufferBreakStartTime) : 0;

    // Track confirmed CLOSED candles
    const closedCandles = this.dowEngine?.getClosedCandles() ?? [];
    const latestClosedCandle = closedCandles.length > 0 ? closedCandles[closedCandles.length - 1] : lastClosedCandle;
    const isBufferCandleClosed = Boolean(latestClosedCandle && latestClosedCandle.close < cutLossBound);

    const isFastBufferCut = isBelowBuffer && (bufferDelayMs <= 0 || bufferBreakElapsedMs >= bufferDelayMs || isBufferCandleClosed);


    const uptrendLine = dow?.uptrendLine;
    const trendSupportBrokenHandled = await this.riskManager.evaluateTrendSupportBreak({
      dow,
      refPrice,
      lowerBound,
      span,
      buyLevels,
      bestBid,
      effectiveMid,
      isChannelReady,
      lastClosedCandle,
      cancelAllRestingOrders: (side, reason) => this.orderExecutor.cancelAllRestingOrders(side, reason),
      sellAll: (price, action, anchorRefPrice) => this.orderExecutor.sellAll(price, action, anchorRefPrice),
    });
    if (trendSupportBrokenHandled) return;

    const cutLossHandled = await this.riskManager.evaluateCutLoss({
      isChannelReady,
      lowerBound,
      upperBound,
      cutLossBound,
      bufferAmount,
      refPrice,
      span,
      buyLevels,
      bestBid,
      effectiveMid,
      lastClosedCandle,
      dow,
      cancelAllRestingOrders: (side, reason) => this.orderExecutor.cancelAllRestingOrders(side, reason),
      cancelOrderInternal: (order, reason) => this.orderExecutor.cancelOrderInternal(order, reason),
      placeRestingOrder: (isBid, price, qty, targetFraction, notionalQuote, levelDesc) =>
        this.orderExecutor.placeRestingOrder(isBid, price, qty, targetFraction, notionalQuote, levelDesc),
      sellTrancheIOC: (qty, execPrice, levelName, targetPrice, allowLoss) =>
        this.orderExecutor.sellTrancheIOC(qty, execPrice, levelName, targetPrice, allowLoss),
      sellAll: (price, action, anchorRefPrice) => this.orderExecutor.sellAll(price, action, anchorRefPrice),
    });
    if (cutLossHandled) return;

    // ── 100% UPPER BOUND: 100% FULL TAKE PROFIT EXIT & LH DYNAMIC ESCAPE ─────
    // Take profit when the Binance reference price or Best Bid reaches or crosses the 100% Ceiling or highest ENABLED sell level!
    // SAFETY: Take Profit must NEVER sell at a loss or micro-dust profit! Strictly require >= 0.50% profit above avgEntry on the actual execution Bid, and check DEX Bid discount vs Binance.
    const avgEntryPrice = this.getAvgEntryPrice();
    const tpExecBid = (bestBid !== undefined && bestBid > 0) ? bestBid : effectiveMid;
    const minTpProfitPct = Math.max(0.50, this.cfg.minNetProfitPct ?? 0.25);
    const isProfitableExit = avgEntryPrice <= 0 || tpExecBid >= avgEntryPrice * (1 + minTpProfitPct / 100);
    const tpMaxBidDiscountPct = this.cfg.cutLossMaxBidDiscountPct ?? 0.75;
    const tpBidDiscountPct = (binancePrice && binancePrice > 0 && tpExecBid > 0)
      ? ((binancePrice - tpExecBid) / binancePrice) * 100
      : 0;
    const isTpBidHealthy = tpBidDiscountPct <= tpMaxBidDiscountPct;

    const enabledSellsForTp = Array.isArray(this.cfg.enabledSellTargets) ? this.cfg.enabledSellTargets : [true, true, true, true, true];
    const activeSellTargetsForTp = sellLevels.filter((_, idx) => enabledSellsForTp[idx]);
    const firstActiveSellTarget = activeSellTargetsForTp.length > 0
      ? activeSellTargetsForTp[0]!
      : upperBound;
    const highestActiveSellTarget = activeSellTargetsForTp.length > 0
      ? activeSellTargetsForTp[activeSellTargetsForTp.length - 1]!
      : upperBound;

    const liveCalculatedCeil = dow?.gridZone?.upperBound ?? dow?.upperBound;
    const latestSwingHigh = dow?.lastSwingHigh;
    const isLatestHighLh = Boolean(
      (latestSwingHigh && (latestSwingHigh as any).dowLabel === "LH") ||
      (dow?.waveCycle?.lastLh && latestSwingHigh && dow.waveCycle.lastLh.time === latestSwingHigh.time),
    );
    const latestLhPrice = isLatestHighLh && latestSwingHigh ? latestSwingHigh.price : undefined;

    // In downtrend structure (LH+LL), allow escaping at breakeven / slight profit to safely de-risk
    const isDowntrendActive = Boolean(
      dow?.regime === "DOWNTREND" ||
      (dow?.waveCycle?.lastLl && (!dow?.waveCycle?.lastHl || dow.waveCycle.lastLl.index > dow.waveCycle.lastHl.index))
    );
    const escapeMinProfitPct = isDowntrendActive
      ? Math.max(0.05, this.cfg.breakevenEscapeProfitPct ?? 0.06)
      : Math.max(0.20, this.cfg.minNetProfitPct ?? 0.25);
    const minNetProfitTargetPrice = avgEntryPrice > 0 ? avgEntryPrice * (1 + escapeMinProfitPct / 100) : 0;

    // Consider candidatePeak as well if confirmed >= 2 bars
    const candidatePeakPrice = (dow?.candidatePeak && (dow.candidatePeak.confirmationCandles ?? 0) >= 2)
      ? dow.candidatePeak.price
      : undefined;
    const effectiveLhPrice = latestLhPrice ?? candidatePeakPrice;

    const candidateLhEscape = Math.min(
      effectiveLhPrice !== undefined && effectiveLhPrice > 0 ? effectiveLhPrice : Infinity,
      liveCalculatedCeil !== undefined && liveCalculatedCeil > 0 ? liveCalculatedCeil : Infinity,
    );
    const isIocMode = this.cfg.orderExecutionMode === "IOC_BRACKET";
    const isPriceStuckBelowFirstSell = refPrice < firstActiveSellTarget * 0.999;
    const isLhNearPrice = Number.isFinite(candidateLhEscape) &&
      candidateLhEscape < firstActiveSellTarget &&
      candidateLhEscape >= minNetProfitTargetPrice;

    // LH Dynamic Escape: Active in BOTH IOC and MAKER_LIMIT modes when price is genuinely stuck below first sell target,
    // and candidate escape price is above required profit/breakeven target
    const lhDynamicEscapePrice = (
      (this.cfg.enableLhDynamicEscape !== false) &&
      isPriceStuckBelowFirstSell &&
      isLhNearPrice &&
      refPrice <= candidateLhEscape * 1.002
    ) ? candidateLhEscape : undefined;

    const liveRealCeil = (this.cfg.enableSellAtRealCeiling !== false)
      ? (lhDynamicEscapePrice !== undefined && liveCalculatedCeil !== undefined
          ? Math.min(liveCalculatedCeil, lhDynamicEscapePrice)
          : (lhDynamicEscapePrice ?? liveCalculatedCeil))
      : undefined;

    const isLiveRealCeilReached = isIocMode && liveRealCeil !== undefined && liveRealCeil > 0 && (
      refPrice >= liveRealCeil ||
      (bestBid !== undefined && bestBid >= liveRealCeil)
    );
    const isLhEscapeReached = isIocMode && lhDynamicEscapePrice !== undefined && (
      refPrice >= lhDynamicEscapePrice ||
      (bestBid !== undefined && bestBid >= lhDynamicEscapePrice)
    ) && tpExecBid >= minNetProfitTargetPrice;

    const reachedTargetPrice = isIocMode
      ? Math.min(
          upperBound,
          liveRealCeil && isLiveRealCeilReached ? liveRealCeil : upperBound,
          highestActiveSellTarget,
        )
      : upperBound;
    const isBidAtTarget = tpExecBid >= reachedTargetPrice * (isLhEscapeReached ? (1 - (this.cfg.iocSlippagePct ?? 0.2) / 100) : 1.0);

    // In MAKER_LIMIT mode: Grid sell targets (Sell Targets 1..5) are strictly handled by resting MAKER limit orders!
    // Never hijack intra-channel grid sell targets with IOC sellAll in Maker mode.
    // In MAKER_LIMIT mode, sellAll Take Profit is ONLY permitted if price reached true Upper Bound (Ceiling 100%) AND all resting sells are clear.
    const hasOpenRestingSells = !isIocMode && this.openOrders.some((o) => !o.isBid);
    const realCeilingReached = isIocMode
      ? (
          (tpExecBid >= highestActiveSellTarget && refPrice >= highestActiveSellTarget) ||
          (isAboveCeiling || refPrice >= upperBound || (bestBid !== undefined && bestBid >= upperBound)) ||
          (isLiveRealCeilReached && isProfitableExit) ||
          (isLhEscapeReached && isProfitableExit)
        )
      : (
          !hasOpenRestingSells &&
          (isAboveCeiling || refPrice >= upperBound || (bestBid !== undefined && bestBid >= upperBound)) &&
          isProfitableExit
        );

    if (
      !this.isPaused &&
      this.cfg.takeProfitAtUpperBound &&
      this.lots.length > 0 &&
      realCeilingReached
    ) {
      if (!isProfitableExit) {
        this.status(
          `⏳ TAKE PROFIT STANDBY: Price $${refPrice.toFixed(6)} reached Upper Bound / Target ($${reachedTargetPrice.toFixed(6)}) but DEX Bid $${tpExecBid.toFixed(6)} is below min profit target (+${minTpProfitPct.toFixed(2)}% >= $${(avgEntryPrice * (1 + minTpProfitPct / 100)).toFixed(6)} | Avg Entry: $${avgEntryPrice.toFixed(6)}) — holding for profitable bid`,
        );
        return;
      } else if (!isTpBidHealthy) {
        this.status(
          `⏳ TAKE PROFIT STANDBY: Price $${refPrice.toFixed(6)} reached Upper Bound ($${upperBound.toFixed(6)}) but DEX Bid $${tpExecBid.toFixed(6)} is discounted ${tpBidDiscountPct.toFixed(2)}% below Binance (Max allowed: ${tpMaxBidDiscountPct.toFixed(2)}%) — waiting for DEX bid liquidity to catch up`,
        );
        return;
      } else if (!isBidAtTarget) {
        this.status(
          `⏳ TAKE PROFIT STANDBY: Price $${refPrice.toFixed(6)} reached Upper Bound ($${upperBound.toFixed(6)}) but DEX Bid $${tpExecBid.toFixed(6)} is below target price $${reachedTargetPrice.toFixed(6)} — waiting for bid to reach target`,
        );
        return;
      } else {
        const exitPrice = tpExecBid;
        const exitTypeLabel = isLhEscapeReached ? "LH DYNAMIC ESCAPE" : "100% TAKE PROFIT";
        this.log(
          `🎯 ${exitTypeLabel}: Price $${refPrice.toFixed(6)} (Bid: $${exitPrice.toFixed(6)}) reached ${isLhEscapeReached ? "Lower High / Real Ceil" : "Upper Bound / Real Ceil"} ($${reachedTargetPrice.toFixed(6)}) with +${(((exitPrice - avgEntryPrice) / (avgEntryPrice || exitPrice)) * 100).toFixed(2)}% profit (Avg Entry: $${avgEntryPrice.toFixed(6)}) — cancelling orders & full 100% exit to start fresh cycle`,
        );
        await this.cancelAllRestingOrders();
        await this.sellAll(exitPrice, "SELL", reachedTargetPrice);
        this.iocBracketSellCycle = undefined;
        this.stuckSince = undefined;
    this.lastBuyFillTime = 0;
    this.lastBuyFillPrice = 0;
    this.lastBuyFillCandleTime = 0;
        this.lockedChannel = undefined;
        this.confirmedChannel = undefined;
        this.pendingConfirmedChannelUpdate = true;
        const symbolKey = this.getSymbolKey();
        this.db.saveLockedChannel(symbolKey, undefined);
        this.saveState();
        return;
      }
    }

    // ── Target Holding % Rebalancing Model based on Ladder Zone ───────────────
    const enabledBuys = Array.isArray(this.cfg.enabledBuyLevels) ? this.cfg.enabledBuyLevels : [true, true, true, true, true];
    const enabledSells = Array.isArray(this.cfg.enabledSellTargets) ? this.cfg.enabledSellTargets : [true, true, true, true, true];
    const buyPcts = this.cfg.buyLevelPcts ?? [42, 32, 22, 12, 2];
    const sellPcts = this.cfg.sellLevelPcts ?? [52, 62, 72, 82, 92];
    const activeBuyCount = enabledBuys.filter(Boolean).length;
    const activeSellCount = enabledSells.filter(Boolean).length;

    let targetHoldingFraction = 0;
    let activeLevelName = "";

    if (isBelowFloor || positionPct <= 0) {
      targetHoldingFraction = 0.0;
      activeLevelName = this.baseHeld() > 0 ? "0% Floor (Cut Loss)" : "0% Floor (Protected in Cash)";
    } else if (positionPct < 50) {
      // Buy Zone: 0% .. 50%
      // Map Buy Levels dynamically (e.g. 2%, 12%, 22%, 32%, 42%)
      const buyLevelBands = [
        { idx: 4, maxPct: buyPcts[4] ?? 2, name: `${buyPcts[4] ?? 2}% Buy Level 5` },
        { idx: 3, maxPct: buyPcts[3] ?? 12, name: `${buyPcts[3] ?? 12}% Buy Level 4` },
        { idx: 2, maxPct: buyPcts[2] ?? 22, name: `${buyPcts[2] ?? 22}% Buy Level 3` },
        { idx: 1, maxPct: buyPcts[1] ?? 32, name: `${buyPcts[1] ?? 32}% Buy Level 2` },
        { idx: 0, maxPct: buyPcts[0] ?? 42, name: `${buyPcts[0] ?? 42}% Buy Level 1` },
      ];

      // Find which buy band price sits in
      const matchedBand = buyLevelBands.find((b) => positionPct <= b.maxPct);
      if (matchedBand) {
        activeLevelName = matchedBand.name;
        if (activeBuyCount === 0) {
          targetHoldingFraction = 0.0;
        } else {
          targetHoldingFraction = this.getCumulativeBuyTargetFraction(matchedBand.idx, enabledBuys, 5, false);
        }
      } else {
        targetHoldingFraction = 0.0;
        activeLevelName = `Accumulation Midline (${buyPcts[0] ?? 42}-50%)`;
      }
    } else if (positionPct <= (50 + Math.max(1, ((sellPcts[0] ?? 52) - 50) / 2))) {
      targetHoldingFraction = 1.0;
      activeLevelName = "50% Center Midline (Hold 100%)";
    } else if (positionPct < 100 && !isAboveCeiling) {
      // Sell Zone: 50% .. 100%
      // Map Sell Targets dynamically (e.g. 52%, 62%, 72%, 82%, 92%)
      const sellTargetBands = [
        { idx: 0, maxPct: ((sellPcts[0] ?? 52) + (sellPcts[1] ?? 62)) / 2, name: `${sellPcts[0] ?? 52}% Sell Target 1` },
        { idx: 1, maxPct: ((sellPcts[1] ?? 62) + (sellPcts[2] ?? 72)) / 2, name: `${sellPcts[1] ?? 62}% Sell Target 2` },
        { idx: 2, maxPct: ((sellPcts[2] ?? 72) + (sellPcts[3] ?? 82)) / 2, name: `${sellPcts[2] ?? 72}% Sell Target 3` },
        { idx: 3, maxPct: ((sellPcts[3] ?? 82) + (sellPcts[4] ?? 92)) / 2, name: `${sellPcts[3] ?? 82}% Sell Target 4` },
        { idx: 4, maxPct: 99.9, name: `${sellPcts[4] ?? 92}% Sell Target 5` },
      ];

      const matchedBand = sellTargetBands.find((b) => positionPct <= b.maxPct);
      if (matchedBand) {
        activeLevelName = matchedBand.name;
        if (activeSellCount === 0) {
          targetHoldingFraction = 1.0; // No sell targets active, hold position
        } else {
          // Count how many active sell targets have been reached up to matchedBand.idx
          let reachedActiveSellCount = 0;
          for (let sIdx = 0; sIdx <= matchedBand.idx; sIdx++) {
            if (enabledSells[sIdx]) reachedActiveSellCount++;
          }
          // Target remaining fraction decreases with each reached active sell step
          targetHoldingFraction = Math.max(0.0, 1.0 - (reachedActiveSellCount / activeSellCount));
        }
      } else {
        targetHoldingFraction = 0.0;
        activeLevelName = "100% Ceiling (Exit All)";
      }
    } else {
      targetHoldingFraction = 0.0;
      activeLevelName = "100% Ceiling (Exit All)";
    }

    const targetInventoryQuote = targetHoldingFraction * this.cfg.maxInventoryQuote;
    const targetInventoryUsdso = targetInventoryQuote;
    const isCexExchange = this.binance.exchangeName === "binance";
    const currentBestBid = bestBid ?? effectiveMid;
    const currentBestAsk = bestAsk ?? effectiveMid;
    const valuationBid = currentBestBid > 0 ? currentBestBid : refPrice;
    const inventoryQuote = this.baseHeld() * valuationBid;
    const inventoryUsdso = inventoryQuote;
    const currentHoldPct = this.cfg.maxInventoryQuote > 0 ? (inventoryQuote / this.cfg.maxInventoryQuote) * 100 : 0;
    const avgEntry = this.getAvgEntryPrice();
    const unrealizedPnl = this.baseHeld() > 0 && avgEntry > 0 ? (valuationBid - avgEntry) * this.baseHeld() : 0;

    // Active Buy Trigger in Buy Zone:
    // 1. Identify the first active buy level whose cumulative capacity quota is not yet satisfied
    let firstUnsatisfiedBuyPrice: number | undefined;
    for (let i = 0; i < buyLevels.length; i++) {
      if (!enabledBuys[i]) continue;
      const lvlPrice = buyLevels[i];
      if (lvlPrice === undefined || lvlPrice <= 0) continue;
      const capFraction = this.getCumulativeBuyTargetFraction(i, enabledBuys, buyLevels.length, false);
      const capQuote = capFraction * this.cfg.maxInventoryQuote;
      if (inventoryQuote < capQuote - 1.0) {
        firstUnsatisfiedBuyPrice = lvlPrice;
        break;
      }
    }

    let buyTrigger: number;
    const enabledBuyLvlPrices = buyLevels.filter((_, idx) => enabledBuys[idx]);
    const effectivePriceForBuyTrigger = (!isCexExchange && currentBestAsk > 0) ? Math.min(refPrice, currentBestAsk) : refPrice;
    const halfTick = (this.tickSize || 0.0001) * 0.5;

    if (enabledBuyLvlPrices.length === 0) {
      buyTrigger = 0;
    } else if (firstUnsatisfiedBuyPrice !== undefined) {
      // Anchor buyTrigger to the first unsatisfied buy level.
      // If price has dipped below it, use strict half-tick comparison without arbitrary percentage buffers
      if (effectivePriceForBuyTrigger < firstUnsatisfiedBuyPrice - halfTick) {
        const deeperLevel = enabledBuyLvlPrices.find((lvl) => lvl <= effectivePriceForBuyTrigger + halfTick);
        buyTrigger = deeperLevel ?? firstUnsatisfiedBuyPrice;
      } else {
        buyTrigger = firstUnsatisfiedBuyPrice;
      }
    } else {
      // All enabled buy levels have reached capacity
      const nextBuyLevel = enabledBuyLvlPrices.find((lvl) => lvl < effectivePriceForBuyTrigger - halfTick);
      buyTrigger = nextBuyLevel ?? (enabledBuyLvlPrices[enabledBuyLvlPrices.length - 1] ?? (lowerBound + span * ((buyPcts[buyPcts.length - 1] ?? 2) / 100)));
    }

    let sellTrigger: number;
    const enabledSellLvlPrices = sellLevels.filter((_, idx) => enabledSells[idx]);
    if (enabledSellLvlPrices.length === 0) {
      sellTrigger = 0;
    } else {
      const nextSellLevel = enabledSellLvlPrices.find((lvl) => lvl > refPrice * 1.0001);
      sellTrigger = nextSellLevel ?? enabledSellLvlPrices[enabledSellLvlPrices.length - 1] ?? (lowerBound + span * ((sellPcts[sellPcts.length - 1] ?? 92) / 100));
    }

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

    // 🛡️ Downtrend Drop Guard is now fully unified into the single waitingForHigherLow state machine above
    const downtrendDropPaused = false;
    const downtrendDropReason = "";
    this.isDowntrendDropPaused = false;

    // Trendline Filter: Active during breakdown recovery until confirmed breakout occurs
    const downtrendLine = dow?.downtrendLine;
    const trendlineFiltered = Boolean(this.cfg.trendlineFilter && this.waitingForHigherLow && downtrendLine && !downtrendLine.isBroken);
    const uptrendBroken = Boolean(
      (this.cfg.enableBuyAboveTrendSupport !== false) &&
      ((uptrendLine && (uptrendLine.isBroken || refPrice < uptrendLine.currentLinePrice)) ||
      dow?.uptrendBreakdownConfirmed)
    );

    // ── Trendline / Real Ceil Sell Trigger Override ───────────────────────────
    let isTlSellTrigger = false;
    let tlSellPrice: number | undefined;
    const isTlActiveForTrigger = (this.cfg.enableSellBelowTrendResistance !== false) &&
      Boolean(downtrendLine && !downtrendLine.isBroken && !dow?.downtrendBreakoutConfirmed);
    const isRealCeilActiveForTrigger = (this.cfg.enableSellAtRealCeiling !== false) &&
      Boolean(liveCalculatedCeil && liveCalculatedCeil < upperBound);

    if (isTlActiveForTrigger || isRealCeilActiveForTrigger) {
      const tlPrice = (isTlActiveForTrigger && downtrendLine) ? downtrendLine.currentLinePrice : Infinity;
      const rcPrice = (isRealCeilActiveForTrigger && liveCalculatedCeil) ? liveCalculatedCeil : Infinity;
      const effectiveResPrice = Math.min(tlPrice, rcPrice);
      const levelsUnderRes = sellLevels.filter((lvl) => lvl < effectiveResPrice);
      if (levelsUnderRes.length === 0 || effectiveResPrice < sellTrigger) {
        sellTrigger = effectiveResPrice;
        isTlSellTrigger = true;
        tlSellPrice = effectiveResPrice;
      }
    }

    // ── Trendline Buy Trigger Override ───────────────────────────────────────
    let isTlBuyTrigger = false;
    let tlBuyPrice: number | undefined;
    const sellLevel1Cap = sellLevels[0] ?? upperBound;
    if (
      (this.cfg.enableBuyAboveTrendSupport !== false) &&
      uptrendLine &&
      !uptrendLine.isBroken &&
      refPrice >= uptrendLine.currentLinePrice * 0.995 &&
      uptrendLine.currentLinePrice < sellLevel1Cap
    ) {
      const tlPrice = uptrendLine.currentLinePrice;
      // If trendline support sits above standard buyTrigger (i.e. "ถ้าเลย buy target"),
      // the trendline becomes the active primary buy entry (even if Buy L1/L2 are disabled)!
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
        `🔺 [TRIANGLE SQUEEZE] Support ($${uptrendLine!.currentLinePrice.toFixed(6)}) & Resistance ($${downtrendLine!.currentLinePrice.toFixed(6)}) converging (Spread ${tlSpreadPct.toFixed(2)}% <= ${squeezeSpreadThreshold.toFixed(1)}%) — Liquidating all ${this.baseHeld().toFixed(4)} ${this.baseAsset} to cash and standing by for channel expansion!`,
      );
      await this.cancelAllRestingOrders(undefined, "Triangle squeeze: trendlines converging — liquidating and pausing");
      if (this.baseHeld() > 0 && !isBelowFloor && this.cfg.orderExecutionMode === "IOC_BRACKET") {
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
      const isFlatWait = this.isFlatChannelShiftWaiting;
      if (this.isTrendSupportExitActive) {
        const supPriceStr = this.trendSupportBreakPrice ? `$${this.trendSupportBreakPrice.toFixed(this.pricePrecision)}` : "Support TL";
        botActionState = {
          code: "TREND_SUPPORT_BROKEN",
          title: "🛡️ Trend Support Broken (100% Cash)",
          reason: `Support broke (${supPriceStr}) • Liquidated to Cash`,
          nextTrigger: `Paused: Waiting Reversal / Higher Low > $${dumpLow.toFixed(this.pricePrecision)} or Stand > Buy L2 ($${effectiveBuyLevel2Target.toFixed(this.pricePrecision)})`,
          severity: "warning",
        };
      } else if (this.cfg.trendlineFilter && downtrendLine && !downtrendLine.isBroken) {
        const count = downtrendLine.brokenCandleCount;
        botActionState = {
          code: "WAITING_TRENDLINE_BREAKOUT",
          title: count === 1 ? "⏳ TL Breakout (1/2 bars)" : (isFlatWait ? "🛡️ รอตั้งฐาน HL (ใต้เส้นกด)" : "📉 Under Trendline"),
          reason: `${isFlatWait ? `100% Cash • กรอบเปลี่ยน/เสี่ยงทำ LL (Floor: $${dumpFloor.toFixed(4)})` : `Floor broke`} • Under TL ($${downtrendLine.currentLinePrice.toFixed(4)})${count === 1 ? " [1/2 bars breaking]" : ""}`,
          nextTrigger: count === 1
            ? `Wait 2nd candle confirm > $${downtrendLine.currentLinePrice.toFixed(4)}`
            : `Wait breakout > $${downtrendLine.currentLinePrice.toFixed(4)} or Stand above Buy 2 ($${effectiveBuyLevel2Target.toFixed(4)})`,
          severity: "warning",
        };
      } else {
        botActionState = {
          code: "WAITING_HIGHER_LOW",
          title: isFlatWait ? "🛡️ รอตั้งฐาน HL (100% Cash)" : "⏳ Wait Higher Low",
          reason: isFlatWait
            ? `100% Cash • กรอบเปลี่ยน/เสี่ยงทำ LL (Floor: $${dumpFloor.toFixed(4)})`
            : `Floor broke ($${dumpFloor.toFixed(4)})`,
          nextTrigger: `Wait HL > $${dumpLow.toFixed(4)} or Stand above Buy 2 ($${effectiveBuyLevel2Target.toFixed(4)})`,
          severity: "warning",
        };
      }
    } else if (downtrendDropPaused) {
      const dumpLow = dow?.downtrendDropLow ?? lowerBound;
      const channelFloorRef = dow?.activeValley?.price ?? lowerBound;
      const isBreakdown = refPrice < channelFloorRef;
      botActionState = {
        code: "DOWNTREND_DROP_WAIT_BASE",
        title: isBreakdown ? "🛡️ หลุดฐานกรอบ รอตั้งฐาน HL" : "🛡️ ขาลง รอตั้งฐาน HL",
        reason: isBreakdown
          ? `แท่งเทียนหลุดฐานกรอบ ($${channelFloorRef.toFixed(4)}) • หยุดรับมีดชั่วคราว`
          : `รอบคลื่นขาลง (LH + LL กดตัว) • หยุดรับมีดชั่วคราว`,
        nextTrigger: `รอสร้างฐาน HL > $${dumpLow.toFixed(4)} หรือ Breakout เส้นกด`,
        severity: "warning",
      };
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
    } else if (dow?.isSwingConfirmed === false) {
      botActionState = {
        code: "NO_VALID_CHANNEL_WARMUP",
        title: "⏳ No Valid Channel (Standby)",
        reason: `ไม่มีคู่ยอด-เหวที่ความกว้างอยู่ในช่วง [${(this.cfg.minChannelWidthPct ?? 1.8).toFixed(1)}%..${(this.cfg.maxChannelWidthPct ?? 6.0).toFixed(1)}%] • หยุดเล่นไปก่อน`,
        nextTrigger: "รอแท่งเทียนยืนยันยอด/เหวใหม่ที่อยู่ในเกณฑ์ความกว้าง",
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
        reason: `Price ($${refPrice.toFixed(this.pricePrecision)}) < Support TL (${supPriceStr}) • Accumulating at grid levels based on held position`,
        nextTrigger: `Wait to buy at Buy Level $${buyTrigger.toFixed(this.pricePrecision)}`,
        severity: "info",
      };
    } else if (trendlineFiltered && downtrendLine) {
      const count = downtrendLine.brokenCandleCount;
      botActionState = {
        code: "TRENDLINE_DESCENDING_ACTIVE",
        title: count === 1 ? "⏳ TL Breakout (1/2 bars)" : "📉 Under Trendline",
        reason: `Under TL ($${downtrendLine.currentLinePrice.toFixed(this.pricePrecision)})${count === 1 ? " [1/2 bars breaking]" : ""}`,
        nextTrigger: count === 1
          ? `Wait 2nd candle confirm > $${downtrendLine.currentLinePrice.toFixed(this.pricePrecision)}`
          : `Wait breakout > $${downtrendLine.currentLinePrice.toFixed(this.pricePrecision)}`,
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
      const openSells = this.openOrders.filter((o) => !o.isBid);
      const tlSellOrder = openSells.find(
        (o) => o.levelDesc?.includes("TL Exit") || o.levelDesc?.includes("Real Ceil") || o.levelDesc?.includes("Trendline"),
      );
      const refResistancePrice = downtrendLine?.currentLinePrice ?? tlSellPrice ?? sellTrigger;
      const tlFrontRunPct = (tlSellOrder && refResistancePrice > 0)
        ? ((refResistancePrice - tlSellOrder.price) / refResistancePrice) * 100
        : 0;

      let sellStatusPart = "";
      if (tlSellOrder) {
        const diffStr = tlFrontRunPct > 0 ? ` -${tlFrontRunPct.toFixed(2)}%` : "";
        sellStatusPart = `Sell TL Resting @ $${tlSellOrder.price.toFixed(this.pricePrecision)} (TL $${refResistancePrice.toFixed(this.pricePrecision)}${diffStr})`;
      } else if (openSells.length > 0) {
        sellStatusPart = openSells.length === 1
          ? `Sell Resting @ $${openSells[0].price.toFixed(this.pricePrecision)}`
          : `${openSells.length} Sells Resting ($${openSells.map((s) => s.price.toFixed(this.pricePrecision)).join(", ")})`;
      } else if (isTlSellTrigger) {
        sellStatusPart = `Sell Trigger: >$${sellTrigger.toFixed(this.pricePrecision)} (TL Resistance)`;
      } else {
        sellStatusPart = `Sell: >$${sellTrigger.toFixed(this.pricePrecision)}`;
      }

      const isCapacityFull = currentHoldPct >= 95 || inventoryQuote >= this.cfg.maxInventoryQuote - 1.0;

      if (isCapacityFull) {
        botActionState = {
          code: "CAPACITY_FULL",
          title: `📦 Capacity Full (${currentHoldPct.toFixed(0)}%)`,
          reason: `Holding $${inventoryQuote.toFixed(1)} / $${this.cfg.maxInventoryQuote.toFixed(0)} • Buying full`,
          nextTrigger: isTlSellTrigger
            ? `IOC Sell @ Trendline ($${sellTrigger.toFixed(this.pricePrecision)})`
            : `Sell target: >$${sellTrigger.toFixed(this.pricePrecision)}`,
          severity: "info",
        };
      } else if (isTlSellTrigger && this.baseHeld() > 0 && openBuys.length === 0 && openSells.length === 0) {
        const tlSlipPct = (this.cfg.iocSlippagePct ?? 0.2);
        botActionState = {
          code: "WAITING_TRENDLINE_EXIT",
          title: "📉 Waiting TL Sell Exit",
          reason: `Sells paused below TL ($${sellTrigger.toFixed(this.pricePrecision)}) • Holding $${inventoryQuote.toFixed(1)}`,
          nextTrigger: `IOC Sell when price touches TL ($${sellTrigger.toFixed(this.pricePrecision)} • slip ${tlSlipPct.toFixed(2)}%)`,
          severity: "info",
        };
      } else if (openBuys.length > 0 && openSells.length > 0) {
        const buyLvlIdx = buyLevels.findIndex((lvl) => Math.abs(lvl - buyTrigger) <= ((this.tickSize || 0.0001) * 0.5));
        const buyLvlTag = buyLvlIdx >= 0 ? ` (Buy L${buyLvlIdx + 1})` : "";
        botActionState = {
          code: "MAKER_BUY_SELL_RESTING",
          title: `📋 ${openBuys.length} Buys & 💎 ${openSells.length} Sell${openSells.length > 1 ? "s" : ""} Resting`,
          reason: `Buys: ${openBuys.map((o) => `$${o.price.toFixed(this.pricePrecision)}`).join(", ")} • ${tlSellOrder ? `Sell TL: $${tlSellOrder.price.toFixed(this.pricePrecision)}` : `Sell: $${openSells[0].price.toFixed(this.pricePrecision)}`}`,
          nextTrigger: `Fills on flash dip <$${buyTrigger.toFixed(this.pricePrecision)}${buyLvlTag} • ${sellStatusPart}`,
          severity: "success",
        };
      } else if (openBuys.length > 0) {
        const buyLvlIdx = buyLevels.findIndex((lvl) => Math.abs(lvl - buyTrigger) <= ((this.tickSize || 0.0001) * 0.5));
        const buyLvlTag = buyLvlIdx >= 0 ? ` (Buy L${buyLvlIdx + 1})` : "";
        botActionState = {
          code: "MAKER_BUY_RESTING",
          title: `📋 ${openBuys.length} Buys Resting`,
          reason: openBuys.map((o) => `$${o.price.toFixed(this.pricePrecision)}`).join(", "),
          nextTrigger: `Fills on flash dip <$${buyTrigger.toFixed(this.pricePrecision)}${buyLvlTag} • ${sellStatusPart}`,
          severity: "success",
        };
      } else {
        const buyLvlIdx = buyLevels.findIndex((lvl) => Math.abs(lvl - buyTrigger) <= ((this.tickSize || 0.0001) * 0.5));
        const buyLvlTag = buyLvlIdx >= 0 ? ` (Buy L${buyLvlIdx + 1})` : "";
        botActionState = {
          code: "BUY_ZONE_TARGET_MET",
          title: openSells.length > 0
            ? `🎯 Level Target Met • 💎 ${openSells.length} Sell Resting`
            : "🎯 Level Target Met",
          reason: `Holding $${inventoryQuote.toFixed(1)} (${activeLevelName})${openSells.length > 0 ? ` • ${tlSellOrder ? `Sell TL: $${tlSellOrder.price.toFixed(this.pricePrecision)}` : `Sell: $${openSells[0].price.toFixed(this.pricePrecision)}`}` : ""}`,
          nextTrigger: `Buy next dip: <$${buyTrigger.toFixed(this.pricePrecision)}${buyLvlTag} • ${sellStatusPart}`,
          severity: "info",
        };
      }
    } else {
      // In Sell Zone (50% - 100%)
      const openSells = this.openOrders.filter((o) => !o.isBid);
      const openBuys = this.openOrders.filter((o) => o.isBid);
      const tlSellOrder = openSells.find(
        (o) => o.levelDesc?.includes("TL Exit") || o.levelDesc?.includes("Real Ceil") || o.levelDesc?.includes("Trendline"),
      );
      const refResistancePrice = downtrendLine?.currentLinePrice ?? tlSellPrice ?? sellTrigger;
      const tlFrontRunPct = (tlSellOrder && refResistancePrice > 0)
        ? ((refResistancePrice - tlSellOrder.price) / refResistancePrice) * 100
        : 0;

      const isCapacityFull = currentHoldPct >= 95 || inventoryQuote >= this.cfg.maxInventoryQuote - 1.0;

      if (openSells.length > 0) {
        const tlDiffStr = tlFrontRunPct > 0 ? ` -${tlFrontRunPct.toFixed(2)}%` : "";
        botActionState = {
          code: "MAKER_SELL_RESTING",
          title: tlSellOrder
            ? `💎 ${openSells.length} Sell${openSells.length > 1 ? "s" : ""} Resting (TL Exit)`
            : (openBuys.length > 0
                ? `💎 ${openSells.length} Sell${openSells.length > 1 ? "s" : ""} & 📋 ${openBuys.length} Buy${openBuys.length > 1 ? "s" : ""} Resting`
                : `💎 ${openSells.length} Sells Resting`),
          reason: tlSellOrder
            ? `Sell TL: $${tlSellOrder.price.toFixed(this.pricePrecision)} (TL $${refResistancePrice.toFixed(this.pricePrecision)}${tlDiffStr})`
            : openSells.map((o) => `$${o.price.toFixed(this.pricePrecision)}`).join(", "),
          nextTrigger: tlSellOrder
            ? `Resting Limit Sell placed @ $${tlSellOrder.price.toFixed(this.pricePrecision)} (Front-run${tlDiffStr} below TL $${refResistancePrice.toFixed(this.pricePrecision)})`
            : (openSells.length === 1
                ? `Resting Limit Sell placed @ $${openSells[0].price.toFixed(this.pricePrecision)}`
                : `${openSells.length} Resting Limit Sells placed`),
          severity: "success",
        };
      } else if (isTlSellTrigger && this.baseHeld() > 0) {
        const tlSlipPct = (this.cfg.iocSlippagePct ?? 0.2);
        botActionState = {
          code: "WAITING_TRENDLINE_EXIT",
          title: "📉 Waiting TL Sell Exit",
          reason: `Sells suppressed by TL ($${sellTrigger.toFixed(this.pricePrecision)}) • Holding $${inventoryQuote.toFixed(1)}`,
          nextTrigger: `IOC Sell when price touches TL ($${sellTrigger.toFixed(this.pricePrecision)} • slip ${tlSlipPct.toFixed(2)}%)`,
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
        downtrendDropPaused,
        waitingForHigherLow: this.waitingForHigherLow,
        isFlatChannelShiftWaiting: this.isFlatChannelShiftWaiting,
        isTrendSupportExitActive: this.isTrendSupportExitActive,
        trendSupportBreakPrice: this.trendSupportBreakPrice,
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
        walletBaseValueQuote: (this.walletBaseTotal > 0 ? this.walletBaseTotal : this.walletBaseBalance) * valuationBid,
        walletTotalValueQuote: this.getTotalPortfolioValueQuote(valuationBid),
        walletSomiValueUsdso: (this.walletBaseTotal > 0 ? this.walletBaseTotal : this.walletBaseBalance) * valuationBid,
        walletTotalValueUsdso: this.getTotalPortfolioValueQuote(valuationBid),
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
        enabledBuyLevels: this.cfg.enabledBuyLevels ?? [true, true, true, true, true],
        enabledSellTargets: this.cfg.enabledSellTargets ?? [true, true, true, true, true],
        buyLevelPcts: this.cfg.buyLevelPcts ?? [42, 32, 22, 12, 2],
        sellLevelPcts: this.cfg.sellLevelPcts ?? [52, 62, 72, 82, 92],
        buySizingMode: this.cfg.buySizingMode ?? "PYRAMID",
        buyLevelWeights: this.cfg.buyLevelWeights ?? [10, 15, 20, 25, 30],
        buyWeightFractions: this.getBuyLevelWeightFractions(),
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
        enableExitOnTrendSupportBreak: this.cfg.enableExitOnTrendSupportBreak !== false,
        breakevenEscapeProfitPct: this.cfg.breakevenEscapeProfitPct ?? 0.06,
        maxActiveMakerBuys: this.cfg.maxActiveMakerBuys ?? 2,
        isBelowFloor,
        isAboveCeiling,
        zoneWidthPct: gridZone?.zoneWidthPct ?? 0,
        channelMode: this.cfg.channelMode,
        clampStatus: gridZone?.clampStatus ?? "NATURAL_SWING",
        rawWidthPct: gridZone?.rawWidthPct,
        minWidthPct: gridZone?.minWidthPct,
        maxWidthPct: gridZone?.maxWidthPct,
        anchorSide: gridZone?.anchorSide ?? "NONE",
        isChannelLocked: Boolean(isHoldingPosition && lockChannelInPosition && this.lockedChannel),
        liveCalculatedUpperBound: dow?.isSwingConfirmed && (dow.upperBound ?? 0) > 0 ? (dow.gridZone?.upperBound ?? dow.upperBound) : undefined,
        liveCalculatedBottomBound: dow?.isSwingConfirmed && (dow.bottomBound ?? 0) > 0 ? (dow.gridZone?.bottomBound ?? dow.bottomBound) : undefined,
        regime: activeRegime,
        isSwingConfirmed: dow?.isSwingConfirmed ?? false,
        maxInventoryQuote: this.cfg.maxInventoryQuote,
        maxInventoryUsdso: this.cfg.maxInventoryQuote,
        intervalMs: this.cfg.intervalMs ?? 2000,
        stuckSince: this.stuckSince,
        stuckTimeoutMs: this.cfg.stuckTimeoutMs,
        lots: this.lots.map((l) => ({ price: l.price, qty: l.qty, time: l.time })),
        soldSellIndices: Array.from(this.soldSellIndices),
        orderExecutionMode: this.cfg.orderExecutionMode ?? "IOC_BRACKET",
        iocBracketSellCycle: this.iocBracketSellCycle
          ? {
              baselineHeldQuote: this.iocBracketSellCycle.baselineHeldQuote,
              baselineHeldQty: this.iocBracketSellCycle.baselineHeldQty,
              numSellTranches: this.iocBracketSellCycle.numSellTranches,
              soldStepNums: Array.from(this.iocBracketSellCycle.soldStepNums),
            }
          : undefined,
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
        pricePrecision: this.pricePrecision,
        qtyPrecision: this.qtyPrecision,
        tickSize: this.tickSize && this.tickSize > 0 ? this.tickSize : (1 / Math.pow(10, this.pricePrecision || 2)),
        stepSize: this.stepSize && this.stepSize > 0 ? this.stepSize : (1 / Math.pow(10, this.qtyPrecision || 4)),
        minQty: this.minQty,
        minNotional: this.minNotional,
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
          ` | Next Buy: $${buyTrigger.toFixed(6)}${dow?.isSwingConfirmed === false ? " [Paused: No Valid Channel]" : ""}${this.waitingForHigherLow ? ` [Paused: Wait Higher Low > $${(this.breakdownLowPrice ?? effectiveMid).toFixed(6)}]` : !inBuyZone ? " [Wait <50%]" : ""}${trendFiltered ? " [Paused: Downtrend]" : ""}${downtrendDropPaused ? ` ${downtrendDropReason}` : ""}${trendlineFiltered && downtrendLine ? ` [Paused: Under TL $${downtrendLine.currentLinePrice.toFixed(6)}]` : ""}${uptrendBroken && uptrendLine ? ` [Below TL Support $${uptrendLine.currentLinePrice.toFixed(6)} → Grid Buy]` : ""}${this.isSqueezePaused ? " [Paused: Triangle Squeeze Standby]" : ""}${laggardGuardActive ? " [Paused: Lag Guard]" : ""}` +
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

    // ── 2a. Resistance IOC Exit: If price tests or touches the active resistance (Trendline or Real S/R Ceil), sell immediately ──
    // In MAKER_LIMIT mode: Selling at resistance is handled exclusively by resting Maker limit orders! Never execute IOC taker sells.
    const isIocModeForRes = this.cfg.orderExecutionMode === "IOC_BRACKET";
    const isTlActiveForIoc = isIocModeForRes && (this.cfg.enableSellBelowTrendResistance !== false) && Boolean(downtrendLine && !downtrendLine.isBroken && !dow?.downtrendBreakoutConfirmed);
    const isRealCeilActiveForIoc = isIocModeForRes && (this.cfg.enableSellAtRealCeiling !== false) && liveRealCeil !== undefined && liveRealCeil > 0 && liveRealCeil < upperBound;

    if (isTlActiveForIoc || isRealCeilActiveForIoc) {
      const tlPrice = (isTlActiveForIoc && downtrendLine) ? downtrendLine.currentLinePrice : Infinity;
      const rcPrice = (isRealCeilActiveForIoc && liveRealCeil) ? liveRealCeil : Infinity;
      const effectiveResPrice = Math.min(tlPrice, rcPrice);
      const isUsingRealCeil = isRealCeilActiveForIoc && liveRealCeil !== undefined && effectiveResPrice === liveRealCeil;
      const resDisplayName = isUsingRealCeil ? "Real S/R Ceil" : "Trendline";
      const tlState = downtrendLine && (downtrendLine.brokenCandleCount ?? 0) > 0
        ? `Break 1/2 bars ⏳`
        : "Active 🔴";

      // Debug log every ~30s (avoid spamming every tick)
      const debugCooldownKey = "res_debug_log";
      const lastDebug = this.orderCooldowns.get(debugCooldownKey) ?? 0;
      if (Date.now() - lastDebug > 30_000) {
        this.orderCooldowns.set(debugCooldownKey, Date.now());
        this.log(
          `📉 [RES DEBUG] ${resDisplayName} @ $${effectiveResPrice.toFixed(6)} | Price: $${refPrice.toFixed(6)} | ${refPrice > effectiveResPrice ? `ABOVE ${resDisplayName} → IOC candidate` : `Below ${resDisplayName} → resting orders below resistance`}`,
        );
      }

      if (this.baseHeld() > 0 && !isBelowFloor) {
        // Check Best Bid liquidity on DEX/CEX before executing IOC
        const effectiveBestBid = bestBid !== undefined && bestBid > 0 ? bestBid : (currentBestBid > 0 ? currentBestBid : undefined);
        const avgEntry = this.getAvgEntryPrice();
        const sellSlippage = (this.cfg.iocSlippagePct ?? 0.2) / 100;
        const minAllowedResPrice = effectiveResPrice * (1 - sellSlippage);
        // Strictly require Best Bid to match or exceed resistance price (no premature selling below resistance)
        const isBidAtResistance = effectiveBestBid !== undefined && effectiveBestBid >= effectiveResPrice;
        const isProfitableAtBid = avgEntry <= 0 || (effectiveBestBid !== undefined && effectiveBestBid >= avgEntry * this.getMinProfitMultiplier());
        const isPriceAtResistance = (effectiveBestBid !== undefined && effectiveBestBid >= effectiveResPrice) || (refPrice >= effectiveResPrice);

        if (isPriceAtResistance) {
          if (effectiveBestBid !== undefined && !isBidAtResistance) {
            // Bid has not reached resistance yet -> hold off to avoid selling below resistance
            if (Date.now() - (this.orderCooldowns.get("res_ioc_bid_warn") ?? 0) > 30_000) {
              this.orderCooldowns.set("res_ioc_bid_warn", Date.now());
              this.log(
                `⏳ [RES IOC STANDBY] Price $${refPrice.toFixed(6)} reached ${resDisplayName} ($${effectiveResPrice.toFixed(6)}) but Best Bid $${effectiveBestBid.toFixed(6)} has not reached resistance — waiting for bid to match level`,
              );
            }
          } else if (effectiveBestBid !== undefined && !isProfitableAtBid) {
            // Best bid would result in a loss below avg entry -> hold off
            if (Date.now() - (this.orderCooldowns.get("res_ioc_loss_warn") ?? 0) > 30_000) {
              this.orderCooldowns.set("res_ioc_loss_warn", Date.now());
              this.log(
                `⏳ [RES IOC STANDBY] Price $${refPrice.toFixed(6)} reached ${resDisplayName} $${effectiveResPrice.toFixed(6)} but Best Bid $${effectiveBestBid.toFixed(6)} is below Avg Entry $${avgEntry.toFixed(6)} — holding for profit`,
              );
            }
          } else if (effectiveBestBid !== undefined && isBidAtResistance && isProfitableAtBid) {
            const iocCooldownKey = `res_ioc_sell`;
            const lastIocTime = this.orderCooldowns.get(iocCooldownKey) ?? 0;
            const iocCooldownMs = 30_000; // 30-second cooldown to prevent rapid re-triggers

            if (Date.now() - lastIocTime > iocCooldownMs) {
              this.orderCooldowns.set(iocCooldownKey, Date.now());
              const sellExecPrice = effectiveBestBid;

              this.log(
                `📉 [RES IOC] Triggered (refPrice: $${refPrice.toFixed(6)}, Best Bid: $${sellExecPrice.toFixed(6)} >= ${resDisplayName}: $${effectiveResPrice.toFixed(6)} - ${(sellSlippage * 100).toFixed(2)}% slip: $${minAllowedResPrice.toFixed(6)}) — executing IOC sell at Best Bid $${sellExecPrice.toFixed(6)} for all ${this.baseHeld().toFixed(4)} ${this.baseAsset} (Avg Entry: $${avgEntry.toFixed(6)})`,
              );
              if (this.openOrders.length > 0) {
                await this.cancelAllRestingOrders(undefined, `${resDisplayName} IOC sell: cancelling resting orders before IOC execution`);
              }
              await this.sellAll(sellExecPrice, "SELL", effectiveResPrice);
            }
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
    const buyActionTerm = this.cfg.orderExecutionMode === "IOC_BRACKET" ? "IOC buy trigger" : "buy orders";
    const sellL1Pct = this.cfg.sellLevelPcts?.[0] ?? 52;
    if (!isCexExchange && this.cfg.enableBuyBelowSellLevel1 !== false) {
      const isDexAskInAccumulationZone = currentBestAsk > 0 && currentBestAsk <= sellLevel1Price;
      if (this.buyOrdersActive && (positionPct > (sellL1Pct + 0.5) || refPrice > sellLevel1Price * 1.001) && !isDexAskInAccumulationZone) {
        this.buyOrdersActive = false;
        this.log(`🛑 Price ($${refPrice.toFixed(6)} | ${positionPct.toFixed(1)}%) above Sell Level 1 ($${sellLevel1Price.toFixed(6)}) — pausing ${buyActionTerm} to prevent churn in upper profit zone`);
        this.saveState();
      } else if (!this.buyOrdersActive && (positionPct <= sellL1Pct || refPrice <= sellLevel1Price || isDexAskInAccumulationZone)) {
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
    const buyL1Pct = this.cfg.buyLevelPcts?.[0] ?? 42;
    if (!isCexExchange && this.cfg.enableSellAboveBuyLevel1 !== false) {
      if (this.sellOrdersActive && (positionPct < (buyL1Pct - 0.5) || refPrice < buyLevel1Price * 0.999)) {
        this.sellOrdersActive = false;
        this.log(`🛑 Price ($${refPrice.toFixed(6)} | ${positionPct.toFixed(1)}%) below Buy Level 1 ($${buyLevel1Price.toFixed(6)}) — pausing ${sellActionTerm} to prevent churn in lower accumulation zone`);
        this.saveState();
      } else if (!this.sellOrdersActive && (positionPct >= buyL1Pct || refPrice >= buyLevel1Price)) {
        this.sellOrdersActive = true;
        this.needsSellRebalance = true;
        this.log(`🟢 Price ($${refPrice.toFixed(6)} | ${positionPct.toFixed(1)}%) returned above Buy Level 1 ($${buyLevel1Price.toFixed(6)}) — reactivating ${sellActionTerm}`);
        this.saveState();
      }
    } else {
      this.sellOrdersActive = true;
    }

    const canBuy = !offloadOnly && !trendFiltered && !trendlineFiltered && !downtrendDropPaused && !this.isSqueezePaused && !laggardGuardActive && !this.waitingForHigherLow && !isBelowFloor && this.buyOrdersActive && (dow?.isSwingConfirmed !== false);


    if (this.cfg.orderExecutionMode === "IOC_BRACKET") {
      await this.orderExecutor.executeIocBracketGrid({
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
        activeDowntrendLine: downtrendLine ?? undefined,
        activeUptrendLine: uptrendLine ?? undefined,
        uptrendBroken,
      });
    } else {
      await this.buySync.syncBuyOrders({
        buyLevels,
        sellLevels,
        lowerBound,
        upperBound,
        span,
        positionPct,
        canBuy,
        currentBestAsk,
        currentBestBid,
        refPrice,
        activeDowntrendLine: downtrendLine ?? undefined,
        activeUptrendLine: uptrendLine ?? undefined,
        uptrendBroken,
        dow,
        cancelAllRestingOrders: (side, reason) => this.orderExecutor.cancelAllRestingOrders(side, reason),
        cancelOrderInternal: (order, reason) => this.orderExecutor.cancelOrderInternal(order, reason),
        placeRestingOrder: (isBid, price, qty, targetFraction, notionalQuote, levelDesc) =>
          this.orderExecutor.placeRestingOrder(isBid, price, qty, targetFraction, notionalQuote, levelDesc),
        buyTrancheIOC: (qty, execPrice, levelName, targetPrice, notionalQuote) =>
          this.orderExecutor.buyTrancheIOC(qty, execPrice, levelName, targetPrice, notionalQuote),
      });
      await this.sellSync.syncSellOrders({
        sellLevels,
        lowerBound,
        upperBound,
        refPrice,
        currentBestBid,
        currentBestAsk,
        activeDowntrendLine: downtrendLine ?? undefined,
        liveRealCeil,
        dow,
        cancelAllRestingOrders: (side, reason) => this.orderExecutor.cancelAllRestingOrders(side, reason),
        cancelOrderInternal: (order, reason) => this.orderExecutor.cancelOrderInternal(order, reason),
        placeRestingOrder: (isBid, price, qty, targetFraction, notionalQuote, levelDesc) =>
          this.orderExecutor.placeRestingOrder(isBid, price, qty, targetFraction, notionalQuote, levelDesc),
        sellTrancheIOC: (qty, execPrice, levelName, targetPrice, allowLoss) =>
          this.orderExecutor.sellTrancheIOC(qty, execPrice, levelName, targetPrice, allowLoss),
      });
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
        this.lastCutLossTime = Date.now();
        this.waitingForHigherLow = true;
        this.isFlatChannelShiftWaiting = false;
        this.lastResolvedDumpLowPrice = undefined;
        this.breakdownFloorPrice = lowerBound;
        this.breakdownLowPrice = bestBid;
        this.breakdownTime = Math.floor(Date.now() / 1000);
        this.breakdownBuyLevel2Price = isChannelReady && buyLevels.length > 1 && buyLevels[1] > 0.0001
          ? buyLevels[1]
          : (lowerBound > 0 ? lowerBound + span * 0.32 : bestBid * 1.01);
        this.stuckSince = undefined;
    this.lastBuyFillTime = 0;
    this.lastBuyFillPrice = 0;
    this.lastBuyFillCandleTime = 0;
        this.saveState();
      }
    } else if (this.lots.length === 0) {
      this.stuckSince = undefined;
    this.lastBuyFillTime = 0;
    this.lastBuyFillPrice = 0;
    this.lastBuyFillCandleTime = 0;
    }
  }

  /**
   * Shared helper: Process a confirmed BUY fill (gas compensation, lot creation, emit, log)
   */
  private recalcStep(): void {
    const fresh = this.atrSource.isFresh?.() ?? true;
    if (!fresh) return;

    const atrPct = this.atrSource.atrPct();
    if (atrPct === undefined) return;

    const raw = atrPct * 10_000 * this.cfg.atrMultiplier;
    const clamped = Math.min(this.cfg.maxStepBps, Math.max(this.cfg.minStepBps, raw));
    this.stepBps = clamped;
  }

  public getAvgEntryPrice(): number {
    return this.lotTracker.getAvgEntryPrice();
  }

  public baseHeld(): number {
    return this.lotTracker.baseHeld();
  }

  public closeLots(qty: number, exitPrice: number) {
    return this.lotTracker.closeLots(qty, exitPrice);
  }

  public async placeRestingOrder(
    isBid: boolean,
    price: number,
    qty: number,
    targetFraction: number,
    notionalQuote: number,
    levelDesc: string,
  ): Promise<void> {
    return this.orderExecutor.placeRestingOrder(isBid, price, qty, targetFraction, notionalQuote, levelDesc);
  }

  public async cancelOrderInternal(order: OpenOrder, reason: string): Promise<void> {
    return this.orderExecutor.cancelOrderInternal(order, reason);
  }

  public async cancelAllRestingOrders(side?: "BUY" | "SELL", reason = "Strategy reset / Channel shifted"): Promise<void> {
    return this.orderExecutor.cancelAllRestingOrders(side, reason);
  }

  public async sellTrancheIOC(
    qty: number,
    execPrice: number,
    levelName: string,
    targetPrice: number,
    allowLoss = false,
  ): Promise<boolean> {
    return this.orderExecutor.sellTrancheIOC(qty, execPrice, levelName, targetPrice, allowLoss);
  }

  public async buyTrancheIOC(
    qty: number,
    execPrice: number,
    levelName: string,
    targetPrice: number,
    notionalQuote: number,
  ): Promise<boolean> {
    return this.orderExecutor.buyTrancheIOC(qty, execPrice, levelName, targetPrice, notionalQuote);
  }

  public async sellAll(price: number, action: "SELL" | "CUT" | "MANUAL", anchorRefPrice?: number): Promise<void> {
    return this.orderExecutor.sellAll(price, action, anchorRefPrice);
  }

  public async trackTxGas(txHash?: string, label?: string): Promise<void> {
    return this.orderExecutor.trackTxGas(txHash, label);
  }

  public async checkOrderFills(bestBid: number, bestAsk: number, mid: number): Promise<void> {
    return this.orderExecutor.checkOrderFills(bestBid, bestAsk, mid);
  }

  public processBuyFill(opts: any): void {
    return this.orderExecutor.processBuyFill(opts);
  }

  public processSellFill(opts: any): void {
    return this.orderExecutor.processSellFill(opts);
  }
}
