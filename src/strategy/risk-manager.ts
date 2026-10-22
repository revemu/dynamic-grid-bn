/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import type { IStrategyHost, OpenOrder } from "./types.js";
import type { Candle, DowStructure } from "../market-structure.js";
import { roundToStep, roundToTick } from "../exchange/binance/client.js";

export interface EvaluateCutLossParams {
  isChannelReady: boolean;
  lowerBound: number;
  upperBound: number;
  cutLossBound: number;
  bufferAmount: number;
  refPrice: number;
  span: number;
  buyLevels: number[];
  bestBid?: number;
  effectiveMid: number;
  lastClosedCandle?: Candle;
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
  sellAll: (price: number, action: "SELL" | "CUT" | "MANUAL", anchorRefPrice?: number) => Promise<void>;
}

export class RiskManager {
  constructor(private host: IStrategyHost) {}

  /**
   * Evaluates trend support line breakdown.
   * If decisively broken, liquidates position to quote asset and transitions into waitingForHigherLow.
   */
  public async evaluateTrendSupportBreak(params: {
    dow?: DowStructure;
    refPrice: number;
    lowerBound: number;
    span: number;
    buyLevels: number[];
    bestBid?: number;
    effectiveMid: number;
    isChannelReady: boolean;
    lastClosedCandle?: Candle;
    cancelAllRestingOrders: (side?: "BUY" | "SELL", reason?: string) => Promise<void>;
    sellAll: (price: number, action: "SELL" | "CUT" | "MANUAL", anchorRefPrice?: number) => Promise<void>;
  }): Promise<boolean> {
    const { dow, refPrice, lowerBound, span, buyLevels, bestBid, effectiveMid, isChannelReady, lastClosedCandle, cancelAllRestingOrders, sellAll } = params;
    const isBelowFloor = isChannelReady && refPrice < lowerBound;
    const uptrendLine = dow?.uptrendLine;
    const isExitOnTrendSupportBreak = this.host.cfg.enableExitOnTrendSupportBreak !== false;
    const uptrendKey = uptrendLine ? `${uptrendLine.p1.time}_${uptrendLine.p2.time}` : undefined;
    const isNewUptrendBreak = uptrendKey ? (this.host.lastTrendSupportBreakKey !== uptrendKey) : true;

    const closedCandles = this.host.dowEngine?.getClosedCandles() ?? [];
    const latestClosedCandle = closedCandles.length > 0 ? closedCandles[closedCandles.length - 1] : lastClosedCandle;

    // Decisive trend support breakdown requires:
    // 1. Confirmed closed candle below trendline, OR
    // 2. Real-time price dropped below trendline beyond floorBufferPct threshold (preventing intra-bar wicks), OR
    // 3. Multi-bar confirmed breakdown (uptrendBreakdownConfirmed)
    const trendSupportBufferPct = Math.max(0.20, this.host.cfg.floorBufferPct ?? 0.25);
    const isDecisiveSupportBreak = Boolean(
      uptrendLine && (
        dow?.uptrendBreakdownConfirmed ||
        (uptrendLine.brokenCandleCount ?? 0) >= 1 ||
        (latestClosedCandle && latestClosedCandle.close < uptrendLine.currentLinePrice * 0.9995) ||
        refPrice < uptrendLine.currentLinePrice * (1 - trendSupportBufferPct / 100)
      )
    );
    const isTrendSupportBroken = Boolean(
      isExitOnTrendSupportBreak &&
      uptrendLine &&
      isNewUptrendBreak &&
      isDecisiveSupportBreak
    );

    if (isTrendSupportBroken && !this.host.isPaused && !isBelowFloor) {
      if (uptrendKey) {
        this.host.lastTrendSupportBreakKey = uptrendKey;
      }
      const dustThreshold = this.host.minQty ? this.host.minQty * 0.5 : 1e-6;
      if (this.host.baseHeld() >= dustThreshold) {
        const dexBid = bestBid ?? effectiveMid;
        this.host.log(
          `🚨 [TREND SUPPORT BREAK] Price ($${refPrice.toFixed(6)}) broke below Support Trendline ($${uptrendLine.currentLinePrice.toFixed(6)}) — Liquidating 100% (${this.host.baseHeld().toFixed(4)} ${this.host.baseAsset}) to ${this.host.quoteAsset} to prevent holding crash knife!`,
        );
        if (this.host.openOrders.length > 0) {
          await cancelAllRestingOrders();
        }
        await sellAll(dexBid, "CUT");
        this.host.lastCutLossTime = Date.now();
        this.host.waitingForHigherLow = true;
        this.host.isFlatChannelShiftWaiting = false;
        this.host.isTrendSupportExitActive = true;
        this.host.trendSupportBreakPrice = uptrendLine.currentLinePrice;
        this.host.lastResolvedDumpLowPrice = undefined;
        this.host.breakdownFloorPrice = lowerBound;
        this.host.breakdownLowPrice = dexBid;
        this.host.breakdownTime = Math.floor(Date.now() / 1000);
        this.host.breakdownBuyLevel2Price = isChannelReady && buyLevels.length > 1 && buyLevels[1] > 0.0001
          ? buyLevels[1]
          : (lowerBound > 0 ? lowerBound + span * 0.32 : dexBid * 1.01);
        this.host.bufferBreakStartTime = undefined;
        this.host.cutLossStage1Executed = false;
        this.host.cutLossStage1Price = undefined;
        this.host.cutLossStage1CandleTime = undefined;
        this.host.postCutSingleTrancheOnly = true;
        this.host.iocBracketSellCycle = undefined;
        this.host.stuckSince = undefined;
        this.host.lastBuyFillTime = 0;
        this.host.lastBuyFillPrice = 0;
        this.host.lastBuyFillCandleTime = 0;
        this.host.breakdownCandleTimes.clear();
        this.host.saveState();
        return true;
      } else if (!this.host.waitingForHigherLow) {
        // In 100% cash already: cancel any resting buy orders to avoid catching a falling knife
        const openBuys = this.host.openOrders.filter((o) => o.isBid);
        if (openBuys.length > 0) {
          await cancelAllRestingOrders("BUY", "Trend Support Broken — Cancel buys to avoid catching crash knife");
        }
        this.host.waitingForHigherLow = true;
        this.host.isTrendSupportExitActive = true;
        this.host.trendSupportBreakPrice = uptrendLine.currentLinePrice;
        this.host.breakdownFloorPrice = lowerBound;
        this.host.breakdownLowPrice = refPrice;
        this.host.breakdownTime = Math.floor(Date.now() / 1000);
        this.host.saveState();
      }
    }
    return false;
  }

