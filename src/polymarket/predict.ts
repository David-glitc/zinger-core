// @ts-nocheck
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { markModelRunning, markModelSuccess, markModelError, markModelIdle } from './modelRegistry.js';

const ROOT_DIR = path.resolve(import.meta.dirname, '../..');
const ROOT_VENV_PY = path.join(ROOT_DIR, '.venv/bin/python3');
const ML_DIR = path.join(ROOT_DIR, 'ml');
const VENV_PY = path.join(ML_DIR, '.venv/bin/python3');
const PYTHON = process.env.ZINGER_ML_PYTHON
  || (fs.existsSync(ROOT_VENV_PY) ? ROOT_VENV_PY : null)
  || (fs.existsSync(VENV_PY) ? VENV_PY : null)
  || (fs.existsSync('/usr/bin/python3') ? '/usr/bin/python3' : null)
  || 'python3';
const ML_TIMEOUT_MS = 55000;

function modelId(symbol, timeframe, horizon) {
  return `${symbol.toLowerCase()}-${timeframe}-h${horizon}`;
}

function callQuickML(symbol, timeframe, horizon) {
  const id = modelId(symbol, timeframe, horizon);
  const code = `
import sys, json
sys.path.insert(0, ${JSON.stringify(ML_DIR)})
from predict import quick_ml_signal
result = quick_ml_signal(${JSON.stringify(symbol)}, ${JSON.stringify(timeframe)}, ${Number(horizon)})
print(json.dumps(result))
  `;

  markModelRunning(id);

  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (value.error) {
        markModelError(id, value.error);
      } else {
        value._duration = Date.now() - t0;
        markModelSuccess(id, value);
      }
      resolve(value);
    };

    const t0 = Date.now();
    const proc = spawn(PYTHON, ['-c', code], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        OMP_NUM_THREADS: '2',
        MKL_NUM_THREADS: '2',
        OPENBLAS_NUM_THREADS: '2',
        PYTHONUNBUFFERED: '1',
      },
      cwd: ML_DIR,
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      done({ direction: 0, confidence: 0, error: 'timeout' });
    }, ML_TIMEOUT_MS);

    proc.on('error', (err) => {
      done({ direction: 0, confidence: 0, error: err.message });
    });

    proc.on('close', (code) => {
      if (code !== 0 || !stdout.trim()) {
        done({ direction: 0, confidence: 0, error: (stderr || 'no output').slice(0, 240) });
        return;
      }
      try {
        const lines = stdout.trim().split('\n').filter(Boolean);
        done(JSON.parse(lines[lines.length - 1]));
      } catch {
        done({ direction: 0, confidence: 0, error: 'parse error' });
      }
    });
  });
}

function horizonMinutes(timeframe, horizon) {
  const unit = timeframe === '1m' ? 1 : timeframe === '5m' ? 5 : 60;
  return unit * Number(horizon);
}

function normalizePoint(label, minutes, raw) {
  if (!raw || raw.error) return null;
  const direction = raw.direction === 1 || raw.direction === 'up'
    ? 'up'
    : raw.direction === -1 || raw.direction === 'down'
      ? 'down'
      : 'neutral';
  return {
    label,
    minutes,
    direction,
    confidence: Number(raw.confidence || 0),
    expectedReturn: Number(raw.expected_return || 0),
    model: raw.model,
    rawDirection: raw.direction,
  };
}

