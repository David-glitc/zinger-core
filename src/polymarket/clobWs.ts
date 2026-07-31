// @ts-nocheck
/**
 * Polymarket CLOB market WebSocket — live UP/DOWN book + mid stream.
 * Direct egress only (no order-write proxy) — saves paid-proxy bandwidth.
 *
 * Endpoint: wss://ws-subscriptions-clob.polymarket.com/ws/market
 * Subscribe: { type: "market", assets_ids: [tokenId, ...] }
 */
import WebSocket from 'ws';

const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const MAX_BOOK_AGE_MS = 15_000;
const RECONNECT_MS = 2500;
const PING_MS = 20_000;

/** @type {Map<string, { bestBid:number|null, bestAsk:number|null, mid:number|null, lastTrade:number|null, ts:number, source:string }>} */
const books = new Map();
const listeners = new Set();
/** @type {Set<string>} */
let desired = new Set();
let ws = null;
let running = false;
let reconnectTimer = null;
let pingTimer = null;
let lastMsgAt = 0;
let connectCount = 0;
let msgCount = 0;

function emit(tokenId, snap) {
  for (const fn of listeners) {
    try { fn(tokenId, snap); } catch {}
  }
}

function usablePx(px) {
  const n = Number(px);
  return Number.isFinite(n) && n > 0 && n < 1 ? n : null;
}

function upsertFromBook(assetId, bids, asks, ts) {
  if (!assetId) return;
  const bidPx = (bids || [])
    .map((b) => parseFloat(b.price ?? b[0]))
    .filter((p) => Number.isFinite(p) && p > 0)
    .sort((a, b) => b - a)[0] ?? null;
  const askPx = (asks || [])
    .map((a) => parseFloat(a.price ?? a[0]))
    .filter((p) => Number.isFinite(p) && p > 0)
    .sort((a, b) => a - b)[0] ?? null;
  const rawMid = bidPx != null && askPx != null
    ? (bidPx + askPx) / 2
    : (bidPx ?? askPx ?? null);
  const prev = books.get(String(assetId)) || {};
  const snap = {
    bestBid: bidPx,
    bestAsk: askPx,
    mid: usablePx(rawMid) ?? usablePx(prev.mid) ?? usablePx(prev.lastTrade),
    lastTrade: prev.lastTrade ?? null,
    ts: Number(ts) || Date.now(),
    source: 'clob-ws',
  };
  books.set(String(assetId), snap);
  emit(String(assetId), snap);
}

function applyPriceChange(change, ts) {
  const assetId = String(change.asset_id || change.assetId || '');
  if (!assetId) return;
  const price = parseFloat(change.price);
  const size = parseFloat(change.size);
  const side = String(change.side || '').toUpperCase();
  const prev = books.get(assetId) || {
    bestBid: null, bestAsk: null, mid: null, lastTrade: null, ts: 0, source: 'clob-ws',
  };
  let { bestBid, bestAsk } = prev;
  // size 0 = level removed; otherwise update best if this side improves/matches
  if (Number.isFinite(price) && price > 0) {
    if (side === 'BUY' || side === 'BID') {
      if (!Number.isFinite(size) || size <= 0) {
        if (bestBid === price) bestBid = null;
      } else if (bestBid == null || price >= bestBid) {
        bestBid = price;
      }
    } else if (side === 'SELL' || side === 'ASK') {
      if (!Number.isFinite(size) || size <= 0) {
        if (bestAsk === price) bestAsk = null;
      } else if (bestAsk == null || price <= bestAsk) {
        bestAsk = price;
      }
    }
  }
  const rawMid = bestBid != null && bestAsk != null
    ? (bestBid + bestAsk) / 2
    : (bestBid ?? bestAsk ?? prev.mid);
  const snap = {
    bestBid,
    bestAsk,
    mid: usablePx(rawMid) ?? usablePx(prev.mid) ?? usablePx(prev.lastTrade),
    lastTrade: prev.lastTrade,
    ts: Number(ts) || Date.now(),
    source: 'clob-ws',
  };
  books.set(assetId, snap);
  emit(assetId, snap);
}

