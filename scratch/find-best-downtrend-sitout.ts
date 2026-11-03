import fs from "fs";
import path from "path";
import { Candle } from "../src/types.js";
import { calcEMA } from "../src/strategy/ma-fan/ribbon.js";
import { calcRSI, calcMACD } from "../src/strategy/ma-fan/exhaustion.js";
import { BacktestService } from "../src/backtest-service.js";

const CACHE_DIR = path.join(process.cwd(), "data", "cache", "klines");
const BLACKLIST = new Set([
  "BFUSDUSDT", "USDEUSDT", "RWUSDUSDT", "UUSDT", "??USDT",
  "GOOGLBUSDT", "INTCBUSDT", "MSTRBUSDT", "QQQBUSDT", "SKHYBUSDT",
  "SNDKBUSDT", "SOXLBUSDT", "SPCXBUSDT", "TQQQBUSDT", "CRCLBUSDT", "PAXGUSDT", "XAUTUSDT"
]);

function loadUniverse(minBars: number) {
  const files = fs.readdirSync(CACHE_DIR).filter((f) => f.endsWith("USDT_5m.json"));
  const universe: { symbol: string; candles: Candle[] }[] = [];
  let btcCandles: Candle[] = [];

  for (const file of files) {
    const symbol = file.replace("_5m.json", "");
    if (BLACKLIST.has(symbol)) continue;
    const parsed = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, file), "utf8"));
    const raw: Candle[] = Array.isArray(parsed) ? parsed : parsed.candles;
    if (!raw || raw.length < minBars) continue;

    if (symbol === "BTCUSDT") btcCandles = raw;
    universe.push({ symbol, candles: raw });
  }

  return { universe, btcCandles };
}

