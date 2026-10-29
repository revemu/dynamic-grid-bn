/**
 * MA Fan Elastic Exhaustion & Reversion Strategy State Machine
 * Implements the full lifecycle:
 * 1. Momentum Exhaustion Hook Detection
 * 2. Sniper Buy Order Execution
 * 3. TP1 Mean Reversion Exit at EMA 25
 * 4. Instant Breakeven Stop Loss Lock-in
 * 5. TP2 Macro Runner / Trailing Exit
 */

import { IExchangeClient } from "../../exchange/types.js";
import { getDatabase } from "../../db.js";
import { Candle, MaFanConfig, MaFanPosition, RibbonState, HtfRegime, CalibrationResult } from "./types.js";
import { RibbonEngine, calcATR } from "./ribbon.js";
import { ExhaustionEngine } from "./exhaustion.js";
import { RegimeSupervisor } from "./regime.js";
import { AutoCalibrator } from "./calibrator.js";
import { MaFanOrderExecutor } from "./executor.js";
import { MaFanCoreRules } from "./core-rules.js";

export interface MaFanStrategyOptions {
  symbol: string;
  config: MaFanConfig;
  client: IExchangeClient;
  onLog?: (msg: string) => void;
  onTrade?: (trade: any) => void;
  onStateUpdate?: (state: any) => void;
}

export class MaFanStrategy {
  public symbol: string;
  public config: MaFanConfig;
  public client: IExchangeClient;
  public executor: MaFanOrderExecutor;

  private candles: Candle[] = [];
  private candlesHtf: Candle[] = [];
  private activePosition: MaFanPosition | null = null;
  private currentRibbon?: RibbonState;
  private currentHtfRegime?: HtfRegime;
  private lastCalibration?: CalibrationResult;
  private effectiveSpreadThreshold: number = 0.40;
  private lastClosedCandle: Candle | null = null;
  private evaluatedClosedCandleTime: number = 0;

  private isPaused: boolean = true;
  private isProcessing: boolean = false;
  private log: (msg: string) => void;
  private onTrade?: (trade: any) => void;
  private onStateUpdate?: (state: any) => void;
  private db = getDatabase();

  // Metrics
  private totalCycles: number = 0;
  private winCount: number = 0;
  private lossCount: number = 0;
  private realizedPnl: number = 0;

  constructor(opts: MaFanStrategyOptions) {
    this.symbol = opts.symbol;
    this.config = opts.config;
    this.client = opts.client;
    this.isPaused = opts.config.startPaused ?? true;
    this.log = opts.onLog ?? ((msg) => console.log(`[ma-fan-strategy] ${msg}`));
    this.onTrade = opts.onTrade;
    this.onStateUpdate = opts.onStateUpdate;

    this.executor = new MaFanOrderExecutor({
      client: this.client,
      dryRun: this.config.isDryRun ?? false,
      breakevenFeeBufferPct: this.config.breakevenFeeBufferPct,
      slBufferPct: this.config.slBufferPct,
      onTrade: (t: any) => {
        this.restoreMetricsFromDb();
        this.onTrade?.(t);
      },
      onLog: this.log,
    });

    this.effectiveSpreadThreshold = this.config.manualSpreadPct;
    this.restoreMetricsFromDb();
  }

  private restoreMetricsFromDb(): void {
    try {
      const summary = this.db.getTradeRounds(this.symbol)?.summary;
      if (summary) {
        this.totalCycles = summary.closedRounds || 0;
        this.winCount = summary.winRounds || 0;
        this.lossCount = summary.lossRounds || 0;
        this.realizedPnl = Number((summary.totalNetPnlQuote || summary.totalGrossPnlQuote || 0).toFixed(4));
      }
    } catch (_) {}
  }

  public async init(): Promise<void> {
    await this.executor.init(this.symbol);
    this.log(`🚀 MaFanStrategy initialized for ${this.symbol} (DryRun: ${this.config.isDryRun})`);
  }

  public setInitialCandles(candles: Candle[]): void {
    // Only ingest confirmed closed candles so indicators and entry evaluations match closed-bar backtests 1:1
    this.candles = candles.filter((c) => c.isClosed !== false).sort((a, b) => a.time - b.time);
    if (this.candles.length > 0) {
      this.lastClosedCandle = this.candles[this.candles.length - 1] ?? null;
      this.evaluatedClosedCandleTime = this.lastClosedCandle ? this.lastClosedCandle.time : 0;
    }
    this.recomputeIndicators();
    if (this.config.autoCalibrateSpreadOnSwitch && this.candles.length >= 50) {
      this.calibrateSpread();
    }
  }

