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
  const btnSyncLiveBotConfig = document.getElementById("btnSyncLiveBotConfig");
  const btnApplyConfigToLiveBot = document.getElementById("btnApplyConfigToLiveBot");
  const btnOpenHistory = document.getElementById("btnOpenHistory");
  const btnCloseHistoryModal = document.getElementById("btnCloseHistoryModal");
  const historyModalBackdrop = document.getElementById("historyModalBackdrop");
  const loadingOverlay = document.getElementById("loadingOverlay");
  const loadingText = document.getElementById("loadingText");
  const historyCountEl = document.getElementById("historyCount");

  // Inputs
  const inpSymbol = document.getElementById("btSymbol");
  const inpSymbolDatalist = document.getElementById("btSymbolDatalist");
  const inpTimeframe = document.getElementById("btTimeframe");
  const inpLimit = document.getElementById("btLimit");
  const inpSpread = document.getElementById("btSpread");
  const inpSlMode = document.getElementById("btSlMode");
  const inpFeeTier = document.getElementById("btFeeTier");
  const inpMacroGate = document.getElementById("btMacroGate");
  const inpCircuitBreaker = document.getElementById("btCircuitBreaker");
  const inpUpsideFloor = document.getElementById("btUpsideFloor");
  const inpFastCut = document.getElementById("btFastCut");
  const inpMaxSl = document.getElementById("btMaxSl");
  const inpTradeMode = document.getElementById("btTradeMode");
  const inpTradeDirection = document.getElementById("btTradeDirection");
  const inpBudget = document.getElementById("btBudget");

  function getSelectedSymbol() {
    if (!inpSymbol) return "BNBFDUSD";
    return (inpSymbol.value || "BNBFDUSD").trim().toUpperCase().replace(/[\/\-_:]/g, "");
  }

  function setSymbolValue(sym) {
    if (!sym || !inpSymbol) return;
    const clean = sym.toUpperCase().replace(/[\/\-_:]/g, "");
    inpSymbol.value = clean;
  }

  // Fetch dynamic symbols list from backend and populate datalist
  async function loadDynamicSymbols() {
    try {
      const res = await fetch("/api/symbols?exchange=binance");
      if (!res.ok) return;
      const data = await res.json();
      if (!inpSymbolDatalist) return;

      const fdusd = Array.isArray(data.fdusd) ? data.fdusd : [];
      const popular = Array.isArray(data.popular) ? data.popular : [];
      const usdt = Array.isArray(data.usdt) ? data.usdt : [];
      const usdc = Array.isArray(data.usdc) ? data.usdc : [];

      let html = "";
      popular.forEach((s) => {
        html += `<option value="${s}">⭐ ${s} (Popular)</option>`;
      });
      fdusd.forEach((s) => {
        if (!popular.includes(s)) {
          html += `<option value="${s}">🟡 ${s} (FDUSD 0% Fee)</option>`;
        }
      });
      usdt.forEach((s) => {
        if (!popular.includes(s)) {
          html += `<option value="${s}">💵 ${s} (USDT)</option>`;
        }
      });
      usdc.forEach((s) => {
        if (!popular.includes(s)) {
          html += `<option value="${s}">💎 ${s} (USDC)</option>`;
        }
      });

      inpSymbolDatalist.innerHTML = html;
    } catch (e) {
      console.warn("Failed to load symbols for datalist:", e);
    }
  }

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

  // Badges & Tooltip
  const elChartOrderBadgesLayer = document.getElementById("btChartOrderBadgesLayer");
  const elChartOrderTooltip = document.getElementById("btChartOrderTooltip");
  let orderBadgesData = [];
  const badgeDomPool = new Map();
  const candlesMap = new Map();

  // Candle Inspector & Spread State
  const elBtCandleInspectorCard = document.getElementById("btCandleInspectorCard");
  const elBtChartPinnedCandleMarker = document.getElementById("btChartPinnedCandleMarker");
  const elBtLegFanSpreadChip = document.getElementById("btLegFanSpreadChip");
  const elBtLegFanSpreadVal = document.getElementById("btLegFanSpreadVal");
  let btMaFanCandleDataMap = new Map();
  let btPinnedCandleTime = null;

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
      localization: {
        priceFormatter: (price) =>
          typeof price === "number" && Number.isFinite(price) ? fmtPrice(price) : "",
        timeFormatter: (time) => {
          const timestamp = typeof time === "number" ? time : (time?.timestamp || time);
          if (!timestamp) return "";
          const date = new Date(timestamp * 1000);
          const day = String(date.getDate()).padStart(2, "0");
          const month = date.toLocaleDateString(undefined, { month: "short" });
          const hours = String(date.getHours()).padStart(2, "0");
          const minutes = String(date.getMinutes()).padStart(2, "0");
          return `${day} ${month} ${hours}:${minutes}`;
        },
      },
      timeScale: {
        borderColor: "#22304d",
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (time, tickMarkType, locale) => {
          const timestamp = typeof time === "number" ? time : (time?.timestamp || time);
          if (!timestamp) return "";
          const date = new Date(timestamp * 1000);
          const hours = String(date.getHours()).padStart(2, "0");
          const minutes = String(date.getMinutes()).padStart(2, "0");
          const day = String(date.getDate()).padStart(2, "0");
          const month = String(date.getMonth() + 1).padStart(2, "0");
          if (tickMarkType === 0) return `${day}/${month}`;
          if (tickMarkType === 1) return `${day}/${month}`;
          if (tickMarkType === 2) return `${hours}:${minutes}`;
          return `${hours}:${minutes}`;
        },
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
      if (!param || !param.time || !param.seriesData) {
        if (!btPinnedCandleTime && currentRecord && currentRecord.candles && currentRecord.candles.length > 0) {
          const lastC = currentRecord.candles[currentRecord.candles.length - 1];
          updateBtMaLegendForCandle(lastC.time);
        }
        return;
      }
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

      if (param.time) {
        updateBtMaLegendForCandle(param.time);
      }
    });

    // Click to Pin / Inspect Candle & Spread (Clears previous pin if clicking another candle)
    chart.subscribeClick((param) => {
      if (!param || !param.time) {
        closeBtCandleInspector();
        return;
      }
      const clickedTime = param.time;
      if (btPinnedCandleTime === clickedTime) {
        closeBtCandleInspector();
        return;
      }
      openBtCandleInspector(clickedTime);
    });

    // Auto-resize on window resize
    window.addEventListener("resize", () => {
      if (chart && chartContainer) {
        chart.applyOptions({
          width: chartContainer.clientWidth,
          height: chartContainer.clientHeight || 520,
        });
        updateOrderBadgesPositions();
        updateBtCandleInspectorPosition();
      }
    });

    // Synchronize circular order badges and inspector with chart scroll, pan, zoom, and drag
    chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
      updateOrderBadgesPositions();
      updateBtCandleInspectorPosition();
    });
    chart.timeScale().subscribeVisibleTimeRangeChange(() => {
      updateOrderBadgesPositions();
      updateBtCandleInspectorPosition();
    });
    chartContainer.addEventListener("mousemove", (e) => {
      if (e.buttons > 0) {
        updateOrderBadgesPositions();
        updateBtCandleInspectorPosition();
      }
    });
    chartContainer.addEventListener("wheel", () => {
      requestAnimationFrame(() => {
        updateOrderBadgesPositions();
        updateBtCandleInspectorPosition();
      });
    }, { passive: true });
    chartContainer.addEventListener("mouseleave", () => {
      hideOrderTooltip();
    });
    if (window.ResizeObserver && chartContainer) {
      const ro = new ResizeObserver(() => {
        updateOrderBadgesPositions();
        updateBtCandleInspectorPosition();
      });
      ro.observe(chartContainer);
    }
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
    const spreadLabel = record.isAutoCalibrated
      ? `Spread เฉลี่ย ~${(record.spreadThreshold || 0.25).toFixed(2)}% (Causal Auto ⚡)`
      : `Spread ≥ ${(record.spreadThreshold || 0.25).toFixed(2)}%`;
    overlayInfo.textContent = `ทดสอบ ${record.candleCount} แท่ง | ${spreadLabel} | ${record.trades?.length || 0} ไม้`;

    // 2. Set Candles and EMA lines
    if (record.candles && record.candles.length > 0) {
      candleSeries.setData(record.candles);

      const hasWarmEmas = Array.isArray(record.evaluations) &&
        record.evaluations.length === record.candles.length &&
        record.evaluations[0]?.ema4 !== undefined;
      const getWarmOrCalc = (field, period) => {
        if (!hasWarmEmas) return calcEma(record.candles, period);
        return record.candles.map((c, idx) => {
          const ev = record.evaluations[idx];
          return { time: c.time, value: (ev && ev[field] !== undefined) ? ev[field] : c.close };
        });
      };
      const e4 = getWarmOrCalc("ema4", 4);
      const e8 = getWarmOrCalc("ema8", 8);
      const e16 = getWarmOrCalc("ema16", 16);
      const e25 = getWarmOrCalc("ema25", 25);
      const e75 = getWarmOrCalc("ema75", 75);
      const e200 = getWarmOrCalc("ema200", 200);

      ema4Series.setData(e4);
      ema8Series.setData(e8);
      ema16Series.setData(e16);
      ema25Series.setData(e25);
      ema75Series.setData(e75);
      ema200Series.setData(e200);

      // Populate btMaFanCandleDataMap for crosshair inspection and click inspector
      const e4Map = new Map(e4.map((x) => [x.time, x.value]));
      const e8Map = new Map(e8.map((x) => [x.time, x.value]));
      const e16Map = new Map(e16.map((x) => [x.time, x.value]));
      const e25Map = new Map(e25.map((x) => [x.time, x.value]));
      const e75Map = new Map(e75.map((x) => [x.time, x.value]));
      const e200Map = new Map(e200.map((x) => [x.time, x.value]));

      btMaFanCandleDataMap.clear();
      for (let i = 0; i < record.candles.length; i++) {
        const c = record.candles[i];
        const ev = record.evaluations ? record.evaluations[i] : null;
        const prevC = i > 0 ? record.candles[i - 1] : null;

        const range = c.high - c.low;
        const bodyBottom = Math.min(c.open, c.close);
        const lowerWick = bodyBottom - c.low;
        const lowerWickPct = range > 0 ? (lowerWick / range) * 100 : 0;

        if (ev) {
          btMaFanCandleDataMap.set(c.time, {
            time: c.time,
            candle: c,
            prevCandle: prevC,
            ema4: ev.ema4,
            ema8: ev.ema8,
            ema16: ev.ema16,
            ema25: ev.ema25,
            ema75: ev.ema75,
            ema200: ev.ema200,
            spreadPct: ev.fanSpreadPct,
            requiredSpreadPct: ev.requiredSpreadPct,
            isFanningDown: ev.isFanningDown,
            isHookUp: ev.isHookUp,
            rsi: ev.rsi,
            rsiSma: ev.rsiSma,
            isOversoldExhaustion: ev.isOversoldExhaustion,
            lowerWickPct,
          });
        } else {
          const v4 = e4Map.get(c.time);
          const v8 = e8Map.get(c.time);
          const v16 = e16Map.get(c.time);
          const v25 = e25Map.get(c.time);
          const v75 = e75Map.get(c.time);
          const v200 = e200Map.get(c.time);

          if (v4 !== undefined && v25 !== undefined) {
            const spreadPct = v25 > 0 ? (Math.abs(v25 - v4) / v25) * 100 : 0;
            const prevV4 = prevC ? e4Map.get(prevC.time) : v4;
            const prevV8 = prevC ? e8Map.get(prevC.time) : v8;
            const prevV16 = prevC ? e16Map.get(prevC.time) : v16;
            const prevV25 = prevC ? e25Map.get(prevC.time) : v25;

            const curFanningDown = v4 < v8 && v8 < v16 && v16 < v25;
            const prevFanningDown = prevV4 < prevV8 && prevV8 < prevV16 && prevV16 < prevV25;
            const isCurBullish = v4 > v8 && v8 > v16 && v16 > v25;
            const isFanningDown = !isCurBullish && v4 <= v25 && (curFanningDown || (prevFanningDown && v4 <= v16));

            const isHookUp =
              v4 <= v25 * 1.002 &&
              c.close < v25 &&
              ((v4 >= v8 && prevV4 < prevV8) || (c.close > v4 && c.close > c.open));

            btMaFanCandleDataMap.set(c.time, {
              time: c.time,
              candle: c,
              prevCandle: prevC,
              ema4: v4,
              ema8: v8,
              ema16: v16,
              ema25: v25,
              ema75: v75,
              ema200: v200,
              spreadPct,
              isFanningDown,
              isHookUp,
              rsi: 50,
              isOversoldExhaustion: true,
              lowerWickPct,
            });
          }
        }
      }

      // Latest values for legend
      const lastC = record.candles[record.candles.length - 1];
      legOhlc.textContent = `O: ${fmtPrice(lastC.open)} H: ${fmtPrice(lastC.high)} L: ${fmtPrice(lastC.low)} C: ${fmtPrice(lastC.close)}`;
      const activeTime = btPinnedCandleTime || lastC.time;
      updateBtMaLegendForCandle(activeTime);
      if (btPinnedCandleTime) updateBtCandleInspectorPosition();
    }

    // 3. Set Badges on Chart (Circular Badges with Hover Tooltips)
    candleSeries.setMarkers([]);
    buildOrderBadges(record);

    // Fit chart
    chart.timeScale().fitContent();
    setTimeout(() => {
      updateOrderBadgesPositions();
    }, 60);

    // 4. Update KPI Summary Cards
    const sum = record.summary || {};
    const netPnlPct = sum.netPnlPct ?? 0;
    kpiNetPnl.textContent = `${netPnlPct >= 0 ? "+" : ""}${netPnlPct.toFixed(2)}%`;
    kpiNetPnl.className = `kpi-val ${netPnlPct >= 0 ? "text-win" : "text-loss"}`;

    const netQuote = sum.netPnlQuote ?? 0;
    const feeSub = sum.totalFeesQuote ? ` (หัก Fee -$${sum.totalFeesQuote.toFixed(2)})` : "";
    kpiNetPnlQuote.textContent = `${netQuote >= 0 ? "+$" : "-$"}${Math.abs(netQuote).toFixed(2)}${feeSub}`;

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

  // Update in-chart legend EMA and Fan Spread chip for a specific candle
  function updateBtMaLegendForCandle(time) {
    if (!time || !btMaFanCandleDataMap.has(time)) return;
    const data = btMaFanCandleDataMap.get(time);

    if (legValEma4) legValEma4.textContent = fmtPrice(data.ema4);
    if (legValEma8) legValEma8.textContent = fmtPrice(data.ema8);
    if (legValEma16) legValEma16.textContent = fmtPrice(data.ema16);
    if (legValEma25) legValEma25.textContent = fmtPrice(data.ema25);
    if (legValEma75) legValEma75.textContent = fmtPrice(data.ema75);
    if (legValEma200) legValEma200.textContent = fmtPrice(data.ema200);

    const targetSpread = data.requiredSpreadPct || currentRecord?.spreadThreshold || 0.25;
    if (elBtLegFanSpreadChip && elBtLegFanSpreadVal) {
      if (data.spreadPct >= targetSpread) {
        elBtLegFanSpreadChip.style.background = "rgba(16, 185, 129, 0.2)";
        elBtLegFanSpreadChip.style.borderColor = "rgba(16, 185, 129, 0.5)";
        elBtLegFanSpreadChip.style.color = "#34d399";
        elBtLegFanSpreadVal.textContent = `${data.spreadPct.toFixed(2)}% (กางตึง ✅)`;
      } else {
        elBtLegFanSpreadChip.style.background = "rgba(245, 158, 11, 0.15)";
        elBtLegFanSpreadChip.style.borderColor = "rgba(245, 158, 11, 0.35)";
        elBtLegFanSpreadChip.style.color = "#fbbf24";
        elBtLegFanSpreadVal.textContent = `${data.spreadPct.toFixed(2)}% (ยังไม่ตึง ⚠️)`;
      }
    }
  }

  // Open Candle & Spread Inspector Popover for clicked candle in Backtest Studio
  function openBtCandleInspector(candleTime) {
    if (!elBtCandleInspectorCard || !chart || !candleSeries) return;
    const data = btMaFanCandleDataMap.get(candleTime);
    if (!data) return;

    btPinnedCandleTime = candleTime;
    const c = data.candle;
    const d = new Date(c.time * 1000);
    const dateStr = d.toLocaleDateString([], { month: "short", day: "numeric" });
    const timeStr = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const changePct = c.open > 0 ? ((c.close - c.open) / c.open) * 100 : 0;
    const changeColor = changePct >= 0 ? "#34d399" : "#f87171";

    const targetSpread = data.requiredSpreadPct || currentRecord?.spreadThreshold || 0.25;
    const isSpreadReady = data.spreadPct >= targetSpread;
    const spreadDiff = data.spreadPct - targetSpread;

    // 6-point Sniper conditions (Exact match with MaFanCoreRules)
    const condOrder = data.isFanningDown && data.ema4 <= data.ema25;
    const condSpread = isSpreadReady && data.ema4 <= data.ema25;
    const condHook = data.isHookUp && c.close < data.ema25 && c.close <= data.ema25 * (1 - 0.0030);
    const condExhaust = !!data.isOversoldExhaustion;
    const condAbsorption = (data.lowerWickPct || 0) >= 15;
    const isBelowMajor = (data.ema75 > 0 && c.close < data.ema75) || (data.ema200 > 0 && c.close < data.ema200);
    const condNoKnife = !isBelowMajor || !data.prevCandle || (c.low >= data.prevCandle.low);

    const allReady = condOrder && condSpread && condHook && condExhaust && condAbsorption && condNoKnife;

    let verdictHtml = "";
    if (allReady) {
      verdictHtml = `<div class="cic-verdict cic-verdict-ready">🟢 แท่งนี้เข้าเกณฑ์ Sniper ครบถ้วน! (เปิดไม้ BUY ณ ราคาปิดแท่ง $${fmtPrice(c.close)} เข้าสู่แท่งถัดไป)</div>`;
    } else {
      const missing = [];
      if (!condSpread) missing.push(data.ema4 > data.ema25 ? `พัดกางผิดทิศ (EMA4 อยู่เหนือ EMA25)` : `Spread ขาดอีก ${Math.abs(spreadDiff).toFixed(2)}%`);
      if (!condHook) missing.push(c.close >= data.ema25 * (1 - 0.0030) ? `ราคาอยู่ชิด/สูงกว่า EMA25 เกินไป (ขาด Upside Room ≥ 0.30%)` : `ปลายพัดยังไม่ม้วนตัวขึ้น (Hook Up)`);
      if (!condOrder) missing.push(`พัดยังไม่เรียงตัวขาลง`);
      if (!condNoKnife) missing.push(`อยู่ใต้เส้นใหญ่ EMA 75/200 และทำ New Low (มีดกำลังหล่น)`);
      if (!condExhaust) missing.push(`ยังไม่เข้าเกณฑ์กลับตัว (RSI ${typeof data.rsi === 'number' ? data.rsi.toFixed(1) : '--'}${data.rsiSma ? ` / SMA ${data.rsiSma.toFixed(1)}` : ''})`);
      if (!condAbsorption) missing.push(`ไส้ล่างซึมซับแรงขายต่ำเกินไป (${(data.lowerWickPct || 0).toFixed(1)}% < 15%)`);
      verdictHtml = `<div class="cic-verdict cic-verdict-wait">⚠️ แท่งนี้ยังไม่เข้าเกณฑ์: ${missing.join(", ")}</div>`;
    }

    elBtCandleInspectorCard.innerHTML = `
      <div class="cic-header">
        <span class="cic-title">🔬 ตรวจวัดแท่งเทียน (Candle & Spread)</span>
        <button class="cic-close-btn" onclick="window.closeBtCandleInspector()" title="ปิดหน้าต่าง">✖</button>
      </div>

      <div class="cic-section">
        <div class="cic-row">
          <span class="cic-label">เวลาแท่งเทียน:</span>
          <span class="cic-val" style="color: #cbd5e1;">${dateStr} ${timeStr}</span>
        </div>
        <div class="cic-row">
          <span class="cic-label">ราคา OHLC:</span>
          <span class="cic-val">
            <span style="color:#94a3b8;">O</span> $${fmtPrice(c.open)} 
            <span style="color:#94a3b8;">H</span> $${fmtPrice(c.high)}<br/>
            <span style="color:#94a3b8;">L</span> $${fmtPrice(c.low)} 
            <span style="color:${changeColor};">C $${fmtPrice(c.close)} (${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%)</span>
          </span>
        </div>
        <div class="cic-row">
          <span class="cic-label">ไส้ล่าง (Lower Wick):</span>
          <span class="cic-val" style="color: ${(data.lowerWickPct || 0) >= 15 ? "#34d399" : "#cbd5e1"};">${(data.lowerWickPct || 0).toFixed(1)}% ${(data.lowerWickPct || 0) >= 15 ? "✅ (ซึมซับดี ≥15%)" : "⚠️ (เสี่ยง Waterfall)"}</span>
        </div>
      </div>

      <div class="cic-spread-box">
        <div class="cic-spread-row">
          <span class="cic-label" style="font-weight:700; color:#cbd5e1;">ความกว้างพัด (Spread %):</span>
          <span class="cic-spread-val" style="color: ${isSpreadReady ? "#34d399" : "#fbbf24"};">
            ${data.spreadPct.toFixed(2)}%
          </span>
        </div>
        <div class="cic-spread-row" style="margin-top: 2px; font-size: 10px;">
          <span style="color:#94a3b8;">เกณฑ์ขั้นต่ำ: ≥ ${targetSpread.toFixed(2)}%</span>
          <span style="color:${isSpreadReady ? "#34d399" : "#fbbf24"};">
            ${isSpreadReady ? `✅ เกินเกณฑ์ (+${spreadDiff.toFixed(2)}%)` : `⚠️ ขาดอีก ${Math.abs(spreadDiff).toFixed(2)}%`}
          </span>
        </div>
      </div>

      <div class="cic-section">
        <div class="cic-row">
          <span class="cic-label">EMA 4 / EMA 8:</span>
          <span class="cic-val">$${fmtPrice(data.ema4)} / $${fmtPrice(data.ema8)}</span>
        </div>
        <div class="cic-row">
          <span class="cic-label">EMA 16 / EMA 25:</span>
          <span class="cic-val">$${fmtPrice(data.ema16)} / $${fmtPrice(data.ema25)}</span>
        </div>
        <div class="cic-row">
          <span class="cic-label">EMA 75 / EMA 200:</span>
          <span class="cic-val">$${fmtPrice(data.ema75)} / $${fmtPrice(data.ema200)}</span>
        </div>
      </div>

      <div class="cic-checklist">
        <div class="cic-check-item">
          <span>1. พัดเรียงตัวขาลง (EMA 4 < 8 < 16 < 25)</span>
          <span style="color: ${condOrder ? "#34d399" : "#f87171"}; font-weight:700;">${condOrder ? "✅ ผ่าน" : "❌ ไม่ผ่าน"}</span>
        </div>
        <div class="cic-check-item">
          <span>2. พัดกางตึง (Spread ≥ ${targetSpread.toFixed(2)}%)</span>
          <span style="color: ${condSpread ? "#34d399" : "#f87171"}; font-weight:700;">${condSpread ? "✅ ผ่าน" : "❌ ไม่ผ่าน"}</span>
        </div>
        <div class="cic-check-item">
          <span>3. ปลายพัดม้วนตัวกลับ (Hook Up)</span>
          <span style="color: ${condHook ? "#34d399" : "#f87171"}; font-weight:700;">${condHook ? "✅ ผ่าน" : "⏳ ไม่ม้วน"}</span>
        </div>
        <div class="cic-check-item">
          <span>4. ภาวะหมดแรงเทขาย (Oversold Exhaustion)</span>
          <span style="color: ${condExhaust ? "#34d399" : "#f87171"}; font-weight:700;">${condExhaust ? `✅ ผ่าน (RSI ${typeof data.rsi === 'number' ? data.rsi.toFixed(1) : '--'})` : `⏳ รอขายหมด (RSI ${typeof data.rsi === 'number' ? data.rsi.toFixed(1) : '--'})`}</span>
        </div>
        <div class="cic-check-item">
          <span>5. แรงซึมซับไส้ล่าง (Lower Wick ≥ 15%)</span>
          <span style="color: ${condAbsorption ? "#34d399" : "#f87171"}; font-weight:700;">${condAbsorption ? `✅ ผ่าน (${(data.lowerWickPct || 0).toFixed(1)}%)` : `❌ ไม่ผ่าน (${(data.lowerWickPct || 0).toFixed(1)}%)`}</span>
        </div>
      </div>

      ${verdictHtml}
    `;

    elBtCandleInspectorCard.classList.add("active");
    if (elBtChartPinnedCandleMarker) elBtChartPinnedCandleMarker.classList.add("active");

    updateBtCandleInspectorPosition();
    updateBtMaLegendForCandle(candleTime);
  }

  function closeBtCandleInspector() {
    btPinnedCandleTime = null;
    if (elBtCandleInspectorCard) {
      elBtCandleInspectorCard.classList.remove("active");
      elBtCandleInspectorCard.style.display = "none";
    }
    if (elBtChartPinnedCandleMarker) {
      elBtChartPinnedCandleMarker.classList.remove("active");
      elBtChartPinnedCandleMarker.style.display = "none";
    }
    if (currentRecord && currentRecord.candles && currentRecord.candles.length > 0) {
      const lastC = currentRecord.candles[currentRecord.candles.length - 1];
      updateBtMaLegendForCandle(lastC.time);
    }
  }
  window.closeBtCandleInspector = closeBtCandleInspector;

  function updateBtCandleInspectorPosition() {
    if (!btPinnedCandleTime || !elBtCandleInspectorCard || !chart || !chartContainer) {
      if (elBtCandleInspectorCard) {
        elBtCandleInspectorCard.classList.remove("active");
        elBtCandleInspectorCard.style.display = "none";
      }
      if (elBtChartPinnedCandleMarker) {
        elBtChartPinnedCandleMarker.classList.remove("active");
        elBtChartPinnedCandleMarker.style.display = "none";
      }
      return;
    }
    const x = chart.timeScale().timeToCoordinate(btPinnedCandleTime);
    if (x === null || x < -50 || x > chartContainer.clientWidth + 50) {
      elBtCandleInspectorCard.style.display = "none";
      if (elBtChartPinnedCandleMarker) elBtChartPinnedCandleMarker.style.display = "none";
      return;
    }

    elBtCandleInspectorCard.style.display = "block";
    if (elBtChartPinnedCandleMarker) {
      elBtChartPinnedCandleMarker.style.display = "block";
      elBtChartPinnedCandleMarker.style.left = `${Math.round(x)}px`;
    }

    const cardWidth = elBtCandleInspectorCard.offsetWidth || 300;
    const cardHeight = elBtCandleInspectorCard.offsetHeight || 340;
    const chartW = chartContainer.clientWidth;
    const chartH = chartContainer.clientHeight;

    let left = x + 16;
    if (left + cardWidth > chartW - 60) {
      left = x - cardWidth - 16;
    }
    if (left < 10) left = 10;

    let top = 60;
    if (top + cardHeight > chartH - 10) {
      top = Math.max(10, chartH - cardHeight - 10);
    }

    elBtCandleInspectorCard.style.left = `${Math.round(left)}px`;
    elBtCandleInspectorCard.style.top = `${Math.round(top)}px`;
  }

  // Build and render circular order badges on chart overlay layer
  function buildOrderBadges(record) {
    if (!elChartOrderBadgesLayer) return;
    elChartOrderBadgesLayer.innerHTML = "";
    badgeDomPool.clear();
    orderBadgesData = [];

    if (!record || !record.trades || !record.candles) return;

    candlesMap.clear();
    for (const c of record.candles) {
      candlesMap.set(c.time, c);
    }

    // High trade volume guard (> 80 trades): Use Lightweight Charts native canvas markers (GPU accelerated, 60fps, zero DOM lag)
    if (record.trades.length > 80) {
      const canvasMarkers = [];
      for (const t of record.trades) {
        const isShort = t.side === "SHORT";
        const isGrid = t.subsystem === "GRID" || t.exitType === "GRID_TP" || t.exitType === "GRID_CUT";

        canvasMarkers.push({
          time: t.entryTime,
          position: isShort ? "aboveBar" : "belowBar",
          color: isGrid ? "#10b981" : (isShort ? "#ef4444" : "#f59e0b"),
          shape: isShort ? "arrowDown" : "arrowUp",
          text: isGrid ? `🕸️ B #${t.id}` : (isShort ? `🎯 S #${t.id}` : `🎯 B #${t.id}`),
        });

        // TP1 Marker (Sniper Only!)
        if (!isGrid && t.tp1Time && t.tp1Price) {
          canvasMarkers.push({
            time: t.tp1Time,
            position: isShort ? "belowBar" : "aboveBar",
            color: "#06b6d4",
            shape: "circle",
            text: `🎯 TP1`,
          });
        }

        if (t.exitTime) {
          const isWin = t.pnlPct >= 0;
          let exitText = "";
          let exitColor = isWin ? "#8b5cf6" : "#ef4444";
          let exitShape = isWin ? "arrowDown" : "square";

          if (isGrid) {
            exitColor = isWin ? "#3b82f6" : "#ef4444";
            exitText = isWin ? `🕸️ TP (+${t.pnlPct.toFixed(1)}%)` : `🕸️ CUT (${t.pnlPct.toFixed(1)}%)`;
          } else {
            exitText = t.exitType === "TP1+TP2" ? `🎯 TP2 (+${t.pnlPct.toFixed(1)}%)` : `🎯 ${t.exitType} (${t.pnlPct.toFixed(1)}%)`;
          }

          canvasMarkers.push({
            time: t.exitTime,
            position: isShort ? (isWin ? "belowBar" : "aboveBar") : (isWin ? "aboveBar" : "belowBar"),
            color: exitColor,
            shape: exitShape,
            text: exitText,
          });
        }
      }
      canvasMarkers.sort((a, b) => a.time - b.time);
      candleSeries.setMarkers(canvasMarkers);
      orderBadgesData = [];
      elChartOrderBadgesLayer.innerHTML = "";
      return;
    }

    const items = [];

    for (const t of record.trades) {
      const isShort = t.side === "SHORT";
      const isGrid = t.subsystem === "GRID" || t.exitType === "GRID_TP" || t.exitType === "GRID_CUT";

      // 1. Entry Badge (B for Long, S for Short)
      items.push({
        tradeId: t.id,
        action: isShort ? "SHORT" : "BUY",
        text: isGrid ? "B" : (isShort ? "S" : "B"),
        time: t.entryTime,
        price: t.entryPrice,
        cssClass: isShort ? "badge-sell" : "badge-buy",
        badgeType: isShort ? "SHORT" : "BUY",
        trade: t,
      });

      // 2. TP1 Badge (Sniper Only!)
      if (!isGrid && t.tp1Time && t.tp1Price) {
        items.push({
          tradeId: t.id,
          action: "TP1",
          text: "TP1",
          time: t.tp1Time,
          price: t.tp1Price,
          cssClass: "badge-tp1",
          badgeType: "TP1",
          trade: t,
        });
      }

      // 3. Exit Badge
      if (t.exitType === "GRID_TP") {
        items.push({
          tradeId: t.id,
          action: "GRID_TP",
          text: "TP",
          time: t.exitTime,
          price: t.exitPrice,
          cssClass: "badge-tp2",
          badgeType: "GRID_TP",
          trade: t,
        });
      } else if (t.exitType === "GRID_CUT") {
        items.push({
          tradeId: t.id,
          action: "GRID_CUT",
          text: "CUT",
          time: t.exitTime,
          price: t.exitPrice,
          cssClass: "badge-sl-fixed",
          badgeType: "GRID_CUT",
          trade: t,
        });
      } else if (t.exitType === "TP1+TP2") {
        items.push({
          tradeId: t.id,
          action: "TP2",
          text: "TP2",
          time: t.tp2Time || t.exitTime,
          price: t.tp2Price || t.exitPrice,
          cssClass: "badge-tp2",
          badgeType: "TP2",
          trade: t,
        });
      } else if (t.exitType === "TP1+SL_BE") {
        items.push({
          tradeId: t.id,
          action: "SL_BE",
          text: "SL",
          time: t.exitTime,
          price: t.exitPrice,
          cssClass: "badge-sl-be",
          badgeType: "SL_BE",
          trade: t,
        });
      } else if (t.exitType === "RATCHET_SL") {
        items.push({
          tradeId: t.id,
          action: "RATCHET_SL",
          text: "SL",
          time: t.exitTime,
          price: t.exitPrice,
          cssClass: "badge-sl-ratchet",
          badgeType: "RATCHET_SL",
          trade: t,
        });
      } else if (t.exitType === "SL") {
        items.push({
          tradeId: t.id,
          action: "SL",
          text: "SL",
          time: t.exitTime,
          price: t.exitPrice,
          cssClass: "badge-sl-fixed",
          badgeType: "SL",
          trade: t,
        });
      } else if (t.exitType === "TECH_FAST_CUT") {
        items.push({
          tradeId: t.id,
          action: "TECH_FAST_CUT",
          text: "CUT",
          time: t.exitTime,
          price: t.exitPrice,
          cssClass: "badge-sl-ratchet",
          badgeType: "TECH_FAST_CUT",
          trade: t,
        });
      }
      // Note: for "OPEN" and "TP1+OPEN" trades, entry badge B (and TP1 if filled) are already added above
    }

    orderBadgesData = items;

    // Create DOM element for each badge
    for (const item of orderBadgesData) {
      const key = `${item.tradeId}_${item.action}_${item.time}`;
      const el = document.createElement("div");
      el.className = `chart-order-badge ${item.cssClass}`;
      el.textContent = item.text;

      // Tooltip triggers
      el.addEventListener("mouseenter", (e) => {
        showOrderTooltip(item, e);
      });
      el.addEventListener("mouseleave", () => {
        hideOrderTooltip();
      });

      // Click: Highlight trade in table
      el.addEventListener("click", () => {
        highlightTradeRow(item.tradeId);
      });

      elChartOrderBadgesLayer.appendChild(el);
      badgeDomPool.set(key, el);
    }

    updateOrderBadgesPositions();
  }

  // Update badge positions on pan/zoom/resize
  function updateOrderBadgesPositions() {
    if (!chart || !candleSeries || !elChartOrderBadgesLayer || orderBadgesData.length === 0) return;

    const chartWidth = chartContainer.clientWidth;
    const chartHeight = chartContainer.clientHeight;

    for (const item of orderBadgesData) {
      const key = `${item.tradeId}_${item.action}_${item.time}`;
      const el = badgeDomPool.get(key);
      if (!el) continue;

      const x = chart.timeScale().timeToCoordinate(item.time);
      if (x === null || x < -25 || x > chartWidth + 25) {
        el.style.display = "none";
        continue;
      }

      const candle = candlesMap.get(item.time);
      const isBelow = item.action === "BUY" || item.action === "SL" || item.action === "RATCHET_SL" || item.action === "SL_BE" || item.action === "TECH_FAST_CUT";

      let refPrice = item.price;
      if (candle) {
        refPrice = isBelow ? candle.low : candle.high;
      }

      const yCoord = candleSeries.priceToCoordinate(refPrice);
      if (yCoord === null || yCoord < -30 || yCoord > chartHeight + 30) {
        el.style.display = "none";
        continue;
      }

      const y = isBelow ? yCoord + 14 : yCoord - 14;

      el.style.left = `${Math.round(x)}px`;
      el.style.top = `${Math.round(y)}px`;
      el.style.display = "flex";
    }
  }

  // Show hover tooltip with trade details
  function showOrderTooltip(item, e) {
    if (!elChartOrderTooltip || !chartContainer) return;
    const t = item.trade;
    const rect = chartContainer.getBoundingClientRect();

    let actionTitle = "";
    let actionColor = "#10b981";
    let bodyHtml = "";

    if (item.action === "BUY") {
      const isOpen = t.exitType?.includes("OPEN");
      actionTitle = isOpen ? `🟢 เข้าซื้อ (BUY) ไม้ #${t.id} [กำลังถือ]` : `🟢 เข้าซื้อ (BUY) ไม้ #${t.id}`;
      actionColor = "#10b981";
      bodyHtml = `
        <div class="cot-row"><span class="cot-label">ราคาเข้า (ราคาปิดแท่ง):</span><span class="cot-val" style="color: #34d399;">$${fmtPrice(t.entryPrice)}</span></div>
        <div class="cot-row"><span class="cot-label">Fan Spread ตอนเข้า:</span><span class="cot-val">${t.fanSpreadAtEntry ? t.fanSpreadAtEntry.toFixed(2) + "%" : "--"}</span></div>
        <div class="cot-row"><span class="cot-label">Stop Loss:</span><span class="cot-val" style="color: #f87171;">$${fmtPrice(t.stopLossPrice)}</span></div>
        <div class="cot-row"><span class="cot-label">แท่งสัญญาณ (Confirmed):</span><span class="cot-val">${fmtDateTime(t.entryTime)} (ปิดแท่งสมบูรณ์)</span></div>
        ${isOpen ? `<div class="cot-row"><span class="cot-label">สถานะปัจจุบัน:</span><span class="cot-val" style="color: #34d399; font-weight:700;">🟢 กำลังถือ Position (${t.holdingBars} แท่ง, PnL: ${t.pnlPct >= 0 ? "+" : ""}${t.pnlPct.toFixed(2)}%)</span></div>` : ""}
      `;
    } else if (item.action === "TP1") {
      actionTitle = `🔵 ขาย TP1 50% (EMA 25) ไม้ #${t.id}`;
      actionColor = "#38bdf8";
      const pnlPct = t.tp1PnlPct ?? (((t.tp1Price - t.entryPrice) / t.entryPrice) * 100);
      bodyHtml = `
        <div class="cot-row"><span class="cot-label">ราคาขาย (TP1):</span><span class="cot-val" style="color: #38bdf8;">$${fmtPrice(t.tp1Price)}</span></div>
        <div class="cot-row"><span class="cot-label">กำไรส่วน TP1:</span><span class="cot-val text-win">+${pnlPct.toFixed(2)}%</span></div>
        <div class="cot-row"><span class="cot-label">สถานะ SL:</span><span class="cot-val" style="color: #fbbf24;">ขยับเป็น Breakeven ($${fmtPrice(t.entryPrice * 1.0005)})</span></div>
        <div class="cot-row"><span class="cot-label">เวลา TP1:</span><span class="cot-val">${fmtDateTime(t.tp1Time)}</span></div>
      `;
    } else if (item.action === "TP2") {
      actionTitle = `🟣 ขาย TP2 เต็มรอบ (EMA 75/200) ไม้ #${t.id}`;
      actionColor = "#a855f7";
      const pnlPct = t.tp2PnlPct ?? (((t.exitPrice - t.entryPrice) / t.entryPrice) * 100);
      bodyHtml = `
        <div class="cot-row"><span class="cot-label">ราคาขาย (TP2):</span><span class="cot-val" style="color: #c084fc;">$${fmtPrice(t.exitPrice)}</span></div>
        <div class="cot-row"><span class="cot-label">กำไรไม้รัน (TP2):</span><span class="cot-val text-win">+${pnlPct.toFixed(2)}%</span></div>
        <div class="cot-row"><span class="cot-label">กำไรสุทธิทั้งรอบ:</span><span class="cot-val text-win">+${t.pnlPct.toFixed(2)}% (+$${Math.abs(t.pnlQuote).toFixed(2)})</span></div>
        <div class="cot-row"><span class="cot-label">ระยะเวลาถือ:</span><span class="cot-val">${t.holdingBars} แท่ง (~${t.holdingBars * 5} นาที)</span></div>
        <div class="cot-row"><span class="cot-label">เวลาปิดรอบ:</span><span class="cot-val">${fmtDateTime(t.exitTime)}</span></div>
      `;
    } else if (item.action === "SL_BE") {
      actionTitle = `🟡 ปิดรอบ SL Breakeven ไม้ #${t.id}`;
      actionColor = "#f59e0b";
      bodyHtml = `
        <div class="cot-row"><span class="cot-label">ราคาปิด (SL BE):</span><span class="cot-val" style="color: #fbbf24;">$${fmtPrice(t.exitPrice)}</span></div>
        <div class="cot-row"><span class="cot-label">ผลลัพธ์รอบนี้:</span><span class="cot-val text-win">+${t.pnlPct.toFixed(2)}% (กำไรจาก TP1 50%)</span></div>
        <div class="cot-row"><span class="cot-label">กำไรสุทธิ:</span><span class="cot-val text-win">+$${Math.abs(t.pnlQuote).toFixed(2)}</span></div>
        <div class="cot-row"><span class="cot-label">ระยะเวลาถือ:</span><span class="cot-val">${t.holdingBars} แท่ง (~${t.holdingBars * 5} นาที)</span></div>
        <div class="cot-row"><span class="cot-label">เวลาปิดไม้:</span><span class="cot-val">${fmtDateTime(t.exitTime)}</span></div>
      `;
    } else if (item.action === "RATCHET_SL") {
      actionTitle = `🟠 Ratchet SL ยกฐานตัดขาดทุน ไม้ #${t.id}`;
      actionColor = "#f97316";
      bodyHtml = `
        <div class="cot-row"><span class="cot-label">ราคาตัดขาดทุน:</span><span class="cot-val" style="color: #fb923c;">$${fmtPrice(t.exitPrice)}</span></div>
        <div class="cot-row"><span class="cot-label">ขาดทุนสุทธิ:</span><span class="cot-val text-loss">${t.pnlPct.toFixed(2)}% (-$${Math.abs(t.pnlQuote).toFixed(2)})</span></div>
        <div class="cot-row"><span class="cot-label">กลยุทธ์:</span><span class="cot-val" style="color: #fed7aa;">ยกฐานหนีตามแท่งเทียน ช่วยลดการลากยาว</span></div>
        <div class="cot-row"><span class="cot-label">ระยะเวลาถือ:</span><span class="cot-val">${t.holdingBars} แท่ง (~${t.holdingBars * 5} นาที)</span></div>
        <div class="cot-row"><span class="cot-label">เวลาตัดขาดทุน:</span><span class="cot-val">${fmtDateTime(t.exitTime)}</span></div>
      `;
    } else {
      actionTitle = `🔴 ตัดขาดทุนก้นเหว (Fixed SL) ไม้ #${t.id}`;
      actionColor = "#ef4444";
      bodyHtml = `
        <div class="cot-row"><span class="cot-label">ราคาตัดขาดทุน:</span><span class="cot-val" style="color: #f87171;">$${fmtPrice(t.exitPrice)}</span></div>
        <div class="cot-row"><span class="cot-label">ขาดทุนสุทธิ:</span><span class="cot-val text-loss">${t.pnlPct.toFixed(2)}% (-$${Math.abs(t.pnlQuote).toFixed(2)})</span></div>
        <div class="cot-row"><span class="cot-label">ระยะเวลาถือ:</span><span class="cot-val">${t.holdingBars} แท่ง (~${t.holdingBars * 5} นาที)</span></div>
        <div class="cot-row"><span class="cot-label">เวลาตัดขาดทุน:</span><span class="cot-val">${fmtDateTime(t.exitTime)}</span></div>
      `;
    }

    elChartOrderTooltip.innerHTML = `
      <div class="cot-title" style="color: ${actionColor};">
        <span>${actionTitle}</span>
      </div>
      ${bodyHtml}
    `;

    const relX = e.clientX - rect.left;
    const relY = e.clientY - rect.top;

    let left = relX + 16;
    let top = relY - 40;

    const tooltipWidth = 260;
    const tooltipHeight = 160;

    if (left + tooltipWidth > chartContainer.clientWidth - 10) {
      left = relX - tooltipWidth - 16;
    }
    if (top < 10) {
      top = 10;
    }
    if (top + tooltipHeight > chartContainer.clientHeight - 10) {
      top = chartContainer.clientHeight - tooltipHeight - 10;
    }

    elChartOrderTooltip.style.left = `${Math.round(left)}px`;
    elChartOrderTooltip.style.top = `${Math.round(top)}px`;
    elChartOrderTooltip.classList.add("active");
  }

  function hideOrderTooltip() {
    if (elChartOrderTooltip) {
      elChartOrderTooltip.classList.remove("active");
    }
  }

  function highlightTradeRow(tradeId) {
    const row = tradesTableBody.querySelector(`tr[data-trade-id="${tradeId}"]`);
    if (row) {
      row.scrollIntoView({ behavior: "smooth", block: "nearest" });
      row.style.backgroundColor = "rgba(99, 102, 241, 0.25)";
      setTimeout(() => {
        row.style.backgroundColor = "";
      }, 1500);
    }
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
      tradesTableBody.innerHTML = `<tr><td colspan="10" class="td-empty">ไม่พบรายการไม้เทรดในหมวดนี้</td></tr>`;
      return;
    }

    const maxInitial = 80;
    const shouldSlice = filtered.length > maxInitial;
    const displayTrades = shouldSlice ? filtered.slice(0, maxInitial) : filtered;

    function renderRows(list) {
      return list.map((t) => {
        const isWin = t.pnlPct >= 0;
        const isGrid = t.subsystem === "GRID" || t.exitType === "GRID_TP" || t.exitType === "GRID_CUT";
        const sysBadge = isGrid
          ? `<div style="display:inline-block; padding: 1px 5px; border-radius: 4px; font-size: 10px; font-weight: 700; background: rgba(59, 130, 246, 0.2); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.4); margin-top: 3px;">🕸️ GRID</div>`
          : `<div style="display:inline-block; padding: 1px 5px; border-radius: 4px; font-size: 10px; font-weight: 700; background: rgba(245, 158, 11, 0.2); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.4); margin-top: 3px;">🎯 SNIPER</div>`;

        let badgeClass = "badge-sl-loss";
        let badgeLabel = "SL (Loss)";
        if (t.exitType === "GRID_TP") {
          badgeClass = "badge-tp-full";
          badgeLabel = "🕸️ Grid TP";
        } else if (t.exitType === "GRID_CUT") {
          badgeClass = "badge-sl-loss";
          badgeLabel = "🕸️ Grid Cut";
        } else if (t.exitType === "TP1+TP2") {
          badgeClass = "badge-tp-full";
          badgeLabel = "🎯 TP1 + TP2";
        } else if (t.exitType === "TP1+SL_BE") {
          badgeClass = "badge-tp-be";
          badgeLabel = "🎯 TP1 + SL BE";
        } else if (t.exitType === "RATCHET_SL") {
          badgeClass = "badge-ratchet-sl";
          badgeLabel = "🎯 Ratchet SL";
        } else if (t.exitType === "TECH_FAST_CUT") {
          badgeClass = "badge-ratchet-sl";
          badgeLabel = "⚡ Fast Cut";
        } else if (t.exitType === "SL") {
          badgeClass = "badge-sl-loss";
          badgeLabel = "🎯 Stop Loss";
        } else if (t.exitType === "OPEN") {
          badgeClass = "badge-open";
          badgeLabel = isGrid ? "🕸️ ถือค้าง (GRID)" : "🟢 ถือค้าง (OPEN)";
        } else if (t.exitType === "TP1+OPEN") {
          badgeClass = "badge-open-tp1";
          badgeLabel = "🔵 TP1 + ถือต่อ";
        }

        const isStillOpen = t.exitType?.includes("OPEN");

        return `
          <tr data-trade-id="${t.id}" data-entry-time="${t.entryTime}" data-exit-time="${t.exitTime}">
            <td>
              <div style="font-weight: 700;">#${t.id}</div>
              ${sysBadge}
            </td>
            <td>
              ${t.side === "SHORT"
                ? '<span style="display:inline-block; padding: 1px 4px; border-radius: 3px; font-size: 10px; font-weight: 700; background: rgba(239, 68, 68, 0.2); color: #f87171; margin-right: 4px;">SHORT</span>'
                : '<span style="display:inline-block; padding: 1px 4px; border-radius: 3px; font-size: 10px; font-weight: 700; background: rgba(16, 185, 129, 0.2); color: #34d399; margin-right: 4px;">LONG</span>'}
              <span style="color: ${t.side === "SHORT" ? "#f87171" : "#34d399"};">$${fmtPrice(t.entryPrice)}</span>
              <div style="font-size: 10px; color: #94a3b8;">${fmtDateTime(t.entryTime)}</div>
            </td>
            <td>${t.fanSpreadAtEntry ? t.fanSpreadAtEntry.toFixed(2) + "%" : "--"}</td>
            <td>
              <span>$${fmtPrice(t.exitPrice)}</span>
              <div style="font-size: 10px; color: ${isStillOpen ? "#34d399" : "#94a3b8"};">
                ${isStillOpen ? "(ราคาปัจจุบัน)" : fmtDateTime(t.exitTime)}
              </div>
            </td>
            <td><span class="badge-exit ${badgeClass}">${badgeLabel}</span></td>
            <td>${t.holdingBars} แท่ง</td>
            <td class="${isWin ? "text-win" : "text-loss"}" style="font-weight: 700;">
              ${isWin ? "+" : ""}${t.pnlPct.toFixed(2)}%
            </td>
            <td class="${isWin ? "text-win" : "text-loss"}">
              ${isWin ? "+$" : "-$"}${Math.abs(t.pnlQuote).toFixed(2)}
            </td>
            <td style="color: #94a3b8; font-size: 11px;">
              ${t.costQuote ? "-$" + t.costQuote.toFixed(2) : "$0.00"}
            </td>
            <td>
              <button class="btn-zoom" data-trade-id="${t.id}">🔍 ซูมดูกราฟ</button>
            </td>
          </tr>
        `;
      }).join("");
    }

    let tableHtml = renderRows(displayTrades);
    if (shouldSlice) {
      tableHtml += `
        <tr id="rowLoadMoreTrades">
          <td colspan="10" style="text-align: center; padding: 12px; cursor: pointer; color: #38bdf8; font-weight: 600; background: rgba(56, 189, 248, 0.08); border-top: 1px dashed rgba(56, 189, 248, 0.3);">
            ⬇️ แสดงไม้เทรดเพิ่มเติมอีก ${filtered.length - maxInitial} ไม้ (กดที่นี่)
          </td>
        </tr>
      `;
    }
    tradesTableBody.innerHTML = tableHtml;

    const rowMore = document.getElementById("rowLoadMoreTrades");
    if (rowMore) {
      rowMore.addEventListener("click", () => {
        tradesTableBody.innerHTML = renderRows(filtered);
        bindRowClickEvents();
      });
    }

    function bindRowClickEvents() {
      tradesTableBody.querySelectorAll("tr[data-entry-time]").forEach((row) => {
        row.addEventListener("click", () => {
          const entryTime = Number(row.getAttribute("data-entry-time"));
          const exitTime = Number(row.getAttribute("data-exit-time"));
          zoomToTrade(entryTime, exitTime);
        });
      });
    }

    bindRowClickEvents();
  }

  // Zoom chart to a specific trade
  function zoomToTrade(entryTime, exitTime) {
    if (!chart || !entryTime) return;
    const paddingSec = 3600 * 3; // 3 hours padding
    const fromTime = entryTime - paddingSec;
    const toTime = (exitTime || entryTime) + paddingSec;

    try {
      chart.timeScale().setVisibleRange({ from: fromTime, to: toTime });
      setTimeout(() => updateOrderBadgesPositions(), 50);
    } catch (e) {
      console.warn("Could not set visible range:", e);
    }
  }

  // Run Backtest Trigger
  async function runBacktest() {
    const symbol = getSelectedSymbol();
    const timeframe = inpTimeframe.value;
    const limit = Number(inpLimit.value) || 1000;
    const spreadThreshold = inpSpread.value === "auto" ? "auto" : Number(inpSpread.value);
    const budget = Number(inpBudget.value) || 200;
    const useRatchetSl = inpSlMode ? inpSlMode.value === "ratchet" : true;
    const feeTier = inpFeeTier ? inpFeeTier.value : "bnb";
    const macroGateMode = inpMacroGate ? inpMacroGate.value : "off";
    const enableCircuitBreaker = inpCircuitBreaker ? inpCircuitBreaker.value === "on" : true;
    const enableUpsideFloor = inpUpsideFloor ? inpUpsideFloor.value === "on" : true;
    const enableFastCut = inpFastCut ? inpFastCut.value === "on" : true;
    const maxSlPct = inpMaxSl ? Number(inpMaxSl.value) : 1.80;
    const tradeMode = inpTradeMode ? inpTradeMode.value : "dip_hunter";
    const tradeDirection = inpTradeDirection ? inpTradeDirection.value : "long";

    const dayEstimate = limit >= 34000 ? "~120 วัน" : (limit >= 25000 ? "~90 วัน" : (limit >= 17000 ? "~60 วัน" : (limit >= 8000 ? "~30 วัน" : (limit >= 4000 ? "~15 วัน" : (limit >= 2000 ? "~7 วัน" : (limit >= 1000 ? "~3.5 วัน" : "~1.7 วัน"))))));
    loadingOverlay.style.display = "flex";
    loadingText.textContent = `กำลังดึง ${limit.toLocaleString()} แท่ง (${dayEstimate}) ของ ${symbol} และรันจำลอง MA Fan Sniper (${tradeMode} / ${tradeDirection})...`;

    try {
      const resp = await fetch("/api/backtest/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol,
          timeframe,
          limit,
          spreadThreshold,
          budget,
          useRatchetSl,
          feeTier,
          macroGateMode,
          enableCircuitBreaker,
          enableUpsideFloor,
          enableFastCut,
          maxSlPct,
          tradeMode,
          tradeDirection,
        }),
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
                <span class="hist-date">${new Date(h.createdAt).toLocaleString("th-TH")} | Spread ${h.isAutoCalibrated ? "เฉลี่ย ~" : "≥ "}${(h.spreadThreshold || 0.25).toFixed(2)}%${h.isAutoCalibrated ? " (Auto ⚡)" : ""}</span>
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
      setSymbolValue(data.record.symbol || "BNBFDUSD");
      inpTimeframe.value = data.record.timeframe || "5m";
      inpSpread.value = String(data.record.spreadThreshold || "0.25");
      if (inpSlMode && data.record.useRatchetSl !== undefined) {
        inpSlMode.value = data.record.useRatchetSl ? "ratchet" : "fixed";
      }

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

  // Synchronize Live Bot Configuration to Forms (Main & Scanner)
  async function syncLiveBotConfigToForms(target = "both", triggerBtn = null) {
    try {
      if (triggerBtn) {
        triggerBtn.disabled = true;
        triggerBtn.innerHTML = `<span>⏳ กำลังดึงค่า...</span>`;
      }

      const res = await fetch("/api/config");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const cfg = await res.json();

      // 1. Sync to Main Form
      if (target === "main" || target === "both") {
        if (cfg.symbol) setSymbolValue(cfg.symbol);
        if (inpTimeframe && cfg.maFanExecutionTimeframe) inpTimeframe.value = cfg.maFanExecutionTimeframe;
        if (inpSpread) {
          inpSpread.value = cfg.maFanAutoCalibrateSpreadOnSwitch !== false ? "auto" : String(cfg.maFanManualSpreadPct || 0.25);
        }
        if (inpBudget && cfg.maFanMaxBudgetUsd) inpBudget.value = String(cfg.maFanMaxBudgetUsd);
        if (inpSlMode) inpSlMode.value = cfg.maFanUseRatchetSl !== false ? "ratchet" : "fixed";
        if (inpCircuitBreaker) inpCircuitBreaker.value = cfg.maFanCircuitBreaker !== false ? "on" : "off";
        if (inpUpsideFloor) inpUpsideFloor.value = cfg.maFanUpsideFloor !== false ? "on" : "off";
        if (inpMacroGate && cfg.maFanMacroGate) inpMacroGate.value = cfg.maFanMacroGate;
        if (inpTradeMode && cfg.maFanTradeMode) inpTradeMode.value = cfg.maFanTradeMode;
        if (inpTradeDirection && cfg.maFanTradeDirection) inpTradeDirection.value = cfg.maFanTradeDirection;
        if (inpFastCut) inpFastCut.value = "on";
        if (inpMaxSl) inpMaxSl.value = "1.8";
        if (inpFeeTier) {
          inpFeeTier.value = (cfg.symbol && cfg.symbol.endsWith("FDUSD")) ? "zero" : "bnb";
        }
      }

      // 2. Sync to Market Scanner
      if (target === "scanner" || target === "both") {
        if (scTimeframe && cfg.maFanExecutionTimeframe) scTimeframe.value = cfg.maFanExecutionTimeframe;
        if (scSpread) {
          scSpread.value = cfg.maFanAutoCalibrateSpreadOnSwitch !== false ? "auto" : String(cfg.maFanManualSpreadPct || 0.25);
        }
        if (scSlMode) scSlMode.value = cfg.maFanUseRatchetSl !== false ? "ratchet" : "fixed";
        if (scCircuitBreaker) scCircuitBreaker.value = cfg.maFanCircuitBreaker !== false ? "on" : "off";
        if (scUpsideFloor) scUpsideFloor.value = cfg.maFanUpsideFloor !== false ? "on" : "off";
        if (scMacroGate && cfg.maFanMacroGate) scMacroGate.value = cfg.maFanMacroGate;
        if (scTradeMode && cfg.maFanTradeMode) scTradeMode.value = cfg.maFanTradeMode;
        if (scTradeDirection && cfg.maFanTradeDirection) scTradeDirection.value = cfg.maFanTradeDirection;
        if (scFastCut) scFastCut.value = "on";
        if (scMaxSl) scMaxSl.value = "1.8";
      }

      if (triggerBtn) {
        triggerBtn.innerHTML = `<span>✅ ซิงค์สำเร็จ!</span>`;
        setTimeout(() => {
          triggerBtn.disabled = false;
          triggerBtn.innerHTML = `<span class="btn-run-icon">🔄</span> ${target === "scanner" ? "ใช้ Config บอท" : "ใช้ Config เดียวกับบอท"}`;
        }, 1500);
      }
      return cfg;
    } catch (err) {
      alert(`❌ ไม่สามารถดึงคอนฟิกจากบอทได้: ${err.message}`);
      if (triggerBtn) {
        triggerBtn.disabled = false;
        triggerBtn.innerHTML = `<span class="btn-run-icon">🔄</span> ${target === "scanner" ? "ใช้ Config บอท" : "ใช้ Config เดียวกับบอท"}`;
      }
    }
  }

  // Apply Backtest Form Settings directly to Live Bot
  async function applyBacktestConfigToLiveBot() {
    const symbol = getSelectedSymbol();
    const timeframe = inpTimeframe ? inpTimeframe.value : "5m";
    const spreadVal = inpSpread ? inpSpread.value : "auto";
    const isAutoSpread = spreadVal === "auto";
    const budget = inpBudget ? Number(inpBudget.value) || 200 : 200;
    const useRatchetSl = inpSlMode ? inpSlMode.value === "ratchet" : true;
    const enableCircuitBreaker = inpCircuitBreaker ? inpCircuitBreaker.value === "on" : true;
    const enableUpsideFloor = inpUpsideFloor ? inpUpsideFloor.value === "on" : true;
    const macroGateMode = inpMacroGate ? inpMacroGate.value : "off";

    const summaryMsg = `ยืนยันการนำ Config จาก Backtest ไปใช้กับบอทจริงหรือไม่?\n\n` +
      `• คู่เหรียญ: ${symbol}\n` +
      `• Timeframe: ${timeframe}\n` +
      `• Min Spread: ${isAutoSpread ? "Auto Calibrate ⚡" : `${spreadVal}%`}\n` +
      `• SL Mode: ${useRatchetSl ? "Ratchet SL (ยกตามฐาน)" : "Fixed SL"}\n` +
      `• Circuit Breaker: ${enableCircuitBreaker ? "On (SL 2 ไม้ติด พัก 45m)" : "Off"}\n` +
      `• Upside Floor: ${enableUpsideFloor ? "On (≥ 0.45% to EMA25)" : "Off"}\n` +
      `• Macro Gate: ${macroGateMode === "noDeepBear" ? "No Deep Bear" : macroGateMode === "bullOnly" ? "Bull Only" : "Off"}\n` +
      `• เงินทุนสูงสุด: $${budget}\n\n` +
      `บอทจริงจะบันทึกและสลับไปใช้คอนฟิกนี้ทันที!`;

    if (!confirm(summaryMsg)) return;

    if (btnApplyConfigToLiveBot) {
      btnApplyConfigToLiveBot.disabled = true;
      btnApplyConfigToLiveBot.innerHTML = `<span>⏳ กำลังบันทึก...</span>`;
    }

    try {
      const payload = {
        symbol,
        maFanExecutionTimeframe: timeframe,
        maFanAutoCalibrateSpreadOnSwitch: isAutoSpread,
        ...(isAutoSpread ? {} : { maFanManualSpreadPct: Number(spreadVal) }),
        maFanMaxBudgetUsd: budget,
        maFanUseRatchetSl: useRatchetSl,
        maFanCircuitBreaker: enableCircuitBreaker,
        maFanUpsideFloor: enableUpsideFloor,
        maFanMacroGate: macroGateMode,
      };

      const res = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }

      alert(`✅ นำ Config จาก Backtest ไปปรับใช้กับบอทจริง (${symbol} ${timeframe}) เรียบร้อยแล้ว!`);
    } catch (err) {
      alert(`❌ ไม่สามารถส่ง Config ไปยังบอทจริงได้: ${err.message}`);
    } finally {
      if (btnApplyConfigToLiveBot) {
        btnApplyConfigToLiveBot.disabled = false;
        btnApplyConfigToLiveBot.innerHTML = `<span class="btn-run-icon">📤</span> ส่งไปใช้กับบอทจริง`;
      }
    }
  }

  // Apply optimal best-known presets for the selected engine
  function applyOptimalPreset(engine = "dual_hybrid", target = "both") {
    // 1. Main Backtest Form
    if (target === "main" || target === "both") {
      if (inpTradeMode) inpTradeMode.value = engine;
      if (inpTimeframe) inpTimeframe.value = "5m";
      if (inpSpread) inpSpread.value = "0.50";
      if (inpSlMode) inpSlMode.value = "ratchet";
      if (inpMacroGate) inpMacroGate.value = "noDeepBear";
      if (inpCircuitBreaker) inpCircuitBreaker.value = "on";
      if (inpUpsideFloor) inpUpsideFloor.value = "on";
      if (inpFastCut) inpFastCut.value = "on";
      if (inpMaxSl) inpMaxSl.value = "1.8";
      if (inpTradeDirection) inpTradeDirection.value = "long";
      if (inpFeeTier) inpFeeTier.value = "bnb";
      if (inpBudget && (!inpBudget.value || Number(inpBudget.value) < 100)) inpBudget.value = "100";
    }

    // 2. Market Scanner Form
    if (target === "scanner" || target === "both") {
      if (scTradeMode) scTradeMode.value = engine;
      if (scTimeframe) scTimeframe.value = "5m";
      if (scSpread) scSpread.value = "0.50";
      if (scSlMode) scSlMode.value = "ratchet";
      if (scMacroGate) scMacroGate.value = "noDeepBear";
      if (scCircuitBreaker) scCircuitBreaker.value = "on";
      if (scUpsideFloor) scUpsideFloor.value = "on";
      if (scFastCut) scFastCut.value = "on";
      if (scMaxSl) scMaxSl.value = "1.8";
      if (scTradeDirection) scTradeDirection.value = "long";
    }
  }

  // Initialize event handlers
  function initEvents() {
    btnRunBacktest.addEventListener("click", runBacktest);

    // Auto-tune optimal preset on engine dropdown change
    if (inpTradeMode) {
      inpTradeMode.addEventListener("change", (e) => {
        applyOptimalPreset(e.target.value, "main");
      });
    }

    const btnResetBestPreset = document.getElementById("btnResetBestPreset");
    if (btnResetBestPreset) {
      btnResetBestPreset.addEventListener("click", () => {
        const currentEngine = inpTradeMode ? inpTradeMode.value : "dual_hybrid";
        applyOptimalPreset(currentEngine, "main");
        btnResetBestPreset.innerHTML = `<span>⚡ คืนค่าแล้ว!</span>`;
        setTimeout(() => {
          btnResetBestPreset.innerHTML = `<span class="btn-run-icon">⚡</span> ค่าแนะนำ (Best)`;
        }, 1200);
      });
    }

    if (btnSyncLiveBotConfig) {
      btnSyncLiveBotConfig.addEventListener("click", () => {
        syncLiveBotConfigToForms("main", btnSyncLiveBotConfig);
      });
    }

    if (btnApplyConfigToLiveBot) {
      btnApplyConfigToLiveBot.addEventListener("click", applyBacktestConfigToLiveBot);
    }

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

    initScannerEvents();
  }

  // ─── Scanner Modal & Logic ────────────────────────────────────────────────────────
  const btnOpenScanner = document.getElementById("btnOpenScanner");
  const scannerModalBackdrop = document.getElementById("scannerModalBackdrop");
  const btnCloseScannerModal = document.getElementById("btnCloseScannerModal");
  const btnStartScan = document.getElementById("btnStartScan");
  const btnScannerSyncLiveConfig = document.getElementById("btnScannerSyncLiveConfig");
  const scannerProgressWrap = document.getElementById("scannerProgressWrap");
  const scannerStatusText = document.getElementById("scannerStatusText");
  const scannerCountText = document.getElementById("scannerCountText");
  const scannerTableBody = document.getElementById("scannerTableBody");

  const scScope = document.getElementById("scScope");
  const scTimeframe = document.getElementById("scTimeframe");
  const scLimit = document.getElementById("scLimit");
  const scSpread = document.getElementById("scSpread");
  const scUpsideFloor = document.getElementById("scUpsideFloor");
  const scFastCut = document.getElementById("scFastCut");
  const scMaxSl = document.getElementById("scMaxSl");
  const scCircuitBreaker = document.getElementById("scCircuitBreaker");
  const scSlMode = document.getElementById("scSlMode");
  const scMacroGate = document.getElementById("scMacroGate");
  const scTradeMode = document.getElementById("scTradeMode");
  const scTradeDirection = document.getElementById("scTradeDirection");

  function initScannerEvents() {
    loadLatestScannerResults();

    if (btnOpenScanner && scannerModalBackdrop) {
      btnOpenScanner.addEventListener("click", () => {
        scannerModalBackdrop.style.display = "flex";
        loadLatestScannerResults();
      });
    }

    if (btnCloseScannerModal && scannerModalBackdrop) {
      btnCloseScannerModal.addEventListener("click", () => {
        scannerModalBackdrop.style.display = "none";
      });
    }

    if (scannerModalBackdrop) {
      scannerModalBackdrop.addEventListener("click", (e) => {
        if (e.target === scannerModalBackdrop) {
          scannerModalBackdrop.style.display = "none";
        }
      });
    }

    if (btnScannerSyncLiveConfig) {
      btnScannerSyncLiveConfig.addEventListener("click", () => {
        syncLiveBotConfigToForms("scanner", btnScannerSyncLiveConfig);
      });
    }

    // Auto-tune optimal preset on scanner engine dropdown change
    if (scTradeMode) {
      scTradeMode.addEventListener("change", (e) => {
        applyOptimalPreset(e.target.value, "scanner");
      });
    }

    const btnScannerResetBestPreset = document.getElementById("btnScannerResetBestPreset");
    if (btnScannerResetBestPreset) {
      btnScannerResetBestPreset.addEventListener("click", () => {
        const currentEngine = scTradeMode ? scTradeMode.value : "dual_hybrid";
        applyOptimalPreset(currentEngine, "scanner");
        btnScannerResetBestPreset.innerHTML = `<span>⚡ คืนค่าแล้ว!</span>`;
        setTimeout(() => {
          btnScannerResetBestPreset.innerHTML = `<span class="btn-run-icon">⚡</span> ค่าแนะนำ`;
        }, 1200);
      });
    }

    if (btnStartScan) {
      btnStartScan.addEventListener("click", async () => {
        const scope = scScope?.value || "top20";
        const timeframe = scTimeframe?.value || "5m";
        const limit = Number(scLimit?.value) || 1000;
        const spread = scSpread?.value || "auto";
        const budget = Number(inpBudget?.value) || 200;
        const useRatchetSl = scSlMode ? scSlMode.value === "ratchet" : (inpSlMode ? inpSlMode.value === "ratchet" : true);
        const feeTier = inpFeeTier ? inpFeeTier.value : "bnb";
        const macroGateMode = scMacroGate ? scMacroGate.value : (inpMacroGate ? inpMacroGate.value : "off");
        const enableCircuitBreaker = scCircuitBreaker ? scCircuitBreaker.value === "on" : (inpCircuitBreaker ? inpCircuitBreaker.value === "on" : true);
        const enableUpsideFloor = scUpsideFloor ? scUpsideFloor.value === "on" : (inpUpsideFloor ? inpUpsideFloor.value === "on" : true);
        const enableFastCut = scFastCut ? scFastCut.value === "on" : (inpFastCut ? inpFastCut.value === "on" : true);
        const maxSlPct = scMaxSl ? Number(scMaxSl.value) : (inpMaxSl ? Number(inpMaxSl.value) : 1.80);
        const tradeMode = scTradeMode ? scTradeMode.value : (inpTradeMode ? inpTradeMode.value : "dip_hunter");
        const tradeDirection = scTradeDirection ? scTradeDirection.value : (inpTradeDirection ? inpTradeDirection.value : "long");

        btnStartScan.disabled = true;
        if (scannerProgressWrap) scannerProgressWrap.style.display = "block";
        const scopeLabel = scope === "top100" ? "Top 100 USDT" : scope === "top50" ? "Top 50 USDT" : scope === "top20" ? "Top 20 USDT" : scope.toUpperCase();
        const dayEstimate = limit >= 34000 ? "~120 วัน" : (limit >= 25000 ? "~90 วัน" : (limit >= 17000 ? "~60 วัน" : (limit >= 8000 ? "~30 วัน" : (limit >= 4000 ? "~15 วัน" : (limit >= 2000 ? "~7 วัน" : (limit >= 1000 ? "~3.5 วัน" : "~1.7 วัน"))))));
        if (scannerStatusText) scannerStatusText.textContent = `กำลังสแกนเหรียญ Binance (${scopeLabel}) บน ${timeframe} ย้อนหลัง ${limit.toLocaleString()} แท่ง (${dayEstimate})...`;
        if (scannerCountText) scannerCountText.textContent = "กำลังดาวน์โหลดแท่งเทียนและประมวลผล MA Fan Sniper แบบคู่ขนาน...";

        try {
          const res = await fetch("/api/backtest/scan", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              scope,
              timeframe,
              limit,
              spreadThreshold: spread,
              budget,
              useRatchetSl,
              feeTier,
              macroGateMode,
              enableCircuitBreaker,
              enableUpsideFloor,
              enableFastCut,
              maxSlPct,
              tradeMode,
              tradeDirection,
            }),
          });

          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || `HTTP ${res.status}`);
          }

          const data = await res.json();
          renderScannerLeaderboard(data.results || []);
          if (scannerStatusText) {
            scannerStatusText.textContent = `สแกนตลาดเสร็จสมบูรณ์ (${data.results?.length || 0} คู่เหรียญ)`;
          }
        } catch (err) {
          alert(`เกิดข้อผิดพลาดในการสแกนตลาด: ${err.message}`);
        } finally {
          btnStartScan.disabled = false;
          if (scannerProgressWrap) scannerProgressWrap.style.display = "none";
        }
      });
    }
  }

  async function loadLatestScannerResults() {
    try {
      const res = await fetch("/api/backtest/scan/latest");
      if (res.ok) {
        const data = await res.json();
        if (data.scan && Array.isArray(data.scan.results) && data.scan.results.length > 0) {
          renderScannerLeaderboard(data.scan.results);
          if (scannerStatusText) {
            const dateStr = new Date(data.scan.timestamp).toLocaleString();
            scannerStatusText.textContent = `ผลสแกนล่าสุดที่บันทึกไว้ (${dateStr})`;
          }
          if (data.scan.options) {
            const o = data.scan.options;
            if (scScope && o.scope) scScope.value = o.scope;
            if (scTimeframe && o.timeframe) scTimeframe.value = o.timeframe;
            if (scLimit && o.limit) scLimit.value = String(o.limit);
            if (scSpread && o.spreadThreshold !== undefined) scSpread.value = String(o.spreadThreshold);
            if (scUpsideFloor && o.enableUpsideFloor !== undefined) scUpsideFloor.value = o.enableUpsideFloor ? "on" : "off";
            if (scFastCut && o.enableFastCut !== undefined) scFastCut.value = o.enableFastCut ? "on" : "off";
            if (scMaxSl && o.maxSlPct !== undefined) scMaxSl.value = String(o.maxSlPct);
            if (scCircuitBreaker && o.enableCircuitBreaker !== undefined) scCircuitBreaker.value = o.enableCircuitBreaker ? "on" : "off";
            if (scSlMode && o.useRatchetSl !== undefined) scSlMode.value = o.useRatchetSl ? "ratchet" : "fixed";
            if (scMacroGate && o.macroGateMode) scMacroGate.value = o.macroGateMode;
            if (scTradeMode && o.tradeMode) scTradeMode.value = o.tradeMode;
            if (scTradeDirection && o.tradeDirection) scTradeDirection.value = o.tradeDirection;
          }
        }
      }
    } catch {}
  }

  function renderScannerLeaderboard(items) {
    if (!scannerTableBody) return;
    if (!items || items.length === 0) {
      scannerTableBody.innerHTML = `<tr><td colspan="10" class="td-empty">ไม่พบเหรียญที่เข้าเงื่อนไขหรือเกิดข้อผิดพลาดในการดึงข้อมูล</td></tr>`;
      return;
    }

    let html = "";
    items.forEach((item, idx) => {
      const rank = item.rank || idx + 1;
      const rankClass = rank === 1 ? "rank-1" : rank === 2 ? "rank-2" : rank === 3 ? "rank-3" : "";
      const rankBadge = `<span class="rank-badge ${rankClass}">${rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : rank}</span>`;

      const volStr = item.quoteVolume >= 1_000_000
        ? `$${(item.quoteVolume / 1_000_000).toFixed(1)}M`
        : `$${(item.quoteVolume / 1_000).toFixed(0)}k`;

      const pnlClass = item.netPnlPct > 0 ? "text-profit" : item.netPnlPct < 0 ? "text-loss" : "";
      const pnlSign = item.netPnlPct > 0 ? "+" : "";

      html += `
        <tr>
          <td style="text-align: center;">${rankBadge}</td>
          <td><b>${item.symbol}</b></td>
          <td><span style="font-family: var(--font-mono); color: var(--text-muted);">${volStr}</span></td>
          <td class="${pnlClass}" style="font-weight: 700; font-family: var(--font-mono);">${pnlSign}${item.netPnlPct.toFixed(2)}%</td>
          <td style="font-weight: 600;">${item.winRate.toFixed(1)}% <span style="font-size: 10.5px; color: var(--text-muted);">(${item.winTrades}W/${item.lossTrades}L)</span></td>
          <td>${item.tradesCount} ไม้</td>
          <td style="font-family: var(--font-mono);">${item.profitFactor.toFixed(2)}</td>
          <td class="text-loss" style="font-family: var(--font-mono);">${item.maxDrawdownPct.toFixed(2)}%</td>
          <td class="text-profit" style="font-family: var(--font-mono);">+${item.bestTradePct.toFixed(2)}%</td>
          <td>
            <button class="btn-action-view" data-sym="${item.symbol}" title="ดูกราฟและผลเทรดเหรียญนี้ทันที">📊 ดูกราฟ</button>
            <button class="btn-action-trade" data-sym="${item.symbol}" title="สลับบอทจริงไปเทรดเหรียญนี้">⚡ สลับบอท</button>
          </td>
        </tr>
      `;
    });

    scannerTableBody.innerHTML = html;

    // Attach row button events
    scannerTableBody.querySelectorAll(".btn-action-view").forEach((btn) => {
      btn.addEventListener("click", () => {
        const sym = btn.getAttribute("data-sym");
        if (sym) {
          setSymbolValue(sym);
          if (scTimeframe && inpTimeframe) inpTimeframe.value = scTimeframe.value;
          if (scLimit && inpLimit) inpLimit.value = scLimit.value;
          if (scSpread && inpSpread) inpSpread.value = scSpread.value;
          if (scUpsideFloor && inpUpsideFloor) inpUpsideFloor.value = scUpsideFloor.value;
          if (scFastCut && inpFastCut) inpFastCut.value = scFastCut.value;
          if (scMaxSl && inpMaxSl) inpMaxSl.value = scMaxSl.value;
          if (scCircuitBreaker && inpCircuitBreaker) inpCircuitBreaker.value = scCircuitBreaker.value;
          if (scSlMode && inpSlMode) inpSlMode.value = scSlMode.value;
          if (scMacroGate && inpMacroGate) inpMacroGate.value = scMacroGate.value;
          if (scTradeMode && inpTradeMode) inpTradeMode.value = scTradeMode.value;
          if (scTradeDirection && inpTradeDirection) inpTradeDirection.value = scTradeDirection.value;
          if (scannerModalBackdrop) scannerModalBackdrop.style.display = "none";
          runBacktest();
        }
      });
    });

    scannerTableBody.querySelectorAll(".btn-action-trade").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const sym = btn.getAttribute("data-sym");
        if (!sym) return;

        const timeframe = scTimeframe ? scTimeframe.value : "5m";
        const spreadVal = scSpread ? scSpread.value : "auto";
        const isAutoSpread = spreadVal === "auto";
        const useRatchetSl = scSlMode ? scSlMode.value === "ratchet" : true;
        const enableCircuitBreaker = scCircuitBreaker ? scCircuitBreaker.value === "on" : true;
        const enableUpsideFloor = scUpsideFloor ? scUpsideFloor.value === "on" : true;
        const macroGateMode = scMacroGate ? scMacroGate.value : "off";
        const tradeMode = scTradeMode ? scTradeMode.value : "dip_hunter";
        const tradeDirection = scTradeDirection ? scTradeDirection.value : "long";

        const confirmMsg = `ต้องการสลับบอทจริงไปเทรด ${sym} พร้อมนำ Config ที่สแกนไปใช้งานหรือไม่?\n\n` +
          `• คู่เหรียญ: ${sym}\n` +
          `• Timeframe: ${timeframe}\n` +
          `• Min Spread: ${isAutoSpread ? "Auto Calibrate ⚡" : `${spreadVal}%`}\n` +
          `• Engine: ${tradeMode}\n` +
          `• Direction: ${tradeDirection}\n` +
          `• SL Mode: ${useRatchetSl ? "Ratchet SL" : "Fixed SL"}\n` +
          `• Circuit Breaker: ${enableCircuitBreaker ? "On" : "Off"}\n` +
          `• Upside Floor: ${enableUpsideFloor ? "On" : "Off"}\n` +
          `• Macro Gate: ${macroGateMode}`;

        if (!confirm(confirmMsg)) return;

        btn.disabled = true;
        btn.textContent = "⏳ กำลังสลับ...";
        try {
          const payload = {
            symbol: sym,
            maFanExecutionTimeframe: timeframe,
            maFanAutoCalibrateSpreadOnSwitch: isAutoSpread,
            ...(isAutoSpread ? {} : { maFanManualSpreadPct: Number(spreadVal) }),
            maFanUseRatchetSl: useRatchetSl,
            maFanCircuitBreaker: enableCircuitBreaker,
            maFanUpsideFloor: enableUpsideFloor,
            maFanMacroGate: macroGateMode,
            maFanTradeMode: tradeMode,
            maFanTradeDirection: tradeDirection,
          };

          const res = await fetch("/api/config", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          if (res.ok) {
            alert(`✅ สลับคู่เทรดของบอทจริงเป็น ${sym} พร้อมอัปเดต Config ที่สแกนเรียบร้อยแล้ว!`);
          } else {
            const err = await res.json().catch(() => ({}));
            alert(`❌ ไม่สามารถสลับคู่เหรียญได้: ${err.error || "เกิดข้อผิดพลาด"}`);
          }
        } catch (e) {
          alert(`❌ เกิดข้อผิดพลาด: ${e.message}`);
        } finally {
          btn.disabled = false;
          btn.textContent = "⚡ สลับบอท";
        }
      });
    });
  }

  // Bootstrap
  document.addEventListener("DOMContentLoaded", () => {
    initChart();
    initEvents();
    applyOptimalPreset("dual_hybrid", "both");
    loadHistoryList();
    loadDynamicSymbols();

    // Check if query params exist (e.g. symbol from live bot)
    const urlParams = new URLSearchParams(window.location.search);
    const sym = urlParams.get("symbol");
    if (sym) {
      setSymbolValue(sym);
    }

    // Always pre-fill settings from active live bot configuration
    fetch("/api/config")
      .then((r) => r.json())
      .then((cfg) => {
        if (!cfg) return;
        if (!sym && cfg.symbol) {
          setSymbolValue(cfg.symbol);
        }
        if (inpBudget && (cfg.maFanMaxBudgetUsd || cfg.budget)) {
          inpBudget.value = cfg.maFanMaxBudgetUsd || cfg.budget;
        }
        if (inpTimeframe && cfg.maFanExecutionTimeframe) {
          inpTimeframe.value = cfg.maFanExecutionTimeframe;
        }
        if (inpSpread) {
          if (cfg.maFanAutoCalibrateSpreadOnSwitch) {
            inpSpread.value = "auto";
          } else if (cfg.maFanManualSpreadPct !== undefined) {
            const spreadStr = String(cfg.maFanManualSpreadPct);
            let hasOption = false;
            for (let i = 0; i < inpSpread.options.length; i++) {
              if (inpSpread.options[i].value === spreadStr) {
                hasOption = true;
                break;
              }
            }
            if (!hasOption) {
              const opt = document.createElement("option");
              opt.value = spreadStr;
              opt.textContent = `🎯 ${spreadStr}% (จากบอทจริง)`;
              inpSpread.appendChild(opt);
            }
            inpSpread.value = spreadStr;
          }
        }
        if (inpSlMode && cfg.maFanUseRatchetSl !== undefined) {
          inpSlMode.value = cfg.maFanUseRatchetSl ? "ratchet" : "fixed";
        }
      })
      .catch(() => {});

    // Do NOT automatically run backtest on page load; wait for user to click "Run Backtest"
  });
})();
