# dynamic-grid — Project Knowledge (ของ Tenixe Agent)

ไฟล์นี้สรุปความเข้าใจโปรเจกต์จากการอ่านโค้ดและเอกสาร ใช้แยกจาก `GEMINI.md` (ซึ่งยาวประมาณ 1.8 MB และเป็นบันทึกประวัติการแก้ไขเดิม)
หากข้อมูลในไฟล์นี้ขัดแย้งกับโค้ดจริง ให้ยึดโค้ดเป็นหลัก

## 1. ภาพรวม

- ชื่อแพ็กเกจ `dynamic-grid` เวอร์ชัน `0.3.0.64` (`package.json`), ใช้ ESM (`"type": "module"`)
- บอทเทรดแบบ Dynamic Grid + Dow Theory
  - **Binance Spot (CEX)**: ค่าเริ่มต้น ใช้ REST + HMAC SHA-256, WebSocket kline/bookTicker, User Data Stream
  - **DreamDEX on Somnia (DEX)**: on-chain ผ่าน `viem` (ยังมีโค้ดอยู่ แต่ใน `src/exchange/index.ts` เลือกได้ด้วย `EXCHANGE=dreamdex`)
  - **Alpaca**: มีโฟลเดอร์ `src/exchange/alpaca/` และ switch ใน factory
- มี Web Dashboard แบบ real-time (SSE/WebSocket) ที่ `http://localhost:3333` (ค่าเริ่มต้น)

## 2. คำสั่งที่ใช้บ่อย

| คำสั่ง | หน้าที่ |
| :--- | :--- |
| `npm install` | ติดตั้ง dependencies |
| `npm run typecheck` | `tsc --noEmit` ตรวจชนิดข้อมูล |
| `npm start` | รันบอท (`tsx src/index.ts`) และเปิด dashboard |
| `npm run dev` | รันโหมด watch |
| `npm run backtest` | `src/backtest.ts` |
| `npm run history` | `src/fetch-history.ts` ดึงประวัติ |
| `npm run claim` / `cancel-all` / `inspect-orders` | ยูทิลิตี้ `src/claim.ts`, `src/cancel-all.ts`, `src/inspect-orders.ts` |
| `npm run research:*` | `snapshot`, `verify`, `run`, `rr`, `waterfall` ใน `src/research/` |

dependencies หลัก: `dotenv`, `viem`, `ws`; devDeps: `tsx`, `typescript`, `@types/node`, `@types/ws`

## 3. โครงสร้างโค้ด

```tree
dynamic-grid/
├── src/
│   ├── index.ts              # entry point: เชื่อม config, exchange, strategy, feed, engine, dashboard, pair rotator
│   ├── config.ts             # defaultStrategyConfig + โหลดค่าจาก DB/.env (DB เป็น source of truth)
│   ├── db.ts                 # ACID state JSON (settings, orders, lots, trades)
│   ├── server.ts             # HTTP + SSE/WebSocket dashboard, API /api/*
│   ├── strategy/
│   │   ├── factory.ts        # createStrategy(type): swing_trade | ma_fan | dynamic_grid (default)
│   │   ├── index.ts          # DynamicGrid
│   │   ├── swing/            # SwingTraderStrategy
│   │   ├── ma-fan/           # MaFanTradingStrategy (exhaustion, regime, ribbon, calibrator, executor ...)
│   │   ├── buy-sync.ts, sell-sync.ts, lot-tracker.ts, order-executor.ts, risk-manager.ts
│   ├── exchange/
│   │   ├── types.ts          # IExchangeClient
│   │   ├── index.ts          # createExchangeClient: binance | dreamdex | alpaca
│   │   ├── binance/          # client.ts, feed.ts (ATR, bookTicker, User Data Stream v3)
│   │   ├── dreamdex/         # client.ts, indexer.ts (Somnia GraphQL)
│   │   └── alpaca/
│   ├── market-structure/     # candle-manager, swing-detector, dow-engine, channel-engine,
│   │                         # trendline-engine, regime-classifier/gate, volume-profile
│   ├── research/             # runner*, verify-*, fetch-snapshot, report, stats
│   ├── backtest-service.ts, backtest.ts
│   ├── pair-rotator.ts       # AutonomousPairRotator
│   ├── volatility.ts         # ATR
│   ├── trade-rounds.ts, version.ts, types.ts, utils.ts
├── public/                   # dashboard: index.html, app.js, style.css, backtest.*
├── scripts/                  # test-120d*.ts
├── scratch/                  # สคริปต์วิเคราะห์ชั่วคราว (ไม่ใช่ runtime)
└── data/                     # settings + DB JSON (ไม่ควร commit ค่าลับ)
```

