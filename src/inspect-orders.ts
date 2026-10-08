import { BinanceClient } from "./exchange/binance/client.js";
import { config } from "./config.js";

async function main(): Promise<void> {
  const binance = new BinanceClient({
    apiKey: config.binanceApiKey,
    apiSecret: config.binanceApiSecret,
    baseUrl: config.binanceBaseUrl,
  });

  const symbol = (process.argv[2] || config.symbol || "BTCUSDT").toUpperCase().replace(/[\/\-_:]/g, "");

  console.log(`\n============================================================`);
  console.log(`🔍 Binance Spot Order & Trade Inspector`);
  console.log(`============================================================`);
  console.log(`Market  : ${symbol}`);
  console.log(`Endpoint: ${binance.getBaseUrl()}\n`);

  if (!binance.hasCredentials()) {
    console.error("❌ BINANCE_API_KEY and BINANCE_API_SECRET must be configured in .env to inspect private orders.");
    process.exit(1);
  }

  await binance.syncTime();

  // 1. Fetch Open Orders
  const openOrders = await binance.getOpenOrders(symbol);
  console.log(`📋 ACTIVE RESTING ORDERS (${openOrders.length}):`);
  if (openOrders.length === 0) {
    console.log("   (No active resting orders on book)\n");
  } else {
    for (const o of openOrders) {
      const side = o.side === "BUY" ? "🟢 BUY " : "🔴 SELL";
      const remaining = o.origQty - o.executedQty;
      const notional = (o.price * remaining).toFixed(2);
      const placed = o.time ? new Date(o.time).toLocaleString() : "—";
      console.log(
        `   • #${String(o.orderId).padEnd(16)} | ${side} | $${o.price} | Rem: ${remaining} / ${o.origQty} ($${notional}) | ${placed}`,
      );
    }
    console.log();
  }

  // 2. Fetch Recent Trades
  try {
    const trades = await binance.getMyTrades(symbol, 15);
    console.log(`📜 RECENT TRADE HISTORY (Last ${trades.length}):`);
    if (trades.length === 0) {
      console.log("   (No trade history found for this market)\n");
    } else {
      for (const t of trades) {
        const side = t.isBuyer ? "🟢 BOUGHT" : "🔴 SOLD  ";
        const timeStr = t.time ? new Date(t.time).toLocaleTimeString() : "—";
        console.log(
          `   ✅ ${side} | #${String(t.orderId).padEnd(16)} | Qty: ${t.qty} @ $${t.price} ($${t.quoteQty.toFixed(2)}) | Fee: ${t.commission} ${t.commissionAsset} | ${timeStr}`,
        );
      }
      console.log();
    }
  } catch (err) {
    console.log(`⚠️ Note: could not query recent trades: ${(err as Error).message}\n`);
  }

  console.log(`============================================================\n`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
