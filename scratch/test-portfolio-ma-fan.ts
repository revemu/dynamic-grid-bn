import fs from "fs";
import path from "path";
import { Candle } from "../src/strategy/ma-fan/types.js";
import { calcEMA } from "../src/strategy/ma-fan/ribbon.js";
import { calcRSI, calcMACD } from "../src/strategy/ma-fan/exhaustion.js";

// Exclusion list for synthetics, tokenized stocks & stablecoins
const BLACKLIST = new Set([
  "BFUSDUSDT", "USDEUSDT", "RWUSDUSDT", "UUSDT", "??USDT",
  "GOOGLBUSDT", "INTCBUSDT", "MSTRBUSDT", "QQQBUSDT", "SKHYBUSDT",
  "SNDKBUSDT", "SOXLBUSDT", "SPCXBUSDT", "TQQQBUSDT", "CRCLBUSDT", "PAXGUSDT", "XAUTUSDT"
]);

const cache: Record<string, Candle[]> = {};
export function loadCandles(symbol: string, minutes: number): Candle[] {
  const key = `${symbol}_${minutes}`;
  if (cache[key]) return cache[key]!;
  const f = path.resolve(process.cwd(), "data/cache/klines", `${symbol}_5m.json`);
  if (!fs.existsSync(f)) return [];
  const raw = JSON.parse(fs.readFileSync(f, "utf8"));
  const c5: Candle[] = raw.candles || raw;
  const sec = minutes * 60;
  const out: Candle[] = [];
  let b = -1;
  let cur: Candle | null = null;
  for (const c of c5) {
    const bk = Math.floor(c.time / sec) * sec;
    if (bk !== b) {
      if (cur) out.push(cur);
      b = bk;
      cur = { ...c, time: bk, isClosed: true };
    } else if (cur) {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      cur.volume += c.volume;
    }
  }
  if (cur) out.push(cur);
  cache[key] = out;
  return out;
}

export interface PortfolioConfig {
  name: string;
  maxSlots: number;
  btc4hAboveEma75: boolean;
  coin1hRsi40: boolean;
  stopLossMode: "NONE" | "SWING_LOW" | "FIXED_5PCT" | "MA8_CROSS_MA16_DOWN";
  /** Require low to penetrate below MA4[idx-1] by this % to count as limit fill (default 0.10%) */
  limitPenetrationPct?: number;
  /** Force-close stuck positions if held longer than maxHoldHours (0 = disabled) */
  maxHoldHours?: number;
}

export interface CompletedTrade {
  symbol: string;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  pnlQuote: number;
  pnlPct: number;
  maePct: number;
  holdHours: number;
  exitReason: string;
  isForcedEndMtm: boolean;
}

