// @ts-nocheck
import { findMarkets, fetchPriceToBeat } from './markets.js';
import {
  takerFeeUsdc,
  takerFeeUsdcForToken,
  openCostWithFee,
  closeProceedsWithFee,
  closeProceedsWithFeeForToken,
  isFeeFreeExit,
} from './fees.js';
import { buildDataAssurance, dataAssuranceBuyBlockReason } from './dataAssurance.js';
import { getPricesForMarket, getDepthForMarket } from './clob.js';
import {
  startClobMarketStream,
  setClobMarketTokens,
  getClobWsSnapshot,
} from './clobWs.js';
import {
  startSessionLedger,
  endSessionLedger,
  traceSession,
  updateSessionMarks,
  reconcileSession,
  getSessionLedger,
} from './sessionLedger.js';
import {
  syncLiveAccount,
  markLiveSessionStart,
  markLiveSessionEnd,
  traceLiveFill,
  getLiveAccount,
} from './liveAccount.js';
import { buildSystemNarrative, buildLiveScoreCards } from './accountNarrative.js';
import { appendEquityPoint, buildAccountBundle } from './accountSnapshot.js';
import { getRemainingSeconds, getRemainingMs, getCycleEndMs, formatRemainingMs, POLY_MIN_ORDER_USD, POLY_SCAN_INTERVAL_MS, POLY_WINDOW_SECONDS, durationFromSlug, windowSecondsForDuration } from './config.js';
import { getSignalForBoth } from './signal.js';
import { getMLSignalForBoth, getMLTraceForBoth } from './predict.js';
import { addMLPrediction, addPriceTrace, getConfidenceBias, getConfidenceBufferStats, getPriceTrace } from './confidence.js';
import { addSpotTick } from './spotPriceHistory.js';
import { getModelStates, getModelHealth, onModelChange } from './modelRegistry.js';
import { persist, persistSync, load, FILES, dataPath } from './persistence.js';
import { placeOrder, placeMarketSell, syncClobBalance } from './trade.js';
import { checkReadiness } from './readiness.js';
import { computeKellySize, computeCertaintyKelly, resolveDynamicLimits, setKellyTradeHistory, getKellyStats, buildDynamicPlan, checkTrailingStop, checkPartialProfit, resolveAdaptiveSl } from './kelly.js';
import {
  dedupeTrades,
  computeTradeStats,
  runAudit,
  loadBaseline,
  saveBaseline,
  normalizeTrade,
  tradeRealizedPnl,
  tradeCostBasis,
} from './audit.js';
import { evaluateEdgeGate, passesEdgeFilter } from './edge.js';
import { recordTradeSample } from './heuristics/tradeCollector.js';
import {
  heuristicForTrade,
  resolveEntryWindows,
  overlayPlanWithHeuristics,
  manageEnvironment,
} from './heuristics/fundHeuristics.js';
import {
  normalizeConfigStore,
  resolveActiveConfig,
  applyConfigPatch,
  defaultPaperStrategy,
  defaultLiveStrategy,
} from './modeConfig.js';
import {
  currentWallWindow,
  marketWindow,
  parseSlugWindow,
  computeWindowStats,
  windowKeyFromTrade,
} from './windows.js';
import {
  saveConfigSession,
  listConfigSessions,
  getConfigSession,
  analyzeConfigSessions,
} from './configSessions.js';
import { llmStatus } from '../ai/llm.js';
import { runOptimizer, getOptimizerStatus, recordCycleSession, loadSessionPerf } from '../ai/optimizer.js';
import { runGovernor, getGovernorStatus, getActiveProfile, computeProfilePerf } from '../ai/governor.js';

let botState = {
  running: false,
  interval: null,
  configStore: loadConfigStore(),
  config: null,
  markets: [],
  positions: loadPositions(),
  trades: loadTrades(),
  actions: loadActions(),
  signals: { btc: null, eth: null },
  stats: { totalTrades: 0, wins: 0, losses: 0, totalPnl: 0, winRate: 0, bestTrade: 0, worstTrade: 0, scansDone: 0 },
  telemetry: { uptime: 0, usdcBalance: 0, openValue: 0, totalFees: 0, signalsToday: 0, polyBalance: 0 },
  readiness: null,
  diagnostics: [],
  executionLog: [],
  lastScan: null,
  lastScanLog: null,
  pendingTrades: [],
  announcements: [],
  notifications: [],
  traces: { events: [], decisions: [], exits: [] },
  _scanning: false,
  _refreshingMarkets: false,
  _buyLocks: new Set(),
  _stateListeners: [],
  _chartTicks: {},
  spotPrices: { btc: null, eth: null },
  cycleReward: null,
  settle: { lastCycle: null, pending: null, history: [] },
  _cycleKey: null,
  _cycleSettleAccum: { pnl: 0, closes: 0, rewards: 0, tp: 0, sl: 0, trail: 0, settle: 0, partial: 0 },
  windows: { current: null, history: [] },
  stopRequest: null,
  session: null,
  sessionHistory: [],
  _optimizerTimer: null,
  _governorTimer: null,
};
syncConfigFromStore();

export function onStateChange(fn) {
  botState._stateListeners.push(fn);
  return () => {
    botState._stateListeners = botState._stateListeners.filter(f => f !== fn);
  };
}

function notifyStateChange() {
  for (const fn of botState._stateListeners) {
    try { fn(); } catch {}
  }
}

let _notifyTimer = null;
/** Debounced notify — prevents SSE floods on every tick */
function notifyStateChangeDebounced(ms = 120) {
  if (_notifyTimer) return;
  _notifyTimer = setTimeout(() => {
    _notifyTimer = null;
    notifyStateChange();
  }, ms);
}

function flatDefaults() {
  return {
    enabled: false,
    mode: 'paper',
    ...defaultPaperStrategy(),
    paperBankroll: 1000,
    paperInitialDeposit: 1000,
  };
}

function resolveMarketDurations(cfg = botState.config) {
  if (Array.isArray(cfg?.enabledDurations) && cfg.enabledDurations.length) {
    return cfg.enabledDurations;
  }
  return cfg?.use15m === false ? ['5m'] : ['5m', '15m', '30m', '1h'];
}

export function loadConfig() {
  const existing = load(FILES.CONFIG, null);
  const store = normalizeConfigStore(existing, flatDefaults());
  return resolveActiveConfig(store);
}

function loadConfigStore() {
  const existing = load(FILES.CONFIG, null);
  return normalizeConfigStore(existing, flatDefaults());
}

function syncConfigFromStore() {
  botState.config = resolveActiveConfig(botState.configStore);
}

export function saveConfig(cfg) {
  const patch = cfg || {};
  let store = applyConfigPatch(botState.configStore || loadConfigStore(), patch);

  // Switching to live: evaluate gate against PAPER expectancy only (isolation)
  if (store.mode === 'live') {
    const liveFlat = resolveActiveConfig({ ...store, mode: 'live' });
    const gate = evaluateEdgeGate(botState.trades, liveFlat);
    if (!gate.liveAllowed) {
      store = { ...store, mode: 'paper' };
      log(`🔒 LIVE blocked — ${gate.reason} (paper WR ${(gate.wr * 100).toFixed(1)}% · E $${gate.expectancy})`, 'system', { edgeGate: gate });
    }
  }

  botState.configStore = store;
  syncConfigFromStore();
  // Persist dual-profile shape (not flat) so strategies stay isolated on disk
  persistSync(FILES.CONFIG, {
    mode: store.mode,
    enabled: store.enabled,
    paperBankroll: store.paperBankroll,
    paperInitialDeposit: store.paperInitialDeposit,
    profiles: store.profiles,
  });
  notifyStateChange();
}

function loadTrades() {
  const raw = load(FILES.TRADES, []);
  return Array.isArray(raw) ? raw.map(normalizeTrade) : [];
}

function loadPositions() {
  return load(FILES.POSITIONS, []);
}

function loadActions() {
  return load(FILES.ACTIONS, []);
}

function saveState() {
  persist(FILES.POSITIONS, botState.positions);
  persist(FILES.ACTIONS, botState.actions.slice(0, 300));
  notifyStateChange();
}

