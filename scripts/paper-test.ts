#!/usr/bin/env node
// @ts-nocheck
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.cwd());
process.chdir(ROOT);

const { analyze, loadFusionContext, fetchCandles, fetchFunding } = await import(path.join(ROOT, 'src/polymarket/signal.js'));
const { applyAlphaFusion } = await import(path.join(ROOT, 'src/polymarket/alphaFusion.js'));
const {
  computeKellySize,
  computeCertaintyKelly,
  resolveDynamicLimits,
  buildDynamicPlan,
} = await import(path.join(ROOT, 'src/polymarket/kelly.js'));
const { takerFeeUsdc, openCostWithFee, closeProceedsWithFee } = await import(path.join(ROOT, 'src/polymarket/fees.js'));

const DURATIONS = [
  { duration: '5m', windowSec: 300, horizon: 300 },
  { duration: '15m', windowSec: 900, horizon: 900 },
  { duration: '30m', windowSec: 1800, horizon: 1800 },
  { duration: '1h', windowSec: 3600, horizon: 3600 },
];

const ENTRY_LOOKBACK = 61;

await loadFusionContext();
const fusion = globalThis.__zingerFusionCtx || {};

// Binance caps a klines request at 1000. Pulling the cap rather than 260 takes
// the evaluable window from ~3h to ~16h, which matters because a knob sweep over
// 60 windows cannot separate a real edge from noise.
const ONE_MIN_DEPTH = Number(process.env.ZINGER_PAPER_1M_DEPTH || 1000);
const FIVE_MIN_DEPTH = Number(process.env.ZINGER_PAPER_5M_DEPTH || 1000);

// The asset/duration/window loops previously broke at a hardcoded 60 trades.
// Because BTC 5m is iterated first, every run stopped inside it: ETH and the
// 15m/30m/1h durations were never reached, so a "sweep" compared variants on
// one asset and one duration and called it a config. Configurable now, and high
// enough by default that the span is the binding constraint rather than a cap.
const MAX_TRADES = Number(process.env.ZINGER_PAPER_MAX_TRADES || 5000);

const candleCache = {};
async function mkCandles(symbol) {
  if (!candleCache[symbol]) {
    const [one, five] = await Promise.all([
      fetchCandles(symbol, '1m', ONE_MIN_DEPTH),
      fetchCandles(symbol, '5m', FIVE_MIN_DEPTH),
    ]);
    const toSec = (c) => ({ ...c, time: Math.floor(c.time / 1000) });
    candleCache[symbol] = {
      one: (one || []).map(toSec),
      five: (five || []).map(toSec),
    };
  }
  return candleCache[symbol];
}

function candlesUpTo(candles, tSec) {
  return (candles || []).filter((c) => c.time <= tSec);
}

function candlesFromTo(candles, t0Sec, t1Sec) {
  return (candles || []).filter((c) => c.time > t0Sec && c.time <= t1Sec);
}

/** Model up-side implied prob from the underlying move over the window so far. */
function probUpAt(candles, windowStartSec, tSec, dirBias = 0) {
  const path = candlesFromTo(candles, windowStartSec - 1, tSec);
  const o = path[0]?.open ?? candles[0]?.close;
  const c = path[path.length - 1]?.close ?? candles[0]?.close;
  if (!o || !c) return 0.5;
  const mFrac = (c - o) / o;
  let p = 0.5 + mFrac * 12 + dirBias;
  if (!Number.isFinite(p)) p = 0.5;
  return Math.min(0.94, Math.max(0.06, p));
}

