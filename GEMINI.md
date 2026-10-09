# Dynamic Grid Binance Spot — Project Knowledge & Memory (`GEMINI.md`)

This document is the persistent operational and architectural knowledge base for `dynamic-grid-bn`. It is automatically loaded into the agent's context to ensure continuity across sessions without re-analyzing the codebase from scratch.

---

> [!IMPORTANT]
> ### 🚨 GOLDEN RULE: ถามยืนยันผู้ใช้ทุกครั้ง (STRICT CONFIRMATION PROTOCOL)
> 1. **ก่อนเริ่มแก้ไขโค้ด (Before Code Edits)**: ต้องอธิบายสาเหตุของปัญหาและแนวทางแก้ไขให้ชัดเจน จากนั้นถามยืนยันกับผู้ใช้ก่อนแตะต้องหรือแก้ไขไฟล์โค้ดเสมอ
> 2. **ก่อน Commit และ Push ขึ้น Git (Before Git Commit & Push)**: เมื่อแก้ไขโค้ดเสร็จและรัน `npm run typecheck` ผ่าน 100% แล้ว ให้สรุปสิ่งที่แก้ไขและใช้เครื่องมือ `ask_question` ถามยืนยันกับผู้ใช้ทุกครั้ง ห้ามรัน `git commit` หรือ `git push` เองโดยเด็ดขาดหากยังไม่ได้รับการกดยืนยันจากผู้ใช้
> 3. **อัปเดต Persistent Knowledge (`GEMINI.md`) เสมอ**: เมื่อใดก็ตามที่มีการแก้ไขโค้ด, ปรับแต่งตรรกะ, แก้ไขบั๊ก หรือเพิ่มฟีเจอร์ ต้องอัปเดตเนื้อหาลงใน `GEMINI.md` ทันที เพื่อให้ Memory ของ AI ตรงกับโค้ดปัจจุบันเสมอ

---

## 1. Project Architecture (`dynamic-grid-bn`)

> [!NOTE]
> `dynamic-grid-bn` เป็น **Standalone Universal Trading Bot** รองรับทั้ง **Binance Spot (CEX)** และ **DreamDEX on Somnia (DEX)** ผ่าน Pluggable Multi-Exchange Adapter Layer โดยไม่ต้องพึ่งพา Monorepo หรือรันข้ามโฟลเดอร์อีกต่อไป

```text
dynamic-grid-bn/                     # Project Root (c:\Sites\github\dynamic-grid-bn)
├── package.json                     # Dependencies: dotenv, ws, viem, tsx, typescript
├── data/
│   ├── settings.db.json             # Isolated Bot Settings configuration (clean & human-readable)
│   └── grid-bot.db.json             # ACID database for lots, orders, trades, and PnL persistence
├── public/                          # TradingView Lightweight Charts Dashboard UI
│   ├── index.html                   # Web dashboard layout & control modals
│   ├── app.js                       # Frontend event handling, chart rendering, SSE listeners
│   └── style.css                    # Dashboard dark theme styling
└── src/
    ├── index.ts                     # Strategy entrypoint (bootstraps feeds, engines, dashboard)
    ├── exchange/                    # Exchange Adapter Layer (Pluggable Multi-Exchange Support)
    │   ├── types.ts                 # IExchangeClient interface & standardized exchange types
    │   ├── index.ts                 # createExchangeClient factory loader
    │   ├── binance/                 # 🟡 Binance Module Folder
    │   │   ├── client.ts            # Binance Spot Adapter (implements IExchangeClient)
    │   │   ├── feed.ts              # Binance WebSocket feed (ATR, bookTicker, User Data Stream)
    │   │   └── index.ts             # Binance barrel export
    │   └── dreamdex/                # 🟣 DreamDEX Module Folder
    │       ├── client.ts            # DreamDEX On-Chain Adapter (implements IExchangeClient via viem)
    │       ├── indexer.ts           # Somnia GraphQL Indexer client
    │       └── index.ts             # DreamDEX barrel export
    ├── strategy.ts                  # Core DynamicGrid state machine, lots management, safeguards
    ├── market-structure.ts          # Dow Theory swing pivots, trendlines, 4 channel modes
    ├── config.ts                    # Strategy environment & DB settings loader
    ├── db.ts                        # JSON ACID state persistence (separates settings & orders)
    ├── server.ts                    # Real-time WebSocket + SSE + HTTP dashboard server (default port 3333/3334)
    ├── trade-rounds.ts              # Trade round cycle & performance calculations
    ├── types.ts                     # Shared interfaces & data types
    └── volatility.ts                # ATR calculation engine
```

---

## 2. Multi-Exchange Adapter Architecture & Spot Execution

1. **Exchange Adapter Pattern (`src/exchange/types.ts` & `src/exchange/index.ts`)**:
   - ประกาศ Standard Interface: `IExchangeClient` เพื่อรองรับการสลับระหว่าง Binance Spot (CEX) และ DreamDEX Spot (DEX) โดยไม่แตะต้องตรรกะใน Strategy
   - เมธอดมาตรฐาน: `getExchangeInfo`, `getAccountBalances`, `getOpenOrders`, `getOrder`, `getTopOfBook`, `placeOrder`, `cancelOrder`, `cancelAllOpenOrders`, `syncTime`
   - Factory function: `createExchangeClient({ exchange, ... })` เลือกกระดานผ่าน DB (`settings.exchange = "binance" | "dreamdex"`)
2. **Binance Spot Implementation (`src/exchange/binance/client.ts` & `src/exchange/binance/feed.ts`)**:
   - `BinanceClient implements IExchangeClient` (Default CEX Adapter)
   - เชื่อมต่อกับ Binance Spot REST API (`https://api.binance.com`)
   - รองรับโหมด `DRY_RUN=true` และ Live Trading (`apiKey`, `apiSecret`)
   - **Modern Binance WebSocket API v3 User Data Stream (`BinanceUserDataFeed`)**:
     - เนื่องจาก Binance ได้ทำการ Deprecate ระบบขอ `listenKey` แบบดั้งเดิม (`POST /api/v3/userDataStream` -> `410 Gone`) อย่างถาวร
     - ระบบได้รับการอัปเกรดเป็น **Binance WebSocket API v3 (`wss://ws-api.binance.com:443/ws-api/v3`)** เต็มรูปแบบ โดยสมัครรับข้อมูลผ่านเมธอด `userDataStream.subscribe.signature` พร้อมลายเซ็น HMAC-SHA256
     - รองรับการรับ `executionReport` (Order Fills / Partials / Cancels) และ `outboundAccountPosition` แบบ Real-time ทันทีในระดับ Milliseconds และส่งตรงเข้า `strategy.handleWsExecutionReport` โดยไม่ต้องรอ REST Polling อีกต่อไป
     - มีระบบ WebSocket Ping Keepalive อัตโนมัติทุก 3 นาที และ Reconnect พร้อม Resubscribe อัตโนมัติเมื่อหลุดการเชื่อมต่อ
     - มีการ Encapsulate ตรรกะของ Binance WebSocket API ทั้งหมดไว้ใน Module `src/exchange/binance/` อย่างเป็นสัดส่วน ไม่รั่วไหลไปยัง Layer ของ Strategy
