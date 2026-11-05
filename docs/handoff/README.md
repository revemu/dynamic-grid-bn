# 🗂️ Universal Trading Bot — Complete Handoff Package (`docs/handoff/`)
## ชุดเอกสารส่งมอบงาน สถาปัตยกรรม แผนแม่บท และผลการทดสอบสมบูรณ์ 3 ตลาด

> **สถานะเวอร์ชันล่าสุด**: `v0.3.0.65`  
> **วันที่จัดทำเอกสาร**: 2026-11-05  
> **Repository**: `dynamic-grid-bn` (GitHub: `revemu/dynamic-grid-bn`)  
> **เป้าหมาย**: เอกสารส่งมอบงานสำหรับวิศวกรผู้รับช่วงต่อ เพื่อให้สามารถเข้าใจสถาปัตยกรรม รันการทดสอบ ขยายผลสู่สินทรัพย์ใหม่ และดูแลระบบ Production ได้อย่างไร้รอยต่อ

---

## 📑 สารบัญเอกสารในชุดส่งมอบงาน (Documentation Index)

| ไฟล์เอกสาร | คำอธิบายและสาระสำคัญ |
| :--- | :--- |
| 📘 [**`01_MASTER_PLAN_COMPLETE.md`**](./01_MASTER_PLAN_COMPLETE.md) | **แผนแม่บทฉบับสมบูรณ์ (Consolidated Master Plan v17.0 – v24.0)**<br/>สรุปวิวัฒนาการตั้งแต่ Phase 1 ถึง Phase 8, สถาปัตยกรรม Dual-Window DNA Funnel, ตารางพารามิเตอร์เฉพาะตลาด (USD, FDUSD, USDT), และการวิเคราะห์บั๊กเชิงลึก |
| 📊 [**`02_VERIFICATION_RESULTS_ALL_MARKETS.md`**](./02_VERIFICATION_RESULTS_ALL_MARKETS.md) | **รายงานผลการทดสอบ 3 ตลาด (Walk-Forward Verification Results)**<br/>ตารางสรุปผลตอบแทน, ไทม์ไลน์การถือครองรายรอบ (Leg Timeline), Win Rate รายไม้, Alpha vs Benchmark, และบทพิสูจน์การทำงาน All-Green |
| 🛠️ [**`03_RUNBOOK_AND_OPERATIONS.md`**](./03_RUNBOOK_AND_OPERATIONS.md) | **คู่มือการปฏิบัติการและการดูแลระบบ (Operations & Engineering Runbook)**<br/>คำสั่งรัน Typecheck, สคริปต์ทดสอบย้อนหลัง, ขั้นตอนการเพิ่มหุ้น/เหรียญใหม่, สถาปัตยกรรมเซิร์ฟเวอร์สด Production, และกฎเหล็กการ Bump Version |

---

## 🌐 Live Production Bot Endpoints (เซิร์ฟเวอร์จริง)

บอทเทรดจริงรันอยู่บน Production Server (ไม่ได้รันบน Local):
1. **DreamDEX Spot (DEX on Somnia Network)**:
   - Dashboard UI: `http://210.246.253.13:3333/`
   - State & Telemetry API: `http://210.246.253.13:3333/api/state`
   - Config API: `http://210.246.253.13:3333/api/config`
   - Version API: `http://210.246.253.13:3333/api/version`
2. **Binance Spot (CEX)**:
   - Dashboard UI: `http://210.246.253.13:3334/`
   - State & Telemetry API: `http://210.246.253.13:3334/api/state`
   - Config API: `http://210.246.253.13:3334/api/config`
   - Version API: `http://210.246.253.13:3334/api/version`

---

## 🏆 จุดเด่นสำคัญของระบบในเวอร์ชัน `0.3.0.65`

1. **Lab-to-Live Parity 100%**: โค้ด Backtest (`src/backtest-service.ts`) และโค้ดบอทจริง (`src/strategy.ts`, `src/pair-rotator.ts`) ใช้โมเดลคณิตศาสตร์และการตั้งค่าเดียวกันทั้งหมด
2. **Cross-Market Capability**: รองรับทั้ง หุ้นสหรัฐฯ/ETF (`Alpaca USD`), คริปโตค่าธรรมเนียมฟรี (`Binance FDUSD`), และคริปโตกระดานหลัก (`Binance USDT`)
3. **Pure Grade S/A Portfolio**: ระบบคัดกรอง DNA ตัดเหรียญขยะ/เหรียญปั่นทิ้ง และไม่อนุญาตให้ถือสินทรัพย์ Grade B ในพอร์ตเด็ดขาด
4. **All-Green Performance**: ผลการทดสอบ Walk-forward ล่าสุดในสภาพตลาดจริง มีกำไรเป็นบวกและ Win Rate สูงกว่า 76%–100% ครบทั้ง 3 ตลาด
