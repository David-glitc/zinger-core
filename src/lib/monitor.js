import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createPublicClient, http, formatEther, formatUnits, parseAbi } from 'viem';
import { robinhood } from 'viem/chains';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DATA_DIR = path.join(ROOT, 'data');
const BALANCE_FILE = path.join(DATA_DIR, 'balance-history.json');
const CONFIG_FILE = path.join(DATA_DIR, 'auto-sell-config.json');

const ETH_USD = 1913.36;
const PONS_FACTORY = '0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB';
const factoryAbi = parseAbi(['function getLaunchedToken(address) view returns ((address,address,address,address,uint256,uint256,uint256,uint256,uint256,bool,uint24,bool,uint256))']);
const tokenAbi = parseAbi(['function balanceOf(address) view returns (uint256)', 'function liquidityPool() view returns (address)']);
const slot0Abi = parseAbi(['function slot0() view returns (uint160, int24, uint16, uint16, uint16, uint8, bool)']);

const publicClient = createPublicClient({
  chain: robinhood,
  transport: http('https://rpc.mainnet.chain.robinhood.com', { timeout: 10000 }),
});

export function loadBalanceHistory() {
  try { return JSON.parse(fs.readFileSync(BALANCE_FILE, 'utf-8')); }
  catch { return []; }
}

export function saveBalanceSnapshot(balanceEth) {
  const history = loadBalanceHistory();
  history.push({ time: Date.now(), balance: balanceEth });
  if (history.length > 500) history.splice(0, history.length - 500);
  fs.writeFileSync(BALANCE_FILE, JSON.stringify(history, null, 2));
  return history;
}

export function getBalanceChanges(history) {
  if (history.length < 2) return { change: 0, pct: 0, first: 0, last: 0 };
  const first = history[0].balance;
  const last = history[history.length - 1].balance;
  return { change: last - first, pct: first > 0 ? ((last - first) / first) * 100 : 0, first, last };
}

export function loadAutoSellConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')); }
  catch { return { enabled: false, tpPct: 50, slPct: 25 }; }
}

export function saveAutoSellConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

export async function refreshTokenValue(token) {
  if (!token.tokenAddress || !token.initialBuyAmount) {
    return { ...token, currentValue: 0, price: 0, roi: 0, alive: false };
  }
  try {
    const code = await publicClient.getCode({ address: token.tokenAddress });
    if (!code) return { ...token, currentValue: 0, price: 0, roi: 0, alive: false };

    const info = await publicClient.readContract({
      address: PONS_FACTORY, abi: factoryAbi, functionName: 'getLaunchedToken', args: [token.tokenAddress],
    });
    if (!info || !info[11]) return { ...token, currentValue: 0, price: 0, roi: 0, alive: false };

    const pool = await publicClient.readContract({
      address: token.tokenAddress, abi: tokenAbi, functionName: 'liquidityPool',
    }).catch(() => null);

    let price = 0;
    let currentValue = 0;
    if (pool) {
      const [sqrtPriceX96] = await publicClient.readContract({ address: pool, abi: slot0Abi, functionName: 'slot0' });
      const t0 = await publicClient.readContract({
        address: pool, abi: parseAbi(['function token0() view returns (address)']), functionName: 'token0',
      });
      const isToken0 = token.tokenAddress.toLowerCase() === t0.toLowerCase();
      const ratio = Number(sqrtPriceX96) / 2 ** 96;
      price = isToken0 ? ratio * ratio : 1 / (ratio * ratio);

      const bal = await publicClient.readContract({
        address: token.tokenAddress, abi: tokenAbi, functionName: 'balanceOf', args: [token.wallet || info[1]],
      });
      currentValue = price * Number(formatUnits(bal, 18));
    }

    const spent = token.initialBuyAmount || 0;
    const roi = spent > 0 ? ((currentValue - spent) / spent) * 100 : 0;
    return { ...token, currentValue, price, roi, alive: true, supply: info[8]?.toString() };
  } catch {
    return { ...token, currentValue: token.currentValue || 0, price: 0, roi: 0, alive: false };
  }
}

export async function refreshAllTokens(sessions) {
  const results = [];
  for (const s of sessions) {
    results.push(await refreshTokenValue(s));
  }
  return results;
}

export function calculatePnl(token) {
  const spent = token.initialBuyAmount || 0;
  const currentValue = token.currentValue || 0;
  const netPnl = currentValue - spent;
  const roi = token.roi ?? (spent > 0 ? ((currentValue - spent) / spent) * 100 : 0);
  return { spent, currentValue, totalReturn: currentValue, netPnl, roi };
}

export function formatPnl(pnl) {
  const sign = pnl.netPnl >= 0 ? '+' : '';
  return `${sign}${pnl.netPnl.toFixed(6)} ETH (${sign}${pnl.roi.toFixed(1)}%)`;
}