function saveTrade(trade) {
  const fromSlug = parseSlugWindow(trade?.slug);
  const normalized = normalizeTrade({
    ...trade,
    duration: trade?.duration || fromSlug?.duration || null,
    windowSeconds: trade?.windowSeconds || fromSlug?.windowSec || null,
  });
  if (!normalized.id) {
    normalized.id = `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  }
  const dupe = botState.trades.find((t) =>
    t.id && normalized.id && t.id === normalized.id
  );
  if (dupe) return;
  // Near-identical fills within 5s (same mode/slug/outcome/exit/pnl)
  const near = botState.trades.find((t) =>
    t.mode === normalized.mode
    && t.slug === normalized.slug
    && t.outcome === normalized.outcome
    && t.exitReason === normalized.exitReason
    && Math.abs((t.pnl || 0) - (normalized.pnl || 0)) < 0.001
    && Math.abs((t.timestamp || t.entryTime || 0) - (normalized.timestamp || normalized.entryTime || 0)) < 5000
  );
  if (near) return;
  botState.trades.unshift(normalized);
  persist(FILES.TRADES, botState.trades.slice(0, 500));
  refreshKellyHistory();
}

/** Rebuild paper spendable cash from initial + closed PnL − open cost (idempotent). */
function reconcilePaperCash(reason = 'reconcile') {
  if (botState.config.mode !== 'paper') return null;
  const initial = Number(botState.config.paperInitialDeposit ?? 100);
  const paperTrades = dedupeTrades(botState.trades).filter((t) => t.mode === 'paper');
  const realized = paperTrades.reduce((s, t) => s + Number(t.pnl || 0), 0);
  const openCost = botState.positions
    .filter((p) => !p.closed && p.mode === 'paper')
    .reduce((s, p) => s + Number(p.costBasis || p.size || 0), 0);
  const next = Math.round((initial + realized - openCost) * 100) / 100;
  const prev = Number(botState.config.paperBankroll ?? initial);
  if (Math.abs(prev - next) < 0.01) return prev;
  botState.config.paperBankroll = next;
  saveConfig({ paperBankroll: next });
  log(`💵 PAPER CASH reconcile $${prev.toFixed(2)} → $${next.toFixed(2)} · ${reason}`, 'system');
  return next;
}

/** Paper cash ledger — spendable bankroll in config.paperBankroll */
function adjustPaperCash(delta, reason = '') {
  if (botState.config.mode !== 'paper') return null;
  const current = Number(botState.config.paperBankroll ?? botState.config.paperInitialDeposit ?? 100);
  const next = Math.round((current + Number(delta || 0)) * 100) / 100;
  botState.config.paperBankroll = next;
  saveConfig({ paperBankroll: next });
  if (reason) {
    log(`💵 PAPER CASH ${delta >= 0 ? '+' : ''}${Number(delta).toFixed(2)} → $${next.toFixed(2)} · ${reason}`, 'system');
  }
  return next;
}

function countOpenPositions(mode = botState.config.mode) {
  return botState.positions.filter((p) => !p.closed && (!mode || p.mode === mode)).length;
}

/** Recent closed/open outcome mix — used to break chronic UP-only bias */
function sideBalanceStats(cfg) {
  const mode = cfg.mode || 'paper';
  const recent = dedupeTrades(botState.trades)
    .filter((t) => t.mode === mode)
    .slice(0, 50);
  const open = botState.positions.filter((p) => !p.closed && p.mode === mode);
  let up = 0;
  let down = 0;
  for (const t of recent) {
    if (t.outcome === 'up') up += 1;
    else if (t.outcome === 'down') down += 1;
  }
  for (const p of open) {
    if (p.outcome === 'up') up += 2;
    else if (p.outcome === 'down') down += 2;
  }
  const total = up + down;
  const upShare = total > 0 ? up / total : 0.5;
  return { up, down, total, upShare };
}

function sideBalanceBonus(outcome, cfg) {
  if (cfg.sideBalanceEnabled === false) return { bonus: 0, note: null };
  const weight = Number(cfg.sideBalanceWeight ?? 12);
  const { up, down, total, upShare } = sideBalanceStats(cfg);
  if (total < 5) return { bonus: 0, note: null, up, down, upShare };

  // Soft tilt only — never hard-force a side (FORCE DOWN caused live SL massacre)
  if (outcome === 'down' && upShare > 0.62) {
    return { bonus: weight * (upShare - 0.5) * 1.6, note: `soft-balance DOWN (+${((upShare - 0.5) * 100).toFixed(0)}% UP skew)`, up, down, upShare };
  }
  if (outcome === 'up' && upShare < 0.38) {
    return { bonus: weight * (0.5 - upShare) * 1.6, note: `soft-balance UP`, up, down, upShare };
  }
  if (outcome === 'up' && upShare > 0.70) {
    return { bonus: -weight * (upShare - 0.5) * 1.2, note: `UP overtraded soft`, up, down, upShare };
  }
  if (outcome === 'down' && (1 - upShare) > 0.70) {
    return { bonus: -weight * ((1 - upShare) - 0.5) * 1.2, note: `DOWN overtraded soft`, up, down, upShare };
  }
  return { bonus: 0, note: null, up, down, upShare };
}

function detectClobArb(depth, prices, cfg) {
  const upAsk = Number(depth?.up?.bestAsk || prices?.up || 0);
  const downAsk = Number(depth?.down?.bestAsk || prices?.down || 0);
  if (!(upAsk > 0.01 && downAsk > 0.01 && upAsk < 0.99 && downAsk < 0.99)) return null;
  const sum = upAsk + downAsk;
  const gap = 1 - sum;
  const minGap = Number(cfg.minArbGap ?? 0.015);
  if (gap < minGap) return null;
  return {
    upAsk,
    downAsk,
    sum: Math.round(sum * 1000) / 1000,
    gap: Math.round(gap * 1000) / 1000,
    edgePct: Math.round(gap * 1000) / 10,
  };
}

/**
 * If paper cash is negative (ledger drift / oversize opens), mark-close oldest
 * positions until books cash is non-negative (or opens cleared), then reconcile.
 */
function repairPaperOverdraft(reason = 'overdraft repair') {
  if (botState.config.mode !== 'paper') return null;
  const booksCash = () => {
    const initial = Number(botState.config.paperInitialDeposit ?? 100);
    const paperTrades = dedupeTrades(botState.trades).filter((t) => t.mode === 'paper');
    const realized = paperTrades.reduce((s, t) => s + Number(t.pnl || 0), 0);
    const openCost = botState.positions
      .filter((p) => !p.closed && p.mode === 'paper')
      .reduce((s, p) => s + Number(p.costBasis || p.size || 0), 0);
    return Math.round((initial + realized - openCost) * 100) / 100;
  };

  let guard = 0;
  while (booksCash() < -0.01 && guard < 120) {
    guard += 1;
    const open = botState.positions
      .filter((p) => !p.closed && p.mode === 'paper')
      .sort((a, b) => (a.entryTime || 0) - (b.entryTime || 0));
    if (!open.length) break;
    const pos = open[0];
    const price = Number(pos.currentPrice || pos.entryPrice || 0);
    if (!(price > 0)) break;
    markPosition(pos, price);
    const shares = positionShares(pos);
    const proceeds = Math.round(shares * price * 100) / 100;
    pos.exitPrice = price;
    pos.closed = true;
    pos.exitReason = 'repair';
    // Ledger will be rebuilt by reconcile — still credit for live log clarity
    adjustPaperCash(proceeds, `REPAIR ${pos.symbol} ${pos.outcome?.toUpperCase()}`);
    saveTrade({ ...pos, timestamp: Date.now() });
    log(`🧰 PAPER REPAIR close ${pos.symbol} ${pos.outcome?.toUpperCase()} @ $${price.toFixed(3)} · freed $${proceeds.toFixed(2)}`, 'system');
  }

  // Also trim down to max open so we don't sit oversized after a near-zero cash repair
  const maxOpen = Number(botState.config.maxOpenPositions ?? 6);
  let trim = 0;
  while (countOpenPositions('paper') > maxOpen && trim < 80) {
    trim += 1;
    const open = botState.positions
      .filter((p) => !p.closed && p.mode === 'paper')
      .sort((a, b) => (a.entryTime || 0) - (b.entryTime || 0));
    if (!open.length) break;
    const pos = open[0];
    const price = Number(pos.currentPrice || pos.entryPrice || 0);
    if (!(price > 0)) break;
    markPosition(pos, price);
    const shares = positionShares(pos);
    const proceeds = Math.round(shares * price * 100) / 100;
    pos.exitPrice = price;
    pos.closed = true;
    pos.exitReason = 'repair';
    adjustPaperCash(proceeds, `REPAIR TRIM ${pos.symbol}`);
    saveTrade({ ...pos, timestamp: Date.now() });
  }

  reconcilePaperCash(`${reason} post`);
  saveState();
  return botState.config.paperBankroll;
}

/** Detect real 5m market-window rollover (slug open→end) → book window stats. */
function maybeFinalizeCycle() {
  const wall = currentWallWindow(POLY_WINDOW_SECONDS);
  // Key by window START so it stays stable for the full open→end interval
  const cycleKey = String(wall.startSec);
  if (botState._cycleKey == null) {
    botState._cycleKey = cycleKey;
    botState.windows.current = {
      ...wall,
      ...computeWindowStats(botState.trades, botState.positions, wall, botState.config.mode),
    };
    return null;
  }
  if (botState._cycleKey === cycleKey) {
    // Live-refresh current window stats without rolling
    botState.windows.current = {
      ...wall,
      ...computeWindowStats(botState.trades, botState.positions, wall, botState.config.mode),
      accum: { ...botState._cycleSettleAccum },
    };
    return null;
  }

  const prevStart = Number(botState._cycleKey);
  const prevWindow = {
    startSec: prevStart,
    endSec: prevStart + POLY_WINDOW_SECONDS,
    startAtMs: prevStart * 1000,
    endAtMs: (prevStart + POLY_WINDOW_SECONDS) * 1000,
    key: `wall-${POLY_WINDOW_SECONDS}-${prevStart}`,
    windowSec: POLY_WINDOW_SECONDS,
  };
  const accum = { ...botState._cycleSettleAccum };
  const wstats = computeWindowStats(botState.trades, botState.positions, prevWindow, botState.config.mode);
  const portfolio = buildPortfolio(botState.readiness, botState.config.mode || 'paper');
  const entry = {
    cycleEndAt: prevWindow.endAtMs,
    cycleStartAt: prevWindow.startAtMs,
    cycleKey: String(prevStart),
    openAt: prevWindow.startAtMs,
    endAt: prevWindow.endAtMs,
    pnl: wstats.pnl || accum.pnl || 0,
    closes: wstats.closes || accum.closes || 0,
    rewards: accum.rewards || 0,
    tpFull: wstats.tpFull || accum.tp || 0,
    tpPartial: wstats.tpPartial || accum.partial || 0,
    tpHits: wstats.tpHits || 0,
    sl: wstats.byReason?.sl || accum.sl || 0,
    trail: wstats.byReason?.trail || accum.trail || 0,
    settle: wstats.byReason?.settle || accum.settle || 0,
    byReason: wstats.byReason,
    wr: wstats.wr,
    equity: portfolio.equity,
    netPnl: portfolio.netPnl,
    cash: portfolio.cash,
    unrealizedPnl: portfolio.unrealizedPnl,
    realizedPnl: portfolio.realizedPnl,
    openCount: portfolio.openCount,
    mode: botState.config.mode,
  };
  recordCycleSession(entry);
  botState.cycleReward = { ...entry, at: Date.now() };
  botState.settle.lastCycle = entry;
  botState.settle.history = [entry, ...(botState.settle.history || [])].slice(0, 40);
  botState.windows.history = [entry, ...(botState.windows.history || [])].slice(0, 40);
  botState._cycleSettleAccum = { pnl: 0, closes: 0, rewards: 0, tp: 0, sl: 0, trail: 0, settle: 0, partial: 0 };
  botState._cycleKey = cycleKey;
  botState.windows.current = {
    ...wall,
    ...computeWindowStats(botState.trades, botState.positions, wall, botState.config.mode),
    accum: { ...botState._cycleSettleAccum },
  };

  log(
    `🏁 WINDOW ${new Date(prevWindow.startAtMs).toISOString().slice(11, 16)}→${new Date(prevWindow.endAtMs).toISOString().slice(11, 16)} · closes ${entry.closes} · TP ${entry.tpHits} · PnL $${Number(entry.pnl || 0).toFixed(2)} · cash $${Number(entry.cash || 0).toFixed(2)}`,
    'system',
    entry,
  );

  if (botState.stopRequest?.status === 'queued') {
    const request = { ...botState.stopRequest };
    stopBot({ immediate: true, reason: 'queued_window_end' });
    log(
      `⏹️ QUEUED STOP COMPLETE · requested ${new Date(request.requestedAt).toLocaleTimeString()} · window closed`,
      'system',
      request,
    );
  } else if (botState.config.llmOptimize !== false && botState.running) {
    optimizeNow({ apply: true, useLlm: true }).catch((err) => {
      log(`⚠️ Optimizer after cycle: ${err.message?.slice(0, 100) || err}`, 'error');
    });
  }
  notifyStateChange();
  return entry;
}

function bookWindowExit(exitReason, pnl) {
  const reward = Number(pnl || 0);
  botState._cycleSettleAccum.pnl = Math.round((botState._cycleSettleAccum.pnl + reward) * 100) / 100;
  botState._cycleSettleAccum.closes += 1;
  if (reward > 0) {
    botState._cycleSettleAccum.rewards = Math.round((botState._cycleSettleAccum.rewards + reward) * 100) / 100;
  }
  const key = exitReason === 'tp' ? 'tp'
    : exitReason === 'partial' ? 'partial'
      : exitReason === 'sl' ? 'sl'
        : exitReason === 'trail' ? 'trail'
          : exitReason === 'settle' ? 'settle'
            : null;
  if (key) botState._cycleSettleAccum[key] = (botState._cycleSettleAccum[key] || 0) + 1;
}

function computeStats(trades) {
  return computeTradeStats(trades);
}

// Feed recent paper trades into Kelly (ignore ancient UP-monopoly history)
function refreshKellyHistory() {
  const paper = (botState.trades || []).filter((t) => t.mode === 'paper').slice(0, 120);
  setKellyTradeHistory(paper.length ? paper : botState.trades.slice(0, 80));
}
refreshKellyHistory();

function recordChartTick(slug, prices) {
  if (!slug || !prices) return;
  const up = prices.up != null ? Number(prices.up) : null;
  const down = prices.down != null ? Number(prices.down) : null;
  if (up == null && down == null) return;
  if (!botState._chartTicks[slug]) botState._chartTicks[slug] = [];
  const series = botState._chartTicks[slug];
  const last = series[series.length - 1];
  const now = Date.now();
  // debounce identical prints under 250ms
  if (last && now - last.t < 250 && last.up === up && last.down === down) return;
  series.push({ t: now, up, down });
  if (series.length > 360) series.splice(0, series.length - 360);
}

function getChartSeries(slug) {
  if (!slug) return [];
  return botState._chartTicks[slug] || [];
}

function hasOpenOnSlug(slug) {
  const cfg = botState.config;
  if (cfg.maxConcurrentPerSlug === 0) return true;
  const maxConcurrent = cfg.maxConcurrentPerSlug || 1;
  const openCount = botState.positions.filter((p) => !p.closed && p.slug === slug).length;
  if (openCount >= maxConcurrent) return true;
  const pendingCount = botState.pendingTrades.filter((p) => p.slug === slug && p.status === 'pending').length;
  if (openCount + pendingCount >= maxConcurrent) return true;
  return botState._buyLocks.has(slug);
}

function prunePendingTrades() {
  const now = Date.now();
  botState.pendingTrades = botState.pendingTrades.filter((p) => {
    if (p.status !== 'pending') return false;
    if (p.expiresAt && now > p.expiresAt) {
      p.status = 'expired';
      log(`⌛ TRADE EXPIRED ${p.symbol} ${p.outcome?.toUpperCase()} — no approve in time`, 'signal', { id: p.id, slug: p.slug });
      botState._buyLocks.delete(p.slug);
      return false;
    }
    return true;
  });
}

function buildTradePlan({ cfg, market, outcome, price, remaining, signal, sizeUsd, kelly, analysis }) {
  let plan = buildDynamicPlan({ cfg, price, analysis, signal });
  plan = overlayPlanWithHeuristics(plan, {
    duration: market?.duration,
    confidence: signal?.confidence,
    entryPrice: price,
    symbol: market?.symbol,
  });
  const entry = Number(price);
  const minSh = Number(market.minShares || 5);
  let shares;
  if (cfg.mode === 'paper') {
    // Paper: never inflate above budget (minShares=5 was blowing the ledger)
    shares = Math.max(0.01, Math.round((sizeUsd / entry) * 1000) / 1000);
  } else {
    shares = Math.max(minSh, Math.ceil((sizeUsd / entry) * 100) / 100);
  }
  const costEst = Math.round(shares * entry * 100) / 100;

  // Floor full-TP$ so partial leftovers / tiny scalp targets don't show ~$1 on ~$36 tickets.
  const minTpUsd = Number(cfg.minTpUsd ?? 5);
  if (minTpUsd > 0 && shares > 0 && entry > 0 && !plan.holdToSettle) {
    const needPct = (minTpUsd / (shares * entry)) * 100;
    if (needPct > plan.tpPct) {
      plan.tpPct = Math.round(Math.min(80, needPct) * 10) / 10;
      const frac = Number(cfg.partialTpFrac ?? 0.78);
      plan.partialTpPct = Math.round(plan.tpPct * Math.min(0.95, Math.max(0.7, frac)) * 10) / 10;
      plan.trailActivatePct = Math.round(plan.tpPct * Number(cfg.trailActivateFrac ?? 0.72) * 10) / 10;
    }
  }

  const tpPrice = Math.min(0.99, entry * (1 + plan.tpPct / 100));
  const slPrice = Math.max(0.01, entry * (1 - plan.slPct / 100));
  const tpPnl = Math.round((tpPrice - entry) * shares * 100) / 100;
  const slPnl = Math.round((slPrice - entry) * shares * 100) / 100;

  return {
    targetTp: plan.tpPct,
    slPct: plan.slPct,
    trailActivatePct: plan.trailActivatePct,
    trailDistancePct: plan.trailDistancePct,
    partialTpPct: plan.partialTpPct,
    partialPct: plan.partialPct,
    volFactor: plan.volFactor,
    adaptiveSlEnabled: plan.holdToSettle ? false : plan.adaptiveSlEnabled !== false,
    minAdaptiveSlPct: plan.minAdaptiveSlPct ?? Number(cfg.minAdaptiveSlPct ?? 8),
    holdToSettle: !!plan.holdToSettle,
    planMethod: plan.method,
    entryPrice: entry,
    tpPrice: Math.round(tpPrice * 1000) / 1000,
    slPrice: Math.round(slPrice * 1000) / 1000,
    shares,
    costEst,
    tpPnl,
    slPnl,
    sizeUsd: costEst,
    kelly,
    remaining,
    confidence: signal?.confidence || 0,
    direction: signal?.direction || outcome,
    thesis: signal?.thesis || null,
  };
}

function announceTrade(plan, market, outcome) {
  const id = `ann-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
  const timeoutSec = Number(botState.config.announceTimeoutSec ?? 28);
  const announcement = {
    id,
    status: 'pending',
    createdAt: Date.now(),
    expiresAt: Date.now() + timeoutSec * 1000,
    symbol: market.symbol,
    slug: market.slug,
    outcome,
    mode: botState.config.mode,
    question: market.question,
    tokenId: market.tokenIds?.[outcome] || null,
    negRisk: !!market.negRisk,
    tickSize: market.tickSize || '0.01',
    minShares: market.minShares || 5,
    plan,
  };

  botState.pendingTrades.unshift(announcement);
  if (botState.pendingTrades.length > 20) botState.pendingTrades.length = 20;
  botState.announcements.unshift({
    id,
    type: 'trade_intent',
    time: Date.now(),
    title: `READY ${market.symbol} ${outcome.toUpperCase()}`,
    msg: `${market.symbol} ${outcome.toUpperCase()} @ $${plan.entryPrice.toFixed(3)} · size $${plan.costEst} (~${plan.shares} sh) · TP +${plan.targetTp}% → $${plan.tpPrice.toFixed(3)} (+$${plan.tpPnl}) · SL -${plan.slPct}% → $${plan.slPrice.toFixed(3)} ($${plan.slPnl}) · ${plan.remaining}s left`,
    plan,
  });
  if (botState.announcements.length > 50) botState.announcements.length = 50;

  log(
    `📣 ANNOUNCE ${market.symbol} ${outcome.toUpperCase()} @ $${plan.entryPrice.toFixed(3)} · $${plan.costEst} · TP +${plan.targetTp}% ($${plan.tpPrice.toFixed(3)}) · SL -${plan.slPct}% ($${plan.slPrice.toFixed(3)}) · approve in ${timeoutSec}s`,
    'announce',
    { id, ...plan, slug: market.slug, outcome },
  );

  return announcement;
}

async function executePendingTrade(pending) {
  const cfg = botState.config;
  const plan = pending.plan;
  const costNeeded = Number(plan.costEst || plan.sizeUsd || 0);
  const maxOpen = Number(cfg.maxOpenPositions ?? 6);
  if (countOpenPositions(cfg.mode) >= maxOpen) {
    pending.status = 'skipped';
    botState._buyLocks.delete(pending.slug);
    log(`⛔ SKIP ${pending.symbol} — max open positions (${maxOpen})`, 'signal');
    return { ok: false, error: 'max open positions' };
  }
  if (cfg.mode === 'paper' && costNeeded > Number(cfg.paperBankroll ?? 0) + 0.001) {
    pending.status = 'skipped';
    botState._buyLocks.delete(pending.slug);
    log(`⛔ SKIP ${pending.symbol} — paper cash $${Number(cfg.paperBankroll || 0).toFixed(2)} < $${costNeeded.toFixed(2)}`, 'signal');
    return { ok: false, error: 'insufficient paper cash' };
  }

  const pos = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    symbol: pending.symbol,
    slug: pending.slug,
    outcome: pending.outcome,
    entryPrice: plan.entryPrice,
    currentPrice: plan.entryPrice,
    highestPrice: plan.entryPrice,
    size: plan.sizeUsd,
    shares: plan.shares,
    pnl: 0,
    gainPct: 0,
    targetTp: plan.targetTp,
    slPct: plan.slPct,
    tpPrice: plan.tpPrice,
    slPrice: plan.slPrice,
    trailActivatePct: plan.trailActivatePct,
    trailDistancePct: plan.trailDistancePct,
    partialTpPct: plan.partialTpPct,
    partialPct: plan.partialPct,
    partialSold: false,
    adaptiveSlEnabled: plan.holdToSettle ? false : plan.adaptiveSlEnabled !== false,
    minAdaptiveSlPct: plan.minAdaptiveSlPct ?? cfg.minAdaptiveSlPct ?? 8,
    holdToSettle: !!plan.holdToSettle,
    planMethod: plan.planMethod || plan.method || null,
    arb: !!plan.arb,
    effectiveSlPct: plan.slPct,
    adaptiveSlArmed: false,
    volFactor: plan.volFactor,
    entryTime: Date.now(),
    closed: false,
    mode: cfg.mode,
    governorProfile: getActiveProfile(),
    signal: { direction: plan.direction, confidence: plan.confidence },
    tokenId: pending.tokenId,
    negRisk: pending.negRisk,
    tickSize: pending.tickSize,
    minShares: pending.minShares,
    announceId: pending.id,
  };

  if (cfg.mode === 'live' && pending.tokenId) {
    try {
      // Min-share inflation guard: 5-share exchange minimum can blow a small budget
      const minSh = Number(pending.minShares || 5);
      const realCost = Math.max(Number(plan.sizeUsd || 0), minSh * Number(plan.entryPrice || 0));
      const spendable = Number(botState.readiness?.spendableBalance ?? botState.readiness?.clobBalance ?? 0);
      if (realCost > spendable * 0.95) {
        pending.status = 'failed';
        botState._buyLocks.delete(pending.slug);
        log(`⛔ LIVE SKIP ${pending.symbol} — min order $${realCost.toFixed(2)} (${minSh} sh) > spendable $${spendable.toFixed(2)}`, 'error');
        return { ok: false, error: 'min order exceeds spendable' };
      }
      const capUsd = Number(cfg.maxPositionCap ?? cfg.maxPositionSize ?? 14);
      if (realCost > Math.max(capUsd * 1.6, 4.5)) {
        pending.status = 'failed';
        botState._buyLocks.delete(pending.slug);
        log(`⛔ LIVE SKIP ${pending.symbol} — min order $${realCost.toFixed(2)} (${minSh} sh @ $${plan.entryPrice}) blows cap $${capUsd}`, 'error');
        return { ok: false, error: 'min order exceeds risk cap' };
      }
      log(`🛰️ LIVE ORDER SUBMIT ${pending.symbol} ${pending.outcome.toUpperCase()} @ $${plan.entryPrice.toFixed(3)}`, 'signal', {
        market: pending.symbol, slug: pending.slug, outcome: pending.outcome,
        amount: plan.sizeUsd, price: plan.entryPrice, announceId: pending.id,
      });
      const orderResult = await placeOrder({
        tokenId: pending.tokenId,
        side: 'buy',
        amountUsd: plan.sizeUsd,
        price: plan.entryPrice,
        negRisk: pending.negRisk,
        tickSize: pending.tickSize || '0.01',
        minShares: pending.minShares || 5,
      });
      pos.orderId = orderResult.id;
      pos.shares = orderResult.size;
      pos.entryPrice = orderResult.price;
      markPosition(pos, orderResult.price);
      try { await syncClobBalance(); await refreshTelemetry(); } catch {}
      log(`✅ LIVE BUY ${pending.symbol} ${pending.outcome.toUpperCase()} @ $${orderResult.price.toFixed(3)} · ${orderResult.size} sh · TP $${plan.tpPrice.toFixed(3)} · SL $${plan.slPrice.toFixed(3)}`, 'buy', {
        market: pending.symbol, slug: pending.slug, outcome: pending.outcome,
        orderId: pos.orderId, amount: plan.sizeUsd, price: orderResult.price,
        shares: orderResult.size, targetTp: plan.targetTp, tpPrice: plan.tpPrice, slPrice: plan.slPrice,
      });
      traceLiveFill({
        type: 'bot_entry',
        message: `LIVE BUY ${pending.symbol} ${pending.outcome.toUpperCase()} · ${orderResult.size}sh @ ${orderResult.price} · $${Number(plan.sizeUsd).toFixed(2)}`,
        slug: pending.slug,
        outcome: pending.outcome,
        side: 'BUY',
        shares: orderResult.size,
        price: orderResult.price,
        usdc: plan.sizeUsd,
        orderId: pos.orderId,
        verifiedSell: false,
      });
      syncLiveAccount({ botTrades: botState.trades, note: 'live_buy' }).catch(() => {});
    } catch (err) {
      pending.status = 'failed';
      botState._buyLocks.delete(pending.slug);
      log(`❌ LIVE BUY FAILED ${pending.symbol}: ${err.message.slice(0, 160)}`, 'error', {
        market: pending.symbol, slug: pending.slug, outcome: pending.outcome,
      });
      return { ok: false, error: err.message };
    }
  } else {
    markPosition(pos, plan.entryPrice);
    const premium = Number(pos.costBasis || plan.sizeUsd || 0);
    const feeCategory = cfg.feeCategory || 'crypto';
    const feeOn = cfg.simulateClobFees !== false;
    const useClobFees = cfg.useClobMarketFees !== false;
    const entryFee = !feeOn
      ? 0
      : (useClobFees && pending.tokenId)
        ? await takerFeeUsdcForToken(pos.shares, plan.entryPrice, pending.tokenId, feeCategory)
        : takerFeeUsdc(pos.shares, plan.entryPrice, feeCategory);
    pos.entryFee = entryFee;
    pos.feesPaid = entryFee;
    pos.costBasis = premium;
    const debit = Math.round((premium + entryFee) * 100) / 100;
    adjustPaperCash(-debit, `BUY ${pending.symbol} ${pending.outcome?.toUpperCase()} @ ${plan.entryPrice}`);
    log(`✅ PAPER BUY ${pending.symbol} ${pending.outcome.toUpperCase()} @ $${plan.entryPrice.toFixed(3)} · $${premium.toFixed(2)} + fee $${entryFee.toFixed(4)} · TP +${plan.targetTp}% · SL -${plan.slPct}%`, 'buy', {
      market: pending.symbol, slug: pending.slug, outcome: pending.outcome,
      amount: plan.sizeUsd, price: plan.entryPrice, targetTp: plan.targetTp, tpPrice: plan.tpPrice, slPrice: plan.slPrice,
      entryFee,
    });
  }

  botState.positions.push(pos);
  botState.stats.signalsToday = (botState.stats.signalsToday || 0) + 1;
  pending.status = 'executed';
  pending.executedAt = Date.now();
  botState._buyLocks.delete(pending.slug);
  botState.pendingTrades = botState.pendingTrades.filter((p) => p.id !== pending.id);
  saveState();
  return { ok: true, position: pos };
}

export async function approveTrade(id) {
  prunePendingTrades();
  const pending = botState.pendingTrades.find((p) => p.id === id && p.status === 'pending');
  if (!pending) return { ok: false, error: 'No pending trade with that id' };
  pending.status = 'approved';
  return executePendingTrade(pending);
}

export async function rejectTrade(id) {
  prunePendingTrades();
  const pending = botState.pendingTrades.find((p) => p.id === id && p.status === 'pending');
  if (!pending) return { ok: false, error: 'No pending trade with that id' };
  pending.status = 'rejected';
  botState._buyLocks.delete(pending.slug);
  botState.pendingTrades = botState.pendingTrades.filter((p) => p.id !== id);
  log(`🚫 REJECTED ${pending.symbol} ${pending.outcome?.toUpperCase()} @ $${pending.plan?.entryPrice?.toFixed(3)}`, 'signal', { id });
  return { ok: true };
}

export async function approveAllTrades() {
  prunePendingTrades();
  const results = [];
  for (const p of [...botState.pendingTrades]) {
    if (p.status === 'pending') results.push(await approveTrade(p.id));
  }
  return { ok: true, results };
}

