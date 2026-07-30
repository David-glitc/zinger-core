import fs from 'fs';
import { dataPath } from './persistence.js';

const FILE = dataPath('poly_config_sessions.json');

function readStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(parsed.sessions) ? parsed : { sessions: [] };
  } catch {
    return { sessions: [] };
  }
}

function writeStore(store) {
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, FILE);
}

function summarizeTrades(trades, mode, limit = 100) {
  const rows = (trades || [])
    .filter((trade) => trade.mode === mode && (trade.closed || trade.exitReason))
    .slice(0, limit);
  const pnls = rows.map((trade) => Number(trade.pnl || 0));
  const wins = pnls.filter((pnl) => pnl > 0).length;
  const exits = {};
  for (const trade of rows) {
    const reason = trade.exitReason || 'unknown';
    exits[reason] = (exits[reason] || 0) + 1;
  }
  return {
    trades: rows.length,
    wins,
    losses: rows.length - wins,
    winRate: rows.length ? Math.round((wins / rows.length) * 1000) / 10 : 0,
    pnl: Math.round(pnls.reduce((sum, pnl) => sum + pnl, 0) * 100) / 100,
    exits,
  };
}

export function saveConfigSession({ configStore, trades, label = '', source = 'manual' }) {
  const store = readStore();
  const mode = configStore?.mode === 'live' ? 'live' : 'paper';
  const row = {
    id: `cfg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    label: String(label || `${mode} config`).slice(0, 80),
    source,
    mode,
    createdAt: Date.now(),
    configStore: JSON.parse(JSON.stringify(configStore || {})),
    analysis: {
      paper: summarizeTrades(trades, 'paper'),
      live: summarizeTrades(trades, 'live'),
    },
  };
  store.sessions = [row, ...store.sessions].slice(0, 100);
  writeStore(store);
  return row;
}

export function listConfigSessions() {
  return readStore().sessions;
}

export function getConfigSession(id) {
  return readStore().sessions.find((session) => session.id === id) || null;
}

export function analyzeConfigSessions(trades = []) {
  const sessions = listConfigSessions();
  return {
    count: sessions.length,
    latest: sessions[0] || null,
    current: {
      paper: summarizeTrades(trades, 'paper'),
      live: summarizeTrades(trades, 'live'),
    },
    sessions: sessions.slice(0, 30).map((session) => ({
      id: session.id,
      label: session.label,
      source: session.source,
      mode: session.mode,
      createdAt: session.createdAt,
      analysis: session.analysis,
      activeConfig: session.configStore?.profiles?.[session.mode] || null,
    })),
  };
}
