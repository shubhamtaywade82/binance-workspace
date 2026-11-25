---
name: orderbook
description: Inspect Binance public Spot or USD-M Futures order-book snapshots, best bid/ask, spread and depth. Use for liquidity, spread, imbalance or order-book structure.
---

# Binance order book

1. Call binance_get_order_book with the exact symbol, market (spot or futures) and a supported limit.
2. Treat the REST response as a point-in-time snapshot, not a continuously synchronized local order book. For live updates use the WebSocket snapshot collector and label its capture window.
3. Preserve price and quantity units. Do not compare base-asset quantities across symbols without normalization.
4. Explain any imbalance using returned bid/ask quantities and depth range. A depth imbalance is descriptive liquidity state, not proof of future price direction.
5. State the snapshot timestamp when available; if the response does not include one, say so.

For sustained order-book reconstruction, a short WebSocket capture is not a complete diff-depth book. Binance's documented snapshot-plus-diff update sequence is required for a gap-free local book. No order placement or account access is allowed.
