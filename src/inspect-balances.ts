import { BinanceClient } from "./binance-client.js";
import { config } from "./config.js";

async function main() {
  const binance = new BinanceClient({
    apiKey: config.binanceApiKey,
    apiSecret: config.binanceApiSecret,
    baseUrl: config.binanceBaseUrl,
  });

  const symbol = (process.argv[2] || config.symbol || "BTCUSDT").toUpperCase().replace(/[\/\-_:]/g, "");

  if (!binance.hasCredentials()) {
    console.log(JSON.stringify({
      error: "BINANCE_API_KEY and BINANCE_API_SECRET must be configured in Database (Web UI / DB) or .env to inspect private account balances",
      mode: "public_only",
    }, null, 2));
    return;
  }

  await binance.syncTime();
  const balances = await binance.getAccountBalances(symbol);
  const openOrders = await binance.getOpenOrders(symbol);

  console.log(JSON.stringify({
    symbol,
    baseAsset: balances.baseAsset,
    quoteAsset: balances.quoteAsset,
    balances: {
      base: {
        free: balances.baseFree,
        locked: balances.baseLocked,
        total: balances.baseTotal,
      },
      quote: {
        free: balances.quoteFree,
        locked: balances.quoteLocked,
        total: balances.quoteTotal,
      },
    },
    openOrdersCount: openOrders.length,
    openOrders: openOrders.map((o) => ({
      orderId: o.orderId,
      side: o.side,
      price: o.price,
      origQty: o.origQty,
      executedQty: o.executedQty,
      status: o.status,
      type: o.type,
    })),
  }, null, 2));
}

main().catch(console.error);
