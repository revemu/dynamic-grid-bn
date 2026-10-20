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

1. **Exchange Adapter Pattern & Clean CEX vs DEX Decoupling (`src/exchange/types.ts` & `src/exchange/index.ts`)**:
   - ประกาศ Standard Interface: `IExchangeClient` เพื่อรองรับการสลับระหว่าง Binance Spot (CEX) และ DreamDEX Spot (DEX) โดยไม่แตะต้องตรรกะใน Strategy
   - **Strict CEX vs DEX Capability Flags (`isDex`, `hasGasFees`, `nativeGasAsset`, `onGasSpent`)**:
     - แยกตรรกะค่าธรรมเนียมและค่าแก๊สออกจากกันอย่างเด็ดขาด:
       - **CEX (Binance)**: `isDex = false`, `hasGasFees = false` ตัดระบบแก๊ส On-chain ออกทั้งหมด ไม่มีการติดตามแก๊ส ไม่มีการหัก/คืนแก๊ส คิดเฉพาะ CEX Trading Fee (0.075% / 0% Maker) ปกติ
       - **DEX (DreamDEX)**: `isDex = true`, `hasGasFees = true`, `nativeGasAsset = "SOMI"` มีระบบดักฟังค่าแก๊ส On-Chain จาก EVM Transaction Receipt (`client.onGasSpent`) ทุกธุรกรรม (Place, Cancel, Approval, IOC)
     - ใน `strategy.ts`: `wireExchangeGasListener` ผูก `onGasSpent` กับ DEX อัตโนมัติ 100% ทำให้ค่าแก๊สถูกสะสมเข้า `accumulatedGasBase` อย่างต่อเนื่อง และถูกดึงมาชดเชยใน Buy Fill พร้อมแสดงป้าย `🛡️ +... SOMI Gas Ret` และกระจาย Event `order_gas` ไปอัปเดตแถบ Activity Feed ทันที
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
   - **Confirmed Candles Only Channel Bounds Architecture (`adjustChannelOnClosedOnly`)**:
     - **สาเหตุของปัญหากรอบราคาขยับขึ้นลงตลอดเวลา**:
       1. ใน `src/strategy.ts` เมธอด `step()` ทำงานเป็น Main Loop ทุก 1 วินาที (Tick) และส่งราคา Real-time ล่าสุด (`refPrice`) เข้า `dowEngine.getStructure(refPrice)` ตลอดเวลา
       2. แท่งเทียนแท่งล่าสุดที่กำลังก่อตัวอยู่ (Unclosed/Live Candle) มีการอัปเดต High/Low/Close ตามราคาทุก Tick ทำให้สวิงและระยะ `minChannelWidthPct` (ซึ่งคิดเป็น % จากราคาปัจจุบัน) ขยับตามราคาไปเรื่อยๆ
       3. เมื่อไม่ได้ถือ Position (100% Cash) ระบบจะไม่เปิดใช้ Hysteresis ส่งผลให้กรอบราคา (Floor, Ceiling, Center) และเส้นกริด Buy/Sell Levels ส่ายขึ้นลงตามความผันผวนย่อย (Noise) ในแท่งเทียนตลอดเวลา
     - **การแก้ไขและสถาปัตยกรรมใหม่**:
       1. **เพิ่มการตั้งค่า `adjustChannelOnClosedOnly` (ค่าเริ่มต้น: `true`)**:
          - รองรับทั้งใน `src/config.ts`, `data/settings.db.json` และมี Toggle Switch ในหน้าต่าง Settings Modal บนเว็บแดชบอร์ด
       2. **คำนวณและปรับกรอบเฉพาะแท่งเทียนที่ยืนยันแล้ว (Confirmed Candle Close)**:
          - ใน `src/market-structure.ts`: เพิ่มออปชัน `useOnlyClosedCandles?: boolean` ให้กับ `getStructure` เพื่อให้การค้นหา Swings, Donchian High/Low, และโครงสร้าง Dow Theory คำนวณจากแท่งเทียนที่ปิดสมบูรณ์แล้วเท่านั้น (`getClosedCandles()`) และอ้างอิงราคาปิดของแท่งเทียนที่ยืนยันแล้ว
          - ใน `src/strategy.ts`: เก็บ State `confirmedChannel` แคชระดับกรอบราคาไว้ระหว่างแท่งเทียน และรีคำนวณเฉพาะเมื่อแท่งเทียนปิดสมบูรณ์ (`lastClosedTime !== this.confirmedChannel.candleTime`) หรือเมื่อมีการสลับเหรียญ/เปลี่ยนการตั้งค่า
          - ใน `src/index.ts`: เมื่อ WebSocket Kline Feed ส่งสัญญาณ `isClosed === true` จะเรียก `grid.onCandleClosed(candle)` และปลุก `wakeSleep?.()` ให้บอทปรับกรอบทันทีในระดับ Milliseconds
       3. **ความเสถียรในการเทรด**:
          - ระหว่างแท่งเทียนที่ยังไม่ปิด: กรอบราคา (Floor, Ceiling, Buy Levels 1-4, Sell Targets 1-4) นิ่งสนิท 100% ไม่เลื่อนหนีไปมา
          - การส่งคำสั่งและการจับคู่ (Buy/Sell/Cut Loss/Take Profit): ราคายังคงวิ่งแบบ Real-time ตรวจจับการแตะระดับราคาเป้าหมายได้อย่างแม่นยำ
   - **Unbroken Confirmed Valley & Peak Channel Anchoring (`isUnbrokenValley` & `isUnbrokenPeak` in `src/market-structure.ts`)**:
     - **สาเหตุของปัญหากรอบไม่เกาะเหวและยอดที่ยืนยันแล้วของคลื่นปัจจุบัน**:
       1. `baseValley` เดิมหาจุดต่ำสุด (`minLow`) ของคลื่นทั้งหมดตั้งแต่อดีต (เช่น `$0.193200`) แทนที่จะเกาะเหวยืนยันที่ยังไม่ถูกทำลายซึ่งรองรับราคาปัจจุบันอยู่ (เช่น `⭐ HL ~$0.1978`)
       2. ตรรกะการขยับขอบล่างขึ้นมาเกาะ `HL` เดิมถูกบล็อกด้วยเงื่อนไข `!isLatestLowLl` ทำให้เมื่อเหวด้านบนที่เพิ่งหลุดลงมามีป้าย `LL` ระบบจะข้ามการเกาะเหว `⭐ HL` ที่อยู่ใต้ราคาไปเลย
       3. เมื่อขอบล่างค้างอยู่ที่เหวเก่า (`$0.193200`) ทำให้ระยะห่างถึงยอด `🚀 HH` ล่าสุด (`~$0.2060`) เกิน `maxChannelWidthPct` ระบบจึงเข้าใจผิดและกดขอบบน (`upperBound`) ลงไปเกาะยอด `HH` เก่าในอดีต (`$0.204167`) ที่เกิดก่อนหน้า `activePeak` และถูกทะลุทำลายโครงสร้างไปแล้ว
     - **การแก้ไขและสถาปัตยกรรมใหม่ (`src/market-structure.ts`)**:
       1. **นิยามสวิงยืนยันที่ยังไม่ถูกทำลาย (`isUnbrokenValley` / `isUnbrokenPeak`)**:
          - เหวที่ยืนยันแล้ว (`v`) ถือว่ายังไม่ถูกทำลาย หากไม่มีเหวยืนยันในอนาคต (`later.index > v.index`), ไม่มี `candidateValley` (`candidateValley.time > v.time`) และไม่มีแท่งเทียนถัดมา (`c.time > v.time`) ที่ทำจุดต่ำสุด (`getEffectiveLow`) ต่ำกว่า `v.price` (ป้องกันไม่ให้บอทยกฐานกรอบขึ้นไปเกาะเหวที่เพิ่งถูกแท่งเทียนทุบทะลุลงไปแล้วแต่ยังรอปิดครบ 3 แท่ง)
          - ยอดที่ยืนยันแล้ว (`p`) ถือว่ายังไม่ถูกทำลาย หากไม่มียอดยืนยันในอนาคต, ไม่มี `candidatePeak` และไม่มีแท่งเทียนถัดมาที่ทำจุดสูงสุด (`getEffectiveHigh`) สูงกว่า `p.price`
       2. **การยึดขอบล่างกับเหวยืนยันล่าสุดใต้ราคา (`validWidthValleys`, `validLows` & `candidateValleys`)**:
          - ค้นหาเหวยืนยันที่ยังไม่ถูกทำลาย (`isUnbrokenValley`) และอยู่ต่ำกว่าราคาปัจจุบัน (`l.price <= price`) เรียงจากเหวที่ใกล้ราคาที่สุดลงไป ซึ่งให้ความกว้างกรอบอยู่ในเกณฑ์ `[minSpan, maxSpan]` โดยบังคับเช็ค `isUnbrokenValley` ในทุกขั้นตอนของการเลือกแนวรับ (`lowerValleys`, `lowerConfirmedLows`, `validLows`, `lowerConfirmedValleys`, `lowerLow`)
       3. **การยึดขอบบนกับยอดยืนยันปัจจุบัน (`activePeak` & Post-Peak Unbroken Lower Highs)**:
          - ยึดยอดสูงสุดของคลื่นปัจจุบัน (`activePeak`) เป็นเพดานหลัก และห้ามดึงเพดานลงไปเกาะยอดเก่าที่เกิดก่อน `activePeak` (`h.index < activePeak.index`) โดยเด็ดขาด
          - การปรับลดเพดานลงทำได้เมื่อเกิดยอดที่ยืนยันแล้วหลังจาก `activePeak` (`h.index > activePeak.index`) ซึ่งมีราคาต่ำกว่า `activePeak` (`h.price < activePeak.price`) และยังไม่ถูกทำลาย (`isUnbrokenPeak`) แม้ว่าก่อนหน้านั้นจะมีสวิงย่อยเล็กๆ ทำให้ป้าย `dowLabel` เป็น `HH` เทียบสวิงย่อยก็ตาม
       4. **การประสานระบบรอตั้งฐาน (`isDowntrendDropActive`, `downtrendDropLow`, `checkForHigherLow` & `breakdownTime`) ให้สัมพันธ์กับจุดต่ำสุดจริง (`src/market-structure.ts` & `src/strategy.ts`)**:
          - เมื่อราคาทำจุดต่ำสุดใหม่ระหว่างรอตั้งฐาน (`refPrice < this.breakdownLowPrice`) จะอัปเดต `this.breakdownTime` เป็นเวลาของจุดต่ำสุดใหม่เสมอ
          - ใน `checkForHigherLow`: ค้นหาเวลาจริงของแท่งเทียนที่ทำจุดต่ำสุดของการทุบ (`effectiveSinceTime`) และบังคับว่าสวิงที่จะมายืนยัน `Higher Low (HL)` ต้องเกิดขึ้นหลัง `effectiveSinceTime` และยังไม่ถูกแท่งเทียนถัดมาทุบหลุด (`isSwingLowUnbroken`) ป้องกันไม่ให้บอทนำสวิง `LL` ก่อนการทุบมาปลดล็อก `waitingForHigherLow` หรือ `downtrendDropPaused` ก่อนเวลาอันควร
          - แยกแยะการย่อตัวเข้าโซนซื้อในกรอบ (`price >= bottomBound` เมื่อยอดคลื่นเป็น `HH`) ออกจากกรณีหลุดฐานกรอบจริง (`price < bottomBound` หรือ `LH + LL` กดตัว) และคำนวณ `downtrendDropLow` โดยอ้างอิงจากยอดของกรอบปัจจุบัน (`activePeak`)
   - **Strict IOC Buy & Sell Level Execution & Slippage Elimination Architecture (`src/strategy.ts`):**
     - **สาเหตุของปัญหา**:
       1. **IOC Buy ชิงซื้อก่อนราคาลงมาถึงเป้า และส่งราคาซื้อสูงกว่า Buy Level**:
          - ใน `executeIocBracketGrid`: โค้ดเดิมยอมให้ Trigger ซื้อล่วงหน้าตั้งแต่ `currentBestAsk <= lvlPrice * (1 + buySlippage)` หรือ `tlPrice * 1.0025` แม้ว่าราคา Ask และ `refPrice` จะยังไม่ย่อตัวลงมาถึงระดับเส้นซื้อจริง
          - ใน `buyTrancheIOC`: โค้ดเดิมอนุญาตให้บวก Slippage เหนือ `targetPrice` ด้วยสูตร `maxAllowedPrice = targetPrice * (1 + slippagePct)` ทำให้ส่ง Limit Buy ที่ราคาแพงกว่า Level (เช่น Buy Level 3 อยู่ที่ `$0.199716` แต่ส่งซื้อและ Fill ที่ `$0.2000`)
       2. **IOC Sell ชิงขายก่อนราคาขึ้นถึงเป้า และหัก Slippage ลงมาขายต่ำกว่า Sell Target**:
          - ใน `executeIocBracketGrid` และ `syncRestingOrders`: โค้ดเดิมยอมให้ Trigger ขายทำกำไรเมื่อ `currentBestBid >= lvlPrice * (1 - sellSlippage)` หรือ `lvlPrice * 0.998` แม้ว่า Bid จะยังอยู่ต่ำกว่า Sell Target
          - ใน `sellTrancheIOC` และ `sellAll` (เมื่อ `action === "SELL"`): โค้ดเดิมคำนวณ `minAllowedBySlippage = targetPrice * (1 - slippagePct)` ทำให้บอทส่งคำสั่งขายที่ราคาต่ำกว่าเป้าหมาย (เช่น เป้า `$0.1979` แต่ส่งขายและ Match ที่ `$0.1976`)
          - ใน `Resistance IOC Exit` และ `100% Take Profit`: ยอมให้ยิงคำสั่งขายเมื่อ `refPrice` ชนเป้า แม้ว่าราคา `Best Bid` จริงบนกระดานจะยังขึ้นมาไม่ถึงแนวต้านหรือเพดานเป้าหมาย
     - **การแก้ไขและสถาปัตยกรรมใหม่ (`src/strategy.ts`):**
       1. **Strict IOC Buy Trigger & Hard Price Ceiling**:
          - ใน `executeIocBracketGrid`: บังคับให้ **`currentBestAsk > 0 && currentBestAsk <= lvlPrice && refPrice <= lvlPrice`** อย่างเด็ดขาด (และ `currentBestAsk <= tlPrice && refPrice <= tlPrice` สำหรับ Trendline Support Buy) ถ้าราคา Ask ยังไม่ลงมาแตะหรือต่ำกว่าเส้นจริง บอทจะไม่รีบยิงซื้อ
          - ใน `buyTrancheIOC`: กำหนด `maxAllowedPrice = targetPrice` อย่างเด็ดขาด โดย Limit Price จะไม่มีทางสูงกว่า `targetPrice` (`Math.min(targetPrice, basePrice * (1 + slippagePct))`)
       2. **IOC Sell Execution Policy (Grid Tranche, Trendline / Resistance Exit & Sell All)**:
          - **การขายแบบแบ่งไม้ตามกริด (`sellTrancheIOC`, `executeIocBracketGrid` & `syncRestingOrders`)**: ยอมให้ส่งราคาขายต่ำกว่าเส้นเป้าหมายลงมาได้ตาม Slippage (`targetPrice * (1 - sellSlippage)`) และ Trigger เมื่อ `currentBestBid >= lvlPrice * (1 - sellSlippage) || refPrice >= lvlPrice` เพื่อให้จับคู่กับ Bid ใน Orderbook ได้ทันที ไม่หลุด Match โดยยังคงคุ้มครองไม่ให้ขายต่ำกว่าทุนเฉลี่ย (`minProfitablePrice = avgEntry * 1.0005`)
          - **การขายทำกำไรที่แนวต้านเส้นกดและเพดาน (`Resistance IOC Exit` & `sellAll(..., "SELL")`)**: นำค่า `iocSlippagePct` มาคำนวณระยะเผื่อ Slippage (`minAllowedResPrice = effectiveResPrice * (1 - sellSlippage)`) เพื่อไม่ให้บอทพลาดโอกาสขายทำกำไรบนกระดาน DEX ที่ Best Bid มักตามหลังราคาชนแนวต้าน 1–3 ช่องราคา:
            1. **Trigger & Liquidity Check**: ยิงคำสั่งทันทีเมื่อ `refPrice >= minAllowedResPrice || effectiveBestBid >= minAllowedResPrice` โดยมี `effectiveBestBid >= minAllowedResPrice` และ `effectiveBestBid >= avgEntry * 1.0005` (ต้องมีกำไรเหนือทุนเฉลี่ยเสมอ)
            2. **Slippage-Aware Limit Price in `sellAll`**: คำนวณ `minAllowedBySlippage = targetPrice * (1 - slippagePct)` โดยส่ง Limit Price เท่ากับ `Math.max(minAllowedPrice, basePrice * (1 - slippagePct))` และยังคงล็อกไม่ให้ต่ำกว่าจุดคุ้มทุน `avgEntry * 1.0005` อย่างเด็ดขาด
            3. **Transparent Dashboard Display**: แสดงค่า Slippage ในแถบสถานะและคำแนะนำ Trigger เช่น `IOC Sell when price touches TL ($0.2008 • slip 0.15%)` เพื่อให้ผู้ใช้ทราบสถานะที่แท้จริงแบบ Real-time
       3. **Safeguard Protection for Emergency Exits**:
          - ระบบยังคงอนุญาตให้ใช้ Slippage สำหรับกรณีฉุกเฉิน `action === "CUT"` (Cut Loss) และ `"MANUAL"` (Manual Exit) เพื่อรับประกันว่าจะสามารถระบายเหรียญตัดขาดทุนหนีตายได้ทันท่วงที 100%
   - **Instant Pair Switching & Cross-Symbol Feed Isolation (`symbolChanged` & `exchangeChanged`):**
      - **สาเหตุของปัญหากรอบราคาเพี้ยน ($103.15 .. $2510.83):**
        1. เมื่อสลับคู่เหรียญ (เช่น จาก `ETHFDUSD` เป็น `SOLFDUSD`) ใน `src/index.ts` เดิมเรียก `grid.updateSymbolInfo(nextInfo)` โดยที่ `grid.atrSource` ถูกประกาศเป็น `readonly` และไม่มีการส่งต่อ `atrSource` ใหม่เข้าไป
        2. `grid.atrSource` จึงยังคงผูกกับ Feed เก่าของ ETH ที่ถูกหยุดไปแล้ว และจำราคาอ้างอิงล่าสุดไว้ที่ `$2509.580000`
        3. ใน `src/strategy.ts` ตอนคำนวณ `refPrice = binancePrice ?? effectiveMid` ได้ดึงราคา `$2509.58` ของ ETH มาเป็นราคาอ้างอิงของ SOL ($106.95)
        4. ตรรกะ Price Enclosure ใน Dow Channel จึงถูกบังคับขยาย Ceiling ขึ้นไปคลุมราคา $2509.58 กลายเป็น `$2510.834790` (กว้าง 2334%)
        5. นอกจากนี้ ค่าสถานะในหน่วยความจำเดิม เช่น `lockedChannel`, `lastDynamicBounds`, `lastRefPrice`, `wsBookTicker`, `waitingForHigherLow`, `breakdownFloorPrice`, `iocBracketSellCycle` ของเหรียญเดิมไม่ถูกล้างออก ทำให้รั่วไหลไปสู่เหรียญใหม่
      - **การแก้ไข:**
        1. ใน `src/strategy.ts`: ปลด `readonly` จาก `atrSource` และให้ `updateSymbolInfo(info, newAtrSource?: AtrSource)` และ `updateExchangeClient(newClient, info?, newAtrSource?: AtrSource)` รับ Feed ใหม่ไปแทนที่ `this.atrSource` ทันที
        2. เมื่อสลับเหรียญ ให้ล้าง State เฉพาะของเหรียญเดิมในหน่วยความจำทิ้งทั้งหมด: `lastRefPrice = undefined`, `wsBookTicker = undefined`, `lastDynamicBounds = undefined`, `lockedChannel = undefined`, `waitingForHigherLow = false`, `breakdownFloorPrice = undefined`, `breakdownLowPrice = undefined`, `breakdownTime = undefined`, `iocBracketSellCycle = undefined`, `orderCooldowns.clear()`
        3. ใน `loadState()`: เพิ่ม `else` branch ชัดเจน หากเหรียญใหม่ไม่มี `lockedChannel`, `waitingForHigherLow` หรือ `iocBracketSellCycle` ในฐานข้อมูล ให้รีเซ็ตเป็น `undefined` / `false` เสมอ ไม่ปล่อยให้ค่าเก่าค้าง
        4. ใน `src/index.ts`: ปรับลำดับการทำงานใน `symbolChanged` และ `exchangeChanged` ให้โหลด `await initFeeds(nextInfo.symbol)` ให้เสร็จก่อนเสมอ แล้วจึงส่ง `atrSource!` เข้า `grid.updateSymbolInfo(nextInfo, atrSource!)` หรือ `grid.updateExchangeClient(newExchange, nextInfo, atrSource!)`
        5. ล้างประวัติกราฟบนหน้าแดชบอร์ดด้วย `dashboard.resetState({ clearTrades: false })` และ `dashboard.setInitialCandles(...)` พร้อมเรียก `wakeSleep?.()` ปลุก Main Loop ให้รีคำนวณกรอบ Channel ของเหรียญใหม่ได้ทันที 100% โดยไม่ต้องรอจังหวะ Sleep เดิม
   - **Trading Pair & Exchange Switching Protection Guard (Position Lock)**:
      - **สาเหตุของปัญหา**: หากผู้ใช้เผลอกดสลับเหรียญบน Dropdown หัวเว็บ (`#topSymbolSelect`) หรือในหน้าต่าง Settings (`#cfg_symbol` / `#cfg_exchange`) ในขณะที่บอทกำลังถือครอง Position อยู่ (มีเหรียญ Base หรือ Lots ค้างในหน่วยความจำ) ระบบจะสลับคู่เทรดทันทีและทิ้ง Position เดิมไว้ ทำให้เหรียญที่ถืออยู่ค้างในกระเป๋าและหลุดออกจากการจัดการของบอท
      - **การแก้ไข**:
        1. **Backend Protection (`src/index.ts`)**: ใน `onUpdateSettings` เพิ่ม Guard ตรวจสอบ `if ((symbolChanged || exchangeChanged) && isHoldingPosition)` โดยตรวจทั้ง `grid.baseHeld() > minQty` และ `grid.getLots().length > 0` หากบอทกำลังถือ Position อยู่ จะโยน Error ปฏิเสธการสลับเหรียญหรือกระดานทันที พร้อมแจ้งเตือนจำนวนเหรียญและ Lots ที่ต้องเคลียร์ก่อน
        2. **Frontend UI Lock (`public/app.js`)**: ในฟังก์ชัน `updateTick` เมื่อพบว่าบอทมี Position (`lots.length > 0` หรือ `baseHeld > 0` หรือ `holdPct > 0`) จะตั้งค่า `disabled = true`, `cursor = not-allowed`, `opacity = 0.6` ให้กับ `#topSymbolSelect`, `#cfg_symbol`, และ `#cfg_exchange` พร้อม Tooltip: `🔒 ปิดการเปลี่ยนคู่เทรดชั่วคราวเนื่องจากบอทกำลังถือ Position อยู่` และใน Event Listener ของ `#topSymbolSelect` จะตรวจสอบ Guard และแสดง Toast Alert ปฏิเสธทันที
   - **Anchor LL Floor & Upward Peak Search / L2 Breakdown Structure Recovery (src/market-structure.ts & src/strategy.ts)**:
     - **สาเหตุของปัญหา**:
       1. **กรอบลอยในอากาศใต้ LL เมื่อตลาดทุบลงเรื่อยๆ**: ใน src/market-structure.ts เมื่อกรอบระหว่างยอดและเหวแคบกว่า minChannelWidthPct โค้ดเดิมใช้วิธีลบขอบล่างลงในอากาศ (ottomBound -= needed และ curFloor -= needed) ทำให้ Floor ลอยอยู่ใต้เหว LL จริงของแท่งเทียน ส่งผลให้เส้น Buy Levels ลอยเคว้งและเปิดรับของผิดจังหวะกลางอากาศ
       2. **L2 Recovery หลอกตัวเองขณะราคาไหลลง**: ใน src/strategy.ts เมื่อราคาหลุด Floor และ Cut Loss ไปแล้ว ระบบจำกัดการซื้อ (waitingForHigherLow = true) แต่ uyLevel2Price = buyLevels[1] ไปอิงตาม Buy Level 2 ของกรอบใหม่ที่เพิ่งเลื่อนรูดต่ำลงมาตามราคา เมื่อราคาเด้งทางเทคนิคสั้นๆ จึงเข้าใจผิดว่าราคากลับมายืนเหนือโซน 30% ได้แล้ว และรีบปลดล็อกเข้าซื้อก่อนทำ Higher Low จริง
       3. **Drop Guard ไม่ตรวจจับการทุบฉับพลันหลังยอด HH**: โค้ดเดิมดักจับเฉพาะรูปแบบ LH + LL ทำให้เมื่อราคาทำยอด HH แล้วรูดทำ New Low ทันที (HH + LL) ระบบยังไม่ถือว่าเป็นรอบคลื่นขาลง จึงไม่สั่งหยุดซื้อ
     - **การแก้ไขและสถาปัตยกรรมใหม่**:
       1. **Anchor LL Protection & Upward Peak Search (src/market-structure.ts)**:
          - ในช่วงขาลงหรือทำ New Low: ฐานกรอบ (Floor) ต้องยึดติดกับจุดต่ำสุดจริงของสวิง Low / LL ล่าสุดเสมอ (ottomBound ไม่ถูกลบลอยลงในอากาศ)
          - หากความกว้างแคบกว่า minChannelWidthPct: ให้กวาดสายตาขึ้นไปข้างบนเพื่อค้นหายอดต้านในอดีต (canonicalHighs เหนือราคา) หรือปรับขยาย Ceiling ขึ้นไป เพื่อรักษาฐาน LL ด้านล่างให้ติดดินตาม Dow Theory
       2. **Original Broken L2 Anchoring & Confirmed Close Only (src/strategy.ts)**:
          - เมื่อเกิด Floor Breakdown หรือ Cut Loss ระบบจะบันทึกระดับ Buy Level 2 ของกรอบเดิมที่พังไว้ (reakdownBuyLevel2Price)
          - การจะปลดล็อกด้วย L2 Recovery ได้ ราคาจะต้องมีแท่งเทียนที่ปิดสมบูรณ์แล้ว (getClosedCandles()) ยืนเหนือ effectiveBuyLevel2Target ของกรอบเดิมเท่านั้น (ตัดเงื่อนไข unconfirmed live-tick ทิ้ง)
       3. **Comprehensive Downtrend Drop Detection (src/market-structure.ts)**:
          - เพิ่มการตรวจจับ isHhThenLlBreakdown: ตรวจสอบกรณีที่ยอดล่าสุดเป็น HH แต่ตามด้วยสวิง Low ที่รูดทำ LL หลุดฐานเหวก่อนหน้า เพื่อให้บอทเปิดโหมด DOWNTREND_DROP_WAIT_BASE หยุดรับของและรอตั้งฐาน HL ทันที
   - **Preserved Locked Channel & Direct Real Ceiling Take Profit Architecture (`liveRealCeil` Take Profit)**:
      - **สาเหตุของปัญหา**:
        1. เมื่อบอทเข้าถือ Position (`isHoldingPosition = true`) ระบบจะเปิดใช้งาน `lockChannelInPosition` (Strict Freeze 100%) เพื่อป้องกันไม่ให้กรอบเลื่อนลงมาจนเทขายขาดทุน
        2. ในตลาดจริง เมื่อโครงสร้าง Dow Theory หรือกรอบ Donchian ของแท่งเทียนจริงสร้างสวิงใหม่และเลื่อนแนวต้านจริงลงมา (`Real S/R Ceil` ต่ำลง เช่น จาก $0.2132 -> $0.2088)
        3. หากไประบบดึง `Locked Ceil` ยุบลงมาทับ `Real Ceil` จะทำให้กรอบหลักยุบตัวแคบลง และเส้นประ `🎯 Real S/R Ceil` กับข้อความ `• Real Ceil` ใน Header จะหายไปจากหน้าจอทันทีเนื่องจากราคาซ้ำกับ Locked Ceil
      - **การแก้ไขและสถาปัตยกรรมที่ถูกต้อง**:
        1. **Preserved Locked Channel Structure (`src/strategy.ts`)**:
           - คงระดับ `Locked Ceil` (เช่น $0.2132) และ `Locked Floor` (เช่น $0.2046) ไว้อย่างมั่นคง เพื่อรักษาโครงสร้างของกรอบเดิมและความกว้างของ Channel ไม่ให้ยุบตัว
           - เส้นประ **`🎯 Real S/R Ceil: $0.2088`** และข้อความใน Header จะยังคงแสดงผลแยกจาก Locked Ceil อย่างชัดเจน 100%
           - มีระบบ Auto-restore ตรวจจับหาก Locked Ceil เคยถูกยุบตัวลงไป จะกู้คืนกลับไปยัง Macro Peak เดิมให้โดยอัตโนมัติ
        2. **Direct Real Ceiling Take Profit (`src/strategy.ts`)**:
           - ในฟังก์ชัน `Take Profit at Upper Bound`: เพิ่มการตรวจสอบ `isLiveRealCeilReached = refPrice >= liveCalculatedCeil || bestBid >= liveCalculatedCeil`
           - เมื่อราคาตลาดวิ่งชนหรือทะลุ `liveCalculatedCeil` ($0.2088) และราคานั้นได้กำไร (`isProfitableExit === true`): ระบบจะสั่ง **100% Take Profit Exit** ทันที เพื่อเก็บกำไรเข้ากระเป๋าและปลดล็อครอบทันที ไม่ปล่อยให้ราคาชนแนวต้านจริงแล้วทุบกลับลงมาขาดทุน โดยไม่ต้องไปดึงกรอบหลักให้ยุบตัวลงมาทับ
       - **Proximity-Guarded Channel Bounds & Anti-Churning Buy Allocation Architecture**:
      - **สาเหตุของปัญหากรอบบนทะลุไปไกล ($108.03 vs $105.38) และบอทตั้งซื้อวนซ้ำ (Churn Loop)**:
        1. **Unrestricted Swing Leap ใน `src/market-structure.ts`**: เมื่อความกว้าง Channel ขาดระยะจาก `minSpan` เล็กน้อย (เช่น ขาดเพียง $0.003) โค้ดเดิมค้นหา `canonicalHighs` ที่ `price > upperBound` โดยไม่มีการจำกัดระยะ (Proximity check) ทำให้กระโดดข้ามสวิงย่อยในปัจจุบันขึ้นไปเกาะยอดโบราณ ($108.03) ส่งผลให้เพดานดีดตัวกว้างเกินจริง
        2. **Locked Ceiling Inflation ใน `src/strategy.ts`**: โค้ดเดิมดึง `macroPeak` ขึ้นไปคืนค่าให้ `lockedChannel.upperBound` ส่งผลให้กรอบบนที่ถูกล็อกถูกดันขึ้นไปที่ $108.03 อย่างถาวร และทำให้เส้น Real S/R Ceil หายไปจากหน้าจอ
        3. **Real Ceil Hiding Glitch ใน `public/app.js`**: เมื่อราคาคำนวณจริงเท่ากับหรือใกล้เคียงกับกรอบบน (`<= 0.001`) โค้ดเดิมซ่อนข้อความ `• Real Ceil` และลบเส้นประ `🎯 Real S/R Ceil` ออกจากชาร์ต ทำให้ผู้ใช้ไม่เห็นแนวต้านจริง
        4. **Infinite Cancel/Place Churn Loop ในการคำนวณ Buy Capacity**: เมื่อผู้ใช้มีงบ $100 ซื้อไปแล้ว $70.35 เหลืองบ $29.65 แต่เงินสด FDUSD ในกระเป๋าจริงมีเพียง $20.09 บอทตั้งซื้อได้ $20.03 พอส่งคำสั่งแล้ว Tick ถัดไประบบเปรียบเทียบ $20.03 กับทฤษฎี $29.65 พบว่าเบี่ยงเบน > 10% จึงสั่ง Cancel และตั้งใหม่ซ้ำๆ ทุกวินาที อีกทั้งการคำนวณงบต่อไม้ไม่ได้หักลบยอดออเดอร์ซื้ออื่นที่ค้างอยู่บนกระดาน ทำให้สัดส่วนซื้อรวมอาจเกินงบ $100 ที่กำหนดไว้
      - **การแก้ไขและสถาปัตยกรรมใหม่**:
        1. **Proximity-Guarded Channel Expansion & Max Span Cap (`src/market-structure.ts`)**:
           - เพิ่ม Tolerance Threshold 95% (`upperBound - bottomBound < minSpan * 0.95`) ป้องกันการดีดกรอบเมื่อขาดเพียงเศษทศนิยม
           - หากจำเป็นต้องขยายกรอบ จะตรวจสอบสวิงใกล้เคียงในระยะ `needed * 1.5` เท่านั้น และให้ความสำคัญกับการขยาย Floor ลงไปก่อนเพื่อรักษาแนวต้านปัจจุบัน
           - เพิ่ม Hard Guarantee บังคับให้ความกว้างของ Channel ไม่มีทางเกิน `maxSpan` (`upperBound - bottomBound <= maxSpan`)
        2. **Removal of Macro Peak Inflation & Enforce Max Span Clamp on Locked Channel (`src/strategy.ts`)**:
           - ลบตรรกะการดันเพดานกลับไปหา `macroPeak` ออก และเพิ่ม Max Span Clamp ให้กับ `this.lastDynamicBounds.upperBound` เพื่อจำกัดความกว้างกรอบไม่ให้เกิน `maxChannelWidthPct` (5%)
        3. **Real S/R Ceil Always-Visible Display (`public/app.js`)**:
           - ปลดเงื่อนไขซ่อนเส้นออก ทำให้ข้อความ `• Real Ceil` ใน Header และเส้นประสีชมพู `🎯 Real S/R Ceil` บนชาร์ตแสดงผลตลอดเวลาขณะที่กรอบถูกล็อก เพื่อให้ผู้ใช้เห็นแนวต้านจริงของโครงสร้างราคาเสมอ
        4. **Airtight Capacity Accounting & Anti-Churning Order Rebalancing (`src/strategy.ts`)**:
           - ในการคำนวณงบซื้อของแต่ละไม้ จะนำยอดออเดอร์ซื้ออื่นๆ ที่ค้างอยู่บนกระดาน (`otherOpenBuysQuote`) มาหักลบออกจาก `currentAvailableCapacity` ก่อนเสมอ ทำให้ยอดรวมของพอร์ต (เหรียญที่ถือ + ออเดอร์ซื้อทั้งหมด) ไม่มีทางเกิน `maxInventoryQuote` ($100) อย่างเด็ดขาด
           - ตรวจสอบ `maxPossibleBudget` อ้างอิงจากเงินสดจริงในกระเป๋า (`walletQuoteBalance + currentOrderNotional`) หากออเดอร์บนกระดานใช้เงินสดสูงสุดเท่าที่ทำได้แล้ว จะไม่สั่ง Cancel มาตั้งใหม่เด็ดขาด
           - กำหนด Guard `canResize` ต้องมีความต่างของงบอย่างน้อย $\ge \max(\text{minNotional} \times 0.5, \$2.00)$ และปิดการ Churn ทุก Tick บน CEX ตัดปัญหา Cancel/Replace Loop บน Binance โดยสิ้นเชิง
