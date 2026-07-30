# Zinger ML — Data pipeline: fetch from Binance, cache locally

import os
import time
import json
from datetime import datetime, timezone, timedelta

import ccxt
import numpy as np
import pandas as pd

from config import SYMBOLS, TIMEFRAMES, DATA_DIR

exchange = ccxt.binance({
    'enableRateLimit': True,
    'rateLimit': 1200,
    'options': {'defaultType': 'spot'},
})

def fetch_ohlcv(symbol: str, timeframe: str, limit: int = 1000, since_ts: int | None = None) -> pd.DataFrame:
    """Fetch OHLCV from Binance, return DataFrame."""
    all_ohlcv = []
    remaining = limit
    current_since = since_ts

    while remaining > 0:
        fetch_limit = min(remaining, 1000)
        try:
            ohlcv = exchange.fetch_ohlcv(symbol, timeframe, since=current_since, limit=fetch_limit)
            if not ohlcv:
                break
            all_ohlcv.extend(ohlcv)
            remaining -= len(ohlcv)
            current_since = ohlcv[-1][0] + 1
            if len(ohlcv) < fetch_limit:
                break
            time.sleep(0.3)
        except Exception as e:
            print(f"  Error fetching {symbol} {timeframe}: {e}")
            time.sleep(2)
            continue

    if not all_ohlcv:
        return pd.DataFrame()

    df = pd.DataFrame(all_ohlcv, columns=['timestamp', 'open', 'high', 'low', 'close', 'volume'])
    df['timestamp'] = pd.to_datetime(df['timestamp'], unit='ms', utc=True)
    df.set_index('timestamp', inplace=True)
    df = df[~df.index.duplicated(keep='last')].sort_index()
    return df.astype(np.float32)

def build_cache_filename(symbol: str, timeframe: str) -> str:
    name = symbol.replace('/', '_').lower()
    return os.path.join(DATA_DIR, f'{name}_{timeframe}.parquet')

def cache_exists(symbol: str, timeframe: str) -> bool:
    return os.path.isfile(build_cache_filename(symbol, timeframe))

def load_cached(symbol: str, timeframe: str) -> pd.DataFrame | None:
    fp = build_cache_filename(symbol, timeframe)
    if os.path.isfile(fp):
        return pd.read_parquet(fp)
    return None

def save_cache(df: pd.DataFrame, symbol: str, timeframe: str):
    os.makedirs(DATA_DIR, exist_ok=True)
    df.to_parquet(build_cache_filename(symbol, timeframe))

def get_5yr_timestamp() -> int:
    """Timestamp in ms for 5 years ago."""
    return int((datetime.now(timezone.utc) - timedelta(days=1825)).timestamp() * 1000)

def fetch_all(force_refetch: bool = False) -> dict:
    """Fetch or load cached data for all symbols/timeframes."""
    available = {}
    since_ts = get_5yr_timestamp()

    for symbol in SYMBOLS:
        for timeframe, params in TIMEFRAMES.items():
            key = f'{symbol}_{timeframe}'
            if not force_refetch and cache_exists(symbol, timeframe):
                df = load_cached(symbol, timeframe)
                if df is not None and len(df) > 1000:
                    print(f"  [CACHE] {key}: {len(df)} rows ({df.index[0]} → {df.index[-1]})")
                    available[key] = df
                    continue

            print(f"  [FETCH] {key} (limit={params['limit']})...")
            df = fetch_ohlcv(symbol, timeframe, since_ts=since_ts)
            if len(df) == 0:
                print(f"  [WARN] Empty data for {key}")
                continue
            save_cache(df, symbol, timeframe)
            print(f"  [OK] {key}: {len(df)} rows ({df.index[0]} → {df.index[-1]})")
            available[key] = df

    return available

def merge_timeframes(dfs: dict[str, pd.DataFrame]) -> pd.DataFrame:
    """Merge multiple timeframe OHLCV into aligned multi-index columns."""
    parts = []
    for key, df in dfs.items():
        df = df.copy()
        df.columns = pd.MultiIndex.from_product([[key], df.columns])
        parts.append(df)
    merged = pd.concat(parts, axis=1).ffill().bfill()
    return merged

if __name__ == '__main__':
    print("Fetching all data...")
    data = fetch_all()
    print(f"\nAvailable datasets: {list(data.keys())}")
    for k, v in data.items():
        print(f"  {k}: {len(v)} rows, {v.index[0]} → {v.index[-1]}")
