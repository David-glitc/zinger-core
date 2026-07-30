import { POLY, ASSETS, ALL_ASSETS, getCurrentSlug, getNextSlug, assetsForDurations, durationFromSlug, windowSecondsForDuration } from './config.js';

function parseMaybeJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value); }
    catch { return fallback; }
  }
  return value;
}

function toUnixSeconds(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
  }
  const parsed = Date.parse(String(value));
  if (Number.isNaN(parsed)) return null;
  return Math.floor(parsed / 1000);
}

function resolveAssetMeta(symbol, slug, assetHint = null) {
  if (assetHint?.slugPrefix && assetHint?.windowSeconds) return assetHint;
  const fromSlug = durationFromSlug(slug);
  if (fromSlug) {
    const hit = ALL_ASSETS.find(
      (a) => a.symbol === symbol && a.duration === fromSlug,
    );
    if (hit) return hit;
  }
  return ALL_ASSETS.find((a) => a.symbol === symbol && a.duration === '5m')
    || ASSETS.find((a) => a.symbol === symbol)
    || null;
}

function normalizeMarket(raw, symbol, slug, assetHint = null) {
  if (!raw) return null;

  const assetObj = resolveAssetMeta(symbol, slug, assetHint);
  const outcomes = parseMaybeJson(raw.outcomes, ['Up', 'Down']);
  const clobTokenIds = parseMaybeJson(raw.clobTokenIds, []);
  const outcomePrices = parseMaybeJson(raw.outcomePrices, []);

  if (!Array.isArray(outcomes) || outcomes.length === 0) return null;

  const tokenIds = {};
  const prices = {};
  for (let i = 0; i < outcomes.length; i++) {
    const label = String(outcomes[i] || '').toLowerCase();
    if (!label) continue;
    if (clobTokenIds[i]) tokenIds[label] = String(clobTokenIds[i]);
    const price = Number(outcomePrices[i]);
    if (Number.isFinite(price)) prices[label] = price;
  }

  const endTime = toUnixSeconds(raw.endTime ?? raw.endDate ?? raw.endDateIso);
  if (!Object.keys(tokenIds).length && !Object.keys(prices).length) return null;

  const windowSeconds = assetObj?.windowSeconds
    || windowSecondsForDuration(durationFromSlug(slug))
    || 300;
  const duration = assetObj?.duration || durationFromSlug(slug) || '5m';
  const eventStartTimeIso = raw.eventStartTime
    || (endTime != null ? new Date((endTime - windowSeconds) * 1000).toISOString() : null);
  return {
    id: raw.id,
    conditionId: raw.conditionId,
    question: raw.question || raw.title || slug,
    outcomes,
    tokenIds,
    gammaPrices: prices,
    endTime,
    endDate: raw.endDate || raw.endDateIso || null,
    eventStartTime: eventStartTimeIso,
    volume: Number(raw.volumeNum ?? raw.volume ?? 0) || 0,
    liquidity: Number(raw.liquidityNum ?? raw.liquidity ?? 0) || 0,
    acceptingOrders: raw.acceptingOrders !== false,
    active: raw.active !== false,
    closed: !!raw.closed,
    negRisk: !!raw.negRisk,
    tickSize: String(raw.orderPriceMinTickSize ?? 0.01),
    minShares: Number(raw.orderMinSize ?? 5) || 5,
    bestBid: raw.bestBid != null ? Number(raw.bestBid) : null,
    bestAsk: raw.bestAsk != null ? Number(raw.bestAsk) : null,
    symbol,
    slug,
    asset: assetObj || ASSETS.find((item) => item.symbol === symbol) || null,
    duration,
    windowSeconds,
    isCurrent: (() => {
      if (!assetObj) return false;
      const nowSec = Math.floor(Date.now() / 1000);
      if (raw.closed || (endTime != null && endTime <= nowSec)) return false;
      return slug === getCurrentSlug(assetObj.slugPrefix, assetObj.windowSeconds);
    })(),
  };
}

