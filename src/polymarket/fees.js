/**
 * Polymarket CLOB taker fees — same math the order client uses.
 *
 * Platform fee (clob-client-v2 adjustBuyAmountForFees):
 *   platformFee = shares × rate × (p × (1 − p))^exponent
 * where rate/exponent come from GET /clob-markets/{conditionId} → fd.r / fd.e.
 *
 * Order signing uses GET /fee-rate?token_id=… → base_fee (bps), separate from USDC fee.
 *
 * Paper assumes aggressive (taker) fills. Settlement / redemption is NOT a CLOB sell.
 */

const CLOB_HOST = String(process.env.CLOB_API_URL || process.env.CLOB_HOST || 'https://clob.polymarket.com').replace(/\/$/, '');

/** Category fallbacks when token fee params are unavailable (docs schedule). */
export const FEE_RATES = Object.freeze({
  crypto: 0.07,
  sports: 0.05,
  finance: 0.04,
  politics: 0.04,
  economics: 0.05,
  culture: 0.05,
  weather: 0.05,
  other: 0.05,
  mentions: 0.04,
  tech: 0.04,
  geopolitics: 0,
});

/** Exits that resolve via redeem / window end — not a taker CLOB sell. */
export const FEE_FREE_EXIT_REASONS = Object.freeze(new Set([
  'settle',
  'window_close',
  'redeem',
  'resolution',
  'orphan_settle',
]));

const feeCache = new Map(); // tokenId -> { rate, exponent, feeRateBps, takerOnly, at }
const FEE_CACHE_TTL_MS = 10 * 60 * 1000;

/** Round to 5 decimal places (protocol precision). */
export function roundFeeUsdc(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const rounded = Math.round(n * 1e5) / 1e5;
  return rounded < 0.00001 ? 0 : rounded;
}

function categoryParams(categoryOrRate = 'crypto') {
  if (categoryOrRate && typeof categoryOrRate === 'object') {
    const rate = Number(categoryOrRate.rate ?? categoryOrRate.r ?? 0);
    const exponent = Number(categoryOrRate.exponent ?? categoryOrRate.e ?? 1);
    return {
      rate: Number.isFinite(rate) ? rate : 0,
      exponent: Number.isFinite(exponent) ? exponent : 1,
      feeRateBps: Number(categoryOrRate.feeRateBps ?? categoryOrRate.base_fee ?? 0) || 0,
      takerOnly: categoryOrRate.takerOnly !== false && categoryOrRate.to !== false,
      source: categoryOrRate.source || 'inline',
    };
  }
  if (typeof categoryOrRate === 'number') {
    return { rate: categoryOrRate, exponent: 1, feeRateBps: 0, takerOnly: true, source: 'rate' };
  }
  const key = String(categoryOrRate || 'crypto');
  return {
    rate: FEE_RATES[key] ?? FEE_RATES.crypto,
    exponent: 1,
    feeRateBps: 0,
    takerOnly: true,
    source: `category:${key}`,
  };
}

/**
 * Taker USDC fee for C shares at price p.
 * Matches @polymarket/clob-client-v2: shares * rate * (p*(1-p))^exponent
 */
export function takerFeeUsdc(shares, price, categoryOrRate = 'crypto') {
  const C = Number(shares);
  const p = Number(price);
  if (!(C > 0) || !(p > 0) || !(p < 1)) return 0;
  const { rate, exponent } = categoryParams(categoryOrRate);
  if (!(rate > 0)) return 0;
  const curve = (p * (1 - p)) ** Math.max(0, exponent);
  return roundFeeUsdc(C * rate * curve);
}

