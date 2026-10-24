/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import type { IStrategy, StrategyType, StrategyContext } from "./types.js";
import { DynamicGrid } from "./index.js";
import { SwingTraderStrategy } from "./swing/index.js";

/**
 * Strategy Factory: Instantiates and initializes the configured strategy.
 * Enables seamless switching between Dynamic Grid, Swing Trade, and future strategies.
 */
export function createStrategy(
  type: StrategyType = "dynamic_grid",
  context: StrategyContext,
): IStrategy {
  switch (type) {
    case "swing_trade":
      return new SwingTraderStrategy(context);
    case "dynamic_grid":
    default:
      return new DynamicGrid(
        context.exchange,
        context.symbolInfo,
        context.config,
        context.atrSource,
        context.log,
        context.macroDowEngine,
        context.localTrendEngine,
        context.htfDowEngine,
      );
  }
}
