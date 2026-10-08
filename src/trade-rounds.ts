/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import type { UnifiedOrderRecord } from "./db.js";

export interface TradeRoundTrade {
  id: string;
  orderId: string;
  side: "BUY" | "SELL";
  action: string;
  price: number;
  qty: number;
  notionalQuote: number;
  notionalUsdso?: number; // Backward compat
  notional?: number;
  time: number;
  txHash?: string;
  pnl?: number;
  gasFeeQuote?: number;
  gasFeeUsdso?: number;
  gasFeeSomi?: number;
  reason?: string;
  explorerUrl?: string;
}

export interface TradeRound {
  roundNumber: number;
  status: "CLOSED" | "HOLDING" | "SELL_ONLY";
  startTime: number;
  endTime: number;
  durationMs: number;

  // Buy statistics
  buyQty: number;              // Total base bought
  buyCostQuote: number;        // Total quote spent
  buyCostUsdso?: number;       // Backward compat alias
  avgBuyPrice: number;         // Average purchase price
  buyCount: number;            // Number of buy fills

  // Sell statistics
  sellQty: number;             // Total base sold
  sellProceedsQuote: number;   // Total quote received
  sellProceedsUsdso?: number;  // Backward compat alias
  avgSellPrice: number;        // Average selling price
  sellCount: number;           // Number of sell fills

  // Position remainder
  holdingQty: number;          // Remaining unsold base in this round

  // Profit & Loss and Complete Fee/Gas Breakdown
  grossPnlQuote: number;       // Gross realized PnL
  grossPnlUsdso?: number;      // Backward compat alias
  grossPnlPct: number;         // Gross PnL percentage
  createGasQuote: number;      // Fee/gas spent placing orders during this round
  createGasUsdso?: number;
  cancelGasQuote: number;      // Fee/gas spent cancelling orders during this round
  cancelGasUsdso?: number;
  fillGasQuote: number;        // Direct execution fee/gas
  fillGasUsdso?: number;
  totalGasQuote: number;       // Complete total fee/gas spent
  totalGasUsdso?: number;
  totalGasSomi?: number;
  netPnlQuote: number;         // Net realized PnL (Gross PnL - Total Gas/Fee)
  netPnlUsdso?: number;

  // Granular fill records inside this round
  buyTrades: TradeRoundTrade[];
  sellTrades: TradeRoundTrade[];
}

export interface TradeRoundSummary {
  totalRounds: number;
  closedRounds: number;
  openRounds: number;
  winRounds: number;
  lossRounds: number;
  winRatePct: number;
  totalBoughtBase: number;
  totalBoughtSomi?: number;
  totalBoughtQuote: number;
  totalBoughtUsdso?: number;
  avgBuyPriceOverall: number;
  totalSoldBase: number;
  totalSoldSomi?: number;
  totalSoldQuote: number;
  totalSoldUsdso?: number;
  avgSellPriceOverall: number;
  totalGrossPnlQuote: number;
  totalGrossPnlUsdso?: number;
  totalCreateGasQuote: number;
  totalCreateGasUsdso?: number;
  totalCancelGasQuote: number;
  totalCancelGasUsdso?: number;
  totalGasQuote: number;
  totalGasUsdso?: number;
  totalNetPnlQuote: number;
  totalNetPnlUsdso?: number;
}

export interface TradeRoundsResult {
  summary: TradeRoundSummary;
  rounds: TradeRound[];
}

/**
 * Reconstructs discrete trading cycles / rounds from unified trade fills.
 * A trading round begins with accumulation (BUY fills) and concludes when
 * the position is distributed/sold (SELL fills). When a new BUY occurs after
 * a selling phase, a new round is initiated.
 */
