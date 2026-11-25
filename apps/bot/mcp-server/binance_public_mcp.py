"""Binance-only public MCP surface backed by the shared exchange handlers.

The source module contains additional CoinDCX and cross-exchange tools. This
entry point deliberately registers only the Binance Spot/USD-M public tools.
"""
from __future__ import annotations

from typing import Any

from mcp.server.fastmcp import FastMCP

import crypto_exchange_mcp as exchange


BINANCE_PUBLIC_TOOL_NAMES = (
    "binance_get_exchange_info",
    "binance_futures_exchange_info",
    "binance_get_price",
    "binance_futures_get_price",
    "binance_get_ticker_24hr",
    "binance_futures_ticker_24hr",
    "binance_get_order_book",
    "binance_get_recent_trades",
    "binance_get_klines",
    "binance_get_agg_trades",
    "binance_futures_premium_index",
    "binance_futures_funding_rate_history",
    "binance_futures_open_interest",
    "binance_futures_open_interest_hist",
    "binance_futures_top_long_short_ratio",
    "binance_ws_collect_stream",
    "binance_ws_collect_multi_stream",
)


def register_binance_public_tools(server: Any, source: Any = exchange) -> tuple[str, ...]:
    """Register the explicit Binance public allowlist on a FastMCP-compatible server."""
    for name in BINANCE_PUBLIC_TOOL_NAMES:
        handler = getattr(source, name)
        annotations = {
            **dict(source.READ_ANNOTATIONS),
            "title": name.replace("_", " ").title(),
        }
        server.tool(name=name, annotations=annotations)(handler)
    return BINANCE_PUBLIC_TOOL_NAMES


mcp = FastMCP("binance_public_mcp", lifespan=exchange.lifespan)
register_binance_public_tools(mcp)


def main() -> None:
    """Run the Binance-only MCP server over stdio."""
    mcp.run()


if __name__ == "__main__":
    main()
