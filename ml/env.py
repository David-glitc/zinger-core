# Zinger ML — Trading environment with Kelly-aware rewards for RL

import numpy as np
import gymnasium as gym
from gymnasium import spaces
from typing import Optional

from config import SYMBOLS, TIMEFRAMES


class ZingerTradingEnv(gym.Env):
    """
    Gymnasium environment for RL fine-tuning.

    State: LSTM latent vector + meta features + current portfolio state
    Action: {DOWN, NEUTRAL, UP} — direction prediction with confidence
    Reward: Kelly-optimal PnL with penalty for wrong high-confidence calls
    """

    def __init__(
        self,
        features: np.ndarray,
        meta: np.ndarray,
        targets: np.ndarray,
        seq_fn,  # function: (features, start_idx, seq_len) -> seq
        seq_len: int = 64,
        pred_horizon: int = 1,
        kelly_fraction: float = 0.25,
        bankroll_init: float = 100.0,
        fee_pct: float = 0.001,
    ):
        super().__init__()
        self.features = features
        self.meta = meta
        self.targets = targets  # forward returns
        self.seq_fn = seq_fn
        self.seq_len = seq_len
        self.pred_horizon = pred_horizon
        self.kelly_fraction = kelly_fraction
        self.bankroll_init = bankroll_init
        self.fee_pct = fee_pct

        n = len(features)
        self.valid_start = seq_len
        self.valid_end = n - pred_horizon
        self.episode_length = self.valid_end - self.valid_start

        # Action: 0=DOWN, 1=NEUTRAL, 2=UP
        self.action_space = spaces.Discrete(3)
        # Observation: latent (64) + meta (M) + portfolio (3) = ?
        self.observation_space = spaces.Box(-np.inf, np.inf, shape=(1,), dtype=np.float32)

        self.reset()

    def reset(self, seed: Optional[int] = None, options: Optional[dict] = None):
        super().reset(seed=seed)
        self.current_step = self.valid_start
        self.bankroll = self.bankroll_init
        self.position = 0  # -1 (DOWN), 0 (NONE), 1 (UP)
        self.position_size = 0.0
        self.trades = []
        self.entry_price = 0.0
        return self._get_obs(), {}

    def _get_obs(self) -> np.ndarray:
        """Package observation."""
        i = self.current_step
        feat_seq = self.features[i - self.seq_len : i]
        meta_vec = self.meta[i]
        port = np.array([self.bankroll / self.bankroll_init, self.position, self.position_size], dtype=np.float32)
        # Flatten: seq features → we pass to model externally, this is just for gym interface
        obs = np.concatenate([feat_seq.ravel()[-100:], meta_vec, port])
        return obs.astype(np.float32)

    def step(self, action: int):
        """Execute action, return next_state, reward, done, info."""
        i = self.current_step
        actual_return = self.targets[i + self.pred_horizon]
        price_move = actual_return  # return over horizon

        action_map = {0: -1, 1: 0, 2: 1}
        direction = action_map[action]
        reward = 0.0

        if direction != 0 and abs(price_move) > 1e-6:
            # Kelly-optimal bet sizing
            edge = abs(price_move)
            win_prob = 0.5 + edge * 2.5  # rough estimate
            win_prob = min(max(win_prob, 0.05), 0.95)
            loss_prob = 1 - win_prob
            win_loss_ratio = 1.0  # assume 1:1 for simplicity
            kelly_pct = (win_prob * win_loss_ratio - loss_prob) / win_loss_ratio
            kelly_pct = max(0, min(kelly_pct * self.kelly_fraction, 0.5))

            bet_amount = self.bankroll * kelly_pct
            is_correct = (direction * price_move) > 0

            if is_correct:
                gross_return = bet_amount * abs(price_move)
                fee = bet_amount * self.fee_pct
                reward = gross_return - fee
                self.bankroll += gross_return - fee
            else:
                loss = bet_amount * min(abs(price_move), 0.5)
                fee = bet_amount * self.fee_pct
                reward = -loss - fee
                self.bankroll -= loss + fee

        self.bankroll = max(self.bankroll, 0.1)
        self.current_step += 1
        done = self.current_step >= self.valid_end - 1

        info = {
            'bankroll': self.bankroll,
            'direction': direction,
            'price_move': price_move,
            'reward': reward,
            'step': self.current_step,
        }
        return self._get_obs(), reward, done, False, info

    def get_kelly_metrics(self) -> dict:
        """Return performance metrics."""
        wins = len([t for t in self.trades if t > 0])
        if len(self.trades) == 0:
            return {'win_rate': 0, 'avg_win': 0, 'avg_loss': 0, 'kelly': 0, 'sharpe': 0}
        win_rate = wins / len(self.trades)
        winning = [t for t in self.trades if t > 0]
        losing = [t for t in self.trades if t < 0]
        avg_win = np.mean(winning) if winning else 0
        avg_loss = abs(np.mean(losing)) if losing else 0
        ratio = avg_win / max(avg_loss, 1e-6)
        kelly = max(0, (win_rate * ratio - (1 - win_rate)) / max(ratio, 1e-6))
        returns = self.trades
        sharpe = np.mean(returns) / max(np.std(returns), 1e-6) * np.sqrt(252 * 24 * 6) if len(returns) > 1 else 0
        return {'win_rate': win_rate, 'avg_win': avg_win, 'avg_loss': avg_loss, 'kelly': kelly, 'sharpe': sharpe}
