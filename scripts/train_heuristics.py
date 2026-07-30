#!/usr/bin/env python3
"""
Bayesian heuristics trainer — learns optimal trading parameters from closed trade samples.

Reads:  data/trade_samples.json
Writes: data/heuristics_optimized.json

For each stratum (duration × confidence × price × asset), computes:
- Optimal Kelly fraction via Bayesian Beta-Bernoulli model of win rate
- Optimal TP/SL via empirical distribution of PnL per exit reason
- Optimal position sizing via maximum expectancy
- Regime classification using rolling ADX/volatility

Run manually:
  python3 scripts/train_heuristics.py

Or auto-triggered by tradeCollector.js after every 5 new trades.
"""

import json
import os
import sys
import math
from pathlib import Path
from collections import defaultdict

import numpy as np
from scipy import stats as sp_stats

DATA_DIR = Path(__file__).resolve().parent.parent / 'data'
SAMPLES_FILE = DATA_DIR / 'trade_samples.json'
OUTPUT_FILE = DATA_DIR / 'heuristics_optimized.json'
FUND_FILE = DATA_DIR / 'fund_heuristics.json'

# Beta-Bernoulli prior (weakly informative: 2 wins, 2 losses)
PRIOR_ALPHA = 2.0
PRIOR_BETA = 2.0

def load_samples():
    if not SAMPLES_FILE.exists():
        return []
    with open(SAMPLES_FILE) as f:
        samples = json.load(f)
    return samples

def duration_label(dur):
    d = str(dur or '5m').lower()
    if d == '60m': return '1h'
    if d in ('5m', '15m', '30m', '1h'): return d
    return '5m'

def conf_bucket(c):
    x = float(c) if c is not None else 0
    if x < 0.35: return 'low'
    if x < 0.5: return 'mid'
    if x < 0.65: return 'high'
    return 'vhigh'

def price_band(p):
    x = float(p) if p is not None else 0.5
    if x < 0.35: return 'dog'
    if x < 0.45: return 'cheap'
    if x < 0.55: return 'mid'
    if x < 0.68: return 'sweet'
    return 'fav'

def stratum_key(row):
    return f"{row['duration']}|{row['confBucket']}|{row['priceBand']}|{row['asset']}"

def beta_mean(alpha, beta):
    return alpha / (alpha + beta) if (alpha + beta) > 0 else 0.5

def beta_std(alpha, beta):
    s = alpha + beta
    if s <= 0: return 0.5
    return math.sqrt((alpha * beta) / (s * s * (s + 1)))

def optimal_kelly(wr, avg_win, avg_loss):
    """Full Kelly: f* = (p * b - q) / b where b = avg_win/avg_loss"""
    if avg_loss <= 0 or avg_win <= 0:
        return 0.1
    b = avg_win / avg_loss
    if b <= 0:
        return 0.1
    k = (wr * b - (1 - wr)) / b
    return max(0.02, min(0.5, k))

def optimal_tp_sl(pnls, exit_reasons, entry_prices):
    """Learn optimal TP/SL from empirical distributions."""
    if len(pnls) < 3:
        return None

    pnl_arr = np.array(pnls)
    entry_arr = np.array(entry_prices)
    reasons = [str(r or '') for r in exit_reasons]

    tp_entries = entry_arr[np.array([r == 'take_profit' for r in reasons])]
    sl_entries = entry_arr[np.array([r == 'stop_loss' for r in reasons])]
    settle_entries = entry_arr[np.array([r == 'window_close' or r == 'settle' for r in reasons])]

    # Mean return for each exit type
    tp_returns = []
    for i, r in enumerate(reasons):
        if r == 'take_profit' and entry_prices[i] > 0:
            tp_returns.append((pnls[i] / entry_prices[i]) / (1 - entry_prices[i]))

    sl_returns = []
    for i, r in enumerate(reasons):
        if r == 'stop_loss' and entry_prices[i] > 0:
            sl_returns.append(abs(pnls[i]) / entry_prices[i])

    result = {}

    # TP: use median of observed TP % returns
    if tp_returns:
        result['tpPctLow'] = max(8, min(40, round(np.percentile(tp_returns, 25) * 100, 1)))
        result['tpPctHigh'] = max(12, min(55, round(np.percentile(tp_returns, 75) * 100, 1)))
    else:
        result['tpPctLow'] = 16
        result['tpPctHigh'] = 36

    # SL: use median of observed SL % drawdowns
    if sl_returns:
        result['slPct'] = max(8, min(25, round(np.percentile(sl_returns, 50) * 100, 1)))
    else:
        result['slPct'] = 14

    return result

