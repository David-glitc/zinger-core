// @ts-nocheck
/**
 * Offline fund-management heuristics (duration / conf / price strata).
 * Produced by trainFundHeuristics.js → data/fund_heuristics.json
 *
 * Used for: Kelly sizing, entry timing by duration, TP/SL overlays,
 * and whole-env management (heat / concurrent books / exit tighten).
 */
import { load, dataPath } from '../persistence.js';

const FILE = dataPath('fund_heuristics.json');
let _cache = null;
let _cacheAt = 0;

/** Priors when Gamma has the book but we lack fill samples yet. */
export const DURATION_ENTRY_DEFAULTS = Object.freeze({
  '5m': {
    maxEntryRemainingSec: 270,
    minRemainingSec: 25,
    tpPctLow: 18,
    tpPctHigh: 40,
    slPct: 14,
    kellyFraction: 0.1,
    maxPositionPct: 0.12,
    minConfidence: 0.38,
    maxOpens: 2,
  },
  '15m': {
    maxEntryRemainingSec: 800,
    minRemainingSec: 60,
    tpPctLow: 14,
    tpPctHigh: 36,
    slPct: 16,
    kellyFraction: 0.09,
    maxPositionPct: 0.12,
    minConfidence: 0.4,
    maxOpens: 2,
  },
  '30m': {
    maxEntryRemainingSec: 1600,
    minRemainingSec: 120,
    tpPctLow: 12,
    tpPctHigh: 30,
    slPct: 18,
    kellyFraction: 0.08,
    maxPositionPct: 0.1,
    minConfidence: 0.42,
    maxOpens: 1,
  },
  '1h': {
    maxEntryRemainingSec: 3200,
    minRemainingSec: 180,
    tpPctLow: 12,
    tpPctHigh: 28,
    slPct: 18,
    kellyFraction: 0.07,
    maxPositionPct: 0.1,
    minConfidence: 0.45,
    maxOpens: 1,
  },
});

export function loadFundHeuristics(force = false) {
  if (!force && _cache && Date.now() - _cacheAt < 60_000) return _cache;
  _cache = load(FILE, null);
  _cacheAt = Date.now();
  return _cache;
}

export function normalizeDuration(duration) {
  const d = String(duration || '5m').toLowerCase();
  if (d === '60m') return '1h';
  return DURATION_ENTRY_DEFAULTS[d] ? d : '5m';
}

export function heuristicForTrade({ duration = '5m', confidence, entryPrice, symbol = 'BTC' } = {}) {
  const store = loadFundHeuristics();
  const dur = normalizeDuration(duration);
  const defaults = DURATION_ENTRY_DEFAULTS[dur];
  const conf = Number(confidence);
  const confBucket = !Number.isFinite(conf) ? 'unk'
    : conf < 0.35 ? 'low'
      : conf < 0.5 ? 'mid'
        : conf < 0.65 ? 'high'
          : 'vhigh';
  const p = Number(entryPrice);
  const priceBand = !Number.isFinite(p) ? 'unk'
    : p < 0.35 ? 'dog'
      : p < 0.45 ? 'cheap'
        : p < 0.55 ? 'mid'
          : p < 0.68 ? 'sweet'
            : 'fav';

  const key = `${dur}|${confBucket}|${priceBand}|${String(symbol).toUpperCase()}`;
  const stratum = store?.strata?.[key] || null;
  const durationPolicy = store?.durationPolicies?.[dur] || null;
  const merged = {
    ...defaults,
    ...(durationPolicy || {}),
  };

  return {
    stratum,
    durationPolicy: merged,
    kellyFraction: stratum?.n >= 8
      ? stratum.kellyFraction
      : merged.kellyFraction ?? null,
    maxPositionPct: stratum?.n >= 8
      ? stratum.maxPositionPct
      : merged.maxPositionPct ?? null,
    minConfidence: stratum?.n >= 8
      ? stratum.minConfidence
      : merged.minConfidence ?? null,
    maxEntryRemainingSec: merged.maxEntryRemainingSec ?? null,
    minRemainingSec: merged.minRemainingSec ?? null,
    tpPctLow: merged.tpPctLow ?? null,
    tpPctHigh: merged.tpPctHigh ?? null,
    slPct: merged.slPct ?? null,
    maxOpens: merged.maxOpens ?? null,
    suggested: stratum?.suggested || durationPolicy?.suggested || null,
    exitMix: store?.exitMix || null,
    source: stratum?.n >= 8 ? 'stratum' : durationPolicy ? 'duration' : 'prior',
  };
}

