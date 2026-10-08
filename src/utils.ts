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
 * Throttled status logger that suppresses identical repeat messages unless intervalMs has passed.
 */
export function createStatusLogger(
  log: (msg: string) => void,
  intervalMs = 60_000,
): (msg: string) => void {
  let lastLogTime = 0;
  let lastMessage = "";

  return (msg: string) => {
    const now = Date.now();
    if (msg !== lastMessage || now - lastLogTime >= intervalMs) {
      log(msg);
      lastLogTime = now;
      lastMessage = msg;
    }
  };
}

export const ORDER_TYPE = {
  PostOnly: "LIMIT_MAKER",
  ImmediateOrCancel: "IOC",
  Limit: "LIMIT",
  Market: "MARKET",
} as const;
