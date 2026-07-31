import { describe, expect, it } from 'vitest';
import { parseSlugWindow, currentWallWindow, marketWindow } from '../../src/polymarket/windows.js';

describe('parseSlugWindow', () => {
  it('parses btc 5m slug', () => {
    const w = parseSlugWindow('btc-updown-5m-1700000000');
    expect(w).toMatchObject({
      asset: 'BTC',
      duration: '5m',
      windowSec: 300,
      startSec: 1700000000,
      endSec: 1700000300,
    });
  });

  it('normalizes 60m to 1h', () => {
    const w = parseSlugWindow('eth-updown-60m-1700000000');
    expect(w?.duration).toBe('1h');
    expect(w?.windowSec).toBe(3600);
  });

  it('returns null for garbage', () => {
    expect(parseSlugWindow('')).toBeNull();
    expect(parseSlugWindow('not-a-slug')).toBeNull();
  });
});

describe('currentWallWindow', () => {
  it('aligns to wall buckets', () => {
    const nowMs = 1_700_000_123_000;
    const w = currentWallWindow(300, nowMs);
    expect(w.startSec % 300).toBe(0);
    expect(w.endSec - w.startSec).toBe(300);
    expect(w.remainingMs).toBeGreaterThan(0);
    expect(w.remainingMs).toBeLessThanOrEqual(300_000);
  });
});

describe('marketWindow', () => {
  it('prefers slug source', () => {
    const nowMs = 1_700_000_100_000;
    const w = marketWindow({ slug: 'btc-updown-5m-1700000000', symbol: 'BTC' }, nowMs);
    expect(w.source).toBe('slug');
    expect(w.isOpen).toBe(true);
  });
});