- **Strict Total Committed Capital & Buy Allocation Guard (Elimination of Over-allocation & Churn Loops)**:
      - **สาเหตุของปัญหา**:
        1. เมื่อบอทเข้าซื้อสะสมจนพอร์ตในมือเติบโตขึ้น (เช่น ซื้อแล้ว $70.35 จากงบ $100) โควตาเงินสดคงเหลือจริงสำหรับวางซื้อคือ `$29.65` ($100 - $70.35)
        2. ระดับ `Buy Level 3` (เป้าหมายสะสม 75%) ถูกพอร์ตสะสมผ่านไปแล้ว 70% ทำให้ `Buy Level 3` หลุดจาก `eligibleBuyIndices`
        3. อย่างไรก็ตาม โค้ดลูปเดิมไม่ได้สั่ง Cancel ออเดอร์ซื้อที่ค้างอยู่บนกระดานของระดับที่หลุดโควตาไปแล้ว ทำให้ออเดอร์ Buy Level 3 เดิม ($29.92) ยังคงคาอยู่บนกระดานและล็อกเงินสด FDUSD ไว้
        4. ส่งผลให้ยอดออเดอร์รอซื้อรวมกลายเป็น $29.92 (Level 3) + $20.83 (Level 4) = **$50.75** เมื่อรวมกับของในมือ $70.35 พอร์ตจึงทะลุเป็น **$121.10** (เกินงบ $100)
        5. นอกจากนี้ เมื่อบอทพยายามปรับขนาดไม้ Level 4 ให้เท่ากับงบที่เหลือ ($29.65) แต่เงินสดในกระเป๋าเหลือเพียง $20.09 (เพราะอีก $29.92 ติดล็อกอยู่ใน Level 3) บอทจึงถูกบังคับลดไซส์เหลือ $20.03 พอส่ง $20.03 ไป ใน Tick ถัดไประบบตรวจพบว่าไม่ตรงกับเป้า $29.65 จึง Cancel และพยายามส่งใหม่ เกิดเป็น **Infinite Cancel/Place Churn Loop ทุก 500ms** บน Binance
      - **การแก้ไขและสถาปัตยกรรมใหม่**:
        1. **Ineligible Level Cancel Guard (`src/strategy.ts`)**:
           - ในทุกๆ Tick ตรวจสอบออเดอร์ซื้อทั้งหมด หากพบว่ามีออเดอร์ใดอยู่ในระดับที่ไม่ได้อยู่ใน `eligibleBuyIndices` อีกต่อไป (เช่น พอร์ตสะสมจนเกินเป้าโควตาของ Level นั้นแล้ว) ระบบจะสั่ง **Cancel ทันที** เพื่อปลดล็อกเงินสดกลับเข้ากระเป๋า
        2. **Buy Rebalance on Buy Fills (`processBuyFill`)**:
           - เพิ่ม `this.needsBuyRebalance = true;` ทุกครั้งที่เกิด Buy Fill เพื่อให้ระบบสั่งรีบาลานซ์และปรับขนาดออเดอร์ซื้อที่เหลือให้พอดีกับงบคงเหลือทันทีใน Tick ถัดไป
        3. **Strict Total Buy Exposure Cap Guard**:
           - บังคับใช้กฎ Invariant: $\text{Total Open Buys} \le \text{currentAvailableCapacity} = \max(0, \text{maxInventoryQuote} - \text{currentHeldQuote})$
           - ทุกคำสั่งซื้อใหม่และการปรับขนาด จะถูก Cap ด้วย `currentAvailableCapacity` เสมอ ทำให้ผลรวมของเหรียญที่ถืออยู่ + ยอดรอซื้อทั้งหมดไม่มีทางเกิน `maxInventoryQuote` ($100) อย่างเด็ดขาด และตัดปัญหา Churn Loop ให้หมดไป 100%
   - **Automated Order Cancellation, Balance Refresh, Cross-Symbol Orphan Order Sweep, and Dynamic Symbol Persistence on Chart Switch**:
       - **สาเหตุของปัญหา**:
         1. **ไม่ได้ยกเลิกออเดอร์เดิมก่อนสลับกราฟ**: เมื่อผู้ใช้เปลี่ยนคู่เทรดจากหน้าแรกผ่าน Dropdown (`topSymbolSelect`) ระบบเดิมเพียงแค่เปลี่ยน `symbolInfo` และโหลดแท่งเทียนใหม่ โดยไม่ได้สั่ง `cancelAllRestingOrders()` หรือยกเลิกออเดอร์คู่เดิมบน Exchange ทำให้ออเดอร์ซื้อขายของคู่เหรียญเดิม (เช่น `ETHFDUSD`) ยังคงค้างอยู่บนกระดาน Binance
         2. **เงินสดถูกล็อกข้ามคู่เหรียญ ทำให้ตั้งออเดอร์คู่ใหม่ไม่ตรงงบ**: ออเดอร์ซื้อของคู่เหรียญเดิมที่ค้างอยู่ได้ล็อกเงินทุน `FDUSD`/`USDT` ในกระเป๋าไว้ (เช่น ~$99.76 ถูกล็อก) ส่งผลให้เมื่อบอทเริ่มรันคู่เหรียญใหม่ (เช่น `BNBFDUSD`) เงินสดคงเหลือจริง (`quoteFree`) ไม่เพียงพอสำหรับการตั้งโควตาเต็มของ Buy Level 1-5 ทำให้วางออเดอร์ได้เพียงบางระดับ หรือวางได้ด้วยเศษเงินที่เหลือ (เช่น $20.09 ใน Level 4 และ $0 ใน Level 5) ไม่ตรงตามแผน
         3. **ไม่บันทึกคู่เหรียญลงใน Database Config**: ใน `src/index.ts` เมธอด `onUpdateSettings` เรียก `grid.updateRuntimeSettings(s)` ก่อนที่ `symbol` จะถูกอัปเดตเป็นคู่ใหม่ และใน `src/strategy.ts` เมธอด `getRuntimeConfig()` ยังคงคืนค่า `symbol: this.symbol` ซึ่งเป็นคู่เดิม ทำให้การบันทึก `this.db.setSettings(configToPersist)` เขียนทับคู่เหรียญเดิมลงใน `data/settings.db.json` เสมอ เมื่อรีสตาร์ทบอทจึงกลับไปใช้คู่เหรียญเดิมโดยไม่จำคู่ที่เพิ่งเลือก
       - **การแก้ไขและสถาปัตยกรรมใหม่**:
         1. **Automated Order Cancellation on Symbol/Exchange Switch (`prepareForSymbolSwitch`)**:
            - ใน `src/strategy.ts`: เพิ่มเมธอด `prepareForSymbolSwitch(nextSymbolLabel)` ซึ่งจะสั่งยกเลิกออเดอร์ที่ตั้งรออยู่ทั้งหมดของคู่เดิม (`cancelAllRestingOrders`), กวาดล้างออเดอร์บนกระดานของคู่นั้น (`cancelAllOpenOrders(this.symbol)`), กวาดออเดอร์ข้ามเหรียญที่ล็อกเงินสด (`sweepOrphanQuoteOrders()`), และเคลียร์ Memory `openOrders` ทันที
            - ใน `src/index.ts`: เมื่อตรวจพบ `symbolChanged` หรือ `exchangeChanged` จะเปิดแฟลก `grid.setSwitchingSymbol(true)` เพื่อหยุดการประมวลผล `tick()` ชั่วคราว และเรียก `await grid.prepareForSymbolSwitch(...)` ก่อนที่จะสลับ `symbolInfo` หรือเริ่มต้นฟีดใหม่
         2. **Cross-Symbol Orphan Order Sweep (`sweepOrphanQuoteOrders`)**:
            - ใน `src/exchange/types.ts` & `src/exchange/binance/client.ts`: ปรับปรุง `getOpenOrders(symbol?: string)` ให้สามารถดึงออเดอร์ที่เปิดอยู่ทั้งหมดข้ามทุกคู่เหรียญบน Binance เมื่อส่งค่า `""` หรือไม่ระบุ `symbol`
            - ใน `src/strategy.ts`: เพิ่ม `sweepOrphanQuoteOrders()` สแกนหาออเดอร์ซื้อฝั่ง BUY บนคู่เหรียญอื่นที่ลงท้ายด้วย Quote Asset เดียวกัน (เช่น `ETHFDUSD` หรือ `BTCFDUSD` ที่ล็อก `FDUSD`) และยกเลิกออเดอร์เหล่านั้นเพื่อคืนเงินสดกลับเข้ากระเป๋า
            - เมธอดนี้จะถูกเรียกอัตโนมัติใน:
              - `prepareForSymbolSwitch()` ก่อนสลับเหรียญ
              - `cancelAllOrdersUser()` เมื่อผู้ใช้กดปุ่ม Emergency Cancel All
              - `resetBotState()` เมื่อผู้ใช้กด Reset Bot
              - `syncOnChainOrders()` ทุกครั้งที่พบว่าเงินสดที่ถูกล็อก (`walletQuoteLocked`) มีค่ามากกว่ายอดออเดอร์ซื้อของคู่เหรียญปัจจุบัน (`activeBuyLockedQuote + 1.0`)
         3. **Immediate Wallet Balance Refresh & Ready State**:
            - หลังจากสลับเหรียญและฟีดเสร็จสิ้น ใน `src/index.ts` จะเรียก `await grid.refreshWalletBalances()` และ `await grid.syncOnChainOrders()` ทันที เพื่อให้ยอดเงินสดที่เพิ่งปลดล็อกอัปเดตเป็นปัจจุบัน 100% ก่อนที่บอทจะเริ่มคำนวณและวางคำสั่งซื้อของคู่เหรียญใหม่
         4. **Instant Dynamic Symbol Persistence (`data/settings.db.json`)**:
            - ใน `src/strategy.ts` เมธอด `updateRuntimeSettings()`: หากพบการส่งค่า `symbol` ใหม่ จะทำการอัปเดต `this.symbol`, `this.cfg.symbol`, และ `this.cfg.binanceSymbol` ให้เสร็จสิ้นทันทีก่อนที่ `getRuntimeConfig()` จะถูกดึงไปบันทึกผ่าน `this.db.setSettings(configToPersist)`
            - ใน `updateSymbolInfo()`: เรียก `this.db.setSetting("symbol", this.symbol)` เพื่อการันตีว่าค่าคู่เหรียญที่เป็น Canonical Symbol จะถูกบันทึกลงใน `data/settings.db.json` อย่างถาวรทุกครั้ง
            - ใน `src/index.ts`: คืนค่า `grid.getRuntimeConfig()` จาก `onUpdateSettings` เพื่อให้ผลลัพธ์ของ API ส่งคู่เหรียญใหม่ล่าสุดกลับไปยัง Frontend
         5. **Frontend Synchronization & Smooth Feedback (`public/app.js` & `public/index.html`)**:
            - ใน `public/app.js` ฟังก์ชัน `updateTick()`: ซิงค์ค่าของ Dropdown `#topSymbolSelect` ให้ตรงกับ `data.symbol` ของระบบอยู่เสมอ (หากไม่มีตัวเลือกเหรียญนั้น จะสร้าง `<option>` ให้อัตโนมัติ)
            - ใน Event Listener ของ `#topSymbolSelect`: ขณะกำลังสลับเหรียญจะทำการ Disable Dropdown ชั่วคราวและแสดง Toast แจ้งเตือนสถานะชัดเจน (`⏳ กำลังยกเลิกออเดอร์คู่เดิม บันทึก Config และสลับกราฟเป็น ...`) เมื่อสำเร็จจะแจ้งเตือนและเรียก `refreshFrontPageState()` เพื่ออัปเดตยอดเงินสดและหน้าต่างออเดอร์บนแดชบอร์ดทันที
            - อัปเดต Cache Buster เป็น `app.js?v=2.4` ใน `public/index.html`
   - **Dual Resistance Selling Architecture (`enableSellAtRealCeiling` & `min(TL, Real Ceil)` Overrides)**:
      - **สาเหตุและความต้องการ**:
        1. เมื่อบอทล็อกกรอบ (`lockChannelInPosition`) เพื่อป้องกันไม่ให้กรอบหลักขยับลงมาทับต้นทุน แต่โครงสร้างราคาจริง (Dow Theory / Donchian Highs) ได้ปรับตัวลงมาและสร้างแนวต้านจริง (`Real S/R Ceil`) ที่ต่ำกว่าเพดานเดิม (เช่น Locked Ceil อยู่ที่ $108.03 แต่ Real S/R Ceil ลดลงมาอยู่ที่ $105.38)
        2. หากเปิดใช้เพียงการขายใต้เส้นกด Trendline Resistance (`enableSellBelowTrendResistance`) บอทจะวางขายที่ $105.76 (ใต้ TL) ซึ่งสูงกว่าแนวต้านจริง $105.38 ทำให้พลาดโอกาสขายทำกำไรที่แนวต้านจริง
        3. ผู้ใช้ระบุหลักการอย่างชัดเจน: **"ไม่ใช่ locked คือ locked เพิ่ม option ให้ขายที่กรอบจริง เมื่อทำงานคู่กับการขายใต้ trendline ก็เลือกเอาราคาที่ต่ำกว่า"** (ห้ามแก้ Locked Channel เพราะ locked ต้อง locked แต่ให้เพิ่มออปชันขายที่กรอบจริง และเมื่อทำงานคู่กับ trendline ให้เลือกราคาที่ต่ำกว่าเสมอ min(tlPrice, liveRealCeil))
      - **การพัฒนาและสถาปัตยกรรมใหม่**:
        1. **Config & UI Switch (`enableSellAtRealCeiling`)**:
           - เพิ่ม `enableSellAtRealCeiling: true` (ค่าเริ่มต้น: `true`) ใน `src/config.ts`, `data/settings.db.json`
           - เพิ่ม Toggle Switch ในหน้าต่าง Settings Modal บนเว็บแดชบอร์ด (`public/index.html` และ `public/app.js`)
        2. **Dual Resistance Price Selection (`src/strategy.ts`)**:
           - ตรวจสอบทั้ง Trendline Resistance (`isTlActiveForTrigger`) และ Real Ceiling (`isRealCeilActiveForTrigger` เมื่อ `enableSellAtRealCeiling` เปิดใช้งาน, มี `liveRealCeil < upperBound`, และได้กำไรเหนือต้นทุนเฉลี่ย)
           - กำหนดราคาแนวต้านประสาน:
             $\text{effectiveResistancePrice} = \begin{cases}
               \min(\text{tlPrice}, \text{liveRealCeil}) & \text{ถ้าทั้งสองเงื่อนไขทำงาน} \\
               \text{tlPrice} & \text{ถ้ามีเฉพาะ Trendline} \\
               \text{liveRealCeil} & \text{ถ้ามีเฉพาะ Real Ceiling}
             \end{cases}$
        3. **Synchronized Resting Limit & IOC Exit**:
           - ใน `syncRestingOrders()`: เมื่อ `hasResistanceOverride` ทำงาน บอทจะส่ง Maker Limit Sell ไปดักรอที่ `effectiveResistancePrice` ทันที โดยติดป้าย `Sell Real Ceil Exit` หรือ `Sell TL Exit` ตามแหล่งที่มาของราคาที่ต่ำกว่า
           - ยกเลิก (Cancel) ออเดอร์ขายปกติทั้งหมดที่ตั้งราคาไว้สูงกว่าหรือเท่ากับ `effectiveResistancePrice` เพื่อไม่ให้ค้างขวางทาง
           - ใน Immediate Trigger & Block 2a (Resistance IOC Exit): เมื่อราคาตลาดวิ่งขึ้นมาแตะหรือทะลุ `effectiveResistancePrice` ระบบจะยิง Market/IOC Sell ออกไปทันที ปิดรอบทำกำไรได้รวดเร็วที่สุด
   - **Clean Minimalist Chart & Dynamic Open Order Price Lines Architecture**:
      - **สาเหตุและความต้องการ**:
        1. ป้ายกำกับบนชาร์ตเดิม (Locked Ceil, Real S/R Ceil, Locked Floor, Real S/R Floor) ใช้กล่องข้อความทึบยาว ยื่นเข้ามาในพื้นที่กราฟด้านซ้ายถึง 120-150px ทำให้บดบังเนื้อเทียนและไส้เทียนของแท่งเทียนที่กำลังก่อตัวอยู่
        2. ออเดอร์ซื้อขายจริงที่ตั้งรอจับคู่อยู่บน Exchange (Open Maker Orders) ไม่มีเส้นราคาแสดงบนชาร์ต ทำให้ผู้ใช้มองไม่เห็นว่ามีคำสั่งวางอยู่ที่ใด
        3. ในตาราง Grid Channel Meter ด้านขวา คำสั่งขายแบบ Real Ceil Exit ไม่ได้ถูกจับคู่กับแถวบันได ทำให้ดูเหมือนไม่มีคำสั่งขายวางอยู่
      - **การพัฒนาและสถาปัตยกรรมใหม่**:
        1. **Clean Unobstructed Chart Canvas (`public/app.js`)**:
           - นำกล่องข้อความทึบออกจากเส้นกรอบในชาร์ต (`title: ""`) โดยคงเส้นและแถบสีระบุราคาที่แกนขวาสุด (Axis) ไว้อย่างชัดเจน 100% ทำให้พื้นที่แท่งเทียนโล่ง สะอาดตา ไม่ถูกป้ายข้อความบดบัง
        2. **Dynamic Open Order Price Lines**:
           - เพิ่ม `openOrderPriceLines` วาดเส้นประแสดงระดับราคาออเดอร์จริงที่กำลังรอจับคู่อยู่บนกระดาน:
             - 🔴 เส้นประสีแดง (`#ef4444`) สำหรับ Limit Sell Orders
             - 🟢 เส้นประสีเขียว (`#22c55e`) สำหรับ Limit Buy Orders
           - ไม่ใส่กล่องข้อความทึบในพื้นที่กราฟ มีเพียงเส้นประบางๆ และแท็กสีระบุราคาที่แกนขวาสุด ทำให้มองเห็นตำแหน่งออเดอร์ชัดเจนโดยไม่บังแท่งเทียน
        3. **Enhanced Ladder Order Matching & Badging**:
           - ในตาราง Grid Channel Meter ด้านขวา เพิ่มการรองรับคำสั่งประเภท `Real Ceil Exit` ให้จับคู่กับระดับขายที่ใกล้เคียง พร้อมแสดงป้ายเคลื่อนไหว `🎯 SELL CEIL` และราคาชัดเจน
        4. **Unambiguous Action State Telemetry (`src/strategy.ts`)**:
           - ปรับปรุงข้อความสถานะด้านบนขวาให้ระบุชัดเจน เช่น `Resting Limit Sell placed @ $...` แทนคำว่า `Fills on upside rally...` เพื่อไม่ให้เกิดความสับสน
   - **Binance Cancelled Order Pruning & High-Performance Chart Refresh Architecture**:
      - **สาเหตุของปัญหา Refresh หน้าเว็บช้าบน Binance เมื่อเทียบกับ DreamDEX**:
        1. ทั้งสองระบบโหลดแท่งเทียน 300 แท่งเท่ากัน (~26 KB) แต่บน Binance มีประวัติออเดอร์ในฐานข้อมูลมากถึง 2,765 รายการ (1.66 MB) ซึ่ง 96.4% (2,665 รายการ) เป็นออเดอร์ Cancelled ที่ไม่มีค่าแก๊ส ต่างจาก DreamDEX ที่มีออเดอร์สะสมเพียง 157 รายการ (~150 KB)
        2. Endpoint `/api/state` เดิมส่งประวัติออเดอร์ทั้งหมด 5,000 รายการ ส่งผลให้ขนาด Payload ใหญ่ถึง 1.77 MB
        3. เมื่อบราวเซอร์ได้รับข้อมูล ฟังก์ชัน `connectSSE` วนลูปสร้าง HTML Elements กว่า 5,530 nodes, รัน `document.querySelector` 2,765 ครั้ง, และเรียก `rebuildOrderMarkers()` ซ้ำๆ นับร้อยรอบ ทำให้ Main Thread ของบราวเซอร์ค้างไป 2-4 วินาทีก่อนกราฟจะขึ้น
      - **การแก้ไขและสถาปัตยกรรมใหม่**:
        1. **Binance Zero-Gas Cancellation Pruning (`src/db.ts`)**:
           - บน Binance (CEX) การยกเลิกออเดอร์ไม่มีค่าแก๊สและไม่มีค่าธรรมเนียม: เมื่อเกิด Cancel จะถอดออเดอร์ Open ออกจาก `this.data.orders` โดยตรง และไม่บันทึกประวัติ Cancelled order ที่ไม่มีค่าแก๊สลงฐานข้อมูลอีกต่อไป
           - เพิ่ม `cleanupBinanceCancelledOrders()` กวาดล้างออเดอร์ Cancelled ตกค้างในอดีตออกจากฐานข้อมูลอัตโนมัติ ลดขนาด DB ลงกว่า 90% ทันที
        2. **Optimized Initial State Payload (`src/server.ts`)**:
           - ใน `/api/state` ส่งเฉพาะออเดอร์ล่าสุด 150 รายการ (`this.recentOrders.slice(0, 150)`) ลดขนาด Payload จาก 1.77 MB เหลือเพียง ~80 KB (โหลดผ่านเน็ตได้ใน 10ms)
        3. **Asynchronous Batched Marker Rebuild (`public/app.js`)**:
           - ใน `addOrderActivity` ปิดการเรียก `rebuildOrderMarkers()` และปิดการรัน `document.querySelector` ขณะทำการโหลดชุดเริ่มต้น (`isLiveUpdate === false`)
           - รัน `rebuildOrderMarkers()` เพียงครั้งเดียวตอนท้ายเมื่อประมวลผลข้อมูลชุดเริ่มต้นเสร็จสมบูรณ์ ทำให้หน้าเว็บและกราฟแสดงผลเร็วขึ้นทันทีในระดับ Milliseconds เท่ากับ DreamDEX
   - **Dual-Speed Cut Loss & Buffer-Only Option Architecture (`cutLossOnBufferOnly` & `cutLossBufferDelaySeconds`)**:
      - **สาเหตุและความต้องการ**:
        1. หากใช้เงื่อนไขปิดแท่งเทียน 15 นาทีเพียงอย่างเดียว เมื่อเกิดเหตุการณ์ทุบราคารุนแรง (Flash Dump) ที่ราคาดิ่งหลุดทะลุแนวรับบัฟเฟอร์อย่างรวดเร็ว การรอแท่ง 15 นาทีปิดแท่งอาจทำให้พอร์ตเสียหายหนักจากการถูกลากลงเหวลึก
        2. ในสภาวะตลาดที่มีความผันผวนย่อย (Consolidation/Whipsaw) ราคาอาจย่อลงไปใต้กรอบล่าง (Floor) ชั่วคราว แต่ยังอยู่สูงกว่าเส้น Safety Buffer การคัทลอสทันทีเมื่อแท่งเทียนปิดใต้กรอบล่างอาจทำให้โดนตัดขาดทุนที่จุดต่ำสุดก่อนราคาดีดกลับ
        3. ผู้ใช้กำหนดความต้องการชัดเจน:
           - **"แก้เรื่อง cutloss เฉพาะหลุด buffer เท่านั้น"** (ไม่คัทเมื่อหลุดแค่ Floor แต่ให้หยุดรับมีด และคัทเฉพาะเมื่อหลุดเส้น Buffer เท่านั้น)
           - **"ทำให้เปิดปิดเป็น options ได้ไหม"** (มีตัวเลือกเปิด/ปิดใน Settings และปรับระยะเวลาหน่วงก่อนคัทได้)
      - **การพัฒนาและสถาปัตยกรรมใหม่ (`src/strategy.ts`, `src/config.ts`, `public/index.html`, `public/app.js`)**:
        1. **Configurable Options & Settings Modal**:
           - `cutLossOnBufferOnly` (boolean, ค่าเริ่มต้น: `true`):
             - เมื่อเปิดใช้งาน (`true`): หากราคาหลุดกรอบล่าง (`refPrice < lowerBound`) ระบบจะสั่งหยุดตั้งซื้อทันที (`waitingForHigherLow = true`) เพื่อป้องกันการรับมีด แต่จะ **ไม่สั่ง Cut Loss**
             - การสั่ง **Cut Loss จะเกิดขึ้นเฉพาะเมื่อราคาหลุดเส้นบัฟเฟอร์ฉุกเฉิน (`cutLossBound = lowerBound - bufferAmount`) เท่านั้น**
             - หากปิดใช้งาน (`false`): จะกลับไปใช้ตรรกะเดิมที่คัทเมื่อแท่งเทียนปิดสมบูรณ์ใต้ Floor ครบตาม `cutLossConfirmCandles` (1 แท่ง)
           - `cutLossBufferDelaySeconds` (number, ค่าเริ่มต้น: `60` วินาที):
             - กำหนดเวลาแช่ใต้เส้นบัฟเฟอร์ก่อนสั่งคัทฉุกเฉิน หากตั้งค่าเป็น `0` วินาที ระบบจะคัททันทีที่ราคาหลุดเส้นบัฟเฟอร์ (Zero-delay)
             - มีการตรวจสอบว่าหากมีแท่งเทียนปิดสมบูรณ์ใต้เส้นบัฟเฟอร์ (`latestClosedCandle.close < cutLossBound`) ระบบจะสั่งคัททันทีโดยไม่ต้องรอหมดเวลา
        2. **Floor Breakdown Protection (Pause Buys Only)**:
           - เมื่อราคาหลุดต่ำกว่ากรอบล่าง (`refPrice < lowerBound`): บอทจะหยุดตั้งซื้อทันที (`waitingForHigherLow = true`) และยกเลิก Open Buy Orders ทั้งหมด
        3. **Emergency Fast Cut Loss (> Buffer Delay Seconds Below Buffer Line)**:
           - ติดตามราคาเทียบกับเส้นบัฟเฟอร์ฉุกเฉิน (`cutLossBound`):
           - หากราคาหลุดต่ำกว่าเส้นบัฟเฟอร์ (`refPrice < cutLossBound`): เริ่มนับเวลาถอยหลังตาม `cutLossBufferDelaySeconds` (`this.bufferBreakStartTime`) พร้อมแสดงสถานะ Countdown บนแดชบอร์ด
           - หากราคาแช่อยู่ใต้เส้นบัฟเฟอร์ต่อเนื่องเกินเวลาที่กำหนด (`bufferBreakElapsedMs >= bufferDelayMs` หรือ `bufferDelayMs <= 0` หรือมีแท่งเทียนปิดใต้บัฟเฟอร์): ระบบจะสั่ง **Emergency Fast Cut Loss ทันที**
           - หากราคาดีดกลับขึ้นมาเหนือเส้นบัฟเฟอร์ก่อนครบเวลา: ตัวจับเวลาจะถูกรีเซ็ตเป็น `undefined` โดยไม่คัท
   - **Comprehensive IOC Order Execution Telemetry & Trade Logging**:
      - **ความต้องการ**: ผู้ใช้ต้องการทราบอย่างชัดเจนใน Trade Matches / Trade Log ว่าเมื่อบอทส่งคำสั่งแบบ IOC: (1) ส่งที่ราคาอ้างอิง/เป้าหมาย (Target/Anchor) เท่าไหร่, (2) ตั้งค่า Slippage Protection ไว้กี่ %, (3) ส่งราคา Limit Price เข้า Exchange จริงเท่าไหร่, และ (4) ท้ายสุดได้ราคา Match จริง (Executed Fill Price) เท่าไหร่
      - **การแก้ไข**:
        1. **Database Schema & Event Mapping (`src/db.ts`)**: เพิ่มฟิลด์ `isIoc?: boolean`, `targetPrice?: number`, `slippagePct?: number`, `limitPrice?: number` ลงใน `UnifiedOrderRecord` และแมปค่าลงในฟังก์ชัน `recordEvent` ทั้งสำหรับออเดอร์ใหม่, ออเดอร์ที่ Match, และประวัติการเทรด
        2. **Core Strategy IOC Flow (`src/strategy.ts`)**:
           - ใน `buyTrancheIOC`: คำนวณ `targetPrice` (Buy Level), `slippagePct` (`iocSlippagePct`), `limitPrice` (ส่งไป exchange), และคำนวณ `fillPrice` จาก `res.cummulativeQuoteQty / res.executedQty` หรือ `res.price` ส่งต่อไปยัง `processBuyFill` ทั้งในโหมด Dry Run และ Live
           - ใน `processBuyFill`: รับ `targetPrice`, `slippagePct`, `limitPrice` และบันทึกลง Log: `⚡ IOC BUY FILLED: ... [Target: $... | Slip: ...% | Limit: $...]` พร้อมกระจายลงใน Order Event
           - ใน `sellTrancheIOC`: ส่งและบันทึก Log ชัดเจน: `⚡ ON-CHAIN IOC Sell: ... | Target: $... | Slip: ...% | Limit: $... • Trade PnL: ...` และกระจาย Event `SELL_FILL` พร้อมฟิลด์ IOC Telemetry ครบถ้วน
           - ใน `sellAll`: กำหนด `targetPrice = (anchorRefPrice && anchorRefPrice > 0) ? anchorRefPrice : price` เพื่ออ้างอิงเส้น Trendline หรือ Trigger Price จริง, คำนวณ `slippagePct`, `limitPrice`, และ `actualPrice` ที่ Match จริง พร้อมบันทึก Log และกระจาย Event `CUT` หรือ `TAKE_PROFIT`
        3. **Activity Feed & Trade Manager UI (`public/app.js`)**:
           - ใน `createActivityElement`: เพิ่ม Badge แสดงสถานะและ Telemetry ชัดเจน: `🎯 Target: $... | Slip: ...% (Sent: $...) ➔ Fill: $...` พร้อม Tooltip ข้อมูลเชิงลึกเมื่อนำเมาส์ไปชี้ และปรับ Badge Action ให้ชัดเจนเป็น `IOC BUY`, `IOC SELL`, `IOC CUT`, `IOC TP`
           - ในตาราง Trade Manager Modal (`renderTmTrades`): แสดง Sub-text ใต้ช่องราคา: `🎯 T: $... (Slip ...%)` หรือ `⚡ IOC` และแก้ไขการแสดงชื่อเหรียญให้เป็น Dynamic Base Asset (`o.baseAsset`) แทนการฮาร์ดโค้ด
   - **5-Level Dynamic Grid & In-Channel Safe Buffer Removal Architecture**:
      - **ความต้องการของผู้ใช้**:
        1. ตัด Safe Buffer (0-5%) ในกรอบออกไปเลยอย่างถาวร
        2. ปรับ Target ระดับการซื้อ-ขายใหม่เป็น **5 Levels** (Buy 5 Levels & Sell 5 Targets):
           - ฝั่งซื้อ 5 ระดับ: `42%, 32%, 22%, 12%, 2%` (เรียงจากบนลงล่าง: Level 1 อยู่บนสุดที่ 42%, Level 5 ติด Floor ที่ 2%)
           - ฝั่งขาย 5 ระดับ: `52%, 62%, 72%, 82%, 92%` (เรียงจากล่างขึ้นบน: Target 1 อยู่ล่างสุดที่ 52%, Target 5 ติด Ceiling ที่ 92%)
        3. ทั้ง 5 Levels ฝั่งซื้อและขายต้องสามารถ **เปิด-ปิด (toggle checkbox)** ได้อย่างอิสระ และสามารถ **ปรับแก้ค่า `%` ใหม่ได้** จากหน้าต่าง Settings Modal
      - **การพัฒนาและสถาปัตยกรรมใหม่**:
        1. **Configuration & Data Layer (`src/config.ts`, `data/settings.db.json`)**:
           - เพิ่ม `buyLevelPcts: number[]` (ค่าเริ่มต้น: `[42, 32, 22, 12, 2]`) และ `sellLevelPcts: number[]` (ค่าเริ่มต้น: `[52, 62, 72, 82, 92]`)
           - ขยาย `enabledBuyLevels: boolean[]` และ `enabledSellTargets: boolean[]` เป็น 5 ช่อง (ค่าเริ่มต้น: `[true, true, true, true, true]`)
           - เพิ่ม Auto-migration ใน `loadConfigFromDatabase()`: หากฐานข้อมูลเดิมเก็บอาร์เรย์ 4 ช่อง จะขยายเป็น 5 ช่องและเติมค่าเริ่มต้นให้อัตโนมัติ ป้องกัน Index Out of Bounds
        2. **Market Structure Calculations (`src/market-structure.ts`)**:
           - รับ `buyLevelPcts` และ `sellLevelPcts` ใน `ChannelOptions`
           - คำนวณ `buyLevels` และ `sellLevels` ใน `getStructure()` จากค่า % ไดนามิกที่ผู้ใช้กำหนดแทนการฮาร์ดโค้ด
        3. **Core Strategy Execution State Machine (`src/strategy.ts`)**:
           - ใน `syncRestingOrders()`:
             - สร้าง `levelNames` ฝั่งซื้อและ `sellNames` ฝั่งขายตามจำนวนและ % ที่ตั้งไว้
             - ตัด Safe Buffer Legacy Hysteresis (`positionPct < 5`) ออกทั้งหมด
             - ใช้ `buyLevelPcts[0]` (เช่น 42%) เป็นจุด Hysteresis ของการพัก/เปิดคำสั่งขายรอบล่าง
           - ใน `executeIocBracketGrid()`:
             - รองรับ 5 ระดับซื้อและ 5 ระดับขายอย่างสมบูรณ์ คำนวณ `activeBuyCount` และ `baseTrancheQuote = maxInv / activeBuyCount`
             - ขยาย `activeSellIndices` เป็น 5 ระดับไดนามิก `[0, 1, 2, 3, 4]` พร้อมคำนวณ `targetRemainingFraction` ตามสัดส่วนของแต่ละระดับ
           - ใน Dynamic Holding Fraction Telemetry:
             - ปรับ `buyLevelBands` (5 bands) และ `sellTargetBands` (5 bands) ให้เกาะค่า `buyLevelPcts` และ `sellLevelPcts`
        4. **UI Dashboard & Settings Modal (`public/index.html`, `public/app.js`)**:
            - **Zone Ladder Meter**:
              - ถอด `0-5% Safe Buffer` ออก และเพิ่ม `Buy Level 5 (2%)` กับ `Sell Target 5 (92%)`
              - อัปเดตป้าย % และคำนวณราคาของทั้ง 10 ขั้นบันได (5 ซื้อ + 5 ขาย + Center + Floor + Ceiling) แบบไดนามิกตามค่าใน DB
            - **Settings Modal**:
              - ฝั่งซื้อ: แสดง 5 แถว แต่ละแถวมี Checkbox เปิด/ปิด และช่อง Input ตัวเลข `%` (`#cfg_buy_pct_1..5`)
              - ฝั่งขาย: แสดง 5 แถว แต่ละแถวมี Checkbox เปิด/ปิด และช่อง Input ตัวเลข `%` (`#cfg_sell_pct_1..5`)
              - ฟังก์ชัน `loadSettings()` และ `saveSettings()` โหลดและบันทึกค่า % และสถานะ Checkbox ทั้ง 5 ระดับเข้าฐานข้อมูล
            - **Lightweight Charts Rendering**:
              - วาดเส้นระดับราคากริดย่อย 5 เส้นซื้อ (สีฟ้า) และ 5 เส้นขาย (สีส้ม) ตาม % ไดนามิก และหรี่สีเป็นสีเทาหากระดับนั้นถูกปิดใช้งาน
   - **Gas Compensation Decoupling, Persistence & Historical Reconcile Architecture**:
      - **การแยกความแตกต่าง CEX (Binance) vs DEX (DreamDEX) เรื่องแก๊สอย่างเด็ดขาด**:
        1. **Capability Flags บน Adapter Layer (`IExchangeClient`)**:
           - **Binance (`BinanceClient`)**: `isDex = false`, `hasGasFees = false`, `nativeGasAsset = undefined` ตัดระบบแก๊ส On-chain ออกทั้งหมด ไม่มีการติดตามแก๊ส ไม่มีการหัก/คืนแก๊ส คิดเฉพาะ CEX Trading Fee (0.075% BNB / 0% Maker FDUSD) ตามปกติ
           - **DreamDEX (`DreamDexClient`)**: `isDex = true`, `hasGasFees = true`, `nativeGasAsset = "SOMI"`, มี Callback `onGasSpent` ดักฟังค่าแก๊สจาก EVM Receipt จริงทุกคำสั่ง
        2. **Core Strategy Decoupling (`src/strategy.ts`)**:
           - ตรวจสอบ `isDex` และ `isSomiBase = isDex && this.baseAsset.toUpperCase() === "SOMI"`
           - เมื่อเทรดบน Binance Spot (CEX): ระบบจะปิดระบบแก๊สและการคืนแก๊ส 100% (`compBase = 0`, `gasLossQuote = 0`)
           - เมื่อเทรดบน DreamDEX (DEX) คู่ `SOMI:USDso`: เนื่องจากค่าแก๊สถูกจ่ายออกไปด้วยเหรียญ Native SOMI จากกระเป๋า เมื่อเกิด Buy Fill ระบบจะคำนวณ `uncompensatedGas` และหักเหรียญ SOMI จาก Lot ที่เพิ่งซื้อได้ (สูงสุดไม่เกิน 50%) คืนกลับเข้ากระเป๋า Wallet Gas Reserve ทันที พร้อมแสดงป้าย `🛡️ +X SOMI Gas Ret`
      - **สาเหตุที่การคืนแก๊สเคยหายไปหลังรีเฟรชหน้าเว็บ**:
        - ใน `src/db.ts` เดิมฟังก์ชัน `recordEvent()` ไม่ได้นำฟิลด์ `gasCompBase`, `gasCompSomi`, `gasLossQuote`, `gasLossUsdso`, `netQty` ไปบันทึกลงใน `UnifiedOrderRecord` ของฐานข้อมูล JSON
        - เมื่อออเดอร์ Match สดๆ ป้ายจะแสดงผลผ่าน SSE ได้ แต่เมื่อผู้ใช้กด Refresh หน้าเว็บ (F5) ข้อมูลถูกโหลดใหม่จากฐานข้อมูล ฟิลด์ `gasCompSomi` จึงกลายเป็น `undefined` ทำให้ป้ายคืนแก๊สหายวับไป
      - **การแก้ไขและระบบ Reconcile ย้อนหลังอัตโนมัติ (`reconcileHistoricalIocAndGasOrders`)**:
        1. **ถาวรการบันทึกใน DB (`src/db.ts`)**: เพิ่มการบันทึก `gasCompBase`, `gasCompSomi`, `gasLossQuote`, `gasLossUsdso`, `netQty` ลงในทุกสถานะคำสั่ง (`existingFilled`, `existing`, `record`) อย่างถาวร
        2. **Retrospective Reconcile Engine (`src/db.ts`)**: ทำงานอัตโนมัติทุกครั้งที่บอทเริ่มทำงาน:
           - **กู้คืน Gas Compensation ย้อนหลัง**: สแกนออเดอร์ซื้อในอดีตที่มีข้อความ `(Comp: X.XXXX SOMI)` หรือ `Gas Comp:` ดึงตัวเลขแก๊สคืนกลับมาบันทึกลงฟิลด์ `gasCompSomi`, `gasCompBase`, `gasLossQuote`, `netQty` ทำให้ป้ายเขียว `🛡️ +... SOMI Gas Ret` ฟื้นคืนชีพกลับมาทุกไม้ในอดีต
           - **กู้คืน IOC Telemetry ย้อนหลัง**: สแกนออเดอร์ในอดีตทั้งหมดที่ส่งแบบ IOC (CUT, TAKE_PROFIT, หรือมีคีย์เวิร์ด IOC) ดึงราคา `targetPrice` จากข้อความ `(Target: $...)` หรือ trigger price, เติม `slippagePct` และคำนวณ `limitPrice` ที่ส่งไป Match จริงย้อนหลังให้ครบถ้วน 100%
        3. **Resilient State Sync (`src/strategy.ts`)**: ใน `loadState()` หากค่า `totalGasDeductedBase` ใน State เป็น 0 หรือหลุดหาย ระบบจะคำนวณผลรวม `gasCompSomi` จากประวัติออเดอร์ใน Database แล้วดึงยอดสะสมที่ชดเชยจริงกลับมาเป็นฐานให้โดยอัตโนมัติ
   - **Portfolio Total Equity Protection & Locked Balance Accounting**:
     - **สาเหตุของปัญหา**: ใน `strategy.ts` เดิมดึงเฉพาะยอด `baseFree` และ `quoteFree` จาก exchange แล้วคำนวณ `walletTotalValueQuote = (walletBaseBalance * price) + walletQuoteBalance` โดยตัดยอดที่ถูกล็อกอยู่ใน Open Orders ทิ้งทั้งหมด ทำให้เวลาที่บอทวาง Buy Order $50 × 2 ไม้ ($100 ถูกล็อกอยู่ใน Open Orders) ยอด Equity รวมบนแดชบอร์ดจะวูบลงเหลือแค่ $20.06 ทั้งที่มีทุนจริง $120+
     - **การแก้ไข**:
       1. ใน `strategy.ts` เพิ่มการจัดเก็บ `walletBaseLocked`, `walletQuoteLocked`, `walletBaseTotal`, `walletQuoteTotal` จาก `getAccountBalances` ใน `refreshWalletBalances()`
       2. เพิ่ม Helper `getTotalPortfolioValueQuote(refP)` ซึ่งรวมทั้งยอด Free และยอด Locked ใน Open Orders ทั้งฝั่ง Base และ Quote ทำให้มูลค่าพอร์ตสมบูรณ์และถูกต้อง 100%
   - **Dynamic `binanceSymbol` Synchronization & Cross-Exchange Trade Attribution**:
     - **สาเหตุของปัญหา**: ใน `updateSymbolInfo(info)` เดิมตกการอัปเดต `this.cfg.binanceSymbol` ส่งผลให้เมื่อสลับคู่เทรดเป็น `SOLFDUSD` ค่า `binanceSymbol` ยังคงค้างเป็น `ethfdusd` และใน `src/db.ts` ฟังก์ชัน `backfillMissingSellPnl` มีการเดาเหรียญที่ราคา 2,500 เป็น `WETH:USDSO` เสมอแม้ว่าจะเป็นคำสั่งบน Binance CEX (Order ID เป็นตัวเลขของ Binance)
     - **การแก้ไข**:
       1. ใน `src/strategy.ts`: เพิ่ม `this.cfg.binanceSymbol = info.symbol.toLowerCase().replace(/[\/\-_:]/g, "");` ใน `updateSymbolInfo`
       2. ใน `src/db.ts`: กำหนด `targetSymbol`, `targetBase`, `targetQuote` ให้รองรับ Quote ของ Binance CEX (`FDUSD` / `USDT`) และซ่อมแซม Order เดิมของ Binance ที่เคยถูกแท็กผิดเป็น `WETH:USDSO` ให้กลับมาเป็น `ETHFDUSD` อย่างถูกต้อง
   - **DreamDEX Strict Price & Quantity Tick Rounding (Elimination of `0xaf608abb` & `0x4f174b29` Reverts)**:
     - **สาเหตุของปัญหา `0xaf608abb` (InvalidPriceTick)**: บน DreamDEX สัญญา `SpotPool` มี require guard บังคับว่าราคาคำสั่งซื้อขายต้องหารลงตัวกับ `tickSize` พอดี (`price % tickSize == 0`) หากราคาที่ส่งไปมีทศนิยมเกินระดับขั้น (เช่น `0.20342` แต่ `tickSize` คือ `0.0001`) สัญญาจะ Revert ด้วย Custom Error `0xaf608abb` (`InvalidPriceTick(uint256 price, uint256 tickSize)`)
     - **สาเหตุของปัญหา `0x4f174b29` (InvalidQuantity)**: สัญญา `SpotPool` บน Somnia Mainnet สำหรับคู่ `SOMI:USDSO` กำหนด `lotSize_ = 0.01 SOMI` (1e16 wei) และ `minQuantity_ = 1.0 SOMI` (1e18 wei) เมื่อคำสั่งมีทศนิยมเกิน 2 ตำแหน่ง (เช่น 395.004 SOMI) จะละเมิดเงื่อนไข `quantity % lotSize == 0` ทำให้ Revert ด้วย `0x4f174b29`
     - **การแก้ไข**:
       1. ใน `DREAMDEX_MARKETS["SOMI:USDSO"]` กำหนด `stepSize: 0.01` และ `minQty: 1.0`
       2. ใน `DreamDexClient.getExchangeInfo` คำนวณ `qtyPrecision` และ `pricePrecision` แบบ Dynamic ตาม `stepSize` และ `tickSize`
       3. ใน `src/strategy.ts` ส่ง `this.qtyPrecision` เข้า `roundToStep` ในทุกการส่งคำสั่ง ทำให้ทศนิยมของจำนวนเหรียญลงตัวกับ Smart Contract เสมอ 100%
     - **การแก้ไข Price Tick**: ใน `src/exchange/dreamdex/client.ts` เมธอด `placeOrder` นำเข้าและใช้ `roundToTick(params.price, market.tickSize)` และ `roundToStep(params.qty, market.stepSize)` เสมอก่อนแปลงเป็น BigInt (`priceRaw`, `qtyRaw`) และใน `src/strategy.ts` มีการปัดเศษด้วย `roundToTick(price, this.tickSize)` ก่อนสร้างออเดอร์ ทำให้ส่งคำสั่งได้สำเร็จ 100%
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
   - **DreamDEX On-Chain IOC Execution Receipt & Decoupled Fill Confirmation**:
     - **สาเหตุของปัญหาเดิม**: เมธอด `placeOrder` ของ `DreamDexClient` เคยคืนค่าเริ่มต้นเป็น `status: "NEW"` และ `executedQty: 0` เสมอ ทำให้ฟังก์ชัน `sellAll`, `sellTrancheIOC`, `buyTrancheIOC` ใน `strategy.ts` ซึ่งเดิมถูกออกแบบมาอิงพฤติกรรมของ Binance เข้าใจผิดว่าคำสั่ง IOC บน DreamDEX ไม่ Match (`UNFILLED`) และข้ามการเรียก `closeLots()` ทำให้ Lots ไม่ถูกเคลียร์ จนเกิดการส่ง Cut Loss ซ้ำรอบสอง และคำสั่งรอบสอง Revert ด้วย Error `0xc04ad919` เพราะเหรียญในกระเป๋าถูกขายออกไปหมดแล้วในรอบแรก
     - **การแก้ไข**:
       1. ใน `src/exchange/dreamdex/client.ts`: สำหรับคำสั่งแบบ IOC ทำการรอ `waitForTransactionReceipt` ยืนยันจากเชน Somnia และคืนค่า `status: "FILLED"`, `executedQty: qty` ที่แท้จริง
       2. ใน `src/strategy.ts`: ตรวจสอบสถานะการ Match ให้เป็นอิสระต่อทั้ง CEX (Binance) และ On-Chain EVM (DreamDEX) โดยหากได้รับ `res.status === "FILLED"` หรือยืนยัน On-Chain txHash จะทำการ `closeLots()` และตัดจำหน่าย Lots ออกจาก Position ทันที
   - **DreamDEX Direct Best Bid Order Matching & IOC Sell Slippage Buffer (Elimination of Cross-Exchange Price Leakage & 0xc04ad919 Reverts)**:
      - **สาเหตุของปัญหา**:
        1. ใน `sellAllUser()` บอทเคยไปดึงราคา `execPrice` จาก `this.wsBookTicker.bestBid` ซึ่งเป็น WebSocket ของ Binance (SOMIUSDT) ที่มีสภาพคล่องสูงกว่าและราคาดีดขึ้นไปที่ $0.207900 ขณะที่บน DreamDEX มี Best Bid อยู่ที่ $0.207500
        2. ใน `sellAll()` มีการตั้ง `limitPrice = price` (0% discount) เมื่อคำสั่งขายราคา $0.207900 ถูกส่งไปยังสัญญา `SpotPool` บน DreamDEX สัญญาไม่พบคนตั้งรับซื้อที่ $0.207900 จึง Revert ทันทีด้วย Error `0xc04ad919` (Unmatched IOC Order)
        3. นอกจากนี้ หากขายไม้ใหญ่ (~486 SOMI) ด้วย 0% discount หาก Best Bid แรกมีสภาพคล่องไม่พอรับ (เช่น มีแค่ 200 SOMI) สัญญา DreamDEX จะ Revert ทันที
      - **การแก้ไข**:
        1. ใน `sellAllUser()`: เมื่อรันบน DreamDEX ให้ดึงราคา Best Bid จาก Orderbook ของ DreamDEX (`getTopOfBook`) โดยตรงเสมอ ห้ามนำราคา Bid ของ Binance มาใช้ตั้งขาย
        2. ใน `sellAll()`: หากรันบน DreamDEX ให้ดึงและ Clamp ราคากับ Best Bid ปัจจุบันของ DreamDEX และอนุญาต Slippage เล็กน้อย (0.35%) ลงมาได้ถึง `Math.max(avgEntry * 1.0005, price * (1 - slippagePct))` เพื่อให้คำสั่ง IOC กวาดสภาพคล่องข้ามช่องได้เต็มจำนวนโดยยังคงรับประกันกำไรเหนือทุนเฉลี่ย 100%
    - **Fast-Path IOC Order Execution (Skip Redundant Resting Order Cancels)**:
      - ในโหมด IOC (`IOC_BRACKET`) บอทไม่มีออเดอร์ค้างอยู่บนกระดาน (`openOrders.length === 0`) อยู่แล้ว
      - ใน `sellAllUser()` และ `Block 2a (Trendline Exit)`: ตรวจสอบ `if (this.openOrders.length > 0)` ก่อนเรียก Cancel เท่านั้น หากไม่มีออเดอร์ค้างอยู่ ให้ข้ามขั้นตอน Cancel ทันที 100% ยิงขายออกไปใน 0.1 วินาที ไม่ต้องรอ Delay 600ms - 1s
    - **Universal Grid Level Slippage Tolerance & Single Floor/Ceiling Caps (Buy Levels 1..4 & Sell Targets 1..4)**:
      - **เป้าหมาย**: นำเกณฑ์ Slippage Cap เดียวกันที่ผูกตรงกับราคาเป้าหมาย (Level Price) ไปใช้กับบันได Grid ทุกระดับ ทั้งฝั่งซื้อและฝั่งขาย
      - **ฝั่งขาย (Sell Target 1..4 & 100% Exit)**:
        - Trigger เมื่อ Best Bid ขึ้นมาในระยะ `lvlPrice * (1 - iocSlippagePct)`
        - ใน `sellTrancheIOC()`: บังคับ Single Floor Cap `limitPrice >= targetPrice * (1 - iocSlippagePct)` และ `>= avgEntry * 1.0005` ไม่ขายต่ำกว่าเป้าเกินค่า Slippage ที่ตั้งไว้ และรับประกันขายมีกำไร
      - **ฝั่งซื้อ (Buy Level 1..4 & Trendline Support)**:
        - Trigger เมื่อ Best Ask ลงมาในระยะ `lvlPrice * (1 + iocSlippagePct)`
        - ใน `buyTrancheIOC()`: บังคับ Single Ceiling Cap `limitPrice <= targetPrice * (1 + iocSlippagePct)` เพื่อให้กวาด Ask บน Orderbook สำเร็จ 100% ไม่ Revert `0xc04ad919` และไม่มีทางซื้อแพงกว่า Buy Level เกินค่า Slippage
    - **Trendline Dual Trigger & Single Floor Cap (Elimination of Double-Dip Discounts)**:
      - **สาเหตุ & ปัญหาเดิม**: การ Trigger เส้นกดเคยยอมให้ Best Bid ต่ำกว่าเส้นกดได้สูงสุด 0.35% จากนั้นพอส่งคำสั่งใน `sellAll()` ดันเอา Best Bid มาหัก Slippage อีก 0.24% ทำให้เกิดการ "ลดราคาเบิ้ล 2 ต่อ" รวมหลุดต่ำกว่าเส้นกดจริงไปถึง ~0.59%
      - **การแก้ไข**:
        1. ใน `Block 2a`: ปรับ `maxAllowedDiscountPct` ให้ผูกตรงกับ `iocSlippagePct` (ค่า Slippage ใน Execution Guard เช่น 0.2%) ไม่ยอมให้ Best Bid ห่างจากเส้นกดเกินกว่าค่า Slippage ที่ผู้ใช้กำหนด
        2. ส่ง `tlPrice` เป็น `anchorRefPrice` เข้า `sellAll(..., tlPrice)` โดยใน `sellAll()` คำนวณ Single Floor Cap: `limitPrice >= tlPrice * (1 - iocSlippagePct)` รับประกันว่าราคาขายต่ำสุดจะไม่มีทางหลุดห่างจากเส้นกดเกินกว่าค่า Slippage ที่ตั้งไว้ใน Execution Guard เด็ดขาด (ไม่เบิ้ล 2 ต่อ)
   - **Trendline IOC Sell Best Bid Matching & Unmatched Error `0xc04ad919` Handling**:
     - **สาเหตุของปัญหา**: เมื่อราคา Binance ทะลุเส้นกด Trendline บอทเคยส่ง IOC Sell ด้วยราคา `tlPrice` (คำนวณจาก CEX) ไปยัง DreamDEX SpotPool Smart Contract แต่ใน Orderbook ฝั่ง Bid บน DEX ราคาซื้อจริงอาจอยู่ต่ำกว่าเล็กน้อย (เช่น TL อยู่ที่ $0.2038 แต่ Best Bid บน DEX มีสภาพคล่องที่ $0.2032) ส่งผลให้สัญญา `placeOrder` แบบ IOC ไม่พบคำสั่งคู่ตรงข้ามและสั่ง Revert ทันทีด้วย Custom Error `0xc04ad919` (Unmatched IOC Order)
     - **การแก้ไข**:
       1. ใน `src/strategy.ts` (Block 2a): ตรวจสอบ `bestBid` บนกระดาน DEX ก่อนส่ง Trendline IOC Sell เสมอ หาก `bestBid` ต่างจากราคาเส้นกดไม่เกินเกณฑ์ความคลาดเคลื่อน (`cutLossMaxBidDiscountPct` เช่น ไม่เกิน 1.5%) และราคานั้นยังคงมีกำไรเหนือทุนเฉลี่ย (`bestBid >= avgEntry * 1.0005`) ระบบจะปรับราคาขายไปที่ `bestBid` โดยตรง เพื่อให้คำสั่ง IOC จับคู่และ Fill ทันที 100% ป้องกันการเกิด Revert
       2. ใน `src/strategy.ts`: หาก Best Bid บนกระดานต่ำกว่าทุนเฉลี่ย หรือห่างจากราคาเส้นกดมากเกินไป บอทจะเข้าสู่สถานะ Standby รอสภาพคล่อง ไม่ยิงขายขาดทุนและไม่ยิง Revert ให้เสียค่าแก๊ส
       3. ใน `src/exchange/dreamdex/client.ts`: ครอบ `try-catch` รอบ `writeContract` ดักจับ Error signature `0xc04ad919` โดยหากเป็นคำสั่ง IOC ที่ไม่ Match จะคืนค่า `status: "CANCELED"` และ `executedQty: 0` พร้อมแสดงข้อความเตือนชัดเจน ไม่ให้โยน Uncaught Revert Error รบกวนระบบ
   - **Trendline Breakout Invalidation & Continuous Grid Cycling**:
     - **สาเหตุ & ปัญหาเดิม**: เมื่อราคาเบรคทะลุเส้นกด (Downtrend Line) ขึ้นมาจนทำยอดใหม่เหนือเส้น (Confirmed Breakout >= 2 closed candles) ตัวแปร `downtrendLine` ยังคงถูกคำนวณและวาดค้างอยู่บนกราฟ ส่งผลให้ Buy Filter สั่งบล็อกการเข้าซื้อใน Buy Zone (`targetTranches = 0`) และ Block 2a พยายามส่งคำสั่ง IOC Sell 100% Exit ทุกครั้งที่ราคาขยับเหนือเส้นกด ทำให้บอทไม่ยอมเข้าซื้อและไม่วางขายตามขั้นบันได Grid
     - **การแก้ไข**:
       1. ใน `src/market-structure.ts` (`calculateTrendlines`): เมื่อราคาปิดยืนเหนือเส้นกดครบ 2 แท่ง (`brokenCandleCount >= 2`) ให้ทำการยกเลิกเส้นกดนี้ทันที (`downtrendLine = undefined`) และตั้งค่า `downtrendBreakoutConfirmed = true` เพื่อให้เส้นกดที่ถูกทำลายแล้วหายไปจากระบบ
       2. ใน `src/strategy.ts` (Block 2a): เพิ่ม Guard บังคับว่า Trendline IOC Sell จะทำงานเฉพาะเมื่อเส้นกดยังสมบูรณ์และยังไม่เบรค (`!downtrendLine.isBroken && !dow?.downtrendBreakoutConfirmed`) เท่านั้น เมื่อเบรคแล้วจะส่งมอบการซื้อขายให้เป็นหน้าที่ของ Grid Ladder ปกติ (Buy Level 1..4 และ Sell Target 1..4) วนรอบได้อย่างราบรื่น
   - **100% Full Take Profit Exit Slippage Buffer & Redundant Step 4/4 Elimination**:
     - **สาเหตุของปัญหาเดิม**:
       1. ใน `sellAll()` คำสั่ง IOC Sell สำหรับ Take Profit 100% ถูกส่งด้วยราคา Best Bid ตรงๆ เป๊ะๆ หากสภาพคล่อง Orderbook ฝั่ง Bid บน DEX ณ วินาทีนั้นมีไม่พอรองรับจำนวนเหรียญทั้งหมด สัญญาจะ Revert ทันทีด้วย Custom Error `0xc04ad919` (Unmatched IOC Order) ทำให้คำสั่งไม่ Match และเหรียญยังค้างอยู่
       2. ในบล็อก 100% Take Profit Exit หลังเรียก `await this.sellAll()` ขาดคำสั่ง `return;` ทำให้โค้ดไหลต่อลงไปยัง `executeIocBracketGrid` ซึ่งพอเห็นว่าราคายังอยู่เหนือ Sell Target 4 จึงยิงคำสั่ง `IOC Sell Step 4/4` ซ้ำซ้อนอีกไม้ ผู้ใช้จึงเห็นบอทแบ่งขายย่อยและเสียค่าแก๊สซ้ำ
     - **การแก้ไข**:
       1. ใน `sellAll()`: ปรับปรุงการคำนวณ `limitPrice` สำหรับโหมด IOC ให้ยอมรับ Slippage Buffer เล็กน้อย (0.3% - 0.5% หรือไม่เกิน `cutLossMaxBidDiscountPct`) เพื่อให้คำสั่ง IOC กวาด Orderbook และ Match เต็มจำนวน 100% ในไม้เดียว โดยมี Guard คุมเข้มว่า `limitPrice` ต้องไม่ต่ำกว่าทุนเฉลี่ยเด็ดขาด (`Math.max(avgEntry * 1.0005, discountedPrice)`) รับประกันขายมีกำไรแน่นอน
       2. ใน `src/strategy.ts`: ใส่ `return;` หลังจบ 100% Take Profit Exit และ Cut Loss ทันที เพื่อยุติการทำงานของ tick นั้น ไม่ให้หลุดไหลลงไปหา `executeIocBracketGrid`
       3. ใน `executeIocBracketGrid`: เพิ่ม Guard ตรวจสอบว่าหากราคาแตะหรืออยู่เหนือเพดานกรอบบน (`refPrice >= upperBound || currentBestBid >= upperBound`) ให้งดการแบ่งขายตามขั้นบันได (Step 1..4) ทันที เพื่อส่งมอบให้ 100% Full Exit ทำหน้าที่ปิดรอบไม้เดียวจบ
   - **Strict Structural Channel & Standby (ยกเลิก Narrow Grid • อิงเฉพาะยอด/เหวแท้จริง • ไม่สร้างจุดลอย)**:
     - **สาเหตุ & หลักการ**:
       - ยกเลิกโหมด Narrow Grid (`isNarrowChannel`) ทั้งหมด เนื่องจากขัดกับตรรกะกริด 4 ระดับมาตรฐาน และไม่ต้องการให้มีการสร้างจุดลอยหรือขอบจำลองขึ้นมาเอง
       - **หลักการตายตัวของผู้ใช้**: "การขยายกรอบ ให้อิงจากเหวหรือยอดเท่านั้น ไม่ใช่จุดลอยๆ ถ้าหาไม่ได้ ให้หยุด trade ไป"
       - ขอบล่าง (Floor) ต้องอิงจาก Swing Low (เหว) ที่ยืนยันแล้ว และ ขอบบน (Ceiling) ต้องอิงจาก Swing High (ยอด) ที่ยืนยันแล้วเท่านั้น ห้ามใช้สูตรสมมติหรือจุดลอยในอากาศเด็ดขาด
     - **การแก้ไข**:
       1. **ลบ Narrow Grid โดยสมบูรณ์**:
          - นำฟิลด์ `enableNarrowChannelCollapse`, `narrowChannelThresholdPct`, `narrowChannelBuyBufferPct`, `narrowChannelSellBufferPct` ออกจาก `ChannelOptions`, `src/config.ts`, `src/strategy.ts`, `public/index.html` และ `public/app.js`
          - บอทใช้กริด 4 ระดับมาตรฐานเสมอ (Buy L1 40%, L2 30%, L3 20%, L4 10%; Sell T1 60%, T2 70%, T3 80%, T4 90%)
       2. **Strict Structural Bounds Search (`findStructuralBoundsSatisfyingMinWidth`)**:
          - ใน `src/market-structure.ts`: ตรวจสอบคู่ยอด/เหวของรอบคลื่นปัจจุบัน (Recent Active Wave Swings) โดยตรง และไม่วิ่งไปควานหายอดเก่าในอดีตที่ห่างไกลมาถ่างกรอบ
          - นำ synthetic fallbacks (เช่น `price * (1 ± minPct / 2)`) ออกทั้งหมด
          - หากยอด/เหวของรอบคลื่นปัจจุบันมีระยะห่างแคบกว่า `minChannelWidthPct` ระบบจะคงตำแหน่งยอด/เหวจริงไว้ (ไม่ดีดไปยอดไกล) และส่งสัญญาณ `hasValidStructuralChannel = false` สั่ง Standby ทันที
       3. **Channel Structure Standby Guard**:
          - ใน `src/strategy.ts`: เมื่อ `hasValidStructuralChannel === false` บอทจะเข้าสู่สถานะ `channelStructureStandby = true`
          - ยกเลิกคำสั่งซื้อที่ค้างอยู่ทั้งหมดทันที และตั้ง `canBuy = false` เพื่อหยุดการเข้าซื้อชั่วคราว
          - แสดงสถานะในแดชบอร์ด: `CHANNEL_STRUCTURE_STANDBY` ("⚠️ Channel Structure Standby: No structural peak/valley pair meets minChannelWidthPct — Waiting for confirmed swing highs & lows")
          - เมื่อโครงสร้างตลาดเกิด Swing High/Low ใหม่ที่กว้างเพียงพอ ระบบจะ Clear Standby และกลับมาทำงานต่อโดยอัตโนมัติ
       4. **Clean UI**:
          - ลบสวิตช์และช่องตั้งค่า Narrow Channel ออกจากหน้าต่าง Settings Modal ใน Web Dashboard ทั้งหมด
   - จัดการ Time Synchronization กับ Server อัตโนมัติ (`syncTime()`)
   - ปรับความละเอียดตาม Symbol Filter เสมอ (`stepSize`, `tickSize`, `minQty`, `minNotional`)
    - **Emergency Sell All Button (ขายเหรียญทั้งหมดทันทีจากแดชบอร์ด)**:
      - เพิ่มปุ่ม 💥 Sell All บน Top Navigation Bar ของ Web Dashboard (public/index.html, public/style.css, public/app.js)
      - รองรับการขาย Position ทั้งหมด (sellAllUser()) ทันทีที่ราคาตลาด (IOC/Market Exit) โดยยกเลิกคำสั่ง Resting Orders ทั้งหมดก่อนส่งคำสั่งขาย
      - มี Confirmation Modal ป้องกันการเผลอกดผิดพลาด และเมื่อขายสำเร็จระบบจะสลับเป็นสถานะ Pause อัตโนมัติเพื่อไม่ให้บอทกระโดดเข้าซื้อรอบใหม่ทันที
      - รองรับทั้งโหมด DRY_RUN และ Live Trading ทั้งบน Binance Spot และ DreamDEX On-Chain พร้อม API Endpoint POST /api/bot/sell-all
     - **Dynamic Grid Level Enable/Disable & Proportional Weight Allocation (เปิด/ปิดระดับ Buy & Sell แยกอิสระพร้อมจัดสรรสัดส่วนแบบไดนามิก)**:
       - **ความต้องการ**: ผู้ใช้ต้องการให้สามารถเปิด/ปิดแต่ละระดับเป้าหมายซื้อ (`Buy Level 1..4`) และขาย (`Sell Target 1..4`) แยกกันได้อย่างอิสระ หากปิดระดับใด บอทจะไม่ Trigger หรือวางคำสั่งที่ระดับนั้นเด็ดขาด และการจัดสรรงบประมาณ (ฝั่งซื้อ) หรือจำนวนเหรียญที่ขาย (ฝั่งขาย) ให้หารตามจำนวนระดับที่เปิดใช้งานจริง (เช่น หากเปิด Buy Level 1 เพียงระดับเดียว จะเข้าซื้อ 100% เต็มพอร์ตที่ระดับนี้ หากเปิด 2 ระดับ จะแบ่งเป็น 50% / 50%)
       - **การแก้ไขในโค้ด**:
         1. ใน `src/config.ts`: เพิ่ม `enabledBuyLevels: boolean[]` (default `[true, true, true, true]`) และ `enabledSellTargets: boolean[]` (default `[true, true, true, true]`) พร้อมตัวแปลง array ใน `loadConfigFromDatabase()`
         2. ใน `src/strategy.ts`:
            - `getRuntimeConfig()` & `updateRuntimeSettings()`: รองรับการอ่านและบันทึกค่าลง `settings.db.json` โดยเมื่อมีการแก้ไขจะตั้งค่า `needsBuyRebalance = true`, `needsSellRebalance = true` และรีเซ็ต `iocBracketSellCycle = undefined` ทันที
            - Target Holding Rebalancing (`targetHoldingFraction`): คำนวณแบบ Dynamic ตามสัดส่วนจำนวนระดับที่เปิดใช้งานจริง (`activeBuyCount` และ `activeSellCount`)
            - `executeIocBracketGrid`: ฝั่งซื้อคำนวณ `baseTrancheQuote = maxInv / activeBuyCount` และข้ามระดับที่ถูกปิด, ฝั่งขายจับคู่เฉพาะ `activeSellIndices`
            - `placeBuyOrders` & `placeSellOrders` (Maker Limit mode): ตรวจสอบ `enabledBuys[i]` และ `enabledSells[i]` ข้ามการวางออเดอร์และยกเลิกคำสั่งเดิมที่ค้างอยู่ที่ระดับที่ถูกปิด
            - Next Triggers (`buyTrigger` / `sellTrigger`): กรองเฉพาะระดับที่เปิดใช้งานจริง
            - `telemetryData`: ส่ง `enabledBuyLevels` และ `enabledSellTargets` ไปยังหน้าบ้าน Dashboard
         3. ใน `public/index.html` & `public/style.css`:
            - เพิ่มส่วน UI `🎯 Dynamic Grid Target Levels` ใน Settings Modal (แท็บ Execution & Guard) แสดงการ์ด 2 คอลัมน์สีเขียว/ส้ม พร้อม Checkbox ควบคุม Buy L1..L4 และ Sell T1..T4 อย่างชัดเจน
            - เพิ่มสไตล์ `.ladder-step.step-disabled` สำหรับขีดฆ่าและ dim สเต็ปที่ปิดใช้งานบน Grid Ladder Meter
         4. ใน `public/app.js`:
            - `loadSettings()`: ดึงค่าจาก Database มาตั้งสถานะ Checkbox ทั้ง 8 ตัว
            - `saveSettings()`: อ่านค่า Checkbox ส่งบันทึกผ่าน API `/api/db/settings`
            - updateZoneLevelBars(): ซิงค์สถานะ Disabled กับ Grid Ladder Meter แบบ Real-time
             - `gridZoneLevelLines`: ซิงค์สีเส้นระดับบนชาร์ต TradingView โดยหาก Level ถูกปิด (Disabled) จะแสดงเป็นเส้นประสีเทาจางล้วน `rgba(148, 163, 184, 0.25)` โดยซ่อนป้ายราคาและข้อความ (`axisLabelVisible: false, title: ""`) ให้เห็นเฉพาะเส้นแนวนอนสีเทา
     - **DreamDEX On-Chain Gas Tracking & Buy Fill Gas Compensation (ระบบชดเชยค่าแก๊สอัตโนมัติป้องกันยอด SOMI ร่อยหรอ)**:
       - **ปัญหาเดิม**:
         - ใน `src/strategy.ts` เมธอด `trackTxGas` เดิมเป็น empty stub (`return;`) และตัวแปรสะสมแก๊ส `accumulatedGasBase` เคยอัปเดตเฉพาะในโหมด `dryRun` เท่านั้น ทำให้ใน Live Trading ค่าแก๊สที่จ่ายจริงไม่ถูกบันทึก
         - ส่งผลให้ `uncompensatedGas = 0` และ `compBase = 0` เสมอ เมื่อเข้าซื้อเหรียญ SOMI ยอดที่ซื้อมาทั้งหมดจะถูกนำไปสร้าง Lot 100% และเมื่อขายทำกำไรก็จะถูกขายออกไปจนหมด ทำให้ Native SOMI ในกระเป๋าที่ถูกหักเป็นค่าธรรมเนียมแก๊ส On-chain ค่อยๆ ลดลงเรื่อยๆ ตามจำนวนธุรกรรม
       - **การแก้ไขในระบบ**:
         1. **Exchange Layer (`src/exchange/types.ts` & `src/exchange/dreamdex/client.ts`)**:
            - เพิ่ม `gasFee?: number;` ลงใน `ExchangeOrderResult`
            - เพิ่มเมธอด `getTransactionFee(txHash: string): Promise<number | undefined>` ใน `IExchangeClient` และ `DreamDexClient` โดยอ่าน `gasUsed` และ `effectiveGasPrice` จาก `TransactionReceipt` บน Somnia Network แปลงเป็นหน่วย SOMI ผ่าน `formatUnits(feeWei, 18)`
            - ใน `placeOrder` (DreamDexClient) สำหรับคำสั่ง IOC: ดึงค่าแก๊สจาก receipt แนบกลับมาใน `gasFee` ทันทีที่คำสั่งส่งสำเร็จ
         2. **Strategy Gas Tracking (`src/strategy.ts`)**:
            - อิมพลีเมนต์ `trackTxGas(txHash, label)` อย่างสมบูรณ์: เรียก `getTransactionFee` จาก exchange, สะสมยอดแก๊สเข้า `this.accumulatedGasBase`, `this.totalGasSpentBase`, คำนวณมูลค่าเทียบเคียง `accumulatedGasQuote`, เพิ่ม `totalTxCount`, บันทึกลงใน DB ผ่าน `this.db.updateTxGas(...)` และส่ง Real-time Telemetry
            - ใน `buyTrancheIOC`: หาก `res.gasFee` มีค่า (> 0) จะนำมาสะสมเข้า `accumulatedGasBase` ทันทีล่วงหน้าก่อนเข้าสู่ `processBuyFill`
         3. **Buy Fill Gas Compensation (`src/strategy.ts` -> `processBuyFill`)**:
            - เมื่อเข้าซื้อเหรียญที่มี `baseAsset === "SOMI"`: ปรับยกเว้น Spot Commission (เพราะบน DEX หักในพูลแล้ว) และทำการคำนวณชดเชยค่าแก๊ส `compBase = Math.min(uncompensatedGas, qty * 0.5)`
            - หักค่าชดเชยออกจากขนาด Lot ที่จะนำไปตั้งขาย (`netQty = qty - compBase`) เพื่อให้คงเหลือ SOMI ในกระเป๋าสำหรับเป็นค่าแก๊สหมุนเวียน ไม่ถูกนำไปตั้งขายจนหมด
            - ตัดทอน `accumulatedGasBase` ลงตามจำนวนที่ชดเชย และบันทึก `totalGasDeductedBase`
            - แสดง Log ละเอียด: `⛽ Gas Compensated: X.XXXX SOMI (-$X.XXXX) returned to wallet gas reserve`
     - **Strict Structural S/R Multi-Touch & Fresh LL (Lower Low) Channel Floor Priority**:
       - **ปัญหาเดิม**:
         - ใน `findMultiTouchSR` (`market-structure.ts`): อัลกอริทึม Clustering ใช้ `lineTouchTol = 0.002` (0.20%) และการจับกลุ่มใช้ `tol = 0.35% - 1.0%` ทำให้สวิงเหวที่ลอยอยู่เหนือเส้นรับจริง (เช่น เหวที่ $2512 ขณะที่เส้นแนวรับอยู่ที่ $2509.56) ถูกดึงเข้ามาในกลุ่มเดียวกัน และได้รับป้าย `🎯 3x` ทั้งที่ไม่ได้สัมผัสเส้นจริง
         - การให้คะแนนคู่แนวรับ-ต้าน (Scoring): คลัสเตอร์เดิมที่มี Multi-touch (เช่น $2509.56) ได้รับคะแนนสะสมสูงมาก (`touchBonus +3000`, `currentBaseBonus +2000`, `anchorBonus +4000`) จนชนะจุดเหวต่ำสุดใหม่ **LL (Lower Low, เช่น $2503.28)** ของรอบคลื่นปัจจุบัน ส่งผลให้ `liveCalculatedBottomBound` (เส้นประ Real S/R Floor) ไม่ยอมขยับลงมาที่จุด LL แท้จริง
       - **การแก้ไขในระบบ**:
         1. **Strict Touch Verification (`src/market-structure.ts`)**:
            - ปรับ `lineTouchTol` ใน `clusterPoints` ให้เข้มขึ้นเหลือ `Math.min(tol, 0.001)` (0.10%) คัดกรองให้เฉพาะสวิงที่แตะถึงเส้นระดับราคาของแนวรับ/ต้านจริงเท่านั้นถึงจะนับเป็น `touchCount` ได้ จุดเหวที่ลอยอยู่จะไม่ถูกนับ
         2. **LL Structural Priority Bonus (`src/market-structure.ts`)**:
            - เพิ่ม `structuralLlBonus (+3000)` ให้กับผู้สมัครแนวรับที่เป็นจุดต่ำสุดจริงของรอบคลื่นปัจจุบัน (`recentCanonicalLows`) เพื่อให้จุดเหว LL ใหม่ของรอบไม่ถูกคลัสเตอร์เก่าในอดีตกดทับ ทำให้ `liveCalculatedBottomBound` (Real S/R Floor) ขยับลงมาสะท้อนจุดต่ำสุดแท้จริง
         3. **Strict Touch Badge Rendering (`public/app.js`)**:
            - ปรับปรุงตัวกรอง `supTouchPoints` และ `resTouchPoints` ให้แสดงป้าย `🎯 Nx` เฉพาะจุดที่ราคาแตะเส้น `bottomBound` / `upperBound` / `liveCalculatedBottomBound` / `liveCalculatedUpperBound` ภายในระยะ `<= 0.10%` เท่านั้น กำจัดบั๊กป้ายลอยอยู่กลางอากาศได้อย่างสมบูรณ์
     - **Active Wave Anchoring & Zero Floating/Synthesized S/R Bounds**:
       - **ปัญหาเดิม**:
         - `supCandidates` ใน `findMultiTouchSR` เคยดึง `this.swingLows` ทั้งหมดในประวัติศาสตร์ย้อนหลัง ทำให้เหวเก่าโบราณจากหลายวันก่อน (เช่น $2488.40) หลุดเข้ามาเป็น Support Candidate และถูกจับคู่เป็น Floor
         - เมื่อ Floor หลุดไปที่ $2488.40 บล็อก Clamping ใน `calculateChannelBounds` พยายามรักษาความกว้างกรอบ จึงคำนวณ `upperBound = bottomBound + maxSpanFromPct` ทำให้ Ceiling ลอยขึ้นไปที่ $2538.68 ซึ่งเป็นจุดที่เกิดจากการบวกเลขลอยๆ ไม่มีแท่งเทียนหรือยอดสวิงจริง
       - **การแก้ไขในระบบ**:
         1. **Strict Active Wave Swings Only (`src/market-structure.ts`)**:
            - ใน `findMultiTouchSR`: `supCandidates` ถูกจำกัดให้ดึงเฉพาะ `valleyPoints` (สวิงเหวที่เป็น canonical lows ในรอบคลื่นปัจจุบัน) ป้องกันเหวโบราณนอกรอบคลื่นไม่ให้หลุดเข้ามาเป็น Floor อีกต่อไป
         2. **Zero Synthesized Clamping / Strict Swing Snapping (`src/market-structure.ts`)**:
            - ใน `calculateChannelBounds`: ยกเลิกการคำนวณบวกเปอร์เซ็นต์ลอยๆ (`bottomBound + maxSpanFromPct`) หากกรอบกว้างเกินหรือต้องการปรับลดเพดาน/พื้น ระบบจะ Snap ล็อคเกาะกับยอดสวิง Peak จริง (`activePeak` / `recentCanonicalHighs` เช่น HH $2528.96 หรือ LH $2516.02) และเหวจริง (`activeValley` / `recentCanonicalLows` เช่น LL $2503.28) เท่านั้น 100%
          3. **Multi-Touch Base Valley Tolerance Harmonization (`src/market-structure.ts`):**
             - ปรับปรุงการคัดกรอง `cycleLowMin` ใน `findMultiTouchSR` (ทั้ง `valleyPoints` และ `supCandidates`) ให้ใช้เกณฑ์ความคลาดเคลื่อน `(1 - tol)` สอดคล้องกับ grouping tolerance แทนที่เกณฑ์เดิมที่แคบเกินไป (`0.999` หรือ 0.10%)
             - ป้องกันบั๊กที่เหวฐานล่างแท้จริงของรอบคลื่น (เช่น 0.2042 ที่มี 3 touches) โดนตัดทิ้งเพียงเพราะอยู่ต่ำกว่า Higher Low ล่าสุด (0.2045) เล็กน้อย ทำให้แนวรับ Multi-Touch สัมผัสพื้นฐานเหวที่ต่ำที่สุดได้อย่างสมบูรณ์แบบ ไม่ลอยขึ้นมาที่ 0.2044 อีกต่อไป
          4. **Pure Structural Wave Base Anchoring (`src/market-structure.ts`):**
             - ปรับตรรกะ `baseValley` ใน `getStructure` ให้ยึดจุดต่ำสุดจริงของรอบคลื่นปัจจุบัน (`Math.min(...activeCycleLows)` เช่น LL $0.2026 / $2501.75) เสมอ แทนการดึงยกตาม Higher Low (`confirmedHl`) ย่อย
             - ผ่อนปรน `effectiveTradeableMinSpan = minSpanPct * 0.95` เพื่อรองรับคู่สวิงธรรมชาติของคลื่นหลัก (เช่น กรอบ 2.96% จากยอด $0.2086 ถึงเหว $0.2026) ไม่ให้ถูกตีตกไปเข้าโหมด Clamped แคบ
           5. **Active Wave Dow Theory Ceiling & Floor Snapping (New HH & Recent LL Anchor) (`src/market-structure.ts`):**
              - **Ceiling Snapping to New HH**: เพิ่มตัวตรวจจับ `isLatestHighHh` (เมื่อ `lastCanonicalHigh` เป็น `HH` หรือราคาสูงกว่ายอดก่อนหน้า) โดยเมื่อทำ New HH สำเร็จ ระบบจะปรับ `activePeak` และ `recentMajorHigh` ไปที่ยอดใหม่ทันที ($0.2073) แทนที่จะค้างอยู่ที่ยอดเก่า $0.2086
              - **Multi-Touch S/R Bounds Localization**: ใน `findMultiTouchSR` ปรับ `candidateLowSwings`, `candidateHighSwings`, `cycleLowMin`, และ `cycleHighMax` ให้จำกัดอยู่ภายในสวิงของรอบคลื่นปัจจุบัน เพื่อให้การจัดกลุ่ม S/R สะท้อนคลื่นปัจจุบันอย่างแม่นยำตรงตาม Dow Theory
           6. **Elimination of Synthesized Floating Channels (`midEst2 * 1.01 / 0.99`) & Active Wave Base Anchoring (`src/market-structure.ts`)**:
              - **สาเหตุ & ปัญหาเดิม**:
                - ใน `market-structure.ts` เดิมมีตรรกะบังคับความกว้างกรอบขั้นต่ำ:
                  ```ts
                  if (upperBound <= bottomBound || (upperBound - bottomBound) / bottomBound < 0.005) {
                    const midEst2 = (upperBound + bottomBound) / 2 || price;
                    upperBound = midEst2 * 1.01;   // เช่น $2507.995 * 1.01 = $2533.074950
                    bottomBound = midEst2 * 0.99;  // เช่น $2507.995 * 0.99 = $2482.915050
                  }
                  ```
                - เมื่อใช้ `slice(-4)` สวิงขนาดเล็กถูกดึงเข้ามาคำนวณและมีช่วงสวิงแคบกว่า 0.5% ทำให้สูตรคณิตศาสตร์เสกกรอบลอยกลางอากาศขึ้นมาทันที ($2533.07 / $2482.91 ความกว้าง 2.02%) โดยไม่มีแท่งเทียนหรือสวิงจริง
              - **การแก้ไขในระบบ**:
                - กำจัดสูตรสังเคราะห์ `midEst2 * 1.01` และ `midEst2 * 0.99` ออกจากระบบ 100%
                - ปรับการหาขอบเขตคลื่นยึดตาม **Active Wave Base Index** (`waveCycle.lastLl.index` หรือ `macroLow.index`) ทำให้สวิงหลักทั้งหมดของรอบคลื่น (ตั้งแต่ Major LL $2501.75 ถึง Major HH $2524.59) อยู่ใน Pool คำนวณเสมอ
                - หากกรอบมีช่วงแคบ ให้ Snap เกาะกับสวิงจริงที่ใกล้ที่สุด (`candidateHighs` / `candidateLows`) เสมอ ป้องกันการเกิดกรอบลอยกลางอากาศอย่างเด็ดขาด
           7. **Manual "Sell All" Resting Orders Auto-Purge & Balance Unlock (`src/strategy.ts`)**:
              - **สาเหตุ & ปัญหาเดิม**: เมื่อผู้ใช้กดปุ่ม "Sell All" ผ่านแดชบอร์ด ในโหมด Binance Spot เหรียญส่วนใหญ่ถูกล็อคอยู่ในออเดอร์ตั้งขายเดิม (`locked` balance เช่น 0.0349 ETH) ทำให้ `walletBaseBalance` (free balance) เหลือเพียง `0.0001 ETH` ซึ่งต่ำกว่า `minQty` ส่งผลให้ระบบแจ้งเตือนข้อผิดพลาด: `❌ ไม่สามารถขายได้: Position quantity (0.0001 ETH) is below minimum order size (0.0001)`
              - **การแก้ไขในระบบ**:
                - ใน `sellAllUser()`: เพิ่มการเรียก `await this.cancelAllOrdersUser();` และ `await this.refreshWalletBalances();` ตั้งแต่เริ่มต้น เพื่อยกเลิกออเดอร์ตั้งขายที่ค้างอยู่บนกระดานทั้งหมดและปลดล็อคยอดเหรียญ Base กลับเข้า Free Balance ก่อนทำการคำนวณยอดที่จะขาย
                - เพิ่ม Fallback ให้ดึง `held = availableBase` หากยอดใน Position Memory ต่ำกว่า `minQty` แต่ใน Wallet มีเหรียญจริงพร้อมเทรด ทำให้การกด Sell All สำเร็จ 100% เสมอ

            8. **Complete Purge of Multi-Touch S/R & Progressive Nearest-Swing Channel Expansion (`DOW_SWINGS`)**:
               - **สาเหตุ & ปัญหาเดิม**:
                 - อัลกอริทึม Multi-Touch S/R (`findMultiTouchSR`) มักสร้างคลัสเตอร์สัมผัสซ้ำ (เช่น `🎯 6x` ที่ยอด $2515.22) แล้วล็อกเพดานไว้ที่นั่น ขณะเดียวกันฝั่งแนวรับไม่มีจุดที่มี touch >= 2 ใกล้ราคา จึงถอยหลังย้อนอดีตไปขุดเอา Swing Low เก่าโบราณจาก 36 ชั่วโมงก่อนหน้า ($2483.11, `🎯 1x`) มาเป็น Floor ทำให้กรอบราคาเบี้ยว ไม่สมดุล และไม่สะท้อนโครงสร้างราคาปัจจุบัน
                 - นอกจากนี้ การบล็อกหรือบายพาสด้วย if-else ยังคงเหลือโค้ด คลัสเตอร์ ป้าย marker และ telemetry ค้างอยู่มากมาย
               - **การแก้ไขในระบบ (Complete Purge)**:
                 1. **ลบโค้ด Multi-Touch ออกจากทั้งระบบ 100%**:
                    - ลบฟังก์ชัน `findMultiTouchSR()` ขนาด ~430 บรรทัดออกจาก `src/market-structure.ts`
                    - ลบฟิลด์ `resistanceCluster`, `supportCluster`, `allResistanceClusters`, `allSupportClusters`, `resistanceTouchCount`, `supportTouchCount` ออกจาก Interface และ Telemetry ทั้งหมดใน `market-structure.ts`, `strategy.ts`, `types.ts`
                    - ลบตัวเลือก `srMinTouchCount` และ `srTouchTolerancePct` ออกจาก `config.ts`, `strategy.ts`, `public/app.js`, และ `public/index.html`
                    - ลบโค้ดวาดป้าย `🎯 Nx` overlay badge และป้ายข้อความ `S/R Multi-Touch [Res: ..., Sup: ...]` ออกจาก `public/app.js`
                 2. **Symmetrical Nearest-Swing Progressive Expansion ใน `DOW_SWINGS`**:
                    - เริ่มต้นจากราคาปัจจุบัน (`refPrice`) หา Swing High ที่ใกล้ที่สุดเหนือราคา (`upSwings`) และ Swing Low ที่ใกล้ที่สุดใต้ราคา (`downSwings`)
                    - หากความกว้างเริ่มต้นยังน้อยกว่า `minChannelWidthPct` (เช่น 0.5% หรือ 2.0%) ระบบจะขยายกรอบทีละขั้นอย่างสมดุล (Symmetrical Expansion):
                      - คำนวณระยะห่างไปยัง High ถัดไปด้านบน และ Low ถัดไปด้านล่าง
                      - เลือกขยายฝั่งที่อยู่ใกล้ที่สุดก่อน หรือขยายทั้งสองฝั่งพร้อมกัน จนกระทั่ง `width >= minChannelWidthPct`
                    - ไม่มีการล็อกยอดเดิม ไม่มีการถอยไปหาเหวโบราณ และไม่มีการเสกเส้นลอยกลางอากาศ กรอบราคาจะยึดสวิงจริงรอบราคาปัจจุบันอย่างเป็นธรรมชาติ 100%
             9. **Pure Dow Confirmed Peak & Launchpad Base Valley Floor Anchoring (อิงเหวฐานจริงและยอดที่ยืนยันแล้ว 100%)**:
                - **สาเหตุ & ปัญหาเดิม**:
                  - เมื่อราคาทำยอดสูงสุด Major Peak (`HH` $0.2093) โค้ดเดิมเคยตัดประวัติเหวก่อนหน้าทิ้งทั้งหมด (`activeWaveBaseIndex = macroPeak.index`) ส่งผลให้เหวฐานจุดส่ง (**Launchpad Base Low** เช่น $0.2018 ในกล่องแดง) หลุดหายไป แล้วไประบุเอาเหวย่อยที่เพิ่งย่อตัวลงมา ($0.2028) เป็น Floor แทน ทำให้กรอบตื้นเกินไป และพร้อมจะ Cut Loss ผิดจังหวะ
                  - นอกจากนี้ ในช่วงที่ตลาดกำลังทุบลงมาทำ `LH + LL กดตัว` หลังยอด HH บอทไม่มีตัวหน่วงการซื้อ ทำให้เข้าไปช้อนซื้อไม้ Buy Level 1..4 จนเต็มพอร์ต (Capacity 99%) ท่ามกลางแท่งเทียนที่กำลังเทกระจาด
                - **การแก้ไขในระบบ**:
                  1. **Pre-Peak Launchpad Base Valley Anchoring**:
                     - เมื่อเกิด `macroPeak` ($0.2093) ระบบจะไม่ตัดประวัติที่ยอดนี้ แต่จะมองหาเหวฐานที่ส่งราคาขึ้นไปทำยอด (`launchpadLow` และ `baseClusterLows` เช่น $0.2018) มาเป็นจุดเริ่มต้นของรอบคลื่น
                     - กำหนดให้ Floor ยึดฐานจริง ($0.2018) เสมอตราบใดที่ราคายังไม่หลุดจุดนี้ และมองเหวระหว่างทาง ($0.2028) เป็นเพียง Sub-Swing ย่อย
                  2. **Downtrend Drop Guard (ป้องกันการรับมีดช่วงทุบ LH+LL & หลุดเหวเก่า Real-time)**:
                      - **Real-Time Valley Breakdown**: แทนที่จะรอป้าย LL แบบดีเลย์ 3 แท่ง (45 นาที) เมื่อราคาหลุดเหวเดิม (price < lastSwingLow.price เช่น หลุด .2045) บอทจะเปิดการทำงานทันทีตั้งแต่แท่งแรก!
                     - เมื่อโครงสร้างรอบคลื่นยืนยันสภาวะทุบขาลง (`LH + LL กดตัว` หรือ `isDowntrendDropActive`): บอทจะ **พักคำสั่งซื้อใน Buy Zone ทุกระดับชั่วคราว (`downtrendDropPaused = true`)** และยกเลิกคำสั่งซื้อ Resting Buys ที่ค้างอยู่บนกระดานทั้งหมด
                     - **การปลดล็อกให้เริ่มสะสมไม้ซื้อ จะต้องอิงจากสัญญาณการตั้งฐานที่แท้จริงเท่านั้น**:
                       - **เงื่อนไข 1 (HL Confirmed)**: เกิดการยืนยันเหวยกตัวสูงขึ้น (`HL`) ชัดเจน เหนือจุดต่ำสุดของรอบทุบ
                       - **เงื่อนไข 2 (Trendline Breakout)**: แท่งเทียนเบรคทะลุเส้นกด Downtrend Line ยืนยัน $\ge$ 2 แท่ง
                       - *(ตัดเงื่อนไขการปลดล็อกเพราะราคาลงมาใกล้ขอบล่าง 0%-10% ออก 100% เพื่อป้องกันการรับมีดก่อนที่กรอบจะหลุดลงไปทำ New Low ใหม่)*
                  3. **Zero Floating Math Guarantee**:
              11. **Candle Tracking when No Structural Valley Supports Below Price (เกาะแท่งเทียนเมื่อไม่มีเหวรองรับ) (`src/market-structure.ts`):**
                  - **สาเหตุ & ปัญหาเดิม:**
                    - เมื่อราคาเกิดการทุบหรือหลุด Floor เดิมลงมา (Drop Breakdown) ตรรกะเดิมค้นหา `canonicalLows` ที่ต่ำกว่าราคาปัจจุบัน แต่ไม่ได้จำกัดความกว้างกรอบ ทำให้ข้ามรอบไปดึงเหวโบราณในอดีต (เช่น เหว $0.192933 เมื่อ 2 วันก่อน) ส่งผลให้ Real S/R Floor ฉีกกว้างเกิน Max Channel Width (กว้างถึง 6.93% เกิน 6.0%) และระหว่างราคาปัจจุบัน ($0.198900) ถึงเหวโบราณไม่มีเหวรองรับอยู่เลย หรือกรณีที่ไม่มีเหวต่ำกว่าราคาในประวัติศาสตร์เลย ระบบจะใช้ `price - minSpan` แทนที่จะเกาะแท่งเทียน
                  - **การแก้ไขในระบบ:**
                    1. **Max Channel Span Guard on Valleys**: กรองเหวโครงสร้างด้านล่าง `lowerValleys` และ `lowerConfirmedValleys` ให้พิจารณาเฉพาะเหวที่อยู่ในระยะความกว้างสูงสุดของกรอบ (`curCeil - l.price <= maxSpanFromPct` หรือ `upperBound - l.price <= maxSpan`)
                    2. **Candle Tracking Fallback**: ในกรณีที่ไม่มีเหวรองรับอีก (หรือเหวในอดีตอยู่ลึกเกินระยะ Max Channel) ให้อนุญาตให้ Real S/R Floor เกาะแท่งเทียนได้ทันที โดยดึงจากจุดต่ำสุดของแท่งเทียนล่าสุด: `candidateValley` (หากมี Candidate Low) หรือ `lastCandleEffLow` (ไส้ล่างของแท่งเทียนล่าสุด) และกำหนด `activeValley` ชี้ไปที่แท่งเทียนนั้นทันที
                    3. **Decoupled Strategy Cut Loss Shield**: คงตรรกะการ Cut Loss และ Locked Floor ของ Position ตามเดิมอย่างเข้มงวด เพื่อปกป้องต้นทุนเงินทุนตามการตั้งค่าความปลอดภัยของผู้ใช้
                     - ยกเลิกสูตรบวก/ลบเลข `shortfall / 2` กลางอากาศออก 100% การันตีว่าเส้น Ceiling และ Floor บนกราฟจะไม่มีการลอยเคว้งหรือตัดกลางแท่งเทียนอีกต่อไป

             10. **False HL Invalidation & Active Downwave Base Valley Anchoring (src/market-structure.ts):**
                 - **สาเหตุ & ปัญหาเดิม:**
                   - เมื่อเกิดยอดสูงสุด Macro Peak (เช่น .07) แล้วราคาทุบตัวลงมา จุดสวิง Low จุดแรกหลังยอด (เช่น ) ได้รับการประเมินเบื้องต้นเป็น HL เนื่องจากราคาสูงกว่าสวิง Low ก่อนหน้าที่เป็นฐานส่ง (.70)
                   - แต่เมื่อเวลาผ่านไป แท่งเทียนทุบหลุดต่ำกว่า  ลงไปทำ New Low ใหม่ (เช่น .48) ป้ายที่จุด  กลับยังค้างเป็น HL หลอกตา ทั้งที่ฐานรับถูกทำลายลงไปแล้ว
                   - นอกจากนี้ ตัวแปร ctiveWaveBaseIndex และ aseValley ใน getStructure() ยังคงวิ่งถอยหลังย้อนอดีตไปหาจุดฐานส่งก่อนหน้า (.70) ทำให้ Floor ไม่ยอมเกาะที่เหวต่ำสุดของรอบทุบปัจจุบัน (.48) แม้ว่าความกว้างระหว่างยอด .07 กับเหว .48 จะกว้างถึง 1.33% (เกินเกณฑ์ minChannelWidthPct = 0.5% บนเซิร์ฟเวอร์จริง) แล้วก็ตาม
                 - **การแก้ไขในระบบ:**
                   1. **False HL Invalidation ใน nalyzeWaveCycles:**
                      - เพิ่มรอบตรวจสอบ Post-processing: หากสวิงใดที่เคยได้รับป้าย HL มีสวิง Low ในอนาคตถัดมาที่มีราคาต่ำกว่ามัน (ext.price < sw.price) แสดงว่าฐานรับถูกทำลาย ให้ Invalidate เปลี่ยนป้ายเป็น LL ทันที และประเมิน lastHl, lastLl, และ lastLowLabel ใหม่อย่างถูกต้อง
                   2. **Active Downwave Base Valley Anchoring ใน getStructure:**
                      - ในสภาวะ Downwave หลังยอด Macro Peak (macroPeak.index > macroLow.index):
                      - ตรวจหา postPeakLows ที่เกิดขึ้นหลังยอด Macro Peak หากมีอยู่ ให้ยึดจุดต่ำสุดของรอบทุบนี้ (lowestPostPeak เช่น .48) เป็น ctiveWaveBaseIndex และกำหนดให้ aseValley ล็อคเกาะจุดต่ำสุดนี้เป็น Floor ทันที
                      - ส่งผลให้กรอบล่าง Snap เข้ากับจุดสวิงเหวแท้จริงของรอบคลื่นปัจจุบันอย่างแม่นยำ ไม่ถอยหลังไปหาฐานส่งในอดีต
              11. **Dynamic Channel Hysteresis Bypass on Confirmed Swings & Flat Inventory (`src/strategy.ts`):**
                  - **สาเหตุ & ปัญหาเดิม:**
                    - ใน `strategy.ts` มีการตรวจสอบ `lowerShift < minShiftPct && upperShift < minShiftPct` (โดย `minShiftPct` ตั้งไว้ที่ 1.0% ใน `settings.db.json`)
                    - เมื่อราคาทำยอด New High (HH) หรือทำเหวใหม่ (HL/LL) ที่ขยับน้อยกว่า 1.0% (เช่น ราคา ETH ขยับจาก $2,572.50 ไป $2,582.43 คิดเป็น +0.386%) ระบบจะทับค่ากลับไปใช้ยอดเดิม $2,572.50 ใน `lastDynamicBounds` ซ้ำทุก Tick
                    - ทำให้เกิดอาการ Deadlock ค้างอยู่ที่ยอดเดิมตลอดเวลา แม้เวลาผ่านไปหลายแท่งเทียน จนกว่าผู้ใช้จะกด Restart บอทเพื่อล้างหน่วยความจำ RAM
                  - **การแก้ไขในระบบ:**
                    1. **Confirmed Swing Change Detection (`swingChanged`)**: ติดตาม `lastActivePeakTime/Price` และ `lastActiveValleyTime/Price` หากมีจุดสวิงใหม่ที่ Dow Theory ยืนยันแล้ว (เกิด HH, LH, HL, LL ใหม่) ระบบจะอนุญาตให้ปรับกรอบทันทีโดยไม่ถูก `minShiftPct` บล็อค
                    2. **Unrestricted Dynamic Updates When Flat (`!isHoldingPosition`)**: ในช่วงที่ไม่ได้ถือครอง Position (0 Open Lots / ถือเงินสด 100% รอสะสมของ) กรอบ Ceiling, Midline, Floor และ Buy Levels 1..4 จะปรับตัวแบบ Dynamic ตามโครงสร้างตลาดล่าสุดเสมอ ไม่ถูกแช่แข็ง
              12. **DreamDEX Full Gas Tracking, 4-Decimal SOMI Precision & Compensated Gas Reserve Shield (`src/strategy.ts` & `src/exchange/dreamdex/client.ts`):**
                  - **สาเหตุ & ปัญหาเดิม:**
                    1. **Whole Integer Truncation (`stepSize: 1.0`)**: คู่ `SOMI:USDSO` เคยฮาร์ดโค้ด `stepSize: 1.0` ทำให้คำสั่งซื้อขายและการกักกันแก๊สถูกปัดเศษทศนิยมทิ้งหมด (เช่น หักแก๊ส 0.0083 SOMI จากไม้ 196 SOMI กลายเป็นปัดทิ้งเหลือ 195.0 SOMI เสียหายไปเกือบ 1 SOMI)
                    2. **One-Way Buy Gas Tracking Only**: ค่าแก๊สที่นำเข้าสู่ `accumulatedGasBase` ดึงเฉพาะจาก IOC Buy Fills แต่คำสั่งฝั่ง Sell (Limit/IOC), Cancel orders, และ Token approvals ถูกมองข้าม ไม่เคยนำค่าแก๊สที่จ่ายจริงมาบวกสะสมเพื่อชดเชยคืน
                    3. **`reconcileInventory` Over-Adoption**: เมื่อกักกัน SOMI ไว้ในกระเป๋า ฟังก์ชัน `reconcileInventory` เห็นว่ามีเหรียญเกินกว่า Lot จึง Auto-Adopt ยอดแก๊สที่กักไว้กลับไปสร้าง Lot รอขาย พอราคาถึงเป้า บอทก็เทขายเหรียญค่าแก๊สทิ้งออกไปเป็น USDso จนหมด ทำให้ยอด SOMI ในกระเป๋าลดลงเรื่อยๆ
                  - **การแก้ไขในระบบ:**
                    1. **4-Decimal SOMI Precision (`stepSize: 0.0001`, `minQty: 0.0001`)**: ปลดล็อคให้เทรดและคำนวณ SOMI เป็นเศษทศนิยม 4 ตำแหน่งได้เหมือน WETH/WBTC ทำให้การหักค่าแก๊ส (เช่น 0.0046, 0.0083 SOMI) ทำงานได้แม่นยำ 100%
                    2. **Full Lifecycle Gas Tracking (`onGasSpent`)**: เพิ่ม Event Callback `onGasSpent` บน `DreamDexClient` ติดตามค่าแก๊สที่จ่ายจริงจากทุกคำสั่ง (IOC Buy, IOC Sell, Limit Orders, Cancel Sweeps, และ Token Approvals) ส่งเข้าสะสมใน `accumulatedGasBase` ทันทีเมื่อคอนเฟิร์ม Receipt บน Somnia
                    3. **Compensated Gas Reserve Shield (`getEffectiveGasReserveBase`)**: รวม `totalGasDeductedBase` เข้าเป็นส่วนหนึ่งของ Protected Gas Reserve เสมอ การันตีว่า `reconcileInventory` จะไม่มีวันแตะต้องหรือนำเหรียญ SOMI ที่กักกันเป็นค่าแก๊สกลับไปสร้างเป็น Lot ขายอีกต่อไป เหรียญแก๊สที่ชดเชยจะอยู่ถาวรในกระเป๋าจริง

               13. **Lower Confirmed Structural Valley Anchoring on Breakdown (กำจัดบั๊ก Floor เกาะติดใต้แท่งเทียน price * 0.9995) (`src/market-structure.ts`):**
                   - **สาเหตุ & ปัญหาเดิม:**
                     - ใน `src/market-structure.ts` มีตรรกะบังคับราคาให้อยู่ในกรอบเดิม `if (price < curFloor) curFloor = price * 0.9995;`
                     - และในบล็อก `isDropBreakdown`: ดึงเอา `liveLowCandidate = price < bottomBound ? price : undefined` มากำหนด `bottomBound = liveLowCandidate` ตรงๆ
                     - เมื่อราคาร่วงหลุด Floor เดิม ($2,546.51) ลงมาที่ $2,539.24 บอทคำนวณ $2,539.24 * 0.9995 = $2,537.970380 ทำให้ขอบล่างจริง (`liveCalculatedBottomBound`) สไลด์ตามเกาะติดใต้ไส้แท่งเทียนทันที แทนที่จะยึดเหวโครงสร้างที่ต่ำกว่า (`🌊 LL` ที่ $2,527.41)
                   - **การแก้ไขในระบบ:**
                     1. ในบล็อกคำนวณกรอบเริ่มต้น (`mode !== "DONCHIAN_ATR"`): เมื่อ `price < curFloor` ให้ค้นหาเหวที่ยืนยันแล้วในโครงสร้าง (`canonicalLows`) ที่อยู่ต่ำกว่าราคาปัจจุบัน (`l.price < price`) แล้วเลือกเหวที่ใกล้ราคาที่สุดลงไป (เช่น $2,527.41) มาเป็น Floor ทันที หากไม่มีเหวที่ต่ำกว่าราคานี้แล้วจึงค่อยขยายตาม `minSpanFromPct`
                     2. ในบล็อก `isDropBreakdown`: ปรับให้ค้นหาเหวที่ยืนยันแล้วด้านล่าง (`lowerConfirmedValleys`) ก่อนเสมอ และเมื่อเกิดการสร้างแท่งคอนเฟิร์มเป็น New Swing Low ใหม่จริง จึงค่อยปรับขยับ Floor ลงมารับจุดใหม่ตามทฤษฎี Dow Theory

                14. **Post-Dump Recovery Base Decoupling, Ceiling Pull-Down Fix on HH & Symmetrical Higher Low (HL) Floor Lifting (`src/market-structure.ts`):**
                    - **สาเหตุ & ปัญหาเดิม:**
                      1. **`baseValley` ยึดติด Flash Dump โบราณ:** เมื่อเกิดการทุบ (Flash Crash เช่น BNB รูดลง $726.58) โดยที่ยอดสูงสุดของ Lookback 192 แท่ง (`macroPeak` เช่น $759.00) เกิดขึ้น*ก่อน*การทุบ ตรรกะ `activeWaveBaseIndex = macroLow.index` จะล็อคเข้าที่จุดต่ำสุด $726.58 เสมอ และวนลูปหา `minLow` ทำให้ `baseValley` ได้ $726.58 ค้างเติ่ง แม้ว่าตลาดจะฟื้นตัวและสร้างฐานใหม่ที่ $738.55 มานานกว่า 24 ชั่วโมงแล้วก็ตาม
                      2. **Ceiling ถูกดึงลงมาชิดราคาผิดปกติจาก `Boolean(waveCycle.lastLh)`:** ในบล็อกปรับลดกรอบบน มีเงื่อนไข `Boolean(waveCycle.lastLh)` ซึ่งแทบจะเป็นจริงเสมอในประวัติ 192 แท่ง ส่งผลให้เมื่อราคาทำ Higher High (HH $747.43) กรอบบนกลับถูกดึงรูดลงมาครอบที่ LH เก่า ($743.89) ทำให้ราคาชนเพดาน 99.4% ตลอดเวลา
                      3. **ขาดตรรกะยกฐานตาม Higher Low (HL) อย่างสมมาตร:** ในโค้ดเดิมมีเฉพาะการปรับกรอบบนลดลงตาม LH หรือยกขึ้นตาม HH และปรับกรอบล่างลดลงตาม LL แต่ไม่มีตรรกะยก Floor ขึ้นตาม Higher Low (HL) เมื่อตลาดฟื้นตัวทำคลื่นขาขึ้น (`HH + HL ยกตัว`)
                      4. **การขยายกรอบตาม `minSpanFromPct` รูดทะลุกลับไปหา Flash Crash:** เมื่อความกว้างสวิงปัจจุบันแคบกว่า `minChannelWidthPct` ลูป `curCeil - curFloor < minSpanFromPct` จะหยิบสวิงถัดไปในอดีตทันที ซึ่งเนื่องจากจังหวะดีดตัวเป็น V-shape ไม่มีสวิงคั่นกลาง ระบบจึงกระโดดข้ามลงไปหยิบ $726.58 (ระยะห่างเกินความจำเป็นถึงเกือบ 3 เท่า)
                    - **การแก้ไขในระบบ:**
                      1. **Post-Dump Recovery Wave Base Recognition:** เมื่อ `macroPeak.index <= macroLow.index` ให้ตรวจจับคลื่นฟื้นตัวหลังการทุบ (`postLowHighs` และ `postLowLows`) หากมีการตั้งฐานหลังจุดทุบแล้ว ให้กำหนด `activeWaveBaseIndex` เป็นจุดต่ำสุดของคลื่นฟื้นตัวหลังการทุบ (เช่น $738.55) ปลดล็อคไม่ให้ยึดติดกับ Flash Dump $726.58
                      2. **Ceiling Pull-Down Protection on HH:** เพิ่ม Guard `!isLatestHighHh` และตัด `Boolean(waveCycle.lastLh)` ออก เพื่อไม่ให้เพดานถูกดึงลงมา หากรอบปัจจุบันยืนยันการทำ Higher High (HH)
                      3. **Symmetrical Higher Low (HL) Floor Lifting Rule:** เพิ่มกฎ Dow Theory สมมาตรกับฝั่ง LH โดยเมื่อราคายกฐานทำ Higher Low (HL) ยืนยันแล้วในรอบขาขึ้น/ฟื้นตัว ให้ระบบค้นหาเหว HL ที่ยืนยันแล้วที่อยู่ต่ำกว่าราคาปัจจุบัน และรักษาระยะห่างจาก `upperBound >= minSpan` และปรับยก `bottomBound` (Floor) ขึ้นมาเกาะฐาน HL นั้นทันที
                      4. **Shortfall Overshoot Cap (1.5x):** ในลูปขยายกรอบตาม `minSpanFromPct` จำกัดระยะการหยิบสวิงในอดีตไม่ให้เกิน 1.5x ของระยะที่ขาดจริง (`lDist <= needed * 1.5`) ป้องกันไม่ให้รูดตกหล่นไปหาสวิง Flash Crash โบราณ แต่ให้ใช้วิธีขยายกรอบเติมเต็มระยะ shortfall อย่างราบรื่น

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
     - **Strict Expired Orders Filtering (`expireTimestampNs > nowNs`)**: บน Somnia Indexer ออเดอร์ที่หมดอายุไปแล้วในอดีต (เช่น ออเดอร์ $0.085000 จาก 2 เดือนก่อน) ยังคงมีสถานะเป็น `Open` ในฐานข้อมูล จึงต้องกรอง `expireTimestampNs > nowNs` เพื่อกำจัด Phantom Orders เก่าที่หมดอายุแล้วออก 100%
     - **IOC Bracket Buy Phantom Ask Guard**: ใน `executeIocBracketGrid` เพิ่ม Guard ป้องกันราคา Ask หลุดโลก (`|currentBestAsk - refPrice| / refPrice <= 0.05`) และบังคับให้ราคาตลาดจริง (`refPrice`) ต้องลงมาถึงระดับ Buy Level จริงด้วย ป้องกันไม่ให้บอทกระโดดยิงคำสั่งซื้อตอนที่ตลาดยังอยู่ใน Sell Zone (>50%)
     - มีระบบ In-memory cache 1.5 วินาที เพื่อป้องกันการยิง GraphQL ถี่เกินไประหว่าง Polling
     - **Price $0.000000 & Mid Fallback Protection**:
       - แก้ไขจุดบกพร่อง `effectiveMid = mid ?? binancePrice` ใน `src/strategy.ts` ที่ประเมิน `0 ?? binancePrice` เป็น `0` โดยปรับเป็น `const effectiveMid = (mid !== undefined && mid > 0) ? mid : (binancePrice ?? 0);`
       - ป้องกันปัญหา Orderbook บน DEX ว่างจนสะดุด Spread Dislocated Gate ด้วยการผ่อนปรนให้ใช้ CEX Reference Price ได้อย่างปลอดภัย
   - **Broken Floor & Higher Low Recovery (`checkForHigherLow`)**:
     - ปรับปรุงการตรวจสอบ Higher Low หลังหลุด Floor ใน `market-structure.ts` และ `strategy.ts` ให้ตรวจจับสวิงที่ได้รับการวิเคราะห์คลื่น Dow Wave Cycles ว่าเป็น `HL`
     - **Strict Breakdown Floor Reclaim Protection**: ป้องกันบั๊กกรอบเลื่อนลงมาหลอกระบบ (False Floor Reclaim) โดยหากราคาหลุด Floor และเกิด Cut Loss จน Channel สร้างกรอบใหม่ที่ Floor เลื่อนต่ำลงมา ระบบจะ**ห้าม**ปลดล็อค `waitingForHigherLow` เพียงเพราะราคายืนเหนือ Floor ใหม่ แต่ต้องรอ Higher Low (`HL`) คอนเฟิร์มจาก Dow Theory จริงๆ หรือราคากลับขึ้นไปยืนเหนือ Floor เดิมก่อนหลุด (`breakdownFloorPrice`) เท่านั้น
   - **Exchange-Layer Order Expiry Isolation (`supportsOrderExpiry`)**:
     - **Binance Spot (CEX)**: คำสั่ง Limit บน Binance ทำงานแบบ **`GTC` (Good-Till-Cancelled)** โดยสมบูรณ์ ไม่มีวันหมดอายุตามเวลา (`supportsOrderExpiry = false`) บอทจะไม่สร้างหรือบันทึกเวลาหมดอายุหลอก ไม่ใส่ข้อความ `[Expires in ...h]` ใน Log และแดชบอร์ดจะแสดงสถานะเป็น `GTC` (ไม่แสดงไอคอนนาฬิกาทราย ⏳)
     - **DreamDEX Spot (DEX on Somnia)**: สัญญาออนเชน `SpotPool.sol` มีพารามิเตอร์ `expireTimestampNs` จริง (`supportsOrderExpiry = true`) บอทจะนำค่า `orderExpireHours` จากการตั้งค่าส่งเข้าไปในสัญญาออนเชนจริง และหน้า Dashboard จะแสดงเวลานับถอยหลัง ⏳ ตามจริง
     - **Exchange Isolation ใน UI**: ใน Settings Modal ย้ายช่องตั้งค่า `Limit Order Duration (Hours)` ไปอยู่ภายใต้กลุ่ม DreamDEX (`.dreamdex-fields-group`) โดยอัตโนมัติ เมื่อผู้ใช้เลือก Exchange เป็น Binance ช่องนี้จะถูกซ่อนไว้เพื่อป้องกันความสับสน

