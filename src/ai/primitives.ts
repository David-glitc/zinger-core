// @ts-nocheck
/**
 * LLM / operator primitives — hot-update strategy knobs while the bot runs.
 * All numeric patches are clamped to BOUNDS.
 */
import { llmStatus } from './llm.js';

export const STRATEGY_BOUNDS = {
  kellyFraction: [0.15, 0.85],
  slPct: [5, 22],
  tpPctLow: [6, 28],
  tpPctHigh: [12, 55],
  minConfidence: [0.15, 0.55],
  partialTpFrac: [0.6, 0.92],
  partialSellPct: [0.15, 0.45],
  maxPositionPct: [0.1, 0.55],
  minAdaptiveSlPct: [4, 8],
  aggScaleMultiplier: [1.0, 2.2],
  maxOpenPositions: [2, 12],
  maxConcurrentPerSlug: [1, 3],
  minArbGap: [0.008, 0.05],
  arbExploreRate: [0, 0.35],
  sideBalanceWeight: [0, 40],
  shortTfWeight: [0.5, 3],
  optimizeIntervalMs: [60000, 600000],
};

const BOOL_KEYS = new Set([
  'adaptiveSl',
  'llmOptimize',
  'clobArbEnabled',
  'sideBalanceEnabled',
  'evalBothSides',
  'useSignals',
  'useML',
  'useOrderBookBias',
  'requireTightSpread',
  'useKellySizing',
  'useAggressiveScaling',
  'autoApprovePaper',
  'autoApproveLive',
  'announceBeforeTrade',
  'enabled',
]);

const MODE_KEYS = new Set(['mode']);

function clamp(v, [lo, hi]) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.max(lo, Math.min(hi, n)) * 1000) / 1000;
}

export function listPrimitives() {
  return [
    { name: 'update_config', args: '{ key: value, ... }', desc: 'Patch strategy knobs within bounds' },
    { name: 'tighten_risk', args: '{}', desc: 'Preset: lower Kelly, tighter SL, higher conf' },
    { name: 'loosen_risk', args: '{}', desc: 'Preset: raise Kelly slightly, wider TP' },
    { name: 'enable_arb', args: '{ minArbGap? }', desc: 'Turn on CLOB UP+DOWN arb exploit' },
    { name: 'disable_arb', args: '{}', desc: 'Turn off CLOB arb' },
    { name: 'balance_sides', args: '{ weight? }', desc: 'Penalize over-traded UP/DOWN side' },
    { name: 'short_tf_focus', args: '{ weight? }', desc: 'Emphasize 1m/5m over long-range trend' },
    { name: 'optimize', args: '{ useLlm? }', desc: 'Run heuristic(+LLM) optimizer now' },
    { name: 'pause_bot', args: '{}', desc: 'Stop scanning' },
    { name: 'resume_bot', args: '{}', desc: 'Start scanning' },
    { name: 'set_mode', args: '{ mode: paper|live }', desc: 'Switch paper/live' },
  ];
}

export function sanitizeConfigPatch(patch = {}) {
  const out = {};
  const rejected = [];
  for (const [k, v] of Object.entries(patch || {})) {
    if (STRATEGY_BOUNDS[k]) {
      const c = clamp(v, STRATEGY_BOUNDS[k]);
      if (c == null) rejected.push(k);
      else out[k] = c;
    } else if (BOOL_KEYS.has(k)) {
      out[k] = Boolean(v);
    } else if (MODE_KEYS.has(k) && (v === 'paper' || v === 'live')) {
      out[k] = v;
    } else {
      rejected.push(k);
    }
  }
  return { patch: out, rejected };
}

/**
 * Execute one or more primitive actions.
 * deps: { saveConfig, startBot, stopBot, optimizeNow, getConfig, log }
 */
export async function runPrimitives(actions, deps = {}) {
  const results = [];
  const list = Array.isArray(actions) ? actions : [actions];

  for (const raw of list) {
    if (!raw || !raw.name) continue;
    const name = String(raw.name);
    const args = raw.args || raw.params || {};
    try {
      const r = await runOne(name, args, deps);
      results.push({ name, ok: true, ...r });
      if (deps.log) deps.log(`🧠 LLM primitive ${name} · ${r.summary || 'ok'}`, 'system', r);
    } catch (e) {
      results.push({ name, ok: false, error: e.message });
    }
  }
  return {
    ok: results.every((r) => r.ok),
    results,
    llm: llmStatus(),
    primitives: listPrimitives(),
  };
}