function trySizing({ sizeArgs, plan, cfg, entry, bankroll, mode = 'paper' }) {
  const limits = resolveDynamicLimits(cfg, bankroll);
  const { minUsd, maxUsd } = limits;
  const cashFrac = Math.min(0.95, Math.max(0.01, Number(cfg.maxPositionPct ?? 0.1)));
  const hardCap = Math.min(maxUsd, Math.max(0, bankroll * cashFrac));
  if (hardCap < minUsd) return null;

  const kelly = computeKellySize({
    bankroll: limits.spendable || bankroll,
    signalConfidence: sizeArgs.confidence,
    minUsd,
    maxUsd: hardCap,
    kellyFraction: Number(cfg.kellyFraction ?? 0.5),
    maxPositionPct: cashFrac,
    historicalWinRate: sizeArgs.historicalWinRate,
    tradeCount: sizeArgs.tradeCount,
    realizedVol: sizeArgs.realizedVol,
    calmBaseline: sizeArgs.calmBaseline,
  });

  let sizeUsd = kelly?.sizeUsd ?? 0;
  if (sizeArgs.remaining != null && plan?.holdToSettle === false) {
    const certMaxPct = Number(cfg.certaintyMaxPct ?? 0.35);
    const certCap = Math.min(Math.max(maxUsd, bankroll * certMaxPct), Number(cfg.certaintyMaxUsd ?? 40), bankroll * cashFrac);
    const certainty = computeCertaintyKelly({
      price: entry,
      confidence: sizeArgs.confidence,
      remaining: sizeArgs.remaining,
      windowSec: sizeArgs.windowSec,
      bankroll: limits.spendable || bankroll,
      kellyFraction: Number(cfg.kellyFraction ?? 0.5),
      minUsd,
      maxUsd: certCap,
      maxPct: certMaxPct,
      realizedVol: sizeArgs.realizedVol,
      calmBaseline: sizeArgs.calmBaseline,
    });
    if (certainty && certainty.sizeUsd > sizeUsd) sizeUsd = Math.min(certainty.sizeUsd, certCap);
  }

  if (!sizeUsd || sizeUsd <= 0) {
    const conf = Math.min(0.65, Number(sizeArgs.confidence || 0.35));
    sizeUsd = Math.round(Math.max(minUsd, Math.min(hardCap, 1.2 + conf * 2.5)) * 100) / 100;
  }
  return { sizeUsd, kelly, limits };
}

function simulateTrade({ cfg, entry, entryPrice, outcome, shares, windowSec, candles, entryT, settleProbAtExit }) {
  const entryCost = openCostWithFee(shares, entryPrice, cfg.feeCategory || 'crypto').total;
  const tpPct = Number(planShallow.tpPct ?? 20);
  const T = Math.min(entryT + windowSec, candles[candles.length - 1]?.time || entryT + windowSec);
  const steps = candlesFromTo(candles, entryT - 0.5, entryT + windowSec);

  let exitPrice = null, exitReason = null;
  for (const c of steps) {
    if (planRisk.holdToSettle) break;
    const prob = outcome === 'up' ? probUpAt(candles, entryT, c.time) : 1 - probUpAt(candles, entryT, c.time);
    if (prob >= entryPrice * (1 + tpPct / 100)) { exitPrice = prob; exitReason = 'tp'; break; }
    if (prob <= entryPrice * (1 - planRisk.slPct / 100) && planRisk.slPct < 42) { exitPrice = prob; exitReason = 'sl'; break; }
  }
  if (exitReason === 'tp') {
    const proceeds = closeProceedsWithFee(shares, exitPrice, cfg.feeCategory || 'crypto', 'clob_sell');
    return { exitReason, exitPrice, gross: proceeds.net - entryCost, fee: entryCost - shares * entryPrice + proceeds.premium - proceeds.net };
  }

  // settle at window end: up wins if close > open
  const path = candlesFromTo(candles, entryT - 1, T);
  const o = path[0]?.open ?? null;
  const c = path[path.length - 1]?.close ?? null;
  if (o == null || c == null) return { exitReason: 'orphan', exitPrice: entryPrice, gross: 0, fee: 0 };
  const upWon = c >= o;
  const won = (outcome === 'up') === upWon;
  let gross;
  if (won) {
    const payout = shares * 1;
    gross = Math.round((payout - entryCost) * 100) / 100;
  } else {
    gross = Math.round(-entryCost * 100) / 100;
  }
  return { exitReason: won ? 'settle_win' : 'settle_loss', exitPrice: won ? 1 : 0, gross, fee: Math.round((entryCost - shares * entryPrice) * 100) / 100 };
}

