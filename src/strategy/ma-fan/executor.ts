/**
 * MA Fan Order Executor
 * Handles order placements, partial fills, Breakeven Lock-in, and trade logging
 * across Binance (CEX) and DreamDEX (DEX) using IExchangeClient.
 */

import { IExchangeClient, ExchangeSymbolInfo } from "../../exchange/types.js";
import { getDatabase } from "../../db.js";
import { MaFanPosition, MaFanTradeLog, HtfRegime } from "./types.js";

export interface ExecutorOptions {
  client: IExchangeClient;
  dryRun?: boolean;
  breakevenFeeBufferPct?: number;
  slBufferPct?: number;
  onTrade?: (trade: MaFanTradeLog) => void;
  onLog?: (msg: string) => void;
}

export class MaFanOrderExecutor {
  private client: IExchangeClient;
  private dryRun: boolean;
  private breakevenFeeBufferPct: number;
  private slBufferPct: number;
  private onTrade?: (trade: MaFanTradeLog) => void;
  private log: (msg: string) => void;
  private db = getDatabase();
  private symbolInfo?: ExchangeSymbolInfo;

  constructor(opts: ExecutorOptions) {
    this.client = opts.client;
    this.dryRun = opts.dryRun ?? false;
    this.breakevenFeeBufferPct = opts.breakevenFeeBufferPct ?? 0.05;
    this.slBufferPct = opts.slBufferPct ?? 0.25;
    this.onTrade = opts.onTrade;
    this.log = opts.onLog ?? ((msg) => console.log(`[ma-fan-executor] ${msg}`));
  }

  public async init(symbol: string): Promise<void> {
    try {
      this.symbolInfo = await this.client.getExchangeInfo(symbol);
    } catch (err: any) {
      this.log(`⚠️ Failed to fetch exchange info for ${symbol}: ${err.message}`);
    }
  }

  public roundQty(qty: number): number {
    if (!this.symbolInfo) return parseFloat(qty.toFixed(6));
    const step = this.symbolInfo.stepSize;
    if (step && step > 0) {
      const precision = Math.max(0, Math.round(-Math.log10(step)));
      const factor = Math.pow(10, precision);
      return Math.floor(qty * factor) / factor;
    }
    const prec = this.symbolInfo.qtyPrecision ?? 6;
    const factor = Math.pow(10, prec);
    return Math.floor(qty * factor) / factor;
  }

  public roundPrice(price: number): number {
    if (!this.symbolInfo) return parseFloat(price.toFixed(4));
    const tick = this.symbolInfo.tickSize;
    if (tick && tick > 0) {
      const precision = Math.max(0, Math.round(-Math.log10(tick)));
      return parseFloat(price.toFixed(precision));
    }
    const prec = this.symbolInfo.pricePrecision ?? 4;
    return parseFloat(price.toFixed(prec));
  }

  /**
   * Execute Sniper BUY order
   */
  public async executeBuy(
    symbol: string,
    entryPrice: number,
    budgetUsd: number,
    swingLowPrice: number,
    htfRegime: HtfRegime,
    fanSpreadPct: number
  ): Promise<MaFanPosition | null> {
    const rawQty = budgetUsd / entryPrice;
    const qty = this.roundQty(rawQty);

    if (qty <= 0) {
      this.log(`⚠️ Calculated buy qty is 0, skipping buy.`);
      return null;
    }

    // Stop Loss is placed slightly below recent swing low
    const stopLossPrice = this.roundPrice(swingLowPrice * (1 - this.slBufferPct / 100));

    this.log(`🟢 [BUY_SNIPER] ${symbol} | Price: $${entryPrice.toFixed(4)} | Qty: ${qty} | SL: $${stopLossPrice.toFixed(4)} | Spread: ${fanSpreadPct.toFixed(2)}% | DryRun: ${this.dryRun}`);

    let fillPrice = entryPrice;
    if (!this.dryRun) {
      try {
        const res = await this.client.placeOrder({
          symbol,
          side: "BUY",
          type: "MARKET",
          qty,
        });
        if (res.price && res.price > 0) fillPrice = res.price;
      } catch (err: any) {
        this.log(`❌ Buy order execution failed: ${err.message}`);
        return null;
      }
    }

    const position: MaFanPosition = {
      symbol,
      entryPrice: fillPrice,
      entryTime: Date.now(),
      totalQty: qty,
      remainingQty: qty,
      stopLossPrice,
      isBreakevenLocked: false,
      tp1Filled: false,
      highestPriceSinceTp1: fillPrice,
      htfRegimeAtEntry: htfRegime,
      fanSpreadAtEntry: fanSpreadPct,
    };

    const trade: MaFanTradeLog = {
      id: `mf_buy_${Date.now()}`,
      type: "BUY_HOOK",
      symbol,
      price: fillPrice,
      qty,
      reason: `Fan Spread ${fanSpreadPct.toFixed(2)}% + Hook`,
      time: Date.now(),
    };

    this.recordDbOrder(trade, "BUY", fillPrice, qty);
    this.onTrade?.(trade);

    return position;
  }

