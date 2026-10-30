import { BacktestService } from "../src/backtest-service.js";

async function testCoin(symbol: string) {
  try {
    const candles5m = await BacktestService.fetchBinanceCandles(symbol, "5m", 34560);
    const candles15m = await BacktestService.fetchBinanceCandles(symbol, "15m", 11520);

    const baseOpts = {
      symbol,
      timeframe: "5m",
      spreadThreshold: "auto" as const,
      initialCapital: 200,
      slBufferPct: 0.25,
      useRatchetSl: true,
      useAtrAdaptiveSpread: true,
      atrMultiplier: 1.25,
      trailingPullbackPct: 0.45,
      tp1Ratio: 0.5,
      breakevenFeeBufferPct: 0.05,
      supervisorTimeframe: "15m" as const,
      candlesHtf: candles15m,
      cushionMode: "off" as const,
      waterfallGuardMode: "combined" as const,
      costModel: { feePctPerSide: 0.075, slippagePctPerFill: 0.01 },
      enableUpsideFloor: true,
      enableCircuitBreaker: true,
      enableFastCut: true,
      fastCutThresholdPct: -0.80,
      stagnationBars: 6,
      maxSlPct: 1.80,
    };

    const runOff = BacktestService.runMaFanSimulation(candles5m, { ...baseOpts, macroGateMode: "off" });
    const runGate = BacktestService.runMaFanSimulation(candles5m, { ...baseOpts, macroGateMode: "noDeepBear" });

    return {
      symbol,
      off: runOff.summary,
      gate: runGate.summary,
    };
  } catch (err: any) {
    return { symbol, error: err.message };
  }
}

async function main() {
  console.log("Testing multiple coins across 120 days with Macro Gate comparison...\n");
  const coins = ["BNBUSDT", "SOLUSDT", "DOGEUSDT", "BTCUSDT"];

  for (const c of coins) {
    const res: any = await testCoin(c);
    if (res.error) {
      console.log(`${c}: Error - ${res.error}`);
      continue;
    }
    console.log(`=== ${c} (120 DAYS) ===`);
    console.log(`Macro OFF:   ${res.off.totalTrades} trades | WinRate: ${res.off.winRate.toFixed(1)}% | PnL: ${(res.off.netPnlPct > 0 ? "+" : "") + res.off.netPnlPct.toFixed(2)}% | PF: ${res.off.profitFactor.toFixed(2)} | MaxDD: -${res.off.maxDrawdownPct.toFixed(2)}%`);
    console.log(`NoDeepBear:  ${res.gate.totalTrades} trades | WinRate: ${res.gate.winRate.toFixed(1)}% | PnL: ${(res.gate.netPnlPct > 0 ? "+" : "") + res.gate.netPnlPct.toFixed(2)}% | PF: ${res.gate.profitFactor.toFixed(2)} | MaxDD: -${res.gate.maxDrawdownPct.toFixed(2)}%`);
    console.log("");
  }
}

main().catch(console.error);