let planShallow = { tpPct: 20 };
let planRisk = { slPct: 12, holdToSettle: false };

async function runSession(cfg, opts = {}) {
  const bankroll0 = Number(cfg.paperBankroll ?? 15);
  const trades = [];
  let cash = bankroll0;
  const t0 = opts.startSec;
  const t1 = opts.endSec;
  const dbg = { windows: 0, bodyShort: 0, noSig: 0, neutral: 0, lowConf: 0, noUnderlying: 0, priceBand: 0, sizing: 0, noCash: 0, badShares: 0, traded: 0 };

  const durations = (cfg.enabledDurations || ['5m', '15m', '30m', '1h'])
    .map((d) => DURATIONS.find((x) => x.duration === String(d).toLowerCase()))
    .filter(Boolean);

  for (const asset of (cfg.enabledAssets || ['BTC', 'ETH'])) {
    const symbol = asset === 'BTC' ? 'BTCUSDT' : 'ETHUSDT';
    const { one, five } = candleCache[symbol] || {};
    if (!one || !five) continue;

    for (const dur of durations) {
      const { windowSec, horizon } = dur;
      for (let ws = t0; ws <= t1 - 20; ws += windowSec) {
        dbg.windows++;
const entryT = Math.min(ws + Math.round(windowSec * 0.35), t1 - 10);
      const body = candlesUpTo(one, entryT);
      if (body.length < 55) { dbg.bodyShort++; continue; }

        const funding = await fetchFunding(symbol).catch(() => null);
        let base = analyze(body, { funding });
        if (!base) { dbg.noSig++; continue; }
        const isEth = asset === 'ETH';
        const ctx = {
          ...(fusion[isEth ? 'eth' : 'btc'] || {}),
          isEth,
          leadMom1: opts.btcLeadM1 ?? null,
        };
        const sig = applyAlphaFusion(base, ctx);
        const dir = sig?.direction;
        if (dir !== 'up' && dir !== 'down') { dbg.neutral++; continue; }
        const conf = Number(sig?.confidence ?? 0);
        if (conf < Number(cfg.minConfidence ?? 0.35)) { dbg.lowConf++; continue; }

        const underlying = five[0]?.close ?? body[body.length - 1]?.close;
        if (!underlying) { dbg.noUnderlying++; continue; }
        const outcome = dir === 'up' ? 'up' : 'down';
        const rawProb = probUpAt(one, ws, entryT, dir === 'up' ? 0.03 : -0.03);
        const entryPrice = outcome === 'up' ? rawProb : 1 - rawProb;
        const minP = Number(cfg.minPrice ?? 0.42);
        const maxP = Number(cfg.maxPrice ?? 0.68);
        if (entryPrice < minP || entryPrice > maxP) { dbg.priceBand++; continue; }

        const remaining = Math.max(5, ws + windowSec - entryT);
        const plan = buildDynamicPlan({ cfg, price: entryPrice, analysis: sig, signal: sig });
        planShallow = plan; planRisk = plan;

        const sizing = trySizing({
          sizeArgs: { confidence: conf, remaining, windowSec, realizedVol: base?.volatility?.atrPct, calmBaseline: 0.2 },
          plan, cfg, entry: entryPrice, bankroll: cash,
        });
        if (!sizing || sizing.sizeUsd <= 0) { dbg.sizing++; continue; }
        if (cash - sizing.sizeUsd < 0.85 && cash < sizing.sizeUsd) { dbg.noCash++; continue; }

        const shares = Math.round((sizing.sizeUsd / entryPrice) * 1000) / 1000;
        if (shares <= 0 || !Number.isFinite(shares)) { dbg.badShares++; continue; }

        const res = simulateTrade({
          cfg, entryT, entryPrice, outcome, shares, windowSec,
          candles: one, settleProbAtExit: null,
        });

        cash = Math.round((cash + res.gross - 0) * 100) / 100;
        const trade = {
          asset, duration: dur.duration, outcome, ts: entryT,
          entryPrice: Math.round(entryPrice * 1000) / 1000,
          sizeUsd: Math.round(sizing.sizeUsd * 100) / 100,
          shares, confidence: conf, direction: dir,
          exit: res.exitReason, gross: res.gross, fee: res.fee,
          score: base?.score, method: sizing.kelly?.method || 'probe',
        };
        trades.push(trade);
        dbg.traded++;
        if (trades.length >= MAX_TRADES) break;
      }
      if (trades.length >= MAX_TRADES) break;
    }
    if (trades.length >= MAX_TRADES) break;
  }

  return { trades, cash, bankroll0, dbg };
}

