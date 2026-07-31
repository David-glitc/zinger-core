// @ts-nocheck
// Kelly Criterion position sizing with dynamic TP/SL, trailing stops, partial profits

const MAX_KELLY = 0.5;
const MIN_KELLY_FRAC = 0.01;

let tradeHistory = [];

export function setKellyTradeHistory(trades) {
  tradeHistory = trades;
}

export function getKellyStats() {
  const wins = tradeHistory.filter((x) => (x.pnl || 0) > 0);
  const losses = tradeHistory.filter((x) => (x.pnl || 0) <= 0);
  const total = tradeHistory.length;
  if (total < 5) return null;

  const winRate = wins.length / total;
  const avgWin = wins.length > 0 ? wins.reduce((s, x) => s + (x.pnl || 0), 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, x) => s + (x.pnl || 0), 0) / losses.length) : 0;
  const ratio = avgLoss > 0 ? avgWin / avgLoss : 0;
  const kelly = ratio > 0 ? (winRate * ratio - (1 - winRate)) / ratio : 0;
  const edge = winRate * avgWin - (1 - winRate) * avgLoss;

  return {
    winRate: Math.round(winRate * 1000) / 10,
    avgWin: Math.round(avgWin * 100) / 100,
    avgLoss: Math.round(avgLoss * 100) / 100,
    ratio: Math.round(ratio * 10) / 10,
    kelly: Math.round(kelly * 1000) / 1000,
    edge: Math.round(edge * 100) / 100,
    totalTrades: total,
  };
}

export function computeKellySize({
  bankroll,
  price,
  signalConfidence,
  historicalWinRate,
  tradeCount,
  minUsd = 0.4,
  maxUsd,
  kellyFraction = 0.25,
  maxPositionPct = 0.4,
}) {
  const stats = getKellyStats();

  if (!stats || tradeCount < 10) {
    const cappedConf = Math.min(0.65, Number(signalConfidence || 0));
    const size = minUsd + (maxUsd - minUsd) * (0.15 + cappedConf * 0.25);
    return {
      sizeUsd: Math.round(Math.max(minUsd, Math.min(size, maxUsd)) * 100) / 100,
      kellyFraction: 0,
      kellyRaw: 0,
      method: 'confidence_scaling',
      ...(stats || { winRate: 0, totalTrades: tradeCount }),
    };
  }

  // Negative edge → size 0 (do not floor into forced min bets)
  if (!(stats.kelly > 0) || !(stats.edge > 0)) {
    return {
      sizeUsd: 0,
      kellyFraction: 0,
      kellyRaw: stats.kelly,
      method: 'negative_kelly',
      ...stats,
    };
  }

  const betPct = Math.max(MIN_KELLY_FRAC, Math.min(stats.kelly * kellyFraction, MAX_KELLY));
  const sizedByBankroll = bankroll * betPct;
  const cappedConf = Math.min(0.65, Number(signalConfidence || 0));
  const sizedBySignal = sizedByBankroll * (0.35 + cappedConf * 0.5);
  const finalSize = Math.max(minUsd, Math.min(sizedBySignal, maxUsd, bankroll * maxPositionPct));

  return {
    sizeUsd: Math.round(finalSize * 100) / 100,
    kellyFraction: Math.round(betPct * 10000) / 100,
    kellyRaw: stats.kelly,
    method: 'kelly',
    ...stats,
  };
}

/**
 * Certainty-aware Kelly for near-guaranteed favorites.
 *
 * These are short (5–15 min) BTC/ETH up-or-down windows. A favored outcome
 * (ask price > 0.5) becomes progressively locked in as the window nears
 * settlement — there is simply less time left for the underlying to flip the
 * result. That falling variance is real edge that flat historical Kelly ignores,
 * which is why a "10% away, 20 seconds left" entry gets under-sized today.
 *
 *   q  = estimated settlement win-prob. Start from the market-implied prob
 *        (≈ the ask price) and lift it toward 1.0 in proportion to (a) how close
 *        we are to settle and (b) signal confidence. Bounded by remaining
 *        upside (1 - price) so it can never exceed a sane ceiling.
 *   f* = (q - price) / (1 - price)  — full Kelly fraction for a $1-payout bet.
 *
 * Returns null for underdogs (price ≤ 0.5), no time left, or no positive edge —
 * callers then fall back to normal Kelly so we never over-bet a coin-flip.
 */
