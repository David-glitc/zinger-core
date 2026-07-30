import { getModelStates, getModelHealth } from '../polymarket/modelRegistry.js';
import { getConfidenceBufferStats, getConsensus, getPriceTrace } from '../polymarket/confidence.js';
import { getSpotHistory, getSpotPriceSnapshot, onSpotTick } from '../polymarket/spotPriceHistory.js';
import { getMidPrice, getOrderBook } from '../polymarket/clob.js';
import { openCostWithFee, closeProceedsWithFee } from '../polymarket/fees.js';
import { buildDataAssurance } from '../polymarket/dataAssurance.js';
import { checkGeoblock, checkGeoblockDirect, checkProxyHealth } from '../polymarket/proxyEnv.js';
import { getClobWsSnapshot } from '../polymarket/clobWs.js';
import { getSessionLedger } from '../polymarket/sessionLedger.js';
import { syncLiveAccount, getLiveAccount } from '../polymarket/liveAccount.js';
import { getWallet } from '../lib/wallet.js';
import { POLY, durationFromSlug } from '../polymarket/config.js';
import { checkPusdBalance } from '../polymarket/swap.js';
import { startDepositScanner, stopDepositScanner, getLastScannedBlock } from '../polymarket/deposits.js';
import { placeOrder, placeMarketSell, syncClobBalance, getClobBalance } from '../polymarket/trade.js';
import {
  ensureAccount,
  getAccount,
  setMode,
  deposit as ledgerDeposit,
  withdraw as ledgerWithdraw,
  saveRules,
  startSession,
  stopSession,
  getRunningSession,
  syncAccountCash,
  getPlatformFeeRate,
  confirmUsdcDeposit as ledgerConfirmUsdcDeposit,
  loadStore as ledgerLoadStore,
  normalizeAddress,
} from './pilotLedger.js';

const predictionSseClients = new Set();
const spotSseClients = new Set();
const paperSseClients = new Set();
let _notifyPredictions = null;
let _notifySpot = null;
let depositScannerCleanup = null;

/** Pilot paper book — mirrors live CLOB economics as closely as we can on mids. */
const PILOT = Object.freeze({
  initialBankroll: 1000,
  maxCashFrac: 0.10,
  minTicketUsd: 5,
  minConfidence: 0.35,
  maxConfidenceSweet: 0.72,
  minPrice: 0.42,
  maxPrice: 0.68,
  minRemainingSec: 20,
  maxRemainingSec: 280,
  entryByDuration: {
    '5m': { min: 20, max: 280 },
    '15m': { min: 60, max: 800 },
    '30m': { min: 120, max: 1600 },
    '1h': { min: 180, max: 3200 },
  },
  feeCategory: 'crypto',
  tpBase: 0.16,
  tpConfScale: 0.14,
  slPct: 0.12,
});

function freshPaperState(bankroll = PILOT.initialBankroll) {
  const b = Math.max(100, Number(bankroll) || PILOT.initialBankroll);
  return {
    initialBankroll: b,
    cash: b,
    open: {},
    lastTradedSlug: {},
    trades: [],
    events: [],
    feesPaid: 0,
    startedAt: Date.now(),
    lastUpdate: 0,
    wallet: null,
    deployedAt: null,
  };
}

let publicPaper = freshPaperState();

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Max-Age': '86400',
  };
}

function sendSSE(clients, data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try { client.res.write(msg); } catch { clients.delete(client); }
  }
}

function sseSetup(req, res, clients, metadata = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...corsHeaders(),
  });
  const client = { res, ...metadata };
  clients.add(client);
  req.on('close', () => clients.delete(client));
}

function buildLevels(confidence = 0.5, entry = 0.5) {
  const conf = Math.max(0, Math.min(0.65, Number(confidence) || 0));
  const tpPct = 0.08 + conf * 0.08;
  const slPct = 0.12;
  return {
    entry,
    takeProfit: { pct: Math.round(tpPct * 1000) / 10, price: Math.round(Math.min(0.99, entry * (1 + tpPct)) * 10000) / 10000 },
    stopLoss: { pct: Math.round(slPct * 1000) / 10, price: Math.round(Math.max(0.01, entry * (1 - slPct)) * 10000) / 10000 },
    partial: { pct: 55, price: Math.round(Math.min(0.99, entry * (1 + tpPct * 0.5)) * 10000) / 10000 },
  };
}

function collectSignalSummary(polyState) {
  const signals = polyState?.signals || {};
  const result = {};
  for (const asset of ['btc', 'eth']) {
    const s = signals[asset];
    if (!s) { result[asset] = null; continue; }
    const direction = s.direction || 'neutral';
    const levels = buildLevels(s.confidence, 0.5);
    const components = [
      { id: 'rsi', label: 'RSI', value: s.rsi, vote: s.rsi < 40 ? 1 : s.rsi > 60 ? -1 : 0 },
      { id: 'macd', label: 'MACD', value: s.macd?.hist, vote: (s.macd?.hist || 0) > 0 ? 1 : (s.macd?.hist || 0) < 0 ? -1 : 0 },
      { id: 'adx', label: 'ADX', value: s.adx?.adx ?? s.adx, vote: s.adx?.trend === 'up' ? 1 : s.adx?.trend === 'down' ? -1 : 0 },
      { id: 'mom', label: 'Mom 1m', value: s.momentum?.m1, vote: (s.momentum?.m1 || 0) > 0.05 ? 1 : (s.momentum?.m1 || 0) < -0.05 ? -1 : 0 },
      { id: 'vol', label: 'Vol', value: s.volume?.ratio, vote: (s.volume?.ratio || 1) > 1.3 ? ((s.momentum?.m1 || 0) >= 0 ? 1 : -1) : 0 },
      { id: 'taker', label: 'Taker', value: s.volume?.takerBuyRatio, vote: (s.volume?.takerBuyRatio || 0.5) >= 0.58 ? 1 : (s.volume?.takerBuyRatio || 0.5) <= 0.42 ? -1 : 0 },
      { id: 'fund', label: 'Funding', value: s.funding?.rate, vote: (s.funding?.rate || 0) < -0.00015 ? 1 : (s.funding?.rate || 0) > 0.00015 ? -1 : 0 },
      { id: 'score', label: 'Score', value: s.score, vote: (s.score || 0) > 2.5 ? 1 : (s.score || 0) < -2.5 ? -1 : 0 },
    ];
    result[asset] = {
      asset: asset.toUpperCase(),
      action: direction === 'up' ? 'buy_up' : direction === 'down' ? 'buy_down' : 'hold',
      direction,
      confidence: s.confidence,
      score: s.score,
      edge: s.edge,
      price: s.price,
      rsi: s.rsi,
      adx: s.adx?.adx || s.adx || null,
      macdHist: s.macd?.hist ?? null,
      momentum: s.momentum || null,
      volume: s.volume || null,
      funding: s.funding || null,
      skipTrade: !!s.skipTrade,
      timestamp: s.timestamp,
      tags: s.signals?.slice(0, 12) || s.tags?.slice(0, 12) || [],
      components,
      ...levels,
    };
  }
  return result;
}

function collectModelData() {
  const models = getModelStates();
  const health = getModelHealth();
  const byAsset = { BTC: [], ETH: [] };
  for (const m of models) {
    byAsset[m.symbol] = byAsset[m.symbol] || [];
    byAsset[m.symbol].push({
      id: m.id,
      timeframe: m.timeframe,
      horizon: m.horizon,
      label: m.label,
      minutes: m.minutes,
      status: m.status,
      direction: m.direction,
      confidence: m.confidence,
      expectedReturn: m.expectedReturn,
      probUp: m.probUp,
      probDown: m.probDown,
      probNeutral: m.probNeutral,
      lastRun: m.lastRun,
      lastDuration: m.lastDuration,
      error: m.error,
    });
  }
  return { models: byAsset, health };
}

