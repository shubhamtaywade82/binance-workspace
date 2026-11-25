# binance-workspace

Consolidated: apps/bot (was `binance`), packages/charts (was `binance-charts`), packages/docs-scraper (was `binance-docs-scraper`). SDKs (`binance-client-ts`, `binance-client`) stay separate.

## Claude Code extension

A read-only Binance market-data mod (public REST + WebSocket) is available at [apps/bot/plugins/binance-public](./apps/bot/plugins/binance-public). It adds quote/watchlist commands, MCP-backed market-data workflows, and current USD-M Futures WebSocket route handling. See its README for setup and safety boundaries.
