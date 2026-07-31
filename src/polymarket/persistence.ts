// @ts-nocheck
import fs from 'fs';
import path from 'path';

const DEFAULT_DATA_DIR = path.resolve(import.meta.dirname, '../../data');
const DATA_DIR = process.env.ZINGER_DATA_DIR
  ? path.resolve(process.env.ZINGER_DATA_DIR)
  : DEFAULT_DATA_DIR;

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const queues = new Map();
const pendingFlush = new Map();

function atomicWrite(filePath, data) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, filePath);
}

function enqueue(file, data) {
  if (!queues.has(file)) queues.set(file, []);
  queues.get(file).push(data);
  if (!pendingFlush.has(file)) {
    pendingFlush.set(file, setTimeout(() => flush(file), 0));
  }
}

function flush(file) {
  pendingFlush.delete(file);
  const items = queues.get(file);
  if (!items || items.length === 0) return;
  queues.set(file, []);
  const last = items[items.length - 1];
  try {
    atomicWrite(file, last);
  } catch (err) {
    console.error(`[persist] write error ${path.basename(file)}: ${err.message}`);
    queues.set(file, [...items]);
  }
}

export function persist(file, data) {
  enqueue(file, data);
}

export function persistSync(file, data) {
  clearTimeout(pendingFlush.get(file));
  pendingFlush.delete(file);
  queues.delete(file);
  try {
    atomicWrite(file, data);
  } catch (err) {
    console.error(`[persist] sync write error ${path.basename(file)}: ${err.message}`);
  }
}

export function load(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return fallback;
  }
}

export function loadWithDefault(file, defaults) {
  const existing = load(file, null);
  if (existing) return existing;
  persistSync(file, defaults);
  return defaults;
}

export function dataPath(name) {
  return path.join(DATA_DIR, name);
}

export function getDataDir() {
  return DATA_DIR;
}

export const FILES = {
  CONFIG: path.join(DATA_DIR, 'poly_config.json'),
  TRADES: path.join(DATA_DIR, 'poly_trades.json'),
  POSITIONS: path.join(DATA_DIR, 'poly_positions.json'),
  ACTIONS: path.join(DATA_DIR, 'poly_actions.json'),
};