function pushTrace(kind, payload = {}) {
  const entry = {
    id: `tr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
    t: Date.now(),
    kind,
    ...payload,
  };
  if (!botState.traces) botState.traces = { events: [], decisions: [], exits: [] };
  botState.traces.events.unshift(entry);
  if (botState.traces.events.length > 250) botState.traces.events.length = 250;
  if (kind === 'decision' || kind === 'arb' || kind === 'scan') {
    botState.traces.decisions.unshift(entry);
    if (botState.traces.decisions.length > 120) botState.traces.decisions.length = 120;
  }
  if (kind === 'exit' || kind === 'sl' || kind === 'tp' || kind === 'settle' || kind === 'trail') {
    botState.traces.exits.unshift(entry);
    if (botState.traces.exits.length > 80) botState.traces.exits.length = 80;
  }
  return entry;
}

function pushNotification(entry) {
  if (!botState.notifications) botState.notifications = [];
  botState.notifications.unshift(entry);
  if (botState.notifications.length > 80) botState.notifications.length = 80;
}

const AGILE_NOTIFY_TYPES = new Set(['buy', 'sl', 'tp', 'error', 'announce', 'system', 'signal']);

function log(msg, type = 'info', meta = null) {
  const entry = { id: `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`, msg, type, time: Date.now(), meta };
  botState.actions.unshift(entry);
  if (botState.actions.length > 300) botState.actions.length = 300;
  botState.executionLog.unshift({
    ...entry,
    level: type,
  });
  if (botState.executionLog.length > 500) botState.executionLog.length = 500;

  if (AGILE_NOTIFY_TYPES.has(type) || (meta && meta.arb)) {
    pushNotification({
      id: entry.id,
      time: entry.time,
      type: meta?.arb ? 'arb' : type,
      title: String(type).toUpperCase(),
      msg,
      meta: meta || null,
      read: false,
    });
    pushTrace(type === 'sl' || type === 'tp' ? type : (meta?.arb ? 'arb' : 'event'), {
      msg,
      type,
      symbol: meta?.market || meta?.symbol,
      outcome: meta?.outcome,
      pnl: meta?.pnl,
      gainPct: meta?.gainPct,
      arb: !!meta?.arb,
    });
    if (['buy', 'sl', 'tp', 'arb', 'error', 'system'].includes(type) || meta?.arb) {
      traceSession({
        type: meta?.arb ? 'arb' : type,
        message: msg,
        symbol: meta?.market || meta?.symbol || null,
        outcome: meta?.outcome || null,
        pnl: meta?.pnl ?? null,
        slug: meta?.slug || null,
        orderId: meta?.orderId || null,
        fee: meta?.fee ?? meta?.feesPaid ?? null,
      });
    }
  }
  notifyStateChangeDebounced(80);
  saveState();
}

export function getTraces({ limit = 80 } = {}) {
  const traces = botState.traces || { events: [], decisions: [], exits: [] };
  return {
    events: (traces.events || []).slice(0, limit),
    decisions: (traces.decisions || []).slice(0, Math.min(60, limit)),
    exits: (traces.exits || []).slice(0, Math.min(40, limit)),
    notifications: (botState.notifications || []).slice(0, 40),
    unread: (botState.notifications || []).filter((n) => !n.read).length,
    at: Date.now(),
  };
}

export function markNotificationsRead() {
  for (const n of botState.notifications || []) n.read = true;
  notifyStateChange();
  return { ok: true, unread: 0 };
}

function logScan(msg, meta) {
  const entry = {
    id: 'latest-scan',
    msg,
    type: 'scan',
    time: Date.now(),
    meta,
    level: 'scan',
  };
  botState.lastScanLog = entry;
  botState.executionLog = botState.executionLog.filter((e) => e.type !== 'scan' && e.level !== 'scan' && e.id !== 'latest-scan');
  botState.executionLog.unshift(entry);
  if (botState.executionLog.length > 500) botState.executionLog.length = 500;
}

function summarizeSignal(signal) {
  if (!signal) return null;
  return {
    asset: signal.asset,
    direction: signal.direction,
    confidence: signal.confidence,
    conviction: signal.conviction,
    thesis: signal.thesis,
    score: signal.score,
    rsi: signal.rsi,
    tooVolatile: signal.tooVolatile,
    price: signal.price,
    regime: signal.structure?.regime,
    factors: signal.factors?.slice(0, 8) || [],
    signals: signal.signals?.slice(0, 8) || [],
  };
}

function positionShares(pos) {
  if (pos.shares > 0) return pos.shares;
  if (pos.entryPrice > 0 && pos.size > 0) return pos.size / pos.entryPrice;
  return 0;
}

function findReadinessPositionForBotPosition(position, readinessPositions = []) {
  const rows = Array.isArray(readinessPositions) ? readinessPositions : [];
  const tokenId = String(position?.tokenId || '');
  if (tokenId) {
    const byToken = rows.find((row) => String(row?.asset || '') === tokenId);
    if (byToken) return byToken;
  }
  return rows.find((row) =>
    row
    && String(row.slug || '') === String(position?.slug || '')
    && String(row.outcome || '').toLowerCase() === String(position?.outcome || '').toLowerCase()
  ) || null;
}

function pmSharesForPosition(position, readinessPositions = []) {
  const row = findReadinessPositionForBotPosition(position, readinessPositions);
  return Number(row?.size || 0);
}

function reconcileLiveGhostPosition(position, readinessPositions = [], reason = 'missing_pm_inventory') {
  if (!position || position.closed || position.mode !== 'live') return false;
  const pmShares = pmSharesForPosition(position, readinessPositions);
  position.closed = true;
  position.exitReason = 'sync_stale';
  position.reconciledStale = true;
  position.reconciledAt = Date.now();
  position.pendingRedeem = false;
  position.pmSharesAtReconcile = Math.round(pmShares * 1000) / 1000;
  position.exitPrice = Number(position.currentPrice || position.entryPrice || 0) || null;
  position.markValue = 0;
  position.unrealizedPnl = 0;
  position.shares = 0;
  log(
    `🧹 LIVE RECONCILE ${position.symbol} ${String(position.outcome || '').toUpperCase()} · local open cleared (${reason})`,
    'system',
    {
      symbol: position.symbol,
      slug: position.slug,
      outcome: position.outcome,
      tokenId: position.tokenId || null,
      reason,
      pmShares: Math.round(pmShares * 1000) / 1000,
    },
  );
  return true;
}

function markPosition(pos, price) {
  const shares = positionShares(pos);
  pos.currentPrice = price;
  pos.shares = shares;
  pos.costBasis = Math.round(shares * (pos.entryPrice || 0) * 100) / 100;
  pos.markValue = Math.round(shares * price * 100) / 100;
  pos.pnl = Math.round((price - pos.entryPrice) * shares * 100) / 100;
  pos.unrealizedPnl = pos.pnl;
  pos.gainPct = pos.entryPrice ? ((price - pos.entryPrice) / pos.entryPrice) * 100 : 0;
  if (pos.highestPrice == null || price > pos.highestPrice) pos.highestPrice = price;
  return pos;
}

/** Executable exit mark — best bid when available (mid/gamma lag caused 10% SL → 50%+ fills). */
function exitMarkPrice(outcome, prices, depth) {
  const bid = Number(depth?.[outcome]?.bestBid || 0);
  const mid = Number(prices?.[outcome] || 0);
  if (bid > 0.005 && bid < 0.995) return bid;
  return mid || 0;
}

/**
 * Cap paper SL fills at stop + small slip so gaps can't book -56% on a 10% stop.
 * Live keeps the real bid (exchange fill) but still triggers off bid.
 */
function resolveSlFillPrice(pos, markBid, effectiveSl, cfg) {
  const entry = Number(pos.entryPrice || 0);
  const mark = Number(markBid || 0);
  if (!(entry > 0)) return mark;
  const slip = Math.max(0, Number(cfg.slMaxSlippagePct ?? 2));
  const floor = entry * (1 - (Number(effectiveSl) + slip) / 100);
  if (pos.mode === 'paper') {
    return Math.round(Math.max(0.01, Math.max(mark, floor)) * 1000) / 1000;
  }
  return Math.round(Math.max(0.01, mark || floor) * 1000) / 1000;
}

function summarizeBook(depth) {
  if (!depth) return null;
  const side = (d) => (d ? {
    bestBid: d.bestBid,
    bestAsk: d.bestAsk,
    spread: d.spread,
    spreadPct: d.spreadPct,
    imbalance: d.imbalance,
    bidVol: d.totalBidVol,
    askVol: d.totalAskVol,
    mid: d.mid,
    bids: (d.bids || []).slice(0, 5),
    asks: (d.asks || []).slice(0, 5),
  } : null);
  return {
    up: side(depth.up),
    down: side(depth.down),
    arbGap: (depth.up?.bestAsk && depth.down?.bestAsk)
      ? Math.round((1 - depth.up.bestAsk - depth.down.bestAsk) * 1000) / 1000
      : null,
  };
}

function buildPortfolio(readiness, mode) {
  const cfg = botState.config;
  const isPaper = mode === 'paper' || cfg.mode === 'paper';
  const paperBankroll = Number(cfg.paperBankroll ?? cfg.paperInitialDeposit ?? 100);
  const paperInitial = Number(cfg.paperInitialDeposit ?? 100);

  const deduped = dedupeTrades(botState.trades);
  const liveTrades = deduped.filter((t) => t.mode === 'live');
  const paperTrades = deduped.filter((t) => t.mode === 'paper');
  const liveStats = computeTradeStats(liveTrades);
  const paperStats = computeTradeStats(paperTrades);

  if (isPaper) {
    const paperPositions = botState.positions.filter((p) => !p.closed && p.mode === 'paper');
    const paperUnrealized = paperPositions.reduce(
      (sum, p) => sum + Number(p.unrealizedPnl ?? p.pnl ?? 0),
      0,
    );
    const paperOpenValue = paperPositions.reduce((sum, p) => sum + Number(p.markValue || 0), 0);
    const paperCostBasis = paperPositions.reduce((sum, p) => {
      const basis = Number(p.costBasis);
      if (Number.isFinite(basis) && basis > 0) return sum + basis;
      return sum + Number(p.size || 0);
    }, 0);
    const paperRealizedPnl = paperStats.totalPnl || 0;
    // Spendable cash is the live ledger (buys debit, closes credit exit value)
    const cash = Math.round(paperBankroll * 100) / 100;
    const equity = Math.round((cash + paperOpenValue) * 100) / 100;
    const netPnl = Math.round((equity - paperInitial) * 100) / 100;
    const limits = resolveDynamicLimits(cfg, Math.max(cash, 1));

    return {
      cash,
      openMarkValue: Math.round(paperOpenValue * 100) / 100,
      openCostBasis: Math.round(paperCostBasis * 100) / 100,
      unrealizedPnl: Math.round(paperUnrealized * 100) / 100,
      pmUnrealized: 0,
      baselineUsd: paperInitial,
      cashPnl: netPnl,
      netPnl,
      sessionPnl: netPnl,
      realizedPnl: Math.round(paperRealizedPnl * 100) / 100,
      realizedPnlBot: 0,
      realizedPnlPaper: Math.round(paperRealizedPnl * 100) / 100,
      equity,
      openCount: paperPositions.length,
      limits,
      live: { totalTrades: 0, wins: 0, losses: 0, totalPnl: 0, verifiedPnl: 0 },
      paper: paperStats,
      pnlSource: 'paper',
      paperBankroll: cash,
      paperInitialDeposit: paperInitial,
    };
  }

  // Prefer CLOB trading collateral for live PnL (not max(deposit, clob)).
  const cash = Number(
    readiness?.clobBalance ?? readiness?.spendableBalance ?? botState.telemetry.usdcBalance ?? 0,
  );
  const pmPositions = readiness?.positions || [];
  const liveBotOpen = botState.positions.filter((p) => !p.closed && p.mode === 'live');
  const botTokenIds = new Set(liveBotOpen.map((p) => String(p.tokenId || '')).filter(Boolean));
  // Only count PM inventory that matches bot opens — ignore redeemable junk / orphans in equity.
  const pmTracked = botTokenIds.size
    ? pmPositions.filter((p) => botTokenIds.has(String(p.asset || '')))
    : [];
  const pmUnrealized = pmTracked.reduce((sum, p) => sum + Number(p.cashPnl || 0), 0);
  const openMarkValue = pmTracked.length
    ? pmTracked.reduce((sum, p) => sum + Number(p.currentValue || 0), 0)
    : liveBotOpen.reduce((sum, p) => sum + Number(p.markValue || 0), 0);
  const openCostBasis = liveBotOpen.reduce((sum, p) => {
    const basis = Number(p.costBasis);
    if (Number.isFinite(basis) && basis > 0) return sum + basis;
    return sum + Number(p.size || 0);
  }, 0);
  const baselineUsd = loadBaseline();
  const cashPnl = baselineUsd != null ? Math.round((cash - baselineUsd) * 100) / 100 : null;
  const equity = Math.round((cash + openMarkValue) * 100) / 100;
  const netPnl = cashPnl != null
    ? Math.round((cashPnl + pmUnrealized) * 100) / 100
    : Math.round((liveStats.verifiedPnl + pmUnrealized) * 100) / 100;
  const limits = resolveDynamicLimits(cfg, cash);

  return {
    cash: Math.round(cash * 100) / 100,
    openMarkValue: Math.round(openMarkValue * 100) / 100,
    openCostBasis: Math.round(openCostBasis * 100) / 100,
    unrealizedPnl: Math.round(pmUnrealized * 100) / 100,
    pmUnrealized: Math.round(pmUnrealized * 100) / 100,
    pmOpenRaw: pmPositions.length,
    baselineUsd,
    cashPnl,
    netPnl,
    sessionPnl: liveStats.verifiedPnl,
    realizedPnl: liveStats.verifiedPnl,
    realizedPnlBot: liveStats.totalPnl,
    realizedPnlPaper: paperStats.totalPnl,
    equity,
    openCount: liveBotOpen.length,
    limits,
    live: liveStats,
    paper: paperStats,
    pnlSource: 'clob+pm_tracked',
  };
}

function resolveOrderSize(cfg, { price, signal, readiness, stats, remaining, windowSec, duration, symbol }) {
  const paperBankroll = Number(cfg.paperBankroll ?? cfg.paperInitialDeposit ?? 100);
  const liveBankroll = readiness?.spendableBalance ?? readiness?.clobBalance ?? 0;
  // Never pretend cash is $100 when paper ledger is empty/negative — that over-bought to -cash
  if (cfg.mode === 'paper' && !(paperBankroll > 0.05)) {
    return { sizeUsd: 0, kelly: null, limits: resolveDynamicLimits(cfg, 0), reason: 'no_paper_cash' };
  }
  const bankroll = cfg.mode === 'paper' ? paperBankroll : liveBankroll;
  if (!(bankroll > 0)) {
    return { sizeUsd: 0, kelly: null, limits: resolveDynamicLimits(cfg, 0), reason: 'no_bankroll' };
  }

  // Offline-trained duration/conf/price heuristics (when available)
  const heur = heuristicForTrade({
    duration: duration || (windowSec >= 3600 ? '1h' : windowSec >= 1800 ? '30m' : windowSec >= 900 ? '15m' : '5m'),
    confidence: signal?.confidence,
    entryPrice: price,
    symbol: symbol || signal?.asset,
  });
  const kellyFraction = Number(
    heur?.kellyFraction ?? cfg.kellyFraction ?? 0.50,
  );
  const maxPositionPct = Number(
    heur?.maxPositionPct ?? cfg.maxPositionPct ?? 0.10,
  );

  const limits = resolveDynamicLimits(cfg, bankroll);
  const { minUsd, maxUsd } = limits;
  const cashFrac = Math.min(0.95, Math.max(0.01, maxPositionPct));
  const hardCap = cfg.mode === 'paper'
    ? Math.min(maxUsd, Math.max(0, paperBankroll * cashFrac))
    : maxUsd;

  if (!cfg.useKellySizing) {
    return {
      sizeUsd: Math.min(hardCap, maxUsd),
      kelly: null,
      limits,
      heuristic: heur?.source || null,
    };
  }

  const kelly = computeKellySize({
    bankroll: limits.spendable || bankroll,
    price,
    signalConfidence: signal?.confidence ?? 0.35,
    historicalWinRate: stats?.totalTrades > 0 ? stats.wins / stats.totalTrades : null,
    tradeCount: stats?.totalTrades ?? 0,
    minUsd,
    maxUsd: hardCap,
    kellyFraction,
    maxPositionPct,
  });

  let sizeUsd = kelly.sizeUsd;
  if (cfg.useAggressiveScaling && sizeUsd > 0) {
    const mul = Number(cfg.aggScaleMultiplier ?? 1.0);
    sizeUsd = Math.min(sizeUsd * mul, hardCap);
  }
  sizeUsd = Math.min(sizeUsd, hardCap);

  // Certainty-aware upsizing: near-guaranteed favorites late in the window earn a
  // bigger stake than flat historical Kelly allows. This runs its own, higher cap
  // (certaintyMaxPct of bankroll) so a "10% away, 20s left" entry can be $10–30 on
  // a $100 book instead of a $2 token bet — while ordinary trades stay conservative.
  let certainty = null;
  if (cfg.certaintySizing !== false && remaining != null) {
    const certMaxPct = Number(cfg.certaintyMaxPct ?? 0.35);
    const certCap = Math.min(
      Math.max(maxUsd, bankroll * certMaxPct),
      Number(cfg.certaintyMaxUsd ?? 40),
      cfg.mode === 'paper' ? paperBankroll * cashFrac : bankroll,
    );
    certainty = computeCertaintyKelly({
      price,
      confidence: signal?.confidence,
      remaining,
      windowSec: Number(windowSec) || POLY_WINDOW_SECONDS,
      bankroll: limits.spendable || bankroll,
      kellyFraction,
      minUsd,
      maxUsd: certCap,
      maxPct: certMaxPct,
    });
    if (certainty && certainty.sizeUsd > sizeUsd) {
      sizeUsd = Math.min(certainty.sizeUsd, certCap);
    }
  }

  // Paper directional recovery: if historical Kelly is negative, still allow tiny probes
  // (live stays blocked by edge gate / zero size)
  if ((!sizeUsd || sizeUsd <= 0) && cfg.mode === 'paper' && cfg.arbOnlyUntilEdge === false && hardCap >= minUsd) {
    const conf = Math.min(0.65, Number(signal?.confidence || 0.35));
    sizeUsd = Math.round(Math.max(minUsd, Math.min(hardCap, 1.2 + conf * 2.5)) * 100) / 100;
    return {
      sizeUsd,
      kelly: { ...(kelly || {}), limits, method: 'paper_probe' },
      limits,
      reason: 'paper_probe',
    };
  }

  if (!sizeUsd || sizeUsd <= 0) {
    return { sizeUsd: 0, kelly: { ...kelly, limits }, limits, reason: kelly?.method || 'zero_size' };
  }

  const usedCertainty = certainty && Math.abs(sizeUsd - certainty.sizeUsd) < 0.005;
  return {
    sizeUsd,
    kelly: {
      ...kelly,
      ...(usedCertainty ? { method: 'certainty_kelly' } : {}),
      certainty: certainty || null,
      limits,
      heuristic: heur?.source || null,
    },
    limits,
    heuristic: heur,
  };
}

function buildDecision({
  cfg,
  market,
  outcome,
  price,
  remaining,
  signal,
  existingPosition,
  readiness,
  depth = null,
  prices = null,
}) {
  const reasons = [];
  let eligible = true;
  let score = 0;

  if (cfg.tradeCurrentWindowOnly && !market.isCurrent) {
    eligible = false;
    reasons.push('next window — watch only');
  }

  if (!market.acceptingOrders) {
    eligible = false;
    reasons.push('not accepting orders');
  }

  if (!price || price === 0) {
    eligible = false;
    reasons.push('no price');
  }

  if (eligible && price < cfg.minPrice) {
    eligible = false;
    reasons.push(`below min $${cfg.minPrice.toFixed(2)}`);
  }

  if (eligible && price > cfg.maxPrice) {
    eligible = false;
    reasons.push(`above max $${cfg.maxPrice.toFixed(2)}`);
  }

  const entryWin = resolveEntryWindows(market?.duration || '5m', cfg);
  if (eligible && remaining < entryWin.minRemainingSec) {
    eligible = false;
    reasons.push(`${remaining}s left < ${entryWin.minRemainingSec}s min (${entryWin.duration})`);
  }

  // Hard stop on expired / resolved windows (slug clock can lag a few seconds)
  if (eligible && remaining <= 0) {
    eligible = false;
    reasons.push('window expired');
  }

  if (
    eligible
    && cfg.requireDataAssurance !== false
    && botState._dataAssurance
    && !botState._dataAssurance.canBuy
  ) {
    eligible = false;
    reasons.push(dataAssuranceBuyBlockReason(botState._dataAssurance) || 'data assurance blocked');
  }

  const maxEntry = entryWin.maxEntryRemainingSec ?? cfg.maxEntryRemainingSec ?? 298;
  if (eligible && remaining > maxEntry) {
    eligible = false;
    reasons.push(`${remaining}s left > ${maxEntry}s entry window (${entryWin.duration})`);
  }

  if (eligible && remaining >= 180) {
    const earlyBoost = Math.min(18, ((remaining - 180) / 120) * 18);
    score += earlyBoost;
    reasons.push(`early entry +${earlyBoost.toFixed(0)} (${remaining}s left)`);
  } else if (eligible && remaining >= 120) {
    score += 6;
    reasons.push(`mid-early ${remaining}s`);
  }

  if (eligible && cfg.minPositionSize != null && cfg.maxPositionSize < cfg.minPositionSize) {
    eligible = false;
    reasons.push(`max $${cfg.maxPositionSize} < min $${cfg.minPositionSize}`);
  }

  const minBet = Number(cfg.minPositionSize ?? POLY_MIN_ORDER_USD);
  if (eligible && (readiness?.spendableBalance ?? 0) < minBet && cfg.mode === 'live') {
    eligible = false;
    reasons.push(`bankroll $${(readiness?.spendableBalance ?? 0).toFixed(2)} < min bet $${minBet}`);
  }

  const maxConcurrent = cfg.maxConcurrentPerSlug ?? 1;
  const allowScaleIn = cfg.allowScaleIn !== false && maxConcurrent > 1;
  if (eligible && existingPosition && !allowScaleIn) {
    eligible = false;
    reasons.push('position already open');
  }
  if (eligible && existingPosition && allowScaleIn) {
    reasons.push('scale-in allowed');
    score += 4;
  }

  if (eligible && hasOpenOnSlug(market.slug)) {
    eligible = false;
    reasons.push('already in this window');
  }

  if (cfg.mode === 'live' && readiness && !readiness.liveReady) {
    eligible = false;
    reasons.push('live not ready — fund CLOB USDC');
  }

  // Order book / arb: YES+NO ask sum < 1 → free edge; imbalance biases direction
  let bookMeta = null;
  if (cfg.useOrderBookBias !== false && depth) {
    const side = depth[outcome];
    const upAsk = depth.up?.bestAsk || prices?.up;
    const downAsk = depth.down?.bestAsk || prices?.down;
    const arbGap = (upAsk > 0 && downAsk > 0) ? (1 - upAsk - downAsk) : null;
    const imbalance = side?.imbalance ?? 0;
    const spreadPct = side?.spreadPct ?? null;
    bookMeta = { arbGap, imbalance, spreadPct, bestBid: side?.bestBid, bestAsk: side?.bestAsk };

    if (arbGap != null && arbGap > 0.01) {
      score += arbGap * 160;
      reasons.push(`arb gap +${(arbGap * 100).toFixed(1)}c`);
    }
    // Absolute cents also matter — mid-% can look fine while book is untradeable
    const spreadCents = side?.bestBid > 0 && side?.bestAsk > 0
      ? (side.bestAsk - side.bestBid) * 100
      : null;
    if (spreadPct != null && spreadPct < 0.8) {
      score += 12;
      reasons.push(`ultra-tight spread ${spreadPct.toFixed(2)}%`);
    } else if (spreadPct != null && spreadPct < 1.5) {
      score += 7;
      reasons.push(`tight spread ${spreadPct.toFixed(2)}%`);
    } else if (spreadPct != null && spreadPct > 3) {
      score -= 14;
      reasons.push(`wide spread ${spreadPct.toFixed(2)}%`);
      const blockPct = cfg.mode === 'paper' ? 12 : 6;
      if (spreadPct > blockPct && cfg.requireTightSpread !== false) {
        eligible = false;
        reasons.push('spread too wide — blocked');
      }
    }
    if (spreadCents != null && spreadCents > 8 && cfg.requireTightSpread !== false && cfg.mode !== 'paper') {
      eligible = false;
      reasons.push(`spread ${spreadCents.toFixed(1)}c too wide`);
    }
    const imbHelps = (outcome === 'up' && imbalance > 0.15) || (outcome === 'down' && imbalance < -0.15);
    const imbHurts = (outcome === 'up' && imbalance < -0.25) || (outcome === 'down' && imbalance > 0.25);
    if (imbHelps) {
      score += Math.abs(imbalance) * 18;
      reasons.push(`book ${imbalance > 0 ? 'bid' : 'ask'} heavy`);
    } else if (imbHurts) {
      score -= Math.abs(imbalance) * 12;
      reasons.push('book against');
    }
  }

  if (cfg.useSignals) {
    if (!signal) {
      eligible = false;
      reasons.push('signal unavailable');
    } else if (signal.tooVolatile || signal.skipTrade) {
      eligible = false;
      reasons.push(`volatility high (${signal.volatility?.atrPct?.toFixed?.(2) || 'n/a'}% ATR)`);
    } else if (signal.direction === 'neutral') {
      // Neutral: still allow book/arb-driven trades on either side
      const edge = Math.max(0, 0.55 - price);
      score += edge * 35;
      reasons.push('signal neutral — book/arb may lead');
      if (edge < 0.02 && !(bookMeta?.arbGap > 0.012)) {
        eligible = false;
        reasons.push('neutral + no edge');
      }
    } else {
      const expectedDirection = outcome === 'up' ? 'up' : 'down';
      const agrees = signal.direction === expectedDirection;
      const edge = Math.max(0, 0.55 - price);
      const balPre = sideBalanceStats(cfg);
      const skewSoft = cfg.sideBalanceEnabled !== false && balPre.upShare >= 0.68;
      if (!agrees) {
        // Soft mismatch ONLY — never hard-lock; explore lightly when skewed
        const arbRescue = bookMeta?.arbGap != null && bookMeta.arbGap >= Number(cfg.minArbGap ?? 0.015);
        const explore = (cfg.arbExploreRate > 0 && Math.random() < Number(cfg.arbExploreRate));
        score -= 22;
        reasons.push(`signal says ${signal.direction.toUpperCase()} (counter)`);
        if (arbRescue) {
          score += bookMeta.arbGap * 200;
          reasons.push('arb overrides mismatch');
        } else if (explore || skewSoft) {
          score += skewSoft ? 8 : 6;
          reasons.push(skewSoft ? 'soft skew explore' : 'explore opposite side');
        }
        // Counter without arb/edge stays eligible only if price is a clear underdog
        if (!arbRescue && !(price > 0 && price <= Number(cfg.underdogMaxPrice ?? 0.42))) {
          eligible = false;
          reasons.push('counter needs arb or underdog price');
        }
      } else if (signal.confidence < entryWin.minConfidence && !skewSoft) {
        eligible = false;
        reasons.push(
          `confidence ${(signal.confidence * 100).toFixed(0)}% < ${(entryWin.minConfidence * 100).toFixed(0)}% (${entryWin.source})`,
        );
      } else {
        // Cap signal score contribution so soft balance can still nudge
        const confCap = Math.min(Number(signal.confidence || 0), 0.65);
        score += (confCap * 40) + (edge * 45) + Math.min(Number(signal.score || 0), 6);
        reasons.push(`signal ${signal.direction.toUpperCase()} ${(confCap * 100).toFixed(0)}%`);
        if (edge > 0) reasons.push(`price edge +${(edge * 100).toFixed(1)}c`);
        if (price > 0 && price <= Number(cfg.underdogMaxPrice ?? 0.42)) {
          score += 12;
          reasons.push('underdog hold-to-settle candidate');
        }
        if (signal.confidenceBiasUsed && signal.confidenceBias?.traceAgree === true) {
          score += 3;
          reasons.push('ML short-trace agrees');
        } else if (signal.confidenceBias?.traceAgree === false) {
          score -= 8;
          reasons.push('ML short-trace disagrees');
        }
      }
    }
  } else {
    score += Math.max(0, 0.55 - price) * 40;
    reasons.push('signals disabled');
  }

  // Break chronic single-side bias
  const bal = sideBalanceBonus(outcome, cfg);
  if (bal.bonus) {
    score += bal.bonus;
    if (bal.note) reasons.push(bal.note);
  }

  if (eligible) reasons.push('tradable now');

  return {
    outcome,
    price,
    eligible,
    score,
    reasons,
    book: bookMeta,
  };
}

function summarizeMarketDecision({ market, remaining, selectedCandidate, candidates, activePosition, announced }) {
  if (announced) {
    return {
      action: 'announce',
      outcome: announced.outcome,
      confidence: announced.plan?.confidence || 0,
      summary: `ANNOUNCE ${market.symbol} ${announced.outcome.toUpperCase()} — await approve`,
      trace: [
        `entry $${announced.plan?.entryPrice?.toFixed(3)}`,
        `TP +${announced.plan?.targetTp}% → $${announced.plan?.tpPrice?.toFixed(3)}`,
        `SL -${announced.plan?.slPct}% → $${announced.plan?.slPrice?.toFixed(3)}`,
      ],
    };
  }

  if (selectedCandidate) {
    return {
      action: 'buy',
      outcome: selectedCandidate.outcome,
      confidence: selectedCandidate.signal?.confidence || 0,
      summary: `BUY ${market.symbol} ${selectedCandidate.outcome.toUpperCase()} @ $${selectedCandidate.price.toFixed(3)}`,
      trace: selectedCandidate.reasons,
    };
  }

  if (activePosition) {
    return {
      action: 'watch',
      outcome: activePosition.outcome,
      confidence: activePosition.signal?.confidence || 0,
      summary: `${market.symbol} ${activePosition.outcome.toUpperCase()} already open`,
      trace: [`tracking open ${activePosition.outcome.toUpperCase()} position`, `${remaining}s remaining`],
    };
  }

  const blockedReasons = candidates.flatMap((candidate) =>
    candidate.reasons.map((reason) => `${candidate.outcome.toUpperCase()}: ${reason}`)
  );

  return {
    action: 'hold',
    outcome: null,
    confidence: 0,
    summary: `HOLD ${market.symbol}`,
    trace: blockedReasons.slice(0, 6),
  };
}

export function getState(opts = {}) {
  const lean = opts.lean === true;
  prunePendingTrades();
  const deduped = dedupeTrades(botState.trades);
  const liveTrades = deduped.filter((t) => t.mode === 'live');
  const paperTrades = deduped.filter((t) => t.mode === 'paper');
  const liveStats = computeStats(liveTrades);
  const paperStats = computeStats(paperTrades);
  const mode = botState.config?.mode || 'paper';
  const modeStats = mode === 'live' ? liveStats : paperStats;
  const portfolio = buildPortfolio(botState.readiness, mode);
  const pmOpen = (botState.readiness?.positions || []);

  const modePositions = botState.positions.filter((p) => !p.closed && p.mode === mode);
  const modeTrades = deduped.filter((t) => t.mode === mode);

  // Attach live mark / book quotes from current market snapshots
  const marketBySlug = Object.fromEntries((botState.markets || []).map((m) => [m.slug, m]));
  const liveBotPositions = modePositions.map((p) => {
    const m = marketBySlug[p.slug];
    const book = m?.depth?.[p.outcome] || m?.book?.[p.outcome] || null;
    const mark = m?.prices?.[p.outcome] ?? p.currentPrice;
    if (mark != null && Number.isFinite(Number(mark))) markPosition(p, Number(mark));
    return {
      ...p,
      liveMark: p.currentPrice,
      bestBid: book?.bestBid ?? null,
      bestAsk: book?.bestAsk ?? null,
      mid: book?.mid ?? p.currentPrice,
      spreadPct: book?.spreadPct ?? null,
      unrealizedPnl: p.unrealizedPnl ?? p.pnl,
      ageSec: p.entryTime ? Math.max(0, Math.floor((Date.now() - p.entryTime) / 1000)) : null,
    };
  });

  const liveAccountEarly = getLiveAccount(lean ? 12 : 40);
  const audit = runAudit({
    readiness: botState.readiness,
    trades: botState.trades,
    botPositions: botState.positions,
    cash: portfolio.cash,
    baselineUsd: portfolio.baselineUsd,
    mode,
    portfolio,
    liveAccount: liveAccountEarly,
  });
  if (lean) {
    // Keep lean payload small but always surface cash issues
    audit.lean = true;
  }

  const logFiltered = botState.executionLog.filter((e) => e.type !== 'scan' && e.level !== 'scan');
  const executionLog = botState.lastScanLog
    ? [botState.lastScanLog, ...logFiltered].slice(0, lean ? 40 : 200)
    : logFiltered.slice(0, lean ? 40 : 200);

  const wallNow = currentWallWindow(POLY_WINDOW_SECONDS);
  const remainingSec = Math.ceil(wallNow.remainingMs / 1000);
  const cycleClass = remainingSec <= 0
    ? 'SETTLED'
    : remainingSec <= 8
      ? 'ENDING'
      : remainingSec <= 60
        ? 'LATE'
        : 'OPEN';

  const currentMarkets = (botState.markets || []).filter((m) => m.isCurrent);
  const botProcess = {
    phase: botState.running ? (botState._scanning ? 'scanning' : 'idle') : 'stopped',
    scanning: !!botState._scanning,
    lastScanAt: botState.lastScan,
    scansDone: botState.stats.scansDone || 0,
    signalsToday: botState.stats.signalsToday || 0,
    pendingCount: botState.pendingTrades.filter((p) => p.status === 'pending').length,
    openCount: liveBotPositions.length,
    decisions: currentMarkets.map((m) => ({
      symbol: m.symbol,
      slug: m.slug,
      action: m.action,
      remaining: m.remaining,
      prices: m.prices,
      decision: m.decision,
      candidates: (m.candidates || []).slice(0, 4),
      sizingPreview: m.sizingPreview || null,
      signal: m.signal || null,
    })),
    lastSizing: botState.lastSizing || null,
  };

  let llmMeta = { configured: Boolean(process.env.OPENROUTER_API_KEY), provider: 'openrouter' };
  try {
    llmMeta = llmStatus();
  } catch {}

  const edgeGate = evaluateEdgeGate(botState.trades, botState.config);
  const wall = currentWallWindow(POLY_WINDOW_SECONDS);
  const windowStats = computeWindowStats(botState.trades, botState.positions, wall, mode);
  botState.windows.current = {
    ...wall,
    ...windowStats,
    accum: { ...botState._cycleSettleAccum },
  };

  // Live cash audit snapshot (mode-isolated)
  const cashAudit = {
    mode,
    cash: portfolio.cash,
    equity: portfolio.equity,
    unrealizedPnl: portfolio.unrealizedPnl,
    realizedPnl: portfolio.realizedPnl,
    netPnl: portfolio.netPnl,
    openMarkValue: portfolio.openMarkValue,
    openCostBasis: portfolio.openCostBasis ?? null,
    openCount: portfolio.openCount,
    paperBankroll: portfolio.paperBankroll ?? null,
    paperInitialDeposit: portfolio.paperInitialDeposit ?? null,
    baselineUsd: portfolio.baselineUsd ?? null,
    pnlSource: audit?.pnlSource || portfolio.pnlSource,
    issues: audit?.issues || [],
    notes: audit?.notes || [],
    pmRealizedSum: audit?.pmRealizedSum ?? liveAccountEarly?.totals?.pmRealizedSum ?? null,
    botPnlVerified: audit?.botPnlVerified ?? null,
    ok: audit?.ok !== false,
    updatedAt: Date.now(),
  };
  const sessionModeTrades = modeTrades.filter((trade) => {
    if (!botState.session || botState.session.mode !== mode) return false;
    return Number(trade.timestamp || trade.entryTime || 0) >= Number(botState.session.startedAt || 0);
  });
  const sessionSnapshot = botState.session
    ? {
      ...botState.session,
      status: botState.running ? 'running' : botState.session.status,
      trades: sessionModeTrades.length,
      wins: sessionModeTrades.filter((trade) => Number(trade.pnl || 0) > 0).length,
      losses: sessionModeTrades.filter((trade) => Number(trade.pnl || 0) <= 0).length,
      pnl: Math.round(
        sessionModeTrades.reduce((sum, trade) => sum + Number(trade.pnl || 0), 0) * 100,
      ) / 100,
      uptimeMs: botState.running ? Math.max(0, Date.now() - botState.session.startedAt) : 0,
    }
    : null;

  if (botState.running && sessionSnapshot) {
    updateSessionMarks({
      cash: portfolio.cash,
      equity: portfolio.equity,
      realizedPnl: portfolio.realizedPnl,
      unrealizedPnl: portfolio.unrealizedPnl,
      openCount: portfolio.openCount,
      feesPaid: portfolio.feesPaid ?? null,
      sessionPnl: sessionSnapshot.pnl,
      tradeCount: sessionSnapshot.trades,
    });
  }
  try {
    // Throttle equity marks — getState is polled/SSE'd aggressively
    const lastEq = botState._lastEquityAppendAt || 0
    const due = Date.now() - lastEq > (botState.running ? 8_000 : 30_000)
    if (due) {
      appendEquityPoint({
        cash: portfolio.cash,
        equity: portfolio.equity,
        realizedPnl: portfolio.realizedPnl,
        unrealizedPnl: portfolio.unrealizedPnl,
        mode,
        sessionId: sessionSnapshot?.id || botState.session?.id || null,
        note: botState.running ? 'running' : 'idle',
      });
      botState._lastEquityAppendAt = Date.now();
    }
  } catch {}

  const clobWs = getClobWsSnapshot();
  const sessionLedger = getSessionLedger(8);
  const liveAccount = liveAccountEarly;

  // Mode-isolated payload: never mix the other mode's history into primary trades/stats
  const isolatedStats = {
    ...modeStats,
    scansDone: botState.stats.scansDone || 0,
    mode,
    cashPnl: portfolio.cashPnl,
    netPnl: portfolio.netPnl,
    unrealizedPnl: portfolio.unrealizedPnl,
    realizedPnl: portfolio.realizedPnl,
    botPnl: modeStats.totalPnl,
  };
  if (!lean) {
    isolatedStats.paper = paperStats;
    isolatedStats.live = liveStats;
  }

  const stateCore = {
    running: botState.running,
    config: botState.config,
    mode,
    markets: currentMarkets,
    signals: botState.signals,
    actions: botState.actions.slice(0, lean ? 30 : 80),
    botPositions: botState.positions,
    positions: botState.positions,
    trades: modeTrades,
    lastScan: botState.lastScanLog || { at: botState.lastScan },
    lastScanLog: botState.lastScanLog,
    cashAudit,
    liveAccount: lean
      ? {
          cash: liveAccount.cash,
          reconcile: liveAccount.reconcile,
          totals: liveAccount.totals,
          mismatches: (liveAccount.mismatches || []).slice(0, 8),
          closed: (liveAccount.closed || []).slice(0, 8),
          traces: (liveAccount.traces || []).slice(0, 15),
        }
      : liveAccount,
    session: sessionSnapshot,
    edgeGate,
    clobWs: {
      connected: clobWs.connected,
      running: clobWs.running,
      subscribed: clobWs.subscribed,
      books: clobWs.books,
      msgCount: clobWs.msgCount,
      lastMsgAgeMs: clobWs.lastMsgAgeMs,
    },
    dataAssurance: botState._dataAssurance || null,
    mlTraces: {
      btc: getPriceTrace('btc'),
      eth: getPriceTrace('eth'),
    },
    audit,
    portfolio,
  };
  const narrative = buildSystemNarrative(stateCore);
  const liveScoreCards = buildLiveScoreCards(stateCore);
  const account = buildAccountBundle({
    ...stateCore,
    trades: modeTrades,
  });

  return {
    running: botState.running,
    config: botState.config,
    mode,
    profiles: {
      active: mode,
      paper: botState.configStore?.profiles?.paper || null,
      live: botState.configStore?.profiles?.live || null,
    },
    edgeGate,
    cashAudit,
    narrative,
    liveScoreCards,
    account,
    dataAssurance: botState._dataAssurance || null,
    session: sessionSnapshot,
    sessionHistory: botState.sessionHistory.slice(0, lean ? 5 : 30),
    sessionLedger: lean
      ? {
          currentId: sessionLedger.currentId,
          current: sessionLedger.current
            ? {
                id: sessionLedger.current.id,
                mode: sessionLedger.current.mode,
                status: sessionLedger.current.status,
                startedAt: sessionLedger.current.startedAt,
                sessionPnl: sessionLedger.current.sessionPnl,
                tradeCount: sessionLedger.current.tradeCount,
                uptimeMs: sessionLedger.current.uptimeMs,
                reconcile: sessionLedger.current.reconcile,
                traces: (sessionLedger.current.traces || []).slice(0, 20),
              }
            : null,
        }
      : sessionLedger,
    clobWs: {
      connected: clobWs.connected,
      running: clobWs.running,
      subscribed: clobWs.subscribed,
      books: clobWs.books,
      msgCount: clobWs.msgCount,
      lastMsgAgeMs: clobWs.lastMsgAgeMs,
    },
    liveAccount: lean
      ? {
          cash: liveAccount.cash,
          reconcile: liveAccount.reconcile,
          totals: liveAccount.totals,
          mismatches: (liveAccount.mismatches || []).slice(0, 8),
          closed: (liveAccount.closed || []).slice(0, 8),
          traces: (liveAccount.traces || []).slice(0, 15),
        }
      : liveAccount,
    stopRequest: botState.stopRequest,
    configSessions: lean ? listConfigSessions().slice(0, 8).map((session) => ({
      id: session.id,
      label: session.label,
      source: session.source,
      mode: session.mode,
      createdAt: session.createdAt,
      analysis: session.analysis,
    })) : listConfigSessions(),
    windows: {
      current: botState.windows.current,
      history: (botState.windows.history || botState.settle.history || []).slice(0, lean ? 6 : 20),
    },
    markets: botState.markets,
    positions: mode === 'live' && pmOpen.length ? pmOpen : liveBotPositions,
    botPositions: liveBotPositions,
    orders: botState.pendingTrades.filter((p) => p.status === 'pending'),
    trades: modeTrades.slice(0, lean ? 30 : 80),
    tradesRaw: modeTrades.length,
    pendingTrades: botState.pendingTrades.filter((p) => p.status === 'pending'),
    announcements: botState.announcements.slice(0, lean ? 8 : 20),
    actions: botState.actions.filter((a) => !a.mode || a.mode === mode).slice(0, lean ? 30 : 100),
    signals: botState.signals,
    stats: isolatedStats,
    audit,
    telemetry: {
      uptime: botState.running ? Math.floor((Date.now() - botState._startTime) / 1000) : 0,
      uptimeMs: botState.running ? Date.now() - botState._startTime : 0,
      startedAt: botState.running ? botState._startTime : null,
      usdcBalance: portfolio.cash,
      openValue: portfolio.openMarkValue,
      totalFees: botState.telemetry.totalFees || 0,
      signalsToday: botState.stats.signalsToday || 0,
      polyBalance: botState.telemetry.polyBalance || 0,
    },
    portfolio,
    process: botProcess,
    llm: llmMeta,
    lastScan: botState.lastScan,
    readiness: botState.readiness,
    diagnostics: botState.diagnostics,
    executionLog,
    intelligence: {
      btc: summarizeSignal(botState.signals.btc),
      eth: summarizeSignal(botState.signals.eth),
    },
    cycle: {
      remainingSeconds: remainingSec,
      remainingMs: wallNow.remainingMs,
      startAtMs: wallNow.startAtMs,
      endAtMs: wallNow.endAtMs,
      openAt: wallNow.startAtMs,
      serverTime: Date.now(),
      scanIntervalMs: POLY_SCAN_INTERVAL_MS,
      class: cycleClass,
      key: wallNow.key,
    },
    cycleReward: botState.cycleReward,
    settle: botState.settle,
    optimizer: getOptimizerStatus(),
    governor: { ...getGovernorStatus(), profilePerf: computeProfilePerf(modeTrades) },
    sessionPerf: lean
      ? { updatedAt: loadSessionPerf().updatedAt, sessions: (loadSessionPerf().sessions || []).slice(0, 5) }
      : loadSessionPerf(),
    sizing: botState.lastSizing || null,
    kellyStats: lean ? null : getKellyStats(),
    confidenceBuffer: lean ? null : getConfidenceBufferStats(),
    charts: lean ? {} : Object.fromEntries(
      Object.keys(botState._chartTicks).map((slug) => [slug, getChartSeries(slug).slice(-90)])
    ),
    mlTraces: {
      btc: getPriceTrace('btc'),
      eth: getPriceTrace('eth'),
    },
    spotPrices: botState.spotPrices,
    models: getModelStates(),
    modelHealth: getModelHealth(),
    sideMix: (() => { const b = sideBalanceBonus('up', botState.config); return { up: b.up || 0, down: b.down || 0 }; })(),
    traces: lean
      ? {
          events: (botState.traces?.events || []).slice(0, 25),
          decisions: (botState.traces?.decisions || []).slice(0, 15),
          exits: (botState.traces?.exits || []).slice(0, 12),
        }
      : {
          events: (botState.traces?.events || []).slice(0, 80),
          decisions: (botState.traces?.decisions || []).slice(0, 40),
          exits: (botState.traces?.exits || []).slice(0, 30),
        },
    notifications: (botState.notifications || []).slice(0, lean ? 15 : 40),
    notificationsUnread: (botState.notifications || []).filter((n) => !n.read).length,
    lean: !!lean,
  };
}

async function refreshTelemetry() {
  try {
    const readiness = await checkReadiness(botState.config);
    botState.readiness = readiness;
    botState.telemetry.usdcBalance = readiness.spendableBalance ?? readiness.clobBalance;
    botState.telemetry.polyBalance = readiness.polyBalance;
    return readiness;
  } catch (err) {
    botState.readiness = { liveReady: false, paperReady: true, needs: [err.message], checks: [] };
    return botState.readiness;
  }
}

export async function getReadiness() {
  return refreshTelemetry();
}

export async function syncBalances() {
  try {
    await syncClobBalance();
  } catch {}
  const readiness = await refreshTelemetry();
  if (loadBaseline() == null && readiness?.spendableBalance > 0) {
    saveBaseline(readiness.spendableBalance, 'Auto-set on first sync');
  }
  return readiness;
}

export async function getAudit() {
  await refreshTelemetry();
  const mode = botState.config.mode || 'paper';
  const portfolio = buildPortfolio(botState.readiness, mode);
  return runAudit({
    readiness: botState.readiness,
    trades: botState.trades,
    botPositions: botState.positions,
    cash: portfolio.cash,
    baselineUsd: portfolio.baselineUsd,
    mode,
    portfolio,
    liveAccount: getLiveAccount(40),
  });
}

export async function optimizeNow({ apply = true, useLlm = true } = {}) {
  const state = getState();
  return runOptimizer({
    state,
    saveConfig,
    log,
    apply,
    useLlm: useLlm && botState.config.llmOptimize !== false,
  });
}

export async function governorNow({ useLlm = true } = {}) {
  return runGovernor({
    config: botState.config,
    signals: botState.signals,
    portfolio: buildPortfolio(botState.readiness, botState.config.mode || 'paper'),
    trades: botState.trades,
    saveConfig,
    log,
    useLlm: useLlm && botState.config.llmOptimize !== false,
  });
}

export async function applyLlmPrimitives(actions) {
  const { runPrimitives } = await import('../ai/primitives.js');
  return runPrimitives(actions, {
    saveConfig,
    startBot,
    stopBot,
    optimizeNow,
    getConfig: () => botState.config,
    log,
  });
}

export function setBaseline(balanceUsd) {
  return saveBaseline(balanceUsd, 'Manual set');
}

/** Lightweight exit pass used when the main scan is busy — prevents SL gaps. */
async function scanOpenExitsFast() {
  const cfg = botState.config;
  if (!cfg?.enabled) return;
  const opens = botState.positions.filter((p) => !p.closed);
  if (!opens.length) return;
  const readinessPositions = botState.readiness?.positions || [];
  const bySlug = new Map();
  for (const pos of opens) {
    if (!bySlug.has(pos.slug)) bySlug.set(pos.slug, []);
    bySlug.get(pos.slug).push(pos);
  }
  for (const [slug, positions] of bySlug) {
    const market = (botState.markets || []).find((m) => m.slug === slug)
      || {
        symbol: positions[0].symbol,
        slug,
        tokenIds: Object.fromEntries(positions.map((p) => [p.outcome, p.tokenId]).filter(([, id]) => id)),
        endTime: positions[0].endTime || null,
        negRisk: positions[0].negRisk,
        tickSize: positions[0].tickSize || '0.01',
      };
    const prices = await getPricesForMarket(market).catch(() => ({}));
    const depth = await getDepthForMarket(market).catch(() => null);
    for (const pos of positions) {
      if (pos.closed) continue;
      const mark = exitMarkPrice(pos.outcome, prices, depth);
      if (!mark) continue;
      markPosition(pos, mark);
      const liveSignal = botState.signals?.[String(pos.symbol || '').toLowerCase()] || null;
      const effectiveSl = pos.holdToSettle
        ? Number(pos.slPct || cfg.holdToSettleDisasterSlPct || 42)
        : resolveAdaptiveSl(pos, { signal: liveSignal, cfg });
      const hit = pos.gainPct <= -effectiveSl || (pos.slPrice > 0 && mark <= Number(pos.slPrice));
      if (!hit) continue;
      const fillPrice = resolveSlFillPrice(pos, mark, effectiveSl, cfg);
      let sellShares = positionShares(pos);
      if (pos.mode === 'live' && pos.tokenId && sellShares > 0) {
        const pmShares = pmSharesForPosition(pos, readinessPositions);
        if (!(pmShares > 0)) {
          reconcileLiveGhostPosition(pos, readinessPositions, 'fast_sl_no_pm_inventory');
          continue;
        }
        const adjustedShares = Math.min(sellShares, pmShares);
        if (adjustedShares <= 0) {
          reconcileLiveGhostPosition(pos, readinessPositions, 'fast_sl_zero_adjusted_shares');
          continue;
        }
        if (Math.abs(adjustedShares - sellShares) > 0.01) {
          log(
            `🧮 LIVE FAST-SL share clamp ${pos.symbol} ${pos.outcome.toUpperCase()} · ${sellShares.toFixed(3)}→${adjustedShares.toFixed(3)}sh`,
            'system',
            { symbol: pos.symbol, slug: pos.slug, requestedShares: sellShares, pmShares, adjustedShares },
          );
        }
        sellShares = adjustedShares;
        try {
          const sellRes = await placeMarketSell({
            tokenId: pos.tokenId,
            shares: sellShares,
            negRisk: pos.negRisk,
            tickSize: pos.tickSize,
          });
          pos.sellOrderId = sellRes.id;
        } catch (err) {
          log(`⚠️ LIVE FAST-SL sell REJECTED ${pos.symbol}: ${err.message.slice(0, 120)} — position stays open`, 'error');
          continue;
        }
      }
      markPosition(pos, fillPrice);
      pos.exitPrice = fillPrice;
      pos.closed = true;
      pos.exitReason = 'sl';
      if (pos.mode === 'paper') {
        adjustPaperCash(Math.round(sellShares * fillPrice * 100) / 100, `SL ${pos.symbol} ${pos.outcome?.toUpperCase()}`);
      }
      saveTrade({
        ...pos,
        timestamp: Date.now(),
        orderId: pos.orderId,
        windowKey: windowKeyFromTrade(pos) || parseSlugWindow(pos.slug)?.key,
        effectiveSlPct: effectiveSl,
        markBid: mark,
        fillCapped: fillPrice > mark + 0.0005,
        fastExit: true,
      });
      bookWindowExit('sl', pos.pnl);
      log(`🛑 FAST SL ${pos.mode === 'live' ? 'LIVE' : 'PAPER'} ${pos.symbol} ${pos.outcome.toUpperCase()} · -$${Math.abs(pos.pnl).toFixed(2)} (${pos.gainPct.toFixed(1)}%) · stop ${effectiveSl}%`, 'sl', {
        market: pos.symbol, slug: pos.slug, outcome: pos.outcome,
        entryPrice: pos.entryPrice, exitPrice: fillPrice, gainPct: pos.gainPct, pnl: pos.pnl,
        effectiveSlPct: effectiveSl, markBid: mark,
      });
    }
  }
  saveState();
}

async function scan() {
  const cfg = botState.config;
  if (!cfg.enabled) return;
  if (botState._scanning) {
    // Heavy scan in flight — still try a fast bid-based exit pass so SL can't gap 50%+
    await scanOpenExitsFast().catch(() => {});
    return;
  }
  botState._scanning = true;

  try {
    maybeFinalizeCycle();
    prunePendingTrades();
    botState.stats.scansDone = (botState.stats.scansDone || 0) + 1;
    const readiness = await refreshTelemetry();

    if (cfg.useSignals) {
      botState.signals = await getSignalForBoth();
      // Prefer cached ML ladder from background refresh; only force a light signal nudge
      const mlOverride = cfg.useML
        ? await getMLSignalForBoth('5m', 1).catch(() => ({ btc: null, eth: null }))
        : null;
      if (mlOverride) {
        for (const asset of ['btc', 'eth']) {
          const raw = botState.signals[asset];
          const ml = mlOverride[asset];
          if (!raw || !ml || ml.error || ml.direction === 'neutral' || ml.direction === 0) continue;
          addMLPrediction(asset, ml);
          const rawIsBull = raw.direction === 'up';
          const mlIsBull = ml.direction === 1 || ml.direction === 'up';
          const mlConf = Number(ml.confidence || 0);
          // Paper: let a clear ML call fill neutral/weak technicals so scans actually fire
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
          const bias = getConfidenceBias(asset, raw);
          if (bias.bias !== 0) {
            raw.confidence = Math.min(0.65, bias.adjusted);
            raw.confidenceBias = bias;
            raw.confidenceBiasUsed = true;
          }
        }
      }
    }

    const { markets, diagnostics } = await findMarkets(resolveMarketDurations(cfg));
    botState.diagnostics = diagnostics;
    const tradableMarkets = cfg.tradeCurrentWindowOnly ? markets.filter((market) => market.isCurrent) : markets;
    const enriched = [];
    let signalsFound = 0;

    if (markets.length === 0) {
      log(`🧯 Discovery miss — 0 BTC/ETH markets`, 'error', { diagnostics });
    } else if (diagnostics.length > 0) {
      log(`🧭 Discovery partial — ${markets.length} live · ${diagnostics.length} missing`, 'scan', { diagnostics });
    }

    // Paper orphans first — don't wait on CLOB/PTB. Exits only run on current slug.
    {
      const nowMs = Date.now();
      for (const pos of [...botState.positions]) {
        if (pos.closed || pos.mode !== 'paper') continue;
        const slugTs = Number(String(pos.slug || '').split('-').pop());
        const windowEndMs = Number.isFinite(slugTs) && slugTs > 1e9
          ? (slugTs + POLY_WINDOW_SECONDS) * 1000
          : null;
        if (windowEndMs == null || nowMs < windowEndMs + 5000) continue;
        try {
          const result = await executeSell(pos, 'settle');
          if (result?.ok) {
            const pnlTxt = `${(pos.pnl || 0) >= 0 ? '+' : ''}$${Math.abs(pos.pnl || 0).toFixed(2)}`;
            log(
              `🏁 PAPER ORPHAN SETTLE ${pos.symbol} ${String(pos.outcome || '').toUpperCase()} · ${pnlTxt} · ${pos.slug}`,
              (pos.pnl || 0) >= 0 ? 'tp' : 'sl',
              { market: pos.symbol, slug: pos.slug, outcome: pos.outcome, pnl: pos.pnl, exitPrice: pos.exitPrice },
            );
          }
        } catch (err) {
          log(`⚠️ Orphan settle failed ${pos.slug}: ${String(err.message || err).slice(0, 120)}`, 'error');
        }
      }
    }

    // Restore window open clock + Chainlink to-beat before decisions (bounded).
    await Promise.all(tradableMarkets.map(async (market) => {
      const windowSec = Number(market.windowSeconds || POLY_WINDOW_SECONDS) || POLY_WINDOW_SECONDS;
      if (!market.eventStartTime && market.endTime) {
        market.eventStartTime = new Date((Number(market.endTime) - windowSec) * 1000).toISOString();
      }
      if (!market.endDate && market.endTime) {
        market.endDate = new Date(Number(market.endTime) * 1000).toISOString();
      }
      const ptb = await Promise.race([
        fetchPriceToBeat(market).catch(() => null),
        new Promise((resolve) => setTimeout(() => resolve(null), 3500)),
      ]);
      market.priceToBeat = ptb?.openPrice ?? market.priceToBeat ?? null;
      market.priceToBeatMeta = ptb || market.priceToBeatMeta || null;
    }));

    const signalTs = Math.max(
      Number(botState.signals?.btc?.timestamp || 0),
      Number(botState.signals?.eth?.timestamp || 0),
    );
    botState._dataAssurance = buildDataAssurance({
      spotPrices: botState.spotPrices,
      signals: botState.signals,
      feed: { status: signalTs ? 'live' : 'stale', lastSignalAt: signalTs || null },
      markets: tradableMarkets.map((m) => ({
        symbol: m.symbol,
        slug: m.slug,
        isCurrent: m.isCurrent,
        prices: m.gammaPrices || {},
        priceToBeat: m.priceToBeat,
        eventStartTime: m.eventStartTime,
        endTime: m.endTime,
      })),
      positions: botState.positions,
      cashAudit: {
        ok: true,
        cash: botState.config.paperBankroll,
        equity: botState.config.paperBankroll,
        issues: [],
      },
      lastScan: botState.lastScan,
      botRunning: true,
    });
    if (!botState._dataAssurance.canBuy && cfg.requireDataAssurance !== false) {
      log(`🛡️ DATA GATE · ${botState._dataAssurance.note}`, 'scan', {
        score: botState._dataAssurance.score,
        blocking: botState._dataAssurance.blocking,
      });
    }

    for (const market of tradableMarkets) {
      if (!cfg.assets.includes(market.symbol)) continue;
      const prices = await getPricesForMarket(market);
      recordChartTick(market.slug, prices);
      const hasOpenHere = botState.positions.some(
        (p) => !p.closed && p.slug === market.slug && p.symbol === market.symbol
      );
      // Always pull depth when we have opens — SL must mark on bid, not mid
      const depth = (cfg.useOrderBookBias !== false || hasOpenHere)
        ? await getDepthForMarket(market).catch(() => null)
        : null;
      const remainingMs = market.endTime
        ? Math.max(0, market.endTime * 1000 - Date.now())
        : getRemainingMs();
      const remaining = Math.ceil(remainingMs / 1000);
      const buildLiveSellDebug = (position, requestedShares, reason = '') => {
        const readinessPositions = readiness?.positions || [];
        const matchingReadinessPosition = findReadinessPositionForBotPosition(position, readinessPositions);
        return {
          reason,
          symbol: position?.symbol,
          slug: position?.slug,
          outcome: position?.outcome,
          requestedShares: Math.round(Number(requestedShares || 0) * 1000) / 1000,
          botShares: Math.round(Number(positionShares(position) || 0) * 1000) / 1000,
          pmShares: Math.round(Number(matchingReadinessPosition?.size || 0) * 1000) / 1000,
          entryPrice: position?.entryPrice ?? null,
          currentPrice: position?.currentPrice ?? null,
          tokenId: position?.tokenId || null,
          sellOrderId: position?.sellOrderId || null,
          pendingRedeem: !!position?.pendingRedeem,
          redeemable: !!matchingReadinessPosition?.redeemable,
          mergeable: !!matchingReadinessPosition?.mergeable,
          clobBalance: Math.round(Number(readiness?.clobBalance ?? 0) * 100) / 100,
          spendableBalance: Math.round(Number(readiness?.spendableBalance ?? 0) * 100) / 100,
        };
      };
      // Exit BEFORE new entries on this market so an open SL can't wait behind a buy path
      if (hasOpenHere) {
        for (const outcome of ['up', 'down']) {
          const mark = exitMarkPrice(outcome, prices, depth);
          if (!mark) continue;
          const openPos = botState.positions.find((p) =>
            !p.closed && p.symbol === market.symbol && p.slug === market.slug && p.outcome === outcome
          );
          if (!openPos || openPos.holdToSettle) continue;
          markPosition(openPos, mark);
          const liveSignal = botState.signals?.[String(market.symbol || '').toLowerCase()] || null;
          const effectiveSl = resolveAdaptiveSl(openPos, { signal: liveSignal, cfg });
          if (openPos.gainPct > -effectiveSl && !(openPos.slPrice > 0 && mark <= Number(openPos.slPrice))) continue;
          const fillPrice = resolveSlFillPrice(openPos, mark, effectiveSl, cfg);
          let sellShares = positionShares(openPos);
          if (openPos.mode === 'live' && openPos.tokenId && sellShares > 0) {
            const pmShares = pmSharesForPosition(openPos, readiness?.positions || []);
            if (!(pmShares > 0)) {
              reconcileLiveGhostPosition(openPos, readiness?.positions || [], 'early_sl_no_pm_inventory');
              continue;
            }
            const adjustedShares = Math.min(sellShares, pmShares);
            if (adjustedShares <= 0) {
              reconcileLiveGhostPosition(openPos, readiness?.positions || [], 'early_sl_zero_adjusted_shares');
              continue;
            }
            if (Math.abs(adjustedShares - sellShares) > 0.01) {
              log(
                `🧮 LIVE EARLY-SL share clamp ${openPos.symbol} ${openPos.outcome.toUpperCase()} · ${sellShares.toFixed(3)}→${adjustedShares.toFixed(3)}sh`,
                'system',
                { symbol: openPos.symbol, slug: openPos.slug, requestedShares: sellShares, pmShares, adjustedShares },
              );
            }
            sellShares = adjustedShares;
            const sellDebug = buildLiveSellDebug(openPos, sellShares, 'early_sl');
            log(
              `🛰️ LIVE EARLY-SL SELL SUBMIT ${openPos.symbol} ${openPos.outcome.toUpperCase()} · ${sellDebug.requestedShares}sh`,
              'system',
              sellDebug,
            );
            try {
              const sellRes = await placeMarketSell({
                tokenId: openPos.tokenId,
                shares: sellShares,
                negRisk: openPos.negRisk,
                tickSize: openPos.tickSize,
              });
              openPos.sellOrderId = sellRes.id;
              log(
                `✅ LIVE EARLY-SL SELL ACCEPTED ${openPos.symbol} ${openPos.outcome.toUpperCase()} · ${sellDebug.requestedShares}sh`,
                'system',
                { ...sellDebug, sellOrderId: sellRes.id },
              );
            } catch (err) {
              log(
                `⚠️ LIVE EARLY-SL sell REJECTED ${openPos.symbol}: ${err.message.slice(0, 120)} — position stays open`,
                'error',
                { ...sellDebug, error: err.message.slice(0, 200) },
              );
              continue;
            }
          }
          markPosition(openPos, fillPrice);
          openPos.exitPrice = fillPrice;
          openPos.closed = true;
          openPos.exitReason = 'sl';
          if (openPos.mode === 'paper') {
            adjustPaperCash(Math.round(sellShares * fillPrice * 100) / 100, `SL ${openPos.symbol} ${openPos.outcome?.toUpperCase()}`);
          }
          saveTrade({
            ...openPos,
            timestamp: Date.now(),
            orderId: openPos.orderId,
            windowKey: windowKeyFromTrade(openPos) || parseSlugWindow(openPos.slug)?.key,
            effectiveSlPct: effectiveSl,
            markBid: mark,
            fillCapped: fillPrice > mark + 0.0005,
            earlyExit: true,
          });
          bookWindowExit('sl', openPos.pnl);
          log(`🛑 EARLY SL ${openPos.mode === 'live' ? 'LIVE' : 'PAPER'} ${openPos.symbol} ${openPos.outcome.toUpperCase()} · -$${Math.abs(openPos.pnl).toFixed(2)} (${openPos.gainPct.toFixed(1)}%) · stop ${effectiveSl}%`, 'sl', {
            market: openPos.symbol, slug: openPos.slug, outcome: openPos.outcome,
            entryPrice: openPos.entryPrice, exitPrice: fillPrice, gainPct: openPos.gainPct, pnl: openPos.pnl,
            effectiveSlPct: effectiveSl, markBid: mark,
          });
        }
      }
      const signal = botState.signals[market.symbol.toLowerCase()];
      // Always score both sides — signal preference is a score, not a hard filter (kills UP monopoly)
      const targetOutcomes = (cfg.evalBothSides === false && cfg.useSignals && signal?.direction && signal.direction !== 'neutral')
        ? [signal.direction]
        : ['up', 'down'];

      let action = 'hold';
      let buyOutcome = null;
      let buyPrice = null;
      let confidence = 0;
      const candidates = [];
      let selectedCandidate = null;
      const activePosition = botState.positions.find((position) =>
        position.symbol === market.symbol && position.slug === market.slug && !position.closed
      );

      const arb = cfg.clobArbEnabled !== false ? detectClobArb(depth, prices, cfg) : null;
      if (arb) {
        market.arb = arb;
      }

      // Exploit: buy BOTH legs when ask sum < 1 − minArbGap (guaranteed settlement edge)
      if (
        arb
        && remaining > Number(cfg.minRemainingSec ?? 15)
        && market.acceptingOrders
        && countOpenPositions(cfg.mode) + 2 <= Number(cfg.maxOpenPositions ?? 6)
        && !botState.positions.some((p) => !p.closed && p.slug === market.slug)
      ) {
        // Guaranteed settlement edge — size it off the whole book, not a flat $4 cap.
        // A riskless arb on a $100 account should commit real money, not pocket change.
        const arbBank = cfg.mode === 'paper'
          ? Number(cfg.paperBankroll ?? 0)
          : Number(readiness?.spendableBalance ?? readiness?.clobBalance ?? 0);
        const shareBudget = Math.max(
          Number(cfg.minPositionSize ?? 0.5) * 2,
          Math.min(
            arbBank * Number(cfg.arbBankrollFrac ?? 0.25),
            Number(cfg.arbMaxUsd ?? 40),
          ),
        );
        const shares = Math.max(0.5, Math.round((shareBudget / arb.sum) * 1000) / 1000);
        const costUp = Math.round(shares * arb.upAsk * 100) / 100;
        const costDown = Math.round(shares * arb.downAsk * 100) / 100;
        const totalCost = costUp + costDown;
        const canPay = cfg.mode !== 'paper' || Number(cfg.paperBankroll ?? 0) >= totalCost + 0.01;
        if (canPay && shares > 0) {
          for (const [outcome, ask, cost] of [['up', arb.upAsk, costUp], ['down', arb.downAsk, costDown]]) {
            const plan = buildTradePlan({
              cfg, market, outcome, price: ask, remaining, signal,
              sizeUsd: cost, kelly: { method: 'clob_arb', gap: arb.gap }, analysis: signal,
            });
            plan.shares = shares;
            plan.costEst = cost;
            plan.sizeUsd = cost;
            plan.targetTp = Math.max(plan.targetTp, arb.edgePct);
            // Arb legs must hold to settlement — never mid-cycle TP/SL grind
            plan.holdToSettle = true;
            plan.adaptiveSlEnabled = false;
            plan.slPct = Number(cfg.holdToSettleDisasterSlPct ?? 42);
            plan.partialTpPct = 999;
            plan.trailActivatePct = 999;
            const pending = {
              id: `arb-${outcome}-${Date.now().toString(36)}`,
              status: 'pending',
              symbol: market.symbol,
              slug: market.slug,
              outcome,
              tokenId: market.tokenIds?.[outcome] || null,
              negRisk: !!market.negRisk,
              tickSize: market.tickSize || '0.01',
              minShares: 1,
              plan: { ...plan, arb: true, arbGap: arb.gap, holdToSettle: true },
            };
            // Temporarily allow 2 concurrent on slug for dual-leg
            const prevMax = cfg.maxConcurrentPerSlug;
            botState.config.maxConcurrentPerSlug = 2;
            await executePendingTrade(pending);
            botState.config.maxConcurrentPerSlug = prevMax;
          }
          action = 'arb';
          log(`⚖️ CLOB ARB ${market.symbol} UP@${arb.upAsk.toFixed(3)}+DN@${arb.downAsk.toFixed(3)}=$${arb.sum} · gap +${arb.edgePct}% · ${shares} sh/leg`, 'buy', arb);
          signalsFound += 1;
        }
      }

      for (const outcome of targetOutcomes) {
        const depthSide = depth?.[outcome];
        // Prefer executable ask for buys; fall back to mid/gamma
        const price = (depthSide?.bestAsk > 0 && depthSide.bestAsk < 0.99)
          ? depthSide.bestAsk
          : prices[outcome];
        const existing = botState.positions.find((position) =>
          position.symbol === market.symbol && position.slug === market.slug && position.outcome === outcome && !position.closed
        );
        const candidate = buildDecision({
          cfg,
          market,
          outcome,
          price,
          remaining,
          signal,
          existingPosition: existing,
          readiness,
          depth,
          prices,
        });

        candidates.push(candidate);

        if (candidate.eligible && (!selectedCandidate || candidate.score > selectedCandidate.score)) {
          selectedCandidate = { ...candidate, signal };
        }
      }

      // Soft side-balance: only among candidates that already pass an edge filter (no FORCE DOWN)
      const edgeGate = evaluateEdgeGate(botState.trades, cfg);
      if (cfg.sideBalanceEnabled !== false && candidates.length >= 2) {
        const edged = candidates.filter((c) => passesEdgeFilter(c, signal));
        if (edged.length >= 2) {
          const skew = sideBalanceStats(cfg);
          edged.sort((a, b) => b.score - a.score);
          let pick = edged[0];
          if (skew.upShare >= 0.68) {
            const downPick = edged.find((c) => c.outcome === 'down');
            if (downPick && downPick.score >= pick.score - 18) pick = downPick;
          } else if (skew.upShare <= 0.32) {
            const upPick = edged.find((c) => c.outcome === 'up');
            if (upPick && upPick.score >= pick.score - 18) pick = upPick;
          }
          selectedCandidate = { ...pick, signal };
        } else if (edged.length === 1) {
          selectedCandidate = { ...edged[0], signal };
        }
      }

      // Arb-only gate: block directional buys until paper expectancy recovers
      if (selectedCandidate && action !== 'arb') {
        if (edgeGate.arbOnly) {
          selectedCandidate = null;
          action = 'hold';
          confidence = signal?.confidence || 0;
        } else {
          buyOutcome = selectedCandidate.outcome;
          buyPrice = selectedCandidate.price;
          action = 'buy';
          confidence = signal?.confidence || 0;
          signalsFound++;
        }
      }

      if (action === 'buy' && buyOutcome) {
        const env = manageEnvironment({
          opens: botState.positions,
          mode: cfg.mode,
          maxOpenPositions: Number(cfg.maxOpenPositions ?? 6),
          cash: readiness?.spendableBalance ?? cfg.paperBankroll,
          equity: null,
        });
        if (!env.allowNewEntries || !env.maxOpensFor(market.duration || '5m')) {
          action = 'hold';
          buyOutcome = null;
        } else if (hasOpenOnSlug(market.slug)) {
          action = 'hold';
        } else if (countOpenPositions(cfg.mode) >= Number(cfg.maxOpenPositions ?? 6)) {
          action = 'hold';
        } else {
        botState._buyLocks.add(market.slug);
        try {
        const { sizeUsd, kelly } = resolveOrderSize(cfg, {
          price: buyPrice,
          signal,
          readiness,
          stats: botState.stats,
          remaining,
          windowSec: market.windowSeconds || market.windowSec || POLY_WINDOW_SECONDS,
          duration: market.duration,
          symbol: market.symbol,
        });
        if (!sizeUsd || sizeUsd <= 0) {
          action = 'hold';
          botState._buyLocks.delete(market.slug);
        } else {
        botState.lastSizing = kelly ? { ...kelly, sizeUsd, bankroll: readiness?.spendableBalance } : { sizeUsd, reason: 'fixed' };

        const analysis = signal?.direction ? signal : null;
        const plan = buildTradePlan({
          cfg, market, outcome: buyOutcome, price: buyPrice, remaining, signal, sizeUsd, kelly, analysis,
        });

        if (cfg.mode === 'paper' && plan.costEst > Number(cfg.paperBankroll ?? 0) + 0.001) {
          action = 'hold';
          botState._buyLocks.delete(market.slug);
        } else {
        const autoApproved = (cfg.mode === 'paper' && cfg.autoApprovePaper)
          || (cfg.mode === 'live' && cfg.autoApproveLive);
        const shouldAnnounce = cfg.announceBeforeTrade !== false && !autoApproved;

        if (shouldAnnounce) {
          announceTrade(plan, market, buyOutcome);
          action = 'announce';
          // keep lock until approve / reject / expire
        } else {
          const pending = {
            id: `auto-${Date.now().toString(36)}`,
            status: 'pending',
            symbol: market.symbol,
            slug: market.slug,
            outcome: buyOutcome,
            tokenId: market.tokenIds?.[buyOutcome] || null,
            negRisk: !!market.negRisk,
            tickSize: market.tickSize || '0.01',
            minShares: market.minShares || 5,
            plan,
          };
          log(`📡 AUTO ${market.symbol} ${buyOutcome.toUpperCase()} @ $${buyPrice.toFixed(3)} · $${plan.costEst} · TP +${plan.targetTp}% · SL -${plan.slPct}%`, 'signal', {
            market: market.symbol, slug: market.slug, outcome: buyOutcome, ...plan,
          });
          await executePendingTrade(pending);
        }
        }
        }
        } catch (err) {
          botState._buyLocks.delete(market.slug);
          throw err;
        }
        }
      }

      // 0. Portfolio-level max drawdown circuit breaker
      if (!botState._ddTriggered) {
        const maxDd = Number(cfg.maxOpenDrawdownPct ?? 0);
        if (maxDd > 0) {
          let totalCost = 0, totalUnrealized = 0;
          const modePositions = botState.positions.filter(p => !p.closed && p.mode === cfg.mode);
          for (const op of modePositions) {
            const entryP = Number(op.entryPrice || 0);
            const shares = Number(op.shares || 0);
            const markP = Number(op.currentPrice || entryP);
            totalCost += entryP * shares;
            totalUnrealized += (markP - entryP) * shares;
          }
          if (totalCost > 0 && (totalUnrealized / totalCost) <= -maxDd) {
            const ddPct = ((totalUnrealized / totalCost) * 100).toFixed(1);
            log(`🔴 MAX DRAWDOWN ${cfg.mode.toUpperCase()} · ${ddPct}% off cost (limit ${(maxDd * 100)}%) — closing all positions`, 'system', { totalCost, totalUnrealized, ddPct, limit: maxDd });
            botState._ddTriggered = true;
            for (const op of modePositions) {
              if (op.mode === 'live' && op.tokenId && op.shares > 0) {
                try {
                  const sellRes = await placeMarketSell({
                    tokenId: op.tokenId,
                    shares: Number(op.shares),
                    negRisk: !!op.negRisk,
                    tickSize: op.tickSize || '0.01',
                  });
                  op.sellOrderId = sellRes?.id || op.sellOrderId;
                } catch (err) {
                  log(`⚠️ DRAWDOWN close failed ${op.slug}: ${err.message.slice(0, 120)} — leaving open`, 'error');
                  continue;
                }
              }
              const fillPrice = Number(op.currentPrice || op.entryPrice || 0);
              op.exitPrice = fillPrice;
              op.closed = true;
              op.exitReason = 'dd';
              if (op.mode === 'paper') {
                adjustPaperCash(Number(op.shares) * fillPrice, `DD ${op.symbol} ${op.outcome?.toUpperCase()}`);
              }
              saveTrade({ ...op, timestamp: Date.now(), exitReason: 'dd' });
            }
            botState.config.mode = 'paper';
            persistSync(FILES.CONFIG, {
              mode: 'paper',
              enabled: botState.config.enabled,
              paperBankroll: botState.config.paperBankroll,
              paperInitialDeposit: botState.config.paperInitialDeposit,
              profiles: botState.configStore?.profiles || botState.config,
            });
            log(`🔴 DRAWDOWN BREAKER — switched to paper mode, all positions closed`, 'system', {});
          }
        }
      }
      // Clear flag when scan completes
      process.nextTick(() => { botState._ddTriggered = false; });

      // Check exits for existing positions — mark on executable BID (not mid)
      for (const outcome of ['up', 'down']) {
        const price = exitMarkPrice(outcome, prices, depth);
        if (!price) continue;
        const pos = botState.positions.find(p =>
          p.symbol === market.symbol && p.slug === market.slug && p.outcome === outcome && !p.closed
        );
        if (!pos) continue;

        markPosition(pos, price);
        const gainPct = pos.gainPct;
        const liveSignal = botState.signals?.[String(market.symbol || '').toLowerCase()] || null;

        async function closePosition(exitReason, extraMeta = {}) {
          let fillPrice = Number(extraMeta.fillPrice || price);
          if (exitReason === 'sl') {
            const effSl = Number(extraMeta.effectiveSlPct ?? pos.effectiveSlPct ?? pos.slPct ?? cfg.slPct ?? 10);
            fillPrice = resolveSlFillPrice(pos, fillPrice || price, effSl, cfg);
            extraMeta = { ...extraMeta, markBid: price, fillCapped: fillPrice > price + 0.0005 };
          }
          let sellShares = exitReason === 'partial' ? positionShares(pos) * (pos.partialPct || 0.5) : positionShares(pos);
          if (pos.mode === 'live' && pos.tokenId && sellShares > 0) {
            const pmShares = pmSharesForPosition(pos, readiness?.positions || []);
            if (!(pmShares > 0)) {
              reconcileLiveGhostPosition(pos, readiness?.positions || [], `${exitReason}_no_pm_inventory`);
              return false;
            }
            const adjustedShares = Math.min(sellShares, pmShares);
            if (adjustedShares <= 0) {
              reconcileLiveGhostPosition(pos, readiness?.positions || [], `${exitReason}_zero_adjusted_shares`);
              return false;
            }
            if (Math.abs(adjustedShares - sellShares) > 0.01) {
              log(
                `🧮 LIVE ${exitReason.toUpperCase()} share clamp ${pos.symbol} ${pos.outcome.toUpperCase()} · ${sellShares.toFixed(3)}→${adjustedShares.toFixed(3)}sh`,
                'system',
                { symbol: pos.symbol, slug: pos.slug, requestedShares: sellShares, pmShares, adjustedShares },
              );
            }
            sellShares = adjustedShares;
          }
          if (exitReason === 'partial') {
            if (pos.mode === 'live' && pos.tokenId && sellShares > 0) {
              const sellDebug = buildLiveSellDebug(pos, sellShares, 'partial');
              log(
                `🛰️ LIVE PARTIAL SELL SUBMIT ${pos.symbol} ${pos.outcome.toUpperCase()} · ${sellDebug.requestedShares}sh`,
                'system',
                sellDebug,
              );
              try {
                const sellRes = await placeMarketSell({
                  tokenId: pos.tokenId,
                  shares: sellShares,
                  negRisk: pos.negRisk,
                  tickSize: pos.tickSize,
                });
                pos.sellOrderId = sellRes.id;
                log(
                  `✅ LIVE PARTIAL SELL ACCEPTED ${pos.symbol} ${pos.outcome.toUpperCase()} · ${sellDebug.requestedShares}sh`,
                  'system',
                  { ...sellDebug, sellOrderId: sellRes.id },
                );
              } catch (err) {
                log(
                  `⚠️ LIVE PARTIAL sell REJECTED ${pos.symbol}: ${err.message.slice(0, 140)} — keeping full size`,
                  'error',
                  { ...sellDebug, error: err.message.slice(0, 200) },
                );
                return false;
              }
            }
            pos.partialSold = true;
            pos.firstPartialTime = Date.now();
            const feeOn = botState.config.simulateClobFees !== false;
            const useClob = botState.config.useClobMarketFees !== false;
            const feeCat = botState.config.feeCategory || 'crypto';
            const proceedsPack = !feeOn
              ? { premium: Math.round(sellShares * fillPrice * 100) / 100, fee: 0, net: Math.round(sellShares * fillPrice * 100) / 100 }
              : (useClob && pos.tokenId)
                ? await closeProceedsWithFeeForToken(sellShares, fillPrice, pos.tokenId, 'partial', feeCat)
                : closeProceedsWithFee(sellShares, fillPrice, feeCat, 'partial');
            const proceeds = proceedsPack.net;
            const partialPnl = Math.round(((fillPrice - pos.entryPrice) * sellShares - proceedsPack.fee - (Number(pos.entryFee || 0) * (sellShares / Math.max(positionShares(pos) + sellShares, 1e-9)))) * 100) / 100;
            pos.shares = positionShares(pos) * (1 - (pos.partialPct || 0.5));
            pos.costBasis = Math.round(pos.shares * pos.entryPrice * 100) / 100;
            pos.markValue = Math.round(pos.shares * fillPrice * 100) / 100;
            pos.partialExitPrice = fillPrice;
            pos.partialPnl = partialPnl;
            pos.feesPaid = Math.round((Number(pos.feesPaid || 0) + proceedsPack.fee) * 1e5) / 1e5;
            if (pos.mode === 'paper') {
              adjustPaperCash(proceeds, `PARTIAL ${pos.symbol} ${pos.outcome?.toUpperCase()}`);
            }
            saveTrade({
              ...pos,
              id: `partial-${pos.id}-${Date.now().toString(36)}`,
              shares: sellShares,
              size: proceeds,
              costBasis: Math.round(sellShares * pos.entryPrice * 100) / 100,
              exitPrice: fillPrice,
              pnl: partialPnl,
              closed: true,
              exitReason: 'partial',
              timestamp: Date.now(),
              ...extraMeta,
            });
            log(`🔹 PARTIAL TP ${pos.symbol} ${pos.outcome.toUpperCase()} · +$${partialPnl.toFixed(2)} (+${gainPct.toFixed(1)}%) · ${(pos.partialPct * 100).toFixed(0)}% sold, ${pos.shares.toFixed(2)} sh remain`, 'tp', {
              market: pos.symbol, slug: pos.slug, outcome: pos.outcome,
              entryPrice: pos.entryPrice, exitPrice: fillPrice, gainPct, pnl: partialPnl, shares: sellShares,
            });
            saveState();
            return true;
          }
          // LIVE: exchange sell must succeed BEFORE we book the close.
          // Settle: if sell fails, keep open as pendingRedeem — do NOT invent PnL (PM closed-positions is truth).
          if (pos.mode === 'live' && pos.tokenId && sellShares > 0) {
            const sellDebug = buildLiveSellDebug(pos, sellShares, exitReason);
            log(
              `🛰️ LIVE ${exitReason.toUpperCase()} SELL SUBMIT ${pos.symbol} ${pos.outcome.toUpperCase()} · ${sellDebug.requestedShares}sh`,
              'system',
              sellDebug,
            );
            try {
              const sellRes = await placeMarketSell({
                tokenId: pos.tokenId,
                shares: sellShares,
                negRisk: pos.negRisk,
                tickSize: pos.tickSize,
              });
              pos.sellOrderId = sellRes.id;
              log(
                `✅ LIVE ${exitReason.toUpperCase()} SELL ACCEPTED ${pos.symbol} ${pos.outcome.toUpperCase()} · ${sellDebug.requestedShares}sh`,
                'system',
                { ...sellDebug, sellOrderId: sellRes.id },
              );
            } catch (err) {
              if (exitReason === 'settle') {
                pos.pendingRedeem = true;
                pos.pendingRedeemAt = Date.now();
                log(
                  `⏳ LIVE SETTLE pending redeem ${pos.symbol}: ${err.message.slice(0, 120)} — leaving open until PM confirms`,
                  'system',
                  { ...sellDebug, error: err.message.slice(0, 200), pendingRedeem: true },
                );
                saveState();
                syncLiveAccount({ botTrades: botState.trades, note: 'settle_pending' }).catch(() => {});
                return false;
              }
              log(
                `⚠️ LIVE ${exitReason.toUpperCase()} sell REJECTED ${pos.symbol}: ${err.message.slice(0, 140)} — position stays open`,
                'error',
                { ...sellDebug, error: err.message.slice(0, 200) },
              );
              return false;
            }
          }
          markPosition(pos, fillPrice);
          pos.exitPrice = fillPrice;
          pos.closed = true;
          pos.exitReason = exitReason;
          pos.pendingRedeem = false;
          if (pos.mode === 'paper') {
            const feeOn = cfg.simulateClobFees !== false;
            const useClob = cfg.useClobMarketFees !== false;
            const feeCat = cfg.feeCategory || 'crypto';
            const pack = !feeOn
              ? { premium: Math.round(sellShares * fillPrice * 100) / 100, fee: 0, net: Math.round(sellShares * fillPrice * 100) / 100 }
              : (useClob && pos.tokenId)
                ? await closeProceedsWithFeeForToken(sellShares, fillPrice, pos.tokenId, exitReason, feeCat)
                : closeProceedsWithFee(sellShares, fillPrice, feeCat, exitReason);
            const entryFeeAlloc = Number(pos.entryFee || 0);
            pos.exitFee = pack.fee;
            pos.feesPaid = Math.round((entryFeeAlloc + pack.fee) * 1e5) / 1e5;
            pos.pnl = Math.round(((fillPrice - pos.entryPrice) * sellShares - entryFeeAlloc - pack.fee) * 100) / 100;
            adjustPaperCash(pack.net, `${exitReason.toUpperCase()}${isFeeFreeExit(exitReason) ? ' (redeem)' : ''} ${pos.symbol} ${pos.outcome?.toUpperCase()}`);
            recordTradeSample({
              asset: pos.symbol,
              slug: pos.slug,
              duration: pos.duration || durationFromSlug(pos.slug),
              entryPrice: pos.entryPrice,
              exitPrice: fillPrice,
              pnl: pos.pnl,
              grossPnl: pos.pnl,
              fees: pos.feesPaid,
              confidence: pos.confidence,
              direction: pos.outcome,
              exitReason,
              mode: 'paper',
            });
          }
          saveTrade({ ...pos, timestamp: Date.now(), orderId: pos.orderId, windowKey: windowKeyFromTrade(pos) || parseSlugWindow(pos.slug)?.key, ...extraMeta });
          recordTradeSample({
            asset: pos.symbol,
            slug: pos.slug,
            duration: pos.duration || durationFromSlug(pos.slug),
            entryPrice: pos.entryPrice,
            exitPrice: fillPrice,
            pnl: pos.pnl,
            grossPnl: pos.pnl,
            fees: pos.feesPaid,
            confidence: pos.confidence,
            direction: pos.outcome,
            exitReason,
            mode: pos.mode || 'paper',
          });
          if (pos.mode === 'live') {
            traceLiveFill({
              type: 'bot_exit',
              message: `LIVE ${exitReason.toUpperCase()} ${pos.symbol} ${String(pos.outcome || '').toUpperCase()} · ${sellShares}sh @ ${fillPrice} · PnL $${Number(pos.pnl || 0).toFixed(2)}`,
              slug: pos.slug,
              outcome: pos.outcome,
              side: 'SELL',
              shares: sellShares,
              price: fillPrice,
              usdc: Math.round(sellShares * fillPrice * 100) / 100,
              pnl: pos.pnl,
              orderId: pos.orderId,
              sellOrderId: pos.sellOrderId,
              exitReason,
              verifiedSell: !!pos.sellOrderId,
            });
            syncLiveAccount({ botTrades: botState.trades, note: `exit_${exitReason}` }).catch(() => {});
          }
          // Book EVERY exit into the open→end window accum (not just settle)
          if (exitReason !== 'partial') {
            bookWindowExit(exitReason, pos.pnl);
          } else {
            bookWindowExit('partial', extraMeta.partialPnl ?? pos.partialPnl ?? 0);
          }
          try { await syncClobBalance(); await refreshTelemetry(); } catch {}
          return true;
        }

        const win = marketWindow(market);
        const remainingFromMarket = Math.ceil((win.remainingMs ?? remaining * 1000) / 1000);

        // Force settle only when THIS market window is done (slug open→end)
        if (remainingFromMarket <= 0 || (remainingFromMarket <= 8 && (price <= 0.02 || price >= 0.98))) {
          const settleReason = 'settle';
          await closePosition(settleReason);
          const pnlTxt = `${(pos.pnl || 0) >= 0 ? '+' : ''}$${Math.abs(pos.pnl || 0).toFixed(2)}`;
          log(`🏁 ${pos.mode === 'live' ? 'LIVE' : 'PAPER'} SETTLE ${pos.symbol} ${pos.outcome.toUpperCase()} · ${pnlTxt} (${gainPct.toFixed(1)}%) · window ${win.key}`, gainPct >= 0 ? 'tp' : 'sl', {
            market: pos.symbol, slug: pos.slug, outcome: pos.outcome,
            entryPrice: pos.entryPrice, exitPrice: pos.exitPrice || price, gainPct, pnl: pos.pnl, shares: positionShares(pos),
            windowKey: win.key, openAt: win.startAtMs, endAt: win.endAtMs,
          });
          continue;
        }

        // Hold-to-settle underdogs: still allow FULL TP near resolution / target; else disaster SL only
        if (pos.holdToSettle) {
          const tpPriceHit = pos.tpPrice > 0 && price >= pos.tpPrice * 0.995;
          const fullTpHit = gainPct >= Number(pos.targetTp || 999) || tpPriceHit || price >= 0.97;
          if (fullTpHit) {
            if (await closePosition('tp', { holdToSettle: true, fullTp: true }) === false) continue;
            log(`💰 HOLD-TP ${pos.symbol} ${pos.outcome.toUpperCase()} · +$${pos.pnl.toFixed(2)} (+${gainPct.toFixed(1)}%)`, 'tp', {
              market: pos.symbol, slug: pos.slug, outcome: pos.outcome,
              entryPrice: pos.entryPrice, exitPrice: price, gainPct, pnl: pos.pnl,
            });
            continue;
          }
          const disasterSl = Number(pos.slPct || cfg.holdToSettleDisasterSlPct || 42);
          if (gainPct <= -disasterSl || (pos.slPrice > 0 && price <= pos.slPrice)) {
            if (await closePosition('sl', { holdToSettle: true, disaster: true, effectiveSlPct: disasterSl }) === false) continue;
            log(`🛑 DISASTER SL ${pos.symbol} ${pos.outcome.toUpperCase()} · -$${Math.abs(pos.pnl).toFixed(2)} (${pos.gainPct.toFixed(1)}%) · hold-to-settle`, 'sl', {
              market: pos.symbol, slug: pos.slug, outcome: pos.outcome,
              entryPrice: pos.entryPrice, exitPrice: pos.exitPrice, gainPct: pos.gainPct, pnl: pos.pnl,
            });
          }
          continue;
        }

        // 1. Adaptive SL — tighten toward floor when loss deepening + confidence dropping
        const effectiveSl = resolveAdaptiveSl(pos, { signal: liveSignal, cfg });
        const hitSlPct = gainPct <= -effectiveSl;
        const hitSlPrice = pos.slPrice > 0 && price <= Number(pos.slPrice);
        if (hitSlPct || hitSlPrice) {
          if (await closePosition('sl', { effectiveSlPct: effectiveSl, adaptive: !!pos.adaptiveSlArmed, hitSlPct, hitSlPrice }) === false) continue;
          log(`🛑 ${pos.mode === 'live' ? 'LIVE' : 'PAPER'} SL ${pos.symbol} ${pos.outcome.toUpperCase()} · -$${Math.abs(pos.pnl).toFixed(2)} (${pos.gainPct.toFixed(1)}%) · stop ${effectiveSl}%${pos.adaptiveSlArmed ? ' adaptive' : ''}`, 'sl', {
            market: pos.symbol, slug: pos.slug, outcome: pos.outcome,
            entryPrice: pos.entryPrice, exitPrice: pos.exitPrice, gainPct: pos.gainPct, pnl: pos.pnl, shares: positionShares(pos),
            effectiveSlPct: effectiveSl, markBid: price,
          });
          continue;
        }

        // 2. Check trailing stop
        const trailHit = checkTrailingStop(pos, price);
        if (trailHit) {
          if (await closePosition(trailHit) === false) continue;
          log(`🪤 TRAIL ${pos.symbol} ${pos.outcome.toUpperCase()} · ${gainPct.toFixed(1)}% from peak · +$${pos.pnl.toFixed(2)}`, 'tp', {
            market: pos.symbol, slug: pos.slug, outcome: pos.outcome,
            entryPrice: pos.entryPrice, exitPrice: price, gainPct, pnl: pos.pnl, shares: positionShares(pos),
            highestPrice: pos.highestPrice,
          });
          continue;
        }

        // 3. Check partial profit (before full TP) — rarer / later via cfg.partialTpFrac
        if (!pos.partialSold) {
          const partialHit = checkPartialProfit(pos, price);
          if (partialHit) {
            await closePosition(partialHit);
            continue;
          }
        }

        // 4. Full TP — gain% OR absolute tpPrice (inclusion of both cases)
        // TP uses ask/mid for take-profit trigger when bid alone is sticky
        const tpMark = Number(depth?.[outcome]?.bestAsk || prices?.[outcome] || price);
        const tpGain = pos.entryPrice ? ((tpMark - pos.entryPrice) / pos.entryPrice) * 100 : gainPct;
        const tpPctHit = tpGain >= Number(pos.targetTp || 999);
        const tpPriceHit = pos.tpPrice > 0 && tpMark >= Number(pos.tpPrice) * 0.998;
        if (tpPctHit || tpPriceHit) {
          if (await closePosition('tp', { tpPctHit, tpPriceHit, fillPrice: tpMark }) === false) continue;
          log(`💰 ${pos.mode === 'live' ? 'LIVE' : 'PAPER'} TP ${pos.symbol} ${pos.outcome.toUpperCase()} · +$${pos.pnl.toFixed(2)} (+${pos.gainPct.toFixed(1)}%)`, 'tp', {
            market: pos.symbol, slug: pos.slug, outcome: pos.outcome,
            entryPrice: pos.entryPrice, exitPrice: pos.exitPrice || tpMark, gainPct: pos.gainPct, pnl: pos.pnl, shares: positionShares(pos),
            tpPctHit, tpPriceHit,
          });
        }
      }

      const winMeta = marketWindow(market);
      const windowStartMs = winMeta.startAtMs;
      const pendingForMarket = botState.pendingTrades.find(
        (p) => p.status === 'pending' && p.slug === market.slug
      );

      const decision = summarizeMarketDecision({
        market,
        remaining,
        selectedCandidate: action === 'announce' ? null : selectedCandidate,
        candidates,
        activePosition,
        announced: pendingForMarket || (action === 'announce' ? botState.pendingTrades.find((p) => p.slug === market.slug) : null),
      });

      if (action === 'buy' || action === 'arb' || action === 'announce' || (selectedCandidate && selectedCandidate.eligible)) {
        pushTrace('decision', {
          symbol: market.symbol,
          slug: market.slug,
          action,
          outcome: selectedCandidate?.outcome || buyOutcome,
          score: selectedCandidate?.score,
          price: selectedCandidate?.price || buyPrice,
          confidence: signal?.confidence,
          reasons: (selectedCandidate?.reasons || decision?.trace || []).slice(0, 6),
          arb: market.arb || null,
          tpSl: selectedCandidate ? null : null,
        });
      }

      enriched.push({
        symbol: market.symbol, slug: market.slug, question: market.question,
        tokenIds: market.tokenIds, endTime: market.endTime,
        endDate: market.endDate || null,
        eventStartTime: market.eventStartTime || null,
        startAtMs: windowStartMs,
        endAtMs: winMeta.endAtMs,
        durationSec: winMeta.windowSec || POLY_WINDOW_SECONDS,
        windowKey: winMeta.key,
        windowStatus: market.isCurrent ? 'LIVE' : 'NEXT',
        remaining: Math.ceil((winMeta.remainingMs || 0) / 1000),
        remainingMs: winMeta.remainingMs,
        prices, action,
        priceSource: prices?._source || 'gamma',
        priceToBeat: market.priceToBeat ?? null,
        priceToBeatMeta: market.priceToBeatMeta || null,
        oracleClose: market.priceToBeatMeta?.closePrice ?? null,
        isCurrent: market.isCurrent,
        acceptingOrders: market.acceptingOrders,
        spread: prices.up && prices.down ? Math.round((1 - prices.up - prices.down) * 1000) / 1000 : null,
        depth: summarizeBook(depth),
        book: summarizeBook(depth),
        signal: signal ? { direction: signal.direction, confidence: signal.confidence, rsi: signal.rsi } : null,
        signalDetails: summarizeSignal(signal),
        decision,
        candidates,
        sizingPreview: selectedCandidate?.eligible ? resolveOrderSize(cfg, {
          price: selectedCandidate.price,
          signal,
          readiness,
          stats: botState.stats,
          remaining: market.remaining,
          windowSec: market.windowSeconds || POLY_WINDOW_SECONDS,
          duration: market.duration,
          symbol: market.symbol,
        }) : null,
        position: activePosition ? {
          id: activePosition.id,
          outcome: activePosition.outcome,
          entryPrice: activePosition.entryPrice,
          currentPrice: activePosition.currentPrice,
          shares: positionShares(activePosition),
          gainPct: activePosition.gainPct || 0,
          pnl: activePosition.pnl || 0,
          markValue: activePosition.markValue || activePosition.size,
          mode: activePosition.mode,
          targetTp: activePosition.targetTp,
        } : null,
        volume: market.volume || 0,
        liquidity: market.liquidity || 0,
        tickSize: market.tickSize,
        minShares: market.minShares,
      });
    }

    botState.markets = [
      ...enriched,
      ...markets.filter((market) => !market.isCurrent).map((market) => {
        const nextRemainingMs = market.endTime
          ? Math.max(0, market.endTime * 1000 - Date.now())
          : getRemainingMs();
        return {
        symbol: market.symbol,
        slug: market.slug,
        question: market.question,
        endTime: market.endTime,
        endDate: market.endDate || null,
        eventStartTime: market.eventStartTime || null,
        duration: market.duration || durationFromSlug(market.slug) || '5m',
        windowSeconds: market.windowSeconds || POLY_WINDOW_SECONDS,
        endAtMs: market.endTime ? market.endTime * 1000 : getCycleEndMs(market.windowSeconds || POLY_WINDOW_SECONDS),
        remaining: Math.ceil(nextRemainingMs / 1000),
        remainingMs: nextRemainingMs,
        prices: market.gammaPrices || {},
        priceToBeat: market.priceToBeat ?? null,
        priceToBeatMeta: market.priceToBeatMeta || null,
        action: 'watch',
        isCurrent: false,
        decision: {
          action: 'watch',
          summary: `NEXT ${market.symbol} ${market.duration || ''} window`,
          trace: [`next ${market.duration || '5m'} window — not trading yet`],
        },
      };
      }),
    ];
    botState.lastScan = Date.now();

    // Recompute assurance with CLOB mids from this scan (authoritative for reporting).
    botState._dataAssurance = buildDataAssurance({
      spotPrices: botState.spotPrices,
      signals: botState.signals,
      feed: {
        status: 'live',
        lastSignalAt: Math.max(
          Number(botState.signals?.btc?.timestamp || 0),
          Number(botState.signals?.eth?.timestamp || 0),
        ) || null,
      },
      markets: botState.markets,
      positions: botState.positions,
      cashAudit: {
        ok: true,
        cash: botState.config.paperBankroll,
        equity: botState.config.paperBankroll,
        issues: [],
      },
      priceToBeat: Object.fromEntries(
        botState.markets
          .filter((m) => m.isCurrent && m.priceToBeat != null)
          .map((m) => [String(m.symbol).toLowerCase(), { openPrice: m.priceToBeat }]),
      ),
      lastScan: botState.lastScan,
      botRunning: true,
    });

    const t = botState.trades;
    botState.stats.totalTrades = t.length;
    botState.stats.totalPnl = Math.round(t.reduce((s, x) => s + (x.pnl || 0), 0) * 100) / 100;
    botState.stats.wins = t.filter(x => (x.pnl || 0) > 0).length;
    botState.stats.losses = t.filter(x => (x.pnl || 0) <= 0).length;

    saveState();

    const buyCount = enriched.filter((market) => market.action === 'buy').length;
    logScan(
      `🔎 Scan #${botState.stats.scansDone} — ${enriched.length} mkts · ${buyCount} buy signals · cycle ${formatRemainingMs()}`,
      {
        scan: botState.stats.scansDone,
        markets: enriched.map((market) => ({
          symbol: market.symbol,
          slug: market.slug,
          action: market.action,
          summary: market.decision?.summary,
          remaining: market.remaining,
        })),
      }
    );

  } catch (err) {
    log(`⚠️ Scan error: ${err.message}`, 'error');
  } finally {
    botState._scanning = false;
  }
}

