# Dynamic Grid Bot — Binance Spot Trading Edition (`dynamic-grid-bn`)

บอทเทรด **Dynamic Grid & Dow Theory Market Structure** แบบ Standalone สำหรับ **Binance Spot** 
ปรับปรุงสเต็ปกรอบราคาแบบไดนามิกตามความผันผวนของตลาด (ATR) และโครงสร้างราคาแนวนอน Support/Resistance Multi-Touch อัตโนมัติ โดยส่งคำสั่งซื้อขายตรงเข้ากระดาน **Binance Spot API** พร้อมระบบควบคุมผ่านหน้าต่าง **Real-Time Web Dashboard**

---

## 🌟 จุดเด่นและฟีเจอร์สำคัญ (Key Features)

1. **เทรดบน Binance Spot โดยตรง (Native Binance Spot Trading)**:
   - ทำงานแบบ Standalone ไม่ขึ้นกับบล็อกเชน EVM หรือสัญญา Smart Contract
   - ส่งคำสั่งเทรดแบบ Spot (LIMIT, LIMIT_MAKER, IOC Market) ผ่าน Binance REST API พร้อม HMAC SHA-256 Signature
   - ระบบ Auto Clock Synchronization ซิงค์เวลาเครื่องกับ Binance Server ป้องกัน Timestamp out of recvWindow (`-1021`)
   - ระบบปัดเศษทศนิยมตามตัวกรองของคู่เทรด (`tickSize`, `stepSize`, `minNotional`) ป้องกันข้อผิดพลาด Precision

2. **สลับคู่เทรดได้อิสระ (Dynamic Trading Pair Selection)**:
   - เลือกลิสต์คู่เทรดได้จากเมนูบน Topbar หรือตั้งค่าคู่เหรียญใดก็ได้ใน Binance (เช่น `BTCUSDT`, `ETHUSDT`, `SOLUSDT`, `BNBUSDT`, `DOGEUSDT`, `PEPEUSDT`)
   - ระบบเชื่อมต่อ WebSocket Kline Feed, โหลดข้อมูลแท่งเทียน และคำนวณกรอบราคาของคู่เหรียญใหม่ให้ทันทีแบบเรียลไทม์

3. **โครงสร้างราคา 5-Zone Channel & Dow Theory Multi-Touch**:
   - **0% Floor (แนวรับ)**: ล็อกตามจุดเหว/ฐานราคาที่แท้จริง (`Multi-Touch Support`) และเป็นจุด Trigger Stop-Loss / Cut-Loss
   - **0%–50% Buy Zone**: ทยอยสะสมออเดอร์ซื้อแบบ Stepped Laddering
   - **50% Center**: จุดสมดุลของกรอบราคา
   - **50%–100% Sell Zone**: ทยอยขายทำกำไร
   - **100% Ceiling (แนวต้าน)**: ล็อกตามจุดยอดโครงสร้างราคา (`Multi-Touch Resistance`) และเป็นจุด Take Profit 100% เต็มจำนวน
   - คำนวณแนวโน้มหลัก (Uptrend / Downtrend) และเส้น Trendline อัตโนมัติเพื่อหยุดการเปิด Buy ในจังหวะที่ราคาทิ้งตัวรุนแรง

4. **ควบคุมผ่าน Database (Single Source of Truth) & Web Dashboard**:
   - การตั้งค่าทั้งหมด (API Keys, Secret, Symbol, Dry Run, Max Inventory, Port ฯลฯ) จัดเก็บในไฟล์ฐานข้อมูล JSON ACID (`data/grid-bot.db.json`)
   - ไม่จำเป็นต้องพึ่งพาไฟล์ `.env` (สามารถเปิดบอทและตั้งค่า API ผ่านหน้าเว็บได้ทันที)
   - หน้าต่าง Config ปรับเปลี่ยนค่าและมีผลทันทีแบบ Real-Time โดยไม่ต้อง Restart บอท

5. **ไม่มีการกัน Gas Reserve (100% Spot Asset Efficiency)**:
   - บอททำงานบน Binance Spot จึงไม่มีค่า Gas Fee เหมือนบล็อกเชน
   - สามารถใช้ยอดเหรียญ Base Asset ในกระเป๋า Spot เพื่อวางคำสั่งขายทำกำไรหรือ Rebalance ได้เต็ม 100% ของพอร์ต

---

## 🖥️ หน้าต่าง Web Dashboard & TradingView Chart

บอทมาพร้อม Web Dashboard ในตัว (เข้าใช้งานที่ `http://localhost:3333`):
- **Lightweight Candlestick Chart**: กราฟแท่งเทียน 15M / 1H เรียลไทม์
- **Dynamic Channel Overlay**: เส้นกรอบแนวต้าน (Ceiling), เส้นกึ่งกลาง (Center), เส้นแนวรับ (Floor), และเส้น Cut Loss Buffer
- **Structural Markers**: แสดงจุดยอด (Peaks ⛰️) และเหว (Valleys 🌊) ตามทฤษฎี Dow Theory พร้อมจำนวนจุดสัมผัส (🎯 2x / Multi-Touch)
- **Order & Execution Markers**: จุดเข้าซื้อ (BUY) และขายทำกำไร (SELL) พร้อมแสดง Realized PnL ของแต่ละรอบ
- **Control Bar**: ปุ่ม Pause / Resume, Cancel All Orders, Reset Position, จัดการ Fills/Lots และหน้าต่างตั้งค่า ⚙️ Config

