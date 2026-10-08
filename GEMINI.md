# Dynamic Grid Strategy — Project Knowledge & Memory (`GEMINI.md`)

This document is the persistent operational and architectural knowledge base for `dynamic-grid`. It is automatically loaded into the agent's context to ensure continuity across sessions without re-analyzing the codebase from scratch.

---

## 1. Monorepo Relationship & Architecture

> [!IMPORTANT]
> `dynamic-grid` is **NOT** an independent standalone bot. It is a **strategy package inside the `dreamdex-bot-kit` monorepo** (`strategies/dynamic-grid`).
> It cannot run in isolation — it depends on `@dreamdex-bot-kit/core` (`packages/core`) and the root monorepo workspace.

```text
dreamdex-bot-kit-main/               # Monorepo root
├── package.json                     # Root workspace configuration ("workspaces": ["packages/*", "strategies/*", ...])
├── .env                             # Global credentials (PRIVATE_KEY, NETWORK, RPC_URL, OWNER_ADDRESS)
├── scripts/
│   ├── doctor.ts                    # Global health check (reads wallet, gas, and all order books)
│   ├── quickstart.mjs               # Interactive bot setup script
│   └── railway-start.mjs            # Production Railway process launcher
├── packages/
│   ├── core/                        # @dreamdex-bot-kit/core (the engine driving all strategies)
│   │   ├── src/pool.ts              # Pool class: topOfBook(), place(), cancel(), walletBase()
│   │   ├── src/client.ts            # Chain context, Viem public/wallet clients
│   │   ├── src/env.ts               # loadEnv(): walks UP directories to read root .env
│   │   ├── src/execute.ts           # Order simulation, auto-pull payable placeOrder(), gas headroom
│   │   └── src/gotchas.ts           # Protocol-level validation rules & checks
│   └── backtest/                    # @dreamdex-bot-kit/backtest simulation engine
└── strategies/
    ├── grid/                        # Original static grid strategy
    └── dynamic-grid/                # <-- THIS PACKAGE (volatility & Dow-driven dynamic grid)
        ├── package.json             # Workspace package referencing "@dreamdex-bot-kit/core": "*"
        ├── .env                     # Local strategy tuning knobs (DGRID_*, DOW_*, CHANNEL_MODE)
        ├── data/grid-bot.db.json    # ACID database for lots, orders, and PnL persistence
        ├── public/                  # Static web dashboard UI
        └── src/
            ├── index.ts             # Strategy entrypoint (bootstraps feeds, engines, dashboard)
            ├── strategy.ts          # Core DynamicGrid state machine, lots, and safeguards
            ├── market-structure.ts  # Dow Theory swing pivots, trendlines, 3 channel modes
            ├── config.ts            # Strategy environment loader (calls loadEnv() from core)
            ├── db.ts                # JSON ACID state persistence
            ├── indexer.ts           # Somnia Markets GraphQL Indexer client (https://prd.smk.somnia.host/v1/graphql)
            ├── inspect-orders.ts    # CLI order inspector (open orders & fill history via GraphQL)
            ├── server.ts            # Real-time WebSocket + HTTP TradingView dashboard (port 3333)
            ├── binance-feed.ts      # Binance WebSocket kline client for live ATR
            └── types.ts             # Shared interfaces
```

---

## 2. Core Dependencies & Protocol Mechanics (`@dreamdex-bot-kit/core`)

All interaction with the Somnia blockchain and DreamDEX CLOB contracts goes through `@dreamdex-bot-kit/core`:

1. **Environment Cascading (`loadEnv`)**:
   - `packages/core/src/env.ts` walks up directories from `strategies/dynamic-grid` to the monorepo root.
   - **Root `.env`**: Sets `PRIVATE_KEY`, `NETWORK` (`testnet` or `mainnet`), `RPC_URL`.
   - **Local `.env`** (`strategies/dynamic-grid/.env`): Overrides or sets strategy knobs (`DGRID_ATR_SOURCE`, `GRID_MAX_INVENTORY_USDSO`, `CHANNEL_MODE`, etc.).
2. **Post-Upgrade Spot Contract (June 2026)**:
   - Single entrypoint `placeOrder(...)` with `payable` auto-pull — funds are pulled directly from the wallet, no separate vault deposit required.
   - `expireTimestampNs` must be a future nanosecond timestamp (`(Date.now() + ms) * 1_000_000`).
   - Native SOMI buy transactions require $\ge 5,000,000$ gas limit.
   - `USDso` has **18 decimals** (never assume 6 decimals).
3. **Execution Routing**:
   - `AtrSource` (Binance WebSocket or DreamDEX synthetic candles) calculates relative volatility (`atrPct()`).
   - **Execution is 100% on DreamDEX**: All order placements, cancellations, and prices use `pool.topOfBook()` and `pool.place()` via `@dreamdex-bot-kit/core`.

---

## 3. Operational Runbook & How to Run

Because `dynamic-grid` is part of the npm workspace, commands should be executed from the **monorepo root** or inside the workspace with workspace links established:

### From Monorepo Root (`c:\Sites\github\dreamdex-bot-kit-main`):
| Purpose | Command | Notes |
| :--- | :--- | :--- |
| **Workspace Build** | `npm run build` | Builds `@dreamdex-bot-kit/core` and dependencies. Run first if core changes. |
| **System Diagnostics** | `npx tsx scripts/doctor.ts` | Read-only check: prints wallet address, gas, token balances, and live market books. |
| **Dry Run (Dev)** | `npm run dev -w dynamic-grid` | Starts `dynamic-grid` with hot-reload (`DRY_RUN=true`). Logs orders, sends no txs. |
| **Live Production** | `npm start -w dynamic-grid` | Runs live on-chain trading (`DRY_RUN=false` in `.env`). |
| **Global Type Check** | `npm run typecheck` | Validates TypeScript across all workspaces including `dynamic-grid`. |

### From Workspace Directory (`strategies/dynamic-grid/`):
| Purpose | Command | Notes |
| :--- | :--- | :--- |
| **Local Type Check** | `npm run typecheck` | Runs `tsc --noEmit` locally. |
| **Local Dry Run** | `npm run dev` | Runs `tsx watch src/index.ts`. |
| **Cancel All Orders**| `npm run cancel-all` | Emergency cancel for all resting Maker orders on the pool contract. |
| **Claim Proceeds** | `npm run claim` | Claims tokens from matched/settled limit orders on DreamDEX. |
| **Inspect Balances** | `npx tsx src/inspect-balances.ts` | Detailed inspect of native SOMI and USDso balances. |
| **Inspect Orders** | `npm run inspect-orders [addr]` | Inspects active resting orders & recent fill/cancel history via GraphQL Indexer. |
| **Trade History** | `npm run history` | Queries trade logs and realized PnL. |

---

## 4. Key Strategy Features & Safeguards

- **5-Zone Dynamic Channel**:
  - `0% Floor`: Support boundary; cut-loss trigger.
  - `0%–50% Buy Zone`: Stepped accumulation ladder.
  - `50% Center`: Equilibrium midpoint.
  - `50%–100% Sell Zone`: Stepped profit taking ladder.
  - `100% Ceiling`: Resistance boundary; 100% full take-profit exit.
