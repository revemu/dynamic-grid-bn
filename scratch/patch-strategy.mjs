import fs from "node:fs";

const file = "src/strategy.ts";
let content = fs.readFileSync(file, "utf8");

// 1. Replace the stale order loop in syncOnChainOrders
const staleLoopStart = `        for (const stale of staleTracked) {
          const now = Date.now();

          // Leftover virtual order without on-chain ID
          if (!stale.onChainOrderId) {
            this.log(\`ℹ️ [sync] Leftover virtual order removed: \${stale.levelDesc}\`);
            continue;
          }`;

const staleLoopEndMarker = `        this.openOrders = this.openOrders.filter((o) => !staleTracked.includes(o));
      }`;

const idxStart = content.indexOf(staleLoopStart);
const idxEnd = content.indexOf(staleLoopEndMarker, idxStart);

if (idxStart !== -1 && idxEnd !== -1) {
  const replacement = `      for (const stale of staleTracked) {
        if (!stale.onChainOrderId) {
          this.log(\`ℹ️ [sync] Leftover virtual order removed: \${stale.levelDesc}\`);
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
                \`⚡ [sync] Confirmed BINANCE BUY MATCH for Order #\${stale.onChainOrderId} (\${filledQty} \${this.baseAsset} @ $\${fillPrice}).\`,
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
                \`⚡ [sync] Confirmed BINANCE SELL MATCH for Order #\${stale.onChainOrderId} (\${filledQty} \${this.baseAsset} @ $\${fillPrice}).\`,
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
              \`ℹ️ [sync] Confirmed CANCEL \${sideStr} for Order #\${stale.onChainOrderId} (\${stale.qty} \${this.baseAsset} @ $\${stale.price}) [\${binanceOrder.status}].\`,
            );
            this.emit({
              type: "order",
              data: {
                side: stale.isBid ? "BUY" : "SELL",
                action: stale.isBid ? "CANCEL_BUY" : "CANCEL_SELL",
                price: stale.price,
                qty: stale.qty,
                notionalUsdso: stale.notionalUsdso,
                levelDesc: stale.levelDesc,
                orderId: stale.onChainOrderId,
                reason: \`Binance \${binanceOrder.status}\`,
                time: Date.now(),
                dryRun: false,
              },
            });
          }
        } catch (err) {
          this.log(\`⚠️ [sync] Could not query order #\${stale.onChainOrderId}: \${(err as Error).message}\`);
        }
      }

      this.openOrders = this.openOrders.filter((o) => !staleTracked.includes(o));`;

  content = content.slice(0, idxStart) + replacement + content.slice(idxEnd + staleLoopEndMarker.length);
  console.log("Replaced stale order loop successfully");
} else {
  console.error("Could not find stale order loop markers! idxStart=", idxStart, "idxEnd=", idxEnd);
}

// 2. Replace this.pool.minQty with this.minQty
content = content.replaceAll("this.pool.minQty", "this.minQty");
console.log("Replaced this.pool.minQty with this.minQty");

// 3. Replace cancelAllOrdersUser on-chain purge (around line 1017)
const cancelAllPurgeTarget = `    // Direct On-Chain Purge: ensure any orphaned open orders on DreamDEX are also cancelled
    if (!this.cfg.dryRun) {
      try {
        const liveIds = await this.pool.openOrderIds();
        for (const rawId of liveIds) {
          const idStr = rawId.toString();
          this.cancelledOrderIds.set(idStr, Date.now());
          try {
            await this.pool.cancel(rawId);
            this.log(\`🗑️ Directly cancelled on-chain order #\${idStr}\`);
          } catch (e) {
            this.log(\`ℹ️ On-chain order #\${idStr} cancel note: \${(e as Error).message}\`);
          }
        }
      } catch (err) {
        this.log(\`⚠️ Direct on-chain purge check error: \${(err as Error).message}\`);
      }
    }`;