  public setInitialHtfCandles(candles: Candle[]): void {
    this.candlesHtf = candles.filter((c) => c.isClosed !== false).sort((a, b) => a.time - b.time);
    this.currentHtfRegime = RegimeSupervisor.evaluateHtfRegime(this.candlesHtf, this.config.supervisorTimeframe, undefined, this.config.tp1Ratio);
  }

  public onCandle(candle: Candle, isClosed: boolean): void {
    if (!isClosed) return;
    this.lastClosedCandle = candle;
    const idx = this.candles.findIndex((c) => c.time === candle.time);
    if (idx >= 0) {
      this.candles[idx] = candle;
    } else {
      this.candles.push(candle);
      this.candles.sort((a, b) => a.time - b.time);
      if (this.candles.length > 1200) this.candles.shift();
    }
    this.recomputeIndicators();
  }

  public onHtfCandle(candle: Candle, isClosed: boolean): void {
    if (!isClosed) return;
    const idx = this.candlesHtf.findIndex((c) => c.time === candle.time);
    if (idx >= 0) {
      this.candlesHtf[idx] = candle;
    } else {
      this.candlesHtf.push(candle);
      this.candlesHtf.sort((a, b) => a.time - b.time);
      if (this.candlesHtf.length > 300) this.candlesHtf.shift();
    }
    this.currentHtfRegime = RegimeSupervisor.evaluateHtfRegime(this.candlesHtf, this.config.supervisorTimeframe, undefined, this.config.tp1Ratio);
  }

  public calibrateSpread(): CalibrationResult | null {
    if (this.candles.length < 50) return null;
    const t0 = Date.now();
    const res = AutoCalibrator.calibrate(this.symbol, this.candles, undefined, this.candlesHtf, {
      slBufferPct: this.config.slBufferPct,
      trailingPullbackPct: this.config.trailingPullbackPct,
      breakevenFeeBufferPct: this.config.breakevenFeeBufferPct,
      tp1Ratio: this.config.tp1Ratio,
      initialCapital: this.config.maxPositionBudgetUsd,
      supervisorTimeframe: this.config.supervisorTimeframe,
      useRatchetSl: this.config.useRatchetSl !== false,
    });
    this.lastCalibration = res;
    this.effectiveSpreadThreshold = res.bestSpreadPct;
    this.log(`⚡ [AUTO_CALIBRATED] ${this.symbol} sweet spot spread: ${res.bestSpreadPct}% (Sim WinRate: ${res.winRate.toFixed(1)}%, took ${Date.now() - t0}ms)`);
    return res;
  }

  public refreshConfig(): void {
    if (this.candlesHtf.length > 0) {
      this.currentHtfRegime = RegimeSupervisor.evaluateHtfRegime(this.candlesHtf, this.config.supervisorTimeframe, undefined, this.config.tp1Ratio);
    }
    if (this.config.autoCalibrateSpreadOnSwitch && this.candles.length >= 50 && !this.lastCalibration) {
      this.calibrateSpread();
    } else {
      this.recomputeIndicators();
    }
    this.onStateUpdate?.(this.getState());
  }

  public recomputeIndicators(): void {
    if (this.candles.length < 25) return;
    this.currentRibbon = RibbonEngine.computeRibbonState(this.candles);

    // Compute dynamic spread threshold via Universal MaFanCoreRules
    const atrs = calcATR(this.candles, 14);
    const curAtr = atrs[atrs.length - 1] ?? 0;
    const lastClose = this.candles[this.candles.length - 1]?.close ?? 1;

    this.effectiveSpreadThreshold = MaFanCoreRules.computeEffectiveSpread({
      baseSpread: this.lastCalibration?.bestSpreadPct ?? this.config.manualSpreadPct,
      useAtrAdaptiveSpread: this.config.useAtrAdaptiveSpread,
      isAutoCalibrated: !!(this.config.autoCalibrateSpreadOnSwitch && this.lastCalibration),
      curAtr,
      closePrice: lastClose,
      atrMultiplier: this.config.atrMultiplier,
    });
  }