async function fetchSpotTicker(symbol) {
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
}

export async function refreshSpotPrices() {
  try {
    const [btc, eth] = await Promise.all([
      fetchSpotTicker('BTCUSDT'),
      fetchSpotTicker('ETHUSDT'),
    ]);
    botState.spotPrices = {
      btc: btc || botState.spotPrices.btc,
      eth: eth || botState.spotPrices.eth,
    };
    // Also feed REST prices to spot history buffer (WS provides the real stream)
    if (btc?.price) addSpotTick('btc', btc.price, btc.ts);
    if (eth?.price) addSpotTick('eth', eth.price, eth.ts);
  } catch {}
  return botState.spotPrices;
}

function windowStatusFor(market, remainingMs) {
  if (market.closed || remainingMs <= 0) return 'RESOLVED';
  if (!market.isCurrent) return 'NEXT';
  if (remainingMs <= 15000) return 'ENDING';
  return 'LIVE';
}

/** Keep markets + resolution visible even when the trading bot is stopped */
export async function refreshLiveMarkets() {
  if (botState._scanning) return botState.markets;
  if (botState._refreshingMarkets) return botState.markets;
  botState._refreshingMarkets = true;
  try {
    const { markets, diagnostics } = await findMarkets(resolveMarketDurations(botState.config));
    botState.diagnostics = diagnostics;
    // Always prefer CLOB mids for UP/DOWN (public feed + trading). Gamma is fallback only.
    const useClob = botState.config?.useClobMids !== false;
    // Soft-timeout CLOB so a dead proxy cannot block Gamma + price-to-beat forever.
    const withTimeout = (promise, ms, fallback) => Promise.race([
      promise,
      new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
    ]);

    const enrichOne = async (market) => {
      const prices = useClob
        ? await withTimeout(
          getPricesForMarket(market).catch(() => market.gammaPrices || {}),
          2000,
          market.gammaPrices || {},
        )
        : (market.gammaPrices || {});
      const depth = useClob
        ? await withTimeout(
          getDepthForMarket(market).catch(() => null),
          2000,
          null,
        )
        : null;
      const priceToBeat = await fetchPriceToBeat(market).catch(() => null);
      recordChartTick(market.slug, prices);
      const remainingMs = market.endTime
        ? Math.max(0, market.endTime * 1000 - Date.now())
        : getRemainingMs();
      const remaining = Math.ceil(remainingMs / 1000);
      const windowStatus = windowStatusFor(market, remainingMs);
      const up = prices.up ?? market.gammaPrices?.up;
      const down = prices.down ?? market.gammaPrices?.down;
      const priceSource = prices._source || (useClob ? 'gamma' : 'gamma');
      const impliedWinner = up != null && down != null
        ? (up > down ? 'UP' : down > up ? 'DOWN' : 'TIE')
        : null;

      const bookSummary = summarizeBook(depth);
      const openPrice = priceToBeat?.openPrice ?? null;
      const oracleClose = priceToBeat?.closePrice ?? null;
      const liveSpot = botState.spotPrices?.[market.symbol.toLowerCase()]?.price
        ?? botState.signals?.[market.symbol.toLowerCase()]?.price
        ?? null;
      const vsBeat = openPrice != null && liveSpot != null
        ? {
            delta: Math.round((liveSpot - openPrice) * 100) / 100,
            pct: Math.round(((liveSpot - openPrice) / openPrice) * 10000) / 100,
            side: liveSpot >= openPrice ? 'up' : 'down',
          }
        : null;

      return {
        symbol: market.symbol,
        slug: market.slug,
        question: market.question,
        tokenIds: market.tokenIds,
        endTime: market.endTime,
        eventStartTime: market.eventStartTime || null,
        duration: market.duration || durationFromSlug(market.slug) || '5m',
        windowSeconds: market.windowSeconds || windowSecondsForDuration(market.duration) || POLY_WINDOW_SECONDS,
        startAtMs: market.endTime
          ? (market.endTime - (market.windowSeconds || POLY_WINDOW_SECONDS)) * 1000
          : null,
        endAtMs: market.endTime ? market.endTime * 1000 : getCycleEndMs(market.windowSeconds || POLY_WINDOW_SECONDS),
        durationSec: market.windowSeconds || windowSecondsForDuration(market.duration) || POLY_WINDOW_SECONDS,
        windowStatus,
        remaining,
        remainingMs,
        prices: { up, down },
        priceSource,
        priceToBeat: openPrice,
        oracleClose,
        priceToBeatMeta: priceToBeat ? {
          openPrice,
          closePrice: oracleClose,
          completed: !!priceToBeat.completed,
          source: priceToBeat.source,
          fetchedAt: priceToBeat.fetchedAt,
        } : null,
        vsBeat,
        action: botState.running ? (botState.markets.find((m) => m.slug === market.slug)?.action || 'watch') : 'watch',
        isCurrent: market.isCurrent,
        acceptingOrders: market.acceptingOrders && remainingMs > 0,
        closed: !!market.closed || remainingMs <= 0,
        spread: up != null && down != null ? Math.round((1 - up - down) * 1000) / 1000 : null,
        impliedWinner,
        book: bookSummary,
        depth: bookSummary,
        resolution: {
          status: windowStatus,
          endsAt: market.endTime ? market.endTime * 1000 : null,
          impliedWinner,
          priceToBeat: openPrice,
          note: windowStatus === 'RESOLVED'
            ? 'Window ended — Polymarket settles winning side'
            : windowStatus === 'ENDING'
              ? 'Final seconds — exits / resolution imminent'
              : windowStatus === 'LIVE'
                ? 'Accepting orders'
                : 'Next window',
        },
        signal: botState.signals[market.symbol.toLowerCase()]
          ? {
              direction: botState.signals[market.symbol.toLowerCase()].direction,
              confidence: botState.signals[market.symbol.toLowerCase()].confidence,
              rsi: botState.signals[market.symbol.toLowerCase()].rsi,
            }
          : null,
        volume: market.volume || 0,
        liquidity: market.liquidity || 0,
        tickSize: market.tickSize,
        minShares: market.minShares,
      };
    };

    const enriched = await Promise.all(markets.map(enrichOne));

    // Keep CLOB WS subscribed to current + next window token IDs (direct, no proxy).
    const tokenIds = [];
    for (const m of markets) {
      for (const id of Object.values(m.tokenIds || {})) {
        if (id) tokenIds.push(String(id));
      }
    }
    setClobMarketTokens(tokenIds);

    // Preserve richer scan decision fields when bot is actively scanning/running
    if (botState.running && botState.markets?.length) {
      const bySlug = Object.fromEntries(botState.markets.map((m) => [m.slug, m]));
      botState.markets = enriched.map((m) => {
        const prev = bySlug[m.slug];
        if (!prev) return m;
        return {
          ...m,
          action: prev.action,
          decision: prev.decision,
          candidates: prev.candidates,
          sizingPreview: prev.sizingPreview,
          position: prev.position,
          signalDetails: prev.signalDetails,
          // Keep fresh CLOB depth from enrich; only preserve scan fields above
        };
      });
    } else {
      botState.markets = enriched;
    }
    notifyStateChange();
  } catch (err) {
    console.error('refreshLiveMarkets:', err?.message || err);
  } finally {
    botState._refreshingMarkets = false;
  }
  return botState.markets;
}

