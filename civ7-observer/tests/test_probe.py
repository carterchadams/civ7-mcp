import json
import os

import pytest

from civ7_observer import probe, service
from civ7_observer.payloads import load_payload, render_payload
from test_targets import GAME, Factory, reply, target

CAPS = {"probeVersion": 1, "boundPlayerId": 1, "seatMismatch": False, "context": {"turn": 12}, "errors": []}


def run_probe(tmp_path, scripts, **kw):
    tl = [target("a")]
    out = tmp_path / "runs" / "capabilities.json"
    kw.setdefault("player", None)
    return probe.run_probe(port=9444, timeout=1, out=out, discover=lambda p, t: tl, session_factory=Factory(scripts), **kw), out


# ---- render_payload

def test_render_payload_substitutes_bound_player_id():
    text = render_payload("capabilities.js", bound_player_id=3)
    assert "BOUND_PLAYER_ID" not in text
    assert "3" in text


@pytest.mark.parametrize("bad", [-1, "1", 1.5, True, None])
def test_render_payload_rejects_non_engine_ids(bad):
    with pytest.raises(ValueError):
        render_payload("capabilities.js", bound_player_id=bad)


def test_render_payload_leaves_context_probe_untouched():
    assert render_payload("context.js", bound_player_id=0) == load_payload("context.js")


# ---- run_probe

def test_probe_defaults_to_local_player_and_writes_file(tmp_path):
    scripts = {"a": [reply(1, json.dumps(GAME)), reply(1, json.dumps(GAME)), reply(2, json.dumps(CAPS)), reply(3, json.dumps(GAME))]}
    result, out = run_probe(tmp_path, scripts)
    assert result.bound_player_id == 1
    assert result.path == out
    assert json.loads(out.read_text())["boundPlayerId"] == 1
    assert not list(out.parent.glob("*.tmp"))


def test_probe_sends_rendered_payload_with_local_player(tmp_path):
    f_scripts = {"a": [reply(1, json.dumps(GAME)), reply(1, json.dumps(GAME)), reply(2, json.dumps(CAPS)), reply(3, json.dumps(GAME))]}
    tl = [target("a")]
    f = Factory(f_scripts)
    probe.run_probe(port=9444, timeout=1, out=tmp_path / "c.json", player=None, discover=lambda p, t: tl, session_factory=f)
    sent = json.loads(f.all_sockets[1].sent[1])["params"]["expression"]
    assert sent == render_payload("capabilities.js", bound_player_id=1)


def test_probe_refuses_player_that_is_not_the_local_seat(tmp_path):
    scripts = {"a": [reply(1, json.dumps(GAME)), reply(1, json.dumps(GAME))]}
    with pytest.raises(service.ObserverError) as ei:
        run_probe(tmp_path, scripts, player=0)
    assert ei.value.code == "WRONG_PLAYER"
    assert not (tmp_path / "runs" / "capabilities.json").exists()


def test_probe_rejects_non_object_or_mismatched_result(tmp_path):
    scripts = {"a": [reply(1, json.dumps(GAME)), reply(1, json.dumps(GAME)), reply(2, json.dumps({**CAPS, "boundPlayerId": 7}))]}
    with pytest.raises(service.ObserverError) as ei:
        run_probe(tmp_path, scripts)
    assert ei.value.code == "API_CONTRACT_MISMATCH"


def test_probe_rejects_seat_mismatch_reported_by_payload(tmp_path):
    scripts = {"a": [reply(1, json.dumps(GAME)), reply(1, json.dumps(GAME)), reply(2, json.dumps({**CAPS, "seatMismatch": True}))]}
    with pytest.raises(service.ObserverError) as ei:
        run_probe(tmp_path, scripts)
    assert ei.value.code == "WRONG_PLAYER"


def test_probe_fails_when_turn_changes_during_capture(tmp_path):
    scripts = {"a": [reply(1, json.dumps(GAME)), reply(1, json.dumps(GAME)), reply(2, json.dumps({**CAPS, "context": {"turn": 13}})), reply(3, json.dumps(GAME))]}
    with pytest.raises(service.ObserverError) as ei:
        run_probe(tmp_path, scripts)
    assert ei.value.code == "CONTEXT_CHANGED"
