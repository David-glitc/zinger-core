// @ts-nocheck
import { POLY_WINDOW_SECONDS } from '../config.js';
import { loadFusionContext, refreshFusionContext } from '../signal.js';

export async function fetchSpotTicker(symbol: string) {
  try {
    const res = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const d = await res.json();
    return {
      symbol,
      price: Number(d.lastPrice),
      changePct: Number(d.priceChangePercent),
      high: Number(d.highPrice),
      low: Number(d.lowPrice),
      ts: Date.now(),
    };
  } catch {
    return null;
  }
}

export async function refreshSpotPrices(botState, { addSpotTick } = {}) {
  if (!botState) return {};
  try {
    const [btc, eth] = await Promise.all([
      fetchSpotTicker('BTCUSDT'),
      fetchSpotTicker('ETHUSDT'),
    ]);
    botState.spotPrices = {
      btc: btc || botState.spotPrices?.btc || null,
      eth: eth || botState.spotPrices?.eth || null,
    };
    if (typeof addSpotTick === 'function') {
      if (btc?.price) addSpotTick('btc', btc.price, btc.ts);
      if (eth?.price) addSpotTick('eth', eth.price, eth.ts);
    }
  } catch {}
  return botState.spotPrices;
}

export async function collectSignals({
  cfg,
  botState,
  getSignalForBoth,
  getMLSignalForBoth,
  addMLPrediction,
  getConfidenceBias,
  log,
}) {
  if (!cfg?.useSignals) return botState.signals || {};

  // Alpha fusion context must be in place before the signals are analyzed:
  // the jump-model regime comes off disk, the book imbalance from last pass.
  await loadFusionContext();
  refreshFusionContext({
    btc: { book: botState.booksForFusion?.btc || null },
    eth: { book: botState.booksForFusion?.eth || null },
  });

  // Outage-resilient: network timeouts must not abort scan pass
  const freshSignals = typeof getSignalForBoth === 'function'
    ? await getSignalForBoth().catch((err) => {
      if (Date.now() - (botState._signalFailLoggedAt || 0) > 60_000) {
        botState._signalFailLoggedAt = Date.now();
        if (typeof log === 'function') {
          log(`⚠️ Signal feed unavailable — ${String(err?.message || err).slice(0, 90)} · reusing last signals`, 'error');
        }
      }
      return null;
    })
    : null;

  if (freshSignals) botState.signals = freshSignals;

  if (cfg.useML && typeof getMLSignalForBoth === 'function') {
    const mlOverride = await getMLSignalForBoth('5m', 1).catch(() => ({ btc: null, eth: null }));
    if (mlOverride) {
      for (const asset of ['btc', 'eth']) {
        const raw = botState.signals?.[asset];
        const ml = mlOverride[asset];
        if (!raw || !ml || ml.error || ml.direction === 'neutral' || ml.direction === 0) continue;
        if (typeof addMLPrediction === 'function') addMLPrediction(asset, ml);

        const rawIsBull = raw.direction === 'up';
        const mlIsBull = ml.direction === 1 || ml.direction === 'up';
        const mlConf = Number(ml.confidence || 0);
        const paperLoose = cfg.mode === 'paper' && mlConf >= 0.58;
        const liveStrong = mlConf >= 0.62;

        if ((paperLoose || liveStrong) && (raw.direction === 'neutral' || rawIsBull !== mlIsBull)) {
          raw.direction = mlIsBull ? 'up' : 'down';
          raw.confidence = Math.min(0.65, Math.max(raw.confidence || 0, mlConf * 0.75));
          raw.score = Math.min(6, mlConf * 6);
          raw.mlOverride = true;
          raw.mlConfidence = mlConf;
        } else if ((paperLoose || liveStrong) && rawIsBull === mlIsBull) {
          raw.confidence = Math.min(0.65, (raw.confidence || 0) + mlConf * 0.12);
          raw.mlConfirmed = true;
          raw.mlConfidence = mlConf;
        }

        if (typeof getConfidenceBias === 'function') {
          const bias = getConfidenceBias(asset, raw);
          if (bias?.bias !== 0) {
            raw.confidence = Math.min(0.65, bias.adjusted);
            raw.confidenceBias = bias;
            raw.confidenceBiasUsed = true;
          }
        }
      }
    }
  }

  return botState.signals;
}

export async function enrichMarketsWithOracle(markets, { fetchPriceToBeat, timeoutMs = 3500 } = {}) {
  if (!Array.isArray(markets)) return [];
  await Promise.all(markets.map(async (market) => {
    const windowSec = Number(market.windowSeconds || POLY_WINDOW_SECONDS) || POLY_WINDOW_SECONDS;
    if (!market.eventStartTime && market.endTime) {
      market.eventStartTime = new Date((Number(market.endTime) - windowSec) * 1000).toISOString();
    }
    if (!market.endDate && market.endTime) {
      market.endDate = new Date(Number(market.endTime) * 1000).toISOString();
    }
    if (typeof fetchPriceToBeat === 'function') {
      const ptb = await Promise.race([
        fetchPriceToBeat(market).catch(() => null),
        new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
      ]);
      market.priceToBeat = ptb?.openPrice ?? market.priceToBeat ?? null;
      market.priceToBeatMeta = ptb || market.priceToBeatMeta || null;
    }
  }));
  return markets;
}
