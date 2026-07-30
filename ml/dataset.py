# Zinger ML — PyTorch Dataset for sequence forecasting

import numpy as np
import pandas as pd
import torch
from torch.utils.data import Dataset, DataLoader
import gc

from config import TIMEFRAMES, BATCH_SIZE, SEED

torch.manual_seed(SEED)
np.random.seed(SEED)


class TradingDataset(Dataset):
    """Sliding-window sequence dataset for price direction prediction."""

    def __init__(
        self,
        features: np.ndarray,
        meta: np.ndarray,
        targets: np.ndarray,
        seq_len: int,
        pred_horizon: int,
    ):
        self.features = torch.from_numpy(features).float()
        self.meta = torch.from_numpy(meta).float()
        self.targets = torch.from_numpy(targets).float()
        self.seq_len = seq_len
        self.pred_horizon = pred_horizon
        n = len(features)
        self.valid_indices = list(range(seq_len, n - pred_horizon))

    def __len__(self):
        return len(self.valid_indices)

    def __getitem__(self, idx):
        i = self.valid_indices[idx]
        feat_seq = self.features[i - self.seq_len : i]
        meta_now = self.meta[i]
        target = self.targets[i + self.pred_horizon]
        return feat_seq, meta_now, target


def build_dataloader(
    df_features: pd.DataFrame,
    df_meta: pd.DataFrame,
    target_col: str,
    seq_len: int,
    pred_horizon: int,
    batch_size: int = BATCH_SIZE,
    shuffle: bool = True,
    targets_df: pd.DataFrame | None = None,
) -> DataLoader:
    """Build a DataLoader from preprocessed feature/meta DataFrames."""
    features = df_features.values.astype(np.float32)
    meta = df_meta.values.astype(np.float32)
    if targets_df is not None:
        targets = targets_df[target_col].values.astype(np.float32)
    else:
        targets = df_features[target_col].values.astype(np.float32)

    # Drop NaN rows
    valid = ~(np.isnan(features).any(axis=1) | np.isnan(meta).any(axis=1) | np.isnan(targets))
    features = features[valid]
    meta = meta[valid]
    targets = targets[valid]

    ds = TradingDataset(features, meta, targets, seq_len, pred_horizon)
    dl = DataLoader(ds, batch_size=batch_size, shuffle=shuffle, num_workers=0, pin_memory=True)
    return dl, len(ds)


def build_rollout_dataset(
    df_features: pd.DataFrame,
    df_meta: pd.DataFrame,
    target_col: str,
    seq_len: int,
    pred_horizon: int,
) -> tuple:
    """Build a full numpy arrays for RL rollouts (no shuffling)."""
    features = df_features.values.astype(np.float32)
    meta = df_meta.values.astype(np.float32)
    targets = df_features[target_col].values.astype(np.float32)
    valid = ~(np.isnan(features).any(axis=1) | np.isnan(meta).any(axis=1) | np.isnan(targets))
    features = features[valid]
    meta = meta[valid]
    targets = targets[valid]
    n = len(features)
    indices = list(range(seq_len, n - pred_horizon))
    return features, meta, targets, indices
