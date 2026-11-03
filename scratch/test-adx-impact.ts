import { BacktestService } from "../src/backtest-service.js";
import { Candle } from "../src/strategy/ma-fan/types.js";
import { calcADXSingle } from "./test-adx-val.js";

interface SimResult {
  symbol: string;
  adx5m: number;
  adx1h: number;
  netPnlPct: number;
  maxDrawdownPct: number;
  winRate: number;
  trades: number;
  profitFactor: number;
}

async function runComprehensiveAdxTest() {
  console.log("====================================================================");
  console.log("📊 FORENSIC BACKTEST: Testing Impact of ADX Filter on Dynamic Grid");
  console.log("====================================================================");

  // 1. Fetch liquid USDT tickers
  const tickerRes = await fetch("https://api.binance.com/api/v3/ticker/24hr");
  const allTickers = await tickerRes.json();
  const usdtTickers = allTickers
    .filter((t: any) => t.symbol.endsWith("USDT") && !t.symbol.includes("UP") && !t.symbol.includes("DOWN"))
    .sort((a: any, b: any) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume));

  const targetSymbols = usdtTickers.slice(0, 40).map((t: any) => t.symbol);
  console.log(`Fetched top ${targetSymbols.length} USDT symbols by volume.`);

  const limit = 8640; // 30-day crash test (~8,640 bars of 5m)
  const results: SimResult[] = [];

  for (const sym of targetSymbols) {
    try {
      const candles = await BacktestService.fetchBinanceCandles(sym, "5m", limit);
      if (!candles || candles.length < 5000) continue;

      // Calculate current 5m ADX(14) and 1H ADX(14) at the end of the warmup/initial zone
      const adx5m = calcADXSingle(candles, candles.length - 1, 14);
      const c1h = BacktestService.aggregateCandles(candles, 60);
      const adx1h = c1h.length >= 28 ? calcADXSingle(c1h, c1h.length - 1, 14) : 0;

      // Run Dynamic Grid simulation on this coin
      const rec = BacktestService.runDynamicGridSimulation(candles, {
        symbol: sym,
        timeframe: "5m",
        initialCapital: 200,
        maxInventoryQuote: 200,
        capitalZones: 2,
        channelMode: "DONCHIAN_ATR",
        gridCutLossMode: "none",
        enableBaseConfirmationFilter: false,
        lockChannelInPosition: false,
        costModel: { feePctPerSide: 0.075, slippagePctPerFill: 0.01 },
      });

      results.push({
        symbol: sym,
        adx5m,
        adx1h,
        netPnlPct: rec.summary.netPnlPct,
        maxDrawdownPct: rec.summary.maxDrawdownPct,
        winRate: rec.summary.winRate,
        trades: rec.summary.totalTrades,
        profitFactor: rec.summary.profitFactor,
      });
      process.stdout.write(".");
    } catch (e) {
      // ignore
    }
  }

  console.log(`\nLoaded and simulated ${results.length} valid coins.\n`);

  // Analyze groups:
  // Group 1: All coins (No ADX filter)
  // Group 2: Coins with 5m ADX < 25 (Low trend / Sideways on 5m)
  // Group 3: Coins with 5m ADX >= 25 (Strong trend on 5m)
  // Group 4: Coins with 1H ADX < 25 (Low trend / Sideways on 1H macro)
  // Group 5: Coins with 1H ADX >= 25 (Strong trend on 1H macro)

  function summarize(name: string, list: SimResult[]) {
    if (list.length === 0) {
      console.log(`--- ${name}: 0 coins ---`);
      return;
    }
    const avgPnl = list.reduce((a, b) => a + b.netPnlPct, 0) / list.length;
    const avgDD = list.reduce((a, b) => a + b.maxDrawdownPct, 0) / list.length;
    const avgWinRate = list.reduce((a, b) => a + b.winRate, 0) / list.length;
    const winCoins = list.filter((c) => c.netPnlPct > 0).length;
    const winCoinPct = (winCoins / list.length) * 100;
    const avgPF = list.filter(c => isFinite(c.profitFactor)).reduce((a, b) => a + b.profitFactor, 0) / (list.filter(c => isFinite(c.profitFactor)).length || 1);

    console.log(`📌 ${name} (${list.length} coins):`);
    console.log(`   Avg Net PnL:        ${avgPnl >= 0 ? "+" : ""}${avgPnl.toFixed(2)}%`);
    console.log(`   Avg Max Drawdown:   ${avgDD.toFixed(2)}%`);
    console.log(`   Avg Win Rate:       ${avgWinRate.toFixed(1)}%`);
    console.log(`   Profitable Coins:   ${winCoins}/${list.length} (${winCoinPct.toFixed(1)}%)`);
    console.log(`   Avg Profit Factor:  ${avgPF.toFixed(2)}`);
    console.log("--------------------------------------------------------------------");
  }

  summarize("1. BASELINE (All Coins - No ADX filter)", results);
  summarize("2. 5M ADX < 25 (Sideways / Mean-Reverting)", results.filter(r => r.adx5m < 25));
  summarize("3. 5M ADX >= 25 (Trending / Momentum Breakout)", results.filter(r => r.adx5m >= 25));
  summarize("4. 1H ADX < 25 (Macro Range-Bound Sideways)", results.filter(r => r.adx1h < 25));
  summarize("5. 1H ADX >= 25 (Macro Strong Trend)", results.filter(r => r.adx1h >= 25));
  summarize("6. DUAL ADX (1H ADX < 25 AND 5M ADX < 25)", results.filter(r => r.adx1h < 25 && r.adx5m < 25));

  // Print top 5 best and top 5 worst
  const sorted = [...results].sort((a, b) => b.netPnlPct - a.netPnlPct);
  console.log("\n🏆 TOP 5 Performers in Dynamic Grid:");
  sorted.slice(0, 5).forEach((c, idx) => {
    console.log(`   ${idx + 1}. ${c.symbol}: PnL=${c.netPnlPct >= 0 ? "+" : ""}${c.netPnlPct.toFixed(2)}%, DD=${c.maxDrawdownPct.toFixed(2)}%, 5m ADX=${c.adx5m.toFixed(1)}, 1H ADX=${c.adx1h.toFixed(1)}`);
  });

  console.log("\n💥 WORST 5 Performers in Dynamic Grid:");
  sorted.slice(-5).reverse().forEach((c, idx) => {
    console.log(`   ${idx + 1}. ${c.symbol}: PnL=${c.netPnlPct.toFixed(2)}%, DD=${c.maxDrawdownPct.toFixed(2)}%, 5m ADX=${c.adx5m.toFixed(1)}, 1H ADX=${c.adx1h.toFixed(1)}`);
  });
}

runComprehensiveAdxTest().catch(console.error);
