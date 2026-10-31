/**
 * Lightweight embedded HTTP server & SSE real-time stream for the Dynamic Grid Dashboard.
 * Serves the web UI and pushes live candle, order, and grid-bound updates.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Candle } from "./market-structure.js";
import { BotDatabase, getDatabase } from "./db.js";
import { APP_VERSION_INFO } from "./version.js";
import { BacktestService } from "./backtest-service.js";
import { readLatestDecisionSnapshots } from "./strategy/ma-fan/decision-log.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, "../public");

export interface DashboardServerOptions {
  port: number;
  log: (msg: string) => void;
  db?: BotDatabase;
  getSettings?: () => Record<string, any>;
  onUpdateSettings?: (settings: Record<string, any>) => Record<string, any> | Promise<Record<string, any>>;
  onPauseBot?: (paused: boolean) => boolean;
  getIsPaused?: () => boolean;
  onCancelAll?: () => Promise<{ cancelledCount: number }>;
  onSellAll?: () => Promise<{ success: boolean; soldQty: number; price: number; error?: string }>;
  onResetBot?: (opts?: { resetPnl?: boolean; clearTrades?: boolean }) => Promise<{ success: boolean }>;
  onResetPosition?: () => Promise<{ success: boolean; clearedLots: number }>;
  onReloadState?: () => void;
  onSyncExchangeTrades?: () => Promise<{ success: boolean; synced: number; purged?: number; error?: string }>;
  maxCandles?: number;
}

export class DashboardServer {
  private server?: http.Server;
  private clients: Set<http.ServerResponse> = new Set();
  private candles: Candle[] = [];
  private htfCandles: Candle[] = [];
  private recentOrders: any[] = [];
  private latestTick: any = null;
  private db: BotDatabase;
  private maxCandles = 600;
  private binanceSymbolsCache: {
    time: number;
    symbols: string[];
    popular: string[];
    fdusd: string[];
    usdt: string[];
    usdc: string[];
  } | null = null;
  private currentScanProgress: any = null;

  constructor(private readonly opts: DashboardServerOptions) {
    this.db = opts.db || getDatabase();
    this.maxCandles = Math.max(50, opts.maxCandles ?? 600);
  }

  public setMaxCandles(count: number): void {
    const k = Math.max(50, Math.round(count));
    if (this.maxCandles !== k) {
      this.maxCandles = k;
      if (this.candles.length > this.maxCandles) {
        this.candles.splice(0, this.candles.length - this.maxCandles);
        this.broadcast("candles_batch", { candles: this.candles });
      }
    }
  }

  public getMaxCandles(): number {
    return this.maxCandles;
  }

  start(): void {
    if (this.opts.port <= 0) {
      this.opts.log("dashboard disabled (DASHBOARD_PORT=0)");
      return;
    }

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });

    this.server.listen(this.opts.port, () => {
      this.opts.log(`web dashboard live at http://localhost:${this.opts.port} (version: ${APP_VERSION_INFO.version}, commit: ${APP_VERSION_INFO.commit})`);
    });

    this.server.on("error", (err: any) => {
      this.opts.log(`dashboard server error: ${err.message}`);
    });
  }

  stop(): void {
    for (const client of this.clients) {
      client.end();
    }
    this.clients.clear();
    this.server?.close();
  }

  setInitialCandles(candles: Candle[]): void {
    const map = new Map<number, Candle>();
    for (const c of candles) {
      if (c && typeof c.time === "number" && Number.isFinite(c.close)) {
        map.set(c.time, c);
      }
    }
    this.candles = Array.from(map.values()).sort((a, b) => a.time - b.time);
    if (this.candles.length > this.maxCandles) {
      this.candles.splice(0, this.candles.length - this.maxCandles);
    }
    this.broadcast("candles_batch", { candles: this.candles });
  }

  setInitialHtfCandles(candles: Candle[]): void {
    const map = new Map<number, Candle>();
    for (const c of candles) {
      if (c && typeof c.time === "number" && Number.isFinite(c.close)) {
        map.set(c.time, c);
      }
    }
    this.htfCandles = Array.from(map.values()).sort((a, b) => a.time - b.time);
    if (this.htfCandles.length > 300) {
      this.htfCandles.splice(0, this.htfCandles.length - 300);
    }
    this.broadcast("htf_candles_batch", { candles: this.htfCandles });
  }

  addHtfCandle(candle: Candle, isClosed: boolean): void {
    if (!candle || typeof candle.time !== "number" || !Number.isFinite(candle.close)) return;

    const idx = this.htfCandles.findIndex((c) => c.time === candle.time);
    if (idx >= 0) {
      this.htfCandles[idx] = candle;
    } else {
      this.htfCandles.push(candle);
      this.htfCandles.sort((a, b) => a.time - b.time);
      if (this.htfCandles.length > 300) {
        this.htfCandles.splice(0, this.htfCandles.length - 300);
      }
    }
    this.broadcast("htf_candle", { candle, isClosed });
  }

  setInitialOrders(orders: any[]): void {
    if (Array.isArray(orders)) {
      this.recentOrders = [...orders];
    }
  }

  addCandle(candle: Candle, isClosed: boolean): void {
    if (!candle || typeof candle.time !== "number" || !Number.isFinite(candle.close)) return;

    const idx = this.candles.findIndex((c) => c.time === candle.time);
    if (idx >= 0) {
      this.candles[idx] = candle;
    } else {
      this.candles.push(candle);
      this.candles.sort((a, b) => a.time - b.time);
      if (this.candles.length > this.maxCandles) {
        this.candles.splice(0, this.candles.length - this.maxCandles);
      }
    }
    this.broadcast("candle", { candle, isClosed });
  }

  addOrder(order: any): void {
    const existing = this.recentOrders.find(
      (o) => (order.orderId && o.orderId === order.orderId) || (order.txHash && o.txHash === order.txHash),
    );
    if (existing) {
      Object.assign(existing, order);
    } else {
      this.recentOrders.unshift(order);
      if (this.recentOrders.length > 5000) this.recentOrders.pop();
    }
    this.broadcast("order", order);
  }

  updateOrderGas(txHash: string, gasFeeBase: number, gasFeeQuote: number): void {
    const match = this.recentOrders.find(
      (o) => o.createTxHash === txHash || o.cancelTxHash === txHash || o.txHash === txHash,
    );
    if (match) {
      match.gasFeeBase = (match.gasFeeBase || 0) + gasFeeBase;
      match.gasFeeQuote = (match.gasFeeQuote || 0) + gasFeeQuote;
      match.gasFeeSomi = (match.gasFeeSomi || 0) + gasFeeBase;
      match.gasFeeUsdso = (match.gasFeeUsdso || 0) + gasFeeQuote;
    }
    this.broadcast("order_gas", {
      txHash,
      gasFeeBase,
      gasFeeQuote,
      gasFeeSomi: gasFeeBase,
      gasFeeUsdso: gasFeeQuote,
    });
  }

  updateTick(tickData: any): void {
    if (tickData && typeof tickData === "object" && !tickData.versionInfo) {
      tickData.versionInfo = APP_VERSION_INFO;
    }
    this.latestTick = tickData;
    this.broadcast("tick", tickData);
  }

  resetState(opts?: { clearTrades?: boolean }): void {
    if (opts?.clearTrades) {
      this.recentOrders = [];
    }
    this.latestTick = null;
  }

  public broadcast(event: string, data: any): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients) {
      try {
        res.write(payload);
      } catch {
        this.clients.delete(res);
      }
    }
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const parsedUrl = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const pathname = parsedUrl.pathname;

    // CORS headers for convenience
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // SSE Stream
    if (pathname === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });
      res.write(`event: connected\ndata: {"status":"connected"}\n\n`);
      this.clients.add(res);

      req.on("close", () => {
        this.clients.delete(res);
      });
      return;
    }

    // Version info API
    if (pathname === "/api/version") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(APP_VERSION_INFO));
      return;
    }

    // Snapshot state
    if (pathname === "/api/state") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          versionInfo: APP_VERSION_INFO,
          candles: this.candles,
          htfCandles: this.htfCandles,
          orders: this.recentOrders.slice(0, 150),
          latestTick: this.latestTick,
        }),
      );
      return;
    }

    // Higher Timeframe Candles API
    if (pathname === "/api/candles/htf") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ candles: this.htfCandles }));
      return;
    }

    // Database: Trades History API
    if (pathname === "/api/db/trades") {
      const limit = parseInt(parsedUrl.searchParams.get("limit") || "5000", 10);
      const symbolParam = parsedUrl.searchParams.get("symbol") || undefined;
      const trades = this.db.getTrades(limit, symbolParam);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(trades));
      return;
    }

    // Database: Order Activity History API
    if (pathname === "/api/db/orders") {
      const limit = parseInt(parsedUrl.searchParams.get("limit") || "5000", 10);
      const symbolParam = parsedUrl.searchParams.get("symbol") || undefined;
      const orders = this.db.getOrderActivity(limit, symbolParam);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(orders));
      return;
    }

    // Database: Gas Logs & Cumulative Summary API
    if (pathname === "/api/db/gas") {
      const limit = parseInt(parsedUrl.searchParams.get("limit") || "5000", 10);
      const logs = this.db.getGasLogs(limit);
      const summary = this.db.getGasSummary();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ summary, logs }));
      return;
    }

    // Database: Trade Rounds Summary API (Buy Accumulation & Sell Distribution Cycles)
    if (pathname === "/api/db/rounds") {
      let symbolParam = parsedUrl.searchParams.get("symbol") || undefined;
      if (!symbolParam && this.opts.getSettings) {
        symbolParam = this.opts.getSettings().symbol;
      }
      const roundsData = this.db.getTradeRounds(symbolParam);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, ...roundsData }));
      return;
    }

    // Database: Trade & Lot Manager Overview API
    if (pathname === "/api/db/trade-manager") {
      let symbolParam = parsedUrl.searchParams.get("symbol") || undefined;
      if (!symbolParam && this.opts.getSettings) {
        symbolParam = this.opts.getSettings().symbol;
      }
      const trades = this.db.getTrades(5000, symbolParam);
      const allOrders = this.db.getOrders(5000, { symbol: symbolParam });
      const state = this.db.getState(symbolParam);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          success: true,
          trades,
          allOrders,
          lots: state.lots || [],
          openOrders: state.openOrders || [],
          realizedPnl: state.realizedPnl || 0,
          tradeRealizedPnl: state.tradeRealizedPnl || 0,
        }),
      );
      return;
    }

    // Trade Manager: Update Trade
    if (pathname === "/api/db/trades/update" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          if (!parsed.id) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: "Missing trade ID" }));
            return;
          }
          const result = this.db.updateTrade(parsed.id, parsed.updates || {});
          if (result.success) {
            if (result.order) {
              const idx = this.recentOrders.findIndex(
                (o: any) => o.id === parsed.id || o.orderId === parsed.id || o.txHash === parsed.id,
              );
              if (idx >= 0) {
                this.recentOrders[idx] = { ...this.recentOrders[idx], ...result.order };
              }
            }
            this.opts.onReloadState?.();
            this.broadcast("trade_updated", { id: parsed.id, order: result.order });
          }
          res.writeHead(result.success ? 200 : 400, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (e: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: (e as Error).message }));
        }
      });
      return;
    }

    // Trade Manager: Delete Trade (Permanent or Mark as Cancelled)
    if (pathname === "/api/db/trades/delete" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          if (!parsed.id) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: "Missing trade ID" }));
            return;
          }
          const result = this.db.deleteTrade(parsed.id, parsed.opts || {});
          if (result.success) {
            this.recentOrders = this.recentOrders.filter(
              (o: any) => o.id !== parsed.id && o.orderId !== parsed.id && o.txHash !== parsed.id,
            );
            this.opts.onReloadState?.();
            this.broadcast("trade_deleted", { id: parsed.id, opts: parsed.opts });
          }
          res.writeHead(result.success ? 200 : 400, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (e: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: (e as Error).message }));
        }
      });
      return;
    }

    // Trade Manager: Add Manual Trade
    if (pathname === "/api/db/trades/add" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          if (!parsed.symbol && this.opts.getSettings) {
            parsed.symbol = this.opts.getSettings().symbol;
          }
          const result = this.db.addManualTrade(parsed || {});
          if (result.success) {
            if (result.order) {
              this.addOrder(result.order);
            }
            this.opts.onReloadState?.();
            this.broadcast("trade_added", { order: result.order });
          }
          res.writeHead(result.success ? 200 : 400, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (e: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: (e as Error).message }));
        }
      });
      return;
    }

    // Trade Manager: Reconcile Manual Trades PnL
    if (pathname === "/api/db/trades/reconcile-pnl" && (req.method === "POST" || req.method === "GET")) {
      try {
        const added = this.db.reconcileManualTradesPnl();
        this.opts.onReloadState?.();
        const state = this.db.getState();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            success: true,
            added,
            tradeRealizedPnl: state.tradeRealizedPnl,
            realizedPnl: state.realizedPnl,
          }),
        );
      } catch (e: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: (e as Error).message }));
      }
      return;
    }

    // Trade Manager: Reconcile / Sync trades directly from Binance / Exchange
    if (
      (pathname === "/api/db/trades/sync-exchange" || pathname === "/api/db/trades/sync-binance") &&
      (req.method === "POST" || req.method === "GET")
    ) {
      (async () => {
        try {
          let result: { success: boolean; synced: number; purged?: number; error?: string };
          if (this.opts.onSyncExchangeTrades) {
            result = await this.opts.onSyncExchangeTrades();
          } else {
            result = { success: false, synced: 0, error: "Exchange trade sync callback not registered" };
          }
          this.opts.onReloadState?.();
          const state = this.db.getState();
          res.writeHead(result.success ? 200 : 400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ...result,
              tradeRealizedPnl: state.tradeRealizedPnl,
              realizedPnl: state.realizedPnl,
            }),
          );
        } catch (e: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: (e as Error).message }));
        }
      })();
      return;
    }

    // Lot Manager: Update Lot
    if (pathname === "/api/db/lots/update" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          if (typeof parsed.index !== "number" || !parsed.lot) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: "Missing lot index or lot payload" }));
            return;
          }
          const result = this.db.updateLot(parsed.index, parsed.lot, parsed.symbol);
          if (result.success) {
            this.opts.onReloadState?.();
            this.broadcast("lots_updated", { lots: result.lots });
          }
          res.writeHead(result.success ? 200 : 400, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (e: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: (e as Error).message }));
        }
      });
      return;
    }

    // Lot Manager: Delete Lot
    if (pathname === "/api/db/lots/delete" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          if (typeof parsed.index !== "number") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: "Missing lot index" }));
            return;
          }
          const result = this.db.deleteLot(parsed.index, parsed.symbol);
          if (result.success) {
            this.opts.onReloadState?.();
            this.broadcast("lots_updated", { lots: result.lots });
          }
          res.writeHead(result.success ? 200 : 400, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (e: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: (e as Error).message }));
        }
      });
      return;
    }

    // Lot Manager: Add Lot
    if (pathname === "/api/db/lots/add" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          if (!parsed.lot) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: "Missing lot payload" }));
            return;
          }
          const result = this.db.addLot(parsed.lot, parsed.symbol);
          if (result.success) {
            this.opts.onReloadState?.();
            this.broadcast("lots_updated", { lots: result.lots });
          }
          res.writeHead(result.success ? 200 : 400, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (e: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: (e as Error).message }));
        }
      });
      return;
    }

    // Bot Control: Pause / Resume API
    if (pathname === "/api/bot/pause") {
      if (req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          try {
            const parsed = body ? JSON.parse(body) : {};
            const shouldPause = typeof parsed.paused === "boolean" ? parsed.paused : !(this.opts.getIsPaused ? this.opts.getIsPaused() : false);
            const isPaused = this.opts.onPauseBot ? this.opts.onPauseBot(shouldPause) : shouldPause;
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: true, isPaused }));
          } catch (e: any) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: (e as Error).message }));
          }
        });
        return;
      }
      const isPaused = this.opts.getIsPaused ? this.opts.getIsPaused() : false;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ isPaused }));
      return;
    }

    // Bot Control: Emergency Cancel All Orders API
    if (pathname === "/api/bot/cancel-all" && req.method === "POST") {
      (async () => {
        try {
          const result = this.opts.onCancelAll ? await this.opts.onCancelAll() : { cancelledCount: 0 };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, ...result }));
        } catch (e: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: (e as Error).message }));
        }
      })();
      return;
    }

    // Bot Control: Emergency Sell All Position API
    if (pathname === "/api/bot/sell-all" && req.method === "POST") {
      (async () => {
        try {
          const result = this.opts.onSellAll ? await this.opts.onSellAll() : { success: false, soldQty: 0, price: 0, error: "Handler not registered" };
          res.writeHead(result.success ? 200 : 400, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (e: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: (e as Error).message }));
        }
      })();
      return;
    }

    // Bot Control: Reset Bot State API
    if (pathname === "/api/bot/reset" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const parsed = body ? JSON.parse(body) : {};
          this.resetState(parsed);
          const result = this.opts.onResetBot ? await this.opts.onResetBot(parsed) : { success: true };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (e: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: (e as Error).message }));
        }
      });
      return;
    }

    // Bot Control: Reset Position Lots API
    if (pathname === "/api/bot/reset-position" && req.method === "POST") {
      (async () => {
        try {
          const result = this.opts.onResetPosition ? await this.opts.onResetPosition() : { success: true, clearedLots: 0 };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (e: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: (e as Error).message }));
        }
      })();
      return;
    }

    // Dynamic Spot Symbols list (Binance & DreamDEX)
    if (pathname === "/api/symbols" && req.method === "GET") {
      const exchangeQuery = (parsedUrl.searchParams.get("exchange") || "binance").toLowerCase();
      if (exchangeQuery === "dreamdex") {
        const dreamdexSymbols = ["SOMI", "SOMI:USDSO", "USDC.E:USDSO", "WBTC:USDSO", "WETH:USDSO"];
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, exchange: "dreamdex", symbols: dreamdexSymbols, popular: dreamdexSymbols }));
        return;
      }

      // Check Binance in-memory cache (1 hour)
      const now = Date.now();
      if (this.binanceSymbolsCache && now - this.binanceSymbolsCache.time < 3600_000) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, exchange: "binance", ...this.binanceSymbolsCache }));
        return;
      }

      // Async fetch all active spot trading pairs from Binance
      (async () => {
        const fallbackPopular = [
          "BTCUSDT", "ETHUSDT", "ETHFDUSD", "BTCFDUSD", "SOLUSDT", "SOLFDUSD",
          "BNBUSDT", "BNBFDUSD", "DOGEUSDT", "DOGEFDUSD", "XRPUSDT", "XRPFDUSD",
          "ADAUSDT", "AVAXUSDT", "SUIUSDT", "SUIFDUSD", "NEARUSDT", "PEPEUSDT",
        ];
        try {
          const resp = await fetch("https://api.binance.com/api/v3/exchangeInfo");
          if (resp.ok) {
            const data = (await resp.json()) as any;
            const spotSymbols = (data.symbols || []).filter(
              (s: any) => s.status === "TRADING" && s.isSpotTradingAllowed !== false && ["USDT", "FDUSD", "USDC"].includes(s.quoteAsset),
            );
            const fdusd = spotSymbols.filter((s: any) => s.quoteAsset === "FDUSD").map((s: any) => s.symbol).sort();
            const usdt = spotSymbols.filter((s: any) => s.quoteAsset === "USDT").map((s: any) => s.symbol).sort();
            const usdc = spotSymbols.filter((s: any) => s.quoteAsset === "USDC").map((s: any) => s.symbol).sort();
            const allSymbols = spotSymbols.map((s: any) => s.symbol).sort();
            const popular = fallbackPopular.filter((sym) => allSymbols.includes(sym));

            this.binanceSymbolsCache = {
              time: now,
              symbols: allSymbols,
              popular: popular.length > 0 ? popular : fallbackPopular,
              fdusd,
              usdt,
              usdc,
            };
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: true, exchange: "binance", ...this.binanceSymbolsCache }));
            return;
          }
        } catch (fetchErr) {
          this.opts.log(`⚠️ Failed to fetch dynamic symbols from Binance API: ${(fetchErr as Error).message}`);
        }

        // Fallback if fetch fails
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: true,
          exchange: "binance",
          symbols: fallbackPopular,
          popular: fallbackPopular,
          fdusd: ["ETHFDUSD", "BTCFDUSD", "SOLFDUSD", "BNBFDUSD", "DOGEFDUSD", "XRPFDUSD", "SUIFDUSD"],
          usdt: fallbackPopular.filter((s) => s.endsWith("USDT")),
          usdc: [],
        }));
      })();
      return;
    }

    // ─── Backtest API Endpoints ──────────────────────────────────────────────
    if (pathname === "/api/backtest/run" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const liveCfg = this.opts.getSettings ? this.opts.getSettings() : this.db.getAllSettings();
          const parsed = body ? JSON.parse(body) : {};
          const symbol = parsed.symbol || this.latestTick?.symbol || liveCfg.symbol || "BNBFDUSD";
          const timeframe = parsed.timeframe || (liveCfg.maFanExecutionTimeframe as string) || "5m";
          const limit = Number(parsed.limit) || 1000;
          const spreadThreshold = parsed.spreadThreshold === "auto" ? "auto" : (Number(parsed.spreadThreshold) || 0.25);
          const budget = Number(parsed.budget) || Number(liveCfg.maFanMaxBudgetUsd) || 200;
          const slBufferPct = Number(parsed.slBufferPct) || Number(liveCfg.maFanSlBufferPct) || 0.25;
          const useRatchetSl = parsed.useRatchetSl !== false;
          const supervisorTimeframe = (parsed.supervisorTimeframe || liveCfg.maFanSupervisorTimeframe || "15m") as "15m" | "1h";
          const macroGateMode = parsed.macroGateMode || liveCfg.maFanMacroGate || "off";
          const enableUpsideFloor = parsed.enableUpsideFloor !== undefined ? Boolean(parsed.enableUpsideFloor) : (liveCfg.maFanUpsideFloor !== false);
          const enableCircuitBreaker = parsed.enableCircuitBreaker !== undefined ? Boolean(parsed.enableCircuitBreaker) : (liveCfg.maFanCircuitBreaker !== false);
          const enableFastCut = parsed.enableFastCut !== undefined ? Boolean(parsed.enableFastCut) : true;
          const fastCutThresholdPct = parsed.fastCutThresholdPct !== undefined ? Number(parsed.fastCutThresholdPct) : -0.80;
          const stagnationBars = parsed.stagnationBars !== undefined ? Number(parsed.stagnationBars) : 6;
          const maxSlPct = parsed.maxSlPct !== undefined ? Number(parsed.maxSlPct) : 1.80;
          const lockChannelInPosition = parsed.lockChannelInPosition !== undefined ? Boolean(parsed.lockChannelInPosition) : (liveCfg.lockChannelInPosition !== false);

          const isAutoSpread = spreadThreshold === "auto";
          const warmupPrefixBars = isAutoSpread ? 1200 : 0;
          const fetchLimit = limit + warmupPrefixBars;

          // Compute required HTF supervisor candles based on fetchLimit and timeframe ratio
          const tfMinutes = timeframe === "1m" ? 1 : timeframe === "5m" ? 5 : timeframe === "15m" ? 15 : 60;
          const htfMinutes = supervisorTimeframe === "1h" ? 60 : 15;
          const htfLimit = Math.max(300, Math.ceil((fetchLimit * tfMinutes) / htfMinutes) + 50);

          let feePctPerSide = 0.075;
          let slippagePctPerFill = 0.01;
          if (parsed.feeTier === "zero" || (parsed.feeTier === "auto" && symbol.endsWith("FDUSD"))) {
            feePctPerSide = 0.0;
            slippagePctPerFill = 0.0;
          } else if (parsed.feeTier === "standard") {
            feePctPerSide = 0.10;
            slippagePctPerFill = 0.01;
          } else if (parsed.feeTier === "bnb") {
            feePctPerSide = 0.075;
            slippagePctPerFill = 0.01;
          } else if (parsed.feeTier === "none") {
            feePctPerSide = 0;
            slippagePctPerFill = 0;
          } else if (symbol.endsWith("FDUSD")) {
            feePctPerSide = 0;
            slippagePctPerFill = 0;
          }
          const costModel = { feePctPerSide, slippagePctPerFill };

          const hlMode = parsed.enableBaseConfirmationFilter !== undefined ? Boolean(parsed.enableBaseConfirmationFilter) : false;
          const hlModeStr = hlMode ? "ON (รอสร้างฐาน HL - บอทจริง)" : "OFF (Pure Grid - ดักเก็บทุกรอบ)";
          console.log(`[Backtest] 🚀 Running Backtest: ${symbol} (${timeframe}, ${limit} bars, Engine: ${parsed.tradeMode || "dip_hunter"}, HL Filter: ${hlModeStr})...`);

          const [candles, candlesHtf] = await Promise.all([
            BacktestService.fetchBinanceCandles(symbol, timeframe, fetchLimit),
            BacktestService.fetchBinanceCandles(symbol, supervisorTimeframe, htfLimit).catch(() => []),
          ]);
          const actualWarmup = isAutoSpread ? Math.max(0, candles.length - limit) : 0;

          const result = BacktestService.runMaFanSimulation(candles, {
            symbol,
            timeframe,
            spreadThreshold,
            initialCapital: budget,
            slBufferPct,
            useRatchetSl,
            useAtrAdaptiveSpread: liveCfg.maFanUseAtrAdaptiveSpread ?? true,
            atrMultiplier: Number(liveCfg.maFanAtrMultiplier) || 1.25,
            trailingPullbackPct: parsed.trailingPullbackPct !== undefined ? Number(parsed.trailingPullbackPct) : (Number(liveCfg.maFanTrailingPullbackPct) || 0.45),
            tp1Ratio: parsed.tp1Ratio !== undefined ? Number(parsed.tp1Ratio) : (Number(liveCfg.maFanTp1Ratio) || 0.5),
            breakevenFeeBufferPct: parsed.breakevenFeeBufferPct !== undefined ? Number(parsed.breakevenFeeBufferPct) : (Number(liveCfg.maFanBreakevenFeeBufferPct) || 0.05),
            supervisorTimeframe,
            candlesHtf: candlesHtf.length > 0 ? candlesHtf : undefined,
            cushionMode: parsed.cushionMode ?? (liveCfg.maFanBullCushion ? "htfBull" : "off"),
            waterfallGuardMode: parsed.waterfallGuardMode ?? (liveCfg.maFanWaterfallGuard !== false ? "combined" : "off"),
            costModel,
            macroGateMode,
            enableUpsideFloor,
            enableCircuitBreaker,
            enableFastCut,
            fastCutThresholdPct,
            stagnationBars,
            maxSlPct,
            tradeMode: parsed.tradeMode || (liveCfg.maFanTradeMode as any) || "dip_hunter",
            tradeDirection: parsed.tradeDirection || (liveCfg.maFanTradeDirection as any) || "long",
            enableBaseConfirmationFilter: hlMode,
            channelMode: parsed.channelMode || (liveCfg.channelMode as any) || "DONCHIAN_ATR",
            donchianPeriod: parsed.donchianPeriod !== undefined ? Number(parsed.donchianPeriod) : (Number(liveCfg.donchianPeriod) || 48),
            minChannelWidthPct: parsed.minChannelWidthPct !== undefined ? Number(parsed.minChannelWidthPct) : (Number(liveCfg.minChannelWidthPct) || 6.0),
            maxChannelWidthPct: parsed.maxChannelWidthPct !== undefined ? Number(parsed.maxChannelWidthPct) : (Number(liveCfg.maxChannelWidthPct) || 20.0),
            floorBufferPct: parsed.floorBufferPct !== undefined ? Number(parsed.floorBufferPct) : (Number(liveCfg.floorBufferPct) || 0.0),
            maxInventoryQuote: parsed.budget ? Number(parsed.budget) : (Number(liveCfg.maxInventoryQuote) || budget),
            lockChannelInPosition,
            capitalZones: parsed.capitalZones !== undefined ? Number(parsed.capitalZones) : (Number(liveCfg.capitalZones) || 4),
            zoneStabilizeCandles: parsed.zoneStabilizeCandles !== undefined ? Number(parsed.zoneStabilizeCandles) : (Number(liveCfg.zoneStabilizeCandles) || 3),
            zoneMinDropPct: parsed.zoneMinDropPct !== undefined ? Number(parsed.zoneMinDropPct) : (Number(liveCfg.zoneMinDropPct) || 2.5),
            gridCutLossMode: parsed.gridCutLossMode || (liveCfg.gridCutLossMode as any) || "final_zone_floor",
            zoneExitMode: parsed.zoneExitMode || (liveCfg.zoneExitMode as any) || "PORTFOLIO_AVG",
            minNetProfitPct: parsed.minNetProfitPct !== undefined ? Number(parsed.minNetProfitPct) : (Number(liveCfg.minNetProfitPct) || 0.25),
            warmupBars: actualWarmup,
            trimWarmupPrefix: isAutoSpread && actualWarmup > 0,
          });

          console.log(`[Backtest] ✅ Simulation complete for ${symbol}: Net PnL ${(result.summary.netPnlPct >= 0 ? '+' : '')}${result.summary.netPnlPct.toFixed(2)}% | Win Rate ${result.summary.winRate.toFixed(1)}% | ${result.summary.totalTrades} trades`);

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, ...result }));
        } catch (e: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: (e as Error).message }));
        }
      });
      return;
    }

    if (pathname === "/api/backtest/scan/progress" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, progress: this.currentScanProgress }));
      return;
    }

    if (pathname === "/api/backtest/scan" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const liveCfg = this.opts.getSettings ? this.opts.getSettings() : this.db.getAllSettings();
          const parsed = body ? JSON.parse(body) : {};
          const scope = parsed.scope || "top20";
          const timeframe = parsed.timeframe || (liveCfg.maFanExecutionTimeframe as string) || "5m";
          const limit = Number(parsed.limit) || 1000;
          const spreadThreshold = parsed.spreadThreshold === "auto" ? "auto" : (Number(parsed.spreadThreshold) || undefined);
          const useRatchetSl = parsed.useRatchetSl !== false;
          const macroGateMode = parsed.macroGateMode || liveCfg.maFanMacroGate || "off";
          const enableUpsideFloor = parsed.enableUpsideFloor !== undefined ? Boolean(parsed.enableUpsideFloor) : (liveCfg.maFanUpsideFloor !== false);
          const enableCircuitBreaker = parsed.enableCircuitBreaker !== undefined ? Boolean(parsed.enableCircuitBreaker) : (liveCfg.maFanCircuitBreaker !== false);
          const enableFastCut = parsed.enableFastCut !== undefined ? Boolean(parsed.enableFastCut) : true;
          const fastCutThresholdPct = parsed.fastCutThresholdPct !== undefined ? Number(parsed.fastCutThresholdPct) : -0.80;
          const stagnationBars = parsed.stagnationBars !== undefined ? Number(parsed.stagnationBars) : 6;
          const maxSlPct = parsed.maxSlPct !== undefined ? Number(parsed.maxSlPct) : 1.80;
          const lockChannelInPosition = parsed.lockChannelInPosition !== undefined ? Boolean(parsed.lockChannelInPosition) : (liveCfg.lockChannelInPosition !== false);
          const enableBaseConfirmationFilter = parsed.enableBaseConfirmationFilter !== undefined ? Boolean(parsed.enableBaseConfirmationFilter) : false;

          let scanCostModel: { feePctPerSide: number; slippagePctPerFill: number } | undefined;
          if (parsed.feeTier === "zero" || parsed.feeTier === "none") {
            scanCostModel = { feePctPerSide: 0, slippagePctPerFill: 0 };
          } else if (parsed.feeTier === "standard") {
            scanCostModel = { feePctPerSide: 0.10, slippagePctPerFill: 0.01 };
          } else if (parsed.feeTier === "bnb") {
            scanCostModel = { feePctPerSide: 0.075, slippagePctPerFill: 0.01 };
          }

          this.currentScanProgress = { index: 0, total: 0, symbol: "Starting...", candlesCount: 0 };
          const hlModeStr = enableBaseConfirmationFilter ? "ON (รอสร้างฐาน HL - บอทจริง)" : "OFF (Pure Grid - ดักเก็บทุกรอบ)";
          console.log(`[MarketScanner] 🚀 Starting Market Scan (Scope: ${scope}, TF: ${timeframe}, Limit: ${limit} bars, Engine: ${parsed.tradeMode || "dip_hunter"}, HL Filter: ${hlModeStr})...`);

          const results = await BacktestService.scanMarket({
            scope,
            timeframe,
            limit,
            spreadThreshold,
            useRatchetSl,
            initialCapital: Number(parsed.budget) || Number(liveCfg.maFanMaxBudgetUsd) || 200,
            slBufferPct: parsed.slBufferPct !== undefined ? Number(parsed.slBufferPct) : (Number(liveCfg.maFanSlBufferPct) || 0.25),
            useAtrAdaptiveSpread: liveCfg.maFanUseAtrAdaptiveSpread ?? true,
            atrMultiplier: Number(liveCfg.maFanAtrMultiplier) || 1.25,
            trailingPullbackPct: parsed.trailingPullbackPct !== undefined ? Number(parsed.trailingPullbackPct) : (Number(liveCfg.maFanTrailingPullbackPct) || 0.45),
            tp1Ratio: parsed.tp1Ratio !== undefined ? Number(parsed.tp1Ratio) : (Number(liveCfg.maFanTp1Ratio) || 0.5),
            breakevenFeeBufferPct: parsed.breakevenFeeBufferPct !== undefined ? Number(parsed.breakevenFeeBufferPct) : (Number(liveCfg.maFanBreakevenFeeBufferPct) || 0.05),
            supervisorTimeframe: (parsed.supervisorTimeframe || liveCfg.maFanSupervisorTimeframe || "15m") as "15m" | "1h",
            cushionMode: parsed.cushionMode ?? (liveCfg.maFanBullCushion ? "htfBull" : "off"),
            waterfallGuardMode: parsed.waterfallGuardMode ?? (liveCfg.maFanWaterfallGuard !== false ? "combined" : "off"),
            costModel: scanCostModel,
            macroGateMode,
            enableUpsideFloor,
            enableCircuitBreaker,
            enableFastCut,
            fastCutThresholdPct,
            stagnationBars,
            maxSlPct,
            tradeMode: parsed.tradeMode || (liveCfg.maFanTradeMode as any) || "dip_hunter",
            tradeDirection: parsed.tradeDirection || (liveCfg.maFanTradeDirection as any) || "long",
            enableBaseConfirmationFilter,
            lockChannelInPosition,
            onProgress: (p) => {
              this.currentScanProgress = p;
              this.broadcast("scan_progress", p);
            },
          });

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, count: results.length, results }));
        } catch (e: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: (e as Error).message }));
        } finally {
          this.currentScanProgress = null;
        }
      });
      return;
    }

    if (pathname === "/api/backtest/scan/latest" && req.method === "GET") {
      const latest = BacktestService.getLatestScan();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, scan: latest }));
      return;
    }

    if (pathname === "/api/backtest/history" && req.method === "GET") {
      const history = BacktestService.getHistoryList();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, history }));
      return;
    }

    if (pathname === "/api/backtest/history/get" && req.method === "GET") {
      const id = parsedUrl.searchParams.get("id");
      if (!id) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "Missing backtest ID" }));
        return;
      }
      const record = BacktestService.getRecordById(id);
      if (!record) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "Backtest record not found" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, record }));
      return;
    }

    if (pathname === "/api/decision-snapshots" && req.method === "GET") {
      const limit = Math.min(1000, Math.max(1, parseInt(parsedUrl.searchParams.get("limit") || "200", 10)));
      const snapshots = readLatestDecisionSnapshots(limit);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, count: snapshots.length, snapshots }));
      return;
    }

    if (
      (pathname === "/api/backtest/history/delete" && req.method === "POST") ||
      (pathname === "/api/backtest/delete" && req.method === "POST")
    ) {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const parsed = body ? JSON.parse(body) : {};
          const id = parsed.id || parsedUrl.searchParams.get("id");
          if (!id) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: "Missing ID" }));
            return;
          }
          const ok = BacktestService.deleteRecordById(id);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: ok }));
        } catch (e: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: (e as Error).message }));
        }
      });
      return;
    }

    // Database: Bot Settings Key-Value API (GET & POST)
    if (pathname === "/api/db/settings" || pathname === "/api/config") {
      if (req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", async () => {
          try {
            const parsed = JSON.parse(body);
            if (parsed && typeof parsed === "object") {
              const updated = this.opts.onUpdateSettings
                ? await this.opts.onUpdateSettings(parsed)
                : (() => {
                    this.db.setSettings(parsed);
                    return this.db.getAllSettings();
                  })();
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ success: true, settings: updated }));
              return;
            }
          } catch (e: any) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: (e as Error).message || "Invalid JSON payload" }));
            return;
          }
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON payload" }));
        });
        return;
      }
      const current = this.opts.getSettings ? this.opts.getSettings() : this.db.getAllSettings();
      const masked = { ...current };
      if (masked.binanceApiKey) masked.binanceApiKey = "******";
      if (masked.binanceApiSecret) masked.binanceApiSecret = "******";
      if (masked.dreamdexPrivateKey) masked.dreamdexPrivateKey = "******";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(masked));
      return;
    }

    // Serve static files from public/
    let filePath = path.join(PUBLIC_DIR, pathname === "/" ? "index.html" : pathname);
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    fs.stat(filePath, (err, stats) => {
      if (err || !stats.isFile()) {
        // Fallback to index.html for SPA if needed
        filePath = path.join(PUBLIC_DIR, "index.html");
      }

      const ext = path.extname(filePath).toLowerCase();
      const mimeTypes: Record<string, string> = {
        ".html": "text/html; charset=utf-8",
        ".js": "application/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".json": "application/json",
        ".png": "image/png",
        ".svg": "image/svg+xml",
      };

      const contentType = mimeTypes[ext] || "application/octet-stream";
      fs.readFile(filePath, (readErr, content) => {
        if (readErr) {
          res.writeHead(404);
          res.end("Not Found");
          return;
        }
        res.writeHead(200, {
          "Content-Type": contentType,
          "Cache-Control": "no-cache, no-store, must-revalidate",
        });
        res.end(content);
      });
    });
  }
}
