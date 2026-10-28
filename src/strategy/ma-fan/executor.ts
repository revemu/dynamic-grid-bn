/**
 * MA Fan Order Executor
 * Handles order placements, partial fills, Breakeven Lock-in, and trade logging
 * across Binance (CEX) and DreamDEX (DEX) using IExchangeClient.
 */

import { IExchangeClient, ExchangeSymbolInfo } from "../../exchange/types.js";
import { getDatabase, type UnifiedOrderRecord } from "../../db.js";
import { MaFanPosition, MaFanTradeLog, HtfRegime } from "./types.js";

export interface ExecutorOptions {
  client: IExchangeClient;
  dryRun?: boolean;
  breakevenFeeBufferPct?: number;
  slBufferPct?: number;
  onTrade?: (trade: UnifiedOrderRecord | MaFanTradeLog) => void;
  onLog?: (msg: string) => void;
}

export class MaFanOrderExecutor {
  private client: IExchangeClient;
  private dryRun: boolean;
  private breakevenFeeBufferPct: number;
  private slBufferPct: number;
  private onTrade?: (trade: UnifiedOrderRecord | MaFanTradeLog) => void;
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

  public updateOptions(opts: Partial<ExecutorOptions>): void {
    if (opts.client) this.client = opts.client;
    if (opts.dryRun !== undefined) this.dryRun = opts.dryRun;
    if (opts.breakevenFeeBufferPct !== undefined) this.breakevenFeeBufferPct = opts.breakevenFeeBufferPct;
    if (opts.slBufferPct !== undefined) this.slBufferPct = opts.slBufferPct;
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
    const factor = Math.pow(10, prec);
    return parseFloat(price.toFixed(prec));
  }

