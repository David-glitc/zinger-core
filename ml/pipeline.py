#!/usr/bin/env python3
"""
End-to-end pipeline:
1. Fetch data (uses cache if available)
2. Train LSTM base models
3. Fine-tune with PPO (RL)
4. Export final discriminator config
"""

import os
import sys
import time
import json
import subprocess

from config import MODEL_DIR, SYMBOLS, TIMEFRAMES


def step(msg):
    print(f'\n{"="*60}')
    print(f'  {msg}')
    print(f'{"="*60}')


def train_lstm():
    step('Step 1: Training LSTM base models')
    from train_lstm import train
    train()


def train_rl():
    step('Step 2: RL fine-tuning with PPO')
    from train_rl import train_rl
    train_rl()


def verify_models():
    step('Verifying trained models')
    models = [f for f in os.listdir(MODEL_DIR) if f.endswith('.pt')]
    histories = [f for f in os.listdir(MODEL_DIR) if f.endswith('_history.json')]

    print(f'Models found: {len(models)}')
    for m in sorted(models):
        size_kb = os.path.getsize(os.path.join(MODEL_DIR, m)) / 1024
        print(f'  {m} ({size_kb:.1f} KB)')

    print(f'\nTraining histories: {len(histories)}')
    for h in sorted(histories):
        try:
            with open(os.path.join(MODEL_DIR, h)) as f:
                data = json.load(f)
            best = min(data, key=lambda x: x['val_loss']) if data else {}
            print(f'  {h}: best val_loss={best.get("val_loss", "N/A")}, val_acc={best.get("val_acc", "N/A")}')
        except:
            print(f'  {h}: (unreadable)')


def test_inference():
    step('Step 3: Testing inference')
    from predict import get_discriminator
    import ccxt
    import pandas as pd

    disc = get_discriminator()

    ex = ccxt.binance()
    for tf in ['1m', '5m', '1h']:
        try:
            ohlcv = ex.fetch_ohlcv('BTC/USDT', tf, limit=200)
            df = pd.DataFrame(ohlcv, columns=['timestamp', 'open', 'high', 'low', 'close', 'volume'])
            df['timestamp'] = pd.to_datetime(df['timestamp'], unit='ms', utc=True)
            df.set_index('timestamp', inplace=True)
            disc.update_buffer(df, tf)
        except Exception as e:
            print(f'  Failed to fetch {tf}: {e}')

    ensemble = disc.ensemble_discriminator()
    print(f'\nEnsemble signal: {json.dumps(ensemble, indent=2)}')


def main():
    os.makedirs(MODEL_DIR, exist_ok=True)
    start = time.time()

    phases = sys.argv[1] if len(sys.argv) > 1 else 'all'

    if phases == 'lstm':
        train_lstm()
    elif phases == 'rl':
        train_rl()
    elif phases == 'verify':
        verify_models()
    elif phases == 'test':
        test_inference()
    elif phases == 'all':
        train_lstm()
        train_rl()
        verify_models()
        test_inference()
    else:
        print(f'Usage: python pipeline.py [lstm|rl|verify|test|all]')

    elapsed = time.time() - start
    print(f'\nTotal time: {elapsed/60:.1f} min')


if __name__ == '__main__':
    main()
