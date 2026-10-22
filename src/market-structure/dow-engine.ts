import type {
  Candle,
  SwingPoint,
  DowSwingPoint,
  DowLabel,
  WaveLeg,
  WaveCycleData,
  TrendLinePoint,
  MarketRegime,
  CandidatePoint,
} from "./types.js";
import { getEffectiveLow } from "./candle-manager.js";
import { SwingDetector } from "./swing-detector.js";

export class DowEngine {
  /**
   * Calculate Dow Theory Wave Cycles and annotate swings (HH, LH, HL, LL),
   * identifying structural trend transitions (จุดที่เริ่มทำ HL, HH, LH, LL).
   */
  public static calculateWaveCycles(
    candles: Candle[],
    swingHighs: SwingPoint[],
    swingLows: SwingPoint[],
    structureLookback = 120,
    _activeValley?: SwingPoint,
    _activePeak?: SwingPoint,
  ): WaveCycleData {
    const n = candles.length;
    if (n < 4) {
      return {
        legs: [],
        wavePoints: [],
        annotatedSwings: [],
      };
    }

    const lookback = Math.min(n, structureLookback);
    const minIndex = Math.max(0, n - lookback);

    // Collect all confirmed swings within the lookback window, strictly ordered by time
    const rawSwings: SwingPoint[] = [
      ...swingHighs.filter((s) => s.index >= minIndex),
      ...swingLows.filter((s) => s.index >= minIndex),
    ].sort((a, b) => a.time - b.time);

    if (rawSwings.length === 0) {
      return {
        legs: [],
        wavePoints: [],
        annotatedSwings: [],
      };
    }

    // 1. Filter into canonical alternating ZigZag swings (Peak -> Valley -> Peak -> Valley...)
    const alternatingSwings: SwingPoint[] = [];
    for (const s of rawSwings) {
      if (alternatingSwings.length === 0) {
        alternatingSwings.push({ ...s });
        continue;
      }
      const prev = alternatingSwings[alternatingSwings.length - 1];
      if (!prev) {
        alternatingSwings.push({ ...s });
        continue;
      }
      if (s.type === prev.type) {
        if (s.type === "HIGH" && s.price >= prev.price) {
          alternatingSwings[alternatingSwings.length - 1] = { ...s };
        } else if (s.type === "LOW" && s.price <= prev.price) {
          alternatingSwings[alternatingSwings.length - 1] = { ...s };
        }
      } else {
        alternatingSwings.push({ ...s });
      }
    }

    // 2. Annotate each swing with Dow Theory structure (HH, LH, HL, LL)
    // and identify transition starts (จุดที่เริ่มทำ HL, HH, LH, LL)
    const annotatedSwings: DowSwingPoint[] = [];
    let lastHigh: SwingPoint | undefined;
    let lastLow: SwingPoint | undefined;
    let lastHighLabel: DowLabel | undefined;
    let lastLowLabel: DowLabel | undefined;

    let lastHh: DowSwingPoint | undefined;
    let lastHl: DowSwingPoint | undefined;
    let lastLh: DowSwingPoint | undefined;
    let lastLl: DowSwingPoint | undefined;

    for (const s of alternatingSwings) {
      if (s.type === "HIGH") {
        let dowLabel: DowLabel = "HH";
        let isTransitionStart = false;
        let transitionType: DowSwingPoint["transitionType"];
        let changePct: number | undefined;

        if (!lastHigh) {
          dowLabel = "HH";
          lastHighLabel = "HH";
        } else {
          changePct = ((s.price - lastHigh.price) / lastHigh.price) * 100;
          if (s.price > lastHigh.price) {
            dowLabel = "HH";
            if (lastHighLabel === "LH") {
              isTransitionStart = true;
              transitionType = "START_HH";
            }
            lastHighLabel = "HH";
          } else {
            dowLabel = "LH";
            if (lastHighLabel === "HH") {
              isTransitionStart = true;
              transitionType = "START_LH";
            }
            lastHighLabel = "LH";
          }
        }

        const annotated: DowSwingPoint = {
          ...s,
          dowLabel,
          isTransitionStart,
          transitionType,
          prevPrice: lastHigh?.price,
          changePct,
          labelDescription: isTransitionStart
            ? (transitionType === "START_HH" ? "เริ่มทำ Higher High (HH)" : "เริ่มทำ Lower High (LH)")
            : (dowLabel === "HH" ? "Higher High (HH)" : "Lower High (LH)"),
        };

        if (dowLabel === "HH") lastHh = annotated;
        else lastLh = annotated;

        lastHigh = s;
        annotatedSwings.push(annotated);
      } else {
        let dowLabel: DowLabel = "LL";
        let isTransitionStart = false;
        let transitionType: DowSwingPoint["transitionType"];
        let changePct: number | undefined;

        // ค้นหาจุดต่ำสุดของสวิงโลว์ที่ยืนยันแล้ว (alternatingSwings) ก่อนหน้านับตั้งแต่ยอด High ล่าสุด (lastHigh)
        // หากอยู่ในช่วงขาลงหลังจากยอด High (s.time > lastHigh.time):
        // เหวที่ยืนยันแล้วซึ่งเกิดขึ้นระหว่างรอบทุบ หากราคาต่ำกว่าเหวยืนยันก่อนหน้า ต้องเป็น LL เสมอ!
        const priorLowsInDownwave = annotatedSwings.filter(
          (l) => l.type === "LOW" && lastHigh && l.time > lastHigh.time && l.time < s.time
        );
        const hasHigherPriorLowInWave = priorLowsInDownwave.some((l) => l.price > s.price);

        if (!lastLow) {
          dowLabel = "LL";
          lastLowLabel = "LL";
        } else {
          changePct = ((s.price - lastLow.price) / lastLow.price) * 100;
          // ถ้ามีเหวก่อนหน้าในรอบทุบนี้ที่สูงกว่าจุดนี้ แปลว่าจุดนี้รูดลงมาทำนิวโลว์ -> ต้องเป็น LL!
          if (hasHigherPriorLowInWave) {
            dowLabel = "LL";
            if (lastLowLabel === "HL") {
              isTransitionStart = true;
              transitionType = "START_LL";
            }
            lastLowLabel = "LL";
          } else if (s.price > lastLow.price) {
            dowLabel = "HL";
            if (lastLowLabel === "LL") {
              isTransitionStart = true;
              transitionType = "START_HL";
            }
            lastLowLabel = "HL";
          } else {
            dowLabel = "LL";
            if (lastLowLabel === "HL") {
              isTransitionStart = true;
              transitionType = "START_LL";
            }
            lastLowLabel = "LL";
          }
        }

        const annotated: DowSwingPoint = {
          ...s,
          dowLabel,
          isTransitionStart,
          transitionType,
          prevPrice: lastLow?.price,
          changePct,
          labelDescription: isTransitionStart
            ? (transitionType === "START_HL" ? "เริ่มทำ Higher Low (HL) ยกฐานกลับตัว" : "เริ่มทำ Lower Low (LL) หลุดฐาน")
            : (dowLabel === "HL" ? "Higher Low (HL) ยกฐาน" : "Lower Low (LL) หลุดฐาน"),
        };

        if (dowLabel === "HL") lastHl = annotated;
        else lastLl = annotated;

        lastLow = s;
        annotatedSwings.push(annotated);
      }
    }

    // 2.1 Invalidate False HLs: หากมีจุดสวิง Low ใดที่เคยถูกมองว่าเป็น HL ชั่วคราว
    // แต่ในเวลาต่อมามีสวิง Low ถัดมา (หรือสวิง Low ในรอบทุบ) ที่กดตัวต่ำกว่ามัน (New Low ต่ำกว่า HL นั้น)
    // โครงสร้าง Higher Low นั้นถือว่าถูกทำลาย (Broken/Invalidated) ทันที -> ต้องเปลี่ยนป้ายเป็น LL
    for (let i = 0; i < annotatedSwings.length; i++) {
      const sw = annotatedSwings[i]!;
      if (sw.type === "LOW" && sw.dowLabel === "HL") {
        const futureLows = annotatedSwings.slice(i + 1).filter((next) => next.type === "LOW");
        const brokenByFutureLow = futureLows.some((next) => next.price < sw.price);
        if (brokenByFutureLow) {
          sw.dowLabel = "LL";
          sw.labelDescription = "Lower Low (LL) หลุดฐาน";
          sw.isTransitionStart = false;
          sw.transitionType = undefined;
        }
      }
    }

    // Re-evaluate lastHl / lastLl after invalidation
    lastHl = undefined;
    lastLl = undefined;
    for (const sw of annotatedSwings) {
      if (sw.type === "LOW") {
        if (sw.dowLabel === "HL") lastHl = sw;
        else if (sw.dowLabel === "LL") lastLl = sw;
      }
    }
    lastLowLabel = annotatedSwings.filter((s) => s.type === "LOW").pop()?.dowLabel ?? "LL";

    // 3. Build wave legs and interpolated continuous wave points
    const legs: WaveLeg[] = [];
    const wavePoints: TrendLinePoint[] = [];

    for (let i = 1; i < annotatedSwings.length; i++) {
      const from = annotatedSwings[i - 1];
      const to = annotatedSwings[i];
      if (!from || !to) continue;

      const direction: "UP" | "DOWN" = to.type === "HIGH" ? "UP" : "DOWN";
      const changePct = ((to.price - from.price) / from.price) * 100;
      const barCount = Math.abs(to.index - from.index);
      const durationSec = Math.abs(to.time - from.time);
      const description = `${direction === "UP" ? "คลื่นขึ้น ↗" : "คลื่นลง ↘"} ${from.dowLabel} ➔ ${to.dowLabel} (${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%)`;

      legs.push({
        from,
        to,
        direction,
        changePct,
        barCount,
        durationSec,
        description,
      });

      const minIdx = Math.min(from.index, to.index);
      const maxIdx = Math.max(from.index, to.index);
      const idxSpan = Math.max(1, maxIdx - minIdx);

      for (let cIdx = minIdx; cIdx <= maxIdx; cIdx++) {
        const c = candles[cIdx];
        if (!c) continue;
        const progress = (cIdx - minIdx) / idxSpan;
        const interpPrice = from.index < to.index
          ? from.price + progress * (to.price - from.price)
          : to.price + (1 - progress) * (from.price - to.price);

        const lastPt = wavePoints[wavePoints.length - 1];
        if (lastPt && lastPt.time === c.time) {
          lastPt.value = Number(interpPrice.toFixed(6));
        } else {
          wavePoints.push({
            time: c.time,
            value: Number(interpPrice.toFixed(6)),
          });
        }
      }
    }

    // 4. Current active forming leg (informational metadata only; wave line stops at the last confirmed swing)
    const currentLeg: WaveLeg | undefined = legs.length > 0 ? legs[legs.length - 1] : undefined;

    let activeCycleSummary = "รอบคลื่น: ก่อตัว (Warmup)";
    if (annotatedSwings.length >= 2) {
      const isBull = lastHighLabel === "HH" && lastLowLabel === "HL";
      const isBear = lastHighLabel === "LH" && lastLowLabel === "LL";
      if (isBull) {
        activeCycleSummary = "รอบคลื่น: ขาขึ้น (HH + HL ยกตัว)";
      } else if (isBear) {
        activeCycleSummary = "รอบคลื่น: ขาลง (LH + LL กดตัว)";
      } else if (lastLowLabel === "HL") {
        activeCycleSummary = "รอบคลื่น: ฟื้นตัว (ยก HL ฐานสูงขึ้น)";
      } else if (lastHighLabel === "LH") {
        activeCycleSummary = "รอบคลื่น: ชะลอตัว (ติด LH ยอดต่ำลง)";
      } else {
        const lastTwo = annotatedSwings.slice(-2);
        activeCycleSummary = `รอบคลื่น: ไซด์เวย์ (${lastTwo.map((s) => s.dowLabel).join(" ➔ ")})`;
      }
    }

    // Deduplicate wave points and ensure strictly ascending by time for Lightweight Charts
    const wavePtMap = new Map<number, TrendLinePoint>();
    for (const pt of wavePoints) {
      if (pt && typeof pt.time === "number" && Number.isFinite(pt.time) && Number.isFinite(pt.value)) {
        wavePtMap.set(pt.time, pt);
      }
    }
    const cleanWavePoints = Array.from(wavePtMap.values()).sort((a, b) => a.time - b.time);

    return {
      legs,
      currentLeg,
      wavePoints: cleanWavePoints,
      annotatedSwings,
      lastHh,
      lastHl,
      lastLh,
      lastLl,
      activeCycleSummary,
    };
  }

