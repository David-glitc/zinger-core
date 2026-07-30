import { summarizeState, askQuestion, llmStatus } from './llm.js';
import { extractActionsFromText, listPrimitives } from './primitives.js';

let _lastSummary = null;
let _lastSummaryTime = 0;
const SUMMARY_INTERVAL_MS = 300_000; // 5 min

export function getCachedSummary() {
  return _lastSummary;
}

export async function generateSummary(state) {
  const result = await summarizeState(state);
  if (result.text) {
    _lastSummary = { text: result.text, model: result.model, timestamp: Date.now() };
    _lastSummaryTime = Date.now();
  }
  return result.text ? _lastSummary : { error: result.error || 'Summary generation failed', ...llmStatus() };
}

export async function generateSummaryIfStale(state) {
  if (Date.now() - _lastSummaryTime > SUMMARY_INTERVAL_MS) {
    return generateSummary(state);
  }
  return _lastSummary;
}

export async function ask(state, question) {
  const result = await askQuestion(state, question, { allowActions: true });
  let applied = null;
  const actions = extractActionsFromText(result.text);
  if (actions.length) {
    try {
      const poly = await import('../polymarket/index.js');
      applied = await poly.applyLlmPrimitives(actions);
    } catch (e) {
      applied = { ok: false, error: e.message };
    }
  }
  return {
    answer: result.text || result.error || 'No response',
    ok: Boolean(result.text),
    model: result.model || null,
    error: result.error || null,
    actions,
    applied,
    primitives: listPrimitives(),
    llm: llmStatus(),
  };
}

async function handleAsk(req, res) {
  try {
    const { question } = req.body || {};
    if (!question) return res.status(400).json({ error: 'question required' });
    const poly = await import('../polymarket/index.js');
    const state = poly.getState();
    const result = await ask(state, question);
    res.json({ question, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

async function handleBrief(req, res) {
  try {
    const poly = await import('../polymarket/index.js');
    const state = poly.getState();
    const result = await generateSummary(state);
    res.json(result || { text: 'Summary generation failed' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

export function registerAIEndpoint(router) {
  router.get('/api/ai/status', (req, res) => {
    res.json(llmStatus());
  });

  router.get('/api/ai/summary', async (req, res) => {
    try {
      const summary = _lastSummary;
      if (!summary) return res.json({ text: 'No summary yet. Ask the AI or refresh brief.' });
      res.json(summary);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/api/ai/refresh-summary', handleBrief);
  router.post('/api/ai/ask', handleAsk);

  // Terminal aliases
  router.post('/api/poly/ask', handleAsk);
  router.get('/api/poly/brief', handleBrief);
  router.post('/api/poly/brief', handleBrief);
}
