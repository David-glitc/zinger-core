// @ts-nocheck
/**
 * The one owner of the jump-model regime signal.
 *
 * `ml/regime_emit.py` fits a two-state statistical jump model and writes its
 * verdict through the shared store under `regime_signal.json`. Two consumers
 * read it — the governor (profile selection) and the alpha fusion (sizing
 * de-risk) — and they must agree on three things: where it lives, when it is
 * too old to trust, and what its labels mean.
 *
 * They previously did not. The governor read through `loadFileOrStore` (sqlite
 * on Node 22) while the emitter wrote a bare JSON file, so the governor was
 * permanently blind; the fusion read that file directly via `process.cwd()`,
 * ignoring `ZINGER_DATA_DIR`. This module exists so there is one answer.
 *
 * The model is `n_states=2`: it reports high volatility or not. It is not a
 * trend/chop classifier and must not be read as one — see `detectRegimeFromModel`.
 */
import { loadFileOrStore } from './sqliteStore.js';
import { dataPath } from './dataDir.js';

/** Store key, resolved through the active data dir like every other store. */
export const REGIME_SIGNAL_FILE = dataPath('regime_signal.json');

/**
 * How old a reading may be before it is ignored entirely.
 *
 * The emitter is driven off 1h candles, so a few hours stale is still
 * informative; a day stale is a signal that the ML side stopped running, and
 * silently de-risking on it forever is worse than falling back to live TA.
 */
export const REGIME_SIGNAL_MAX_AGE_MS = 6 * 3600_000;

/**
 * The raw reading, or null when absent, malformed, or stale.
 * Both consumers go through here so a stale signal can never drive one of them
 * while the other has already given up on it.
 */
export function loadRegimeSignal() {
  const disk = loadFileOrStore(REGIME_SIGNAL_FILE, null);
  if (!disk || typeof disk !== 'object' || !disk.regime) return null;
  const age = Date.now() - new Date(disk.at).getTime();
  if (!Number.isFinite(age) || age > REGIME_SIGNAL_MAX_AGE_MS) return null;
  return disk;
}

/** True when the model reports elevated realized volatility. */
export function isHighVol(signal) {
  return signal?.regime === 'high-vol';
}
