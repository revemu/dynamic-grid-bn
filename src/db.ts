/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import fs from "node:fs";
import path from "node:path";
import { calculateTradeRounds, type TradeRoundsResult, type TradeRound, type TradeRoundSummary } from "./trade-rounds.js";

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
  notionalQuote?: number;
  notionalUsdso?: number;
  levelDesc: string;
  placedTime: number;
  expireTime?: number;
  txHash?: string;
}

export interface LockedChannel {
  lowerBound: number;
  upperBound: number;
  centerPrice: number;
  buyLevels: number[];
  sellLevels: number[];
  rawFloorPrice?: number;
  lockedAt: number;
}

export interface StrategyStateRecord {
  lots: Lot[];
  openOrders: OpenOrder[];
  realizedPnl: number;
  tradeRealizedPnl?: number;       // Gross profit from closed trades
  netPnl?: number;
  walletBaseBalance?: number;
  walletQuoteBalance?: number;
  baseAsset?: string;
  quoteAsset?: string;
  totalGasDeductedBase?: number;
  totalGasDeductedQuote?: number;
  totalGasDeductedSomi?: number;   // Cumulative gas/fee compensated (compat)
  totalGasDeductedUsdso?: number;  // (compat)
  accumulatedGasBase?: number;
  accumulatedGasQuote?: number;
  accumulatedGasSomi?: number;     // (compat)
  accumulatedGasUsdso?: number;    // (compat)
  totalGasSpentBase?: number;
  totalGasSpentQuote?: number;
  totalGasSpentSomi?: number;      // (compat)
  totalGasSpentUsdso?: number;     // (compat)
  totalTxCount?: number;
  stuckSince?: number;
  waitingForHigherLow?: boolean;
  isFlatChannelShiftWaiting?: boolean;
  breakdownFloorPrice?: number;
  breakdownLowPrice?: number;
  breakdownBuyLevel2Price?: number;
  breakdownTime?: number;
  brokenValleyTime?: number;
  brokenValleyPrice?: number;
  lockedChannel?: LockedChannel;
  sellOrdersActive?: boolean;
  buyOrdersActive?: boolean;
  isSqueezePaused?: boolean;
  isPaused?: boolean;
  recentOrders?: any[];
  appliedManualTradeIds?: string[];
  lastCutLossTime?: number;
  postCutSingleTrancheOnly?: boolean;
  iocBracketSellCycle?: {
    baselineHeldQuote: number;
    baselineHeldQty: number;
    numSellTranches: number;
    soldStepNums: number[];
  };
  lastUpdated: number;
}

/**
 * Single Unified Order Record
 * Combines Placement, Execution/Fill, Cancellation, and Gas Accounting into a single source of truth.
 */
export interface UnifiedOrderRecord {
  id: string;                    // Local DB record ID e.g. "ord_1790467149578_abc"
  orderId: string;               // On-chain or local order ID
  symbol?: string;               // Trading pair symbol e.g. "SOMI:USDSO"
  side: "BUY" | "SELL";
  price: number;
  qty: number;
  notionalQuote?: number;
  notional?: number;
  notionalUsdso?: number;        // Backward compat alias
  baseAsset?: string;
  quoteAsset?: string;
  levelDesc?: string;
  status: "OPEN" | "FILLED" | "CANCELLED";
  action: "CREATE_BUY" | "CREATE_SELL" | "CANCEL_BUY" | "CANCEL_SELL" | "BUY_FILL" | "SELL_FILL" | "CUT" | "TAKE_PROFIT" | "SNIPE_BUY" | "SNIPE_SELL" | "CLAIM";

  // Timestamps
  placedTime: number;
  fillTime?: number;
  cancelTime?: number;
  expireTime?: number;
  time: number;                  // Display timestamp

  // Execution & PnL
  fillPrice?: number;
  pnl?: number;
  pnlQuote?: number;
  pnlUsdso?: number;
  reason?: string;
  dryRun?: boolean;
  maker?: boolean;
  isIoc?: boolean;
  targetPrice?: number;          // Target price before slippage (e.g. Trendline, Level price)
  slippagePct?: number;          // Configured slippage percentage at time of order
  limitPrice?: number;           // Limit price sent to exchange (with slippage protection)

  // Gas Tracking & Immediate Buy Compensation
  gasCompBase?: number;
  gasCompSomi?: number;          // Gas compensated back to wallet from this buy (compat)
  gasLossQuote?: number;
  gasLossUsdso?: number;         // Value of compensated gas booked as loss (compat)
  netQty?: number;               // Remaining base asset added to trading lot after gas compensation
  createTxHash?: string;
  createGasBase?: number;
  createGasQuote?: number;
  createGasSomi?: number;
  createGasUsdso?: number;
  cancelTxHash?: string;
  cancelGasBase?: number;
  cancelGasQuote?: number;
  cancelGasSomi?: number;
  cancelGasUsdso?: number;
  fillTxHash?: string;
  txHash?: string;               // Primary/latest txHash
  gasFeeBase?: number;
  gasFeeQuote?: number;
  gasFeeSomi?: number;           // Total gas for this order (create + cancel)
  gasFeeUsdso?: number;
  explorerUrl?: string;
}

// Backward-compatibility aliases
export type TradeRecord = UnifiedOrderRecord;
export type OrderActivityRecord = UnifiedOrderRecord;
export type { TradeRound, TradeRoundSummary, TradeRoundsResult, TradeRoundTrade } from "./trade-rounds.js";

export interface GasLogRecord {
  id: string;
  timestamp: number;
  txHash: string;
  label: string;
  gasUsed: number;
  effectiveGasPriceGwei: number;
  gasBase?: number;
  gasQuote?: number;
  gasSomi: number;
  gasUsdso: number;
  explorerUrl: string;
}

export interface BotDatabaseSchema {
  version: number;
  createdAt: number;
  updatedAt: number;
  state: StrategyStateRecord;
  lockedChannels?: Record<string, LockedChannel>;     // Keyed by `${exchange}:${symbol}`
  statesBySymbol?: Record<string, Partial<StrategyStateRecord>>; // Per-symbol persistent state
  orders: UnifiedOrderRecord[];  // Single Unified Source of Truth
  settings: Record<string, any>;
}

export interface DatabaseOptions {
  dbPath?: string;
  legacyStateFile?: string;
  log?: (msg: string) => void;
}

/**
 * High-performance, ACID-compliant Offline File Database for the Dynamic Grid Bot.
 * Uses a single unified `orders` table to track order lifecycle, fills, PnL, and gas without redundancy.
 */
export class BotDatabase {
  private dbPath: string;
  private settingsPath: string;
  private legacyStateFile: string;
  private log: (msg: string) => void;
  private data: BotDatabaseSchema;
  private isDirty = false;
  private isSettingsDirty = false;
  private flushTimer: NodeJS.Timeout | null = null;
  private maxHistoryRecords = 5000;
  private pendingTxGas = new Map<string, { gasUsed: number; effectiveGasPriceGwei?: number; gasSomi: number; gasUsdso: number }>();

  constructor(opts: DatabaseOptions = {}) {
    this.dbPath = opts.dbPath ? path.resolve(opts.dbPath) : path.resolve(process.cwd(), "grid-state.db.json");
    const dir = path.dirname(this.dbPath);
    this.settingsPath = path.resolve(dir, "settings.db.json");
    this.legacyStateFile = opts.legacyStateFile ? path.resolve(opts.legacyStateFile) : path.resolve(process.cwd(), ".grid-state.json");
    this.log = opts.log || ((msg) => console.log(`[database] ${msg}`));
    this.data = this.initializeDatabase();
    this.loadSeparateSettings();
    this.backfillMissingSellPnl();
    this.cleanupHijackedMakerFills();
    this.cleanupDuplicateExitFills();
    this.cleanupDuplicateTxRecords();
    this.cleanupStaleOpenOrders();
    this.cleanupBinanceCancelledOrders();
    this.reconcileManualTradesPnl();
    this.reconcileHistoricalIocAndGasOrders();
  }

  private loadSeparateSettings(): void {
    if (fs.existsSync(this.settingsPath)) {
      try {
        const raw = fs.readFileSync(this.settingsPath, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          this.data.settings = { ...this.data.settings, ...parsed };
          this.log(`loaded separate settings from ${this.settingsPath}`);
        }
      } catch (err) {
        this.log(`⚠️ failed to read settings file ${this.settingsPath}: ${(err as Error).message}`);
      }
    } else if (Object.keys(this.data.settings).length > 0) {
      // Migrate existing settings to settings.db.json
      this.flushSettingsSync();
    }
  }

