import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEntries, entryFrom, readJournal, replayPlan, scoreEntry, summarize } from './journal.mjs';

const shortEntry = { ts: 0, symbol: 'SOLUSDT', price: 100, direction: 'short', grade: 'A', plan: { poiLow: 100, poiHigh: 102, invalidation: 104, targets: [96, 92] } };
const longEntry = { ...shortEntry, direction: 'long', plan: { poiLow: 100, poiHigh: 102, invalidation: 98, targets: [106, 110] } };
const bar = (h, l, c = (h + l) / 2) => ({ h, l, c, ct: 1 });

test('short: fill at the POI midpoint, then first target is a win of about 1.67R', () => {
  const result = replayPlan(shortEntry, [bar(99, 97), bar(101.2, 100), bar(100, 95)]);
  assert.deepEqual([result.status, result.r], ['target1', 1.67]);
});

test('short: price later reaching the second target upgrades the outcome to target2 (3R)', () => {
  const result = replayPlan(shortEntry, [bar(101.2, 100), bar(100, 91)]);
  assert.deepEqual([result.status, result.r], ['target2', 3]);
});

test('short: a stop after the fill is -1R and records the adverse excursion', () => {
  const result = replayPlan(shortEntry, [bar(101.5, 100), bar(102, 100), bar(105, 100)]);
  assert.deepEqual([result.status, result.r], ['stopped', -1]);
  assert.ok(result.maeR > 0);
});

test('a fill candle that also trades through the stop counts as stopped', () => {
  assert.equal(replayPlan(shortEntry, [bar(105, 100)]).status, 'stopped');
});

test('price running to the target without ever filling is a miss, not a win', () => {
  assert.equal(replayPlan(shortEntry, [bar(99, 95)]).status, 'missed');
});

test('unfilled and unresolved outcomes: pending and open with unrealized R', () => {
  assert.equal(replayPlan(shortEntry, [bar(99, 98)]).status, 'pending');
  const open = replayPlan(shortEntry, [bar(101.5, 100, 100.5)]);
  assert.deepEqual([open.status, open.r], ['open', 0.17]);
});

test('long mirrors the short logic', () => {
  const result = replayPlan(longEntry, [bar(103, 100.9), bar(107, 103)]);
  assert.deepEqual([result.status, result.r], ['target1', 1.67]);
});

test('scoreEntry expires stale unresolved calls and keeps stand-aside excursions', () => {
  const week = 8 * 24 * 3600 * 1000;
  assert.equal(scoreEntry(shortEntry, [bar(99, 98)], week).status, 'no fill');
  assert.equal(scoreEntry(shortEntry, [bar(101.5, 100, 100.5)], week).status, 'expired');
  const aside = scoreEntry({ ts: 0, price: 100, plan: null }, [{ h: 103, l: 98, c: 100, ct: 1000 }]);
  assert.deepEqual([aside.status, aside.maxUpPct, aside.maxDownPct], ['no-plan', 3, 2]);
});

test('summarize groups by grade and reports win rate and average R', () => {
  const row = (grade, status, r) => ({ entry: { grade, symbol: 'SOLUSDT' }, outcome: { status, r } });
  const summary = summarize([row('A', 'target1', 2), row('A', 'stopped', -1), row('C', 'stopped', -1), row('A', 'pending'), { entry: {}, outcome: { status: 'no-plan' } }]);
  assert.deepEqual([summary.byGrade.A.winRate, summary.byGrade.A.avgR, summary.byGrade.A.pending], [0.5, 0.5, 1]);
  assert.equal(summary.byGrade.C.winRate, 0);
  assert.equal(summary.standAside, 1);
});

test('entryFrom compacts an analysis and appendEntries skips an unchanged repeat within the hour', async () => {
  const analysis = {
    symbol: 'XRPUSDT', price: 0.9, asOf: '2026-11-25T13:00:00.000Z', mtf: { direction: 'short', aligned: 4 },
    confluence: { grade: 'A', score: 5 }, derivatives: { oi24h: { regime: 'short build-up' } },
    plan: { poi: { low: 0.93, high: 0.94 }, invalidation: 0.95, targets: [0.89] },
  };
  const entry = entryFrom(analysis, 'report');
  assert.deepEqual([entry.grade, entry.plan.poiLow, entry.ts], ['A', 0.93, Date.parse(analysis.asOf)]);
  const path = join(await mkdtemp(join(tmpdir(), 'journal-')), 'j.jsonl');
  assert.equal(await appendEntries([entry], path), 1);
  assert.equal(await appendEntries([{ ...entry, ts: entry.ts + 600000 }], path), 0);
  assert.equal(await appendEntries([{ ...entry, ts: entry.ts + 7200000 }], path), 1);
  assert.equal((await readJournal(path)).length, 2);
  assert.equal((await readFile(path, 'utf8')).split('\n').filter(Boolean).length, 2);
});
