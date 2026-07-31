// @ts-nocheck
import fs from 'fs';
import path from 'path';
import { chat, llmStatus } from './llm.js';

const DATA_DIR = path.resolve(import.meta.dirname, '../../data');
const PERF_FILE = path.join(DATA_DIR, 'session_perf.json');
const OPT_FILE = path.join(DATA_DIR, 'optimizer_state.json');

const BOUNDS = {
  kellyFraction: [0.1, 0.35],
  slPct: [12, 22],
  tpPctLow: [16, 28],
  tpPctHigh: [28, 48],
  minConfidence: [0.32, 0.48],
  partialTpFrac: [0.72, 0.92],
  partialSellPct: [0.2, 0.35],
  trailActivateFrac: [0.65, 0.85],
  maxPositionPct: [0.10, 0.25],
  minAdaptiveSlPct: [7, 12],
  aggScaleMultiplier: [1.0, 1.2],
  minArbGap: [0.012, 0.04],
  arbExploreRate: [0, 0.15],
  sideBalanceWeight: [0, 18],
  shortTfWeight: [0.5, 3],
};

let _state = {
  lastRunAt: null,
  lastApplyAt: null,
  lastResult: null,
  running: false,
  enabled: true,
  llmEnabled: true,
};

function clamp(v, [lo, hi]) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.max(lo, Math.min(hi, n)) * 1000) / 1000;
}

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return fallback;
  }
}

function saveJson(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export function getOptimizerStatus() {
  const disk = loadJson(OPT_FILE, {});
  return { ..._state, ...disk, llm: llmStatus(), bounds: BOUNDS };
}

export function loadSessionPerf() {
  return loadJson(PERF_FILE, { sessions: [], updatedAt: null });
}

export function saveSessionPerf(entry) {
  const store = loadSessionPerf();
  const row = {
    id: Date.now().toString(36),
    ...entry,
    timestamp: new Date().toISOString(),
  };
  store.sessions = [row, ...(store.sessions || [])].slice(0, 200);
  store.updatedAt = Date.now();
  saveJson(PERF_FILE, store);
  return row;
}

function exitMix(trades) {
  const closed = (trades || []).filter((t) => t.closed || t.exitReason);
  const counts = {};
  for (const t of closed.slice(0, 80)) {
    const r = t.exitReason || 'unknown';
    counts[r] = (counts[r] || 0) + 1;
  }
  return { total: closed.length, counts };
}

/** Fast heuristic — no LLM. Returns patch + reasons. */
export function heuristicOptimize(state) {
  const cfg = state?.config || {};
  const trades = (state?.trades || []).filter((t) => (t.mode || cfg.mode) === (cfg.mode || 'paper'));
  const closed = trades.filter((t) => t.closed || t.exitReason).slice(0, 40);
  if (closed.length < 4) {
    return { patch: {}, reasons: ['Need ≥4 closed trades in mode before auto-tune'], source: 'heuristic' };
  }

  const wins = closed.filter((t) => (t.pnl || 0) > 0);
  const losses = closed.filter((t) => (t.pnl || 0) <= 0);
  const winRate = wins.length / closed.length;
  const avgWin = wins.length ? wins.reduce((s, t) => s + (t.pnl || 0), 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, t) => s + Math.abs(t.pnl || 0), 0) / losses.length : 0;
  const mix = exitMix(closed);
  const partialShare = (mix.counts.partial || 0) / Math.max(1, mix.total);
  const slShare = (mix.counts.sl || 0) / Math.max(1, mix.total);
  const settleShare = (mix.counts.settle || 0) / Math.max(1, mix.total);

  const patch = {};
  const reasons = [];

  if (partialShare > 0.35) {
    patch.partialTpFrac = clamp((cfg.partialTpFrac ?? 0.72) + 0.06, BOUNDS.partialTpFrac);
    patch.partialSellPct = clamp((cfg.partialSellPct ?? 0.35) - 0.05, BOUNDS.partialSellPct);
    reasons.push(`Partials ${(partialShare * 100).toFixed(0)}% of exits — delay + shrink`);
  }

  if (slShare > 0.4 || (winRate < 0.4 && avgLoss > avgWin)) {
    patch.slPct = clamp((cfg.slPct ?? 14) + 1.5, BOUNDS.slPct);
    patch.minAdaptiveSlPct = clamp(Math.max(cfg.minAdaptiveSlPct ?? 10, 10), BOUNDS.minAdaptiveSlPct);
    patch.adaptiveSl = false;
    reasons.push(`SL pressure ${(slShare * 100).toFixed(0)}% / WR ${(winRate * 100).toFixed(0)}% — widen stop; disable adaptive tightening`);
  }

  if (winRate >= 0.55 && avgWin > 0) {
    patch.kellyFraction = clamp((cfg.kellyFraction ?? 0.5) + 0.05, BOUNDS.kellyFraction);
    patch.maxPositionPct = clamp((cfg.maxPositionPct ?? 0.5) + 0.03, BOUNDS.maxPositionPct);
    reasons.push(`Edge WR ${(winRate * 100).toFixed(0)}% — nudge Kelly/size up`);
  } else if (winRate < 0.38) {
    patch.kellyFraction = clamp((cfg.kellyFraction ?? 0.5) - 0.08, BOUNDS.kellyFraction);
    patch.minConfidence = clamp((cfg.minConfidence ?? 0.22) + 0.03, BOUNDS.minConfidence);
    reasons.push(`Weak WR ${(winRate * 100).toFixed(0)}% — cut Kelly, raise conf gate`);
  }

  if (settleShare > 0.45 && winRate < 0.5) {
    patch.tpPctLow = clamp((cfg.tpPctLow ?? 8) - 1, BOUNDS.tpPctLow);
    reasons.push(`Many settles (${(settleShare * 100).toFixed(0)}%) — slightly earlier TP low`);
  }

  // Drop nulls
  for (const k of Object.keys(patch)) {
    if (patch[k] == null) delete patch[k];
  }

  return {
    patch,
    reasons,
    source: 'heuristic',
    stats: { winRate, avgWin, avgLoss, mix, n: closed.length },
  };
}

