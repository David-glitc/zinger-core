// @ts-nocheck
/**
 * Real Polymarket up/down window helpers.
 * Slug form: {asset}-updown-{5m|15m|30m|1h|60m}-{unixStart}
 */

import { POLY_WINDOW_SECONDS, DURATION_SECONDS } from './config.js';

export function parseSlugWindow(slug) {
  if (!slug || typeof slug !== 'string') return null;
  const m = slug.match(/^(btc|eth)-updown-(5m|15m|30m|1h|60m)-(\d+)$/i);
  if (!m) return null;
  const startSec = Number(m[3]);
  if (!Number.isFinite(startSec) || startSec <= 0) return null;
  let duration = m[2].toLowerCase();
  if (duration === '60m') duration = '1h';
  const windowSec = DURATION_SECONDS[duration] || POLY_WINDOW_SECONDS;
  const endSec = startSec + windowSec;
  return {
    asset: m[1].toUpperCase(),
    duration,
    windowSec,
    startSec,
    endSec,
    startAtMs: startSec * 1000,
    endAtMs: endSec * 1000,
    key: `${m[1].toLowerCase()}-${duration}-${startSec}`,
    slug,
  };
}

/** Active 5m wall bucket — matches Polymarket slug open time */
export function currentWallWindow(windowSec = POLY_WINDOW_SECONDS, nowMs = Date.now()) {
  const nowSec = Math.floor(nowMs / 1000);
  const startSec = Math.floor(nowSec / windowSec) * windowSec;
  const endSec = startSec + windowSec;
  return {
    windowSec,
    startSec,
    endSec,
    startAtMs: startSec * 1000,
    endAtMs: endSec * 1000,
    remainingMs: Math.max(0, endSec * 1000 - nowMs),
    key: `wall-${windowSec}-${startSec}`,
  };
}

export function marketWindow(market, nowMs = Date.now()) {
  const fromSlug = parseSlugWindow(market?.slug);
  if (fromSlug) {
    return {
      ...fromSlug,
      remainingMs: Math.max(0, fromSlug.endAtMs - nowMs),
      isOpen: nowMs >= fromSlug.startAtMs && nowMs < fromSlug.endAtMs,
      source: 'slug',
    };
  }
  const endSec = Number(market?.endTime);
  if (Number.isFinite(endSec) && endSec > 0) {
    const windowSec = Number(market.windowSeconds || POLY_WINDOW_SECONDS);
    const startSec = endSec - windowSec;
    const duration = windowSec >= 3600 ? '1h'
      : windowSec >= 1800 ? '30m'
        : windowSec >= 900 ? '15m'
          : '5m';
    return {
      asset: market.symbol,
      duration,
      windowSec,
      startSec,
      endSec,
      startAtMs: startSec * 1000,
      endAtMs: endSec * 1000,
      remainingMs: Math.max(0, endSec * 1000 - nowMs),
      isOpen: nowMs < endSec * 1000,
      key: `${String(market.symbol || 'x').toLowerCase()}-${startSec}`,
      slug: market.slug,
      source: 'endTime',
    };
  }
  const wall = currentWallWindow(POLY_WINDOW_SECONDS, nowMs);
  return { ...wall, asset: market?.symbol, slug: market?.slug, source: 'wall', isOpen: true };
}

export function windowKeyFromTrade(t) {
  const parsed = parseSlugWindow(t?.slug);
  if (parsed) return parsed.key;
  const et = Number(t?.entryTime || t?.timestamp || 0);
  if (et > 0) {
    const w = currentWallWindow(POLY_WINDOW_SECONDS, et);
    return w.key;
  }
  return null;
}

/** Aggregate closes for one window key */
export function computeWindowStats(trades, positions, windowMeta, mode = 'paper') {
  const key = windowMeta?.key;
  const startAt = windowMeta?.startAtMs || 0;
  const endAt = windowMeta?.endAtMs || Infinity;
  const startSec = windowMeta?.startSec ?? Math.floor(startAt / 1000);

  const modeTrades = (trades || []).filter((t) => (!mode || t.mode === mode) && (t.closed || t.exitReason));
  const inWindow = modeTrades.filter((t) => {
    const parsed = parseSlugWindow(t?.slug);
    if (parsed && startSec && parsed.startSec === startSec) return true;
    const tk = windowKeyFromTrade(t);
    if (key && tk && tk === key) return true;
    const et = Number(t.entryTime || t.timestamp || 0);
    return et >= startAt && et < endAt;
  });

  const opens = (positions || []).filter((p) => {
    if (p.closed || (mode && p.mode !== mode)) return false;
    const parsed = parseSlugWindow(p.slug);
    if (parsed && startSec && parsed.startSec === startSec) return true;
    const et = Number(p.entryTime || 0);
    return et >= startAt && et < endAt;
  });

  const pnls = inWindow.map((t) => Number(t.pnl || 0));
  const byReason = {};
  let tpFull = 0;
  let tpPartial = 0;
  for (const t of inWindow) {
    const r = t.exitReason || 'unknown';
    byReason[r] = (byReason[r] || 0) + 1;
    if (r === 'tp') tpFull += 1;
    if (r === 'partial') tpPartial += 1;
  }
  const wins = pnls.filter((x) => x > 0).length;
  const totalPnl = pnls.reduce((s, x) => s + x, 0);

  return {
    key: key || null,
    startAtMs: windowMeta?.startAtMs || null,
    endAtMs: windowMeta?.endAtMs || null,
    remainingMs: windowMeta?.remainingMs ?? null,
    closes: inWindow.length,
    opens: opens.length,
    wins,
    losses: inWindow.length - wins,
    wr: inWindow.length ? Math.round((wins / inWindow.length) * 1000) / 10 : 0,
    pnl: Math.round(totalPnl * 100) / 100,
    tpFull,
    tpPartial,
    tpHits: tpFull + tpPartial,
    byReason,
    source: windowMeta?.source || null,
  };
}
