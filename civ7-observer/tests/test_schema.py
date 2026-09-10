import copy
import json
import math

import pytest

from civ7_observer import schema

GOOD = {
    "payloadVersion": 1,
    "refused": None,
    "context": {"turn": 15, "age": 4242, "ageType": "AGE_ANTIQUITY", "playerId": 1, "localPlayerId": 1, "localObserverId": 1, "mode": "singleplayer", "isTurnActive": True},
    "settlements": [
        {"id": {"owner": 1, "id": 65536, "type": 1}, "owner": 1, "nameKey": "LOC_MADRID", "displayName": "Madrid", "location": {"x": 63, "y": 15},
         "isTown": False, "isCapital": True, "population": {"total": 6, "rural": 4, "urban": 2},
         "production": {"status": "supported", "isEmpty": False, "currentType": -1563767818, "currentTypeKey": "UNIT_HOPLITE", "currentKind": "unit"}},
    ],
    "units": [
        {"id": {"owner": 1, "id": 131072, "type": 26}, "owner": 1, "type": 99, "typeKey": "UNIT_SCOUT", "displayName": "Scout",
         "locationStatus": "tile", "location": {"x": 59, "y": 35}, "isEmbarked": False, "movement": {"remaining": 2, "max": 2},
         "health": {"damage": 32, "maxDamage": 100}, "isCommander": False, "armyId": None},
    ],
    "warnings": [],
}


def test_valid_payload_passes():
    obs = schema.validate_payload(GOOD)
    assert obs["settlements"][0]["displayName"] == "Madrid"


def mutate(path, value):
    d = copy.deepcopy(GOOD)
    cur = d
    for k in path[:-1]:
        cur = cur[k]
    if value is schema.DELETE:
        del cur[path[-1]]
    else:
        cur[path[-1]] = value
    return d


@pytest.mark.parametrize("path, value", [
    (["extra"], 1),
    (["settlements", 0, "extra"], 1),
    (["units", 0, "extra"], 1),
    (["context", "turn"], schema.DELETE),
    (["context", "turn"], -1),
    (["context", "turn"], 1.5),
    (["context", "turn"], True),
    (["context", "mode"], "network"),
    (["settlements", 0, "id"], 65536),
    (["settlements", 0, "id"], {"owner": 1, "id": 65536}),
    (["settlements", 0, "id", "id"], 2 ** 53),
    (["settlements", 0, "location"], {"x": 0, "y": -1}),
    (["settlements", 0, "displayName"], "x" * 300),
    (["settlements", 0, "production"], {"status": "supported"}),
    (["settlements", 0, "production", "status"], "maybe"),
    (["units", 0, "locationStatus"], "somewhere"),
    (["units", 0, "location"], None),
    (["units", 0, "health", "damage"], float("nan")),
    (["units", 0, "movement", "remaining"], -1),
    (["units", 0, "armyId"], {"owner": 1}),
    (["warnings"], [{"code": "X"}]),
    (["payloadVersion"], 2),
])
def test_invalid_payloads_are_rejected(path, value):
    with pytest.raises(schema.InvalidObservation):
        schema.validate_payload(mutate(path, value))


def test_off_map_and_invalid_units_require_null_location():
    d = mutate(["units", 0, "locationStatus"], "off-map")
    with pytest.raises(schema.InvalidObservation):
        schema.validate_payload(d)
    d["units"][0]["location"] = None
    schema.validate_payload(d)


def test_movement_may_be_null():
    schema.validate_payload(mutate(["units", 0, "movement"], None))


def test_unsupported_production_is_allowed():
    schema.validate_payload(mutate(["settlements", 0, "production"], {"status": "unsupported", "reason": "BuildQueue missing"}))


def test_collection_limits():
    d = copy.deepcopy(GOOD)
    d["units"] = [copy.deepcopy(GOOD["units"][0]) for _ in range(schema.MAX_UNITS + 1)]
    with pytest.raises(schema.InvalidObservation):
        schema.validate_payload(d)


def test_refusal_is_typed():
    d = {"payloadVersion": 1, "refused": {"code": "WRONG_PLAYER", "message": "no"}, "context": None, "settlements": None, "units": None, "warnings": []}
    with pytest.raises(schema.PayloadRefused) as ei:
        schema.validate_payload(d)
    assert ei.value.code == "WRONG_PLAYER"


def test_build_observation_wraps_with_ids_and_markers():
    obs = schema.build_observation(schema.validate_payload(GOOD), session_id="s", observation_id="o", captured_at="2026-09-10T00:00:00Z")
    assert obs["schemaVersion"] == 1
    assert obs["sessionId"] == "s" and obs["observationId"] == "o"
    assert obs["technology"] == {"status": "unsupported", "reason": "not implemented until Change 4"}
    assert obs["civics"]["status"] == "unsupported"
    assert obs["map"]["status"] == "unsupported"
    assert "resources" in obs["omittedFeatures"] and "foreign-units" in obs["omittedFeatures"]
    json.dumps(obs)
