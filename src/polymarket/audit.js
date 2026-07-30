import fs from 'fs';
import path from 'path';

const BASELINE_FILE = path.resolve(import.meta.dirname, '../../data/poly_baseline.json');

export function loadBaseline() {
  try {
    const data = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf-8'));
    return Number(data.balanceUsd) || null;
  } catch {
    return null;
  }
}

export function saveBaseline(balanceUsd, note = '') {
  const payload = { balanceUsd: Number(balanceUsd), setAt: Date.now(), note };
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(payload, null, 2));
  return payload;
}

export function tradeCostBasis(trade) {
  const shares = trade.shares > 0
    ? trade.shares
    : (trade.entryPrice > 0 && trade.size > 0 ? trade.size / trade.entryPrice : 0);
  return Math.round(shares * (trade.entryPrice || 0) * 100) / 100;
}

export function tradeRealizedPnl(trade) {
  if (trade.exitPrice == null || !trade.entryPrice) return trade.pnl ?? 0;
  const shares = trade.shares > 0
    ? trade.shares
    : (trade.size > 0 ? trade.size / trade.entryPrice : 0);
  if (!shares) return trade.pnl ?? 0;
  return Math.round((trade.exitPrice - trade.entryPrice) * shares * 100) / 100;
}

export function normalizeTrade(trade) {
  const cost = tradeCostBasis(trade);
  const pnl = tradeRealizedPnl(trade);
  // Live is only verified when CLOB returned a real orderId (phantom fills had none).
  const verified = trade.mode === 'paper' ? false : !!trade.orderId;
  return { ...trade, costBasis: cost, pnl, verified };
}

export function dedupeTrades(trades) {
  const seen = new Map();
  for (const t of trades) {
    const normalized = normalizeTrade(t);
    const key = normalized.id
      || `${normalized.mode}:${normalized.slug}:${normalized.outcome}:${normalized.exitReason || '?'}:${normalized.timestamp || normalized.entryTime || 0}`;
    if (!seen.has(key)) seen.set(key, normalized);
  }
  return [...seen.values()];
}

export function computeTradeStats(trades) {
  const list = trades.map(normalizeTrade);
  const wins = list.filter((x) => x.pnl > 0).length;
  const losses = list.filter((x) => x.pnl <= 0).length;
  const totalPnl = list.reduce((s, x) => s + x.pnl, 0);
  const verified = list.filter((x) => x.verified);
  const verifiedPnl = verified.reduce((s, x) => s + x.pnl, 0);
  return {
    totalTrades: list.length,
    verifiedTrades: verified.length,
    wins,
    losses,
    totalPnl: Math.round(totalPnl * 100) / 100,
    verifiedPnl: Math.round(verifiedPnl * 100) / 100,
    winRate: list.length ? ((wins / list.length) * 100).toFixed(1) : '0',
    bestTrade: list.length ? Math.round(Math.max(...list.map((x) => x.pnl)) * 100) / 100 : 0,
    worstTrade: list.length ? Math.round(Math.min(...list.map((x) => x.pnl)) * 100) / 100 : 0,
  };
}

