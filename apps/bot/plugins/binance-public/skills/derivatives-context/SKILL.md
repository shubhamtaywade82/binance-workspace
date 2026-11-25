---
name: derivatives-context
description: Retrieve Binance USD-M public derivatives context such as mark price, index price, funding, open interest and top-trader ratios.
---

# USD-M Futures public derivatives context

Use only public market-data tools:
- binance_futures_premium_index for mark price, index price, current funding rate and next funding time.
- binance_futures_funding_rate_history for historical funding observations.
- binance_futures_open_interest for current open interest.
- binance_futures_open_interest_hist for aggregated open-interest history.
- binance_futures_top_long_short_ratio for the top-trader account ratio.

Always label each metric and its time granularity. Open-interest history and long/short ratios are aggregated series, not tick-level feeds. Do not treat top-trader ratios as all-account positioning. Do not derive liquidation levels or leverage exposure from these fields alone. Compare series only when symbols, periods and time windows align. Distinguish exchange-reported values from derived calculations and state formulas.

No account endpoints, private user-data streams, order operations, or recommendations to execute a trade.
