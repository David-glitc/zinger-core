#!/usr/bin/env python3
"""
Zinger ML Benchmark Suite
- Loads all 12 ONNX models
- Runs inference on live Binance data
- Measures latency, throughput
- Backtests against historical trade outcomes
"""

import sys, os, json, time, math, statistics
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np
import pandas as pd
from features import add_technical_indicators, add_meta_features
from config import TIMEFRAMES
from collections import defaultdict

ONNX_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data/ml/models/onnx')
MANIFEST_PATH = os.path.join(ONNX_DIR, 'manifest.json')
TRADES_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data/poly_trades.json')

try:
    import onnxruntime as ort
except ImportError:
    ort = None

VERBOSE = True

def log(msg):
    if VERBOSE:
        print(msg)

# ── 1. Load manifest ────────────────────────────────────────────────
def load_manifest():
    with open(MANIFEST_PATH) as f:
        return json.load(f)

# ── 2. Fetch live data from Binance ─────────────────────────────────
def fetch_live_data(symbol, timeframe, limit=500):
    import ccxt
    asset = f'{symbol}/USDT'
    ex = ccxt.binance()
    ohlcv = ex.fetch_ohlcv(asset, timeframe, limit=limit)
    df = pd.DataFrame(ohlcv, columns=['timestamp','open','high','low','close','volume'])
    df['timestamp'] = pd.to_datetime(df['timestamp'], unit='ms', utc=True)
    df.set_index('timestamp', inplace=True)
    return df

# ── 3. Preprocess features ──────────────────────────────────────────
def preprocess(df, timeframe):
    feats = add_technical_indicators(df)
    meta = add_meta_features(df, feats)
    seq_len = TIMEFRAMES.get(timeframe, {}).get('seq_len', 64)

    clean_idx = meta.dropna().index
    feats_c = feats.loc[clean_idx].dropna(how='any')
    if len(feats_c) < seq_len + 5:
        return None, None, None, None, None

    meta_c = meta.loc[feats_c.index]

    seq_feats = feats_c.values[-seq_len:].astype(np.float32)
    latest_meta = meta_c.values[-1:].astype(np.float32)

    return seq_feats, latest_meta, seq_len, feats_c.shape[1], meta_c.shape[1]

# ── 4. ONNX inference ────────────────────────────────────────────────
def onnx_infer(session, feat_seq, meta):
    feat_seq = feat_seq.astype(np.float32)
    meta = meta.astype(np.float32)
    inputs = {
        session.get_inputs()[0].name: feat_seq,
        session.get_inputs()[1].name: meta,
    }
    t0 = time.perf_counter()
    outputs = session.run(None, inputs)
    elapsed = time.perf_counter() - t0
    return outputs, elapsed

