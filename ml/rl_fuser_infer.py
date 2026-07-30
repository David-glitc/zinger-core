#!/usr/bin/env python3
"""
RL Fuser inference for Polymarket bot.
Takes 12 model outputs → RL policy → fused signal.
"""
import sys, os, json, warnings, traceback
warnings.filterwarnings('ignore')

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import torch
import ccxt
import pandas as pd
from features import add_technical_indicators, add_meta_features
from model import ZingerLSTM
from config import TIMEFRAMES

MODEL_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data/ml/models')
DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data/ml')
MODEL_SPECS = [
    ('5m', 1, 96), ('5m', 3, 96), ('5m', 12, 96),
    ('1h', 1, 64), ('1h', 4, 64), ('1h', 24, 64),
]

device = torch.device('cpu')


def fetch_live_data(symbol='BTC/USDT'):
    ex = ccxt.binance()
    df_5m = pd.DataFrame(ex.fetch_ohlcv(symbol, '5m', limit=500), columns=['timestamp','open','high','low','close','volume'])
    df_5m['timestamp'] = pd.to_datetime(df_5m['timestamp'], unit='ms', utc=True)
    df_5m.set_index('timestamp', inplace=True)
    df_1h = pd.DataFrame(ex.fetch_ohlcv(symbol, '1h', limit=200), columns=['timestamp','open','high','low','close','volume'])
    df_1h['timestamp'] = pd.to_datetime(df_1h['timestamp'], unit='ms', utc=True)
    df_1h.set_index('timestamp', inplace=True)
    return df_5m, df_1h


