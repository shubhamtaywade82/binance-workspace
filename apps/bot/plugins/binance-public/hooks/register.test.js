import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatTicker,
  normalizeTicker,
  normalizeSymbol,
  parseExchangeError,
  parseQuoteArgs,
  parseWatchlistArgs,
  tickerUrl,
} from './market-data.js';
import { register } from './register.js';

test('normalizes common futures symbol suffixes', () => {
  assert.equal(normalizeSymbol(' solusdt.P '), 'SOLUSDT');
  assert.equal(normalizeSymbol('BTCUSDT-PERP'), 'BTCUSDT');
});

test('rejects malformed symbols rather than interpolating them into a URL', () => {
  assert.throws(() => normalizeSymbol('BTC/USDT'), /Invalid Binance symbol/);
  assert.throws(() => normalizeSymbol('https://evil.example'), /Invalid Binance symbol/);
});

test('parses quote command with spot default', () => {
  assert.deepEqual(parseQuoteArgs('btcusdt'), { symbol: 'BTCUSDT', market: 'spot' });
});

test('parses explicit futures quote command', () => {
  assert.deepEqual(parseQuoteArgs('ethusdt futures'), { symbol: 'ETHUSDT', market: 'futures' });
});

test('rejects extra quote command arguments', () => {
  assert.throws(() => parseQuoteArgs('BTCUSDT spot extra'), /Usage:/);
});

test('parses bounded watchlists and normalizes symbols', () => {
  assert.deepEqual(parseWatchlistArgs('btcUsdt,ethUsdt futures'), {
    symbols: ['BTCUSDT', 'ETHUSDT'],
    market: 'futures',
  });
  assert.deepEqual(parseWatchlistArgs('BTCUSDT, ETHUSDT futures'), {
    symbols: ['BTCUSDT', 'ETHUSDT'],
    market: 'futures',
  });
});

test('rejects watchlists above eight symbols and duplicates', () => {
  assert.throws(() => parseWatchlistArgs('AABB,BBCC,CCDD,DDEE,EEFF,FFGG,GGHH,HHII,IIJJ'), /at most 8/);
  assert.throws(() => parseWatchlistArgs('BTCUSDT,BTCUSDT'), /duplicate/);
});

test('uses fixed Binance public Spot and USD-M Futures ticker hosts', () => {
  assert.equal(
    tickerUrl('BTCUSDT', 'spot'),
    'https://data-api.binance.vision/api/v3/ticker/24hr?symbol=BTCUSDT',
  );
  assert.equal(
    tickerUrl('BTCUSDT', 'futures'),
    'https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=BTCUSDT',
  );
});

test('validates a ticker payload against its requested symbol', () => {
  const ticker = normalizeTicker({
    symbol: 'BTCUSDT', lastPrice: '101.25', priceChange: '1.25',
    priceChangePercent: '1.25', highPrice: '103', lowPrice: '99',
    quoteVolume: '12345.6', closeTime: 1_700_000_000_000,
  }, 'BTCUSDT');
  assert.equal(ticker.lastPrice, 101.25);
  assert.equal(ticker.quoteVolume, 12345.6);
  assert.throws(() => normalizeTicker({ symbol: 'ETHUSDT', lastPrice: '1', priceChangePercent: '0' }, 'BTCUSDT'), /mismatch/);
  assert.throws(() => normalizeTicker({ symbol: 'BTCUSDT', lastPrice: 'NaN', priceChangePercent: '0' }, 'BTCUSDT'), /non-numeric/);
});

test('formats ticker without inventing optional values', () => {
  const ticker = normalizeTicker({ symbol: 'SOLUSDT', lastPrice: '145.5', priceChangePercent: '-2.5' }, 'SOLUSDT');
  const output = formatTicker(ticker, 'spot');
  assert.match(output, /SOLUSDT · SPOT/);
  assert.match(output, /-2\.50%/);
  assert.match(output, /24h high \/ low: n\/a \/ n\/a/);
});

test('surfaces structured Binance HTTP errors', () => {
  assert.equal(parseExchangeError('{"code":-1121,"msg":"Invalid symbol."}', 400), 'Binance request failed (HTTP 400): -1121: Invalid symbol.');
});

