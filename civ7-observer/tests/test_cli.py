import json
import subprocess
import sys

import pytest

from civ7_observer import cli, doctor


def fake_result(status=doctor.DoctorStatus.IN_GAME):
    return doctor.DoctorResult(
        status=status, ok=status is doctor.DoctorStatus.IN_GAME, summary="fake",
        discovery={"url": "http://127.0.0.1:9444/json", "targetCount": 1, "error": None},
        targets=[], selected=None, context=None, game_process="unknown", adapter_version="0.0", duration_ms=1,
    )


def test_doctor_json_stdout_contains_only_one_json_document(monkeypatch, capsys):
    calls = {}

    def fake_run(**kw):
        calls.update(kw)
        return fake_result()

    monkeypatch.setattr(cli, "run_doctor", fake_run)
    code = cli.main(["doctor", "--json", "-v", "--port", "9555", "--timeout", "2.5"])
    out, err = capsys.readouterr()
    assert code == 0
    assert json.loads(out)["status"] == "IN_GAME"
    assert calls["port"] == 9555 and calls["timeout"] == 2.5 and calls["target_id"] is None


def test_doctor_human_output_and_exit_code(monkeypatch, capsys):
    monkeypatch.setattr(cli, "run_doctor", lambda **kw: fake_result(doctor.DoctorStatus.NOT_IN_GAME))
    code = cli.main(["doctor"])
    out, _ = capsys.readouterr()
    assert code == 1
    assert "NOT_IN_GAME" in out


def test_target_id_flag(monkeypatch, capsys):
    seen = {}
    monkeypatch.setattr(cli, "run_doctor", lambda **kw: seen.update(kw) or fake_result())
    cli.main(["doctor", "--target-id", "abc"])
    assert seen["target_id"] == "abc"




def test_module_entrypoint_runs_from_outside_repo(tmp_path):
    proc = subprocess.run([sys.executable, "-m", "civ7_observer", "doctor", "--json", "--port", "1", "--timeout", "0.5"],
                          cwd=tmp_path, capture_output=True, text=True)
    assert proc.returncode == 1
    doc = json.loads(proc.stdout)
    assert doc["status"] == "DEBUGGER_UNAVAILABLE"


def test_probe_command_prints_summary_and_returns_zero(monkeypatch, capsys, tmp_path):
    from civ7_observer import probe as probe_mod
    seen = {}

    def fake_run_probe(**kw):
        seen.update(kw)
        return probe_mod.ProbeResult(path=kw["out"], bound_player_id=1, turn=2, error_count=0, size_bytes=10)

    monkeypatch.setattr(cli, "run_probe", fake_run_probe)
    code = cli.main(["probe", "--out", str(tmp_path / "c.json"), "--player", "1", "--port", "9555"])
    out, _ = capsys.readouterr()
    assert code == 0 and seen["player"] == 1 and seen["port"] == 9555
    assert str(tmp_path / "c.json") in out


def test_probe_command_reports_typed_error(monkeypatch, capsys):
    from civ7_observer import service as service_mod

    def boom(**kw):
        raise service_mod.ObserverError("WRONG_PLAYER", "seat is 1")

    monkeypatch.setattr(cli, "run_probe", boom)
    code = cli.main(["probe", "--json"])
    out, err = capsys.readouterr()
    assert code == 1
    assert json.loads(out)["error"]["code"] == "WRONG_PLAYER"


def test_snapshot_command_wires_flags(monkeypatch, capsys, tmp_path):
    from civ7_observer import snapshot as snap_mod
    seen = {}

    def fake(**kw):
        seen.update(kw)
        return snap_mod.SnapshotResult(path=kw["out"], session_id="s", observation_id="o", turn=2, player_id=1, settlement_count=1, unit_count=1, size_bytes=5)

    monkeypatch.setattr(cli, "run_snapshot", fake)
    code = cli.main(["snapshot", "--player", "1", "--mode", "local-hotseat", "--out", str(tmp_path / "o.json"), "--json"])
    out, _ = capsys.readouterr()
    assert code == 0 and seen["player"] == 1 and seen["mode"] == "local-hotseat"
    assert json.loads(out)["observationId"] == "o"


def test_snapshot_command_rejects_unknown_mode(capsys):
    with pytest.raises(SystemExit):
        cli.main(["snapshot", "--mode", "network"])


def test_snapshot_json_reports_transport_failures_as_structured_errors(monkeypatch, capsys):
    from civ7_observer import cdp as cdp_mod

    def boom(**kw):
        raise cdp_mod.CdpConnectionClosed("gone")

    monkeypatch.setattr(cli, "run_snapshot", boom)
    code = cli.main(["snapshot", "--json"])
    out, _ = capsys.readouterr()
    assert code == 1
    assert json.loads(out)["error"]["code"] == "CDP_CONNECTION_CLOSED"


def test_probe_json_reports_transport_failures_as_structured_errors(monkeypatch, capsys):
    from civ7_observer import cdp as cdp_mod

    def boom(**kw):
        raise cdp_mod.DiscoveryUnavailable("gone")

    monkeypatch.setattr(cli, "run_probe", boom)
    code = cli.main(["probe", "--json"])
    out, _ = capsys.readouterr()
    assert code == 1
    assert json.loads(out)["error"]["code"] == "DEBUGGER_UNAVAILABLE"


