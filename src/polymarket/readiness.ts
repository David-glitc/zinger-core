// @ts-nocheck
import { createPublicClient, http, formatUnits } from 'viem';
import { polygon } from 'viem/chains';
import { getWallet } from '../lib/wallet.js';
import { POLY, POLY_MIN_ORDER_USD } from './config.js';
import { ensureApiKey, getClobBalance, getWalletAddress, getFunderAddress } from './trade.js';
import { resolveDynamicLimits } from './kelly.js';
import { checkGeoblock, getClobProxyUrl, redactProxy } from './proxyEnv.js';

const ERC20_ABI = [{
  inputs: [{ name: 'owner', type: 'address' }],
  name: 'balanceOf',
  outputs: [{ name: '', type: 'uint256' }],
  stateMutability: 'view',
  type: 'function',
}];

let _client;
function getClient() {
  if (!_client) {
    _client = createPublicClient({
      chain: polygon,
      transport: http('https://polygon-bor.publicnode.com', { timeout: 8000 }),
    });
  }
  return _client;
}

async function readDepositWalletOwner(depositWallet) {
  try {
    const data = await getClient().call({ to: depositWallet, data: '0x8da5cb5b' });
    if (!data?.data || data.data.length < 42) return null;
    return `0x${data.data.slice(-40)}`;
  } catch {
    return null;
  }
}

