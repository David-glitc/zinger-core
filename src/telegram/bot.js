import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import path from 'path';
import { generateSummary, generateSummaryIfStale, ask } from '../ai/monitor.js';
import { chat } from '../ai/llm.js';

let bot = null;
let chatId = null;
let lastPnl = 0;
let dashboardMsgId = null;
let pinnedMsgId = null;

const TRADE_EMOJI = { tp: '✅', sl: '❌', panic: '⚠️', rapid: '⚡', settle: '🏁', partial: '🔹' };
const TG_CHAT_FILE = path.resolve(import.meta.dirname, '../../data/telegram_chat.json');

function loadPersistedChatId() {
  try {
    const data = JSON.parse(fs.readFileSync(TG_CHAT_FILE, 'utf-8'));
    const id = Number(data.chatId);
    return Number.isFinite(id) && id !== 0 ? id : null;
  } catch {
    return null;
  }
}

function persistChatId(id) {
  try {
    fs.writeFileSync(TG_CHAT_FILE, JSON.stringify({ chatId: Number(id), setAt: Date.now() }, null, 2));
  } catch {}
}

function resolveAuthorizedChatId() {
  const fromEnv = Number(process.env.TELEGRAM_CHAT_ID);
  if (Number.isFinite(fromEnv) && fromEnv !== 0) return fromEnv;
  return loadPersistedChatId();
}

function auth(id) {
  const expected = resolveAuthorizedChatId();
  // If nothing configured yet, allow first /start and lock to that chat
  if (!expected) return true;
  return Number(id) === Number(expected);
}

function deny(id) {
  if (!bot) return;
  bot.sendMessage(id, '⛔ Unauthorized. This bot is locked to one chat. Set TELEGRAM_CHAT_ID in .env or /start from the operator chat.').catch(() => {});
}

function rememberChat(id) {
  chatId = Number(id);
  const expected = Number(process.env.TELEGRAM_CHAT_ID);
  if (!expected) persistChatId(id);
}

function poly() {
  return import('../polymarket/index.js');
}

