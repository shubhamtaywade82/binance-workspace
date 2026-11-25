// Pure market-structure helpers over CLOSED candles. No I/O.
// Candle: { t, o, h, l, c, v, ct, tb }  (tb = taker-buy base volume)

export function parseKlines(rows, nowMs) {
  return rows
    .filter((r) => r[6] < nowMs)
    .map((r) => ({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5], ct: r[6], tb: +r[9] }));
}

export function atr(candles, period = 14) {
  const recent = candles.slice(-(period + 1));
  let sum = 0;
  for (let i = 1; i < recent.length; i++) {
    const prevClose = recent[i - 1].c;
    const x = recent[i];
    sum += Math.max(x.h - x.l, Math.abs(x.h - prevClose), Math.abs(x.l - prevClose));
  }
  return sum / Math.max(recent.length - 1, 1);
}

/** Fractal swings: k candles lower on each side (ties allowed on the right). */
export function swings(candles, k = 2) {
  const out = [];
  for (let i = k; i < candles.length - k; i++) {
    const left = candles.slice(i - k, i);
    const right = candles.slice(i + 1, i + k + 1);
    const x = candles[i];
    if (left.every((y) => y.h < x.h) && right.every((y) => y.h <= x.h)) out.push({ i, type: 'H', p: x.h });
    if (left.every((y) => y.l > x.l) && right.every((y) => y.l >= x.l)) out.push({ i, type: 'L', p: x.l });
  }
  return out;
}

function firstCloseBeyond(candles, swing, isBeyond) {
  return candles.findIndex((x, i) => i > swing.i && isBeyond(x.c));
}

/** Trend from the last two swing highs/lows plus the latest close-based BOS/CHoCH. */
export function structure(candles, sw) {
  const highs = sw.filter((s) => s.type === 'H').slice(-2);
  const lows = sw.filter((s) => s.type === 'L').slice(-2);
  if (highs.length < 2 || lows.length < 2) return { trend: 'range', bias: 'range', status: 'not enough swings' };

  const [h0, h1] = highs;
  const [l0, l1] = lows;
  const trend = h1.p > h0.p && l1.p > l0.p ? 'bullish' : h1.p < h0.p && l1.p < l0.p ? 'bearish' : 'range';
  const upAt = firstCloseBeyond(candles, h1, (c) => c > h1.p);
  const downAt = firstCloseBeyond(candles, l1, (c) => c < l1.p);
  const result = { trend, bias: trend, status: 'intact', protectedHigh: h1.p, protectedLow: l1.p };
  if (upAt < 0 && downAt < 0) return result;

  const brokeUp = upAt >= downAt;
  const dir = brokeUp ? 'up' : 'down';
  const withTrend = brokeUp === (trend === 'bullish');
  result.status = trend === 'range' ? `range break ${dir}` : `${withTrend ? 'BOS' : 'CHoCH'} ${dir}`;
  result.breakAge = candles.length - 1 - Math.max(upAt, downAt);
  // A CHoCH or range break shifts the working bias to the break direction; BOS keeps the trend.
  if (!withTrend || trend === 'range') result.bias = brokeUp ? 'bullish' : 'bearish';
  return result;
}

function gapFilled(candles, gap) {
  const after = candles.slice(gap.i + 1);
  if (gap.side === 'bull') return { filled: after.some((x) => x.l <= gap.low), tested: after.some((x) => x.l < gap.high) };
  return { filled: after.some((x) => x.h >= gap.high), tested: after.some((x) => x.h > gap.low) };
}

const nearestFirst = (price) => (a, b) =>
  Math.abs((a.low + a.high) / 2 - price) - Math.abs((b.low + b.high) / 2 - price);

/** Unfilled 3-candle imbalances larger than 0.25 ATR, nearest to price first. */
export function fairValueGaps(candles, a, price, limit = 3) {
  const gaps = [];
  for (let i = 2; i < candles.length; i++) {
    const first = candles[i - 2];
    const third = candles[i];
    if (third.l - first.h > 0.25 * a) gaps.push({ side: 'bull', low: first.h, high: third.l, i });
    else if (first.l - third.h > 0.25 * a) gaps.push({ side: 'bear', low: third.h, high: first.l, i });
  }
  return gaps
    .map((g) => ({ ...g, ...gapFilled(candles, g) }))
    .filter((g) => !g.filled)
    .sort(nearestFirst(price))
    .slice(0, limit);
}

const MAX_OB_ATR = 3;

function lastOppositeCandle(candles, displacementAt, isBull) {
  for (let i = displacementAt - 1; i >= Math.max(displacementAt - 3, 0); i--) {
    if (isBull ? candles[i].c < candles[i].o : candles[i].c > candles[i].o) return i;
  }
  return -1;
}

/** Last opposite candle before a >1.5 ATR displacement; dropped once closed through or wider than 3 ATR. */
export function orderBlocks(candles, a, price, limit = 3) {
  const found = new Map();
  candles.forEach((x, j) => {
    if (Math.abs(x.c - x.o) < 1.5 * a) return;
    const isBull = x.c > x.o;
    const at = lastOppositeCandle(candles, j, isBull);
    if (at < 0 || found.has(at)) return;
    const ob = candles[at];
    if (ob.h - ob.l > MAX_OB_ATR * a) return;
    const after = candles.slice(j + 1);
    const broken = after.some((y) => (isBull ? y.c < ob.l : y.c > ob.h));
    const tested = after.some((y) => (isBull ? y.l <= ob.h : y.h >= ob.l));
    if (!broken) found.set(at, { side: isBull ? 'bull' : 'bear', low: ob.l, high: ob.h, tested, i: at });
  });
  return [...found.values()].sort(nearestFirst(price)).slice(0, limit);
}

