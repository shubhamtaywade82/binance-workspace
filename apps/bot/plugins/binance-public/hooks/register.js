import {
  formatTicker,
  normalizeTicker,
  parseExchangeError,
  parseQuoteArgs,
  parseWatchlistArgs,
  tickerUrl,
} from './market-data.js';

const SERVER_TIMEOUT_MS = 12_000;

async function fetchTicker($, symbol, market) {
  const response = await $.http.fetch(tickerUrl(symbol, market), {
    method: 'GET',
    headers: { accept: 'application/json' },
    timeoutMs: SERVER_TIMEOUT_MS,
  });
  if (!response.ok) throw new Error(parseExchangeError(response.text, response.status));

  let payload;
  try {
    payload = JSON.parse(response.text);
  } catch {
    throw new Error('Binance returned a response that was not valid JSON.');
  }
  return normalizeTicker(payload, symbol);
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'binance-quote',
      description: 'Fetch a read-only Binance Spot or USD-M Futures 24-hour ticker.',
      argumentHint: '<SYMBOL> [spot|futures]',
    });
    await $.command.register({
      name: 'binance-watchlist',
      description: 'Fetch a small read-only Binance ticker watchlist.',
      argumentHint: '<SYMBOL[,SYMBOL...]> [spot|futures]',
    });
    return next(e);
  }).catch(($, e, next) => {
    $.ui.log('Binance Public mod could not register its slash commands.');
    return next(e);
  });

  on('command.run', { command: 'binance-quote' }, async ($, e) => {
    try {
      const { symbol, market } = parseQuoteArgs(e.args);
      const ticker = await fetchTicker($, symbol, market);
      return { text: formatTicker(ticker, market) };
    } catch (error) {
      return { text: 'Binance quote unavailable: ' + (error instanceof Error ? error.message : String(error)) };
    }
  });

  on('command.run', { command: 'binance-watchlist' }, async ($, e) => {
    try {
      const { symbols, market } = parseWatchlistArgs(e.args);
      const tickers = await Promise.all(symbols.map((symbol) => fetchTicker($, symbol, market)));
      const rows = tickers.map((ticker) => {
        const change = (ticker.priceChangePercent > 0 ? '+' : '') + ticker.priceChangePercent.toFixed(2) + '%';
        const price = ticker.lastPrice.toLocaleString('en-US', { maximumFractionDigits: 8 });
        const volume = ticker.quoteVolume?.toLocaleString('en-US', { maximumFractionDigits: 2 }) ?? 'n/a';
        return '| ' + ticker.symbol + ' | ' + price + ' | ' + change + ' | ' + volume + ' |';
      });
      return {
        text: [
          '**Binance ' + market.toUpperCase() + ' public ticker snapshot**',
          '| Symbol | Last price | 24h change | 24h quote volume |',
          '|---|---:|---:|---:|',
          ...rows,
          '',
          '_Public exchange data; snapshot timestamps may differ slightly across symbols. Not an execution quote._',
        ].join('\n'),
      };
    } catch (error) {
      return { text: 'Binance watchlist unavailable: ' + (error instanceof Error ? error.message : String(error)) };
    }
  });
}
