/**
 * Causal Rolling Spread Calibrator
 * Zero Lookahead Bias (Strictly Walk-Forward Causal Calibration)
 * Shared 1:1 Engine between Live Bot and Backtest Studio.
 */

import { Candle, RibbonState, HtfRegime, CalibrationResult } from "./types.js";
import { RibbonEngine, calcATR } from "./ribbon.js";
import { ExhaustionEngine, ExhaustionState } from "./exhaustion.js";
import { RegimeSupervisor } from "./regime.js";
import { MaFanCoreRules, CushionMode, WaterfallGuardMode } from "./core-rules.js";

export const DEFAULT_CALIBRATION_LOOKBACK = 1000;
export const CANDIDATE_SPREADS = [
  0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.65, 0.80, 1.00, 1.25, 1.50, 1.80,
];

export interface RollingCalibratorOptions {
  slBufferPct?: number;
  trailingPullbackPct?: number;
  breakevenFeeBufferPct?: number;
  tp1Ratio?: number;
  initialCapital?: number;
  supervisorTimeframe?: "15m" | "1h";
  executionTimeframe?: "5m" | "15m";
  useRatchetSl?: boolean;
  cushionMode?: CushionMode;
  costModel?: { feePctPerSide?: number; slippagePctPerFill?: number };
  macroGateMode?: "off" | "noDeepBear" | "bullOnly";
  enableUpsideFloor?: boolean;
  waterfallGuardMode?: WaterfallGuardMode;
  lookbackBars?: number;
  tieBreakMarginPct?: number;
  defensiveOnLossRegime?: boolean;
}

export interface TradeOutcome {
  exitIdx: number;
  tp1Idx: number;
  tp1ProceedsPerInvest: number;
  initialQtyPerInvest: number;
  remQtyAfterTp1PerInvest: number;
  finalProceedsPerInvest: number;
}

export function aggregateTo15m(candles: Candle[], targetMinutes = 15): Candle[] {
  const targetSeconds = targetMinutes * 60;
  const groups = new Map<number, Candle>();
  for (const c of candles) {
    const bucket = Math.floor(c.time / targetSeconds) * targetSeconds;
    const existing = groups.get(bucket);
    if (!existing) {
      groups.set(bucket, { time: bucket, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 });
    } else {
      existing.high = Math.max(existing.high, c.high);
      existing.low = Math.min(existing.low, c.low);
      existing.close = c.close;
      existing.volume = (existing.volume || 0) + (c.volume || 0);
    }
  }
  return Array.from(groups.values()).sort((a, b) => a.time - b.time);
}

export class RollingSpreadCalibrator {
  public symbol: string;
  public candles: Candle[];
  public candlesHtf: Candle[];
  public opts: Required<RollingCalibratorOptions>;
  public costPerFill: number;

  public ribbons: RibbonState[];
  public exhaustions: ExhaustionState[];
  public atrs: number[];
  public htfRegimes: HtfRegime[];
  public baseCandidate: Uint8Array;
  public outcomes: (TradeOutcome | null)[];

