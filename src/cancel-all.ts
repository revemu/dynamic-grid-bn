import { BinanceClient } from "./binance-client.js";
import { config } from "./config.js";

async function main() {
  const binance = new BinanceClient({
    apiKey: config.binanceApiKey,
    apiSecret: config.binanceApiSecret,
    baseUrl: config.binanceBaseUrl,
  });

  const symbol = (process.argv[2] || config.symbol || "BTCUSDT").toUpperCase().replace(/[\/\-_:]/g, "");
  console.log(`\n🛑 Cancelling all open orders on Binance for market: ${symbol}...\n`);

  if (!binance.hasCredentials()) {
    console.error("❌ BINANCE_API_KEY and BINANCE_API_SECRET must be configured in Database (Web UI / DB) or .env");
    process.exit(1);
  }

  await binance.syncTime();
  const openOrders = await binance.getOpenOrders(symbol);
  console.log(`📋 Found ${openOrders.length} active open orders for ${symbol}.`);

  if (openOrders.length > 0) {
    try {
      await binance.cancelAllOpenOrders(symbol);
      console.log(`✅ Successfully cancelled all open orders for ${symbol}!`);
    } catch (err) {
      console.error(`⚠️ Failed to cancel all open orders:`, (err as Error).message);
    }
  } else {
    console.log(`✨ No open orders to cancel.`);
  }

  const balances = await binance.getAccountBalances(symbol);
  console.log(`\n💳 Current Balances:`);
  console.log(`   • ${balances.baseAsset}: ${balances.baseFree} (Free) / ${balances.baseLocked} (Locked)`);
  console.log(`   • ${balances.quoteAsset}: ${balances.quoteFree} (Free) / ${balances.quoteLocked} (Locked)\n`);
}

main().catch((err) => {
  console.error("❌ Error:", (err as Error).message);
  process.exit(1);
});