export async function sampleCharts({ refreshMl = false } = {}) {
  try {
    const { markets } = await findMarkets(resolveMarketDurations(botState.config));
    const current = markets.filter((m) => m.isCurrent);
    await Promise.all(current.map(async (m) => {
      const prices = await getPricesForMarket(m).catch(() => m.gammaPrices || {});
      recordChartTick(m.slug, prices);
    }));
  } catch {}

  if (refreshMl && botState.config.useML !== false) {
    await refreshMLTraces(false).catch(() => {});
  }

  return {
    charts: Object.fromEntries(
      Object.keys(botState._chartTicks).map((slug) => [slug, getChartSeries(slug)])
    ),
    mlTraces: {
      btc: getPriceTrace('btc'),
      eth: getPriceTrace('eth'),
    },
    confidenceBuffer: getConfidenceBufferStats(),
    mlPython: null,
  };
}

let _mlRefreshRunning = false;
let _lastMlRefresh = 0;
const ML_REFRESH_MIN_MS = 50000;

export async function refreshMLTraces(force = false) {
  if (botState.config.useML === false) {
    return { btc: getPriceTrace('btc'), eth: getPriceTrace('eth') };
  }
  if (_mlRefreshRunning) {
    return { btc: getPriceTrace('btc'), eth: getPriceTrace('eth'), pending: true };
  }
  if (!force && Date.now() - _lastMlRefresh < ML_REFRESH_MIN_MS) {
    return { btc: getPriceTrace('btc'), eth: getPriceTrace('eth'), cached: true };
  }

  _mlRefreshRunning = true;
  try {
    // Prefer longest live book duration so 15m/30m/1h activate longer ML ladders
    const liveDurs = (botState.markets || [])
      .filter((m) => m.isCurrent)
      .map((m) => String(m.duration || '5m').toLowerCase());
    const marketDuration = liveDurs.includes('1h') || liveDurs.includes('60m')
      ? '1h'
      : liveDurs.includes('30m')
        ? '30m'
        : liveDurs.includes('15m')
          ? '15m'
          : '5m';
    const traces = await getMLTraceForBoth(marketDuration);
    for (const asset of ['btc', 'eth']) {
      const trace = traces[asset];
      if (!trace || trace.error) continue;
      if (trace.priceTrace?.length) {
        addPriceTrace(asset, trace.priceTrace);
        addMLPrediction(asset, {
          direction: trace.direction,
          confidence: trace.confidence,
          expected_return: trace.expected_return,
        });
      }
    }
    _lastMlRefresh = Date.now();
    notifyStateChange();
  } catch (err) {
    console.error('ML trace refresh failed:', err?.message || err);
  } finally {
    _mlRefreshRunning = false;
  }

  return {
    btc: getPriceTrace('btc'),
    eth: getPriceTrace('eth'),
    refreshedAt: _lastMlRefresh,
  };
}