function resample(candles5m: Candle[], sec: number): Candle[] {
  const out: Candle[] = [];
  let cur: Candle | null = null;
  for (const c of candles5m) {
    const bk = Math.floor(c.time / sec) * sec;
    if (!cur || cur.time !== bk) {
      if (cur) out.push(cur);
      cur = { time: bk, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
    } else {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      cur.volume += c.volume;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function getClosedIdx(arr: Candle[], durationSec: number, targetSec: number) {
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].time + durationSec <= targetSec) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

interface GateFilter {
  name: string;
  check: (macro: {
    t: number;
    b25: number;
    b75: number;
    btc4hClose: number;
    btc4hEma75: number;
    btc4hEma200: number;
    btc1dClose: number;
    btc1dEma25: number;
  }) => boolean;
}

function runSimulatorWithGate(
  universe: { symbol: string; candles: Candle[] }[],
  btcCandles: Candle[],
  gate: GateFilter,
  useStagedExit = false
) {
  const costPerFill = (0.075 + 0.01) / 100;
  const penetration = 0.10 / 100;
  const maxSlots = 3;
  let cash = 100;

  interface CoinPrecalc {
    symbol: string;
    c15: Candle[];
    timeMap15: Map<number, number>;
    m4: number[];
    m8: number[];
    m16: number[];
    m25: number[];
    m75: number[];
    m200: number[];
    rsi15: number[];
    macdHist15: number[];
    c1h: Candle[];
    rsi1h: number[];
  }

  const precalc: CoinPrecalc[] = [];
  for (const u of universe) {
    if (!u.candles || u.candles.length < 500) continue;
    const c15 = BacktestService.aggregateCandles(u.candles, 15);
    if (c15.length < 220) continue;
    const closes15 = c15.map((c) => c.close);
    const timeMap15 = new Map<number, number>();
    c15.forEach((c, idx) => timeMap15.set(c.time, idx));

    const c1h = BacktestService.aggregateCandles(u.candles, 60);

    precalc.push({
      symbol: u.symbol,
      c15,
      timeMap15,
      m4: calcEMA(closes15, 4),
      m8: calcEMA(closes15, 8),
      m16: calcEMA(closes15, 16),
      m25: calcEMA(closes15, 25),
      m75: calcEMA(closes15, 75),
      m200: calcEMA(closes15, 200),
      rsi15: calcRSI(c15, 14),
      macdHist15: calcMACD(c15).hist,
      c1h,
      rsi1h: calcRSI(c1h, 14),
    });
  }

  const btc4h = resample(btcCandles, 14400);
  const btc4hCloses = btc4h.map((c) => c.close);
  const btc4hEma75 = calcEMA(btc4hCloses, 75);
  const btc4hEma200 = calcEMA(btc4hCloses, 200);

  const btc1d = resample(btcCandles, 86400);
  const btc1dCloses = btc1d.map((c) => c.close);
  const btc1dEma25 = calcEMA(btc1dCloses, 25);

  const btc15 = BacktestService.aggregateCandles(btcCandles, 15);
  const btcTimeMap = new Map<number, number>();
  btc15.forEach((c, idx) => btcTimeMap.set(c.time, idx));

  const startT = Math.max(...precalc.map((c) => c.c15[220]?.time ?? 0), btc15[220]?.time ?? 0);
  const endT = Math.min(...precalc.map((c) => c.c15[c.c15.length - 1]?.time ?? Infinity), btc15[btc15.length - 1]?.time ?? Infinity);

  let allowedBars = 0;
  let totalBars = 0;

  // Active Positions
  interface ActivePos {
    symbol: string;
    entryTime: number;
    entryPrice: number;
    allocatedCapital: number;
    qty: number;
    troughPrice: number;
    peakPrice: number;
    lastKnownPrice: number;
    beLocked: boolean;
    tp1Done: boolean;
    realizedProceeds: number;
  }

  let activePositions: ActivePos[] = [];
  const completedTrades: {
    symbol: string;
    entryTime: number;
    exitTime: number;
    pnlPct: number;
    isWin: boolean;
    exitReason: string;
  }[] = [];

  let peakEquity = 100;
  let maxDdPct = 0;

  interface CoinSetupState {
    hadBottomFan: boolean;
    fanExpiryTime: number;
    waitingPullback: boolean;
    pullbackExpiryTime: number;
    waitFromTime: number;
    bottomLow: number;
  }

  const states = new Map<string, CoinSetupState>();
  for (const c of precalc) {
    states.set(c.symbol, {
      hadBottomFan: false,
      fanExpiryTime: 0,
      waitingPullback: false,
      pullbackExpiryTime: 0,
      waitFromTime: 0,
      bottomLow: Infinity,
    });
  }

  for (let t = startT; t <= endT; t += 900) {
    totalBars++;
    // Check gate strictly at closed candle before t
    const b4hIdx = getClosedIdx(btc4h, 14400, t);
    const b1dIdx = getClosedIdx(btc1d, 86400, t);

    let a25 = 0, a75 = 0, tot = 0;
    for (const c of precalc) {
      if (c.symbol === "BTCUSDT") continue;
      const idx = c.timeMap15.get(t);
      if (idx !== undefined && idx > 200) {
        tot++;
        if (c.c15[idx - 1].close > c.m25[idx - 1]) a25++;
        if (c.c15[idx - 1].close > c.m75[idx - 1]) a75++;
      }
    }

    const macro = {
      t,
      b25: tot > 0 ? (a25 / tot) * 100 : 50,
      b75: tot > 0 ? (a75 / tot) * 100 : 50,
      btc4hClose: b4hIdx >= 0 ? btc4h[b4hIdx].close : 0,
      btc4hEma75: b4hIdx >= 75 ? btc4hEma75[b4hIdx] : 0,
      btc4hEma200: b4hIdx >= 200 ? btc4hEma200[b4hIdx] : 0,
      btc1dClose: b1dIdx >= 0 ? btc1d[b1dIdx].close : 0,
      btc1dEma25: b1dIdx >= 25 ? btc1dEma25[b1dIdx] : 0,
    };

    const isGateOpen = gate.check(macro);
    if (isGateOpen) allowedBars++;

    // 1. Manage existing positions
    const surviving: ActivePos[] = [];
    for (const pos of activePositions) {
      const coin = precalc.find((c) => c.symbol === pos.symbol)!;
      const idx = coin.timeMap15.get(t);
      if (idx === undefined) {
        surviving.push(pos);
        continue;
      }
      const c = coin.c15[idx];
      pos.lastKnownPrice = c.close;
      pos.troughPrice = Math.min(pos.troughPrice, c.low);
      pos.peakPrice = Math.max(pos.peakPrice, c.high);

      let shouldClose = false;
      let exitPrice = c.close;
      let exitReason = "TIME_STOP";

      // Disaster SL 12%
      if (c.low <= pos.entryPrice * 0.88) {
        shouldClose = true;
        exitPrice = Math.min(c.open, pos.entryPrice * 0.88);
        exitReason = "SL_DISASTER_12%";
      }

      // Staged Exit / Breakeven
      if (useStagedExit) {
        if (!shouldClose && pos.beLocked && c.low <= pos.entryPrice * 1.0025) {
          shouldClose = true;
          exitPrice = Math.min(c.open, pos.entryPrice * 1.0025);
          exitReason = "SL_BREAKEVEN";
        }

        const ema200Target = Math.max(coin.m200[idx], pos.entryPrice * 1.008);
        if (!shouldClose && c.high >= ema200Target) {
          pos.beLocked = true;
          if (!pos.tp1Done) {
            pos.tp1Done = true;
            const halfQty = pos.qty * 0.5;
            const proceedsHalf = halfQty * ema200Target * (1 - costPerFill);
            cash += proceedsHalf;
            pos.realizedProceeds += proceedsHalf;
            pos.qty -= halfQty;
          }
        }
      }

      // Bullish Fan exit
      const isBullishFan =
        coin.m4[idx] > coin.m8[idx] &&
        coin.m8[idx] > coin.m16[idx] &&
        coin.m16[idx] > coin.m25[idx] &&
        coin.m25[idx] > coin.m75[idx] &&
        coin.m75[idx] > coin.m200[idx];

      if (!shouldClose && isBullishFan) {
        shouldClose = true;
        exitPrice = c.close;
        exitReason = "FULL_BULLISH_FAN";
      }

      if (shouldClose) {
        const finalProceeds = pos.qty * exitPrice * (1 - costPerFill);
        cash += finalProceeds;
        const totalProceeds = pos.realizedProceeds + finalProceeds;
        const netPnlPct = ((totalProceeds - pos.allocatedCapital) / pos.allocatedCapital) * 100;
        completedTrades.push({
          symbol: pos.symbol,
          entryTime: pos.entryTime,
          exitTime: t,
          pnlPct: netPnlPct,
          isWin: netPnlPct > 0,
          exitReason,
        });
      } else {
        surviving.push(pos);
      }
    }
    activePositions = surviving;

    // Track Equity & Max Drawdown
    let currentEquity = cash;
    for (const pos of activePositions) {
      currentEquity += pos.realizedProceeds + pos.qty * pos.lastKnownPrice * (1 - costPerFill);
    }
    if (currentEquity > peakEquity) peakEquity = currentEquity;
    const curDd = ((peakEquity - currentEquity) / peakEquity) * 100;
    if (curDd > maxDdPct) maxDdPct = curDd;

    // 2. Setup tracking for candidates
    for (const coin of precalc) {
      const idx = coin.timeMap15.get(t);
      if (idx === undefined || idx < 200) continue;
      const st = states.get(coin.symbol)!;

      const isBottomFan =
        coin.m4[idx] < coin.m8[idx] &&
        coin.m8[idx] < coin.m16[idx] &&
        coin.m16[idx] < coin.m25[idx] &&
        coin.m25[idx] < coin.m75[idx] &&
        coin.m75[idx] < coin.m200[idx];

      if (isBottomFan) {
        st.hadBottomFan = true;
        st.fanExpiryTime = t + 24 * 3600;
        st.bottomLow = Math.min(st.bottomLow, coin.c15[idx].low);
      } else if (t > st.fanExpiryTime) {
        st.hadBottomFan = false;
        st.bottomLow = Infinity;
      }

      const p4 = coin.m4[idx] > coin.m8[idx];
      const p8 = coin.m8[idx] > coin.m16[idx];
      const p16 = coin.m16[idx] > coin.m25[idx];
      const fanOpeningUp = (p4 ? 1 : 0) + (p8 ? 1 : 0) + (p16 ? 1 : 0) >= 2;

      if (st.hadBottomFan && !st.waitingPullback && fanOpeningUp) {
        st.waitingPullback = true;
        st.pullbackExpiryTime = t + 12 * 3600;
        st.waitFromTime = t;
      } else if (t > st.pullbackExpiryTime) {
        st.waitingPullback = false;
      }
    }

    // 3. Check Entries if Gate is OPEN and slots available
    const openSlots = maxSlots - activePositions.length;
    if (isGateOpen && openSlots > 0) {
      const candidates: { symbol: string; score: number; limitPrice: number }[] = [];

      for (const coin of precalc) {
        if (activePositions.some((p) => p.symbol === coin.symbol)) continue;
        const idx = coin.timeMap15.get(t);
        if (idx === undefined || idx < 200) continue;
        const st = states.get(coin.symbol)!;
        if (!st.waitingPullback) continue;

        const c = coin.c15[idx];
        const m4 = coin.m4[idx];
        const m8 = coin.m8[idx];
        const m16 = coin.m16[idx];
        const m25 = coin.m25[idx];
        const m75 = coin.m75[idx];
        const m200 = coin.m200[idx];

        // 1H RSI >= 40 check
        const idx1h = getClosedIdx(coin.c1h, 3600, t);
        if (idx1h >= 0 && coin.rsi1h[idx1h] < 40) continue;

        // Buyer volume absorption >= 1.3
        let upV = 0, dnV = 0;
        for (let k = Math.max(0, idx - 11); k <= idx; k++) {
          if (coin.c15[k].close >= coin.c15[k].open) upV += coin.c15[k].volume;
          else dnV += coin.c15[k].volume;
        }
        if (dnV > 0 && upV / dnV < 1.3) continue;

        // Pullback into ribbon
        const ribbonTop = Math.max(m4, m8, m16, m25);
        const ribbonBottom = Math.min(m4, m8, m16, m25);
        const touchesRibbon = c.low <= ribbonTop && c.high >= ribbonBottom;
        const aboveSupport = c.close >= ribbonBottom * 0.995;
        if (!touchesRibbon || !aboveSupport) continue;

        const limitPrice = ribbonTop;
        const canFill = c.low <= limitPrice * (1 + penetration);
        if (!canFill) continue;

        const score = 100 - coin.rsi15[idx] + coin.macdHist15[idx] * 10;
        candidates.push({ symbol: coin.symbol, score, limitPrice });
      }

      candidates.sort((a, b) => b.score - a.score);
      const chosen = candidates.slice(0, openSlots);

      for (const ch of chosen) {
        const coin = precalc.find((c) => c.symbol === ch.symbol)!;
        const idx = coin.timeMap15.get(t)!;
        const c = coin.c15[idx];
        const fillPrice = ch.limitPrice;
        const currentCap = cash / (maxSlots - activePositions.length);
        const alloc = Math.min(cash, currentCap);
        if (alloc < 5) continue;

        const effectiveCost = fillPrice * (1 + costPerFill);
        const qty = alloc / effectiveCost;
        cash -= alloc;

        activePositions.push({
          symbol: ch.symbol,
          entryTime: t,
          entryPrice: fillPrice,
          allocatedCapital: alloc,
          qty,
          troughPrice: Math.min(c.low, fillPrice),
          peakPrice: Math.max(c.high, fillPrice),
          lastKnownPrice: c.close,
          beLocked: false,
          tp1Done: false,
          realizedProceeds: 0,
        });

        const st = states.get(ch.symbol)!;
        st.waitingPullback = false;
        st.hadBottomFan = false;
      }
    }
  }

  // Close remaining active positions at end
  for (const pos of activePositions) {
    const finalProceeds = pos.qty * pos.lastKnownPrice * (1 - costPerFill);
    cash += finalProceeds;
    const totalProceeds = pos.realizedProceeds + finalProceeds;
    const netPnlPct = ((totalProceeds - pos.allocatedCapital) / pos.allocatedCapital) * 100;
    completedTrades.push({
      symbol: pos.symbol,
      entryTime: pos.entryTime,
      exitTime: endT,
      pnlPct: netPnlPct,
      isWin: netPnlPct > 0,
      exitReason: "END_OF_SIM",
    });
  }

  const finalEquity = cash;
  const netPnlPct = ((finalEquity - 100) / 100) * 100;
  const totalTrades = completedTrades.length;
  const wins = completedTrades.filter((t) => t.isWin).length;
  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  const grossWin = completedTrades.filter((t) => t.pnlPct > 0).reduce((s, t) => s + t.pnlPct, 0);
  const grossLoss = Math.abs(completedTrades.filter((t) => t.pnlPct < 0).reduce((s, t) => s + t.pnlPct, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0;
  const activePct = totalBars > 0 ? (allowedBars / totalBars) * 100 : 0;
  const sitOutPct = 100 - activePct;

  return {
    netPnlPct,
    maxDdPct,
    totalTrades,
    winRate,
    pf,
    activePct,
    sitOutPct,
  };
}

function runComparison() {
  const { universe: uni68, btcCandles } = loadUniverse(9000);
  const { universe: uni19 } = loadUniverse(30000);

  const gates: GateFilter[] = [
    {
      name: "1. No Gate (Trade 100% of the time)",
      check: () => true,
    },
    {
      name: "2. BTC 4H >= EMA 75",
      check: (m) => m.btc4hClose >= m.btc4hEma75,
    },
    {
      name: "3. BTC 4H >= EMA 200",
      check: (m) => m.btc4hClose >= m.btc4hEma200,
    },
    {
      name: "4. BTC 1D >= EMA 25",
      check: (m) => m.btc1dClose >= m.btc1dEma25,
    },
    {
      name: "5. Altcoin Breadth 25 >= 45%",
      check: (m) => m.b25 >= 45,
    },
    {
      name: "6. Altcoin Breadth 25 >= 50%",
      check: (m) => m.b25 >= 50,
    },
    {
      name: "7. Dual Gate: BTC 4H >= EMA 75 AND Breadth 25 >= 40%",
      check: (m) => m.btc4hClose >= m.btc4hEma75 && m.b25 >= 40,
    },
    {
      name: "8. Dual Gate: BTC 1D >= EMA 25 AND Breadth 25 >= 40%",
      check: (m) => m.btc1dClose >= m.btc1dEma25 && m.b25 >= 40,
    },
  ];

  console.log("\n====================================================================================================");
  console.log("TESTING DOWNTREND SIT-OUT GATES (STAGED EXIT: TP1 @ EMA200 + BREAKEVEN + RUNNER)");
  console.log("====================================================================================================");

  console.log("\n--- DATASET A: RECENT 33 DAYS (DOWNTREND SLUMP, BTC -7.71%) ---");
  for (const g of gates) {
    const res = runSimulatorWithGate(uni68, btcCandles, g, true);
    console.log(
      `${g.name.padEnd(52)} | Ret: ${(res.netPnlPct >= 0 ? "+" : "") + res.netPnlPct.toFixed(2)}% | MaxDD: -${res.maxDdPct.toFixed(2)}% | Trades: ${res.totalTrades.toString().padStart(3)} | WR: ${res.winRate.toFixed(1)}% | SitOut: ${res.sitOutPct.toFixed(1)}%`
    );
  }

  console.log("\n--- DATASET B: FULL 122 DAYS (BULL + RANGING + DOWNTREND, BTC +23.18%) ---");
  for (const g of gates) {
    const res = runSimulatorWithGate(uni19, btcCandles, g, true);
    console.log(
      `${g.name.padEnd(52)} | Ret: ${(res.netPnlPct >= 0 ? "+" : "") + res.netPnlPct.toFixed(2)}% | MaxDD: -${res.maxDdPct.toFixed(2)}% | Trades: ${res.totalTrades.toString().padStart(3)} | WR: ${res.winRate.toFixed(1)}% | SitOut: ${res.sitOutPct.toFixed(1)}%`
    );
  }
}

runComparison();