3. **DreamDEX On-Chain Implementation (`src/exchange/dreamdex/client.ts` & `src/exchange/dreamdex/indexer.ts`)**:
   - `DreamDexClient implements IExchangeClient` (DEX Adapter for Somnia Network)
   - เชื่อมต่อ Somnia RPC ผ่าน `viem` (`publicClient`, `walletClient`) และเซ็นคำสั่งด้วย `privateKey`
   - เรียก Smart Contract `SpotPool` (`placeOrder`, `cancelOrder`, `getPoolParams`)
   - ซิงค์ประวัติ Order ย้อนหลังผ่าน Somnia GraphQL Indexer API (`SomniaIndexerClient` / `https://prd.smk.somnia.host/v1/graphql`)
   - รองรับคู่เทรดหลัก: `SOMI:USDso`, `USDC.e:USDso`, `WBTC:USDso`, `WETH:USDso`
   - **Real On-Chain ERC-20 Balances & Allowance**: ดึงยอดเงิน USDso และ Base token (WETH, WBTC, USDC.e) ผ่าน ERC-20 `balanceOf` บน Somnia RPC จริง โดยไม่ฮาร์ดโค้ด `quoteFree: 0` พร้อมระบบ `ensureAllowance` ตรวจสอบและ approve อัตโนมัติก่อนวางออเดอร์
   - **Credentials Masking Protection (`******`)**: ฟรอนต์เอนด์และแบ็กเอนด์แยกแยะระหว่างค่า Masking (`******`) กับ Private Key จริงอย่างเข้มงวด โดยจะไม่ส่งหรือเผลอ parse ข้อความ `******` เป็น private key เข้า `viem` อีกต่อไป ป้องกันปัญหา `invalid private key, expected hex or 32 bytes` ขณะบันทึกการตั้งค่า
   - **True Select Dropdown for Trading Pair in Settings Modal**: เปลี่ยนช่องกรอกคู่เทรดในหน้าต่าง Settings จาก input text เป็น `<select id="cfg_symbol" class="form-select">` เต็มรูปแบบ กดเลือกรายการเหรียญ (`WBTC:USDso`, `WETH:USDso`, `SOMI:USDso`, `USDC.e:USDso`) ได้ทันทีโดยไม่ต้องพิมพ์เอง
   - **Instant Pair Switching (`symbolChanged`)**: ปรับปรุงตรรกะการตรวจจับการสลับเหรียญใน `index.ts` โดยเทียบ Symbol ที่ normalize แล้วล่วงหน้า ทำให้การกดเปลี่ยนเหรียญทั้งจากแถบด้านบนหรือใน Settings สลับกระดาน ดึง Info คู่เทรดใหม่ และรีเฟรชกราฟแท่งเทียนได้ทันที 100%
   - **DreamDEX Strict Price & Quantity Tick Rounding (Elimination of `0xaf608abb` Reverts)**:
     - **สาเหตุของปัญหาเดิม**: บน DreamDEX สัญญา `SpotPool` มี require guard บังคับว่าราคาคำสั่งซื้อขายต้องหารลงตัวกับ `tickSize` พอดี (`price % tickSize == 0`) หากราคาที่ส่งไปมีทศนิยมเกินระดับขั้น (เช่น `0.20342` แต่ `tickSize` คือ `0.0001`) สัญญาจะ Revert ด้วย Custom Error `0xaf608abb` (`InvalidPriceTick(uint256 price, uint256 tickSize)`)
     - **การแก้ไข**: ใน `src/exchange/dreamdex/client.ts` เมธอด `placeOrder` นำเข้าและใช้ `roundToTick(params.price, market.tickSize)` และ `roundToStep(params.qty, market.stepSize)` เสมอก่อนแปลงเป็น BigInt (`priceRaw`, `qtyRaw`) และใน `src/strategy.ts` มีการปัดเศษด้วย `roundToTick(price, this.tickSize)` ก่อนสร้างออเดอร์ ทำให้ส่งคำสั่งได้สำเร็จ 100%
   - **DreamDEX Native Gas Reserve Protection & Settings Persistence (`minGasReserveSomi`)**:
     - เนื่องจากบน Somnia Network ค่าแก๊สในการส่งคำสั่งทั้งหมด (Place/Cancel Order, Token Approvals) ต้องจ่ายด้วย Native SOMI เสมอ
     - เพิ่มช่องกรอก `⛽ DreamDEX Gas Safety Reserve (SOMI)` ใน Settings Modal (ค่าเริ่มต้น `2.0` SOMI) บันทึกลงใน `settings.db.json`
     - **การแก้ไข Settings Persistence & Auto-Adopting Lots Fix**:
       - ใน `strategy.ts` เมธอด `getRuntimeConfig()` เคยตกคีย์ `minGasReserveSomi` ทำให้เมื่อผู้ใช้กดบันทึก ค่านี้จะหลุดหายไปจาก `settings.db.json` และส่งผลให้ `reconcileInventory` มองว่าไม่มี Gas Reserve จึงนำ SOMI ค่าแก๊สในกระเป๋าไปสร้างเป็น Lot ถือครองเพิ่มใน Position
       - ได้เพิ่ม `minGasReserveSomi` เข้าไปใน `getRuntimeConfig()` และ `updateRuntimeSettings` พร้อมการแปลง Number ป้องกันยอดแก๊สหลุดไปถูกนำไปสร้าง Lot โดยเด็ดขาด
     - ใน `src/strategy.ts`:
       - เมื่อเทรดคู่เหรียญที่ Base Asset เป็น SOMI (เช่น `SOMI:USDSO`): ฟังก์ชัน `getEffectiveGasReserveBase()` จะกันยอด `minGasReserveSomi` ออกจาก Inventory และยอดที่พร้อมเทรด/พร้อมขายโดยเด็ดขาด ป้องกันไม่ให้บอทเทขาย SOMI หมดเกลี้ยงกระเป๋าตอนเกิด Sell All หรือ Cut Loss
       - ใน `reconcileInventory`, `placeSellOrders`, `sellTrancheIOC`, `sellAll`: ป้องกันไม่ให้บอทดึง SOMI ในส่วน Gas Reserve ไปตั้งขาย
       - ใน `refreshWalletBalances`: ดึงยอดคงเหลือ Native SOMI มาอัปเดต telemetry เสมอแม้จะเทรดคู่เหรียญอื่น (เช่น `WETH:USDSO`)
     - ใน `src/exchange/dreamdex/client.ts`:
       - `getAccountBalances`: คืนค่ายอด Native SOMI ใน `allBalances["SOMI"]` เสมอ
       - `placeOrder`: ตรวจสอบยอด Native SOMI หากต่ำกว่า `< 0.05 SOMI` จะแจ้งเตือน `⚠️ [DREAMDEX LOW GAS WARNING]` ป้องกันธุรกรรม Revert จาก On-chain
   - **Cross-Exchange Credentials Isolation & RPC Overwrite Protection**:
     - **สาเหตุของปัญหาเดิม**: ใน `strategy.ts` เมธอด `updateRuntimeSettings` เคยเรียก `this.binance.updateCredentials(newKey, newSecret, newBase)` โดยไม่เช็ค exchange ทำให้เมื่อผู้ใช้รัน DreamDEX แต่บันทึกการตั้งค่าที่มี `binanceBaseUrl = https://api.binance.com` ค่า URL ของ Binance จะถูกส่งเข้าไปในพารามิเตอร์ที่ 3 ของ `DreamDexClient.updateCredentials` ซึ่งเป็นช่อง `rpcUrl` ส่งผลให้ Somnia RPC Node โดนเขียนทับด้วย URL ของ Binance และเวลาดึงยอด on-chain balance (`eth_getBalance`) จะยิงไปที่ Binance REST API จนเกิดข้อผิดพลาด `Status: 403 Forbidden`
     - **การแก้ไข**:
       1. ใน `src/strategy.ts`: ตรวจสอบ `this.binance.exchangeName` หากเป็น `binance` ให้อัปเดตเฉพาะ Binance keys & URL หากเป็น `dreamdex` ให้อัปเดตเฉพาะ `dreamdexPrivateKey` และ `dreamdexRpcUrl`
       2. ใน `src/exchange/dreamdex/client.ts`: เพิ่ม Guard ใน `updateCredentials` ปฏิเสธ URL ใดๆ ที่มี `binance.com` ไม่ให้เขียนทับ Somnia EVM RPC endpoint อย่างเด็ดขาด
   - จัดการ Time Synchronization กับ Server อัตโนมัติ (`syncTime()`)
   - ปรับความละเอียดตาม Symbol Filter เสมอ (`stepSize`, `tickSize`, `minQty`, `minNotional`)
4. **Asset Precision & Terminology**:
   - **Base Asset**: เหรียญหลักที่เทรด (เช่น BTC, ETH, SOL, BNB, SOMI)
   - **Quote Asset**: สินทรัพย์ที่ใช้ซื้อ/ประเมินมูลค่า (เช่น USDT, USDso)
