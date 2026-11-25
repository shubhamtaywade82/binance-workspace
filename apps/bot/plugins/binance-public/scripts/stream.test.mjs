import test from 'node:test';
import assert from 'node:assert/strict';
import { backoffMs, createRunner, isCandleClose, startStream, streamUrl } from './stream.mjs';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const kline = (symbol, x, i = '4h') => JSON.stringify({ stream: `${symbol}@kline_${i}`, data: { e: 'kline', k: { x, i } } });

class FakeSocket {
  static instances = [];
  constructor(url) { this.url = url; this.closed = false; FakeSocket.instances.push(this); }
  close() { this.closed = true; }
}

function harness(overrides = {}) {
  FakeSocket.instances = [];
  const calls = { checks: 0 };
  const runner = createRunner(async () => ({ ok: ++calls.checks > 0 }), { debounceMs: 5 });
  const stream = startStream({
    symbols: ['SOLUSDT', 'ETHUSDT'], runner, log: () => {}, WebSocketImpl: FakeSocket,
    staleMs: 1000, backoff: { base: 5, max: 20 }, ...overrides,
  });
  return { calls, runner, stream, socket: () => FakeSocket.instances.at(-1) };
}

test('streamUrl uses the /market route with one lowercase kline stream per symbol', () => {
  assert.equal(streamUrl(['SOLUSDT', 'XRPUSDT']), 'wss://fstream.binance.com/market/stream?streams=solusdt@kline_4h/xrpusdt@kline_4h');
});

test('isCandleClose is true only for the final 4h push', () => {
  assert.equal(isCandleClose(kline('solusdt', true)), true);
  assert.equal(isCandleClose(kline('solusdt', false)), false);
  assert.equal(isCandleClose(kline('solusdt', true, '1h')), false);
  assert.equal(isCandleClose('not json'), false);
});

test('backoffMs doubles and caps', () => {
  assert.deepEqual([0, 1, 2, 10].map((n) => backoffMs(n, { base: 1000, max: 60000 })), [1000, 2000, 4000, 60000]);
});

test('runner merges a burst of triggers into one check and serializes runs', async () => {
  let running = 0;
  let overlap = false;
  let checks = 0;
  const runner = createRunner(async () => {
    checks++;
    overlap ||= ++running > 1;
    await wait(20);
    running--;
    return { ok: true };
  }, { debounceMs: 5 });
  runner.trigger(); runner.trigger(); runner.trigger();
  await wait(15);
  runner.trigger(); // lands while the first check is still running
  await wait(80);
  await runner.idle();
  assert.equal(checks, 2);
  assert.equal(overlap, false);
});

test('runner retries a failed delivery, then stops after the retry budget', async () => {
  let checks = 0;
  const runner = createRunner(async () => ({ ok: ++checks === 3 }), { retryDelays: [1, 1] });
  await runner.runNow();
  assert.equal(checks, 3);
  let always = 0;
  const failing = createRunner(async () => { always++; throw new Error('boom'); }, { retryDelays: [1, 1] });
  await failing.runNow();
  assert.equal(always, 3);
});

test('connect runs a catch-up check; only a closed candle triggers another, once for all symbols', async () => {
  const { calls, socket } = harness();
  socket().onopen();
  await wait(15);
  assert.equal(calls.checks, 1);
  socket().onmessage({ data: kline('solusdt', false) });
  await wait(20);
  assert.equal(calls.checks, 1);
  socket().onmessage({ data: kline('solusdt', true) });
  socket().onmessage({ data: kline('ethusdt', true) });
  await wait(30);
  assert.equal(calls.checks, 2);
});

test('error plus close reconnect exactly once, then catch up again on the new socket', async () => {
  const { calls, socket } = harness();
  const first = socket();
  first.onopen();
  first.onerror();
  first.onclose();
  await wait(30);
  assert.equal(FakeSocket.instances.length, 2);
  assert.equal(first.closed, true);
  first.onmessage({ data: kline('solusdt', true) }); // ignored: stale socket
  socket().onopen();
  await wait(30);
  assert.equal(calls.checks, 2);
});

test('watchdog reconnects a socket that goes silent', async () => {
  const { socket } = harness({ staleMs: 20 });
  socket().onopen();
  await wait(60);
  assert.ok(FakeSocket.instances.length >= 2);
});

test('close stops reconnecting', async () => {
  const { stream, socket } = harness();
  const first = socket();
  stream.close();
  first.onclose();
  await wait(30);
  assert.equal(FakeSocket.instances.length, 1);
});