test('registers both slash commands at session start', async () => {
  const handlers = new Map();
  const commands = [];
  const on = (event, matcherOrHandler, maybeHandler) => {
    const matcher = typeof matcherOrHandler === 'function' ? {} : matcherOrHandler;
    const handler = typeof matcherOrHandler === 'function' ? matcherOrHandler : maybeHandler;
    handlers.set(event + ':' + (matcher.command ?? '*'), handler);
    return { catch() {} };
  };
  register(on);
  const sessionStart = handlers.get('session.start:*');
  await sessionStart({ command: { register: async (spec) => commands.push(spec) } }, {}, async () => ({ ok: true }));
  assert.deepEqual(commands.map((item) => item.name), ['binance-quote', 'binance-watchlist']);
});

test('quote command fetches a public ticker and formats returned fields', async () => {
  const handlers = new Map();
  const on = (event, matcherOrHandler, maybeHandler) => {
    const matcher = typeof matcherOrHandler === 'function' ? {} : matcherOrHandler;
    const handler = typeof matcherOrHandler === 'function' ? matcherOrHandler : maybeHandler;
    handlers.set(event + ':' + (matcher.command ?? '*'), handler);
    return { catch() {} };
  };
  register(on);
  let requestedUrl;
  const $ = {
    http: {
      fetch: async (url, init) => {
        requestedUrl = url;
        assert.equal(init.method, 'GET');
        assert.equal(init.timeoutMs, 12_000);
        assert.equal(init.headers.accept, 'application/json');
        return {
          ok: true,
          status: 200,
          text: JSON.stringify({
            symbol: 'BTCUSDT', lastPrice: '90000', priceChange: '1000',
            priceChangePercent: '1.12', highPrice: '91000', lowPrice: '88000', quoteVolume: '500000000', closeTime: 1_700_000_000_000,
          }),
        };
      },
    },
  };
  const result = await handlers.get('command.run:binance-quote')($, { args: 'btcusdt' });
  assert.equal(requestedUrl, 'https://data-api.binance.vision/api/v3/ticker/24hr?symbol=BTCUSDT');
  assert.match(result.text, /BTCUSDT · SPOT/);
  assert.match(result.text, /90,000/);
});

test('watchlist command fetches each requested public futures ticker', async () => {
  const handlers = new Map();
  const on = (event, matcherOrHandler, maybeHandler) => {
    const matcher = typeof matcherOrHandler === 'function' ? {} : matcherOrHandler;
    const handler = typeof matcherOrHandler === 'function' ? matcherOrHandler : maybeHandler;
    handlers.set(event + ':' + (matcher.command ?? '*'), handler);
    return { catch() {} };
  };
  register(on);
  const urls = [];
  const $ = {
    http: {
      fetch: async (url) => {
        urls.push(url);
        const symbol = new URL(url).searchParams.get('symbol');
        return { ok: true, status: 200, text: JSON.stringify({ symbol, lastPrice: '12.5', priceChangePercent: '0.25', quoteVolume: '1000' }) };
      },
    },
  };
  const result = await handlers.get('command.run:binance-watchlist')($, { args: 'BTCUSDT, ETHUSDT futures' });
  assert.equal(urls.length, 2);
  assert.ok(urls.every((url) => url.startsWith('https://fapi.binance.com/fapi/v1/ticker/24hr?')));
  assert.match(result.text, /BTCUSDT/);
  assert.match(result.text, /ETHUSDT/);
});

test('quote command converts upstream HTTP errors to bounded diagnostics', async () => {
  const handlers = new Map();
  const on = (event, matcherOrHandler, maybeHandler) => {
    const matcher = typeof matcherOrHandler === 'function' ? {} : matcherOrHandler;
    const handler = typeof matcherOrHandler === 'function' ? matcherOrHandler : maybeHandler;
    handlers.set(event + ':' + (matcher.command ?? '*'), handler);
    return { catch() {} };
  };
  register(on);
  const $ = { http: { fetch: async () => ({ ok: false, status: 400, text: '{"code":-1121,"msg":"Invalid symbol."}' }) } };
  const result = await handlers.get('command.run:binance-quote')($, { args: 'NOTREALUSDT spot' });
  assert.match(result.text, /HTTP 400/);
  assert.match(result.text, /Invalid symbol/);
});