/** Ladder keyed by Polymarket window duration */
export async function getMLTrace(symbol = 'BTC', marketDuration = '5m') {
  const dur = String(marketDuration || '5m').toLowerCase();
  const ultra = await callQuickML(symbol, '1m', 1).catch(() => ({ error: '1m fail' }));
  const near = await callQuickML(symbol, '5m', 1);
  const mid = await callQuickML(symbol, '5m', 3);
  // Longer books activate longer horizons
  const long = (dur === '30m' || dur === '1h' || dur === '60m')
    ? await callQuickML(symbol, '1h', 1).catch(() => null)
    : null;
  const xl = dur === '1h' || dur === '60m'
    ? await callQuickML(symbol, '1h', 4).catch(() => null)
    : null;

  const priceTrace = [
    normalizePoint('1m', horizonMinutes('1m', 1), ultra?.error ? null : ultra),
    normalizePoint('5m', horizonMinutes('5m', 1), near),
    normalizePoint('15m', horizonMinutes('5m', 3), mid),
    long ? normalizePoint('1h', horizonMinutes('1h', 1), long) : null,
    xl ? normalizePoint('4h', horizonMinutes('1h', 4), xl) : null,
  ].filter(Boolean);

  // Weighted vote — nearer horizons count more; long books weight 1h higher
  let upW = 0;
  let downW = 0;
  let confAcc = 0;
  let confW = 0;
  let retAcc = 0;
  for (const p of priceTrace) {
    let w = 1 / Math.max(1, (p.minutes || 5) / 5);
    if ((dur === '30m' || dur === '1h') && (p.timeframe === '1h' || p.timeframe === '4h')) {
      w *= 1.6;
    }
    if (p.direction === 'up') upW += w * (p.confidence || 0.5);
    else if (p.direction === 'down') downW += w * (p.confidence || 0.5);
    confAcc += (p.confidence || 0) * w;
    confW += w;
    retAcc += (p.expectedReturn || 0) * w;
  }
  const direction = upW === downW ? 0 : upW > downW ? 1 : -1;
  const confidence = confW ? confAcc / confW : 0;
  const expectedReturn = confW ? retAcc / confW : 0;

  return {
    direction,
    confidence,
    expected_return: expectedReturn,
    priceTrace,
    marketDuration: dur,
    timestamp: Date.now(),
    shortLadder: dur === '5m' || dur === '15m',
    error: priceTrace.length === 0
      ? (ultra?.error || near?.error || mid?.error || 'no trace')
      : undefined,
  };
}

export async function getMLSignal(symbol = 'BTC', timeframe = '1h', horizon = 1) {
  const result = await callQuickML(symbol, timeframe, horizon);
  result.timestamp = Date.now();
  return result;
}

export async function getMLSignalForBoth(timeframe = '1h', horizon = 1) {
  const [btc, eth] = await Promise.all([
    callQuickML('BTC', timeframe, horizon),
    callQuickML('ETH', timeframe, horizon),
  ]);
  return { btc, eth };
}

export async function getMLTraceForBoth(marketDuration = '5m') {
  // sequential assets — each runs model ladder for this book duration
  const btc = await getMLTrace('BTC', marketDuration);
  const eth = await getMLTrace('ETH', marketDuration);
  return { btc, eth };
}

/** Call the RL fuser for ensemble-aware signal fusion */
export async function getRLSignal(symbol = 'BTC') {
  const asset = symbol.toUpperCase() === 'BTC' ? 'BTC/USDT' : 'ETH/USDT';
  const code = `
import sys, json
sys.path.insert(0, ${JSON.stringify(ML_DIR)})
from rl_fuser_infer import run_inference
result = run_inference(${JSON.stringify(asset)})
print(json.dumps(result))
  `;

  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const proc = spawn(PYTHON, ['-c', code], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
      cwd: ML_DIR,
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      done({ rl_direction: 0, rl_label: 'NEUTRAL', error: 'timeout' });
    }, 30000);

    proc.on('error', (err) => done({ rl_direction: 0, rl_label: 'NEUTRAL', error: err.message }));
    proc.on('close', (code) => {
      if (code !== 0 || !stdout.trim()) {
        done({ rl_direction: 0, rl_label: 'NEUTRAL', error: (stderr || 'no output').slice(0, 240) });
        return;
      }
      try {
        const lines = stdout.trim().split('\n').filter(Boolean);
        done(JSON.parse(lines[lines.length - 1]));
      } catch {
        done({ rl_direction: 0, rl_label: 'NEUTRAL', error: 'parse error' });
      }
    });
  });
}

export function getMlPythonPath() {
  return PYTHON;
}
