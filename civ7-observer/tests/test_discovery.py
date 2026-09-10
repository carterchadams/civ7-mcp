import json
import socket

import pytest

from civ7_observer import cdp
from fake_cdp import FakeCdpServer


@pytest.fixture
def server():
    s = FakeCdpServer().start()
    yield s
    s.stop()


def test_discovery_url_is_loopback_only():
    assert cdp.discovery_url(9444) == "http://127.0.0.1:9444/json"


def test_parses_target_list_in_order(server):
    server.targets = [server.target("a", "/devtools/page/a"), server.target("b", "/devtools/page/b", title="Game")]
    targets = cdp.discover_targets(server.port, timeout=2)
    assert [t.id for t in targets] == ["a", "b"]
    assert targets[1].title == "Game"
    assert targets[1].ws_url == server.ws_url("/devtools/page/b")
    assert targets[0].index == 0


def test_entry_without_ws_url_is_kept_with_error(server):
    server.targets = [server.target("a")]
    (t,) = cdp.discover_targets(server.port, timeout=2)
    assert t.ws_url is None
    assert "webSocketDebuggerUrl" in t.ws_url_error


def test_entry_with_non_loopback_ws_url_is_kept_with_error(server):
    server.targets = [server.target("a", webSocketDebuggerUrl="ws://10.1.1.1:9444/x")]
    (t,) = cdp.discover_targets(server.port, timeout=2)
    assert t.ws_url is None
    assert "loopback" in t.ws_url_error


def test_identity_never_includes_ws_url(server):
    server.targets = [server.target("a", "/x")]
    (t,) = cdp.discover_targets(server.port, timeout=2)
    assert "ws" not in json.dumps(t.identity())


def test_refused_port_raises_unavailable():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    with pytest.raises(cdp.DiscoveryUnavailable) as ei:
        cdp.discover_targets(port, timeout=1)
    assert ei.value.code == "DEBUGGER_UNAVAILABLE"


def test_timeout_raises_unavailable(server):
    server.discovery_delay = 2.0
    with pytest.raises(cdp.DiscoveryUnavailable):
        cdp.discover_targets(server.port, timeout=0.3)


def test_non_200_raises_invalid(server):
    server.targets = lambda: (500, b"[]")
    with pytest.raises(cdp.DiscoveryInvalid):
        cdp.discover_targets(server.port, timeout=2)


def test_oversize_body_raises_invalid(server):
    server.targets = lambda: (200, b"[" + b"1," * (cdp.MAX_DISCOVERY_BYTES // 2) + b"1]")
    with pytest.raises(cdp.DiscoveryInvalid):
        cdp.discover_targets(server.port, timeout=5)


@pytest.mark.parametrize("body", [b"not json", b'{"a":1}', b"[1, 2]", b"\xff\xfe"])
def test_bad_shapes_raise_invalid(server, body):
    server.targets = lambda: (200, body)
    with pytest.raises(cdp.DiscoveryInvalid):
        cdp.discover_targets(server.port, timeout=2)


def test_too_many_targets_raises_invalid(server):
    server.targets = [server.target(str(i), f"/p/{i}") for i in range(cdp.MAX_TARGETS + 1)]
    with pytest.raises(cdp.DiscoveryInvalid):
        cdp.discover_targets(server.port, timeout=2)
