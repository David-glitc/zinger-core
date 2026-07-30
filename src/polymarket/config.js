export const POLY = {
  gammaApi: 'https://gamma-api.polymarket.com',
  clobApi: process.env.CLOB_API_URL?.trim() || 'https://clob.polymarket.com',
  chainId: 137,
  usdc: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
  pUsd: '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB',
  ctfExchange: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E',
  negRiskAdapter: '0xd91E80cF2Ba13D2A2F09b49f2E6834f8E1E1A1a1',
};

export const POLY_MIN_ORDER_USD = 0.4;
export const POLY_DEFAULT_MIN_BET = 0.4;
export const POLY_DEFAULT_MAX_BET = 50;
export const POLY_WINDOW_SECONDS = 300;
export const POLY_WINDOW_SECONDS_15M = 900;
export const POLY_WINDOW_SECONDS_30M = 1800;
export const POLY_WINDOW_SECONDS_1H = 3600;
export const POLY_SCAN_INTERVAL_MS = 250;

export const ASSETS = [
  { symbol: 'BTC', duration: '5m', slugPrefix: 'btc-updown-5m', windowSeconds: 300 },
  { symbol: 'ETH', duration: '5m', slugPrefix: 'eth-updown-5m', windowSeconds: 300 },
];

export const ASSETS_15M = [
  { symbol: 'BTC', duration: '15m', slugPrefix: 'btc-updown-15m', windowSeconds: 900 },
  { symbol: 'ETH', duration: '15m', slugPrefix: 'eth-updown-15m', windowSeconds: 900 },
];

export const ASSETS_30M = [
  { symbol: 'BTC', duration: '30m', slugPrefix: 'btc-updown-30m', windowSeconds: 1800 },
  { symbol: 'ETH', duration: '30m', slugPrefix: 'eth-updown-30m', windowSeconds: 1800 },
];

export const ASSETS_1H = [
  { symbol: 'BTC', duration: '1h', slugPrefix: 'btc-updown-1h', windowSeconds: 3600 },
  { symbol: 'ETH', duration: '1h', slugPrefix: 'eth-updown-1h', windowSeconds: 3600 },
];

/** All duration books the bot can discover (Gamma may not list 30m/1h yet). */
export const ALL_ASSETS = [...ASSETS, ...ASSETS_15M, ...ASSETS_30M, ...ASSETS_1H];

export const DURATION_SECONDS = {
  '5m': 300,
  '15m': 900,
  '30m': 1800,
  '1h': 3600,
  '60m': 3600,
};

export function assetsForDurations(durations = ['5m', '15m', '30m', '1h']) {
  const want = new Set((durations || []).map((d) => String(d).toLowerCase()));
  return ALL_ASSETS.filter((a) => want.has(String(a.duration).toLowerCase()));
}

export function durationFromSlug(slug) {
  if (!slug || typeof slug !== 'string') return null;
  const m = slug.match(/-updown-(5m|15m|30m|1h|60m)-/i);
  return m ? (m[1].toLowerCase() === '60m' ? '1h' : m[1].toLowerCase()) : null;
}

export function windowSecondsForDuration(duration) {
  return DURATION_SECONDS[String(duration || '').toLowerCase()] || POLY_WINDOW_SECONDS;
}

export function getCurrentSlug(symbolPrefix, windowSeconds = 300) {
  const now = Math.floor(Date.now() / 1000);
  const interval = Math.floor(now / windowSeconds) * windowSeconds;
  return `${symbolPrefix}-${interval}`;
}

export function getNextSlug(symbolPrefix, windowSeconds = 300) {
  const now = Math.floor(Date.now() / 1000);
  const interval = Math.floor(now / windowSeconds) * windowSeconds + windowSeconds;
  return `${symbolPrefix}-${interval}`;
}

export function getRemainingSeconds(windowSeconds) {
  return Math.ceil(getRemainingMs(windowSeconds) / 1000);
}

export function getRemainingMs(windowSeconds) {
  const ws = windowSeconds || POLY_WINDOW_SECONDS;
  const now = Date.now();
  const nextInterval = (Math.floor(now / 1000 / ws) + 1) * ws * 1000;
  return nextInterval - now;
}

export function getCycleEndMs(windowSeconds) {
  return Date.now() + getRemainingMs(windowSeconds);
}

export function formatRemainingMs(ms = getRemainingMs()) {
  const safe = Math.max(0, Math.floor(ms));
  const minutes = Math.floor(safe / 60000);
  const seconds = Math.floor((safe % 60000) / 1000);
  const millis = safe % 1000;
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

export function getIntervalBoundary(timestamp, windowSeconds = 300) {
  return Math.floor(timestamp / windowSeconds) * windowSeconds;
}