5. **Data Feeds & Dual-Exchange Candle Mapping Pipeline**:
   - **Binance Universal Candle Source**: แม้ว่าบอทจะส่งคำสั่งเทรดบน DreamDEX (เช่น `SOMI:USDso`, `WBTC:USDso`, `WETH:USDso`) แท่งเทียนและ ATR จะถูกดึงจาก Binance Spot เสมอเพื่อความเสถียรและสภาพคล่องสูงสุด
   - **Symbol Resolution (`resolveBinanceCandleSymbol`)**:
     - `SOMI` / `SOMI:USDSO` -> `SOMIUSDT`
     - `USDC.E:USDSO` -> `USDCUSDT`
     - `WBTC:USDSO` -> `BTCUSDT`
     - `WETH:USDSO` -> `ETHUSDT`
   - **Candle Flush Protection (`clearCandles` & `clearExisting: true`)**:
     - เมื่อสลับคู่เหรียญ ระบบจะเรียก `macroDowEngine.clearCandles()` และ `localTrendEngine.clearCandles()` เพื่อล้างแท่งเทียนเก่าของเหรียญเดิมทิ้ง ป้องกันปัญหากราฟเพี้ยนจากการนำแท่งเทียน BTC (ราคา $83,000) มาผสมกับแท่ง SOMI (ราคา $0.20)
   - **Real-Time WebSockets**: สตรีมแท่งเทียน Real-time (Binance Kline WS) และ Order Book Ticker สำหรับคำนวณ ATR, Dow Swings และอัปเดต Dashboard chart
   - **DreamDEX Real On-Chain Top of Book Indexing (`getTopOfBook`)**:
     - เพิ่มเมธอด `getTopOfBook` ใน `SomniaIndexerClient` และ `DreamDexClient` โดยคิวรี Open Orders (Bids & Asks) จาก Somnia GraphQL Indexer แบบเรียลไทม์ และคำนวณ Best Bid, Best Ask และ Mid Price
     - มีระบบ In-memory cache 1.5 วินาที เพื่อป้องกันการยิง GraphQL ถี่เกินไประหว่าง Polling
     - **Price $0.000000 & Mid Fallback Protection**:
       - แก้ไขจุดบกพร่อง `effectiveMid = mid ?? binancePrice` ใน `src/strategy.ts` ที่ประเมิน `0 ?? binancePrice` เป็น `0` โดยปรับเป็น `const effectiveMid = (mid !== undefined && mid > 0) ? mid : (binancePrice ?? 0);`
       - ป้องกันปัญหา Orderbook บน DEX ว่างจนสะดุด Spread Dislocated Gate ด้วยการผ่อนปรนให้ใช้ CEX Reference Price ได้อย่างปลอดภัย
   - **Broken Floor & Higher Low Recovery (`checkForHigherLow`)**:
     - ปรับปรุงการตรวจสอบ Higher Low หลังหลุด Floor ใน `market-structure.ts` และ `strategy.ts` ให้ตรวจจับสวิงที่ได้รับการวิเคราะห์คลื่น Dow Wave Cycles ว่าเป็น `HL` และหากราคากลับขึ้นมายืนเหนือ Floor ของ Channel ปัจจุบันได้อย่างมั่นคง จะทำการปลดล็อกสถานะ `waitingForHigherLow` ทันทีและกลับมาเปิดการซื้อขายตามปกติ
   - **Settings Modal UI Revamp**:
     - ลบแท็บ `💾 Offline DB Status` และเมทริกซ์ที่ไม่ได้ใช้งานออกจาก Settings Modal
     - เปลี่ยนชื่อแท็บ `Binance API & Env` เป็น `🔑 Exchange & Network`
     - จัดกลุ่มแสดงผลเฉพาะของกระดานที่เลือก (`.binance-fields-group` vs `.dreamdex-fields-group`) โดยอัตโนมัติเมื่อผู้ใช้สลับ Dropdown Exchange
     - ตัดตัวเลือก Laggard Snipe, Laggard Guard, และ Laggard Dislocation Threshold ออกจากแท็บ Execution & Guard เพื่อความกระชับสะอาดตา

---

## 3. Operational Runbook & Commands

คำสั่งทั้งหมดรันโดยตรงในโฟลเดอร์โปรเจกต์ `dynamic-grid-bn`:

| Purpose | Command | Notes |
| :--- | :--- | :--- |
| **Development (Hot-Reload)** | `npm run dev` | รันบอทด้วย `tsx watch src/index.ts` รีโหลดอัตโนมัติเมื่อแก้โค้ด |
| **Production Start** | `npm start` | รันบอทด้วย `tsx src/index.ts` |
| **TypeScript Typecheck** | `npm run typecheck` | ตรวจสอบประเภทข้อมูล TypeScript ด้วย `tsc --noEmit` |
| **Dashboard UI** | เปิดเบราว์เซอร์ไปที่ `http://localhost:3333` หรือ `http://localhost:3334` | พอร์ตถูกกำหนดใน `.env` (`PORT`) หรือ `data/grid-bot.db.json` (`dashboardPort`) |

---

## 4. Key Strategy Features & Safeguards

- **5-Zone Dynamic Channel**:
  - `0% Floor`: Support boundary; cut-loss trigger.
  - `0%–50% Buy Zone`: Stepped accumulation ladder.
  - `50% Center`: Equilibrium midpoint.
  - `50%–100% Sell Zone`: Stepped profit taking ladder.
  - `100% Ceiling`: Resistance boundary; 100% full take-profit exit.
- **Dynamic Buy Tranche Allocation & Min Notional Floor (No Rigid / 4 Dilution)**:
  - แทนที่จะหาร 4 แบบคงที่ (`currentAvailableCapacity / 4`) ซึ่งทำให้เกิดปัญหาเมื่อเหลือความจุ เช่น $15.75 แล้วถูกหารจนเหลือเพียง $3.82 จนต่ำกว่า Binance Min Notional ($5.00)
  - ระบบจะคำนวณจำนวนระดับที่พร้อมวางคำสั่งซื้อจริง (`numEligibleBuyLevels`) โดยไม่นับระดับที่ติด Holding Fraction Guard หรือ Trendline Filters
  - หากหารเฉลี่ยแล้วขนาดไม้ต่ำกว่า $5.00 (`rawTrancheQuote < minNotional`) ระบบจะรวบรวมงบที่เหลือเข้าด้วยกัน (`min(currentAvailableCapacity, minOrderNotional)`) เพื่อการันตีว่าออเดอร์มีมูลค่า $\ge \$5.00$ เสมอ ไม่โดนข้าม (Skip) โดย `MIN NOTIONAL GUARD` อีกต่อไป
- **Dynamic Sell Tranche Allocation & CEX Rebalancing (Equal Sell Sizes & Zero Dump)**:
  - **Eligible Level Counting (`numEligibleLevels`)**: คำนวณจำนวนระดับที่อยู่เหนือราคาตลาดและพร้อมวางขายจริง (`lvl > minAllowedSellPrice`) และแบ่งขนาดไม้เฉลี่ยเท่ากันเป๊ะ (`trancheQty = held / numEligibleLevels`) แทนการหาร 4 แบบคงที่ ซึ่งเคยทำให้เกิดเศษค้างเมื่อราคาผ่าน Sell Target 1 ไปแล้ว
  - **Zero Final Level Dump & Anti-Hoarding**: ไม้สุดท้าย (Exit All) จะรับเฉพาะส่วนต่างเศษทศนิยมระดับ Satoshis/Wei เล็กๆ เท่านั้น (`Math.max(trancheQty, held - (trancheQty * (numEligible - 1)))`) ไม่ดูด Inventory ก้อนใหญ่ที่ยังไม่ได้ตั้งของไม้อื่นมากองไว้ที่ Sell Target 4 จนขนาดไม้เบิ้ล 2 เท่าอีกต่อไป
  - **Missing Eligible Level Enforcement (`hasMissingEligibleSellOrders`)**: หากตรวจพบว่ายังมีระดับขายที่ยังไม่ได้วางออเดอร์ (เช่น Sell Target 3 ว่างอยู่) ระบบจะ **ไม่ถือว่า `isInventoryFullyCovered`** และสั่ง Rebalance ลดขนาดไม้ที่เบิ้ลเพื่อนำยอดมาวางออเดอร์ให้ระดับที่ขาดหายไปทันที ทำให้มีคำสั่งขายกระจายครบทุกระดับอย่างสม่ำเสมอ 100%
  - **Auto Rebalancing on CEX / BUY Fills**: เมื่อมี BUY แมตช์ (`needsSellRebalance = true`) หรือบน CEX (Binance) หากตรวจพบว่าขนาดออเดอร์ขายแต่ละไม้เบี่ยงเบนไปจากไม้เฉลี่ยเกิน 10% บอทจะทำการยกเลิกและตั้งออเดอร์ขายใหม่ให้ทุกไม้มีขนาดเท่ากันสม่ำเสมอทันที โดยไม่มีค่า Gas หรือ Fee บน Maker orders
- **Holding Fraction Guard (Elimination of Repeated Buy Level 1 Fills)**:
  - In a stepped accumulation grid ladder, each buy level represents a target capacity threshold (Level 1 $\le 25\%$, Level 2 $\le 50\%$, Level 3 $\le 75\%$, Level 4 $\le 100\%$).
  - When a buy order fills and current portfolio inventory already satisfies or exceeds that level's target fraction (`currentHoldFraction >= levelTargetFraction - 0.05`), the bot **strictly forbids re-placing a new buy order at that same level** while holding that position.
  - This completely eliminates repeated buy fills at Buy Level 1 (e.g. 3 consecutive fills at \$2562.45), forcing accumulation to take place only at deeper buy levels or waiting until inventory is sold.