def compute_stratum_stats(rows):
    """Compute full Bayesian posterior for a stratum."""
    n = len(rows)
    if n < 2:
        return None

    pnls = np.array([float(r.get('pnl', 0)) for r in rows])
    wins = int(np.sum(pnls > 0))
    losses = n - wins
    total_pnl = float(np.sum(pnls))

    # Bayesian win rate posterior: Beta(alpha + wins, beta + losses)
    alpha_post = PRIOR_ALPHA + wins
    beta_post = PRIOR_BETA + losses
    wr_posterior = beta_mean(alpha_post, beta_post)
    wr_uncertainty = beta_std(alpha_post, beta_post)

    # Expectancy
    avg_win = float(np.mean(pnls[pnls > 0])) if wins > 0 else 0
    avg_loss = float(np.mean(abs(pnls[pnls <= 0]))) if losses > 0 else 0
    expectancy = wr_posterior * avg_win - (1 - wr_posterior) * avg_loss

    # Optimal Kelly
    kelly_raw = optimal_kelly(wr_posterior, avg_win, avg_loss)

    # Conservative Kelly (half-Kelly for safety)
    kelly_fraction = round(min(kelly_raw * 0.5, 0.35), 3)

    # Optimal position size: fraction of bankroll to maximize expectancy
    max_pos_pct = round(
        max(0.04, min(0.25, 0.06 + max(0, expectancy) * 0.02)),
        3
    )

    # Min confidence: lower when win rate is high, higher when uncertain
    min_conf = round(
        0.30 if wr_posterior >= 0.55 else
        0.35 if wr_posterior >= 0.45 else
        0.40 if wr_posterior >= 0.35 else
        0.45,
        2
    )

    # TP/SL from empirical distribution
    tp_sl = optimal_tp_sl(
        [r.get('pnl', 0) for r in rows],
        [r.get('exitReason') for r in rows],
        [r.get('entryPrice', 0) for r in rows]
    )

    result = {
        'n': n,
        'wins': wins,
        'losses': losses,
        'wr': round(wr_posterior, 3),
        'wrUncertainty': round(wr_uncertainty, 3),
        'avgWin': round(avg_win, 2),
        'avgLoss': round(avg_loss, 2),
        'totalPnl': round(total_pnl, 2),
        'expectancy': round(expectancy, 4),
        'kellyFraction': kelly_fraction,
        'maxPositionPct': max_pos_pct,
        'minConfidence': min_conf,
        'suggested': (
            'scale_up' if expectancy > 0.3 else
            'aggressive' if expectancy > 0.1 else
            'base' if expectancy > 0 else
            'defensive' if expectancy > -0.05 else
            'pause'
        ),
    }

    if tp_sl:
        result.update(tp_sl)

    return result