## 4. การตั้งค่า (Config)

- ค่าเริ่มต้นอยู่ใน `src/config.ts` (`defaultStrategyConfig`) ค่าที่บันทึกใน DB/ผ่าน dashboard มีผลเหนือค่าเริ่มต้น
- ฟิลด์ที่ยืนยันจาก `src/config.ts` แล้ว: `strategyType` (`dynamic_grid` | `swing_trade` | `ma_fan`), `exchange` (env `EXCHANGE`, ค่าเริ่มต้น `binance`), `symbol` (env `SYMBOL`, ค่าเริ่มต้น `BTCUSDT`), `maxInventoryQuote` (40), `dowTimeframe` (15m), `tradingTimeframe` (5m), `htfTimeframe` (4h)
- ฟิลด์อื่นที่เคยเขียนไว้ (`dryRun`, `maxSessionLossQuote`, `intervalMs`) ยังไม่ได้ตรวจในโค้ด
- ค่า `DRY_RUN=true` จำลองคำสั่งในหน่วยความจำ ไม่ส่งออเดอร์จริง
- เขตเวลาค่าเริ่มต้น `Asia/Bangkok`
- ความไม่สอดคล้องที่พบ: README ระบุว่าการตั้งค่าอยู่ใน `data/grid-bot.db.json` ฟิลด์ `settings` ส่วน GEMINI.md ระบุว่าอยู่ใน `data/settings.db.json` ควรยืนยันกับโค้ดก่อนแก้ไข

## 5. กลยุทธ์ Dynamic Grid

- กรอบราคา 5 โซน: 0% Floor (แนวรับ, จุด cut-loss), 0–50% Buy Zone, 50% Center, 50–100% Sell Zone, 100% Ceiling (ทำกำไรเต็ม)
- ขนาดขั้นกริดขึ้นกับ ATR (สูตรละเอียดยังไม่ได้ยืนยันจากโค้ด ให้ดู `src/strategy/index.ts` และ `src/volatility.ts`)
- กรอบแคบ (`width < 1.2%`) ใช้โหมด single edge bracket (ซื้อไม้เดียวที่ Floor + 0.2%) ตาม GEMINI.md บรรทัด 796–799
- กรอบอิง Dow Theory: จุดสูง/ต่ำที่ยืนยันแล้ว (HH/HL/LH/LL), `isUnbrokenValley` / `isUnbrokenPeak`
- GEMINI.md บรรทัด 137–141 ระบุบั๊กที่เคยพบ: IOC buy/sell เคยส่งราคาเกินระดับเป้าเพราะ slippage (เป็นประวัติการแก้ ยังไม่ได้ยืนยันว่าแก้แล้วในโค้ดปัจจุบัน)
- ค่าอื่น ๆ ของกรอบ (เช่น การปรับกรอบเฉพาะตอนแท่งปิด, ค่าแก๊ส DEX) ยังไม่ได้ยืนยันจากโค้ด

## 6. กลยุทธ์อื่น

- **swing_trade**: `src/strategy/swing/`
- **ma_fan**: `src/strategy/ma-fan/` มี MA ribbon, exhaustion, regime supervisor, macro gate (`off` | `noDeepBear` | `bullOnly`), waterfall guard, circuit breaker, TP1 ratio, trailing และ rolling calibrator

