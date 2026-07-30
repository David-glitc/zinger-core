# Zinger ML — Feature engineering: TA indicators + meta-features

import numpy as np
import pandas as pd
from typing import Tuple

from config import TIMEFRAMES


def add_technical_indicators(df: pd.DataFrame) -> pd.DataFrame:
    """Add technical analysis features."""
    close = df['close'].values.astype(np.float64)
    high = df['high'].values.astype(np.float64)
    low = df['low'].values.astype(np.float64)
    volume = df['volume'].values.astype(np.float64)
    n = len(df)

    out = {}

    # ——— Moving Averages ———
    for p in [5, 10, 20, 50, 100, 200]:
        out[f'sma_{p}'] = _sma(close, p)
        out[f'ema_{p}'] = _ema(close, p)
    # MA crossovers
    out['ma_cross_10_50'] = out['sma_10'] - out['sma_50']
    out['ma_cross_20_100'] = out['sma_20'] - out['sma_100']
    out['price_to_ma_50'] = close / np.where(out['sma_50'] == 0, 1, out['sma_50']) - 1
    out['price_to_ma_200'] = close / np.where(out['sma_200'] == 0, 1, out['sma_200']) - 1

    # ——— RSI ———
    for p in [6, 14, 21]:
        out[f'rsi_{p}'] = _rsi(close, p)

    # ——— MACD ———
    macd_line, macd_signal, macd_hist = _macd(close)
    out['macd'] = macd_line
    out['macd_signal'] = macd_signal
    out['macd_hist'] = macd_hist

    # ——— Bollinger Bands ———
    bb_mid, bb_upper, bb_lower, bb_width, bb_pos = _bollinger(close)
    out['bb_mid'] = bb_mid
    out['bb_upper'] = bb_upper
    out['bb_lower'] = bb_lower
    out['bb_width'] = bb_width
    out['bb_position'] = bb_pos
    out['bb_squeeze'] = bb_width < np.percentile(bb_width[max(0, n-500):], 20) if n > 500 else np.zeros(n)

    # ——— ATR ———
    atr = _atr(high, low, close)
    out['atr'] = atr
    out['atr_pct'] = atr / np.where(close == 0, 1, close)

    # ——— ADX ———
    adx, pdi, ndi = _adx(high, low, close)
    out['adx'] = adx
    out['pdi'] = pdi
    out['ndi'] = ndi
    out['adx_trend'] = np.where(adx > 25, np.where(pdi > ndi, 1, -1), 0)

    # ——— Momentum ———
    for p in [1, 3, 5, 10, 20]:
        mom = np.full(n, np.nan)
        if n > p:
            mom[p:] = (close[p:] / close[:-p]) - 1
        out[f'mom_{p}'] = mom

    # ——— Rate of Change ———
    for p in [5, 10, 20]:
        roc = np.full(n, np.nan)
        if n > p:
            roc[p:] = (close[p:] - close[:-p]) / close[:-p] * 100
        out[f'roc_{p}'] = roc

    # ——— Volume ———
    for p in [5, 10, 20]:
        out[f'vol_sma_{p}'] = _sma(volume, p)
    vol_sma_5 = out.get('vol_sma_5', np.full(n, np.nan))
    out['vol_ratio'] = volume / np.where(vol_sma_5 == 0, 1, vol_sma_5)
    out['volume_spike'] = (out['vol_ratio'] > 1.5).astype(np.float32)

    # ——— Price action ———
    hl_range = (high - low) / np.where(close == 0, 1, close)
    out['hl_range'] = hl_range
    open_p = df['open'].values.astype(np.float64)
    out['gap'] = np.full(n, np.nan)
    if n > 1:
        out['gap'][1:] = (open_p[1:] - close[:-1]) / np.where(close[:-1] == 0, 1, close[:-1])
    out['body'] = np.abs(close - open_p) / np.where(hl_range == 0, 1, hl_range)
    candle_dir = np.zeros(n)
    candle_dir[close > open_p] = 1
    candle_dir[close < open_p] = -1
    out['candle_dir'] = candle_dir

    # ——— Volatility ———
    for p in [5, 10, 20]:
        out[f'volatility_{p}'] = _sma(hl_range, p)

    # ——— Target encoding (forward returns) ———
    targets = {}
    for h in [1, 3, 5, 10, 20]:
        fwd_ret = np.full(n, np.nan)
        if n > h:
            fwd_ret[:n-h] = (close[h:] / close[:n-h]) - 1
        targets[f'fwd_ret_{h}'] = fwd_ret
        targets[f'target_dir_{h}'] = np.sign(fwd_ret)

    df_out = pd.DataFrame(out, index=df.index)
    df_out = df_out.replace([np.inf, -np.inf], np.nan)

    # Attach targets as separate attributes (not columns)
    df_targets = pd.DataFrame(targets, index=df.index)
    df_out.attrs['targets'] = df_targets
    return df_out


