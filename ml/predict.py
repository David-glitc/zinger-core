#!/usr/bin/env python3
"""Live inference module — feeds into Polymarket bot as final discriminator."""

import os
import json
import time
import pickle
import numpy as np
import pandas as pd
import torch
import torch.nn.functional as F

from config import MODEL_DIR, TIMEFRAMES
from features import add_technical_indicators, add_meta_features
from model import ZingerLSTM


class ZingerSignalDiscriminator:
    """
    Final discriminator for Polymarket signals.

    Takes live tick/orderbook data + current market state
    → direction, confidence, expected_value, Kelly fraction
    """

    def __init__(self, symbol: str = 'BTC/USDT', device: str = 'cpu'):
        self.symbol = symbol
        self.device = torch.device(device)
        self.models = {}
        self.buffer = {}  # rolling buffers per timeframe

        if torch.cuda.is_available():
            self.device = torch.device('cuda')

        self._load_models()

    def _load_models(self):
        """Load all trained LSTM models for this symbol."""
        for timeframe, params in TIMEFRAMES.items():
            for horizon in params['pred_horizons']:
                label = f'{self.symbol}_{timeframe}_h{horizon}'
                path = os.path.join(MODEL_DIR, f'{label}.pt')
                if os.path.isfile(path):
                    self.models[f'{timeframe}_h{horizon}'] = {
                        'path': path,
                        'seq_len': params['seq_len'],
                        'horizon': horizon,
                    }
                    print(f'  Loaded {label}')

    def update_buffer(self, ohlcv: pd.DataFrame, timeframe: str):
        """Update rolling buffer with new OHLCV data."""
        if not isinstance(ohlcv, pd.DataFrame) or len(ohlcv) == 0:
            return
        self.buffer[timeframe] = ohlcv

    def predict(self, timeframe: str = '1m', horizon: int = 1) -> dict:
        """Run prediction for a given timeframe and horizon."""
        model_key = f'{timeframe}_h{horizon}'
        if model_key not in self.models:
            return {'error': f'Model {model_key} not loaded'}

        info = self.models[model_key]
        ohlcv = self.buffer.get(timeframe)
        if ohlcv is None or len(ohlcv) < info['seq_len'] + 10:
            return {'error': f'Insufficient buffer for {timeframe}'}

        # Compute features
        feats = add_technical_indicators(ohlcv)
        meta = add_meta_features(ohlcv, feats)
        feat_dim = 0
        meta_dim = 0

        # Get latest sequence
        seq_feats = feats.values[-info['seq_len']:].astype(np.float32)
        latest_meta = meta.values[-1:].astype(np.float32)

        # Check for NaNs
        if np.isnan(seq_feats).any() or np.isnan(latest_meta).any():
            return {'error': 'NaN in input features'}

        # Build model on first call
        if not hasattr(self, '_model') or self._model_key != model_key:
            feat_dim = feats.shape[1]
            meta_dim = meta.shape[1]
            lstm = ZingerLSTM(feat_dim=feat_dim, meta_dim=meta_dim)
            lstm.load_state_dict(torch.load(info['path'], map_location=self.device, weights_only=True))
            lstm.to(self.device)
            lstm.eval()
            self._model = lstm
            self._model_key = model_key

        with torch.no_grad():
            f = torch.from_numpy(seq_feats).float().unsqueeze(0).to(self.device)
            m = torch.from_numpy(latest_meta).float().unsqueeze(0).to(self.device)
            logits, conf, ret, latent = self._model(f, m)
            probs = F.softmax(logits, dim=-1).squeeze(0).cpu().numpy()

        direction_map = {0: -1, 1: 0, 2: 1}
        direction = direction_map[int(np.argmax(probs))]
        confidence = float(torch.sigmoid(conf).squeeze().cpu().numpy())
        expected_return = float(ret.squeeze().cpu().numpy())

        # Kelly-optimal fraction
        edge = abs(expected_return)
        win_prob = min(max(0.5 + edge * 2.5, 0.05), 0.95)
        kelly_pct = max(0, (win_prob * 1.0 - (1 - win_prob)) / 1.0) * 0.25

        return {
            'direction': direction,
            'direction_label': 'UP' if direction == 1 else ('DOWN' if direction == -1 else 'NEUTRAL'),
            'confidence': round(confidence, 4),
            'expected_return': round(expected_return, 6),
            'prob_up': round(float(probs[2]), 4),
            'prob_down': round(float(probs[0]), 4),
            'prob_neutral': round(float(probs[1]), 4),
            'kelly_fraction': round(kelly_pct, 4),
            'model': model_key,
            'timestamp': time.time(),
        }

    def predict_all(self) -> list:
        """Run predictions across all loaded models."""
        results = []
        for key in self.models:
            tf, h = key.split('_h')
            result = self.predict(timeframe=tf, horizon=int(h))
            result['timeframe'] = tf
            result['horizon'] = int(h)
            results.append(result)
        return results

    def ensemble_discriminator(self, symbol: str | None = None, timeframe: str | None = None, horizon: int | None = None) -> dict:
        """
        Ensemble across loaded models → single final signal for Polymarket bot.
        Filters by symbol, timeframe, and/or horizon if provided.

        Returns the final direction + confidence + expected value.
        """
        all_preds = self.predict_all()
        if not all_preds:
            return {'direction': 0, 'confidence': 0, 'expected_value': 0, 'kelly': 0}

        # Filter by timeframe/horizon if specified
        if timeframe:
            all_preds = [p for p in all_preds if p.get('timeframe') == timeframe]
        if horizon is not None:
            all_preds = [p for p in all_preds if p.get('horizon') == horizon]

        valid = [p for p in all_preds if 'error' not in p]
        if not valid:
            return {'direction': 0, 'confidence': 0, 'expected_value': 0, 'kelly': 0}

        # If a single timeframe+horizon requested, just return that
        if timeframe and horizon is not None and len(valid) == 1:
            p = valid[0]
            dir_int = p['direction']
            return {
                'direction': dir_int,
                'confidence': round(p['confidence'], 4),
                'expected_value': round(p['expected_return'], 6),
                'kelly': round(max(0, (p['confidence'] * 1.0 - (1 - p['confidence'])) / 1.0) * 0.25, 4),
                'model': p.get('model', ''),
            }

        # Weighted ensemble across matching predictions
        weighted_dir = 0.0
        weighted_conf = 0.0
        weighted_ret = 0.0
        total_weight = 0.0

        for p in valid:
            tf = p.get('timeframe', '1m')
            weight = {'1m': 1.5, '5m': 1.0, '1h': 0.7}.get(tf, 1.0)
            w = p['confidence'] * weight
            weighted_dir += p['direction'] * w
            weighted_conf += p['confidence'] * w
            weighted_ret += p['expected_return'] * w
            total_weight += w

        if total_weight == 0:
            return {'direction': 0, 'confidence': 0, 'expected_value': 0, 'kelly': 0}

        final_dir = weighted_dir / total_weight
        final_conf = min(weighted_conf / total_weight, 1.0)
        final_ret = weighted_ret / total_weight

        dir_int = 0
        if final_dir > 0.2:
            dir_int = 1
        elif final_dir < -0.2:
            dir_int = -1

        return {
            'direction': dir_int,
            'confidence': round(final_conf, 4),
            'expected_value': round(final_ret, 6),
            'kelly': round(max(0, (final_conf * 1.0 - (1 - final_conf)) / 1.0) * 0.25, 4),
            'ensemble_count': len(valid),
        }


