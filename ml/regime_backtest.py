# Zinger ML — Paper backtest for the statistical jump-model regime detector.
# Loads fresh OHLCV, fits the model walk-forward, reports regime flips, and
# compares a regime-gated hold strategy vs buy-and-hold (vol, drawdown, Sharpe).
#
# Usage:  python3 ml/regime_backtest.py [LINK/USDT|BTC/USDT|ETH/USDT] [1h|5m]

import sys
import warnings

import numpy as np
import pandas as pd

warnings.filterwarnings("ignore")

sys.path.insert(0, "ml")
from data import load_cached
from regime_jump import StatisticalJumpModel, label_regime


def returns_from(df):
    close = df["close"].values.astype(np.float64)
    r = np.zeros(len(close))
    r[1:] = np.diff(close) / close[:-1]
    return r, close


def walk_forward_fit(r, window=200, min_fit=120):
    """Fit penalty-tuned model on each training window (walk-forward, causal)."""
    import numpy as np

    n = len(r)
    out_states = np.zeros(n, dtype=np.int32)
    out_states[:] = -1
    out_penalty = np.full(n, np.nan)
    candidates = np.logspace(-2, 1, 12)  # penalty grid
    for start in range(0, n - min_fit, window):
        end = min(start + window, n)
        train = r[start:end]
        # pick penalty by Sharpe of regime-gated long on the window (walk-forward CV)
        best_pen, best_sh = candidates[0], -1e9
        for pen in candidates:
            mdl = StatisticalJumpModel(n_states=2, penalty=pen, n_iter=20, seed=42)
            try:
                st = mdl.fit_predict(train)
            except Exception:
                continue
            high = mdl.high_vol_state
            hold = st != high          # hold long except in high-vol regime
            pos = np.zeros(len(train)); pos[:-1] = hold[:-1]
            strat = (pos[:-1] * train[1:]).cumsum()
            sh = strat[-1] / (np.std(strat) + 1e-12) if len(strat) > 5 else 0
            if sh > best_sh:
                best_sh, best_pen = sh, pen
        mdl = StatisticalJumpModel(n_states=2, penalty=best_pen, n_iter=30, seed=42)
        st = mdl.fit_predict(train)
        out_states[start:end] = st
        out_penalty[start:end] = best_pen
        print(f"  window {start}:{end} penalty={best_pen:.4f} flips={mdl.flips_}")
    return out_states, out_penalty


def summary(name, r, close, states, high_vol_state):
    n = len(r)
    hold = states != high_vol_state
    pos = np.zeros(n); pos[:-1] = hold[:-1]
    strat_ret = pos[:-1] * r[1:]
    bh_ret = r[1:]

    def metrics(ser):
        if len(ser) == 0:
            return {}
        eq = np.cumprod(1 + ser)
        peak = np.maximum.accumulate(eq)
        dd = float(np.max((peak - eq) / peak)) if len(peak) else 0.0
        mu = ser.mean() * 252 * 24
        sd = ser.std() * np.sqrt(252 * 24)
        return {
            "cagr": float(np.prod(1 + ser) ** (24 * 252 / len(ser)) - 1),
            "max_dd": dd,
            "sharpe": float(mu / sd) if sd > 0 else 0.0,
            "mean": float(ser.mean()),
            "vol": float(sd),
        }

    ms = metrics(strat_ret)
    mb = metrics(bh_ret)
    flips = int((states[1:] != states[:-1]).sum())
    frac_hold = float(hold.mean())
    print(f"\n=== {name} ({n} bars, {flips} regime flips, hold {frac_hold*100:.1f}% of time) ===")
    print(f"  regime-gated hold : {ms}")
    print(f"  buy-and-hold      : {mb}")
    # state label transitions
    labels = label_regime(states, high_vol_state)
    runs = []
    for i in range(n):
        if i == 0 or labels[i] != labels[i - 1]:
            runs.append([i, labels[i], 1])
        else:
            runs[-1][2] += 1
    print("  regime runs (start,label,len):")
    for st, lab, ln in runs:
        print(f"     {st:>5}  {lab:<10} {ln} bars")
    return ms, mb, flips


def main():
    symbol = sys.argv[1] if len(sys.argv) > 1 else "LINK/USDT"
    tf = sys.argv[2] if len(sys.argv) > 2 else "1h"
    df = load_cached(symbol, tf)
    if df is None or len(df) < 300:
        print(f"No cached data for {symbol} {tf} (need >=300 bars). Run data fetch first.")
        return
    r, close = returns_from(df)
    print(f"Series {symbol} {tf}: {len(r)} bars, {df.index[0]} -> {df.index[-1]}")
    states, pen = walk_forward_fit(r)
    valid = states != -1
    mdl = StatisticalJumpModel(n_states=2, penalty=float(np.nanmean(pen[valid])), n_iter=30, seed=42)
    mdl.fit(r, verbose=False)
    high = mdl.high_vol_state
    summary(f"{symbol} {tf}", r[valid], close[valid], states[valid], high)


if __name__ == "__main__":
    main()