- **Dynamic 4-Level Buy Tranche Allocation (No Hardcoded $10!)**:
  - Available capacity (`currentAvailableCapacity = Math.max(0, maxInv - currentHeldUsdso)`) is dynamically divided equally across all 4 buy levels (`trancheUsdso = currentAvailableCapacity / 4`).
  - Eliminates the flawed rigid $10 limit (`maxInv / 4`) which previously prevented Buy Level 4 from placing orders when partial inventory was held.
  - Guarantees 100% that **all 4 buy levels have active resting orders**, fully utilizing available USDso capacity without empty levels.
  - **Symmetric Rebalance Rules**:
    - **When a BUY fills**: Triggers SELL rebalance (`needsSellRebalance = true`) to cover the new SOMI across all eligible sell targets. Remaining resting buy orders stay untouched on the book ("คงออเดอร์ไว้") to avoid cancel gas churn.
    - **When a SELL fills**: Triggers BUY rebalance (`needsBuyRebalance = true`) to recalculate freed capacity and evenly distribute new buy orders across all 4 levels.
- **4 Channel Modes (`CHANNEL_MODE`)**:
  - `DOW_ATR_CLAMP` (Default): Dow Theory swing pivots clamped to $2.5\times$ – $5.0\times$ ATR.
  - `FIXED_PCT_CLAMP`: Clamped between `MIN_CHANNEL_WIDTH_PCT` (1.8%) and `MAX_CHANNEL_WIDTH_PCT` (4.0%).
  - `DONCHIAN_ATR`: Adaptive Donchian Channel (last 20 bars) + ATR buffer.
  - `MULTI_TOUCH_SR`: Horizontal Support/Resistance clustering strictly using calculated Dow swing points (`this.swingHighs` + `candidatePeak`, `this.swingLows` + `candidateValley`). No raw candle loops. Clusters swing points within tolerance (default $\pm 0.35\%$ via `SR_TOUCH_TOLERANCE_PCT`). Identifies resistance above price with $\ge 2$ touches (default `SR_MIN_TOUCH_COUNT`) and support below price with $\ge 2$ touches.
    - *Pure Calculated Swing Clustering*: Uses ONLY the peaks (ยอด) and valleys (เหว) that the engine already calculated and displayed on the chart. Resistance ONLY clusters genuine peaks (`HIGH`); Support ONLY clusters genuine valleys (`LOW`).
    - *Absolute Elimination of Single-Touch Boundaries*: Single swing points with only 1 touch are completely forbidden from serving as channel bounds. If a side lacks a multi-touch cluster ($\ge 2$ distinct touches), it strictly anchors to the confirmed active swing point on that side (`activeValley` / `activePeak`) or centered price, ensuring every bound always directly sits on a genuine swing point shown on the chart. Prevents floating projected bounds (e.g. `upperBound - minSpan`) from appearing in empty space unrelated to actual peaks or valleys.
    - *Active Wave Swings (Elimination of 120-Bar Ancient Low Leakage)*: Replaced the flawed 120-bar `minLow` scan (which anchored `activeValley` to ancient lows like `0.1889` from 75 hours ago prior to major rallies) with recent confirmed swing pivots (`confirmedLows.slice(-4)` and `confirmedHighs.slice(-4)`). Locks `activeValley` (`0.2072`) and `activePeak` (`0.2127`) strictly to the active trading wave/consolidation cycle.
    - *Structural Support Prioritization in `findMultiTouchSR`*: `findMultiTouchSR` now prioritizes the confirmed support cluster belonging to `activeWaveLow` (`Math.abs(c.price - activeWaveLow) / activeWaveLow <= 0.02`). Prevents the engine from rejecting the active double bottom (`0.20745`) during breakdowns and searching backward for ancient clusters from 4 days ago (`0.1983`). Keeps the floor rock-solid at `0.20745`, cleanly reporting `isBelowFloor = true` (`BELOW_FLOOR_CUTLOSS`).
    - *Fixed Seed Leader Clustering (Zero Drift)*: Fixed a subtle clustering drift flaw where calculating moving `groupAvg` caused nearby points to chain together (e.g. 0.2072 chained to 0.2085 into a fictitious 0.2080 level). Points in a group are now strictly compared to the anchor seed price `p1.price` (`Math.abs(p2.price - p1.price) / p1.price <= tol`), cleanly separating distinct structural levels (e.g. double bottom at 0.20745 vs upper support at 0.20828).
    - *Strict Multi-Touch Reach Enforcement (`min` of Peaks & `max` of Valleys)*: In `clusterPoints`, Resistance clusters are strictly priced at $\min(p.\text{price})$ (e.g. `0.2181`) so every peak reaches and touches the resistance line ($\ge 2$ peaks touch), and Support clusters at $\max(p.\text{price})$. This completely prevents the upper bound from floating into empty space above peaks ("กรอบบนไม่ลอย"), ensuring the line rests solidly on the structural touch point.
    - *Canonical Alternating Swings Clustering (Elimination of Intra-Leg 3x Noise Wicks)*: `findMultiTouchSR` now clusters ONLY genuine alternating Dow swings (`canonicalHighs` / `canonicalLows` from `calculateWaveCycles()`) instead of raw 3-bar candle wicks. This completely eliminates false 3x touch counts caused by minor intra-pullback candles (e.g. a 1-bar green wiggle during a dump), guaranteeing that the cluster touch count reflects strictly genuine structural wave peaks (2x).
    - *Multi-Touch Upper Bound Protection Against Floating HH Overrides*: In `MULTI_TOUCH_SR` mode, when a confirmed multi-touch resistance cluster exists ($\ge 2$ touches, e.g. at `0.2181`), the upper bound strictly remains anchored to this structural multi-touch level. The Higher High override (`upperBound = lastCanonicalHigh.price`) is skipped, preventing the upper line from being pushed up into empty space at `0.2186` where it would float above the first peak.
    - *1.0% Clustering Tolerance (`SR_TOUCH_TOLERANCE_PCT`)*: Updated default clustering tolerance to `1.0%` (from `0.5%`), allowing double tops/bottoms with natural slight wick tilt or retest variance on 15M candles to group into multi-touch clusters reliably.
    - *Multi-Touch Cluster Priority & Sub-Point Protection*: If a swing point is already part of a multi-touch cluster, it is strictly forbidden from being added as an isolated 1-touch candidate that could compete against its own cluster. Increased multi-touch bonus (`touchBonus`) to 2500 in `bestPair` scoring, ensuring multi-touch levels are overwhelmingly prioritized over single points.
    - *6.0% Max Channel Width Headroom (`MAX_CHANNEL_WIDTH_PCT`)*: Increased default max channel width to `6.0%` (from `3.0%`), preventing natural wide consolidation channels (such as 4.24%) from being falsely penalized as "out of range".
    - *Multi-Touch S/R Visual Markers on Chart*: Touch points belonging to active resistance and support clusters are streamed to the TradingView dashboard and visually marked with `🎯 2x` (or `🎯 Nx` when $N \ge 2$) or `🎯 ⛰️` / `🎯 🌊` with shape rendering suppressed (`size: 0`). Eliminates the red and blue circle dots on touch points to completely avoid visual confusion with buy/sell order execution dots while explicitly confirming the multi-touch count directly on the candles.
    - *Broken Support Invalidation vs Active Wave Low*: If market breaks down and establishes a lower valley (`activeWaveLow` / `activeValley`), ancient support levels sitting above `activeWaveLow * (1 + tol)` (e.g. `0.2085` when wave made a low at `0.2045`) are marked as broken and excluded from `validSupsBelowPrice`.
    - *Confirmed Resistance Cluster Protection*: `findMultiTouchSR` strictly prohibits overwriting an existing confirmed resistance cluster (e.g. double top at `0.212672`) with broken floor levels. The confirmed resistance ceiling remains 100% locked to its structural peaks.
    - *Active Valley Floor Fallback & Zero Empty Space Dilation*: When no 2-touch support cluster exists below the active wave low, `bottomBound` moves down to the lowest valley of its own active wave (`activeValley.price` = `0.2045`). When both bounds are anchored to genuine structural points (resistance cluster + active valley), the channel is marked as `NATURAL_SWING`, completely eliminating artificial dilation to `0.216844` in empty space. Inverted `UPPER_CEILING` clamping (which previously pushed ceiling upward) was reversed to anchor the ceiling and adjust the floor if needed.
    - *Breakdown Channel Invalidation & S/R Flip*: Support clusters MUST sit at or below current price (`price <= currentPrice * (1 + tol)`). When price breaks down below the previous support floor, that old channel becomes invalid. The broken support level above price flips to become the NEW resistance ceiling.
    - *Lowest Active Wave Valley Fallback (Strict Confirmed Swings Only)*: If no confirmed multi-touch support ($\ge 2$ touches) exists below current price, the engine strictly anchors `bottomBound` to the confirmed lowest valley of its own active wave (`activeValley` or `swingLows.pop()`). **`candidateValley` (unconfirmed real-time wicks) is completely forbidden from serving as floor**, eliminating the critical bug where falling prices dragged the lower bound down continuously in real time.
    - *Absolute Elimination of `candidatePeak` from Channel Boundaries*: Symmetrically, **`candidatePeak` (unconfirmed real-time wicks of the live candle) is completely forbidden from serving as ceiling or channel bound**. Previously, as price rallied in real-time, `candidatePeak` updated on every tick, dragging `upperBound` and the entire channel upward continuously. Resistance is now strictly anchored to closed, confirmed swing highs (`this.swingHighs`).
    - *Left-Scan Multi-Touch S/R with Active Wave Peak/Valley Fallback*:
      - Looking from current price:
        - **Resistance**: Search peaks to the left above current price (`price >= currentPrice * (1 - tol)`). If a peak has $> 1$ touch point ($\ge 2$ touches), use it as resistance. If a peak has only 1 touch, keep searching. If no peak above price has $> 1$ touch, fallback strictly to the highest confirmed peak of its own active wave (`activeCeilingPoint` / `activePeak` / `confirmedHighs`, never `candidatePeak`).
        - **Support**: Search valleys to the left below current price (`price <= currentPrice * (1 + tol)`). If a valley has $> 1$ touch point ($\ge 2$ touches) and was not penetrated by the active wave low, use it as support. If a valley has only 1 touch, keep searching. If no valley below price has $> 1$ touch, fallback strictly to the confirmed lowest valley of its own active wave (`activeValley` / `recentConfirmedLows`, never `candidateValley`).
    - *Lower 2-Touch Resistance Prioritization ("ถ้ามี สองจุดที่ต่ำกว่า ถือให้ใช้กรอบนั้น")*: When selecting resistance near/above price, `findMultiTouchSR` prioritizes confirmed multi-touch resistance clusters ($\ge 2$ touches) sorted ascending by price (`(a, b) => a.price - b.price`). If lower 2-touch peaks exist near price (e.g. double top at $0.2050), the engine strictly locks onto that lower 2-touch ceiling instead of jumping to a higher distant single peak (e.g. $0.2080$).
    - *Absolute Elimination of Midpoint Dilation (`diff / 2`)*: Completely eliminated the symmetric dilation logic (`upperBound += diff / 2; bottomBound -= diff / 2;`) across all channel modes. Channel boundaries are strictly and unconditionally locked to genuine calculated peaks and valleys shown on the chart. Zero lines float in empty space.
    - *Higher Low Floor Lift & Canonical Alternating Swings ("ตรงจุดนี้เป็นเหวได้อย่างไร ในเมื่อมองไปทางซ้ายก็ไม่มียอด")*: In Dow Theory, swings must strictly alternate (`Peak -> Valley -> Peak -> Valley`). A point can ONLY be a valley if there is a preceding peak to its left. `activeValley` and `activePeak` are now strictly derived from `waveCycle.annotatedSwings` (canonical alternating ZigZag swings), completely eliminating bogus valley markers from forming under green candles in the middle of a continuous vertical rally. When price establishes a confirmed Higher Low (`HL`), `baseValley` locks to this canonical Higher Low, lifting the floor and unlocking the upper bound.
    - *Single-Point Reference Support & Resistance ("1 จุดก็ต้องแสดง")*: Even if a side lacks a multi-touch cluster ($\ge 2$ touches), `findMultiTouchSR` strictly returns the confirmed structural valley / peak as `support` or `resistance` (`touchCount = 1`, `points = [chosenPoint]`). Streams the target icon (`🎯`) to the chart (cyan for support, magenta for resistance). **The channel bounds (`bottomBound` / `upperBound`) are strictly locked 100% to the exact price of the marked swing point**, completely forbidding artificial dilation (`upperBound - minSpanFromPct`) that previously pushed bounds into empty space where no valley existed.
