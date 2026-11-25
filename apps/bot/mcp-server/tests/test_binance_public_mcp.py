from types import SimpleNamespace

from binance_public_mcp import BINANCE_PUBLIC_TOOL_NAMES, register_binance_public_tools


class FakeMcp:
    def __init__(self):
        self.tools = {}

    def tool(self, *, name, annotations):
        def register(handler):
            self.tools[name] = {"handler": handler, "annotations": annotations}
            return handler
        return register


def test_public_server_allowlist_contains_only_binance_market_data_tools():
    assert len(BINANCE_PUBLIC_TOOL_NAMES) == 17
    assert all(name.startswith("binance_") for name in BINANCE_PUBLIC_TOOL_NAMES)
    assert "binance_ws_collect_stream" in BINANCE_PUBLIC_TOOL_NAMES
    assert "binance_ws_collect_multi_stream" in BINANCE_PUBLIC_TOOL_NAMES
    assert not any("coindcx" in name or "cross_exchange" in name for name in BINANCE_PUBLIC_TOOL_NAMES)


def test_registers_only_the_explicit_public_tool_allowlist():
    source = SimpleNamespace(READ_ANNOTATIONS={"readOnlyHint": True})
    for name in BINANCE_PUBLIC_TOOL_NAMES:
        setattr(source, name, object())

    server = FakeMcp()
    registered = register_binance_public_tools(server, source)

    assert registered == BINANCE_PUBLIC_TOOL_NAMES
    assert tuple(server.tools) == BINANCE_PUBLIC_TOOL_NAMES
    assert all(item["annotations"]["readOnlyHint"] is True for item in server.tools.values())
