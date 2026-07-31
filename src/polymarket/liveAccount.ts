// @ts-nocheck
/**
 * Live account ledger — ground truth from Polymarket data-api
 * (closed-positions + activity), reconciled against CLOB cash.
 *
 * Bot marks can lie when a sell fails but the tracker still closes.
 * This ledger is the money story: fills, settles, cash, drift.
 */
import { persist, persistSync, load, dataPath, FILES } from './persistence.js';
import { getWallet } from '../lib/wallet.js';
import { getClobBalance } from './trade.js';
import { dedupeTrades } from './audit.js';

const FILE = dataPath('live_account.json');
const MAX_EVENTS = 800;
const MAX_CLOSED = 200;
const MAX_TRACES = 400;

function emptyStore() {
  return {
    updatedAt: Date.now(),
    wallet: null,
    cash: {
      clob: 0,
      lastSyncAt: null,
      sessionStartCash: null,
      lifetimeBaseline: null,
    },
    closed: [], // PM closed-positions snapshots (keyed by slug+outcome)
    events: [], // BUY/SELL/REDEEM from activity
    traces: [],
    reconcile: null,
    botMismatch: [],
  };
}

function loadStore() {
  return load(FILE, emptyStore()) || emptyStore();
}

function saveStore(store, sync = false) {
  store.updatedAt = Date.now();
  if (sync) persistSync(FILE, store);
  else persist(FILE, store);
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function depositWallet() {
  return getWallet()?.polymarketDepositWallet || null;
}

function appendTrace(store, event) {
  const row = {
    id: `lat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: Date.now(),
    ...event,
  };
  store.traces = [row, ...(store.traces || [])].slice(0, MAX_TRACES);
  return row;
}

async function fetchJson(url, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export async function fetchClosedPositions(wallet = depositWallet(), limit = 50) {
  if (!wallet) return [];
  const data = await fetchJson(
    `https://data-api.polymarket.com/closed-positions?user=${wallet}&limit=${limit}`,
  );
  return Array.isArray(data) ? data : [];
}

export async function fetchActivity(wallet = depositWallet(), limit = 80) {
  if (!wallet) return [];
  const data = await fetchJson(
    `https://data-api.polymarket.com/activity?user=${wallet}&limit=${limit}`,
  );
  return Array.isArray(data) ? data : [];
}

function normalizeClosed(row) {
  const shares = Number(row.totalBought ?? row.size ?? 0) || 0;
  const avg = Number(row.avgPrice ?? 0) || 0;
  const cost = round2(shares * avg);
  const realized = round2(row.realizedPnl);
  const won = round2(cost + realized);
  return {
    key: `${row.slug || ''}::${String(row.outcome || '').toLowerCase()}`,
    slug: row.slug || null,
    title: row.title || null,
    outcome: row.outcome || null,
    shares: Math.round(shares * 1e6) / 1e6,
    avgPrice: avg,
    costUsd: cost,
    amountWonUsd: won,
    realizedPnl: realized,
    realizedPct: cost > 0 ? round2((realized / cost) * 100) : null,
    curPrice: row.curPrice != null ? Number(row.curPrice) : null,
    timestamp: Number(row.timestamp) || null,
    endDate: row.endDate || null,
    source: 'polymarket-closed',
  };
}

function normalizeActivity(row) {
  const ts = Number(row.timestamp) || Date.now();
  // activity timestamps are often seconds
  const timestamp = ts < 2e10 ? ts * 1000 : ts;
  return {
    id: `${row.type || 'ACT'}-${row.transactionHash || row.id || ''}-${timestamp}-${row.side || ''}-${row.slug || ''}`,
    type: row.type || 'UNKNOWN',
    side: row.side || null,
    slug: row.slug || null,
    title: row.title || null,
    outcome: row.outcome || null,
    shares: Number(row.size ?? 0) || 0,
    price: Number(row.price ?? 0) || 0,
    usdcSize: round2(row.usdcSize),
    timestamp,
    txHash: row.transactionHash || row.txHash || null,
    source: 'polymarket-activity',
  };
}

/**
 * Pull PM closed-positions + activity + CLOB cash into durable ledger.
 * Optionally compare against bot live trades for mismatch traces.
 */
export async function syncLiveAccount({ botTrades = [], note = 'sync' } = {}) {
  const store = loadStore();
  const wallet = depositWallet();
  store.wallet = wallet;

  // Always merge persisted live trades so paper-mode API sync still sees fills
  const persisted = load(FILES.TRADES, []) || [];
  const merged = dedupeTrades([...(botTrades || []), ...persisted]);
  const liveBotAll = merged.filter((t) => t.mode === 'live');

  const [closedRaw, activityRaw, clobRaw] = await Promise.all([
    fetchClosedPositions(wallet, 80),
    fetchActivity(wallet, 100),
    getClobBalance().catch(() => null),
  ]);

  const prevCash = Number(store.cash?.clob) || 0;
  const cash = round2(
    clobRaw && typeof clobRaw === 'object'
      ? clobRaw.balance
      : (clobRaw ?? store.cash?.clob ?? 0),
  );
  store.cash = {
    ...store.cash,
    clob: cash,
    lastSyncAt: Date.now(),
  };
  if (store.cash.lifetimeBaseline == null && cash > 0) {
    store.cash.lifetimeBaseline = cash;
  }

  const closed = closedRaw.map(normalizeClosed);
  const byKey = new Map((store.closed || []).map((c) => [c.key, c]));
  const newlyClosed = [];
  for (const c of closed) {
    const prev = byKey.get(c.key);
    if (!prev || prev.realizedPnl !== c.realizedPnl || prev.shares !== c.shares) {
      if (!prev || Math.abs((prev.realizedPnl || 0) - c.realizedPnl) > 0.001) {
        newlyClosed.push(c);
      }
      byKey.set(c.key, c);
    }
  }
  store.closed = [...byKey.values()]
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, MAX_CLOSED);

  const events = activityRaw.map(normalizeActivity);
  const seen = new Set((store.events || []).map((e) => e.id));
  const freshEvents = [];
  for (const e of events) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    freshEvents.push(e);
  }
  store.events = [...freshEvents, ...(store.events || [])].slice(0, MAX_EVENTS);

  for (const c of newlyClosed) {
    appendTrace(store, {
      type: 'pm_closed',
      message: `${c.slug || c.title} · ${c.outcome} · ${c.shares}sh @ ${(c.avgPrice * 100).toFixed(1)}¢ · PnL $${c.realizedPnl} (${c.realizedPct ?? '?'}%)`,
      ...c,
    });
  }
  for (const e of freshEvents.slice(0, 20)) {
    appendTrace(store, {
      type: e.type === 'TRADE' ? `pm_${String(e.side || 'trade').toLowerCase()}` : `pm_${String(e.type || 'event').toLowerCase()}`,
      message: `${e.side || e.type} ${e.slug || ''} · ${e.shares}sh @ ${e.price} · $${e.usdcSize}`,
      slug: e.slug,
      side: e.side,
      shares: e.shares,
      price: e.price,
      usdcSize: e.usdcSize,
      outcome: e.outcome,
    });
  }
  if (Math.abs(cash - prevCash) > 0.02) {
    appendTrace(store, {
      type: 'cash_sync',
      message: `CLOB cash $${prevCash} → $${cash} (Δ $${round2(cash - prevCash)}) · ${note}`,
      prevCash,
      cash,
      delta: round2(cash - prevCash),
    });
  }

  // Bot vs PM closed mismatch (same slug)
  const liveBot = liveBotAll.filter((t) => t.slug);
  const botBySlug = new Map();
  for (const t of liveBot) {
    const k = `${t.slug}::${String(t.outcome || '').toLowerCase()}`;
    const cur = botBySlug.get(k) || { slug: t.slug, outcome: t.outcome, pnl: 0, trades: 0, shares: 0 };
    cur.pnl = round2(cur.pnl + Number(t.pnl || 0));
    cur.trades += 1;
    cur.shares = round2(cur.shares + Number(t.shares || 0));
    botBySlug.set(k, cur);
  }
  const mismatches = [];
  for (const c of store.closed) {
    const bot = botBySlug.get(c.key);
    if (!bot) continue;
    const gap = round2(c.realizedPnl - bot.pnl);
    if (Math.abs(gap) > 0.5) {
      mismatches.push({
        slug: c.slug,
        outcome: c.outcome,
        pmPnl: c.realizedPnl,
        botPnl: bot.pnl,
        gap,
        pmShares: c.shares,
        botShares: bot.shares,
        botTrades: bot.trades,
        note: gap > 0
          ? 'PM realized more than bot marks — likely failed sell then settle/near-settle exit'
          : 'Bot marks ahead of PM — phantom close or fee/fill skew',
      });
    }
  }
  store.botMismatch = mismatches.slice(0, 40);

  const pmRealizedSum = round2(store.closed.reduce((s, c) => s + Number(c.realizedPnl || 0), 0));
  const botVerifiedSum = round2(
    liveBot.filter((t) => t.orderId).reduce((s, t) => s + Number(t.pnl || 0), 0),
  );
  const lifetime = store.cash.lifetimeBaseline;
  store.reconcile = {
    at: Date.now(),
    clobCash: cash,
    lifetimeBaseline: lifetime,
    cashPnlVsLifetime: lifetime != null ? round2(cash - lifetime) : null,
    pmClosedCount: store.closed.length,
    pmRealizedSum,
    botVerifiedSum,
    botVsPmGap: round2(pmRealizedSum - botVerifiedSum),
    mismatchCount: mismatches.length,
    ok: mismatches.length === 0,
    note,
  };

  saveStore(store, true);
  return getLiveAccount(40);
}