function sweetSizeUsd(cash, confidence, entry) {
  const conf = Math.max(0.35, Math.min(0.65, Number(confidence) || 0.4));
  const midDist = Math.abs(entry - 0.55);
  const bandBonus = midDist <= 0.08 ? 1.15 : midDist <= 0.14 ? 1.0 : 0.85;
  const frac = Math.min(PILOT.maxCashFrac, (0.035 + (conf - 0.35) * 0.22) * bandBonus);
  const raw = cash * frac;
  return Math.round(Math.max(PILOT.minTicketUsd, Math.min(cash * PILOT.maxCashFrac, raw)) * 100) / 100;
}

const livePositions = {};
const liveTradeLocks = {};

async function executeLiveEntry(asset, market, signal, conf, budget, entry, tpPct, slPct) {
  const key = `live_entry_${asset}`;
  if (liveTradeLocks[key]) { return; }
  liveTradeLocks[key] = true;

  try {
    const outcome = signal.direction;
    const tokenId = market.tokenIds?.[outcome];
    if (!tokenId) { liveTradeLocks[key] = false; return; }

    const result = await placeOrder({
      tokenId,
      side: 'buy',
      amountUsd: budget,
      price: entry,
      negRisk: market.negRisk || false,
      tickSize: market.tickSize || '0.01',
      minShares: 5,
    });

    livePositions[asset] = {
      orderId: result.id,
      tokenId,
      outcome,
      shares: result.order?.size || 0,
      entry: result.price || entry,
      takeProfit: Math.min(0.99, entry * (1 + tpPct)),
      stopLoss: Math.max(0.01, entry * (1 - slPct)),
      openedAt: Date.now(),
    };
  } catch (err) {
    console.error(`Live entry ${asset} failed:`, err.message);
  } finally {
    setTimeout(() => { liveTradeLocks[key] = false; }, 8000);
  }
}

async function executeLiveExit(asset, reason) {
  const pos = livePositions[asset];
  if (!pos) return;

  try {
    await placeMarketSell({
      tokenId: pos.tokenId,
      shares: pos.shares,
      negRisk: false,
      tickSize: '0.01',
    });
    delete livePositions[asset];
  } catch (err) {
    console.error(`Live exit ${asset} failed:`, err.message);
  }
}

async function syncLiveCash() {
  try {
    return await getClobBalance();
  } catch {
    return null;
  }
}

function updatePublicPaper(signals, markets, rawMarkets) {
  const now = Date.now();
  if (now - publicPaper.lastUpdate < 500) return publicPaperSnapshot();
  publicPaper.lastUpdate = now;

  for (const asset of ['btc', 'eth']) {
    const signal = signals[asset];
    const open = publicPaper.open[asset];
    const signalMarket = markets.find((m) => String(m.symbol || '').toLowerCase() === asset);
    const market = open ? markets.find((m) => m.slug === open.slug) : signalMarket;
    const outcome = open?.outcome || signal?.direction;
    const observedMark = outcome === 'up' ? market?.prices?.up : outcome === 'down' ? market?.prices?.down : null;
    const mark = Number.isFinite(Number(observedMark)) ? Number(observedMark) : open?.mark;

    if (open && Number.isFinite(Number(mark))) {
      open.mark = Number(mark);
      open.unrealizedPnl = Math.round((open.shares * (open.mark - open.entry) - Number(open.entryFee || 0)) * 100) / 100;
      open.updatedAt = now;
      const expired = !market || Number(market.remaining ?? 1) <= 0;
      const hitTp = open.mark >= open.takeProfit;
      const hitSl = open.mark <= open.stopLoss;
      if (expired || hitTp || hitSl) {
        const reason = hitTp ? 'take_profit' : hitSl ? 'stop_loss' : 'window_close';
      const pack = closeProceedsWithFee(
          open.shares,
          open.mark,
          PILOT.feeCategory,
          reason,
        );
        const gross = Math.round(open.shares * (open.mark - open.entry) * 100) / 100;
        const pnl = Math.round((gross - Number(open.entryFee || 0) - pack.fee) * 100) / 100;
        const closed = {
          ...open,
          exit: open.mark,
          exitFee: pack.fee,
          feesPaid: Math.round((Number(open.entryFee || 0) + pack.fee) * 1e5) / 1e5,
          pnl,
          grossPnl: gross,
          reason,
          closedAt: now,
        };
        publicPaper.cash = Math.round((publicPaper.cash + pack.net) * 100) / 100;
        publicPaper.feesPaid = Math.round((publicPaper.feesPaid + pack.fee) * 1e5) / 1e5;
        publicPaper.trades.unshift(closed);
        publicPaper.trades = publicPaper.trades.slice(0, 80);
        publicPaper.events.unshift({
          id: `paper_close_${asset}_${now}`,
          type: 'close',
          asset: asset.toUpperCase(),
          message: `${asset.toUpperCase()} ${open.outcome.toUpperCase()} ${closed.reason} · PnL ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} · fee $${pack.fee.toFixed(4)}`,
          timestamp: now,
          pnl,
          fee: pack.fee,
        });
        const running = getRunningSession();
        if (running?.mode === 'live' && livePositions[asset]) {
          executeLiveExit(asset, closed.reason);
        }
        delete publicPaper.open[asset];
      }
    }

    const remaining = Number(signalMarket?.remaining || 0);
    const conf = Number(signal?.confidence || 0);
    const runningAcct = getRunningSession();
    const bands = runningAcct?.rules || {
      minConfidence: PILOT.minConfidence,
      minPrice: PILOT.minPrice,
      maxPrice: PILOT.maxPrice,
      maxPositionPct: PILOT.maxCashFrac * 100,
      assets: ['BTC', 'ETH'],
    };
    const assetsAllowed = (bands.assets || ['BTC', 'ETH']).map((a) => String(a).toLowerCase());
    const minConf = Number(bands.minConfidence ?? PILOT.minConfidence);
    const minPx = Number(bands.minPrice ?? PILOT.minPrice);
    const maxPx = Number(bands.maxPrice ?? PILOT.maxPrice);
    const maxCashFrac = Math.min(0.25, Math.max(0.01, Number(bands.maxPositionPct ?? 10) / 100));
    const bookDur = String(
      signalMarket?.duration || durationFromSlug(signalMarket?.slug) || '5m',
    ).toLowerCase();
    const entryWin = PILOT.entryByDuration[bookDur] || PILOT.entryByDuration['5m'];
    const durationsAllowed = Array.isArray(bands.durations) && bands.durations.length
      ? bands.durations.map((d) => String(d).toLowerCase())
      : ['5m', '15m', '30m', '1h'];

    if (
      runningAcct?.session?.running
      && assetsAllowed.includes(asset)
      && durationsAllowed.includes(bookDur === '60m' ? '1h' : bookDur)
      && !publicPaper.open[asset]
      && signal
      && ['up', 'down'].includes(signal.direction)
      && conf >= minConf
      && conf <= PILOT.maxConfidenceSweet
      && signal.skipTrade !== true
      && remaining >= entryWin.min
      && remaining <= entryWin.max
      && publicPaper.lastTradedSlug[asset] !== signalMarket?.slug
    ) {
      const entry = Number(signal.direction === 'up' ? signalMarket?.prices?.up : signalMarket?.prices?.down);
      if (!(entry >= minPx && entry <= maxPx)) continue;
      // Prefer account cash when session owns the book
      if (runningAcct.wallet && publicPaper.wallet?.address === runningAcct.wallet) {
        /* keep ledger synced below */
      }
      const premiumBudget = Math.min(
        sweetSizeUsd(publicPaper.cash, conf, entry),
        publicPaper.cash * maxCashFrac,
      );
      if (publicPaper.cash < premiumBudget + 0.5) continue;
      const shares = premiumBudget / entry;
      const openPack = openCostWithFee(shares, entry, PILOT.feeCategory);
      if (publicPaper.cash < openPack.total) continue;
      const tpPct = PILOT.tpBase + Math.min(0.55, conf) * PILOT.tpConfScale;
      const position = {
        id: `paper_${asset}_${now}`,
        asset: asset.toUpperCase(),
        slug: signalMarket.slug,
        duration: bookDur,
        outcome: signal.direction,
        action: signal.action,
        confidence: conf,
        cost: openPack.premium,
        entryFee: openPack.fee,
        feesPaid: openPack.fee,
        shares,
        entry,
        mark: entry,
        takeProfit: Math.min(0.99, entry * (1 + tpPct)),
        stopLoss: Math.max(0.01, entry * (1 - PILOT.slPct)),
        unrealizedPnl: -openPack.fee,
        sweetSpot: true,
        openedAt: now,
        updatedAt: now,
      };
      publicPaper.cash = Math.round((publicPaper.cash - openPack.total) * 100) / 100;
      publicPaper.feesPaid = Math.round((publicPaper.feesPaid + openPack.fee) * 1e5) / 1e5;
      publicPaper.open[asset] = position;
      publicPaper.lastTradedSlug[asset] = signalMarket.slug;
      if (runningAcct?.wallet) syncAccountCash(runningAcct.wallet, publicPaper.cash);
      if (runningAcct?.mode === 'live') {
        const rawMkt = rawMarkets?.find((m) => m.slug === signalMarket.slug) || signalMarket;
        executeLiveEntry(asset, rawMkt, signal, conf, premiumBudget, entry, tpPct, PILOT.slPct);
      }
      publicPaper.events.unshift({
        id: `paper_open_${asset}_${now}`,
        type: 'open',
        asset: asset.toUpperCase(),
        message: `${asset.toUpperCase()} BUY ${signal.direction.toUpperCase()} · $${openPack.premium.toFixed(2)} @ ${entry.toFixed(3)} · fee $${openPack.fee.toFixed(4)} · conf ${(conf * 100).toFixed(0)}%`,
        timestamp: now,
        cost: openPack.premium,
        fee: openPack.fee,
        entry,
      });
    }
  }

  const running = getRunningSession();
  if (running?.wallet) syncAccountCash(running.wallet, publicPaper.cash);

  if (running?.mode === 'live') {
    syncClobBalance().catch(() => {});
  }

  publicPaper.events = publicPaper.events.slice(0, 60);
  return publicPaperSnapshot();
}

