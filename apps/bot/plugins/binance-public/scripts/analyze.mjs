// Multi-timeframe SMC / price-action / open-interest snapshot from Binance public USD-M endpoints.
// Usage: node analyze.mjs SOLUSDT,ETHUSDT   -> one JSON array on stdout. Read-only, no API keys.
import { fileURLToPath } from 'node:url';
import {
  atr, dealingRange, fairValueGaps, liquidityPools, mtfBias, oiRegime, orderBlocks,
  parseKlines, priceAction, structure, sweeps, swings, takerBuyRatio,
} from './smc.mjs';

const BASE = 'https://fapi.binance.com';
const SYMBOL_PATTERN = /^[A-Z0-9]{2,15}USDT$/;
const MAX_SYMBOLS = 5;
const TIMEFRAMES = { '1d': { limit: 60, flow: 3 }, '4h': { limit: 120, flow: 6 }, '1h': { limit: 120, flow: 24 }, '15m': { limit: 120, flow: 16 } };
// Funding per 8h: shorts paying more than 0.01% / longs paying more than 0.03% = crowded side.
const CROWDED_FUNDING = { short: -0.0001, long: 0.0003 };
const POI_DISTANCE_ATR = 2;
const PLAN_MAX_DISTANCE_ATR = 5;
const STOP_BUFFER_ATR = 0.5;

const round = (x) => (x == null ? x : +Number(x).toPrecision(6));
const pctChange = (now, before) => (before ? ((now - before) / before) * 100 : 0);