- **Position Lock while in Inventory (`lockChannelInPosition`) & DB Persistence**:
  - Automatically freezes/locks the active channel bounds (`lowerBound`, `upperBound`, `centerPrice`, `buyLevels`, `sellLevels`) while holding inventory (`baseHeld() > 0`).
  - **Strict Floor Protection While in Position (ห้ามปรับกรอบล่างขึ้นเด็ดขาดเมื่อมี Position)**:
    - When holding inventory (`baseHeld() > 0`), `lowerBound` can **ONLY remain flat or adapt downwards** to lower support/LL.
    - **It is strictly forbidden from rising/increasing while in position**: Raising the floor would immediately lift `cutLossBound` and cause an accidental, premature cut loss on the held inventory. Floor can only rise once the position is completely closed (100% cash).
  - **Major Ceiling Adaptation While in Position & Active Resistance Protection**:
    - If a confirmed Major Resistance Cluster ($\ge 2$ touches) forms BELOW the locked `upperBound`, the bot can adapt to lower `upperBound` only if it belongs to the active wave.
    - **Active Resistance Floor Protection**: The ceiling is strictly forbidden from lowering below the active confirmed 2-touch resistance (`dow.resistanceCluster.price`, e.g. `0.2181`). If previous locked bounds were lower, it automatically restores the ceiling back up to `dow.resistanceCluster.price`.
    - **Broken Cluster Filtering**: `allResistanceClusters` and `allSupportClusters` strictly exclude broken historical clusters that were penetrated by subsequent wave rallies, preventing ancient levels (such as 0.2149 from before a 0.2186 rally) from falsely pulling down the ceiling.
  - Persists `lockedChannel` to `grid-bot.db.json` in `saveState()` and restores it in `loadState()`, preventing channel shifts across restarts, crashes, or hot-reloads.
  - Keeps resting limit sells and the cut-loss floor rock-solid and stable.
  - Automatically unfreezes immediately when position returns to 0 (flat/cash), letting the bot calculate a tight, fresh channel around current market price for the next accumulation cycle.
