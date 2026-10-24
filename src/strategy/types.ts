/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import type { Config } from "../config.js";
import type { AtrSource } from "../types.js";
import type { DowStructureEngine, Candle, TrendLine, DowStructure } from "../market-structure.js";
import type { IExchangeClient, ExchangeSymbolInfo } from "../exchange/types.js";
import type { BotDatabase, StrategyStateRecord, LockedChannel } from "../db.js";

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

export interface ConfirmedChannelState {
  candleTime: number;
  channel: {
    floor: number;
    center: number;
    ceiling: number;
    span: number;
    buyLevels: number[];
    sellLevels: number[];
  };
  dow: DowStructure;
}

/**
 * Host interface implemented by DynamicGrid orchestrator,
 * allowing modular strategy components (RiskManager, LotTracker, BuySync, SellSync, OrderExecutor)
 * to interact with runtime state and dependencies cleanly without circular imports.
 */
export interface IStrategyHost {
  cfg: Config;
  binance: IExchangeClient;
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  minQty: number;
  stepSize: number;
  tickSize: number;
  qtyPrecision: number;
  minNotional: number;
  isPaused: boolean;
  isSwitchingSymbol: boolean;
  db: BotDatabase;
  atrSource: AtrSource;
  dowEngine?: DowStructureEngine;
  localTrendEngine?: DowStructureEngine;

  // Balances
  walletBaseBalance: number;
  walletQuoteBalance: number;
  lastObservedBaseBalance: number;
  lastObservedQuoteBalance: number;
  getEffectiveGasReserveBase(): number;
  getEffectiveGasReserveSomi(): number;

  // Orders & Lots
  lots: Lot[];
  openOrders: OpenOrder[];
  cancelledOrderIds: Map<string, number>;
  handledExitOrderIds: Map<string, number>;
  inFlightOrders: Set<string>;
  orderCooldowns: Map<string, number>;
  processedGasTxHashes: Set<string>;

  // PnL & Gas
  realizedPnl: number;
  tradeRealizedPnl: number;
  totalGasDeductedBase: number;
  totalGasDeductedQuote: number;
  accumulatedGasBase: number;
  accumulatedGasQuote: number;
  totalGasSpentBase: number;
  totalGasSpentQuote: number;
  totalTxCount: number;

  // State & Flags
  lastRefPrice: number;
  lastBestBid?: number;
  lastBestAsk?: number;
  wsBookTicker?: {
    bestBid: number;
    bestAsk: number;
    mid: number;
    time: number;
  };
  stuckSince?: number;
  waitingForHigherLow: boolean;
  isFlatChannelShiftWaiting: boolean;
  isTrendSupportExitActive: boolean;
  trendSupportBreakPrice?: number;
  lastTrendSupportBreakKey?: string;
  wasFlatCashLastTick: boolean;
  lastCutLossTime?: number;
  cutLossStage1Executed: boolean;
  cutLossStage1Price?: number;
  cutLossStage1CandleTime?: number;
  cutLossStage1Time?: number;
  bufferBreakStartTime?: number;
  breakdownCandleTimes: Set<number>;
  breakdownFloorPrice?: number;
  breakdownLowPrice?: number;
  breakdownTime?: number;
  breakdownBuyLevel2Price?: number;
  postCutSingleTrancheOnly: boolean;
  iocBracketSellCycle?: any;
  lastBuyFillTime: number;
  lastBuyFillPrice: number;
  lastBuyFillCandleTime: number;
  lastResolvedDumpLowPrice?: number;
  isDowntrendDropPaused: boolean;
  downtrendDropLow?: number;
  needsBuyRebalance: boolean;
  needsSellRebalance: boolean;
  soldSellIndices: Set<number>;
  buyOrdersActive: boolean;
  sellOrdersActive: boolean;
  confirmedChannel?: any;
  pendingConfirmedChannelUpdate: boolean;
  lockedChannel?: LockedChannel;
  lastEvaluatedFloor?: number;
  lastEvaluatedCeil?: number;

  // Methods
  clearPositionState(): void;
  getSymbolKey(): string;
  log(msg: string): void;
  status(msg: string): void;
  emit(event: StrategyEvent): void;
  emitTelemetryTick(): void;
  saveState(immediate?: boolean): void;
  refreshWalletBalances(): Promise<{ base: number; quote: number; somi: number; usdso: number; address: string }>;
  syncOnChainOrders(): Promise<void>;
  roundPrice(price: number): number;
  roundQty(qty: number): number;
  formatPrice(price: number): string;
  formatQty(qty: number): string;
  getBuyLevelWeightFractions(enabledBuys?: boolean[], numLevels?: number, forceFirstActive?: boolean): number[];
  getCumulativeBuyTargetFraction(upToIdx: number, enabledBuys?: boolean[], numLevels?: number, forceFirstActive?: boolean): number;
  getMinProfitMultiplier(): number;
  getAvgEntryPrice(): number;
  baseHeld(): number;
  getTotalPortfolioValueQuote(refP: number): number;
}

export type StrategyType = "dynamic_grid" | "swing_trade";

export interface StrategyContext {
  exchange: IExchangeClient;
  symbolInfo: ExchangeSymbolInfo;
  config: Config;
  atrSource: AtrSource;
  log: (msg: string) => void;
  macroDowEngine: DowStructureEngine;
  localTrendEngine?: DowStructureEngine;
  htfDowEngine?: DowStructureEngine;
}

/**
 * Standard pluggable Strategy Interface implemented by all bot trading strategies
 * (DynamicGrid, SwingTrader, etc.) to ensure uniform lifecycle and dashboard controls.
 */
export interface IStrategy {
  readonly name: string;
  readonly strategyType: StrategyType;

  // Lifecycle & Execution
  tick(): Promise<void>;
  getIntervalMs(): number;

  // Real-time Feeds & Events
  onCandleClosed(candle: Candle): void;
  onEvent(cb: (event: StrategyEvent) => void): void;
  emitTelemetryTick(): void;
  handleWsBookTicker?(b: any): void;
  handleWsExecutionReport?(rep: any): void;
  handleWsAccountUpdate?(acc: any): void;

  // Controls & Settings
  atrSource: AtrSource;
  getRealDreamdexPrivateKey(): string | undefined;
  getRealBinanceApiKey(): string | undefined;
  getRealBinanceApiSecret(): string | undefined;
  getDatabase(): BotDatabase;
  getRuntimeConfig(): any;
  updateRuntimeSettings(s: any): any;
  setPaused(paused: boolean): boolean;
  getIsPaused(): boolean;
  cancelAllOrdersUser(): Promise<{ cancelledCount: number; }>;
  sellAllUser(): Promise<{ success: boolean; soldQty: number; price: number; error?: string; }>;
  resetBotState(opts?: any): Promise<{ success: boolean; }>;
  resetPosition(): Promise<{ success: boolean; clearedLots: number; }>;
  reloadState(): void;
  getRecentOrders(): any[];
  saveState(immediate?: boolean): void;

  // Portfolio & Balances
  baseHeld(): number;
  getLots(): Lot[];
  refreshWalletBalances(): Promise<any>;
  syncOnChainOrders(): Promise<void>;

  // Symbol & Exchange switching
  setSwitchingSymbol(val: boolean): void;
  prepareForSymbolSwitch(targetSymbol: string): Promise<void>;
  updateExchangeClient(newExchange: IExchangeClient, nextInfo: ExchangeSymbolInfo, atrSource: AtrSource): void;
  updateSymbolInfo(nextInfo: ExchangeSymbolInfo, atrSource: AtrSource): void;
}

