import { describe, expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
import { takerFeeUsdc, roundFeeUsdc } from '../../src/polymarket/fees.js';
import { parseSlugWindow, currentWallWindow, marketWindow } from '../../src/polymarket/windows.js';
import { computeKellySize, setKellyTradeHistory } from '../../src/polymarket/kelly.js';
import { issueToken, verifyToken, passwordsMatch } from '../../src/lib/auth.js';

function timeOps(label: string, iterations: number, fn: () => void) {
  // warm-up
  for (let i = 0; i < Math.min(1_000, iterations); i++) fn();
  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const ms = performance.now() - start;
  const opsPerSec = iterations / (ms / 1000);
  return { label, iterations, ms, opsPerSec };
}

function assertBudget(
  result: { label: string; iterations: number; ms: number; opsPerSec: number },
  maxMs: number,
  minOpsPerSec: number,
) {
  // Soft log for CI annotations
  // eslint-disable-next-line no-console
  console.log(
    `[perf] ${result.label}: ${result.iterations} ops in ${result.ms.toFixed(2)}ms` +
      ` (${Math.round(result.opsPerSec).toLocaleString()} ops/s)`,
  );
  expect(result.ms, `${result.label} exceeded ${maxMs}ms`).toBeLessThanOrEqual(maxMs);
  expect(result.opsPerSec, `${result.label} below ${minOpsPerSec} ops/s`).toBeGreaterThanOrEqual(minOpsPerSec);
}

describe('hot-path throughput budgets', () => {
  it('takerFeeUsdc stays fast', () => {
    const prices = [0.12, 0.35, 0.5, 0.62, 0.81];
    let i = 0;
    const result = timeOps('takerFeeUsdc', 200_000, () => {
      takerFeeUsdc(25 + (i % 10), prices[i % prices.length], 'crypto');
      i++;
    });
    // CI runners are noisy; keep budgets loose but meaningful
    assertBudget(result, 2_000, 50_000);
    expect(roundFeeUsdc(1.234567)).toBe(1.23457);
  });

  it('window parsers stay fast', () => {
    const slug = 'btc-updown-5m-1700000000';
    const now = 1_700_000_100_000;
    const result = timeOps('window-parsers', 100_000, () => {
      parseSlugWindow(slug);
      currentWallWindow(300, now);
      marketWindow({ slug, symbol: 'BTC' }, now);
    });
    assertBudget(result, 2_000, 25_000);
  });

  it('kelly sizing stays fast with warm history', () => {
    const wins = Array.from({ length: 14 }, () => ({ pnl: 3 }));
    const losses = Array.from({ length: 6 }, () => ({ pnl: -1 }));
    setKellyTradeHistory([...wins, ...losses]);
    const result = timeOps('computeKellySize', 50_000, () => {
      computeKellySize({
        bankroll: 100,
        price: 0.55,
        signalConfidence: 0.55,
        historicalWinRate: 0.7,
        tradeCount: 20,
        minUsd: 1,
        maxUsd: 40,
      });
    });
    assertBudget(result, 2_000, 10_000);
  });

  it('auth token issue/verify stays fast', () => {
    process.env.AUTH_PASSWORD = 'perf-pass';
    process.env.AUTH_SECRET = 'perf-secret';
    const result = timeOps('auth-issue-verify', 5_000, () => {
      const token = issueToken();
      verifyToken(token);
      passwordsMatch('perf-pass');
    });
    // crypto HMAC is heavier — lower ops floor
    assertBudget(result, 5_000, 500);
  });
});
