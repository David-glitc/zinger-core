"""
RL Fuser Environment — batched generation, PPO training.
"""

import numpy as np
import gymnasium as gym
from gymnasium import spaces
from dataclasses import dataclass
from typing import Optional
import json, os, time, torch

@dataclass
class ModelOutput:
    direction: int
    confidence: float
    expected_return: float
    symbol: str
    timeframe: str
    horizon: int

@dataclass
class FuserStep:
    models: list[ModelOutput]
    actual_return: float
    timestamp: int
    regime: dict


class RlFuserEnv(gym.Env):
    """
    Gymnasium env: PPO agent learns to fuse model outputs into a single signal.
    State (24-dim): 6 models × 3 features + 5 regime + 1 last_action
    Action: 0=DOWN, 1=NEUTRAL, 2=UP
    Reward: directional accuracy with magnitude scaling
    """

    def __init__(self, steps: list[FuserStep], kelly_fraction=0.25, fee_pct=0.001):
        super().__init__()
        self.steps = steps
        self.kelly_fraction = kelly_fraction
        self.fee_pct = fee_pct
        self.n_models = 6
        obs_dim = self.n_models * 3 + 5 + 1  # 24
        self.observation_space = spaces.Box(-np.inf, np.inf, shape=(obs_dim,), dtype=np.float32)
        self.action_space = spaces.Discrete(3)
        self.reset()

    def reset(self, seed=None, options=None):
        super().reset(seed=seed)
        self.idx = 0
        self.bankroll = 100.0
        self.trades = []
        self.last_action = 1
        return self._get_obs(), {}

    def _get_obs(self) -> np.ndarray:
        step = self.steps[self.idx]
        parts = []
        for m in step.models:
            parts.extend([m.direction, m.confidence, m.expected_return])
        r = step.regime
        regime_vec = [r.get('regime', 0), r.get('vol_regime', 0),
                      r.get('liq_regime', 0), r.get('rsi_regime', 0),
                      r.get('dir_consistency', 0)]
        parts.extend(regime_vec)
        parts.append(self.last_action / 2.0)
        return np.nan_to_num(np.array(parts, dtype=np.float32), nan=0.0, posinf=1.0, neginf=-1.0)

    def step(self, action: int):
        step = self.steps[self.idx]
        actual_ret = step.actual_return * 100  # scale to %
        action_map = {0: -1, 1: 0, 2: 1}
        direction = action_map[action]
        reward = 0.0

        if direction != 0:
            is_correct = (direction * actual_ret) > 0
            magnitude = min(abs(actual_ret), 5.0)  # cap at 5%
            reward = magnitude if is_correct else -magnitude * 0.8
            self.trades.append(reward)
        else:
            self.trades.append(0.0)

        self.last_action = action
        self.idx += 1
        done = self.idx >= len(self.steps) - 1
        return self._get_obs(), reward, done, False, {
            'bankroll': self.bankroll, 'direction': direction,
            'actual_return': actual_ret, 'reward': reward, 'step': self.idx}

    def get_metrics(self):
        if not self.trades:
            return {'win_rate': 0, 'profit': 0, 'sharpe': 0, 'max_dd': 0}
        wins = [t for t in self.trades if t > 0]
        losses = [t for t in self.trades if t < 0]
        win_rate = len(wins) / max(len(self.trades), 1)
        profit = sum(self.trades)
        avg_w = np.mean(wins) if wins else 0
        avg_l = abs(np.mean(losses)) if losses else 0
        sharpe = np.mean(self.trades) / max(np.std(self.trades), 1e-6) if len(self.trades) > 1 else 0
        cum = np.cumsum(self.trades)
        running_max = np.maximum.accumulate(cum)
        dd = cum - running_max
        max_dd = abs(min(dd)) if len(dd) else 0
        return {
            'trades': len(self.trades), 'win_rate': round(win_rate, 4),
            'profit': round(profit, 4), 'avg_win': round(avg_w, 4),
            'avg_loss': round(avg_l, 4),
            'profit_factor': round(abs(sum(wins) / max(abs(sum(losses)), 1e-6)), 4) if losses else float('inf'),
            'sharpe': round(sharpe, 4), 'max_drawdown': round(max_dd, 4),
            'final_bankroll': round(self.bankroll, 4),
        }


