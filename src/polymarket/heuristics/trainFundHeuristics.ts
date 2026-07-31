#!/usr/bin/env node
// @ts-nocheck
/**
 * Heuristic ops trainer — offline fit of Kelly / bands / management knobs
 * from platform traces: trades, actions, session ledger, live_account, session_perf.
 *
 * Output: data/fund_heuristics.json (stratified by duration × conf × price band)
 *
 * Usage:
 *   node src/polymarket/heuristics/trainFundHeuristics.js
 *   node src/polymarket/heuristics/trainFundHeuristics.js --apply
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(__dirname, '../../../data');
const OUT = path.join(DATA, 'fund_heuristics.json');

function loadJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8'));
  } catch {
    return fallback;
  }
}

function durationFromSlug(slug) {
  const m = String(slug || '').match(/-updown-(5m|15m|30m|1h|60m)-/i);
  if (!m) return '5m';
  return m[1].toLowerCase() === '60m' ? '1h' : m[1].toLowerCase();
}

function confBucket(c) {
  const x = Number(c);
  if (!Number.isFinite(x)) return 'unk';
  if (x < 0.35) return 'low';
  if (x < 0.5) return 'mid';
  if (x < 0.65) return 'high';
  return 'vhigh';
}

function priceBand(p) {
  const x = Number(p);
  if (!Number.isFinite(x)) return 'unk';
  if (x < 0.35) return 'dog';
  if (x < 0.45) return 'cheap';
  if (x < 0.55) return 'mid';
  if (x < 0.68) return 'sweet';
  return 'fav';
}

function stratumKey(row) {
  return `${row.duration}|${row.confBucket}|${row.priceBand}|${row.symbol}`;
}

function summarize(rows) {
  if (!rows.length) return null;
  const wins = rows.filter((r) => r.pnl > 0).length;
  const losses = rows.length - wins;
  const totalPnl = rows.reduce((s, r) => s + r.pnl, 0);
  const avgPnl = totalPnl / rows.length;
  const wr = wins / rows.length;
  const avgWin = wins ? rows.filter((r) => r.pnl > 0).reduce((s, r) => s + r.pnl, 0) / wins : 0;
  const avgLoss = losses
    ? Math.abs(rows.filter((r) => r.pnl <= 0).reduce((s, r) => s + r.pnl, 0) / losses)
    : 0;
  const expectancy = wr * avgWin - (1 - wr) * avgLoss;
  // Kelly fraction of bankroll (edge / odds) using avg win/loss as proxy
  const b = avgLoss > 0 ? avgWin / avgLoss : 0;
  const kellyRaw = b > 0 ? wr - (1 - wr) / b : 0;
  const kellyFraction = Math.max(0.05, Math.min(0.85, kellyRaw > 0 ? kellyRaw * 0.5 : 0.08));
  const maxPositionPct = expectancy > 0
    ? Math.max(0.04, Math.min(0.25, 0.06 + expectancy * 0.02))
    : 0.04;
  const minConfidence = wr >= 0.55 ? 0.32 : wr >= 0.45 ? 0.38 : 0.45;
  return {
    n: rows.length,
    wins,
    losses,
    wr: Math.round(wr * 1000) / 1000,
    avgPnl: Math.round(avgPnl * 100) / 100,
    expectancy: Math.round(expectancy * 1000) / 1000,
    kellyFraction: Math.round(kellyFraction * 1000) / 1000,
    maxPositionPct: Math.round(maxPositionPct * 1000) / 1000,
    minConfidence: Math.round(minConfidence * 100) / 100,
    suggested:
      expectancy > 0.5 ? 'scale_up'
        : expectancy > 0 ? 'base'
          : 'defensive',
  };
}

function main() {
  const trades = loadJson('poly_trades.json', []);
  const live = loadJson('live_account.json', {});
  const sessionPerf = loadJson('session_perf.json', []);
  const actions = loadJson('poly_actions.json', []);

  const rows = [];
  for (const t of trades) {
    if (!t || t.exitPrice == null) continue;
    const pnl = Number(t.pnl || 0);
    const conf = t.signal?.confidence ?? t.lastSignalConfidence ?? null;
    rows.push({
      source: 'trade',
      mode: t.mode || 'paper',
      symbol: String(t.symbol || '').toUpperCase() || 'BTC',
      slug: t.slug,
      duration: t.duration || durationFromSlug(t.slug),
      entryPrice: Number(t.entryPrice),
      exitPrice: Number(t.exitPrice),
      pnl,
      confBucket: confBucket(conf),
      priceBand: priceBand(t.entryPrice),
      exitReason: t.exitReason || null,
      governorProfile: t.governorProfile || null,
      confidence: conf,
    });
  }

  // PM closed-positions as additional labels (ground truth for live)
  for (const c of live.closed || []) {
    rows.push({
      source: 'pm_closed',
      mode: 'live',
      symbol: String(c.slug || '').includes('eth') ? 'ETH' : 'BTC',
      slug: c.slug,
      duration: durationFromSlug(c.slug),
      entryPrice: Number(c.avgPrice),
      exitPrice: 1,
      pnl: Number(c.realizedPnl || 0),
      confBucket: 'unk',
      priceBand: priceBand(c.avgPrice),
      exitReason: 'settle',
      governorProfile: null,
      confidence: null,
    });
  }

  const byStratum = new Map();
  for (const r of rows) {
    const k = stratumKey(r);
    if (!byStratum.has(k)) byStratum.set(k, []);
    byStratum.get(k).push(r);
  }

  const strata = {};
  for (const [k, list] of byStratum.entries()) {
    if (list.length < 3) continue;
    const stats = summarize(list);
    if (stats) strata[k] = stats;
  }

  // Duration-level rollups (always useful even with sparse strata)
  const byDuration = {};
  for (const r of rows) {
    const d = r.duration || '5m';
    if (!byDuration[d]) byDuration[d] = [];
    byDuration[d].push(r);
  }
  const durationPolicies = {};
  for (const [d, list] of Object.entries(byDuration)) {
    const stats = summarize(list);
    if (!stats) continue;
    durationPolicies[d] = {
      ...stats,
      // Scale entry window with duration
      maxEntryRemainingSec: d === '5m' ? 270 : d === '15m' ? 800 : d === '30m' ? 1600 : 3200,
      minRemainingSec: d === '5m' ? 25 : d === '15m' ? 60 : d === '30m' ? 120 : 180,
      // Longer books → wider TP / looser SL
      tpPctLow: d === '5m' ? 18 : d === '15m' ? 14 : 12,
      tpPctHigh: d === '5m' ? 40 : d === '15m' ? 36 : 30,
      slPct: d === '5m' ? 14 : d === '15m' ? 16 : 18,
      mlLadder: d === '5m' || d === '15m' ? 'short' : 'long',
    };
  }
  // Always seed priors for books we trade (or will trade) so entry windows aren't 5m-only
  const PRIORS = {
    '5m': { maxEntryRemainingSec: 270, minRemainingSec: 25, tpPctLow: 18, tpPctHigh: 40, slPct: 14, kellyFraction: 0.1, maxPositionPct: 0.12, minConfidence: 0.38, mlLadder: 'short', suggested: 'prior' },
    '15m': { maxEntryRemainingSec: 800, minRemainingSec: 60, tpPctLow: 14, tpPctHigh: 36, slPct: 16, kellyFraction: 0.09, maxPositionPct: 0.12, minConfidence: 0.4, mlLadder: 'short', suggested: 'prior' },
    '30m': { maxEntryRemainingSec: 1600, minRemainingSec: 120, tpPctLow: 12, tpPctHigh: 30, slPct: 18, kellyFraction: 0.08, maxPositionPct: 0.1, minConfidence: 0.42, mlLadder: 'long', suggested: 'prior' },
    '1h': { maxEntryRemainingSec: 3200, minRemainingSec: 180, tpPctLow: 12, tpPctHigh: 28, slPct: 18, kellyFraction: 0.07, maxPositionPct: 0.1, minConfidence: 0.45, mlLadder: 'long', suggested: 'prior' },
  };
  for (const [d, prior] of Object.entries(PRIORS)) {
    if (!durationPolicies[d]) durationPolicies[d] = { n: 0, ...prior };
  }

  // Exit-reason mix from actions (management heuristics)
  const exitMix = {};
  for (const a of actions.slice(0, 500)) {
    const reason = a?.meta?.exitReason || a?.type;
    if (!reason) continue;
    exitMix[reason] = (exitMix[reason] || 0) + 1;
  }

  const payload = {
    generatedAt: Date.now(),
    version: 1,
    sample: {
      trades: trades.length,
      rows: rows.length,
      strata: Object.keys(strata).length,
      sessionPerfCycles: Array.isArray(sessionPerf) ? sessionPerf.length : 0,
    },
    durationPolicies,
    strata,
    exitMix,
    global: summarize(rows) || null,
    notes: [
      'Train on Kelly outcomes, price bands, confidence, signals, PM closed, session/actions traces.',
      'Apply via loadFundHeuristics() in resolveOrderSize / optimizer seed.',
      'Re-run nightly or after live sessions: node src/polymarket/heuristics/trainFundHeuristics.js',
    ],
  };

  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
  console.log(`Wrote ${OUT}`);
  console.log('durations', Object.keys(durationPolicies));
  console.log('strata', Object.keys(strata).length, 'global', payload.global);

  if (process.argv.includes('--apply')) {
    console.log('Heuristics file ready for bot loadFundHeuristics()');
  }
}

main();
