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
  notionalUsdso: number;
  time: number;
  txHash?: string;
  pnl?: number;
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
  buyQty: number;              // Total SOMI bought
  buyCostUsdso: number;        // Total USDso spent
  avgBuyPrice: number;         // Average purchase price
  buyCount: number;            // Number of buy fills

  // Sell statistics
  sellQty: number;             // Total SOMI sold
  sellProceedsUsdso: number;   // Total USDso received
  avgSellPrice: number;        // Average selling price
  sellCount: number;           // Number of sell fills

  // Position remainder
  holdingQty: number;          // Remaining unsold SOMI in this round

  // Profit & Loss and Complete Gas Breakdown (including all created & cancelled orders)
  grossPnlUsdso: number;       // Gross realized PnL
  grossPnlPct: number;         // Gross PnL percentage
  createGasUsdso: number;      // Gas spent placing orders during this round
  cancelGasUsdso: number;      // Gas spent cancelling orders during this round
  fillGasUsdso: number;        // Direct execution gas (market/IOC)
  totalGasUsdso: number;       // Complete total gas spent (create + cancel + fill)
  totalGasSomi: number;        // Total gas spent in SOMI
  netPnlUsdso: number;         // Net realized PnL (Gross PnL - Total Gas)

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
  totalBoughtSomi: number;
  totalBoughtUsdso: number;
  avgBuyPriceOverall: number;
  totalSoldSomi: number;
  totalSoldUsdso: number;
  avgSellPriceOverall: number;
  totalGrossPnlUsdso: number;
  totalCreateGasUsdso: number;
  totalCancelGasUsdso: number;
  totalGasUsdso: number;
  totalNetPnlUsdso: number;
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
    const notional = Number(f.notionalUsdso || qty * price);
    const time = Number(f.fillTime || f.time || f.placedTime || 0);
    const gasUsdso = Number(f.gasFeeUsdso || 0);
    const gasSomi = Number(f.gasFeeSomi || 0);
    const pnl = Number(f.pnlUsdso !== undefined ? f.pnlUsdso : (f.pnl || 0));

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
        buyCostUsdso: 0,
        avgBuyPrice: 0,
        buyCount: 0,
        sellQty: 0,
        sellProceedsUsdso: 0,
        avgSellPrice: 0,
        sellCount: 0,
        holdingQty: 0,
        grossPnlUsdso: 0,
        grossPnlPct: 0,
        createGasUsdso: 0,
        cancelGasUsdso: 0,
        fillGasUsdso: 0,
        totalGasUsdso: 0,
        totalGasSomi: 0,
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
      notionalUsdso: notional,
      time,
      txHash: f.txHash || f.fillTxHash || f.createTxHash,
      pnl: effectivePnl,
      gasFeeUsdso: gasUsdso,
      gasFeeSomi: gasSomi,
      reason: f.reason || f.levelDesc,
      explorerUrl: f.explorerUrl || (f.txHash ? `https://explorer.somnia.network/tx/${f.txHash}` : undefined),
    };

    if (isBuy) {
      currentRound.buyTrades.push(tradeRecord);
      currentRound.buyQty += qty;
      currentRound.buyCostUsdso += notional;
      currentRound.buyCount++;
      currentRound.avgBuyPrice =
        currentRound.buyQty > 0
          ? currentRound.buyCostUsdso / currentRound.buyQty
          : 0;
    } else {
      inSellPhase = true;
      currentRound.sellTrades.push(tradeRecord);
      currentRound.sellQty += qty;
      currentRound.sellProceedsUsdso += notional;
      currentRound.sellCount++;
      currentRound.avgSellPrice =
        currentRound.sellQty > 0
          ? currentRound.sellProceedsUsdso / currentRound.sellQty
          : 0;
      currentRound.grossPnlUsdso += effectivePnl;

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
    const cGas = Number(o.createGasUsdso || 0);
    const cGasSomi = Number(o.createGasSomi || 0);
    const kGas = Number(o.cancelGasUsdso || 0);
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
        matchRound.createGasUsdso += cGas;
        matchRound.totalGasUsdso += cGas;
        matchRound.totalGasSomi += cGasSomi;
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
        matchRound.cancelGasUsdso += kGas;
        matchRound.totalGasUsdso += kGas;
        matchRound.totalGasSomi += kGasSomi;
      }
    }

    // 3. Standalone fill gas (where neither createGas nor cancelGas was set, e.g. market IOC or take profit)
    const directGas = Number(o.gasFeeUsdso || 0);
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
        matchRound.fillGasUsdso += directGas;
        matchRound.totalGasUsdso += directGas;
        matchRound.totalGasSomi += directGasSomi;
      }
    }
  }

  // Recalculate net PnL for each round after complete gas attribution
  for (const r of rounds) {
    r.netPnlUsdso = r.grossPnlUsdso - r.totalGasUsdso;
  }

  // Compute aggregate statistics
  let totalBoughtSomi = 0;
  let totalBoughtUsdso = 0;
  let totalSoldSomi = 0;
  let totalSoldUsdso = 0;
  let totalGrossPnlUsdso = 0;
  let totalCreateGasUsdso = 0;
  let totalCancelGasUsdso = 0;
  let totalGasUsdso = 0;
  let totalNetPnlUsdso = 0;
  let winRounds = 0;
  let lossRounds = 0;
  let closedRounds = 0;
  let openRounds = 0;

  for (const r of rounds) {
    totalBoughtSomi += r.buyQty;
    totalBoughtUsdso += r.buyCostUsdso;
    totalSoldSomi += r.sellQty;
    totalSoldUsdso += r.sellProceedsUsdso;
    totalGrossPnlUsdso += r.grossPnlUsdso;
    totalCreateGasUsdso += r.createGasUsdso;
    totalCancelGasUsdso += r.cancelGasUsdso;
    totalGasUsdso += r.totalGasUsdso;
    totalNetPnlUsdso += r.netPnlUsdso;

    if (r.status === "CLOSED" || r.status === "SELL_ONLY") {
      closedRounds++;
      if (r.netPnlUsdso > 0.0001) {
        winRounds++;
      } else if (r.netPnlUsdso < -0.0001) {
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
    totalBoughtSomi,
    totalBoughtUsdso,
    avgBuyPriceOverall: totalBoughtSomi > 0 ? totalBoughtUsdso / totalBoughtSomi : 0,
    totalSoldSomi,
    totalSoldUsdso,
    avgSellPriceOverall: totalSoldSomi > 0 ? totalSoldUsdso / totalSoldSomi : 0,
    totalGrossPnlUsdso,
    totalCreateGasUsdso,
    totalCancelGasUsdso,
    totalGasUsdso,
    totalNetPnlUsdso,
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
  if (Math.abs(r.grossPnlUsdso) < 0.000001 && r.sellCount > 0 && r.buyCostUsdso > 0) {
    r.grossPnlUsdso = r.sellProceedsUsdso - (r.sellQty * r.avgBuyPrice);
  }
  const costBasis = r.buyCostUsdso > 0 ? r.buyCostUsdso : (r.sellProceedsUsdso || 1);
  r.grossPnlPct = (r.grossPnlUsdso / costBasis) * 100;
  r.netPnlUsdso = r.grossPnlUsdso - r.totalGasUsdso;
}