function publicPaperSnapshot() {
  const open = Object.values(publicPaper.open);
  const unrealizedPnl = open.reduce((sum, position) => sum + Number(position.unrealizedPnl || 0), 0);
  const realizedPnl = publicPaper.trades.reduce((sum, trade) => sum + Number(trade.pnl || 0), 0);
  const openValue = open.reduce((sum, position) => {
    const markVal = Number(position.shares || 0) * Number(position.mark || position.entry || 0);
    return sum + markVal;
  }, 0);
  const wins = publicPaper.trades.filter((t) => Number(t.pnl) > 0).length;
  const losses = publicPaper.trades.filter((t) => Number(t.pnl) <= 0).length;
  const closed = publicPaper.trades.length;
  return {
    mode: 'paper',
    engine: 'pilot_clob_sim',
    status: publicPaper.deployedAt || publicPaper.trades.length || open.length ? 'running' : 'armed',
    initialBankroll: publicPaper.initialBankroll,
    cash: Math.round(publicPaper.cash * 100) / 100,
    equity: Math.round((publicPaper.cash + openValue) * 100) / 100,
    realizedPnl: Math.round(realizedPnl * 100) / 100,
    unrealizedPnl: Math.round(unrealizedPnl * 100) / 100,
    feesPaid: publicPaper.feesPaid,
    winRate: closed ? Math.round((wins / closed) * 1000) / 10 : null,
    wins,
    losses,
    closedTrades: closed,
    open,
    trades: publicPaper.trades,
    events: publicPaper.events,
    wallet: publicPaper.wallet,
    deployedAt: publicPaper.deployedAt,
    startedAt: publicPaper.startedAt,
    updatedAt: publicPaper.lastUpdate,
    sizing: {
      bankroll: publicPaper.initialBankroll,
      maxCashFrac: PILOT.maxCashFrac,
      minTicketUsd: PILOT.minTicketUsd,
      entryBand: [PILOT.minPrice, PILOT.maxPrice],
      confidenceBand: [PILOT.minConfidence, PILOT.maxConfidenceSweet],
      feeFormula: 'CLOB fd: C × rate × (p×(1−p))^exponent (crypto usually r=0.07 e=1)',
      feeCategory: PILOT.feeCategory,
    },
    note: 'Pilot paper: $1k book, max 10% cash/ticket, sweet entry 0.42–0.68, live CLOB fee schedule on open+CLOB exit. Settle/redeem exit fee $0.',
  };
}

export function resetPublicPaper({ bankroll, wallet } = {}) {
  publicPaper = freshPaperState(bankroll ?? PILOT.initialBankroll);
  if (wallet) {
    publicPaper.wallet = {
      address: String(wallet.address || '').toLowerCase(),
      chainId: Number(wallet.chainId) || 137,
      connectedAt: Date.now(),
    };
    publicPaper.deployedAt = Date.now();
  }
  publicPaper.events.unshift({
    id: `paper_reset_${Date.now()}`,
    type: 'deploy',
    message: `Deployed $${publicPaper.initialBankroll.toFixed(0)} paper capital${wallet?.address ? ` · ${String(wallet.address).slice(0, 6)}…${String(wallet.address).slice(-4)}` : ''}`,
    timestamp: Date.now(),
  });
  return publicPaperSnapshot();
}

export function attachPilotWallet(wallet) {
  if (!wallet?.address) return publicPaperSnapshot();
  publicPaper.wallet = {
    address: String(wallet.address).toLowerCase(),
    chainId: Number(wallet.chainId) || 137,
    connectedAt: Date.now(),
  };
  if (!publicPaper.deployedAt) publicPaper.deployedAt = Date.now();
  return publicPaperSnapshot();
}

