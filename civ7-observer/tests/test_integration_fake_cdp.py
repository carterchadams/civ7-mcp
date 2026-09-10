"""End-to-end: real websocket-client against the fake Cohtml server."""
import json
import socket
import time

import pytest

from civ7_observer import cdp, doctor
from fake_cdp import Close, FakeCdpServer, Reply, Send, SendRaw, Sleep, binary_frame, echo_value
from test_targets import GAME, MENU


@pytest.fixture
def server():
    s = FakeCdpServer().start()
    yield s
    s.stop()


def run(server, **kw):
    return doctor.run_doctor(port=server.port, timeout=kw.pop("timeout", 2.0), **kw)


def test_end_to_end_in_game(server):
    server.targets = [server.target("menu", "/p/menu"), server.target("game", "/p/game")]
    server.ws_scripts = {"/p/menu": [echo_value(json.dumps(MENU))], "/p/game": [echo_value(json.dumps(GAME))]}
    r = run(server)
    assert r.status is doctor.DoctorStatus.IN_GAME
    assert r.selected["id"] == "game"
    assert r.context["turn"] == 12
    assert server.received[0]["method"] == "Runtime.evaluate"
    assert server.received[0]["params"]["returnByValue"] is True


def test_end_to_end_menu(server):
    server.targets = [server.target("menu", "/p/menu")]
    server.ws_scripts = {"/p/menu": [echo_value(json.dumps(MENU))]}
    assert run(server).status is doctor.DoctorStatus.NOT_IN_GAME


def test_end_to_end_ambiguous(server):
    server.targets = [server.target("a", "/p/a"), server.target("b", "/p/b")]
    server.ws_scripts = {"/p/a": [echo_value(json.dumps(GAME))], "/p/b": [echo_value(json.dumps(GAME))]}
    assert run(server).status is doctor.DoctorStatus.AMBIGUOUS_GAME_TARGET


def test_events_before_response_over_real_socket(server):
    server.targets = [server.target("g", "/p/g")]
    event = json.dumps({"method": "Runtime.consoleAPICalled", "params": {"type": "log"}})
    server.ws_scripts = {"/p/g": [Send(event), Send(event), echo_value(json.dumps(GAME))]}
    assert run(server).status is doctor.DoctorStatus.IN_GAME


def test_real_deadline_when_server_never_replies(server):
    server.targets = [server.target("g", "/p/g")]
    server.ws_scripts = {"/p/g": [Sleep(10)]}
    t0 = time.monotonic()
    r = run(server, timeout=0.5)
    assert time.monotonic() - t0 < 3
    assert r.status is doctor.DoctorStatus.TARGET_PROBE_FAILED
    assert r.targets[0]["error"]["code"] == "CDP_DEADLINE"


def test_server_closes_mid_call(server):
    server.targets = [server.target("g", "/p/g")]
    server.ws_scripts = {"/p/g": [Close()]}
    r = run(server)
    assert r.status is doctor.DoctorStatus.TARGET_PROBE_FAILED
    assert r.targets[0]["error"]["code"] == "CDP_CONNECTION_CLOSED"


def test_ws_upgrade_rejected_with_404(server):
    server.targets = [server.target("g", "/p/g")]
    server.ws_reject_status = 404
    r = run(server)
    assert r.targets[0]["error"]["code"] == "TARGET_CONNECT_FAILED"


def test_ws_url_port_not_listening(server):
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    dead_port = s.getsockname()[1]
    s.close()
    server.targets = [server.target("g", webSocketDebuggerUrl=f"ws://127.0.0.1:{dead_port}/p/g")]
    r = run(server)
    assert r.targets[0]["error"]["code"] == "TARGET_CONNECT_FAILED"


def test_binary_frame_is_malformed(server):
    server.targets = [server.target("g", "/p/g")]
    server.ws_scripts = {"/p/g": [SendRaw(binary_frame(b"\x00\x01"))]}
    r = run(server)
    assert r.targets[0]["error"]["code"] == "CDP_MALFORMED"


def test_js_exception_is_contract_issue(server):
    server.targets = [server.target("g", "/p/g")]
    exc = lambda req: json.dumps({"id": req["id"], "result": {"result": {"type": "undefined"},
                                  "exceptionDetails": {"text": "Uncaught", "exception": {"description": "ReferenceError: UI is not defined"}}}})
    server.ws_scripts = {"/p/g": [Reply(exc)]}
    r = run(server)
    assert r.status is doctor.DoctorStatus.API_CONTRACT_MISMATCH
    assert "ReferenceError" in r.targets[0]["error"]["description"]


@pytest.mark.parametrize("size", [200, 70_000])
def test_long_frame_lengths(server, size):
    payload = {**GAME, "href": "x" * size}
    server.targets = [server.target("g", "/p/g")]
    server.ws_scripts = {"/p/g": [echo_value(json.dumps(payload))]}
    r = run(server)
    assert r.status is doctor.DoctorStatus.IN_GAME
    assert len(r.targets[0]["probe"]["href"]) == size


def test_session_direct_multiple_calls(server):
    server.targets = [server.target("g", "/p/g")]
    server.ws_scripts = {"/p/g": [echo_value("one"), echo_value("two")]}
    with cdp.CdpSession(server.ws_url("/p/g"), timeout=2) as s:
        assert s.evaluate_readonly("1") == "one"
        assert s.evaluate_readonly("2") == "two"
    assert [r["id"] for r in server.received] == [1, 2]


def test_ws_redirect_is_not_followed(server):
    server.targets = [server.target("g", "/p/g")]
    server.ws_scripts = {"/p/g": [echo_value(json.dumps(GAME))]}
    server.redirect_to = f"ws://127.0.0.1:{server.port}/p/g"   # even a loopback redirect must be refused
    server.targets = lambda: (200, json.dumps([{"id": "g", "type": "page", "title": "g", "url": "x", "webSocketDebuggerUrl": server.ws_url("/p/g")}]).encode())
    # discovery itself must not redirect, so serve /json normally and redirect only the upgrade
    server.redirect_to = None
    server.ws_redirect_to = f"ws://127.0.0.1:{server.port}/p/g"
    r = run(server)
    assert r.status is doctor.DoctorStatus.TARGET_PROBE_FAILED
    assert r.targets[0]["error"]["code"] == "TARGET_CONNECT_FAILED"
    assert server.connections == ["/p/g"], "client must not have followed the redirect"


def test_invalid_ws_frame_is_malformed_not_a_crash(server):
    server.targets = [server.target("g", "/p/g")]
    server.ws_scripts = {"/p/g": [SendRaw(b"\x8f\x05hello")]}   # reserved opcode 0xF
    r = run(server)
    assert r.status is doctor.DoctorStatus.TARGET_PROBE_FAILED
    assert r.targets[0]["error"]["code"] == "CDP_MALFORMED"
