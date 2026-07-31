// @ts-nocheck
const MODELS = [
  { id: 'btc-5m-h1', symbol: 'BTC', timeframe: '5m', horizon: 1, file: 'BTC_USDT_5m_h1.pt', label: '5m h1', minutes: 5 },
  { id: 'btc-5m-h3', symbol: 'BTC', timeframe: '5m', horizon: 3, file: 'BTC_USDT_5m_h3.pt', label: '5m h3', minutes: 15 },
  { id: 'btc-5m-h12', symbol: 'BTC', timeframe: '5m', horizon: 12, file: 'BTC_USDT_5m_h12.pt', label: '5m h12', minutes: 60 },
  { id: 'btc-1h-h1', symbol: 'BTC', timeframe: '1h', horizon: 1, file: 'BTC_USDT_1h_h1.pt', label: '1h h1', minutes: 60 },
  { id: 'btc-1h-h4', symbol: 'BTC', timeframe: '1h', horizon: 4, file: 'BTC_USDT_1h_h4.pt', label: '1h h4', minutes: 240 },
  { id: 'btc-1h-h24', symbol: 'BTC', timeframe: '1h', horizon: 24, file: 'BTC_USDT_1h_h24.pt', label: '1h h24', minutes: 1440 },
  { id: 'eth-5m-h1', symbol: 'ETH', timeframe: '5m', horizon: 1, file: 'ETH_USDT_5m_h1.pt', label: '5m h1', minutes: 5 },
  { id: 'eth-5m-h3', symbol: 'ETH', timeframe: '5m', horizon: 3, file: 'ETH_USDT_5m_h3.pt', label: '5m h3', minutes: 15 },
  { id: 'eth-5m-h12', symbol: 'ETH', timeframe: '5m', horizon: 12, file: 'ETH_USDT_5m_h12.pt', label: '5m h12', minutes: 60 },
  { id: 'eth-1h-h1', symbol: 'ETH', timeframe: '1h', horizon: 1, file: 'ETH_USDT_1h_h1.pt', label: '1h h1', minutes: 60 },
  { id: 'eth-1h-h4', symbol: 'ETH', timeframe: '1h', horizon: 4, file: 'ETH_USDT_1h_h4.pt', label: '1h h4', minutes: 240 },
  { id: 'eth-1h-h24', symbol: 'ETH', timeframe: '1h', horizon: 24, file: 'ETH_USDT_1h_h24.pt', label: '1h h24', minutes: 1440 },
];

const modelStates = new Map();

const listeners = new Set();

export function onModelChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  for (const fn of listeners) {
    try { fn(); } catch {}
  }
}

for (const m of MODELS) {
  modelStates.set(m.id, {
    id: m.id,
    symbol: m.symbol,
    timeframe: m.timeframe,
    horizon: m.horizon,
    label: m.label,
    minutes: m.minutes,
    file: m.file,
    status: 'idle',
    direction: null,
    confidence: null,
    expectedReturn: null,
    probUp: null,
    probDown: null,
    probNeutral: null,
    error: null,
    lastRun: null,
    lastDuration: null,
    runs: 0,
    failures: 0,
  });
}

export function getModelDefs() {
  return MODELS;
}

export function getModelStates() {
  return Array.from(modelStates.values());
}

export function getModelState(id) {
  return modelStates.get(id) || null;
}

export function markModelRunning(id) {
  const s = modelStates.get(id);
  if (!s) return;
  s.status = 'running';
  s.lastRun = Date.now();
  notify();
}

export function markModelSuccess(id, result) {
  const s = modelStates.get(id);
  if (!s) return;
  s.status = 'healthy';
  s.direction = result.direction;
  s.confidence = result.confidence ?? result.confidence;
  s.expectedReturn = result.expected_return ?? result.expectedReturn;
  s.probUp = result.prob_up ?? null;
  s.probDown = result.prob_down ?? null;
  s.probNeutral = result.prob_neutral ?? null;
  s.error = null;
  s.runs += 1;
  s.lastDuration = result._duration || null;
  notify();
}

export function markModelError(id, error) {
  const s = modelStates.get(id);
  if (!s) return;
  s.status = 'error';
  s.error = typeof error === 'string' ? error.slice(0, 120) : 'unknown error';
  s.failures += 1;
  notify();
}

export function markModelIdle(id) {
  const s = modelStates.get(id);
  if (!s) return;
  if (s.status === 'running') {
    markModelError(id, 'interrupted');
  }
  s.status = 'idle';
  notify();
}

export function getModelHealth() {
  const states = getModelStates();
  const healthy = states.filter(s => s.status === 'healthy').length;
  const running = states.filter(s => s.status === 'running').length;
  const errors = states.filter(s => s.status === 'error').length;
  const idle = states.filter(s => s.status === 'idle').length;
  return { total: states.length, healthy, running, error: errors, idle };
}

export function modelsForAsset(symbol) {
  return MODELS.filter(m => m.symbol === symbol);
}
