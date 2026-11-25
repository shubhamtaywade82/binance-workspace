import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPayload, detectBreak, rangeOf } from './watch.mjs';

const candle = (ct, l, h, c) => ({ ct, l, h, c });
const saved = { support: 10, resistance: 20, checkedThrough: 100 };

test('rangeOf uses the lowest low and highest high of the last 6 candles', () => {
  const candles = [candle(1, 1, 99, 5), ...[12, 13, 14, 15, 16, 17].map((n) => candle(n, n - 2, n + 2, n))];
  assert.deepEqual(rangeOf(candles), { support: 10, resistance: 19 });
});

test('detectBreak flags the first close below support after the last check', () => {
  const candles = [candle(90, 5, 25, 5), candle(200, 9, 15, 9.5), candle(300, 8, 12, 11)];
  assert.deepEqual(detectBreak(candles, saved), { kind: 'BREAKDOWN', close: 9.5, level: 10, closeTimeMs: 200 });
});

test('detectBreak flags a close above resistance and ignores already-checked candles', () => {
  assert.equal(detectBreak([candle(90, 5, 25, 5)], saved), null);
  const hit = detectBreak([candle(200, 15, 22, 21)], saved);
  assert.deepEqual([hit.kind, hit.level], ['RECLAIM', 20]);
});

test('detectBreak stays silent for closes inside the range', () => {
  assert.equal(detectBreak([candle(200, 9, 21, 15)], saved), null);
});

test('buildPayload sends native entities with styled symbol, monospace prices and local time', () => {
  const alert = { symbol: 'SOLUSDT', kind: 'BREAKDOWN', close: 67.55, level: 67.72, support: 67.72, resistance: 71.69, closeTimeMs: 1795612799999, context: 'HTF short 3/4 · OI short build-up' };
  const { text, entities } = buildPayload([alert]);
  assert.match(text, /^🔻 SOLUSDT 4h BREAKDOWN\nClose 67.55 vs support < 67.72\n24h range 67.72 – 71.69\nHTF short 3\/4/);
  assert.ok(entities.some((e) => e.type === 'bold' && text.slice(e.offset, e.offset + e.length) === 'SOLUSDT'));
  assert.ok(entities.some((e) => e.type === 'code' && text.slice(e.offset, e.offset + e.length) === '67.55'));
  assert.ok(entities.some((e) => e.type === 'date_time'));
  assert.equal(JSON.stringify(buildPayload([alert])).includes('parse_mode'), false);
});
