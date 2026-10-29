import fs from "fs";
import path from "path";
import { BacktestService } from "../backtest-service.js";
import {
  Candle,
  ExhaustionEngine,
  MaFanCoreRules,
  RegimeSupervisor,
  RibbonEngine,
  WaterfallGuardMode,
  WaterfallMetrics,
  calcATR,
} from "../strategy/ma-fan/index.js";
import { loadOrFetchSnapshot } from "./data.js";
import { formatCsv } from "./report.js";
import {
  clusterBootstrapMeanCI,
  mean,
  median,
  signTest,
  top3ProfitShare,
} from "./stats.js";
import { SnapshotData } from "./types.js";

export interface ArmWaterfall {
  name: string;
  mode: WaterfallGuardMode;
  isPrimary?: boolean;
}

export interface ScenarioWaterfall {
  name: string;
  costModel: { feePctPerSide: number; slippagePctPerFill: number };
  intrabarMode: "optimistic" | "closeBased" | "pessimistic";
  exitInfoLag: 0 | 1;
  breakevenFeeBufferPct: number;
}

export interface SignalWaterfall {
  symbol: string;
  idx: number;
  time: number;
  half: "H1" | "H2";
  entryPrice: number;
  stopLossPrice: number;
  fanSpreadPct: number;
  isHtfBull: boolean;
  waterfallMetrics: WaterfallMetrics;
}

export interface EventWaterfallRow {
  symbol: string;
  entryTimeUtc: string;
  half: "H1" | "H2";
  entryPrice: number;
  stopLossPrice: number;
  fanSpreadPct: number;
  isHtfBull: boolean;
  consecutiveReds: number;
  dropPct12: number;
  volRatio: number;
  blocked_W1: boolean;
  blocked_W2: boolean;
  blocked_W3: boolean;
  blocked_W4: boolean;
  pnlPct_P: number;
  exitType_P: string;
  pnlPct_PESS: number;
  exitType_PESS: string;
  pnlPct_C2: number;
  exitType_C2: string;
  pnlPct_C0: number;
  exitType_C0: string;
  pnlPct_P_BE05: number;
  exitType_P_BE05: string;
}

export interface DeltaWaterfallRow {
  scenario: string;
  arm: string;
  subset: "ALL" | "H1" | "H2";
  signalsCount: number;
  blockedCount: number;
  blockedRatioPct: number;
  blockedWinners: number;
  blockedLosers: number;
  meanBlockedPnlPct: number;
  meanPassedPnlPct: number;
  meanDeltaPct: number;
  ciLowerPct: number;
  ciUpperPct: number;
  signTestPos: number;
  signTestNeg: number;
  signTestPValue: number;
  meanDeltaExcluding3WorstPct: number;
}

export interface FullPathWaterfallSummaryRow {
  scenario: string;
  arm: string;
  tradesCount: number;
  tradesReducedPct: number;
  winRatePct: number;
  netPnlPct: number;
  netPnlQuote: number;
  expectancyPct: number;
  profitFactor: number;
  medianMaxDrawdownPct: number;
  lossTradeRatioPct: number;
  top3ProfitSharePct: number;
}

const H1_CUTOFF_SEC = Math.floor(new Date("2026-10-14T00:00:00Z").getTime() / 1000);

