/**
 * Paper / live strategy isolation.
 * Shared: mode, enabled, paper cash ledger fields.
 * Everything else lives under profiles.paper / profiles.live.
 */

export const SHARED_KEYS = new Set([
  'mode',
  'enabled',
  'paperBankroll',
  'paperInitialDeposit',
]);

/** Strategy knobs that must NOT leak across modes */
export const STRATEGY_KEYS = [
  'minPrice', 'maxPrice',
  'tpPctLow', 'tpPctHigh', 'slPct',
  'maxPositionSize', 'minPositionSize', 'maxPositionPct', 'maxPositionCap',
  'bankrollReservePct',
  'useKellySizing', 'kellyFraction',
  'certaintySizing', 'certaintyMaxPct', 'certaintyMaxUsd',
  'arbBankrollFrac', 'arbMaxUsd',
  'useAggressiveScaling', 'aggScaleMultiplier',
  'minRemainingSec', 'maxEntryRemainingSec',
  'assets', 'use15m', 'enabledDurations',
  'maxConcurrentPerSlug', 'maxOpenPositions',
  'minConfidence',
  'useSignals', 'useML', 'useOrderBookBias', 'requireTightSpread',
  'tradeCurrentWindowOnly',
  'announceBeforeTrade', 'announceTimeoutSec',
  'autoApprovePaper', 'autoApproveLive',
  'partialTpFrac', 'partialSellPct', 'trailActivateFrac', 'trailDistanceCap',
  'adaptiveSl', 'minAdaptiveSlPct',
  'llmOptimize', 'optimizeIntervalMs',
  'governorEnabled', 'governorIntervalMs', 'governorCooldownMs',
  'governorDrawdownPct', 'governorRevertTrades',
  'evalBothSides', 'sideBalanceEnabled', 'sideBalanceWeight',
  'preferShortTf', 'shortTfWeight',
  'clobArbEnabled', 'minArbGap', 'arbExploreRate',
  'arbOnlyUntilEdge', 'forceArbOnly', 'requireEdgeForLive',
  'edgeLookback', 'edgeMinTrades', 'edgeMinExpectancy',
  'holdToSettleUnderdogs', 'underdogMaxPrice', 'holdToSettleDisasterSlPct',
  'holdToSettleFavorites', 'favoriteMinPrice', 'favoriteMaxPrice',
  'slMaxSlippagePct',
  'allowScaleIn',
  'maxOpenDrawdownPct',
  'simulateClobFees',
  'useClobMarketFees',
  'feeCategory',
  'minTpUsd',
  'requireDataAssurance',
];

export function defaultPaperStrategy() {
  return {
    // Pilot paper book ($1k): sweet entry band + 10% cash max ticket.
    // Sweet spots from thesis/dev: mid-priced 0.42–0.68, conf ~0.35–0.55; avoid ≥0.70 favorites.
    minPrice: 0.42, maxPrice: 0.68,
    tpPctLow: 18, tpPctHigh: 36, slPct: 12,
    maxPositionSize: 100,
    minPositionSize: 5,
    maxPositionPct: 0.10,
    maxPositionCap: 100,
    bankrollReservePct: 0.05,
    useKellySizing: true,
    kellyFraction: 0.12,
    certaintySizing: true,
    certaintyMaxPct: 0.10,
    certaintyMaxUsd: 100,
    arbBankrollFrac: 0.10,
    arbMaxUsd: 50,
    useAggressiveScaling: false,
    aggScaleMultiplier: 1.0,
    minRemainingSec: 30,
    maxEntryRemainingSec: 270,
    assets: ['BTC', 'ETH'],
    use15m: true,
    enabledDurations: ['5m', '15m', '30m', '1h'],
    maxConcurrentPerSlug: 1,
    maxOpenPositions: 4,
    minConfidence: 0.38,
    useSignals: true,
    useML: true,
    useOrderBookBias: true,
    requireTightSpread: true,
    tradeCurrentWindowOnly: true,
    announceBeforeTrade: true,
    announceTimeoutSec: 28,
    autoApprovePaper: true,
    autoApproveLive: false,
    partialTpFrac: 0.78,
    partialSellPct: 0.28,
    trailActivateFrac: 0.72,
    trailDistanceCap: 10,
    minTpUsd: 5,
    adaptiveSl: false,
    minAdaptiveSlPct: 10,
    slMaxSlippagePct: 2,
    // Live CLOB schedule via /clob-markets fd.r/e (fallback category crypto).
    simulateClobFees: true,
    useClobMarketFees: true,
    feeCategory: 'crypto',
    // Skip buys when spot/signal/mids/to-beat/ledger fail freshness checks.
    requireDataAssurance: true,
    llmOptimize: false,
    optimizeIntervalMs: 180000,
    governorEnabled: true,
    governorIntervalMs: 120000,
    governorCooldownMs: 240000,
    governorDrawdownPct: 0.12,
    governorRevertTrades: 6,
    evalBothSides: true,
    sideBalanceEnabled: true,
    sideBalanceWeight: 12,
    preferShortTf: true,
    shortTfWeight: 2.0,
    clobArbEnabled: true,
    minArbGap: 0.015,
    arbExploreRate: 0.08,
    arbOnlyUntilEdge: false,
    forceArbOnly: false,
    requireEdgeForLive: true,
    edgeLookback: 100,
    edgeMinTrades: 40,
    edgeMinExpectancy: 0,
    holdToSettleUnderdogs: false,
    underdogMaxPrice: 0.42,
    holdToSettleDisasterSlPct: 42,
    allowScaleIn: false,
  };
}