- **Binance CEX Continuous Grid (Bypass Hysteresis Pause & Cancel Churn)**:
  - When trading on Binance (`this.binance.exchangeName === "binance"`), `buyOrdersActive` and `sellOrdersActive` remain continuously `true`.
  - Hysteresis level pausing (`enableBuyBelowSellLevel1` and `enableSellAboveBuyLevel1`) is bypassed on CEX because 0% maker fees and zero gas allow resting buy and sell orders to stay simultaneously active on the order book without churn costs.
  - Eliminates rapid rebalance loops (`needsBuyRebalance = true`) caused by price wiggling around Sell Level 1.
- **Smart Order Level Re-linking & Closest-Price Reconciliation (Zero Overwrite & Zero Missing Sell Levels)**:
  - **สาเหตุของปัญหาเดิม**: ใน `reconcileActiveOrders` มีการเทียบราคาแบบวนลูปหาตัวแรกด้วย Tolerance กว้างเกินไป (`diff <= 0.003` หรือ 0.3%) ซึ่งในกรอบแคบ (เช่น 1.91%) ระยะห่างระหว่างกริดแต่ละระดับมีเพียง 0.18% ส่งผลให้ออเดอร์ Sell Target 2 ($2576.62) ถูกรวบไปจับคู่กับ Sell Target 1 ($2571.90) และได้ชื่อซ้ำเป็น "Sell Target 1" ทั้งคู่ ทำให้ออเดอร์ที่เหลือถูกเลื่อนชื่อตามกันมา และไม่มีออเดอร์ใดได้ชื่อ "Sell Target 4" เลย ส่งผลให้บนหน้าบ้าน `app.js` ออเดอร์ $2576.62 ไปเขียนทับแถว Sell Target 1 จนแถว Sell Target 4 กลายเป็นช่องว่าง
  - **การแก้ไข**:
    1. ปรับระบบ Reconcile (`reconcileActiveOrders`) ทั้งฝั่ง Buy และ Sell ให้ใช้ **Closest-Price Search (`minDiff`)** โดยจับคู่กับระดับที่ใกล้ที่สุดจริง พร้อมบีบ Tolerance ลงเหลือ $\le 0.15\%$ ป้องกันการแย่งชื่อข้ามระดับโดยสิ้นเชิง
    2. ใน `staleSells` และ `staleBuys`: เพิ่มระบบ Auto-Correction หากพบออเดอร์ที่มีชื่อ `levelDesc` ไม่ตรงกับระดับราคาจริง (เช่น $2576.62 ดันชื่อ Sell Target 1) ระบบจะ Re-link ให้เป็นชื่อระดับที่ถูกต้อง ($2576.62 -> Sell Target 2) โดยอัตโนมัติ
    3. ใน `public/app.js`: ปรับการจับคู่ออเดอร์เข้า Grid Channel Meter ให้ใช้ `usedSteps (Set)` ป้องกันการเขียนทับซ้ำแถวเดิม (1 ออเดอร์ ต่อ 1 แถวอย่างเคร่งครัด) ทำให้แถว Sell Target 1, 2, 3, 4 แสดง Badge ออเดอร์ขายครบทั้ง 4 แถวอย่างถูกต้อง 100%
- **Persistent Multi-Symbol Locked Channel (`lockedChannels` by `${exchange}:${symbol}`)**:
  - **สาเหตุของปัญหาเดิม**:
    1. ในฐานข้อมูล `grid-bot.db.json` เคยเก็บ `state` ก้อนเดียวรวมกัน เมื่อสลับคู่เทรดไปมา (เช่น สลับระหว่าง Binance `ETHFDUSD` กับ DreamDEX `SOMI:USDso`) หรือบอทรีสตาร์ท ข้อมูล `lockedChannel` ของเหรียญเดิมจะสูญหาย
    2. มีตรรกะ `isFresh` ตรวจจับระยะห่าง `Math.abs(centerPrice - avgEntry) / avgEntry < 0.15` หากกรอบเดิมกว้างมาก หรือตลาดวิ่งห่าง บอทจะล้าง `lockedChannel = undefined` ทิ้งไปเอง
    3. เมื่อกรอบที่จำไว้หาย บอทจะ Fallback ไปคำนวณจากแท่งเทียนที่โหลดเข้ามาใหม่ (192–300 แท่ง) หากจุดยอด/ฐานเดิมหลุดออกนอกขอบแท่งเทียนไปแล้ว (อยู่นอกกราฟ) บอทจะมองไม่เห็น และไปหยิบยอดคลื่นแคบๆ ปัจจุบันบนจอมาล็อคทับเป็นกรอบใหม่แทน ทำให้กรอบกว้างเดิมหายไป
  - **การแก้ไข**:
    1. ใน `BotDatabase` เพิ่ม `lockedChannels: Record<string, LockedChannel>` และ `statesBySymbol` แยกตามคู่เทรด (`${exchange}:${symbol}`) บันทึกกรอบล็อคและสถานะอย่างถาวร
    2. ใน `strategy.ts`: ลบเงื่อนไข `isFresh < 0.15` ทิ้ง ตราบใดที่มี Inventory หรือออเดอร์ขายค้างอยู่ บอทจะยึดถือกรอบเดิมอย่างเคร่งครัด 100%
    3. ใน `step()`: Reconstruct `lastDynamicBounds` จาก `lockedChannel` เสมอหากเริ่มทำงานขณะถือ Position ป้องกันการถูกแท่งเทียนแคบๆ ในจอเขียนทับ
    4. ใน `updateExchangeClient` และ `updateSymbolInfo`: มีการ `saveState(true)` ก่อนสลับเหรียญ และ `loadState()` โหลดสถานะและกรอบล็อคของเหรียญใหม่ขึ้นมาทันที 100%
- **Strict Closed-Candle Cut-Loss Confirmation (100% Closed Bar Close Price & Zero Wick Triggers)**:
  - **สาเหตุของปัญหาเดิม**: เดิมระบบนับแท่งเทียนที่หลุด Floor ผ่าน `breakdownCandleTimes.add(currentCandle.time)` โดย `currentCandle` คือแท่งปัจจุบันที่กำลังวิ่งอยู่ (ยังไม่ปิดแท่ง) ทำให้เมื่อราคาแลบไส้ (Wick) ลงไปแตะบัฟเฟอร์เพียง 1 วินาทีกลางแท่ง (เช่น นาทีที่ 18:16:04 ของแท่ง 18:15–18:30) บอทก็นับว่าครบ 1 แท่งทันทีและเทขาย Cut Loss ล้างพอร์ตกลางแท่งโดยที่แท่งเทียนยังไม่จบ
  - **ระบบยืนยันแท่งเทียนปิด 100% (`getClosedCandles`)**: ปรับปรุงให้การตรวจ Cut Loss ตรวจสอบเฉพาะแท่งเทียนที่ปิดสมบูรณ์แล้วเท่านั้น (`c.isClosed === true` หรือแท่งก่อนหน้าแท่งปัจจุบัน) โดยราคาปิดแท่ง (`c.close`) ต้องต่ำกว่า Cut-Loss Buffer จริง
  - **Strict Post-Cutloss Safeguards (Mandatory Higher Low or Explicit Optional Recovery)**:
    - เมื่อเกิด Cut Loss / Floor หลุดกรอบ ระบบจะเปิดสถานะ `waitingForHigherLow = true` และระงับคำสั่งซื้อใหม่ (`canBuy = false`) อย่างเด็ดขาด
    - **ลบเงื่อนไขแตะ Floor แล้วปลดล็อคทันที**: ยกเลิกตรรกะเดิมที่เคยปลดล็อคเพียงเพราะราคาดีดกลับมาแตะ Floor หรือ Cut-Loss Buffer เพื่อป้องกันปัญหาการเข้าช้อนซื้อทันที (Dead Cat Bounce)
    - **เงื่อนไขปลดล็อคที่ได้รับอนุญาตเท่านั้น**:
      1. **Confirmed Higher Low (HL) (บังคับเป็นแกนหลัก Mandatory Baseline)**: ราคาต้องสร้าง Swing Low Pivot ตัวใหม่ที่ยกสูงกว่าก้นเหว (`Lowest Dump`) และมีแท่งยืนยันตามทฤษฎี Dow Theory
      2. **Trendline Breakout (กรณีเปิด `trendlineFilter`)**: ราคาต้องปิดแท่งทะลุเหนือเส้นกดขาลงอย่างน้อย 2 แท่งเทียน
      3. **Buy Level 2 Recovery (กรณีเปิด `enableBuyLevel2Recovery`)**: ราคาต้องฟื้นตัวขึ้นมายืนเหนือ Buy Level 2 (30% Zone) ได้อย่างน้อย 1 แท่งเทียน
