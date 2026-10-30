import { BacktestService } from "../src/backtest-service.js";

async function main() {
  console.log("Fetching 120-day data...");
  const [candles5m, candles15m] = await Promise.all([
    BacktestService.fetchBinanceCandles("HAEDALUSDT", "5m", 34560),
    BacktestService.fetchBinanceCandles("HAEDALUSDT", "15m", 11520),
  ]);

  const configs: Array<{ name: string; opts: any }> = [
    {
      name: "1. Baseline (Macro Off)",
      opts: { macroGateMode: "off" },
    },
    {
      name: "2. Macro Gate: No Deep Bear",
      opts: { macroGateMode: "noDeepBear" },
    },
    {
      name: "3. Macro Gate: Bull Only",
      opts: { macroGateMode: "bullOnly" },
    },
    {
      name: "4. HTF Cushion Mode (htfBull)",
      opts: { cushionMode: "htfBull", macroGateMode: "off" },
    },
    {
      name: "5. Min Spread 0.35% Fixed",
      opts: { spreadThreshold: 0.35, useAtrAdaptiveSpread: false },
    },
    {
      name: "6. Min Spread 0.40% Fixed",
      opts: { spreadThreshold: 0.40, useAtrAdaptiveSpread: false },
    },
    {
      name: "7. Auto Spread + No Deep Bear",
      opts: { macroGateMode: "noDeepBear", spreadThreshold: "auto" },
    },
  ];

  console.log("\n==========================================================================================");
  console.log("                           120-DAY PARAMETER EXPERIMENTS                                  ");
  console.log("==========================================================================================");
  console.log("Experiment Name".padEnd(32) + "Trades".padEnd(16) + "WinRate".padEnd(12) + "Net PnL %".padEnd(14) + "ProfitFactor".padEnd(16) + "Max DD");
  console.log("------------------------------------------------------------------------------------------");

  for (const cfg of configs) {
    const res = BacktestService.runMaFanSimulation(candles5m, {
      symbol: "HAEDALUSDT",
      timeframe: "5m",
      spreadThreshold: "auto",
      initialCapital: 200,
      slBufferPct: 0.25,
      useRatchetSl: true,
      useAtrAdaptiveSpread: true,
      atrMultiplier: 1.25,
      trailingPullbackPct: 0.45,
      tp1Ratio: 0.5,
      breakevenFeeBufferPct: 0.05,
      supervisorTimeframe: "15m",
      candlesHtf: candles15m,
      cushionMode: "off",
      waterfallGuardMode: "combined",
      costModel: { feePctPerSide: 0.075, slippagePctPerFill: 0.01 },
      macroGateMode: "off",
      enableUpsideFloor: true,
      enableCircuitBreaker: true,
      enableFastCut: true,
      fastCutThresholdPct: -0.80,
      stagnationBars: 6,
      maxSlPct: 1.80,
      ...cfg.opts,
    });

    const s = res.summary;
    const pnlSign = s.netPnlPct > 0 ? "+" : "";
    console.log(
      cfg.name.padEnd(32) +
      `${s.totalTrades} (${s.winTrades}W/${s.lossTrades}L)`.padEnd(16) +
      `${s.winRate.toFixed(1)}%`.padEnd(12) +
      `${pnlSign}${s.netPnlPct.toFixed(2)}%`.padEnd(14) +
      `${s.profitFactor.toFixed(2)}`.padEnd(16) +
      `-${s.maxDrawdownPct.toFixed(2)}%`
    );
  }

  // Deep dive into losing trades of Baseline
  console.log("\n==========================================================================================");
  console.log("                      DEEP DIVE: ALL 18 TRADES IN 120 DAYS                                ");
  console.log("==========================================================================================");
  const baseline = BacktestService.runMaFanSimulation(candles5m, {
    symbol: "HAEDALUSDT",
    timeframe: "5m",
    spreadThreshold: "auto",
    initialCapital: 200,
    slBufferPct: 0.25,
    useRatchetSl: true,
    useAtrAdaptiveSpread: true,
    atrMultiplier: 1.25,
    trailingPullbackPct: 0.45,
    tp1Ratio: 0.5,
    breakevenFeeBufferPct: 0.05,
    supervisorTimeframe: "15m",
    candlesHtf: candles15m,
    cushionMode: "off",
    waterfallGuardMode: "combined",
    costModel: { feePctPerSide: 0.075, slippagePctPerFill: 0.01 },
    macroGateMode: "off",
    enableUpsideFloor: true,
    enableCircuitBreaker: true,
    enableFastCut: true,
    fastCutThresholdPct: -0.80,
    stagnationBars: 6,
    maxSlPct: 1.80,
  });

  baseline.trades.forEach((t) => {
    const d = new Date(t.entryTime * 1000).toISOString().replace("T", " ").slice(0, 16);
    const pnlSign = t.pnlPct > 0 ? "+" : "";
    const pnlStr = (pnlSign + t.pnlPct.toFixed(2) + "%").padEnd(8);
    const winStr = t.pnlPct > 0 ? "WIN " : "LOSS";
    console.log(
      `Trade #${String(t.id).padStart(2)} [${d}] | ${winStr} | PnL: ${pnlStr} | Exit: ${t.exitType.padEnd(14)} | Bars: ${String(t.holdingBars).padStart(2)} | Entry: ${t.entryPrice.toFixed(4)} -> Exit: ${t.exitPrice.toFixed(4)}`
    );
  });
}

main().catch(console.error);
