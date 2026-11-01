/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import fs from "fs";
import path from "path";
import { BacktestService } from "./backtest-service.js";
import { getActiveBinanceTradingSymbols } from "./exchange/binance/client.js";
import type { Config } from "./config.js";

export interface RotationCandidateScore {
  symbol: string;
  compositeScore: number;
  simScore: number;
  structureScore: number;
  positionScore: number;
  liquidityScore: number;
  netPnlPct: number;
  winRate: number;
  tradesCount: number;
  maxDrawdownPct: number;
  quoteVolume24h: number;
  change24hPct: number;
  range24hPct: number;
  posInRange: number;
  channelWidthPct?: number;
  reason: string;
}

export interface RotationHistoryRecord {
  timestamp: number;
  fromSymbol: string;
  toSymbol: string;
  fromScore: number;
  toScore: number;
  triggerReason: "POST_ROUND_EXIT" | "IDLE_CASH_TIMEOUT" | "MANUAL_FORCE";
  topCandidates: RotationCandidateScore[];
}

export interface RotationStatus {
  enabled: boolean;
  quoteAsset: "USDT" | "FDUSD";
  lastScanTime: number;
  lastRotationTime: number;
  currentSymbol: string;
  currentSymbolScore: number;
  latestCandidates: RotationCandidateScore[];
  history: RotationHistoryRecord[];
}

const ROTATION_DB_PATH = path.resolve(process.cwd(), "data", "pair-rotation.db.json");

const STABLE_BASE_TOKENS = new Set([
  "USDC", "FDUSD", "USDT", "TUSD", "BUSD", "USDP", "DAI", "EUR", "EURI", "AEUR"
]);

export class AutonomousPairRotator {
  private isScanning = false;
  public lastRotationTime: number = 0;
  public lastScanTime: number = 0;
  private history: RotationHistoryRecord[] = [];
  private latestCandidates: RotationCandidateScore[] = [];

  constructor(private readonly logger?: (msg: string) => void) {
    this.loadState();
  }

  private log(msg: string): void {
    if (this.logger) {
      this.logger(`[PairRotator] ${msg}`);
    } else {
      console.log(`[PairRotator] ${msg}`);
    }
  }

