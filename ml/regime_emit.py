# Zinger ML — Emit a live regime signal consumed by the JS governor.
# Fits the statistical jump model on the latest cached OHLCV and writes the
# current regime label, idio-vol tilt, and enough context for the governor to
# override its heuristic.
#
# Written through the shared SQLite store (data/zinger.db, docs table) under the
# key `regime_signal.json`, matching every other ML script and — crucially — the
# path `loadFileOrStore` reads on the Node side. Writing a bare JSON file here
# left the governor permanently blind on Node 22, where the store is sqlite.
#
# Usage: python3 ml/regime_emit.py [LINK/USDT|BTC/USDT|ETH/USDT] [1h|5m]

import sys
import json
import os

import numpy as np

sys.path.insert(0, "ml")
from data import load_cached
from regime_jump import StatisticalJumpModel, downside_deviation
from sqlite_store import store_save

STORE_KEY = "regime_signal.json"


def main():
    symbol = sys.argv[1] if len(sys.argv) > 1 else "BTC/USDT"
    tf = sys.argv[2] if len(sys.argv) > 2 else "1h"
    df = load_cached(symbol, tf)
    if df is None or len(df) < 200:
        print(f"No cached data for {symbol} {tf}")
        return 1

    close = df["close"].values.astype(np.float64)
    r = np.zeros(len(close)); r[1:] = np.diff(close) / close[:-1]

    # penalty=1.0 is the knee of the flips-vs-occupancy sweep across BTC/ETH on
    # 1h and 5m: separation is already maximal (1.5-2.1x downside dev between
    # states) and flip count has plateaued, while larger penalties only start
    # skewing occupancy. The old 0.05 ran ~2x the flips for no extra separation.
    penalty = float(os.environ.get("ZINGER_REGIME_PENALTY", 1.0))
    mdl = StatisticalJumpModel(n_states=2, penalty=penalty, n_iter=30, seed=42)
    states = mdl.fit_predict(r)
    cur = int(states[-1])
    high_vol = cur == mdl.high_vol_state

    # kelly's vol tilt divides realizedVol by calmBaseline, so both have to be the
    # same statistic or the ratio is meaningless. Both are now the model's own
    # downside-deviation feature: `rv` is its current value, `calm` is its mean
    # over the low-vol state. Previously rv was a 12-bar half-life-weighted dd of
    # raw returns while calm came from the oldest bars in the cache — different
    # windows, different weighting, and the quotient systematically under-de-risked.
    dd_series = mdl.features_[:, 0]
    rv = float(dd_series[-1])
    low_mask = states == mdl.low_vol_state
    calm = float(dd_series[low_mask].mean()) if low_mask.any() else None

    regime = "high-vol" if high_vol else "trend"
    out = {
        "symbol": symbol,
        "timeframe": tf,
        "at": df.index[-1].isoformat(),
        "regime": regime,
        "highVol": high_vol,
        "flips": mdl.flips_,
        "highVolFraction": float((states == mdl.high_vol_state).mean()),
        "penalty": penalty,
        "realizedVol": float(rv),
        "calmBaseline": None if calm is None else float(calm),
        "ddHighVolState": float(dd_series[states == mdl.high_vol_state].mean()) if (states == mdl.high_vol_state).any() else None,
        "downsideDev": float(downside_deviation(r[-1:])),
        "lastPrice": float(close[-1]),
        "source": "statistical-jump-model",
    }
    store_save(STORE_KEY, out)
    print(json.dumps(out, indent=2))
    print(f"\nwrote {STORE_KEY} to the shared store")


if __name__ == "__main__":
    main()
