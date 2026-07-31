// @ts-nocheck
/**
 * Autonomous regime governor — the "gear box" that sits above the fine-tune
 * optimizer. Every tick it classifies the market regime and switches the bot
 * between a small set of bounded strategy profiles, in-flight, on its own.
 *
 * Levers are deliberately narrow (profile selection only — no free-form knob
 * writing) so behaviour stays predictable. Guardrails:
 *   - drawdown circuit-breaker  → force arb-only when equity falls off its peak
 *   - cooldown                  → no thrashing between profiles
 *   - auto-revert               → undo a switch that bleeds PnL over N trades
 *   - live safety               → never relaxes the live edge-gate lock
 * Every action is logged with its rationale.
 */
import fs from 'fs';
import path from 'path';
import { chat, llmStatus } from './llm.js';

const DATA_DIR = path.resolve(import.meta.dirname, '../../data');
const GOV_FILE = path.join(DATA_DIR, 'governor_state.json');

// Bounded knob overlays per regime. Values stay inside optimizer/primitive bounds.
export const REGIME_PROFILES = {
  // Mid-band trend: recent paper sim winner sits ~0.42–0.68, not rich favorites
  'trend-ride': {
    minPrice: 0.42, maxPrice: 0.70,
    tpPctLow: 22, tpPctHigh: 55, slPct: 18,
    adaptiveSl: false, minAdaptiveSlPct: 16,
    partialTpFrac: 0.85, partialSellPct: 0.2,
    trailActivateFrac: 0.85, trailDistanceCap: 9,
    kellyFraction: 0.18, minConfidence: 0.42,
    certaintyMaxPct: 0.28,
    holdToSettleUnderdogs: true,
    holdToSettleFavorites: false,
    underdogMaxPrice: 0.50,
    holdToSettleDisasterSlPct: 48,
    minRemainingSec: 30,
    evalBothSides: true,
    enabledDurations: ['5m', '15m'],
    arbOnlyUntilEdge: false,
    shortTfWeight: 1.5,
  },
  // Chop: tighter entries, still avoid favorite SL grind
  'scalp': {
    minPrice: 0.40, maxPrice: 0.65,
    tpPctLow: 16, tpPctHigh: 32, slPct: 16,
    adaptiveSl: false, minAdaptiveSlPct: 14,
    partialTpFrac: 0.78, partialSellPct: 0.25,
    trailActivateFrac: 0.8, trailDistanceCap: 8,
    kellyFraction: 0.12, minConfidence: 0.45,
    certaintyMaxPct: 0.2,
    holdToSettleUnderdogs: true,
    holdToSettleFavorites: false,
    underdogMaxPrice: 0.48,
    holdToSettleDisasterSlPct: 45,
    minRemainingSec: 35,
    evalBothSides: true,
    enabledDurations: ['5m', '15m'],
    arbOnlyUntilEdge: false,
    shortTfWeight: 2.0,
  },
  'arb-only': {
    clobArbEnabled: true,
    arbOnlyUntilEdge: true,
    minConfidence: 0.5,
    kellyFraction: 0.1,
    certaintyMaxPct: 0.18,
    minArbGap: 0.012,
    adaptiveSl: false,
    holdToSettleFavorites: false,
  },
};

export const REGIME_LIST = Object.keys(REGIME_PROFILES);

// Keys the governor must never relax while live — the edge-gate owns these.
const LIVE_PROTECTED = new Set(['arbOnlyUntilEdge', 'requireEdgeForLive', 'forceArbOnly']);

const DEFAULTS = {
  cooldownMs: 240_000,      // min gap between switches
  drawdownBreakerPct: 0.12, // equity off-peak → force arb-only
  revertMinTrades: 6,       // trades before judging a switch
  revertPnlThreshold: 0,    // pnl since switch below this → revert
};

let _state = {
  enabled: true,
  llmEnabled: true,
  running: false,
  regime: null,
  profile: null,
  prevProfile: null,
  lastMode: null,
  lastSwitchAt: 0,
  peakEquity: null,
  peakEquityByMode: { paper: null, live: null },
  breakerActive: false,
  breakerActiveByMode: { paper: false, live: false },
  lastResult: null,
  switchBaseline: null, // { profile, at, tradeCount, netPnl }
  cooling: {},          // profile -> untilTs
  history: [],
};

function round(n, d = 2) {
  const m = 10 ** d;
  return Math.round(Number(n || 0) * m) / m;
}

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return fallback; }
}

