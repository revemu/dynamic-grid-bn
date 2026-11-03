import { Candle } from "../src/strategy/ma-fan/types.js";

async function fetchYahooCandles(symbol: string, range: string = "730d", interval: string = "1h"): Promise<Candle[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=${range}&interval=${interval}`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${symbol}`);
  const data = await res.json();
  const result = data.chart?.result?.[0];
  if (!result || !result.timestamp) return [];

  const timestamps: number[] = result.timestamp;
  const quote = result.indicators.quote[0];
  const candles: Candle[] = [];

  for (let i = 0; i < timestamps.length; i++) {
    const o = quote.open[i];
    const h = quote.high[i];
    const l = quote.low[i];
    const c = quote.close[i];
    const v = quote.volume[i] ?? 0;

    // Filter nulls / missing data (market holidays / pre-market gaps)
    if (o != null && h != null && l != null && c != null && !isNaN(c)) {
      candles.push({
        time: timestamps[i],
        open: o,
        high: h,
        low: l,
        close: c,
        volume: v,
      });
    }
  }

  return candles;
}

interface StockGridResult {
  symbol: string;
  category: string;
  startPrice: number;
  endPrice: number;
  buyAndHoldPnlPct: number;
  gridNetPnlPct: number;
  gridMaxDDPct: number;
  closedTrades: number;
  winRate: number;
  cashFlowGenerated: number;
  finalEquity: number;
}

// Unleveraged multi-zone stock grid simulator
function simulateStockGrid(candles: Candle[], opts: {
  symbol: string;
  category: string;
  initialCapital?: number;
  zones?: number;
  stepPct?: number;     // Dip required to buy next zone (e.g. 1.5%)
  tpPct?: number;       // Take profit target (e.g. 2.0%)
  feePct?: number;      // Stock trading fee (0.02% or zero commission)
}): StockGridResult {
  const capital = opts.initialCapital ?? 10000;
  const zones = opts.zones ?? 5; // 5 zones = 20% per zone
  const zoneSize = capital / zones;
  const stepPct = (opts.stepPct ?? 1.5) / 100;
  const tpPct = (opts.tpPct ?? 2.0) / 100;
  const feePct = (opts.feePct ?? 0.01) / 100; // Typical US broker (zero commission, tiny exchange fee)

  let cash = capital;
  let lots: Array<{ price: number; amount: number; cost: number; tpPrice: number }> = [];
  let peakEquity = capital;
  let maxDD = 0;
  let closedWins = 0;
  let closedLosses = 0;
  let totalCashFlow = 0;

  const startPrice = candles[0].close;
  const endPrice = candles[candles.length - 1].close;
  const buyAndHoldPnlPct = ((endPrice - startPrice) / startPrice) * 100;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];

    // 1. Check TP for existing lots
    for (let j = lots.length - 1; j >= 0; j--) {
      const lot = lots[j];
      if (c.high >= lot.tpPrice) {
        // Sold lot at take profit!
        const sellVal = lot.amount * lot.tpPrice * (1 - feePct);
        const profit = sellVal - lot.cost;
        cash += sellVal;
        totalCashFlow += profit;
        closedWins++;
        lots.splice(j, 1);
      }
    }

    // 2. Check Buy Criteria
    if (lots.length < zones && cash >= zoneSize) {
      let shouldBuy = false;
      if (lots.length === 0) {
        // First entry: buy base zone to start harvesting cashflow
        shouldBuy = true;
      } else {
        // Next zone: buy when price drops by stepPct below the lowest open lot
        const lowestOpenPrice = Math.min(...lots.map(l => l.price));
        if (c.low <= lowestOpenPrice * (1 - stepPct)) {
          shouldBuy = true;
        }
      }

      if (shouldBuy) {
        const buyPrice = c.close;
        const invest = Math.min(cash, zoneSize);
        const fee = invest * feePct;
        const netInvest = invest - fee;
        const amount = netInvest / buyPrice;
        const lotTpPrice = buyPrice * (1 + tpPct);

        lots.push({ price: buyPrice, amount, cost: invest, tpPrice: lotTpPrice });
        cash -= invest;
      }
    }

    // 3. Track Total Equity & Max Drawdown
    let stockVal = 0;
    for (const lot of lots) stockVal += lot.amount * c.close;
    const equity = cash + stockVal;
    if (equity > peakEquity) peakEquity = equity;
    const curDD = peakEquity > 0 ? ((peakEquity - equity) / peakEquity) * 100 : 0;
    if (curDD > maxDD) maxDD = curDD;
  }

  // End of test: mark to market
  let finalStockVal = 0;
  for (const lot of lots) finalStockVal += lot.amount * endPrice * (1 - feePct);
  const finalEquity = cash + finalStockVal;
  const gridNetPnlPct = ((finalEquity - capital) / capital) * 100;
  const totalTrades = closedWins + closedLosses;
  const winRate = totalTrades > 0 ? (closedWins / totalTrades) * 100 : 0;

  return {
    symbol: opts.symbol,
    category: opts.category,
    startPrice,
    endPrice,
    buyAndHoldPnlPct,
    gridNetPnlPct,
    gridMaxDDPct: maxDD,
    closedTrades: totalTrades,
    winRate,
    cashFlowGenerated: totalCashFlow,
    finalEquity,
  };
}