export async function getJson(path) {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path.split('?')[0]}`);
  return res.json();
}

function fetchAll(symbol) {
  const q = `symbol=${symbol}`;
  return Promise.all([
    getJson(`/fapi/v1/premiumIndex?${q}`),
    getJson(`/futures/data/openInterestHist?${q}&period=4h&limit=7`),
    getJson(`/futures/data/openInterestHist?${q}&period=1h&limit=7`),
    getJson(`/futures/data/topLongShortAccountRatio?${q}&period=4h&limit=7`),
    ...Object.entries(TIMEFRAMES).map(([tf, { limit }]) => getJson(`/fapi/v1/klines?${q}&interval=${tf}&limit=${limit}`)),
  ]);
}

const roundZone = ({ i, ...z }, n) => ({ ...z, low: round(z.low), high: round(z.high), age: n - 1 - i });

function analyzeTimeframe(rows, nowMs, price, flowWindow) {
  const candles = parseKlines(rows, nowMs);
  const a = atr(candles);
  const sw = swings(candles);
  const st = structure(candles, sw);
  const n = candles.length;
  const range = dealingRange(sw, price);
  return {
    candles, sw, atr: a,
    view: {
      trend: st.trend, bias: st.bias, status: st.status, breakAge: st.breakAge,
      protectedHigh: round(st.protectedHigh), protectedLow: round(st.protectedLow),
      range: range && { high: round(range.high), low: round(range.low), eq: round(range.eq), pct: range.pct, zone: range.zone },
      fairValueGaps: fairValueGaps(candles, a, price).map((g) => roundZone(g, n)),
      orderBlocks: orderBlocks(candles, a, price).map((b) => roundZone(b, n)),
      sweeps: sweeps(candles, sw).map((s) => ({ ...s, level: round(s.level) })),
      priceAction: priceAction(candles, a),
      takerBuyRatio: round(takerBuyRatio(candles, flowWindow)),
      atr: round(a),
    },
  };
}

function oiWindow(oiRows, candles, price) {
  const first = oiRows[0];
  const last = oiRows.at(-1);
  const windowOpen = (candles.find((x) => x.t >= first.timestamp) ?? candles.at(-1)).o;
  const priceChg = pctChange(price, windowOpen);
  const coinChg = pctChange(+last.sumOpenInterest, +first.sumOpenInterest);
  return {
    priceChgPct: round(priceChg), oiCoinChgPct: round(coinChg),
    oiUsdChgPct: round(pctChange(+last.sumOpenInterest * price, +first.sumOpenInterest * windowOpen)),
    regime: oiRegime(priceChg, coinChg),
  };
}

function derivatives({ premium, oi4h, oi1h, lsr }, frames, price) {
  const funding = +premium.lastFundingRate;
  return {
    fundingPct8h: round(funding * 100),
    basisPct: round(pctChange(+premium.markPrice, +premium.indexPrice)),
    oi24h: oiWindow(oi4h, frames['4h'].candles, price),
    oi6h: oiWindow(oi1h, frames['1h'].candles, price),
    topTraderLongPct: round(+lsr.at(-1).longAccount * 100),
    topTraderLongPctChange24h: round((+lsr.at(-1).longAccount - +lsr[0].longAccount) * 100),
  };
}

const distanceToZone = (price, z) => (price >= z.low && price <= z.high ? 0 : Math.min(Math.abs(price - z.low), Math.abs(price - z.high)));

function confluence(direction, f) {
  const short = direction === 'short';
  const want = short ? 'bear' : 'bull';
  const items = [
    ['MTF alignment', f.mtf.aligned >= 3, `${f.mtf.aligned}/${f.mtf.of} timeframes agree`],
    ['Location', f.range?.zone === (short ? 'premium' : 'discount'), `${f.range?.zone ?? 'n/a'} (${f.range?.pct ?? '?'}% of 4h range)`],
    ['POI in play', f.zones.some((z) => z.side === want && distanceToZone(f.price, z) <= POI_DISTANCE_ATR * f.atr4h), `${want} OB/FVG within ${POI_DISTANCE_ATR} ATR(4h)`],
    ['Liquidity sweep', f.sweeps.some((s) => s.side === (short ? 'buy-side' : 'sell-side')), `${short ? 'buy' : 'sell'}-side liquidity taken recently`],
    ['OI regime', f.oi.regime === (short ? 'short build-up' : 'long build-up'), `${f.oi.regime} over 24h`],
    ['Order flow (1h)', short ? f.flow1h < 0.48 : f.flow1h > 0.52, `taker buy ratio ${f.flow1h}`],
    ['Funding not crowded', short ? f.funding >= CROWDED_FUNDING.short : f.funding <= CROWDED_FUNDING.long, `${round(f.funding * 100)}% per 8h`],
  ].map(([name, pass, note]) => ({ name, pass, note }));
  const score = items.filter((x) => x.pass).length;
  return { direction, score, max: items.length, grade: score >= 5 ? 'A' : score === 4 ? 'B' : 'C (low confluence)', items };
}

function buildPlan(direction, f) {
  const short = direction === 'short';
  const candidates = f.zones.filter((z) => z.side === (short ? 'bear' : 'bull')
    && (short ? z.high > f.price : z.low < f.price)
    && distanceToZone(f.price, z) <= PLAN_MAX_DISTANCE_ATR * f.atr4h);
  if (!candidates.length) return { note: `no unmitigated ${short ? 'bearish' : 'bullish'} POI within ${PLAN_MAX_DISTANCE_ATR} ATR(4h); wait for a pullback` };
  const poi = candidates.sort((p, q) => distanceToZone(f.price, p) - distanceToZone(f.price, q))[0];
  const mid = (poi.low + poi.high) / 2;
  const stop = short ? poi.high + STOP_BUFFER_ATR * f.atr1h : poi.low - STOP_BUFFER_ATR * f.atr1h;
  const targets = (short ? f.pools.below : f.pools.above).slice(0, 2).map((p) => p.price);
  const rr = targets.length ? Math.abs(mid - targets[0]) / Math.abs(stop - mid) : null;
  return {
    poi: { tf: poi.tf, kind: poi.kind, low: round(poi.low), high: round(poi.high), tested: poi.tested },
    invalidation: round(stop), targets: targets.map(round), rrToFirstTarget: rr && round(rr),
    note: rr !== null && rr < 1.5 ? 'poor reward-to-risk at this POI' : undefined,
  };
}

function collectZones(frames) {
  return ['4h', '1h'].flatMap((tf) => [
    ...frames[tf].view.orderBlocks.map((z) => ({ ...z, tf, kind: 'OB' })),
    ...frames[tf].view.fairValueGaps.map((z) => ({ ...z, tf, kind: 'FVG' })),
  ]);
}

export async function analyzeSymbol(symbol, nowMs = Date.now()) {
  const [premium, oi4h, oi1h, lsr, ...klines] = await fetchAll(symbol);
  const price = +premium.markPrice;
  const frames = Object.fromEntries(Object.keys(TIMEFRAMES).map((tf, i) => [tf, analyzeTimeframe(klines[i], nowMs, price, TIMEFRAMES[tf].flow)]));
  const mtf = mtfBias(Object.fromEntries(Object.entries(frames).map(([tf, x]) => [tf, x.view.bias])));
  const deriv = derivatives({ premium, oi4h, oi1h, lsr }, frames, price);
  const zones = collectZones(frames);
  const pools = liquidityPools([...frames['4h'].sw, ...frames['1h'].sw], price, frames['4h'].atr);
  const dailyPrev = frames['1d'].candles.at(-1);
  const facts = {
    price, mtf, range: frames['4h'].view.range, zones, pools, atr4h: frames['4h'].atr, atr1h: frames['1h'].atr,
    sweeps: [...frames['4h'].view.sweeps, ...frames['1h'].view.sweeps], oi: deriv.oi24h,
    flow1h: frames['1h'].view.takerBuyRatio, funding: +premium.lastFundingRate,
  };
  const trade = mtf.direction !== 'neutral';
  return {
    symbol, price: round(price), asOf: new Date(nowMs).toISOString(), mtf,
    timeframes: Object.fromEntries(Object.entries(frames).map(([tf, x]) => [tf, x.view])),
    liquidity: { buySideAbove: pools.above.map((p) => ({ ...p, price: round(p.price) })), sellSideBelow: pools.below.map((p) => ({ ...p, price: round(p.price) })), previousDayHigh: round(dailyPrev.h), previousDayLow: round(dailyPrev.l) },
    derivatives: deriv,
    confluence: trade ? confluence(mtf.direction, facts) : null,
    plan: trade ? buildPlan(mtf.direction, facts) : null,
  };
}

async function main() {
  const symbols = (process.argv[2] ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (!symbols.length || symbols.length > MAX_SYMBOLS || !symbols.every((s) => SYMBOL_PATTERN.test(s))) {
    console.error(`usage: analyze.mjs SYMBOL[,SYMBOL...] (max ${MAX_SYMBOLS}, USDT pairs)`);
    process.exit(2);
  }
  const results = await Promise.all(symbols.map((s) => analyzeSymbol(s).catch((e) => ({ symbol: s, error: e.message }))));
  console.log(JSON.stringify(results));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
