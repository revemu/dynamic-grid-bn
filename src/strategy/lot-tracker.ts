/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import type { Lot, IStrategyHost } from "./types.js";

/**
 * Manages position lots, FIFO closing, lot-based profit matching,
 * average entry price calculation, and position clamping.
 */
export class LotTracker {
  constructor(private host: IStrategyHost) {}

  /**
   * Return total base asset quantity held across all active lots.
   */
  public baseHeld(): number {
    return this.host.lots.reduce((s, l) => s + l.qty, 0);
  }

  /**
   * Calculate weighted average entry price for all open lots.
   */
  public getAvgEntryPrice(): number {
    const totalQty = this.baseHeld();
    if (totalQty <= 0) return 0;
    const totalCost = this.host.lots.reduce((s, l) => s + l.price * l.qty, 0);
    return totalCost / totalQty;
  }

  /**
   * Check if any existing lot was purchased close to a specific grid price level.
   * Proximity tolerance is dynamically calculated to be well below half the distance to the nearest
   * adjacent grid level (max 35% of adjacent step, capped at 0.15%), preventing adjacent levels from falsely blocking each other.
   * If expectedTrancheQty is provided, allows re-buying if the lot has been mostly liquidated (remaining < 40% of tranche).
   */
  public hasLotNearLevel(levelPrice: number, levelIdx: number, levels: number[], expectedTrancheQty?: number): boolean {
    if (this.host.lots.length === 0 || !levelPrice || !levels || levels.length === 0) return false;
    const prevLvl = levelIdx > 0 ? levels[levelIdx - 1] : undefined;
    const nextLvl = levelIdx < levels.length - 1 ? levels[levelIdx + 1] : undefined;
    const distToAdjacent = Math.min(
      prevLvl ? Math.abs(prevLvl - levelPrice) : Infinity,
      nextLvl ? Math.abs(nextLvl - levelPrice) : Infinity,
    );
    const maxProximityRatio = isFinite(distToAdjacent) && distToAdjacent > 0
      ? Math.min(0.0015, (distToAdjacent / levelPrice) * 0.35)
      : 0.0015;

    const lotsNearPrice = this.host.lots.filter((l) => Math.abs(l.price - levelPrice) / levelPrice <= maxProximityRatio);
    if (lotsNearPrice.length === 0) return false;

    if (expectedTrancheQty && expectedTrancheQty > 0) {
      const totalQtyNear = lotsNearPrice.reduce((sum, l) => sum + l.qty, 0);
      return totalQtyNear >= expectedTrancheQty * 0.40;
    }

    return true;
  }

  /**
   * Close lots upon a sell execution using either LOT_BASED_PROFIT or standard FIFO.
   * Updates realized PnL and tradeRealizedPnl.
   */
  public closeLots(qty: number, exitPrice: number): { closedQty: number; roundPnl: number } {
    let remaining = qty;
    let roundPnl = 0;
    const mode = this.host.cfg.sellProfitMode || (this.host.cfg.requireProfitAboveAvgEntry ? "PORTFOLIO_AVG_PROFIT" : "GRID_CASHFLOW");

    if (mode === "LOT_BASED_PROFIT") {
      // In LOT_BASED_PROFIT: close lots that are in profit first (lowest entry price first)
      const profitableLots = this.host.lots
        .filter((l) => l.price <= exitPrice)
        .sort((a, b) => a.price - b.price);

      for (const lot of profitableLots) {
        if (remaining <= 1e-12) break;
        const take = Math.min(lot.qty, remaining);
        const pnl = (exitPrice - lot.price) * take;
        this.host.tradeRealizedPnl += pnl;
        roundPnl += pnl;
        this.host.realizedPnl = this.host.tradeRealizedPnl - this.host.totalGasDeductedQuote;
        lot.qty -= take;
        remaining -= take;
      }
      this.host.lots = this.host.lots.filter((l) => l.qty > 1e-12);
    }

    // Close remaining with standard FIFO
    while (remaining > 1e-12 && this.host.lots.length > 0) {
      const lot = this.host.lots[0]!;
      const take = Math.min(lot.qty, remaining);
      const pnl = (exitPrice - lot.price) * take;
      this.host.tradeRealizedPnl += pnl;
      roundPnl += pnl;
      this.host.realizedPnl = this.host.tradeRealizedPnl - this.host.totalGasDeductedQuote;
      lot.qty -= take;
      remaining -= take;
      if (lot.qty <= 1e-12) this.host.lots.shift();
    }

    // If remaining inventory is less than half minQty or 1e-6, treat position as completely flat/closed
    const dustThreshold = (this.host.minQty ? this.host.minQty * 0.5 : 1e-6);
    if (this.baseHeld() < dustThreshold) {
      this.host.clearPositionState();
    }

    return { closedQty: qty - remaining, roundPnl };
  }

  /**
   * Clamp open lots to maxAllowedQty (used during inventory reconciliation)
   */
  public clampLotsTo(maxAllowedQty: number): void {
    if (maxAllowedQty <= 1e-6) {
      this.host.clearPositionState();
      return;
    }
    let accumulated = 0;
    const clampedLots: Lot[] = [];
    for (const lot of this.host.lots) {
      if (accumulated + lot.qty <= maxAllowedQty) {
        clampedLots.push(lot);
        accumulated += lot.qty;
      } else {
        const remaining = maxAllowedQty - accumulated;
        if (remaining > 1e-6) {
          clampedLots.push({ ...lot, qty: remaining });
          accumulated += remaining;
        }
        break;
      }
    }
    this.host.lots = clampedLots;
  }
}