export function computeCertaintyKelly({
  price,
  confidence,
  remaining,
  windowSec = 300,
  bankroll,
  kellyFraction = 0.5,
  minUsd = 0.4,
  maxUsd,
  maxPct = 0.35,
}) {
  const entry = Number(price);
  const rem = Number(remaining);
  const bank = Number(bankroll);
  if (!(entry > 0.5) || !(entry < 0.985) || !(bank > 0) || !(rem > 0)) return null;

  const frac = Math.max(0, Math.min(1, rem / Math.max(1, Number(windowSec) || 300)));
  // Front-loaded: certainty ramps up sharply in the final stretch of the window.
  const settleWeight = Math.pow(1 - frac, 0.7);
  const conf = Math.max(0.3, Math.min(0.97, Number(confidence ?? 0.55)));
  const q = Math.min(0.985, entry + settleWeight * conf * (1 - entry));
  const edge = q - entry;
  if (!(edge > 0)) return null;

  const kellyRaw = edge / (1 - entry);
  const betPct = Math.max(0, Math.min(Number(maxPct) || 0.35, kellyRaw * kellyFraction));
  const capUsd = Math.max(minUsd, Math.min(maxUsd ?? bank * betPct, bank * (Number(maxPct) || 0.35)));
  const sizeUsd = Math.round(Math.max(0, Math.min(bank * betPct, capUsd)) * 100) / 100;
  if (!(sizeUsd > 0)) return null;

  return {
    sizeUsd,
    kellyRaw: Math.round(kellyRaw * 1000) / 1000,
    betPct: Math.round(betPct * 10000) / 100,
    q: Math.round(q * 1000) / 1000,
    edge: Math.round(edge * 1000) / 1000,
    settleWeight: Math.round(settleWeight * 100) / 100,
    remaining: rem,
    method: 'certainty_kelly',
  };
}

export function resolveDynamicLimits(cfg, bankroll) {
  const min = Math.max(Number(cfg.minPositionSize ?? 0.4), 0.1);
  const maxPct = Number(cfg.maxPositionPct ?? 0.4);
  const cap = Number(cfg.maxPositionCap ?? 50);
  const maxByBankroll = bankroll * maxPct;
  const maxUsd = Math.min(maxByBankroll, cap, Number(cfg.maxPositionSize ?? cap));
  const minUsd = Math.min(min, maxUsd);
  return { minUsd, maxUsd, spendable: bankroll };
}

export function buildDynamicPlan({ cfg, price, analysis, signal }) {
  const vol = analysis?.volatility?.atrPct || 0.2;
  const volFactor = Math.max(0.5, Math.min(vol / 0.2, 2.2));
  const trendStrength = analysis?.adx?.adx || 25;
  const conf = Math.max(0, Math.min(0.65, Number(signal?.confidence ?? 0.45)));
  const entry = Number(price || 0);

  // Cheap underdogs / high-confidence favorites: hold to settlement (skip mid-cycle TP/SL grind)
  const underdogMax = Number(cfg.underdogMaxPrice ?? 0.42);
  const favoriteMin = Number(cfg.favoriteMinPrice ?? 0.55);
  const favoriteMax = Number(cfg.favoriteMaxPrice ?? 0.85);
  const holdUnderdog = cfg.holdToSettleUnderdogs !== false && entry > 0 && entry <= underdogMax;
  const holdFavorite = cfg.holdToSettleFavorites === true
    && entry >= favoriteMin
    && entry <= favoriteMax
    && conf >= Number(cfg.minConfidence ?? 0.5);
  const holdToSettle = holdUnderdog || holdFavorite;

  if (holdToSettle) {
    const disasterSl = Number(cfg.holdToSettleDisasterSlPct ?? 42);
    return {
      tpPct: Math.round(((0.99 / Math.max(0.01, entry)) - 1) * 1000) / 10, // near settle $1
      slPct: disasterSl,
      trailActivatePct: 999,
      trailDistancePct: 99,
      partialTpPct: 999,
      partialPct: 0,
      volFactor: Math.round(volFactor * 10) / 10,
      confidence: Math.round(conf * 1000) / 1000,
      confTpMul: 1,
      confSlMul: 1,
      method: holdFavorite ? 'hold_to_settle_favorite' : 'hold_to_settle',
      holdToSettle: true,
      adaptiveSlEnabled: false,
      minAdaptiveSlPct: disasterSl,
    };
  }

  // Reshaped: wider TP band, late/small partials, trail only after most of TP.
  const baseTpLow = Number(cfg.tpPctLow ?? 18);
  const baseTpHigh = Number(cfg.tpPctHigh ?? 36);
  const baseSl = Number(cfg.slPct ?? 12);

  const confTp = baseTpLow + conf * (baseTpHigh - baseTpLow);
  const scaledTp = confTp * (1 + (volFactor - 1) * 0.15);
  const dynamicTp = Math.round(Math.max(baseTpLow * 0.9, Math.min(scaledTp, baseTpHigh * 1.1)) * 10) / 10;

  // When adaptive SL is off, honour configured slPct exactly (no silent widening/narrowing).
  const minFloor = Number(cfg.minAdaptiveSlPct ?? 8);
  let dynamicSl = baseSl;
  let confSlMul = 1;
  if (cfg.adaptiveSl !== false) {
    // Wider SL; high conf only mildly tightens (never back to 5% scalp stops)
    confSlMul = 1.05 - conf * 0.2;
    const trendNarrowing = trendStrength > 35 ? 0.92 : 1;
    const scaledSl = baseSl * confSlMul * Math.min(volFactor, 1.35) * trendNarrowing;
    dynamicSl = Math.round(Math.max(minFloor, Math.min(scaledSl, Math.max(baseSl * 1.25, minFloor + 3))) * 10) / 10;
  } else {
    dynamicSl = Math.round(Math.max(minFloor, baseSl) * 10) / 10;
  }

  const trailActivatePct = Math.round(dynamicTp * (Number(cfg.trailActivateFrac ?? 0.72)) * 10) / 10;
  const trailDistance = Math.min(Math.max(vol * 2.5, 4), Number(cfg.trailDistanceCap ?? 12));

  const partialFrac = Number(cfg.partialTpFrac ?? 0.78);
  const confPartialFrac = partialFrac + (conf - 0.5) * 0.05;
  const partialTpPct = Math.round(dynamicTp * Math.min(0.95, Math.max(0.7, confPartialFrac)) * 10) / 10;
  const partialPct = Number(cfg.partialSellPct ?? (conf >= 0.55 ? 0.22 : 0.28));

  return {
    tpPct: dynamicTp,
    slPct: dynamicSl,
    trailActivatePct,
    trailDistancePct: Math.round(trailDistance * 10) / 10,
    partialTpPct,
    partialPct,
    volFactor: Math.round(volFactor * 10) / 10,
    confidence: Math.round(conf * 1000) / 1000,
    confTpMul: Math.round((confTp / Math.max(1, baseTpLow)) * 100) / 100,
    confSlMul: Math.round(confSlMul * 100) / 100,
    method: 'confidence_tp_sl',
    holdToSettle: false,
    adaptiveSlEnabled: cfg.adaptiveSl !== false,
    minAdaptiveSlPct: minFloor,
  };
}