function saveJson(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export function getGovernorStatus() {
  return {
    enabled: _state.enabled,
    running: _state.running,
    regime: _state.regime,
    profile: _state.profile,
    prevProfile: _state.prevProfile,
    lastMode: _state.lastMode,
    lastSwitchAt: _state.lastSwitchAt,
    breakerActive: _state.breakerActive,
    lastResult: _state.lastResult,
    history: _state.history.slice(0, 12),
    profiles: REGIME_LIST,
    llm: llmStatus(),
  };
}

export function setGovernorEnabled(on) {
  _state.enabled = on !== false;
  return _state.enabled;
}

/** The profile active right now — stamped onto positions at entry for attribution. */
export function getActiveProfile() {
  return _state.profile || null;
}

/**
 * Per-profile performance from closed trades tagged with `governorProfile`.
 * Returns { [profile]: { trades, wins, winRate, pnl } } incl. 'unattributed'.
 */
export function computeProfilePerf(trades = []) {
  const out = {};
  for (const name of [...REGIME_LIST, 'unattributed']) {
    out[name] = { profile: name, trades: 0, wins: 0, pnl: 0, winRate: 0 };
  }
  for (const t of trades) {
    if (!(t.closed || t.exitReason)) continue;
    const key = REGIME_LIST.includes(t.governorProfile) ? t.governorProfile : 'unattributed';
    const row = out[key];
    row.trades += 1;
    if (Number(t.pnl || 0) > 0) row.wins += 1;
    row.pnl += Number(t.pnl || 0);
  }
  for (const row of Object.values(out)) {
    row.winRate = row.trades ? Math.round((row.wins / row.trades) * 1000) / 10 : 0;
    row.pnl = Math.round(row.pnl * 100) / 100;
  }
  return out;
}

/** Heuristic regime from trend strength (ADX) and volatility (ATR%). */
export function detectRegime({ signals = {} } = {}) {
  const sigs = ['btc', 'eth'].map((k) => signals[k]).filter(Boolean);
  const adxVals = sigs.map((s) => Number(s?.adx?.adx ?? s?.adx ?? 0)).filter((n) => n > 0);
  const atrVals = sigs.map((s) => Number(s?.volatility?.atrPct ?? 0)).filter((n) => n > 0);
  const avgAdx = adxVals.length ? adxVals.reduce((a, b) => a + b, 0) / adxVals.length : 0;
  const maxAtr = atrVals.length ? Math.max(...atrVals) : 0;
  const trending = sigs.filter((s) => s?.adx?.trend && s.adx.trend !== 'range').length;

  const reasons = [];
  let regime;
  if (maxAtr >= 0.5) {
    regime = 'arb-only';
    reasons.push(`ATR ${round(maxAtr)}% too hot for directional`);
  } else if (avgAdx >= 28 && trending >= 1) {
    regime = 'trend-ride';
    reasons.push(`ADX ${round(avgAdx, 0)} trending (${trending}/2)`);
  } else {
    regime = 'scalp';
    reasons.push(`ADX ${round(avgAdx, 0)} range/chop`);
  }
  return { regime, avgAdx: round(avgAdx, 1), maxAtr: round(maxAtr), trending, reasons };
}

/** Apply a profile overlay via saveConfig; returns true only if something changed. */
function applyProfile(name, { saveConfig, config }) {
  const overlay = REGIME_PROFILES[name];
  if (!overlay || typeof saveConfig !== 'function') return false;
  const patch = { ...overlay };
  // Live safety: never let a profile loosen the edge-gate lock.
  if ((config.mode || 'paper') === 'live') {
    for (const k of LIVE_PROTECTED) {
      if (k in patch && patch[k] === false) delete patch[k];
    }
  }
  const differs = Object.entries(patch).some(([k, v]) => config[k] !== v);
  if (!differs) return false;
  saveConfig(patch);
  return true;
}

function record(entry) {
  const result = { ...entry, at: Date.now() };
  _state.regime = entry.regime;
  _state.lastResult = result;
  if (entry.changed) {
    _state.history = [result, ..._state.history].slice(0, 40);
  }
  saveJson(GOV_FILE, {
    enabled: _state.enabled,
    profile: _state.profile,
    prevProfile: _state.prevProfile,
    regime: _state.regime,
    lastMode: _state.lastMode,
    lastSwitchAt: _state.lastSwitchAt,
    breakerActive: _state.breakerActive,
    peakEquity: _state.peakEquity,
    peakEquityByMode: _state.peakEquityByMode,
    breakerActiveByMode: _state.breakerActiveByMode,
    lastResult: result,
    history: _state.history.slice(0, 20),
  });
  return result;
}

async function llmChooseProfile({ detected, perf, closed }) {
  if (!process.env.OPENROUTER_API_KEY) return null;
  const wins = closed.filter((t) => (t.pnl || 0) > 0).length;
  const wr = closed.length ? wins / closed.length : 0;
  const prompt = [
    'Pick ONE trading regime profile for a 5-15m BTC/ETH up/down prediction-market bot.',
    `Options: ${REGIME_LIST.join(', ')}.`,
    'trend-ride = strong directional trend, ride winners with wider TP.',
    'scalp = chop/range, take quick small profits, tighter stops.',
    'arb-only = high volatility or uncertainty, riskless CLOB arb only.',
    `Heuristic detected: ${detected.regime} (ADX ${detected.avgAdx}, ATR ${detected.maxAtr}%, trending ${detected.trending}/2).`,
    `Recent: ${closed.length} trades, win rate ${(wr * 100).toFixed(0)}%, net $${round(perf.netPnl)}, equity $${round(perf.equity)}.`,
    'Prefer the heuristic unless recent performance clearly argues otherwise.',
    'Reply ONLY compact JSON: {"profile":"scalp|trend-ride|arb-only","reason":"one short line"}',
  ].join('\n');

  const res = await chat(prompt, 'You are a market-regime classifier for a trading bot. Output JSON only.');
  if (!res.text) return null;
  const s = res.text.indexOf('{');
  const e = res.text.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  let parsed;
  try { parsed = JSON.parse(res.text.slice(s, e + 1)); } catch { return null; }
  if (!REGIME_LIST.includes(parsed.profile)) return null;
  return { profile: parsed.profile, reason: String(parsed.reason || '').slice(0, 120), model: res.model };
}

/**
 * One governor tick. deps: { config, signals, portfolio, trades, saveConfig, log, useLlm }
 */
export async function runGovernor({
  config = {}, signals = {}, portfolio = {}, trades = [], saveConfig, log, useLlm = true,
} = {}) {
  if (_state.running) return { skipped: 'busy' };
  if (_state.enabled === false || config.governorEnabled === false) return { skipped: 'disabled' };
  _state.running = true;
  try {
    const mode = config.mode || 'paper';
    const now = Date.now();
    const equity = Number(portfolio.equity ?? 0);
    if (_state.lastMode !== mode) {
      _state.lastMode = mode;
      _state.breakerActive = Boolean(_state.breakerActiveByMode?.[mode]);
      _state.peakEquity = _state.peakEquityByMode?.[mode] ?? null;
    }
    const peakByMode = { paper: null, live: null, ...(_state.peakEquityByMode || {}) };
    if (equity > 0 && (peakByMode[mode] == null || equity > peakByMode[mode])) {
      peakByMode[mode] = equity;
    }
    _state.peakEquityByMode = peakByMode;
    _state.peakEquity = peakByMode[mode];

    const closed = (trades || []).filter((t) => (t.closed || t.exitReason) && (t.mode || mode) === mode);
    const perf = { equity, netPnl: Number(portfolio.netPnl ?? 0) };
    const detected = detectRegime({ signals });

    // --- Drawdown circuit-breaker (overrides everything) ---
    const breakerPct = Number(config.governorDrawdownPct ?? DEFAULTS.drawdownBreakerPct);
    const modePeak = Number(_state.peakEquityByMode?.[mode] ?? 0);
    const dd = modePeak > 0 ? (modePeak - equity) / modePeak : 0;
    if (dd >= breakerPct) {
      const changed = applyProfile('arb-only', { saveConfig, config });
      if (changed || _state.profile !== 'arb-only') {
        _state.prevProfile = _state.profile;
        _state.profile = 'arb-only';
        _state.lastSwitchAt = now;
        _state.switchBaseline = { profile: 'arb-only', at: now, tradeCount: closed.length, netPnl: perf.netPnl };
      }
      _state.breakerActiveByMode = {
        paper: false,
        live: false,
        ...(_state.breakerActiveByMode || {}),
        [mode]: true,
      };
      _state.breakerActive = true;
      const res = record({ action: 'breaker', regime: 'arb-only', reasons: [`drawdown ${round(dd * 100, 1)}% ≥ ${round(breakerPct * 100, 0)}% off peak`], changed, mode, source: 'guardrail' });
      if (changed && log) log(`⛔ GOVERNOR drawdown breaker → arb-only (${round(dd * 100, 1)}% off peak)`, 'system', res);
      return res;
    }
    if (_state.breakerActiveByMode?.[mode] && dd < breakerPct * 0.5) {
      _state.breakerActiveByMode = {
        paper: false,
        live: false,
        ...(_state.breakerActiveByMode || {}),
        [mode]: false,
      };
      _state.breakerActive = false;
    }

    // --- Auto-revert: did the last switch bleed? ---
    if (_state.switchBaseline && _state.prevProfile && _state.prevProfile !== _state.profile) {
      const b = _state.switchBaseline;
      const nSince = closed.length - b.tradeCount;
      const pnlSince = perf.netPnl - b.netPnl;
      const revertN = Number(config.governorRevertTrades ?? DEFAULTS.revertMinTrades);
      if (nSince >= revertN) {
        if (pnlSince < Number(config.governorRevertPnl ?? DEFAULTS.revertPnlThreshold)) {
          const revertTo = _state.prevProfile;
          const changed = applyProfile(revertTo, { saveConfig, config });
          _state.cooling[_state.profile] = now + Number(config.governorCooldownMs ?? DEFAULTS.cooldownMs) * 2;
          const from = _state.profile;
          _state.profile = revertTo;
          _state.prevProfile = from;
          _state.lastSwitchAt = now;
          _state.switchBaseline = null;
          const res = record({ action: 'revert', regime: revertTo, reasons: [`${from} lost $${round(pnlSince)} over ${nSince} trades — revert to ${revertTo}`], changed, mode, source: 'guardrail' });
          if (log) log(`↩️ GOVERNOR revert ${from}→${revertTo} (PnL $${round(pnlSince)}/${nSince}t)`, 'system', res);
          return res;
        }
        _state.switchBaseline = null; // switch proved out — stop watching
      }
    }

    // --- Cooldown ---
    const cooldownMs = Number(config.governorCooldownMs ?? DEFAULTS.cooldownMs);
    if (_state.profile && now - _state.lastSwitchAt < cooldownMs) {
      return record({ action: 'hold', regime: _state.profile, reasons: [`cooldown ${Math.ceil((cooldownMs - (now - _state.lastSwitchAt)) / 1000)}s`], changed: false, mode, detected: detected.regime });
    }

    // --- Choose target: heuristic, optionally LLM-arbitrated ---
    let target = detected.regime;
    let reasons = [...detected.reasons];
    let source = 'heuristic';
    let model = null;
    if (useLlm && _state.llmEnabled) {
      const llm = await llmChooseProfile({ detected, perf, closed }).catch(() => null);
      if (llm && REGIME_LIST.includes(llm.profile)) {
        target = llm.profile;
        reasons = [llm.reason, ...detected.reasons].filter(Boolean);
        source = 'llm';
        model = llm.model;
      }
    }
    // Respect cooling — don't immediately re-pick a just-reverted profile.
    if (_state.cooling[target] && now < _state.cooling[target] && _state.profile) {
      reasons.unshift(`${target} cooling — hold ${_state.profile}`);
      target = _state.profile;
    }

    if (target === _state.profile) {
      return record({ action: 'hold', regime: target, reasons, changed: false, mode, source, model, detected: detected.regime });
    }

    const changed = applyProfile(target, { saveConfig, config });
    if (changed) {
      _state.prevProfile = _state.profile;
      _state.profile = target;
      _state.lastSwitchAt = now;
      _state.switchBaseline = { profile: target, at: now, tradeCount: closed.length, netPnl: perf.netPnl };
    }
    const res = record({ action: 'switch', regime: target, reasons, changed, mode, source, model, detected: detected.regime });
    if (changed && log) log(`🧭 GOVERNOR ${source === 'llm' ? '(LLM) ' : ''}regime → ${target} · ${(reasons[0] || '').slice(0, 90)}`, 'system', res);
    return res;
  } finally {
    _state.running = false;
  }
}

// Restore persisted governor memory on boot.
(() => {
  const disk = loadJson(GOV_FILE, null);
  if (disk) {
    _state.enabled = disk.enabled !== false;
    _state.profile = disk.profile ?? null;
    _state.prevProfile = disk.prevProfile ?? null;
    _state.regime = disk.regime ?? null;
    _state.lastMode = disk.lastMode ?? null;
    _state.lastSwitchAt = disk.lastSwitchAt ?? 0;
    _state.breakerActive = Boolean(disk.breakerActive);
    _state.peakEquity = Number.isFinite(Number(disk.peakEquity)) ? Number(disk.peakEquity) : null;
    _state.peakEquityByMode = {
      paper: Number.isFinite(Number(disk?.peakEquityByMode?.paper)) ? Number(disk.peakEquityByMode.paper) : null,
      live: Number.isFinite(Number(disk?.peakEquityByMode?.live)) ? Number(disk.peakEquityByMode.live) : null,
    };
    _state.breakerActiveByMode = {
      paper: Boolean(disk?.breakerActiveByMode?.paper),
      live: Boolean(disk?.breakerActiveByMode?.live),
    };
    _state.lastResult = disk.lastResult ?? null;
    _state.history = Array.isArray(disk.history) ? disk.history : [];
  }
})();
