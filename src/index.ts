/**
 * Runnable entry point for the Dynamic Grid Bot on Binance Spot
 * Dow Theory market structure and real-time visual web dashboard.
 */

import { config } from "./config.js";
import { BinanceClient } from "./binance-client.js";
import { DynamicGrid } from "./strategy.js";
import { VolatilityEngine } from "./volatility.js";
import { BinanceAtrFeed } from "./binance-feed.js";
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
  const binance = new BinanceClient({
    apiKey: config.binanceApiKey,
    apiSecret: config.binanceApiSecret,
    baseUrl: config.binanceBaseUrl,
    log: (msg) => log(`[binance] ${msg}`),
  });

  await binance.syncTime();

  let activeSymbol = (config.symbol || "BTCUSDT").toUpperCase().replace(/[\/\-_:]/g, "");
  let symbolInfo = await binance.getExchangeInfo(activeSymbol);

  log(
    `📊 Binance Spot Market: ${symbolInfo.symbol} (${symbolInfo.baseAsset}/${symbolInfo.quoteAsset}) ` +
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

  const initFeeds = async (sym: string) => {
    const symLower = sym.toLowerCase();
    await macroDowEngine.loadHigherTimeframeCandles(
      symLower,
      config.dowTimeframe,
      config.binanceBaseUrl,
      log,
      config.initialCandleCount ?? 300,
    );
    await localTrendEngine.loadHigherTimeframeCandles(
      symLower,
      config.tradingTimeframe,
      config.binanceBaseUrl,
      log,
      config.initialCandleCount ?? 300,
    );

    macroFeed?.stop();
    tradingFeed?.stop();

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

    atrSource = tradingFeed;
  };

  await initFeeds(symbolInfo.symbol);

  // Fetch initial balances
  let initialBaseBal = 0;
  let initialQuoteBal = 0;
  if (binance.hasCredentials()) {
    try {
      const b = await binance.getAccountBalances(symbolInfo.symbol);
      initialBaseBal = b.baseFree;
      initialQuoteBal = b.quoteFree;
    } catch (err) {
      log(`warning: failed to query initial Binance balance: ${(err as Error).message}`);
    }
  } else {
    log(`ℹ️ Running without Binance API credentials (public market data / dryRun mode).`);
  }

  log(
    `Binance Spot balance=[${initialBaseBal} ${symbolInfo.baseAsset} | ${initialQuoteBal.toFixed(2)} ${symbolInfo.quoteAsset}] ` +
      `symbol=${symbolInfo.symbol} maxInv=$${config.maxInventoryUsdso} dryRun=${config.dryRun} ` +
      `trendFilter=${config.dowTrendFilter} (${config.trendTimeframe})`,
  );

  const grid = new DynamicGrid(binance, symbolInfo, config, atrSource!, log, macroDowEngine, localTrendEngine);
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

      // Handle trading pair change dynamically
      if (s.symbol && s.symbol.toUpperCase().replace(/[\/\-_:]/g, "") !== prevSymbol) {
        const nextSymbolStr = s.symbol.toUpperCase().replace(/[\/\-_:]/g, "");
        try {
          const nextInfo = await binance.getExchangeInfo(nextSymbolStr);
          symbolInfo = nextInfo;
          grid.updateSymbolInfo(nextInfo);
          await initFeeds(nextInfo.symbol);
          dashboard.setInitialCandles(macroDowEngine.getCandles());
          macroFeed?.onCandle((candle, isClosed) => {
            macroDowEngine.addCandle(candle);
            dashboard.addCandle(candle, isClosed);
          });
          macroFeed?.start();
          tradingFeed?.start();
          log(`🔄 Switched active Binance trading pair to: ${nextInfo.symbol}`);
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
          await macroDowEngine.loadHigherTimeframeCandles(
            symbolInfo.symbol.toLowerCase(),
            tf,
            config.binanceBaseUrl,
            log,
            fetchLimit,
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
  process.exit(0);
}

main().catch((err) => {
  console.error("[dynamic-grid] fatal:", err);
  process.exit(1);
});
