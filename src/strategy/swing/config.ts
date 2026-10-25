/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

export interface SwingStrategyConfig {
  minRiskReward: number;
  stopLossBufferPct: number;
  maxPositionPct: number;
  tp1CloseRatio: number;
  tp1TargetType: "CENTER_POC" | "FIXED_PCT";
  tp2TargetType: "SWING_HIGH_HH" | "TRAILING_STOP";
  trailingActivationPct: number;
  trailingPullbackPct: number;
  enableHlBaseEntry: boolean;
  enableTrendlineBreakoutEntry: boolean;
  enableSupportRetestEntry: boolean;
  enableBearishReversalExit?: boolean;
  bearishReversalMinProfitPct?: number;
  bearishReversalResistanceTolerancePct?: number;
}