const OUTPUT = path.join(ROOT, 'data', 'paper-test-results.json');

async function main() {
  const args = process.argv.slice(2);
  const cfgIdx = args.indexOf('--cfg');
  const cfgJson = cfgIdx >= 0 ? args[cfgIdx + 1] : null;
  const sweep = args.includes('--sweep');
  const assetArg = args.find((a) => a.startsWith('--assets='))?.split('=')[1];
  const assets = assetArg ? assetArg.split(',').filter(Boolean) : ['BTC', 'ETH'];
  const durArg = args.find((a) => a.startsWith('--durations='))?.split('=')[1];
  const durations = durArg ? durArg.split(',').filter(Boolean) : ['5m', '15m', '30m', '1h'];
  const spanArg = args.find((a) => a.startsWith('--span='))?.split('=')[1];
  const spanSec = Number(spanArg ?? 3600);

  const [btc1, eth1] = await Promise.all([mkCandles('BTCUSDT'), mkCandles('ETHUSDT')]);
  const lastTs = Math.max(
    ...[btc1, eth1].flatMap(({ one }) => (one && one.length ? [one[one.length - 1].time] : [])),
  );
  const t1 = lastTs;
  const t0 = t1 - spanSec;

  const baseCfg = cfgJson ? JSON.parse(cfgJson) : {
    mode: 'paper',
    paperBankroll: 15,
    minConfidence: 0.42,
    minPrice: 0.42,
    maxPrice: 0.68,
    enabledAssets: assets,
    enabledDurations: durations,
    kellyFraction: 0.5,
    maxPositionPct: 0.10,
    maxPositionSize: 8,
    minPositionSize: 1,
    useKellySizing: true,
    adaptiveSl: true,
    minAdaptiveSlPct: 8,
    tpPctLow: 18,
    tpPctHigh: 36,
    feeCategory: 'crypto',
    underdogMaxPrice: 0.42,
    favoriteMinPrice: 0.55,
    holdToSettleUnderdogs: true,
  };

  const run = async (cfg) => {
    const out = await runSession(cfg, { startSec: t0, endSec: t1 });
    const winners = out.trades.filter((t) => t.gross > 0).length;
    const losers = out.trades.filter((t) => t.gross < 0).length;
    const flat = out.trades.filter((t) => t.gross === 0).length;
    const grossPnl = out.trades.reduce((s, t) => s + t.gross, 0);
    const fees = out.trades.reduce((s, t) => s + (t.fee || 0), 0);
    const avgWin = winners ? out.trades.filter((t) => t.gross > 0).reduce((s, t) => s + t.gross, 0) / winners : 0;
    const avgLoss = losers ? out.trades.filter((t) => t.gross < 0).reduce((s, t) => s + t.gross, 0) / losers : 0;
    return {
      cfg,
      trades: out.trades,
      pnl: Math.round(grossPnl * 100) / 100,
      fees: Math.round(fees * 100) / 100,
      net: Math.round((grossPnl - fees) * 100) / 100,
      endCash: Math.round(out.cash * 100) / 100,
      winners, losers, flat,
      winRate: out.trades.length ? Math.round((winners / out.trades.length) * 10000) / 100 : 0,
      avgWin: Math.round(avgWin * 100) / 100,
      avgLoss: Math.round(avgLoss * 100) / 100,
      tradeCount: out.trades.length,
      dbg: out.dbg,
    };
  };

  let results;
  if (sweep) {
    const sweeps = [];
    const futures = [];
    const makeCfg = (patch) => JSON.parse(JSON.stringify({ ...baseCfg, ...patch }));
    const variants = [
      { label: 'base', patch: {} },
      { label: 'conf055', patch: { minConfidence: 0.55 } },
      { label: 'conf062', patch: { minConfidence: 0.62 } },
      { label: 'kelly03', patch: { kellyFraction: 0.3 } },
      { label: 'kelly07', patch: { kellyFraction: 0.7 } },
      { label: 'pos07', patch: { maxPositionPct: 0.07, maxPositionSize: 6 } },
      { label: 'pos15', patch: { maxPositionPct: 0.15, maxPositionSize: 10 } },
      { label: 'tight_tp', patch: { tpPctLow: 12, tpPctHigh: 22 } },
      { label: 'loose_tp', patch: { tpPctLow: 24, tpPctHigh: 42 } },
      { label: 'band43_60', patch: { minPrice: 0.43, maxPrice: 0.60 } },
      { label: 'band40_72', patch: { minPrice: 0.40, maxPrice: 0.72 } },
      { label: '5m_only', patch: { enabledAssets: assets, enabledDurations: ['5m', '15m'] } },
      { label: 'cf_crit', patch: { certaintyMaxPct: 0.5, certaintyMaxUsd: 12 } },
      { label: 'no_cert', patch: { certaintySizing: false } },
    ];
    for (const v of variants) {
      futures.push(Promise.resolve().then(() => run(makeCfg(v.patch))).then((r) => ({ ...v, ...r })));
    }
    sweeps.push(...await Promise.all(futures));
    sweeps.sort((a, b) => (b.net - b.fees) - (a.net - a.fees));
    results = { window: { t0, t1, spanSec }, config: baseCfg, sweeps };
  } else {
    results = { window: { t0, t1, spanSec }, config: baseCfg, run: await run(baseCfg) };
  }

  writeFileSync(OUTPUT, JSON.stringify(results, null, 2));
  console.log(`wrote ${OUTPUT}`);
  if (results.run) {
    const r = results.run;
    console.log(`trades=${r.tradeCount} net=$${r.net} winrate=${r.winRate}% (${r.winners}W/${r.losers}L/${r.flat}F) avgWin=$${r.avgWin} avgLoss=$${r.avgLoss}`);
    console.log('dbg', JSON.stringify(r.dbg));
  } else if (results.sweeps) {
    console.log(`\n${'label'.padEnd(12)} trades  pnl     net      wr%    avgW   avgL   method`);
    for (const s of results.sweeps) {
      const m = new Set(s.trades.map((t) => t.method)).size;
      console.log(`${s.label.padEnd(12)} ${String(s.tradeCount).padEnd(6)} ${s.pnl.toFixed(2).padStart(7)} ${s.net.toFixed(2).padStart(7)} ${String(s.winRate).padStart(5)} ${s.avgWin.toFixed(2).padStart(6)} ${s.avgLoss.toFixed(2).padStart(6)} ${m}`);
    }
    const best = results.sweeps[0];
    console.log(`\nBEST: ${best.label} — ${best.tradeCount} trades, net $${best.net}, win ${best.winRate}% on $${best.cfg.paperBankroll}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });