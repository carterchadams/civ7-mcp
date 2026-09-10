import json

import pytest

from civ7_observer import service, snapshot
from civ7_observer.payloads import render_payload
from test_schema import GOOD
from test_targets import GAME, Factory, reply, target

# payload context must agree with the scripted session context (GAME has turn 12)
OBS = {**GOOD, "context": {**GOOD["context"], "turn": GAME["turn"]}}


def run_snapshot(tmp_path, payload_value, player=None, mode="singleplayer", after=None):
    ctx = json.dumps(GAME)
    scripts = {"a": [reply(1, ctx), reply(1, ctx), reply(2, payload_value), reply(3, after or ctx)]}
    tl = [target("a")]
    f = Factory(scripts)
    out = tmp_path / "observation.json"
    res = snapshot.run_snapshot(port=9444, timeout=1, out=out, player=player, mode=mode, discover=lambda p, t: tl, session_factory=f)
    return res, out, f


def test_snapshot_writes_validated_observation(tmp_path):
    res, out, f = run_snapshot(tmp_path, json.dumps(OBS))
    doc = json.loads(out.read_text())
    assert doc["schemaVersion"] == 1 and doc["context"]["playerId"] == 1
    assert doc["settlements"][0]["displayName"] == "Madrid"
    assert res.observation_id == doc["observationId"] and res.session_id == doc["sessionId"]
    assert "ws://" not in out.read_text()


def test_snapshot_sends_rendered_payload_with_mode_and_player(tmp_path):
    _, _, f = run_snapshot(tmp_path, json.dumps(OBS), mode="singleplayer")
    sent = json.loads(f.all_sockets[1].sent[1])["params"]["expression"]
    assert sent == render_payload("observe.js", bound_player_id=1, allowed_mode="singleplayer")
    assert "BOUND_PLAYER_ID" not in sent and "ALLOWED_MODE" not in sent


def test_snapshot_maps_payload_refusal_to_typed_error(tmp_path):
    refused = {"payloadVersion": 1, "refused": {"code": "UNSUPPORTED_GAME_MODE", "message": "hotseat"}, "context": None, "settlements": None, "units": None, "warnings": []}
    with pytest.raises(service.ObserverError) as ei:
        run_snapshot(tmp_path, json.dumps(refused))
    assert ei.value.code == "UNSUPPORTED_GAME_MODE"
    assert not (tmp_path / "observation.json").exists()


def test_snapshot_rejects_invalid_payload(tmp_path):
    bad = {**OBS, "extra": 1}
    with pytest.raises(service.ObserverError) as ei:
        run_snapshot(tmp_path, json.dumps(bad))
    assert ei.value.code == "INVALID_OBSERVATION"


def test_snapshot_refuses_wrong_player_before_evaluating(tmp_path):
    with pytest.raises(service.ObserverError) as ei:
        run_snapshot(tmp_path, json.dumps(OBS), player=0)
    assert ei.value.code == "WRONG_PLAYER"


def test_snapshot_rejects_bad_mode_argument(tmp_path):
    with pytest.raises(ValueError):
        run_snapshot(tmp_path, json.dumps(OBS), mode="network")


def test_snapshot_discards_when_context_changes_after(tmp_path):
    changed = json.dumps({**GAME, "turn": 13})
    with pytest.raises(service.ObserverError) as ei:
        run_snapshot(tmp_path, json.dumps(OBS), after=changed)
    assert ei.value.code == "CONTEXT_CHANGED"


def test_snapshot_rejects_payload_context_that_disagrees_with_session(tmp_path):
    other = {**OBS, "context": {**OBS["context"], "turn": 99}}
    with pytest.raises(service.ObserverError) as ei:
        run_snapshot(tmp_path, json.dumps(other))
    assert ei.value.code == "CONTEXT_CHANGED"


def test_two_snapshots_in_one_process_share_session_but_not_observation_ids(tmp_path):
    r1, _, _ = run_snapshot(tmp_path, json.dumps(OBS))
    r2, _, _ = run_snapshot(tmp_path, json.dumps(OBS))
    assert r1.observation_id != r2.observation_id