export function runAudit({
  readiness,
  trades,
  botPositions,
  cash,
  baselineUsd,
  mode = 'paper',
  portfolio = null,
  liveAccount = null,
}) {
  const issues = [];
  const notes = [];
  const deduped = dedupeTrades(trades || []);
  const live = deduped.filter((t) => t.mode === 'live');
  const paper = deduped.filter((t) => t.mode === 'paper');
  const liveStats = computeTradeStats(live);
  const paperStats = computeTradeStats(paper);
  const isPaper = mode === 'paper';

  const pmPositions = readiness?.positions || [];
  const openBot = (botPositions || []).filter((p) => !p.closed && (!p.mode || p.mode === mode));
  const unverifiedLive = live.filter((t) => !t.orderId);

  if (!isPaper && unverifiedLive.length) {
    // Informational — phantom fills used to block buys; PM closed-book is ground truth now
    notes.push(`${unverifiedLive.length} live trade(s) missing orderId — prefer Polymarket closed-book PnL`);
  }
  // Paper positions are virtual — never compare to CLOB wallet
  if (!isPaper && openBot.length && pmPositions.length === 0) {
    issues.push(`${openBot.length} bot-tracked open position(s) not on Polymarket wallet`);
  }
  if (!isPaper && openBot.length > pmPositions.length + 1) {
    issues.push('Bot position count exceeds wallet — stale tracker entries');
  }

  const baseline = baselineUsd ?? loadBaseline();
  const cashPnl = baseline != null ? Math.round((cash - baseline) * 100) / 100 : null;
  const botPnl = liveStats.verifiedPnl;
  const pmRealized = liveAccount?.totals?.pmRealizedSum != null
    ? Math.round(Number(liveAccount.totals.pmRealizedSum) * 100) / 100
    : null;
  const lifetimeBaseline = liveAccount?.cash?.lifetimeBaseline != null
    ? Number(liveAccount.cash.lifetimeBaseline)
    : null;
  const clobCash = liveAccount?.cash?.clob != null ? Number(liveAccount.cash.clob) : Number(cash);

  // Live: Polymarket closed-book + CLOB cash are ground truth. Bot fill marks may diverge
  // historically (failed sells / phantoms) — never fail the ledger on that, and only note
  // actionable cash/identity problems (not expected bot↔PM book drift).
  if (!isPaper && Number.isFinite(clobCash) && Math.abs(Number(cash) - clobCash) > 1.5) {
    issues.push(
      `Portfolio cash $${Number(cash).toFixed(2)} ≠ CLOB $${clobCash.toFixed(2)} — sync live account`,
    );
  }
  // Soft warning if baseline is wildly stale vs current CLOB (deposit/withdraw without rebase)
  if (!isPaper && baseline != null && lifetimeBaseline != null && Math.abs(baseline - lifetimeBaseline) > 5) {
    notes.push(
      `Baseline $${Number(baseline).toFixed(2)} vs live lifetime $${lifetimeBaseline.toFixed(2)} — rebase baseline after deposits`,
    );
  }

  // Paper ledger: equity ≡ cash + open marks; net ≡ equity − initial (by construction).
  // Hard-fail only when cash/equity identity breaks. Fill-book R+U may drift from fees /
  // redeposits — equity path is canonical; do not surface that drift as an audit note.
  if (isPaper && portfolio) {
    const openMark = Number(portfolio.openMarkValue ?? 0);
    const eq = Number(portfolio.equity ?? 0);
    const paperCash = Number(portfolio.cash ?? cash ?? 0);
    const identity = paperCash + openMark;
    if (Math.abs(eq - identity) > 1.0) {
      issues.push(
        `Paper equity $${eq.toFixed(2)} ≠ cash+marks $${identity.toFixed(2)} — ledger identity break`,
      );
    }
  }

  const pnlSource = isPaper
    ? 'paper'
    : pmRealized != null
      ? 'polymarket_closed'
      : 'cash';

  return {
    ok: issues.length === 0,
    issues,
    notes,
    mode,
    baselineUsd: baseline,
    cashPnl: isPaper ? (portfolio?.netPnl ?? null) : cashPnl,
    botPnlVerified: liveStats.verifiedPnl,
    botPnlAll: liveStats.totalPnl,
    pmRealizedSum: pmRealized,
    paperPnl: paperStats.totalPnl,
    pnlSource,
    live: liveStats,
    paper: paperStats,
    wallet: {
      cash: Math.round(Number(cash) * 100) / 100,
      clobCash: Math.round(clobCash * 100) / 100,
      pmPositions: pmPositions.length,
      pmUnrealized: Math.round(pmPositions.reduce((s, p) => s + Number(p.cashPnl || 0), 0) * 100) / 100,
      botOpen: openBot.length,
      clobBalance: readiness?.clobBalance ?? null,
      liveReady: readiness?.liveReady ?? false,
    },
    checks: [
      { id: 'clob', ok: isPaper || (readiness?.clobBalance ?? 0) >= 0, detail: isPaper ? 'Paper mode' : `CLOB $${(readiness?.clobBalance ?? 0).toFixed(2)}` },
      { id: 'api', ok: isPaper || !!readiness?.apiReady, detail: readiness?.apiReady ? 'API ok' : (isPaper ? 'n/a paper' : 'API missing') },
      { id: 'owner', ok: readiness?.ownerMatches !== false, detail: readiness?.ownerMatches === false ? 'Owner mismatch' : 'Owner ok' },
      {
        id: 'pnl_books',
        ok: issues.every((i) => !i.includes('ledger') && !i.includes('Paper cash')),
        detail: isPaper
          ? `Net $${Number(portfolio?.netPnl || 0).toFixed(2)}`
          : pmRealized != null
            ? `PM closed $${pmRealized}`
            : (cashPnl != null ? `Net vs baseline: $${cashPnl}` : 'Set baseline'),
      },
      {
        id: 'trades',
        ok: true,
        detail: isPaper
          ? `${paperStats.totalTrades} paper trades`
          : `${liveStats.verifiedTrades}/${liveStats.totalTrades} live verified` +
            (pmRealized != null ? ` · PM $${pmRealized}` : ''),
      },
    ],
  };
}
