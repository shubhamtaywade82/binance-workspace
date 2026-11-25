// Event-driven alerting: the Binance 4h kline WebSocket triggers watch.mjs's closed-candle check
// the moment a candle closes. The socket is only a trigger; range logic, state and dedupe stay in
// runCheck, so a missed message or a reconnect can never lose or repeat an alert.
// Usage: node stream.mjs SOLUSDT,ETHUSDT,XRPUSDT   (env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)
import { fileURLToPath } from 'node:url';
import { parseSymbols, runCheck } from './watch.mjs';

// USD-M kline streams moved to the /market route (the legacy /stream route was retired).
const BASE_URL = 'wss://fstream.binance.com/market/stream';
const INTERVAL = '4h';
const DEBOUNCE_MS = 3000; // lets Binance finalize the candle and merges the symbols that close together
const STALE_MS = 60_000; // kline pushes arrive about once a second; this much silence means a dead socket
const BACKOFF = { base: 1000, max: 60_000 };
const RETRY_DELAYS_MS = [30_000, 60_000, 120_000]; // a failed delivery keeps old state; retry soon, not in 4h

export const streamUrl = (symbols, interval = INTERVAL) =>
  `${BASE_URL}?streams=${symbols.map((s) => `${s.toLowerCase()}@kline_${interval}`).join('/')}`;

/** True only for the final push of a candle (k.x), which Binance sends once at close. */
export function isCandleClose(raw, interval = INTERVAL) {
  try {
    const kline = JSON.parse(raw).data?.k;
    return kline?.x === true && kline.i === interval;
  } catch {
    return false;
  }
}

export const backoffMs = (attempt, { base, max } = BACKOFF) => Math.min(max, base * 2 ** attempt);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Serializes checks (one at a time, never two writing the state file), debounces triggers, retries failures. */
export function createRunner(check, { debounceMs = DEBOUNCE_MS, retryDelays = RETRY_DELAYS_MS, log = () => {} } = {}) {
  let timer;
  let chain = Promise.resolve();
  const attempt = async () => {
    try {
      return (await check()).ok;
    } catch (error) {
      log(`check failed: ${error.message}`);
      return false;
    }
  };
  const runWithRetry = async () => {
    for (let i = 0; ; i++) {
      if (await attempt()) return;
      if (i >= retryDelays.length) return log('giving up until the next candle close or reconnect');
      log(`retrying in ${retryDelays[i] / 1000}s`);
      await sleep(retryDelays[i]);
    }
  };
  const runNow = () => (chain = chain.then(runWithRetry));
  return {
    runNow,
    trigger() {
      clearTimeout(timer);
      timer = setTimeout(runNow, debounceMs);
    },
    idle: () => chain,
  };
}

/** Connects, reconnects with backoff, and runs a catch-up check on every (re)connect. */
export function startStream({ symbols, runner, log, interval = INTERVAL, WebSocketImpl = WebSocket, staleMs = STALE_MS, backoff = BACKOFF }) {
  let socket = null;
  let attempts = 0;
  let stopped = false;
  let watchdog;
  let reconnectTimer;

  const reconnect = () => {
    clearTimeout(watchdog);
    const old = socket;
    socket = null; // events from the old socket are ignored from here on
    try { old?.close(); } catch { /* already closed */ }
    if (stopped) return;
    const wait = backoffMs(attempts++, backoff);
    log(`disconnected, reconnecting in ${wait}ms`);
    reconnectTimer = setTimeout(connect, wait);
  };
  const armWatchdog = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => { log('no data, socket looks dead'); reconnect(); }, staleMs);
  };

  function connect() {
    const current = new WebSocketImpl(streamUrl(symbols, interval));
    socket = current;
    const live = () => socket === current && !stopped;
    current.onopen = () => {
      if (!live()) return;
      attempts = 0;
      log(`connected: ${symbols.length} symbols, ${interval} candles`);
      armWatchdog();
      runner.runNow(); // catch up on anything that closed while we were away
    };
    current.onmessage = (event) => {
      if (!live()) return;
      armWatchdog();
      if (isCandleClose(event.data, interval)) {
        log(`${interval} candle closed`);
        runner.trigger();
      }
    };
    current.onerror = current.onclose = () => live() && reconnect();
  }

  connect();
  return {
    close() {
      stopped = true;
      clearTimeout(watchdog);
      clearTimeout(reconnectTimer);
      try { socket?.close(); } catch { /* already closed */ }
    },
  };
}

async function main() {
  const symbols = parseSymbols(process.argv[2]);
  if (!symbols) {
    console.error('usage: stream.mjs SYMBOL[,SYMBOL...] (max 5, USDT pairs)');
    process.exit(2);
  }
  const log = (message) => console.log(`${new Date().toISOString()} ${message}`);
  const runner = createRunner(() => runCheck(symbols), { log });
  const stream = startStream({ symbols, runner, log });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      stream.close();
      await runner.idle(); // let an in-flight check finish writing state
      process.exit(0);
    });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
