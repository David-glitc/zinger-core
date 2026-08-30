# Zinger ML — Statistical jump-model regime detector (Bemporad, Breschi, Piga, Boyd 2018;
# regime-switching signal per Shu, Yu, Mulvey 2024).
#
# The textbook HMM regime flip on daily returns is noisy. This reframes regime
# detection as clustering-with-memory:
#   - features: exponentially-weighted downside deviation + Sortino per state
#   - a fixed penalty for every state transition (the "jump")
#   - fit by alternating coordinate descent: (assign states) <-> (recompute state
#     params), with a dynamic-programming step to solve the penalized assignment.
#
# Exposes a scikit-learn-style .fit / .predict, plus .fit_predict that returns the
# state series, the penalty, and diagnostics so callers (backtests, the JS governor)
# can consume stable, slow regime flips.

import numpy as np


def downside_deviation(returns, target=0.0, gamma=1.5, half_life=None):
    """Downside deviation of a returns array toward target with exp weighting."""
    r = np.asarray(returns, dtype=np.float64)
    if half_life:
        lam = np.exp(np.log(0.5) / max(1.0, half_life))
        w = np.power(lam, np.arange(len(r))[::-1])
        w /= w.sum()
    else:
        w = np.ones(len(r)) / max(1, len(r))
    dd = np.sqrt(np.maximum(0.0, np.sum(w * np.maximum(target - r, 0.0) ** gamma)))
    return dd


def sortino(returns, target=0.0, half_life=None):
    r = np.asarray(returns, dtype=np.float64)
    if len(r) == 0:
        return 0.0
    lam = np.exp(np.log(0.5) / max(1.0, half_life)) if half_life else 1.0
    w = np.power(lam, np.arange(len(r))[::-1]) if half_life else np.ones(len(r))
    w /= w.sum()
    dd = np.sqrt(np.maximum(0.0, np.sum(w * np.maximum(target - r, 0.0) ** 2)))
    mean = np.sum(w * r)
    return mean / dd if dd > 0 else (0.0 if mean > 0 else 0.0)


def _assign(dp_cost, n, k, penalty):
    """Viterbi-style assignment minimizing sum of per-point cost + penalty per jump.

    `dp_cost` is a distance-to-center cost, so this is a minimization: each point
    wants its *nearest* center, and the penalty makes switching center expensive
    so the state series stays slow. Maximizing here instead would assign every
    point to the center it is furthest from, inverting the regime labels.
    """
    # dp[i, s] = min cost to assign points 0..i ending in state s
    inf = 1e18
    dp = np.full((n, k), inf, dtype=np.float64)
    arg = np.zeros((n, k), dtype=np.int32)
    dp[0] = dp_cost[0]
    for i in range(1, n):
        best_from = int(np.argmin(dp[i - 1]))
        for s in range(k):
            stay = dp[i - 1, s]
            jump = (dp[i - 1, best_from] + penalty) if k > 1 else inf
            # A jump out of s and back into s is not a jump; `stay` already covers it.
            if jump < stay:
                dp[i, s] = dp_cost[i, s] + jump
                arg[i, s] = best_from
            else:
                dp[i, s] = dp_cost[i, s] + stay
                arg[i, s] = s
    # backtrack
    states = np.zeros(n, dtype=np.int32)
    states[-1] = int(np.argmin(dp[-1]))
    for i in range(n - 1, 0, -1):
        states[i - 1] = arg[i, states[i]]
    return states, float(np.min(dp[-1]))


