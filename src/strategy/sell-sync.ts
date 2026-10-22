/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import type { IStrategyHost, OpenOrder } from "./types.js";
import type { LotTracker } from "./lot-tracker.js";
import type { TrendLine, DowStructure } from "../market-structure.js";
import { roundToStep, roundToTick } from "../exchange/binance/client.js";

export interface SyncSellOrdersParams {
  sellLevels: number[];
  lowerBound: number;
  upperBound: number;
  refPrice: number;
  currentBestBid: number;
  currentBestAsk: number;
  activeDowntrendLine?: TrendLine;
  liveRealCeil?: number;
  dow?: DowStructure;
  cancelAllRestingOrders: (side?: "BUY" | "SELL", reason?: string) => Promise<void>;
  cancelOrderInternal: (order: OpenOrder, reason: string) => Promise<void>;
  placeRestingOrder: (
    isBid: boolean,
    price: number,
    qty: number,
    targetFraction: number,
    notionalQuote: number,
    levelDesc: string,
  ) => Promise<void>;
  sellTrancheIOC: (
    qty: number,
    execPrice: number,
    levelName: string,
    targetPrice: number,
    allowLoss?: boolean,
  ) => Promise<boolean>;
}

export class SellOrderSynchronizer {
  constructor(
    private host: IStrategyHost,
    private lotTracker: LotTracker,
  ) {}

