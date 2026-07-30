import { createPublicClient, createWalletClient, http, parseAbi } from 'viem';
import { polygon } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { getWallet } from '../lib/wallet.js';
import { POLY } from './config.js';

const RPC = process.env.POLYGON_RPC_URL || 'https://polygon-bor.publicnode.com';
const ZRX_PROXY = '0xDef1C0ded9bec7F1a1670819833240f027b25EfF';

const erc20Abi = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function decimals() view returns (uint8)',
]);

export async function checkUsdcBalance() {
  const wallet = getWallet();
  const client = createPublicClient({ chain: polygon, transport: http(RPC, { timeout: 10000 }) });
  const balance = await client.readContract({
    address: POLY.usdc,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [wallet.address],
  });
  return balance;
}

export async function checkPusdBalance(address) {
  const client = createPublicClient({ chain: polygon, transport: http(RPC, { timeout: 10000 }) });
  const target = address || getWallet().address;
  const balance = await client.readContract({
    address: POLY.pUsd,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [target],
  });
  return balance;
}

export async function swapUsdcToPusd(amountUsdc = 0) {
  const wallet = getWallet();
  const account = privateKeyToAccount(wallet.privateKey);
  const publicClient = createPublicClient({ chain: polygon, transport: http(RPC, { timeout: 15000 }) });
  const walletClient = createWalletClient({ chain: polygon, transport: http(RPC, { timeout: 15000 }) });

  const balance = await publicClient.readContract({
    address: POLY.usdc,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [wallet.address],
  });

  const sellAmount = amountUsdc > 0 ? BigInt(Math.floor(amountUsdc * 1_000_000)) : balance;
  if (sellAmount <= 0n) return { ok: false, error: 'no USDC balance' };

  const allowance = await publicClient.readContract({
    address: POLY.usdc,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [wallet.address, ZRX_PROXY],
  });

  if (allowance < sellAmount) {
    const hash = await walletClient.writeContract({
      address: POLY.usdc,
      abi: erc20Abi,
      functionName: 'approve',
      args: [ZRX_PROXY, sellAmount],
      account,
    });
    await publicClient.waitForTransactionReceipt({ hash });
  }

  const qs = new URLSearchParams({
    sellToken: POLY.usdc,
    buyToken: POLY.pUsd,
    sellAmount: sellAmount.toString(),
    takerAddress: wallet.address,
    slippagePercentage: '0.01',
  });

  const quoteUrl = `https://polygon.api.0x.org/swap/v1/quote?${qs}`;
  const quoteRes = await fetch(quoteUrl, {
    headers: { '0x-api-key': process.env.ZRX_API_KEY || '' },
  });
  if (!quoteRes.ok) {
    const text = await quoteRes.text();
    return { ok: false, error: `0x quote ${quoteRes.status}: ${text.slice(0, 300)}` };
  }

  const quote = await quoteRes.json();
  const tx = await walletClient.sendTransaction({
    to: quote.to,
    data: quote.data,
    value: BigInt(quote.value || 0),
    account,
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
  return {
    ok: true,
    tx: receipt.transactionHash,
    sellAmount,
    buyAmount: BigInt(quote.buyAmount),
    blockNumber: Number(receipt.blockNumber),
  };
}

export async function depositPusdToDepositWallet(depositWallet, amount) {
  const wallet = getWallet();
  const account = privateKeyToAccount(wallet.privateKey);
  const publicClient = createPublicClient({ chain: polygon, transport: http(RPC, { timeout: 15000 }) });
  const walletClient = createWalletClient({ chain: polygon, transport: http(RPC, { timeout: 15000 }) });

  if (!amount) {
    amount = await publicClient.readContract({
      address: POLY.pUsd,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [wallet.address],
    });
  }

  if (amount <= 0n) return { ok: false, error: 'no pUSD balance' };

  const hash = await walletClient.writeContract({
    address: POLY.pUsd,
    abi: erc20Abi,
    functionName: 'transfer',
    args: [depositWallet, amount],
    account,
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  return { ok: true, tx: receipt.transactionHash, amount };
}