- **Cut-Loss Full Base Liquidation & Anti-Loop Safeguards (Zero Residual Dust & Zero 30s Dump Loops)**:
  - **สาเหตุของปัญหาเดิม**:
    1. ใน `sellAll()` เดิมใช้คำนวณ `rawExecuteQty = Math.min(held, availableBase)` ซึ่งหาก `held` ใน memory ของบอทมีค่าน้อยกว่าเหรียญจริงในกระเป๋า (เช่น `held` = 0.0315 ETH แต่ในกระเป๋า Binance มี 0.1626 ETH จากไม้ซื้อสะสมก่อนหน้า) บอทจะ Cut Loss ขายออกเพียงแค่ 0.0315 ETH และเหลือค้างในกระเป๋าถึง 0.1311 ETH
    2. ทุกๆ 30 วินาทีตามรอบ `periodicSyncIntervalMs`, ฟังก์ชัน `reconcileInventory()` ตรวจพบว่าเหรียญในกระเป๋ามีมากกว่า memory lots จึงสั่ง Adopt ส่วนต่างกลับเข้ามาใน `this.lots` อีก
    3. เมื่อราคาตลาด ณ ขณะนั้นยังคงอยู่ต่ำกว่า Cut-Loss Buffer (Floor Breakdown) บอทจึงสั่งยิง `sellAll()` ซ้ำทุก 30 วินาที ติดต่อกันถึง 6 ไม้รวด จนกระทั่งเหรียญในกระเป๋าหมดเกลี้ยง
    4. เมื่อราคาหลุด Floor เก่า ($2533) ทุบลงไปทำ Low ($2512) แล้วเด้งกลับขึ้นมาที่ $2538 ขณะที่กรอบ S/R Channel ขยับลงมารับราคา ทำให้ Floor ใหม่อยู่ที่ $2512 และราคา $2538 อยู่ใน Buy Zone ใหม่ แต่เนื่องจาก `dowTrendFilter: false`, `trendlineFilter: false` และราคาเด้งพ้น Floor เก่าแล้ว ทำให้สถานะ `isBelowFloor` กลายเป็น false บอทจึงเข้าไปวางไม้ซื้อสะสมกรอบใหม่ช่วง 22:00 น. โดยที่ยังไม่เกิด Confirmed Higher Low (HL) ตามทฤษฎี Dow Theory
  - **การแก้ไข**:
    1. **Full Base Liquidation on Live Exchange (`rawExecuteQty = Math.max(held, availableBase)`)**: ใน `sellAll()` เมื่อเกิด Cut Loss / Full Exit บน Exchange จริง ให้เทขายเหรียญ Base Asset ทั้งหมดที่พร้อมขายในกระเป๋า (`availableBase`) ในไม้เดียวเกลี้ยงพอร์ต ไม่ต้องแคปด้วย `held` หรือ `maxInventoryQuote` เพื่อไม่ให้มีเศษเหลือค้างและจบการ Cut Loss ได้ในคำสั่งเดียว 100%
    2. **Auto-Clear Memory Lots**: หลังยิงคำสั่ง `sellAll()` สำเร็จ หากยอดคงเหลือในกระเป๋า $\le \text{minQty}$ ให้รีเซ็ต `this.lots = []` และปลดล็อค `lockedChannel = undefined` ทันที
    3. **Reconcile Inventory Guard (`if (this.waitingForHigherLow) return;`)**: ใน `reconcileInventory()` เพิ่ม Guard ห้าม Adopt เหรียญในกระเป๋ามาสร้าง lots ระหว่างที่อยู่ในสถานะรอ Higher Low หรือช่วง Floor Breakdown โดยเด็ดขาด ป้องกันการวนลูปดูดเหรียญมา Cut Loss ซ้ำทุก 30 วินาที
    4. **Strict Higher Low Enforcement**: ตราบใดที่ยังไม่เกิด Confirmed Higher Low (HL) เหนือจุดต่ำสุดของการทุบ (`lowestDumpPrice`) สถานะ `waitingForHigherLow` จะยังคงเป็น `true` และบล็อกคำสั่งซื้อ (`canBuy = false`) อย่างสมบูรณ์ แม้ว่ากรอบ S/R Channel จะเลื่อนลงมารองรับราคาแล้วก็ตาม
- **Strict Dow Theory Trendline Anchoring & Minimum 3-Touch Rule (Zero Steep & Floating Lines)**:
  - **สาเหตุของปัญหาเดิม**:
    1. ในการคำนวณ Uptrend Support Line (`calculateTrendlines`) จุดกำเนิด $V_1$ จับที่ก้นเหว $LL$ ล่าสุด ($2422.73) แต่ ณ ขณะนั้นตลาดยังไม่เกิด Confirmed Higher Low ($V_2$) เลยแม้แต่จุดเดียว (เหวยังเป็น Candidate Valley `🌊 0/3` ยังไม่ปิดแท่ง 3 bars) แต่โค้ดมีระบบ Fallback ดึงค่ามโนมาคำนวณ ทำให้เกิดเส้นประรับพุ่งเฉียงขึ้นไปบนฟ้าแบบ **"ไม่ได้เชื่อมจากเหวไปเหว"**
    2. การลากเส้นเชื่อมเพียง 2 จุด มักทำให้ได้เส้นที่ชันเกินไป (Too Steep) และหลุดจากพฤติกรรมราคาจริง ขาดความน่าเชื่อถือ
    3. ในการคำนวณ Downtrend Resistance Line จุด $P_1$ ไปควักยอดเก่าของคลื่นก่อนหน้า ($2588) ข้ามยอด Lower High จริงๆ ของรอบทุบ ทำให้เส้นประม่วงลอยอยู่สูงเกินไปและไม่ได้กดลงมาตามพฤติกรรมราคาจริง
  - **การแก้ไขตามหลัก Dow Theory & Minimum 3 Touches**:
    1. **Downtrend Resistance Line**:
       - $P_1$: เริ่มจากจุดยอดสูงสุด (The Major High) ของรอบคลื่นที่ส่งราคาลงมาทำจุดต่ำสุด ($LL$ ล่าสุด)
       - **ต้องมีจุดสัมผัสลากผ่าน $\ge 3$ จุด ($P_1$ + Confirmed $LH \ge 2$ จุด)**: จุดสัมผัสต้องอยู่บนหรือใกล้เส้นมาก ($\le 0.25\%$) และต้องไม่มีแท่งเทียนหรือยอดใดทะลุผ่านเส้น
       - **กฎเหล็ก**: หากมีจุดสัมผัสไม่ถึง 3 จุด จะต้องไม่วาดเส้นกดเด็ดขาด (`downtrendLine = undefined`)
    2. **Uptrend Support Line**:
       - $V_1$: เริ่มจากจุดต่ำสุดของรอบทุบ (The Lowest Low / $LL$) ล่าสุด
       - **ต้องมีจุดสัมผัสลากผ่าน $\ge 3$ จุด ($V_1$ + Confirmed $HL \ge 2$ จุด)**: จุดสัมผัสต้องยกฐานสูงขึ้นและอยู่บนหรือใกล้เส้นมาก ($\le 0.25\%$) โดยไม่มีเหวใดหลุดใต้เส้น
       - **กฎเหล็ก**: หากยังไม่เกิด Confirmed $HL$ ครบอย่างน้อย 2 จุด (รวมจุดกำเนิดเป็น 3 จุด) จะต้องไม่วาดเส้นรับเด็ดขาด (`uptrendLine = undefined`) ป้องกันเส้นชันเกินไปและป้องกันเส้นลอยกลางอากาศ 100%