function buildPredictionResponse(polyState) {
  const ml = collectModelData();
  const signals = collectSignalSummary(polyState);
  const spot = getSpotPriceSnapshot();
  const confidence = getConfidenceBufferStats();
  const btcConsensus = getConsensus('btc');
  const ethConsensus = getConsensus('eth');
  const btcTrace = getPriceTrace('btc');
  const ethTrace = getPriceTrace('eth');

  const markets = (polyState?.markets || []).filter(m => m.isCurrent).map(m => {
    const p = m.prices || {};
    return {
      slug: m.slug,
      symbol: m.symbol,
      title: m.title || m.question || m.slug,
      question: m.question || null,
      isCurrent: true,
      closesAt: m.closesAt || m.endAtMs || null,
      eventStartTime: m.eventStartTime || null,
      remaining: m.remaining,
      prices: { up: p.up, down: p.down },
      priceSource: m.priceSource || p._source || null,
      priceToBeat: m.priceToBeat ?? m.priceToBeatMeta?.openPrice ?? null,
      oracleClose: m.oracleClose ?? m.priceToBeatMeta?.closePrice ?? null,
      vsBeat: m.vsBeat || null,
      depth: m.depth ? {
        up: m.depth.up ? { bestBid: m.depth.up.bestBid, bestAsk: m.depth.up.bestAsk, mid: m.depth.up.mid, spreadPct: m.depth.up.spreadPct } : null,
        down: m.depth.down ? { bestBid: m.depth.down.bestBid, bestAsk: m.depth.down.bestAsk, mid: m.depth.down.mid, spreadPct: m.depth.down.spreadPct } : null,
      } : null,
      action: m.action || null,
      decision: m.decision || null,
      signal: m.signal || null,
    };
  });

  const currentMarket = markets[0] || null;
  const priceToBeat = {};
  for (const m of markets) {
    const key = String(m.symbol || '').toLowerCase();
    if (!key || m.priceToBeat == null) continue;
    priceToBeat[key] = {
      symbol: m.symbol,
      slug: m.slug,
      openPrice: m.priceToBeat,
      closePrice: m.oracleClose,
      vsBeat: m.vsBeat,
      eventStartTime: m.eventStartTime,
      remaining: m.remaining,
      question: m.question,
      note: `Polymarket resolves UP if end price ≥ open ($${m.priceToBeat}).`,
    };
  }

  let targetPrice = null;
  if (currentMarket) {
    const midUp = currentMarket.prices?.up ?? currentMarket.depth?.up?.mid;
    const midDown = currentMarket.prices?.down ?? currentMarket.depth?.down?.mid;
    const midPrice = midUp != null ? midUp : midDown;
    const price = midPrice || spot[currentMarket.symbol?.toLowerCase() === 'btc' ? 'btc' : 'eth']?.price;
    if (price != null) {
      const assetModels = ml.models[currentMarket.symbol === 'BTC' ? 'BTC' : 'ETH'] || [];
      const bestModel = assetModels
        .filter(m => m.status === 'healthy' && m.confidence != null)
        .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0];
      const signal = signals[currentMarket.symbol?.toLowerCase() || 'btc'];
      if (bestModel && bestModel.expectedReturn != null) {
        const dir = bestModel.direction === 1 ? 1 : bestModel.direction === -1 ? -1 : 0;
        const move = dir * bestModel.expectedReturn * (bestModel.confidence || 0.5);
        const predicted = price * (1 + move);
        targetPrice = {
          current: price,
          predicted: Math.max(0.001, Math.min(0.999, predicted)),
          direction: dir > 0 ? 'up' : dir < 0 ? 'down' : 'neutral',
          confidence: bestModel.confidence,
          expectedReturn: bestModel.expectedReturn,
          modelId: bestModel.id,
          modelLabel: bestModel.label,
        };
      } else if (signal && signal.direction !== 'neutral' && signal.confidence > 0) {
        const dir = signal.direction === 'up' ? 1 : -1;
        const move = dir * signal.confidence * 0.02;
        targetPrice = {
          current: price,
          predicted: Math.max(0.001, Math.min(0.999, price * (1 + move))),
          direction: signal.direction,
          confidence: signal.confidence,
          source: 'signal',
        };
      }
    }
  }

  const window = currentMarket
    ? {
        slug: currentMarket.slug,
        symbol: currentMarket.symbol,
        closesAt: currentMarket.closesAt,
        remaining: currentMarket.remaining,
        prices: currentMarket.prices,
      }
    : null;
  const paper = updatePublicPaper(signals, markets, polyState?.markets || []);
  const botPaper = summarizeBotPaper(polyState);
  const signalTs = Math.max(
    Number(signals?.btc?.timestamp || 0),
    Number(signals?.eth?.timestamp || 0),
  );
  const feed = {
    status: signals?.btc || signals?.eth ? 'live' : 'warming',
    lastSignalAt: signalTs || null,
    ageMs: signalTs ? Math.max(0, Date.now() - signalTs) : null,
    intervalMs: 2000,
    botRunning: !!polyState?.running,
    note: 'Public TA feed runs independently of the trading bot.',
  };
  const dataAssurance = polyState?.dataAssurance || buildDataAssurance({
    spotPrices: {
      btc: spot?.btc ? { price: spot.btc.price ?? spot.btc, ts: spot.btc.ts || Date.now() } : null,
      eth: spot?.eth ? { price: spot.eth.price ?? spot.eth, ts: spot.eth.ts || Date.now() } : null,
    },
    signals,
    feed,
    markets,
    positions: polyState?.positions || [],
    cashAudit: polyState?.cashAudit || { ok: true },
    priceToBeat,
    lastScan: polyState?.lastScan,
    botRunning: !!polyState?.running,
  });

  return {
    timestamp: Date.now(),
    spot,
    signals,
    ml,
    confidence,
    consensus: { btc: btcConsensus, eth: ethConsensus },
    traces: { btc: btcTrace, eth: ethTrace },
    markets,
    currentMarket,
    priceToBeat,
    targetPrice,
    window,
    paper,
    botPaper,
    publishedPaper: botPaper,
    dataAssurance,
    pilot: {
      paper,
      bot: botPaper,
      product: 'Zinger Pilot',
      app: 'zinger.xyz',
      custody: 'paper_simulated',
      note: 'Pilot product surface lives on zinger.xyz — playground publishes the experiment bot paper book.',
    },
    feed,
  };
}

function summarizeBotPaper(polyState) {
  const portfolio = polyState?.portfolio || null;
  const cfg = polyState?.config || {};
  const initialBankroll = Number(cfg.paperInitialDeposit ?? cfg.paperBankroll ?? 1000) || 1000;
  const allTrades = (polyState?.trades || []).filter((t) => t.mode === 'paper' || !t.mode);
  const open = (polyState?.positions || []).filter((p) => !p.closed && (p.mode === 'paper' || !p.mode));
  const closed = allTrades.filter((t) => t.closed);
  const wins = closed.filter((t) => Number(t.pnl) > 0).length;
  const losses = closed.filter((t) => Number(t.pnl) <= 0).length;
  const cash = Number(portfolio?.paperBankroll ?? polyState?.paperBankroll ?? initialBankroll);
  const equity = Number(portfolio?.equity ?? portfolio?.paperEquity ?? cash);
  const realizedPnl = Number(portfolio?.paperStats?.totalPnl ?? portfolio?.realizedPnl ?? 0);
  const feesPaid = Math.round(
    (open.reduce((sum, p) => sum + Number(p.feesPaid || p.entryFee || 0), 0)
      + closed.reduce((sum, t) => sum + Number(t.feesPaid || 0), 0)) * 1e5,
  ) / 1e5;

  const openRows = open.slice(0, 12).map((p) => {
    const asset = String(p.symbol || '').toUpperCase();
    const entry = Number(p.entryPrice);
    const mark = Number(p.currentPrice ?? p.entryPrice);
    const cost = Number(p.costBasis || p.size || 0);
    return {
      asset,
      symbol: asset,
      outcome: String(p.outcome || '').toLowerCase(),
      entry,
      mark,
      cost,
      size: cost,
      shares: Number(p.shares || 0) || null,
      unrealizedPnl: Number(p.pnl ?? ((mark - entry) * Number(p.shares || 0))),
      pnl: Number(p.pnl || 0),
      feesPaid: Number(p.feesPaid || 0),
      entryFee: Number(p.entryFee || 0),
      takeProfit: Number(p.tpPrice || 0) || null,
      stopLoss: Number(p.slPrice || 0) || null,
      slug: p.slug || null,
    };
  });

  const tradeRows = closed.slice(0, 40).map((t) => ({
    asset: String(t.symbol || '').toUpperCase(),
    symbol: String(t.symbol || '').toUpperCase(),
    outcome: String(t.outcome || '').toLowerCase(),
    entry: Number(t.entryPrice),
    exit: Number(t.exitPrice),
    pnl: Number(t.pnl || 0),
    feesPaid: Number(t.feesPaid || 0),
    reason: t.exitReason || t.reason || 'close',
    closedAt: t.closedAt || t.timestamp || null,
    timestamp: t.timestamp || t.closedAt || null,
    slug: t.slug || null,
  }));

  const events = (polyState?.actions || [])
    .slice(0, 40)
    .map((a) => ({
      type: a.type || 'system',
      message: a.msg || a.message || '',
      timestamp: a.time || a.timestamp || Date.now(),
      pnl: a.meta?.pnl ?? null,
      fee: a.meta?.entryFee ?? a.meta?.fee ?? null,
    }));

  return {
    source: process.env.ZINGER_INSTANCE === 'pilot' ? 'pilot_bot' : 'experiment_bot',
    published: process.env.ZINGER_INSTANCE !== 'pilot',
    note: process.env.ZINGER_INSTANCE === 'pilot'
      ? 'Pilot instance book — not the playground published feed.'
      : 'Published on Playground Signals via /api/v1/bot-paper.',
    status: polyState?.running ? 'running' : 'stopped',
    running: !!polyState?.running,
    mode: cfg.mode || polyState?.mode || 'paper',
    instance: process.env.ZINGER_INSTANCE || 'experiment',
    initialBankroll,
    cash: Math.round(cash * 100) / 100,
    equity: Math.round(equity * 100) / 100,
    realizedPnl: Math.round(realizedPnl * 100) / 100,
    feesPaid,
    openCount: open.length,
    open: openRows,
    trades: tradeRows,
    recentTrades: tradeRows.slice(0, 20),
    events,
    wins,
    losses,
    winRate: closed.length ? Math.round((wins / closed.length) * 1000) / 10 : null,
    sizing: {
      bankroll: initialBankroll,
      maxCashFrac: Number(cfg.maxPositionPct ?? 0.10),
      entryBand: [Number(cfg.minPrice ?? 0.42), Number(cfg.maxPrice ?? 0.68)],
      fees: cfg.simulateClobFees === false
        ? 'off'
        : 'CLOB market fd.r/e on open/exit; settle/redeem exit fee $0',
    },
    updatedAt: Date.now(),
  };
}