let _feedsStarted = false;
export function startBackgroundFeeds() {
  if (_feedsStarted) return;
  _feedsStarted = true;
  reconcilePaperCash('feeds start');
  repairPaperOverdraft('feeds start');

  // Live CLOB UP/DOWN books via WebSocket (direct — not order-write proxy)
  startClobMarketStream([]);

  // Immediate kick
  refreshSpotPrices().catch(() => {});
  refreshLiveMarkets().catch(() => {});
  syncBalances().catch(() => {});

  // Spot BTC/ETH every 3s
  setInterval(() => {
    refreshSpotPrices().catch(() => {});
  }, 3000);

  // Markets + resolution + chart ticks every 3s (works with bot stopped)
  setInterval(() => {
    refreshLiveMarkets().catch(() => {});
  }, 3000);

  // Keep CLOB / cash fresh
  setInterval(() => {
    syncBalances().catch(() => {});
  }, 30000);

  // Session PnL reconcile while bot running (every 20s)
  setInterval(() => {
    if (!botState.running) return;
    try {
      const mode = botState.config.mode || 'paper';
      const portfolio = buildPortfolio(botState.readiness, mode);
      const modeTrades = dedupeTrades(botState.trades).filter((t) => t.mode === mode);
      const sessionCashDelta = botState.session?.baselineCash != null
        ? Math.round((Number(portfolio.cash) - Number(botState.session.baselineCash)) * 100) / 100
        : null;
      reconcileSession({
        mode,
        cash: portfolio.cash,
        equity: portfolio.equity,
        realizedPnl: portfolio.realizedPnl,
        unrealizedPnl: portfolio.unrealizedPnl,
        openCost: portfolio.openCostBasis,
        openMark: portfolio.openMarkValue,
        // Always use THIS session's cash baseline — never stale poly_baseline / paperInitial
        initialBankroll: Number(botState.session?.baselineCash ?? portfolio.cash),
        tradesPnlSum: modeTrades.reduce((s, t) => s + Number(t.pnl || 0), 0),
        sessionCashDelta,
        issues: [],
      });
      if (mode === 'live') {
        syncLiveAccount({ botTrades: botState.trades, note: 'session_tick' }).catch(() => {});
      }
    } catch {}
  }, 20000);

  // Extra chart sample
  setInterval(() => {
    sampleCharts({ refreshMl: false }).catch(() => {});
  }, 5000);

  // ML ladder traces (~every 55s, first kick after 3s)
  setTimeout(() => {
    refreshMLTraces(true).catch(() => {});
  }, 3000);
  setInterval(() => {
    refreshMLTraces(false).catch(() => {});
  }, 55000);

  // Cycle watch even when bot stopped (settle banner)
  setInterval(() => {
    maybeFinalizeCycle();
  }, 2000);

  // Public signal feed — always-on TA so /api/v1 publishes live signals without trading bot
  const publishPublicSignals = async () => {
    if (botState.running && botState.config.useSignals) return; // scan() owns signals while trading
    try {
      const both = await getSignalForBoth();
      if (!both) return;
      const now = Date.now();
      botState.signals = {
        btc: both.btc ? { ...both.btc, asset: 'BTC', timestamp: both.btc.timestamp || now } : botState.signals.btc,
        eth: both.eth ? { ...both.eth, asset: 'ETH', timestamp: both.eth.timestamp || now } : botState.signals.eth,
      };
      botState._publicSignalAt = now;
      notifyStateChange();
    } catch (err) {
      console.error('[public-signals]', err?.message || err);
    }
  };
  publishPublicSignals().catch(() => {});
  setInterval(() => { publishPublicSignals().catch(() => {}); }, 2000);
}

