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

export interface SyncBuyOrdersParams {
  buyLevels: number[];
  sellLevels: number[];
  lowerBound: number;
  upperBound: number;
  span: number;
  positionPct: number;
  canBuy: boolean;
  currentBestAsk: number;
  currentBestBid: number;
  refPrice: number;
  activeDowntrendLine?: TrendLine;
  activeUptrendLine?: TrendLine;
  uptrendBroken?: boolean;
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
  buyTrancheIOC: (
    qty: number,
    execPrice: number,
    levelName: string,
    targetPrice: number,
    notionalQuote: number,
  ) => Promise<boolean>;
}

export class BuyOrderSynchronizer {
  constructor(
    private host: IStrategyHost,
    private lotTracker: LotTracker,
  ) {}

  /**
   * Synchronizes resting maker buy limit orders according to current channel structure.
   * Enforces Anti-waterfall Staged Window Guard, Neckline Breakdown Guard, Cooldowns,
   * Dynamic Budget Allocation, and Ineligible Order Cancellation.
   */
  public async syncBuyOrders(params: SyncBuyOrdersParams): Promise<void> {
    const {
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
      activeDowntrendLine,
      activeUptrendLine,
      uptrendBroken,
      liveRealCeil,
      dow,
      cancelAllRestingOrders,
      cancelOrderInternal,
      placeRestingOrder,
      buyTrancheIOC,
    } = params;

    const currentHeldQuote = this.lotTracker.baseHeld() * refPrice;
    const maxInv = this.host.cfg.maxInventoryQuote;
    const currentHoldFraction = maxInv > 0 ? (currentHeldQuote / maxInv) : 0;
    const isCexExchange = this.host.binance.exchangeName === "binance";

    const priceTol = (this.host.cfg.orderPriceTolerancePct ?? 0.8) / 100;
    const qtyTol = (this.host.cfg.orderQtyTolerancePct ?? 20) / 100;

    const isBelowFloor = refPrice < lowerBound;
    if (isBelowFloor) {
      const openBuys = this.host.openOrders.filter((o) => o.isBid);
      if (openBuys.length > 0) {
        await cancelAllRestingOrders("BUY", "Price dropped below floor / Cut loss active");
      }
      return;
    }

    if (!canBuy) {
      // If buying is disallowed (e.g. Wait Higher Low, Downtrend, Trendline Guard, Broken Trend Support, Lag Guard, Offload Only),
      // cancel all active resting buys on-chain immediately to prevent unexpected fills!
      const openBuys = this.host.openOrders.filter((o) => o.isBid);
      if (openBuys.length > 0) {
        const sellLevel1Price = sellLevels[0] ?? (lowerBound + span * 0.60);
        const pauseReason = !this.host.buyOrdersActive
          ? `Price ($${refPrice.toFixed(6)} | ${positionPct.toFixed(1)}%) above Sell Level 1 ($${sellLevel1Price.toFixed(6)}) — buying paused to prevent churn in upper profit zone`
          : uptrendBroken
          ? `Trend support broken ($${activeUptrendLine?.currentLinePrice.toFixed(6)}) — buying paused, waiting to sell or cut loss`
          : (this.host.cfg.enableBaseConfirmationFilter !== false && this.host.waitingForHigherLow)
          ? "Waiting for Higher Low — cancelled resting buy orders"
          : (this.host.cfg.enableBaseConfirmationFilter !== false && this.host.isDowntrendDropPaused)
          ? "Active Downtrend Drop (LH+LL) — waiting for HL or Trendline Breakout"
          : "Buying paused by filters (Downtrend/Trendline/Lag Guard/Offload)";
        await cancelAllRestingOrders("BUY", pauseReason);
      }
      return;
    }

    const isSingleBuyLevel = buyLevels.length === 1;
    const buyBufPct = this.host.cfg.narrowChannelBuyBufferPct ?? 0.05;
    const buyPcts = this.host.cfg.buyLevelPcts ?? [42, 32, 22, 12, 2];
    const levelNames = isSingleBuyLevel
      ? [`Buy Edge Floor (+${buyBufPct.toFixed(2)}%)`]
      : buyLevels.map((_, idx) => `Buy Level ${idx + 1} (${buyPcts[idx] ?? Math.round(42 - idx * 10)}%)`);

    const enabledBuys = Array.isArray(this.host.cfg.enabledBuyLevels) ? this.host.cfg.enabledBuyLevels : [true, true, true, true, true];
    const highestEnabledBuyPrice = buyLevels.find((_, idx) => enabledBuys[idx]) ?? (buyLevels[0] ?? 0);
    const sellLevel1Limit = sellLevels[0] ?? upperBound;

    // Check if Uptrend Support Line is active and sits above standard enabled buy targets
    const isTlAboveBuyTarget = Boolean(
      Boolean(this.host.cfg.enableBuyAboveTrendSupport) &&
      activeUptrendLine &&
      !activeUptrendLine.isBroken &&
      refPrice >= activeUptrendLine.currentLinePrice * 0.995 &&
      activeUptrendLine.currentLinePrice > highestEnabledBuyPrice &&
      activeUptrendLine.currentLinePrice < sellLevel1Limit
    );

    const isTrendSupportGuarded = Boolean(this.host.cfg.enableBuyAboveTrendSupport);
    const isDowntrendBreakoutConfirmed = Boolean(
      activeDowntrendLine && (activeDowntrendLine.breakoutConfirmed || (activeDowntrendLine.brokenCandleCount ?? 0) >= 2)
    );

    // ── Resistance Profit Margin Guard (Trendline & Real Ceil) ────────────
    const isTlActive = (this.host.cfg.enableSellBelowTrendResistance !== false) &&
      Boolean(activeDowntrendLine && !isDowntrendBreakoutConfirmed);
    const isRealCeilActive = (this.host.cfg.enableSellAtRealCeiling !== false) &&
      liveRealCeil !== undefined && liveRealCeil > 0 && liveRealCeil < upperBound;
    const hasResistanceOverride = isTlActive || isRealCeilActive;
    const effectiveResistancePrice = hasResistanceOverride
      ? Math.min(
          isTlActive && activeDowntrendLine ? activeDowntrendLine.currentLinePrice : Infinity,
          isRealCeilActive && liveRealCeil ? liveRealCeil : Infinity,
        )
      : Infinity;

    const effectiveMinProfitPct = Math.max(0.20, this.host.cfg.minNetProfitPct ?? 0.25);
    const minResProfitMarginPct = effectiveMinProfitPct + 0.10;
    const maxAllowedBuyUnderRes = effectiveResistancePrice < Infinity
      ? effectiveResistancePrice * (1 - minResProfitMarginPct / 100)
      : Infinity;

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

    const buyWeightFractions = this.host.getBuyLevelWeightFractions(enabledBuys, effectiveBuyLevels.length, isTlAboveBuyTarget);
    const buyTargets = effectiveBuyLevels.map((_, idx) =>
      this.host.getCumulativeBuyTargetFraction(idx, enabledBuys, effectiveBuyLevels.length, isTlAboveBuyTarget)
    );

    // Clean up stale resting buy orders or correct mislabeled levelDesc to closest buyLevel
    const remainingStaleBuys: OpenOrder[] = [];
    for (const o of this.host.openOrders) {
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
          this.host.log(`🔗 [sync] Re-linked resting BUY order #${o.onChainOrderId || o.id} (${oldName} -> ${o.levelDesc}) @ $${o.price.toFixed(6)}`);
        }
      } else if (!o.levelDesc || !effectiveLevelNames.includes(o.levelDesc)) {
        remainingStaleBuys.push(o);
      }
    }

    if (remainingStaleBuys.length > 0) {
      for (const o of remainingStaleBuys) {
        await cancelOrderInternal(o, "Channel shifted / Level no longer in buy zone");
      }
      this.host.openOrders = this.host.openOrders.filter((o) => !remainingStaleBuys.includes(o));
      this.host.saveState();
    }

    // Rebalance Buy side: track available capacity across all buy levels
    const openBuys = this.host.openOrders.filter((o) => o.isBid);
    const currentAvailableCapacity = Math.max(0, maxInv - currentHeldQuote);
    const minOrderNotional = Math.max(this.host.minNotional || 5.0, 5.0);

    // ── Intra-Channel Structural Breakdown Guard ─────────────────────────
    const annotatedSwings = dow?.waveCycle?.annotatedSwings ?? [];
    const confirmedHighs = annotatedSwings.filter((s) => s.type === "HIGH");
    const latestConfirmedHigh = confirmedHighs.length > 0 ? confirmedHighs[confirmedHighs.length - 1] : undefined;
    const prevConfirmedHigh = confirmedHighs.length > 1 ? confirmedHighs[confirmedHighs.length - 2] : undefined;

    const candidatePeakLower = Boolean(
      dow?.candidatePeak &&
      (dow.candidatePeak.confirmationCandles ?? 0) >= 2 &&
      latestConfirmedHigh &&
      dow.candidatePeak.price < latestConfirmedHigh.price
    );

    const isLatestHighLh = Boolean(
      latestConfirmedHigh?.dowLabel === "LH" || (
        prevConfirmedHigh && latestConfirmedHigh && latestConfirmedHigh.price < prevConfirmedHigh.price
      )
    );

    const hasBearishPeak = Boolean(isLatestHighLh || candidatePeakLower);

    let structuralBreakdownLow: { price: number; time: number; index?: number } | undefined;
    if (hasBearishPeak) {
      const refHighTime = candidatePeakLower
        ? (dow?.candidatePeak?.time ?? Infinity)
        : (latestConfirmedHigh?.time ?? Infinity);
      const refHighIdx = candidatePeakLower
        ? Infinity
        : (latestConfirmedHigh?.index ?? Infinity);

      for (let sIdx = annotatedSwings.length - 1; sIdx >= 0; sIdx--) {
        const sw = annotatedSwings[sIdx];
        if (sw.type === "LOW") {
          const swIdx = sw.index ?? 0;
          const swTime = sw.time ?? 0;
          if (swIdx < refHighIdx && swTime < refHighTime) {
            structuralBreakdownLow = sw;
            break;
          }
        }
      }
      if (!structuralBreakdownLow) {
        structuralBreakdownLow = dow?.lastSwingLow ?? dow?.waveCycle?.lastLl;
      }
    }

    const isLlContinuationBreakdown = Boolean(
      structuralBreakdownLow &&
      hasBearishPeak &&
      refPrice < structuralBreakdownLow.price * 1.0005
    );

    // ── Post-Buy Cooldown & Intra-Candle Waterfall Guard ────────────────
    const buyFillCooldownMs = 60_000;
    const isWithinBuyCooldown = this.host.lastBuyFillTime > 0 && (Date.now() - this.host.lastBuyFillTime < buyFillCooldownMs);
    const closedCandles = this.host.dowEngine?.getClosedCandles();
    const latestClosedCandle = closedCandles && closedCandles.length > 0 ? closedCandles[closedCandles.length - 1] : undefined;
    const currentClosedCandleTime = this.host.confirmedChannel?.candleTime ?? (latestClosedCandle?.time ?? 0);
    const isSameCandleAsLastBuy = this.host.lastBuyFillCandleTime > 0 && this.host.lastBuyFillCandleTime === currentClosedCandleTime;
    const isPriceDumpingPostBuy = this.host.lastBuyFillPrice > 0 && refPrice < this.host.lastBuyFillPrice * 0.9975;
    const isIntraCandleWaterfallActive = isSameCandleAsLastBuy && isPriceDumpingPostBuy;

    // Determine which buy levels are actually eligible for placing/holding orders
    const eligibleBuyIndices = effectiveBuyLevels
      .map((lvl, idx) => ({ lvl, idx }))
      .filter(({ lvl, idx }) => {
        if (!lvl) return false;
        const isLevelEnabled = (idx === 0 && isTlAboveBuyTarget) ? enabledBuys.some(Boolean) : (enabledBuys[idx] !== false);
        if (!isLevelEnabled) return false;

        const levelWeightFrac = buyWeightFractions[idx] ?? (activeBuyCount > 0 ? (1 / activeBuyCount) : 0.2);
        const expectedTrancheQuote = isSingleBuyLevel ? maxInv : (maxInv * levelWeightFrac);
        const expectedTrancheQty = lvl > 0 ? (expectedTrancheQuote / lvl) : 0;

        // Cumulative Exposure Quota Guard: If current inventory already fulfills or exceeds this level's target,
        // this level is fulfilled and not eligible for duplicate buys (even across dynamic channel shifts).
        const targetExposure = buyTargets[idx] ?? 1.0;
        const isQuotaFulfilled = currentHoldFraction >= (targetExposure - 0.01);
        if (isQuotaFulfilled) {
          return false;
        }

        if (this.lotTracker.hasLotNearLevel(lvl, idx, effectiveBuyLevels, expectedTrancheQty)) {
          return false;
        }

        if (currentHoldFraction >= 0.95) {
          return false;
        }
        if (effectiveResistancePrice < Infinity && lvl >= maxAllowedBuyUnderRes) {
          return false;
        }
        if (isTrendSupportGuarded && activeUptrendLine && !activeUptrendLine.isBroken && lvl < activeUptrendLine.currentLinePrice * 0.998) {
          return false;
        }
        if (this.host.cfg.enableBaseConfirmationFilter !== false && isLlContinuationBreakdown && structuralBreakdownLow && lvl < structuralBreakdownLow.price * 1.0005) {
          return false;
        }
        if (this.host.cfg.enableBaseConfirmationFilter !== false && this.host.cfg.enableWaterfallKnifeGuard !== false && this.host.cfg.orderExecutionMode === "MAKER_LIMIT" && (isWithinBuyCooldown || isIntraCandleWaterfallActive) && this.host.lastBuyFillPrice > 0 && lvl < this.host.lastBuyFillPrice * 0.999) {
          return false;
        }
        // In MAKER_LIMIT mode: buy orders must strictly be placed below current market price!
        // Levels at or above current market price are not eligible (waiting for price to dip below them).
        if (this.host.cfg.orderExecutionMode === "MAKER_LIMIT" && lvl >= maxAllowedBuyPrice) {
          return false;
        }
        return true;
      })
      .map(({ idx }) => idx);

    // ── Staged Maker Buy Window Guard ──────────────────────────────────
    // On Binance CEX: place all active levels below price (up to 5 levels) so levels 5, 4, 3 are all active simultaneously.
    // On DreamDEX: limit to maxActiveMakerBuys (default 2) to manage on-chain gas fees.
    const configuredMaxBuys = Number(this.host.cfg.maxActiveMakerBuys);
    const maxActiveBuys = isCexExchange
      ? 5
      : (Number.isFinite(configuredMaxBuys) && configuredMaxBuys > 0 ? configuredMaxBuys : 2);

    const eligiblePlacableBuyIndices = eligibleBuyIndices.filter((idx) => {
      const lvl = effectiveBuyLevels[idx];
      if (!lvl) return false;
      const hasOpenBuy = openBuys.some((o) => (o.levelDesc && effectiveLevelNames[idx] && o.levelDesc.startsWith(effectiveLevelNames[idx])) || Math.abs(o.price - lvl) / lvl <= 0.001);
      return hasOpenBuy || lvl <= maxAllowedBuyPrice;
    });

    const sortedEligibleByPriceDesc = [...eligiblePlacableBuyIndices].sort((a, b) => {
      const pA = effectiveBuyLevels[a] ?? 0;
      const pB = effectiveBuyLevels[b] ?? 0;
      return pB - pA;
    });
    const activeWindowBuyIndices = new Set(sortedEligibleByPriceDesc.slice(0, maxActiveBuys));

    const numBuyLevels = effectiveBuyLevels.length || 5;
    const doBuyRebalance = this.host.needsBuyRebalance;
    this.host.needsBuyRebalance = false;

    // If capacity is full (held inventory >= maxInv), cancel resting buy orders
    if (currentAvailableCapacity < (this.host.minQty * (refPrice || 0.2))) {
      if (openBuys.length > 0) {
        for (const o of openBuys) {
          await cancelOrderInternal(o, "Inventory capacity full — canceling resting buy orders");
        }
        this.host.openOrders = this.host.openOrders.filter((o) => !openBuys.includes(o));
        this.host.saveState();
      }
    }

    // If open buys exceed the number of active buy levels, trim unmapped or excess duplicates
    const activeLevelNamesSet = new Set(effectiveLevelNames.slice(0, numBuyLevels));
    const unmappedBuys = openBuys.filter((o) => !o.levelDesc || !activeLevelNamesSet.has(o.levelDesc));
    if (unmappedBuys.length > 0) {
      for (const o of unmappedBuys) {
        await cancelOrderInternal(o, "Excess buy orders beyond grid levels — removing unmapped");
      }
      this.host.openOrders = this.host.openOrders.filter((o) => !unmappedBuys.includes(o));
      this.host.saveState();
    } else {
      const duplicatesToTrim: OpenOrder[] = [];
      for (let i = 0; i < effectiveBuyLevels.length; i++) {
        const lvlName = effectiveLevelNames[i];
        const lvlPrice = effectiveBuyLevels[i];
        if (!lvlName || !lvlPrice) continue;
        const ordersAtLevel = openBuys.filter((o) => o.levelDesc === lvlName);
        if (ordersAtLevel.length > 1) {
          ordersAtLevel.sort((a, b) => Math.abs(a.price - lvlPrice) - Math.abs(b.price - lvlPrice));
          const extras = ordersAtLevel.slice(1);
          duplicatesToTrim.push(...extras);
        }
      }

      if (duplicatesToTrim.length > 0) {
        for (const o of duplicatesToTrim) {
          await cancelOrderInternal(o, `Duplicate buy order at ${o.levelDesc} — keeping closest to grid price`);
        }
        this.host.openOrders = this.host.openOrders.filter((o) => !duplicatesToTrim.includes(o));
        this.host.saveState();
      } else if (openBuys.length > numBuyLevels) {
        const excessBuys = openBuys.filter((o) => !effectiveBuyLevels.some((lvl) => Math.abs(o.price - lvl) / lvl <= 0.0015));
        for (const o of excessBuys) {
          await cancelOrderInternal(o, "Excess buy orders beyond grid levels — removing non-matching");
        }
        if (excessBuys.length > 0) {
          this.host.openOrders = this.host.openOrders.filter((o) => !excessBuys.includes(o));
          this.host.saveState();
        }
      }
    }

    // ── Ineligible Level Cancel Guard (Strict Budget & Level Allocation) ──
    const ineligibleOpenBuys = openBuys.filter((o) => {
      const lvlIdx = effectiveLevelNames.indexOf(o.levelDesc || "");
      return lvlIdx >= 0 && !eligibleBuyIndices.includes(lvlIdx);
    });
    if (ineligibleOpenBuys.length > 0) {
      for (const o of ineligibleOpenBuys) {
        const ordNotional = (o.notionalQuote !== undefined ? o.notionalQuote : o.notionalUsdso) || (o.price * o.qty);
        let cancelReason = `Level allocation target fulfilled (${o.levelDesc}) — releasing locked budget ($${ordNotional.toFixed(2)}) for remaining eligible levels`;
        if (this.host.cfg.enableBaseConfirmationFilter !== false && isLlContinuationBreakdown && structuralBreakdownLow && o.price < structuralBreakdownLow.price * 1.0005) {
          cancelReason = `Dow continuation breakdown: price ($${refPrice.toFixed(4)}) breaking below support ($${structuralBreakdownLow.price.toFixed(4)}) after LH — cancelling buys below broken support`;
        } else if (this.host.cfg.enableBaseConfirmationFilter !== false && this.host.cfg.enableWaterfallKnifeGuard !== false && this.host.cfg.orderExecutionMode === "MAKER_LIMIT" && (isWithinBuyCooldown || isIntraCandleWaterfallActive) && this.host.lastBuyFillPrice > 0 && o.price < this.host.lastBuyFillPrice * 0.999) {
          cancelReason = isIntraCandleWaterfallActive
            ? `Intra-candle waterfall guard: price dumping post-buy — cancelling deep buy (${o.levelDesc}) until candle stabilizes`
            : `Buy fill cooldown: waiting ${Math.ceil((buyFillCooldownMs - (Date.now() - this.host.lastBuyFillTime)) / 1000)}s before placing deep buy (${o.levelDesc})`;
        } else if (effectiveResistancePrice < Infinity && o.price >= maxAllowedBuyUnderRes) {
          const marginPct = ((effectiveResistancePrice - o.price) / o.price) * 100;
          const isTl = isTlActive && activeDowntrendLine && effectiveResistancePrice === activeDowntrendLine.currentLinePrice;
          const resDisplayName = isTl ? "Trendline" : "Real S/R Ceil";
          cancelReason = o.price >= effectiveResistancePrice
            ? `${resDisplayName} resistance filter: buy @ $${o.price.toFixed(4)} >= ${resDisplayName} $${effectiveResistancePrice.toFixed(4)} — suppressed until breakout`
            : `${resDisplayName} profit guard: buy @ $${o.price.toFixed(4)} too close to ${resDisplayName} $${effectiveResistancePrice.toFixed(4)} (margin ${marginPct.toFixed(2)}% < min ${minResProfitMarginPct.toFixed(2)}%) — suppressed until breakout`;
        } else if (isTrendSupportGuarded && activeUptrendLine && !activeUptrendLine.isBroken && o.price < activeUptrendLine.currentLinePrice * 0.998) {
          cancelReason = `Trend support filter: buy @ $${o.price.toFixed(6)} < Support TL $${activeUptrendLine.currentLinePrice.toFixed(6)} — cancelled to prevent below-TL fill`;
        } else if (currentHoldFraction >= 0.95) {
          cancelReason = `Portfolio capacity full (${(currentHoldFraction * 100).toFixed(1)}%) — cancelling ${o.levelDesc}`;
        }

        await cancelOrderInternal(o, cancelReason);
      }
      this.host.openOrders = this.host.openOrders.filter((o) => !ineligibleOpenBuys.includes(o));
      this.host.saveState();
    }

    for (let i = 0; i < effectiveBuyLevels.length; i++) {
      const lvlPrice = effectiveBuyLevels[i];
      if (!lvlPrice) continue;

      const isLevelEnabled = (i === 0 && isTlAboveBuyTarget) ? enabledBuys.some(Boolean) : (enabledBuys[i] !== false);
      if (!isLevelEnabled) {
        const existingDisabledBuy = this.host.openOrders.find(
          (o) => o.isBid && (o.levelDesc === effectiveLevelNames[i] || (!o.levelDesc && Math.abs(o.price - lvlPrice) / lvlPrice <= 0.001)),
        );
        if (existingDisabledBuy) {
          await cancelOrderInternal(
            existingDisabledBuy,
            `User disabled Buy Level ${i + 1} — cancelling resting order`,
          );
          this.host.openOrders = this.host.openOrders.filter((o) => o !== existingDisabledBuy);
          this.host.saveState();
        }
        continue;
      }

      if (!eligibleBuyIndices.includes(i)) {
        continue;
      }

      // ── Staged Maker Buy Window Guard (Anti-Waterfall) ──────────────────
      if (this.host.cfg.orderExecutionMode === "MAKER_LIMIT" && !activeWindowBuyIndices.has(i)) {
        const currentDistantBuy = this.host.openOrders.find(
          (o) => o.isBid && (o.levelDesc === effectiveLevelNames[i] || (!o.levelDesc && Math.abs(o.price - lvlPrice) / lvlPrice <= 0.001)),
        );
        if (currentDistantBuy) {
          await cancelOrderInternal(
            currentDistantBuy,
            `Staged window guard: buy level ${i + 1} is beyond next ${maxActiveBuys} active levels — will place when price approaches`,
          );
          this.host.openOrders = this.host.openOrders.filter((o) => o !== currentDistantBuy);
          this.host.saveState();
        }
        continue;
      }

      const currentOpenBuyAtLvl = this.host.openOrders.find(
        (o) => o.isBid && ((o.levelDesc && effectiveLevelNames[i] && o.levelDesc.startsWith(effectiveLevelNames[i])) || (!o.levelDesc && Math.abs(o.price - lvlPrice) / lvlPrice <= 0.001)),
      );

      const otherOpenBuysQuote = this.host.openOrders
        .filter((o) => o.isBid && o !== currentOpenBuyAtLvl)
        .reduce((sum, o) => sum + ((o.notionalQuote !== undefined ? o.notionalQuote : o.notionalUsdso) || (o.price * o.qty)), 0);
      const remainingCapacityForOrder = Math.max(0, currentAvailableCapacity - otherOpenBuysQuote);
      const isPyramid = (this.host.cfg.buySizingMode ?? "PYRAMID") === "PYRAMID";
      const rawWeights = Array.isArray(this.host.cfg.buyLevelWeights) && this.host.cfg.buyLevelWeights.length >= 5
        ? this.host.cfg.buyLevelWeights
        : [10, 15, 20, 25, 30];

      const totalEligibleBuyWeight = eligibleBuyIndices.reduce((sum, idx) => {
        const w = isPyramid ? Math.max(1, Number(rawWeights[idx]) || 10) : 1;
        return sum + w;
      }, 0);

      const myWeight = isPyramid ? Math.max(1, Number(rawWeights[i]) || 10) : 1;
      const eligibleWeightFrac = totalEligibleBuyWeight > 0
        ? (myWeight / totalEligibleBuyWeight)
        : (1 / Math.max(1, eligibleBuyIndices.length));

      let levelTrancheQuote = isSingleBuyLevel ? currentAvailableCapacity : (currentAvailableCapacity * eligibleWeightFrac);
      if (levelTrancheQuote < minOrderNotional && currentAvailableCapacity >= minOrderNotional) {
        levelTrancheQuote = Math.min(currentAvailableCapacity, minOrderNotional);
      }
      const targetOrderQuote = Math.min(levelTrancheQuote, remainingCapacityForOrder);

      if (currentOpenBuyAtLvl) {
        const priceDiffRatio = Math.abs(currentOpenBuyAtLvl.price - lvlPrice) / lvlPrice;
        const priceTolerance = priceTol;
        const currentOrderNotional = currentOpenBuyAtLvl.notionalQuote !== undefined ? currentOpenBuyAtLvl.notionalQuote : currentOpenBuyAtLvl.notionalUsdso;
        const totalOpenBuysQuote = otherOpenBuysQuote + currentOrderNotional;
        const isTotalExposureExceeded = totalOpenBuysQuote > currentAvailableCapacity * 1.05;

        const maxPossibleBudget = this.host.cfg.dryRun
          ? targetOrderQuote
          : Math.min(targetOrderQuote, Math.max(0, this.host.walletQuoteBalance) + currentOrderNotional);

        const effectiveDiff = Math.abs(currentOrderNotional - maxPossibleBudget);
        const effectiveDiffRatio = effectiveDiff / Math.max(0.01, maxPossibleBudget);
        const canResize = effectiveDiff >= Math.max(minOrderNotional * 0.5, 2.0);

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
          await cancelOrderInternal(currentOpenBuyAtLvl, reason);
          this.host.openOrders = this.host.openOrders.filter((o) => o !== currentOpenBuyAtLvl);

          const effectiveBuyQty = maxPossibleBudget / lvlPrice;
          const isEligibleForReplacement = lvlPrice <= maxAllowedBuyPrice && canBuy;
          if (isEligibleForReplacement && effectiveBuyQty >= this.host.minQty && maxPossibleBudget >= minOrderNotional) {
            await placeRestingOrder(
              true,
              lvlPrice,
              effectiveBuyQty,
              buyTargets[i] || 1.0,
              maxPossibleBudget,
              effectiveLevelNames[i] || `Buy Level ${i + 1}`,
            );
          }
        }
        continue;
      }

      if (currentHoldFraction >= 0.95) {
        continue;
      }
      const targetExposure = buyTargets[i] ?? 1.0;
      if (currentHoldFraction >= (targetExposure - 0.01)) {
        continue;
      }
      const expectedTrancheQty = lvlPrice > 0 ? (targetOrderQuote / lvlPrice) : 0;
      if (this.lotTracker.hasLotNearLevel(lvlPrice, i, effectiveBuyLevels, expectedTrancheQty)) {
        continue;
      }

      // On DreamDEX: if Ask <= lvlPrice, execute immediate IOC fill
      const isDexAskAtOrBelowLevel = !isCexExchange && this.host.cfg.orderExecutionMode === "IOC_BRACKET" && currentBestAsk > 0 && currentBestAsk <= lvlPrice;
      if (isDexAskAtOrBelowLevel && canBuy && targetOrderQuote > 0) {
        const availableBudget = this.host.cfg.dryRun
          ? targetOrderQuote
          : Math.min(targetOrderQuote, this.host.walletQuoteBalance);
        const desiredBuyQty = availableBudget / currentBestAsk;
        if (desiredBuyQty >= this.host.minQty && availableBudget >= minOrderNotional) {
          const actionLabel = effectiveLevelNames[i] || `Buy Level ${i + 1}`;
          this.host.log(
            `⚡ [DREAMDEX ASK MATCH] Ask $${currentBestAsk.toFixed(6)} <= ${actionLabel} ($${lvlPrice.toFixed(6)}) — executing immediate IOC fill for $${availableBudget.toFixed(2)} ${this.host.quoteAsset}`,
          );
          await buyTrancheIOC(desiredBuyQty, currentBestAsk, actionLabel, lvlPrice, availableBudget);
          continue;
        }
      }

      const isEligibleForNewOrder = lvlPrice <= maxAllowedBuyPrice && canBuy;
      if (isEligibleForNewOrder && targetOrderQuote > 0 && lvlPrice > 0) {
        const availableBudget = this.host.cfg.dryRun
          ? targetOrderQuote
          : Math.min(targetOrderQuote, this.host.walletQuoteBalance);
        const desiredBuyQty = availableBudget / lvlPrice;
        if (desiredBuyQty >= this.host.minQty && availableBudget >= minOrderNotional) {
          await placeRestingOrder(
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
