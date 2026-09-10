import json
import threading

import pytest
import websocket

from civ7_observer import cdp
from scripted_socket import ScriptedSocket

WS = "ws://127.0.0.1:9444/devtools/page/1"


def reply(id_, value, **extra):
    msg = {"id": id_, "result": {"result": {"type": "string", "value": value}}}
    msg["result"].update(extra)
    return json.dumps(msg)


class FakeClock:
    def __init__(self, step=0.0):
        self.now = 0.0
        self.step = step

    def __call__(self):
        t = self.now
        self.now += self.step
        return t


def make_session(script, timeout=5.0, clock=None):
    sock = ScriptedSocket(script)
    session = cdp.CdpSession(WS, timeout=timeout, connect=lambda url, t: sock, clock=clock or FakeClock())
    return sock, session


# ---- validate_ws_url ----

@pytest.mark.parametrize("bad", [
    "ws://10.0.0.5:9444/x", "ws://civ.example/x", "wss://127.0.0.1/x",
    "http://127.0.0.1/x", "", None, 42, "ws://127.0.0.1", "ws:///x",
])
def test_rejects_invalid_ws_destinations(bad):
    with pytest.raises(cdp.InvalidTargetUrl):
        cdp.validate_ws_url(bad)


@pytest.mark.parametrize("good", [
    "ws://127.0.0.1:9444/devtools/page/1", "ws://localhost:9444/x", "ws://[::1]:1/x",
])
def test_accepts_loopback_variants(good):
    assert cdp.validate_ws_url(good) == good


def test_session_rejects_bad_url_without_connecting():
    calls = []
    with pytest.raises(cdp.InvalidTargetUrl):
        cdp.CdpSession("ws://10.0.0.5:9444/x", timeout=1.0, connect=lambda u, t: calls.append(u))
    assert calls == []


# ---- evaluate_readonly ----

def test_evaluate_sends_runtime_evaluate_with_return_by_value():
    sock, session = make_session([reply(1, "hi")])
    with session:
        assert session.evaluate_readonly("1+1") == "hi"
    sent = json.loads(sock.sent[0])
    assert sent["method"] == "Runtime.evaluate"
    assert sent["params"]["expression"] == "1+1"
    assert sent["params"]["returnByValue"] is True
    assert sent["params"]["awaitPromise"] is False
    assert sock.closed == 1


def test_ids_monotonic_across_calls():
    sock, session = make_session([reply(1, "a"), reply(2, "b"), reply(3, "c")])
    with session:
        assert [session.evaluate_readonly("x") for _ in range(3)] == ["a", "b", "c"]
    assert [json.loads(s)["id"] for s in sock.sent] == [1, 2, 3]


def test_events_before_response_are_ignored():
    events = [json.dumps({"method": "Runtime.consoleAPICalled", "params": {}})] * 2
    sock, session = make_session(events + [reply(1, "v")])
    with session:
        assert session.evaluate_readonly("x") == "v"
    assert session.events_ignored == 2


def test_stale_response_id_is_ignored():
    sock, session = make_session([reply(99, "stale"), reply(1, "v")])
    with session:
        assert session.evaluate_readonly("x") == "v"
    assert session.stale_responses_ignored == 1


@pytest.mark.parametrize("frame", ["{not json", "[1]", '"x"', "null", b"\x00\x01", "{\"id\":1}", '{"id":1,"result":"x"}', '{"id":1,"result":{"result":"x"}}'])
def test_malformed_replies_raise_malformed(frame):
    sock, session = make_session([frame])
    with session, pytest.raises(cdp.CdpMalformedResponse):
        session.evaluate_readonly("x")
    assert sock.closed == 1


def test_protocol_error_raises_protocol_error():
    sock, session = make_session([json.dumps({"id": 1, "error": {"code": -32000, "message": "nope"}})])
    with session, pytest.raises(cdp.CdpProtocolError) as ei:
        session.evaluate_readonly("x")
    assert ei.value.protocol_code == -32000
    assert ei.value.protocol_message == "nope"
    assert ei.value.code == "CDP_PROTOCOL_ERROR"