const cancelAllPurgeReplacement = `    // Direct Purge: cancel all open orders on Binance
    if (!this.cfg.dryRun && this.binance.hasCredentials()) {
      try {
        await this.binance.cancelAllOpenOrders(this.symbol);
        this.log(\`🗑️ Directly cancelled all open orders on Binance for \${this.symbol}\`);
      } catch (err) {
        this.log(\`⚠️ Binance cancel all orders error: \${(err as Error).message}\`);
      }
    }`;

content = content.replaceAll(cancelAllPurgeTarget, cancelAllPurgeReplacement);
console.log("Replaced cancelAll purge blocks");

// 4. Replace topOfBook
const topOfBookTarget = `const { bestBid, bestAsk, mid } = await this.pool.topOfBook();`;
const topOfBookReplacement = `let bestBid: number | undefined;
    let bestAsk: number | undefined;
    let mid: number | undefined;
    try {
      const top = await this.binance.getTopOfBook(this.symbol);
      bestBid = top.bestBid;
      bestAsk = top.bestAsk;
      mid = top.mid;
    } catch (err) {
      this.status(\`Binance bookTicker error: \${(err as Error).message}\`);
    }`;
content = content.replace(topOfBookTarget, topOfBookReplacement);
console.log("Replaced topOfBook");

// 5. Replace single order cancel
const cancelOrderTarget = `const res = await this.pool.cancel(BigInt(order.onChainOrderId));`;
const cancelOrderReplacement = `const res = await this.binance.cancelOrder(this.symbol, order.onChainOrderId);`;
content = content.replace(cancelOrderTarget, cancelOrderReplacement);
console.log("Replaced single order cancel");

// 6. Replace Maker placeOrder
const placeMakerTarget = `      const res = await this.pool.place({
        isBid,
        price,
        qty,
        orderType: ORDER_TYPE.PostOnly,
        expireMs,
      });`;
const placeMakerReplacement = `      const res = await this.binance.placeOrder({
        symbol: this.symbol,
        side: isBid ? "BUY" : "SELL",
        type: "LIMIT",
        price,
        qty,
        clientOrderId: id,
      });`;
content = content.replace(placeMakerTarget, placeMakerReplacement);
console.log("Replaced placeMaker");

// 7. Replace cancel sweep (around line 3704)
const sweepTarget = `    // Direct On-Chain Sweep: Never trust memory alone! Reconcile & cancel directly from pool.openOrderIds()
    if (!this.cfg.dryRun) {
      try {
        const liveIds = await this.pool.openOrderIds();
        for (const rawId of liveIds) {
          const idStr = rawId.toString();
          if (side) {
            try {
              const orderTuple = (await (this.pool as any).ctx.publicClient.readContract({
                address: this.pool.address,
                abi: SPOT_POOL_ABI,
                functionName: "getOrder",
                args: [rawId],
              })) as [bigint, boolean, string, bigint, bigint, bigint, bigint, bigint];
              const isBid = Boolean(orderTuple[1]);
              if ((side === "BUY" && !isBid) || (side === "SELL" && isBid)) {
                continue; // Not matching requested side
              }
            } catch {
              // If getOrder fails, proceed to cancel to be safe
            }
          }
          this.cancelledOrderIds.set(idStr, Date.now());
          try {
            await this.pool.cancel(rawId);
            this.log(\`🗑️ On-chain sweep cancelled \${side || "ALL"} order #\${idStr} [\${reason}]\`);
          } catch (e) {
            this.log(\`ℹ️ On-chain sweep #\${idStr} note: \${(e as Error).message}\`);
          }
        }
      } catch (err) {
        this.log(\`⚠️ On-chain cancel sweep error: \${(err as Error).message}\`);
      }
      await this.refreshWalletBalances();
    }`;

const sweepReplacement = `    if (!this.cfg.dryRun && this.binance.hasCredentials()) {
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
        this.log(\`⚠️ Binance cancel sweep error: \${(err as Error).message}\`);
      }
      await this.refreshWalletBalances();
    }`;
content = content.replace(sweepTarget, sweepReplacement);
console.log("Replaced sweepTarget");