def generate_fuser_steps(data_dir, model_dir, cache_path=None):
    """Batched generation: run each model ONCE on ALL positions."""
    if cache_path and os.path.exists(cache_path):
        return _load_steps(cache_path)

    from features import add_technical_indicators, add_meta_features
    from model import ZingerLSTM
    from config import TIMEFRAMES
    import pandas as pd

    device = torch.device('cpu')
    print('Loading BTC 5m data...', flush=True)
    df_5m = pd.read_parquet(os.path.join(data_dir, 'btc_usdt_5m.parquet'))
    print(f'  {len(df_5m)} rows', flush=True)

    feats_5m = add_technical_indicators(df_5m)
    meta_5m = add_meta_features(df_5m, feats_5m)
    common_5m = feats_5m.index.intersection(meta_5m.index)
    feats_5m_c = feats_5m.loc[common_5m].dropna(how='any').astype(np.float32)
    meta_5m_c = meta_5m.loc[common_5m].astype(np.float32)
    n_5m = len(feats_5m_c)
    print(f'  5m clean: {feats_5m_c.shape}', flush=True)

    print('Loading BTC 1h data...', flush=True)
    df_1h = pd.read_parquet(os.path.join(data_dir, 'btc_usdt_1h.parquet'))
    print(f'  {len(df_1h)} rows', flush=True)
    feats_1h = add_technical_indicators(df_1h)
    meta_1h = add_meta_features(df_1h, feats_1h)
    common_1h = feats_1h.index.intersection(meta_1h.index)
    feats_1h_c = feats_1h.loc[common_1h].dropna(how='any').astype(np.float32)
    meta_1h_c = meta_1h.loc[common_1h].astype(np.float32)
    print(f'  1h clean: {feats_1h_c.shape}', flush=True)

    feat_dim_5m = feats_5m_c.shape[1]
    meta_dim_5m = meta_5m_c.shape[1]

    # Load 6 BTC models
    spec_list = [
        ('5m', 1, 96), ('5m', 3, 96), ('5m', 12, 96),
        ('1h', 1, 64), ('1h', 4, 64), ('1h', 24, 64),
    ]
    models = []
    for tf, h, seq_len in spec_list:
        label = f'BTC/USDT_{tf}_h{h}'.replace('/', '_')
        pt_path = os.path.join(model_dir, f'{label}.pt')
        if not os.path.exists(pt_path):
            print(f'  SKIP {label}', flush=True)
            continue
        lstm = ZingerLSTM(feat_dim=feat_dim_5m, meta_dim=meta_dim_5m)
        lstm.load_state_dict(torch.load(pt_path, map_location='cpu', weights_only=True))
        lstm.eval()
        models.append({'tf': tf, 'h': h, 'seq_len': seq_len, 'model': lstm})
        print(f'  Loaded {label}', flush=True)

    max_seq = max(m['seq_len'] for m in models)
    valid_start = max_seq + 10
    valid_end = n_5m - 150  # leave room for horizons
    n_positions = valid_end - valid_start
    print(f'{n_positions} positions ({valid_start}–{valid_end})', flush=True)

    # Pre-compute all sequences for each model in ONE batch
    feats_5m_np = feats_5m_c.values
    meta_5m_np = meta_5m_c.values
    feats_1h_np = feats_1h_c.values
    meta_1h_np = meta_1h_c.values
    feats_1h_index = feats_1h_c.index

    for m in models:
        tf = m['tf']
        seq_len = m['seq_len']
        lstm = m['model']
        t0 = time.time()

        # Build batch tensors
        all_seqs = []
        all_metas = []
        valid_positions = []

        for i in range(valid_start, valid_end):
            if tf == '5m':
                seq = feats_5m_np[i - seq_len : i]
                met = meta_5m_np[i - 1 : i]  # just the last meta
            else:
                curr_ts = df_5m.index[i]
                mask = feats_1h_index <= curr_ts
                cnt = int(mask.sum())
                if cnt < seq_len + 2:
                    continue
                seq = feats_1h_np[cnt - seq_len : cnt]
                met = meta_1h_np[cnt - 1 : cnt]

            if len(seq) != seq_len or np.isnan(seq).any() or np.isnan(met).any():
                continue
            all_seqs.append(seq[np.newaxis, ...])
            all_metas.append(met)
            valid_positions.append(i)

        if len(all_seqs) == 0:
            m['outputs'] = {}
            print(f'  {tf} h{m["h"]}: 0 valid positions (skipped)', flush=True)
            continue

        # Batch inference
        batch_seq = torch.from_numpy(np.concatenate(all_seqs, axis=0)).float()
        batch_meta = torch.from_numpy(np.concatenate(all_metas, axis=0)).float()

        with torch.no_grad():
            logits, conf, ret, _ = lstm(batch_seq, batch_meta)
            probs = torch.softmax(logits, dim=-1).cpu().numpy()
            conf_vals = torch.sigmoid(conf).cpu().numpy()
            ret_vals = ret.cpu().numpy()

        # Store per-position outputs
        outputs = {}
        for idx, pos in enumerate(valid_positions):
            direction = int(np.argmax(probs[idx])) - 1
            outputs[pos] = ModelOutput(
                direction=direction,
                confidence=min(max(float(conf_vals[idx][0]), 0), 1),
                expected_return=float(ret_vals[idx][0]),
                symbol='BTC',
                timeframe=tf,
                horizon=m['h'],
            )
        m['outputs'] = outputs
        print(f'  {tf} h{m["h"]}: {len(valid_positions)} positions in {time.time()-t0:.1f}s', flush=True)

    # Assemble steps: for each position, collect all model outputs
    print('Assembling steps...', flush=True)
    steps = []
    skipped_low_models = 0
    for i in range(valid_start, valid_end):
        model_outputs = [m['outputs'].get(i) for m in models if i in m.get('outputs', {})]
        model_outputs = [mo for mo in model_outputs if mo is not None]
        if len(model_outputs) < 2:
            skipped_low_models += 1
            continue

        actual_ret = float(df_5m['close'].iloc[i + 1] / df_5m['close'].iloc[i] - 1) if i + 1 < n_5m else 0

        # Regime
        regime = {}
        meta_row = meta_5m_c.iloc[max(0, i - 5) : i]
        if len(meta_row) > 0:
            last = meta_row.iloc[-1]
            regime = {
                'regime': last.get('regime', 0) if isinstance(last.get('regime'), (int, float)) else 0,
                'vol_regime': last.get('vol_regime', 0) if isinstance(last.get('vol_regime'), (int, float)) else 0,
                'liq_regime': last.get('liq_regime', 0) if isinstance(last.get('liq_regime'), (int, float)) else 0,
                'rsi_regime': last.get('rsi_regime', 0) if isinstance(last.get('rsi_regime'), (int, float)) else 0,
                'dir_consistency': 0.0,
            }

        steps.append(FuserStep(
            models=model_outputs,
            actual_return=actual_ret,
            timestamp=int(df_5m.index[i].timestamp()),
            regime=regime,
        ))

    print(f'Generated {len(steps)} steps (skipped {skipped_low_models} positions with <2 models)', flush=True)
    _save_steps(steps, cache_path or os.path.join(data_dir, 'rl_fuser_steps.json'))
    return steps


def _save_steps(steps, path):
    data = [{
        'models': [(m.direction, m.confidence, m.expected_return, m.symbol, m.timeframe, m.horizon) for m in s.models],
        'actual_return': s.actual_return, 'timestamp': s.timestamp, 'regime': s.regime,
    } for s in steps]
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f:
        json.dump(data, f)
    print(f'Saved {len(steps)} steps to {path}', flush=True)


def _load_steps(path):
    with open(path) as f:
        data = json.load(f)
    steps = [FuserStep(
        models=[ModelOutput(*m) for m in d['models']],
        actual_return=d['actual_return'], timestamp=d['timestamp'], regime=d['regime'],
    ) for d in data]
    print(f'Loaded {len(steps)} steps from {path}', flush=True)
    return steps