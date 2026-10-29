import assert from "assert";
import { MaFanCoreRules } from "../strategy/ma-fan/core-rules.js";
import { RibbonState } from "../strategy/ma-fan/types.js";

const mockRibbon: RibbonState = {
  ema4: 100,
  ema8: 100,
  ema16: 100,
  ema25: 100.25, // +0.25% above 100.0 (less than 0.35%)
  ema75: 99,
  ema200: 98,
  fanSpreadPct: 1.0,
  isFanningDown: false,
  isFanningUp: false,
  isHookUp: false,
  isHookDown: false,
};

const entryPrice = 100.0;
const stopLossPrice = 98.5; // Initial SL 1.5% below entry
const beFeeBufferPct = 0.05; // 0.05%
const expectedBePrice = entryPrice * (1 + beFeeBufferPct / 100); // 100.05

console.log("--- Starting Acceptance Gate P0 Verification ---");

// Case 1: mode = "off" -> Breakeven always
{
  const res = MaFanCoreRules.evaluateExits({
    highPrice: 101.0,
    lowPrice: 99.5,
    closePrice: 100.3,
    entryPrice,
    stopLossPrice,
    tp1Filled: false,
    highestPriceSinceTp1: 100.0,
    ribbon: mockRibbon,
    trailingPullbackPct: 0.45,
    breakevenFeeBufferPct: beFeeBufferPct,
    barsHeld: 1,
    isHtfBull: true,
    cushionMode: "off",
  });

  assert.strictEqual(res.action, "TP1", "Case 1 should trigger TP1");
  assert.strictEqual(res.cushionApplied, false, "Case 1 cushionApplied should be false");
  assert.ok(
    Math.abs((res.newStopLossPrice ?? 0) - expectedBePrice) < 1e-6,
    `Case 1 SL should be raised to Breakeven (${expectedBePrice}), got ${res.newStopLossPrice}`
  );
  console.log("✓ Case 1 Passed: mode=off strictly raises SL to Breakeven");
}

// Case 2: mode = "htfBull", isHtfBull = true, TP1 profit < 0.35% -> Breathing Cushion active
{
  const res = MaFanCoreRules.evaluateExits({
    highPrice: 101.0,
    lowPrice: 99.5,
    closePrice: 100.3,
    entryPrice,
    stopLossPrice,
    tp1Filled: false,
    highestPriceSinceTp1: 100.0,
    ribbon: mockRibbon,
    trailingPullbackPct: 0.45,
    breakevenFeeBufferPct: beFeeBufferPct,
    barsHeld: 1,
    isHtfBull: true,
    cushionMode: "htfBull",
  });

  assert.strictEqual(res.action, "TP1", "Case 2 should trigger TP1");
  assert.strictEqual(res.cushionApplied, true, "Case 2 cushionApplied should be true");
  assert.strictEqual(
    res.newStopLossPrice,
    stopLossPrice,
    `Case 2 SL should preserve original base (${stopLossPrice}), got ${res.newStopLossPrice}`
  );
  console.log("✓ Case 2 Passed: mode=htfBull with isHtfBull=true preserves cushion");
}

// Case 3: mode = "htfBull", isHtfBull = false, TP1 profit < 0.35% -> Breakeven
{
  const res = MaFanCoreRules.evaluateExits({
    highPrice: 101.0,
    lowPrice: 99.5,
    closePrice: 100.3,
    entryPrice,
    stopLossPrice,
    tp1Filled: false,
    highestPriceSinceTp1: 100.0,
    ribbon: mockRibbon,
    trailingPullbackPct: 0.45,
    breakevenFeeBufferPct: beFeeBufferPct,
    barsHeld: 1,
    isHtfBull: false,
    cushionMode: "htfBull",
  });

  assert.strictEqual(res.action, "TP1", "Case 3 should trigger TP1");
  assert.strictEqual(res.cushionApplied, false, "Case 3 cushionApplied should be false");
  assert.ok(
    Math.abs((res.newStopLossPrice ?? 0) - expectedBePrice) < 1e-6,
    `Case 3 SL should be Breakeven (${expectedBePrice}), got ${res.newStopLossPrice}`
  );
  console.log("✓ Case 3 Passed: mode=htfBull with isHtfBull=false raises SL to Breakeven");
}

// Case 4: mode = "always", TP1 profit >= 0.35% -> Breakeven
{
  const mockRibbonWideTp1: RibbonState = {
    ...mockRibbon,
    ema25: 100.5, // +0.50% profit (>= 0.35%)
  };

  const res = MaFanCoreRules.evaluateExits({
    highPrice: 101.0,
    lowPrice: 99.5,
    closePrice: 100.5,
    entryPrice,
    stopLossPrice,
    tp1Filled: false,
    highestPriceSinceTp1: 100.0,
    ribbon: mockRibbonWideTp1,
    trailingPullbackPct: 0.45,
    breakevenFeeBufferPct: beFeeBufferPct,
    barsHeld: 1,
    isHtfBull: true,
    cushionMode: "always",
  });

  assert.strictEqual(res.action, "TP1", "Case 4 should trigger TP1");
  assert.strictEqual(res.cushionApplied, false, "Case 4 cushionApplied should be false when profit >= threshold");
  assert.ok(
    Math.abs((res.newStopLossPrice ?? 0) - expectedBePrice) < 1e-6,
    `Case 4 SL should be Breakeven (${expectedBePrice}), got ${res.newStopLossPrice}`
  );
  console.log("✓ Case 4 Passed: mode=always with profit >= 0.35% raises SL to Breakeven");
}

console.log("🎉 ALL 4 CASES PASSED ACCEPTANCE GATE P0!");
