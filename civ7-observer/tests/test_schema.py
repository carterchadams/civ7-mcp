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
    "technology": {
        "status": "supported",
        "tree": {"type": 500, "typeKey": "TREE_TECHS_AQ"},
        "current": {"type": 701, "typeKey": "NODE_TECH_AQ_POTTERY", "displayName": "Pottery", "tree": "TREE_TECHS_AQ", "state": 3, "stateName": "NODE_STATE_IN_PROGRESS", "progress": 45, "cost": 60, "turnsLeft": 1, "depthUnlocked": 0, "maxDepth": 1},
        "queuedTarget": {"type": 702, "typeKey": "NODE_TECH_AQ_WRITING"},
        "completed": [{"type": 700, "typeKey": "NODE_TECH_AQ_AGRICULTURE", "displayName": "Agriculture", "tree": "TREE_TECHS_AQ", "state": 5, "stateName": "NODE_STATE_FULLY_UNLOCKED", "depthUnlocked": 1, "maxDepth": 1}],
    },
    "civics": {
        "status": "supported",
        "trees": {"active": {"type": 600, "typeKey": "TREE_CIVICS_AQ_MAIN"}, "available": [{"type": 600, "typeKey": "TREE_CIVICS_AQ_MAIN"}, {"type": 601, "typeKey": "TREE_CIVICS_AQ_GREECE"}]},
        "current": {"type": 801, "typeKey": "NODE_CIVIC_AQ_MAIN_DISCIPLINE", "displayName": "Discipline", "tree": "TREE_CIVICS_AQ_MAIN", "state": 3, "stateName": "NODE_STATE_IN_PROGRESS", "progress": 72, "cost": 125, "turnsLeft": 1, "depthUnlocked": 0, "maxDepth": 2},
        "queuedTarget": None,
        "completed": [],
    },
    "map": {
        "status": "supported", "width": 6, "height": 4, "coverage": "currently-visible-only",
        "counts": {"visible": 2, "revealed": 4, "hidden": 18},
        "tiles": [
            {"x": 2, "y": 1, "index": 8, "terrain": 5, "terrainKey": "TERRAIN_HILL", "biome": 0, "biomeKey": "BIOME_PLAINS", "feature": None, "featureKey": None, "elevation": 102, "isRiver": False, "riverType": None},
            {"x": 3, "y": 1, "index": 9, "terrain": 1, "terrainKey": "TERRAIN_FLAT", "biome": 0, "biomeKey": "BIOME_PLAINS", "feature": 7, "featureKey": "FEATURE_FOREST", "elevation": 103, "isRiver": True, "riverType": 3},
        ],
    },
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
    (["technology"], schema.DELETE),
    (["technology", "status"], "unsupported"),
    (["technology", "current", "state"], 9),
    (["technology", "current", "stateName"], "NODE_STATE_OPEN"),
    (["technology", "current", "progress"], -1),
    (["technology", "completed", 0, "state"], 2),
    (["technology", "completed", 0, "extra"], 1),
    (["technology", "queuedTarget"], {"type": 702}),
    (["civics", "trees", "active"], 600),
    (["civics", "trees", "available"], []),
    (["civics", "current", "depthUnlocked"], 3),
    (["map"], schema.DELETE),
    (["map", "status"], "unsupported"),
    (["map", "coverage"], "full"),
    (["map", "width"], 0),
    (["map", "counts", "visible"], 3),
    (["map", "counts", "hidden"], 17),
    (["map", "tiles", 0, "x"], 6),
    (["map", "tiles", 0, "y"], -1),
    (["map", "tiles", 0, "index"], 9),
    (["map", "tiles", 0, "resource"], 4),
    (["map", "tiles", 0, "terrain"], schema.DELETE),
    (["map", "tiles", 0, "elevation"], float("inf")),
    (["map", "tiles", 1], {"x": 2, "y": 1, "index": 8, "terrain": 5, "terrainKey": "TERRAIN_HILL", "biome": 0, "biomeKey": "BIOME_PLAINS", "feature": None, "featureKey": None, "elevation": 102, "isRiver": False, "riverType": None}),
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
    assert obs["technology"]["status"] == "supported" and obs["technology"]["current"]["typeKey"] == "NODE_TECH_AQ_POTTERY"
    assert obs["civics"]["status"] == "supported" and obs["civics"]["completed"] == []
    assert obs["map"]["coverage"] == "currently-visible-only" and len(obs["map"]["tiles"]) == 2
    assert "hidden-tiles" in obs["omittedFeatures"] and "resources" in obs["omittedFeatures"] and "map-tiles" not in obs["omittedFeatures"]
    assert "resources" in obs["omittedFeatures"] and "foreign-units" in obs["omittedFeatures"]
    json.dumps(obs)


def test_progression_current_may_be_null_and_active_tree_may_be_null():
    d = mutate(["technology", "current"], None)
    d["civics"]["trees"]["active"] = None
    schema.validate_payload(d)


def test_completed_allows_unlocked_with_mastery_remaining():
    d = mutate(["technology", "completed", 0], {"type": 703, "typeKey": "NODE_TECH_AQ_SAILING", "displayName": "Sailing", "tree": "TREE_TECHS_AQ", "state": 4, "stateName": "NODE_STATE_UNLOCKED", "depthUnlocked": 1, "maxDepth": 2})
    schema.validate_payload(d)


def test_map_tiles_may_be_empty_when_nothing_visible():
    d = copy.deepcopy(GOOD)
    d["map"]["tiles"] = []
    d["map"]["counts"] = {"visible": 0, "revealed": 0, "hidden": 24}
    schema.validate_payload(d)


def test_map_tile_count_limit():
    d = copy.deepcopy(GOOD)
    d["map"]["width"], d["map"]["height"] = 2, 1
    d["map"]["counts"] = {"visible": 2, "revealed": 0, "hidden": 0}
    d["map"]["tiles"][0].update({"x": 0, "y": 0, "index": 0})
    d["map"]["tiles"][1].update({"x": 1, "y": 0, "index": 1})
    schema.validate_payload(d)
    d["map"]["tiles"].append({**d["map"]["tiles"][1], "x": 1, "y": 0, "index": 1})
    d["map"]["counts"]["visible"] = 3
    with pytest.raises(schema.InvalidObservation):
        schema.validate_payload(d)
