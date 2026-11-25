// Closed-4h range-break watcher. Alerts Telegram once per break.
// Usage: node watch.mjs SOLUSDT,ETHUSDT,XRPUSDT   (env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID; DRY=1 = print only)
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join as joinPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bold, code, dateTime, fmt, italic, join, toTelegramPayload } from '@nemesis-oss/tg-format';
import { analyzeSymbol, getJson } from './analyze.mjs';
import { appendEntries, entryFrom } from './journal.mjs';
import { parseKlines } from './smc.mjs';

const STATE_PATH = process.env.BIAS_STATE ?? joinPath(homedir(), '.cache', 'binance-bias', 'state.json');
const SYMBOL_PATTERN = /^[A-Z0-9]{2,15}USDT$/;
const MAX_SYMBOLS = 5;
const RANGE_CANDLES = 6; // 24h of 4h candles
const ICON = { BREAKDOWN: '🔻', RECLAIM: '🔺' };
const COMPARE = { BREAKDOWN: 'support <', RECLAIM: 'resistance >' };
const STANCE = {
  BREAKDOWN: 'Longs unfavorable until reclaim.',
  RECLAIM: 'Shorts unfavorable until it fails back inside.',
};

export function rangeOf(candles) {
  const recent = candles.slice(-RANGE_CANDLES);
  return { support: Math.min(...recent.map((x) => x.l)), resistance: Math.max(...recent.map((x) => x.h)) };
}

/** First closed candle after the last check that closes outside the saved range. */
export function detectBreak(candles, saved) {
  for (const x of candles.filter((c) => c.ct > saved.checkedThrough)) {
    if (x.c < saved.support) return { kind: 'BREAKDOWN', close: x.c, level: saved.support, closeTimeMs: x.ct };
    if (x.c > saved.resistance) return { kind: 'RECLAIM', close: x.c, level: saved.resistance, closeTimeMs: x.ct };
  }
  return null;
}

async function checkSymbol(symbol, state, nowMs) {
  const candles = parseKlines(await getJson(`/fapi/v1/klines?symbol=${symbol}&interval=4h&limit=12`), nowMs);
  const checkedThrough = candles.at(-1).ct;
  const saved = state[symbol];
  if (!saved) {
    state[symbol] = { ...rangeOf(candles), checkedThrough };
    return { symbol, kind: 'SEEDED', ...state[symbol] };
  }
  const hit = detectBreak(candles, saved);
  state[symbol] = { ...(hit ? rangeOf(candles) : saved), checkedThrough };
  return hit ? { symbol, ...hit, support: saved.support, resistance: saved.resistance } : { symbol, kind: 'QUIET', ...saved };
}

function contextLine(analysis) {
  const { mtf, derivatives, confluence } = analysis;
  const parts = [`HTF ${mtf.direction} ${mtf.aligned}/${mtf.of}`, `OI ${derivatives.oi24h.regime}`];
  if (confluence) parts.push(`confluence ${confluence.score}/${confluence.max} ${confluence.grade[0]}`);
  return parts.join(' · ');
}

const price = (n) => code(String(n));

function block(alert) {
  const head = fmt`${ICON[alert.kind]} ${bold(alert.symbol)} 4h ${bold(alert.kind)}`;
  const levels = fmt`Close ${price(alert.close)} vs ${COMPARE[alert.kind]} ${price(alert.level)}\n24h range ${price(alert.support)} – ${price(alert.resistance)}`;
  const context = alert.context ? fmt`${alert.context}\n` : '';
  return fmt`${head}\n${levels}\n${context}${italic(STANCE[alert.kind])}`;
}

/** Native-entity Telegram payload for one or more breaks. */
export function buildPayload(alerts, market = 'Binance futures') {
  const closeTimeMs = Math.max(...alerts.map((a) => a.closeTimeMs));
  const closed = `${new Date(closeTimeMs).toISOString().slice(11, 16)} UTC`;
  const footer = fmt`${italic(market, ' · candle closed ')}${dateTime(closed, Math.floor(closeTimeMs / 1000), 'dt')}`;
  return toTelegramPayload(fmt`${join(alerts.map(block), '\n\n')}\n\n${footer}`);
}

async function sendTelegram(payload) {
  const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chatId } = process.env;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, ...payload }),
    });
    return res.status;
  } catch {
    return 'send failed'; // never print the error: it can carry the bot URL
  }
}

async function loadState() {
  try {
    return JSON.parse(await readFile(STATE_PATH, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(`unreadable state file ${STATE_PATH}: ${error.message}`);
  }
}

async function saveState(state) {
  await mkdir(dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(state));
}

async function addContext(alert) {
  try {
    const analysis = await analyzeSymbol(alert.symbol);
    return { ...alert, analysis, context: contextLine(analysis) };
  } catch {
    return alert; // context is a bonus; the break alert must still go out
  }
}

export function parseSymbols(arg) {
  const symbols = (arg ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const valid = symbols.length > 0 && symbols.length <= MAX_SYMBOLS && symbols.every((s) => SYMBOL_PATTERN.test(s));
  return valid ? symbols : null;
}

function printResults(results) {
  for (const r of results.filter((x) => !ICON[x.kind])) {
    console.log(r.kind === 'ERROR' ? `${r.symbol} ERROR ${r.detail}` : `${r.symbol} ${r.kind.toLowerCase()} range ${r.support}-${r.resistance}, no break`);
  }
}

/** Prints the alert and sends it when configured. false = delivery failed, caller must keep old state. */
async function deliver(alerts) {
  const payload = buildPayload(alerts);
  console.log(payload.text);
  if (process.env.DRY || !process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
    console.log('Telegram not sent: set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in this process environment.');
    return true;
  }
  const status = await sendTelegram(payload);
  console.log(`Telegram HTTP ${status}`);
  return status === 200;
}

/**
 * One closed-4h check over all symbols. Idempotent: state advances only past candles already
 * checked, so it is safe to call from cron, /loop or a WebSocket trigger. Never exits the process.
 */
export async function runCheck(symbols) {
  const state = await loadState();
  const nowMs = Date.now();
  const results = await Promise.all(symbols.map((s) => checkSymbol(s, state, nowMs).catch((e) => ({ symbol: s, kind: 'ERROR', detail: e.message }))));
  printResults(results);
  const alerts = await Promise.all(results.filter((x) => ICON[x.kind]).map(addContext));
  if (alerts.length && !(await deliver(alerts))) return { ok: false }; // old state kept so the next run re-alerts
  if (process.env.DRY) return { ok: true };
  await appendEntries(alerts.filter((a) => a.analysis).map((a) => entryFrom(a.analysis, 'watch', { trigger: a.kind }))).catch((e) => console.error(`journal not updated: ${e.message}`));
  await saveState(state);
  return { ok: true };
}

async function main() {
  const symbols = parseSymbols(process.argv[2]);
  if (!symbols) {
    console.error(`usage: watch.mjs SYMBOL[,SYMBOL...] (max ${MAX_SYMBOLS}, USDT pairs)`);
    process.exit(2);
  }
  if (!(await runCheck(symbols)).ok) process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
