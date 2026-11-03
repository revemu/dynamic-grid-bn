async function testIntervals() {
  const sym = "SPY";
  // 1. Test 1h for 730d (~2 years)
  const res1h = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=730d&interval=1h`, {
    headers: { "User-Agent": "Mozilla/5.0" }
  });
  const data1h = await res1h.json();
  const count1h = data1h.chart?.result?.[0]?.timestamp?.length ?? 0;
  console.log(`SPY 1-hour bars (2 years): ${count1h} bars`);

  // 2. Test 1d for 5y
  const res1d = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=5y&interval=1d`, {
    headers: { "User-Agent": "Mozilla/5.0" }
  });
  const data1d = await res1d.json();
  const count1d = data1d.chart?.result?.[0]?.timestamp?.length ?? 0;
  console.log(`SPY 1-day bars (5 years): ${count1d} bars`);
}

testIntervals().catch(console.error);