  /**
   * Evaluates Cut Loss / Stop Loss logic at 0% Channel Floor.
   * Handles:
   * 1. Fast Buffer Cut (instant or delay / candle close below buffer)
   * 2. Floor Candle Cut (optional via cutLossOnBufferOnly)
   * 3. Stage 1 (50% de-risk) with resting bounce exit limit sell at Floor
   * 4. Stage 2 (full liquidation) if price continues dropping below Stage 2 bound or candle closes below Stage 1
   * 5. Recovery if price climbs back above Floor
   *
   * Returns true if cut loss executed an exit and tick() should return early.
   */
  public async evaluateCutLoss(params: EvaluateCutLossParams): Promise<boolean> {
    const {
      isChannelReady,
      lowerBound,
      cutLossBound,
      bufferAmount,
      refPrice,
      span,
      buyLevels,
      bestBid,
      effectiveMid,
      lastClosedCandle,
      cancelAllRestingOrders,
      cancelOrderInternal,
      placeRestingOrder,
      sellTrancheIOC,
      sellAll,
    } = params;

    const isBelowFloor = isChannelReady && refPrice < lowerBound;
    const isBelowBuffer = isChannelReady && refPrice < cutLossBound;

    if (isBelowBuffer) {
      if (!this.host.bufferBreakStartTime) {
        this.host.bufferBreakStartTime = Date.now();
      }
    } else {
      this.host.bufferBreakStartTime = undefined;
    }

    const bufferDelayMs = Math.max(0, (this.host.cfg.cutLossBufferDelaySeconds ?? 60) * 1000);
    const bufferBreakElapsedMs = this.host.bufferBreakStartTime ? (Date.now() - this.host.bufferBreakStartTime) : 0;

    // Track confirmed CLOSED candles
    const closedCandles = this.host.dowEngine?.getClosedCandles() ?? [];
    const latestClosedCandle = closedCandles.length > 0 ? closedCandles[closedCandles.length - 1] : lastClosedCandle;
    const isBufferCandleClosed = Boolean(latestClosedCandle && latestClosedCandle.close < cutLossBound);

    const isFastBufferCut = isBelowBuffer && (bufferDelayMs <= 0 || bufferBreakElapsedMs >= bufferDelayMs || isBufferCandleClosed);

    if (this.host.cfg.cutLossAtLowerBound && isBelowFloor) {
      const isInitialBreakdown = !this.host.waitingForHigherLow;
      this.host.waitingForHigherLow = true;
      this.host.breakdownFloorPrice = this.host.breakdownFloorPrice ?? lowerBound;
      
      // BUG B FIX: If making new lower low below floor, update breakdownTime to current time
      if (this.host.breakdownLowPrice === undefined || refPrice < this.host.breakdownLowPrice) {
        this.host.breakdownLowPrice = refPrice;
        this.host.breakdownTime = Math.floor(Date.now() / 1000);
      }
      this.host.breakdownTime = this.host.breakdownTime ?? Math.floor(Date.now() / 1000);
      this.host.breakdownBuyLevel2Price = this.host.breakdownBuyLevel2Price ?? buyLevels[1];

      // Track confirmed CLOSED candle bars whose CLOSE price (body) is strictly below Channel Floor (lowerBound)
      let confirmedCandlesCount = 0;
      this.host.breakdownCandleTimes.clear();
      for (let i = closedCandles.length - 1; i >= 0; i--) {
        if (closedCandles[i].close < lowerBound) {
          confirmedCandlesCount++;
          this.host.breakdownCandleTimes.add(closedCandles[i].time);
        } else {
          break; // unbroken streak of closed candles below floor
        }
      }

      const cutLossOnBufferOnly = this.host.cfg.cutLossOnBufferOnly !== false;
      const isTwoStageEnabled = this.host.cfg.enableTwoStageCutLoss !== false;
      const stage2Mult = Math.max(1.2, Number(this.host.cfg.cutLossStage2Multiplier ?? 2.0));
      const stage2CutBound = lowerBound - bufferAmount * stage2Mult;
      const isBelowStage2Bound = isChannelReady && refPrice < stage2CutBound;

      const heldNow = this.host.baseHeld();
      const dexBidForCut = bestBid ?? effectiveMid;
      const minNotionalForSplit = Math.max(this.host.minNotional || 5.0, 5.0);
      const canDoStage1Split =
        !this.host.cutLossStage1Executed &&
        isTwoStageEnabled &&
        !isBelowStage2Bound &&
        (heldNow * dexBidForCut >= minNotionalForSplit * 2.1);

      const isStage2CandleClosed = Boolean(
        this.host.cutLossStage1Executed &&
        latestClosedCandle &&
        this.host.cutLossStage1CandleTime !== undefined &&
        latestClosedCandle.time > this.host.cutLossStage1CandleTime &&
        this.host.cutLossStage1Price !== undefined &&
        latestClosedCandle.close < this.host.cutLossStage1Price
      );
      const isStage2Triggered = Boolean(this.host.cutLossStage1Executed && (isBelowStage2Bound || isStage2CandleClosed));

      const isFloorCandleCut = (!cutLossOnBufferOnly || canDoStage1Split) && (confirmedCandlesCount >= (this.host.cfg.cutLossConfirmCandles ?? 1));
      const shouldExecuteCut = isFastBufferCut || isFloorCandleCut || isStage2Triggered;

      if (!this.host.isPaused && this.host.lots.length > 0) {
        const dexBid = bestBid ?? effectiveMid;
        const binancePrice = this.host.atrSource.getLatestPrice?.();
        const maxAllowedBidDiscount = this.host.cfg.cutLossMaxBidDiscountPct ?? 2.5;
        const bidDiscountPct = binancePrice && binancePrice > 0 ? ((binancePrice - dexBid) / binancePrice) * 100 : 0;
        const isBidTooDepressed = bidDiscountPct > maxAllowedBidDiscount;

        // Cancel resting buy orders immediately so we never buy more while below floor
        await cancelAllRestingOrders("BUY");

        if (isBidTooDepressed) {
          this.host.status(
            `⚠️ CUT LOSS PAUSED: Price broken below floor/buffer ($${refPrice.toFixed(6)} | Floor: $${lowerBound.toFixed(6)} | Buffer: $${cutLossBound.toFixed(6)}) but DEX Bid $${dexBid.toFixed(6)} is discounted ${bidDiscountPct.toFixed(2)}% below Binance (Limit: ${maxAllowedBidDiscount.toFixed(1)}%) — Holding off fire-sale dump until DEX Bid liquidity normalizes.`,
          );
        } else if (!shouldExecuteCut) {
          if (this.host.cutLossStage1Executed) {
            this.host.status(
              `🛡️ STAGE 1 DE-RISKED (50% HELD): Price $${refPrice.toFixed(6)} — holding bounce exit limit sell @ Floor $${lowerBound.toFixed(6)} unless Buffer ($${cutLossBound.toFixed(6)}) breaks`,
            );
          } else if (isBelowBuffer) {
            const remSec = Math.max(0, Math.ceil((bufferDelayMs - bufferBreakElapsedMs) / 1000));
            this.host.status(
              `⏳ FAST CUT PENDING (BUFFER BREAK): Price $${refPrice.toFixed(6)} < Buffer $${cutLossBound.toFixed(6)} — below buffer for ${(bufferBreakElapsedMs / 1000).toFixed(0)}s (${remSec}s remaining until Emergency Fast Cut)`,
            );
          } else if (cutLossOnBufferOnly) {
            this.host.status(
              `⏳ BELOW FLOOR (BUY PAUSED): Price $${refPrice.toFixed(6)} < Floor $${lowerBound.toFixed(6)} (Above Buffer $${cutLossBound.toFixed(6)}) — holding lots, buy paused until reclaim or buffer break`,
            );
          } else {
            this.host.status(
              `⏳ FLOOR BREAK PENDING (1 CANDLE): Price $${refPrice.toFixed(6)} < Floor $${lowerBound.toFixed(6)} — waiting for 1 confirmed CLOSED candle with body < Floor (Current: ${confirmedCandlesCount}/1 closed bar)`,
            );
          }
        } else {
          const lastClosedStr = lastClosedCandle ? `Last Closed Bar: $${lastClosedCandle.close.toFixed(6)} | ` : "";
          const exitActionDesc = this.host.openOrders.length > 0 ? "cancelling resting orders & executing clean exit" : "executing clean exit";
          const triggerReason = isFastBufferCut
            ? (bufferDelayMs <= 0
                ? `INSTANT CUT ON BUFFER BREAK: Price $${refPrice.toFixed(6)} < Buffer $${cutLossBound.toFixed(6)}`
                : (isBufferCandleClosed
                    ? `CLOSED CANDLE CONFIRMED BELOW BUFFER: ${lastClosedStr}Price $${refPrice.toFixed(6)} < Buffer $${cutLossBound.toFixed(6)}`
                    : `EMERGENCY FAST CUT (> ${Math.round(bufferDelayMs / 1000)}s BELOW BUFFER): Price $${refPrice.toFixed(6)} stayed below Buffer $${cutLossBound.toFixed(6)} for ${(bufferBreakElapsedMs / 1000).toFixed(0)}s`))
            : (isStage2CandleClosed
                ? `CLOSED CANDLE CONFIRMED BELOW STAGE 1 CUT: ${lastClosedStr}Price $${refPrice.toFixed(6)} < Stage 1 $${(this.host.cutLossStage1Price ?? 0).toFixed(6)}`
                : (isBelowStage2Bound
                    ? `PRICE REACHED STAGE 2 BOUND: Price $${refPrice.toFixed(6)} < $${stage2CutBound.toFixed(6)}`
                    : `1 CLOSED CANDLE CONFIRMED BELOW FLOOR: ${lastClosedStr}Price $${refPrice.toFixed(6)} closed below Floor $${lowerBound.toFixed(6)}`));

          if (canDoStage1Split) {
            const effStepSize = this.host.stepSize || (this.host.qtyPrecision ? 10 ** -this.host.qtyPrecision : 1e-6);
            const halfQty = roundToStep(heldNow * 0.50, effStepSize, this.host.qtyPrecision);
            this.host.log(
              `🛡️ CUT LOSS STAGE 1/2 (50% DE-RISK | ${triggerReason}): Selling 50% (${halfQty.toFixed(4)} ${this.host.baseAsset}) @ Bid $${dexBid.toFixed(6)} — holding remaining 50% with bounce limit sell @ Floor $${lowerBound.toFixed(6)} unless Buffer ($${cutLossBound.toFixed(6)}) breaks`,
            );
            if (this.host.openOrders.length > 0) {
              await cancelAllRestingOrders();
            }
            const stage1Ok = await sellTrancheIOC(halfQty, dexBid, "CUT LOSS STAGE 1 (50% DE-RISK)", dexBid, true);
            if (stage1Ok) {
              this.host.cutLossStage1Executed = true;
              this.host.cutLossStage1Price = refPrice;
              this.host.cutLossStage1CandleTime = latestClosedCandle?.time ?? 0;
              this.host.lastCutLossTime = Date.now();
              this.host.iocBracketSellCycle = undefined;

              // Place resting bounce exit limit sell order at Channel Floor for the remaining 50%
              const remainingHeld = this.host.baseHeld();
              const bounceSellPrice = roundToTick(Math.max(lowerBound, refPrice * 1.002), this.host.tickSize || 0.0001);
              const bounceNotional = remainingHeld * bounceSellPrice;
              const dustThreshold = this.host.minQty ? this.host.minQty * 0.5 : 1e-6;
              if (this.host.cfg.orderExecutionMode === "MAKER_LIMIT" && remainingHeld >= dustThreshold && bounceNotional >= minNotionalForSplit) {
                const bounceQty = roundToStep(remainingHeld, effStepSize, this.host.qtyPrecision);
                await placeRestingOrder(
                  false,
                  bounceSellPrice,
                  bounceQty,
                  0.0,
                  bounceNotional,
                  "Cut Loss Bounce Exit (50%)",
                );
              }

              this.host.saveState();
              return true;
            } else {
              // BUG A FIX: Abort execution if stage 1 IOC failed instead of falling through to 100% sellAll
              this.host.log(`⚠️ [CUT-LOSS] Stage 1 market cut failed on-chain! Aborting execution this tick to prevent full liquidation.`);
              return true;
            }
          }

          if (this.host.cutLossStage1Executed && !isFastBufferCut && !isBelowStage2Bound && !isStage2CandleClosed) {
            this.host.status(
              `🛡️ STAGE 1 DE-RISKED (50% HELD): Price $${refPrice.toFixed(6)} — holding bounce exit limit sell @ Floor $${lowerBound.toFixed(6)} unless Buffer ($${cutLossBound.toFixed(6)}) breaks`,
            );
          } else {
            const stageLabel = this.host.cutLossStage1Executed ? "STAGE 2/2 FULL EXIT | " : "";
            this.host.log(
              `🚨 CUT LOSS TRIGGERED (${stageLabel}${triggerReason}): DEX Bid $${dexBid.toFixed(6)} — ${exitActionDesc}`,
            );
            if (this.host.openOrders.length > 0) {
              await cancelAllRestingOrders();
            }
            await sellAll(dexBid, "CUT");
            this.host.lastCutLossTime = Date.now();
            this.host.waitingForHigherLow = true;
            this.host.isFlatChannelShiftWaiting = false;
            this.host.lastResolvedDumpLowPrice = undefined;
            this.host.breakdownFloorPrice = lowerBound;
            this.host.breakdownLowPrice = dexBid;
            this.host.breakdownTime = Math.floor(Date.now() / 1000);
            this.host.breakdownBuyLevel2Price = isChannelReady && buyLevels.length > 1 && buyLevels[1] > 0.0001
              ? buyLevels[1]
              : (lowerBound > 0 ? lowerBound + span * 0.32 : dexBid * 1.01);
            this.host.bufferBreakStartTime = undefined;
            this.host.cutLossStage1Executed = false;
            this.host.cutLossStage1Price = undefined;
            this.host.cutLossStage1CandleTime = undefined;
            this.host.postCutSingleTrancheOnly = true;
            this.host.iocBracketSellCycle = undefined;
            this.host.stuckSince = undefined;
            this.host.lastBuyFillTime = 0;
            this.host.lastBuyFillPrice = 0;
            this.host.lastBuyFillCandleTime = 0;
            this.host.breakdownCandleTimes.clear();
            this.host.saveState();
            return true;
          }
        }
      } else if (!this.host.isPaused && isInitialBreakdown) {
        // Price fell below floor while holding 0 lots: cancel any open resting buy orders to prevent buying a falling knife
        await cancelAllRestingOrders("BUY");
        this.host.saveState();
      }
    } else {
      // If price is back above floor, reset confirmation counters, buffer timer, and Stage 1 cut loss state
      this.host.bufferBreakStartTime = undefined;
      if (this.host.cutLossStage1Executed) {
        this.host.log(
          `🟢 CUT LOSS STAGE 1 RECOVERED: Price ($${refPrice.toFixed(6)}) reclaimed Channel Floor ($${lowerBound.toFixed(6)}) — keeping remaining 50% inventory to sell on bounce!`,
        );
        this.host.cutLossStage1Executed = false;
        this.host.cutLossStage1Price = undefined;
        this.host.cutLossStage1CandleTime = undefined;
        const bounceExitOrder = this.host.openOrders.find((o) => !o.isBid && o.levelDesc === "Cut Loss Bounce Exit (50%)");
        if (bounceExitOrder) {
          await cancelOrderInternal(bounceExitOrder, "Floor reclaimed — removing bounce exit sell");
          this.host.openOrders = this.host.openOrders.filter((o) => o !== bounceExitOrder);
        }
        this.host.needsSellRebalance = true;
        this.host.saveState();
      }
      if (!this.host.waitingForHigherLow && this.host.breakdownCandleTimes.size > 0) {
        this.host.breakdownCandleTimes.clear();
      }
    }
    return false;
  }