function ensureOptimizerTimer() {
  if (botState._optimizerTimer) return;
  const ms = Number(botState.config.optimizeIntervalMs ?? 180000);
  botState._optimizerTimer = setInterval(() => {
    if (!botState.running || botState.config.llmOptimize === false) return;
    optimizeNow({ apply: true, useLlm: true }).catch(() => {});
  }, Math.max(60000, ms));
}

function ensureGovernorTimer() {
  if (botState._governorTimer) return;
  const ms = Number(botState.config.governorIntervalMs ?? 120000);
  botState._governorTimer = setInterval(() => {
    if (!botState.running || botState.config.governorEnabled === false) return;
    governorNow({ useLlm: true }).catch(() => {});
  }, Math.max(60000, ms));
}

export function startBot() {
  if (botState.running) {
    notifyStateChange();
    return { ok: true, already: true };
  }
  // Enforce paper lock before enabling
  const gate = evaluateEdgeGate(botState.trades, botState.config);
  if (botState.config.mode === 'live' && !gate.liveAllowed) {
    saveConfig({ mode: 'paper', enabled: true });
    log(`🔒 LIVE → PAPER on start — ${gate.reason}`, 'system', { edgeGate: gate });
  } else {
    saveConfig({ enabled: true });
  }
  botState.running = true;
  botState._startTime = Date.now();
  botState.stopRequest = null;
  reconcilePaperCash('bot start');
  repairPaperOverdraft('bot start');
  const modeTrades = dedupeTrades(botState.trades).filter((trade) => trade.mode === botState.config.mode);
  const startPortfolio = buildPortfolio(botState.readiness, botState.config.mode);
  botState.session = {
    id: `session-${Date.now().toString(36)}`,
    mode: botState.config.mode,
    startedAt: botState._startTime,
    baselineTradeCount: modeTrades.length,
    baselinePnl: modeTrades.reduce((sum, trade) => sum + Number(trade.pnl || 0), 0),
    baselineCash: Number(startPortfolio.cash || botState.config.paperBankroll || 0),
    status: 'running',
  };
  startSessionLedger({
    id: botState.session.id,
    mode: botState.session.mode,
    baselineCash: botState.session.baselineCash,
    baselinePnl: botState.session.baselinePnl,
    baselineTradeCount: botState.session.baselineTradeCount,
    baselineUnrealizedPnl: Number(startPortfolio.unrealizedPnl || 0),
    equity: Number(startPortfolio.equity || startPortfolio.cash || 0),
    note: 'bot start',
  });
  if (botState.session.mode === 'live') {
    markLiveSessionStart(botState.session.baselineCash);
    syncLiveAccount({ botTrades: botState.trades, note: 'live_session_start' }).catch(() => {});
  }
  saveConfigSession({
    configStore: botState.configStore,
    trades: botState.trades,
    label: `${botState.config.mode} session start`,
    source: 'session_start',
  });
  ensureOptimizerTimer();
  ensureGovernorTimer();
  notifyStateChange();
  refreshTelemetry().then((readiness) => {
    if (botState.config.mode === 'live' && !readiness.liveReady) {
      log(`⚠️ LIVE blocked — ${readiness.needs.join(' · ') || 'fund CLOB USDC first'}`, 'error', { readiness });
    }
  });
  const gateNow = evaluateEdgeGate(botState.trades, botState.config);
  log(
    `🚀 Bot started — ${botState.config.mode} · ${gateNow.arbOnly ? 'ARB-ONLY' : 'directional'} · E$${gateNow.expectancy} (${gateNow.n} paper) · ${botState.config.useSignals ? 'signals on' : 'no signals'}`,
    'system',
    { edgeGate: gateNow },
  );
  scan();
  botState.interval = setInterval(scan, POLY_SCAN_INTERVAL_MS);
  // Kick an optimizer pass shortly after start (fast tune)
  setTimeout(() => {
    if (botState.running && botState.config.llmOptimize !== false) {
      optimizeNow({ apply: true, useLlm: true }).catch(() => {});
    }
  }, 12000);
  // Kick a governor pass to set the regime gear early
  setTimeout(() => {
    if (botState.running && botState.config.governorEnabled !== false) {
      governorNow({ useLlm: true }).catch(() => {});
    }
  }, 8000);
  return { ok: true, edgeGate: gateNow };
}