# Singleton for live use
_discriminator: ZingerSignalDiscriminator | None = None

def get_discriminator(symbol: str = 'BTC/USDT') -> ZingerSignalDiscriminator:
    global _discriminator
    if _discriminator is None:
        print('Initializing ZingerSignalDiscriminator...')
        _discriminator = ZingerSignalDiscriminator(symbol)
    return _discriminator


def quick_ml_signal(
    symbol: str = 'BTC',
    timeframe: str = '1h',
    horizon: int = 1,
    binance_limit: int = 200,
) -> dict:
    """
    One-shot ML signal: fetch live data from Binance, compute features,
    run the trained model, return signal dict.
    Designed for the Polymarket bot bridge (predict.js).
    """
    asset = 'BTC/USDT' if symbol.upper() == 'BTC' else 'ETH/USDT'
    fetch_limit = max(binance_limit, 500)
    try:
        import ccxt
        ex = ccxt.binance()
        ohlcv_raw = ex.fetch_ohlcv(asset, timeframe, limit=fetch_limit)
        df = pd.DataFrame(ohlcv_raw, columns=['timestamp', 'open', 'high', 'low', 'close', 'volume'])
        df['timestamp'] = pd.to_datetime(df['timestamp'], unit='ms', utc=True)
        df.set_index('timestamp', inplace=True)
    except Exception as e:
        return {'direction': 0, 'confidence': 0, 'error': f'fetch: {e}'}

    # Compute features
    feats = add_technical_indicators(df)
    meta = add_meta_features(df, feats)
    seq_len = TIMEFRAMES.get(timeframe, {}).get('seq_len', 64)

    # Clean NaN rows
    clean_idx = meta.dropna().index
    feats_c = feats.loc[clean_idx].dropna(how='any')
    if len(feats_c) < seq_len + 5:
        return {'direction': 0, 'confidence': 0, 'error': 'insufficient clean data'}
    meta_c = meta.loc[feats_c.index]

    feat_dim = feats_c.shape[1]
    meta_dim = meta_c.shape[1]

    # Load model
    label = f'{asset}_{timeframe}_h{horizon}'.replace('/', '_')
    model_path = os.path.join(MODEL_DIR, f'{label}.pt')
    if not os.path.isfile(model_path):
        return {'direction': 0, 'confidence': 0, 'error': f'no model: {label}'}

    lstm = ZingerLSTM(feat_dim=feat_dim, meta_dim=meta_dim)
    lstm.load_state_dict(torch.load(model_path, map_location='cpu', weights_only=True))
    lstm.eval()

    # Get latest sequence
    seq_feats = feats_c.values[-seq_len:].astype(np.float32)
    latest_meta = meta_c.values[-1:].astype(np.float32)

    if np.isnan(seq_feats).any() or np.isnan(latest_meta).any():
        return {'direction': 0, 'confidence': 0, 'error': 'NaN in input'}

    with torch.no_grad():
        f = torch.from_numpy(seq_feats).float().unsqueeze(0)
        m = torch.from_numpy(latest_meta).float()
        logits, conf, ret, _ = lstm(f, m)
        probs = torch.softmax(logits, dim=-1).squeeze(0).numpy()

    direction_map = {0: -1, 1: 0, 2: 1}
    direction = direction_map[int(np.argmax(probs))]
    confidence = float(torch.sigmoid(conf).squeeze().numpy())
    expected_return = float(ret.squeeze().numpy())

    return {
        'direction': direction,
        'confidence': round(confidence, 4),
        'expected_return': round(expected_return, 6),
        'prob_up': round(float(probs[2]), 4),
        'prob_down': round(float(probs[0]), 4),
        'prob_neutral': round(float(probs[1]), 4),
        'model': label,
    }


if __name__ == '__main__':
    import json
    result = quick_ml_signal('BTC', '1h', 1)
    print(json.dumps(result, indent=2))
