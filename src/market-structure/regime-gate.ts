/**
 * Regime Channel Gate Module
 * 
 * Enforces the "Trend-Gated Structural Channel" architecture:
 * 1. No Channel in a Downtrend (LH+LL / Waterfall dump) -> Standby in 100% Cash.
 * 2. Base Confirmation Protocol -> Only open channel once genuine Higher Low (HL) forms.
 * 3. Safe Floor Proximity Buffer -> Reject channel if Floor is dangerously close (< minProximityPct) to price.
 * 4. Channel Death on Breakdown -> Floor cannot slide down with dump.
 */

import type { Candle, MarketRegime, SwingPoint, WaveCycleData, DowSwingPoint } from "./types.js";

export type ChannelGateStatus =
  | "VALID_CHANNEL"
  | "DOWNTREND_NO_CHANNEL"
  | "WAITING_FOR_BASE_CONFIRMATION"
  | "UNSAFE_FLOOR_PROXIMITY"
  | "WAITING_FOR_CHOCH_BREAKOUT"
  | "WARMUP";

export interface ChannelGateEvaluation {
  canEstablishChannel: boolean;
  gateStatus: ChannelGateStatus;
  gateReason: string;
  safeFloorProximityPct: number;
  actualFloorProximityPct: number;
  isChoChBullish?: boolean;
  choChLevel?: number;
}

export interface ChannelGateParams {
  price: number;
  proposedFloor: number;
  proposedCeiling: number;
  regime: MarketRegime;
  waveCycle?: WaveCycleData;
  lastCanonicalLow?: DowSwingPoint;
  lastCanonicalHigh?: DowSwingPoint;
  lastLh?: DowSwingPoint;
  isDowntrendDropActive?: boolean;
  minFloorProximityPct?: number; // e.g. 1.5% for BTC, 3.5% for SOMI
  enableTrendGating?: boolean;
  enableBaseConfirmationFilter?: boolean;
}

