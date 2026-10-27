/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import { DowStructureEngine } from "./market-structure/index.js";
import { DowEngine } from "./market-structure/dow-engine.js";
import { RegimeChannelGate } from "./market-structure/regime-gate.js";
import { VolumeProfileEngine } from "./market-structure/volume-profile.js";
import { SwingSignalDetector } from "./strategy/swing/signals.js";
import type { SwingStrategyConfig } from "./strategy/swing/config.js";
import { defaultStrategyConfig, type Config } from "./config.js";

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Lot {
  price: number;
  qty: number;
  time: number;
  buyIdx?: number;
}

export interface TradeRecord {
  type: "BUY" | "SELL" | "TAKE_PROFIT" | "CUT_LOSS";
  price: number;
  qty: number;
  pnl?: number;
  reason?: string;
  time: number;
}

export interface BacktestConfig extends Partial<Config> {
  name: string;
  budget: number;
  cutLossMode?: "CONFIRMED_CLOSE" | "WICK_INSTANT" | "OFF";
  floorBufferPct?: number;
  buyWeights?: number[];
}

export interface BacktestResult {
  symbol: string;
  configName: string;
  initialBudget: number;
  finalEquity: number;
  netPnl: number;
  netPnlPct: number;
  totalTrades: number;
  winTrades: number;
  lossTrades: number;
  winRate: number;
  completedCycles: number;
  maxDrawdownPct: number;
  profitFactor: number;
  holdingLotsCount: number;
  unrealizedPnl: number;
  gridCashflowProfit: number;
  tpProfit: number;
  cutLossLoss: number;
  ceilingExitsCount: number;
  lhEscapesCount: number;
  floorCutLossCount: number;
  trendSupportBreakCount: number;
  trades?: TradeRecord[];
}

