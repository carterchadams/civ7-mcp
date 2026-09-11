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
