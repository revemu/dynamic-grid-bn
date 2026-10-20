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
import type { DowStructureEngine, DowStructure, GridZone, Candle } from "./market-structure.js";
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
  private lastBestBid?: number;
  private lastBestAsk?: number;
  private stuckSince?: number;
  private waitingForHigherLow = false;
  private isFlatChannelShiftWaiting = false;
  private wasFlatCashLastTick = true;
  private lastEvaluatedFloor?: number;
  private lastEvaluatedCeil?: number;
  private breakdownFloorPrice?: number;
  private breakdownLowPrice?: number;
  private breakdownBuyLevel2Price?: number;
  private breakdownTime?: number;
  private lastResolvedDumpLowPrice?: number;
  private breakdownCandleTimes = new Set<number>();
  private lastCutLossTime?: number;
  private bufferBreakStartTime?: number;
  private cutLossStage1Executed = false;
  private cutLossStage1Price?: number;
  private cutLossStage1CandleTime?: number;
  private postCutSingleTrancheOnly = false;
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
  private confirmedChannel?: {
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
  private pendingConfirmedChannelUpdate = false;
  private lockedChannel?: LockedChannel;
  private lastActivePeakTime?: number;
  private lastActivePeakPrice?: number;
  private lastActiveValleyTime?: number;
  private lastActiveValleyPrice?: number;
  /** State machine for IOC Bracket Sell distribution cycle */
  private iocBracketSellCycle?: {
    baselineHeldQuote: number;
    baselineHeldQty: number;
    numSellTranches: number;
    soldStepNums: Set<number>;
  };
  /** Indices of Sell Targets (0..4) that have already been executed/sold in the current inventory wave */
  private soldSellIndices = new Set<number>();
  private lastTelemetryData?: any;
  private lastHudLogTime = 0;
  private readonly hudLogIntervalMs = 5_000;
  private tickCount = 0;
  private isPaused = true;
  private isSqueezePaused = false;
  private isDowntrendDropPaused = false;
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
  private lastObservedBaseBalance = 0;
  private lastObservedQuoteBalance = 0;
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
  private wsBookTicker?: BookTickerData;
  private lastPeriodicSyncTs = 0;
  private readonly periodicSyncIntervalMs = 30_000; // Background sanity check every 30s instead of 200ms!

  /** Throttled status logger */
  private readonly status: (msg: string) => void;

  constructor(
    private binance: IExchangeClient,
    private symbolInfo: ExchangeSymbolInfo,
    private readonly cfg: Config,
    private atrSource: AtrSource,
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
    this.qtyPrecision = symbolInfo.qtyPrecision ?? 4;
    this.pricePrecision = symbolInfo.pricePrecision ?? 6;
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
      this.accumulatedGasBase += feeSomi;
      this.totalGasSpentBase += feeSomi;
      const refP = this.lastRefPrice || this.getAvgEntryPrice() || 0.20;
      const feeQuote = feeSomi * refP;
      this.accumulatedGasQuote += feeQuote;
      this.totalGasSpentQuote += feeQuote;
      this.totalTxCount++;
      this.log(
        `⛽ [DEX GAS TRACKED] ${label || "On-Chain Op"}${txHash ? ` (${txHash.slice(0, 10)}...)` : ""}: Spent ${feeSomi.toFixed(5)} SOMI (~$${feeQuote.toFixed(4)}) | Total uncompensated gas: ${this.accumulatedGasBase.toFixed(5)} SOMI`,
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
            gasFeeBase: feeSomi,
            gasFeeQuote: feeQuote,
            gasFeeSomi: feeSomi,
            gasFeeUsdso: feeQuote,
          },
        });
      }
    };
  }

  private isSwitchingSymbol = false;

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
  private hasLotNearLevel(levelPrice: number, levelIdx: number, levels: number[], expectedTrancheQty?: number): boolean {
    if (this.lots.length === 0 || !levelPrice || !levels || levels.length === 0) return false;
    const prevLvl = levelIdx > 0 ? levels[levelIdx - 1] : undefined;
    const nextLvl = levelIdx < levels.length - 1 ? levels[levelIdx + 1] : undefined;
    const distToAdjacent = Math.min(
      prevLvl ? Math.abs(prevLvl - levelPrice) : Infinity,
      nextLvl ? Math.abs(nextLvl - levelPrice) : Infinity,
    );
    const maxProximityRatio = isFinite(distToAdjacent) && distToAdjacent > 0
      ? Math.min(0.0015, (distToAdjacent / levelPrice) * 0.35)
      : 0.0015;

    const lotsNearPrice = this.lots.filter((l) => Math.abs(l.price - levelPrice) / levelPrice <= maxProximityRatio);
    if (lotsNearPrice.length === 0) return false;

    if (expectedTrancheQty && expectedTrancheQty > 0) {
      const totalQtyNear = lotsNearPrice.reduce((sum, l) => sum + l.qty, 0);
      return totalQtyNear >= expectedTrancheQty * 0.40;
    }

    return true;
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
      if (this.soldSellIndices.size === 0 && this.recentOrders.length > 0 && this.lots.length > 0) {
        for (let i = this.recentOrders.length - 1; i >= 0; i--) {
          const ord = this.recentOrders[i];
          if (!ord) continue;
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
      const persistentLockedChannel = this.db.getLockedChannel(symbolKey) || data.lockedChannel;

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
        isFlatChannelShiftWaiting: this.isFlatChannelShiftWaiting,
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
    this.breakdownFloorPrice = undefined;
    this.breakdownLowPrice = undefined;
    this.breakdownBuyLevel2Price = undefined;
    this.breakdownTime = undefined;
    this.lastResolvedDumpLowPrice = undefined;
    this.breakdownCandleTimes.clear();
    this.sellOrdersActive = true;
    this.buyOrdersActive = true;
    this.stuckSince = undefined;
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
    this.breakdownFloorPrice = undefined;
    this.breakdownLowPrice = undefined;
    this.breakdownBuyLevel2Price = undefined;
    this.breakdownTime = undefined;
    this.lastResolvedDumpLowPrice = undefined;
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
      dow = this.confirmedChannel!.dow;
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

    if (this.waitingForHigherLow) {
      const candidateLow = dow?.downtrendDropLow !== undefined ? Math.min(refPrice, dow.downtrendDropLow) : refPrice;
      if (this.breakdownLowPrice === undefined || candidateLow < this.breakdownLowPrice) {
        this.breakdownLowPrice = candidateLow;
        if (refPrice <= candidateLow * 1.0005) {
          this.breakdownTime = Math.floor(Date.now() / 1000);
        }
        this.saveState();
      }

      const cutLossCooldownMs = 15 * 60 * 1000; // 15m (1 candle) mandatory cooldown after Cut Loss
      const elapsedSinceCutMs = this.lastCutLossTime ? (Date.now() - this.lastCutLossTime) : Infinity;
      const isInCutLossCooldown = elapsedSinceCutMs < cutLossCooldownMs;

      const closedCandlesList = this.dowEngine?.getClosedCandles() ?? [];
      const confirmedLastClosed = closedCandlesList.length > 0 ? closedCandlesList[closedCandlesList.length - 1] : undefined;
      const trackedLow = this.breakdownLowPrice ?? (dow?.downtrendDropLow ?? lowerBound);

      // 1. Resolve via Confirmed Closed Candle reclaiming Buy Level 2 (32% Zone) above dump trough
      const isCandleStandingAboveBuy2 = Boolean(
        !isBelowFloor &&
        confirmedLastClosed &&
        confirmedLastClosed.close >= effectiveBuyLevel2Target * 0.9995 &&
        refPrice >= effectiveBuyLevel2Target * 0.999 &&
        refPrice >= trackedLow * 1.002,
      );

      // 2. Resolve via Trendline Breakout (>= 2 confirmed candles)
      const isTlBreakoutResolved = Boolean(
        !isBelowFloor &&
        (dow?.downtrendBreakoutConfirmed ||
          (dow?.downtrendLine && (dow.downtrendLine.isBroken || dow.downtrendLine.breakoutConfirmed) && (dow.downtrendLine.brokenCandleCount ?? 0) >= 2)),
      );

      const resolveRecovery = (logMessage: string) => {
        this.log(logMessage);
        this.lastResolvedDumpLowPrice = Math.min(trackedLow, dow?.downtrendDropLow ?? trackedLow);
        this.waitingForHigherLow = false;
        this.isFlatChannelShiftWaiting = false;
        this.isDowntrendDropPaused = false;
        this.breakdownTime = undefined;
        this.breakdownFloorPrice = undefined;
        this.breakdownLowPrice = undefined;
        this.breakdownBuyLevel2Price = undefined;
        this.saveState();
      };

      if (isInCutLossCooldown) {
        const remainMin = Math.ceil((cutLossCooldownMs - elapsedSinceCutMs) / 60000);
        this.status(
          `⏳ POST-CUT-LOSS COOLDOWN: Waiting ${remainMin}m before allowing floor recovery & re-entry (preventing bottom whipsaw)`,
        );
      } else if (isCandleStandingAboveBuy2) {
        resolveRecovery(
          `🚀 BUY LEVEL 2 RECOVERY CONFIRMED @ $${refPrice.toFixed(6)} (Confirmed Closed Candle $${confirmedLastClosed!.close.toFixed(6)} >= Buy Level 2 $${effectiveBuyLevel2Target.toFixed(6)}) — Breakdown resolved, enabling recovery entry!`,
        );
      } else if (isTlBreakoutResolved) {
        const brokenCount = dow?.downtrendLine?.brokenCandleCount ?? 2;
        const linePriceStr = dow?.downtrendLine ? `TL $${dow.downtrendLine.currentLinePrice.toFixed(6)}` : "downtrend line";
        resolveRecovery(
          `🚀 TRENDLINE BREAKOUT CONFIRMED (${brokenCount} candles) @ $${refPrice.toFixed(6)} (Broke above ${linePriceStr}) — Breakdown resolved, enabling recovery entry!`,
        );
      } else if (!isBelowFloor && (this.breakdownFloorPrice || this.breakdownLowPrice || lowerBound > 0)) {
        // 3. Resolve via Confirmed Higher Low (3-Bar Swing HL or Fast 2-Bar Micro-HL)
        const checkTime = this.breakdownTime ?? (Math.floor(Date.now() / 1000) - 3600);
        const checkFloor = this.breakdownFloorPrice ?? lowerBound;
        const checkLow = trackedLow;

        const hlCheck =
          this.localTrendEngine?.checkForHigherLow(checkTime, checkFloor, checkLow, refPrice) ??
          this.dowEngine?.checkForHigherLow(checkTime, checkFloor, checkLow, refPrice);

        if (hlCheck && hlCheck.confirmed && hlCheck.higherLow) {
          resolveRecovery(
            `✅ HIGHER LOW (HL) CONFIRMED @ $${hlCheck.higherLow.price.toFixed(6)} (${hlCheck.reason}) — Breakdown resolved, enabling recovery entry!`,
          );
        } else if (
          isChannelReady &&
          this.breakdownFloorPrice !== undefined &&
          lowerBound >= this.breakdownFloorPrice * 0.998 &&
          refPrice >= this.breakdownFloorPrice * 1.002 &&
          (confirmedLastClosed && confirmedLastClosed.close >= this.breakdownFloorPrice)
        ) {
          resolveRecovery(
            `🚀 CHANNEL FLOOR RECLAIMED @ $${refPrice.toFixed(6)} >= Original Breakdown Floor $${this.breakdownFloorPrice.toFixed(6)} — Breakdown resolved, enabling recovery entry!`,
          );
        }
      }
    }

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

    if (
      this.cfg.cutLossAtLowerBound &&
      isBelowFloor
    ) {
      const isInitialBreakdown = !this.waitingForHigherLow;
      this.waitingForHigherLow = true;
      this.breakdownFloorPrice = this.breakdownFloorPrice ?? lowerBound;
      this.breakdownTime = this.breakdownTime ?? Math.floor(Date.now() / 1000);
      this.breakdownLowPrice = this.breakdownLowPrice !== undefined ? Math.min(this.breakdownLowPrice, refPrice) : refPrice;
      this.breakdownBuyLevel2Price = this.breakdownBuyLevel2Price ?? buyLevels[1];

      // Track confirmed CLOSED candle bars whose CLOSE price (body) is strictly below Channel Floor (lowerBound)
      let confirmedCandlesCount = 0;
      this.breakdownCandleTimes.clear();
      for (let i = closedCandles.length - 1; i >= 0; i--) {
        if (closedCandles[i].close < lowerBound) {
          confirmedCandlesCount++;
          this.breakdownCandleTimes.add(closedCandles[i].time);
        } else {
          break; // unbroken streak of closed candles below floor
        }
      }

      const cutLossOnBufferOnly = this.cfg.cutLossOnBufferOnly !== false;
      const isFloorCandleCut = !cutLossOnBufferOnly && (confirmedCandlesCount >= (this.cfg.cutLossConfirmCandles ?? 1));
      const shouldExecuteCut = isFastBufferCut || isFloorCandleCut;
      const stage2Mult = Math.max(1.2, Number(this.cfg.cutLossStage2Multiplier ?? 2.0));
      const stage2CutBound = lowerBound - bufferAmount * stage2Mult;
      const isBelowStage2Bound = isChannelReady && refPrice < stage2CutBound;
      const isStage2CandleClosed = Boolean(
        this.cutLossStage1Executed &&
        latestClosedCandle &&
        this.cutLossStage1CandleTime !== undefined &&
        latestClosedCandle.time > this.cutLossStage1CandleTime &&
        this.cutLossStage1Price !== undefined &&
        latestClosedCandle.close < this.cutLossStage1Price
      );

      if (!this.isPaused && this.lots.length > 0) {
        const dexBid = bestBid ?? effectiveMid;
        const maxAllowedBidDiscount = this.cfg.cutLossMaxBidDiscountPct ?? 2.5;
        const bidDiscountPct = binancePrice && binancePrice > 0 ? ((binancePrice - dexBid) / binancePrice) * 100 : 0;
        const isBidTooDepressed = bidDiscountPct > maxAllowedBidDiscount;

        // Cancel resting buy orders immediately so we never buy more while below floor
        await this.cancelAllRestingOrders("BUY");

        if (isBidTooDepressed) {
          this.status(
            `⚠️ CUT LOSS PAUSED: Price broken below floor/buffer ($${refPrice.toFixed(6)} | Floor: $${lowerBound.toFixed(6)} | Buffer: $${cutLossBound.toFixed(6)}) but DEX Bid $${dexBid.toFixed(6)} is discounted ${bidDiscountPct.toFixed(2)}% below Binance (Limit: ${maxAllowedBidDiscount.toFixed(1)}%) — Holding off fire-sale dump until DEX Bid liquidity normalizes.`,
          );
        } else if (!shouldExecuteCut) {
          if (isBelowBuffer) {
            const remSec = Math.max(0, Math.ceil((bufferDelayMs - bufferBreakElapsedMs) / 1000));
            this.status(
              `⏳ FAST CUT PENDING (BUFFER BREAK): Price $${refPrice.toFixed(6)} < Buffer $${cutLossBound.toFixed(6)} — below buffer for ${(bufferBreakElapsedMs / 1000).toFixed(0)}s (${remSec}s remaining until Emergency Fast Cut)`,
            );
          } else if (cutLossOnBufferOnly) {
            this.status(
              `⏳ BELOW FLOOR (BUY PAUSED): Price $${refPrice.toFixed(6)} < Floor $${lowerBound.toFixed(6)} (Above Buffer $${cutLossBound.toFixed(6)}) — holding lots, buy paused until reclaim or buffer break`,
            );
          } else {
            this.status(
              `⏳ FLOOR BREAK PENDING (1 CANDLE): Price $${refPrice.toFixed(6)} < Floor $${lowerBound.toFixed(6)} — waiting for 1 confirmed CLOSED candle with body < Floor (Current: ${confirmedCandlesCount}/1 closed bar)`,
            );
          }
        } else {
          const lastClosedStr = lastClosedCandle ? `Last Closed Bar: $${lastClosedCandle.close.toFixed(6)} | ` : "";
          const exitActionDesc = this.openOrders.length > 0 ? "cancelling resting orders & executing clean exit" : "executing clean exit";
          const triggerReason = isFastBufferCut
            ? (bufferDelayMs <= 0
                ? `INSTANT CUT ON BUFFER BREAK: Price $${refPrice.toFixed(6)} < Buffer $${cutLossBound.toFixed(6)}`
                : (isBufferCandleClosed
                    ? `CLOSED CANDLE CONFIRMED BELOW BUFFER: ${lastClosedStr}Price $${refPrice.toFixed(6)} < Buffer $${cutLossBound.toFixed(6)}`
                    : `EMERGENCY FAST CUT (> ${Math.round(bufferDelayMs / 1000)}s BELOW BUFFER): Price $${refPrice.toFixed(6)} stayed below Buffer $${cutLossBound.toFixed(6)} for ${(bufferBreakElapsedMs / 1000).toFixed(0)}s`))
            : `1 CLOSED CANDLE CONFIRMED BELOW FLOOR: ${lastClosedStr}Price $${refPrice.toFixed(6)} closed below Floor $${lowerBound.toFixed(6)}`;

          const heldNow = this.baseHeld();
          const minNotionalForSplit = Math.max(this.minNotional || 5.0, 5.0);
          const canDoStage1Split =
            !this.cutLossStage1Executed &&
            (this.cfg.enableTwoStageCutLoss !== false) &&
            !isBelowStage2Bound &&
            (heldNow * dexBid >= minNotionalForSplit * 2.1);

          if (canDoStage1Split) {
            const halfQty = roundToStep(heldNow * 0.50, this.stepSize || 0.0001, this.qtyPrecision);
            this.log(
              `🛡️ CUT LOSS STAGE 1/2 (50% DE-RISK | ${triggerReason}): Selling 50% (${halfQty.toFixed(4)} ${this.baseAsset}) @ Bid $${dexBid.toFixed(6)} — holding remaining 50% unless Stage 2 ($${stage2CutBound.toFixed(6)}) breaks`,
            );
            if (this.openOrders.length > 0) {
              await this.cancelAllRestingOrders();
            }
            const stage1Ok = await this.sellTrancheIOC(halfQty, dexBid, "CUT LOSS STAGE 1 (50% DE-RISK)", dexBid, true);
            if (stage1Ok) {
              this.cutLossStage1Executed = true;
              this.cutLossStage1Price = refPrice;
              this.cutLossStage1CandleTime = latestClosedCandle?.time ?? 0;
              this.lastCutLossTime = Date.now();
              this.iocBracketSellCycle = undefined;
              this.saveState();
              return;
            }
          }

          if (this.cutLossStage1Executed && !isBelowStage2Bound && !isStage2CandleClosed) {
            this.status(
              `🛡️ STAGE 1 DE-RISKED (50% HELD): Price $${refPrice.toFixed(6)} above Stage 2 Cut Bound ($${stage2CutBound.toFixed(6)}) — holding remaining 50% for potential wick recovery`,
            );
          } else {
            const stageLabel = this.cutLossStage1Executed ? "STAGE 2/2 FULL EXIT | " : "";
            this.log(
              `🚨 CUT LOSS TRIGGERED (${stageLabel}${triggerReason}): DEX Bid $${dexBid.toFixed(6)} — ${exitActionDesc}`,
            );
            if (this.openOrders.length > 0) {
              await this.cancelAllRestingOrders();
            }
            await this.sellAll(dexBid, "CUT");
            this.lastCutLossTime = Date.now();
            this.waitingForHigherLow = true;
            this.isFlatChannelShiftWaiting = false;
            this.lastResolvedDumpLowPrice = undefined;
            this.breakdownFloorPrice = lowerBound;
            this.breakdownLowPrice = dexBid;
            this.breakdownTime = Math.floor(Date.now() / 1000);
            this.breakdownBuyLevel2Price = isChannelReady && buyLevels.length > 1 && buyLevels[1] > 0.0001
              ? buyLevels[1]
              : (lowerBound > 0 ? lowerBound + span * 0.32 : dexBid * 1.01);
            this.bufferBreakStartTime = undefined;
            this.cutLossStage1Executed = false;
            this.cutLossStage1Price = undefined;
            this.cutLossStage1CandleTime = undefined;
            this.postCutSingleTrancheOnly = true;
            this.iocBracketSellCycle = undefined;
            this.stuckSince = undefined;
            this.breakdownCandleTimes.clear();
            this.saveState();
            return;
          }
        }
      } else if (!this.isPaused && isInitialBreakdown) {
        // Price fell below floor while holding 0 lots: cancel any open resting buy orders to prevent buying a falling knife
        await this.cancelAllRestingOrders("BUY");
        this.saveState();
      }
    } else {
      // If price is back above floor, reset confirmation counters, buffer timer, and Stage 1 cut loss state
      this.bufferBreakStartTime = undefined;
      if (this.cutLossStage1Executed) {
        this.log(
          `🟢 CUT LOSS STAGE 1 RECOVERED: Price ($${refPrice.toFixed(6)}) reclaimed Channel Floor ($${lowerBound.toFixed(6)}) — keeping remaining 50% inventory to sell on bounce!`,
        );
        this.cutLossStage1Executed = false;
        this.cutLossStage1Price = undefined;
        this.cutLossStage1CandleTime = undefined;
        this.needsSellRebalance = true;
        this.saveState();
      }
      if (!this.waitingForHigherLow && this.breakdownCandleTimes.size > 0) {
        this.breakdownCandleTimes.clear();
      }
    }

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
    const minNetProfitTargetPrice = avgEntryPrice > 0 ? avgEntryPrice * this.getMinProfitMultiplier() : 0;
    const candidateLhEscape = Math.min(
      latestLhPrice !== undefined && latestLhPrice > 0 ? latestLhPrice : Infinity,
      liveCalculatedCeil !== undefined && liveCalculatedCeil > 0 ? liveCalculatedCeil : Infinity,
    );
    const lhDynamicEscapePrice = (
      (this.cfg.enableLhDynamicEscape !== false) &&
      Number.isFinite(candidateLhEscape) &&
      candidateLhEscape < firstActiveSellTarget &&
      candidateLhEscape >= minNetProfitTargetPrice
    ) ? candidateLhEscape : undefined;

    const liveRealCeil = lhDynamicEscapePrice !== undefined && liveCalculatedCeil !== undefined
      ? Math.min(liveCalculatedCeil, lhDynamicEscapePrice)
      : (lhDynamicEscapePrice ?? liveCalculatedCeil);

    const isLiveRealCeilReached = liveRealCeil !== undefined && liveRealCeil > 0 && (
      refPrice >= liveRealCeil ||
      (bestBid !== undefined && bestBid >= liveRealCeil)
    );
    const isLhEscapeReached = lhDynamicEscapePrice !== undefined && (
      refPrice >= lhDynamicEscapePrice ||
      (bestBid !== undefined && bestBid >= lhDynamicEscapePrice)
    ) && tpExecBid >= minNetProfitTargetPrice;

    const isIocMode = this.cfg.orderExecutionMode === "IOC_BRACKET";
    const reachedTargetPrice = isIocMode
      ? Math.min(
          upperBound,
          liveRealCeil && isLiveRealCeilReached ? liveRealCeil : upperBound,
          highestActiveSellTarget,
        )
      : Math.min(
          upperBound,
          liveRealCeil && isLiveRealCeilReached ? liveRealCeil : upperBound,
        );
    const isBidAtTarget = tpExecBid >= reachedTargetPrice * (isLhEscapeReached ? (1 - (this.cfg.iocSlippagePct ?? 0.2) / 100) : 1.0);

    // In MAKER_LIMIT mode: Grid sell targets (Sell Targets 1..5) are strictly handled by resting MAKER limit orders!
    // Never hijack intra-channel grid sell targets with IOC sellAll in Maker mode.
    // Full Take Profit via sellAll is ONLY for reaching true Upper Bound / Ceiling, LH Escape, or when running in IOC_BRACKET mode.
    const hasOpenRestingSells = !isIocMode && this.openOrders.some((o) => !o.isBid);
    const realCeilingReached =
      (!hasOpenRestingSells && (isAboveCeiling || refPrice >= upperBound || (bestBid !== undefined && bestBid >= upperBound))) ||
      (isIocMode && tpExecBid >= highestActiveSellTarget && refPrice >= highestActiveSellTarget) ||
      (isLiveRealCeilReached && isProfitableExit) ||
      (isLhEscapeReached && isProfitableExit);

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
        this.lockedChannel = undefined;
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

    // Active Buy Trigger in Buy Zone
    let buyTrigger: number;
    const enabledBuyLvlPrices = buyLevels.filter((_, idx) => enabledBuys[idx]);
    const effectivePriceForBuyTrigger = (!isCexExchange && currentBestAsk > 0) ? Math.min(refPrice, currentBestAsk) : refPrice;
    if (enabledBuyLvlPrices.length === 0) {
      buyTrigger = 0;
    } else if (inventoryQuote < targetInventoryQuote - 1.0) {
      const activeZoneCeiling = enabledBuyLvlPrices.find((lvl) => lvl >= effectivePriceForBuyTrigger * 0.9995) ?? enabledBuyLvlPrices[0] ?? (lowerBound + span * ((buyPcts[0] ?? 42) / 100));
      buyTrigger = activeZoneCeiling;
    } else {
      const nextBuyLevel = enabledBuyLvlPrices.find((lvl) => lvl < effectivePriceForBuyTrigger * 0.999);
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
    const uptrendLine = dow?.uptrendLine;
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
      const isFlatWait = this.isFlatChannelShiftWaiting;
      if (this.cfg.trendlineFilter && downtrendLine && !downtrendLine.isBroken) {
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
      } else if (isTlSellTrigger && this.baseHeld() > 0 && openBuys.length === 0) {
        const tlSlipPct = (this.cfg.iocSlippagePct ?? 0.2);
        botActionState = {
          code: "WAITING_TRENDLINE_EXIT",
          title: "📉 Waiting TL Sell Exit",
          reason: `Sells paused below TL ($${sellTrigger.toFixed(this.pricePrecision)}) • Holding $${inventoryQuote.toFixed(1)}`,
          nextTrigger: `IOC Sell when price touches TL ($${sellTrigger.toFixed(this.pricePrecision)} • slip ${tlSlipPct.toFixed(2)}%)`,
          severity: "info",
        };
      } else if (openBuys.length > 0) {
        botActionState = {
          code: "MAKER_BUY_RESTING",
          title: `📋 ${openBuys.length} Buys Resting`,
          reason: openBuys.map((o) => `$${o.price.toFixed(this.pricePrecision)}`).join(", "),
          nextTrigger: `Fills on flash dip <$${buyTrigger.toFixed(this.pricePrecision)} • Sell: >$${sellTrigger.toFixed(this.pricePrecision)}`,
          severity: "success",
        };
      } else {
        botActionState = {
          code: "BUY_ZONE_TARGET_MET",
          title: "🎯 Level Target Met",
          reason: `Holding $${inventoryQuote.toFixed(1)} (Target $${targetInventoryQuote.toFixed(0)} for ${activeLevelName})`,
          nextTrigger: `Buy next dip: <$${buyTrigger.toFixed(this.pricePrecision)} • Sell: >$${sellTrigger.toFixed(this.pricePrecision)}`,
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
          reason: openSells.map((o) => `$${o.price.toFixed(this.pricePrecision)}`).join(", "),
          nextTrigger: openSells.length === 1
            ? `Resting Limit Sell placed @ $${openSells[0].price.toFixed(this.pricePrecision)}`
            : `${openSells.length} Resting Limit Sells placed`,
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
        const isBidWithinSlippage = effectiveBestBid !== undefined && effectiveBestBid >= minAllowedResPrice;
        const isProfitableAtBid = avgEntry <= 0 || (effectiveBestBid !== undefined && effectiveBestBid >= avgEntry * this.getMinProfitMultiplier());
        const isPriceAtResistance = refPrice >= minAllowedResPrice || (effectiveBestBid !== undefined && effectiveBestBid >= minAllowedResPrice);

        if (isPriceAtResistance) {
          if (effectiveBestBid !== undefined && !isBidWithinSlippage) {
            // Bid is below slippage floor -> hold off to avoid selling below target
            if (Date.now() - (this.orderCooldowns.get("res_ioc_bid_warn") ?? 0) > 30_000) {
              this.orderCooldowns.set("res_ioc_bid_warn", Date.now());
              this.log(
                `⏳ [RES IOC STANDBY] Price $${refPrice.toFixed(6)} reached ${resDisplayName} ($${effectiveResPrice.toFixed(6)}, slip ${(sellSlippage * 100).toFixed(2)}%: $${minAllowedResPrice.toFixed(6)}) but Best Bid $${effectiveBestBid.toFixed(6)} is below slippage floor — waiting for bid to reach level`,
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
          } else if (effectiveBestBid !== undefined && isBidWithinSlippage && isProfitableAtBid) {
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
        liveRealCeil,
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
        this.saveState();
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
    targetPrice?: number;
    slippagePct?: number;
    limitPrice?: number;
  }): void {
    const { price, qty, levelDesc, orderId, txHash, logPrefix = "", dryRun, isIoc = false, targetPrice, slippagePct, limitPrice } = opts;
    const fillNotional = price * qty;
    const now = Date.now();

    // ── Strict CEX vs DEX Fee & Gas Accounting Decoupling ────────────────────
    const isDex = this.binance.hasGasFees || this.binance.isDex || this.binance.exchangeName === "dreamdex";
    const isSomiBase = isDex && this.baseAsset.toUpperCase() === "SOMI";

    let spotTradingFeeBase = 0;
    let compBase = 0;
    let gasLossQuote = 0;
    let feeLog = "";

    if (!isDex) {
      // 🟡 1. CEX (Binance Spot):
      // - No on-chain gas, no blockchain tx fees.
      // - Standard spot trading fee (0.075% with BNB or 0.1% without, 0% for FDUSD maker).
      // - Strictly 0 gas compensation.
      const isZeroFeeMaker = (this.quoteAsset.toUpperCase() === "FDUSD" && !isIoc);
      const spotFeeRate = (isZeroFeeMaker || this.cfg.dryRun) ? 0.0 : 0.00075;
      spotTradingFeeBase = qty * spotFeeRate;
      feeLog = spotTradingFeeBase > 0
        ? ` | 🏷️ CEX Spot Fee: ${spotTradingFeeBase.toFixed(6)} ${this.baseAsset}`
        : isZeroFeeMaker
        ? " | 🎁 0% Maker Fee"
        : "";
    } else {
      // 🟣 2. DEX (DreamDEX On-Chain):
      // - SpotPool trading fees are settled on-chain.
      // - All transactions cost native EVM gas (SOMI).
      // - Gas Compensation: when trading SOMI as base asset, compensate accumulated gas by withholding from buy lot back to wallet gas reserve.
      const uncompensatedGas = isSomiBase
        ? Math.max(this.accumulatedGasBase, this.totalGasSpentBase - this.totalGasDeductedBase)
        : 0;

      if (uncompensatedGas > 0) {
        // Can compensate up to 50% of the buy quantity per fill to keep position sizing healthy
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
    }

    const rawNetQty = Math.max(0, qty - compBase - spotTradingFeeBase);
    // Align lot qty with exchange stepSize and precision (4 decimals for ETH/SOMI)
    const netQty = roundToStep(rawNetQty, this.stepSize || 0.0001, 4);
    this.lots.push({ price, qty: netQty, time: now });
    this.needsSellRebalance = true;
    this.needsBuyRebalance = true;
    // Reset IOC Bracket Sell Cycle whenever a buy order fills to re-partition lots with new baseline
    this.iocBracketSellCycle = undefined;
    if (this.soldSellIndices.size > 0) {
      this.log(`🔄 [Sell Cycle] New BUY fill received — resetting sold sell targets to re-enable full ladder`);
      this.soldSellIndices.clear();
    }

    const gasCompLog = compBase > 0
      ? ` | ⛽ Gas Compensated: ${compBase.toFixed(4)} ${this.baseAsset} (-$${gasLossQuote.toFixed(4)}) returned to wallet gas reserve`
      : "";
    const fillLabel = isIoc ? "IOC BUY FILLED" : "MAKER BUY FILLED";
    const iocLog = (isIoc && (targetPrice !== undefined || limitPrice !== undefined))
      ? ` [Target: $${(targetPrice ?? price).toFixed(6)} | Slip: ${(slippagePct ?? 0.2).toFixed(2)}% | Limit: $${(limitPrice ?? price).toFixed(6)}]`
      : "";
    this.log(
      `⚡ ${logPrefix}${fillLabel}: ${qty.toFixed(4)} ${this.baseAsset} ($${fillNotional.toFixed(2)} ${this.quoteAsset}) @ $${price.toFixed(6)} • ${levelDesc}${iocLog}${orderId ? ` #${orderId}` : ""}${feeLog}${gasCompLog}`,
    );
    this.emit({
      type: "order",
      data: {
        action: "BUY_FILL",
        status: "FILLED",
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
        isIoc,
        targetPrice,
        slippagePct,
        limitPrice,
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

    // Track which sell target was sold in this inventory wave
    const soldIdx = this.findSellLevelIndex(levelDesc, price);
    if (soldIdx >= 0) {
      this.soldSellIndices.add(soldIdx);
      this.log(`🎯 [Sell Cycle] Marked Sell Target ${soldIdx + 1} as SOLD for current inventory wave (sold: [${Array.from(this.soldSellIndices).map((i) => i + 1).join(", ")}])`);
      this.saveState();
    }

    this.log(
      `🔥 ${logPrefix}MAKER SELL FILLED: ${qty.toFixed(4)} ${this.baseAsset} ($${fillNotional.toFixed(2)} ${this.quoteAsset}) @ $${price.toFixed(6)} • ${levelDesc}${orderId ? ` #${orderId}` : ""} (Trade PnL: ${roundPnl >= 0 ? "+$" : "-$"}${Math.abs(roundPnl).toFixed(4)} | Net Total: ${this.realizedPnl >= 0 ? "+$" : "-$"}${Math.abs(this.realizedPnl).toFixed(4)})`,
    );
    this.emit({
      type: "order",
      data: {
        action: "SELL_FILL",
        status: "FILLED",
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
    liveRealCeil?: number,
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
          : this.isDowntrendDropPaused
          ? "Active Downtrend Drop (LH+LL) — waiting for HL or Trendline Breakout"
          : "Buying paused by filters (Downtrend/Trendline/Lag Guard/Offload)";
        await this.cancelAllRestingOrders("BUY", pauseReason);
      }
    } else {
      const isSingleBuyLevel = buyLevels.length === 1;
      const buyBufPct = this.cfg.narrowChannelBuyBufferPct ?? 0.05;
      const buyPcts = this.cfg.buyLevelPcts ?? [42, 32, 22, 12, 2];
      const levelNames = isSingleBuyLevel
        ? [`Buy Edge Floor (+${buyBufPct.toFixed(2)}%)`]
        : buyLevels.map((_, idx) => `Buy Level ${idx + 1} (${buyPcts[idx] ?? Math.round(42 - idx * 10)}%)`);

      const enabledBuys = Array.isArray(this.cfg.enabledBuyLevels) ? this.cfg.enabledBuyLevels : [true, true, true, true, true];
      const highestEnabledBuyPrice = buyLevels.find((_, idx) => enabledBuys[idx]) ?? (buyLevels[0] ?? 0);
      const sellLevel1Limit = sellLevels[0] ?? upperBound;

      // Check if Uptrend Support Line is active and sits above standard enabled buy targets ("ถ้าเลย buy target")
      const isTlAboveBuyTarget = Boolean(
        (this.cfg.enableBuyAboveTrendSupport !== false) &&
        activeUptrendLine &&
        !activeUptrendLine.isBroken &&
        refPrice >= activeUptrendLine.currentLinePrice * 0.995 &&
        activeUptrendLine.currentLinePrice > highestEnabledBuyPrice &&
        activeUptrendLine.currentLinePrice < sellLevel1Limit
      );

      const effectiveBuyLevels = [...buyLevels];
      const effectiveLevelNames = [...levelNames];

      if (isTlAboveBuyTarget && activeUptrendLine) {
        // If trendline sits above standard buy targets, float top buy level to trendline support price
        effectiveBuyLevels[0] = activeUptrendLine.currentLinePrice;
        effectiveLevelNames[0] = `Buy TL Support ($${activeUptrendLine.currentLinePrice.toFixed(4)})`;
      }

      const maxAllowedBuyPrice = Math.min(currentBestBid, refPrice);

      // Count total active buy levels considering enabledBuys and potential trendline support at idx 0
      const activeBuyCount = effectiveBuyLevels.reduce((cnt, _, idx) => {
        const isEnabled = (idx === 0 && isTlAboveBuyTarget) ? enabledBuys.some(Boolean) : (enabledBuys[idx] !== false);
        return isEnabled ? cnt + 1 : cnt;
      }, 0) || (buyLevels.length || 5);

      const buyWeightFractions = this.getBuyLevelWeightFractions(enabledBuys, effectiveBuyLevels.length, isTlAboveBuyTarget);
      const buyTargets = effectiveBuyLevels.map((_, idx) =>
        this.getCumulativeBuyTargetFraction(idx, enabledBuys, effectiveBuyLevels.length, isTlAboveBuyTarget)
      );

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

      // Rebalance Buy side: track available capacity across all buy levels
      const openBuys = this.openOrders.filter((o) => o.isBid);
      const currentAvailableCapacity = Math.max(0, maxInv - currentHeldQuote);
      const currentHoldFraction = maxInv > 0 ? (currentHeldQuote / maxInv) : 0;
      const minOrderNotional = Math.max(this.minNotional || 5.0, 5.0);

      // Determine which buy levels are actually eligible for placing/holding orders
      // (not disabled by user unless overridden by active Uptrend Support at idx 0, not suppressed by Holding Fraction Guard, Trendline filter, or above current bid)
      const eligibleBuyIndices = effectiveBuyLevels
        .map((lvl, idx) => ({ lvl, idx }))
        .filter(({ lvl, idx }) => {
          if (!lvl) return false;
          // Check if disabled by user (allow idx === 0 if it is the active Uptrend Support Line entry)
          const isLevelEnabled = (idx === 0 && isTlAboveBuyTarget) ? enabledBuys.some(Boolean) : (enabledBuys[idx] !== false);
          if (!isLevelEnabled) return false;
          // Open Lot Proximity Guard: If we already hold an open lot bought near this price level, do NOT re-buy it!
          // Note: dynamic tolerance ensures adjacent grid levels do not falsely suppress each other in narrow channels
          // Allows re-buying if prior lot was mostly liquidated (< 40% residue)
          const levelWeightFrac = buyWeightFractions[idx] ?? (activeBuyCount > 0 ? (1 / activeBuyCount) : 0.2);
          const expectedTrancheQuote = isSingleBuyLevel ? maxInv : (maxInv * levelWeightFrac);
          const expectedTrancheQty = lvl > 0 ? (expectedTrancheQuote / lvl) : 0;
          if (this.hasLotNearLevel(lvl, idx, effectiveBuyLevels, expectedTrancheQty)) {
            return false;
          }

          // Total Capacity Guard: If portfolio is full (>= 95% of maxInventoryQuote), do not place any more buy orders
          if (currentHoldFraction >= 0.95) {
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

      const numBuyLevels = effectiveBuyLevels.length || 5;
      const numEligibleBuyLevels = eligibleBuyIndices.length > 0 ? eligibleBuyIndices.length : numBuyLevels;
      // Fixed portfolio proportion tranche sizing: Each level represents maxInv / activeBuyCount
      const baseTrancheQuote = isSingleBuyLevel ? maxInv : (activeBuyCount > 0 ? (maxInv / activeBuyCount) : 0);
      let rawTrancheQuote = baseTrancheQuote;
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
          const sellL1Pct = this.cfg.sellLevelPcts?.[0] ?? 52;
          const reason = !this.buyOrdersActive
            ? `Price above Sell Level 1 (> ${sellL1Pct}%) — cancelling buy orders to avoid churn in profit zone`
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

        // If open buys exceed the number of active buy levels, only trim orders that are unmapped or excess duplicates
        const activeLevelNamesSet = new Set(effectiveLevelNames.slice(0, numBuyLevels));
        const unmappedBuys = openBuys.filter((o) => !o.levelDesc || !activeLevelNamesSet.has(o.levelDesc));
        if (unmappedBuys.length > 0) {
          for (const o of unmappedBuys) {
            await this.cancelOrderInternal(o, "Excess buy orders beyond grid levels — removing unmapped");
          }
          this.openOrders = this.openOrders.filter((o) => !unmappedBuys.includes(o));
          this.saveState();
        } else {
          // Detect duplicates per level: if multiple orders share the same levelDesc, keep the one closest to lvlPrice and trim the rest
          const duplicatesToTrim: OpenOrder[] = [];
          for (let i = 0; i < effectiveBuyLevels.length; i++) {
            const lvlName = effectiveLevelNames[i];
            const lvlPrice = effectiveBuyLevels[i];
            if (!lvlName || !lvlPrice) continue;
            const ordersAtLevel = openBuys.filter((o) => o.levelDesc === lvlName);
            if (ordersAtLevel.length > 1) {
              // Sort by price diff to lvlPrice ascending (keep closest, trim the others)
              ordersAtLevel.sort((a, b) => Math.abs(a.price - lvlPrice) - Math.abs(b.price - lvlPrice));
              const extras = ordersAtLevel.slice(1);
              duplicatesToTrim.push(...extras);
            }
          }

          if (duplicatesToTrim.length > 0) {
            for (const o of duplicatesToTrim) {
              await this.cancelOrderInternal(o, `Duplicate buy order at ${o.levelDesc} — keeping closest to grid price`);
            }
            this.openOrders = this.openOrders.filter((o) => !duplicatesToTrim.includes(o));
            this.saveState();
          } else if (openBuys.length > numBuyLevels) {
            // As a safe fallback if no duplicate levelDesc is found, trim only orders that do not match ANY active level price
            const excessBuys = openBuys.filter((o) => !effectiveBuyLevels.some((lvl) => Math.abs(o.price - lvl) / lvl <= 0.0015));
            for (const o of excessBuys) {
              await this.cancelOrderInternal(o, "Excess buy orders beyond grid levels — removing non-matching");
            }
            if (excessBuys.length > 0) {
              this.openOrders = this.openOrders.filter((o) => !excessBuys.includes(o));
              this.saveState();
            }
          }
        }

        // ── Ineligible Level Cancel Guard (Strict Budget & Level Allocation) ──
        // Cancel resting buy orders on levels that are NO LONGER in eligibleBuyIndices
        // (e.g. portfolio holding already exceeded level target fraction, or trendline filter active)
        const ineligibleOpenBuys = openBuys.filter((o) => {
          const lvlIdx = effectiveLevelNames.indexOf(o.levelDesc || "");
          return lvlIdx >= 0 && !eligibleBuyIndices.includes(lvlIdx);
        });
        if (ineligibleOpenBuys.length > 0) {
          for (const o of ineligibleOpenBuys) {
            const ordNotional = (o.notionalQuote !== undefined ? o.notionalQuote : o.notionalUsdso) || (o.price * o.qty);
            await this.cancelOrderInternal(
              o,
              `Level allocation target fulfilled (${o.levelDesc}) — releasing locked budget ($${ordNotional.toFixed(2)}) for remaining eligible levels`,
            );
          }
          this.openOrders = this.openOrders.filter((o) => !ineligibleOpenBuys.includes(o));
          this.saveState();
        }

        for (let i = 0; i < effectiveBuyLevels.length; i++) {
          const lvlPrice = effectiveBuyLevels[i];
          if (!lvlPrice) continue;

          // If this buy level is disabled by user (and not overridden by active Uptrend Support at i === 0), cancel any existing order and skip
          const isLevelEnabled = (i === 0 && isTlAboveBuyTarget) ? enabledBuys.some(Boolean) : (enabledBuys[i] !== false);
          if (!isLevelEnabled) {
            const existingDisabledBuy = this.openOrders.find(
              (o) => o.isBid && (o.levelDesc === effectiveLevelNames[i] || (!o.levelDesc && Math.abs(o.price - lvlPrice) / lvlPrice <= 0.001)),
            );
            if (existingDisabledBuy) {
              await this.cancelOrderInternal(
                existingDisabledBuy,
                `User disabled Buy Level ${i + 1} — cancelling resting order`,
              );
              this.openOrders = this.openOrders.filter((o) => o !== existingDisabledBuy);
              this.saveState();
            }
            continue;
          }

          // If this level is not in eligibleBuyIndices (e.g. holding fraction exceeded level quota), cancel existing order and skip
          if (!eligibleBuyIndices.includes(i)) {
            const currentIneligibleBuy = this.openOrders.find(
              (o) => o.isBid && (o.levelDesc === effectiveLevelNames[i] || (!o.levelDesc && Math.abs(o.price - lvlPrice) / lvlPrice <= 0.001)),
            );
            if (currentIneligibleBuy) {
              await this.cancelOrderInternal(
                currentIneligibleBuy,
                `Buy level ${i + 1} quota already fulfilled by current holding (${(currentHoldFraction * 100).toFixed(1)}%) — cancelling`,
              );
              this.openOrders = this.openOrders.filter((o) => o !== currentIneligibleBuy);
              this.saveState();
            }
            continue;
          }

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

          // Calculate remaining capacity for this specific order, accounting for all OTHER open buy orders
          const otherOpenBuysQuote = this.openOrders
            .filter((o) => o.isBid && o !== currentOpenBuyAtLvl)
            .reduce((sum, o) => sum + ((o.notionalQuote !== undefined ? o.notionalQuote : o.notionalUsdso) || (o.price * o.qty)), 0);
          const remainingCapacityForOrder = Math.max(0, currentAvailableCapacity - otherOpenBuysQuote);
          const levelWeightFrac = buyWeightFractions[i] ?? (activeBuyCount > 0 ? (1 / activeBuyCount) : 0.2);
          let levelTrancheQuote = isSingleBuyLevel ? maxInv : (maxInv * levelWeightFrac);
          if (levelTrancheQuote < minOrderNotional && currentAvailableCapacity >= minOrderNotional) {
            levelTrancheQuote = Math.min(currentAvailableCapacity, minOrderNotional);
          }
          const targetOrderQuote = Math.min(levelTrancheQuote, remainingCapacityForOrder);

          if (currentOpenBuyAtLvl) {
            // Preserve resting buy order! Only re-align price if channel shifted significantly OR if rebalancing to equal tranche
            const priceDiffRatio = Math.abs(currentOpenBuyAtLvl.price - lvlPrice) / lvlPrice;
            const priceTolerance = priceTol;
            const currentOrderNotional = currentOpenBuyAtLvl.notionalQuote !== undefined ? currentOpenBuyAtLvl.notionalQuote : currentOpenBuyAtLvl.notionalUsdso;
            const totalOpenBuysQuote = otherOpenBuysQuote + currentOrderNotional;
            const isTotalExposureExceeded = totalOpenBuysQuote > currentAvailableCapacity * 1.05;

            // Maximum budget physically possible with available wallet balance
            const maxPossibleBudget = this.cfg.dryRun
              ? targetOrderQuote
              : Math.min(targetOrderQuote, Math.max(0, this.walletQuoteBalance) + currentOrderNotional);

            const effectiveDiff = Math.abs(currentOrderNotional - maxPossibleBudget);
            const effectiveDiffRatio = effectiveDiff / Math.max(0.01, maxPossibleBudget);
            const canResize = effectiveDiff >= Math.max(minOrderNotional * 0.5, 2.0);

            // Rebalance tranche ONLY if:
            // 1. Total buy exposure exceeded remaining capacity (risk management)
            // 2. Explicit rebalance requested after fills/startup (doBuyRebalance) AND order differs from achievable budget
            // 3. Significant deviation from achievable budget AND sufficient wallet/capacity delta to resize without churning
            const needsResize = (
              isTotalExposureExceeded ||
              (doBuyRebalance && effectiveDiffRatio > 0.05 && canResize) ||
              (effectiveDiffRatio > 0.15 && canResize)
            ) && effectiveDiffRatio > 0.05;

            if (priceDiffRatio > priceTolerance || needsResize) {
              const reason = priceDiffRatio > priceTolerance
                ? `Channel shifted: aligning buy price ($${currentOpenBuyAtLvl.price.toFixed(6)} -> $${lvlPrice.toFixed(6)})`
                : isTotalExposureExceeded
                ? `Total buy exposure exceeded remaining capacity: adjusting order ($${currentOrderNotional.toFixed(2)} -> $${maxPossibleBudget.toFixed(2)})`
                : `Rebalancing buy quantity to match grid tranche ($${currentOrderNotional.toFixed(2)} -> $${maxPossibleBudget.toFixed(2)})`;
              await this.cancelOrderInternal(currentOpenBuyAtLvl, reason);
              this.openOrders = this.openOrders.filter((o) => o !== currentOpenBuyAtLvl);

              const effectiveBuyQty = maxPossibleBudget / lvlPrice;
              if (effectiveBuyQty >= this.minQty && maxPossibleBudget >= minOrderNotional) {
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
          // Total Capacity Guard: If portfolio is full (>= 95% of maxInventoryQuote), do not place any more buy orders
          if (currentHoldFraction >= 0.95) {
            continue;
          }
          // Open Lot Proximity Guard: skip if a full lot near this price is already held
          const expectedTrancheQty = lvlPrice > 0 ? (targetOrderQuote / lvlPrice) : 0;
          if (this.hasLotNearLevel(lvlPrice, i, effectiveBuyLevels, expectedTrancheQty)) {
            continue;
          }

          // On DreamDEX: ถ้า currentBestAsk <= lvlPrice มีสภาพคล่องฝั่ง Ask ที่ราคาเท่ากับหรือถูกกว่า Buy Level
          // สามารถเข้าซื้อ (IOC Fill) คว้าสภาพคล่องไม้ Buy Level นั้นได้ทันที ไม่ต้องรอราคาแท่งเทียน
          const isDexAskAtOrBelowLevel = !isCexExchange && currentBestAsk > 0 && currentBestAsk <= lvlPrice;
          if (isDexAskAtOrBelowLevel && canBuy && targetOrderQuote > 0) {
            const availableBudget = this.cfg.dryRun
              ? targetOrderQuote
              : Math.min(targetOrderQuote, this.walletQuoteBalance);
            const desiredBuyQty = availableBudget / currentBestAsk;
            if (desiredBuyQty >= this.minQty && availableBudget >= minOrderNotional) {
              const actionLabel = effectiveLevelNames[i] || `Buy Level ${i + 1}`;
              this.log(
                `⚡ [DREAMDEX ASK MATCH] Ask $${currentBestAsk.toFixed(6)} <= ${actionLabel} ($${lvlPrice.toFixed(6)}) — executing immediate IOC fill for $${availableBudget.toFixed(2)} ${this.quoteAsset}`,
              );
              await this.buyTrancheIOC(desiredBuyQty, currentBestAsk, actionLabel, lvlPrice, availableBudget);
              continue;
            }
          }

          const isEligibleForNewOrder = lvlPrice < maxAllowedBuyPrice && canBuy;
          if (isEligibleForNewOrder && targetOrderQuote > 0) {
            // Place new equal tranche buy order (strictly capped by remainingCapacityForOrder and available wallet balance)
            const availableBudget = this.cfg.dryRun
              ? targetOrderQuote
              : Math.min(targetOrderQuote, this.walletQuoteBalance);
            const desiredBuyQty = availableBudget / lvlPrice;
            if (desiredBuyQty >= this.minQty && availableBudget >= minOrderNotional) {
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
      // Sell orders are paused/deactivated while below Buy Level 1
      const buyL1Pct = this.cfg.buyLevelPcts?.[0] ?? 42;
      const openSells = this.openOrders.filter((o) => !o.isBid);
      if (openSells.length > 0) {
        await this.cancelAllRestingOrders("SELL", `Price below Buy Level 1 (< ${buyL1Pct}%) — cancelling sell orders to avoid churn while accumulating`);
      }
    } else {
      const isSingleSellLevel = sellLevels.length === 1;
      const sellBufPct = this.cfg.narrowChannelSellBufferPct ?? 0.05;
      const sellPcts = this.cfg.sellLevelPcts ?? [52, 62, 72, 82, 92];
      const sellNames = isSingleSellLevel
        ? [`Sell Edge Ceil (-${sellBufPct.toFixed(2)}%)`]
        : sellLevels.map((_, idx) => `Sell Target ${idx + 1} (${sellPcts[idx] ?? Math.round(52 + idx * 10)}%)`);

      const enabledSells = Array.isArray(this.cfg.enabledSellTargets) ? this.cfg.enabledSellTargets : [true, true, true, true, true];
      const activeSellCount = enabledSells.filter(Boolean).length;
      if (activeSellCount === 0) {
        // All sell targets disabled: cancel resting sell orders
        const openSells = this.openOrders.filter((o) => !o.isBid && o.levelDesc && sellNames.includes(o.levelDesc));
        if (openSells.length > 0) {
          for (const o of openSells) {
            await this.cancelOrderInternal(o, "All sell targets disabled by configuration");
          }
          this.openOrders = this.openOrders.filter((o) => !openSells.includes(o));
          this.saveState();
        }
        return;
      }

      // Cancel resting sell orders for disabled sell targets
      const disabledSellOrders = this.openOrders.filter((o) => {
        if (o.isBid || !o.levelDesc) return false;
        const idx = sellNames.indexOf(o.levelDesc);
        return idx >= 0 && !enabledSells[idx];
      });
      if (disabledSellOrders.length > 0) {
        for (const o of disabledSellOrders) {
          await this.cancelOrderInternal(o, `Sell target disabled by configuration: ${o.levelDesc}`);
        }
        this.openOrders = this.openOrders.filter((o) => !disabledSellOrders.includes(o));
        this.saveState();
      }

      // ── Resistance Sell Override (Downtrend Trendline & Real Frame S/R Ceil) ──
      // When an active descending trendline OR real frame ceiling is lower than locked ceiling:
      // Choose the LOWER price between Trendline and Real S/R Ceil: min(TL, Real Ceil)
      const isIocMode = this.cfg.orderExecutionMode === "IOC_BRACKET";
      const isTlActive = (this.cfg.enableSellBelowTrendResistance !== false) && Boolean(activeDowntrendLine && !activeDowntrendLine.isBroken);
      const isRealCeilActive = (this.cfg.enableSellAtRealCeiling !== false) && liveRealCeil !== undefined && liveRealCeil > 0;
      const hasResistanceOverride = isTlActive || (isRealCeilActive && liveRealCeil < upperBound);

      if (hasResistanceOverride) {
        const tlPrice = (isTlActive && activeDowntrendLine) ? activeDowntrendLine.currentLinePrice : Infinity;
        const rcPrice = (isRealCeilActive && liveRealCeil) ? liveRealCeil : Infinity;
        const effectiveResistancePrice = Math.min(tlPrice, rcPrice);
        const isUsingRealCeil = isRealCeilActive && liveRealCeil !== undefined && effectiveResistancePrice === liveRealCeil;
        const resSellName = isUsingRealCeil ? "Sell Real Ceil Exit" : "Sell TL Exit (Trendline)";
        const resDisplayName = isUsingRealCeil ? "Real S/R Ceil" : "Trendline";

        // All standard sell names that should be cancelled when resistance override is active
        const allSellNames = [...sellNames, "Sell TL Exit (Trendline)", "Sell Real Ceil Exit"];

        // Determine which standard sell levels are below the effective resistance
        const levelsUnderTL = sellLevels.filter((lvl, idx) => lvl < effectiveResistancePrice && enabledSells[idx]);

        if (levelsUnderTL.length === 0) {
          if (isIocMode) {
            // In IOC_BRACKET mode: do NOT place resting orders at the resistance.
            // Cancel any leftover resting TL/RC sell orders and standard sell orders, then wait for IOC trigger.
            const leftoverSells = this.openOrders.filter(
              (o) => !o.isBid && o.levelDesc && allSellNames.includes(o.levelDesc),
            );
            if (leftoverSells.length > 0) {
              for (const o of leftoverSells) {
                await this.cancelOrderInternal(o, `IOC mode active: cancelling resting sell at ${resDisplayName} — waiting for IOC trigger`);
              }
              this.openOrders = this.openOrders.filter((o) => !leftoverSells.includes(o));
              this.saveState();
            }
            return;
          }

          // No standard sell target is below resistance (MAKER_LIMIT mode).
          // Place or maintain a resting Maker Limit Sell order at the resistance price for 100% exit.
          // When the resistance price shifts, automatically cancel and replace the order at the new price.
          const tlSellName = resSellName;
          // Match existing TL/RC sell by exact levelDesc OR by proximity to resistance price OR generic Binance order when no grid targets exist
          let existingTlSell = this.openOrders.find((o) => !o.isBid && (
            o.levelDesc === resSellName ||
            o.levelDesc === "Sell TL Exit (Trendline)" ||
            o.levelDesc === "Sell Real Ceil Exit" ||
            (o.levelDesc && o.levelDesc.startsWith("SELL Order #") && o.price >= refPrice * 0.999) ||
            Math.abs(o.price - effectiveResistancePrice) / effectiveResistancePrice <= 0.005
          ));

          if (existingTlSell && existingTlSell.levelDesc !== tlSellName) {
            existingTlSell.levelDesc = tlSellName;
            existingTlSell.targetFraction = 0.0;
            this.log(`🔗 [RES SELL] Re-linked resting SELL order #${existingTlSell.onChainOrderId || existingTlSell.id} @ $${existingTlSell.price.toFixed(6)} to ${tlSellName}`);
          }

          // Cancel any standard grid sell orders that might still be resting
          const staleStandardSells = this.openOrders.filter(
            (o) => !o.isBid && o !== existingTlSell && o.levelDesc && sellNames.includes(o.levelDesc),
          );
          if (staleStandardSells.length > 0) {
            for (const o of staleStandardSells) {
              await this.cancelOrderInternal(o, `${resDisplayName} override: cancelling standard grid sells — switching to ${resDisplayName} sell`);
            }
            this.openOrders = this.openOrders.filter((o) => !staleStandardSells.includes(o));
            this.saveState();
          }

          // Set resting sell price slightly below resistance to ensure front-running and reliable maker fill
          const frontRunRatio = isUsingRealCeil ? 0.0003 : 0.0008; // 0.03% below Real Ceil, 0.08% below slope TL
          const rawTargetSellPrice = effectiveResistancePrice * (1 - frontRunRatio);
          const effectiveTlSellPrice = roundToTick(Math.max(refPrice * 1.0005, rawTargetSellPrice), this.tickSize || 0.0001);

          const mode = this.cfg.sellProfitMode || (this.cfg.requireProfitAboveAvgEntry ? "PORTFOLIO_AVG_PROFIT" : "GRID_CASHFLOW");
          const avgEntry = this.getAvgEntryPrice();
          const isProfitOk = mode !== "PORTFOLIO_AVG_PROFIT" || avgEntry <= 0 || effectiveTlSellPrice >= avgEntry * 1.001;

          // In MAKER_LIMIT mode: Keep resting sell order active on the book right below resistance to fill as a Maker!
          const isBelowSellPrice = refPrice < effectiveTlSellPrice;

          if (isProfitOk && isBelowSellPrice && held >= this.minQty) {
            const minOrderNotional = Math.max(this.minNotional || 5.0, 5.0);
            const targetSellQty = roundToStep(held, this.stepSize || 0.0001, 4);
            const orderNotional = targetSellQty * effectiveTlSellPrice;

            if (targetSellQty >= this.minQty && orderNotional >= minOrderNotional) {
              if (existingTlSell) {
                // If resistance price has drifted beyond tolerance (e.g. >0.1%), update the order to match the new price!
                const tlPriceDiffRatio = Math.abs(existingTlSell.price - effectiveTlSellPrice) / effectiveTlSellPrice;
                const qtyDiffRatio = Math.abs(existingTlSell.qty - targetSellQty) / targetSellQty;

                if (tlPriceDiffRatio > 0.001 || qtyDiffRatio > 0.05) {
                  await this.cancelOrderInternal(
                    existingTlSell,
                    `${resDisplayName} price updated: moving resting sell ($${existingTlSell.price.toFixed(6)} -> $${effectiveTlSellPrice.toFixed(6)})`,
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
                // Place new resting sell order right slightly below the resistance price
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
          }
        } else {
          // Some sell levels are below resistance.
          // IMPORTANT: ALL inventory must be covered by sell orders.
          // The LAST eligible level below resistance is treated as a full-exit level (targetFraction = 0),
          // so the remaining inventory not sold by earlier tranches is fully captured there.
          const tlExitOrders = this.openOrders.filter(
            (o) => !o.isBid && o.levelDesc && (o.levelDesc === "Sell TL Exit (Trendline)" || o.levelDesc === "Sell Real Ceil Exit"),
          );
          if (tlExitOrders.length > 0) {
            for (const o of tlExitOrders) {
              await this.cancelOrderInternal(o, `${resDisplayName} override: valid targets below resistance now exist — reverting to grid levels`);
            }
            this.openOrders = this.openOrders.filter((o) => !tlExitOrders.includes(o));
            this.saveState();
          }

          // Cancel sell orders that sit AT or ABOVE resistance (price >= effectiveResistancePrice)
          const suppressedSells = this.openOrders.filter(
            (o) => !o.isBid && o.levelDesc && sellNames.includes(o.levelDesc) && o.price >= effectiveResistancePrice,
          );
          if (suppressedSells.length > 0) {
            for (const o of suppressedSells) {
              await this.cancelOrderInternal(
                o,
                `${resDisplayName} suppressed: sell @ $${o.price.toFixed(6)} >= ${resDisplayName} $${effectiveResistancePrice.toFixed(6)}`,
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

          // Identify eligible levels (strictly below resistance, unsold in current wave, and strictly above minAllowedSellPrice)
          const eligibleIndices = sellLevels
            .map((lvl, idx) => ({ lvl, idx }))
            .filter(({ lvl, idx }) => {
              if (!enabledSells[idx]) return false;
              if (this.soldSellIndices.has(idx)) return false;
              if (lvl >= effectiveResistancePrice) return false;
              // An existing resting sell order at this level is ALWAYS eligible — NEVER cancel when price reaches it!
              const hasExistingOrder = this.openOrders.some(
                (o) => !o.isBid && (o.levelDesc === sellNames[idx] || (lvl && Math.abs(o.price - lvl) / lvl <= 0.001)),
              );
              if (hasExistingOrder) return true;
              // For placing NEW orders, price must be strictly above minAllowedSellPrice
              return lvl > minAllowedSellPrice;
            })
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

          // Check if any active levels below resistance are missing an open sell order
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
            if (!enabledSells[i]) continue;

            // Skip levels that are at or above resistance
            if (lvlPrice >= effectiveResistancePrice) {
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
              const sellSlippage = (this.cfg.iocSlippagePct ?? 0.2) / 100;
              const isPriceExceeded = (currentBestBid > 0 && currentBestBid >= lvlPrice * (1 - sellSlippage)) || (refPrice >= lvlPrice && currentBestBid >= lvlPrice * (1 - sellSlippage));
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
        : sellLevels.map((_, idx) => {
            if (!enabledSells[idx] || activeSellCount <= 0) return 0.0;
            const rank = enabledSells.slice(0, idx + 1).filter(Boolean).length;
            return Math.max(0.0, 1.0 - (rank / activeSellCount));
          });

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

      // Only place/maintain sell orders at levels strictly ABOVE the current market price AND meeting minNetProfitPct
      const mode = this.cfg.sellProfitMode || (this.cfg.requireProfitAboveAvgEntry ? "PORTFOLIO_AVG_PROFIT" : "GRID_CASHFLOW");
      const avgEntry = this.getAvgEntryPrice();
      const minProfitMulti = this.getMinProfitMultiplier();
      const lowestLotPrice = this.lots.length > 0 ? Math.min(...this.lots.map((l) => l.price)) : 0;
      let minAllowedSellPrice = Math.max(
        currentBestBid,
        refPrice,
        lowestLotPrice > 0 ? lowestLotPrice * minProfitMulti : 0,
      );
      if ((mode === "PORTFOLIO_AVG_PROFIT" || this.cfg.requireProfitAboveAvgEntry) && avgEntry > 0) {
        minAllowedSellPrice = Math.max(minAllowedSellPrice, avgEntry * minProfitMulti);
      }

      // Determine eligible sell levels strictly ABOVE minAllowedSellPrice and not yet sold in this wave
      const eligibleSellIndices = sellLevels
        .map((lvl, idx) => ({ lvl, idx }))
        .filter(({ lvl, idx }) => {
          if (!enabledSells[idx]) return false;
          if (this.soldSellIndices.has(idx)) return false;
          const hasExistingOrder = this.openOrders.some(
            (o) => !o.isBid && (o.levelDesc === sellNames[idx] || (lvl && Math.abs(o.price - lvl) / lvl <= 0.001)),
          );
          if (hasExistingOrder) return true;
          return lvl > minAllowedSellPrice;
        })
        .map(({ idx }) => idx);

      // Fallback: If all enabled targets above price have been marked as sold, but position remains, allow the highest enabled target
      if (eligibleSellIndices.length === 0 && held >= (this.minQty || 0.0001)) {
        for (let i = sellLevels.length - 1; i >= 0; i--) {
          if (enabledSells[i]) {
            eligibleSellIndices.push(i);
            break;
          }
        }
      }

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
      const numActiveLevels = activeSellIndices.length > 0 ? activeSellIndices.length : (sellLevels.length || 5);
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
        if (!enabledSells[i]) continue;

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
          const sellSlippage = (this.cfg.iocSlippagePct ?? 0.2) / 100;
          const isPriceExceeded = (currentBestBid > 0 && currentBestBid >= originalLvlPrice * (1 - sellSlippage)) || (refPrice >= originalLvlPrice && currentBestBid >= originalLvlPrice * (1 - sellSlippage));
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

    // Strictly round order quantity to exchange stepSize and precision
    qty = roundToStep(qty, this.stepSize || 0.0001, this.qtyPrecision);
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
          const hashes = await this.binance.cancelAllOpenOrders(this.symbol);
          if (Array.isArray(hashes)) {
            for (const h of hashes) {
              if (typeof h === "string") {
                this.trackTxGas(h, "Cancel All Sweep");
              }
            }
          }
        } else {
          const live = await this.binance.getOpenOrders(this.symbol);
          for (const o of live) {
            const matches = (side === "BUY" && o.side === "BUY") || (side === "SELL" && o.side === "SELL");
            if (matches) {
              const h = await this.binance.cancelOrder(this.symbol, o.orderId);
              if (typeof h === "string") {
                this.trackTxGas(h, `Cancel ${side} Order Sweep #${o.orderId}`);
              }
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
    const enabledBuys = Array.isArray(this.cfg.enabledBuyLevels) ? this.cfg.enabledBuyLevels : [true, true, true, true, true];
    const enabledSells = Array.isArray(this.cfg.enabledSellTargets) ? this.cfg.enabledSellTargets : [true, true, true, true, true];
    const activeBuyCount = enabledBuys.filter(Boolean).length;
    const buyFractions = this.getBuyLevelWeightFractions(enabledBuys, buyLevels.length);
    const baseTrancheQuote = activeBuyCount > 0 ? (maxInv / activeBuyCount) : 0;
    const baseTrancheUsdso = baseTrancheQuote;

    // ── BUY SIDE (IOC Accumulation with Tranche Aggregation) ──────────────────
    const isCexExchange = this.binance.exchangeName === "binance";
    // Safety Guard: Check that currentBestAsk is sane and not an outlier/phantom order
    const isAskPriceSane = refPrice > 0 && currentBestAsk > 0 && (
      !isCexExchange
        ? (currentBestAsk <= refPrice * 1.05 && currentBestAsk >= refPrice * 0.85)
        : Math.abs(currentBestAsk - refPrice) / refPrice <= 0.05
    );

    if (canBuy && this.buyOrdersActive && currentBestAsk > 0 && isAskPriceSane && activeBuyCount > 0) {
      // Determine which buy band the market price has reached
      let targetTranches = 0;
      let matchedLevelIndex = -1;
      let isTlBuy = false;
      let matchedBuyPrice: number | undefined;

      const tlPrice = (activeUptrendLine && !activeUptrendLine.isBroken) ? activeUptrendLine.currentLinePrice : undefined;
      const highestEnabledBuyPrice = buyLevels.find((_, idx) => enabledBuys[idx]) ?? (buyLevels[0] ?? 0);
      const sellLevel1Limit = sellLevels[0] ?? upperBound;

      // 1. Trendline Support Entry ("ถ้าเลย buy target สามารถเข้าซื้อได้ที่เส้น trend")
      if (
        (this.cfg.enableBuyAboveTrendSupport !== false) &&
        tlPrice !== undefined &&
        tlPrice > highestEnabledBuyPrice &&
        tlPrice < sellLevel1Limit &&
        currentBestAsk > 0 &&
        currentBestAsk <= tlPrice &&
        refPrice <= tlPrice &&
        activeBuyCount > 0 // Allow 1-tranche TL support buy even when Buy L1/L2 are disabled
      ) {
        targetTranches = 1;
        matchedLevelIndex = 0;
        isTlBuy = true;
        matchedBuyPrice = tlPrice;
      } else {
        // 2. Standard Grid Buy Levels: count how many ACTIVE buy levels have been crossed
        let activeReached = 0;
        for (let i = 0; i < buyLevels.length; i++) {
          const lvlPrice = buyLevels[i];
          if (lvlPrice !== undefined) {
            // Strict trigger: currentBestAsk and refPrice must strictly reach or drop below lvlPrice
            const isLevelTriggered = currentBestAsk > 0 && currentBestAsk <= lvlPrice && refPrice <= lvlPrice;

            if (isLevelTriggered && enabledBuys[i]) {
              activeReached++;
              matchedLevelIndex = i;
            }
          }
        }
        if (activeReached > 0 && matchedLevelIndex >= 0) {
          targetTranches = activeReached;
          matchedBuyPrice = buyLevels[matchedLevelIndex];
        }
      }

      // Check trendline resistance filter (if descending trendline is active, cannot buy at or above TL)
      if (activeDowntrendLine && !activeDowntrendLine.isBroken && currentBestAsk >= activeDowntrendLine.currentLinePrice) {
        targetTranches = 0;
      }

      if (targetTranches > 0 && matchedLevelIndex >= 0 && matchedBuyPrice !== undefined && baseTrancheQuote > 0) {
        const firstActiveFrac = buyFractions.find((f) => f > 0) ?? (1 / activeBuyCount);
        const targetCapacityFraction = isTlBuy
          ? firstActiveFrac
          : this.getCumulativeBuyTargetFraction(matchedLevelIndex, enabledBuys, buyLevels.length);
        const targetCapacityQuote = maxInv * targetCapacityFraction;
        const levelTrancheQuote = isTlBuy
          ? (maxInv * firstActiveFrac)
          : (maxInv * (buyFractions[matchedLevelIndex] || firstActiveFrac));
        const deficitQuote = targetCapacityQuote - currentHeldQuote;

        // Only trigger if deficit is significant (at least 70% of this level's tranche, avoiding micro-dust churn)
        if (deficitQuote >= (levelTrancheQuote * 0.70)) {
          const cooldownKey = isTlBuy ? `ioc_bracket_buy_tl` : `ioc_bracket_buy_level_${matchedLevelIndex}`;
          const lastBuyTime = this.orderCooldowns.get(cooldownKey) ?? 0;
          const globalBuyCooldown = this.orderCooldowns.get("ioc_bracket_buy_global") ?? 0;
          const now = Date.now();

          // 10s cooldown per level, 3s global debounce
          if (now - lastBuyTime > 10_000 && now - globalBuyCooldown > 3_000) {
            const availableWalletQuote = this.cfg.dryRun ? maxInv : this.walletQuoteBalance;
            // After a Cut Loss, enforce incremental 1-tranche DCA re-entry (prevent immediate lump-sum whipsaw buy)
            const maxAllowedPerBuy = this.postCutSingleTrancheOnly ? levelTrancheQuote : deficitQuote;
            let toSpendQuote = Math.min(deficitQuote, maxAllowedPerBuy, Math.max(0, maxInv - currentHeldQuote), availableWalletQuote);
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
              const tranchesAggregated = Math.max(1, Math.round(toSpendQuote / Math.max(levelTrancheQuote, 0.01)));
              const buyQty = toSpendQuote / currentBestAsk;
              const actionLabel = isTlBuy
                ? `IOC Buy @ Trendline Support ($${matchedBuyPrice.toFixed(6)})`
                : tranchesAggregated > 1
                ? `IOC Buy L1-L${matchedLevelIndex + 1} (${tranchesAggregated}x)`
                : `IOC Buy Level ${matchedLevelIndex + 1}`;

              this.log(
                `🎯 [IOC BRACKET] Ask $${currentBestAsk.toFixed(6)} <= ${isTlBuy ? "TL Support" : `Buy Band ${matchedLevelIndex + 1}`} ($${matchedBuyPrice.toFixed(6)}) — executing ${actionLabel} for $${toSpendQuote.toFixed(2)} ${this.quoteAsset}${this.postCutSingleTrancheOnly ? " [Post-Cut 1x DCA Guard]" : ""}`,
              );
              await this.buyTrancheIOC(buyQty, currentBestAsk, actionLabel, matchedBuyPrice, toSpendQuote);
              if (this.postCutSingleTrancheOnly) {
                this.postCutSingleTrancheOnly = false;
                this.saveState();
              }
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
    const activeSellIndices = (sellLevels.length > 0 ? sellLevels.map((_, idx) => idx) : [0, 1, 2, 3, 4]).filter(
      (idx) => enabledSells[idx] && sellLevels[idx] !== undefined,
    );

    // Ceiling / Upper Bound Guard: If price reached or exceeded Upper Bound, do NOT execute stepped ladder tranches.
    // Stepped tranches (Step 1..4) are for intra-channel distribution only. Upper bound exit is handled by 100% Full Take Profit.
    const isCeilingZone = refPrice >= upperBound || (currentBestBid > 0 && currentBestBid >= upperBound);
    if (isCeilingZone && this.cfg.takeProfitAtUpperBound) {
      return;
    }

    if (this.sellOrdersActive && held >= this.minQty && totalHeldQuote >= minNotional && currentBestBid > 0 && activeSellIndices.length > 0) {
      // 1. Maintain or initialize sell distribution cycle
      // If no active cycle, or position grew significantly (new buy filled), establish new baseline
      if (
        !this.iocBracketSellCycle ||
        held > this.iocBracketSellCycle.baselineHeldQty * 1.05
      ) {
        let numSellTranches = Math.min(activeSellIndices.length, Math.max(1, sellLevels.length));
        while (numSellTranches > 1 && (totalHeldQuote / numSellTranches) < minNotional) {
          numSellTranches--;
        }
        this.iocBracketSellCycle = {
          baselineHeldQuote: totalHeldQuote,
          baselineHeldQty: held,
          numSellTranches,
          soldStepNums: new Set<number>(),
        };
        this.saveState();
      }

      const cycle = this.iocBracketSellCycle;
      const numSellTranches = cycle.numSellTranches;

      interface SellStep {
        levelIndex: number;
        targetRemainingFraction: number;
        stepNum: number;
      }
      const activeSteps: SellStep[] = [];
      const selectedIndices = activeSellIndices.slice(0, numSellTranches);
      for (let s = 0; s < selectedIndices.length; s++) {
        const lvlIdx = selectedIndices[s]!;
        const isFinal = (s === selectedIndices.length - 1);
        const remFraction = isFinal ? 0.0 : ((selectedIndices.length - 1 - s) / selectedIndices.length);
        activeSteps.push({
          levelIndex: lvlIdx,
          targetRemainingFraction: remFraction,
          stepNum: s + 1,
        });
      }

      // 3. Find candidate sell steps that have been reached by market bid but NOT yet sold in this cycle
      const sellSlippage = (this.cfg.iocSlippagePct ?? 0.2) / 100;
      let matchedStep: SellStep | undefined;
      for (const step of activeSteps) {
        const lvlPrice = sellLevels[step.levelIndex];
        const minAllowedBid = lvlPrice !== undefined ? lvlPrice * (1 - sellSlippage) : undefined;
        if (lvlPrice !== undefined && minAllowedBid !== undefined && (currentBestBid >= minAllowedBid || refPrice >= lvlPrice)) {
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
          const minProfitMult = this.getMinProfitMultiplier();
          const lowestLotCost = this.lots.length > 0 ? Math.min(...this.lots.map((l) => l.price)) : avgEntry;
          const meetsProfitRequirement = this.cfg.requireProfitAboveAvgEntry
            ? (avgEntry <= 0 || currentBestBid >= avgEntry * minProfitMult)
            : (lowestLotCost <= 0 || currentBestBid >= lowestLotCost * minProfitMult);

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
                    if (matchedStep.targetRemainingFraction === 0 || this.baseHeld() < this.minQty) {
                      this.iocBracketSellCycle = undefined;
                    }
                    this.saveState();
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
    allowLoss = false,
  ): Promise<boolean> {
    const actionLabel = levelName.startsWith("IOC") ? levelName : `IOC ${levelName}`;
    const held = this.baseHeld();
    if (held < this.minQty || qty < this.minQty) {
      return false;
    }
    const executeQty = roundToStep(Math.min(held, qty), this.stepSize || 0.0001, this.qtyPrecision);
    if (executeQty < this.minQty) {
      return false;
    }
    const now = Date.now();
    // In IOC sell: price must NEVER be below targetPrice (Sell Level) unless allowLoss is explicitly true (Stage 1 Cut Loss)
    const effectivePrice = allowLoss ? (execPrice > 0 ? execPrice : targetPrice) : Math.max(execPrice, targetPrice);
    const minNotional = Math.max(this.minNotional || 5.0, 5.0);
    const orderNotional = executeQty * effectivePrice;

    if (orderNotional < minNotional) {
      this.log(
        `⚠️ [MIN NOTIONAL GUARD] Cannot execute ${actionLabel}: Order value $${orderNotional.toFixed(2)} is below Binance minimum ($${minNotional.toFixed(2)}).`,
      );
      return false;
    }

    if (this.cfg.dryRun) {
      const slippagePctVal = this.cfg.iocSlippagePct ?? 0.2;
      const dryLimitPrice = roundToTick(targetPrice * (1 - slippagePctVal / 100), this.tickSize || 0.0001);
      const oldTradePnl = this.tradeRealizedPnl;
      this.closeLots(executeQty, effectivePrice);
      const roundPnl = this.tradeRealizedPnl - oldTradePnl;
      this.log(
        `[dry-run] ⚡ ${actionLabel}: Sold ${executeQty.toFixed(4)} ${this.baseAsset} @ $${effectivePrice.toFixed(6)} | Target: $${targetPrice.toFixed(6)} | Slip: ${slippagePctVal.toFixed(2)}% | Limit: $${dryLimitPrice.toFixed(6)} • Trade PnL: ${roundPnl >= 0 ? "+$" : "-$"}${Math.abs(roundPnl).toFixed(4)} | Net: ${this.realizedPnl >= 0 ? "+$" : "-$"}${Math.abs(this.realizedPnl).toFixed(4)}`,
      );
      this.emit({
        type: "order",
        data: {
          action: "SELL_FILL",
          status: "FILLED",
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
          targetPrice,
          slippagePct: slippagePctVal,
          limitPrice: dryLimitPrice,
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
      // In CLOB IOC sell: targetPrice acts as trigger price and anchor.
      // Grid tranche sell allows setting below level down to targetPrice * (1 - slippagePct), while guarding against selling below avg entry (unless allowLoss is true)
      const avgEntry = this.getAvgEntryPrice();
      const slippagePctVal = this.cfg.iocSlippagePct ?? 0.2;
      const slippagePct = slippagePctVal / 100;
      const minAllowedBySlippage = targetPrice * (1 - slippagePct);
      const minProfitablePrice = (!allowLoss && avgEntry > 0) ? avgEntry * this.getMinProfitMultiplier() : minAllowedBySlippage;
      const minAllowedPrice = Math.max(minProfitablePrice, minAllowedBySlippage);
      const basePrice = (execPrice > 0) ? execPrice : targetPrice;
      let limitPrice = Math.max(minAllowedPrice, basePrice * (1 - slippagePct));
      limitPrice = roundToTick(limitPrice, this.tickSize || 0.0001);
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
      const fillPrice = (typeof res.cummulativeQuoteQty === "number" && res.cummulativeQuoteQty > 0 && typeof res.executedQty === "number" && res.executedQty > 0)
        ? (res.cummulativeQuoteQty / res.executedQty)
        : (typeof res.price === "number" && res.price > 0 ? res.price : effectivePrice);

      const oldTradePnl = this.tradeRealizedPnl;
      this.closeLots(actualQty, fillPrice);
      const roundPnl = this.tradeRealizedPnl - oldTradePnl;

      this.log(
        `⚡ ON-CHAIN ${actionLabel}: Sold ${actualQty.toFixed(4)} ${this.baseAsset} @ $${fillPrice.toFixed(6)} | Target: $${targetPrice.toFixed(6)} | Slip: ${slippagePctVal.toFixed(2)}% | Limit: $${limitPrice.toFixed(6)} • Trade PnL: ${roundPnl >= 0 ? "+$" : "-$"}${Math.abs(roundPnl).toFixed(4)} | Net: ${this.realizedPnl >= 0 ? "+$" : "-$"}${Math.abs(this.realizedPnl).toFixed(4)} (tx: ${res.txHash || orderIdStr || "N/A"})`,
      );
      this.emit({
        type: "order",
        data: {
          action: "SELL_FILL",
          status: "FILLED",
          price: fillPrice,
          qty: actualQty,
          notional: actualQty * fillPrice,
          notionalQuote: actualQty * fillPrice,
          notionalUsdso: actualQty * fillPrice,
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
          targetPrice,
          slippagePct: slippagePctVal,
          limitPrice,
        },
      });
      if (res?.txHash && (res.gasFee === undefined || res.gasFee <= 0)) {
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
      const buyQty = roundToStep(rawBuyQty, this.stepSize || 0.0001, this.qtyPrecision);
      if (buyQty < this.minQty) return false;
      const slippagePctVal = this.cfg.iocSlippagePct ?? 0.2;
      const dryLimitPrice = roundToTick(Math.min(targetPrice, effectivePrice * (1 + slippagePctVal / 100)), this.tickSize || 0.0001);
      this.processBuyFill({
        price: effectivePrice,
        qty: buyQty,
        levelDesc: actionLabel,
        logPrefix: "[dry-run] ",
        dryRun: true,
        isIoc: true,
        targetPrice,
        slippagePct: slippagePctVal,
        limitPrice: dryLimitPrice,
      });
      this.saveState();
      this.emitTelemetryTick();
      return true;
    }

    // In live mode: Refresh wallet balance to ensure 100% accurate available balance
    await this.refreshWalletBalances();

    const availableBudgetQuote = Math.min(notionalQuote, this.walletQuoteBalance);
    const rawFinalQty = availableBudgetQuote / effectivePrice;
    const finalQty = roundToStep(rawFinalQty, this.stepSize || 0.0001, this.qtyPrecision);
    if (finalQty < this.minQty) {
      this.log(`⚠️ [IOC BUY] Insufficient ${this.quoteAsset} balance ($${this.walletQuoteBalance.toFixed(2)} < $${notionalQuote.toFixed(2)})`);
      return false;
    }

    try {
      // In CLOB IOC buy: enforce Single Ceiling Cap strictly anchored to targetPrice (Buy Level)
      // limitPrice must NEVER exceed targetPrice!
      // If execPrice is below targetPrice, allow slippage up to targetPrice, but never above targetPrice!
      const slippagePctVal = this.cfg.iocSlippagePct ?? 0.2;
      const slippagePct = slippagePctVal / 100;
      const maxAllowedPrice = targetPrice;
      const basePrice = (execPrice > 0) ? execPrice : targetPrice;
      let limitPrice = Math.min(maxAllowedPrice, basePrice * (1 + slippagePct));
      limitPrice = roundToTick(limitPrice, this.tickSize || 0.0001);
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

      // On DreamDEX On-Chain IOC: gas fee is tracked via onGasSpent or returned in res.gasFee
      if (res.gasFee !== undefined && res.gasFee > 0) {
        if (!this.binance.onGasSpent) {
          this.accumulatedGasBase += res.gasFee;
          this.totalGasSpentBase += res.gasFee;
          const refP = effectivePrice || 0.20;
          this.accumulatedGasQuote += res.gasFee * refP;
          this.totalGasSpentQuote += res.gasFee * refP;
          this.totalTxCount++;
        }
        this.log(`⛽ [GAS ON BUY] Spent ${res.gasFee.toFixed(5)} SOMI on this IOC buy transaction. Included in uncompensated gas.`);
      }

      const actualQty = Math.min(finalQty, filledQty > 0 ? filledQty : finalQty);
      const fillPrice = (typeof res.cummulativeQuoteQty === "number" && res.cummulativeQuoteQty > 0 && typeof res.executedQty === "number" && res.executedQty > 0)
        ? (res.cummulativeQuoteQty / res.executedQty)
        : (typeof res.price === "number" && res.price > 0 ? res.price : effectivePrice);

      this.processBuyFill({
        price: fillPrice,
        qty: actualQty,
        levelDesc: actionLabel,
        orderId: orderIdStr,
        txHash: res?.txHash,
        logPrefix: "ON-CHAIN ",
        dryRun: false,
        isIoc: true,
        targetPrice,
        slippagePct: slippagePctVal,
        limitPrice,
      });
      if (res?.txHash && (res.gasFee === undefined || res.gasFee <= 0)) {
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

  private async sellAll(price: number, action: "SELL" | "CUT" | "MANUAL", anchorRefPrice?: number): Promise<void> {
    const actionLabel = action === "CUT"
      ? "CUT LOSS (SELL ALL)"
      : (action === "MANUAL" ? "MANUAL SELL ALL (EMERGENCY EXIT)" : "100% FULL EXIT (TAKE PROFIT)");
    const targetPrice = (anchorRefPrice && anchorRefPrice > 0) ? anchorRefPrice : price;
    const slippagePctVal = this.cfg.iocSlippagePct ?? 0.35;

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
      const isCut = action === "CUT";
      const isManual = action === "MANUAL";
      const avgEntry = this.getAvgEntryPrice();
      let dryLimitPrice: number;
      if (action === "SELL") {
        const minAllowed = targetPrice * (1 - slippagePctVal / 100);
        const minProfitMult = this.getMinProfitMultiplier();
        const minProfitablePrice = avgEntry > 0 ? avgEntry * minProfitMult : minAllowed;
        dryLimitPrice = roundToTick(Math.max(minProfitablePrice, Math.max(minAllowed, price * (1 - slippagePctVal / 100))), this.tickSize || 0.0001);
      } else if (action === "MANUAL") {
        dryLimitPrice = roundToTick(price, this.tickSize || 0.0001);
      } else {
        dryLimitPrice = roundToTick(targetPrice * (1 - slippagePctVal / 100), this.tickSize || 0.0001);
      }
      const effectiveSlipPct = action === "MANUAL" ? 0 : slippagePctVal;
      const oldTradePnl = this.tradeRealizedPnl;
      this.closeLots(held, price);
      const roundPnl = this.tradeRealizedPnl - oldTradePnl;
      const effectiveActionLabel = isCut
        ? "CUT LOSS (SELL ALL)"
        : (isManual ? "MANUAL SELL ALL (EMERGENCY EXIT)" : (roundPnl >= 0 ? "100% FULL EXIT (TAKE PROFIT)" : "BREAKDOWN EXIT (LOSS)"));
      const orderAction = isCut
        ? "CUT"
        : (isManual ? "EXIT" : (roundPnl >= 0 ? "TAKE_PROFIT" : "BREAKDOWN_EXIT"));
      this.log(
        `[dry-run] 🚨 ${effectiveActionLabel}: ${held.toFixed(4)} ${this.baseAsset} @ $${price.toFixed(6)} | Target: $${targetPrice.toFixed(6)} | Slip: ${effectiveSlipPct.toFixed(2)}% | Limit: $${dryLimitPrice.toFixed(6)} (Trade PnL: ${roundPnl >= 0 ? "+$" : "-$"}${Math.abs(roundPnl).toFixed(4)} | Net Total: ${this.realizedPnl >= 0 ? "+$" : "-$"}${Math.abs(this.realizedPnl).toFixed(4)})`,
      );
      this.emit({
        type: "order",
        data: {
          action: orderAction,
          status: "FILLED",
          price,
          qty: held,
          notional: held * price,
          notionalQuote: held * price,
          notionalUsdso: held * price,
          pnl: roundPnl,
          pnlQuote: roundPnl,
          pnlUsdso: roundPnl,
          levelDesc: effectiveActionLabel,
          reason: effectiveActionLabel,
          time: now,
          dryRun: true,
          maker: false,
          isIoc: true,
          targetPrice,
          slippagePct: effectiveSlipPct,
          limitPrice: dryLimitPrice,
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
    const executeQty = roundToStep(rawExecuteQty, this.stepSize || 0.0001, this.qtyPrecision);
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
      // Determine effective limit price with slippage protection for IOC execution
      // On DreamDEX CLOB / IOC bracket, strict limit price with 0 slippage causes Revert 0xc04ad919 if book depth shifts.
      let limitPrice = price;
      if (this.binance.exchangeName === "dreamdex" || this.cfg.orderExecutionMode === "IOC_BRACKET") {
        let currentBestBid = 0;
        if (this.binance.exchangeName === "dreamdex") {
          try {
            const top = await this.binance.getTopOfBook(this.symbol, action === "MANUAL");
            if (top?.bestBid && top.bestBid > 0) {
              currentBestBid = top.bestBid;
              price = Math.min(price, top.bestBid);
            }
          } catch {}
        } else if (this.wsBookTicker && Date.now() - this.wsBookTicker.time < 10_000 && this.wsBookTicker.bestBid > 0) {
          currentBestBid = this.wsBookTicker.bestBid;
        } else {
          try {
            const top = await this.binance.getTopOfBook(this.symbol, action === "MANUAL");
            if (top?.bestBid && top.bestBid > 0) {
              currentBestBid = top.bestBid;
            }
          } catch {}
        }
        const avgEntry = this.getAvgEntryPrice();
        const slippagePct = slippagePctVal / 100;
        if (action === "SELL") {
          // Take profit / Resistance IOC: limitPrice allows matching down to targetPrice * (1 - slippagePct), while staying strictly above avg entry
          const minAllowedBySlippage = targetPrice * (1 - slippagePct);
          const minProfitMult = this.getMinProfitMultiplier();
          const minProfitablePrice = avgEntry > 0 ? avgEntry * minProfitMult : minAllowedBySlippage;
          const minAllowedPrice = Math.max(minProfitablePrice, minAllowedBySlippage);
          const basePrice = (price > 0) ? price : targetPrice;
          limitPrice = Math.max(minAllowedPrice, basePrice * (1 - slippagePct));
        } else if (action === "MANUAL") {
          // Manual Sell All: If Best Bid is available in orderbook, send strictly at Best Bid (0% discount)
          // No need to reduce/discount price beforehand. Only fallback to slippage if no valid Best Bid exists.
          const effectiveBid = currentBestBid > 0 ? currentBestBid : (price > 0 ? price : 0);
          if (effectiveBid > 0) {
            limitPrice = effectiveBid;
          } else {
            limitPrice = (price > 0 ? price : targetPrice) * (1 - slippagePct);
          }
        } else {
          // Cut Loss: Allow matching down to max bid discount to guarantee immediate execution
          limitPrice = price * (1 - slippagePct);
        }
        limitPrice = roundToTick(limitPrice, this.tickSize || 0.0001);
      }

      const exitClientOrderId = `exit_${Date.now()}`;
      this.handledExitOrderIds.set(exitClientOrderId, Date.now());

      const res = await this.binance.placeOrder({
        symbol: this.symbol,
        side: "SELL",
        type: "IOC",
        price: limitPrice,
        qty: executeQty,
        clientOrderId: exitClientOrderId,
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

      // If WebSocket already processed the executionReport and closed the lots, avoid duplicate closing/emission
      if (this.baseHeld() < this.minQty) {
        this.log(`⚡ [EXIT SYNC] Position was already closed by WebSocket execution report — skipping duplicate fill processing`);
        this.saveState();
        this.emitTelemetryTick();
        return;
      }

      const actualQty = Math.min(executeQty, filledQty > 0 ? filledQty : executeQty);
      const actualPrice = (typeof res.cummulativeQuoteQty === "number" && res.cummulativeQuoteQty > 0 && typeof res.executedQty === "number" && res.executedQty > 0)
        ? (res.cummulativeQuoteQty / res.executedQty)
        : (typeof res.price === "number" && res.price > 0 ? res.price : limitPrice);

      const oldTradePnl = this.tradeRealizedPnl;
      this.closeLots(actualQty, actualPrice);
      const roundPnl = this.tradeRealizedPnl - oldTradePnl;
      const effectiveSlipPct = (action === "MANUAL" && limitPrice >= targetPrice) ? 0 : slippagePctVal;
      const isCut = action === "CUT";
      const isManual = action === "MANUAL";
      const effectiveActionLabel = isCut
        ? "CUT LOSS (SELL ALL)"
        : (isManual ? "MANUAL SELL ALL (EMERGENCY EXIT)" : (roundPnl >= 0 ? "100% FULL EXIT (TAKE PROFIT)" : "BREAKDOWN EXIT (LOSS)"));
      const orderAction = isCut
        ? "CUT"
        : (isManual ? "EXIT" : (roundPnl >= 0 ? "TAKE_PROFIT" : "BREAKDOWN_EXIT"));
      this.log(
        `🚨 ON-CHAIN ${effectiveActionLabel}: ${actualQty.toFixed(4)} ${this.baseAsset} @ $${actualPrice.toFixed(6)} | Target: $${targetPrice.toFixed(6)} | Slip: ${effectiveSlipPct.toFixed(2)}% | Limit: $${limitPrice.toFixed(6)} (Trade PnL: ${roundPnl >= 0 ? "+$" : "-$"}${Math.abs(roundPnl).toFixed(4)} | Net Total: ${this.realizedPnl >= 0 ? "+$" : "-$"}${Math.abs(this.realizedPnl).toFixed(4)}) (tx: ${res.txHash || orderIdStr || "N/A"})`,
      );
      this.emit({
        type: "order",
        data: {
          action: orderAction,
          status: "FILLED",
          price: actualPrice,
          qty: actualQty,
          notional: actualQty * actualPrice,
          notionalQuote: actualQty * actualPrice,
          notionalUsdso: actualQty * actualPrice,
          pnl: roundPnl,
          pnlQuote: roundPnl,
          pnlUsdso: roundPnl,
          levelDesc: effectiveActionLabel,
          reason: effectiveActionLabel,
          time: now,
          dryRun: false,
          txHash: res.txHash,
          orderId: orderIdStr,
          maker: false,
          isIoc: true,
          targetPrice,
          slippagePct: effectiveSlipPct,
          limitPrice,
        },
      });
      if (res?.txHash && (res.gasFee === undefined || res.gasFee <= 0)) {
        this.trackTxGas(res.txHash, effectiveActionLabel);
      }
      await this.refreshWalletBalances();
      if (this.walletBaseBalance - minGasReserveBase <= (this.minQty || 0.0001)) {
        this.lots = [];
        this.lockedChannel = undefined;
        this.lastDynamicBounds = undefined;
      }
      this.saveState();
    } catch (err) {
      this.log(`⚠️ On-chain ${actionLabel} failed: ${(err as Error).message}`);
      await this.refreshWalletBalances();
      // If balance is already depleted after an on-chain cut loss attempt, clear lots to avoid infinite loop
      if (this.walletBaseBalance - minGasReserveBase <= (this.minQty || 0.0001)) {
        this.lots = [];
        this.lockedChannel = undefined;
        this.lastDynamicBounds = undefined;
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
      this.lastDynamicBounds = undefined;
      this.iocBracketSellCycle = undefined;
      this.soldSellIndices.clear();
    }
  }

  public baseHeld(): number {
    return this.lots.reduce((s, l) => s + l.qty, 0);
  }

  /**
   * Asynchronously fetch transaction receipt to track gas fee spent
   */
  public async trackTxGas(txHash?: string, label?: string): Promise<void> {
    if (!txHash) return;
    if (this.cfg.dryRun) return;
    if (this.binance.exchangeName !== "dreamdex") return;

    try {
      const getFeeFn = (this.binance as any).getTransactionFee;
      let feeSomi: number | undefined;
      if (typeof getFeeFn === "function") {
        feeSomi = await (this.binance as any).getTransactionFee(txHash);
      }
      if (feeSomi !== undefined && feeSomi > 0) {
        this.accumulatedGasBase += feeSomi;
        this.totalGasSpentBase += feeSomi;
        const refPrice = this.lastRefPrice || this.getAvgEntryPrice() || 0.20;
        const feeQuote = feeSomi * refPrice;
        this.accumulatedGasQuote += feeQuote;
        this.totalGasSpentQuote += feeQuote;
        this.totalTxCount++;

        this.log(
          `⛽ [GAS TRACKED] ${label || "Tx"} (${txHash.slice(0, 10)}...): Spent ${feeSomi.toFixed(5)} SOMI (~$${feeQuote.toFixed(4)}) | Total uncompensated gas: ${this.accumulatedGasBase.toFixed(5)} SOMI`,
        );

        if (typeof (this.db as any).updateTxGas === "function") {
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
      }
    } catch (err) {
      this.log(`⚠️ Failed to track gas for tx ${txHash}: ${(err as Error).message}`);
    }
  }
}
