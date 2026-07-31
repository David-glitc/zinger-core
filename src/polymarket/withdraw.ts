// @ts-nocheck
import { getFunderAddress } from './trade.js';
import { POLY } from './config.js';

/**
 * Initiate Polymarket bridge withdrawal — returns bridge deposit address.
 * User/bot must transfer pUSD from deposit wallet to bridge address.
 */
export async function initiateWithdraw({ amountUsd, recipient, chainId = '137', tokenAddress = POLY.usdc } = {}) {
  const depositWallet = getFunderAddress();
  if (!depositWallet) throw new Error('No deposit wallet configured');

  const res = await fetch('https://bridge.polymarket.com/withdraw', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      address: depositWallet,
      toChainId: String(chainId),
      toTokenAddress: tokenAddress,
      recipientAddr: recipient || depositWallet,
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Bridge withdraw failed (${res.status}): ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  return {
    depositWallet,
    amountUsd,
    recipient: recipient || depositWallet,
    bridge: data,
    note: 'Transfer pUSD from deposit wallet to the bridge address returned above.',
  };
}
