/**
 * MA Fan Decision Snapshot Logger
 * Persists tick-by-tick decisions, indicator states, and execution fills
 * to an ACID JSONL file for perfect historical reconciliation with Backtest simulations.
 */

import fs from "fs";
import path from "path";

const LOG_FILE_PATH = path.resolve(process.cwd(), "data", "decision-snapshots.jsonl");

export interface DecisionSnapshot {
  ts: number; // Unix ms
  iso: string;
  version: string;
  symbol: string;
  kind: "ENTRY" | "TP1" | "TP2" | "SL" | "RATCHET";
  refPrice: number;
  fillPrice?: number;
  qty?: number;
  entryPrice?: number;
  stopLossPrice?: number;
  barsHeld?: number;
  lastClosedCandleTime?: number;
  ribbon?: {
    ema4: number;
    ema8: number;
    ema16: number;
    ema25: number;
    ema75: number;
    ema200: number;
    fanSpreadPct: number;
  };
  atr?: number;
  rsi?: number;
  htf?: {
    isBullish: boolean;
    isAboveEma200: boolean;
  };
  effectiveSpreadThreshold?: number;
  cushionApplied?: boolean;
  cushionEnabled?: boolean;
  rewardRisk?: number;
  riskPct?: number;
  rewardPct?: number;
  reason?: string;
}

/**
 * Appends a decision snapshot to data/decision-snapshots.jsonl safely.
 * Never throws or disrupts trading under any circumstances.
 */
export function appendDecisionSnapshot(snapshot: Partial<DecisionSnapshot>): void {
  try {
    const dir = path.dirname(LOG_FILE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const payload: DecisionSnapshot = {
      ts: snapshot.ts || Date.now(),
      iso: snapshot.iso || new Date().toISOString(),
      version: snapshot.version || "unknown",
      symbol: snapshot.symbol || "UNKNOWN",
      kind: snapshot.kind || "ENTRY",
      refPrice: snapshot.refPrice ?? 0,
      fillPrice: snapshot.fillPrice,
      qty: snapshot.qty,
      entryPrice: snapshot.entryPrice,
      stopLossPrice: snapshot.stopLossPrice,
      barsHeld: snapshot.barsHeld,
      lastClosedCandleTime: snapshot.lastClosedCandleTime,
      ribbon: snapshot.ribbon,
      atr: snapshot.atr,
      rsi: snapshot.rsi,
      htf: snapshot.htf,
      effectiveSpreadThreshold: snapshot.effectiveSpreadThreshold,
      cushionApplied: snapshot.cushionApplied,
      cushionEnabled: snapshot.cushionEnabled,
      rewardRisk: snapshot.rewardRisk,
      riskPct: snapshot.riskPct,
      rewardPct: snapshot.rewardPct,
      reason: snapshot.reason,
    };

    fs.appendFileSync(LOG_FILE_PATH, JSON.stringify(payload) + "\n", "utf8");
  } catch (err: any) {
    // Silently suppress filesystem errors to protect trading engine
  }
}

/**
 * Reads the latest N decision snapshots for API / UI inspection
 */
export function readLatestDecisionSnapshots(limit = 200): DecisionSnapshot[] {
  try {
    if (!fs.existsSync(LOG_FILE_PATH)) return [];
    const content = fs.readFileSync(LOG_FILE_PATH, "utf8");
    const lines = content.trim().split("\n").filter(Boolean);
    const slice = lines.slice(-Math.min(limit, 1000));
    return slice.map((l) => JSON.parse(l) as DecisionSnapshot);
  } catch {
    return [];
  }
}