async function fetchDepositPositions(depositWallet) {
  try {
    const res = await fetch(`https://data-api.polymarket.com/positions?user=${depositWallet}`);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export async function checkReadiness(config = {}) {
  const wallet = getWallet();
  const address = wallet.address;
  const depositWallet = wallet.polymarketDepositWallet || null;
  const checks = [];
  let apiReady = false;
  let clobBalance = 0;
  let clobAllowance = 0;
  let onchainUsdc = 0;
  let depositPusd = 0;
  let polyBalance = 0;
  let depositOwner = null;
  let ownerMatches = false;
  let clobError = null;
  let positions = [];
  const geoblock = await checkGeoblock();
  checks.push({
    id: 'geoblock',
    ok: geoblock.ok && !geoblock.blocked,
    detail: geoblock.blocked
      ? `Trading restricted from ${geoblock.country || 'current region'}${geoblock.region ? `/${geoblock.region}` : ''}`
      : (geoblock.ok ? `Trading region allowed (${geoblock.country || 'unknown'})` : `Region check failed: ${geoblock.error || 'unknown error'}`),
  });

  try {
    const creds = await ensureApiKey();
    apiReady = !!creds?.key;
    checks.push({ id: 'api', ok: apiReady, detail: apiReady ? 'CLOB API key derived from wallet' : 'API key missing' });
  } catch (err) {
    checks.push({ id: 'api', ok: false, detail: `API auth failed: ${err.message}` });
  }

  if (depositWallet) {
    depositOwner = await readDepositWalletOwner(depositWallet);
    ownerMatches = !!depositOwner && depositOwner.toLowerCase() === address.toLowerCase();
    checks.push({
      id: 'deposit_owner',
      ok: ownerMatches,
      detail: ownerMatches
        ? `Deposit wallet owned by bot signer ${address.slice(0, 6)}…${address.slice(-4)}`
        : `Deposit wallet owner ${depositOwner?.slice(0, 6)}…${depositOwner?.slice(-4)} ≠ bot ${address.slice(0, 6)}…${address.slice(-4)}`,
    });

    try {
      const bal = await getClient().readContract({
        address: POLY.pUsd,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [depositWallet],
      });
      depositPusd = Number(formatUnits(bal, 6));
      checks.push({
        id: 'deposit_pusd',
        ok: depositPusd > 0,
        detail: `Deposit wallet pUSD $${depositPusd.toFixed(2)} at ${depositWallet.slice(0, 6)}…${depositWallet.slice(-4)}`,
      });
    } catch (err) {
      checks.push({ id: 'deposit_pusd', ok: false, detail: `Deposit pUSD check failed: ${err.message}` });
    }

    positions = await fetchDepositPositions(depositWallet);
    if (positions.length) {
      const openPnl = positions.reduce((sum, p) => sum + Number(p.cashPnl || 0), 0);
      checks.push({
        id: 'open_positions',
        ok: true,
        detail: `${positions.length} open position(s) · unrealized PnL ${openPnl >= 0 ? '+' : ''}$${openPnl.toFixed(2)}`,
      });
    }
  }

  try {
    const bal = await getClobBalance();
    clobBalance = bal.balance;
    clobAllowance = bal.allowance;
    clobError = bal.clobError;
    const effectiveBalance = clobBalance > 0 ? clobBalance : depositPusd;
    checks.push({
      id: 'clob_balance',
      ok: effectiveBalance >= POLY_MIN_ORDER_USD,
      detail: clobError
        ? `CLOB cache $0 (${clobError}) · on-chain pUSD $${depositPusd.toFixed(2)}`
        : `CLOB pUSD $${clobBalance.toFixed(2)} (need $${POLY_MIN_ORDER_USD}+)`,
    });
    checks.push({
      id: 'allowance',
      ok: clobAllowance > 0 || effectiveBalance === 0,
      detail: clobAllowance > 0 ? `Allowance $${clobAllowance.toFixed(2)}` : 'No exchange allowance yet',
    });
  } catch (err) {
    checks.push({ id: 'clob_balance', ok: depositPusd >= POLY_MIN_ORDER_USD, detail: `CLOB balance check failed: ${err.message}` });
  }

  try {
    const bal = await getClient().readContract({
      address: POLY.usdc,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [address],
    });
    onchainUsdc = Number(formatUnits(bal, 6));
    checks.push({
      id: 'wallet_usdc',
      ok: onchainUsdc > 0,
      detail: `Signer wallet USDC $${onchainUsdc.toFixed(2)}`,
    });
  } catch (err) {
    checks.push({ id: 'wallet_usdc', ok: false, detail: `Wallet USDC check failed: ${err.message}` });
  }

  try {
    const bal = await getClient().getBalance({ address });
    polyBalance = Number(formatUnits(bal, 18));
    // CLOB trades via deposit wallet — POL on signer is optional, not a live blocker
    checks.push({
      id: 'gas',
      ok: true,
      detail: polyBalance > 0.01 ? `Signer POL ${polyBalance.toFixed(4)} (optional)` : 'CLOB uses deposit wallet — no POL needed',
    });
  } catch (err) {
    checks.push({ id: 'gas', ok: true, detail: 'Gas check skipped (CLOB path)' });
  }

  const spendable = Math.max(clobBalance, depositPusd);
  const limits = resolveDynamicLimits(config, spendable);
  const minBet = limits.minUsd;
  const maxBet = limits.maxUsd;
  const sizeOk = maxBet >= minBet && minBet >= POLY_MIN_ORDER_USD;
  checks.push({
    id: 'position_size',
    ok: sizeOk,
    detail: config.useKellySizing
      ? `Kelly $${minBet}–$${maxBet} dynamic (${Math.round((config.maxPositionPct ?? 0.4) * 100)}% bankroll)`
      : `Fixed $${minBet}–$${maxBet}`,
  });

  const minRequired = minBet;
  const regionAllowed = geoblock.ok && !geoblock.blocked;
  const clobWorks = apiReady && !clobError;
  const liveReady = (regionAllowed || clobWorks) && apiReady && ownerMatches && spendable >= minRequired && sizeOk && (!clobError || spendable >= minRequired);
  const walletFunded = onchainUsdc >= minRequired || depositPusd >= minRequired;
  const paperReady = true;

  return {
    wallet: address,
    signer: getWalletAddress(),
    funder: getFunderAddress(),
    depositWallet,
    depositOwner,
    ownerMatches,
    clobError,
    geoblock,
    proxy: redactProxy(getClobProxyUrl()),
    openPositions: positions.length,
    positions: positions.slice(0, 10),
    apiReady,
    liveReady,
    walletFunded,
    needsDeposit: walletFunded && spendable < minRequired,
    paperReady,
    clobBalance,
    depositPusd,
    spendableBalance: spendable,
    clobAllowance,
    onchainUsdc,
    polyBalance,
    minOrderUsd: minBet,
    maxOrderUsd: maxBet,
    useKellySizing: !!config.useKellySizing,
    needs: [
      depositWallet && !ownerMatches && `Deposit wallet owner ${depositOwner} is not bot signer ${address} — export that wallet’s private key into Zinger`,
      clobError && `CLOB registry: ${clobError} (website balance may still work)`,
      !apiReady && 'Wallet must sign CLOB API auth (automatic on first live trade)',
      !regionAllowed && clobWorks && `Polymarket region check says blocked (${geoblock.country || 'FR'}) but CLOB API works — live trading allowed`,
      !regionAllowed && !clobWorks && (geoblock.blocked
        ? `Polymarket trading is restricted in ${geoblock.country || 'this region'}`
        : `Unable to verify trading region: ${geoblock.error || 'unknown error'}`),
      spendable < minRequired && `Need $${minRequired}+ trading balance (have $${spendable.toFixed(2)} pUSD)`,
      !sizeOk && `Bet range invalid — min $${minBet} max $${maxBet}`,
    ].filter(Boolean),
    checks,
  };
}