  /**
   * Evaluates Higher Low, Micro-HL, Trendline Breakout, or Buy Level 2 Reclaim recovery.
   * If recovery criteria met, resolves waitingForHigherLow state and re-enables accumulation.
   */
  public evaluateHigherLowRecovery(params: {
    dow?: DowStructure;
    refPrice: number;
    lowerBound: number;
    effectiveBuyLevel2Target: number;
    isBelowFloor: boolean;
    isChannelReady: boolean;
  }): void {
    const { dow, refPrice, lowerBound, effectiveBuyLevel2Target, isBelowFloor, isChannelReady } = params;

    if (!this.host.waitingForHigherLow) return;

    const candidateLow = dow?.downtrendDropLow !== undefined ? Math.min(refPrice, dow.downtrendDropLow) : refPrice;
    if (this.host.breakdownLowPrice === undefined || candidateLow < this.host.breakdownLowPrice) {
      this.host.breakdownLowPrice = candidateLow;
      if (refPrice <= candidateLow * 1.0005) {
        this.host.breakdownTime = Math.floor(Date.now() / 1000);
      }
      this.host.saveState();
    }

    const cutLossCooldownMs = 15 * 60 * 1000; // 15m (1 candle) mandatory cooldown after Cut Loss
    const elapsedSinceCutMs = this.host.lastCutLossTime ? (Date.now() - this.host.lastCutLossTime) : Infinity;
    const isInCutLossCooldown = elapsedSinceCutMs < cutLossCooldownMs;

    const closedCandlesList = this.host.dowEngine?.getClosedCandles() ?? [];
    const confirmedLastClosed = closedCandlesList.length > 0 ? closedCandlesList[closedCandlesList.length - 1] : undefined;
    const trackedLow = this.host.breakdownLowPrice ?? (dow?.downtrendDropLow ?? lowerBound);

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
      this.host.log(logMessage);
      this.host.lastResolvedDumpLowPrice = Math.min(trackedLow, dow?.downtrendDropLow ?? trackedLow);
      this.host.waitingForHigherLow = false;
      this.host.isFlatChannelShiftWaiting = false;
      this.host.isDowntrendDropPaused = false;
      this.host.isTrendSupportExitActive = false;
      this.host.trendSupportBreakPrice = undefined;
      this.host.lastTrendSupportBreakKey = undefined;
      this.host.breakdownTime = undefined;
      this.host.breakdownFloorPrice = undefined;
      this.host.breakdownLowPrice = undefined;
      this.host.breakdownBuyLevel2Price = undefined;
      this.host.saveState();
    };