function handleMessage(raw) {
  lastMsgAt = Date.now();
  msgCount += 1;
  let data;
  try { data = JSON.parse(raw.toString()); } catch { return; }

  // Initial snapshot can be an array of books
  if (Array.isArray(data)) {
    for (const item of data) {
      const assetId = item.asset_id || item.assetId || item.payload?.tokenId;
      upsertFromBook(assetId, item.bids || item.payload?.bids, item.asks || item.payload?.asks, item.timestamp || item.payload?.timestamp);
    }
    return;
  }

  const type = data.event_type || data.type || data.payload?.type;
  if (type === 'book' || data.bids || data.asks) {
    const assetId = data.asset_id || data.assetId || data.payload?.tokenId;
    upsertFromBook(
      assetId,
      data.bids || data.payload?.bids,
      data.asks || data.payload?.asks,
      data.timestamp || data.payload?.timestamp,
    );
    return;
  }

  if (type === 'price_change' || data.price_changes) {
    const changes = data.price_changes || data.payload?.price_changes || [];
    const ts = data.timestamp || data.payload?.timestamp;
    for (const c of changes) applyPriceChange(c, ts);
    return;
  }

  if (type === 'last_trade_price' || data.last_trade_price != null || data.payload?.lastTradePrice != null) {
    const assetId = String(data.asset_id || data.assetId || data.payload?.tokenId || '');
    const px = parseFloat(data.last_trade_price ?? data.price ?? data.payload?.lastTradePrice);
    if (!assetId || !Number.isFinite(px)) return;
    const prev = books.get(assetId) || {};
    const snap = {
      ...prev,
      lastTrade: px,
      mid: prev.mid ?? px,
      ts: Number(data.timestamp || data.payload?.timestamp) || Date.now(),
      source: 'clob-ws',
    };
    books.set(assetId, snap);
    emit(assetId, snap);
  }
}

function sendSubscribe(ids) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !ids.length) return;
  ws.send(JSON.stringify({ type: 'market', assets_ids: ids }));
}

function connect() {
  if (!running) return;
  if (ws) {
    try { ws.close(); } catch {}
    ws = null;
  }
  connectCount += 1;
  ws = new WebSocket(WS_URL);
  ws.on('open', () => {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    sendSubscribe([...desired]);
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) {
        try { ws.ping(); } catch {}
      }
    }, PING_MS);
  });
  ws.on('message', handleMessage);
  ws.on('close', () => {
    ws = null;
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (!running) return;
    reconnectTimer = setTimeout(connect, RECONNECT_MS);
  });
  ws.on('error', () => {
    try { ws?.close(); } catch {}
  });
}

export function onClobBook(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function startClobMarketStream(tokenIds = []) {
  running = true;
  if (tokenIds?.length) setClobMarketTokens(tokenIds);
  if (!ws || ws.readyState !== WebSocket.OPEN) connect();
}

export function stopClobMarketStream() {
  running = false;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  if (ws) { try { ws.close(); } catch {} ws = null; }
}

/** Replace subscribed token set (BTC/ETH up+down current + next). */
export function setClobMarketTokens(tokenIds = []) {
  const next = new Set(
    (tokenIds || []).map((id) => String(id)).filter(Boolean),
  );
  const same = next.size === desired.size && [...next].every((id) => desired.has(id));
  desired = next;
  if (!running) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    connect();
    return;
  }
  if (!same) sendSubscribe([...desired]);
}

export function getClobWsMid(tokenId) {
  const snap = books.get(String(tokenId));
  if (!snap) return null;
  if (Date.now() - snap.ts > MAX_BOOK_AGE_MS) return null;
  return Number.isFinite(snap.mid) ? snap.mid : null;
}

export function getClobWsBook(tokenId) {
  const snap = books.get(String(tokenId));
  if (!snap) return null;
  if (Date.now() - snap.ts > MAX_BOOK_AGE_MS) return { ...snap, stale: true };
  return { ...snap, stale: false };
}

export function getClobWsSnapshot() {
  const out = {};
  for (const [id, snap] of books.entries()) {
    out[id] = {
      ...snap,
      ageMs: Math.max(0, Date.now() - snap.ts),
      stale: Date.now() - snap.ts > MAX_BOOK_AGE_MS,
    };
  }
  return {
    connected: !!(ws && ws.readyState === WebSocket.OPEN),
    running,
    subscribed: desired.size,
    books: Object.keys(out).length,
    msgCount,
    connectCount,
    lastMsgAt,
    lastMsgAgeMs: lastMsgAt ? Date.now() - lastMsgAt : null,
    tokens: out,
  };
}
