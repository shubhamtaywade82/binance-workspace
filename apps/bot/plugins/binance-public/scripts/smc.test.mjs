import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dealingRange, fairValueGaps, liquidityPools, mtfBias, oiRegime, orderBlocks,
  parseKlines, priceAction, structure, sweeps, swings, takerBuyRatio,
} from './smc.mjs';

const candle = (o, h, l, c, v = 100, tb = 50) => ({ o, h, l, c, v, tb });
const flat = (close) => candle(close, close + 0.1, close - 0.1, close);

test('parseKlines drops the unfinished candle and reads taker-buy volume', () => {
  const rows = [
    [0, '1', '2', '0.5', '1.5', '10', 99, '0', 0, '4'],
    [100, '1', '2', '0.5', '1.5', '10', 199, '0', 0, '4'],
  ];
  const parsed = parseKlines(rows, 150);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].tb, 4);
});

test('swings finds a fractal high and low', () => {
  const highs = [1, 2, 3, 2, 1, 2, 3.5, 2];
  const candles = highs.map((h) => candle(h - 0.5, h, h - 1, h - 0.5));
  const found = swings(candles);
  assert.deepEqual(found.filter((s) => s.type === 'H').map((s) => s.i), [2]);
  assert.deepEqual(found.filter((s) => s.type === 'L').map((s) => s.i), [4]);
});

const bearishSwings = [
  { i: 1, type: 'H', p: 10 }, { i: 3, type: 'L', p: 5 },
  { i: 5, type: 'H', p: 9 }, { i: 7, type: 'L', p: 4 },
];

test('structure reports a bearish trend as intact while inside the swings', () => {
  const candles = [8, 7, 6, 5.5, 6, 7, 6, 5, 6, 7].map(flat);
  const result = structure(candles, bearishSwings);
  assert.equal(result.trend, 'bearish');
  assert.equal(result.status, 'intact');
  assert.equal(result.protectedHigh, 9);
});

test('structure flags a close above the last lower high as CHoCH up', () => {
  const candles = [8, 7, 6, 5.5, 6, 7, 6, 5, 6, 9.5].map(flat);
  const result = structure(candles, bearishSwings);
  assert.equal(result.status, 'CHoCH up');
  assert.equal(result.trend, 'bearish');
  assert.equal(result.bias, 'bullish');
});

test('structure flags a close below the last lower low as BOS down', () => {
  const candles = [8, 7, 6, 5.5, 6, 7, 6, 5, 6, 3.5].map(flat);
  const result = structure(candles, bearishSwings);
  assert.equal(result.status, 'BOS down');
  assert.equal(result.bias, 'bearish');
});

test('fairValueGaps returns an open bullish gap and drops it once filled', () => {
  const open = [candle(9, 10, 8, 9.5), candle(10, 13, 9.5, 12.5), candle(12.5, 14, 12, 13.5)];
  const [gap] = fairValueGaps(open, 1, 13);
  assert.deepEqual([gap.side, gap.low, gap.high], ['bull', 10, 12]);
  const filled = [...open, candle(13, 13, 9.8, 10)];
  assert.equal(fairValueGaps(filled, 1, 13).length, 0);
});

test('orderBlocks marks the last down candle before bullish displacement', () => {
  const candles = [candle(10, 10.2, 8.8, 9), candle(9, 14, 9, 14), candle(14, 14.5, 13.5, 14.2)];
  const [block] = orderBlocks(candles, 1, 14);
  assert.deepEqual([block.side, block.low, block.high], ['bull', 8.8, 10.2]);
  const broken = [...candles, candle(14, 14, 8, 8.5)];
  assert.equal(orderBlocks(broken, 1, 8.5).filter((b) => b.side === 'bull').length, 0);
});

test('orderBlocks ignores blocks wider than 3 ATR', () => {
  const candles = [candle(10, 16, 8, 9), candle(9, 20, 9, 20), candle(20, 21, 19, 20)];
  assert.equal(orderBlocks(candles, 1, 20).filter((b) => b.side === 'bull').length, 0);
});

test('sweeps detects a wick above an untouched high that closes back below', () => {
  const candles = [1, 2, 3, 2, 1.5, 1.8, 2].map((h) => candle(h - 0.3, h, h - 0.6, h - 0.3));
  candles.push(candle(2.5, 3.4, 2.4, 2.8));
  const [sweep] = sweeps(candles, [{ i: 2, type: 'H', p: 3 }]);
  assert.deepEqual([sweep.side, sweep.level, sweep.age], ['buy-side', 3, 0]);
});

test('liquidityPools splits levels around price and flags equal highs', () => {
  const sw = [
    { i: 1, type: 'H', p: 105 }, { i: 4, type: 'H', p: 105.05 },
    { i: 6, type: 'H', p: 110 }, { i: 3, type: 'L', p: 95 },
  ];
  const pools = liquidityPools(sw, 100, 1);
  assert.deepEqual(pools.above.map((p) => [p.price, p.equal]), [[105, true], [110, false]]);
  assert.deepEqual(pools.below.map((p) => p.price), [95]);
});

test('dealingRange classifies premium and discount', () => {
  const sw = [{ i: 1, type: 'L', p: 100 }, { i: 5, type: 'H', p: 200 }];
  assert.equal(dealingRange(sw, 180).zone, 'premium');
  assert.equal(dealingRange(sw, 120).zone, 'discount');
  assert.equal(dealingRange(sw, 150).zone, 'equilibrium');
  assert.equal(dealingRange(sw, 90).zone, 'below range');
  assert.equal(dealingRange(sw, 210).zone, 'above range');
});

test('priceAction tags a long upper wick as bearish rejection', () => {
  const candles = [candle(10, 10.5, 9.8, 10.2), candle(10, 12, 9.9, 10.1)];
  assert.ok(priceAction(candles, 5).includes('bearish rejection (upper wick)'));
});

test('takerBuyRatio is buy volume over total volume', () => {
  assert.equal(takerBuyRatio([candle(1, 1, 1, 1, 100, 60), candle(1, 1, 1, 1, 100, 40)], 2), 0.5);
});

test('oiRegime maps the four price/OI quadrants and ignores noise', () => {
  assert.equal(oiRegime(-3, 2), 'short build-up');
  assert.equal(oiRegime(-3, -2), 'long liquidation');
  assert.equal(oiRegime(3, 2), 'long build-up');
  assert.equal(oiRegime(3, -2), 'short covering');
  assert.equal(oiRegime(0.1, 2), 'neutral');
});

test('mtfBias weights 1d and 4h double and needs |score| >= 3', () => {
  const bear = { '1d': 'bearish', '4h': 'bearish', '1h': 'bearish', '15m': 'range' };
  assert.deepEqual(mtfBias(bear), { score: -5, direction: 'short', aligned: 3, of: 4 });
  const mixed = { '1d': 'bearish', '4h': 'bullish', '1h': 'bullish', '15m': 'bullish' };
  assert.equal(mtfBias(mixed).direction, 'neutral');
});
