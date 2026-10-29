import assert from "assert";
import { MaFanCoreRules } from "../strategy/ma-fan/core-rules.js";
import { Candle, RibbonState } from "../strategy/ma-fan/types.js";
import { ExhaustionState } from "../strategy/ma-fan/exhaustion.js";

console.log("--- Starting Acceptance Gate R0: Reward:Risk Verification ---");

// Case 1: HAEDAL exact numbers
{
  const res = MaFanCoreRules.computeRewardRisk({
    entryPrice: 0.02601,
    ema25: 0.026858537,
    stopLossPrice: 0.025385217,
  });

  assert.ok(Math.abs(res.riskPct - 2.402) < 0.01, `riskPct should be ~2.402, got ${res.riskPct}`);
  assert.ok(Math.abs(res.rewardPct - 3.262) < 0.01, `rewardPct should be ~3.262, got ${res.rewardPct}`);
  assert.ok(Math.abs(res.rr - 1.358) < 0.01, `rr should be ~1.358, got ${res.rr}`);
  console.log(`✓ Case 1 Passed: HAEDAL motivating trade RR = ${res.rr.toFixed(3)} (risk: ${res.riskPct.toFixed(3)}%, reward: ${res.rewardPct.toFixed(3)}%)`);
}

// Case 2: stopLossPrice >= entryPrice -> rr = 99
{
  const res = MaFanCoreRules.computeRewardRisk({
    entryPrice: 100,
    ema25: 105,
    stopLossPrice: 100,
  });
  assert.strictEqual(res.rr, 99, `rr should be 99 when stopLossPrice >= entryPrice, got ${res.rr}`);

  const res2 = MaFanCoreRules.computeRewardRisk({
    entryPrice: 100,
    ema25: 105,
    stopLossPrice: 101,
  });
  assert.strictEqual(res2.rr, 99, `rr should be 99 when stopLossPrice > entryPrice, got ${res2.rr}`);
  console.log("✓ Case 2 Passed: non-positive risk capped safely at rr = 99");
}

// Case 3 & 4: evaluateEntry with mock candles
{
  const candles: Candle[] = [];
  for (let i = 0; i < 15; i++) {
    candles.push({
      time: 1000 + i * 300,
      open: 10,
      high: 10.5,
      low: 9.0,
      close: 9.8,
      volume: 1000,
      isClosed: true,
    });
  }
  candles[14] = {
    time: 1000 + 14 * 300,
    open: 9.8,
    high: 10.0,
    low: 9.2,
    close: 9.9,
    volume: 1000,
    isClosed: true,
  };

  const mockRibbon: RibbonState = {
    ema4: 9.7,
    ema8: 10.0,
    ema16: 10.3,
    ema25: 10.5,
    ema75: 11.0,
    ema200: 12.0,
    fanSpreadPct: 7.6,
    isFanningDown: true,
    isFanningUp: false,
    isHookUp: true,
    isHookDown: false,
  };

  const mockExhaustion: ExhaustionState = {
    rsi: 30,
    prevRsi: 28,
    macd: {
      macd: -0.5,
      signal: -0.4,
      hist: -0.1,
      isTurningUp: true,
      isTurningDown: false,
    },
    isOversoldExhaustion: true,
    isOverboughtExhaustion: false,
  };

  // Case 3: evaluateEntry without minRewardRiskRatio and with 0 -> identical shouldEnter: true
  const resNoGate = MaFanCoreRules.evaluateEntry({
    candles,
    closePrice: 9.9,
    ribbon: mockRibbon,
    exhaustion: mockExhaustion,
    requiredSpreadPct: 0.25,
    curAtr: 0.1,
    slBufferPct: 0.25,
  });

  const resGateZero = MaFanCoreRules.evaluateEntry({
    candles,
    closePrice: 9.9,
    ribbon: mockRibbon,
    exhaustion: mockExhaustion,
    requiredSpreadPct: 0.25,
    curAtr: 0.1,
    slBufferPct: 0.25,
    minRewardRiskRatio: 0,
  });

  assert.strictEqual(resNoGate.shouldEnter, true, "resNoGate shouldEnter should be true");
  assert.strictEqual(resGateZero.shouldEnter, true, "resGateZero shouldEnter should be true");
  assert.strictEqual(resNoGate.entryPrice, resGateZero.entryPrice);
  assert.strictEqual(resNoGate.stopLossPrice, resGateZero.stopLossPrice);
  assert.strictEqual(resNoGate.rewardRisk, resGateZero.rewardRisk);
  console.log(`✓ Case 3 Passed: evaluateEntry without gate and with 0 are identical (rr = ${resNoGate.rewardRisk?.toFixed(2)})`);

  // Case 4: minRewardRiskRatio lower than rr -> enter; higher than rr -> blockedBy: "REWARD_RISK"
  const rr = resNoGate.rewardRisk!;
  const resPass = MaFanCoreRules.evaluateEntry({
    candles,
    closePrice: 9.9,
    ribbon: mockRibbon,
    exhaustion: mockExhaustion,
    requiredSpreadPct: 0.25,
    curAtr: 0.1,
    slBufferPct: 0.25,
    minRewardRiskRatio: rr - 0.1,
  });
  assert.strictEqual(resPass.shouldEnter, true, "resPass shouldEnter should be true when rr >= minRewardRiskRatio");

  const resBlock = MaFanCoreRules.evaluateEntry({
    candles,
    closePrice: 9.9,
    ribbon: mockRibbon,
    exhaustion: mockExhaustion,
    requiredSpreadPct: 0.25,
    curAtr: 0.1,
    slBufferPct: 0.25,
    minRewardRiskRatio: rr + 0.5,
  });
  assert.strictEqual(resBlock.shouldEnter, false, "resBlock shouldEnter should be false when rr < minRewardRiskRatio");
  assert.strictEqual(resBlock.blockedBy, "REWARD_RISK", "resBlock blockedBy should be 'REWARD_RISK'");
  console.log(`✓ Case 4 Passed: minRewardRiskRatio selectively blocks trades with blockedBy = 'REWARD_RISK'`);
}

console.log("🎉 ALL 4 CASES PASSED ACCEPTANCE GATE R0!");