  /**
   * Query actual available free base asset balance in wallet.
   */
  public async getAvailableBaseBalance(symbol: string): Promise<number> {
    if (this.dryRun) return 999999;
    try {
      const b = await this.client.getAccountBalances(this.symbolInfo?.symbol || symbol);
      return b.baseFree ?? 0;
    } catch (err: any) {
      this.log(`⚠️ Failed to fetch available base balance for ${symbol}: ${err.message}`);
      return 0;
    }
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
    fanSpreadPct: number,
    curAtr?: number
  ): Promise<MaFanPosition | null> {
    const rawQty = budgetUsd / entryPrice;
    const qty = this.roundQty(rawQty);

    if (qty <= 0) {
      this.log(`⚠️ Calculated buy qty is 0, skipping buy.`);
      return null;
    }

    const minNotional = (this.symbolInfo?.minNotional && this.symbolInfo.minNotional > 0) ? this.symbolInfo.minNotional : 5.0;
    const notional = qty * entryPrice;
    if (notional < minNotional) {
      this.log(`⚠️ Order value $${notional.toFixed(2)} is below minimum allowed ($${minNotional.toFixed(2)}), skipping buy.`);
      return null;
    }

    // Dynamic ATR SL Buffer: protect from extreme wicks below recent swing low
    const slDist = Math.max(swingLowPrice * (this.slBufferPct / 100), (curAtr ?? 0) * 1.0);
    const stopLossPrice = this.roundPrice(swingLowPrice - slDist);

    this.log(`🟢 [BUY_SNIPER] ${symbol} | Price: $${entryPrice.toFixed(4)} | Qty: ${qty} | SL: $${stopLossPrice.toFixed(4)} (Buffer: $${slDist.toFixed(4)}) | Spread: ${fanSpreadPct.toFixed(2)}% | DryRun: ${this.dryRun}`);

    let fillPrice = entryPrice;
    let netReceivedQty = qty;

    if (!this.dryRun) {
      try {
        const orderType = this.client.exchangeName === "dreamdex" ? "IOC" : "MARKET";
        const res = await this.client.placeOrder({
          symbol,
          side: "BUY",
          type: orderType,
          price: entryPrice,
          qty,
        });
        if (res.price && res.price > 0) fillPrice = res.price;

        // 🛡️ Deduct Trading Fee in Base Asset (Binance Spot fee deduction)
        if (Array.isArray(res.fills) && res.fills.length > 0) {
          const sym = symbol.toUpperCase();
          const baseSym = (this.symbolInfo?.baseAsset || sym.replace(/(USDT|FDUSD|USDSO|USDC)$/i, "")).toUpperCase();
          let baseFee = 0;
          for (const f of res.fills) {
            if ((f.commissionAsset || "").toUpperCase() === baseSym) {
              baseFee += Number(f.commission || 0);
            }
          }
          if (baseFee > 0) {
            netReceivedQty = Math.max(0, qty - baseFee);
            this.log(`ℹ️ [BUY_FEE DEDUCTION] Bought ${qty} ${baseSym} - fee ${baseFee} ${baseSym} = net received ${netReceivedQty} ${baseSym}`);
          }
        }
      } catch (err: any) {
        this.log(`❌ Buy order execution failed: ${err.message}`);
        return null;
      }
    }

    const finalHoldingQty = this.roundQty(netReceivedQty);

    const position: MaFanPosition = {
      symbol,
      entryPrice: fillPrice,
      entryTime: Date.now(),
      totalQty: finalHoldingQty,
      remainingQty: finalHoldingQty,
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
      qty: finalHoldingQty,
      reason: `Fan Spread ${fanSpreadPct.toFixed(2)}% + Hook`,
      time: Date.now(),
    };

    const orderRecord = this.recordDbOrder(trade, "BUY", fillPrice, finalHoldingQty);
    this.onTrade?.(orderRecord || trade);

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
    const minNotional = (this.symbolInfo?.minNotional && this.symbolInfo.minNotional > 0) ? this.symbolInfo.minNotional : 5.0;
    let sellQty = this.roundQty(position.totalQty * tp1Ratio);
    if (sellQty <= 0) return false;

    // 🛡️ BALANCE GUARD: Check live wallet free balance before placing TP1
    if (!this.dryRun) {
      const available = await this.getAvailableBaseBalance(position.symbol);
      if (available > 0 && available < sellQty) {
        this.log(`ℹ️ [TP1 BALANCE GUARD] Available wallet balance ${available} is less than planned sell ${sellQty}. Adjusting sell qty to ${available}`);
        sellQty = this.roundQty(available);
      }
    }

    // 🛡️ Min Notional Dust Guard: Check if remaining runner would be below minimum exchange size (< $5.10)
    const remainingQty = this.roundQty(position.remainingQty - sellQty);
    const remainingValue = remainingQty * currentPrice;
    if (remainingQty > 0 && remainingValue < minNotional * 1.05) {
      this.log(`ℹ️ [MIN_NOTIONAL GUARD] Remaining runner ${remainingQty} ($${remainingValue.toFixed(2)}) is below exchange min notional ($${minNotional.toFixed(2)}). Liquidating 100% at TP1 to prevent dust lockup.`);
      sellQty = position.remainingQty;
    }

    this.log(`🎯 [TP1_EMA25] ${position.symbol} | Target: $${currentPrice.toFixed(4)} | Selling: ${sellQty} | DryRun: ${this.dryRun}`);

    let fillPrice = currentPrice;
    if (!this.dryRun) {
      try {
        const orderType = this.client.exchangeName === "dreamdex" ? "IOC" : "MARKET";
        const res = await this.client.placeOrder({
          symbol: position.symbol,
          side: "SELL",
          type: orderType,
          price: currentPrice,
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

    position.remainingQty = Math.max(0, this.roundQty(position.remainingQty - sellQty));
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

    const orderRecord = this.recordDbOrder(trade, "SELL", fillPrice, sellQty, pnl);
    this.onTrade?.(orderRecord || trade);

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
    let sellQty = this.roundQty(position.remainingQty);
    if (sellQty <= 0) return false;

    // 🛡️ BALANCE GUARD: Check actual wallet free balance before placing TP2 (Runner Full Liquidation)
    if (!this.dryRun) {
      const available = await this.getAvailableBaseBalance(position.symbol);
      if (available <= 0) {
        this.log(`⚠️ [TP2 BALANCE GUARD] Wallet free balance is 0 for ${position.symbol}. Position appears to be already sold or liquidated.`);
        position.remainingQty = 0;
        return true;
      }
      if (available < sellQty) {
        this.log(`ℹ️ [TP2 BALANCE GUARD] Adjusting TP2 sell qty from ${sellQty} to available wallet balance ${available} (deducting fees/dust)`);
        sellQty = this.roundQty(available);
      }
    }

    if (sellQty <= 0) return false;

    this.log(`🚀 [TP2_RUNNER] ${position.symbol} | Price: $${currentPrice.toFixed(4)} | Qty: ${sellQty} | Reason: ${reason} | DryRun: ${this.dryRun}`);

    let fillPrice = currentPrice;
    if (!this.dryRun) {
      try {
        const orderType = this.client.exchangeName === "dreamdex" ? "IOC" : "MARKET";
        const res = await this.client.placeOrder({
          symbol: position.symbol,
          side: "SELL",
          type: orderType,
          price: currentPrice,
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

    const orderRecord = this.recordDbOrder(trade, "SELL", fillPrice, sellQty, pnl);
    this.onTrade?.(orderRecord || trade);

    return true;
  }

  /**
   * Execute Stop Loss Exit
   */
  public async executeStopLoss(
    position: MaFanPosition,
    currentPrice: number
  ): Promise<boolean> {
    let sellQty = this.roundQty(position.remainingQty);
    if (sellQty <= 0) return false;

    // 🛡️ BALANCE GUARD: Check actual wallet free balance before placing SL
    if (!this.dryRun) {
      const available = await this.getAvailableBaseBalance(position.symbol);
      if (available <= 0) {
        this.log(`⚠️ [SL BALANCE GUARD] Wallet free balance is 0 for ${position.symbol}. Position appears to be already sold or closed.`);
        position.remainingQty = 0;
        return true;
      }
      if (available < sellQty) {
        this.log(`ℹ️ [SL BALANCE GUARD] Adjusting SL sell qty from ${sellQty} to available wallet balance ${available}`);
        sellQty = this.roundQty(available);
      }
    }

    if (sellQty <= 0) return false;

    this.log(`🔴 [STOP_LOSS] ${position.symbol} | Trigger: $${currentPrice.toFixed(4)} | SL Price: $${position.stopLossPrice.toFixed(4)} | Qty: ${sellQty} | Breakeven Locked: ${position.isBreakevenLocked}`);

    let fillPrice = currentPrice;
    if (!this.dryRun) {
      try {
        const orderType = this.client.exchangeName === "dreamdex" ? "IOC" : "MARKET";
        const res = await this.client.placeOrder({
          symbol: position.symbol,
          side: "SELL",
          type: orderType,
          price: currentPrice,
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

    const orderRecord = this.recordDbOrder(trade, "SELL", fillPrice, sellQty, pnl);
    this.onTrade?.(orderRecord || trade);

    return true;
  }

  private recordDbOrder(
    trade: MaFanTradeLog,
    side: "BUY" | "SELL",
    price: number,
    qty: number,
    pnl?: number
  ): UnifiedOrderRecord | undefined {
    try {
      const sym = (trade.symbol || "").toUpperCase();
      let baseAsset: string | undefined;
      let quoteAsset = "USDT";
      if (sym.includes(":")) {
        const parts = sym.split(":");
        baseAsset = parts[0];
        quoteAsset = parts[1] || "USDT";
      } else if (sym.endsWith("USDT")) {
        baseAsset = sym.slice(0, -4);
        quoteAsset = "USDT";
      } else if (sym.endsWith("FDUSD")) {
        baseAsset = sym.slice(0, -5);
        quoteAsset = "FDUSD";
      } else if (sym.endsWith("USDSO")) {
        baseAsset = sym.slice(0, -5);
        quoteAsset = "USDSO";
      } else if (sym.endsWith("USDC")) {
        baseAsset = sym.slice(0, -4);
        quoteAsset = "USDC";
      }
      return this.db.recordEvent({
        id: trade.id,
        orderId: trade.id,
        symbol: trade.symbol,
        baseAsset,
        quoteAsset,
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
      return undefined;
    }
  }
}
