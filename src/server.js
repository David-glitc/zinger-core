import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { getWallet, loadOrCreateWallet } from './lib/wallet.js';
import {
  clearAuthCookie,
  isAuthConfigured,
  issueToken,
  passwordsMatch,
  requireAuth,
  setAuthCookie,
  verifyToken,
  extractToken,
} from './lib/auth.js';
import { generateTokenFromPrompt } from './lib/ai.js';
import { launchFlashToken } from './lib/chain.js';
import { createPublicClient, http, formatEther } from 'viem';
import { polygon } from 'viem/chains';
import fs from 'fs';
import { refreshAllTokens, loadAutoSellConfig, saveAutoSellConfig } from './lib/monitor.js';
import { sellToken, addTransaction, loadTransactions, getTokenFees } from './lib/pons.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

export function getSessions() {
  try { return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8')); }
  catch { return []; }
}

export function addSession(session) {
  const sessions = getSessions();
  sessions.push({ id: Date.now().toString(36), ...session, timestamp: new Date().toISOString() });
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
  return sessions[sessions.length - 1];
}

let sseClients = [];

async function collectStreamData(publicClient, wallet) {
  const balance = await Promise.race([
    publicClient.getBalance({ address: wallet.address }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000)),
  ]);
  const balanceEth = Number(formatEther(balance));

  const sessions = getSessions();
  const refreshed = await refreshAllTokens(sessions);
  const activeTokens = refreshed.filter(s => s.alive && s.initialBuyAmount && (s.currentValue || 0) > 0);
  let totalPnl = 0, totalSpent = 0, totalReturn = 0;
  const tokens = activeTokens.map(s => {
    const spent = s.initialBuyAmount || 0;
    const val = s.currentValue || 0;
    const ret = val + (s.feesCollected || 0);
    totalPnl += ret - spent;
    totalSpent += spent;
    totalReturn += ret;
    return { symbol: s.symbol, name: s.name, tokenAddress: s.tokenAddress, spent, currentValue: val, roi: s.roi || 0, price: s.price || 0, logoUrl: s.logoUrl || null };
  });
  const portfolio = { totalPnl, totalSpent, totalReturn, roi: totalSpent > 0 ? ((totalReturn - totalSpent) / totalSpent) * 100 : 0, activeCount: activeTokens.length };

  const sellConfig = loadAutoSellConfig();
  const txs = loadTransactions().reverse().slice(0, 50);

  return { balance: balanceEth, wallet: wallet.address, portfolio, tokens, sessions: refreshed, sellConfig, transactions: txs, timestamp: Date.now() };
}

function broadcast(clients, data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try { client.res.write(msg); } catch { /* gone */ }
  }
}

import * as poly from './polymarket/index.js';
import { registerPublicAPI } from './api/publicPredictions.js';
import { startSpotPriceStream } from './polymarket/spotPriceHistory.js';

