/**
 * Market structure module entrypoint.
 * Modularized into `src/market-structure/*` for clean separation of concerns:
 * - types.ts: Type definitions and interfaces
 * - candle-manager.ts: Candle history, effective wick calculations, HTF loader
 * - swing-detector.ts: Swing pivots, candidate points, unbroken swing invariant checks
 * - dow-engine.ts: Dow Theory swing classification, wave cycles, higher-low checks, bear drop detection
 * - trendline-engine.ts: Outer envelope trendlines, touch scoring, breakout confirmation
 * - channel-engine.ts: Tier 1 Wave Box, Tier 2 Staircase, Tier 3 Fallback, Donchian ATR, GridZone levels
 * - index.ts: DowStructureEngine facade orchestrator
 */

export * from "./market-structure/index.js";
