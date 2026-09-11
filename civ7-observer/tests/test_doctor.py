import json

import pytest

from civ7_observer import cdp, doctor, targets
from test_targets import GAME, MENU, NON_GAME, INCONSISTENT, Factory, reply, target


def run(target_specs, scripts, **kw):
    """target_specs: list of (id, has_ws). scripts: id -> socket script or exception."""
    tl = [target(i, ws) for i, ws in target_specs]
    return doctor.run_doctor(port=9444, timeout=1, discover=lambda port, timeout: tl, session_factory=Factory(scripts), **kw)


def test_debugger_unavailable():
    def discover(port, timeout):
        raise cdp.DiscoveryUnavailable("refused")
    r = doctor.run_doctor(port=9444, timeout=1, discover=discover, session_factory=Factory({}))
    assert r.status is doctor.DoctorStatus.DEBUGGER_UNAVAILABLE
    assert r.ok is False and r.exit_code() == 1 and r.context is None
    assert r.discovery["error"]["code"] == "DEBUGGER_UNAVAILABLE"


def test_discovery_invalid():
    def discover(port, timeout):
        raise cdp.DiscoveryInvalid("bad")
    r = doctor.run_doctor(port=9444, timeout=1, discover=discover, session_factory=Factory({}))
    assert r.status is doctor.DoctorStatus.DISCOVERY_INVALID and r.ok is False


def test_in_game():
    r = run([("a", True), ("b", True)], {"a": [reply(1, json.dumps(MENU))], "b": [reply(1, json.dumps(GAME))]})
    assert r.status is doctor.DoctorStatus.IN_GAME
    assert r.ok is True and r.exit_code() == 0
    assert r.selected["id"] == "b"
    assert r.context == {"turn": 12, "age": 4242, "localPlayerId": 1, "localObserverId": 1, "gameGuid": "ABCDEF0123456789"}
    assert len(r.targets) == 2


def test_ambiguous_game_target():
    r = run([("a", True), ("b", True)], {"a": [reply(1, json.dumps(GAME))], "b": [reply(1, json.dumps(GAME))]})
    assert r.status is doctor.DoctorStatus.AMBIGUOUS_GAME_TARGET
    assert r.selected is None and r.context is None
    assert "--target-id" in r.summary


def test_not_in_game():
    r = run([("a", True), ("b", True)], {"a": [reply(1, json.dumps(MENU))], "b": [reply(1, json.dumps(NON_GAME))]})
    assert r.status is doctor.DoctorStatus.NOT_IN_GAME and r.exit_code() == 1


def test_api_contract_mismatch_from_inconsistent_realm():
    r = run([("a", True)], {"a": [reply(1, json.dumps(INCONSISTENT))]})
    assert r.status is doctor.DoctorStatus.API_CONTRACT_MISMATCH


def test_api_contract_mismatch_from_bad_probe_shape():
    r = run([("a", True)], {"a": [reply(1, "garbage")]})
    assert r.status is doctor.DoctorStatus.API_CONTRACT_MISMATCH


def test_target_probe_failed():
    r = run([("a", True)], {"a": ConnectionRefusedError()})
    assert r.status is doctor.DoctorStatus.TARGET_PROBE_FAILED


def test_no_game_target_when_list_empty():
    r = run([], {})
    assert r.status is doctor.DoctorStatus.NO_GAME_TARGET


def test_no_game_target_when_only_non_game_and_invalid_url():
    r = run([("a", True), ("b", False)], {"a": [reply(1, json.dumps(NON_GAME))]})
    assert r.status is doctor.DoctorStatus.NO_GAME_TARGET


def test_menu_beats_transport_error():
    r = run([("a", True), ("b", True)], {"a": ConnectionRefusedError(), "b": [reply(1, json.dumps(MENU))]})
    assert r.status is doctor.DoctorStatus.NOT_IN_GAME


def test_target_id_override_passes_through():
    r = run([("a", True), ("b", True)], {"a": [reply(1, json.dumps(GAME))], "b": [reply(1, json.dumps(GAME))]}, target_id="a")
    assert r.status is doctor.DoctorStatus.IN_GAME and r.selected["id"] == "a"


def test_to_json_is_valid_and_complete():
    r = run([("a", True)], {"a": [reply(1, json.dumps(GAME))]})
    d = json.loads(r.to_json())
    assert set(d) == {"schemaVersion", "status", "ok", "summary", "discovery", "targets", "selected",
                      "context", "gameProcess", "adapterVersion", "durationMs"}
    assert d["schemaVersion"] == 1 and d["status"] == "IN_GAME"
    assert d["targets"][0]["kind"] == "game"
    assert "ws://" not in r.to_json()


def test_detect_game_process_never_raises(monkeypatch):
    monkeypatch.setattr(doctor, "_PROC", "/nonexistent")
    assert doctor.detect_game_process() in {"detected", "not-detected", "unknown"}


def test_detect_game_process_detects_civ7(tmp_path, monkeypatch):
    (tmp_path / "123").mkdir()
    (tmp_path / "123" / "comm").write_text("Civ7_linux_Vulk\n")
    monkeypatch.setattr(doctor, "_PROC", str(tmp_path))
    assert doctor.detect_game_process() == "detected"


def test_failure_reports_never_contain_ws_urls():
    r = run([("a", True), ("b", True)], {"a": ConnectionRefusedError(), "b": ConnectionRefusedError()})
    assert r.status is doctor.DoctorStatus.TARGET_PROBE_FAILED
    assert "ws://" not in r.to_json()


def test_contract_issue_beats_menu():
    r = run([("a", True), ("b", True)], {"a": [reply(1, json.dumps(MENU))], "b": [reply(1, json.dumps(INCONSISTENT))]})
    assert r.status is doctor.DoctorStatus.API_CONTRACT_MISMATCH


def test_null_context_never_yields_in_game():
    nulls = {**GAME, "turn": None, "localPlayerId": None, "localObserverId": None}
    r = run([("a", True)], {"a": [reply(1, json.dumps(nulls))]})
    assert r.status is doctor.DoctorStatus.API_CONTRACT_MISMATCH
    assert r.ok is False and r.exit_code() == 1 and r.context is None