/** Nearest swing highs above / lows below price; `equal` marks resting equal highs/lows. */
export function liquidityPools(sw, price, a) {
  const tol = Math.max(0.25 * a, price * 0.001);
  const pools = (type) => {
    const levels = sw.filter((s) => s.type === type).map((s) => s.p);
    return levels.map((p) => ({ price: p, equal: levels.filter((q) => Math.abs(q - p) <= tol).length >= 2 }));
  };
  const unique = (list) => list.filter((x, i) => list.findIndex((y) => Math.abs(y.price - x.price) <= tol) === i);
  return {
    above: unique(pools('H').filter((x) => x.price > price).sort((p, q) => p.price - q.price)).slice(0, 3),
    below: unique(pools('L').filter((x) => x.price < price).sort((p, q) => q.price - p.price)).slice(0, 3),
  };
}

/** Wick through an untouched swing level that closes back inside = liquidity sweep. */
export function sweeps(candles, sw, lookback = 12) {
  const n = candles.length;
  const out = [];
  for (let j = Math.max(n - lookback, 1); j < n; j++) {
    for (const s of sw) {
      if (s.i >= j - 1) continue;
      const untouched = candles.slice(s.i + 1, j).every((y) => (s.type === 'H' ? y.h < s.p : y.l > s.p));
      const x = candles[j];
      if (untouched && s.type === 'H' && x.h > s.p && x.c < s.p) out.push({ side: 'buy-side', level: s.p, age: n - 1 - j });
      if (untouched && s.type === 'L' && x.l < s.p && x.c > s.p) out.push({ side: 'sell-side', level: s.p, age: n - 1 - j });
    }
  }
  return out.sort((p, q) => p.age - q.age).slice(0, 2);
}

/** Last swing leg as the dealing range; premium above 55%, discount below 45%, outside = extended. */
export function dealingRange(sw, price) {
  const high = sw.filter((s) => s.type === 'H').at(-1);
  const low = sw.filter((s) => s.type === 'L').at(-1);
  if (!high || !low) return null;
  const top = Math.max(high.p, low.p);
  const bottom = Math.min(high.p, low.p);
  const pct = ((price - bottom) / (top - bottom)) * 100;
  return { high: top, low: bottom, eq: (top + bottom) / 2, pct: Math.round(pct), zone: rangeZone(pct) };
}

function rangeZone(pct) {
  if (pct < 0) return 'below range';
  if (pct > 100) return 'above range';
  return pct > 55 ? 'premium' : pct < 45 ? 'discount' : 'equilibrium';
}

export function priceAction(candles, a) {
  const x = candles.at(-1);
  const prev = candles.at(-2);
  const range = x.h - x.l;
  const body = Math.abs(x.c - x.o);
  const upperWick = x.h - Math.max(x.o, x.c);
  const lowerWick = Math.min(x.o, x.c) - x.l;
  const tags = [];
  if (body > 1.5 * a) tags.push(x.c > x.o ? 'bullish displacement' : 'bearish displacement');
  if (prev && prev.c < prev.o && x.c > x.o && x.c >= prev.o && x.o <= prev.c) tags.push('bullish engulfing');
  if (prev && prev.c > prev.o && x.c < x.o && x.c <= prev.o && x.o >= prev.c) tags.push('bearish engulfing');
  if (range > 0 && lowerWick >= 2 * body && lowerWick >= 0.5 * range) tags.push('bullish rejection (lower wick)');
  if (range > 0 && upperWick >= 2 * body && upperWick >= 0.5 * range) tags.push('bearish rejection (upper wick)');
  if (prev && x.h < prev.h && x.l > prev.l) tags.push('inside bar');
  return tags;
}

/** Share of volume bought by takers over the last n candles. */
export function takerBuyRatio(candles, n) {
  const recent = candles.slice(-n);
  const total = recent.reduce((s, x) => s + x.v, 0);
  return total > 0 ? recent.reduce((s, x) => s + x.tb, 0) / total : 0.5;
}

/** Price vs open-interest quadrant over the same window (percent changes). */
export function oiRegime(priceChgPct, oiChgPct, priceThr = 0.3, oiThr = 0.5) {
  if (Math.abs(priceChgPct) < priceThr || Math.abs(oiChgPct) < oiThr) return 'neutral';
  if (priceChgPct > 0) return oiChgPct > 0 ? 'long build-up' : 'short covering';
  return oiChgPct > 0 ? 'short build-up' : 'long liquidation';
}

const TREND_SCORE = { bullish: 1, range: 0, bearish: -1 };

/** HTF-weighted bias: 1d and 4h count double, 1h once; 15m is trigger only. */
export function mtfBias(trends) {
  const score = 2 * TREND_SCORE[trends['1d']] + 2 * TREND_SCORE[trends['4h']] + TREND_SCORE[trends['1h']];
  const direction = score >= 3 ? 'long' : score <= -3 ? 'short' : 'neutral';
  const sign = Math.sign(score);
  const aligned = Object.values(trends).filter((t) => TREND_SCORE[t] === sign && sign !== 0).length;
  return { score, direction, aligned, of: Object.keys(trends).length };
}