async function llmOptimize(state, heuristic) {
  if (!process.env.OPENROUTER_API_KEY) {
    return { patch: {}, reasons: ['No OPENROUTER_API_KEY'], source: 'llm-skip' };
  }
  const cfg = state.config || {};
  const portfolio = state.portfolio || {};
  const prompt = [
    'You tune Polymarket 5m bot config. Reply ONLY compact JSON:',
    '{"kellyFraction":n,"slPct":n,"tpPctLow":n,"tpPctHigh":n,"minConfidence":n,"partialTpFrac":n,"partialSellPct":n,"maxPositionPct":n,"minAdaptiveSlPct":n,"reason":"one line"}',
    'Bounds:',
    JSON.stringify(BOUNDS),
    'Current config:',
    JSON.stringify({
      kellyFraction: cfg.kellyFraction,
      slPct: cfg.slPct,
      tpPctLow: cfg.tpPctLow,
      tpPctHigh: cfg.tpPctHigh,
      minConfidence: cfg.minConfidence,
      partialTpFrac: cfg.partialTpFrac,
      partialSellPct: cfg.partialSellPct,
      maxPositionPct: cfg.maxPositionPct,
      minAdaptiveSlPct: cfg.minAdaptiveSlPct,
    }),
    'Heuristic already suggests:',
    JSON.stringify(heuristic.patch),
    `Equity $${Number(portfolio.equity || 0).toFixed(2)} net $${Number(portfolio.netPnl || 0).toFixed(2)}`,
    `Exit mix: ${JSON.stringify(heuristic.stats?.mix || {})}`,
    'Prefer small steps. Never tighten stops when SL share is high. Preserve wider TP targets.',
  ].join('\n');

  const res = await chat(prompt, 'You are a trading-config optimizer. Output JSON only.');
  if (!res.text) return { patch: {}, reasons: [res.error || 'LLM empty'], source: 'llm-fail' };

  const raw = res.text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return { patch: {}, reasons: ['LLM no JSON'], source: 'llm-fail' };

  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return { patch: {}, reasons: ['LLM JSON parse fail'], source: 'llm-fail' };
  }

  const patch = {};
  for (const key of Object.keys(BOUNDS)) {
    if (parsed[key] != null) {
      const v = clamp(parsed[key], BOUNDS[key]);
      if (v != null) patch[key] = v;
    }
  }
  return {
    patch,
    reasons: [parsed.reason || 'LLM patch'].filter(Boolean),
    source: 'llm',
    model: res.model,
  };
}

