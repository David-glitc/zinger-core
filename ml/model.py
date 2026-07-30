# Zinger ML — LSTM + RL hybrid architecture

import torch
import torch.nn as nn
import torch.nn.functional as F
import numpy as np

from config import LSTM_HIDDEN, LSTM_LAYERS, DROPOUT, META_EMBED_DIM


class FeatureEncoder(nn.Module):
    """LSTM encoder for time-series features."""

    def __init__(self, input_dim: int, hidden: int = LSTM_HIDDEN, layers: int = LSTM_LAYERS, dropout: float = DROPOUT):
        super().__init__()
        self.lstm = nn.LSTM(
            input_size=input_dim,
            hidden_size=hidden,
            num_layers=layers,
            batch_first=True,
            dropout=dropout if layers > 1 else 0,
            bidirectional=True,
        )
        self.layer_norm = nn.LayerNorm(hidden * 2)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # x: (B, T, D)
        _, (h, _) = self.lstm(x)
        # h: (num_layers * 2, B, hidden) — take last layer, both directions
        h_fwd = h[-2]  # last layer forward
        h_bwd = h[-1]  # last layer backward
        out = torch.cat([h_fwd, h_bwd], dim=-1)  # (B, hidden*2)
        return self.layer_norm(out)


class MetaEncoder(nn.Module):
    """Small MLP for meta-features."""

    def __init__(self, meta_dim: int, embed_dim: int = META_EMBED_DIM):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(meta_dim, embed_dim),
            nn.ReLU(),
            nn.Linear(embed_dim, embed_dim),
            nn.ReLU(),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x)


class ZingerLSTM(nn.Module):
    """Base LSTM model: predicts direction + confidence + expected return."""

    def __init__(self, feat_dim: int, meta_dim: int, num_classes: int = 3):
        super().__init__()
        self.feat_encoder = FeatureEncoder(feat_dim)
        self.meta_encoder = MetaEncoder(meta_dim)
        combined_dim = LSTM_HIDDEN * 2 + META_EMBED_DIM

        self.head = nn.Sequential(
            nn.Linear(combined_dim, 128),
            nn.ReLU(),
            nn.Dropout(DROPOUT),
            nn.Linear(128, 64),
            nn.ReLU(),
        )

        # Direction logits (3 classes: down/neutral/up)
        self.dir_head = nn.Linear(64, num_classes)
        # Confidence score (0-1)
        self.conf_head = nn.Linear(64, 1)
        # Expected return
        self.ret_head = nn.Linear(64, 1)

    def forward(self, feat_seq: torch.Tensor, meta: torch.Tensor) -> tuple:
        """
        Returns:
            dir_logits: (B, 3) — down, neutral, up
            confidence: (B, 1) — sigmoid squashed
            expected_ret: (B, 1)
            latent: (B, 64) — shared latent for RL
        """
        feat_enc = self.feat_encoder(feat_seq)
        meta_enc = self.meta_encoder(meta)
        combined = torch.cat([feat_enc, meta_enc], dim=-1)
        latent = self.head(combined)

        dir_logits = self.dir_head(latent)
        confidence = torch.sigmoid(self.conf_head(latent))
        expected_ret = self.ret_head(latent)

        return dir_logits, confidence, expected_ret, latent

    def predict(self, feat_seq: np.ndarray, meta: np.ndarray) -> dict:
        """Numpy → numpy inference."""
        self.eval()
        with torch.no_grad():
            f = torch.from_numpy(feat_seq).float().unsqueeze(0)  # (1, T, D)
            if meta.ndim == 1:
                m = torch.from_numpy(meta).float().unsqueeze(0).unsqueeze(0)  # (1, 1, M)
            else:
                m = torch.from_numpy(meta).float()
                if m.dim() == 2:
                    pass  # (B, M) — already correct
                else:
                    m = m.squeeze(0)  # (1, M) → (M,) → handled above
            if m.dim() == 3:
                m = m.squeeze(1)  # (B, 1, M) → (B, M)
            logits, conf, ret, _ = self.forward(f, m)
            probs = F.softmax(logits, dim=-1).squeeze(0).numpy()
            direction = int(np.argmax(probs)) - 1  # -1, 0, +1
            confidence = float(conf.squeeze().numpy())
            expected_ret = float(ret.squeeze().numpy())
        return {
            'direction': direction,
            'confidence': min(max(confidence, 0), 1),
            'expected_return': expected_ret,
            'prob_down': float(probs[0]),
            'prob_neutral': float(probs[1]),
            'prob_up': float(probs[2]),
        }


class ZingerActorCritic(nn.Module):
    """Actor-Critic head for RL fine-tuning on top of LSTM latent."""

    def __init__(self, latent_dim: int = 64, action_dim: int = 3):
        super().__init__()
        self.actor = nn.Sequential(
            nn.Linear(latent_dim, 64),
            nn.ReLU(),
            nn.Linear(64, action_dim),
        )
        self.critic = nn.Sequential(
            nn.Linear(latent_dim, 64),
            nn.ReLU(),
            nn.Linear(64, 1),
        )

    def forward(self, latent: torch.Tensor) -> tuple:
        action_logits = self.actor(latent)
        value = self.critic(latent)
        return action_logits, value


# ====== Loss Functions ======

def direction_loss(logits: torch.Tensor, targets: torch.Tensor) -> torch.Tensor:
    """Cross-entropy for direction classification.
    targets: -1, 0, or +1 → shift to 0, 1, 2
    """
    targets_shifted = targets.long() + 1
    return F.cross_entropy(logits, targets_shifted)


def confidence_loss(confidence: torch.Tensor, targets: torch.Tensor) -> torch.Tensor:
    """Confidence should be high when prediction is correct, low otherwise.
    Use binary cross-entropy: target = 1 if correct, 0 if wrong.
    We don't have 'correct' at training time since we predict into the future,
    so this is handled during RL fine-tuning instead.
    For supervised, we use MSE against absolute return magnitude.
    """
    return F.mse_loss(confidence.squeeze(), torch.abs(targets))


def expected_return_loss(pred: torch.Tensor, actual: torch.Tensor) -> torch.Tensor:
    return F.mse_loss(pred.squeeze(), actual)