  private loadState(): void {
    try {
      if (fs.existsSync(ROTATION_DB_PATH)) {
        const raw = fs.readFileSync(ROTATION_DB_PATH, "utf8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.history)) this.history = parsed.history.slice(-50);
        if (Array.isArray(parsed.latestCandidates)) this.latestCandidates = parsed.latestCandidates;
        if (typeof parsed.lastRotationTime === "number") this.lastRotationTime = parsed.lastRotationTime;
        if (typeof parsed.lastScanTime === "number") this.lastScanTime = parsed.lastScanTime;
      }
    } catch (e: any) {
      this.log(`Warning: Failed to load pair-rotation.db.json: ${e.message}`);
    }
  }

  private saveState(): void {
    try {
      const dir = path.dirname(ROTATION_DB_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        ROTATION_DB_PATH,
        JSON.stringify(
          {
            lastRotationTime: this.lastRotationTime,
            lastScanTime: this.lastScanTime,
            latestCandidates: this.latestCandidates,
            history: this.history,
          },
          null,
          2
        ),
        "utf8"
      );
    } catch (e: any) {
      this.log(`Warning: Failed to save pair-rotation.db.json: ${e.message}`);
    }
  }

  public getStatus(currentSymbol: string, cfg: Config): RotationStatus {
    const currentScoreItem = this.latestCandidates.find(
      (c) => c.symbol.toUpperCase().replace(/[\/\-_:]/g, "") === currentSymbol.toUpperCase().replace(/[\/\-_:]/g, "")
    );
    return {
      enabled: Boolean(cfg.enableAutoRotation),
      quoteAsset: cfg.rotationQuoteAsset || "USDT",
      lastScanTime: this.lastScanTime,
      lastRotationTime: this.lastRotationTime,
      currentSymbol,
      currentSymbolScore: currentScoreItem?.compositeScore || 0,
      latestCandidates: this.latestCandidates,
      history: this.history,
    };
  }

  /**
   * Evaluates the market regime across candidate pairs and determines if an automatic pair rotation should occur.
   */
  public async evaluateAndRotate(opts: {
    currentSymbol: string;
    trigger: "POST_ROUND_EXIT" | "IDLE_CASH_TIMEOUT" | "MANUAL_FORCE";
    cfg: Config;
    forceRotate?: boolean;
    quoteAsset?: string;
  }): Promise<{ rotated: boolean; targetSymbol?: string; report: RotationCandidateScore[]; reason: string }> {
    if (this.isScanning) {
      return {
        rotated: false,
        report: this.latestCandidates,
        reason: "A market scan is already in progress. Please wait for completion.",
      };
    }
    this.isScanning = true;

    try {
      const { currentSymbol, trigger, cfg, forceRotate } = opts;
      const normCurrent = currentSymbol.toUpperCase().replace(/[\/\-_:]/g, "");

      // 1. Cooldown Guard
      const cooldownMs = (cfg.rotationIntervalMinutes || 180) * 60_000;
      const timeSinceLastRotation = Date.now() - this.lastRotationTime;
      if (trigger !== "MANUAL_FORCE" && !forceRotate && timeSinceLastRotation < cooldownMs) {
        const remainingMins = Math.ceil((cooldownMs - timeSinceLastRotation) / 60_000);
        const reason = `Rotation cooldown active (${remainingMins} min remaining)`;
        return { rotated: false, report: this.latestCandidates, reason };
      }

      const targetQuote = opts.quoteAsset === "FDUSD" || (!opts.quoteAsset && cfg.rotationQuoteAsset === "FDUSD") ? "FDUSD" : "USDT";
    this.log(`Initiating market scan (${trigger}) for Quote Asset: ${targetQuote}...`);

    // 2. Stage 1: Lightweight 24h Ticker Fetch & Filtering
    let tickers: Array<{
      symbol: string;
      quoteVolume: string;
      highPrice: string;
      lowPrice: string;
      lastPrice: string;
      priceChangePercent: string;
      count: number;
    }> = [];

    try {
      const tickerRes = await fetch("https://api.binance.com/api/v3/ticker/24hr", {
        headers: { "User-Agent": "dynamic-grid-bn/rotator" },
      });
      if (!tickerRes.ok) {
        throw new Error(`Binance 24hr API HTTP ${tickerRes.status}`);
      }
      tickers = (await tickerRes.json()) as any[];
    } catch (err: any) {
      this.log(`Failed to fetch Binance 24h ticker: ${err.message}`);
      return { rotated: false, report: this.latestCandidates, reason: `Ticker fetch error: ${err.message}` };
    }

    const minVolume = cfg.rotationMinVolumeUsd || 3_000_000;
    const blacklistSet = new Set(
      (cfg.rotationBlacklist || []).map((s) => s.toUpperCase().replace(/[\/\-_:]/g, ""))
    );
    const whitelistSet = new Set(
      (cfg.rotationWhitelist || []).map((s) => s.toUpperCase().replace(/[\/\-_:]/g, ""))
    );

    const activeTradingSymbols = await getActiveBinanceTradingSymbols();

    // Filter tickers matching target Quote Asset
    const prefiltered = tickers.filter((t) => {
      const sym = t.symbol.toUpperCase();
      if (activeTradingSymbols.size > 0 && !activeTradingSymbols.has(sym)) return false;
      if (!sym.endsWith(targetQuote)) return false;
      const base = sym.slice(0, -targetQuote.length);
      if (STABLE_BASE_TOKENS.has(base)) return false;
      if (blacklistSet.has(sym)) return false;
      if (whitelistSet.size > 0 && !whitelistSet.has(sym)) return false;

      const vol = Number(t.quoteVolume);
      if (vol < minVolume) return false;

      const high = Number(t.highPrice);
      const low = Number(t.lowPrice);
      const change = Number(t.priceChangePercent);
      if (low <= 0 || high <= low) return false;

      const rangePct = ((high - low) / low) * 100;
      // Sweet spot range: 4% to 22%
      if (rangePct < 4.0 || rangePct > 22.0) return false;
      // Filter out heavy dumps or vertical pumps
      if (change < -5.5 || change > 15.0) return false;

      const last = Number(t.lastPrice);
      const posRatio = (last - low) / (high - low);
      // Favorable entry: price between 10% and 65% of 24h range
      if (posRatio < 0.10 || posRatio > 0.65) return false;

      return true;
    });

    // Sort prefiltered candidates by volume * range activity
    prefiltered.sort((a, b) => {
      const volA = Number(a.quoteVolume);
      const volB = Number(b.quoteVolume);
      const rangeA = (Number(a.highPrice) - Number(a.lowPrice)) / Number(a.lowPrice);
      const rangeB = (Number(b.highPrice) - Number(b.lowPrice)) / Number(b.lowPrice);
      return volB * rangeB - volA * rangeA;
    });

    // Select top 5 candidates
    const candidateSymbols = prefiltered.slice(0, 5).map((t) => t.symbol);

    // Always include currentSymbol in evaluation to compare fair performance
    if (!candidateSymbols.includes(normCurrent) && normCurrent.endsWith(targetQuote)) {
      candidateSymbols.push(normCurrent);
    }

    if (candidateSymbols.length === 0) {
      const reason = `No candidates met Stage 1 criteria for ${targetQuote}`;
      this.log(reason);
      return { rotated: false, report: [], reason };
    }

    this.log(`Stage 1 selected ${candidateSymbols.length} pairs: ${candidateSymbols.join(", ")}`);

    // 3. Stage 2: In-depth 5m/15m Simulation & Dow Structure Scoring
    const report: RotationCandidateScore[] = [];

    for (const sym of candidateSymbols) {
      try {
        const tickerItem = tickers.find((t) => t.symbol === sym);
        const quoteVol = tickerItem ? Number(tickerItem.quoteVolume) : 1_000_000;
        const change24h = tickerItem ? Number(tickerItem.priceChangePercent) : 0;
        const high24h = tickerItem ? Number(tickerItem.highPrice) : 0;
        const low24h = tickerItem ? Number(tickerItem.lowPrice) : 0;
        const last24h = tickerItem ? Number(tickerItem.lastPrice) : 0;
        const range24h = low24h > 0 ? ((high24h - low24h) / low24h) * 100 : 0;
        const posInRange = high24h > low24h ? (last24h - low24h) / (high24h - low24h) : 0.5;

        // Fetch 1,000 candles of 5m (~3.5 days) and 350 candles of 15m
        const [candles5m, candles15m] = await Promise.all([
          BacktestService.fetchBinanceCandles(sym, "5m", 1000),
          BacktestService.fetchBinanceCandles(sym, "15m", 350).catch(() => []),
        ]);

        if (!candles5m || candles5m.length < 200) {
          continue;
        }

        const symCostModel = sym.endsWith("FDUSD")
          ? { feePctPerSide: 0, slippagePctPerFill: 0.01 }
          : { feePctPerSide: 0.075, slippagePctPerFill: 0.01 };

        // Run dynamic grid backtest
        const rec = BacktestService.runMaFanSimulation(candles5m, {
          symbol: sym,
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
          candlesHtf: candles15m.length > 0 ? candles15m : undefined,
          saveToHistory: false,
          cushionMode: "off",
          waterfallGuardMode: "off",
          costModel: symCostModel,
          macroGateMode: "off",
          enableUpsideFloor: true,
          enableCircuitBreaker: true,
          enableFastCut: true,
          fastCutThresholdPct: -0.80,
          stagnationBars: 6,
          maxSlPct: 1.80,
          tradeMode: "dynamic_grid",
          tradeDirection: "long",
          capitalZones: cfg.capitalZones ?? 2,
          channelMode: cfg.channelMode ?? "DONCHIAN_ATR",
          donchianPeriod: cfg.donchianLookback ?? 48,
          minChannelWidthPct: cfg.minChannelWidthPct ?? 6.0,
          maxChannelWidthPct: cfg.maxChannelWidthPct ?? 25.0,
          zoneMinDropPct: cfg.zoneMinDropPct ?? 2.5,
          zoneStabilizeCandles: cfg.zoneStabilizeCandles ?? 3,
        });

        const summary = rec.summary;
        let simScore = 0;

        if (summary.netPnlPct > 0 && summary.maxDrawdownPct <= 22 && summary.totalTrades >= 2) {
          // PnL & trade frequency component (up to 25 pts)
          const pnlComponent = Math.min(25, summary.netPnlPct * 3.5 + summary.totalTrades * 1.5);
          // Win rate & low drawdown component (up to 20 pts)
          const wrComponent = Math.min(20, Math.max(0, (summary.winRate - 50) * 0.4) + Math.max(0, 16 - summary.maxDrawdownPct));
          simScore = Math.min(45, Math.max(0, pnlComponent + wrComponent));
        }

        // Structure score (up to 30 pts)
        let structureScore = 0;
        const recentCandles = candles5m.slice(-48);
        const donchianHigh = Math.max(...recentCandles.map((c) => c.high));
        const donchianLow = Math.min(...recentCandles.map((c) => c.low));
        const channelWidthPct = donchianLow > 0 ? ((donchianHigh - donchianLow) / donchianLow) * 100 : 0;

        if (channelWidthPct >= 5.5 && channelWidthPct <= 16.0) {
          structureScore += 20;
        } else if (channelWidthPct >= 16.0 && channelWidthPct <= 22.0) {
          structureScore += 10;
        }

        if (change24h >= -4.0) {
          structureScore += 10;
        }

        // Position in channel score (up to 15 pts)
        let positionScore = 0;
        if (posInRange >= 0.15 && posInRange <= 0.45) {
          positionScore = 15; // Prime bottom accumulation zone
        } else if (posInRange > 0.45 && posInRange <= 0.60) {
          positionScore = 8;  // Mid channel
        }

        // Liquidity score (up to 10 pts)
        const liquidityScore = Math.min(10, Math.max(0, (Math.log10(quoteVol) - 6) * 4));

        const compositeScore = Math.round(simScore + structureScore + positionScore + liquidityScore);

        report.push({
          symbol: sym,
          compositeScore,
          simScore: Math.round(simScore),
          structureScore: Math.round(structureScore),
          positionScore: Math.round(positionScore),
          liquidityScore: Math.round(liquidityScore),
          netPnlPct: summary.netPnlPct,
          winRate: summary.winRate,
          tradesCount: summary.totalTrades,
          maxDrawdownPct: summary.maxDrawdownPct,
          quoteVolume24h: Math.round(quoteVol),
          change24hPct: change24h,
          range24hPct: range24h,
          posInRange,
          channelWidthPct,
          reason: `Sim: +${summary.netPnlPct.toFixed(1)}% (${summary.totalTrades}T, WR ${summary.winRate.toFixed(0)}%, DD ${summary.maxDrawdownPct.toFixed(1)}%) | Width: ${channelWidthPct.toFixed(1)}% | Pos: ${(posInRange * 100).toFixed(0)}%`,
        });
      } catch (e: any) {
        this.log(`Error simulating candidate ${sym}: ${e.message}`);
      }
      await new Promise((r) => setImmediate(r));
    }

    // Sort report descending by composite score
    report.sort((a, b) => b.compositeScore - a.compositeScore);
    this.latestCandidates = report;
    this.lastScanTime = Date.now();
    this.saveState();

    if (report.length === 0) {
      return { rotated: false, report: [], reason: "No candidate scores evaluated" };
    }

    const bestCandidate = report[0]!;
    const currentScoreItem = report.find((r) => r.symbol === normCurrent);
    const currentScore = currentScoreItem ? currentScoreItem.compositeScore : 0;

    this.log(
      `Evaluation complete: Best = ${bestCandidate.symbol} (Score ${bestCandidate.compositeScore}/100) vs Current ${normCurrent} (Score ${currentScore}/100)`
    );

    // 4. Decision Gate
    if (forceRotate && bestCandidate.symbol !== normCurrent) {
      this.lastRotationTime = Date.now();
      this.recordHistory(normCurrent, bestCandidate.symbol, currentScore, bestCandidate.compositeScore, trigger, report);
      return {
        rotated: true,
        targetSymbol: bestCandidate.symbol,
        report,
        reason: `Force rotation triggered -> Selected ${bestCandidate.symbol} (Score ${bestCandidate.compositeScore})`,
      };
    }

    if (bestCandidate.symbol !== normCurrent) {
      const marginPct = cfg.rotationScoreMarginPct || 20;
      const minWinningScore = Math.max(60, currentScore * (1 + marginPct / 100));

      if (bestCandidate.compositeScore >= minWinningScore) {
        this.lastRotationTime = Date.now();
        this.recordHistory(normCurrent, bestCandidate.symbol, currentScore, bestCandidate.compositeScore, trigger, report);
        const reason = `Auto-rotated from ${normCurrent} to ${bestCandidate.symbol}: Score ${bestCandidate.compositeScore} exceeds threshold ${minWinningScore.toFixed(0)} (+${marginPct}% margin over current ${currentScore})`;
        this.log(`🚀 [ROTATION TRIGGERED] ${reason}`);
        return {
          rotated: true,
          targetSymbol: bestCandidate.symbol,
          report,
          reason,
        };
      } else {
        const reason = `Best candidate ${bestCandidate.symbol} (Score ${bestCandidate.compositeScore}) did not beat threshold ${minWinningScore.toFixed(0)} (+${marginPct}% over current ${currentScore})`;
        this.log(reason);
        return { rotated: false, report, reason };
      }
    }

    return {
      rotated: false,
      report,
      reason: `Current symbol ${normCurrent} is already the highest scoring candidate (${currentScore}/100). Remaining on ${normCurrent}.`,
    };
    } finally {
      this.isScanning = false;
    }
  }

  private recordHistory(
    fromSymbol: string,
    toSymbol: string,
    fromScore: number,
    toScore: number,
    triggerReason: "POST_ROUND_EXIT" | "IDLE_CASH_TIMEOUT" | "MANUAL_FORCE",
    topCandidates: RotationCandidateScore[]
  ): void {
    const record: RotationHistoryRecord = {
      timestamp: Date.now(),
      fromSymbol,
      toSymbol,
      fromScore,
      toScore,
      triggerReason,
      topCandidates: topCandidates.slice(0, 5),
    };
    this.history.unshift(record);
    if (this.history.length > 50) this.history = this.history.slice(0, 50);
    this.saveState();
  }
}
