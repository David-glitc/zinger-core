#!/usr/bin/env python3
"""
RL Fuser: Train PPO agent to optimally fuse 12 model signals.

Usage: python3 ml/train_rl_fuser.py [--generate] [--train] [--eval]
"""

import os, sys, json, time, argparse, warnings
warnings.filterwarnings('ignore')

import numpy as np
import torch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rl_fuser_env import RlFuserEnv, generate_fuser_steps, _save_steps as save_steps, _load_steps as load_steps

from config import DATA_DIR, MODEL_DIR
CACHE_FILE = os.path.join(DATA_DIR, 'rl_fuser_steps.json')

# ── 1. Generate dataset ─────────────────────────────────────────────
def do_generate():
    print('\n━━━ Generating fuser training dataset ━━━\n')
    steps = generate_fuser_steps(DATA_DIR, MODEL_DIR, cache_path=None)
    if len(steps) == 0:
        print('ERROR: No steps generated')
        sys.exit(1)
    save_steps(steps, CACHE_FILE)
    return steps

# ── 2. Rule-based baseline ──────────────────────────────────────────
def rule_baseline(env: RlFuserEnv) -> dict:
    """
    Simulate the current rule-based signal fuser:
    Weighted vote across all models with timeframe weights.
    """
    env.reset()
    done = False
    while not done:
        step = env.steps[env.idx]
        models = step.models

        # Weighted vote (same logic as predict.py ensemble_discriminator)
        weighted_dir = 0.0
        total_w = 0.0
        for m in models:
            w = {'5m': 1.0, '1h': 0.7}.get(m.timeframe, 1.0) * m.confidence
            weighted_dir += m.direction * w
            total_w += w

        final_dir = weighted_dir / max(total_w, 1e-6)
        action = 0  # DOWN
        if final_dir > 0.2:
            action = 2  # UP
        elif abs(final_dir) <= 0.2:
            action = 1  # NEUTRAL

        obs, reward, done, truncated, info = env.step(action)

    return env.get_metrics()


