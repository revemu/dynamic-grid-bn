import { BacktestService } from "../src/backtest-service.js";

async function optimize() {
  console.log("=== Comprehensive Portfolio Strategy Optimization ===");

  const simLimit = 34560;
  const universeCandlesMap = await BacktestService.fetchTopUniverseCandles({
    quoteAsset: "USDT",
    maxPairs: 50,
    limit: simLimit,
  });

  const btcSym = "BTCUSDT";
  let btcCandles = universeCandlesMap.get(btcSym)!;
  if (!btcCandles || btcCandles.length < 500) {
    btcCandles = await BacktestService.fetchBinanceCandles("BTCUSDT", "5m", simLimit + 600);
  }

  const allPairs: { symbol: string; candles: any[] }[] = [];
  for (const [symbol, candles] of universeCandlesMap.entries()) {
    if (candles && candles.length >= 500) {
      allPairs.push({ symbol, candles });
    }
  }

  // Filter 1: Quality filter (exclude meme/penny coins with price < $0.001 or tokens known to have zero liquidity)
  const qualityPairs = allPairs.filter(p => {
    const lastClose = p.candles[p.candles.length - 1].close;
    // Exclude micro-penny tokens (< $0.005) or notorious low-float pump-and-dumps
    const isMemePenny = ["1000CATUSDT", "PEPEUSDT", "MARSCOINUSDT", "HAEDALUSDT", "TRUMPUSDT", "BMTUSDT", "MEGAUSDT"].includes(p.symbol);
    return !isMemePenny && lastClose >= 0.01;
  });

  console.log(`All pairs: ${allPairs.length}, Quality pairs: ${qualityPairs.length}`);

  // Test Matrix
  const configs = [
    { name: "1. Baseline (All 50, SL 12%, EMA200 TP1)", universe: allPairs, sl: 12, tp1: "EMA200", lockBe: true, partTp: true },
    { name: "2. All 50, SL 3.5%, EMA200 TP1", universe: allPairs, sl: 3.5, tp1: "EMA200", lockBe: true, partTp: true },
    { name: "3. Quality Pairs only, SL 12%, EMA200 TP1", universe: qualityPairs, sl: 12, tp1: "EMA200", lockBe: true, partTp: true },
    { name: "4. Quality Pairs only, SL 3.5%, EMA200 TP1", universe: qualityPairs, sl: 3.5, tp1: "EMA200", lockBe: true, partTp: true },
    { name: "5. Quality Pairs only, SL 4.0%, EMA200 TP1", universe: qualityPairs, sl: 4.0, tp1: "EMA200", lockBe: true, partTp: true },
    { name: "6. Quality Pairs only, SL 5.0%, EMA200 TP1", universe: qualityPairs, sl: 5.0, tp1: "EMA200", lockBe: true, partTp: true },
    { name: "7. Quality Pairs only, SL 3.5%, No BE Lock (Partial TP only)", universe: qualityPairs, sl: 3.5, tp1: "EMA200", lockBe: false, partTp: true },
    { name: "8. Quality Pairs only, SL 3.5%, No TP1 (Full Fan)", universe: qualityPairs, sl: 3.5, tp1: undefined, lockBe: false, partTp: false },
  ];

  for (const cfg of configs) {
    const res = BacktestService.runMaFanPortfolioSimulation({
      universe: cfg.universe,
      btcCandles,
      maxSlots: 3,
      initialCapital: 200,
      requireCoin1hRsi40: true,
      minBuyVolRatio12: 1.3,
      minRelStrengthVsBtc24h: -1.0,
      rankBy: "COMPOSITE_QUALITY",
      tp1TargetMode: cfg.tp1 as any,
      lockBreakevenAtEma200: cfg.lockBe,
      partialTpAtEma200: cfg.partTp,
      maxDisasterSlPct: cfg.sl,
      downtrendSitOutMode: "dual",
    });

    console.log(`${cfg.name}:`);
    console.log(`   PnL: ${res.netPnlPct >= 0 ? "+" : ""}${res.netPnlPct.toFixed(2)}% ($${res.netPnlQuote.toFixed(2)}) | WR: ${res.winRate}% | MaxDD: ${res.maxDrawdownPct.toFixed(2)}% | PF: ${res.profitFactor} | Trades: ${res.totalTrades}`);
  }
}

optimize().catch(console.error);
