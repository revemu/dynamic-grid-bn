/**
 * Shared utility functions for Binance trading and quantification.
 */

/**
 * Shifts a price by a given basis points (bps).
 * e.g. shiftBps(100, 50) => 100 * (1 + 0.005) = 100.5
 */
export function shiftBps(price: number, bps: number): number {
  return price * (1 + bps / 10_000);
}

/**
 * Calculates bid-ask spread in basis points (bps).
 */
export function spreadBps(bestBid: number, bestAsk: number): number {
  if (bestBid <= 0 || bestAsk <= 0) return 0;
  const mid = (bestBid + bestAsk) / 2;
  return Math.round(((bestAsk - bestBid) / mid) * 10_000);
}

/**
 * Throttled status logger that suppresses repeat messages matching the same pattern
 * unless intervalMs has passed. Replaces dynamic numbers and prices with placeholder tokens
 * so that fluctuating floats/percentages do not bypass throttling.
 */
export function createStatusLogger(
  log: (msg: string) => void,
  intervalMs = 60_000,
): (msg: string, customIntervalMs?: number) => void {
  const lastLogTimes = new Map<string, number>();

  return (msg: string, customIntervalMs?: number) => {
    const now = Date.now();
    // Normalize numeric values (prices, percentages, counters, floats) into placeholder tokens
    // so that dynamic values do not bypass throttling.
    const patternKey = msg
      .replace(/[-+]?\$?\d+(?:\.\d+)?%?/g, "#")
      .trim();

    const effectiveInterval = customIntervalMs ?? intervalMs;
    const lastTime = lastLogTimes.get(patternKey) ?? 0;

    if (now - lastTime >= effectiveInterval) {
      log(msg);
      lastLogTimes.set(patternKey, now);

      // Periodic pruning to prevent unbounded map growth
      if (lastLogTimes.size > 100) {
        for (const [k, t] of lastLogTimes) {
          if (now - t >= effectiveInterval * 3) {
            lastLogTimes.delete(k);
          }
        }
      }
    }
  };
}

export const ORDER_TYPE = {
  PostOnly: "LIMIT_MAKER",
  ImmediateOrCancel: "IOC",
  Limit: "LIMIT",
  Market: "MARKET",
} as const;
