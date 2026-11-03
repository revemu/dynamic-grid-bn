import fs from "fs";
import path from "path";
import { Candle } from "../src/types.js";
import { calcEMA } from "../src/strategy/ma-fan/ribbon.js";
import { calcRSI, calcMACD } from "../src/strategy/ma-fan/exhaustion.js";

const CACHE_DIR = path.join(process.cwd(), "data", "cache", "klines");
const BLACKLIST = new Set([
  "BFUSDUSDT", "USDEUSDT", "RWUSDUSDT", "UUSDT", "??USDT",
  "GOOGLBUSDT", "INTCBUSDT", "MSTRBUSDT", "QQQBUSDT", "SKHYBUSDT",
  "SNDKBUSDT", "SOXLBUSDT", "SPCXBUSDT", "TQQQBUSDT", "CRCLBUSDT", "PAXGUSDT", "XAUTUSDT"
]);

function resampleCandles(candles5m: Candle[], intervalMinutes: number): Candle[] {
  const bucketSec = intervalMinutes * 60;
  const out: Candle[] = [];
  let cur: Candle | null = null;
  for (const c of candles5m) {
    const bucketTime = Math.floor(c.time / bucketSec) * bucketSec;
    if (!cur || cur.time !== bucketTime) {
      if (cur) out.push(cur);
      cur = { time: bucketTime, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
    } else {
      if (c.high > cur.high) cur.high = c.high;
      if (c.low < cur.low) cur.low = c.low;
      cur.close = c.close;
      cur.volume += c.volume;
    }
  }
  if (cur) out.push(cur);
  return out;
}

interface CoinData {
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
  m200_1h: number[];
  rsi1h: number[];
}

function loadUniverse(min5mBars: number) {
  const files = fs.readdirSync(CACHE_DIR).filter((f) => f.endsWith("USDT_5m.json"));
  const coins: CoinData[] = [];

  for (const file of files) {
    const symbol = file.replace("_5m.json", "");
    if (BLACKLIST.has(symbol)) continue;
    const parsed = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, file), "utf8"));
    const raw: Candle[] = Array.isArray(parsed) ? parsed : parsed.candles;
    if (!raw || raw.length < min5mBars) continue;

    const c15 = resampleCandles(raw, 15);
    const closes15 = c15.map((c) => c.close);
    const timeMap15 = new Map<number, number>();
    c15.forEach((c, idx) => timeMap15.set(c.time, idx));

    const c1h = resampleCandles(raw, 60);
    const closes1h = c1h.map((c) => c.close);

    coins.push({
      symbol,
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
      m200_1h: calcEMA(closes1h, 200),
      rsi1h: calcRSI(c1h, 14),
    });
  }

  const startT = Math.max(...coins.map((c) => c.c15[220].time));
  const endT = Math.min(...coins.map((c) => c.c15[c.c15.length - 1].time));
  return { coins, startT, endT };
}

interface SimConfig {
  name: string;
  maxSlots: number;
  // Macro Gate options (strictly prior bar)
  minBreadth25Pct?: number;
  requireBtcNotDumping?: boolean; // BTC 4h return >= -1.2% & BTC > 24h SMA * 0.99
  requireCoin1hRsi40?: boolean;   // Coin closed 1H RSI >= 40
  // MA Fan Entry Quality Filters (strictly prior bar idx - 1)
  minBuyVolRatio12?: number;      // UpVol / DnVol over prior 12 bars >= X
  minRelStrengthVsBtc24h?: number;// 24h return vs BTC >= X%
  maxUpperRibbonSpreadPct?: number; // (EMA200 - EMA75)/EMA200 * 100 <= X%
  // Ranking mode when multiple coins trigger on the same bar
  rankBy?: "RSI15" | "COMPOSITE_QUALITY";
  // Exit & Risk Protection enhancements
  lockBeAtEma200?: boolean;       // Once High >= EMA200 (and > Entry*1.006), lock Breakeven SL at Entry*1.0025
  partialTpAtEma200?: boolean;    // Sell 50% at EMA200 (when > Entry*1.008) + lock Breakeven SL, hold 50% for Full Bullish Fan
  maxDisasterSlPct?: number;      // Hard catastrophe SL (e.g. 6.0% or 8.0%)
  maxHoldHours?: number;          // Time stop if stuck
}

