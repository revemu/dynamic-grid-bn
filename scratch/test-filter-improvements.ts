/**
 * Test: compositeScore >= 50 filter + tokenized stock / BUSDT filtering
 * Uses cached 15m candles from disk (no network needed).
 */
import fs from "fs";
import path from "path";
import { BacktestService } from "../src/backtest-service.js";
import { Candle } from "../src/types.js";

const CACHE_DIR = path.resolve(process.cwd(), "data", "cache", "klines");
const ALPACA_PREFIX = "alpaca_";

function loadAllCandidates(): Array<{ symbol: string; candles: Candle[] }> {
  const files = fs.readdirSync(CACHE_DIR).filter((f) => f.endsWith("_15m.json"));
  const result: Array<{ symbol: string; candles: Candle[] }> = [];

  for (const file of files) {
    // Alpaca files: alpaca_SYMBOL_15m.json
    let symbol: string;
    if (file.startsWith(ALPACA_PREFIX)) {
      symbol = file.slice(ALPACA_PREFIX.length, -"_15m.json".length);
    } else {
      symbol = file.slice(0, -"_15m.json".length);
    }

    const raw = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, file), "utf8"));
    const candles: Candle[] = Array.isArray(raw) ? raw : raw.candles;
    if (!candles || candles.length < 100) continue;
    result.push({ symbol, candles });
  }
  return result;
}

