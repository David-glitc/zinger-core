import { describe, expect, it } from 'vitest';
import { takerFeeUsdc, roundFeeUsdc, FEE_RATES, FEE_FREE_EXIT_REASONS } from '../../src/polymarket/fees.js';

describe('roundFeeUsdc', () => {
  it('rounds protocol precision and floors dust', () => {
    expect(roundFeeUsdc(0)).toBe(0);
    expect(roundFeeUsdc(-1)).toBe(0);
    expect(roundFeeUsdc(0.000001)).toBe(0);
    expect(roundFeeUsdc(1.234567)).toBe(1.23457);
  });
});

describe('takerFeeUsdc', () => {
  it('returns 0 for invalid inputs', () => {
    expect(takerFeeUsdc(0, 0.5)).toBe(0);
    expect(takerFeeUsdc(10, 0)).toBe(0);
    expect(takerFeeUsdc(10, 1)).toBe(0);
  });

  it('applies crypto curve at mid price', () => {
    // shares * rate * (p*(1-p))^1 = 100 * 0.07 * 0.25 = 1.75
    const fee = takerFeeUsdc(100, 0.5, 'crypto');
    expect(fee).toBeCloseTo(1.75, 5);
    expect(FEE_RATES.crypto).toBe(0.07);
  });

  it('uses inline rate/exponent objects', () => {
    const fee = takerFeeUsdc(10, 0.5, { rate: 0.1, exponent: 1 });
    expect(fee).toBeCloseTo(0.25, 5);
  });

  it('marks settle exits fee-free', () => {
    expect(FEE_FREE_EXIT_REASONS.has('settle')).toBe(true);
    expect(FEE_FREE_EXIT_REASONS.has('redeem')).toBe(true);
  });
});
