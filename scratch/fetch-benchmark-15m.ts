import fs from "fs";
import path from "path";

// Builds the 15m cache files that runMasterBenchmark (src/backtest.ts:777) reads:
//   data/cache/klines/<SYMBOL>_15m.json           (Binance spot, crypto)
//   data/cache/klines/alpaca_<SYMBOL>_15m.json    (Alpaca IEX, US stocks/ETF)
// Output shape matches scratch/sync-kline-cache.ts: { timestamp, candles }.
// Alpaca credentials are read from env only (ALPACA_API_KEY / ALPACA_API_SECRET).

const CACHE_DIR = path.resolve(process.cwd(), "data", "cache", "klines");
const TARGET_BARS = 12000;
const INTERVAL_SEC = 900;

const CRYPTO = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "AVAXUSDT", "LINKUSDT", "ADAUSDT"];
const STOCKS = ["SPY", "AAPL", "KO"];

interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  isClosed: boolean;
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<any> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
      if (res.status === 429 || res.status === 418) {
        await new Promise((r) => setTimeout(r, 2000 * attempt));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.split("?")[0]}`);
      return await res.json();
    } catch (err) {
      if (attempt === 4) throw err;
      await new Promise((r) => setTimeout(r, 800 * attempt));
    }
  }
  throw new Error("unreachable");
}

async function fetchBinance15m(symbol: string): Promise<Candle[]> {
  const nowMs = Date.now();
  const byTime = new Map<number, Candle>();
  let endMs = nowMs;
  while (byTime.size < TARGET_BARS) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=15m&endTime=${endMs}&limit=1000`;
    const raw: any[] = await getJson(url, { "User-Agent": "dynamic-grid-bn/bench-fetch" });
    if (raw.length === 0) break;
    for (const k of raw) {
      const closeMs = Number(k[6]);
      if (closeMs > nowMs) continue;
      const c: Candle = {
        time: Math.floor(Number(k[0]) / 1000),
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
        volume: Number(k[5]) || 0,
        isClosed: true,
      };
      if ([c.time, c.open, c.high, c.low, c.close].every(Number.isFinite) && c.close > 0) {
        byTime.set(c.time, c);
      }
    }
    const firstMs = Number(raw[0][0]);
    if (raw.length < 1000 || firstMs >= endMs) break;
    endMs = firstMs - 1;
    await new Promise((r) => setTimeout(r, 60));
  }
  return Array.from(byTime.values()).sort((a, b) => a.time - b.time).slice(-TARGET_BARS);
}

async function fetchAlpaca15m(symbol: string, apiKey: string, apiSecret: string): Promise<Candle[]> {
  const dataUrl = process.env.ALPACA_DATA_URL || "https://data.alpaca.markets";
  const headers = { "APCA-API-KEY-ID": apiKey, "APCA-API-SECRET-KEY": apiSecret };
  // 2 years back is enough for 12,000 15m bars of regular-session US equity.
  const startIso = new Date(Date.now() - 730 * 86400 * 1000).toISOString().split(".")[0] + "Z";
  const byTime = new Map<number, Candle>();
  let pageToken: string | undefined;
  let pages = 0;
  do {
    let url = `${dataUrl}/v2/stocks/${symbol}/bars?timeframe=15Min&start=${startIso}&adjustment=all&feed=iex&limit=10000`;
    if (pageToken) url += `&page_token=${encodeURIComponent(pageToken)}`;
    const d = await getJson(url, headers);
    for (const b of d.bars || []) {
      const c: Candle = {
        time: Math.floor(new Date(b.t).getTime() / 1000),
        open: Number(b.o),
        high: Number(b.h),
        low: Number(b.l),
        close: Number(b.c),
        volume: Number(b.v) || 0,
        isClosed: true,
      };
      if ([c.time, c.open, c.high, c.low, c.close].every(Number.isFinite) && c.close > 0) {
        byTime.set(c.time, c);
      }
    }
    pageToken = d.next_page_token || undefined;
    pages++;
  } while (pageToken && byTime.size < TARGET_BARS * 2 && pages < 30);
  return Array.from(byTime.values()).sort((a, b) => a.time - b.time).slice(-TARGET_BARS);
}

function save(file: string, candles: Candle[]) {
  const filePath = path.join(CACHE_DIR, file);
  fs.writeFileSync(filePath, JSON.stringify({ timestamp: Date.now(), candles }), "utf8");
  const days = candles.length > 1 ? ((candles[candles.length - 1]!.time - candles[0]!.time) / 86400).toFixed(1) : "0";
  console.log(`[BenchFetch] wrote ${file}: ${candles.length} bars (~${days} days)`);
}

async function main() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  for (const sym of CRYPTO) {
    try {
      const candles = await fetchBinance15m(sym);
      save(`${sym}_15m.json`, candles);
    } catch (e: any) {
      console.warn(`[BenchFetch] FAILED ${sym}: ${e.message}`);
    }
  }

  const apiKey = process.env.ALPACA_API_KEY || "";
  const apiSecret = process.env.ALPACA_API_SECRET || "";
  if (!apiKey || !apiSecret) {
    console.warn("[BenchFetch] SKIPPED stocks: set ALPACA_API_KEY and ALPACA_API_SECRET in the environment");
    return;
  }
  for (const sym of STOCKS) {
    try {
      const candles = await fetchAlpaca15m(sym, apiKey, apiSecret);
      save(`alpaca_${sym}_15m.json`, candles);
    } catch (e: any) {
      console.warn(`[BenchFetch] FAILED ${sym}: ${e.message}`);
    }
  }
}

main().catch(console.error);