function runPortfolioSim(
  coins: CoinData[],
  startT: number,
  endT: number,
  macroMap: Map<number, { b25: number; btcNotDumping: boolean; btcRet24h: number }>,
  cfg: SimConfig
) {
  const costPerFill = (0.075 + 0.01) / 100; // 0.085% per side
  const INITIAL_CAPITAL = 100.0;
  let cash = INITIAL_CAPITAL;

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
  const completedTrades: { pnlPct: number; maePct: number; holdHours: number; isWin: boolean; time: number }[] = [];
  let peakEquity = INITIAL_CAPITAL;
  let maxDdPct = 0;

  interface CoinState {
    hadBottomFan: boolean;
    fanExpiryTime: number;
    waitingPullback: boolean;
    pullbackExpiryTime: number;
    waitFromTime: number;
    bottomLow: number;
  }

  const states = new Map<string, CoinState>();
  const p1Map = new Map<string, number>();
  for (const c of coins) {
    states.set(c.symbol, {
      hadBottomFan: false,
      fanExpiryTime: 0,
      waitingPullback: false,
      pullbackExpiryTime: 0,
      waitFromTime: 0,
      bottomLow: Infinity,
    });
    p1Map.set(c.symbol, 0);
  }

  for (let t = startT; t <= endT; t += 900) {
    const closeT = t + 900;

    // 1. Update Active Positions
    const surviving: ActivePos[] = [];
    for (const pos of activePositions) {
      const coin = coins.find((c) => c.symbol === pos.symbol)!;
      const idx = coin.timeMap15.get(t);
      if (idx === undefined) {
        surviving.push(pos);
        continue;
      }
      const c = coin.c15[idx];
      pos.lastKnownPrice = c.close;
      pos.troughPrice = Math.min(pos.troughPrice, c.low);
      pos.peakPrice = Math.max(pos.peakPrice, c.high);

      let shouldCloseAll = false;
      let exitPrice = c.close;

      // Check Disaster SL first
      if (cfg.maxDisasterSlPct && c.low <= pos.entryPrice * (1 - cfg.maxDisasterSlPct / 100)) {
        shouldCloseAll = true;
        exitPrice = Math.min(c.open, pos.entryPrice * (1 - cfg.maxDisasterSlPct / 100));
      }

      // Check Locked Breakeven Stop (from a PRIOR or earlier touch of EMA200)
      if (!shouldCloseAll && pos.beLocked && c.low <= pos.entryPrice * 1.0025) {
        shouldCloseAll = true;
        exitPrice = Math.min(c.open, pos.entryPrice * 1.0025);
      }

      // Check if current bar reaches EMA200 in profit (>= +0.8%)
      const ema200Target = Math.max(coin.m200[idx], pos.entryPrice * 1.008);
      if (!shouldCloseAll && c.high >= ema200Target) {
        if (cfg.lockBeAtEma200) {
          pos.beLocked = true;
        }
        if (cfg.partialTpAtEma200 && !pos.tp1Done) {
          pos.tp1Done = true;
          pos.beLocked = true;
          const halfQty = pos.qty * 0.5;
          const proceedsHalf = halfQty * ema200Target * (1 - costPerFill);
          cash += proceedsHalf;
          pos.realizedProceeds += proceedsHalf;
          pos.qty -= halfQty;
        }
      }

      // Check Full Bullish Fan (4 > 8 > 16 > 25 > 75 > 200)
      const isBullishFan =
        coin.m4[idx] > coin.m8[idx] &&
        coin.m8[idx] > coin.m16[idx] &&
        coin.m16[idx] > coin.m25[idx] &&
        coin.m25[idx] > coin.m75[idx] &&
        coin.m75[idx] > coin.m200[idx];

      if (!shouldCloseAll && isBullishFan) {
        shouldCloseAll = true;
        exitPrice = c.close;
      }

      const holdHours = (t - pos.entryTime) / 3600;
      if (!shouldCloseAll && cfg.maxHoldHours && holdHours >= cfg.maxHoldHours) {
        shouldCloseAll = true;
        exitPrice = c.close;
      }

      if (shouldCloseAll) {
        const finalProceeds = pos.qty * exitPrice * (1 - costPerFill);
        cash += finalProceeds;
        const totalProceeds = pos.realizedProceeds + finalProceeds;
        const netPnlPct = ((totalProceeds - pos.allocatedCapital) / pos.allocatedCapital) * 100;
        const maePct = ((pos.troughPrice - pos.entryPrice) / pos.entryPrice) * 100;
        completedTrades.push({
          pnlPct: netPnlPct,
          maePct,
          holdHours,
          isWin: netPnlPct > 0,
          time: pos.entryTime,
        });
        const st = states.get(pos.symbol)!;
        st.hadBottomFan = false;
        st.waitingPullback = false;
        st.bottomLow = Infinity;
      } else {
        surviving.push(pos);
      }
    }
    activePositions = surviving;

    // 2. Scan for Candidate Fills (strictly using prior bar `idx - 1`)
    const macro = macroMap.get(t)!;
    const isMacroOk =
      (cfg.minBreadth25Pct === undefined || macro.b25 >= cfg.minBreadth25Pct) &&
      (!cfg.requireBtcNotDumping || macro.btcNotDumping);

    interface Cand {
      symbol: string;
      entryPrice: number;
      barLow: number;
      barHigh: number;
      barClose: number;
      score: number;
    }
    const candidates: Cand[] = [];

    for (const coin of coins) {
      const idx = coin.timeMap15.get(t);
      if (idx === undefined || idx < 200) continue;
      const st = states.get(coin.symbol)!;
      const c = coin.c15[idx];
      const isHeld = activePositions.some((p) => p.symbol === coin.symbol);

      let p1 = p1Map.get(coin.symbol)!;
      while (p1 + 1 < coin.c1h.length && coin.c1h[p1 + 1].time + 3600 <= closeT) p1++;
      p1Map.set(coin.symbol, p1);

      if (!isHeld && isMacroOk && st.waitingPullback && t > st.waitFromTime && t <= st.pullbackExpiryTime) {
        const prev = idx - 1;
        const limitP = coin.m4[prev];
        if (coin.m8[prev] >= coin.m16[prev] && c.low <= limitP * (1 - 0.001)) {
          // Check prior-bar quality filters
          let pass = true;
          if (cfg.requireCoin1hRsi40 && coin.rsi1h[p1] < 40) pass = false;

          let buyVolRatio12 = 1.0;
          if (pass) {
            let upV = 0, dnV = 0;
            for (let k = Math.max(0, prev - 11); k <= prev; k++) {
              const b = coin.c15[k];
              const qv = b.volume * b.close;
              if (b.close >= b.open) upV += qv;
              else dnV += qv;
            }
            buyVolRatio12 = dnV > 0 ? upV / dnV : 2.0;
            if (cfg.minBuyVolRatio12 !== undefined && buyVolRatio12 < cfg.minBuyVolRatio12) pass = false;
          }

          let relStrength24h = 0;
          if (pass) {
            const coinRet24h = ((coin.c15[prev].close - coin.c15[Math.max(0, prev - 96)].open) / coin.c15[Math.max(0, prev - 96)].open) * 100;
            relStrength24h = coinRet24h - macro.btcRet24h;
            if (cfg.minRelStrengthVsBtc24h !== undefined && relStrength24h < cfg.minRelStrengthVsBtc24h) pass = false;
          }

          let upperSpreadPct = 0;
          if (pass) {
            upperSpreadPct = ((coin.m200[prev] - coin.m75[prev]) / coin.m200[prev]) * 100;
            if (cfg.maxUpperRibbonSpreadPct !== undefined && upperSpreadPct > cfg.maxUpperRibbonSpreadPct) pass = false;
          }

          if (pass) {
            const fillPrice = Math.min(c.open, limitP);
            const score =
              cfg.rankBy === "COMPOSITE_QUALITY"
                ? Math.min(3, buyVolRatio12) * 20 + Math.max(-5, Math.min(10, relStrength24h)) * 3 - upperSpreadPct * 10
                : coin.rsi15[prev];
            candidates.push({
              symbol: coin.symbol,
              entryPrice: fillPrice,
              barLow: c.low,
              barHigh: c.high,
              barClose: c.close,
              score,
            });
          }
        }
      }

      if (st.waitingPullback && (t >= st.pullbackExpiryTime || coin.m8[idx] < coin.m16[idx])) {
        st.waitingPullback = false;
      }

      const isBottomFan =
        coin.m4[idx] < coin.m8[idx] &&
        coin.m8[idx] < coin.m16[idx] &&
        coin.m16[idx] < coin.m25[idx] &&
        coin.m25[idx] < coin.m75[idx] &&
        coin.m75[idx] < coin.m200[idx];

      if (isBottomFan) {
        st.hadBottomFan = true;
        st.fanExpiryTime = t + 20 * 900;
        st.bottomLow = Math.min(st.bottomLow, c.low);
      }
      if (t > st.fanExpiryTime && !st.waitingPullback && !isHeld) {
        st.hadBottomFan = false;
        st.bottomLow = Infinity;
      }

      const is8Cross16Up = coin.m8[idx - 1] <= coin.m16[idx - 1] && coin.m8[idx] > coin.m16[idx];
      if (!isHeld && !st.waitingPullback && st.hadBottomFan && is8Cross16Up) {
        const rsiOk = coin.rsi15[idx] >= 35 && coin.rsi15[idx] > coin.rsi15[idx - 1];
        const macdOk = coin.macdHist15[idx] > coin.macdHist15[idx - 1];
        if (rsiOk && macdOk) {
          st.waitingPullback = true;
          st.waitFromTime = t;
          st.pullbackExpiryTime = t + 12 * 900;
        }
      }
    }

    // 3. Allocate free slots
    const freeSlots = cfg.maxSlots - activePositions.length;
    if (freeSlots > 0 && candidates.length > 0) {
      candidates.sort((a, b) => b.score - a.score);
      const chosen = candidates.slice(0, freeSlots);
      for (const ch of chosen) {
        const currentFreeSlots = cfg.maxSlots - activePositions.length;
        const alloc = cash / currentFreeSlots;
        if (alloc < 1.0) continue;
        cash -= alloc;
        const qty = (alloc * (1 - costPerFill)) / ch.entryPrice;
        activePositions.push({
          symbol: ch.symbol,
          entryTime: t,
          entryPrice: ch.entryPrice,
          allocatedCapital: alloc,
          qty,
          troughPrice: Math.min(ch.entryPrice, ch.barLow),
          peakPrice: Math.max(ch.entryPrice, ch.barHigh),
          lastKnownPrice: ch.barClose,
          beLocked: false,
          tp1Done: false,
          realizedProceeds: 0,
        });
        const st = states.get(ch.symbol)!;
        st.waitingPullback = false;
        st.hadBottomFan = false;
      }
    }

    // 4. Mark-to-market equity
    let openVal = 0;
    for (const pos of activePositions) {
      openVal += pos.qty * pos.lastKnownPrice;
    }
    const eq = cash + openVal;
    if (eq > peakEquity) peakEquity = eq;
    const dd = ((peakEquity - eq) / peakEquity) * 100;
    if (dd > maxDdPct) maxDdPct = dd;
  }

  // Force End-of-Period MTM
  for (const pos of activePositions) {
    const finalProceeds = pos.qty * pos.lastKnownPrice * (1 - costPerFill);
    cash += finalProceeds;
    const totalProceeds = pos.realizedProceeds + finalProceeds;
    const netPnlPct = ((totalProceeds - pos.allocatedCapital) / pos.allocatedCapital) * 100;
    const maePct = ((pos.troughPrice - pos.entryPrice) / pos.entryPrice) * 100;
    completedTrades.push({
      pnlPct: netPnlPct,
      maePct,
      holdHours: (endT - pos.entryTime) / 3600,
      isWin: netPnlPct > 0,
      time: pos.entryTime,
    });
  }

  const netReturnPct = ((cash - INITIAL_CAPITAL) / INITIAL_CAPITAL) * 100;
  const wins = completedTrades.filter((x) => x.isWin);
  const losses = completedTrades.filter((x) => !x.isWin);
  const wr = completedTrades.length > 0 ? (wins.length / completedTrades.length) * 100 : 0;
  const sumW = wins.reduce((s, x) => s + x.pnlPct, 0);
  const sumL = Math.abs(losses.reduce((s, x) => s + x.pnlPct, 0));
  const pf = sumL > 0 ? sumW / sumL : 99;
  const avgMae = completedTrades.length > 0 ? completedTrades.reduce((s, x) => s + x.maePct, 0) / completedTrades.length : 0;

  return {
    name: cfg.name,
    trades: completedTrades.length,
    wr,
    pf,
    netReturnPct,
    maxDdPct,
    calmar: maxDdPct > 0 ? netReturnPct / maxDdPct : 0,
    avgMae,
  };
}