export function runPortfolioSimulation(
  config: PortfolioConfig,
  validSymbols: string[],
  windowStart: number,
  windowEnd: number
) {
  const btc4h = loadCandles("BTCUSDT", 240);
  const btc4hEma75 = calcEMA(btc4h.map((c) => c.close), 75);

  interface PrecomputedCoin {
    symbol: string;
    c15: Candle[];
    c1h: Candle[];
    m4: number[];
    m8: number[];
    m16: number[];
    m25: number[];
    m75: number[];
    m200: number[];
    rsi15: number[];
    macd15: { hist: number[] };
    rsi1h: number[];
    timeMap: Map<number, number>;
  }

  const coinData: PrecomputedCoin[] = [];
  for (const sym of validSymbols) {
    const c15 = loadCandles(sym, 15);
    const c1h = loadCandles(sym, 60);
    if (c15.length < 500 || c1h.length < 200) continue;
    // Require symbol to have warmup data before windowStart and data through windowEnd
    if (c15[0]!.time > windowStart - 200 * 900 || c15.at(-1)!.time < windowEnd - 86400) continue;

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
  const penetration = (config.limitPenetrationPct ?? 0.10) / 100;
  const INITIAL_CAPITAL = 100.0;
  let cash = INITIAL_CAPITAL;

  interface ActivePosition {
    symbol: string;
    entryTime: number;
    entryPrice: number;
    allocatedCapital: number;
    qty: number;
    troughPrice: number;
    peakPrice: number;
    swingLow: number;
    lastKnownPrice: number;
  }

  let activePositions: ActivePosition[] = [];
  const completedTrades: CompletedTrade[] = [];
  let peakEquity = INITIAL_CAPITAL;
  let maxPortfolioDdPct = 0;

  interface CoinState {
    hadBottomFan: boolean;
    fanExpiryTime: number;
    waitingPullback: boolean;
    pullbackExpiryTime: number;
    waitFromTime: number;
    bottomSwingLow: number;
  }

  const coinStates = new Map<string, CoinState>();
  const p1Map = new Map<string, number>();
  for (const c of coinData) {
    coinStates.set(c.symbol, {
      hadBottomFan: false,
      fanExpiryTime: 0,
      waitingPullback: false,
      pullbackExpiryTime: 0,
      waitFromTime: 0,
      bottomSwingLow: Infinity,
    });
    p1Map.set(c.symbol, 0);
  }

  let pbBtc = 0;

  for (let t = windowStart; t <= windowEnd; t += 900) {
    const closeT = t + 900;

    // 0. Sync BTC 4H pointer using ONLY closed 4H candles at closeT
    while (pbBtc + 1 < btc4h.length && btc4h[pbBtc + 1]!.time + 14400 <= closeT) pbBtc++;
    const isBtcGatePassed = !config.btc4hAboveEma75 || (btc4h[pbBtc]!.close >= btc4hEma75[pbBtc]!);

    // 1. Update Active Positions & Evaluate Exits
    const surviving: ActivePosition[] = [];
    for (const pos of activePositions) {
      const coin = coinData.find((c) => c.symbol === pos.symbol)!;
      const idx = coin.timeMap.get(t);
      if (idx === undefined) {
        surviving.push(pos);
        continue;
      }

      const c = coin.c15[idx]!;
      pos.lastKnownPrice = c.close;
      pos.troughPrice = Math.min(pos.troughPrice, c.low);
      pos.peakPrice = Math.max(pos.peakPrice, c.high);

      let shouldExit = false;
      let exitReason = "";
      let exitPrice = c.close;

      if (config.stopLossMode === "SWING_LOW" && c.low <= pos.swingLow) {
        shouldExit = true;
        exitPrice = Math.min(c.open, pos.swingLow);
        exitReason = "SL_SWING_LOW";
      } else if (config.stopLossMode === "FIXED_5PCT" && c.low <= pos.entryPrice * 0.95) {
        shouldExit = true;
        exitPrice = Math.min(c.open, pos.entryPrice * 0.95);
        exitReason = "SL_FIXED_5PCT";
      } else if (config.stopLossMode === "MA8_CROSS_MA16_DOWN" && coin.m8[idx]! < coin.m16[idx]!) {
        shouldExit = true;
        exitPrice = c.close;
        exitReason = "MA8_CROSS_MA16_DOWN";
      }

      const isBullishFan =
        coin.m4[idx]! > coin.m8[idx]! &&
        coin.m8[idx]! > coin.m16[idx]! &&
        coin.m16[idx]! > coin.m25[idx]! &&
        coin.m25[idx]! > coin.m75[idx]! &&
        coin.m75[idx]! > coin.m200[idx]!;

      if (!shouldExit && isBullishFan) {
        shouldExit = true;
        exitPrice = c.close;
        exitReason = "FULL_BULLISH_FAN";
      }

      const holdHours = (t - pos.entryTime) / 3600;
      if (!shouldExit && config.maxHoldHours && holdHours >= config.maxHoldHours) {
        shouldExit = true;
        exitPrice = c.close;
        exitReason = "TIME_STOP";
      }

      if (shouldExit) {
        const proceeds = pos.qty * exitPrice * (1 - costPerFill);
        const netPnlQuote = proceeds - pos.allocatedCapital;
        const netPnlPct = (netPnlQuote / pos.allocatedCapital) * 100;
        const maePct = ((pos.troughPrice - pos.entryPrice) / pos.entryPrice) * 100;

        cash += proceeds;
        completedTrades.push({
          symbol: pos.symbol,
          entryTime: pos.entryTime,
          exitTime: t,
          entryPrice: pos.entryPrice,
          exitPrice,
          pnlQuote: netPnlQuote,
          pnlPct: netPnlPct,
          maePct,
          holdHours,
          exitReason,
          isForcedEndMtm: false,
        });

        const st = coinStates.get(pos.symbol)!;
        st.hadBottomFan = false;
        st.waitingPullback = false;
        st.bottomSwingLow = Infinity;
      } else {
        surviving.push(pos);
      }
    }
    activePositions = surviving;

    // 2. Always update coin setup states on every bar (even if slots are full)
    //    AND check resting limit fills using STRICTLY prior-bar values (idx - 1)
    interface CandidateEntry {
      symbol: string;
      entryPrice: number;
      barLow: number;
      barHigh: number;
      barClose: number;
      swingLow: number;
      priorScore: number; // Strictly known at idx - 1!
    }
    const candidates: CandidateEntry[] = [];

    for (const coin of coinData) {
      const idx = coin.timeMap.get(t);
      if (idx === undefined || idx < 200) continue;

      const st = coinStates.get(coin.symbol)!;
      const c = coin.c15[idx]!;
      const isAlreadyHeld = activePositions.some((p) => p.symbol === coin.symbol);

      // Sync Coin 1H pointer using ONLY closed 1H candles at closeT
      let p1 = p1Map.get(coin.symbol)!;
      while (p1 + 1 < coin.c1h.length && coin.c1h[p1 + 1]!.time + 3600 <= closeT) p1++;
      p1Map.set(coin.symbol, p1);

      // Step A: If waiting for pullback from a PRIOR bar, check if resting limit at m4[idx - 1] filled during bar idx
      // Note: At the start of bar idx, m8[idx-1] >= m16[idx-1] was valid. We CANNOT peek at m8[idx] to cancel a limit fill!
      if (!isAlreadyHeld && isBtcGatePassed && st.waitingPullback && t > st.waitFromTime && t <= st.pullbackExpiryTime) {
        const restingLimitPrice = coin.m4[idx - 1]!;
        const priorMomentumValid = coin.m8[idx - 1]! >= coin.m16[idx - 1]!;
        const requiredLow = restingLimitPrice * (1 - penetration);

        if (priorMomentumValid && c.low <= requiredLow) {
          const fillPrice = Math.min(c.open, restingLimitPrice);
          candidates.push({
            symbol: coin.symbol,
            entryPrice: fillPrice,
            barLow: c.low,
            barHigh: c.high,
            barClose: c.close,
            swingLow: st.bottomSwingLow,
            priorScore: coin.rsi15[idx - 1]!, // Strictly prior bar's RSI!
          });
        }
      }

      // Expire pullback if window elapsed or if MA8 crossed back below MA16 at end of bar idx
      if (st.waitingPullback && (t >= st.pullbackExpiryTime || coin.m8[idx]! < coin.m16[idx]!)) {
        st.waitingPullback = false;
      }

      // Step B: Update Bottom Fan & 8/16 Cross at the CLOSE of bar idx (for future bars > t)
      const isBottomFan =
        coin.m4[idx]! < coin.m8[idx]! &&
        coin.m8[idx]! < coin.m16[idx]! &&
        coin.m16[idx]! < coin.m25[idx]! &&
        coin.m25[idx]! < coin.m75[idx]! &&
        coin.m75[idx]! < coin.m200[idx]!;

      if (isBottomFan) {
        st.hadBottomFan = true;
        st.fanExpiryTime = t + 20 * 900;
        st.bottomSwingLow = Math.min(st.bottomSwingLow, c.low);
      }
      if (t > st.fanExpiryTime && !st.waitingPullback) {
        st.hadBottomFan = false;
        st.bottomSwingLow = Infinity;
      }

      const is8Cross16Up = coin.m8[idx - 1]! <= coin.m16[idx - 1]! && coin.m8[idx]! > coin.m16[idx]!;
      const is1hRsiPassed = !config.coin1hRsi40 || (coin.rsi1h[p1]! >= 40);

      if (!isAlreadyHeld && !st.waitingPullback && st.hadBottomFan && is8Cross16Up) {
        const rsiOk = coin.rsi15[idx]! >= 35 && coin.rsi15[idx]! > coin.rsi15[idx - 1]!;
        const macdOk = coin.macd15.hist[idx]! > coin.macd15.hist[idx - 1]!;
        if (rsiOk && macdOk && is1hRsiPassed && isBtcGatePassed) {
          st.waitingPullback = true;
          st.waitFromTime = t;
          st.pullbackExpiryTime = t + 12 * 900;
        }
      }
    }

    // 3. Fill Available Slots (Fixed Equal-Slot Sizing based on cash / remainingSlots)
    const availableSlots = config.maxSlots - activePositions.length;
    if (availableSlots > 0 && isBtcGatePassed && candidates.length > 0) {
      candidates.sort((a, b) => b.priorScore - a.priorScore);
      const toFill = candidates.slice(0, availableSlots);

      for (let k = 0; k < toFill.length; k++) {
        const cand = toFill[k]!;
        const remainingEmptySlots = config.maxSlots - activePositions.length;
        const capitalToUse = cash / remainingEmptySlots;
        if (capitalToUse < 5) continue;

        const entryCost = capitalToUse * (1 - costPerFill);
        const qty = entryCost / cand.entryPrice;
        cash -= capitalToUse;

        // Track intra-bar adverse excursion on the entry bar itself!
        const entryBarTrough = Math.min(cand.entryPrice, cand.barLow);
        const entryBarPeak = Math.max(cand.entryPrice, cand.barHigh);

        activePositions.push({
          symbol: cand.symbol,
          entryTime: t,
          entryPrice: cand.entryPrice,
          allocatedCapital: capitalToUse,
          qty,
          troughPrice: entryBarTrough,
          peakPrice: entryBarPeak,
          swingLow: cand.swingLow,
          lastKnownPrice: cand.barClose,
        });

        const st = coinStates.get(cand.symbol)!;
        st.waitingPullback = false;
        st.hadBottomFan = false;
      }
    }

    // 4. Mark-to-Market Portfolio Equity & Max Drawdown at end of bar t
    let currentOpenValue = 0;
    for (const pos of activePositions) {
      currentOpenValue += pos.qty * pos.lastKnownPrice * (1 - costPerFill);
    }
    const totalEquity = cash + currentOpenValue;
    if (totalEquity > peakEquity) peakEquity = totalEquity;
    const curDd = ((peakEquity - totalEquity) / peakEquity) * 100;
    if (curDd > maxPortfolioDdPct) maxPortfolioDdPct = curDd;
  }

  // 5. Force Mark-to-Market Liquidation of ALL Remaining Open Positions at windowEnd
  const stuckCount = activePositions.length;
  for (const pos of activePositions) {
    const exitPrice = pos.lastKnownPrice;
    const proceeds = pos.qty * exitPrice * (1 - costPerFill);
    const netPnlQuote = proceeds - pos.allocatedCapital;
    const netPnlPct = (netPnlQuote / pos.allocatedCapital) * 100;
    const maePct = ((pos.troughPrice - pos.entryPrice) / pos.entryPrice) * 100;
    const holdHours = (windowEnd - pos.entryTime) / 3600;

    cash += proceeds;
    completedTrades.push({
      symbol: pos.symbol,
      entryTime: pos.entryTime,
      exitTime: windowEnd,
      entryPrice: pos.entryPrice,
      exitPrice,
      pnlQuote: netPnlQuote,
      pnlPct: netPnlPct,
      maePct,
      holdHours,
      exitReason: "END_OF_PERIOD_MTM",
      isForcedEndMtm: true,
    });
  }
  activePositions = [];

  const finalEquity = cash;
  const netPnlQuote = finalEquity - INITIAL_CAPITAL;
  const netPnlPct = (netPnlQuote / INITIAL_CAPITAL) * 100;
  const wins = completedTrades.filter((t) => t.pnlPct > 0).length;
  const winRate = completedTrades.length > 0 ? (wins / completedTrades.length) * 100 : 0;
  const grossWin = completedTrades.filter((t) => t.pnlQuote > 0).reduce((a, b) => a + b.pnlQuote, 0);
  const grossLoss = Math.abs(completedTrades.filter((t) => t.pnlQuote < 0).reduce((a, b) => a + b.pnlQuote, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : 0;
  const avgHold = completedTrades.length > 0 ? completedTrades.reduce((a, b) => a + b.holdHours, 0) / completedTrades.length : 0;
  const avgMae = completedTrades.length > 0 ? completedTrades.reduce((a, b) => a + b.maePct, 0) / completedTrades.length : 0;
  const worstMae = completedTrades.length > 0 ? Math.min(...completedTrades.map((t) => t.maePct)) : 0;

  return {
    configName: config.name,
    universeCount: coinData.length,
    tradesCount: completedTrades.length,
    stuckCount,
    winRate,
    netPnlPct,
    netPnlQuote,
    profitFactor,
    maxPortfolioDdPct,
    avgHoldHours: avgHold,
    avgMaePct: avgMae,
    worstMaePct: worstMae,
    completedTrades,
  };
}

function computeBenchmarks(symbols: string[], startT: number, endT: number) {
  const getReturn = (sym: string) => {
    const c = loadCandles(sym, 15);
    const first = c.find((x) => x.time >= startT);
    let last: Candle | undefined;
    for (let i = c.length - 1; i >= 0; i--) {
      if (c[i]!.time <= endT) { last = c[i]!; break; }
    }
    if (!first || !last || first.time >= last.time) return null;
    return ((last.close - first.close) / first.close) * 100;
  };

  const btcRet = getReturn("BTCUSDT") ?? 0;
  let sum = 0, cnt = 0;
  for (const s of symbols) {
    const r = getReturn(s);
    if (r !== null) { sum += r; cnt++; }
  }
  return { btcRet, marketRet: cnt > 0 ? sum / cnt : 0, cnt };
}

async function main() {
  const allFiles = fs.readdirSync(path.resolve(process.cwd(), "data/cache/klines"))
    .filter((f) => f.endsWith("USDT_5m.json"))
    .map((f) => f.replace("_5m.json", ""))
    .filter((s) => !BLACKLIST.has(s));

  const btc15 = loadCandles("BTCUSDT", 15);
  const fullStart = btc15[0]!.time + 320 * 3600;
  const fullEnd = btc15.at(-1)!.time;
  const midPoint = Math.floor(((fullStart + fullEnd) / 2) / 900) * 900;

  const configs: PortfolioConfig[] = [
    { name: "E-1Slot (BTC 4H Gate)", maxSlots: 1, btc4hAboveEma75: true, coin1hRsi40: false, stopLossMode: "NONE" },
    { name: "F-1Slot (BTC 4H + 1H RSI>=40)", maxSlots: 1, btc4hAboveEma75: true, coin1hRsi40: true, stopLossMode: "NONE" },
    { name: "E-3Slots (BTC 4H Gate)", maxSlots: 3, btc4hAboveEma75: true, coin1hRsi40: false, stopLossMode: "NONE" },
    { name: "F-3Slots (BTC 4H + 1H RSI>=40)", maxSlots: 3, btc4hAboveEma75: true, coin1hRsi40: true, stopLossMode: "NONE" },
    { name: "E-5Slots (BTC 4H Gate)", maxSlots: 5, btc4hAboveEma75: true, coin1hRsi40: false, stopLossMode: "NONE" },
    { name: "F-5Slots (BTC 4H + 1H RSI>=40)", maxSlots: 5, btc4hAboveEma75: true, coin1hRsi40: true, stopLossMode: "NONE" },
    { name: "F-3Slots + 5% SL", maxSlots: 3, btc4hAboveEma75: true, coin1hRsi40: true, stopLossMode: "FIXED_5PCT" },
    { name: "F-3Slots + SwingLow SL", maxSlots: 3, btc4hAboveEma75: true, coin1hRsi40: true, stopLossMode: "SWING_LOW" },
  ];

  const windows = [
    { label: "1. FULL 110 DAYS (19 Full-History Coins)", start: fullStart, end: fullEnd },
    { label: "2. IN-SAMPLE H1: First 55 Days (2026-07-14 -> 2026-09-08)", start: fullStart, end: midPoint },
    { label: "3. OUT-OF-SAMPLE H2: Last 55 Days (2026-09-08 -> 2026-11-02)", start: midPoint, end: fullEnd },
    { label: "4. BROAD UNIVERSE: Last 18 Days (58 Coins with 32d Cache)", start: fullEnd - 18 * 86400, end: fullEnd },
  ];

  for (const w of windows) {
    const bm = computeBenchmarks(allFiles, w.start, w.end);
    console.log(`\n================================================================================`);
    console.log(`   ${w.label}`);
    console.log(`   Period: ${new Date(w.start * 1000).toISOString().slice(0, 10)} -> ${new Date(w.end * 1000).toISOString().slice(0, 10)} | BTC B&H: ${bm.btcRet >= 0 ? "+" : ""}${bm.btcRet.toFixed(2)}% | Eq-Weight Market: ${bm.marketRet >= 0 ? "+" : ""}${bm.marketRet.toFixed(2)}%`);
    console.log(`================================================================================`);

    const rows = configs.map((cfg) => {
      const r = runPortfolioSimulation(cfg, allFiles, w.start, w.end);
      return {
        Model: r.configName,
        Coins: r.universeCount,
        "Trades (Stuck)": `${r.tradesCount} (${r.stuckCount})`,
        WinRate: `${r.winRate.toFixed(1)}%`,
        NetPnL: `${r.netPnlPct >= 0 ? "+" : ""}${r.netPnlPct.toFixed(2)}%`,
        MaxDD: `-${r.maxPortfolioDdPct.toFixed(1)}%`,
        PF: r.profitFactor > 50 ? ">50" : r.profitFactor.toFixed(2),
        AvgMAE: `${r.avgMaePct.toFixed(2)}%`,
        WorstMAE: `${r.worstMaePct.toFixed(2)}%`,
        AvgHold: `${r.avgHoldHours.toFixed(1)}h`,
      };
    });
    console.table(rows);
  }
}

if (process.argv[1]?.includes("test-portfolio-ma-fan")) {
  main().catch(console.error);
}