function fetchPost(pathName, body) {
  return fetch(`http://localhost:${process.env.PORT || 3000}${pathName}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).then((r) => r.json());
}

function formatAskResult(result) {
  if (result == null) return 'No response.';
  if (typeof result === 'string') return result;
  if (result.answer) return String(result.answer);
  if (result.text) return String(result.text);
  if (result.error) return `AI error: ${result.error}`;
  return 'No response.';
}

export function isRunning() {
  return bot !== null;
}

export async function startBot() {
  if (bot) return bot;

  if (process.env.TELEGRAM_DISABLED === '1' || process.env.TELEGRAM_DISABLED === 'true') {
    console.log('[tg] TELEGRAM_DISABLED — skipping');
    return null;
  }
  // Only the experiment instance owns Telegram polling (one token → one poller).
  if ((process.env.ZINGER_INSTANCE || 'experiment') === 'pilot') {
    console.log('[tg] Pilot instance — Telegram polling disabled (experiment owns the token)');
    return null;
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const targetChat = process.env.TELEGRAM_CHAT_ID;
  if (!token) { console.log('[tg] No TELEGRAM_BOT_TOKEN — bot disabled'); return null; }

  bot = new TelegramBot(token, { polling: true });

  // --- Info commands (anyone can use) ---

  const mainKeyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: '📊 Status', callback_data: 'status' }, { text: '📈 PnL', callback_data: 'pnl' }, { text: '🤖 Models', callback_data: 'models' }],
        [{ text: '📋 Positions', callback_data: 'positions' }, { text: '⏳ Pending', callback_data: 'pending' }, { text: '⚙️ Config', callback_data: 'config' }],
        [{ text: '▶️ Start', callback_data: 'startbot' }, { text: '⏸️ Stop', callback_data: 'stopbot' }, { text: '🔄 Paper/Live', callback_data: 'mode_toggle' }],
        [{ text: '✅ Approve', callback_data: 'approve' }, { text: '❌ Reject', callback_data: 'reject' }, { text: '⚠️ Panic', callback_data: 'panic' }],
        [{ text: '💰 Deposit $50', callback_data: 'deposit50' }, { text: '🏧 Withdraw $50', callback_data: 'withdraw50' }],
        [{ text: '🤖 Ask AI', callback_data: 'ask_ai' }, { text: '📄 Summary', callback_data: 'summary' }],
      ],
    },
  };

  async function sendOrEdit(id, text, keyboard = mainKeyboard) {
    if (dashboardMsgId) {
      try {
        await bot.editMessageText(text, { chat_id: id, message_id: dashboardMsgId, reply_markup: keyboard.reply_markup, parse_mode: 'Markdown' });
        return;
      } catch {
        try { await bot.editMessageText(text, { chat_id: id, message_id: dashboardMsgId, reply_markup: keyboard.reply_markup }); return; } catch {}
      }
    }
    const sent = await bot.sendMessage(id, text, keyboard);
    dashboardMsgId = sent.message_id;
    // Pin only in the authorized operator chat (one pinned command dashboard)
    if (Number(id) === Number(chatId || resolveAuthorizedChatId())) {
      try {
        if (pinnedMsgId && pinnedMsgId !== sent.message_id) {
          await bot.unpinChatMessage(id, { message_id: pinnedMsgId }).catch(() => {});
        }
        await bot.pinChatMessage(id, sent.message_id, { disable_notification: true });
        pinnedMsgId = sent.message_id;
      } catch {}
    }
  }

  async function showMainMenu(id, msg) {
    await bot.sendMessage(id, msg || 'Zinger Command Center — tap a button:', mainKeyboard);
  }

  bot.onText(/\/start/, async (msg) => {
    const id = msg.chat.id;
    if (!auth(id)) return deny(id);
    rememberChat(id);
    console.log(`[tg] 👤 Chat joined / locked: ${id}`);
    const locked = resolveAuthorizedChatId();
    await bot.sendMessage(id, [
      '🤖 *Zinger Command Center*',
      '',
      `Your Chat ID: \`${id}\``,
      locked ? `✅ Operator chat locked: \`${locked}\`` : '⚠️ First /start locks this chat for pins + pushes',
      'Set `TELEGRAM_CHAT_ID` in `.env` to hard-lock.',
      '—'.repeat(16),
      'Tap buttons below or type commands.',
      'Free text → AI chat (OpenRouter).',
      '/ask <question> · /menu · /pnl · /status',
      'Pin: command dashboard is pinned in *this* chat only.',
    ].join('\n'), { parse_mode: 'Markdown', ...mainKeyboard });
  });

  bot.onText(/\/menu/, async (msg) => {
    const id = msg.chat.id;
    if (!auth(id)) return deny(id);
    rememberChat(id);
    await showMainMenu(id, 'Command Center:');
  });

  bot.onText(/\/pin/, async (msg) => {
    const id = msg.chat.id;
    if (!auth(id)) return deny(id);
    rememberChat(id);
    await sendOrEdit(id, [
      '📌 *Pinned Command Dashboard*',
      '',
      'This message stays pinned in your operator chat.',
      'Use the buttons below. Push alerts also go here.',
    ].join('\n'));
  });

  // --- Inline keyboard handler ---
  bot.on('callback_query', async (query) => {
    const id = query.message.chat.id;
    if (!auth(id)) { await bot.answerCallbackQuery(query.id, { text: '⛔ Unauthorized' }); return; }
    await bot.answerCallbackQuery(query.id);

    const data = query.data;
    const p = await poly();
    const state = p.getState();

    try {
      switch (data) {
        case 'status': {
          const cfg = state.config || {};
          const port = state.portfolio || {};
          const open = (state.botPositions || []).filter((p) => !p.closed).length;
          const net = Number(port.netPnl ?? state.stats?.netPnl ?? 0);
          await sendOrEdit(id, [
            `📊 *Zinger Status*`,
            ``,
            `Status: ${state.running ? '▶️ RUNNING' : '⏸️ STOPPED'} · ${state.mode || cfg.mode || 'paper'}`,
            `Cash: ${port.cash != null ? '$' + Number(port.cash).toFixed(2) : '—'} · Equity: ${port.equity != null ? '$' + Number(port.equity).toFixed(2) : '—'}`,
            `Net PnL: ${net >= 0 ? '+' : ''}$${net.toFixed(2)} · R $${Number(port.realizedPnl || 0).toFixed(2)} · U $${Number(port.unrealizedPnl || 0).toFixed(2)}`,
            `Open: ${open} · Pending: ${(state.pendingTrades || []).length} · Scans: ${state.stats?.scansDone || 0}`,
            `Kelly: ${cfg.kellyFraction} · TP: ${cfg.tpPctLow}-${cfg.tpPctHigh}% · SL: ${cfg.slPct}%`,
          ].join('\n'));
          break;
        }
        case 'pnl': {
          const port = state.portfolio || {};
          const stats = state.stats || {};
          const net = Number(port.netPnl ?? 0);
          await sendOrEdit(id, [
            `📈 *PnL — ${state.mode || 'paper'}*`,
            ``,
            `Net: ${net >= 0 ? '+' : ''}$${net.toFixed(2)}`,
            `Realized: $${Number(port.realizedPnl || 0).toFixed(2)}`,
            `Unrealized: $${Number(port.unrealizedPnl || 0).toFixed(2)}`,
            `Cash: $${Number(port.cash || 0).toFixed(2)} · Equity: $${Number(port.equity || 0).toFixed(2)}`,
            stats.paper?.totalTrades != null ? `Paper trades: ${stats.paper.totalTrades} · $${Number(stats.paper.totalPnl || 0).toFixed(2)}` : '',
            stats.live?.totalTrades != null ? `Live trades: ${stats.live.totalTrades} · verified $${Number(stats.live.verifiedPnl || 0).toFixed(2)}` : '',
          ].filter(Boolean).join('\n'));
          break;
        }
        case 'models': {
          const models = p.getModelStates?.() || [];
          if (!models.length) { await bot.sendMessage(id, 'No ML models loaded.', mainKeyboard); break; }
          const lines = models.map(m =>
            `${m.symbol} ${m.timeframe} h${m.horizon}: ${m.status === 'healthy' ? '✅' : m.status === 'running' ? '⏳' : '❌'} ${m.direction ? (m.direction === 1 ? '↑' : '↓') : '—'} ${m.confidence ? (m.confidence * 100).toFixed(0) + '%' : '—'}`
          );
          for (const chunk of chunkArray(lines, 15)) {
            await bot.sendMessage(id, chunk.join('\n'), mainKeyboard);
          }
          break;
        }
        case 'positions': {
          const pos = state.botPositions || [];
          if (!pos.length) { await sendOrEdit(id, '📋 No open positions.'); break; }
          const lines = [`📋 *Open Positions*`, ``];
          pos.forEach(po => {
            const pnl = po.pnl || 0;
            const dir = (po.outcome || '').toUpperCase();
            lines.push(`${po.symbol} ${dir} · ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} · ${(po.shares || 0).toFixed(1)}sh · $${(po.markValue || 0).toFixed(2)}`);
            lines.push(`  TP ${po.tpPct || '?'}% · SL ${po.slPct || '?'}% · \`${po.id || '?'}\``);
          });
          await sendOrEdit(id, lines.join('\n'));
          break;
        }
        case 'pending': {
          const pending = state.pendingTrades || [];
          if (!pending.length) { await sendOrEdit(id, '⏳ No pending trades.'); break; }
          const lines = [`⏳ *Pending Trades*`, ``];
          pending.forEach(pt => {
            const secs = pt.expiresAt ? Math.max(0, Math.ceil((pt.expiresAt - Date.now()) / 1000)) : '?';
            lines.push(`${pt.symbol} ${(pt.outcome || '').toUpperCase()} · $${(pt.plan?.entryPrice || 0).toFixed(3)} · ${((pt.plan?.confidence || 0) * 100).toFixed(0)}% conf · ${secs}s left`);
          });
          await sendOrEdit(id, lines.join('\n'));
          break;
        }
        case 'config': {
          const cfg = p.loadConfig();
          const lines = Object.entries(cfg).filter(([k]) => !k.startsWith('_')).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
          for (const chunk of chunkArray(lines, 15)) {
            await bot.sendMessage(id, chunk.join('\n'), mainKeyboard);
          }
          break;
        }
        case 'startbot': {
          await fetchPost('/api/poly/start');
          await bot.sendMessage(id, '▶️ Bot started', mainKeyboard);
          break;
        }
        case 'stopbot': {
          await fetchPost('/api/poly/stop');
          await bot.sendMessage(id, '⏸️ Bot stopped', mainKeyboard);
          break;
        }
        case 'mode_toggle': {
          const current = state.mode || state.config?.mode || 'paper';
          const next = current === 'paper' ? 'live' : 'paper';
          await fetchPost('/api/poly/config', { mode: next });
          await bot.sendMessage(id, `🔄 Switched to ${next.toUpperCase()}`, mainKeyboard);
          break;
        }
        case 'approve': {
          const pending = state.pendingTrades || [];
          if (!pending.length) { await bot.sendMessage(id, 'No pending trades to approve.', mainKeyboard); break; }
          await fetchPost('/api/poly/approve', { id: pending[0].id });
          await bot.sendMessage(id, `✅ Approved ${pending[0].symbol}`, mainKeyboard);
          break;
        }
        case 'reject': {
          const pending = state.pendingTrades || [];
          if (!pending.length) { await bot.sendMessage(id, 'No pending trades to reject.', mainKeyboard); break; }
          await fetchPost('/api/poly/reject', { id: pending[0].id });
          await bot.sendMessage(id, `❌ Rejected ${pending[0].symbol}`, mainKeyboard);
          break;
        }
        case 'panic': {
          await fetchPost('/api/poly/sell-all');
          await bot.sendMessage(id, '⚠️ Panic sell executed', mainKeyboard);
          break;
        }
        case 'deposit50': {
          const r = await fetchPost('/api/poly/paper-deposit', { amount: 50 });
          if (r.ok) await bot.sendMessage(id, `💰 Deposited $50. Balance: $${(r.paperBankroll || 0).toFixed(2)}`, mainKeyboard);
          else await bot.sendMessage(id, `❌ Deposit failed: ${r.error}`, mainKeyboard);
          break;
        }
        case 'withdraw50': {
          const r = await fetchPost('/api/poly/paper-withdraw', { amount: 50 });
          if (r.ok) await bot.sendMessage(id, `🏧 Withdrew $50. Balance: $${(r.paperBankroll || 0).toFixed(2)}`, mainKeyboard);
          else await bot.sendMessage(id, `❌ Withdraw failed: ${r.error}`, mainKeyboard);
          break;
        }
        case 'summary': {
          await bot.sendChatAction(id, 'typing');
          const result = await generateSummary(state);
          await bot.sendMessage(id, result?.text || 'Summary unavailable.', mainKeyboard);
          break;
        }
        case 'ask_ai': {
          await bot.sendMessage(id, 'Type your question for the AI quant analyst. Any message works.', mainKeyboard);
          break;
        }
      }
    } catch (e) {
      await bot.sendMessage(id, `Error: ${e.message}`, mainKeyboard);
    }
  });

  bot.onText(/\/status/, async (msg) => {
    const id = msg.chat.id;
    if (!auth(id)) return deny(id);
    try {
      const p = await poly();
      const state = p.getState();
      const cfg = state.config || {};
      const trades = state.trades || [];
      const closed = trades.filter(t => t.closed);
      const pnl = closed.reduce((s, t) => s + (t.pnl || 0), 0);
      const open = (state.botPositions || []).filter(p => !p.closed).length;
      const port = state.portfolio || {};
      const text = [
        `Status: ${state.running ? '▶️ RUNNING' : '⏸️ STOPPED'}`,
        `Mode: ${state.mode || cfg.mode || 'paper'}`,
        `Bankroll: ${port.cash != null ? '$' + port.cash.toFixed(2) : '—'}`,
        `Equity: ${port.equity != null ? '$' + port.equity.toFixed(2) : '—'}`,
        `PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`,
        `Trades: ${closed.length} closed, ${open} open`,
        `Pending: ${(state.pendingTrades || []).length}`,
        `Scans: ${state.stats?.scansDone || 0}`,
        `Kelly: ${cfg.kellyFraction} | TP: ${cfg.tpPctLow}-${cfg.tpPctHigh}% | SL: ${cfg.slPct}%`,
        `Conf min: ${cfg.minConfidence}`,
      ].join('\n');
      await bot.sendMessage(id, text);
    } catch (e) {
      await bot.sendMessage(id, `Error: ${e.message}`);
    }
  });

  bot.onText(/\/summary/, async (msg) => {
    const id = msg.chat.id;
    if (!auth(id)) return deny(id);
    await bot.sendChatAction(id, 'typing');
    try {
      const p = await poly();
      const state = p.getState();
      const result = await generateSummary(state);
      await bot.sendMessage(id, result?.text || 'Summary unavailable.');
    } catch (e) {
      await bot.sendMessage(id, `Error: ${e.message}`);
    }
  });

  bot.onText(/\/pnl/, async (msg) => {
    const id = msg.chat.id;
    if (!auth(id)) return deny(id);
    try {
      const p = await poly();
      const state = p.getState();
      const trades = state.trades || [];
      const closed = trades.filter(t => t.closed);
      const wins = closed.filter(t => (t.pnl || 0) > 0);
      const losses = closed.filter(t => (t.pnl || 0) <= 0);
      const totalPnl = closed.reduce((s, t) => s + (t.pnl || 0), 0);
      const stats = state.stats || {};
      const text = [
        `📊 PnL — ${state.mode || 'paper'}`,
        '',
        `Total: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`,
        `Trades: ${closed.length} (${wins.length}W / ${losses.length}L)`,
        `WR: ${closed.length ? (wins.length / closed.length * 100).toFixed(1) : '—'}%`,
        `Avg W: ${wins.length ? '$' + (wins.reduce((s, t) => s + (t.pnl || 0), 0) / wins.length).toFixed(2) : '—'}`,
        `Avg L: ${losses.length ? '$' + (losses.reduce((s, t) => s + (t.pnl || 0), 0) / losses.length).toFixed(2) : '—'}`,
        '',
        stats.live?.totalTrades ? `Live: ${stats.live.totalTrades} tr, $${(stats.live.totalPnl || 0).toFixed(2)}` : '',
        stats.paper?.totalTrades ? `Paper: ${stats.paper.totalTrades} tr, $${(stats.paper.totalPnl || 0).toFixed(2)}` : '',
      ].filter(Boolean).join('\n');
      await bot.sendMessage(id, text);
    } catch (e) {
      await bot.sendMessage(id, `Error: ${e.message}`);
    }
  });

  bot.onText(/\/models/, async (msg) => {
    const id = msg.chat.id;
    if (!auth(id)) return deny(id);
    try {
      const p = await poly();
      const models = p.getModelStates?.() || [];
      if (!models.length) return bot.sendMessage(id, 'No ML models loaded.');
      const lines = models.map(m =>
        `${m.symbol} ${m.timeframe} h${m.horizon}: ${m.status === 'healthy' ? '✅' : m.status === 'running' ? '⏳' : m.status === 'error' ? '❌' : '💤'} ${m.direction ? (m.direction === 1 ? '↑' : m.direction === -1 ? '↓' : '→') : '—'} ${m.confidence ? (m.confidence * 100).toFixed(0) + '%' : '—'}`
      );
      for (const chunk of chunkArray(lines, 15)) {
        await bot.sendMessage(id, chunk.join('\n') || 'No models');
      }
    } catch (e) {
      await bot.sendMessage(id, `Error: ${e.message}`);
    }
  });

  bot.onText(/\/positions/, async (msg) => {
    const id = msg.chat.id;
    if (!auth(id)) return deny(id);
    try {
      const p = await poly();
      const state = p.getState();
      const pos = state.botPositions || [];
      const walletPos = state.positions || [];
      if (!pos.length && !walletPos.length) return bot.sendMessage(id, 'No open positions.');
      const lines = [];
      for (const po of pos) {
        const pnl = po.pnl || 0;
        lines.push(`${po.symbol} ${(po.outcome || '').toUpperCase()} | ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} | ${(po.shares || 0).toFixed(1)}sh $${(po.markValue || 0).toFixed(2)} | SL ${po.slPct || '?'}% | id: \`${po.id || '?'}\``);
      }
      if (walletPos.length && state.mode !== 'paper') {
        lines.push('—'.repeat(20));
        for (const wp of walletPos) {
          lines.push(`Wallet: ${(wp.title || wp.slug || '').slice(0, 30)} ${wp.outcome} | $${(wp.cashPnl || 0).toFixed(2)}`);
        }
      }
      for (const chunk of chunkArray(lines, 10)) {
        await bot.sendMessage(id, chunk.join('\n') || 'No positions');
      }
    } catch (e) {
      await bot.sendMessage(id, `Error: ${e.message}`);
    }
  });

  bot.onText(/\/pending/, async (msg) => {
    const id = msg.chat.id;
    if (!auth(id)) return deny(id);
    try {
      const p = await poly();
      const state = p.getState();
      const pending = state.pendingTrades || [];
      if (!pending.length) return bot.sendMessage(id, 'No pending trades.');
      const lines = pending.map((pt, i) =>
        `#${i + 1}: ${pt.symbol} ${(pt.outcome || '').toUpperCase()} | $${(pt.plan?.entryPrice || 0).toFixed(3)} | conf ${((pt.plan?.confidence || 0) * 100).toFixed(0)}% | expires ${pt.expiresAt ? Math.max(0, Math.ceil((pt.expiresAt - Date.now()) / 1000)) : '?'}s | id: \`${pt.id}\``
      );
      await bot.sendMessage(id, lines.join('\n'));
    } catch (e) {
      await bot.sendMessage(id, `Error: ${e.message}`);
    }
  });

  bot.onText(/\/config(?:\s+(.+))?/, async (msg, match) => {
    const id = msg.chat.id;
    if (!auth(id)) return deny(id);
    try {
      const p = await poly();
      const cfg = p.loadConfig();
      const rest = match?.[1]?.trim();
      if (!rest) {
        const lines = Object.entries(cfg)
          .filter(([k]) => !k.startsWith('_'))
          .map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
        for (const chunk of chunkArray(lines, 15)) {
          await bot.sendMessage(id, '```\n' + chunk.join('\n') + '\n```', { parse_mode: 'Markdown' });
        }
        return;
      }
      const eqIdx = rest.indexOf('=');
      const spaceIdx = rest.indexOf(' ');
      const sepIdx = eqIdx > 0 && (spaceIdx < 0 || eqIdx < spaceIdx) ? eqIdx : spaceIdx;
      if (sepIdx > 0) {
        const key = rest.slice(0, sepIdx).trim();
        let val = rest.slice(sepIdx + 1).trim();
        if (!key) return bot.sendMessage(id, 'Usage: /config key=value or /config key value');
        const old = cfg[key];
        if (!isNaN(Number(val))) val = Number(val);
        else if (val === 'true') val = true;
        else if (val === 'false') val = false;
        p.saveConfig({ [key]: val });
        await bot.sendMessage(id, `✅ ${key}: ${JSON.stringify(old)} → ${JSON.stringify(val)}`);
      } else {
        const val = cfg[rest];
        await bot.sendMessage(id, `\`${rest}\` = ${JSON.stringify(val)}`, { parse_mode: 'Markdown' });
      }
    } catch (e) {
      await bot.sendMessage(id, `Error: ${e.message}`);
    }
  });

  // --- Action commands (POST to local API) ---

  bot.onText(/\/startbot/, async (msg) => {
    const id = msg.chat.id;
    if (!auth(id)) return deny(id);
    try {
      await fetchPost('/api/poly/start');
      await bot.sendMessage(id, '▶️ Bot started');
    } catch (e) {
      await bot.sendMessage(id, `Error: ${e.message}`);
    }
  });

  bot.onText(/\/stopbot/, async (msg) => {
    const id = msg.chat.id;
    if (!auth(id)) return deny(id);
    try {
      await fetchPost('/api/poly/stop');
      await bot.sendMessage(id, '⏸️ Bot stopped');
    } catch (e) {
      await bot.sendMessage(id, `Error: ${e.message}`);
    }
  });

  bot.onText(/\/mode\s+(.+)/, async (msg, match) => {
    const id = msg.chat.id;
    if (!auth(id)) return deny(id);
    const mode = match[1].trim().toLowerCase();
    if (mode !== 'paper' && mode !== 'live') return bot.sendMessage(id, 'Usage: /mode paper|live');
    try {
      await fetchPost('/api/poly/config', { mode });
      await bot.sendMessage(id, `✅ Mode switched to ${mode.toUpperCase()}`);
    } catch (e) {
      await bot.sendMessage(id, `Error: ${e.message}`);
    }
  });

  bot.onText(/\/panic/, async (msg) => {
    const id = msg.chat.id;
    if (!auth(id)) return deny(id);
    try {
      const result = await fetchPost('/api/poly/sell-all');
      if (result.ok === false) return bot.sendMessage(id, `❌ Panic failed: ${result.error}`);
      await bot.sendMessage(id, '⚠️ Panic sell executed — all positions dumped');
    } catch (e) {
      await bot.sendMessage(id, `Error: ${e.message}`);
    }
  });

  bot.onText(/\/approve(?:\s+(.+))?/, async (msg, match) => {
    const id = msg.chat.id;
    if (!auth(id)) return deny(id);
    const arg = match?.[1]?.trim();
    try {
      if (arg === 'all') {
        await fetchPost('/api/poly/approve-all');
        await bot.sendMessage(id, '✅ All trades approved');
      } else if (arg) {
        await fetchPost('/api/poly/approve', { id: arg });
        await bot.sendMessage(id, `✅ Trade ${arg} approved`);
      } else {
        const p = await poly();
        const state = p.getState();
        const pending = state.pendingTrades || [];
        if (!pending.length) return bot.sendMessage(id, 'No pending trades to approve.');
        const first = pending[0];
        await fetchPost('/api/poly/approve', { id: first.id });
        await bot.sendMessage(id, `✅ Approved ${first.symbol} ${(first.outcome || '').toUpperCase()}`);
      }
    } catch (e) {
      await bot.sendMessage(id, `Error: ${e.message}`);
    }
  });

  bot.onText(/\/reject(?:\s+(.+))?/, async (msg, match) => {
    const id = msg.chat.id;
    if (!auth(id)) return deny(id);
    const arg = match?.[1]?.trim();
    try {
      if (arg) {
        await fetchPost('/api/poly/reject', { id: arg });
        await bot.sendMessage(id, `❌ Trade ${arg} rejected`);
      } else {
        const p = await poly();
        const state = p.getState();
        const pending = state.pendingTrades || [];
        if (!pending.length) return bot.sendMessage(id, 'No pending trades to reject.');
        const first = pending[0];
        await fetchPost('/api/poly/reject', { id: first.id });
        await bot.sendMessage(id, `❌ Rejected ${first.symbol} ${(first.outcome || '').toUpperCase()}`);
      }
    } catch (e) {
      await bot.sendMessage(id, `Error: ${e.message}`);
    }
  });

  bot.onText(/\/sell(?:\s+(.+))?/, async (msg, match) => {
    const id = msg.chat.id;
    if (!auth(id)) return deny(id);
    const arg = match?.[1]?.trim();
    if (!arg) return bot.sendMessage(id, 'Usage: /sell <positionId>');
    try {
      const result = await fetchPost('/api/poly/sell', { positionId: arg });
      if (result.ok === false) return bot.sendMessage(id, `❌ Sell failed: ${result.error}`);
      await bot.sendMessage(id, `✅ Position ${arg} sold`);
    } catch (e) {
      await bot.sendMessage(id, `Error: ${e.message}`);
    }
  });

  bot.onText(/\/deposit\s+(.+)/, async (msg, match) => {
    const id = msg.chat.id;
    if (!auth(id)) return deny(id);
    const amount = parseFloat(match[1]);
    if (!amount || amount <= 0) return bot.sendMessage(id, 'Usage: /deposit <amount>');
    try {
      const result = await fetchPost('/api/poly/paper-deposit', { amount });
      if (result.ok) {
        await bot.sendMessage(id, `💰 Deposited $${amount.toFixed(2)} to paper bankroll. Balance: $${(result.paperBankroll || 0).toFixed(2)}`);
      } else {
        await bot.sendMessage(id, `❌ Deposit failed: ${result.error}`);
      }
    } catch (e) {
      await bot.sendMessage(id, `Error: ${e.message}`);
    }
  });

  bot.onText(/\/withdraw\s+(.+)/, async (msg, match) => {
    const id = msg.chat.id;
    if (!auth(id)) return deny(id);
    const amount = parseFloat(match[1]);
    if (!amount || amount <= 0) return bot.sendMessage(id, 'Usage: /withdraw <amount>');
    try {
      const result = await fetchPost('/api/poly/paper-withdraw', { amount });
      if (result.ok) {
        await bot.sendMessage(id, `🏧 Withdrew $${amount.toFixed(2)} from paper bankroll. Balance: $${(result.paperBankroll || 0).toFixed(2)}`);
      } else {
        await bot.sendMessage(id, `❌ Withdraw failed: ${result.error}`);
      }
    } catch (e) {
      await bot.sendMessage(id, `Error: ${e.message}`);
    }
  });

  // --- AI ---

  bot.onText(/\/ask\s+(.+)/, async (msg, match) => {
    const id = msg.chat.id;
    if (!auth(id)) return deny(id);
    rememberChat(id);
    const question = match[1];
    await bot.sendChatAction(id, 'typing');
    try {
      const p = await poly();
      const state = p.getState();
      const result = await ask(state, question);
      await bot.sendMessage(id, formatAskResult(result));
    } catch (e) {
      await bot.sendMessage(id, `Error: ${e.message}`);
    }
  });

  // Free-form text → LLM quant analyst
  bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    if (!auth(msg.chat.id)) return;
    rememberChat(msg.chat.id);
    const text = msg.text.trim();
    if (!text) return;
    await bot.sendChatAction(msg.chat.id, 'typing');

    const stateKeywords = ['pnl', 'profit', 'loss', 'trade', 'position', 'bankroll', 'equity', 'kelly', 'model', 'signal', 'market', 'btc', 'eth', 'confidence', 'running', 'status', 'cash'];
    const isStateQuery = stateKeywords.some((k) => text.toLowerCase().includes(k));

    try {
      if (isStateQuery) {
        const p = await poly();
        const state = p.getState();
        const result = await ask(state, text);
        await bot.sendMessage(msg.chat.id, formatAskResult(result), mainKeyboard);
      } else {
        const result = await chat(text, 'You are Zinger, a quant hedge fund AI assistant. Be concise. No markdown. If the user asks about trading data, remind them to use /ask with specific questions.');
        await bot.sendMessage(msg.chat.id, `${formatAskResult(result)}\n\n/menu for controls`, mainKeyboard);
      }
    } catch (e) {
      try {
        const result = await chat(text, 'You are Zinger, a quant hedge fund AI assistant. Be concise. No markdown.');
        await bot.sendMessage(msg.chat.id, `${formatAskResult(result)}\n\n/menu for controls`, mainKeyboard);
      } catch (err) {
        await bot.sendMessage(msg.chat.id, `AI error: ${err.message || e.message}`).catch(() => {});
      }
    }
  });

  chatId = resolveAuthorizedChatId();
  console.log(`[tg] Command center active${chatId ? `, pinning/pushes → chat ${chatId}` : ' (await /start to lock chat)'}`);
  return bot;
}

