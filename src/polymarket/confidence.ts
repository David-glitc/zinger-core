// @ts-nocheck
const MAX_BUFFER_SIZE = 12;
const BUFFER_WINDOW_MS = 180000; // 3 min rolling window

const buffers = { btc: [], eth: [] };
const priceTraceBuffer = { btc: [], eth: [] };

function normalizeDirection(direction) {
  if (direction === 1 || direction === 'up') return 'up';
  if (direction === -1 || direction === 'down') return 'down';
  return 'neutral';
}

export function addMLPrediction(asset, prediction) {
  if (!prediction || prediction.error) return;
  const direction = normalizeDirection(prediction.direction);
  if (direction === 'neutral') return;
  const buf = buffers[asset];
  if (!buf) return;
  buf.push({
    direction,
    confidence: prediction.confidence || 0,
    expectedReturn: prediction.expected_return || prediction.expectedReturn || 0,
    timestamp: Date.now(),
  });
  if (buf.length > MAX_BUFFER_SIZE) buf.shift();
  pruneBuffer(asset);
}

export function addPriceTrace(asset, prices) {
  if (!prices || !Array.isArray(prices) || prices.length === 0) return;
  const buf = priceTraceBuffer[asset];
  if (!buf) return;
  buf.push({ prices, timestamp: Date.now() });
  if (buf.length > 5) buf.shift();
}

function pruneBuffer(asset) {
  const buf = buffers[asset];
  if (!buf) return;
  const cutoff = Date.now() - BUFFER_WINDOW_MS;
  while (buf.length > 0 && buf[0].timestamp < cutoff) buf.shift();
}

export function getConsensus(asset) {
  const buf = buffers[asset];
  if (!buf || buf.length === 0) return null;
  const up = buf.filter(p => p.direction === 'up').length;
  const down = buf.filter(p => p.direction === 'down').length;
  const total = up + down;
  if (total === 0) return null;
  const dominant = up > down ? 'up' : 'down';
  const dominance = Math.max(up, down) / total;
  const avgConfidence = buf.reduce((s, p) => s + p.confidence, 0) / buf.length;
  const avgExpectedReturn = buf.reduce((s, p) => s + p.expectedReturn, 0) / buf.length;
  const momentum = buf.length >= 3
    ? (buf[buf.length - 1].direction === dominant ? 1 : -1) * (dominance - 0.5) * 2
    : 0;
  return {
    direction: dominant,
    confidence: avgConfidence,
    dominance,
    totalPredictions: total,
    agreementPct: dominance * 100,
    expectedReturn: avgExpectedReturn,
    momentum,
    sampleCount: buf.length,
  };
}

export function getPriceTrace(asset) {
  const buf = priceTraceBuffer[asset];
  if (!buf || buf.length === 0) return null;
  const latest = buf[buf.length - 1];
  return {
    prices: latest.prices,
    timestamp: latest.timestamp,
    ageMs: Date.now() - latest.timestamp,
  };
}

/** Trace bias: short-horizon ladder (≈5–15m) agreeing with signal → boost */
function getTraceBias(asset, rawSignal) {
  const trace = getPriceTrace(asset);
  if (!trace?.prices?.length || !rawSignal?.direction) return { traceBoost: 0, traceAgree: null };
  const rawIsBull = rawSignal.direction === 'up';
  let agree = 0;
  let weight = 0;
  for (const point of trace.prices) {
    const dir = normalizeDirection(point.direction);
    if (dir === 'neutral') continue;
    const w = 1 / Math.max(1, (point.minutes || 5) / 5); // nearer horizons weigh more
    const match = (dir === 'up') === rawIsBull;
    agree += match ? w * (point.confidence || 0.5) : -w * (point.confidence || 0.5);
    weight += w;
  }
  if (weight === 0) return { traceBoost: 0, traceAgree: null };
  const score = agree / weight;
  return {
    traceBoost: Math.max(-0.2, Math.min(0.25, score * 0.35)),
    traceAgree: score > 0.05 ? true : score < -0.05 ? false : null,
    traceScore: score,
  };
}

export function getConfidenceBias(asset, rawSignal) {
  const consensus = getConsensus(asset);
  const { traceBoost, traceAgree, traceScore } = getTraceBias(asset, rawSignal);
  if (!consensus && !traceBoost) {
    return { bias: 0, adjusted: rawSignal?.confidence || 0 };
  }

  let confidenceBoost = 0;
  let momentumBoost = 0;
  let agree = null;
  if (consensus && rawSignal) {
    const rawIsBull = rawSignal.direction === 'up';
    const consensusIsBull = consensus.direction === 'up';
    agree = rawIsBull === consensusIsBull;
    const agreementStrength = agree ? consensus.agreementPct : -consensus.agreementPct;
    confidenceBoost = (agreementStrength / 100) * 0.3;
    momentumBoost = (consensus.momentum || 0) * 0.1;
  }

  const totalBias = confidenceBoost + momentumBoost + (traceBoost || 0);
  // Hard cap — inflated ML/consensus conf caused false certainty and bad TP/SL
  const CONF_CAP = 0.65;
  const adjusted = Math.max(0, Math.min(CONF_CAP, (rawSignal?.confidence || 0) + totalBias * 0.5));
  return {
    bias: totalBias,
    adjusted,
    confCap: CONF_CAP,
    consensus,
    agree,
    confidenceBoost,
    momentumBoost,
    traceBoost,
    traceAgree,
    traceScore,
  };
}

export function getConfidenceBufferStats() {
  const stats = {};
  for (const asset of ['btc', 'eth']) {
    const consensus = getConsensus(asset);
    const trace = getPriceTrace(asset);
    stats[asset] = {
      bufferSize: buffers[asset]?.length || 0,
      consensus,
      traceAvailable: !!trace,
      tracePoints: trace?.prices?.length || 0,
      traceAgeMs: trace ? Date.now() - trace.timestamp : null,
    };
  }
  return stats;
}