async function runTest() {
  console.log("══════════════════════════════════════════════════════════════");
  console.log("  TEST: compositeScore >= 50 filter + BUSDT tokenized stock");
  console.log("══════════════════════════════════════════════════════════════\n");

  const candidates = loadAllCandidates();
  console.log(`Loaded ${candidates.length} symbols with 15m cached candles:\n`);

  // ── Test 1: evaluateGridDna on each symbol ──
  console.log("── Test 1: Grid DNA evaluation ──");
  interface DnaRow {
    symbol: string;
    grade: string;
    dnaScore: number;
    recentDnaScore: number;
    trendRegime: string;
    cleanBounceRate: number;
    isDegrading?: boolean;
  }
  const dnaRows: DnaRow[] = [];

  for (const { symbol, candles } of candidates) {
    const assetClass = symbol.startsWith("alpaca_") || /^[A-Z]{1,4}$/.test(symbol) ? "STOCK" : "CRYPTO";
    const dna = BacktestService.evaluateGridDna(candles, assetClass as "CRYPTO" | "STOCK");
    dnaRows.push({
      symbol,
      grade: dna.grade,
      dnaScore: dna.dnaScore,
      recentDnaScore: dna.recentDnaScore,
      trendRegime: dna.trendRegime,
      cleanBounceRate: dna.cleanBounceRate,
      isDegrading: dna.isDegrading,
    });
    console.log(
      `  ${symbol.padEnd(12)} grade=${dna.grade.padEnd(6)} score=${String(dna.dnaScore).padEnd(3)} ` +
      `recent=${String(dna.recentDnaScore).padEnd(3)} trend=${(dna.trendRegime ?? "?").padEnd(22)} ` +
      `bounce=${dna.cleanBounceRate.toFixed(1)}%`
    );
  }

  // ── Test 2: Compute compositeScore inline (same logic as evaluateHistoricalFunnelAtTime) ──
  console.log("\n── Test 2: Composite Score (simulating entry of evaluateHistoricalFunnelAtTime) ──");
  // Auto-detect asset class based on symbol pattern (same heuristic as scanMarket)
  function detectAssetClass(sym: string): "CRYPTO" | "STOCK" {
    // Alpaca stock symbols are pure letters 1-4 chars (AAPL, KO, SPY)
    if (/^[A-Z]{1,4}$/.test(sym)) return "STOCK";
    return "CRYPTO";
  }

  interface ScoreRow {
    symbol: string;
    dnaGrade: string;
    compositeScore: number;
    simScore: number;
    trendScore: number;
    positionScore: number;
    liquidityScore: number;
    penalty: number;
    passes50: boolean;
    passes60: boolean;
  }
  const scoreRows: ScoreRow[] = [];

  for (const { symbol, candles } of candidates) {
    const assetClass = detectAssetClass(symbol);
    const n = candles.length;
    const lastC = candles[n - 1];
    if (!lastC) continue;

    // 24h window
    const intervalSec = candles.length >= 2 ? candles[1].time - candles[0].time : 900;
    const bars24h = Math.max(16, Math.min(n - 1, Math.round(86400 / intervalSec)));
    const slice24 = candles.slice(n - bars24h, n);
    const high24 = Math.max(...slice24.map((c) => c.high));
    const low24 = Math.min(...slice24.map((c) => c.low));
    const range24hPct = low24 > 0 ? ((high24 - low24) / low24) * 100 : 0;
    const posRatio = (lastC.close - low24) / (high24 - low24);
    const vol24h = slice24.reduce((s, c) => s + c.volume * c.close, 0);

    // skip illiquid/too-narrow
    if (range24hPct < 2.0 || range24hPct > 35.0) {
      console.log(`  ${symbol.padEnd(12)} RANGE=${range24hPct.toFixed(1)}% → SKIP (outside 2-35%)`);
      continue;
    }

    const dna = BacktestService.evaluateGridDna(candles, assetClass as "CRYPTO" | "STOCK");

    // strict grade gate (S/A only)
    if (dna.grade !== "S" && dna.grade !== "A") {
      console.log(`  ${symbol.padEnd(12)} grade=${dna.grade} → SKIP (Grade Gate)`);
      continue;
    }

    // Layer 1: DNA (up to 40)
    const dnaPoints = Math.round(dna.dnaScore * 0.40);

    // Layer 2: trend (up to 35)
    let trendScore = 0;
    if (dna.trendRegime === "BULL_UPTREND") trendScore = 20;
    else if (dna.trendRegime === "ACCUMULATION_RANGE") trendScore = 12;
    else trendScore = 0;

    // We don't compute btcChange24hPct here so we skip the relative strength bonus
    // Just use the cleanBounceRate bonus
    if (dna.cleanBounceRate >= 65 || dna.recentDnaScore >= 75) trendScore += 8;
    else if (dna.cleanBounceRate >= 50 || dna.recentDnaScore >= 60) trendScore += 4;
    trendScore = Math.min(35, trendScore);

    // Layer 3: position (up to 20)
    let positionScore = 0;
    if (posRatio >= 0.10 && posRatio <= 0.38) positionScore = 20;
    else if (posRatio > 0.38 && posRatio <= 0.55) positionScore = 12;
    else if (posRatio < 0.10) positionScore = 6;
    else positionScore = 2;

    // liquidity (up to 5)
    const liquidityScore = Math.min(5, Math.max(0, (Math.log10(vol24h) - 5.5) * 2));

    // penalty
    let penalty = 0;
    if (dna.grade === "AVOID" || dna.trendRegime === "BEAR_DOWNTREND") penalty = -40;
    else if (dna.grade === "B") penalty = -10;
    else if (dna.isDegrading) penalty = -15;

    const compositeScore = Math.max(0, Math.min(100, dnaPoints + trendScore + positionScore + liquidityScore + penalty));

    scoreRows.push({
      symbol,
      dnaGrade: dna.grade,
      compositeScore,
      simScore: Math.round(dnaPoints),
      trendScore,
      positionScore,
      liquidityScore,
      penalty,
      passes50: compositeScore >= 50,
      passes60: compositeScore >= 60,
    });
  }

  // Sort by compositeScore descending
  scoreRows.sort((a, b) => b.compositeScore - a.compositeScore);

  console.log(`\nRanked by compositeScore:`);
  console.log(`  ${"Symbol".padEnd(12)} Grade Score  sim trnd pos liq pen  >=50 >=60`);
  console.log(`  ${"─".repeat(12)} ───── ───── ─── ─── ─── ─── ─── ──── ────`);
  for (const r of scoreRows) {
    console.log(
      `  ${r.symbol.padEnd(12)} ${r.dnaGrade.padEnd(5)} ${String(Math.round(r.compositeScore)).padStart(3)}  ` +
      `${String(r.simScore).padStart(3)} ${String(r.trendScore).padStart(3)} ${String(r.positionScore).padStart(3)} ` +
      `${String(Math.round(r.liquidityScore)).padStart(3)} ${String(r.penalty).padStart(3)}  ` +
      `${r.passes50 ? "YES" : "no"}  ${r.passes60 ? "YES" : "no"}`
    );
  }

  // ── Summary ──
  const total = scoreRows.length;
  const pass50 = scoreRows.filter((r) => r.passes50).length;
  const pass60 = scoreRows.filter((r) => r.passes60).length;
  const avgScore = total > 0 ? scoreRows.reduce((s, r) => s + r.compositeScore, 0) / total : 0;
  const sCount = scoreRows.filter((r) => r.dnaGrade === "S").length;
  const aCount = scoreRows.filter((r) => r.dnaGrade === "A").length;

  console.log(`\n══════════════════════════════════════════════════════════════`);
  console.log(`  SUMMARY`);
  console.log(`══════════════════════════════════════════════════════════════`);
  console.log(`  Symbols passing Grade Gate (S/A):      ${sCount} S  +  ${aCount} A  = ${total}`);
  console.log(`  Symbols with compositeScore >= 50:     ${pass50}/${total}  (${((pass50 / total) * 100).toFixed(1)}%)`);
  console.log(`  Symbols with compositeScore >= 60:     ${pass60}/${total}  (${((pass60 / total) * 100).toFixed(1)}%)`);
  console.log(`  Average compositeScore:                ${avgScore.toFixed(1)}`);
  console.log(`══════════════════════════════════════════════════════════════\n`);

  // ── BUSDT filter test ──
  console.log("── Test 3: isSyntheticOrStock (BUSDT tokenized stock) filter ──");
  const { isSyntheticOrStock } = await import("../src/pair-rotator.js");
  const testSymbols = [
    "MSTRBUSDT", "SOXLBUSDT", "QQQBUSDT", "GOOGLBUSDT", // tokenized stock → true
    "BTCUSDT", "ETHUSDT", "SOLUSDT",                       // normal crypto → false
    "1000PEPEUSDT", "PEPEUSDT", "SHIBUSDT",               // meme/penny (not caught by this, but by TOXIC_MEME)
    "RWUSDUSDT", "UUSDT", "USDCUSDT",                      // synthetic → true
  ];
  console.log(`  ${"Symbol".padEnd(16)} isSyntheticOrStock`);
  console.log(`  ${"─".repeat(16)} ─────────────────`);
  for (const sym of testSymbols) {
    const result = isSyntheticOrStock(sym);
    console.log(`  ${sym.padEnd(16)} ${result}`);
  }

  console.log("\n✅ Test complete.");
}

runTest().catch((err) => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});