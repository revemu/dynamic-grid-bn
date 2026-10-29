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
import {
  DeltaRow,
  EventMatchedRow,
  FullPathRow,
  ScenarioSummaryRow,
  writeResearchReport,
} from "./report.js";
import {
  clusterBootstrapMeanCI,
  mean,
  median,
  signTest,
  top3ProfitShare,
} from "./stats.js";
import { SnapshotData } from "./types.js";

interface ArmConfig {
  name: string;
  cushionMode: "off" | "htfBull" | "always";
  breakevenFeeBufferPct: number;
  tp1MinProfitPct: number;
}

interface ScenarioConfig {
  name: string;
  costModel: { feePctPerSide: number; slippagePctPerFill: number };
  intrabarMode: "optimistic" | "closeBased" | "pessimistic";
  exitInfoLag: 0 | 1;
}

const SEEN_CUTOFF_SEC = Math.floor(new Date("2026-10-25T00:00:00Z").getTime() / 1000);

export async function runResearchSuite(opts: {
  days: number;
  endIso?: string;
  topN?: number;
}): Promise<{
  days: number;
  firedCount: number;
  passedGateCriteria: boolean[];
  reportDir: string;
}> {
  const days = opts.days;
  const endIso = opts.endIso || "2026-10-29T00:00:00.000Z";
  const topN = opts.topN || 30;

  console.log(`\n======================================================`);
  console.log(`🚀 Starting Research Suite Execution (${days} Days)`);
  console.log(`======================================================`);

  const snapshot: SnapshotData = await loadOrFetchSnapshot({ days, endIso, topN });
  const symbols = snapshot.manifest.passedSymbols;

  // ── 1. Define Experimental Arms ──────────────────────────────────────────
  const coreArms: ArmConfig[] = [
    { name: "G0", cushionMode: "off", breakevenFeeBufferPct: 0.05, tp1MinProfitPct: 0.2 },
    { name: "G1", cushionMode: "htfBull", breakevenFeeBufferPct: 0.05, tp1MinProfitPct: 0.2 },
    { name: "G2", cushionMode: "always", breakevenFeeBufferPct: 0.05, tp1MinProfitPct: 0.2 },
  ];

  const g3FeeBuffers = [0.05, 0.15, 0.2];
  const g3Tp1MinProfits = [0.2, 0.3, 0.4];
  const g3Arms: ArmConfig[] = [];

  for (const be of g3FeeBuffers) {
    for (const tp of g3Tp1MinProfits) {
      const armId = `G3_BE${(be * 100).toFixed(0)}_TP${(tp * 100).toFixed(0)}`;
      g3Arms.push({
        name: armId,
        cushionMode: "off",
        breakevenFeeBufferPct: be,
        tp1MinProfitPct: tp,
      });
    }
  }

  // ── 2. Define Scenarios ──────────────────────────────────────────────────
  const primaryScenario: ScenarioConfig = {
    name: "P",
    costModel: { feePctPerSide: 0.075, slippagePctPerFill: 0.03 },
    intrabarMode: "closeBased",
    exitInfoLag: 1,
  };

  const sensitivityScenarios: ScenarioConfig[] = [
    {
      name: "C0",
      costModel: { feePctPerSide: 0, slippagePctPerFill: 0 },
      intrabarMode: "closeBased",
      exitInfoLag: 1,
    },
    {
      name: "C2",
      costModel: { feePctPerSide: 0.1, slippagePctPerFill: 0.06 },
      intrabarMode: "closeBased",
      exitInfoLag: 1,
    },
    {
      name: "optimistic",
      costModel: { feePctPerSide: 0.075, slippagePctPerFill: 0.03 },
      intrabarMode: "optimistic",
      exitInfoLag: 1,
    },
    {
      name: "pessimistic",
      costModel: { feePctPerSide: 0.075, slippagePctPerFill: 0.03 },
      intrabarMode: "pessimistic",
      exitInfoLag: 1,
    },
    {
      name: "lag0",
      costModel: { feePctPerSide: 0.075, slippagePctPerFill: 0.03 },
      intrabarMode: "closeBased",
      exitInfoLag: 0,
    },
  ];

  const allScenarios = [primaryScenario, ...sensitivityScenarios];

  // ── 3. Generate De-clustered Entry Signals per Coin ───────────────────────
  console.log(`[Research] Generating de-clustered entry signals across ${symbols.length} coins...`);
  interface Signal {
    symbol: string;
    idx: number;
    time: number;
    entryPrice: number;
    segment: "unseen" | "seen";
  }

  const signalsBySymbol = new Map<string, Signal[]>();
  const precomputedBySymbol = new Map<
    string,
    { ribbonStates: any[]; exhaustionStates: any[]; atrs: number[] }
  >();

  let totalSignals = 0;

  for (const sym of symbols) {
    const pairData = snapshot.candlesBySymbol.get(sym)!;
    const c5m = pairData.candles5m;
    const c15m = pairData.candlesHtf15m;

    const ribbonStates = RibbonEngine.computeAllRibbonStates(c5m);
    const exhaustionStates = ExhaustionEngine.computeAllExhaustion(c5m);
    const atrs = calcATR(c5m, 14);

    precomputedBySymbol.set(sym, { ribbonStates, exhaustionStates, atrs });

    const coinSignals: Signal[] = [];
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
        // De-cluster: at least 12 bars (1 hour) separation
        if (i - lastSignalIdx >= 12) {
          const segment = c.time < SEEN_CUTOFF_SEC ? "unseen" : "seen";
          coinSignals.push({
            symbol: sym,
            idx: i,
            time: c.time,
            entryPrice: entry.entryPrice,
            segment,
          });
          lastSignalIdx = i;
        }
      }
    }

    signalsBySymbol.set(sym, coinSignals);
    totalSignals += coinSignals.length;
  }

  console.log(`[Research] Generated ${totalSignals} de-clustered signals across ${symbols.length} coins.`);

  // ── 4. Run Entry-Matched Simulations ─────────────────────────────────────
  console.log(`[Research] Executing Entry-matched simulations...`);
  const eventRows: EventMatchedRow[] = [];
  // Map key: `${scenario.name}_${arm.name}_${sym}_${sig.idx}` -> trade
  const entryMatchedResults = new Map<string, { pnlPct: number; cushionApplied: boolean; exitType: string }>();

  for (const sc of allScenarios) {
    const armsToRun = sc.name === "P" ? [...coreArms, ...g3Arms] : coreArms;

    for (const arm of armsToRun) {
      console.log(`[Research] Entry-Matched: Scenario ${sc.name}, Arm ${arm.name}...`);
      for (const sym of symbols) {
        const pairData = snapshot.candlesBySymbol.get(sym)!;
        const precomputed = precomputedBySymbol.get(sym)!;
        const signals = signalsBySymbol.get(sym)!;

        for (const sig of signals) {
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
            breakevenFeeBufferPct: arm.breakevenFeeBufferPct,
            tp1MinProfitPct: arm.tp1MinProfitPct,
            cushionMode: arm.cushionMode,
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
          const key = `${sc.name}_${arm.name}_${sym}_${sig.idx}`;
          if (t) {
            entryMatchedResults.set(key, {
              pnlPct: t.pnlPct,
              cushionApplied: !!t.cushionApplied,
              exitType: t.exitType,
            });

            eventRows.push({
              symbol: sym,
              entryTimeUtc: new Date(sig.time * 1000).toISOString(),
              segment: sig.segment,
              scenario: sc.name,
              arm: arm.name,
              exitType: t.exitType,
              exitPrice: t.exitPrice,
              pnlPctNet: Number(t.pnlPct.toFixed(4)),
              cushionApplied: !!t.cushionApplied,
              holdingBars: t.holdingBars,
              costQuote: Number((t.costQuote ?? 0).toFixed(4)),
            });
          }
        }
      }
    }
  }

  // ── 5. Run Full-Path Simulations ─────────────────────────────────────────
  console.log(`[Research] Executing Full-path continuous simulations...`);
  const fullPathRows: FullPathRow[] = [];
  const fullPathSummaries: ScenarioSummaryRow[] = [];

  for (const sc of allScenarios) {
    const armsToRun = sc.name === "P" ? [...coreArms, ...g3Arms] : coreArms;

    for (const arm of armsToRun) {
      let totalTrades = 0;
      let totalWins = 0;
      let totalLosses = 0;
      let totalNetPnlQuote = 0;
      let totalGrossProfit = 0;
      let totalGrossLoss = 0;
      const maxDrawdowns: number[] = [];
      const tradePnls: number[] = [];
      let breakevenLossTrades = 0;

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
          breakevenFeeBufferPct: arm.breakevenFeeBufferPct,
          tp1MinProfitPct: arm.tp1MinProfitPct,
          cushionMode: arm.cushionMode,
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

          // Check if trade exited at Breakeven/TP1 but ended with negative net PnL due to costs
          if ((t.exitType === "TP1+SL_BE" || t.exitType === "SL") && t.pnlPct < 0 && t.exitPrice >= t.entryPrice) {
            breakevenLossTrades++;
          }

          const seg: "unseen" | "seen" = t.entryTime < SEEN_CUTOFF_SEC ? "unseen" : "seen";
          fullPathRows.push({
            tradeId: t.id,
            symbol: sym,
            entryTimeUtc: new Date(t.entryTime * 1000).toISOString(),
            segment: seg,
            scenario: sc.name,
            arm: arm.name,
            exitType: t.exitType,
            exitPrice: t.exitPrice,
            pnlPctNet: Number(t.pnlPct.toFixed(4)),
            cushionApplied: !!t.cushionApplied,
            holdingBars: t.holdingBars,
            costQuote: Number((t.costQuote ?? 0).toFixed(4)),
          });
        }
      }

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
        winRatePct,
        netPnlPct,
        netPnlQuote: Number(totalNetPnlQuote.toFixed(2)),
        expectancyPct,
        profitFactor,
        medianMaxDrawdownPct,
        lossTradeRatioPct,
        top3ProfitSharePct: top3Share,
        breakevenLossTradesCount: breakevenLossTrades,
      });
    }
  }

  // ── 6. Compute G1 vs G0 Delta Statistics (Entry-Matched) ──────────────────
  console.log(`[Research] Computing Delta statistics (G1 vs G0)...`);
  const deltaRows: DeltaRow[] = [];

  for (const sc of allScenarios) {
    const deltasAll: number[] = [];
    const deltasByCluster = new Map<string, number[]>();
    const unseenDeltas: number[] = [];
    const seenDeltas: number[] = [];

    let firedCount = 0;
    let outcomeChangedCount = 0;
    let unseenFiredCount = 0;
    let seenFiredCount = 0;

    for (const sym of symbols) {
      const signals = signalsBySymbol.get(sym)!;
      const clusterVals: number[] = [];

      for (const sig of signals) {
        const keyG0 = `${sc.name}_G0_${sym}_${sig.idx}`;
        const keyG1 = `${sc.name}_G1_${sym}_${sig.idx}`;

        const resG0 = entryMatchedResults.get(keyG0);
        const resG1 = entryMatchedResults.get(keyG1);

        if (resG0 && resG1) {
          if (resG1.cushionApplied) {
            firedCount++;
            const delta = resG1.pnlPct - resG0.pnlPct;
            deltasAll.push(delta);
            clusterVals.push(delta);

            if (resG1.exitType !== resG0.exitType || Math.abs(delta) > 0.05) {
              outcomeChangedCount++;
            }

            if (sig.segment === "unseen") {
              unseenFiredCount++;
              unseenDeltas.push(delta);
            } else {
              seenFiredCount++;
              seenDeltas.push(delta);
            }
          }
        }
      }

      if (clusterVals.length > 0) {
        deltasByCluster.set(sym, clusterVals);
      }
    }

    const meanDelta = mean(deltasAll);
    const bootCi = clusterBootstrapMeanCI(deltasByCluster, 10000, 0.9);
    const st = signTest(deltasAll);

    deltaRows.push({
      scenario: sc.name,
      firedCount,
      outcomeChangedCount,
      meanDeltaPct: Number(meanDelta.toFixed(4)),
      ciLowerPct: bootCi.lower,
      ciUpperPct: bootCi.upper,
      signTestPos: st.positive,
      signTestNeg: st.negative,
      signTestPValue: st.pValue,
      unseenFiredCount,
      unseenMeanDeltaPct: Number(mean(unseenDeltas).toFixed(4)),
      seenFiredCount,
      seenMeanDeltaPct: Number(mean(seenDeltas).toFixed(4)),
    });
  }

  // ── 7. Evaluate Pre-Registered Criteria (Section 6) ───────────────────────
  const deltaP = deltaRows.find((d) => d.scenario === "P")!;
  const deltaPessimistic = deltaRows.find((d) => d.scenario === "pessimistic")!;

  const summaryG0_P = fullPathSummaries.find((s) => s.scenario === "P" && s.arm === "G0")!;
  const summaryG1_P = fullPathSummaries.find((s) => s.scenario === "P" && s.arm === "G1")!;

  const crit1 = deltaP.firedCount >= 30;
  const crit2 = deltaP.ciLowerPct > 0;
  const crit3 = deltaPessimistic.meanDeltaPct >= 0;

  const crit4Unseen = deltaP.unseenFiredCount < 10 || deltaP.unseenMeanDeltaPct > 0;
  const crit4Seen = deltaP.seenFiredCount < 10 || deltaP.seenMeanDeltaPct > 0;
  const crit4 = crit4Unseen && crit4Seen && deltaP.meanDeltaPct > 0;

  // Criterion 5: Median Max Drawdown and Loss Trade Ratio must not worsen by > 10% relatively
  const ddRatio = summaryG0_P.medianMaxDrawdownPct > 0
    ? (summaryG1_P.medianMaxDrawdownPct - summaryG0_P.medianMaxDrawdownPct) / summaryG0_P.medianMaxDrawdownPct
    : 0;
  const lossRatio = summaryG0_P.lossTradeRatioPct > 0
    ? (summaryG1_P.lossTradeRatioPct - summaryG0_P.lossTradeRatioPct) / summaryG0_P.lossTradeRatioPct
    : 0;
  const crit5 = ddRatio <= 0.1 && lossRatio <= 0.1;

  const passedCriteria = [crit1, crit2, crit3, crit4, crit5];

  // ── 8. Generate Markdown Report ──────────────────────────────────────────
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
  const reportDir = path.resolve(process.cwd(), "data", "research-reports", `${timestamp}_${days}d`);

  const mdReport = generateMarkdownReport({
    days,
    endIso,
    symbolsCount: symbols.length,
    totalSignals,
    deltaRows,
    fullPathSummaries,
    passedCriteria,
    ddRatio,
    lossRatio,
  });

  writeResearchReport({
    reportDir,
    events: eventRows,
    fullPathTrades: fullPathRows,
    scenarioSummaries: fullPathSummaries,
    deltas: deltaRows,
    markdownContent: mdReport,
  });

  console.log(`\n================ Summary for ${days}d ================`);
  console.log(`Scenario P Fired Events: ${deltaP.firedCount}`);
  console.log(`Mean Delta Δ: ${deltaP.meanDeltaPct}% (CI 90%: [${deltaP.ciLowerPct}%, ${deltaP.ciUpperPct}%])`);
  console.log(`Sign Test: +${deltaP.signTestPos} / -${deltaP.signTestNeg} (p=${deltaP.signTestPValue})`);
  console.log(`Criterion 1 (N >= 30): ${crit1 ? "PASS" : "FAIL"}`);
  console.log(`Criterion 2 (CI lower > 0): ${crit2 ? "PASS" : "FAIL"}`);
  console.log(`Criterion 3 (Pessimistic >= 0): ${crit3 ? "PASS" : "FAIL"}`);
  console.log(`Criterion 4 (Unseen/Seen > 0): ${crit4 ? "PASS" : "FAIL"}`);
  console.log(`Criterion 5 (Risk <= +10%): ${crit5 ? "PASS" : "FAIL"}`);

  return {
    days,
    firedCount: deltaP.firedCount,
    passedGateCriteria: passedCriteria,
    reportDir,
  };
}