async function clobGet(path) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(`${CLOB_HOST}${path}`, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`clob ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/**
 * Resolve live CLOB fee params for a token (same path order-builder uses).
 * @returns {Promise<{rate:number,exponent:number,feeRateBps:number,takerOnly:boolean,source:string}>}
 */
export async function resolveClobFeeParams(tokenId, fallbackCategory = 'crypto') {
  const id = String(tokenId || '').trim();
  const fallback = categoryParams(fallbackCategory);
  if (!id) return fallback;

  const hit = feeCache.get(id);
  if (hit && (Date.now() - hit.at) < FEE_CACHE_TTL_MS) {
    return hit;
  }

  try {
    const byToken = await clobGet(`/markets-by-token/${encodeURIComponent(id)}`);
    const conditionId = byToken?.condition_id || byToken?.conditionId;
    if (!conditionId) throw new Error('no condition_id');

    const [market, feeRate] = await Promise.all([
      clobGet(`/clob-markets/${encodeURIComponent(conditionId)}`),
      clobGet(`/fee-rate?token_id=${encodeURIComponent(id)}`).catch(() => null),
    ]);

    const fd = market?.fd || {};
    const rate = Number(fd.r);
    const exponent = Number(fd.e);
    const params = {
      rate: Number.isFinite(rate) ? rate : fallback.rate,
      exponent: Number.isFinite(exponent) ? exponent : 1,
      feeRateBps: Number(feeRate?.base_fee ?? market?.tbf ?? 0) || 0,
      takerOnly: fd.to !== false,
      source: 'clob-markets',
      conditionId,
      at: Date.now(),
    };
    feeCache.set(id, params);
    return params;
  } catch {
    const miss = { ...fallback, at: Date.now(), source: `${fallback.source}:fallback` };
    feeCache.set(id, miss);
    return miss;
  }
}

/** Async fee using live CLOB market schedule when tokenId is known. */
export async function takerFeeUsdcForToken(shares, price, tokenId, fallbackCategory = 'crypto') {
  const params = await resolveClobFeeParams(tokenId, fallbackCategory);
  return takerFeeUsdc(shares, price, params);
}

/** Effective cost to open a long (premium + taker fee). */
export function openCostWithFee(shares, price, category = 'crypto') {
  const premium = Math.round(shares * price * 100) / 100;
  const fee = takerFeeUsdc(shares, price, category);
  return { premium, fee, total: Math.round((premium + fee) * 100) / 100 };
}

export async function openCostWithFeeForToken(shares, price, tokenId, fallbackCategory = 'crypto') {
  const premium = Math.round(shares * price * 100) / 100;
  const fee = await takerFeeUsdcForToken(shares, price, tokenId, fallbackCategory);
  return { premium, fee, total: Math.round((premium + fee) * 100) / 100 };
}

/**
 * Net proceeds after selling shares on the CLOB (premium − taker fee).
 * Pass exitReason so settle/redeem skips the exit fee.
 */
export function closeProceedsWithFee(shares, price, category = 'crypto', exitReason = 'clob_sell') {
  const premium = Math.round(shares * price * 100) / 100;
  const fee = isFeeFreeExit(exitReason) ? 0 : takerFeeUsdc(shares, price, category);
  return { premium, fee, net: Math.round((premium - fee) * 100) / 100 };
}

export async function closeProceedsWithFeeForToken(shares, price, tokenId, exitReason = 'clob_sell', fallbackCategory = 'crypto') {
  const premium = Math.round(shares * price * 100) / 100;
  const fee = isFeeFreeExit(exitReason)
    ? 0
    : await takerFeeUsdcForToken(shares, price, tokenId, fallbackCategory);
  return { premium, fee, net: Math.round((premium - fee) * 100) / 100 };
}

export function isFeeFreeExit(exitReason) {
  const reason = String(exitReason || '').toLowerCase().trim();
  if (!reason) return false;
  if (FEE_FREE_EXIT_REASONS.has(reason)) return true;
  if (reason.includes('settle') || reason.includes('redeem')) return true;
  return false;
}

/** Expected round-trip fee if entry is taker and exit is a mid-window CLOB sell. */
export function expectedRoundTripFeeUsdc(shares, entryPrice, exitPrice, category = 'crypto') {
  return Math.round(
    (takerFeeUsdc(shares, entryPrice, category) + takerFeeUsdc(shares, exitPrice, category)) * 1e5,
  ) / 1e5;
}

export function clearFeeCache() {
  feeCache.clear();
}
