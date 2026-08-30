// @ts-nocheck
/**
 * Alpha fusion engine — combines multiple independent alpha modalities into a
 * single calibrated signal for the 5m–1h BTC/ETH up/down windows.
 *
 * Modalities fused (each emits a z-scored vote in [-1, 1]):
 *   1. TA_MEANREV   — RSI/Bollinger pullback (fades extremes)
 *   2. TA_MOMENTUM  — short-window momentum + MACD + volume surge
 *   3. ORDER_FLOW   — CLOB book imbalance + spread quality (microstructure)
 *   4. CROSS_ASSET  — BTC→ETH lead (leader spills into laggard)
 *   5. POSITIONING  — funding rate + mark premium (crowding)
 *   6. REGIME       — jump-model high-vol guardrail (down-weights all else)
 *   7. VOL_TILT     — low-vol anomaly: shrink confidence in high idio-vol
 *
 * Fusion: convex blend with regime-dependent weights, then a final squashing
 * to a confidence in [0,1] and a direction sign. Each vote is attributable
 * (`alpha.components`) so operators can see *why* a signal fired.
 */

const REGIME_WEIGHTS = {
  trend: { TA_MEANREV: 0.15, TA_MOMENTUM: 0.45, ORDER_FLOW: 0.25, CROSS_ASSET: 0.2, POSITIONING: 0.15 },
  highvol: { TA_MEANREV: 0.3, TA_MOMENTUM: 0.1, ORDER_FLOW: 0.2, CROSS_ASSET: 0.1, POSITIONING: 0.2 },
  chop: { TA_MEANREV: 0.4, TA_MOMENTUM: 0.2, ORDER_FLOW: 0.3, CROSS_ASSET: 0.15, POSITIONING: 0.1 },
};

function clamp01(n) { return Math.max(0, Math.min(1, Number(n) || 0)); }
function clamp11(n) { return Math.max(-1, Math.min(1, Number(n) || 0)); }
function round(n, d = 4) { const m = 10 ** d; return Math.round(Number(n || 0) * m) / m; }

/** z-score a raw value vs its recent range (rolling min-max). */
function normRange(v, lo, hi) {
  if (!(hi > lo)) return 0;
  return clamp11((v - lo) / (hi - lo) * 2 - 1);
}

/**
 * @param {object} opts
 * @param {object} opts.analysis   base TA from signal.js `analyze()`
 * @param {object} [opts.book]     depth for this outcome side {bestBid,bestAsk,spreadPct,imbalance}
 * @param {object} [opts.funding]  {fundingRate, premium}
 * @param {number} [opts.leadMom1] BTC 1m momentum feeding ETH vote
 * @param {string} [opts.regime]   'trend' | 'highvol' | 'chop'
 * @param {object} [opts.regimeSignal] jump-model output {realizedVol, calmBaseline, highVol}
 * @param {number} [opts.isEth]    cross-asset lead is present
 */
