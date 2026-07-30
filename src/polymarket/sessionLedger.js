/**
 * Durable bot session ledger — profit, traces, reconcile.
 * Written under data/session_ledger.json (gitignored via data/*.local if needed — use poly_ prefix).
 */
import { persist, persistSync, load, dataPath } from './persistence.js';

const FILE = dataPath('session_ledger.json');
const MAX_SESSIONS = 40;
const MAX_TRACES_PER_SESSION = 500;

function emptyStore() {
  return { updatedAt: Date.now(), currentId: null, sessions: [] };
}

function loadStore() {
  return load(FILE, emptyStore()) || emptyStore();
}

function saveStore(store, sync = false) {
  store.updatedAt = Date.now();
  if (sync) persistSync(FILE, store);
  else persist(FILE, store);
}

function findSession(store, id) {
  return store.sessions.find((s) => s.id === id) || null;
}

export function startSessionLedger({
  id,
  mode,
  baselineCash,
  baselinePnl,
  baselineTradeCount,
  baselineUnrealizedPnl,
  equity,
  note,
} = {}) {
  const store = loadStore();
  const session = {
    id: id || `session-${Date.now().toString(36)}`,
    mode: mode || 'paper',
    status: 'running',
    startedAt: Date.now(),
    endedAt: null,
    stopReason: null,
    baseline: {
      cash: Number(baselineCash) || 0,
      pnl: Number(baselinePnl) || 0,
      tradeCount: Number(baselineTradeCount) || 0,
      equity: Number(equity) || Number(baselineCash) || 0,
      unrealizedPnl: Number(baselineUnrealizedPnl) || 0,
    },
    peak: {
      equity: Number(equity) || Number(baselineCash) || 0,
      cash: Number(baselineCash) || 0,
    },
    latest: {
      cash: Number(baselineCash) || 0,
      equity: Number(equity) || Number(baselineCash) || 0,
      realizedPnl: 0,
      unrealizedPnl: Number(baselineUnrealizedPnl) || 0,
      openCount: 0,
      feesPaid: 0,
    },
    sessionPnl: 0,
    tradeCount: 0,
    traces: [],
    reconcile: null,
    note: note || null,
  };
  store.sessions = [session, ...store.sessions.filter((s) => s.id !== session.id)].slice(0, MAX_SESSIONS);
  store.currentId = session.id;
  appendTrace(store, session.id, {
    type: 'session_start',
    message: `Session started · ${session.mode}`,
    cash: session.baseline.cash,
    equity: session.baseline.equity,
  });
  saveStore(store, true);
  return session;
}

