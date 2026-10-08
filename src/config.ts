/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import dotenv from "dotenv";
import { getDatabase } from "./db.js";

dotenv.config();

const envSymbol = process.env.SYMBOL || "BTCUSDT";
const cleanBinanceSymbol = envSymbol.toLowerCase().replace(/[\/\-_:]/g, "");

/**
 * Baseline fallback configuration defaults.
 * All runtime strategy parameters are loaded from and stored directly in the
 * ACID database (`grid-bot.db.json` -> `db.settings`) as the Single Source of Truth.
 */
export const defaultStrategyConfig = {
  // ── Core Parameters ────────────────────────────────────────────────────
  symbol: envSymbol,
  /** Stop opening new longs once total base inventory exceeds this (Quote/USDT terms). */
  maxInventoryUsdso: 40,
  /** Skip a cycle if the book spread is wider than this. */
  maxSpreadBps: 60,
  /** Halt buying (offload-only) once session PnL drops below −this. */
  maxSessionLossUsdso: 25,
  /** Maximum allowable Bid discount (%) compared to reference price before allowing Cut Loss sell. */
  cutLossMaxBidDiscountPct: 0.75,
  /** If a lot can't hit its sell trigger within this long, cut it and re-anchor (ms). 0 = off / disabled. Default 0. */
  stuckTimeoutMs: 0,
  /** Poll interval / Tick speed in ms (default 500ms). */
  intervalMs: 500,
  /** Expiration duration for resting Maker limit orders in hours (default 24h). */
  orderExpireHours: 24,
  /** Minimum reserve balance to protect in wallet (never traded or sold). */
  minGasReserveSomi: 0,
  /** Timezone for log timestamps and formatting. Default "Asia/Bangkok". */
  timezone: process.env.TZ || "Asia/Bangkok",
  dryRun: process.env.DRY_RUN === "true" || false,

  // ── Binance API Credentials ─────────────────────────────────────────────
  binanceApiKey: process.env.BINANCE_API_KEY || "",
  binanceApiSecret: process.env.BINANCE_API_SECRET || "",
  binanceBaseUrl: process.env.BINANCE_BASE_URL || "https://api.binance.com",

  // ── Dynamic-grid specific: volatility-driven step sizing ────────────────
  /** "binance" (external WS feed) or "dreamdex" (self-sampled from pool.topOfBook()). */
  atrSource: "binance",
  /** Number of bars ATR is averaged over (classic ATR uses 14). Used by both sources. */
  atrLookback: 14,
  /** step_bps = atrPct * 10_000 * atrMultiplier, before clamping. */
  atrMultiplier: 0.8,
  /** Never let the computed step go below this many bps. */
  minStepBps: 15,
  /** Never let the computed step go above this many bps. */
  maxStepBps: 150,
  /** Recompute the step from ATR every N ticks (avoids re-pricing every second). */
  recalcEveryTicks: 5,
  /** Fixed step used before ATR has enough bars to be meaningful, or while the feed is stale. */
  warmupStepBps: 30,

  // ── DGRID_ATR_SOURCE=dreamdex only ───────────────────────────────────────
  /** Duration of each synthetic OHLC bar built from sampled mid price, ms. */
  barMs: 60_000,

  // ── DGRID_ATR_SOURCE=binance only ────────────────────────────────────────
  // ── Timeframes ────────────────────────────────────────────────────────────
  /** Higher timeframe used for Dow Theory macro bounds (Upper Ceiling & Lower Floor). Default "15m". */
  dowTimeframe: "15m",
  /** Trading timeframe used for the candlestick chart and grid execution. Default "15m". */
  tradingTimeframe: "15m",
  /** Timeframe used for detecting localized Downtrends (LH+LL) to pause buys (default "15m"). */
  trendTimeframe: "15m",
  /** Lowercase Binance symbol to stream klines for. */
  binanceSymbol: cleanBinanceSymbol,
  /** wss host. */
  binanceWsBase: process.env.BINANCE_WS_URL || "wss://stream.binance.com:9443",
  /** Feed is considered stale after this long with no message, ms. */
  binanceStaleMs: 30_000,

  // ── Candlestick & Data History ──────────────────────────────────────────
  /** Initial number of historical candles fetched from Binance upon startup (default 300, max 1000). */
  initialCandleCount: 300,
  /** Maximum number of candles maintained in memory and on chart buffer (default 600, max 2000). */
  maxCandleCount: 600,

  // ── Dow Theory & Market Structure Bounds ──────────────────────────────────
  /** Number of bars on left & right to confirm a pivot swing high/low (default 3). */
  dowSwingLookback: 3,
  /** When true, pauses opening new buy orders during a confirmed Dow downtrend (LH+LL). Default false. */
  dowTrendFilter: false,
  /** When true, pauses opening new buy orders while price is under a descending Downtrend Line until breakout. Default false. */
  trendlineFilter: false,
  /** When true, allows resuming buy orders if price stands/closes above Buy Level 2 (30% Zone) for at least 1 candle after a floor breakdown. */
  enableBuyLevel2Recovery: true,
  /** When true, only places buy orders strictly above ascending Trend Support line and pauses buying if support breaks. */
  enableBuyAboveTrendSupport: false,
  /** When true, only places sell orders strictly below descending Trendline Resistance. */
  enableSellBelowTrendResistance: false,
  /** When true, only maintains/places buy orders when price is at or below Sell Level 1 (<= 60%). Default true. */
  enableBuyBelowSellLevel1: true,
  /** When true, only maintains/places sell orders when price is at or above Buy Level 1 (>= 40%). Default true. */
  enableSellAboveBuyLevel1: true,
  /**
   * Order Execution Mode:
   * 1. "IOC_BRACKET" (Default): Zero resting orders on book. Dynamically snipes buys/sells via IOC when price enters level brackets. Aggregates tranches on fast moves to save gas.
   * 2. "MAKER_LIMIT": Maintains resting limit orders on DreamDEX CLOB book.
   */
  orderExecutionMode: "IOC_BRACKET" as "IOC_BRACKET" | "MAKER_LIMIT",
  /** Slippage tolerance (%) for IOC orders in IOC_BRACKET mode (default 0.35%). */
  iocSlippagePct: 0.35,
  /**
   * Profit taking / Sell mode:
   * 1. "GRID_CASHFLOW" (Default): Sell at all grid targets regardless of avgEntry to maximize cash flow.
   * 2. "PORTFOLIO_AVG_PROFIT": Only sell at prices higher than portfolio average entry (+0.1% profit).
   * 3. "LOT_BASED_PROFIT": Lot-based matching; only sell inventory from lots bought lower than the sell target price.
   */
  sellProfitMode: "GRID_CASHFLOW" as "GRID_CASHFLOW" | "PORTFOLIO_AVG_PROFIT" | "LOT_BASED_PROFIT",
  /** When true, only places sell orders strictly at prices higher than average entry (+0.1% profit). */
  requireProfitAboveAvgEntry: false,
  /** Automatically cut loss / sell all inventory if price breaks below Lower Bound (0% Floor). */
  cutLossAtLowerBound: true,
  /** Number of confirmed candle periods below floor buffer required before executing cut loss (default 1). */
  cutLossConfirmCandles: 1,
  /** Automatically sell 100% of all inventory when price reaches Upper Bound (100% Ceiling). */
  takeProfitAtUpperBound: true,
  /** When true, if market price exceeds a grid sell level's target price, executes an immediate IOC sell. */
  enableIocSellWhenExceeded: true,

  // ── Triangle Squeeze / Trendline Convergence ────────────────────────────
  /** When true, liquidates position to cash and pauses when support and resistance trendlines converge. */
  enableTriangleSqueezeExit: false,
  /** Minimum spread (%) between resistance and support trendlines before triggering squeeze exit (default 1.0%). */
  triangleSqueezeSpreadPct: 1.0,
  /** Minimum channel width (%) required to resume trading after a squeeze exit (default 2.0%). */
  minTradeableChannelWidthPct: 2.0,

  // ── Support & Resistance Channel Calculation Mode ────────────────────────
  /**
   * Channel boundary calculation mode:
   * 1. "DOW_ATR_CLAMP": Dow Theory Swings with dynamic ATR min/max width clamping & true wick support.
   * 2. "FIXED_PCT_CLAMP": Dow Theory Swings clamped to fixed min/max percentage width.
   * 3. "DONCHIAN_ATR": Adaptive Donchian Channel (Highest High & Lowest Low of lookback bars) + ATR buffer.
   * 4. "MULTI_TOUCH_SR" (Default): Horizontal Support & Resistance levels where price was rejected >= 2 times.
   */
  channelMode: "MULTI_TOUCH_SR" as "DOW_ATR_CLAMP" | "FIXED_PCT_CLAMP" | "DONCHIAN_ATR" | "MULTI_TOUCH_SR",
  /** Min channel width for FIXED_PCT_CLAMP & MULTI_TOUCH_SR (in %, default 2.5%). */
  minChannelWidthPct: 2.5,
  /** Max channel width for FIXED_PCT_CLAMP & MULTI_TOUCH_SR (in %, default 6.0%). */
  maxChannelWidthPct: 6.0,
  /** When true, freezes/locks channel bounds while holding inventory position to avoid shifting sell targets. */
  lockChannelInPosition: true,
  /** Min channel width multiplier of ATR for DOW_ATR_CLAMP (default 2.5x ATR). */
  atrMinMultiplier: 2.5,
  /** Max channel width multiplier of ATR for DOW_ATR_CLAMP (default 5.0x ATR). */
  atrMaxMultiplier: 5.0,
  /** Donchian lookback bars for DONCHIAN_ATR mode (default 20 bars). */
  donchianLookback: 20,
  /** Minimum touch count for horizontal support/resistance levels in MULTI_TOUCH_SR mode (default 2). */
  srMinTouchCount: 2,
  /** Tolerance % to cluster swing highs/lows into a single S/R level in MULTI_TOUCH_SR mode (default 1.0%). */
  srTouchTolerancePct: 1.0,
  /** Shared lookback (bars) for Peak/Valley detection, trendlines AND multi-touch S/R analysis (default 300 = initial candle load). */
  srLookbackCandles: 300,
  /** Safety buffer below floor (in % of price, default 0.25%). */
  floorBufferPct: 0.25,
  /** Use true wick (candle high/low) for swing pivots instead of body clipping (default false). */
  useTrueWick: false,
  /** Rejection wick threshold (% of candle range) to clip to candle body when useTrueWick is false (default 50.0%). */
  wickThresholdPct: 50.0,

  // ── Order Stability & Fee Optimization (Hysteresis) ─────────────────────
  /** Minimum % change in channel bounds before shifting grid levels (default 1.0%). Prevents order churn and fee waste on minor fluctuations. */
  minChannelShiftPct: 1.0,
  /** Price tolerance (%) between desired grid level and existing open order to keep resting order without canceling (default 1.0%). */
  orderPriceTolerancePct: 1.0,
  /** Quantity difference ratio (%) before rebalancing an existing open order (default 10%). */
  orderQtyTolerancePct: 10.0,

  // ── Cross-Exchange Laggard / Dislocation Detection ────────────────────────
  /** Percentage difference between DreamDEX and Binance to qualify as a laggard opportunity (default 0.40%). */
  laggardThresholdPct: 0.4,
  /** Opportunistically buy discounted asks or sell to premium bids on DreamDEX vs Binance. */
  enableLaggardSnipe: true,
  /** Protect against buying on DreamDEX when DreamDEX is lagging above a dumping Binance market. */
  enableLaggardGuard: true,

  // ── State Persistence & Offline Database (Lots & PnL recovery on restart) ──
  /** Persist open lots, realized PnL, order history, and gas tracking to offline database. Default true. */
  persistState: true,
  /** File path for offline ACID database. Default "data/grid-bot.db.json". */
  dbPath: "data/grid-bot.db.json",
  /** Legacy JSON state file path to auto-migrate from. Default ".grid-state.json". */
  stateFile: ".grid-state.json",

  // ── Bot Control & Initial State ──────────────────────────────────────────
  /** Start bot in PAUSED mode on boot (chart and bounds calculate normally, no orders placed/closed). Default true. */
  startPaused: true,

  // ── Web Dashboard ────────────────────────────────────────────────────────
  /** Port to serve the live TradingView dashboard on (0 to disable). Default 3333 or process.env.PORT. */
  dashboardPort: process.env.PORT ? parseInt(process.env.PORT, 10) : 3333,
};