export function fuseAlpha({
  analysis = null,
  book = null,
  funding = null,
  leadMom1 = null,
  regime = 'chop',
  regimeSignal = null,
  isEth = false,
} = {}) {
  if (!analysis) return null;

  const c = [];
  const push = (id, vote, weight, note) => {
    if (!Number.isFinite(vote) || Math.abs(vote) < 1e-9) return;
    c.push({ id, vote: round(clamp11(vote)), weight: round(weight), note: note || '' });
  };

  // ── 1. TA mean-reversion ──────────────────────────────────────────
  const rsi = Number(analysis.rsi ?? 50);
  const bbPos = Number(analysis.bb?.pos ?? analysis.bbPosition ?? 0.5);
  const meanRev = normRange(50 - rsi, -30, 30);       // rsi 20→+1, 80→-1
  const bbVote = clamp11((0.5 - bbPos) * 2);          // low band→+1 (mean-revert up)
  push('TA_MEANREV', 0.6 * meanRev + 0.4 * bbVote, 1, `rsi=${rsi} bb=${round(bbPos, 3)}`);

  // ── 2. TA momentum ───────────────────────────────────────────────
  const m1 = Number(analysis.momentum?.m1 ?? 0);
  const m5 = Number(analysis.momentum?.m5 ?? 0);
  const macdH = Number(analysis.macd?.hist ?? 0);
  const volRatio = Number(analysis.volume?.ratio ?? 1);
  const momVote = clamp11(m1 * 8 + m5 * 3 + macdH * 40);
  push('TA_MOMENTUM', momVote, 1, `m1=${round(m1)} m5=${round(m5)} macd=${round(macdH)}`);

  // ── 3. Order flow ────────────────────────────────────────────────
  if (book) {
    const imb = clamp11(Number(book.imbalance ?? 0));
    const spreadPct = Number(book.spreadPct ?? 0);
    const spreadScore = spreadPct > 0 && spreadPct < 0.8 ? 0.5 : spreadPct > 2 ? -0.6 : 0;
    push('ORDER_FLOW', 0.8 * imb + 0.2 * spreadScore, 1,
      `imb=${round(imb)} spread=${round(spreadPct, 2)}%`);
  }

  // ── 4. Cross-asset lead (BTC → ETH) ─────────────────────────────
  if (isEth && leadMom1 != null && Number.isFinite(leadMom1)) {
    push('CROSS_ASSET', clamp11(Number(leadMom1) * 30), 1, `btc_m1=${round(leadMom1)}`);
  }

  // ── 5. Positioning (crowding) ────────────────────────────────────
  if (funding) {
    const fr = Number(funding.fundingRate ?? 0);
    const prem = Number(funding.premium ?? 0);
    // Positive funding = long crowd → fade longs (negative vote for up)
    const crowd = clamp11(-fr * 1200 - prem * 500);
    push('POSITIONING', crowd, 1, `funding=${round(fr, 6)} premium=${round(prem, 6)}`);
  }

  // ── 6. Regime guardrail (jump model) ────────────────────────────
  let regimePenalty = 0;
  if (regimeSignal?.highVol || regime === 'highvol') {
    regimePenalty = -0.5;
    push('REGIME', -1, 0.8, 'high-vol — de-risk directional');
  } else if (regime === 'trend') {
    push('REGIME', 0.4, 0.6, 'trend regime — ride');
  }

  // ── 7. Vol tilt (low-vol anomaly) ────────────────────────────────
  let volScale = 1;
  if (regimeSignal?.realizedVol > 0 && regimeSignal?.calmBaseline > 0) {
    const ratio = regimeSignal.realizedVol / regimeSignal.calmBaseline;
    volScale = clamp01(Math.exp(-(ratio - 1) / 2));
    if (ratio > 1.5) push('VOL_TILT', clamp11((1 - ratio) * 0.6), 0.7,
      `rv/base=${round(ratio, 2)} — vol anomaly says de-risk`);
  }

  // ── Fuse with regime weights ────────────────────────────────────
  const w = REGIME_WEIGHTS[regime] || REGIME_WEIGHTS.chop;
  const weights = { TA_MEANREV: w.TA_MEANREV, TA_MOMENTUM: w.TA_MOMENTUM, ORDER_FLOW: w.ORDER_FLOW, CROSS_ASSET: w.CROSS_ASSET, POSITIONING: w.POSITIONING };
  let fused = 0, wsum = 0;
  for (const comp of c) {
    const wgt = comp.id === 'REGIME' || comp.id === 'VOL_TILT'
      ? comp.weight
      : (weights[comp.id] ?? 0.2);
    fused += comp.vote * wgt;
    wsum += wgt;
  }
  fused = wsum > 0 ? fused / wsum : 0;
  fused += regimePenalty * 0.3;
  fused = clamp11(fused);

  // Confidence: magnitude after squash + a floor from base TA
  const baseConf = Number(analysis.confidence ?? 0.4);
  const mag = Math.abs(fused);
  const confidence = round(clamp01(0.5 + mag * 0.5) * 0.6 + baseConf * 0.4 * volScale, 3);

  const direction = fused > 0.12 ? 'up' : fused < -0.12 ? 'down' : 'neutral';
  const score = round(fused * 10, 1);
  const edge = round(direction === 'neutral' ? 0 : Math.sign(fused) * confidence, 3);

  return {
    alpha: round(fused, 3),
    direction,
    score,
    edge,
    confidence,
    regime,
    regimePenalty: round(regimePenalty, 3),
    volScale: round(volScale, 3),
    components: c,
    baseScore: analysis.score,
    timestamp: Date.now(),
  };
}

/**
 * Convenience: decorate a base TA `analysis` with the fused alpha so the rest
 * of the pipeline (edge gate, governor, kelly) sees the richer signal.
 * Returns a shallow copy with .alphaFusion attached.
 */
export function applyAlphaFusion(analysis, ctx = {}) {
  if (!analysis) return analysis;
  const fused = fuseAlpha({ analysis, ...ctx });
  return {
    ...analysis,
    alphaFusion: fused,
    direction: fused?.direction || analysis.direction,
    confidence: fused?.confidence != null && fused.confidence > 0
      ? fused.confidence
      : analysis.confidence,
    score: fused?.score ?? analysis.score,
    edge: fused?.edge ?? analysis.edge,
    signals: [...(analysis.signals || []), ...(fused?.components || []).map((x) => x.id)],
  };
}