  /**
   * Main Strategy Tick Step
   */
  public async step(refPrice: number): Promise<void> {
    if (this.isProcessing || this.isPaused) return;
    this.isProcessing = true;

    try {
      if (!this.currentRibbon || this.candles.length < 25) {
        return;
      }

      const ribbon = this.currentRibbon;
      const htfRegime = this.currentHtfRegime || {
        timeframe: this.config.supervisorTimeframe,
        isBullish: true,
        isAboveEma200: true,
        spreadMultiplier: 1.0,
        recommendedTp1Ratio: this.config.tp1Ratio,
      };

      // ── 1. MANAGE ACTIVE POSITION EXITS ──────────────────────────────────────
      if (this.activePosition && this.activePosition.remainingQty > 0) {
        const pos = this.activePosition;
        if (refPrice > pos.highestPriceSinceTp1) {
          pos.highestPriceSinceTp1 = refPrice;
        }

        const entryTimeSec = Math.floor(pos.entryTime / 1000);
        // Count confirmed candles in history that closed at or after entryTime
        const barsHeld = this.candles.filter((c) => c.time >= entryTimeSec - 5).length;
        const atrs = calcATR(this.candles, 14);
        const curAtr = atrs[atrs.length - 1] ?? (refPrice * 0.003);

        // Keep evaluatedClosedCandleTime up to date while holding a position so we don't evaluate old closed candles upon exit
        if (this.lastClosedCandle) {
          this.evaluatedClosedCandleTime = this.lastClosedCandle.time;
        }

        // Dynamic Ratchet SL: After entry, if price forms higher local base, lift SL
        const liftedSl = MaFanCoreRules.evaluateRatchetSl({
          candles: this.candles,
          barsHeld,
          currentSlPrice: pos.stopLossPrice,
          currentPrice: refPrice,
          curAtr,
          slBufferPct: this.config.slBufferPct,
          useRatchetSl: this.config.useRatchetSl !== false,
        });

        if (liftedSl !== null) {
          const roundedSl = this.executor.roundPrice(liftedSl);
          if (roundedSl > pos.stopLossPrice) {
            this.log(`🛡️ [RATCHET_SL] Lifting SL for ${this.symbol} from $${pos.stopLossPrice.toFixed(4)} to $${roundedSl.toFixed(4)}`);
            pos.stopLossPrice = roundedSl;
            this.onStateUpdate?.(this.getState());
          }
        }

        // Evaluate Exits (Priority: TP2 -> SL -> TP1 & Trapped Rescue)
        const exhaustion = ExhaustionEngine.evaluate(this.candles);
        const exitDecision = MaFanCoreRules.evaluateExits({
          highPrice: refPrice,
          lowPrice: refPrice,
          closePrice: refPrice,
          entryPrice: pos.entryPrice,
          stopLossPrice: pos.stopLossPrice,
          tp1Filled: pos.tp1Filled,
          highestPriceSinceTp1: pos.highestPriceSinceTp1,
          ribbon,
          trailingPullbackPct: this.config.trailingPullbackPct,
          breakevenFeeBufferPct: this.config.breakevenFeeBufferPct,
          isOverbought: exhaustion.isOverboughtExhaustion,
          barsHeld,
        });

        // A. Take Profit 2 (Macro Runner / Trailing Stop)
        if (exitDecision.action === "TP2") {
          const ok = await this.executor.executeTp2(pos, refPrice, exitDecision.reason || "TP2 Exit");
          if (ok) {
            this.activePosition = null;
            if (this.lastClosedCandle) this.evaluatedClosedCandleTime = this.lastClosedCandle.time;
            this.totalCycles++;
            this.onStateUpdate?.(this.getState());
          }
          return;
        }

        // B. Stop Loss Exit
        if (exitDecision.action === "SL") {
          this.log(`⚠️ Stop Loss triggered for ${this.symbol} at $${refPrice.toFixed(4)} (SL: $${pos.stopLossPrice.toFixed(4)})`);
          const ok = await this.executor.executeStopLoss(pos, refPrice);
          if (ok) {
            this.activePosition = null;
            if (this.lastClosedCandle) this.evaluatedClosedCandleTime = this.lastClosedCandle.time;
            this.totalCycles++;
            this.onStateUpdate?.(this.getState());
          }
          return;
        }

        // C. Take Profit 1 (Mean Reversion at EMA 25 & Trapped Breakeven Rescue)
        if (exitDecision.action === "TP1") {
          const ratio = htfRegime.recommendedTp1Ratio ?? this.config.tp1Ratio;
          const ok = await this.executor.executeTp1(pos, refPrice, ratio);
          if (ok) {
            if (exitDecision.newStopLossPrice && exitDecision.newStopLossPrice > pos.stopLossPrice) {
              pos.stopLossPrice = this.executor.roundPrice(exitDecision.newStopLossPrice);
            }
            if (pos.remainingQty <= 0) {
              this.activePosition = null;
              this.totalCycles++;
            }
            this.onStateUpdate?.(this.getState());
          }
          return;
        }

        return;
      }

      // ── 2. SCAN FOR ENTRY (ELASTIC HOOK BUY) ──────────────────────────────────
      if (!this.activePosition) {
        const entryOnClosedOnly = this.config.entryOnClosedOnly !== false;

        // In confirmed candle close mode, evaluate entry strictly on confirmed closed bars (aligns with Backtest)
        if (entryOnClosedOnly) {
          if (!this.lastClosedCandle || this.lastClosedCandle.time === this.evaluatedClosedCandleTime) {
            return;
          }
          this.evaluatedClosedCandleTime = this.lastClosedCandle.time;
        }

        const requiredSpread = this.effectiveSpreadThreshold * htfRegime.spreadMultiplier;
        const exhaustion = ExhaustionEngine.evaluate(this.candles);
        const atrs = calcATR(this.candles, 14);
        const curAtr = atrs[atrs.length - 1] ?? 0;
        const evalPrice = (entryOnClosedOnly && this.lastClosedCandle) ? this.lastClosedCandle.close : refPrice;

        const entryDecision = MaFanCoreRules.evaluateEntry({
          candles: this.candles,
          closePrice: evalPrice,
          ribbon,
          exhaustion,
          requiredSpreadPct: requiredSpread,
          curAtr,
          slBufferPct: this.config.slBufferPct,
        });

        if (entryDecision.shouldEnter) {
          const budget = this.config.maxPositionBudgetUsd;
          this.log(`🎯 Entry criteria met: Fan Spread=${entryDecision.fanSpreadPct.toFixed(2)}% (Req: ${requiredSpread.toFixed(2)}%), Hook=${ribbon.isHookUp}, Oversold=${exhaustion.isOversoldExhaustion}`);

          const newPos = await this.executor.executeBuy(
            this.symbol,
            refPrice,
            budget,
            entryDecision.swingLow,
            htfRegime,
            entryDecision.fanSpreadPct,
            curAtr
          );

          if (newPos) {
            this.activePosition = newPos;
            this.onStateUpdate?.(this.getState());
          }
        }
      }
    } catch (err: any) {
      this.log(`❌ Error in MaFanStrategy step: ${err.message}`);
    } finally {
      this.isProcessing = false;
    }
  }

