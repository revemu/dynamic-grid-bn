/**
 * MA Fan Backtest Studio - Frontend Controller
 * TradingView Lightweight Charts rendering, interactive simulation triggers,
 * and trade-by-trade chart zooming.
 */

(function () {
  "use strict";

  // State variables
  let chart = null;
  let candleSeries = null;
  let ema4Series = null;
  let ema8Series = null;
  let ema16Series = null;
  let ema25Series = null;
  let ema75Series = null;
  let ema200Series = null;

  let currentRecord = null;
  let activeFilter = "ALL";

  // Elements
  const chartContainer = document.getElementById("btChartContainer");
  const btnRunBacktest = document.getElementById("btnRunBacktest");
  const btnOpenHistory = document.getElementById("btnOpenHistory");
  const btnCloseHistoryModal = document.getElementById("btnCloseHistoryModal");
  const historyModalBackdrop = document.getElementById("historyModalBackdrop");
  const loadingOverlay = document.getElementById("loadingOverlay");
  const loadingText = document.getElementById("loadingText");
  const historyCountEl = document.getElementById("historyCount");

  // Inputs
  const inpSymbol = document.getElementById("btSymbol");
  const inpTimeframe = document.getElementById("btTimeframe");
  const inpLimit = document.getElementById("btLimit");
  const inpSpread = document.getElementById("btSpread");
  const inpBudget = document.getElementById("btBudget");

  // Legend elements
  const legSymTf = document.getElementById("legSymTf");
  const legOhlc = document.getElementById("legOhlc");
  const legValEma4 = document.getElementById("legValEma4");
  const legValEma8 = document.getElementById("legValEma8");
  const legValEma16 = document.getElementById("legValEma16");
  const legValEma25 = document.getElementById("legValEma25");
  const legValEma75 = document.getElementById("legValEma75");
  const legValEma200 = document.getElementById("legValEma200");

  // KPI elements
  const kpiNetPnl = document.getElementById("kpiNetPnl");
  const kpiNetPnlQuote = document.getElementById("kpiNetPnlQuote");
  const kpiWinRate = document.getElementById("kpiWinRate");
  const kpiWinLoss = document.getElementById("kpiWinLoss");
  const kpiTotalTrades = document.getElementById("kpiTotalTrades");
  const kpiAvgBars = document.getElementById("kpiAvgBars");
  const kpiProfitFactor = document.getElementById("kpiProfitFactor");
  const kpiMaxDrawdown = document.getElementById("kpiMaxDrawdown");
  const kpiBestTrade = document.getElementById("kpiBestTrade");
  const kpiWorstTrade = document.getElementById("kpiWorstTrade");

  // Overlay elements
  const overlayStatus = document.getElementById("overlayStatus");
  const overlayInfo = document.getElementById("overlayInfo");

  // Table & filters
  const tradesTableBody = document.getElementById("tradesTableBody");
  const filterBtns = document.querySelectorAll(".filter-btn");
  const cntAll = document.getElementById("cntAll");
  const cntWin = document.getElementById("cntWin");
  const cntLoss = document.getElementById("cntLoss");

  // Colors for EMA ribbons (matching user preferences)
  function getMaColors() {
    try {
      const saved = localStorage.getItem("dg_ma_colors");
      if (saved) return JSON.parse(saved);
    } catch {}
    return {
      c4: "#10b981",
      c8: "#eab308",
      c16: "#f97316",
      c25: "#06b6d4",
      c75: "#a855f7",
      c200: "#ec4899",
    };
  }

  // EMA computation helper
  function calcEma(candles, period) {
    const k = 2 / (period + 1);
    const data = [];
    if (!candles || candles.length === 0) return data;
    let prevEma = 0;
    const initial = Math.min(period, candles.length);
    let sum = 0;
    for (let i = 0; i < initial; i++) sum += candles[i].close;
    prevEma = sum / initial;

    for (let i = 0; i < candles.length; i++) {
      if (i < initial - 1) {
        data.push({ time: candles[i].time, value: prevEma });
      } else if (i === initial - 1) {
        data.push({ time: candles[i].time, value: prevEma });
      } else {
        prevEma = candles[i].close * k + prevEma * (1 - k);
        data.push({ time: candles[i].time, value: prevEma });
      }
    }
    return data;
  }

  // Format price
  function fmtPrice(p) {
    if (typeof p !== "number" || !Number.isFinite(p)) return "--";
    return p >= 1000 ? p.toFixed(2) : p >= 1 ? p.toFixed(4) : p.toFixed(6);
  }

  // Format date time
  function fmtDateTime(sec) {
    if (!sec) return "--";
    const d = new Date(sec * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // Initialize TradingView Lightweight Chart
  function initChart() {
    if (!window.LightweightCharts) {
      console.error("LightweightCharts library not loaded");
      return;
    }

    chart = window.LightweightCharts.createChart(chartContainer, {
      width: chartContainer.clientWidth,
      height: chartContainer.clientHeight || 520,
      layout: {
        background: { color: "#131b2e" },
        textColor: "#94a3b8",
        fontSize: 12,
        fontFamily: "'JetBrains Mono', monospace",
      },
      grid: {
        vertLines: { color: "rgba(255, 255, 255, 0.04)" },
        horzLines: { color: "rgba(255, 255, 255, 0.04)" },
      },
      crosshair: {
        mode: window.LightweightCharts.CrosshairMode.Normal,
      },
      rightPriceScale: {
        borderColor: "#22304d",
        scaleMargins: { top: 0.1, bottom: 0.1 },
      },
      timeScale: {
        borderColor: "#22304d",
        timeVisible: true,
        secondsVisible: false,
      },
    });

    candleSeries = chart.addCandlestickSeries({
      upColor: "#10b981",
      downColor: "#ef4444",
      borderVisible: false,
      wickUpColor: "#10b981",
      wickDownColor: "#ef4444",
    });

    const colors = getMaColors();
    const lc = window.LightweightCharts;

    ema4Series = chart.addLineSeries({
      color: colors.c4,
      lineWidth: 1,
      lineStyle: lc.LineStyle.Solid,
      title: "",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    ema8Series = chart.addLineSeries({
      color: colors.c8,
      lineWidth: 1,
      lineStyle: lc.LineStyle.Solid,
      title: "",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    ema16Series = chart.addLineSeries({
      color: colors.c16,
      lineWidth: 1,
      lineStyle: lc.LineStyle.Solid,
      title: "",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    ema25Series = chart.addLineSeries({
      color: colors.c25,
      lineWidth: 2,
      lineStyle: lc.LineStyle.Solid,
      title: "",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    ema75Series = chart.addLineSeries({
      color: colors.c75,
      lineWidth: 2,
      lineStyle: lc.LineStyle.Solid,
      title: "",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    ema200Series = chart.addLineSeries({
      color: colors.c200,
      lineWidth: 2,
      lineStyle: lc.LineStyle.Solid,
      title: "",
      lastValueVisible: false,
      priceLineVisible: false,
    });

    // Crosshair hover inspection
    chart.subscribeCrosshairMove((param) => {
      if (!param || !param.time || !param.seriesData) return;
      const cBar = param.seriesData.get(candleSeries);
      if (cBar) {
        legOhlc.textContent = `O: ${fmtPrice(cBar.open)} H: ${fmtPrice(cBar.high)} L: ${fmtPrice(cBar.low)} C: ${fmtPrice(cBar.close)}`;
      }
      const e4 = param.seriesData.get(ema4Series); if (e4) legValEma4.textContent = fmtPrice(e4.value);
      const e8 = param.seriesData.get(ema8Series); if (e8) legValEma8.textContent = fmtPrice(e8.value);
      const e16 = param.seriesData.get(ema16Series); if (e16) legValEma16.textContent = fmtPrice(e16.value);
      const e25 = param.seriesData.get(ema25Series); if (e25) legValEma25.textContent = fmtPrice(e25.value);
      const e75 = param.seriesData.get(ema75Series); if (e75) legValEma75.textContent = fmtPrice(e75.value);
      const e200 = param.seriesData.get(ema200Series); if (e200) legValEma200.textContent = fmtPrice(e200.value);
    });

    // Auto-resize on window resize
    window.addEventListener("resize", () => {
      if (chart && chartContainer) {
        chart.applyOptions({
          width: chartContainer.clientWidth,
          height: chartContainer.clientHeight || 520,
        });
      }
    });
  }

  // Display Backtest Record on Chart & Dashboard
  function displayRecord(record) {
    if (!record) return;
    currentRecord = record;

    // 1. Update Title and Headers
    const sym = record.symbol || "BNBFDUSD";
    const tf = (record.timeframe || "5m").toUpperCase();
    legSymTf.textContent = `${sym} ${tf}`;
    overlayStatus.textContent = `ผลการทดสอบ: ${sym} (${tf})`;
    overlayInfo.textContent = `ทดสอบ ${record.candleCount} แท่ง | Spread ≥ ${(record.spreadThreshold || 0.25).toFixed(2)}% | ${record.trades?.length || 0} ไม้`;

    // 2. Set Candles and EMA lines
    if (record.candles && record.candles.length > 0) {
      candleSeries.setData(record.candles);

      const e4 = calcEma(record.candles, 4);
      const e8 = calcEma(record.candles, 8);
      const e16 = calcEma(record.candles, 16);
      const e25 = calcEma(record.candles, 25);
      const e75 = calcEma(record.candles, 75);
      const e200 = calcEma(record.candles, 200);

      ema4Series.setData(e4);
      ema8Series.setData(e8);
      ema16Series.setData(e16);
      ema25Series.setData(e25);
      ema75Series.setData(e75);
      ema200Series.setData(e200);

      // Latest values for legend
      const lastC = record.candles[record.candles.length - 1];
      legOhlc.textContent = `O: ${fmtPrice(lastC.open)} H: ${fmtPrice(lastC.high)} L: ${fmtPrice(lastC.low)} C: ${fmtPrice(lastC.close)}`;
      if (e4.length > 0) legValEma4.textContent = fmtPrice(e4[e4.length - 1].value);
      if (e8.length > 0) legValEma8.textContent = fmtPrice(e8[e8.length - 1].value);
      if (e16.length > 0) legValEma16.textContent = fmtPrice(e16[e16.length - 1].value);
      if (e25.length > 0) legValEma25.textContent = fmtPrice(e25[e25.length - 1].value);
      if (e75.length > 0) legValEma75.textContent = fmtPrice(e75[e75.length - 1].value);
      if (e200.length > 0) legValEma200.textContent = fmtPrice(e200[e200.length - 1].value);
    }

    // 3. Set Markers on Chart
    if (record.markers && Array.isArray(record.markers)) {
      candleSeries.setMarkers(record.markers);
    } else {
      candleSeries.setMarkers([]);
    }

    // Fit chart
    chart.timeScale().fitContent();

    // 4. Update KPI Summary Cards
    const sum = record.summary || {};
    const netPnlPct = sum.netPnlPct ?? 0;
    kpiNetPnl.textContent = `${netPnlPct >= 0 ? "+" : ""}${netPnlPct.toFixed(2)}%`;
    kpiNetPnl.className = `kpi-val ${netPnlPct >= 0 ? "text-win" : "text-loss"}`;

    const netQuote = sum.netPnlQuote ?? 0;
    kpiNetPnlQuote.textContent = `${netQuote >= 0 ? "+$" : "-$"}${Math.abs(netQuote).toFixed(2)}`;

    kpiWinRate.textContent = `${(sum.winRate ?? 0).toFixed(1)}%`;
    kpiWinLoss.textContent = `${sum.winTrades ?? 0} ชนะ / ${sum.lossTrades ?? 0} แพ้`;

    kpiTotalTrades.textContent = `${sum.totalTrades ?? 0} ไม้`;
    kpiAvgBars.textContent = `เฉลี่ย ${sum.avgBarsHeld ?? 0} แท่ง/ไม้`;

    kpiProfitFactor.textContent = (sum.profitFactor ?? 0).toFixed(2);
    kpiMaxDrawdown.textContent = `-${(sum.maxDrawdownPct ?? 0).toFixed(2)}%`;

    kpiBestTrade.textContent = `+${(sum.bestTradePct ?? 0).toFixed(2)}%`;
    kpiWorstTrade.textContent = `${(sum.worstTradePct ?? 0).toFixed(2)}%`;

    // 5. Render Trades Table
    renderTradesTable(record.trades || []);

    // Refresh history badge count
    loadHistoryList();
  }

  // Render Trades Table with Filters
  function renderTradesTable(trades) {
    const wins = trades.filter((t) => t.pnlPct >= 0);
    const losses = trades.filter((t) => t.pnlPct < 0);

    cntAll.textContent = trades.length;
    cntWin.textContent = wins.length;
    cntLoss.textContent = losses.length;

    let filtered = trades;
    if (activeFilter === "WIN") filtered = wins;
    else if (activeFilter === "LOSS") filtered = losses;

    if (filtered.length === 0) {
      tradesTableBody.innerHTML = `<tr><td colspan="9" class="td-empty">ไม่พบรายการไม้เทรดในหมวดนี้</td></tr>`;
      return;
    }

    tradesTableBody.innerHTML = filtered
      .map((t) => {
        const isWin = t.pnlPct >= 0;
        let badgeClass = "badge-sl-loss";
        let badgeLabel = "SL (Loss)";
        if (t.exitType === "TP1+TP2") {
          badgeClass = "badge-tp-full";
          badgeLabel = "TP1 + TP2";
        } else if (t.exitType === "TP1+SL_BE") {
          badgeClass = "badge-tp-be";
          badgeLabel = "TP1 + SL Breakeven";
        }

        return `
          <tr data-trade-id="${t.id}" data-entry-time="${t.entryTime}" data-exit-time="${t.exitTime}">
            <td>#${t.id}</td>
            <td>
              <span style="color: #34d399;">$${fmtPrice(t.entryPrice)}</span>
              <div style="font-size: 10px; color: #94a3b8;">${fmtDateTime(t.entryTime)}</div>
            </td>
            <td>${t.fanSpreadAtEntry ? t.fanSpreadAtEntry.toFixed(2) + "%" : "--"}</td>
            <td>
              <span>$${fmtPrice(t.exitPrice)}</span>
              <div style="font-size: 10px; color: #94a3b8;">${fmtDateTime(t.exitTime)}</div>
            </td>
            <td><span class="badge-exit ${badgeClass}">${badgeLabel}</span></td>
            <td>${t.holdingBars} แท่ง</td>
            <td class="${isWin ? "text-win" : "text-loss"}" style="font-weight: 700;">
              ${isWin ? "+" : ""}${t.pnlPct.toFixed(2)}%
            </td>
            <td class="${isWin ? "text-win" : "text-loss"}">
              ${isWin ? "+$" : "-$"}${Math.abs(t.pnlQuote).toFixed(2)}
            </td>
            <td>
              <button class="btn-zoom" data-trade-id="${t.id}">🔍 ซูมดูกราฟ</button>
            </td>
          </tr>
        `;
      })
      .join("");

    // Bind click-to-zoom on rows
    tradesTableBody.querySelectorAll("tr").forEach((row) => {
      row.addEventListener("click", () => {
        const entryTime = Number(row.getAttribute("data-entry-time"));
        const exitTime = Number(row.getAttribute("data-exit-time"));
        zoomToTrade(entryTime, exitTime);
      });
    });
  }

  // Zoom chart to a specific trade
  function zoomToTrade(entryTime, exitTime) {
    if (!chart || !entryTime) return;
    const paddingSec = 3600 * 3; // 3 hours padding
    const fromTime = entryTime - paddingSec;
    const toTime = (exitTime || entryTime) + paddingSec;

    try {
      chart.timeScale().setVisibleRange({ from: fromTime, to: toTime });
    } catch (e) {
      console.warn("Could not set visible range:", e);
    }
  }

  // Run Backtest Trigger
  async function runBacktest() {
    const symbol = inpSymbol.value.trim().toUpperCase() || "BNBFDUSD";
    const timeframe = inpTimeframe.value;
    const limit = Number(inpLimit.value) || 1000;
    const spreadThreshold = inpSpread.value === "auto" ? "auto" : Number(inpSpread.value);
    const budget = Number(inpBudget.value) || 200;

    loadingOverlay.style.display = "flex";
    loadingText.textContent = `กำลังดึง ${limit} แท่งเทียนของ ${symbol} และรันจำลอง MA Fan Sniper...`;

    try {
      const resp = await fetch("/api/backtest/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, timeframe, limit, spreadThreshold, budget }),
      });

      const data = await resp.json();
      if (!data.success) {
        throw new Error(data.error || "Failed to execute backtest");
      }

      displayRecord(data);
    } catch (err) {
      alert(`❌ เกิดข้อผิดพลาดในการรัน Backtest: ${err.message}`);
    } finally {
      loadingOverlay.style.display = "none";
    }
  }

  // Load Saved History List
  async function loadHistoryList() {
    try {
      const resp = await fetch("/api/backtest/history");
      const data = await resp.json();
      if (!data.success || !Array.isArray(data.history)) return;

      historyCountEl.textContent = data.history.length;
      const historyListEl = document.getElementById("historyList");
      if (!historyListEl) return;

      if (data.history.length === 0) {
        historyListEl.innerHTML = `<div class="td-empty">ยังไม่มีประวัติที่บันทึกไว้ เมื่อรัน Backtest ระบบจะบันทึกอัตโนมัติ</div>`;
        return;
      }

      historyListEl.innerHTML = data.history
        .map((h) => {
          const isWin = (h.summary?.netPnlPct ?? 0) >= 0;
          return `
            <div class="history-item" data-id="${h.id}">
              <div class="hist-left">
                <span class="hist-title">${h.symbol} (${(h.timeframe || "5m").toUpperCase()}) — ${h.tradeCount} ไม้</span>
                <span class="hist-date">${new Date(h.createdAt).toLocaleString("th-TH")} | Spread ≥ ${(h.spreadThreshold || 0.25).toFixed(2)}%</span>
              </div>
              <div class="hist-stats">
                <span class="hist-pnl ${isWin ? "text-win" : "text-loss"}">
                  ${isWin ? "+" : ""}${(h.summary?.netPnlPct ?? 0).toFixed(2)}%
                </span>
                <div class="hist-actions">
                  <button class="btn-hist-load" data-id="${h.id}">📈 โหลดดูกราฟ</button>
                  <button class="btn-hist-del" data-id="${h.id}">🗑️</button>
                </div>
              </div>
            </div>
          `;
        })
        .join("");

      // Bind Load buttons
      historyListEl.querySelectorAll(".btn-hist-load").forEach((btn) => {
        btn.addEventListener("click", async (e) => {
          e.stopPropagation();
          const id = btn.getAttribute("data-id");
          await loadSavedRecord(id);
          historyModalBackdrop.style.display = "none";
        });
      });

      // Bind Delete buttons
      historyListEl.querySelectorAll(".btn-hist-del").forEach((btn) => {
        btn.addEventListener("click", async (e) => {
          e.stopPropagation();
          const id = btn.getAttribute("data-id");
          if (confirm("ต้องการลบผลการทดสอบนี้หรือไม่?")) {
            await deleteSavedRecord(id);
            loadHistoryList();
          }
        });
      });
    } catch (e) {
      console.warn("Could not load history list:", e);
    }
  }

  // Load a saved backtest record by ID
  async function loadSavedRecord(id) {
    loadingOverlay.style.display = "flex";
    loadingText.textContent = "กำลังโหลดผลการทดสอบที่บันทึกไว้...";
    try {
      const resp = await fetch(`/api/backtest/history/get?id=${id}`);
      const data = await resp.json();
      if (!data.success || !data.record) throw new Error(data.error || "Record not found");

      // Populate input controls with loaded record settings
      inpSymbol.value = data.record.symbol || "BNBFDUSD";
      inpTimeframe.value = data.record.timeframe || "5m";
      inpSpread.value = String(data.record.spreadThreshold || "0.25");

      displayRecord(data.record);
    } catch (err) {
      alert(`❌ ไม่สามารถโหลดผลการทดสอบได้: ${err.message}`);
    } finally {
      loadingOverlay.style.display = "none";
    }
  }

  // Delete saved record
  async function deleteSavedRecord(id) {
    try {
      await fetch("/api/backtest/history/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
    } catch (e) {
      console.warn("Could not delete record:", e);
    }
  }

  // Initialize event handlers
  function initEvents() {
    btnRunBacktest.addEventListener("click", runBacktest);

    btnOpenHistory.addEventListener("click", () => {
      loadHistoryList();
      historyModalBackdrop.style.display = "flex";
    });

    btnCloseHistoryModal.addEventListener("click", () => {
      historyModalBackdrop.style.display = "none";
    });

    historyModalBackdrop.addEventListener("click", (e) => {
      if (e.target === historyModalBackdrop) {
        historyModalBackdrop.style.display = "none";
      }
    });

    // Table filter buttons
    filterBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        filterBtns.forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        activeFilter = btn.getAttribute("data-filter") || "ALL";
        if (currentRecord) {
          renderTradesTable(currentRecord.trades || []);
        }
      });
    });
  }

  // Bootstrap
  document.addEventListener("DOMContentLoaded", () => {
    initChart();
    initEvents();
    loadHistoryList();

    // Check if query params exist (e.g. symbol from live bot)
    const urlParams = new URLSearchParams(window.location.search);
    const sym = urlParams.get("symbol");
    if (sym) inpSymbol.value = sym.toUpperCase();

    // Automatically trigger initial backtest for immediate gratification!
    setTimeout(() => {
      runBacktest();
    }, 400);
  });
})();