export async function fetchKlines(symbol: string, interval = "15m", limit = 500): Promise<Candle[]> {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${symbol}: ${res.statusText}`);
  const raw = (await res.json()) as any[];
  return raw.map((r: any) => ({
    time: Math.floor(r[0] / 1000),
    open: parseFloat(r[1]),
    high: parseFloat(r[2]),
    low: parseFloat(r[3]),
    close: parseFloat(r[4]),
    volume: parseFloat(r[5]),
  }));
}

/**
 * Full Production-Aligned Strategy Simulator
 * Accurately models Dow Theory Market Structure, RegimeChannelGate (ChoCh Gate),
 * Trendline Support & Resistance, Zone Midline Caps, Dynamic Escapes, and Floor Cut Loss.
 */
export function runSimulation(symbol: string, candles: Candle[], customCfg: BacktestConfig): BacktestResult {
  const cfg: Config & BacktestConfig = {
    ...defaultStrategyConfig,
    ...customCfg,
    name: customCfg.name,
    budget: customCfg.budget,
    cutLossMode: customCfg.cutLossMode ?? "CONFIRMED_CLOSE",
    floorBufferPct: customCfg.floorBufferPct ?? defaultStrategyConfig.floorBufferPct,
  };

  const engine = new DowStructureEngine(
    cfg.dowSwingLookback ?? 3,
    cfg.useTrueWick ?? true,
    cfg.wickThresholdPct ?? 20.0,
    cfg.maxCandleCount ?? 600,
  );
  const warmupCount = 120;

  for (let i = 0; i < warmupCount && i < candles.length; i++) {
    engine.addCandle(candles[i]!);
  }

  let cash = cfg.budget;
  let lots: Lot[] = [];
  const trades: TradeRecord[] = [];
  let peakEquity = cfg.budget;
  let maxDrawdown = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let winTrades = 0;
  let lossTrades = 0;

  let ceilingExitsCount = 0;
  let lhEscapesCount = 0;
  let floorCutLossCount = 0;
  let trendSupportBreakCount = 0;
  let completedCycles = 0;

  // State guards mirroring src/strategy/index.ts
  let waitingForHigherLow = false;
  let trendSupportBroken = false;
  let breakdownLow = 0;
  let lastTrendSupportBreakKey: string | undefined;

  const soldSellIndices = new Set<number>();
  const filledBuyIndices = new Set<number>();

  let lockedChannel: {
    lowerBound: number;
    upperBound: number;
    center: number;
    buyLevels: number[];
    sellLevels: number[];
  } | null = null;

  for (let i = warmupCount; i < candles.length; i++) {
    const c = candles[i]!;

    let volumeProfile;
    if (cfg.channelMode === "VOLUME_PROFILE_HTF") {
      volumeProfile = VolumeProfileEngine.calculate(engine.getCandles(), cfg.vpLookbackBars ?? 192);
    }

    const structure = engine.getStructure(c.open, c.open, {
      mode: cfg.channelMode || "DOW_SWINGS",
      minChannelWidthPct: cfg.minChannelWidthPct,
      maxChannelWidthPct: cfg.maxChannelWidthPct,
      floorBufferPct: cfg.floorBufferPct,
      volumeProfile,
      useOnlyClosedCandles: cfg.adjustChannelOnClosedOnly ?? true,
    });

    const isSwingConfirmed = structure.isSwingConfirmed;

    // 1. Position-Locked Channel Logic
    let lowerBound = structure.bottomBound;
    let upperBound = structure.upperBound;
    let center = structure.centerPrice;
    let buyLevels = structure.gridZone?.buyLevels ?? [];
    let sellLevels = structure.gridZone?.sellLevels ?? [];

    const currentBaseHeld = lots.reduce((sum, l) => sum + l.qty, 0);
    const avgEntry = currentBaseHeld > 0 ? lots.reduce((sum, l) => sum + l.price * l.qty, 0) / currentBaseHeld : 0;
    const currentEquity = cash + currentBaseHeld * c.close;

    if (currentEquity > peakEquity) peakEquity = currentEquity;
    const dd = peakEquity > 0 ? ((peakEquity - currentEquity) / peakEquity) * 100 : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;

    if (cfg.lockChannelInPosition && currentBaseHeld > 0 && lockedChannel) {
      lowerBound = lockedChannel.lowerBound;
      upperBound = lockedChannel.upperBound;
      center = lockedChannel.center;
      buyLevels = lockedChannel.buyLevels;
      sellLevels = lockedChannel.sellLevels;
    } else if (currentBaseHeld > 0 && !lockedChannel && lowerBound > 0 && upperBound > 0) {
      lockedChannel = { lowerBound, upperBound, center, buyLevels, sellLevels };
    } else if (currentBaseHeld <= 0) {
      lockedChannel = null;
      soldSellIndices.clear();
      filledBuyIndices.clear();
    }

    // 2. Dow Market Regime & Trend Filtering
    const regime = structure.regime ?? DowEngine.determineMarketRegime(structure.swingHighs, structure.swingLows, isSwingConfirmed);
    const isDowntrend = regime === "DOWNTREND";
    const trendFiltered = Boolean(cfg.dowTrendFilter && isDowntrend);

    // 3. Regime Channel Gate (Dow ChoCh Gate & Base Confirmation)
    const lastLh = structure.lastLh;
    const isUnderLastLh = Boolean(lastLh && lastLh.price > 0 && c.open < lastLh.price * 0.999);
    const isDowntrendStructure = regime === "DOWNTREND" || (
      structure.waveCycle?.annotatedSwings?.filter((s) => s.type === "LOW").slice(-1)[0]?.dowLabel === "LL" &&
      structure.waveCycle?.annotatedSwings?.filter((s) => s.type === "HIGH").slice(-1)[0]?.dowLabel === "LH"
    );
    const isChoChBullish = !lastLh || lastLh.price <= 0 || c.open >= lastLh.price * 0.999;
    const isBreakingLow = Boolean(structure.isDowntrendDropActive || (lowerBound > 0 && c.open < lowerBound));

    const canEstablishChannel = cfg.enableTrendChannelGating === false || (
      !(isUnderLastLh && isDowntrendStructure) &&
      !(isDowntrendStructure && !isChoChBullish) &&
      !isBreakingLow
    );

    // 4. Trendline Evaluations
    const downtrendLine = structure.downtrendLine;
    const isTrendlineFiltered = Boolean(cfg.trendlineFilter && downtrendLine && !downtrendLine.isBroken);

    const uptrendLine = structure.uptrendLine;
    const uptrendKey = uptrendLine ? `${uptrendLine.p1.time}_${uptrendLine.p2.time}` : undefined;
    const isNewUptrendBreak = uptrendKey ? (lastTrendSupportBreakKey !== uptrendKey) : true;
    const trendSupportBufferPct = Math.max(0.20, cfg.floorBufferPct ?? 0.35);

    const isUptrendBroken = Boolean(
      uptrendLine && isNewUptrendBreak && (
        structure.uptrendBreakdownConfirmed ||
        (uptrendLine.brokenCandleCount ?? 0) >= 1 ||
        c.low < uptrendLine.currentLinePrice * (1 - trendSupportBufferPct / 100)
      )
    );

    if (cfg.enableExitOnTrendSupportBreak && isUptrendBroken) {
      if (uptrendKey) lastTrendSupportBreakKey = uptrendKey;
      if (currentBaseHeld > 0 && cfg.liquidateOnTrendSupportBreak) {
        // Liquidate
        const exitPrice = Math.min(c.open, uptrendLine!.currentLinePrice);
        const pnl = (exitPrice - avgEntry) * currentBaseHeld;
        cash += currentBaseHeld * exitPrice;
        if (pnl >= 0) { grossProfit += pnl; winTrades++; }
        else { grossLoss += Math.abs(pnl); lossTrades++; }
        trades.push({ type: "CUT_LOSS", price: exitPrice, qty: currentBaseHeld, pnl, time: c.time, reason: "Trend Support Liquidate" });
        lots = [];
        lockedChannel = null;
        soldSellIndices.clear();
        filledBuyIndices.clear();
        trendSupportBreakCount++;
      }
      trendSupportBroken = true;
      waitingForHigherLow = false;
      breakdownLow = c.low;
    }

    // 5. Recovery & Reclaim Checks
    if (waitingForHigherLow || trendSupportBroken) {
      // Reclaim above Buy Level 2
      if (cfg.enableBuyLevel2Recovery && buyLevels.length > 1 && c.close > buyLevels[1]!) {
        waitingForHigherLow = false;
        trendSupportBroken = false;
      }
      // Reversal above Last LH (ChoCh)
      if (structure.lastLh && c.close >= structure.lastLh.price * 0.999) {
        waitingForHigherLow = false;
        trendSupportBroken = false;
      }
      // Confirmed Higher Low
      if (structure.waveCycle?.lastHl && structure.waveCycle.lastHl.price > breakdownLow) {
        waitingForHigherLow = false;
        trendSupportBroken = false;
      }
    }

    // 6. Triangle Squeeze Detection
    let isSqueezePaused = false;
    if (cfg.enableTriangleSqueezeExit && uptrendLine && downtrendLine && !uptrendLine.isBroken && !downtrendLine.isBroken) {
      const tlSpreadPct = Math.abs((downtrendLine.currentLinePrice - uptrendLine.currentLinePrice) / uptrendLine.currentLinePrice) * 100;
      if (tlSpreadPct <= (cfg.triangleSqueezeSpreadPct ?? 1.5)) {
        isSqueezePaused = true;
      }
    }

    // ── 7. EXECUTION: SELLS & EXITS ──────────────────────────────────────────
    const cutLossBound = lowerBound * (1 - (cfg.floorBufferPct ?? 0.35) / 100);
    let isCutLossTriggered = false;
    let cutLossPrice = cutLossBound;

    if (cfg.cutLossMode === "CONFIRMED_CLOSE") {
      if (currentBaseHeld > 0 && c.close < cutLossBound) {
        isCutLossTriggered = true;
        cutLossPrice = c.close;
      }
    } else if (cfg.cutLossMode === "WICK_INSTANT") {
      if (currentBaseHeld > 0 && c.low < cutLossBound) {
        isCutLossTriggered = true;
        cutLossPrice = cutLossBound;
      }
    }

    // A0. Fast Cut: Dow Downtrend Emergency Exit
    if (cfg.enableExitOnDowntrendRegime && currentBaseHeld > 0 && isDowntrend) {
      const exitPrice = c.open;
      const pnl = (exitPrice - avgEntry) * currentBaseHeld;
      cash += currentBaseHeld * exitPrice;
      if (pnl >= 0) { grossProfit += pnl; winTrades++; }
      else { grossLoss += Math.abs(pnl); lossTrades++; }
      trades.push({ type: "CUT_LOSS", price: exitPrice, qty: currentBaseHeld, pnl, time: c.time, reason: "Fast Cut: Dow Downtrend" });
      lots = [];
      lockedChannel = null;
      soldSellIndices.clear();
      filledBuyIndices.clear();
      waitingForHigherLow = true;
      breakdownLow = c.low;
      floorCutLossCount++;
    }
    // A. Floor Cut Loss
    else if (isCutLossTriggered && currentBaseHeld > 0) {
      const pnl = (cutLossPrice - avgEntry) * currentBaseHeld;
      cash += currentBaseHeld * cutLossPrice;
      if (pnl >= 0) { grossProfit += pnl; winTrades++; }
      else { grossLoss += Math.abs(pnl); lossTrades++; }
      trades.push({ type: "CUT_LOSS", price: cutLossPrice, qty: currentBaseHeld, pnl, time: c.time, reason: "Floor Cut Loss" });
      lots = [];
      lockedChannel = null;
      soldSellIndices.clear();
      filledBuyIndices.clear();
      waitingForHigherLow = false;
      breakdownLow = c.low;
      floorCutLossCount++;
    }
    // B. Upper Bound Take Profit
    else if (
      currentBaseHeld > 0 &&
      (cfg.takeProfitAtUpperBound !== false) &&
      c.high >= upperBound &&
      (cfg.sellProfitMode !== "PORTFOLIO_AVG_PROFIT" || c.high >= avgEntry * (1 + cfg.minNetProfitPct / 100))
    ) {
      const exitPrice = upperBound;
      const pnl = (exitPrice - avgEntry) * currentBaseHeld;
      cash += currentBaseHeld * exitPrice;
      if (pnl >= 0) { grossProfit += pnl; winTrades++; completedCycles++; }
      else { grossLoss += Math.abs(pnl); lossTrades++; }
      trades.push({ type: "TAKE_PROFIT", price: exitPrice, qty: currentBaseHeld, pnl, time: c.time, reason: "Ceiling 100% Exit" });
      lots = [];
      lockedChannel = null;
      soldSellIndices.clear();
      filledBuyIndices.clear();
      ceilingExitsCount++;
    }
    // C. LH Dynamic Escape
    else if (
      currentBaseHeld > 0 &&
      cfg.enableLhDynamicEscape !== false &&
      structure.lastLh &&
      structure.lastLh.price < upperBound &&
      structure.lastLh.price >= avgEntry * (1 + cfg.minNetProfitPct / 100) &&
      c.high >= structure.lastLh.price
    ) {
      const exitPrice = structure.lastLh.price;
      const pnl = (exitPrice - avgEntry) * currentBaseHeld;
      cash += currentBaseHeld * exitPrice;
      if (pnl >= 0) { grossProfit += pnl; winTrades++; completedCycles++; }
      else { grossLoss += Math.abs(pnl); lossTrades++; }
      trades.push({ type: "SELL", price: exitPrice, qty: currentBaseHeld, pnl, time: c.time, reason: "LH Dynamic Escape" });
      lots = [];
      lockedChannel = null;
      soldSellIndices.clear();
      filledBuyIndices.clear();
      lhEscapesCount++;
    }
    // D. Grid Sell Targets
    else if (currentBaseHeld > 0 && sellLevels.length > 0) {
      const activeTargets = cfg.enabledSellTargets
        ? sellLevels.map((lvl, idx) => ({ lvl, idx })).filter((item) => cfg.enabledSellTargets![item.idx] !== false)
        : sellLevels.map((lvl, idx) => ({ lvl, idx }));

      const eligibleTargets = activeTargets.filter((item) => !soldSellIndices.has(item.idx));

      if (eligibleTargets.length > 0) {
        for (const item of eligibleTargets) {
          let sPrice = item.lvl;

          // Cap target if enableSellBelowTrendResistance is active
          if (cfg.enableSellBelowTrendResistance && downtrendLine && !downtrendLine.isBroken && downtrendLine.currentLinePrice < sPrice) {
            sPrice = downtrendLine.currentLinePrice;
          }

          if (c.high >= sPrice && lots.length > 0) {
            const isProfitOk = cfg.sellProfitMode !== "PORTFOLIO_AVG_PROFIT" || sPrice >= avgEntry * (1 + cfg.minNetProfitPct / 100);
            if (isProfitOk) {
              // If this is the last eligible target OR holding only 1 lot, sell entire remaining inventory!
              const sellQty = (eligibleTargets.length === 1 || lots.length === 1)
                ? currentBaseHeld
                : currentBaseHeld / eligibleTargets.length;

              if (sellQty > 0) {
                let rem = sellQty;
                let tradePnl = 0;
                while (rem > 0 && lots.length > 0) {
                  const l = lots[0]!;
                  const take = Math.min(l.qty, rem);
                  tradePnl += (sPrice - l.price) * take;
                  l.qty -= take;
                  rem -= take;
                  if (l.qty <= 1e-8) {
                    if (l.buyIdx !== undefined) filledBuyIndices.delete(l.buyIdx);
                    lots.shift();
                  }
                }
                cash += sellQty * sPrice;
                if (tradePnl >= 0) { grossProfit += tradePnl; winTrades++; }
                else { grossLoss += Math.abs(tradePnl); lossTrades++; }
                trades.push({ type: "SELL", price: sPrice, qty: sellQty, pnl: tradePnl, time: c.time, reason: `Sell Target ${item.idx + 1}` });

                soldSellIndices.add(item.idx);

                if (lots.length === 0) {
                  completedCycles++;
                  lockedChannel = null;
                  soldSellIndices.clear();
                  filledBuyIndices.clear();
                }
                break;
              }
            }
          }
        }
      }
    }

    // ── 8. EXECUTION: BUYS ───────────────────────────────────────────────────
    const midRef = center > 0 ? center : (lowerBound + upperBound) / 2;
    const inBuyZone = (cfg.enableBuyBelowSellLevel1 !== false) ? (c.low <= midRef) : true;

    const canBuy = (
      canEstablishChannel &&
      !trendFiltered &&
      !isTrendlineFiltered &&
      !trendSupportBroken &&
      !isSqueezePaused &&
      !waitingForHigherLow &&
      inBuyZone &&
      isSwingConfirmed &&
      lowerBound > 0 &&
      upperBound > 0
    );

    if (canBuy && buyLevels.length > 0 && c.low >= lowerBound) {
      const weights = cfg.buySizingMode === "EQUAL"
        ? buyLevels.map(() => 20)
        : (customCfg.buyWeights || cfg.buyLevelWeights || [35, 35, 30, 10, 10]);
      const totalWeight = weights.reduce((s, w) => s + w, 0);

      const currentHeldQuote = lots.reduce((sum, l) => sum + l.price * l.qty, 0);
      const currentHoldFrac = cfg.budget > 0 ? currentHeldQuote / cfg.budget : 0;

      if (currentHoldFrac < 0.95) {
        for (let bIdx = 0; bIdx < buyLevels.length; bIdx++) {
          if (cfg.enabledBuyLevels && cfg.enabledBuyLevels[bIdx] === false) continue;
          if (filledBuyIndices.has(bIdx)) continue;
          let bPrice = buyLevels[bIdx]!;

          // Buy above trend support override
          if (cfg.enableBuyAboveTrendSupport && uptrendLine && !uptrendLine.isBroken && uptrendLine.currentLinePrice > bPrice && uptrendLine.currentLinePrice < midRef) {
            bPrice = uptrendLine.currentLinePrice;
          }

          let cumWeight = 0;
          for (let w = 0; w <= bIdx; w++) {
            if (!cfg.enabledBuyLevels || cfg.enabledBuyLevels[w] !== false) {
              cumWeight += weights[w] ?? 20;
            }
          }
          const targetFrac = cumWeight / totalWeight;

          if (currentHoldFrac < targetFrac - 0.01 && c.low <= bPrice) {
            const weightFrac = (weights[bIdx] ?? 20) / totalWeight;
            const trancheBudget = Math.min(cash, cfg.budget * weightFrac);
            if (trancheBudget >= 5.0) {
              const buyQty = trancheBudget / bPrice;
              cash -= trancheBudget;
              lots.push({ price: bPrice, qty: buyQty, time: c.time, buyIdx: bIdx });
              filledBuyIndices.add(bIdx);
              trades.push({ type: "BUY", price: bPrice, qty: buyQty, time: c.time, reason: `Buy Level ${bIdx + 1}` });
              break;
            }
          }
        }
      }
    }

    engine.addCandle(c);
  }

  const lastCandle = candles[candles.length - 1]!;
  const finalHeldBase = lots.reduce((sum, l) => sum + l.qty, 0);
  const finalAvg = finalHeldBase > 0 ? lots.reduce((sum, l) => sum + l.price * l.qty, 0) / finalHeldBase : 0;
  const unrealizedPnl = finalHeldBase > 0 ? (lastCandle.close - finalAvg) * finalHeldBase : 0;
  const finalEquity = cash + finalHeldBase * lastCandle.close;
  const netPnl = finalEquity - cfg.budget;
  const netPnlPct = (netPnl / cfg.budget) * 100;
  const totalClosedTrades = winTrades + lossTrades;
  const winRate = totalClosedTrades > 0 ? (winTrades / totalClosedTrades) * 100 : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99.9 : 0;

  const cutLosses = trades.filter((t) => t.type === "CUT_LOSS");
  const normalSells = trades.filter((t) => t.type === "SELL");
  const tpExits = trades.filter((t) => t.type === "TAKE_PROFIT");
  const gridCashflowProfit = normalSells.reduce((s, t) => s + (t.pnl || 0), 0);
  const tpProfit = tpExits.reduce((s, t) => s + (t.pnl || 0), 0);
  const cutLossLoss = Math.abs(cutLosses.reduce((s, t) => s + (t.pnl || 0), 0));

  return {
    symbol,
    configName: cfg.name,
    initialBudget: cfg.budget,
    finalEquity,
    netPnl,
    netPnlPct,
    totalTrades: totalClosedTrades,
    winTrades,
    lossTrades,
    winRate,
    completedCycles,
    maxDrawdownPct: maxDrawdown,
    profitFactor,
    holdingLotsCount: lots.length,
    unrealizedPnl,
    gridCashflowProfit,
    tpProfit,
    cutLossLoss,
    ceilingExitsCount,
    lhEscapesCount,
    floorCutLossCount,
    trendSupportBreakCount,
    trades,
  };
}

export function runSwingSimulation(
  symbol: string,
  candles: Candle[],
  swingCfg: SwingStrategyConfig & { enableChoChGate?: boolean; name?: string },
  initialBudget = 200,
): BacktestResult {
  const engine = new DowStructureEngine(3, true, 20.0, 600);
  const warmupCount = 120;

  for (let i = 0; i < warmupCount && i < candles.length; i++) {
    engine.addCandle(candles[i]!);
  }

  let cash = initialBudget;
  let activePos: {
    entryPrice: number;
    qty: number;
    notional: number;
    stopLossPrice: number;
    tp1Price: number;
    tp2Price: number;
    tp1Executed: boolean;
    highestPrice: number;
    trailingStopActive: boolean;
    trailingStopPrice?: number;
  } | null = null;

  let winTrades = 0;
  let lossTrades = 0;
  let totalTrades = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let tpProfit = 0;
  let cutLossLoss = 0;
  let peakEquity = initialBudget;
  let maxDrawdown = 0;

  for (let i = warmupCount; i < candles.length; i++) {
    const c = candles[i]!;
    const structure = engine.getStructure(c.open, c.open, {
      mode: "DOW_SWINGS",
      minChannelWidthPct: 2.0,
      maxChannelWidthPct: 15.0,
      useOnlyClosedCandles: true,
    });

    const currentEquity = cash + (activePos ? activePos.qty * c.close : 0);
    if (currentEquity > peakEquity) peakEquity = currentEquity;
    const dd = peakEquity > 0 ? ((peakEquity - currentEquity) / peakEquity) * 100 : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;

    if (activePos) {
      if (c.high > activePos.highestPrice) {
        activePos.highestPrice = c.high;
      }

      // Check Trailing Stop Activation after TP1
      const gainPct = ((c.high - activePos.entryPrice) / activePos.entryPrice) * 100;
      if (activePos.tp1Executed && gainPct >= swingCfg.trailingActivationPct) {
        activePos.trailingStopActive = true;
        const trailingFloor = activePos.highestPrice * (1 - swingCfg.trailingPullbackPct / 100);
        if (!activePos.trailingStopPrice || trailingFloor > activePos.trailingStopPrice) {
          activePos.trailingStopPrice = trailingFloor;
        }
      }

      const effectiveSl = activePos.trailingStopActive && activePos.trailingStopPrice
        ? Math.max(activePos.stopLossPrice, activePos.trailingStopPrice)
        : activePos.stopLossPrice;

      // 1. Stop Loss triggered
      if (c.low <= effectiveSl) {
        const exitP = Math.min(c.open, effectiveSl);
        const pnl = (exitP - activePos.entryPrice) * activePos.qty;
        cash += activePos.qty * exitP;
        totalTrades++;
        if (pnl >= 0) {
          grossProfit += pnl;
          tpProfit += pnl;
          winTrades++;
        } else {
          grossLoss += Math.abs(pnl);
          cutLossLoss += Math.abs(pnl);
          lossTrades++;
        }
        activePos = null;
      }
      // 2. TP1 Target reached (close 50%, move SL to Breakeven)
      else if (!activePos.tp1Executed && c.high >= activePos.tp1Price) {
        const exitQty = activePos.qty * swingCfg.tp1CloseRatio;
        const pnl = (activePos.tp1Price - activePos.entryPrice) * exitQty;
        cash += exitQty * activePos.tp1Price;
        grossProfit += pnl;
        tpProfit += pnl;
        winTrades++;
        totalTrades++;
        activePos.qty -= exitQty;
        activePos.tp1Executed = true;
        activePos.stopLossPrice = activePos.entryPrice; // Breakeven!
      }
      // 3. TP2 Target reached
      else if (activePos.tp1Executed && c.high >= activePos.tp2Price) {
        const pnl = (activePos.tp2Price - activePos.entryPrice) * activePos.qty;
        cash += activePos.qty * activePos.tp2Price;
        grossProfit += pnl;
        tpProfit += pnl;
        winTrades++;
        totalTrades++;
        activePos = null;
      }
    } else {
      // 🛡️ Macro ChoCh Gate check for Swing Entry
      let canEnter = true;
      if (swingCfg.enableChoChGate) {
        const gate = RegimeChannelGate.evaluateGate({
          price: c.close,
          proposedFloor: structure.bottomBound,
          proposedCeiling: structure.upperBound,
          regime: structure.regime,
          waveCycle: structure.waveCycle,
          lastLh: structure.lastLh,
          isDowntrendDropActive: structure.isDowntrendDropActive,
        });
        if (structure.regime === "DOWNTREND" && !gate.isChoChBullish) {
          canEnter = false;
        }
      }

      if (canEnter) {
        // Look for Entry Setup
        const signal = SwingSignalDetector.evaluateSetup(c.close, structure, swingCfg, engine.getCandles());
        if (signal.hasSignal && signal.entryPrice > 0) {
          const budgetForTrade = cash * (swingCfg.maxPositionPct / 100);
          const entryPrice = c.close;
          const qty = budgetForTrade / entryPrice;
          cash -= budgetForTrade;
          activePos = {
            entryPrice,
            qty,
            notional: budgetForTrade,
            stopLossPrice: signal.stopLossPrice,
            tp1Price: signal.tp1Price,
            tp2Price: signal.tp2Price,
            tp1Executed: false,
            highestPrice: entryPrice,
            trailingStopActive: false,
          };
        }
      }
    }

    engine.addCandle(c);
  }

  // Close remaining position if any
  let unrealizedPnl = 0;
  if (activePos && candles.length > 0) {
    const lastClose = candles[candles.length - 1]!.close;
    unrealizedPnl = (lastClose - activePos.entryPrice) * activePos.qty;
  }

  const netPnl = cash + (activePos ? activePos.qty * (candles[candles.length - 1]?.close || 0) : 0) - initialBudget;
  const netPnlPct = (netPnl / initialBudget) * 100;
  const winRate = totalTrades > 0 ? (winTrades / totalTrades) * 100 : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 99.99 : 1.0);

  return {
    symbol,
    configName: swingCfg.name || "6. Swing Strategy (Raw LL Retest & Breakout)",
    initialBudget,
    finalEquity: initialBudget + netPnl,
    netPnl,
    netPnlPct,
    totalTrades,
    winTrades,
    lossTrades,
    winRate,
    completedCycles: winTrades,
    maxDrawdownPct: maxDrawdown,
    profitFactor,
    holdingLotsCount: activePos ? 1 : 0,
    unrealizedPnl,
    gridCashflowProfit: tpProfit,
    tpProfit,
    cutLossLoss,
    ceilingExitsCount: 0,
    lhEscapesCount: 0,
    floorCutLossCount: 0,
    trendSupportBreakCount: 0,
    trades: [],
  };
}

async function main() {
  const symbols = ["BNBFDUSD", "BTCUSDT"];

  const configs: BacktestConfig[] = [
    {
      name: "1. Optimized Sniper Grid (Front-Load [50,30,20] + FastCut 🛡️) 🌟",
      budget: 200,
      sellProfitMode: "GRID_CASHFLOW",
      channelMode: "DONCHIAN_ATR",
      minChannelWidthPct: 1.8,
      maxChannelWidthPct: 6.0,
      buyLevelPcts: [15, 8, 2, 1, 0.5],
      sellLevelPcts: [60, 80, 100, 100, 100],
      buyLevelWeights: [50, 30, 20, 10, 10],
      enabledBuyLevels: [true, true, true, false, false],
      enabledSellTargets: [true, true, true, false, false],
      minNetProfitPct: 0.50,
      floorBufferPct: 0.35,
      dowTrendFilter: true,
      enableTrendChannelGating: true,
      enableExitOnDowntrendRegime: true,
      enableExitOnTrendSupportBreak: false,
      enableBuyBelowSellLevel1: true,
      enableSellBelowTrendResistance: true,
      enableLhDynamicEscape: false,
      lockChannelInPosition: true,
    },
    {
      name: "2. Previous Sniper Grid (Baseline [35,35,30] + No FastCut)",
      budget: 200,
      sellProfitMode: "GRID_CASHFLOW",
      channelMode: "DONCHIAN_ATR",
      minChannelWidthPct: 1.8,
      maxChannelWidthPct: 6.0,
      buyLevelPcts: [15, 8, 2, 1, 0.5],
      sellLevelPcts: [50, 75, 95, 98, 100],
      buyLevelWeights: [35, 35, 30, 10, 10],
      enabledBuyLevels: [true, true, true, false, false],
      enabledSellTargets: [true, true, true, false, false],
      minNetProfitPct: 0.25,
      floorBufferPct: 0.35,
      dowTrendFilter: true,
      enableTrendChannelGating: true,
      enableExitOnDowntrendRegime: false,
      enableExitOnTrendSupportBreak: false,
      enableBuyBelowSellLevel1: true,
      enableSellBelowTrendResistance: true,
      enableLhDynamicEscape: false,
      lockChannelInPosition: true,
    },
    {
      name: "3. Sniper Grid (ชิดฟลอร์ 15/8/2% + SupportBreak = TRUE)",
      budget: 200,
      sellProfitMode: "GRID_CASHFLOW",
      channelMode: "DONCHIAN_ATR",
      minChannelWidthPct: 1.8,
      maxChannelWidthPct: 6.0,
      buyLevelPcts: [15, 8, 2, 1, 0.5],
      sellLevelPcts: [50, 75, 95, 98, 100],
      buyLevelWeights: [35, 35, 30, 10, 10],
      enabledBuyLevels: [true, true, true, false, false],
      enabledSellTargets: [true, true, true, false, false],
      minNetProfitPct: 0.25,
      floorBufferPct: 0.35,
      dowTrendFilter: true,
      enableTrendChannelGating: true,
      enableExitOnTrendSupportBreak: true,
      enableBuyBelowSellLevel1: true,
      enableSellBelowTrendResistance: true,
      enableLhDynamicEscape: true,
      lockChannelInPosition: true,
    },
    {
      name: "4. Classic Wide Grid (กระจายเต็มกรอบ 42/32/22%)",
      budget: 200,
      sellProfitMode: "GRID_CASHFLOW",
      channelMode: "DONCHIAN_ATR",
      minChannelWidthPct: 1.8,
      maxChannelWidthPct: 6.0,
      buyLevelPcts: [42, 32, 22, 12, 2],
      sellLevelPcts: [52, 62, 72, 82, 92],
      buyLevelWeights: [35, 35, 30, 10, 10],
      enabledBuyLevels: [true, true, true, false, false],
      enabledSellTargets: [true, true, true, false, false],
      minNetProfitPct: 0.25,
      floorBufferPct: 0.35,
      dowTrendFilter: true,
      enableTrendChannelGating: true,
      enableExitOnTrendSupportBreak: false,
      enableBuyBelowSellLevel1: true,
      enableSellBelowTrendResistance: true,
      enableLhDynamicEscape: true,
      lockChannelInPosition: true,
    },
    {
      name: "5. Equal 5-Tranche Wide Grid (กระจายเท่ากัน 5 ไม้ x 20%)",
      budget: 200,
      sellProfitMode: "GRID_CASHFLOW",
      channelMode: "DONCHIAN_ATR",
      minChannelWidthPct: 1.8,
      maxChannelWidthPct: 6.0,
      buySizingMode: "EQUAL",
      buyLevelPcts: [42, 32, 22, 12, 2],
      sellLevelPcts: [52, 62, 72, 82, 92],
      enabledBuyLevels: [true, true, true, true, true],
      enabledSellTargets: [true, true, true, true, true],
      minNetProfitPct: 0.25,
      floorBufferPct: 0.35,
      dowTrendFilter: true,
      enableTrendChannelGating: true,
      enableExitOnTrendSupportBreak: false,
      enableBuyBelowSellLevel1: true,
      enableSellBelowTrendResistance: true,
      enableLhDynamicEscape: true,
      lockChannelInPosition: true,
    },
    {
      name: "6. Naked Pure Grid (Zero Guards Baseline)",
      budget: 200,
      sellProfitMode: "GRID_CASHFLOW",
      channelMode: "DOW_SWINGS",
      minChannelWidthPct: 1.8,
      maxChannelWidthPct: 6.0,
      buyLevelPcts: [42, 32, 22, 12, 2],
      sellLevelPcts: [52, 62, 72, 82, 92],
      buyWeights: [35, 35, 30],
      minNetProfitPct: 0.25,
      floorBufferPct: 0.35,
      dowTrendFilter: false,
      enableTrendChannelGating: false,
      enableExitOnTrendSupportBreak: false,
      enableBuyBelowSellLevel1: false,
      enableLhDynamicEscape: false,
      lockChannelInPosition: false,
    },
  ];

  console.log("==========================================================================================================");
  console.log("🚀 UNIFIED REALISTIC PRODUCTION BACKTEST BENCHMARK (All Profiles Evaluated)");
  console.log("   Data: 1000 Binance 15m Candles (~10.4 Days) | Simulated Budget: $200");
  console.log("==========================================================================================================\n");

  const results: BacktestResult[] = [];

  for (const sym of symbols) {
    console.log(`📡 Fetching historical data for ${sym}...`);
    try {
      const candles = await fetchKlines(sym, "15m", 1000);
      const startPrice = candles[0]!.open;
      const endPrice = candles[candles.length - 1]!.close;
      const priceChangePct = ((endPrice - startPrice) / startPrice) * 100;
      console.log(`   Market: $${startPrice.toFixed(4)} -> $${endPrice.toFixed(4)} (${priceChangePct >= 0 ? "+" : ""}${priceChangePct.toFixed(2)}%)\n`);

      // 1-5: Grid Profiles
      for (const cfg of configs) {
        const res = runSimulation(sym, candles, cfg);
        results.push(res);
      }

      // 7. Swing Strategy Raw (LL Retest, Breakout)
      const swingCfgRaw: SwingStrategyConfig & { enableChoChGate?: boolean; name?: string } = {
        name: "7. Swing Strategy (Raw LL Retest & Breakout)",
        minRiskReward: 1.8,
        stopLossBufferPct: 0.35,
        maxPositionPct: 50.0,
        tp1CloseRatio: 0.5,
        tp1TargetType: "CENTER_POC",
        tp2TargetType: "SWING_HIGH_HH",
        trailingActivationPct: 1.2,
        trailingPullbackPct: 0.5,
        enableHlBaseEntry: true,
        enableTrendlineBreakoutEntry: true,
        enableSupportRetestEntry: true,
        enableChoChGate: false,
      };
      results.push(runSwingSimulation(sym, candles, swingCfgRaw, 200));

      // 8. Guarded Swing Strategy with Dow ChoCh Gate
      const swingCfgGuarded: SwingStrategyConfig & { enableChoChGate?: boolean; name?: string } = {
        name: "8. Guarded Swing Strategy (with Dow ChoCh Gate 🛡️)",
        minRiskReward: 1.8,
        stopLossBufferPct: 0.35,
        maxPositionPct: 50.0,
        tp1CloseRatio: 0.5,
        tp1TargetType: "CENTER_POC",
        tp2TargetType: "SWING_HIGH_HH",
        trailingActivationPct: 1.2,
        trailingPullbackPct: 0.5,
        enableHlBaseEntry: true,
        enableTrendlineBreakoutEntry: true,
        enableSupportRetestEntry: true,
        enableChoChGate: true,
      };
      results.push(runSwingSimulation(sym, candles, swingCfgGuarded, 200));

    } catch (err) {
      console.error(`❌ Error testing ${sym}:`, (err as Error).message);
    }
  }

  console.log("\n==========================================================================================================================================================");
  console.log("🏆 COMPREHENSIVE STRATEGY BENCHMARK AUDIT (10.4 DAYS 15M CANDLES)");
  console.log("==========================================================================================================================================================");
  console.log("| Symbol   | Profile                                                    | Net Return        | Trades | Cycles | Win Rate | CutLoss        | Max DD  | Final ($) |");
  console.log("----------------------------------------------------------------------------------------------------------------------------------------------------------");

  for (const r of results) {
    const symStr = r.symbol.padEnd(8);
    const profStr = r.configName.padEnd(58);
    const retStr = `${r.netPnl >= 0 ? "+" : ""}$${r.netPnl.toFixed(2)} (${r.netPnlPct >= 0 ? "+" : ""}${r.netPnlPct.toFixed(2)}%)`.padEnd(17);
    const trStr = String(r.totalTrades).padEnd(6);
    const cycStr = String(r.completedCycles ?? 0).padEnd(6);
    const wrStr = `${r.winRate.toFixed(1)}%`.padEnd(8);
    const clStr = `-$${r.cutLossLoss.toFixed(2)} (${r.floorCutLossCount}x)`.padEnd(14);
    const ddStr = `${r.maxDrawdownPct.toFixed(2)}%`.padEnd(7);
    const finStr = `$${r.finalEquity.toFixed(2)}`.padEnd(9);

    console.log(`| ${symStr} | ${profStr} | ${retStr} | ${trStr} | ${cycStr} | ${wrStr} | ${clStr} | ${ddStr} | ${finStr} |`);
  }
  console.log("==========================================================================================================================================================\n");
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.includes("backtest")) {
  main().catch(console.error);
}