---

                - **Swing-Anchored Boundaries & Adaptive Edge Grid Levels for Narrow Channels**:
      - **สาเหตุ & ปัญหาเดิม**: เมื่อราคาทำแนวต้านใกล้ชิดราคาปัจจุบัน (เช่น ) และช่วงสวิงแคบกว่า minSpanPct โค้ดเดิมเคยนำสูตร upperBound - minSpanFromPct มาสร้างเป็นเส้น Floor สมมุติลอยๆ (.09) โดยไม่มีจุดอ้างอิงสวิงเหวหรือฐานรับจริงบนกราฟเลย และการซอยไม้ตรงกลางในกรอบแคบเสี่ยงต่อการเทรดติดขัด
      - **การแก้ไขใน Market Structure (src/market-structure.ts)**:
        1. **100% Swing-Anchored Bounds (No Floating Math Floors)**: ตัดสูตรการลบ % ลอยๆ ทิ้งทั้งหมด และบังคับให้ Floor ล็อคเข้ากับจุดเหวจริง (lowestWaveValley หรือ Swing Low ต่ำกว่าราคาที่ใกล้เคียงที่สุด) เสมอ ทำให้กรอบราคาบนชาร์ตมีจุดอ้างอิงของสวิงจริง 100%
        2. **Narrow Pair Selection Resilience**: ใน findMultiTouchSR หากคู่สวิงแคบกว่า minSpanPct ระบบจะไม่ตัดทิ้งหรือคืน undefined แต่จะให้คะแนนและเลือกคู่สวิงที่ดีที่สุด (เช่น ยอด  กับเหว ) และยอมรับความกว้างจริงตามธรรมชาติของตลาด
        3. **Adaptive Edge Grid Levels (< 1.2% Narrow Channel)**: เมื่อกรอบราคาแคบกว่า 1.2% ระบบจะปรับระดับกริดให้ขยับไปเน้นเข้าซื้อที่ขอบล่าง (Floor + 0.2%) และขายที่ขอบบน (Ceiling - 0.2%) โดยอัตโนมัติ เพื่อรักษาความคุ้มค่าของการทำกำไรและไม่ขัดแย้งกับการกระจายสัดส่วน 40/30/20/10 ในกรอบปกติ
    - **Structural Min-Channel Width & Anchor Priority Protection (MULTI_TOUCH_SR)**:
      - **สาเหตุ & ปัญหาเดิม**: ในโหมด MULTI_TOUCH_SR ฟังก์ชัน findMultiTouchSR เคยมีการฮาร์ดโค้ด effectiveTradeableMinSpan = Math.min(minSpanPct, 1.8) ทำให้ลดเกรด minSpanPct ของผู้ใช้ลงเหลือ 1.8% และไม่มีการตรวจสอบ minSpanFromPct หลังได้กรอบ ส่งผลให้เมื่อสวิงในคลื่นปัจจุบันแคบและราคาทำ Lower High เล็กๆ () ระบบได้บีบ Ceiling ลงมาติดราคาปัจจุบัน และถอยหลังย้อนอดีตไปกด Floor ลงไปหาเหวเก่าที่จบคลื่นไปแล้ว () เพื่อให้ได้ความกว้างครบแทนที่จะมองหายอดต้านด้านบน
      - **การแก้ไขใน Market Structure (src/market-structure.ts)**:
        1. **Strict User Min-Span (effectiveTradeableMinSpan)**: เคารพ minSpanPct ของผู้ใช้อย่างเคร่งครัด (เช่น 3.0%) โดยไม่ตัดลดทอนลงมาเป็น 1.8%
        2. **Ancient Low Penalty & Base Valley Anchor**: เพิ่มแต้มคะแนนพิเศษ (currentBaseBonus) สำหรับคู่สวิงที่ยึดฐานรับ (Valley/Support) ของคลื่นปัจจุบัน และเพิ่มโทษหนัก (ancientLowPenalty: -6000) ป้องกันไม่ให้ระบบดึงเหวเก่าในอดีตที่ราคาหลุดรอบไปแล้วมาใช้
        3. **Structural Min Channel Width Expansion**: ในกระบวนการ Clamping หากกรอบแคบกว่า minSpanFromPct ระบบจะขยายกรอบไปยังสวิงที่เป็นไปได้จริงของโครงสร้าง Dow Theory (หากราคาอยู่ใกล้ฐานล่าง จะมองหายอดบนในรอบคลื่นเพื่อทำ Ceiling แทนการกด Floor ลงเหวลึก)
    - **On-Chain Order Transaction-Hash Deduplication & Metadata Merging (cleanupDuplicateTxRecords)**:
      - **สาเหตุ & ปัญหาเดิม**: คำสั่งประเภท IOC ที่ยิงสำเร็จบน DreamDEX เชน Somnia จะบันทึกเฉพาะ txHash ในรอบแรก (ยังไม่มี on-chain orderId จนกว่า Indexer จะประมวลผล) เมื่อบอทเรียกซิงค์ประวัติจาก Indexer (syncRecentOrdersFromIndexer) ตรรกะเดิมเทียบเฉพาะ orderId ทำให้บอทมองไม่เห็นเรคคอร์ดเดิมที่มีอยู่แล้ว และบันทึกคำสั่งเพิ่มซ้ำซ้อน (Duplicate Entry เช่น มีทั้ง IOC Buy Level 2 และ BUY Market (IOC) ภายใต้ txHash เดียวกัน)
      - **การแก้ไขใน Database Layer (src/db.ts)**:
        1. **Enhanced Matching ใน syncRecentOrdersFromIndexer**: ตรวจจับและจับคู่ออเดอร์เดิมผ่าน orderId หรือ txHash (placedTxHash, fillTxHash, createTxHash) หากพบรายการเดิมจะทำการอัปเดตและผูก orderId จากสัญญา Smart Contract เข้ากับเรคคอร์ดเดิมทันที ไม่สร้างแถวซ้ำ
        2. **Multi-Source Deduplication ใน recordEvent**: ป้องกันการเพิ่มเรคคอร์ดสถานะ FILLED ซ้ำหากมี txHash ตรงกันในระบบ
        3. **Auto-Cleanup & Metadata Merging (cleanupDuplicateTxRecords)**: กวาดล้างและยุบรวมรายการออเดอร์ในอดีตที่แชร์ txHash เดียวกัน โดยคงชื่อ Grid Level ดั้งเดิมของบอท (เช่น IOC Buy Level 2) พร้อมผูก orderId จาก on-chain เข้าด้วยกันอย่างสมบูรณ์แบบ
    - **On-Chain Order History Sync & Inventory Reconciliation (getRecentOrders & syncOnChainOrders)**:
      - **สาเหตุ & ปัญหาเดิม**: เมื่อเกิด Cut Loss หรือ Buy แบบ IOC บน DreamDEX คำสั่ง Match ทันทีบน On-Chain สัญญา Smart Contract แต่ในอดีตหากบอทบันทึกสถานะไม่ทัน หรือเริ่มทำงานใหม่หลังรีสตาร์ท ประวัติคำสั่งซื้อขายใน Dashboard และฐานข้อมูล db.orders จะขาดหายไป ไม่ตรงกับความเป็นจริงบนบล็อกเชน และการคำนวณ reconcileInventory (เวลามีเหรียญที่ไม่ได้ผูกกับ Lot) จะต้องเดาราคาต้นทุน fallback
      - **การแก้ไขใน Adapter Layer (IExchangeClient)**:
        - เพิ่มเมธอดมาตรฐาน getRecentOrders(symbol: string, limit?: number) เข้าไปใน IExchangeClient
        - ใน DreamDexClient: คิวรีคำสั่งย้อนหลังโดยตรงจาก Somnia GraphQL Indexer (SomniaIndexerClient) พร้อมแปลงสถานะ On-Chain (Filled, Cancelled, Open) และ Transaction Hash ออกมาเป็น Standard Exchange Orders
        - ใน BinanceClient: คิวรีผ่าน Binance REST API /api/v3/allOrders
      - **การทำงานใน Strategy (syncOnChainOrders & reconcileInventory)**:
        - ใน src/strategy.ts: บอทจะซิงค์คำสั่งล่าสุดจาก On-Chain / CEX ทุกครั้งที่เริ่มต้นระบบ และระหว่างการรันตามระยะเวลาที่กำหนด เพื่อเติมเต็มประวัติออเดอร์ใน db.orders และ this.recentOrders
        - ใน reconcileInventory: หากตรวจพบว่ามีเหรียญตกค้างในกระเป๋าที่ยังไม่ถูกสร้างเป็น Lot บอทจะนำราคาของคำสั่ง BUY_FILL ล่าสุดที่จับคู่ได้จริงจาก Indexer มาตั้งเป็น costPrice ของ Lot นั้นทันที แทนการเดาราคา fallback

                          11. **Strict Downwave Low Labeling & Elimination of False HL (ป้องกันป้าย HL ปลอมช่วงทุบ)**:
                 - **สาเหตุ & ปัญหาเดิม**:
                   - เมื่อราคาเกิดรอบทุบหลังยอด High (เช่น HH .2093 -> .2045 -> .2019) ใน analyzeWaveCycles ตรรกะเดิมเปรียบเทียบเฉพาะสวิงที่อยู่ใน alternatingSwings ติดกัน หากสวิงย่อยตรงกลางถูกกรองออก สวิง .2019 จะถูกนำไปเทียบข้ามรอบกับเหวโบราณของเมื่อวาน (.2009) ส่งผลให้ได้รับป้าย HL ปลอม ทั้งที่กำลังทุบหลุดเหว .2045 ลงมาสดๆ ร้อนๆ
                   - หากระบบถือว่าจุดนี้เป็น HL จะทำให้ตัวกรอง Downtrend Drop Guard เข้าใจผิดว่าตลาดตั้งฐานเสร็จแล้ว และปลดล็อกการเข้าซื้อกลางอากาศ
                 - **การแก้ไขในระบบ (src/market-structure.ts)**:
                   - ตรวจสอบประวัติสวิงโลว์ทั้งหมดที่เกิดขึ้นหลังยอด High ล่าสุด (priorLowsInDownwave): หากมีเหวก่อนหน้าในรอบทุบนี้ที่สูงกว่าจุดปัจจุบัน สวิงปัจจุบันจะถูกจัดเป็น LL (Lower Low) เสมอ 100%
                   - ป้องกันไม่ให้เกิดการข้ามรอบไปเทียบกับเหวของวันก่อนหน้า ขจัดปัญหา False HL และรับประกันว่าจะไม่เปิดซื้อจนกว่าจะเกิดการกลับตัวและยกฐานเหนือจุดต่ำสุดของรอบทุบจริง
             10. **Breakdown Dynamic Floor Tracking & Closest Min-Width Peak Ceiling Selection (โหมดไม่มีของ / Flat)**:
                 - **สาเหตุ & ปัญหาเดิม**:
                   - เมื่ออยู่ในโหมดป้องกันดาวน์เทรนด์ (Downtrend Drop Guard) และราคาทิ่มหลุดกรอบ Floor เดิมลงไปทำ New Low / candidateValley (เช่น .2019 ในรูป 0/3) กรอบล่าง Floor เดิมจะยังค้างอยู่ที่เหวเก่า (.2030) ทำให้ราคาหลุดออกนอกกรอบล่าง (0% Floor / Below Channel) และกรอบบน Ceiling ยังค้างอยู่ที่ยอดสูงเดิม ไม่ยอมปรับลดลงมารักษาความกว้างให้กระชับ
                 - **การแก้ไขในระบบ (src/market-structure.ts)**:
                   1. **Real-Time Dynamic Floor Tracking**: เมื่ออยู่ในสภาวะหลุดเหวหรือมีรอบทุบ (isDropBreakdown) และราคาหรือ candidate low หลุดต่ำกว่า Floor เดิม (liveLowCandidate < bottomBound): ปรับ Floor ลงมารับจุด Low ล่าสุดทันทีเพื่อเกาะติดการเคลื่อนไหวของราคา พร้อมซิงค์ activeValley และ activePeak ให้ตรงกับจุดสวิงที่อัปเดตใหม่ 100%
                   2. **Closest Min-Width Peak Ceiling Selection**: เมื่อ Floor ปรับลงมาที่ New Low ระบบจะคำนวณหาระยะกว้างขั้นต่ำ minSpan = bottomBound * minChannelWidthPct และเลือกยอดสวิงที่ยืนยันแล้ว (canonicalHighs) ที่อยู่สูงกว่า New Floor อย่างน้อย minSpan โดยเรียงจากยอดต่ำสุดขึ้นไป (.sort((a, b) => a.price - b.price)) และเลือกยอดแรกที่ใกล้เคียงกับความกว้างขั้นต่ำที่สุด เพื่อให้กรอบราคากระชับและเกาะติดการเคลื่อนที่ของราคาอย่างสมบูรณ์แบบ
                   3. **Zero Floating Math**: ทั้ง Floor และ Ceiling ยึดจากจุดสวิงจริงของแท่งเทียนเท่านั้น ไม่มีการนำตัวเลขลอยมาบวก/ลบในอากาศ
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
- **Narrow Channel Single Edge-Bracket Mode (`isNarrowChannel = width < 1.20%`)**:
  - **สาเหตุ & แนวคิด**: ในสภาวะตลาดที่มีกรอบแคบมาก (`channel width < 1.2%`) หากยังซอยไม้แบ่งออกเป็น 4 ระดับ (L1-L4) จะทำให้ระยะห่างระหว่างระดับเหลือเพียง 0.1%–0.2% ซึ่งอัดแน่นเกินไป เสี่ยงต่อการซื้อกระจุกตัวกลางกรอบและติดดอยง่าย
  - **การทำงาน**:
    - **Buy Level**: ยุบเหลือระดับเดียวที่ขอบล่าง **Floor + 0.2%** (`bottomBound * 1.002`) สำหรับสะสมไม้เดียวเต็มโควต้าเมื่อราคาลงมาทดสอบก้นกรอบจริง
    - **Sell Level**: ยุบเหลือระดับเดียวที่ขอบบน **Ceiling - 0.2%** (`upperBound * 0.998`) สำหรับขายทำกำไรเต็มโควต้า 100% (Full Exit) เมื่อราคาเด้งทดสอบยอดกรอบ
    - ใน `executeIocBracketGrid`: ฝั่งขายจะกำหนด `numSellTranches = 1` เพื่อขายกวาดหมดพอร์ตที่ขอบบนทันที และบน UI กราฟ `app.js` จะแสดงเส้นกรอบที่ตรงกับระดับจริง ไม่กระจายเส้นหลอก
    - ใน `syncRestingOrders` & `reconcileInventory`: รองรับทั้งสองโหมดอย่างสมบูรณ์ (Dual Mode Compatibility):
      - ตรวจจับขนาด `buyLevels.length` และ `sellLevels.length` แบบไดนามิก
      - ถ้าแคบ (`length === 1`): กำหนดชื่อระดับเป็น `Buy Edge Floor (+0.2%)` และ `Sell Edge Ceil (-0.2%)` พร้อมเป้า `buyTargets = [1.0]` และ `sellHoldingTargets = [0.0]`
      - ถ้าปกติ (`length >= 4`): กำหนด 4 ระดับ `Buy Level 1..4 (40%..10%)` และ `Sell Target 1..4 (60%..90%)` ตามลำดับ
      - **Duplicate-per-Level Trimming (Elimination of Cancel-Create Loops)**: ตรวจจับออเดอร์ส่วนเกินโดยเช็คว่ามีออเดอร์ซ้ำในระดับเดียวกันหรือไม่ (เช่น มี 2 ออเดอร์ที่ถูก Re-link ไปเป็น Buy Level 2) ระบบจะเก็บออเดอร์ที่ราคาใกล้เคียงกับราคา Grid ของระดับนั้นที่สุดไว้เพียง 1 รายการ และยกเลิกเฉพาะตัวที่เกิน โดยไม่ไปตัดออเดอร์ของระดับอื่น (เช่น Buy Level 1) ทิ้งแบบสุ่มสี่สุ่มห้าอีกต่อไป ป้องกันลูป Cancel-Replace ได้ 100%