def test_exception_details_win_even_with_value():
    details = {"text": "Uncaught", "lineNumber": 3, "columnNumber": 7, "exception": {"description": "ReferenceError: UI is not defined"}}
    sock, session = make_session([reply(1, "looks-valid", exceptionDetails=details)])
    with session, pytest.raises(cdp.CdpEvaluateException) as ei:
        session.evaluate_readonly("x")
    assert ei.value.text == "Uncaught"
    assert "ReferenceError" in ei.value.description
    assert ei.value.line == 3


def test_undefined_result_raises_missing_value():
    sock, session = make_session([json.dumps({"id": 1, "result": {"result": {"type": "undefined"}}})])
    with session, pytest.raises(cdp.CdpMissingValue) as ei:
        session.evaluate_readonly("x")
    assert ei.value.remote_type == "undefined"


def test_recv_timeout_raises_deadline():
    sock, session = make_session([websocket.WebSocketTimeoutException()])
    with session, pytest.raises(cdp.CdpDeadlineExceeded):
        session.evaluate_readonly("x")
    assert sock.closed == 1


def test_event_flood_cannot_extend_deadline():
    event = json.dumps({"method": "X.y", "params": {}})
    sock, session = make_session([event] * 100, timeout=3.0, clock=FakeClock(step=1.0))
    with session, pytest.raises(cdp.CdpDeadlineExceeded):
        session.evaluate_readonly("x")
    assert len(sock.script) > 90
    assert sock.timeouts == sorted(sock.timeouts, reverse=True)


def test_session_poisoned_after_deadline():
    sock, session = make_session([websocket.WebSocketTimeoutException(), reply(2, "late")])
    with session:
        with pytest.raises(cdp.CdpDeadlineExceeded):
            session.evaluate_readonly("x")
        with pytest.raises(cdp.CdpConnectionClosed):
            session.evaluate_readonly("y")
    assert len(sock.sent) == 1


@pytest.mark.parametrize("item", [websocket.WebSocketConnectionClosedException(), "", OSError("reset")])
def test_closed_connection_raises_closed(item):
    sock, session = make_session([item])
    with session, pytest.raises(cdp.CdpConnectionClosed):
        session.evaluate_readonly("x")
    assert sock.closed == 1


@pytest.mark.parametrize("exc", [ConnectionRefusedError(), websocket.WebSocketBadStatusException("bad", 404), OSError("x")])
def test_connect_failure_raises_connect_failed(exc):
    def connect(url, t):
        raise exc
    with pytest.raises(cdp.CdpConnectFailed):
        with cdp.CdpSession(WS, timeout=1.0, connect=connect):
            pass


def test_close_is_idempotent():
    sock, session = make_session([reply(1, "v")])
    with session:
        session.evaluate_readonly("x")
    session.close()
    session.close()
    assert sock.closed == 1


def test_mutex_serializes_concurrent_evaluates():
    n = 10
    sock, session = make_session([reply(i, str(i)) for i in range(1, n + 1)])
    results = []

    def worker():
        for _ in range(n // 2):
            results.append(session.evaluate_readonly("x"))

    with session:
        threads = [threading.Thread(target=worker) for _ in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
    assert sorted(results, key=int) == [str(i) for i in range(1, n + 1)]
    assert sock.overlap_detected is False


def test_errors_serialize_to_dict():
    err = cdp.CdpProtocolError(-1, "m")
    d = err.to_dict()
    assert d["code"] == "CDP_PROTOCOL_ERROR"
    assert d["protocolCode"] == -1
    assert "message" in d


def test_close_passes_bounded_timeout():
    sock, session = make_session([reply(1, "v")])
    with session:
        session.evaluate_readonly("x")
    assert sock.close_timeouts == [cdp.CLOSE_TIMEOUT]
    assert 0 < cdp.CLOSE_TIMEOUT <= 1.0


def test_deadline_includes_time_spent_waiting_for_mutex():
    clock = FakeClock()
    sock, session = make_session([reply(1, "v")], timeout=2.0, clock=clock)
    with session:
        session._lock.acquire()
        outcome = {}

        def worker():
            try:
                outcome["value"] = session.evaluate_readonly("x")
            except cdp.CdpError as exc:
                outcome["error"] = exc

        t = threading.Thread(target=worker)
        t.start()
        t.join(0.2)
        clock.now += 5.0  # the caller has now waited longer than its budget
        session._lock.release()
        t.join(2)
    assert isinstance(outcome.get("error"), cdp.CdpDeadlineExceeded)
    assert sock.sent == []