- **Guaranteed Startup Pause & Strict Liquidation Gate (`START_PAUSED`)**:
  - `startPaused` enforces `this.isPaused = true` on boot regardless of previous database state.
  - **Strict Liquidation Gate**: `Cut Loss`, `Take Profit`, and `Triangle Squeeze` liquidations are strictly suspended while `this.isPaused` is true, preventing accidental fire-sale dumps on startup before the channel confirms.
  - `isBelowFloor` requires a confirmed channel (`isChannelReady`); warming up never triggers cut loss.
  - Automatically resets stale `waitingForHigherLow` if current market price is safely inside/above the active channel.
    - *Breakout Resistance Fallback to Multi-Touch Cluster ("จุดที่แตะทั้ง 4 ยอดได้")*: When price has broken above ALL confirmed peaks (no confirmed swing high ≥ `currentPrice * (1 - tol)`, e.g. new high still `Peak (2/3)`), `findMultiTouchSR` now uses the highest valid multi-touch resistance cluster (≥2 touches, priced at `min` of its peaks so the line touches all of them, e.g. 0.2105 touching 0.2111/0.2109/0.2113/0.2105) instead of the last single swing high (previous bug: ceiling fell to an unrelated single peak 0.2097). Falls back to the last single swing high only if no multi-touch cluster exists.
    - *findMultiTouchSR Parameter Order Alignment*: Fixed parameter signature misalignment where `maxSpanPct` was placed as 8th argument in definition but passed as 6th argument by caller (`getStructure`), which previously caused `maxSpanPct` to receive `activeValley.price` (~0.205%), causing `inRange` to be false for all pairs and discarding multi-touch bonuses. Corrected signature: `(currentPrice, lookbackBars, minTouchCount, tolerancePct, minSpanPct, maxSpanPct, activeWaveHigh, activeWaveLow)`.
    - *Strict Structural Pairing within Min/Max Channel Width (`[minChannelWidthPct, maxChannelWidthPct]`)*: When determining channel bounds, `findMultiTouchSR` evaluates combinations of genuine confirmed peaks above price and genuine confirmed valleys below price to find the optimal pair $(S, R)$ whose width $(\frac{R - S}{S} \times 100\%)$ satisfies `[minChannelWidthPct, maxChannelWidthPct]` (e.g. 3%–6%). If the closest peak and valley are narrower than `minChannelWidthPct`, the engine automatically selects the next confirmed peak (or next confirmed valley) on the chart so the channel widens to $\ge \text{minChannelWidthPct}$. **Zero floating lines or artificial dilations in empty space** — every boundary is strictly anchored to a real peak and valley marked on the chart.
    - *Broken Resistance Invalidation & Enclosing Price Enforcement ("กรอบไม่ขยับ ไม่มี position ด้วย")*:
      - **Ceiling Must Be Above Current Price**: When confirmed peaks exist at or above current price, candidates below current price are strictly disqualified from `resCandidates`. Completely fixes the critical bug where an old resistance cluster from 40 bars ago (e.g. 0.2149) sitting *below* current price (0.2157) was selected because `minResPrice = currentPrice * (1 - tol)` allowed it, freezing the channel below market price and trapping the bot in `ABOVE_CEILING_FULL_EXIT` with zero position.
      - **Broken Resistance Filtering**: If price rallied and established a higher peak (`activeWaveHigh` / `activePeak`), any historical resistance sitting below `activeWaveHigh * (1 - tol)` was penetrated and broken by the breakout, and is excluded from `resCandidates`.
      - **Enclosing Price & Active Wave Priority in Pairing**: Pairs that enclose current price ($S \le \text{currentPrice} * 1.001$ and $R \ge \text{currentPrice} * 0.999$) receive a decisive +1000 point bonus, while pairs that leave price outside the channel receive -2000 penalty. Candidates matching `activeWaveHigh` (`HH`) and `activeWaveLow` (`HL`) receive +600 points each, guaranteeing that new breakout waves (e.g. `HH` at 0.2182) immediately lift the channel instead of being held back by ancient 2-touch clusters from previous cycles.
    - *Dow Theory HH/LL Boundary Protection & Lower High Adaptation ("ถ้ายอดในราคาปัจจุบันทำ Lower high สามารถปรับลดกรอบลงมาได้")*:
      - **Ceiling Max Peak Pricing**: Resistance clusters in `clusterPoints` now price at $\max(p.\text{price})$ (and support at $\min(p.\text{price})$). When a new Higher High (`HH`) forms within a cluster, the ceiling encompasses the full height of the breakout instead of dropping to the older, lower peak.
      - **Strict Dow Theory Ceiling Preservation Prior to LH**: If the latest confirmed peak in the active wave is a Higher High (`HH`), the market made a new high. The ceiling CANNOT be reduced below that confirmed `HH` until the market forms a confirmed Lower High (`LH`): `upperBound = Math.max(upperBound, lastCanonicalHigh.price)`.
      - **Lower High (LH) Ceiling Adaptation ("กรอบสามารถปรับลดลงมาได้ ถ้ายอดในราคาปัจจุบันทำ Lower high")**: As soon as the active wave forms and confirms a genuine Lower High (`LH`) that price is actively respecting (`lastCanonicalHigh.dowLabel === "LH"` and `price <= lastCanonicalHigh.price * 1.005`), `upperBound` and `activeCeilingPoint` step down to this confirmed Lower High, and `findMultiTouchSR` awards it a decisive +3000 priority bonus.
      - **Multiple Candidate Lower Highs Search in Downtrends**: When active wave is in a downtrend (`waveCycle.bias === "DOWNTREND"` or `waveCycle.phase === "LOWER_HIGHS_LOWS"`), the engine evaluates all confirmed Lower Highs in `canonicalHighs` (not just the single latest one) to adapt `upperBound` down to the highest valid Lower High that fits inside `[minSpan, maxSpan]`, preventing the ceiling from staying trapped at ancient double tops (e.g. 0.2168) when channel width exceeds `MAX_CHANNEL_WIDTH_PCT`.
      - **Strict Multi-Touch Pairing Score Clamping (Elimination of Out-of-Range Inversion)**: In `findMultiTouchSR`, pairs with `widthPct > maxSpanPct` previously received inverted high scores ($(1000 - widthPct) \times 10 \approx 9917$). Score is now strictly capped below in-range pairs (`Math.max(0, 3000 + multiTouchBonus - excessWidth * 1000)`), guaranteeing that in-range structural pairs always take precedence.
      - **Channel Width Cap (`MAX_CHANNEL_WIDTH_PCT`) in `MULTI_TOUCH_SR`**: In `getStructure`, if the selected bounds exceed `maxSpanFromPct` (default 6.0%), the ceiling adapts down to the highest confirmed Lower High within range or strictly clamps to `bottomBound + maxSpanFromPct`. Channels are never allowed to blow out to 8.24%+.
      - **Position Lock Lower High Adaptation & Max Width Enforcement in Strategy**: While holding inventory (`baseHeld() > 0`):
        - Restoring `upperBound` to `dow.resistanceCluster.price` is strictly guarded against exceeding `maxAllowedSpan = lowerBound * (maxChannelWidthPct / 100)`.
        - If locked channel width exceeds `maxAllowedSpan`, the bot automatically adapts `upperBound` down to `dow.upperBound` or `lowerBound + maxAllowedSpan`.
        - Adapts the locked ceiling down to confirmed Lower Highs (`LH`) above the floor (`(lhPrice - lowerBound) / lowerBound >= 1.5%`) without being blocked by ancient resistance clusters, securing profit at the new structural resistance and updating all 4 resting sell targets accordingly.
      - **Strict Dow Theory Floor Preservation**: Symmetrically, if the latest confirmed valley is a Lower Low (`LL`), the floor CANNOT be lifted above that confirmed `LL` until the market forms a confirmed Higher Low (`HL`): `bottomBound = Math.min(bottomBound, lastCanonicalLow.price)`.


