// @ts-nocheck
import { useEffect, useState } from 'react';

export const CLOCK_TICK_MS = 16;
export const POLY_POLL_MS = 250;

/** Format milliseconds as M:SS.mmm */
export function fmtCountdownMs(totalMs) {
  if (totalMs == null || Number.isNaN(Number(totalMs))) return '—';
  const ms = Math.max(0, Math.floor(Number(totalMs)));
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  const millis = ms % 1000;
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

/** Back-compat for second-only values from older payloads */
export function fmtCountdown(seconds) {
  if (seconds == null || Number.isNaN(Number(seconds))) return '—';
  return fmtCountdownMs(Math.max(0, Number(seconds)) * 1000);
}

export function remainingMs(endAtMs, fallbackSeconds) {
  if (endAtMs) return Math.max(0, endAtMs - Date.now());
  if (fallbackSeconds != null) return Math.max(0, Number(fallbackSeconds) * 1000);
  return null;
}

/** Re-render ~100×/sec for smooth millisecond clocks */
export function useLiveTick(intervalMs = CLOCK_TICK_MS) {
  const [, bump] = useState(0);
  useEffect(() => {
    const id = setInterval(() => bump((n) => n + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
}

export function LiveCountdown({ endAtMs, fallbackSeconds, fallbackMs, className }) {
  useLiveTick(CLOCK_TICK_MS);
  const ms = endAtMs
    ? remainingMs(endAtMs)
    : fallbackMs != null
      ? Math.max(0, Number(fallbackMs))
      : remainingMs(null, fallbackSeconds);
  return <span className={`poly-clock-ms ${className || ''}`.trim()}>{fmtCountdownMs(ms)}</span>;
}

export function LiveClock({ className }) {
  useLiveTick(250);
  const now = new Date();
  const value = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
  return <span className={className}>{value}</span>;
}

export function LiveUptime({ startedAt, fallbackSeconds, className }) {
  useLiveTick(CLOCK_TICK_MS);
  const ms = startedAt
    ? Math.max(0, Date.now() - startedAt)
    : fallbackSeconds != null
      ? Math.max(0, Number(fallbackSeconds) * 1000)
      : null;
  return <span className={`poly-clock-ms ${className || ''}`.trim()}>{fmtDurationMs(ms)}</span>;
}

export function LiveTimeAgo({ ts, className }) {
  useLiveTick(CLOCK_TICK_MS);
  if (!ts) return <span className={className}>—</span>;
  const delta = Math.max(0, Date.now() - new Date(ts).getTime());
  return <span className={`poly-clock-ms ${className || ''}`.trim()}>{fmtAgoMs(delta)}</span>;
}

export function fmtDurationMs(totalMs) {
  if (totalMs == null || Number.isNaN(Number(totalMs))) return '—';
  const ms = Math.max(0, Math.floor(Number(totalMs)));
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  const millis = ms % 1000;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

export function fmtAgoMs(deltaMs) {
  if (deltaMs == null || Number.isNaN(Number(deltaMs))) return '—';
  const ms = Math.max(0, Math.floor(Number(deltaMs)));
  if (ms < 1000) return `${ms}ms ago`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s ago`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  const millis = ms % 1000;
  return `${minutes}m ${seconds}.${String(millis).padStart(3, '0')}s ago`;
}

export function fmtTimeMs(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  const s = d.getSeconds().toString().padStart(2, '0');
  const ms = d.getMilliseconds().toString().padStart(3, '0');
  return `${h}:${m}:${s}.${ms}`;
}
