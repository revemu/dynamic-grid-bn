import { BacktestService, Candle } from "../src/backtest-service.js";

const BS: any = BacktestService;
const QUOTE = "USDT";
const PAIRS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "NEARUSDT", "SUIUSDT"];
const WINDOW = 8640; // 30 days of 5m bars

async function main() {
  console.log("Loading universe candles from disk cache for:", PAIRS.join(", "));
  const universe = new Map<string, Candle[]>();
  for (const pair of PAIRS) {
    const candles = await BS.fetchBinanceCandles(pair, "5m", 35000);
    universe.set(pair, candles);
  }

  let globalMax = 0;
  for (const c of universe.values()) {
    if (c.length > 0) globalMax = Math.max(globalMax, c[c.length - 1].time);
  }

  const windows = [
    { label: "W1 [Oct-Nov: Bear Market]", w: 0 },
    { label: "W2 [Sep-Oct: Bull Rally]", w: 1 },
    { label: "W3 [Aug-Sep: Bull Run]", w: 2 },
    { label: "W4 [Jul-Aug: Sideway]", w: 3 },
  ];

  console.log("\n==========================================================================================");
  console.log("🏆 HEAD-TO-HEAD BACKTEST: DYNAMIC GRID vs MA-FAN TREND RIDER vs BUY & HOLD (120 DAYS)");
  console.log("==========================================================================================\n");

  const fullReport: any[] = [];

  for (const win of windows) {
    const endBarTime = globalMax - win.w * WINDOW * 300;
    const startBarTime = endBarTime - WINDOW * 300;

    console.log(`\n------------------------------------------------------------------------------------------`);
    console.log(`📊 Window: ${win.label} (${new Date(startBarTime * 1000).toISOString().slice(0, 10)} to ${new Date(endBarTime * 1000).toISOString().slice(0, 10)})`);
    console.log(`------------------------------------------------------------------------------------------`);

    const btcCandlesAll = universe.get("BTCUSDT")!;
    const btcStartIdx = btcCandlesAll.findIndex((c) => c.time >= startBarTime);
    const btcEndIdx = btcCandlesAll.findIndex((c) => c.time > endBarTime);
    const btcSlice = btcCandlesAll.slice(
      Math.max(0, btcStartIdx - 300),
      btcEndIdx >= 0 ? btcEndIdx : btcCandlesAll.length
    );
    const btc0 = btcSlice.find((c) => c.time >= startBarTime)!;
    const btc1 = btcSlice[btcSlice.length - 1];
    const btcReturnPct = ((btc1.close - btc0.open) / btc0.open) * 100;

    console.log(`📌 BTC Benchmark: ${btcReturnPct >= 0 ? "+" : ""}${btcReturnPct.toFixed(2)}%`);

    const winResults: any = {
      window: win.label,
      btcReturn: Number(btcReturnPct.toFixed(2)),
      gridPnlAvg: 0,
      gridMaxDdAvg: 0,
      trendPnlAvg: 0,
      trendMaxDdAvg: 0,
      trendGatedPnlAvg: 0,
      trendGatedMaxDdAvg: 0,
      holdPnlAvg: 0,
    };

    let sumGrid = 0, sumGridDd = 0;
    let sumTrend = 0, sumTrendDd = 0;
    let sumTrendGated = 0, sumTrendGatedDd = 0;
    let sumHold = 0;
    let countPairs = 0;

    for (const sym of PAIRS) {
      const allC = universe.get(sym);
      if (!allC || allC.length < 500) continue;

      const sIdx = allC.findIndex((c) => c.time >= startBarTime);
      const eIdx = allC.findIndex((c) => c.time > endBarTime);
      if (sIdx < 0) continue;

      const simCandles = allC.slice(
        Math.max(0, sIdx - 300),
        eIdx >= 0 ? eIdx : allC.length
      );
      if (simCandles.length < 500) continue;

      const p0 = simCandles.find((c) => c.time >= startBarTime)!;
      const p1 = simCandles[simCandles.length - 1];
      const holdRet = ((p1.close - p0.open) / p0.open) * 100;

      // 1. Dynamic Grid Simulation (Standard 2 Zones)
      const gridRes = BS.runDynamicGridSimulation(simCandles, {
        symbol: sym,
        timeframe: "5m",
        initialCapital: 100,
        maxInventoryQuote: 100,
        capitalZones: 2,
        channelMode: "DONCHIAN_ATR",
        minChannelWidthPct: 6.0,
        maxChannelWidthPct: 25.0,
        costModel: { feePctPerSide: 0.075, slippagePctPerFill: 0.01 },
      });

      // 2. MA Fan Trend Rider Simulation (No Gate)
      const trendRes = BS.runMaFanSimulation(simCandles, {
        symbol: sym,
        timeframe: "5m",
        initialCapital: 100,
        tradeMode: "trend_rider",
        useRatchetSl: true,
        enableFastCut: true,
        macroGateMode: "off",
        costModel: { feePctPerSide: 0.075, slippagePctPerFill: 0.01 },
      });

      // 3. MA Fan Trend Rider with BTC Macro Gate (BullOnly / 100% Cash in Bear)
      const trendGatedRes = BS.runMaFanSimulation(simCandles, {
        symbol: sym,
        timeframe: "5m",
        initialCapital: 100,
        tradeMode: "trend_rider",
        useRatchetSl: true,
        enableFastCut: true,
        macroGateMode: "bullOnly",
        candlesHtf: btcSlice,
        costModel: { feePctPerSide: 0.075, slippagePctPerFill: 0.01 },
      });

      sumGrid += gridRes.summary.netPnlPct;
      sumGridDd += gridRes.summary.maxDrawdownPct;
      sumTrend += trendRes.summary.netPnlPct;
      sumTrendDd += trendRes.summary.maxDrawdownPct;
      sumTrendGated += trendGatedRes.summary.netPnlPct;
      sumTrendGatedDd += trendGatedRes.summary.maxDrawdownPct;
      sumHold += holdRet;
      countPairs++;

      console.log(`  [${sym.padEnd(8)}] B&H: ${holdRet >= 0 ? "+" : ""}${holdRet.toFixed(2)}% | Grid: ${gridRes.summary.netPnlPct >= 0 ? "+" : ""}${gridRes.summary.netPnlPct.toFixed(2)}% (DD ${gridRes.summary.maxDrawdownPct.toFixed(1)}%) | Trend: ${trendRes.summary.netPnlPct >= 0 ? "+" : ""}${trendRes.summary.netPnlPct.toFixed(2)}% (DD ${trendRes.summary.maxDrawdownPct.toFixed(1)}%) | Trend+Gate: ${trendGatedRes.summary.netPnlPct >= 0 ? "+" : ""}${trendGatedRes.summary.netPnlPct.toFixed(2)}% (DD ${trendGatedRes.summary.maxDrawdownPct.toFixed(1)}%)`);
    }

    if (countPairs > 0) {
      winResults.gridPnlAvg = Number((sumGrid / countPairs).toFixed(2));
      winResults.gridMaxDdAvg = Number((sumGridDd / countPairs).toFixed(2));
      winResults.trendPnlAvg = Number((sumTrend / countPairs).toFixed(2));
      winResults.trendMaxDdAvg = Number((sumTrendDd / countPairs).toFixed(2));
      winResults.trendGatedPnlAvg = Number((sumTrendGated / countPairs).toFixed(2));
      winResults.trendGatedMaxDdAvg = Number((sumTrendGatedDd / countPairs).toFixed(2));
      winResults.holdPnlAvg = Number((sumHold / countPairs).toFixed(2));
      fullReport.push(winResults);
    }
  }

  console.log("\n==========================================================================================");
  console.log("📊 120-DAY MULTI-STRATEGY EMPIRICAL COMPARISON TABLE");
  console.log("==========================================================================================");
  console.table(fullReport);
}

main().catch(console.error);
