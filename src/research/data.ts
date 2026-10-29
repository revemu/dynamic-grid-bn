import fs from "fs";
import path from "path";
import crypto from "crypto";
import { Candle } from "../strategy/ma-fan/types.js";
import { STABLE_TOKENS } from "../backtest-service.js";
import { CandleCacheMetadata, SnapshotData, SnapshotManifest, UniverseCoin, UniverseFile } from "./types.js";

const DEFAULT_CACHE_DIR = path.resolve(process.cwd(), "data", "research-cache");

const DEFAULT_FORCE_INCLUDE = [
  "HAEDALUSDT",
  "BNBUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "SUIUSDT",
  "NEARUSDT",
];

/**
 * Calculates SHA256 hash of a string buffer
 */
export function calcSha256(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Sleep helper for rate-limiting and backoff
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Robust fetch with exponential backoff and rate-limit compliance
 */
export async function fetchWithRetry(url: string, maxRetries = 5): Promise<Response> {
  let attempt = 0;
  while (attempt < maxRetries) {
    attempt++;
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "dynamic-grid-bn/research-suite" },
      });

      if (res.ok) return res;

      if (res.status === 429 || res.status === 418 || res.status >= 500) {
        const retryAfterHeader = res.headers.get("Retry-After");
        const retryAfterMs = retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : Math.pow(2, attempt) * 1000;
        console.warn(`[Binance API] HTTP ${res.status} on ${url}. Backing off for ${retryAfterMs}ms (attempt ${attempt}/${maxRetries})...`);
        await sleep(retryAfterMs);
        continue;
      }

      throw new Error(`Binance API error: HTTP ${res.status} ${res.statusText}`);
    } catch (err: any) {
      if (attempt >= maxRetries) throw err;
      const delayMs = Math.pow(2, attempt) * 1000;
      console.warn(`[Binance API] Network error on ${url}: ${err.message}. Retrying in ${delayMs}ms...`);
      await sleep(delayMs);
    }
  }
  throw new Error(`Failed to fetch ${url} after ${maxRetries} retries`);
}

/**
 * Fetches all historical klines for a symbol and interval across a time range via Binance REST API.
 * Automatically paginates in chunks of 1000 bars.
 */
