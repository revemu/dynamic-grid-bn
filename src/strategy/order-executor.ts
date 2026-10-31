/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import type { IStrategyHost, OpenOrder } from "./types.js";
import type { LotTracker } from "./lot-tracker.js";
import { roundToStep, roundToTick } from "../exchange/binance/client.js";

export class OrderExecutor {
  constructor(
    private host: IStrategyHost,
    private lotTracker: LotTracker,
  ) {}

  /**
   * Helper: Match levelDesc or price to find which sell target index (0..4) is being executed.
   */
  public findSellLevelIndex(levelDesc?: string, price?: number): number {
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
    const bounds = this.host.confirmedChannel;
    const sellLevels = bounds?.sellLevels ?? bounds?.gridZone?.sellLevels ?? [];
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

  private getStepSize(): number {
    return this.host.stepSize || (this.host.qtyPrecision ? 10 ** -this.host.qtyPrecision : 1e-6);
  }

  /**
   * Asynchronously fetch transaction receipt to track gas fee spent
   */
  public async trackTxGas(txHash?: string, label?: string): Promise<void> {
    if (!txHash) return;
    if (this.host.cfg.dryRun) return;
    if (this.host.binance.exchangeName !== "dreamdex") return;

    const normTx = txHash.trim().toLowerCase();
    if (this.host.processedGasTxHashes.has(normTx)) {
      return;
    }

    try {
      const getFeeFn = (this.host.binance as any).getTransactionFee;
      let feeSomi: number | undefined;
      if (typeof getFeeFn === "function") {
        feeSomi = await (this.host.binance as any).getTransactionFee(txHash);
      }
      if (feeSomi !== undefined && feeSomi > 0) {
        if (this.host.processedGasTxHashes.has(normTx)) {
          return;
        }
        this.host.processedGasTxHashes.add(normTx);
        if (this.host.processedGasTxHashes.size > 2000) {
          const first = this.host.processedGasTxHashes.values().next().value;
          if (first) this.host.processedGasTxHashes.delete(first);
        }

        const isSomiBase = this.host.baseAsset.toUpperCase() === "SOMI";
        if (isSomiBase) {
          this.host.accumulatedGasBase += feeSomi;
          this.host.totalGasSpentBase += feeSomi;
        }
        const somiPrice = isSomiBase ? (this.host.lastRefPrice || this.lotTracker.getAvgEntryPrice() || 0.20) : 0.20;
        const feeQuote = feeSomi * somiPrice;
        this.host.accumulatedGasQuote += feeQuote;
        this.host.totalGasSpentQuote += feeQuote;
        this.host.totalTxCount++;

        this.host.log(
          `⛽ [GAS TRACKED] ${label || "Tx"} (${txHash.slice(0, 10)}...): Spent ${feeSomi.toFixed(5)} SOMI (~$${feeQuote.toFixed(4)}) | Total uncompensated gas: ${this.host.accumulatedGasBase.toFixed(5)} ${isSomiBase ? "SOMI" : this.host.baseAsset}`,
        );

        if (typeof (this.host.db as any).updateTxGas === "function") {
          try {
            (this.host.db as any).updateTxGas(txHash, {
              gasUsed: 0,
              gasSomi: feeSomi,
              gasUsdso: feeQuote,
            });
          } catch {}
        }

        this.host.saveState();
        this.host.emitTelemetryTick();
      }
    } catch (err) {
      this.host.log(`⚠️ Failed to track gas for tx ${txHash}: ${(err as Error).message}`);
    }
  }

  /**
   * Cancel a single open order with explicit on-chain & dry-run logging
   */
  public async cancelOrderInternal(order: OpenOrder, reason: string): Promise<void> {
    const sideStr = order.isBid ? "BUY" : "SELL";
    const orderNotional = (order.notionalQuote !== undefined ? order.notionalQuote : order.notionalUsdso) || (order.price * order.qty);
    if (this.host.cfg.dryRun) {
      const isDex = this.host.binance.hasGasFees || this.host.binance.isDex || this.host.binance.exchangeName === "dreamdex";
      if (isDex) {
        const isSomiBase = this.host.baseAsset.toUpperCase() === "SOMI";
        const dryGasSomi = 0.001;
        if (isSomiBase) {
          this.host.accumulatedGasBase += dryGasSomi;
          this.host.totalGasSpentBase += dryGasSomi;
        }
        const somiPrice = isSomiBase ? order.price : 0.20;
        const dryGasQuote = dryGasSomi * somiPrice;
        this.host.accumulatedGasQuote += dryGasQuote;
        this.host.totalGasSpentQuote += dryGasQuote;
        this.host.totalTxCount++;
      }

      this.host.log(
        `[dry-run] 🗑️ CANCELLED ${sideStr} LIMIT @ $${order.price.toFixed(6)} (${order.qty.toFixed(4)} ${this.host.baseAsset} | $${orderNotional.toFixed(2)} ${this.host.quoteAsset}) • ${order.levelDesc} [${reason}]`,
      );
      this.host.emit({
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
      this.host.cancelledOrderIds.set(order.onChainOrderId, Date.now());
      try {
        const res = await this.host.binance.cancelOrder(this.host.symbol, order.onChainOrderId);
        const txHash = typeof res === "string" ? res : ((res as any)?.txHash || (res as any)?.hash || undefined);
        const txStr = txHash ? ` (tx: ${txHash})` : "";
        this.host.log(
          `🗑️ ON-CHAIN CANCELLED ${sideStr} LIMIT #${order.onChainOrderId} @ $${order.price.toFixed(6)} (${order.qty.toFixed(4)} ${this.host.baseAsset} | $${orderNotional.toFixed(2)} ${this.host.quoteAsset}) • ${order.levelDesc} [${reason}]${txStr}`,
        );
        this.host.emit({
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
        await this.host.refreshWalletBalances();
      } catch (err) {
        this.host.log(
          `⚠️ On-chain cancel order #${order.onChainOrderId} failed: ${(err as Error).message}`,
        );
      }
    }
  }

  /**
   * Place a Maker / Resting Limit Order (Virtual in Dry-Run, On-Chain in Live)
   */
  public async placeRestingOrder(
    isBid: boolean,
    price: number,
    qty: number,
    targetFraction: number,
    notionalQuote: number,
    levelDesc: string,
  ): Promise<void> {
    if (qty < this.host.minQty) return;
    price = roundToTick(price, this.host.tickSize || 0.0001);
    let notionalUsdso = notionalQuote;
    const now = Date.now();
    const sideStr = isBid ? "BUY" : "SELL";
    const orderKey = `${sideStr}_${price.toFixed(6)}`;

    // 1. Guard: Cooldown check
    const cooldownUntil = this.host.orderCooldowns.get(orderKey) ?? 0;
    if (now < cooldownUntil) {
      return;
    }

    // 2. Guard: Check if identical order is currently in-flight
    if (this.host.inFlightOrders.has(orderKey)) {
      return;
    }

    // 3. Guard: Check if an active order at this exact price/side already exists in memory
    const existing = this.host.openOrders.find(
      (o) => o.isBid === isBid && Math.abs(o.price - price) / price < 0.0005,
    );
    if (existing) {
      return;
    }

    // 4. Guard: Live Wallet Balance Verification
    if (!this.host.cfg.dryRun) {
      await this.host.refreshWalletBalances();
      if (isBid) {
        if (this.host.walletQuoteBalance < notionalQuote) {
          if (this.host.walletQuoteBalance >= this.host.minQty * price) {
            const adjustedQty = this.host.walletQuoteBalance / price;
            this.host.log(
              `ℹ️ Auto-adjusting BUY budget from $${notionalQuote.toFixed(2)} to $${this.host.walletQuoteBalance.toFixed(2)} to fit available ${this.host.quoteAsset} balance`,
            );
            qty = adjustedQty;
            notionalQuote = this.host.walletQuoteBalance;
            notionalUsdso = notionalQuote;
          } else {
            this.host.log(
              `⚠️ Insufficient ${this.host.quoteAsset} balance for BUY order (Wallet: $${this.host.walletQuoteBalance.toFixed(2)} | Needed: $${notionalQuote.toFixed(2)}). Skipping placement.`,
            );
            this.host.orderCooldowns.set(orderKey, now + 15000);
            return;
          }
        }
      } else {
        const minReserveBase = this.host.getEffectiveGasReserveBase();
        const availableBaseInWallet = Math.max(0, this.host.walletBaseBalance - minReserveBase);

        if (availableBaseInWallet < this.host.minQty) {
          this.host.log(
            `🛑 [BALANCE GUARD] Skipping SELL order: Wallet has ${this.host.walletBaseBalance.toFixed(4)} ${this.host.baseAsset}, which is below minimum trading size.`,
          );
          this.host.orderCooldowns.set(orderKey, now + 15000);
          return;
        }

        const tradingHeld = this.lotTracker.baseHeld();
        const otherSellOrdersQty = this.host.openOrders
          .filter((o) => !o.isBid && o.levelDesc !== levelDesc)
          .reduce((sum, o) => sum + o.qty, 0);
        const remainingTradingQty = Math.max(0, Math.min(tradingHeld - otherSellOrdersQty, availableBaseInWallet));

        if (remainingTradingQty < this.host.minQty) {
          this.host.log(
            `🛑 [INVENTORY GUARD] Skipping SELL order: Strategy trading inventory is ${tradingHeld.toFixed(4)} ${this.host.baseAsset} (Active sells: ${otherSellOrdersQty.toFixed(4)} ${this.host.baseAsset} | Safe wallet available: ${availableBaseInWallet.toFixed(4)} ${this.host.baseAsset}). Protected wallet balance from non-trading dilution (Wallet: ${this.host.walletBaseBalance.toFixed(4)} ${this.host.baseAsset}).`,
          );
          this.host.orderCooldowns.set(orderKey, now + 15000);
          return;
        }

        if (qty > remainingTradingQty) {
          this.host.log(
            `ℹ️ [INVENTORY GUARD] Clamping SELL order qty from ${qty.toFixed(4)} to ${remainingTradingQty.toFixed(4)} ${this.host.baseAsset} to protect wallet balance and inventory.`,
          );
          qty = remainingTradingQty;
          notionalQuote = qty * price;
          notionalUsdso = notionalQuote;
        }
      }
    }

    qty = roundToStep(qty, this.getStepSize(), this.host.qtyPrecision);
    if (qty < this.host.minQty) {
      return;
    }
    notionalQuote = qty * price;
    notionalUsdso = notionalQuote;

    const minNotional = Math.max(this.host.minNotional || 5.0, 5.0);
    if (notionalQuote < minNotional) {
      this.host.log(
        `⚠️ [MIN NOTIONAL GUARD] Skipping ${sideStr} order placement @ $${price.toFixed(6)}: Order notional $${notionalQuote.toFixed(2)} is below minimum requirement ($${minNotional.toFixed(2)}).`,
      );
      this.host.orderCooldowns.set(orderKey, now + 15000);
      return;
    }

    this.host.inFlightOrders.add(orderKey);

    const id = `order_${isBid ? "buy" : "sell"}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const supportsExpiry = Boolean(this.host.binance.supportsOrderExpiry);
    const expireHours = supportsExpiry ? (this.host.cfg.orderExpireHours ?? 24) : undefined;
    const expireTime = (supportsExpiry && expireHours) ? (now + expireHours * 3600 * 1000) : undefined;
    const expireLogSuffix = (supportsExpiry && expireHours) ? ` [Expires in ${expireHours}h]` : "";

    if (this.host.cfg.dryRun) {
      try {
        const isDex = this.host.binance.hasGasFees || this.host.binance.isDex || this.host.binance.exchangeName === "dreamdex";
        if (isDex) {
          const isSomiBase = this.host.baseAsset.toUpperCase() === "SOMI";
          const dryGasSomi = 0.002;
          if (isSomiBase) {
            this.host.accumulatedGasBase += dryGasSomi;
            this.host.totalGasSpentBase += dryGasSomi;
          }
          const somiPrice = isSomiBase ? price : 0.20;
          const dryGasQuote = dryGasSomi * somiPrice;
          this.host.accumulatedGasQuote += dryGasQuote;
          this.host.totalGasSpentQuote += dryGasQuote;
          this.host.totalTxCount++;
        }

        this.host.openOrders.push({
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
        this.host.log(
          `[dry-run] 📋 CREATED ${sideStr} LIMIT @ $${price.toFixed(6)} (${qty.toFixed(4)} ${this.host.baseAsset} | $${notionalQuote.toFixed(2)} ${this.host.quoteAsset}) • ${levelDesc}${expireLogSuffix}`,
        );
        this.host.emit({
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
        this.host.saveState();
      } finally {
        this.host.inFlightOrders.delete(orderKey);
      }
      return;
    }

    try {
      const res = await this.host.binance.placeOrder({
        symbol: this.host.symbol,
        side: isBid ? "BUY" : "SELL",
        type: "LIMIT",
        price,
        qty,
        clientOrderId: id,
        expireHours,
      });
      const orderIdStr = res.orderId ? res.orderId.toString() : undefined;
      this.host.openOrders.push({
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
      this.host.log(
        `🚀 CREATED ${sideStr} LIMIT ${orderIdStr ? `#${orderIdStr} ` : ""}@ $${price.toFixed(6)} (${qty.toFixed(4)} ${this.host.baseAsset} | $${notionalQuote.toFixed(2)} ${this.host.quoteAsset}) • ${levelDesc}${expireLogSuffix}${txDesc}`,
      );
      this.host.emit({
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
      this.host.saveState();
      await this.host.refreshWalletBalances();
    } catch (err) {
      this.host.log(`⚠️ Place on-chain ${sideStr} order failed: ${(err as Error).message}`);
      this.host.orderCooldowns.set(orderKey, now + 15000);
      await this.host.syncOnChainOrders();
    } finally {
      this.host.inFlightOrders.delete(orderKey);
    }
  }

  /**
   * Cancel resting Maker limit orders (virtual in Dry-Run, on-chain in Live)
   */
  public async cancelAllRestingOrders(side?: "BUY" | "SELL", reason = "Strategy reset / Channel shifted"): Promise<void> {
    const toCancel = this.host.openOrders.filter((o) => (side ? (side === "BUY" ? o.isBid : !o.isBid) : true));
    this.host.openOrders = this.host.openOrders.filter((o) => (side ? (side === "BUY" ? !o.isBid : o.isBid) : false));
    const now = Date.now();
    for (const order of toCancel) {
      if (order.onChainOrderId) this.host.cancelledOrderIds.set(order.onChainOrderId, now);
    }
    this.host.saveState();

    for (const order of toCancel) {
      await this.cancelOrderInternal(order, reason);
    }

    if (!this.host.cfg.dryRun && this.host.binance.hasCredentials()) {
      try {
        if (!side) {
          const hashes = await this.host.binance.cancelAllOpenOrders(this.host.symbol);
          if (Array.isArray(hashes)) {
            for (const h of hashes) {
              if (typeof h === "string") {
                this.trackTxGas(h, "Cancel All Sweep");
              }
            }
          }
        } else {
          const live = await this.host.binance.getOpenOrders(this.host.symbol);
          for (const o of live) {
            const matches = (side === "BUY" && o.side === "BUY") || (side === "SELL" && o.side === "SELL");
            if (matches) {
              const h = await this.host.binance.cancelOrder(this.host.symbol, o.orderId);
              if (typeof h === "string") {
                this.trackTxGas(h, `Cancel ${side} Order Sweep #${o.orderId}`);
              }
            }
          }
        }
      } catch (err) {
        this.host.log(`⚠️ Binance cancel sweep error: ${(err as Error).message}`);
      }
      await this.host.refreshWalletBalances();
    }
    this.host.saveState();
  }

  /**
   * Helper to compute CEX spot fee in quote currency (USDT) and base currency deduction (if fee was paid in base asset).
   */
  public calculateSpotFeeQuote(opts: {
    fee?: number;
    feeAsset?: string | null;
    price: number;
    qty: number;
    dryRun?: boolean;
    isIoc?: boolean;
  }): { feeQuote: number; feeBase: number; feeAsset: string } {
    const isDex = this.host.binance.hasGasFees || this.host.binance.isDex || this.host.binance.exchangeName === "dreamdex";
    if (isDex || opts.dryRun) {
      return { feeQuote: 0, feeBase: 0, feeAsset: "" };
    }
    const fillNotional = opts.price * opts.qty;
    const isZeroFeeMaker = (this.host.quoteAsset.toUpperCase() === "FDUSD" && !opts.isIoc);
    if (isZeroFeeMaker) {
      return { feeQuote: 0, feeBase: 0, feeAsset: "FDUSD" };
    }

    const rawFee = Number(opts.fee || 0);
    const feeAssetUpper = (opts.feeAsset || "").toUpperCase();
    const quoteSym = (this.host.quoteAsset || "USDT").toUpperCase();
    const baseSym = (this.host.baseAsset || "").toUpperCase();

    let feeQuote = 0;
    let feeBase = 0;

    if (rawFee > 0) {
      if (feeAssetUpper === quoteSym || ["USDT", "USDSO", "FDUSD", "USDC", "USD"].includes(feeAssetUpper)) {
        feeQuote = rawFee;
      } else if (feeAssetUpper === baseSym && opts.price > 0) {
        feeQuote = rawFee * opts.price;
        feeBase = rawFee;
      } else if (feeAssetUpper === "BNB" && fillNotional > 0) {
        feeQuote = fillNotional * 0.00075;
      } else if (fillNotional > 0) {
        feeQuote = fillNotional * 0.00075;
      }
      return { feeQuote, feeBase, feeAsset: opts.feeAsset || quoteSym };
    }

    // Default CEX fee rate (0.075% BNB discount tier or standard)
    feeQuote = fillNotional * 0.00075;
    return { feeQuote, feeBase: 0, feeAsset: "BNB" };
  }

  /**
   * Shared helper: Process a confirmed BUY fill (gas compensation, lot creation, emit, log)
   */
  public processBuyFill(opts: {
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
    fee?: number;
    feeAsset?: string | null;
  }): void {
    const { price, qty, levelDesc, orderId, txHash, logPrefix = "", dryRun, isIoc = false, targetPrice, slippagePct, limitPrice } = opts;
    const fillNotional = price * qty;
    const now = Date.now();

    const isDex = this.host.binance.hasGasFees || this.host.binance.isDex || this.host.binance.exchangeName === "dreamdex";
    const isSomiBase = isDex && this.host.baseAsset.toUpperCase() === "SOMI";

    let spotTradingFeeBase = 0;
    let spotTradingFeeQuote = 0;
    let compBase = 0;
    let gasLossQuote = 0;
    let feeLog = "";

    if (!isDex) {
      const feeCalc = this.calculateSpotFeeQuote({
        fee: opts.fee,
        feeAsset: opts.feeAsset,
        price,
        qty,
        dryRun,
        isIoc,
      });
      spotTradingFeeQuote = feeCalc.feeQuote;
      spotTradingFeeBase = feeCalc.feeBase;
      if (spotTradingFeeQuote > 0) {
        this.host.totalGasSpentQuote += spotTradingFeeQuote;
        this.host.totalGasDeductedQuote += spotTradingFeeQuote;
        this.host.realizedPnl = this.host.tradeRealizedPnl - this.host.totalGasDeductedQuote;
        feeLog = ` | 🏷️ Fee: -$${spotTradingFeeQuote.toFixed(4)} ${this.host.quoteAsset}`;
      }
    } else {
      const uncompensatedGas = isSomiBase
        ? Math.max(this.host.accumulatedGasBase, this.host.totalGasSpentBase - this.host.totalGasDeductedBase)
        : 0;

      if (uncompensatedGas > 0) {
        const maxComp = Math.max(0, qty * 0.5);
        compBase = Math.min(uncompensatedGas, maxComp);
        if (compBase > 0) {
          gasLossQuote = compBase * price;
          this.host.accumulatedGasBase = Math.max(0, this.host.accumulatedGasBase - compBase);
          this.host.accumulatedGasQuote = Math.max(0, this.host.accumulatedGasQuote - gasLossQuote);
          this.host.totalGasDeductedBase += compBase;
          this.host.totalGasDeductedQuote += gasLossQuote;
          this.host.realizedPnl = this.host.tradeRealizedPnl - this.host.totalGasDeductedQuote;
        }
      }
    }

    const rawNetQty = Math.max(0, qty - compBase - spotTradingFeeBase);
    const netQty = roundToStep(rawNetQty, this.getStepSize(), this.host.qtyPrecision);
    const activeZoneIndex = Math.max(0, (this.host.unlockedCapitalZones ?? 1) - 1);
    this.host.lots.push({ price, qty: netQty, time: now, zoneIndex: activeZoneIndex });
    this.host.lastBuyFillTime = now;
    this.host.lastBuyFillPrice = price;
    if (this.host.confirmedChannel?.candleTime) {
      this.host.lastBuyFillCandleTime = this.host.confirmedChannel.candleTime;
    } else {
      const closed = this.host.dowEngine?.getClosedCandles();
      if (closed && closed.length > 0) {
        this.host.lastBuyFillCandleTime = closed[closed.length - 1].time;
      }
    }
    this.host.needsSellRebalance = true;
    this.host.needsBuyRebalance = true;
    this.host.iocBracketSellCycle = undefined;
    if (this.host.soldSellIndices.size > 0) {
      this.host.log(`🔄 [Sell Cycle] New BUY fill received — resetting sold sell targets to re-enable full ladder`);
      this.host.soldSellIndices.clear();
    }
    this.host.saveState();

    const gasCompLog = compBase > 0
      ? ` | ⛽ Gas Compensated: ${compBase.toFixed(4)} ${this.host.baseAsset} (-$${gasLossQuote.toFixed(4)}) returned to wallet gas reserve`
      : "";
    const fillLabel = isIoc ? "IOC BUY FILLED" : "MAKER BUY FILLED";
    const iocLog = (isIoc && (targetPrice !== undefined || limitPrice !== undefined))
      ? ` [Target: $${(targetPrice ?? price).toFixed(6)} | Slip: ${(slippagePct ?? 0.2).toFixed(2)}% | Limit: $${(limitPrice ?? price).toFixed(6)}]`
      : "";
    this.host.log(
      `⚡ ${logPrefix}${fillLabel}: ${qty.toFixed(4)} ${this.host.baseAsset} ($${fillNotional.toFixed(2)} ${this.host.quoteAsset}) @ $${price.toFixed(6)} • ${levelDesc}${iocLog}${orderId ? ` #${orderId}` : ""}${feeLog}${gasCompLog}`,
    );
    this.host.emit({
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
        gasFeeQuote: spotTradingFeeQuote,
        gasFeeUsdso: spotTradingFeeQuote,
        fee: opts.fee !== undefined ? opts.fee : (spotTradingFeeQuote > 0 ? (spotTradingFeeQuote / price) : undefined),
        feeAsset: opts.feeAsset ?? (spotTradingFeeQuote > 0 ? (opts.fee !== undefined ? "BNB" : this.host.quoteAsset) : undefined),
        notional: fillNotional,
        notionalQuote: fillNotional,
        notionalUsdso: fillNotional,
        levelDesc,
        orderId,
        txHash,
        reason: isIoc
          ? `IOC Fill${compBase > 0 ? ` (Comp: ${compBase.toFixed(4)} ${this.host.baseAsset})` : ""}`
          : `Maker Buy Filled${orderId ? ` #${orderId}` : ""}${compBase > 0 ? ` (Comp: ${compBase.toFixed(4)} ${this.host.baseAsset})` : ""}`,
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
  public processSellFill(opts: {
    price: number;
    qty: number;
    levelDesc: string;
    orderId?: string;
    txHash?: string;
    logPrefix?: string;
    dryRun: boolean;
    fee?: number;
    feeAsset?: string | null;
  }): void {
    const { price, qty, levelDesc, orderId, txHash, logPrefix = "", dryRun } = opts;
    const fillNotional = price * qty;
    const now = Date.now();

    const isDex = this.host.binance.hasGasFees || this.host.binance.isDex || this.host.binance.exchangeName === "dreamdex";
    let spotTradingFeeQuote = 0;
    let feeLog = "";

    if (!isDex) {
      const feeCalc = this.calculateSpotFeeQuote({
        fee: opts.fee,
        feeAsset: opts.feeAsset,
        price,
        qty,
        dryRun,
        isIoc: false,
      });
      spotTradingFeeQuote = feeCalc.feeQuote;
      if (spotTradingFeeQuote > 0) {
        this.host.totalGasSpentQuote += spotTradingFeeQuote;
        this.host.totalGasDeductedQuote += spotTradingFeeQuote;
        this.host.realizedPnl = this.host.tradeRealizedPnl - this.host.totalGasDeductedQuote;
        feeLog = ` | 🏷️ Fee: -$${spotTradingFeeQuote.toFixed(4)} ${this.host.quoteAsset}`;
      }
    }

    const { roundPnl } = this.lotTracker.closeLots(qty, price);
    this.host.needsBuyRebalance = true;

    const remainingHeldAfterFill = this.lotTracker.baseHeld();
    const dustThreshold = (this.host.minQty ? this.host.minQty * 0.5 : 1e-6);
    if (remainingHeldAfterFill < dustThreshold) {
      this.host.soldSellIndices.clear();
      this.host.iocBracketSellCycle = undefined;
    } else {
      const soldIdx = this.findSellLevelIndex(levelDesc, price);
      if (soldIdx >= 0) {
        this.host.soldSellIndices.add(soldIdx);
        this.host.log(`🎯 [Sell Cycle] Marked Sell Target ${soldIdx + 1} as SOLD for current inventory wave (sold: [${Array.from(this.host.soldSellIndices).map((i) => i + 1).join(", ")}])`);
      }
    }
    this.host.saveState();

    if (this.host.cutLossStage1Executed && (levelDesc === "Cut Loss Bounce Exit (50%)" || remainingHeldAfterFill < dustThreshold)) {
      this.host.cutLossStage1Executed = false;
      this.host.cutLossStage1Price = undefined;
      this.host.cutLossStage1CandleTime = undefined;
      this.host.cutLossStage1Time = undefined;
      this.host.log(`🎉 [BOUNCE EXIT FILLED] Remaining position exited successfully on bounce! Two-stage de-risk cycle complete.`);
    }

    this.host.log(
      `🎯 ${logPrefix}MAKER SELL FILLED: ${qty.toFixed(4)} ${this.host.baseAsset} ($${fillNotional.toFixed(2)} ${this.host.quoteAsset}) @ $${price.toFixed(6)} • ${levelDesc}${orderId ? ` #${orderId}` : ""}${feeLog} (Trade PnL: ${roundPnl >= 0 ? "+$" : "-$"}${Math.abs(roundPnl).toFixed(4)} | Net: ${this.host.realizedPnl >= 0 ? "+$" : "-$"}${Math.abs(this.host.realizedPnl).toFixed(4)})`,
    );
    this.host.emit({
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
        gasFeeQuote: spotTradingFeeQuote,
        gasFeeUsdso: spotTradingFeeQuote,
        fee: opts.fee !== undefined ? opts.fee : (spotTradingFeeQuote > 0 ? (spotTradingFeeQuote / price) : undefined),
        feeAsset: opts.feeAsset ?? (spotTradingFeeQuote > 0 ? (opts.fee !== undefined ? "BNB" : this.host.quoteAsset) : undefined),
        reason: `Maker Sell Filled${orderId ? ` #${orderId}` : ""}`,
        time: now,
        dryRun,
        maker: true,
      },
    });
    this.host.stuckSince = undefined;
  }

  /**
   * Evaluate fills on active resting limit orders against real-time market price and candle range
   */
  public async checkOrderFills(bestBid: number, bestAsk: number, mid: number): Promise<void> {
    if (!this.host.cfg.dryRun) return;

    const remainingOpenOrders: OpenOrder[] = [];
    const binancePrice = this.host.atrSource.getLatestPrice?.();
    const candles = this.host.dowEngine?.getCandles() ?? [];
    const latestCandle = candles.length > 0 ? candles[candles.length - 1] : undefined;
    const candleLow = latestCandle ? latestCandle.low : mid;
    const candleHigh = latestCandle ? latestCandle.high : mid;

    for (const order of this.host.openOrders) {
      if (order.isBid) {
        const effectiveLowPrice = binancePrice !== undefined ? Math.min(mid, binancePrice, candleLow) : Math.min(mid, candleLow);
        const isFilled = (bestAsk !== undefined && bestAsk <= order.price) || (effectiveLowPrice <= order.price);
        if (isFilled) {
          this.processBuyFill({
            price: order.price,
            qty: order.qty,
            levelDesc: `${order.levelDesc} (${(order.targetFraction * 100).toFixed(0)}% Target)`,
            dryRun: this.host.cfg.dryRun,
          });
          continue;
        }
      } else {
        const effectiveHighPrice = binancePrice !== undefined ? Math.max(mid, binancePrice, candleHigh) : Math.max(mid, candleHigh);
        const isFilled = (bestBid !== undefined && bestBid >= order.price) || (effectiveHighPrice >= order.price);
        if (isFilled && this.lotTracker.baseHeld() > 0) {
          const isFullClose = order.targetFraction === 0 || order.qty >= this.lotTracker.baseHeld() * 0.98;
          const fillQty = isFullClose ? this.lotTracker.baseHeld() : Math.min(order.qty, this.lotTracker.baseHeld());
          this.processSellFill({
            price: order.price,
            qty: fillQty,
            levelDesc: `${order.levelDesc} (${(order.targetFraction * 100).toFixed(0)}% Target)`,
            dryRun: this.host.cfg.dryRun,
          });
          continue;
        }
      }
      remainingOpenOrders.push(order);
    }

    if (remainingOpenOrders.length !== this.host.openOrders.length) {
      this.host.openOrders = remainingOpenOrders;
      this.host.saveState();
    }
  }

  /**
   * Execute an immediate IOC sell for a specific tranche / grid level or aggregated tranches.
   */
  public async sellTrancheIOC(
    qty: number,
    execPrice: number,
    levelName: string,
    targetPrice: number,
    allowLoss = false,
  ): Promise<boolean> {
    const actionLabel = levelName.startsWith("IOC") ? levelName : `IOC ${levelName}`;
    const held = this.lotTracker.baseHeld();
    if (held < this.host.minQty || qty < this.host.minQty) {
      return false;
    }
    const executeQty = roundToStep(Math.min(held, qty), this.getStepSize(), this.host.qtyPrecision);
    if (executeQty < this.host.minQty) {
      return false;
    }
    const now = Date.now();
    const effectivePrice = allowLoss ? (execPrice > 0 ? execPrice : targetPrice) : Math.max(execPrice, targetPrice);
    const minNotional = Math.max(this.host.minNotional || 5.0, 5.0);
    const orderNotional = executeQty * effectivePrice;

    if (orderNotional < minNotional) {
      this.host.log(
        `⚠️ [MIN NOTIONAL GUARD] Cannot execute ${actionLabel}: Order value $${orderNotional.toFixed(2)} is below Binance minimum ($${minNotional.toFixed(2)}).`,
      );
      return false;
    }

    if (this.host.cfg.dryRun) {
      const slippagePctVal = this.host.cfg.iocSlippagePct ?? 0.2;
      const dryLimitPrice = roundToTick(targetPrice * (1 - slippagePctVal / 100), this.host.tickSize || 0.0001);
      const { roundPnl } = this.lotTracker.closeLots(executeQty, effectivePrice);
      const remainingHeld = this.lotTracker.baseHeld();
      const dustThreshold = (this.host.minQty ? this.host.minQty * 0.5 : 1e-6);
      if (remainingHeld < dustThreshold) {
        this.host.soldSellIndices.clear();
        this.host.iocBracketSellCycle = undefined;
      } else {
        const soldIdx = this.findSellLevelIndex(actionLabel, effectivePrice);
        if (soldIdx >= 0) {
          this.host.soldSellIndices.add(soldIdx);
          this.host.log(
            `🎯 [Sell Cycle] Marked Sell Target ${soldIdx + 1} as SOLD for current inventory wave (sold: [${Array.from(this.host.soldSellIndices).map((i) => i + 1).join(", ")}])`,
          );
        }
      }
      this.host.log(
        `[dry-run] ⚡ ${actionLabel}: Sold ${executeQty.toFixed(4)} ${this.host.baseAsset} @ $${effectivePrice.toFixed(6)} | Target: $${targetPrice.toFixed(6)} | Slip: ${slippagePctVal.toFixed(2)}% | Limit: $${dryLimitPrice.toFixed(6)} • Trade PnL: ${roundPnl >= 0 ? "+$" : "-$"}${Math.abs(roundPnl).toFixed(4)} | Net: ${this.host.realizedPnl >= 0 ? "+$" : "-$"}${Math.abs(this.host.realizedPnl).toFixed(4)}`,
      );
      this.host.emit({
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
      this.host.saveState();
      this.host.emitTelemetryTick();
      return true;
    }

    await this.host.refreshWalletBalances();

    const minGasReserveBase = this.host.getEffectiveGasReserveBase();
    const availableBase = Math.max(0, this.host.walletBaseBalance - minGasReserveBase);

    if (availableBase < this.host.minQty) {
      this.host.log(
        `⚠️ [GAS GUARD] Cannot execute ${actionLabel}: Wallet has ${this.host.walletBaseBalance.toFixed(4)} ${this.host.baseAsset}, which is within the ${minGasReserveBase.toFixed(4)} ${this.host.baseAsset} gas safety reserve.`,
      );
      return false;
    }

    const finalQty = roundToStep(Math.min(executeQty, availableBase), this.getStepSize(), this.host.qtyPrecision);
    if (finalQty < this.host.minQty) return false;

    try {
      const avgEntry = this.lotTracker.getAvgEntryPrice();
      const slippagePctVal = this.host.cfg.iocSlippagePct ?? 0.2;
      const slippagePct = slippagePctVal / 100;
      const minAllowedBySlippage = targetPrice * (1 - slippagePct);
      const minProfitablePrice = (!allowLoss && avgEntry > 0) ? avgEntry * this.host.getMinProfitMultiplier() : minAllowedBySlippage;
      const minAllowedPrice = Math.max(minProfitablePrice, minAllowedBySlippage);
      const basePrice = (execPrice > 0) ? execPrice : targetPrice;
      let limitPrice = Math.max(minAllowedPrice, basePrice * (1 - slippagePct));
      limitPrice = roundToTick(limitPrice, this.host.tickSize || 0.0001);
      const res = await this.host.binance.placeOrder({
        symbol: this.host.symbol,
        side: "SELL",
        type: "IOC",
        price: limitPrice,
        qty: finalQty,
      });

      const orderIdStr = res.orderId ? String(res.orderId) : (res.txHash ? String(res.txHash) : undefined);
      if (orderIdStr) {
        this.host.handledExitOrderIds.set(orderIdStr, Date.now());
      }

      const isConfirmedSuccess = res.status === "FILLED" || (res.txHash && res.status !== "CANCELED" && res.status !== "EXPIRED");
      const filledQty = typeof res.executedQty === "number" && !isNaN(res.executedQty) && res.executedQty > 0
        ? res.executedQty
        : (isConfirmedSuccess ? finalQty : 0);

      if (filledQty <= 0 && !isConfirmedSuccess) {
        this.host.log(
          `⚠️ [IOC UNFILLED] ${actionLabel} order #${orderIdStr || "N/A"} was not filled on exchange (status: ${res.status || "UNFILLED"}, executedQty: ${filledQty}/${finalQty}).`,
        );
        return false;
      }

      const actualQty = Math.min(finalQty, filledQty > 0 ? filledQty : finalQty);
      const fillPrice = (typeof res.cummulativeQuoteQty === "number" && res.cummulativeQuoteQty > 0 && typeof res.executedQty === "number" && res.executedQty > 0)
        ? (res.cummulativeQuoteQty / res.executedQty)
        : (typeof res.price === "number" && res.price > 0 ? res.price : effectivePrice);

      let totalCommission = 0;
      let commissionAsset = "";
      if (Array.isArray(res.fills)) {
        for (const fill of res.fills) {
          totalCommission += Number(fill.commission || 0);
          if (fill.commissionAsset) commissionAsset = fill.commissionAsset;
        }
      }
      const feeCalc = this.calculateSpotFeeQuote({
        fee: totalCommission > 0 ? totalCommission : undefined,
        feeAsset: commissionAsset || undefined,
        price: fillPrice,
        qty: actualQty,
        dryRun: false,
        isIoc: true,
      });
      if (feeCalc.feeQuote > 0) {
        this.host.totalGasSpentQuote += feeCalc.feeQuote;
        this.host.totalGasDeductedQuote += feeCalc.feeQuote;
        this.host.realizedPnl = this.host.tradeRealizedPnl - this.host.totalGasDeductedQuote;
      }

      const { roundPnl } = this.lotTracker.closeLots(actualQty, fillPrice);
      const remainingHeld = this.lotTracker.baseHeld();
      const dustThreshold = (this.host.minQty ? this.host.minQty * 0.5 : 1e-6);
      if (remainingHeld < dustThreshold) {
        this.host.soldSellIndices.clear();
        this.host.iocBracketSellCycle = undefined;
      } else {
        const soldIdx = this.findSellLevelIndex(actionLabel, fillPrice);
        if (soldIdx >= 0) {
          this.host.soldSellIndices.add(soldIdx);
          this.host.log(
            `🎯 [Sell Cycle] Marked Sell Target ${soldIdx + 1} as SOLD for current inventory wave (sold: [${Array.from(this.host.soldSellIndices).map((i) => i + 1).join(", ")}])`,
          );
        }
      }

      const feeLog = feeCalc.feeQuote > 0 ? ` | 🏷️ Fee: -$${feeCalc.feeQuote.toFixed(4)} ${this.host.quoteAsset}` : "";
      this.host.log(
        `⚡ ON-CHAIN ${actionLabel}: Sold ${actualQty.toFixed(4)} ${this.host.baseAsset} @ $${fillPrice.toFixed(6)} | Target: $${targetPrice.toFixed(6)} | Slip: ${slippagePctVal.toFixed(2)}% | Limit: $${limitPrice.toFixed(6)}${feeLog} • Trade PnL: ${roundPnl >= 0 ? "+$" : "-$"}${Math.abs(roundPnl).toFixed(4)} | Net: ${this.host.realizedPnl >= 0 ? "+$" : "-$"}${Math.abs(this.host.realizedPnl).toFixed(4)} (tx: ${res.txHash || orderIdStr || "N/A"})`,
      );
      this.host.emit({
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
          gasFeeQuote: feeCalc.feeQuote,
          gasFeeUsdso: feeCalc.feeQuote,
          fee: totalCommission > 0 ? totalCommission : (feeCalc.feeQuote > 0 ? feeCalc.feeQuote : undefined),
          feeAsset: commissionAsset || (feeCalc.feeQuote > 0 ? feeCalc.feeAsset : undefined),
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
      await this.host.refreshWalletBalances();
      this.host.lastObservedBaseBalance = this.host.walletBaseBalance;
      this.host.lastObservedQuoteBalance = this.host.walletQuoteBalance;
      this.host.saveState();
      this.host.emitTelemetryTick();
      return true;
    } catch (err) {
      this.host.log(`❌ ${actionLabel} failed: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Execute an immediate IOC buy for a specific tranche / grid level or aggregated tranches.
   */
  public async buyTrancheIOC(
    qty: number,
    execPrice: number,
    levelName: string,
    targetPrice: number,
    notionalQuote: number,
  ): Promise<boolean> {
    const actionLabel = levelName.startsWith("IOC") ? levelName : `IOC ${levelName}`;
    const minNotional = Math.max(this.host.minNotional || 5.0, 5.0);
    if (qty < this.host.minQty || notionalQuote < minNotional) {
      if (notionalQuote < minNotional) {
        this.host.log(
          `⚠️ [MIN NOTIONAL GUARD] Cannot execute ${actionLabel}: Buy budget $${notionalQuote.toFixed(2)} is below Binance minimum ($${minNotional.toFixed(2)}).`,
        );
      }
      return false;
    }
    const now = Date.now();
    const effectivePrice = Math.min(execPrice, targetPrice);

    if (this.host.cfg.dryRun) {
      const rawBuyQty = notionalQuote / effectivePrice;
      const buyQty = roundToStep(rawBuyQty, this.getStepSize(), this.host.qtyPrecision);
      if (buyQty < this.host.minQty) return false;
      const slippagePctVal = this.host.cfg.iocSlippagePct ?? 0.2;
      const dryLimitPrice = roundToTick(Math.min(targetPrice, effectivePrice * (1 + slippagePctVal / 100)), this.host.tickSize || 0.0001);
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
      this.host.saveState();
      this.host.emitTelemetryTick();
      return true;
    }

    await this.host.refreshWalletBalances();

    const availableBudgetQuote = Math.min(notionalQuote, this.host.walletQuoteBalance);
    const rawFinalQty = availableBudgetQuote / effectivePrice;
    const finalQty = roundToStep(rawFinalQty, this.getStepSize(), this.host.qtyPrecision);
    if (finalQty < this.host.minQty) {
      this.host.log(`⚠️ [IOC BUY] Insufficient ${this.host.quoteAsset} balance ($${this.host.walletQuoteBalance.toFixed(2)} < $${notionalQuote.toFixed(2)})`);
      return false;
    }

    try {
      const slippagePctVal = this.host.cfg.iocSlippagePct ?? 0.2;
      const slippagePct = slippagePctVal / 100;
      const maxAllowedPrice = targetPrice;
      const basePrice = (execPrice > 0) ? execPrice : targetPrice;
      let limitPrice = Math.min(maxAllowedPrice, basePrice * (1 + slippagePct));
      limitPrice = roundToTick(limitPrice, this.host.tickSize || 0.0001);
      const res = await this.host.binance.placeOrder({
        symbol: this.host.symbol,
        side: "BUY",
        type: "IOC",
        price: limitPrice,
        qty: finalQty,
      });

      const orderIdStr = res.orderId ? String(res.orderId) : (res.txHash ? String(res.txHash) : undefined);
      if (orderIdStr) {
        this.host.handledExitOrderIds.set(orderIdStr, Date.now());
      }

      const isConfirmedSuccess = res.status === "FILLED" || (res.txHash && res.status !== "CANCELED" && res.status !== "EXPIRED");
      const filledQty = typeof res.executedQty === "number" && !isNaN(res.executedQty) && res.executedQty > 0
        ? res.executedQty
        : (isConfirmedSuccess ? finalQty : 0);

      if (filledQty <= 0 && !isConfirmedSuccess) {
        this.host.log(
          `⚠️ [IOC UNFILLED] ${actionLabel} order #${orderIdStr || "N/A"} was not filled on exchange (status: ${res.status || "UNFILLED"}, executedQty: ${filledQty}/${finalQty}).`,
        );
        return false;
      }

      if (res.gasFee !== undefined && res.gasFee > 0) {
        const txKey = (res.txHash || "").trim().toLowerCase();
        const alreadyTracked = txKey ? this.host.processedGasTxHashes.has(txKey) : false;
        if (!alreadyTracked && !this.host.binance.onGasSpent) {
          if (txKey) {
            this.host.processedGasTxHashes.add(txKey);
          }
          const isSomiBase = this.host.baseAsset.toUpperCase() === "SOMI";
          if (isSomiBase) {
            this.host.accumulatedGasBase += res.gasFee;
            this.host.totalGasSpentBase += res.gasFee;
          }
          const somiPrice = isSomiBase ? (effectivePrice || 0.20) : 0.20;
          this.host.accumulatedGasQuote += res.gasFee * somiPrice;
          this.host.totalGasSpentQuote += res.gasFee * somiPrice;
          this.host.totalTxCount++;
        }
        this.host.log(`⛽ [GAS ON BUY] Spent ${res.gasFee.toFixed(5)} SOMI on this IOC buy transaction. Included in uncompensated gas.`);
      }

      const actualQty = Math.min(finalQty, filledQty > 0 ? filledQty : finalQty);
      const fillPrice = (typeof res.cummulativeQuoteQty === "number" && res.cummulativeQuoteQty > 0 && typeof res.executedQty === "number" && res.executedQty > 0)
        ? (res.cummulativeQuoteQty / res.executedQty)
        : (typeof res.price === "number" && res.price > 0 ? res.price : effectivePrice);

      let totalCommission = 0;
      let commissionAsset = "";
      if (Array.isArray(res.fills)) {
        for (const fill of res.fills) {
          totalCommission += Number(fill.commission || 0);
          if (fill.commissionAsset) commissionAsset = fill.commissionAsset;
        }
      }

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
        fee: totalCommission > 0 ? totalCommission : undefined,
        feeAsset: commissionAsset || undefined,
      });
      if (res?.txHash && (res.gasFee === undefined || res.gasFee <= 0)) {
        this.trackTxGas(res.txHash, actionLabel);
      }
      await this.host.refreshWalletBalances();
      this.host.lastObservedBaseBalance = this.host.walletBaseBalance;
      this.host.lastObservedQuoteBalance = this.host.walletQuoteBalance;
      this.host.saveState();
      this.host.emitTelemetryTick();
      return true;
    } catch (err) {
      this.host.log(`❌ ${actionLabel} failed: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Clean exit / Stop-loss liquidation of 100% held position
   */
  public async sellAll(price: number, action: "SELL" | "CUT" | "MANUAL", anchorRefPrice?: number): Promise<boolean> {
    const actionLabel = action === "CUT"
      ? "CUT LOSS (SELL ALL)"
      : (action === "MANUAL" ? "MANUAL SELL ALL (EMERGENCY EXIT)" : "100% FULL EXIT (TAKE PROFIT)");
    const targetPrice = (anchorRefPrice && anchorRefPrice > 0) ? anchorRefPrice : price;
    const slippagePctVal = this.host.cfg.iocSlippagePct ?? 0.35;

    if (this.host.openOrders.length > 0) {
      await this.cancelAllRestingOrders(undefined, `Cancelling open orders before ${actionLabel}`);
      await this.host.refreshWalletBalances();
    }

    const held = this.lotTracker.baseHeld();
    if (held < this.host.minQty) {
      this.host.clearPositionState();
      this.host.saveState();
      return true;
    }
    const now = Date.now();

    if (this.host.cfg.dryRun) {
      const isCut = action === "CUT";
      const isManual = action === "MANUAL";
      const avgEntry = this.lotTracker.getAvgEntryPrice();
      let dryLimitPrice: number;
      if (action === "SELL") {
        const minAllowed = targetPrice * (1 - slippagePctVal / 100);
        const minProfitMult = this.host.getMinProfitMultiplier();
        const minProfitablePrice = avgEntry > 0 ? avgEntry * minProfitMult : minAllowed;
        dryLimitPrice = roundToTick(Math.max(minProfitablePrice, Math.max(minAllowed, price * (1 - slippagePctVal / 100))), this.host.tickSize || 0.0001);
      } else if (action === "MANUAL") {
        dryLimitPrice = roundToTick(price, this.host.tickSize || 0.0001);
      } else {
        dryLimitPrice = roundToTick(targetPrice * (1 - slippagePctVal / 100), this.host.tickSize || 0.0001);
      }
      const effectiveSlipPct = action === "MANUAL" ? 0 : slippagePctVal;
      const { roundPnl } = this.lotTracker.closeLots(held, price);
      const effectiveActionLabel = isCut
        ? "CUT LOSS (SELL ALL)"
        : (isManual ? "MANUAL SELL ALL (EMERGENCY EXIT)" : (roundPnl >= 0 ? "100% FULL EXIT (TAKE PROFIT)" : "BREAKDOWN EXIT (LOSS)"));
      const orderAction = isCut
        ? "CUT"
        : (isManual ? "EXIT" : (roundPnl >= 0 ? "TAKE_PROFIT" : "BREAKDOWN_EXIT"));
      this.host.log(
        `[dry-run] 🚨 ${effectiveActionLabel}: ${held.toFixed(4)} ${this.host.baseAsset} @ $${price.toFixed(6)} | Target: $${targetPrice.toFixed(6)} | Slip: ${effectiveSlipPct.toFixed(2)}% | Limit: $${dryLimitPrice.toFixed(6)} (Trade PnL: ${roundPnl >= 0 ? "+$" : "-$"}${Math.abs(roundPnl).toFixed(4)} | Net Total: ${this.host.realizedPnl >= 0 ? "+$" : "-$"}${Math.abs(this.host.realizedPnl).toFixed(4)})`,
      );
      this.host.emit({
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
      this.host.saveState();
      this.host.emitTelemetryTick();
      return true;
    }

    await this.host.refreshWalletBalances();

    const minGasReserveBase = this.host.getEffectiveGasReserveBase();
    const availableBase = Math.max(0, this.host.walletBaseBalance - minGasReserveBase);

    if (held < this.host.minQty) {
      this.host.log(
        `🛑 [INVENTORY GUARD] ${actionLabel} aborted: Trading inventory is empty (${held.toFixed(4)} ${this.host.baseAsset}). Refusing to sell wallet gas balance (${this.host.walletBaseBalance.toFixed(4)} ${this.host.baseAsset}).`,
      );
      this.host.clearPositionState();
      this.host.saveState();
      return true;
    }

    if (availableBase < this.host.minQty) {
      this.host.log(
        `⚠️ [GAS GUARD] Cannot execute ${actionLabel}: Wallet has ${this.host.walletBaseBalance.toFixed(4)} ${this.host.baseAsset}, which is within the ${minGasReserveBase.toFixed(4)} ${this.host.baseAsset} gas safety reserve. Standing by for balance.`,
      );
      return false;
    }

    const rawExecuteQty = Math.min(held, availableBase > 0 ? availableBase : held);
    const executeQty = roundToStep(rawExecuteQty, this.getStepSize(), this.host.qtyPrecision);
    const minNotional = Math.max(this.host.minNotional || 5.0, 5.0);
    const orderNotional = executeQty * price;

    if (executeQty < this.host.minQty || orderNotional < minNotional) {
      this.host.log(
        `⚠️ [MIN NOTIONAL GUARD] Cannot execute ${actionLabel}: Order quantity ${executeQty.toFixed(4)} or value $${orderNotional.toFixed(2)} is below exchange minimum.`,
      );
      this.host.clearPositionState();
      this.host.saveState();
      return true;
    }

    try {
      let orderType: "MARKET" | "IOC" = "IOC";
      let limitPrice = price;
      const slippagePct = Math.max(0.005, slippagePctVal / 100);

      // On Binance Spot, MARKET sell is natively supported and guaranteed to execute 100% immediately for MANUAL & CUT
      if (this.host.binance.exchangeName === "binance" && (action === "MANUAL" || action === "CUT")) {
        orderType = "MARKET";
        limitPrice = price;
      } else if (action === "CUT") {
        // Stop-loss exit on DEX: allow wider 1.5% slippage to guarantee fill during breakdowns
        const cutSlippage = Math.max(0.015, slippagePct);
        limitPrice = price * (1 - cutSlippage);
        limitPrice = roundToTick(limitPrice, this.host.tickSize || 0.0001);
      } else if (action === "MANUAL") {
        let currentBestBid = 0;
        if (this.host.binance.exchangeName === "dreamdex") {
          try {
            const top = await this.host.binance.getTopOfBook(this.host.symbol, true);
            if (top?.bestBid && top.bestBid > 0) {
              currentBestBid = top.bestBid;
              price = Math.min(price, top.bestBid);
            }
          } catch {}
        } else if (this.host.wsBookTicker && Date.now() - this.host.wsBookTicker.time < 10_000 && this.host.wsBookTicker.bestBid > 0) {
          currentBestBid = this.host.wsBookTicker.bestBid;
        } else {
          try {
            const top = await this.host.binance.getTopOfBook(this.host.symbol, true);
            if (top?.bestBid && top.bestBid > 0) {
              currentBestBid = top.bestBid;
            }
          } catch {}
        }
        const effectiveBid = currentBestBid > 0 ? currentBestBid : (price > 0 ? price : targetPrice);
        // Emergency exit: apply at least 1.0% slippage below best bid so IOC never expires unfilled
        limitPrice = effectiveBid * (1 - Math.max(0.01, slippagePct));
        limitPrice = roundToTick(limitPrice, this.host.tickSize || 0.0001);
      } else if (action === "SELL") {
        let currentBestBid = 0;
        if (this.host.binance.exchangeName === "dreamdex") {
          try {
            const top = await this.host.binance.getTopOfBook(this.host.symbol, false);
            if (top?.bestBid && top.bestBid > 0) {
              currentBestBid = top.bestBid;
              price = Math.min(price, top.bestBid);
            }
          } catch {}
        } else if (this.host.wsBookTicker && Date.now() - this.host.wsBookTicker.time < 10_000 && this.host.wsBookTicker.bestBid > 0) {
          currentBestBid = this.host.wsBookTicker.bestBid;
        } else {
          try {
            const top = await this.host.binance.getTopOfBook(this.host.symbol, false);
            if (top?.bestBid && top.bestBid > 0) {
              currentBestBid = top.bestBid;
            }
          } catch {}
        }
        const avgEntry = this.lotTracker.getAvgEntryPrice();
        const minAllowedBySlippage = targetPrice * (1 - slippagePct);
        const minProfitMult = this.host.getMinProfitMultiplier();
        const minProfitablePrice = avgEntry > 0 ? avgEntry * minProfitMult : minAllowedBySlippage;
        const minAllowedPrice = Math.max(minProfitablePrice, minAllowedBySlippage);
        const basePrice = (price > 0) ? price : targetPrice;
        limitPrice = Math.max(minAllowedPrice, basePrice * (1 - slippagePct));
        limitPrice = roundToTick(limitPrice, this.host.tickSize || 0.0001);
      }

      const exitClientOrderId = `exit_${Date.now()}`;
      this.host.handledExitOrderIds.set(exitClientOrderId, Date.now());

      const res = await this.host.binance.placeOrder({
        symbol: this.host.symbol,
        side: "SELL",
        type: orderType,
        price: orderType === "MARKET" ? undefined : limitPrice,
        qty: executeQty,
        clientOrderId: exitClientOrderId,
      });
      const orderIdStr = res.orderId ? String(res.orderId) : (res.txHash ? String(res.txHash) : undefined);
      if (orderIdStr) {
        this.host.handledExitOrderIds.set(orderIdStr, Date.now());
      }

      const isConfirmedSuccess = res.status === "FILLED" || (res.txHash && res.status !== "CANCELED" && res.status !== "EXPIRED");
      const filledQty = typeof res.executedQty === "number" && !isNaN(res.executedQty) && res.executedQty > 0
        ? res.executedQty
        : (isConfirmedSuccess ? executeQty : 0);

      if (filledQty <= 0 && !isConfirmedSuccess) {
        this.host.log(
          `⚠️ [${orderType} UNFILLED] ${actionLabel} order #${orderIdStr || "N/A"} was not filled on exchange (status: ${res.status || "UNFILLED"}, executedQty: ${filledQty}/${executeQty}). Keeping inventory lots intact.`,
        );
        this.host.handledExitOrderIds.delete(exitClientOrderId);
        if (orderIdStr) this.host.handledExitOrderIds.delete(orderIdStr);
        await this.host.refreshWalletBalances();
        this.host.saveState();
        return false;
      }

      const dustThreshold = this.host.minQty ? this.host.minQty * 0.5 : 1e-6;
      if (this.lotTracker.baseHeld() < dustThreshold) {
        this.host.log(`⚡ [EXIT SYNC] Position was already closed by WebSocket execution report — skipping duplicate fill processing`);
        this.host.saveState();
        this.host.emitTelemetryTick();
        return true;
      }

      const actualQty = Math.min(executeQty, filledQty > 0 ? filledQty : executeQty);
      const actualPrice = (typeof res.cummulativeQuoteQty === "number" && res.cummulativeQuoteQty > 0 && typeof res.executedQty === "number" && res.executedQty > 0)
        ? (res.cummulativeQuoteQty / res.executedQty)
        : (typeof res.price === "number" && res.price > 0 ? res.price : limitPrice);

      let totalCommission = 0;
      let commissionAsset = "";
      if (Array.isArray(res.fills)) {
        for (const fill of res.fills) {
          totalCommission += Number(fill.commission || 0);
          if (fill.commissionAsset) commissionAsset = fill.commissionAsset;
        }
      }
      const feeCalc = this.calculateSpotFeeQuote({
        fee: totalCommission > 0 ? totalCommission : undefined,
        feeAsset: commissionAsset || undefined,
        price: actualPrice,
        qty: actualQty,
        dryRun: false,
        isIoc: true,
      });
      if (feeCalc.feeQuote > 0) {
        this.host.totalGasSpentQuote += feeCalc.feeQuote;
        this.host.totalGasDeductedQuote += feeCalc.feeQuote;
        this.host.realizedPnl = this.host.tradeRealizedPnl - this.host.totalGasDeductedQuote;
      }

      const { roundPnl } = this.lotTracker.closeLots(actualQty, actualPrice);
      const effectiveSlipPct = (action === "MANUAL" && limitPrice >= targetPrice) ? 0 : slippagePctVal;
      const isCut = action === "CUT";
      const isManual = action === "MANUAL";
      const effectiveActionLabel = isCut
        ? "CUT LOSS (SELL ALL)"
        : (isManual ? "MANUAL SELL ALL (EMERGENCY EXIT)" : (roundPnl >= 0 ? "100% FULL EXIT (TAKE PROFIT)" : "BREAKDOWN EXIT (LOSS)"));
      const orderAction = isCut
        ? "CUT"
        : (isManual ? "EXIT" : (roundPnl >= 0 ? "TAKE_PROFIT" : "BREAKDOWN_EXIT"));
      const feeLog = feeCalc.feeQuote > 0 ? ` | 🏷️ Fee: -$${feeCalc.feeQuote.toFixed(4)} ${this.host.quoteAsset}` : "";
      this.host.log(
        `🚨 ON-CHAIN ${effectiveActionLabel}: ${actualQty.toFixed(4)} ${this.host.baseAsset} @ $${actualPrice.toFixed(6)} | Target: $${targetPrice.toFixed(6)} | Slip: ${effectiveSlipPct.toFixed(2)}% | Limit: $${limitPrice.toFixed(6)}${feeLog} (Trade PnL: ${roundPnl >= 0 ? "+$" : "-$"}${Math.abs(roundPnl).toFixed(4)} | Net Total: ${this.host.realizedPnl >= 0 ? "+$" : "-$"}${Math.abs(this.host.realizedPnl).toFixed(4)}) (tx: ${res.txHash || orderIdStr || "N/A"})`,
      );
      this.host.emit({
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
          gasFeeQuote: feeCalc.feeQuote,
          gasFeeUsdso: feeCalc.feeQuote,
          fee: totalCommission > 0 ? totalCommission : (feeCalc.feeQuote > 0 ? feeCalc.feeQuote : undefined),
          feeAsset: commissionAsset || (feeCalc.feeQuote > 0 ? feeCalc.feeAsset : undefined),
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
      await this.host.refreshWalletBalances();
      if (this.lotTracker.baseHeld() < dustThreshold || this.host.walletBaseBalance - minGasReserveBase <= dustThreshold) {
        this.host.clearPositionState();
      }
      this.host.saveState();
      return true;
    } catch (err) {
      this.host.log(`⚠️ On-chain ${actionLabel} failed: ${(err as Error).message}`);
      await this.host.refreshWalletBalances();
      const dustThreshold = (this.host.minQty ? this.host.minQty * 0.5 : 1e-6);
      if (this.lotTracker.baseHeld() < dustThreshold || this.host.walletBaseBalance - minGasReserveBase <= dustThreshold) {
        this.host.clearPositionState();
        this.host.saveState();
      }
      return false;
    }
  }

  /**
   * IOC Bracket Grid Execution Engine
   */
  public async executeIocBracketGrid(params: {
    buyLevels: number[];
    sellLevels: number[];
    lowerBound: number;
    upperBound: number;
    span: number;
    positionPct: number;
    inBuyZone: boolean;
    canBuy: boolean;
    currentBestAsk: number;
    currentBestBid: number;
    refPrice: number;
    activeDowntrendLine?: any;
    activeUptrendLine?: any;
    uptrendBroken?: boolean;
    liveRealCeil?: number;
  }): Promise<void> {
    const {
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
      activeDowntrendLine,
      activeUptrendLine,
      uptrendBroken,
      liveRealCeil,
    } = params;

    if (this.host.openOrders.length > 0) {
      await this.cancelAllRestingOrders(undefined, "IOC_BRACKET mode active — clearing resting maker orders");
    }

    const maxInv = typeof (this.host as any).getEffectiveMaxInventoryQuote === "function"
      ? (this.host as any).getEffectiveMaxInventoryQuote()
      : (this.host.cfg.maxInventoryQuote ?? 40);
    const currentHeldQuote = this.lotTracker.baseHeld() * refPrice;
    const enabledBuys = Array.isArray(this.host.cfg.enabledBuyLevels) ? this.host.cfg.enabledBuyLevels : [true, true, true, true, true];
    const enabledSells = Array.isArray(this.host.cfg.enabledSellTargets) ? this.host.cfg.enabledSellTargets : [true, true, true, true, true];
    const activeBuyCount = enabledBuys.filter(Boolean).length;
    const buyFractions = this.host.getBuyLevelWeightFractions(enabledBuys, buyLevels.length);
    const baseTrancheQuote = activeBuyCount > 0 ? (maxInv / activeBuyCount) : 0;

    // BUY SIDE
    const isCexExchange = this.host.binance.exchangeName === "binance";
    const isAskPriceSane = refPrice > 0 && currentBestAsk > 0 && (
      !isCexExchange
        ? (currentBestAsk <= refPrice * 1.05 && currentBestAsk >= refPrice * 0.85)
        : Math.abs(currentBestAsk - refPrice) / refPrice <= 0.05
    );

    if (canBuy && this.host.buyOrdersActive && currentBestAsk > 0 && isAskPriceSane && activeBuyCount > 0) {
      let targetTranches = 0;
      let matchedLevelIndex = -1;
      let isTlBuy = false;
      let matchedBuyPrice: number | undefined;

      const isTlAboveBuyTarget = Boolean(
        Boolean(this.host.cfg.enableBuyAboveTrendSupport) &&
        activeUptrendLine &&
        !activeUptrendLine.isBroken &&
        refPrice >= activeUptrendLine.currentLinePrice * 0.995 &&
        activeUptrendLine.currentLinePrice > (buyLevels[0] ?? 0) &&
        activeUptrendLine.currentLinePrice < (sellLevels[0] ?? upperBound)
      );

      if (isTlAboveBuyTarget && activeUptrendLine && currentBestAsk <= activeUptrendLine.currentLinePrice * 1.0005) {
        targetTranches = 1;
        matchedLevelIndex = 0;
        isTlBuy = true;
        matchedBuyPrice = activeUptrendLine.currentLinePrice;
      } else {
        for (let i = 0; i < buyLevels.length; i++) {
          if (!enabledBuys[i]) continue;
          const lvlPrice = buyLevels[i];
          if (currentBestAsk <= lvlPrice) {
            targetTranches = i + 1;
            matchedLevelIndex = i;
            matchedBuyPrice = lvlPrice;
          }
        }
      }

      // Check resistance profit guard (cannot buy if price is at or too close to resistance to make profit)
      const isTlActive = (this.host.cfg.enableSellBelowTrendResistance !== false) &&
        Boolean(activeDowntrendLine && !activeDowntrendLine.isBroken);
      const isRealCeilActive = (this.host.cfg.enableSellAtRealCeiling !== false) &&
        liveRealCeil !== undefined && liveRealCeil > 0 && liveRealCeil < upperBound;
      const effectiveResPrice = (isTlActive || isRealCeilActive)
        ? Math.min(
            isTlActive && activeDowntrendLine ? activeDowntrendLine.currentLinePrice : Infinity,
            isRealCeilActive && liveRealCeil ? liveRealCeil : Infinity,
          )
        : Infinity;
      const minResProfitMarginPct = Math.max(0.20, this.host.cfg.minNetProfitPct ?? 0.25) + 0.10;
      const maxAllowedBuyUnderRes = effectiveResPrice < Infinity
        ? effectiveResPrice * (1 - minResProfitMarginPct / 100)
        : Infinity;
      if (currentBestAsk >= maxAllowedBuyUnderRes) {
        targetTranches = 0;
      }

      if (targetTranches > 0 && matchedLevelIndex >= 0 && matchedBuyPrice !== undefined) {
        const targetHoldFraction = isTlBuy
          ? (buyFractions[0] ?? 0.20)
          : (this.host.getCumulativeBuyTargetFraction(matchedLevelIndex, enabledBuys, buyLevels.length));
        const targetHoldQuote = maxInv * targetHoldFraction;
        const deficitQuote = targetHoldQuote - currentHeldQuote;
        const minOrderNotional = Math.max(this.host.minNotional || 5.0, 5.0);

        // After a Cut Loss, enforce incremental 1-tranche DCA re-entry
        const levelTrancheQuote = isTlBuy
          ? (maxInv * (buyFractions[0] ?? 0.20))
          : (maxInv * (buyFractions[matchedLevelIndex] || (activeBuyCount > 0 ? 1 / activeBuyCount : 0.20)));
        const maxAllowedPerBuy = this.host.postCutSingleTrancheOnly ? levelTrancheQuote : deficitQuote;
        const toSpendQuote = Math.min(deficitQuote, maxAllowedPerBuy);

        if (toSpendQuote >= minOrderNotional) {
          const buyCooldownKey = isTlBuy ? `ioc_buy_tl` : `ioc_buy_level_${matchedLevelIndex}`;
          const lastBuyTs = this.host.orderCooldowns.get(buyCooldownKey) ?? 0;
          const buyCooldownMs = 15_000;

          if (Date.now() - lastBuyTs > buyCooldownMs) {
            const rawDesiredQty = toSpendQuote / currentBestAsk;
            const desiredQty = roundToStep(rawDesiredQty, this.getStepSize(), this.host.qtyPrecision);

            if (desiredQty >= this.host.minQty) {
              this.host.orderCooldowns.set(buyCooldownKey, Date.now());
              const levelName = isTlBuy
                ? `Buy TL Support ($${matchedBuyPrice.toFixed(4)})`
                : `Buy Level ${matchedLevelIndex + 1} (${((matchedBuyPrice - lowerBound) / span * 100).toFixed(0)}%)`;

              this.host.log(
                `⚡ [IOC BRACKET BUY] Market ask $${currentBestAsk.toFixed(6)} entered ${levelName} — executing IOC buy for $${toSpendQuote.toFixed(2)} ${this.host.quoteAsset}${this.host.postCutSingleTrancheOnly ? " [Post-Cut 1x DCA Guard]" : ""}`,
              );
              const ok = await this.buyTrancheIOC(desiredQty, currentBestAsk, levelName, matchedBuyPrice, toSpendQuote);
              if (ok && this.host.postCutSingleTrancheOnly) {
                this.host.postCutSingleTrancheOnly = false;
                this.host.saveState();
              }
            }
          }
        }
      }
    }

    // SELL SIDE
    const held = this.lotTracker.baseHeld();

    // If Stage 1 Cut Loss is active and price bounced back to or above Floor, execute IOC full bounce exit
    if (this.host.cutLossStage1Executed && held >= this.host.minQty && currentBestBid > 0 && currentBestBid >= lowerBound) {
      this.host.log(
        `🎉 [IOC BOUNCE EXIT] Price ($${currentBestBid.toFixed(6)}) bounced to Channel Floor ($${lowerBound.toFixed(6)}) after Stage 1 de-risk — executing IOC bounce exit for ${held.toFixed(4)} ${this.host.baseAsset}!`,
      );
      const ok = await this.sellTrancheIOC(held, currentBestBid, "Cut Loss Bounce Exit (50%)", lowerBound, true);
      if (ok) {
        this.host.cutLossStage1Executed = false;
        this.host.cutLossStage1Price = undefined;
        this.host.cutLossStage1CandleTime = undefined;
        this.host.cutLossStage1Time = undefined;
        this.host.saveState();
      }
      return;
    }

    const isCeilingZone = refPrice >= upperBound || (currentBestBid > 0 && currentBestBid >= upperBound);
    if (isCeilingZone && this.host.cfg.takeProfitAtUpperBound) {
      return;
    }

    const isTlActive = (this.host.cfg.enableSellBelowTrendResistance !== false) &&
      Boolean(activeDowntrendLine && !activeDowntrendLine.isBroken);
    const tlPrice = (isTlActive && activeDowntrendLine) ? activeDowntrendLine.currentLinePrice : Infinity;

    const activeSellIndices = (sellLevels.length > 0 ? sellLevels.map((_, idx) => idx) : [0, 1, 2, 3, 4]).filter(
      (idx) => enabledSells[idx] && sellLevels[idx] !== undefined && (!isTlActive || sellLevels[idx]! < tlPrice),
    );

    if (this.host.sellOrdersActive && held >= this.host.minQty && currentBestBid > 0 && activeSellIndices.length > 0) {
      let targetTrancheToSell = -1;
      let matchedSellPrice: number | undefined;

      // Pick the lowest unsold reached target (ladder upwards)
      for (const i of activeSellIndices) {
        const lvlPrice = sellLevels[i];
        if (lvlPrice !== undefined && currentBestBid >= lvlPrice && !this.host.soldSellIndices.has(i)) {
          targetTrancheToSell = i;
          matchedSellPrice = lvlPrice;
          break;
        }
      }

      if (targetTrancheToSell >= 0 && matchedSellPrice !== undefined) {
        const avgEntry = this.lotTracker.getAvgEntryPrice();
        const minProfitMult = this.host.getMinProfitMultiplier();
        const lowestLotCost = this.host.lots.length > 0 ? Math.min(...this.host.lots.map((l) => l.price)) : avgEntry;
        const meetsProfitRequirement = this.host.cfg.requireProfitAboveAvgEntry
          ? (avgEntry <= 0 || currentBestBid >= avgEntry * minProfitMult)
          : (lowestLotCost <= 0 || currentBestBid >= lowestLotCost * minProfitMult);

        if (meetsProfitRequirement) {
          const sellCooldownKey = `ioc_sell_level_${targetTrancheToSell}`;
          const lastSellTs = this.host.orderCooldowns.get(sellCooldownKey) ?? 0;
          const sellCooldownMs = 15_000;

          if (Date.now() - lastSellTs > sellCooldownMs) {
            const remainingUnsold = activeSellIndices.filter((idx) => !this.host.soldSellIndices.has(idx));
            const isFinalTranche = remainingUnsold.length <= 1 || targetTrancheToSell === activeSellIndices[activeSellIndices.length - 1];

            let sellFrac = 1 / Math.max(1, remainingUnsold.length);
            const sellWeights = this.host.cfg.sellLevelWeights;
            if (Array.isArray(sellWeights) && sellWeights.some((w) => w > 0)) {
              const totalUnsoldWeight = remainingUnsold.reduce((sum, idx) => sum + (sellWeights[idx] ?? 0), 0);
              const targetWeight = sellWeights[targetTrancheToSell] ?? 0;
              if (totalUnsoldWeight > 0 && targetWeight > 0) {
                sellFrac = targetWeight / totalUnsoldWeight;
              }
            }

            const rawDesiredQty = isFinalTranche
              ? held
              : roundToStep(held * sellFrac, this.getStepSize(), this.host.qtyPrecision);
            const desiredQty = Math.min(held, rawDesiredQty);

            if (desiredQty >= this.host.minQty) {
              this.host.orderCooldowns.set(sellCooldownKey, Date.now());
              const levelName = `Sell Target ${targetTrancheToSell + 1} (${((matchedSellPrice - lowerBound) / span * 100).toFixed(0)}%)`;

              this.host.log(
                `⚡ [IOC BRACKET SELL] Market bid $${currentBestBid.toFixed(6)} entered ${levelName} — executing IOC sell for ${desiredQty.toFixed(4)} ${this.host.baseAsset}${isFinalTranche ? " (100% Exit)" : ""}`,
              );
              await this.sellTrancheIOC(desiredQty, currentBestBid, levelName, matchedSellPrice);
            }
          }
        }
      }
    }
  }
}
