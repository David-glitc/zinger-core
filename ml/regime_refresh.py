# Zinger ML — Refresh the OHLCV cache, then re-emit the live regime signal.
#
# The governor reads one regime signal and drops it once it is older than 6h
# (see src/polymarket/regimeSignal.ts). The signal is stamped from the last
# candle, not from wall clock, so a stale OHLCV cache produces a stale signal
# even on a successful run — refreshing the cache first is the whole point of
# bundling these two steps into one entry point.
#
# Failing safe: if the fetch fails we still try to emit, since an emit off a
# slightly-old cache is better than no emit at all. If the emit fails the
# governor simply falls back to its ADX/ATR heuristic.
#
# Cadence: every 2h keeps the reading comfortably inside the 6h gate even if a
# run or two is missed.
#
# Usage: python3 ml/regime_refresh.py [SYMBOL] [TIMEFRAME]

import os
import subprocess
import sys
import traceback
from datetime import datetime, timedelta, timezone

sys.path.insert(0, "ml")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_SYMBOL = "BTC/USDT"
# 1h, not 5m: the overlay exists to give the governor a slow, stable risk-on/
# risk-off read that a single ATR sample cannot. The 5m fit is materially
# twitchier and disagrees with 1h during transitions.
DEFAULT_TIMEFRAME = "1h"

# Trailing bars to keep per timeframe. Deliberately not data.fetch_all():
# that anchors `since` five years back and caps at the 1000-row exchange limit,
# so it returns the *oldest* 1000 candles and silently replaces a current cache
# with 2021 data. Anchoring `since` to now-minus-N-bars pages forward to the
# present instead. The jump model needs >=200 bars; these give it room.
BARS = {"1h": 1500, "5m": 6000, "1m": 1440}
TF_SECONDS = {"1m": 60, "5m": 300, "1h": 3600}


def log(msg):
    print(f"[{datetime.now(timezone.utc).isoformat(timespec='seconds')}] {msg}", flush=True)


def refresh_cache():
    from config import SYMBOLS
    from data import fetch_ohlcv, save_cache

    now = datetime.now(timezone.utc)
    ok = 0
    for symbol in SYMBOLS:
        for tf, bars in BARS.items():
            since = int((now - timedelta(seconds=TF_SECONDS[tf] * bars)).timestamp() * 1000)
            df = fetch_ohlcv(symbol, tf, limit=bars, since_ts=since)
            if df is None or len(df) == 0:
                log(f"  {symbol} {tf}: empty fetch, leaving existing cache alone")
                continue
            save_cache(df, symbol, tf)
            log(f"  {symbol} {tf}: {len(df)} rows -> {df.index[-1]}")
            ok += 1
    log(f"cache refreshed: {ok} series")
    return ok > 0


def emit(symbol, timeframe):
    log(f"emitting regime signal for {symbol} {timeframe}")
    res = subprocess.run(
        [sys.executable, os.path.join("ml", "regime_emit.py"), symbol, timeframe],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    sys.stdout.write(res.stdout)
    if res.returncode != 0:
        sys.stderr.write(res.stderr)
        log(f"emit FAILED rc={res.returncode}")
        return False
    log("emit ok")
    return True


def main():
    symbol = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SYMBOL
    timeframe = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_TIMEFRAME
    os.chdir(ROOT)

    try:
        refresh_cache()
    except Exception:
        log("cache refresh FAILED — emitting off the existing cache anyway")
        traceback.print_exc()

    return 0 if emit(symbol, timeframe) else 1


if __name__ == "__main__":
    sys.exit(main())
