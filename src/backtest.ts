import { DowStructureEngine } from "./market-structure/index.js";
import { VolumeProfileEngine } from "./market-structure/volume-profile.js";
import { SwingSignalDetector } from "./strategy/swing/signals.js";
import type { SwingStrategyConfig } from "./strategy/swing/config.js";

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
}

export interface TradeRecord {
  type: "BUY" | "SELL" | "TAKE_PROFIT" | "CUT_LOSS";
  price: number;
  qty: number;
  pnl?: number;
  reason?: string;
  time: number;
}

export interface BacktestConfig {
  name: string;
  budget: number;
  sellProfitMode: "GRID_CASHFLOW" | "PORTFOLIO_AVG_PROFIT";
  channelMode?: "DOW_SWINGS" | "VOLUME_PROFILE_HTF" | "DOW_ATR_CLAMP";
  minChannelWidthPct: number;
  maxChannelWidthPct: number;
  buyWeights: number[];
  minNetProfitPct: number;
  cutLossMode: "CONFIRMED_CLOSE" | "WICK_INSTANT" | "OFF";
  floorBufferPct: number;
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
  maxDrawdownPct: number;
  profitFactor: number;
  holdingLotsCount: number;
  unrealizedPnl: number;
  gridCashflowProfit: number;
  tpProfit: number;
  cutLossLoss: number;
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

export function runSimulation(symbol: string, candles: Candle[], cfg: BacktestConfig): BacktestResult {
  const engine = new DowStructureEngine(3, true, 20.0, 600);
  const warmupCount = 120;

  for (let i = 0; i < warmupCount; i++) {
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

  const totalWeight = cfg.buyWeights.reduce((s, w) => s + w, 0);

  for (let i = warmupCount; i < candles.length; i++) {
    const c = candles[i]!;
    let volumeProfile;
    if (cfg.channelMode === "VOLUME_PROFILE_HTF") {
      volumeProfile = VolumeProfileEngine.calculate(engine.getCandles(), 192);
    }
    const structure = engine.getStructure(c.open, c.open, {
      mode: cfg.channelMode || "DOW_SWINGS",
      minChannelWidthPct: cfg.minChannelWidthPct,
      maxChannelWidthPct: cfg.maxChannelWidthPct,
      floorBufferPct: cfg.floorBufferPct,
      volumeProfile,
    });

    const isSwingConfirmed = structure.isSwingConfirmed;
    const lowerBound = structure.bottomBound;
    const upperBound = structure.upperBound;
    const cutLossBound = lowerBound * (1 - cfg.floorBufferPct / 100);
    const buyLevels = structure.gridZone?.buyLevels ?? [];
    const sellLevels = structure.gridZone?.sellLevels ?? [];

    const currentBaseHeld = lots.reduce((sum, l) => sum + l.qty, 0);
    const avgEntry = currentBaseHeld > 0 ? lots.reduce((sum, l) => sum + l.price * l.qty, 0) / currentBaseHeld : 0;
    const currentEquity = cash + currentBaseHeld * c.close;

    if (currentEquity > peakEquity) peakEquity = currentEquity;
    const dd = peakEquity > 0 ? ((peakEquity - currentEquity) / peakEquity) * 100 : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;

    if (isSwingConfirmed && lowerBound > 0 && upperBound > 0) {
      // 1. Cut Loss evaluation
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

      if (isCutLossTriggered && currentBaseHeld > 0) {
        const pnl = (cutLossPrice - avgEntry) * currentBaseHeld;
        cash += currentBaseHeld * cutLossPrice;
        if (pnl >= 0) {
          grossProfit += pnl;
          winTrades++;
        } else {
          grossLoss += Math.abs(pnl);
          lossTrades++;
        }
        trades.push({ type: "CUT_LOSS", price: cutLossPrice, qty: currentBaseHeld, pnl, time: c.time, reason: "Cut Loss" });
        lots = [];
      }
      // 2. 100% Take Profit at Upper Bound
      else if (
        currentBaseHeld > 0 &&
        c.high >= upperBound &&
        (cfg.sellProfitMode !== "PORTFOLIO_AVG_PROFIT" || c.high >= avgEntry * (1 + cfg.minNetProfitPct / 100))
      ) {
        const exitPrice = upperBound;
        const pnl = (exitPrice - avgEntry) * currentBaseHeld;
        cash += currentBaseHeld * exitPrice;
        if (pnl >= 0) {
          grossProfit += pnl;
          winTrades++;
        } else {
          grossLoss += Math.abs(pnl);
          lossTrades++;
        }
        trades.push({ type: "TAKE_PROFIT", price: exitPrice, qty: currentBaseHeld, pnl, time: c.time, reason: "Ceiling Exit" });
        lots = [];
      }
      // 3. Grid Sell Targets
      else if (currentBaseHeld > 0 && sellLevels.length > 0) {
        for (let sIdx = 0; sIdx < sellLevels.length; sIdx++) {
          const sPrice = sellLevels[sIdx]!;
          if (c.high >= sPrice && lots.length > 0) {
            const isProfitOk =
              cfg.sellProfitMode !== "PORTFOLIO_AVG_PROFIT" || sPrice >= avgEntry * (1 + cfg.minNetProfitPct / 100);
            if (isProfitOk) {
              const trancheQty = currentBaseHeld / Math.max(1, sellLevels.length);
              const sellQty = Math.min(lots.reduce((s, l) => s + l.qty, 0), trancheQty);
              if (sellQty > 0) {
                let rem = sellQty;
                let tradePnl = 0;
                while (rem > 0 && lots.length > 0) {
                  const l = lots[0]!;
                  const take = Math.min(l.qty, rem);
                  tradePnl += (sPrice - l.price) * take;
                  l.qty -= take;
                  rem -= take;
                  if (l.qty <= 1e-8) lots.shift();
                }
                cash += sellQty * sPrice;
                if (tradePnl >= 0) {
                  grossProfit += tradePnl;
                  winTrades++;
                } else {
                  grossLoss += Math.abs(tradePnl);
                  lossTrades++;
                }
                trades.push({ type: "SELL", price: sPrice, qty: sellQty, pnl: tradePnl, time: c.time, reason: `Sell Target ${sIdx + 1}` });
                break;
              }
            }
          }
        }
      }

      // 4. Grid Buy Levels with Cumulative Exposure Quota Guard (v0.2.45)
      const currentHeldQuote = lots.reduce((sum, l) => sum + l.price * l.qty, 0);
      const currentHoldFrac = cfg.budget > 0 ? currentHeldQuote / cfg.budget : 0;

      if (buyLevels.length > 0 && currentHoldFrac < 0.95 && c.low >= lowerBound) {
        for (let bIdx = 0; bIdx < buyLevels.length; bIdx++) {
          const bPrice = buyLevels[bIdx]!;
          let cumWeight = 0;
          for (let w = 0; w <= bIdx; w++) cumWeight += cfg.buyWeights[w] ?? 20;
          const targetFrac = cumWeight / totalWeight;

          if (currentHoldFrac < targetFrac - 0.01 && c.low <= bPrice) {
            const weightFrac = (cfg.buyWeights[bIdx] ?? 20) / totalWeight;
            const trancheBudget = Math.min(cash, cfg.budget * weightFrac);
            if (trancheBudget >= 5.0) {
              const buyQty = trancheBudget / bPrice;
              cash -= trancheBudget;
              lots.push({ price: bPrice, qty: buyQty, time: c.time });
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
    maxDrawdownPct: maxDrawdown,
    profitFactor,
    holdingLotsCount: lots.length,
    unrealizedPnl,
    gridCashflowProfit,
    tpProfit,
    cutLossLoss,
  };
}

export function runSwingSimulation(
  symbol: string,
  candles: Candle[],
  swingCfg: SwingStrategyConfig,
  initialBudget = 200,
): BacktestResult {
  const engine = new DowStructureEngine(3, true, 20.0, 600);
  const warmupCount = 120;

  for (let i = 0; i < warmupCount; i++) {
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
    configName: "5. Major LL Retest & Reversal Swing Strategy",
    initialBudget,
    finalEquity: initialBudget + netPnl,
    netPnl,
    netPnlPct,
    totalTrades,
    winTrades,
    lossTrades,
    winRate,
    maxDrawdownPct: maxDrawdown,
    profitFactor,
    holdingLotsCount: activePos ? 1 : 0,
    unrealizedPnl,
    gridCashflowProfit: 0,
    tpProfit,
    cutLossLoss,
  };
}

async function main() {
  const symbols = (process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["ETHFDUSD", "BTCUSDT", "SOMIUSDT"]);
  const configs: BacktestConfig[] = [
    {
      name: "1. Confirmed-Close Buffer CutLoss (Safe Buffer 0.35%)",
      budget: 200,
      sellProfitMode: "GRID_CASHFLOW",
      minChannelWidthPct: 1.8,
      maxChannelWidthPct: 6.0,
      buyWeights: [10, 15, 20, 25, 30],
      minNetProfitPct: 0.25,
      cutLossMode: "CONFIRMED_CLOSE",
      floorBufferPct: 0.35,
    },
    {
      name: "2. Pure Grid Cashflow (No Instant CutLoss, Hold & Turn)",
      budget: 200,
      sellProfitMode: "GRID_CASHFLOW",
      minChannelWidthPct: 1.8,
      maxChannelWidthPct: 6.0,
      buyWeights: [10, 15, 20, 25, 30],
      minNetProfitPct: 0.25,
      cutLossMode: "OFF",
      floorBufferPct: 0.0,
    },
    {
      name: "3. Optimized Dynamic Adaptive (Narrow 1.5% / Cashflow)",
      budget: 200,
      sellProfitMode: "GRID_CASHFLOW",
      channelMode: "DOW_SWINGS",
      minChannelWidthPct: 1.5,
      maxChannelWidthPct: 5.0,
      buyWeights: [12, 16, 20, 24, 28],
      minNetProfitPct: 0.30,
      cutLossMode: "CONFIRMED_CLOSE",
      floorBufferPct: 0.25,
    },
    {
      name: "4. Volume Profile Tactical (Hybrid VP & 15M Swings)",
      budget: 200,
      sellProfitMode: "GRID_CASHFLOW",
      channelMode: "VOLUME_PROFILE_HTF",
      minChannelWidthPct: 2.0,
      maxChannelWidthPct: 6.0,
      buyWeights: [10, 15, 20, 25, 30],
      minNetProfitPct: 0.25,
      cutLossMode: "CONFIRMED_CLOSE",
      floorBufferPct: 0.35,
    },
  ];

  console.log("==========================================================================================================");
  console.log("🚀 PRODUCTION BACKTEST COMPARISON: ETHFDUSD vs BTCUSDT vs SOMIUSDT");
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

      for (const cfg of configs) {
        const res = runSimulation(sym, candles, cfg);
        results.push(res);
      }

      // 5. Major LL Retest & Reversal Swing Strategy
      const swingCfg: SwingStrategyConfig = {
        minRiskReward: 2.0,
        stopLossBufferPct: 0.5,
        maxPositionPct: 60.0,
        tp1CloseRatio: 0.5,
        tp1TargetType: "CENTER_POC",
        tp2TargetType: "SWING_HIGH_HH",
        trailingActivationPct: 1.5,
        trailingPullbackPct: 0.8,
        enableHlBaseEntry: true,
        enableTrendlineBreakoutEntry: true,
        enableSupportRetestEntry: true,
      };
      const swingRes = runSwingSimulation(sym, candles, swingCfg, 200);
      results.push(swingRes);
    } catch (err) {
      console.error(`❌ Error testing ${sym}:`, (err as Error).message);
    }
  }

  console.log("========================================================================================================================================================");
  console.log("| Symbol   | Profile                                           | Net Return | Cashflow ($) | TP PnL ($) | CutLoss ($) | Win Rate  | Trades | Max DD (%) |");
  console.log("========================================================================================================================================================");

  for (const r of results) {
    const pnlSign = r.netPnl >= 0 ? "+" : "";
    const retStr = `${pnlSign}${r.netPnlPct.toFixed(2)}% ($${r.netPnl.toFixed(2)})`.padEnd(17);
    const cfStr = `+$${r.gridCashflowProfit.toFixed(2)}`.padEnd(12);
    const tpStr = `+$${r.tpProfit.toFixed(2)}`.padEnd(10);
    const clStr = `-$${r.cutLossLoss.toFixed(2)}`.padEnd(11);
    const winStr = `${r.winRate.toFixed(1)}%`.padEnd(9);
    const tradesStr = `${r.totalTrades}`.padEnd(6);
    const ddStr = `${r.maxDrawdownPct.toFixed(2)}%`.padEnd(10);
    const symStr = r.symbol.padEnd(8);
    const cfgStr = r.configName.padEnd(49);

    console.log(`| ${symStr} | ${cfgStr} | ${retStr} | ${cfStr} | ${tpStr} | ${clStr} | ${winStr} | ${tradesStr} | ${ddStr} |`);
  }
  console.log("========================================================================================================================================================\n");
}

if (process.argv[1]?.includes("backtest")) {
  main().catch(console.error);
}