def run_inference(symbol='BTC/USDT'):
    df_5m, df_1h = fetch_live_data(symbol)

    feats_5m = add_technical_indicators(df_5m)
    meta_5m = add_meta_features(df_5m, feats_5m)
    common_5m = feats_5m.index.intersection(meta_5m.index)
    feats_5m_c = feats_5m.loc[common_5m].dropna(how='any').astype(np.float32)
    meta_5m_c = meta_5m.loc[common_5m].astype(np.float32)

    feats_1h = add_technical_indicators(df_1h)
    meta_1h = add_meta_features(df_1h, feats_1h)
    common_1h = feats_1h.index.intersection(meta_1h.index)
    feats_1h_c = feats_1h.loc[common_1h].dropna(how='any').astype(np.float32)
    meta_1h_c = meta_1h.loc[common_1h].astype(np.float32)

    feat_dim = feats_5m_c.shape[1]
    meta_dim = meta_5m_c.shape[1]

    model_predictions = []
    for tf, h, seq_len in MODEL_SPECS:
        label = f'{symbol}_{tf}_h{h}'.replace('/', '_')
        pt_path = os.path.join(MODEL_DIR, f'{label}.pt')
        if not os.path.exists(pt_path):
            continue

        lstm = ZingerLSTM(feat_dim=feat_dim, meta_dim=meta_dim)
        lstm.load_state_dict(torch.load(pt_path, map_location='cpu', weights_only=True))
        lstm.eval()

        if tf == '5m':
            n = len(feats_5m_c)
            if n < seq_len + 5: continue
            seq = feats_5m_c.values[-seq_len:].astype(np.float32)
            met = meta_5m_c.values[-1:].astype(np.float32)
        else:
            n = len(feats_1h_c)
            if n < seq_len + 5: continue
            # Align 1h: use latest 1h candle
            curr_5m_ts = df_5m.index[-1]
            mask = feats_1h_c.index <= curr_5m_ts
            cnt = int(mask.sum())
            if cnt < seq_len + 2: continue
            seq = feats_1h_c.values[cnt - seq_len : cnt].astype(np.float32)
            met = meta_1h_c.values[cnt - 1 : cnt].astype(np.float32)

        with torch.no_grad():
            f = torch.from_numpy(seq).float().unsqueeze(0)
            mm = torch.from_numpy(met).float()
            logits, conf, ret, _ = lstm(f, mm)
            probs = torch.softmax(logits, dim=-1).squeeze(0).numpy()

        model_predictions.append({
            'timeframe': tf,
            'horizon': h,
            'direction': int(np.argmax(probs)) - 1,
            'confidence': min(max(float(torch.sigmoid(conf).squeeze().numpy()), 0), 1),
            'expected_return': float(ret.squeeze().numpy()),
            'prob_up': float(probs[2]),
            'prob_down': float(probs[0]),
            'prob_neutral': float(probs[1]),
        })

    # Regime features
    regime = {'regime': 0, 'vol_regime': 0, 'liq_regime': 0, 'rsi_regime': 0, 'dir_consistency': 0}
    if len(meta_5m_c) > 0:
        last = meta_5m_c.iloc[-1]
        regime = {
            'regime': float(last.get('regime', 0)) if isinstance(last.get('regime'), (int, float)) else 0,
            'vol_regime': float(last.get('vol_regime', 0)) if isinstance(last.get('vol_regime'), (int, float)) else 0,
            'liq_regime': float(last.get('liq_regime', 0)) if isinstance(last.get('liq_regime'), (int, float)) else 0,
            'rsi_regime': float(last.get('rsi_regime', 0)) if isinstance(last.get('rsi_regime'), (int, float)) else 0,
            'dir_consistency': 0.0,
        }

    # Build RL state vector: 6 models × 3 + 5 regime + 1 last_action = 24
    state_parts = []
    model_count = 0
    for spec in MODEL_SPECS:
        mp = next((p for p in model_predictions if p['timeframe'] == spec[0] and p['horizon'] == spec[1]), None)
        if mp:
            state_parts.extend([mp['direction'], mp['confidence'], mp['expected_return']])
            model_count += 1
        else:
            state_parts.extend([0, 0, 0])
    state_parts.extend([regime['regime'], regime['vol_regime'], regime['liq_regime'],
                        regime['rsi_regime'], regime['dir_consistency'], 0.0])
    state = np.array(state_parts, dtype=np.float32).reshape(1, -1)
    state = np.nan_to_num(state, nan=0.0, posinf=1.0, neginf=-1.0)

    # Load RL policy
    try:
        from stable_baselines3 import PPO
        policy_path = os.path.join(MODEL_DIR, 'rl_fuser_best', 'best_model.zip')
        if os.path.exists(policy_path):
            rl_model = PPO.load(policy_path, device='cpu')
            action, _ = rl_model.predict(state, deterministic=True)
            rl_action = int(action[0])
            rl_direction_map = {0: -1, 1: 0, 2: 1}
            rl_direction = rl_direction_map[rl_action]
            rl_label = {0: 'DOWN', 1: 'NEUTRAL', 2: 'UP'}[rl_action]
        else:
            rl_direction = 0
            rl_label = 'NEUTRAL'
            rl_action = 1
    except Exception as e:
        rl_direction = 0
        rl_label = 'NEUTRAL'
        rl_action = 1

    # Rule-based ensemble (for comparison)
    weighted_dir = 0.0
    total_w = 0.0
    for mp in model_predictions:
        w = {'5m': 1.0, '1h': 0.7}.get(mp['timeframe'], 1.0) * mp['confidence']
        weighted_dir += mp['direction'] * w
        total_w += w
    rule_dir = weighted_dir / max(total_w, 1e-6)
    rule_action = 0 if rule_dir > 0.2 else (2 if rule_dir < -0.2 else 1)
    rule_direction = {0: -1, 1: 0, 2: 1}[rule_action]

    # Confidence: use the RL action's probability or model avg confidence
    conf_values = [mp['confidence'] for mp in model_predictions]
    avg_conf = float(np.mean(conf_values)) if conf_values else 0

    result = {
        'rl_direction': rl_direction,
        'rl_label': rl_label,
        'rl_confidence': round(avg_conf, 4),
        'rl_action': rl_action,
        'rule_direction': rule_direction,
        'rule_label': {0: 'DOWN', 1: 'NEUTRAL', 2: 'UP'}[rule_action],
        'models': model_predictions,
        'model_count': model_count,
        'regime': regime,
        'timestamp': pd.Timestamp.now().isoformat(),
    }
    return result


if __name__ == '__main__':
    symbol = sys.argv[1] if len(sys.argv) > 1 else 'BTC/USDT'
    try:
        result = run_inference(symbol)
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({'error': str(e), 'traceback': traceback.format_exc()}))