/**
 * Loads the active strategy configuration exclusively from Database settings (`db.settings`),
 * falling back to defaultStrategyConfig for any uninitialized fields.
 */
export function loadConfigFromDatabase(): typeof defaultStrategyConfig {
  try {
    const db = getDatabase({ dbPath: defaultStrategyConfig.dbPath });
    const saved = db.getAllSettings();
    if (saved && Object.keys(saved).length > 0) {
      const merged = {
        ...defaultStrategyConfig,
        ...saved,
      };
      if (saved.symbol) {
        merged.symbol = String(saved.symbol).toUpperCase().replace(/[\/\-_:]/g, "");
        merged.binanceSymbol = String(saved.symbol).toLowerCase().replace(/[\/\-_:]/g, "");
      }
      if (saved.binanceApiKey !== undefined) merged.binanceApiKey = String(saved.binanceApiKey);
      if (saved.binanceApiSecret !== undefined) merged.binanceApiSecret = String(saved.binanceApiSecret);
      if (saved.binanceBaseUrl !== undefined) merged.binanceBaseUrl = String(saved.binanceBaseUrl);
      if (saved.binanceWsBase !== undefined) merged.binanceWsBase = String(saved.binanceWsBase);
      if (saved.dryRun !== undefined) merged.dryRun = Boolean(saved.dryRun);
      if (saved.timezone !== undefined) merged.timezone = String(saved.timezone);
      if (saved.dashboardPort !== undefined) merged.dashboardPort = Number(saved.dashboardPort);
      return merged;
    }
  } catch {
    // If DB is not yet available, use default baseline
  }
  return { ...defaultStrategyConfig };
}

export const config = loadConfigFromDatabase();
export type Config = typeof defaultStrategyConfig;