export async function fetchKlinesRange(
  symbol: string,
  interval: "5m" | "15m",
  startMs: number,
  endMs: number
): Promise<Candle[]> {
  const intervalMinutes = interval === "15m" ? 15 : 5;
  const intervalMs = intervalMinutes * 60 * 1000;
  const candles: Candle[] = [];
  const seenTimes = new Set<number>();
  let currentStart = startMs;
  const nowMs = Date.now();

  while (currentStart < endMs) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${currentStart}&endTime=${endMs}&limit=1000`;
    const res = await fetchWithRetry(url);
    const data = (await res.json()) as any[];

    if (!Array.isArray(data) || data.length === 0) {
      break;
    }

    let lastOpenTime = currentStart;
    for (const raw of data) {
      const openTimeMs = Number(raw[0]);
      const closeTimeMs = Number(raw[6]);

      // Filter out any candle that hasn't closed yet or lies beyond requested endMs
      if (closeTimeMs > nowMs || openTimeMs >= endMs) continue;

      const sec = Math.floor(openTimeMs / 1000);
      if (!seenTimes.has(sec)) {
        seenTimes.add(sec);
        candles.push({
          time: sec,
          open: parseFloat(raw[1]),
          high: parseFloat(raw[2]),
          low: parseFloat(raw[3]),
          close: parseFloat(raw[4]),
          volume: parseFloat(raw[5]),
          isClosed: true,
        });
      }
      lastOpenTime = openTimeMs;
    }

    if (data.length < 1000 || lastOpenTime + intervalMs <= currentStart) {
      break;
    }
    currentStart = lastOpenTime + intervalMs;
    await sleep(50); // Gentle pacing
  }

  candles.sort((a, b) => a.time - b.time);
  return candles;
}

/**
 * Selects the top liquid USDT pairs from Binance 24h tickers + forces specific core pairs.
 */
export async function selectUniverse(
  topN = 30,
  forceInclude = DEFAULT_FORCE_INCLUDE,
  cacheDir = DEFAULT_CACHE_DIR
): Promise<UniverseCoin[]> {
  fs.mkdirSync(cacheDir, { recursive: true });
  const universeFilePath = path.join(cacheDir, "universe.json");

  // If already cached, return existing universe
  if (fs.existsSync(universeFilePath)) {
    try {
      const saved: UniverseFile = JSON.parse(fs.readFileSync(universeFilePath, "utf8"));
      if (saved && Array.isArray(saved.coins) && saved.coins.length > 0) {
        return saved.coins;
      }
    } catch (_) {}
  }

  console.log(`[Universe] Fetching 24h ticker from Binance for Top ${topN} selection...`);
  const tickerRes = await fetchWithRetry("https://api.binance.com/api/v3/ticker/24hr");
  const tickers = (await tickerRes.json()) as Array<{
    symbol: string;
    quoteVolume: string;
    count: number;
  }>;

  // Filter USDT pairs, exclude stablecoins
  const filtered = tickers.filter((t) => {
    if (!t.symbol.endsWith("USDT")) return false;
    const base = t.symbol.slice(0, -4);
    if (STABLE_TOKENS.has(base)) return false;
    return Number(t.quoteVolume) > 10_000 && Number(t.count) > 100;
  });

  filtered.sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume));

  const topCoins = filtered.slice(0, topN);
  const selectedMap = new Map<string, UniverseCoin>();

  topCoins.forEach((c, idx) => {
    selectedMap.set(c.symbol, {
      symbol: c.symbol,
      quoteVolume: Math.round(Number(c.quoteVolume)),
      count: Number(c.count),
      rank: idx + 1,
      isForceIncluded: forceInclude.includes(c.symbol),
    });
  });

  // Force include specific pairs
  for (const sym of forceInclude) {
    if (!selectedMap.has(sym)) {
      const match = tickers.find((t) => t.symbol === sym);
      selectedMap.set(sym, {
        symbol: sym,
        quoteVolume: match ? Math.round(Number(match.quoteVolume)) : 0,
        count: match ? Number(match.count) : 0,
        rank: 999,
        isForceIncluded: true,
      });
    }
  }

  const result = Array.from(selectedMap.values());
  const universeFile: UniverseFile = {
    selectedAt: new Date().toISOString(),
    topN,
    forceInclude,
    coins: result,
  };

  fs.writeFileSync(universeFilePath, JSON.stringify(universeFile, null, 2), "utf8");
  console.log(`[Universe] Selected ${result.length} coins (Top ${topN} + ${forceInclude.length} forced). Saved to ${universeFilePath}`);
  return result;
}

/**
 * Validates data quality: coverage >= 99%, no gaps > 3 consecutive bars, close > 0
 */
export function validateCandleQuality(
  symbol: string,
  timeframe: "5m" | "15m",
  candles: Candle[],
  expectedBars: number
): { isValid: boolean; coveragePct: number; reason?: string } {
  if (candles.length === 0) {
    return { isValid: false, coveragePct: 0, reason: "Zero candles retrieved" };
  }

  const coveragePct = Number(((candles.length / expectedBars) * 100).toFixed(2));
  if (coveragePct < 99.0) {
    return {
      isValid: false,
      coveragePct,
      reason: `Insufficient coverage (${coveragePct}% < 99.0%, got ${candles.length}/${expectedBars} bars)`,
    };
  }

  const intervalSec = timeframe === "15m" ? 15 * 60 : 5 * 60;
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1]!;
    const cur = candles[i]!;

    if (cur.close <= 0 || cur.high <= 0 || cur.low <= 0 || cur.open <= 0) {
      return { isValid: false, coveragePct, reason: `Invalid non-positive price found at bar ${cur.time}` };
    }

    const gapBars = Math.round((cur.time - prev.time) / intervalSec) - 1;
    if (gapBars > 3) {
      return {
        isValid: false,
        coveragePct,
        reason: `Gap of ${gapBars} consecutive bars found between ${prev.time} and ${cur.time}`,
      };
    }
  }

  return { isValid: true, coveragePct };
}

/**
 * Main loader / fetcher for deterministic snapshot datasets
 */
export async function loadOrFetchSnapshot(opts: {
  days: number;
  endIso?: string;
  topN?: number;
  forceInclude?: string[];
  cacheDir?: string;
  concurrency?: number;
}): Promise<SnapshotData> {
  const days = opts.days;
  const endIso = opts.endIso || "2026-10-29T00:00:00.000Z";
  const endSec = Math.floor(new Date(endIso).getTime() / 1000);
  const startSec = endSec - days * 86400;
  const startIso = new Date(startSec * 1000).toISOString();
  const cacheDir = opts.cacheDir || DEFAULT_CACHE_DIR;
  fs.mkdirSync(cacheDir, { recursive: true });

  const universe = await selectUniverse(opts.topN ?? 30, opts.forceInclude ?? DEFAULT_FORCE_INCLUDE, cacheDir);
  const manifestPath = path.join(cacheDir, `manifest_${days}d.json`);

  // Check if manifest already exists and is fully valid
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest: SnapshotManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (manifest.days === days && manifest.endSec === endSec && manifest.passedSymbols.length >= 25) {
        console.log(`[Snapshot] Found existing valid manifest for ${days}d (${manifest.passedSymbols.length} passed coins). Loading from disk cache...`);
        const candlesBySymbol = new Map<string, { candles5m: Candle[]; candlesHtf15m: Candle[] }>();

        let allFilesOk = true;
        for (const sym of manifest.passedSymbols) {
          const meta5m = manifest.files[`${sym}_5m`];
          const meta15m = manifest.files[`${sym}_15m`];
          if (!meta5m || !meta15m || !fs.existsSync(meta5m.filePath) || !fs.existsSync(meta15m.filePath)) {
            allFilesOk = false;
            break;
          }
          const c5m: Candle[] = JSON.parse(fs.readFileSync(meta5m.filePath, "utf8"));
          const c15m: Candle[] = JSON.parse(fs.readFileSync(meta15m.filePath, "utf8"));
          candlesBySymbol.set(sym, { candles5m: c5m, candlesHtf15m: c15m });
        }

        if (allFilesOk) {
          return { manifest, universe, candlesBySymbol };
        }
      }
    } catch (_) {}
  }

  console.log(`[Snapshot] Building new snapshot for ${days} days (${startIso} -> ${endIso}) across ${universe.length} symbols...`);

  // Warmup requirements: 300 bars of 5m (= 25 hours = 90,000s) and 300 bars of 15m (= 75 hours = 270,000s)
  const warmup5mSec = 300 * 5 * 60;
  const warmup15mSec = 300 * 15 * 60;

  const fetchStart5mMs = (startSec - warmup5mSec) * 1000;
  const fetchStart15mMs = (startSec - warmup15mSec) * 1000;
  const fetchEndMs = endSec * 1000;

  const expectedBars5m = days * 288 + 300;
  const expectedBars15m = days * 96 + 300;

  const manifest: SnapshotManifest = {
    fetchedAt: new Date().toISOString(),
    days,
    startIso,
    endIso,
    startSec,
    endSec,
    totalSymbols: universe.length,
    passedSymbols: [],
    rejectedSymbols: [],
    files: {},
  };

  const candlesBySymbol = new Map<string, { candles5m: Candle[]; candlesHtf15m: Candle[] }>();

  // Process symbols in chunks of 4 for polite concurrency
  const concurrency = opts.concurrency || 4;
  for (let i = 0; i < universe.length; i += concurrency) {
    const chunk = universe.slice(i, i + concurrency);
    await Promise.all(
      chunk.map(async (u) => {
        const sym = u.symbol;
        const file5mPath = path.join(cacheDir, `${sym}_5m_${startSec}_${endSec}.json`);
        const file15mPath = path.join(cacheDir, `${sym}_15m_${startSec}_${endSec}.json`);

        let c5m: Candle[];
        let c15m: Candle[];

        if (fs.existsSync(file5mPath)) {
          c5m = JSON.parse(fs.readFileSync(file5mPath, "utf8"));
        } else {
          c5m = await fetchKlinesRange(sym, "5m", fetchStart5mMs, fetchEndMs);
          fs.writeFileSync(file5mPath, JSON.stringify(c5m), "utf8");
        }

        if (fs.existsSync(file15mPath)) {
          c15m = JSON.parse(fs.readFileSync(file15mPath, "utf8"));
        } else {
          c15m = await fetchKlinesRange(sym, "15m", fetchStart15mMs, fetchEndMs);
          fs.writeFileSync(file15mPath, JSON.stringify(c15m), "utf8");
        }

        const q5m = validateCandleQuality(sym, "5m", c5m, expectedBars5m);
        const q15m = validateCandleQuality(sym, "15m", c15m, expectedBars15m);

        const sha5m = calcSha256(JSON.stringify(c5m));
        const sha15m = calcSha256(JSON.stringify(c15m));

        manifest.files[`${sym}_5m`] = {
          symbol: sym,
          timeframe: "5m",
          filePath: file5mPath,
          sha256: sha5m,
          candleCount: c5m.length,
          firstTime: c5m[0]?.time ?? 0,
          lastTime: c5m[c5m.length - 1]?.time ?? 0,
          expectedBars: expectedBars5m,
          coveragePct: q5m.coveragePct,
          isValid: q5m.isValid,
          invalidReason: q5m.reason,
        };

        manifest.files[`${sym}_15m`] = {
          symbol: sym,
          timeframe: "15m",
          filePath: file15mPath,
          sha256: sha15m,
          candleCount: c15m.length,
          firstTime: c15m[0]?.time ?? 0,
          lastTime: c15m[c15m.length - 1]?.time ?? 0,
          expectedBars: expectedBars15m,
          coveragePct: q15m.coveragePct,
          isValid: q15m.isValid,
          invalidReason: q15m.reason,
        };

        if (q5m.isValid && q15m.isValid) {
          manifest.passedSymbols.push(sym);
          candlesBySymbol.set(sym, { candles5m: c5m, candlesHtf15m: c15m });
          console.log(`✓ [Snapshot] ${sym}: PASS (5m: ${c5m.length}/${expectedBars5m} bars, 15m: ${c15m.length}/${expectedBars15m} bars)`);
        } else {
          const reason = `5m: ${q5m.reason || "ok"}; 15m: ${q15m.reason || "ok"}`;
          manifest.rejectedSymbols.push({ symbol: sym, reason });
          console.warn(`✗ [Snapshot] ${sym}: REJECTED (${reason})`);
        }
      })
    );
  }

  // Also write canonical manifest.json for default 15d
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  fs.writeFileSync(path.join(cacheDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  console.log(`[Snapshot] Completed! ${manifest.passedSymbols.length}/${manifest.totalSymbols} symbols passed data quality gates.`);
  return { manifest, universe, candlesBySymbol };
}