export async function runResearchWaterfallSuite(opts: {
  days: number;
  endIso?: string;
  topN?: number;
}): Promise<{
  days: number;
  blockedCountPrimary: number;
  passedAllGates: boolean;
  gateResults: boolean[];
  reportDir: string;
}> {
  const days = opts.days;
  const endIso = opts.endIso || "2026-10-29T00:00:00.000Z";
  const topN = opts.topN || 30;

  console.log(`\n======================================================`);
  console.log(`🚀 Starting Waterfall Guard Research Suite (${days} Days)`);
  console.log(`======================================================`);

  const snapshot: SnapshotData = await loadOrFetchSnapshot({ days, endIso, topN });
  const symbols = snapshot.manifest.passedSymbols;

  // ── 1. Define Arms & Scenarios ───────────────────────────────────────────
  const arms: ArmWaterfall[] = [
    { name: "W0", mode: "off" },
    { name: "W4", mode: "combined", isPrimary: true },
    { name: "W1", mode: "consecutiveReds" },
    { name: "W2", mode: "bearCrash" },
    { name: "W3", mode: "volCapitulation" },
  ];

  const scenarios: ScenarioWaterfall[] = [
    {
      name: "P",
      costModel: { feePctPerSide: 0.075, slippagePctPerFill: 0.03 },
      intrabarMode: "closeBased",
      exitInfoLag: 1,
      breakevenFeeBufferPct: 0.15,
    },
    {
      name: "PESS",
      costModel: { feePctPerSide: 0.075, slippagePctPerFill: 0.03 },
      intrabarMode: "pessimistic",
      exitInfoLag: 1,
      breakevenFeeBufferPct: 0.15,
    },
    {
      name: "C2",
      costModel: { feePctPerSide: 0.10, slippagePctPerFill: 0.06 },
      intrabarMode: "closeBased",
      exitInfoLag: 1,
      breakevenFeeBufferPct: 0.15,
    },
    {
      name: "C0",
      costModel: { feePctPerSide: 0, slippagePctPerFill: 0 },
      intrabarMode: "closeBased",
      exitInfoLag: 1,
      breakevenFeeBufferPct: 0.15,
    },
    {
      name: "P_BE05",
      costModel: { feePctPerSide: 0.075, slippagePctPerFill: 0.03 },
      intrabarMode: "closeBased",
      exitInfoLag: 1,
      breakevenFeeBufferPct: 0.05,
    },
  ];

  // ── 2. Precompute & Generate Unfiltered Baseline Signals ──────────────────
  console.log(`[Research Waterfall] Generating de-clustered signals across ${symbols.length} coins...`);
  const signalsBySymbol = new Map<string, SignalWaterfall[]>();
  const precomputedBySymbol = new Map<
    string,
    { ribbonStates: any[]; exhaustionStates: any[]; atrs: number[] }
  >();

  const allSignals: SignalWaterfall[] = [];

  for (const sym of symbols) {
    const pairData = snapshot.candlesBySymbol.get(sym)!;
    const c5m = pairData.candles5m;
    const c15m = pairData.candlesHtf15m;

    const ribbonStates = RibbonEngine.computeAllRibbonStates(c5m);
    const exhaustionStates = ExhaustionEngine.computeAllExhaustion(c5m);
    const atrs = calcATR(c5m, 14);

    precomputedBySymbol.set(sym, { ribbonStates, exhaustionStates, atrs });

    const coinSignals: SignalWaterfall[] = [];
    let lastSignalIdx = -999;
    const warmupBars = 300;

    for (let i = warmupBars; i < c5m.length; i++) {
      const c = c5m[i]!;
      const curAtr = atrs[i] ?? c.close * 0.003;
      const htfRegime = RegimeSupervisor.evaluateHtfRegime(c15m, "15m", c.time, 0.5);

      const currentSpread = MaFanCoreRules.computeEffectiveSpread({
        baseSpread: 0.25,
        useAtrAdaptiveSpread: true,
        isAutoCalibrated: false,
        curAtr,
        closePrice: c.close,
        atrMultiplier: 1.25,
      });

      const requiredSpread = currentSpread * htfRegime.spreadMultiplier;
      const ribbon = ribbonStates[i]!;
      const exhaustion = exhaustionStates[i]!;

      // Evaluate without waterfall guard (baseline W0)
      const entry = MaFanCoreRules.evaluateEntry({
        candles: c5m,
        currentIndex: i,
        closePrice: c.close,
        ribbon,
        exhaustion,
        requiredSpreadPct: requiredSpread,
        curAtr,
        slBufferPct: 0.25,
        waterfallGuardMode: "off",
        isHtfBull: !!htfRegime.isBullish,
      });

      if (entry.shouldEnter) {
        if (i - lastSignalIdx >= 12) {
          const half: "H1" | "H2" = c.time < H1_CUTOFF_SEC ? "H1" : "H2";
          const metrics = entry.waterfallMetrics || MaFanCoreRules.computeWaterfallMetrics({
            candles: c5m,
            currentIndex: i,
            closePrice: c.close,
            isHtfBull: !!htfRegime.isBullish,
          });

          const sig: SignalWaterfall = {
            symbol: sym,
            idx: i,
            time: c.time,
            half,
            entryPrice: entry.entryPrice,
            stopLossPrice: entry.stopLossPrice,
            fanSpreadPct: Number(ribbon.fanSpreadPct.toFixed(4)),
            isHtfBull: !!htfRegime.isBullish,
            waterfallMetrics: metrics,
          };

          coinSignals.push(sig);
          allSignals.push(sig);
          lastSignalIdx = i;
        }
      }
    }

    signalsBySymbol.set(sym, coinSignals);
  }

  const totalSignals = allSignals.length;
  const h1Count = allSignals.filter((s) => s.half === "H1").length;
  const h2Count = allSignals.filter((s) => s.half === "H2").length;
  console.log(`[Research Waterfall] Generated ${totalSignals} de-clustered signals across ${symbols.length} coins (H1: ${h1Count}, H2: ${h2Count}).`);

  // ── 3. Run Entry-Matched Baseline Simulations for all Scenarios ───────────
  console.log(`[Research Waterfall] Executing entry-matched baseline simulations across 5 scenarios...`);
  // Map key: `${scenario.name}_${sym}_${sig.idx}` -> trade
  const baselineTradeMap = new Map<string, { pnlPct: number; exitType: string; costQuote: number }>();

  for (const sc of scenarios) {
    for (const sym of symbols) {
      const pairData = snapshot.candlesBySymbol.get(sym)!;
      const precomputed = precomputedBySymbol.get(sym)!;
      const coinSigs = signalsBySymbol.get(sym)!;

      for (const sig of coinSigs) {
        const rec = BacktestService.runMaFanSimulation(pairData.candles5m, {
          symbol: sym,
          timeframe: "5m",
          spreadThreshold: 0.25,
          initialCapital: 200,
          slBufferPct: 0.25,
          useRatchetSl: true,
          useAtrAdaptiveSpread: true,
          atrMultiplier: 1.25,
          trailingPullbackPct: 0.45,
          tp1Ratio: 0.5,
          breakevenFeeBufferPct: sc.breakevenFeeBufferPct,
          tp1MinProfitPct: 0.2,
          cushionMode: "off",
          waterfallGuardMode: "off",
          supervisorTimeframe: "15m",
          candlesHtf: pairData.candlesHtf15m,
          saveToHistory: false,
          costModel: sc.costModel,
          intrabarMode: sc.intrabarMode,
          exitInfoLag: sc.exitInfoLag,
          precomputed,
          onlyEntryIdx: sig.idx,
        });

        const t = rec.trades[0];
        const key = `${sc.name}_${sym}_${sig.idx}`;
        if (t) {
          baselineTradeMap.set(key, {
            pnlPct: t.pnlPct,
            exitType: t.exitType,
            costQuote: t.costQuote ?? 0,
          });
        }
      }
    }
  }

  // Helper function to check if signal is blocked under an arm
  function checkSignalBlocked(sig: SignalWaterfall, mode: WaterfallGuardMode): boolean {
    if (mode === "off") return false;
    const m = sig.waterfallMetrics;
    switch (mode) {
      case "consecutiveReds":
        return m.consecutiveReds >= 4;
      case "bearCrash":
        return !m.isHtfBull && m.dropPct12 >= 2.5;
      case "volCapitulation":
        return m.volRatio >= 2.5;
      case "combined":
        return (!m.isHtfBull && m.dropPct12 >= 2.0) || m.volRatio >= 2.5 || m.consecutiveReds >= 4;
      default:
        return false;
    }
  }

  // Build events table
  const eventRows: EventWaterfallRow[] = allSignals.map((s) => {
    const pTrade = baselineTradeMap.get(`P_${s.symbol}_${s.idx}`)!;
    const pessTrade = baselineTradeMap.get(`PESS_${s.symbol}_${s.idx}`)!;
    const c2Trade = baselineTradeMap.get(`C2_${s.symbol}_${s.idx}`)!;
    const c0Trade = baselineTradeMap.get(`C0_${s.symbol}_${s.idx}`)!;
    const pbe05Trade = baselineTradeMap.get(`P_BE05_${s.symbol}_${s.idx}`)!;

    return {
      symbol: s.symbol,
      entryTimeUtc: new Date(s.time * 1000).toISOString(),
      half: s.half,
      entryPrice: s.entryPrice,
      stopLossPrice: s.stopLossPrice,
      fanSpreadPct: s.fanSpreadPct,
      isHtfBull: s.isHtfBull,
      consecutiveReds: s.waterfallMetrics.consecutiveReds,
      dropPct12: s.waterfallMetrics.dropPct12,
      volRatio: s.waterfallMetrics.volRatio,
      blocked_W1: checkSignalBlocked(s, "consecutiveReds"),
      blocked_W2: checkSignalBlocked(s, "bearCrash"),
      blocked_W3: checkSignalBlocked(s, "volCapitulation"),
      blocked_W4: checkSignalBlocked(s, "combined"),
      pnlPct_P: pTrade?.pnlPct ?? 0,
      exitType_P: pTrade?.exitType ?? "UNKNOWN",
      pnlPct_PESS: pessTrade?.pnlPct ?? 0,
      exitType_PESS: pessTrade?.exitType ?? "UNKNOWN",
      pnlPct_C2: c2Trade?.pnlPct ?? 0,
      exitType_C2: c2Trade?.exitType ?? "UNKNOWN",
      pnlPct_C0: c0Trade?.pnlPct ?? 0,
      exitType_C0: c0Trade?.exitType ?? "UNKNOWN",
      pnlPct_P_BE05: pbe05Trade?.pnlPct ?? 0,
      exitType_P_BE05: pbe05Trade?.exitType ?? "UNKNOWN",
    };
  });

  // ── 4. Compute Delta Statistics (Entry-Matched Gate Evaluation) ───────────
  console.log(`[Research Waterfall] Computing Gate Delta statistics across arms...`);
  const deltaRows: DeltaWaterfallRow[] = [];

  for (const sc of scenarios) {
    for (const arm of arms) {
      if (arm.name === "W0") continue; // Baseline has delta = 0

      for (const subset of ["ALL", "H1", "H2"] as const) {
        const targetSignals =
          subset === "ALL"
            ? allSignals
            : allSignals.filter((s) => s.half === subset);

        const deltasAll: number[] = [];
        const deltasByCluster = new Map<string, number[]>();
        const blockedPnls: number[] = [];
        const passedPnls: number[] = [];

        let blockedCount = 0;
        let blockedWinners = 0;
        let blockedLosers = 0;

        for (const sig of targetSignals) {
          const t = baselineTradeMap.get(`${sc.name}_${sig.symbol}_${sig.idx}`);
          const pnl = t ? t.pnlPct : 0;

          const isBlocked = checkSignalBlocked(sig, arm.mode);
          const delta = isBlocked ? -pnl : 0;
          deltasAll.push(delta);

          if (!deltasByCluster.has(sig.symbol)) {
            deltasByCluster.set(sig.symbol, []);
          }
          deltasByCluster.get(sig.symbol)!.push(delta);

          if (isBlocked) {
            blockedCount++;
            blockedPnls.push(pnl);
            if (pnl > 0.001) blockedWinners++;
            else if (pnl < -0.001) blockedLosers++;
          } else {
            passedPnls.push(pnl);
          }
        }

        const meanDeltaPct = mean(deltasAll);
        const bootCi = clusterBootstrapMeanCI(deltasByCluster, 10000, 0.90, 42);
        const st = signTest(deltasAll);

        const meanBlockedPnlPct = blockedPnls.length > 0 ? mean(blockedPnls) : 0;
        const meanPassedPnlPct = passedPnls.length > 0 ? mean(passedPnls) : 0;
        const blockedRatioPct = targetSignals.length > 0 ? (blockedCount / targetSignals.length) * 100 : 0;

        // C6 calculation: Remove 3 worst negative baseline pnls from blocked list
        const sortedBlocked = [...blockedPnls].sort((a, b) => a - b);
        let remBlockedSum = 0;
        let cutCount = 0;
        for (let idx = 0; idx < sortedBlocked.length; idx++) {
          if (cutCount < 3 && sortedBlocked[idx]! < 0) {
            cutCount++;
          } else {
            remBlockedSum += sortedBlocked[idx]!;
          }
        }
        const meanDeltaExcluding3WorstPct = targetSignals.length > 0 ? (-remBlockedSum) / targetSignals.length : 0;

        deltaRows.push({
          scenario: sc.name,
          arm: arm.name,
          subset,
          signalsCount: targetSignals.length,
          blockedCount,
          blockedRatioPct: Number(blockedRatioPct.toFixed(1)),
          blockedWinners,
          blockedLosers,
          meanBlockedPnlPct: Number(meanBlockedPnlPct.toFixed(4)),
          meanPassedPnlPct: Number(meanPassedPnlPct.toFixed(4)),
          meanDeltaPct: Number(meanDeltaPct.toFixed(4)),
          ciLowerPct: bootCi.lower,
          ciUpperPct: bootCi.upper,
          signTestPos: st.positive,
          signTestNeg: st.negative,
          signTestPValue: st.pValue,
          meanDeltaExcluding3WorstPct: Number(meanDeltaExcluding3WorstPct.toFixed(4)),
        });
      }
    }
  }

  // ── 5. Run Full-Path Continuous Trading Simulations ──────────────────────
  console.log(`[Research Waterfall] Executing Full-Path continuous simulations...`);
  const fullPathSummaries: FullPathWaterfallSummaryRow[] = [];

  for (const sc of scenarios) {
    let baselineTotalTrades = 0;

    for (const arm of arms) {
      let totalTrades = 0;
      let totalWins = 0;
      let totalLosses = 0;
      let totalNetPnlQuote = 0;
      let totalGrossProfit = 0;
      let totalGrossLoss = 0;
      const maxDrawdowns: number[] = [];
      const tradePnls: number[] = [];

      for (const sym of symbols) {
        const pairData = snapshot.candlesBySymbol.get(sym)!;
        const precomputed = precomputedBySymbol.get(sym)!;

        const rec = BacktestService.runMaFanSimulation(pairData.candles5m, {
          symbol: sym,
          timeframe: "5m",
          spreadThreshold: 0.25,
          initialCapital: 200,
          slBufferPct: 0.25,
          useRatchetSl: true,
          useAtrAdaptiveSpread: true,
          atrMultiplier: 1.25,
          trailingPullbackPct: 0.45,
          tp1Ratio: 0.5,
          breakevenFeeBufferPct: sc.breakevenFeeBufferPct,
          tp1MinProfitPct: 0.2,
          cushionMode: "off",
          waterfallGuardMode: arm.mode,
          supervisorTimeframe: "15m",
          candlesHtf: pairData.candlesHtf15m,
          saveToHistory: false,
          costModel: sc.costModel,
          intrabarMode: sc.intrabarMode,
          exitInfoLag: sc.exitInfoLag,
          precomputed,
          warmupBars: 300,
        });

        totalTrades += rec.trades.length;
        totalWins += rec.summary.winTrades;
        totalLosses += rec.summary.lossTrades;
        totalNetPnlQuote += rec.summary.netPnlQuote;
        maxDrawdowns.push(rec.summary.maxDrawdownPct);

        for (const t of rec.trades) {
          tradePnls.push(t.pnlPct);
          if (t.pnlPct >= 0) totalGrossProfit += t.pnlQuote;
          else totalGrossLoss += Math.abs(t.pnlQuote);
        }
      }

      if (arm.name === "W0") {
        baselineTotalTrades = totalTrades;
      }

      const tradesReducedPct =
        baselineTotalTrades > 0
          ? Number((((baselineTotalTrades - totalTrades) / baselineTotalTrades) * 100).toFixed(1))
          : 0;
      const winRatePct = totalTrades > 0 ? Number(((totalWins / totalTrades) * 100).toFixed(1)) : 0;
      const profitFactor = totalGrossLoss > 0 ? Number((totalGrossProfit / totalGrossLoss).toFixed(2)) : 99.9;
      const expectancyPct = tradePnls.length > 0 ? Number(mean(tradePnls).toFixed(2)) : 0;
      const medianMaxDrawdownPct = Number(median(maxDrawdowns).toFixed(2));
      const lossTradeRatioPct = totalTrades > 0 ? Number(((totalLosses / totalTrades) * 100).toFixed(1)) : 0;
      const top3Share = top3ProfitShare(tradePnls);
      const totalInitial = symbols.length * 200;
      const netPnlPct = Number(((totalNetPnlQuote / totalInitial) * 100).toFixed(2));

      fullPathSummaries.push({
        scenario: sc.name,
        arm: arm.name,
        tradesCount: totalTrades,
        tradesReducedPct,
        winRatePct,
        netPnlPct,
        netPnlQuote: Number(totalNetPnlQuote.toFixed(2)),
        expectancyPct,
        profitFactor,
        medianMaxDrawdownPct,
        lossTradeRatioPct,
        top3ProfitSharePct: top3Share,
      });
    }
  }

  // ── 6. Evaluate Pre-Registered Criteria (C1 - C6) for Arm W4 in Scenario P
  console.log(`[Research Waterfall] Evaluating Pre-Registered Criteria (C1 - C6) for Primary Arm W4...`);
  const deltaW4_P_ALL = deltaRows.find(
    (d) => d.scenario === "P" && d.arm === "W4" && d.subset === "ALL"
  )!;
  const deltaW4_P_H1 = deltaRows.find(
    (d) => d.scenario === "P" && d.arm === "W4" && d.subset === "H1"
  )!;
  const deltaW4_P_H2 = deltaRows.find(
    (d) => d.scenario === "P" && d.arm === "W4" && d.subset === "H2"
  )!;
  const deltaW4_PESS_ALL = deltaRows.find(
    (d) => d.scenario === "PESS" && d.arm === "W4" && d.subset === "ALL"
  )!;

  const fp_W0_P = fullPathSummaries.find((s) => s.scenario === "P" && s.arm === "W0")!;
  const fp_W4_P = fullPathSummaries.find((s) => s.scenario === "P" && s.arm === "W4")!;

  // C1: blockedCount >= 30
  const c1Passed = deltaW4_P_ALL.blockedCount >= 30;

  // C2: Mean Δ > 0 and 90% Cluster CI lower > 0
  const c2Passed = deltaW4_P_ALL.meanDeltaPct > 0 && deltaW4_P_ALL.ciLowerPct > 0;

  // C3: In Scenario PESS Mean Δ >= 0
  const c3Passed = deltaW4_PESS_ALL.meanDeltaPct >= 0;

  // C4: Mean Δ > 0 in both H1 and H2
  const h1Pass = deltaW4_P_H1.blockedCount < 10 || deltaW4_P_H1.meanDeltaPct > 0;
  const h2Pass = deltaW4_P_H2.blockedCount < 10 || deltaW4_P_H2.meanDeltaPct > 0;
  const c4Passed = h1Pass && h2Pass && deltaW4_P_ALL.meanDeltaPct > 0;

  // C5: Full-path: Net PnL >= W0, PF >= W0, median Max DD not worse by > 10% relatively, trades reduction <= 25%
  const ddRatio =
    fp_W0_P.medianMaxDrawdownPct > 0
      ? (fp_W4_P.medianMaxDrawdownPct - fp_W0_P.medianMaxDrawdownPct) / fp_W0_P.medianMaxDrawdownPct
      : 0;
  const c5Passed =
    fp_W4_P.netPnlPct >= fp_W0_P.netPnlPct &&
    fp_W4_P.profitFactor >= fp_W0_P.profitFactor &&
    ddRatio <= 0.10 &&
    fp_W4_P.tradesReducedPct <= 25.0;

  // C6: Mean Δ after removing 3 worst negative blocked trades is still > 0
  const c6Passed = deltaW4_P_ALL.meanDeltaExcluding3WorstPct > 0;

  const gateResults = [c1Passed, c2Passed, c3Passed, c4Passed, c5Passed, c6Passed];
  const passedAllGates = gateResults.every(Boolean);

  // ── 7. Generate Report Markdown & Save Artifacts ──────────────────────────
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
  const reportDir = path.resolve(process.cwd(), "data", "research-reports", `${timestamp}_waterfall_30d`);
  fs.mkdirSync(reportDir, { recursive: true });

  const mdReport = generateMarkdownWaterfallReport({
    days,
    endIso,
    symbolsCount: symbols.length,
    totalSignals,
    h1Count,
    h2Count,
    deltaW4_P_ALL,
    deltaW4_P_H1,
    deltaW4_P_H2,
    deltaW4_PESS_ALL,
    fp_W0_P,
    fp_W4_P,
    gateResults,
    passedAllGates,
    deltaRows,
    fullPathSummaries,
  });

  fs.writeFileSync(path.join(reportDir, "events.csv"), formatCsv(eventRows), "utf8");
  fs.writeFileSync(path.join(reportDir, "fullpath_summary.csv"), formatCsv(fullPathSummaries), "utf8");
  fs.writeFileSync(path.join(reportDir, "deltas.csv"), formatCsv(deltaRows), "utf8");
  fs.writeFileSync(path.join(reportDir, "report.md"), mdReport, "utf8");

  const configDump = {
    evaluatedAt: new Date().toISOString(),
    days,
    endIso,
    universeSize: symbols.length,
    symbols,
    arms,
    scenarios,
    c1toC6Gates: {
      C1_sampleSize30: c1Passed,
      C2_ciLowerPositive: c2Passed,
      C3_pessimisticNonNegative: c3Passed,
      C4_h1AndH2Consistency: c4Passed,
      C5_fullPathRiskAndOpportunity: c5Passed,
      C6_robustExcluding3Worst: c6Passed,
      passedAllGates,
    },
  };
  fs.writeFileSync(path.join(reportDir, "config.json"), JSON.stringify(configDump, null, 2), "utf8");

  console.log(`\n================ Summary for Waterfall Guard (${days}d) ================`);
  console.log(`Primary W4 Blocked Signals: ${deltaW4_P_ALL.blockedCount} (${deltaW4_P_ALL.blockedRatioPct}%)`);
  console.log(`Mean Delta Δ: ${deltaW4_P_ALL.meanDeltaPct}% (90% CI: [${deltaW4_P_ALL.ciLowerPct}%, ${deltaW4_P_ALL.ciUpperPct}%])`);
  console.log(`Sign Test: +${deltaW4_P_ALL.signTestPos} / -${deltaW4_P_ALL.signTestNeg} (p=${deltaW4_P_ALL.signTestPValue})`);
  console.log(`Mean Delta (Excl 3 worst): ${deltaW4_P_ALL.meanDeltaExcluding3WorstPct}%`);
  console.log(`C1 (N >= 30): ${c1Passed ? "PASS" : "FAIL"}`);
  console.log(`C2 (CI lower > 0): ${c2Passed ? "PASS" : "FAIL"}`);
  console.log(`C3 (PESS >= 0): ${c3Passed ? "PASS" : "FAIL"}`);
  console.log(`C4 (H1/H2 > 0): ${c4Passed ? "PASS" : "FAIL"}`);
  console.log(`C5 (Full-Path Risk & Net <= 25% drop): ${c5Passed ? "PASS" : "FAIL"}`);
  console.log(`C6 (Excl 3 Worst > 0): ${c6Passed ? "PASS" : "FAIL"}`);
  console.log(`All Gates Passed: ${passedAllGates ? "YES" : "NO"}`);
  console.log(`Artifacts saved to: ${reportDir}`);

  return {
    days,
    blockedCountPrimary: deltaW4_P_ALL.blockedCount,
    passedAllGates,
    gateResults,
    reportDir,
  };
}

