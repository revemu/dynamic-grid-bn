import fs from "fs";
import path from "path";
import { Candle } from "../src/strategy/ma-fan/types.js";
import { calcEMA } from "../src/strategy/ma-fan/ribbon.js";
import { calcRSI, calcMACD } from "../src/strategy/ma-fan/exhaustion.js";
import { loadCandles, runPortfolioSimulation, PortfolioConfig } from "./test-portfolio-ma-fan.js";

const BLACKLIST = new Set([
  "BFUSDUSDT", "USDEUSDT", "RWUSDUSDT", "UUSDT", "??USDT",
  "GOOGLBUSDT", "INTCBUSDT", "MSTRBUSDT", "QQQBUSDT", "SKHYBUSDT",
  "SNDKBUSDT", "SOXLBUSDT", "SPCXBUSDT", "TQQQBUSDT", "CRCLBUSDT", "PAXGUSDT", "XAUTUSDT"
]);

// Parameterized simulator for exact ablation from the original +61.42% script
function runAblationSim(opts: {
  label: string;
  fixLookAhead: boolean;
  fixMtmEnd: boolean;
  fixSizing: boolean;
  uniformUniverseOnly: boolean;
  penetrationPct: number;
}, allSymbols: string[]) {
  const btc15m = loadCandles("BTCUSDT", 15);
  const btc4h = loadCandles("BTCUSDT", 240);
  const btc4hEma75 = calcEMA(btc4h.map((c) => c.close), 75);

  const startTime = btc15m[0]!.time + 320 * 3600;
  const endTime = btc15m.at(-1)!.time;

  const coinData = [];
  for (const sym of allSymbols) {
    const c15 = loadCandles(sym, 15);
    const c1h = loadCandles(sym, 60);
    if (c15.length < 500 || c1h.length < 200) continue;
    if (opts.uniformUniverseOnly) {
      if (c15[0]!.time > startTime - 200 * 900 || c15.at(-1)!.time < endTime - 86400) continue;
    }

    const closes15 = c15.map((c) => c.close);
    const timeMap = new Map<number, number>();
    for (let i = 0; i < c15.length; i++) timeMap.set(c15[i]!.time, i);

    coinData.push({
      symbol: sym,
      c15,
      c1h,
      m4: calcEMA(closes15, 4),
      m8: calcEMA(closes15, 8),
      m16: calcEMA(closes15, 16),
      m25: calcEMA(closes15, 25),
      m75: calcEMA(closes15, 75),
      m200: calcEMA(closes15, 200),
      rsi15: calcRSI(c15, 14),
      macd15: calcMACD(c15, 12, 26, 9),
      rsi1h: calcRSI(c1h, 14),
      timeMap,
    });
  }

  const costPerFill = (0.075 + 0.01) / 100;
  const maxSlots = 3;
  let cash = 100.0;
  let activePositions: Array<{
    symbol: string;
    entryTime: number;
    entryPrice: number;
    allocatedCapital: number;
    qty: number;
    troughPrice: number;
    lastKnownPrice: number;
  }> = [];
  const completedTrades: Array<{ pnlQuote: number; pnlPct: number; maePct: number }> = [];
  let peakEquity = 100.0;
  let maxDd = 0;

  const coinStates = new Map<string, {
    hadBottomFan: boolean;
    fanExpiryTime: number;
    waitingPullback: boolean;
    pullbackExpiryTime: number;
    waitFromTime: number;
  }>();
  const p1Map = new Map<string, number>();
  for (const c of coinData) {
    coinStates.set(c.symbol, {
      hadBottomFan: false,
      fanExpiryTime: 0,
      waitingPullback: false,
      pullbackExpiryTime: 0,
      waitFromTime: 0,
    });
    p1Map.set(c.symbol, 0);
  }

  let pbBtc = 0;

  for (let t = startTime; t <= endTime; t += 900) {
    const closeT = t + 900;
    while (pbBtc + 1 < btc4h.length && btc4h[pbBtc + 1]!.time + 14400 <= closeT) pbBtc++;
    const isBtcGatePassed = btc4h[pbBtc]!.close >= btc4hEma75[pbBtc]!;

    // 1. Exits
    const surviving = [];
    for (const pos of activePositions) {
      const coin = coinData.find((c) => c.symbol === pos.symbol)!;
      const idx = coin.timeMap.get(t);
      if (idx === undefined) { surviving.push(pos); continue; }
      const c = coin.c15[idx]!;
      pos.lastKnownPrice = c.close;
      pos.troughPrice = Math.min(pos.troughPrice, c.low);

      const isBullishFan =
        coin.m4[idx]! > coin.m8[idx]! &&
        coin.m8[idx]! > coin.m16[idx]! &&
        coin.m16[idx]! > coin.m25[idx]! &&
        coin.m25[idx]! > coin.m75[idx]! &&
        coin.m75[idx]! > coin.m200[idx]!;

      if (isBullishFan) {
        const proceeds = pos.qty * c.close * (1 - costPerFill);
        const netPnlQuote = proceeds - pos.allocatedCapital;
        const netPnlPct = (netPnlQuote / pos.allocatedCapital) * 100;
        const maePct = ((pos.troughPrice - pos.entryPrice) / pos.entryPrice) * 100;
        cash += proceeds;
        completedTrades.push({ pnlQuote: netPnlQuote, pnlPct: netPnlPct, maePct });
        const st = coinStates.get(pos.symbol)!;
        st.hadBottomFan = false;
        st.waitingPullback = false;
      } else {
        surviving.push(pos);
      }
    }
    activePositions = surviving;

    // 2. Equity
    let currentOpenValue = 0;
    for (const pos of activePositions) {
      const coin = coinData.find((c) => c.symbol === pos.symbol)!;
      const idx = coin.timeMap.get(t);
      const curPrice = idx !== undefined ? coin.c15[idx]!.close : pos.entryPrice;
      currentOpenValue += pos.qty * curPrice;
    }
    const totalEquity = cash + currentOpenValue;
    if (totalEquity > peakEquity) peakEquity = totalEquity;
    const curDd = ((peakEquity - totalEquity) / peakEquity) * 100;
    if (curDd > maxDd) maxDd = curDd;

    const availableSlots = maxSlots - activePositions.length;
    if (availableSlots <= 0 || !isBtcGatePassed) {
      for (const coin of coinData) {
        const idx = coin.timeMap.get(t);
        if (idx === undefined || idx < 200) continue;
        const st = coinStates.get(coin.symbol)!;
        if (t > st.fanExpiryTime && !st.waitingPullback) st.hadBottomFan = false;
        if (t > st.pullbackExpiryTime) st.waitingPullback = false;
      }
      continue;
    }

    const candidates: Array<{ symbol: string; entryPrice: number; score: number; barLow: number; barClose: number }> = [];
    for (const coin of coinData) {
      if (activePositions.some((p) => p.symbol === coin.symbol)) continue;
      const idx = coin.timeMap.get(t);
      if (idx === undefined || idx < 200) continue;

      const st = coinStates.get(coin.symbol)!;
      const c = coin.c15[idx]!;

      let p1 = p1Map.get(coin.symbol)!;
      while (p1 + 1 < coin.c1h.length && coin.c1h[p1 + 1]!.time + 3600 <= closeT) p1++;
      p1Map.set(coin.symbol, p1);
      const is1hRsiPassed = coin.rsi1h[p1]! >= 40;

      if (opts.fixLookAhead) {
        // Strictly check prior-bar resting limit BEFORE updating current-bar state
        if (st.waitingPullback && t > st.waitFromTime && t <= st.pullbackExpiryTime) {
          const limitP = coin.m4[idx - 1]!;
          const reqLow = limitP * (1 - opts.penetrationPct / 100);
          if (coin.m8[idx - 1]! >= coin.m16[idx - 1]! && c.low <= reqLow) {
            candidates.push({
              symbol: coin.symbol,
              entryPrice: Math.min(c.open, limitP),
              score: coin.rsi15[idx - 1]!,
              barLow: c.low,
              barClose: c.close,
            });
          }
        }
        if (t > st.pullbackExpiryTime && st.waitingPullback) st.waitingPullback = false;
      }

      const isBottomFan =
        coin.m4[idx]! < coin.m8[idx]! &&
        coin.m8[idx]! < coin.m16[idx]! &&
        coin.m16[idx]! < coin.m25[idx]! &&
        coin.m25[idx]! < coin.m75[idx]! &&
        coin.m75[idx]! < coin.m200[idx]!;
      if (isBottomFan) {
        st.hadBottomFan = true;
        st.fanExpiryTime = t + 20 * 900;
      }
      if (t > st.fanExpiryTime && !st.waitingPullback) st.hadBottomFan = false;

      const is8Cross16Up = coin.m8[idx - 1]! <= coin.m16[idx - 1]! && coin.m8[idx]! > coin.m16[idx]!;
      if (!st.waitingPullback && st.hadBottomFan && is8Cross16Up) {
        const rsiOk = coin.rsi15[idx]! >= 35 && coin.rsi15[idx]! > coin.rsi15[idx - 1]!;
        const macdOk = coin.macd15.hist[idx]! > coin.macd15.hist[idx - 1]!;
        if (rsiOk && macdOk && is1hRsiPassed) {
          st.waitingPullback = true;
          st.waitFromTime = t;
          st.pullbackExpiryTime = t + 12 * 900;
        }
      }

      if (!opts.fixLookAhead) {
        if (t > st.pullbackExpiryTime && st.waitingPullback) st.waitingPullback = false;
        if (st.waitingPullback && t > st.waitFromTime && t <= st.pullbackExpiryTime) {
          const touchedMa4 = c.low <= coin.m4[idx]!;
          const momentumValid = coin.m8[idx]! >= coin.m16[idx]!;
          if (touchedMa4 && momentumValid) {
            candidates.push({
              symbol: coin.symbol,
              entryPrice: Math.min(c.open, coin.m4[idx]!) * 1.0001,
              score: coin.rsi15[idx]!,
              barLow: c.low,
              barClose: c.close,
            });
          }
        }
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    const toFill = candidates.slice(0, availableSlots);
    for (const cand of toFill) {
      const capitalToUse = opts.fixSizing
        ? cash / (maxSlots - activePositions.length)
        : Math.min(cash, totalEquity / maxSlots);
      if (capitalToUse < 10) continue;
      const entryCost = capitalToUse * (1 - costPerFill);
      const qty = entryCost / cand.entryPrice;
      cash -= capitalToUse;

      activePositions.push({
        symbol: cand.symbol,
        entryTime: t,
        entryPrice: cand.entryPrice,
        allocatedCapital: capitalToUse,
        qty,
        troughPrice: opts.fixLookAhead ? Math.min(cand.entryPrice, cand.barLow) : cand.entryPrice,
        lastKnownPrice: cand.barClose,
      });

      const st = coinStates.get(cand.symbol)!;
      st.waitingPullback = false;
      st.hadBottomFan = false;
    }
  }

  const stuck = activePositions.length;
  let finalEquity = cash;
  if (opts.fixMtmEnd) {
    for (const p of activePositions) {
      const proceeds = p.qty * p.lastKnownPrice * (1 - costPerFill);
      finalEquity += proceeds;
      completedTrades.push({
        pnlQuote: proceeds - p.allocatedCapital,
        pnlPct: ((proceeds - p.allocatedCapital) / p.allocatedCapital) * 100,
        maePct: ((p.troughPrice - p.entryPrice) / p.entryPrice) * 100,
      });
    }
  } else {
    finalEquity += activePositions.reduce((acc, p) => acc + p.qty * p.entryPrice, 0);
  }

  const wins = completedTrades.filter((t) => t.pnlPct > 0).length;
  const wr = completedTrades.length > 0 ? (wins / completedTrades.length) * 100 : 0;
  const gw = completedTrades.filter((t) => t.pnlQuote > 0).reduce((a, b) => a + b.pnlQuote, 0);
  const gl = Math.abs(completedTrades.filter((t) => t.pnlQuote < 0).reduce((a, b) => a + b.pnlQuote, 0));
  const pf = gl > 0 ? gw / gl : 999;

  return {
    Step: opts.label,
    Coins: coinData.length,
    "Trades (Stuck)": `${completedTrades.length} (${stuck})`,
    WinRate: `${wr.toFixed(1)}%`,
    NetPnL: `${finalEquity - 100 >= 0 ? "+" : ""}${(finalEquity - 100).toFixed(2)}%`,
    MaxDD: `-${maxDd.toFixed(1)}%`,
    PF: pf.toFixed(2),
  };
}

async function main() {
  const allFiles = fs.readdirSync(path.resolve(process.cwd(), "data/cache/klines"))
    .filter((f) => f.endsWith("USDT_5m.json"))
    .map((f) => f.replace("_5m.json", ""))
    .filter((s) => !BLACKLIST.has(s));

  console.log("================================================================================");
  console.log("   PART 1: EXACT ABLATION STUDY — WHAT CAUSED +61.42% TO DROP TO +8.72%?");
  console.log("================================================================================");

  const ablationSteps = [
    { label: "0. Original Script (All bugs present)", fixLookAhead: false, fixMtmEnd: false, fixSizing: false, uniformUniverseOnly: false, penetrationPct: 0 },
    { label: "1. + Fix End-of-Period MTM Valuation only", fixLookAhead: false, fixMtmEnd: true, fixSizing: false, uniformUniverseOnly: false, penetrationPct: 0 },
    { label: "2. + Fix Intra-bar Look-Ahead (0% pen)", fixLookAhead: true, fixMtmEnd: true, fixSizing: false, uniformUniverseOnly: false, penetrationPct: 0 },
    { label: "3. + Add 0.10% Limit Penetration Buffer", fixLookAhead: true, fixMtmEnd: true, fixSizing: false, uniformUniverseOnly: false, penetrationPct: 0.10 },
    { label: "4. + Fix Uniform 110d Universe (19 coins)", fixLookAhead: true, fixMtmEnd: true, fixSizing: false, uniformUniverseOnly: true, penetrationPct: 0.10 },
    { label: "5. + Fix Equal Slot Cash Sizing (Fully Fixed)", fixLookAhead: true, fixMtmEnd: true, fixSizing: true, uniformUniverseOnly: true, penetrationPct: 0.10 },
  ];

  console.table(ablationSteps.map((s) => runAblationSim(s, allFiles)));

  console.log("\n================================================================================");
  console.log("   PART 2: UNIFORM 28-DAY BACKTEST ON 59 CACHED COINS (200-bar 15m Warmup)");
  console.log("   Gate Check: Does Profit Factor >= 1.40 across a broad 59-coin universe?");
  console.log("================================================================================");

  const btc15 = loadCandles("BTCUSDT", 15);
  const endT = btc15.at(-1)!.time;
  const start28d = endT - 28 * 86400; // 28 days + 2.1 days (200 bars of 15m) warmup = 30.1 days

  const configs28d: PortfolioConfig[] = [
    { name: "E-1Slot (BTC 4H Gate)", maxSlots: 1, btc4hAboveEma75: true, coin1hRsi40: false, stopLossMode: "NONE" },
    { name: "F-1Slot (BTC 4H + 1H RSI>=40)", maxSlots: 1, btc4hAboveEma75: true, coin1hRsi40: true, stopLossMode: "NONE" },
    { name: "E-3Slots (BTC 4H Gate)", maxSlots: 3, btc4hAboveEma75: true, coin1hRsi40: false, stopLossMode: "NONE" },
    { name: "F-3Slots (BTC 4H + 1H RSI>=40)", maxSlots: 3, btc4hAboveEma75: true, coin1hRsi40: true, stopLossMode: "NONE" },
    { name: "E-5Slots (BTC 4H Gate)", maxSlots: 5, btc4hAboveEma75: true, coin1hRsi40: false, stopLossMode: "NONE" },
    { name: "F-5Slots (BTC 4H + 1H RSI>=40)", maxSlots: 5, btc4hAboveEma75: true, coin1hRsi40: true, stopLossMode: "NONE" },
    { name: "F-3Slots + Fixed 5% SL", maxSlots: 3, btc4hAboveEma75: true, coin1hRsi40: true, stopLossMode: "FIXED_5PCT" },
  ];

  const rows28d = configs28d.map((cfg) => {
    const r = runPortfolioSimulation(cfg, allFiles, start28d, endT);
    return {
      Model: r.configName,
      Coins: r.universeCount,
      "Trades (Stuck)": `${r.tradesCount} (${r.stuckCount})`,
      WinRate: `${r.winRate.toFixed(1)}%`,
      NetPnL: `${r.netPnlPct >= 0 ? "+" : ""}${r.netPnlPct.toFixed(2)}%`,
      MaxDD: `-${r.maxPortfolioDdPct.toFixed(1)}%`,
      PF: r.profitFactor.toFixed(2),
      WorstMAE: `${r.worstMaePct.toFixed(2)}%`,
      "Pass Gate (PF>=1.4)?": r.profitFactor >= 1.4 && r.tradesCount >= 20 ? "PASS" : "FAIL",
    };
  });
  console.table(rows28d);
}

main().catch(console.error);
