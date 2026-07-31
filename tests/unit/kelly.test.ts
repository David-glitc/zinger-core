import { beforeEach, describe, expect, it } from 'vitest';
import { computeKellySize, setKellyTradeHistory, getKellyStats } from '../../src/polymarket/kelly.js';

describe('kelly sizing', () => {
  beforeEach(() => {
    setKellyTradeHistory([]);
  });

  it('falls back to confidence scaling with thin history', () => {
    const out = computeKellySize({
      bankroll: 100,
      price: 0.55,
      signalConfidence: 0.6,
      historicalWinRate: 0.55,
      tradeCount: 3,
      minUsd: 1,
      maxUsd: 20,
    });
    expect(out.method).toBe('confidence_scaling');
    expect(out.sizeUsd).toBeGreaterThanOrEqual(1);
    expect(out.sizeUsd).toBeLessThanOrEqual(20);
  });

  it('returns negative_kelly when edge is bad', () => {
    const losses = Array.from({ length: 20 }, () => ({ pnl: -2 }));
    setKellyTradeHistory(losses);
    expect(getKellyStats()?.kelly).toBeLessThanOrEqual(0);

    const out = computeKellySize({
      bankroll: 100,
      price: 0.55,
      signalConfidence: 0.6,
      historicalWinRate: 0.2,
      tradeCount: 20,
      minUsd: 1,
      maxUsd: 20,
    });
    expect(out.method).toBe('negative_kelly');
    expect(out.sizeUsd).toBe(0);
  });

  it('uses kelly when history has positive edge', () => {
    const wins = Array.from({ length: 14 }, () => ({ pnl: 3 }));
    const losses = Array.from({ length: 6 }, () => ({ pnl: -1 }));
    setKellyTradeHistory([...wins, ...losses]);

    const out = computeKellySize({
      bankroll: 100,
      price: 0.55,
      signalConfidence: 0.55,
      historicalWinRate: 0.7,
      tradeCount: 20,
      minUsd: 1,
      maxUsd: 40,
      kellyFraction: 0.25,
      maxPositionPct: 0.4,
    });
    expect(out.method).toBe('kelly');
    expect(out.sizeUsd).toBeGreaterThan(0);
    expect(out.sizeUsd).toBeLessThanOrEqual(40);
  });
});
