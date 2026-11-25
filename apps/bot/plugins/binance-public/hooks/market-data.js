const SYMBOL_PATTERN = /^[A-Z0-9]{2,30}$/;
const MAX_WATCHLIST_SIZE = 8;

export function normalizeSymbol(value) {
  if (typeof value !== 'string') throw new TypeError('Symbol must be a string.');
  const symbol = value.trim().toUpperCase().replace(/\.(?:P|PERP)$|-(?:PERP|P)$/i, '');
  if (!SYMBOL_PATTERN.test(symbol)) {
    throw new Error('Invalid Binance symbol "' + value + '". Use an alphanumeric pair such as BTCUSDT.');
  }
  return symbol;
}

export function normalizeMarket(value = 'spot') {
  const market = String(value).trim().toLowerCase();
  if (market !== 'spot' && market !== 'futures') {
    throw new Error('Unsupported market "' + value + '". Choose spot or futures.');
  }
  return market;
}

export function parseQuoteArgs(args = '') {
  const tokens = String(args).trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 1 || tokens.length > 2) {
    throw new Error('Usage: /binance-quote <SYMBOL> [spot|futures]');
  }
  const market = normalizeMarket(tokens[1] ?? 'spot');
  return { symbol: normalizeSymbol(tokens[0]), market };
}

export function parseWatchlistArgs(args = '') {
  const tokens = String(args).trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 1) {
    throw new Error('Usage: /binance-watchlist <SYMBOL[,SYMBOL...]> [spot|futures]');
  }
  const last = tokens.at(-1)?.toLowerCase();
  const hasMarket = last === 'spot' || last === 'futures';
  const market = normalizeMarket(hasMarket ? tokens.pop() : 'spot');
  const symbolSpec = tokens.join('').replace(/,+$/, '');
  if (!symbolSpec.includes(',') && tokens.length > 1) {
    throw new Error('Separate watchlist symbols with commas. Usage: /binance-watchlist <SYMBOL[,SYMBOL...]> [spot|futures]');
  }
  const symbols = symbolSpec.split(',').map(normalizeSymbol);
  if (symbols.length > MAX_WATCHLIST_SIZE) {
    throw new Error('A watchlist can contain at most ' + MAX_WATCHLIST_SIZE + ' symbols.');
  }
  if (new Set(symbols).size !== symbols.length) {
    throw new Error('Remove duplicate symbols from the watchlist.');
  }
  return { symbols, market };
}

export function tickerUrl(symbol, market) {
  const normalizedSymbol = normalizeSymbol(symbol);
  const normalizedMarket = normalizeMarket(market);
  const base = normalizedMarket === 'spot'
    ? 'https://data-api.binance.vision/api/v3/ticker/24hr'
    : 'https://fapi.binance.com/fapi/v1/ticker/24hr';
  return base + '?symbol=' + encodeURIComponent(normalizedSymbol);
}

function numericField(payload, field, { required = false } = {}) {
  const raw = payload[field];
  if (raw === undefined || raw === null || raw === '') {
    if (required) throw new Error('Binance response is missing required field "' + field + '".');
    return null;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error('Binance returned a non-numeric "' + field + '" field.');
  return value;
}

export function normalizeTicker(payload, expectedSymbol) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Binance returned an unexpected ticker response.');
  }
  const symbol = normalizeSymbol(payload.symbol);
  if (symbol !== normalizeSymbol(expectedSymbol)) {
    throw new Error('Binance response symbol mismatch: expected ' + expectedSymbol + ', received ' + symbol + '.');
  }
  return {
    symbol,
    lastPrice: numericField(payload, 'lastPrice', { required: true }),
    priceChange: numericField(payload, 'priceChange'),
    priceChangePercent: numericField(payload, 'priceChangePercent', { required: true }),
    highPrice: numericField(payload, 'highPrice'),
    lowPrice: numericField(payload, 'lowPrice'),
    quoteVolume: numericField(payload, 'quoteVolume'),
    closeTime: numericField(payload, 'closeTime'),
  };
}

function formatNumber(value, maximumFractionDigits = 8) {
  if (value === null || value === undefined) return 'n/a';
  return value.toLocaleString('en-US', { maximumFractionDigits });
}

export function formatTicker(ticker, market) {
  const change = (ticker.priceChangePercent > 0 ? '+' : '') + ticker.priceChangePercent.toFixed(2) + '%';
  const lines = [
    '**' + ticker.symbol + ' · ' + normalizeMarket(market).toUpperCase() + '**',
    'Last price: ' + formatNumber(ticker.lastPrice),
    '24h change: ' + change + (ticker.priceChange === null ? '' : ' (' + (ticker.priceChange > 0 ? '+' : '') + formatNumber(ticker.priceChange) + ')'),
    '24h high / low: ' + formatNumber(ticker.highPrice) + ' / ' + formatNumber(ticker.lowPrice),
    '24h quote volume: ' + formatNumber(ticker.quoteVolume, 2),
  ];
  if (ticker.closeTime !== null && Number.isFinite(new Date(ticker.closeTime).getTime())) {
    lines.push('Ticker close time: ' + new Date(ticker.closeTime).toISOString());
  }
  lines.push('_Public exchange data; not an execution quote._');
  return lines.join('\n');
}

export function parseExchangeError(text, status) {
  let detail = String(text ?? '').slice(0, 400);
  try {
    const payload = JSON.parse(detail);
    if (payload && typeof payload === 'object') {
      detail = [payload.code, payload.msg].filter((part) => part !== undefined).join(': ') || detail;
    }
  } catch {
    // Keep the bounded response excerpt as the diagnostic.
  }
  return 'Binance request failed (HTTP ' + status + '): ' + (detail || 'no response body');
}