---

## 🚀 การติดตั้งและเริ่มต้นใช้งาน (Quick Start)

### 1. ติดตั้ง Dependencies
```bash
npm install
```

### 2. ตรวจสอบโค้ด (Typecheck)
```bash
npm run typecheck
```

### 3. รันโปรแกรม
```bash
# รันบอทและเปิด Web Dashboard (Production)
npm start

# หรือรันในโหมด Development (Hot-reload เมื่อแก้โค้ด)
npm run dev
```

เปิดเว็บเบราว์เซอร์ไปที่: **`http://localhost:3333`**

---

## ⚙️ การตั้งค่าระบบ (Configuration)

คุณสามารถตั้งค่าได้ **2 วิธี**:

### วิธีที่ 1: ตั้งค่าผ่านหน้าเว็บ Dashboard (แนะนำ)
1. เปิดเว็บ `http://localhost:3333`
2. กดปุ่ม **⚙️ Config** ที่มุมขวาบน
3. ไปที่แท็บ **🔑 Binance API & Env**:
   - เปิด/ปิด **🧪 Dry Run Simulation Mode** (เปิด = จำลองการเทรด ไม่ส่งคำสั่งจริง, ปิด = ส่งออเดอร์จริงเข้า Binance)
   - ใส่ **Binance API Key** และ **Binance API Secret** (เปิดสิทธิ์ *Enable Spot & Margin Trading*)
   - ระบุ **Web Dashboard Port** (ค่าเริ่มต้น `3333`)
4. กด **💾 Save & Apply** ข้อมูลจะถูกบันทึกลง Database และเริ่มทำงานทันที

### วิธีที่ 2: ตั้งค่าผ่านไฟล์ `data/grid-bot.db.json` โดยตรง
แก้ไขค่าในฟิลด์ `"settings"`:
```json
{
  "settings": {
    "symbol": "BTCUSDT",
    "binanceApiKey": "YOUR_BINANCE_API_KEY",
    "binanceApiSecret": "YOUR_BINANCE_API_SECRET",
    "binanceBaseUrl": "https://api.binance.com",
    "binanceWsBase": "wss://stream.binance.com:9443",
    "dryRun": true,
    "dashboardPort": 3333,
    "maxInventoryUsdso": 100,
    "channelMode": "MULTI_TOUCH_SR",
    "intervalMs": 500
  }
}
```

*(หรือหากต้องการใช้ `.env` ก็สามารถคัดลอกจาก `.env.example` ได้เช่นกัน)*

---

## 🛠️ คำสั่ง Command-Line (CLI Utilities)

| คำสั่ง | หน้าที่การทำงาน |
| :--- | :--- |
| `npm start` | รันบอทเทรดหลักและเปิดเซิร์ฟเวอร์ Dashboard |
| `npm run dev` | รันบอทในโหมด Development พร้อม Hot-reload (`tsx watch`) |
| `npm run typecheck` | ตรวจสอบความถูกต้องของ Type ด้วย TypeScript (`tsc --noEmit`) |
| `npm run cancel-all [SYMBOL]` | ยกเลิกคำสั่ง Open Orders ทั้งหมดของคู่เทรดบน Binance |
| `npm run inspect-balances [SYMBOL]` | ตรวจสอบยอดเงินคงเหลือในกระเป๋า Spot (Free / Locked) และคำสั่งที่เปิดอยู่ |
| `npm run inspect-orders [SYMBOL]` | ตรวจสอบรายการออเดอร์ย้อนหลังจาก Binance API |
| `npm run history [SYMBOL]` | ตรวจสอบประวัติการจับคู่เทรด (Trade Fills) จากบัญชี Binance |

---

## ⚠️ คำเตือนความเสี่ยง (Risk Disclaimer)

การเทรดคริปโทเคอร์เรนซีมีความเสี่ยงจากความผันผวนของราคา กลยุทธ์ Grid Trading ได้รับการออกแบบมาสำหรับสภาวะตลาดที่มีการแกว่งตัวในกรอบ (Sideway / Consolidation) หากตลาดเกิดแนวโน้มทิศทางเดียวรุนแรง (Strong Trend) หรือหลุดกรอบแนวรับสำคัญ บอทจะมีระบบ Cut-Loss เพื่อรักษาเงินทุน โปรดทดสอบในโหมด **Dry Run (`dryRun: true`)** และบริหารจัดการความเสี่ยง (Money Management) ให้เหมาะสมกับเงินทุนของคุณเสมอ
