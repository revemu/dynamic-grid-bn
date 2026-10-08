/**
 * Exchange Factory and Module Registry
 * Provides a unified entry point to initialize any supported exchange client.
 */

import { BinanceClient, type BinanceClientOptions } from "../binance-client.js";
import type { IExchangeClient } from "./types.js";

export * from "./types.js";

export type SupportedExchange = "binance" | "bybit" | "okx";

export interface ExchangeFactoryOptions extends BinanceClientOptions {
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
    default:
      throw new Error(`Unsupported exchange: "${exchange}". Currently supported: binance`);
  }
}
