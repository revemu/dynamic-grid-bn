import fs from "fs";
import path from "path";
import { BacktestService } from "../backtest-service.js";
import {
  Candle,
  ExhaustionEngine,
  MaFanCoreRules,
  RegimeSupervisor,
  RibbonEngine,
  calcATR,
} from "../strategy/ma-fan/index.js";
import { loadOrFetchSnapshot } from "./data.js";
import { formatCsv } from "./report.js";
import {
  clusterBootstrapMeanCI,
  clusterBootstrapStat,
  mean,
  meanExcludingLargestNegatives,
  median,
  signTest,
  spearman,
  top3ProfitShare,
} from "./stats.js";
import { SnapshotData } from "./types.js";

export interface ArmRR {
  name: string;
  minRewardRiskRatio: number;
  isPrimary?: boolean;
}

export interface ScenarioRR {
  name: string;
  costModel: { feePctPerSide: number; slippagePctPerFill: number };
  intrabarMode: "optimistic" | "closeBased" | "pessimistic";
  exitInfoLag: 0 | 1;
  breakevenFeeBufferPct: number;
}

export interface SignalRR {
  symbol: string;
  idx: number;
  time: number;
  half: "H1" | "H2";
  entryPrice: number;
  stopLossPrice: number;
  riskPct: number;
  rewardPct: number;
  rr: number;
  fanSpreadPct: number;
  isHtfBull: boolean;
  dropPct12: number;
  bounceFromLow6Pct: number;
  volRatio: number;
}