    if (isInCutLossCooldown) {
      const remainMin = Math.ceil((cutLossCooldownMs - elapsedSinceCutMs) / 60000);
      this.host.status(
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
    } else if (!isBelowFloor && (this.host.breakdownFloorPrice || this.host.breakdownLowPrice || lowerBound > 0)) {
      // 3. Resolve via Confirmed Higher Low (3-Bar Swing HL or Fast 2-Bar Micro-HL)
      const checkTime = this.host.breakdownTime ?? (Math.floor(Date.now() / 1000) - 3600);
      const checkFloor = this.host.breakdownFloorPrice ?? lowerBound;
      const checkLow = trackedLow;

      const hlCheck =
        this.host.localTrendEngine?.checkForHigherLow(checkTime, checkFloor, checkLow, refPrice) ??
        this.host.dowEngine?.checkForHigherLow(checkTime, checkFloor, checkLow, refPrice);

      if (hlCheck && hlCheck.confirmed && hlCheck.higherLow) {
        resolveRecovery(
          `✅ HIGHER LOW (HL) CONFIRMED @ $${hlCheck.higherLow.price.toFixed(6)} (${hlCheck.reason}) — Breakdown resolved, enabling recovery entry!`,
        );
      } else if (
        isChannelReady &&
        this.host.breakdownFloorPrice !== undefined &&
        lowerBound >= this.host.breakdownFloorPrice * 0.998 &&
        refPrice >= this.host.breakdownFloorPrice * 1.002 &&
        (confirmedLastClosed && confirmedLastClosed.close >= this.host.breakdownFloorPrice)
      ) {
        resolveRecovery(
          `🚀 CHANNEL FLOOR RECLAIMED @ $${refPrice.toFixed(6)} >= Original Breakdown Floor $${this.host.breakdownFloorPrice.toFixed(6)} — Breakdown resolved, enabling recovery entry!`,
        );
      }
    }
  }
}
