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
      onTrade: (t) => {
        if (t.type === "TP1_EMA25" || t.type === "TP2_RUNNER") {
          this.winCount++;
          if (t.pnl) this.realizedPnl += t.pnl;
        } else if (t.type === "STOP_LOSS") {
          if (t.pnl && t.pnl >= 0) this.winCount++;
          else this.lossCount++;
          if (t.pnl) this.realizedPnl += t.pnl;
        }
        this.onTrade?.(t);
      },
      onLog: this.log,
    });

    this.effectiveSpreadThreshold = this.config.manualSpreadPct;
  }

  public async init(): Promise<void> {
    await this.executor.init(this.symbol);
    this.log(`🚀 MaFanStrategy initialized for ${this.symbol} (DryRun: ${this.config.isDryRun})`);
  }

  public setInitialCandles(candles: Candle[]): void {
    this.candles = [...candles].sort((a, b) => a.time - b.time);
    this.recomputeIndicators();
    if (this.config.autoCalibrateSpreadOnSwitch && this.candles.length >= 50) {
      this.calibrateSpread();
    }
  }

  public setInitialHtfCandles(candles: Candle[]): void {
    this.candlesHtf = [...candles].sort((a, b) => a.time - b.time);
    this.currentHtfRegime = RegimeSupervisor.evaluateHtfRegime(this.candlesHtf, this.config.supervisorTimeframe);
  }

  public onCandle(candle: Candle, isClosed: boolean): void {
    const idx = this.candles.findIndex((c) => c.time === candle.time);
    if (idx >= 0) {
      this.candles[idx] = candle;
    } else {
      this.candles.push(candle);
      this.candles.sort((a, b) => a.time - b.time);
      if (this.candles.length > 500) this.candles.shift();
    }
    this.recomputeIndicators();
  }

  public onHtfCandle(candle: Candle, isClosed: boolean): void {
    const idx = this.candlesHtf.findIndex((c) => c.time === candle.time);
    if (idx >= 0) {
      this.candlesHtf[idx] = candle;
    } else {
      this.candlesHtf.push(candle);
      this.candlesHtf.sort((a, b) => a.time - b.time);
      if (this.candlesHtf.length > 300) this.candlesHtf.shift();
    }
    this.currentHtfRegime = RegimeSupervisor.evaluateHtfRegime(this.candlesHtf, this.config.supervisorTimeframe);
  }

  public calibrateSpread(): CalibrationResult | null {
    if (this.candles.length < 50) return null;
    const t0 = Date.now();
    const res = AutoCalibrator.calibrate(this.symbol, this.candles);
    this.lastCalibration = res;
    this.effectiveSpreadThreshold = res.bestSpreadPct;
    this.log(`⚡ [AUTO_CALIBRATED] ${this.symbol} sweet spot spread: ${res.bestSpreadPct}% (Sim WinRate: ${res.winRate.toFixed(1)}%, took ${Date.now() - t0}ms)`);
    return res;
  }

  private recomputeIndicators(): void {
    if (this.candles.length < 25) return;
    this.currentRibbon = RibbonEngine.computeRibbonState(this.candles);

    // Compute dynamic spread if ATR adaptive is enabled
    if (this.config.useAtrAdaptiveSpread) {
      const atrs = calcATR(this.candles, 14);
      const curAtr = atrs[atrs.length - 1] ?? 0;
      const lastClose = this.candles[this.candles.length - 1]?.close ?? 1;
      const atrPct = (curAtr / lastClose) * 100;
      const baseSpread = this.config.autoCalibrateSpreadOnSwitch && this.lastCalibration
        ? this.lastCalibration.bestSpreadPct
        : this.config.manualSpreadPct;

      this.effectiveSpreadThreshold = Math.max(0.20, Math.max(baseSpread, atrPct * this.config.atrMultiplier));
    }
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

        // A. Stop Loss Exit
        if (refPrice <= pos.stopLossPrice) {
          this.log(`⚠️ Stop Loss triggered for ${this.symbol} at $${refPrice.toFixed(4)} (SL: $${pos.stopLossPrice.toFixed(4)})`);
          await this.executor.executeStopLoss(pos, refPrice);
          this.activePosition = null;
          this.totalCycles++;
          this.onStateUpdate?.(this.getState());
          return;
        }

        // B. Take Profit 1 (Mean Reversion at EMA 25)
        if (!pos.tp1Filled && refPrice >= ribbon.ema25 && ribbon.ema25 > pos.entryPrice * 1.0015) {
          const ratio = htfRegime.recommendedTp1Ratio ?? this.config.tp1Ratio;
          const ok = await this.executor.executeTp1(pos, refPrice, ratio);
          if (ok) {
            if (pos.remainingQty <= 0) {
              this.activePosition = null;
              this.totalCycles++;
            }
            this.onStateUpdate?.(this.getState());
          }
          return;
        }

        // C. Take Profit 2 (Macro Runner / Trailing Stop)
        if (pos.tp1Filled && pos.remainingQty > 0) {
          const macroTarget = Math.max(ribbon.ema75, ribbon.ema200);
          const hitMacro = refPrice >= macroTarget && refPrice > pos.entryPrice * 1.0035;

          const trailingHit =
            pos.highestPriceSinceTp1 > pos.entryPrice * (1 + (this.config.trailingPullbackPct * 1.5) / 100) &&
            refPrice <= pos.highestPriceSinceTp1 * (1 - this.config.trailingPullbackPct / 100);

          const exhaustion = ExhaustionEngine.evaluate(this.candles);
          const hitOverbought = exhaustion.isOverboughtExhaustion && refPrice > pos.entryPrice * 1.008;

          if (hitMacro || trailingHit || hitOverbought) {
            const reason = trailingHit
              ? `Trailing Pullback (${this.config.trailingPullbackPct}%) from peak $${pos.highestPriceSinceTp1.toFixed(4)}`
              : hitMacro
              ? `EMA Macro Target Reached ($${macroTarget.toFixed(4)})`
              : "Overbought Exhaustion Exit";

            await this.executor.executeTp2(pos, refPrice, reason);
            this.activePosition = null;
            this.totalCycles++;
            this.onStateUpdate?.(this.getState());
            return;
          }
        }
        return;
      }

      // ── 2. SCAN FOR ENTRY (ELASTIC HOOK BUY) ──────────────────────────────────
      if (!this.activePosition) {
        const requiredSpread = this.effectiveSpreadThreshold * htfRegime.spreadMultiplier;
        const isStretched = ribbon.fanSpreadPct >= requiredSpread;

        const exhaustion = ExhaustionEngine.evaluate(this.candles);
        const isHook = ribbon.isHookUp;

        const isDownside = ribbon.ema4 <= ribbon.ema25 && refPrice < ribbon.ema25;

        if (ribbon.isFanningDown && isStretched && isHook && exhaustion.isOversoldExhaustion && isDownside) {
          const recentCandles = this.candles.slice(Math.max(0, this.candles.length - 12));
          const swingLow = Math.min(...recentCandles.map((c) => c.low));

          const budget = this.config.maxPositionBudgetUsd;
          this.log(`🎯 Entry criteria met: Fan Spread=${ribbon.fanSpreadPct.toFixed(2)}% (Req: ${requiredSpread.toFixed(2)}%), Hook=${isHook}, Oversold=${exhaustion.isOversoldExhaustion}`);

          const newPos = await this.executor.executeBuy(
            this.symbol,
            refPrice,
            budget,
            swingLow,
            htfRegime,
            ribbon.fanSpreadPct
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

    return {
      strategyType: "ma_fan",
      strategyMode: "ma_fan",
      symbol: this.symbol,
      isPaused: this.isPaused,
      activePosition: this.activePosition,
      effectiveSpreadThreshold: this.effectiveSpreadThreshold,
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
}
