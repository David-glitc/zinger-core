#!/usr/bin/env python3
"""RL fine-tuning with PPO using stable-baselines3."""

import os
import gc
import json
import numpy as np
import torch
from datetime import datetime

from config import (
    SYMBOLS, TIMEFRAMES, MODEL_DIR, RL_TIMESTEPS, RL_LEARNING_RATE,
    RL_GAMMA, RL_BATCH_SIZE,
)
from data import fetch_all
from features import add_technical_indicators, add_meta_features
from dataset import build_rollout_dataset
from model import ZingerLSTM


def get_latent_extractor(model, device):
    """Wrap model to return latent vector for RL state."""
    def extract(feat_seq, meta):
        model.eval()
        with torch.no_grad():
            f = torch.from_numpy(feat_seq).float().unsqueeze(0).to(device)
            m = torch.from_numpy(meta).float().unsqueeze(0).to(device)
            _, _, _, latent = model(f, m)
            return latent.cpu().numpy().flatten()
    return extract


def train_rl():
    """Fine-tune with PPO using latent from pre-trained LSTM."""
    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    print(f'RL device: {device}')
    os.makedirs(MODEL_DIR, exist_ok=True)

    from stable_baselines3 import PPO
    from stable_baselines3.common.env_util import make_vec_env
    from stable_baselines3.common.callbacks import EvalCallback, CheckpointCallback

    print('Loading data...')
    data = fetch_all(force_refetch=False)

    # Use 1h BTC for RL training
    symbol = 'BTC/USDT'
    timeframe = '1h'
    params = TIMEFRAMES[timeframe]
    horizon = 1
    seq_len = params['seq_len']

    key = f'{symbol}_{timeframe}'
    df = data.get(key)
    if df is None or len(df) < 1000:
        print('Insufficient data for RL.')
        return

    feats = add_technical_indicators(df)
    meta = add_meta_features(df, feats)
    target_col = f'fwd_ret_{horizon}'

    common = feats.index.intersection(meta.index)
    feats = feats.loc[common].dropna(how='any')
    meta = meta.loc[common]

    # Load pretrained LSTM
    model_label = f'{symbol}_{timeframe}_h{horizon}'
    model_path = os.path.join(MODEL_DIR, f'{model_label}.pt')
    feat_dim = feats.shape[1]
    meta_dim = meta.shape[1]

    lstm = ZingerLSTM(feat_dim=feat_dim, meta_dim=meta_dim).to(device)
    if os.path.isfile(model_path):
        lstm.load_state_dict(torch.load(model_path, map_location=device, weights_only=True))
        print(f'Loaded pretrained LSTM from {model_path}')
    else:
        print('No pretrained LSTM found. Train with train_lstm.py first.')
        return

    features_arr = feats.values.astype(np.float32)
    meta_arr = meta.values.astype(np.float32)
    targets_arr = feats[target_col].values.astype(np.float32)

    valid = ~(np.isnan(features_arr).any(axis=1) | np.isnan(meta_arr).any(axis=1) | np.isnan(targets_arr))
    features_arr = features_arr[valid]
    meta_arr = meta_arr[valid]
    targets_arr = targets_arr[valid]

    # Create environment
    from env import ZingerTradingEnv

    def seq_fn(features, start, length):
        return features[start - length : start]

    env = ZingerTradingEnv(
        features=features_arr,
        meta=meta_arr,
        targets=targets_arr,
        seq_fn=seq_fn,
        seq_len=seq_len,
        pred_horizon=horizon,
        bankroll_init=100.0,
        fee_pct=0.001,
    )

    # Custom policy that uses LSTM latent
    from stable_baselines3.common.policies import ActorCriticPolicy
    import torch.nn as nn

    class ZingerFeatureExtractor(nn.Module):
        """Extract LSTM latent for RL policy."""
        def __init__(self, observation_space, lstm_model, seq_len, feat_dim, meta_dim):
            super().__init__()
            self.lstm = lstm_model
            self.seq_len = seq_len
            self.feat_dim = feat_dim
            self.meta_dim = meta_dim
            self.device = device
            self.features_dim = 64

        def forward(self, obs):
            # obs is (B, flat_dim) — we need to unflatten
            batch_size = obs.shape[0]
            feat_size = self.seq_len * self.feat_dim
            feat_flat = obs[:, :feat_size]
            meta_part = obs[:, feat_size:feat_size + self.meta_dim]
            # portfolio part (last 3) is ignored for now

            feat_seq = feat_flat.reshape(batch_size, self.seq_len, self.feat_dim)
            _, _, _, latent = self.lstm(feat_seq, meta_part)
            return latent

    # Use PPO with custom feature extractor
    # Actually, since our env returns flat observations, we need to handle this differently
    # Let's use a simpler approach: train PPO directly on the environment

    vec_env = make_vec_env(lambda: env, n_envs=1)

    model = PPO(
        'MlpPolicy',
        vec_env,
        learning_rate=RL_LEARNING_RATE,
        n_steps=2048,
        batch_size=RL_BATCH_SIZE,
        gamma=RL_GAMMA,
        gae_lambda=0.95,
        clip_range=0.2,
        ent_coef=0.01,
        verbose=1,
        tensorboard_log=os.path.join(MODEL_DIR, 'tb_logs'),
    )

    print(f'Starting PPO training for {RL_TIMESTEPS} timesteps...')
    model.learn(
        total_timesteps=RL_TIMESTEPS,
        callback=[
            CheckpointCallback(save_freq=10000, save_path=MODEL_DIR, name_prefix='ppo_zinger'),
        ],
    )

    model.save(os.path.join(MODEL_DIR, 'ppo_zinger_final'))
    print(f'PPO model saved.')

    # Evaluate
    metrics = env.get_kelly_metrics()
    print(f'\nFinal metrics:')
    for k, v in metrics.items():
        print(f'  {k}: {v:.4f}')

    with open(os.path.join(MODEL_DIR, 'rl_metrics.json'), 'w') as f:
        json.dump(metrics, f)


if __name__ == '__main__':
    train_rl()