def add_meta_features(ohlcv: pd.DataFrame, features: pd.DataFrame) -> pd.DataFrame:
    """Add meta/regime features derived from combined indicators."""
    meta = pd.DataFrame(index=features.index)
    close = ohlcv['close'].values.astype(np.float64)
    n = len(close)

    # Regime classification
    adx = features['adx'].values
    bb_pos = features['bb_position'].values
    rsi_14 = features['rsi_14'].values

    meta['regime'] = np.where(
        adx > 25,
        np.where(features['adx_trend'].values > 0, 2, -2),  # trending up/down
        np.where(
            (bb_pos > 0.8) | (bb_pos < 0.2),
            1,  # ranging but at extremes
            0   # ranging neutral
        )
    )

    # Volatility regime
    atr_pct = features['atr_pct'].values
    atr_valid = atr_pct[~np.isnan(atr_pct)]
    thresh_high = np.nanpercentile(atr_valid, 75) if len(atr_valid) > 0 else 1
    thresh_low = np.nanpercentile(atr_valid, 25) if len(atr_valid) > 0 else 0
    meta['vol_regime'] = np.where(
        atr_pct > thresh_high, 2,
        np.where(atr_pct < thresh_low, 0, 1)
    )

    # Liquidity proxy (volume relative to MA)
    vol_ratio = features['vol_ratio'].values
    meta['liq_regime'] = np.where(vol_ratio > 1.2, 1, np.where(vol_ratio < 0.8, -1, 0))

    # RSI regime
    meta['rsi_regime'] = np.where(rsi_14 > 70, -1, np.where(rsi_14 < 30, 1, 0))

    # Rolling win rate for recent price direction (using OHLCV close)
    fwd_ret_1 = np.full(n, np.nan)
    if n > 1:
        fwd_ret_1[:n-1] = (close[1:] / close[:n-1]) - 1
    fwd_dir = np.sign(fwd_ret_1)
    for p in [5, 10]:
        roll = _roll_mean(np.where(fwd_dir == 1, 1, 0), p)
        meta[f'dir_consistency_{p}'] = roll

    return meta


# ====== Internal helpers (numpy) ======

def _sma(arr: np.ndarray, period: int) -> np.ndarray:
    out = np.full(len(arr), np.nan)
    if len(arr) < period:
        return out
    cum = np.cumsum(arr, dtype=np.float64)
    out[period-1:] = (cum[period-1:] - np.concatenate([[0], cum[:-period]])) / period
    return out

def _ema(arr: np.ndarray, period: int) -> np.ndarray:
    out = arr.astype(np.float64).copy()
    if len(arr) < period:
        out[:] = np.nan
        return out
    k = 2.0 / (period + 1)
    # Find first non-NaN index
    first_valid = np.where(~np.isnan(arr))[0]
    if len(first_valid) == 0:
        out[:] = np.nan
        return out
    start = max(first_valid[0], period - 1)
    if start >= len(arr):
        out[:] = np.nan
        return out
    # Seed with mean of first valid window
    seed = np.nanmean(arr[max(0, start - period + 1):start + 1])
    if np.isnan(seed):
        out[:] = np.nan
        return out
    out[start] = seed
    for i in range(start + 1, len(arr)):
        if np.isnan(arr[i]):
            continue
        out[i] = arr[i] * k + out[i-1] * (1 - k)
    out[:start] = np.nan
    return out

