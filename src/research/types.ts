import { Candle } from "../strategy/ma-fan/types.js";

export interface UniverseCoin {
  symbol: string;
  quoteVolume: number;
  count: number;
  rank: number;
  isForceIncluded?: boolean;
}

export interface UniverseFile {
  selectedAt: string;
  topN: number;
  forceInclude: string[];
  coins: UniverseCoin[];
}

export interface CandleCacheMetadata {
  symbol: string;
  timeframe: string;
  filePath: string;
  sha256: string;
  candleCount: number;
  firstTime: number; // Unix seconds
  lastTime: number;  // Unix seconds
  expectedBars: number;
  coveragePct: number;
  isValid: boolean;
  invalidReason?: string;
}

export interface SnapshotManifest {
  fetchedAt: string;
  days: number;
  startIso: string;
  endIso: string;
  startSec: number;
  endSec: number;
  totalSymbols: number;
  passedSymbols: string[];
  rejectedSymbols: { symbol: string; reason: string }[];
  files: Record<string, CandleCacheMetadata>;
}

export interface SnapshotData {
  manifest: SnapshotManifest;
  universe: UniverseCoin[];
  candlesBySymbol: Map<string, { candles5m: Candle[]; candlesHtf15m: Candle[] }>;
}