  /**
   * Execute Take Profit 1 (Mean Reversion at EMA 25)
   * Sells partial position and locks Stop Loss to Breakeven (+fee buffer)
   */
  public async executeTp1(
    position: MaFanPosition,
    currentPrice: number,
    tp1Ratio: number
  ): Promise<boolean> {
    const sellQty = this.roundQty(position.totalQty * tp1Ratio);
    if (sellQty <= 0) return false;

    this.log(`🎯 [TP1_EMA25] ${position.symbol} | Target: $${currentPrice.toFixed(4)} | Selling: ${sellQty} (${(tp1Ratio * 100).toFixed(0)}%) | DryRun: ${this.dryRun}`);

    let fillPrice = currentPrice;
    if (!this.dryRun) {
      try {
        const res = await this.client.placeOrder({
          symbol: position.symbol,
          side: "SELL",
          type: "MARKET",
          qty: sellQty,
        });
        if (res.price && res.price > 0) fillPrice = res.price;
      } catch (err: any) {
        this.log(`❌ TP1 order failed: ${err.message}`);
        return false;
      }
    }

    const pnl = (fillPrice - position.entryPrice) * sellQty;
    const pnlPct = ((fillPrice - position.entryPrice) / position.entryPrice) * 100;

    position.remainingQty = Math.max(0, position.remainingQty - sellQty);
    position.tp1Filled = true;
    position.tp1Price = fillPrice;
    position.tp1Time = Date.now();
    position.highestPriceSinceTp1 = fillPrice;

    // 🛡️ INSTANT BREAKEVEN LOCK-IN: Shift remaining position's Stop Loss to Entry + fee buffer
    const breakevenSl = this.roundPrice(position.entryPrice * (1 + this.breakevenFeeBufferPct / 100));
    position.stopLossPrice = Math.max(position.stopLossPrice, breakevenSl);
    position.isBreakevenLocked = true;

    this.log(`🛡️ [BREAKEVEN_LOCKED] SL for remaining ${position.remainingQty} moved to $${position.stopLossPrice.toFixed(4)} (Risk-Free Mode Active)`);

    const trade: MaFanTradeLog = {
      id: `mf_tp1_${Date.now()}`,
      type: "TP1_EMA25",
      symbol: position.symbol,
      price: fillPrice,
      qty: sellQty,
      pnl,
      pnlPct,
      reason: "EMA 25 Mean Reversion Reached",
      time: Date.now(),
    };

    this.recordDbOrder(trade, "SELL", fillPrice, sellQty, pnl);
    this.onTrade?.(trade);

    return true;
  }

