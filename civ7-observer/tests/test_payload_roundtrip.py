"""Real observe.js output (via node) fed into the Python schema. Catches values JS already coerced."""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from civ7_observer import schema

HARNESS = Path(__file__).parent / "harness" / "observe_harness.mjs"
pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node not available")


def run_js(fixture: str, bound: int = 1, mode: str = "singleplayer") -> dict:
    proc = subprocess.run(["node", str(HARNESS), fixture, str(bound), mode], capture_output=True, text=True, check=True)
    return json.loads(proc.stdout)


def test_good_fixture_round_trips_through_schema():
    v = schema.validate_payload(run_js("good"), bound_player_id=1)
    assert v["settlements"][0]["isTown"] is True and v["settlements"][0]["isCapital"] is True
    assert v["units"][0]["isEmbarked"] is True and v["units"][0]["isCommander"] is True
    assert v["units"][0]["movement"] == {"remaining": 0, "max": 2}
    assert v["units"][0]["armyId"] == {"owner": 1, "id": 5, "type": 3}


@pytest.mark.parametrize("fixture, code", [("coerced_booleans", "API_CONTRACT_MISMATCH"), ("string_movement", "API_CONTRACT_MISMATCH"), ("not_in_game", "NOT_IN_GAME")])
def test_broken_fixtures_are_refused_before_python_sees_a_valid_document(fixture, code):
    with pytest.raises(schema.PayloadRefused) as ei:
        schema.validate_payload(run_js(fixture), bound_player_id=1)
    assert ei.value.code == code