- **Dynamic Buy Tranche Allocation & Min Notional Floor (No Rigid / 4 Dilution)**:
  - แทนที่จะหาร 4 แบบคงที่ (`currentAvailableCapacity / 4`) ซึ่งทำให้เกิดปัญหาเมื่อเหลือความจุ เช่น $15.75 แล้วถูกหารจนเหลือเพียง $3.82 จนต่ำกว่า Binance Min Notional ($5.00)
  - ระบบจะคำนวณจำนวนระดับที่พร้อมวางคำสั่งซื้อจริง (`numEligibleBuyLevels`) โดยไม่นับระดับที่ติด Holding Fraction Guard หรือ Trendline Filters
  - หากหารเฉลี่ยแล้วขนาดไม้ต่ำกว่า $5.00 (`rawTrancheQuote < minNotional`) ระบบจะรวบรวมงบที่เหลือเข้าด้วยกัน (`min(currentAvailableCapacity, minOrderNotional)`) เพื่อการันตีว่าออเดอร์มีมูลค่า $\ge \$5.00$ เสมอ ไม่โดนข้าม (Skip) โดย `MIN NOTIONAL GUARD` อีกต่อไป
- **Trendline Resting Limit Sell Order & Dynamic Slope Tracking (`Sell TL Exit (Trendline)`)**:
  - เมื่อเส้นกด (Descending Trendline) กดลงมาต่ำจนไม่มี Grid Sell Target ใดๆ (Target 1–4) อยู่ต่ำกว่าเส้นกด (`levelsUnderTL.length === 0`):
    - แทนที่จะยกเลิกออเดอร์ทั้งหมดแล้วนั่งรอส่งคำสั่ง IOC ตอนราคาชนเส้นกด บอทจะวาง **Maker Limit Sell Order (`Sell TL Exit (Trendline)`)** ดักรอไว้ที่ราคาเส้นกดทันทีสำหรับ inventory ทั้งหมด (100% Exit)
    - **Front-Run Buffer (0.08% below TL)**: กำหนดราคาขายไว้ต่ำกว่าเส้นกดเล็กน้อยประมาณ `0.08%` (`tlPrice * (1 - 0.0008)`) เพื่อให้แมทช์ออกได้ง่ายและรวดเร็ว ก่อนที่ราคาจะชนเนื้อเส้นกดจริง
    - **Dynamic Slope Tracking**: เนื่องจากราคาเส้นกดขยับเปลี่ยนลงตามเวลา (ทุกแท่งเทียนหรือตามองศา Trendline) หากราคาเส้นกดเปลี่ยนไปเกิน tolerance (`> 0.1%`) บอทจะยกเลิกออเดอร์เดิมและส่งคำสั่งขายที่ราคาเส้นกดใหม่โดยอัตโนมัติ เพื่อให้คำสั่งขายเกาะติดเส้นกดอยู่เสมอ
    - **Robust Existing TL Order Re-linking & Duplicate Prevention**:
      - ใน `syncWalletAndReconcileOrders` และ `syncRestingOrders`: ปรับปรุงการค้นหาและผูกออเดอร์เดิมบน Binance ที่ตั้งค้างไว้ แม้จะถูกตั้งชื่อชั่วคราวว่า `SELL Order #...` ระบบจะ Re-link ให้เป็น `Sell TL Exit (Trendline)` ทันที เพื่อป้องกันไม่ให้บอทเข้าใจผิดว่ายังไม่มีออเดอร์ขายแล้วพยายามส่งคำสั่งซ้ำจนติด `[BALANCE GUARD]`
    - **IOC_BRACKET Mode Isolation (No Resting Order at TL)**:
      - ในโหมด **`IOC_BRACKET`**: บอทจะไม่วาง Resting Maker Limit Sell Order ดักรอที่ Trendline โดยเด็ดขาด
      - หากมีออเดอร์เก่าตกค้าง บอทจะสั่ง Cancel ทันที และจะรอให้ราคาตลาด (Bid) วิ่งขึ้นไปแตะหรือทะลุเส้นกดจริง จึงจะทำการยิงคำสั่ง **IOC Sell ทันที** (`sellAll` / `sellTrancheIOC`)
      - โหมด `MAKER_LIMIT` เท่านั้นที่จะวาง Maker Limit ดักรอใต้เส้นกดล่วงหน้า
    - **Grid Channel Meter UI Integration**: บน Dashboard ในแถบ Grid Channel Meter ด้านขวา เมื่อมีออเดอร์ตั้งขายที่ Trendline ระบบจะแสดงป้าย `📉 SELL TL` พร้อมแสดงราคาที่ตั้งขายจริงบนขั้นบันไดอย่างชัดเจน
    - หากราคาวิ่งเข้ามาประชิดหรือชนเส้นกดในระยะ IOC บอทจะยกเลิก Maker Sell และส่งคำสั่ง IOC ทันทีเพื่อความปลอดภัย