  /**
   * Check if a valid Dow Theory Higher Low (HL) has formed after a floor breakdown.
   */
  public static checkForHigherLow(
    candles: Candle[],
    swingHighs: SwingPoint[],
    swingLows: SwingPoint[],
    sinceTime: number,
    referenceFloor: number,
    lowestDumpPrice: number,
    currentPrice?: number,
    useTrueWick = true,
    wickThresholdPct = 0.20,
    structureLookback = 120,
  ): { confirmed: boolean; higherLow?: SwingPoint; reason?: string } {
    if (swingLows.length === 0) {
      return { confirmed: false, reason: "No confirmed swing lows in memory" };
    }

    // Find the actual timestamp of the lowest dump trough in candles so a pre-dump swing is never mistaken for a post-dump HL
    let effectiveSinceTime = sinceTime;
    for (const c of candles) {
      const effLow = getEffectiveLow(c, useTrueWick, wickThresholdPct);
      if (c.time >= sinceTime - 3600 && (c.low <= lowestDumpPrice * 1.0005 || effLow <= lowestDumpPrice * 1.0005)) {
        if (c.time > effectiveSinceTime) {
          effectiveSinceTime = c.time;
        }
      }
    }

    // 1. Check annotated structural wave swings (if the wave cycle already labeled a confirmed unbroken "HL" after the lowest dump)
    const wave = DowEngine.calculateWaveCycles(candles, swingHighs, swingLows, structureLookback);
    if (wave && wave.annotatedSwings.length > 0) {
      const postDumpSwings = wave.annotatedSwings.filter(
        (s) =>
          s.type === "LOW" &&
          s.dowLabel === "HL" &&
          s.time >= effectiveSinceTime &&
          s.price > lowestDumpPrice * 1.0005 &&
          SwingDetector.isSwingLowUnbroken(s, candles, useTrueWick, wickThresholdPct),
      );
      if (postDumpSwings.length > 0) {
        const lastHl = postDumpSwings[postDumpSwings.length - 1]!;
        if (!currentPrice || currentPrice >= lastHl.price * 0.999) {
          return {
            confirmed: true,
            higherLow: lastHl,
            reason: `Structural Wave labeled ${lastHl.dowLabel} at $${lastHl.price.toFixed(6)} > lowest dump $${lowestDumpPrice.toFixed(6)}`,
          };
        }
      }
    }

    // 2. Check confirmed unbroken swing lows formed strictly at/after the dump trough
    const recentConfirmedLows = swingLows.filter(
      (s) => s.time >= effectiveSinceTime && SwingDetector.isSwingLowUnbroken(s, candles, useTrueWick, wickThresholdPct),
    );

    for (let i = recentConfirmedLows.length - 1; i >= 0; i--) {
      const candidateLow = recentConfirmedLows[i];
      if (!candidateLow) continue;

      // Guard 1: Never treat a swing that was structurally classified as "LL" (Lower Low) as an HL!
      const annotated = wave?.annotatedSwings.find(
        (s) => s.type === "LOW" && (s.index === candidateLow.index || s.time === candidateLow.time),
      );
      if (annotated && annotated.dowLabel === "LL") {
        continue;
      }

      const isHigherThanDump = candidateLow.price > lowestDumpPrice * 1.0005;

      // Guard 2: Must compare with the IMMEDIATELY PRECEDING swing low in the wave, NOT any ancient swing in history!
      const candidateIdx = swingLows.findIndex((s) => s.index === candidateLow.index || s.time === candidateLow.time);
      const immediatePriorLow = candidateIdx > 0 ? swingLows[candidateIdx - 1] : undefined;
      const isHigherThanImmediatePrior = Boolean(immediatePriorLow && candidateLow.price > immediatePriorLow.price * 1.0005);
      const isPriceHoldingAbove = currentPrice ? currentPrice >= candidateLow.price : true;

      // Higher Low requires:
      // 1. Higher than the dump trough
      // 2. Higher than the immediate preceding low in the wave structure
      // 3. Price holding above the candidate low
      if (isHigherThanDump && isHigherThanImmediatePrior && isPriceHoldingAbove) {
        return {
          confirmed: true,
          higherLow: candidateLow,
          reason: `Confirmed Higher Low at $${candidateLow.price.toFixed(6)} > Prior Low $${immediatePriorLow!.price.toFixed(6)} (and Lowest $${lowestDumpPrice.toFixed(6)})`,
        };
      }
    }

    // 3. Fast 2-Bar Structural Micro-HL (Confirmed Closed Candles)
    const closedCandles = candles.length > 0 && candles[candles.length - 1]?.isClosed === true ? candles : candles.slice(0, -1);
    if (closedCandles.length >= 4) {
      let troughIdx = -1;
      let troughLow = lowestDumpPrice;
      for (let i = 0; i < closedCandles.length; i++) {
        const c = closedCandles[i]!;
        if (c.time >= sinceTime - 3600) {
          const effLow = getEffectiveLow(c, useTrueWick, wickThresholdPct);
          const barLow = Math.min(c.low, effLow);
          if (troughIdx === -1 || barLow <= troughLow * 1.0005) {
            troughLow = Math.min(troughLow, barLow);
            troughIdx = i;
          }
        }
      }

      if (troughIdx >= 0 && closedCandles.length - 1 >= troughIdx + 2) {
        const lastClosed = closedCandles[closedCandles.length - 1]!;
        let maxBounceHigh = closedCandles[troughIdx]!.high;

        for (let i = troughIdx + 1; i < closedCandles.length; i++) {
          const c = closedCandles[i]!;
          const effLow = getEffectiveLow(c, useTrueWick, wickThresholdPct);
          const barLow = Math.min(c.low, effLow);

          // Must hold strictly above dump trough (+0.10%) and have seen an initial bounce (>= +0.20%)
          const isHigherLowRetest =
            barLow > troughLow * 1.001 &&
            maxBounceHigh >= troughLow * 1.002 &&
            barLow < maxBounceHigh;

          if (isHigherLowRetest) {
            const nextBarConfirmed =
              i < closedCandles.length - 1 &&
              lastClosed.close > lastClosed.open &&
              lastClosed.close >= c.high &&
              lastClosed.close >= referenceFloor * 0.998;

            const selfReversalConfirmed =
              i >= troughIdx + 2 &&
              c.close > c.open &&
              c.close >= maxBounceHigh &&
              c.close >= referenceFloor * 0.998;

            const isLiveHolding = !currentPrice || (currentPrice >= barLow && currentPrice >= referenceFloor * 0.998);

            if ((nextBarConfirmed || selfReversalConfirmed) && isLiveHolding) {
              const microHl: SwingPoint = {
                index: i,
                time: c.time,
                price: barLow,
                type: "LOW",
              };
              return {
                confirmed: true,
                higherLow: microHl,
                reason: `Fast 2-Bar Micro-HL at $${barLow.toFixed(6)} > Dump Trough $${troughLow.toFixed(6)} (Closed @ $${lastClosed.close.toFixed(6)})`,
              };
            }
          }

          if (c.high > maxBounceHigh) {
            maxBounceHigh = c.high;
          }
        }
      }
    }

    return { confirmed: false, reason: "Waiting for confirmed Higher Low or 2-bar Micro-HL after dump trough" };
  }