  public flushSettingsSync(): void {
    try {
      const deprecatedKeys = [
        "srMinTouchCount",
        "srTouchTolerancePct",
        "enableLaggardSnipe",
        "enableLaggardGuard",
        "laggardThresholdPct",
        "maxInventoryUsdso",
        "maxSessionLossUsdso",
        "requireProfitAboveAvgEntry",
        "tradingTimeframe",
        "trendTimeframe",
      ];
      if (this.data.settings) {
        if (this.data.settings.maxInventoryQuote === undefined && this.data.settings.maxInventoryUsdso !== undefined) {
          this.data.settings.maxInventoryQuote = Number(this.data.settings.maxInventoryUsdso);
        }
        for (const k of deprecatedKeys) {
          delete this.data.settings[k];
        }
      }
      const dir = path.dirname(this.settingsPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const tempPath = `${this.settingsPath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(this.data.settings, null, 2), "utf8");
      fs.renameSync(tempPath, this.settingsPath);
      this.isSettingsDirty = false;
    } catch (err) {
      this.log(`❌ critical: failed to flush settings to disk: ${(err as Error).message}`);
    }
  }

  private getDefaultState(): StrategyStateRecord {
    return {
      lots: [],
      openOrders: [],
      realizedPnl: 0,
      tradeRealizedPnl: 0,
      totalGasDeductedSomi: 0,
      totalGasDeductedUsdso: 0,
      accumulatedGasSomi: 0,
      accumulatedGasUsdso: 0,
      totalGasSpentSomi: 0,
      totalGasSpentUsdso: 0,
      totalTxCount: 0,
      sellOrdersActive: true,
      recentOrders: [],
      lastUpdated: Date.now(),
    };
  }

  private getDefaultSchema(): BotDatabaseSchema {
    return {
      version: 2,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      state: this.getDefaultState(),
      lockedChannels: {},
      statesBySymbol: {},
      orders: [],
      settings: {},
    };
  }

  private initializeDatabase(): BotDatabaseSchema {
    // 1. Check if DB file exists
    if (fs.existsSync(this.dbPath)) {
      try {
        const raw = fs.readFileSync(this.dbPath, "utf8");
        const parsed = JSON.parse(raw) as any;
        if (parsed && typeof parsed.version === "number" && parsed.state) {
          let unifiedOrders: UnifiedOrderRecord[] = [];

          if (Array.isArray(parsed.orders)) {
            unifiedOrders = parsed.orders;
          } else {
            // Migrate from legacy separated tables
            if (Array.isArray(parsed.orderActivity)) {
              for (const ord of parsed.orderActivity) {
                unifiedOrders.push({
                  id: ord.id || `ord_${ord.timestamp || Date.now()}`,
                  orderId: ord.orderId || "",
                  side: ord.side || "BUY",
                  price: Number(ord.price || 0),
                  qty: Number(ord.qty || 0),
                  notionalUsdso: Number(ord.price || 0) * Number(ord.qty || 0),
                  status: ord.status || "OPEN",
                  action: ord.action === "PLACED" ? (ord.side === "BUY" ? "CREATE_BUY" : "CREATE_SELL") : (ord.side === "SELL" ? "CANCEL_SELL" : "CANCEL_BUY"),
                  placedTime: ord.timestamp || Date.now(),
                  time: ord.timestamp || Date.now(),
                  txHash: ord.txHash,
                  createTxHash: ord.action === "PLACED" ? ord.txHash : undefined,
                  cancelTxHash: ord.action === "CANCELLED" ? ord.txHash : undefined,
                  gasFeeSomi: ord.gasSomi || 0,
                  gasFeeUsdso: ord.gasUsdso || 0,
                  reason: ord.reason,
                });
              }
            }
            if (Array.isArray(parsed.trades)) {
              for (const tr of parsed.trades) {
                unifiedOrders.push({
                  id: tr.id || `trade_${tr.timestamp || Date.now()}`,
                  orderId: tr.id || "",
                  side: tr.side || "BUY",
                  price: Number(tr.price || 0),
                  qty: Number(tr.qty || 0),
                  notionalUsdso: Number(tr.costUsdso || (tr.price * tr.qty) || 0),
                  status: "FILLED",
                  action: tr.type === "BUY" ? "BUY_FILL" : tr.type === "SELL" ? "SELL_FILL" : tr.type,
                  placedTime: tr.timestamp || Date.now(),
                  fillTime: tr.timestamp || Date.now(),
                  fillPrice: tr.price,
                  pnlUsdso: tr.pnlUsdso,
                  time: tr.timestamp || Date.now(),
                  txHash: tr.txHash,
                  gasFeeSomi: tr.gasSomi || 0,
                  gasFeeUsdso: tr.gasUsdso || 0,
                  reason: tr.reason,
                });
              }
            }
          }

          this.log(`loaded database from ${this.dbPath} (${unifiedOrders.length} unified orders)`);
          return {
            version: 2,
            createdAt: parsed.createdAt || Date.now(),
            updatedAt: parsed.updatedAt || Date.now(),
            state: { ...this.getDefaultState(), ...parsed.state },
            lockedChannels: parsed.lockedChannels || {},
            statesBySymbol: parsed.statesBySymbol || {},
            orders: unifiedOrders.slice(0, this.maxHistoryRecords),
            settings: parsed.settings || {},
          };
        }
      } catch (err) {
        this.log(`⚠️ corrupt database detected at ${this.dbPath}: ${(err as Error).message}. Checking backup...`);
        const bakPath = `${this.dbPath}.bak`;
        if (fs.existsSync(bakPath)) {
          try {
            const rawBak = fs.readFileSync(bakPath, "utf8");
            const parsedBak = JSON.parse(rawBak);
            this.log(`✅ successfully restored database from backup ${bakPath}`);
            return parsedBak;
          } catch (bakErr) {
            this.log(`failed to recover from backup: ${(bakErr as Error).message}`);
          }
        }
      }
    }

    // 2. Brand new database
    const schema = this.getDefaultSchema();
    this.data = schema;
    this.flushSync();
    return schema;
  }

  /**
   * Atomic Flush to disk using temp file + rename to guarantee ACID durability.
   */
  public flushSync(): void {
    try {
      this.data.updatedAt = Date.now();
      const dir = path.dirname(this.dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const tempPath = `${this.dbPath}.tmp`;
      const bakPath = `${this.dbPath}.bak`;
      const payload = JSON.stringify(this.data, null, 2);

      // Write to temp file
      fs.writeFileSync(tempPath, payload, "utf8");

      // Backup existing database before overwriting
      if (fs.existsSync(this.dbPath)) {
        try {
          fs.copyFileSync(this.dbPath, bakPath);
        } catch {
          // ignore backup copy failure
        }
      }

      // Atomic rename
      fs.renameSync(tempPath, this.dbPath);
      this.isDirty = false;
    } catch (err) {
      this.log(`❌ critical: failed to flush database to disk: ${(err as Error).message}`);
    }
  }

  /** Schedule a debounced flush if not already pending */
  private scheduleFlush(): void {
    this.isDirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (this.isDirty) {
        this.flushSync();
      }
    }, 1000);
  }

  /**
   * Automatically backfills missing PnL for historical SELL fills using chronological buy cost.
   * Ensures UI and trade history never have undefined or missing PnL values.
   */
  public backfillMissingSellPnl(): void {
    if (!this.data || !Array.isArray(this.data.orders) || this.data.orders.length === 0) return;

    let modified = false;

    const inferBase = (o: UnifiedOrderRecord): string => {
      const p = Number(o.fillPrice || o.price || 0);
      const isSomnia = Boolean(
        o.explorerUrl?.includes("somnia") ||
        (o.txHash && o.txHash.startsWith("0x")) ||
        (o.createTxHash && o.createTxHash.startsWith("0x")) ||
        (o.fillTxHash && o.fillTxHash.startsWith("0x"))
      );
      if (p > 50_000) return "WBTC";
      if (p > 500 && p <= 50_000) return (isSomnia ? "WETH" : (this.data.settings?.exchange === "binance" ? "ETH" : "WETH"));
      if (p >= 50 && p <= 300) return "SOL";
      if (p > 0.01 && p < 10.0) return "SOMI";

      if (o.symbol) {
        const s = o.symbol.toUpperCase();
        if (s.includes("WBTC") || s.includes("BTC")) return "WBTC";
        if (s.includes("WETH") || s.includes("ETH")) return (isSomnia ? "WETH" : (this.data.settings?.exchange === "binance" ? "ETH" : "WETH"));
        if (s.includes("SOL")) return "SOL";
        if (s.includes("SOMI")) return "SOMI";
      }

      if (o.baseAsset) return o.baseAsset.toUpperCase();
      return "DEFAULT";
    };

    // 1. Align pnl, pnlQuote, and pnlUsdso if one is present, and backfill inferred baseAsset
    for (const o of this.data.orders) {
      const p = Number(o.fillPrice || o.price || 0);
      const isSomnia = Boolean(
        o.explorerUrl?.includes("somnia") ||
        (o.txHash && o.txHash.startsWith("0x")) ||
        (o.createTxHash && o.createTxHash.startsWith("0x")) ||
        (o.fillTxHash && o.fillTxHash.startsWith("0x")) ||
        (p > 0.01 && p < 10.0)
      );

      // Self-Healing: Repair any SOMI orders that were mistakenly marked as ETH / ETHFDUSD
      if (p > 0.01 && p < 10.0) {
        if (o.baseAsset !== "SOMI" || o.symbol !== "SOMI:USDSO" || o.quoteAsset !== "USDSO") {
          o.baseAsset = "SOMI";
          o.quoteAsset = "USDSO";
          o.symbol = "SOMI:USDSO";
          modified = true;
        }
      }

      // Repair orders wrongly tagged as WETH:USDSO that were actually executed on Binance (no Somnia tx/explorer, price in ETH range)
      const isTrueBinanceOrder = !isSomnia && p > 500 && p <= 50_000 && Boolean(o.orderId && /^\d{8,}$/.test(o.orderId) && !o.orderId.startsWith("0x"));
      if (isTrueBinanceOrder && (o.symbol === "WETH:USDSO" || o.quoteAsset === "USDSO")) {
        o.symbol = "ETHFDUSD";
        o.baseAsset = "ETH";
        o.quoteAsset = "FDUSD";
        modified = true;
      }
      if (!o.baseAsset) {
        const inferred = inferBase(o);
        if (inferred !== "DEFAULT") {
          o.baseAsset = inferred;
          const isBinance = this.data.settings?.exchange === "binance";
          const defaultQuote = isBinance
            ? (this.data.settings?.symbol?.includes("FDUSD") ? "FDUSD" : "USDT")
            : "USDSO";
          o.quoteAsset = o.quoteAsset || defaultQuote;
          o.symbol = o.symbol || (isBinance ? `${inferred}${o.quoteAsset}` : `${inferred}:${o.quoteAsset}`);
          modified = true;
        }
      }
      const existingPnl = o.pnlQuote !== undefined ? o.pnlQuote : o.pnl !== undefined ? o.pnl : o.pnlUsdso;
      if (existingPnl !== undefined) {
        if (o.pnlQuote === undefined) { o.pnlQuote = existingPnl; modified = true; }
        if (o.pnl === undefined) { o.pnl = existingPnl; modified = true; }
        if (o.pnlUsdso === undefined) { o.pnlUsdso = existingPnl; modified = true; }
      }
      const existingNotional = o.notionalQuote !== undefined ? o.notionalQuote : o.notional !== undefined ? o.notional : o.notionalUsdso;
      if (existingNotional !== undefined) {
        if (o.notionalQuote === undefined) { o.notionalQuote = existingNotional; modified = true; }
        if (o.notional === undefined) { o.notional = existingNotional; modified = true; }
        if (o.notionalUsdso === undefined) { o.notionalUsdso = existingNotional; modified = true; }
      }
    }

    // 2. Chronologically reconstruct inventory PER ASSET to compute missing PnL and repair cross-symbol corrupted PnLs
    const fills = this.data.orders
      .filter(
        (o) =>
          (o.status === "FILLED" ||
            ["BUY_FILL", "SELL_FILL", "TAKE_PROFIT", "CUT", "EXIT"].includes(o.action)) &&
          !o.action?.startsWith("CANCEL"),
      )
      .slice()
      .sort((a, b) => (a.time || a.placedTime || 0) - (b.time || b.placedTime || 0));

    const invByAsset = new Map<string, { qty: number; cost: number }>();

    for (const f of fills) {
      const assetKey = inferBase(f);
      const state = invByAsset.get(assetKey) || { qty: 0, cost: 0 };
      const isBuy = f.side === "BUY" || f.action === "BUY_FILL" || f.action === "SNIPE_BUY";
      const qty = Number(f.qty || 0);
      const price = Number(f.fillPrice || f.price || 0);

      if (isBuy) {
        state.qty += qty;
        state.cost += qty * price;
      } else {
        const avgBuyPrice = state.qty > 0 ? state.cost / state.qty : price;
        const calcPnl = (price - avgBuyPrice) * qty;
        const notional = Number(f.notionalQuote || f.notionalUsdso || qty * price || 0);
        const existingPnl = f.pnlQuote ?? f.pnl ?? f.pnlUsdso;

        // Repair if PnL is missing OR if historical cross-symbol contamination caused an impossible loss (> 50% of notional on a normal grid trade)
        const isCorruptedCrossSymbolPnl =
          existingPnl !== undefined &&
          notional > 0 &&
          Math.abs(existingPnl) > notional * 0.5 &&
          Math.abs(calcPnl) < notional * 0.25;

        if ((existingPnl === undefined) || isCorruptedCrossSymbolPnl) {
          f.pnl = calcPnl;
          f.pnlQuote = calcPnl;
          f.pnlUsdso = calcPnl;
          modified = true;
        }

        const soldRatio = state.qty > 0 ? Math.min(1, qty / state.qty) : 1;
        state.qty = Math.max(0, state.qty - qty);
        state.cost = Math.max(0, state.cost * (1 - soldRatio));
      }
      invByAsset.set(assetKey, state);
    }

    if (modified) {
      this.isDirty = true;
      this.flushSync();
      this.log("✅ automatically backfilled & repaired per-symbol PnL for historical sell orders");
    }
  }

  /**
   * Self-healing migration: revert any resting maker orders that were falsely marked
   * "FILLED" because an IOC taker execution shared the same transaction hash or collided by price.
   */
  public cleanupHijackedMakerFills(): void {
    if (!this.data || !Array.isArray(this.data.orders) || this.data.orders.length === 0) return;

    // Collect all txHashes that belong to genuine IOC / Taker fills
    const iocTxHashes = new Set<string>();
    for (const o of this.data.orders) {
      const isIoc = Boolean(
        o.levelDesc?.startsWith("IOC") ||
        o.levelDesc?.includes("[IOC") ||
        o.reason?.includes("IOC") ||
        o.action === "SNIPE_BUY" ||
        o.action === "SNIPE_SELL"
      );
      if (isIoc && o.txHash) {
        iocTxHashes.add(o.txHash.toLowerCase());
      }
    }

    let modified = false;
    for (const o of this.data.orders) {
      const isMaker = Boolean(
        !o.levelDesc?.startsWith("IOC") &&
        !o.levelDesc?.includes("[IOC") &&
        !o.reason?.includes("IOC") &&
        (o.levelDesc?.includes("Buy Level") || o.levelDesc?.includes("Sell Target") || o.levelDesc?.includes("TL Support"))
      );
      // If a resting maker order is FILLED with the exact same txHash as an IOC execution, it was hijacked!
      if (isMaker && o.status === "FILLED" && o.txHash && iocTxHashes.has(o.txHash.toLowerCase())) {
        o.status = "CANCELLED";
        o.action = o.side === "BUY" ? "CANCEL_BUY" : "CANCEL_SELL";
        o.reason = "Cancelled: Falsely marked filled by IOC tx sharing same hash";
        delete o.fillTime;
        delete o.fillPrice;
        delete o.fillTxHash;
        modified = true;
      }
    }

    if (modified) {
      this.log("🧹 Repaired database: reverted falsely filled maker order(s) colliding with IOC transactions");
      this.flushSync();
    }
  }

  /**
   * Cleans up duplicate SELL_FILL records that share the same orderId or txHash
   * with a CUT or TAKE_PROFIT record (from WS race conditions).
   */
  public cleanupDuplicateExitFills(): void {
    if (!this.data || !Array.isArray(this.data.orders) || this.data.orders.length === 0) return;

    const exitOrderIds = new Set<string>();
    const exitTxHashes = new Set<string>();

    for (const o of this.data.orders) {
      if (o.action === "CUT" || o.action === "TAKE_PROFIT") {
        if (o.orderId && !o.orderId.startsWith("ord_")) exitOrderIds.add(o.orderId);
        if (o.txHash) exitTxHashes.add(o.txHash);
      }
    }

    if (exitOrderIds.size === 0 && exitTxHashes.size === 0) return;

    const beforeLen = this.data.orders.length;
    this.data.orders = this.data.orders.filter((o) => {
      if (o.action === "SELL_FILL") {
        const isDupOrderId = Boolean(o.orderId && exitOrderIds.has(o.orderId));
        const isDupTx = Boolean(o.txHash && exitTxHashes.has(o.txHash));
        if (isDupOrderId || isDupTx) {
          return false; // Remove spurious SELL_FILL duplicate!
        }
      }
      return true;
    });

    if (this.data.orders.length !== beforeLen) {
      this.log(`🧹 [cleanup] Purged ${beforeLen - this.data.orders.length} duplicate SELL_FILL record(s) matching CUT/TAKE_PROFIT orders`);
      this.flushSync();
    }
  }

  /**
   * Deduplicates records that share the exact same on-chain transaction hash.
   * Merges metadata (keeping bot levelDesc and linking on-chain orderId).
   */
  public cleanupDuplicateTxRecords(): void {
    if (!this.data || !Array.isArray(this.data.orders) || this.data.orders.length === 0) return;

    const seenTx = new Map<string, UnifiedOrderRecord>();
    const toRemove = new Set<UnifiedOrderRecord>();

    for (const o of this.data.orders) {
      const tx = (o.txHash || o.fillTxHash || o.createTxHash || "").trim().toLowerCase();
      if (!tx || !tx.startsWith("0x") || tx.length < 10) continue;

      const existing = seenTx.get(tx);
      if (existing) {
        // We have a duplicate record with the same txHash!
        // Merge them: keep the richer record
        if (!existing.orderId || existing.orderId.startsWith("ord_")) {
          if (o.orderId && !o.orderId.startsWith("ord_")) existing.orderId = o.orderId;
        }
        if (!existing.levelDesc || existing.levelDesc.includes("Market (IOC)")) {
          if (o.levelDesc && !o.levelDesc.includes("Market (IOC)")) existing.levelDesc = o.levelDesc;
        }
        if (existing.status !== "FILLED" && o.status === "FILLED") {
          existing.status = "FILLED";
          existing.action = o.action;
          existing.fillPrice = o.fillPrice || o.price;
          existing.fillTime = o.fillTime || o.time;
        }
        toRemove.add(o);
      } else {
        seenTx.set(tx, o);
      }
    }

    if (toRemove.size > 0) {
      const beforeLen = this.data.orders.length;
      this.data.orders = this.data.orders.filter((o) => !toRemove.has(o));
      this.log(`🧹 [cleanup] Deduplicated ${beforeLen - this.data.orders.length} record(s) sharing identical on-chain txHash`);
      this.flushSync();
    }
  }

  /**
   * Marks stale OPEN orders in db.orders as CANCELLED on startup when expired or when in IOC_BRACKET mode.
   */
  public cleanupStaleOpenOrders(): void {
    if (!this.data || !Array.isArray(this.data.orders) || this.data.orders.length === 0) return;
    const now = Date.now();
    const isIocMode = (this.data.settings?.orderExecutionMode || "IOC_BRACKET") === "IOC_BRACKET";
    let cleaned = 0;

    for (const o of this.data.orders) {
      if (o.status === "OPEN") {
        const isExpired = o.expireTime !== undefined && o.expireTime > 0 && now > o.expireTime;
        const isVeryOld = o.placedTime > 0 && (now - o.placedTime) > 24 * 3600 * 1000;
        if (isExpired || isVeryOld || isIocMode) {
          o.status = "CANCELLED";
          o.cancelTime = o.cancelTime || now;
          o.action = o.side === "SELL" ? "CANCEL_SELL" : "CANCEL_BUY";
          o.reason = o.reason || (isExpired ? "Expired open order cleaned up" : "Stale resting order reconciled (0 open on exchange)");
          cleaned++;
        }
      }
    }

    if (cleaned > 0) {
      this.log(`🧹 [cleanup] Marked ${cleaned} stale OPEN order(s) in database as CANCELLED`);
      this.flushSync();
    }
  }

  /**
   * Prunes cancelled orders that do not have on-chain gas expenditure (e.g. Binance CEX cancelled orders).
   */
  public cleanupBinanceCancelledOrders(): void {
    if (!this.data || !Array.isArray(this.data.orders) || this.data.orders.length === 0) return;
    const isBinance = this.data.settings?.exchange === "binance";
    const beforeLen = this.data.orders.length;
    this.data.orders = this.data.orders.filter((o) => {
      const isCancelled = o.status === "CANCELLED" || o.action === "CANCEL_BUY" || o.action === "CANCEL_SELL";
      if (!isCancelled) return true;
      const hasGas = Boolean(
        o.gasFeeSomi ||
        o.gasFeeUsdso ||
        o.gasFeeBase ||
        o.gasFeeQuote ||
        (o.txHash && typeof o.txHash === "string" && o.txHash.startsWith("0x"))
      );
      if (isBinance || !hasGas) {
        return false; // Prune cancelled order without gas expenditure
      }
      return true;
    });

    if (this.data.orders.length !== beforeLen) {
      this.log(`🧹 [cleanup] Purged ${beforeLen - this.data.orders.length} cancelled order(s) without gas fees (CEX cleanup)`);
      this.flushSync();
    }
  }

  /**
   * Retrospectively reconciles past order logs in db.orders:
   * 1. Restores missing gas compensation fields (gasCompSomi, gasCompBase, gasLossQuote, netQty) from trade reasons.
   * 2. Backfills IOC telemetry (isIoc, targetPrice, slippagePct, limitPrice) for historical IOC/Exit orders.
   */
  public reconcileHistoricalIocAndGasOrders(): { reconciledIocCount: number; reconciledGasCount: number } {
    if (!this.data || !Array.isArray(this.data.orders) || this.data.orders.length === 0) {
      return { reconciledIocCount: 0, reconciledGasCount: 0 };
    }

    let reconciledIocCount = 0;
    let reconciledGasCount = 0;
    const defaultSlippage = typeof this.data.settings?.iocSlippagePct === "number" ? this.data.settings.iocSlippagePct : 0.2;

    for (const order of this.data.orders) {
      let changed = false;

      // ── 1. Reconcile Historical Gas Compensation ──────────────────────────
      if (order.gasCompSomi === undefined || order.gasCompSomi === null) {
        const fullText = `${order.reason || ""} ${order.levelDesc || ""}`;
        const gasMatch = fullText.match(/(?:Comp(?:ensated)?|Gas Comp):\s*([\d.]+)/i);
        if (gasMatch && gasMatch[1]) {
          const comp = parseFloat(gasMatch[1]);
          if (!isNaN(comp) && comp > 0) {
            order.gasCompSomi = comp;
            order.gasCompBase = comp;
            order.gasLossUsdso = comp * (order.price || 0);
            order.gasLossQuote = order.gasLossUsdso;
            if (order.netQty === undefined && order.qty) {
              order.netQty = Math.max(0, order.qty - comp);
            }
            reconciledGasCount++;
            changed = true;
          }
        }
      }

      // ── 2. Reconcile Historical IOC Orders Telemetry ──────────────────────
      const isIoc = Boolean(
        order.isIoc ||
        order.maker === false ||
        order.levelDesc?.startsWith("IOC") ||
        order.levelDesc?.includes("[IOC") ||
        order.levelDesc?.toLowerCase().includes("ioc") ||
        order.reason?.toLowerCase().includes("ioc") ||
        ["CUT", "TAKE_PROFIT", "CUT_LOSS", "EXIT", "SNIPE_BUY", "SNIPE_SELL"].includes(order.action || "")
      );

      if (isIoc) {
        if (!order.isIoc) {
          order.isIoc = true;
          changed = true;
        }

        if (order.slippagePct === undefined) {
          order.slippagePct = defaultSlippage;
          changed = true;
        }

        if (order.targetPrice === undefined) {
          const fullText = `${order.levelDesc || ""} ${order.reason || ""}`;
          const targetMatch = fullText.match(/Target:\s*\$?([\d.]+)/i);
          if (targetMatch && targetMatch[1]) {
            order.targetPrice = parseFloat(targetMatch[1]);
            changed = true;
          } else if (order.price && order.price > 0) {
            order.targetPrice = order.price;
            changed = true;
          }
        }

        if (order.limitPrice === undefined && order.targetPrice !== undefined) {
          const slip = (order.slippagePct ?? defaultSlippage) / 100;
          const tick = 0.0001;
          const isBuy = order.side === "BUY" || (order.action || "").includes("BUY");
          if (isBuy) {
            const rawLimit = order.targetPrice * (1 + slip);
            order.limitPrice = Math.round(rawLimit / tick) * tick;
          } else {
            const rawLimit = order.targetPrice * (1 - slip);
            order.limitPrice = Math.round(rawLimit / tick) * tick;
          }
          changed = true;
        }

        if (changed) {
          reconciledIocCount++;
        }
      }
    }

    if (reconciledIocCount > 0 || reconciledGasCount > 0) {
      this.log(`🔄 [reconcile] Restored ${reconciledIocCount} historical IOC orders & ${reconciledGasCount} gas compensation records in database`);
      this.scheduleFlush();
    }

    return { reconciledIocCount, reconciledGasCount };
  }

  /**
   * Synchronizes OPEN records in db.orders with the authoritative set of active orderIds from the exchange.
   */
  public reconcileOpenOrdersWithExchange(liveOrderIds: Set<string>, activeSymbol?: string): number {
    if (!this.data || !Array.isArray(this.data.orders)) return 0;
    const now = Date.now();
    let updated = 0;
    for (const o of this.data.orders) {
      if (o.status === "OPEN") {
        if (!o.orderId || !liveOrderIds.has(String(o.orderId))) {
          // Allow 15s grace period for newly placed orders
          if (now - (o.placedTime || o.time || 0) > 15_000) {
            o.status = "CANCELLED";
            o.cancelTime = now;
            o.action = o.side === "SELL" ? "CANCEL_SELL" : "CANCEL_BUY";
            o.reason = o.reason || "Order no longer open on exchange (reconciled)";
            updated++;
          }
        }
      }
    }
    if (updated > 0) {
      this.scheduleFlush();
    }
    return updated;
  }

  /**
   * Authoritatively reconcile open orders in the database against the Somnia Markets GraphQL Indexer.
   * Any orders in db.orders marked as OPEN that are not active on DreamDEX are updated to their
   * genuine status (CANCELLED, FILLED, or EXPIRED).
   */
  public async reconcileWithIndexer(
    indexer: { getOrdersByIds: (pool: string, ids: string[]) => Promise<Map<string, any>> },
    poolAddress: string,
  ): Promise<{ reconciled: number; open: number; cancelled: number; filled: number }> {
    if (!this.data || !Array.isArray(this.data.orders)) return { reconciled: 0, open: 0, cancelled: 0, filled: 0 };
    const openOrders = this.data.orders.filter((o) => o.status === "OPEN" && o.orderId && !o.orderId.startsWith("ord_"));
    if (openOrders.length === 0) return { reconciled: 0, open: 0, cancelled: 0, filled: 0 };

    const ids = openOrders.map((o) => o.orderId!);
    let cancelled = 0;
    let filled = 0;
    let open = 0;
    let modified = false;

    for (let i = 0; i < ids.length; i += 50) {
      const chunkIds = ids.slice(i, i + 50);
      try {
        const resultMap = await indexer.getOrdersByIds(poolAddress, chunkIds);
        for (const o of openOrders.slice(i, i + 50)) {
          const indexed = resultMap.get(o.orderId!);
          if (!indexed) {
            // Not found on GraphQL indexer
            o.status = "CANCELLED";
            o.action = o.side === "BUY" ? "CANCEL_BUY" : "CANCEL_SELL";
            o.reason = "Reconciled with GraphQL: Not found on-chain";
            cancelled++;
            modified = true;
          } else if (indexed.status === "Open") {
            open++;
          } else if (indexed.status === "Filled") {
            o.status = "FILLED";
            o.action = o.side === "BUY" ? "BUY_FILL" : "SELL_FILL";
            o.fillTime = indexed.placedAtTimestamp ? indexed.placedAtTimestamp * 1000 : o.placedTime;
            o.fillPrice = indexed.price;
            o.fillTxHash = indexed.placedTxHash;
            filled++;
            modified = true;
          } else {
            o.status = "CANCELLED";
            o.action = o.side === "BUY" ? "CANCEL_BUY" : "CANCEL_SELL";
            o.reason = `Reconciled with GraphQL: ${indexed.status}`;
            cancelled++;
            modified = true;
          }
        }
      } catch (err) {
        this.log(`⚠️ [reconcileWithIndexer] chunk reconciliation failed: ${(err as Error).message}`);
      }
    }

    if (open === 0 && Array.isArray(this.data.state.openOrders) && this.data.state.openOrders.length > 0) {
      this.data.state.openOrders = [];
      modified = true;
    }

    if (modified) {
      this.isDirty = true;
      this.flushSync();
      this.log(`🔄 Reconciled database with GraphQL: ${cancelled} cancelled, ${filled} filled, ${open} still open`);
    }

    return { reconciled: openOrders.length, open, cancelled, filled };
  }

  /**
   * Sync recent on-chain order history from Somnia Markets GraphQL Indexer into the database.
   * Backfills any trades executed externally or while the bot was offline.
   */
  public async syncRecentOrdersFromIndexer(
    indexer: { getRecentOrders: (owner: string, pool?: string, limit?: number) => Promise<any[]> },
    owner: string,
    poolAddress?: string,
    limit = 50,
  ): Promise<number> {
    if (!this.data || !Array.isArray(this.data.orders)) return 0;
    try {
      const recent = await indexer.getRecentOrders(owner, poolAddress, limit);
      if (!recent || recent.length === 0) return 0;

      let syncedCount = 0;
      let modified = false;

      for (const ro of recent) {
        if (!ro.orderId) continue;
        const roTx = (ro.placedTxHash || "").trim().toLowerCase();
        const existing = this.data.orders.find(
          (o) =>
            o.orderId === ro.orderId ||
            (roTx && (
              (o.txHash && o.txHash.toLowerCase() === roTx) ||
              (o.fillTxHash && o.fillTxHash.toLowerCase() === roTx) ||
              (o.createTxHash && o.createTxHash.toLowerCase() === roTx)
            )),
        );
        const side: "BUY" | "SELL" = ro.isBid ? "BUY" : "SELL";
        const isFilled = ro.status === "Filled";
        const isCancelled = ro.status === "Cancelled" || ro.status === "Expired";
        const status = isFilled ? "FILLED" : isCancelled ? "CANCELLED" : "OPEN";
        const action = isFilled
          ? (ro.isBid ? "BUY_FILL" : "SELL_FILL")
          : isCancelled
          ? (ro.isBid ? "CANCEL_BUY" : "CANCEL_SELL")
          : (ro.isBid ? "CREATE_BUY" : "CREATE_SELL");
        const time = ro.placedAtTimestamp ? ro.placedAtTimestamp * 1000 : Date.now();

        if (existing) {
          let updatedThis = false;
          // Link on-chain orderId if existing was recorded before contract orderId was known
          if (!existing.orderId || existing.orderId.startsWith("ord_") || existing.orderId.startsWith("0x")) {
            existing.orderId = ro.orderId;
            updatedThis = true;
          }
          if (existing.status !== status || (isFilled && !existing.fillTime)) {
            existing.status = status;
            existing.action = action;
            if (isFilled) {
              existing.fillPrice = ro.price;
              existing.fillTime = time;
              if (ro.placedTxHash) existing.fillTxHash = ro.placedTxHash;
            } else if (isCancelled && !existing.reason) {
              existing.reason = `Reconciled with GraphQL: ${ro.status}`;
            }
            if (ro.placedTxHash) existing.txHash = ro.placedTxHash;
            updatedThis = true;
          }
          if (updatedThis) {
            modified = true;
            syncedCount++;
          }
        } else {
          // New order found on GraphQL that wasn't in DB: insert it!
          const qty = ro.filledQuantity || ro.fullQuantity || 0;
          const notionalUsdso = ro.price * qty;
          const newRecord: UnifiedOrderRecord = {
            id: `ord_${time}_${ro.orderId.slice(-5)}`,
            orderId: ro.orderId,
            side,
            price: ro.price,
            qty,
            notionalUsdso,
            levelDesc: ro.rested ? `${side} Limit (Maker)` : `${side} Market (IOC)`,
            status,
            action,
            placedTime: time,
            time,
            txHash: ro.placedTxHash,
            createTxHash: ro.placedTxHash,
            fillTxHash: isFilled ? ro.placedTxHash : undefined,
            fillTime: isFilled ? time : undefined,
            fillPrice: isFilled ? ro.price : undefined,
            explorerUrl: ro.placedTxHash ? `https://explorer.somnia.network/tx/${ro.placedTxHash}` : undefined,
          };
          this.data.orders.push(newRecord);
          modified = true;
          syncedCount++;
        }
      }

