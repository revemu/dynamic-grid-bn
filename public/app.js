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
  const elBotVersionBadge = document.getElementById("botVersionBadge");
  const elBotVersionText = document.getElementById("botVersionText");

  function updateVersionBadge(info) {
    if (!info || !elBotVersionText) return;
    const vStr = info.version ? `v${info.version}` : "";
    const cStr = info.commit && info.commit !== "unknown" ? ` (${info.commit})` : "";
    elBotVersionText.textContent = `${vStr}${cStr}`.trim() || "v...";
    if (elBotVersionBadge) {
      const fullDate = info.commitDate ? `\nCommit Date: ${info.commitDate}` : "";
      const build = info.buildTime ? `\nBooted: ${new Date(info.buildTime).toLocaleString()}` : "";
      elBotVersionBadge.title = `Dynamic Grid ${vStr}\nCommit: ${info.commit || "local"}${fullDate}${build}\n(คลิกเพื่อดูรายละเอียด /api/version)`;
      elBotVersionBadge.onclick = () => {
        window.open(`${API_BASE}/api/version`, "_blank");
      };
    }
  }

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
  const elLadderResistanceBanner = document.getElementById("ladderResistanceBanner");
  const elLadderCurrentLevel = document.getElementById("ladderCurrentLevel");
  const elLadderTargetAlloc = document.getElementById("ladderTargetAlloc");

  const elStepCeil = document.getElementById("stepCeil");
  const elStepSell5 = document.getElementById("stepSell5");
  const elStepSell4 = document.getElementById("stepSell4");
  const elStepSell3 = document.getElementById("stepSell3");
  const elStepSell2 = document.getElementById("stepSell2");
  const elStepSell1 = document.getElementById("stepSell1");
  const elStepCenter = document.getElementById("stepCenter");
  const elStepBuy1 = document.getElementById("stepBuy1");
  const elStepBuy2 = document.getElementById("stepBuy2");
  const elStepBuy3 = document.getElementById("stepBuy3");
  const elStepBuy4 = document.getElementById("stepBuy4");
  const elStepBuy5 = document.getElementById("stepBuy5");
  const elStepFloor = document.getElementById("stepFloor");

  const elStepPriceCeil = document.getElementById("stepPriceCeil");
  const elStepPriceSell5 = document.getElementById("stepPriceSell5");
  const elStepPriceSell4 = document.getElementById("stepPriceSell4");
  const elStepPriceSell3 = document.getElementById("stepPriceSell3");
  const elStepPriceSell2 = document.getElementById("stepPriceSell2");
  const elStepPriceSell1 = document.getElementById("stepPriceSell1");
  const elStepPriceCenter = document.getElementById("stepPriceCenter");
  const elStepPriceBuy1 = document.getElementById("stepPriceBuy1");
  const elStepPriceBuy2 = document.getElementById("stepPriceBuy2");
  const elStepPriceBuy3 = document.getElementById("stepPriceBuy3");
  const elStepPriceBuy4 = document.getElementById("stepPriceBuy4");
  const elStepPriceBuy5 = document.getElementById("stepPriceBuy5");
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
  const elHudBestBid = document.getElementById("hudBestBid");
  const elHudBestAsk = document.getElementById("hudBestAsk");
  const elTopBookSpread = document.getElementById("topBookSpread");
  const elTopBidSubText = document.getElementById("topBidSubText");
  const elTopAskSubText = document.getElementById("topAskSubText");
  const elTopBidStatusBadge = document.getElementById("topBidStatusBadge");
  const elTopAskStatusBadge = document.getElementById("topAskStatusBadge");
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
  // MA Fan Ribbon Series (4, 8, 16, 25, 75, 200)
  let ema4Series = null;
  let ema8Series = null;
  let ema16Series = null;
  let ema25Series = null;
  let ema75Series = null;
  let ema200Series = null;

  // MA Fan Candle Inspector & Spread State
  const maFanCandleDataMap = new Map();
  let pinnedCandleTime = null;
  const elCandleInspectorCard = document.getElementById("candleInspectorCard");
  const elChartPinnedCandleMarker = document.getElementById("chartPinnedCandleMarker");
  const elLegFanSpreadChip = document.getElementById("legFanSpreadChip");
  const elLegFanSpreadVal = document.getElementById("legFanSpreadVal");

  const DEFAULT_MA_COLORS = {
    c4: "#38bdf8",
    c8: "#0284c7",
    c16: "#3b82f6",
    c25: "#f59e0b",
    c75: "#a855f7",
    c200: "#f43f5e",
  };

  function getMaFanColors() {
    try {
      const saved = localStorage.getItem("ma_fan_colors");
      if (saved) return { ...DEFAULT_MA_COLORS, ...JSON.parse(saved) };
    } catch (_) {}
    return { ...DEFAULT_MA_COLORS };
  }

  function applyMaFanColors(colors) {
    const c = colors || getMaFanColors();
    if (ema4Series) ema4Series.applyOptions({ color: c.c4 });
    if (ema8Series) ema8Series.applyOptions({ color: c.c8 });
    if (ema16Series) ema16Series.applyOptions({ color: c.c16 });
    if (ema25Series) ema25Series.applyOptions({ color: c.c25 });
    if (ema75Series) ema75Series.applyOptions({ color: c.c75 });
    if (ema200Series) ema200Series.applyOptions({ color: c.c200 });
  }
  let isWaveVisible = true;
  const elWaveStatusPill = document.getElementById("waveStatusPill");
  const elWaveStatusText = document.getElementById("waveStatusText");
  const btnToggleWave = document.getElementById("btnToggleWave");
  let orderMarkers = [];
  let rawOrders = [];
  let structureMarkers = [];
  let pendingCandles = null;
  let pendingTick = null;
  let activeSymbol = "SOMI:USDso";
  let activeBaseAsset = "BASE";
  let activeQuoteAsset = "USDT";
  let activePricePrecision = 2;
  let activeQtyPrecision = 4;
  let activeTickSize = 0.01;
  let activeStepSize = 0.0001;
  let latestGridData = null;

  function fmtPrice(p, prec = activePricePrecision) {
    if (typeof p !== "number" || !Number.isFinite(p)) return "";
    let effectivePrec = prec;
    if (effectivePrec === 2 && typeof p === "number" && p > 0) {
      if (p < 0.01) effectivePrec = 6;
      else if (p < 1) effectivePrec = 5;
      else if (p < 10) effectivePrec = 4;
    }
    return p.toFixed(effectivePrec);
  }

  function fmtQty(q, prec = activeQtyPrecision) {
    if (typeof q !== "number" || !Number.isFinite(q)) return "";
    return q.toFixed(prec);
  }

  function updateChartPrecision(precision, minMove) {
    if (!chart) return;
    const pFormat = {
      type: "price",
      precision: precision,
      minMove: minMove || (1 / Math.pow(10, precision)),
    };
    try {
      if (candleSeries) candleSeries.applyOptions({ priceFormat: pFormat });
      if (downtrendLineSeries) downtrendLineSeries.applyOptions({ priceFormat: pFormat });
      if (uptrendLineSeries) uptrendLineSeries.applyOptions({ priceFormat: pFormat });
      if (waveCycleLineSeries) waveCycleLineSeries.applyOptions({ priceFormat: pFormat });
      chart.applyOptions({
        localization: {
          priceFormatter: (price) =>
            typeof price === "number" && Number.isFinite(price) ? fmtPrice(price, precision) : "",
        },
      });
    } catch (e) {
      console.warn("Failed to apply chart precision", e);
    }
  }
  let isHoldingActivePosition = false;
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
              <span class="cot-val-price">$${fmtPrice(price)}</span>
            </div>
            <div class="cot-card-row">
              <span class="cot-label">Amount:</span>
              <span class="cot-val-qty">${fmtQty(qty)} ${activeBaseAsset} <span class="cot-dim">($${notional.toFixed(2)})</span></span>
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
            <span class="cot-val-qty">${fmtQty(totalQty)} ${activeBaseAsset} ($${totalNotional.toFixed(2)})</span>
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
  let openOrderPriceLines = [];
  let lineSwingEntry = null;
  let lineSwingTp1 = null;
  let lineSwingTp2 = null;
  let lineSwingSl = null;
  let lineSwingNextEntry = null;
  let lineMfEntry = null;
  let lineMfTp1 = null;
  let lineMfTp2 = null;
  let lineMfSl = null;
  let lineHtfCeil = null;
  let lineHtfFloor = null;
  let linePoc = null;
  let showHtfLines = true;
  let currentActiveTimeframe = "15m";
  let cachedPrimaryCandles = [];
  let cachedHtfCandles = [];

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
            top: 0.08,
            bottom: 0.08,
          },
        },
        timeScale: {
          borderColor: "rgba(255, 255, 255, 0.08)",
          timeVisible: true,
          secondsVisible: false,
          rightOffset: 20,
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
        wickUpColor: "#34d399",
        wickDownColor: "#fb7185",
        priceFormat: {
          type: "price",
          precision: activePricePrecision,
          minMove: activeTickSize || (1 / Math.pow(10, activePricePrecision)),
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
          precision: activePricePrecision,
          minMove: activeTickSize || (1 / Math.pow(10, activePricePrecision)),
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
          precision: activePricePrecision,
          minMove: activeTickSize || (1 / Math.pow(10, activePricePrecision)),
        },
      });

      // Wave Cycle Series (Subtle Slate/Blue line connecting Dow Swings in background, does not clash with candles)
      waveCycleLineSeries = chart.addLineSeries({
        color: "rgba(148, 163, 184, 0.40)",
        lineWidth: 1,
        lineStyle: lc.LineStyle ? lc.LineStyle.Solid : 0,
        title: "",
        lastValueVisible: false,
        priceLineVisible: false,
        priceFormat: {
          type: "price",
          precision: activePricePrecision,
          minMove: activeTickSize || (1 / Math.pow(10, activePricePrecision)),
        },
      });

      // ── MA Fan Ribbon 6 Series (4, 8, 16, 25, 75, 200) ──────────────────────
      const pFormat = {
        type: "price",
        precision: activePricePrecision,
        minMove: activeTickSize || (1 / Math.pow(10, activePricePrecision)),
      };
      const maColors = getMaFanColors();
      ema4Series = chart.addLineSeries({
        color: maColors.c4, // EMA 4
        lineWidth: 1,
        lineStyle: lc.LineStyle ? lc.LineStyle.Solid : 0,
        title: "",
        lastValueVisible: false,
        priceLineVisible: false,
        priceFormat: pFormat,
      });
      ema8Series = chart.addLineSeries({
        color: maColors.c8, // EMA 8
        lineWidth: 1,
        lineStyle: lc.LineStyle ? lc.LineStyle.Solid : 0,
        title: "",
        lastValueVisible: false,
        priceLineVisible: false,
        priceFormat: pFormat,
      });
      ema16Series = chart.addLineSeries({
        color: maColors.c16, // EMA 16
        lineWidth: 1,
        lineStyle: lc.LineStyle ? lc.LineStyle.Solid : 0,
        title: "",
        lastValueVisible: false,
        priceLineVisible: false,
        priceFormat: pFormat,
      });
      ema25Series = chart.addLineSeries({
        color: maColors.c25, // EMA 25
        lineWidth: 2,
        lineStyle: lc.LineStyle ? lc.LineStyle.Solid : 0,
        title: "",
        lastValueVisible: false,
        priceLineVisible: false,
        priceFormat: pFormat,
      });
      ema75Series = chart.addLineSeries({
        color: maColors.c75, // EMA 75
        lineWidth: 2,
        lineStyle: lc.LineStyle ? lc.LineStyle.Solid : 0,
        title: "",
        lastValueVisible: false,
        priceLineVisible: false,
        priceFormat: pFormat,
      });
      ema200Series = chart.addLineSeries({
        color: maColors.c200, // EMA 200
        lineWidth: 2,
        lineStyle: lc.LineStyle ? lc.LineStyle.Solid : 0,
        title: "",
        lastValueVisible: false,
        priceLineVisible: false,
        priceFormat: pFormat,
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
          if (!pinnedCandleTime && latestCandle) {
            renderOhlc(latestCandle);
            updateMaLegendForCandle(latestCandle.time);
          }
          hideChartOrderTooltip();
          return;
        }
        const bar = param.seriesData.get(candleSeries);
        if (bar) {
          renderOhlc(bar);
        } else if (latestCandle) {
          renderOhlc(latestCandle);
        }

        if (param.time) {
          updateMaLegendForCandle(param.time);
        }

        renderChartOrderTooltip(param.time, param.point);
      });

      // Click to Pin / Inspect Candle & Spread (Clears previous pin if clicking another candle)
      chart.subscribeClick((param) => {
        if (!param || !param.time) {
          closeCandleInspector();
          return;
        }
        const clickedTime = param.time;
        if (pinnedCandleTime === clickedTime) {
          closeCandleInspector();
          return;
        }
        openCandleInspector(clickedTime);
      });

      chartContainer.addEventListener("mouseleave", () => {
        hideChartOrderTooltip();
      });

      // Synchronize circular order badges and candle inspector with chart scroll, pan, zoom, and drag
      chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
        updateOrderBadgesPositions();
        updateSwingBadgesPositions();
        updateCandleInspectorPosition();
      });
      chart.timeScale().subscribeVisibleTimeRangeChange(() => {
        updateOrderBadgesPositions();
        updateSwingBadgesPositions();
        updateCandleInspectorPosition();
      });
      chartContainer.addEventListener("mousemove", (e) => {
        if (e.buttons > 0) {
          updateOrderBadgesPositions();
          updateSwingBadgesPositions();
          updateCandleInspectorPosition();
        }
      });
      chartContainer.addEventListener("wheel", () => {
        requestAnimationFrame(() => {
          updateOrderBadgesPositions();
          updateSwingBadgesPositions();
          updateCandleInspectorPosition();
        });
      }, { passive: true });

      if (window.ResizeObserver) {
        const ro = new ResizeObserver((entries) => {
          for (const entry of entries) {
            const { width, height } = entry.contentRect;
            if (width > 0 && height > 0 && chart) {
              chart.applyOptions({ width, height });
              updateOrderBadgesPositions();
              updateSwingBadgesPositions();
              updateCandleInspectorPosition();
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
            updateCandleInspectorPosition();
          }
        });
      }

      if (btnFitChart) {
        btnFitChart.addEventListener("click", () => {
          chart.timeScale().fitContent();
          chart.timeScale().applyOptions({ rightOffset: 20 });
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
          if (elChartSwingBadgesLayer) {
            elChartSwingBadgesLayer.style.display = isWaveVisible ? "block" : "none";
          }
          refreshMarkers();
        });
      }

      const btnToggleHtfLines = document.getElementById("btnToggleHtfLines");
      if (btnToggleHtfLines) {
        btnToggleHtfLines.addEventListener("click", () => {
          showHtfLines = !showHtfLines;
          btnToggleHtfLines.classList.toggle("active", showHtfLines);
          if (!showHtfLines) {
            if (lineHtfCeil) { try { candleSeries.removePriceLine(lineHtfCeil); } catch (_) {} lineHtfCeil = null; }
            if (lineHtfFloor) { try { candleSeries.removePriceLine(lineHtfFloor); } catch (_) {} lineHtfFloor = null; }
            if (linePoc) { try { candleSeries.removePriceLine(linePoc); } catch (_) {} linePoc = null; }
          } else if (pendingTick) {
            updateTick(pendingTick);
          }
        });
      }

      const btnTf15m = document.getElementById("btnTf15m");
      const btnTf4h = document.getElementById("btnTf4h");
      if (btnTf15m) {
        btnTf15m.addEventListener("click", () => {
          if (currentActiveTimeframe === "15m") return;
          currentActiveTimeframe = "15m";
          btnTf15m.classList.add("active");
          if (btnTf4h) btnTf4h.classList.remove("active");
          applyCurrentTimeframeCandles();
        });
      }
      if (btnTf4h) {
        btnTf4h.addEventListener("click", () => {
          if (currentActiveTimeframe === "4h") return;
          currentActiveTimeframe = "4h";
          btnTf4h.classList.add("active");
          if (btnTf15m) btnTf15m.classList.remove("active");
          if (!cachedHtfCandles || cachedHtfCandles.length === 0) {
            fetch("/api/candles/htf")
              .then((res) => res.json())
              .then((data) => {
                if (data.candles && data.candles.length > 0) {
                  updateHtfCandles(data.candles);
                }
              })
              .catch((err) => console.warn("Failed to fetch HTF candles:", err));
          } else {
            applyCurrentTimeframeCandles();
          }
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
    if (elLegendO) elLegendO.textContent = fmtPrice(open);
    if (elLegendH) elLegendH.textContent = fmtPrice(high);
    if (elLegendL) elLegendL.textContent = fmtPrice(low);
    if (elLegendC) elLegendC.textContent = fmtPrice(close);

    if (open > 0 && elLegendChange) {
      const diffPct = ((close - open) / open) * 100;
      const sign = diffPct >= 0 ? "+" : "";
      elLegendChange.textContent = `${sign}${diffPct.toFixed(2)}%`;
      elLegendChange.className = "ohlc-val " + (diffPct >= 0 ? "pnl-positive" : "pnl-negative");
    }
  }

  function formatCandles(candles) {
    if (!candles || candles.length === 0) return [];
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
    return Array.from(timeMap.values()).sort((a, b) => a.time - b.time);
  }

  function calcEMAForChart(candles, period) {
    if (!Array.isArray(candles) || candles.length === 0) return [];
    const k = 2 / (period + 1);
    const data = [];
    const initial = Math.min(period, candles.length);
    let sum = 0;
    for (let i = 0; i < initial; i++) sum += candles[i].close;
    let prevEma = sum / initial;

    for (let i = 0; i < candles.length; i++) {
      if (i < initial - 1) continue;
      if (i === initial - 1) {
        data.push({ time: candles[i].time, value: prevEma });
      } else {
        prevEma = candles[i].close * k + prevEma * (1 - k);
        data.push({ time: candles[i].time, value: prevEma });
      }
    }
    return data;
  }

  function updateMaFanRibbonLines(candles) {
    if (!ema4Series || !ema8Series || !ema16Series || !ema25Series || !ema75Series || !ema200Series) return;
    const isMaFanMode = latestGridData?.strategyType === "ma_fan" || latestGridData?.strategyMode === "ma_fan" || (document.getElementById("cfg_strategyType")?.value === "ma_fan");

    const elLegendMaRow = document.getElementById("legendMaRow");
    const elLegendDowRow = document.getElementById("legendDowRow");

    if (!isMaFanMode || !candles || candles.length < 10) {
      ema4Series.setData([]);
      ema8Series.setData([]);
      ema16Series.setData([]);
      ema25Series.setData([]);
      ema75Series.setData([]);
      ema200Series.setData([]);
      if (elLegendMaRow) elLegendMaRow.style.display = "none";
      if (elLegendDowRow) elLegendDowRow.style.display = "flex";
      return;
    }

    if (elLegendMaRow) elLegendMaRow.style.display = "flex";
    if (elLegendDowRow) elLegendDowRow.style.display = "none";

    try {
      const e4 = calcEMAForChart(candles, 4);
      const e8 = calcEMAForChart(candles, 8);
      const e16 = calcEMAForChart(candles, 16);
      const e25 = calcEMAForChart(candles, 25);
      const e75 = calcEMAForChart(candles, 75);
      const e200 = calcEMAForChart(candles, 200);

      ema4Series.setData(e4);
      ema8Series.setData(e8);
      ema16Series.setData(e16);
      ema25Series.setData(e25);
      ema75Series.setData(e75);
      ema200Series.setData(e200);

      // Populate maFanCandleDataMap for crosshair and click inspector
      const e4Map = new Map(e4.map((x) => [x.time, x.value]));
      const e8Map = new Map(e8.map((x) => [x.time, x.value]));
      const e16Map = new Map(e16.map((x) => [x.time, x.value]));
      const e25Map = new Map(e25.map((x) => [x.time, x.value]));
      const e75Map = new Map(e75.map((x) => [x.time, x.value]));
      const e200Map = new Map(e200.map((x) => [x.time, x.value]));

      maFanCandleDataMap.clear();
      for (let i = 0; i < candles.length; i++) {
        const c = candles[i];
        const v4 = e4Map.get(c.time);
        const v8 = e8Map.get(c.time);
        const v16 = e16Map.get(c.time);
        const v25 = e25Map.get(c.time);
        const v75 = e75Map.get(c.time);
        const v200 = e200Map.get(c.time);

        if (v4 !== undefined && v25 !== undefined) {
          const spreadPct = v25 > 0 ? (Math.abs(v25 - v4) / v25) * 100 : 0;
          const prevC = i > 0 ? candles[i - 1] : null;
          const prevV4 = prevC ? e4Map.get(prevC.time) : v4;
          const prevV8 = prevC ? e8Map.get(prevC.time) : v8;
          const prevV16 = prevC ? e16Map.get(prevC.time) : v16;
          const prevV25 = prevC ? e25Map.get(prevC.time) : v25;

          const isCurBullish = v8 !== undefined && v16 !== undefined && (v4 > v8 && v8 > v16 && v16 > v25);
          const isFanningDown =
            !isCurBullish &&
            v4 <= v25 &&
            v8 !== undefined && v16 !== undefined &&
            ((v4 < v8 && v8 < v16 && v16 < v25) ||
              (prevV4 !== undefined && prevV4 < prevV8 && prevV8 < prevV16 && prevV16 < prevV25 && v4 <= v16));

          const isFanningUp =
            (v8 !== undefined && v16 !== undefined && (v4 > v8 && v8 > v16 && v16 > v25)) ||
            (prevV4 !== undefined && prevV4 > prevV8 && prevV8 > prevV16 && prevV16 > prevV25);

          const isHookUp = prevV4 !== undefined && v4 > prevV4 && v4 <= v25 * 1.002 && c.close < v25;

          const range = c.high - c.low;
          const bodyBottom = Math.min(c.open, c.close);
          const lowerWick = bodyBottom - c.low;
          const lowerWickPct = range > 0 ? (lowerWick / range) * 100 : 0;
          const isOversoldWick = lowerWickPct >= 30;

          maFanCandleDataMap.set(c.time, {
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
            isFanningUp,
            isHookUp,
            lowerWickPct,
            isOversoldWick,
          });
        }
      }

      // Update in-chart legend values for active or latest candle
      const activeTime = pinnedCandleTime || (candles.length > 0 ? candles[candles.length - 1].time : null);
      if (activeTime) updateMaLegendForCandle(activeTime);
      if (pinnedCandleTime) updateCandleInspectorPosition();
    } catch (err) {
      console.warn("Error updating MA Fan lines:", err);
    }
  }

  // Update in-chart legend EMA and Fan Spread chip for a specific candle
  function updateMaLegendForCandle(time) {
    if (!time || !maFanCandleDataMap.has(time)) return;
    const data = maFanCandleDataMap.get(time);
    const curColors = getMaFanColors();

    const el4 = document.getElementById("legEma4"); if (el4) { el4.textContent = fmtPrice(data.ema4); el4.style.color = curColors.c4; }
    const el8 = document.getElementById("legEma8"); if (el8) { el8.textContent = fmtPrice(data.ema8); el8.style.color = curColors.c8; }
    const el16 = document.getElementById("legEma16"); if (el16) { el16.textContent = fmtPrice(data.ema16); el16.style.color = curColors.c16; }
    const el25 = document.getElementById("legEma25"); if (el25) { el25.textContent = fmtPrice(data.ema25); el25.style.color = curColors.c25; }
    const el75 = document.getElementById("legEma75"); if (el75) { el75.textContent = fmtPrice(data.ema75); el75.style.color = curColors.c75; }
    const el200 = document.getElementById("legEma200"); if (el200) { el200.textContent = fmtPrice(data.ema200); el200.style.color = curColors.c200; }

    const targetSpread = latestGridData?.effectiveSpreadThreshold || latestGridData?.fanSpreadThreshold || latestGridData?.minFanSpread || 0.25;
    if (elLegFanSpreadChip && elLegFanSpreadVal) {
      if (data.spreadPct >= targetSpread) {
        elLegFanSpreadChip.style.background = "rgba(16, 185, 129, 0.2)";
        elLegFanSpreadChip.style.borderColor = "rgba(16, 185, 129, 0.5)";
        elLegFanSpreadChip.style.color = "#34d399";
        elLegFanSpreadVal.textContent = `${data.spreadPct.toFixed(2)}% (กางตึง ✅)`;
      } else {
        elLegFanSpreadChip.style.background = "rgba(245, 158, 11, 0.15)";
        elLegFanSpreadChip.style.borderColor = "rgba(245, 158, 11, 0.35)";
        elLegFanSpreadChip.style.color = "#fbbf24";
        elLegFanSpreadVal.textContent = `${data.spreadPct.toFixed(2)}% (ยังไม่ตึง ⚠️)`;
      }
    }
  }

  // Open Candle & Spread Inspector Popover for clicked candle
  function openCandleInspector(candleTime) {
    if (!elCandleInspectorCard || !chart || !candleSeries) return;
    const data = maFanCandleDataMap.get(candleTime);
    if (!data) return;

    pinnedCandleTime = candleTime;
    const c = data.candle;
    const d = new Date(c.time * 1000);
    const dateStr = d.toLocaleDateString([], { month: "short", day: "numeric" });
    const timeStr = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const changePct = c.open > 0 ? ((c.close - c.open) / c.open) * 100 : 0;
    const changeColor = changePct >= 0 ? "#34d399" : "#f87171";

    const targetSpread = latestGridData?.effectiveSpreadThreshold || latestGridData?.fanSpreadThreshold || latestGridData?.minFanSpread || 0.25;
    const isSpreadReady = data.spreadPct >= targetSpread;
    const spreadDiff = data.spreadPct - targetSpread;

    // 4-point Sniper conditions
    const condOrder = data.isFanningDown && data.ema4 <= data.ema25;
    const condSpread = isSpreadReady && data.ema4 <= data.ema25;
    const condHook = data.isHookUp && c.close < data.ema25;
    const condExhaust = data.isOversoldWick;

    const allReady = condOrder && condSpread && condHook && condExhaust;

    let verdictHtml = "";
    if (allReady) {
      verdictHtml = `<div class="cic-verdict cic-verdict-ready">🟢 แท่งนี้เข้าเกณฑ์ Sniper ครบ 4 ข้อ! (จังหวะเปิดไม้ BUY)</div>`;
    } else {
      const missing = [];
      if (!condSpread) missing.push(data.ema4 > data.ema25 ? `พัดกางผิดทิศ (EMA4 อยู่เหนือ EMA25)` : `Spread ขาดอีก ${Math.abs(spreadDiff).toFixed(2)}%`);
      if (!condHook) missing.push(c.close >= data.ema25 ? `ราคาปิดอยู่สูงกว่า EMA25 (หลุดโซนย่อ)` : `ปลายพัดยังไม่ม้วนตัวขึ้น`);
      if (!condOrder) missing.push(`พัดยังไม่เรียงตัวขาลง`);
      if (!condExhaust) missing.push(`แท่งเทียนยังไม่ทิ้งไส้ล่าง`);
      verdictHtml = `<div class="cic-verdict cic-verdict-wait">⚠️ แท่งนี้ยังไม่เข้าเกณฑ์: ${missing.join(", ")}</div>`;
    }

    elCandleInspectorCard.innerHTML = `
      <div class="cic-header">
        <span class="cic-title">🔬 ตรวจวัดแท่งเทียน (Candle & Spread)</span>
        <button class="cic-close-btn" onclick="window.closeCandleInspector()" title="ปิดหน้าต่าง">✖</button>
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
          <span>4. แรงซื้อดีดกลับ (Oversold Wick)</span>
          <span style="color: ${condExhaust ? "#34d399" : "#f87171"}; font-weight:700;">${condExhaust ? "✅ ผ่าน" : "⏳ ไม่มี"}</span>
        </div>
      </div>

      ${verdictHtml}
    `;

    elCandleInspectorCard.classList.add("active");
    if (elChartPinnedCandleMarker) elChartPinnedCandleMarker.classList.add("active");

    updateCandleInspectorPosition();
    updateMaLegendForCandle(candleTime);
  }

  function closeCandleInspector() {
    pinnedCandleTime = null;
    if (elCandleInspectorCard) {
      elCandleInspectorCard.classList.remove("active");
      elCandleInspectorCard.style.display = "none";
    }
    if (elChartPinnedCandleMarker) {
      elChartPinnedCandleMarker.classList.remove("active");
      elChartPinnedCandleMarker.style.display = "none";
    }
    if (latestCandle) updateMaLegendForCandle(latestCandle.time);
  }
  window.closeCandleInspector = closeCandleInspector;

  function updateCandleInspectorPosition() {
    if (!pinnedCandleTime || !elCandleInspectorCard || !chart || !chartContainer) {
      if (elCandleInspectorCard) {
        elCandleInspectorCard.classList.remove("active");
        elCandleInspectorCard.style.display = "none";
      }
      if (elChartPinnedCandleMarker) {
        elChartPinnedCandleMarker.classList.remove("active");
        elChartPinnedCandleMarker.style.display = "none";
      }
      return;
    }
    const x = chart.timeScale().timeToCoordinate(pinnedCandleTime);
    if (x === null || x < -50 || x > chartContainer.clientWidth + 50) {
      elCandleInspectorCard.style.display = "none";
      if (elChartPinnedCandleMarker) elChartPinnedCandleMarker.style.display = "none";
      return;
    }

    elCandleInspectorCard.style.display = "block";
    if (elChartPinnedCandleMarker) {
      elChartPinnedCandleMarker.style.display = "block";
      elChartPinnedCandleMarker.style.left = `${Math.round(x)}px`;
    }

    const cardWidth = elCandleInspectorCard.offsetWidth || 300;
    const cardHeight = elCandleInspectorCard.offsetHeight || 340;
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

    elCandleInspectorCard.style.left = `${Math.round(left)}px`;
    elCandleInspectorCard.style.top = `${Math.round(top)}px`;
  }

  function applyCurrentTimeframeCandles() {
    if (!candleSeries || !chart) return;
    const targetList = currentActiveTimeframe === "4h" ? cachedHtfCandles : cachedPrimaryCandles;
    const cleanCandles = formatCandles(targetList);
    if (cleanCandles.length > 0) {
      try {
        candleSeries.setData(cleanCandles);
        updateMaFanRibbonLines(cleanCandles);
        latestCandle = cleanCandles[cleanCandles.length - 1];
        latestCandleTime = latestCandle.time;
        renderOhlc(latestCandle);
        rebuildOrderMarkers();
        refreshMarkers();
        chart.timeScale().fitContent();
        chart.timeScale().applyOptions({ rightOffset: 20 });
        updateOrderBadgesPositions();
        updateSwingBadgesPositions();
      } catch (err) {
        console.error("Failed to set candle data for timeframe:", currentActiveTimeframe, err);
      }
    }
  }

  function updateCandles(candles) {
    if (!candles || candles.length === 0) return;
    cachedPrimaryCandles = candles;
    pendingCandles = candles;
    if (currentActiveTimeframe === "15m") {
      applyCurrentTimeframeCandles();
    }
  }

  function updateHtfCandles(candles) {
    if (!candles || candles.length === 0) return;
    cachedHtfCandles = candles;
    if (currentActiveTimeframe === "4h") {
      applyCurrentTimeframeCandles();
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

    if (cachedPrimaryCandles) {
      const idx = cachedPrimaryCandles.findIndex((c) => c.time === formatted.time);
      if (idx >= 0) cachedPrimaryCandles[idx] = formatted;
      else cachedPrimaryCandles.push(formatted);
    }
    pendingCandles = cachedPrimaryCandles;

    if (currentActiveTimeframe === "15m") {
      latestCandle = formatted;
      renderOhlc(latestCandle);

      if (candleSeries) {
        try {
          candleSeries.update(formatted);
          latestCandleTime = Math.max(latestCandleTime, candle.time);
          updateOrderBadgesPositions();
          updateSwingBadgesPositions();
          updateMaFanRibbonLines(cachedPrimaryCandles);
        } catch (err) {
          console.warn("Error updating single candle:", err);
        }
      }
    }
  }

  function updateSingleHtfCandle(candle) {
    if (!candle || typeof candle.time !== "number") return;
    if (![candle.open, candle.high, candle.low, candle.close].every(Number.isFinite)) return;

    const formatted = {
      time: candle.time,
      open: Number(candle.open),
      high: Number(candle.high),
      low: Number(candle.low),
      close: Number(candle.close),
    };

    if (cachedHtfCandles) {
      const idx = cachedHtfCandles.findIndex((c) => c.time === formatted.time);
      if (idx >= 0) cachedHtfCandles[idx] = formatted;
      else cachedHtfCandles.push(formatted);
    }

    if (currentActiveTimeframe === "4h") {
      latestCandle = formatted;
      renderOhlc(latestCandle);

      if (candleSeries) {
        try {
          candleSeries.update(formatted);
          latestCandleTime = Math.max(latestCandleTime, candle.time);
          updateOrderBadgesPositions();
          updateSwingBadgesPositions();
          updateMaFanRibbonLines(cachedPrimaryCandles);
        } catch (err) {
          console.warn("Error updating single HTF candle:", err);
        }
      }
    }
  }

  function updateSwingTradePlanUI(data) {
    const elSignalType = document.getElementById("stpSignalType");
    const elSignalDesc = document.getElementById("stpSignalDesc");
    const elTp2Price = document.getElementById("stpTp2Price");
    const elTp2Gain = document.getElementById("stpTp2Gain");
    const elTp1Price = document.getElementById("stpTp1Price");
    const elTp1Gain = document.getElementById("stpTp1Gain");
    const elEntryTitle = document.getElementById("stpEntryTitle");
    const elEntryStatus = document.getElementById("stpEntryStatus");
    const elEntryPrice = document.getElementById("stpEntryPrice");
    const elSlPrice = document.getElementById("stpSlPrice");
    const elSlRisk = document.getElementById("stpSlRisk");
    const elRrRatio = document.getElementById("stpRrRatio");
    const elStatusText = document.getElementById("stpStatusText");
    const elPosQty = document.getElementById("stpPosQty");

    const plan = data.swingPlan || {};
    const pos = data.activePosition;
    const signal = data.lastSignal;
    const refPrice = data.mid || data.refPrice || 0;

    const entryPrice = plan.entryPrice || pos?.entryPrice || (signal?.hasSignal ? signal.entryPrice : 0);
    const slPrice = plan.stopLossPrice || pos?.stopLossPrice || (signal?.hasSignal ? signal.stopLossPrice : 0);
    const tp1Price = plan.tp1Price || pos?.tp1Price || (signal?.hasSignal ? signal.tp1Price : 0);
    const tp2Price = plan.tp2Price || pos?.tp2Price || (signal?.hasSignal ? signal.tp2Price : 0);
    const rrRatio = plan.riskRewardRatio || (signal?.hasSignal ? signal.riskRewardRatio : 0);

    // Update Signal Banner
    if (elSignalType && elSignalDesc) {
      if (pos) {
        if (plan.isTrappedPosition) {
          elSignalType.textContent = "⚠️ Trapped Position (TP Aligned to TL)";
          elSignalType.style.color = "#f59e0b";
          elSignalDesc.textContent = `Entry $${fmtPrice(pos.entryPrice)} is near/above trendline. Target adjusted to Trendline for clean breakeven exit.`;
        } else {
          elSignalType.textContent = pos.tp1Executed
            ? "🚀 TP1 Done — Trailing Trend"
            : `📈 In Swing Position (${pos.signalType})`;
          elSignalType.style.color = "#10b981";
          elSignalDesc.textContent = pos.reason || "Holding position with dynamic SL & TP targets";
        }
      } else if (signal && signal.hasSignal) {
        let typeBadge = "⭐ Higher Low (HL) Base Setup";
        if (signal.signalType === "LL_RETEST_BOUNCE") typeBadge = "💎 Major LL Retest Bounce Setup";
        if (signal.signalType === "TL_BREAKOUT") typeBadge = "📐 Trendline Breakout Setup";
        if (signal.signalType === "SUPPORT_RETEST") typeBadge = "🧱 Support Retest Setup";
        elSignalType.textContent = typeBadge;
        elSignalType.style.color = "#38bdf8";
        elSignalDesc.textContent = signal.reason || "Asymmetric R:R setup qualified";
      } else {
        const isBroken = Boolean(
          plan.reason?.includes("Support broken") ||
          plan.reason?.includes("New Low") ||
          plan.signalType === "WAITING_NEW_BASE" ||
          plan.signalType === "WAITING_BASE" ||
          entryPrice <= 0 ||
          data.regime === "WARMUP"
        );
        if (isBroken) {
          elSignalType.textContent = "🛑 Searching New Base (หลุดแนวรับ — รอสร้างฐานใหม่)";
          elSignalType.style.color = "#ef4444";
        } else if (plan.signalType === "WAITING_TL_RETEST" || plan.reason?.includes("Trendline Support")) {
          elSignalType.textContent = "⏳ Waiting Trendline Retest (รอราคาย่อทดสอบแนวรับ Trendline)";
          elSignalType.style.color = "#f59e0b";
        } else if (plan.signalType === "WAITING_HL_RETEST" || plan.reason?.includes("HL Support")) {
          elSignalType.textContent = "⏳ Waiting HL Retest (รอราคาย่อทดสอบฐาน HL เดิม)";
          elSignalType.style.color = "#f59e0b";
        } else {
          elSignalType.textContent = "⏳ Waiting LL Retest (รอราคาย่อทดสอบฐาน LL เดิม)";
          elSignalType.style.color = "#f59e0b";
        }
        elSignalDesc.textContent = plan.reason || signal?.reason || "Waiting for structure base confirmation";
      }
    }

    // Update TP2
    if (elTp2Price) {
      elTp2Price.textContent = tp2Price > 0 ? fmtPrice(tp2Price) : "--.------";
    }
    if (elTp2Gain) {
      const baseP = entryPrice > 0 ? entryPrice : refPrice;
      const gainPct = baseP > 0 && tp2Price > 0 ? ((tp2Price - baseP) / baseP) * 100 : 0;
      elTp2Gain.textContent = tp2Price > 0 ? `Target +${gainPct.toFixed(2)}%` : "Target --%";
    }

    // Update TP1
    if (elTp1Price) {
      elTp1Price.textContent = tp1Price > 0 ? fmtPrice(tp1Price) : "--.------";
    }
    if (elTp1Gain) {
      const baseP = entryPrice > 0 ? entryPrice : refPrice;
      const gainPct = baseP > 0 && tp1Price > 0 ? ((tp1Price - baseP) / baseP) * 100 : 0;
      elTp1Gain.textContent = tp1Price > 0 ? `Target +${gainPct.toFixed(2)}%` : "Target --%";
    }

    // Update Entry
    if (elEntryPrice) {
      elEntryPrice.textContent = entryPrice > 0 ? fmtPrice(entryPrice) : "--.------";
    }
    if (elEntryTitle && elEntryStatus) {
      if (pos) {
        elEntryTitle.textContent = plan.isTrappedPosition ? "⚠️ เข้าค้างเหนือ LL (Active Entry)" : "🚀 จุดเข้าซื้อจริง (Active Entry)";
        const currentGain = entryPrice > 0 ? ((refPrice - entryPrice) / entryPrice) * 100 : 0;
        const gainSign = currentGain >= 0 ? "+" : "";
        const nextLlNote = plan.nextPlannedEntryPrice && Math.abs(plan.nextPlannedEntryPrice - entryPrice) / entryPrice >= 0.004
          ? `Next LL: $${fmtPrice(plan.nextPlannedEntryPrice)} | `
          : "";
        elEntryStatus.textContent = `${nextLlNote}PnL: ${gainSign}${currentGain.toFixed(2)}%`;
        elEntryStatus.style.color = currentGain >= 0 ? "#10b981" : "#ef4444";
      } else if (signal && signal.hasSignal) {
        elEntryTitle.textContent = "🎯 จุดเข้าซื้อพร้อม (Ready Entry)";
        elEntryStatus.textContent = "Setup Ready";
        elEntryStatus.style.color = "#10b981";
      } else {
        if (entryPrice > 0) {
          const sigType = plan.signalType || "";
          if (sigType === "SUPPORT_RETEST" || sigType === "WAITING_TL_RETEST" || sigType.includes("TL")) {
            elEntryTitle.textContent = "🎯 จุดรอรับแนวรับ Trendline";
          } else if (sigType === "HL_BASE" || sigType === "WAITING_HL_RETEST") {
            elEntryTitle.textContent = "🎯 จุดรอรับฐาน HL (Target HL Entry)";
          } else {
            elEntryTitle.textContent = "🎯 จุดรอรับเหนือ LL (Target LL Entry)";
          }
          if (refPrice > entryPrice) {
            const dipNeeded = ((refPrice - entryPrice) / refPrice) * 100;
            elEntryStatus.textContent = `Wait Dip -${dipNeeded.toFixed(1)}%`;
            elEntryStatus.style.color = "#38bdf8";
          } else {
            elEntryStatus.textContent = "Waiting Retest";
            elEntryStatus.style.color = "#94a3b8";
          }
        } else {
          elEntryTitle.textContent = "🛑 โครงสร้างหลุดฐาน (Waiting Base)";
          elEntryStatus.textContent = "Searching New Base";
          elEntryStatus.style.color = "#ef4444";
        }
      }
    }

    // Update SL
    if (elSlPrice) {
      elSlPrice.textContent = slPrice > 0 ? fmtPrice(slPrice) : "--.------";
    }
    if (elSlRisk) {
      const baseP = entryPrice > 0 ? entryPrice : refPrice;
      const riskPct = baseP > 0 && slPrice > 0 ? ((baseP - slPrice) / baseP) * 100 : 0;
      if (pos && pos.trailingStopActive) {
        elSlRisk.textContent = `Trailing Stop Lock`;
        elSlRisk.style.color = "#10b981";
      } else if (pos && pos.tp1Executed) {
        elSlRisk.textContent = `Breakeven Lock (Risk-Free)`;
        elSlRisk.style.color = "#10b981";
      } else {
        elSlRisk.textContent = slPrice > 0 ? `Max Risk -${riskPct.toFixed(2)}%` : "Max Risk --%";
        elSlRisk.style.color = "#ef4444";
      }
    }

    // Update Footer Stats
    if (elRrRatio) {
      elRrRatio.textContent = rrRatio > 0 ? `${rrRatio.toFixed(2)}x R:R` : "-- R:R";
    }
    if (elStatusText) {
      if (data.swingState === "PENDING_ENTRY") {
        elStatusText.textContent = "PENDING_ENTRY";
        elStatusText.style.color = "#38bdf8";
      } else {
        elStatusText.textContent = data.swingState || "WAITING_SETUP";
        elStatusText.style.color = pos ? "#10b981" : "#f59e0b";
      }
    }
    if (elPosQty) {
      const qty = pos?.qty || (typeof data.baseHeld === "number" ? data.baseHeld : 0);
      elPosQty.textContent = `${qty.toFixed(4)} ${data.baseAsset || ""}`;
    }

    // Update Live Price Progress Track
    const elProgressFill = document.getElementById("stpProgressFill");
    const elProgressPin = document.getElementById("stpProgressPin");
    const elProgressStatus = document.getElementById("stpProgressStatus");
    if (elProgressPin && elProgressFill) {
      if (slPrice > 0 && tp2Price > slPrice && refPrice > 0) {
        const rawPct = ((refPrice - slPrice) / (tp2Price - slPrice)) * 100;
        const clampedPct = Math.max(0, Math.min(100, rawPct));
        elProgressPin.style.left = `${clampedPct.toFixed(1)}%`;
        elProgressFill.style.width = `${clampedPct.toFixed(1)}%`;
      } else {
        elProgressPin.style.left = "50%";
        elProgressFill.style.width = "50%";
      }
    }
    if (elProgressStatus) {
      if (pos) {
        if (refPrice >= tp1Price) {
          elProgressStatus.textContent = "🎯 Run to TP2";
          elProgressStatus.style.color = "#06b6d4";
        } else if (refPrice >= entryPrice) {
          elProgressStatus.textContent = "📈 In Profit Zone";
          elProgressStatus.style.color = "#10b981";
        } else {
          elProgressStatus.textContent = "⚠️ In Drawdown Zone";
          elProgressStatus.style.color = "#f59e0b";
        }
      } else if (signal && signal.hasSignal) {
        elProgressStatus.textContent = "⚡ Setup Ready";
        elProgressStatus.style.color = "#38bdf8";
      } else {
        elProgressStatus.textContent = "🔍 Waiting Signal";
        elProgressStatus.style.color = "#94a3b8";
      }
    }

    // Update Top Right Status Badge on the Card
    const elZoneBadge = document.getElementById("ladderZoneBadge");
    if (elZoneBadge) {
      if (pos) {
        if (pos.tp1Executed) {
          elZoneBadge.textContent = "🚀 TRAILING TP1";
          elZoneBadge.className = "active-zone-pill badge-trailing";
        } else {
          elZoneBadge.textContent = "📈 IN POSITION";
          elZoneBadge.className = "active-zone-pill badge-inpos";
        }
      } else if (signal && signal.hasSignal) {
        elZoneBadge.textContent = "⚡ SETUP READY";
        elZoneBadge.className = "active-zone-pill badge-ready";
      } else {
        elZoneBadge.textContent = "🔍 SCANNING";
        elZoneBadge.className = "active-zone-pill badge-scanning";
      }
    }
  }

  function updateMaFanPlanUI(data) {
    const elSignalType = document.getElementById("mfSignalType");
    const elSignalDesc = document.getElementById("mfSignalDesc");
    const elReqSpread = document.getElementById("mfReqSpread");
    const elCurrentSpread = document.getElementById("mfCurrentSpread");
    const elHtfRegime = document.getElementById("mfHtfRegime");
    const elPositionStatus = document.getElementById("mfPositionStatus");
    const elTp2Price = document.getElementById("mfTp2Price");
    const elTp2TargetDesc = document.getElementById("mfTp2TargetDesc");
    const elTp1Price = document.getElementById("mfTp1Price");
    const elTp1Desc = document.getElementById("mfTp1Desc");
    const elEntryPrice = document.getElementById("mfEntryPrice");
    const elEntryQty = document.getElementById("mfEntryQty");
    const elSlPrice = document.getElementById("mfSlPrice");
    const elSlTitle = document.getElementById("mfSlTitle");
    const elSlStatus = document.getElementById("mfSlStatus");
    const elSlBadge = document.getElementById("mfSlBadge");
    const elWinRate = document.getElementById("mfWinRate");
    const elCycles = document.getElementById("mfCycles");
    const elRealizedPnl = document.getElementById("mfRealizedPnl");

    const ribbon = data.ribbon || {};
    const pos = data.activePosition;
    const htf = data.htfRegime;
    const effSpread = data.effectiveSpreadThreshold || 0.40;
    const metrics = data.metrics || {};

    if (elReqSpread) elReqSpread.textContent = effSpread.toFixed(2);
    if (elCurrentSpread) {
      const curSpread = ribbon.fanSpreadPct || 0;
      elCurrentSpread.textContent = `${curSpread.toFixed(2)}%`;
      elCurrentSpread.style.color = curSpread >= effSpread ? "#4ade80" : "#38bdf8";
    }

    if (elHtfRegime) {
      if (htf) {
        elHtfRegime.textContent = htf.isBullish ? "🟢 ขาขึ้น (Bullish)" : "🔴 ขาลง (Bearish)";
        elHtfRegime.style.color = htf.isBullish ? "#4ade80" : "#f87171";
      } else {
        elHtfRegime.textContent = "--";
      }
    }

    // Targets
    const curPrice = data.mid || data.refPrice || 0;
    const tp1Price = pos?.tp1Price || ribbon.ema25 || 0;
    const tp2Price = Math.max(ribbon.ema75 || 0, ribbon.ema200 || 0);

    if (elTp1Price) elTp1Price.textContent = tp1Price > 0 ? fmtPrice(tp1Price) : "--.------";
    if (elTp2Price) elTp2Price.textContent = tp2Price > 0 ? fmtPrice(tp2Price) : "--.------";

    if (pos) {
      // In position
      if (elPositionStatus) {
        elPositionStatus.textContent = pos.tp1Filled ? "🎯 แตะ TP1 (ถือไม้รัน)" : "🟢 ถือไม้ (รอแตะ TP1)";
        elPositionStatus.style.color = "#4ade80";
      }

      if (elSignalType) elSignalType.textContent = pos.tp1Filled ? "🚀 กำลังรันเทรนด์ไม้ TP2 (Breakeven Locked)" : "🎯 ถือออเดอร์ (รอเด้งแตะ EMA 25)";
      if (elSignalDesc) {
        const pnlPct = pos.entryPrice > 0 ? (((curPrice - pos.entryPrice) / pos.entryPrice) * 100).toFixed(2) : "0.00";
        elSignalDesc.textContent = `เข้าซื้อที่ $${fmtPrice(pos.entryPrice)} | PnL: ${pnlPct >= "0" ? "+" : ""}${pnlPct}%`;
      }

      if (elEntryPrice) elEntryPrice.textContent = fmtPrice(pos.entryPrice);
      if (elEntryQty) elEntryQty.textContent = `ถือ ${pos.remainingQty} (${((pos.remainingQty / pos.totalQty) * 100).toFixed(0)}%)`;

      if (elSlPrice) elSlPrice.textContent = fmtPrice(pos.stopLossPrice);
      if (elSlTitle) elSlTitle.textContent = pos.isBreakevenLocked ? "🛡️ Stop Loss (ล็อกทุน Breakeven)" : "🛡️ Stop Loss (ใต้ Swing Low)";
      if (elSlStatus) elSlStatus.textContent = pos.isBreakevenLocked ? "Risk-Free Mode (ปลอดภัย 100%)" : `ระยะ SL: ${curPrice > 0 ? (((pos.stopLossPrice - curPrice) / curPrice) * 100).toFixed(2) : 0}%`;
      if (elSlBadge) elSlBadge.style.background = pos.isBreakevenLocked ? "#3b82f6" : "#ef4444";
    } else {
      // No position, waiting for entry
      if (elPositionStatus) {
        elPositionStatus.textContent = ribbon.isFanningDown && ribbon.fanSpreadPct >= effSpread ? "⚡ พัดกางตึง! รอม้วนกลับ" : "รอพัดกางตึง";
        elPositionStatus.style.color = ribbon.isFanningDown && ribbon.fanSpreadPct >= effSpread ? "#facc15" : "var(--text-muted)";
      }

      if (elSignalType) elSignalType.textContent = "🪭 MA Fan Sniper (กำลังสแกนจังหวะ)";
      if (elSignalDesc) elSignalDesc.textContent = `พัดปัจจุบัน: ${(ribbon.fanSpreadPct || 0).toFixed(2)}% (ต้องการ ≥ ${effSpread.toFixed(2)}%)`;

      if (elEntryPrice) elEntryPrice.textContent = "--.------";
      if (elEntryQty) elEntryQty.textContent = "รอจังหวะเข้า";
      if (elSlPrice) elSlPrice.textContent = "--.------";
      if (elSlTitle) elSlTitle.textContent = "🛡️ Stop Loss (ใต้ Swing Low)";
      if (elSlStatus) elSlStatus.textContent = "--";
      if (elSlBadge) elSlBadge.style.background = "#ef4444";
    }

    if (elWinRate) elWinRate.textContent = `${(metrics.winRate || 0).toFixed(1)}%`;
    if (elCycles) elCycles.textContent = String(metrics.totalCycles || 0);
    if (elRealizedPnl) {
      const pnl = metrics.realizedPnl || 0;
      elRealizedPnl.textContent = `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`;
      elRealizedPnl.style.color = pnl >= 0 ? "#4ade80" : "#f87171";
    }

    const elZoneBadge = document.getElementById("ladderZoneBadge");
    if (elZoneBadge) {
      if (pos) {
        if (pos.tp1Filled) {
          elZoneBadge.textContent = "🚀 TRAILING TP2";
          elZoneBadge.className = "active-zone-pill badge-trailing";
        } else {
          elZoneBadge.textContent = "🎯 TP1 PENDING";
          elZoneBadge.className = "active-zone-pill badge-inpos";
        }
      } else if (ribbon.isFanningDown && ribbon.fanSpreadPct >= effSpread) {
        elZoneBadge.textContent = "⚡ HOOK READY";
        elZoneBadge.className = "active-zone-pill badge-ready";
      } else {
        elZoneBadge.textContent = "🪭 FAN SCANNING";
        elZoneBadge.className = "active-zone-pill badge-scanning";
      }
    }
  }

  function updateZoneLevelBars(data) {
    latestGridData = data;

    const elGridTitle = document.getElementById("gridLadderTitle");
    const elVerticalLadder = document.getElementById("verticalLadderMeter");
    const elSwingPlanCard = document.getElementById("swingTradePlanCard");
    const elMaFanPlanCard = document.getElementById("maFanPlanCard");

    if (data.strategyType === "swing_trade") {
      if (elGridTitle) elGridTitle.textContent = "🏹 แผนและการวิ่งของราคา (Swing Targets)";
      if (elVerticalLadder) elVerticalLadder.style.display = "none";
      if (elSwingPlanCard) elSwingPlanCard.style.display = "flex";
      if (elMaFanPlanCard) elMaFanPlanCard.style.display = "none";
      updateSwingTradePlanUI(data);
      return;
    } else if (data.strategyType === "ma_fan" || data.strategyMode === "ma_fan") {
      if (elGridTitle) elGridTitle.textContent = "🪭 แผนการเทรด MA Fan Sniper";
      if (elVerticalLadder) elVerticalLadder.style.display = "none";
      if (elSwingPlanCard) elSwingPlanCard.style.display = "none";
      if (elMaFanPlanCard) elMaFanPlanCard.style.display = "flex";
      updateMaFanPlanUI(data);
      if (cachedPrimaryCandles && cachedPrimaryCandles.length > 0) {
        updateMaFanRibbonLines(cachedPrimaryCandles);
      }
      return;
    } else {
      if (elGridTitle) elGridTitle.textContent = "🎯 ระดับกริด & เป้าหมาย (Grid Ladder)";
      if (elVerticalLadder) elVerticalLadder.style.display = "";
      if (elSwingPlanCard) elSwingPlanCard.style.display = "none";
      if (elMaFanPlanCard) elMaFanPlanCard.style.display = "none";
      if (ema4Series) {
        updateMaFanRibbonLines([]);
      }
    }
    const pos = data.positionPct !== undefined ? data.positionPct : 50;
    const floor = data.bottomBound ?? 0;
    const ceil = data.upperBound ?? 0;
    const span = Math.max(0.000001, ceil - floor);
    const center = data.centerPrice ?? (floor + ceil) / 2;

    const buyPcts = Array.isArray(data.buyLevelPcts) && data.buyLevelPcts.length >= 5
      ? data.buyLevelPcts
      : [42, 32, 22, 12, 2];
    const sellPcts = Array.isArray(data.sellLevelPcts) && data.sellLevelPcts.length >= 5
      ? data.sellLevelPcts
      : [52, 62, 72, 82, 92];

    const bLevels = Array.isArray(data.buyLevels) && data.buyLevels.length >= 5 ? data.buyLevels : null;
    const sLevels = Array.isArray(data.sellLevels) && data.sellLevels.length >= 5 ? data.sellLevels : null;

    const effBuyPcts = buyPcts.map((pct, i) => (bLevels && span > 0 ? Math.round(((bLevels[i] - floor) / span) * 100) : pct));
    const effSellPcts = sellPcts.map((pct, i) => (sLevels && span > 0 ? Math.round(((sLevels[i] - floor) / span) * 100) : pct));
    const centerPct = span > 0 ? Math.round(((center - floor) / span) * 100) : 50;

    // Update step percentages on DOM if present
    const elPctBuy1 = document.getElementById("stepPctBuy1");
    if (elPctBuy1) elPctBuy1.textContent = `${effBuyPcts[0]}%`;
    const elPctBuy2 = document.getElementById("stepPctBuy2");
    if (elPctBuy2) elPctBuy2.textContent = `${effBuyPcts[1]}%`;
    const elPctBuy3 = document.getElementById("stepPctBuy3");
    if (elPctBuy3) elPctBuy3.textContent = `${effBuyPcts[2]}%`;
    const elPctBuy4 = document.getElementById("stepPctBuy4");
    if (elPctBuy4) elPctBuy4.textContent = `${effBuyPcts[3]}%`;
    const elPctBuy5 = document.getElementById("stepPctBuy5");
    if (elPctBuy5) elPctBuy5.textContent = `${effBuyPcts[4]}%`;

    const elPctSell1 = document.getElementById("stepPctSell1");
    if (elPctSell1) elPctSell1.textContent = `${effSellPcts[0]}%`;
    const elPctSell2 = document.getElementById("stepPctSell2");
    if (elPctSell2) elPctSell2.textContent = `${effSellPcts[1]}%`;
    const elPctSell3 = document.getElementById("stepPctSell3");
    if (elPctSell3) elPctSell3.textContent = `${effSellPcts[2]}%`;
    const elPctSell4 = document.getElementById("stepPctSell4");
    if (elPctSell4) elPctSell4.textContent = `${effSellPcts[3]}%`;
    const elPctSell5 = document.getElementById("stepPctSell5");
    if (elPctSell5) elPctSell5.textContent = `${effSellPcts[4]}%`;

    // 1. Update prices on each vertical step (from top 100% to bottom 0%)
    if (elStepPriceCeil) elStepPriceCeil.textContent = fmtPrice(ceil);
    if (elStepPriceSell5) elStepPriceSell5.textContent = fmtPrice(sLevels ? sLevels[4] : (floor + span * (sellPcts[4] / 100)));
    if (elStepPriceSell4) elStepPriceSell4.textContent = fmtPrice(sLevels ? sLevels[3] : (floor + span * (sellPcts[3] / 100)));
    if (elStepPriceSell3) elStepPriceSell3.textContent = fmtPrice(sLevels ? sLevels[2] : (floor + span * (sellPcts[2] / 100)));
    if (elStepPriceSell2) elStepPriceSell2.textContent = fmtPrice(sLevels ? sLevels[1] : (floor + span * (sellPcts[1] / 100)));
    if (elStepPriceSell1) elStepPriceSell1.textContent = fmtPrice(sLevels ? sLevels[0] : (floor + span * (sellPcts[0] / 100)));
    if (elStepPriceCenter) elStepPriceCenter.textContent = fmtPrice(center);
    if (elStepPriceBuy1) elStepPriceBuy1.textContent = fmtPrice(bLevels ? bLevels[0] : (floor + span * (buyPcts[0] / 100)));
    if (elStepPriceBuy2) elStepPriceBuy2.textContent = fmtPrice(bLevels ? bLevels[1] : (floor + span * (buyPcts[1] / 100)));
    if (elStepPriceBuy3) elStepPriceBuy3.textContent = fmtPrice(bLevels ? bLevels[2] : (floor + span * (buyPcts[2] / 100)));
    if (elStepPriceBuy4) elStepPriceBuy4.textContent = fmtPrice(bLevels ? bLevels[3] : (floor + span * (buyPcts[3] / 100)));
    if (elStepPriceBuy5) elStepPriceBuy5.textContent = fmtPrice(bLevels ? bLevels[4] : (floor + span * (buyPcts[4] / 100)));
    if (elStepPriceFloor) {
      elStepPriceFloor.textContent = fmtPrice(floor);
      elStepPriceFloor.title = `0% Grid Base (Structural Valley: $${fmtPrice(floor)})`;
    }

    // 2. Define ladder steps with dynamic Pyramid / Equal percentage targets
    const enabledBuys = Array.isArray(data.enabledBuyLevels) ? data.enabledBuyLevels : [true, true, true, true, true];
    const enabledSells = Array.isArray(data.enabledSellTargets) ? data.enabledSellTargets : [true, true, true, true, true];
    const maxInv = data.maxInventoryQuote ?? data.maxInventoryUsdso ?? 40;

    const rawBuyWeights = (data.buySizingMode === "EQUAL") ? [1, 1, 1, 1, 1] : [10, 15, 20, 25, 30];
    const activeBuyWeightSum = rawBuyWeights.reduce((s, w, i) => (enabledBuys[i] !== false ? s + w : s), 0);
    const buyFractions = (Array.isArray(data.buyWeightFractions) && data.buyWeightFractions.length >= 5)
      ? data.buyWeightFractions
      : rawBuyWeights.map((w, i) => (enabledBuys[i] !== false && activeBuyWeightSum > 0 ? w / activeBuyWeightSum : 0));

    let cumBuyFrac = 0;
    const buyCumPcts = [0, 0, 0, 0, 0];
    const buyStepLabels = buyFractions.map((frac, i) => {
      if (enabledBuys[i] === false) return "Disabled (OFF)";
      cumBuyFrac += frac;
      const cumPct = Math.round(cumBuyFrac * 100);
      buyCumPcts[i] = cumPct;
      const trancheDollar = (maxInv * frac).toFixed(0);
      return `Hold ${cumPct}% (+$${trancheDollar})`;
    });

    const activeSellIndices = [0, 1, 2, 3, 4].filter((i) => enabledSells[i] !== false);
    const totalActiveSells = activeSellIndices.length;
    const sellHoldPcts = [80, 60, 40, 20, 0];
    const sellStepLabels = [0, 1, 2, 3, 4].map((i) => {
      if (enabledSells[i] === false) return "Disabled (OFF)";
      const orderInActive = activeSellIndices.indexOf(i) + 1;
      const remPct = totalActiveSells > 0 ? Math.max(0, Math.round((1 - orderInActive / totalActiveSells) * 100)) : 0;
      sellHoldPcts[i] = remPct;
      return remPct === 0 ? "Flat 0%" : `Hold ${remPct}%`;
    });

    const ladderSteps = [
      { pct: 100, el: elStepCeil, priceEl: elStepPriceCeil, defaultTitle: "Ceiling (Take Profit)", defaultAction: "Flat 0%", price: ceil, enabled: true, isCeil: true, isSell: true, levelIndex: 5 },
      { pct: effSellPcts[4], el: elStepSell5, priceEl: elStepPriceSell5, defaultTitle: "Sell Target 5", defaultAction: sellStepLabels[4], price: sLevels ? sLevels[4] : (floor + span * (sellPcts[4] / 100)), enabled: enabledSells[4] !== false, isSell: true, levelIndex: 4 },
      { pct: effSellPcts[3], el: elStepSell4, priceEl: elStepPriceSell4, defaultTitle: "Sell Target 4", defaultAction: sellStepLabels[3], price: sLevels ? sLevels[3] : (floor + span * (sellPcts[3] / 100)), enabled: enabledSells[3] !== false, isSell: true, levelIndex: 3 },
      { pct: effSellPcts[2], el: elStepSell3, priceEl: elStepPriceSell3, defaultTitle: "Sell Target 3", defaultAction: sellStepLabels[2], price: sLevels ? sLevels[2] : (floor + span * (sellPcts[2] / 100)), enabled: enabledSells[2] !== false, isSell: true, levelIndex: 2 },
      { pct: effSellPcts[1], el: elStepSell2, priceEl: elStepPriceSell2, defaultTitle: "Sell Target 2", defaultAction: sellStepLabels[1], price: sLevels ? sLevels[1] : (floor + span * (sellPcts[1] / 100)), enabled: enabledSells[1] !== false, isSell: true, levelIndex: 1 },
      { pct: effSellPcts[0], el: elStepSell1, priceEl: elStepPriceSell1, defaultTitle: "Sell Target 1", defaultAction: sellStepLabels[0], price: sLevels ? sLevels[0] : (floor + span * (sellPcts[0] / 100)), enabled: enabledSells[0] !== false, isSell: true, levelIndex: 0 },
      { pct: centerPct, el: elStepCenter, priceEl: elStepPriceCenter, defaultTitle: `${centerPct}% Center`, defaultAction: "Midline", price: center, enabled: true, isCenter: true },
      { pct: effBuyPcts[0], el: elStepBuy1, priceEl: elStepPriceBuy1, defaultTitle: "Buy Level 1", defaultAction: buyStepLabels[0], price: bLevels ? bLevels[0] : (floor + span * (buyPcts[0] / 100)), enabled: enabledBuys[0] !== false, isBuy: true, levelIndex: 0 },
      { pct: effBuyPcts[1], el: elStepBuy2, priceEl: elStepPriceBuy2, defaultTitle: "Buy Level 2", defaultAction: buyStepLabels[1], price: bLevels ? bLevels[1] : (floor + span * (buyPcts[1] / 100)), enabled: enabledBuys[1] !== false, isBuy: true, levelIndex: 1 },
      { pct: effBuyPcts[2], el: elStepBuy3, priceEl: elStepPriceBuy3, defaultTitle: "Buy Level 3", defaultAction: buyStepLabels[2], price: bLevels ? bLevels[2] : (floor + span * (buyPcts[2] / 100)), enabled: enabledBuys[2] !== false, isBuy: true, levelIndex: 2 },
      { pct: effBuyPcts[3], el: elStepBuy4, priceEl: elStepPriceBuy4, defaultTitle: "Buy Level 4", defaultAction: buyStepLabels[3], price: bLevels ? bLevels[3] : (floor + span * (buyPcts[3] / 100)), enabled: enabledBuys[3] !== false, isBuy: true, levelIndex: 3 },
      { pct: effBuyPcts[4], el: elStepBuy5, priceEl: elStepPriceBuy5, defaultTitle: "Buy Level 5", defaultAction: buyStepLabels[4], price: bLevels ? bLevels[4] : (floor + span * (buyPcts[4] / 100)), enabled: enabledBuys[4] !== false, isBuy: true, levelIndex: 4 },
      { pct: 0, el: elStepFloor, priceEl: elStepPriceFloor, defaultTitle: "0% Floor (Low)", defaultAction: "Cut Loss", price: floor, enabled: true, isFloor: true },
    ];

    // Reset all ladder steps to default clean state
    ladderSteps.forEach((step) => {
      if (!step.el) return;
      step.el.classList.remove("has-resting-buy", "has-resting-sell", "active-ladder-step");
      const titleEl = step.el.querySelector(".step-title");
      if (titleEl && step.defaultTitle) {
        titleEl.textContent = step.defaultTitle;
        titleEl.title = "";
      }
      const actionEl = step.el.querySelector(".step-action");
      if (step.enabled === false) {
        step.el.classList.add("step-disabled");
        step.el.style.display = "none";
        if (actionEl) actionEl.textContent = "Disabled (OFF)";
      } else {
        step.el.classList.remove("step-disabled");
        step.el.style.display = "";
        if (actionEl) {
          if (step.pct === 0) {
            actionEl.textContent = "0% Floor";
          } else {
            actionEl.textContent = step.defaultAction;
          }
        }
      }
      if (step.priceEl) step.priceEl.textContent = fmtPrice(step.price);
    });

    // 3. Match each resting order strictly to its corresponding grid zone
    const openOrders = data.openOrders || [];
    const usedSteps = new Set();

    // Sort orders: prioritize orders with known target names first
    const sortedOrders = [...openOrders].sort((a, b) => {
      const aHas = Boolean(a.levelDesc && (a.levelDesc.includes("Sell Target") || a.levelDesc.includes("Buy Level")));
      const bHas = Boolean(b.levelDesc && (b.levelDesc.includes("Sell Target") || b.levelDesc.includes("Buy Level")));
      return (bHas ? 1 : 0) - (aHas ? 1 : 0);
    });

    sortedOrders.forEach((order) => {
      if (!order || !order.price) return;

      let matchedStep = null;
      const desc = (order.levelDesc || "").toLowerCase();
      const isBid = order.isBid;

      // Available candidate steps on the corresponding side (only enabled steps)
      const candidateSteps = ladderSteps.filter((s) => {
        if (!s.enabled) return false;
        if (usedSteps.has(s)) return false;
        if (isBid) return Boolean(s.isBuy);
        return Boolean(s.isSell && !s.isCeil);
      });

      // 1. Try matching by levelDesc
      const isRealCeilOrder = desc.includes("real ceil");
      const isTlExitOrder = desc.includes("tl exit") || desc.includes("trendline") || isRealCeilOrder;
      if (desc.includes("buy level 1") || desc.includes(`${buyPcts[0]}%`)) matchedStep = candidateSteps.find((s) => s.isBuy && s.levelIndex === 0) || candidateSteps.find((s) => s.pct === buyPcts[0]);
      else if (desc.includes("buy level 2") || desc.includes(`${buyPcts[1]}%`)) matchedStep = candidateSteps.find((s) => s.isBuy && s.levelIndex === 1) || candidateSteps.find((s) => s.pct === buyPcts[1]);
      else if (desc.includes("buy level 3") || desc.includes(`${buyPcts[2]}%`)) matchedStep = candidateSteps.find((s) => s.isBuy && s.levelIndex === 2) || candidateSteps.find((s) => s.pct === buyPcts[2]);
      else if (desc.includes("buy level 4") || desc.includes(`${buyPcts[3]}%`)) matchedStep = candidateSteps.find((s) => s.isBuy && s.levelIndex === 3) || candidateSteps.find((s) => s.pct === buyPcts[3]);
      else if (desc.includes("buy level 5") || desc.includes(`${buyPcts[4]}%`)) matchedStep = candidateSteps.find((s) => s.isBuy && s.levelIndex === 4) || candidateSteps.find((s) => s.pct === buyPcts[4]);
      else if (desc.includes("sell target 1") || desc.includes(`${sellPcts[0]}%`)) matchedStep = candidateSteps.find((s) => s.isSell && s.levelIndex === 0) || candidateSteps.find((s) => s.pct === sellPcts[0]);
      else if (desc.includes("sell target 2") || desc.includes(`${sellPcts[1]}%`)) matchedStep = candidateSteps.find((s) => s.isSell && s.levelIndex === 1) || candidateSteps.find((s) => s.pct === sellPcts[1]);
      else if (desc.includes("sell target 3") || desc.includes(`${sellPcts[2]}%`)) matchedStep = candidateSteps.find((s) => s.isSell && s.levelIndex === 2) || candidateSteps.find((s) => s.pct === sellPcts[2]);
      else if (desc.includes("sell target 4") || desc.includes(`${sellPcts[3]}%`)) matchedStep = candidateSteps.find((s) => s.isSell && s.levelIndex === 3) || candidateSteps.find((s) => s.pct === sellPcts[3]);
      else if (desc.includes("sell target 5") || desc.includes(`${sellPcts[4]}%`)) matchedStep = candidateSteps.find((s) => s.isSell && s.levelIndex === 4) || candidateSteps.find((s) => s.pct === sellPcts[4]);
      else if (isTlExitOrder) {
        // Find candidate sell step closest to the resistance/trendline exit order price
        let bestTlStep = null;
        let minTlDiff = Infinity;
        candidateSteps.forEach((step) => {
          const diff = Math.abs(step.price - order.price);
          if (diff < minTlDiff) {
            minTlDiff = diff;
            bestTlStep = step;
          }
        });
        matchedStep = bestTlStep || candidateSteps[0] || null;
      }

      // 2. Find closest step by price among unused candidate steps
      let closestStep = null;
      let minDiff = Infinity;
      candidateSteps.forEach((step) => {
        const diff = Math.abs(step.price - order.price);
        if (diff < minDiff) {
          minDiff = diff;
          closestStep = step;
        }
      });

      // Price verification: if price is much closer to another step than matchedStep (or no matchedStep), use closestStep
      if (closestStep) {
        if (!matchedStep) {
          if (minDiff < span * 0.08 || isTlExitOrder) matchedStep = closestStep;
        } else if (!isTlExitOrder) {
          const matchedDiff = Math.abs(matchedStep.price - order.price);
          if (minDiff < matchedDiff * 0.4) {
            matchedStep = closestStep;
          }
        }
      }

      // If zone has an active resting order, update price & badge
      if (matchedStep && matchedStep.el) {
        usedSteps.add(matchedStep);
        matchedStep.el.classList.add(isBid ? "has-resting-buy" : "has-resting-sell");

        // Format TL Exit reference and front-run buffer
        const titleEl = matchedStep.el.querySelector(".step-title");
        const tlObj = data.downtrendLine && !data.downtrendLine.isBroken ? data.downtrendLine : null;
        const liveTlPrice = tlObj?.currentLinePrice ?? data.sellTrigger;
        const liveRcPrice = data.liveCalculatedUpperBound || data.upperBound;
        const refResPrice = isRealCeilOrder ? liveRcPrice : liveTlPrice;
        const frontRunPct = (refResPrice && refResPrice > 0 && refResPrice > order.price)
          ? ((refResPrice - order.price) / refResPrice) * 100
          : 0;
        const frontRunStr = frontRunPct > 0 ? ` (-${frontRunPct.toFixed(2)}%)` : "";

        if (isTlExitOrder && titleEl) {
          titleEl.textContent = isRealCeilOrder ? "🎯 Ceil Exit" : "📉 TL Exit";
          titleEl.title = isRealCeilOrder
            ? `Real Ceiling Exit Limit Order (Ref Ceil: $${fmtPrice(refResPrice)})`
            : `Trendline Exit Limit Order (Ref TL: $${fmtPrice(refResPrice)}${frontRunStr})`;
        }

        if (matchedStep.priceEl) {
          if (isTlExitOrder && refResPrice && Math.abs(refResPrice - order.price) > 0.005) {
            matchedStep.priceEl.innerHTML = `${fmtPrice(order.price)} <span style="font-size:7.5px; opacity:0.8; color:#f59e0b; display:block; font-weight:normal;" title="Ref ${isRealCeilOrder ? "Ceil" : "TL"}: $${fmtPrice(refResPrice)}${frontRunStr}">(TL ${fmtPrice(refResPrice)})</span>`;
          } else {
            matchedStep.priceEl.textContent = fmtPrice(order.price);
          }
        }

        const actionEl = matchedStep.el.querySelector(".step-action");
        if (actionEl) {
          const notionalVal = order.notionalUsdso || (order.price * (order.qty || 0));
          const notional = notionalVal > 0 ? `$${notionalVal.toFixed(2)}` : "";
          const sideTag = isRealCeilOrder ? "🎯 SELL CEIL" : (isTlExitOrder ? `📉 SELL TL${frontRunStr}` : (isBid ? "BUY" : "SELL"));
          const tagClass = isBid ? "buy-order-tag" : "sell-order-tag";
          let expPill = "";
          if (order.expireTime) {
            const remH = Math.max(0, Math.round((order.expireTime - Date.now()) / 3600000));
            expPill = remH > 0 ? `<span style="opacity:0.8; font-size:7.5px; margin-left:3px; font-weight:600;">⏳${remH}h</span>` : "";
          }
          const orderTitle = isRealCeilOrder
            ? `Real Ceiling Exit Limit Order @ $${fmtPrice(order.price)} (Ref Ceil: $${fmtPrice(refResPrice)})`
            : (isTlExitOrder ? `Trendline Exit Limit Order @ $${fmtPrice(order.price)} (Front-run ${frontRunPct.toFixed(2)}% below TL $${fmtPrice(refResPrice)} for early Maker fill)` : `Limit Order @ $${fmtPrice(order.price)}`);
          actionEl.innerHTML = `<span class="step-order-tag ${tagClass}" title="${orderTitle}"><span class="order-pulse-dot"></span> ${sideTag} ${notional}${expPill}</span>`;
        }
      }
    });

    // Determine execution mode for visual rendering
    const isIocExecution = (data.orderExecutionMode === "IOC_BRACKET") || (!openOrders.length && data.exchange === "dreamdex");

    // In MAKER_LIMIT mode: Mark targets above resistance as suppressed (🚫 TL CAP)
    if (!isIocExecution) {
      const hasPosition = (data.baseHeld > 0) || (data.lots && data.lots.length > 0) || ((data.positionQuote || data.positionUsdso) > 0.05);
      const tl = data.downtrendLine && !data.downtrendLine.isBroken ? data.downtrendLine : null;
      const tlPrice = tl?.currentLinePrice;
      const isTlActive = Boolean(tlPrice && (data.enableSellBelowTrendResistance !== false));
      const rcPrice = data.liveCalculatedUpperBound || data.upperBound;
      const isRcActive = Boolean(rcPrice && (data.enableSellAtRealCeiling !== false) && rcPrice < ceil);
      const effectiveRes = Math.min(isTlActive && tlPrice ? tlPrice : Infinity, isRcActive && rcPrice ? rcPrice : Infinity);

      if (hasPosition && Number.isFinite(effectiveRes)) {
        [0, 1, 2, 3, 4].forEach((idx) => {
          const step = ladderSteps.find((s) => s.isSell && s.levelIndex === idx) || ladderSteps.find((s) => s.pct === effSellPcts[idx]);
          if (!step || !step.el || !step.enabled || usedSteps.has(step)) return;
          const lvlPrice = (sLevels && sLevels[idx] !== undefined) ? sLevels[idx] : step.price;
          if (lvlPrice >= effectiveRes) {
            const actionEl = step.el.querySelector(".step-action");
            if (actionEl) {
              const resLabel = (effectiveRes === tlPrice) ? `TL $${fmtPrice(tlPrice)}` : `Ceil $${fmtPrice(rcPrice)}`;
              actionEl.innerHTML = `<span class="step-order-tag" style="background:rgba(239,68,68,0.12); border:1px dashed rgba(239,68,68,0.4); color:#fca5a5; font-size:8.5px;" title="Target suppressed by ${resLabel} (Consolidated to TL Exit)"><span style="color:#f87171; font-weight:600;">🚫 TL CAP</span></span>`;
            }
          }
        });
      }
    }

    // 3b. In IOC mode (zero resting limit orders on book), render virtual IOC triggers, sold status, and TL Capping directly on the ladder
    if (isIocExecution) {
      const soldSet = new Set(Array.isArray(data.soldSellIndices) ? data.soldSellIndices : []);
      const tl = data.downtrendLine && !data.downtrendLine.isBroken ? data.downtrendLine : null;
      const tlPrice = tl?.currentLinePrice;
      const isTlActive = Boolean(tlPrice && (data.enableSellBelowTrendResistance !== false));
      const hasPosition = (data.baseHeld > 0) || (data.lots && data.lots.length > 0) || ((data.positionQuote || data.positionUsdso) > 0.05);
      const heldBase = data.baseHeld || 0;
      const heldQuote = (data.inventoryQuote ?? data.inventoryUsdso) || (heldBase * (data.refPrice || 0));

      // ── SELL TARGETS (0 to 4) ──────────────────────────────────────────────
      // Find valid sell targets that are enabled and not capped by Trendline
      const validSellIndices = [0, 1, 2, 3, 4].filter((i) => {
        if (enabledSells[i] === false) return false;
        const p = (sLevels && sLevels[i] !== undefined) ? sLevels[i] : (floor + span * (sellPcts[i] / 100));
        return !isTlActive || tlPrice === undefined || p < tlPrice;
      });
      const unsoldValidIndices = validSellIndices.filter((i) => !soldSet.has(i));
      const numUnsold = unsoldValidIndices.length;

      [0, 1, 2, 3, 4].forEach((idx) => {
        const step = ladderSteps.find((s) => s.isSell && s.levelIndex === idx) || ladderSteps.find((s) => s.pct === effSellPcts[idx]);
        if (!step || !step.el || !step.enabled) return;
        const actionEl = step.el.querySelector(".step-action");
        if (!actionEl) return;

        const lvlPrice = (sLevels && sLevels[idx] !== undefined) ? sLevels[idx] : step.price;
        const isCappedByTl = hasPosition && isTlActive && tlPrice !== undefined && lvlPrice >= tlPrice;
        const isSold = soldSet.has(idx);
        const isCurrentSellTrigger = Boolean(data.sellTrigger && Math.abs(lvlPrice - data.sellTrigger) < (span * 0.02));
        const isFinalTargetBelowTl = (unsoldValidIndices.length > 0 && idx === unsoldValidIndices[unsoldValidIndices.length - 1]);

        // Calculate estimated tranche sell value
        let estSellQuote = 0;
        let estSellQty = 0;
        let isFullExit = false;

        if (hasPosition && numUnsold > 0) {
          if (isFinalTargetBelowTl || numUnsold === 1) {
            isFullExit = true;
            estSellQuote = heldQuote;
            estSellQty = heldBase;
          } else {
            const frac = 1 / numUnsold;
            estSellQuote = heldQuote * frac;
            estSellQty = heldBase * frac;
          }
        }

        const sellValStr = estSellQuote > 0 ? `$${estSellQuote.toFixed(estSellQuote >= 10 ? 1 : 2)}` : "";
        const exitBadge = isFullExit ? " [Exit]" : "";

        if (isSold) {
          actionEl.innerHTML = `<span class="step-order-tag sell-order-tag" style="background:rgba(34,197,94,0.15); border-color:rgba(34,197,94,0.4); color:#4ade80;" title="Sell Target ${idx + 1} ($${fmtPrice(lvlPrice)}) sold in this cycle"><span style="color:#4ade80; font-weight:700;">✓ SOLD</span></span>`;
          step.el.classList.add("has-resting-sell");
        } else if (isCappedByTl) {
          actionEl.innerHTML = `<span class="step-order-tag" style="background:rgba(239,68,68,0.12); border:1px dashed rgba(239,68,68,0.4); color:#fca5a5; font-size:9.5px;" title="Capped by Trendline ($${fmtPrice(tlPrice)})"><span style="color:#f87171; font-weight:600;">🚫 TL CAP</span></span>`;
        } else if (isCurrentSellTrigger && hasPosition) {
          const title = `Active IOC Sell Trigger @ $${fmtPrice(lvlPrice)}: Sell ~${sellValStr} (~${fmtQty(estSellQty)} ${activeBaseAsset})${isFullExit ? " (100% Full Exit)" : ""}`;
          actionEl.innerHTML = `<span class="step-order-tag sell-order-tag" title="${title}"><span class="order-pulse-dot"></span> IOC SELL ${sellValStr}${exitBadge}</span>`;
          step.el.classList.add("has-resting-sell");
        } else if (hasPosition && estSellQuote > 0) {
          const title = `IOC Sell Target ${idx + 1} @ $${fmtPrice(lvlPrice)}: Sell ~${sellValStr} (~${fmtQty(estSellQty)} ${activeBaseAsset})${isFullExit ? " (100% Full Exit)" : ""}`;
          actionEl.innerHTML = `<span class="step-order-tag sell-order-tag" style="opacity:0.85;" title="${title}">IOC SELL ${sellValStr}${exitBadge}</span>`;
        }
      });

      // Trendline Exit Trigger if active
      if (data.isTlSellTrigger && tlPrice && hasPosition) {
        let closestTlStep = null;
        let minTlDiff = Infinity;
        ladderSteps.filter((s) => s.pct >= 51 && s.pct < 100 && s.enabled).forEach((s) => {
          const d = Math.abs(s.price - tlPrice);
          if (d < minTlDiff) { minTlDiff = d; closestTlStep = s; }
        });
        if (closestTlStep && closestTlStep.el) {
          const act = closestTlStep.el.querySelector(".step-action");
          if (act) {
            act.innerHTML = `<span class="step-order-tag sell-order-tag" title="IOC Sell @ Trendline ($${fmtPrice(tlPrice)}): ~$${heldQuote.toFixed(1)} (${fmtQty(heldBase)} ${activeBaseAsset})"><span class="order-pulse-dot"></span> 📉 IOC TL $${heldQuote.toFixed(1)}</span>`;
            closestTlStep.el.classList.add("has-resting-sell");
          }
        }
      }

      // ── BUY LEVELS (0 to 4) ────────────────────────────────────────────────
      let runningCumFrac = 0;
      [0, 1, 2, 3, 4].forEach((idx) => {
        const step = ladderSteps.find((s) => s.isBuy && s.levelIndex === idx) || ladderSteps.find((s) => s.pct === effBuyPcts[idx]);
        if (!step || !step.el || !step.enabled) return;
        const actionEl = step.el.querySelector(".step-action");
        if (!actionEl) return;

        const lvlPrice = (bLevels && bLevels[idx] !== undefined) ? bLevels[idx] : step.price;
        const isCurrentBuyTrigger = Boolean(data.buyTrigger && Math.abs(lvlPrice - data.buyTrigger) < (span * 0.02));
        const frac = buyFractions[idx] || 0.2;
        runningCumFrac += frac;
        const targetCumulativeQuote = maxInv * runningCumFrac;
        const prevCumulativeQuote = maxInv * (runningCumFrac - frac);

        if (heldQuote >= targetCumulativeQuote - 1.0) {
          // Level target already met/exceeded (with $1.0 rounding/price tolerance)
          actionEl.innerHTML = `<span class="step-order-tag buy-order-tag" style="opacity:0.65; background:rgba(59,130,246,0.15); border-color:rgba(59,130,246,0.35); color:#93c5fd;" title="Level Capacity Met (Holding $${heldQuote.toFixed(1)} >= Target $${targetCumulativeQuote.toFixed(0)})">HOLD $${targetCumulativeQuote.toFixed(0)} ✓</span>`;
        } else {
          // Calculate incremental tranche spend for this specific level (e.g. +$50 for L4, +$60 for L5)
          const incrementalTrancheQuote = targetCumulativeQuote - Math.max(heldQuote, prevCumulativeQuote);
          const toSpendQuote = Math.max(0, Math.min(incrementalTrancheQuote, maxInv - heldQuote));
          const spendStr = `+$${Math.round(toSpendQuote)}`;
          const title = `IOC Buy Level ${idx + 1} @ $${fmtPrice(lvlPrice)}: Tranche ${spendStr} (Target Cumulative: $${targetCumulativeQuote.toFixed(0)})`;

          const isGateBlocked = Boolean(data.gateStatus && data.gateStatus !== "VALID_CHANNEL");
          const isBuyingBlocked = Boolean(data.isPaused || data.isBelowFloor || data.waitingForHigherLow || data.downtrendDropPaused || data.buyOrdersActive === false || isGateBlocked);

          if (isBuyingBlocked) {
            const blockReason = data.isPaused
              ? "Paused"
              : data.isBelowFloor
              ? "Below Floor"
              : (data.gateStatus === "WAITING_FOR_BASE_CONFIRMATION" || data.waitingForHigherLow)
              ? "🛡️ รอสร้างฐาน"
              : (data.gateStatus === "DOWNTREND_NO_CHANNEL" || data.downtrendDropPaused)
              ? "🛑 ตลาดขาลง"
              : (data.gateStatus === "UNSAFE_FLOOR_PROXIMITY")
              ? "⚠️ Floor ชิดราคา"
              : "Buy Paused";
            actionEl.innerHTML = `<span class="step-order-tag buy-order-tag" style="opacity:0.85; background:rgba(245,158,11,0.12); border:1px dashed rgba(245,158,11,0.4); color:#fbbf24; font-size:9.5px;" title="${blockReason} — พักการซื้อชั่วคราว">${blockReason}</span>`;
            step.el.classList.remove("has-resting-buy");
          } else if (isCurrentBuyTrigger) {
            actionEl.innerHTML = `<span class="step-order-tag buy-order-tag" title="${title}"><span class="order-pulse-dot"></span> IOC BUY ${spendStr}</span>`;
            step.el.classList.add("has-resting-buy");
          } else {
            actionEl.innerHTML = `<span class="step-order-tag buy-order-tag" style="opacity:0.8;" title="${title}">IOC BUY ${spendStr}</span>`;
          }
        }
      });
    }

    // 3c. Update Active Resistance Banner in Grid Meter Header
    if (elLadderResistanceBanner) {
      const tl = data.downtrendLine && !data.downtrendLine.isBroken ? data.downtrendLine : null;
      const tlPrice = tl?.currentLinePrice;
      const isTlActive = Boolean(tlPrice && (data.enableSellBelowTrendResistance !== false));
      const rcPrice = data.liveCalculatedUpperBound || data.upperBound;
      const isRcActive = Boolean(rcPrice && (data.enableSellAtRealCeiling !== false) && rcPrice < ceil);

      const activeTlOrder = (data.openOrders || []).find(
        (o) => !o.isBid && o.levelDesc && (o.levelDesc.includes("TL Exit") || o.levelDesc.includes("Trendline") || o.levelDesc.includes("Real Ceil")),
      );

      if (isTlActive && tlPrice && tlPrice < ceil) {
        elLadderResistanceBanner.style.display = "";
        const orderInfo = activeTlOrder
          ? ` • Exit: $${fmtPrice(activeTlOrder.price)} <span style="opacity:0.75; font-size:7.5px;">(-0.08%)</span>`
          : "";
        elLadderResistanceBanner.innerHTML = `📉 TL Resistance: $${fmtPrice(tlPrice)}${orderInfo}`;
      } else if (isRcActive && rcPrice && rcPrice < ceil) {
        elLadderResistanceBanner.style.display = "";
        const orderInfo = activeTlOrder
          ? ` • Exit: $${fmtPrice(activeTlOrder.price)} <span style="opacity:0.75; font-size:7.5px;">(-0.03%)</span>`
          : "";
        elLadderResistanceBanner.innerHTML = `🎯 Real Ceil: $${fmtPrice(rcPrice)}${orderInfo}`;
      } else {
        elLadderResistanceBanner.style.display = "none";
      }
    }

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
    } else if (pos <= effBuyPcts[4]) {
      activeStep = elStepBuy5;
      levelName = `Buy Level 5 (${effBuyPcts[4]}% | ${pos.toFixed(1)}%)`;
      targetText = `Target ${buyCumPcts[4]}% (Max Inventory)`;
      colorClass = "highlight-green";
      zoneBadgeText = `BUY ZONE (${pos.toFixed(1)}%)`;
      zoneBadgeClass = "active-zone-pill badge-inzone";
    } else if (pos <= effBuyPcts[3]) {
      activeStep = elStepBuy4;
      levelName = `Buy Level 4 (${effBuyPcts[3]}% | ${pos.toFixed(1)}%)`;
      targetText = `Target ${buyCumPcts[3]}% Capacity`;
      colorClass = "highlight-green";
      zoneBadgeText = `BUY ZONE (${pos.toFixed(1)}%)`;
      zoneBadgeClass = "active-zone-pill badge-inzone";
    } else if (pos <= effBuyPcts[2]) {
      activeStep = elStepBuy3;
      levelName = `Buy Level 3 (${effBuyPcts[2]}% | ${pos.toFixed(1)}%)`;
      targetText = `Target ${buyCumPcts[2]}% Capacity`;
      colorClass = "highlight-green";
      zoneBadgeText = `BUY ZONE (${pos.toFixed(1)}%)`;
      zoneBadgeClass = "active-zone-pill badge-inzone";
    } else if (pos <= effBuyPcts[1]) {
      activeStep = elStepBuy2;
      levelName = `Buy Level 2 (${effBuyPcts[1]}% | ${pos.toFixed(1)}%)`;
      targetText = `Target ${buyCumPcts[1]}% Capacity`;
      colorClass = "highlight-green";
      zoneBadgeText = `BUY ZONE (${pos.toFixed(1)}%)`;
      zoneBadgeClass = "active-zone-pill badge-inzone";
    } else if (pos <= effBuyPcts[0]) {
      activeStep = elStepBuy1;
      levelName = `Buy Level 1 (${effBuyPcts[0]}% | ${pos.toFixed(1)}%)`;
      targetText = `Target ${buyCumPcts[0]}% Capacity`;
      colorClass = "highlight-green";
      zoneBadgeText = `BUY ZONE (${pos.toFixed(1)}%)`;
      zoneBadgeClass = "active-zone-pill badge-inzone";
    } else if (pos < centerPct) {
      activeStep = elStepCenter;
      levelName = `Accumulation Midline (${pos.toFixed(1)}%)`;
      targetText = `Waiting Dip (<${effBuyPcts[0]}%)`;
      colorClass = "highlight-amber";
      zoneBadgeText = `ACCUMULATION (${pos.toFixed(1)}%)`;
      zoneBadgeClass = "active-zone-pill badge-range";
    } else if (pos <= (centerPct + Math.max(1, (effSellPcts[0] - centerPct) / 2))) {
      activeStep = elStepCenter;
      levelName = `${centerPct}% Center (${pos.toFixed(1)}%)`;
      targetText = "Hold 100% (Neutral Midline)";
      colorClass = "highlight-amber";
      zoneBadgeText = `${centerPct}% CENTER (${pos.toFixed(1)}%)`;
      zoneBadgeClass = "active-zone-pill badge-range";
    } else if (pos <= ((effSellPcts[0] + effSellPcts[1]) / 2)) {
      activeStep = elStepSell1;
      levelName = `Sell Target 1 (${effSellPcts[0]}% | ${pos.toFixed(1)}%)`;
      targetText = `Hold ${sellHoldPcts[0]}%`;
      colorClass = "highlight-red";
      zoneBadgeText = `SELL ZONE (${pos.toFixed(1)}%)`;
      zoneBadgeClass = "active-zone-pill badge-breakout";
    } else if (pos <= ((effSellPcts[1] + effSellPcts[2]) / 2)) {
      activeStep = elStepSell2;
      levelName = `Sell Target 2 (${effSellPcts[1]}% | ${pos.toFixed(1)}%)`;
      targetText = `Hold ${sellHoldPcts[1]}%`;
      colorClass = "highlight-red";
      zoneBadgeText = `SELL ZONE (${pos.toFixed(1)}%)`;
      zoneBadgeClass = "active-zone-pill badge-breakout";
    } else if (pos <= ((effSellPcts[2] + effSellPcts[3]) / 2)) {
      activeStep = elStepSell3;
      levelName = `Sell Target 3 (${effSellPcts[2]}% | ${pos.toFixed(1)}%)`;
      targetText = `Hold ${sellHoldPcts[2]}%`;
      colorClass = "highlight-red";
      zoneBadgeText = `SELL ZONE (${pos.toFixed(1)}%)`;
      zoneBadgeClass = "active-zone-pill badge-breakout";
    } else if (pos <= ((effSellPcts[3] + effSellPcts[4]) / 2)) {
      activeStep = elStepSell4;
      levelName = `Sell Target 4 (${effSellPcts[3]}% | ${pos.toFixed(1)}%)`;
      targetText = `Hold ${sellHoldPcts[3]}%`;
      colorClass = "highlight-red";
      zoneBadgeText = `SELL ZONE (${pos.toFixed(1)}%)`;
      zoneBadgeClass = "active-zone-pill badge-breakout";
    } else if (pos < 99) {
      activeStep = elStepSell5;
      levelName = `Sell Target 5 (${effSellPcts[4]}% | ${pos.toFixed(1)}%)`;
      targetText = `Hold ${sellHoldPcts[4]}% (Final Target)`;
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

    // Ensure activeStep is enabled and visible; if disabled, fallback to nearest visible enabled step
    if (activeStep) {
      const activeObj = ladderSteps.find((s) => s.el === activeStep);
      if (activeObj && !activeObj.enabled) {
        const visibleSteps = ladderSteps.filter((s) => s.enabled && s.el && s.el.style.display !== "none");
        let closest = null;
        let minDiff = Infinity;
        visibleSteps.forEach((s) => {
          const diff = Math.abs(s.pct - pos);
          if (diff < minDiff) {
            minDiff = diff;
            closest = s;
          }
        });
        if (closest && closest.el) {
          activeStep = closest.el;
        }
      }
    }

    if (activeStep) activeStep.classList.add("active-ladder-step");
    if (elLadderCurrentLevel) elLadderCurrentLevel.textContent = levelName;
    if (elLadderTargetAlloc) {
      if (typeof data.targetHoldingPct === "number" && typeof data.targetInventoryQuote === "number") {
        const allocQuoteStr = `$${data.targetInventoryQuote.toFixed(0)}`;
        const targetHoldingPctNum = Number(data.targetHoldingPct);
        const targetHoldingPctStr = Number.isFinite(targetHoldingPctNum)
          ? targetHoldingPctNum.toFixed(1).replace(/\.0$/, "")
          : "0";
        const fracNote = (data.targetHoldingPct === 0 && pos < 50) ? " (Waiting Dip)" : (data.targetHoldingPct === 100 ? " (Max Inv)" : "");
        elLadderTargetAlloc.textContent = `Target ${targetHoldingPctStr}% (${allocQuoteStr})${fracNote}`;
      } else {
        elLadderTargetAlloc.textContent = targetText;
      }
      elLadderTargetAlloc.className = `sum-val ${colorClass}`;
    }
    if (elLadderZoneBadge) {
      elLadderZoneBadge.textContent = zoneBadgeText;
      elLadderZoneBadge.className = zoneBadgeClass;
    }
  }

  function updateTick(data) {
    if (!data) return;
    if (data.versionInfo) {
      updateVersionBadge(data.versionInfo);
    }

    if (typeof data.pricePrecision === "number" && data.pricePrecision >= 0) {
      if (activePricePrecision !== data.pricePrecision || activeTickSize !== data.tickSize) {
        activePricePrecision = data.pricePrecision;
        activeTickSize = (typeof data.tickSize === "number" && data.tickSize > 0)
          ? data.tickSize
          : (1 / Math.pow(10, activePricePrecision));
        updateChartPrecision(activePricePrecision, activeTickSize);
      }
    }
    if (typeof data.qtyPrecision === "number" && data.qtyPrecision >= 0) {
      activeQtyPrecision = data.qtyPrecision;
      activeStepSize = (typeof data.stepSize === "number" && data.stepSize > 0)
        ? data.stepSize
        : (1 / Math.pow(10, activeQtyPrecision));
    }

    // Symbol Display
    const rawSymbol = data.symbol || (data.binanceSymbol ? `${data.binanceSymbol.toUpperCase()}` : "SOMI:USDso");
    const displaySymbol = rawSymbol.replace(":", " / ").toUpperCase();
    const macroTf = (data.dowTimeframe || "15m").toUpperCase();
    const tradeTf = (data.tradingTimeframe || "15m").toUpperCase();

    if (elNavSymbolBadge) elNavSymbolBadge.textContent = displaySymbol;
    if (elChartSymbolBadge) elChartSymbolBadge.textContent = displaySymbol;
    if (elLegendSymbol) elLegendSymbol.textContent = displaySymbol;
    if (elLegendTf) elLegendTf.textContent = macroTf;
    if (elLegendLivePrice && data.mid !== undefined) elLegendLivePrice.textContent = `$${fmtPrice(data.mid)}`;

    // Top Brand Logo Badge (Exchange indicator)
    const elLogoBadge = document.getElementById("logoBadge");
    if (elLogoBadge) {
      const isDreamdex = (data.exchange || "").toLowerCase() === "dreamdex" || rawSymbol.includes(":") || rawSymbol.includes("USDSO");
      let stratSuffix = "GRID";
      if (data.strategyType === "swing_trade" || (data.strategyName && data.strategyName.includes("Swing"))) {
        stratSuffix = "SWING";
      } else if (data.strategyType === "ma_fan" || data.strategyMode === "ma_fan") {
        stratSuffix = "MA FAN";
      }
      elLogoBadge.textContent = isDreamdex ? `DREAMDEX ${stratSuffix}` : `BINANCE ${stratSuffix}`;
    }

    // Dry Run vs Live Trading Mode Badge
    if (data.dryRun !== undefined && elDryRunBadge) {
      if (data.dryRun) {
        elDryRunBadge.textContent = "🟡 โหมดจำลอง (DRY RUN)";
        elDryRunBadge.className = "dry-badge";
        elDryRunBadge.style.background = "rgba(245, 158, 11, 0.16)";
        elDryRunBadge.style.color = "#fbbf24";
        elDryRunBadge.style.borderColor = "rgba(245, 158, 11, 0.4)";
      } else {
        elDryRunBadge.textContent = "🟢 โหมดเทรดจริง (LIVE)";
        elDryRunBadge.className = "dry-badge live-badge";
        elDryRunBadge.style.background = "rgba(16, 185, 129, 0.16)";
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
    if (data.strategyType === "ma_fan") {
      const execTf = (data.executionTimeframe || "5m").toUpperCase();
      const supTf = (data.supervisorTimeframe || data.htfRegime?.timeframe || "15m").toUpperCase();
      if (elTimeframeBadge) {
        elTimeframeBadge.textContent = `EXEC: ${execTf} • HTF SUPERVISOR: ${supTf}`;
      }
      if (elChartTimeframeSub) {
        elChartTimeframeSub.textContent = `(${execTf} Execution Candles)`;
      }
      const btnTf15m = document.getElementById("btnTf15m");
      const btnTf4h = document.getElementById("btnTf4h");
      if (btnTf15m && btnTf15m.textContent !== execTf) btnTf15m.textContent = execTf;
      if (btnTf4h && btnTf4h.textContent !== `${supTf} (HTF)`) btnTf4h.textContent = `${supTf} (HTF)`;
    } else if (data.dowTimeframe && data.tradingTimeframe) {
      const macroTf = data.dowTimeframe.toUpperCase();
      const tradeTf = data.tradingTimeframe.toUpperCase();
      if (elTimeframeBadge) {
        const modeStr = data.channelMode ? ` • MODE: ${data.channelMode}` : "";
        elTimeframeBadge.textContent = `CHART: ${macroTf} • TRIGGER: ${tradeTf}${modeStr}`;
      }
      if (elChartTimeframeSub) {
        elChartTimeframeSub.textContent = `(${macroTf} Macro Candles)`;
      }
      const btnTf15m = document.getElementById("btnTf15m");
      const btnTf4h = document.getElementById("btnTf4h");
      if (btnTf15m && btnTf15m.textContent !== "15M") btnTf15m.textContent = "15M";
      if (btnTf4h && btnTf4h.textContent !== "4H (HTF)") btnTf4h.textContent = "4H (HTF)";
    }

    // Mid Price & 50% Center
    if (data.mid !== undefined) {
      if (elMidPrice) elMidPrice.textContent = fmtPrice(data.mid);
      document.title = `$${fmtPrice(data.mid)} ${displaySymbol} | Dynamic Grid`;
    }
    if (data.centerPrice !== undefined && elAnchorPrice) elAnchorPrice.textContent = fmtPrice(data.centerPrice);

    // Spread in % and $
    if (data.spreadPct !== undefined && elSpreadBpsBadge) {
      elSpreadBpsBadge.textContent = `Spread: ${data.spreadPct.toFixed(2)}%`;
    }

    // HUD overlays in chart
    if (data.upperBound !== undefined && elHudUpperBound) {
      elHudUpperBound.textContent = fmtPrice(data.upperBound);
    }
    if (data.bottomBound !== undefined && elHudBottomBound) {
      elHudBottomBound.textContent = fmtPrice(data.bottomBound);
    }
    if (data.centerPrice !== undefined && elHudCenter) {
      elHudCenter.textContent = fmtPrice(data.centerPrice);
    }
    if (data.zoneWidthPct !== undefined && elHudChannelWidth) {
      elHudChannelWidth.textContent = `${data.zoneWidthPct.toFixed(2)}%`;
    }

    // Channel Clamp Mode & Swing Details
    const widthPct = data.zoneWidthPct !== undefined ? data.zoneWidthPct : 0;
    let clampStr = data.isSwingConfirmed === false && !data.isChannelLocked
      ? "⚪ ไม่มีกรอบสวิงที่เข้าเกณฑ์ (หยุดรอสวิง)"
      : data.channelMode === "DONCHIAN_ATR"
        ? `Donchian 48b + Dow ChoCh (${widthPct.toFixed(1)}%)`
      : data.channelMode === "VOLUME_PROFILE_HTF"
        ? `Hybrid VP + 4H HTF (${widthPct.toFixed(1)}%${data.poc ? ` • POC: $${fmtPrice(data.poc)}` : ""}${data.val ? ` • VAL: $${fmtPrice(data.val)}` : ""})`
        : data.channelMode === "DOW_SWINGS"
          ? `Pure Dow Swings`
        : data.clampStatus === "CLAMPED_MIN"
          ? `Clamped Min (${(data.minWidthPct || 0).toFixed(1)}%)`
          : data.clampStatus === "CLAMPED_MAX"
            ? `Clamped Max (${(data.maxWidthPct || 0).toFixed(1)}%)`
            : `Natural Swing (${widthPct.toFixed(1)}%)`;

    if (data.isChannelLocked) {
      const realCeilStr = data.liveCalculatedUpperBound
        ? ` • Real Ceil: $${fmtPrice(data.liveCalculatedUpperBound)}`
        : "";
      const realFloorStr = data.liveCalculatedBottomBound && Math.abs(data.liveCalculatedBottomBound - data.bottomBound) / data.bottomBound > 0.001
        ? ` • Real Floor: $${fmtPrice(data.liveCalculatedBottomBound)}`
        : "";
      clampStr = `🔒 100% Locked${realCeilStr}${realFloorStr} • ${clampStr}`;
    } else if (data.canEstablishChannel === false) {
      const gateBadge = data.gateStatus === "DOWNTREND_NO_CHANNEL"
        ? "🛑 ขาลง (Downtrend) — ปิดกรอบงดรับมีด"
        : data.gateStatus === "WAITING_FOR_BASE_CONFIRMATION"
          ? "⏳ หลุดฐาน — รอสร้างฐาน HL ใหม่"
          : data.gateStatus === "UNSAFE_FLOOR_PROXIMITY"
            ? `⚠️ Floor ชิดราคาเกินไป (< ${(data.minFloorProximityPct || 1.5).toFixed(1)}%)`
            : "⚪ พักรอโครงสร้าง";
      clampStr = `${gateBadge} • ${clampStr}`;
    }

    if (elChannelStatusPill) {
      elChannelStatusPill.style.display = data.strategyType === "swing_trade" ? "none" : "";
    }
    if (elChannelStatusText) {
      if (data.canEstablishChannel === false && !data.isChannelLocked) {
        elChannelStatusText.textContent = `Channel: ⏸️ ${data.gateReason || "ปิดกรอบรอเงื่อนไขเทรนด์"}`;
      } else if (data.isSwingConfirmed === false && !data.isChannelLocked) {
        elChannelStatusText.textContent = `Channel: ไม่มีกรอบที่เข้าเกณฑ์ (หยุดรอสวิง)`;
      } else {
        elChannelStatusText.textContent = `Channel: ${widthPct.toFixed(2)}% (${clampStr})`;
      }
    }
    const elLegendPillBottomText = document.getElementById("legendPillBottomText");
    if (elLegendPillBottomText && data.bottomBound) {
      elLegendPillBottomText.textContent = `0% Lower (Floor): $${fmtPrice(data.bottomBound)}`;
    }
    const elLegendPillCutLoss = document.getElementById("legendPillCutLoss");
    const elLegendPillCutLossText = document.getElementById("legendPillCutLossText");
    if (elLegendPillCutLoss && elLegendPillCutLossText) {
      if (data.cutLossBound && data.bottomBound && data.cutLossBound < data.bottomBound) {
        const bufDelta = data.bottomBound - data.cutLossBound;
        const bufPct = (bufDelta / data.bottomBound) * 100;
        elLegendPillCutLoss.style.display = "inline-flex";
        elLegendPillCutLossText.textContent = `Cut Loss Buffer: $${fmtPrice(data.cutLossBound)} (-${bufPct.toFixed(2)}%)`;
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
    const invUsd = data.inventoryUsdso !== undefined
      ? data.inventoryUsdso
      : (data.positionQuote || data.positionUsdso || (data.activePosition && data.mid ? data.activePosition.qty * data.mid : 0));
    const maxInvUsd = data.maxInventoryQuote || data.maxInventoryUsdso || 90;
    let totalBase = 0;
    lots.forEach((lot) => totalBase += (lot.qty || 0));
    if (totalBase === 0 && data.activePosition?.qty) {
      totalBase = data.activePosition.qty;
    }
    const rawHoldPct = data.currentHoldPct !== undefined ? data.currentHoldPct : (maxInvUsd > 0 ? (invUsd / maxInvUsd) * 100 : 0);
    const holdPct = Math.min(100, Math.max(0, rawHoldPct));

    // 🔒 Lock Trading Pair & Exchange controls when holding active position
    isHoldingActivePosition = (Array.isArray(lots) && lots.length > 0) ||
      (totalBase > 0.0001) ||
      (typeof data.baseHeld === "number" && data.baseHeld > 0.0001) ||
      (holdPct > 0);

    const elTopSymbolSelect = document.getElementById("topSymbolSelect");
    const elCfgSymbol = document.getElementById("cfg_symbol");
    const elCfgExchange = document.getElementById("cfg_exchange");
    if (elTopSymbolSelect) {
      if (!window.__isSwitchingSymbolUI && document.activeElement !== elTopSymbolSelect && rawSymbol) {
        const cleanSym = rawSymbol.replace(/[\/\s]/g, "").toUpperCase();
        const hasOpt = Array.from(elTopSymbolSelect.options).some((o) => o.value.toUpperCase() === cleanSym);
        if (!hasOpt && cleanSym !== "__CUSTOM__") {
          const opt = document.createElement("option");
          opt.value = cleanSym;
          opt.textContent = displaySymbol;
          const customOpt = Array.from(elTopSymbolSelect.options).find((o) => o.value === "__custom__");
          if (customOpt) elTopSymbolSelect.insertBefore(opt, customOpt);
          else elTopSymbolSelect.appendChild(opt);
        }
        if (elTopSymbolSelect.value !== cleanSym) {
          elTopSymbolSelect.value = cleanSym;
        }
        const topSearchInput = document.getElementById("topSymbolSearchInput");
        if (topSearchInput && document.activeElement !== topSearchInput) {
          topSearchInput.value = cleanSym;
        }
      }
      const topSearchInput = document.getElementById("topSymbolSearchInput");
      if (isHoldingActivePosition || window.__isSwitchingSymbolUI) {
        elTopSymbolSelect.disabled = true;
        elTopSymbolSelect.style.cursor = "not-allowed";
        elTopSymbolSelect.style.opacity = "0.6";
        elTopSymbolSelect.title = isHoldingActivePosition
          ? "🔒 ปิดการเปลี่ยนคู่เทรดชั่วคราวเนื่องจากบอทกำลังถือ Position อยู่ (กรุณา Take Profit หรือ Cut Loss ให้หมดก่อนสลับคู่เหรียญ)"
          : "⏳ กำลังสลับคู่เหรียญและยกเลิกออเดอร์คู่เดิม...";
        if (topSearchInput) {
          topSearchInput.disabled = true;
          topSearchInput.style.opacity = "0.6";
          topSearchInput.style.cursor = "not-allowed";
        }
      } else {
        elTopSymbolSelect.disabled = false;
        elTopSymbolSelect.style.cursor = "pointer";
        elTopSymbolSelect.style.opacity = "1";
        elTopSymbolSelect.title = "Change Trading Pair";
        if (topSearchInput) {
          topSearchInput.disabled = false;
          topSearchInput.style.opacity = "1";
          topSearchInput.style.cursor = "text";
        }
      }
    }
    if (elCfgSymbol) {
      if (isHoldingActivePosition) {
        elCfgSymbol.disabled = true;
        elCfgSymbol.style.cursor = "not-allowed";
        elCfgSymbol.title = "🔒 บอทกำลังถือ Position อยู่ ไม่สามารถสลับเหรียญได้";
      } else {
        elCfgSymbol.disabled = false;
        elCfgSymbol.style.cursor = "pointer";
        elCfgSymbol.title = "";
      }
    }
    if (elCfgExchange) {
      if (isHoldingActivePosition) {
        elCfgExchange.disabled = true;
        elCfgExchange.style.cursor = "not-allowed";
        elCfgExchange.title = "🔒 บอทกำลังถือ Position อยู่ ไม่สามารถสลับกระดานเทรดได้";
      } else {
        elCfgExchange.disabled = false;
        elCfgExchange.style.cursor = "pointer";
        elCfgExchange.title = "";
      }
    }

    // 0. Binance Account Balance Updates
    activeSymbol = data.symbol || data.binanceSymbol || activeSymbol || "SOMI:USDso";
    activeBaseAsset = data.baseAsset || activeBaseAsset || "BASE";
    activeQuoteAsset = data.quoteAsset || activeQuoteAsset || "USDT";
    const baseSym = activeBaseAsset;
    const quoteSym = activeQuoteAsset;
    const walletAddr = data.walletAddress || "";
    const isEvmAddr = typeof walletAddr === "string" && walletAddr.startsWith("0x") && walletAddr.length > 12;
    const shortAddr = isEvmAddr ? `${walletAddr.slice(0, 6)}...${walletAddr.slice(-4)}` : (walletAddr || "Binance Spot");
    const somiBal = data.walletBaseBalance !== undefined ? data.walletBaseBalance : (data.walletSomiBalance !== undefined ? data.walletSomiBalance : 0);
    const usdsoBal = data.walletQuoteBalance !== undefined ? data.walletQuoteBalance : (data.walletUsdsoBalance !== undefined ? data.walletUsdsoBalance : 0);
    const somiVal = somiBal * (data.mid || 0);
    const totalVal = data.walletTotalValueQuote !== undefined ? data.walletTotalValueQuote : (somiVal + usdsoBal);

    const tradingSomi = data.tradingSomiBalance !== undefined ? data.tradingSomiBalance : totalBase;
    const gasReserve = data.gasReserveSomi !== undefined ? data.gasReserveSomi : Math.max(0, somiBal - tradingSomi);

    if (elNavWalletAddr) elNavWalletAddr.textContent = shortAddr;
    if (elNavWalletSomi) {
      elNavWalletSomi.textContent = `${fmtQty(somiBal)} ${baseSym}`;
      elNavWalletSomi.title = `Spot Wallet: ${fmtQty(somiBal)} ${baseSym}\n• Trading: ${fmtQty(tradingSomi)} ${baseSym}`;
    }
    if (elNavWalletUsdso) elNavWalletUsdso.textContent = `$${usdsoBal.toFixed(2)} ${quoteSym}`;

    if (elTopWalletAddrBadge) elTopWalletAddrBadge.textContent = shortAddr;
    if (elTopWalletSomi) {
      elTopWalletSomi.textContent = `${fmtQty(somiBal)} ${baseSym}`;
      elTopWalletSomi.title = `Total: ${fmtQty(somiBal)} ${baseSym} (Trading: ${fmtQty(tradingSomi)})`;
    }
    if (elTopWalletUsdso) elTopWalletUsdso.textContent = `$${usdsoBal.toFixed(2)} ${quoteSym}`;
    if (elTopWalletTotalVal) {
      elTopWalletTotalVal.textContent = `Total: $${totalVal.toFixed(2)}`;
      elTopWalletTotalVal.title = `Total Portfolio Value: $${totalVal.toFixed(2)}`;
    }

    // 1. Top KPI: Position Allocation
    if (elTopPosBadge) elTopPosBadge.textContent = lots.length > 0 ? `${holdPct.toFixed(1)}% (${lots.length} ไม้)` : `${holdPct.toFixed(1)}%`;
    if (elTopPosBase) elTopPosBase.textContent = `${fmtQty(totalBase)} ${baseSym}`;
    if (elTopPosUsd) elTopPosUsd.textContent = `$${invUsd.toFixed(2)}`;
    if (elTopMaxInv) elTopMaxInv.textContent = maxInvUsd.toFixed(0);

    // 2. Top KPI: Capacity Load
    const invPct = Math.min(100, Math.round((invUsd / maxInvUsd) * 100));
    if (elTopCapPct) elTopCapPct.textContent = `${invPct}% Load`;
    if (elInventoryUsd) elInventoryUsd.textContent = `$${invUsd.toFixed(2)}`;
    if (elInventoryProgress) elInventoryProgress.style.width = `${invPct}%`;

    // 3. Top KPI: Unrealized Profit & Cost Basis
    const posEntry = data.avgEntryPrice || data.activePosition?.entryPrice || (lots.length > 0 && totalBase > 0 ? (lots.reduce((s, l) => s + (l.price * l.qty), 0) / totalBase) : 0);
    const upnl = data.unrealizedPnl !== undefined
      ? data.unrealizedPnl
      : (posEntry > 0 && totalBase > 0 && data.mid ? (data.mid - posEntry) * totalBase : 0);
    const costBasis = (posEntry > 0 && totalBase > 0) ? (totalBase * posEntry) : invUsd;
    const upnlPct = data.unrealizedPnlPct !== undefined
      ? data.unrealizedPnlPct
      : (costBasis > 0 ? (upnl / costBasis) * 100 : (invUsd > 0 ? (upnl / invUsd) * 100 : 0));
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

    const avgPrice = posEntry > 0 ? `$${fmtPrice(posEntry)}` : "--.--";
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
    if (elLotsBadgeCount) elLotsBadgeCount.textContent = `${lots.length}`;

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

    // 5. Exchange Orderbook: Best Bid & Ask
    if (elHudBestBid && data.bestBid !== undefined && data.bestBid > 0) {
      elHudBestBid.textContent = `$${fmtPrice(data.bestBid)}`;
    }
    if (elHudBestAsk && data.bestAsk !== undefined && data.bestAsk > 0) {
      elHudBestAsk.textContent = `$${fmtPrice(data.bestAsk)}`;
    }
    if (elTopBookSpread && data.bestBid && data.bestAsk && data.bestBid > 0 && data.bestAsk > 0) {
      const spPct = ((data.bestAsk - data.bestBid) / data.bestBid) * 100;
      elTopBookSpread.textContent = `Spread: ${spPct.toFixed(2)}%`;
      elTopBookSpread.className = `kpi-badge ${spPct > 0.5 ? "badge-soft-orange" : "badge-soft"}`;
    }
    if (elTopBidSubText && data.bestBid && data.mid) {
      const bidDiff = ((data.mid - data.bestBid) / data.mid) * 100;
      elTopBidSubText.textContent = bidDiff >= 0 ? `Mid -${bidDiff.toFixed(2)}%` : `Mid +${Math.abs(bidDiff).toFixed(2)}%`;
    }
    if (elTopAskSubText && data.bestAsk && data.mid) {
      const askDiff = ((data.bestAsk - data.mid) / data.mid) * 100;
      elTopAskSubText.textContent = askDiff >= 0 ? `Mid +${askDiff.toFixed(2)}%` : `Mid -${Math.abs(askDiff).toFixed(2)}%`;
    }

    // Fallback: Next Buy Trigger
    if (data.buyTrigger !== undefined && elHudBuyTrigger) {
      elHudBuyTrigger.textContent = `$${fmtPrice(data.buyTrigger)}`;
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

    // Fallback: Next Sell Trigger
    if (data.sellTrigger !== undefined && elHudSellTrigger) {
      elHudSellTrigger.textContent = `$${fmtPrice(data.sellTrigger)}`;
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
      const isSwingMode = data.strategyType === "swing_trade";

      // 1. 100% Upper Bound (Full Exit) - Solid Fuchsia / Magenta (Grid Mode Only)
      if (!isSwingMode && data.upperBound && data.bottomBound) {
        lineUpperBound = setPriceLine(lineUpperBound, {
          price: data.upperBound,
          color: "#d946ef",
          lineWidth: 2,
          lineStyle: LightweightCharts.LineStyle.Solid,
          axisLabelVisible: true,
          title: "",
        });
      } else if (lineUpperBound) {
        try { candleSeries.removePriceLine(lineUpperBound); } catch (_) {}
        lineUpperBound = null;
      }

      // 1.1 Real Current Calculated Resistance Bound (Dashed Fuchsia / Magenta Line)
      if (
        !isSwingMode &&
        data.isChannelLocked &&
        data.liveCalculatedUpperBound
      ) {
        lineLiveCalculatedUpperBound = setPriceLine(lineLiveCalculatedUpperBound, {
          price: data.liveCalculatedUpperBound,
          color: "#e879f9",
          lineWidth: 2,
          lineStyle: LightweightCharts.LineStyle.Dashed,
          axisLabelVisible: true,
          title: "",
        });
      } else if (lineLiveCalculatedUpperBound) {
        try { candleSeries.removePriceLine(lineLiveCalculatedUpperBound); } catch (_) {}
        lineLiveCalculatedUpperBound = null;
      }

      // 1.2 Real Current Calculated Support Bound (Dashed Purple Line, if differs from locked floor)
      if (
        !isSwingMode &&
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
          title: "",
        });
      } else if (lineLiveCalculatedBottomBound) {
        try { candleSeries.removePriceLine(lineLiveCalculatedBottomBound); } catch (_) {}
        lineLiveCalculatedBottomBound = null;
      }

      // 2. 50% Channel Center (Midline) - Dashed Amber (Grid Mode Only)
      if (!isSwingMode && data.centerPrice && data.bottomBound && data.upperBound) {
        lineCenter = setPriceLine(lineCenter, {
          price: data.centerPrice,
          color: "rgba(251, 191, 36, 0.45)",
          lineWidth: 1.5,
          lineStyle: LightweightCharts.LineStyle.Dashed,
          axisLabelVisible: true,
          title: "",
        });
      } else if (lineCenter) {
        try { candleSeries.removePriceLine(lineCenter); } catch (_) {}
        lineCenter = null;
      }

      // 3. 0% Lower Bound (Structural Grid Floor) - Solid Purple (Grid Mode Only)
      if (!isSwingMode && data.bottomBound && data.upperBound) {
        lineBottomBound = setPriceLine(lineBottomBound, {
          price: data.bottomBound,
          color: "#c084fc",
          lineWidth: 2,
          lineStyle: LightweightCharts.LineStyle.Solid,
          axisLabelVisible: true,
          title: "",
        });
      } else if (lineBottomBound) {
        try { candleSeries.removePriceLine(lineBottomBound); } catch (_) {}
        lineBottomBound = null;
      }

      // 3.1 Cut Loss Trigger Buffer Line - Dashed Slate Silver (Grid Mode Only)
      if (!isSwingMode && data.cutLossBound && data.cutLossBound < data.bottomBound) {
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
        try { candleSeries.removePriceLine(lineCutLossBound); } catch (_) {}
        lineCutLossBound = null;
      }

      // 3.2 4H HTF Major Support / Resistance & POC Lines
      const midPrice = data.mid || data.refPrice || 0;
      const maxHtfDeviation = 0.075; // 7.5% max deviation from mid to protect Y-axis scaling from ancient extremes
      const isHtfCeilValid = Boolean(
        data.htfCeil && data.htfCeil > 0 &&
        (midPrice <= 0 || (data.htfCeil - midPrice) / midPrice <= maxHtfDeviation)
      );
      const isHtfFloorValid = Boolean(
        data.htfFloor && data.htfFloor > 0 &&
        (midPrice <= 0 || (midPrice - data.htfFloor) / midPrice <= maxHtfDeviation)
      );

      if (showHtfLines && isHtfCeilValid) {
        lineHtfCeil = setPriceLine(lineHtfCeil, {
          price: data.htfCeil,
          color: "#a855f7",
          lineWidth: 2,
          lineStyle: LightweightCharts.LineStyle.Solid,
          axisLabelVisible: true,
          title: "",
        });
      } else if (lineHtfCeil) {
        try { candleSeries.removePriceLine(lineHtfCeil); } catch (_) {}
        lineHtfCeil = null;
      }

      if (showHtfLines && isHtfFloorValid) {
        lineHtfFloor = setPriceLine(lineHtfFloor, {
          price: data.htfFloor,
          color: "#7c3aed",
          lineWidth: 2,
          lineStyle: LightweightCharts.LineStyle.Solid,
          axisLabelVisible: true,
          title: "",
        });
      } else if (lineHtfFloor) {
        try { candleSeries.removePriceLine(lineHtfFloor); } catch (_) {}
        lineHtfFloor = null;
      }

      if (showHtfLines && data.poc && data.poc > 0) {
        linePoc = setPriceLine(linePoc, {
          price: data.poc,
          color: "#f59e0b",
          lineWidth: 1.5,
          lineStyle: LightweightCharts.LineStyle.Dashed,
          axisLabelVisible: true,
          title: "",
        });
      } else if (linePoc) {
        try { candleSeries.removePriceLine(linePoc); } catch (_) {}
        linePoc = null;
      }

      // 4. Intermediate Grid Levels in Buy and Sell Zones OR Dedicated Swing Trade Lines
      if (data.strategyType === "swing_trade") {
        // Clear grid levels
        while (gridZoneLevelLines.length > 0) {
          const l = gridZoneLevelLines.pop();
          if (l) try { candleSeries.removePriceLine(l); } catch (_) {}
        }

        const plan = data.swingPlan || {};
        const pos = data.activePosition;
        const signal = data.lastSignal;
        const entryPrice = plan.entryPrice || pos?.entryPrice || (signal?.hasSignal ? signal.entryPrice : 0);
        const slPrice = plan.stopLossPrice || pos?.stopLossPrice || (signal?.hasSignal ? signal.stopLossPrice : 0);
        const tp1Price = plan.tp1Price || pos?.tp1Price || (signal?.hasSignal ? signal.tp1Price : 0);
        const tp2Price = plan.tp2Price || pos?.tp2Price || (signal?.hasSignal ? signal.tp2Price : 0);

        // Swing Entry Line (Green)
        if (entryPrice > 0) {
          lineSwingEntry = setPriceLine(lineSwingEntry, {
            price: entryPrice,
            color: "#10b981",
            lineWidth: 2,
            lineStyle: pos ? LightweightCharts.LineStyle.Solid : LightweightCharts.LineStyle.Dashed,
            axisLabelVisible: true,
            title: "",
          });
        } else if (lineSwingEntry) {
          try { candleSeries.removePriceLine(lineSwingEntry); } catch (_) {}
          lineSwingEntry = null;
        }

        // Swing TP1 Line (Amber/Orange)
        if (tp1Price > 0) {
          lineSwingTp1 = setPriceLine(lineSwingTp1, {
            price: tp1Price,
            color: "#f59e0b",
            lineWidth: 2,
            lineStyle: LightweightCharts.LineStyle.Dashed,
            axisLabelVisible: true,
            title: "",
          });
        } else if (lineSwingTp1) {
          try { candleSeries.removePriceLine(lineSwingTp1); } catch (_) {}
          lineSwingTp1 = null;
        }

        // Swing TP2 Line (Cyan)
        if (tp2Price > 0) {
          lineSwingTp2 = setPriceLine(lineSwingTp2, {
            price: tp2Price,
            color: "#06b6d4",
            lineWidth: 2,
            lineStyle: LightweightCharts.LineStyle.Dashed,
            axisLabelVisible: true,
            title: "",
          });
        } else if (lineSwingTp2) {
          try { candleSeries.removePriceLine(lineSwingTp2); } catch (_) {}
          lineSwingTp2 = null;
        }

        // Swing Stop Loss Line (Red)
        if (slPrice > 0) {
          lineSwingSl = setPriceLine(lineSwingSl, {
            price: slPrice,
            color: "#ef4444",
            lineWidth: 2,
            lineStyle: pos ? LightweightCharts.LineStyle.Solid : LightweightCharts.LineStyle.Dashed,
            axisLabelVisible: true,
            title: "",
          });
        } else if (lineSwingSl) {
          try { candleSeries.removePriceLine(lineSwingSl); } catch (_) {}
          lineSwingSl = null;
        }

        // Swing Next Entry Line (Dotted Light Blue) when holding a position above new LL
        const nextPlannedEntry = plan.nextPlannedEntryPrice;
        if (pos && nextPlannedEntry > 0 && Math.abs(nextPlannedEntry - entryPrice) / entryPrice >= 0.004) {
          lineSwingNextEntry = setPriceLine(lineSwingNextEntry, {
            price: nextPlannedEntry,
            color: "#38bdf8",
            lineWidth: 1,
            lineStyle: LightweightCharts.LineStyle.Dotted,
            axisLabelVisible: true,
            title: "",
          });
        } else if (lineSwingNextEntry) {
          try { candleSeries.removePriceLine(lineSwingNextEntry); } catch (_) {}
          lineSwingNextEntry = null;
        }
      } else if (data.strategyType === "ma_fan" || data.strategyMode === "ma_fan") {
        // Clear grid levels
        while (gridZoneLevelLines.length > 0) {
          const l = gridZoneLevelLines.pop();
          if (l) try { candleSeries.removePriceLine(l); } catch (_) {}
        }
        // Clear swing lines
        if (lineSwingEntry) { try { candleSeries.removePriceLine(lineSwingEntry); } catch (_) {} lineSwingEntry = null; }
        if (lineSwingTp1) { try { candleSeries.removePriceLine(lineSwingTp1); } catch (_) {} lineSwingTp1 = null; }
        if (lineSwingTp2) { try { candleSeries.removePriceLine(lineSwingTp2); } catch (_) {} lineSwingTp2 = null; }
        if (lineSwingSl) { try { candleSeries.removePriceLine(lineSwingSl); } catch (_) {} lineSwingSl = null; }
        if (lineSwingNextEntry) { try { candleSeries.removePriceLine(lineSwingNextEntry); } catch (_) {} lineSwingNextEntry = null; }

        const ribbon = data.ribbon || {};
        const pos = data.activePosition;
        const tp1Price = pos?.tp1Price || ribbon.ema25 || 0;
        const tp2Price = Math.max(ribbon.ema75 || 0, ribbon.ema200 || 0);

        // Clean up TP price lines on chart completely (keeps chart clean and prevents overlap with MA lines)
        if (lineMfTp1) {
          try { candleSeries.removePriceLine(lineMfTp1); } catch (_) {}
          lineMfTp1 = null;
        }
        if (lineMfTp2) {
          try { candleSeries.removePriceLine(lineMfTp2); } catch (_) {}
          lineMfTp2 = null;
        }

        // MA Fan Entry Line (Green)
        if (pos && pos.entryPrice > 0) {
          lineMfEntry = setPriceLine(lineMfEntry, {
            price: pos.entryPrice,
            color: "#10b981",
            lineWidth: 2,
            lineStyle: LightweightCharts.LineStyle.Solid,
            axisLabelVisible: true,
            title: "🟢 Entry",
          });
        } else if (lineMfEntry) {
          try { candleSeries.removePriceLine(lineMfEntry); } catch (_) {}
          lineMfEntry = null;
        }

        // MA Fan Stop Loss Line (Blue if Breakeven Locked, Red if SL)
        if (pos && pos.stopLossPrice > 0) {
          lineMfSl = setPriceLine(lineMfSl, {
            price: pos.stopLossPrice,
            color: pos.isBreakevenLocked ? "#3b82f6" : "#ef4444",
            lineWidth: 2,
            lineStyle: LightweightCharts.LineStyle.Solid,
            axisLabelVisible: true,
            title: pos.isBreakevenLocked ? "🛡️ Breakeven" : "🔴 Stop Loss",
          });
        } else if (lineMfSl) {
          try { candleSeries.removePriceLine(lineMfSl); } catch (_) {}
          lineMfSl = null;
        }
      } else {
        // Clear MA Fan lines when in Grid or Swing mode
        if (lineMfEntry) { try { candleSeries.removePriceLine(lineMfEntry); } catch (_) {} lineMfEntry = null; }
        if (lineMfTp1) { try { candleSeries.removePriceLine(lineMfTp1); } catch (_) {} lineMfTp1 = null; }
        if (lineMfTp2) { try { candleSeries.removePriceLine(lineMfTp2); } catch (_) {} lineMfTp2 = null; }
        if (lineMfSl) { try { candleSeries.removePriceLine(lineMfSl); } catch (_) {} lineMfSl = null; }

        // Clear Swing Lines when in Grid mode
        if (lineSwingEntry) {
          try { candleSeries.removePriceLine(lineSwingEntry); } catch (_) {}
          lineSwingEntry = null;
        }
        if (lineSwingTp1) {
          try { candleSeries.removePriceLine(lineSwingTp1); } catch (_) {}
          lineSwingTp1 = null;
        }
        if (lineSwingTp2) {
          try { candleSeries.removePriceLine(lineSwingTp2); } catch (_) {}
          lineSwingTp2 = null;
        }
        if (lineSwingSl) {
          try { candleSeries.removePriceLine(lineSwingSl); } catch (_) {}
          lineSwingSl = null;
        }
        if (lineSwingNextEntry) {
          try { candleSeries.removePriceLine(lineSwingNextEntry); } catch (_) {}
          lineSwingNextEntry = null;
        }

        const buyPcts = Array.isArray(data.buyLevelPcts) && data.buyLevelPcts.length >= 5
          ? data.buyLevelPcts
          : [42, 32, 22, 12, 2];
        const sellPcts = Array.isArray(data.sellLevelPcts) && data.sellLevelPcts.length >= 5
          ? data.sellLevelPcts
          : [52, 62, 72, 82, 92];

        let buyLevels = Array.isArray(data.buyLevels) && data.buyLevels.length > 0
          ? data.buyLevels
          : (data.bottomBound && data.upperBound
              ? buyPcts.map((pct) => data.bottomBound + (data.upperBound - data.bottomBound) * (pct / 100))
              : (data.buyLevels || []));

        let sellLevels = Array.isArray(data.sellLevels) && data.sellLevels.length > 0
          ? data.sellLevels
          : (data.bottomBound && data.upperBound
              ? sellPcts.map((pct) => data.bottomBound + (data.upperBound - data.bottomBound) * (pct / 100))
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

          const enabledBuys = Array.isArray(data.enabledBuyLevels) ? data.enabledBuyLevels : [true, true, true, true, true];
          const enabledSells = Array.isArray(data.enabledSellTargets) ? data.enabledSellTargets : [true, true, true, true, true];

          let lineIdx = 0;
          // Buy Levels (40%, 30%, 20%, 10%) - Soft Subtle Cyan dotted lines (does not clash with candles)
          buyLevels.forEach((lvl, bIdx) => {
            if (Number.isFinite(lvl) && gridZoneLevelLines[lineIdx]) {
              const isEnabled = enabledBuys[bIdx] !== false;
              gridZoneLevelLines[lineIdx].applyOptions({
                price: lvl,
                color: isEnabled ? "rgba(56, 189, 248, 0.22)" : "rgba(148, 163, 184, 0.12)",
                axisLabelVisible: isEnabled,
                title: "",
              });
              lineIdx++;
            }
          });

          // Sell Levels (60%, 70%, 80%, 90%) - Soft Subtle Coral Orange dotted lines (does not clash with candles)
          sellLevels.forEach((lvl, sIdx) => {
            if (Number.isFinite(lvl) && gridZoneLevelLines[lineIdx]) {
              const isEnabled = enabledSells[sIdx] !== false;
              gridZoneLevelLines[lineIdx].applyOptions({
                price: lvl,
                color: isEnabled ? "rgba(249, 115, 22, 0.22)" : "rgba(148, 163, 184, 0.12)",
                axisLabelVisible: isEnabled,
                title: "",
              });
              lineIdx++;
            }
          });
        }
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

      // ── Open Order Lines: Active resting Limit Orders on Exchange ───────────
      const rawOpenOrders = Array.isArray(data.openOrders) ? data.openOrders : [];
      const validOrders = rawOpenOrders.filter((o) => o && Number.isFinite(o.price) && o.price > 0);

      while (openOrderPriceLines.length < validOrders.length) {
        const l = candleSeries.createPriceLine({
          price: validOrders[openOrderPriceLines.length]?.price || 0,
          color: "rgba(255, 255, 255, 0.4)",
          lineWidth: 1,
          lineStyle: LightweightCharts.LineStyle.Dashed,
          axisLabelVisible: true,
          title: "",
        });
        if (l) openOrderPriceLines.push(l);
        else break;
      }
      while (openOrderPriceLines.length > validOrders.length) {
        const excess = openOrderPriceLines.pop();
        if (excess) {
          try { candleSeries.removePriceLine(excess); } catch (_) {}
        }
      }

      validOrders.forEach((order, idx) => {
        const line = openOrderPriceLines[idx];
        if (!line) return;
        const isBid = Boolean(order.isBid);
        line.applyOptions({
          price: order.price,
          color: isBid ? "#facc15" : "#f97316", // Electric Gold for Buys, Coral Orange for Sells (does not clash with green/red candles!)
          lineWidth: 1.5,
          lineStyle: LightweightCharts.LineStyle.Dashed,
          axisLabelVisible: true,
          title: "", // Clean: thin dashed line, no blocking boxes on candles!
        });
      });
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

          // If wave is hidden, only show active key bounds
          if (!isWaveVisible && !isActive) continue;

          if (s.type === "HIGH") {
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
              title = `${label} @ ${fmtPrice(s.price)}`;
            }
            pushSwingBadge(s.time, s.price, label, icon, cssClass, false, title);
            swingBadgeTimes.add(s.time);

          } else {
            // LOW (เหว)
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
              title = `${label} @ ${fmtPrice(s.price)}`;
            }
            if (!swingBadgeTimes.has(s.time)) {
              pushSwingBadge(s.time, s.price, label, icon, cssClass, true, title);
              swingBadgeTimes.add(s.time);
            }
          }
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
          <td>$${fmtPrice(lot.price)}</td>
          <td>$${lotVal.toFixed(2)}</td>
          <td style="color: #38bdf8;">${weightPct.toFixed(0)}%</td>
        </tr>`;
    });

    elLotsTableBody.innerHTML = html;
    elLotsTotalBase.textContent = `${fmtQty(totalBase)} ${activeBaseAsset} ($${totalValue.toFixed(2)})`;
  }

  function renderOpenOrdersTable(openOrders, mid) {
    if (!elOpenOrdersTableBody) return;
    if (!openOrders || openOrders.length === 0) {
      elOpenOrdersTableBody.innerHTML = `
        <tr class="empty-row">
          <td colspan="6">ไม่มีออเดอร์ Limit ที่วางรอในสมุดคำสั่งซื้อ</td>
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

      // Expiration time calculation (Only if exchange supports order expiry, e.g. DreamDEX)
      let expCell = `<td style="font-family: var(--font-mono); font-size: 11px; opacity: 0.6;">GTC</td>`;
      if (o.expireTime) {
        let expText = "24h";
        let expClass = "";
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
        expCell = `<td class="${expClass}" style="font-family: var(--font-mono); font-size: 11px;">⏳ ${expText}</td>`;
      }

      html += `
        <tr>
          <td class="${sideClass}" style="font-weight: 700;">${sideText}</td>
          <td>${o.levelDesc || "-"}</td>
          <td style="font-family: var(--font-mono);">$${fmtPrice(o.price)}</td>
          <td>${fmtQty(o.qty)}</td>
          <td style="font-family: var(--font-mono);">$${notional.toFixed(2)}</td>
          ${expCell}
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
    const qtyStr = order.qty ? `${fmtQty(order.qty)} ${activeBaseAsset}` : "";
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
        <span class="toast-price">$${fmtPrice(order.price || 0)}</span>
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
  const elOpenOrdersFeed = document.getElementById("openOrdersFeed");
  const elHoldingLotsFeed = document.getElementById("holdingLotsFeed");
  const elOnchainFeed = document.getElementById("onchainFeed");
  const elAllFeed = document.getElementById("allFeed");
  const elTradesCount = document.getElementById("tradesCount");
  const elOnchainCount = document.getElementById("onchainCount");
  const elOrdersCount = document.getElementById("ordersCount");
  const tabTradesBtn = document.getElementById("tabTradesBtn");
  const tabOpenOrdersBtn = document.getElementById("tabOpenOrdersBtn");
  const tabHoldingLotsBtn = document.getElementById("tabHoldingLotsBtn");
  const tabOnchainBtn = document.getElementById("tabOnchainBtn");
  const tabAllBtn = document.getElementById("tabAllBtn");
  let tradesCount = 0;
  let onchainCount = 0;
  let allCount = 0;

  // Tab switching logic
  const actTabs = [
    { btn: tabTradesBtn, feed: elTradesFeed, name: "trades" },
    { btn: tabOpenOrdersBtn, feed: elOpenOrdersFeed, name: "openorders" },
    { btn: tabHoldingLotsBtn, feed: elHoldingLotsFeed, name: "holdinglots" },
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

  function formatActivityTime(timestamp) {
    if (!timestamp) return { display: "", full: "" };
    const d = new Date(timestamp);
    if (isNaN(d.getTime())) return { display: "", full: "" };

    const now = Date.now();
    const diffMs = now - d.getTime();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const hours = String(d.getHours()).padStart(2, "0");
    const minutes = String(d.getMinutes()).padStart(2, "0");
    const seconds = String(d.getSeconds()).padStart(2, "0");
    const fullDateTime = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;

    // If less than 12 hours ago (and not in the future > 1 min):
    if (diffMs >= -60000 && diffMs < 12 * 3600 * 1000) {
      const diffSec = Math.max(0, Math.floor(diffMs / 1000));
      if (diffSec < 45) return { display: "just now", full: fullDateTime };
      const diffMin = Math.floor(diffSec / 60);
      if (diffMin < 60) return { display: `${diffMin}m ago`, full: fullDateTime };
      const diffHours = Math.floor(diffMin / 60);
      const remMin = diffMin % 60;
      return {
        display: remMin > 0 ? `${diffHours}h ${remMin}m ago` : `${diffHours}h ago`,
        full: fullDateTime,
      };
    }

    // 12 hours or older: display Day/Month/Year Hour:Minute e.g. "15/10/26 13:53"
    const shortYear = String(year).slice(-2);
    const display = `${day}/${month}/${shortYear} ${hours}:${minutes}`;
    return { display, full: fullDateTime };
  }

  function createActivityElement(order) {
    const div = document.createElement("div");
    div.className = "activity-item";

    let badgeClass = "act-neutral";
    let badgeText = order.action || "ORDER";
    const isIocOrder = Boolean(order.isIoc || order.maker === false || order.levelDesc?.includes("IOC") || order.reason?.includes("IOC"));
    if (order.action === "BUY" || order.action === "BUY_FILL" || order.action === "SNIPE_BUY") {
      badgeClass = "act-buy";
      badgeText = isIocOrder ? "IOC BUY" : "BUY FILL";
    } else if (order.action === "SELL" || order.action === "SELL_FILL" || order.action === "TAKE_PROFIT" || order.action === "SNIPE_SELL") {
      badgeClass = "act-sell";
      badgeText = isIocOrder ? (order.action === "TAKE_PROFIT" ? "IOC TP" : "IOC SELL") : "SELL FILL";
    } else if (order.action === "CUT") {
      badgeClass = "act-cut";
      badgeText = isIocOrder ? "IOC CUT" : "CUT LOSS";
    } else if (order.action === "EXIT") {
      badgeClass = "act-buy";
      badgeText = isIocOrder ? "IOC EXIT" : "FULL EXIT";
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

    const timeInfo = formatActivityTime(order.time || Date.now());
    const baseSym = order.baseAsset || (order.symbol ? order.symbol.split(/[:\-_]/)[0] : "") || activeBaseAsset || "BASE";
    const quoteVal = order.notionalQuote !== undefined ? order.notionalQuote : (order.notionalUsdso !== undefined ? order.notionalUsdso : (order.price && order.qty ? order.price * order.qty : 0));
    const notionalStr = quoteVal > 0 ? `$${quoteVal.toFixed(2)}` : "";
    const qtyStr = order.qty ? `${fmtQty(order.qty)} ${baseSym}` : "";

    // ── Clean & Compact Level Description & Target Name ──
    let cleanLevelDesc = (order.levelDesc || "").trim();
    if (["TAKE_PROFIT", "SELL", "BUY", "CUT_LOSS", "CUT", "EXIT", "SNIPE_BUY", "SNIPE_SELL"].includes(cleanLevelDesc.toUpperCase())) {
      cleanLevelDesc = "";
    }
    cleanLevelDesc = cleanLevelDesc.replace(/\s*\(Target:[^)]+\)/i, "").trim();
    cleanLevelDesc = cleanLevelDesc.replace(/^IOC\s+(?:BUY|TAKE PROFIT|Sell)\s*\[(.*)\]$/i, "$1");
    cleanLevelDesc = cleanLevelDesc.replace(/^IOC\s+(?:BUY|TAKE PROFIT|Sell)\s+/i, "");
    cleanLevelDesc = cleanLevelDesc.replace(/^\[(.*)\]$/, "$1").trim();
    cleanLevelDesc = cleanLevelDesc.replace(/Aggregated\s+(\d+)\s+targets\s+up\s+to\s+Target\s+(\d+)/i, "T1-T$2 ($1x)");
    cleanLevelDesc = cleanLevelDesc.replace(/Aggregated\s+(\d+)\s+tranches/i, "Aggregated ($1x)");

    // Convert legacy "Sell Step X/Y" or "Step X/Y" to clean Target name
    let displayLevelName = cleanLevelDesc;
    if (displayLevelName.toLowerCase().startsWith("sell step") || displayLevelName.toLowerCase().startsWith("step")) {
      if (order.targetPrice && latestGridData?.sellLevels) {
        const matchedIdx = latestGridData.sellLevels.findIndex((p) => Math.abs(p - order.targetPrice) < (order.targetPrice * 0.005));
        if (matchedIdx >= 0) {
          displayLevelName = `Sell Target ${matchedIdx + 1}`;
        }
      }
      if (displayLevelName.toLowerCase().startsWith("sell step") || displayLevelName.toLowerCase().startsWith("step")) {
        displayLevelName = displayLevelName.replace(/(?:Sell\s+)?Step\s+(\d+)\/(\d+)(?:\s*\([^)]+\))?/i, "Sell Target $1");
      }
    }
    // Clean redundant trailing dollar amounts e.g. "Sell Target 2 ($12.64)" -> "Sell Target 2"
    displayLevelName = displayLevelName.replace(/\s*\(\$\d+(?:\.\d+)?\)$/, "").trim();

    // IOC Telemetry badge: compact Target & Limit Sent with true price precision
    const iocBadge = (order.targetPrice !== undefined || order.limitPrice !== undefined)
      ? `<span class="act-ioc-badge" style="padding: 1px 5px; border-radius: 4px; font-size: 9.5px; font-weight: 600; background: rgba(56, 189, 248, 0.12); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.3);" title="IOC Telemetry:&#10;🎯 Target: $${fmtPrice(order.targetPrice || order.price)}&#10;📉 Slippage: ${order.slippagePct !== undefined ? Number(order.slippagePct).toFixed(2) : '0.15'}%&#10;🛑 Sent: $${fmtPrice(order.limitPrice || order.price)}&#10;⚡ Fill: $${fmtPrice(order.price || 0)}">🎯 Target: $${fmtPrice(order.targetPrice || order.price)}${order.limitPrice && Math.abs(order.limitPrice - (order.targetPrice || order.price)) > 0.00001 ? ` (Sent: $${fmtPrice(order.limitPrice)})` : ""}</span>`
      : "";

    // Compact Tx badge: display compact ...3e27 with full hash tooltip
    const txBadge = order.txHash
      ? `<a href="https://explorer.somnia.network/tx/${order.txHash}" target="_blank" rel="noopener noreferrer" class="act-tx-link" title="Somnia Tx: ${order.txHash}">⛓️ ...${order.txHash.slice(-4)}</a>`
      : "";
    const gasBadge = order.gasFeeSomi !== undefined
      ? `<span class="act-gas-badge" title="Gas fee paid for this tx: ${order.gasFeeSomi.toFixed(6)} SOMI">⛽ ${order.gasFeeSomi.toFixed(5)} SOMI</span>`
      : "";
    const compAmount = Number(order.gasCompSomi || order.gasCompBase || 0);
    const gasCompBadge = compAmount > 0
      ? `<span class="act-gas-badge" style="background: rgba(16, 185, 129, 0.15); color: #4ade80; border-color: rgba(16, 185, 129, 0.4);" title="Compensated to Wallet: ${compAmount.toFixed(4)} SOMI (-$${(Number(order.gasLossUsdso || order.gasLossQuote || 0)).toFixed(4)}) | Net Lot: ${(Number(order.netQty || order.qty)).toFixed(4)} SOMI">🛡️ +${compAmount.toFixed(4)} SOMI Gas Ret</span>`
      : "";

    if (order.id) div.setAttribute("data-order-id", String(order.id));
    if (order.orderId) div.setAttribute("data-clob-id", String(order.orderId));
    if (order.txHash) div.setAttribute("data-txhash", String(order.txHash));
    if (order.action) div.setAttribute("data-action", String(order.action));

    div.innerHTML = `
      <div class="act-left">
        <div style="display: flex; align-items: center; gap: 5px; flex-wrap: wrap;">
          <span class="act-badge ${badgeClass}">${badgeText}</span>
          ${displayLevelName ? `<span style="color: #38bdf8; font-size: 11px; font-weight: 700;">${displayLevelName}</span>` : ""}
          <span class="act-price" style="font-weight: 800; font-family: var(--font-mono); font-size: 11.5px;">$${fmtPrice(order.price || 0)}</span>
          ${pnlHtml}
        </div>
        <div style="display: flex; align-items: center; gap: 5px; margin-top: 3px; font-size: 10px; color: #94a3b8; flex-wrap: wrap;">
          <span>${notionalStr ? `${notionalStr} • ` : ""}${qtyStr}</span>
          ${iocBadge}
          ${txBadge}
          ${gasBadge}
          ${gasCompBadge}
        </div>
      </div>
      <div class="act-time">
        ${order.id ? `<button class="feed-item-edit-btn" data-trade-id="${order.id}" title="แก้ไขหรือลบรายการนี้">✏️</button>` : ""}
        <span title="${timeInfo.full}" data-timestamp="${order.time || Date.now()}">${timeInfo.display}</span>
      </div>
    `;
    return div;
  }

  function addOrderActivity(order, isLiveUpdate = false) {
    if (!order) return;
    const isTradeFill = order.status === "FILLED" || (order.status !== "CANCELLED" && order.status !== "OPEN" && ["BUY", "SELL", "BUY_FILL", "SELL_FILL", "CUT", "EXIT", "TAKE_PROFIT", "SNIPE_BUY", "SNIPE_SELL"].includes(order.action));
    const isOnChainAction = order.status === "OPEN" || order.status === "CANCELLED" || ["CREATE_BUY", "CREATE_SELL", "CANCEL_BUY", "CANCEL_SELL"].includes(order.action);

    // Track trade executions on chart
    if (isTradeFill) {
      const exists = rawOrders.some(
        (o) => (order.id && o.id === order.id) || (o.time === order.time && o.action === order.action && o.price === order.price && o.qty === order.qty)
      );
      if (!exists) {
        rawOrders.push(order);
        if (isLiveUpdate) {
          rebuildOrderMarkers();
        }
      }
    }

    if (isLiveUpdate && isTradeFill) {
      showTradeToast(order);
    }

    const strId = order.id ? String(order.id) : (order.orderId ? String(order.orderId) : (order.txHash ? String(order.txHash) : ""));
    const actionKey = order.action ? String(order.action) : "";

    // 1. Insert into Trade Matches Feed
    if (isTradeFill && elTradesFeed) {
      let alreadyInTrades = false;
      if (isLiveUpdate && strId) {
        const query = order.id
          ? `.activity-item[data-order-id="${strId}"]`
          : `.activity-item[data-clob-id="${strId}"][data-action="${actionKey}"], .activity-item[data-txhash="${strId}"][data-action="${actionKey}"]`;
        alreadyInTrades = !!elTradesFeed.querySelector(query);
      }
      if (!alreadyInTrades) {
        const emptyFeed = elTradesFeed.querySelector(".empty-feed");
        if (emptyFeed) emptyFeed.remove();
        elTradesFeed.insertBefore(createActivityElement(order), elTradesFeed.firstChild);
        tradesCount++;
        if (elTradesCount) elTradesCount.textContent = tradesCount;
      }
    }

    // 2. Insert into On-Chain Lifecycle Feed
    if (isOnChainAction && elOnchainFeed) {
      let alreadyInOnchain = false;
      if (isLiveUpdate && strId) {
        const query = `.activity-item[data-clob-id="${strId}"][data-action="${actionKey}"], .activity-item[data-txhash="${strId}"][data-action="${actionKey}"], .activity-item[data-order-id="${strId}"]`;
        alreadyInOnchain = !!elOnchainFeed.querySelector(query);
      }
      if (!alreadyInOnchain) {
        const emptyFeed = elOnchainFeed.querySelector(".empty-feed");
        if (emptyFeed) emptyFeed.remove();
        elOnchainFeed.insertBefore(createActivityElement(order), elOnchainFeed.firstChild);
        onchainCount++;
        if (elOnchainCount) elOnchainCount.textContent = onchainCount;
      }
    }

    // 3. Insert into Combined All Feed
    if (elAllFeed) {
      let alreadyInAll = false;
      if (isLiveUpdate && strId) {
        const query = `.activity-item[data-clob-id="${strId}"][data-action="${actionKey}"], .activity-item[data-txhash="${strId}"][data-action="${actionKey}"], .activity-item[data-order-id="${strId}"]`;
        alreadyInAll = !!elAllFeed.querySelector(query);
      }
      if (!alreadyInAll) {
        const emptyFeed = elAllFeed.querySelector(".empty-feed");
        if (emptyFeed) emptyFeed.remove();
        elAllFeed.insertBefore(createActivityElement(order), elAllFeed.firstChild);
        allCount++;
        if (elOrdersCount) elOrdersCount.textContent = allCount;
      }
    }
  }

  // Periodic ticker to refresh relative timestamps (e.g. "5m ago" -> "6m ago") every 30s
  setInterval(() => {
    document.querySelectorAll(".act-time span[data-timestamp]").forEach((el) => {
      const ts = Number(el.getAttribute("data-timestamp"));
      if (ts) {
        const res = formatActivityTime(ts);
        if (el.textContent !== res.display) {
          el.textContent = res.display;
        }
        if (el.title !== res.full) {
          el.title = res.full;
        }
      }
    });
  }, 30000);

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
        if (data.versionInfo) {
          updateVersionBadge(data.versionInfo);
        }
        if (data.candles && data.candles.length > 0) {
          updateCandles(data.candles);
        } else {
          loadFallbackCandles();
        }
        if (data.htfCandles && data.htfCandles.length > 0) {
          updateHtfCandles(data.htfCandles);
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
          rebuildOrderMarkers();

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
      if (elConnectionText) elConnectionText.textContent = "ออนไลน์";
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

    sse.addEventListener("htf_candles_batch", (e) => {
      try {
        const payload = JSON.parse(e.data);
        if (Array.isArray(payload.candles) && payload.candles.length > 0) {
          updateHtfCandles(payload.candles);
        }
      } catch (err) {
        console.error("Malformed htf_candles_batch event:", err);
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

    sse.addEventListener("htf_candle", (e) => {
      try {
        const payload = JSON.parse(e.data);
        if (payload.candle) updateSingleHtfCandle(payload.candle);
      } catch (err) {
        console.error("Malformed htf_candle event:", err);
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
          removeActivityItem(payload.id);
          if (payload.order && payload.order.status !== "CANCELLED") {
            addOrderActivity(payload.order, false);
          }
          refreshFrontPageState();
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
        if (payload && payload.order) {
          addOrderActivity(payload.order, false);
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

  function updateExchangeFieldsVisibility(exchange) {
    const isDreamdex = exchange === "dreamdex";
    const binanceGroups = document.querySelectorAll(".binance-fields-group");
    const dreamdexGroups = document.querySelectorAll(".dreamdex-fields-group");
    binanceGroups.forEach((el) => {
      el.style.display = isDreamdex ? "none" : "";
    });
    dreamdexGroups.forEach((el) => {
      el.style.display = isDreamdex ? "" : "none";
    });
  }

  function updateSettingsConditionalVisibility() {
    const execMode = document.getElementById("cfg_orderExecutionMode")?.value || "IOC_BRACKET";
    const isIoc = execMode === "IOC_BRACKET";
    const grpIoc = document.getElementById("group_iocSlippage");
    const grpMakerPrice = document.getElementById("group_makerPriceTol");
    const grpMakerQty = document.getElementById("group_makerQtyTol");
    if (grpIoc) grpIoc.style.display = isIoc ? "" : "none";
    if (grpMakerPrice) grpMakerPrice.style.display = isIoc ? "none" : "";
    if (grpMakerQty) grpMakerQty.style.display = isIoc ? "none" : "";

    const useTrueWick = document.getElementById("cfg_useTrueWick")?.checked ?? true;
    const grpWick = document.getElementById("group_wickThreshold");
    if (grpWick) grpWick.style.display = useTrueWick ? "none" : "";

    const narrowEnabled = document.getElementById("cfg_enableNarrowChannelCollapse")?.checked ?? true;
    const grpNarrow = document.getElementById("narrowChannelSubGroup");
    if (grpNarrow) grpNarrow.style.display = narrowEnabled ? "" : "none";

    const squeezeEnabled = document.getElementById("cfg_enableTriangleSqueezeExit")?.checked ?? true;
    const grpSqueeze = document.getElementById("triangleSqueezeSubGroup");
    if (grpSqueeze) grpSqueeze.style.display = squeezeEnabled ? "" : "none";

    const cutLossEnabled = document.getElementById("cfg_cutLossAtLowerBound")?.checked ?? true;
    const grpCutLoss = document.getElementById("cutLossSubGroup");
    if (grpCutLoss) grpCutLoss.style.display = cutLossEnabled ? "" : "none";

    const twoStageEnabled = document.getElementById("cfg_enableTwoStageCutLoss")?.checked ?? true;
    const grpStage2 = document.getElementById("group_stage2Multiplier");
    if (grpStage2) grpStage2.style.display = twoStageEnabled ? "" : "none";

    const stratType = document.getElementById("cfg_strategyType")?.value || "dynamic_grid";
    const tabBtnSwing = document.getElementById("tabBtnSwing");
    if (tabBtnSwing) {
      if (stratType === "swing_trade") {
        tabBtnSwing.textContent = "🏹 5. สวิงเทรด ⭐ (เปิดใช้งาน)";
        tabBtnSwing.style.borderColor = "#6366f1";
        tabBtnSwing.style.color = "#a5b4fc";
      } else {
        tabBtnSwing.textContent = "🏹 5. สวิงเทรด (Swing Trade)";
        tabBtnSwing.style.borderColor = "";
        tabBtnSwing.style.color = "";
      }
    }
    const tabBtnMaFan = document.getElementById("tabBtnMaFan");
    if (tabBtnMaFan) {
      if (stratType === "ma_fan") {
        tabBtnMaFan.textContent = "🪭 6. MA Fan ⭐ (เปิดใช้งาน)";
        tabBtnMaFan.style.borderColor = "#a855f7";
        tabBtnMaFan.style.color = "#c084fc";
      } else {
        tabBtnMaFan.textContent = "🪭 6. MA Fan Sniper";
        tabBtnMaFan.style.borderColor = "";
        tabBtnMaFan.style.color = "";
      }
    }
  }

  [
    "cfg_strategyType",
    "cfg_orderExecutionMode",
    "cfg_useTrueWick",
    "cfg_enableNarrowChannelCollapse",
    "cfg_enableTriangleSqueezeExit",
    "cfg_cutLossAtLowerBound",
    "cfg_enableTwoStageCutLoss",
  ].forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener("change", updateSettingsConditionalVisibility);
    }
  });

  tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      tabBtns.forEach((b) => b.classList.remove("active"));
      tabPanes.forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      const targetId = btn.getAttribute("data-tab");
      const targetPane = document.getElementById(targetId);
      if (targetPane) targetPane.classList.add("active");
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

      const currentExchange = (data.exchange || "binance").toLowerCase();
      const defaultSym = currentExchange === "dreamdex" ? "SOMI:USDSO" : "BTCFDUSD";
      setVal("cfg_symbol", data.symbol || defaultSym);
      setVal("cfg_exchange", data.exchange || "binance");
      setVal("cfg_strategyType", data.strategyType || "dynamic_grid");
      renderTopSymbolOptions(currentExchange, data.symbol || defaultSym);
      updateExchangeFieldsVisibility(currentExchange);
      setVal("cfg_binanceApiKey", data.binanceApiKey || "");
      setVal("cfg_binanceApiSecret", data.binanceApiSecret || "");
      setVal("cfg_binanceBaseUrl", data.binanceBaseUrl || "https://api.binance.com");
      setVal("cfg_binanceWsBase", data.binanceWsBase || "wss://stream.binance.com:9443");
      setVal("cfg_dreamdexPrivateKey", data.dreamdexPrivateKey || "");
      setVal("cfg_dreamdexRpcUrl", data.dreamdexRpcUrl || "https://api.infra.mainnet.somnia.network");
      setVal("cfg_dashboardPort", data.dashboardPort || 3333);
      setCheck("cfg_dryRun", data.dryRun !== false);
      setVal("cfg_maxInventoryUsdso", data.maxInventoryQuote ?? data.maxInventoryUsdso);
      setVal("cfg_intervalMs", data.intervalMs ?? 2000);
      setVal("cfg_floorBufferPct", data.floorBufferPct);
      setVal("cfg_cutLossMaxBidDiscountPct", data.cutLossMaxBidDiscountPct);
      setVal("cfg_orderExpireHours", data.orderExpireHours);
      setCheck("cfg_cutLossAtLowerBound", data.cutLossAtLowerBound);
      setCheck("cfg_cutLossOnBufferOnly", data.cutLossOnBufferOnly !== false);
      setVal("cfg_cutLossBufferDelaySeconds", data.cutLossBufferDelaySeconds ?? 60);
      setCheck("cfg_takeProfitAtUpperBound", data.takeProfitAtUpperBound);
      setVal("cfg_timezone", data.timezone || "Asia/Bangkok");
      setVal("cfg_dowTimeframe", data.dowTimeframe || "15m");
      setVal("cfg_initialCandleCount", data.initialCandleCount ?? 300);
      setVal("cfg_maxCandleCount", data.maxCandleCount ?? 600);
      setVal("cfg_channelMode", data.channelMode);
      setVal("cfg_donchianLookback", data.donchianLookback ?? 48);
      setVal("cfg_minChannelWidthPct", data.minChannelWidthPct);
      setVal("cfg_maxChannelWidthPct", data.maxChannelWidthPct);
      setCheck("cfg_enableNarrowChannelCollapse", data.enableNarrowChannelCollapse !== false);
      setCheck("cfg_adjustChannelOnClosedOnly", data.adjustChannelOnClosedOnly !== false);
      setVal("cfg_narrowChannelThresholdPct", data.narrowChannelThresholdPct ?? 1.2);
      setVal("cfg_narrowChannelBuyBufferPct", data.narrowChannelBuyBufferPct ?? 0.05);
      setVal("cfg_narrowChannelSellBufferPct", data.narrowChannelSellBufferPct ?? 0.05);
      setVal("cfg_srLookbackCandles", data.srLookbackCandles ?? 300);
      setVal("cfg_minChannelShiftPct", data.minChannelShiftPct);
      setVal("cfg_wickThresholdPct", data.wickThresholdPct ?? 20.0);
      setCheck("cfg_useTrueWick", data.useTrueWick !== false);
      setCheck("cfg_dowTrendFilter", data.dowTrendFilter);
      setCheck("cfg_trendlineFilter", data.trendlineFilter);
      setCheck("cfg_enableBuyLevel2Recovery", data.enableBuyLevel2Recovery !== false);
      setCheck("cfg_enableBuyAboveTrendSupport", Boolean(data.enableBuyAboveTrendSupport));
      setCheck("cfg_enableExitOnTrendSupportBreak", data.enableExitOnTrendSupportBreak !== false);
      setCheck("cfg_liquidateOnTrendSupportBreak", Boolean(data.liquidateOnTrendSupportBreak));
      setCheck("cfg_enableExitOnDowntrendRegime", Boolean(data.enableExitOnDowntrendRegime));
      setCheck("cfg_enableSellBelowTrendResistance", data.enableSellBelowTrendResistance !== false);
      setCheck("cfg_enableSellAtRealCeiling", data.enableSellAtRealCeiling !== false);
      setVal("cfg_sellProfitMode", data.sellProfitMode || (data.requireProfitAboveAvgEntry ? "PORTFOLIO_AVG_PROFIT" : "GRID_CASHFLOW"));
      setCheck("cfg_enableTriangleSqueezeExit", data.enableTriangleSqueezeExit !== false);
      setVal("cfg_triangleSqueezeSpreadPct", data.triangleSqueezeSpreadPct ?? 1.5);
      setVal("cfg_minTradeableChannelWidthPct", data.minTradeableChannelWidthPct ?? 2.0);
      setVal("cfg_orderExecutionMode", data.orderExecutionMode || "IOC_BRACKET");
      setVal("cfg_iocSlippagePct", data.iocSlippagePct ?? 0.35);
      setVal("cfg_buySizingMode", data.buySizingMode || "PYRAMID");
      setVal("cfg_minNetProfitPct", data.minNetProfitPct ?? 0.25);
      setVal("cfg_breakevenEscapeProfitPct", data.breakevenEscapeProfitPct ?? 0.06);
      setVal("cfg_maxActiveMakerBuys", data.maxActiveMakerBuys ?? 2);
      setVal("cfg_cutLossStage2Multiplier", data.cutLossStage2Multiplier ?? 2.0);
      setCheck("cfg_enableTwoStageCutLoss", data.enableTwoStageCutLoss !== false);
      setCheck("cfg_enableLhDynamicEscape", data.enableLhDynamicEscape !== false);
      setVal("cfg_stuckTimeoutMinutes", data.stuckTimeoutMs ? Math.round(data.stuckTimeoutMs / 60000) : 0);
      setCheck("cfg_enableBuyBelowSellLevel1", data.enableBuyBelowSellLevel1 !== false);
      setCheck("cfg_enableSellAboveBuyLevel1", data.enableSellAboveBuyLevel1 !== false);
      setVal("cfg_orderPriceTolerancePct", data.orderPriceTolerancePct);
      setVal("cfg_orderQtyTolerancePct", data.orderQtyTolerancePct);
      setVal("cfg_minGasReserveSomi", data.minGasReserveSomi ?? 2.0);

      const buyPcts = Array.isArray(data.buyLevelPcts) && data.buyLevelPcts.length >= 5
        ? data.buyLevelPcts
        : [42, 32, 22, 12, 2];
      setVal("cfg_buy_pct_1", buyPcts[0]);
      setVal("cfg_buy_pct_2", buyPcts[1]);
      setVal("cfg_buy_pct_3", buyPcts[2]);
      setVal("cfg_buy_pct_4", buyPcts[3]);
      setVal("cfg_buy_pct_5", buyPcts[4]);

      const sellPcts = Array.isArray(data.sellLevelPcts) && data.sellLevelPcts.length >= 5
        ? data.sellLevelPcts
        : [52, 62, 72, 82, 92];
      setVal("cfg_sell_pct_1", sellPcts[0]);
      setVal("cfg_sell_pct_2", sellPcts[1]);
      setVal("cfg_sell_pct_3", sellPcts[2]);
      setVal("cfg_sell_pct_4", sellPcts[3]);
      setVal("cfg_sell_pct_5", sellPcts[4]);

      const enabledBuys = Array.isArray(data.enabledBuyLevels) ? data.enabledBuyLevels : [true, true, true, true, true];
      setCheck("cfg_buy_l1", enabledBuys[0] !== false);
      setCheck("cfg_buy_l2", enabledBuys[1] !== false);
      setCheck("cfg_buy_l3", enabledBuys[2] !== false);
      setCheck("cfg_buy_l4", enabledBuys[3] !== false);
      setCheck("cfg_buy_l5", enabledBuys[4] !== false);

      const enabledSells = Array.isArray(data.enabledSellTargets) ? data.enabledSellTargets : [true, true, true, true, true];
      setCheck("cfg_sell_t1", enabledSells[0] !== false);
      setCheck("cfg_sell_t2", enabledSells[1] !== false);
      setCheck("cfg_sell_t3", enabledSells[2] !== false);
      setCheck("cfg_sell_t4", enabledSells[3] !== false);
      setCheck("cfg_sell_t5", enabledSells[4] !== false);

      setVal("cfg_swingMinRiskReward", data.swingMinRiskReward ?? 2.0);
      setVal("cfg_swingStopLossBufferPct", data.swingStopLossBufferPct ?? 0.5);
      setVal("cfg_swingMaxPositionPct", data.swingMaxPositionPct ?? 60.0);
      setVal("cfg_swingTp1CloseRatio", data.swingTp1CloseRatio !== undefined ? Math.round(data.swingTp1CloseRatio * 100) : 50);
      setVal("cfg_swingTp1TargetType", data.swingTp1TargetType || "CENTER_POC");
      setVal("cfg_swingTp2TargetType", data.swingTp2TargetType || "SWING_HIGH_HH");
      setVal("cfg_swingTrailingActivationPct", data.swingTrailingActivationPct ?? 1.5);
      setVal("cfg_swingTrailingPullbackPct", data.swingTrailingPullbackPct ?? 0.8);
      setCheck("cfg_swingEnableHlBaseEntry", data.swingEnableHlBaseEntry !== false);
      setCheck("cfg_swingEnableTrendlineBreakoutEntry", Boolean(data.swingEnableTrendlineBreakoutEntry));
      setCheck("cfg_swingEnableSupportRetestEntry", data.swingEnableSupportRetestEntry !== false);
      setCheck("cfg_swingEnableBearishReversalExit", data.swingEnableBearishReversalExit !== false);
      setVal("cfg_swingBearishReversalMinProfitPct", data.swingBearishReversalMinProfitPct ?? 0.35);

      // MA Fan Sniper settings
      setVal("cfg_maFanExecutionTimeframe", data.maFanExecutionTimeframe || "5m");
      setVal("cfg_maFanSupervisorTimeframe", data.maFanSupervisorTimeframe || "15m");
      setVal("cfg_maFanMaxBudgetUsd", data.maFanMaxBudgetUsd ?? 200);
      setVal("cfg_maFanManualSpreadPct", data.maFanManualSpreadPct ?? 0.40);
      setVal("cfg_maFanAtrMultiplier", data.maFanAtrMultiplier ?? 1.25);
      setCheck("cfg_maFanAutoCalibrateSpreadOnSwitch", data.maFanAutoCalibrateSpreadOnSwitch !== false);
      setCheck("cfg_maFanUseAtrAdaptiveSpread", data.maFanUseAtrAdaptiveSpread !== false);
      setVal("cfg_maFanTp1Ratio", data.maFanTp1Ratio !== undefined ? String(data.maFanTp1Ratio) : "0.5");
      setVal("cfg_maFanTrailingPullbackPct", data.maFanTrailingPullbackPct ?? 0.45);
      setVal("cfg_maFanSlBufferPct", data.maFanSlBufferPct ?? 0.25);
      setVal("cfg_maFanBreakevenFeeBufferPct", data.maFanBreakevenFeeBufferPct ?? 0.05);

      const maColors = getMaFanColors();
      setVal("cfg_maColor4", maColors.c4);
      setVal("cfg_maColor8", maColors.c8);
      setVal("cfg_maColor16", maColors.c16);
      setVal("cfg_maColor25", maColors.c25);
      setVal("cfg_maColor75", maColors.c75);
      setVal("cfg_maColor200", maColors.c200);

      updateGridSimulatorPreview();
      updateSettingsConditionalVisibility();
    } catch (e) {
      console.error("Failed to load settings:", e);
    }
  }

  function updateGridSimulatorPreview() {
    const elFullAvg = document.getElementById("simFullAvgPct");
    const elInnerSpread = document.getElementById("simInnerSpreadPct");
    const elAvgToT1 = document.getElementById("simAvgToT1Pct");
    const elTranchesList = document.getElementById("gridSimTranchesList");
    if (!elFullAvg || !elInnerSpread || !elAvgToT1 || !elTranchesList) return;

    const maxInv = parseFloat(document.getElementById("cfg_maxInventoryUsdso")?.value) || 40;
    const sizingMode = document.getElementById("cfg_buySizingMode")?.value || "PYRAMID";
    const defaultBuys = [42, 32, 22, 12, 2];
    const defaultSells = [52, 62, 72, 82, 92];

    const buyEnabled = [1, 2, 3, 4, 5].map((i) => {
      const el = document.getElementById(`cfg_buy_l${i}`);
      return el ? el.checked : true;
    });
    const buyPcts = [1, 2, 3, 4, 5].map((i, idx) => {
      const el = document.getElementById(`cfg_buy_pct_${i}`);
      const val = el ? parseFloat(el.value) : NaN;
      return Number.isFinite(val) ? val : defaultBuys[idx];
    });
    const sellEnabled = [1, 2, 3, 4, 5].map((i) => {
      const el = document.getElementById(`cfg_sell_t${i}`);
      return el ? el.checked : true;
    });
    const sellPcts = [1, 2, 3, 4, 5].map((i, idx) => {
      const el = document.getElementById(`cfg_sell_pct_${i}`);
      const val = el ? parseFloat(el.value) : NaN;
      return Number.isFinite(val) ? val : defaultSells[idx];
    });

    const rawWeights = sizingMode === "EQUAL" ? [1, 1, 1, 1, 1] : [10, 15, 20, 25, 30];
    const activeWeightSum = rawWeights.reduce((sum, w, idx) => (buyEnabled[idx] ? sum + w : sum), 0);
    const fractions = rawWeights.map((w, idx) => (buyEnabled[idx] && activeWeightSum > 0 ? w / activeWeightSum : 0));

    if (activeWeightSum <= 0) {
      elFullAvg.textContent = "N/A (ปิด Buy ครบ)";
      elInnerSpread.textContent = "-";
      elAvgToT1.textContent = "-";
      elTranchesList.innerHTML = `<span style="color:#f87171;">⚠️ กรุณาเปิดอย่างน้อย 1 Buy Level</span>`;
      return;
    }

    const fullFillAvgPct = fractions.reduce((sum, frac, idx) => sum + frac * buyPcts[idx], 0);
    const firstActiveBuyIdx = buyEnabled.findIndex(Boolean);
    const firstActiveSellIdx = sellEnabled.findIndex(Boolean);
    const firstBuyPct = firstActiveBuyIdx >= 0 ? buyPcts[firstActiveBuyIdx] : 42;
    const firstSellPct = firstActiveSellIdx >= 0 ? sellPcts[firstActiveSellIdx] : 52;
    const innerSpread = firstSellPct - firstBuyPct;
    const avgToT1 = firstSellPct - fullFillAvgPct;

    elFullAvg.textContent = `${fullFillAvgPct.toFixed(1)}% ของกรอบ`;
    elInnerSpread.textContent = `${firstBuyPct}% → ${firstSellPct}% (${innerSpread >= 0 ? "+" : ""}${innerSpread.toFixed(0)}% กรอบ)`;
    elAvgToT1.textContent = `${avgToT1 >= 0 ? "+" : ""}${avgToT1.toFixed(1)}% ของกรอบ`;

    const pills = fractions
      .map((frac, idx) => {
        if (!buyEnabled[idx]) {
          return `<span style="padding: 2px 6px; border-radius: 4px; background: rgba(255,255,255,0.03); color: #64748b; text-decoration: line-through;">L${idx + 1} (${buyPcts[idx]}%): ปิด</span>`;
        }
        const pctWeight = (frac * 100).toFixed(1).replace(/\.0$/, "");
        const quoteAmt = (maxInv * frac).toFixed(2);
        return `<span style="padding: 2px 7px; border-radius: 4px; background: rgba(16, 185, 129, 0.12); border: 1px solid rgba(16, 185, 129, 0.3); color: #a7f3d0;"><b>L${idx + 1} (${buyPcts[idx]}%)</b>: ${pctWeight}% ($${quoteAmt})</span>`;
      })
      .join("");
    elTranchesList.innerHTML = pills;
  }

  [
    "cfg_buySizingMode",
    "cfg_maxInventoryUsdso",
    "cfg_buy_l1", "cfg_buy_l2", "cfg_buy_l3", "cfg_buy_l4", "cfg_buy_l5",
    "cfg_buy_pct_1", "cfg_buy_pct_2", "cfg_buy_pct_3", "cfg_buy_pct_4", "cfg_buy_pct_5",
    "cfg_sell_t1", "cfg_sell_t2", "cfg_sell_t3", "cfg_sell_t4", "cfg_sell_t5",
    "cfg_sell_pct_1", "cfg_sell_pct_2", "cfg_sell_pct_3", "cfg_sell_pct_4", "cfg_sell_pct_5",
  ].forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener("input", updateGridSimulatorPreview);
      el.addEventListener("change", updateGridSimulatorPreview);
    }
  });

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
      strategyType: document.getElementById("cfg_strategyType") ? document.getElementById("cfg_strategyType").value : "dynamic_grid",
      symbol: (() => {
        const customInput = document.getElementById("cfg_symbol_custom");
        if (customInput && customInput.style.display !== "none" && customInput.value.trim()) {
          return customInput.value.trim().toUpperCase().replace(/[\/\-_:]/g, "");
        }
        const sel = document.getElementById("cfg_symbol");
        return sel ? sel.value.trim().toUpperCase() : undefined;
      })(),
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
      intervalMs: parseFloat(document.getElementById("cfg_intervalMs").value),
      floorBufferPct: parseFloat(document.getElementById("cfg_floorBufferPct").value),
      cutLossMaxBidDiscountPct: parseFloat(document.getElementById("cfg_cutLossMaxBidDiscountPct").value),
      orderExpireHours: document.getElementById("cfg_orderExpireHours") ? parseFloat(document.getElementById("cfg_orderExpireHours").value) || 24 : 24,
      cutLossAtLowerBound: document.getElementById("cfg_cutLossAtLowerBound").checked,
      cutLossOnBufferOnly: document.getElementById("cfg_cutLossOnBufferOnly") ? document.getElementById("cfg_cutLossOnBufferOnly").checked : true,
      cutLossBufferDelaySeconds: document.getElementById("cfg_cutLossBufferDelaySeconds") ? parseFloat(document.getElementById("cfg_cutLossBufferDelaySeconds").value) || 0 : 60,
      takeProfitAtUpperBound: document.getElementById("cfg_takeProfitAtUpperBound").checked,
      timezone: document.getElementById("cfg_timezone").value || "Asia/Bangkok",
      dowTimeframe: document.getElementById("cfg_dowTimeframe").value || "15m",
      initialCandleCount: parseInt(document.getElementById("cfg_initialCandleCount").value, 10) || 300,
      maxCandleCount: parseInt(document.getElementById("cfg_maxCandleCount").value, 10) || 600,
      channelMode: document.getElementById("cfg_channelMode").value,
      donchianLookback: document.getElementById("cfg_donchianLookback") ? (parseInt(document.getElementById("cfg_donchianLookback").value, 10) || 48) : 48,
      minChannelWidthPct: parseFloat(document.getElementById("cfg_minChannelWidthPct").value),
      maxChannelWidthPct: parseFloat(document.getElementById("cfg_maxChannelWidthPct").value),
      enableNarrowChannelCollapse: document.getElementById("cfg_enableNarrowChannelCollapse") ? document.getElementById("cfg_enableNarrowChannelCollapse").checked : true,
      adjustChannelOnClosedOnly: document.getElementById("cfg_adjustChannelOnClosedOnly") ? document.getElementById("cfg_adjustChannelOnClosedOnly").checked : true,
      narrowChannelThresholdPct: document.getElementById("cfg_narrowChannelThresholdPct") ? parseFloat(document.getElementById("cfg_narrowChannelThresholdPct").value) : 1.2,
      narrowChannelBuyBufferPct: document.getElementById("cfg_narrowChannelBuyBufferPct") ? parseFloat(document.getElementById("cfg_narrowChannelBuyBufferPct").value) : 0.05,
      narrowChannelSellBufferPct: document.getElementById("cfg_narrowChannelSellBufferPct") ? parseFloat(document.getElementById("cfg_narrowChannelSellBufferPct").value) : 0.05,
      srLookbackCandles: parseInt(document.getElementById("cfg_srLookbackCandles").value, 10) || 300,
      minChannelShiftPct: parseFloat(document.getElementById("cfg_minChannelShiftPct").value),
      wickThresholdPct: parseFloat(document.getElementById("cfg_wickThresholdPct").value),
      useTrueWick: document.getElementById("cfg_useTrueWick").checked,
      dowTrendFilter: document.getElementById("cfg_dowTrendFilter").checked,
      trendlineFilter: document.getElementById("cfg_trendlineFilter").checked,
      enableBuyLevel2Recovery: document.getElementById("cfg_enableBuyLevel2Recovery").checked,
      enableBuyAboveTrendSupport: document.getElementById("cfg_enableBuyAboveTrendSupport").checked,
      enableExitOnTrendSupportBreak: document.getElementById("cfg_enableExitOnTrendSupportBreak").checked,
      liquidateOnTrendSupportBreak: Boolean(document.getElementById("cfg_liquidateOnTrendSupportBreak")?.checked),
      enableExitOnDowntrendRegime: Boolean(document.getElementById("cfg_enableExitOnDowntrendRegime")?.checked),
      enableSellBelowTrendResistance: document.getElementById("cfg_enableSellBelowTrendResistance").checked,
      enableSellAtRealCeiling: document.getElementById("cfg_enableSellAtRealCeiling").checked,
      sellProfitMode: document.getElementById("cfg_sellProfitMode").value,
      enableTriangleSqueezeExit: document.getElementById("cfg_enableTriangleSqueezeExit").checked,
      triangleSqueezeSpreadPct: parseFloat(document.getElementById("cfg_triangleSqueezeSpreadPct").value),
      minTradeableChannelWidthPct: parseFloat(document.getElementById("cfg_minTradeableChannelWidthPct").value),
      orderExecutionMode: document.getElementById("cfg_orderExecutionMode").value,
      iocSlippagePct: parseFloat(document.getElementById("cfg_iocSlippagePct").value) || 0.35,
      buySizingMode: document.getElementById("cfg_buySizingMode") ? document.getElementById("cfg_buySizingMode").value : "PYRAMID",
      minNetProfitPct: document.getElementById("cfg_minNetProfitPct") ? parseFloat(document.getElementById("cfg_minNetProfitPct").value) || 0.25 : 0.25,
      breakevenEscapeProfitPct: document.getElementById("cfg_breakevenEscapeProfitPct") ? parseFloat(document.getElementById("cfg_breakevenEscapeProfitPct").value) || 0.06 : 0.06,
      maxActiveMakerBuys: document.getElementById("cfg_maxActiveMakerBuys") ? parseInt(document.getElementById("cfg_maxActiveMakerBuys").value, 10) || 2 : 2,
      cutLossStage2Multiplier: document.getElementById("cfg_cutLossStage2Multiplier") ? parseFloat(document.getElementById("cfg_cutLossStage2Multiplier").value) || 2.0 : 2.0,
      enableTwoStageCutLoss: document.getElementById("cfg_enableTwoStageCutLoss") ? document.getElementById("cfg_enableTwoStageCutLoss").checked : true,
      enableLhDynamicEscape: document.getElementById("cfg_enableLhDynamicEscape") ? document.getElementById("cfg_enableLhDynamicEscape").checked : true,
      stuckTimeoutMs: (parseFloat(document.getElementById("cfg_stuckTimeoutMinutes").value) || 0) * 60_000,
      enableBuyBelowSellLevel1: document.getElementById("cfg_enableBuyBelowSellLevel1").checked,
      enableSellAboveBuyLevel1: document.getElementById("cfg_enableSellAboveBuyLevel1").checked,
      orderPriceTolerancePct: parseFloat(document.getElementById("cfg_orderPriceTolerancePct").value),
      orderQtyTolerancePct: parseFloat(document.getElementById("cfg_orderQtyTolerancePct").value),
      minGasReserveSomi: document.getElementById("cfg_minGasReserveSomi") ? parseFloat(document.getElementById("cfg_minGasReserveSomi").value) : 0,
      buyLevelPcts: [
        parseFloat(document.getElementById("cfg_buy_pct_1") ? document.getElementById("cfg_buy_pct_1").value : 42) || 42,
        parseFloat(document.getElementById("cfg_buy_pct_2") ? document.getElementById("cfg_buy_pct_2").value : 32) || 32,
        parseFloat(document.getElementById("cfg_buy_pct_3") ? document.getElementById("cfg_buy_pct_3").value : 22) || 22,
        parseFloat(document.getElementById("cfg_buy_pct_4") ? document.getElementById("cfg_buy_pct_4").value : 12) || 12,
        parseFloat(document.getElementById("cfg_buy_pct_5") ? document.getElementById("cfg_buy_pct_5").value : 2) || 2,
      ],
      sellLevelPcts: [
        parseFloat(document.getElementById("cfg_sell_pct_1") ? document.getElementById("cfg_sell_pct_1").value : 52) || 52,
        parseFloat(document.getElementById("cfg_sell_pct_2") ? document.getElementById("cfg_sell_pct_2").value : 62) || 62,
        parseFloat(document.getElementById("cfg_sell_pct_3") ? document.getElementById("cfg_sell_pct_3").value : 72) || 72,
        parseFloat(document.getElementById("cfg_sell_pct_4") ? document.getElementById("cfg_sell_pct_4").value : 82) || 82,
        parseFloat(document.getElementById("cfg_sell_pct_5") ? document.getElementById("cfg_sell_pct_5").value : 92) || 92,
      ],
      enabledBuyLevels: [
        document.getElementById("cfg_buy_l1") ? document.getElementById("cfg_buy_l1").checked : true,
        document.getElementById("cfg_buy_l2") ? document.getElementById("cfg_buy_l2").checked : true,
        document.getElementById("cfg_buy_l3") ? document.getElementById("cfg_buy_l3").checked : true,
        document.getElementById("cfg_buy_l4") ? document.getElementById("cfg_buy_l4").checked : true,
        document.getElementById("cfg_buy_l5") ? document.getElementById("cfg_buy_l5").checked : true,
      ],
      enabledSellTargets: [
        document.getElementById("cfg_sell_t1") ? document.getElementById("cfg_sell_t1").checked : true,
        document.getElementById("cfg_sell_t2") ? document.getElementById("cfg_sell_t2").checked : true,
        document.getElementById("cfg_sell_t3") ? document.getElementById("cfg_sell_t3").checked : true,
        document.getElementById("cfg_sell_t4") ? document.getElementById("cfg_sell_t4").checked : true,
        document.getElementById("cfg_sell_t5") ? document.getElementById("cfg_sell_t5").checked : true,
      ],
      swingMinRiskReward: parseFloat(document.getElementById("cfg_swingMinRiskReward")?.value) || 2.0,
      swingStopLossBufferPct: parseFloat(document.getElementById("cfg_swingStopLossBufferPct")?.value) || 0.5,
      swingMaxPositionPct: parseFloat(document.getElementById("cfg_swingMaxPositionPct")?.value) || 60.0,
      swingTp1CloseRatio: (parseFloat(document.getElementById("cfg_swingTp1CloseRatio")?.value) || 50) / 100,
      swingTp1TargetType: document.getElementById("cfg_swingTp1TargetType")?.value || "CENTER_POC",
      swingTp2TargetType: document.getElementById("cfg_swingTp2TargetType")?.value || "SWING_HIGH_HH",
      swingTrailingActivationPct: parseFloat(document.getElementById("cfg_swingTrailingActivationPct")?.value) || 1.5,
      swingTrailingPullbackPct: parseFloat(document.getElementById("cfg_swingTrailingPullbackPct")?.value) || 0.8,
      swingEnableHlBaseEntry: document.getElementById("cfg_swingEnableHlBaseEntry") ? document.getElementById("cfg_swingEnableHlBaseEntry").checked : true,
      swingEnableTrendlineBreakoutEntry: document.getElementById("cfg_swingEnableTrendlineBreakoutEntry") ? document.getElementById("cfg_swingEnableTrendlineBreakoutEntry").checked : false,
      swingEnableSupportRetestEntry: document.getElementById("cfg_swingEnableSupportRetestEntry") ? document.getElementById("cfg_swingEnableSupportRetestEntry").checked : true,
      swingEnableBearishReversalExit: document.getElementById("cfg_swingEnableBearishReversalExit") ? document.getElementById("cfg_swingEnableBearishReversalExit").checked : true,
      swingBearishReversalMinProfitPct: parseFloat(document.getElementById("cfg_swingBearishReversalMinProfitPct")?.value) || 0.35,

      // MA Fan Strategy
      maFanExecutionTimeframe: document.getElementById("cfg_maFanExecutionTimeframe") ? document.getElementById("cfg_maFanExecutionTimeframe").value : "5m",
      maFanSupervisorTimeframe: document.getElementById("cfg_maFanSupervisorTimeframe") ? document.getElementById("cfg_maFanSupervisorTimeframe").value : "15m",
      maFanMaxBudgetUsd: parseFloat(document.getElementById("cfg_maFanMaxBudgetUsd")?.value) || 200,
      maFanManualSpreadPct: parseFloat(document.getElementById("cfg_maFanManualSpreadPct")?.value) || 0.40,
      maFanAtrMultiplier: parseFloat(document.getElementById("cfg_maFanAtrMultiplier")?.value) || 1.25,
      maFanAutoCalibrateSpreadOnSwitch: Boolean(document.getElementById("cfg_maFanAutoCalibrateSpreadOnSwitch")?.checked),
      maFanUseAtrAdaptiveSpread: Boolean(document.getElementById("cfg_maFanUseAtrAdaptiveSpread")?.checked),
      maFanTp1Ratio: parseFloat(document.getElementById("cfg_maFanTp1Ratio")?.value) || 0.5,
      maFanTrailingPullbackPct: parseFloat(document.getElementById("cfg_maFanTrailingPullbackPct")?.value) || 0.45,
      maFanSlBufferPct: parseFloat(document.getElementById("cfg_maFanSlBufferPct")?.value) || 0.25,
      maFanBreakevenFeeBufferPct: parseFloat(document.getElementById("cfg_maFanBreakevenFeeBufferPct")?.value) || 0.05,
    };

    const newMaColors = {
      c4: document.getElementById("cfg_maColor4")?.value || "#38bdf8",
      c8: document.getElementById("cfg_maColor8")?.value || "#0284c7",
      c16: document.getElementById("cfg_maColor16")?.value || "#3b82f6",
      c25: document.getElementById("cfg_maColor25")?.value || "#f59e0b",
      c75: document.getElementById("cfg_maColor75")?.value || "#a855f7",
      c200: document.getElementById("cfg_maColor200")?.value || "#f43f5e",
    };
    try {
      localStorage.setItem("ma_fan_colors", JSON.stringify(newMaColors));
    } catch (_) {}
    applyMaFanColors(newMaColors);

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

  // Live preview for MA Fan color picker inputs
  ["4", "8", "16", "25", "75", "200"].forEach((p) => {
    const el = document.getElementById(`cfg_maColor${p}`);
    if (el) {
      el.addEventListener("input", () => {
        const colors = {
          c4: document.getElementById("cfg_maColor4")?.value || "#38bdf8",
          c8: document.getElementById("cfg_maColor8")?.value || "#0284c7",
          c16: document.getElementById("cfg_maColor16")?.value || "#3b82f6",
          c25: document.getElementById("cfg_maColor25")?.value || "#f59e0b",
          c75: document.getElementById("cfg_maColor75")?.value || "#a855f7",
          c200: document.getElementById("cfg_maColor200")?.value || "#f43f5e",
        };
        applyMaFanColors(colors);
      });
    }
  });

  const cachedExchangeSymbols = {
    binance: null,
    dreamdex: null,
  };

  async function renderTopSymbolOptions(exchange, currentSymbol) {
    const elTopSymbolSelect = document.getElementById("topSymbolSelect");
    const elCfgSymbol = document.getElementById("cfg_symbol");
    const isDreamdex = exchange === "dreamdex";
    const normCur = (currentSymbol || "").toUpperCase().replace(/[\/\-_:]/g, "");

    // 1. Initial Quick Render (Fallback options while loading)
    const dreamdexInitial = `
      <option value="SOMI">SOMI (SOMI/USDso)</option>
      <option value="SOMI:USDSO">SOMI:USDso</option>
      <option value="USDC.E:USDSO">USDC.e:USDso</option>
      <option value="WBTC:USDSO">WBTC:USDso</option>
      <option value="WETH:USDSO">WETH:USDso</option>
      <option value="__custom__">➕ Custom Symbol (พิมพ์เอง)...</option>
    `;
    const binanceInitial = `
      <optgroup label="🆓 FDUSD Pairs (0% Maker Fee)">
        <option value="BTCFDUSD">BTC/FDUSD</option>
        <option value="ETHFDUSD">ETH/FDUSD</option>
        <option value="SOLFDUSD">SOL/FDUSD</option>
        <option value="BNBFDUSD">BNB/FDUSD</option>
        <option value="DOGEFDUSD">DOGE/FDUSD</option>
        <option value="XRPFDUSD">XRP/FDUSD</option>
        <option value="SUIFDUSD">SUI/FDUSD</option>
      </optgroup>
      <optgroup label="⭐ Popular USDT Pairs">
        <option value="BTCUSDT">BTC/USDT</option>
        <option value="ETHUSDT">ETH/USDT</option>
        <option value="SOLUSDT">SOL/USDT</option>
        <option value="BNBUSDT">BNB/USDT</option>
        <option value="DOGEUSDT">DOGE/USDT</option>
        <option value="XRPUSDT">XRP/USDT</option>
        <option value="SUIUSDT">SUI/USDT</option>
        <option value="PEPEUSDT">PEPE/USDT</option>
      </optgroup>
      <option value="__custom__">➕ Custom Pair (พิมพ์คู่เหรียญเอง)...</option>
    `;

    function applyHtml(html) {
      if (elTopSymbolSelect) {
        elTopSymbolSelect.innerHTML = html;
        if (normCur) {
          elTopSymbolSelect.value = normCur;
          if (!elTopSymbolSelect.value) {
            elTopSymbolSelect.value = (currentSymbol || "").toUpperCase();
          }
        }
      }
      const topSearchInput = document.getElementById("topSymbolSearchInput");
      if (topSearchInput && normCur) {
        topSearchInput.value = normCur;
      }
      if (elCfgSymbol) {
        elCfgSymbol.innerHTML = html;
        if (normCur) {
          elCfgSymbol.value = normCur;
          if (!elCfgSymbol.value) {
            elCfgSymbol.value = (currentSymbol || "").toUpperCase();
          }
        }
      }
    }

    applyHtml(isDreamdex ? dreamdexInitial : binanceInitial);

    const lblSymbol = document.getElementById("lbl_symbol");
    if (lblSymbol) {
      lblSymbol.innerHTML = isDreamdex
        ? `DreamDEX Trading Pair (Symbol) <span class="help-tip" title="Choose or enter DreamDEX pair (e.g. SOMI, SOMI:USDso, WETH:USDso, WBTC:USDso)">ℹ️</span>`
        : `Binance Trading Pair (Symbol) <span class="help-tip" title="Choose from Binance list or type custom pair (e.g. BTCFDUSD, ETHFDUSD, SOLUSDT)">ℹ️</span>`;
    }

    // 2. Fetch full dynamic symbols list from backend
    try {
      const cacheKey = isDreamdex ? "dreamdex" : "binance";
      let symData = cachedExchangeSymbols[cacheKey];
      if (!symData) {
        const resp = await fetch(`${API_BASE}/api/symbols?exchange=${cacheKey}`);
        if (resp.ok) {
          symData = await resp.json();
          cachedExchangeSymbols[cacheKey] = symData;
        }
      }

      if (symData) {
        let fullHtml = "";
        if (isDreamdex) {
          const syms = Array.isArray(symData.symbols) ? symData.symbols : ["SOMI", "SOMI:USDSO", "USDC.E:USDSO", "WBTC:USDSO", "WETH:USDSO"];
          fullHtml = syms.map((s) => `<option value="${s}">${s}</option>`).join("") + `<option value="__custom__">➕ Custom Symbol (พิมพ์เอง)...</option>`;
        } else {
          const fdusd = Array.isArray(symData.fdusd) ? symData.fdusd : [];
          const popular = Array.isArray(symData.popular) ? symData.popular : [];
          const usdt = Array.isArray(symData.usdt) ? symData.usdt : [];
          const usdc = Array.isArray(symData.usdc) ? symData.usdc : [];

          // If currentSymbol is not in popular or fdusd, prepend an option for it
          let currentOptionHtml = "";
          if (normCur && !popular.includes(normCur) && !fdusd.includes(normCur) && !usdt.includes(normCur)) {
            currentOptionHtml = `<option value="${normCur}">📍 ${currentSymbol} (Current)</option>`;
          }

          const fdusdOptions = fdusd.map((s) => `<option value="${s}">${s.replace("FDUSD", "/FDUSD")}</option>`).join("");
          const popOptions = popular.filter((s) => !s.endsWith("FDUSD")).map((s) => `<option value="${s}">${s.replace("USDT", "/USDT")}</option>`).join("");
          const otherUsdt = usdt.filter((s) => !popular.includes(s));
          const otherUsdtOptions = otherUsdt.map((s) => `<option value="${s}">${s.replace("USDT", "/USDT")}</option>`).join("");
          const usdcOptions = usdc.map((s) => `<option value="${s}">${s.replace("USDC", "/USDC")}</option>`).join("");

          fullHtml = `
            ${currentOptionHtml}
            <optgroup label="🆓 FDUSD Pairs (0% Maker Fee)">
              ${fdusdOptions}
            </optgroup>
            <optgroup label="⭐ Popular USDT Pairs">
              ${popOptions}
            </optgroup>
            ${otherUsdtOptions ? `<optgroup label="💵 Other USDT Pairs">${otherUsdtOptions}</optgroup>` : ""}
            ${usdcOptions ? `<optgroup label="🪙 USDC Pairs">${usdcOptions}</optgroup>` : ""}
            <option value="__custom__">➕ Custom Pair (พิมพ์คู่เหรียญเอง)...</option>
          `;
        }
        applyHtml(fullHtml);

        const elTopDatalist = document.getElementById("topSymbolDatalist");
        if (elTopDatalist) {
          const allSyms = isDreamdex
            ? (Array.isArray(symData.symbols) ? symData.symbols : ["SOMI", "SOMI:USDSO", "USDC.E:USDSO", "WBTC:USDSO", "WETH:USDSO"])
            : (Array.isArray(symData.symbols) ? symData.symbols : []);
          elTopDatalist.innerHTML = allSyms.map((s) => `<option value="${s}">${s}</option>`).join("");
        }
      }
    } catch (err) {
      console.warn("Failed to load dynamic symbols:", err);
    }
  }

  const elCfgExchange = document.getElementById("cfg_exchange");
  if (elCfgExchange) {
    elCfgExchange.addEventListener("change", (e) => {
      const selectedExchange = (e.target.value || "binance").toLowerCase();
      updateExchangeFieldsVisibility(selectedExchange);
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
      if (isHoldingActivePosition) {
        showToast({
          title: "PAIR SWITCH BLOCKED",
          desc: "บอทกำลังถือ Position อยู่ ไม่สามารถสลับคู่เหรียญได้ (กรุณา Take Profit หรือ Cut Loss ก่อน)",
          action: "ALERT",
        });
        const navPill = document.getElementById("navSymbolBadge");
        if (navPill) elTopSymbolSelect.value = navPill.textContent.replace(/[\/\s]/g, "");
        return;
      }

      let newSym = e.target.value;
      if (!newSym) return;

      if (newSym === "__custom__") {
        const entered = prompt("กรอกชื่อคู่เหรียญที่ต้องการเทรด (เช่น BTCFDUSD, SOLFDUSD, DOGEFDUSD):");
        if (!entered || !entered.trim()) {
          const navPill = document.getElementById("navSymbolBadge");
          const isDEX = document.getElementById("logoBadge")?.textContent?.includes("DREAMDEX");
          const fallbackSym = isDEX ? "SOMI:USDSO" : "BTCFDUSD";
          elTopSymbolSelect.value = navPill ? navPill.textContent.replace(/[\/\s]/g, "") : fallbackSym;
          return;
        }
        newSym = entered.trim().toUpperCase().replace(/[\/\-_:]/g, "");
      }

      window.__isSwitchingSymbolUI = true;
      elTopSymbolSelect.disabled = true;
      showToast({
        title: "⏳ SWITCHING TRADING PAIR",
        desc: `กำลังยกเลิกออเดอร์คู่เดิม บันทึก Config และสลับกราฟเป็น ${newSym}...`,
        action: "SETTINGS",
      });

      try {
        const res = await fetch(`${API_BASE}/api/db/settings`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ symbol: newSym }),
        });
        if (res.ok) {
          const respData = await res.json().catch(() => ({}));
          const savedSym = (respData.settings && respData.settings.symbol) || newSym;
          showToast({
            title: "✅ SYMBOL CHANGED",
            desc: `ยกเลิกออเดอร์คู่เดิม บันทึก Config และสลับคู่เทรดเป็น ${savedSym} เรียบร้อยแล้ว`,
            action: "SETTINGS",
          });
          const navPill = document.getElementById("navSymbolBadge");
          if (navPill) navPill.textContent = savedSym;
          const cfgSym = document.getElementById("cfg_symbol");
          if (cfgSym) cfgSym.value = savedSym;
          elTopSymbolSelect.value = savedSym;
          await refreshFrontPageState();
        } else {
          const errData = await res.json().catch(() => ({}));
          showToast({
            title: "SYMBOL ERROR",
            desc: errData.error || `Failed to switch pair to ${newSym}`,
            action: "ALERT",
          });
          const navPill = document.getElementById("navSymbolBadge");
          if (navPill) elTopSymbolSelect.value = navPill.textContent.replace(/[\/\s]/g, "");
        }
      } catch (err) {
        console.error("Failed to switch symbol:", err);
      } finally {
        window.__isSwitchingSymbolUI = false;
        elTopSymbolSelect.disabled = isHoldingActivePosition;
      }
    });
  }

  // Top symbol search input listener (typing & datalist)
  const elTopSymbolSearch = document.getElementById("topSymbolSearchInput");
  if (elTopSymbolSearch && elTopSymbolSelect) {
    elTopSymbolSearch.addEventListener("change", (e) => {
      const val = (e.target.value || "").trim().toUpperCase().replace(/[\/\-_:]/g, "");
      if (!val) return;
      let matched = false;
      for (const opt of elTopSymbolSelect.options) {
        if (opt.value.toUpperCase().replace(/[\/\-_:]/g, "") === val) {
          elTopSymbolSelect.value = opt.value;
          matched = true;
          break;
        }
      }
      if (!matched) {
        const newOpt = document.createElement("option");
        newOpt.value = val;
        newOpt.textContent = val;
        elTopSymbolSelect.appendChild(newOpt);
        elTopSymbolSelect.value = val;
      }
      elTopSymbolSelect.dispatchEvent(new Event("change"));
    });
  }

  // Quick live filter for Settings modal cfg_symbol
  const elCfgSymbolFilter = document.getElementById("cfg_symbol_filter");
  const elCfgSymbolDropdown = document.getElementById("cfg_symbol");
  if (elCfgSymbolFilter && elCfgSymbolDropdown) {
    elCfgSymbolFilter.addEventListener("input", (e) => {
      const query = (e.target.value || "").trim().toUpperCase();
      let firstMatch = null;
      for (const opt of elCfgSymbolDropdown.options) {
        if (opt.value === "__custom__") continue;
        const text = (opt.textContent || "").toUpperCase();
        const val = (opt.value || "").toUpperCase();
        const matches = !query || val.includes(query) || text.includes(query);
        opt.style.display = matches ? "" : "none";
        if (matches && !firstMatch) firstMatch = opt;
      }
      if (query && firstMatch) {
        elCfgSymbolDropdown.value = firstMatch.value;
      }
    });
  }

  // Toggle button for custom symbol input in Settings modal
  const btnToggleCustom = document.getElementById("btnToggleCustomSymbol");
  const cfgSymbolSelect = document.getElementById("cfg_symbol");
  const cfgSymbolCustom = document.getElementById("cfg_symbol_custom");
  if (btnToggleCustom && cfgSymbolSelect && cfgSymbolCustom) {
    btnToggleCustom.addEventListener("click", () => {
      const isCustom = cfgSymbolCustom.style.display !== "none";
      if (isCustom) {
        cfgSymbolCustom.style.display = "none";
        cfgSymbolSelect.style.display = "";
        btnToggleCustom.textContent = "✏️ พิมพ์เอง";
      } else {
        cfgSymbolCustom.style.display = "";
        cfgSymbolSelect.style.display = "none";
        cfgSymbolCustom.value = cfgSymbolSelect.value || "";
        cfgSymbolCustom.focus();
        btnToggleCustom.textContent = "📋 เลือกจากรายการ";
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

  const elBtnSellAll = document.getElementById("btnSellAll");
  if (elBtnSellAll) {
    elBtnSellAll.addEventListener("click", async () => {
      const ok = confirm(`💥 Emergency Sell All: ขายเหรียญทั้งหมดทันที?\n\nคำสั่งนี้จะยกเลิกออเดอร์ค้างทั้งหมด และส่งคำสั่งขายเหรียญ ${activeBaseAsset} ใน Position ทั้งหมดออกทันทีที่ราคาตลาด (IOC/Market Exit) พร้อมทั้งหยุดการทำงานของบอทชั่วคราว (Pause)\n\nต้องการดำเนินการต่อหรือไม่?`);
      if (!ok) return;
      try {
        elBtnSellAll.disabled = true;
        elBtnSellAll.textContent = "Selling All...";
        const res = await fetch("/api/bot/sell-all", { method: "POST" });
        const data = await res.json();
        if (data.success) {
          alert(`✅ ขายเหรียญทั้งหมดสำเร็จ!\nจำนวน: ${data.soldQty} ${activeBaseAsset}\nราคา: $${data.price}\n\n(บอทได้ถูกสลับเป็นสถานะ Pause เรียบร้อยแล้ว)`);
          checkBotPauseStatus();
          refreshFrontPageState();
        } else {
          alert("❌ ไม่สามารถขายได้: " + (data.error || "Unknown error"));
        }
      } catch (err) {
        alert("❌ Error: " + (err?.message || err));
      } finally {
        elBtnSellAll.disabled = false;
        elBtnSellAll.innerHTML = '<span class="btn-icon">💥</span><span>Sell All</span>';
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
  const elTmBtnReconcilePnl = document.getElementById("tmBtnReconcilePnl");
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
      const symParam = encodeURIComponent(activeSymbol || activeBaseAsset || "");
      const res = await fetch(`${API_BASE}/api/db/trade-manager?symbol=${symParam}`);
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

        const baseSymbol = o.baseAsset || (o.symbol ? o.symbol.split(/[:\-_]/)[0] : activeBaseAsset) || "BASE";
        const priceStr = `$${Number(o.price || 0).toFixed(5)}`;
        const qtyStr = `${Number(o.quantity || o.qty || 0).toFixed(4)} ${baseSymbol}`;
        const notionalStr = `$${(Number(o.notionalUsdso) || Number(o.price || 0) * Number(o.quantity || o.qty || 0)).toFixed(2)}`;

        const hasIoc = Boolean(o.isIoc || o.targetPrice !== undefined || o.limitPrice !== undefined);
        const iocSubText = (o.targetPrice !== undefined || o.limitPrice !== undefined)
          ? `<div style="font-size: 10px; color: #38bdf8; font-weight: normal; margin-top: 2px;" title="IOC Telemetry:&#10;Target: $${o.targetPrice}&#10;Slippage: ${o.slippagePct ?? 0.2}%&#10;Limit Sent: $${o.limitPrice}&#10;Executed Fill: $${o.price}">🎯 T: $${Number(o.targetPrice || o.price).toFixed(4)} (Slip ${o.slippagePct ?? 0.2}%)</div>`
          : (hasIoc ? `<div style="font-size: 10px; color: #38bdf8; font-weight: normal; margin-top: 2px;">⚡ IOC</div>` : "");

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
          <td style="text-align: right; color: #fff; font-weight: 600;">${priceStr}${iocSubText}</td>
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
    if (elTmSummaryLotsQty) elTmSummaryLotsQty.textContent = `${fmtQty(totalQty)} ${activeBaseAsset}`;
    if (elTmSummaryLotsAvgPrice) elTmSummaryLotsAvgPrice.textContent = `$${fmtPrice(avgPrice)}`;

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
              <span class="tm-lot-val" style="color: #4ade80;">$${fmtPrice(p)}</span>
            </div>
            <div class="tm-lot-field">
              <span class="tm-lot-label">Quantity (จำนวน)</span>
              <span class="tm-lot-val" style="color: #38bdf8;">${fmtQty(q)} ${activeBaseAsset}</span>
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
      const symParam = encodeURIComponent(activeSymbol || activeBaseAsset || "");
      const res = await fetch(`${API_BASE}/api/db/rounds?symbol=${symParam}`);
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
            <div class="round-buy-val">${fmtQty(r.buyQty)} ${activeBaseAsset}</div>
            <span class="round-dim-info">$${buyCost.toFixed(2)} @ $${fmtPrice(r.avgBuyPrice)} (${r.buyCount} ไม้)</span>
          </td>
          <td style="text-align: right;">
            <div class="round-sell-val">${fmtQty(r.sellQty)} ${activeBaseAsset}</div>
            <span class="round-dim-info">$${sellProceeds.toFixed(2)} @ $${fmtPrice(r.avgSellPrice)} (${r.sellCount} ไม้)</span>
          </td>
          <td style="text-align: right;">
            <span style="font-weight: 600; ${r.holdingQty > 0.0001 ? "color: #38bdf8;" : "color: #64748b;"}">
              ${fmtQty(r.holdingQty)} ${activeBaseAsset}
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
                    <span>รวม: $${buyCost.toFixed(2)} ${activeQuoteAsset} (${fmtQty(r.buyQty)} ${activeBaseAsset})</span>
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
                          <td style="text-align: right; color: #34d399;">$${fmtPrice(b.price)}</td>
                          <td style="text-align: right;">${fmtQty(b.qty)}</td>
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
                    <span>รวม: $${sellProceeds.toFixed(2)} ${activeQuoteAsset} (${fmtQty(r.sellQty)} ${activeBaseAsset})</span>
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
                          <td style="text-align: right; color: #fb923c;">$${fmtPrice(s.price)}</td>
                          <td style="text-align: right;">${fmtQty(s.qty)}</td>
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
          symbol: activeSymbol || activeBaseAsset,
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
        addOrderActivity(data.order, false);
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
        body: JSON.stringify({ symbol: activeSymbol || activeBaseAsset, index, lot: { price, qty, time } }),
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
        body: JSON.stringify({ symbol: activeSymbol || activeBaseAsset, index }),
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
        body: JSON.stringify({ symbol: activeSymbol || activeBaseAsset, lot: { price, qty, time: Date.now() } }),
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
  if (elLotsCount) elLotsCount.addEventListener("click", () => openTradeManager("tmTabLots"));

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
  if (elTmBtnReconcilePnl) {
    elTmBtnReconcilePnl.addEventListener("click", async () => {
      const origText = elTmBtnReconcilePnl.innerHTML;
      try {
        elTmBtnReconcilePnl.disabled = true;
        elTmBtnReconcilePnl.innerHTML = "<span>⏳ กำลังซิงค์...</span>";
        const res = await fetch(`${API_BASE}/api/db/trades/reconcile-pnl`, { method: "POST" });
        const data = await res.json();
        if (data.success) {
          await refreshFrontPageState();
          loadTradeManagerData();
          showToast({
            title: "REALIZED PNL SYNCED",
            desc: `ซิงค์ PnL สำเร็จ ${data.added !== 0 ? `(ปรับยอด ${data.added >= 0 ? "+" : ""}$${Number(data.added).toFixed(4)})` : "(ยอดตรงกันอยู่แล้ว)"}`,
            action: "TAKE_PROFIT",
          });
        } else {
          showToast({ title: "SYNC FAILED", desc: data.error || "ซิงค์ไม่สำเร็จ", action: "CUT" });
        }
      } catch (err) {
        showToast({ title: "SYNC ERROR", desc: err.message, action: "CUT" });
      } finally {
        elTmBtnReconcilePnl.disabled = false;
        elTmBtnReconcilePnl.innerHTML = origText;
      }
    });
  }
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
