// @ts-nocheck
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createPublicClient, createWalletClient, http, formatEther, parseEther, parseAbi, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { robinhood } from 'viem/chains';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const PONS_FACTORY = '0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB';
const PONS_LOCKER = '0x736D76699C26D0d966744cAe304C000d471f7F35';
const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
const SWAP_ROUTER = '0xCaf681a66D020601342297493863E78C959E5cb2';
const LAUNCH_FEE = parseEther('0.0005');
const LAUNCH_CONFIG_ID = 0n;
const DEX_ID = 0n;

const factoryAbi = [
  {
    type: 'function',
    name: 'launchToken',
    inputs: [
      {
        type: 'tuple',
        components: [
          { type: 'string', name: 'name' },
          { type: 'string', name: 'symbol' },
          { type: 'string', name: 'logo' },
          { type: 'string', name: 'description' },
          {
            type: 'tuple',
            components: [
              { type: 'string', name: 'twitter' },
              { type: 'string', name: 'telegram' },
              { type: 'string', name: 'discord' },
              { type: 'string', name: 'website' },
              { type: 'string', name: 'farcaster' },
            ],
            name: 'socials',
          },
          { type: 'address', name: 'feeWallet' },
        ],
        name: 'params',
      },
      { type: 'uint256', name: 'launchConfigId' },
      { type: 'uint256', name: 'dexId' },
      { type: 'bytes32', name: 'salt' },
    ],
    outputs: [{ type: 'address', name: 'token' }],
    stateMutability: 'payable',
  },
  {
    type: 'event',
    name: 'TokenLaunched',
    inputs: [
      { type: 'address', name: 'token', indexed: true },
      { type: 'address', name: 'deployer', indexed: true },
      { type: 'address', name: 'dexFactory', indexed: true },
      { type: 'address', name: 'pairToken' },
      { type: 'address', name: 'pool' },
      { type: 'uint256', name: 'dexId' },
      { type: 'uint256', name: 'launchConfigId' },
      { type: 'uint256', name: 'positionId' },
      { type: 'uint256', name: 'restrictionsEndBlock' },
      { type: 'uint256', name: 'initialBuyAmount' },
    ],
  },
];

function getWallet() {
  const walletFile = path.join(ROOT, 'data', 'wallet.json');
  return JSON.parse(fs.readFileSync(walletFile, 'utf-8'));
}

function randomSalt() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return '0x' + Buffer.from(bytes).toString('hex');
}

export async function launchTokenOnPons({ name, symbol, description, initialBuyAmount, logoUrl }) {
  const wallet = getWallet();
  const account = privateKeyToAccount(wallet.privateKey);

  const publicClient = createPublicClient({
    chain: robinhood,
    transport: http('https://rpc.mainnet.chain.robinhood.com', { timeout: 30000 }),
  });

  const walletClient = createWalletClient({
    chain: robinhood,
    transport: http('https://rpc.mainnet.chain.robinhood.com', { timeout: 30000 }),
  });

  const initialBuyWei = parseEther(String(initialBuyAmount));
  const value = LAUNCH_FEE + initialBuyWei;

  const salt = randomSalt();

  const params = {
    name: name?.substring(0, 30) || 'Token',
    symbol: (symbol || 'TOKEN').substring(0, 8).toUpperCase(),
    logo: logoUrl || '',
    description: description || '',
    socials: { twitter: '', telegram: '', discord: '', website: '', farcaster: '' },
    feeWallet: wallet.address,
  };

  const receipt = await walletClient.writeContract({
    address: PONS_FACTORY,
    abi: factoryAbi,
    functionName: 'launchToken',
    args: [params, LAUNCH_CONFIG_ID, DEX_ID, salt],
    value,
    account,
  });

  const txReceipt = await publicClient.waitForTransactionReceipt({ hash: receipt, timeout: 60000 });

  const tokenLaunchedEventSig = '0xdb51ea9ad51ab453a65a4cb7e60c3cb378c9501bb002609f9f97778fb6c4235a';
  const tokenLaunchedLog = txReceipt.logs.find(
    l => l.address.toLowerCase() === PONS_FACTORY.toLowerCase()
      && l.topics[0] === tokenLaunchedEventSig
  );

  let tokenAddress = null;
  let pool = null;
  let initialBuyWeiActual = 0n;

  if (tokenLaunchedLog) {
    tokenAddress = '0x' + tokenLaunchedLog.topics[1].slice(-40);
    pool = '0x' + tokenLaunchedLog.data.slice(64, 104);
    initialBuyWeiActual = BigInt('0x' + tokenLaunchedLog.data.slice(320, 384));
  }

  const balance = await publicClient.getBalance({ address: wallet.address });

  return {
    name: params.name,
    symbol: params.symbol,
    description: params.description,
    totalSupply: 1000000000,
    tokenAddress,
    pool,
    txHash: receipt,
    initialBuyAmount: Number(formatEther(initialBuyWeiActual)),
    initialBuyWei: initialBuyWeiActual.toString(),
    fee: Number(formatEther(LAUNCH_FEE)),
    valueSent: Number(formatEther(value)),
    balanceAfter: Number(formatEther(balance)),
    success: !!tokenAddress,
  };
}