- **Wallet & Gas Reserve Telemetry Guard & Hard Limit Sell Gate**:
  - **Dynamic Gas Reserve Baseline (`getEffectiveGasReserveSomi()`)**:
    - Instead of a rigid constant reserve (e.g. 59.0 SOMI) which caused lot clamping and cancel loops whenever tiny gas fees (0.002 SOMI) were deducted from the wallet, the reserve baseline temporarily flexes downward by uncompensated transaction gas (`effectiveGasReserve = Math.max(0, minGasReserveSomi - (totalGasSpentSomi - totalGasDeductedSomi))`).
    - Trading inventory (`baseHeld()`) remains 100% constant and is NOT cannibalized or clamped by gas fees.
    - When buy orders fill, gas compensation (`compSomi`) in `processBuyFill` increments `totalGasDeductedSomi`, naturally and smoothly restoring the reserve baseline back up toward `minGasReserveSomi` (59.0 SOMI).
  - `gasReserveSomi` is strictly capped at `Math.min(walletSomiBalance, getEffectiveGasReserveSomi())`.
  - **Inviolable Gas Reserve Protection on All Sells**: Placing ANY resting Limit Sell or IOC Taker Sell strictly checks available wallet balance above the effective gas reserve: `availableSomiInWallet = Math.max(0, walletSomiBalance - effectiveGasReserve)`. The bot **NEVER pulls, escrows, or sells initial native SOMI gas reserve balance**. If `availableSomiInWallet < minQty`, order placement is aborted immediately with `[GAS GUARD]`.
- **Multi-Pillar Active Inventory Reconcile & Real-Time Partial Fill Engine**:
  - Completely eliminates lot-drift, phantom lots, missing partial fills, and ambiguity between multiple sell targets:
  - **Pillar 1: Real-Time Contract State Tracking (`quantityRemaining` via `getOrder`)**:
    - Every tick, loops through all active `openOrderIds` and calls `getOrder(id)` directly on the DreamDEX SpotPool contract.
    - Compares `remainingQty` with `alreadyTracked.qty`. If `remainingQty < prevRemaining - 0.0001`, a **Partial Fill** is detected immediately on-chain!
    - Processes the filled delta (`prevRemaining - remainingQty`) via `processSellFill` or `processBuyFill`, updating the in-memory order's `qty` and notional value.
    - Zero lots are missed or unallocated when takers take partial bites out of resting limit orders.
  - **Pillar 2: Blockchain Event Logs Auditing (`OrderFilled` & `OrderCancelled` via `getLogs`)**:
    - When an order disappears from `openOrderIds` (closed on-chain), queries recent blockchain Event Logs (`TOPIC.OrderFilled` and `TOPIC.OrderCancelled`) matching the order's ID in `topics[1]` or `topics[2]`.
    - Confirms fills and cancels with 100% indisputable cryptographic proof from the block receipt, capturing the true on-chain `transactionHash`.
  - **Pillar 3: Unambiguous Balance-Delta Fallback & Zero Market-Price Guessing**:
    - If RPC log queries time out or orders closed while the bot was offline, falls back ONLY to high-confidence balance deltas (`deltaSomi >= stale.qty * 0.85` or `deltaUsdso >= stale.notionalUsdso * 0.85`).
    - **Zero Market-Price Guessing**: Ambiguous disappeared orders without fill event logs or balance arrival are strictly treated as **CANCELLED** (`isBuyFill = false`). Completely eliminates phantom lots caused by previous `refPrice <= stale.price * 1.001` guesswork.
  - **Pillar 4: Active Multi-Pillar Two-Way Inventory Reconcile (`reconcileInventory`)**:
    - Calculates true physical trading capacity: `maxAllowedTradingSomi = Math.max(0, (walletSomiBalance + somiInOpenSells) - minGasReserveSomi)`.
    - **Direction 1 (Guard Against Phantom Lots)**: If strategy memory lots exceed capacity (`memoryHeld > maxAllowedTradingSomi`), automatically clamps `this.lots` to `maxAllowedTradingSomi` (`clampLotsTo`).
    - **Direction 2 (Adopt Unallocated Physical Trading Inventory)**: If physical trading capacity exceeds memory lots (`maxAllowedTradingSomi > memoryHeld + 1.0 SOMI`), automatically adopts the unallocated SOMI into `this.lots` as an active lot at current reference price. Guarantees that no physical coins remain stranded in the wallet, ensuring they are placed into limit sell tranches and fully liquidated on Cut Loss / 100% Take Profit.
    - If resting sell orders exceed capacity (`somiInOpenSells > maxAllowedTradingSomi`), automatically cancels excess resting sell orders on-chain, refunding the native SOMI directly back into the wallet to restore the user's initial gas reserve.
  - **Zero Cost-Basis Corruption on `Cancel All`**:
    - `this.lots` is the permanent, truthful ledger of acquired lots. Cancelling resting orders never changes lot prices or portfolio `avgEntry`.
  - **Guard Against Redundant IOC Sells on Already-Matched Levels**:
    - In both standard and trendline sell routines, the bot verifies if a sell level has no resting order AND has already satisfied its inventory reduction target (`currentHoldFraction <= targetHoldingFraction || isInventoryFullyCovered`).
    - If fulfilled, the level is immediately skipped, preventing the bot from attempting repeated IOC taker sells on already-matched lower targets.
- **4-Level Equal Sell Tranches & Anti-Churn Rule**:
  - **4 Equal Tranches (25% each)**: Total held inventory is divided equally across the 4 sell targets (`held / 4`). If Level 1's grid price is below best bid, it is floated to the minimum valid Maker ask (`max(lvlPrice, currentBestAsk, refPrice * 1.0005)`) so Target 1 is NEVER skipped or abandoned. Eliminates dumping a 50% remainder on Target 4.
- **Immediate-Or-Cancel (IOC) Take-Profit on Exceeded Sell Levels (`ENABLE_IOC_SELL_WHEN_EXCEEDED`)**:
  - **Strict Maker Preservation (No IOC Churn)**: If an active resting Maker limit sell order ALREADY exists for a level (`currentOpenSellAtLvl`), the bot **NEVER** cancels it to attempt an IOC taker sell. It lets the resting order stay in the queue to be matched naturally as Maker (0 fee/rebate, 0 gas cancel/re-create churn).
  - IOC taker selling (`ORDER_TYPE.ImmediateOrCancel`) is strictly reserved for **uncovered inventory** where **NO resting order exists** (`!currentOpenSellAtLvl`) and the market bid meets or exceeds the target price (`currentBestBid >= originalLvlPrice`).
  - Protected by a DEX bid discount guard (`cutLossMaxBidDiscountPct`, default 2.5%) and `sellProfitMode` rules.
