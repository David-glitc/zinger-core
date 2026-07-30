/**
 * Outbound proxy for Polymarket CLOB (geo-unblock).
 *
 * Some VPS regions are geoblocked for new orders. Cloudflare orange-cloud only
 * proxies inbound web traffic — it does NOT change the IP Polymarket sees on
 * order posts. Use a real egress proxy in an allowed region (Ireland/eu-west-1
 * is the documented API-friendly region).
 *
 * Env:
 *   CLOB_PROXY_URL=http://user:pass@host:port
 *   CLOB_PROXY_URL=socks5://user:pass@host:1080
 *   HTTPS_PROXY=... (fallback)
 */
import dns from 'dns';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

// SOCKS5 proxies often reject IPv6 — force IPv4 DNS resolution
dns.setDefaultResultOrder('ipv4first');

let _installed = false;
let _proxyUrl = null;
let _agent = null;

export function getClobProxyUrl() {
  return String(process.env.CLOB_PROXY_URL || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '').trim() || null;
}

export function getClobProxyAgent() {
  installClobProxy();
  return _agent;
}



/** Install axios default agent so @polymarket/clob-client-v2 posts exit via proxy. */
export function installClobProxy() {
  if (_installed) return { ok: true, proxyUrl: redactProxy(_proxyUrl), agent: !!_agent };
  _installed = true;
  _proxyUrl = getClobProxyUrl();
  if (!_proxyUrl) {
    return { ok: false, proxyUrl: null, agent: false, reason: 'no CLOB_PROXY_URL' };
  }
  try {
    const lower = _proxyUrl.toLowerCase();
    _agent = lower.startsWith('socks')
      ? new SocksProxyAgent(_proxyUrl)
      : new HttpsProxyAgent(_proxyUrl);
    // When using a custom agent, disable axios's own proxy resolver.
    axios.defaults.httpAgent = _agent;
    axios.defaults.httpsAgent = _agent;
    axios.defaults.proxy = false;
    return { ok: true, proxyUrl: redactProxy(_proxyUrl), agent: true };
  } catch (err) {
    _agent = null;
    return { ok: false, proxyUrl: redactProxy(_proxyUrl), agent: false, reason: err.message };
  }
}

export function redactProxy(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    if (u.username) u.username = u.username.slice(0, 2) + '***';
    return u.toString();
  } catch {
    return '[invalid-proxy-url]';
  }
}

/**
 * Proxy-aware fetch — uses axios so it rides the same egress proxy as the CLOB
 * SDK. Falls through to native fetch when no proxy. Compatible signature with
 * native fetch (returns { status, ok, json, text }).
 */
let _proxyFetchInstalled = false;
export async function proxyGet(url, opts = {}) {
  if (!_proxyFetchInstalled) { installClobProxy(); _proxyFetchInstalled = true; }
  // AbortSignal.timeout(ms) has no `.timeout` field — axios was hanging forever on a
  // dead SOCKS hop (SYN-SENT). Always pass a numeric axios timeout.
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 8000;
  if (!_proxyUrl) {
    return fetch(url, {
      ...opts,
      signal: opts.signal || AbortSignal.timeout(timeoutMs),
    });
  }
  try {
    const res = await axios.get(url, {
      timeout: timeoutMs,
      responseType: 'arraybuffer',
      validateStatus: () => true,
      signal: opts.signal || AbortSignal.timeout(timeoutMs),
    });
    const ok = res.status >= 200 && res.status < 300;
    const text = async () => new TextDecoder().decode(res.data);
    const json = async () => JSON.parse(new TextDecoder().decode(res.data));
    return { status: res.status, ok, json, text };
  } catch (err) {
    if (err?.name === 'CanceledError' || err?.name === 'AbortError' || err?.code === 'ECONNABORTED') {
      throw new DOMException('aborted', 'AbortError');
    }
    throw err;
  }
}

/** Geoblock from VPS egress (no proxy) — native fetch avoids axios default agent. */
export async function checkGeoblockDirect() {
  try {
    const res = await fetch('https://polymarket.com/api/geoblock', {
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json().catch(() => ({}));
    if (data && typeof data === 'object') {
      return {
        ok: true,
        blocked: !!data.blocked,
        ip: data.ip || null,
        country: data.country || null,
        region: data.region || null,
        viaProxy: false,
        proxy: null,
      };
    }
    return {
      ok: false,
      blocked: true,
      error: 'bad geoblock response',
      viaProxy: false,
      proxy: null,
    };
  } catch (err) {
    return {
      ok: false,
      blocked: true,
      error: err.message?.slice(0, 160) || 'geoblock check failed',
      viaProxy: false,
      proxy: null,
    };
  }
}

/** Geoblock check — uses axios so it rides the same egress proxy as CLOB. */
export async function checkGeoblock() {
  installClobProxy();
  if (!_agent) return checkGeoblockDirect();
  try {
    const { data } = await axios.get('https://polymarket.com/api/geoblock', {
      timeout: 8000,
      validateStatus: () => true,
    });
    if (data && typeof data === 'object') {
      return {
        ok: true,
        blocked: !!data.blocked,
        ip: data.ip || null,
        country: data.country || null,
        region: data.region || null,
        viaProxy: true,
        proxy: redactProxy(_proxyUrl),
      };
    }
    return {
      ok: false,
      blocked: true,
      error: typeof data === 'string' ? data.slice(0, 120) : 'bad geoblock response',
      viaProxy: true,
      proxy: redactProxy(_proxyUrl),
    };
  } catch (err) {
    const direct = await checkGeoblockDirect();
    return {
      ...direct,
      proxyError: err.message?.slice(0, 160) || 'proxy geoblock failed',
      proxy: redactProxy(_proxyUrl),
    };
  }
}

/** Quick proxy health — CLOB time endpoint through configured egress. */
export async function checkProxyHealth() {
  const proxy = getClobProxyUrl();
  if (!proxy) {
    return { ok: false, configured: false, proxy: null, detail: 'no CLOB_PROXY_URL' };
  }
  installClobProxy();
  const started = Date.now();
  try {
    const res = await proxyGet('https://clob.polymarket.com/time', { timeoutMs: 6000 });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      return {
        ok: false,
        configured: true,
        proxy: redactProxy(proxy),
        latencyMs,
        detail: `HTTP ${res.status}`,
      };
    }
    const body = await res.json().catch(() => ({}));
    return {
      ok: true,
      configured: true,
      proxy: redactProxy(proxy),
      latencyMs,
      detail: 'CLOB reachable via proxy',
      serverTime: body?.timestamp ?? body?.time ?? null,
    };
  } catch (err) {
    return {
      ok: false,
      configured: true,
      proxy: redactProxy(proxy),
      latencyMs: Date.now() - started,
      detail: err.message?.slice(0, 160) || 'proxy unreachable',
    };
  }
}
