import { BacktestService } from "../src/backtest-service.js";
import { Candle } from "../src/strategy/ma-fan/types.js";
import { calcEMA } from "../src/strategy/ma-fan/ribbon.js";
import { calcBollingerBands, calcRSI, calcStochastic } from "./test-bb-rsi-stoch.js";

interface StrategyResult {
  name: string;
  totalTrades: number;
  winTrades: number;
  winRate: number;
  netPnlPct: number;
  maxDrawdownPct: number;
  profitFactor: number;
}

// Custom Grid Simulator that allows testing entry filters (BB + RSI / Stoch)
function simulateCustomGrid(candles: Candle[], opts: {
  symbol: string;
  initialCapital?: number;
  capitalZones?: number;
  entryFilter?: "none" | "bb_lower" | "bb_rsi" | "bb_stoch";
  maxChannelWidthPct?: number;
}): StrategyResult {
  const capital = opts.initialCapital ?? 200;
  const zones = opts.capitalZones ?? 2;
  const zoneSize = capital / zones;
  const feePct = 0.075 / 100;

  // Precompute indicators
  const bb = calcBollingerBands(candles, 20, 2.0);
  const rsi = calcRSI(candles, 14);
  const stoch = calcStochastic(candles, 14, 3);

  // HTF 1H EMA200 precomputation
  const c1h = BacktestService.aggregateCandles(candles, 60);
  const ema200_1h = calcEMA(c1h.map(c => c.close), 200);

  let cash = capital;
  let lots: Array<{ price: number; amount: number; cost: number; tpPrice: number }> = [];
  let peakEquity = capital;
  let maxDD = 0;
  let closedWins = 0;
  let closedLosses = 0;
  let grossProfit = 0;
  let grossLoss = 0;

  // Simple Donchian channel for reference (48 bars = 4h)
  const donchianPeriod = 48;

  for (let i = 200; i < candles.length; i++) {
    const c = candles[i];
    const prevC = candles[i - 1];

    // Current 1H bar
    const htfIdx = Math.floor(i / 12);
    const last1hEma = ema200_1h[Math.min(htfIdx, ema200_1h.length - 1)] ?? 0;
    const isHtfBull = last1hEma > 0 ? c.close >= last1hEma : true;

    // Current Donchian
    let dH = -Infinity, dL = Infinity;
    for (let k = i - donchianPeriod; k < i; k++) {
      if (candles[k].high > dH) dH = candles[k].high;
      if (candles[k].low < dL) dL = candles[k].low;
    }
    const channelSpan = dH - dL;
    const channelSpanPct = dL > 0 ? (channelSpan / dL) * 100 : 0;
    const posInChannel = channelSpan > 0 ? (c.close - dL) / channelSpan : 0.5;

    // 1. Check TP for existing lots
    for (let j = lots.length - 1; j >= 0; j--) {
      const lot = lots[j];
      if (c.high >= lot.tpPrice) {
        // Lot hit TP!
        const sellVal = lot.amount * lot.tpPrice * (1 - feePct);
        const pnl = sellVal - lot.cost;
        cash += sellVal;
        if (pnl > 0) {
          closedWins++;
          grossProfit += pnl;
        } else {
          closedLosses++;
          grossLoss += Math.abs(pnl);
        }
        lots.splice(j, 1);
      }
    }

    // 2. Check Stop Loss / Floor Breakdown
    if (lots.length > 0 && c.low < dL * 0.96) {
      // Emergency cut loss when breaking 4% below Donchian Floor
      for (const lot of lots) {
        const sellVal = lot.amount * (dL * 0.96) * (1 - feePct);
        const pnl = sellVal - lot.cost;
        cash += sellVal;
        closedLosses++;
        grossLoss += Math.abs(pnl);
      }
      lots = [];
    }

    // 3. Check Buy Trigger
    if (lots.length < zones && cash >= zoneSize) {
      // Must pass basic HTF & lower channel filter
      if (isHtfBull && posInChannel <= 0.35 && channelSpanPct >= 3.5 && channelSpanPct <= 20.0) {
        let allowBuy = false;

        if (opts.entryFilter === "none") {
          // Naive Grid: Buy if we have no lots, or price dropped 2.5% below last lot
          if (lots.length === 0) allowBuy = true;
          else {
            const lastLotPrice = lots[lots.length - 1].price;
            if (c.close <= lastLotPrice * 0.975) allowBuy = true;
          }
        } else if (opts.entryFilter === "bb_lower") {
          // Only buy when price is at lower Bollinger Band (%B <= 0.25)
          const isAtLowerBB = bb.percentB[i] <= 0.25;
          if (lots.length === 0) allowBuy = isAtLowerBB;
          else {
            const lastLotPrice = lots[lots.length - 1].price;
            allowBuy = isAtLowerBB && c.close <= lastLotPrice * 0.975;
          }
        } else if (opts.entryFilter === "bb_rsi") {
          // Buy when %B <= 0.30 AND RSI <= 38 (Oversold discount)
          const isOversold = bb.percentB[i] <= 0.30 && rsi[i] <= 38;
          if (lots.length === 0) allowBuy = isOversold;
          else {
            const lastLotPrice = lots[lots.length - 1].price;
            allowBuy = isOversold && c.close <= lastLotPrice * 0.975;
          }
        } else if (opts.entryFilter === "bb_stoch") {
          // Buy when %B <= 0.30 AND StochK <= 30 and curling up (K >= D or K > prevK)
          const isStochHook = bb.percentB[i] <= 0.30 && stoch.stochK[i] <= 30 && (stoch.stochK[i] >= stoch.stochD[i] || stoch.stochK[i] > stoch.stochK[i - 1]);
          if (lots.length === 0) allowBuy = isStochHook;
          else {
            const lastLotPrice = lots[lots.length - 1].price;
            allowBuy = isStochHook && c.close <= lastLotPrice * 0.975;
          }
        }

        if (allowBuy) {
          const buyPrice = c.close;
          const invest = Math.min(cash, zoneSize);
          const fee = invest * feePct;
          const netInvest = invest - fee;
          const amount = netInvest / buyPrice;
          const tpPct = 0.025; // 2.5% TP
          const tpPrice = buyPrice * (1 + tpPct);

          lots.push({ price: buyPrice, amount, cost: invest, tpPrice });
          cash -= invest;
        }
      }
    }

    // Equity calculation
    let inventoryVal = 0;
    for (const lot of lots) inventoryVal += lot.amount * c.close;
    const totalEquity = cash + inventoryVal;
    if (totalEquity > peakEquity) peakEquity = totalEquity;
    const curDD = peakEquity > 0 ? ((peakEquity - totalEquity) / peakEquity) * 100 : 0;
    if (curDD > maxDD) maxDD = curDD;
  }

  // Liquidate at end
  const lastPrice = candles[candles.length - 1].close;
  for (const lot of lots) {
    const sellVal = lot.amount * lastPrice * (1 - feePct);
    const pnl = sellVal - lot.cost;
    cash += sellVal;
    if (pnl > 0) {
      closedWins++;
      grossProfit += pnl;
    } else {
      closedLosses++;
      grossLoss += Math.abs(pnl);
    }
  }

  const finalEquity = cash;
  const netPnlPct = ((finalEquity - capital) / capital) * 100;
  const totalTrades = closedWins + closedLosses;
  const winRate = totalTrades > 0 ? (closedWins / totalTrades) * 100 : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : 0;

  return {
    name: opts.entryFilter ?? "none",
    totalTrades,
    winTrades: closedWins,
    winRate,
    netPnlPct,
    maxDrawdownPct: maxDD,
    profitFactor,
  };
}