- **Strict Exchange Fill Verification for IOC / Exits (`executedQty` & `status` Guard)**:
  - แก้ไขปัญหาคำสั่งขายแบบ IOC ที่ส่งไปแล้วแต่ Orderbook ไม่มีสภาพคล่องรองรับ จน Binance ยกเลิกคำสั่งทันที (`EXPIRED / CANCELED` หรือ `executedQty = 0`) แต่ระบบ Strategy ดันเรียก `closeLots()` และแจ้งเตือนบน UI ว่าขายสำเร็จแล้ว
  - เพิ่มการตรวจสอบ `res.executedQty` และ `res.status` ใน `sellAll()`, `sellTrancheIOC()`, และ `buyTrancheIOC()` อย่างเข้มงวด: หากออเดอร์ไม่ถูกจับคู่จริง (`executedQty <= 0`) บอทจะไม่ตัด Lot ออกจากความจำ และไม่บันทึก Trade Fill หลอกบนหน้าจอแดชบอร์ดอย่างเด็ดขาด
- **IOC Bracket Sell Cycle State Machine (Elimination of Cascading IOC Dumps at Single Target)**:
  - **สาเหตุของปัญหาเดิม**: ในโหมด `IOC_BRACKET` เมื่อราคาตลาด Bid แตะถึง Sell Target 1 บอทจะคำนวณจำนวนไม้ `numSellTranches` จากยอดคงเหลือ ณ เวลานั้นเสมอ (เช่น ถือ $18 -> 3 ไม้ ไม้ละ $6) เมื่อยิงขาย Step 1/3 สำเร็จ เหลือ $12 บอทนำ $12 มาคำนวณใหม่กลายเป็น 2 ไม้ ไม้ละ $6 และมองว่า Step 1/2 ยังไม่ได้ขาย จึงยิงขายอีกไม้ และวนลูปจนกลายเป็น 1 ไม้ (Exit 100%) เทขายหมดเกลี้ยง 3 ไม้รวดใน 20 วินาที ทั้งที่ราคาตลาดอยู่ที่ Sell Target 1 เดิม ไม่ได้ขึ้นไปแตะ Sell Target 2 หรือ 3 เลย
  - **การแก้ไข**:
    1. เพิ่ม `iocBracketSellCycle` State Machine เพื่อจำรอบการขาย บันทึก `baselineHeldQty`, `baselineHeldQuote`, `numSellTranches` และ `soldStepNums (Set)` ประจำรอบ
    2. **Single-Execution per Step & Strictly Ladder Up**: บอทจะขายเฉพาะไม้ของ Step ที่ราคาวิ่งไปถึงจริง (`currentBestBid >= sellLevels[step.levelIndex]`) และต้องเป็นไม้ที่ยังไม่เคยขายในรอบนั้น (`!soldStepNums.has(step.stepNum)`)
    3. **Reset Cycle on Buy Fills & Flat Position**: เมื่อมีคำสั่งซื้อใหม่สำเร็จ (`processBuyFill`) หรือพอร์ตถูกปิดจนเกลี้ยง (`closeLots` หรือ `sellAll`) ระบบจะ Reset `iocBracketSellCycle = undefined` ทันทีเพื่อให้รอบการสะสมใหม่สามารถคำนวณ ladder ขายชุดใหม่ได้อย่างสมบูรณ์ 100%
- **Dynamic Sell Tranche Allocation & CEX Rebalancing (Equal Sell Sizes & Zero Dump)**:
  - **Eligible Level Counting (`numEligibleLevels`)**: คำนวณจำนวนระดับที่อยู่เหนือราคาตลาดและพร้อมวางขายจริง (`lvl > minAllowedSellPrice`) และแบ่งขนาดไม้เฉลี่ยเท่ากันเป๊ะ (`trancheQty = held / numEligibleLevels`) แทนการหาร 4 แบบคงที่ ซึ่งเคยทำให้เกิดเศษค้างเมื่อราคาผ่าน Sell Target 1 ไปแล้ว
  - **Zero Final Level Dump & Anti-Hoarding**: ไม้สุดท้าย (Exit All) จะรับเฉพาะส่วนต่างเศษทศนิยมระดับ Satoshis/Wei เล็กๆ เท่านั้น (`Math.max(trancheQty, held - (trancheQty * (numEligible - 1)))`) ไม่ดูด Inventory ก้อนใหญ่ที่ยังไม่ได้ตั้งของไม้อื่นมากองไว้ที่ Sell Target 4 จนขนาดไม้เบิ้ล 2 เท่าอีกต่อไป
  - **Missing Eligible Level Enforcement (`hasMissingEligibleSellOrders`)**: หากตรวจพบว่ายังมีระดับขายที่ยังไม่ได้วางออเดอร์ (เช่น Sell Target 3 ว่างอยู่) ระบบจะ **ไม่ถือว่า `isInventoryFullyCovered`** และสั่ง Rebalance ลดขนาดไม้ที่เบิ้ลเพื่อนำยอดมาวางออเดอร์ให้ระดับที่ขาดหายไปทันที ทำให้มีคำสั่งขายกระจายครบทุกระดับอย่างสม่ำเสมอ 100%
  - **Auto Rebalancing on CEX / BUY Fills**: เมื่อมี BUY แมตช์ (`needsSellRebalance = true`) หรือบน CEX (Binance) หากตรวจพบว่าขนาดออเดอร์ขายแต่ละไม้เบี่ยงเบนไปจากไม้เฉลี่ยเกิน 10% บอทจะทำการยกเลิกและตั้งออเดอร์ขายใหม่ให้ทุกไม้มีขนาดเท่ากันสม่ำเสมอทันที โดยไม่มีค่า Gas หรือ Fee บน Maker orders
- **Holding Fraction Guard (Elimination of Repeated Buy Level 1 Fills)**:
  - In a stepped accumulation grid ladder, each buy level represents a target capacity threshold (Level 1 $\le 25\%$, Level 2 $\le 50\%$, Level 3 $\le 75\%$, Level 4 $\le 100\%$).
  - When a buy order fills and current portfolio inventory already satisfies or exceeds that level's target fraction (`currentHoldFraction >= levelTargetFraction - 0.05`), the bot **strictly forbids re-placing a new buy order at that same level** while holding that position.
  - This completely eliminates repeated buy fills at Buy Level 1 (e.g. 3 consecutive fills at \$2562.45), forcing accumulation to take place only at deeper buy levels or waiting until inventory is sold.
- **Narrow Channel Adaptation & Bounds Hysteresis Fix (< 1.20%)**:
  - **สาเหตุของปัญหาเดิม**: ใน `market-structure.ts` เมื่อกรอบราคาแคบกว่า `< 1.20%` ระบบจะบีบกรอบเป็น Edge Bracket (ซื้อ 1 ระดับที่ `Floor + 0.2%` และขาย 1 ระดับที่ `Ceiling - 0.2%`) แต่ใน `src/strategy.ts` ตรงส่วน Channel Hysteresis มีเงื่อนไข Fallback บังคับว่า `if (!Array.isArray(this.lastDynamicBounds.buyLevels) || this.lastDynamicBounds.buyLevels.length < 4)` ทำให้เมื่อราคายังเคลื่อนไหวอยู่ในกรอบเดิม ระบบ Hysteresis จะเขียนทับ `buyLevels` ของ Narrow Channel กลับไปเป็น 4 ระดับอัตโนมัติ ส่งผลให้บอทตั้งออเดอร์ซื้อ 4 ไม้ และแสดงผล 4 ระดับ ทั้งๆ ที่กรอบแคบเพียง 1.18%
  - **การแก้ไข**:
    1. ใน `src/strategy.ts` เมธอด `step()`: ปรับตรรกะ Hysteresis ให้ตรวจสอบ `isNarrowChannel = ((dSpan / lowerBound) * 100) < 1.20` หากเป็นกรอบแคบจะคงค่า 1 ระดับ (`lowerBound * 1.002` และ `upperBound * 0.998`) โดยไม่บังคับ `length < 4`
    2. มีระบบ Transition ตรวจจับการสลับระหว่างกรอบปกติและกรอบแคบอัตโนมัติ หากกรอบย่อตัวลงมาแคบกว่า 1.20% ระบบจะปรับ `lastDynamicBounds` ให้เหลือ 1 ระดับ และหากกรอบขยายตัวกว้างขึ้นเกิน 1.20% จะคืนค่าเป็น 4 ระดับแบบขั้นบันไดทันที
    3. ปรับ `LOCKED CHANNEL ENTRY SHIELD` ให้รองรับ Narrow Channel เช่นเดียวกัน ป้องกันการสร้าง 4 ระดับเกินจริงขณะล็อคกรอบ
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
    - *Structural Swing Stability & Zero Tick Oscillation (Pure Confirmed Swing Anchoring)*:
      - **สาเหตุของปัญหาเดิม**: ใน `findMultiTouchSR` เดิมมีการใช้ `currentPrice` กรองแนวรับแนวต้านว่า "broken" (`isResistanceBroken` / `isSupportBroken`), สลับเป้าหมาย `nearestMultiTouch` ตามราคา Real-time ทุก Tick, และมีบทลงโทษ `enclosesPrice (-2000)` ทำให้เมื่อราคาในแท่งเทียนแกว่งขึ้นลงเพียงเล็กน้อย กรอบจะกระตุกเปลี่ยนคู่ยอด/เหวไปมา
      - **การแก้ไข**: ยกเลิกการตัดแนวรับแนวต้านด้วยราคาแลบของแท่งเทียน และยกเลิกการใช้ราคา Tick ในการคิดคะแนนคู่กรอบทั้งหมด โดยให้ยึดมั่นกับ **จุดเหว (Confirmed Valley / HL)** และ **จุดยอด (Confirmed Peak / LH / HH)** ที่ยืนยันโครงสร้าง Dow Theory อย่างมั่นคง 100% ตราบใดที่ยังไม่เกิดเหวใหม่หรือยอดใหม่ที่ได้รับการยืนยัน กรอบ Channel จะอยู่นิ่งสนิท ไม่ดิ้นตามราคา Tick ในแท่งเทียนอีกต่อไป
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
  - **Trade & Lot Manager Real-Time Front Page Sync & PnL State Persistence**:
    - Whenever a trade or lot is deleted, cancelled, edited, or added via Trade Manager:
      - Helper `removeActivityItem(id)` immediately removes matching `.activity-item` elements across all feed DOMs (`elTradesFeed`, `elOnchainFeed`, `elAllFeed`) using `data-order-id`, `data-clob-id`, and `data-txhash` attributes, and decrements feed count badges.
      - Helper `refreshFrontPageState()` fetches `/api/state` and invokes `updateTick(data.latestTick)` to immediately refresh inventory KPIs (`#lotsCount`, `#topPosBase`, `#topPosUsd`, `#posUnrealizedPnl`) on the front page.
      - Server endpoint `/api/db/trades/delete` automatically filters out deleted orders from `this.recentOrders` to prevent resurrected orders on page refresh, and broadcasts `trade_deleted` / `lots_updated` via SSE to trigger `removeActivityItem` and `refreshFrontPageState` across all connected tabs.
    - **Manual Trade Realized PnL & Activity Feed Sync (`addManualTrade`)**:
      - เมื่อผู้ใช้เพิ่มรายการ Trade ผ่าน Trade Manager (`POST /api/db/trades/add`):
        - ใน `src/db.ts`: สะสมกำไร/ขาดทุนเข้า `state.tradeRealizedPnl` และ `state.realizedPnl` ใน DB ทันทีเมื่อเป็น SELL ที่ FILLED พร้อมทั้งตัดลด Lots ใน `state.lots` แบบ FIFO
        - ใน `src/server.ts`: เรียก `this.addOrder(result.order)` เพื่อเพิ่มเข้า `recentOrders` ทันที และสั่ง `this.opts.onReloadState?.()` เพื่อซิงค์ State เข้า Strategy และกระจาย Telemetry Tick อัปเดต NET REALIZED บนหัวเว็บแบบ Real-time
        - ใน `public/app.js`: เมื่อเกิด `trade_added` หรือกดเพิ่มสำเร็จ จะเรียก `addOrderActivity(order, false)` เพื่อนำรายการไปแสดงในกล่อง Trade Matches Feed (`#tradesFeed`) และ Combined All Feed (`#allFeed`) พร้อมปักหมุดบนกราฟทันที โดยมีระบบ Guard ป้องกันการ Render ซ้ำด้วย `data-order-id` / `data-clob-id` / `data-txhash`
      - เมื่อผู้ใช้แก้ไขหรือลบ Trade ผ่าน Trade Manager (`updateTrade` / `deleteTrade`):
        - คำนวณ Delta PnL ปรับยอด `tradeRealizedPnl` และ `realizedPnl` ใน State อัตโนมัติ พร้อมทั้งอัปเดต/ลบรายการใน DOM Activity Feed ทันที
      - **Automatic Historical Manual Trades Reconcile & `statesBySymbol` Isolation Fix (`reconcileManualTradesPnl`)**:
        - แก้ปัญหา `statesBySymbol` แยกตามเหรียญ (เช่น `SOMI:USDSO`) เขียนทับ State รวม: ฟังก์ชัน `adjustStatePnl` จะอัปเดตยอด `tradeRealizedPnl` และ `realizedPnl` ให้ทั้งใน `state` กลาง และทุกคู่เหรียญใน `statesBySymbol` พร้อมกัน 100% ป้องกัน `getState(symbolKey)` คืนค่าเก่า
        - เพิ่มระบบ `appliedManualTradeIds`: ตรวจสอบและดึงรายการ Manual Sell ในอดีตที่ยังไม่เคยถูกรวมยอดมาคำนวณบวกเพิ่มให้อัตโนมัติทันทีเมื่อเปิดบอทหรือเรียก Reconcile โดยไม่บวกซ้ำซ้อน
        - เพิ่ม API `POST /api/db/trades/reconcile-pnl` และปุ่ม `🔄 ซิงค์ Realized PnL` ในหน้าต่าง Trade Manager ให้กดซิงค์กำไรเข้าหัวเว็บได้ทันที
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
- **S/R Multi-Touch Active Cycle Restriction & Elimination of Ancient Out-of-Cycle Swings**:
  - **สาเหตุของปัญหาเดิม**:
    1. ใน `findMultiTouchSR` มี Lookback ย้อนหลังถึง 300 แท่ง (75 ชั่วโมง / > 3 วัน) ทำให้เหวโบราณในอดีต (เช่น `$2488.40` ที่เคยสะสม touchCount 3 ครั้ง) และยอดโบราณ (`$2538.68` ที่เคยสะสม touchCount 2-3 ครั้ง) ถูกนำมาเป็น candidate
    2. คลื่นปัจจุบันแคบกว่าค่า `minSpanPct` (เช่น คลื่นปัจจุบันมี LL อยู่ที่ `$2503.28` และ HH อยู่ที่ `$2528.96` คิดเป็นความกว้างเพียง 1.02% ซึ่งน้อยกว่า `minSpanPct` 2.0%)
    3. ส่งผลให้ระบบให้คะแนนคู่โบราณ `$2538.68 / $2488.40` ที่มีความกว้าง 2.02% และมี Touch bonus สูงกว่า ชนะคลื่นปัจจุบัน และแสดงผลเส้นประ `Real Ceil: $2538.68` และ `Real Floor: $2488.40` ลอยอยู่ในอากาศโดยไม่มีจุด Swing High / Low ใดๆ บนหน้าจอให้เห็น
  - **การแก้ไข** (`src/market-structure.ts`):
    1. **Active Cycle Boundaries (`cycleLowMin` & `cycleHighMax`)**: ใน `findMultiTouchSR` กำหนดขอบเขตจากรอบคลื่นปัจจุบัน (`activeWaveLow` / `recentCanonicalLows` และ `activeWaveHigh` / `recentCanonicalHighs`) โดย candidate แนวรับต้องไม่ต่ำกว่าจุดต่ำสุดของคลื่นปัจจุบัน (`c.price >= cycleLowMin * 0.999`) และ candidate แนวต้านต้องไม่ลอยสูงกว่ายอดของคลื่นปัจจุบัน (`c.price <= cycleHighMax * 1.002`)
    2. **Strict Candidate Pool Filtering**: กรอง `peakPoints`, `valleyPoints`, `resCandidates`, `supCandidates` ทั้งหมดให้ถูกจำกัดอยู่ในกรอบรอบคลื่นปัจจุบัน ป้องกันไม่ให้จุด Swing โบราณจาก 3 วันที่แล้วหลุดเข้ามาแย่งกรอบ
    3. **Active Cycle Extremes Preservation (No `slice(-4)` Major Peak/Valley Truncation)**:
       - **ปัญหาเดิม**: การใช้ `slice(-4)` ทำให้เมื่อมีคลื่นย่อยเกิดขึ้นเกิน 4 ครั้ง ยอดหลัก **HH บนสุด** จะหลุดหายไปจากตัวเลือก และระบบไปคว้ายอด Lower High เตี้ยๆ ในคลื่นย่อย ($2518.06) และเหวย่อย ($2504.83) ทำให้กรอบหดแคบเหลือเพียง 0.53%
       - **การแก้ไข**: ขอบเขตของรอบคลื่นปัจจุบัน (`activeCycleHighs` และ `activeCycleLows`) จะถูกนิยามครอบคลุมตั้งแต่ `macroPeak` เป็นต้นมาอย่างสมบูรณ์ ทำให้ `activePeak` และ `cycleHighMax` ล็อคยอดสูงสุดของรอบคลื่น (**Major HH $2524.59 / $2528.96**) และ `activeValley` และ `cycleLowMin` ล็อคเหวต่ำสุดของรอบคลื่น (**Major LL $2501.75**) เสมอ ไม่ถูกยอดเตี้ยของสวิงย่อยบีบกรอบอีกต่อไป
- **DOW_SWINGS Mode: Progressive Nearest-Swing Expansion & Absolute Min-Width Guarantee**:
  - **ความต้องการ & หลักการของผู้ใช้**:
    - "ไม่ต้องยึด major swing ขนาดนั้น ให้ยึดจากราคาปัจจุบัน และ เหว ยอดที่อยู่ใกล้ๆ ให้ได้ความกว้างอย่างต่ำที่ min chan ไม่ได้ก็ขยับไปเรื่อยๆ"
    - "เอา multitouch ออกไปเลย"
  - **ปัญหาเดิม**:
    1. ตัวเลือกหน้า UI (`index.html`) และ default config ยังคงเป็น `MULTI_TOUCH_SR` พร้อมช่องกรอก *S/R Min Touches*
    2. ในลูปขยายสวิง เมื่อประวัติสวิงใกล้ราคาหมดลิสต์ในอาร์เรย์ (`hIdx + 1` และ `lIdx + 1` สุดทาง) ลูปจะหยุด และไม่มีกลไกเติมส่วนต่าง (Shortfall Buffer) ทำให้กรอบติดอยู่ที่ระยะ $9.41 (0.38%) โดยเพิกเฉยต่อ `minChannelWidthPct` (2.0% - 3.0%)
  - **การแก้ไข**:
    1. **Elimination of Multi-Touch S/R**:
       - เปลี่ยนค่าเริ่มต้น `channelMode` ใน `src/config.ts` เป็น `"DOW_SWINGS"`
       - อัปเดต `public/index.html` ให้ `DOW_SWINGS` เป็นตัวเลือกหลักใน Dropdown และซ่อนช่องกรอก S/R Min Touches / Tolerance
       - ใน `src/market-structure.ts`: ไม่เรียก `findMultiTouchSR` ในโหมด `DOW_SWINGS`
    2. **Progressive Nearest-Swing Expansion**:
       - รวม Swing Highs เหนือราคาปัจจุบัน (`this.swingHighs` + `canonicalHighs`) เรียงจากน้อยไปมาก (ใกล้ราคาขึ้นไป)
       - รวม Swing Lows ใต้ราคาปัจจุบัน (`this.swingLows` + `canonicalLows`) เรียงจากมากไปน้อย (ใกล้ราคาลงไป)
       - เริ่มต้นจากคู่สวิงที่ใกล้ราคาปัจจุบันที่สุด แล้วค่อยๆ สเต็ปขยายออกไปหายอด/เหวถัดไปทีละขั้นจนกว่า `upperBound - bottomBound >= minSpanFromPct`
    3. **Absolute Minimum Channel Width Guarantee (`minSpan`)**:
       - หากตรวจสวิงจนสุดประวัติแล้วระยะห่างยังไม่ถึง `minSpanFromPct` (เช่น กราฟไซด์เวย์นิ่งสนิท) หรือหลังการปรับปรุงสวิงใดๆ ความกว้างยังต่ำกว่า `minSpan`:
       - ระบบจะคำนวณ `shortfall = minSpan - (upperBound - bottomBound)` และขยายกรอบบนขึ้น `+ shortfall / 2` และกรอบล่างลง `- shortfall / 2` แบบสมดุลทันที การันตีว่าความกว้างจะไม่มีทางแคบกว่า `minChannelWidthPct` (เช่น 2.0% หรือ 3.0%) 100%
