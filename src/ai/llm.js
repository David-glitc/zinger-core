import OpenAI from 'openai';

/** Prefer free router — specific :free slugs rotate/404 often on OpenRouter */
const DEFAULT_MODELS = [
  process.env.OPENROUTER_MODEL,
  'openrouter/free',
  'openai/gpt-oss-20b:free',
  'meta-llama/llama-3.2-3b-instruct:free',
].filter(Boolean);

let client = null;

function getClient() {
  if (client) return client;
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;
  client = new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey,
    defaultHeaders: {
      'HTTP-Referer': process.env.SITE_URL || 'http://localhost:3000',
      'X-Title': 'Zinger Quant Monitor',
    },
  });
  return client;
}

function extractText(choice) {
  const msg = choice?.message || {};
  if (typeof msg.content === 'string' && msg.content.trim()) return msg.content.trim();
  if (Array.isArray(msg.content)) {
    const joined = msg.content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('').trim();
    if (joined) return joined;
  }
  if (typeof msg.reasoning === 'string' && msg.reasoning.trim()) {
    // reasoning-only models: take last non-empty line as answer when content is empty
    const lines = msg.reasoning.split('\n').map((l) => l.trim()).filter(Boolean);
    const last = lines[lines.length - 1];
    if (last && last.length < 400) return last;
  }
  return null;
}

export function llmStatus() {
  return {
    configured: Boolean(process.env.OPENROUTER_API_KEY),
    models: DEFAULT_MODELS,
    provider: 'openrouter',
  };
}

export async function chat(prompt, system = 'You are Zinger, a quant hedge fund AI assistant. Be concise and data-driven.') {
  const c = getClient();
  if (!c) return { error: 'OPENROUTER_API_KEY not set', ...llmStatus() };

  const errors = [];
  for (const model of DEFAULT_MODELS) {
    try {
      const res = await c.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
        max_tokens: 1024,
        temperature: 0.3,
      });
      const text = extractText(res.choices?.[0]);
      if (text) {
        return {
          text,
          model: res.model || model,
          tokens: res.usage?.total_tokens || 0,
        };
      }
      errors.push(`${model}: empty content`);
    } catch (e) {
      errors.push(`${model}: ${e?.message || e}`);
      continue;
    }
  }
  return { error: errors.slice(0, 3).join(' · ') || 'All models failed', ...llmStatus() };
}

export async function summarizeState(state) {
  const trades = state.trades || [];
  const stats = state.stats || {};
  const models = state.models || [];
  const config = state.config || {};
  const signals = state.signals || {};
  const portfolio = state.portfolio || {};

  const closed = trades.filter((t) => t.closed || t.exitReason);
  const wins = closed.filter((t) => (t.pnl || 0) > 0);
  const totalPnl = Number(portfolio.netPnl ?? stats.totalPnl ?? closed.reduce((s, t) => s + (t.pnl || 0), 0));
  const winRate = closed.length ? ((wins.length / closed.length) * 100).toFixed(1) : '—';

  const modelHealth = (models || []).filter((m) => m.status === 'healthy').length;
  const modelErrors = (models || []).filter((m) => m.status === 'error').length;

  const prompt = [
    '=== ZINGER QUANT STATE ===',
    `Status: ${state.running ? 'RUNNING' : 'STOPPED'} | Mode: ${config.mode || 'paper'}`,
    `Net PnL: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)} · Realized $${Number(portfolio.realizedPnl || 0).toFixed(2)} · Unrealized $${Number(portfolio.unrealizedPnl || 0).toFixed(2)}`,
    `Equity $${Number(portfolio.equity || 0).toFixed(2)} · Cash $${Number(portfolio.cash || 0).toFixed(2)}`,
    `Trades: ${closed.length} · Win rate: ${winRate}%`,
    `Open positions: ${(state.botPositions || state.positions || []).filter((p) => !p.closed).length}`,
    `Model health: ${modelHealth} healthy, ${modelErrors} errors of ${(models || []).length}`,
    `BTC signal: ${signals.btc?.direction || '—'} conf=${((signals.btc?.confidence || 0) * 100).toFixed(0)}%`,
    `ETH signal: ${signals.eth?.direction || '—'} conf=${((signals.eth?.confidence || 0) * 100).toFixed(0)}%`,
    '',
    'Write a 2-3 sentence plain-text hedge fund briefing. No markdown, no formatting. Just numbers and plain English.',
  ].join('\n');

  return chat(prompt, 'You are a quant hedge fund analyst. Output only plain text, no markdown.');
}

export async function askQuestion(state, question, { allowActions = true } = {}) {
  const trades = state.trades || [];
  const models = state.models || [];
  const config = state.config || {};
  const portfolio = state.portfolio || {};
  const open = (state.botPositions || state.positions || []).filter((p) => !p.closed);
  const sideMix = state.sideMix || {};

  const context = [
    '=== ZINGER SYSTEM STATE ===',
    `Running: ${state.running} | Mode: ${config.mode} | Kelly: ${config.kellyFraction}`,
    `Net PnL: $${Number(portfolio.netPnl || 0).toFixed(2)} · Realized $${Number(portfolio.realizedPnl || 0).toFixed(2)} · Unrealized $${Number(portfolio.unrealizedPnl || 0).toFixed(2)}`,
    `Equity $${Number(portfolio.equity || 0).toFixed(2)} · Open marks $${Number(portfolio.openMarkValue || 0).toFixed(2)}`,
    `Side mix recent: UP ${sideMix.up || 0} / DOWN ${sideMix.down || 0}`,
    `Arb: ${config.clobArbEnabled !== false ? 'ON' : 'OFF'} minGap=${config.minArbGap ?? 0.015}`,
    `Trades: ${trades.length} | Models: ${models.length}`,
    `Open: ${open.map((p) => `${p.symbol || p.title} ${p.outcome} @${p.entryPrice}→${p.currentPrice} pnl=${p.pnl}`).join(' · ') || 'none'}`,
    '',
  ].join('\n');

  const actionHint = allowActions
    ? [
      '',
      'If the user asks to change strategy/risk/arb/sides, append a JSON block on its own:',
      '{"actions":[{"name":"update_config","args":{"kellyFraction":0.4}}]}',
      'Primitives: update_config, tighten_risk, loosen_risk, enable_arb, disable_arb, balance_sides, short_tf_focus, optimize, pause_bot, resume_bot, set_mode',
      'Answer in plain English first, then optional JSON.',
    ].join('\n')
    : '';

  const prompt = `${context}\nUser question: ${question}\n\nAnswer in 1-3 plain English sentences.${actionHint}`;
  return chat(prompt, 'You are a quant analyst assistant for Zinger. You may emit strategy primitive JSON to hot-update the running bot.');
}