  /**
   * Execute Take Profit 2 (Macro Runner / Trailing Stop)
   */
  public async executeTp2(
    position: MaFanPosition,
    currentPrice: number,
    reason: string
  ): Promise<boolean> {
    const sellQty = this.roundQty(position.remainingQty);
    if (sellQty <= 0) return false;

    this.log(`🚀 [TP2_RUNNER] ${position.symbol} | Price: $${currentPrice.toFixed(4)} | Qty: ${sellQty} | Reason: ${reason} | DryRun: ${this.dryRun}`);

    let fillPrice = currentPrice;
    if (!this.dryRun) {
      try {
        const res = await this.client.placeOrder({
          symbol: position.symbol,
          side: "SELL",
          type: "MARKET",
          qty: sellQty,
        });
        if (res.price && res.price > 0) fillPrice = res.price;
      } catch (err: any) {
        this.log(`❌ TP2 order failed: ${err.message}`);
        return false;
      }
    }

    const pnl = (fillPrice - position.entryPrice) * sellQty;
    const pnlPct = ((fillPrice - position.entryPrice) / position.entryPrice) * 100;

    position.remainingQty = 0;

    const trade: MaFanTradeLog = {
      id: `mf_tp2_${Date.now()}`,
      type: "TP2_RUNNER",
      symbol: position.symbol,
      price: fillPrice,
      qty: sellQty,
      pnl,
      pnlPct,
      reason,
      time: Date.now(),
    };

    this.recordDbOrder(trade, "SELL", fillPrice, sellQty, pnl);
    this.onTrade?.(trade);

    return true;
  }

  /**
   * Execute Stop Loss Exit
   */
  public async executeStopLoss(
    position: MaFanPosition,
    currentPrice: number
  ): Promise<boolean> {
    const sellQty = this.roundQty(position.remainingQty);
    if (sellQty <= 0) return false;

    this.log(`🔴 [STOP_LOSS] ${position.symbol} | Trigger: $${currentPrice.toFixed(4)} | SL Price: $${position.stopLossPrice.toFixed(4)} | Qty: ${sellQty} | Breakeven Locked: ${position.isBreakevenLocked}`);

    let fillPrice = currentPrice;
    if (!this.dryRun) {
      try {
        const res = await this.client.placeOrder({
          symbol: position.symbol,
          side: "SELL",
          type: "MARKET",
          qty: sellQty,
        });
        if (res.price && res.price > 0) fillPrice = res.price;
      } catch (err: any) {
        this.log(`❌ Stop Loss exit failed: ${err.message}`);
        return false;
      }
    }

    const pnl = (fillPrice - position.entryPrice) * sellQty;
    const pnlPct = ((fillPrice - position.entryPrice) / position.entryPrice) * 100;

    position.remainingQty = 0;

    const trade: MaFanTradeLog = {
      id: `mf_sl_${Date.now()}`,
      type: "STOP_LOSS",
      symbol: position.symbol,
      price: fillPrice,
      qty: sellQty,
      pnl,
      pnlPct,
      reason: position.isBreakevenLocked ? "Breakeven SL Hit (Protected)" : "Swing Low SL Hit",
      time: Date.now(),
    };

    this.recordDbOrder(trade, "SELL", fillPrice, sellQty, pnl);
    this.onTrade?.(trade);

    return true;
  }

  private recordDbOrder(
    trade: MaFanTradeLog,
    side: "BUY" | "SELL",
    price: number,
    qty: number,
    pnl?: number
  ): void {
    try {
      this.db.recordEvent({
        id: trade.id,
        orderId: trade.id,
        symbol: trade.symbol,
        side,
        price,
        qty,
        notional: price * qty,
        notionalQuote: price * qty,
        status: "FILLED",
        action: side === "BUY" ? "SNIPE_BUY" : (trade.type === "STOP_LOSS" ? "CUT" : "TAKE_PROFIT"),
        placedTime: trade.time,
        fillTime: trade.time,
        time: trade.time,
        fillPrice: price,
        pnl,
        pnlQuote: pnl,
        reason: trade.reason,
        dryRun: this.dryRun,
      });
    } catch (err: any) {
      this.log(`⚠️ Failed to record DB order: ${err.message}`);
    }
  }
}