  /**
   * Determine market regime according to Dow Theory (UPTREND, DOWNTREND, RANGE, WARMUP)
   */
  public static determineMarketRegime(
    swingHighs: SwingPoint[],
    swingLows: SwingPoint[],
    isSwingConfirmed: boolean,
  ): MarketRegime {
    if (!isSwingConfirmed) return "WARMUP";

    const lastHigh = swingHighs[swingHighs.length - 1];
    const lastLow = swingLows[swingLows.length - 1];
    const prevHigh = swingHighs.length >= 2 ? swingHighs[swingHighs.length - 2] : undefined;
    const prevLow = swingLows.length >= 2 ? swingLows[swingLows.length - 2] : undefined;

    if (lastHigh && lastLow && prevHigh && prevLow) {
      const higherHigh = lastHigh.price > prevHigh.price;
      const higherLow = lastLow.price > prevLow.price;
      const lowerHigh = lastHigh.price < prevHigh.price;
      const lowerLow = lastLow.price < prevLow.price;

      if (higherHigh && higherLow) {
        return "UPTREND";
      } else if (lowerHigh && lowerLow) {
        return "DOWNTREND";
      } else {
        return "RANGE";
      }
    }

    return "RANGE";
  }

  /**
   * Active downtrend drop detection:
   * 1) Confirmed active bear wave where the latest low is LL and no subsequent HH or HL has broken the bear structure, OR
   * 2) Real-time breakdown below the active channel floor (หลุดฐานกรอบ)
   */
  public static detectDowntrendDrop(
    candles: Candle[],
    lastCanonicalHigh: DowSwingPoint | undefined,
    lastCanonicalLow: DowSwingPoint | undefined,
    candidateValley: CandidatePoint | undefined,
    activePeak: SwingPoint | undefined,
    activeValley: SwingPoint | undefined,
    bottomBound: number,
    upperBound: number,
    finalSpan: number,
    price: number,
    hasValidChannel: boolean,
    useTrueWick = true,
    wickThresholdPct = 0.20,
  ): { isDowntrendDropActive: boolean; downtrendDropLow: number } {
    const activeFloorPrice = bottomBound > 0 ? bottomBound : (activeValley?.price ?? 0);
    const isBreakingBelowChannelFloor = Boolean(
      hasValidChannel && (
        price < activeFloorPrice ||
        (candidateValley && candidateValley.price < activeFloorPrice)
      )
    );

    const buy2LevelPrice = hasValidChannel ? (bottomBound + finalSpan * 0.32) : 0;
    const hasReclaimedBuy2SinceLl = Boolean(
      hasValidChannel &&
      lastCanonicalLow &&
      candles.some((c) => c.time > lastCanonicalLow.time && c.close >= buy2LevelPrice * 0.9995)
    );
    const isFreshLlAfterPeak = Boolean(
      lastCanonicalLow?.dowLabel === "LL" &&
      lastCanonicalLow.index > (lastCanonicalHigh?.index ?? -1) &&
      !hasReclaimedBuy2SinceLl
    );
    const isConfirmedDowntrendWave = Boolean(
      isFreshLlAfterPeak &&
      price < (activePeak?.price ?? upperBound)
    );
    const isDowntrendDropActive = isConfirmedDowntrendWave || isBreakingBelowChannelFloor;

    const dropPrices: number[] = [];
    if (lastCanonicalLow?.dowLabel === "LL") {
      dropPrices.push(lastCanonicalLow.price);
      for (const c of candles) {
        if (c.time >= lastCanonicalLow.time) {
          dropPrices.push(getEffectiveLow(c, useTrueWick, wickThresholdPct));
        }
      }
    }
    if (candidateValley && (!lastCanonicalLow || candidateValley.time >= lastCanonicalLow.time)) {
      dropPrices.push(candidateValley.price);
    }
    if (isBreakingBelowChannelFloor || dropPrices.length === 0) {
      dropPrices.push(price);
    }
    const downtrendDropLow = dropPrices.length > 0
      ? Math.min(...dropPrices)
      : (lastCanonicalLow?.price ?? bottomBound);

    return {
      isDowntrendDropActive,
      downtrendDropLow,
    };
  }
}