- **Active Wave Swings & Elimination of Major Peak Override (`DOW_SWINGS`)**:
  - **ความต้องการ & หลักการของผู้ใช้**:
    - "อย่าไปเลือก major peak เลย ให้พิจารณาจากราคาปัจจุบันแล้วปรับไปตามกรอบดีกว่า อิงความกว้างตาม min chan ด้วย เพราะพอทำ LH ในคลื่นปัจจุบันก็เป็นแนวต้านละ"
  - **ปัญหาเดิม**:
    1. ใน `src/market-structure.ts` เมธอดคำนวณกรอบมีตรรกะ `recentMajorHigh` และ `macroPeak` ที่ค้นหายอดสูงสุดตลอดกาลในอดีต (เช่น ยอดเก่า $0.2093) แล้วนำมาเขียนทับ `activePeak` / `activeCeilingPoint` เสมอ
    2. ทำให้เมื่อราคาในคลื่นปัจจุบันเกิดยอด **Lower High (LH)** หรือยอดสวิงรอบใหม่ กรอบบน (Ceiling) ไม่ยอมลดลงมาเกาะที่ยอดสวิงแนวต้านปัจจุบัน แต่ยังถูกดึงไปล็อคค้างอยู่ที่ Major Peak โบราณ ทำให้ระยะกรอบกว้างเกินจริงและกึ่งกลาง 50% Center ลอยสูงเกินไป
    3. หากความกว้างแคบกว่า `minSpanFromPct` มี fallback กระโดดไปดึง `macroPeak` กลับมาอีกครั้ง
  - **การแก้ไข**:
    1. **Elimination of Major Peak Override**:
       - ตัดตัวแปร `recentMajorHigh` และการ override ด้วย `macroPeak` ออกทั้งหมด
       - กำหนดให้ `activeCeilingPoint = activePeak` โดยตรง ยึดสวิงยอดล่าสุดในคลื่นปัจจุบัน (Confirmed LH หรือ HH) ที่ราคาเทรดอยู่ใต้หรือใกล้เคียง เป็นแนวต้านตาม Dow Theory ทันที
    2. **Min Channel Width Guarantee with Resistance Preservation**:
       - ขยายกรอบตามสวิงหรือเติมเต็มระยะห่างให้ได้อย่างน้อยเท่ากับ `minChannelWidthPct` (`minSpanFromPct`)
       - จัดลำดับความสำคัญให้ขยายขอบล่าง (Floor) ก่อน เพื่อรักษายอด LH ปัจจุบันให้ทำหน้าที่เป็นแนวต้าน (Ceiling) ไว้ได้อย่างสมบูรณ์
    3. **Price Enclosure**:
       - การันตีว่ากรอบต้องครอบคลุมราคาปัจจุบันเสมอ (`Floor <= Price <= Ceiling`) หากราคาเบรคทะลุกรอบบนหรือล่าง กรอบจะปรับรับราคาทันที
- **DreamDEX Level Buy via DEX Ask Orderbook Trigger**:
  - **ความต้องการ & หลักการของผู้ใช้**:
    - "สำหรับ dreamdex level buy สามารถดูได้จาก ask ถ้าอยู่ในระดับเดียวหรือต่ำกว่า ก็สามารถเข้าซื้อได้นะ ไม่ต้องรอ trigger จาก ราคาแท่งเทียนอย่างเดียว"
  - **ปัญหาเดิม**:
    1. ใน `executeIocBracketGrid` มีเงื่อนไขผูกติดแบบ AND: `currentBestAsk <= lvlPrice && refPrice <= lvlPrice * 1.001`
    2. ทำให้เมื่อมีคนตั้งขาย (Ask) บน DreamDEX ในระดับราคาเท่ากับหรือถูกกว่า Buy Level (`currentBestAsk <= lvlPrice`) แต่ราคาแท่งเทียน Binance (`refPrice`) ยังไม่ย่อลงมา บอทจะปฏิเสธการเข้าซื้อเพราะติดรอราคาแท่งเทียน
    3. ในโหมด `syncRestingOrders` มีการจำกัด `maxAllowedBuyPrice = Math.min(currentBestBid, refPrice)` ทำให้ไม่ส่งคำสั่งเข้าจับคู่กับ Ask ที่มีอยู่
  - **การแก้ไข**:
    1. **Direct DEX Ask Buy Trigger**:
       - สำหรับ DreamDEX (`!isCexExchange`): ปรับเงื่อนไข `isLevelTriggered` ให้เข้าซื้อได้ทันทีหาก `currentBestAsk <= lvlPrice` (DEX Ask อยู่ในระดับเดียวหรือต่ำกว่า Buy Level) โดยไม่ต้องรอราคาแท่งเทียน Binance
       - หรือถ้าราคาแท่งเทียนย่อลงมาแตะระดับ (`refPrice <= lvlPrice * 1.001`) และ Ask บน DEX อยู่ในกรอบที่รับได้ ก็เข้าซื้อได้เช่นเดียวกัน
    2. **Immediate IOC Fill in Maker Mode**:
       - ใน `syncRestingOrders`: หากพบว่า `currentBestAsk <= lvlPrice` ให้ใช้ `buyTrancheIOC` ส่งคำสั่งซื้อจับคู่กับสภาพคล่องฝั่ง Ask ทันที ไม่ปล่อยโอกาสหลุดมือ
    3. **Hysteresis & Buy Zone Sensitivity**:
       - นำ `currentBestAsk` มาร่วมพิจารณาใน hysteresis (`isDexAskInAccumulationZone`) และ `buyTrigger` เพื่อป้องกันการปิดกั้นสัญญาณซื้อขณะที่ Ask บน DEX กำลังอยู่ในโซนซื้อ
- **Top KPI Dashboard 3-Card Redesign: Merged Wallet & Position + Exchange Orderbook (Bid / Ask)**:
  - **ความต้องการ & หลักการของผู้ใช้**:
    - "เอา next trigger ออกแล้วแสดง ask bid บน ex แทนได้หรือไม่"
    - "ให้ยุบรวม wallet balance กับ position ให้รวมกันได้ไหม ออกแบบให้ดูสรุปหน่อย"
  - **การปรับปรุงหน้าจอ Dashboard**:
    1. **การ์ดที่ 1: `WALLET & POSITION` (ยุบรวม Spot Wallet + Position)**:
       - ซีกซ้าย (Wallet Assets): แสดงยอดคงเหลือเหรียญ Base ในกระเป๋า (เช่น SOMI), ยอด Quote (USDso) และมูลค่ารวมพอร์ตจริง
       - ซีกขวา (Bot Position): แสดงยอดเหรียญที่บอทถือครองในระบบ, ยอดทุนปัจจุบันเทียบกับ Max Inventory Capacity, และแถบ Mini Progress Bar แสดง % Load
       - หัวการ์ดแสดง Address Badge, Position %, และ % Load สรุปครบถ้วนในช่องเดียว
    2. **การ์ดที่ 2: `PROFIT & LOSS (PNL)`**:
       - แสดงผล Unrealized PnL (พร้อม Avg Entry) และ Net Realized PnL (พร้อม Trade/Fee breakdown)
    3. **การ์ดที่ 3: `EXCHANGE ORDERBOOK (BID / ASK)` (แทนที่ Next Triggers)**:
       - หัวการ์ดแสดงป้าย `EXCHANGE ORDERBOOK` พร้อม Badge คำนวณ `Spread: X.XX%` ระหว่าง Best Bid กับ Best Ask แบบ Real-time
       - ซีกซ้าย: แสดงราคา **Best Bid (🟢)** บนกระดานเทรดจริง พร้อมระยะห่างเทียบกับ Mid Price
       - ซีกขวา: แสดงราคา **Best Ask (🔴)** บนกระดานเทรดจริง พร้อมระยะห่างเทียบกับ Mid Price
    4. **Layout**: ปรับ Grid สรุปผลด้านบนเป็น 3 คอลัมน์ที่กว้างและอ่านค่าง่าย (`grid-template-columns: 1.25fr 1fr 1fr`)