export function calculateTradeRounds(orders: UnifiedOrderRecord[]): TradeRoundsResult {
  // 1. Filter only genuine executed fills (exclude pure cancellations)
  const fills = orders.filter(
    (o) =>
      (o.status === "FILLED" ||
        ["BUY_FILL", "SELL_FILL", "CUT", "TAKE_PROFIT", "SNIPE_BUY", "SNIPE_SELL"].includes(o.action)) &&
      !o.action?.startsWith("CANCEL") &&
      o.status !== "CANCELLED",
  );

  // 2. Sort chronologically
  fills.sort(
    (a, b) =>
      (a.fillTime || a.time || a.placedTime || 0) -
      (b.fillTime || b.time || b.placedTime || 0),
  );

  const rounds: TradeRound[] = [];
  let currentRound: TradeRound | null = null;
  let inSellPhase = false;

  for (const f of fills) {
    const isBuy =
      f.side === "BUY" || f.action === "BUY_FILL" || f.action === "SNIPE_BUY";
    const qty = Number(f.qty || 0);
    const price = Number(f.fillPrice || f.price || 0);
    const notional = Number(f.notionalQuote || f.notionalUsdso || f.notional || qty * price);
    const time = Number(f.fillTime || f.time || f.placedTime || 0);
    const gasQuote = Number(f.gasFeeQuote || f.gasFeeUsdso || 0);
    const gasSomi = Number(f.gasFeeSomi || 0);
    const pnl = Number(f.pnlQuote !== undefined ? f.pnlQuote : f.pnlUsdso !== undefined ? f.pnlUsdso : (f.pnl || 0));

    // Only split into a new round if previous round has completely closed its inventory or was sell-only
    if (currentRound && isBuy) {
      const remainingHeld = currentRound.buyQty - currentRound.sellQty;
      const isInventoryFlat = currentRound.buyQty > 0 && (
        remainingHeld <= 0.5 ||
        currentRound.sellQty >= currentRound.buyQty * 0.98
      );
      const isSellOnly = currentRound.buyQty === 0 && currentRound.sellCount > 0;

      if (isInventoryFlat || isSellOnly) {
        finalizeRound(currentRound, false);
        rounds.push(currentRound);
        currentRound = null;
        inSellPhase = false;
      }
    }

    if (!currentRound) {
      currentRound = {
        roundNumber: rounds.length + 1,
        status: "CLOSED",
        startTime: time,
        endTime: time,
        durationMs: 0,
        buyQty: 0,
        buyCostQuote: 0,
        buyCostUsdso: 0,
        avgBuyPrice: 0,
        buyCount: 0,
        sellQty: 0,
        sellProceedsQuote: 0,
        sellProceedsUsdso: 0,
        avgSellPrice: 0,
        sellCount: 0,
        holdingQty: 0,
        grossPnlQuote: 0,
        grossPnlUsdso: 0,
        grossPnlPct: 0,
        createGasQuote: 0,
        createGasUsdso: 0,
        cancelGasQuote: 0,
        cancelGasUsdso: 0,
        fillGasQuote: 0,
        fillGasUsdso: 0,
        totalGasQuote: 0,
        totalGasUsdso: 0,
        totalGasSomi: 0,
        netPnlQuote: 0,
        netPnlUsdso: 0,
        buyTrades: [],
        sellTrades: [],
      };
    }

    currentRound.endTime = time;

    // Auto-calculate sell PnL against current round's avg buy price if missing
    let effectivePnl = pnl;
    if (!isBuy && (!effectivePnl || effectivePnl === 0) && currentRound.avgBuyPrice > 0) {
      effectivePnl = (price - currentRound.avgBuyPrice) * qty;
    }

    const tradeRecord: TradeRoundTrade = {
      id: f.id,
      orderId: f.orderId,
      side: isBuy ? "BUY" : "SELL",
      action: f.action,
      price,
      qty,
      notionalQuote: notional,
      notionalUsdso: notional,
      notional,
      time,
      txHash: f.txHash || f.fillTxHash || f.createTxHash,
      pnl: effectivePnl,
      gasFeeQuote: gasQuote,
      gasFeeUsdso: gasQuote,
      gasFeeSomi: gasSomi,
      reason: f.reason || f.levelDesc,
      explorerUrl: f.explorerUrl,
    };

    if (isBuy) {
      currentRound.buyTrades.push(tradeRecord);
      currentRound.buyQty += qty;
      currentRound.buyCostQuote += notional;
      currentRound.buyCostUsdso = currentRound.buyCostQuote;
      currentRound.buyCount++;
      currentRound.avgBuyPrice =
        currentRound.buyQty > 0
          ? currentRound.buyCostQuote / currentRound.buyQty
          : 0;
    } else {
      inSellPhase = true;
      currentRound.sellTrades.push(tradeRecord);
      currentRound.sellQty += qty;
      currentRound.sellProceedsQuote += notional;
      currentRound.sellProceedsUsdso = currentRound.sellProceedsQuote;
      currentRound.sellCount++;
      currentRound.avgSellPrice =
        currentRound.sellQty > 0
          ? currentRound.sellProceedsQuote / currentRound.sellQty
          : 0;
      currentRound.grossPnlQuote += effectivePnl;
      currentRound.grossPnlUsdso = currentRound.grossPnlQuote;

      // Check if this SELL completely closed out the inventory
      const remainingHeld = currentRound.buyQty - currentRound.sellQty;
      const isFullExit = ["CUT", "EXIT"].includes(f.action) ||
        f.reason?.includes("100% FULL EXIT") ||
        f.reason?.includes("CUT LOSS") ||
        f.levelDesc?.includes("CUT LOSS") ||
        f.levelDesc?.includes("100% FULL EXIT");

      const isInventoryFlat = currentRound.buyQty > 0 && (
        remainingHeld <= 0.5 ||
        currentRound.sellQty >= currentRound.buyQty * 0.98
      );

      if (isInventoryFlat || isFullExit) {
        finalizeRound(currentRound, false);
        rounds.push(currentRound);
        currentRound = null;
        inSellPhase = false;
      }
    }
  }

  // Finalize the active/last round
  if (currentRound) {
    finalizeRound(currentRound, true);
    rounds.push(currentRound);
  }

  // Attribute ALL order gas (including orders created, orders cancelled during rebalancing, and direct fills)
  for (const o of orders) {
    const cGas = Number(o.createGasQuote || o.createGasUsdso || 0);
    const cGasSomi = Number(o.createGasSomi || 0);
    const kGas = Number(o.cancelGasQuote || o.cancelGasUsdso || 0);
    const kGasSomi = Number(o.cancelGasSomi || 0);
    const pTime = Number(o.placedTime || o.time || 0);
    const kTime = Number(o.cancelTime || o.time || 0);

    // 1. Assign Create Gas based on placedTime
    if (cGas > 0 || cGasSomi > 0) {
      let matchRound = rounds.find((r, idx) => {
        const nextRound = rounds[idx + 1];
        const endLimit = nextRound ? nextRound.startTime : Infinity;
        return pTime >= r.startTime && pTime < endLimit;
      });
      if (!matchRound && rounds.length > 0) {
        matchRound = pTime < (rounds[0]?.startTime ?? 0) ? rounds[0] : rounds[rounds.length - 1];
      }
      if (matchRound) {
        matchRound.createGasQuote = (matchRound.createGasQuote || 0) + cGas;
        matchRound.createGasUsdso = matchRound.createGasQuote;
        matchRound.totalGasQuote = (matchRound.totalGasQuote || 0) + cGas;
        matchRound.totalGasUsdso = matchRound.totalGasQuote;
        matchRound.totalGasSomi = (matchRound.totalGasSomi || 0) + cGasSomi;
      }
    }

    // 2. Assign Cancel Gas based on cancelTime
    if (kGas > 0 || kGasSomi > 0) {
      let matchRound = rounds.find((r, idx) => {
        const nextRound = rounds[idx + 1];
        const endLimit = nextRound ? nextRound.startTime : Infinity;
        return kTime >= r.startTime && kTime < endLimit;
      });
      if (!matchRound && rounds.length > 0) {
        matchRound = kTime < (rounds[0]?.startTime ?? 0) ? rounds[0] : rounds[rounds.length - 1];
      }
      if (matchRound) {
        matchRound.cancelGasQuote = (matchRound.cancelGasQuote || 0) + kGas;
        matchRound.cancelGasUsdso = matchRound.cancelGasQuote;
        matchRound.totalGasQuote = (matchRound.totalGasQuote || 0) + kGas;
        matchRound.totalGasUsdso = matchRound.totalGasQuote;
        matchRound.totalGasSomi = (matchRound.totalGasSomi || 0) + kGasSomi;
      }
    }

    // 3. Standalone fill gas (where neither createGas nor cancelGas was set, e.g. market IOC or take profit)
    const directGas = Number(o.gasFeeQuote || o.gasFeeUsdso || 0);
    const directGasSomi = Number(o.gasFeeSomi || 0);
    if (directGas > 0 && !o.createGasUsdso && !o.cancelGasUsdso) {
      const fTime = Number(o.fillTime || o.time || o.placedTime || 0);
      let matchRound = rounds.find((r, idx) => {
        const nextRound = rounds[idx + 1];
        const endLimit = nextRound ? nextRound.startTime : Infinity;
        return fTime >= r.startTime && fTime < endLimit;
      });
      if (!matchRound && rounds.length > 0) {
        matchRound = fTime < (rounds[0]?.startTime ?? 0) ? rounds[0] : rounds[rounds.length - 1];
      }
      if (matchRound) {
        matchRound.fillGasQuote = (matchRound.fillGasQuote || 0) + directGas;
        matchRound.fillGasUsdso = matchRound.fillGasQuote;
        matchRound.totalGasQuote = (matchRound.totalGasQuote || 0) + directGas;
        matchRound.totalGasUsdso = matchRound.totalGasQuote;
        matchRound.totalGasSomi = (matchRound.totalGasSomi || 0) + directGasSomi;
      }
    }
  }

  // Recalculate net PnL for each round after complete gas attribution
  for (const r of rounds) {
    r.netPnlQuote = r.grossPnlQuote - (r.totalGasQuote || 0);
    r.netPnlUsdso = r.netPnlQuote;
  }

  // Compute aggregate statistics
  let totalBoughtBase = 0;
  let totalBoughtQuote = 0;
  let totalSoldBase = 0;
  let totalSoldQuote = 0;
  let totalGrossPnlQuote = 0;
  let totalCreateGasQuote = 0;
  let totalCancelGasQuote = 0;
  let totalGasQuote = 0;
  let totalNetPnlQuote = 0;
  let winRounds = 0;
  let lossRounds = 0;
  let closedRounds = 0;
  let openRounds = 0;

  for (const r of rounds) {
    totalBoughtBase += r.buyQty;
    totalBoughtQuote += r.buyCostQuote;
    totalSoldBase += r.sellQty;
    totalSoldQuote += r.sellProceedsQuote;
    totalGrossPnlQuote += r.grossPnlQuote;
    totalCreateGasQuote += r.createGasQuote || 0;
    totalCancelGasQuote += r.cancelGasQuote || 0;
    totalGasQuote += r.totalGasQuote || 0;
    totalNetPnlQuote += r.netPnlQuote;

    if (r.status === "CLOSED" || r.status === "SELL_ONLY") {
      closedRounds++;
      if (r.netPnlQuote > 0.0001) {
        winRounds++;
      } else if (r.netPnlQuote < -0.0001) {
        lossRounds++;
      }
    } else {
      openRounds++;
    }
  }

  const winRatePct =
    closedRounds > 0 ? (winRounds / (winRounds + lossRounds || 1)) * 100 : 0;

  const summary: TradeRoundSummary = {
    totalRounds: rounds.length,
    closedRounds,
    openRounds,
    winRounds,
    lossRounds,
    winRatePct,
    totalBoughtBase,
    totalBoughtSomi: totalBoughtBase,
    totalBoughtQuote,
    totalBoughtUsdso: totalBoughtQuote,
    avgBuyPriceOverall: totalBoughtBase > 0 ? totalBoughtQuote / totalBoughtBase : 0,
    totalSoldBase,
    totalSoldSomi: totalSoldBase,
    totalSoldQuote,
    totalSoldUsdso: totalSoldQuote,
    avgSellPriceOverall: totalSoldBase > 0 ? totalSoldQuote / totalSoldBase : 0,
    totalGrossPnlQuote,
    totalGrossPnlUsdso: totalGrossPnlQuote,
    totalCreateGasQuote,
    totalCreateGasUsdso: totalCreateGasQuote,
    totalCancelGasQuote,
    totalCancelGasUsdso: totalCancelGasQuote,
    totalGasQuote,
    totalGasUsdso: totalGasQuote,
    totalNetPnlQuote,
    totalNetPnlUsdso: totalNetPnlQuote,
  };

  return { summary, rounds };
}

