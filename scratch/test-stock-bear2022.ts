import { Candle } from "../src/strategy/ma-fan/types.js";

async function fetchDailyCandles(symbol: string): Promise<Candle[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=5y&interval=1d`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
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
    if (o != null && h != null && l != null && c != null && !isNaN(c)) {
      candles.push({ time: timestamps[i], open: o, high: h, low: l, close: c, volume: v });
    }
  }
  return candles;
}

// Simulate 2022 Bear Market (Jan 2022 - Dec 2022)
async function testBearMarket2022() {
  console.log("=========================================================================");
  console.log("🐻 2022 US STOCK BEAR MARKET TEST: When S&P 500 crashed -19.4% & QQQ -33.1%");
  console.log("=========================================================================");

  const symbols = ["SPY", "QQQ", "DIA", "IWM", "KO", "JNJ", "PG", "MCD", "AAPL", "MSFT", "NVDA", "INTC", "TSLA"];

  for (const sym of symbols) {
    const allCandles = await fetchDailyCandles(sym);
    // Filter year 2022 (timestamps between 1640995200 [2022-01-01] and 1672531199 [2022-12-31])
    const c2022 = allCandles.filter(c => {
      const d = new Date(c.time * 1000);
      return d.getUTCFullYear() === 2022;
    });

    if (c2022.length < 200) continue;

    const startP = c2022[0].close;
    const endP = c2022[c2022.length - 1].close;
    const bhPnl = ((endP - startP) / startP) * 100;

    // Run 5-zone grid (3% step, 3% TP on daily bars)
    const capital = 10000;
    const zones = 5;
    const zoneSize = capital / zones;
    const stepPct = 0.03;
    const tpPct = 0.035;

    let cash = capital;
    let lots: Array<{ price: number; amount: number; cost: number; tpPrice: number }> = [];
    let peakEquity = capital;
    let maxDD = 0;
    let cashflow = 0;
    let trades = 0;

    for (const c of c2022) {
      // TP check
      for (let j = lots.length - 1; j >= 0; j--) {
        const lot = lots[j];
        if (c.high >= lot.tpPrice) {
          const sellVal = lot.amount * lot.tpPrice;
          cash += sellVal;
          cashflow += sellVal - lot.cost;
          trades++;
          lots.splice(j, 1);
        }
      }

      // Buy check
      if (lots.length < zones && cash >= zoneSize) {
        let shouldBuy = false;
        if (lots.length === 0) shouldBuy = true;
        else {
          const lowestP = Math.min(...lots.map(l => l.price));
          if (c.low <= lowestP * (1 - stepPct)) shouldBuy = true;
        }

        if (shouldBuy) {
          const buyP = c.close;
          const invest = Math.min(cash, zoneSize);
          const amount = invest / buyP;
          lots.push({ price: buyP, amount, cost: invest, tpPrice: buyP * (1 + tpPct) });
          cash -= invest;
        }
      }

      let stockVal = 0;
      for (const lot of lots) stockVal += lot.amount * c.close;
      const eq = cash + stockVal;
      if (eq > peakEquity) peakEquity = eq;
      const dd = peakEquity > 0 ? ((peakEquity - eq) / peakEquity) * 100 : 0;
      if (dd > maxDD) maxDD = dd;
    }

    let finalStockVal = 0;
    for (const lot of lots) finalStockVal += lot.amount * endP;
    const finalEq = cash + finalStockVal;
    const gridPnl = ((finalEq - capital) / capital) * 100;

    const alpha = gridPnl - bhPnl;
    console.log(`${sym.padEnd(6)} | Buy&Hold: ${bhPnl.toFixed(1).padStart(7)}% | Grid Net: ${gridPnl.toFixed(1).padStart(7)}% | Max DD: -${maxDD.toFixed(1).padStart(5)}% | Trades: ${trades.toString().padStart(3)} tr | Cashflow: $${cashflow.toFixed(0).padStart(5)} | Alpha: +${alpha.toFixed(1)}%`);
  }
}

testBearMarket2022().catch(console.error);