- **3 Take-Profit & Sell Profit Modes (`sellProfitMode` / `DGRID_SELL_PROFIT_MODE`)**:
  - `GRID_CASHFLOW` (Default): Places sell orders at all grid upper ladder levels (50%–100%) regardless of whether the price is above or below portfolio `avgEntry`. Ensures continuous turnover and cash-flow recovery when the channel shifts lower. Closes lots via FIFO.
  - `PORTFOLIO_AVG_PROFIT`: Strict safeguard. Only places sell orders if the price exceeds portfolio `avgEntry * 1.001` (+0.1% fee margin). Prevents any aggregate loss on inventory.
  - `LOT_BASED_PROFIT`: Per-lot profitability matching. Only allocates inventory for sell orders from lots acquired below the sell target price (`lot.buyPrice < targetPrice`). Closes lowest-cost (most profitable) lots first.
- **Hold Timeout Limit Safeguard (`stuckTimeoutMs`, 0 = Disabled by Default)**:
  - **Elimination of Arbitrary 15m Premature Cut Loss**: An old legacy static-grid timer (`stuckTimeoutMs = 15m`) previously unwound positions at market bid after 15 minutes of holding, even when price was consolidating safely within a 15M candle and Dow structure was in an uptrend.
  - Set `stuckTimeoutMs: 0` by default (disabled).
  - Exposed `Hold Timeout Limit (Minutes)` in the Web Dashboard settings under "Execution & Guard", allowing traders to keep it disabled (`0 = off`) or configure custom holding limits if desired. When disabled, positions are held patiently until Take Profit targets are reached, or until true structural Cut Loss (`isBelowFloor = true`), Max Session Loss, or Triangle Squeeze occurs.
- **Configurable Chart & Dow Timeframe (`dowTimeframe`, Default 15m)**:
  - Previously defaulted to `1h` without any UI setting, causing the bot to calculate macro bounds and stream 1H candles to the chart.
  - Updated default `dowTimeframe` to `15m` to match standard intraday dynamic grid trading.
  - Added `Chart & Dow Timeframe` dropdown selector to the Web UI Settings under "Market Structure" (`15m`, `1h`, `4h`, `5m`, `1m`), saved directly to `db.settings`.
- **Configurable Candle Loading & Stored Capacity (`initialCandleCount: 300`, `maxCandleCount: 600`)**:
  - **Initial Candle Load (`initialCandleCount`, Default 300)**: Pre-loads 300 historical candles from Binance REST API on boot (configurable from 50 to 1,000 candles), providing ample historical depth for Dow Theory swing pivots and multi-touch support/resistance clustering.
  - **Max Stored Candles (`maxCandleCount`, Default 600)**: Retains up to 600 candles in memory and chart buffer (configurable from 100 to 2,000 candles).
  - **Live UI Tuning & Instant Re-fetch**: Configurable via Web UI Settings under "Market Structure". When the user updates `initialCandleCount` or `dowTimeframe` and saves settings, the bot immediately re-fetches the requested number of candles from Binance, re-runs Dow Swings on the fresh dataset, updates the dashboard buffer, and live-streams them to the chart via `candles_batch` without requiring a bot restart.
  - **Unified Structure Lookback (`srLookbackCandles`, Default 300)**: Peak/Valley wave-cycle detection (`calculateWaveCycles`, previously hardcoded 120 bars), trendlines (`calculateTrendlines`, previously hardcoded 100 bars) and multi-touch S/R clustering (`findMultiTouchSR`) all share ONE window `structureLookback`, synced from `srLookbackCandles` on every `getStructure()` call (both macro and local trend engines). S/R can only cluster peaks/valleys that the wave engine actually found, so the two windows must always match.
- **Order Management & Sell Lockout Safeguard**:
  - In downward-shifting channels, grid levels may fall below open inventory's `avgEntry`. If strict average profit is enforced, the bot cancels old resting sells during channel shift and refuses to place new ones, freezing grid turnover. `sellProfitMode` allows switching between pure cash-flow oscillation and strict profit locks.
- **Risk Safeguards**:
  - `DOW_TREND_FILTER` & `TRENDLINE_FILTER`: Pauses buying when market forms Lower Highs + Lower Lows or stays under downtrend line.
  - `ENABLE_TRIANGLE_SQUEEZE_EXIT`: Liquidates to cash when support and resistance trendlines converge tighter than `1.0%`.
  - `GRID_CUTLOSS_MAX_BID_DISCOUNT_PCT` (2.5%): Prevents selling into hollow flash dumps on DreamDEX when DEX bid lags behind Binance.
  - `Hysteresis`: `MIN_CHANNEL_SHIFT_PCT` (1.0%) & `ORDER_PRICE_TOLERANCE_PCT` (0.8%) prevent order churn and unnecessary gas fees.
- **Truthful Bot State & Trigger Telemetry (Capacity Full & Trendline Exit)**:
  - **Accurate Status Pill & Bot Action**:
    - When inventory reaches $\ge 95\%$ or within $\$1.0$ of `maxInventoryUsdso`, the bot no longer displays a generic `"Target Met"`. Instead, it displays `"📦 Capacity Full (99%)"`, with subtitle clearly stating buying is paused due to full inventory.
    - When an active descending trendline suppresses resting sell orders above it and forces an IOC sell at the trendline price, the status truthfully shows `"📉 Waiting TL Sell Exit"`, with trigger stating `"IOC Sell @ Trendline ($0.2075)"`.
  - **Dynamic Next Sell Trigger Alignment**:
    - When an active descending trendline is present and lower than grid sell levels, `sellTrigger` dynamically reflects the Trendline price (`tlPrice`) instead of an unreachable upper grid level, and the HUD displays `"TL Exit (Active 🔴)"`.
  - **Truthful Buy Trigger Status**:
    - When inventory is full, the HUD subtitle under Buy Trigger switches from `"Ready to Accumulate"` to `"Capacity Full (100%)"`, avoiding confusing traders about why no buy orders are being placed.
- **Startup Pause & Decoupled Monitoring Mode (`START_PAUSED`)**:
  - The bot boots into a safe **PAUSED** state by default (`startPaused: true`).
  - **Decoupled Monitoring**: Even while paused, the bot fully runs `topOfBook()`, `dowEngine.getStructure()`, S/R multi-touch clustering, wave cycle tracing, and live trendlines, streaming real-time telemetry to the web dashboard.
  - **Unconditional Telemetry Streaming**:
    - **Elimination of Premature Returns Before Telemetry**: Previously, early `return;` statements in Cut Loss (`if (this.isPaused) return;`), Take Profit, Triangle Squeeze, and wide DEX spread checks aborted `tick()` before reaching line 2223 (`this.emit({ type: "tick", ... })`). This caused the dashboard to freeze with `--.------`, `DOW: WARMUP`, and zero lines on chart when price dumped below the floor or when paused.
    - All early returns were converted to order execution gates (`if (!this.isPaused)` and `if (this.isPaused || isSpreadDislocated) return;` at the trading gate after telemetry emission).
    - `emitTelemetryTick()` now caches and merges `lastTelemetryData` so settings updates or reloads never wipe out Dow structure, S/R bounds, or regime badges.
  - **Trading Gate**: Order placement, resting order cancellation, and position liquidation are strictly suspended until the user explicitly toggles "Resume" on the web dashboard (via `/api/bot/pause`).