function completeSession(reason = 'stopped') {
  if (!botState.session) return null;
  const mode = botState.session.mode || 'paper';
  const modeTrades = dedupeTrades(botState.trades).filter((trade) => trade.mode === mode);
  const currentPnl = modeTrades.reduce((sum, trade) => sum + Number(trade.pnl || 0), 0);
  const portfolio = buildPortfolio(botState.readiness, mode);
  const sessionCashDelta = botState.session.baselineCash != null
    ? Math.round((Number(portfolio.cash) - Number(botState.session.baselineCash)) * 100) / 100
    : null;
  reconcileSession({
    mode,
    cash: portfolio.cash,
    equity: portfolio.equity,
    realizedPnl: portfolio.realizedPnl,
    unrealizedPnl: portfolio.unrealizedPnl,
    openCost: portfolio.openCostBasis,
    openMark: portfolio.openMarkValue,
    initialBankroll: Number(botState.session.baselineCash ?? portfolio.cash),
    tradesPnlSum: currentPnl,
    sessionCashDelta,
  });
  endSessionLedger(reason, {
    cash: portfolio.cash,
    equity: portfolio.equity,
    realizedPnl: portfolio.realizedPnl,
    unrealizedPnl: portfolio.unrealizedPnl,
    openCount: portfolio.openCount,
    sessionPnl: Math.round((currentPnl - Number(botState.session.baselinePnl || 0)) * 100) / 100,
  });
  if (mode === 'live') {
    markLiveSessionEnd({ cash: portfolio.cash, reason });
    syncLiveAccount({ botTrades: botState.trades, note: 'live_session_end' }).catch(() => {});
  }
  const row = {
    ...botState.session,
    status: 'stopped',
    stopReason: reason,
    endedAt: Date.now(),
    trades: Math.max(0, modeTrades.length - Number(botState.session.baselineTradeCount || 0)),
    pnl: Math.round((currentPnl - Number(botState.session.baselinePnl || 0)) * 100) / 100,
    cashDelta: sessionCashDelta,
  };
  botState.sessionHistory = [row, ...botState.sessionHistory].slice(0, 30);
  botState.session = row;
  return row;
}

export function stopBot(options = {}) {
  const immediate = options?.immediate === true;
  const cancel = options?.cancel === true;
  if (cancel && botState.stopRequest?.status === 'queued') {
    const cancelled = { ...botState.stopRequest, status: 'cancelled', cancelledAt: Date.now() };
    botState.stopRequest = null;
    log('▶️ QUEUED STOP CANCELLED · bot remains active', 'system', cancelled);
    notifyStateChange();
    return { ok: true, running: true, queued: false, cancelled: true };
  }
  if (!botState.running) {
    return { ok: true, running: false, already: true };
  }
  const wall = currentWallWindow(POLY_WINDOW_SECONDS);
  if (!immediate && wall.remainingMs > 5000) {
    botState.stopRequest = {
      id: `stop-${Date.now().toString(36)}`,
      status: 'queued',
      requestedAt: Date.now(),
      executeAt: wall.endAtMs,
      windowKey: wall.key,
      remainingMs: wall.remainingMs,
    };
    log(
      `⏳ STOP QUEUED · bot remains active until window end (${Math.ceil(wall.remainingMs / 1000)}s)`,
      'system',
      botState.stopRequest,
    );
    notifyStateChange();
    return {
      ok: true,
      running: true,
      queued: true,
      stopRequest: botState.stopRequest,
      message: 'Stop queued for window end',
    };
  }
  botState.running = false;
  saveConfig({ enabled: false });
  if (botState.interval) { clearInterval(botState.interval); botState.interval = null; }
  const session = completeSession(options?.reason || (immediate ? 'immediate' : 'stopped'));
  botState.stopRequest = null;
  log(`⏹️ Bot stopped · session ${session?.trades || 0} trades · PnL $${Number(session?.pnl || 0).toFixed(2)}`, 'system');
  notifyStateChange();
  return { ok: true, running: false, session };
}

export function saveCurrentConfigSession({ label = '', source = 'manual' } = {}) {
  const row = saveConfigSession({
    configStore: botState.configStore,
    trades: botState.trades,
    label,
    source,
  });
  notifyStateChange();
  return { ok: true, session: row };
}

export function getConfigSessionsAnalysis() {
  return analyzeConfigSessions(botState.trades);
}

export function restoreConfigSession(id) {
  const row = getConfigSession(id);
  if (!row?.configStore) return { ok: false, error: 'Config session not found' };
  saveConfigSession({
    configStore: botState.configStore,
    trades: botState.trades,
    label: 'Before restore',
    source: 'pre_restore',
  });
  botState.configStore = normalizeConfigStore(row.configStore, flatDefaults());
  syncConfigFromStore();
  saveConfig({});
  log(`↩️ CONFIG RESTORED · ${row.label} · ${row.mode}`, 'system', { configSessionId: id });
  return { ok: true, restored: row, config: botState.config };
}

export function resetPaperData({ initialDeposit = 100 } = {}) {
  const amount = Number(initialDeposit);
  if (!Number.isFinite(amount) || amount < 0) {
    return { ok: false, error: 'Initial paper deposit must be zero or greater' };
  }
  if (botState.running) stopBot({ immediate: true, reason: 'paper_reset' });
  saveConfigSession({
    configStore: botState.configStore,
    trades: botState.trades,
    label: 'Before paper reset',
    source: 'paper_reset_backup',
  });
  const removed = {
    trades: botState.trades.filter((trade) => trade.mode === 'paper').length,
    positions: botState.positions.filter((position) => position.mode === 'paper').length,
    actions: botState.actions.filter((action) => action.mode === 'paper').length,
  };
  botState.trades = botState.trades.filter((trade) => trade.mode !== 'paper');
  botState.positions = botState.positions.filter((position) => position.mode !== 'paper');
  botState.actions = botState.actions.filter((action) => action.mode !== 'paper');
  botState.pendingTrades = botState.pendingTrades.filter((trade) => trade.mode === 'live');
  botState.announcements = botState.announcements.filter((item) => item.mode === 'live');
  botState.session = null;
  botState.sessionHistory = botState.sessionHistory.filter((session) => session.mode !== 'paper');
  botState._cycleSettleAccum = { pnl: 0, closes: 0, rewards: 0, tp: 0, sl: 0, trail: 0, settle: 0, partial: 0 };
  botState.windows = { current: null, history: [] };
  persistSync(FILES.TRADES, botState.trades);
  persistSync(FILES.POSITIONS, botState.positions);
  persistSync(FILES.ACTIONS, botState.actions);
  saveConfig({ mode: 'paper', enabled: false, paperBankroll: amount, paperInitialDeposit: amount });
  refreshKellyHistory();
  log(`♻️ PAPER DATA RESET · $${amount.toFixed(2)} initial · removed ${removed.trades} trades`, 'system', removed);
  notifyStateChange();
  return { ok: true, removed, paperBankroll: amount };
}

/**
 * Wipe phantom / stale live tracker history and re-baseline to current CLOB cash.
 * Does NOT touch paper data or on-chain Polymarket positions.
 */
export function resetLiveData({ baselineUsd = null } = {}) {
  if (botState.running) stopBot({ immediate: true, reason: 'live_reset' });
  saveConfigSession({
    configStore: botState.configStore,
    trades: botState.trades,
    label: 'Before live reset',
    source: 'live_reset_backup',
  });

  const liveTrades = botState.trades.filter((trade) => trade.mode === 'live');
  const livePositions = botState.positions.filter((position) => position.mode === 'live');
  const phantomTrades = liveTrades.filter((t) => !t.orderId);
  const phantomOpen = livePositions.filter((p) => !p.closed && !p.orderId);

  const archiveFile = dataPath('poly_live_archive.json');
  const prev = load(archiveFile, []) || [];
  persistSync(archiveFile, [
    ...prev.slice(-20),
    {
      archivedAt: Date.now(),
      reason: 'live_reset_clean_slate',
      trades: liveTrades,
      positions: livePositions,
      phantomTradeCount: phantomTrades.length,
      phantomOpenCount: phantomOpen.length,
    },
  ]);

  const removed = {
    trades: liveTrades.length,
    positions: livePositions.length,
    actions: botState.actions.filter((action) => action.mode === 'live').length,
    phantomTrades: phantomTrades.length,
    phantomOpen: phantomOpen.length,
  };

  botState.trades = botState.trades.filter((trade) => trade.mode !== 'live');
  botState.positions = botState.positions.filter((position) => position.mode !== 'live');
  botState.actions = botState.actions.filter((action) => action.mode !== 'live');
  botState.pendingTrades = botState.pendingTrades.filter((trade) => trade.mode === 'paper');
  botState.announcements = botState.announcements.filter((item) => item.mode === 'paper');
  botState.session = null;
  botState.sessionHistory = botState.sessionHistory.filter((session) => session.mode !== 'live');
  botState._cycleSettleAccum = { pnl: 0, closes: 0, wins: 0, tp: 0, sl: 0, trail: 0, settle: 0, partial: 0 };
  botState.windows = { current: null, history: [] };

  persistSync(FILES.TRADES, botState.trades);
  persistSync(FILES.POSITIONS, botState.positions);
  persistSync(FILES.ACTIONS, botState.actions);

  const cash = Number(
    baselineUsd
    ?? botState.readiness?.spendableBalance
    ?? botState.readiness?.clobBalance
    ?? loadBaseline()
    ?? 0,
  );
  const baseline = saveBaseline(cash, 'Live account normalized — clean slate');
  saveConfig({ mode: 'live', enabled: false });
  refreshKellyHistory();
  log(
    `♻️ LIVE DATA RESET · baseline $${Number(baseline.balanceUsd).toFixed(2)} · removed ${removed.trades} trades (${removed.phantomTrades} phantom)`,
    'system',
    removed,
  );
  notifyStateChange();
  return { ok: true, removed, baseline };
}

async function executeSell(pos, reason = 'manual') {
  if (!pos || pos.closed) return { ok: false, error: 'Position not found or already closed' };

  const price = pos.currentPrice || pos.entryPrice;
  markPosition(pos, price);

  if (pos.mode === 'live' && pos.tokenId && positionShares(pos) > 0) {
    try {
      const result = await placeMarketSell({
        tokenId: pos.tokenId,
        shares: positionShares(pos),
        negRisk: pos.negRisk,
        tickSize: pos.tickSize,
      });
      pos.orderId = result.id;
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  pos.exitPrice = price;
  pos.closed = true;
  pos.exitReason = reason;
  if (pos.mode === 'paper') {
    const proceeds = Math.round(positionShares(pos) * price * 100) / 100;
    adjustPaperCash(proceeds, `${reason.toUpperCase()} ${pos.symbol} ${pos.outcome?.toUpperCase()}`);
  }
  saveTrade({ ...pos, timestamp: Date.now(), orderId: pos.orderId });
  saveState();
  try { await syncClobBalance(); await refreshTelemetry(); } catch {}

  log(`⚡ RAPID SELL ${pos.symbol} ${pos.outcome?.toUpperCase()} · ${reason} · PnL $${pos.pnl?.toFixed(2)}`, 'sl', {
    market: pos.symbol, slug: pos.slug, outcome: pos.outcome, reason,
    pnl: pos.pnl, shares: positionShares(pos), exitPrice: price,
  });

  return { ok: true, position: pos, pnl: pos.pnl };
}

export async function rapidSell(positionId) {
  const pos = botState.positions.find((p) => p.id === positionId && !p.closed);
  return executeSell(pos, 'rapid');
}

export async function rapidSellAll() {
  const open = botState.positions.filter((p) => !p.closed);
  const results = [];
  for (const pos of open) {
    results.push({ id: pos.id, ...(await executeSell(pos, 'panic')) });
  }
  return { sold: results.filter((r) => r.ok).length, results };
}

export async function rapidSellPmAsset({ assetId, size }) {
  if (!assetId || !size) throw new Error('assetId and size required');
  const result = await placeMarketSell({
    tokenId: assetId,
    shares: Number(size),
    negRisk: false,
    tickSize: '0.01',
  });
  try { await syncClobBalance(); await refreshTelemetry(); } catch {}
  log(`⚡ PM WALLET SELL asset ${String(assetId).slice(0, 12)} · ${size} sh`, 'sl', { assetId, size, orderId: result.id });
  return { ok: true, orderId: result.id };
}

// Model state changes trigger SSE push
onModelChange(() => notifyStateChange());
