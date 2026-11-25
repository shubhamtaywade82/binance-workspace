// Append-only journal of analyzer calls plus a mechanical replay of what happened next.
// Usage: node journal.mjs review [N]   (N = latest entries to score, default 60)
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseKlines } from './smc.mjs';

const JOURNAL_PATH = process.env.BIAS_JOURNAL ?? join(homedir(), '.cache', 'binance-bias', 'journal.jsonl');
const EXPIRY_MS = 7 * 24 * 3600 * 1000;
const DEDUPE_MS = 60 * 60 * 1000;
const NO_PLAN_WINDOW_MS = 24 * 3600 * 1000;
const DEFAULT_REVIEW_COUNT = 60;
const RESOLVED = ['target1', 'target2', 'stopped'];

const round = (x) => +x.toFixed(2);

/** Compact record of one analyzer result; extra carries e.g. the alert trigger. */
export function entryFrom(analysis, source, extra = {}) {
  const poi = analysis.plan?.poi;
  return {
    ts: Date.parse(analysis.asOf), symbol: analysis.symbol, source, price: analysis.price,
    direction: analysis.mtf.direction, grade: analysis.confluence?.grade[0] ?? null,
    score: analysis.confluence?.score ?? null, aligned: analysis.mtf.aligned,
    oiRegime24h: analysis.derivatives.oi24h.regime,
    plan: poi ? { poiLow: poi.low, poiHigh: poi.high, invalidation: analysis.plan.invalidation, targets: analysis.plan.targets } : null,
    ...extra,
  };
}

export async function readJournal(path = JOURNAL_PATH) {
  try {
    return (await readFile(path, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error(`unreadable journal ${path}: ${error.message}`);
  }
}

const isRepeat = (entry, last) =>
  last && entry.ts - last.ts < DEDUPE_MS && entry.direction === last.direction && entry.plan?.poiLow === last.plan?.poiLow;

/** Appends entries, skipping a symbol's repeat of an unchanged call within the hour. */
export async function appendEntries(entries, path = JOURNAL_PATH) {
  const existing = await readJournal(path);
  const lastBySymbol = new Map(existing.map((e) => [e.symbol, e]));
  const fresh = [];
  for (const entry of entries) {
    if (isRepeat(entry, lastBySymbol.get(entry.symbol))) continue;
    lastBySymbol.set(entry.symbol, entry);
    fresh.push(entry);
  }
  if (!fresh.length) return 0;
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, fresh.map((e) => JSON.stringify(e) + '\n').join(''));
  return fresh.length;
}

function tradeGeometry({ direction, plan }) {
  const short = direction === 'short';
  const mid = (plan.poiLow + plan.poiHigh) / 2;
  const risk = Math.abs(plan.invalidation - mid);
  return {
    toR: (price) => (short ? mid - price : price - mid) / risk,
    filled: (c) => (short ? c.h >= mid : c.l <= mid),
    stopped: (c) => (short ? c.h >= plan.invalidation : c.l <= plan.invalidation),
    reached: (c, level) => level != null && (short ? c.l <= level : c.h >= level),
    favorable: (c) => (short ? mid - c.l : c.h - mid) / risk,
    adverse: (c) => (short ? c.h - mid : mid - c.l) / risk,
  };
}

/**
 * Limit order at the POI midpoint. Conservative: the stop wins any same-candle tie and the fill
 * candle only checks the stop. T1 is the exit; target2 means price later reached T2 too.
 */
export function replayPlan(entry, candles) {
  const g = tradeGeometry(entry);
  const [t1, t2] = entry.plan.targets;
  let filled = false;
  let mfe = 0;
  let mae = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const excursions = () => ({ mfeR: round(mfe), maeR: round(mae) });
    if (!filled) {
      if (!g.filled(c)) {
        if (g.reached(c, t1)) return { status: 'missed' };
        continue;
      }
      filled = true;
      if (g.stopped(c)) return { status: 'stopped', r: -1, ...excursions() };
      continue;
    }
    if (g.stopped(c)) return { status: 'stopped', r: -1, ...excursions() };
    mfe = Math.max(mfe, g.favorable(c));
    mae = Math.max(mae, g.adverse(c));
    if (g.reached(c, t1)) {
      const reachedT2 = candles.slice(i).some((x) => g.reached(x, t2));
      return { status: reachedT2 ? 'target2' : 'target1', r: round(g.toR(reachedT2 ? t2 : t1)), ...excursions() };
    }
  }
  if (!filled) return { status: 'pending' };
  return { status: 'open', r: round(g.toR(candles.at(-1).c)), mfeR: round(mfe), maeR: round(mae) };
}

function replayNoPlan(entry, candles) {
  const window = candles.filter((c) => c.ct <= entry.ts + NO_PLAN_WINDOW_MS);
  if (!window.length) return { status: 'no-plan' };
  return {
    status: 'no-plan',
    maxUpPct: round((Math.max(...window.map((c) => c.h)) / entry.price - 1) * 100),
    maxDownPct: round((1 - Math.min(...window.map((c) => c.l)) / entry.price) * 100),
  };
}

export function scoreEntry(entry, candles, nowMs = Date.now()) {
  if (!entry.plan) return replayNoPlan(entry, candles);
  const outcome = replayPlan(entry, candles);
  const stale = nowMs - entry.ts > EXPIRY_MS;
  if (stale && outcome.status === 'open') return { ...outcome, status: 'expired' };
  if (stale && outcome.status === 'pending') return { ...outcome, status: 'no fill' };
  return outcome;
}

function stats(rows) {
  const count = (...statuses) => rows.filter((r) => statuses.includes(r.outcome.status)).length;
  const resolved = rows.filter((r) => RESOLVED.includes(r.outcome.status));
  const wins = count('target1', 'target2');
  const losses = count('stopped');
  return {
    calls: rows.length, wins, losses, open: count('open'), pending: count('pending'),
    missed: count('missed'), expired: count('expired', 'no fill'),
    winRate: wins + losses ? round(wins / (wins + losses)) : null,
    avgR: resolved.length ? round(resolved.reduce((s, r) => s + r.outcome.r, 0) / resolved.length) : null,
  };
}

function groupStats(rows, keyOf) {
  const groups = Map.groupBy(rows, keyOf);
  return Object.fromEntries([...groups].sort().map(([key, group]) => [key, stats(group)]));
}

export function summarize(rows) {
  const planned = rows.filter((r) => r.outcome.status !== 'no-plan');
  return {
    overall: stats(planned),
    byGrade: groupStats(planned, (r) => r.entry.grade ?? '-'),
    bySymbol: groupStats(planned, (r) => r.entry.symbol),
    standAside: rows.length - planned.length,
  };
}

async function candlesSince(entry) {
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${entry.symbol}&interval=15m&startTime=${entry.ts}&limit=${EXPIRY_MS / 900000}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} klines ${entry.symbol}`);
  return parseKlines(await res.json(), Date.now());
}

async function review(count) {
  const entries = (await readJournal()).slice(-count);
  const rows = await Promise.all(entries.map(async (entry) => {
    try {
      return { entry, outcome: scoreEntry(entry, await candlesSince(entry)) };
    } catch (error) {
      return { entry, outcome: { status: 'error', note: error.message } };
    }
  }));
  const scored = rows.filter((r) => r.outcome.status !== 'error');
  console.log(JSON.stringify({ entries: rows, summary: summarize(scored), journalPath: JOURNAL_PATH }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== 'review') {
    console.error('usage: journal.mjs review [N]');
    process.exit(2);
  }
  await review(Number(process.argv[3]) || DEFAULT_REVIEW_COUNT);
}
