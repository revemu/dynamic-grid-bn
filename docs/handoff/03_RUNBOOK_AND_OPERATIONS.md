# 🛠️ เอกสารส่งมอบงานส่วนที่ 3: คู่มือการปฏิบัติการและการดูแลระบบ (Operations & Runbook)
## Universal Dynamic Grid Trading Bot (`v0.3.0.65`)

> **คู่มือสำหรับวิศวกรผู้รับช่วงต่องาน (Successor Engineer)**

---

## 1. ข้อกำหนดสภาพแวดล้อมและคำสั่งพื้นฐาน (Environment & Setup)

* **Node.js**: v20+ หรือ v22+
* **Package Manager**: npm
* **TypeScript Runtime**: `tsx`
* **Dependencies สำคัญ**: `dotenv`, `ws`, `viem`, `typescript`, `tsx`

### คำสั่งตรวจสอบและทดสอบ (Commands Runbook)

```powershell
# 1. ตรวจสอบความถูกต้องของ Type ทั่วทั้งโปรเจกต์ (ต้องผ่าน 0 Errors เสมอ)
npm run typecheck

# 2. รันสคริปต์ Walk-Forward Verification ครอบคลุมทั้ง 3 ตลาด (USD, FDUSD, USDT)
npx tsx scratch/verify-v23.ts

# 3. รันการจำลองแบบ Multi-Pair Rotation สำหรับเหรียญ USDT เฉพาะเจาะจง
npx tsx scratch/run-rotation-test.ts

# 4. ทดสอบรันบอทในเครื่อง Local (Dry-Run Mode)
npm run dev
```

---

## 2. โครงสร้างสถาปัตยกรรมเซิร์ฟเวอร์จริง (Production Architecture)

บอทเทรดจริงทำงานอยู่บน Cloud Server (`210.246.253.13`) แยกเป็น 2 Service:

```text
Production Server: 210.246.253.13
├── Port 3333: DreamDEX Spot (DEX on Somnia Network)
│   ├── UI: http://210.246.253.13:3333/
│   ├── State: http://210.246.253.13:3333/api/state
│   ├── Config: http://210.246.253.13:3333/api/config
│   └── Version: http://210.246.253.13:3333/api/version
│
└── Port 3334: Binance Spot (CEX)
    ├── UI: http://210.246.253.13:3334/
    ├── State: http://210.246.253.13:3334/api/state
    ├── Config: http://210.246.253.13:3334/api/config
    └── Version: http://210.246.253.13:3334/api/version
```

> [!IMPORTANT]
> **กฎการตรวจสอบสถานะสด**: เมื่อพบปัญหาหรือผู้ใช้แจ้งเหตุผิดปกติ **ต้องยิง API ตรวจสอบสถานะจาก Server จริง (`:3333` หรือ `:3334`) เท่านั้น** ห้ามอ้างอิงจากไฟล์ในโฟลเดอร์ `data/` บนเครื่อง Local เด็ดขาด!

---

## 3. ขั้นตอนการขยายผลและเพิ่มสินทรัพย์ใหม่ (Adding New Assets)

### ก) การเพิ่มหุ้น/ETF สหรัฐฯ ใหม่
1. เปิดไฟล์ [`src/backtest-service.ts`](file:///c:/Sites/github/dynamic-grid-bn/src/backtest-service.ts)
2. ค้นหาอาเรย์ `US_STOCK_UNIVERSE`
3. เพิ่ม Ticker หุ้นที่มีสภาพคล่องสูง เช่น `"COST"`, `"NFLX"`, `"CRM"`, `"JNJ"`
4. ระบบจะดึงข้อมูลผ่าน Alpaca IEX Feed อัตโนมัติด้วยคำสั่ง `sort=desc`

### ข) การเพิ่มคู่เหรียญคริปโตใหม่
1. เปิดไฟล์ [`src/backtest-service.ts`](file:///c:/Sites/github/dynamic-grid-bn/src/backtest-service.ts)
2. ค้นหาอาเรย์ `CRYPTO_UNIVERSE_PRESET` หรือระบุคู่เหรียญใน `runMultiPairRotationSimulation`
3. ระวัง: หากเป็นเหรียญมีมที่มีประวัติทุบทะลุแนวรับแรง (Waterfall) ให้ใส่ใน `TOXIC_MEME_PENNY_TOKENS` หรือหากเป็นเหรียญสังเคราะห์/ตรึงมูลค่า ให้ใส่ใน `SYNTHETIC_BLACKLIST`

---

## 4. กฎเหล็กในการพัฒนาและแก้ไขโค้ด (Strict Development Rules)

1. **ถามยืนยันผู้ใช้ก่อนแก้โค้ดเสมอ**:
   - อธิบายสาเหตุของปัญหาและแนวทางแก้ไขให้ชัดเจน แล้วถามยืนยันผ่านเครื่องมือ `ask_question` ก่อนแตะต้องไฟล์โค้ด
2. **ขยับเลขเวอร์ชัน 4 หลักเสมอ (ALWAYS BUMP VERSION)**:
   - ทุกครั้งที่มีการแก้โค้ด ต้องปรับเลขเวอร์ชันใน [`package.json`](file:///c:/Sites/github/dynamic-grid-bn/package.json) และ [`src/version.ts`](file:///c:/Sites/github/dynamic-grid-bn/src/version.ts) ตามมาตรฐาน `MAJOR.MINOR.FEATURE.PATCH` (เช่น `0.3.0.65` ➔ `0.3.0.66`)
3. **บันทึก Memory ใน `GEMINI.md` ทันที**:
   - เพิ่มหัวข้อ Section ใหม่ใน [`GEMINI.md`](file:///c:/Sites/github/dynamic-grid-bn/GEMINI.md) อธิบายสาเหตุ แนวทางแก้ไข และผลการทดสอบ เพื่อให้ AI มีความจำต่อเนื่อง
4. **Automated Commit & Push**:
   - เมื่อรัน `npm run typecheck` ผ่าน 100% แล้ว ให้ทำการ `git commit` และ `git push origin main` ทันทีโดยไม่ต้องหยุดถามยืนยันซ้ำซ้อน