// 8. Replace Snipe IOC Sell
const snipeSellTarget = `      const res = await this.pool.place({
        isBid: false,
        price: limitPrice,
        qty: finalQty,
        orderType: ORDER_TYPE.ImmediateOrCancel,
      });`;
const snipeSellReplacement = `      const res = await this.binance.placeOrder({
        symbol: this.symbol,
        side: "SELL",
        type: "IOC",
        price: limitPrice,
        qty: finalQty,
      });`;
content = content.replace(snipeSellTarget, snipeSellReplacement);
console.log("Replaced snipeSellTarget");

// 9. Replace Snipe IOC Buy
const snipeBuyTarget = `      const res = await this.pool.place({
        isBid: true,
        price: limitPrice,
        qty: finalQty,
        orderType: ORDER_TYPE.ImmediateOrCancel,
      });`;
const snipeBuyReplacement = `      const res = await this.binance.placeOrder({
        symbol: this.symbol,
        side: "BUY",
        type: "IOC",
        price: limitPrice,
        qty: finalQty,
      });`;
content = content.replace(snipeBuyTarget, snipeBuyReplacement);
console.log("Replaced snipeBuyTarget");

// 10. Replace Cut Loss / Take Profit IOC Sell
const liquidateTarget = `      const res = await this.pool.place({
        isBid: false,
        price,
        qty: executeQty,
        orderType: ORDER_TYPE.ImmediateOrCancel,
      });`;
const liquidateReplacement = `      const res = await this.binance.placeOrder({
        symbol: this.symbol,
        side: "SELL",
        type: "IOC",
        price,
        qty: executeQty,
      });`;
content = content.replace(liquidateTarget, liquidateReplacement);
console.log("Replaced liquidateTarget");

// 11. Replace trackTxGas
const trackGasTarget = `  public async trackTxGas(txHash?: string, label?: string): Promise<void> {
    if (!txHash || this.cfg.dryRun) return;
    try {
      const publicClient = (this.pool as any).ctx?.publicClient;
      if (!publicClient) return;

      const receipt = await publicClient.getTransactionReceipt({ hash: txHash as \`0x\${string}\` });
      if (receipt) {
        const gasUsed = receipt.gasUsed;
        const effectiveGasPrice = receipt.effectiveGasPrice ?? 0n;
        const gasFeeWei = gasUsed * effectiveGasPrice;
        const gasFeeSomi = Number(gasFeeWei) / 1e18;
        const refPrice = this.lastRefPrice || 0.2;
        const gasFeeUsdso = gasFeeSomi * refPrice;

        this.totalGasSpentSomi += gasFeeSomi;
        this.totalGasSpentUsdso += gasFeeUsdso;
        this.accumulatedGasSomi += gasFeeSomi;
        this.accumulatedGasUsdso += gasFeeUsdso;
        this.totalTxCount++;

        // Attach gas fee to matching recent order in state
        const matchingOrder = this.recentOrders.find((o) => o.createTxHash === txHash || o.cancelTxHash === txHash || o.txHash === txHash);
        if (matchingOrder) {
          matchingOrder.gasFeeSomi = (matchingOrder.gasFeeSomi || 0) + gasFeeSomi;
          matchingOrder.gasFeeUsdso = (matchingOrder.gasFeeUsdso || 0) + gasFeeUsdso;
        }

        // Update gas details directly on the matching Order Activity or Trade record in DB
        this.db.updateTxGas(txHash, {
          gasUsed: Number(gasUsed),
          effectiveGasPriceGwei: Number(effectiveGasPrice) / 1e9,
          gasSomi: gasFeeSomi,
          gasUsdso: gasFeeUsdso,
        });
      }
    } catch {}
  }`;

const trackGasReplacement = `  public async trackTxGas(txHash?: string, label?: string): Promise<void> {
    return;
  }`;
content = content.replace(trackGasTarget, trackGasReplacement);
console.log("Replaced trackTxGas");

fs.writeFileSync(file, content, "utf8");
console.log("Finished updating src/strategy.ts successfully!");
