"""Binance WebSocket endpoint routing for Spot and USD-M Futures.

USD-M Futures routes high-frequency depth/book-ticker streams to /public and
regular market feeds to /market. Spot continues to use the un-routed endpoint.
"""
from __future__ import annotations

from collections import OrderedDict
from urllib.parse import quote

SPOT_WS_BASE = "wss://stream.binance.com:9443"
FUTURES_WS_BASE = "wss://fstream.binance.com"


def normalize_stream(stream: str) -> str:
    """Normalize only the symbol portion; preserve Binance event-name casing."""
    raw = stream.strip()
    if not raw or any(char.isspace() for char in raw):
        raise ValueError(f"Invalid Binance stream: {stream!r}")
    if len(raw) > 100:
        raise ValueError("Binance stream name must not exceed 100 characters")
    parts = raw.split("@")
    if not parts[0].startswith("!"):
        parts[0] = parts[0].lower()
    return "@".join(parts)


def futures_route_for_stream(stream: str) -> str:
    """Return the current USD-M public route for a market-data stream."""
    parts = normalize_stream(stream).split("@")
    if len(parts) < 2:
        raise ValueError(
            f"Expected a Binance symbol stream such as btcusdt@aggTrade: {stream!r}"
        )

    channel = parts[1].lower()
    # Binance classifies depth and book ticker as high-frequency public data.
    # The depth suffix may carry an optional level count and update speed.
    if channel == "bookticker" or channel.startswith("depth"):
        return "public"
    return "market"


def group_futures_streams(streams: list[str]) -> dict[str, list[str]]:
    """Group USD-M streams by route while preserving order within each group."""
    groups: OrderedDict[str, list[str]] = OrderedDict()
    for stream in streams:
        cleaned = normalize_stream(stream)
        route = futures_route_for_stream(cleaned)
        groups.setdefault(route, []).append(cleaned)
    return dict(groups)


def build_ws_urls(
    market: str,
    streams: list[str],
    *,
    spot_base: str = SPOT_WS_BASE,
    futures_base: str = FUTURES_WS_BASE,
) -> list[dict[str, object]]:
    """Build one or more URL groups for raw or combined public subscriptions.

    Mixed USD-M subscriptions are split across sockets because Binance routes
    /public and /market traffic independently.
    """
    normalized_market = market.strip().lower()
    if normalized_market not in {"spot", "futures"}:
        raise ValueError("market must be 'spot' or 'futures'")
    if not streams:
        raise ValueError("at least one stream is required")

    cleaned_streams = [normalize_stream(stream) for stream in streams]
    if normalized_market == "spot":
        if len(cleaned_streams) == 1:
            url = f"{spot_base}/ws/{quote(cleaned_streams[0], safe='@!_')}"
        else:
            url = f"{spot_base}/stream?streams={quote('/'.join(cleaned_streams), safe='@!_/')}"
        return [{"route": "spot", "streams": cleaned_streams, "url": url}]

    groups = group_futures_streams(cleaned_streams)
    result: list[dict[str, object]] = []
    for route, route_streams in groups.items():
        base = f"{futures_base}/{route}"
        if len(route_streams) == 1:
            url = f"{base}/ws/{quote(route_streams[0], safe='@!_')}"
        else:
            url = f"{base}/stream?streams={quote('/'.join(route_streams), safe='@!_/')}"
        result.append({"route": route, "streams": route_streams, "url": url})
    return result