- **Live Production Audit Logic Improvements (Items #1, #2, #3, #4, #5, #6, #7)**:
  1. **API Key Masking (`binanceApiKey` Protection)**:
     - ใน `src/strategy.ts`, `src/index.ts`, และ `src/server.ts`: ทำการ Mask ค่า `binanceApiKey` เป็น `"******"` เสมอเมื่อส่งออกผ่าน `/api/db/settings` หรือ `/api/config` (เช่นเดียวกับ `binanceApiSecret` และ `dreamdexPrivateKey`) และป้องกันไม่ให้ค่า `"******"` เขียนทับคีย์จริงในฐานข้อมูลเมื่อกด Save Settings
  2. **Upper Bound 100% Take Profit Minimum Profit (>= 0.50%) & DEX Bid Discount Guard**:
     - ใน `src/strategy.ts`: บังคับให้การสั่งขาย 100% Take Profit ที่ขอบบนต้องมีกำไรสุทธิอย่างน้อย `>= 0.50%` เหนือ `avgEntryPrice` เสมอ (คำนวณจาก `bestBid` จริงบนกระดาน DEX ไม่ว่าจะตั้ง `sellProfitMode` เป็นโหมดใด)
     - เพิ่มการตรวจสอบ `tpBidDiscountPct <= cutLossMaxBidDiscountPct` เทียบกับราคา Binance เพื่อป้องกันการโยนขายใส่ Bid บน DEX ที่ยังขยับตามราคา CEX ไม่ทัน
     - ตรวจสอบ `highestActiveSellTarget` เฉพาะระดับ Sell Target ที่เปิดใช้งานจริง (`enabledSellTargets`) เท่านั้น
  3. **Post-Cut Loss Cooldown (15m) & 1-Tranche Incremental DCA Re-Entry Guard**:
     - ใน `src/strategy.ts` & `src/db.ts`: บันทึก `lastCutLossTime` และ `postCutSingleTrancheOnly = true` ลงใน State ทันทีที่เกิด Cut Loss
     - บังคับ Cooldown 15 นาที (1 แท่งเทียน 15m) หลัง Cut Loss ก่อนอนุญาตให้ปลดล็อก `waitingForHigherLow` เพื่อป้องกันอาการ Whipsaw ขายก้นเหวแล้วเด้งกลับไปซื้อแพงกว่าเดิมทันที
     - เมื่อกลับเข้าซื้อไม้แรกหลัง Cut Loss (`postCutSingleTrancheOnly`) ระบบจะจำกัดวงเงินซื้อไม่เกิน 1 ไม้ (`baseTrancheQuote`) ห้ามรวบซื้อ 4 ไม้รวด (`IOC Buy L1-L4 (4x)`) ในคำสั่งเดียว
  4. **Persistent IOC Bracket Sell Ladder Cycle (`iocBracketSellCycle`)**:
     - ใน `src/strategy.ts` & `src/db.ts`: บันทึกสถานะ `iocBracketSellCycle` (`baselineHeldQuote`, `baselineHeldQty`, `numSellTranches`, `soldStepNums`) ลงในฐานข้อมูล (`StrategyStateRecord`) และโหลดกลับมาเมื่อบอทรีสตาร์ท ป้องกันปัญหาการขายซ้ำ `Step 1/4` หลายรอบจาก State Reset กลางคัน
  5. **Per-Symbol Trade Rounds Isolation, Cross-Symbol PnL Self-Healing, Stale Open Orders Cleanup & IOC Gas Logging**:
     - ใน `src/trade-rounds.ts` & `src/db.ts`: แยกการคำนวณ `calculateTradeRounds` และ `backfillMissingSellPnl` ตามเหรียญ (`symbol` / `baseAsset` หรือช่วงราคา) ป้องกันไม่ให้ประวัติเทรด `WETH` (~$2,556) ไปปนกับต้นทุนของ `SOMI` (~$0.20) จนทำให้ Summary PnL เพี้ยน (-$45.67) พร้อมระบบซ่อมแซมค่า PnL ที่เพี้ยนโดยอัตโนมัติ
     - เพิ่ม `cleanupStaleOpenOrders()` ตอนเปิดบอท และ `reconcileOpenOrdersWithExchange()` ตอนซิงค์กับกระดาน เพื่อล้างรายการ `OPEN` ที่ค้างอยู่ใน DB (Ghost Orders) ให้เป็น `CANCELLED` ตามสถานะจริง
     - ปรับปรุง `updateTxGas` (พร้อม `pendingTxGas` cache แก้ปัญหา race condition ที่ `onGasSpent` ทำงานก่อน `recordEvent`) และ `getGasLogs` ให้รองรับธุรกรรมแบบ IOC (`fillTxHash` / `txHash`) และนับ `totalTxCount` ให้ตรงกับจำนวนธุรกรรม On-Chain จริง
  6. **Accurate Dow Theory HL / LL Swing Labeling**:
     - ใน `src/market-structure.ts`: แก้ไขการตรวจสอบ `priorLowsInDownwave` ให้อ้างอิงเฉพาะจุดสวิงที่ยืนยันแล้ว (`annotatedSwings`) แทนการใช้ `this.swingLows` ดิบทั้งหมด ป้องกันไม่ให้จุดยกฐาน (Higher Low จริง เช่น $0.2042 > $0.2026) ถูกติดป้ายผิดเป็น `LL หลุดฐาน`
  7. **Structural 2+ Pivot Trendline Engine & Uptrend Support Line 1-Tranche Pullback Entry (Item #3)**:
     - ใน `src/market-structure.ts` (`calculateTrendlines`): อัปเกรดอัลกอริทึมการตีเส้น Trendline ทั้งขาลง (`DESCENDING`) และขาขึ้น (`ASCENDING`) ให้ลากเชื่อมจาก **2+ Confirmed Swing Pivots** (`P1 -> P2` หรือ `V1 -> V2`) พร้อมระบบให้คะแนนความแม่นยำจากจำนวนจุดสวิงที่อยู่ในระนาบ (`alignedSwings`) และจำนวนแท่งเทียน/ไส้เทียนที่ลงมาแตะทดสอบเส้น (`candleTouches`), ตรวจสอบ Outer Envelope ไม่ให้แท่งเทียนระหว่างจุดตัดทะลุเส้นเกิน `0.25%` และจำกัดความชันที่เหมาะสม (`0.015%/hr` ถึง `2.5%/hr`) เพื่อให้ตีเส้นเทรนด์ไลน์ตามโครงสร้างตลาดจริงบน TF 15m ได้อย่างแม่นยำและแสดงผลบนกราฟทันที
     - ใน `src/strategy.ts`: ปลดล็อก **Uptrend Support Line Entry (`enableBuyAboveTrendSupport`)** ทั้งในโหมด `IOC_BRACKET` และ `MAKER_LIMIT` ให้สามารถเข้าซื้อสะสม **1 ไม้ (`targetTranches = 1`)** เมื่อราคาย่อตัวลงมาแตะเส้นรับขาขึ้น (`uptrendLine`) ที่อยู่สูงกว่า Buy Level ที่เปิดใช้งานและอยู่ต่ำกว่า `Sell Target 1` ได้ทันที แม้ว่าผู้ใช้จะปิด `Buy Level 1` และ `Buy Level 2` ไว้ก็ตาม (และหากราคาหลุดเส้นรับขาลงไป ระบบจะถอยกลับไปรอรับที่ `Buy Level 3` และ `Buy Level 4` ตามปกติ)
  8. **Dynamic Binance Spot Pairs Fetching & Free Custom Pair Entry (FDUSD / USDT / USDC)**:
     - ใน `src/server.ts` (`/api/symbols`): อัปเกรดให้ดึงคู่เทรด Spot ทั้งหมดจาก Binance REST API (`/api/v3/exchangeInfo`) แบบ Real-time พร้อม In-Memory Cache (1 ชั่วโมง) แยกกลุ่มเป็น `fdusd` (คู่ FDUSD ทั้งหมด 32+ คู่สำหรับรับสิทธิ์ 0% Maker Fee), `popular` (คู่ยอดนิยม), `usdt` (คู่ USDT ทั้งหมด) และ `usdc` แทนการ Hardcode รายการคู่เหรียญแบบเดิม
     - ใน `public/app.js` & `public/index.html`:
       - จัดกลุ่มตัวเลือกใน Dropdown ด้วย `<optgroup>` แยกชัดเจน (`🆓 FDUSD Pairs (0% Maker Fee)`, `⭐ Popular USDT Pairs`, `💵 Other USDT Pairs`, `🪙 USDC Pairs`)
       - เพิ่มตัวเลือก `➕ Custom Pair (พิมพ์คู่เหรียญเอง)...` ใน Dropdown บน Navigation Bar เพื่อให้ผู้ใช้สามารถกรอกชื่อคู่เหรียญใดๆ บน Binance (เช่น `BTCFDUSD`, `SOLFDUSD`, `DOGEFDUSD`) แล้วสลับเทรดได้ทันที
       - เพิ่มปุ่ม `✏️ Custom` สลับระหว่าง Dropdown กับช่องกรอก Text Input ใน Settings Modal เพื่อความยืดหยุ่นในการตั้งค่าคู่เหรียญตามใจชอบ
  9. **Zero-Discount Trendline Sell & Tightened DEX Bid Gap Guard (0% Haircut)**:
     - ใน `src/strategy.ts` (`sellAll`): ยกเลิกการหักส่วนลด Slippage buffer 0.50% ใต้ Best Bid สำหรับคำสั่งขายทำกำไร (`action === "SELL"`) โดยปรับเป็น **`limitPrice = price` (0% Discount)** ขายที่ราคาเต็ม Best Bid หรือราคาเป้าหมายโดยตรง ป้องกันการเสียกำไร 0.5% โดยไม่จำเป็น
     - ใน `src/strategy.ts` (Block 2a - Trendline IOC Sell): ปรับลดเกณฑ์ยอมรับช่องว่างระหว่างราคาเส้นกดเทรนด์ไลน์กับ Best Bid บนกระดานจากเดิม `1.5%` ลงเหลือ **`0.35%`** สูงสุด เพื่อป้องกันไม่ให้บอทโยนขายใส่ Bid ที่ถ่างต่ำกว่าราคาตลาด และเข้าสู่สถานะ Standby รอรอบิดบน DEX ขยับตามราคาจริงเสมอ
   10. **Real-Time Trade Matches Feed & Scoped Duplicate Guard (Zero F5 Refresh Required)**:
      - **สาเหตุของปัญหา**: เดิมใน `public/app.js` ฟังก์ชัน `addOrderActivity` มี Duplicate Guard ระดับทั้งหน้า (`document.querySelector`) ซึ่งเมื่อคำสั่ง Maker Limit Sell ถูกวาง จะสร้าง Element `CREATE_SELL` พร้อม `data-clob-id="orderId"` ในแท็บ All Feed ไว้ก่อน เมื่อคำสั่งนั้นแมตช์สำเร็จในตลาดจริง (`SELL_FILL`) ระบบส่งอีเวนต์เข้ามาด้วย `orderId` เดิม ทำให้ Guard ตัวนี้ตรวจพบ `CREATE_SELL` และสั่ง `return` ตัดจบทั้งฟังก์ชันทันที ส่งผลให้มาร์กเกอร์สีแดง `S` บนกราฟขึ้น แต่แถว Trade Matches ไม่ถูกแทรก ต้องกด Refresh (F5) ถึงจะโผล่ขึ้นมา
      - **การแก้ไข**:
        - ใน `public/app.js`: ใส่ `data-action="${order.action}"` ในทุก Element และยกเลิก Guard ที่ตัดจบทั้งฟังก์ชัน เปลี่ยนเป็นการตรวจจับความซ้ำซ้อนแบบแยกตามคอนเทนเนอร์ (Container-scoped Duplicate Check) เฉพาะในแท็บนั้นๆ ทำให้เมื่อมี `SELL_FILL` หรือ `BUY_FILL` เข้ามา จะถูกแทรกขึ้นบนสุดของแท็บ Trade Matches ทันทีแบบ Real-time พร้อมอัปเดตตัวนับ `tradesCount` ทันที 100%
        - ใน `src/strategy.ts`: เพิ่ม `status: "FILLED"` ใน Payload ของ `processSellFill`, `processBuyFill`, `sellTrancheIOC`, และ `sellAll` ให้ชัดเจนทุกเลเยอร์
   11. **Smart Activity Timestamps (< 12h Relative "ago" & >= 12h DD/MM/YY Full Date)**:
      - ใน `public/app.js`: เพิ่มฟังก์ชัน `formatActivityTime(timestamp)`:
        - **หากไม่เกิน 12 ชั่วโมง (< 12 ชม.)**: แสดงผลเป็น Relative Time เช่น `just now`, `5m ago`, `2h 15m ago` เพื่อให้ดูง่ายและรู้ว่าเพิ่งเกิดขึ้นเมื่อไร
        - **หากเกิน 12 ชั่วโมง (>= 12 ชม.) หรือข้ามวัน**: แสดงผลเป็น วัน/เดือน/ปี พร้อมเวลา เช่น `15/10/26 13:53`
   12. **DreamDEX Emergency Sell All & Manual Liquidation (Zero Revert 0xc04ad919 & Best Bid Direct Execution)**:
      - **สาเหตุของปัญหา**: เมื่อผู้ใช้กด Emergency "Sell All" บนหน้าเว็บ ฟังก์ชัน `sellAllUser()` ดึงราคา Best Bid มาเป็นฐานก็จริง แต่ในฟังก์ชัน `sellAll()` เดิมมีตรรกะสำหรับ `action = "MANUAL"` ที่นำราคาไปคำนวณหักส่วนลด Slippage buffer (`price * (1 - slippagePct)`) ก่อนส่งคำสั่งเสมอ ทำให้แม้ว่าใน Orderbook จะมี Best Bid รอรับซื้ออยู่ที่ $0.2002 แต่คำสั่งกลับถูกส่งขายออกไปที่ $0.1999 (ลดราคาลงมา 0.15%) และบันทึกราคา Fill ที่ $0.1999 ไปด้วย นอกจากนี้ `getTopOfBook()` บน DreamDEX มีแคช 1.5 วินาที ทำให้บางจังหวะดึงได้ราคาของเสี้ยววินาทีก่อนหน้า
      - **การแก้ไข**:
        - ใน `src/exchange/types.ts` & `src/exchange/dreamdex/client.ts`: เพิ่มตัวเลือก `forceFresh?: boolean` ให้กับ `getTopOfBook()` เพื่อให้สามารถบายพาสแคช 1.5 วินาที และดึงราคา Orderbook สดใหม่ ณ เสี้ยววินาทีที่ผู้ใช้กดปุ่มได้ทันที
        - ใน `src/strategy.ts` (`sellAllUser()`): ส่ง `forceFresh = true` เพื่อดึงราคา Best Bid ล่าสุดจากตลาดจริง
        - ใน `src/strategy.ts` (`sellAll()`): สำหรับ `action === "MANUAL"` ปรับตรรกะให้ส่งคำสั่งขายที่ราคา **`bestBid` โดยตรง 100% (0% Discount / ไม่หักลดราคาล่วงหน้า)** เมื่อมี Best Bid อยู่ใน Orderbook (`effectiveBid > 0`) เพื่อให้ขายได้ราคาที่ดีที่สุดเสมอ โดยจะใช้ Slippage เป็น Fallback เฉพาะในกรณีที่ Orderbook ไม่มี Bid รองรับเท่านั้น พร้อมทั้งบันทึกและแสดงผล `Slip: 0.00%` ใน Activity Feed อย่างถูกต้อง
    13. **Strict Confirmed Dow Swings & Canonical Max Peak Ceiling Architecture ("แต่มันไม่ใช่ ยอด หรือ เหวที่ยืนยันนะ เห็นเป็นแค่แท่งเทียนนี่")**:
       - **สาเหตุของปัญหา**:
         1. บอทแสดงกรอบบน Ceiling (100%) อยู่ที่ระดับ `$0.199580` ซึ่งเป็นเพียง "แท่งเทียนธรรมดา" (ไม่ใช่ยอดสวิงที่ยืนยัน ไม่มีเส้นหยัก ZigZag สีฟ้า และไม่มีป้าย Dow Theory `HH`/`LH`) ขณะที่ยอดสวิงจริงของรอบคลื่นฟื้นตัวอยู่ที่ `$0.2022` (ตรงป้าย `[CUT]`) และยอดคลื่นใหญ่ก่อนหน้าอยู่ที่ `$0.2088` (ป้าย `[HH]`)
         2. ใน `src/market-structure.ts`: โค้ดเดิมมีเงื่อนไขบังคับให้ `activePeak = lastCanonicalHigh` ทันทีในทุกกรณีเมื่อมียอดสวิงล่าสุด ทำให้ยอดสวิงสูงสุดของรอบคลื่น (`maxHigh` ที่เป็นยอดแท้จริงของรอบคลื่น) กลายเป็น Dead Code ที่ไม่มีวันถูกเรียกใช้ และเมื่อไม่มี canonical high ในรอบคลื่น โค้ดยัง fallback ไปดึงเอาแท่งเทียนทั่วไปใน `confirmedHighs` (3-bar local pivot ดิบ) มาเป็นเพดาน
         3. เมื่อตลาดทุบทำ `macroLow` ($0.189800) และฟื้นตัวขึ้นไป หากเกิดเหวย่อย (postLowLows) ตรรกะเดิมดันเลื่อน `activeWaveBaseIndex` ข้ามไปเริ่มที่เหวย่อยนั้น ทำให้ยอด High สวิงหลักก่อนหน้า ($0.2022) หลุดออกจาก Pool คำนวณ
       - **การแก้ไข**:
         1. **Strict Canonical Swings Only**: เพดาน (Ceiling) และพื้น (Floor) ต้องล็อคกับจุดสวิงที่ยืนยันตามรอบคลื่น Dow Theory (`canonicalHighs` และ `canonicalLows` ที่มีเส้นคลื่น ZigZag และป้ายกำกับ) เท่านั้น 100% ตัดการ fallback ไปหาแท่งเทียนดิบ (`confirmedHighs` / `confirmedLows`) ออกทั้งหมด
         2. **Lock Max Confirmed Peak of Active Wave (`maxHigh`)**: กำหนดให้ `activePeak` ยึดยอดสวิงสูงสุดที่ยืนยันแล้วในรอบคลื่นปัจจุบัน (`maxHigh` ใน `highsPool`) เสมอ เพดานจึงล็อคเกาะกับยอดต้านสวิงหลักแท้จริงของคลื่น (เช่น **`$0.2022`**) ไม่ถูกแท่งเทียนย่อยหรือสวิงเตี้ยๆ บีบเพดานยุบตัวลงมากลางอากาศ
         3. **Preserve Post-MacroLow Swings (`cycleHighsStartIndex`)**: ในกรณีคลื่นฟื้นตัวหลัง `macroLow` ($0.189800) กำหนดให้ `cycleHighsStartIndex = macroLow.index` ครอบคลุมยอดสวิงทั้งหมดที่เกิดขึ้นนับตั้งแต่จุดต่ำสุดเป็นต้นมา ทำให้ยอดสวิงหลัก ($0.2022) อยู่ใน Pool คำนวณเสมอ
         4. **Lower High Step-Down Guard**: การปรับลดเพดานตาม Lower High (LH) ให้เป็นหน้าที่ของ Dow Theory Clamping Step (บรรทัด 1565) ที่มีเงื่อนไขตรวจสอบความกว้าง `minSpan` และ `maxSpan` อย่างรัดกุมตามเดิม

    14. **Mark-to-Bid Liquidation Valuation for Unrealized PnL (Zero Phantom Profit)**:
       - **สาเหตุของปัญหา**: ค่า Unrealized PnL เดิมใน step() และ emitTelemetryTick() ถูกคำนวณจาก efPrice (CEX Last Trade) หรือ mid (กึ่งกลาง Bid/Ask) ด้วยสูตร (refPrice - avgEntry) * baseHeld ซึ่งสำหรับฝั่งซื้อถือเหรียญ (Long Position) หากต้องการขายทำกำไรหรือคัทลอสจริง จะต้องขายใส่ฝั่ง Best Bid เสมอ การใช้ราคา Mid หรือ CEX ทำให้มี Spread หรือราคา Ask ปนอยู่ ตัวเลข PnL บนแดชบอร์ดจึงดูเขียวมากกว่าความเป็นจริง (หลอกตา)
       - **การแก้ไข**:
         - ใน src/strategy.ts: เพิ่มตัวแปร State lastBestBid และ lastBestAsk บันทึกราคา BBO ทุกครั้งจาก WebSocket Feed หรือ REST Top of Book
         - ใน src/strategy.ts (step() & emitTelemetryTick()): เปลี่ยนสูตรคำนวณ Unrealized PnL และมูลค่า Inventory / Wallet Base Total เป็น **Mark-to-Bid Liquidation Price** (aluationBid = currentBestBid > 0 ? currentBestBid : refPrice):
           \text{unrealizedPnl} = (\text{valuationBid} - \text{avgEntry}) \times \text{baseHeld}
         - ใน public/app.js: คำนวณ % Unrealized PnL โดยเทียบกับ Cost Basis แท้จริง ((upnl / costBasis) * 100) ทำให้ตัวเลข PnL และเปอร์เซ็นต์บนหน้าจอสะท้อนกำไรขาดทุนแท้จริงที่จะได้รับทันทีหากกด Sell All

     15. **Somnia uint128 Order ID Isolation & Trade Rounds Self-Healing (100% History Recovery)**:
        - **สาเหตุของปัญหา**:
          1. ใน `src/db.ts` (`migrateOrders`): มีการตรวจสอบเงื่อนไข `isBinanceOrderId = o.orderId && /^\d{8,}$/.test(o.orderId) && !o.orderId.startsWith("0x")` โดยเข้าใจว่าเลขออร์เดอร์ตัวเลขล้วนที่ยาวตั้งแต่ 8 หลักขึ้นไปเป็นออร์เดอร์ของ Binance เท่านั้น
          2. บน Somnia DreamDEX (`SpotPool` Smart Contract) ออร์เดอร์ ID บน On-Chain สร้างขึ้นด้วยชนิดข้อมูล `uint128` (เช่น `3560221606225972338705` - 22 หลัก) ซึ่งไม่มี `0x` นำหน้า และคู่เหรียญมี Quote Asset เป็น `USDSO` ทำให้เข้าเงื่อนไขพอดี คำสั่งใน `migrateOrders` จึงเข้าใจผิดและไปเขียนทับประวัติออร์เดอร์ `SOMI:USDSO` ทั้งหมด 118 รายการใน DB ให้กลายเป็น `baseAsset: "ETH"` และ `symbol: "ETHFDUSD"`
          3. เมื่อเปิดหน้าเว็บแดชบอร์ด ฟังก์ชัน `calculateTradeRounds(orders, "SOMI:USDSO")` ใน `src/trade-rounds.ts` จึงกรองออร์เดอร์ออกหมด เพราะเห็นเป็น `baseAsset: "ETH"` ทำให้รอบการเทรดของ SOMI หายไปทั้งหมด เหลือแสดงเพียงแค่ 1 รอบ (Sell Only #1)
        - **การแก้ไขและระบบ Self-Healing**:
          1. ใน `src/db.ts`:
             - ปรับปรุงฟังก์ชัน `inferBase()` ให้ใช้การตรวจจับจากช่วงราคาจริง (`price >= 0.01 && price <= 10.0` เป็น `SOMI`, `price >= 500` เป็น `WETH`) และตรวจจับ Somnia Explorer URL / Hash (`shannon-explorer`, `0x`)
             - ปรับปรุง `migrateOrders()` ให้ป้องกันไม่ให้ออร์เดอร์ Somnia/DreamDEX (ที่มี price < 10 หรือ quoteAsset เป็น USDSO หรือ Somnia orderId) ถูกเปลี่ยนเป็น Binance ETH และเพิ่มระบบ Self-Healing ซ่อมแซมออร์เดอร์ SOMI ที่เคยถูกแก้เป็น ETH ให้กลับคืนเป็น `baseAsset: "SOMI"`, `quoteAsset: "USDSO"`, `symbol: "SOMI:USDSO"` อัตโนมัติเมื่อเริ่มเปิดบอท
          2. ใน `src/trade-rounds.ts`:
             - ปรับปรุง `inferOrderBase()` ให้ใช้ช่วงราคาในการตรวจสอบควบคู่ เพื่อให้ครอบคลุมและสามารถคำนวณรอบของ SOMI ได้ครบถ้วนทุกกรณี
             - เพิ่ม action `"EXIT"` ลงใน Whitelist ของ Order Fills ใน `calculateTradeRounds()` เพื่อไม่ให้ตกหล่นไม้ที่เกิดจากการตัดขาย/ออกฉุกเฉิน
          3. **ผลลัพธ์**: ข้อมูลรอบการเทรด 32 รอบ (22 Wins / 10 Losses) และ PnL รวม +$2.67 ได้รับการกู้คืนครบถ้วนสมบูรณ์ 100% โดยอัตโนมัติ

     16. **Dynamic Grid Tranche Sizing & Proportional Level Quota Guards (Strict 50/50 & Tranche Isolation)**:
        - **สาเหตุของปัญหา**:
          1. ใน `src/strategy.ts` (`syncRestingOrders`): ค่า `buyTargets` ถูก Hardcode ไว้เป็น `[0.25, 0.50, 0.75, 1.00]` เสมอ โดยไม่สนใจว่าผู้ใช้เปิดใช้งานกี่เลเวล เมื่อผู้ใช้เปิดใช้งานเพียง 2 ไม้ (เช่น Buy Level 3 และ Buy Level 4) ค่าเป้าหมายพอร์ตของ Level 3 กลับถูกตั้งไว้ที่ 75% แทนที่จะเป็น 50%
          2. เมื่อไม้แรกซื้อสำเร็จที่ Buy Level 3 เป็นเงิน $50 (ถือครอง 50% ของงบ $100) ระบบตรวจพบว่า `50% < 75%` จึงเข้าใจผิดว่า Buy Level 3 ยังไม่เต็มโควตา และนับเป็นไม้ที่ต้องวางซื้อต่อไป
          3. สูตรคำนวณขนาดไม้ `rawTrancheQuote = currentAvailableCapacity / numEligibleBuyLevels` เมื่อเหลืองบ $50 และเห็นว่ามี 2 ไม้ที่ Eligible จึงนำ $50 มาหาร 2 เหลือไม้ละ $25 ส่งผลให้บอทไปแคนเซิลไม้ Buy Level 4 เดิม ($50) แล้วลดขนาดเหลือ $25 พร้อมทั้งวางคำสั่งซื้อใหม่ที่ Buy Level 3 ซ้ำอีก $25 ที่ราคาเดิม ทั้งๆ ที่เพิ่งซื้อไปและยังไม่ได้ขาย ทำให้เสียสัดส่วนพอร์ตกลายเป็น ถือ 50% + รอซื้อ Level 3 25% + รอซื้อ Level 4 25%
        - **การแก้ไขและสถาปัตยกรรมใหม่**:
          1. **Dynamic Buy Targets (`buyTargets`)**: คำนวณเป้าหมายสัดส่วนพอร์ตแบบไดนามิกตามลำดับของเลเวลที่เปิดใช้งานจริง (`activeBuyCount`) เช่น หากเปิด 2 ไม้ (Level 3 & 4): Level 3 = 50% (1/2), Level 4 = 100% (2/2) ทำให้เมื่อ Level 3 ซื้อสำเร็จและถือครองครบ 50% จะถูกตัดออกจาก Eligible ไม้ซื้อทันที
          2. **Fixed Portfolio Proportion Tranche Sizing (`baseTrancheQuote`)**: ล็อกขนาดไม้ตามสัดส่วนพอร์ตถาวร `baseTrancheQuote = maxInv / activeBuyCount` (เปิด 2 ไม้ = ไม้ละ $50 เสมอ) และแต่ละออร์เดอร์อิงจาก `Math.min(baseTrancheQuote, remainingCapacityForOrder)` ไม่นำเงินคงเหลือมาหารย่อยจนเสียสัดส่วน
          3. **Open Lot Proximity Guard**: เพิ่มการตรวจสอบใน `this.lots` หากมี Lot ที่ซื้อมาในระดับราคาของเลเวลนั้นอยู่แล้ว (ภายใน 0.25%) จะถือว่าเลเวลนั้นถูกเติมเต็มแล้ว ห้ามวางคำสั่งซื้อที่ระดับราคานั้นซ้ำเด็ดขาด
          4. **Auto-Cancellation & Self-Healing**: เมื่อบอทรันรอบถัดไป Ineligible Level Cancel Guard จะตรวจพบไม้ซื้อที่ Buy Level 3 และสั่งยกเลิกทันที พร้อมปรับขนาดไม้ Buy Level 4 กลับเป็น $50 เต็มจำนวนตามสัดส่วนเดิม
          5. **UI Target Allocation**: ปรับ `Grid Channel Meter` ใน `public/app.js` ให้อ้างอิง `targetHoldingPct` จาก Strategy Telemetry โดยตรง แสดงผลเป้าหมายสัดส่วนพอร์ตตรงตามความเป็นจริง

     17. **Strict MAKER_LIMIT Mode Integrity & Anti-Hijack Guard (No IOC at Grid Sell Targets)**:
        - **สาเหตุของปัญหา**:
          1. ใน `src/strategy.ts` (`syncRestingOrders`): เงื่อนไขกรอง `eligibleIndices` ของฝั่งขายเดิมมี `lvl > minAllowedSellPrice` (โดย `minAllowedSellPrice = bestBid`) เมื่อราคาขึ้นมาถึง Sell Target 1 พอดี ทำให้ `lvl > minAllowedSellPrice` กลายเป็นเท็จ ส่งผลให้ออร์เดอร์ Maker ที่ตั้งรอไว้ถูก Cancel ทิ้งเสี้ยววินาทีก่อนจะ Match
          2. ใน `src/strategy.ts` (`step()`): เงื่อนไข `realCeilingReached` เดิมมี `tpExecBid >= highestActiveSellTarget` เมื่อผู้ใช้เปิดขายเป้าเดียว (Sell Target 1) เลเวลนี้จึงกลายเป็น `highestActiveSellTarget` ส่งผลให้ฟังก์ชัน Take Profit เพดานบนแทรกแซงด้วยการเรียก `sellAll()` ซึ่งส่งคำสั่งแบบ IOC (Taker) ออกไปกวาดขายในตลาดแทนที่จะรอให้ออร์เดอร์ Maker แมตช์ตามปกติ
          3. คำสั่ง IOC ถูกส่งไป Binance และแมตช์ทันที เกิด Race Condition ระหว่าง WebSocket `executionReport` กับ REST response ของ `sellAll` ทำให้หน้าจอขึ้นเบิ้ล 2 การ์ด (การ์ดล่าง Maker Fill +$0.55 และการ์ดบน IOC TP +$0.0000) สำหรับออร์เดอร์เดียวกัน (#5585189244)
        - **การแก้ไขและสถาปัตยกรรมใหม่**:
          1. **Preserve Resting Sell Orders on Touch**: ใน `syncRestingOrders` หากมีออร์เดอร์ Maker วางรออยู่ที่เลเวลนั้นอยู่แล้ว (`hasExistingOrder`) ให้คงสถานะ Eligible เสมอ ห้ามแคนเซิลทิ้งเด็ดขาด เพื่อรอให้จับคู่ใน Orderbook
          2. **Strict Maker Limit at Grid Targets**: ใน `step()` กำหนดให้ `highestActiveSellTarget` ทริกเกอร์ IOC ได้เฉพาะเมื่อรันในโหมด `IOC_BRACKET` เท่านั้น ในโหมด `MAKER_LIMIT` ทุกระดับ Sell Targets จะต้องถูกจับคู่ด้วย Maker Limit Orders 100% (กินสิทธิ์ 0% Fee และบันทึก Reconcile สถานะตามจริง) โดยจะอนุญาตให้ใช้ `sellAll` (IOC) เฉพาะกรณีราคาหลุดเหวล่าง (Cut Loss), กดปุ่มฉุกเฉินด้วยมือ (Manual), หรือราคาทะลุเพดานกรอบบนสุดจริง (`refPrice >= upperBound`)
          3. **De-duplication via clientOrderId & Held Balance**: กำหนด `exitClientOrderId` ล่วงหน้าก่อนส่ง `placeOrder` และตรวจสอบใน `sellAll` หาก WebSocket ปิด Lot ไปแล้ว จะไม่บันทึกหรือยิงอีเวนต์ซ้ำซ้อน

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

---

### 18. Classic Dow Theory Channel Floor & Ceiling Pairing (`isValleyEligibleForFloor`, `activeWaveReachableValleys` & Upward Resistance Ceiling Expansion)
- **สาเหตุของปัญหา**:
  1. ใน `src/market-structure.ts` (`getStructure()`): เมื่อราคาปรับตัวลงจากยอด `macroPeak` (`HH`) มาสร้างจุดต่ำสุดของคลื่นปัจจุบัน `LL` (`activeWaveBaseIndex`, เช่น `$103.00`) แล้วเด้งขึ้นไปทำยอดย่อย `LH` (เช่น `$104.71`) ระบบกรอง `activeCycleHighs` ให้เริ่มหลัง `activeWaveBaseIndex` ทำให้ `curCeil` เริ่มต้นที่ยอดเด้งย่อย `$104.71` เท่านั้น
  2. เมื่อคำนวณระยะห่างระหว่างยอดเด้งย่อย `$104.71` กับฐานคลื่นปัจจุบัน `$103.00` (หรือ `⭐ HL $104.20`) ได้ความกว้างน้อยกว่า `minChannelWidthPct` (`3.0%`) ตัวกรอง `validWidthValleys` จึงข้ามทั้ง `⭐ HL` และฐานคลื่นปัจจุบัน `LL ($103.00)` ย้อนกลับไปเกาะเหวโบราณเมื่อ 2 วันก่อน (`$101.56`)
  3. ลูปขยายกรอบเมื่อความกว้างต่ำกว่า `minSpanFromPct` เดิมให้ความสำคัญกับการดึง `curFloor` ลงไปหาเหวเก่าในอดีต (`nextL`) แทนที่จะขยาย `curCeil` ขึ้นไปหาแนวต้าน `LH/HH` ที่ยังไม่ถูกทำลายด้านบน (`nextH`, เช่น `LH $106.54`)
- **การแก้ไขและสถาปัตยกรรมใหม่**:
  1. **Breakout-Confirmed Higher Low (`isValleyEligibleForFloor`)**:
     - เมื่อ `macroPeak.index < macroLow.index` ระบบยึด `activeWaveBaseIndex = macroLow.index` เป็นจุดเริ่มต้นของคลื่นเสมอ เพื่อให้ `activeCycleLows` มีทั้งฐาน `macroLow (LL)` และเหว `HL` ถัดมาครบถ้วน
     - เหวที่เป็น `LL` (`!prevValley || v.price <= prevValley.price || dowLabel === "LL"`) มีสิทธิ์ใช้เป็น `Floor` ของกรอบได้ทันที
     - เหวที่เป็น `Higher Low (⭐ HL)` ทุกตัวจะมีสิทธิ์ยก `Floor` ของกรอบขึ้นไปเกาะ **ก็ต่อเมื่อราคา (หรือแท่งเทียน/สวิงถัดมา) ทะลุยอด (`precedingPeak`) ที่คั่นอยู่ก่อนหน้า `HL` นั้นขึ้นไปได้แล้วเท่านั้น** ตามหลัก Dow Theory แท้ (โดยไม่มีทางลัดข้ามการเช็ค)
  2. **Active Wave Reachable Valley Priority (`activeWaveReachableValleys` & `canReachMinSpanWithPeak`)**:
     - บังคับให้ระบบเลือกเหวที่ผ่านเกณฑ์ในคลื่นปัจจุบัน (`l.index >= activeWaveBaseIndex`) ก่อนเสมอ หากเหวนั้นสามารถจับคู่กับยอดปัจจุบันหรือยอดต้าน `LH/HH` ด้านบนที่ยังไม่ถูกทำลาย (`unbrokenPeaksAbove`) แล้วได้ความกว้างอยู่ในเกณฑ์ `[minSpanFromPct, maxSpanFromPct]` เพื่อป้องกันไม่ให้บอทกระโดดข้ามฐานคลื่นปัจจุบันย้อนกลับไปเกาะเหวเก่าข้ามวัน
  3. **Upward Resistance Ceiling Expansion (`higherConfirmedHighs` First)**:
     - เมื่อความกว้าง `curCeil - curFloor < minSpanFromPct` ระบบจะขยาย `curCeil` ขึ้นไปเกาะยอดต้าน `LH` หรือ `HH` ที่ยังไม่ถูกทำลายด้านบน (`nextH`) ตามลำดับจากต่ำไปสูงจนกว่าความกว้างจะผ่านเกณฑ์ `minSpanFromPct` (เช่น ยก `Floor` มาที่ฐานคลื่น `LL $103.00` คู่กับ `Ceiling` ที่แนวต้าน `LH $106.54`) และจะขยับ `Floor` ขึ้นไปเกาะ `⭐ HL ($104.20)` ทันทีเมื่อราคาเบรกยอด `$104.71` ขึ้นไปสำเร็จ
  4. **Dynamic 5-Level Grid Synchronization & Removal of Legacy 18% Buffer (`src/strategy.ts` & `public/app.js`)**:
     - `inBuyZone` ใน `src/strategy.ts` และป้ายบอกโซนใน `public/app.js` ครอบคลุมช่วง `0% – 50%` ของกรอบทั้งหมด (`positionPct >= 0 && positionPct < 50`) สอดคล้องกับการตัด Safe Buffer `18%` ออกและใช้ Buy Level 4 (`12%`) / Buy Level 5 (`2%`)
     - `sellHoldingTargets` ใน `syncRestingOrders` คำนวณสัดส่วนเป้าหมายการถือครองแบบไดนามิกตามจำนวนเลเวลขายที่เปิดใช้งานจริง (`enabledSells` / `activeSellCount`) รองรับครบทั้ง 5 เลเวล
     - ระบบ Hysteresis ฝั่งซื้อบน DEX อ้างอิง `sellLevelPcts[0]` (`52%`) แบบไดนามิก และเมื่อโหลด `persistentLockedChannel` หรือแก้ไข `buyLevelPcts` / `sellLevelPcts` ขณะถือของ ระบบจะรีคำนวณ `buyLevels` และ `sellLevels` ทั้ง 5 เลเวลจากขอบ `lowerBound` และ `upperBound` ที่ล็อกไว้ทันที

### 19. Pyramid Buy Tranche Sizing, 2-Stage Smart Cut Loss, LH Dynamic Escape, Minimum Net Profit Guard & Live Grid Simulator (`src/config.ts`, `src/strategy.ts`, `public/index.html`, `public/app.js`)
- **สาเหตุและเป้าหมายการปรับปรุง**:
  1. **Equal Sizing (20% x 5) เสียเปรียบเมื่อรวบครบ 5 ไม้**: ทำให้ต้นทุนเฉลี่ย (`Avg Entry`) อยู่กลางโซนซื้อ (`22%` ของกรอบ) และเมื่อหลุด Floor เพียงเล็กน้อยจะโดนคัทก้อนใหญ่ `100%` ทันที
  2. **100% Cut Loss ครั้งเดียวเสี่ยงโดนไส้เทียนกวาด (Stop-Hunt Whipsaw)**: บ่อยครั้งที่ราคาทุบหลุด `Floor Buffer` ลงไปกิน Stop แล้วดีดกลับเข้ากรอบทันที
  3. **การล็อกกรอบขณะถือของอาจพลาดจังหวะออกเมื่อตลาดเริ่มทำ Lower High (LH)**: หากราคาเด้งขึ้นไปทำยอด `LH` ใหม่ที่ต่ำกว่า `Sell Target 1 (52%)` แต่ยังมีกำไรเหนือทุนเฉลี่ย ระบบเดิมจะถือรอจนราคาทุบลงมาคัทลอส
  4. **ความเสี่ยง Fee Erosion บนคู่ใน (`Buy L1 42% -> Sell T1 52%`)**: เมื่อกรอบแคบ ระยะ `10%` ของกรอบอาจแคบเกินกว่าจะคุ้มค่าธรรมเนียมและ Slippage
- **สถาปัตยกรรมและฟีเจอร์ทั้ง 5 ข้อ**:
  1. **Pyramid Buy Tranche Sizing (`buySizingMode`: `"PYRAMID" | "EQUAL"`, `buyLevelWeights`: `[10, 15, 20, 25, 30]`)**:
     - เมธอด `getBuyLevelWeightFractions()` และ `getCumulativeBuyTargetFraction()` คำนวณสัดส่วนงบประมาณของแต่ละเลเวลแบบไดนามิกตามเลเวลที่เปิดใช้งานจริง (`enabledBuyLevels`)
     - ในโหมด `PYRAMID` (ค่าเริ่มต้น): กระจายน้ำหนัก `L1 (42%) = 10%`, `L2 (32%) = 15%`, `L3 (22%) = 20%`, `L4 (12%) = 25%`, `L5 (2%) = 30%` ดึงต้นทุนเฉลี่ยเมื่อรับครบ 5 ไม้ลงมาจาก `22.0%` เหลือเพียง **`17.0%` ของกรอบ** (เด้งขึ้นเพียง `18%` ของกรอบก็เริ่มเขียว)
  2. **2-Stage Smart Cut Loss (`enableTwoStageCutLoss`: `true`, `cutLossStage2Multiplier`: `2.0`)**:
     - **Stage 1 (De-Risk 50%)**: เมื่อราคาหลุด `cutLossBound` (และครบ `cutLossBufferDelaySeconds`) บอทจะแบ่งขายตัดขาดทุนออกก่อน **`50%`** (`sellTrancheIOC(..., true)`) เพื่อลดความเสี่ยงครึ่งพอร์ต
     - **Recovery**: หากราคาดีดกลับขึ้นมายืนเหนือ `lowerBound` (`Floor 0%`) สำเร็จ ระบบจะรีเซ็ต `cutLossStage1Executed = false` และเก็บของอีก `50%` ที่เหลือไว้ขายคืนทุนในกรอบ
     - **Stage 2 (Full Exit 100%)**: หากราคาไหลลงต่อจนหลุด `stage2CutBound` (`lowerBound - floorBuffer * cutLossStage2Multiplier`) หรือปิดแท่งเทียนถัดมาต่ำกว่าราคาที่คัท Stage 1 บอทจะตัดขายไม้ที่เหลืออีก `50%` ออกทั้งหมดทันที (`exitAllPosition`)
  3. **LH Dynamic Escape (`enableLhDynamicEscape`: `true`)**:
     - ขณะถือครองเหรียญในกรอบที่ล็อกไว้ หากโครงสร้างตลาดสร้างยอดสวิง `Lower High (LH)` ที่ยืนยันแล้ว (หรือ `liveCalculatedCeil`) ซึ่งอยู่ต่ำกว่า `Sell Target 1` (`52%`) แต่สูงกว่าต้นทุนเฉลี่ยบวกกำไรขั้นต่ำ (`avgEntry * getMinProfitMultiplier()`) บอทจะปรับเพดานขายหนีตาย (`lhDynamicEscapePrice`) ลงมาปิดทำกำไรที่ยอด `LH` นั้นทันทีก่อนที่ราคาจะม้วนตัวลงทำ `LL`
  4. **Minimum Net Profit Guard (`minNetProfitPct`: `0.25%`)**:
     - เมธอด `getMinProfitMultiplier()` บังคับระยะกำไรสุทธิขั้นต่ำ (`+0.25%` เหนือต้นทุนไม้ที่ถูกสุด หรือเหนือ `avgEntry` ในโหมด `PORTFOLIO_AVG_PROFIT`) ทั้งใน `syncRestingOrders`, `executeIocBracketGrid`, และ `sellTrancheIOC` ป้องกันการขายหมุนรอบที่ได้กำไรไม่คุ้มค่าธรรมเนียมเมื่อกรอบแคบ
  5. **Interactive Grid & Avg Entry Simulator (`public/index.html` & `public/app.js`)**:
     - เพิ่มการ์ด **`📊 Live Grid Allocation & Avg Entry Simulator`** ในหน้าต่าง Settings (Tab 3: Execution & Guard) คำนวณและแสดงผลแบบ Real-time ทันทีที่ปรับแก้ `%`, เปิด/ปิดเลเวล, หรือสลับโหมด `PYRAMID` / `EQUAL`:
       - แสดง `Full-Fill Avg Entry (% ของกรอบ)`
       - แสดง `Inner Spread (Buy L1 -> Sell T1)`
       - แสดง `First Profit Distance (Avg -> T1)` พร้อมป้ายขนาดไม้ (`%` และ `$USDT`) ของแต่ละเลเวลซื้อ

### 20. Dashboard v2.3 Redesign, Balanced Top Bar, Bot Status Control Strip, Categorized 4-Tab Config Modal & Obsolete Config Cleanup (`data/settings.db.json`, `src/db.ts`, `src/config.ts`, `public/index.html`, `public/style.css`, `public/app.js`)
- **สาเหตุและเป้าหมายการปรับปรุง**:
  1. **หน้า Dashboard เดิมอัดข้อมูลซ้อนกันและเมนูด้านบนไม่สมดุล**: การ์ด KPI ใบแรกอัดทั้ง Wallet และ Position ไว้ด้วยกัน, เมนูด้านบนมีขนาดฟอนต์ไม่เท่ากันและป้าย `Live Feed` กับ `LIVE ON-CHAIN` ชวนสับสน, ปุ่มควบคุมบอทอัดอยู่ด้านบนในขณะที่แถบสถานะบอทด้านล่างมีพื้นที่ว่างมาก, ปุ่มเปิดจัดการเทรด/ล็อต/รอบเทรดซ้ำซ้อนกันหลายจุด และบันไดกริด 13 ขั้นแสดง `Hold 20%, 40%, 60%, 80%, 100%` แบบตายตัวไม่เปลี่ยนตามโหมด `PYRAMID`
  2. **หน้า Config กระจัดกระจายและมีค่าที่เลิกใช้แล้วค้างอยู่**: การตั้งค่าที่เกี่ยวข้องกันกระจายอยู่คนละแท็บ ไม่มีกรอบหมวดหมู่ย่อย แสดงพารามิเตอร์ทุกตัวพร้อมกันแม้จะปิดฟีเจอร์นั้นอยู่ และมีคีย์เก่าที่ไม่ได้ใช้งานแล้ว (`srMinTouchCount`, `srTouchTolerancePct`, `enableLaggardSnipe`, `enableLaggardGuard`, `laggardThresholdPct`, `maxInventoryUsdso`, `requireProfitAboveAvgEntry`, `tradingTimeframe`, `trendTimeframe`) ปะปนอยู่ใน `data/settings.db.json`
- **สถาปัตยกรรมและการปรับปรุงใหม่**:
  1. **Dashboard Layout v2.3 (`public/index.html`, `public/style.css`, `public/app.js`)**:
     - **Balanced Single-Line Top Bar (`header.top-nav`)**:
       - **ฝั่งซ้าย**: ป้ายกระดาน (`#logoBadge`) + Dropdown เลือกคู่เหรียญธีมมืด (`#topSymbolSelect`) + ป้ายโหมดการเทรดที่ชัดเจน (`#dryRunBadge`: `🟡 โหมดจำลอง (DRY RUN)` / `🟢 โหมดเทรดจริง (LIVE)`) + ป้ายสถานะการเชื่อมต่อรวมกับความเร็วรอบบอท (`#connectionStatus`: `🟢 ออนไลน์ • ⚡ 0.2s`)
       - **ฝั่งขวา**: เหลือเพียง 2 ปุ่มเมนูหลักขนาดสมดุลกัน (`height: 32px`, บรรทัดเดียว): `📊 ประวัติ / ล็อต / สรุปรอบ` (`#btnOpenTradeManager` ซึ่งภายในมีครบทั้ง 3 แท็บ: ประวัติเทรด, จัดการ Lots, และสรุปรอบเทรด) และ `⚙️ ตั้งค่า (Config)` (`#openSettingsBtn`)
     - **Bot Status & Operational Control Strip (`#botStatusBanner`)**: ย้ายปุ่มควบคุมการทำงานของบอททั้ง 4 ปุ่ม (`⏸️ หยุดชั่วคราว`, `🛑 ยกเลิกออเดอร์`, `💥 ขายล้างพอร์ต`, `🔄 รีเซ็ต`) ลงมาไว้ฝั่งขวาของแถบสถานะบอท ใช้พื้นที่ว่างให้เกิดประโยชน์สูงสุดและอยู่ติดกับข้อความสถานะบอทโดยตรง
     - **4-Card KPI Strip (`kpi-four-grid`)**: แยกการ์ดออกเป็น 4 ใบเต็มความกว้าง: `💼 กระเป๋าเงิน (Spot Wallet)`, `📦 ของที่ถือ & ความจุ (Active Position)` (คลิกป้าย `0 ไม้` `#lotsCount` เพื่อเปิดแท็บจัดการ Lots ได้ทันที), `💰 กำไร / ขาดทุน (Performance PnL)`, และ `📖 ราคาตลาด (Best Bid / Ask)`
     - **Dynamic Pyramid / Equal Grid Channel Meter (`updateZoneLevelBars`)**: บันได 13 ขั้นคำนวณและแสดงสัดส่วน `Hold % (+$USDT)` ของแต่ละ Buy Level (`L1–L5`) และ Sell Target (`T1–T5`) แบบไดนามิกตามโหมด `PYRAMID` หรือ `EQUAL` และตามเลเวลที่เปิดใช้งานจริง
     - **Right Sidebar 3-Tab Live Dock**: แสดง 3 แท็บหลักที่กว้างและอ่านง่าย (`⚡ เทรด`, `📖 ออเดอร์รอ`, `ทั้งหมด`) โดยตัดแท็บ Lots ที่ซ้ำซ้อนกับหน้าต่าง `📊 ประวัติ / ล็อต / สรุปรอบ` ออก
  2. **Categorized 4-Tab Settings Modal & Smart Conditional Visibility (`updateSettingsConditionalVisibility`)**:
     - จัดระเบียบหน้าต่าง Settings ใหม่เป็น 4 หมวดหมู่ตามลำดับความคิด พร้อมการ์ดหมวดย่อย (`.cfg-section-card`):
       - **Tab 1 (`🎯 1. กริด & การออกคำสั่ง`)**: งบประมาณ & รูปแบบคำสั่ง (`IOC_BRACKET` / `LIMIT_MAKER`), โหมดคิดกำไร (`GRID_CASHFLOW` / `PORTFOLIO_AVG_PROFIT`), กำไรสุทธิขั้นต่ำ (`minNetProfitPct`), ตารางตั้งค่าระดับกริด 5 ชั้น + โหมด `PYRAMID`/`EQUAL` + Live Grid Simulator, และเงื่อนไขโซนซื้อ/ขาย
       - **Tab 2 (`📊 2. กรอบราคา & โครงสร้าง`)**: การคำนวณกรอบราคา (`channelMode`, `dowTimeframe`, `min/maxChannelWidthPct`, `adjustChannelOnClosedOnly`), การคัดกรองไส้เทียน (`useTrueWick` ซ่อน `wickThresholdPct` อัตโนมัติเมื่อเปิดใช้ปลายไส้เทียนจริง), ตัวกรองเทรนด์ (`dowTrendFilter`, `trendlineFilter`), และการบีบแคบ/สามเหลี่ยม (`enableNarrowChannelCollapse`, `enableTriangleSqueezeExit` ซ่อนพารามิเตอร์ย่อยอัตโนมัติเมื่อปิดสวิตช์)
       - **Tab 3 (`🛡️ 3. ความเสี่ยง & Cut Loss`)**: การขายทำกำไรที่เพดาน (`takeProfitAtUpperBound`, `enableSellAtRealCeiling`, `enableLhDynamicEscape`), ระบบตัดขาดทุน (`cutLossAtLowerBound` และ `enableTwoStageCutLoss` ซ่อน/แสดงพารามิเตอร์ย่อยอัตโนมัติ), และเวลาถือครองสูงสุด (`stuckTimeoutMinutes`)
       - **Tab 4 (`🔌 4. กระดานเทรด & ระบบ`)**: กระดานเทรด & คู่เหรียญ & Dry Run, API Keys / RPC ตามกระดานที่เลือก, และการตั้งค่าระบบ (`intervalMs`, `timezone`, `dashboardPort`, จำนวนแท่งเทียน)
  3. **Obsolete Config Cleanup (`data/settings.db.json`, `src/db.ts`, `src/config.ts`)**:
     - ลบคีย์ที่เลิกใช้และซ้ำซ้อนออกจาก `data/settings.db.json` และเพิ่ม `DEPRECATED_SETTINGS_KEYS` ใน `flushSettingsSync()` (`src/db.ts`) เพื่อป้องกันไม่ให้คีย์เก่าถูกเขียนกลับลงไฟล์อีก
     - แปลง `tradingTimeframe`, `trendTimeframe`, และ `requireProfitAboveAvgEntry` ใน `src/config.ts` เป็น Computed Getter/Setter ที่อ้างอิงจาก `dowTimeframe` และ `sellProfitMode` โดยตรง


---

### 21. Dashboard v2.5: Consolidated 2-Card KPI Strip, Orderbook Integration in Grid Meter & Active-Only Grid Levels (`public/index.html`, `public/style.css`, `public/app.js`)
- **สาเหตุและเป้าหมายการปรับปรุง**:
  1. **การ์ด KPI ด้านบนกระจัดกระจายและ Orderbook กินพื้นที่**: การ์ดกระเป๋าเงิน (Wallet) และของที่ถือ (Position) มีข้อมูลที่เกี่ยวข้องกันอย่างใกล้ชิด การแยกเป็นการ์ดเดี่ยวหลายใบทำให้แถบด้านบนแน่นเกินไป และการ์ด Orderbook (Best Bid/Ask) เหมาะที่จะอยู่เคียงข้างระดับราคาในบันไดกริด (Grid Meter) มากกว่า
  2. **บันไดกริด (Grid Meter) แสดงระดับที่ปิดใช้งาน**: ขั้นบันไดกริดของเลเวลที่ผู้ใช้ปิดสวิตช์ไว้ (เช่น Buy Level 5 หรือ Sell Target 5 ปิดใช้งาน) เดิมเพียงแค่หรี่แสงลง ทำให้บันไดรกและยาวเกินจำเป็น
- **สถาปัตยกรรมและการปรับปรุงใหม่**:
  1. **Consolidated 2-Card KPI Ribbon (`kpi-two-grid`)**:
     - ยุบรวม Card 1 (Wallet) และ Card 2 (Position) เข้าเป็นใบเดียว: `💼 กระเป๋า & การถือครอง (WALLET & POSITION)` แบ่ง 2 ฝั่งซ้าย-ขวาอย่างสมดุล (ฝั่งซ้าย: เงินสด USDT/USDso + เหรียญ Base ในกระเป๋า, ฝั่งขวา: ของที่ถือครอง + หลอดความจุ % Load + ปุ่ม `lotsCount` สำหรับเปิดแท็บจัดการล็อต)
     - Card 2: `💰 กำไร / ขาดทุน (PNL & PERFORMANCE)` แสดง Unrealized PnL, Realized PnL, Win Rate, และจังหวะรอบเทรด
     - แถบ KPI ด้านบนกลายเป็น 2 คอลัมน์ที่กว้าง โปร่ง สะอาดตา และไม่เบียดเสียด
  2. **Integrated Orderbook Bar in Grid Meter (`.ladder-orderbook-bar`)**:
     - ย้าย Best Bid, Best Ask, และ Spread เข้าไปอยู่ในกรอบบันไดกริด (Grid Meter) เหนือขั้นบันได 100% Ceil ถึง 0% Floor โดยตรง
     - ผู้ใช้สามารถเทียบราคา Best Bid (รับซื้อ) และ Best Ask (ตั้งขาย) กับเส้นราคา Buy Levels และ Sell Targets ได้อย่างเป็นธรรมชาติในจุดเดียว
  3. **Active-Only Grid Meter Levels (`updateZoneLevelBars`)**:
     - ซ่อนระดับบันไดกริดที่ปิดใช้งานทั้งหมดด้วย `display: none` (แสดงเฉพาะ Level ที่เปิดสวิตช์ใช้งานจริงเท่านั้น) ทำให้บันไดกริดกะทัดรัดและตรงกับสภาพการเทรดจริง 100%
     - ปรับตรรกะการจับคู่ Maker Order (`candidateSteps`) ให้ค้นหาเฉพาะบันไดที่เปิดใช้งาน (`s.enabled === true`)
     - ปรับตรรกะการเน้นแถบราคาปัจจุบัน (`activeStep`) หากระดับราคาปัจจุบันตกอยู่ในเลเวลที่ปิดใช้งาน ระบบจะ Fallback ไปยังบันไดเลเวลที่เปิดใช้งานจริงที่ใกล้ที่สุดโดยอัตโนมัติ ไม่แสดงผลค้างบนแถวที่ถูกซ่อน


---

### 22. Recovery Wave HL Channel Floor Anchoring & Floating Floor Elimination (`src/market-structure.ts`)
- **สาเหตุของปัญหา**:
  1. **Higher Low (HL) ถูกบล็อกไม่ให้ยกฐานในรอบฟื้นตัว (`isValleyEligibleForFloor`)**:
     - ใน `src/market-structure.ts`: ฟังก์ชัน `isValleyEligibleForFloor` เดิมกำหนดว่าเหวที่เป็น Higher Low (`HL`) จะยกฐานกรอบล่าง (`Floor`) ได้ ก็ต่อเมื่อราคา (หรือแท่งเทียนถัดมา) ต้อง Breakout ทะลุยอดเดิม (`precedingPeak`) ขึ้นไปก่อนเท่านั้น
     - ในช่วงที่ตลาดกำลังฟื้นตัว (`รอบคลื่น: ฟื้นตัว (ยก HL ฐานสูงขึ้น)`) เช่น หลังราคาทุบทำก้นเหว `LL 0.180470` แล้วเด้งขึ้นไปทำ `HH 0.193300` และย่อตัวลงมาสร้างฐาน `⭐ HL 0.188943`: ตราบใดที่ราคายังวิ่งสะสมของอยู่ในกรอบ $0.1889–$0.1920 (ยังไม่เบรก $0.193300) บอทจะปฏิเสธ `⭐ HL` ทั้งหมด และยังคงมองฐานกรอบล่างลงไปที่ก้นเหว `LL 0.180470` ในอดีต
  2. **กรอบล่างถูกเฉือนลอยกลางอากาศเมื่อติด Max Span Clamp (`bottomBound = upperBound - maxSpan`)**:
     - เมื่อระยะระหว่างยอด `HH 0.193300` กับก้นเหว `LL 0.180470` กว้างถึง 7.11% ซึ่งเกินกว่า `maxChannelWidthPct` (เช่น ตั้งไว้ 6.0%)
     - โค้ดในบรรทัด 1854 เดิมตรวจพบว่าราคา ($0.190900) อยู่ซีกบนของกรอบ (`price >= centerPrice`) จึงใช้สูตรเฉือนความกว้างกรอบ:
       `bottomBound = Math.max(0.000001, upperBound - maxSpan)` ได้ตัวเลขออกมาเป็น `$0.181834`
     - ตัวเลข $0.181834 นี้เป็นตัวเลขคณิตศาสตร์ที่ **ลอยอยู่กลางอากาศ (Floating Floor)** โดยไม่มีสวิงรับหรือแท่งเทียนใดๆ รองรับ ทำให้เส้น Cut Loss และระดับ Buy Levels ลอยเคว้ง บอทเสี่ยงถูกตัดขาดทุนก่อนเวลาอันควร และไม่สามารถตั้งรับซื้อที่แนวรับจริง `⭐ HL` ได้
- **การแก้ไขและสถาปัตยกรรมใหม่**:
  1. **Active Wave HL Immediate Floor Eligibility (`isValleyEligibleForFloor`)**:
     - เพิ่มเงื่อนไขให้เหวที่เป็นสวิง Higher Low ที่ยืนยันแล้วในรอบคลื่นปัจจุบัน (`v.index >= activeWaveBaseIndex`) ซึ่งราคาปัจจุบันกำลังยืนอยู่เหนือระดับราคานั้น (`price >= v.price`) และยังไม่ถูกทำลาย (`isUnbrokenValley`) สามารถทำหน้าที่เป็น Floor ของกรอบราคาได้ทันทีในรอบคลื่นฟื้นตัว ไม่ต้องรอให้ราคาเบรกยอดเดิม
  2. **Elimination of Artificial Floating Floor in Max Span Clamping**:
     - ในจุดคำนวณ `upperBound - bottomBound > maxSpan`: ยกเลิกการใช้สูตรสังเคราะห์ตัวเลขลอย `bottomBound = upperBound - maxSpan` โดยเด็ดขาด
     - เปลี่ยนมาเป็นการค้นหาสวิงรับที่ยืนยันแล้วที่ยังไม่ถูกทำลายใต้ราคา (`unbrokenValleysBelow`) ที่อยู่ในระยะ `maxSpan` (เช่น `⭐ HL 0.188943`) มาทำหน้าที่เป็น Floor จริง
     - หากไม่มีสวิงรับย่อยอื่นใดใต้ราคา (มีเพียงฐานสวิงใหญ่ `LL 0.180470`): ระบบจะ **ล็อก Floor อยู่กับฐานสวิงจริงเสมอ (ไม่ยกมาลอยในอากาศ)** และปรับลดเพดานบน (`upperBound = Math.max(price * 1.0005, bottomBound + maxSpan)`) แทน เพื่อคงความปลอดภัยของ Cut Loss ที่ฐานแนวรับจริง 100%


---

### 23. Nearest Confirmed Valley Priority & Minimum Width Expansion (`src/market-structure.ts`)
- **สาเหตุของปัญหา**:
  1. **สวิงรับใกล้ราคาถูกคัดทิ้งเพราะแคบกว่า Min Span (`canReachMinSpanWithPeak` & `validWidthValleys`)**:
     - ใน `src/market-structure.ts`: เมื่อมีสวิงรับที่ยืนยันแล้วอยู่ใกล้ราคาปัจจุบันมาก (เช่น บนกราฟ ETHFDUSD มี `⭐ HL ~2420` อยู่ใต้ราคาปัจจุบัน $2429.57 เพียงเล็กน้อย)
     - แต่ระยะห่างระหว่างเพดาน `HH 2449.45` กับ `⭐ HL 2420` แคบเพียง 1.21% ซึ่งน้อยกว่า `minChannelWidthPct` (3.0%)
     - ตัวกรองเดิม `activeWaveReachableValleys` (ที่พึ่งพา `canReachMinSpanWithPeak`) และ `validWidthValleys` ตรวจพบว่า 1.21% < 3.0% จึง **คัดทิ้ง `⭐ HL 2420` ออกไป** แล้วกระโดดข้ามไปเลือกฐานก้นเหวมหึมาในอดีต `LL 2334.10` ที่อยู่ไกลถึง 4.94% เพียงเพราะความกว้างของมันถึง 3.0% พอดี
  2. **ผลกระทบของกรอบกว้างและไกลเกินไป (Oversized 4.94% Channel)**:
     - เส้น Floor (0% Low) ถูกกดลงไปลึกถึง $2,334.10 ส่งผลให้ Buy Level 4 ($2,347.83) และ Buy Level 5 ($2,336.39) อยู่ห่างจากราคาปัจจุบันเกือบ 4%
     - บอทต้องนั่งรอเฉยๆ (Waiting for Dip, Zone 83%) โดยไม่สามารถเข้าซื้อสะสมในรอบคลื่นย่อยตามแนวรับจริง `⭐ HL 2420` ได้เลย
- **การแก้ไขและสถาปัตยกรรมใหม่**:
  1. **Nearest Confirmed Valley in Active Wave Priority**:
     - ยึดสวิงรับที่ยืนยันแล้วที่ใกล้ราคาปัจจุบันที่สุดในคลื่นปัจจุบันก่อนเสมอ (`activeWaveValleys[0]`, เช่น `⭐ HL ~2420`)
     - ไม่ยอมให้ระบบกระโดดข้ามสวิงใกล้ไปหาสวิงไกลลิบ เพื่อให้กรอบราคาเกาะอยู่กับฐานโครงสร้างที่แท้จริงรอบราคาปัจจุบัน
  2. **Minimum Width Expansion (`curCeil = curFloor + minSpanFromPct`)**:
     - หากระยะห่างระหว่างสวิงใกล้แคบกว่า `minChannelWidthPct` (เช่น 1.21% < 3.0%):
       - ระบบจะคงฐานแนวรับ Floor ที่ใกล้ราคาไว้ (`Floor = 2420.00`)
       - และขยาย Ceiling ขึ้นไปเกาะยอดต้านถัดไป หรือขยายขึ้นไปให้ความกว้างของกรอบเท่ากับ `minChannelWidthPct` พอดี (3.0%)
       - ส่งผลให้กรอบราคาไม่บวมเป็น 4.94% และเส้น Buy Levels จะขยับขึ้นมาอยู่แถวๆ $2,422–$2,426 ใกล้ราคาปัจจุบัน พร้อมรองรับการย่อตัวเข้าซื้อได้ทันที


---

### 24. Prevention of Outdated LL Dragging Floor Downward (`src/market-structure.ts`)
- **สาเหตุของปัญหา**:
  1. **สวิง LL โบราณในอดีตกระชาก Floor กลับลงไปที่ก้นเหว (`lastCanonicalLow.dowLabel === "LL"` Override)**:
     - ใน `src/market-structure.ts` (เดิมบรรทัด 1684–1696): มีบล็อกตรรกะที่ตั้งใจปรับลด Floor เมื่อตลาดทำนิวโลว์:
       `if (isLatestLowLl && bottomBound > lastCanonicalLow.price) { bottomBound = lastCanonicalLow.price; }`
     - โค้ดเดิมไม่ได้ตรวจสอบว่า `lastCanonicalLow` เกิดขึ้น **หลังจาก `activeValley` หรือไม่**
     - แม้ว่าตรรกะ Nearest Valley จะยกฐาน `curFloor` ขึ้นมาเกาะที่ `⭐ HL ~2420.00` ได้สำเร็จแล้ว แต่เนื่องจากสวิงต่ำสุดของคลื่นในประวัติคือ `LL 2334.10` (ซึ่งมีป้ายเป็น `LL`) และ `2420 > 2334.10`
     - โค้ดบล็อกนี้จึงมองว่าเงื่อนไขเป็นจริง และ **เขียนทับ (Override) กระชาก Floor กลับลงไปที่ $2,334.10 ทุกครั้ง!** ทำให้หน้าจอแสดง Floor ค้างอยู่ที่ $2,334.10 และความกว้าง 4.94% ไม่ยอมเปลี่ยน
- **การแก้ไขและสถาปัตยกรรมใหม่**:
  1. **Strict Recency Guard for Lower Low Override**:
     - เพิ่มเงื่อนไข `(!activeValley || lastCanonicalLow.index > activeValley.index) && lastCanonicalLow.price < bottomBound`
     - การปรับลด Floor ลงไปรับ Lower Low จะทำงานได้ก็ต่อเมื่อเป็น **LL ที่เกิดขึ้นใหม่หลังจากฐาน `activeValley` ปัจจุบันเท่านั้น**
     - สวิง LL โบราณที่เกิดขึ้นก่อนหน้า `activeValley` จะไม่มีสิทธิ์ดึง Floor ถอยหลังกลับไปเด็ดขาด
     - ส่งผลให้ Floor ล็อกแน่นอยู่ที่ฐานแนวรับที่ใกล้ราคาปัจจุบัน (`⭐ HL ~2420.00`) อย่างถาวร และความกว้างกรอบจะเริ่มต้นจากความกว้างต่ำสุด (Minimum Width เช่น 3.0%) ตามที่ผู้ใช้ต้องการ 100%

---

### 25. Proximity-First & Minimum-Width Anchoring Architecture (`src/market-structure.ts`)
- **สาเหตุของปัญหาเดิม**:
  1. **กรอบราคาลอยกลางอากาศ (Floating Floor) หรือติดกับดักสวิงโบราณ (Macro Low Trap)**:
     - โค้ดเดิมใช้วิธีกำหนดเพดาน `curCeil` จากยอดสูงสุดของรอบคลื่นก่อนเสมอ แล้วจึงหาเหว `curFloor` มารองรับ
     - เมื่อราคาปัจจุบันอยู่ใกล้เหว (เช่น SOMI 0.198 ใกล้เหว 0.196) หรือราคาวิ่งย่อตัวลงมา แต่ยอดอยู่ห่างออกไปมาก ระบบจะพยายาม clamp ด้วย `maxSpan` ส่งผลให้คำนวณ `bottomBound = upperBound - maxSpan` จนเกิด Floor ลอยกลางอากาศที่ไม่มีสวิงรองรับ (เช่น 0.181834)
     - และในทางกลับกัน เมื่อราคาใกล้เหว แต่เหวใกล้แคบเกินไป โค้ดเดิมจะกระโดดข้ามไปดึงเหวโบราณในอดีต (เช่น 2334.10) มาเป็น Floor ทำให้กรอบบวมกว้าง 5%–7% โดยไม่จำเป็น
- **การแก้ไขและสถาปัตยกรรมใหม่ (Proximity-First & Minimum-Width Anchoring)**:
  1. **การตรวจสอบระยะใกล้-ไกล (Proximity Check)**:
     - วัดระยะห่างจากราคาปัจจุบันไปยังสวิงยอดที่ยืนยันแล้วเหนือราคา (`distToPeak = nearestPeak.price - price`) และสวิงเหวที่ยืนยันแล้วใต้ราคา (`distToValley = price - nearestValley.price`)
     - **ถ้าราคาอยู่ใกล้ยอดมากกว่า (`distToPeak < distToValley`)**:
       - ล็อก **ยอด (Peak)** เป็นแนวต้านหลักก่อน (`anchorSide = "UPPER_CEILING"`, `curCeil = nearestPeak.price`)
       - แล้วค้นหาเหวใต้ราคามาประกบคู่เป็น Floor
     - **ถ้าราคาอยู่ใกล้เหวมากกว่า (`distToValley <= distToPeak`)**:
       - ล็อก **เหว (Valley)** เป็นแนวรับหลักก่อน (`anchorSide = "LOWER_FLOOR"`, `curFloor = nearestValley.price`)
       - แล้วค้นหายอดเหนือราคามาประกบคู่เป็น Ceiling
  2. **เกณฑ์การเลือกคู่สวิงประกบ (Paired Swing Scoring)**:
     - กวาดดูสวิงทั้งหมดที่อยู่ฝั่งตรงข้าม ไม่ว่าจะใกล้หรือไกลย้อนอดีตไป:
       - **เลือกสวิงที่ใกล้ก่อน**: หากสวิงที่ใกล้ที่สุดให้ความกว้างอยู่ในเกณฑ์ `[minSpan, maxSpan]` ให้เลือกสวิงตัวนั้นทันที
       - **สวิงที่ไกลกว่าแต่ใกล้เคียง Min Width มากกว่า**: หากสวิงใกล้แคบเกินไป (< minSpan) แต่มีสวิงถัดไปในอดีตที่ให้ความกว้างใกล้เคียงกับ `minChannelWidthPct` มากกว่า ให้เลือกล็อกสวิงตัวนั้นทันที
  3. **การันตีความปลอดภัยและป้องกันราคาหลุดกรอบ (Safeguards)**:
     - หากสวิงทั้งหมดแคบกว่า `minSpan`: ขยายออกจากสมอหลัก (Primary Anchor) ให้ได้ระยะ `minSpan` พอดี
     - หากความกว้างเกิน `maxSpan`: จำกัดไม่ให้เกิน `maxSpan` โดยอ้างอิงจากสมอหลัก
     - ป้องกันราคาหลุดกรอบ: บังคับ `curCeil >= price * 1.0005` และ `curFloor <= price * 0.9995` เสมอ

---

### 26. Look-Left Primary Anchor, Narrowest Valid Width Selection, and Floating Bounds Elimination (`src/market-structure.ts`, `src/strategy.ts` & `public/app.js`)
- **สาเหตุของปัญหากรอบลอย ($0.1860) และการตัดสิทธิ์ HL**:
  1. **สูตรกรอบเทียมใน Fallback Branch (`price * (1 ± minPct / 2)`)**:
     - เมื่อระบบค้นหาคู่สวิงในเกณฑ์ `[minSpan, maxSpan]` ไม่พบ โค้ดเดิมในท่อน `else` คำนวณกรอบเทียมขึ้นมาลอยๆ กลางอากาศ:
       - `upperBound = price * (1 + 0.03 / 2) = 0.1888 * 1.015 = 0.191632` (Real Ceil: $0.1916)
       - `bottomBound = price * (1 - 0.03 / 2) = 0.1888 * 0.985 = 0.185968` (Real Floor: $0.1860)
     - ทำให้แดชบอร์ดวาดเส้นประ `Real Floor: 0.185968` ลอยอยู่กลางอากาศโดยไม่มีจุดสวิงเหวใดๆ รองรับ
  2. **ความผิดพลาดของ `resolveValley` ที่ตัดสิทธิ์ HL ทั้งหมด**:
     - โค้ดเดิมตั้งเงื่อนไข `if (distPct > minChannelWidthPct) return waveLl;` ทำให้เหว `HL` ทุกจุดที่ยกตัวสูงกว่า `LL` เกิน 3% (เช่น SOMI HL $0.189000$ สูงกว่า LL $0.178000$ อยู่ 6.18%) ถูกแทนที่ด้วย `LL $0.178000` ทั้งหมด
     - จากนั้นเมื่อนำ `0.178000` ไปจับคู่แล้วความกว้างบวมเกินเกณฑ์สูงสุด จึงหลุดไปเข้าท่อน `else` และสร้างตัวเลขลอยๆ `$0.1860` ขึ้นมา
- **การแก้ไขและสถาปัตยกรรมใหม่**:
  1. **ยกเลิกสูตรกรอบเทียมลอยๆ 100%**:
     - เมื่อไม่มีคู่สวิงจริงที่เข้าเกณฑ์ความกว้าง: กำหนด `isSwingConfirmed = false`, `upperBound = 0`, `bottomBound = 0` และไม่ส่งค่า `liveCalculatedBottomBound` / `liveCalculatedUpperBound` ไปยังฟรอนต์เอนด์ เพื่อไม่ให้วาดเส้นประลอยในอากาศ
  2. **สแกนหาสวิงจริงจากจุดเริ่มมองย้อนไปทางซ้าย (Scan Backwards from Primary Anchor)**:
     - รวมสวิง Low ทั้งหมดที่อยู่ใต้ราคาเข้า `candidateLows` โดยไม่ตัดสิทธิ์ HL ล่วงหน้า
     - **ถ้าเจอยอดก่อน**: เริ่มจากยอดล่าสุด `mostRecentHigh` แล้วสแกนหาเหวใน `candidateLows` ที่ให้ความกว้างอยู่ในเกณฑ์ `[minSpan, maxSpan]` โดยเลือกเหวที่แคบที่สุดก่อน
       - ใน ETH: สวิง HL ($2,420$) แคบเกินไป ($1.21\% < 3\%$) จึงถูกข้าม และระบบเลือก `LL $2,334.10` ($4.94\%$) เป็น Floor ตรงตามชาร์ต
       - ใน SOMI: สวิง HL ($0.189000$) ให้ความกว้างกับเพดาน ($0.195800$) อยู่ที่ $3.59\%$ (เข้าเกณฑ์ $3\% - 10\%$) จึงถูกเลือกเป็น Floor จริง $0.189000$ ทันที
     - **ถ้าเจอเหวก่อน**: เริ่มจากเหวล่าสุด `mostRecentLow` แล้วสแกนหายอดใน `candidateHighs` ที่ให้ความกว้างอยู่ในเกณฑ์
  3. **การทำงานเมื่อบอทมีของอยู่ vs ไม่มีของ (Holding Position vs Flat Cash)**:
     - **เมื่อถือของอยู่ (`isHoldingPosition === true`)**:
       - บอท **ห้ามหยุดเล่นเด็ดขาด**! ระบบจะใช้ `this.lockedChannel` (`Floor: 0.189000`, `Ceiling: 0.195800`) บริหารจัดการไม้ต่อไปอย่างต่อเนื่อง
       - คำสั่งขายทำกำไร (Sell Targets: 52%, 62%, 72%, 82%, 92%), เพดาน Take Profit (100%), และ Floor Buffer Cut Loss ยังคงทำงานครบถ้วนสมบูรณ์
     - **เมื่อไม่มีของ (`100% Cash`)**:
       - หากหาสวิงจริงที่เข้าเกณฑ์ไม่ได้ บอทจะเข้าสู่โหมด `[Paused: Waiting for Dow Swings]` / `⚪ ไม่มีกรอบสวิงที่เข้าเกณฑ์ (หยุดรอสวิง)` ไม่เปิดไม้ใหม่จนกว่าจะมีโครงสร้างสวิงจริง




---

### 27. Dynamic Channel Shift Buy Level 2 Target Reset & Recovery (`src/strategy.ts` & `src/db.ts`)
- **สาเหตุของปัญหา**:
  1. **เป้าหมาย Buy Level 2 ค้างที่ Floor เดิมเมื่อราคาหลุดกรอบ (`breakdownBuyLevel2Price` State Loss)**:
     - เมื่อราคาหลุด Floor เดิม (เช่น $2422.5100) บอทเข้าสู่โหมด `waitingForHigherLow = true`
     - แต่ข้อความแสดงบนสถานะและแถบควบคุมระบุ `Wait HL > $2422.2000 or Stand above Buy 2 ($2422.5100)` ซึ่งราคาเป้าหมาย Buy 2 ดันเป็นราคาเดียวกับ Floor ที่หลุด ($2422.5100)
     - สาเหตุเกิดจาก `this.breakdownBuyLevel2Price` ไม่ได้ถูกกำหนดใน Interface `StrategyStateRecord` ใน `src/db.ts` และไม่ได้ถูกบันทึก/โหลดใน `saveState()` และ `loadState()` ของ `DynamicGrid`
     - เมื่อค่าเป็น `undefined` โค้ดคำนวณจึงตกลงไปใช้ fallback: `originalBrokenL2 = this.breakdownBuyLevel2Price ?? this.breakdownFloorPrice` ซึ่งกลายเป็นตัวเลข Floor เดิม ($2422.5100)
  2. **เมื่อกรอบราคาขยับ (Channel Shift) เป้าหมาย Buy Level 2 ไม่ได้ขยับตามกรอบใหม่**:
     - เมื่อแท่งเทียนปิดและสร้างโครงสร้างกรอบราคาใหม่ (เช่น Floor: $2416.33, Ceiling: $2495.58) ระดับ Buy Level 2 ของกรอบใหม่อยู่ที่ `$2441.69`
     - แต่ระบบเดิมไม่มีตรรกะตรวจจับการปรับกรอบเพื่ออัปเดต `this.breakdownBuyLevel2Price` ส่งผลให้เป้าหมายการ Recovery ยังคงยึดติดอยู่กับกรอบเก่า
- **การแก้ไขและสถาปัตยกรรมใหม่**:
  1. **Persistence & State Sync (`src/db.ts` & `src/strategy.ts`)**:
     - เพิ่ม `breakdownBuyLevel2Price?: number;` ลงใน `StrategyStateRecord` ใน `src/db.ts`
     - บันทึกและกู้คืน `breakdownBuyLevel2Price` ใน `loadState()` และ `saveState()` ใน `src/strategy.ts` ป้องกันการสูญหายของ State เมื่อรีสตาร์ทบอท
  2. **Dynamic Channel Shift Reset**:
     - ใน `src/strategy.ts`: เมื่อเกิดการปรับกรอบราคาในแท่งเทียนปิดสมบูรณ์ (`adjustOnClosedOnly` candle close) หากอยู่ในสถานะ `waitingForHigherLow` ระบบจะรีเซ็ต `this.breakdownBuyLevel2Price = buyLevels[1]` ให้ตรงกับ Buy Level 2 ของกรอบใหม่ทันที (เช่น $2441.69)
     - มี Log แสดงชัดเจน: `🔄 [CHANNEL SHIFT] Updated recovery Buy Level 2 to new channel L2: $... (Floor: $...)` และเซฟลง DB ทันที
  3. **New Channel Buy Level 2 Recovery Target**:
     - ปรับปรุงการคำนวณ `effectiveBuyLevel2Target` ให้ใช้ `currentBuyLevel2 = buyLevels[1]` ของกรอบปัจจุบันเป็นอันดับแรก
     - เมื่อแท่งเทียนที่ยืนยันแล้วปิดราคาเหนือ Buy Level 2 ของกรอบใหม่ ($2441.69) ระบบจะยืนยันการฟื้นตัว ปลดล็อก `waitingForHigherLow = false` และกลับมาเข้าซื้อสะสมในกรอบใหม่อย่างปลอดภัยตามความต้องการของผู้ใช้


---

### 28. Flat Cash Channel Shift & Downtrend LL Prevention Architecture (`src/strategy.ts`, `src/market-structure.ts` & `src/db.ts`)
- **สาเหตุของปัญหา**:
  1. **การเข้าซื้อมีดร่วง (Falling Knife) เมื่อพอร์ตว่าง 100% Cash หลังขายหมด**:
     - เมื่อบอทขายทำกำไรหรือขายหมดพอร์ต (`100% Cash / held = 0 / 0 lots`) พอร์ตไม่มีความเสี่ยง
     - เมื่อแท่งเทียนปิดและมีการปรับกรอบราคาใหม่ (Channel Shift เช่น SOMI: Floor $0.187300, Ceiling $0.193800) ระดับเส้นซื้อ Buy Level 4 ($0.1880) และ Buy Level 5 ($0.1874) อยู่ใกล้ชิดติดกับ Floor ($0.187300, ห่างเพียง 0.06%)
     - ระหว่างที่ราคารูดลงมาจากยอด $0.1930 โดยยังไม่มีสวิงกลับตัวหรือฐาน Higher Low (`HL`) ใดๆ มารองรับ โค้ดเดิมปล่อยให้เข้าซื้อ IOC Buy Level 4 และ Buy Level 5 จนเต็มงบ 100%
     - ส่งผลให้เพียงไม่กี่นาทีถัดมา ราคาไหลหลุด Floor $0.187300 เพียงเล็กน้อย ทำให้บอทติดสถานะ `Cut Loss Confirming` ทันทีและเกิดความเสียหายโดยไม่จำเป็น
  2. **ตัวตรวจจับคลื่นขาลง (`isConfirmedDowntrendWave`) มองข้ามคลื่นที่ลงท้ายด้วย LL**:
     - ใน `src/market-structure.ts`: โค้ดเดิมตรวจจับเฉพาะ `waveCycle.activeCycleSummary?.includes("LH + LL")`
     - หากคลื่นเป็นไซด์เวย์ที่รูดลงทำนิวโลว์ เช่น `รอบคลื่น: ไซด์เวย์ (HH ➔ LL)` หรือ `(LH ➔ LL)` ระบบจะไม่ถือว่าเป็นคลื่นขาลง ทำให้ `isDowntrendDropActive` และ `downtrendDropPaused` ไม่ทำงาน
- **การแก้ไขและสถาปัตยกรรมใหม่**:
  1. **ขยายการตรวจจับคลื่นขาลงครอบคลุมทุกคลื่นที่มี LL (`src/market-structure.ts`)**:
     - ปรับ `isConfirmedDowntrendWave` ให้ตรวจสอบ `waveCycle.activeCycleSummary?.includes("LL")` ทำให้คลื่น `HH ➔ LL` และ `LH ➔ LL` ถูกตรวจจับเป็นคลื่นขาลงที่เสี่ยงทำ Lower Low ทันที
  2. **Flat Cash & Channel Shift LL Guard (`src/strategy.ts` & `src/db.ts`)**:
     - เมื่อบอทถือเงินสด 100% (`isFlatCash = !isHoldingPosition && this.lots.length === 0`) และเกิดการปรับกรอบราคาใหม่ (`isChannelChanged`) หรือเพิ่งขายหมดพอร์ต (`justSoldOut`):
     - ระบบจะประเมินความเสี่ยงของการทำ LL ใหม่ (`hasRiskOfNewLl`):
       - รอบคลื่นมีป้าย `LL` (`activeCycleSummary.includes("LL")` หรือ `lastAnnotatedLow.dowLabel === "LL"`)
       - ยอดล่าสุดเป็น `LH` (Lower High สะท้อนแรงขายกดตัว)
       - ขอบล่างกรอบใหม่ต่ำลง (`newFloor < prevFloor * 0.999`)
       - `isDowntrendDropActive` หรือ `regime === "DOWNTREND"`
       - ราคากำลังไหลลงจากยอดโดยที่ยังไม่มีสวิง Higher Low (`HL`) ที่ยืนยันแล้วเหนือ Floor
     - หากตรวจพบความเสี่ยง: สั่งเปิดโหมดรอตั้งฐาน `waitingForHigherLow = true` และตั้งแฟล็ก `isFlatChannelShiftWaiting = true` พร้อมเซฟลง DB ทันที
     - บอทจะหยุดการเข้าซื้อทุกระดับ ไม่รับมีดร่วง และแสดงสถานะอย่างโปร่งใส: `🛡️ รอตั้งฐาน HL (100% Cash) | 100% Cash • กรอบเปลี่ยน/เสี่ยงทำ LL`
  3. **เงื่อนไขการปลดล็อกกลับมาเข้าซื้อสะสมอย่างปลอดภัย (Triple Recovery Engine)**:
     - 1. ยืนยันการสร้างฐาน **Higher Low (HL)** ที่ยกตัวสูงขึ้นเหนือจุดต่ำสุดของการทุบหรือเหนือ Floor
     - 2. ราคาแท่งเทียนปิดสมบูรณ์ยืนเหนือ **Buy Level 2** ของกรอบใหม่
     - 3. เกิดการ **Breakout ทะลุเส้น Downtrend Line**
     - เมื่อเข้าเงื่อนไขใดเงื่อนไขหนึ่ง ระบบจะปลดล็อก `waitingForHigherLow = false` และเริ่มสะสมกริดบนฐานแนวรับที่มั่นคง 100%

---

### 29. True Swing-Pair Percentage Width Calculation & False Floor Alert Cleanup (`src/market-structure.ts` & `src/strategy.ts`)
- **สาเหตุของปัญหา**:
  1. **การคำนวณระยะห่างขั้นต่ำผิดพลาดโดยนำราคาปัจจุบัน (`refPrice`) ไปคูณ `%`**:
     - ใน `src/market-structure.ts`: เดิมคำนวณ `minSpan = price * minPct` (เช่น `2396.6 * 0.03 = 71.898`) แล้วนำไปเปรียบเทียบกับความกว้างของคู่สวิง `w = p.price - v.price >= minSpan`
     - ส่งผลให้เมื่อยอดคือ `$2433.00` และเหวคือ `$2361.18` (ระยะห่างจริง `w = 71.82 USD` ซึ่งคิดเป็น `%` จากเหวคือ `(2433 - 2361.18) / 2361.18 = 3.0417%` ซึ่งผ่านเกณฑ์ `minChannelWidthPct = 3.0%` จริงๆ)
     - แต่เนื่องจากราคาปัจจุบันวิ่งขึ้นไปอยู่ที่ `$2396.60` ทำให้ `minSpan = 71.898 USD` ระบบจึงมองว่า `71.82 < 71.898` (ขาดไปเพียง 0.08 USD) และปฏิเสธเหว `$2361.18` แล้วไหลลงไปเลือกก้นเหวมหึมา `LL $2334.10` ด้านล่างแทน ทำให้กรอบบวมเป็น 4.24%
  2. **การแจ้งเตือนผิดพลาด `Price < 0% Floor` ทั้งที่ราคาอยู่สูงกว่า Floor จริง**:
     - ใน `src/strategy.ts` (เดิมบรรทัด 2599): `isBelowFloor` มีเงื่อนไขแฝง `|| (this.waitingForHigherLow && this.breakdownFloorPrice !== undefined && refPrice < this.breakdownFloorPrice)`
     - ซึ่ง `this.breakdownFloorPrice` ยังคงเก็บค่า Floor ของรอบก่อนหน้า (`$2422.51`) ไว้ ทำให้เมื่อราคาหลุดรอบก่อนแล้วเกิดกรอบใหม่ที่ Floor `$2334.10` แม้ราคาปัจจุบัน `$2396.60` จะอยู่สูงกว่า Floor ใหม่ถึง 62.5 ดอลลาร์ แต่ระบบยังมองว่า `2396.60 < 2422.51` และขึ้นข้อความผิดพลาดว่า `Price < 0% Floor ($2334.1000)`
- **การแก้ไขและสถาปัตยกรรมใหม่**:
  1. **True Percentage Width Calculation Directly Between Candidate Swings (`src/market-structure.ts`)**:
     - คำนวณ `%` ความกว้างระหว่างคู่สวิง Peak และ Valley โดยตรง:
       `const wPct = ((p.price - v.price) / v.price) * 100;`
       และตรวจสอบ `wPct >= minChannelWidthPct && wPct <= maxChannelWidthPct;`
     - ยกเลิกการนำราคาปัจจุบัน (`price`) มาคูณแปลงเป็น `minSpan / maxSpan` ในการคัดเลือกคู่สวิงกรอบราคาโดยเด็ดขาด ทำให้การวัดระยะห่างสะท้อนสัดส่วนจริงของโครงสร้างสวิง 100%
     - ส่งผลให้ยอด `$2433.00` และเหว `$2361.18` (กว้าง 3.04%) ผ่านเกณฑ์ความกว้างขั้นต่ำ (3.0%) และถูกเลือกล็อกเป็นกรอบราคาที่แคบที่สุดได้ถูกต้องทันที
  2. **Cleanup of `isBelowFloor` Evaluation (`src/strategy.ts`)**:
     - ปรับให้ `isBelowFloor = isChannelReady && refPrice < lowerBound;` เทียบกับ Floor ของกรอบปัจจุบันเท่านั้น ไม่นำ `this.breakdownFloorPrice` ของรอบก่อนหน้ามาปะปน
     - ป้องกันการแจ้งเตือนผิดพลาดบนหน้าเว็บแดชบอร์ด

---

### 30. Strict Primary Anchor Locking & Elimination of Fallback Scan Across Waves (`src/market-structure.ts`)
- **สาเหตุของปัญหา**:
  1. **ลูปสแกนย้อนอดีตกระโดดข้ามสวิงล่าสุดไปขุดสวิงเก่า (Fallback Scan Loop)**:
     - ใน `src/market-structure.ts`: เมื่อระบบมองย้อนไปทางซ้ายแล้วเจอยอดแรกคือ **จุดที่ 1 (`mostRecentHigh`, เช่น SOMI $0.1908)**
     - เมื่อนำจุดที่ 1 ไปหาเหวใต้ราคาที่อยู่ในเกณฑ์ `3.0% – 5.0%` ปรากฏว่าเหว `$0.1873` ได้ความกว้างเพียง $1.87\%$ (แคบเกินไป) ส่วนก้นเหว `$0.1790` ได้ความกว้าง $6.59\%$ (กว้างเกินไป) ทำให้จุดที่ 1 ไม่มีเหวที่เข้าเกณฑ์
     - โค้ดเดิมใช้ลูป `for (const p of sortedHighsByRecency)` ถอยหลังย้อนอดีตไปเรื่อยๆ จนไปขุดเอายอดเก่าที่จบไปแล้วคือ **จุดที่ 2 (`$0.193300`)** ที่มีระยะห่างกับเหว `$0.1873` อยู่ $3.20\%$ พอดี
     - ส่งผลให้ระบบกระโดดข้ามยอดปัจจุบัน (จุดที่ 1) ไปสวมเอายอดโบราณ (จุดที่ 2) มาเป็น Ceiling และปลุกกรอบเก่าขึ้นมาเล่นใหม่ ทั้งๆ ที่ตลาดกำลังวิ่งอยู่ในคลื่นย่อยของจุดที่ 1
  2. **ความสับสนบนหน้าจอแดชบอร์ด (กรอบปรับไปปรับมา)**:
     - ช่วงแรก: ก่อนแท่งเทียนยืนยัน ระบบรายงาน `Channel: ไม่มีกรอบที่เข้าเกณฑ์ (หยุดสร้าง)`
     - ช่วงต่อมา: ลูปสแกนย้อนอดีตไปขุดยอดจุดที่ 2 กลับมา ทำให้จู่ๆ ก็บอกว่า "มีกรอบแล้ว 3.20%" สลับไปสลับมา
- **การแก้ไขและสถาปัตยกรรมใหม่**:
  1. **Strict Primary Anchor Without Fallback Across Waves (`src/market-structure.ts`)**:
     - ยกเลิกลูปสแกนถอยหลัง `for (const p of sortedHighsByRecency)` และ `for (const v of sortedLowsByRecency)` ทั้งหมด
     - **กรณีเจอยอดก่อน**: ยึดยอดล่าสุด (`mostRecentHigh`, จุดที่ 1) เป็นตัวตั้งแนวต้านหลักเท่านั้น และค้นหาเหวใต้ราคา
       - หากพบเหวที่ให้ความกว้างอยู่ในเกณฑ์ `[minChannelWidthPct, maxChannelWidthPct]` $\rightarrow$ สร้างกรอบเล่นได้ตามปกติ
       - หากยอดล่าสุดไม่มีเหวที่เข้าเกณฑ์ $\rightarrow$ **"หยุดเล่นทันที (ไม่มีกรอบ / WARMUP)"** ห้ามกระโดดข้ามไปขุดเอายอดเก่าในอดีตมาเล่นเด็ดขาด
     - **กรณีเจอเหวก่อน**: ยึดเหวล่าสุด (`mostRecentLow`) เป็นตัวตั้งแนวรับหลักเท่านั้น หากไม่มีสวิงยอดใดที่เข้าเกณฑ์ $\rightarrow$ **"หยุดเล่นทันที"** ไม่ถอยหลังไปขุดเหวเก่า


---

### 31. Strict Maker Limit Execution, Elimination of Resistance IOC Hijack & Guaranteed Profitable Take Profit Architecture (`src/strategy.ts`)
- **สาเหตุของปัญหา**:
  1. **ปัญหาเครื่อง 3334 (Binance Spot `MAKER_LIMIT` mode)**:
     - บอทถูกตั้งค่าเป็น `MAKER_LIMIT` เพื่อใช้สิทธิ์ค่าธรรมเนียม Maker 0% บน Binance Spot แต่เมื่อราคาเด้งขึ้นไปใกล้แนวต้าน Trendline หรือ Real S/R Ceil:
       - ใน `syncRestingOrders` (บรรทัด 4898–4903 เดิม): มีเงื่อนไข `isNearTL && existingTlSell` ซึ่งสั่งยกเลิกออเดอร์ขาย Maker ทันทีที่ราคาแตะระดับต้าน (`cancelling resting sell for immediate IOC exit`)
       - ใน `Resistance IOC Exit` (บรรทัด 3838–3908 เดิม): โค้ดไม่ได้ตรวจสอบ `orderExecutionMode === "MAKER_LIMIT"` ทำให้สั่งยิงคำสั่งขาย `sellAll(..., "SELL")` เป็น IOC Taker Market Order ซ้ำๆ
       - ส่งผลให้บอทตั้งซื้อแบบ Maker สำเร็จ แต่พอขายกลับขายเป็น Taker ตลอดเวลา โดนค่าธรรมเนียม Taker Fee กินกำไรจนติดลบ (`-$4.22`)
  2. **ปัญหาเครื่อง 3333 (DreamDEX SOMI/USDso - ซื้อแล้วขายขาดทุนแต่ติดป้าย TAKE PROFIT)**:
     - บอทซื้อ SOMI ที่ $0.1874 จากนั้นราคาหลุดก้นกรอบลงไป $0.1862 แล้วเด้งกลับมา $0.1869 บอททำการขายออกทั้งหมดที่ $0.1869 (ขาดทุน `-$0.24`) แต่ขึ้นป้ายว่า `100% FULL EXIT (TAKE PROFIT)`:
       - ใน `takeProfitAtUpperBound`: บรรทัด 2974 เดิมใช้เงื่อนไข `if (!isProfitableExit && !isLhEscapeReached)` เมื่อ `isLhEscapeReached` เป็นจริง ทำให้ข้ามการบล็อก `!isProfitableExit` หลุดเข้าไปในบล็อก `else` และสั่งยิง `sellAll`
       - ใน `sellAll` (บรรทัด 6511 เดิม): มีเงื่อนไข `minProfitablePrice` คุ้มครองทุนเฉลี่ยเฉพาะเมื่อ `sellProfitMode === "PORTFOLIO_AVG_PROFIT"` เท่านั้น หากเป็นโหมดเริ่มต้น `GRID_CASHFLOW` ระบบยอมให้ขายต่ำกว่าทุนเฉลี่ยได้
       - ในการปั๊มป้ายออเดอร์ (บรรทัด 6417 และ 6587 เดิม): คำสั่งที่ไม่ได้เป็น `CUT` หรือ `MANUAL` จะถูกปั๊มป้าย `TAKE_PROFIT` และ `100% FULL EXIT (TAKE PROFIT)` ทั้งหมดโดยไม่ดู PnL จริง
  3. **คำถามเรื่องราคาเข้าซื้อ $0.1874 สูงกว่า Buy Level**:
     - ออเดอร์ซื้อที่ราคา $0.1874 เกิดขึ้นขณะที่กรอบเดิมมี Floor $0.1873 และ Ceiling $0.1918 ซึ่ง Buy Level 4 ของกรอบนั้นอยู่ที่ $0.18784 (ราคา $0.1874 อยู่ต่ำกว่า Buy Level 4 จริง ณ จังหวะนั้น)
     - แต่หลังจากนั้นราคาหลุด Floor ลงไปที่ $0.1862 ระบบจึงคำนวณกรอบใหม่โดยมี Floor ต่ำลง ทำให้ Buy Level 4 ของกรอบใหม่ขยับลงมาอยู่ที่ $0.1868 ผู้ใช้จึงมองเห็นว่าซื้อแพงกว่า Buy Level ในปัจจุบัน
- **การแก้ไขและสถาปัตยกรรมใหม่ (`src/strategy.ts`)**:
  1. **Strict Maker Limit Resistance Execution (เครื่อง 3334)**:
     - ใน `Resistance IOC Exit`: บังคับเช็ค `const isIocModeForRes = this.cfg.orderExecutionMode === "IOC_BRACKET"` ตัดระบบยิง IOC Taker Sell ออก 100% เมื่อบอทรันในโหมด `MAKER_LIMIT`
     - ใน `syncRestingOrders`: ลบเงื่อนไขยกเลิกออเดอร์ `isNearTL && existingTlSell` ออกทั้งหมด เพื่อให้ออเดอร์ Maker Sell ที่วางไว้ใต้แนวต้านคงอยู่บน Orderbook และถูกจับคู่ (Fill) ในฐานะ Maker รับค่าธรรมเนียม 0% เสมอ
     - ใน `takeProfitAtUpperBound`: ในโหมด `MAKER_LIMIT` หากยังมี Resting Sell Orders วางรออยู่บนกระดาน จะไม่ถูกแย่งปิดด้วย IOC `sellAll` ปล่อยให้ออเดอร์ขาย Maker ทำงานอย่างสมบูรณ์
  2. **Guaranteed Profitable Take Profit & Elimination of Loss Bypass (เครื่อง 3333)**:
     - ใน `takeProfitAtUpperBound`: ปรับเงื่อนไขเป็น `if (!isProfitableExit) { ... return; }` เด็ดขาด โดยไม่ให้ `isLhEscapeReached` มาเป็นข้อยกเว้น การทำ Take Profit / Dynamic Escape ทุกรูปแบบต้องได้ราคาปิดที่ทำกำไรสุทธิเหนือทุนเฉลี่ย (`avgEntryPrice * (1 + minTpProfitPct / 100)`) เสมอ
     - ใน `sellAll`: เมื่อ `action === "SELL"` บังคับ `minProfitablePrice = avgEntry > 0 ? avgEntry * minProfitMult : minAllowedBySlippage` ครอบคลุมทุกโหมดกำไร ป้องกันไม่ให้ส่ง Limit Price ต่ำกว่าทุนเฉลี่ย
     - **Truthful Order Action & Labeling**: ตรวจสอบ PnL จริง (`roundPnl >= 0 ? "TAKE_PROFIT" : "BREAKDOWN_EXIT"`) และป้ายกำกับ (`roundPnl >= 0 ? "100% FULL EXIT (TAKE PROFIT)" : "BREAKDOWN EXIT (LOSS)"`) หากมีคำสั่งใดที่ปิดต่ำกว่าทุน จะไม่มีการติดป้ายเท็จว่าเป็น TAKE PROFIT อีกต่อไป

---

### 32. Accurate Candidate Swing Confirmation Counting on Confirmed Candles (`src/market-structure.ts`)
- **สาเหตุของปัญหา**:
  1. **การนับแท่งยืนยัน Candidate ผิดพลาดเป็น `0/3` แทนที่จะเป็น `1/3`**:
     - ใน `src/market-structure.ts` ฟังก์ชัน `getStructure()`: เมื่อเปิดใช้งานสถาปัตยกรรม `adjustChannelOnClosedOnly: true` อาร์เรย์ `candles` ถูกส่งมาจาก `getClosedCandles()` ซึ่งได้ตัดแท่งเทียนที่ยังไม่ปิดออกไปแล้ว 1 แท่ง
     - แต่ในลูปตรวจจับ Candidate Swings (บรรทัด 1188 เดิม): เขียนฮาร์ดโค้ดไว้ว่า `const followingClosedCandles = Math.max(0, (n - 2) - idx);` เพราะตั้งสมมติฐานเดิมว่าแท่งสุดท้าย `n - 1` เป็นแท่งเปิดที่ยังไม่ปิดเสมอ
     - ส่งผลให้เกิดการหักลบซ้ำสองครั้ง (`- 2`) ตัดแท่งเทียนที่เพิ่งปิดสมบูรณ์ (`08:15`) ทิ้งไป ทำให้แท่ง Candidate (`08:00` ไส้ยาว Low `$2,376.94`) คำนวณได้ `(301 - 2) - 299 = 0` และแสดงผลเป็น `⏳ 0/3` ทั้งๆ ที่แท่ง `08:15` ปิดแท่งยืนยันไปแล้ว
     - ในลูปตรวจสอบขอบขวา (บรรทัด 1201 และ 1233 เดิม) ใช้ `Math.min(n - 2, idx + k)` ข้ามการตรวจสอบแท่ง `n - 1` ที่ปิดแล้วไปด้วย
- **การแก้ไขและสถาปัตยกรรมใหม่ (`src/market-structure.ts`)**:
  1. **Dynamic `lastClosedIdx` Resolution**:
     - คำนวณดัชนีแท่งปิดล่าสุดตามความเป็นจริง:
       `const lastClosedIdx = (options?.useOnlyClosedCandles || candles[n - 1]?.isClosed === true) ? n - 1 : n - 2;`
  2. **Accurate Following Closed Candles Count**:
     - คำนวณ `const followingClosedCandles = Math.max(0, lastClosedIdx - idx);`
     - ทำให้เมื่อแท่งถัดมาปิดสมบูรณ์ 1 แท่ง จะนับได้ 1 และแสดงผลเป็น **`⏳ 1/3`** ถูกต้องทันที และเมื่อปิดครบ 2 แท่งจะแสดง **`⏳ 2/3`** จนกระทั่งครบ 3 แท่งจึงยืนยันเป็นสวิงถาวร
  3. **Full Right-Side Closed Candle Scan & Live Candle Guard**:
     - วนลูปตรวจสอบแท่งปิดด้านขวาครบถึง `Math.min(lastClosedIdx, idx + k)`
     - ตรวจสอบแท่งเทียนที่กำลังวิ่งอยู่ (`liveCandle`) ว่าหากไส้เทียนปัจจุบันทะลุราคา Candidate จะไม่อนุมัติเป็น Candidate ทันที

---

### 33. Immediate Structural Swing Confirmation on 3rd Closed Candle & Automated Version Tracking Architecture
- **สาเหตุของปัญหา**:
  1. **สวิงยืนยัน (LL, HL, HH, LH) ล่าช้าไป 1 แท่ง (15 นาที) หลังแท่งที่ 3 ปิดสมบูรณ์**:
     - ใน `src/market-structure.ts` ฟังก์ชัน `recalculateSwings()`: มีการฮาร์ดโค้ดสูตร `const maxConfirmedIdx = n - 2 - k;` โดยตั้งสมมติฐานว่าแท่ง `n - 1` เป็นแท่งที่ยังไม่ปิดเสมอ
     - เมื่อแท่งที่ 3 (เช่น แท่ง 09:00 น.) เพิ่งปิดสมบูรณ์และถูกบันทึกลงฐานข้อมูล `this.candles[n - 1].isClosed === true` อาร์เรย์ `this.candles` มีความยาว `n = 301` ทำให้สูตรคำนวณ `301 - 2 - 3 = 296`
     - แท่งต่ำสุด (08:15 น. Low `$0.1847` ดัชนี 297) จึงไม่ถูกยืนยัน (`297 <= 296` เป็นเท็จ) ส่งผลให้เกิด **"หลุมดำ (No Man's Land)"** คือไม่เป็นทั้ง Candidate (เพราะปิดครบ 3 แท่งแล้ว) และยังไม่เป็น Confirmed Swing จนกว่าจะมีแท่งใหม่วิ่งเข้ามาอีก 15 นาที
     - ตัวกรองสวิงใน `getStructure()` เดิมใช้ `.filter((s) => s.index < n - 1)` เผลอตัดสวิงที่ยืนยันบนแท่งปิดล่าสุดทิ้งไปอีกชั้นหนึ่ง
  2. **ไม่มีการแสดง Version และ Git Commit Hash บนบอทและหน้าแดชบอร์ด**:
     - ทำให้เมื่อผู้ใช้หรือผู้พัฒนาเข้าไปตรวจสอบบอทที่รันอยู่บนเซิร์ฟเวอร์ (เช่น Port 3333 / 3334) ไม่สามารถระบุได้ทันทีว่าโค้ดที่รันอยู่เป็น Commit เดียวกันกับ Git ล่าสุดหรือไม่
- **การแก้ไขและสถาปัตยกรรมใหม่**:
  1. **Immediate Swing Confirmation on 3rd Closed Candle (`src/market-structure.ts`)**:
     - ปรับการคำนวณ `lastClosedIdx` ใน `recalculateSwings()` ให้ตรวจสถานะแท่งเทียนปิดจริง:
       ```typescript
       const lastClosedIdx = this.candles[n - 1]?.isClosed === true ? n - 1 : n - 2;
       const maxConfirmedIdx = lastClosedIdx - k;
       ```
     - ตรวจสอบขอบขวาของสวิงยืนยันจนถึง `Math.min(lastClosedIdx, i + k)` และปรับตัวกรองใน `getStructure()` เป็น `.filter((s) => s.index < n)`
     - ทันทีที่แท่งที่ 3 ปิดสมบูรณ์ สวิงจะเปลี่ยนสถานะจาก Candidate สู่การติดป้าย `LL` / `HL` / `HH` / `LH` ทันทีในระดับมิลลิวินาที ไม่มีความล่าช้า 15 นาทีอีกต่อไป
  2. **Automated Version & Git Commit Tracking Architecture (`src/version.ts`, `src/server.ts`, `public/index.html`, `public/app.js`)**:
     - สร้างโมดูล `src/version.ts` ดึง Git Commit Hash สั้น (`git rev-parse --short HEAD`), วันที่ Commit ล่าสุด และเวอร์ชันจาก `package.json` (อัปเกรดเป็น `v0.2.0`) อัตโนมัติ พร้อมระบบ Fallback
     - เพิ่ม API Endpoint `GET /api/version` และผนวก `versionInfo` เข้าใน `GET /api/state` และ WebSocket / SSE Telemetry Tick
     - เพิ่มป้าย Badge `🏷️ v0.2.0 (commit)` บน Header แถบนำทางด้านบนของหน้าเว็บแดชบอร์ด พร้อม Tooltip แสดงวันที่อัปเดตและสามารถคลิกเพื่อเปิดดู `/api/version` ได้ทันที