def compute_duration_policy(rows, dur):
    """Compute aggregated duration-level policy."""
    n = len(rows)
    if n == 0:
        return None

    stats = compute_stratum_stats(rows)
    if not stats:
        return None

    # Duration-specific entry windows
    entry_windows = {
        '5m': {'maxEntryRemainingSec': 270, 'minRemainingSec': 25, 'tpPctLow': 18, 'tpPctHigh': 40, 'slPct': 14},
        '15m': {'maxEntryRemainingSec': 800, 'minRemainingSec': 60, 'tpPctLow': 14, 'tpPctHigh': 36, 'slPct': 16},
        '30m': {'maxEntryRemainingSec': 1600, 'minRemainingSec': 120, 'tpPctLow': 12, 'tpPctHigh': 30, 'slPct': 18},
        '1h': {'maxEntryRemainingSec': 3200, 'minRemainingSec': 180, 'tpPctLow': 12, 'tpPctHigh': 28, 'slPct': 18},
    }
    ew = entry_windows.get(dur, entry_windows['5m'])

    return {
        **stats,
        **ew,
        'tpPctLow': stats.get('tpPctLow', entry_windows[dur]['tpPctLow'] if dur in ('5m', '15m') else 12),
        'tpPctHigh': stats.get('tpPctHigh', 40 if dur == '5m' else 36 if dur == '15m' else 30),
        'slPct': stats.get('slPct', 14 if dur == '5m' else 16 if dur == '15m' else 18),
    }

def classify_regime(rows):
    """Classify current market regime from recent trade outcomes."""
    if len(rows) < 5:
        return {'label': 'cold_start', 'profile': 'scalp', 'confidence': 0}

    recent = rows[-min(50, len(rows)):]
    pnls = np.array([float(r.get('pnl', 0)) for r in recent])
    wr = np.mean(pnls > 0) if len(pnls) > 0 else 0.5
    avg_abs_pnl = np.mean(np.abs(pnls)) if len(pnls) > 0 else 0
    consecutive_losses = 0
    max_consecutive = 0
    for p in pnls:
        if p <= 0:
            consecutive_losses += 1
            max_consecutive = max(max_consecutive, consecutive_losses)
        else:
            consecutive_losses = 0

    exit_reasons = [str(r.get('exitReason', '')) for r in recent]
    sl_share = exit_reasons.count('stop_loss') / max(1, len(exit_reasons))
    tp_share = exit_reasons.count('take_profit') / max(1, len(exit_reasons))

    # Regime classification
    if sl_share > 0.4 or max_consecutive >= 5:
        return {
            'label': 'high_loss',
            'profile': 'arb_only',
            'confidence': round(min(1.0, sl_share + 0.2), 2),
            'slShare': round(sl_share, 3),
            'maxConsecutiveLosses': max_consecutive,
        }
    elif wr >= 0.55 and tp_share > 0.35:
        return {
            'label': 'trending',
            'profile': 'trend_ride',
            'confidence': round(wr, 2),
            'tpShare': round(tp_share, 3),
        }
    elif avg_abs_pnl > 0 and avg_abs_pnl < 0.5:
        return {
            'label': 'choppy',
            'profile': 'scalp',
            'confidence': round(0.5 + wr * 0.3, 2),
        }
    else:
        return {
            'label': 'neutral',
            'profile': 'scalp',
            'confidence': round(0.5, 2),
        }

def compute_exit_mix(rows):
    """Compute exit reason distribution."""
    reasons = [str(r.get('exitReason', 'unknown')) for r in rows]
    total = max(1, len(reasons))
    mix = defaultdict(int)
    for r in reasons:
        mix[r] += 1
    return {k: round(v / total, 3) for k, v in sorted(mix.items(), key=lambda x: -x[1])}