function finalizeRound(r: TradeRound, isLatestRound: boolean): void {
  r.durationMs = Math.max(0, r.endTime - r.startTime);
  r.holdingQty = Math.max(0, r.buyQty - r.sellQty);

  if (r.sellCount > 0 && r.buyCount === 0) {
    r.status = "SELL_ONLY";
  } else if (r.holdingQty <= 0.5 || (r.buyQty > 0 && r.sellQty >= r.buyQty * 0.98)) {
    r.status = "CLOSED";
  } else if (r.buyCount > 0 && r.sellCount === 0) {
    r.status = "HOLDING";
  } else {
    r.status = isLatestRound ? "HOLDING" : "CLOSED";
  }

  // Calculate gross PnL
  if (Math.abs(r.grossPnlQuote) < 0.000001 && r.sellCount > 0 && r.buyCostQuote > 0) {
    r.grossPnlQuote = r.sellProceedsQuote - (r.sellQty * r.avgBuyPrice);
    r.grossPnlUsdso = r.grossPnlQuote;
  }
  const costBasis = r.buyCostQuote > 0 ? r.buyCostQuote : (r.sellProceedsQuote || 1);
  r.grossPnlPct = (r.grossPnlQuote / costBasis) * 100;
  r.netPnlQuote = r.grossPnlQuote - (r.totalGasQuote || 0);
  r.netPnlUsdso = r.netPnlQuote;
}
