import { BinanceClient } from "./exchange/binance/client.js";
import { config } from "./config.js";

async function main() {
  const binance = new BinanceClient({
    apiKey: config.binanceApiKey,
    apiSecret: config.binanceApiSecret,
    baseUrl: config.binanceBaseUrl,
  });

  const symbol = (process.argv[2] || config.symbol || "BTCUSDT").toUpperCase().replace(/[\/\-_:]/g, "");
  console.log(`\n📊 Market History Inspector: ${symbol}`);
  console.log(`🌐 Endpoint: ${binance.getBaseUrl()}\n`);

  if (!binance.hasCredentials()) {
    console.error("❌ BINANCE_API_KEY and BINANCE_API_SECRET must be configured in .env");
    process.exit(1);
  }

  await binance.syncTime();

  // 1. Check Open Orders
  const openOrders = await binance.getOpenOrders(symbol);
  console.log(`📋 Active Open Orders (${openOrders.length}):`);
  for (const o of openOrders) {
    const remaining = o.origQty - o.executedQty;
    console.log(
      `   • Order #${o.orderId}: ${o.side} ${remaining} / ${o.origQty} @ $${o.price} [${o.type} ${o.timeInForce}]`,
    );
  }

  // 2. Check Recent Trades
  const trades = await binance.getMyTrades(symbol, 20);
  console.log(`\n📜 Recent Trade Fills (${trades.length}):`);
  for (const t of trades) {
    const side = t.isBuyer ? "BUY " : "SELL";
    const date = new Date(t.time).toLocaleString();
    console.log(
      `   • [${date}] ${side} ${t.qty} @ $${t.price} ($${t.quoteQty.toFixed(2)}) Fee: ${t.commission} ${t.commissionAsset}`,
    );
  }

  // 3. Check Account Balances
  const balances = await binance.getAccountBalances(symbol);
  console.log(`\n💳 Spot Account Balances:`);
  console.log(`   • ${balances.baseAsset}: ${balances.baseFree} (Free) / ${balances.baseLocked} (Locked)`);
  console.log(`   • ${balances.quoteAsset}: ${balances.quoteFree} (Free) / ${balances.quoteLocked} (Locked)\n`);
}

main().catch((err) => {
  console.error("❌ Error:", (err as Error).message);
  process.exit(1);
});
