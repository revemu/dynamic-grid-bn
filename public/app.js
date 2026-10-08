/**
 * Channel Grid & Dow Market Structure Dashboard Client
 * Configured with:
 * - 0% Lower Bound (Support / Floor): Cut Loss / Stop Loss
 * - 0% to 50% Buy Zone: Stepped accumulation
 * - 50% Center: Equilibrium neutral line
 * - 50% to 100% Sell Zone: Stepped profit taking
 * - 100% Upper Bound (Resistance / Ceiling): 100% Full Take-Profit exit
 *
 * Full 6-decimal precision and human-readable percentages (no obscure terms).
 */

(function () {
  // ── DOM Elements ───────────────────────────────────────────────────────────
  const elConnectionStatus = document.getElementById("connectionStatus");
  const elConnectionText = document.getElementById("connectionText");
  const elNavSymbolBadge = document.getElementById("navSymbolBadge");
  const elChartSymbolBadge = document.getElementById("chartSymbolBadge");
  const elLegendSymbol = document.getElementById("legendSymbol");
  const elLegendTf = document.getElementById("legendTf");
  const elLegendLivePrice = document.getElementById("legendLivePrice");
  const elLegendO = document.getElementById("legendO");
  const elLegendH = document.getElementById("legendH");
  const elLegendL = document.getElementById("legendL");
  const elLegendC = document.getElementById("legendC");
  const elLegendChange = document.getElementById("legendChange");
  const elTimeframeBadge = document.getElementById("timeframeBadge");
  const elChartTimeframeSub = document.getElementById("chartTimeframeSub");
  const elZoneStatusBadge = document.getElementById("zoneStatusBadge");
  const elRegimeBadge = document.getElementById("regimeBadge");
  const elDryRunBadge = document.getElementById("dryRunBadge");
  const elTickSpeedText = document.getElementById("tickSpeedText");

  // Bot Status & Waiting Reason Banner Elements
  const elBotStatusBanner = document.getElementById("botStatusBanner");
  const elBannerStatusPill = document.getElementById("bannerStatusPill");
  const elBannerStatusTitle = document.getElementById("bannerStatusTitle");
  const elBannerReasonText = document.getElementById("bannerReasonText");
  const elBannerTriggerText = document.getElementById("bannerTriggerText");

  const elMidPrice = document.getElementById("midPrice");
  const elAnchorPrice = document.getElementById("anchorPrice");
  const elSpreadBpsBadge = document.getElementById("spreadBpsBadge");

  // Vertical Ladder Meter Elements
  const elLadderZoneBadge = document.getElementById("ladderZoneBadge");
  const elLadderCurrentLevel = document.getElementById("ladderCurrentLevel");
  const elLadderTargetAlloc = document.getElementById("ladderTargetAlloc");

  const elStepCeil = document.getElementById("stepCeil");
  const elStepSell4 = document.getElementById("stepSell4");
  const elStepSell3 = document.getElementById("stepSell3");
  const elStepSell2 = document.getElementById("stepSell2");
  const elStepSell1 = document.getElementById("stepSell1");
  const elStepCenter = document.getElementById("stepCenter");
  const elStepBuy1 = document.getElementById("stepBuy1");
  const elStepBuy2 = document.getElementById("stepBuy2");
  const elStepBuy3 = document.getElementById("stepBuy3");
  const elStepBuy4 = document.getElementById("stepBuy4");
  const elStepBuffer = document.getElementById("stepBuffer");
  const elStepFloor = document.getElementById("stepFloor");

  const elStepPriceCeil = document.getElementById("stepPriceCeil");
  const elStepPriceSell4 = document.getElementById("stepPriceSell4");
  const elStepPriceSell3 = document.getElementById("stepPriceSell3");
  const elStepPriceSell2 = document.getElementById("stepPriceSell2");
  const elStepPriceSell1 = document.getElementById("stepPriceSell1");
  const elStepPriceCenter = document.getElementById("stepPriceCenter");
  const elStepPriceBuy1 = document.getElementById("stepPriceBuy1");
  const elStepPriceBuy2 = document.getElementById("stepPriceBuy2");
  const elStepPriceBuy3 = document.getElementById("stepPriceBuy3");
  const elStepPriceBuy4 = document.getElementById("stepPriceBuy4");
  const elStepPriceBuffer = document.getElementById("stepPriceBuffer");
  const elStepPriceFloor = document.getElementById("stepPriceFloor");

  const elRealizedPnl = document.getElementById("realizedPnl");
  const elLotsCount = document.getElementById("lotsCount");
  const elLossStopInfo = document.getElementById("lossStopInfo");

  const elInventoryUsd = document.getElementById("inventoryUsd");
  const elMaxInventoryUsd = document.getElementById("maxInventoryUsd");
  const elInventoryProgress = document.getElementById("inventoryProgress");

  const elStepBps = document.getElementById("stepBps");

  const elStuckTimer = document.getElementById("stuckTimer");
  const elStuckTimerDesc = document.getElementById("stuckTimerDesc");
  const elStuckProgress = document.getElementById("stuckProgress");

  const elHudUpperBound = document.getElementById("hudUpperBound");
  const elHudCenter = document.getElementById("hudCenter");
  const elHudBottomBound = document.getElementById("hudBottomBound");
  const elHudBuyTrigger = document.getElementById("hudBuyTrigger");
  const elHudSellTrigger = document.getElementById("hudSellTrigger");
  const elHudChannelWidth = document.getElementById("hudChannelWidth");
  const elChannelStatusPill = document.getElementById("channelStatusPill");
  const elChannelStatusText = document.getElementById("channelStatusText");
  const elChannelClampSub = document.getElementById("channelClampSub");

  // On-Chain Wallet Elements
  const elNavWalletAddr = document.getElementById("navWalletAddr");
  const elNavWalletSomi = document.getElementById("navWalletSomi");
  const elNavWalletUsdso = document.getElementById("navWalletUsdso");
  const elTopWalletAddrBadge = document.getElementById("topWalletAddrBadge");
  const elTopWalletSomi = document.getElementById("topWalletSomi");
  const elTopWalletUsdso = document.getElementById("topWalletUsdso");
  const elTopWalletTotalVal = document.getElementById("topWalletTotalVal");

  // Top KPI Elements
  const elTopPosBadge = document.getElementById("topPosBadge");
  const elTopPosBase = document.getElementById("topPosBase");
  const elTopPosUsd = document.getElementById("topPosUsd");
  const elTopMaxInv = document.getElementById("topMaxInv");
  const elTopCapPct = document.getElementById("topCapPct");
  const elTopUnrealizedBadge = document.getElementById("topUnrealizedBadge");
  const elTopBuyStatusText = document.getElementById("topBuyStatusText");
  const elTopSellStatusText = document.getElementById("topSellStatusText");
  const elToastContainer = document.getElementById("toastContainer");

  const elLotsBadgeCount = document.getElementById("lotsBadgeCount");
  const elLotsTotalBase = document.getElementById("lotsTotalBase");
  const elLotsTableBody = document.getElementById("lotsTableBody");
  const elPosAvgEntry = document.getElementById("posAvgEntry");
  const elPosAvgEntrySub = document.getElementById("posAvgEntrySub");
  const elPosUnrealizedPnl = document.getElementById("posUnrealizedPnl");
  const elPosUnrealizedPnlSub = document.getElementById("posUnrealizedPnlSub");
  const elPosCurrentHold = document.getElementById("posCurrentHold");
  const elPosTargetHold = document.getElementById("posTargetHold");

  // Open Resting Maker Orders Elements
  const elOpenOrdersBadgeCount = document.getElementById("openOrdersBadgeCount");
  const elOpenOrdersTotalValue = document.getElementById("openOrdersTotalValue");
  const elOpenOrdersTableBody = document.getElementById("openOrdersTableBody");

  const btnFitChart = document.getElementById("btnFitChart");

  const elLaggardBadge = document.getElementById("laggardBadge");
  const elLaggardBinancePrice = document.getElementById("laggardBinancePrice");
  const elLaggardDreamdexPrice = document.getElementById("laggardDreamdexPrice");
  const elLaggardOpportunityBanner = document.getElementById("laggardOpportunityBanner");
  const elLaggardAlertText = document.getElementById("laggardAlertText");

  // ── Chart Initialization ───────────────────────────────────────────────────
  const chartContainer = document.getElementById("tvChart");
  let chart = null;
  let candleSeries = null;
  let downtrendLineSeries = null;
  let uptrendLineSeries = null;
  let waveCycleLineSeries = null;
  let isWaveVisible = true;
  const elWaveStatusPill = document.getElementById("waveStatusPill");
  const elWaveStatusText = document.getElementById("waveStatusText");
  const btnToggleWave = document.getElementById("btnToggleWave");
  let orderMarkers = [];
  let rawOrders = [];
  let structureMarkers = [];
  let pendingCandles = null;
  let pendingTick = null;
  let activeBaseAsset = "BASE";
  let activeQuoteAsset = "USDT";
  const ordersByCandleTime = new Map();
  const elChartOrderTooltip = document.getElementById("chartOrderTooltip");

  function hideChartOrderTooltip() {
    if (elChartOrderTooltip) {
      elChartOrderTooltip.classList.remove("active");
    }
  }

  function renderChartOrderTooltip(candleTime, point) {
    if (!elChartOrderTooltip || !chartContainer) return;
    const orders = ordersByCandleTime.get(candleTime);
    if (!orders || orders.length === 0) {
      hideChartOrderTooltip();
      return;
    }

    const sorted = [...orders].sort((a, b) => (a.time || 0) - (b.time || 0));

    const candleDate = new Date(candleTime * 1000);
    const dateStr = candleDate.toLocaleDateString([], { month: "2-digit", day: "2-digit" });
    const timeStr = candleDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    let totalQty = 0;
    let totalNotional = 0;
    let totalPnl = 0;
    let hasAnyPnl = false;

    const cardsHtml = sorted
      .map((order) => {
        const action = order.action || "BUY";
        const isBuy = ["BUY", "BUY_FILL", "SNIPE_BUY"].includes(action);
        const isCut = action === "CUT" || action === "CUT_LOSS";
        const badgeClass = isBuy ? "cot-badge-buy" : isCut ? "cot-badge-cut" : "cot-badge-sell";
        const badgeText = isBuy ? "BUY" : isCut ? "CUT LOSS" : "SELL";

        const price = Number(order.price || 0);
        const qty = Number(order.qty || 0);
        const notional = order.notionalUsdso || price * qty;

        totalQty += qty;
        totalNotional += notional;

        const pnlVal = order.pnl !== undefined ? order.pnl : order.pnlUsdso;
        const isSellAction = !isBuy;
        let pnlHtml = "";
        if (isSellAction && pnlVal !== undefined && pnlVal !== null && !isNaN(Number(pnlVal))) {
          hasAnyPnl = true;
          const pnlNum = Number(pnlVal);
          totalPnl += pnlNum;
          const pnlPct = notional > 0 ? (pnlNum / (notional - pnlNum)) * 100 : 0;
          const pnlClass = pnlNum >= 0 ? "pos" : "neg";
          const sign = pnlNum >= 0 ? "+" : "-";
          pnlHtml = `<span class="cot-val-pnl ${pnlClass}">${sign}$${Math.abs(pnlNum).toFixed(4)} (${sign}${Math.abs(pnlPct).toFixed(2)}%)</span>`;
        }

        const ordTime = order.time
          ? new Date(order.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
          : "";
        const txShort = order.txHash ? `${order.txHash.slice(0, 6)}...${order.txHash.slice(-4)}` : "";
        let cleanDesc = (order.levelDesc || "").replace(/\s*\(Target:[^)]+\)/i, "").trim();
        cleanDesc = cleanDesc.replace(/^IOC\s+(?:BUY|TAKE PROFIT|Sell)\s*\[(.*)\]$/i, "$1").trim();

        return `
          <div class="cot-order-card">
            <div class="cot-card-top">
              <span class="cot-badge ${badgeClass}">${badgeText}</span>
              <span class="cot-order-time">${ordTime}</span>
            </div>
            <div class="cot-card-row">
              <span class="cot-label">Price:</span>
              <span class="cot-val-price">$${price.toFixed(6)}</span>
            </div>
            <div class="cot-card-row">
              <span class="cot-label">Amount:</span>
              <span class="cot-val-qty">${qty.toFixed(4)} ${activeBaseAsset} <span class="cot-dim">($${notional.toFixed(2)})</span></span>
            </div>
            ${pnlHtml ? `
            <div class="cot-card-row">
              <span class="cot-label">Realized PnL:</span>
              ${pnlHtml}
            </div>` : ""}
            ${cleanDesc || txShort ? `
            <div class="cot-card-footer">
              <span>${cleanDesc || "Trade Match"}</span>
              ${txShort ? `<span>Tx: ${txShort}</span>` : ""}
            </div>` : ""}
          </div>
        `;
      })
      .join("");

    let summaryHtml = "";
    if (sorted.length > 1) {
      summaryHtml = `
        <div class="cot-summary-bar">
          <div class="cot-card-row">
            <span class="cot-label">Total (${sorted.length} fills):</span>
            <span class="cot-val-qty">${totalQty.toFixed(4)} ${activeBaseAsset} ($${totalNotional.toFixed(2)})</span>
          </div>
          ${hasAnyPnl ? `
          <div class="cot-card-row">
            <span class="cot-label">Net PnL:</span>
            <span class="cot-val-pnl ${totalPnl >= 0 ? "pos" : "neg"}">${totalPnl >= 0 ? "+$" : "-$"}${Math.abs(totalPnl).toFixed(4)}</span>
          </div>` : ""}
        </div>
      `;
    }

    elChartOrderTooltip.innerHTML = `
      <div class="cot-header">
        <span class="cot-time">🕒 ${dateStr} ${timeStr}</span>
        <span class="cot-count-badge">${sorted.length} ${sorted.length > 1 ? "Trades" : "Trade"}</span>
      </div>
      <div class="cot-orders-list">
        ${cardsHtml}
      </div>
      ${summaryHtml}
    `;

    const chartWidth = chartContainer.clientWidth;
    const chartHeight = chartContainer.clientHeight;
    elChartOrderTooltip.classList.add("active");

    const tipWidth = elChartOrderTooltip.offsetWidth || 230;
    const tipHeight = elChartOrderTooltip.offsetHeight || 130;

    let left = point.x + 18;
    let top = point.y - 18;

    if (left + tipWidth > chartWidth - 14) {
      left = Math.max(14, point.x - tipWidth - 18);
    }
    if (top + tipHeight > chartHeight - 14) {
      top = Math.max(14, chartHeight - tipHeight - 14);
    }
    if (top < 14) {
      top = 14;
    }

    elChartOrderTooltip.style.left = `${left}px`;
    elChartOrderTooltip.style.top = `${top}px`;
  }

  const elChartOrderBadgesLayer = document.getElementById("chartOrderBadgesLayer");
  let orderBadgesData = [];
  const badgeDomPool = new Map();

  // ── Swing Point Badge State ──
  const elChartSwingBadgesLayer = document.getElementById("chartSwingBadgesLayer");
  let swingBadgesData = []; // [{ time, price, label, icon, cssClass, below, title }]
  const swingBadgeDomPool = new Map(); // key → <div>

  function updateSwingBadgesDom() {
    if (!elChartSwingBadgesLayer) return;
    elChartSwingBadgesLayer.innerHTML = "";
    swingBadgeDomPool.clear();
    for (const item of swingBadgesData) {
      const el = document.createElement("div");
      el.className = `swing-badge ${item.cssClass}${item.below ? " badge-below" : ""}`;
      // Separate icon and label spans so CSS can size them independently
      el.innerHTML = `<span class="sw-icon">${item.icon}</span><span class="sw-label">${item.label}</span>`;
      if (item.title) el.title = item.title;
      elChartSwingBadgesLayer.appendChild(el);
      swingBadgeDomPool.set(item.key, el);
    }
  }

  function updateSwingBadgesPositions() {
    if (!chart || !candleSeries || !elChartSwingBadgesLayer || swingBadgesData.length === 0) return;
    const chartWidth  = chartContainer.clientWidth;
    const chartHeight = chartContainer.clientHeight;
    for (const item of swingBadgesData) {
      const el = swingBadgeDomPool.get(item.key);
      if (!el) continue;
      const x = chart.timeScale().timeToCoordinate(item.time);
      if (x === null || x < -40 || x > chartWidth + 40) { el.style.display = "none"; continue; }
      const y = candleSeries.priceToCoordinate(item.price);
      if (y === null || y < -40 || y > chartHeight + 40) { el.style.display = "none"; continue; }
      // aboveBar badges: y is candle high → badge sits 6px above (translate -100% handles it)
      // belowBar badges: y is candle low  → badge sits 6px below (badge-below translate 0% + 4px gap)
      const gap = item.below ? 4 : -6;
      el.style.left    = `${Math.round(x)}px`;
      el.style.top     = `${Math.round(y + gap)}px`;
      el.style.display = "flex";
    }
  }

  function updateOrderBadgesDom() {
    if (!elChartOrderBadgesLayer) return;
    elChartOrderBadgesLayer.innerHTML = "";
    badgeDomPool.clear();

    for (const item of orderBadgesData) {
      const isBuy = item.action === "BUY";
      const isCut = item.action === "CUT";
      const key = `${item.time}_${item.action}`;

      const el = document.createElement("div");
      el.className = `chart-order-badge ${isBuy ? "badge-buy" : isCut ? "badge-cut" : "badge-sell"}`;
      el.textContent = isBuy ? "B" : isCut ? "CUT" : "S";
      el.title = `${isBuy ? "Buy" : isCut ? "Cut Loss" : "Sell"} Execution`;

      el.addEventListener("mouseenter", (e) => {
        const rect = chartContainer.getBoundingClientRect();
        renderChartOrderTooltip(item.time, {
          x: e.clientX - rect.left,
          y: e.clientY - rect.top,
        });
      });
      el.addEventListener("mouseleave", () => {
        hideChartOrderTooltip();
      });

      elChartOrderBadgesLayer.appendChild(el);
      badgeDomPool.set(key, el);
    }
  }

  function updateOrderBadgesPositions() {
    if (!chart || !candleSeries || !elChartOrderBadgesLayer || orderBadgesData.length === 0) return;

    const chartWidth = chartContainer.clientWidth;
    const chartHeight = chartContainer.clientHeight;

    const candleMap = new Map();
    if (pendingCandles && pendingCandles.length > 0) {
      for (const c of pendingCandles) {
        candleMap.set(c.time, c);
      }
    }

    for (const item of orderBadgesData) {
      const key = `${item.time}_${item.action}`;
      const el = badgeDomPool.get(key);
      if (!el) continue;

      const x = chart.timeScale().timeToCoordinate(item.time);
      if (x === null || x < -25 || x > chartWidth + 25) {
        el.style.display = "none";
        continue;
      }

      const candle = candleMap.get(item.time);
      const isBuy = item.action === "BUY";

      let refPrice;
      if (candle) {
        refPrice = isBuy ? candle.low : candle.high;
      } else {
        const orders = ordersByCandleTime.get(item.time);
        refPrice = orders && orders[0] ? orders[0].price : null;
      }

      if (refPrice === null || refPrice === undefined || !Number.isFinite(refPrice)) {
        el.style.display = "none";
        continue;
      }

      const yCoord = candleSeries.priceToCoordinate(refPrice);
      if (yCoord === null || yCoord < -30 || yCoord > chartHeight + 30) {
        el.style.display = "none";
        continue;
      }

      // Position: BUY sits 12px below candle low, SELL sits 12px above candle high (matching reference screenshot)
      const y = isBuy ? yCoord + 12 : yCoord - 12;

      el.style.left = `${Math.round(x)}px`;
      el.style.top = `${Math.round(y)}px`;
      el.style.display = "flex";
    }
  }

  function rebuildOrderMarkers() {
    if (!candleSeries) return;
    const grouped = new Map();
    ordersByCandleTime.clear();

    for (const order of rawOrders) {
      const isTradeFill =
        order.status === "FILLED" ||
        (order.status !== "CANCELLED" &&
          order.status !== "OPEN" &&
          ["BUY", "SELL", "BUY_FILL", "SELL_FILL", "CUT", "EXIT", "TAKE_PROFIT", "SNIPE_BUY", "SNIPE_SELL"].includes(
            order.action
          ));
      if (!isTradeFill) continue;

      const markerTime = getCandleTimeForTimestamp(order.time);

      // Track into candle map for crosshair hover tooltip inspection
      if (!ordersByCandleTime.has(markerTime)) {
        ordersByCandleTime.set(markerTime, []);
      }
      ordersByCandleTime.get(markerTime).push(order);

      const action = order.action || "BUY";
      const isBuyAction = ["BUY", "BUY_FILL", "SNIPE_BUY"].includes(action);
      const isCutAction = action === "CUT" || action === "CUT_LOSS";
      const normalizedAction = isBuyAction ? "BUY" : isCutAction ? "CUT" : "SELL";

      const key = `${markerTime}_${normalizedAction}`;
      if (!grouped.has(key)) {
        grouped.set(key, { time: markerTime, action: normalizedAction, count: 0 });
      }
      grouped.get(key).count += 1;
    }

    orderBadgesData = Array.from(grouped.values());
    updateOrderBadgesDom();
    updateOrderBadgesPositions();

    refreshMarkers();
  }

  function refreshMarkers() {
    if (!candleSeries) return;
    const valid = structureMarkers.filter((m) => m && typeof m.time === "number" && Number.isFinite(m.time));
    valid.sort((a, b) => a.time - b.time);

    // Merge structure markers with identical time to prevent Lightweight Charts internal assertion crashes
    const merged = [];
    for (let i = 0; i < valid.length; i++) {
      const cur = valid[i];
      const prev = merged[merged.length - 1];
      if (prev && prev.time === cur.time) {
        if (prev.position !== cur.position) {
          merged.push({ ...cur });
        } else {
          if (cur.text && cur.text !== prev.text) {
            prev.text = prev.text ? `${prev.text} • ${cur.text}` : cur.text;
          }
        }
      } else {
        merged.push({ ...cur });
      }
    }

    try {
      candleSeries.setMarkers(merged);
    } catch (err) {
      console.warn("Could not set markers:", err);
    }
  }

  function getClientAnnotatedSwings(data) {
    const rawHighs = Array.isArray(data.swingHighs) ? data.swingHighs : [];
    const rawLows = Array.isArray(data.swingLows) ? data.swingLows : [];
    const combined = [
      ...rawHighs.map((h) => ({ ...h, type: "HIGH" })),
      ...rawLows.map((l) => ({ ...l, type: "LOW" })),
    ].sort((a, b) => a.time - b.time);

    const alternating = [];
    for (const s of combined) {
      if (alternating.length === 0) { alternating.push(s); continue; }
      const prev = alternating[alternating.length - 1];
      if (!prev) continue;
      if (s.type === prev.type) {
        if (s.type === "HIGH" && s.price >= prev.price) alternating[alternating.length - 1] = s;
        else if (s.type === "LOW" && s.price <= prev.price) alternating[alternating.length - 1] = s;
      } else {
        alternating.push(s);
      }
    }

    const result = [];
    let lastHigh = null;
    let lastLow = null;
    let lastHighLabel = null;
    let lastLowLabel = null;

    for (const s of alternating) {
      if (s.type === "HIGH") {
        let label = "HH";
        let isStart = false;
        let transType = null;
        if (!lastHigh) {
          label = "HH";
          lastHighLabel = "HH";
        } else if (s.price > lastHigh.price) {
          label = "HH";
          if (lastHighLabel === "LH") { isStart = true; transType = "START_HH"; }
          lastHighLabel = "HH";
        } else {
          label = "LH";
          if (lastHighLabel === "HH") { isStart = true; transType = "START_LH"; }
          lastHighLabel = "LH";
        }
        result.push({ ...s, dowLabel: label, isTransitionStart: isStart, transitionType: transType });
        lastHigh = s;
      } else {
        let label = "LL";
        let isStart = false;
        let transType = null;
        if (!lastLow) {
          label = "LL";
          lastLowLabel = "LL";
        } else if (s.price > lastLow.price) {
          label = "HL";
          if (lastLowLabel === "LL") { isStart = true; transType = "START_HL"; }
          lastLowLabel = "HL";
        } else {
          label = "LL";
          if (lastLowLabel === "HL") { isStart = true; transType = "START_LL"; }
          lastLowLabel = "LL";
        }
        result.push({ ...s, dowLabel: label, isTransitionStart: isStart, transitionType: transType });
        lastLow = s;
      }
    }
    return result;
  }

  // Price Lines
  let lineUpperBound = null;
  let lineLiveCalculatedUpperBound = null;
  let lineBottomBound = null;
  let lineLiveCalculatedBottomBound = null;
  let lineCutLossBound = null;
  let lineCenter = null;
  let lineBuyTrigger = null;
  let lineSellTrigger = null;
  let gridZoneLevelLines = [];

  function initChart() {
    if (chart && candleSeries) return;

    const lc = window.LightweightCharts;
    if (!lc || typeof lc.createChart !== "function") {
      console.warn("LightweightCharts library not loaded yet, retrying in 100ms…");
      setTimeout(initChart, 100);
      return;
    }

    if (!chartContainer) {
      console.error("tvChart container element not found");
      return;
    }

    const containerWidth = chartContainer.clientWidth || chartContainer.parentElement?.clientWidth || 800;
    const containerHeight = chartContainer.clientHeight || 480;

    try {
      chart = lc.createChart(chartContainer, {
        width: containerWidth,
        height: containerHeight,
        layout: {
          background: { color: "transparent" },
          textColor: "#94a3b8",
          fontFamily: "'Inter', sans-serif",
        },
        watermark: {
          visible: true,
          fontSize: 48,
          horzAlign: "center",
          vertAlign: "center",
          color: "rgba(255, 255, 255, 0.04)",
          text: "BINANCE SPOT • 15M",
        },
        localization: {
          priceFormatter: (price) =>
            typeof price === "number" && Number.isFinite(price) ? price.toFixed(6) : "",
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
        grid: {
          vertLines: { color: "rgba(255, 255, 255, 0.04)" },
          horzLines: { color: "rgba(255, 255, 255, 0.04)" },
        },
        crosshair: {
          mode: lc.CrosshairMode ? lc.CrosshairMode.Normal : 1,
        },
        rightPriceScale: {
          borderColor: "rgba(255, 255, 255, 0.08)",
          autoScale: true,
          scaleMargins: {
            top: 0.02,
            bottom: 0.03,
          },
        },
        timeScale: {
          borderColor: "rgba(255, 255, 255, 0.08)",
          timeVisible: true,
          secondsVisible: false,
          rightOffset: 12,
          barSpacing: 10,
          minBarSpacing: 4,
          tickMarkFormatter: (time, tickMarkType, locale) => {
            const timestamp = typeof time === "number" ? time : (time?.timestamp || time);
            if (!timestamp) return "";
            const date = new Date(timestamp * 1000);
            const hours = String(date.getHours()).padStart(2, "0");
            const minutes = String(date.getMinutes()).padStart(2, "0");
            const day = String(date.getDate()).padStart(2, "0");
            const month = date.toLocaleDateString(locale || undefined, { month: "short" });

            // 0: Year, 1: Month, 2: DayOfMonth, 3: Time, 4: TimeWithSeconds
            if (tickMarkType === 0) {
              return String(date.getFullYear());
            } else if (tickMarkType === 1) {
              return month;
            } else if (tickMarkType === 2) {
              return `${day} ${month}`;
            } else if (tickMarkType === 3 || tickMarkType === 4) {
              return `${hours}:${minutes}`;
            }
            return `${hours}:${minutes}`;
          },
        },
      });

      candleSeries = chart.addCandlestickSeries({
        upColor: "#10b981",
        downColor: "#f43f5e",
        borderVisible: false,
        borderColor: "#10b981",
        borderUpColor: "#10b981",
        borderDownColor: "#f43f5e",
        wickUpColor: "#10b981",
        wickDownColor: "#f43f5e",
        priceFormat: {
          type: "price",
          precision: 6,
          minMove: 0.000001,
        },
      });

      // Downtrend Resistance Line Series (Electric Indigo / Purple-Blue dashed)
      downtrendLineSeries = chart.addLineSeries({
        color: "#818cf8",
        lineWidth: 2,
        lineStyle: lc.LineStyle ? lc.LineStyle.Dashed : 2,
        title: "",
        lastValueVisible: true,
        priceLineVisible: false,
        priceFormat: {
          type: "price",
          precision: 6,
          minMove: 0.000001,
        },
      });

      // Uptrend Support Line Series (Bright Teal / Mint dashed)
      uptrendLineSeries = chart.addLineSeries({
        color: "#2dd4bf",
        lineWidth: 2,
        lineStyle: lc.LineStyle ? lc.LineStyle.Dashed : 2,
        title: "",
        lastValueVisible: true,
        priceLineVisible: false,
        priceFormat: {
          type: "price",
          precision: 6,
          minMove: 0.000001,
        },
      });

      // Wave Cycle Series (Cyan / Sky line connecting Dow Swings)
      waveCycleLineSeries = chart.addLineSeries({
        color: "rgba(56, 189, 248, 0.85)",
        lineWidth: 2,
        lineStyle: lc.LineStyle ? lc.LineStyle.Solid : 0,
        title: "",
        lastValueVisible: false,
        priceLineVisible: false,
        priceFormat: {
          type: "price",
          precision: 6,
          minMove: 0.000001,
        },
      });

      // Crosshair Hover Inspection for in-chart Legend & Order Details Tooltip
      chart.subscribeCrosshairMove((param) => {
        if (
          !param.point ||
          !param.time ||
          param.point.x < 0 ||
          param.point.x > chartContainer.clientWidth ||
          param.point.y < 0 ||
          param.point.y > chartContainer.clientHeight
        ) {
          if (latestCandle) renderOhlc(latestCandle);
          hideChartOrderTooltip();
          return;
        }
        const bar = param.seriesData.get(candleSeries);
        if (bar) {
          renderOhlc(bar);
        } else if (latestCandle) {
          renderOhlc(latestCandle);
        }

        renderChartOrderTooltip(param.time, param.point);
      });

      chartContainer.addEventListener("mouseleave", () => {
        hideChartOrderTooltip();
      });

      // Synchronize circular order badges with chart scroll, pan, zoom, and drag
      chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
        updateOrderBadgesPositions();
        updateSwingBadgesPositions();
      });
      chart.timeScale().subscribeVisibleTimeRangeChange(() => {
        updateOrderBadgesPositions();
        updateSwingBadgesPositions();
      });
      chartContainer.addEventListener("mousemove", (e) => {
        if (e.buttons > 0) { updateOrderBadgesPositions(); updateSwingBadgesPositions(); }
      });
      chartContainer.addEventListener("wheel", () => {
        requestAnimationFrame(() => { updateOrderBadgesPositions(); updateSwingBadgesPositions(); });
      }, { passive: true });

      if (window.ResizeObserver) {
        const ro = new ResizeObserver((entries) => {
          for (const entry of entries) {
            const { width, height } = entry.contentRect;
            if (width > 0 && height > 0 && chart) {
              chart.applyOptions({ width, height });
              updateOrderBadgesPositions();
              updateSwingBadgesPositions();
            }
          }
        });
        ro.observe(chartContainer);
      } else {
        window.addEventListener("resize", () => {
          if (chart && chartContainer) {
            chart.applyOptions({
              width: chartContainer.clientWidth || 800,
              height: chartContainer.clientHeight || 480,
            });
            updateOrderBadgesPositions();
            updateSwingBadgesPositions();
          }
        });
      }

      if (btnFitChart) {
        btnFitChart.addEventListener("click", () => {
          chart.timeScale().fitContent();
          chart.timeScale().applyOptions({ rightOffset: 12 });
          setTimeout(() => { updateOrderBadgesPositions(); updateSwingBadgesPositions(); }, 50);
        });
      }

      if (btnToggleWave) {
        btnToggleWave.addEventListener("click", () => {
          isWaveVisible = !isWaveVisible;
          btnToggleWave.classList.toggle("active", isWaveVisible);
          if (waveCycleLineSeries) {
            waveCycleLineSeries.applyOptions({ visible: isWaveVisible });
          }
          refreshMarkers();
        });
      }

      // If candles or tick were received before chart finished initializing, apply now!
      if (pendingCandles && pendingCandles.length > 0) {
        updateCandles(pendingCandles);
      }
      if (pendingTick) {
        updateTick(pendingTick);
      }
    } catch (err) {
      console.error("Error creating LightweightChart:", err);
    }
  }

  function setPriceLine(existingLine, options) {
    if (!candleSeries || !options || !Number.isFinite(options.price)) return null;
    if (existingLine) {
      try {
        existingLine.applyOptions(options);
        return existingLine;
      } catch {
        // Line disposed or expired
      }
    }
    try {
      return candleSeries.createPriceLine(options);
    } catch (err) {
      console.warn("Could not create price line:", err);
      return null;
    }
  }

  // ── State Update Functions ─────────────────────────────────────────────────
  let latestCandleTime = 0;
  let latestCandle = null;

  function renderOhlc(bar) {
    if (!bar) return;
    const open = Number(bar.open || 0);
    const high = Number(bar.high || 0);
    const low = Number(bar.low || 0);
    const close = Number(bar.close || 0);
    if (elLegendO) elLegendO.textContent = open.toFixed(6);
    if (elLegendH) elLegendH.textContent = high.toFixed(6);
    if (elLegendL) elLegendL.textContent = low.toFixed(6);
    if (elLegendC) elLegendC.textContent = close.toFixed(6);

    if (open > 0 && elLegendChange) {
      const diffPct = ((close - open) / open) * 100;
      const sign = diffPct >= 0 ? "+" : "";
      elLegendChange.textContent = `${sign}${diffPct.toFixed(2)}%`;
      elLegendChange.className = "ohlc-val " + (diffPct >= 0 ? "pnl-positive" : "pnl-negative");
    }
  }

  function updateCandles(candles) {
    if (!candles || candles.length === 0) return;
    pendingCandles = candles;
    if (!candleSeries || !chart) return;

    // Deduplicate by time and sort ascending
    const timeMap = new Map();
    for (const c of candles) {
      if (c && typeof c.time === "number" && [c.open, c.high, c.low, c.close].every(Number.isFinite)) {
        timeMap.set(c.time, {
          time: c.time,
          open: Number(c.open),
          high: Number(c.high),
          low: Number(c.low),
          close: Number(c.close),
        });
      }
    }

    const cleanCandles = Array.from(timeMap.values()).sort((a, b) => a.time - b.time);
    if (cleanCandles.length > 0) {
      try {
        candleSeries.setData(cleanCandles);
        latestCandle = cleanCandles[cleanCandles.length - 1];
        latestCandleTime = latestCandle.time;
        renderOhlc(latestCandle);
        rebuildOrderMarkers();
        refreshMarkers();
        chart.timeScale().fitContent();
        chart.timeScale().applyOptions({ rightOffset: 12 });
        updateOrderBadgesPositions();
        updateSwingBadgesPositions();
      } catch (err) {
        console.error("Failed to set candle data:", err);
      }
    }
  }

  function updateSingleCandle(candle) {
    if (!candle || typeof candle.time !== "number") return;
    if (![candle.open, candle.high, candle.low, candle.close].every(Number.isFinite)) return;

    const formatted = {
      time: candle.time,
      open: Number(candle.open),
      high: Number(candle.high),
      low: Number(candle.low),
      close: Number(candle.close),
    };

    if (pendingCandles) {
      const idx = pendingCandles.findIndex((c) => c.time === formatted.time);
      if (idx >= 0) pendingCandles[idx] = formatted;
      else pendingCandles.push(formatted);
    }

    latestCandle = formatted;
    renderOhlc(latestCandle);

    if (candleSeries) {
      try {
        candleSeries.update(formatted);
        latestCandleTime = Math.max(latestCandleTime, candle.time);
        updateOrderBadgesPositions();
        updateSwingBadgesPositions();
      } catch (err) {
        console.warn("Error updating single candle:", err);
      }
    }
  }

  function updateZoneLevelBars(data) {
    const pos = data.positionPct !== undefined ? data.positionPct : 50;
    const floor = data.bottomBound ?? 0;
    const ceil = data.upperBound ?? 0;
    const span = Math.max(0.000001, ceil - floor);
    const center = data.centerPrice ?? (floor + ceil) / 2;

    // 1. Update prices on each vertical step (from top 100% to bottom 0%)
    if (elStepPriceCeil) elStepPriceCeil.textContent = ceil.toFixed(6);
    if (elStepPriceSell4) elStepPriceSell4.textContent = (floor + span * 0.90).toFixed(6);
    if (elStepPriceSell3) elStepPriceSell3.textContent = (floor + span * 0.80).toFixed(6);
    if (elStepPriceSell2) elStepPriceSell2.textContent = (floor + span * 0.70).toFixed(6);
    if (elStepPriceSell1) elStepPriceSell1.textContent = (floor + span * 0.60).toFixed(6);
    if (elStepPriceCenter) elStepPriceCenter.textContent = center.toFixed(6);
    if (elStepPriceBuy1) elStepPriceBuy1.textContent = (floor + span * 0.40).toFixed(6);
    if (elStepPriceBuy2) elStepPriceBuy2.textContent = (floor + span * 0.30).toFixed(6);
    if (elStepPriceBuy3) elStepPriceBuy3.textContent = (floor + span * 0.20).toFixed(6);
    if (elStepPriceBuy4) elStepPriceBuy4.textContent = (floor + span * 0.10).toFixed(6);
    if (elStepPriceBuffer) elStepPriceBuffer.textContent = (floor + span * 0.05).toFixed(6);
    if (elStepPriceFloor) {
      elStepPriceFloor.textContent = floor.toFixed(6);
      elStepPriceFloor.title = `0% Grid Base (Structural Valley: $${floor.toFixed(6)})`;
    }

    // 2. Define ladder steps with percentage targets
    const ladderSteps = [
      { pct: 100, el: elStepCeil, priceEl: elStepPriceCeil, defaultAction: "Flat 0%", price: ceil },
      { pct: 90, el: elStepSell4, priceEl: elStepPriceSell4, defaultAction: "Hold 0%", price: floor + span * 0.90 },
      { pct: 80, el: elStepSell3, priceEl: elStepPriceSell3, defaultAction: "Hold 25%", price: floor + span * 0.80 },
      { pct: 70, el: elStepSell2, priceEl: elStepPriceSell2, defaultAction: "Hold 50%", price: floor + span * 0.70 },
      { pct: 60, el: elStepSell1, priceEl: elStepPriceSell1, defaultAction: "Hold 75%", price: floor + span * 0.60 },
      { pct: 50, el: elStepCenter, priceEl: elStepPriceCenter, defaultAction: "Midline", price: center },
      { pct: 40, el: elStepBuy1, priceEl: elStepPriceBuy1, defaultAction: "Hold 25%", price: floor + span * 0.40 },
      { pct: 30, el: elStepBuy2, priceEl: elStepPriceBuy2, defaultAction: "Hold 50%", price: floor + span * 0.30 },
      { pct: 20, el: elStepBuy3, priceEl: elStepPriceBuy3, defaultAction: "Hold 75%", price: floor + span * 0.20 },
      { pct: 10, el: elStepBuy4, priceEl: elStepPriceBuy4, defaultAction: "Hold 100%", price: floor + span * 0.10 },
      { pct: 5, el: elStepBuffer, priceEl: elStepPriceBuffer, defaultAction: "Hold 100%", price: floor + span * 0.05 },
      { pct: 0, el: elStepFloor, priceEl: elStepPriceFloor, defaultAction: "Cut Loss", price: floor },
    ];

    // Reset all ladder steps to default clean state
    ladderSteps.forEach((step) => {
      if (!step.el) return;
      step.el.classList.remove("has-resting-buy", "has-resting-sell", "active-ladder-step");
      const actionEl = step.el.querySelector(".step-action");
      if (actionEl) {
        if (step.pct === 0) {
          actionEl.textContent = "0% Floor";
        } else {
          actionEl.textContent = step.defaultAction;
        }
      }
      if (step.priceEl) step.priceEl.textContent = step.price.toFixed(6);
    });

    // 3. Match each resting order strictly to its corresponding grid zone
    const openOrders = data.openOrders || [];
    openOrders.forEach((order) => {
      if (!order || !order.price) return;

      let matchedStep = null;
      const desc = (order.levelDesc || "").toLowerCase();

      // Check levelDesc first for exact target matching
      if (desc.includes("buy level 1") || desc.includes("40%")) matchedStep = ladderSteps.find((s) => s.pct === 40);
      else if (desc.includes("buy level 2") || desc.includes("30%")) matchedStep = ladderSteps.find((s) => s.pct === 30);
      else if (desc.includes("buy level 3") || desc.includes("20%")) matchedStep = ladderSteps.find((s) => s.pct === 20);
      else if (desc.includes("buy level 4") || desc.includes("10%")) matchedStep = ladderSteps.find((s) => s.pct === 10);
      else if (desc.includes("sell target 1") || desc.includes("60%")) matchedStep = ladderSteps.find((s) => s.pct === 60);
      else if (desc.includes("sell target 2") || desc.includes("70%")) matchedStep = ladderSteps.find((s) => s.pct === 70);
      else if (desc.includes("sell target 3") || desc.includes("80%")) matchedStep = ladderSteps.find((s) => s.pct === 80);
      else if (desc.includes("sell target 4") || desc.includes("90%")) matchedStep = ladderSteps.find((s) => s.pct === 90);

      // Fallback to nearest price step within half grid spacing
      if (!matchedStep) {
        let minDiff = Infinity;
        ladderSteps.forEach((step) => {
          if (!step.el) return;
          const diff = Math.abs(step.price - order.price);
          if (diff < minDiff) {
            minDiff = diff;
            matchedStep = step;
          }
        });
        if (minDiff >= span * 0.055) {
          matchedStep = null;
        }
      }

      // If zone has an active resting order, update price & badge
      if (matchedStep && matchedStep.el) {
        const isBid = order.isBid;
        matchedStep.el.classList.add(isBid ? "has-resting-buy" : "has-resting-sell");
        if (matchedStep.priceEl) matchedStep.priceEl.textContent = order.price.toFixed(6);

        const actionEl = matchedStep.el.querySelector(".step-action");
        if (actionEl) {
          const notionalVal = order.notionalUsdso || (order.price * (order.qty || 0));
          const notional = notionalVal > 0 ? `$${notionalVal.toFixed(2)}` : "";
          const sideTag = isBid ? "BUY" : "SELL";
          const tagClass = isBid ? "buy-order-tag" : "sell-order-tag";
          let expPill = "";
          if (order.expireTime) {
            const remH = Math.max(0, Math.round((order.expireTime - Date.now()) / 3600000));
            expPill = remH > 0 ? `<span style="opacity:0.8; font-size:7.5px; margin-left:3px; font-weight:600;">⏳${remH}h</span>` : "";
          }
          actionEl.innerHTML = `<span class="step-order-tag ${tagClass}"><span class="order-pulse-dot"></span> ${sideTag} ${notional}${expPill}</span>`;
        }
      }
    });

    // 4. Highlight the active current price step from top to bottom
    let activeStep = null;
    let levelName = "";
    let targetText = "";
    let colorClass = "highlight-green";
    let zoneBadgeText = "";
    let zoneBadgeClass = "active-zone-pill badge-inzone";

    if (data.isBelowFloor || pos < 0) {
      const hasLots = (data.lots && data.lots.length > 0) || ((data.positionQuote || data.positionUsdso) && (data.positionQuote || data.positionUsdso) > 0.05);
      activeStep = elStepFloor;
      levelName = "0% Floor (Below Channel)";
      targetText = hasLots ? "CUT LOSS ACTIVE (0%)" : `PROTECTED IN CASH (100% ${activeQuoteAsset || "Quote"})`;
      colorClass = hasLots ? "highlight-red" : "highlight-blue";
      zoneBadgeText = hasLots ? "0% FLOOR (CUT)" : "0% FLOOR (100% CASH)";
      zoneBadgeClass = hasLots ? "active-zone-pill badge-breakdown" : "active-zone-pill badge-warmup";
    } else if (pos <= 5) {
      activeStep = elStepBuffer;
      levelName = `Safe Buffer 0-5% (${pos.toFixed(1)}%)`;
      targetText = "Hold 100% (Safety Reserve)";
      colorClass = "highlight-green";
      zoneBadgeText = "SAFE BUFFER (0-5%)";
      zoneBadgeClass = "active-zone-pill badge-warmup";
    } else if (pos <= 10) {
      activeStep = elStepBuy4;
      levelName = `Buy Level 4 (10% | ${pos.toFixed(1)}%)`;
      targetText = "Target 100% (Max Inventory)";
      colorClass = "highlight-green";
      zoneBadgeText = `BUY ZONE (${pos.toFixed(1)}%)`;
      zoneBadgeClass = "active-zone-pill badge-inzone";
    } else if (pos <= 20) {
      activeStep = elStepBuy3;
      levelName = `Buy Level 3 (20% | ${pos.toFixed(1)}%)`;
      targetText = "Target 75% (3/4 Capacity)";
      colorClass = "highlight-green";
      zoneBadgeText = `BUY ZONE (${pos.toFixed(1)}%)`;
      zoneBadgeClass = "active-zone-pill badge-inzone";
    } else if (pos <= 30) {
      activeStep = elStepBuy2;
      levelName = `Buy Level 2 (30% | ${pos.toFixed(1)}%)`;
      targetText = "Target 50% (1/2 Capacity)";
      colorClass = "highlight-green";
      zoneBadgeText = `BUY ZONE (${pos.toFixed(1)}%)`;
      zoneBadgeClass = "active-zone-pill badge-inzone";
    } else if (pos <= 40) {
      activeStep = elStepBuy1;
      levelName = `Buy Level 1 (40% | ${pos.toFixed(1)}%)`;
      targetText = "Target 25% (1/4 Capacity)";
      colorClass = "highlight-green";
      zoneBadgeText = `BUY ZONE (${pos.toFixed(1)}%)`;
      zoneBadgeClass = "active-zone-pill badge-inzone";
    } else if (pos < 50) {
      activeStep = elStepCenter;
      levelName = `Accumulation Midline (${pos.toFixed(1)}%)`;
      targetText = "Waiting Dip (<40%)";
      colorClass = "highlight-amber";
      zoneBadgeText = `ACCUMULATION (${pos.toFixed(1)}%)`;
      zoneBadgeClass = "active-zone-pill badge-range";
    } else if (pos <= 55) {
      activeStep = elStepCenter;
      levelName = `50% Center (${pos.toFixed(1)}%)`;
      targetText = "Hold 100% (Neutral Midline)";
      colorClass = "highlight-amber";
      zoneBadgeText = `50% CENTER (${pos.toFixed(1)}%)`;
      zoneBadgeClass = "active-zone-pill badge-range";
    } else if (pos <= 65) {
      activeStep = elStepSell1;
      levelName = `Sell Target 1 (60% | ${pos.toFixed(1)}%)`;
      targetText = "Hold 75% ($68 / 5 lots)";
      colorClass = "highlight-red";
      zoneBadgeText = `SELL ZONE (${pos.toFixed(1)}%)`;
      zoneBadgeClass = "active-zone-pill badge-breakout";
    } else if (pos <= 75) {
      activeStep = elStepSell2;
      levelName = `Sell Target 2 (70% | ${pos.toFixed(1)}%)`;
      targetText = "Hold 50% ($45 / 3 lots)";
      colorClass = "highlight-red";
      zoneBadgeText = `SELL ZONE (${pos.toFixed(1)}%)`;
      zoneBadgeClass = "active-zone-pill badge-breakout";
    } else if (pos <= 85) {
      activeStep = elStepSell3;
      levelName = `Sell Target 3 (80% | ${pos.toFixed(1)}%)`;
      targetText = "Hold 25% ($23 / 1-2 lots)";
      colorClass = "highlight-red";
      zoneBadgeText = `SELL ZONE (${pos.toFixed(1)}%)`;
      zoneBadgeClass = "active-zone-pill badge-breakout";
    } else if (pos < 95) {
      activeStep = elStepSell4;
      levelName = `Sell Target 4 (90% | ${pos.toFixed(1)}%)`;
      targetText = "Flat 0% ($0 / 0 lots)";
      colorClass = "highlight-red";
      zoneBadgeText = `SELL ZONE (${pos.toFixed(1)}%)`;
      zoneBadgeClass = "active-zone-pill badge-breakout";
    } else {
      activeStep = elStepCeil;
      levelName = `100% Ceiling (${pos.toFixed(1)}%)`;
      targetText = "100% FULL EXIT (0%)";
      colorClass = "highlight-red";
      zoneBadgeText = "100% CEIL (EXIT)";
      zoneBadgeClass = "active-zone-pill badge-breakout";
    }

    if (activeStep) activeStep.classList.add("active-ladder-step");
    if (elLadderCurrentLevel) elLadderCurrentLevel.textContent = levelName;
    if (elLadderTargetAlloc) {
      elLadderTargetAlloc.textContent = targetText;
      elLadderTargetAlloc.className = `sum-val ${colorClass}`;
    }
    if (elLadderZoneBadge) {
      elLadderZoneBadge.textContent = zoneBadgeText;
      elLadderZoneBadge.className = zoneBadgeClass;
    }
  }

  function updateTick(data) {
    if (!data) return;

    // Symbol Display
    const rawSymbol = data.symbol || (data.binanceSymbol ? `${data.binanceSymbol.toUpperCase()}` : "SOMI:USDso");
    const displaySymbol = rawSymbol.replace(":", " / ").toUpperCase();
    const macroTf = (data.dowTimeframe || "15m").toUpperCase();
    const tradeTf = (data.tradingTimeframe || "15m").toUpperCase();

    if (elNavSymbolBadge) elNavSymbolBadge.textContent = displaySymbol;
    if (elChartSymbolBadge) elChartSymbolBadge.textContent = displaySymbol;
    if (elLegendSymbol) elLegendSymbol.textContent = displaySymbol;
    if (elLegendTf) elLegendTf.textContent = macroTf;
    if (elLegendLivePrice && data.mid !== undefined) elLegendLivePrice.textContent = `$${data.mid.toFixed(6)}`;

    // Top Brand Logo Badge (Exchange indicator)
    const elLogoBadge = document.getElementById("logoBadge");
    if (elLogoBadge) {
      const isDreamdex = (data.exchange || "").toLowerCase() === "dreamdex" || rawSymbol.includes(":") || rawSymbol.includes("USDSO");
      elLogoBadge.textContent = isDreamdex ? "DREAMDEX SPOT" : "BINANCE GRID";
    }

    // Dry Run vs Live On-Chain Badge
    if (data.dryRun !== undefined && elDryRunBadge) {
      if (data.dryRun) {
        elDryRunBadge.textContent = "DRY RUN";
        elDryRunBadge.className = "dry-badge";
        elDryRunBadge.style.background = "rgba(245, 158, 11, 0.2)";
        elDryRunBadge.style.color = "#fbbf24";
        elDryRunBadge.style.borderColor = "rgba(245, 158, 11, 0.4)";
      } else {
        elDryRunBadge.textContent = "LIVE ON-CHAIN";
        elDryRunBadge.className = "dry-badge live-badge";
        elDryRunBadge.style.background = "rgba(16, 185, 129, 0.2)";
        elDryRunBadge.style.color = "#34d399";
        elDryRunBadge.style.borderColor = "rgba(16, 185, 129, 0.4)";
      }
    }

    if (chart) {
      chart.applyOptions({
        watermark: {
          visible: true,
          text: `${displaySymbol} • ${macroTf}`,
        },
      });
    }

    // Timeframe Badge & Subtitle
    if (data.dowTimeframe && data.tradingTimeframe) {
      const macroTf = data.dowTimeframe.toUpperCase();
      const tradeTf = data.tradingTimeframe.toUpperCase();
      if (elTimeframeBadge) {
        const modeStr = data.channelMode ? ` • MODE: ${data.channelMode}` : "";
        elTimeframeBadge.textContent = `CHART: ${macroTf} • TRIGGER: ${tradeTf}${modeStr}`;
      }
      if (elChartTimeframeSub) {
        elChartTimeframeSub.textContent = `(${macroTf} Macro Candles)`;
      }
    }

    // Mid Price & 50% Center (6 decimals)
    if (data.mid !== undefined) {
      if (elMidPrice) elMidPrice.textContent = data.mid.toFixed(6);
      document.title = `$${data.mid.toFixed(6)} ${displaySymbol} | Dynamic Grid`;
    }
    if (data.centerPrice !== undefined && elAnchorPrice) elAnchorPrice.textContent = data.centerPrice.toFixed(6);

    // Spread in % and $
    if (data.spreadPct !== undefined && elSpreadBpsBadge) {
      elSpreadBpsBadge.textContent = `Spread: ${data.spreadPct.toFixed(2)}%`;
    }

    // HUD overlays in chart
    if (data.upperBound !== undefined && elHudUpperBound) {
      elHudUpperBound.textContent = data.upperBound.toFixed(6);
    }
    if (data.bottomBound !== undefined && elHudBottomBound) {
      elHudBottomBound.textContent = data.bottomBound.toFixed(6);
    }
    if (data.centerPrice !== undefined && elHudCenter) {
      elHudCenter.textContent = data.centerPrice.toFixed(6);
    }
    if (data.zoneWidthPct !== undefined && elHudChannelWidth) {
      elHudChannelWidth.textContent = `${data.zoneWidthPct.toFixed(2)}%`;
    }

    // Channel Clamp Mode & Swing Details
    const widthPct = data.zoneWidthPct !== undefined ? data.zoneWidthPct : 0;
    let clampStr = data.clampStatus === "CLAMPED_MIN"
      ? `Clamped Min (${(data.minWidthPct || 0).toFixed(1)}%)`
      : data.clampStatus === "CLAMPED_MAX"
        ? `Clamped Max (${(data.maxWidthPct || 0).toFixed(1)}%)`
        : `Natural Swing (${widthPct.toFixed(1)}%)`;

    if (data.channelMode === "MULTI_TOUCH_SR" || data.resistanceCluster || data.supportCluster) {
      const resT = data.resistanceCluster?.touchCount ? `${data.resistanceCluster.touchCount}x` : (data.resistanceTouchCount ? `${data.resistanceTouchCount}x` : "-");
      const supT = data.supportCluster?.touchCount ? `${data.supportCluster.touchCount}x` : (data.supportTouchCount ? `${data.supportTouchCount}x` : "-");
      clampStr = `S/R Multi-Touch [Res: ${resT}, Sup: ${supT}]`;
    }

    if (data.isChannelLocked) {
      const realCeilStr = data.liveCalculatedUpperBound && Math.abs(data.liveCalculatedUpperBound - data.upperBound) / data.upperBound > 0.001
        ? ` • Real Ceil: $${data.liveCalculatedUpperBound.toFixed(4)}`
        : "";
      const realFloorStr = data.liveCalculatedBottomBound && Math.abs(data.liveCalculatedBottomBound - data.bottomBound) / data.bottomBound > 0.001
        ? ` • Real Floor: $${data.liveCalculatedBottomBound.toFixed(4)}`
        : "";
      clampStr = `🔒 100% Locked${realCeilStr}${realFloorStr} • ${clampStr}`;
    }

    if (elChannelStatusText) {
      elChannelStatusText.textContent = `Channel: ${widthPct.toFixed(2)}% (${clampStr})`;
    }
    const elLegendPillBottomText = document.getElementById("legendPillBottomText");
    if (elLegendPillBottomText && data.bottomBound) {
      elLegendPillBottomText.textContent = `0% Lower (Floor): $${data.bottomBound.toFixed(6)}`;
    }
    const elLegendPillCutLoss = document.getElementById("legendPillCutLoss");
    const elLegendPillCutLossText = document.getElementById("legendPillCutLossText");
    if (elLegendPillCutLoss && elLegendPillCutLossText) {
      if (data.cutLossBound && data.bottomBound && data.cutLossBound < data.bottomBound) {
        const bufDelta = data.bottomBound - data.cutLossBound;
        const bufPct = (bufDelta / data.bottomBound) * 100;
        elLegendPillCutLoss.style.display = "inline-flex";
        elLegendPillCutLossText.textContent = `Cut Loss Buffer: $${data.cutLossBound.toFixed(6)} (-${bufPct.toFixed(2)}%)`;
      } else {
        elLegendPillCutLoss.style.display = "none";
      }
    }
    if (elChannelClampSub) {
      elChannelClampSub.textContent = `Width: ${widthPct.toFixed(2)}% • ${clampStr}`;
    }

    // Channel Position & Zone Level Bars
    const pos = data.positionPct !== undefined ? data.positionPct : 50;
    updateZoneLevelBars(data);

    if (data.isPaused !== undefined) {
      updatePauseUI(data.isPaused);
    }

    // Live Bot Action / Waiting Indicator Banner
    if (data.isPaused && elBotStatusBanner) {
      elBotStatusBanner.className = "bot-status-banner banner-warning";
      if (elBannerStatusTitle) elBannerStatusTitle.textContent = "⏸️ Strategy Paused (Monitoring Mode)";
      if (elBannerReasonText) elBannerReasonText.textContent = "Chart & market structure active. Order placement/cancellation suspended.";
      if (elBannerTriggerText) elBannerTriggerText.textContent = "Click 'Resume' button to activate live trading";
    } else if (data.botAction && elBotStatusBanner) {
      const { title, reason, nextTrigger, severity } = data.botAction;
      elBotStatusBanner.className = `bot-status-banner banner-${severity || "info"}`;
      if (elBannerStatusTitle) elBannerStatusTitle.textContent = title || "Analyzing Market";
      if (elBannerReasonText) elBannerReasonText.textContent = reason || "Monitoring channel parameters";
      if (elBannerTriggerText) elBannerTriggerText.textContent = nextTrigger || "Evaluating price action";
    }

    if (elTickSpeedText && data.intervalMs !== undefined) {
      const sec = (data.intervalMs / 1000).toFixed(1);
      elTickSpeedText.textContent = `⚡ ${sec}s`;
    }

    // Zone Badge & Type
    const targetHoldStr = data.targetHoldingPct !== undefined ? ` • Target: ${data.targetHoldingPct.toFixed(0)}% ($${data.targetInventoryUsdso ? data.targetInventoryUsdso.toFixed(0) : ""})` : "";

    if (elZoneStatusBadge) {
      if (data.isPaused) {
        elZoneStatusBadge.textContent = `ZONE: PAUSED (MONITORING • ${pos.toFixed(1)}%)`;
        elZoneStatusBadge.className = "zone-status-badge badge-warmup";
      } else if (data.isBelowFloor) {
        const hasLots = (lots && lots.length > 0) || (data.positionUsdso && data.positionUsdso > 0.05);
        if (hasLots) {
          elZoneStatusBadge.textContent = "ZONE: 0% FLOOR (CUT LOSS)";
          elZoneStatusBadge.className = "zone-status-badge badge-breakdown";
        } else {
          elZoneStatusBadge.textContent = "ZONE: BELOW FLOOR (100% CASH)";
          elZoneStatusBadge.className = "zone-status-badge badge-warmup";
        }
      } else if (data.waitingForHigherLow || data.waitingForNewValley) {
        elZoneStatusBadge.textContent = "ZONE: PAUSED (WAIT HIGHER LOW)";
        elZoneStatusBadge.className = "zone-status-badge badge-breakdown";
      } else if (data.isAboveCeiling) {
        elZoneStatusBadge.textContent = "ZONE: 100% CEIL (FULL EXIT)";
        elZoneStatusBadge.className = "zone-status-badge badge-breakout";
      } else if (pos < 18) {
        elZoneStatusBadge.textContent = `ZONE: BUFFER (0%-18% HOLD 100%)`;
        elZoneStatusBadge.className = "zone-status-badge badge-warmup";
      } else if (pos < 50) {
        elZoneStatusBadge.textContent = `ZONE: BUY ZONE (${pos.toFixed(1)}%${targetHoldStr})`;
        elZoneStatusBadge.className = "zone-status-badge badge-inzone";
      } else {
        elZoneStatusBadge.textContent = `ZONE: SELL ZONE (${pos.toFixed(1)}%${targetHoldStr})`;
        elZoneStatusBadge.className = "zone-status-badge badge-breakout";
      }
    }

    // Lots & Position Count
    const lots = data.lots || [];
    const holdPct = data.currentHoldPct !== undefined ? data.currentHoldPct : 0;
    const invUsd = data.inventoryUsdso || 0;
    const maxInvUsd = data.maxInventoryUsdso || 90;
    let totalBase = 0;
    lots.forEach((lot) => totalBase += (lot.qty || 0));

    // 0. Binance Account Balance Updates
    activeBaseAsset = data.baseAsset || activeBaseAsset || "BASE";
    activeQuoteAsset = data.quoteAsset || activeQuoteAsset || "USDT";
    const baseSym = activeBaseAsset;
    const quoteSym = activeQuoteAsset;
    const walletAddr = data.walletAddress || "";
    const shortAddr = walletAddr ? `${walletAddr.slice(0, 6)}...${walletAddr.slice(-4)}` : "Binance Spot";
    const somiBal = data.walletBaseBalance !== undefined ? data.walletBaseBalance : (data.walletSomiBalance !== undefined ? data.walletSomiBalance : 0);
    const usdsoBal = data.walletQuoteBalance !== undefined ? data.walletQuoteBalance : (data.walletUsdsoBalance !== undefined ? data.walletUsdsoBalance : 0);
    const somiVal = somiBal * (data.mid || 0);
    const totalVal = data.walletTotalValueQuote !== undefined ? data.walletTotalValueQuote : (somiVal + usdsoBal);

    const tradingSomi = data.tradingSomiBalance !== undefined ? data.tradingSomiBalance : totalBase;
    const gasReserve = data.gasReserveSomi !== undefined ? data.gasReserveSomi : Math.max(0, somiBal - tradingSomi);

    if (elNavWalletAddr) elNavWalletAddr.textContent = shortAddr;
    if (elNavWalletSomi) {
      elNavWalletSomi.textContent = `${somiBal.toFixed(4)} ${baseSym}`;
      elNavWalletSomi.title = `Spot Wallet: ${somiBal.toFixed(4)} ${baseSym}\n• Trading: ${tradingSomi.toFixed(4)} ${baseSym}`;
    }
    if (elNavWalletUsdso) elNavWalletUsdso.textContent = `$${usdsoBal.toFixed(2)} ${quoteSym}`;

    if (elTopWalletAddrBadge) elTopWalletAddrBadge.textContent = shortAddr;
    if (elTopWalletSomi) {
      elTopWalletSomi.textContent = `${somiBal.toFixed(4)} ${baseSym}`;
      elTopWalletSomi.title = `Total: ${somiBal.toFixed(4)} ${baseSym} (Trading: ${tradingSomi.toFixed(4)})`;
    }
    if (elTopWalletUsdso) elTopWalletUsdso.textContent = `$${usdsoBal.toFixed(2)} ${quoteSym}`;
    if (elTopWalletTotalVal) {
      elTopWalletTotalVal.textContent = `Total: $${totalVal.toFixed(2)}`;
      elTopWalletTotalVal.title = `Total Portfolio Value: $${totalVal.toFixed(2)}`;
    }

    // 1. Top KPI: Position Allocation
    if (elTopPosBadge) elTopPosBadge.textContent = `${holdPct.toFixed(1)}%`;
    if (elTopPosBase) elTopPosBase.textContent = `${totalBase.toFixed(4)} ${baseSym}`;
    if (elTopPosUsd) elTopPosUsd.textContent = `$${invUsd.toFixed(2)}`;
    if (elTopMaxInv) elTopMaxInv.textContent = maxInvUsd.toFixed(0);

    // 2. Top KPI: Capacity Load
    const invPct = Math.min(100, Math.round((invUsd / maxInvUsd) * 100));
    if (elTopCapPct) elTopCapPct.textContent = `${invPct}% Load`;
    if (elInventoryUsd) elInventoryUsd.textContent = `$${invUsd.toFixed(2)}`;
    if (elInventoryProgress) elInventoryProgress.style.width = `${invPct}%`;

    // 3. Top KPI: Unrealized Profit
    const upnl = data.unrealizedPnl || 0;
    const upnlPct = invUsd > 0 ? (upnl / invUsd) * 100 : 0;
    const upnlStr = (upnl >= 0 ? "+$" : "-$") + Math.abs(upnl).toFixed(2);
    const upnlPctStr = (upnl >= 0 ? "+" : "") + upnlPct.toFixed(2) + "%";

    if (elPosUnrealizedPnl) {
      elPosUnrealizedPnl.textContent = `${upnlStr} (${upnlPctStr})`;
      elPosUnrealizedPnl.className = "kpi-val " + (upnl > 0 ? "pnl-positive" : upnl < 0 ? "pnl-negative" : "pnl-neutral");
    }
    if (elPosUnrealizedPnlSub) {
      elPosUnrealizedPnlSub.textContent = upnlStr;
      elPosUnrealizedPnlSub.className = "pos-val " + (upnl > 0 ? "pnl-positive" : upnl < 0 ? "pnl-negative" : "pnl-neutral");
    }
    if (elTopUnrealizedBadge) {
      elTopUnrealizedBadge.textContent = upnlPctStr;
      elTopUnrealizedBadge.className = "kpi-badge " + (upnl > 0 ? "badge-buy-pill" : upnl < 0 ? "badge-sell-pill" : "badge-neutral");
    }

    const avgPrice = data.avgEntryPrice && data.avgEntryPrice > 0 ? `$${data.avgEntryPrice.toFixed(6)}` : "--.------";
    if (elPosAvgEntry) elPosAvgEntry.textContent = avgPrice;
    if (elPosAvgEntrySub) elPosAvgEntrySub.textContent = avgPrice;

    // 4. Top KPI: Net Realized PnL, Trade Profit & Gas Deduction
    const elKpiTradePnl = document.getElementById("kpiTradePnl");
    const elKpiGasSpent = document.getElementById("kpiGasSpent");

    const tradePnl = data.tradeRealizedPnl !== undefined ? data.tradeRealizedPnl : (data.realizedPnl || 0);
    const gasDeductedUsdso = data.totalGasDeductedUsdso || 0;
    const gasDeductedSomi = data.totalGasDeductedSomi || 0;
    const totalGasSpentSomi = data.totalGasSpentSomi || 0;
    const totalGasSpentUsdso = data.totalGasSpentUsdso || 0;
    const pendingGasSomi = data.accumulatedGasSomi || 0;
    const netPnl = data.netPnlUsdso !== undefined ? data.netPnlUsdso : (tradePnl - gasDeductedUsdso);

    if (elRealizedPnl) {
      elRealizedPnl.textContent = (netPnl >= 0 ? "+$" : "-$") + Math.abs(netPnl).toFixed(4);
      elRealizedPnl.className = "kpi-val " + (netPnl > 0 ? "pnl-positive" : netPnl < 0 ? "pnl-negative" : "pnl-neutral");
      elRealizedPnl.title = `Net Realized: ${netPnl >= 0 ? "+$" : "-$"}${Math.abs(netPnl).toFixed(4)} ${quoteSym}\nTrade Profit (Gross): ${tradePnl >= 0 ? "+$" : "-$"}${Math.abs(tradePnl).toFixed(4)} ${quoteSym}`;
    }
    if (elKpiTradePnl) {
      elKpiTradePnl.textContent = `Trade: ${tradePnl >= 0 ? "+$" : "-$"}${Math.abs(tradePnl).toFixed(2)}`;
      elKpiTradePnl.title = `Trade Profit: ${tradePnl >= 0 ? "+$" : "-$"}${Math.abs(tradePnl).toFixed(4)} ${quoteSym}`;
    }
    if (elKpiGasSpent) {
      if (totalGasSpentSomi > 0) {
        elKpiGasSpent.textContent = `Fee: -${totalGasSpentSomi.toFixed(4)} ${baseSym}`;
        elKpiGasSpent.title = `Total Trading Fee/Gas: ${totalGasSpentSomi.toFixed(4)} ${baseSym}`;
        elKpiGasSpent.style.display = "";
      } else {
        elKpiGasSpent.style.display = "none";
      }
    }
    if (elLotsCount) elLotsCount.textContent = `${lots.length} Open Lots`;
    if (elLotsBadgeCount) elLotsBadgeCount.textContent = `${holdPct.toFixed(0)}%`;

    if (elPosCurrentHold) {
      elPosCurrentHold.textContent = `$${invUsd.toFixed(2)} (${holdPct.toFixed(0)}%)`;
    }
    if (elPosTargetHold) {
      const targetPct = data.targetHoldingPct !== undefined ? data.targetHoldingPct.toFixed(0) : "0";
      const targetUsd = data.targetInventoryUsdso !== undefined ? data.targetInventoryUsdso.toFixed(0) : "0";
      elPosTargetHold.textContent = `${targetPct}% ($${targetUsd})`;
    }

    // Dow Regime Badge
    if (data.regime && elRegimeBadge) {
      elRegimeBadge.textContent = `DOW: ${data.regime}`;
      elRegimeBadge.className =
        "regime-badge " +
        (data.regime === "RANGE"
          ? "badge-range"
          : data.regime === "UPTREND"
            ? "badge-uptrend"
            : data.regime === "DOWNTREND"
              ? "badge-downtrend"
              : "badge-warmup");
    }

    // 5. Next Buy Trigger
    if (data.buyTrigger !== undefined && elHudBuyTrigger) {
      elHudBuyTrigger.textContent = `$${data.buyTrigger.toFixed(6)}`;
      const isCapacityFull = (data.currentHoldPct !== undefined && data.currentHoldPct >= 95) ||
        (data.inventoryUsdso !== undefined && data.maxInventoryUsdso !== undefined && data.inventoryUsdso >= data.maxInventoryUsdso - 1.0);
      const isUnderTrendline = (data.trendlineFilter || data.trendlineFiltered) && data.downtrendLine && !data.downtrendLine.isBroken;
      let buyStatus = "Ready to Accumulate";
      if (isCapacityFull) {
        buyStatus = "Capacity Full (100%)";
      } else if (isUnderTrendline) {
        buyStatus = data.downtrendLine.brokenCandleCount === 1 ? "TL Confirming (1/2 bars)" : "Waiting TL Breakout";
      }
      else if (data.waitingForHigherLow || data.waitingForNewValley) buyStatus = "Waiting Higher Low";
      else if (pos >= 50) buyStatus = "Waiting Dip (<50%)";
      else if (data.trendFiltered) buyStatus = "Downtrend Paused";
      else if (data.laggardGuardActive) buyStatus = "Lag Guard Active";
      if (elTopBuyStatusText) elTopBuyStatusText.textContent = buyStatus;
    }

    // 6. Next Sell Trigger
    if (data.sellTrigger !== undefined && elHudSellTrigger) {
      elHudSellTrigger.textContent = `$${data.sellTrigger.toFixed(6)}`;
      let sellStatus = lots.length > 0 ? "Profit-Taking Level" : "No Position Held";
      if (data.isTlSellTrigger) {
        sellStatus = "TL Exit (Active 🔴)";
      } else if (pos < 50 && lots.length > 0) {
        sellStatus = "Waiting Rally (>50%)";
      }
      if (elTopSellStatusText) elTopSellStatusText.textContent = sellStatus;
    }

    // Hold Protection Timer
    if (elStuckTimer) {
      if (data.stuckSince && data.stuckTimeoutMs > 0 && lots.length > 0) {
        const elapsed = Date.now() - data.stuckSince;
        const remainingMs = Math.max(0, data.stuckTimeoutMs - elapsed);
        const remainingMins = Math.ceil(remainingMs / 60000);
        const pct = Math.min(100, (elapsed / data.stuckTimeoutMs) * 100);

        elStuckTimer.textContent = `${remainingMins}m left`;
        if (elStuckTimerDesc) {
          elStuckTimerDesc.textContent = `Unwind cut at 0m (${Math.round(data.stuckTimeoutMs / 60000)}m hold limit)`;
        }
        if (elStuckProgress) elStuckProgress.style.width = `${pct}%`;
      } else {
        elStuckTimer.textContent = lots.length > 0 ? "Target Active" : "Flat";
        if (elStuckTimerDesc) {
          elStuckTimerDesc.textContent = lots.length > 0 ? "Holding take profit" : "No open lots held";
        }
        if (elStuckProgress) elStuckProgress.style.width = "0%";
      }
    }

    // ── Update Price Lines on Chart ──────────────────────────────────────────
    if (candleSeries) {
      // 1. 100% Upper Bound (Full Exit) - Solid Fuchsia / Magenta
      if (data.upperBound) {
        lineUpperBound = setPriceLine(lineUpperBound, {
          price: data.upperBound,
          color: "#d946ef",
          lineWidth: 2,
          lineStyle: LightweightCharts.LineStyle.Solid,
          axisLabelVisible: true,
          title: data.isChannelLocked ? "🔒 Locked Ceil" : "",
        });
      }

      // 1.1 Real Current Calculated Resistance Bound (Dashed Fuchsia / Magenta Line)
      if (
        data.isChannelLocked &&
        data.liveCalculatedUpperBound &&
        Math.abs(data.liveCalculatedUpperBound - data.upperBound) / data.upperBound > 0.001
      ) {
        lineLiveCalculatedUpperBound = setPriceLine(lineLiveCalculatedUpperBound, {
          price: data.liveCalculatedUpperBound,
          color: "#e879f9",
          lineWidth: 2,
          lineStyle: LightweightCharts.LineStyle.Dashed,
          axisLabelVisible: true,
          title: "🎯 Real S/R Ceil",
        });
      } else if (lineLiveCalculatedUpperBound) {
        try { candleSeries.removePriceLine(lineLiveCalculatedUpperBound); } catch (_) {}
        lineLiveCalculatedUpperBound = null;
      }

      // 1.2 Real Current Calculated Support Bound (Dashed Purple Line, if differs from locked floor)
      if (
        data.isChannelLocked &&
        data.liveCalculatedBottomBound &&
        Math.abs(data.liveCalculatedBottomBound - data.bottomBound) / data.bottomBound > 0.001
      ) {
        lineLiveCalculatedBottomBound = setPriceLine(lineLiveCalculatedBottomBound, {
          price: data.liveCalculatedBottomBound,
          color: "#a855f7",
          lineWidth: 2,
          lineStyle: LightweightCharts.LineStyle.Dashed,
          axisLabelVisible: true,
          title: "🎯 Real S/R Floor",
        });
      } else if (lineLiveCalculatedBottomBound) {
        try { candleSeries.removePriceLine(lineLiveCalculatedBottomBound); } catch (_) {}
        lineLiveCalculatedBottomBound = null;
      }

      // 2. 50% Channel Center (Midline) - Dashed Amber
      if (data.centerPrice) {
        lineCenter = setPriceLine(lineCenter, {
          price: data.centerPrice,
          color: "#fbbf24",
          lineWidth: 2,
          lineStyle: LightweightCharts.LineStyle.Dashed,
          axisLabelVisible: true,
          title: "",
        });
      }

      // 3. 0% Lower Bound (Structural Grid Floor) - Solid Purple
      if (data.bottomBound) {
        lineBottomBound = setPriceLine(lineBottomBound, {
          price: data.bottomBound,
          color: "#c084fc",
          lineWidth: 2,
          lineStyle: LightweightCharts.LineStyle.Solid,
          axisLabelVisible: true,
          title: data.isChannelLocked ? "🔒 Locked Floor" : "",
        });
      }

      // 3.1 Cut Loss Trigger Buffer Line - Dashed Slate Silver
      if (data.cutLossBound && data.cutLossBound < data.bottomBound) {
        const bufDelta = data.bottomBound - data.cutLossBound;
        const bufPct = (bufDelta / data.bottomBound) * 100;
        lineCutLossBound = setPriceLine(lineCutLossBound, {
          price: data.cutLossBound,
          color: "#94a3b8",
          lineWidth: 2,
          lineStyle: LightweightCharts.LineStyle.Dashed,
          axisLabelVisible: true,
          title: "",
        });
      } else if (lineCutLossBound) {
        candleSeries.removePriceLine(lineCutLossBound);
        lineCutLossBound = null;
      }

      // 4. Intermediate Grid Levels in Buy and Sell Zones (Clean line only, no overlapping canvas labels)
      let buyLevels = Array.isArray(data.buyLevels) && data.buyLevels.length >= 4
        ? data.buyLevels
        : (data.bottomBound && data.upperBound
            ? [
                data.bottomBound + (data.upperBound - data.bottomBound) * 0.40,
                data.bottomBound + (data.upperBound - data.bottomBound) * 0.30,
                data.bottomBound + (data.upperBound - data.bottomBound) * 0.20,
                data.bottomBound + (data.upperBound - data.bottomBound) * 0.10,
              ]
            : (data.buyLevels || []));

      let sellLevels = Array.isArray(data.sellLevels) && data.sellLevels.length >= 4
        ? data.sellLevels
        : (data.bottomBound && data.upperBound
            ? [
                data.bottomBound + (data.upperBound - data.bottomBound) * 0.60,
                data.bottomBound + (data.upperBound - data.bottomBound) * 0.70,
                data.bottomBound + (data.upperBound - data.bottomBound) * 0.80,
                data.bottomBound + (data.upperBound - data.bottomBound) * 0.90,
              ]
            : (data.sellLevels || []));

      const allLevels = [...buyLevels, ...sellLevels].filter(Number.isFinite);

      if (allLevels.length > 0) {
        while (gridZoneLevelLines.length < allLevels.length) {
          const l = candleSeries.createPriceLine({
            price: allLevels[gridZoneLevelLines.length] || 0,
            color: "rgba(255, 255, 255, 0.15)",
            lineWidth: 1,
            lineStyle: LightweightCharts.LineStyle.Dotted,
            axisLabelVisible: true,
            title: "",
          });
          if (l) gridZoneLevelLines.push(l);
          else break;
        }
        while (gridZoneLevelLines.length > allLevels.length) {
          const excess = gridZoneLevelLines.pop();
          if (excess) {
            try { candleSeries.removePriceLine(excess); } catch (_) {}
          }
        }

        let lineIdx = 0;
        // Buy Levels (40%, 30%, 20%, 10%) - Dotted sky blue / cyan lines
        buyLevels.forEach((lvl) => {
          if (Number.isFinite(lvl) && gridZoneLevelLines[lineIdx]) {
            gridZoneLevelLines[lineIdx].applyOptions({
              price: lvl,
              color: "rgba(56, 189, 248, 0.70)",
              axisLabelVisible: true,
              title: "",
            });
            lineIdx++;
          }
        });

        // Sell Levels (60%, 70%, 80%, 90%) - Dotted orange lines
        sellLevels.forEach((lvl) => {
          if (Number.isFinite(lvl) && gridZoneLevelLines[lineIdx]) {
            gridZoneLevelLines[lineIdx].applyOptions({
              price: lvl,
              color: "rgba(249, 115, 22, 0.50)",
              axisLabelVisible: true,
              title: "",
            });
            lineIdx++;
          }
        });
      }

      // Clean up legacy trigger lines if any to prevent duplicate price tags on axis
      if (lineBuyTrigger) {
        try { candleSeries.removePriceLine(lineBuyTrigger); } catch (_) { }
        lineBuyTrigger = null;
      }
      if (lineSellTrigger) {
        try { candleSeries.removePriceLine(lineSellTrigger); } catch (_) { }
        lineSellTrigger = null;
      }
    }

    // ── Trendline Series: Downtrend Resistance & Uptrend Support ─────────────
    if (downtrendLineSeries) {
      if (data.downtrendLine && Array.isArray(data.downtrendLine.points) && data.downtrendLine.points.length > 0) {
        const isBroken = data.downtrendLine.isBroken;
        const brokenCount = data.downtrendLine.brokenCandleCount || 0;
        try {
          downtrendLineSeries.applyOptions({
            color: isBroken ? "rgba(129, 140, 248, 0.40)" : brokenCount > 0 ? "#fbbf24" : "#818cf8",
            lineStyle: isBroken ? (LightweightCharts.LineStyle?.Dotted ?? 1) : (LightweightCharts.LineStyle?.Dashed ?? 2),
            lineWidth: isBroken ? 1 : 2,
            title: "",
          });
          const ptMap = new Map();
          for (const p of data.downtrendLine.points) {
            if (p && typeof p.time === "number" && Number.isFinite(p.time) && Number.isFinite(p.value)) {
              ptMap.set(p.time, { time: p.time, value: Number(p.value) });
            }
          }
          const cleanPoints = Array.from(ptMap.values()).sort((a, b) => a.time - b.time);
          downtrendLineSeries.setData(cleanPoints);
        } catch (err) {
          console.warn("downtrendLineSeries.setData error:", err);
        }
      } else {
        try { downtrendLineSeries.setData([]); } catch (_) {}
      }
    }

    if (uptrendLineSeries) {
      if (data.uptrendLine && Array.isArray(data.uptrendLine.points) && data.uptrendLine.points.length > 0) {
        const isBroken = data.uptrendLine.isBroken;
        const brokenCount = data.uptrendLine.brokenCandleCount || 0;
        try {
          uptrendLineSeries.applyOptions({
            color: isBroken ? "rgba(45, 212, 191, 0.40)" : brokenCount > 0 ? "#fbbf24" : "#2dd4bf",
            lineStyle: isBroken ? (LightweightCharts.LineStyle?.Dotted ?? 1) : (LightweightCharts.LineStyle?.Dashed ?? 2),
            lineWidth: isBroken ? 1 : 2,
            title: "",
          });
          const ptMap = new Map();
          for (const p of data.uptrendLine.points) {
            if (p && typeof p.time === "number" && Number.isFinite(p.time) && Number.isFinite(p.value)) {
              ptMap.set(p.time, { time: p.time, value: Number(p.value) });
            }
          }
          const cleanPoints = Array.from(ptMap.values()).sort((a, b) => a.time - b.time);
          uptrendLineSeries.setData(cleanPoints);
        } catch (err) {
          console.warn("uptrendLineSeries.setData error:", err);
        }
      } else {
        try { uptrendLineSeries.setData([]); } catch (_) {}
      }
    }

    // ── Wave Cycle Series: ZigZag Dow Swings & Wave Path ────────────────────
    if (waveCycleLineSeries) {
      if (isWaveVisible && data.waveCycle && Array.isArray(data.waveCycle.wavePoints) && data.waveCycle.wavePoints.length > 0) {
        try {
          // Stop zigzag line cleanly at the last confirmed swing destination if next point is not confirmed
          const swings = Array.isArray(data.waveCycle.annotatedSwings) ? data.waveCycle.annotatedSwings : [];
          const lastConfirmedSwing = swings.length > 0 ? swings[swings.length - 1] : null;
          const maxWaveTime = lastConfirmedSwing && typeof lastConfirmedSwing.time === "number" ? lastConfirmedSwing.time : Infinity;

          const ptMap = new Map();
          for (const p of data.waveCycle.wavePoints) {
            if (p && typeof p.time === "number" && Number.isFinite(p.time) && Number.isFinite(p.value)) {
              if (p.time <= maxWaveTime) {
                ptMap.set(p.time, { time: p.time, value: Number(p.value) });
              }
            }
          }
          const cleanPoints = Array.from(ptMap.values()).sort((a, b) => a.time - b.time);
          waveCycleLineSeries.setData(cleanPoints);
        } catch (err) {
          console.warn("waveCycleLineSeries.setData error:", err);
        }
      } else {
        try { waveCycleLineSeries.setData([]); } catch (_) {}
      }
    }

    if (elWaveStatusPill && elWaveStatusText) {
      if (data.waveCycle && data.waveCycle.activeCycleSummary) {
        elWaveStatusText.textContent = data.waveCycle.activeCycleSummary;
        elWaveStatusPill.style.display = "inline-flex";
      } else {
        elWaveStatusPill.style.display = "none";
      }
    }

    // ── Structure Markers: Dow Theory Swings (HH, LH, HL, LL & จุดเริ่มรอบ) ────
    if (data.swingHighs || data.swingLows || (data.waveCycle && data.waveCycle.annotatedSwings)) {
      const markerMap = new Map();

      // Multi-Touch S/R Touch Points Lookup (Active confirmed structural bounds)
      // Strictly filter to points genuinely touching the active channel bounds or live S/R bounds (within 1.5% tolerance)
      const activeResCluster = data.resistanceCluster || (data.isChannelLocked ? data.liveResistanceCluster : undefined);
      const resTouchPoints = (activeResCluster && Array.isArray(activeResCluster.points))
        ? activeResCluster.points.filter((p) => {
            if (!p || typeof p.price !== "number") return false;
            const matchesUpper = data.upperBound && Math.abs(p.price - data.upperBound) / data.upperBound <= 0.015;
            const matchesLive = data.liveCalculatedUpperBound && Math.abs(p.price - data.liveCalculatedUpperBound) / data.liveCalculatedUpperBound <= 0.015;
            return matchesUpper || matchesLive;
          })
        : [];
      const activeSupCluster = data.supportCluster || (data.isChannelLocked ? data.liveSupportCluster : undefined);
      const supTouchPoints = (activeSupCluster && Array.isArray(activeSupCluster.points))
        ? activeSupCluster.points.filter((p) => {
            if (!p || typeof p.price !== "number") return false;
            const matchesBottom = data.bottomBound && Math.abs(p.price - data.bottomBound) / data.bottomBound <= 0.015;
            const matchesLive = data.liveCalculatedBottomBound && Math.abs(p.price - data.liveCalculatedBottomBound) / data.liveCalculatedBottomBound <= 0.015;
            return matchesBottom || matchesLive;
          })
        : [];

      const resTouchTimes = new Map();
      resTouchPoints.forEach((p, idx) => {
        if (p && typeof p.time === "number") {
          resTouchTimes.set(p.time, { num: idx + 1, total: resTouchPoints.length, price: p.price });
        }
      });

      const supTouchTimes = new Map();
      supTouchPoints.forEach((p, idx) => {
        if (p && typeof p.time === "number") {
          supTouchTimes.set(p.time, { num: idx + 1, total: supTouchPoints.length, price: p.price });
        }
      });

      // Get annotated swings from backend or compute with client fallback
      const annotated = (data.waveCycle && Array.isArray(data.waveCycle.annotatedSwings) && data.waveCycle.annotatedSwings.length > 0)
        ? data.waveCycle.annotatedSwings
        : getClientAnnotatedSwings(data);

      // ── Build swing HTML overlay badges (replaces TradingView text markers for swings) ──
      const newSwingBadges = [];

      // Helper: push a swing badge descriptor
      function pushSwingBadge(time, price, label, icon, cssClass, below, title) {
        newSwingBadges.push({ key: `swing_${time}`, time, price, label, icon, cssClass, below, title: title || "" });
      }

      // Track which swing times already have badges so we don't double-add
      const swingBadgeTimes = new Set();

      if (Array.isArray(annotated) && annotated.length > 0) {
        for (const s of annotated) {
          if (!s || typeof s.time !== "number") continue;
          const isActiveHigh = Boolean(data.activePeak   && data.activePeak.time   === s.time);
          const isActiveLow  = Boolean(data.activeValley && data.activeValley.time === s.time);
          const isActive = isActiveHigh || isActiveLow;
          const isResTouch = resTouchTimes.has(s.time);
          const isSupTouch = supTouchTimes.has(s.time);
          const isTouch = isResTouch || isSupTouch;

          // If wave is hidden, only show active key bounds AND S/R touch points
          if (!isWaveVisible && !isActive && !isTouch) continue;

          if (s.type === "HIGH") {
            // S/R touch peaks → badge sits ON the actual candle top (s.price), not floating at cluster line
            if (isResTouch) {
              const count = activeResCluster?.touchCount || data.resistanceCluster?.touchCount || 0;
              const clusterPrice = activeResCluster?.price ?? data.resistanceCluster?.price ?? s.price;
              const label = count > 1 ? `${count}x` : "1x";
              if (!swingBadgeTimes.has(s.time)) {
                // Y = s.price so badge sits exactly on THIS candle's high
                pushSwingBadge(s.time, s.price, label, "🎯", "badge-res-touch", false,
                  `Resistance touch ${label} @ ${s.price?.toFixed ? s.price.toFixed(6) : s.price} (level ${clusterPrice?.toFixed ? clusterPrice.toFixed(6) : clusterPrice})`);
                swingBadgeTimes.add(s.time);
              }
              continue;
            }

            // Swing peak → HTML badge
            let label, icon, cssClass, title;
            if (isActive) {
              const dl = s.dowLabel || "HH";
              icon = "⛰️"; label = dl; cssClass = "badge-active-peak";
              title = `Active Peak (${dl}) — resistance ceiling`;
            } else if (s.isTransitionStart) {
              if (s.transitionType === "START_HH") {
                icon = "🚀"; label = "HH"; cssClass = "badge-hh badge-transition";
              } else {
                icon = "⚠️"; label = "LH"; cssClass = "badge-lh badge-transition";
              }
              title = s.transitionType || "";
            } else {
              const isHH = s.dowLabel === "HH";
              icon = "⛰️"; label = isHH ? "HH" : "LH";
              cssClass = isHH ? "badge-hh" : "badge-lh";
              title = `${label} @ ${s.price?.toFixed ? s.price.toFixed(6) : s.price}`;
            }
            pushSwingBadge(s.time, s.price, label, icon, cssClass, false, title);
            swingBadgeTimes.add(s.time);

          } else {
            // LOW (เหว)
            // S/R touch valleys → badge sits ON the actual candle bottom (s.price)
            if (isSupTouch) {
              const count = activeSupCluster?.touchCount || data.supportCluster?.touchCount || 0;
              const clusterPrice = activeSupCluster?.price ?? data.supportCluster?.price ?? s.price;
              const label = count > 1 ? `${count}x` : "1x";
              if (!swingBadgeTimes.has(s.time)) {
                // Y = s.price so badge sits exactly on THIS candle's low
                pushSwingBadge(s.time, s.price, label, "🎯", "badge-sup-touch", true,
                  `Support touch ${label} @ ${s.price?.toFixed ? s.price.toFixed(6) : s.price} (level ${clusterPrice?.toFixed ? clusterPrice.toFixed(6) : clusterPrice})`);
                swingBadgeTimes.add(s.time);
              }
              continue;
            }

            // Swing valley → HTML badge
            let label, icon, cssClass, title;
            if (isActive) {
              const dl = s.dowLabel || "HL";
              icon = "🌊"; label = dl; cssClass = "badge-active-valley";
              title = `Active Valley (${dl}) — support floor`;
            } else if (s.isTransitionStart) {
              if (s.transitionType === "START_HL") {
                icon = "⭐"; label = "HL"; cssClass = "badge-hl badge-transition";
              } else {
                icon = "💥"; label = "LL"; cssClass = "badge-ll badge-transition";
              }
              title = s.transitionType || "";
            } else {
              const isHL = s.dowLabel === "HL";
              icon = "🌊"; label = isHL ? "HL" : "LL";
              cssClass = isHL ? "badge-hl" : "badge-ll";
              title = `${label} @ ${s.price?.toFixed ? s.price.toFixed(6) : s.price}`;
            }
            if (!swingBadgeTimes.has(s.time)) {
              pushSwingBadge(s.time, s.price, label, icon, cssClass, true, title);
              swingBadgeTimes.add(s.time);
            }
          }
        }
      }

      // Guarantee any remaining Resistance touch points that weren't in annotated swings
      // Use info.price (the actual touch point price) so badge sits on the candle
      for (const [t, info] of resTouchTimes.entries()) {
        if (!swingBadgeTimes.has(t)) {
          const count = data.resistanceCluster?.touchCount || 0;
          const clusterPrice = data.resistanceCluster?.price ?? info.price;
          pushSwingBadge(t, info.price, count > 1 ? `${count}x` : "1x", "🎯", "badge-res-touch", false,
            `Resistance touch @ ${info.price?.toFixed ? info.price.toFixed(6) : info.price} (level ${clusterPrice?.toFixed ? clusterPrice.toFixed(6) : clusterPrice})`);
          swingBadgeTimes.add(t);
        }
      }

      // Guarantee any remaining Support touch points that weren't in annotated swings
      // Use info.price (the actual touch point price) so badge sits on the candle
      for (const [t, info] of supTouchTimes.entries()) {
        if (!swingBadgeTimes.has(t)) {
          const count = data.supportCluster?.touchCount || 0;
          const clusterPrice = data.supportCluster?.price ?? info.price;
          pushSwingBadge(t, info.price, count > 1 ? `${count}x` : "1x", "🎯", "badge-sup-touch", true,
            `Support touch @ ${info.price?.toFixed ? info.price.toFixed(6) : info.price} (level ${clusterPrice?.toFixed ? clusterPrice.toFixed(6) : clusterPrice})`);
          swingBadgeTimes.add(t);
        }
      }

      // Guarantee Active Peak badge (in case not in annotated list)
      if (data.activePeak && typeof data.activePeak.time === "number" && !swingBadgeTimes.has(data.activePeak.time)) {
        const dl = data.activePeak.dowLabel || "HH";
        pushSwingBadge(data.activePeak.time, data.activePeak.price, dl, "⛰️", "badge-active-peak", false, `Active Peak (${dl})`);
        swingBadgeTimes.add(data.activePeak.time);
      }

      // Guarantee Active Valley badge (in case not in annotated list)
      if (data.activeValley && typeof data.activeValley.time === "number" && !swingBadgeTimes.has(data.activeValley.time)) {
        const dl = data.activeValley.dowLabel || "HL";
        pushSwingBadge(data.activeValley.time, data.activeValley.price, dl, "🌊", "badge-active-valley", true, `Active Valley (${dl})`);
        swingBadgeTimes.add(data.activeValley.time);
      }

      // Candidate Peak badge (unconfirmed, only when wave visible)
      if (isWaveVisible && data.candidatePeak && typeof data.candidatePeak.time === "number" && !swingBadgeTimes.has(data.candidatePeak.time)) {
        const prog = `${data.candidatePeak.confirmationCandles}/${data.candidatePeak.requiredCandles}`;
        pushSwingBadge(data.candidatePeak.time, data.candidatePeak.price, prog, "⏳", "badge-candidate", false, `Candidate Peak (${prog} bars confirmed)`);
      }

      // Candidate Valley badge (unconfirmed, only when wave visible)
      if (isWaveVisible && data.candidateValley && typeof data.candidateValley.time === "number" && !swingBadgeTimes.has(data.candidateValley.time)) {
        const prog = `${data.candidateValley.confirmationCandles}/${data.candidateValley.requiredCandles}`;
        pushSwingBadge(data.candidateValley.time, data.candidateValley.price, prog, "⏳", "badge-candidate", true, `Candidate Valley (${prog} bars confirmed)`);
      }

      // Commit swing badges
      swingBadgesData = newSwingBadges;
      updateSwingBadgesDom();
      updateSwingBadgesPositions();

      structureMarkers = Array.from(markerMap.values());
      refreshMarkers();

    }


    // Render Open Lots Table
    renderLotsTable(lots, data.stepPct, data.mid);

    // Render Open Resting Orders Table
    renderOpenOrdersTable(data.openOrders || [], data.mid);
  }

  function renderLotsTable(lots, stepPct, mid) {
    if (!elLotsTableBody) return;
    if (!lots || lots.length === 0) {
      elLotsTableBody.innerHTML = `
        <tr class="empty-row">
          <td colspan="4">No open position (0% Allocation)</td>
        </tr>`;
      if (elLotsTotalBase) elLotsTotalBase.textContent = `0.00 ${activeBaseAsset}`;
      return;
    }

    let totalBase = 0;
    let totalValue = 0;
    lots.forEach((lot) => {
      totalBase += lot.qty;
      totalValue += lot.qty * (mid || lot.price);
    });

    let html = "";
    lots.forEach((lot, idx) => {
      const lotVal = lot.qty * (mid || lot.price);
      const weightPct = totalValue > 0 ? (lotVal / totalValue) * 100 : 0;

      html += `
        <tr>
          <td>Entry #${idx + 1}</td>
          <td>$${lot.price.toFixed(6)}</td>
          <td>$${lotVal.toFixed(2)}</td>
          <td style="color: #38bdf8;">${weightPct.toFixed(0)}%</td>
        </tr>`;
    });

    elLotsTableBody.innerHTML = html;
    elLotsTotalBase.textContent = `${totalBase.toFixed(4)} ${activeBaseAsset} ($${totalValue.toFixed(2)})`;
  }

  function renderOpenOrdersTable(openOrders, mid) {
    if (!elOpenOrdersTableBody) return;
    if (!openOrders || openOrders.length === 0) {
      elOpenOrdersTableBody.innerHTML = `
        <tr class="empty-row">
          <td colspan="5">No resting maker orders in book</td>
        </tr>`;
      if (elOpenOrdersBadgeCount) elOpenOrdersBadgeCount.textContent = "0";
      if (elOpenOrdersTotalValue) elOpenOrdersTotalValue.textContent = "$0.00 Waiting";
      return;
    }

    let totalValue = 0;
    openOrders.forEach((o) => {
      totalValue += o.notionalUsdso || (o.price * o.qty);
    });

    if (elOpenOrdersBadgeCount) elOpenOrdersBadgeCount.textContent = `${openOrders.length}`;
    if (elOpenOrdersTotalValue) elOpenOrdersTotalValue.textContent = `$${totalValue.toFixed(2)} Waiting`;

    // Sort: BUYs first (highest price first), then SELLs (lowest target price first)
    const sortedOrders = [...openOrders].sort((a, b) => {
      if (a.isBid && !b.isBid) return -1;
      if (!a.isBid && b.isBid) return 1;
      if (a.isBid) return b.price - a.price;
      return a.price - b.price;
    });

    let html = "";
    sortedOrders.forEach((o) => {
      const isBid = o.isBid;
      const sideClass = isBid ? "highlight-green" : "highlight-red";
      const sideText = isBid ? "BUY" : "SELL";
      const notional = o.notionalUsdso || (o.price * o.qty);

      // Expiration time calculation
      let expText = "24h";
      let expClass = "";
      if (o.expireTime) {
        const remainingMs = Math.max(0, o.expireTime - Date.now());
        const remainingHours = Math.floor(remainingMs / (1000 * 60 * 60));
        const remainingMins = Math.floor((remainingMs % (1000 * 60 * 60)) / (1000 * 60));
        if (remainingHours > 0) {
          expText = `${remainingHours}h ${remainingMins}m`;
          expClass = remainingHours < 2 ? "highlight-amber" : "";
        } else if (remainingMins > 0) {
          expText = `${remainingMins}m`;
          expClass = "highlight-amber";
        } else if (remainingMs > 0) {
          expText = `<1m`;
          expClass = "highlight-red";
        } else {
          expText = "Expired";
          expClass = "highlight-red";
        }
      }

      html += `
        <tr>
          <td class="${sideClass}" style="font-weight: 700;">${sideText}</td>
          <td>${o.levelDesc || "-"}</td>
          <td style="font-family: var(--font-mono);">$${o.price.toFixed(6)}</td>
          <td>${o.qty.toFixed(2)}</td>
          <td style="font-family: var(--font-mono);">$${notional.toFixed(2)}</td>
          <td class="${expClass}" style="font-family: var(--font-mono); font-size: 11px;">⏳ ${expText}</td>
        </tr>`;
    });

    elOpenOrdersTableBody.innerHTML = html;
  }

  function getCandleTimeForTimestamp(timestamp) {
    if (!timestamp) return latestCandleTime;
    const sec = timestamp > 1e11 ? Math.floor(timestamp / 1000) : Math.floor(timestamp);

    if (pendingCandles && pendingCandles.length > 0) {
      // Find the candle bar where candle.time <= sec
      for (let i = pendingCandles.length - 1; i >= 0; i--) {
        if (pendingCandles[i].time <= sec) {
          return pendingCandles[i].time;
        }
      }
      return pendingCandles[0].time;
    }
    return latestCandleTime || sec;
  }

  // Web Audio Alert Chimes
  function playAudioAlert(type) {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      if (ctx.state === "suspended") {
        ctx.resume().catch(() => {});
      }
      const now = ctx.currentTime;
      if (type === "BUY") {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(880, now);
        osc.frequency.exponentialRampToValueAtTime(1320, now + 0.12);
        gain.gain.setValueAtTime(0.12, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.35);
      } else if (type === "SELL") {
        [587, 880, 1174].forEach((freq, idx) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = "triangle";
          osc.frequency.setValueAtTime(freq, now + idx * 0.08);
          gain.gain.setValueAtTime(0.1, now + idx * 0.08);
          gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.08 + 0.35);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(now + idx * 0.08);
          osc.stop(now + idx * 0.08 + 0.35);
        });
      } else if (type === "CUT") {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sawtooth";
        osc.frequency.setValueAtTime(440, now);
        osc.frequency.setValueAtTime(330, now + 0.15);
        gain.gain.setValueAtTime(0.15, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.45);
      }
    } catch (_) {}
  }

  function showTradeToast(order) {
    if (!elToastContainer || !order) return;
    const action = order.action || "BUY";
    const isBuy = ["BUY", "BUY_FILL", "SNIPE_BUY"].includes(action);
    const isSell = ["SELL", "SELL_FILL", "TAKE_PROFIT", "SNIPE_SELL"].includes(action);
    const isCut = action === "CUT";
    const isExit = action === "EXIT";
    if (!isBuy && !isSell && !isCut && !isExit) return;

    playAudioAlert(isBuy ? "BUY" : isCut ? "CUT" : "SELL");

    const toastClass = isBuy ? "toast-buy" : isSell ? "toast-sell" : isCut ? "toast-cut" : "toast-exit";
    const icon = isBuy ? "⚡" : isSell ? "🔥" : isCut ? "🚨" : "🎯";
    const isIoc = !order.maker || (order.levelDesc && order.levelDesc.includes("IOC")) || (order.reason && order.reason.includes("IOC"));
    const title = isBuy
      ? (isIoc ? "IOC BUY FILLED" : "MAKER BUY MATCHED")
      : isSell
      ? (isIoc ? "IOC SELL FILLED" : "MAKER SELL MATCHED")
      : isCut
      ? "CUT LOSS EXECUTED"
      : "100% TAKE PROFIT EXIT";
    const timeStr = new Date(order.time || Date.now()).toLocaleTimeString();
    const notional = (order.notionalQuote || order.notionalUsdso) ? `$${(order.notionalQuote || order.notionalUsdso).toFixed(2)}` : "";
    const qtyStr = order.qty ? `${order.qty.toFixed(4)} ${activeBaseAsset}` : "";
    const pnlStr = order.pnl !== undefined
      ? `<span class="${order.pnl >= 0 ? 'pnl-positive' : 'pnl-negative'}" style="font-weight:700;">${order.pnl >= 0 ? '+$' : '-$'}${Math.abs(order.pnl).toFixed(2)}</span>`
      : "";

    const toast = document.createElement("div");
    toast.className = `trade-toast ${toastClass}`;

    toast.innerHTML = `
      <div class="toast-header">
        <div class="toast-title-wrap">
          <span class="toast-icon">${icon}</span>
          <span class="toast-title">${title}</span>
        </div>
        <span class="toast-time">${timeStr}</span>
      </div>
      <div class="toast-body">
        <span class="toast-price">$${(order.price || 0).toFixed(6)}</span>
        <span class="toast-qty">${notional ? notional + ' • ' : ''}${qtyStr}</span>
        ${pnlStr}
      </div>
      <div class="toast-level">${order.levelDesc || ''} ${order.targetPct !== undefined ? `(Target: ${order.targetPct}%)` : ''}</div>
      <div class="toast-progress"></div>
    `;

    toast.addEventListener("click", () => {
      toast.style.animation = "toast-out 0.25s forwards";
      setTimeout(() => toast.remove(), 250);
    });

    elToastContainer.appendChild(toast);

    setTimeout(() => {
      if (toast.parentElement) {
        toast.style.animation = "toast-out 0.25s forwards";
        setTimeout(() => toast.remove(), 250);
      }
    }, 5000);
  }

  function showToast({ title, desc, action = "EXIT" }) {
    if (!elToastContainer) return;
    const toast = document.createElement("div");
    toast.className = `trade-toast toast-exit`;
    const icon = action === "ERROR" ? "❌" : "⚙️";
    const headerTitle = title || "SYSTEM NOTIFICATION";
    const timeStr = new Date().toLocaleTimeString();

    toast.innerHTML = `
      <div class="toast-header">
        <div class="toast-title-wrap">
          <span class="toast-icon">${icon}</span>
          <span class="toast-title">${headerTitle}</span>
        </div>
        <span class="toast-time">${timeStr}</span>
      </div>
      <div class="toast-body">
        <span style="font-size: 0.85rem; color: #e2e8f0;">${desc || ""}</span>
      </div>
      <div class="toast-progress"></div>
    `;

    toast.addEventListener("click", () => {
      toast.style.animation = "toast-out 0.25s forwards";
      setTimeout(() => toast.remove(), 250);
    });

    elToastContainer.appendChild(toast);

    setTimeout(() => {
      if (toast.parentElement) {
        toast.style.animation = "toast-out 0.25s forwards";
        setTimeout(() => toast.remove(), 250);
      }
    }, 4000);
  }

  // Activity Feed & Tabs Elements
  const elTradesFeed = document.getElementById("tradesFeed");
  const elOnchainFeed = document.getElementById("onchainFeed");
  const elAllFeed = document.getElementById("allFeed");
  const elTradesCount = document.getElementById("tradesCount");
  const elOnchainCount = document.getElementById("onchainCount");
  const elOrdersCount = document.getElementById("ordersCount");
  const tabTradesBtn = document.getElementById("tabTradesBtn");
  const tabOnchainBtn = document.getElementById("tabOnchainBtn");
  const tabAllBtn = document.getElementById("tabAllBtn");
  let tradesCount = 0;
  let onchainCount = 0;
  let allCount = 0;

  // Tab switching logic
  const actTabs = [
    { btn: tabTradesBtn, feed: elTradesFeed, name: "trades" },
    { btn: tabOnchainBtn, feed: elOnchainFeed, name: "onchain" },
    { btn: tabAllBtn, feed: elAllFeed, name: "all" },
  ];

  function switchActivityTab(name) {
    actTabs.forEach((t) => {
      const isMatch = t.name === name;
      if (t.btn) t.btn.classList.toggle("active", isMatch);
      if (t.feed) t.feed.style.display = isMatch ? "flex" : "none";
    });
  }

  actTabs.forEach((tab) => {
    if (tab.btn) {
      tab.btn.addEventListener("click", () => switchActivityTab(tab.name));
    }
  });

  function createActivityElement(order) {
    const div = document.createElement("div");
    div.className = "activity-item";

    let badgeClass = "act-neutral";
    let badgeText = order.action || "ORDER";
    if (order.action === "BUY" || order.action === "BUY_FILL" || order.action === "SNIPE_BUY") {
      badgeClass = "act-buy";
      badgeText = "BUY FILL";
    } else if (order.action === "SELL" || order.action === "SELL_FILL" || order.action === "TAKE_PROFIT" || order.action === "SNIPE_SELL") {
      badgeClass = "act-sell";
      badgeText = "SELL FILL";
    } else if (order.action === "CUT") {
      badgeClass = "act-cut";
      badgeText = "CUT LOSS";
    } else if (order.action === "EXIT") {
      badgeClass = "act-buy";
      badgeText = "FULL EXIT";
    } else if (order.action === "CREATE_BUY") {
      badgeClass = "act-create-buy";
      badgeText = "+BUY LIMIT";
    } else if (order.action === "CREATE_SELL") {
      badgeClass = "act-create-sell";
      badgeText = "+SELL LIMIT";
    } else if (order.action === "CANCEL_BUY") {
      badgeClass = "act-cancel";
      badgeText = "CANCEL BUY";
    } else if (order.action === "CANCEL_SELL") {
      badgeClass = "act-cancel";
      badgeText = "CANCEL SELL";
    }

    const isSellAction = ["SELL", "SELL_FILL", "TAKE_PROFIT", "CUT", "EXIT", "SNIPE_SELL"].includes(order.action) || order.side === "SELL";
    let pnlVal = order.pnl !== undefined ? order.pnl : order.pnlUsdso;
    if (isSellAction && (pnlVal === undefined || pnlVal === null) && Array.isArray(rawOrders) && rawOrders.length > 0) {
      const priorBuys = rawOrders.filter(
        (o) => (o.side === "BUY" || o.action === "BUY_FILL" || o.action === "SNIPE_BUY") && (o.status === "FILLED" || !o.status) && (o.time || 0) <= (order.time || 0)
      );
      if (priorBuys.length > 0) {
        const lastBuy = priorBuys[priorBuys.length - 1];
        if (lastBuy && lastBuy.price) {
          pnlVal = (Number(order.price || 0) - Number(lastBuy.price)) * Number(order.qty || 0);
        }
      }
    }

    const pnlHtml =
      isSellAction && pnlVal !== undefined && pnlVal !== null && !isNaN(Number(pnlVal))
        ? `<span class="act-pnl-badge ${Number(pnlVal) >= 0 ? "act-pnl-positive" : "act-pnl-negative"}" style="padding: 1px 6px; border-radius: 4px; font-weight: 700; font-size: 10px; background: ${Number(pnlVal) >= 0 ? "rgba(34, 197, 94, 0.15)" : "rgba(239, 68, 68, 0.15)"}; color: ${Number(pnlVal) >= 0 ? "#4ade80" : "#f87171"}; border: 1px solid ${Number(pnlVal) >= 0 ? "rgba(34, 197, 94, 0.3)" : "rgba(239, 68, 68, 0.3)"}; margin-left: 4px;" title="Realized PnL: ${Number(pnlVal) >= 0 ? "+$" : "-$"}${Math.abs(Number(pnlVal)).toFixed(4)}">${Number(pnlVal) >= 0 ? "+$" : "-$"}${Math.abs(Number(pnlVal)) >= 0.1 ? Math.abs(Number(pnlVal)).toFixed(2) : Math.abs(Number(pnlVal)).toFixed(4)}</span>`
        : "";

    const timeStr = new Date(order.time || Date.now()).toLocaleTimeString();
    const notionalStr = order.notionalUsdso ? `$${order.notionalUsdso.toFixed(2)} • ` : "";
    const targetStr = order.targetPct !== undefined ? `Target: ${order.targetPct}%` : "";

    // ── Clean & Compact Level Description & Reason ──
    let cleanLevelDesc = (order.levelDesc || "").trim();
    // Filter out redundant generic action names
    if (["TAKE_PROFIT", "SELL", "BUY", "CUT_LOSS", "CUT", "EXIT", "SNIPE_BUY", "SNIPE_SELL"].includes(cleanLevelDesc.toUpperCase())) {
      cleanLevelDesc = "";
    }
    // Strip trailing target if any (e.g. "Target: $0.212030")
    cleanLevelDesc = cleanLevelDesc.replace(/\s*\(Target:[^)]+\)/i, "").trim();
    // Strip redundant nested wrappers e.g. "IOC BUY [IOC Buy Level 1]" -> "IOC Buy Level 1"
    cleanLevelDesc = cleanLevelDesc.replace(/^IOC\s+(?:BUY|TAKE PROFIT|Sell)\s*\[(.*)\]$/i, "$1");
    cleanLevelDesc = cleanLevelDesc.replace(/^IOC\s+(?:BUY|TAKE PROFIT|Sell)\s*\[(.*)\]$/i, "$1");
    cleanLevelDesc = cleanLevelDesc.replace(/^\[(.*)\]$/, "$1").trim();
    // Compact aggregated targets: e.g. "IOC Sell (Aggregated 4 targets up to Target 4)" -> "IOC Sell T1-T4 (4x)"
    cleanLevelDesc = cleanLevelDesc.replace(/Aggregated\s+(\d+)\s+targets\s+up\s+to\s+Target\s+(\d+)/i, "T1-T$2 ($1x)");
    cleanLevelDesc = cleanLevelDesc.replace(/Aggregated\s+(\d+)\s+tranches/i, "Aggregated ($1x)");
    cleanLevelDesc = cleanLevelDesc.trim();

    let cleanReason = (order.reason || "").trim();
    if (cleanReason) {
      if (["TAKE_PROFIT", "SELL", "BUY", "CUT_LOSS", "CUT", "EXIT", "SNIPE_BUY", "SNIPE_SELL"].includes(cleanReason.toUpperCase())) {
        cleanReason = "";
      }
      cleanReason = cleanReason.replace(/\s*\(Target:[^)]+\)/i, "").trim();
      cleanReason = cleanReason.replace(/^IOC\s+(?:BUY|TAKE PROFIT|Sell)\s*\[(.*)\]$/i, "$1");
      cleanReason = cleanReason.replace(/^IOC\s+(?:BUY|TAKE PROFIT|Sell)\s*\[(.*)\]$/i, "$1");
      cleanReason = cleanReason.replace(/^\[(.*)\]$/, "$1").trim();
      cleanReason = cleanReason.replace(/Aggregated\s+(\d+)\s+targets\s+up\s+to\s+Target\s+(\d+)/i, "T1-T$2 ($1x)");
      cleanReason = cleanReason.replace(/Aggregated\s+(\d+)\s+tranches/i, "Aggregated ($1x)");

      // Remove gas comp substring if gasCompBadge is already rendered or gasCompSomi > 0
      if (order.gasCompSomi && order.gasCompSomi > 0) {
        cleanReason = cleanReason.replace(/\s*\(Gas Comp:[^)]+\)/i, "").trim();
      }
      // If reason is redundant with cleanLevelDesc or starts with it, suppress duplicate
      const ldLower = cleanLevelDesc.toLowerCase();
      const rLower = cleanReason.toLowerCase();
      if (
        rLower === ldLower ||
        (rLower === "ioc fill" && ldLower.includes("ioc")) ||
        (ldLower && rLower.includes(ldLower)) ||
        (cleanLevelDesc && cleanReason.startsWith(cleanLevelDesc))
      ) {
        cleanReason = "";
      }
    }

    const isTradeFill = order.status === "FILLED" || (order.status !== "CANCELLED" && order.status !== "OPEN" && ["BUY", "SELL", "BUY_FILL", "SELL_FILL", "CUT", "EXIT", "TAKE_PROFIT", "SNIPE_BUY", "SNIPE_SELL"].includes(order.action));
    const isRestingOpen = !isTradeFill && (order.status === "OPEN" || order.action === "CREATE_BUY" || order.action === "CREATE_SELL");
    const expHoursLeft = order.expireHours ? order.expireHours : (order.expireTime ? Math.max(0, Math.round((order.expireTime - (order.time || Date.now())) / 3600000)) : 0);
    const expStr = isRestingOpen && expHoursLeft > 0 ? ` [Expires: ${expHoursLeft}h]` : "";

    const subDesc = cleanLevelDesc ? ` (${cleanLevelDesc})` : "";
    const reasonStr = cleanReason ? ` [${cleanReason}]` : "";
    const isNumericOrderId = order.orderId && /^\d+$/.test(String(order.orderId)) && !String(order.orderId).startsWith("0x");
    const orderIdStr = isNumericOrderId ? ` #${order.orderId}` : "";

    // Compact Tx badge: display compact ...3e27 with full hash tooltip
    const txBadge = order.txHash
      ? `<a href="https://explorer.somnia.network/tx/${order.txHash}" target="_blank" rel="noopener noreferrer" class="act-tx-link" title="Somnia Tx: ${order.txHash}">⛓️ ...${order.txHash.slice(-4)}</a>`
      : "";
    const gasBadge = order.gasFeeSomi !== undefined
      ? `<span class="act-gas-badge" title="Gas fee paid for this tx: ${order.gasFeeSomi.toFixed(6)} SOMI">⛽ ${order.gasFeeSomi.toFixed(5)} SOMI</span>`
      : "";
    const gasCompBadge = (order.gasCompSomi && order.gasCompSomi > 0)
      ? `<span class="act-gas-badge" style="background: rgba(16, 185, 129, 0.15); color: #4ade80; border-color: rgba(16, 185, 129, 0.4);" title="Compensated to Wallet: ${order.gasCompSomi.toFixed(4)} SOMI (-$${(order.gasLossUsdso || 0).toFixed(4)}) | Net Lot: ${(order.netQty || order.qty).toFixed(4)} SOMI">🛡️ +${order.gasCompSomi.toFixed(4)} SOMI Gas Ret</span>`
      : "";

    if (order.id) div.setAttribute("data-order-id", String(order.id));
    if (order.orderId) div.setAttribute("data-clob-id", String(order.orderId));
    if (order.txHash) div.setAttribute("data-txhash", String(order.txHash));

    div.innerHTML = `
      <div class="act-left">
        <span class="act-badge ${badgeClass}">${badgeText}</span>
        <span class="act-price">$${(order.price || 0).toFixed(6)}</span>
        <span style="color: #94a3b8; font-size: 10.5px;">(${notionalStr}${order.qty ? Number(order.qty).toFixed(4) : ""} ${activeBaseAsset}${orderIdStr})</span>
        <span style="color: #38bdf8; font-size: 10px; font-weight: 600;">${targetStr}${subDesc}${expStr}${reasonStr}</span>
        ${txBadge}
        ${gasBadge}
        ${gasCompBadge}
        ${pnlHtml}
      </div>
      <div class="act-time">
        ${order.id ? `<button class="feed-item-edit-btn" data-trade-id="${order.id}" title="แก้ไขหรือลบรายการนี้">✏️</button>` : ""}
        <span>${timeStr}</span>
      </div>
    `;
    return div;
  }

  function addOrderActivity(order, isLiveUpdate = false) {
    const isTradeFill = order.status === "FILLED" || (order.status !== "CANCELLED" && order.status !== "OPEN" && ["BUY", "SELL", "BUY_FILL", "SELL_FILL", "CUT", "EXIT", "TAKE_PROFIT", "SNIPE_BUY", "SNIPE_SELL"].includes(order.action));
    const isOnChainAction = order.status === "OPEN" || order.status === "CANCELLED" || ["CREATE_BUY", "CREATE_SELL", "CANCEL_BUY", "CANCEL_SELL"].includes(order.action);

    // Track trade executions on chart
    if (isTradeFill) {
      const exists = rawOrders.some(
        (o) => o.time === order.time && o.action === order.action && o.price === order.price && o.qty === order.qty
      );
      if (!exists) {
        rawOrders.push(order);
        rebuildOrderMarkers();
      }
    }

    if (isLiveUpdate && isTradeFill) {
      showTradeToast(order);
    }

    // 1. Insert into Trade Matches Feed
    if (isTradeFill && elTradesFeed) {
      const emptyFeed = elTradesFeed.querySelector(".empty-feed");
      if (emptyFeed) emptyFeed.remove();
      elTradesFeed.insertBefore(createActivityElement(order), elTradesFeed.firstChild);
      tradesCount++;
      if (elTradesCount) elTradesCount.textContent = tradesCount;
    }

    // 2. Insert into On-Chain Lifecycle Feed
    if (isOnChainAction && elOnchainFeed) {
      const emptyFeed = elOnchainFeed.querySelector(".empty-feed");
      if (emptyFeed) emptyFeed.remove();
      elOnchainFeed.insertBefore(createActivityElement(order), elOnchainFeed.firstChild);
      onchainCount++;
      if (elOnchainCount) elOnchainCount.textContent = onchainCount;
    }

    // 3. Insert into Combined All Feed
    if (elAllFeed) {
      const emptyFeed = elAllFeed.querySelector(".empty-feed");
      if (emptyFeed) emptyFeed.remove();
      elAllFeed.insertBefore(createActivityElement(order), elAllFeed.firstChild);
      allCount++;
      if (elOrdersCount) elOrdersCount.textContent = allCount;
    }
  }

  // ── SSE Connection & Dynamic Host Resolution ──────────────────────────────
  const API_BASE = (window.location.protocol === "file:" || window.location.port === "5500" || !window.location.port)
    ? "http://210.246.253.13:3333"
    : "";

  function removeActivityItem(id) {
    if (!id) return;
    const strId = String(id);
    const selectors = [
      `.activity-item[data-order-id="${strId}"]`,
      `.activity-item[data-clob-id="${strId}"]`,
      `.activity-item[data-txhash="${strId}"]`,
    ];
    document.querySelectorAll(selectors.join(", ")).forEach((el) => {
      if (el.parentElement === elTradesFeed && tradesCount > 0) {
        tradesCount--;
        if (elTradesCount) elTradesCount.textContent = tradesCount;
      } else if (el.parentElement === elOnchainFeed && onchainCount > 0) {
        onchainCount--;
        if (elOnchainCount) elOnchainCount.textContent = onchainCount;
      } else if (el.parentElement === elAllFeed && allCount > 0) {
        allCount--;
        if (elOrdersCount) elOrdersCount.textContent = allCount;
      }
      el.remove();
    });
    if (elTradesFeed && elTradesFeed.children.length === 0) {
      elTradesFeed.innerHTML = '<div class="empty-feed">No trade fills recorded yet</div>';
    }
    if (elOnchainFeed && elOnchainFeed.children.length === 0) {
      elOnchainFeed.innerHTML = '<div class="empty-feed">No on-chain activity yet</div>';
    }
    if (elAllFeed && elAllFeed.children.length === 0) {
      elAllFeed.innerHTML = '<div class="empty-feed">No order activity yet</div>';
    }
  }

  async function refreshFrontPageState() {
    try {
      const res = await fetch(`${API_BASE}/api/state`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.latestTick) {
        updateTick(data.latestTick);
      }
    } catch (e) {
      console.warn("Could not refresh front page state:", e);
    }
  }

  function resolveBinanceCandleSymbol(sym) {
    if (!sym) return "BTCUSDT";
    const s = sym.toUpperCase().replace(/[\/\-_:]/g, "");
    if (s.startsWith("SOMI")) return "SOMIUSDT";
    if (s.startsWith("USDC") || s === "USDSO") return "USDCUSDT";
    if (s.startsWith("WBTC") || s === "BTC") return "BTCUSDT";
    if (s.startsWith("WETH") || s === "ETH") return "ETHUSDT";
    if (!s.endsWith("USDT") && !s.endsWith("USDC") && !s.endsWith("FDUSD")) {
      return `${s}USDT`;
    }
    return s;
  }

  async function loadFallbackCandles() {
    if (pendingCandles && pendingCandles.length > 0) return;
    try {
      const topSel = document.getElementById("topSymbolSelect");
      const rawSym = (topSel && topSel.value) ? topSel.value.toUpperCase() : "BTCUSDT";
      const binanceSym = resolveBinanceCandleSymbol(rawSym);
      const res = await fetch(`https://api.binance.com/api/v3/klines?symbol=${binanceSym}&interval=15m&limit=100`);
      if (!res.ok) return;
      const raw = await res.json();
      if (!Array.isArray(raw) || raw.length === 0) return;

      const candles = raw.map((k) => ({
        time: Math.floor(Number(k[0]) / 1000),
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
      })).filter((c) => [c.time, c.open, c.high, c.low, c.close].every(Number.isFinite));

      if (candles.length > 0) {
        updateCandles(candles);
        if (!pendingTick) {
          synthesizeDowWavePreview(candles);
        }
      }
    } catch (err) {
      console.warn("Could not fetch preview candles from Binance:", err);
    }
  }

  function synthesizeDowWavePreview(candles) {
    if (!candles || candles.length < 8) return;
    const n = candles.length;
    const k = 3;
    const swingHighs = [];
    const swingLows = [];

    for (let i = k; i <= n - 1 - k; i++) {
      const c = candles[i];
      let isH = true;
      let isL = true;
      for (let j = i - k; j <= i + k; j++) {
        if (j === i) continue;
        const o = candles[j];
        if (o.high > c.high) isH = false;
        if (o.low < c.low) isL = false;
      }
      if (isH) swingHighs.push({ time: c.time, price: c.high, type: "HIGH" });
      if (isL) swingLows.push({ time: c.time, price: c.low, type: "LOW" });
    }

    const annotatedSwings = getClientAnnotatedSwings({ swingHighs, swingLows });
    const wavePoints = [];
    for (let i = 1; i < annotatedSwings.length; i++) {
      const from = annotatedSwings[i - 1];
      const to = annotatedSwings[i];
      const fromCandleIdx = candles.findIndex((c) => c.time === from.time);
      const toCandleIdx = candles.findIndex((c) => c.time === to.time);
      if (fromCandleIdx >= 0 && toCandleIdx > fromCandleIdx) {
        const span = toCandleIdx - fromCandleIdx;
        for (let idx = fromCandleIdx; idx <= toCandleIdx; idx++) {
          const c = candles[idx];
          const prog = (idx - fromCandleIdx) / span;
          const val = from.price + prog * (to.price - from.price);
          const last = wavePoints[wavePoints.length - 1];
          if (last && last.time === c.time) {
            last.value = Number(val.toFixed(6));
          } else {
            wavePoints.push({ time: c.time, value: Number(val.toFixed(6)) });
          }
        }
      }
    }

    const lastC = candles[n - 1];
    const highestP = Math.max(...candles.map((c) => c.high));
    const lowestP = Math.min(...candles.map((c) => c.low));

    updateTick({
      symbol: `${activeBaseAsset} / ${activeQuoteAsset}`,
      dowTimeframe: "15m",
      tradingTimeframe: "15m",
      mid: lastC.close,
      upperBound: highestP,
      bottomBound: lowestP,
      centerPrice: (highestP + lowestP) / 2,
      zoneWidthPct: ((highestP - lowestP) / lowestP) * 100,
      clampStatus: "NATURAL_SWING",
      activePeak: swingHighs[swingHighs.length - 1],
      activeValley: swingLows[swingLows.length - 1],
      swingHighs,
      swingLows,
      waveCycle: {
        wavePoints,
        annotatedSwings,
        activeCycleSummary: "รอบคลื่น: กำลังวิเคราะห์ (Preview)",
      },
    });
  }

  function connectSSE() {
    let initialLoaded = false;

    fetch(`${API_BASE}/api/state`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        initialLoaded = true;
        if (data.candles && data.candles.length > 0) {
          updateCandles(data.candles);
        } else {
          loadFallbackCandles();
        }
        const initialEvents = (Array.isArray(data.orders) ? data.orders : []).sort(
          (a, b) => (a.time || a.placedTime || a.timestamp || 0) - (b.time || b.placedTime || b.timestamp || 0),
        );

        if (initialEvents.length > 0) {
          rawOrders = [];
          tradesCount = 0;
          onchainCount = 0;
          allCount = 0;
          if (elTradesFeed) elTradesFeed.innerHTML = "";
          if (elOnchainFeed) elOnchainFeed.innerHTML = "";
          if (elAllFeed) elAllFeed.innerHTML = "";

          // Pre-pass: Backfill any missing PnL for historical sell orders based on chronological average buy cost
          let invQty = 0;
          let invCost = 0;
          for (const ord of initialEvents) {
            const isBuy = ord.side === "BUY" || ord.action === "BUY_FILL" || ord.action === "SNIPE_BUY";
            const isSell = ord.side === "SELL" || ["SELL", "SELL_FILL", "TAKE_PROFIT", "CUT", "EXIT", "SNIPE_SELL"].includes(ord.action);
            const q = Number(ord.qty || 0);
            const p = Number(ord.fillPrice || ord.price || 0);

            if (isBuy && (ord.status === "FILLED" || !ord.status)) {
              invQty += q;
              invCost += q * p;
            } else if (isSell && (ord.status === "FILLED" || !ord.status)) {
              const avgBuy = invQty > 0 ? invCost / invQty : p;
              if (ord.pnl === undefined && ord.pnlUsdso === undefined) {
                const calcPnl = (p - avgBuy) * q;
                ord.pnl = calcPnl;
                ord.pnlUsdso = calcPnl;
              } else if (ord.pnl === undefined && ord.pnlUsdso !== undefined) {
                ord.pnl = ord.pnlUsdso;
              } else if (ord.pnlUsdso === undefined && ord.pnl !== undefined) {
                ord.pnlUsdso = ord.pnl;
              }
              const soldFrac = invQty > 0 ? Math.min(1, q / invQty) : 1;
              invQty = Math.max(0, invQty - q);
              invCost = Math.max(0, invCost * (1 - soldFrac));
            }
          }

          initialEvents.forEach((o) => addOrderActivity(o, false));

          // If there are no trade fills yet, automatically activate "On-Chain" or "All" tab so user immediately sees activity
          if (tradesCount === 0 && (onchainCount > 0 || allCount > 0)) {
            switchActivityTab(onchainCount > 0 ? "onchain" : "all");
          }
        }
        if (data.latestTick) {
          updateTick(data.latestTick);
        }
      })
      .catch((err) => {
        console.warn(`Could not load initial state from ${API_BASE}/api/state:`, err);
        loadFallbackCandles();
      });

    let sse = null;
    try {
      sse = new EventSource(`${API_BASE}/api/events`);
    } catch (e) {
      console.warn("Could not create EventSource:", e);
      loadFallbackCandles();
      return;
    }

    sse.addEventListener("connected", () => {
      if (elConnectionStatus) elConnectionStatus.className = "status-pill connected";
      if (elConnectionText) elConnectionText.textContent = "Live Feed";
    });

    sse.addEventListener("candles_batch", (e) => {
      try {
        const payload = JSON.parse(e.data);
        if (Array.isArray(payload.candles) && payload.candles.length > 0) {
          updateCandles(payload.candles);
        }
      } catch (err) {
        console.error("Malformed candles_batch event:", err);
      }
    });

    sse.addEventListener("candle", (e) => {
      try {
        const payload = JSON.parse(e.data);
        if (payload.candle) updateSingleCandle(payload.candle);
      } catch (err) {
        console.error("Malformed candle event:", err);
      }
    });

    sse.addEventListener("tick", (e) => {
      try {
        const data = JSON.parse(e.data);
        updateTick(data);
      } catch (err) {
        console.error("Malformed tick event:", err);
      }
    });

    sse.addEventListener("order", (e) => {
      try {
        const order = JSON.parse(e.data);
        addOrderActivity(order, true);
      } catch (err) {
        console.error("Malformed order event:", err);
      }
    });

    sse.addEventListener("order_gas", (e) => {
      try {
        const gasData = JSON.parse(e.data);
        if (gasData && gasData.txHash) {
          const matchingRow = document.querySelector(`[data-txhash="${gasData.txHash}"]`);
          if (matchingRow) {
            const leftDiv = matchingRow.querySelector(".act-left");
            if (leftDiv && !leftDiv.querySelector(".act-gas-badge")) {
              const gasSpan = document.createElement("span");
              gasSpan.className = "act-gas-badge";
              gasSpan.title = `Gas fee paid for this tx: ${gasData.gasFeeSomi.toFixed(6)} SOMI ($${gasData.gasFeeUsdso.toFixed(4)})`;
              gasSpan.textContent = `⛽ ${gasData.gasFeeSomi.toFixed(5)} SOMI`;
              leftDiv.appendChild(gasSpan);
            }
          }
        }
      } catch (err) {
        console.error("Malformed order_gas event:", err);
      }
    });

    sse.addEventListener("trade_updated", (e) => {
      try {
        const payload = JSON.parse(e.data);
        if (payload && payload.id) {
          const idx = rawOrders.findIndex((o) => o.id === payload.id);
          if (idx >= 0) {
            if (payload.order?.status === "CANCELLED") {
              rawOrders.splice(idx, 1);
            } else if (payload.order) {
              Object.assign(rawOrders[idx], payload.order);
            }
            rebuildOrderMarkers();
          } else if (payload.order && payload.order.status === "FILLED") {
            rawOrders.push(payload.order);
            rebuildOrderMarkers();
          }
          if (elTradeManagerModal && elTradeManagerModal.style.display !== "none") {
            loadTradeManagerData();
          }
        }
      } catch (err) {
        console.error("Malformed trade_updated event:", err);
      }
    });

    sse.addEventListener("trade_deleted", (e) => {
      try {
        const payload = JSON.parse(e.data);
        if (payload && payload.id) {
          rawOrders = rawOrders.filter((o) => o.id !== payload.id && o.orderId !== payload.id);
          rebuildOrderMarkers();
          removeActivityItem(payload.id);
          refreshFrontPageState();
          if (elTradeManagerModal && elTradeManagerModal.style.display !== "none") {
            loadTradeManagerData();
          }
        }
      } catch (err) {
        console.error("Malformed trade_deleted event:", err);
      }
    });

    sse.addEventListener("trade_added", (e) => {
      try {
        const payload = JSON.parse(e.data);
        if (payload && payload.order && payload.order.status === "FILLED") {
          rawOrders.push(payload.order);
          rebuildOrderMarkers();
          refreshFrontPageState();
          if (elTradeManagerModal && elTradeManagerModal.style.display !== "none") {
            loadTradeManagerData();
          }
        }
      } catch (err) {
        console.error("Malformed trade_added event:", err);
      }
    });

    sse.addEventListener("lots_updated", () => {
      refreshFrontPageState();
      if (elTradeManagerModal && elTradeManagerModal.style.display !== "none") {
        loadTradeManagerData();
      }
    });

    sse.onerror = () => {
      if (elConnectionStatus) elConnectionStatus.className = "status-pill disconnected";
      if (elConnectionText) elConnectionText.textContent = "Reconnecting…";
    };
  }

  // ── Settings Modal Controller ──
  const elOpenSettingsBtn = document.getElementById("openSettingsBtn");
  const elCloseSettingsBtn = document.getElementById("closeSettingsBtn");
  const elSettingsModalOverlay = document.getElementById("settingsModalOverlay");
  const elSaveSettingsBtn = document.getElementById("saveSettingsBtn");
  const elResetSettingsBtn = document.getElementById("resetSettingsBtn");
  const elSettingsSaveStatus = document.getElementById("settingsSaveStatus");
  const tabBtns = document.querySelectorAll(".settings-tabs .tab-btn");
  const tabPanes = document.querySelectorAll(".tab-pane");

  tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      tabBtns.forEach((b) => b.classList.remove("active"));
      tabPanes.forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      const targetId = btn.getAttribute("data-tab");
      const targetPane = document.getElementById(targetId);
      if (targetPane) targetPane.classList.add("active");
      if (targetId === "tab-database") loadDatabaseStatus();
    });
  });

  async function loadSettings() {
    try {
      const res = await fetch(`${API_BASE}/api/db/settings`);
      if (!res.ok) return;
      const data = await res.json();
      if (!data) return;

      const setVal = (id, val) => {
        const el = document.getElementById(id);
        if (el && val !== undefined) el.value = val;
      };
      const setCheck = (id, val) => {
        const el = document.getElementById(id);
        if (el && val !== undefined) el.checked = Boolean(val);
      };

      setVal("cfg_symbol", data.symbol || "BTCUSDT");
      setVal("cfg_exchange", data.exchange || "binance");
      const currentExchange = (data.exchange || "binance").toLowerCase();
      renderTopSymbolOptions(currentExchange, data.symbol);
      setVal("cfg_binanceApiKey", data.binanceApiKey || "");
      setVal("cfg_binanceApiSecret", data.binanceApiSecret || "");
      setVal("cfg_binanceBaseUrl", data.binanceBaseUrl || "https://api.binance.com");
      setVal("cfg_binanceWsBase", data.binanceWsBase || "wss://stream.binance.com:9443");
      setVal("cfg_dreamdexPrivateKey", data.dreamdexPrivateKey || "");
      setVal("cfg_dreamdexRpcUrl", data.dreamdexRpcUrl || "https://api.infra.mainnet.somnia.network");
      setVal("cfg_dashboardPort", data.dashboardPort || 3333);
      setCheck("cfg_dryRun", data.dryRun !== false);
      setVal("cfg_maxInventoryUsdso", data.maxInventoryUsdso);
      setVal("cfg_intervalMs", data.intervalMs ?? 2000);
      setVal("cfg_floorBufferPct", data.floorBufferPct);
      setVal("cfg_cutLossMaxBidDiscountPct", data.cutLossMaxBidDiscountPct);
      setVal("cfg_orderExpireHours", data.orderExpireHours);
      setCheck("cfg_cutLossAtLowerBound", data.cutLossAtLowerBound);
      setCheck("cfg_takeProfitAtUpperBound", data.takeProfitAtUpperBound);
      setVal("cfg_timezone", data.timezone || "Asia/Bangkok");
      setVal("cfg_dowTimeframe", data.dowTimeframe || "15m");
      setVal("cfg_initialCandleCount", data.initialCandleCount ?? 300);
      setVal("cfg_maxCandleCount", data.maxCandleCount ?? 600);
      setVal("cfg_channelMode", data.channelMode);
      setVal("cfg_minChannelWidthPct", data.minChannelWidthPct);
      setVal("cfg_maxChannelWidthPct", data.maxChannelWidthPct);
      setVal("cfg_srMinTouchCount", data.srMinTouchCount ?? 2);
      setVal("cfg_srTouchTolerancePct", data.srTouchTolerancePct ?? 0.35);
      setVal("cfg_srLookbackCandles", data.srLookbackCandles ?? 300);
      setVal("cfg_minChannelShiftPct", data.minChannelShiftPct);
      setVal("cfg_wickThresholdPct", data.wickThresholdPct ?? 20.0);
      setCheck("cfg_useTrueWick", data.useTrueWick !== false);
      setCheck("cfg_dowTrendFilter", data.dowTrendFilter);
      setCheck("cfg_trendlineFilter", data.trendlineFilter);
      setCheck("cfg_enableBuyLevel2Recovery", data.enableBuyLevel2Recovery !== false);
      setCheck("cfg_enableBuyAboveTrendSupport", data.enableBuyAboveTrendSupport !== false);
      setCheck("cfg_enableSellBelowTrendResistance", data.enableSellBelowTrendResistance !== false);
      setVal("cfg_sellProfitMode", data.sellProfitMode || (data.requireProfitAboveAvgEntry ? "PORTFOLIO_AVG_PROFIT" : "GRID_CASHFLOW"));
      setCheck("cfg_enableTriangleSqueezeExit", data.enableTriangleSqueezeExit !== false);
      setVal("cfg_triangleSqueezeSpreadPct", data.triangleSqueezeSpreadPct ?? 1.0);
      setVal("cfg_minTradeableChannelWidthPct", data.minTradeableChannelWidthPct ?? 2.0);
      setVal("cfg_orderExecutionMode", data.orderExecutionMode || "IOC_BRACKET");
      setVal("cfg_iocSlippagePct", data.iocSlippagePct ?? 0.35);
      setVal("cfg_stuckTimeoutMinutes", data.stuckTimeoutMs ? Math.round(data.stuckTimeoutMs / 60000) : 0);
      setCheck("cfg_enableBuyBelowSellLevel1", data.enableBuyBelowSellLevel1 !== false);
      setCheck("cfg_enableSellAboveBuyLevel1", data.enableSellAboveBuyLevel1 !== false);
      setVal("cfg_laggardThresholdPct", data.laggardThresholdPct);
      setVal("cfg_orderPriceTolerancePct", data.orderPriceTolerancePct);
      setVal("cfg_orderQtyTolerancePct", data.orderQtyTolerancePct);
      setVal("cfg_minGasReserveSomi", data.minGasReserveSomi ?? 0.5);
      setCheck("cfg_enableLaggardSnipe", data.enableLaggardSnipe);
      setCheck("cfg_enableLaggardGuard", data.enableLaggardGuard);
    } catch (e) {
      console.error("Failed to load settings:", e);
    }
  }

  async function loadDatabaseStatus() {
    try {
      const [tradesRes, gasRes] = await Promise.all([
        fetch(`${API_BASE}/api/db/trades?limit=1000`),
        fetch(`${API_BASE}/api/db/gas?limit=1000`),
      ]);
      if (tradesRes.ok) {
        const trades = await tradesRes.json();
        const elTradesCount = document.getElementById("dbTradesCount");
        if (elTradesCount) elTradesCount.textContent = `${trades.length} Trades`;
      }
      if (gasRes.ok) {
        const gasData = await gasRes.json();
        const elGasCount = document.getElementById("dbGasCount");
        const elGasTotal = document.getElementById("dbGasTotalSomi");
        if (elGasCount) elGasCount.textContent = `${gasData.summary?.totalTxCount || 0} Tx`;
        if (elGasTotal) elGasTotal.textContent = `${(gasData.summary?.totalGasSpentSomi || 0).toFixed(6)} Fees Spent`;
      }
    } catch (err) {
      console.error("Failed to load DB metrics:", err);
    }
  }

  async function saveSettings() {
    if (!elSaveSettingsBtn) return;
    elSaveSettingsBtn.disabled = true;
    elSaveSettingsBtn.textContent = "Saving…";
    if (elSettingsSaveStatus) {
      elSettingsSaveStatus.style.color = "#818cf8";
      elSettingsSaveStatus.textContent = "Saving to database…";
    }

    const maxInvVal = parseFloat(document.getElementById("cfg_maxInventoryUsdso").value);
    const payload = {
      exchange: document.getElementById("cfg_exchange") ? document.getElementById("cfg_exchange").value : "binance",
      symbol: document.getElementById("cfg_symbol") ? document.getElementById("cfg_symbol").value.trim().toUpperCase() : undefined,
      binanceApiKey: document.getElementById("cfg_binanceApiKey") ? document.getElementById("cfg_binanceApiKey").value.trim() : undefined,
      binanceApiSecret: (() => {
        const val = document.getElementById("cfg_binanceApiSecret") ? document.getElementById("cfg_binanceApiSecret").value.trim() : "";
        return (val && val !== "******") ? val : undefined;
      })(),
      binanceBaseUrl: document.getElementById("cfg_binanceBaseUrl") ? document.getElementById("cfg_binanceBaseUrl").value.trim() : undefined,
      binanceWsBase: document.getElementById("cfg_binanceWsBase") ? document.getElementById("cfg_binanceWsBase").value.trim() : undefined,
      dreamdexPrivateKey: (() => {
        const val = document.getElementById("cfg_dreamdexPrivateKey") ? document.getElementById("cfg_dreamdexPrivateKey").value.trim() : "";
        return (val && val !== "******") ? val : undefined;
      })(),
      dreamdexRpcUrl: document.getElementById("cfg_dreamdexRpcUrl") ? document.getElementById("cfg_dreamdexRpcUrl").value.trim() : undefined,
      dashboardPort: document.getElementById("cfg_dashboardPort") ? parseInt(document.getElementById("cfg_dashboardPort").value, 10) : undefined,
      dryRun: document.getElementById("cfg_dryRun") ? document.getElementById("cfg_dryRun").checked : false,
      maxInventoryQuote: maxInvVal,
      maxInventoryUsdso: maxInvVal,
      intervalMs: parseFloat(document.getElementById("cfg_intervalMs").value),
      floorBufferPct: parseFloat(document.getElementById("cfg_floorBufferPct").value),
      cutLossMaxBidDiscountPct: parseFloat(document.getElementById("cfg_cutLossMaxBidDiscountPct").value),
      orderExpireHours: parseFloat(document.getElementById("cfg_orderExpireHours").value),
      cutLossAtLowerBound: document.getElementById("cfg_cutLossAtLowerBound").checked,
      takeProfitAtUpperBound: document.getElementById("cfg_takeProfitAtUpperBound").checked,
      timezone: document.getElementById("cfg_timezone").value || "Asia/Bangkok",
      dowTimeframe: document.getElementById("cfg_dowTimeframe").value || "15m",
      initialCandleCount: parseInt(document.getElementById("cfg_initialCandleCount").value, 10) || 300,
      maxCandleCount: parseInt(document.getElementById("cfg_maxCandleCount").value, 10) || 600,
      channelMode: document.getElementById("cfg_channelMode").value,
      minChannelWidthPct: parseFloat(document.getElementById("cfg_minChannelWidthPct").value),
      maxChannelWidthPct: parseFloat(document.getElementById("cfg_maxChannelWidthPct").value),
      srMinTouchCount: parseInt(document.getElementById("cfg_srMinTouchCount").value, 10) || 2,
      srTouchTolerancePct: parseFloat(document.getElementById("cfg_srTouchTolerancePct").value) || 0.35,
      srLookbackCandles: parseInt(document.getElementById("cfg_srLookbackCandles").value, 10) || 300,
      minChannelShiftPct: parseFloat(document.getElementById("cfg_minChannelShiftPct").value),
      wickThresholdPct: parseFloat(document.getElementById("cfg_wickThresholdPct").value),
      useTrueWick: document.getElementById("cfg_useTrueWick").checked,
      dowTrendFilter: document.getElementById("cfg_dowTrendFilter").checked,
      trendlineFilter: document.getElementById("cfg_trendlineFilter").checked,
      enableBuyLevel2Recovery: document.getElementById("cfg_enableBuyLevel2Recovery").checked,
      enableBuyAboveTrendSupport: document.getElementById("cfg_enableBuyAboveTrendSupport").checked,
      enableSellBelowTrendResistance: document.getElementById("cfg_enableSellBelowTrendResistance").checked,
      sellProfitMode: document.getElementById("cfg_sellProfitMode").value,
      requireProfitAboveAvgEntry: document.getElementById("cfg_sellProfitMode").value === "PORTFOLIO_AVG_PROFIT",
      enableTriangleSqueezeExit: document.getElementById("cfg_enableTriangleSqueezeExit").checked,
      triangleSqueezeSpreadPct: parseFloat(document.getElementById("cfg_triangleSqueezeSpreadPct").value),
      minTradeableChannelWidthPct: parseFloat(document.getElementById("cfg_minTradeableChannelWidthPct").value),
      orderExecutionMode: document.getElementById("cfg_orderExecutionMode").value,
      iocSlippagePct: parseFloat(document.getElementById("cfg_iocSlippagePct").value) || 0.35,
      stuckTimeoutMs: (parseFloat(document.getElementById("cfg_stuckTimeoutMinutes").value) || 0) * 60_000,
      enableBuyBelowSellLevel1: document.getElementById("cfg_enableBuyBelowSellLevel1").checked,
      enableSellAboveBuyLevel1: document.getElementById("cfg_enableSellAboveBuyLevel1").checked,
      laggardThresholdPct: parseFloat(document.getElementById("cfg_laggardThresholdPct").value),
      orderPriceTolerancePct: parseFloat(document.getElementById("cfg_orderPriceTolerancePct").value),
      orderQtyTolerancePct: parseFloat(document.getElementById("cfg_orderQtyTolerancePct").value),
      minGasReserveSomi: document.getElementById("cfg_minGasReserveSomi") ? parseFloat(document.getElementById("cfg_minGasReserveSomi").value) : 0,
      enableLaggardSnipe: document.getElementById("cfg_enableLaggardSnipe").checked,
      enableLaggardGuard: document.getElementById("cfg_enableLaggardGuard").checked,
    };

    try {
      const res = await fetch(`${API_BASE}/api/db/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        if (elSettingsSaveStatus) {
          elSettingsSaveStatus.style.color = "#10b981";
          elSettingsSaveStatus.textContent = "✅ Applied & saved to DB!";
        }
        showToast({
          title: "SETTINGS SAVED",
          desc: "Bot configuration saved to Database & applied live!",
          action: "SETTINGS",
        });
      } else {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || "Failed to save");
      }
    } catch (err) {
      if (elSettingsSaveStatus) {
        elSettingsSaveStatus.style.color = "#f43f5e";
        elSettingsSaveStatus.textContent = `❌ Failed to save: ${err?.message || "Unknown error"}`;
      }
    } finally {
      elSaveSettingsBtn.disabled = false;
      elSaveSettingsBtn.textContent = "💾 Save & Apply";
    }
  }

  if (elOpenSettingsBtn) {
    elOpenSettingsBtn.addEventListener("click", () => {
      loadSettings();
      loadDatabaseStatus();
      if (elSettingsModalOverlay) elSettingsModalOverlay.classList.add("active");
      if (elSettingsSaveStatus) elSettingsSaveStatus.textContent = "";
    });
  }

  if (elCloseSettingsBtn) {
    elCloseSettingsBtn.addEventListener("click", () => {
      if (elSettingsModalOverlay) elSettingsModalOverlay.classList.remove("active");
    });
  }

  if (elSettingsModalOverlay) {
    elSettingsModalOverlay.addEventListener("click", (e) => {
      if (e.target === elSettingsModalOverlay) {
        elSettingsModalOverlay.classList.remove("active");
      }
    });
  }

  if (elResetSettingsBtn) {
    elResetSettingsBtn.addEventListener("click", () => {
      loadSettings();
      if (elSettingsSaveStatus) {
        elSettingsSaveStatus.style.color = "#94a3b8";
        elSettingsSaveStatus.textContent = "Reset to current DB values.";
      }
    });
  }

  if (elSaveSettingsBtn) {
    elSaveSettingsBtn.addEventListener("click", saveSettings);
  }

  function renderTopSymbolOptions(exchange, currentSymbol) {
    const elTopSymbolSelect = document.getElementById("topSymbolSelect");
    const elPopularSymbolsList = document.getElementById("popularSymbolsList");
    const isDreamdex = exchange === "dreamdex";
    const dreamdexHtml = `
      <option value="SOMI">SOMI (SOMI/USDso)</option>
      <option value="SOMI:USDSO">SOMI:USDso</option>
      <option value="USDC.E:USDSO">USDC.e:USDso</option>
      <option value="WBTC:USDSO">WBTC:USDso</option>
      <option value="WETH:USDSO">WETH:USDso</option>
    `;
    const binanceHtml = `
      <option value="BTCUSDT">BTC/USDT</option>
      <option value="ETHUSDT">ETH/USDT</option>
      <option value="ETHFDUSD">ETH/FDUSD</option>
      <option value="SOLUSDT">SOL/USDT</option>
      <option value="BNBUSDT">BNB/USDT</option>
      <option value="SOMIUSDT">SOMI/USDT</option>
      <option value="DOGEUSDT">DOGE/USDT</option>
      <option value="XRPUSDT">XRP/USDT</option>
      <option value="ADAUSDT">ADA/USDT</option>
      <option value="AVAXUSDT">AVAX/USDT</option>
      <option value="SUIUSDT">SUI/USDT</option>
      <option value="NEARUSDT">NEAR/USDT</option>
      <option value="PEPEUSDT">PEPE/USDT</option>
    `;
    const targetHtml = isDreamdex ? dreamdexHtml : binanceHtml;
    if (elTopSymbolSelect) {
      elTopSymbolSelect.innerHTML = targetHtml;
      if (currentSymbol) {
        elTopSymbolSelect.value = currentSymbol.toUpperCase();
        if (!elTopSymbolSelect.value) {
          elTopSymbolSelect.value = currentSymbol.toUpperCase().replace(/[\/\-_:]/g, "");
        }
      }
    }
    const elCfgSymbol = document.getElementById("cfg_symbol");
    if (elCfgSymbol) {
      elCfgSymbol.innerHTML = targetHtml;
      if (currentSymbol) {
        elCfgSymbol.value = currentSymbol.toUpperCase();
        if (!elCfgSymbol.value) {
          elCfgSymbol.value = currentSymbol.toUpperCase().replace(/[\/\-_:]/g, "");
        }
      }
    }
    const lblSymbol = document.getElementById("lbl_symbol");
    if (lblSymbol) {
      lblSymbol.innerHTML = isDreamdex
        ? `DreamDEX Trading Pair (Symbol) <span class="help-tip" title="Choose or enter DreamDEX pair (e.g. SOMI, SOMI:USDso, WETH:USDso, WBTC:USDso)">ℹ️</span>`
        : `Binance Trading Pair (Symbol) <span class="help-tip" title="Choose or enter Binance Spot pair (e.g. BTCUSDT, ETHUSDT, ETHFDUSD)">ℹ️</span>`;
    }
  }

  const elCfgExchange = document.getElementById("cfg_exchange");
  if (elCfgExchange) {
    elCfgExchange.addEventListener("change", (e) => {
      const selectedExchange = (e.target.value || "binance").toLowerCase();
      const cfgSymbol = document.getElementById("cfg_symbol");
      let newDefaultSym = selectedExchange === "dreamdex" ? "SOMI" : "BTCUSDT";
      if (cfgSymbol) {
        const cur = (cfgSymbol.value || "").toUpperCase();
        if (selectedExchange === "dreamdex" && (cur.includes("USDT") || cur.includes("FDUSD") || cur === "BTCUSDT")) {
          cfgSymbol.value = "SOMI";
        } else if (selectedExchange === "binance" && (cur.includes("USDSO") || cur === "SOMI")) {
          cfgSymbol.value = "SOMIUSDT";
        }
        newDefaultSym = cfgSymbol.value;
      }
      renderTopSymbolOptions(selectedExchange, newDefaultSym);
    });
  }

  const elTopSymbolSelect = document.getElementById("topSymbolSelect");
  if (elTopSymbolSelect) {
    elTopSymbolSelect.addEventListener("change", async (e) => {
      const newSym = e.target.value;
      if (!newSym) return;
      try {
        const res = await fetch(`${API_BASE}/api/db/settings`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ symbol: newSym }),
        });
        if (res.ok) {
          showToast({
            title: "SYMBOL CHANGED",
            desc: `Switched trading pair to ${newSym}`,
            action: "SETTINGS",
          });
          const navPill = document.getElementById("navSymbolBadge");
          if (navPill) navPill.textContent = newSym;
          const cfgSym = document.getElementById("cfg_symbol");
          if (cfgSym) cfgSym.value = newSym;
        } else {
          showToast({
            title: "SYMBOL ERROR",
            desc: `Failed to switch pair to ${newSym}`,
            action: "ALERT",
          });
        }
      } catch (err) {
        console.error("Failed to switch symbol:", err);
      }
    });
  }

  // ── Bot Operation Control Buttons ─────────────────────────────────────────
  const elBtnPauseBot = document.getElementById("btnPauseBot");
  const elPauseBtnIcon = document.getElementById("pauseBtnIcon");
  const elPauseBtnText = document.getElementById("pauseBtnText");
  const elBtnCancelAll = document.getElementById("btnCancelAll");
  const elBtnOpenResetModal = document.getElementById("btnOpenResetModal");
  const elResetBotModal = document.getElementById("resetBotModal");
  const elCloseResetModalBtn = document.getElementById("closeResetModalBtn");
  const elCancelResetModalBtn = document.getElementById("cancelResetModalBtn");
  const elConfirmResetBtn = document.getElementById("confirmResetBtn");
  const elResetModalStatus = document.getElementById("resetModalStatus");
  const elChkResetOrders = document.getElementById("chkResetOrders");
  const elChkResetPnl = document.getElementById("chkResetPnl");
  const elChkClearHistory = document.getElementById("chkClearHistory");

  let isBotPaused = false;

  async function checkBotPauseStatus() {
    try {
      const res = await fetch("/api/bot/pause");
      if (res.ok) {
        const data = await res.json();
        updatePauseUI(data.isPaused);
      }
    } catch {}
  }

  function updatePauseUI(paused) {
    isBotPaused = Boolean(paused);
    if (elBtnPauseBot) {
      elBtnPauseBot.classList.toggle("is-paused", isBotPaused);
      if (elPauseBtnIcon) elPauseBtnIcon.textContent = isBotPaused ? "▶️" : "⏸️";
      if (elPauseBtnText) elPauseBtnText.textContent = isBotPaused ? "Resume" : "Pause";
      elBtnPauseBot.title = isBotPaused ? "Bot is PAUSED. Click to Resume Trading." : "Bot is Running. Click to Pause Trading.";
    }
  }

  if (elBtnPauseBot) {
    elBtnPauseBot.addEventListener("click", async () => {
      try {
        elBtnPauseBot.disabled = true;
        const targetState = !isBotPaused;
        const res = await fetch("/api/bot/pause", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paused: targetState }),
        });
        if (res.ok) {
          const data = await res.json();
          updatePauseUI(data.isPaused);
        }
      } catch (err) {
        alert("Failed to toggle bot pause: " + (err?.message || err));
      } finally {
        elBtnPauseBot.disabled = false;
      }
    });
  }

  if (elBtnCancelAll) {
    elBtnCancelAll.addEventListener("click", async () => {
      if (!confirm("⚠️ Emergency Cancel All: Are you sure you want to cancel ALL open orders on-chain and claim funds back to wallet?")) {
        return;
      }
      try {
        elBtnCancelAll.disabled = true;
        elBtnCancelAll.textContent = "Cancelling...";
        const res = await fetch("/api/bot/cancel-all", { method: "POST" });
        const data = await res.json();
        if (data.success) {
          alert(`✅ All open orders cancelled successfully! (${data.cancelledCount || 0} orders cancelled)`);
        } else {
          alert("❌ Cancel all failed: " + (data.error || "Unknown error"));
        }
      } catch (err) {
        alert("❌ Error: " + (err?.message || err));
      } finally {
        elBtnCancelAll.disabled = false;
        elBtnCancelAll.innerHTML = '<span class="btn-icon">🛑</span><span>Cancel All</span>';
      }
    });
  }

  const elBtnResetPosition = document.getElementById("btnResetPosition");
  if (elBtnResetPosition) {
    elBtnResetPosition.addEventListener("click", async () => {
      const ok = confirm(`🎯 Reset Position?\n\nThis will clear all in-memory lots to 0.00 ${activeBaseAsset} and cancel any resting SELL orders, allowing the bot to start accumulating fresh from Level 1.\n\n(Wallet balance will NOT be touched). Continue?`);
      if (!ok) return;
      try {
        elBtnResetPosition.disabled = true;
        elBtnResetPosition.textContent = "Resetting Pos...";
        const res = await fetch("/api/bot/reset-position", { method: "POST" });
        const data = await res.json();
        if (data.success) {
          alert(`✅ Position successfully reset! (${data.clearedLots || 0} lots cleared)`);
        } else {
          alert("❌ Reset position failed: " + (data.error || "Unknown error"));
        }
      } catch (err) {
        alert("❌ Error: " + (err?.message || err));
      } finally {
        elBtnResetPosition.disabled = false;
        elBtnResetPosition.innerHTML = '<span class="btn-icon">🎯</span><span>Reset Pos</span>';
      }
    });
  }



  // ── Reset Modal Handlers ──────────────────────────────────────────────────
  if (elBtnOpenResetModal) {
    elBtnOpenResetModal.addEventListener("click", () => {
      if (elResetBotModal) elResetBotModal.style.display = "flex";
      if (elResetModalStatus) elResetModalStatus.textContent = "";
    });
  }

  function closeResetModal() {
    if (elResetBotModal) elResetBotModal.style.display = "none";
  }

  if (elCloseResetModalBtn) elCloseResetModalBtn.addEventListener("click", closeResetModal);
  if (elCancelResetModalBtn) elCancelResetModalBtn.addEventListener("click", closeResetModal);
  if (elResetBotModal) {
    elResetBotModal.addEventListener("click", (e) => {
      if (e.target === elResetBotModal) closeResetModal();
    });
  }

  if (elConfirmResetBtn) {
    elConfirmResetBtn.addEventListener("click", async () => {
      try {
        elConfirmResetBtn.disabled = true;
        elConfirmResetBtn.textContent = "Resetting...";
        if (elResetModalStatus) elResetModalStatus.textContent = "Executing on-chain cancellation and state wipe...";

        const payload = {
          resetPnl: elChkResetPnl ? elChkResetPnl.checked : true,
          clearTrades: elChkClearHistory ? elChkClearHistory.checked : false,
        };

        const res = await fetch("/api/bot/reset", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await res.json();

        if (data.success) {
          if (elResetModalStatus) {
            elResetModalStatus.style.color = "#4ade80";
            elResetModalStatus.textContent = "✅ Bot reset successfully!";
          }
          setTimeout(() => {
            closeResetModal();
            window.location.reload();
          }, 800);
        } else {
          if (elResetModalStatus) {
            elResetModalStatus.style.color = "#f87171";
            elResetModalStatus.textContent = "❌ Reset failed: " + (data.error || "Unknown error");
          }
        }
      } catch (err) {
        if (elResetModalStatus) {
          elResetModalStatus.style.color = "#f87171";
          elResetModalStatus.textContent = "❌ Error: " + (err?.message || err);
        }
      } finally {
        elConfirmResetBtn.disabled = false;
        elConfirmResetBtn.textContent = "⚠️ Reset Selected";
      }
    });
  }

  // ═══════════════════ TRADE & LOT MANAGER CONTROLLER ═══════════════════
  let tmTrades = [];
  let tmLots = [];
  let tmOpenOrders = [];

  const elBtnOpenTradeManager = document.getElementById("btnOpenTradeManager");
  const elTradeManagerModal = document.getElementById("tradeManagerModal");
  const elCloseTradeManagerBtn = document.getElementById("closeTradeManagerBtn");
  const elTmBtnRefresh = document.getElementById("tmBtnRefresh");

  const elTmTabFillsBtn = document.getElementById("tmTabFillsBtn");
  const elTmTabLotsBtn = document.getElementById("tmTabLotsBtn");
  const elTmTabFills = document.getElementById("tmTabFills");
  const elTmTabLots = document.getElementById("tmTabLots");

  const elTmBadgeFillsCount = document.getElementById("tmBadgeFillsCount");
  const elTmBadgeLotsCount = document.getElementById("tmBadgeLotsCount");
  const elTmSearchInput = document.getElementById("tmSearchInput");
  const elTmFilterAction = document.getElementById("tmFilterAction");
  const elTmTradesTbody = document.getElementById("tmTradesTbody");
  const elTmLotsGrid = document.getElementById("tmLotsGrid");

  const elTmSummaryTotal = document.getElementById("tmSummaryTotal");
  const elTmSummaryBuys = document.getElementById("tmSummaryBuys");
  const elTmSummarySells = document.getElementById("tmSummarySells");
  const elTmSummaryCancelled = document.getElementById("tmSummaryCancelled");
  const elTmSummaryLotsCount = document.getElementById("tmSummaryLotsCount");
  const elTmSummaryLotsQty = document.getElementById("tmSummaryLotsQty");
  const elTmSummaryLotsAvgPrice = document.getElementById("tmSummaryLotsAvgPrice");

  // Trade Rounds elements
  let tmRounds = [];
  let tmRoundsSummary = null;
  let expandedRoundNumbers = new Set();

  const elBtnOpenRoundsModal = document.getElementById("btnOpenRoundsModal");
  const elTmTabRoundsBtn = document.getElementById("tmTabRoundsBtn");
  const elTmTabRounds = document.getElementById("tmTabRounds");
  const elTmBadgeRoundsCount = document.getElementById("tmBadgeRoundsCount");

  const elRoundsKpiTotal = document.getElementById("roundsKpiTotal");
  const elRoundsKpiClosed = document.getElementById("roundsKpiClosed");
  const elRoundsKpiWinRate = document.getElementById("roundsKpiWinRate");
  const elRoundsKpiWinLoss = document.getElementById("roundsKpiWinLoss");
  const elRoundsKpiBought = document.getElementById("roundsKpiBought");
  const elRoundsKpiBoughtQty = document.getElementById("roundsKpiBoughtQty");
  const elRoundsKpiSold = document.getElementById("roundsKpiSold");
  const elRoundsKpiSoldQty = document.getElementById("roundsKpiSoldQty");
  const elRoundsKpiPnl = document.getElementById("roundsKpiPnl");
  const elRoundsKpiGas = document.getElementById("roundsKpiGas");

  const elTmRoundsSearchInput = document.getElementById("tmRoundsSearchInput");
  const elTmRoundsFilterStatus = document.getElementById("tmRoundsFilterStatus");
  const elTmRoundsSortOrder = document.getElementById("tmRoundsSortOrder");
  const elTmRoundsBtnExportCsv = document.getElementById("tmRoundsBtnExportCsv");
  const elTmRoundsTbody = document.getElementById("tmRoundsTbody");

  // Sub-modals elements
  const elEditTradeModal = document.getElementById("editTradeModal");
  const elCloseEditTradeModalBtn = document.getElementById("closeEditTradeModalBtn");
  const elCancelEditTradeBtn = document.getElementById("cancelEditTradeBtn");
  const elSaveEditTradeBtn = document.getElementById("saveEditTradeBtn");
  const elEditTradeStatus = document.getElementById("editTradeStatus");

  const elEtfId = document.getElementById("etf_id");
  const elEtfDisplayId = document.getElementById("etf_display_id");
  const elEtfAction = document.getElementById("etf_action");
  const elEtfStatus = document.getElementById("etf_status");
  const elEtfPrice = document.getElementById("etf_price");
  const elEtfQty = document.getElementById("etf_qty");
  const elEtfPnl = document.getElementById("etf_pnl");
  const elEtfTime = document.getElementById("etf_time");
  const elEtfTimeDisplay = document.getElementById("etf_time_display");
  const elEtfSyncLot = document.getElementById("etf_syncLot");
  const elEtfSyncLotGroup = document.getElementById("etf_syncLotGroup");

  const elAddTradeModal = document.getElementById("addTradeModal");
  const elCloseAddTradeModalBtn = document.getElementById("closeAddTradeModalBtn");
  const elCancelAddTradeBtn = document.getElementById("cancelAddTradeBtn");
  const elConfirmAddTradeBtn = document.getElementById("confirmAddTradeBtn");
  const elTmBtnOpenAddTrade = document.getElementById("tmBtnOpenAddTrade");
  const elAddTradeStatus = document.getElementById("addTradeStatus");

  const elAtfAction = document.getElementById("atf_action");
  const elAtfStatus = document.getElementById("atf_status");
  const elAtfPrice = document.getElementById("atf_price");
  const elAtfQty = document.getElementById("atf_qty");
  const elAtfPnl = document.getElementById("atf_pnl");
  const elAtfNote = document.getElementById("atf_note");
  const elAtfAddLot = document.getElementById("atf_addLot");

  const elEditLotModal = document.getElementById("editLotModal");
  const elCloseEditLotModalBtn = document.getElementById("closeEditLotModalBtn");
  const elCancelEditLotBtn = document.getElementById("cancelEditLotBtn");
  const elSaveEditLotBtn = document.getElementById("saveEditLotBtn");
  const elEditLotStatus = document.getElementById("editLotStatus");
  const elElIndex = document.getElementById("el_index");
  const elElPrice = document.getElementById("el_price");
  const elElQty = document.getElementById("el_qty");
  const elElTime = document.getElementById("el_time");
  const elElTimeDisplay = document.getElementById("el_time_display");

  const elAddLotModal = document.getElementById("addLotModal");
  const elCloseAddLotModalBtn = document.getElementById("closeAddLotModalBtn");
  const elCancelAddLotBtn = document.getElementById("cancelAddLotBtn");
  const elConfirmAddLotBtn = document.getElementById("confirmAddLotBtn");
  const elTmBtnOpenAddLot = document.getElementById("tmBtnOpenAddLot");
  const elAddLotStatus = document.getElementById("addLotStatus");
  const elAlPrice = document.getElementById("al_price");
  const elAlQty = document.getElementById("al_qty");

  function openTradeManager(initialTab = "tmTabFills") {
    if (elTradeManagerModal) {
      elTradeManagerModal.classList.add("active");
      elTradeManagerModal.style.display = "flex";
      switchTmTab(initialTab);
      loadTradeManagerData();
    }
  }

  function closeTradeManager() {
    if (elTradeManagerModal) {
      elTradeManagerModal.classList.remove("active");
      elTradeManagerModal.style.display = "none";
    }
  }

  function switchTmTab(targetId) {
    if (elTmTabFillsBtn) elTmTabFillsBtn.classList.toggle("active", targetId === "tmTabFills");
    if (elTmTabLotsBtn) elTmTabLotsBtn.classList.toggle("active", targetId === "tmTabLots");
    if (elTmTabRoundsBtn) elTmTabRoundsBtn.classList.toggle("active", targetId === "tmTabRounds");
    if (elTmTabFills) elTmTabFills.style.display = targetId === "tmTabFills" ? "flex" : "none";
    if (elTmTabLots) elTmTabLots.style.display = targetId === "tmTabLots" ? "flex" : "none";
    if (elTmTabRounds) elTmTabRounds.style.display = targetId === "tmTabRounds" ? "flex" : "none";
    if (targetId === "tmTabRounds" && (!tmRounds || tmRounds.length === 0)) {
      loadTradeRoundsData();
    }
  }

  async function loadTradeManagerData() {
    try {
      if (elTmTradesTbody) {
        elTmTradesTbody.innerHTML = '<tr><td colspan="8" class="tm-empty-row">🔄 กำลังโหลดข้อมูลล่าสุดจากฐานข้อมูล...</td></tr>';
      }
      const res = await fetch(`${API_BASE}/api/db/trade-manager`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      tmTrades = Array.isArray(data.allOrders)
        ? data.allOrders.filter(
            (o) =>
              o.status === "FILLED" ||
              o.status === "CANCELLED" ||
              ["BUY_FILL", "SELL_FILL", "TAKE_PROFIT", "CUT", "CUT_LOSS", "CANCEL_BUY", "CANCEL_SELL"].includes(o.action),
          )
        : [];

      tmTrades.sort((a, b) => (b.time || b.placedTime || 0) - (a.time || a.placedTime || 0));
      tmLots = Array.isArray(data.lots) ? data.lots : [];
      tmOpenOrders = Array.isArray(data.openOrders) ? data.openOrders : [];

      if (elTmBadgeFillsCount) elTmBadgeFillsCount.textContent = tmTrades.length;
      if (elTmBadgeLotsCount) elTmBadgeLotsCount.textContent = tmLots.length;

      renderTmTrades();
      renderTmLots();
      loadTradeRoundsData();
    } catch (err) {
      console.error("Failed to load Trade Manager data:", err);
      if (elTmTradesTbody) {
        elTmTradesTbody.innerHTML = `<tr><td colspan="8" class="tm-empty-row" style="color: #f87171;">❌ โหลดข้อมูลล้มเหลว: ${err.message}</td></tr>`;
      }
    }
  }

  function renderTmTrades() {
    if (!elTmTradesTbody) return;
    const query = (elTmSearchInput ? elTmSearchInput.value : "").trim().toLowerCase();
    const filter = elTmFilterAction ? elTmFilterAction.value : "ALL";

    const filtered = tmTrades.filter((order) => {
      if (filter === "BUY_FILL" && !(order.action === "BUY_FILL" || order.action === "BUY")) return false;
      if (filter === "SELL_FILL" && !(order.action === "SELL_FILL" || order.action === "SELL")) return false;
      if (filter === "TAKE_PROFIT" && order.action !== "TAKE_PROFIT") return false;
      if (filter === "CUT" && !(order.action === "CUT" || order.action === "CUT_LOSS")) return false;
      if (filter === "CANCEL_BUY") {
        const isCanc = order.status === "CANCELLED" || order.action?.startsWith("CANCEL_");
        const isBuy = order.side === "BUY" || order.action === "CANCEL_BUY" || order.action === "BUY_FILL" || order.action === "BUY" || order.action === "CREATE_BUY";
        if (!isCanc || !isBuy) return false;
      }
      if (filter === "CANCEL_SELL") {
        const isCanc = order.status === "CANCELLED" || order.action?.startsWith("CANCEL_");
        const isBuy = order.side === "BUY" || order.action === "CANCEL_BUY" || order.action === "BUY_FILL" || order.action === "BUY" || order.action === "CREATE_BUY";
        if (!isCanc || isBuy) return false;
      }
      if (filter === "CANCELLED" && order.status !== "CANCELLED" && !order.action?.startsWith("CANCEL_")) return false;

      if (query) {
        const idMatch = (order.id || "").toLowerCase().includes(query);
        const orderIdMatch = (order.orderId || "").toLowerCase().includes(query);
        const txMatch = (order.txHash || "").toLowerCase().includes(query);
        const noteMatch = (order.reason || order.levelDesc || "").toLowerCase().includes(query);
        return idMatch || orderIdMatch || txMatch || noteMatch;
      }
      return true;
    });

    const totalCount = filtered.length;
    const buyCount = filtered.filter((o) => (o.action?.includes("BUY") || o.side === "BUY") && o.status === "FILLED").length;
    const sellCount = filtered.filter((o) => (o.action?.includes("SELL") || o.side === "SELL" || o.action === "TAKE_PROFIT" || o.action === "CUT") && o.status === "FILLED").length;
    const cancelCount = filtered.filter((o) => o.status === "CANCELLED" || o.action?.startsWith("CANCEL_")).length;

    if (elTmSummaryTotal) elTmSummaryTotal.textContent = totalCount;
    if (elTmSummaryBuys) elTmSummaryBuys.textContent = buyCount;
    if (elTmSummarySells) elTmSummarySells.textContent = sellCount;
    if (elTmSummaryCancelled) elTmSummaryCancelled.textContent = cancelCount;

    if (filtered.length === 0) {
      elTmTradesTbody.innerHTML = '<tr><td colspan="8" class="tm-empty-row">🔍 ไม่พบรายการตามเงื่อนไขที่ค้นหา</td></tr>';
      return;
    }

    elTmTradesTbody.innerHTML = filtered
      .map((o) => {
        const isFilled = o.status === "FILLED";
        const isCancelled = o.status === "CANCELLED" || o.action?.startsWith("CANCEL_");
        const isBuy = o.side === "BUY" || o.action === "CANCEL_BUY" || o.action === "BUY_FILL" || o.action === "BUY" || o.action === "CREATE_BUY";

        let badgeClass = "tm-badge-buy";
        let actionLabel = o.action || "BUY_FILL";
        if (isCancelled) {
          if (isBuy) {
            badgeClass = "tm-badge-cancel-buy";
            actionLabel = "⚪ CANCEL BUY";
          } else {
            badgeClass = "tm-badge-cancel-sell";
            actionLabel = "⚪ CANCEL SELL";
          }
        } else if (o.action === "SELL_FILL" || o.action === "SELL") {
          badgeClass = "tm-badge-sell";
          actionLabel = "🔴 SELL";
        } else if (o.action === "BUY_FILL" || o.action === "BUY") {
          badgeClass = "tm-badge-buy";
          actionLabel = "🟢 BUY";
        } else if (o.action === "TAKE_PROFIT") {
          badgeClass = "tm-badge-tp";
          actionLabel = "🎯 TAKE PROFIT";
        } else if (o.action === "CUT" || o.action === "CUT_LOSS") {
          badgeClass = "tm-badge-cut";
          actionLabel = "✂️ CUT LOSS";
        }

        const timeVal = o.time || o.placedTime || o.timestamp || Date.now();
        const timeDate = new Date(timeVal);
        const timeStr = `${timeDate.toLocaleDateString()} ${timeDate.toLocaleTimeString()}`;

        const priceStr = `$${Number(o.price || 0).toFixed(5)}`;
        const qtyStr = `${Number(o.quantity || o.qty || 0).toFixed(4)} SOMI`;
        const notionalStr = `$${(Number(o.notionalUsdso) || Number(o.price || 0) * Number(o.quantity || o.qty || 0)).toFixed(2)}`;

        let pnlStr = "-";
        if (o.pnlUsdso !== undefined && o.pnlUsdso !== null) {
          const pVal = Number(o.pnlUsdso);
          const pColor = pVal >= 0 ? "#4ade80" : "#f87171";
          pnlStr = `<span style="color: ${pColor}; font-weight: 600;">${pVal >= 0 ? "+$" : "-$"}${Math.abs(pVal).toFixed(2)}</span>`;
        }

        const reasonEscaped = (o.reason || "").replace(/"/g, "&quot;");
        const statusBadge = isFilled
          ? '<span class="tm-badge-status-filled">● FILLED</span>'
          : `<span class="tm-badge-status-cancelled"${reasonEscaped ? ` title="${reasonEscaped}"` : ""}>○ CANCELLED</span>`;

        const rowId = o.id || o.orderId || "";
        return `
        <tr data-trade-id="${rowId}">
          <td style="color: #94a3b8; font-size: 11px;">${timeStr}</td>
          <td><span class="tm-badge ${badgeClass}">${actionLabel}</span></td>
          <td style="text-align: right; color: #fff; font-weight: 600;">${priceStr}</td>
          <td style="text-align: right; color: #bae6fd;">${qtyStr}</td>
          <td style="text-align: right; color: #cbd5e1;">${notionalStr}</td>
          <td style="text-align: right;">${pnlStr}</td>
          <td style="text-align: center;">${statusBadge}</td>
          <td style="text-align: center;">
            <div class="tm-actions-cell">
              <button class="tm-btn-action btn-edit" title="แก้ไขราคา/จำนวน" onclick="window.tmOpenEditTrade('${rowId}')">✏️ แก้ไข</button>
              ${!isCancelled ? `<button class="tm-btn-action btn-cancel" title="เปลี่ยนเป็นยกเลิก (ไม่พล็อตบนกราฟ)" onclick="window.tmCancelTrade('${rowId}')">🚫 ยกเลิก</button>` : ""}
              <button class="tm-btn-action btn-delete" title="ลบทิ้งถาวรจากฐานข้อมูล" onclick="window.tmDeleteTrade('${rowId}')">🗑️ ลบ</button>
            </div>
          </td>
        </tr>
      `;
      })
      .join("");
  }

  function renderTmLots() {
    if (!elTmLotsGrid) return;
    const totalLots = tmLots.length;
    let totalQty = 0;
    let totalCost = 0;

    tmLots.forEach((l) => {
      const q = Number(l.qty || 0);
      const p = Number(l.price || 0);
      totalQty += q;
      totalCost += q * p;
    });

    const avgPrice = totalQty > 0 ? totalCost / totalQty : 0;

    if (elTmSummaryLotsCount) elTmSummaryLotsCount.textContent = totalLots;
    if (elTmSummaryLotsQty) elTmSummaryLotsQty.textContent = `${totalQty.toFixed(4)} ${activeBaseAsset}`;
    if (elTmSummaryLotsAvgPrice) elTmSummaryLotsAvgPrice.textContent = `$${avgPrice.toFixed(5)}`;

    if (tmLots.length === 0) {
      elTmLotsGrid.innerHTML = '<div class="tm-empty-row" style="grid-column: 1 / -1;">📦 ไม่มี Holding Lot ในระบบ (ยอดคงเหลือ 0)</div>';
      return;
    }

    elTmLotsGrid.innerHTML = tmLots
      .map((lot, idx) => {
        const p = Number(lot.price || 0);
        const q = Number(lot.qty || 0);
        const val = p * q;
        const t = lot.time ? new Date(lot.time).toLocaleString() : "-";

        return `
        <div class="tm-lot-card">
          <div class="tm-lot-header">
            <div class="tm-lot-title">📦 Lot #${idx + 1}</div>
            <div style="display: flex; gap: 4px;">
              <button class="tm-btn-action btn-edit" onclick="window.tmOpenEditLot(${idx})">✏️ แก้ไข</button>
              <button class="tm-btn-action btn-delete" onclick="window.tmDeleteLot(${idx})">🗑️ ลบ</button>
            </div>
          </div>
          <div class="tm-lot-body">
            <div class="tm-lot-field">
              <span class="tm-lot-label">Entry Price (ราคาต้นทุน)</span>
              <span class="tm-lot-val" style="color: #4ade80;">$${p.toFixed(5)}</span>
            </div>
            <div class="tm-lot-field">
              <span class="tm-lot-label">Quantity (จำนวน)</span>
              <span class="tm-lot-val" style="color: #38bdf8;">${q.toFixed(4)} ${activeBaseAsset}</span>
            </div>
            <div class="tm-lot-field">
              <span class="tm-lot-label">Est. Value (มูลค่า)</span>
              <span class="tm-lot-val">$${val.toFixed(2)} ${activeQuoteAsset}</span>
            </div>
            <div class="tm-lot-field">
              <span class="tm-lot-label">Entry Time (เวลา)</span>
              <span class="tm-lot-val" style="font-size: 10px; color: #94a3b8;">${t}</span>
            </div>
          </div>
        </div>
      `;
      })
      .join("");
  }

  // ── Trade Rounds Logic & Rendering ──────────────────────────────────────────

  function formatRoundDuration(ms) {
    if (!ms || ms <= 0) return "< 1 นาที";
    const minutes = Math.floor(ms / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    if (days > 0) return `${days} วัน ${hours % 24} ชม.`;
    if (hours > 0) return `${hours} ชม. ${minutes % 60} นาที`;
    return `${minutes} นาที`;
  }

  function formatShortDate(ts) {
    if (!ts) return "--:--";
    const d = new Date(ts);
    const day = String(d.getDate()).padStart(2, "0");
    const month = d.toLocaleDateString("th-TH", { month: "short" });
    const hours = String(d.getHours()).padStart(2, "0");
    const mins = String(d.getMinutes()).padStart(2, "0");
    return `${day} ${month} ${hours}:${mins}`;
  }

  async function loadTradeRoundsData() {
    try {
      if (elTmRoundsTbody && (!tmRounds || tmRounds.length === 0)) {
        elTmRoundsTbody.innerHTML = '<tr><td colspan="9" class="tm-empty-row">🔄 กำลังคำนวณและโหลดสรุปรอบการซื้อขาย...</td></tr>';
      }
      const res = await fetch(`${API_BASE}/api/db/rounds`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data && data.success) {
        tmRounds = Array.isArray(data.rounds) ? data.rounds : [];
        tmRoundsSummary = data.summary || null;
        if (elTmBadgeRoundsCount) elTmBadgeRoundsCount.textContent = tmRounds.length;
        renderTmRounds();
      }
    } catch (err) {
      console.error("Failed to load Trade Rounds data:", err);
      if (elTmRoundsTbody) {
        elTmRoundsTbody.innerHTML = `<tr><td colspan="9" class="tm-empty-row" style="color: #f87171;">❌ โหลดข้อมูลรอบการเทรดล้มเหลว: ${err.message}</td></tr>`;
      }
    }
  }

  function renderTmRounds() {
    // 1. Update KPI Summary Cards
    if (tmRoundsSummary) {
      const s = tmRoundsSummary;
      if (elRoundsKpiTotal) elRoundsKpiTotal.innerHTML = `${s.totalRounds} <span class="round-kpi-sub" id="roundsKpiClosed">(${s.closedRounds} จบแล้ว)</span>`;
      if (elRoundsKpiWinRate) {
        const wrColor = s.winRatePct >= 50 ? "text-green" : "text-orange";
        elRoundsKpiWinRate.className = `round-kpi-val ${wrColor}`;
        elRoundsKpiWinRate.innerHTML = `${s.winRatePct.toFixed(1)}% <span class="round-kpi-sub" id="roundsKpiWinLoss">(${s.winRounds} ชนะ / ${s.lossRounds} แพ้)</span>`;
      }
      if (elRoundsKpiBought) {
        elRoundsKpiBought.innerHTML = `$${(s.totalBoughtQuote !== undefined ? s.totalBoughtQuote : s.totalBoughtUsdso || 0).toFixed(2)} <span class="round-kpi-sub" id="roundsKpiBoughtQty">(${(s.totalBoughtBase !== undefined ? s.totalBoughtBase : s.totalBoughtSomi || 0).toFixed(2)} ${activeBaseAsset})</span>`;
      }
      if (elRoundsKpiSold) {
        elRoundsKpiSold.innerHTML = `$${(s.totalSoldQuote !== undefined ? s.totalSoldQuote : s.totalSoldUsdso || 0).toFixed(2)} <span class="round-kpi-sub" id="roundsKpiSoldQty">(${(s.totalSoldBase !== undefined ? s.totalSoldBase : s.totalSoldSomi || 0).toFixed(2)} ${activeBaseAsset})</span>`;
      }
      if (elRoundsKpiPnl) {
        const netPnlVal = s.totalNetPnlQuote !== undefined ? s.totalNetPnlQuote : (s.totalNetPnlUsdso || 0);
        const pnlColor = netPnlVal >= 0 ? "text-green" : "text-rose";
        const sign = netPnlVal >= 0 ? "+" : "";
        elRoundsKpiPnl.className = `round-kpi-val ${pnlColor}`;
        elRoundsKpiPnl.innerHTML = `${sign}$${netPnlVal.toFixed(3)} <span class="round-kpi-sub" id="roundsKpiGas">(Fee: $${(s.totalGasQuote !== undefined ? s.totalGasQuote : s.totalGasUsdso || 0).toFixed(4)})</span>`;
      }
    }

    if (!elTmRoundsTbody) return;

    if (!tmRounds || tmRounds.length === 0) {
      elTmRoundsTbody.innerHTML = '<tr><td colspan="9" class="tm-empty-row">ยังไม่มีประวัติรอบการซื้อขาย</td></tr>';
      return;
    }

    // 2. Filter rounds
    const filterStatus = elTmRoundsFilterStatus ? elTmRoundsFilterStatus.value : "ALL";
    const searchQuery = (elTmRoundsSearchInput ? elTmRoundsSearchInput.value : "").trim().toLowerCase();

    let list = tmRounds.filter((r) => {
      // Status filter
      const roundPnl = r.grossPnlQuote !== undefined ? r.grossPnlQuote : (r.grossPnlUsdso || 0);
      if (filterStatus === "WIN" && roundPnl <= 0.0001) return false;
      if (filterStatus === "LOSS" && roundPnl >= -0.0001) return false;
      if (filterStatus === "HOLDING" && r.status !== "HOLDING") return false;
      if (filterStatus === "CLOSED" && r.status !== "CLOSED") return false;
      if (filterStatus === "SELL_ONLY" && r.status !== "SELL_ONLY") return false;

      // Search filter
      if (searchQuery) {
        const str = `รอบ ${r.roundNumber} #${r.roundNumber} ${r.status} ${formatShortDate(r.startTime)} ${formatShortDate(r.endTime)}`.toLowerCase();
        if (!str.includes(searchQuery)) return false;
      }
      return true;
    });

    // 3. Sort rounds
    const sortOrder = elTmRoundsSortOrder ? elTmRoundsSortOrder.value : "NEWEST";
    list.sort((a, b) => {
      if (sortOrder === "NEWEST") return b.roundNumber - a.roundNumber;
      if (sortOrder === "OLDEST") return a.roundNumber - b.roundNumber;
      const pnlA = a.netPnlQuote !== undefined ? a.netPnlQuote : (a.netPnlUsdso || 0);
      const pnlB = b.netPnlQuote !== undefined ? b.netPnlQuote : (b.netPnlUsdso || 0);
      if (sortOrder === "PNL_DESC") return pnlB - pnlA;
      if (sortOrder === "PNL_ASC") return pnlA - pnlB;
      return b.roundNumber - a.roundNumber;
    });

    if (list.length === 0) {
      elTmRoundsTbody.innerHTML = '<tr><td colspan="9" class="tm-empty-row">ไม่พบรายการรอบที่ตรงกับเงื่อนไขการค้นหา</td></tr>';
      return;
    }

    // 4. Render Table Rows with Expandable sub-rows
    let html = "";
    for (const r of list) {
      const isExpanded = expandedRoundNumbers.has(r.roundNumber);
      const grossPnl = r.grossPnlQuote !== undefined ? r.grossPnlQuote : (r.grossPnlUsdso || 0);
      const netPnl = r.netPnlQuote !== undefined ? r.netPnlQuote : (r.netPnlUsdso !== undefined ? r.netPnlUsdso : grossPnl);
      const buyCost = r.buyCostQuote !== undefined ? r.buyCostQuote : (r.buyCostUsdso || 0);
      const sellProceeds = r.sellProceedsQuote !== undefined ? r.sellProceedsQuote : (r.sellProceedsUsdso || 0);
      const totalGas = r.totalGasQuote !== undefined ? r.totalGasQuote : (r.totalGasUsdso || 0);
      const isWin = grossPnl > 0.0001;
      const isLoss = grossPnl < -0.0001;
      const pnlColor = isWin ? "color: #34d399;" : isLoss ? "color: #f87171;" : "color: #94a3b8;";
      const pnlSign = grossPnl >= 0 ? "+" : "";

      let statusBadge = "";
      if (r.status === "CLOSED") {
        statusBadge = `<span class="round-status-pill round-status-closed">✅ CLOSED</span>`;
      } else if (r.status === "HOLDING") {
        statusBadge = `<span class="round-status-pill round-status-holding">📦 HOLDING</span>`;
      } else {
        statusBadge = `<span class="round-status-pill round-status-sellonly">⚪ SELL ONLY</span>`;
      }

      const totalTradesCount = (r.buyTrades ? r.buyTrades.length : 0) + (r.sellTrades ? r.sellTrades.length : 0);

      html += `
        <tr class="round-row ${isExpanded ? "expanded" : ""}" data-round-id="${r.roundNumber}">
          <td style="text-align: center;">
            <span class="round-num-badge">#${r.roundNumber}</span>
          </td>
          <td>
            <div style="font-size: 11.5px; font-weight: 600; color: #f1f5f9;">${formatShortDate(r.startTime)} ➔ ${formatShortDate(r.endTime)}</div>
            <span class="round-dim-info">⏱️ ระยะเวลา: ${formatRoundDuration(r.durationMs)}</span>
          </td>
          <td style="text-align: center;">
            ${statusBadge}
          </td>
          <td style="text-align: right;">
            <div class="round-buy-val">${r.buyQty.toFixed(4)} ${activeBaseAsset}</div>
            <span class="round-dim-info">$${buyCost.toFixed(2)} @ $${r.avgBuyPrice.toFixed(4)} (${r.buyCount} ไม้)</span>
          </td>
          <td style="text-align: right;">
            <div class="round-sell-val">${r.sellQty.toFixed(4)} ${activeBaseAsset}</div>
            <span class="round-dim-info">$${sellProceeds.toFixed(2)} @ $${r.avgSellPrice.toFixed(4)} (${r.sellCount} ไม้)</span>
          </td>
          <td style="text-align: right;">
            <span style="font-weight: 600; ${r.holdingQty > 0.0001 ? "color: #38bdf8;" : "color: #64748b;"}">
              ${r.holdingQty.toFixed(4)} ${activeBaseAsset}
            </span>
          </td>
          <td style="text-align: right;">
            <div style="font-weight: 700; ${pnlColor}">${pnlSign}$${netPnl.toFixed(3)}</div>
            <span class="round-dim-info" style="${pnlColor}">${pnlSign}${r.grossPnlPct.toFixed(2)}% (Gross: ${pnlSign}$${grossPnl.toFixed(2)})</span>
          </td>
          <td style="text-align: right; color: #94a3b8; font-size: 11px;">
            <div>
              <span style="font-weight: 600; color: #cbd5e1;">$${totalGas.toFixed(4)}</span>
              <span class="round-dim-info" style="font-size: 9.5px;">Fee</span>
            </div>
          </td>
          <td style="text-align: center;">
            <button class="btn-toggle-round ${isExpanded ? "expanded" : ""}" data-toggle-round="${r.roundNumber}" title="คลิกเพื่อดูไม้ซื้อ/ขายในรอบนี้">
              <span>${totalTradesCount} ไม้</span>
              <span class="toggle-arrow">▼</span>
            </button>
          </td>
        </tr>
      `;

      if (isExpanded) {
        html += `
          <tr class="round-details-tr" id="roundDetails_${r.roundNumber}">
            <td colspan="9">
              <div class="round-details-container">
                <!-- Buy Orders Breakdown -->
                <div class="round-sub-card">
                  <div class="round-sub-header header-buy">
                    <span>🟢 ไม้เข้าซื้อ (Buys Accumulation - ${r.buyTrades.length} ไม้)</span>
                    <span>รวม: $${buyCost.toFixed(2)} ${activeQuoteAsset} (${r.buyQty.toFixed(4)} ${activeBaseAsset})</span>
                  </div>
                  <table class="round-subtable">
                    <thead>
                      <tr>
                        <th>เวลา</th>
                        <th>Action</th>
                        <th style="text-align: right;">ราคา</th>
                        <th style="text-align: right;">จำนวน</th>
                        <th style="text-align: right;">มูลค่า ($)</th>
                        <th style="text-align: center;">ID</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${
                        r.buyTrades.length === 0
                          ? '<tr><td colspan="6" style="text-align: center; color: #64748b; padding: 10px;">ไม่มีไม้ซื้อในรอบนี้</td></tr>'
                          : r.buyTrades
                              .map(
                                (b) => `
                        <tr>
                          <td>${formatShortDate(b.time)}</td>
                          <td><span class="tm-badge tm-badge-buy">${b.action}</span></td>
                          <td style="text-align: right; color: #34d399;">$${b.price.toFixed(5)}</td>
                          <td style="text-align: right;">${b.qty.toFixed(4)}</td>
                          <td style="text-align: right;">$${(b.notionalQuote || b.notionalUsdso || 0).toFixed(2)}</td>
                          <td style="text-align: center; font-size: 10.5px; color: #94a3b8;">
                            ${b.orderId || "-"}
                          </td>
                        </tr>
                      `,
                              )
                              .join("")
                      }
                    </tbody>
                  </table>
                </div>

                <!-- Sell Orders Breakdown -->
                <div class="round-sub-card">
                  <div class="round-sub-header header-sell">
                    <span>🔴 ไม้ขายออก (Sells Distribution - ${r.sellTrades.length} ไม้)</span>
                    <span>รวม: $${sellProceeds.toFixed(2)} ${activeQuoteAsset} (${r.sellQty.toFixed(4)} ${activeBaseAsset})</span>
                  </div>
                  <table class="round-subtable">
                    <thead>
                      <tr>
                        <th>เวลา</th>
                        <th>Action</th>
                        <th style="text-align: right;">ราคา</th>
                        <th style="text-align: right;">จำนวน</th>
                        <th style="text-align: right;">มูลค่า ($)</th>
                        <th style="text-align: right;">PnL ($)</th>
                        <th style="text-align: center;">ID</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${
                        r.sellTrades.length === 0
                          ? '<tr><td colspan="7" style="text-align: center; color: #64748b; padding: 10px;">ยังไม่มีไม้ขายในรอบนี้</td></tr>'
                          : r.sellTrades
                              .map((s) => {
                                const trPnl = s.pnl !== undefined ? s.pnl : 0;
                                const trPnlColor = trPnl > 0 ? "color: #34d399;" : trPnl < 0 ? "color: #f87171;" : "color: #94a3b8;";
                                const trPnlSign = trPnl >= 0 ? "+" : "";
                                return `
                        <tr>
                          <td>${formatShortDate(s.time)}</td>
                          <td><span class="tm-badge tm-badge-sell">${s.action}</span></td>
                          <td style="text-align: right; color: #fb923c;">$${s.price.toFixed(5)}</td>
                          <td style="text-align: right;">${s.qty.toFixed(4)}</td>
                          <td style="text-align: right;">$${(s.notionalQuote || s.notionalUsdso || 0).toFixed(2)}</td>
                          <td style="text-align: right; font-weight: 600; ${trPnlColor}">${trPnlSign}$${trPnl.toFixed(4)}</td>
                          <td style="text-align: center; font-size: 10.5px; color: #94a3b8;">
                            ${s.orderId || "-"}
                          </td>
                        </tr>
                      `;
                              })
                              .join("")
                      }
                    </tbody>
                  </table>
                </div>
              </div>
            </td>
          </tr>
        `;
      }
    }

    elTmRoundsTbody.innerHTML = html;

    // Attach toggle listeners
    const toggleBtns = elTmRoundsTbody.querySelectorAll("[data-toggle-round]");
    toggleBtns.forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const roundNum = parseInt(btn.getAttribute("data-toggle-round"), 10);
        if (expandedRoundNumbers.has(roundNum)) {
          expandedRoundNumbers.delete(roundNum);
        } else {
          expandedRoundNumbers.add(roundNum);
        }
        renderTmRounds();
      });
    });
  }

  function exportRoundsCsv() {
    if (!tmRounds || tmRounds.length === 0) {
      alert("ไม่มีข้อมูลรอบการเทรดที่จะส่งออก");
      return;
    }

    const baseLabel = activeBaseAsset || "Base";
    const quoteLabel = activeQuoteAsset || "Quote";
    const headers = [
      "Round #",
      "Status",
      "Start Time",
      "End Time",
      "Duration (mins)",
      `Bought ${baseLabel}`,
      `Buy Cost ${quoteLabel}`,
      "Avg Buy Price",
      "Buy Orders Count",
      `Sold ${baseLabel}`,
      `Sell Proceeds ${quoteLabel}`,
      "Avg Sell Price",
      "Sell Orders Count",
      `Remaining Holding ${baseLabel}`,
      `Gross PnL ${quoteLabel}`,
      "Gross PnL %",
      `Create Gas/Fee ${quoteLabel}`,
      `Cancel Gas/Fee ${quoteLabel}`,
      `Total Gas/Fee ${quoteLabel}`,
      `Net PnL ${quoteLabel}`,
    ];

    const rows = tmRounds.map((r) => [
      r.roundNumber,
      r.status,
      new Date(r.startTime).toISOString(),
      new Date(r.endTime).toISOString(),
      Math.round(r.durationMs / 60000),
      r.buyQty.toFixed(4),
      ((r.buyCostQuote !== undefined ? r.buyCostQuote : r.buyCostUsdso) || 0).toFixed(4),
      r.avgBuyPrice.toFixed(6),
      r.buyCount,
      r.sellQty.toFixed(4),
      ((r.sellProceedsQuote !== undefined ? r.sellProceedsQuote : r.sellProceedsUsdso) || 0).toFixed(4),
      r.avgSellPrice.toFixed(6),
      r.sellCount,
      r.holdingQty.toFixed(4),
      ((r.grossPnlQuote !== undefined ? r.grossPnlQuote : r.grossPnlUsdso) || 0).toFixed(4),
      r.grossPnlPct.toFixed(2),
      (((r.createGasQuote !== undefined ? r.createGasQuote : r.createGasUsdso) || 0)).toFixed(6),
      (((r.cancelGasQuote !== undefined ? r.cancelGasQuote : r.cancelGasUsdso) || 0)).toFixed(6),
      (((r.totalGasQuote !== undefined ? r.totalGasQuote : r.totalGasUsdso) || 0)).toFixed(6),
      ((r.netPnlQuote !== undefined ? r.netPnlQuote : r.netPnlUsdso) || 0).toFixed(4),
    ]);

    const csvContent = "\uFEFF" + [headers.join(","), ...rows.map((row) => row.join(","))].join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `trade_rounds_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  window.tmOpenEditTrade = function (id) {
    if (!id) return;
    const order = tmTrades.find((o) => String(o.id) === String(id) || (o.orderId && String(o.orderId) === String(id)));
    if (!order) {
      console.warn(`[TradeManager] Order "${id}" not found in tmTrades`);
      return;
    }

    if (elEtfId) elEtfId.value = order.id || order.orderId || "";
    if (elEtfDisplayId) elEtfDisplayId.value = order.id || order.orderId || "";
    let currentAction = order.action || "BUY_FILL";
    if (order.status === "CANCELLED" || currentAction === "CANCELLED") {
      const isBuy = order.side === "BUY" || currentAction.includes("BUY") || order.action === "BUY_FILL" || order.action === "CREATE_BUY";
      currentAction = isBuy ? "CANCEL_BUY" : "CANCEL_SELL";
    }
    if (elEtfAction) elEtfAction.value = currentAction;
    if (elEtfStatus) elEtfStatus.value = order.status || "FILLED";
    if (elEtfPrice) elEtfPrice.value = order.price || 0;
    if (elEtfQty) elEtfQty.value = order.quantity || order.qty || 0;
    if (elEtfPnl) elEtfPnl.value = order.pnlUsdso !== undefined ? order.pnlUsdso : "";
    if (elEtfTime) elEtfTime.value = order.time || order.placedTime || Date.now();
    if (elEtfTimeDisplay) {
      const dt = new Date(Number(elEtfTime.value));
      elEtfTimeDisplay.value = `${dt.toLocaleDateString()} ${dt.toLocaleTimeString()} (${elEtfTime.value})`;
    }
    if (elEtfSyncLotGroup) {
      elEtfSyncLotGroup.style.display =
        order.action === "BUY_FILL" || order.action === "BUY" || order.side === "BUY" ? "block" : "none";
    }
    if (elEditTradeStatus) elEditTradeStatus.textContent = "";
    if (elEditTradeModal) {
      elEditTradeModal.classList.add("active");
      elEditTradeModal.style.display = "flex";
    }
  };

  async function handleSaveEditTrade() {
    try {
      const id = elEtfId.value;
      if (!id) return;

      const price = parseFloat(elEtfPrice.value);
      const qty = parseFloat(elEtfQty.value);
      const action = elEtfAction.value;
      const status = elEtfStatus.value;
      const pnl = elEtfPnl.value !== "" ? parseFloat(elEtfPnl.value) : undefined;
      const syncLot = elEtfSyncLot ? elEtfSyncLot.checked : true;

      if (!Number.isFinite(price) || price <= 0) {
        if (elEditTradeStatus) elEditTradeStatus.textContent = "กรุณากรอกราคาที่ถูกต้อง";
        return;
      }
      if (!Number.isFinite(qty) || qty <= 0) {
        if (elEditTradeStatus) elEditTradeStatus.textContent = "กรุณากรอกจำนวนที่ถูกต้อง";
        return;
      }

      if (elSaveEditTradeBtn) {
        elSaveEditTradeBtn.disabled = true;
        elSaveEditTradeBtn.textContent = "กำลังบันทึก...";
      }

      const res = await fetch(`${API_BASE}/api/db/trades/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id,
          updates: {
            price,
            qty,
            action,
            status,
            pnlUsdso: pnl,
            syncLot,
          },
        }),
      });

      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Update failed");

      // Update in local rawOrders for chart
      const localIdx = rawOrders.findIndex((o) => o.id === id);
      if (localIdx >= 0) {
        if (status === "CANCELLED") {
          rawOrders.splice(localIdx, 1);
        } else {
          rawOrders[localIdx].price = price;
          rawOrders[localIdx].qty = qty;
          rawOrders[localIdx].action = action;
          rawOrders[localIdx].status = status;
        }
        rebuildOrderMarkers();
      } else if (status === "FILLED" && data.order) {
        rawOrders.push(data.order);
        rebuildOrderMarkers();
      }

      if (elEditTradeModal) elEditTradeModal.style.display = "none";
      loadTradeManagerData();
      showToast({ title: "TRADE UPDATED", desc: "แก้ไข Trade Fill สำเร็จแล้ว", action: "SETTINGS" });
    } catch (err) {
      if (elEditTradeStatus) elEditTradeStatus.textContent = `❌ ${err.message}`;
    } finally {
      if (elSaveEditTradeBtn) {
        elSaveEditTradeBtn.disabled = false;
        elSaveEditTradeBtn.textContent = "💾 บันทึกการแก้ไข";
      }
    }
  }

  window.tmCancelTrade = async function (id) {
    if (!confirm("คุณต้องการเปลี่ยนสถานะของรายการนี้เป็น CANCELLED หรือไม่?\n(จุดบนกราฟแท่งเทียนจะถูกนำออกทันที)")) return;
    try {
      const res = await fetch(`${API_BASE}/api/db/trades/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id,
          opts: { permanent: false, removeMatchingLot: true },
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Cancel failed");

      removeActivityItem(id);
      rawOrders = rawOrders.filter((o) => o.id !== id && o.orderId !== id);
      rebuildOrderMarkers();
      loadTradeManagerData();
      refreshFrontPageState();
      showToast({ title: "TRADE CANCELLED", desc: "เปลี่ยนสถานะเป็น CANCELLED เรียบร้อย", action: "EXIT" });
    } catch (err) {
      alert(`ไม่สามารถยกเลิกรายการได้: ${err.message}`);
    }
  };

  window.tmDeleteTrade = async function (id) {
    if (!confirm("⚠️ คุณแน่ใจหรือไม่ว่าต้องการลบรายการนี้ออกจากฐานข้อมูลอย่างถาวร?\n(ข้อมูลจะหายไปจากประวัติและไม่สามารถกู้คืนได้)")) return;
    try {
      const res = await fetch(`${API_BASE}/api/db/trades/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id,
          opts: { permanent: true, removeMatchingLot: true },
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Delete failed");

      removeActivityItem(id);
      rawOrders = rawOrders.filter((o) => o.id !== id && o.orderId !== id);
      rebuildOrderMarkers();
      loadTradeManagerData();
      refreshFrontPageState();
      showToast({ title: "TRADE DELETED", desc: "ลบรายการ Trade Fill ถาวรสำเร็จ", action: "CUT" });
    } catch (err) {
      alert(`ไม่สามารถลบรายการได้: ${err.message}`);
    }
  };

  async function handleAddTrade() {
    try {
      const price = parseFloat(elAtfPrice.value);
      const qty = parseFloat(elAtfQty.value);
      const action = elAtfAction.value;
      const status = elAtfStatus.value;
      const pnl = elAtfPnl.value !== "" ? parseFloat(elAtfPnl.value) : undefined;
      const reason = elAtfNote.value || "Manual Entry";
      const addLot = elAtfAddLot ? elAtfAddLot.checked : true;

      if (!Number.isFinite(price) || price <= 0) {
        if (elAddTradeStatus) elAddTradeStatus.textContent = "กรุณากรอกราคาที่ถูกต้อง";
        return;
      }
      if (!Number.isFinite(qty) || qty <= 0) {
        if (elAddTradeStatus) elAddTradeStatus.textContent = "กรุณากรอกจำนวนที่ถูกต้อง";
        return;
      }

      if (elConfirmAddTradeBtn) {
        elConfirmAddTradeBtn.disabled = true;
        elConfirmAddTradeBtn.textContent = "กำลังเพิ่ม...";
      }

      const res = await fetch(`${API_BASE}/api/db/trades/add`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          price,
          qty,
          action,
          status,
          pnlUsdso: pnl,
          reason,
          addLot,
        }),
      });

      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Add trade failed");

      if (status === "FILLED" && data.order) {
        rawOrders.push(data.order);
        rebuildOrderMarkers();
      }

      if (elAddTradeModal) elAddTradeModal.style.display = "none";
      loadTradeManagerData();
      refreshFrontPageState();
      showToast({ title: "TRADE ADDED", desc: "เพิ่มรายการ Trade Fill ใหม่สำเร็จ", action: "BUY" });
    } catch (err) {
      if (elAddTradeStatus) elAddTradeStatus.textContent = `❌ ${err.message}`;
    } finally {
      if (elConfirmAddTradeBtn) {
        elConfirmAddTradeBtn.disabled = false;
        elConfirmAddTradeBtn.textContent = "➕ เพิ่ม Trade Fill";
      }
    }
  }

  window.tmOpenEditLot = function (index) {
    const lot = tmLots[index];
    if (!lot) return;
    if (elElIndex) elElIndex.value = index;
    if (elElPrice) elElPrice.value = lot.price || 0;
    if (elElQty) elElQty.value = lot.qty || 0;
    if (elElTime) elElTime.value = lot.time || Date.now();
    if (elElTimeDisplay) {
      const dt = new Date(Number(elElTime.value));
      elElTimeDisplay.value = `${dt.toLocaleDateString()} ${dt.toLocaleTimeString()}`;
    }
    if (elEditLotStatus) elEditLotStatus.textContent = "";
    if (elEditLotModal) {
      elEditLotModal.classList.add("active");
      elEditLotModal.style.display = "flex";
    }
  };

  async function handleSaveEditLot() {
    try {
      const index = parseInt(elElIndex.value, 10);
      const price = parseFloat(elElPrice.value);
      const qty = parseFloat(elElQty.value);
      const time = parseInt(elElTime.value, 10);

      if (isNaN(index) || !Number.isFinite(price) || !Number.isFinite(qty)) {
        if (elEditLotStatus) elEditLotStatus.textContent = "กรุณากรอกข้อมูลให้ครบถ้วน";
        return;
      }

      const res = await fetch(`${API_BASE}/api/db/lots/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ index, lot: { price, qty, time } }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Update lot failed");

      if (elEditLotModal) elEditLotModal.style.display = "none";
      loadTradeManagerData();
      refreshFrontPageState();
      showToast({ title: "LOT UPDATED", desc: "แก้ไข Holding Lot สำเร็จแล้ว", action: "SETTINGS" });
    } catch (err) {
      if (elEditLotStatus) elEditLotStatus.textContent = `❌ ${err.message}`;
    }
  }

  window.tmDeleteLot = async function (index) {
    if (!confirm(`คุณต้องการลบ Lot #${index + 1} ออกจากฐานข้อมูลหรือไม่?`)) return;
    try {
      const res = await fetch(`${API_BASE}/api/db/lots/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ index }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Delete lot failed");

      loadTradeManagerData();
      refreshFrontPageState();
      showToast({ title: "LOT DELETED", desc: `ลบ Lot #${index + 1} เรียบร้อยแล้ว`, action: "CUT" });
    } catch (err) {
      alert(`ไม่สามารถลบ Lot ได้: ${err.message}`);
    }
  };

  async function handleAddLot() {
    try {
      const price = parseFloat(elAlPrice.value);
      const qty = parseFloat(elAlQty.value);
      if (!Number.isFinite(price) || !Number.isFinite(qty) || price <= 0 || qty <= 0) {
        if (elAddLotStatus) elAddLotStatus.textContent = "กรุณากรอกราคาและจำนวนที่ถูกต้อง";
        return;
      }

      const res = await fetch(`${API_BASE}/api/db/lots/add`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lot: { price, qty, time: Date.now() } }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Add lot failed");

      if (elAddLotModal) elAddLotModal.style.display = "none";
      loadTradeManagerData();
      refreshFrontPageState();
      showToast({ title: "LOT ADDED", desc: "เพิ่ม Holding Lot ใหม่สำเร็จ", action: "BUY" });
    } catch (err) {
      if (elAddLotStatus) elAddLotStatus.textContent = `❌ ${err.message}`;
    }
  }

  // Event Listeners for Trade & Lot Manager
  if (elBtnOpenTradeManager) elBtnOpenTradeManager.addEventListener("click", openTradeManager);
  if (elCloseTradeManagerBtn) elCloseTradeManagerBtn.addEventListener("click", closeTradeManager);
  if (elTmBtnRefresh) elTmBtnRefresh.addEventListener("click", loadTradeManagerData);

  if (elTradeManagerModal) {
    elTradeManagerModal.addEventListener("click", (e) => {
      if (e.target === elTradeManagerModal) closeTradeManager();
    });
  }

  if (elTmTabFillsBtn) elTmTabFillsBtn.addEventListener("click", () => switchTmTab("tmTabFills"));
  if (elTmTabLotsBtn) elTmTabLotsBtn.addEventListener("click", () => switchTmTab("tmTabLots"));
  if (elTmTabRoundsBtn) elTmTabRoundsBtn.addEventListener("click", () => switchTmTab("tmTabRounds"));
  if (elBtnOpenRoundsModal) elBtnOpenRoundsModal.addEventListener("click", () => openTradeManager("tmTabRounds"));

  if (elTmSearchInput) elTmSearchInput.addEventListener("input", renderTmTrades);
  if (elTmFilterAction) elTmFilterAction.addEventListener("change", renderTmTrades);

  if (elTmRoundsSearchInput) elTmRoundsSearchInput.addEventListener("input", renderTmRounds);
  if (elTmRoundsFilterStatus) elTmRoundsFilterStatus.addEventListener("change", renderTmRounds);
  if (elTmRoundsSortOrder) elTmRoundsSortOrder.addEventListener("change", renderTmRounds);
  if (elTmRoundsBtnExportCsv) elTmRoundsBtnExportCsv.addEventListener("click", exportRoundsCsv);

  // Edit Trade
  const closeEditTradeModal = () => {
    if (elEditTradeModal) {
      elEditTradeModal.classList.remove("active");
      elEditTradeModal.style.display = "none";
    }
  };
  if (elCloseEditTradeModalBtn) elCloseEditTradeModalBtn.addEventListener("click", closeEditTradeModal);
  if (elCancelEditTradeBtn) elCancelEditTradeBtn.addEventListener("click", closeEditTradeModal);
  if (elEditTradeModal) {
    elEditTradeModal.addEventListener("click", (e) => {
      if (e.target === elEditTradeModal) closeEditTradeModal();
    });
  }
  if (elSaveEditTradeBtn) elSaveEditTradeBtn.addEventListener("click", handleSaveEditTrade);

  // Add Trade
  const closeAddTradeModal = () => {
    if (elAddTradeModal) {
      elAddTradeModal.classList.remove("active");
      elAddTradeModal.style.display = "none";
    }
  };
  if (elTmBtnOpenAddTrade)
    elTmBtnOpenAddTrade.addEventListener("click", () => {
      if (elAddTradeStatus) elAddTradeStatus.textContent = "";
      if (elAddTradeModal) {
        elAddTradeModal.classList.add("active");
        elAddTradeModal.style.display = "flex";
      }
    });
  if (elCloseAddTradeModalBtn) elCloseAddTradeModalBtn.addEventListener("click", closeAddTradeModal);
  if (elCancelAddTradeBtn) elCancelAddTradeBtn.addEventListener("click", closeAddTradeModal);
  if (elAddTradeModal) {
    elAddTradeModal.addEventListener("click", (e) => {
      if (e.target === elAddTradeModal) closeAddTradeModal();
    });
  }
  if (elConfirmAddTradeBtn) elConfirmAddTradeBtn.addEventListener("click", handleAddTrade);

  // Edit Lot
  const closeEditLotModal = () => {
    if (elEditLotModal) {
      elEditLotModal.classList.remove("active");
      elEditLotModal.style.display = "none";
    }
  };
  if (elCloseEditLotModalBtn) elCloseEditLotModalBtn.addEventListener("click", closeEditLotModal);
  if (elCancelEditLotBtn) elCancelEditLotBtn.addEventListener("click", closeEditLotModal);
  if (elEditLotModal) {
    elEditLotModal.addEventListener("click", (e) => {
      if (e.target === elEditLotModal) closeEditLotModal();
    });
  }
  if (elSaveEditLotBtn) elSaveEditLotBtn.addEventListener("click", handleSaveEditLot);

  // Add Lot
  const closeAddLotModal = () => {
    if (elAddLotModal) {
      elAddLotModal.classList.remove("active");
      elAddLotModal.style.display = "none";
    }
  };
  if (elTmBtnOpenAddLot)
    elTmBtnOpenAddLot.addEventListener("click", () => {
      if (elAddLotStatus) elAddLotStatus.textContent = "";
      if (elAddLotModal) {
        elAddLotModal.classList.add("active");
        elAddLotModal.style.display = "flex";
      }
    });
  if (elCloseAddLotModalBtn) elCloseAddLotModalBtn.addEventListener("click", closeAddLotModal);
  if (elCancelAddLotBtn) elCancelAddLotBtn.addEventListener("click", closeAddLotModal);
  if (elAddLotModal) {
    elAddLotModal.addEventListener("click", (e) => {
      if (e.target === elAddLotModal) closeAddLotModal();
    });
  }
  if (elConfirmAddLotBtn) elConfirmAddLotBtn.addEventListener("click", handleAddLot);

  // Activity Feed quick edit button delegation
  document.addEventListener("click", (e) => {
    const editBtn = e.target.closest(".feed-item-edit-btn");
    if (editBtn) {
      const tid = editBtn.getAttribute("data-trade-id");
      if (tid) {
        openTradeManager();
        setTimeout(() => {
          window.tmOpenEditTrade(tid);
        }, 150);
      }
    }
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      loadSettings();
      initChart();
      connectSSE();
      checkBotPauseStatus();
    });
  } else {
    loadSettings();
    initChart();
    connectSSE();
    checkBotPauseStatus();
  }
})();
