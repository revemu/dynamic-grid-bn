import { BacktestService } from "../src/backtest-service.js";
import { isSyntheticOrStock } from "../src/pair-rotator.js";

async function testOptimalAdjustments() {
  console.log("=== Testing Adjusted MA-Fan Portfolio Settings on 120-Day Dataset (34,560 bars) ===");

  const TOXIC_TOKENS = new Set([
    "MARSCOINUSDT", "1000CATUSDT", "TRUMPUSDT", "HAEDALUSDT", "SOXLBUSDT", "SNDKBUSDT", 
    "CRCLBUSDT", "INTCBUSDT", "GOOGLBUSDT", "MSTRBUSDT", "QQQBUSDT", "SKHYBUSDT", "SPCXBUSDT", 
    "TQQQBUSDT", "PAXGUSDT", "XAUTUSDT", "BFUSDUSDT", "USDEUSDT", "RWUSDUSDT", "UUSDT"
  ]);

  // Test matrix:
  // 1. SL: 3.0%, 3.5%, 4.0%, 5.0%
  // 2. TP1: "none" (Full Bullish Fan) vs "EMA200"
  // 3. Blacklist toxic coins

  for (const tpMode of ["none", "EMA200"]) {
    for (const sl of [3.0, 3.5, 4.0, 5.0]) {
      const res = await BacktestService.runMaFanPortfolioRotationWrapper({
        portfolioMode: "mafan_portfolio",
        quoteAsset: "USDT",
        maxUniversePairs: 50,
        limit: 34560,
        initialCapital: 200,
        maxSlots: 3,
        tp1TargetMode: tpMode === "none" ? "none" : "EMA200",
        lockBreakevenAtEma200: tpMode !== "none",
        partialTpAtEma200: tpMode !== "none",
        maxDisasterSlPct: sl,
        downtrendSitOutMode: "dual",
        rankBy: "COMPOSITE_QUALITY",
        blacklist: Array.from(TOXIC_TOKENS),
      });

      const netQuote = res.summary.netPnlQuote;
      const netPct = res.summary.netPnlPct;
      const wr = res.summary.tradeWinRate;
      const maxDd = res.summary.maxPortfolioDrawdownPct;
      const pf = res.summary.profitFactor;
      const trades = res.summary.totalTrades;

      console.log(`TP: ${tpMode.padEnd(6)} | SL: ${sl}% | Net: ${netPct >= 0 ? "+" : ""}${netPct.toFixed(2)}% ($${netQuote.toFixed(2)}) | WR: ${wr.toFixed(1)}% | DD: -${maxDd.toFixed(2)}% | PF: ${pf.toFixed(2)} | Trd: ${trades}`);
    }
  }
}

testOptimalAdjustments().catch(console.error);