export function checkTrailingStop(pos, currentPrice) {
  if (!pos.highestPrice || currentPrice > pos.highestPrice) {
    pos.highestPrice = currentPrice;
  }
  const trailPct = pos.trailDistancePct || 10;
  const activatePct = pos.trailActivatePct || 50;
  const gainPct = ((pos.highestPrice - pos.entryPrice) / pos.entryPrice) * 100;

  if (gainPct < activatePct) return null;

  const retracePct = ((pos.highestPrice - currentPrice) / pos.highestPrice) * 100;
  if (retracePct >= trailPct) return 'trail';

  return null;
}

export function checkPartialProfit(pos, currentPrice) {
  if (pos.partialSold) return null;
  // Skip partials when adaptive loss defense is active
  if (pos.adaptiveSlArmed) return null;
  const gainPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
  if (gainPct >= (pos.partialTpPct || 999)) {
    return 'partial';
  }
  return null;
}

/**
 * Tighten stop when underwater + signal confidence fading.
 * Returns effective SL % (positive number) for gainPct <= -sl check.
 * Can cut all the way to ~5% when loss is growing and confidence is dropping.
 */
export function resolveAdaptiveSl(pos, { signal, cfg } = {}) {
  const base = Number(pos.slPct || cfg?.slPct || 10);
  if (cfg?.adaptiveSl === false || pos.adaptiveSlEnabled === false) return base;

  const minSl = Number(pos.minAdaptiveSlPct ?? cfg?.minAdaptiveSlPct ?? 5);
  const gainPct = Number(pos.gainPct || 0);
  const confNow = Number(signal?.confidence ?? pos.lastSignalConfidence ?? pos.signal?.confidence ?? 0.5);
  const confEntry = Number(pos.signal?.confidence ?? confNow);
  const confDrop = confEntry - confNow;
  const flipped = Boolean(
    signal?.direction
    && pos.outcome
    && signal.direction !== 'neutral'
    && signal.direction !== pos.outcome
  );
  pos.lastSignalConfidence = confNow;

  // Hard cut: underwater + confidence collapsing / flip → floor SL (default 4%)
  if (gainPct <= -1.2 && (confDrop >= 0.1 || flipped || confNow < 0.22)) {
    pos.adaptiveSlArmed = true;
    pos.effectiveSlPct = minSl;
    return minSl;
  }

  // Loss deepening + confidence drop → cut faster
  if (gainPct < -1.8 && (confDrop >= 0.06 || flipped)) {
    pos.adaptiveSlArmed = true;
    const tightened = Math.max(minSl, base * 0.5);
    pos.effectiveSlPct = Math.round(tightened * 10) / 10;
    return pos.effectiveSlPct;
  }

  // Still losing and getting worse vs last mark
  if (gainPct < -2.5 && pos._prevGainPct != null && gainPct < pos._prevGainPct - 0.6) {
    pos.adaptiveSlArmed = true;
    pos.effectiveSlPct = Math.max(minSl, Math.min(base, 5));
    return pos.effectiveSlPct;
  }

  // Already armed: keep floor tight while still red
  if (pos.adaptiveSlArmed && gainPct < 0) {
    pos.effectiveSlPct = Math.max(minSl, Math.min(base, pos.effectiveSlPct || minSl));
    pos._prevGainPct = gainPct;
    return pos.effectiveSlPct;
  }

  pos._prevGainPct = gainPct;
  pos.effectiveSlPct = base;
  return base;
}
