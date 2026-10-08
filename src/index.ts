/**
 * Runnable entry point for the Dynamic Grid Bot on Binance Spot
 * Dow Theory market structure and real-time visual web dashboard.
 */

import { config } from "./config.js";
import { createExchangeClient, type IExchangeClient } from "./exchange/index.js";
import { DynamicGrid } from "./strategy.js";
import { VolatilityEngine } from "./volatility.js";
import { BinanceAtrFeed, BinanceBookTickerFeed, BinanceUserDataFeed } from "./binance-feed.js";
import { DowStructureEngine } from "./market-structure.js";
import { DashboardServer } from "./server.js";
import type { AtrSource } from "./types.js";

function formatTimestamp(d = new Date()): string {
  try {
    const tz = config.timezone || process.env.TZ || "Asia/Bangkok";
    const formatter = new Intl.DateTimeFormat("sv-SE", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const ms = String(d.getMilliseconds()).padStart(3, "0");
    return `${formatter.format(d)}.${ms}`;
  } catch {
    const pad = (n: number) => String(n).padStart(2, "0");
    const padMs = (n: number) => String(n).padStart(3, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${padMs(d.getMilliseconds())}`;
  }
}

function log(msg: string, extra?: unknown): void {
  const line = `[dynamic-grid ${formatTimestamp()}] ${msg}`;
  if (extra !== undefined) console.log(line, extra);
  else console.log(line);
}

async function main(): Promise<void> {
  let exchange = createExchangeClient({
    exchange: config.exchange || "binance",
    apiKey: config.binanceApiKey,
    apiSecret: config.binanceApiSecret,
    baseUrl: config.binanceBaseUrl,
    privateKey: config.dreamdexPrivateKey,
    rpcUrl: config.dreamdexRpcUrl,
    log: (msg) => log(`[${config.exchange || "binance"}] ${msg}`),
  });

  await exchange.syncTime();

  let activeSymbol = (config.symbol || "BTCUSDT").toUpperCase().replace(/[\/\-_:]/g, "");
  let symbolInfo = await exchange.getExchangeInfo(activeSymbol);

  log(
    `📊 Spot Market (${exchange.exchangeName.toUpperCase()}): ${symbolInfo.symbol} (${symbolInfo.baseAsset}/${symbolInfo.quoteAsset}) ` +
      `| minQty: ${symbolInfo.minQty} | stepSize: ${symbolInfo.stepSize} | tickSize: ${symbolInfo.tickSize} | minNotional: $${symbolInfo.minNotional}`,
  );

  // ── Dow Theory & Market Structure Engines ────────────────────────────────
  // 1. Macro Engine (15m/1h): establishes the solid 0% Floor, 50% Center, 100% Ceiling
  const macroDowEngine = new DowStructureEngine(
    config.dowSwingLookback,
    config.useTrueWick,
    config.wickThresholdPct,
    config.maxCandleCount ?? 600,
  );
  // 2. Local Trend Engine (15m): detects localized downtrends to pause buys during drops
  const localTrendEngine = new DowStructureEngine(
    config.dowSwingLookback,
    config.useTrueWick,
    config.wickThresholdPct,
    config.maxCandleCount ?? 600,
  );

  // Preload macro candles and trading candles on boot
  let macroFeed: BinanceAtrFeed | undefined;
  let tradingFeed: BinanceAtrFeed | undefined;
  let atrSource: AtrSource;

  let bookTickerFeed: BinanceBookTickerFeed | undefined;
  let userDataFeed: BinanceUserDataFeed | undefined;

  // Map trading symbol (which may be on DreamDEX like SOMI, SOMI:USDSO, WBTC, WETH)
  // to a liquid Binance Spot Symbol for 100% reliable candlestick data & ATR calculations!
  const resolveBinanceCandleSymbol = (sym: string): string => {
    const s = sym.toUpperCase().replace(/[\/\-_:]/g, "");
    if (s.startsWith("SOMI")) return "SOMIUSDT";
    if (s.startsWith("USDC") || s === "USDSO") return "USDCUSDT";
    if (s.startsWith("WBTC") || s === "BTC") return "BTCUSDT";
    if (s.startsWith("WETH") || s === "ETH") return "ETHUSDT";
    // If symbol does not end with USDT, USDC, FDUSD, etc., default to appending USDT
    if (!s.endsWith("USDT") && !s.endsWith("USDC") && !s.endsWith("FDUSD")) {
      return `${s}USDT`;
    }
    return s;
  };

  const initFeeds = async (sym: string) => {
    const binanceCandleSymbol = resolveBinanceCandleSymbol(sym);
    const symLower = binanceCandleSymbol.toLowerCase();

    log(`📈 Initializing Binance market feeds for ${sym} -> using Binance symbol: ${binanceCandleSymbol}`);

    macroDowEngine.clearCandles();
    localTrendEngine.clearCandles();

    await macroDowEngine.loadHigherTimeframeCandles(
      binanceCandleSymbol,
      config.dowTimeframe,
      config.binanceBaseUrl,
      log,
      config.initialCandleCount ?? 300,
      true,
    );
    await localTrendEngine.loadHigherTimeframeCandles(
      binanceCandleSymbol,
      config.tradingTimeframe,
      config.binanceBaseUrl,
      log,
      config.initialCandleCount ?? 300,
      true,
    );

    macroFeed?.stop();
    tradingFeed?.stop();
    bookTickerFeed?.stop();
    userDataFeed?.stop();

    macroFeed = new BinanceAtrFeed(
      {
        symbol: symLower,
        interval: config.dowTimeframe,
        wsBase: config.binanceWsBase,
        staleMs: config.binanceStaleMs,
        initialCandleCount: config.initialCandleCount ?? 300,
      },
      config.atrLookback,
      (msg) => log(`[macro ${config.dowTimeframe}] ${msg}`),
    );

    tradingFeed = new BinanceAtrFeed(
      {
        symbol: symLower,
        interval: config.tradingTimeframe,
        wsBase: config.binanceWsBase,
        staleMs: config.binanceStaleMs,
        initialCandleCount: config.initialCandleCount ?? 300,
      },
      config.atrLookback,
      (msg) => log(`[trading ${config.tradingTimeframe}] ${msg}`),
    );

    tradingFeed.onCandle((candle, isClosed) => {
      if (isClosed) {
        localTrendEngine.addCandle(candle);
      }
    });

    // 0-weight Real-Time Book Ticker WebSocket feed
    bookTickerFeed = new BinanceBookTickerFeed(
      symLower,
      config.binanceWsBase,
      (msg) => log(`[bookTicker] ${msg}`),
    );

    // Real-Time User Data Stream WebSocket feed (if on Binance with API credentials)
    if (exchange.exchangeName === "binance" && exchange.hasCredentials() && exchange.createUserDataStream) {
      userDataFeed = new BinanceUserDataFeed(
        {
          createUserDataStream: () => exchange.createUserDataStream!(),
          keepAliveUserDataStream: (k) => exchange.keepAliveUserDataStream!(k),
          closeUserDataStream: (k) => exchange.closeUserDataStream!(k),
        },
        config.binanceWsBase,
        (msg) => log(`[userData] ${msg}`),
      );
    }

    atrSource = tradingFeed;
  };

  await initFeeds(symbolInfo.symbol);

  // Fetch initial balances
  let initialBaseBal = 0;
  let initialQuoteBal = 0;
  if (exchange.hasCredentials()) {
    try {
      const b = await exchange.getAccountBalances(symbolInfo.symbol);
      initialBaseBal = b.baseFree;
      initialQuoteBal = b.quoteFree;
    } catch (err) {
      log(`warning: failed to query initial ${exchange.exchangeName} balance: ${(err as Error).message}`);
    }
  } else {
    log(`ℹ️ Running without ${exchange.exchangeName} API credentials (public market data / dryRun mode).`);
  }

  log(
    `${exchange.exchangeName.toUpperCase()} Spot balance=[${initialBaseBal} ${symbolInfo.baseAsset} | ${initialQuoteBal.toFixed(2)} ${symbolInfo.quoteAsset}] ` +
      `symbol=${symbolInfo.symbol} maxInv=$${config.maxInventoryQuote} dryRun=${config.dryRun} ` +
      `trendFilter=${config.dowTrendFilter} (${config.trendTimeframe})`,
  );

  const grid = new DynamicGrid(exchange, symbolInfo, config, atrSource!, log, macroDowEngine, localTrendEngine);
  await grid.syncOnChainOrders();

  let wakeSleep: (() => void) | null = null;
  const interruptibleSleep = (ms: number): Promise<void> => {
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | null = setTimeout(() => {
        wakeSleep = null;
        resolve();
      }, ms);
      wakeSleep = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        wakeSleep = null;
        resolve();
      };
    });
  };

  const wireFeedsToGrid = () => {
    if (bookTickerFeed) {
      bookTickerFeed.onBook((b) => grid.handleWsBookTicker(b));
      bookTickerFeed.start();
    }
    if (userDataFeed) {
      userDataFeed.onExecutionReport((rep) => grid.handleWsExecutionReport(rep));
      userDataFeed.onAccountUpdate((acc) => grid.handleWsAccountUpdate(acc));
      userDataFeed.start().catch((err) => log(`⚠️ User data stream start error: ${(err as Error).message}`));
    }
  };

  // ── Real-Time Dashboard Server & Dynamic Config API ───────────────────────
  const dashboard = new DashboardServer({
    port: config.dashboardPort,
    log,
    db: grid.getDatabase(),
    maxCandles: config.maxCandleCount ?? 600,
    getSettings: () => grid.getRuntimeConfig(),
    onUpdateSettings: async (s) => {
      const prevConfig = grid.getRuntimeConfig();
      const prevInitial = prevConfig.initialCandleCount;
      const prevMax = prevConfig.maxCandleCount;
      const prevTf = prevConfig.dowTimeframe;
      const prevSymbol = prevConfig.symbol;

      const res = grid.updateRuntimeSettings(s);

      const targetExchangeName = (s.exchange || prevConfig.exchange || "binance").toLowerCase();
      const exchangeChanged = s.exchange && targetExchangeName !== (prevConfig.exchange || "binance").toLowerCase();
      const privateKeyChanged = s.dreamdexPrivateKey && s.dreamdexPrivateKey !== "******";

      const normPrevSymbol = (prevSymbol || "").toUpperCase().replace(/[\/\-_:]/g, "");
      const normNextSymbol = (s.symbol || "").toUpperCase().replace(/[\/\-_:]/g, "");
      const symbolChanged = Boolean(normNextSymbol && normNextSymbol !== normPrevSymbol);

      // 1. Handle Exchange Adapter switch or credentials update dynamically
      if (exchangeChanged || (targetExchangeName === "dreamdex" && privateKeyChanged)) {
        try {
          const realPrivateKey = (s.dreamdexPrivateKey !== undefined && s.dreamdexPrivateKey !== "******" && s.dreamdexPrivateKey.trim() !== "")
            ? s.dreamdexPrivateKey.trim()
            : grid.getRealDreamdexPrivateKey();

          const realApiSecret = (s.binanceApiSecret !== undefined && s.binanceApiSecret !== "******")
            ? s.binanceApiSecret
            : grid.getRealBinanceApiSecret();

          const newExchange = createExchangeClient({
            exchange: targetExchangeName,
            apiKey: s.binanceApiKey !== undefined ? s.binanceApiKey : prevConfig.binanceApiKey,
            apiSecret: realApiSecret,
            baseUrl: s.binanceBaseUrl || prevConfig.binanceBaseUrl,
            privateKey: (realPrivateKey && realPrivateKey !== "******") ? realPrivateKey : undefined,
            rpcUrl: s.dreamdexRpcUrl || prevConfig.dreamdexRpcUrl,
            log: (msg) => log(`[${targetExchangeName}] ${msg}`),
          });
          await newExchange.syncTime();
          exchange = newExchange;

          // If switching to dreamdex and symbol is still a Binance symbol like ETHFDUSD, suggest/switch to SOMI
          let targetSymbol = (s.symbol || prevConfig.symbol || "BTCUSDT").toUpperCase().replace(/[\/\-_:]/g, "");
          if (targetExchangeName === "dreamdex" && (targetSymbol.includes("FDUSD") || targetSymbol.includes("USDT") || targetSymbol === "BTCUSDT")) {
            targetSymbol = "SOMI";
          }

          const nextInfo = await exchange.getExchangeInfo(targetSymbol);
          symbolInfo = nextInfo;
          grid.updateExchangeClient(newExchange, nextInfo);
          await initFeeds(nextInfo.symbol);
          wireFeedsToGrid();
          dashboard.setInitialCandles(macroDowEngine.getCandles());
          macroFeed?.onCandle((candle, isClosed) => {
            macroDowEngine.addCandle(candle);
            dashboard.addCandle(candle, isClosed);
          });
          macroFeed?.start();
          tradingFeed?.start();
          log(`🔄 Successfully switched Exchange Adapter to: ${exchange.exchangeName.toUpperCase()} (${nextInfo.symbol})`);
        } catch (err) {
          log(`⚠️ Failed to switch exchange adapter to ${targetExchangeName}: ${(err as Error).message}`);
        }
      } else if (symbolChanged) {
        // 2. Handle trading pair change dynamically on same exchange
        const nextSymbolStr = normNextSymbol;
        try {
          const nextInfo = await exchange.getExchangeInfo(nextSymbolStr);
          symbolInfo = nextInfo;
          grid.updateSymbolInfo(nextInfo);
          await initFeeds(nextInfo.symbol);
          wireFeedsToGrid();
          dashboard.setInitialCandles(macroDowEngine.getCandles());
          macroFeed?.onCandle((candle, isClosed) => {
            macroDowEngine.addCandle(candle);
            dashboard.addCandle(candle, isClosed);
          });
          macroFeed?.start();
          tradingFeed?.start();
          log(`🔄 Switched active ${exchange.exchangeName} trading pair to: ${nextInfo.symbol}`);
        } catch (err) {
          log(`⚠️ Failed to switch symbol to ${nextSymbolStr}: ${(err as Error).message}`);
        }
      }

      if (s.maxCandleCount && s.maxCandleCount !== prevMax) {
        dashboard.setMaxCandles(s.maxCandleCount);
        macroDowEngine.setMaxCandles(s.maxCandleCount);
        localTrendEngine.setMaxCandles(s.maxCandleCount);
      }

      // If initialCandleCount changed or timeframe changed, re-fetch candles
      if (
        (s.initialCandleCount && s.initialCandleCount !== prevInitial) ||
        (s.dowTimeframe && s.dowTimeframe !== prevTf)
      ) {
        const fetchLimit = s.initialCandleCount ?? res.initialCandleCount ?? 300;
        const tf = s.dowTimeframe ?? res.dowTimeframe ?? config.dowTimeframe;
        try {
          const candleSym = resolveBinanceCandleSymbol(symbolInfo.symbol);
          await macroDowEngine.loadHigherTimeframeCandles(
            candleSym,
            tf,
            config.binanceBaseUrl,
            log,
            fetchLimit,
            true,
          );
          dashboard.setInitialCandles(macroDowEngine.getCandles());
          log(`🔄 Reloaded ${fetchLimit} candles (${tf}) following settings update`);
        } catch (err) {
          log(`⚠️ Failed to reload candles on settings update: ${(err as Error).message}`);
        }
      }

      grid.emitTelemetryTick();
      wakeSleep?.();
      return res;
    },
    onPauseBot: (paused) => grid.setPaused(paused),
    getIsPaused: () => grid.getIsPaused(),
    onCancelAll: () => grid.cancelAllOrdersUser(),
    onResetBot: (opts) => grid.resetBotState(opts),
    onResetPosition: () => grid.resetPosition(),
    onReloadState: () => {
      grid.reloadState();
      grid.emitTelemetryTick();
    },
  });

  dashboard.setInitialCandles(macroDowEngine.getCandles());
  dashboard.setInitialOrders(grid.getRecentOrders());
  dashboard.start();

  wireFeedsToGrid();

  if (macroFeed) {
    macroFeed.onCandle((candle, isClosed) => {
      macroDowEngine.addCandle(candle);
      dashboard.addCandle(candle, isClosed);
    });
    macroFeed.start();
  }
  tradingFeed?.start();

  // Forward strategy events (ticks, buy/sell/cut executions) to dashboard
  grid.onEvent((event) => {
    if (event.type === "tick") {
      dashboard.updateTick(event.data);
    } else if (event.type === "order") {
      dashboard.addOrder(event.data);
    }
  });

  let stop = false;
  process.on("SIGINT", () => {
    stop = true;
    wakeSleep?.();
    grid.saveState();
    log("stopping after current tick…");
  });
  process.on("SIGTERM", () => {
    stop = true;
    wakeSleep?.();
    grid.saveState();
  });

  while (!stop) {
    try {
      await grid.tick();
    } catch (err) {
      log("tick error", (err as Error).message);
    }
    const loopInterval = grid.getIntervalMs();
    await interruptibleSleep(loopInterval > 0 ? loopInterval : 1000);
  }

  dashboard.stop();
  macroFeed?.stop();
  tradingFeed?.stop();
  bookTickerFeed?.stop();
  userDataFeed?.stop();
  process.exit(0);
}

main().catch((err) => {
  console.error("[dynamic-grid] fatal:", err);
  process.exit(1);
});