def _rsi(close: np.ndarray, period: int = 14) -> np.ndarray:
    out = np.full(len(close), np.nan)
    if len(close) <= period:
        return out
    deltas = np.diff(close)
    gains = np.where(deltas > 0, deltas, 0).astype(np.float64)
    losses = np.where(deltas < 0, -deltas, 0).astype(np.float64)
    avg_gain = _ema(gains, period)
    avg_loss = _ema(losses, period)
    rs = avg_gain / np.where(avg_loss == 0, 1e-10, avg_loss)
    # rs starts at index period-1 in delta-space (index period in close-space)
    valid = period
    out[valid:] = 100 - (100 / (1 + rs[valid-1:]))
    return out

def _macd(close: np.ndarray) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    ema12 = _ema(close, 12)
    ema26 = _ema(close, 26)
    macd_line = ema12 - ema26
    signal = _ema(macd_line, 9)
    hist = macd_line - signal
    return macd_line, signal, hist

def _bollinger(close: np.ndarray, period: int = 20) -> Tuple[np.ndarray, ...]:
    n = len(close)
    mid = _sma(close, period)
    rolling_std = np.full(n, np.nan)
    for i in range(period-1, n):
        rolling_std[i] = np.std(close[i-period+1:i+1], ddof=1)
    upper = mid + 2 * rolling_std
    lower = mid - 2 * rolling_std
    width = (upper - lower) / np.where(mid == 0, 1, mid)
    pos = (close - lower) / np.where(upper - lower == 0, 1, upper - lower)
    return mid, upper, lower, width, pos

def _atr(high: np.ndarray, low: np.ndarray, close: np.ndarray, period: int = 14) -> np.ndarray:
    n = len(high)
    tr = np.zeros(n); tr[0] = high[0] - low[0]
    for i in range(1, n):
        tr[i] = max(high[i] - low[i], abs(high[i] - close[i-1]), abs(low[i] - close[i-1]))
    return _ema(tr, period)

def _adx(high: np.ndarray, low: np.ndarray, close: np.ndarray, period: int = 14) -> Tuple[np.ndarray, ...]:
    n = len(high)
    up_move = np.zeros(n); up_move[1:] = np.diff(high)
    down_move = np.zeros(n); down_move[1:] = np.diff(low)
    plus_dm = np.where((up_move > down_move) & (up_move > 0), up_move, 0).astype(np.float64)
    minus_dm = np.where((down_move > up_move) & (down_move > 0), down_move, 0).astype(np.float64)
    tr = np.zeros(n); tr[0] = high[0] - low[0]
    for i in range(1, n):
        tr[i] = max(high[i]-low[i], abs(high[i]-close[i-1]), abs(low[i]-close[i-1]))
    atr = _ema(tr, period)
    pdi = 100 * _ema(plus_dm, period) / np.where(atr == 0, 1, atr)
    ndi = 100 * _ema(minus_dm, period) / np.where(atr == 0, 1, atr)
    dx = 100 * np.abs(pdi - ndi) / np.where(pdi + ndi == 0, 1, pdi + ndi)
    adx_vals = _ema(dx, period)
    return adx_vals, pdi, ndi

def _roll_mean(arr: np.ndarray, window: int) -> np.ndarray:
    out = np.full(len(arr), np.nan)
    if len(arr) < window:
        return out
    cum = np.cumsum(arr, dtype=np.float64)
    out[window-1:] = (cum[window-1:] - np.concatenate([[0], cum[:-window]])) / window
    return out
