import fs from "fs";
import path from "path";
import { Candle } from "../src/strategy/ma-fan/types.js";

const CACHE_DIR = path.resolve(process.cwd(), "data/cache/klines");
const BLACKLIST = new Set([
  "BFUSDUSDT", "USDEUSDT", "RWUSDUSDT", "UUSDT", "??USDT",
  "GOOGLBUSDT", "INTCBUSDT", "MSTRBUSDT", "QQQBUSDT", "SKHYBUSDT",
  "SNDKBUSDT", "SOXLBUSDT", "SPCXBUSDT", "TQQQBUSDT", "CRCLBUSDT", "PAXGUSDT", "XAUTUSDT"
]);

// Target: 120 days of 5m candles = 34,560 bars
const TARGET_BARS_5M = 34560;
const INTERVAL_SEC = 300;

async function fetchWithRetry(url: string, retries = 4): Promise<any[]> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "dynamic-grid-bn/cache-sync" },
        signal: AbortSignal.timeout(12000),
      });
      if (res.status === 429 || res.status === 418) {
        await new Promise((r) => setTimeout(r, 2000 * attempt));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as any[];
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, 800 * attempt));
    }
  }
  return [];
}

function parseKlines(raw: any[], nowMs: number): Candle[] {
  const out: Candle[] = [];
  for (const k of raw) {
    const time = Math.floor(Number(k[0]) / 1000);
    const closeTimeMs = Number(k[6]);
    if (Number.isFinite(closeTimeMs) && closeTimeMs > nowMs) continue;
    const open = Number(k[1]);
    const high = Number(k[2]);
    const low = Number(k[3]);
    const close = Number(k[4]);
    const volume = Number(k[5]) || 0;
    if ([time, open, high, low, close].every(Number.isFinite) && close > 0) {
      out.push({ time, open, high, low, close, volume, isClosed: true });
    }
  }
  return out;
}

async function syncSymbol5m(symbol: string, targetStartSec: number, nowMs: number): Promise<{ symbol: string; before: number; after: number; fetched: number }> {
  const filePath = path.join(CACHE_DIR, `${symbol}_5m.json`);
  let existing: Candle[] = [];
  if (fs.existsSync(filePath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
      existing = raw.candles || raw || [];
    } catch {}
  }

  const beforeCount = existing.length;
  const map = new Map<number, Candle>();
  for (const c of existing) map.set(c.time, c);

  let fetchedCount = 0;

  // 1. Forward fill: if latest candle is older than now - 1h, fetch newer bars
  const latestSec = existing.length > 0 ? existing[existing.length - 1]!.time : 0;
  if (latestSec > 0 && nowMs / 1000 - latestSec > 3600) {
    let curStartMs = (latestSec + INTERVAL_SEC) * 1000;
    while (curStartMs < nowMs - INTERVAL_SEC * 1000) {
      const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=5m&startTime=${curStartMs}&limit=1000`;
      const raw = await fetchWithRetry(url);
      const batch = parseKlines(raw, nowMs);
      if (batch.length === 0) break;
      for (const c of batch) map.set(c.time, c);
      fetchedCount += batch.length;
      const lastBatchSec = batch[batch.length - 1]!.time;
      if (batch.length < 999 || lastBatchSec * 1000 >= nowMs - 600_000) break;
      curStartMs = (lastBatchSec + INTERVAL_SEC) * 1000;
      await new Promise((r) => setTimeout(r, 40));
    }
  }

  // 2. Backward fill: if earliest candle is newer than targetStartSec + 1 day, fetch older bars
  let earliestSec = existing.length > 0 ? existing[0]!.time : Math.floor(nowMs / 1000);
  if (earliestSec > targetStartSec + 86400) {
    let curEndMs = earliestSec * 1000 - 1;
    while (curEndMs > targetStartSec * 1000) {
      const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=5m&endTime=${curEndMs}&limit=1000`;
      const raw = await fetchWithRetry(url);
      const batch = parseKlines(raw, nowMs);
      if (batch.length === 0) break;
      for (const c of batch) map.set(c.time, c);
      fetchedCount += batch.length;
      const firstBatchSec = batch[0]!.time;
      if (batch.length < 500 || firstBatchSec <= targetStartSec) break;
      curEndMs = firstBatchSec * 1000 - 1;
      await new Promise((r) => setTimeout(r, 40));
    }
  }

  if (fetchedCount > 0) {
    const merged = Array.from(map.values()).sort((a, b) => a.time - b.time);
    fs.writeFileSync(filePath, JSON.stringify({ timestamp: Date.now(), candles: merged }), "utf8");
    return { symbol, before: beforeCount, after: merged.length, fetched: fetchedCount };
  }

  return { symbol, before: beforeCount, after: beforeCount, fetched: 0 };
}

async function main() {
  const allSymbols = fs.readdirSync(CACHE_DIR)
    .filter((f) => f.endsWith("USDT_5m.json"))
    .map((f) => f.replace("_5m.json", ""))
    .filter((s) => !BLACKLIST.has(s));

  // Align target start time:
  // - All 69 coins: guaranteed at least 35 days (back to 2026-09-29)
  // - Core 20 coins: guaranteed full 124 days (back to BNBUSDT earliest candle ~2026-07-01)
  const bnbRaw = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, "BNBUSDT_5m.json"), "utf8"));
  const bnbCandles: Candle[] = bnbRaw.candles || bnbRaw;
  const full124dStartSec = bnbCandles[0]!.time;
  const nowMs = Date.now();
  const min35dStartSec = Math.floor(nowMs / 1000) - 35 * 86400;

  const CORE_124D_COINS = new Set([
    "AAVEUSDT", "AVAXUSDT", "BEAMXUSDT", "BNBUSDT", "BTCUSDT", "DOGEUSDT",
    "ENAUSDT", "ETHUSDT", "LINKUSDT", "NEARUSDT", "PEPEUSDT", "SOLUSDT",
    "SUIUSDT", "TRUMPUSDT", "TRXUSDT", "UNIUSDT", "XPLUSDT", "XRPUSDT", "ZECUSDT"
  ]);

  console.log(`[CacheSync] Incremental sync for ${allSymbols.length} USDT symbols (35d baseline + 124d core)...`);

  let idx = 0;
  const concurrency = 6;
  const results: Array<{ symbol: string; before: number; after: number; fetched: number }> = [];

  async function worker() {
    while (idx < allSymbols.length) {
      const curIdx = idx++;
      const sym = allSymbols[curIdx]!;
      const targetStartSec = CORE_124D_COINS.has(sym) ? full124dStartSec : min35dStartSec;
      try {
        const res = await syncSymbol5m(sym, targetStartSec, nowMs);
        results.push(res);
        if (res.fetched > 0) {
          console.log(`[CacheSync] ✅ (${curIdx + 1}/${allSymbols.length}) ${sym}: ${res.before} -> ${res.after} bars (+${res.fetched})`);
        } else {
          console.log(`[CacheSync] ⏭️ (${curIdx + 1}/${allSymbols.length}) ${sym}: already up-to-date (${res.after} bars)`);
        }
      } catch (e: any) {
        console.warn(`[CacheSync] ⚠️ (${curIdx + 1}/${allSymbols.length}) ${sym} error: ${e.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const full100d = results.filter((r) => r.after >= 28800).length;
  console.log(`\n[CacheSync] 🎉 Completed! ${full100d}/${allSymbols.length} symbols now have 100+ days of 5m history on disk.`);
}

main().catch(console.error);
