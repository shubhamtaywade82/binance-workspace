---
name: market-overview
description: Use Binance public Spot or USD-M Futures market data to produce a timestamp-aware market snapshot for one or more symbols. Use for current price, 24-hour overview, or Spot-versus-Futures comparison.
---

# Binance market overview

Use the binance-public MCP server. This workflow is read-only.

1. Resolve the market explicitly: Spot or USD-M Futures. Do not silently compare different contract types.
2. Use binance_get_price or binance_futures_get_price for the latest last-traded price, and the matching *_ticker_24hr tool for 24-hour change, high, low and volume.
3. When comparing Spot and Futures, fetch both explicitly and label each result. A premium/discount requires a synchronized Spot price and Futures mark/index context; do not infer it from stale or mismatched snapshots.
4. Include the symbol, market, source endpoint family and exchange timestamps when available. Report missing fields as unavailable rather than estimating them.
5. Distinguish observations from interpretations. A 24-hour change or volume is not by itself a directional signal or trade recommendation.
6. For invalid or unknown symbols, call the relevant *_exchange_info tool and verify that the symbol is listed and trading before retrying.

Do not use account, wallet, user-stream, order, or execution tools. Never request API credentials.