/**
 * Resolve entry timing + confidence floor for a market duration.
 * Prefer trained policy; fall back to duration priors (so 15m/30m/1h enter).
 */
export function resolveEntryWindows(duration, cfg = {}) {
  const heur = heuristicForTrade({ duration });
  const dur = normalizeDuration(duration);
  const prior = DURATION_ENTRY_DEFAULTS[dur];
  return {
    duration: dur,
    maxEntryRemainingSec: Number(
      heur.maxEntryRemainingSec
        ?? cfg[`maxEntryRemainingSec_${dur}`]
        ?? (dur === '5m' ? cfg.maxEntryRemainingSec : null)
        ?? prior.maxEntryRemainingSec,
    ),
    minRemainingSec: Number(
      heur.minRemainingSec
        ?? cfg[`minRemainingSec_${dur}`]
        ?? (dur === '5m' ? cfg.minRemainingSec : null)
        ?? prior.minRemainingSec,
    ),
    minConfidence: Number(heur.minConfidence ?? cfg.minConfidence ?? prior.minConfidence),
    source: heur.source,
  };
}

/**
 * Overlay TP/SL on a dynamic plan from duration management policy.
 */
export function overlayPlanWithHeuristics(plan, { duration, confidence, entryPrice, symbol } = {}) {
  if (!plan) return plan;
  const heur = heuristicForTrade({ duration, confidence, entryPrice, symbol });
  const next = { ...plan };
  if (heur.tpPctLow != null && heur.tpPctHigh != null && !next.holdToSettle) {
    const conf = Number(confidence || 0);
    const span = Number(heur.tpPctHigh) - Number(heur.tpPctLow);
    const target = Number(heur.tpPctLow) + span * Math.min(1, Math.max(0, conf));
    // Soft blend — don't fight adaptive plan more than ~35%
    next.tpPct = Math.round((Number(next.tpPct || target) * 0.65 + target * 0.35) * 10) / 10;
    if (next.partialTpPct != null) {
      next.partialTpPct = Math.round(next.tpPct * 0.78 * 10) / 10;
    }
    if (next.trailActivatePct != null) {
      next.trailActivatePct = Math.round(next.tpPct * 0.72 * 10) / 10;
    }
  }
  if (heur.slPct != null && !next.holdToSettle) {
    next.slPct = Math.round((Number(next.slPct || heur.slPct) * 0.6 + Number(heur.slPct) * 0.4) * 10) / 10;
  }
  next.heuristicSource = heur.source;
  return next;
}

/**
 * Whole-env management: portfolio heat, concurrent books per duration, exit tighten.
 */
export function manageEnvironment({
  opens = [],
  mode = 'paper',
  maxOpenPositions = 6,
  cash = null,
  equity = null,
} = {}) {
  const open = (opens || []).filter((p) => !p.closed && (!p.mode || p.mode === mode));
  const byDuration = {};
  for (const p of open) {
    const d = normalizeDuration(p.duration || (String(p.slug || '').match(/-updown-(5m|15m|30m|1h|60m)-/i)?.[1]));
    byDuration[d] = (byDuration[d] || 0) + 1;
  }

  const heat = Number.isFinite(Number(equity)) && Number(equity) > 0 && Number.isFinite(Number(cash))
    ? Math.max(0, 1 - Number(cash) / Number(equity))
    : open.length / Math.max(1, maxOpenPositions);

  const exitMix = loadFundHeuristics()?.exitMix || {};
  const panicHeavy = Number(exitMix.panic || 0) + Number(exitMix.dd || 0) > Number(exitMix.tp || 0);

  const allowNewEntries = open.length < maxOpenPositions && heat < 0.85;
  const tightenExits = heat > 0.55 || panicHeavy;
  const reasons = [];
  if (!allowNewEntries) reasons.push(open.length >= maxOpenPositions ? 'max opens' : 'portfolio heat');
  if (tightenExits) reasons.push(panicHeavy ? 'exit-mix dd/panic heavy' : 'heat tighten');

  return {
    allowNewEntries,
    tightenExits,
    heat: Math.round(heat * 1000) / 1000,
    openCount: open.length,
    byDuration,
    maxOpensFor(duration) {
      const prior = DURATION_ENTRY_DEFAULTS[normalizeDuration(duration)];
      const used = byDuration[normalizeDuration(duration)] || 0;
      return used < Number(prior?.maxOpens ?? 2);
    },
    reasons,
  };
}
