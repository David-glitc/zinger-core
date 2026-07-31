// @ts-nocheck
import WebSocket from 'ws';

const MAX_TICKS = 4000;
const history = { btc: [], eth: [] };
const listeners = new Set();
let ws = null;
let reconnectTimer = null;
let running = false;

export function onSpotTick(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getSpotHistory(asset, limit = 500) {
  const buf = history[asset];
  if (!buf || buf.length === 0) return [];
  return buf.slice(-limit);
}

export function addSpotTick(asset, price, ts = Date.now()) {
  const buf = history[asset];
  if (!buf) return;
  const last = buf[buf.length - 1];
  if (last && Math.abs(price - last.price) / last.price < 0.00001 && ts - last.t < 1000) return;
  buf.push({ t: ts, price });
  if (buf.length > MAX_TICKS) buf.splice(0, buf.length - MAX_TICKS);
  for (const fn of listeners) {
    try { fn(asset, price, ts); } catch {}
  }
}

function connectWS() {
  if (ws) try { ws.close(); } catch {}
  const streams = ['btcusdt@trade', 'ethusdt@trade'];
  const url = `wss://stream.binance.com:9443/stream?streams=${streams.join('/')}`;
  ws = new WebSocket(url);
  ws.on('open', () => { if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; } });
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      const data = msg.data;
      if (!data || !data.s) return;
      const asset = data.s === 'BTCUSDT' ? 'btc' : data.s === 'ETHUSDT' ? 'eth' : null;
      if (!asset) return;
      addSpotTick(asset, parseFloat(data.p), data.T);
    } catch {}
  });
  ws.on('close', () => {
    ws = null;
    if (!running) return;
    reconnectTimer = setTimeout(connectWS, 3000);
  });
  ws.on('error', () => {
    ws = null;
    if (!running) return;
    reconnectTimer = setTimeout(connectWS, 5000);
  });
}

export function startSpotPriceStream() {
  if (running) return;
  running = true;
  connectWS();
}

export function stopSpotPriceStream() {
  running = false;
  if (ws) { try { ws.close(); } catch {} ws = null; }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
}

export function getSpotPriceSnapshot() {
  const snap = {};
  for (const asset of ['btc', 'eth']) {
    const buf = history[asset];
    const last = buf && buf.length > 0 ? buf[buf.length - 1] : null;
    snap[asset] = {
      price: last?.price || null,
      ts: last?.t || null,
      ticks: buf?.length || 0,
    };
  }
  return snap;
}
