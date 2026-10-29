import fs from "fs";
import path from "path";

export interface EventMatchedRow {
  symbol: string;
  entryTimeUtc: string;
  segment: "unseen" | "seen";
  scenario: string;
  arm: string;
  exitType: string;
  exitPrice: number;
  pnlPctNet: number;
  cushionApplied: boolean;
  holdingBars: number;
  costQuote: number;
}

export interface FullPathRow {
  tradeId: number;
  symbol: string;
  entryTimeUtc: string;
  segment: "unseen" | "seen";
  scenario: string;
  arm: string;
  exitType: string;
  exitPrice: number;
  pnlPctNet: number;
  cushionApplied: boolean;
  holdingBars: number;
  costQuote: number;
}

export interface ScenarioSummaryRow {
  scenario: string;
  arm: string;
  tradesCount: number;
  winRatePct: number;
  netPnlPct: number;
  netPnlQuote: number;
  expectancyPct: number;
  profitFactor: number;
  medianMaxDrawdownPct: number;
  lossTradeRatioPct: number;
  top3ProfitSharePct: number;
  breakevenLossTradesCount: number;
}

export interface DeltaRow {
  scenario: string;
  firedCount: number;
  outcomeChangedCount: number;
  meanDeltaPct: number;
  ciLowerPct: number;
  ciUpperPct: number;
  signTestPos: number;
  signTestNeg: number;
  signTestPValue: number;
  unseenFiredCount: number;
  unseenMeanDeltaPct: number;
  seenFiredCount: number;
  seenMeanDeltaPct: number;
}

export function formatCsv(rows: Record<string, any>[]): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]!);
  const lines = [headers.join(",")];
  for (const r of rows) {
    const vals = headers.map((h) => {
      const v = r[h];
      if (typeof v === "string" && (v.includes(",") || v.includes("\"") || v.includes("\n"))) {
        return `"${v.replace(/"/g, '""')}"`;
      }
      return v !== undefined && v !== null ? String(v) : "";
    });
    lines.push(vals.join(","));
  }
  return lines.join("\n");
}

export function writeResearchReport(opts: {
  reportDir: string;
  events: EventMatchedRow[];
  fullPathTrades: FullPathRow[];
  scenarioSummaries: ScenarioSummaryRow[];
  deltas: DeltaRow[];
  markdownContent: string;
}): void {
  fs.mkdirSync(opts.reportDir, { recursive: true });

  fs.writeFileSync(path.join(opts.reportDir, "events_entry_matched.csv"), formatCsv(opts.events), "utf8");
  fs.writeFileSync(path.join(opts.reportDir, "trades_fullpath.csv"), formatCsv(opts.fullPathTrades), "utf8");
  fs.writeFileSync(path.join(opts.reportDir, "summary_by_scenario.csv"), formatCsv(opts.scenarioSummaries), "utf8");
  fs.writeFileSync(path.join(opts.reportDir, "delta_g1_vs_g0.csv"), formatCsv(opts.deltas), "utf8");
  fs.writeFileSync(path.join(opts.reportDir, "report.md"), opts.markdownContent, "utf8");

  console.log(`[Report] Successfully generated all 5 report artifacts in ${opts.reportDir}`);
}
