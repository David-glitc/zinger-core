#!/usr/bin/env python3
"""Train the base LSTM model on historical data."""

import os
import gc
import json
import numpy as np
import pandas as pd
import torch
import torch.optim as optim
from torch.utils.data import DataLoader
from datetime import datetime

from config import (
    SYMBOLS, TIMEFRAMES, MODEL_DIR, BATCH_SIZE, LR, EPOCHS_LSTM,
    EARLY_STOP_PATIENCE, LSTM_HIDDEN, LSTM_LAYERS, DROPOUT,
)
from data import fetch_all
from features import add_technical_indicators, add_meta_features
from dataset import build_dataloader
from model import ZingerLSTM, direction_loss, expected_return_loss


def prepare_data(symbol: str, timeframe: str, data: dict, horizon: int, seq_len: int):
    """Prepare feature/meta/target for a single symbol+timeframe."""
    key = f'{symbol}_{timeframe}'
    df = data.get(key)
    if df is None or len(df) < seq_len + horizon + 100:
        return None, None, None, None

    feats = add_technical_indicators(df)
    meta = add_meta_features(df, feats)
    target_col = f'target_dir_{max(1, horizon)}'

    # Align indices
    common = feats.index.intersection(meta.index)
    feats = feats.loc[common]
    meta = meta.loc[common]
    targets_df = feats.attrs.get('targets')
    if targets_df is not None:
        targets_df = targets_df.loc[common]
    feats = feats.dropna(how='any')
    meta = meta.loc[feats.index]
    if targets_df is not None:
        targets_df = targets_df.loc[feats.index]
    return feats, meta, targets_df, target_col


def train_epoch(model, loader, optimizer, device):
    model.train()
    total_loss = 0.0
    n_batches = 0
    for feat_seq, meta, target in loader:
        feat_seq = feat_seq.to(device)
        meta = meta.to(device)
        target = target.to(device)

        optimizer.zero_grad()
        logits, conf, ret, _ = model(feat_seq, meta)

        loss_dir = direction_loss(logits, target)
        loss_ret = expected_return_loss(ret, target)
        loss = loss_dir + 0.3 * loss_ret

        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        optimizer.step()

        total_loss += loss.item()
        n_batches += 1

    return total_loss / max(n_batches, 1)


@torch.no_grad()
def validate(model, loader, device):
    model.eval()
    total_loss = 0.0
    correct = 0
    total = 0
    n_batches = 0
    for feat_seq, meta, target in loader:
        feat_seq = feat_seq.to(device)
        meta = meta.to(device)
        target = target.to(device)

        logits, _, _, _ = model(feat_seq, meta)
        loss = direction_loss(logits, target)
        total_loss += loss.item()

        preds = logits.argmax(dim=-1) - 1
        correct += (preds == target).sum().item()
        total += target.size(0)
        n_batches += 1

    acc = correct / max(total, 1)
    return total_loss / max(n_batches, 1), acc


def train(force_retrain=False):
    import sys
    if '--force' in sys.argv or '-f' in sys.argv:
        force_retrain = True

    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    print(f'Device: {device} | Force re-train: {force_retrain}')
    os.makedirs(MODEL_DIR, exist_ok=True)

    print('Fetching data (use cache if available)...')
    data = fetch_all(force_refetch=False)
    print(f'Data loaded: {list(data.keys())}')

    total_models = len(SYMBOLS) * len(TIMEFRAMES) * sum(len(p['pred_horizons']) for p in TIMEFRAMES.values())
    curr = 0

    for symbol in SYMBOLS:
        for timeframe, params in TIMEFRAMES.items():
            for horizon in params['pred_horizons']:
                curr += 1
                seq_len = params['seq_len']
                label = f'{symbol}_{timeframe}_h{horizon}'.replace('/', '_')
                save_path = os.path.join(MODEL_DIR, f'{label}.pt')
                print(f'\n{"="*60}')
                print(f'[{curr}/{total_models}] Processing: {label} (seq={seq_len}, horizon={horizon})')

                if os.path.exists(save_path) and not force_retrain:
                    print(f'  ✓ SKIP — {label}.pt already trained & saved (pass --force to re-train)')
                    continue

                feats, meta, targets_df, target_col = prepare_data(symbol, timeframe, data, horizon, seq_len)
                if feats is None or targets_df is None:
                    print(f'  SKIP — insufficient data')
                    continue

                feat_dim = feats.shape[1]
                meta_dim = meta.shape[1]

                # Train/val split (chronological with seq_len overlap for validation)
                split_idx = int(len(feats) * 0.85)
                val_start = max(0, split_idx - seq_len)
                train_feats = feats.iloc[:split_idx]
                train_meta = meta.iloc[:split_idx]
                val_feats = feats.iloc[val_start:]
                val_meta = meta.iloc[val_start:]

                # Targets from separate DF
                train_targets = targets_df.iloc[:split_idx]
                val_targets = targets_df.iloc[val_start:]

                train_loader, n_train = build_dataloader(
                    train_feats, train_meta, target_col, seq_len, horizon, shuffle=True, targets_df=train_targets,
                )
                val_loader, n_val = build_dataloader(
                    val_feats, val_meta, target_col, seq_len, horizon, shuffle=False, targets_df=val_targets,
                )
                print(f'  Train samples: {n_train}, Val samples: {n_val}')

                model = ZingerLSTM(feat_dim=feat_dim, meta_dim=meta_dim).to(device)
                optimizer = optim.AdamW(model.parameters(), lr=LR, weight_decay=1e-5)
                scheduler = optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=EPOCHS_LSTM)

                best_val_loss = float('inf')
                best_acc = 0.0
                patience = 0
                history = []

                for epoch in range(EPOCHS_LSTM):
                    train_loss = train_epoch(model, train_loader, optimizer, device)
                    val_loss, val_acc = validate(model, val_loader, device)
                    scheduler.step()

                    history.append({
                        'epoch': epoch + 1,
                        'train_loss': round(train_loss, 4),
                        'val_loss': round(val_loss, 4),
                        'val_acc': round(val_acc, 4),
                    })

                    if (epoch + 1) % 10 == 0 or val_loss < best_val_loss:
                        print(f'  Epoch {epoch+1:3d}/{EPOCHS_LSTM} | train_loss: {train_loss:.4f} | val_loss: {val_loss:.4f} | val_acc: {val_acc:.3f}')

                    if val_loss < best_val_loss:
                        best_val_loss = val_loss
                        best_acc = val_acc
                        patience = 0
                        torch.save(model.state_dict(), os.path.join(MODEL_DIR, f'{label}.pt'))
                    else:
                        patience += 1
                        if patience >= EARLY_STOP_PATIENCE:
                            print(f'  Early stop at epoch {epoch+1}')
                            break

                print(f'  ✓ Best val_loss: {best_val_loss:.4f}, val_acc: {best_acc:.3f}')
                with open(os.path.join(MODEL_DIR, f'{label}_history.json'), 'w') as f:
                    json.dump(history, f)

                # Cleanup
                del model, train_loader, val_loader
                gc.collect()
                torch.cuda.empty_cache()


if __name__ == '__main__':
    train()