async function runOne(name, args, deps) {
  const cfg = typeof deps.getConfig === 'function' ? deps.getConfig() : {};

  switch (name) {
    case 'update_config': {
      const { patch, rejected } = sanitizeConfigPatch(args);
      if (!Object.keys(patch).length) return { summary: 'no valid keys', rejected };
      deps.saveConfig?.(patch);
      return { summary: `patched ${Object.keys(patch).join(',')}`, patch, rejected };
    }
    case 'tighten_risk': {
      const patch = sanitizeConfigPatch({
        kellyFraction: Math.max(0.2, (cfg.kellyFraction ?? 0.5) - 0.08),
        slPct: Math.max(5, (cfg.slPct ?? 10) - 1.5),
        minConfidence: Math.min(0.5, (cfg.minConfidence ?? 0.25) + 0.04),
        minAdaptiveSlPct: 5,
        adaptiveSl: true,
        partialTpFrac: Math.min(0.9, (cfg.partialTpFrac ?? 0.82) + 0.04),
      }).patch;
      deps.saveConfig?.(patch);
      return { summary: 'risk tightened', patch };
    }
    case 'loosen_risk': {
      const patch = sanitizeConfigPatch({
        kellyFraction: Math.min(0.75, (cfg.kellyFraction ?? 0.5) + 0.05),
        tpPctHigh: Math.min(50, (cfg.tpPctHigh ?? 22) + 3),
        minConfidence: Math.max(0.18, (cfg.minConfidence ?? 0.25) - 0.02),
      }).patch;
      deps.saveConfig?.(patch);
      return { summary: 'risk loosened', patch };
    }
    case 'enable_arb': {
      const patch = sanitizeConfigPatch({
        clobArbEnabled: true,
        minArbGap: args.minArbGap ?? cfg.minArbGap ?? 0.015,
        arbExploreRate: args.arbExploreRate ?? cfg.arbExploreRate ?? 0.12,
        maxConcurrentPerSlug: 2,
      }).patch;
      deps.saveConfig?.({ ...patch, clobArbEnabled: true });
      return { summary: 'CLOB arb enabled', patch };
    }
    case 'disable_arb': {
      deps.saveConfig?.({ clobArbEnabled: false });
      return { summary: 'CLOB arb disabled' };
    }
    case 'balance_sides': {
      const patch = sanitizeConfigPatch({
        sideBalanceEnabled: true,
        sideBalanceWeight: args.weight ?? cfg.sideBalanceWeight ?? 18,
        evalBothSides: true,
      }).patch;
      deps.saveConfig?.({ ...patch, sideBalanceEnabled: true, evalBothSides: true });
      return { summary: 'side balance on', patch };
    }
    case 'short_tf_focus': {
      const patch = sanitizeConfigPatch({
        shortTfWeight: args.weight ?? 2.2,
        evalBothSides: true,
      }).patch;
      deps.saveConfig?.({ ...patch, preferShortTf: true });
      return { summary: 'short TF focus', patch };
    }
    case 'optimize': {
      if (!deps.optimizeNow) return { summary: 'optimizer unavailable' };
      const result = await deps.optimizeNow({
        apply: args.apply !== false,
        useLlm: args.useLlm !== false,
      });
      return { summary: result?.applied ? 'optimized' : 'optimizer ran', result };
    }
    case 'pause_bot': {
      deps.stopBot?.();
      return { summary: 'bot paused' };
    }
    case 'resume_bot': {
      deps.startBot?.();
      return { summary: 'bot resumed' };
    }
    case 'set_mode': {
      const mode = args.mode === 'live' ? 'live' : 'paper';
      deps.saveConfig?.({ mode });
      const cfg = deps.getConfig?.() || {};
      const actual = cfg.mode || mode;
      return {
        summary: actual === 'live' ? 'mode live' : (mode === 'live' ? 'live blocked — paper lock (need +expectancy)' : 'mode paper'),
        mode: actual,
      };
    }
    default:
      throw new Error(`unknown primitive: ${name}`);
  }
}

/** Parse LLM text for a JSON actions block. */
export function extractActionsFromText(text) {
  if (!text) return [];
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (Array.isArray(parsed.actions)) return parsed.actions;
    if (parsed.name) return [parsed];
    if (parsed.action) return [{ name: parsed.action, args: parsed.args || parsed }];
    // bare config patch
    if (parsed.kellyFraction != null || parsed.slPct != null || parsed.clobArbEnabled != null) {
      return [{ name: 'update_config', args: parsed }];
    }
  } catch {
    return [];
  }
  return [];
}
