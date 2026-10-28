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
  const inpSymbolDatalist = document.getElementById("btSymbolDatalist");
  const inpTimeframe = document.getElementById("btTimeframe");
  const inpLimit = document.getElementById("btLimit");
  const inpSpread = document.getElementById("btSpread");
  const inpSlMode = document.getElementById("btSlMode");
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
            isFanningDown: ev.isFanningDown,
            isHookUp: ev.isHookUp,
            rsi: ev.rsi,
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

    const targetSpread = currentRecord?.spreadThreshold || 0.25;
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

    const targetSpread = currentRecord?.spreadThreshold || 0.25;
    const isSpreadReady = data.spreadPct >= targetSpread;
    const spreadDiff = data.spreadPct - targetSpread;

    // 4-point Sniper conditions (Exact match with MaFanCoreRules)
    const condOrder = data.isFanningDown && data.ema4 <= data.ema25;
    const condSpread = isSpreadReady && data.ema4 <= data.ema25;
    const condHook = data.isHookUp && c.close < data.ema25;
    const condExhaust = !!data.isOversoldExhaustion;

    const allReady = condOrder && condSpread && condHook && condExhaust;

    let verdictHtml = "";
    if (allReady) {
      verdictHtml = `<div class="cic-verdict cic-verdict-ready">🟢 แท่งนี้เข้าเกณฑ์ Sniper ครบ 4 ข้อ! (จังหวะเปิดไม้ BUY)</div>`;
    } else {
      const missing = [];
      if (!condSpread) missing.push(data.ema4 > data.ema25 ? `พัดกางผิดทิศ (EMA4 อยู่เหนือ EMA25)` : `Spread ขาดอีก ${Math.abs(spreadDiff).toFixed(2)}%`);
      if (!condHook) missing.push(c.close >= data.ema25 ? `ราคาปิดอยู่สูงกว่า EMA25 (หลุดโซนย่อ)` : `ปลายพัดยังไม่ม้วนตัวขึ้น (Hook Up)`);
      if (!condOrder) missing.push(`พัดยังไม่เรียงตัวขาลง`);
      if (!condExhaust) missing.push(`ยังไม่เข้าโซนขายหมดแรง (RSI ${typeof data.rsi === 'number' ? data.rsi.toFixed(1) : '--'} > 45)`);
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
          <span class="cic-val" style="color: ${data.lowerWickPct >= 35 ? "#34d399" : "#cbd5e1"};">${data.lowerWickPct.toFixed(1)}% ${data.lowerWickPct >= 35 ? "✅ (เด้งดี)" : ""}</span>
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

    const items = [];

    for (const t of record.trades) {
      // 1. Entry Badge (B)
      items.push({
        tradeId: t.id,
        action: "BUY",
        text: "B",
        time: t.entryTime,
        price: t.entryPrice,
        cssClass: "badge-buy",
        badgeType: "BUY",
        trade: t,
      });

      // 2. TP1 Badge (TP1) if hit
      if (t.tp1Time && t.tp1Price) {
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

      // 3. Exit Badge (TP2, SL_BE, RATCHET_SL, SL)
      if (t.exitType === "TP1+TP2") {
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
      } else {
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
      }
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
      const isBelow = item.action === "BUY" || item.action === "SL" || item.action === "RATCHET_SL" || item.action === "SL_BE";

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
      actionTitle = `🟢 เข้าซื้อ (BUY) ไม้ #${t.id}`;
      actionColor = "#10b981";
      bodyHtml = `
        <div class="cot-row"><span class="cot-label">ราคาเข้า (Entry):</span><span class="cot-val" style="color: #34d399;">$${fmtPrice(t.entryPrice)}</span></div>
        <div class="cot-row"><span class="cot-label">Fan Spread ตอนเข้า:</span><span class="cot-val">${t.fanSpreadAtEntry ? t.fanSpreadAtEntry.toFixed(2) + "%" : "--"}</span></div>
        <div class="cot-row"><span class="cot-label">Stop Loss เริ่มต้น:</span><span class="cot-val" style="color: #f87171;">$${fmtPrice(t.stopLossPrice)}</span></div>
        <div class="cot-row"><span class="cot-label">เวลาเปิดไม้:</span><span class="cot-val">${fmtDateTime(t.entryTime)}</span></div>
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
        } else if (t.exitType === "RATCHET_SL") {
          badgeClass = "badge-ratchet-sl";
          badgeLabel = "🛡️ Ratchet SL";
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

    loadingOverlay.style.display = "flex";
    loadingText.textContent = `กำลังดึง ${limit} แท่งเทียนของ ${symbol} และรันจำลอง MA Fan Sniper (${useRatchetSl ? "Ratchet SL" : "Fixed SL"})...`;

    try {
      const resp = await fetch("/api/backtest/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, timeframe, limit, spreadThreshold, budget, useRatchetSl }),
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

    initScannerEvents();
  }

  // ─── Scanner Modal & Logic ────────────────────────────────────────────────────────
  const btnOpenScanner = document.getElementById("btnOpenScanner");
  const scannerModalBackdrop = document.getElementById("scannerModalBackdrop");
  const btnCloseScannerModal = document.getElementById("btnCloseScannerModal");
  const btnStartScan = document.getElementById("btnStartScan");
  const scannerProgressWrap = document.getElementById("scannerProgressWrap");
  const scannerStatusText = document.getElementById("scannerStatusText");
  const scannerCountText = document.getElementById("scannerCountText");
  const scannerTableBody = document.getElementById("scannerTableBody");

  const scScope = document.getElementById("scScope");
  const scTimeframe = document.getElementById("scTimeframe");
  const scLimit = document.getElementById("scLimit");
  const scSpread = document.getElementById("scSpread");

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

    if (btnStartScan) {
      btnStartScan.addEventListener("click", async () => {
        const scope = scScope?.value || "top20";
        const timeframe = scTimeframe?.value || "5m";
        const limit = Number(scLimit?.value) || 500;
        const spread = scSpread?.value || "auto";

        btnStartScan.disabled = true;
        if (scannerProgressWrap) scannerProgressWrap.style.display = "block";
        if (scannerStatusText) scannerStatusText.textContent = `กำลังสแกนเหรียญ Binance (${scope.toUpperCase()}) บน ${timeframe}...`;
        if (scannerCountText) scannerCountText.textContent = "ประมวลผลกลยุทธ์ MA Fan Sniper แบบคู่ขนาน...";

        try {
          const res = await fetch("/api/backtest/scan", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ scope, timeframe, limit, spreadThreshold: spread }),
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
            if (scScope && data.scan.options.scope) scScope.value = data.scan.options.scope;
            if (scTimeframe && data.scan.options.timeframe) scTimeframe.value = data.scan.options.timeframe;
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
          if (scannerModalBackdrop) scannerModalBackdrop.style.display = "none";
          runBacktest();
        }
      });
    });

    scannerTableBody.querySelectorAll(".btn-action-trade").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const sym = btn.getAttribute("data-sym");
        if (!sym) return;
        if (!confirm(`ต้องการสลับคู่เทรดของบอทจริงเป็น ${sym} หรือไม่?`)) return;

        btn.disabled = true;
        btn.textContent = "⏳ กำลังสลับ...";
        try {
          const res = await fetch("/api/db/settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ symbol: sym }),
          });
          if (res.ok) {
            alert(`✅ สลับคู่เทรดของบอทจริงเป็น ${sym} เรียบร้อยแล้ว!`);
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
    loadHistoryList();
    loadDynamicSymbols();

    // Check if query params exist (e.g. symbol from live bot)
    const urlParams = new URLSearchParams(window.location.search);
    const sym = urlParams.get("symbol");
    if (sym) setSymbolValue(sym);

    // Automatically trigger initial backtest for immediate gratification!
    setTimeout(() => {
      runBacktest();
    }, 400);
  });
})();