function mergePatches(...parts) {
  const out = {};
  const reasons = [];
  let source = 'none';
  for (const p of parts) {
    if (!p) continue;
    Object.assign(out, p.patch || {});
    reasons.push(...(p.reasons || []));
    if (p.source) source = p.source;
  }
  return { patch: out, reasons, source };
}

/**
 * Run one optimization tick. Applies bounded patch via saveConfig when apply=true.
 */
export async function runOptimizer({ state, saveConfig, log, apply = true, useLlm = true } = {}) {
  if (_state.running) return { ok: false, skipped: true, reason: 'busy' };
  _state.running = true;
  _state.lastRunAt = Date.now();

  try {
    const heuristic = heuristicOptimize(state);
    let llmPart = null;
    if (useLlm && _state.llmEnabled && Object.keys(heuristic.patch).length > 0) {
      try {
        llmPart = await llmOptimize(state, heuristic);
      } catch (e) {
        llmPart = { patch: {}, reasons: [e.message], source: 'llm-err' };
      }
    }

    // Prefer heuristic; overlay LLM only for keys both agree or LLM fills gaps
    const merged = { ...heuristic.patch };
    if (llmPart?.patch) {
      for (const [k, v] of Object.entries(llmPart.patch)) {
        if (heuristic.patch[k] == null || Math.abs(Number(v) - Number(heuristic.patch[k])) < 0.15) {
          merged[k] = v;
        }
      }
    }

    const before = {};
    const cfg = state.config || {};
    for (const k of Object.keys(merged)) before[k] = cfg[k];

    let applied = false;
    if (apply && Object.keys(merged).length > 0 && typeof saveConfig === 'function') {
      saveConfig({ ...merged, adaptiveSl: true });
      applied = true;
      _state.lastApplyAt = Date.now();
    }

    const result = {
      ok: true,
      applied,
      patch: merged,
      before,
      reasons: [...(heuristic.reasons || []), ...(llmPart?.reasons || [])],
      heuristic: heuristic.stats,
      sources: [heuristic.source, llmPart?.source].filter(Boolean),
      model: llmPart?.model || null,
      at: Date.now(),
    };

    _state.lastResult = result;
    saveJson(OPT_FILE, {
      lastRunAt: _state.lastRunAt,
      lastApplyAt: _state.lastApplyAt,
      lastResult: result,
      enabled: _state.enabled,
    });

    if (applied && log) {
      const keys = Object.keys(merged).join(', ');
      log(`🧠 OPTIMIZER applied [${keys}] · ${(result.reasons[0] || 'tune').slice(0, 120)}`, 'system', {
        patch: merged,
        reasons: result.reasons,
      });
    }

    // Persist session perf snapshot each run
    saveSessionPerf({
      type: 'optimizer',
      mode: cfg.mode,
      equity: state.portfolio?.equity,
      netPnl: state.portfolio?.netPnl,
      realizedPnl: state.portfolio?.realizedPnl,
      winRate: heuristic.stats?.winRate,
      exitMix: heuristic.stats?.mix,
      patch: merged,
      applied,
      configSnapshot: {
        kellyFraction: cfg.kellyFraction,
        slPct: cfg.slPct,
        tpPctLow: cfg.tpPctLow,
        tpPctHigh: cfg.tpPctHigh,
        minConfidence: cfg.minConfidence,
        partialTpFrac: cfg.partialTpFrac,
      },
    });

    return result;
  } finally {
    _state.running = false;
  }
}

export function recordCycleSession(entry) {
  return saveSessionPerf({ type: 'cycle', ...entry });
}
