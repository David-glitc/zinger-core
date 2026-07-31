// @ts-nocheck
/**
 * Per-wallet Zinger consumer ledger (paper custody for now).
 * Persists under ZINGER_DATA_DIR / data/pilot_accounts.json
 */
import crypto from 'crypto';
import { createPublicClient, http, parseAbi } from 'viem';
import { polygon } from 'viem/chains';
import { load, persistSync, dataPath } from '../polymarket/persistence.js';
import { getWallet } from '../lib/wallet.js';
import { POLY } from '../polymarket/config.js';
import { processDeposit } from '../polymarket/deposits.js';

const FILE = dataPath('pilot_accounts.json');
const PLATFORM_FEE_RATE = 0.01;
const RPC = process.env.POLYGON_RPC_URL || 'https://polygon-bor.publicnode.com';

const erc20Abi = parseAbi(['function balanceOf(address owner) view returns (uint256)']);

const DEFAULT_RULES = Object.freeze({
  maxPositionPct: 10,
  minConfidence: 0.38,
  minPrice: 0.42,
  maxPrice: 0.68,
  assets: ['BTC', 'ETH'],
  durations: ['5m', '15m'],
  minTpUsd: 5,
});

function emptyStore() {
  return { accounts: {}, updatedAt: Date.now() };
}

export function loadStore() {
  const raw = load(FILE, null);
  if (!raw || typeof raw !== 'object' || !raw.accounts) return emptyStore();
  return raw;
}

function saveStore(store) {
  store.updatedAt = Date.now();
  persistSync(FILE, store);
  return store;
}

export function normalizeAddress(address) {
  const a = String(address || '').toLowerCase().trim();
  if (!/^0x[a-f0-9]{40}$/.test(a)) return null;
  return a;
}

function makeAccountId(wallet) {
  const h = crypto.createHash('sha256').update(`zinger-acct:${wallet}`).digest('hex').slice(0, 12);
  return `za_${h}`;
}

function defaultAccount(wallet, chainId = 137) {
  const now = Date.now();
  return {
    wallet,
    accountId: makeAccountId(wallet),
    chainId: Number(chainId) || 137,
    mode: 'paper',
    createdAt: now,
    cash: 0,
    initialBankroll: 0,
    platformFeesPaid: 0,
    depositedGross: 0,
    withdrawn: 0,
    rules: { ...DEFAULT_RULES },
    session: {
      running: false,
      id: null,
      startedAt: null,
      stoppedAt: null,
    },
    events: [],
    usdcDeposits: [],
    updatedAt: now,
  };
}