function generateMarkdownReport(data: {
  days: number;
  endIso: string;
  symbolsCount: number;
  totalSignals: number;
  deltaRows: DeltaRow[];
  fullPathSummaries: ScenarioSummaryRow[];
  passedCriteria: boolean[];
  ddRatio: number;
  lossRatio: number;
}): string {
  const pDelta = data.deltaRows.find((d) => d.scenario === "P")!;
  const allPassed = data.passedCriteria.every(Boolean);

  let md = `# รายงานผลการทดสอบ Backtest MA Fan Sniper — การตรวจสอบกฎ Bull Cushion (${data.days} วัน)\n\n`;
  md += `> **วันที่ประเมิน:** ${new Date().toISOString()} | **จุดสิ้นสุดข้อมูล:** \`${data.endIso}\` | **จำนวนเหรียญ:** ${data.symbolsCount} เหรียญ | **สัญญาณเข้าทั้งหมด:** ${data.totalSignals} สัญญาณ\n\n`;

  md += `## 1. บทสรุปการตัดสินใจตามเกณฑ์ล่วงหน้า (Pre-registered Decision Criteria)\n\n`;
  md += `| ข้อ | เกณฑ์การตัดสิน | ผลที่ได้ | สถานะ |\n`;
  md += `| :--- | :--- | :--- | :--- |\n`;
  md += `| **1** | จำนวนเหตุการณ์ที่กฎทำงานจริง (Fired Count) ≥ 30 | **${pDelta.firedCount}** ครั้ง | ${data.passedCriteria[0] ? "✅ ผ่าน" : "❌ ไม่ผ่าน"} |\n`;
  md += `| **2** | ขอบล่างของ 90% Cluster Bootstrap CI ของค่าเฉลี่ย Δ > 0 | **[${pDelta.ciLowerPct}%, ${pDelta.ciUpperPct}%]** (Mean: **+${pDelta.meanDeltaPct}%**) | ${data.passedCriteria[1] ? "✅ ผ่าน" : "❌ ไม่ผ่าน"} |\n`;
  const pessDelta = data.deltaRows.find((d) => d.scenario === "pessimistic")!;
  md += `| **3** | ใน Scenario Pessimistic ค่าเฉลี่ย Δ ≥ 0 | Mean Δ = **${pessDelta.meanDeltaPct}%** | ${data.passedCriteria[2] ? "✅ ผ่าน" : "❌ ไม่ผ่าน"} |\n`;
  md += `| **4** | ค่าเฉลี่ย Δ เป็นบวกทั้ง Segment Unseen และ Seen | Unseen: **+${pDelta.unseenMeanDeltaPct}%** (N=${pDelta.unseenFiredCount}), Seen: **+${pDelta.seenMeanDeltaPct}%** (N=${pDelta.seenFiredCount}) | ${data.passedCriteria[3] ? "✅ ผ่าน" : "❌ ไม่ผ่าน"} |\n`;
  md += `| **5** | Full-path: Max Drawdown และสัดส่วนไม้แพ้ต้องไม่แย่ลงเกิน 10% | Max DD Change: **${(data.ddRatio * 100).toFixed(1)}%**, Loss Ratio Change: **${(data.lossRatio * 100).toFixed(1)}%** | ${data.passedCriteria[4] ? "✅ ผ่าน" : "❌ ไม่ผ่าน"} |\n\n`;

  md += `### 🎯 บทสรุปเชิงข้อเสนอแนะ:\n`;
  if (allPassed) {
    md += `> [!TIP]\n> **ผ่านเกณฑ์ล่วงหน้าครบทั้ง 5 ข้ออย่างสมบูรณ์!** กฎ Bull Cushion เพิ่มผลตอบแทนต่อไม้อย่างมีนัยสำคัญทางสถิติโดยไม่เพิ่มความเสี่ยงอย่างผิดสัดส่วน ขอเสนอให้พิจารณาเปิดสวิตช์ \`maFanBullCushion\` เป็นค่าเริ่มต้นบนบอทจริง\n\n`;
  } else {
    md += `> [!WARNING]\n> **ยังไม่ผ่านเกณฑ์ครบทั้ง 5 ข้อ** (คงค่าเริ่มต้นเป็น **ปิด (\`false\`)** ตามระเบียบความปลอดภัย)\n\n`;
  }

  md += `## 2. ตารางเปรียบเทียบผลกระทบของ Bull Cushion (Δ = G1 - G0) ทุก Scenario\n\n`;
  md += `| Scenario | Fired Count | Changed Outcome | Mean Δ (%) | 90% Cluster CI | Sign Test (+/-) | p-value |\n`;
  md += `| :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n`;
  for (const d of data.deltaRows) {
    md += `| **${d.scenario}** | ${d.firedCount} | ${d.outcomeChangedCount} | **${d.meanDeltaPct > 0 ? "+" : ""}${d.meanDeltaPct}%** | [${d.ciLowerPct}%, ${d.ciUpperPct}%] | +${d.signTestPos} / -${d.signTestNeg} | ${d.signTestPValue} |\n`;
  }
  md += `\n`;

  md += `## 3. สรุปผลการจำลองแบบต่อเนื่อง (Full-path Portfolio Simulation)\n\n`;
  md += `| Scenario | Arm | Trades | Win Rate | Net PnL (%) | Net PnL ($) | Expectancy | Profit Factor | Median Max DD | Loss Ratio | Top 3 Share |\n`;
  md += `| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n`;
  for (const s of data.fullPathSummaries) {
    md += `| ${s.scenario} | **${s.arm}** | ${s.tradesCount} | ${s.winRatePct}% | **${s.netPnlPct > 0 ? "+" : ""}${s.netPnlPct}%** | $${s.netPnlQuote} | ${s.expectancyPct}% | ${s.profitFactor} | ${s.medianMaxDrawdownPct}% | ${s.lossTradeRatioPct}% | ${s.top3ProfitSharePct}% |\n`;
  }
  md += `\n`;

  md += `## 4. ผลการตอบคำถามวิจัยเพิ่มเติม (Research Questions RQ2 - RQ4)\n\n`;
  const g1P = data.fullPathSummaries.find((s) => s.scenario === "P" && s.arm === "G1");
  const g2P = data.fullPathSummaries.find((s) => s.scenario === "P" && s.arm === "G2");
  md += `### RQ2: เงื่อนไขกรอง HTF Bullish ช่วยได้จริงหรือไม่ (G1 vs G2)?\n`;
  md += `- **G1 (Cushion เฉพาะ HTF Bull)**: Net PnL **${g1P?.netPnlPct}%**, Win Rate **${g1P?.winRatePct}%**, Profit Factor **${g1P?.profitFactor}**\n`;
  md += `- **G2 (Cushion เสมอ ไม่สน HTF)**: Net PnL **${g2P?.netPnlPct}%**, Win Rate **${g2P?.winRatePct}%**, Profit Factor **${g2P?.profitFactor}**\n\n`;

  md += `### RQ3: ตารางทดสอบโครงสร้าง Fee-Aware Grid (G3a - G3i)\n`;
  md += `การทดสอบ Breakeven Fee Buffer {0.05%, 0.15%, 0.20%} คู่กับ TP1 Min Profit {0.20%, 0.30%, 0.40%} ภายใต้ต้นทุน C1:\n\n`;
  md += `| Arm | Buffer (%) | Min TP1 (%) | Trades | Win Rate | Net PnL (%) | BE Net Loss Trades |\n`;
  md += `| :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n`;
  const g3Summaries = data.fullPathSummaries.filter((s) => s.scenario === "P" && s.arm.startsWith("G3"));
  for (const g3 of g3Summaries) {
    md += `| **${g3.arm}** | - | - | ${g3.tradesCount} | ${g3.winRatePct}% | **${g3.netPnlPct}%** | ${g3.breakevenLossTradesCount} ไม้ |\n`;
  }
  md += `\n`;

  md += `### RQ4: ผลกระทบของ Live Parity (\`exitInfoLag = 1\` vs \`0\`) และ Intrabar Modes\n`;
  const pLag1 = data.fullPathSummaries.find((s) => s.scenario === "P" && s.arm === "G0");
  const pLag0 = data.fullPathSummaries.find((s) => s.scenario === "lag0" && s.arm === "G0");
  md += `- **Live Parity (\`exitInfoLag = 1\`)**: G0 Net PnL = **${pLag1?.netPnlPct}%**, Win Rate = **${pLag1?.winRatePct}%**\n`;
  md += `- **Lookahead Bias (\`exitInfoLag = 0\`)**: G0 Net PnL = **${pLag0?.netPnlPct}%**, Win Rate = **${pLag0?.winRatePct}%**\n\n`;

  return md;
}

