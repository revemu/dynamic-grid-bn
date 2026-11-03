/**
 * Exchange Factory and Module Registry
 * Provides a unified entry point to initialize any supported exchange client.
 */

import { BinanceClient, type BinanceClientOptions } from "./binance/client.js";
import { DreamDexClient, type DreamDexClientOptions } from "./dreamdex/client.js";
import { AlpacaClient, type AlpacaClientOptions } from "./alpaca/client.js";
import type { IExchangeClient } from "./types.js";

export * from "./types.js";
export * from "./binance/index.js";
export * from "./dreamdex/index.js";
export * from "./alpaca/index.js";

export type SupportedExchange = "binance" | "dreamdex" | "alpaca" | "bybit" | "okx";

export interface ExchangeFactoryOptions extends BinanceClientOptions, DreamDexClientOptions, AlpacaClientOptions {
  exchange?: string;
}

/**
 * Creates an instance of the requested exchange client.
 * Defaults to "binance" if unspecified.
 */
export function createExchangeClient(opts: ExchangeFactoryOptions = {}): IExchangeClient {
  const exchange = (opts.exchange || process.env.EXCHANGE || "binance").toLowerCase();

  switch (exchange) {
    case "binance":
      return new BinanceClient(opts);
    case "dreamdex":
      return new DreamDexClient(opts);
    case "alpaca":
      return new AlpacaClient(opts);
    default:
      throw new Error(`Unsupported exchange: "${exchange}". Currently supported: binance, dreamdex, alpaca`);
  }
}