# ── 3. PPO fuser ────────────────────────────────────────────────────
def train_fuser(steps, total_timesteps=50000, seed=42, n_steps_override=None):
    from stable_baselines3 import PPO
    from stable_baselines3.common.callbacks import EvalCallback, StopTrainingOnRewardThreshold
    from stable_baselines3.common.vec_env import DummyVecEnv

    # Split: 80% train, 20% eval (temporal split)
    split = int(len(steps) * 0.8)
    train_steps = steps[:split]
    eval_steps = steps[split:]
    n_steps_override = min(len(train_steps), 1024)

    # Demean returns: subtract the mean of the training period
    # This prevents the degenerate always-UP policy in trending markets
    train_returns = np.array([s.actual_return for s in train_steps])
    mean_ret = np.mean(train_returns)
    print(f'  Mean return: {mean_ret:.6f} (will be subtracted for reward)')
    for s in steps:
        s.actual_return -= mean_ret

    print(f'\n━━━ Training PPO Fuser ━━━\n')
    print(f'  Train steps: {len(train_steps)}')
    print(f'  Eval steps:  {len(eval_steps)}')
    print(f'  Timesteps:   {total_timesteps}')
    print(f'  Obs dim:     {train_steps[0].__class__.__module__}')

    def make_train_env():
        return RlFuserEnv(train_steps)

    def make_eval_env():
        return RlFuserEnv(eval_steps)

    train_vec = DummyVecEnv([make_train_env])
    eval_vec = DummyVecEnv([make_eval_env])

    train_n_steps = n_steps_override or max(len(train_steps), 128)

    model = PPO(
        'MlpPolicy',
        train_vec,
        learning_rate=1e-3,
        n_steps=train_n_steps,
        batch_size=min(32, train_n_steps),
        n_epochs=5,
        gamma=0.95,
        gae_lambda=0.9,
        clip_range=0.3,
        ent_coef=0.1,
        vf_coef=0.5,
        max_grad_norm=0.5,
        verbose=1,
        seed=seed,
        device='cpu',
    )

    # Evaluate baseline first
    print('\n── Baseline (rule-based) ──')
    baseline_env = RlFuserEnv(eval_steps)
    baseline_metrics = rule_baseline(baseline_env)
    for k, v in baseline_metrics.items():
        print(f'  {k}: {v}')

    eval_callback = EvalCallback(
        eval_vec,
        best_model_save_path=os.path.join(MODEL_DIR, 'rl_fuser_best'),
        log_path=os.path.join(MODEL_DIR, 'rl_fuser_logs'),
        eval_freq=max(500, total_timesteps // 20),
        deterministic=True,
        render=False,
        verbose=0,
    )

    print(f'\n── Training ──')
    t0 = time.time()
    model.learn(
        total_timesteps=total_timesteps,
        callback=eval_callback,
        progress_bar=True,
    )
    elapsed = time.time() - t0
    print(f'  Training time: {elapsed:.0f}s')

    # Save final model
    model_path = os.path.join(MODEL_DIR, 'ppo_fuser_final')
    model.save(model_path)
    print(f'  Model saved: {model_path}.zip')

    # Evaluate trained policy
    print(f'\n── RL Fuser (trained) ──')
    rl_env = RlFuserEnv(eval_steps)
    obs, _ = rl_env.reset()
    done = False
    while not done:
        action, _ = model.predict(obs, deterministic=True)
        obs, reward, done, truncated, info = rl_env.step(int(action))
    rl_metrics = rl_env.get_metrics()
    for k, v in rl_metrics.items():
        print(f'  {k}: {v}')

    # Compare
    print(f'\n━━━ Comparison ━━━')
    print(f'  {"Metric":20s} {"Baseline":>12s} {"RL Fuser":>12s} {"Delta":>12s}')
    print(f'  {"─"*56}')
    for k in ['trades', 'win_rate', 'profit', 'sharpe', 'max_drawdown', 'final_bankroll']:
        b = baseline_metrics.get(k, 0)
        r = rl_metrics.get(k, 0)
        delta = r - b if isinstance(r, (int, float)) and isinstance(b, (int, float)) else ''
        if isinstance(delta, float):
            print(f'  {k:20s} {b:>12.4f} {r:>12.4f} {delta:>+12.4f}')
        elif isinstance(delta, int):
            print(f'  {k:20s} {b:>12d} {r:>12d} {delta:>+12d}')
        else:
            print(f'  {k:20s} {b:>12} {r:>12}')

    # Save metrics
    metrics = {
        'baseline': baseline_metrics,
        'rl_fuser': rl_metrics,
        'improvement': {k: rl_metrics.get(k, 0) - baseline_metrics.get(k, 0) for k in baseline_metrics},
        'training_time_s': elapsed,
        'total_timesteps': total_timesteps,
        'train_samples': len(train_steps),
        'eval_samples': len(eval_steps),
    }
    metrics_path = os.path.join(MODEL_DIR, 'rl_fuser_metrics.json')
    with open(metrics_path, 'w') as f:
        json.dump(metrics, f, indent=2, default=str)
    print(f'\n  Metrics saved: {metrics_path}')

    return model, rl_metrics, baseline_metrics


# ── 4. Quick eval ─────────────────────────────────────────────────
def do_eval():
    from stable_baselines3 import PPO

    steps = load_steps(CACHE_FILE)
    if len(steps) == 0:
        print('No cached steps. Run with --generate first.')
        sys.exit(1)

    split = int(len(steps) * 0.8)
    eval_steps = steps[split:]

    model_path = os.path.join(MODEL_DIR, 'ppo_fuser_final.zip')
    if not os.path.exists(model_path):
        print(f'No trained model at {model_path}. Run with --train first.')
        sys.exit(1)

    model = PPO.load(model_path, device='cpu')

    # Baseline
    baseline_env = RlFuserEnv(eval_steps)
    baseline_metrics = rule_baseline(baseline_env)
    print(f'\n── Baseline (rule-based) on {len(eval_steps)} eval steps ──')
    for k, v in baseline_metrics.items():
        print(f'  {k}: {v}')

    # RL
    rl_env = RlFuserEnv(eval_steps)
    obs, _ = rl_env.reset()
    done = False
    while not done:
        action, _ = model.predict(obs, deterministic=True)
        obs, reward, done, truncated, info = rl_env.step(int(action))
    rl_metrics = rl_env.get_metrics()
    print(f'\n── RL Fuser on {len(eval_steps)} eval steps ──')
    for k, v in rl_metrics.items():
        print(f'  {k}: {v}')

    return rl_metrics, baseline_metrics


# ── Main ────────────────────────────────────────────────────────────
if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='RL Fuser for Zinger ML ensemble')
    parser.add_argument('--generate', action='store_true', help='Generate training dataset from all models')
    parser.add_argument('--train', action='store_true', help='Train PPO fuser')
    parser.add_argument('--eval', action='store_true', help='Evaluate trained fuser')
    parser.add_argument('--steps', type=int, default=20000, help='Training timesteps')
    args = parser.parse_args()

    if not (args.generate or args.train or args.eval):
        args.generate = True
        args.train = True
        args.eval = True

    steps = None
    if args.generate or (args.train and not os.path.exists(CACHE_FILE)):
        steps = do_generate()

    if args.train:
        if steps is None:
            steps = load_steps(CACHE_FILE)
        if len(steps) == 0:
            print('No training steps available')
            sys.exit(1)
        train_fuser(steps, total_timesteps=args.steps)

    if args.eval:
        do_eval()