export function markLiveSessionStart(cash) {
  const store = loadStore();
  store.cash = {
    ...store.cash,
    sessionStartCash: round2(cash),
    clob: round2(cash ?? store.cash?.clob),
  };
  appendTrace(store, {
    type: 'live_session_start',
    message: `Live session cash baseline $${round2(cash)}`,
    cash: round2(cash),
  });
  saveStore(store, true);
  return store.cash;
}

export function markLiveSessionEnd({ cash, reason } = {}) {
  const store = loadStore();
  const start = store.cash?.sessionStartCash;
  const end = round2(cash ?? store.cash?.clob);
  const sessionCashPnl = start != null ? round2(end - start) : null;
  appendTrace(store, {
    type: 'live_session_end',
    message: `Live session end · ${reason || 'stopped'} · cash PnL $${sessionCashPnl ?? '?'} ($${start} → $${end})`,
    sessionStartCash: start,
    cash: end,
    sessionCashPnl,
    reason: reason || null,
  });
  store.cash = { ...store.cash, clob: end, sessionStartCash: null };
  saveStore(store, true);
  return { sessionCashPnl, start, end };
}

/** Record a bot-attributed live fill into traces (alongside PM sync). */
export function traceLiveFill(event) {
  const store = loadStore();
  appendTrace(store, {
    type: event.type || 'bot_fill',
    message: event.message,
    slug: event.slug,
    outcome: event.outcome,
    side: event.side,
    shares: event.shares,
    price: event.price,
    usdc: event.usdc,
    pnl: event.pnl,
    orderId: event.orderId,
    sellOrderId: event.sellOrderId,
    exitReason: event.exitReason,
    verifiedSell: event.verifiedSell,
  });
  saveStore(store);
}

export function getLiveAccount(limit = 30) {
  const store = loadStore();
  const start = store.cash?.sessionStartCash;
  const cash = Number(store.cash?.clob) || 0;
  return {
    updatedAt: store.updatedAt,
    wallet: store.wallet,
    cash: {
      ...store.cash,
      sessionCashPnl: start != null ? round2(cash - start) : null,
    },
    reconcile: store.reconcile,
    closed: (store.closed || []).slice(0, limit),
    recentEvents: (store.events || []).slice(0, limit),
    mismatches: store.botMismatch || [],
    traces: (store.traces || []).slice(0, 60),
    totals: {
      pmRealizedSum: round2((store.closed || []).reduce((s, c) => s + Number(c.realizedPnl || 0), 0)),
      closedWins: (store.closed || []).filter((c) => Number(c.realizedPnl) > 0).length,
      closedLosses: (store.closed || []).filter((c) => Number(c.realizedPnl) <= 0).length,
    },
  };
}