- **IOC Bracket Order Sweep & Elimination of Phantom Maker Overlap**:
  - In `IOC_BRACKET` mode, resting BUY limit orders are strictly swept and cancelled from the book upon startup and sync, guaranteeing resting maker buys never compete or overlap with IOC accumulation.
  - **Elimination of Resting Order Hijacking and Duplicate Trade Matches in IOC Mode**:
    - **Root Cause**: When an IOC Buy executed, `this.processBuyFill` emitted a `BUY_FILL` event. In `db.ts`, `recordEvent` lacked an IOC check and fell back to fuzzy price matching (`Math.abs(o.price - price) / price <= 0.001`), accidentally hijacking an old resting maker order (e.g. `Buy Level 4 (10%)` at $0.21035 vs IOC at $0.2105) and marking it `FILLED` with the IOC transaction hash (`...152e`). Furthermore, redundant `this.db.insertTrade(...)` calls in `strategy.ts` inserted a second `BUY_FILL` record for the same transaction, resulting in two simultaneous buy fill cards on the dashboard.
    - **Strict IOC Taker Isolation**: `recordEvent` in `src/db.ts` now explicitly detects IOC / taker orders (`isIocOrder`). IOC executions NEVER match or mutate existing resting maker orders in `this.data.orders`, always creating dedicated taker records.
    - **Safe Maker Fill Matching**: Maker fills only transition existing open orders if `orderId` matches on-chain `o.orderId === orderId`, or in `dryRun` mode when unassigned virtual orders match price. Live orders without matching `orderId` can never hijack resting orders.
    - **Orphaned Duplicate Prevention & Complete Cancellation**: In `db.ts`, `CREATE_BUY` and `CREATE_SELL` deduplicate by on-chain `orderId`, and `CANCEL_BUY` / `CANCEL_SELL` mark ALL open duplicates matching that `orderId` as `CANCELLED`.
    - **Removal of Redundant Database Inserts**: Removed redundant `this.db.insertTrade(...)` and `this.db.insertOrderActivity(...)` calls across `buyTrancheIOC`, `sellTrancheIOC`, `takeProfitIoc`, `placeRestingOrder`, and `sellAll` in `src/strategy.ts`, as `this.emit()` already records all order activity.
    - **Pillar 0 & Unmanaged Buy Sweeps**: When sweeping lingering or unmanaged resting buys in `IOC_BRACKET` mode, `strategy.ts` now emits `CANCEL_BUY` to guarantee the database transitions them to `CANCELLED`.
    - **Self-Healing Database Migration (`cleanupHijackedMakerFills()`)**: Automatically runs on database load to detect and revert any historical resting maker orders falsely marked `FILLED` that collided with an IOC transaction hash, restoring them to `CANCELLED` and cleaning up the dashboard Trade Matches history.
  - **Balance Delta Phantom Fill Fix**: When an IOC BUY fills, wallet SOMI balance rises immediately. Previously, `syncOnChainOrders` evaluated `somiArrived` as true for stale/cancelled maker orders, emitting a duplicate `BUY FILL` (e.g. `Buy Level 3 (20%)`) at the exact same timestamp as the IOC buy. Now, `somiArrived` strictly ignores maker buy fills in `IOC_BRACKET` mode, and `lastObservedSomiBalance` is updated immediately upon IOC completion.
  - **Compact & Clean Activity Feed & Sleek Tx Display**:
    - Stripped redundant nested wrappers (e.g. `(IOC BUY [IOC Buy Level 1])` -> `(IOC Buy Level 1)`).
    - Expiration string (`[Expires: 0h]`) is suppressed for all executed/filled trades, rendering strictly for active resting orders on the book.
    - Suppressed redundant reason strings when identical to the level description or covered by the gas compensation badge.
    - Compacted verbose tx badges from `0xa195...3e27` down to sleek `⛓️ ...3e27` with full hash displayed in the explorer tooltip.
    - **PnL Display & Dual-Layer Auto Backfill / Fallback**:
      - Sell fills and market exits record both `pnl` and `pnlUsdso` symmetrically in `strategy.ts` and `db.ts`.
      - **Database Auto-Backfill (`backfillMissingSellPnl()`)**: On DB startup, automatically iterates all historical fills chronologically, reconstructs inventory entry cost, computes `(price - avgBuyPrice) * qty` for any historical sell fills where `pnl` was omitted/undefined, and flushes to disk.
      - **Client-Side Pre-Pass & Fallback**: In `app.js` `connectSSE()`, a chronological pre-pass computes PnL for historical sell orders when loading initial state, and `createActivityElement` provides a direct prior-buy fallback lookup.
      - **Sleek PnL Badge Pill**: Rendered as a distinct styled pill badge (`act-pnl-badge`) with translucent green/red backgrounds (`+$0.21` / `-$0.05`), ensuring PnL is always visible and prominent.
