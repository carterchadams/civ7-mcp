import json

import pytest

from civ7_observer import cdp, service, targets
from test_targets import GAME, MENU, Factory, reply, target


def open_with(specs, scripts, **kw):
    tl = [target(i) for i in specs]
    return service.open_game_session(port=9444, timeout=1, discover=lambda p, t: tl, session_factory=Factory(scripts), **kw)


def test_open_game_session_returns_bound_context_and_live_session():
    f = Factory({"a": [reply(1, json.dumps(GAME)), reply(1, json.dumps(GAME)), reply(2, "again")]})
    tl = [target("a")]
    with service.open_game_session(port=9444, timeout=1, discover=lambda p, t: tl, session_factory=f) as gs:
        assert gs.target.id == "a"
        assert gs.context.turn == 12 and gs.context.local_player_id == 1
        assert gs.session.evaluate_readonly("x") == "again"
    assert f.sockets["a"].closed == 1


def test_open_game_session_at_menu_raises_not_in_game():
    with pytest.raises(service.ObserverError) as ei:
        open_with(["a"], {"a": [reply(1, json.dumps(MENU))]})
    assert ei.value.code == "NOT_IN_GAME"


def test_open_game_session_debugger_absent_raises():
    def discover(p, t):
        raise cdp.DiscoveryUnavailable("refused")
    with pytest.raises(service.ObserverError) as ei:
        service.open_game_session(port=9444, timeout=1, discover=discover, session_factory=Factory({}))
    assert ei.value.code == "DEBUGGER_UNAVAILABLE"


def test_open_game_session_ambiguous_raises():
    with pytest.raises(service.ObserverError) as ei:
        open_with(["a", "b"], {"a": [reply(1, json.dumps(GAME))], "b": [reply(1, json.dumps(GAME))]})
    assert ei.value.code == "AMBIGUOUS_GAME_TARGET"


def test_open_game_session_rechecks_context_on_reconnect():
    # the second connection (the working session) must see the same seat/turn as the doctor probe
    changed = {**GAME, "localPlayerId": 0, "localObserverId": 0}
    f = Factory({"a": [reply(1, json.dumps(GAME)), reply(1, json.dumps(changed))]})
    tl = [target("a")]
    with pytest.raises(service.ObserverError) as ei:
        service.open_game_session(port=9444, timeout=1, discover=lambda p, t: tl, session_factory=f)
    assert ei.value.code == "CONTEXT_CHANGED"


def test_second_discovery_failure_is_a_typed_observer_error():
    calls = {"n": 0}
    tl = [target("a")]

    def discover(p, t):
        calls["n"] += 1
        if calls["n"] == 2:
            raise cdp.DiscoveryUnavailable("gone")
        return tl

    f = Factory({"a": [reply(1, json.dumps(GAME))]})
    with pytest.raises(service.ObserverError) as ei:
        service.open_game_session(port=9444, timeout=1, discover=discover, session_factory=f)
    assert ei.value.code == "DEBUGGER_UNAVAILABLE"


def test_reopened_context_not_in_game_is_refused():
    menu_like = {**GAME, "inGame": False}
    f = Factory({"a": [reply(1, json.dumps(GAME)), reply(1, json.dumps(menu_like))]})
    tl = [target("a")]
    with pytest.raises(service.ObserverError) as ei:
        service.open_game_session(port=9444, timeout=1, discover=lambda p, t: tl, session_factory=f)
    assert ei.value.code == "NOT_IN_GAME"
    assert f.all_sockets[-1].closed == 1


def test_read_context_transport_failure_is_a_typed_observer_error():
    import websocket
    f = Factory({"a": [reply(1, json.dumps(GAME)), reply(1, json.dumps(GAME)), websocket.WebSocketConnectionClosedException()]})
    tl = [target("a")]
    with service.open_game_session(port=9444, timeout=1, discover=lambda p, t: tl, session_factory=f) as gs:
        with pytest.raises(service.ObserverError) as ei:
            gs.read_context()
    assert ei.value.code == "CDP_CONNECTION_CLOSED"


def test_open_game_session_detects_age_only_change_on_reopen():
    changed = {**GAME, "age": 5555}
    f = Factory({"a": [reply(1, json.dumps(GAME)), reply(1, json.dumps(changed))]})
    tl = [target("a")]
    with pytest.raises(service.ObserverError) as ei:
        service.open_game_session(port=9444, timeout=1, discover=lambda p, t: tl, session_factory=f)
    assert ei.value.code == "CONTEXT_CHANGED"


def test_open_game_session_detects_game_guid_change_on_reopen():
    changed = {**GAME, "gameGuid": "FFFF000011112222"}
    f = Factory({"a": [reply(1, json.dumps(GAME)), reply(1, json.dumps(changed))]})
    tl = [target("a")]
    with pytest.raises(service.ObserverError) as ei:
        service.open_game_session(port=9444, timeout=1, discover=lambda p, t: tl, session_factory=f)
    assert ei.value.code == "CONTEXT_CHANGED"
