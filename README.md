# dynamic-grid

A drop-in replacement for `strategies/grid` from
[`somnia-chain/dreamdex-bot-kit`](https://github.com/somnia-chain/dreamdex-bot-kit)
where the grid step is **recomputed from live volatility (ATR)** instead of
fixed at deploy time. Same FIFO-lot / maker-taker execution, spread gate,
session stop-loss, and stuck-lot timeout as the original — only the sizing of
the grid changes.

## How the dynamic step works

ATR (Average True Range) drives the grid spacing, but **where ATR comes from
and what actually executes the trade are two separate things**:

- **Volatility source** (`DGRID_ATR_SOURCE`): where ATR is computed from.
  Pluggable, via the `AtrSource` interface in `src/types.ts`.
  - `binance` (default) — a Binance public WebSocket kline stream
    (`DGRID_BINANCE_SYMBOL@kline_DGRID_BINANCE_INTERVAL`), e.g.
    `somiusdt@kline_1m`. Real OHLC candles, external to DreamDEX, updates in
    real time independent of how often this bot ticks. No API key needed —
    it's public market data. See `src/binance-feed.ts`.
  - `dreamdex` — self-sampled from DreamDEX's own `pool.topOfBook().mid`,
    bucketed into synthetic bars (`DGRID_BAR_MS`) since DreamDEX's REST API
    doesn't currently expose a candles endpoint. No external dependency, but
    converges slower and depends on `GRID_INTERVAL_MS`. See `src/volatility.ts`.
- **Execution**: always DreamDEX's own `pool.topOfBook()` / `pool.place()`,
  regardless of which ATR source is selected. The buy/sell trigger prices,
  the anchor price, and every order sent to the chain come from DreamDEX —
  never from Binance or any other external feed.

Both sources implement the same interface and expose ATR as a **percentage of
price** (`atrPct()`), not an absolute number. That's deliberate: SOMI/USDT on
Binance and SOMI/USDso on DreamDEX are different order books on different
exchanges, so their absolute prices can and do drift apart slightly (basis
risk). A relative "ATR is currently 0.4% of price" figure transfers cleanly
across that gap in a way an absolute ATR in USDT terms would not.

```
TR(bar)   = max(high-low, |high-prevClose|, |low-prevClose|)
atrPct    = average(TR/close) over the last DGRID_ATR_LOOKBACK bars

step_bps  = clamp(atrPct * 10_000 * DGRID_ATR_K,
                   DGRID_MIN_STEP_BPS, DGRID_MAX_STEP_BPS)
```

- Quiet market → small ATR → tight grid → more fills, smaller profit each.
- Volatile market → large ATR → wide grid → fewer fills, bigger profit each,
  and less chance a lot gets stranded far from its sell trigger.
- The step is recalculated every `DGRID_RECALC_EVERY_TICKS` ticks, not every
  tick, so orders aren't re-priced on every poll.
- Until enough bars have closed (`< 3`), it uses a fixed `DGRID_WARMUP_STEP_BPS`
  instead of trading on a noisy 1–2 bar ATR.
- If the Binance feed disconnects, `isFresh()` goes false after
  `DGRID_BINANCE_STALE_MS` with no message — the bot holds its last known
  step (doesn't freeze buying/selling) rather than sizing off a stale ATR, and
  auto-reconnects with exponential backoff in the background.
- A breakout guard re-anchors the grid (only while flat — it never abandons an
  open lot) if price has moved more than `DGRID_BREAKOUT_ATR_MULT` × ATR away
  from the current anchor.
- **Stepped Buy Laddering**: Instead of piling into all inventory lots at the
  same dip price on consecutive ticks, each subsequent lot requires price to drop
  deeper below the lowest held lot by at least `step_bps`.
- **Dow Theory Market Structure**:
  - Automatically identifies **Swing Highs (Resistance / Upper Bound)** and
    **Swing Lows (Support / Bottom Bound)** from rolling candle pivots.
  - Classifies market regime: `RANGE`, `UPTREND` (Higher Highs + Higher Lows),
    or `DOWNTREND` (Lower Highs + Lower Lows).
  - Trend Filter (`DOW_TREND_FILTER=true`): Automatically pauses opening new buy
    positions during a verified Dow downtrend, protecting you from catching
    falling knives.

## Visual Trading Dashboard

`dynamic-grid` includes a built-in real-time web dashboard running at
`http://localhost:3333` (configurable via `DASHBOARD_PORT`).

- **Interactive Candlestick Chart** powered by TradingView `lightweight-charts`.
- **Live Bound & Trigger Lines**:
  - 🔵 **Upper Bound** (Dow Theory Resistance)
  - 🟣 **Bottom Bound** (Dow Theory Support)
  - 🟡 **Anchor Price**
  - 🟢 **Stepped Buy Trigger**
  - 🔴 **Sell Target**
- **Action Markers**:
  - 🟢 **Buy fills** (arrow pointing up at entry price)
  - 🔴 **Sell fills** (arrow pointing down with realized PnL)
  - ⚠️ **Stuck Cuts** (unwound inventory marker)
- **Live HUD**: Realized PnL, open lots table, stuck timer countdown, and Dow
  market structure regime badge.


### Before you point `DGRID_BINANCE_SYMBOL` at a real pair

`somiusdt` is the default because SOMI/USDT has traded on Binance Spot since
September 2025 — but exchange listings change. Confirm the pair is still live
(e.g. check https://www.binance.com/en/trade/SOMI_USDT) before relying on it,
and if you point this at a different market/token, update the symbol to match
what's actually tradable on both sides (Binance for ATR, DreamDEX for
execution).

## Install

Drop this folder into the kit as `strategies/dynamic-grid/`, alongside the
existing `strategies/grid/`:

```
cp -r dynamic-grid  dreamdex-bot-kit/strategies/dynamic-grid
cd dreamdex-bot-kit
npm install                      # picks up the new workspace package
cp strategies/dynamic-grid/.env.example strategies/dynamic-grid/.env
# .env still needs the root PRIVATE_KEY / NETWORK from the kit's own .env.example
```

Run the same read-only check the kit recommends before anything else:

```
npx tsx scripts/doctor.ts
```

Then run it dry:

```
npm run dev -w dynamic-grid      # DRY_RUN=true by default — logs, sends nothing
```

Watch the log for a few `step recalculated: …` lines to confirm ATR is
converging sensibly for the market you picked, **then** set `DRY_RUN=false` in
`strategies/dynamic-grid/.env` and start on **testnet** (`NETWORK=testnet` in
the kit's root `.env`) with small `GRID_LOT_USDSO` before touching mainnet.

## Tuning notes

| Symptom | Try |
|---|---|
| Step barely moves even when the market is obviously calmer/wilder | Lower `DGRID_BINANCE_INTERVAL` (e.g. `1m`→`30s` isn't valid on Binance, so use more bars via lower `DGRID_ATR_LOOKBACK` instead) — or, on `dreamdex` source, lower `DGRID_BAR_MS` |
| Step whipsaws around every recalc | Raise `DGRID_RECALC_EVERY_TICKS` or `DGRID_ATR_LOOKBACK` |
| Grid barely trades in calm markets | Lower `DGRID_MIN_STEP_BPS` and/or `DGRID_ATR_K` |
| Lots get stranded in trending moves | Lower `DGRID_MAX_STEP_BPS`... or accept that grids are fundamentally a range-bound strategy and rely on `GRID_STUCK_TIMEOUT_MS` / the session stop-loss to cut losses |
| Log repeats "atr=feed stale — holding last step" | Binance WS dropped and hasn't reconnected yet, or `DGRID_BINANCE_SYMBOL`/interval is wrong — check the connect/error log lines; the strategy keeps running safely on the last known step meanwhile |

## Before you point this at real funds

- **This is unaudited, educational-reference code** — same disclaimer as the
  rest of the kit (see `DISCLAIMER.md` at the repo root). Any strategy,
  dynamic or not, can lose money — grids in particular lose in a strong
  one-directional trend, because every lot keeps averaging into the move.
- Read the kit's own [`docs/session-keys.md`](https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/docs/session-keys.md)
  and run the bot with a hot **operator** key that cannot withdraw funds,
  rather than your main wallet's private key.
- Test on **Shannon testnet** (chain `50312`) with `DRY_RUN=true`, then
  `DRY_RUN=false` with small size, before mainnet (chain `5031`).
- This kit is third-party, open-source code, not something Anthropic
  reviewed or vouches for — before wiring in a real private key, check the
  repo yourself (contract addresses, recent commits/issues) rather than
  trusting any single source blindly, this file included.