# ── 5. Run benchmark on all models ──────────────────────────────────
def benchmark_all():
    log('\n═══════════════════════════════════════════════')
    log('  ZINGER ML BENCHMARK — ONNX INFERENCE')
    log('═══════════════════════════════════════════════\n')

    manifest = load_manifest()
    log(f'Manifest loaded: {len(manifest)} models\n')

    results = []
    for entry in manifest:
        symbol = entry['symbol']
        tf = entry['timeframe']
        horizon = entry['horizon']
        onnx_path = entry['path'].replace('.onnx', '.onnx')  # may need .onnx.data

        label = f'{symbol}/{tf} h{horizon}'
        model_path = os.path.join(ONNX_DIR, os.path.basename(entry['path']))
        if not os.path.exists(model_path):
            log(f'  SKIP {label}: {model_path} not found')
            continue

        try:
            t_load = time.perf_counter()
            session = ort.InferenceSession(model_path)
            load_time = time.perf_counter() - t_load
        except Exception as e:
            log(f'  LOAD FAIL {label}: {e}')
            continue

        try:
            df = fetch_live_data(symbol, tf)
        except Exception as e:
            log(f'  FETCH FAIL {label}: {e}')
            continue

        feat_seq, meta, seq_len, feat_dim, meta_dim = preprocess(df, tf)
        if feat_seq is None:
            log(f'  SKIP {label}: insufficient clean data')
            continue

        # Warmup
        for _ in range(3):
            onnx_infer(session, feat_seq[np.newaxis, ...], meta)

        # Benchmark: 10 iterations
        latencies = []
        outputs = None
        for _ in range(10):
            out, lat = onnx_infer(session, feat_seq[np.newaxis, ...], meta)
            latencies.append(lat)
            outputs = out

        probs = outputs[0][0]
        confidence = float(outputs[1][0][0])
        expected_ret = float(outputs[2][0][0])

        direction = 'UP' if probs[2] > probs[0] and probs[2] > probs[1] else \
                    'DOWN' if probs[0] > probs[1] and probs[0] > probs[2] else 'NEUTRAL'

        avg_lat = statistics.mean(latencies) * 1000
        p99_lat = sorted(latencies)[int(len(latencies) * 0.99)] * 1000
        throughput = 1.0 / statistics.mean(latencies)

        res = {
            'model': label,
            'feat_dim': feat_dim,
            'meta_dim': meta_dim,
            'seq_len': seq_len,
            'load_time_ms': round(load_time * 1000, 1),
            'avg_latency_ms': round(avg_lat, 3),
            'p99_latency_ms': round(p99_lat, 3),
            'throughput_ips': round(throughput, 1),
            'direction': direction,
            'confidence': round(confidence, 4),
            'expected_return': round(expected_ret, 6),
            'prob_up': round(float(probs[2]), 4),
            'prob_down': round(float(probs[0]), 4),
            'prob_neutral': round(float(probs[1]), 4),
        }
        results.append(res)

        log(f'  {label:30s} lat={avg_lat:6.2f}ms  p99={p99_lat:6.2f}ms  '
            f'tput={throughput:5.1f}ips  {direction:8s}  conf={confidence:.2%}  '
            f'E[r]={expected_ret:+.4f}')

    log(f'\n── Summary ──────────────────────────────────')
    if results:
        avg_lat = statistics.mean(r['avg_latency_ms'] for r in results)
        max_lat = max(r['avg_latency_ms'] for r in results)
        min_lat = min(r['avg_latency_ms'] for r in results)
        avg_tput = statistics.mean(r['throughput_ips'] for r in results)
        log(f'  Models:       {len(results)}')
        log(f'  Avg latency:  {avg_lat:.2f}ms  (range {min_lat:.2f}–{max_lat:.2f}ms)')
        log(f'  Avg t/put:    {avg_tput:.1f} inferences/sec')
        log(f'  Total t/put:  {sum(r["throughput_ips"] for r in results):.1f} ips (sequential)')

    return results