async function runExperiment() {
  console.log("=========================================================================");
  console.log("🔬 EMPIRICAL EXPERIMENT: Bollinger Bands + RSI / Stochastic on Dynamic Grid");
  console.log("=========================================================================");

  const targetSymbols = [
    "ETHUSDT", "SOLUSDT", "PEPEUSDT", "NEARUSDT", "DOGEUSDT", 
    "XRPUSDT", "BNBUSDT", "SUIUSDT", "LINKUSDT", "ENAUSDT",
    "AAVEUSDT", "UNIUSDT", "TRXUSDT", "AVAXUSDT"
  ];

  console.log(`Testing across ${targetSymbols.length} major crypto pairs over 30-day crash (8,640 bars 5m)...`);

  const modes: Array<"none" | "bb_lower" | "bb_rsi" | "bb_stoch"> = ["none", "bb_lower", "bb_rsi", "bb_stoch"];
  const modeStats: Record<string, { pnlSum: number; ddSum: number; wrSum: number; tradesSum: number; pfSum: number; count: number; profitableCoins: number }> = {};

  for (const m of modes) {
    modeStats[m] = { pnlSum: 0, ddSum: 0, wrSum: 0, tradesSum: 0, pfSum: 0, count: 0, profitableCoins: 0 };
  }

  for (const sym of targetSymbols) {
    try {
      const candles = await BacktestService.fetchBinanceCandles(sym, "5m", 8640);
      if (!candles || candles.length < 5000) continue;

      for (const m of modes) {
        const res = simulateCustomGrid(candles, {
          symbol: sym,
          initialCapital: 200,
          capitalZones: 2,
          entryFilter: m,
        });

        const s = modeStats[m];
        s.pnlSum += res.netPnlPct;
        s.ddSum += res.maxDrawdownPct;
        s.wrSum += res.winRate;
        s.tradesSum += res.totalTrades;
        s.pfSum += isFinite(res.profitFactor) ? res.profitFactor : 1;
        s.count++;
        if (res.netPnlPct > 0) s.profitableCoins++;
      }
      process.stdout.write(".");
    } catch (e) {
      // ignore
    }
  }

  console.log("\n\n📊 RESULTS SUMMARY:\n");
  for (const m of modes) {
    const s = modeStats[m];
    const avgPnl = s.pnlSum / s.count;
    const avgDD = s.ddSum / s.count;
    const avgWR = s.wrSum / s.count;
    const avgTrades = s.tradesSum / s.count;
    const avgPF = s.pfSum / s.count;

    const label = 
      m === "none" ? "1. Baseline (Naive Grid - Blind Entry)" :
      m === "bb_lower" ? "2. Bollinger Lower Band Only (%B <= 0.25)" :
      m === "bb_rsi" ? "3. Bollinger + RSI Oversold (%B <= 0.30 & RSI <= 38)" :
      "4. Bollinger + Stoch Hook (%B <= 0.30 & Stoch <= 30 Hook)";

    console.log(`🔹 ${label}:`);
    console.log(`   Avg Net PnL:        ${avgPnl >= 0 ? "+" : ""}${avgPnl.toFixed(2)}%`);
    console.log(`   Avg Max Drawdown:   ${avgDD.toFixed(2)}%`);
    console.log(`   Avg Win Rate:       ${avgWR.toFixed(1)}%`);
    console.log(`   Avg Total Trades:   ${avgTrades.toFixed(1)} trades`);
    console.log(`   Profitable Coins:   ${s.profitableCoins}/${s.count} (${((s.profitableCoins / s.count) * 100).toFixed(1)}%)`);
    console.log(`   Avg Profit Factor:  ${avgPF.toFixed(2)}`);
    console.log("-------------------------------------------------------------------------");
  }
}

runExperiment().catch(console.error);