async function runStockGridExperiment() {
  console.log("=========================================================================================");
  console.log("📈 STOCK MARKET GRID BACKTEST: Testing Grid Strategy on US Equities & ETFs (2 Years 1H)");
  console.log("=========================================================================================");

  const stockUniverse = [
    // 1. Broad Market & Sector ETFs
    { sym: "SPY", cat: "Index ETF (S&P 500)" },
    { sym: "QQQ", cat: "Index ETF (Nasdaq 100)" },
    { sym: "DIA", cat: "Index ETF (Dow Jones)" },
    { sym: "IWM", cat: "Index ETF (Russell 2000 Small-Cap)" },
    { sym: "XLF", cat: "Sector ETF (Financials)" },
    { sym: "XLE", cat: "Sector ETF (Energy)" },

    // 2. Dividend Aristocrats / Defensive Stocks
    { sym: "KO", cat: "Dividend / Consumer Defensive (Coca-Cola)" },
    { sym: "JNJ", cat: "Dividend / Healthcare (Johnson & Johnson)" },
    { sym: "PG", cat: "Dividend / Consumer Staples (P&G)" },
    { sym: "MCD", cat: "Dividend / Blue-chip (McDonald's)" },

    // 3. Mega-Cap Tech
    { sym: "AAPL", cat: "Mega-Cap Tech (Apple)" },
    { sym: "MSFT", cat: "Mega-Cap Tech (Microsoft)" },
    { sym: "GOOGL", cat: "Mega-Cap Tech (Alphabet)" },
    { sym: "NVDA", cat: "High-Growth Tech (Nvidia)" },

    // 4. Turnaround / Stagnant Stocks
    { sym: "INTC", cat: "Struggling Tech (Intel)" },
    { sym: "TSLA", cat: "Volatile Growth (Tesla)" },
  ];

  const results: StockGridResult[] = [];

  for (const item of stockUniverse) {
    try {
      const candles = await fetchYahooCandles(item.sym, "730d", "1h");
      if (candles.length < 500) {
        console.log(`⚠️ ${item.sym}: insufficient data (${candles.length} bars)`);
        continue;
      }

      // Simulate 5-zone grid: 20% per zone, 1.5% step, 2.0% TP
      const res = simulateStockGrid(candles, {
        symbol: item.sym,
        category: item.cat,
        initialCapital: 10000,
        zones: 5,
        stepPct: 1.5,
        tpPct: 2.0,
      });

      results.push(res);
      process.stdout.write(".");
    } catch (e: any) {
      console.log(`\nError ${item.sym}: ${e.message}`);
    }
  }

  console.log(`\n\n✅ Successfully simulated ${results.length} stocks/ETFs.\n`);

  console.log("-------------------------------------------------------------------------------------------------------------------");
  console.log("Symbol | Category                  | Buy&Hold PnL | Grid Net PnL | Max DD   | Trades | Cashflow Made | Alpha vs B&H");
  console.log("-------------------------------------------------------------------------------------------------------------------");

  for (const r of results) {
    const alpha = r.gridNetPnlPct - r.buyAndHoldPnlPct;
    const alphaStr = `${alpha >= 0 ? "+" : ""}${alpha.toFixed(1)}%`;
    const bhStr = `${r.buyAndHoldPnlPct >= 0 ? "+" : ""}${r.buyAndHoldPnlPct.toFixed(1)}%`;
    const gridStr = `${r.gridNetPnlPct >= 0 ? "+" : ""}${r.gridNetPnlPct.toFixed(1)}%`;
    const symPadded = r.symbol.padEnd(6);
    const catPadded = r.category.padEnd(25);
    const bhPadded = bhStr.padStart(12);
    const gridPadded = gridStr.padStart(12);
    const ddPadded = `-${r.gridMaxDDPct.toFixed(1)}%`.padStart(8);
    const trPadded = `${r.closedTrades} tr`.padStart(8);
    const cfPadded = `$${r.cashFlowGenerated.toFixed(0)}`.padStart(13);
    const alphaPadded = alphaStr.padStart(12);

    console.log(`${symPadded} | ${catPadded} | ${bhPadded} | ${gridPadded} | ${ddPadded} | ${trPadded} | ${cfPadded} | ${alphaPadded}`);
  }
  console.log("-------------------------------------------------------------------------------------------------------------------");

  // Summary by category
  const categories = [...new Set(results.map(r => r.category.split("(")[0].trim()))];
  console.log("\n📊 SUMMARY BY ASSET CLASS:\n");
  for (const cat of categories) {
    const filtered = results.filter(r => r.category.startsWith(cat));
    if (filtered.length === 0) continue;
    const avgGrid = filtered.reduce((a, b) => a + b.gridNetPnlPct, 0) / filtered.length;
    const avgBH = filtered.reduce((a, b) => a + b.buyAndHoldPnlPct, 0) / filtered.length;
    const avgDD = filtered.reduce((a, b) => a + b.gridMaxDDPct, 0) / filtered.length;
    const avgTrades = filtered.reduce((a, b) => a + b.closedTrades, 0) / filtered.length;
    const profitable = filtered.filter(r => r.gridNetPnlPct > 0).length;

    console.log(`📌 ${cat} (${filtered.length} assets):`);
    console.log(`   Avg Grid Return:    ${avgGrid >= 0 ? "+" : ""}${avgGrid.toFixed(1)}% (Profitable: ${profitable}/${filtered.length})`);
    console.log(`   Avg Buy&Hold:       ${avgBH >= 0 ? "+" : ""}${avgBH.toFixed(1)}%`);
    console.log(`   Avg Max Drawdown:   -${avgDD.toFixed(1)}%`);
    console.log(`   Avg Trades:         ${avgTrades.toFixed(0)} trades`);
    console.log("----------------------------------------------------------------------------------");
  }
}

runStockGridExperiment().catch(console.error);
