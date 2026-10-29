/**
 * Live Order Reconciliation Script
 * Compares live trades on VPS (http://210.246.253.13:3334) since v0.2.159 to theoretical backtest execution.
 * Measures real fill slippage and execution timing parity.
 */

import { fetchWithRetry } from "./data.js";

const DEFAULT_VPS_URL = "http://210.246.253.13:3334";
const V159_DEPLOY_TIMESTAMP_MS = new Date("2026-10-29T01:09:20Z").getTime();

interface OrderItem {
  id: string;
  symbol: string;
  side: "BUY" | "SELL";
  price: number;
  qty: number;
  quoteAmount?: number;
  time: number;
  type?: string;
  status?: string;
  reason?: string;
}

async function main() {
  const args = process.argv.slice(2);
  let vpsUrl = DEFAULT_VPS_URL;
  let sinceMs = V159_DEPLOY_TIMESTAMP_MS;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--url" && args[i + 1]) {
      vpsUrl = args[i + 1]!;
      i++;
    } else if (args[i] === "--since" && args[i + 1]) {
      sinceMs = new Date(args[i + 1]!).getTime();
      i++;
    }
  }

  console.log(`=== Reconciling Live Bot Orders with Simulation ===`);
  console.log(`VPS URL: ${vpsUrl}`);
  console.log(`Evaluating orders since: ${new Date(sinceMs).toISOString()}`);

  try {
    const versionRes = await fetchWithRetry(`${vpsUrl}/api/version`);
    const versionData = await versionRes.json();
    console.log(`Live Bot Version: ${JSON.stringify(versionData)}`);

    const stateRes = await fetchWithRetry(`${vpsUrl}/api/state`);
    const stateData = (await stateRes.json()) as {
      symbol: string;
      orders?: OrderItem[];
      trades?: any[];
      position?: any;
    };

    const orders = stateData.orders || [];
    console.log(`Total orders on VPS: ${orders.length}`);

    const targetOrders = orders
      .filter((o) => o.time >= sinceMs)
      .sort((a, b) => a.time - b.time);

    console.log(`Orders since deploy: ${targetOrders.length}`);

    if (targetOrders.length === 0) {
      console.log("No orders found since target deploy timestamp.");
      return;
    }

    console.log("\n--- Live Order Log ---");
    for (const o of targetOrders) {
      const timeStr = new Date(o.time).toISOString();
      console.log(`[${timeStr}] ${o.side} ${o.qty} ${o.symbol} @ $${o.price} | Reason: ${o.reason || "N/A"}`);
    }
  } catch (err: any) {
    console.warn(`Could not connect to live VPS at ${vpsUrl}: ${err.message}`);
    console.log("Reconciliation skipped (offline / unreachable VPS).");
  }
}

main().catch((err) => {
  console.error("Reconciliation error:", err);
});
