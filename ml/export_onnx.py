#!/usr/bin/env python3
"""Export all trained .pt models to ONNX format for Node.js inference."""

import os
import sys
import re
import json
import torch
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from model import ZingerLSTM

MODEL_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data/ml/models')
EXPORT_DIR = os.path.join(MODEL_DIR, 'onnx')
os.makedirs(EXPORT_DIR, exist_ok=True)


class ZingerLSTMOnnxWrapper(torch.nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, feat_seq, meta):
        dir_logits, confidence, expected_ret, _ = self.model(feat_seq, meta)
        probs = torch.softmax(dir_logits, dim=-1)
        return probs, confidence, expected_ret


def parse_model_filename(fname):
    m = re.match(r'([A-Z]+)_USDT_([^_]+)_h(\d+)\.pt', fname)
    if not m:
        return None
    symbol = m.group(1)
    timeframe = m.group(2)
    horizon = int(m.group(3))
    return symbol, timeframe, horizon


def detect_dims(state_dict):
    feat_dim = state_dict['feat_encoder.lstm.weight_ih_l0'].shape[1]
    meta_dim = state_dict['meta_encoder.net.0.weight'].shape[1]
    return feat_dim, meta_dim


def export_model(pt_path):
    fname = os.path.basename(pt_path)
    parsed = parse_model_filename(fname)
    if not parsed:
        print(f'  SKIP: cannot parse {fname}')
        return None

    symbol, timeframe, horizon = parsed
    safe = f'{symbol}_USDT_{timeframe}_h{horizon}'

    state = torch.load(pt_path, map_location='cpu', weights_only=True)
    feat_dim, meta_dim = detect_dims(state)

    seq_len = {'1m': 128, '5m': 96, '1h': 64}.get(timeframe, 64)

    lstm = ZingerLSTM(feat_dim=feat_dim, meta_dim=meta_dim)
    missing, unexpected = lstm.load_state_dict(state, strict=False)
    if unexpected:
        print(f'  WARN: unexpected keys: {unexpected}')
    lstm.eval()

    wrapper = ZingerLSTMOnnxWrapper(lstm)
    dummy_feat = torch.randn(1, seq_len, feat_dim)
    dummy_meta = torch.randn(1, meta_dim)

    onnx_path = os.path.join(EXPORT_DIR, f'{safe}.onnx')

    torch.onnx.export(
        wrapper,
        (dummy_feat, dummy_meta),
        onnx_path,
        input_names=['feat_seq', 'meta'],
        output_names=['probs', 'confidence', 'expected_return'],
        dynamic_axes={'feat_seq': {0: 'batch'}, 'meta': {0: 'batch'}},
        opset_version=18,
    )

    size_kb = round(os.path.getsize(onnx_path) / 1024)
    print(f'  OK: {onnx_path} ({size_kb} KB, feat_dim={feat_dim}, meta_dim={meta_dim})')
    return {'symbol': symbol, 'timeframe': timeframe, 'horizon': horizon,
            'path': onnx_path, 'file': f'{safe}.onnx'}


def main():
    pt_files = sorted([f for f in os.listdir(MODEL_DIR) if f.endswith('.pt')])
    if not pt_files:
        print(f'No .pt files found in {MODEL_DIR}')
        sys.exit(1)

    results = []
    for fname in pt_files:
        pt_path = os.path.join(MODEL_DIR, fname)
        print(f'Exporting {fname}...')
        result = export_model(pt_path)
        if result:
            results.append(result)

    manifest = os.path.join(EXPORT_DIR, 'manifest.json')
    with open(manifest, 'w') as f:
        json.dump(results, f, indent=2)
    print(f'\nDone: {len(results)}/{len(pt_files)} models exported')
    print(f'Manifest: {manifest}')


if __name__ == '__main__':
    main()