- **Buy Above Trend Support (`enableBuyAboveTrendSupport`) & Breakdown Accumulation**:
  - **Trendline Support Entry ("ถ้าเลย buy target สามารถเข้าซื้อได้ที่เส้น trend")**:
    - When an ascending trend support line (`activeUptrendLine`) is active and sits above standard grid buy levels (`tlPrice > buyLevels[0]`):
      - In `IOC_BRACKET` mode: When price tests or reaches the trendline (`currentBestAsk <= tlPrice * 1.002 && currentBestAsk >= tlPrice * 0.990`), triggers `IOC Buy @ Trendline Support` for 1 tranche.
      - In `MAKER_LIMIT` mode: Floats the top buy level to the trendline support price (`Buy TL Support ($...)`), while suppressing lower resting levels while price rides above the trendline.
  - **Breakdown Grid Accumulation ("ถ้าหลุดไปรอซื้อที่ level ตาม position การถือครอง")**:
    - When price breaks down below the trendline, the bot does **NOT** pause buying (`!uptrendBroken` is removed from blocking `canBuy`).
    - The trendline suppression filter is deactivated once below the trendline, enabling immediate accumulation down the normal grid ladder.
    - Remaining available capacity (`maxInv - currentHeldUsdso`) is distributed across grid levels according to actual inventory held, accumulating safely down the grid.
    - **Deep Description Deduplication & Numeric-Only Order ID**:
      - Suppressed generic action labels (`TAKE_PROFIT`, `SELL`, `BUY`, `CUT_LOSS`, `CUT`, `EXIT`) from level descriptions.
      - Stripped trailing target wrappers (e.g. `(Target: $0.212030)`) and nested IOC brackets.
      - Compacted aggregated targets (e.g. `Aggregated 4 targets up to Target 4` $\rightarrow$ `T1-T4 (4x)`).
      - Suppressed redundant reason text when identical to or already included within `levelDesc`.
      - Strict numeric-only check on order ID (`/^\d+$/` and not starting with `0x`) prevents raw 66-character tx hashes from rendering as `#0x8dc5...` after action labels.
  - **Trade & Lot Manager Real-Time Front Page Sync**:
    - Whenever a trade or lot is deleted, cancelled, edited, or added via Trade Manager:
      - Helper `removeActivityItem(id)` immediately removes matching `.activity-item` elements across all feed DOMs (`elTradesFeed`, `elOnchainFeed`, `elAllFeed`) using `data-order-id`, `data-clob-id`, and `data-txhash` attributes, and decrements feed count badges.
      - Helper `refreshFrontPageState()` fetches `/api/state` and invokes `updateTick(data.latestTick)` to immediately refresh inventory KPIs (`#lotsCount`, `#topPosBase`, `#topPosUsd`, `#posUnrealizedPnl`) on the front page.
      - Server endpoint `/api/db/trades/delete` automatically filters out deleted orders from `this.recentOrders` to prevent resurrected orders on page refresh, and broadcasts `trade_deleted` / `lots_updated` via SSE to trigger `removeActivityItem` and `refreshFrontPageState` across all connected tabs.
  - **Inventory-Based Round Tracking (Elimination of Time Collisions & Premature Round Splits)**:
    - Previously, `calculateTradeRounds` prematurely closed an active round whenever any BUY arrived after a SELL (`inSellPhase && isBuy`), splitting rounds mid-cycle while holding inventory (e.g. 47.16 SOMI remained unsold in Round #23), which caused Round #23's `endTime` and Round #24's `startTime` to collide at the exact same minute (`11:15`).
    - Now, in a grid strategy, buys following partial profit-taking represent **re-accumulation within the active cycle**. A round remains active until:
      1. Remaining inventory is flat/dust (`buyQty - sellQty <= 0.5` SOMI or `sellQty >= buyQty * 0.98`), or
      2. Full liquidation / 100% exit / cut loss occurs.
    - Subsequent BUYs only initiate a new round after the previous cycle has completely closed out to flat cash. Eliminates overlapping timestamps and orphaned tokens.
- **Clean Chart Markers & Interactive Order Hover Tooltip**:
  - **Elimination of Wave Cycle Arrow Glyphs**:
    - Suppressed arrow shapes across all structure markers (`s.isPeak`, `s.isValley`, `data.activePeak`, `data.activeValley`, `data.candidatePeak`, `data.candidateValley`) by enforcing `shape: "circle", size: 0`.
    - Completely eliminates green and orange triangle arrowheads pointing at candlesticks, leaving only clean emoji + text labels (`⛰️ HH`, `🌊 LL`, `⭐ HL`, `⛰️ Peak`, `🌊 Valley`, `🎯 2x`) without visual clutter.
  - **Circular Order Badges Inside Circles (Elimination of Below-Dot Text)**:
    - Lightweight Charts' native `setMarkers()` draws text *outside* shapes (underneath the dot for `belowBar`), which caused "B" and "S" to render awkwardly below dots.
    - Implemented a dedicated high-performance **Circular Badge Overlay Layer** (`#chartOrderBadgesLayer`):
      - **SELL (`S`)**: Compact 17px circular badge in crimson red (`#e11d48`) with bold white `S` centered inside, positioned 12px above the candle high/wick.
      - **BUY (`B`)**: Compact 17px circular badge in vibrant green (`#10b981`) with bold white `B` centered inside, positioned 12px below the candle low.
      - **CUT LOSS (`CUT`)**: Pill badge in dark red (`#dc2626`) with bold white `CUT`.
      - Excluded order markers from `candleSeries.setMarkers()` to eliminate duplicate dots and disconnected text.
      - Real-time coordinate synchronization $(X, Y)$ across visible range changes, wheel zoom, mouse drag (60fps), and container resize.
      - Interactive hover: badges scale up smoothly on hover and display the detailed `#chartOrderTooltip`.
  - **Interactive Floating Crosshair Hover Tooltip (`#chartOrderTooltip`)**:
    - Built a high-performance $O(1)$ candle map (`ordersByCandleTime`) populated in `rebuildOrderMarkers()`.
    - Synchronized with `chart.subscribeCrosshairMove` and `chartContainer.mouseleave`: when the crosshair hovers over any candle bar with executions, a sleek floating card appears next to the cursor (with boundary detection preventing viewport overflow).
    - **Hover Card Details**:
      - Candle timestamp & trade count badge.
      - Individual order breakdown: Action badge (`BUY`, `SELL`, `CUT LOSS`), execution time (`HH:mm:ss`), price (`$0.207500`), quantity (`48.20 SOMI`), USDso value (`$10.00`), realized PnL (`+$0.27 (+1.35%)`), level description, and explorer Tx link.
      - Consolidated multi-fill summary (Total SOMI, Total USDso value, Net Realized PnL).

---

## 5. Coding Standards & Maintenance Rules

1. **ESM `.js` Extension**: Local imports must always include the `.js` extension (e.g. `import { config } from "./config.js";`).
2. **Decimals & BigInt**: Base token (SOMI) = 18 decimals, Quote token (USDso) = 18 decimals. Always use `fromRaw`, `toRaw`, and Viem helpers.
3. **State Consistency**: Any modification to lots or active orders in `strategy.ts` must call `this.db.saveState(...)`.
4. **Core Synchronization**: Do not bypass `@dreamdex-bot-kit/core` when placing or cancelling orders to ensure proper gotcha handling and nonces.
5. **ALWAYS Ask for Confirmation (Before Editing AND Before Push)**: The user explicitly instructed: **"ถามยืนยันทุกครั้งที่แก้ไข อันนี้ไม่จำไว้ซักที"** = ALWAYS ask for confirmation every time before modifying code. Workflow: (1) explain the root cause + proposed fix and ask the user to confirm BEFORE editing any file; (2) after editing and passing `npm run typecheck`, summarize the changes and ask again (`ask_question`, e.g. "(Recommended) ยืนยัน Commit และ Push ขึ้น GitHub") BEFORE running `git commit` / `git push origin main`. Never push without explicit confirmation.
6. **Mandatory Persistent Knowledge Update**: Whenever code modifications, new features, or bug fixes are introduced, `GEMINI.md` must be updated immediately with the architecture, operational logic, and rationale. This ensures that in any future session or check, the agent never needs to re-read or re-analyze the codebase from scratch.

---

## 6. Remote Production Host & Data Freshness Rules

> [!CAUTION]
> **Live Production Runs on a Remote Host**: The live trading bot runs on a remote server/cloud host, **NOT** on this local development machine.
> As a result, local workspace files (`.env`, `data/grid-bot.db.json`, `.grid-state.json`, and local logs) may be outdated, mock data, or not reflect live production conditions.

When investigating live production behavior, debugging issues, or analyzing trades:
1. **Do NOT assume local database/logs are current**: Always ask the user for the latest production files (e.g. current `data/grid-bot.db.json`, production `.env`, or live server console logs) before drawing conclusions.
2. **Explicit Target for Changes**: When proposing configuration tweaks or bug fixes, always clarify whether the change needs to be deployed to the remote production host or tested locally first.
3. **Non-Destructive Local Testing**: Never assume wiping or editing local database files affects the live bot on the remote host.
