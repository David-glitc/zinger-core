# Zinger ML Signal Engine — Configuration

SYMBOLS = ['BTC/USDT', 'ETH/USDT']
TIMEFRAMES = {
    '1m':   {'limit': 1000,  'years': 0.5,  'seq_len': 128, 'pred_horizons': [1, 5, 15]},
    '5m':   {'limit': 1000,  'years': 2,    'seq_len': 96,  'pred_horizons': [1, 3, 12]},
    '1h':   {'limit': 1000,  'years': 5,    'seq_len': 64,  'pred_horizons': [1, 4, 24]},
}

import os
_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
_DATA_ROOT = os.environ.get('ZINGER_DATA_DIR', os.path.join(_ROOT, 'data'))
DATA_DIR = os.path.join(_DATA_ROOT, 'ml')
MODEL_DIR = os.path.join(DATA_DIR, 'models')

USE_CUDA = True
SEED = 42

# LSTM
LSTM_HIDDEN = 256
LSTM_LAYERS = 3
DROPOUT = 0.25

# Meta-feature embedder
META_EMBED_DIM = 64

# Training
BATCH_SIZE = 256
LR = 1e-4
EPOCHS_LSTM = 100
EARLY_STOP_PATIENCE = 15

# RL
RL_TIMESTEPS = 200_000
RL_LEARNING_RATE = 3e-5
RL_GAMMA = 0.95
RL_BATCH_SIZE = 64

# Prediction windows (seconds)
WINDOWS = {
    'ultra_short': (10, 300),
    'short':       (300, 1500),
    'medium':      (1500, 6000),
}

# Targets
HIT_RATE_SHORT = 0.95   # ultra_short
HIT_RATE_MEDIUM = 0.75  # short/medium