- **Cut-Loss / IOC WS Fill Deduplication (Zero Duplicate Trade Records & Zero Ghost SELL Fills)**:
  - **สาเหตุของปัญหาเดิม**: เมื่อเกิด Cut Loss / Full Exit คำสั่ง `sellAll()` จะส่ง IOC Order ไปยัง Exchange และบันทึกผลการปิดออเดอร์ (`CUT` / `TAKE_PROFIT`) ทันทีที่ REST ส่งผลลัพธ์กลับมา แต่หลังจากนั้นเพียง 2-3 มิลลิวินาที Binance WebSocket User Data Stream จะส่งข้อความ `executionReport (FILLED)` ตามมา เนื่องจากระบบ `handleWsExecutionReport` เดิมไม่มีการติดตาม ID ของคำสั่งฝั่ง IOC/Exit จึงเข้าใจผิดคิดว่าเป็น Maker Sell Order ปกติ และเรียก `processSellFill()` ซ้ำ ส่งผลให้เกิดรายการ `SELL FILL $0.00 PnL` ซ้ำซ้อนกับ `CUT LOSS` ในหน้ารายการ Trade และแสดง Marker `CUT` กับ `S` ซ้ำกันบนแท่งเทียนเดียวกัน
  - **การแก้ไข**:
    1. ใน `src/strategy.ts`: เพิ่ม `handledExitOrderIds = new Map<string, number>()` เมื่อมีการส่ง IOC ใน `sellAll()`, `sellTrancheIOC()`, หรือ `buyTrancheIOC()` บอทจะลงทะเบียน `orderIdStr` ไว้ทันที และใน `handleWsExecutionReport` จะมี Guard ตรวจสอบ `if (this.handledExitOrderIds.has(idStr)) return;` ข้ามการประมวลผล fill ซ้ำจาก WS อย่างสมบูรณ์
    2. ใน `src/db.ts`: ใน `recordEvent` เพิ่ม Guard ตรวจสอบ `orderId` หรือ `txHash` หากพบว่ามีสถานะ `FILLED` อยู่แล้วในระบบ จะไม่สร้างแถว `SELL_FILL` ซ้ำ และหากเป็นอีเวนต์ `CUT` / `TAKE_PROFIT` จะทำการ Update แถวเดิมแทนการ Unshift แถวใหม่
    3. Auto-Purge Historical Duplicates (`cleanupDuplicateExitFills`): รันอัตโนมัติในคอนสตรัคเตอร์ของ `BotDatabase` เพื่อตรวจจับและลบแถว `SELL_FILL` เก่าในอดีตที่มี `orderId` หรือ `txHash` ซ้ำกับแถว `CUT` หรือ `TAKE_PROFIT` ออกจากฐานข้อมูล `data/grid-bot.db.json` ทันทีที่สตาร์ทบอท
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
    - *Density-First S/R Clustering & Strict Line Touch Verification (Zero Floating 🎯 Badges & Outlier Elimination)*:
      - **สาเหตุของปัญหาเดิม**: ใน `clusterPoints` เดิมเรียงลำดับจุดยอดจากสูงลงมา (`b.price - a.price`) ทำให้ยอดแหลมที่แลบไส้ขึ้นไปทำ New High ($2590.75) ถูกหยิบมาเป็นตัวตั้งต้น (Seed) ของคลัสเตอร์ และดึงยอดแนวต้านข้างล่าง ($2581.75) เข้ามาร่วมกลุ่มเนื่องจากห่างกัน 0.347% (ต่ำกว่า Tolerance 0.35%) จากนั้นตั้งราคาเส้นกรอบที่จุดต่ำสุด `Math.min(...) = $2581.75` (เส้นม่วง) แต่ยังคงยอด $2590.75 ไว้ในอาเรย์ `points` ส่งผลให้หน้าบ้านแสดงป้าย `🎯 2x` ลอยสูงขึ้นไปอยู่บนยอดดอย $2590.75 เหนือเส้นม่วงถึง $9 ดอลลาร์ ทั้งที่ไม่ใช่จุดสัมผัสแนวต้านจริง
      - **การแก้ไข**:
        1. **Density-First Seed Selection**: ใน `clusterPoints` ปรับจากการเรียงตามราคา เป็นการประเมินกลุ่มผู้สมัครทุกจุด และเลือกจุดที่สร้างกลุ่มจุดสัมผัสหนาแน่นที่สุด (Most touches density) เป็นตัวตั้งต้นก่อน ป้องกันยอดหลุดเดี่ยวจากการแย่งจุดระนาบสะสมตัวหลัก
        2. **Strict Line Touch Verification (`lineTouchTol <= 0.20%`)**: เมื่อกำหนดราคาคลัสเตอร์ (`clusterPrice`) ได้แล้ว จุดที่จะนับเป็น `touchCount` และอยู่ใน `points` จะต้องมีราคาใกล้เคียงกับ `clusterPrice` ไม่เกิน $\pm 0.20\%$ (ประมาณ $\le \$5$ บน ETH) ยอดหลุดเดี่ยวที่แลบเกินระยะ (เช่น $2590.75) จะถูกตัดออกจากจุดสัมผัสของเส้นนี้โดยสิ้นเชิง และกลับไปแสดงสถานะ Dow แท้จริง (`⛰️ HH`)
        3. **Dashboard Touch Filter Tightening (`app.js` & `strategy.ts`)**: ปรับลด Tolerance กรองจุดสัมผัสใน `app.js` จาก $1.5\%$ ลงเหลือ $0.25\%$ และกรองใน `strategy.ts` ล่วงหน้า การันตีว่าป้าย `🎯` จะปรากฏเฉพาะบนแท่งเทียนที่แตะสัมผัสเส้นกรอบจริงเท่านั้น 100% ไม่มีป้ายลอยกลางอากาศอีกต่อไป
    - *Nearest Multi-Touch Resistance/Support Priority ("ถ้ามี สองจุดที่ต่ำกว่า ถือให้ใช้กรอบนั้น")*:
      - **สาเหตุของปัญหาเดิม**: ใน `isResistanceBroken` มีเงื่อนไขผิดพลาด `if (activeWaveHigh && p < activeWaveHigh * (1 - tol)) return true;` ซึ่งทำให้ยอดแนวต้านสะสมตัวใหม่ (เช่น $2590.79 ที่มี 🎯 2x) ถูกมองว่าพังแล้ว เพียงเพราะในอดีตเคยมียอด $2701.50 ที่สูงกว่า อีกทั้งระบบคิดคะแนนยังลำเอียงให้ยอดสูงสุดในอดีต (+600) และลงโทษระยะห่างเบาเกินไป รวมถึง `minChannelWidthPct` (3%) ตัดคะแนนกรอบ 2.27% จนระบบกระโดดข้ามแนวต้านใกล้ไปเกาะยอดดอย $2701.50
      - **การแก้ไข**:
        1. ลบตรรกะ `p < activeWaveHigh` ทิ้ง: ตราบใดที่แนวต้านอยู่เหนือราคาปัจจุบัน (`p >= currentPrice * 0.999`) จะถือเป็นแนวต้านสมบูรณ์ที่พร้อมใช้งานเสมอ
        2. ให้คะแนนโบนัสสูงสุดแก่ **Nearest Multi-Touch Cluster (`+3500` points)** ทั้งฝั่ง Resistance เหนือราคา และ Support ใต้ราคา ทำให้แนวต้าน 2x ที่อยู่ติดราคาปัจจุบัน ($2590.79) ชนะยอดอดีตที่อยู่ห่างไกล ($2701.50) ขาดลอย
        3. อนุญาตให้กรอบ Multi-Touch ที่สมบูรณ์และมีความกว้างตั้งแต่ $\ge 1.8\%$ (Baseline Tradeable Span) ได้รับสถานะ In-Range ตามเกณฑ์ เพื่อป้องกันการกระโดดข้ามระดับไปหายอดไกลเกินความจำเป็น
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
- **Binance Spot Minimum Notional ($5.0) & Adaptive IOC Tranche Distribution**:
  - **Binance Minimum Notional Rule (`minNotional = Math.max(this.minNotional || 5.0, 5.0)`)**:
    - Binance Spot บังคับมูลค่าออเดอร์ขั้นต่ำต่อไม้ที่ $5.0 (หรือตาม `minNotional` ใน Symbol Filter)
    - ป้องกันข้อผิดพลาด `Binance Error [-1013]: Filter failure: NOTIONAL` โดยเด็ดขาด ทั้งฝั่ง BUY, SELL (IOC, Maker Limit, Cut-Loss, Take-Profit liquidation)
    - หากมูลค่าออเดอร์ต่ำกว่า $5.0 บอทจะทำการตรวจสอบและระงับการส่งออเดอร์พร้อมแจ้งเตือน `[MIN NOTIONAL GUARD]`
  - **Dynamic Adaptive Sell Tranches (`4 -> 3 -> 2 -> 1`)**:
    - ในโหมด `IOC_BRACKET` เมื่อถึงระดับราคาทำกำไร บอทจะไม่แบ่งขายดื้อๆ เป็น 4 ไม้หากแต่ละไม้มีมูลค่าน้อยกว่า $5.0
    - คำนวณจำนวนไม้ขายที่เหมาะสมแบบ Dynamic:
      ```ts
      let numSellTranches = 4;
      while (numSellTranches > 1 && (totalHeldQuote / numSellTranches) < minNotional) {
        numSellTranches--;
      }
      ```
    - **ตัวอย่างการแบ่งไม้ขายจริง**:
      - ถือ $12: ลอง 4 ($3 < $5) ➔ ลอง 3 ($4 < $5) ➔ ลอง 2 ($6 >= $5) ➔ **แบ่งขาย 2 ไม้ ไม้ละ $6** (ที่ Target 1 ขาย 50%, Target 4 ขาย 100%)
      - ถือ $8: ลอง 4 ➔ ลอง 3 ➔ ลอง 2 ➔ เหลือ 1 ($8 >= $5) ➔ **ขายรวดเดียว 100% ไม้เดียวจบที่ Target 1 ($8)**
      - ถือ $16: ลอง 4 ($4 < $5) ➔ ลอง 3 ($5.33 >= $5) ➔ **แบ่งขาย 3 ไม้ ไม้ละ $5.33**
      - ถือ $20+: แบ่งขายเต็ม **4 ไม้ (25% ละ $5+)** ครบทุก Target
  - **Adaptive Buy Budget Expansion**:
    - ในฝั่งซื้อ IOC หาก `toSpendQuote < minNotional` แต่ Wallet และ Max Inventory มีความจุเพียงพอ บอทจะปรับขยายงบซื้อขึ้นมาเป็น `$5.0` อัตโนมัติ เพื่อให้สามารถเปิดออเดอร์สะสมเหรียญได้ตามเกณฑ์ขั้นต่ำของ Binance
