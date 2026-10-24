import type { Candle, SwingPoint, CandidatePoint, GridZone, ChannelOptions } from "./types.js";
import { getEffectiveHigh, getEffectiveLow } from "./candle-manager.js";
import type { ChannelGateEvaluation } from "./regime-gate.js";

export interface CalculatedBounds {
  upperBound: number;
  bottomBound: number;
  activePeak?: SwingPoint;
  activeValley?: SwingPoint;
  isSwingConfirmed: boolean;
  clampStatus: GridZone["clampStatus"];
  anchorSide: GridZone["anchorSide"];
  rawWidthPct?: number;
  minWidthPct?: number;
  maxWidthPct?: number;
}

export type ChannelPair = { valley: SwingPoint; peak: SwingPoint; width: number; widthPct: number };

export class ChannelEngine {
  /**
   * Calculate Channel Bounds based on selected mode:
   * - "DONCHIAN_ATR": Donchian channel with ATR buffer
   * - "DOW_SWINGS" / "DOW_ATR_CLAMP" / "FIXED_PCT_CLAMP": Active Wave Support-First + Unobstructed Wave Box (Tier 1-3)
   */
  public static calculateBounds(
    candles: Candle[],
    price: number,
    confirmedHighs: SwingPoint[],
    confirmedLows: SwingPoint[],
    candidatePeak: CandidatePoint | undefined,
    candidateValley: CandidatePoint | undefined,
    options: ChannelOptions | undefined,
    effAtrPct: number,
    useTrueWick = true,
    wickThresholdPct = 0.20,
  ): CalculatedBounds {
    const n = candles.length;
    const mode = options?.mode ?? "DOW_SWINGS";
    const minChannelWidthPct = options?.minChannelWidthPct ?? 1.8;
    const maxChannelWidthPct = options?.maxChannelWidthPct ?? 6.0;
    const minPct = minChannelWidthPct / 100;
    const maxPct = maxChannelWidthPct / 100;
    const minSpan = price * minPct;
    const maxSpan = price * maxPct;

    let upperBound = 0;
    let bottomBound = 0;
    let isSwingConfirmed = false;
    let activePeak: SwingPoint | undefined;
    let activeValley: SwingPoint | undefined;
    let clampStatus: GridZone["clampStatus"] = "NATURAL_SWING";
    let anchorSide: GridZone["anchorSide"] = "NONE";
    let rawWidthPct: number | undefined;
    let minWidthPct: number | undefined;
    let maxWidthPct: number | undefined;

    if (mode === "DONCHIAN_ATR") {
      const lookback = Math.min(n, options?.donchianLookback ?? 20);
      const donchianCandles = candles.slice(Math.max(0, n - lookback));
      const allLows = donchianCandles.map((c) => (useTrueWick ? c.low : getEffectiveLow(c, false))).filter(Number.isFinite);
      const allHighs = donchianCandles.map((c) => (useTrueWick ? c.high : getEffectiveHigh(c, false))).filter(Number.isFinite);

      const rawBottom = allLows.length > 0 ? Math.min(...allLows) : price * 0.985;
      const rawUpper = allHighs.length > 0 ? Math.max(...allHighs) : price * 1.015;

      const minDonchianSpan = Math.max(price * 0.015, price * effAtrPct * 2.0);
      bottomBound = rawBottom;
      upperBound = rawUpper;
      isSwingConfirmed = true;

      if (upperBound - bottomBound < minDonchianSpan) {
        upperBound = bottomBound + minDonchianSpan;
      }

      rawWidthPct = bottomBound > 0 ? ((upperBound - bottomBound) / bottomBound) * 100 : 0;
      minWidthPct = (minSpan / price) * 100;
      maxWidthPct = (maxSpan / price) * 100;
    } else if (mode === "VOLUME_PROFILE_HTF") {
      // 🚀 Hybrid: Volume Profile (POC/VAH/VAL) + 4H HTF Structural Anchor Mode
      const vp = options?.volumeProfile;
      const htf = options?.htfStructure;

      // 1. Determine Floor (Support):
      // Prioritize 4H HTF structural floor (major macro support below price)
      // If HTF floor is breached or not yet loaded, anchor to VP Value Area Low (VAL),
      // or lowest unbroken valley in 15m.
      const htfFloor = (htf?.floor && htf.floor > 0 && htf.floor <= price) ? htf.floor : 0;
      const valFloor = (vp?.val && vp.val > 0 && vp.val <= price) ? vp.val : 0;

      const candidateLows = confirmedLows.filter((l) => l.price <= price);
      const isUnbrokenValley = (v: SwingPoint): boolean =>
        !confirmedLows.some((later) => (later.index > v.index || later.time > v.time) && later.price < v.price) &&
        !(candidateValley && candidateValley.time > v.time && candidateValley.price < v.price) &&
        !candles.some((c) => c.time > v.time && getEffectiveLow(c, useTrueWick, wickThresholdPct) < v.price);

      const unbrokenValleys = candidateLows
        .filter(isUnbrokenValley)
        .sort((a, b) => b.price - a.price);

      if (htfFloor > 0) {
        bottomBound = htfFloor;
      } else if (valFloor > 0) {
        bottomBound = valFloor;
      } else if (unbrokenValleys.length > 0) {
        bottomBound = unbrokenValleys[0]!.price;
      } else {
        bottomBound = price * 0.95; // 5% below price fallback
      }

      // 2. Determine Ceiling (Resistance):
      const htfCeil = (htf?.ceiling && htf.ceiling > price) ? htf.ceiling : 0;
      const vahCeil = (vp?.vah && vp.vah > price) ? vp.vah : 0;

      const candidateHighs = confirmedHighs.filter((h) => h.price >= price);
      const isUnbrokenPeak = (p: SwingPoint): boolean =>
        !confirmedHighs.some((later) => (later.index > p.index || later.time > p.time) && later.price > p.price) &&
        !(candidatePeak && candidatePeak.time > p.time && candidatePeak.price > p.price) &&
        !candles.some((c) => c.time > p.time && getEffectiveHigh(c, useTrueWick, wickThresholdPct) > p.price);

      const unbrokenPeaks = candidateHighs
        .filter(isUnbrokenPeak)
        .sort((a, b) => a.price - b.price);

      if (htfCeil > 0) {
        upperBound = htfCeil;
      } else if (vahCeil > 0) {
        upperBound = vahCeil;
      } else if (unbrokenPeaks.length > 0) {
        upperBound = unbrokenPeaks[0]!.price;
      } else {
        upperBound = price * 1.05; // 5% above price fallback
      }

      // 3. Width safety checks:
      const minHybridSpan = Math.max(price * (minChannelWidthPct / 100), price * 0.025);
      if (upperBound - bottomBound < minHybridSpan) {
        upperBound = bottomBound + minHybridSpan;
      }
      const maxHybridSpan = price * (maxChannelWidthPct / 100);
      if (upperBound - bottomBound > maxHybridSpan) {
        upperBound = bottomBound + maxHybridSpan;
      }

      isSwingConfirmed = true;
      clampStatus = "NATURAL_SWING";
      anchorSide = "LOWER_FLOOR";
      activeValley = unbrokenValleys[0];
      activePeak = unbrokenPeaks[0];
      rawWidthPct = bottomBound > 0 ? ((upperBound - bottomBound) / bottomBound) * 100 : 0;
      minWidthPct = minChannelWidthPct;
      maxWidthPct = maxChannelWidthPct;
    } else {
      // 🔒 Active Wave Support-First + Sub-Wave Peak Bypass + Unobstructed Wave Box Architecture:
      // 1. กรองเฉพาะเหวยืนยันใต้ราคาที่ยังไม่ถูกทุบหลุด (unbrokenValleys) และยอดยืนยันเหนือราคาที่ยังไม่ถูกเบรกทะลุ (unbrokenPeaks)
      // 2. Tier 1 (Pure Unobstructed Wave Box): ค้นหาคู่ (valley, peak) ที่อยู่ในช่วง [minChannelWidthPct, maxChannelWidthPct]
      // 3. Tier 2 (Support-First Unbroken Staircase): ยึดเหวที่ยังไม่ถูกทำลายที่ใกล้ราคาที่สุด (unbrokenValleys[0]) เป็นฐานหลักก่อน
      // 4. Tier 3 (Fallback to Confirmed Highs): หากยังไม่พบ ให้จับคู่ unbrokenValleys กับ candidateHighs ที่อยู่ในช่วงความกว้าง
      // 5. หากไม่พบคู่ที่อยู่ในเกณฑ์ความกว้างเลย ให้เข้าโหมด WARMUP (หยุดวางกริดชั่วคราวโดยไม่สร้างกรอบเทียม)

      const candidateHighs = confirmedHighs.filter((h) => h.price >= price);
      const candidateLows = confirmedLows.filter((l) => l.price <= price);

      const isUnbrokenValley = (v: SwingPoint): boolean =>
        !confirmedLows.some((later) => (later.index > v.index || later.time > v.time) && later.price < v.price) &&
        !(candidateValley && candidateValley.time > v.time && candidateValley.price < v.price) &&
        !candles.some((c) => c.time > v.time && getEffectiveLow(c, useTrueWick, wickThresholdPct) < v.price);

      const isUnbrokenPeak = (p: SwingPoint): boolean =>
        !confirmedHighs.some((later) => (later.index > p.index || later.time > p.time) && later.price > p.price) &&
        !(candidatePeak && candidatePeak.time > p.time && candidatePeak.price > p.price) &&
        !candles.some((c) => c.time > p.time && getEffectiveHigh(c, useTrueWick, wickThresholdPct) > p.price);

      const isPureWaveBox = (v: SwingPoint, p: SwingPoint): boolean => {
        const startTime = Math.min(v.time, p.time);
        const startIdx = Math.min(v.index, p.index);
        const floorIntact =
          !confirmedLows.some((l) => (l.index >= startIdx || l.time >= startTime) && l.price < v.price) &&
          !(candidateValley && candidateValley.time >= startTime && candidateValley.price < v.price) &&
          !candles.some((c) => c.time >= startTime && getEffectiveLow(c, useTrueWick, wickThresholdPct) < v.price);
        if (!floorIntact) return false;

        const ceilingIntact =
          !confirmedHighs.some((h) => (h.index >= startIdx || h.time >= startTime) && h.price > p.price) &&
          !(candidatePeak && candidatePeak.time >= startTime && candidatePeak.price > p.price) &&
          !candles.some((c) => c.time >= startTime && getEffectiveHigh(c, useTrueWick, wickThresholdPct) > p.price);
        return ceilingIntact;
      };

      const isWidthValid = (v: SwingPoint, p: SwingPoint): boolean => {
        const w = p.price - v.price;
        if (w <= 0 || v.price <= 0) return false;
        const wPct = (w / v.price) * 100;
        return wPct >= minChannelWidthPct && wPct <= maxChannelWidthPct;
      };

      const unbrokenValleys = candidateLows
        .filter(isUnbrokenValley)
        .sort((a, b) => b.price - a.price || b.index - a.index);
      const unbrokenPeaks = [...candidateHighs.filter(isUnbrokenPeak)].sort((a, b) => a.price - b.price || b.index - a.index);

      let chosenPair: ChannelPair | undefined;

      // ── Tier 1: Pure Unobstructed Wave Box (Telescoping [minLow, maxHigh] box) ──
      const tier1Pairs: ChannelPair[] = [];
      for (const v of unbrokenValleys) {
        for (const p of unbrokenPeaks) {
          if (isWidthValid(v, p) && isPureWaveBox(v, p)) {
            const w = p.price - v.price;
            tier1Pairs.push({
              valley: v,
              peak: p,
              width: w,
              widthPct: (w / v.price) * 100,
            });
          }
        }
      }

      if (tier1Pairs.length > 0) {
        tier1Pairs.sort(
          (a, b) =>
            a.width - b.width ||
            Math.min(b.valley.index, b.peak.index) - Math.min(a.valley.index, a.peak.index) ||
            b.valley.index - a.valley.index
        );
        chosenPair = tier1Pairs[0]!;
      }

      // ── Tier 2: Support-First Unbroken Staircase (ยึดฐาน unbrokenValleys[0] ที่ใกล้ราคาที่สุดก่อน) ──
      if (!chosenPair) {
        for (const v of unbrokenValleys) {
          const validPeaks = unbrokenPeaks.filter((p) => {
            if (!isWidthValid(v, p)) return false;
            // ห้ามจับคู่เหวเก่ากับยอดสวิงย่อยที่อยู่ต่ำกว่ายอดคลื่นระหว่างกลาง (ป้องกัน Cross-Wave Mismatch)
            if (v.index < p.index) {
              const brokenBetween = confirmedHighs.some(
                (h) => h.index > v.index && h.index < p.index && h.price > p.price
              );
              if (brokenBetween) return false;
            }
            return true;
          });
          if (validPeaks.length > 0) {
            const bestPeak = validPeaks[0]!;
            const w = bestPeak.price - v.price;
            chosenPair = {
              valley: v,
              peak: bestPeak,
              width: w,
              widthPct: (w / v.price) * 100,
            };
            break;
          }
        }
      }

      // ── Tier 3: Unbroken Support + Confirmed Highs Fallback ──
      if (!chosenPair) {
        const sortedCandidateHighs = [...candidateHighs].sort((a, b) => a.price - b.price || b.index - a.index);
        for (const v of unbrokenValleys) {
          const validPeaks = sortedCandidateHighs.filter((p) => isWidthValid(v, p));
          if (validPeaks.length > 0) {
            const bestPeak = validPeaks[0]!;
            const w = bestPeak.price - v.price;
            chosenPair = {
              valley: v,
              peak: bestPeak,
              width: w,
              widthPct: (w / v.price) * 100,
            };
            break;
          }
        }
      }

      if (chosenPair) {
        bottomBound = chosenPair.valley.price;
        upperBound = chosenPair.peak.price;
        activePeak = chosenPair.peak;
        activeValley = chosenPair.valley;
        isSwingConfirmed = true;
        clampStatus = "NATURAL_SWING";
        anchorSide = chosenPair.valley.index >= chosenPair.peak.index ? "LOWER_FLOOR" : "UPPER_CEILING";

        rawWidthPct = chosenPair.widthPct;
        minWidthPct = minChannelWidthPct;
        maxWidthPct = maxChannelWidthPct;
      } else {
        isSwingConfirmed = false;
        clampStatus = "WARMUP";
        upperBound = 0;
        bottomBound = 0;
        activePeak = unbrokenPeaks[0] ?? candidateHighs[candidateHighs.length - 1];
        activeValley = unbrokenValleys[0] ?? candidateLows[candidateLows.length - 1];
        anchorSide = "NONE";
        rawWidthPct = undefined;
        minWidthPct = minChannelWidthPct;
        maxWidthPct = maxChannelWidthPct;
      }
    }

    return {
      upperBound,
      bottomBound,
      activePeak,
      activeValley,
      isSwingConfirmed,
      clampStatus,
      anchorSide,
      rawWidthPct,
      minWidthPct,
      maxWidthPct,
    };
  }