function buildMarketsResponse(polyState) {
  return {
    timestamp: Date.now(),
        markets: (polyState?.markets || []).map(m => {
      const p = m.prices || {};
      return {
        slug: m.slug,
        symbol: m.symbol,
        duration: m.duration || null,
        title: m.title || m.question || m.slug,
        question: m.question || null,
        isCurrent: m.isCurrent,
        closesAt: m.closesAt || m.endAtMs || null,
        eventStartTime: m.eventStartTime || null,
        remaining: m.remaining,
        prices: { up: p.up, down: p.down },
        priceToBeat: m.priceToBeat ?? null,
        oracleClose: m.oracleClose ?? null,
        vsBeat: m.vsBeat || null,
        priceSource: m.priceSource || null,
        depth: m.depth ? {
          up: m.depth.up ? { bestBid: m.depth.up.bestBid, bestAsk: m.depth.up.bestAsk, mid: m.depth.up.mid } : null,
          down: m.depth.down ? { bestBid: m.depth.down.bestBid, bestAsk: m.depth.down.bestAsk, mid: m.depth.down.mid } : null,
        } : null,
        volume: m.volume || null,
        liquidity: m.liquidity || null,
      };
    }),
  };
}

async function buildSingleMarketResponse(slug, polyState) {
  const market = (polyState?.markets || []).find(m => m.slug === slug) || null;
  if (!market) return null;
  const tids = market.tokenIds || {};
  const upId = tids.up || tids.UP;
  const downId = tids.down || tids.DOWN;
  const upBook = upId ? await getOrderBook(upId).catch(() => null) : null;
  const downBook = downId ? await getOrderBook(downId).catch(() => null) : null;
  const upMid = upId ? await getMidPrice(upId).catch(() => null) : null;
  const downMid = downId ? await getMidPrice(downId).catch(() => null) : null;

  const mp = market.prices || {};
  const prices = { up: mp.up ?? upMid, down: mp.down ?? downMid };
  const midPrice = prices.up != null ? prices.up : prices.down;
  const ml = collectModelData();
  const signal = collectSignalSummary(polyState)[market.symbol?.toLowerCase() || 'btc'];

  let targetPrice = null;
  if (midPrice != null) {
    const asset = market.symbol === 'BTC' ? 'BTC' : 'ETH';
    const assetModels = ml.models[asset] || [];
    const best = assetModels
      .filter(m => m.status === 'healthy' && m.confidence != null)
      .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0];
    if (best && best.expectedReturn != null) {
      const dir = best.direction === 1 ? 1 : best.direction === -1 ? -1 : 0;
      const move = dir * best.expectedReturn * (best.confidence || 0.5);
      targetPrice = {
        current: midPrice,
        predicted: Math.max(0.001, Math.min(0.999, midPrice * (1 + move))),
        direction: dir > 0 ? 'up' : dir < 0 ? 'down' : 'neutral',
        confidence: best.confidence,
        expectedReturn: best.expectedReturn,
        modelId: best.id,
        modelLabel: best.label,
        source: 'ml',
      };
    } else if (signal && signal.direction !== 'neutral' && signal.confidence > 0) {
      const dir = signal.direction === 'up' ? 1 : -1;
      const move = dir * signal.confidence * 0.02;
      targetPrice = {
        current: midPrice,
        predicted: Math.max(0.001, Math.min(0.999, midPrice * (1 + move))),
        direction: signal.direction,
        confidence: signal.confidence,
        source: 'signal',
      };
    }
  }

  return {
    slug: market.slug,
    symbol: market.symbol,
    title: market.title || market.slug,
    isCurrent: market.isCurrent,
    closesAt: market.closesAt,
    remaining: market.remaining,
    prices,
    depth: {
      up: upBook ? { bestBid: upBook.bestBid ?? upBook.bids?.[0]?.price, bestAsk: upBook.bestAsk ?? upBook.asks?.[0]?.price, mid: upMid } : null,
      down: downBook ? { bestBid: downBook.bestBid ?? downBook.bids?.[0]?.price, bestAsk: downBook.bestAsk ?? downBook.asks?.[0]?.price, mid: downMid } : null,
    },
    targetPrice,
    action: market.action || null,
    decision: market.decision || null,
    signal: market.signal || null,
    volume: market.volume || null,
    liquidity: market.liquidity || null,
  };
}

function buildSpotChartResponse(asset, limit = 1600) {
  const ticks = getSpotHistory(asset, limit);
  const snap = getSpotPriceSnapshot();
  return {
    asset,
    ticks,
    current: snap[asset]?.price || null,
    count: ticks.length,
    timestamp: Date.now(),
  };
}

