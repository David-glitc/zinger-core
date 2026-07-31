// @ts-nocheck
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const ASSETS_DIR = path.join(ROOT, 'assets', 'tokens');

const PALETTES = [
  ['#6366f1', '#4338ca'],
  ['#ec4899', '#be185d'],
  ['#14b8a6', '#0d9488'],
  ['#f97316', '#ea580c'],
  ['#8b5cf6', '#6d28d9'],
  ['#06b6d4', '#0891b2'],
  ['#84cc16', '#65a30d'],
  ['#e11d48', '#be123c'],
  ['#0ea5e9', '#0284c7'],
  ['#d946ef', '#a21caf'],
];

function hashToPalette(name) {
  const hash = crypto.createHash('md5').update(name).digest('hex');
  const idx = parseInt(hash.substring(0, 8), 16) % PALETTES.length;
  return PALETTES[idx];
}

function hashToAccent(name) {
  const hash = crypto.createHash('md5').update(name + ':accent').digest('hex');
  return '#' + hash.substring(0, 6);
}

export function generateTokenSvg(name, symbol) {
  const [color1, color2] = hashToPalette(name);
  const accent = hashToAccent(name);
  const letter = (symbol || name || '?')[0].toUpperCase();

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:${color1}"/>
      <stop offset="100%" style="stop-color:${color2}"/>
    </linearGradient>
    <radialGradient id="glow" cx="30%" cy="30%" r="70%">
      <stop offset="0%" style="stop-color:${accent}44"/>
      <stop offset="100%" style="stop-color:${color2}00"/>
    </radialGradient>
    <filter id="shadow">
      <feDropShadow dx="0" dy="1" stdDeviation="3" flood-color="#00000055"/>
    </filter>
  </defs>
  <rect width="256" height="256" rx="48" fill="url(#bg)"/>
  <circle cx="128" cy="128" r="120" fill="url(#glow)"/>
  <circle cx="128" cy="128" r="72" fill="none" stroke="${accent}44" stroke-width="1"/>
  <text x="128" y="152" font-family="system-ui,-apple-system,sans-serif" font-size="96" font-weight="700" fill="white" text-anchor="middle" filter="url(#shadow)">${letter}</text>
  <rect x="78" y="190" width="100" height="2" rx="1" fill="${accent}88"/>
</svg>`;
}

export function saveTokenLogo(name, symbol) {
  const svg = generateTokenSvg(name, symbol);
  const safeSymbol = (symbol || 'TOKEN').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  const filename = `${safeSymbol}.svg`;
  const filepath = path.join(ASSETS_DIR, filename);
  fs.mkdirSync(ASSETS_DIR, { recursive: true });
  fs.writeFileSync(filepath, svg);
  return `/assets/tokens/${filename}`;
}

export function getLogoUrl(path) {
  const siteUrl = process.env.SITE_URL || 'http://localhost:3000';
  return `${siteUrl}${path}`;
}