  public getState(): any {
    const exhaustion = this.candles.length >= 25 ? ExhaustionEngine.evaluate(this.candles) : null;
    const totalTrades = this.winCount + this.lossCount;
    const winRate = totalTrades > 0 ? (this.winCount / totalTrades) * 100 : 0;

    const htfMultiplier = this.currentHtfRegime?.spreadMultiplier ?? 1.0;
    const requiredSpread = Number((this.effectiveSpreadThreshold * htfMultiplier).toFixed(2));

    return {
      strategyType: "ma_fan",
      strategyMode: "ma_fan",
      symbol: this.symbol,
      isPaused: this.isPaused,
      activePosition: this.activePosition,
      effectiveSpreadThreshold: requiredSpread,
      baseSpreadThreshold: this.effectiveSpreadThreshold,
      lastCalibration: this.lastCalibration,
      ribbon: this.currentRibbon,
      htfRegime: this.currentHtfRegime,
      rsi: exhaustion?.rsi,
      macd: exhaustion?.macd,
      metrics: {
        totalCycles: this.totalCycles,
        winCount: this.winCount,
        lossCount: this.lossCount,
        winRate,
        realizedPnl: this.realizedPnl,
      },
      lastUpdated: Date.now(),
    };
  }

  public setPaused(paused: boolean): boolean {
    this.isPaused = paused;
    this.log(`Strategy pause set to: ${paused}`);
    return this.isPaused;
  }

  public getIsPaused(): boolean {
    return this.isPaused;
  }

  public async cancelAll(): Promise<{ cancelledCount: number }> {
    return { cancelledCount: 0 };
  }

  public async sellAll(): Promise<{ success: boolean; soldQty: number; price: number; error?: string }> {
    if (!this.activePosition || this.activePosition.remainingQty <= 0) {
      return { success: true, soldQty: 0, price: 0 };
    }
    const pos = this.activePosition;
    const price = this.candles[this.candles.length - 1]?.close ?? pos.entryPrice;
    const soldQty = pos.remainingQty;
    const ok = await this.executor.executeStopLoss(pos, price);
    this.activePosition = null;
    this.onStateUpdate?.(this.getState());
    return { success: ok, soldQty, price };
  }

  public restorePosition(pos: MaFanPosition | null): void {
    this.restoreMetricsFromDb();
    if (pos && pos.remainingQty > 0) {
      this.activePosition = pos;
      this.log(`📥 [STATE RESTORED] Loaded active position for ${pos.symbol}: ${pos.remainingQty} units @ $${pos.entryPrice.toFixed(4)} (SL: $${pos.stopLossPrice.toFixed(4)}, TP1 Filled: ${pos.tp1Filled}, Breakeven Locked: ${pos.isBreakevenLocked})`);
    } else {
      this.activePosition = null;
    }
  }

  public getActivePosition(): MaFanPosition | null {
    return this.activePosition;
  }

  public getExecutor(): MaFanOrderExecutor {
    return this.executor;
  }
}
