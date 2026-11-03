async function testYahooFinance() {
  console.log("Testing Yahoo Finance API access for Stocks...");
  // Test SPY (S&P 500 ETF), AAPL (Apple), KO (Coca-Cola)
  const symbols = ["SPY", "AAPL", "KO", "QQQ"];
  for (const sym of symbols) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=1y&interval=1d`;
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
      });
      if (!res.ok) {
        console.log(`Failed ${sym}: HTTP ${res.status}`);
        continue;
      }
      const data = await res.json();
      const result = data.chart?.result?.[0];
      if (result) {
        const timestamps = result.timestamp;
        const quotes = result.indicators.quote[0];
        console.log(`✅ ${sym}: Loaded ${timestamps.length} daily bars. Latest Close: $${quotes.close[quotes.close.length - 1].toFixed(2)}`);
      }
    } catch (e: any) {
      console.log(`Error ${sym}: ${e.message}`);
    }
  }
}

testYahooFinance().catch(console.error);
