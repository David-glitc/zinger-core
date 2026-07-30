import dotenv from 'dotenv';
dotenv.config();

const API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent';

const FREE_MODELS = [];

export async function generateTokenFromPrompt(prompt) {
  if (!API_KEY) {
    console.error('No Gemini API key found - set GEMINI_API_KEY in .env (free from aistudio.google.com)');
    return null;
  }

  const sysPrompt = `You are a token generation assistant. Given an idea or concept, generate a suitable ERC-20 token.

Return ONLY valid JSON with these fields:
{
  "name": "Token Name (max 30 chars, catchy)",
  "symbol": "TICKER (max 8 chars, uppercase)",
  "description": "Short compelling description (2-3 sentences)",
  "initialBuyPct": number (30-70, percentage of wallet balance to use for initial buy)
}

Tokens launch via a flash-token helper with fixed supply of 1,000,000,000 and a 1% pool fee. Keep names creative but plausible. Initial buy is capped at a tiny ETH amount.`;

  try {
    const res = await fetch(GEMINI_URL + '?key=' + API_KEY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: sysPrompt + '\n\nUser request: ' + prompt + '\n\nReturn ONLY valid JSON.' }
          ]
        }],
        generationConfig: {
          temperature: 0.8,
          maxOutputTokens: 500,
          responseMimeType: 'application/json',
        },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(res.status + ' ' + errText.substring(0, 200));
    }

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Empty Gemini response');

    const cleaned = text.replace(/```json\s*|\s*```/g, '').trim();
    const parsed = JSON.parse(cleaned);

    return {
      name: parsed.name?.substring(0, 30) || 'Token',
      symbol: (parsed.symbol || 'TOKEN').substring(0, 8).toUpperCase(),
      description: parsed.description || '',
      totalSupply: 1000000000,
      marketCap: 0,
      initialBuyPct: Math.max(10, Math.min(90, parsed.initialBuyPct || 50)),
      suggestedFeeTier: 1,
      model: 'gemini-2.0-flash-exp',
    };
  } catch (err) {
    console.error('Gemini AI error:', err.message?.substring(0, 200));
    return null;
  }
}