def main():
    samples = load_samples()
    if not samples:
        print('No trade samples found.')
        return

    # Group by stratum
    by_stratum = defaultdict(list)
    for s in samples:
        s['duration'] = duration_label(s.get('duration', '5m'))
        s['confBucket'] = conf_bucket(s.get('confidence'))
        s['priceBand'] = price_band(s.get('entryPrice'))
        s['asset'] = str(s.get('asset', 'BTC')).upper()
        by_stratum[stratum_key(s)].append(s)

    # Compute per-stratum stats
    strata = {}
    for key, rows in by_stratum.items():
        if len(rows) < 2:
            continue
        stats = compute_stratum_stats(rows)
        if stats:
            strata[key] = stats

    # Group by duration
    by_duration = defaultdict(list)
    for s in samples:
        by_duration[s['duration']].append(s)

    duration_policies = {}
    for dur in ['5m', '15m', '30m', '1h']:
        rows = by_duration.get(dur, [])
        pol = compute_duration_policy(rows, dur)
        if pol:
            duration_policies[dur] = pol
        else:
            # Priors for untouched durations
            duration_policies[dur] = {
                'n': 0,
                'maxEntryRemainingSec': 270 if dur == '5m' else 800 if dur == '15m' else 1600 if dur == '30m' else 3200,
                'minRemainingSec': 25 if dur == '5m' else 60 if dur == '15m' else 120 if dur == '30m' else 180,
                'tpPctLow': 18 if dur == '5m' else 14 if dur == '15m' else 12,
                'tpPctHigh': 40 if dur == '5m' else 36 if dur == '15m' else 30,
                'slPct': 14 if dur == '5m' else 16 if dur == '15m' else 18,
                'kellyFraction': 0.10 if dur == '5m' else 0.09 if dur == '15m' else 0.08,
                'maxPositionPct': 0.12 if dur in ('5m', '15m') else 0.10,
                'minConfidence': 0.38 if dur == '5m' else 0.40 if dur == '15m' else 0.42,
                'suggested': 'prior',
            }

    # Global stats
    global_stats = compute_stratum_stats(samples) or {
        'n': len(samples), 'wins': 0, 'losses': 0,
        'kellyFraction': 0.1, 'maxPositionPct': 0.10, 'minConfidence': 0.38,
    }

    # Regime
    regime = classify_regime(samples)

    # Exit mix
    exit_mix = compute_exit_mix(samples)

    # Regime knobs
    REGIME_PROFILES = {
        'trend_ride': {
            'kellyFraction': 0.25, 'maxPositionPct': 0.18, 'minConfidence': 0.30,
            'tpPctLow': 20, 'tpPctHigh': 48, 'slPct': 16,
        },
        'scalp': {
            'kellyFraction': 0.12, 'maxPositionPct': 0.10, 'minConfidence': 0.40,
            'tpPctLow': 16, 'tpPctHigh': 28, 'slPct': 12,
        },
        'arb_only': {
            'kellyFraction': 0.08, 'maxPositionPct': 0.06, 'minConfidence': 0.45,
            'tpPctLow': 12, 'tpPctHigh': 24, 'slPct': 10,
        },
    }
    profile = REGIME_PROFILES.get(regime['profile'], REGIME_PROFILES['scalp'])

    # Regime overlay: blend profile with stratum stats
    for key, stratum in strata.items():
        if regime['profile'] == 'trend_ride' and stratum['suggested'] in ('defensive', 'pause'):
            continue
        if regime['profile'] == 'arb_only':
            stratum['kellyFraction'] = min(stratum['kellyFraction'], profile['kellyFraction'])
            stratum['maxPositionPct'] = min(stratum['maxPositionPct'], profile['maxPositionPct'])
            stratum['minConfidence'] = max(stratum['minConfidence'], profile['minConfidence'])

    payload = {
        'generatedAt': int(__import__('time').time() * 1000),
        'version': 2,
        'sample': {
            'totalSamples': len(samples),
            'strataCount': len(strata),
            'durationPolicies': list(duration_policies.keys()),
        },
        'global': {
            'n': global_stats.get('n', len(samples)),
            'wins': global_stats.get('wins', 0),
            'losses': global_stats.get('losses', 0),
            'wr': global_stats.get('wr', 0.5),
            'expectancy': global_stats.get('expectancy', 0),
            'kellyFraction': profile['kellyFraction'],
            'maxPositionPct': profile['maxPositionPct'],
            'minConfidence': profile['minConfidence'],
        },
        'currentRegime': regime,
        'durationPolicies': duration_policies,
        'strata': strata,
        'exitMix': exit_mix,
        'notes': [
            'Bayesian posterior estimates per stratum (Beta-Bernoulli win rate).',
            'Kelly fraction is half-Kelly for safety.',
            'TP/SL from empirical percentiles of observed returns.',
            'Regime classification from rolling exit mix + consecutive losses.',
            'Auto-triggered by tradeCollector.js after every 5 new trades.',
        ],
    }

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_FILE, 'w') as f:
        json.dump(payload, f, indent=2, default=str)
    print(f'Wrote {OUTPUT_FILE}')

    # Write fund_heuristics.json in the format fundHeuristics.js expects
    fund_payload = {
        'generatedAt': payload['generatedAt'],
        'version': 1,
        'sample': payload['sample'],
        'global': {
            'n': global_stats.get('n', len(samples)),
            'wins': global_stats.get('wins', 0),
            'losses': global_stats.get('losses', 0),
            'wr': global_stats.get('wr', 0.5),
            'avgPnl': global_stats.get('expectancy', 0) * 100,
            'expectancy': global_stats.get('expectancy', 0),
            'kellyFraction': profile['kellyFraction'],
            'maxPositionPct': profile['maxPositionPct'],
            'minConfidence': profile['minConfidence'],
            'suggested': regime['profile'],
        },
        'durationPolicies': {},
        'strata': {},
        'exitMix': exit_mix,
        'notes': ['Trained by train_heuristics.py — Bayesian adaptive optimization'],
    }

    # Format duration policies the way fundHeuristics.js expects
    for dur, pol in duration_policies.items():
        fund_payload['durationPolicies'][dur] = {
            'n': pol.get('n', 0),
            'wins': pol.get('wins', 0),
            'losses': pol.get('losses', 0),
            'wr': pol.get('wr', 0.5),
            'kellyFraction': pol.get('kellyFraction', 0.1),
            'maxPositionPct': pol.get('maxPositionPct', 0.1),
            'minConfidence': pol.get('minConfidence', 0.38),
            'tpPctLow': pol.get('tpPctLow', 18),
            'tpPctHigh': pol.get('tpPctHigh', 40),
            'slPct': pol.get('slPct', 14),
            'maxEntryRemainingSec': pol.get('maxEntryRemainingSec', 270),
            'minRemainingSec': pol.get('minRemainingSec', 25),
            'mlLadder': 'short' if dur in ('5m', '15m') else 'long',
            'suggested': pol.get('suggested', 'prior'),
        }

    # Format strata the way fundHeuristics.js expects
    for key, st in strata.items():
        fund_payload['strata'][key] = {
            'n': st.get('n', 0),
            'wins': st.get('wins', 0),
            'losses': st.get('losses', 0),
            'wr': st.get('wr', 0.5),
            'avgPnl': round(st.get('expectancy', 0) * 100, 2),
            'expectancy': st.get('expectancy', 0),
            'kellyFraction': st.get('kellyFraction', 0.1),
            'maxPositionPct': st.get('maxPositionPct', 0.1),
            'minConfidence': st.get('minConfidence', 0.38),
            'suggested': st.get('suggested', 'base'),
        }

    with open(FUND_FILE, 'w') as f:
        json.dump(fund_payload, f, indent=2, default=str)
    print(f'Wrote {FUND_FILE}')

    print(f'  Samples: {len(samples)}')
    print(f'  Strata: {len(strata)}')
    print(f'  Durations: {list(duration_policies.keys())}')
    print(f'  Regime: {regime["label"]} → {regime["profile"]}')
    print(f'  Global Kelly: {payload["global"]["kellyFraction"]}')
    print(f'  Global WR: {payload["global"]["wr"]}')

if __name__ == '__main__':
    main()
