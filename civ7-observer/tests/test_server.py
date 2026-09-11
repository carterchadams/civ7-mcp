import json

import pytest

from civ7_observer import server as srv
from civ7_observer import service
from test_schema import GOOD
from test_targets import GAME, MENU, Factory, reply, target

OBS = {**GOOD, "context": {**GOOD["context"], "turn": GAME["turn"]}}


def make(scripts, player=1, mode="singleplayer", targets=None):
    tl = targets if targets is not None else [target("a")]
    f = Factory(scripts)
    s = srv.build_server(port=9444, timeout=1, player=player, mode=mode, discover=lambda p, t: tl, session_factory=f)
    return s, f


def tool(s, name):
    return s._tool_manager.get_tool(name)


def test_server_exposes_exactly_two_read_only_tools():
    s, _ = make({"a": []})
    names = sorted(t.name for t in s._tool_manager.list_tools())
    assert names == ["get_observation", "get_status"]
    for n in names:
        t = tool(s, n)
        assert t.annotations.readOnlyHint is True
        assert t.annotations.destructiveHint is False
        assert t.annotations.openWorldHint is False
        assert t.parameters.get("properties", {}) == {}, "tools accept no arguments"
        assert "read-only" in t.description.lower() or "read only" in t.description.lower()


def test_build_server_requires_explicit_player_and_mode():
    with pytest.raises(ValueError):
        srv.build_server(port=9444, timeout=1, player=None, mode="singleplayer")
    with pytest.raises(ValueError):
        srv.build_server(port=9444, timeout=1, player=1, mode="network")


def test_get_observation_returns_validated_observation(capsys):
    ctx = json.dumps(GAME)
    s, f = make({"a": [reply(1, ctx), reply(1, ctx), reply(2, json.dumps(OBS)), reply(3, ctx)]})
    out = tool(s, "get_observation").fn()
    assert out["schemaVersion"] == 1 and out["context"]["playerId"] == 1
    assert out["settlements"][0]["displayName"] == "Madrid"
    assert "omittedFeatures" in out and "resources" in out["omittedFeatures"]
    captured = capsys.readouterr()
    assert captured.out == "", "stdout is reserved for the MCP transport"
    assert "ws://" not in json.dumps(out)


def test_get_observation_returns_typed_error_not_exception():
    s, _ = make({"a": [reply(1, json.dumps(MENU))]})
    out = tool(s, "get_observation").fn()
    assert out["error"]["code"] == "NOT_IN_GAME"
    assert set(out) == {"error"}


def test_get_observation_refuses_when_bound_player_is_not_the_seat():
    ctx = json.dumps(GAME)
    s, _ = make({"a": [reply(1, ctx), reply(1, ctx)]}, player=0)
    out = tool(s, "get_observation").fn()
    assert out["error"]["code"] == "WRONG_PLAYER"


def test_get_observation_maps_transport_failure_to_error():
    s, _ = make({"a": ConnectionRefusedError()})
    out = tool(s, "get_observation").fn()
    assert out["error"]["code"] == "TARGET_PROBE_FAILED"


ELIGIBLE = {"payloadVersion": 1, "guardsOnly": True, "refused": None, "context": {**OBS["context"]}, "settlements": None, "units": None, "technology": None, "civics": None, "map": None, "warnings": []}


def eligibility(code=None, message="no"):
    if code is None:
        return json.dumps(ELIGIBLE)
    return json.dumps({**ELIGIBLE, "refused": {"code": code, "message": message}, "context": None})


def test_get_status_reports_readiness_without_other_seats():
    ctx = json.dumps(GAME)
    # doctor(1) | reopen(1) eligibility(2)
    s, _ = make({"a": [reply(1, ctx), reply(1, ctx), reply(2, eligibility())]})
    st = tool(s, "get_status").fn()
    assert st["status"] == "IN_GAME" and st["ready"] is True
    assert st["boundPlayerId"] == 1 and st["allowedMode"] == "singleplayer"
    assert st["context"] == {"turn": 12, "age": 4242, "localPlayerId": 1, "localObserverId": 1}
    assert "targets" not in st and "ws://" not in json.dumps(st)


def test_get_status_not_ready_when_seat_differs():
    ctx = json.dumps(GAME)
    s, _ = make({"a": [reply(1, ctx), reply(1, ctx)]}, player=0)
    st = tool(s, "get_status").fn()
    assert st["status"] == "IN_GAME" and st["ready"] is False and st["reason"] == "WRONG_PLAYER"


@pytest.mark.parametrize("code", ["UNSUPPORTED_GAME_MODE", "TURN_NOT_READY", "NOT_IN_GAME"])
def test_get_status_not_ready_when_capture_guards_would_refuse(code):
    ctx = json.dumps(GAME)
    s, _ = make({"a": [reply(1, ctx), reply(1, ctx), reply(2, eligibility(code))]})
    st = tool(s, "get_status").fn()
    assert st["ready"] is False and st["reason"] == code
    assert st["context"] is not None


def test_get_status_not_ready_when_eligibility_probe_fails():
    ctx = json.dumps(GAME)
    s, _ = make({"a": [reply(1, ctx), reply(1, ctx), reply(2, "garbage")]})
    st = tool(s, "get_status").fn()
    assert st["ready"] is False and st["reason"] == "API_CONTRACT_MISMATCH"


def test_get_status_when_debugger_absent():
    s, _ = make({"a": []}, targets=[])
    st = tool(s, "get_status").fn()
    assert st["ready"] is False and st["status"] == "NO_GAME_TARGET" and st["reason"] == "NO_GAME_TARGET"


def test_get_status_ready_reports_mode_and_turn_active():
    ctx = json.dumps(GAME)
    s, _ = make({"a": [reply(1, ctx), reply(1, ctx), reply(2, eligibility())]})
    st = tool(s, "get_status").fn()
    assert st["ready"] is True and st["eligibility"] == {"mode": "singleplayer", "isTurnActive": True}


def test_observation_ids_fresh_and_session_stable_across_calls():
    ctx = json.dumps(GAME)
    script = [reply(1, ctx), reply(1, ctx), reply(2, json.dumps(OBS)), reply(3, ctx)] * 2
    # ids restart per connection: doctor(1) | reopen(1) capture(2) after(3) | doctor(1) | reopen(1) capture(2) after(3)
    s, _ = make({"a": script})
    a = tool(s, "get_observation").fn()
    b = tool(s, "get_observation").fn()
    assert a["observationId"] != b["observationId"]
    assert a["sessionId"] == b["sessionId"]