async function fetchMarketBySlug(slug) {
  const url = `${POLY.gammaApi}/events/slug/${slug}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return null;
  const data = await res.json();
  const market = data.markets?.[0];
  if (!market) return null;
  return market;
}

async function fetchMarketDirect(slug) {
  const url = `${POLY.gammaApi}/markets?slug=${encodeURIComponent(slug)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return null;
  const data = await res.json();
  return Array.isArray(data) ? data[0] : null;
}

async function discoverAssetMarkets(asset) {
  const windowSec = asset.windowSeconds || 300;
  const slugs = [getCurrentSlug(asset.slugPrefix, windowSec), getNextSlug(asset.slugPrefix, windowSec)];
  const found = [];

  for (const slug of slugs) {
    let raw = null;
    let error = null;

    try {
      raw = await fetchMarketBySlug(slug);
    } catch (err) {
      error = err;
    }

    if (!raw) {
      try {
        raw = await fetchMarketDirect(slug);
      } catch (err) {
        error = err;
      }
    }

    if (!raw) {
      found.push({
        symbol: asset.symbol,
        slug,
        missing: true,
        error: error?.message || 'not found',
      });
      continue;
    }

    const normalized = normalizeMarket(raw, asset.symbol, slug, asset);
    if (!normalized || normalized.closed) {
      found.push({
        symbol: asset.symbol,
        slug,
        missing: true,
        error: normalized?.closed ? 'closed' : 'unparseable',
      });
      continue;
    }

    found.push(normalized);
  }

  return found;
}

/**
 * Discover markets across durations.
 * @param {boolean|string[]|{durations?:string[], include15m?:boolean}} opts
 *  - true / omit → 5m+15m+30m+1h
 *  - false → 5m only
 *  - string[] → explicit durations
 */
export async function findMarkets(opts = true) {
  const markets = [];
  const diagnostics = [];

  let scanAssets;
  if (opts === false) {
    scanAssets = ASSETS;
  } else if (Array.isArray(opts)) {
    scanAssets = assetsForDurations(opts);
  } else if (opts && typeof opts === 'object') {
    if (Array.isArray(opts.durations)) scanAssets = assetsForDurations(opts.durations);
    else if (opts.include15m === false) scanAssets = ASSETS;
    else scanAssets = ALL_ASSETS;
  } else {
    scanAssets = ALL_ASSETS;
  }

  for (const asset of scanAssets) {
    const discovered = await discoverAssetMarkets(asset);
    for (const item of discovered) {
      if (item.missing) {
        diagnostics.push(item);
        continue;
      }
      if (!markets.find((existing) => existing.slug === item.slug)) {
        markets.push(item);
      }
    }
  }

  return { markets, diagnostics };
}

export async function searchMarkets(query = 'bitcoin up or down') {
  const url = `${POLY.gammaApi}/public-search?q=${encodeURIComponent(query)}&limit_per_type=10`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.events || []).flatMap((event) =>
    (event.markets || []).map((market) => ({
      ...market,
      eventTitle: event.title,
      eventSlug: event.slug,
    }))
  );
}

/** Cache Polymarket Chainlink window open/close (price-to-beat) by slug. */
const priceToBeatCache = new Map();

/**
 * Polymarket crypto up/down resolves vs the Chainlink price at window open.
 * GET https://polymarket.com/api/crypto/crypto-price?symbol=BTC&eventStartTime=…&variant=fiveminute&endDate=…
 */
export async function fetchPriceToBeat(market) {
  if (!market?.symbol) return null;
  const windowSec = Number(market.windowSeconds || market.durationSec || 300) || 300;
  // Derive window open when Gamma omits eventStartTime (common on slug discovery).
  const eventStartTime = market.eventStartTime
    || (market.endTime != null
      ? new Date((Number(market.endTime) - windowSec) * 1000).toISOString()
      : null);
  if (!eventStartTime) return null;

  const cached = priceToBeatCache.get(market.slug);
  if (cached?.openPrice != null && Date.now() - cached.fetchedAt < 20_000) return cached;
  // Once we have an openPrice for this slug, keep it (it is fixed for the window).
  if (cached?.openPrice != null && cached.slug === market.slug) {
    // Still refresh closePrice periodically while window is live.
    if (Date.now() - cached.fetchedAt < 8_000) return cached;
  }

  const variant = windowSec >= 3600
    ? 'hourly'
    : windowSec >= 1800
      ? 'thirtyminute'
      : windowSec >= 900
        ? 'fifteen'
        : 'fiveminute';
  const params = new URLSearchParams({
    symbol: String(market.symbol).toUpperCase(),
    eventStartTime,
    variant,
  });
  if (market.endDate) params.set('endDate', String(market.endDate));
  else if (market.endTime) params.set('endDate', new Date(market.endTime * 1000).toISOString());

  try {
    const url = `https://polymarket.com/api/crypto/crypto-price?${params}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(6000),
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return cached || null;
    const data = await res.json();
    const openPrice = Number(data.openPrice);
    const closePrice = data.closePrice != null ? Number(data.closePrice) : null;
    // Future windows often return openPrice: 0 until the window opens — treat as missing.
    if (!Number.isFinite(openPrice) || openPrice <= 0) return cached || null;
    const entry = {
      slug: market.slug,
      symbol: market.symbol,
      openPrice,
      closePrice: Number.isFinite(closePrice) && closePrice > 0 ? closePrice : null,
      completed: !!data.completed,
      eventStartTime,
      fetchedAt: Date.now(),
      source: 'polymarket_crypto_price',
    };
    priceToBeatCache.set(market.slug, entry);
    return entry;
  } catch {
    return cached || null;
  }
}

export { normalizeMarket, parseMaybeJson, toUnixSeconds };