function appendTrace(store, sessionId, event) {
  const session = findSession(store, sessionId);
  if (!session) return null;
  const row = {
    id: `tr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: Date.now(),
    ...event,
  };
  session.traces = [row, ...(session.traces || [])].slice(0, MAX_TRACES_PER_SESSION);
  return row;
}

export function traceSession(event) {
  const store = loadStore();
  if (!store.currentId) return null;
  const row = appendTrace(store, store.currentId, event);
  saveStore(store);
  return row;
}

export function updateSessionMarks({
  cash,
  equity,
  realizedPnl,
  unrealizedPnl,
  openCount,
  feesPaid,
  sessionPnl,
  tradeCount,
} = {}) {
  const store = loadStore();
  const session = findSession(store, store.currentId);
  if (!session || session.status !== 'running') return null;
  session.latest = {
    cash: Number(cash ?? session.latest.cash) || 0,
    equity: Number(equity ?? session.latest.equity) || 0,
    realizedPnl: Number(realizedPnl ?? session.latest.realizedPnl) || 0,
    unrealizedPnl: Number(unrealizedPnl ?? session.latest.unrealizedPnl) || 0,
    openCount: Number(openCount ?? session.latest.openCount) || 0,
    feesPaid: Number(feesPaid ?? session.latest.feesPaid) || 0,
  };
  if (sessionPnl != null) session.sessionPnl = Number(sessionPnl) || 0;
  if (tradeCount != null) session.tradeCount = Number(tradeCount) || 0;
  if (session.latest.equity > session.peak.equity) session.peak.equity = session.latest.equity;
  if (session.latest.cash > session.peak.cash) session.peak.cash = session.latest.cash;
  saveStore(store);
  return session;
}

export function reconcileSession({
  cash,
  equity,
  realizedPnl,
  unrealizedPnl,
  openCost,
  openMark,
  initialBankroll,
  tradesPnlSum,
  sessionCashDelta = null,
  mode = 'paper',
  issues = [],
} = {}) {
  const store = loadStore();
  const session = findSession(store, store.currentId) || store.sessions[0];
  if (!session) return null;

  const bankroll = Number(initialBankroll ?? session.baseline.cash ?? 0);
  const booksEquity = bankroll
    + Number(realizedPnl || 0)
    + Number(unrealizedPnl || 0);
  const cashExpect = bankroll
    + Number(realizedPnl || 0)
    - Number(openCost || 0);
  const driftEquity = Math.round((Number(equity || 0) - booksEquity) * 100) / 100;
  const driftCash = Math.round((Number(cash || 0) - cashExpect) * 100) / 100;
  const sessionTradePnl = Math.round(
    (Number(tradesPnlSum || 0) - Number(session.baseline.pnl || 0)) * 100,
  ) / 100;
  const sessionEquityPnl = Math.round(
    (Number(equity || 0) - Number(session.baseline.equity || 0)) * 100,
  ) / 100;
  const sessionUnrealizedDelta = Math.round(
    (Number(unrealizedPnl || 0) - Number(session.baseline.unrealizedPnl || 0)) * 100,
  ) / 100;
  const expectedEquityDelta = Math.round((sessionTradePnl + sessionUnrealizedDelta) * 100) / 100;

  const found = [...issues];
  // Live: CLOB cash + verified fills are primary; skip paper-style booksEquity vs stale realized
  if (mode !== 'live') {
    if (Math.abs(driftEquity) > 1) found.push(`equity drift $${driftEquity}`);
    if (Math.abs(driftCash) > 1) found.push(`cash drift $${driftCash}`);
    if (Math.abs(expectedEquityDelta - sessionEquityPnl) > 5) {
      found.push(
        `session books Δ $${expectedEquityDelta} (trades $${sessionTradePnl} + uPnL $${sessionUnrealizedDelta}) vs equity Δ $${sessionEquityPnl}`,
      );
    }
  } else if (sessionCashDelta != null && Math.abs(sessionCashDelta - sessionTradePnl) > 3) {
    found.push(`live cash Δ $${sessionCashDelta} vs fill PnL $${sessionTradePnl} (check PM closed-positions)`);
  }

  // Live session PnL = verified fill Δ (not equity Δ). Paper keeps equity Δ for MTM feel.
  const primaryPnl = mode === 'live' ? sessionTradePnl : sessionEquityPnl;

  session.reconcile = {
    at: Date.now(),
    mode,
    cash: Number(cash) || 0,
    equity: Number(equity) || 0,
    realizedPnl: Number(realizedPnl) || 0,
    unrealizedPnl: Number(unrealizedPnl) || 0,
    openCost: Number(openCost) || 0,
    openMark: Number(openMark) || 0,
    booksEquity: Math.round(booksEquity * 100) / 100,
    cashExpect: Math.round(cashExpect * 100) / 100,
    driftEquity,
    driftCash,
    sessionTradePnl,
    sessionEquityPnl,
    sessionCashDelta,
    sessionUnrealizedDelta,
    expectedEquityDelta,
    ok: found.length === 0,
    issues: found,
  };
  session.sessionPnl = primaryPnl;
  appendTrace(store, session.id, {
    type: 'reconcile',
    message: session.reconcile.ok
      ? `Reconcile OK · session PnL $${primaryPnl}`
      : `Reconcile issues · ${found.slice(0, 2).join('; ')}`,
    ...session.reconcile,
  });
  saveStore(store, true);
  return session.reconcile;
}

export function endSessionLedger(reason = 'stopped', finalMarks = {}) {
  const store = loadStore();
  const session = findSession(store, store.currentId);
  if (!session) return null;
  if (finalMarks && Object.keys(finalMarks).length) {
    session.latest = { ...session.latest, ...finalMarks };
  }
  session.status = 'stopped';
  session.stopReason = reason;
  session.endedAt = Date.now();
  session.uptimeMs = Math.max(0, session.endedAt - session.startedAt);
  if (finalMarks?.sessionPnl != null) {
    session.sessionPnl = Number(finalMarks.sessionPnl) || 0;
  } else if (session.mode === 'live' && session.reconcile?.sessionTradePnl != null) {
    session.sessionPnl = session.reconcile.sessionTradePnl;
  } else if (session.latest?.equity != null && session.baseline?.equity != null) {
    session.sessionPnl = Math.round(
      (Number(session.latest.equity) - Number(session.baseline.equity)) * 100,
    ) / 100;
  }
  appendTrace(store, session.id, {
    type: 'session_stop',
    message: `Session stopped · ${reason} · PnL $${session.sessionPnl}`,
    sessionPnl: session.sessionPnl,
    cash: session.latest?.cash,
    equity: session.latest?.equity,
  });
  store.currentId = null;
  saveStore(store, true);
  return session;
}

export function getSessionLedger(limit = 10) {
  const store = loadStore();
  const current = findSession(store, store.currentId);
  return {
    updatedAt: store.updatedAt,
    currentId: store.currentId,
    current: current
      ? {
          ...current,
          uptimeMs: current.status === 'running'
            ? Math.max(0, Date.now() - current.startedAt)
            : current.uptimeMs || 0,
          traces: (current.traces || []).slice(0, 80),
        }
      : null,
    recent: store.sessions.slice(0, limit).map((s) => ({
      id: s.id,
      mode: s.mode,
      status: s.status,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      sessionPnl: s.sessionPnl,
      tradeCount: s.tradeCount,
      reconcile: s.reconcile,
      stopReason: s.stopReason,
    })),
  };
}
