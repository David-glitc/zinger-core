import { createPublicClient, http, formatEther } from 'viem';
import { robinhood } from 'viem/chains';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchTokenOnPons } from './pons.js';
import { saveTokenLogo, getLogoUrl } from './logo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

export async function launchFlashToken({ name, symbol, description, initialBuyPct }) {
  const wallet = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'wallet.json'), 'utf-8'));

  const publicClient = createPublicClient({
    chain: robinhood,
    transport: http('https://rpc.mainnet.chain.robinhood.com', { timeout: 5000 }),
  });
  const balance = await publicClient.getBalance({ address: wallet.address });
  const balanceEth = Number(formatEther(balance));

  let initialBuyAmount;
  if (initialBuyPct != null) {
    const pct = Math.max(1, Math.min(100, Number(initialBuyPct) || 50));
    initialBuyAmount = parseFloat((balanceEth * (pct / 100)).toFixed(6));
  } else {
    initialBuyAmount = 0.0004;
  }

  initialBuyAmount = Math.min(initialBuyAmount, 0.00001);

  const logoPath = saveTokenLogo(name, symbol);
  const logoUrl = getLogoUrl(logoPath);

  const result = await launchTokenOnPons({
    name,
    symbol,
    description,
    initialBuyAmount,
    logoUrl,
  });

  return {
    name,
    symbol: result.symbol,
    description: result.description,
    totalSupply: 1000000000,
    marketCap: 0,
    feeTier: 1,
    initialBuyAmount: result.initialBuyAmount,
    tokenAddress: result.tokenAddress,
    txHash: result.txHash,
    logoUrl,
    raw: JSON.stringify(result),
    feeBreakdown: {
      launchFee: result.fee,
      buyAmount: result.initialBuyAmount,
    },
  };
}
