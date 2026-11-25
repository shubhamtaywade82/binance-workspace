---
name: klines
description: Retrieve and explain Binance historical or recent OHLCV candlesticks for Spot or USD-M Futures with explicit interval, limits and time boundaries.
---

# Binance candles / OHLCV

Use binance_get_klines for Spot and binance_get_klines with market: "futures" for USD-M Futures.

Required discipline:
- Specify the exact symbol, market, interval, and row limit. Supported intervals are validated by the MCP server.
- Use startTime and endTime in Unix milliseconds when a date range is requested. State timezone assumptions when interpreting local dates.
- Binance kline rows contain open time, OHLC, base volume, close time, quote volume, trade count, taker-buy volumes and an unused field. Preserve original response order and units.
- Identify the last candle as potentially still open unless its close time is earlier than exchange server time. Do not treat a partial candle as a finalized close.
- Do not fabricate missing bars, forward-fill prices, or infer volume units.
- For calculations, show the formula, input range and treatment of incomplete candles. Use deterministic code for indicators; do not estimate numeric indicators from prose.

Read-only only. Do not call trading or account endpoints.