export function registerPublicAPI(app, getPolyState) {
  const ensurePredictionNotifier = () => {
    if (_notifyPredictions) return;
    _notifyPredictions = setInterval(() => {
      if (predictionSseClients.size === 0 && paperSseClients.size === 0) return;
      const state = getPolyState({ lean: true });
      const payload = buildPredictionResponse(state);
      if (predictionSseClients.size > 0) sendSSE(predictionSseClients, payload);
      if (paperSseClients.size > 0) sendSSE(paperSseClients, payload.botPaper);
    }, 1000);
  };

  // CORS preflight middleware for all v1 routes
  app.use('/api/v1', (req, res, next) => {
    res.set(corsHeaders());
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

  app.get('/api/v1/predictions', (req, res) => {
    const state = getPolyState({ lean: true });
    res.set(corsHeaders()).json(buildPredictionResponse(state));
  });

  app.get('/api/v1/predictions/stream', (req, res) => {
    sseSetup(req, res, predictionSseClients);
    const state = getPolyState({ lean: true });
    res.write(`data: ${JSON.stringify(buildPredictionResponse(state))}\n\n`);
    ensurePredictionNotifier();
  });

  app.get('/api/v1/paper', (req, res) => {
    const state = getPolyState({ lean: true });
    const body = buildPredictionResponse(state);
    // Playground publishes the live experiment bot paper book by default.
    // ?source=demo keeps the educational mid-fill sim.
    const source = String(req.query.source || 'bot').toLowerCase();
    const payload = source === 'demo' ? body.paper : body.botPaper;
    res.set(corsHeaders()).json(payload);
  });

  app.get('/api/v1/paper/stream', (req, res) => {
    sseSetup(req, res, paperSseClients);
    const state = getPolyState({ lean: true });
    const body = buildPredictionResponse(state);
    res.write(`data: ${JSON.stringify(body.botPaper)}\n\n`);
    ensurePredictionNotifier();
  });

  app.get('/api/v1/bot-paper', (req, res) => {
    const state = getPolyState({ lean: true });
    res.set(corsHeaders()).json(buildPredictionResponse(state).botPaper);
  });

  app.get('/api/v1/data-health', async (req, res) => {
    const state = getPolyState({ lean: true });
    const body = buildPredictionResponse(state);
    const withTimeout = (promise, ms, fallback) => Promise.race([
      promise,
      new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
    ]);
    const [geoblockProxy, geoblockDirect, proxyHealth] = await Promise.all([
      withTimeout(checkGeoblock(), 4000, { ok: false, blocked: true, error: 'timeout' }),
      withTimeout(checkGeoblockDirect(), 4000, { ok: false, blocked: true, error: 'timeout' }),
      withTimeout(checkProxyHealth(), 4000, { ok: false, configured: true, detail: 'timeout' }),
    ]);
    const clobMarkets = (body.markets || []).filter((m) => m?.isCurrent);
    const clobWsOk = (m) => ['clob-ws', 'clob', 'clob-mixed', 'mixed'].includes(m.priceSource);
    const clobSourced = clobMarkets.filter(clobWsOk).length;
    const wsSnap = getClobWsSnapshot();
    const wsFresh = wsSnap.connected && wsSnap.lastMsgAgeMs != null && wsSnap.lastMsgAgeMs < 15000;
    res.set(corsHeaders()).json({
      ok: body.dataAssurance?.ok !== false,
      timestamp: body.timestamp,
      dataAssurance: body.dataAssurance,
      feed: body.feed,
      feeds: {
        binance: {
          ok: !!(body.spot?.btc?.price && body.spot?.eth?.price),
          btc: body.spot?.btc?.price ?? null,
          eth: body.spot?.eth?.price ?? null,
          source: 'binance',
        },
        chainlink: {
          ok: !!(body.priceToBeat?.btc?.openPrice && body.priceToBeat?.eth?.openPrice),
          btcOpen: body.priceToBeat?.btc?.openPrice ?? null,
          ethOpen: body.priceToBeat?.eth?.openPrice ?? null,
          source: 'polymarket-chainlink',
        },
        clob: {
          ok: clobSourced > 0 || wsFresh,
          sourced: `${clobSourced}/${clobMarkets.length}`,
          priceSources: clobMarkets.map((m) => ({
            slug: m.slug,
            source: m.priceSource || null,
            up: m.prices?.up ?? null,
            down: m.prices?.down ?? null,
          })),
          ws: {
            connected: wsSnap.connected,
            subscribed: wsSnap.subscribed,
            books: wsSnap.books,
            msgCount: wsSnap.msgCount,
            lastMsgAgeMs: wsSnap.lastMsgAgeMs,
          },
          writeProxy: proxyHealth,
          note: wsFresh
            ? 'UP/DOWN mids from CLOB WebSocket (direct)'
            : clobSourced > 0
              ? 'UP/DOWN mids from CLOB REST (direct)'
              : 'Falling back to Gamma mids',
        },
      },
      geoblock: {
        direct: geoblockDirect,
        viaProxy: geoblockProxy,
        liveAllowed: (!geoblockDirect.blocked) || proxyHealth.ok || (geoblockProxy && geoblockProxy.blocked === false),
      },
      session: (() => {
        const cur = getSessionLedger(5).current;
        if (!cur) return null;
        return {
          id: cur.id,
          mode: cur.mode,
          status: cur.status,
          sessionPnl: cur.sessionPnl,
          uptimeMs: cur.uptimeMs,
          reconcile: cur.reconcile,
        };
      })(),
      priceToBeat: body.priceToBeat,
      cashAudit: state?.cashAudit || null,
      bot: {
        running: !!state?.running,
        mode: state?.mode || state?.config?.mode || null,
        lastScan: state?.lastScan || null,
      },
    });
  });

  app.get('/api/v1/session', (req, res) => {
    const ledger = getSessionLedger(Number(req.query?.limit) || 12);
    const state = getPolyState({ lean: true });
    res.set(corsHeaders()).json({
      timestamp: Date.now(),
      botRunning: !!state?.running,
      mode: state?.mode || state?.config?.mode || null,
      session: state?.session || null,
      ledger,
      liveAccount: state?.liveAccount || getLiveAccount(20),
      clobWs: getClobWsSnapshot(),
      cashAudit: state?.cashAudit || null,
      narrative: state?.narrative || null,
      liveScoreCards: state?.liveScoreCards || [],
      account: state?.account
        ? {
            stats: state.account.stats,
            curve: {
              updatedAt: state.account.curve?.updatedAt,
              points: (state.account.curve?.points || []).slice(-120),
            },
            snapshot: state.account.snapshot
              ? { mime: state.account.snapshot.mime, dataUrl: state.account.snapshot.dataUrl }
              : null,
          }
        : null,
      liveTrading: {
        botRunning: !!state?.running,
        mode: state?.mode || state?.config?.mode || null,
        liveReady: !!state?.readiness?.liveReady,
        liveAllowed: !!state?.edgeGate?.liveAllowed,
        writeEgress: process.env.CLOB_PROXY_URL ? 'proxied' : 'direct',
        note: 'CLOB reads via WS/direct; live order writes use CLOB_PROXY_URL when set. Mode stays paper until explicitly switched.',
      },
      edgeGate: state?.edgeGate || null,
    });
  });

  app.get('/api/v1/live-account', async (req, res) => {
    const refresh = String(req.query?.refresh || '') === '1' || String(req.query?.sync || '') === '1';
    const state = getPolyState({ lean: true });
    let account = getLiveAccount(Number(req.query?.limit) || 40);
    if (refresh) {
      account = await syncLiveAccount({
        botTrades: state?.trades || [],
        note: 'api_refresh',
      });
    }
    res.set(corsHeaders()).json({
      timestamp: Date.now(),
      ...account,
      note: 'Ground truth = Polymarket closed-positions + activity + CLOB cash. Bot fill marks are cross-checked for mismatches.',
    });
  });

  app.post('/api/v1/live-account/sync', async (req, res) => {
    const state = getPolyState({ lean: true });
    const account = await syncLiveAccount({
      botTrades: state?.trades || [],
      note: 'api_sync',
    });
    res.set(corsHeaders()).json({ ok: true, timestamp: Date.now(), ...account });
  });

  /** Public account book: equity curve, best trades, PnL snapshot, NLP narrative, score strip */
  app.get('/api/v1/account', (req, res) => {
    try {
      const state = getPolyState({ lean: false });
      res.set(corsHeaders()).json({
        ok: true,
        timestamp: Date.now(),
        mode: state?.mode || null,
        cashAudit: state?.cashAudit || null,
        narrative: state?.narrative || null,
        liveScoreCards: state?.liveScoreCards || [],
        accountBook: state?.account
          ? {
              stats: state.account.stats,
              curve: {
                updatedAt: state.account.curve?.updatedAt,
                points: (state.account.curve?.points || []).slice(-180),
              },
              snapshot: state.account.snapshot
                ? { mime: state.account.snapshot.mime, dataUrl: state.account.snapshot.dataUrl }
                : null,
              liveAccount: {
                cash: state.liveAccount?.cash || null,
                totals: state.liveAccount?.totals || null,
                reconcile: state.liveAccount?.reconcile || null,
                closed: (state.liveAccount?.closed || []).slice(0, 12),
                traces: (state.liveAccount?.traces || []).slice(0, 20),
              },
            }
          : null,
        session: state?.session || null,
      });
    } catch (err) {
      res.status(500).set(corsHeaders()).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/v1/clob-stream', (req, res) => {
    const snap = getClobWsSnapshot();
    const state = getPolyState({ lean: true });
    const markets = (state?.markets || [])
      .filter((m) => m.isCurrent)
      .map((m) => ({
        slug: m.slug,
        symbol: m.symbol,
        priceSource: m.priceSource,
        prices: m.prices,
        tokenIds: m.tokenIds,
      }));
    res.set(corsHeaders()).json({
      timestamp: Date.now(),
      stream: snap,
      markets,
    });
  });

  app.get('/api/v1/pilot', (req, res) => {
    const state = getPolyState({ lean: true });
    const body = buildPredictionResponse(state);
    const wallet = String(req.query?.address || '').toLowerCase();
    const account = wallet && /^0x[a-f0-9]{40}$/.test(wallet) ? getAccount(wallet) : getRunningSession();
    const paper = body.paper;
    const accounting = {
      equity: paper?.equity ?? account?.cash ?? 0,
      cash: account?.cash ?? paper?.cash ?? 0,
      realizedPnl: paper?.realizedPnl ?? 0,
      unrealizedPnl: paper?.unrealizedPnl ?? 0,
      clobFees: paper?.feesPaid ?? 0,
      platformFees: account?.platformFeesPaid ?? 0,
      winRate: paper?.winRate ?? null,
      wins: paper?.wins ?? 0,
      losses: paper?.losses ?? 0,
      openCount: paper?.open?.length ?? 0,
      depositedGross: account?.depositedGross ?? 0,
      withdrawn: account?.withdrawn ?? 0,
    };
    const sessionLedgerCurrent = getSessionLedger(5).current;
    res.set(corsHeaders()).json({
      timestamp: body.timestamp,
      paper,
      botPaper: body.botPaper,
      publishedPaper: body.botPaper,
      feed: body.feed,
      window: body.window,
      priceToBeat: body.priceToBeat,
      signals: body.signals,
      account,
      session: account?.session || { running: false },
      botSession: state?.session || null,
      sessionLedger: sessionLedgerCurrent
        ? {
            id: sessionLedgerCurrent.id,
            mode: sessionLedgerCurrent.mode,
            status: sessionLedgerCurrent.status,
            sessionPnl: sessionLedgerCurrent.sessionPnl,
            uptimeMs: sessionLedgerCurrent.uptimeMs,
            reconcile: sessionLedgerCurrent.reconcile,
            traces: (sessionLedgerCurrent.traces || []).slice(0, 25),
          }
        : null,
      clobWs: (() => {
        const s = getClobWsSnapshot();
        return {
          connected: s.connected,
          subscribed: s.subscribed,
          books: s.books,
          lastMsgAgeMs: s.lastMsgAgeMs,
        };
      })(),
      markets: (state?.markets || [])
        .filter((m) => m.isCurrent)
        .map((m) => ({
          slug: m.slug,
          symbol: m.symbol,
          duration: m.duration || null,
          prices: m.prices,
          priceSource: m.priceSource,
          priceToBeat: m.priceToBeat,
          remaining: m.remaining,
        })),
      opens: (state?.positions || [])
        .filter((p) => !p.closed)
        .slice(0, 24)
        .map((p) => ({
          id: p.id,
          symbol: p.symbol,
          slug: p.slug,
          duration: p.duration || null,
          outcome: p.outcome,
          mode: p.mode,
          entryPrice: p.entryPrice,
          mark: p.mark ?? p.currentPrice,
          shares: p.shares,
          size: p.sizeUsd ?? p.cost,
          pnl: p.pnl,
          gainPct: p.gainPct,
          remaining: p.remaining,
        })),
      liveAccount: state?.liveAccount || getLiveAccount(12),
      cashAudit: state?.cashAudit || null,
      narrative: state?.narrative || null,
      liveScoreCards: state?.liveScoreCards || [],
      accountBook: state?.account
        ? {
            stats: state.account.stats,
            curve: {
              updatedAt: state.account.curve?.updatedAt,
              points: (state.account.curve?.points || []).slice(-120),
            },
            snapshot: state.account.snapshot
              ? { mime: state.account.snapshot.mime, dataUrl: state.account.snapshot.dataUrl }
              : null,
          }
        : null,
      accounting,
      platformFeeRate: getPlatformFeeRate(),
      liveTrading: {
        botRunning: !!state?.running,
        mode: state?.mode || state?.config?.mode || null,
        liveReady: !!state?.readiness?.liveReady,
        liveAllowed: !!state?.edgeGate?.liveAllowed,
        writeEgress: process.env.CLOB_PROXY_URL ? 'proxied' : 'direct',
        note: 'CLOB reads via WS/direct; live order writes use CLOB_PROXY_URL when set',
      },
      edgeGate: state?.edgeGate || null,
      product: {
        name: 'Zinger',
        app: 'core',
        custody: 'paper_simulated',
      },
    });
  });

  app.post('/api/v1/pilot/connect', (req, res) => {
    const address = req.body?.address || req.query?.address;
    const chainId = req.body?.chainId || req.query?.chainId || 137;
    const ensured = ensureAccount({ address, chainId: Number(chainId) || 137 });
    if (!ensured.ok) {
      return res.set(corsHeaders()).status(400).json({ error: ensured.error });
    }
    const paper = attachPilotWallet({ address, chainId: Number(chainId) || 137 });
    res.set(corsHeaders()).json({ ok: true, paper, account: ensured.account });
  });

  app.post('/api/v1/pilot/account', (req, res) => {
    const address = req.body?.address;
    const chainId = req.body?.chainId || 137;
    const mode = req.body?.mode;
    let result = ensureAccount({ address, chainId });
    if (!result.ok) return res.set(corsHeaders()).status(400).json({ error: result.error });
    if (mode === 'paper' || mode === 'live') {
      result = setMode(address, mode);
    }
    res.set(corsHeaders()).json(result);
  });

  app.post('/api/v1/pilot/deposit', (req, res) => {
    const address = req.body?.address;
    const amount = Number(req.body?.amount ?? req.body?.bankroll);
    const result = ledgerDeposit({ address, amount });
    if (!result.ok) return res.set(corsHeaders()).status(400).json({ error: result.error });
    const addr = String(address).toLowerCase();
    attachPilotWallet({ address: addr, chainId: result.account.chainId });
    if (publicPaper.wallet?.address === addr) {
      publicPaper.cash = Math.round((Number(publicPaper.cash) + Number(result.net)) * 100) / 100;
    } else {
      publicPaper.cash = result.account.cash;
      publicPaper.wallet = { address: addr, chainId: result.account.chainId, connectedAt: Date.now() };
      if (!publicPaper.deployedAt) publicPaper.deployedAt = Date.now();
      if (!publicPaper.initialBankroll) publicPaper.initialBankroll = result.net;
    }
    publicPaper.events.unshift({
      id: `deposit_${Date.now()}`,
      type: 'deposit',
      message: `Deposit $${Number(result.gross).toFixed(2)} · platform fee $${Number(result.fee).toFixed(2)} · net $${Number(result.net).toFixed(2)}`,
      timestamp: Date.now(),
      fee: result.fee,
    });
    res.set(corsHeaders()).json({ ...result, paper: publicPaperSnapshot() });
  });

  app.get('/api/v1/pilot/deposit-info', async (req, res) => {
    const wallet = getWallet();
    const pusdBalance = await checkPusdBalance(wallet.polymarketDepositWallet).catch(() => 0n);
    res.set(corsHeaders()).json({
      receiveAddress: wallet.address,
      depositWallet: wallet.polymarketDepositWallet || null,
      depositWalletBalance: Number(pusdBalance) / 1_000_000,
      usdcAddress: POLY.usdc,
      pusdAddress: POLY.pUsd,
      chainId: POLY.chainId,
      network: 'Polygon Mainnet',
      note: 'Send USDC (Polygon native) to the receive address. The bot swaps to pUSD and credits your account.',
      scanActive: !!depositScannerCleanup,
    });
  });

  app.post('/api/v1/pilot/deposit-usdc', async (req, res) => {
    const address = req.body?.address;
    const txHash = req.body?.txHash;
    if (!address || !txHash) {
      return res.set(corsHeaders()).status(400).json({ error: 'address and txHash required' });
    }
    const wallet = normalizeAddress(address);
    if (!wallet) return res.set(corsHeaders()).status(400).json({ error: 'valid address required' });
    if (!/^0x[a-f0-9]{64}$/i.test(txHash)) {
      return res.set(corsHeaders()).status(400).json({ error: 'valid tx hash required' });
    }
    const result = await ledgerConfirmUsdcDeposit(wallet, txHash).catch(err => ({
      ok: false, error: err.message?.slice(0, 300) || 'deposit check failed',
    }));
    res.set(corsHeaders()).json(result);
  });

  app.get('/api/v1/pilot/deposits', (req, res) => {
    const address = req.query?.address;
    const wallet = normalizeAddress(address);
    if (!wallet) return res.set(corsHeaders()).json({ deposists: [] });
    const store = ledgerLoadStore();
    const acct = store.accounts[wallet];
    const deposits = acct?.usdcDeposits || [];
    res.set(corsHeaders()).json({ deposits });
  });

  app.post('/api/v1/pilot/withdraw', (req, res) => {
    const address = req.body?.address;
    const amount = Number(req.body?.amount);
    const result = ledgerWithdraw({ address, amount });
    if (!result.ok) return res.set(corsHeaders()).status(400).json({ error: result.error });
    if (publicPaper.wallet?.address === String(address).toLowerCase()) {
      publicPaper.cash = result.account.cash;
    }
    res.set(corsHeaders()).json({ ...result, paper: publicPaperSnapshot() });
  });

  app.post('/api/v1/pilot/rules', (req, res) => {
    const address = req.body?.address;
    const result = saveRules(address, req.body?.rules || req.body);
    if (!result.ok) return res.set(corsHeaders()).status(400).json({ error: result.error });
    res.set(corsHeaders()).json(result);
  });

  app.post('/api/v1/pilot/session/start', (req, res) => {
    const address = req.body?.address;
    const result = startSession(address);
    if (!result.ok) return res.set(corsHeaders()).status(400).json({ error: result.error });
    // Align paper book cash with account without wiping trade history if same wallet
    const addr = String(address).toLowerCase();
    if (publicPaper.wallet?.address !== addr || !(publicPaper.cash > 0)) {
      resetPublicPaper({
        bankroll: result.account.cash,
        wallet: { address, chainId: result.account.chainId },
      });
    } else {
      publicPaper.cash = result.account.cash;
      publicPaper.wallet = { address: addr, chainId: result.account.chainId, connectedAt: Date.now() };
    }
    res.set(corsHeaders()).json({ ...result, paper: publicPaperSnapshot() });
  });

  app.post('/api/v1/pilot/session/stop', (req, res) => {
    const address = req.body?.address;
    const result = stopSession(address);
    if (!result.ok) return res.set(corsHeaders()).status(400).json({ error: result.error });
    res.set(corsHeaders()).json({ ...result, paper: publicPaperSnapshot() });
  });

  app.post('/api/v1/pilot/deploy', (req, res) => {
    // Back-compat: treat as deposit + account ensure
    const bankroll = Number(req.body?.bankroll ?? 1000);
    const address = req.body?.address || null;
    const chainId = req.body?.chainId || 137;
    if (address) {
      ensureAccount({ address, chainId });
      const dep = ledgerDeposit({ address, amount: bankroll });
      if (!dep.ok) return res.set(corsHeaders()).status(400).json({ error: dep.error });
      const paper = resetPublicPaper({
        bankroll: dep.account.cash,
        wallet: { address, chainId },
      });
      return res.set(corsHeaders()).json({ ok: true, paper, account: dep.account, fee: dep.fee, net: dep.net });
    }
    if (!(bankroll >= 100 && bankroll <= 10000)) {
      return res.set(corsHeaders()).status(400).json({ error: 'bankroll must be 100–10000' });
    }
    const paper = resetPublicPaper({ bankroll, wallet: null });
    res.set(corsHeaders()).json({ ok: true, paper });
  });

  app.get('/api/v1/markets', (req, res) => {
    const state = getPolyState({ lean: true });
    res.set(corsHeaders()).json(buildMarketsResponse(state));
  });

  app.get('/api/v1/market/:slug', async (req, res) => {
    const state = getPolyState({ lean: true });
    const result = await buildSingleMarketResponse(req.params.slug, state);
    if (!result) return res.set(corsHeaders()).status(404).json({ error: 'market not found' });
    res.set(corsHeaders()).json(result);
  });

  app.get('/api/v1/charts/spot', (req, res) => {
    const asset = req.query.asset || 'btc';
    const limit = parseInt(req.query.limit) || 500;
    if (!['btc', 'eth'].includes(asset)) {
      return res.set(corsHeaders()).status(400).json({ error: 'asset must be btc or eth' });
    }
    res.set(corsHeaders()).json(buildSpotChartResponse(asset, limit));
  });

  app.get('/api/v1/charts/spot/stream', (req, res) => {
    const asset = req.query.asset || 'btc';
    if (!['btc', 'eth'].includes(asset)) {
      return res.set(corsHeaders()).status(400).json({ error: 'asset must be btc or eth' });
    }
    sseSetup(req, res, spotSseClients, { asset });
    const limit = parseInt(req.query.limit) || 500;
    const data = buildSpotChartResponse(asset, limit);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    if (!_notifySpot) {
      _notifySpot = onSpotTick((asset, price, ts) => {
        if (spotSseClients.size === 0) return;
        const msg = `data: ${JSON.stringify({ asset, tick: { t: ts, price }, timestamp: Date.now() })}\n\n`;
        for (const client of spotSseClients) {
          if (client.asset !== asset) continue;
          try { client.res.write(msg); } catch { spotSseClients.delete(client); }
        }
      });
    }
  });

  app.get('/api/v1/target-price', async (req, res) => {
    const state = getPolyState({ lean: true });
    const currentMarkets = (state?.markets || []).filter(m => m.isCurrent);
    const slug = req.query.slug || currentMarkets[0]?.slug || null;
    const result = slug ? await buildSingleMarketResponse(slug, state) : null;
    if (!result?.targetPrice) {
      return res.set(corsHeaders()).json({ ok: false, error: 'no target price available', slug });
    }
    res.set(corsHeaders()).json({ ok: true, slug, ...result.targetPrice });
  });

  app.get('/api/v1/health', (req, res) => {
    const state = getPolyState({ lean: true });
    res.set(corsHeaders()).json({
      ok: true,
      timestamp: Date.now(),
      uptime: process.uptime(),
      bot: {
        running: !!state.running,
        mode: state.config?.mode || 'paper',
        liveReady: state.readiness?.liveReady || false,
      },
      models: collectModelData().health,
    });
  });

  if (!depositScannerCleanup) {
    depositScannerCleanup = startDepositScanner();
  }
}