- **Binance ETH 4-Decimal Precision (`stepSize = 0.0001`) & 0% Fee FDUSD Integration**:
  - **Single Source of Truth Configuration**: การตั้งค่าทั้งหมดอ่านและบันทึกผ่าน JSON Database (`data/grid-bot.db.json`) เท่านั้น ไม่ใช้ `.env`
  - **ETH 4-Decimal Precision Enforcement**:
    - บน Binance คู่เทรด ETH มี `stepSize = 0.0001` (อนุญาตทศนิยม 4 ตำแหน่งเท่านั้น)
    - ทุกคำสั่งซื้อและขาย (`placeRestingOrder`, `buyTrancheIOC`, `sellTrancheIOC`, `sellAll`) ปัดเศษลงตาม `roundToStep(qty, this.stepSize, 4)` เสมอ 100% ป้องกันการ Reject จากกระดาน
  - **Zero Maker Fee on FDUSD (`ETHFDUSD`)**:
    - Binance มีสิทธิประโยชน์ **0% Maker Fee** สำหรับคู่เทรด FDUSD
    - ในโหมด `MAKER_LIMIT` บนคู่ FDUSD ค่าธรรมเนียม Spot จะถูกคำนวณเป็น `0.0%` ทำให้เหรียญ ETH ที่ได้จากการซื้อเป็น 4 ตำแหน่งเต็มเม็ดเต็มหน่วย ไม่ถูกหักเหรียญเป็นเศษทศนิยม
    - หากเป็นโหมด Taker หรือคู่เทรดอื่น (เช่น USDT): บันทึกหัก Fee สุทธิ 0.075% ลงใน Lot ทันที
  - **Dust Purge & Residual Balance Reconcile**:
    - **เมื่อขายไม้สุดท้าย (100% Exit)**: สั่งขายจำนวนสูงสุดที่ทำได้ 4 ตำแหน่ง และหากมีเศษเหรียญต่ำกว่า `minQty` (0.0001 ETH) ตกค้างใน Lots จะทำการเคลียร์ `lots = []` และปลดล็อก Channel ทันที เพื่อไม่ให้สถานะบอทค้าง
- **Pure Dynamic Channel Locking & Position Shield (Zero Hardcoded Bounds)**:
  - **Dynamic Locked Channel Persistence**: เมื่อบอทเริ่มถือ Position (`isHoldingPosition = true`) ระบบจะตรึงกรอบ Channel (`lockedChannel`) ล่าสุดไว้ 100% และบันทึกลงฐานข้อมูล `grid-bot.db.json` ป้องกันไม่ให้กรอบเลื่อนลงตามราคาที่ย่อตัวลง
  - **Elimination of Hardcoded Bounds (0.1988 / 0.2154 / 0.2110)**: ลบเลข Hardcoded ตายตัวของเหรียญ SOMI ในอดีตทิ้ง 100% ทำให้ระบบรองรับทุกเหรียญ (BTC, ETH, SOMI ฯลฯ)
  - **Dynamic Entry Shield**: หาก `upperBound` ของเหรียญใดๆ อยู่ต่ำกว่าต้นทุนเฉลี่ย (`avgEntry * 1.002`) บอทจะยกเพดาน `upperBound` ขึ้นเหนือต้นทุนเฉลี่ยตามสัดส่วนคณิตศาสตร์ (`Math.max(upperBound, avgEntry * 1.01)`) โดยยังคงฐานแนวรับ (`lowerBound`) ของเหรียญนั้นๆ ไว้อย่างถูกต้อง ไม่วนลูปพ่น log restore ซ้ำๆ อีกต่อไป
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
- **Separation of Settings and Order/Trade Activity Files (`settings.db.json` vs `grid-bot.db.json`)**:
  - **The Problem**: บันทึกการตั้งค่าบอท (Settings) และข้อมูลคำสั่งเทรด/Lots/Orders นับพันรายการถูกรวมอยู่ในไฟล์เดียว (`grid-bot.db.json`) ทำให้ไฟล์บวมและยากต่อการดู/แก้ไขคอนฟิกด้วยมือ
  - **The Solution**: แยกการจัดเก็บอย่างชัดเจน:
    - **`data/settings.db.json`**: จัดเก็บเฉพาะค่าการตั้งค่าบอท (Exchange, API Keys, Private Key, Grid Parameters, Timeframe ฯลฯ) เป็น JSON สะอาดตา อ่านและแก้ไขได้สะดวก
    - **`data/grid-bot.db.json`**: จัดเก็บเฉพาะ State ภายในของบอท, Lots, Orders, Trades, Gas Logs และ PnL ตามเดิม
    - เมื่อผู้ใช้กดบันทึกผ่าน Dashboard หรือเรียก `setSettings()` ระบบจะ Flush ลง `data/settings.db.json` ควบคู่กันเสมอ
- **Dynamic Multi-Exchange Hot-Swap Support (Dashboard Switching to DreamDEX)**:
  - แก้ไขปัญหา Dashboard ไม่ยอมสลับไป DreamDEX:
    - `getRuntimeConfig()` ตอนนี้ส่งฟิลด์ `exchange`, `dreamdexPrivateKey`, และ `dreamdexRpcUrl` ไปยัง Frontend ครบถ้วน
    - เมื่อผู้ใช้เลือก DreamDEX และใส่ Private Key แล้วกด Save ระบบ `onUpdateSettings` ใน `src/index.ts` จะทำการ Re-instantiate `createExchangeClient(...)` เป็น `DreamDexClient` ตัวใหม่
    - เรียก `grid.updateExchangeClient(newExchange, nextInfo)` เพื่อสลับการทำงานทันทีขณะรัน (Hot-Swap) โดยไม่ต้อง Restart บอท
    - สลับคู่เทรดเริ่มต้นเป็น `SOMI` (หรือเหรียญใน Somnia Network) อัตโนมัติหากเดิมเป็นคู่ CEX (เช่น `ETHFDUSD`)