      if (modified) {
        this.isDirty = true;
        this.flushSync();
        this.log(`📥 Synced ${syncedCount} recent orders from Somnia Markets GraphQL Indexer into database`);
      }
      return syncedCount;
    } catch (err) {
      this.log(`⚠️ [syncRecentOrdersFromIndexer] failed: ${(err as Error).message}`);
      return 0;
    }
  }

  // ── Strategy State CRUD ───────────────────────────────────────────────────

  public getState(symbolKey?: string): StrategyStateRecord {
    if (symbolKey && this.data.statesBySymbol && this.data.statesBySymbol[symbolKey]) {
      return { ...this.data.state, ...this.data.statesBySymbol[symbolKey] };
    }
    return { ...this.data.state };
  }

  public saveState(state: Partial<StrategyStateRecord>, immediate = false, symbolKey?: string): void {
    this.data.state = {
      ...this.data.state,
      ...state,
      lastUpdated: Date.now(),
    };
    if (symbolKey) {
      if (!this.data.statesBySymbol) {
        this.data.statesBySymbol = {};
      }
      this.data.statesBySymbol[symbolKey] = {
        ...(this.data.statesBySymbol[symbolKey] || {}),
        ...state,
        lastUpdated: Date.now(),
      };
    }
    if (immediate) {
      this.flushSync();
    } else {
      this.scheduleFlush();
    }
  }

  public getLockedChannel(symbolKey?: string): LockedChannel | undefined {
    if (symbolKey && this.data.lockedChannels && this.data.lockedChannels[symbolKey]) {
      return this.data.lockedChannels[symbolKey];
    }
    return this.data.state.lockedChannel;
  }

  public saveLockedChannel(symbolKey: string, channel: LockedChannel | undefined): void {
    if (!this.data.lockedChannels) {
      this.data.lockedChannels = {};
    }
    if (channel) {
      this.data.lockedChannels[symbolKey] = channel;
    } else {
      delete this.data.lockedChannels[symbolKey];
    }
    this.data.state.lockedChannel = channel;
    this.scheduleFlush();
  }

  // ── Unified Order Recording & Lifecycle Management ────────────────────────

  public recordEvent(eventData: any): UnifiedOrderRecord {
    let action = eventData.action as UnifiedOrderRecord["action"];
    if ((action as any) === "BUY") action = "BUY_FILL";
    if ((action as any) === "SELL") action = "SELL_FILL";
    const now = eventData.time || Date.now();
    const side: "BUY" | "SELL" = eventData.side || (action?.includes("BUY") ? "BUY" : "SELL");
    const price = Number(eventData.price || 0);
    const qty = Number(eventData.qty || 0);
    const notionalQuote = Number(eventData.notionalQuote || eventData.notionalUsdso || eventData.notional || (price * qty) || 0);
    const notionalUsdso = notionalQuote;
    const pnlVal = eventData.pnlQuote !== undefined ? eventData.pnlQuote : eventData.pnl !== undefined ? eventData.pnl : eventData.pnlUsdso;
    const orderId = eventData.orderId ? String(eventData.orderId) : (action.startsWith("CREATE_") ? `ord_${now}` : "");

    const isBinance = this.data.settings?.exchange === "binance";
    const targetSymbol = eventData.symbol || this.data.settings?.symbol;
    const targetBase = eventData.baseAsset || this.data.state?.baseAsset;
    const defaultQuote = isBinance
      ? (targetSymbol?.includes("FDUSD") ? "FDUSD" : targetSymbol?.includes("USDT") ? "USDT" : "USDSO")
      : "USDSO";
    const targetQuote = eventData.quoteAsset || this.data.state?.quoteAsset || defaultQuote;

    const isIoc = Boolean(
      eventData.isIoc ||
      eventData.maker === false ||
      eventData.levelDesc?.startsWith("IOC") ||
      eventData.levelDesc?.includes("[IOC") ||
      eventData.reason?.includes("IOC")
    );
    const targetPrice = eventData.targetPrice !== undefined ? Number(eventData.targetPrice) : undefined;
    const slippagePct = eventData.slippagePct !== undefined ? Number(eventData.slippagePct) : undefined;
    const limitPrice = eventData.limitPrice !== undefined ? Number(eventData.limitPrice) : undefined;

    let record: UnifiedOrderRecord;

    if (action === "CREATE_BUY" || action === "CREATE_SELL") {
      // Prevent duplicate open records if the same on-chain orderId already exists
      const existing = orderId && !orderId.startsWith("ord_")
        ? this.data.orders.find((o) => o.orderId === orderId && o.status === "OPEN")
        : undefined;
      if (existing) {
        existing.price = price;
        existing.qty = qty;
        existing.notionalQuote = notionalQuote;
        existing.notionalUsdso = notionalUsdso;
        existing.time = now;
        if (eventData.txHash) existing.txHash = eventData.txHash;
        if (!existing.symbol && targetSymbol) existing.symbol = targetSymbol;
        if (!existing.baseAsset && targetBase) existing.baseAsset = targetBase;
        if (!existing.quoteAsset && targetQuote) existing.quoteAsset = targetQuote;
        return existing;
      }
      record = {
        id: `ord_${now}_${Math.random().toString(36).slice(2, 7)}`,
        orderId,
        side,
        price,
        qty,
        notionalQuote,
        notionalUsdso,
        levelDesc: eventData.levelDesc,
        status: "OPEN",
        action,
        placedTime: now,
        expireTime: eventData.expireTime,
        time: now,
        createTxHash: eventData.txHash,
        txHash: eventData.txHash,
        dryRun: eventData.dryRun,
        explorerUrl: eventData.txHash ? `https://explorer.somnia.network/tx/${eventData.txHash}` : undefined,
        symbol: targetSymbol,
        baseAsset: targetBase,
        quoteAsset: targetQuote,
      };
      this.data.orders.unshift(record);
    } else if (action === "BUY_FILL" || action === "SELL_FILL") {
      const isIocOrder = Boolean(
        eventData.isIoc ||
        eventData.maker === false ||
        eventData.levelDesc?.startsWith("IOC") ||
        eventData.levelDesc?.includes("[IOC") ||
        eventData.reason?.includes("IOC")
      );

      // Check if this orderId or txHash is ALREADY recorded as FILLED (e.g. CUT, TAKE_PROFIT, or prior FILL)
      const evTx = (eventData.txHash || "").trim().toLowerCase();
      const existingFilled = this.data.orders.find(
        (o) =>
          o.status === "FILLED" && (
            (orderId && !orderId.startsWith("ord_") && o.orderId === orderId) ||
            (evTx && (
              (o.txHash && o.txHash.toLowerCase() === evTx) ||
              (o.fillTxHash && o.fillTxHash.toLowerCase() === evTx) ||
              (o.createTxHash && o.createTxHash.toLowerCase() === evTx)
            ))
          ),
      );

      if (existingFilled) {
        // Link on-chain orderId if known
        if (orderId && !orderId.startsWith("ord_") && (!existingFilled.orderId || existingFilled.orderId.startsWith("ord_"))) {
          existingFilled.orderId = orderId;
        }
        if (eventData.txHash && !existingFilled.txHash) existingFilled.txHash = eventData.txHash;
        if (eventData.txHash && !existingFilled.fillTxHash) existingFilled.fillTxHash = eventData.txHash;
        if (!existingFilled.symbol && targetSymbol) existingFilled.symbol = targetSymbol;
        if (!existingFilled.baseAsset && targetBase) existingFilled.baseAsset = targetBase;
        if (!existingFilled.quoteAsset && targetQuote) existingFilled.quoteAsset = targetQuote;
        if (isIoc) existingFilled.isIoc = true;
        if (targetPrice !== undefined) existingFilled.targetPrice = targetPrice;
        if (slippagePct !== undefined) existingFilled.slippagePct = slippagePct;
        if (limitPrice !== undefined) existingFilled.limitPrice = limitPrice;
        if (eventData.gasCompBase !== undefined) existingFilled.gasCompBase = Number(eventData.gasCompBase);
        if (eventData.gasCompSomi !== undefined) existingFilled.gasCompSomi = Number(eventData.gasCompSomi);
        if (eventData.gasLossQuote !== undefined) existingFilled.gasLossQuote = Number(eventData.gasLossQuote);
        if (eventData.gasLossUsdso !== undefined) existingFilled.gasLossUsdso = Number(eventData.gasLossUsdso);
        if (eventData.netQty !== undefined) existingFilled.netQty = Number(eventData.netQty);
        return existingFilled;
      }

      // In IOC mode, orders are immediate taker executions and NEVER match resting maker orders
      const existing = !isIocOrder
        ? this.data.orders.find(
            (o) =>
              o.status === "OPEN" &&
              (orderId
                ? o.orderId === orderId
                : eventData.dryRun && o.side === side && Math.abs(o.price - price) / price <= 0.001),
          )
        : undefined;
      if (existing) {
        existing.status = "FILLED";
        existing.fillTime = now;
        existing.fillPrice = price;
        existing.action = action;
        existing.time = now;
        existing.fillTxHash = eventData.txHash;
        existing.pnl = pnlVal;
        existing.pnlQuote = pnlVal;
        existing.pnlUsdso = pnlVal;
        if (eventData.txHash) existing.txHash = eventData.txHash;
        if (!existing.symbol && targetSymbol) existing.symbol = targetSymbol;
        if (!existing.baseAsset && targetBase) existing.baseAsset = targetBase;
        if (!existing.quoteAsset && targetQuote) existing.quoteAsset = targetQuote;
        record = existing;
      } else {
        record = {
          id: `fill_${now}_${Math.random().toString(36).slice(2, 7)}`,
          orderId,
          side,
          price,
          qty,
          notionalQuote,
          notionalUsdso,
          levelDesc: eventData.levelDesc,
          status: "FILLED",
          action,
          placedTime: now,
          fillTime: now,
          fillPrice: price,
          pnl: pnlVal,
          pnlQuote: pnlVal,
          pnlUsdso: pnlVal,
          time: now,
          fillTxHash: eventData.txHash,
          txHash: eventData.txHash,
          dryRun: eventData.dryRun,
          explorerUrl: eventData.txHash ? `https://explorer.somnia.network/tx/${eventData.txHash}` : undefined,
          symbol: targetSymbol,
          baseAsset: targetBase,
          quoteAsset: targetQuote,
        };
        this.data.orders.unshift(record);
      }
    } else if (action === "CUT" || action === "TAKE_PROFIT" || action === "SNIPE_BUY" || action === "SNIPE_SELL" || action === "CLAIM") {
      // Prevent duplicate exit records if the same orderId or txHash was already recorded
      const existing = orderId && !orderId.startsWith("ord_")
        ? this.data.orders.find(
            (o) =>
              o.orderId === orderId ||
              (eventData.txHash && o.txHash === eventData.txHash),
          )
        : undefined;
      if (existing) {
        existing.status = "FILLED";
        existing.fillTime = now;
        existing.fillPrice = price;
        existing.action = action;
        existing.pnl = pnlVal;
        existing.pnlQuote = pnlVal;
        existing.pnlUsdso = pnlVal;
        existing.levelDesc = eventData.levelDesc || action;
        existing.reason = eventData.reason;
        if (eventData.txHash) existing.txHash = eventData.txHash;
        if (!existing.symbol && targetSymbol) existing.symbol = targetSymbol;
        if (!existing.baseAsset && targetBase) existing.baseAsset = targetBase;
        if (!existing.quoteAsset && targetQuote) existing.quoteAsset = targetQuote;
        if (isIoc) existing.isIoc = true;
        if (targetPrice !== undefined) existing.targetPrice = targetPrice;
        if (slippagePct !== undefined) existing.slippagePct = slippagePct;
        if (limitPrice !== undefined) existing.limitPrice = limitPrice;
        return existing;
      }
      record = {
        id: `mkt_${now}_${Math.random().toString(36).slice(2, 7)}`,
        orderId,
        side,
        price,
        qty,
        notionalQuote,
        notionalUsdso,
        levelDesc: eventData.levelDesc || action,
        status: "FILLED",
        action,
        placedTime: now,
        fillTime: now,
        fillPrice: price,
        pnl: pnlVal,
        pnlQuote: pnlVal,
        pnlUsdso: pnlVal,
        reason: eventData.reason,
        time: now,
        txHash: eventData.txHash,
        dryRun: eventData.dryRun,
        explorerUrl: eventData.txHash ? `https://explorer.somnia.network/tx/${eventData.txHash}` : undefined,
        symbol: targetSymbol,
        baseAsset: targetBase,
        quoteAsset: targetQuote,
      };
      this.data.orders.unshift(record);
    } else {
      // CANCEL_BUY / CANCEL_SELL
      const matches = this.data.orders.filter(
        (o) =>
          o.status === "OPEN" &&
          (orderId
            ? o.orderId === orderId
            : (eventData.dryRun || !o.orderId) && o.side === side && Math.abs(o.price - price) / price <= 0.001),
      );
      if (matches.length > 0) {
        if (isBinance) {
          // On Binance CEX, remove cancelled open order directly to prevent accumulating thousands of records
          this.data.orders = this.data.orders.filter((o) => !matches.includes(o));
          return matches[0]!;
        }
        for (const existing of matches) {
          existing.status = "CANCELLED";
          existing.cancelTime = now;
          existing.cancelTxHash = eventData.txHash;
          existing.reason = eventData.reason;
          existing.action = action;
          existing.time = now;
          if (eventData.txHash) existing.txHash = eventData.txHash;
          if (!existing.symbol && targetSymbol) existing.symbol = targetSymbol;
          if (!existing.baseAsset && targetBase) existing.baseAsset = targetBase;
          if (!existing.quoteAsset && targetQuote) existing.quoteAsset = targetQuote;
        }
        record = matches[0]!;
      } else {
        if (isBinance) {
          // On Binance, do not store cancelled order records without gas fees
          return {
            id: `canc_${now}`,
            orderId,
            side,
            price,
            qty,
            status: "CANCELLED",
            action: action || (side === "SELL" ? "CANCEL_SELL" : "CANCEL_BUY"),
            time: now,
          } as any;
        }
        record = {
          id: `canc_${now}_${Math.random().toString(36).slice(2, 7)}`,
          orderId,
          side,
          price,
          qty,
          notionalUsdso,
          levelDesc: eventData.levelDesc,
          status: "CANCELLED",
          action: action || (side === "SELL" ? "CANCEL_SELL" : "CANCEL_BUY"),
          placedTime: now,
          cancelTime: now,
          cancelTxHash: eventData.txHash,
          reason: eventData.reason,
          time: now,
          txHash: eventData.txHash,
          dryRun: eventData.dryRun,
          explorerUrl: eventData.txHash ? `https://explorer.somnia.network/tx/${eventData.txHash}` : undefined,
          symbol: targetSymbol,
          baseAsset: targetBase,
          quoteAsset: targetQuote,
        };
        this.data.orders.unshift(record);
      }
    }

    if (this.data.orders.length > this.maxHistoryRecords) {
      this.data.orders = this.data.orders.slice(0, this.maxHistoryRecords);
    }

    if (record) {
      if (isIoc) record.isIoc = true;
      if (targetPrice !== undefined) record.targetPrice = targetPrice;
      if (slippagePct !== undefined) record.slippagePct = slippagePct;
      if (limitPrice !== undefined) record.limitPrice = limitPrice;
      if (eventData.gasCompBase !== undefined) record.gasCompBase = Number(eventData.gasCompBase);
      if (eventData.gasCompSomi !== undefined) record.gasCompSomi = Number(eventData.gasCompSomi);
      if (eventData.gasLossQuote !== undefined) record.gasLossQuote = Number(eventData.gasLossQuote);
      if (eventData.gasLossUsdso !== undefined) record.gasLossUsdso = Number(eventData.gasLossUsdso);
      if (eventData.netQty !== undefined) record.netQty = Number(eventData.netQty);
      if (!record.symbol && (eventData.symbol || this.data.settings?.symbol)) {
        record.symbol = eventData.symbol || this.data.settings?.symbol;
      }
      if (!record.baseAsset && (eventData.baseAsset || this.data.state?.baseAsset)) {
        record.baseAsset = eventData.baseAsset || this.data.state?.baseAsset;
      }
      if (!record.quoteAsset && (eventData.quoteAsset || this.data.state?.quoteAsset)) {
        record.quoteAsset = eventData.quoteAsset || this.data.state?.quoteAsset;
      }
      const txKey = (record.txHash || record.fillTxHash || record.createTxHash || "").trim().toLowerCase();
      if (txKey && this.pendingTxGas.has(txKey)) {
        const g = this.pendingTxGas.get(txKey)!;
        this.pendingTxGas.delete(txKey);
        this.updateTxGas(record.txHash || record.fillTxHash || record.createTxHash || txKey, g);
      }
    }

    this.scheduleFlush();
    return record;
  }

  // Backward-compatibility insert methods
  public insertTrade(trade: any): UnifiedOrderRecord {
    return this.recordEvent({ ...trade, action: trade.type === "BUY" ? "BUY_FILL" : trade.type === "SELL" ? "SELL_FILL" : trade.type });
  }

  public insertOrderActivity(order: any): UnifiedOrderRecord {
    return this.recordEvent({ ...order, action: order.action === "PLACED" ? (order.side === "BUY" ? "CREATE_BUY" : "CREATE_SELL") : (order.side === "SELL" ? "CANCEL_SELL" : "CANCEL_BUY") });
  }

  public getOrders(limit = 5000, filter?: { status?: "OPEN" | "FILLED" | "CANCELLED"; side?: "BUY" | "SELL" }): UnifiedOrderRecord[] {
    let list = this.data.orders;
    if (filter?.status) {
      list = list.filter((o) => o.status === filter.status);
    }
    if (filter?.side) {
      list = list.filter((o) => o.side === filter.side);
    }
    return list.slice(0, limit);
  }

  public getTrades(limit = 5000): UnifiedOrderRecord[] {
    return this.data.orders
      .filter((o) => o.status === "FILLED" || o.fillTime !== undefined || ["BUY_FILL", "SELL_FILL", "CUT", "TAKE_PROFIT", "SNIPE_BUY", "SNIPE_SELL"].includes(o.action))
      .slice(0, limit);
  }

  public getOrderActivity(limit = 5000): UnifiedOrderRecord[] {
    return this.data.orders.slice(0, limit);
  }

  public getTradeRounds(symbol?: string): TradeRoundsResult {
    const activeSym = symbol || this.data.settings?.symbol || this.data.state?.baseAsset;
    return calculateTradeRounds(this.data.orders, activeSym);
  }

  // ── Trade & Lot Management API Methods ─────────────────────────────────────

  private adjustStatePnl(diff: number, manualTradeId?: string, isRemove?: boolean): void {
    if (!Number.isFinite(diff) || Math.abs(diff) < 1e-8) return;
    if (!this.data.state) this.data.state = this.getDefaultState();

    this.data.state.tradeRealizedPnl = (this.data.state.tradeRealizedPnl || 0) + diff;
    const totalGasQuote = this.data.state.totalGasDeductedQuote ?? this.data.state.totalGasDeductedUsdso ?? 0;
    this.data.state.realizedPnl = this.data.state.tradeRealizedPnl - totalGasQuote;

    if (manualTradeId) {
      if (!Array.isArray(this.data.state.appliedManualTradeIds)) {
        this.data.state.appliedManualTradeIds = [];
      }
      if (isRemove) {
        this.data.state.appliedManualTradeIds = this.data.state.appliedManualTradeIds.filter((id) => id !== manualTradeId);
      } else if (!this.data.state.appliedManualTradeIds.includes(manualTradeId)) {
        this.data.state.appliedManualTradeIds.push(manualTradeId);
      }
    }

    if (this.data.statesBySymbol) {
      for (const sym of Object.keys(this.data.statesBySymbol)) {
        const s = this.data.statesBySymbol[sym];
        if (s) {
          s.tradeRealizedPnl = (s.tradeRealizedPnl || 0) + diff;
          s.realizedPnl = (s.realizedPnl || 0) + diff;
          if (this.data.state.appliedManualTradeIds) {
            s.appliedManualTradeIds = [...this.data.state.appliedManualTradeIds];
          }
        }
      }
    }
  }

  /**
   * Automatically reconciles and applies any uncounted manual SELL trades PnL to state.tradeRealizedPnl.
   * Prevents discrepancies where manual trades were added prior to PnL synchronization or across sessions.
   */
  public reconcileManualTradesPnl(): number {
    if (!this.data) return 0;
    if (!this.data.state) {
      this.data.state = this.getDefaultState();
    }
    if (!Array.isArray(this.data.state.appliedManualTradeIds)) {
      this.data.state.appliedManualTradeIds = [];
    }
    const appliedSet = new Set(this.data.state.appliedManualTradeIds);
    let totalAdded = 0;

    if (Array.isArray(this.data.orders)) {
      for (const order of this.data.orders) {
        const isManual =
          (order.id && order.id.startsWith("manual_")) ||
          (order.orderId && order.orderId.startsWith("ord_manual_")) ||
          order.reason?.includes("Manual") ||
          order.levelDesc?.includes("Manual");

        if (
          isManual &&
          order.status === "FILLED" &&
          order.side === "SELL" &&
          order.id &&
          !appliedSet.has(order.id)
        ) {
          const pnl = Number(
            order.pnlQuote !== undefined
              ? order.pnlQuote
              : order.pnlUsdso !== undefined
              ? order.pnlUsdso
              : (order.pnl || 0),
          );
          if (Number.isFinite(pnl) && Math.abs(pnl) > 1e-8) {
            totalAdded += pnl;
            this.adjustStatePnl(pnl, order.id, false);
          } else {
            this.data.state.appliedManualTradeIds.push(order.id);
            if (this.data.statesBySymbol) {
              for (const sym of Object.keys(this.data.statesBySymbol)) {
                const s = this.data.statesBySymbol[sym];
                if (s) s.appliedManualTradeIds = [...this.data.state.appliedManualTradeIds];
              }
            }
          }
          appliedSet.add(order.id);
        }
      }
    }

    if (Math.abs(totalAdded) > 1e-8) {
      this.log(`🔄 [reconcile] Applied ${totalAdded >= 0 ? "+" : ""}${totalAdded.toFixed(4)} uncounted manual trade PnL to state`);
      this.flushSync();
    }

    return totalAdded;
  }

  public updateTrade(
    id: string,
    updates: Partial<UnifiedOrderRecord> & { syncLot?: boolean },
  ): { success: boolean; order?: UnifiedOrderRecord; error?: string } {
    const order = this.data.orders.find((o) => o.id === id || o.orderId === id);
    if (!order) {
      return { success: false, error: `Order with ID "${id}" not found` };
    }

    const oldPrice = order.price;
    const oldQty = order.qty;
    const oldTime = order.time || order.placedTime;
    const oldPnlQuote = order.pnlQuote !== undefined ? order.pnlQuote : order.pnlUsdso !== undefined ? order.pnlUsdso : order.pnl;

    if (updates.price !== undefined && Number.isFinite(updates.price)) {
      order.price = Number(updates.price);
      if (order.fillPrice !== undefined) order.fillPrice = Number(updates.price);
    }
    if (updates.qty !== undefined && Number.isFinite(updates.qty)) {
      order.qty = Number(updates.qty);
    }
    if (updates.action !== undefined) {
      order.action = updates.action as any;
    }
    if (updates.status !== undefined) {
      order.status = updates.status as any;
    }
    if (updates.side !== undefined) {
      order.side = updates.side as any;
    }
    if (updates.time !== undefined && Number.isFinite(updates.time)) {
      order.time = Number(updates.time);
      if (order.placedTime) order.placedTime = Number(updates.time);
      if (order.fillTime) order.fillTime = Number(updates.time);
    }
    const pnlUpdate = updates.pnlQuote !== undefined ? updates.pnlQuote : updates.pnlUsdso !== undefined ? updates.pnlUsdso : updates.pnl;
    if (pnlUpdate !== undefined && Number.isFinite(pnlUpdate)) {
      order.pnlQuote = Number(pnlUpdate);
      order.pnlUsdso = Number(pnlUpdate);
      order.pnl = Number(pnlUpdate);
    }
    if (updates.reason !== undefined) {
      order.reason = updates.reason;
    }
    if (updates.levelDesc !== undefined) {
      order.levelDesc = updates.levelDesc;
    }

    const notionalUpdate = updates.notionalQuote !== undefined ? updates.notionalQuote : updates.notionalUsdso !== undefined ? updates.notionalUsdso : updates.notional;
    const computedNotional = notionalUpdate !== undefined && Number.isFinite(notionalUpdate)
      ? Number(notionalUpdate)
      : Number(order.price || 0) * Number(order.qty || 0);

    order.notionalQuote = computedNotional;
    order.notionalUsdso = computedNotional;
    order.notional = computedNotional;

    // Adjust state PnL if pnl changed
    if (this.data.state && pnlUpdate !== undefined && Number.isFinite(pnlUpdate)) {
      const oldPnlNum = Number(oldPnlQuote || 0);
      const diff = Number(pnlUpdate) - oldPnlNum;
      if (Math.abs(diff) > 1e-8) {
        this.adjustStatePnl(diff, order.id, false);
      }
    }

    // If syncLot is requested and order is a BUY fill, update corresponding lot in state.lots
    if (updates.syncLot && this.data.state?.lots) {
      const matchLot = this.data.state.lots.find(
        (l) => Math.abs(l.time - oldTime) < 5000 || (Math.abs(l.price - oldPrice) < 0.0001 && Math.abs(l.qty - oldQty) < 0.01),
      );
      if (matchLot) {
        matchLot.price = order.price;
        matchLot.qty = order.qty;
        if (updates.time) matchLot.time = order.time;
      }
    }

    this.flushSync();
    return { success: true, order };
  }

  public deleteTrade(
    id: string,
    opts?: { permanent?: boolean; removeMatchingLot?: boolean },
  ): { success: boolean; lotRemoved?: boolean; error?: string } {
    const idx = this.data.orders.findIndex((o) => o.id === id || o.orderId === id || (o.txHash && o.txHash === id));
    if (idx < 0) {
      return { success: false, error: `Order with ID "${id}" not found` };
    }

    const order = this.data.orders[idx];
    if (!order) {
      return { success: false, error: `Order with ID "${id}" not found` };
    }
    let lotRemoved = false;

    // Deduct order's PnL from state if it had realized PnL
    const orderPnl = Number(order.pnlQuote !== undefined ? order.pnlQuote : order.pnlUsdso !== undefined ? order.pnlUsdso : (order.pnl || 0));
    if (this.data.state && Number.isFinite(orderPnl) && Math.abs(orderPnl) > 1e-8) {
      this.adjustStatePnl(-orderPnl, id, true);
    }

    // Check if lot removal was requested
    if (opts?.removeMatchingLot && this.data.state?.lots) {
      const lotIdx = this.data.state.lots.findIndex(
        (l) =>
          Math.abs(l.time - (order.time || order.placedTime)) < 5000 ||
          (Math.abs(l.price - order.price) < 0.0001 && Math.abs(l.qty - order.qty) < 0.01),
      );
      if (lotIdx >= 0) {
        this.data.state.lots.splice(lotIdx, 1);
        lotRemoved = true;
      }
    }

    if (opts?.permanent) {
      this.data.orders.splice(idx, 1);
    } else {
      order.status = "CANCELLED";
      order.action = order.side === "BUY" ? "CANCEL_BUY" : "CANCEL_SELL";
      order.cancelTime = Date.now();
    }

    this.flushSync();
    return { success: true, lotRemoved };
  }

  public addManualTrade(
    trade: Partial<UnifiedOrderRecord> & { addLot?: boolean },
  ): { success: boolean; order?: UnifiedOrderRecord; error?: string } {
    const now = trade.time || Date.now();
    const price = Number(trade.price || 0);
    const qty = Number(trade.qty || 0);
    const side = trade.side || (trade.action?.includes("BUY") ? "BUY" : "SELL");
    const action = trade.action || (side === "BUY" ? "BUY_FILL" : "SELL_FILL");
    const status = trade.status || "FILLED";
    const notionalQuote = Number(trade.notionalQuote || trade.notionalUsdso || trade.notional || price * qty);
    let pnlVal = trade.pnlQuote !== undefined ? trade.pnlQuote : trade.pnlUsdso !== undefined ? trade.pnlUsdso : trade.pnl;

    if (!this.data.state) {
      this.data.state = this.getDefaultState();
    }

    // If SELL and no PnL provided, calculate against current lots FIFO / average cost
    if (side === "SELL" && status === "FILLED" && (pnlVal === undefined || !Number.isFinite(pnlVal))) {
      if (Array.isArray(this.data.state.lots) && this.data.state.lots.length > 0) {
        let remaining = qty;
        let sellPnl = 0;
        for (const lot of this.data.state.lots) {
          if (remaining <= 1e-12) break;
          const take = Math.min(lot.qty, remaining);
          sellPnl += (price - lot.price) * take;
          remaining -= take;
        }
        pnlVal = sellPnl;
      }
    }

    const record: UnifiedOrderRecord = {
      id: trade.id || `manual_${now}_${Math.random().toString(36).slice(2, 7)}`,
      orderId: trade.orderId || `ord_manual_${now}`,
      side,
      price,
      qty,
      notionalQuote,
      notionalUsdso: notionalQuote,
      notional: notionalQuote,
      levelDesc: trade.levelDesc || "Manual Trade Fill",
      status,
      action: action as any,
      placedTime: now,
      fillTime: status === "FILLED" ? now : undefined,
      fillPrice: status === "FILLED" ? price : undefined,
      pnlQuote: pnlVal,
      pnlUsdso: pnlVal,
      pnl: pnlVal,
      reason: trade.reason || "Manual Entry via Trade Manager",
      time: now,
      txHash: trade.txHash,
      explorerUrl: trade.txHash ? `https://explorer.somnia.network/tx/${trade.txHash}` : undefined,
    };

    this.data.orders.unshift(record);

    if (status === "FILLED") {
      if (side === "BUY") {
        if (trade.addLot) {
          if (!this.data.state.lots) this.data.state.lots = [];
          this.data.state.lots.push({ price, qty, time: now });
        }
      } else if (side === "SELL") {
        // Accumulate Realized PnL into State
        const finalPnl = Number(pnlVal || 0);
        if (Number.isFinite(finalPnl)) {
          this.adjustStatePnl(finalPnl, record.id, false);
        }

        // Deduct Lots (FIFO) from State
        if (Array.isArray(this.data.state.lots) && this.data.state.lots.length > 0) {
          let remaining = qty;
          while (remaining > 1e-12 && this.data.state.lots.length > 0) {
            const lot = this.data.state.lots[0]!;
            const take = Math.min(lot.qty, remaining);
            lot.qty -= take;
            remaining -= take;
            if (lot.qty <= 1e-12) {
              this.data.state.lots.shift();
            }
          }
          if (this.data.state.lots.reduce((sum, l) => sum + l.qty, 0) < 0.0001) {
            this.data.state.lots = [];
          }
        }
      }
    }

    this.flushSync();
    return { success: true, order: record };
  }

  public updateLot(index: number, lot: Lot): { success: boolean; lots: Lot[]; error?: string } {
    if (!this.data.state?.lots || index < 0 || index >= this.data.state.lots.length) {
      return { success: false, lots: this.data.state?.lots || [], error: "Lot index out of bounds" };
    }
    this.data.state.lots[index] = {
      price: Number(lot.price),
      qty: Number(lot.qty),
      time: Number(lot.time || Date.now()),
    };
    this.flushSync();
    return { success: true, lots: this.data.state.lots };
  }

  public deleteLot(index: number): { success: boolean; lots: Lot[]; error?: string } {
    if (!this.data.state?.lots || index < 0 || index >= this.data.state.lots.length) {
      return { success: false, lots: this.data.state?.lots || [], error: "Lot index out of bounds" };
    }
    this.data.state.lots.splice(index, 1);
    this.flushSync();
    return { success: true, lots: this.data.state.lots };
  }

  public addLot(lot: Lot): { success: boolean; lots: Lot[]; error?: string } {
    if (!this.data.state) this.data.state = this.getDefaultState();
    if (!this.data.state.lots) this.data.state.lots = [];
    this.data.state.lots.push({
      price: Number(lot.price),
      qty: Number(lot.qty),
      time: Number(lot.time || Date.now()),
    });
    this.flushSync();
    return { success: true, lots: this.data.state.lots };
  }

  public clearTradesAndActivity(): void {
    this.data.orders = [];
    if (this.data.state) {
      this.data.state.recentOrders = [];
      this.data.state.lots = [];
      this.data.state.openOrders = [];
      this.data.state.realizedPnl = 0;
      this.data.state.tradeRealizedPnl = 0;
      this.data.state.totalGasSpentSomi = 0;
      this.data.state.totalGasSpentUsdso = 0;
      this.data.state.totalTxCount = 0;
    }
    this.flushSync();
  }

  // ── Exact Gas Accounting (Attached to Order/Tx, No Double-Counting) ─────────

  public updateTxGas(
    txHash: string,
    gas: { gasUsed: number; effectiveGasPriceGwei?: number; gasSomi: number; gasUsdso: number },
  ): void {
    const explorerUrl = `https://explorer.somnia.network/tx/${txHash}`;
    const normTx = (txHash || "").trim().toLowerCase();
    let updated = false;

    for (const order of this.data.orders) {
      if (order.createTxHash && order.createTxHash.toLowerCase() === normTx) {
        order.createGasSomi = gas.gasSomi;
        order.createGasUsdso = gas.gasUsdso;
        order.gasFeeSomi = (order.createGasSomi || 0) + (order.cancelGasSomi || 0);
        order.gasFeeUsdso = (order.createGasUsdso || 0) + (order.cancelGasUsdso || 0);
        order.gasFeeBase = order.gasFeeSomi;
        order.gasFeeQuote = order.gasFeeUsdso;
        order.explorerUrl = explorerUrl;
        updated = true;
      }
      if (order.cancelTxHash && order.cancelTxHash.toLowerCase() === normTx) {
        order.cancelGasSomi = gas.gasSomi;
        order.cancelGasUsdso = gas.gasUsdso;
        order.gasFeeSomi = (order.createGasSomi || 0) + (order.cancelGasSomi || 0);
        order.gasFeeUsdso = (order.createGasUsdso || 0) + (order.cancelGasUsdso || 0);
        order.gasFeeBase = order.gasFeeSomi;
        order.gasFeeQuote = order.gasFeeUsdso;
        order.explorerUrl = explorerUrl;
        updated = true;
      }
      if (
        ((order.txHash && order.txHash.toLowerCase() === normTx) ||
          (order.fillTxHash && order.fillTxHash.toLowerCase() === normTx)) &&
        !order.createGasSomi &&
        !order.cancelGasSomi
      ) {
        order.gasFeeSomi = gas.gasSomi;
        order.gasFeeUsdso = gas.gasUsdso;
        order.gasFeeBase = gas.gasSomi;
        order.gasFeeQuote = gas.gasUsdso;
        order.explorerUrl = explorerUrl;
        updated = true;
      }
    }

    if (updated) {
      this.scheduleFlush();
    } else if (normTx) {
      // Cache gas for a transaction whose order event will be emitted immediately after waitForTransactionReceipt
      this.pendingTxGas.set(normTx, gas);
      if (this.pendingTxGas.size > 500) {
        const firstKey = this.pendingTxGas.keys().next().value;
        if (firstKey) this.pendingTxGas.delete(firstKey);
      }
    }
  }

  public insertGasLog(log: Omit<GasLogRecord, "id" | "explorerUrl">): GasLogRecord {
    this.updateTxGas(log.txHash, {
      gasUsed: log.gasUsed,
      effectiveGasPriceGwei: log.effectiveGasPriceGwei,
      gasSomi: log.gasSomi,
      gasUsdso: log.gasUsdso,
    });

    return {
      ...log,
      id: `gas_${log.timestamp}_${Math.random().toString(36).slice(2, 7)}`,
      explorerUrl: `https://explorer.somnia.network/tx/${log.txHash}`,
    };
  }

  public getGasLogs(limit = 5000): GasLogRecord[] {
    const logs: GasLogRecord[] = [];
    for (const o of this.data.orders) {
      if (o.createTxHash && o.createGasSomi) {
        logs.push({
          id: `gas_create_${o.id}`,
          timestamp: o.placedTime,
          txHash: o.createTxHash,
          label: `CREATE ${o.side} #${o.orderId}`,
          gasUsed: 0,
          effectiveGasPriceGwei: 0,
          gasSomi: o.createGasSomi,
          gasUsdso: o.createGasUsdso || 0,
          explorerUrl: `https://explorer.somnia.network/tx/${o.createTxHash}`,
        });
      }
      if (o.cancelTxHash && o.cancelGasSomi) {
        logs.push({
          id: `gas_cancel_${o.id}`,
          timestamp: o.cancelTime || o.placedTime,
          txHash: o.cancelTxHash,
          label: `CANCEL ${o.side} #${o.orderId}`,
          gasUsed: 0,
          effectiveGasPriceGwei: 0,
          gasSomi: o.cancelGasSomi,
          gasUsdso: o.cancelGasUsdso || 0,
          explorerUrl: `https://explorer.somnia.network/tx/${o.cancelTxHash}`,
        });
      }
      const directTx = o.fillTxHash || o.txHash;
      if (directTx && o.gasFeeSomi && !o.createGasSomi && !o.cancelGasSomi) {
        logs.push({
          id: `gas_fill_${o.id}`,
          timestamp: o.fillTime || o.time || o.placedTime,
          txHash: directTx,
          label: `${o.action || o.side} ${o.levelDesc ? `(${o.levelDesc})` : `#${o.orderId}`}`,
          gasUsed: 0,
          effectiveGasPriceGwei: 0,
          gasSomi: o.gasFeeSomi,
          gasUsdso: o.gasFeeUsdso || o.gasFeeQuote || 0,
          explorerUrl: `https://explorer.somnia.network/tx/${directTx}`,
        });
      }
    }
    return logs.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
  }

  public getGasSummary(): { totalGasSpentSomi: number; totalGasSpentUsdso: number; totalTxCount: number } {
    const somiTxs = this.data.orders.filter(
      (o) => (o.txHash || o.fillTxHash || o.createTxHash || "").toString().startsWith("0x"),
    ).length;
    return {
      totalGasSpentSomi: this.data.state.totalGasSpentSomi || 0,
      totalGasSpentUsdso: this.data.state.totalGasSpentUsdso || 0,
      totalTxCount: Math.max(this.data.state.totalTxCount || 0, somiTxs),
    };
  }

  // ── Dynamic Bot Settings Key-Value Store ──────────────────────────────────

  public getSetting<T = any>(key: string, defaultValue?: T): T | undefined {
    return (this.data.settings[key] !== undefined ? this.data.settings[key] : defaultValue) as T | undefined;
  }

  public getAllSettings(): Record<string, any> {
    return { ...this.data.settings };
  }

  public setSetting(key: string, value: any): void {
    this.data.settings[key] = value;
    this.flushSettingsSync();
    this.flushSync();
  }

  public setSettings(settings: Record<string, any>): void {
    this.data.settings = {
      ...this.data.settings,
      ...settings,
    };
    this.flushSettingsSync();
    this.flushSync();
  }

  // ── DB Maintenance ────────────────────────────────────────────────────────

  public close(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushSettingsSync();
    this.flushSync();
  }
}

let globalDbInstance: BotDatabase | null = null;

export function getDatabase(opts?: DatabaseOptions): BotDatabase {
  if (!globalDbInstance) {
    globalDbInstance = new BotDatabase(opts);
  }
  return globalDbInstance;
}
