import json

import pytest

from civ7_observer import cdp, targets
from civ7_observer.payloads import load_payload
from scripted_socket import ScriptedSocket

GAME = {"probeVersion": 1, "hasUI": True, "hasGameContext": True, "hasGame": True, "inGame": True,
        "hasPlayers": True, "hasMap": True, "localPlayerId": 1, "localObserverId": 1, "turn": 12, "age": 4242, "href": "coui://ui/x"}
MENU = {**GAME, "inGame": False, "hasGameContext": False, "hasGame": False, "localPlayerId": None, "localObserverId": None, "turn": None, "age": None}
NON_GAME = {**MENU, "hasUI": False, "hasPlayers": False, "hasMap": False}
INCONSISTENT = {**GAME, "hasPlayers": False}


def reply(id_, value):
    return json.dumps({"id": id_, "result": {"result": {"type": "string", "value": value}}})


def target(id_, ws="ok"):
    ws_url = f"ws://127.0.0.1:9444/devtools/page/{id_}" if ws else None
    return cdp.CdpTarget(index=0, id=id_, title=id_, type="page", url=None, ws_url=ws_url,
                         ws_url_error=None if ws else "missing")


class Factory:
    """Builds CdpSessions over scripted sockets keyed by target id.

    The reply script for an id is shared across connections, so a second
    connection to the same target continues consuming where the first stopped.
    """

    def __init__(self, scripts):
        from collections import deque
        self.scripts = {k: (v if isinstance(v, Exception) else deque(v)) for k, v in scripts.items()}
        self.sockets = {}
        self.all_sockets = []
        self.connects = []

    def __call__(self, ws_url, *, timeout):
        id_ = ws_url.rsplit("/", 1)[-1]
        self.connects.append(id_)
        script = self.scripts[id_]
        if isinstance(script, Exception):
            def connect(u, t):
                raise script
        else:
            sock = ScriptedSocket(script)
            self.sockets[id_] = sock
            self.all_sockets.append(sock)

            def connect(u, t):
                return sock
        return cdp.CdpSession(ws_url, timeout=timeout, connect=connect)


# ---- payload loading

