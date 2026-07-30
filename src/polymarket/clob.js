import { POLY } from './config.js';
import { getClobWsMid, getClobWsBook } from './clobWs.js';

/**
 * CLOB **reads** go direct from the host (saves paid-proxy bandwidth).
 * CLOB **writes** use CLOB_PROXY_URL / write host via trade.js — do not route reads through paid proxy.
 */
async function clobGet(url, timeoutMs = 5000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  return res;
}

export async function getOrderBook(tokenId) {
  const url = `${POLY.clobApi}/book?token_id=${tokenId}`;
  const res = await clobGet(url, 5000);
  if (!res.ok) return null;
  return res.json();
}

export async function getPrice(tokenId) {
  const url = `${POLY.clobApi}/price?token_id=${tokenId}`;
  const res = await clobGet(url, 5000);
  if (!res.ok) return null;
  return res.json();
}

/** Polymarket CLOB often returns bids ascending / asks descending — always normalize. */
function normalizeLevels(book, levels = 10) {
  const bidsRaw = (book?.bids || [])
    .map((b) => ({ price: parseFloat(b.price), size: parseFloat(b.size) }))
    .filter((b) => Number.isFinite(b.price) && Number.isFinite(b.size) && b.size > 0)
    .sort((a, b) => b.price - a.price);
  const asksRaw = (book?.asks || [])
    .map((a) => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
    .filter((a) => Number.isFinite(a.price) && Number.isFinite(a.size) && a.size > 0)
    .sort((a, b) => a.price - b.price);

  const bids = bidsRaw.slice(0, levels).map((b) => ({
    ...b,
    value: b.price * b.size,
  }));
  const asks = asksRaw.slice(0, levels).map((a) => ({
    ...a,
    value: a.price * a.size,
  }));

  let cumBid = 0;
  let cumAsk = 0;
  for (const b of bids) {
    cumBid += b.size;
    b.cum = cumBid;
  }
  for (const a of asks) {
    cumAsk += a.size;
    a.cum = cumAsk;
  }

  const bestBid = bids[0]?.price || 0;
  const bestAsk = asks[0]?.price || 0;
  const spread = bestBid > 0 && bestAsk > 0 ? bestAsk - bestBid : null;
  const mid = bestBid > 0 && bestAsk > 0
    ? (bestBid + bestAsk) / 2
    : (bestBid || bestAsk || null);
  const spreadPct = mid > 0 && spread != null ? (spread / mid) * 100 : null;

  const totalBidVol = bids.reduce((s, b) => s + b.value, 0);
  const totalAskVol = asks.reduce((s, a) => s + a.value, 0);
  const imbalance = totalBidVol + totalAskVol > 0
    ? (totalBidVol - totalAskVol) / (totalBidVol + totalAskVol)
    : 0;

  return {
    bids,
    asks,
    bestBid,
    bestAsk,
    spread: spread ?? 0,
    spreadPct: spreadPct ?? 0,
    mid: mid ?? 0,
    totalBidVol,
    totalAskVol,
    imbalance,
    bidCount: bids.length,
    askCount: asks.length,
  };
}

export async function getMidPrice(tokenId) {
  const wsMid = getClobWsMid(tokenId);
  if (wsMid != null) return wsMid;

  const book = await getOrderBook(tokenId);
  if (!book) return null;
  const depth = normalizeLevels(book, 5);
  if (!depth.mid) return null;
  return depth.mid;
}

export async function getPricesForMarket(market) {
  const gamma = { ...(market.gammaPrices || {}) };
  const prices = { ...gamma };
  let clobLegs = 0;
  let wsLegs = 0;

  for (const [outcome, tokenId] of Object.entries(market.tokenIds || {})) {
    if (!tokenId) continue;
    try {
      const wsBook = getClobWsBook(tokenId);
      const wsMid = wsBook && !wsBook.stale
        ? (Number.isFinite(wsBook.mid) && wsBook.mid > 0 && wsBook.mid < 1
          ? wsBook.mid
          : (Number.isFinite(wsBook.lastTrade) && wsBook.lastTrade > 0 && wsBook.lastTrade < 1
            ? wsBook.lastTrade
            : null))
        : null;
      if (wsMid != null) {
        prices[outcome] = wsMid;
        prices[`${outcome}Bid`] = wsBook.bestBid;
        prices[`${outcome}Ask`] = wsBook.bestAsk;
        clobLegs += 1;
        wsLegs += 1;
        continue;
      }
      const mid = await getMidPrice(tokenId);
      if (mid != null && Number.isFinite(mid) && mid > 0 && mid < 1) {
        prices[outcome] = mid;
        clobLegs += 1;
      }
    } catch {
      // keep gamma fallback
    }
  }

  prices._source = wsLegs >= 2
    ? 'clob-ws'
    : clobLegs > 0
      ? (clobLegs >= 2 ? (wsLegs > 0 ? 'clob-mixed' : 'clob') : 'mixed')
      : 'gamma';
  prices._clobLegs = clobLegs;
  prices._wsLegs = wsLegs;
  return prices;
}

export async function getTrades(tokenId, limit = 20) {
  const url = `${POLY.clobApi}/trades?token_id=${tokenId}&limit=${limit}`;
  const res = await clobGet(url, 5000);
  if (!res.ok) return [];
  return res.json();
}

export async function getTokenPrices(tokenId) {
  const url = `${POLY.clobApi}/price?token_id=${tokenId}`;
  const res = await clobGet(url, 5000);
  if (!res.ok) return null;
  return res.json();
}

export async function getOrderBookDepth(tokenId, levels = 10) {
  const book = await getOrderBook(tokenId);
  if (!book) return null;
  return normalizeLevels(book, levels);
}

export async function getDepthForMarket(market) {
  const depth = {};
  for (const [outcome, tokenId] of Object.entries(market.tokenIds || {})) {
    if (!tokenId) continue;
    try {
      const wsBook = getClobWsBook(tokenId);
      if (wsBook && !wsBook.stale && (wsBook.bestBid || wsBook.bestAsk)) {
        depth[outcome] = {
          bestBid: wsBook.bestBid || 0,
          bestAsk: wsBook.bestAsk || 0,
          mid: wsBook.mid || 0,
          spread: (wsBook.bestBid && wsBook.bestAsk) ? wsBook.bestAsk - wsBook.bestBid : 0,
          source: 'clob-ws',
        };
        continue;
      }
      const d = await getOrderBookDepth(tokenId);
      if (d) depth[outcome] = d;
    } catch {}
  }
  return depth;
}