## 7. กฎการทำงานกับโปรเจกต์ (จาก GEMINI.md)

1. **Golden rule**: ก่อนแก้ไฟล์โค้ด ต้องอธิบายปัญหาและแนวทางแก้ แล้วถามยืนยันผู้ใช้ก่อน
2. **Commit/Push**: GEMINI.md บทที่ 5 ข้อ 5 ระบุว่าต้องถามยืนยันก่อน `git commit` และ `git push` เสมอ (ข้อความในบทกฎเก่าบางจุดเขียนให้ commit อัตโนมัติ จึงควรถามผู้ใช้เมื่อไม่แน่ใจ)
3. **Version bump**: เมื่อแก้โค้ดและ typecheck ผ่าน ต้องขยับเวอร์ชันใน `package.json` และ `src/version.ts` (รูปแบบ MAJOR.MINOR.FEATURE.PATCH)
4. **อัปเดต GEMINI.md** ทุกครั้งที่แก้บั๊ก ปรับ logic หรือเพิ่มฟีเจอร์
5. **ESM**: import ภายในโปรเจกต์ต้องลงท้าย `.js`
6. **Binance precision**: ใช้ `roundToStep()` กับ tickSize/stepSize และตรวจ minQty/minNotional ก่อนส่งออเดอร์
7. **State consistency**: การเปลี่ยน lots/orders/parameters ใน `strategy.ts` ต้องบันทึกผ่าน `this.db.saveState(...)`
8. **Production อยู่บนเซิร์ฟเวอร์ระยะไกล**: ไฟล์ `.env`, DB และ log ในเครื่องอาจไม่ตรงกับ production ต้องขอไฟล์ล่าสุดก่อนสรุปสาเหตุปัญหาจริง

## 8. ข้อควรระวัง

- การทดสอบ live ต้องระวังว่า `DRY_RUN=false` ส่งออเดอร์จริงเข้า Binance
- ห้าม commit ค่า API key, secret หรือ private key
- `src/exchange/index.ts` ประกาศชนิด `bybit`/`okx` ไว้ใน `SupportedExchange` แต่ switch มีเฉพาะ binance, dreamdex, alpaca

## 9. Master Plan ล่าสุดและผลทดสอบ (อ้างจาก GEMINI.md หัวข้อ `## 303.`–`## 312.`)

ข้อมูลส่วนนี้มาจากบันทึกใน GEMINI.md ยังไม่ได้ตรวจซ้ำกับโค้ดทุกจุด
หมายเลขในคอลัมน์ "หัวข้อ" คือเลขหัวข้อ `## NNN.` ไม่ใช่เลขบรรทัด บรรทัดจริงอยู่ในคอลัมน์ "บรรทัด" (ตรวจแล้วด้วย grep)

| Master Plan | เวอร์ชัน | หัวข้อ GEMINI.md | บรรทัด GEMINI.md | ประเด็นหลัก |
| :--- | :--- | :--- | :--- | :--- |
| v15.0 | 0.3.0.56 | 303 | 9155 | Market DNA, Anti-Climax guard, ลดขาดทุนนอกกลุ่ม OOS |
| v16.0 | 0.3.0.57 | 304 | 9189 | คืน Core Engine v14.0, ตัวคัด Grid DNA 5 มิติ (`evaluateGridDna`) |
| v17.0 | 0.3.0.58 | 305 | 9267 | รวมกลยุทธ์เหลือ Dynamic Grid เดียว, คัดเหรียญเกรด S/A เท่านั้น |
| v18.0 | 0.3.0.59 | 306 | 9291 | DNA แบบ Rolling สองหน้าต่าง, Live Trend 4H/1H |
| v19.0 | 0.3.0.60 | 307 | 9323 | Walk-forward multi-pair rotation บน 15m |
| v20.0 | 0.3.0.61 | 308 | 9351 | แก้ 4 จุดคอขวด (warmup, filter, BTC gate, ค่าเริ่มต้น) |
| v21.0 | 0.3.0.62 | 309 | 9388 | Strict S/A, แก้ `curScore = 0` ลวงตา, คัด meme/penny coins |
| v22.0 | 0.3.0.63 | 310 | 9431 | ขยายไปหุ้นสหรัฐฯ (Alpaca USD) |
| v23.0 | 0.3.0.64 | 311 | 9479 | แก้ disk cache ไม่หมดอายุ, Forward bar gate, จูนเกณฑ์หุ้น |