export class RegimeChannelGate {
  /**
   * Evaluates whether current market regime and structural conditions allow establishing a tradeable Grid Channel.
   */
  public static evaluateGate(params: ChannelGateParams): ChannelGateEvaluation {
    const {
      price,
      proposedFloor,
      regime,
      waveCycle,
      lastCanonicalLow,
      lastCanonicalHigh,
      lastLh,
      isDowntrendDropActive,
      minFloorProximityPct = 1.5,
      enableTrendGating = true,
    } = params;

    const actualProximityPct = proposedFloor > 0 && price > proposedFloor
      ? ((price - proposedFloor) / price) * 100
      : 0;

    const choChLevel = lastLh?.price;
    const isChoChBullish = !lastLh || lastLh.price <= 0 || price >= lastLh.price * 0.999;
    const allowBaseBypass = params.enableBaseConfirmationFilter === false;

    // If gating is explicitly disabled or base confirmation is bypassed, allow all valid channels
    if (enableTrendGating === false || allowBaseBypass) {
      return {
        canEstablishChannel: proposedFloor > 0,
        gateStatus: proposedFloor > 0 ? "VALID_CHANNEL" : "WARMUP",
        gateReason: allowBaseBypass ? "Base confirmation & trend gating bypassed by configuration" : "Trend gating disabled by configuration",
        safeFloorProximityPct: minFloorProximityPct,
        actualFloorProximityPct: actualProximityPct,
        isChoChBullish,
        choChLevel,
      };
    }

    if (!proposedFloor || proposedFloor <= 0 || !price || price <= 0) {
      return {
        canEstablishChannel: false,
        gateStatus: "WARMUP",
        gateReason: "Insufficient structure or warmup in progress",
        safeFloorProximityPct: minFloorProximityPct,
        actualFloorProximityPct: 0,
        isChoChBullish,
        choChLevel,
      };
    }

    // ── Pillar 1: Dow ChoCh & Downtrend Gate (Horizontal Last LH Breakout) ─────
    // In Dow Theory, a downtrend is broken only when price breaks above the last Lower High (ChoCh).
    const isUnderLastLh = !allowBaseBypass && Boolean(lastLh && lastLh.price > 0 && price < lastLh.price * 0.999);
    const isDowntrendStructure = !allowBaseBypass && (regime === "DOWNTREND" ||
      (lastCanonicalLow?.dowLabel === "LL" && lastCanonicalHigh?.dowLabel === "LH") ||
      Boolean(waveCycle?.activeCycleSummary?.includes("ขาลง")));

    if (isUnderLastLh && isDowntrendStructure) {
      const lhStr = lastLh.price < 0.01 ? lastLh.price.toFixed(8) : lastLh.price.toFixed(4);
      return {
        canEstablishChannel: false,
        gateStatus: "DOWNTREND_NO_CHANNEL",
        gateReason: `Downtrend active under last LH ($${lhStr}) — Waiting for Dow ChoCh breakout before opening channel`,
        safeFloorProximityPct: minFloorProximityPct,
        actualFloorProximityPct: actualProximityPct,
        isChoChBullish: false,
        choChLevel,
      };
    }

    if (isDowntrendStructure && !isChoChBullish) {
      return {
        canEstablishChannel: false,
        gateStatus: "DOWNTREND_NO_CHANNEL",
        gateReason: `Downtrend active (LH+LL / ${waveCycle?.activeCycleSummary || "Bear wave"}) — Grid channel disabled to prevent catching falling knives`,
        safeFloorProximityPct: minFloorProximityPct,
        actualFloorProximityPct: actualProximityPct,
        isChoChBullish: false,
        choChLevel,
      };
    }

    // ── Pillar 2: Base Confirmation Protocol (Active Dump / Breaking Lows) ──
    const isBreakingLow = !allowBaseBypass && Boolean(
      isDowntrendDropActive ||
      (lastCanonicalLow && price < lastCanonicalLow.price * 0.9995)
    );

    if (isBreakingLow) {
      return {
        canEstablishChannel: false,
        gateStatus: "WAITING_FOR_BASE_CONFIRMATION",
        gateReason: "Price breaking below previous swing low (BOS) — waiting for Higher Low (HL) base formation",
        safeFloorProximityPct: minFloorProximityPct,
        actualFloorProximityPct: actualProximityPct,
        isChoChBullish,
        choChLevel,
      };
    }

    // ── Pillar 3: Safe Floor Proximity Buffer ──────────────────────────────
    // If the proposed floor is dangerously close to current price,
    // any minor random wick will trigger cut loss instantly. Reject until room exists.
    if (!allowBaseBypass && actualProximityPct < minFloorProximityPct) {
      const flStr = proposedFloor < 0.01 ? proposedFloor.toFixed(8) : proposedFloor.toFixed(4);
      const prStr = price < 0.01 ? price.toFixed(8) : price.toFixed(4);
      return {
        canEstablishChannel: false,
        gateStatus: "UNSAFE_FLOOR_PROXIMITY",
        gateReason: `Floor ($${flStr}) is dangerously close (${actualProximityPct.toFixed(2)}%) to price ($${prStr}) — minimum safe proximity is ${minFloorProximityPct.toFixed(2)}%`,
        safeFloorProximityPct: minFloorProximityPct,
        actualFloorProximityPct: actualProximityPct,
        isChoChBullish,
        choChLevel,
      };
    }

    // ── Pillar 4: All Clear — Valid Channel Approved! ───────────────────────
    const choChStr = lastLh && lastLh.price < 0.01 ? lastLh.price.toFixed(8) : lastLh?.price.toFixed(4);
    return {
      canEstablishChannel: true,
      gateStatus: "VALID_CHANNEL",
      gateReason: (lastLh && price >= lastLh.price * 0.999)
        ? `Dow ChoCh confirmed (> $${choChStr}) • Channel active`
        : "Market structure in healthy Range/Base with safe proximity buffer",
      safeFloorProximityPct: minFloorProximityPct,
      actualFloorProximityPct: actualProximityPct,
      isChoChBullish,
      choChLevel,
    };
  }
}
