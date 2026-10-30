import assert from "assert";
import { MaFanCoreRules } from "../strategy/ma-fan/core-rules.js";
import { Candle, RibbonState } from "../strategy/ma-fan/types.js";
import { ExhaustionState } from "../strategy/ma-fan/exhaustion.js";

console.log("--- Starting Verification: Waterfall Guard Rules ---");

// Build candles mock: 20 bars
const candles: Candle[] = [];
for (let i = 0; i < 20; i++) {
  candles.push({
    time: 1000 + i * 300,
    open: 100,
    high: 101,
    low: 99,
    close: 99.5, // red
    volume: 1000,
    isClosed: true,
  });
}

// 1. Test computeWaterfallMetrics
{
  const metrics = MaFanCoreRules.computeWaterfallMetrics({
    candles,
    currentIndex: 19,
    closePrice: 99.5,
    isHtfBull: false,
  });

  assert.ok(metrics.consecutiveReds >= 4, `consecutiveReds should be >= 4, got ${metrics.consecutiveReds}`);
  console.log(`✓ Test 1 Passed: computeWaterfallMetrics detected ${metrics.consecutiveReds} consecutive red bars`);
}

// 2. Test evaluateEntry with waterfallGuardMode
{
  // Make bar 18 bottom out at 94, and bar 19 a hook bar with 15%+ lower wick (low = 94 >= bar 18 low)
  candles[18] = {
    time: 1000 + 18 * 300,
    open: 97,
    high: 97,
    low: 94,
    close: 95,
    volume: 1000,
    isClosed: true,
  };

  candles[19] = {
    time: 1000 + 19 * 300,
    open: 95,
    high: 97,
    low: 94,
    close: 96,
    volume: 1000,
    isClosed: true,
  };

  const mockRibbon: RibbonState = {
    ema4: 95.5,
    ema8: 97.0,
    ema16: 99.0,
    ema25: 101.0,
    ema75: 105.0,
    ema200: 110.0,
    fanSpreadPct: 5.5,
    isFanningDown: true,
    isFanningUp: false,
    isHookUp: true,
    isHookDown: false,
  };

  const mockExhaustion: ExhaustionState = {
    rsi: 30,
    prevRsi: 28,
    macd: { macd: -1, signal: -0.9, hist: -0.1, isTurningUp: true, isTurningDown: false },
    isOversoldExhaustion: true,
    isOverboughtExhaustion: false,
  };

  // Case A: Mode "off" or undefined -> should enter
  const resOff = MaFanCoreRules.evaluateEntry({
    candles,
    currentIndex: 19,
    closePrice: 96,
    ribbon: mockRibbon,
    exhaustion: mockExhaustion,
    requiredSpreadPct: 0.25,
    curAtr: 1.0,
    slBufferPct: 0.25,
    waterfallGuardMode: "off",
  });
  assert.strictEqual(resOff.shouldEnter, true, "resOff should enter when mode is off");

  // Case B: Mode "consecutiveReds" -> should block because bars 0..18 were all red
  const resBlockReds = MaFanCoreRules.evaluateEntry({
    candles,
    currentIndex: 19,
    closePrice: 96,
    ribbon: mockRibbon,
    exhaustion: mockExhaustion,
    requiredSpreadPct: 0.25,
    curAtr: 1.0,
    slBufferPct: 0.25,
    waterfallGuardMode: "consecutiveReds",
  });
  assert.strictEqual(resBlockReds.shouldEnter, false, "resBlockReds should be blocked");
  assert.strictEqual(resBlockReds.blockedBy, "WATERFALL_GUARD");
  console.log(`✓ Test 2 Passed: waterfallGuardMode='consecutiveReds' blocked entry with reason: ${resBlockReds.reason}`);

  // Case C: Mode "combined" -> should block
  const resBlockCombined = MaFanCoreRules.evaluateEntry({
    candles,
    currentIndex: 19,
    closePrice: 96,
    ribbon: mockRibbon,
    exhaustion: mockExhaustion,
    requiredSpreadPct: 0.25,
    curAtr: 1.0,
    slBufferPct: 0.25,
    waterfallGuardMode: "combined",
    isHtfBull: false,
  });
  assert.strictEqual(resBlockCombined.shouldEnter, false);
  assert.strictEqual(resBlockCombined.blockedBy, "WATERFALL_GUARD");
  console.log(`✓ Test 3 Passed: waterfallGuardMode='combined' blocked entry`);

  // Case D: Reset preceding bars to alternating green/red (normal pullback) -> should enter even with combined mode
  for (let i = 0; i < 19; i++) {
    candles[i] = {
      time: 1000 + i * 300,
      open: 96.0,
      high: 96.5,
      low: 94.0,
      close: 96.2, // green
      volume: 1000,
      isClosed: true,
    };
  }
  const resNormal = MaFanCoreRules.evaluateEntry({
    candles,
    currentIndex: 19,
    closePrice: 96,
    ribbon: mockRibbon,
    exhaustion: mockExhaustion,
    requiredSpreadPct: 0.25,
    curAtr: 1.0,
    slBufferPct: 0.25,
    waterfallGuardMode: "combined",
    isHtfBull: true,
  });
  assert.strictEqual(resNormal.shouldEnter, true, "Normal pullback should NOT be blocked by combined waterfall guard");
  console.log(`✓ Test 4 Passed: Normal gentle pullback allowed through without being blocked`);
}

console.log("🎉 ALL TESTS PASSED FOR WATERFALL GUARD ENGINE!");