  /**
   * Builds the comprehensive GridZone data structure including levels, bounds, and collapse states.
   */
  public static buildGridZone(
    upperBound: number,
    bottomBound: number,
    price: number,
    isSwingConfirmed: boolean,
    mode: string,
    clampStatus: GridZone["clampStatus"],
    anchorSide: GridZone["anchorSide"],
    rawWidthPct?: number,
    minWidthPct?: number,
    maxWidthPct?: number,
    options?: ChannelOptions,
    gateEvaluation?: ChannelGateEvaluation,
  ): { gridZone: GridZone; finalSpan: number; centerPrice: number; floorBuffer: number; cutLossBound: number } {
    const hasValidChannel = isSwingConfirmed && bottomBound > 0 && upperBound > 0;
    const floorBuffer = hasValidChannel ? ((options?.floorBufferPct ?? 0.0) / 100) * bottomBound : 0;
    const cutLossBound = hasValidChannel ? bottomBound - floorBuffer : 0;
    const finalSpan = hasValidChannel ? upperBound - bottomBound : 0;
    const centerPrice = hasValidChannel ? bottomBound + finalSpan * 0.5 : price;

    // Position percentage in channel: 0% at floor, 50% at center, 100% at ceiling
    const positionPct = finalSpan > 0 ? ((price - bottomBound) / finalSpan) * 100 : 50;

    const isBelowFloor = hasValidChannel && price < cutLossBound;
    const isAboveCeiling = hasValidChannel && price >= upperBound;

    let zoneType: GridZone["zoneType"] = "BUY_ZONE";
    if (isBelowFloor) {
      zoneType = "BELOW_FLOOR_CUTLOSS";
    } else if (isAboveCeiling) {
      zoneType = "ABOVE_CEILING_FULL_EXIT";
    } else if (positionPct >= 50) {
      zoneType = "SELL_ZONE";
    } else {
      zoneType = "BUY_ZONE";
    }

    // In narrow channels (< narrowChannelThresholdPct%), adapt grid levels towards edges
    const enableCollapse = options?.enableNarrowChannelCollapse !== false;
    const narrowThresh = options?.narrowChannelThresholdPct ?? 1.20;
    const channelWidthPct = bottomBound > 0 ? ((finalSpan / bottomBound) * 100) : 0;
    const isNarrowChannel = enableCollapse && bottomBound > 0 && channelWidthPct < narrowThresh;

    const buyBufferFrac = (options?.narrowChannelBuyBufferPct ?? 0.05) / 100;
    const sellBufferFrac = (options?.narrowChannelSellBufferPct ?? 0.05) / 100;

    const defaultBuyPcts = [42, 32, 22, 12, 2];
    const defaultSellPcts = [52, 62, 72, 82, 92];
    const buyPcts = options?.buyLevelPcts && options.buyLevelPcts.length > 0 ? options.buyLevelPcts : defaultBuyPcts;
    const sellPcts = options?.sellLevelPcts && options.sellLevelPcts.length > 0 ? options.sellLevelPcts : defaultSellPcts;

    // Evaluate Trend / Regime Gate
    const canEstablish = gateEvaluation ? gateEvaluation.canEstablishChannel : true;

    // Grid Levels in Buy Zone (Evenly spaced in accumulation discount zone below Center)
    const buyLevels = hasValidChannel
      ? (isNarrowChannel
          ? [bottomBound * (1 + buyBufferFrac)]
          : buyPcts.map((pct) => Number((bottomBound + finalSpan * (pct / 100)).toFixed(6))))
      : [];

    // Grid Levels in Sell Zone (Evenly spaced in profit taking zone above Center)
    const sellLevels = hasValidChannel
      ? (isNarrowChannel
          ? [upperBound * (1 - sellBufferFrac)]
          : sellPcts.map((pct) => Number((bottomBound + finalSpan * (pct / 100)).toFixed(6))))
      : [];

    const zoneWidthPct = bottomBound > 0 ? (finalSpan / bottomBound) * 100 : 0;

    const gridZone: GridZone = {
      upperBound,
      bottomBound,
      cutLossBound,
      floorBuffer,
      floorBufferPct: price > 0 ? (floorBuffer / price) * 100 : 0,
      centerPrice,
      positionPct,
      zoneType,
      buyLevels,
      sellLevels,
      isBelowFloor,
      isAboveCeiling,
      zoneWidthPct,
      channelMode: mode,
      clampStatus,
      rawWidthPct,
      minWidthPct,
      maxWidthPct,
      anchorSide,
      poc: options?.volumeProfile?.poc,
      vah: options?.volumeProfile?.vah,
      val: options?.volumeProfile?.val,
      htfFloor: options?.htfStructure?.floor,
      htfCeil: options?.htfStructure?.ceiling,
      canEstablishChannel: canEstablish,
      gateStatus: gateEvaluation?.gateStatus ?? (hasValidChannel ? "VALID_CHANNEL" : "WARMUP"),
      gateReason: gateEvaluation?.gateReason,
      actualFloorProximityPct: gateEvaluation?.actualFloorProximityPct,
      minFloorProximityPct: gateEvaluation?.safeFloorProximityPct,
    };

    return {
      gridZone,
      finalSpan,
      centerPrice,
      floorBuffer,
      cutLossBound,
    };
  }
}
