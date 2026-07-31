// @ts-nocheck
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../../data');
const SAMPLES_FILE = path.join(DATA_DIR, 'trade_samples.json');
const OPTIMIZED_FILE = path.join(DATA_DIR, 'heuristics_optimized.json');
const SCRIPTS_DIR = path.resolve(__dirname, '../../../scripts');

let _samples = null;
let _optimized = null;
let _optimizedLoaded = 0;
let _pendingTrain = 0;

function loadSamples() {
  if (_samples) return _samples;
  try {
    _samples = JSON.parse(fs.readFileSync(SAMPLES_FILE, 'utf-8'));
  } catch {
    _samples = [];
  }
  return _samples;
}

function saveSamples() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = SAMPLES_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(_samples, null, 2), 'utf-8');
    fs.renameSync(tmp, SAMPLES_FILE);
  } catch (err) {
    console.error('Failed to save trade samples:', err.message);
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

export function recordTradeSample(trade) {
  if (!trade) return;
  const samples = loadSamples();
  const slug = trade.slug || '';
  const sample = {
    ts: Date.now(),
    asset: String(trade.asset || trade.symbol || '').toUpperCase() || 'BTC',
    slug,
    duration: trade.duration || durationFromSlug(slug),
    entryPrice: Number(trade.entryPrice || trade.entry || 0),
    exitPrice: Number(trade.exitPrice || trade.exit || trade.mark || 0),
    pnl: Number(trade.pnl || 0),
    grossPnl: Number(trade.grossPnl || 0),
    fees: Number(trade.feesPaid || trade.entryFee || 0),
    confidence: Number(trade.confidence || trade.signal?.confidence || 0),
    direction: trade.outcome || trade.direction || null,
    exitReason: trade.reason || trade.exitReason || null,
    mode: trade.mode || 'paper',
    governorProfile: trade.governorProfile || null,
    confBucket: confBucket(trade.confidence || trade.signal?.confidence),
    priceBand: priceBand(trade.entryPrice || trade.entry),
  };
  samples.push(sample);
  _samples = samples;
  _pendingTrain++;

  if (_pendingTrain >= 5) {
    saveSamples();
    triggerPythonTrain().catch(() => {});
    _pendingTrain = 0;
  }
}

function loadOptimized() {
  if (_optimized && Date.now() - _optimizedLoaded < 30000) return _optimized;
  try {
    _optimized = JSON.parse(fs.readFileSync(OPTIMIZED_FILE, 'utf-8'));
    _optimizedLoaded = Date.now();
  } catch {
    _optimized = null;
  }
  return _optimized;
}

export function getAdaptiveParams({ duration = '5m', confidence, entryPrice, symbol = 'BTC' } = {}) {
  const opt = loadOptimized();
  if (!opt) return null;

  const dur = String(duration).toLowerCase().replace('60m', '1h');
  const conf = Number(confidence);
  const cb = confBucket(conf);
  const pb = priceBand(Number(entryPrice));
  const sym = String(symbol).toUpperCase();
  const key = `${dur}|${cb}|${pb}|${sym}`;

  const stratum = opt.strata?.[key];
  const durationPol = opt.durationPolicies?.[dur];
  const regime = opt.currentRegime;

  const params = {};
  if (stratum?.n >= 3) {
    if (stratum.kellyFraction != null) params.kellyFraction = stratum.kellyFraction;
    if (stratum.maxPositionPct != null) params.maxPositionPct = stratum.maxPositionPct;
    if (stratum.minConfidence != null) params.minConfidence = stratum.minConfidence;
    if (stratum.tpPctLow != null) params.tpPctLow = stratum.tpPctLow;
    if (stratum.tpPctHigh != null) params.tpPctHigh = stratum.tpPctHigh;
    if (stratum.slPct != null) params.slPct = stratum.slPct;
  }

  if (durationPol && stratum?.n < 3) {
    if (durationPol.kellyFraction != null && params.kellyFraction == null) params.kellyFraction = durationPol.kellyFraction;
    if (durationPol.maxPositionPct != null && params.maxPositionPct == null) params.maxPositionPct = durationPol.maxPositionPct;
    if (durationPol.minConfidence != null && params.minConfidence == null) params.minConfidence = durationPol.minConfidence;
    if (durationPol.tpPctLow != null && params.tpPctLow == null) params.tpPctLow = durationPol.tpPctLow;
    if (durationPol.tpPctHigh != null && params.tpPctHigh == null) params.tpPctHigh = durationPol.tpPctHigh;
    if (durationPol.slPct != null && params.slPct == null) params.slPct = durationPol.slPct;
  }

  if (regime) {
    params.regime = regime.label || regime.name || null;
    params.regimeProfile = regime.profile || null;
  }

  const global = opt.global;
  if (global && Object.keys(params).length === 0) {
    if (global.kellyFraction != null) params.kellyFraction = global.kellyFraction;
    if (global.maxPositionPct != null) params.maxPositionPct = global.maxPositionPct;
    if (global.minConfidence != null) params.minConfidence = global.minConfidence;
  }

  return Object.keys(params).length > 0 ? params : null;
}

let _training = false;

export async function triggerPythonTrain() {
  if (_training) return;
  _training = true;
  try {
    const script = path.join(SCRIPTS_DIR, 'train_heuristics.py');
    if (!fs.existsSync(script)) {
      _training = false;
      return;
    }
    await new Promise((resolve, reject) => {
      const proc = spawn('python3', [script], {
        cwd: path.resolve(__dirname, '../../..'),
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30000,
      });
      let out = '';
      proc.stdout.on('data', (d) => { out += d.toString(); });
      proc.stderr.on('data', (d) => { out += d.toString(); });
      proc.on('close', (code) => {
        if (code !== 0) console.error(`heuristics train exited ${code}: ${out.slice(0, 200)}`);
        resolve();
      });
      proc.on('error', (err) => {
        console.error('heuristics train spawn error:', err.message);
        resolve();
      });
    });
    _optimized = null;
    _optimizedLoaded = 0;
  } finally {
    _training = false;
  }
}

export function getTradeSampleCount() {
  return loadSamples().length;
}
