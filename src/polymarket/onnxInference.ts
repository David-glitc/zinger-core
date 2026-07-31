// @ts-nocheck
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';

const ML_DIR = path.resolve(import.meta.dirname, '../../ml');
const ONNX_DIR = path.join(ML_DIR, 'data/ml/models/onnx');
const MANIFEST_PATH = path.join(ONNX_DIR, 'manifest.json');
const VENV_PY = path.join(ML_DIR, '.venv/bin/python3');
const PYTHON = process.env.ZINGER_ML_PYTHON
  || (fs.existsSync('/usr/bin/python3') ? '/usr/bin/python3' : null)
  || (fs.existsSync(VENV_PY) ? VENV_PY : null)
  || 'python3';

let _ort = null;
let _manifest = null;
let _models = {};

async function getORT() {
  if (!_ort) {
    try {
      _ort = await import('onnxruntime-node');
    } catch {
      return null;
    }
  }
  return _ort;
}

function loadManifest() {
  if (_manifest) return _manifest;
  try {
    _manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
    return _manifest;
  } catch {
    return [];
  }
}

export function getOnnxModelPath(symbol, timeframe, horizon) {
  const safe = symbol.toUpperCase().replace('/', '_');
  const p = path.join(ONNX_DIR, `${safe}_${timeframe}_h${horizon}.onnx`);
  return fs.existsSync(p) ? p : null;
}

export function isOnnxAvailable() {
  const m = loadManifest();
  return m.length > 0;
}

async function loadOnnxModel(modelPath) {
  if (_models[modelPath]) return _models[modelPath];
  const ort = await getORT();
  if (!ort) return null;
  try {
    const session = await ort.InferenceSession.create(modelPath);
    _models[modelPath] = session;
    return session;
  } catch {
    return null;
  }
}

export async function onnxInfer(symbol, timeframe, horizon, featSeq, meta) {
  const modelPath = getOnnxModelPath(symbol, timeframe, horizon);
  if (!modelPath) return null;

  const session = await loadOnnxModel(modelPath);
  if (!session) return null;

  const ort = await getORT();
  if (!ort) return null;

  try {
    const feeds = {
      feat_seq: new ort.Tensor('float32', featSeq, featSeq.shape),
      meta: new ort.Tensor('float32', meta, meta.shape),
    };
    const results = await session.run(feeds);
    const probs = results.probs.data;
    const confidence = results.confidence.data[0];
    const expectedReturn = results.expected_return.data[0];

    const direction = probs[2] > probs[0] && probs[2] > probs[1] ? 1
      : probs[0] > probs[1] && probs[0] > probs[2] ? -1
      : 0;

    return {
      direction,
      confidence: Math.max(0, Math.min(1, confidence)),
      expected_return: expectedReturn,
      prob_up: probs[2],
      prob_down: probs[0],
      prob_neutral: probs[1],
      model: `${symbol}_${timeframe}_h${horizon}`,
    };
  } catch (err) {
    return { direction: 0, confidence: 0, error: err.message };
  }
}

async function computeFeaturesViaPython(symbol, timeframe) {
  const code = `
import sys, json
sys.path.insert(0, ${JSON.stringify(ML_DIR)})
import ccxt
import pandas as pd
from features import add_technical_indicators, add_meta_features
from config import TIMEFRAMES

asset = 'BTC/USDT' if '${symbol}'.upper() == 'BTC' else 'ETH/USDT'
tf = '${timeframe}'
limit = TIMEFRAMES.get(tf, {}).get('seq_len', 64) + 50

ex = ccxt.binance()
ohlcv = ex.fetch_ohlcv(asset, tf, limit=limit)
df = pd.DataFrame(ohlcv, columns=['timestamp','open','high','low','close','volume'])
feats = add_technical_indicators(df)
meta = add_meta_features(df, feats)
clean = feats.dropna().join(meta.dropna(), lsuffix='_f', rsuffix='_m')
seq_len = TIMEFRAMES.get(tf, {}).get('seq_len', 64)
feat_cols = [c for c in clean.columns if not c.endswith('_m')]
meta_cols = [c for c in clean.columns if c.endswith('_m')]
feat_arr = clean[feat_cols].values[-seq_len:].tolist()
meta_arr = clean[meta_cols].values[-1:].tolist()
print(json.dumps({'feat_shape': [len(feat_arr), len(feat_arr[0]) if feat_arr else 0], 'meta_shape': [len(meta_arr), len(meta_arr[0]) if meta_arr else 0], 'feats': feat_arr, 'meta': meta_arr[0] if meta_arr else []}))
  `;

  return new Promise((resolve) => {
    let settled = false;
    const done = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(val);
    };

    const proc = spawn(PYTHON, ['-c', code], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, OMP_NUM_THREADS: '2', PYTHONUNBUFFERED: '1' },
      cwd: ML_DIR,
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      done({ error: 'timeout' });
    }, 30000);

    proc.on('error', (err) => done({ error: err.message }));
    proc.on('close', (code) => {
      if (code !== 0 || !stdout.trim()) {
        done({ error: (stderr || 'no output').slice(0, 200) });
        return;
      }
      try {
        const lines = stdout.trim().split('\n').filter(Boolean);
        done(JSON.parse(lines[lines.length - 1]));
      } catch {
        done({ error: 'parse error' });
      }
    });
  });
}

export async function onnxInferFromLive(symbol, timeframe, horizon) {
  const features = await computeFeaturesViaPython(symbol, timeframe);
  if (features.error) {
    return { direction: 0, confidence: 0, error: features.error };
  }

  const featFlat = new Float32Array(features.feats.flat());
  const metaFlat = new Float32Array(features.meta);

  return onnxInfer(symbol, timeframe, horizon,
    { data: featFlat, shape: features.feat_shape },
    { data: metaFlat, shape: features.meta_shape },
  );
}