export async function createApp() {
  const app = express();
  app.use(express.json());

  const wallet = loadOrCreateWallet();

  const publicClient = createPublicClient({
    chain: polygon,
    transport: http('https://polygon-bor.publicnode.com', { timeout: 5000 }),
  });

  // Kick chart ticks + ML ladder even when bot is stopped
  try { poly.startBackgroundFeeds(); } catch (err) {
    console.error('background feeds:', err?.message || err);
  }

  // Start real-time spot price feed via Binance WS
  try { startSpotPriceStream(); } catch (err) {
    console.error('spot price stream:', err?.message || err);
  }

  // Timeout middleware
  app.use((req, res, next) => {
    // ML / chart sample can take longer
    const long = req.path.startsWith('/api/poly/charts') || req.path.startsWith('/api/poly/ml');
    res.setTimeout(long ? 90000 : 25000, () => {
      if (!res.headersSent) res.status(503).json({ error: 'timeout' });
    });
    next();
  });

  // --- Auth (public) ---
  app.get('/api/auth/status', (req, res) => {
    const configured = isAuthConfigured();
    const session = configured ? verifyToken(extractToken(req)) : null;
    res.json({
      ok: true,
      configured,
      authenticated: Boolean(session),
      expiresAt: session?.exp || null,
    });
  });

  app.post('/api/auth/login', (req, res) => {
    if (!isAuthConfigured()) {
      return res.status(503).json({ ok: false, error: 'AUTH_PASSWORD not configured' });
    }
    const password = req.body?.password ?? req.body?.pass ?? '';
    if (!passwordsMatch(password)) {
      return res.status(401).json({ ok: false, error: 'invalid password' });
    }
    const token = issueToken();
    setAuthCookie(res, token);
    res.json({ ok: true, authenticated: true });
  });

  app.post('/api/auth/logout', (req, res) => {
    clearAuthCookie(res);
    res.json({ ok: true, authenticated: false });
  });

  // Public V1 API — predictions, markets, spot charts, target price (no auth)
  registerPublicAPI(app, (opts) => poly.getState(opts));

  // Protect all other /api routes (cookie works for EventSource same-origin)
  app.use('/api', (req, res, next) => {
    if (req.path.startsWith('/auth/')) return next();
    return requireAuth(req, res, next);
  });

  // --- API Routes ---

  app.get('/api/status', async (req, res) => {
    try {
      const balance = await Promise.race([
        publicClient.getBalance({ address: wallet.address }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('RPC timeout')), 5000)),
      ]);
      const polBalance = await publicClient.getBalance({ address: wallet.address }).catch(() => 0n);
      res.json({
        address: wallet.address,
        balance: formatEther(balance),
        pol: formatEther(polBalance),
        chainId: 137,
        chain: 'Polygon',
        network: 'mainnet',
        status: 'operational',
      });
    } catch (err) {
      res.json({
        address: wallet.address,
        balance: '0',
        chainId: 137,
        chain: 'Polygon',
        network: 'mainnet',
        status: 'rpc_error',
        error: err.message,
      });
    }
  });

  app.post('/api/generate', async (req, res) => {
    const { prompt } = req.body;
    if (!prompt || !prompt.trim()) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    const result = await generateTokenFromPrompt(prompt);
    if (!result) {
      return res.status(500).json({ error: 'AI generation failed' });
    }
    res.json(result);
  });

  app.post('/api/launch', async (req, res) => {
    const { name, symbol, description, initialBuyPct } = req.body;

    if (!name || !symbol) {
      return res.status(400).json({ error: 'Missing required fields: name, symbol' });
    }

    try {
      const result = await launchFlashToken({
        name,
        symbol,
        description: description || '',
        initialBuyPct: Number(initialBuyPct || 50),
      });

      const session = addSession({
        type: 'launch',
        ...result,
        wallet: wallet.address,
        feesCollected: 0,
        currentValue: 0,
        logoUrl: result.logoUrl || null,
      });

      const ssePush = app.get('ssePush');
      if (ssePush) ssePush();

      res.json({ success: true, ...result, sessionId: session.id });
    } catch (err) {
      const errorMsg = err.stderr?.toString() || err.stdout?.toString() || err.message;
      res.status(500).json({
        success: false,
        error: errorMsg.substring(0, 1000),
      });
    }
  });

  app.get('/api/sessions', (req, res) => {
    res.json(getSessions().reverse());
  });

  app.get('/api/wallet', (req, res) => {
    res.json({
      address: wallet.address,
      chainId: 137,
      chain: 'Polygon',
    });
  });

  app.post('/api/sell', async (req, res) => {
    const { tokenAddress, amount } = req.body;
    if (!tokenAddress) return res.status(400).json({ error: 'tokenAddress required' });

    const sessions = getSessions();
    const session = sessions.find(s => s.tokenAddress?.toLowerCase() === tokenAddress.toLowerCase());
    if (!session) return res.status(400).json({ error: 'Token not found in sessions' });

    try {
      const result = await sellToken({
        tokenAddress,
        amountToSell: amount && amount !== 'all' ? parseFloat(amount) : undefined,
        sellAll: amount === 'all' || !amount,
      });

      addTransaction({
        type: 'sell',
        symbol: session.symbol,
        tokenAddress,
        txHash: result.txHash,
        approveHash: result.approveHash,
        amountIn: result.amountIn,
        gasUsed: result.gasUsed,
        block: result.block,
      });

      const ssePush = app.get('ssePush');
      if (ssePush) ssePush();

      res.json({ success: true, ...result, symbol: session.symbol });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message?.substring(0, 500) || 'Sell failed' });
    }
  });

  app.get('/api/transactions', (req, res) => {
    res.json(loadTransactions().reverse());
  });

  app.post('/api/deposit', (req, res) => {
    const { txHash, amount } = req.body;
    if (!txHash || !amount) return res.status(400).json({ error: 'txHash and amount required' });

    addTransaction({
      type: 'deposit',
      symbol: 'ETH',
      tokenAddress: wallet.address,
      txHash,
      amountIn: amount,
      gasUsed: 21000,
      block: 0,
    });

    const ssePush = app.get('ssePush');
    if (ssePush) ssePush();

    res.json({ ok: true });
  });

  app.get('/api/token-fees', (req, res) => {
    res.json(getTokenFees());
  });

  app.post('/api/config/sell', (req, res) => {
    const { enabled, tpPct, slPct } = req.body;
    saveAutoSellConfig({ enabled: !!enabled, tpPct: Number(tpPct || 50), slPct: Number(slPct || 25) });
    res.json({ ok: true });
  });

  app.get('/api/pnl', async (req, res) => {
    try {
      const balance = await publicClient.getBalance({ address: wallet.address });
      const balanceEth = Number(formatEther(balance));
      const sessions = getSessions();
      const activeTokens = sessions.filter(s => s.tokenAddress && s.initialBuyAmount);
      let totalPnl = 0;
      let totalSpent = 0;
      let totalReturn = 0;
      const tokenPnl = activeTokens.map(s => {
        const spent = s.initialBuyAmount || 0;
        const feesCollected = s.feesCollected || 0;
        const currentValue = s.currentValue || 0;
        const totalReturn = feesCollected + currentValue;
        const netPnl = totalReturn - spent;
        const roi = spent > 0 ? ((totalReturn - spent) / spent) * 100 : 0;
        totalPnl += netPnl;
        totalSpent += spent;
        totalReturn += totalReturn;
        return { symbol: s.symbol, spent, feesCollected, currentValue, netPnl, roi };
      });
      const roi = totalSpent > 0 ? ((totalReturn - totalSpent) / totalSpent) * 100 : 0;
      res.json({ balance: balanceEth, totalPnl, totalSpent, totalReturn, roi, tokens: tokenPnl });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  async function pushAll() {
    try {
      const data = await collectStreamData(publicClient, wallet);
      broadcast(sseClients, data);
    } catch {}
  }

  // Expose pushAll so sell/launch handlers can trigger immediate refresh
  app.set('ssePush', pushAll);

  // --- Polymarket AI Prediction Bot ---

  let polySseClients = [];
  let _polyPushTimer = null;
  function pushPolyState() {
    if (!polySseClients.length) return;
    if (_polyPushTimer) return;
    _polyPushTimer = setTimeout(() => {
      _polyPushTimer = null;
      let data;
      try {
        data = JSON.stringify(poly.getState({ lean: true }));
      } catch (e) {
        console.error('[sse] serialize fail', e.message);
        return;
      }
      polySseClients = polySseClients.filter(c => {
        try { c.res.write(`data: ${data}\n\n`); return true; }
        catch { try { c.res.end(); } catch {} return false; }
      });
    }, 150);
  }
  poly.onStateChange(pushPolyState);

  setInterval(() => {
    polySseClients = polySseClients.filter(c => {
      try { c.res.write(`: ping ${Date.now()}\n\n`); return true; }
      catch { try { c.res.end(); } catch {} return false; }
    });
  }, 20000);

  app.get('/api/poly/state', (req, res) => {
    const lean = req.query.lean === '1' || req.query.lean === 'true';
    res.json(poly.getState(lean ? { lean: true } : {}));
  });

  app.get('/api/poly/stream', (req, res) => {
    const client = { res };
    polySseClients.push(client);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    try {
      res.write(`data: ${JSON.stringify(poly.getState({ lean: true }))}\n\n`);
    } catch (e) {
      console.error('[sse] initial write fail', e.message);
    }
    req.on('close', () => {
      polySseClients = polySseClients.filter(c => c !== client);
    });
  });

  app.get('/api/poly/readiness', async (req, res) => {
    try {
      res.json(await poly.getReadiness());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/poly/sync', async (req, res) => {
    try {
      res.json(await poly.syncBalances());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/poly/deposit', async (req, res) => {
    try {
      const { amountUsd } = req.body || {};
      const result = await poly.syncBalances();
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/poly/start', (req, res) => {
    const result = poly.startBot();
    res.json({ ok: true, running: true, ...result });
  });

  app.post('/api/poly/stop', (req, res) => {
    const result = poly.stopBot(req.body || {});
    res.json({ ok: true, ...result });
  });

  app.post('/api/poly/config', (req, res) => {
    poly.saveConfig(req.body);
    const state = poly.getState({ lean: true });
    res.json({
      ok: true,
      mode: state.config?.mode,
      edgeGate: state.edgeGate || null,
      liveBlocked: req.body?.mode === 'live' && state.config?.mode !== 'live',
    });
  });

  app.get('/api/poly/config-sessions', (req, res) => {
    res.json(poly.getConfigSessionsAnalysis());
  });

  app.post('/api/poly/config-sessions', (req, res) => {
    const { label } = req.body || {};
    res.json(poly.saveCurrentConfigSession({ label, source: 'manual' }));
  });

  app.post('/api/poly/config-sessions/restore', (req, res) => {
    const { id } = req.body || {};
    const result = poly.restoreConfigSession(id);
    res.status(result.ok ? 200 : 404).json(result);
  });

  app.post('/api/poly/paper-reset', (req, res) => {
    const { confirm, initialDeposit } = req.body || {};
    if (confirm !== 'RESET PAPER') {
      return res.status(400).json({ ok: false, error: 'Confirmation must be RESET PAPER' });
    }
    const result = poly.resetPaperData({ initialDeposit });
    res.status(result.ok ? 200 : 400).json(result);
  });

  app.post('/api/poly/live-reset', async (req, res) => {
    const { confirm } = req.body || {};
    if (confirm !== 'RESET LIVE') {
      return res.status(400).json({ ok: false, error: 'Confirmation must be RESET LIVE' });
    }
    try {
      // Refresh CLOB cash so baseline matches wallet before wipe
      await poly.syncBalances().catch(() => null);
      const readiness = await poly.getReadiness().catch(() => null);
      const cash = Number(readiness?.spendableBalance ?? readiness?.clobBalance ?? 0);
      const result = poly.resetLiveData({ baselineUsd: cash > 0 ? cash : undefined });
      res.status(result.ok ? 200 : 400).json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/poly/paper-deposit', (req, res) => {
    try {
      const { amount } = req.body || {};
      const cfg = poly.loadConfig();
      const current = Number(cfg.paperBankroll ?? cfg.paperInitialDeposit ?? 100);
      const deposit = Number(amount);
      if (!Number.isFinite(deposit) || deposit < 0) return res.status(400).json({ error: 'invalid amount' });
      const newBankroll = Math.round((current + deposit) * 100) / 100;
      poly.saveConfig({ paperBankroll: newBankroll, paperInitialDeposit: cfg.paperInitialDeposit ?? 100 });
      res.json({ ok: true, paperBankroll: newBankroll });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/poly/paper-withdraw', (req, res) => {
    try {
      const { amount } = req.body || {};
      const cfg = poly.loadConfig();
      const current = Number(cfg.paperBankroll ?? cfg.paperInitialDeposit ?? 100);
      const withdraw = Number(amount);
      if (!Number.isFinite(withdraw) || withdraw < 0) return res.status(400).json({ error: 'invalid amount' });
      const newBankroll = Math.round(Math.max(0, current - withdraw) * 100) / 100;
      poly.saveConfig({ paperBankroll: newBankroll, paperInitialDeposit: cfg.paperInitialDeposit ?? 100 });
      res.json({ ok: true, paperBankroll: newBankroll });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/poly/sell', async (req, res) => {
    try {
      const { positionId } = req.body || {};
      res.json(await poly.rapidSell(positionId));
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/poly/sell-all', async (req, res) => {
    try {
      res.json(await poly.rapidSellAll());
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/poly/sell-pm', async (req, res) => {
    try {
      const { assetId, size } = req.body || {};
      res.json(await poly.rapidSellPmAsset({ assetId, size }));
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/poly/withdraw', async (req, res) => {
    try {
      const { amountUsd, recipient, chainId } = req.body || {};
      res.json(await poly.initiateWithdraw({ amountUsd, recipient, chainId }));
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/poly/audit', async (req, res) => {
    try {
      res.json(await poly.getAudit());
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/poly/optimize', async (req, res) => {
    try {
      const apply = req.body?.apply !== false;
      const useLlm = req.body?.useLlm !== false;
      res.json(await poly.optimizeNow({ apply, useLlm }));
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/poly/llm-act', async (req, res) => {
    try {
      const actions = req.body?.actions || req.body?.action || req.body;
      const list = Array.isArray(actions) ? actions : [actions];
      res.json(await poly.applyLlmPrimitives(list));
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/poly/primitives', async (req, res) => {
    try {
      const { listPrimitives, STRATEGY_BOUNDS } = await import('./ai/primitives.js');
      res.json({ primitives: listPrimitives(), bounds: STRATEGY_BOUNDS });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/poly/traces', (req, res) => {
    try {
      const limit = Math.min(200, Number(req.query.limit) || 80);
      res.json(poly.getTraces({ limit }));
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/poly/notifications/read', (req, res) => {
    try {
      res.json(poly.markNotificationsRead());
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/poly/optimizer', (req, res) => {
    try {
      const state = poly.getState();
      res.json({
        optimizer: state.optimizer || null,
        sessionPerf: state.sessionPerf || null,
        cycleReward: state.cycleReward || null,
        settle: state.settle || null,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/poly/baseline', (req, res) => {
    const { balanceUsd } = req.body || {};
    if (balanceUsd == null) return res.status(400).json({ error: 'balanceUsd required' });
    res.json(poly.setBaseline(Number(balanceUsd)));
  });

  app.get('/api/poly/account', (req, res) => {
    try {
      const state = poly.getState({ lean: false });
      res.json({
        ok: true,
        timestamp: Date.now(),
        account: state.account || null,
        narrative: state.narrative || null,
        liveScoreCards: state.liveScoreCards || [],
        cashAudit: state.cashAudit || null,
        liveAccount: state.liveAccount || null,
        session: state.session || null,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/poly/narrative', (req, res) => {
    try {
      const state = poly.getState({ lean: true });
      res.json({
        ok: true,
        timestamp: Date.now(),
        narrative: state.narrative || null,
        liveScoreCards: state.liveScoreCards || [],
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/poly/approve', async (req, res) => {
    try {
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ ok: false, error: 'id required' });
      res.json(await poly.approveTrade(id));
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/poly/reject', async (req, res) => {
    try {
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ ok: false, error: 'id required' });
      res.json(await poly.rejectTrade(id));
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/poly/approve-all', async (req, res) => {
    try {
      res.json(await poly.approveAllTrades());
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/poly/depth', async (req, res) => {
    try {
      const { tokenId } = req.query;
      if (!tokenId) return res.status(400).json({ error: 'tokenId required' });
      const { getOrderBookDepth } = await import('./polymarket/clob.js');
      const depth = await getOrderBookDepth(tokenId);
      res.json(depth);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/poly/models', (req, res) => {
    const { getModelStates, getModelHealth } = poly;
    res.json({ models: getModelStates(), health: getModelHealth() });
  });

  app.get('/api/poly/charts', async (req, res) => {
    try {
      const refreshMl = req.query.ml === '1' || req.query.refreshMl === '1';
      res.json(await poly.sampleCharts({ refreshMl }));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/poly/ml-refresh', async (req, res) => {
    try {
      res.json(await poly.refreshMLTraces(true));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/poly/rl-signal', async (req, res) => {
    try {
      const symbol = req.query.symbol || 'BTC';
      const asset = symbol.toUpperCase() === 'BTC' ? 'BTC/USDT' : 'ETH/USDT';
      const scriptPath = path.resolve(ROOT, 'ml', 'rl_fuser_infer.py');
      if (!fs.existsSync(scriptPath)) {
        return res.json({ error: 'RL script not found', rl_direction: 0, rl_label: 'NEUTRAL' });
      }
      const { spawn } = await import('child_process');
      const result = await new Promise((resolve) => {
        const py = process.env.ZINGER_ML_PYTHON || 'python3';
        const proc = spawn(py, [scriptPath, asset], {
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 55000,
          cwd: ROOT,
          env: { ...process.env, PYTHONUNBUFFERED: '1' },
        });
        let out = '', err = '';
        proc.stdout.on('data', d => out += d);
        proc.stderr.on('data', d => err += d);
        const timer = setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch {}
          resolve({ error: 'timeout', rl_direction: 0, rl_label: 'NEUTRAL' });
        }, 55000);
        proc.on('close', (code) => {
          clearTimeout(timer);
          if (code !== 0 || !out.trim()) return resolve({ error: (err || 'no output').slice(0, 200), rl_direction: 0, rl_label: 'NEUTRAL' });
          try { resolve(JSON.parse(out.trim().split('\n').filter(Boolean).pop())); }
          catch { resolve({ error: 'parse error', rl_direction: 0, rl_label: 'NEUTRAL' }); }
        });
        proc.on('error', e => resolve({ error: e.message, rl_direction: 0, rl_label: 'NEUTRAL' }));
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message, rl_direction: 0, rl_label: 'NEUTRAL' });
    }
  });

  // --- AI Endpoints ---
  try {
    const { registerAIEndpoint } = await import('./ai/monitor.js');
    registerAIEndpoint(app);
  } catch (e) {
    console.error('[ai] Failed to register AI endpoints:', e.message);
  }

  // --- Telegram Bot ---
  try {
    const tg = await import('./telegram/bot.js');
    const bot = await tg.startBot();
    if (bot) {
      let prevTradeCount = 0;
      let prevNotifId = null;
      const poly = await import('./polymarket/index.js');
      poly.onStateChange(() => {
        const state = poly.getState({ lean: true });
        const trades = state.trades || [];
        const closed = trades.filter(t => t.closed);
        if (closed.length > prevTradeCount) {
          const newTrade = closed[0];
          tg.notifyTrade(newTrade);
          prevTradeCount = closed.length;
        }
        // Agile pushes: buy / arb / sl / announce as they land
        const n = (state.notifications || [])[0];
        if (n && n.id && n.id !== prevNotifId && ['buy', 'arb', 'sl', 'tp', 'announce', 'error'].includes(n.type)) {
          prevNotifId = n.id;
          const line = `${(n.type || '').toUpperCase()} · ${n.msg || ''}`.slice(0, 350);
          tg.notifyMessage(line).catch(() => {});
        }
      });
      console.log('[tg] Telegram bot active');
    }
  } catch (e) {
    console.error('[tg] Failed to start Telegram bot:', e.message);
  }

  // --- SSE Data Stream ---
  app.get('/api/stream', (req, res) => {
    const client = { res };
    sseClients.push(client);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    req.on('close', () => {
      sseClients = sseClients.filter(c => c !== client);
    });

    pushAll();
    const interval = setInterval(pushAll, 5000);
    req.on('close', () => clearInterval(interval));
  });

  // --- Public simulator UI (uses /api/v1 only — no separate playground API) ---
  const PUBLIC_UI = path.join(ROOT, 'public-api', 'public');
  app.use('/public', express.static(PUBLIC_UI, { etag: false, maxAge: 0 }));
  app.get(['/public', '/public/'], (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(PUBLIC_UI, 'index.html'));
  });
  // Legacy playground URLs → public UI
  app.use('/playground', (req, res) => {
    res.redirect(301, '/public/');
  });

  // --- Static ---
  const isPilotInstance = (process.env.ZINGER_INSTANCE || 'experiment') === 'pilot';
  const PILOT_UI = path.join(ROOT, 'apps', 'pilot', 'public');
  const FRONTEND_DIST = path.join(ROOT, 'frontend', 'dist');
  const STATIC_ROOT = isPilotInstance && fs.existsSync(path.join(PILOT_UI, 'index.html'))
    ? PILOT_UI
    : FRONTEND_DIST;

  app.use('/assets', express.static(path.join(ROOT, 'assets')));
  app.use(express.static(STATIC_ROOT));

  app.get('{*path}', (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.sendFile(path.join(STATIC_ROOT, 'index.html'));
  });

  return app;
}