class StatisticalJumpModel:
    """Two-state regime detector via penalized clustering with memory."""

    def __init__(self, n_states=2, penalty=1.0, half_life=None, n_iter=30, seed=42):
        self.n_states = n_states
        self.penalty = penalty
        self.half_life = half_life
        self.n_iter = n_iter
        self.seed = seed
        self.centers_ = None
        self.samples_ = None
        self.mean_ = None
        self.scale_ = None

    def _feature(self, returns):
        dd = downside_deviation(returns, half_life=self.half_life)
        so = sortino(returns, half_life=self.half_life)
        return np.array([dd, so], dtype=np.float64)

    def _features_matrix(self, returns, win=60):
        """Per-timestep features from a trailing window (causal, walk-forward friendly)."""
        r = np.asarray(returns, dtype=np.float64)
        return np.stack([self._feature(r[max(0, i - win):i + 1]) for i in range(len(r))])

    def _standardize(self, X, fit=False):
        """Z-score the feature columns.

        Downside deviation lives on ~1e-3 while Sortino ranges over ~1e0, so on raw
        units the squared distance is essentially Sortino alone — the volatility
        dimension that defines a "high-vol" regime contributes almost nothing, even
        though the high/low labels are assigned by ordering on it.
        """
        if fit:
            mu = X.mean(axis=0)
            sd = X.std(axis=0)
            sd = np.where(sd < 1e-12, 1.0, sd)
            self.mean_, self.scale_ = mu, sd
        return (X - self.mean_) / self.scale_

    def _cost_matrix(self, Z, centers=None):
        # Z: (n, 2) standardized rows -> (n, k) cost = squared distance to each center
        centers = self.centers_ if centers is None else centers
        n = len(Z)
        C = np.zeros((n, self.n_states))
        for s in range(self.n_states):
            d = Z - centers[s]
            C[:, s] = np.einsum('ij,ij->i', d, d)
        return C

    def fit(self, returns, verbose=False):
        r = np.asarray(returns, dtype=np.float64)
        n = len(r)
        X = self._features_matrix(r)
        Z = self._standardize(X, fit=True)
        rng = np.random.default_rng(self.seed)
        k = self.n_states
        # init centers from sample quantiles of downside-deviation (sorted)
        idx = np.argsort(Z[:, 0])
        centers = np.array([Z[idx[int(i * (n - 1) / (k - 1))]] for i in range(k)])
        centers = centers + rng.normal(0, 1e-6, centers.shape)
        cost = self._cost_matrix(Z, centers=centers)
        states, _ = _assign(cost, n, k, self.penalty)
        for it in range(self.n_iter):
            # M-step: recompute centers per state
            for s in range(k):
                sel = states == s
                if sel.sum() > 0:
                    centers[s] = Z[sel].mean(axis=0)
            cost = self._cost_matrix(Z, centers=centers)
            new_states, best = _assign(cost, n, k, self.penalty)
            if verbose and it % 5 == 0:
                print(f"  iter {it}: cost={best:.4f} flips={(new_states[1:]!=new_states[:-1]).sum()}")
            if np.array_equal(new_states, states):
                states = new_states
                break
            states = new_states
        self.centers_ = centers
        self.samples_ = states
        # state ordering: higher downside-deviation = high-vol regime
        order = np.argsort(self.centers_[:, 0])
        self.high_vol_state = int(order[-1])
        self.low_vol_state = int(order[0])
        self.flips_ = int((states[1:] != states[:-1]).sum())
        # Raw features stay exposed for interpretation; centers live in z-space.
        self.features_ = X
        self.features_z_ = Z
        return self

    def predict(self, returns):
        if self.centers_ is None:
            raise RuntimeError('predict() before fit()')
        r = np.asarray(returns, dtype=np.float64)
        n = len(r)
        Z = self._standardize(self._features_matrix(r))
        C = self._cost_matrix(Z)
        states, _ = _assign(C, n, self.n_states, self.penalty)
        return states

    def fit_predict(self, returns, verbose=False):
        self.fit(returns, verbose=verbose)
        return self.samples_


def label_regime(states, high_vol_state):
    """Map model state indices to a Zinger regime string."""
    out = []
    for s in states:
        if s == high_vol_state:
            out.append('high-vol')
        else:
            out.append('trend')
    return out
