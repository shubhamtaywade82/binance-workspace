import pytest

from crypto_exchange_mcp import WsMultiStreamInput, WsStreamInput
from binance_ws_routing import (
    build_ws_urls,
    futures_route_for_stream,
    group_futures_streams,
)


def test_routes_depth_and_book_ticker_to_public():
    assert futures_route_for_stream("btcusdt@depth") == "public"
    assert futures_route_for_stream("btcusdt@depth20@100ms") == "public"
    assert futures_route_for_stream("ethusdt@bookTicker") == "public"


def test_routes_regular_market_streams_to_market():
    assert futures_route_for_stream("btcusdt@aggTrade") == "market"
    assert futures_route_for_stream("ethusdt@markPrice@1s") == "market"
    assert futures_route_for_stream("solusdt@kline_1m") == "market"
    assert futures_route_for_stream("!forceOrder@arr") == "market"


def test_rejects_invalid_streams():
    with pytest.raises(ValueError):
        futures_route_for_stream("BTCUSDT")
    with pytest.raises(ValueError):
        futures_route_for_stream("btc usdt@depth")


def test_builds_current_futures_raw_route_for_single_depth_stream():
    result = build_ws_urls("futures", ["btcusdt@depth"])
    assert result == [{
        "route": "public",
        "streams": ["btcusdt@depth"],
        "url": "wss://fstream.binance.com/public/ws/btcusdt@depth",
    }]


def test_builds_futures_combined_market_route():
    result = build_ws_urls("futures", ["btcusdt@aggTrade", "ethusdt@markPrice@1s"])
    assert len(result) == 1
    assert result[0]["route"] == "market"
    assert result[0]["url"] == (
        "wss://fstream.binance.com/market/stream?streams="
        "btcusdt@aggTrade/ethusdt@markPrice@1s"
    )


def test_splits_mixed_futures_routes_into_separate_sockets():
    result = build_ws_urls(
        "futures",
        ["btcusdt@depth20@100ms", "ethusdt@markPrice@1s", "btcusdt@bookTicker"],
    )
    assert [group["route"] for group in result] == ["public", "market"]
    assert result[0]["streams"] == ["btcusdt@depth20@100ms", "btcusdt@bookTicker"]
    assert result[1]["streams"] == ["ethusdt@markPrice@1s"]


def test_groups_futures_streams_without_reordering():
    assert group_futures_streams(
        ["btcusdt@aggTrade", "ethusdt@depth", "solusdt@markPrice"]
    ) == {
        "market": ["btcusdt@aggTrade", "solusdt@markPrice"],
        "public": ["ethusdt@depth"],
    }


def test_spot_urls_keep_existing_unrouted_host_and_shapes():
    raw = build_ws_urls("spot", ["btcusdt@aggTrade"])[0]
    combined = build_ws_urls(
        "spot", ["btcusdt@aggTrade", "ethusdt@bookTicker"]
    )[0]
    assert raw["url"] == "wss://stream.binance.com:9443/ws/btcusdt@aggTrade"
    assert combined["url"] == (
        "wss://stream.binance.com:9443/stream?streams="
        "btcusdt@aggTrade/ethusdt@bookTicker"
    )


def test_rejects_empty_stream_list_and_unknown_market():
    with pytest.raises(ValueError):
        build_ws_urls("futures", [])
    with pytest.raises(ValueError):
        build_ws_urls("coinm", ["btcusd_perp@aggTrade"])


def test_preserves_event_name_casing_and_normalizes_only_symbol():
    result = build_ws_urls("spot", ["BTCUSDT@aggTrade"])[0]
    assert result["streams"] == ["btcusdt@aggTrade"]
    assert result["url"] == "wss://stream.binance.com:9443/ws/btcusdt@aggTrade"



def test_websocket_tool_inputs_preserve_binance_event_name_case():
    single = WsStreamInput(stream="BTCUSDT@aggTrade", market="futures")
    multi = WsMultiStreamInput(
        streams=["BTCUSDT@depth20@100ms", "ETHUSDT@bookTicker"],
        market="futures",
    )
    assert single.stream == "btcusdt@aggTrade"
    assert multi.streams == ["btcusdt@depth20@100ms", "ethusdt@bookTicker"]