// --- Push notifications ---

export async function notifyTrade(trade) {
  if (!bot || !chatId) return;
  const emoji = TRADE_EMOJI[trade.exitReason] || '📊';
  const pnl = trade.pnl || 0;
  const text = [
    `${emoji} Trade ${trade.exitReason?.toUpperCase() || 'CLOSED'}`,
    `${trade.symbol} ${trade.outcome?.toUpperCase()} | PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`,
    trade.gainPct ? `Return: ${(trade.gainPct >= 0 ? '+' : '')}${trade.gainPct.toFixed(1)}%` : '',
    `Entry: $${trade.entryPrice?.toFixed(3)} → Exit: $${trade.exitPrice?.toFixed(3) || '—'}`,
  ].filter(Boolean).join('\n');
  try { await bot.sendMessage(chatId, text); } catch {}
}

export async function notifyError(context, error) {
  if (!bot || !chatId) return;
  const text = `🚨 Error: ${context}\n${String(error).slice(0, 200)}`;
  try { await bot.sendMessage(chatId, text); } catch {}
}

export async function notifyMessage(msg) {
  if (!bot || !chatId) return;
  try { await bot.sendMessage(chatId, msg); } catch {}
}

export async function pushPeriodicSummary(state) {
  if (!bot || !chatId) return;
  const result = await generateSummaryIfStale(state);
  if (result?.text) {
    await bot.sendMessage(chatId, `📋 ${result.text}`);
  }
}

export async function checkPnLChange(state) {
  if (!bot || !chatId) return;
  const trades = state.trades || [];
  const closed = trades.filter(t => t.closed);
  const pnl = closed.reduce((s, t) => s + (t.pnl || 0), 0);
  if (lastPnl !== 0 && Math.abs(pnl - lastPnl) > 1.0) {
    const dir = pnl > lastPnl ? '📈' : '📉';
    await bot.sendMessage(chatId, `${dir} PnL moved $${(pnl - lastPnl).toFixed(2)} to $${pnl.toFixed(2)}`);
  }
  lastPnl = pnl;
}

function chunkArray(arr, size) {
  const result = [];
  for (let i = 0; i < arr.length; i += size) result.push(arr.slice(i, i + size));
  return result;
}

export function stopBot() {
  if (bot) {
    bot.stopPolling();
    bot = null;
  }
}