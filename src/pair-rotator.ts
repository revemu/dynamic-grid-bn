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
  trendScore?: number;
  dnaScore?: number;
  dnaGrade?: "S" | "A" | "B" | "AVOID";
  bounce52Rate?: number;
  dipWickPct?: number;
  er48?: number;
  upDownSymmetry?: number;
  netPnlPct: number;
  winRate: number;
  tradesCount: number;
  maxDrawdownPct: number;
  quoteVolume24h: number;
  change24hPct: number;
  range24hPct: number;
  posInRange: number;
  channelWidthPct?: number;
  trendRegime?: "BULL_UPTREND" | "ACCUMULATION_RANGE" | "BEAR_DOWNTREND";
  trendLabel?: string;
  rsVsBtc24h?: number;
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
  "USDC", "FDUSD", "USDT", "TUSD", "BUSD", "USDP", "DAI", "EUR", "EURI", "AEUR", "BFUSD", "USDE"
]);

export const isSyntheticOrStock = (sym: string): boolean => {
  if (sym.endsWith("BUSDT") && sym.length > 6) return true; // Tokenized equity derivatives (MSTRBUSDT, SOXLBUSDT, etc.)
  if (
    sym.includes("USD") &&
    ["RWUSDUSDT", "UUSDT", "USDCUSDT", "FDUSDUSDT", "TUSDUSDT", "EURUSDT", "GBPUSDT", "USDPUSDT", "BFUSDUSDT", "USDEUSDT"].includes(sym)
  ) return true;
  if (["XAUTUSDT", "PAXGUSDT", "BEAMXUSDT"].includes(sym)) return true;
  if (/[\u4e00-\u9fa5]/.test(sym)) return true; // Chinese or non-ascii characters
  return false;
};

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

    // 🛡️ Market Breadth Gate (Live): Check % of tickers with positive 24h momentum
    const quoteTickers = tickers.filter((t) => t.symbol.endsWith(targetQuote) && !isSyntheticOrStock(t.symbol));
    const positiveTickers = quoteTickers.filter((t) => Number(t.priceChangePercent) >= 0);
    const liveBreadthPct = quoteTickers.length > 0 ? (positiveTickers.length / quoteTickers.length) * 100 : 50;
    if (quoteTickers.length >= 10 && liveBreadthPct < 35) {
      const reason = `🛡️ Market Breadth Gate active: Only ${liveBreadthPct.toFixed(1)}% of ${targetQuote} market is positive (< 35%). Bear regime sit-out to 100% Cash.`;
      this.log(reason);
      return { rotated: false, report: this.latestCandidates, reason };
    }

    // 🛡️ BTC Macro Gate Check (Live):
    if (cfg.rotationEnableBtcMacroGate !== false) {
      const btcTicker = tickers.find((t) => t.symbol === "BTCUSDT" || t.symbol === `BTC${targetQuote}`);
      if (btcTicker) {
        const btcChange = Number(btcTicker.priceChangePercent);
        const btcHigh = Number(btcTicker.highPrice);
        const btcLow = Number(btcTicker.lowPrice);
        const btcLast = Number(btcTicker.lastPrice);
        const btcPos = btcHigh > btcLow ? (btcLast - btcLow) / (btcHigh - btcLow) : 0.5;

        // If BTC is dumping (> 1.2% down in 24h) or pinned near 24h lows with negative momentum, protect capital in cash!
        if (btcChange < -1.2 || (btcChange < -0.5 && btcPos < 0.20)) {
          const reason = `🛡️ BTC Macro Gate active: Bitcoin is in severe breakdown (${btcChange.toFixed(2)}%, pos=${(btcPos * 100).toFixed(0)}%). Rotation paused to hold 100% Cash.`;
          this.log(reason);
          return { rotated: false, report: this.latestCandidates, reason };
        }
      }
    }

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
      if (isSyntheticOrStock(sym)) return false;

      const vol = Number(t.quoteVolume);
      if (vol < minVolume) return false;

      const high = Number(t.highPrice);
      const low = Number(t.lowPrice);
      const change = Number(t.priceChangePercent);
      if (low <= 0 || high <= low) return false;

      const rangePct = ((high - low) / low) * 100;
      // Sweet spot range: 4% to 22%
      if (rangePct < 4.0 || rangePct > 22.0) return false;
      // Smart Bear Market Gate: Filter out coins in 24h downtrend (< +0.5%) or vertical overbought pumps (> 15%)
      if (change < 0.5 || change > 15.0) return false;

      const last = Number(t.lastPrice);
      const posRatio = (last - low) / (high - low);
      // Favorable entry: price between 10% and 88% of 24h range (embrace reversal leaders)
      if (posRatio < 0.10 || posRatio > 0.88) return false;

      return true;
    });

    // Sort prefiltered candidates by logarithmic volume + reversal activity score
    prefiltered.sort((a, b) => {
      const volA = Math.log10(Math.max(1000, Number(a.quoteVolume)));
      const volB = Math.log10(Math.max(1000, Number(b.quoteVolume)));
      const rangeA = (Number(a.highPrice) - Number(a.lowPrice)) / Number(a.lowPrice);
      const rangeB = (Number(b.highPrice) - Number(b.lowPrice)) / Number(b.lowPrice);
      const chgA = Number(a.priceChangePercent);
      const chgB = Number(b.priceChangePercent);
      const scoreA = volA * 3 + Math.min(0.25, rangeA) * 50 + (chgA >= 0 && chgA <= 6.0 ? 10 : 0);
      const scoreB = volB * 3 + Math.min(0.25, rangeB) * 50 + (chgB >= 0 && chgB <= 6.0 ? 10 : 0);
      return scoreB - scoreA;
    });

    // Select top 10 candidates
    const candidateSymbols = prefiltered.slice(0, 10).map((t) => t.symbol);

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

    // 3. Stage 2: In-depth 15m/5m Dual-Window Rolling DNA & Forward Trend Scoring
    const report: RotationCandidateScore[] = [];

    // Find BTC 24h change for relative strength comparison
    const btcTicker = tickers.find((t) => t.symbol === "BTCUSDT");
    const btcChange24h = btcTicker ? Number(btcTicker.priceChangePercent) : 0;

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
        const rsVsBtc24h = change24h - btcChange24h;

        // Fetch up to 1,000 candles of 15m (~10.4 days) and 1,000 candles of 5m
        const [candles15m, candles5m] = await Promise.all([
          BacktestService.fetchBinanceCandles(sym, "15m", 1000).catch(() => []),
          BacktestService.fetchBinanceCandles(sym, "5m", 1000).catch(() => []),
        ]);

        const evalCandles = (candles15m && candles15m.length >= 60) ? candles15m : candles5m;
        if (!evalCandles || evalCandles.length < 60) {
          continue;
        }

        // 🛡️ Smart Momentum Check: Reject coins with negative 4-hour return
        if (evalCandles.length >= 16) {
          const lastC = evalCandles[evalCandles.length - 1].close;
          const open4h = evalCandles[Math.max(0, evalCandles.length - 16)].open;
          const ret4h = open4h > 0 ? ((lastC - open4h) / open4h) * 100 : 0;
          if (ret4h < -1.5) continue;
        }

        const symCostModel = sym.endsWith("FDUSD")
          ? { feePctPerSide: 0, slippagePctPerFill: 0.01 }
          : { feePctPerSide: 0.075, slippagePctPerFill: 0.01 };

        // 🧬 1. Dual-Window Rolling Market DNA & Live Trend Alignment Evaluation
        const dna = BacktestService.evaluateGridDna(evalCandles, "CRYPTO");

        // 2. Production Dynamic Grid Simulation with MASTER_PLAN_GRID_CONFIG (Core v14.0)
        const simRes = BacktestService.runDynamicGridSimulation(evalCandles, {
          symbol: sym,
          initialCapital: 200,
          channelMode: "DONCHIAN_ATR",
          donchianPeriod: 48,
          minChannelWidthPct: 2.0,
          maxChannelWidthPct: 25.0,
          lockChannelInPosition: true,
          regimeFilterMode: "UPTREND_AND_SIDEWAY",
          buyLevelPcts: [20, 12],
          buyWeights: [55, 45],
          sellLevelPcts: [52, 72],
          capitalZones: 1,
          zoneMinDropPct: 2.5,
          floorBufferPct: 0.6,
          gridCutLossMode: "entry_floor",
          enableGridTrailingStop: true,
          costModel: symCostModel,
          saveToHistory: false,
        });

        const summary = simRes.summary;

        // ── 3-Layer Composite Scoring (Total 100) ──
        // Layer 1: Market DNA Points (up to 40 pts, weighted by 60% recent form + 40% baseline)
        const dnaPoints = Math.round(dna.dnaScore * 0.40);

        // Layer 2: Forward Trend & Relative Strength (up to 35 pts)
        let trendScore = 0;
        if (dna.trendRegime === "BULL_UPTREND") {
          trendScore = 20;
        } else if (dna.trendRegime === "ACCUMULATION_RANGE") {
          trendScore = 12;
        } else {
          trendScore = 0; // Bear downtrend
        }
        // Relative Strength bonus
        if (rsVsBtc24h >= 0.5 && change24h <= 12.0) {
          trendScore += 7;
        } else if (rsVsBtc24h >= -1.0) {
          trendScore += 3;
        }
        // Simulation profit bonus in trend layer
        if (summary.netPnlPct > 0 && summary.winRate >= 70) {
          trendScore += 8;
        } else if (summary.netPnlPct > 0) {
          trendScore += 4;
        }
        trendScore = Math.min(35, trendScore);

        // Layer 3: Tactical Pullback Entry Position (up to 20 pts) + Liquidity (up to 5 pts)
        // Position in Range & Channel: sweet spot is 10% - 38%
        let positionScore = 0;
        if (posInRange >= 0.10 && posInRange <= 0.38) {
          positionScore = 20; // Prime bottom pullback zone
        } else if (posInRange > 0.38 && posInRange <= 0.55) {
          positionScore = 12; // Lower-mid zone
        } else if (posInRange < 0.10) {
          positionScore = 6;  // Touching bottom
        } else {
          positionScore = 2;  // High in range
        }

        // Liquidity Score (up to 5 pts)
        const liquidityScore = Math.min(5, Math.max(0, (Math.log10(quoteVol) - 6) * 2));

        // Penalty for AVOID / Downtrend flow
        let penalty = 0;
        if (dna.grade === "AVOID" || dna.trendRegime === "BEAR_DOWNTREND") penalty = -40;
        else if (dna.grade === "B") penalty = -10;

        const compositeScore = Math.max(0, Math.min(100, Math.round(dnaPoints + trendScore + positionScore + liquidityScore + penalty)));

        report.push({
          symbol: sym,
          compositeScore,
          simScore: Math.round(summary.netPnlPct * 2),
          structureScore: Math.round(dna.dnaScore * 0.2),
          positionScore: Math.round(positionScore),
          liquidityScore: Math.round(liquidityScore),
          trendScore,
          dnaScore: dna.dnaScore,
          dnaGrade: dna.grade,
          bounce52Rate: dna.bounce52Rate,
          dipWickPct: dna.avgDipWickPct,
          er48: dna.avgEr48,
          upDownSymmetry: dna.upDownSymmetry,
          netPnlPct: summary.netPnlPct,
          winRate: summary.winRate,
          tradesCount: summary.totalTrades,
          maxDrawdownPct: summary.maxDrawdownPct,
          quoteVolume24h: Math.round(quoteVol),
          change24hPct: change24h,
          range24hPct: range24h,
          posInRange,
          channelWidthPct: dna.avgSpan48Pct,
          trendRegime: dna.trendRegime,
          trendLabel: dna.trendLabel,
          rsVsBtc24h,
          reason: `DNA: [${dna.grade}] ${dna.dnaScore} (Rec=${dna.recentDnaScore ?? '--'}, Base=${dna.baselineDnaScore ?? '--'}) | Trend: ${dna.trendLabel ?? '--'} (RS=${rsVsBtc24h >= 0 ? '+' : ''}${rsVsBtc24h.toFixed(1)}%) | Pos: ${(posInRange * 100).toFixed(0)}% | Sim: ${summary.netPnlPct >= 0 ? '+' : ''}${summary.netPnlPct.toFixed(1)}% (${summary.totalTrades}T, WR ${summary.winRate.toFixed(0)}%)`,
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

    // 🛡️ DNA Strict Gate: Only allow rotation into Grade S or Grade A candidates
    const gradeCandidates = report.filter((r) => r.dnaGrade === "S" || r.dnaGrade === "A");
    if (gradeCandidates.length === 0) {
      const reason = `🛡️ DNA Strict Gate active: No candidate achieved Grade S or A DNA. Market unfavorable for Dynamic Grid. Holding 100% Cash.`;
      this.log(reason);
      return { rotated: false, report, reason };
    }

    // 🛡️ Minimum Market Depth Rule: If fewer than 2 pairs score >= 50, market lacks breadth -> sit out in Cash!
    const viableScored = gradeCandidates.filter((r) => r.compositeScore >= 50);
    if (viableScored.length < 1) {
      const reason = `🛡️ Minimum Market Depth Gate active: No Grade S/A pair scored >= 50. Holding 100% Cash.`;
      this.log(reason);
      return { rotated: false, report, reason };
    }

    const bestCandidate = gradeCandidates[0]!;
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