def test_payload_loads_independent_of_cwd(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    text = load_payload("context.js")
    assert text.lstrip().startswith("//") or text.lstrip().startswith("(() =>")
    assert "JSON.stringify" in text


def test_payload_missing_raises():
    with pytest.raises(targets.PayloadMissing):
        load_payload("nope.js")


# ---- parse_realm_probe

def test_parse_realm_probe_valid():
    p = targets.parse_realm_probe(json.dumps(GAME))
    assert p.in_game is True and p.local_player_id == 1 and p.turn == 12


@pytest.mark.parametrize("value", [42, None, "not json", "[1]", json.dumps({**GAME, "turn": "5"}),
                                   json.dumps({**GAME, "turn": 1.5}), json.dumps({**GAME, "localPlayerId": True}),
                                   json.dumps({**GAME, "inGame": "yes"}), json.dumps({k: v for k, v in GAME.items() if k != "turn"}),
                                   json.dumps({**GAME, "extra": 1}), json.dumps({**GAME, "probeVersion": 2})])
def test_parse_realm_probe_rejects_bad_contract(value):
    with pytest.raises(targets.RealmProbeInvalid) as ei:
        targets.parse_realm_probe(value)
    assert ei.value.code == "API_CONTRACT_MISMATCH"


def test_parse_exposes_age():
    assert targets.parse_realm_probe(json.dumps(GAME)).age == 4242
    assert targets.parse_realm_probe(json.dumps(MENU)).age is None


def test_game_realm_requires_age():
    probe = targets.parse_realm_probe(json.dumps({**GAME, "age": None}))
    assert targets.classify(probe) == targets.RealmKind.INCONSISTENT


def test_parse_accepts_in_game_null_as_unknown():
    p = targets.parse_realm_probe(json.dumps({**MENU, "inGame": None}))
    assert p.in_game is None


# ---- classify

@pytest.mark.parametrize("probe, kind", [
    (GAME, targets.RealmKind.GAME), (MENU, targets.RealmKind.MENU),
    (NON_GAME, targets.RealmKind.NON_GAME), (INCONSISTENT, targets.RealmKind.INCONSISTENT),
    ({**MENU, "inGame": None}, targets.RealmKind.MENU),
])
def test_classify(probe, kind):
    assert targets.classify(targets.parse_realm_probe(json.dumps(probe))) == kind


# ---- select_game_target

def test_select_single_game_among_menu_and_non_game():
    f = Factory({"a": [reply(1, json.dumps(MENU))], "b": [reply(1, json.dumps(GAME))], "c": [reply(1, json.dumps(NON_GAME))]})
    sel = targets.select_game_target([target("a"), target("b"), target("c")], timeout=1, session_factory=f)
    assert sel.selected.target.id == "b"
    assert [p.kind for p in sel.probes] == [targets.RealmKind.MENU, targets.RealmKind.GAME, targets.RealmKind.NON_GAME]
    assert f.connects == ["a", "b", "c"]
    assert json.loads(f.sockets["b"].sent[0])["params"]["expression"] == load_payload("context.js")


def test_select_two_game_realms_is_ambiguous():
    f = Factory({"a": [reply(1, json.dumps(GAME))], "b": [reply(1, json.dumps(GAME))]})
    sel = targets.select_game_target([target("a"), target("b")], timeout=1, session_factory=f)
    assert sel.selected is None
    assert [p.target.id for p in sel.game_candidates] == ["a", "b"]


def test_select_continues_after_transport_error():
    f = Factory({"a": ConnectionRefusedError(), "b": [reply(1, json.dumps(GAME))]})
    sel = targets.select_game_target([target("a"), target("b")], timeout=1, session_factory=f)
    assert sel.selected.target.id == "b"
    assert sel.probes[0].kind == targets.RealmKind.ERROR
    assert sel.probes[0].error["code"] == "TARGET_CONNECT_FAILED"
    assert sel.probes[0].contract is False


def test_select_records_evaluate_exception_as_contract_issue():
    exc = json.dumps({"id": 1, "result": {"result": {"type": "undefined"}, "exceptionDetails": {"text": "Uncaught"}}})
    f = Factory({"a": [exc]})
    sel = targets.select_game_target([target("a")], timeout=1, session_factory=f)
    assert sel.probes[0].kind == targets.RealmKind.ERROR
    assert sel.probes[0].contract is True


def test_select_records_invalid_probe_shape_as_contract_issue():
    f = Factory({"a": [reply(1, "garbage")]})
    sel = targets.select_game_target([target("a")], timeout=1, session_factory=f)
    assert sel.probes[0].error["code"] == "API_CONTRACT_MISMATCH"
    assert sel.probes[0].contract is True


def test_select_invalid_ws_url_never_connects():
    f = Factory({})
    sel = targets.select_game_target([target("a", ws=None)], timeout=1, session_factory=f)
    assert f.connects == []
    assert sel.probes[0].kind == targets.RealmKind.ERROR
    assert sel.probes[0].error["code"] == "INVALID_TARGET_URL"


def test_target_id_override_filters():
    f = Factory({"a": [reply(1, json.dumps(GAME))], "b": [reply(1, json.dumps(GAME))]})
    sel = targets.select_game_target([target("a"), target("b")], timeout=1, session_factory=f, target_id="b")
    assert f.connects == ["b"]
    assert sel.selected.target.id == "b"


def test_target_id_override_to_menu_is_not_selected():
    f = Factory({"a": [reply(1, json.dumps(MENU))]})
    sel = targets.select_game_target([target("a")], timeout=1, session_factory=f, target_id="a")
    assert sel.selected is None


def test_every_session_closed_even_on_error():
    f = Factory({"a": [reply(1, "garbage")], "b": [reply(1, json.dumps(GAME))]})
    targets.select_game_target([target("a"), target("b")], timeout=1, session_factory=f)
    assert all(s.closed == 1 for s in f.sockets.values())


def test_probe_records_duration():
    f = Factory({"a": [reply(1, json.dumps(GAME))]})
    (p,) = targets.select_game_target([target("a")], timeout=1, session_factory=f).probes
    assert isinstance(p.duration_ms, int) and p.duration_ms >= 0


@pytest.mark.parametrize("field", ["turn", "localPlayerId", "localObserverId"])
def test_game_realm_with_null_context_field_is_inconsistent(field):
    probe = targets.parse_realm_probe(json.dumps({**GAME, field: None}))
    assert targets.classify(probe) == targets.RealmKind.INCONSISTENT


@pytest.mark.parametrize("field, value", [("localPlayerId", -1), ("localObserverId", -1), ("turn", -3)])
def test_game_realm_with_negative_identity_is_inconsistent(field, value):
    probe = targets.parse_realm_probe(json.dumps({**GAME, field: value}))
    assert targets.classify(probe) == targets.RealmKind.INCONSISTENT
