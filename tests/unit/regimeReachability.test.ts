import { beforeEach, describe, expect, it } from 'vitest';
import {
  REGIME_LIST,
  REGIME_PROFILES,
  detectRegime,
  detectRegimeFromModel,
} from '../../src/ai/governor.js';
import { loadFusionContext } from '../../src/polymarket/signal.js';
import { REGIME_SIGNAL_FILE, loadRegimeSignal } from '../../src/polymarket/regimeSignal.js';
import { saveFileOrStore } from '../../src/polymarket/sqliteStore.js';

/**
 * Every regime must stay *reachable*, not merely defined.
 *
 * Two ways a profile silently dies:
 *
 *   1. The heuristic stops being able to name it. `scalp` is the else-branch, so
 *      it dies if the arb/trend guards ever widen to cover the whole input space.
 *   2. An overlay answers on an axis it cannot see. The jump model is
 *      `n_states=2` — high-vol or not — so if a calm reading is allowed to name
 *      `trend-ride`, then `scalp` becomes unreachable for as long as the ML side
 *      keeps emitting. That regression shipped once; the last case here pins it.
 */

/** Shape `detectRegime` reads: per-asset ADX and ATR%. */
function signalsFor({ adx, atrPct, trend = 'up' }: { adx: number; atrPct: number; trend?: string }) {
  return { btc: { adx: { adx, trend }, volatility: { atrPct } } };
}

function writeSignal(regime: string) {
  saveFileOrStore(REGIME_SIGNAL_FILE, {
    regime,
    highVol: regime === 'high-vol',
    at: new Date().toISOString(),
    flips: 3,
    realizedVol: 0.012,
    calmBaseline: 0.008,
    source: 'statistical-jump-model',
  });
}

describe('INVARIANT: all three regimes stay reachable', () => {
  it('defines exactly the three profiles the bot switches between', () => {
    expect(REGIME_LIST).toEqual(['trend-ride', 'scalp', 'arb-only']);
  });

  it('reaches every profile from the ADX/ATR heuristic alone', () => {
    const reached = new Set([
      // hot volatility → out of directional entirely
      detectRegime({ signals: signalsFor({ adx: 15, atrPct: 0.8 }) }).regime,
      // calm and trending → ride it
      detectRegime({ signals: signalsFor({ adx: 34, atrPct: 0.2 }) }).regime,
      // calm and directionless → scalp the chop
      detectRegime({ signals: signalsFor({ adx: 12, atrPct: 0.2, trend: 'range' }) }).regime,
    ]);
    for (const name of REGIME_LIST) {
      expect(reached, `regime '${name}' is unreachable from the heuristic`).toContain(name);
    }
  });

  it('gives every profile a non-empty overlay', () => {
    for (const name of REGIME_LIST) {
      expect(Object.keys(REGIME_PROFILES[name]).length, `'${name}' overlay is empty`).toBeGreaterThan(0);
    }
  });
});

describe('the jump model overlays risk-on/off without collapsing the regime set', () => {
  beforeEach(() => {
    writeSignal('trend');
  });

  it('reads a fresh signal through the shared store', () => {
    expect(loadRegimeSignal()).not.toBeNull();
  });

  it('forces arb-only when the model reports high volatility', () => {
    writeSignal('high-vol');
    expect(detectRegimeFromModel()?.regime).toBe('arb-only');
  });

  it('names no regime on a calm reading, leaving trend-ride and scalp to ADX', () => {
    // The regression: a two-state model must not answer the trend/chop question.
    const verdict = detectRegimeFromModel();
    expect(verdict).not.toBeNull();
    expect(verdict.regime).toBeNull();
    // …but it must still record that it was consulted.
    expect(verdict.reasons.join(' ')).toMatch(/jump-model/i);
  });

  it('keeps scalp and trend-ride reachable while a fresh calm signal exists', () => {
    const overlay = detectRegimeFromModel();
    const resolve = (signals: unknown) => {
      const base = detectRegime({ signals });
      return overlay?.regime ? overlay.regime : base.regime;
    };
    expect(resolve(signalsFor({ adx: 34, atrPct: 0.2 }))).toBe('trend-ride');
    expect(resolve(signalsFor({ adx: 12, atrPct: 0.2, trend: 'range' }))).toBe('scalp');
  });

  it('feeds the same reading to the alpha fusion, not just the governor', () => {
    // Both consumers must go through regimeSignal.ts. The fusion once called
    // loadRegimeSignal without importing it — inside a bare catch, so it went
    // silently blind while the governor kept working.
    writeSignal('high-vol');
    return loadFusionContext().then((ctx) => {
      expect(ctx, 'alpha fusion is blind to the regime signal').not.toBeNull();
      expect(ctx.btc.regime).toBe('highvol');
      expect(detectRegimeFromModel()?.regime).toBe('arb-only');
    });
  });

  it('ignores a stale reading in both consumers at once', async () => {
    saveFileOrStore(REGIME_SIGNAL_FILE, {
      regime: 'high-vol',
      highVol: true,
      at: new Date(Date.now() - 7 * 3600_000).toISOString(),
      realizedVol: 0.012,
      calmBaseline: 0.008,
    });
    expect(loadRegimeSignal()).toBeNull();
    expect(detectRegimeFromModel()).toBeNull();
    expect(await loadFusionContext()).toBeNull();
  });
});