function pushEvent(account, type, message, extra = {}) {
  account.events.unshift({
    id: `ev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    type,
    message,
    timestamp: Date.now(),
    ...extra,
  });
  if (account.events.length > 200) account.events.length = 200;
}

export function getPlatformFeeRate() {
  return PLATFORM_FEE_RATE;
}

export function ensureAccount({ address, chainId = 137 } = {}) {
  const wallet = normalizeAddress(address);
  if (!wallet) return { ok: false, error: 'valid Polygon address required' };
  const store = loadStore();
  if (!store.accounts[wallet]) {
    store.accounts[wallet] = defaultAccount(wallet, chainId);
    pushEvent(store.accounts[wallet], 'account', `Trading account ${store.accounts[wallet].accountId} created`);
    store.accounts[wallet].cash = 100;
    store.accounts[wallet].initialBankroll = 100;
    pushEvent(store.accounts[wallet], 'deposit', 'Welcome credit: $100 paper cash deposited', { gross: 100, fee: 0, net: 100 });
    saveStore(store);
  } else if (chainId) {
    store.accounts[wallet].chainId = Number(chainId) || store.accounts[wallet].chainId;
    store.accounts[wallet].updatedAt = Date.now();
    saveStore(store);
  }
  return { ok: true, account: publicAccount(store.accounts[wallet]) };
}

export function getAccount(address) {
  const wallet = normalizeAddress(address);
  if (!wallet) return null;
  const store = loadStore();
  return store.accounts[wallet] ? publicAccount(store.accounts[wallet]) : null;
}

export function setMode(address, mode) {
  const wallet = normalizeAddress(address);
  if (!wallet) return { ok: false, error: 'valid address required' };
  const next = mode === 'live' ? 'live' : 'paper';
  const store = loadStore();
  const acct = store.accounts[wallet] || defaultAccount(wallet);
  acct.mode = next;
  acct.updatedAt = Date.now();
  pushEvent(acct, 'mode', `Mode → ${next.toUpperCase()}`);
  store.accounts[wallet] = acct;
  saveStore(store);
  return { ok: true, account: publicAccount(acct) };
}

export function deposit({ address, amount } = {}) {
  const wallet = normalizeAddress(address);
  const gross = Number(amount);
  if (!wallet) return { ok: false, error: 'valid address required' };
  if (!(gross >= 100 && gross <= 100000)) return { ok: false, error: 'deposit must be 100–100000' };
  const store = loadStore();
  const acct = store.accounts[wallet] || defaultAccount(wallet);
  const fee = Math.round(gross * PLATFORM_FEE_RATE * 100) / 100;
  const net = Math.round((gross - fee) * 100) / 100;
  acct.cash = Math.round((Number(acct.cash) + net) * 100) / 100;
  acct.platformFeesPaid = Math.round((Number(acct.platformFeesPaid) + fee) * 100) / 100;
  acct.depositedGross = Math.round((Number(acct.depositedGross) + gross) * 100) / 100;
  if (!acct.initialBankroll) acct.initialBankroll = net;
  else acct.initialBankroll = Math.round((Number(acct.initialBankroll) + net) * 100) / 100;
  acct.updatedAt = Date.now();
  pushEvent(acct, 'deposit', `Deposit $${gross.toFixed(2)} · fee $${fee.toFixed(2)} (${PLATFORM_FEE_RATE * 100}%) · net $${net.toFixed(2)}`, {
    gross, fee, net,
  });
  store.accounts[wallet] = acct;
  saveStore(store);
  return { ok: true, account: publicAccount(acct), gross, fee, net, feeRate: PLATFORM_FEE_RATE };
}

export function withdraw({ address, amount } = {}) {
  const wallet = normalizeAddress(address);
  const amt = Number(amount);
  if (!wallet) return { ok: false, error: 'valid address required' };
  if (!(amt > 0)) return { ok: false, error: 'amount required' };
  const store = loadStore();
  const acct = store.accounts[wallet];
  if (!acct) return { ok: false, error: 'account not found' };
  if (amt > Number(acct.cash) + 0.001) return { ok: false, error: 'insufficient cash' };
  acct.cash = Math.round((Number(acct.cash) - amt) * 100) / 100;
  acct.withdrawn = Math.round((Number(acct.withdrawn) + amt) * 100) / 100;
  acct.updatedAt = Date.now();
  pushEvent(acct, 'withdraw', `Withdraw $${amt.toFixed(2)}`, { amount: amt });
  store.accounts[wallet] = acct;
  saveStore(store);
  return { ok: true, account: publicAccount(acct) };
}

export function saveRules(address, rules = {}) {
  const wallet = normalizeAddress(address);
  if (!wallet) return { ok: false, error: 'valid address required' };
  const store = loadStore();
  const acct = store.accounts[wallet] || defaultAccount(wallet);
  const next = {
    maxPositionPct: clampNum(rules.maxPositionPct, 1, 25, acct.rules.maxPositionPct),
    minConfidence: clampNum(rules.minConfidence, 0.2, 0.9, acct.rules.minConfidence),
    minPrice: clampNum(rules.minPrice, 0.2, 0.8, acct.rules.minPrice),
    maxPrice: clampNum(rules.maxPrice, 0.3, 0.9, acct.rules.maxPrice),
    minTpUsd: clampNum(rules.minTpUsd, 2, 50, acct.rules.minTpUsd),
    assets: normalizeAssets(rules.assets ?? acct.rules.assets),
    durations: normalizeDurations(rules.durations ?? acct.rules.durations),
  };
  if (next.minPrice >= next.maxPrice) return { ok: false, error: 'min entry must be < max entry' };
  acct.rules = next;
  acct.updatedAt = Date.now();
  pushEvent(acct, 'rules', 'Risk bands updated');
  store.accounts[wallet] = acct;
  saveStore(store);
  return { ok: true, account: publicAccount(acct) };
}

export function startSession(address) {
  const wallet = normalizeAddress(address);
  if (!wallet) return { ok: false, error: 'valid address required' };
  const store = loadStore();
  const acct = store.accounts[wallet];
  if (!acct) return { ok: false, error: 'create account first' };
  if (!(Number(acct.cash) >= 50)) {
    return { ok: false, error: 'deposit at least $50 before starting a session' };
  }
  // Only one running paper session globally for the shared paper engine
  for (const [w, a] of Object.entries(store.accounts)) {
    if (w !== wallet && a.session?.running) {
      a.session.running = false;
      a.session.stoppedAt = Date.now();
      pushEvent(a, 'session', 'Session stopped — another wallet took the paper engine');
    }
  }
  acct.session = {
    running: true,
    id: `ses_${Date.now().toString(36)}`,
    startedAt: Date.now(),
    stoppedAt: null,
  };
  acct.updatedAt = Date.now();
  pushEvent(acct, 'session', `Session ${acct.session.id} started`);
  store.accounts[wallet] = acct;
  saveStore(store);
  return { ok: true, account: publicAccount(acct) };
}

export function stopSession(address) {
  const wallet = normalizeAddress(address);
  if (!wallet) return { ok: false, error: 'valid address required' };
  const store = loadStore();
  const acct = store.accounts[wallet];
  if (!acct) return { ok: false, error: 'account not found' };
  acct.session = {
    ...acct.session,
    running: false,
    stoppedAt: Date.now(),
  };
  acct.updatedAt = Date.now();
  pushEvent(acct, 'session', 'Session stopped');
  store.accounts[wallet] = acct;
  saveStore(store);
  return { ok: true, account: publicAccount(acct) };
}

/** Active paper session (at most one) — drives the public paper executor. */
export function getRunningSession() {
  const store = loadStore();
  for (const acct of Object.values(store.accounts)) {
    if (acct.session?.running) return publicAccount(acct);
  }
  return null;
}

export function syncAccountCash(address, cash) {
  const wallet = normalizeAddress(address);
  if (!wallet || !Number.isFinite(Number(cash))) return;
  const store = loadStore();
  const acct = store.accounts[wallet];
  if (!acct) return;
  acct.cash = Math.round(Number(cash) * 100) / 100;
  acct.updatedAt = Date.now();
  store.accounts[wallet] = acct;
  saveStore(store);
}

export async function confirmUsdcDeposit(address, txHash) {
  const wallet = normalizeAddress(address);
  if (!wallet) return { ok: false, error: 'valid address required' };

  const client = createPublicClient({ chain: polygon, transport: http(RPC, { timeout: 10000 }) });

  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: txHash });
  } catch {
    return { ok: false, error: 'transaction not found', txHash };
  }

  if (!receipt || receipt.status !== 'success') {
    return { ok: false, error: 'transaction not confirmed or failed', txHash };
  }

  const botWallet = getWallet();
  const toAddr = String(receipt.to || '').toLowerCase();
  const expectedAddr = botWallet.address.toLowerCase();

  if (toAddr !== expectedAddr) {
    return { ok: false, error: `tx sent to ${toAddr}, expected ${expectedAddr}`, txHash };
  }

  const transferLog = receipt.logs.find(log => {
    if (String(log.address).toLowerCase() !== POLY.usdc.toLowerCase()) return false;
    const topics = log.topics || [];
    return topics.length >= 3
      && topics[2] === `0x${'0'.repeat(24)}${botWallet.address.slice(2).toLowerCase()}`;
  });

  if (!transferLog) {
    return { ok: false, error: 'no USDC transfer found in tx logs', txHash };
  }

  const usdcAmount = Number(transferLog.data) / 1_000_000;
  if (usdcAmount <= 0) {
    return { ok: false, error: 'zero or invalid USDC amount', txHash };
  }

  const store = loadStore();
  const acct = store.accounts[wallet] || defaultAccount(wallet);

  const already = acct.usdcDeposits?.find(d => d.txHash === txHash);
  if (already) return { ok: true, account: publicAccount(acct), usdcAmount, txHash, alreadyProcessed: true };

  const result = await processDeposit(wallet, usdcAmount, txHash);
  if (!result.ok) {
    return { ok: false, error: `deposit processing failed: ${result.error}`, txHash, usdcAmount };
  }

  const fee = Math.round(usdcAmount * 0.01 * 100) / 100;
  const net = Math.round((usdcAmount - fee) * 100) / 100;

  acct.cash = Math.round((Number(acct.cash) + net) * 100) / 100;
  acct.platformFeesPaid = Math.round((Number(acct.platformFeesPaid) + fee) * 100) / 100;
  acct.depositedGross = Math.round((Number(acct.depositedGross) + usdcAmount) * 100) / 100;
  if (!acct.initialBankroll) acct.initialBankroll = net;
  acct.usdcDeposits = acct.usdcDeposits || [];
  acct.usdcDeposits.unshift({
    txHash,
    from: wallet,
    usdcAmount,
    pUsdAmount: result.pUsdAmount || net,
    fee,
    net,
    swapTx: result.swapTx,
    depositTx: result.depositTx,
    processedAt: Date.now(),
  });
  acct.updatedAt = Date.now();
  pushEvent(acct, 'usdc_deposit',
    `USDC deposit $${usdcAmount.toFixed(2)} → pUSD $${(result.pUsdAmount || net).toFixed(2)} · fee $${fee.toFixed(2)}`,
    { txHash, usdcAmount, pUsdAmount: result.pUsdAmount, swapTx: result.swapTx },
  );
  store.accounts[wallet] = acct;
  saveStore(store);

  return { ok: true, account: publicAccount(acct), usdcAmount, pUsdAmount: result.pUsdAmount, net, fee, txHash, swapTx: result.swapTx, depositTx: result.depositTx };
}

function publicAccount(acct) {
  return {
    wallet: acct.wallet,
    accountId: acct.accountId,
    chainId: acct.chainId,
    mode: acct.mode || 'paper',
    createdAt: acct.createdAt,
    cash: Math.round(Number(acct.cash) * 100) / 100,
    initialBankroll: Math.round(Number(acct.initialBankroll) * 100) / 100,
    platformFeesPaid: Math.round(Number(acct.platformFeesPaid) * 100) / 100,
    depositedGross: Math.round(Number(acct.depositedGross) * 100) / 100,
    withdrawn: Math.round(Number(acct.withdrawn) * 100) / 100,
    rules: { ...DEFAULT_RULES, ...acct.rules },
    session: { ...(acct.session || { running: false }) },
    events: (acct.events || []).slice(0, 40),
    platformFeeRate: PLATFORM_FEE_RATE,
    usdcDeposits: (acct.usdcDeposits || []).slice(0, 20),
    updatedAt: acct.updatedAt,
  };
}

function clampNum(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

function normalizeAssets(assets) {
  if (Array.isArray(assets)) {
    return assets.map((a) => String(a).toUpperCase()).filter((a) => a === 'BTC' || a === 'ETH');
  }
  if (typeof assets === 'string') {
    return assets.split(',').map((a) => a.trim().toUpperCase()).filter((a) => a === 'BTC' || a === 'ETH');
  }
  return ['BTC', 'ETH'];
}

function normalizeDurations(durations) {
  const allowed = new Set(['5m', '15m', '30m', '1h']);
  let list = [];
  if (Array.isArray(durations)) list = durations;
  else if (typeof durations === 'string') list = durations.split(/[,\s]+/);
  const out = [...new Set(list.map((d) => String(d).toLowerCase().replace('60m', '1h')).filter((d) => allowed.has(d)))];
  return out.length ? out : ['5m', '15m'];
}