  constructor(
    symbol: string,
    candles: Candle[],
    candlesHtf?: Candle[],
    options?: RollingCalibratorOptions
  ) {
    this.symbol = symbol.toUpperCase().replace(/[\/\-_:]/g, "");
    this.candles = candles;

    const supTf = options?.supervisorTimeframe ?? "15m";
    const targetMinutes = supTf === "1h" ? 60 : 15;
    this.candlesHtf = candlesHtf && candlesHtf.length > 0 ? candlesHtf : aggregateTo15m(candles, targetMinutes);

    const cm = options?.costModel;
    const feePct = cm?.feePctPerSide ?? 0.075;
    const slipPct = cm?.slippagePctPerFill ?? 0.01;
    this.costPerFill = (feePct + slipPct) / 100;

    this.opts = {
      slBufferPct: options?.slBufferPct ?? 0.25,
      trailingPullbackPct: options?.trailingPullbackPct ?? 0.45,
      breakevenFeeBufferPct: options?.breakevenFeeBufferPct ?? 0.05,
      tp1Ratio: Math.max(0.1, Math.min(0.9, options?.tp1Ratio ?? 0.50)),
      initialCapital: options?.initialCapital ?? 200,
      supervisorTimeframe: supTf,
      executionTimeframe: options?.executionTimeframe ?? "5m",
      useRatchetSl: options?.useRatchetSl !== false,
      cushionMode: options?.cushionMode ?? "off",
      costModel: { feePctPerSide: feePct, slippagePctPerFill: slipPct },
      macroGateMode: options?.macroGateMode ?? "off",
      enableUpsideFloor: options?.enableUpsideFloor !== false,
      waterfallGuardMode: options?.waterfallGuardMode ?? "combined",
      lookbackBars: options?.lookbackBars ?? DEFAULT_CALIBRATION_LOOKBACK,
      tieBreakMarginPct: options?.tieBreakMarginPct ?? 0.02,
      defensiveOnLossRegime: options?.defensiveOnLossRegime !== false,
    };

    // Precompute full arrays in O(N)
    this.ribbons = RibbonEngine.computeAllRibbonStates(candles);
    this.exhaustions = ExhaustionEngine.computeAllExhaustion(candles);
    this.atrs = calcATR(candles, 14);
    this.htfRegimes = new Array(candles.length);
    this.baseCandidate = new Uint8Array(candles.length);
    this.outcomes = new Array(candles.length).fill(null);

    const entryPrices = new Float64Array(candles.length);
    const initialSls = new Float64Array(candles.length);

    // Pass 1: HTF regimes & base entry signals (all non-spread criteria)
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i]!;
      const htf = RegimeSupervisor.evaluateHtfRegime(
        this.candlesHtf,
        this.opts.supervisorTimeframe,
        c.time,
        this.opts.tp1Ratio,
        this.opts.executionTimeframe
      );
      this.htfRegimes[i] = htf;
      const curAtr = this.atrs[i] || c.close * 0.003;
      const dec = MaFanCoreRules.evaluateEntry({
        candles,
        currentIndex: i,
        closePrice: c.close,
        ribbon: this.ribbons[i]!,
        exhaustion: this.exhaustions[i]!,
        requiredSpreadPct: 0, // Checked dynamically per candidate spread
        curAtr,
        slBufferPct: this.opts.slBufferPct,
        waterfallGuardMode: this.opts.waterfallGuardMode,
        isHtfBull: htf.isBullish,
        macroGateMode: this.opts.macroGateMode,
        htfRegime: htf,
        enableUpsideFloor: this.opts.enableUpsideFloor,
      });
      if (dec.shouldEnter) {
        this.baseCandidate[i] = 1;
        entryPrices[i] = dec.entryPrice;
        initialSls[i] = dec.stopLossPrice;
      }
    }

    // Pass 2: Forward trade simulation outcomes once htfRegimes is fully populated
    for (let i = 0; i < candles.length; i++) {
      if (this.baseCandidate[i] === 1) {
        this.outcomes[i] = this.simulateTradeFrom(i, entryPrices[i]!, initialSls[i]!);
      }
    }
  }

  private simulateTradeFrom(entryIdx: number, entryPrice: number, initialSl: number): TradeOutcome {
    const { candles, ribbons, exhaustions, atrs, htfRegimes, opts, costPerFill } = this;
    const initialQtyPerInvest = (1 / entryPrice) * (1 - costPerFill);
    let remQty = initialQtyPerInvest;
    let stopLossPrice = initialSl;
    let tp1Filled = false;
    let tp1Idx = -1;
    let tp1ProceedsPerInvest = 0;
    let remQtyAfterTp1PerInvest = initialQtyPerInvest;
    let highestSinceTp1 = entryPrice;

    for (let k = entryIdx + 1; k < candles.length; k++) {
      const c = candles[k]!;
      if (c.high > highestSinceTp1) highestSinceTp1 = c.high;
      const barsHeld = k - entryIdx;
      const curAtr = atrs[k] || c.close * 0.003;

      const liftedSl = MaFanCoreRules.evaluateRatchetSl({
        candles,
        currentIndex: k,
        barsHeld,
        currentSlPrice: stopLossPrice,
        currentPrice: c.close,
        curAtr,
        slBufferPct: opts.slBufferPct,
        useRatchetSl: opts.useRatchetSl,
      });
      if (liftedSl !== null && liftedSl > stopLossPrice) {
        stopLossPrice = liftedSl;
      }

      const htf = htfRegimes[k]!;
      const exitDecision = MaFanCoreRules.evaluateExits({
        highPrice: c.high,
        lowPrice: c.low,
        closePrice: c.close,
        entryPrice,
        stopLossPrice,
        tp1Filled,
        highestPriceSinceTp1: highestSinceTp1,
        ribbon: ribbons[k]!,
        trailingPullbackPct: opts.trailingPullbackPct,
        breakevenFeeBufferPct: opts.breakevenFeeBufferPct,
        isOverbought: exhaustions[k]?.isOverboughtExhaustion,
        barsHeld,
        isHtfBull: !!htf.isBullish,
        cushionMode: opts.cushionMode,
      });

      if (exitDecision.action === "TP2" || exitDecision.action === "SL") {
        const proceeds2 = remQty * exitDecision.exitPrice * (1 - costPerFill);
        return {
          exitIdx: k,
          tp1Idx,
          tp1ProceedsPerInvest,
          initialQtyPerInvest,
          remQtyAfterTp1PerInvest,
          finalProceedsPerInvest: tp1ProceedsPerInvest + proceeds2,
        };
      }

      if (exitDecision.action === "TP1") {
        const activeTp1Ratio = htf.recommendedTp1Ratio ?? opts.tp1Ratio;
        const tp1Qty = remQty * activeTp1Ratio;
        tp1ProceedsPerInvest = tp1Qty * exitDecision.exitPrice * (1 - costPerFill);
        remQty -= tp1Qty;
        remQtyAfterTp1PerInvest = remQty;
        tp1Filled = true;
        tp1Idx = k;
        highestSinceTp1 = c.high;
        if (exitDecision.newStopLossPrice) {
          stopLossPrice = Math.max(stopLossPrice, exitDecision.newStopLossPrice);
        }
        if (exitDecision.newStopLossPrice && exitDecision.newStopLossPrice > entryPrice && c.close <= stopLossPrice) {
          const proceeds2 = remQty * stopLossPrice * (1 - costPerFill);
          return {
            exitIdx: k,
            tp1Idx,
            tp1ProceedsPerInvest,
            initialQtyPerInvest,
            remQtyAfterTp1PerInvest,
            finalProceedsPerInvest: tp1ProceedsPerInvest + proceeds2,
          };
        }
      }
    }

    return {
      exitIdx: candles.length,
      tp1Idx,
      tp1ProceedsPerInvest,
      initialQtyPerInvest,
      remQtyAfterTp1PerInvest,
      finalProceedsPerInvest: tp1ProceedsPerInvest,
    };
  }

  /**
   * Strictly Causal Best Spread Evaluation at endIdx
   * Evaluates historical candles [max(25, endIdx - lookbackBars + 1) ... endIdx]
   * Never peeks at any candle > endIdx.
   */
  public bestSpreadAt(endIdx: number, customLookback?: number): number {
    const res = this.getCalibrationResultAt(endIdx, customLookback);
    return res.bestSpreadPct;
  }

  /**
   * Generates Full CalibrationResult at endIdx with detailed candidate stats
   */
  public getCalibrationResultAt(endIdx: number, customLookback?: number): CalibrationResult {
    const lookback = customLookback ?? this.opts.lookbackBars;
    const startIdx = Math.max(25, endIdx - lookback + 1);
    const windowLen = Math.max(1, endIdx - startIdx + 1);
    const minRequiredTrades = Math.max(3, Math.floor(windowLen / 300));
    const initialCapital = this.opts.initialCapital;
    const cost = this.costPerFill;

    const candidatesResults: {
      spreadPct: number;
      netPnlPct: number;
      winRate: number;
      tradeCount: number;
      profitFactor: number;
      score: number;
    }[] = [];

    let maxScore = -1e9;
    let maxPnl = -1e9;
    let anyCandidateHadTrades = false;

    for (const spread of CANDIDATE_SPREADS) {
      let cash = initialCapital;
      let grossProfit = 0;
      let grossLoss = 0;
      let wins = 0;
      let losses = 0;
      let openMtmValue = 0;

      let pos = startIdx;
      while (pos <= endIdx) {
        if (this.baseCandidate[pos] === 1) {
          const req = spread * this.htfRegimes[pos]!.spreadMultiplier;
          if (this.ribbons[pos]!.fanSpreadPct >= req && cash >= 10) {
            const out = this.outcomes[pos]!;
            const invest = cash * 0.98;
            cash -= invest;

            if (out.exitIdx <= endIdx) {
              const proceeds = invest * out.finalProceedsPerInvest;
              cash += proceeds;
              const pnl = proceeds - invest;
              if (pnl >= 0) {
                grossProfit += pnl;
                wins++;
              } else {
                grossLoss -= pnl;
                losses++;
              }
              pos = out.exitIdx + 1;
              continue;
            } else {
              // Position still open at endIdx: strictly causal mark-to-market at close[endIdx]
              const closeEnd = this.candles[endIdx]!.close;
              if (out.tp1Idx !== -1 && out.tp1Idx <= endIdx) {
                cash += invest * out.tp1ProceedsPerInvest;
                openMtmValue = invest * out.remQtyAfterTp1PerInvest * closeEnd * (1 - cost);
              } else {
                openMtmValue = invest * out.initialQtyPerInvest * closeEnd * (1 - cost);
              }
              break;
            }
          }
        }
        pos++;
      }

      const totalTrades = wins + losses;
      if (totalTrades === 0) {
        candidatesResults.push({
          spreadPct: spread,
          netPnlPct: 0,
          winRate: 0,
          tradeCount: 0,
          profitFactor: 0,
          score: -1e9,
        });
        continue;
      }

      anyCandidateHadTrades = true;
      const winRate = (wins / totalTrades) * 100;
      const pf = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99.9 : 0;
      const finalEquity = cash + openMtmValue;
      const netPnlPct = ((finalEquity - initialCapital) / initialCapital) * 100;
      if (netPnlPct > maxPnl) maxPnl = netPnlPct;

      const cappedPF = Math.min(6.0, pf);
      const tradeConfidence = Math.min(1.0, totalTrades / minRequiredTrades);
      const score = ((cappedPF * (winRate / 100) * 10) + (netPnlPct * 0.5)) * tradeConfidence;

      candidatesResults.push({
        spreadPct: spread,
        netPnlPct,
        winRate,
        tradeCount: totalTrades,
        profitFactor: pf,
        score,
      });

      if (score > maxScore) maxScore = score;
    }

    let bestSpread = CANDIDATE_SPREADS[0]!;
    let bestCand = candidatesResults[0]!;

    if (this.opts.defensiveOnLossRegime) {
      // Case A: Completely quiet market (0 trades across all candidates) -> safe neutral 0.50%
      if (!anyCandidateHadTrades) {
        bestSpread = 0.50;
        const found = candidatesResults.find((c) => Math.abs(c.spreadPct - 0.50) < 1e-4);
        if (found) bestCand = found;
        return {
          symbol: this.symbol,
          bestSpreadPct: bestSpread,
          winRate: bestCand.winRate,
          profitFactor: bestCand.profitFactor,
          netPnlPct: bestCand.netPnlPct,
          tradeCount: bestCand.tradeCount,
          evaluatedAt: Date.now(),
          candidates: candidatesResults,
        };
      }

      // Case B: Toxic losing regime (every spread with trades lost money: maxPnl <= 0)
      // Pick the first wider spread that avoided trading (0 trades = 0 loss), or widest spread 1.80%
      if (maxPnl <= 0) {
        for (const cand of candidatesResults) {
          if (cand.tradeCount === 0) {
            bestSpread = cand.spreadPct;
            bestCand = cand;
            return {
              symbol: this.symbol,
              bestSpreadPct: bestSpread,
              winRate: bestCand.winRate,
              profitFactor: bestCand.profitFactor,
              netPnlPct: bestCand.netPnlPct,
              tradeCount: bestCand.tradeCount,
              evaluatedAt: Date.now(),
              candidates: candidatesResults,
            };
          }
        }
        bestSpread = CANDIDATE_SPREADS[CANDIDATE_SPREADS.length - 1]!;
        const lastCand = candidatesResults[candidatesResults.length - 1]!;
        return {
          symbol: this.symbol,
          bestSpreadPct: bestSpread,
          winRate: lastCand.winRate,
          profitFactor: lastCand.profitFactor,
          netPnlPct: lastCand.netPnlPct,
          tradeCount: lastCand.tradeCount,
          evaluatedAt: Date.now(),
          candidates: candidatesResults,
        };
      }
    }

    // Standard scoring with Conservative Tie-Break Margin (2%)
    if (maxScore <= -1e8) {
      bestSpread = CANDIDATE_SPREADS[0]!;
    } else {
      const margin = this.opts.tieBreakMarginPct;
      const threshold = maxScore >= 0 ? maxScore * (1 - margin) : maxScore * (1 + margin);
      for (const cand of candidatesResults) {
        if (cand.tradeCount > 0 && cand.score >= threshold) {
          bestSpread = cand.spreadPct; // Picks widest spread within margin
          bestCand = cand;
        }
      }
    }

    return {
      symbol: this.symbol,
      bestSpreadPct: bestSpread,
      winRate: bestCand.winRate,
      profitFactor: bestCand.profitFactor,
      netPnlPct: bestCand.netPnlPct,
      tradeCount: bestCand.tradeCount,
      evaluatedAt: Date.now(),
      candidates: candidatesResults,
    };
  }
}