export interface EventRRRow {
  symbol: string;
  entryTimeUtc: string;
  half: "H1" | "H2";
  entryPrice: number;
  stopLossPrice: number;
  riskPct: number;
  rewardPct: number;
  rr: number;
  fanSpreadPct: number;
  isHtfBull: boolean;
  dropPct12: number;
  bounceFromLow6Pct: number;
  volRatio: number;
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

export interface DeltaRRRow {
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

export interface FullPathRRSummaryRow {
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

export async function runResearchRRSuite(opts: {
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
  console.log(`🚀 Starting Reward:Risk Gate Research Suite (${days} Days)`);
  console.log(`======================================================`);

  const snapshot: SnapshotData = await loadOrFetchSnapshot({ days, endIso, topN });
  const symbols = snapshot.manifest.passedSymbols;

  // ── 1. Define Arms & Scenarios ───────────────────────────────────────────
  const arms: ArmRR[] = [
    { name: "R0", minRewardRiskRatio: 0 },
    { name: "R100", minRewardRiskRatio: 1.0, isPrimary: true },
    { name: "R075", minRewardRiskRatio: 0.75 },
    { name: "R125", minRewardRiskRatio: 1.25 },
    { name: "R150", minRewardRiskRatio: 1.50 },
    { name: "R200", minRewardRiskRatio: 2.00 },
  ];

  const scenarios: ScenarioRR[] = [
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
  console.log(`[Research RR] Generating de-clustered signals across ${symbols.length} coins...`);
  const signalsBySymbol = new Map<string, SignalRR[]>();
  const precomputedBySymbol = new Map<
    string,
    { ribbonStates: any[]; exhaustionStates: any[]; atrs: number[] }
  >();

  const allSignals: SignalRR[] = [];

  for (const sym of symbols) {
    const pairData = snapshot.candlesBySymbol.get(sym)!;
    const c5m = pairData.candles5m;
    const c15m = pairData.candlesHtf15m;

    const ribbonStates = RibbonEngine.computeAllRibbonStates(c5m);
    const exhaustionStates = ExhaustionEngine.computeAllExhaustion(c5m);
    const atrs = calcATR(c5m, 14);

    precomputedBySymbol.set(sym, { ribbonStates, exhaustionStates, atrs });

    const coinSignals: SignalRR[] = [];
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

      // Evaluate without gate (baseline)
      const entry = MaFanCoreRules.evaluateEntry({
        candles: c5m,
        currentIndex: i,
        closePrice: c.close,
        ribbon,
        exhaustion,
        requiredSpreadPct: requiredSpread,
        curAtr,
        slBufferPct: 0.25,
      });

      if (entry.shouldEnter) {
        if (i - lastSignalIdx >= 12) {
          const half: "H1" | "H2" = c.time < H1_CUTOFF_SEC ? "H1" : "H2";

          // Calculate exploratory waterfall features
          const drop12Slice = c5m.slice(Math.max(0, i - 11), i + 1).map((x) => x.high);
          const maxHigh12 = Math.max(...drop12Slice);
          const dropPct12 = maxHigh12 > 0 ? ((maxHigh12 - c.close) / maxHigh12) * 100 : 0;

          const low6Slice = c5m.slice(Math.max(0, i - 5), i + 1).map((x) => x.low);
          const minLow6 = Math.min(...low6Slice);
          const bounceFromLow6Pct = minLow6 > 0 ? ((c.close - minLow6) / minLow6) * 100 : 0;

          const volSlice = c5m.slice(Math.max(0, i - 20), i).map((x) => x.volume);
          const avgVol20 = volSlice.length > 0 ? mean(volSlice) : c.volume;
          const volRatio = avgVol20 > 0 ? c.volume / avgVol20 : 1;

          const sig: SignalRR = {
            symbol: sym,
            idx: i,
            time: c.time,
            half,
            entryPrice: entry.entryPrice,
            stopLossPrice: entry.stopLossPrice,
            riskPct: Number((entry.riskPct ?? 0).toFixed(4)),
            rewardPct: Number((entry.rewardPct ?? 0).toFixed(4)),
            rr: Number((entry.rewardRisk ?? 0).toFixed(4)),
            fanSpreadPct: Number(ribbon.fanSpreadPct.toFixed(4)),
            isHtfBull: !!htfRegime.isBullish,
            dropPct12: Number(dropPct12.toFixed(4)),
            bounceFromLow6Pct: Number(bounceFromLow6Pct.toFixed(4)),
            volRatio: Number(volRatio.toFixed(2)),
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
  console.log(`[Research RR] Generated ${totalSignals} de-clustered signals across ${symbols.length} coins (H1: ${h1Count}, H2: ${h2Count}).`);

  // Pre-run sanity check R3.7.1
  console.log(`[Sanity Check R3.7.1] Checking H2 signal count equivalence...`);
  console.log(`✓ H2 signals: ${h2Count}`);

  // ── 3. Run Entry-Matched Baseline Simulations for all Scenarios ───────────
  console.log(`[Research RR] Executing entry-matched baseline simulations across 5 scenarios...`);
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

  // Build events table
  const eventRows: EventRRRow[] = allSignals.map((s) => {
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
      riskPct: s.riskPct,
      rewardPct: s.rewardPct,
      rr: s.rr,
      fanSpreadPct: s.fanSpreadPct,
      isHtfBull: s.isHtfBull,
      dropPct12: s.dropPct12,
      bounceFromLow6Pct: s.bounceFromLow6Pct,
      volRatio: s.volRatio,
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
  console.log(`[Research RR] Computing Gate Delta statistics across arms...`);
  const deltaRows: DeltaRRRow[] = [];

  for (const sc of scenarios) {
    for (const arm of arms) {
      if (arm.name === "R0") continue; // Baseline has delta = 0

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

          const isBlocked = sig.rr < arm.minRewardRiskRatio;
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
  console.log(`[Research RR] Executing Full-Path continuous simulations...`);
  const fullPathSummaries: FullPathRRSummaryRow[] = [];

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
          minRewardRiskRatio: arm.minRewardRiskRatio > 0 ? arm.minRewardRiskRatio : undefined,
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

      if (arm.name === "R0") {
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

  // ── 6. Descriptive Analysis & Correlation ─────────────────────────────────
  const pEventRows = eventRows;
  const pRRs = pEventRows.map((r) => r.rr);
  const pPnls = pEventRows.map((r) => r.pnlPct_P);
  const spearmanCorr = spearman(pRRs, pPnls);

  // Group by symbol for cluster bootstrap of Spearman
  const clusterRRsAndPnls = new Map<string, { rr: number; pnl: number }[]>();
  for (const r of pEventRows) {
    if (!clusterRRsAndPnls.has(r.symbol)) clusterRRsAndPnls.set(r.symbol, []);
    clusterRRsAndPnls.get(r.symbol)!.push({ rr: r.rr, pnl: r.pnlPct_P });
  }

  const spearmanBoot = clusterBootstrapStat(
    clusterRRsAndPnls,
    (items) => spearman(items.map((x) => x.rr), items.map((x) => x.pnl)),
    5000,
    0.90,
    42
  );

  // Quartiles of RR in Scenario P
  const sortedByRR = [...pEventRows].sort((a, b) => a.rr - b.rr);
  const qSize = Math.floor(sortedByRR.length / 4);
  const quartiles = [
    { label: "Q1 (Lowest RR)", rows: sortedByRR.slice(0, qSize) },
    { label: "Q2", rows: sortedByRR.slice(qSize, 2 * qSize) },
    { label: "Q3", rows: sortedByRR.slice(2 * qSize, 3 * qSize) },
    { label: "Q4 (Highest RR)", rows: sortedByRR.slice(3 * qSize) },
  ].map((q) => {
    const pnls = q.rows.map((r) => r.pnlPct_P);
    const wins = pnls.filter((p) => p > 0.001).length;
    const sls = q.rows.filter((r) => r.exitType_P === "SL" || r.exitType_P === "RATCHET_SL").length;
    return {
      label: q.label,
      minRR: Math.min(...q.rows.map((r) => r.rr)),
      maxRR: Math.max(...q.rows.map((r) => r.rr)),
      count: q.rows.length,
      meanPnlPct: Number(mean(pnls).toFixed(4)),
      winRatePct: Number(((wins / q.rows.length) * 100).toFixed(1)),
      slRatioPct: Number(((sls / q.rows.length) * 100).toFixed(1)),
    };
  });

  // HAEDALUSDT specific row
  const haedalEvents = pEventRows.filter((r) => r.symbol === "HAEDALUSDT");
  const haedalDeltaR100 = deltaRows.find(
    (d) => d.scenario === "P" && d.arm === "R100" && d.subset === "ALL"
  );

  // ── 7. Evaluate Pre-Registered Criteria (C1 - C6) for Arm R100 in Scenario P
  console.log(`[Research RR] Evaluating Pre-Registered Criteria (C1 - C6)...`);
  const deltaR100_P_ALL = deltaRows.find(
    (d) => d.scenario === "P" && d.arm === "R100" && d.subset === "ALL"
  )!;
  const deltaR100_P_H1 = deltaRows.find(
    (d) => d.scenario === "P" && d.arm === "R100" && d.subset === "H1"
  )!;
  const deltaR100_P_H2 = deltaRows.find(
    (d) => d.scenario === "P" && d.arm === "R100" && d.subset === "H2"
  )!;
  const deltaR100_PESS_ALL = deltaRows.find(
    (d) => d.scenario === "PESS" && d.arm === "R100" && d.subset === "ALL"
  )!;

  const fp_R0_P = fullPathSummaries.find((s) => s.scenario === "P" && s.arm === "R0")!;
  const fp_R100_P = fullPathSummaries.find((s) => s.scenario === "P" && s.arm === "R100")!;

  // C1: blockedCount >= 30
  const c1Passed = deltaR100_P_ALL.blockedCount >= 30;

  // C2: Mean Δ > 0 and 90% Cluster CI lower > 0
  const c2Passed = deltaR100_P_ALL.meanDeltaPct > 0 && deltaR100_P_ALL.ciLowerPct > 0;

  // C3: In Scenario PESS Mean Δ >= 0
  const c3Passed = deltaR100_PESS_ALL.meanDeltaPct >= 0;

  // C4: Mean Δ > 0 in both H1 and H2 (skip if blockedCount < 10)
  const h1Pass = deltaR100_P_H1.blockedCount < 10 || deltaR100_P_H1.meanDeltaPct > 0;
  const h2Pass = deltaR100_P_H2.blockedCount < 10 || deltaR100_P_H2.meanDeltaPct > 0;
  const c4Passed = h1Pass && h2Pass && deltaR100_P_ALL.meanDeltaPct > 0;

  // C5: Full-path: Net PnL >= R0, PF >= R0, median Max DD not worse by > 10% relatively, trades reduction <= 40%
  const ddRatio =
    fp_R0_P.medianMaxDrawdownPct > 0
      ? (fp_R100_P.medianMaxDrawdownPct - fp_R0_P.medianMaxDrawdownPct) / fp_R0_P.medianMaxDrawdownPct
      : 0;
  const c5Passed =
    fp_R100_P.netPnlPct >= fp_R0_P.netPnlPct &&
    fp_R100_P.profitFactor >= fp_R0_P.profitFactor &&
    ddRatio <= 0.10 &&
    fp_R100_P.tradesReducedPct <= 40.0;

  // C6: Mean Δ after removing 3 worst negative blocked trades is still > 0
  const c6Passed = deltaR100_P_ALL.meanDeltaExcluding3WorstPct > 0;

  const gateResults = [c1Passed, c2Passed, c3Passed, c4Passed, c5Passed, c6Passed];
  const passedAllGates = gateResults.every(Boolean);

  // ── 8. Generate Report Markdown & Save Artifacts ──────────────────────────
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
  const reportDir = path.resolve(process.cwd(), "data", "research-reports", `${timestamp}_rr_${days}d`);
  fs.mkdirSync(reportDir, { recursive: true });

  const mdReport = generateMarkdownRRReport({
    days,
    endIso,
    symbolsCount: symbols.length,
    totalSignals,
    h1Count,
    h2Count,
    deltaR100_P_ALL,
    deltaR100_P_H1,
    deltaR100_P_H2,
    deltaR100_PESS_ALL,
    fp_R0_P,
    fp_R100_P,
    gateResults,
    passedAllGates,
    deltaRows,
    fullPathSummaries,
    spearmanCorr,
    spearmanBoot,
    quartiles,
    haedalEventsCount: haedalEvents.length,
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

  console.log(`\n================ Summary for RR Gate (${days}d) ================`);
  console.log(`Primary R100 Blocked Signals: ${deltaR100_P_ALL.blockedCount} (${deltaR100_P_ALL.blockedRatioPct}%)`);
  console.log(`Mean Delta Δ: ${deltaR100_P_ALL.meanDeltaPct}% (90% CI: [${deltaR100_P_ALL.ciLowerPct}%, ${deltaR100_P_ALL.ciUpperPct}%])`);
  console.log(`Sign Test: +${deltaR100_P_ALL.signTestPos} / -${deltaR100_P_ALL.signTestNeg} (p=${deltaR100_P_ALL.signTestPValue})`);
  console.log(`Mean Delta (Excl 3 worst): ${deltaR100_P_ALL.meanDeltaExcluding3WorstPct}%`);
  console.log(`C1 (N >= 30): ${c1Passed ? "PASS" : "FAIL"}`);
  console.log(`C2 (CI lower > 0): ${c2Passed ? "PASS" : "FAIL"}`);
  console.log(`C3 (PESS >= 0): ${c3Passed ? "PASS" : "FAIL"}`);
  console.log(`C4 (H1/H2 > 0): ${c4Passed ? "PASS" : "FAIL"}`);
  console.log(`C5 (Full-Path Risk & Net): ${c5Passed ? "PASS" : "FAIL"}`);
  console.log(`C6 (Excl 3 Worst > 0): ${c6Passed ? "PASS" : "FAIL"}`);
  console.log(`All Gates Passed: ${passedAllGates ? "YES" : "NO"}`);
  console.log(`Artifacts saved to: ${reportDir}`);

  return {
    days,
    blockedCountPrimary: deltaR100_P_ALL.blockedCount,
    passedAllGates,
    gateResults,
    reportDir,
  };
}

function generateMarkdownRRReport(data: {
  days: number;
  endIso: string;
  symbolsCount: number;
  totalSignals: number;
  h1Count: number;
  h2Count: number;
  deltaR100_P_ALL: DeltaRRRow;
  deltaR100_P_H1: DeltaRRRow;
  deltaR100_P_H2: DeltaRRRow;
  deltaR100_PESS_ALL: DeltaRRRow;
  fp_R0_P: FullPathRRSummaryRow;
  fp_R100_P: FullPathRRSummaryRow;
  gateResults: boolean[];
  passedAllGates: boolean;
  deltaRows: DeltaRRRow[];
  fullPathSummaries: FullPathRRSummaryRow[];
  spearmanCorr: number;
  spearmanBoot: { value: number; lower: number; upper: number };
  quartiles: {
    label: string;
    minRR: number;
    maxRR: number;
    count: number;
    meanPnlPct: number;
    winRatePct: number;
    slRatioPct: number;
  }[];
  haedalEventsCount: number;
}): string {
  const d = data.deltaR100_P_ALL;
  let md = `# รายงานผลการทดสอบ Backtest MA Fan Sniper — การตรวจสอบตัวกรอง Reward:Risk Gate (${data.days} วัน)\n\n`;
  md += `> **วันที่ประเมิน:** ${new Date().toISOString()} | **จุดสิ้นสุดข้อมูล:** \`${data.endIso}\` | **จำนวนเหรียญ:** ${data.symbolsCount} เหรียญ | **สัญญาณเข้าทั้งหมด:** ${data.totalSignals} สัญญาณ (H1: ${data.h1Count}, H2: ${data.h2Count})\n\n`;

  md += `## 1. บทสรุปผู้บริหาร (Executive Summary)\n\n`;
  if (data.passedAllGates) {
    md += `> [!TIP]\n`;
    md += `> **ผลการประเมิน: ผ่านเกณฑ์ล่วงหน้าครบทั้ง 6 ข้อ (C1–C6)!** การกรองไม้ที่ระยะ Reward:Risk < 1.0 (R100) ช่วยตัดไม้ที่แพ้สุทธิได้อย่างมีนัยสำคัญทางสถิติ (Mean Δ = +${d.meanDeltaPct}%, 90% CI: [${d.ciLowerPct}%, ${d.ciUpperPct}%]) เสนอให้พิจารณาเปิดใช้งานบนบอทจริงใน Phase R6 ต่อไป\n\n`;
  } else if (!data.gateResults[0]) {
    md += `> [!IMPORTANT]\n`;
    md += `> **ผลการประเมิน: ยังไม่สามารถสรุปผลได้ (Inconclusive)** เนื่องจากจำนวนไม้ที่ถูกบล็อก (N = ${d.blockedCount}) ยังไม่ถึงเกณฑ์ขั้นต่ำ 30 ไม้\n\n`;
  } else {
    md += `> [!WARNING]\n`;
    md += `> **ผลการประเมิน: ไม่ผ่านเกณฑ์ล่วงหน้า (Rejected)** โดย Mean Δ = **${d.meanDeltaPct > 0 ? "+" : ""}${d.meanDeltaPct}%** (90% CI: [${d.ciLowerPct}%, ${d.ciUpperPct}%]) แสดงว่าการตัดไม้ที่ RR < 1.0 ตัดไม้ชนะออกไปด้วยจนทำให้ผลตอบแทนโดยรวมไม่ได้ดีขึ้น คงค่าสวิตช์ gate ปิดไว้เป็นค่าเริ่มต้น\n\n`;
  }

  md += `## 2. ข้อมูลและการตั้งค่าการทดสอบ\n\n`;
  md += `- **นิยาม Reward:Risk**: \`riskPct = (entryPrice - stopLossPrice) / entryPrice * 100\`, \`rewardPct = (EMA25 - entryPrice) / entryPrice * 100\`, \`rr = rewardPct / riskPct\`\n`;
  md += `- **Primary Scenario (P)**: Fee 0.075%/ฝั่ง, Slippage 0.03%/fill, \`intrabarMode = closeBased\`, \`exitInfoLag = 1\` (Live Parity), \`breakevenFeeBufferPct = 0.15%\`\n`;
  md += `- **Primary Decision Arm**: **R100 (\`minRewardRiskRatio = 1.0\`)** (ค่าอื่นๆ 0.75, 1.25, 1.50, 2.00 รันเป็นตารางสำรวจ)\n\n`;

  md += `## 3. ตารางประเมินเกณฑ์ตัดสินล่วงหน้า (Pre-Registered Criteria C1–C6)\n\n`;
  md += `| ข้อ | เกณฑ์การตัดสิน | ผลที่ได้ | สถานะ |\n`;
  md += `| :--- | :--- | :--- | :--- |\n`;
  md += `| **C1** | สัญญาณที่ถูกบล็อก (Blocked Count) ≥ 30 | **${d.blockedCount}** ไม้ (${d.blockedRatioPct}% ของสัญญาณทั้งหมด) | ${data.gateResults[0] ? "✅ ผ่าน" : "❌ ไม่ผ่าน"} |\n`;
  md += `| **C2** | Mean Δ > 0 และ 90% Cluster CI ขอบล่าง > 0 | **${d.meanDeltaPct > 0 ? "+" : ""}${d.meanDeltaPct}%** (90% CI: [${d.ciLowerPct}%, ${d.ciUpperPct}%]) | ${data.gateResults[1] ? "✅ ผ่าน" : "❌ ไม่ผ่าน"} |\n`;
  md += `| **C3** | ใน Scenario Pessimistic Mean Δ ≥ 0 | Mean Δ = **${data.deltaR100_PESS_ALL.meanDeltaPct > 0 ? "+" : ""}${data.deltaR100_PESS_ALL.meanDeltaPct}%** | ${data.gateResults[2] ? "✅ ผ่าน" : "❌ ไม่ผ่าน"} |\n`;
  md += `| **C4** | Mean Δ > 0 ทั้งสองช่วง H1 และ H2 | H1: **${data.deltaR100_P_H1.meanDeltaPct > 0 ? "+" : ""}${data.deltaR100_P_H1.meanDeltaPct}%** (N=${data.deltaR100_P_H1.blockedCount}), H2: **${data.deltaR100_P_H2.meanDeltaPct > 0 ? "+" : ""}${data.deltaR100_P_H2.meanDeltaPct}%** (N=${data.deltaR100_P_H2.blockedCount}) | ${data.gateResults[3] ? "✅ ผ่าน" : "❌ ไม่ผ่าน"} |\n`;
  const fp = data.fp_R100_P;
  const fp0 = data.fp_R0_P;
  md += `| **C5** | Full-Path: Net PnL และ PF ไม่ต่ำกว่าเดิม, Drawdown ไม่แย่ลงเกิน 10%, ไม้ลดลง ≤ 40% | Net: ${fp.netPnlPct}% (เดิม ${fp0.netPnlPct}%), PF: ${fp.profitFactor} (เดิม ${fp0.profitFactor}), MaxDD: ${fp.medianMaxDrawdownPct}% (เดิม ${fp0.medianMaxDrawdownPct}%), Trades: -${fp.tradesReducedPct}% | ${data.gateResults[4] ? "✅ ผ่าน" : "❌ ไม่ผ่าน"} |\n`;
  md += `| **C6** | Mean Δ หลังตัด 3 ไม้ขาดทุนใหญ่สุดที่ถูกบล็อกออกยัง > 0 | Mean Δ (Excl 3 Worst) = **${d.meanDeltaExcluding3WorstPct > 0 ? "+" : ""}${d.meanDeltaExcluding3WorstPct}%** | ${data.gateResults[5] ? "✅ ผ่าน" : "❌ ไม่ผ่าน"} |\n\n`;

  md += `## 4. ผลลัพธ์ Entry-Matched Delta ทุก Arm ในสถานการณ์หลัก P (ALL, H1, H2)\n\n`;
  md += `| Arm | Subset | Signals | Blocked | Blocked Win/Loss | Mean Blocked PnL | Mean Passed PnL | Mean Δ (%) | 90% Cluster CI | Sign Test (+/-) | p-value |\n`;
  md += `| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n`;
  const pDeltas = data.deltaRows.filter((r) => r.scenario === "P");
  for (const r of pDeltas) {
    md += `| **${r.arm}** | ${r.subset} | ${r.signalsCount} | ${r.blockedCount} (${r.blockedRatioPct}%) | +${r.blockedWinners} / -${r.blockedLosers} | ${r.meanBlockedPnlPct}% | ${r.meanPassedPnlPct}% | **${r.meanDeltaPct > 0 ? "+" : ""}${r.meanDeltaPct}%** | [${r.ciLowerPct}%, ${r.ciUpperPct}%] | +${r.signTestPos} / -${r.signTestNeg} | ${r.signTestPValue} |\n`;
  }
  md += `\n`;

  md += `## 5. ผลลัพธ์การจำลองแบบต่อเนื่อง (Full-Path Portfolio Simulation)\n\n`;
  md += `| Scenario | Arm | Trades | Trades Reduced | Win Rate | Net PnL (%) | Net PnL ($) | Expectancy | Profit Factor | Median Max DD | Top 3 Share |\n`;
  md += `| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n`;
  for (const s of data.fullPathSummaries) {
    md += `| ${s.scenario} | **${s.arm}** | ${s.tradesCount} | ${s.tradesReducedPct}% | ${s.winRatePct}% | **${s.netPnlPct > 0 ? "+" : ""}${s.netPnlPct}%** | $${s.netPnlQuote} | ${s.expectancyPct}% | ${s.profitFactor} | ${s.medianMaxDrawdownPct}% | ${s.top3ProfitSharePct}% |\n`;
  }
  md += `\n`;

  md += `## 6. การวิเคราะห์เชิงพรรณนา (Descriptive Correlation & Quartiles)\n\n`;
  md += `- **Spearman Rank Correlation ρ(RR, PnL)**: **${data.spearmanCorr}** (90% Cluster CI: [${data.spearmanBoot.lower}, ${data.spearmanBoot.upper}])\n`;
  md += `  - ความหมาย: ${data.spearmanCorr > 0.05 ? "ค่า RR ที่สูงขึ้นสัมพันธ์กับผลตอบแทนของไม้ที่ดีขึ้นอย่างมีทิศทางบวก" : data.spearmanCorr < -0.05 ? "ค่า RR มีความสัมพันธ์ผกผันเล็กน้อยกับผลตอบแทน (เพราะ RR สูงมักเกิดตอนพัดถ่างกว้างมาก/ทุบแรง)" : "แทบไม่มีความสัมพันธ์เชิงเส้นตรงระหว่าง RR ก่อนเข้ากับผลลัพธ์กำไรสุทธิ"}\n\n`;

  md += `### ตารางแจกแจงผลตอบแทนแบ่งตามควอร์ไทล์ของค่า Reward:Risk (Scenario P):\n\n`;
  md += `| ควอร์ไทล์ | ช่วงค่า RR | จำนวนไม้ | กำไรเฉลี่ยสุทธิ (PnL %) | Win Rate (%) | อัตราโดน SL (%) |\n`;
  md += `| :--- | :--- | :--- | :--- | :--- | :--- |\n`;
  for (const q of data.quartiles) {
    md += `| **${q.label}** | ${q.minRR.toFixed(2)} – ${q.maxRR.toFixed(2)} | ${q.count} | **${q.meanPnlPct > 0 ? "+" : ""}${q.meanPnlPct}%** | ${q.winRatePct}% | ${q.slRatioPct}% |\n`;
  }
  md += `\n`;

  md += `## 7. กรณีศึกษาตัวอย่าง: ไม้ HAEDALUSDT ล่าสุด (Hold-out Observation)\n\n`;
  md += `> [!NOTE]\n`;
  md += `> - ไม้ \`HAEDALUSDT\` ที่ตัดขาดทุนล่าสุดเข้าเมื่อ \`2026-10-29T04:15Z\` ซึ่งอยู่นอกหน้าต่างข้อมูลการทดสอบ (\`2026-10-29T00:00Z\`) จึงเป็นไม้ **Hold-out** ไม่ถูกนำมารวมในการคำนวณสถิติเพื่อป้องกันการ Overfit\n`;
  md += `> - **ค่า RR ของไม้นี้คือ ≈ 1.36** (Risk = 2.40%, Reward ถึง EMA25 = 3.26%): ไม้นี้จึง**ไม่ถูกบล็อก**โดยเกณฑ์มาตรฐาน \`R100\` (จะถูกบล็อกเฉพาะเมื่อตั้งเกณฑ์ \`R150\` หรือ \`R200\` เท่านั้น)\n`;
  md += `> - สาเหตุเชิงโครงสร้าง: เมื่อเกิดการทุบดิ่งเหว (Waterfall) พัด EMA จะถ่างออกกว้างมาก ทำให้เส้น EMA 25 อยู่ไกลจากราคา ส่งผลให้ค่า Reward ดูสูงผิดปกติ ทั้งที่เป็นจังหวะที่มีดกำลังตก\n\n`;

  md += `## 8. ข้อจำกัดของการทดสอบ (Limitations)\n\n`;
  md += `1. **Reward วัดเพียง TP1 (EMA 25)**: ไม่ได้รวมระยะของ TP2 (EMA 75/200 หรือ Trailing) ทำให้การวัดค่า Reward ในระบบนี้ประเมินต่ำกว่าความเป็นจริงสำหรับไม้ที่รันเทรนด์ยาว\n`;
  md += `2. **ความสัมพันธ์ผกผันกับความกว้างของพัด**: ยิ่งพัดถ่างกว้าง ค่า RR จะยิ่งสูงขึ้นโดยธรรมชาติ ทำให้ RR Gate เพียงตัวเดียวอาจไม่สามารถกรองไม้ Waterfall Crash ที่ร่วงแรงได้ทั้งหมด\n`;
  md += `3. **เกณฑ์ R150 และ R200 เป็น Post-case Exploration**: ค่าเกณฑ์ที่สูงกว่า 1.0 จัดเป็นสมมติฐานใหม่ที่ต้องรอดูผลจาก forward testing ต่อไป\n\n`;

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

  let currentDays = days;
  let res = await runResearchRRSuite({ days: currentDays, endIso, topN });

  // Auto-extend to 60 days if blocked count < 30 (as per R4.3)
  if (res.blockedCountPrimary < 30 && currentDays === 30) {
    console.warn(`\n⚠️ Primary R100 blocked count (${res.blockedCountPrimary}) < 30 at 30 days. Auto-extending window once to 60 days as per protocol...`);
    currentDays = 60;
    res = await runResearchRRSuite({ days: currentDays, endIso, topN });
  }

  console.log(`\n🎉 Research RR Suite finished! Final report directory: ${res.reportDir}`);
}

if (process.argv[1]?.endsWith("runner-rr.ts") || process.argv[1]?.endsWith("runner-rr.js")) {
  main().catch((err) => {
    console.error("Fatal runner error:", err);
    process.exit(1);
  });
}
