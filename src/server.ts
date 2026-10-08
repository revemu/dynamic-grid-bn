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
  onResetBot?: (opts?: { resetPnl?: boolean; clearTrades?: boolean }) => Promise<{ success: boolean }>;
  onResetPosition?: () => Promise<{ success: boolean; clearedLots: number }>;
  onReloadState?: () => void;
  maxCandles?: number;
}

export class DashboardServer {
  private server?: http.Server;
  private clients: Set<http.ServerResponse> = new Set();
  private candles: Candle[] = [];
  private recentOrders: any[] = [];
  private latestTick: any = null;
  private db: BotDatabase;
  private maxCandles = 600;

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
      this.opts.log(`web dashboard live at http://localhost:${this.opts.port}`);
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

  updateOrderGas(txHash: string, gasFeeSomi: number, gasFeeUsdso: number): void {
    const match = this.recentOrders.find(
      (o) => o.createTxHash === txHash || o.cancelTxHash === txHash || o.txHash === txHash,
    );
    if (match) {
      match.gasFeeSomi = (match.gasFeeSomi || 0) + gasFeeSomi;
      match.gasFeeUsdso = (match.gasFeeUsdso || 0) + gasFeeUsdso;
    }
    this.broadcast("order_gas", { txHash, gasFeeSomi, gasFeeUsdso });
  }

  updateTick(tickData: any): void {
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

    // Snapshot state
    if (pathname === "/api/state") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          candles: this.candles,
          orders: this.recentOrders,
          latestTick: this.latestTick,
        }),
      );
      return;
    }

    // Database: Trades History API
    if (pathname === "/api/db/trades") {
      const limit = parseInt(parsedUrl.searchParams.get("limit") || "5000", 10);
      const trades = this.db.getTrades(limit);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(trades));
      return;
    }

    // Database: Order Activity History API
    if (pathname === "/api/db/orders") {
      const limit = parseInt(parsedUrl.searchParams.get("limit") || "5000", 10);
      const orders = this.db.getOrderActivity(limit);
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
      const roundsData = this.db.getTradeRounds();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, ...roundsData }));
      return;
    }

    // Database: Trade & Lot Manager Overview API
    if (pathname === "/api/db/trade-manager") {
      const trades = this.db.getTrades(5000);
      const allOrders = this.db.getOrders(5000);
      const state = this.db.getState();
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
          const result = this.db.addManualTrade(parsed || {});
          if (result.success) {
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
          const result = this.db.updateLot(parsed.index, parsed.lot);
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
          const result = this.db.deleteLot(parsed.index);
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
          const result = this.db.addLot(parsed.lot);
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

    // Popular Binance Spot Symbols list
    if (pathname === "/api/symbols" && req.method === "GET") {
      const popular = [
        "BTCUSDT",
        "ETHUSDT",
        "SOLUSDT",
        "BNBUSDT",
        "DOGEUSDT",
        "XRPUSDT",
        "ADAUSDT",
        "AVAXUSDT",
        "SUIUSDT",
        "NEARUSDT",
        "PEPEUSDT",
        "SHIBUSDT",
        "LINKUSDT",
        "DOTUSDT",
        "FETUSDT",
      ];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ symbols: popular }));
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
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(current));
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
        res.writeHead(200, { "Content-Type": contentType });
        res.end(content);
      });
    });
  }
}