export function defaultLiveStrategy() {
  return {
    ...defaultPaperStrategy(),
    maxPositionSize: 1.0,
    maxPositionPct: 0.05,
    maxPositionCap: 1.0,
    maxOpenPositions: 1,
    minConfidence: 0.50,
    kellyFraction: 0.05,
    certaintyMaxPct: 0.05,
    certaintyMaxUsd: 2.0,
    arbBankrollFrac: 0.03,
    arbMaxUsd: 1,
    autoApprovePaper: false,
    autoApproveLive: true,
    slPct: 8,
    adaptiveSl: true,
    minAdaptiveSlPct: 6,
    slMaxSlippagePct: 1,
    // Live stays locked until paper edge proves out
    arbOnlyUntilEdge: true,
    forceArbOnly: false,
    requireEdgeForLive: true,
    announceBeforeTrade: true,
    minTpUsd: 3,
    minPrice: 0.35,
    maxPrice: 0.65,
    requireTightSpread: true,
    useAggressiveScaling: false,
    maxOpenDrawdownPct: 0.05,
  };
}

function pickStrategy(src = {}) {
  const out = {};
  for (const k of STRATEGY_KEYS) {
    if (src[k] !== undefined) out[k] = src[k];
  }
  return out;
}

function pickShared(src = {}) {
  const out = {};
  for (const k of SHARED_KEYS) {
    if (src[k] !== undefined) out[k] = src[k];
  }
  return out;
}

function normalizeSizing(strategy = {}) {
  const next = { ...strategy };
  const minRaw = Number(next.minPositionSize);
  const maxRaw = Number(next.maxPositionSize);
  const hasMin = Number.isFinite(minRaw) && minRaw > 0;
  const hasMax = Number.isFinite(maxRaw) && maxRaw > 0;

  if (hasMin) next.minPositionSize = minRaw;
  if (hasMax) next.maxPositionSize = maxRaw;

  if (hasMin && hasMax && next.maxPositionSize < next.minPositionSize) {
    next.maxPositionSize = next.minPositionSize;
  }
  return next;
}

/**
 * Migrate legacy flat config → dual-profile shape.
 * Flat strategy keys become both paper + live seeds (then live overrides applied).
 */
export function normalizeConfigStore(raw, defaultsFlat = {}) {
  const base = { ...defaultsFlat, ...(raw || {}) };
  const hasProfiles = raw?.profiles && (raw.profiles.paper || raw.profiles.live);

  const paper = {
    ...defaultPaperStrategy(),
    ...pickStrategy(defaultsFlat),
    ...(hasProfiles ? pickStrategy(raw.profiles.paper || {}) : pickStrategy(base)),
  };
  const live = {
    ...defaultLiveStrategy(),
    ...pickStrategy(defaultsFlat),
    ...(hasProfiles ? pickStrategy(raw.profiles.live || {}) : pickStrategy(base)),
    // Always keep live gate strict even if migrating from flat paper-ish config
    arbOnlyUntilEdge: hasProfiles
      ? (raw.profiles.live?.arbOnlyUntilEdge !== false)
      : true,
    requireEdgeForLive: true,
  };

  return {
    mode: base.mode === 'live' ? 'live' : 'paper',
    enabled: !!base.enabled,
    paperBankroll: Number(base.paperBankroll ?? base.paperInitialDeposit ?? 100),
    paperInitialDeposit: Number(base.paperInitialDeposit ?? 100),
    profiles: { paper, live },
  };
}

/** Flat runtime config the bot scan loop expects */
export function resolveActiveConfig(store) {
  const mode = store?.mode === 'live' ? 'live' : 'paper';
  const strat = store?.profiles?.[mode] || (mode === 'live' ? defaultLiveStrategy() : defaultPaperStrategy());
  return {
    ...strat,
    mode,
    enabled: !!store?.enabled,
    paperBankroll: Number(store?.paperBankroll ?? store?.paperInitialDeposit ?? 100),
    paperInitialDeposit: Number(store?.paperInitialDeposit ?? 100),
  };
}

/**
 * Apply a patch. Strategy keys go into the active (or explicit) profile.
 * Shared keys update the store root.
 */
export function applyConfigPatch(store, patch = {}, opts = {}) {
  const next = {
    mode: store.mode === 'live' ? 'live' : 'paper',
    enabled: !!store.enabled,
    paperBankroll: store.paperBankroll,
    paperInitialDeposit: store.paperInitialDeposit,
    profiles: {
      paper: { ...(store.profiles?.paper || defaultPaperStrategy()) },
      live: { ...(store.profiles?.live || defaultLiveStrategy()) },
    },
  };

  const explicitPatchMode = patch.mode === 'live' || patch.mode === 'paper' ? patch.mode : null;
  const targetMode = opts.targetMode || explicitPatchMode || next.mode;

  for (const [k, v] of Object.entries(patch || {})) {
    if (k === 'profiles') continue;
    if (SHARED_KEYS.has(k)) {
      next[k] = v;
      continue;
    }
    if (STRATEGY_KEYS.includes(k)) {
      const m = targetMode || next.mode;
      next.profiles[m][k] = v;
      continue;
    }
    // Unknown keys: stash on active profile so we don't lose LLM knobs
    const m = targetMode || next.mode;
    next.profiles[m][k] = v;
  }

  if (patch.mode === 'live' || patch.mode === 'paper') {
    next.mode = patch.mode;
  }
  if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;

  next.profiles.paper = normalizeSizing(next.profiles.paper);
  next.profiles.live = normalizeSizing(next.profiles.live);

  return next;
}

export function profilesSummary(store) {
  return {
    mode: store?.mode || 'paper',
    paper: pickStrategy(store?.profiles?.paper || {}),
    live: pickStrategy(store?.profiles?.live || {}),
  };
}