def test_serve_requires_player_and_mode(capsys):
    with pytest.raises(SystemExit):
        cli.main(["serve"])
    with pytest.raises(SystemExit):
        cli.main(["serve", "--player", "1"])
    with pytest.raises(SystemExit):
        cli.main(["serve", "--mode", "singleplayer"])


def test_act_list_prints_offers(monkeypatch, capsys, tmp_path):
    from civ7_observer import actions as actions_mod

    class FakeReg:
        def __init__(self, journal_path):
            self.journal_path = journal_path

        def list_offers(self, gs, *, player, mode):
            return {"context": {"turn": 3, "playerId": player, "curtainDisplayed": False}, "offers": [{"actionId": "a" * 24, "kind": "research", "typeKey": "NODE_TECH_AQ_POTTERY", "canStart": True}], "reconciliationRequired": []}

    class FakeGS:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            pass

    monkeypatch.setattr(cli, "ActionRegistry", FakeReg)
    monkeypatch.setattr(cli, "open_game_session", lambda **kw: FakeGS())
    code = cli.main(["act", "list", "--player", "1", "--mode", "local-hotseat", "--journal", str(tmp_path / "j.jsonl"), "--json"])
    out, _ = capsys.readouterr()
    assert code == 0
    doc = json.loads(out)
    assert doc["offers"][0]["typeKey"] == "NODE_TECH_AQ_POTTERY"


def test_act_perform_requires_ids_and_reports_errors(monkeypatch, capsys, tmp_path):
    from civ7_observer import service as service_mod

    class FakeReg:
        def __init__(self, journal_path):
            pass

        def perform(self, gs, *, action_id, request_id, player, mode):
            raise service_mod.ObserverError("ACTION_EXPIRED", "stale")

    class FakeGS:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            pass

    monkeypatch.setattr(cli, "ActionRegistry", FakeReg)
    monkeypatch.setattr(cli, "open_game_session", lambda **kw: FakeGS())
    with pytest.raises(SystemExit):
        cli.main(["act", "perform", "--player", "1", "--mode", "local-hotseat"])
    code = cli.main(["act", "perform", "--player", "1", "--mode", "local-hotseat", "--action-id", "a" * 24, "--request-id", "r1", "--json"])
    out, _ = capsys.readouterr()
    assert code == 1 and json.loads(out)["error"]["code"] == "ACTION_EXPIRED"


# ---- play and friction: the agent runner's command surface


def _turn_result(**kw):
    from civ7_observer.runner import TurnResult
    base = {"status": "turn_ended", "report": "Chose Pottery, then ended.",
            "actions": [{"kind": "SET_TECH_TREE_NODE", "status": "confirmed", "requestId": "r1"}],
            "friction": [], "tool_calls": 3, "plan_revision": 2}
    return TurnResult(**{**base, **kw})


def test_play_runs_one_turn_for_the_bound_seat_and_reports_it(monkeypatch, capsys, tmp_path):
    seen = {}

    class FakeRunner:
        def __init__(self, **kw):
            seen.update(kw)

        def play_turn(self):
            return _turn_result()

    monkeypatch.setenv("ANTHROPIC_API_KEY", "k")
    monkeypatch.setattr(cli, "Runner", FakeRunner)
    code = cli.main(["play", "--player", "1", "--mode", "local-hotseat", "--workspace", str(tmp_path),
                     "--model", "test-model", "--json"])
    out, _ = capsys.readouterr()
    payload = json.loads(out)
    assert code == 0
    assert payload["status"] == "turn_ended" and payload["actions"] == ["SET_TECH_TREE_NODE"]
    assert seen["player"] == 1 and seen["mode"] == "local-hotseat"
    assert seen["provider"].model == "test-model"


def test_play_exits_nonzero_when_the_turn_did_not_end(monkeypatch, capsys, tmp_path):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k")
    monkeypatch.setattr(cli, "Runner", lambda **kw: type("R", (), {
        "play_turn": lambda self: _turn_result(status="paused", pause={"reason": "UNSUPPORTED_DECISION"})})())
    code = cli.main(["play", "--player", "1", "--mode", "local-hotseat", "--workspace", str(tmp_path), "--json"])
    out, _ = capsys.readouterr()
    assert code == 1
    assert json.loads(out)["pause"]["reason"] == "UNSUPPORTED_DECISION"


def test_play_without_an_api_key_fails_before_touching_the_game(monkeypatch, capsys, tmp_path):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setattr(cli, "Runner", lambda **kw: pytest.fail("the game must not be touched"))
    code = cli.main(["play", "--player", "1", "--mode", "local-hotseat", "--workspace", str(tmp_path), "--json"])
    out, _ = capsys.readouterr()
    assert code == 2 and "API key" in json.loads(out)["error"]["message"]


def test_friction_lists_the_backlog_a_seat_reported(capsys, tmp_path):
    from civ7_observer.workspace import Workspace
    ws = Workspace(root=tmp_path, seat=2)
    ws.record_friction({"match": "M", "generation": 1, "turn": 5, "age": 1},
                       kind="missing_action", goal="attack the scout", needed="an attack action")
    code = cli.main(["friction", "--player", "2", "--workspace", str(tmp_path), "--json"])
    out, _ = capsys.readouterr()
    payload = json.loads(out)
    assert code == 0
    assert payload["count"] == 1 and payload["reports"][0]["needed"] == "an attack action"
