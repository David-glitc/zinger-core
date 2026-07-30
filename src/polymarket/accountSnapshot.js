/**
 * Equity curve + session PnL snapshot (SVG data URL) for Core Account tab.
 */
import { persist, persistSync, load, dataPath } from './persistence.js';

const CURVE_FILE = dataPath('equity_curve.json');
const MAX_POINTS = 2000;

function emptyCurve() {
  return { updatedAt: Date.now(), points: [] };
}

export function loadEquityCurve() {
  return load(CURVE_FILE, emptyCurve()) || emptyCurve();
}

export function appendEquityPoint({
  cash,
  equity,
  realizedPnl,
  unrealizedPnl,
  mode,
  sessionId,
  note,
} = {}) {
  const store = loadEquityCurve();
  const point = {
    t: Date.now(),
    cash: Number(cash) || 0,
    equity: Number(equity) || 0,
    realizedPnl: Number(realizedPnl) || 0,
    unrealizedPnl: Number(unrealizedPnl) || 0,
    mode: mode || 'paper',
    sessionId: sessionId || null,
    note: note || null,
  };
  const last = store.points[store.points.length - 1];
  // Debounce identical equity within 5s
  if (last && Math.abs(last.equity - point.equity) < 0.01 && point.t - last.t < 5000) {
    return store;
  }
  store.points = [...(store.points || []), point].slice(-MAX_POINTS);
  store.updatedAt = Date.now();
  persist(CURVE_FILE, store);
  return store;
}

export function getAccountStats(trades = [], liveAccount = null) {
  const list = (trades || []).filter((t) => t.exitPrice != null || t.closed);
  const sorted = [...list].sort((a, b) => Number(b.pnl || 0) - Number(a.pnl || 0));
  const best = sorted.slice(0, 8).map((t) => ({
    id: t.id,
    slug: t.slug,
    symbol: t.symbol,
    outcome: t.outcome,
    entryPrice: t.entryPrice,
    exitPrice: t.exitPrice,
    pnl: t.pnl,
    exitReason: t.exitReason,
    mode: t.mode,
    shares: t.shares,
    timestamp: t.timestamp || t.entryTime,
  }));
  const worst = [...sorted].reverse().slice(0, 5).map((t) => ({
    id: t.id,
    slug: t.slug,
    symbol: t.symbol,
    pnl: t.pnl,
    exitReason: t.exitReason,
    mode: t.mode,
  }));
  const wins = list.filter((t) => Number(t.pnl) > 0);
  const losses = list.filter((t) => Number(t.pnl) <= 0);
  const totalPnl = list.reduce((s, t) => s + Number(t.pnl || 0), 0);
  return {
    best,
    worst,
    closed: list.length,
    wins: wins.length,
    losses: losses.length,
    winRate: list.length ? Math.round((wins.length / list.length) * 1000) / 10 : null,
    totalPnl: Math.round(totalPnl * 100) / 100,
    pmRealizedSum: liveAccount?.totals?.pmRealizedSum ?? null,
    clobCash: liveAccount?.cash?.clob ?? null,
  };
}

/** SVG PnL card as data URL for session / snapshot share */
export function buildPnlSnapshotSvg({
  title = 'Zinger session',
  mode = 'paper',
  equity = 0,
  cash = 0,
  pnl = 0,
  winRate = null,
  bestTrade = null,
  sessionId = null,
  at = Date.now(),
} = {}) {
  const pnlColor = pnl >= 0 ? '#34d399' : '#f87171';
  const wr = winRate != null ? `${winRate}%` : '—';
  const best = bestTrade != null ? `$${Number(bestTrade).toFixed(2)}` : '—';
  const when = new Date(at).toISOString().replace('T', ' ').slice(0, 19);
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="720" height="400" viewBox="0 0 720 400">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0b1220"/>
      <stop offset="100%" stop-color="#111827"/>
    </linearGradient>
  </defs>
  <rect width="720" height="400" rx="24" fill="url(#bg)"/>
  <text x="40" y="56" fill="#94a3b8" font-family="ui-sans-serif,system-ui" font-size="18">Zinger · ${String(mode).toUpperCase()}</text>
  <text x="40" y="100" fill="#f8fafc" font-family="ui-sans-serif,system-ui" font-size="32" font-weight="700">${escapeXml(title)}</text>
  <text x="40" y="170" fill="#94a3b8" font-family="ui-monospace,monospace" font-size="14">EQUITY</text>
  <text x="40" y="210" fill="#f8fafc" font-family="ui-monospace,monospace" font-size="44" font-weight="700">$${Number(equity).toFixed(2)}</text>
  <text x="360" y="170" fill="#94a3b8" font-family="ui-monospace,monospace" font-size="14">SESSION PnL</text>
  <text x="360" y="210" fill="${pnlColor}" font-family="ui-monospace,monospace" font-size="44" font-weight="700">${pnl >= 0 ? '+' : ''}$${Number(pnl).toFixed(2)}</text>
  <text x="40" y="270" fill="#94a3b8" font-family="ui-monospace,monospace" font-size="14">CASH</text>
  <text x="40" y="300" fill="#e2e8f0" font-family="ui-monospace,monospace" font-size="24">$${Number(cash).toFixed(2)}</text>
  <text x="220" y="270" fill="#94a3b8" font-family="ui-monospace,monospace" font-size="14">WIN RATE</text>
  <text x="220" y="300" fill="#e2e8f0" font-family="ui-monospace,monospace" font-size="24">${wr}</text>
  <text x="400" y="270" fill="#94a3b8" font-family="ui-monospace,monospace" font-size="14">BEST TRADE</text>
  <text x="400" y="300" fill="#e2e8f0" font-family="ui-monospace,monospace" font-size="24">${best}</text>
  <text x="40" y="360" fill="#64748b" font-family="ui-monospace,monospace" font-size="12">${when}${sessionId ? ` · ${sessionId}` : ''}</text>
</svg>`;
  const b64 = Buffer.from(svg).toString('base64');
  return {
    mime: 'image/svg+xml',
    dataUrl: `data:image/svg+xml;base64,${b64}`,
    svg,
  };
}

function escapeXml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function buildAccountBundle(state = {}) {
  const mode = state.mode || state.config?.mode || 'paper';
  const portfolio = state.portfolio || state.cashAudit || {};
  const trades = (state.trades || []).filter((t) => !t.mode || t.mode === mode);
  const liveAccount = state.liveAccount || null;
  const stats = getAccountStats(trades, liveAccount);
  const curve = loadEquityCurve();
  const session = state.session || {};
  const snapshot = buildPnlSnapshotSvg({
    title: session.id ? `Session ${session.id}` : `${String(mode).toUpperCase()} book`,
    mode,
    equity: portfolio.equity ?? portfolio.cash ?? 0,
    cash: portfolio.cash ?? 0,
    pnl: session.pnl ?? portfolio.netPnl ?? stats.totalPnl ?? 0,
    winRate: stats.winRate,
    bestTrade: stats.best[0]?.pnl ?? null,
    sessionId: session.id || null,
  });
  return {
    mode,
    curve: {
      updatedAt: curve.updatedAt,
      points: (curve.points || []).filter((p) => !p.mode || p.mode === mode).slice(-400),
    },
    stats,
    snapshot,
    liveAccount: liveAccount
      ? {
          cash: liveAccount.cash,
          totals: liveAccount.totals,
          closed: (liveAccount.closed || []).slice(0, 12),
          mismatches: (liveAccount.mismatches || []).slice(0, 8),
        }
      : null,
  };
}
