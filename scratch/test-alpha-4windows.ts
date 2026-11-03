import { BacktestService, Candle } from "../src/backtest-service.js";

const BS: any = BacktestService;
const QUOTE = "USDT";
const N = 20;
const WINDOW = 8640; // 30 days of 5m bars

async function run() {
  console.log("Loading universe candles from disk cache...");
  const universe: Map<string, Candle[]> = await BS.fetchTopUniverseCandles({
    quoteAsset: QUOTE, maxPairs: N, limit: 35000
  });

  let globalMax = 0;
  for (const c of universe.values()) globalMax = Math.max(globalMax, c[c.length - 1].time);

  const windowCount = 4;
  const report: any[] = [];

  for (let w = 0; w < windowCount; w++) {
    const endBarTime = globalMax - w * WINDOW * 300;
    const startBarTime = endBarTime - WINDOW * 300;
    const windowLabel = `W${w + 1} [${new Date(startBarTime * 1000).toISOString().slice(0, 10)} ➔ ${new Date(endBarTime * 1000).toISOString().slice(0, 10)}]`;

    console.log(`\n========================================================================`);
    console.log(`Analyzing ${windowLabel}`);
    console.log(`========================================================================`);

    const truncUniverse = new Map<string, Candle[]>();
    for (const [sym, c] of universe) {
      const t = c.filter((x) => x.time <= endBarTime);
      if (t.length >= 500) truncUniverse.set(sym, t);
    }

    const btcCandles = truncUniverse.get(`BTC${QUOTE}`);
    let btcBH = 0;
    if (btcCandles) {
      const b0 = btcCandles.find((c) => c.time >= startBarTime);
      const b1 = btcCandles[btcCandles.length - 1];
      if (b0 && b1) btcBH = ((b1.close - b0.open) / b0.open) * 100;
    }

    let sumEw = 0;
    let countEw = 0;
    for (const [sym, c] of truncUniverse) {
      const b0 = c.find((x) => x.time >= startBarTime);
      const b1 = c[c.length - 1];
      if (b0 && b1 && b0.open > 0) {
        sumEw += ((b1.close - b0.open) / b0.open) * 100;
        countEw++;
      }
    }
    const ewBH = countEw > 0 ? sumEw / countEw : 0;

    console.log(`Benchmark | BTC Buy & Hold: ${btcBH.toFixed(2)}% | Equal-Weight B&H: ${ewBH.toFixed(2)}%`);

    const origFetch = BS.fetchTopUniverseCandles.bind(BS);
    BS.fetchTopUniverseCandles = async () => truncUniverse;

    // Test with 1 Zone (concentrated trend capture, no cash drag) vs 2 Zones
    const r1Zone = await BS.runMultiPairRotationSimulation({
      quoteAsset: QUOTE, maxUniversePairs: N, limit: WINDOW, initialCapital: 100,
      rotationIntervalMinutes: 180, rotationScoreMarginPct: 15, capitalZones: 1,
      signalInvalidationMode: "calibrated",
      enableBtcMacroGate: true,
    });

    const r2Zones = await BS.runMultiPairRotationSimulation({
      quoteAsset: QUOTE, maxUniversePairs: N, limit: WINDOW, initialCapital: 100,
      rotationIntervalMinutes: 180, rotationScoreMarginPct: 15, capitalZones: 2,
      signalInvalidationMode: "calibrated",
      enableBtcMacroGate: true,
    });

    console.log(`  Result 1 Zone  (No Cash Drag) : Net = ${r1Zone.summary.netPnlPct.toFixed(2)}% (MaxDD = ${r1Zone.summary.maxPortfolioDrawdownPct.toFixed(2)}%, Trades = ${r1Zone.summary.totalTrades}, WinRate = ${r1Zone.summary.tradeWinRate}%)`);
    console.log(`  Result 2 Zones (Standard Grid): Net = ${r2Zones.summary.netPnlPct.toFixed(2)}% (MaxDD = ${r2Zones.summary.maxPortfolioDrawdownPct.toFixed(2)}%, Trades = ${r2Zones.summary.totalTrades}, WinRate = ${r2Zones.summary.tradeWinRate}%)`);

    report.push({
      window: windowLabel,
      btcBH: Number(btcBH.toFixed(2)),
      ewBH: Number(ewBH.toFixed(2)),
      zone1: { pnl: r1Zone.summary.netPnlPct, maxDD: r1Zone.summary.maxPortfolioDrawdownPct },
      zone2: { pnl: r2Zones.summary.netPnlPct, maxDD: r2Zones.summary.maxPortfolioDrawdownPct },
    });

    BS.fetchTopUniverseCandles = origFetch;
  }

  console.log("\n==================== FULL 4-WINDOW COMPARISON ====================");
  console.table(report);
}

run().catch(console.error);