**แนวทางหลักที่บันทึกไว้**
- Core Engine v14.0 เป็นฐาน: `buyLevelPcts` `[20, 12]` (หุ้น `[22, 12]`), `buyWeights` `[55, 45]`, `sellLevelPcts` `[52, 72]`, `capitalZones: 1`, `gridCutLossMode: "entry_floor"`, Ratchet Trailing Stop 3 ขั้น, Time-Decay Escape 18 แท่ง (15m)
- Market DNA ให้เกรด `S / A / B / AVOID` ใช้เลือกสินทรัพย์ เฉพาะเกรด S/A เท่านั้นที่ได้เทรด
- ค่า `minChannelWidthPct` แยกตามตลาด: หุ้นสหรัฐฯ `1.2%`, FDUSD `2.0%`, USDT `2.4%`
- Universe ตัด meme/penny/privacy coins (เช่น `PEPE`, `ZECUSDT`, `ENAUSDT`, `HYPEUSDT`) ผ่าน `TOXIC_MEME_PENNY_TOKENS`
- ตลาดหุ้นใช้ `getNextTradingBarTime` ข้ามช่วงปิดตลาดและสุดสัปดาห์
- ค่าเริ่มต้น multi-pair rotation เป็น `grid_sequential` บน `15m`

**ผลทดสอบล่าสุดที่บันทึกไว้ (v0.3.0.64)**

| ตลาด | ข้อมูล | Net PnL | Win Rate | Max DD |
| :--- | :--- | :--- | :--- | :--- |
| หุ้นสหรัฐฯ (Alpaca USD, 20 หุ้น/ETF) | 15m, 1,000 แท่งทำการ | +0.71% (+$71.35) | 74.2% (23/31) | — |
| FDUSD (6 คู่) | 15m, 1,500 แท่ง | +1.33% (+$2.66) | 100% (6/6) | -0.20% |
| USDT (25 คู่) | 15m, 1,500 แท่ง | +1.09% (v0.3.0.63) | 81.8% (9/11) | -1.80% |

- Grade B ที่เข้าเทรด: 0 ครั้ง (หุ้น 0/32, FDUSD 0/7, USDT 0/21)
- คำเตือน `startBarIdx=-1`: 0 ครั้ง (หุ้นสหรัฐฯ)
- ผล USDT ที่ 0.3.0.64 ยังไม่ได้ระบุไว้ในบันทึก จึงใช้ค่าจาก v0.3.0.63

**ข้อควรระวัง**
- ตัวเลขทั้งหมดเป็นผล backtest บนข้อมูลในอดีต ไม่ใช่ผลเทรดจริง
- ตัวอย่างน้อย (เช่น 6–11 ไม้ต่อตลาด) ทำให้ Win Rate สูงเกินจริงได้ง่าย
- บันทึกบอกว่า `typecheck` ผ่านทุกเวอร์ชัน แต่ยังไม่ได้รันซ้ำในรอบนี้

## 10. ช่องว่างที่ยังไม่ได้ตรวจ

- ยังไม่ได้อ่านรายละเอียด `server.ts`, `strategy/index.ts`, `exchange/binance/*`, `market-structure/*` ฉบับเต็ม
- ยังไม่ได้รัน `npm run typecheck` ในรอบนี้