function testSuite(label: string, min5mBars: number) {
  const { coins, startT, endT } = loadUniverse(min5mBars);
  const btc = coins.find((c) => c.symbol === "BTCUSDT")!;
  const timeline = btc.c15.filter((c) => c.time >= startT && c.time <= endT).map((c) => c.time);

  const bStart = btc.c15.find((c) => c.time >= startT)!.close;
  const bEnd = btc.c15[btc.c15.length - 1].close;
  const btcReturnPct = ((bEnd - bStart) / bStart) * 100;

  const macroMap = new Map<number, { b25: number; btcNotDumping: boolean; btcRet24h: number }>();
  for (const t of timeline) {
    let a25 = 0, tot = 0;
    for (const c of coins) {
      if (c.symbol === "BTCUSDT") continue;
      const idx = c.timeMap15.get(t);
      if (idx !== undefined && idx > 200) {
        tot++;
        if (c.c15[idx - 1].close > c.m25[idx - 1]) a25++;
      }
    }
    const bIdx = btc.timeMap15.get(t) ?? 200;
    const prev = bIdx - 1;
    let sma96 = btc.c15[prev].close;
    if (prev >= 96) {
      let s = 0;
      for (let k = prev - 95; k <= prev; k++) s += btc.c15[k].close;
      sma96 = s / 96;
    }
    const btcClose = btc.c15[prev].close;
    const btcRet4h = ((btcClose - btc.c15[Math.max(0, prev - 16)].open) / btc.c15[Math.max(0, prev - 16)].open) * 100;
    const btcRet24h = ((btcClose - btc.c15[Math.max(0, prev - 96)].open) / btc.c15[Math.max(0, prev - 96)].open) * 100;

    macroMap.set(t, {
      b25: tot > 0 ? (a25 / tot) * 100 : 50,
      btcNotDumping: btcClose >= sma96 * 0.99 && btcRet4h >= -1.2,
      btcRet24h,
    });
  }

  const configs: SimConfig[] = [
    { name: "1. Baseline F-3Slots (1H RSI>=40, Hold Full Fan)", maxSlots: 3, requireCoin1hRsi40: true },
    { name: "2. + Macro Gate (Breadth25>=50% & BTC Not Dumping)", maxSlots: 3, requireCoin1hRsi40: true, minBreadth25Pct: 50, requireBtcNotDumping: true },
    { name: "3. + Buyer Vol Absorption (Up/Dn Vol >= 1.3x)", maxSlots: 3, requireCoin1hRsi40: true, minBuyVolRatio12: 1.3 },
    { name: "4. + Rel Strength vs BTC (24h >= -1.0%)", maxSlots: 3, requireCoin1hRsi40: true, minRelStrengthVsBtc24h: -1.0 },
    { name: "5. + Tight Upper Ribbon ((EMA200-EMA75)/200 <= 1.2%)", maxSlots: 3, requireCoin1hRsi40: true, maxUpperRibbonSpreadPct: 1.2 },
    { name: "6. + Lock Breakeven SL when High touches EMA 200", maxSlots: 3, requireCoin1hRsi40: true, lockBeAtEma200: true },
    { name: "7. + Staged TP1 (50% at EMA200 + BE SL) + TP2 (Full Fan)", maxSlots: 3, requireCoin1hRsi40: true, partialTpAtEma200: true },
    {
      name: "8. ★ MA-FAN PRO A (Vol>=1.3 + RelBTC>=-1% + CompositeRank)",
      maxSlots: 3,
      requireCoin1hRsi40: true,
      minBuyVolRatio12: 1.3,
      minRelStrengthVsBtc24h: -1.0,
      rankBy: "COMPOSITE_QUALITY",
    },
    {
      name: "9. ★ MA-FAN PRO B (MacroGate + Vol>=1.3 + RelBTC>=-1% + CompositeRank)",
      maxSlots: 3,
      requireCoin1hRsi40: true,
      minBreadth25Pct: 50,
      requireBtcNotDumping: true,
      minBuyVolRatio12: 1.3,
      minRelStrengthVsBtc24h: -1.0,
      rankBy: "COMPOSITE_QUALITY",
    },
    {
      name: "10. ★ MA-FAN PRO C (Pro B + Lock Breakeven at EMA200 + 8% Disaster SL)",
      maxSlots: 3,
      requireCoin1hRsi40: true,
      minBreadth25Pct: 50,
      requireBtcNotDumping: true,
      minBuyVolRatio12: 1.3,
      minRelStrengthVsBtc24h: -1.0,
      rankBy: "COMPOSITE_QUALITY",
      lockBeAtEma200: true,
      maxDisasterSlPct: 8.0,
    },
    {
      name: "11. ★ MA-FAN PRO D (Pro B + Partial TP1 at EMA200 + 8% Disaster SL)",
      maxSlots: 3,
      requireCoin1hRsi40: true,
      minBreadth25Pct: 50,
      requireBtcNotDumping: true,
      minBuyVolRatio12: 1.3,
      minRelStrengthVsBtc24h: -1.0,
      rankBy: "COMPOSITE_QUALITY",
      partialTpAtEma200: true,
      maxDisasterSlPct: 8.0,
    },
  ];

  console.log(`\n====================================================================================================`);
  console.log(`${label} | ${coins.length} Coins | ${(timeline.length / 96).toFixed(1)} Days | BTC Benchmark: ${btcReturnPct >= 0 ? "+" : ""}${btcReturnPct.toFixed(2)}%`);
  console.log(`====================================================================================================`);
  console.log(`Strategy Variant                                                        | Trd |  WR%  |  PF  | NetRet% | MaxDD% | Calmar | AvgMAE`);
  console.log(`------------------------------------------------------------------------+-----+-------+------+---------+--------+--------+-------`);

  for (const cfg of configs) {
    const r = runPortfolioSim(coins, startT, endT, macroMap, cfg);
    console.log(
      `${r.name.padEnd(71)} | ${String(r.trades).padStart(3)} | ${r.wr.toFixed(1).padStart(5)}% | ${r.pf.toFixed(2).padStart(4)} | ${((r.netReturnPct >= 0 ? "+" : "") + r.netReturnPct.toFixed(2) + "%").padStart(7)} | ${("-" + r.maxDdPct.toFixed(2) + "%").padStart(6)} | ${r.calmar.toFixed(2).padStart(6)} | ${r.avgMae.toFixed(2)}%`
    );
  }
}

testSuite("DATASET 1: 68 UNIFORM COINS (32.7 DAYS)", 9000);
testSuite("DATASET 2: 19 CORE COINS (122.1 DAYS)", 30000);