- **Binance WebSocket Streams & Rate-Limit Ban Mitigation (Elimination of IP Ban Error `-1003`)**:
  - **The Problem**: Polling REST API every 200–500ms in `tick()` (`/api/v3/account` weight 20, `/api/v3/openOrders` weight 6, `/api/v3/ticker/bookTicker` weight 2) exhausted Binance's 1,200 weight/minute limit (~8,000 weight/min used), triggering `Binance Error [-1003]: Way too much request weight used; IP banned`.
  - **Zero-Weight WebSocket Book Ticker (`<symbol>@bookTicker`)**:
    - Streams `bestBid`, `bestAsk`, and `mid` in real time directly into memory via `BinanceBookTickerFeed`.
    - Completely replaces the per-tick REST `/api/v3/ticker/bookTicker` request with 0 REST weight consumed.
  - **User Data Stream via WebSocket (`executionReport` & `outboundAccountPosition`)**:
    - Obtains a `listenKey` on boot via `POST /api/v3/userDataStream` and maintains it with a 20-minute keep-alive ping (`PUT /api/v3/userDataStream`).
    - **`executionReport`**: Real-time push notification of order fills (`FILLED`), partial fills (`PARTIALLY_FILLED`), and cancellations (`CANCELED`). Instantly triggers `processBuyFill` / `processSellFill` without polling `/api/v3/openOrders`.
    - **`outboundAccountPosition`**: Real-time push notification of balance changes updating `walletBaseBalance` and `walletQuoteBalance` without polling `/api/v3/account`.
  - **Throttled Sanity Fallback**:
    - REST `refreshWalletBalances()`, `syncOnChainOrders()`, and `reconcileInventory()` are throttled to run only every 30 seconds (`periodicSyncIntervalMs = 30_000`) as a safety sanity check.
    - Rate limit backoff: Handles HTTP 429/418 and `-1003` with warning logs.
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
  - **Rate-Limited Console HUD Logging (`hudLogIntervalMs = 5000`)**:
    - The terminal heartbeat HUD line (`Price: $... | Channel: ... | Zone: ... | Speed: ...`) in `src/strategy.ts` is throttled to at most once every 5 seconds (`lastHudLogTime`).
    - Eliminates terminal log spamming every 200ms when running at high tick speeds (`intervalMs: 200`), keeping the console clean and readable.
    - All critical trading events (`BUY`, `SELL`, `CUT LOSS`, errors) and WebSocket/SSE telemetry to the Web Dashboard remain 100% real-time on every tick without throttling.
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
- **Outside-Bar Swing Dedup (No Single-Candle Channel)**:
  - **สาเหตุของปัญหาเดิม**: แท่ง outside bar (เช่น ETHFDUSD 15m 20:30 H `2544.33` / L `2512.38`) ผ่านเงื่อนไข pivot ทั้งยอดและเหวพร้อมกันใน `recalculateSwings` → ZigZag ได้ `LH` และ `LL` ที่ index เดียวกัน → `isNewCycleFromLow` (`h.index >= macroLow.index`) เข้าใจผิดว่าราคาเด้งจากก้นแล้ว → candidate ยอดเหลือแค่ยอดของแท่งนั้น → กรอบบน/ล่างกลายเป็น High/Low ของแท่งเดียว (กว้าง 1.27% < min 3%) และ Badge LL ถูกบัง
  - **การแก้ไข** (`src/market-structure.ts`):
    1. `recalculateSwings`: ถ้าแท่งเดียวเป็นทั้ง HIGH และ LOW ให้เก็บเพียงฝั่งเดียวตามทิศปิด — แท่งแดง (close < open) = LOW, แท่งเขียว = HIGH
    2. `findMultiTouchSR` และ `getStructure`: `isNewCycleFromLow` / `postLowHighs` / `activeCycleHighs` นับเฉพาะยอดที่เกิด **หลัง** macroLow อย่างเคร่งครัด (`h.index > macroLow.index`)
  - ผลลัพธ์ (ตัวอย่างจริง): กรอบบนกลับไปอิง LH 2 จุดสัมผัส `2574.86`, กรอบล่างอิง LL `2512.38`
  - หมายเหตุ: ไส้ยาวที่เกิน `wickThresholdPct` (เมื่อ `useTrueWick=false`) จะถูกตัดเป็นตัวแท่ง จึงอาจไม่ถูกนับเป็น LL — เป็นพฤติกรรมตาม setting
- **Dynamic Sell Tranche Consolidation (Fast Exit at Target 1 & 2)**:
  - **สาเหตุของปัญหาเดิม**: เมื่อบอทถือ Inventory ขนาดไม่เต็มพอร์ต (เช่น ถือ ~$19.45) ระบบเคยหาร 4 ระดับคงที่ (`trancheQty = held / numEligibleLevels`) ทำให้ได้ไม้ละ $4.84 - $4.88 ซึ่งต่ำกว่า Binance `minNotional` ($5.00) ส่งผลให้ `MIN NOTIONAL GUARD` สั่งข้าม (Skip) การวางคำสั่งขายทั้ง 4 ระดับ และบอทค้างถือเหรียญโดยไม่มี Order บน Order Book
  - **การแก้ไข** (`src/strategy.ts`):
    1. **Dynamic Tranche Consolidation**: ถ้าหารตามจำนวนระดับที่มีแล้วมูลค่าต่อไม้ต่ำกว่า `minOrderNotional` ($5.00) ระบบจะยุบจำนวนไม้ลงมา:
       - หาก `(held / 2) * price >= $5.00` $\rightarrow$ ยุบเหลือ **2 ไม้** ไม้ละ 50%
       - หากยังต่ำกว่า $5.00 (เช่น ถือแค่ $7.00) $\rightarrow$ ยุบเหลือ **1 ไม้** 100%
    2. **Fast Exit Allocation (Sell Target 1 & 2)**: เมื่อยุบเหลือ 2 ไม้ ระบบจะเลือกวางที่ **2 ระดับแรกที่อยู่ใกล้ราคาตลาดที่สุด** (Sell Target 1 60% zone ขาย 50% และ Sell Target 2 70% zone ขาย 50% Full Exit) เพื่อความรวดเร็วในการ Take Profit และคืนทุนเป็น Cash โดยไม่ต้องรอราคาพุ่งไปถึง Target 4 (90%)
    3. **Stale Level Cleanup**: ออเดอร์ที่เคยค้างอยู่ในระดับที่ไม่ถูกเลือก (Target 3, 4) จะถูกยกเลิกอัตโนมัติ เพื่อรวบ Inventory มารวมไว้ใน 2 ไม้ที่ผ่านเกณฑ์ $5.00 อย่างสมบูรณ์ 100%

---

## 5. Coding Standards & Maintenance Rules

1. **ESM `.js` Extension**: Local imports must always include the `.js` extension (e.g. `import { config } from "./config.js";`).
2. **Binance Precision & Filters**: Always apply Binance `tickSize` (price rounding) and `stepSize` (quantity rounding) via `roundToStep()` and enforce `minQty` and `minNotional` before order dispatch.
3. **State Consistency**: Any modification to lots, open orders, or parameters in `strategy.ts` must persist to `this.db.saveState(...)`.
4. **Spot Execution Safety**: In Live Mode (`DRY_RUN=false`), ensure API key permissions and network connectivity. In `DRY_RUN=true` mode, simulate order lifecycle safely in memory.
5. **🚨 ALWAYS Ask for Confirmation (ถามยืนยันทุกครั้งทั้งก่อนแก้และก่อน Push)**:
   - **ก่อนเริ่มแก้ไขไฟล์โค้ด (Before Editing Code)**: อธิบายปัญหา สาเหตุ และแนวทางแก้ไขให้ผู้ใช้ทราบ แล้วถามยืนยันก่อนลงมือแก้ไขไฟล์ทุกครั้ง
   - **ก่อนรัน Git Commit & Push (Before Commit & Push)**: เมื่อแก้ไขโค้ดและผ่าน `npm run typecheck` 100% แล้ว ต้องสรุปรายละเอียดการแก้ไขและเรียกใช้เครื่องมือ `ask_question` เสมอ เพื่อให้ผู้ใช้กดยืนยันอย่างชัดเจน **ห้ามรัน `git commit` หรือ `git push` โดยเด็ดขาดหากยังไม่ได้รับการกดยืนยัน**
6. **Mandatory Persistent Knowledge Update**: ทุกครั้งที่มีการแก้ไขบั๊ก, ปรับ logic หรือเพิ่มฟีเจอร์ ต้องอัปเดต `GEMINI.md` ทันที เพื่อให้บริบทของโปรเจกต์ถูกต้องและตรงกับโค้ดจริงเสมอ

---

## 6. Remote Production Host & Data Freshness Rules

> [!CAUTION]
> **Live Production Runs on a Remote Host**: The live trading bot runs on a remote server/cloud host, **NOT** on this local development machine.
> As a result, local workspace files (`.env`, `data/grid-bot.db.json`, `.grid-state.json`, and local logs) may be outdated, mock data, or not reflect live production conditions.

When investigating live production behavior, debugging issues, or analyzing trades:
1. **Do NOT assume local database/logs are current**: Always ask the user for the latest production files (e.g. current `data/grid-bot.db.json`, production `.env`, or live server console logs) before drawing conclusions.
2. **Explicit Target for Changes**: When proposing configuration tweaks or bug fixes, always clarify whether the change needs to be deployed to the remote production host or tested locally first.
3. **Non-Destructive Local Testing**: Never assume wiping or editing local database files affects the live bot on the remote host.