// CLI entry point
async function main() {
  const args = process.argv.slice(2);
  let days = 15;
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

  // Phase 4 Auto-Extend Loop: 15 -> 30 -> 60 days
  let currentDays = days;
  let finalResult = null;

  while (currentDays <= 60) {
    const res = await runResearchSuite({ days: currentDays, endIso, topN });
    finalResult = res;

    if (res.firedCount >= 30) {
      console.log(`\n✓ Sufficient affected events reached (${res.firedCount} >= 30) at ${currentDays} days. No extension needed.`);
      break;
    } else if (currentDays < 60) {
      const nextDays = currentDays === 15 ? 30 : 60;
      console.warn(`\n⚠️ Fired events (${res.firedCount}) < 30 at ${currentDays} days. Automatically auto-extending window to ${nextDays} days...`);
      currentDays = nextDays;
    } else {
      console.warn(`\n⚠️ Fired events (${res.firedCount}) < 30 even after maximum extension to 60 days. Stopping as per Phase 4 protocol.`);
      break;
    }
  }

  console.log(`\n🎉 Research Suite finished! Final report directory: ${finalResult?.reportDir}`);
}

if (process.argv[1]?.endsWith("runner.ts") || process.argv[1]?.endsWith("runner.js")) {
  main().catch((err) => {
    console.error("Fatal runner error:", err);
    process.exit(1);
  });
}