  /**
   * Synchronizes resting maker sell limit orders according to current channel structure.
   * Handles:
   * - Inventory dust cleanup & full liquidation detection
   * - Cut Loss Bounce Exit (50%) isolation
   * - Resistance Sell Overrides (Downtrend Trendline & Real Frame S/R Ceil)
   * - Standard ladder sells with minNotional consolidation
   * - IOC sell triggers in IOC_BRACKET mode
   */
  public async syncSellOrders(params: SyncSellOrdersParams): Promise<void> {
    const {
      sellLevels,
      lowerBound,
      upperBound,
      refPrice,
      currentBestBid,
      currentBestAsk,
      activeDowntrendLine,
      liveRealCeil,
      dow,
      cancelAllRestingOrders,
      cancelOrderInternal,
      placeRestingOrder,
      sellTrancheIOC,
    } = params;

    const currentHeldQuote = this.lotTracker.baseHeld() * refPrice;
    const maxInv = this.host.cfg.maxInventoryQuote;
    const currentHoldFraction = maxInv > 0 ? (currentHeldQuote / maxInv) : 0;
    const qtyTol = (this.host.cfg.orderQtyTolerancePct ?? 20) / 100;

    const minReserveBase = this.host.getEffectiveGasReserveBase();
    const totalBaseInOpenSellsInit = this.host.openOrders.filter((o) => !o.isBid).reduce((sum, o) => sum + (o.qty || 0), 0);
    const totalTradingCapacity = Math.max(0, (this.host.walletBaseBalance + totalBaseInOpenSellsInit) - minReserveBase);
    const held = this.host.cfg.dryRun ? this.lotTracker.baseHeld() : Math.min(this.lotTracker.baseHeld(), totalTradingCapacity);
    const isDustPosition = held < this.host.minQty || currentHeldQuote < 0.05;

    if (isDustPosition) {
      const openSells = this.host.openOrders.filter((o) => !o.isBid);
      if (openSells.length > 0) {
        await cancelAllRestingOrders("SELL", "Inventory empty or dust only (no base to sell)");
      }
      if (this.host.lots.length > 0) {
        this.host.clearPositionState();
        this.host.saveState();
      }
      return;
    }

    if (this.host.cutLossStage1Executed) {
      // Stage 1 Cut Loss active: Remaining 50% inventory is dedicated to the Bounce Exit limit sell at Floor
      let bounceExitOrder = this.host.openOrders.find((o) => !o.isBid && o.levelDesc === "Cut Loss Bounce Exit (50%)");
      const straySells = this.host.openOrders.filter((o) => !o.isBid && o !== bounceExitOrder);
      if (straySells.length > 0) {
        for (const o of straySells) {
          await cancelOrderInternal(o, "Stage 1 cut loss active: clearing non-bounce sell orders");
        }
        this.host.openOrders = this.host.openOrders.filter((o) => !straySells.includes(o));
        this.host.saveState();
      }

      // If bounce exit order is missing but we still hold the remaining tranche, re-place it at Floor
      if (!bounceExitOrder && this.host.cfg.orderExecutionMode === "MAKER_LIMIT" && held >= (this.host.minQty || 0.0001)) {
        const bounceSellPrice = roundToTick(Math.max(lowerBound, refPrice * 1.002), this.host.tickSize || 0.0001);
        const bounceNotional = held * bounceSellPrice;
        const minNotionalForSplit = Math.max(this.host.minNotional || 5.0, 5.0);
        if (bounceNotional >= minNotionalForSplit) {
          const bounceQty = roundToStep(held, this.host.stepSize || 0.0001, this.host.qtyPrecision);
          await placeRestingOrder(
            false,
            bounceSellPrice,
            bounceQty,
            0.0,
            bounceNotional,
            "Cut Loss Bounce Exit (50%)",
          );
        }
      }
      return;
    }

    if (!this.host.sellOrdersActive) {
      const buyL1Pct = this.host.cfg.buyLevelPcts?.[0] ?? 42;
      const openSells = this.host.openOrders.filter((o) => !o.isBid);
      if (openSells.length > 0) {
        await cancelAllRestingOrders("SELL", `Price below Buy Level 1 (< ${buyL1Pct}%) — cancelling sell orders to avoid churn while accumulating`);
      }
      return;
    }

    const isSingleSellLevel = sellLevels.length === 1;
    const sellBufPct = this.host.cfg.narrowChannelSellBufferPct ?? 0.05;
    const sellPcts = this.host.cfg.sellLevelPcts ?? [52, 62, 72, 82, 92];
    const sellNames = isSingleSellLevel
      ? [`Sell Edge Ceil (-${sellBufPct.toFixed(2)}%)`]
      : sellLevels.map((_, idx) => `Sell Target ${idx + 1} (${sellPcts[idx] ?? Math.round(52 + idx * 10)}%)`);

    const enabledSells = Array.isArray(this.host.cfg.enabledSellTargets) ? this.host.cfg.enabledSellTargets : [true, true, true, true, true];
    const activeSellCount = enabledSells.filter(Boolean).length;
    if (activeSellCount === 0) {
      const openSells = this.host.openOrders.filter((o) => !o.isBid && o.levelDesc && sellNames.includes(o.levelDesc));
      if (openSells.length > 0) {
        for (const o of openSells) {
          await cancelOrderInternal(o, "All sell targets disabled by configuration");
        }
        this.host.openOrders = this.host.openOrders.filter((o) => !openSells.includes(o));
        this.host.saveState();
      }
      return;
    }

    // Cancel resting sell orders for disabled sell targets
    const disabledSellOrders = this.host.openOrders.filter((o) => {
      if (o.isBid || !o.levelDesc) return false;
      const idx = sellNames.indexOf(o.levelDesc);
      return idx >= 0 && !enabledSells[idx];
    });
    if (disabledSellOrders.length > 0) {
      for (const o of disabledSellOrders) {
        await cancelOrderInternal(o, `Sell target disabled by configuration: ${o.levelDesc}`);
      }
      this.host.openOrders = this.host.openOrders.filter((o) => !disabledSellOrders.includes(o));
      this.host.saveState();
    }

    // ── Resistance Sell Override (Downtrend Trendline & Real Frame S/R Ceil) ──
    const isIocMode = this.host.cfg.orderExecutionMode === "IOC_BRACKET";
    const isTlActive = (this.host.cfg.enableSellBelowTrendResistance !== false) && Boolean(activeDowntrendLine && !activeDowntrendLine.isBroken);
    const isRealCeilActive = (this.host.cfg.enableSellAtRealCeiling !== false) && liveRealCeil !== undefined && liveRealCeil > 0;
    const hasResistanceOverride = isTlActive || (isRealCeilActive && liveRealCeil < upperBound);

    if (hasResistanceOverride) {
      const tlPrice = (isTlActive && activeDowntrendLine) ? activeDowntrendLine.currentLinePrice : Infinity;
      const rcPrice = (isRealCeilActive && liveRealCeil) ? liveRealCeil : Infinity;
      const effectiveResistancePrice = Math.min(tlPrice, rcPrice);
      const isUsingRealCeil = isRealCeilActive && liveRealCeil !== undefined && effectiveResistancePrice === liveRealCeil;
      const resSellName = isUsingRealCeil ? "Sell Real Ceil Exit" : "Sell TL Exit (Trendline)";
      const resDisplayName = isUsingRealCeil ? "Real S/R Ceil" : "Trendline";
      const tlSellName = resSellName;

      const allSellNames = [...sellNames, "Sell TL Exit (Trendline)", "Sell Real Ceil Exit"];
      const frontRunRatio = isUsingRealCeil ? 0.0003 : 0.0008;
      const rawTargetSellPrice = effectiveResistancePrice * (1 - frontRunRatio);
      const effectiveTlSellPrice = roundToTick(Math.max(refPrice * 1.0005, rawTargetSellPrice), this.host.tickSize || 0.0001);

      const mode = this.host.cfg.sellProfitMode || (this.host.cfg.requireProfitAboveAvgEntry ? "PORTFOLIO_AVG_PROFIT" : "GRID_CASHFLOW");
      const avgEntry = this.lotTracker.getAvgEntryPrice();
      const isDowntrendActive = Boolean(
        dow?.regime === "DOWNTREND" ||
        (dow?.waveCycle?.lastLl && (!dow?.waveCycle?.lastHl || dow.waveCycle.lastLl.index > dow.waveCycle.lastHl.index)) ||
        (this.host.waitingForHigherLow && this.host.isTrendSupportExitActive)
      );
      const isStuckPosition = Boolean(
        this.host.stuckSince !== undefined && (Date.now() - this.host.stuckSince > (this.host.cfg.stuckTimeoutMs || 43_200_000) * 0.5)
      );
      const isHeavyDrawdown = Boolean(currentHoldFraction >= 0.22);
      const isDowntrendEscape = Boolean(isDowntrendActive || isStuckPosition || isHeavyDrawdown);
      const effectiveMinProfitPct = isDowntrendEscape
        ? (this.host.cfg.breakevenEscapeProfitPct ?? 0.06)
        : Math.max(0.20, this.host.cfg.minNetProfitPct ?? 0.25);
      const isProfitOk = avgEntry <= 0 || effectiveTlSellPrice >= avgEntry * (1 + effectiveMinProfitPct / 100);

      let existingTlSell = this.host.openOrders.find((o) => !o.isBid && (
        o.levelDesc === resSellName ||
        o.levelDesc === "Sell TL Exit (Trendline)" ||
        o.levelDesc === "Sell Real Ceil Exit"
      ));

      if (!isProfitOk) {
        if (existingTlSell) {
          await cancelOrderInternal(
            existingTlSell,
            `${resDisplayName} price ($${effectiveTlSellPrice.toFixed(4)}) drifted below minimum profit target ($${(avgEntry * (1 + effectiveMinProfitPct / 100)).toFixed(4)}) — cancelling TL sell`,
          );
          this.host.openOrders = this.host.openOrders.filter((o) => o !== existingTlSell);
          this.host.saveState();
        }
      }

      const levelsUnderTL = sellLevels.filter((lvl, idx) => {
        if (lvl >= effectiveResistancePrice || !enabledSells[idx]) return false;
        const hasExistingOrder = this.host.openOrders.some(
          (o) => !o.isBid && (o.levelDesc === sellNames[idx] || (lvl && Math.abs(o.price - lvl) / lvl <= 0.001)),
        );
        if (hasExistingOrder) return true;
        return !this.host.soldSellIndices.has(idx);
      });

      if (levelsUnderTL.length === 0 && isProfitOk) {
        if (isIocMode) {
          const leftoverSells = this.host.openOrders.filter(
            (o) => !o.isBid && o.levelDesc && allSellNames.includes(o.levelDesc),
          );
          if (leftoverSells.length > 0) {
            for (const o of leftoverSells) {
              await cancelOrderInternal(o, `IOC mode active: cancelling resting sell at ${resDisplayName} — waiting for IOC trigger`);
            }
            this.host.openOrders = this.host.openOrders.filter((o) => !leftoverSells.includes(o));
            this.host.saveState();
          }
          return;
        }

        if (existingTlSell && existingTlSell.levelDesc !== tlSellName) {
          existingTlSell.levelDesc = tlSellName;
          existingTlSell.targetFraction = 0.0;
          this.host.log(`🔗 [RES SELL] Re-linked resting SELL order #${existingTlSell.onChainOrderId || existingTlSell.id} @ $${existingTlSell.price.toFixed(6)} to ${tlSellName}`);
        }

        if (isProfitOk) {
          const staleStandardSells = this.host.openOrders.filter(
            (o) => !o.isBid && o !== existingTlSell && o.levelDesc && sellNames.includes(o.levelDesc),
          );
          if (staleStandardSells.length > 0) {
            for (const o of staleStandardSells) {
              await cancelOrderInternal(o, `${resDisplayName} override: cancelling standard grid sells — switching to ${resDisplayName} sell`);
            }
            this.host.openOrders = this.host.openOrders.filter((o) => !staleStandardSells.includes(o));
            this.host.saveState();
          }
        }

        const isBelowSellPrice = refPrice < effectiveTlSellPrice;
        if (isProfitOk && isBelowSellPrice && held >= this.host.minQty) {
          const minOrderNotional = Math.max(this.host.minNotional || 5.0, 5.0);
          const targetSellQty = roundToStep(held, this.host.stepSize || 0.0001, this.host.qtyPrecision);
          const orderNotional = targetSellQty * effectiveTlSellPrice;

          if (targetSellQty >= this.host.minQty && orderNotional >= minOrderNotional) {
            if (existingTlSell) {
              const tlPriceDiffRatio = Math.abs(existingTlSell.price - effectiveTlSellPrice) / effectiveTlSellPrice;
              const qtyDiffRatio = Math.abs(existingTlSell.qty - targetSellQty) / targetSellQty;

              if (tlPriceDiffRatio > 0.001 || qtyDiffRatio > 0.05) {
                await cancelOrderInternal(
                  existingTlSell,
                  `${resDisplayName} price updated: moving resting sell ($${existingTlSell.price.toFixed(6)} -> $${effectiveTlSellPrice.toFixed(6)})`,
                );
                this.host.openOrders = this.host.openOrders.filter((o) => o !== existingTlSell);
                this.host.saveState();

                await placeRestingOrder(
                  false,
                  effectiveTlSellPrice,
                  targetSellQty,
                  0.0,
                  orderNotional,
                  tlSellName,
                );
              }
            } else {
              await placeRestingOrder(
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
        const shouldSuppressAboveRes = isProfitOk;
        const suppressedSells = shouldSuppressAboveRes ? this.host.openOrders.filter(
          (o) => !o.isBid && o.levelDesc && sellNames.includes(o.levelDesc) && o.price >= effectiveResistancePrice,
        ) : [];
        if (suppressedSells.length > 0) {
          for (const o of suppressedSells) {
            await cancelOrderInternal(
              o,
              `${resDisplayName} suppressed: sell @ $${o.price.toFixed(6)} >= ${resDisplayName} $${effectiveResistancePrice.toFixed(6)}`,
            );
          }
          this.host.openOrders = this.host.openOrders.filter((o) => !suppressedSells.includes(o));
          this.host.saveState();
        }

        let minAllowedSellPrice = Math.max(currentBestBid, refPrice);
        if (mode === "PORTFOLIO_AVG_PROFIT" && avgEntry > 0) {
          minAllowedSellPrice = Math.max(minAllowedSellPrice, avgEntry * 1.001);
        }

        const eligibleIndices = sellLevels
          .map((lvl, idx) => ({ lvl, idx }))
          .filter(({ lvl, idx }) => {
            if (!enabledSells[idx]) return false;
            if (shouldSuppressAboveRes && lvl >= effectiveResistancePrice) return false;
            const hasExistingOrder = this.host.openOrders.some(
              (o) => !o.isBid && (o.levelDesc === sellNames[idx] || (lvl && Math.abs(o.price - lvl) / lvl <= 0.001)),
            );
            if (hasExistingOrder) return true;
            if (this.host.soldSellIndices.has(idx)) return false;
            return lvl > minAllowedSellPrice;
          })
          .map(({ idx }) => idx);

        const tlExitOrders = this.host.openOrders.filter(
          (o) => !o.isBid && o.levelDesc && (o.levelDesc === "Sell TL Exit (Trendline)" || o.levelDesc === "Sell Real Ceil Exit"),
        );
        if (tlExitOrders.length > 0 && eligibleIndices.length > 0) {
          for (const o of tlExitOrders) {
            await cancelOrderInternal(o, `${resDisplayName} override: valid targets now exist — reverting to grid levels`);
          }
          this.host.openOrders = this.host.openOrders.filter((o) => !tlExitOrders.includes(o));
          this.host.saveState();
        }

        if (eligibleIndices.length === 0 && held >= (this.host.minQty || 0.0001)) {
          const tlSellName = resSellName;
          const frontRunRatio = isUsingRealCeil ? 0.0003 : 0.0008;
          const rawTargetSellPrice = effectiveResistancePrice * (1 - frontRunRatio);
          const effectiveTlSellPrice = roundToTick(Math.max(refPrice * 1.0005, rawTargetSellPrice), this.host.tickSize || 0.0001);

          if (isProfitOk && refPrice < effectiveTlSellPrice) {
            const minOrderNotional = Math.max(this.host.minNotional || 5.0, 5.0);
            const targetSellQty = roundToStep(held, this.host.stepSize || 0.0001, this.host.qtyPrecision);
            const orderNotional = targetSellQty * effectiveTlSellPrice;
            if (targetSellQty >= this.host.minQty && orderNotional >= minOrderNotional) {
              let existingTlSell = this.host.openOrders.find((o) => !o.isBid && (
                o.levelDesc === resSellName ||
                o.levelDesc === "Sell TL Exit (Trendline)" ||
                o.levelDesc === "Sell Real Ceil Exit" ||
                Math.abs(o.price - effectiveResistancePrice) / effectiveResistancePrice <= 0.005
              ));
              if (existingTlSell) {
                const tlPriceDiffRatio = Math.abs(existingTlSell.price - effectiveTlSellPrice) / effectiveTlSellPrice;
                const qtyDiffRatio = Math.abs(existingTlSell.qty - targetSellQty) / targetSellQty;
                if (tlPriceDiffRatio > 0.001 || qtyDiffRatio > 0.05) {
                  await cancelOrderInternal(
                    existingTlSell,
                    `${resDisplayName} price updated: moving resting sell ($${existingTlSell.price.toFixed(6)} -> $${effectiveTlSellPrice.toFixed(6)})`,
                  );
                  this.host.openOrders = this.host.openOrders.filter((o) => o !== existingTlSell);
                  this.host.saveState();
                  await placeRestingOrder(
                    false,
                    effectiveTlSellPrice,
                    targetSellQty,
                    0.0,
                    orderNotional,
                    tlSellName,
                  );
                }
              } else {
                await placeRestingOrder(
                  false,
                  effectiveTlSellPrice,
                  targetSellQty,
                  0.0,
                  orderNotional,
                  tlSellName,
                );
              }
              return;
            }
          }
        }

        const minOrderNotional = Math.max(this.host.minNotional || 5.0, 5.0);
        let targetTrancheCount = eligibleIndices.length;

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

        const hasMissingEligibleSellOrders = activeSellIndices.some((idx) => {
          const lvlPrice = sellLevels[idx];
          return !this.host.openOrders.some(
            (o) => !o.isBid && (o.levelDesc === sellNames[idx] || (lvlPrice && Math.abs(o.price - lvlPrice) / lvlPrice <= 0.001)),
          );
        });

        const doSellRebalance = this.host.needsSellRebalance;
        this.host.needsSellRebalance = false;

        const totalBaseInOpenSells = this.host.openOrders
          .filter((o) => !o.isBid)
          .reduce((sum, o) => sum + o.qty, 0);
        const isInventoryFullyCovered =
          !hasMissingEligibleSellOrders &&
          (totalBaseInOpenSells >= held * 0.98 || Math.abs(totalBaseInOpenSells - held) <= Math.max(0.01, (this.host.minQty || 1) * 0.5));

        for (let i = 0; i < sellLevels.length; i++) {
          const lvlPrice = sellLevels[i];
          if (!lvlPrice) continue;
          if (!enabledSells[i]) continue;

          if (lvlPrice >= effectiveResistancePrice) {
            continue;
          }

          const currentOpenSellAtLvl = this.host.openOrders.find(
            (o) => !o.isBid && (o.levelDesc === sellNames[i] || (!o.levelDesc && Math.abs(o.price - lvlPrice) / lvlPrice <= 0.001)),
          );

          if (!activeSellIndices.includes(i)) {
            if (currentOpenSellAtLvl) {
              await cancelOrderInternal(currentOpenSellAtLvl, "Consolidating sell tranches into faster levels (Target 1 & 2) to satisfy min notional");
              this.host.openOrders = this.host.openOrders.filter((o) => o !== currentOpenSellAtLvl);
              this.host.saveState();
            }
            continue;
          }

          const isLastActive = i === activeSellIndices[activeSellIndices.length - 1];
          const activeRank = activeSellIndices.indexOf(i);
          const targetHoldingFraction = isLastActive
            ? 0.0
            : (activeSellIndices.length - 1 - activeRank) / activeSellIndices.length;

          // IOC Sell when market price has reached or exceeded this sell target under TL (IOC_BRACKET mode only)
          if (!currentOpenSellAtLvl) {
            const isPriceExceeded = currentBestBid > 0 && currentBestBid >= lvlPrice;
            if (isPriceExceeded && (this.host.cfg.enableIocSellWhenExceeded !== false) && this.host.cfg.orderExecutionMode === "IOC_BRACKET") {
              const currentHoldFraction = maxInv > 0 ? (currentHeldQuote / maxInv) : 0;
              const isLevelAlreadyFulfilled = currentHoldFraction <= targetHoldingFraction || isInventoryFullyCovered;
              if (isLevelAlreadyFulfilled) {
                continue;
              }
              const heldNow = this.lotTracker.baseHeld();
              if (heldNow >= this.host.minQty) {
                const maxBidDiscount = (this.host.cfg.cutLossMaxBidDiscountPct ?? 2.5) / 100;
                const isBidHealthy = currentBestBid > 0 && ((refPrice - currentBestBid) / refPrice) <= maxBidDiscount;
                const isProfitOk = mode !== "PORTFOLIO_AVG_PROFIT" || avgEntry <= 0 || currentBestBid >= avgEntry * 1.001;

                if (isBidHealthy && isProfitOk) {
                  const iocCooldownKey = `ioc_sell_${sellNames[i]}`;
                  const lastIoc = this.host.orderCooldowns.get(iocCooldownKey) ?? 0;
                  if (Date.now() - lastIoc > 15_000) {
                    let desiredSellQty = trancheQty;
                    if (isLastActive && mode !== "LOT_BASED_PROFIT") {
                      desiredSellQty = Math.max(trancheQty, heldNow - (trancheQty * (numActive - 1)));
                    }
                    desiredSellQty = Math.min(this.lotTracker.baseHeld(), desiredSellQty);

                    if (desiredSellQty >= this.host.minQty) {
                      this.host.orderCooldowns.set(iocCooldownKey, Date.now());
                      const success = await sellTrancheIOC(
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

          if (mode === "LOT_BASED_PROFIT") {
            const profitableLots = this.host.lots.filter((l) => l.price * 1.001 <= lvlPrice);
            const totalProfitableQty = profitableLots.reduce((sum, l) => sum + l.qty, 0);
            const lowerSellsQty = this.host.openOrders
              .filter((o) => !o.isBid && o !== currentOpenSellAtLvl && o.price < lvlPrice)
              .reduce((sum, o) => sum + o.qty, 0);
            const availableProfitableQty = Math.max(0, totalProfitableQty - lowerSellsQty);

            if (availableProfitableQty < (this.host.minQty || 1)) {
              if (currentOpenSellAtLvl) {
                await cancelOrderInternal(currentOpenSellAtLvl, "Lot-based mode: no profitable lots available for this sell level");
                this.host.openOrders = this.host.openOrders.filter((o) => o !== currentOpenSellAtLvl);
                this.host.saveState();
              }
              continue;
            }
            desiredSellQty = Math.min(desiredSellQty, availableProfitableQty);
          }

          if (isLastActive && mode !== "LOT_BASED_PROFIT") {
            desiredSellQty = Math.max(trancheQty, this.lotTracker.baseHeld() - (trancheQty * (numActive - 1)));
          }

          if (desiredSellQty < this.host.minQty) continue;

          let effLvlPrice = lvlPrice;
          const minMakerPrice = Math.max(currentBestAsk, refPrice * 1.0005);
          if (effLvlPrice <= currentBestBid) {
            effLvlPrice = Math.max(effLvlPrice, minMakerPrice);
          }

          if (currentOpenSellAtLvl) {
            const qtyDiffRatio = Math.abs(currentOpenSellAtLvl.qty - desiredSellQty) / desiredSellQty;
            const priceDiffRatio = Math.abs(currentOpenSellAtLvl.price - effLvlPrice) / effLvlPrice;
            const shiftTol = this.host.cfg.minChannelShiftPct ? this.host.cfg.minChannelShiftPct / 100 : 0.008;
            const isCexExchange = this.host.binance.exchangeName !== "dreamdex";
            const needsQtyResize = (doSellRebalance || hasMissingEligibleSellOrders || (isCexExchange && qtyDiffRatio > 0.10)) && qtyDiffRatio > qtyTol;
            if (needsQtyResize || priceDiffRatio > shiftTol) {
              const reason = priceDiffRatio > shiftTol
                ? `Channel shifted: aligning sell price ($${currentOpenSellAtLvl.price.toFixed(6)} -> $${effLvlPrice.toFixed(6)})`
                : "Rebalancing sell quantity to match inventory tranche";
              await cancelOrderInternal(currentOpenSellAtLvl, reason);
              this.host.openOrders = this.host.openOrders.filter((o) => o !== currentOpenSellAtLvl);
              await placeRestingOrder(
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
            await placeRestingOrder(
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

    const remainingStaleSells: OpenOrder[] = [];
    for (const o of this.host.openOrders) {
      if (o.isBid) continue;
      if (o.levelDesc === "Cut Loss Bounce Exit (50%)") continue;

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
          this.host.log(`🔗 [sync] Re-linked resting SELL order #${o.onChainOrderId || o.id} (${oldName} -> ${o.levelDesc}) @ $${o.price.toFixed(6)}`);
        }
      } else if (!o.levelDesc || !sellNames.includes(o.levelDesc)) {
        remainingStaleSells.push(o);
      }
    }

    if (remainingStaleSells.length > 0) {
      for (const o of remainingStaleSells) {
        await cancelOrderInternal(o, "Channel shifted / Level no longer in sell zone");
      }
      this.host.openOrders = this.host.openOrders.filter((o) => !remainingStaleSells.includes(o));
      this.host.saveState();
    }

    const mode = this.host.cfg.sellProfitMode || (this.host.cfg.requireProfitAboveAvgEntry ? "PORTFOLIO_AVG_PROFIT" : "GRID_CASHFLOW");
    const avgEntry = this.lotTracker.getAvgEntryPrice();
    const minProfitMulti = this.host.getMinProfitMultiplier();
    const lowestLotPrice = this.host.lots.length > 0 ? Math.min(...this.host.lots.map((l) => l.price)) : 0;
    let minAllowedSellPrice = Math.max(
      currentBestBid,
      refPrice,
      lowestLotPrice > 0 ? lowestLotPrice * minProfitMulti : 0,
    );
    if ((mode === "PORTFOLIO_AVG_PROFIT" || this.host.cfg.requireProfitAboveAvgEntry) && avgEntry > 0) {
      minAllowedSellPrice = Math.max(minAllowedSellPrice, avgEntry * minProfitMulti);
    }

    const eligibleSellIndices = sellLevels
      .map((lvl, idx) => ({ lvl, idx }))
      .filter(({ lvl, idx }) => {
        if (!enabledSells[idx]) return false;
        const hasExistingOrder = this.host.openOrders.some(
          (o) => !o.isBid && (o.levelDesc === sellNames[idx] || (lvl && Math.abs(o.price - lvl) / lvl <= 0.001)),
        );
        if (hasExistingOrder) return true;
        if (this.host.soldSellIndices.has(idx)) return false;
        return lvl > minAllowedSellPrice;
      })
      .map(({ idx }) => idx);

    if (eligibleSellIndices.length === 0 && held >= (this.host.minQty || 0.0001)) {
      for (let i = sellLevels.length - 1; i >= 0; i--) {
        if (enabledSells[i]) {
          eligibleSellIndices.push(i);
          break;
        }
      }
    }

    const minOrderNotional = Math.max(this.host.minNotional || 5.0, 5.0);
    let targetTrancheCount = eligibleSellIndices.length;

    if (targetTrancheCount > 0 && (held / targetTrancheCount) * minAllowedSellPrice < minOrderNotional) {
      if (targetTrancheCount >= 2 && (held / 2) * minAllowedSellPrice >= minOrderNotional) {
        targetTrancheCount = 2;
      } else {
        targetTrancheCount = 1;
      }
    }

    const activeSellIndices = eligibleSellIndices.slice(0, targetTrancheCount);
    const numActiveLevels = activeSellIndices.length > 0 ? activeSellIndices.length : (sellLevels.length || 5);
    const trancheQty = held / numActiveLevels;

    const hasMissingEligibleSellOrders = activeSellIndices.some((idx) => {
      const lvlPrice = sellLevels[idx];
      return !this.host.openOrders.some(
        (o) => !o.isBid && (o.levelDesc === sellNames[idx] || (lvlPrice && Math.abs(o.price - lvlPrice) / lvlPrice <= 0.001)),
      );
    });

    const doSellRebalance = this.host.needsSellRebalance;
    this.host.needsSellRebalance = false;

    const totalBaseInOpenSells = this.host.openOrders
      .filter((o) => !o.isBid)
      .reduce((sum, o) => sum + o.qty, 0);

    const isInventoryFullyCovered =
      !hasMissingEligibleSellOrders &&
      (totalBaseInOpenSells >= held * 0.98 || Math.abs(totalBaseInOpenSells - held) <= Math.max(0.01, (this.host.minQty || 1) * 0.5));

    for (let i = 0; i < sellLevels.length; i++) {
      const originalLvlPrice = sellLevels[i];
      if (!originalLvlPrice) continue;
      if (!enabledSells[i]) continue;

      const currentOpenSellAtLvl = this.host.openOrders.find(
        (o) => !o.isBid && (o.levelDesc === sellNames[i] || (!o.levelDesc && Math.abs(o.price - originalLvlPrice) / originalLvlPrice <= 0.001)),
      );

      if (!activeSellIndices.includes(i)) {
        if (currentOpenSellAtLvl) {
          await cancelOrderInternal(currentOpenSellAtLvl, "Consolidating sell tranches into faster levels (Target 1 & 2) to satisfy min notional");
          this.host.openOrders = this.host.openOrders.filter((o) => o !== currentOpenSellAtLvl);
          this.host.saveState();
        }
        continue;
      }

      const isFinalExitLevel = i === activeSellIndices[activeSellIndices.length - 1];
      const activeRank = activeSellIndices.indexOf(i);
      const targetHoldingFraction = isFinalExitLevel
        ? 0.0
        : (activeSellIndices.length - 1 - activeRank) / activeSellIndices.length;

      // IOC Sell when market price has reached or exceeded this sell target (IOC_BRACKET mode only)
      if (!currentOpenSellAtLvl) {
        const isPriceExceeded = currentBestBid > 0 && currentBestBid >= originalLvlPrice;
        if (isPriceExceeded && (this.host.cfg.enableIocSellWhenExceeded !== false) && this.host.cfg.orderExecutionMode === "IOC_BRACKET") {
          const currentHoldFraction = maxInv > 0 ? (currentHeldQuote / maxInv) : 0;
          const isLevelAlreadyFulfilled = currentHoldFraction <= targetHoldingFraction || isInventoryFullyCovered;
          if (isLevelAlreadyFulfilled) {
            continue;
          }
          const heldNow = this.lotTracker.baseHeld();
          if (heldNow >= this.host.minQty) {
            const maxBidDiscount = (this.host.cfg.cutLossMaxBidDiscountPct ?? 2.5) / 100;
            const isBidHealthy = currentBestBid > 0 && ((refPrice - currentBestBid) / refPrice) <= maxBidDiscount;
            const isProfitOk = mode !== "PORTFOLIO_AVG_PROFIT" || avgEntry <= 0 || currentBestBid >= avgEntry * 1.001;

            if (isBidHealthy && isProfitOk) {
              const iocCooldownKey = `ioc_sell_${sellNames[i]}`;
              const lastIoc = this.host.orderCooldowns.get(iocCooldownKey) ?? 0;
              if (Date.now() - lastIoc > 15_000) {
                let desiredSellQty = trancheQty;
                if (isFinalExitLevel && mode !== "LOT_BASED_PROFIT") {
                  desiredSellQty = Math.max(trancheQty, heldNow - (trancheQty * (numActiveLevels - 1)));
                }
                desiredSellQty = Math.min(this.lotTracker.baseHeld(), desiredSellQty);

                if (desiredSellQty >= this.host.minQty) {
                  this.host.orderCooldowns.set(iocCooldownKey, Date.now());
                  const success = await sellTrancheIOC(
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

      let lvlPrice = originalLvlPrice;
      const minMakerPrice = Math.max(currentBestAsk, refPrice * 1.0005);
      if (lvlPrice <= currentBestBid) {
        lvlPrice = Math.max(lvlPrice, minMakerPrice);
      }

      let desiredSellQty = trancheQty;
      if (isFinalExitLevel && mode !== "LOT_BASED_PROFIT") {
        desiredSellQty = Math.max(trancheQty, this.lotTracker.baseHeld() - (trancheQty * (numActiveLevels - 1)));
      }

      if (currentOpenSellAtLvl) {
        const priceDiffRatio = Math.abs(currentOpenSellAtLvl.price - lvlPrice) / lvlPrice;
        const shiftTol = this.host.cfg.minChannelShiftPct ? this.host.cfg.minChannelShiftPct / 100 : 0.008;
        const isPriceShifted = priceDiffRatio > shiftTol;

        const isCexExchange = this.host.binance.exchangeName !== "dreamdex";
        const targetSellQty = desiredSellQty >= (this.host.minQty || 0.001) ? desiredSellQty : trancheQty;
        const currentQtyDiffRatio = Math.abs(currentOpenSellAtLvl.qty - targetSellQty) / Math.max(0.000001, targetSellQty);
        const currentQtyTol = this.host.cfg.orderQtyTolerancePct ? this.host.cfg.orderQtyTolerancePct / 100 : 0.05;
        const needsQtyResize = (doSellRebalance || hasMissingEligibleSellOrders || (isCexExchange && currentQtyDiffRatio > 0.10)) && currentQtyDiffRatio > currentQtyTol;

        if (isPriceShifted || needsQtyResize) {
          const reason = isPriceShifted
            ? `Channel shifted: aligning sell price ($${currentOpenSellAtLvl.price.toFixed(6)} -> $${lvlPrice.toFixed(6)})`
            : `Rebalancing sell quantity to equal tranche (${currentOpenSellAtLvl.qty.toFixed(4)} -> ${targetSellQty.toFixed(4)} ${this.host.baseAsset})`;
          await cancelOrderInternal(currentOpenSellAtLvl, reason);
          this.host.openOrders = this.host.openOrders.filter((o) => o !== currentOpenSellAtLvl);
          await placeRestingOrder(
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

      if (isInventoryFullyCovered && !doSellRebalance) {
        continue;
      }

      if (desiredSellQty < (this.host.minQty || 0.001)) continue;

      const isEligibleForNewOrder = lvlPrice > minAllowedSellPrice;
      if (isEligibleForNewOrder) {
        await placeRestingOrder(
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
