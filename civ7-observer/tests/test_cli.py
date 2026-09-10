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


@pytest.mark.parametrize("cmd", ["probe", "snapshot", "serve"])
def test_stub_commands_exit_2(cmd, capsys):
    code = cli.main([cmd])
    _, err = capsys.readouterr()
    assert code == 2
    assert "not implemented" in err.lower()


def test_module_entrypoint_runs_from_outside_repo(tmp_path):
    proc = subprocess.run([sys.executable, "-m", "civ7_observer", "doctor", "--json", "--port", "1", "--timeout", "0.5"],
                          cwd=tmp_path, capture_output=True, text=True)
    assert proc.returncode == 1
    doc = json.loads(proc.stdout)
    assert doc["status"] == "DEBUGGER_UNAVAILABLE"