const swapRouterAbi = [
  {
    type: 'function',
    name: 'exactInputSingle',
    inputs: [{
      type: 'tuple',
      components: [
        { type: 'address', name: 'tokenIn' },
        { type: 'address', name: 'tokenOut' },
        { type: 'uint24', name: 'fee' },
        { type: 'address', name: 'recipient' },
        { type: 'uint256', name: 'amountIn' },
        { type: 'uint256', name: 'amountOutMinimum' },
        { type: 'uint160', name: 'sqrtPriceLimitX96' },
      ],
      name: 'params',
    }],
    outputs: [{ type: 'uint256', name: 'amountOut' }],
    stateMutability: 'nonpayable',
  },
];

const erc20Abi = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);

export async function sellToken({ tokenAddress, pool, amountToSell, sellAll }) {
  const wallet = getWallet();
  const account = privateKeyToAccount(wallet.privateKey);

  const publicClient = createPublicClient({
    chain: robinhood,
    transport: http('https://rpc.mainnet.chain.robinhood.com', { timeout: 30000 }),
  });

  const walletClient = createWalletClient({
    chain: robinhood,
    transport: http('https://rpc.mainnet.chain.robinhood.com', { timeout: 30000 }),
  });

  const decimals = await publicClient.readContract({ address: tokenAddress, abi: erc20Abi, functionName: 'decimals' });
  const balance = await publicClient.readContract({ address: tokenAddress, abi: erc20Abi, functionName: 'balanceOf', args: [wallet.address] });

  let sellAmount;
  if (sellAll) {
    sellAmount = balance;
  } else if (amountToSell) {
    sellAmount = BigInt(Math.floor(Number(amountToSell) * 10 ** Number(decimals)));
  } else {
    sellAmount = balance;
  }

  if (sellAmount <= 0n) throw new Error('Nothing to sell');
  if (sellAmount > balance) sellAmount = balance;

  const approveTx = await walletClient.writeContract({
    address: tokenAddress, abi: erc20Abi, functionName: 'approve',
    args: [SWAP_ROUTER, sellAmount], account,
  });
  await publicClient.waitForTransactionReceipt({ hash: approveTx, timeout: 60000 });

  const sellTx = await walletClient.writeContract({
    address: SWAP_ROUTER,
    abi: swapRouterAbi,
    functionName: 'exactInputSingle',
    args: [{
      tokenIn: tokenAddress,
      tokenOut: WETH,
      fee: 10000,
      recipient: wallet.address,
      amountIn: sellAmount,
      amountOutMinimum: 0n,
      sqrtPriceLimitX96: 0n,
    }],
    account,
  });

  const txReceipt = await publicClient.waitForTransactionReceipt({ hash: sellTx, timeout: 60000 });

  return {
    txHash: sellTx,
    approveHash: approveTx,
    tokenAddress,
    amountIn: sellAmount.toString(),
    block: Number(txReceipt.blockNumber),
    gasUsed: Number(txReceipt.gasUsed),
  };
}

export function loadTransactions() {
  const file = path.join(ROOT, 'data', 'transactions.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch { return []; }
}

export function addTransaction(tx) {
  const txs = loadTransactions();
  txs.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 4), ...tx, timestamp: new Date().toISOString() });
  fs.writeFileSync(path.join(ROOT, 'data', 'transactions.json'), JSON.stringify(txs, null, 2));
  return txs[txs.length - 1];
}

export function getTokenFees() {
  return {
    launchFee: Number(formatEther(LAUNCH_FEE)) + ' ETH',
    poolFeeTier: '1%',
    poolFeeBps: 10000,
    maxWalletBps: 500,
    maxTxBps: 550,
    graduationThreshold: '4.2 ETH',
    restrictionBlocks: 2,
  };
}