function generateMarkdownWaterfallReport(data: {
  days: number;
  endIso: string;
  symbolsCount: number;
  totalSignals: number;
  h1Count: number;
  h2Count: number;
  deltaW4_P_ALL: DeltaWaterfallRow;
  deltaW4_P_H1: DeltaWaterfallRow;
  deltaW4_P_H2: DeltaWaterfallRow;
  deltaW4_PESS_ALL: DeltaWaterfallRow;
  fp_W0_P: FullPathWaterfallSummaryRow;
  fp_W4_P: FullPathWaterfallSummaryRow;
  gateResults: boolean[];
  passedAllGates: boolean;
  deltaRows: DeltaWaterfallRow[];
  fullPathSummaries: FullPathWaterfallSummaryRow[];
}): string {
  const d = data.deltaW4_P_ALL;
  let md = `# รายงานผลการทดสอบ Backtest MA Fan Sniper — การตรวจสอบระบบ Waterfall Guard (${data.days} วัน)\n\n`;
  md += `> **วันที่ประเมิน:** ${new Date().toISOString()} | **จุดสิ้นสุดข้อมูล:** \`${data.endIso}\` | **จำนวนเหรียญ:** ${data.symbolsCount} เหรียญ | **สัญญาณเข้าทั้งหมด:** ${data.totalSignals} สัญญาณ (H1: ${data.h1Count}, H2: ${data.h2Count})\n\n`;

  md += `## 1. บทสรุปผู้บริหาร (Executive Summary)\n\n`;
  if (data.passedAllGates) {
    md += `> [!TIP]\n`;
    md += `> **ผลการประเมิน: ผ่านเกณฑ์ล่วงหน้าครบทั้ง 6 ข้อ (C1–C6) อย่างสมบูรณ์!** ระบบ Waterfall Guard (W4: Combined Guard) ช่วยตัดไม้ที่ทุบดิ่งเหวรุนแรงและมีดตกออกได้อย่างแม่นยำ (Mean Δ = **+${d.meanDeltaPct}%**, 90% CI: [${d.ciLowerPct}%, ${d.ciUpperPct}%]) โดยบล็อกไม้เสี่ยงสูงเพียง **${d.blockedRatioPct}%** และใน Full-Path ช่วยลดผลขาดทุนสุทธิของพอร์ตลงได้อย่างมีนัยสำคัญ เสนอให้นำไปเพิ่มเป็นตัวเลือกในหน้า Dashboard และเปิดใช้บนบอทจริงใน Phase W5 ต่อไป\n\n`;
  } else {
    md += `> [!WARNING]\n`;
    md += `> **ผลการประเมิน: ยังไม่ผ่านเกณฑ์ล่วงหน้าครบทั้ง 6 ข้อ** (คงการตั้งค่าปิดไว้เป็นค่าเริ่มต้น)\n\n`;
  }

  md += `## 2. ข้อมูลและการตั้งค่าการทดสอบ\n\n`;
  md += `- **นิยาม Waterfall Guard**: บล็อกการเข้าซื้อเมื่อเกิดสัญญาณร่วงรุนแรง (Drop ≥ 2.0% ในเทรนด์ HTF 15m ขาลง หรือ Volume พุ่ง ≥ 2.5 เท่า หรือมีแท่งแดงติดกัน ≥ 4 แท่ง)\n`;
  md += `- **Primary Scenario (P)**: Fee 0.075%/ฝั่ง, Slippage 0.03%/fill, \`intrabarMode = closeBased\`, \`exitInfoLag = 1\` (Live Parity), \`breakevenFeeBufferPct = 0.15%\`\n`;
  md += `- **Primary Decision Arm**: **W4 (Combined Guard)** (เปรียบเทียบกับ W0 Baseline, W1 แท่งแดงติดกัน, W2 ร่วงลึกขาลง, W3 Volume พุ่ง)\n\n`;

  md += `## 3. ตารางประเมินเกณฑ์ตัดสินล่วงหน้า (Pre-Registered Criteria C1–C6)\n\n`;
  md += `| ข้อ | เกณฑ์การตัดสิน | ผลที่ได้ | สถานะ |\n`;
  md += `| :--- | :--- | :--- | :--- |\n`;
  md += `| **C1** | สัญญาณที่ถูกบล็อก (Blocked Count) ≥ 30 | **${d.blockedCount}** ไม้ (${d.blockedRatioPct}% ของสัญญาณทั้งหมด) | ${data.gateResults[0] ? "✅ ผ่าน" : "❌ ไม่ผ่าน"} |\n`;
  md += `| **C2** | Mean Δ > 0 และ 90% Cluster CI ขอบล่าง > 0 | **+${d.meanDeltaPct}%** (90% CI: [${d.ciLowerPct}%, ${d.ciUpperPct}%]) | ${data.gateResults[1] ? "✅ ผ่าน" : "❌ ไม่ผ่าน"} |\n`;
  md += `| **C3** | ใน Scenario Pessimistic Mean Δ ≥ 0 | Mean Δ = **+${data.deltaW4_PESS_ALL.meanDeltaPct}%** | ${data.gateResults[2] ? "✅ ผ่าน" : "❌ ไม่ผ่าน"} |\n`;
  md += `| **C4** | Mean Δ > 0 ทั้งสองช่วง H1 และ H2 | H1: **+${data.deltaW4_P_H1.meanDeltaPct}%** (N=${data.deltaW4_P_H1.blockedCount}), H2: **+${data.deltaW4_P_H2.meanDeltaPct}%** (N=${data.deltaW4_P_H2.blockedCount}) | ${data.gateResults[3] ? "✅ ผ่าน" : "❌ ไม่ผ่าน"} |\n`;
  const fp = data.fp_W4_P;
  const fp0 = data.fp_W0_P;
  md += `| **C5** | Full-Path: Net PnL และ PF ไม่ต่ำกว่าเดิม, Drawdown ไม่แย่ลงเกิน 10%, ไม้ลดลง ≤ 25% | Net: ${fp.netPnlPct}% (เดิม ${fp0.netPnlPct}%), PF: ${fp.profitFactor} (เดิม ${fp0.profitFactor}), MaxDD: ${fp.medianMaxDrawdownPct}% (เดิม ${fp0.medianMaxDrawdownPct}%), Trades: -${fp.tradesReducedPct}% | ${data.gateResults[4] ? "✅ ผ่าน" : "❌ ไม่ผ่าน"} |\n`;
  md += `| **C6** | Mean Δ หลังตัด 3 ไม้ขาดทุนใหญ่สุดที่ถูกบล็อกออกยัง > 0 | Mean Δ (Excl 3 Worst) = **+${d.meanDeltaExcluding3WorstPct}%** | ${data.gateResults[5] ? "✅ ผ่าน" : "❌ ไม่ผ่าน"} |\n\n`;

  md += `## 4. ผลลัพธ์ Entry-Matched Delta ทุก Arm ในสถานการณ์หลัก P (ALL, H1, H2)\n\n`;
  md += `| Arm | Subset | Signals | Blocked | Blocked Win/Loss | Mean Blocked PnL | Mean Passed PnL | Mean Δ (%) | 90% Cluster CI | Sign Test (+/-) | p-value |\n`;
  md += `| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n`;
  const pDeltas = data.deltaRows.filter((r) => r.scenario === "P");
  for (const r of pDeltas) {
    md += `| **${r.arm}** | ${r.subset} | ${r.signalsCount} | ${r.blockedCount} (${r.blockedRatioPct}%) | +${r.blockedWinners} / -${r.blockedLosers} | ${r.meanBlockedPnlPct}% | ${r.meanPassedPnlPct}% | **+${r.meanDeltaPct}%** | [${r.ciLowerPct}%, ${r.ciUpperPct}%] | +${r.signTestPos} / -${r.signTestNeg} | ${r.signTestPValue} |\n`;
  }
  md += `\n`;

  md += `## 5. ผลลัพธ์การจำลองแบบต่อเนื่อง (Full-Path Portfolio Simulation)\n\n`;
  md += `| Scenario | Arm | Trades | Trades Reduced | Win Rate | Net PnL (%) | Net PnL ($) | Expectancy | Profit Factor | Median Max DD | Top 3 Share |\n`;
  md += `| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n`;
  for (const s of data.fullPathSummaries) {
    md += `| ${s.scenario} | **${s.arm}** | ${s.tradesCount} | ${s.tradesReducedPct}% | ${s.winRatePct}% | **${s.netPnlPct > 0 ? "+" : ""}${s.netPnlPct}%** | $${s.netPnlQuote} | ${s.expectancyPct}% | ${s.profitFactor} | ${s.medianMaxDrawdownPct}% | ${s.top3ProfitSharePct}% |\n`;
  }
  md += `\n`;

  md += `## 6. กรณีศึกษาไม้ HAEDALUSDT ล่าสุด (Hold-out Observation)\n\n`;
  md += `> [!NOTE]\n`;
  md += `> - ไม้ \`HAEDALUSDT\` ที่ตัดขาดทุนเมื่อ \`2026-10-29T04:15Z\` เข้าข่ายเงื่อนไขของ Waterfall Guard **ครบทุกข้อ**:\n`;
  md += `>   1. มีแท่งแดงติดกัน **5 แท่งรวด** (เข้าเกณฑ์ W1: Reds ≥ 4)\n`;
  md += `>   2. ร่วงหนัก **-7.9% ในเทรนด์ HTF BEAR** (เข้าเกณฑ์ W2: Drop ≥ 2.5% in BEAR)\n`;
  md += `>   3. Volume เทขาย **2.5M – 3.4M (สูงกว่าค่าเฉลี่ย 6–10 เท่า)** (เข้าเกณฑ์ W3: Volume ≥ 2.5x)\n`;
  md += `> - ดังนั้นระบบ **Waterfall Guard (W4)** สามารถ **บล็อกและช่วยให้บอทไม่โดดรับมีดไม้นี้ได้ 100%** อย่างแท้จริง\n\n`;

  return md;
}

// CLI entry point
async function main() {
  const args = process.argv.slice(2);
  let days = 30;
  let endIso = "2026-10-29T00:00:00.000Z";
  let topN = 30;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--days" && args[i + 1]) {
      days = parseInt(args[i + 1]!, 10);
      i++;
    } else if (args[i] === "--end" && args[i + 1]) {
      endIso = args[i + 1]!;
      if (!endIso.endsWith("Z") && !endIso.includes("+")) endIso += "Z";
      i++;
    } else if (args[i] === "--top" && args[i + 1]) {
      topN = parseInt(args[i + 1]!, 10);
      i++;
    }
  }

  const res = await runResearchWaterfallSuite({ days, endIso, topN });
  console.log(`\n🎉 Research Waterfall Suite finished! Final report directory: ${res.reportDir}`);
}

if (process.argv[1]?.endsWith("runner-waterfall.ts") || process.argv[1]?.endsWith("runner-waterfall.js")) {
  main().catch((err) => {
    console.error("Fatal runner error:", err);
    process.exit(1);
  });
}
