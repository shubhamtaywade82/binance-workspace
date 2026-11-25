---
name: websocket-snapshot
description: Capture short bounded snapshots from Binance public Spot or USD-M Futures WebSocket market streams.
---

# Binance public WebSocket snapshot

Use binance_ws_collect_stream for one stream or binance_ws_collect_multi_stream for 1–20 streams. Set market to spot or futures explicitly and duration_sec between 1 and 60. Stream names must be lowercase for the symbol part; preserve Binance event casing, for example:

- btcusdt@aggTrade
- btcusdt@bookTicker
- btcusdt@depth20@100ms
- btcusdt@kline_1m
- btcusdt@markPrice@1s
- !forceOrder@arr

Interpretation:
- A collector invocation is a bounded capture, not a persistent subscription or a guaranteed complete feed.
- Report requested duration, message count, reported messages/second, and first/last event timestamps when present.
- The server caps the capture at 60 seconds and samples very large payloads. Never describe a sampled payload as every message observed.
- Binance Spot streams use the Spot market-stream host. USD-M Futures streams are routed by type: high-frequency depth/book-ticker streams use /public; regular public feeds such as aggregate trades, mark price, klines and liquidations use /market. The workspace MCP collector groups mixed-route subscriptions into separate connections.
- For precise order-book reconstruction, a short snapshot is insufficient; use Binance's snapshot/diff synchronization protocol and detect sequence gaps.
- A successful WebSocket connection with zero messages is not proof that the market was inactive. Check the stream name, route, capture window and endpoint status.

Never request private/user-data streams or listen keys. Never place or modify orders.