# ── 6. Backtest against historical trades ────────────────────────────
def backtest_trades():
    log('\n\n═══════════════════════════════════════════════')
    log('  ZINGER TRADE BACKTEST — HISTORICAL ANALYSIS')
    log('═══════════════════════════════════════════════\n')

    if not os.path.exists(TRADES_PATH):
        log('No trades data found')
        return None

    with open(TRADES_PATH) as f:
        trades = json.load(f)

    log(f'Total trades:  {len(trades)}')
    log(f'Date range:    {min(t.get("timestamp",0) or 0 for t in trades)} – '
        f'{max(t.get("timestamp",0) or 0 for t in trades)}')

    # Analysis
    total = len(trades)
    wins = [t for t in trades if (t.get('pnl') or 0) > 0]
    losses = [t for t in trades if (t.get('pnl') or 0) <= 0]
    total_pnl = sum(t.get('pnl') or 0 for t in trades)

    by_symbol = defaultdict(list)
    for t in trades:
        by_symbol[t.get('symbol', 'UNK')].append(t)

    by_outcome = defaultdict(list)
    for t in trades:
        by_outcome[t.get('outcome', 'UNK')].append(t)

    by_exit = defaultdict(list)
    for t in trades:
        by_exit[t.get('exitReason', 'UNK')].append(t)

    by_mode = defaultdict(list)
    for t in trades:
        by_mode[t.get('mode', 'UNK')].append(t)

    log(f'\n── Overall Performance ─────────────────────')
    log(f'  Total PnL:     ${total_pnl:.2f}')
    log(f'  Win rate:      {len(wins)/total*100:.1f}% ({len(wins)}W/{len(losses)}L)')
    log(f'  Avg win:       ${(sum(t.get("pnl") or 0 for t in wins) / len(wins)):.2f}' if wins else '  Avg win:      N/A')
    log(f'  Avg loss:      ${(sum(t.get("pnl") or 0 for t in losses) / len(losses)):.2f}' if losses else '  Avg loss:     N/A')
    if wins and losses:
        profit_factor = abs(sum(t.get("pnl") or 0 for t in wins) / sum(t.get("pnl") or 0 for t in losses))
        log(f'  Profit factor: {profit_factor:.2f}')

    log(f'\n── By Symbol ───────────────────────────────')
    for sym, tx in sorted(by_symbol.items()):
        sym_wins = [t for t in tx if (t.get('pnl') or 0) > 0]
        sym_pnl = sum(t.get('pnl') or 0 for t in tx)
        log(f'  {sym:6s}  {len(tx):3d} trades  PnL={sym_pnl:+.2f}  '
            f'WR={len(sym_wins)/len(tx)*100:5.1f}%')

    log(f'\n── By Outcome ──────────────────────────────')
    for oc, tx in sorted(by_outcome.items()):
        oc_wins = [t for t in tx if (t.get('pnl') or 0) > 0]
        oc_pnl = sum(t.get('pnl') or 0 for t in tx)
        log(f'  {oc:8s}  {len(tx):3d} trades  PnL={oc_pnl:+.2f}  '
            f'WR={len(oc_wins)/len(tx)*100:5.1f}%')

    log(f'\n── By Exit Reason ──────────────────────────')
    for ex, tx in sorted(by_exit.items()):
        ex_wins = [t for t in tx if (t.get('pnl') or 0) > 0]
        ex_pnl = sum(t.get('pnl') or 0 for t in tx)
        log(f'  {ex:10s}  {len(tx):3d} trades  PnL={ex_pnl:+.2f}  '
            f'WR={len(ex_wins)/len(tx)*100:5.1f}%')

    log(f'\n── By Mode ─────────────────────────────────')
    for md, tx in sorted(by_mode.items()):
        md_wins = [t for t in tx if (t.get('pnl') or 0) > 0]
        md_pnl = sum(t.get('pnl') or 0 for t in tx)
        log(f'  {md:8s}  {len(tx):3d} trades  PnL={md_pnl:+.2f}  '
            f'WR={len(md_wins)/len(tx)*100:5.1f}%')

    # Confidence analysis
    log(f'\n── Signal Confidence Calibration ───────────')
    with_conf = [(t.get('pnl') or 0, t.get('signal', {}).get('confidence', 0))
                  for t in trades if t.get('signal')]
    if with_conf:
        bins = [0, 0.3, 0.5, 0.7, 0.9, 1.0]
        for i in range(len(bins) - 1):
            lo, hi = bins[i], bins[i + 1]
            group = [(pnl, conf) for pnl, conf in with_conf if lo <= conf < hi]
            if group:
                wins_g = sum(1 for pnl, _ in group if pnl > 0)
                pnl_g = sum(pnl for pnl, _ in group)
                avg_conf = statistics.mean(conf for _, conf in group)
                log(f'  conf [{lo:.1f}-{hi:.1f}):  {len(group):3d} samples  '
                    f'WR={wins_g/len(group)*100:5.1f}%  PnL={pnl_g:+.2f}  '
                    f'avg_conf={avg_conf:.2f}')

    return {
        'total_trades': total,
        'wins': len(wins),
        'losses': len(losses),
        'total_pnl': total_pnl,
        'win_rate': len(wins) / total * 100,
        'by_symbol': {s: {'trades': len(tx), 'pnl': sum(t.get('pnl') or 0 for t in tx),
                          'win_rate': len([t for t in tx if (t.get('pnl') or 0) > 0]) / len(tx) * 100}
                      for s, tx in by_symbol.items()},
        'by_outcome': {o: {'trades': len(tx), 'pnl': sum(t.get('pnl') or 0 for t in tx),
                           'win_rate': len([t for t in tx if (t.get('pnl') or 0) > 0]) / len(tx) * 100}
                      for o, tx in by_outcome.items()},
        'by_exit': {e: {'trades': len(tx), 'pnl': sum(t.get('pnl') or 0 for t in tx),
                        'win_rate': len([t for t in tx if (t.get('pnl') or 0) > 0]) / len(tx) * 100}
                   for e, tx in by_exit.items()},
    }

# ── 7. Run all ──────────────────────────────────────────────────────
if __name__ == '__main__':
    if ort is None:
        log('onnxruntime not installed. Install: pip install onnxruntime --break-system-packages')
        sys.exit(1)

    results = benchmark_all()
    bt = backtest_trades()

    # Save
    output = {'inference_benchmark': results, 'trade_backtest': bt}
    out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'benchmark_results.json')
    with open(out_path, 'w') as f:
        json.dump(output, f, indent=2, default=str)
    log(f'\nResults saved to {out_path}')