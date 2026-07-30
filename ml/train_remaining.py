"""Train remaining LSTM models not yet trained."""
import sys, os, gc, torch
sys.path.insert(0, os.path.dirname(__file__))

from data import fetch_all
from features import add_technical_indicators, add_meta_features
from dataset import build_dataloader
from model import ZingerLSTM, direction_loss, expected_return_loss
import torch.optim as optim
from config import MODEL_DIR, LR, EPOCHS_LSTM, EARLY_STOP_PATIENCE, TIMEFRAMES, SYMBOLS

os.makedirs(MODEL_DIR, exist_ok=True)
data = fetch_all(force_refetch=False)

def train_model(symbol, timeframe, data, horizon, seq_len):
    label = f"{symbol}_{timeframe}_h{horizon}".replace("/", "_")
    model_path = os.path.join(MODEL_DIR, f"{label}.pt")
    if os.path.exists(model_path):
        print(f"  EXISTS — {label}")
        return True

    df = data.get(f"{symbol}_{timeframe}")
    if df is None or len(df) < seq_len + horizon + 100:
        print(f"  SKIP (insufficient data) — {label}")
        return False

    feats = add_technical_indicators(df)
    meta = add_meta_features(df, feats)
    targets_df = feats.attrs.get("targets")
    if targets_df is None:
        return False

    common = feats.index.intersection(meta.index)
    feats = feats.loc[common]; meta = meta.loc[common]; targets_df = targets_df.loc[common]
    feats = feats.dropna(how="any"); meta = meta.loc[feats.index]; targets_df = targets_df.loc[feats.index]
    if len(feats) < 200:
        return False

    split_idx = int(len(feats) * 0.85)
    train_loader, n_train = build_dataloader(feats.iloc[:split_idx], meta.iloc[:split_idx], "target_dir_1", seq_len, horizon, targets_df=targets_df.iloc[:split_idx])
    val_loader, n_val = build_dataloader(feats.iloc[split_idx:], meta.iloc[split_idx:], "target_dir_1", seq_len, horizon, shuffle=False, targets_df=targets_df.iloc[split_idx:])
    if n_val == 0:
        print(f"  SKIP (no val) — {label}")
        return False

    print(f"  {label}: train={n_train} val={n_val}")

    model = ZingerLSTM(feat_dim=feats.shape[1], meta_dim=meta.shape[1])
    optimizer = optim.AdamW(model.parameters(), lr=LR, weight_decay=1e-5)
    scheduler = optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=EPOCHS_LSTM)
    best_val_loss = float("inf")
    patience = 0

    for epoch in range(EPOCHS_LSTM):
        model.train()
        train_loss = 0.0
        for feat_seq, meta_b, target in train_loader:
            optimizer.zero_grad()
            logits, conf, ret, _ = model(feat_seq, meta_b)
            loss = direction_loss(logits, target) + 0.3 * expected_return_loss(ret, target)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            train_loss += loss.item()

        model.eval()
        val_loss = 0.0; correct = 0; total = 0
        with torch.no_grad():
            for feat_seq, meta_b, target in val_loader:
                logits, _, _, _ = model(feat_seq, meta_b)
                loss = direction_loss(logits, target)
                val_loss += loss.item()
                preds = logits.argmax(dim=-1) - 1
                correct += (preds == target).sum().item()
                total += target.size(0)

        train_loss /= max(len(train_loader), 1)
        val_loss /= max(len(val_loader), 1)
        acc = correct / max(total, 1)
        scheduler.step()

        if (epoch + 1) % 10 == 0 or val_loss < best_val_loss:
            print(f"    E{epoch+1:3d} train={train_loss:.4f} val={val_loss:.4f} acc={acc:.3f}", end="")
            if val_loss < best_val_loss:
                best_val_loss = val_loss; patience = 0
                torch.save(model.state_dict(), model_path)
                print(" *")
            else:
                patience += 1
                print(f" p{patience}")
                if patience >= EARLY_STOP_PATIENCE:
                    print(f"    Early stop at epoch {epoch+1}")
                    break

    print(f"  OK {label}: best_val_loss={best_val_loss:.4f}")
    return True

for symbol in SYMBOLS:
    for timeframe, params in TIMEFRAMES.items():
        seq_len = params["seq_len"]
        for horizon in params["pred_horizons"]:
            print(f"Training: {symbol} {timeframe} h{horizon}")
            sys.stdout.flush()
            train_model(symbol, timeframe, data, horizon, seq_len)
            gc.collect()

print("All models trained.")
