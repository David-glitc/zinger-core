// @ts-nocheck
/**
 * Simple password session auth for the operator terminal.
 * Cookie + Bearer token; HMAC-signed, 30-day expiry.
 */
import crypto from 'crypto';

export const AUTH_COOKIE = 'zinger_session';
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function authPassword() {
  return String(process.env.AUTH_PASSWORD || process.env.ZINGER_PASSWORD || '').trim();
}

function authSecret() {
  const fromEnv = String(process.env.AUTH_SECRET || '').trim();
  if (fromEnv) return fromEnv;
  const pw = authPassword();
  if (!pw) return '';
  return crypto.createHash('sha256').update(`zinger-auth:${pw}`).digest('hex');
}

export function isAuthConfigured() {
  return Boolean(authPassword() && authSecret());
}

export function passwordsMatch(input) {
  const expected = authPassword();
  if (!expected) return false;
  const a = Buffer.from(String(input || ''), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    // still do a compare to reduce timing leaks on length
    crypto.timingSafeEqual(Buffer.alloc(32), Buffer.alloc(32));
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

export function issueToken() {
  const exp = Date.now() + TOKEN_TTL_MS;
  const payload = Buffer.from(JSON.stringify({ v: 1, exp }), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', authSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string' || !authSecret()) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expected = crypto.createHmac('sha256', authSecret()).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data?.exp || Date.now() > Number(data.exp)) return null;
    return data;
  } catch {
    return null;
  }
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  }
  return out;
}

export function extractToken(req) {
  const auth = req.headers?.authorization || '';
  if (auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  const q = req.query?.token || req.query?.auth;
  if (q) return String(q);
  const cookies = parseCookies(req.headers?.cookie);
  return cookies[AUTH_COOKIE] || null;
}

export function cookieOptions({ clear = false } = {}) {
  const secure = String(process.env.SITE_URL || '').startsWith('https');
  const maxAge = clear ? 0 : Math.floor(TOKEN_TTL_MS / 1000);
  const parts = [
    `${AUTH_COOKIE}=${clear ? '' : ''}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (secure) parts.push('Secure');
  return { secure, maxAge, parts };
}

export function setAuthCookie(res, token) {
  const secure = String(process.env.SITE_URL || '').startsWith('https');
  const maxAge = Math.floor(TOKEN_TTL_MS / 1000);
  const bits = [
    `${AUTH_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (secure) bits.push('Secure');
  res.setHeader('Set-Cookie', bits.join('; '));
}

export function clearAuthCookie(res) {
  const secure = String(process.env.SITE_URL || '').startsWith('https');
  const bits = [
    `${AUTH_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ];
  if (secure) bits.push('Secure');
  res.setHeader('Set-Cookie', bits.join('; '));
  res.setHeader('Cache-Control', 'no-store');
}

/** Express middleware — protects /api/* except auth endpoints */
export function requireAuth(req, res, next) {
  if (!isAuthConfigured()) {
    return res.status(503).json({ ok: false, error: 'AUTH_PASSWORD not configured' });
  }
  const token = extractToken(req);
  const session = verifyToken(token);
  if (!session) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  req.auth = session;
  next();
}
