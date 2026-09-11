"""Strict, versioned validation of the observe payload and the model-facing Observation."""

from __future__ import annotations

import math
from typing import Any

SCHEMA_VERSION = 1
PAYLOAD_VERSION = 1
MAX_STRING = 200
MAX_SETTLEMENTS = 500
MAX_UNITS = 2000
MAX_WARNINGS = 50
MAX_SAFE_INT = 2**53 - 1
MODES = ("singleplayer", "local-hotseat")
LOCATION_STATUSES = ("tile", "off-map", "invalid")
PRODUCTION_KINDS = ("unit", "constructible", "project")
MAX_NODES = 500
MAX_TREES = 20
NODE_STATES = {0: "NODE_STATE_INVALID", 1: "NODE_STATE_CLOSED", 2: "NODE_STATE_OPEN", 3: "NODE_STATE_IN_PROGRESS", 4: "NODE_STATE_UNLOCKED", 5: "NODE_STATE_FULLY_UNLOCKED"}
COMPLETED_STATES = (4, 5)
OMITTED_FEATURES = [
    "resources", "foreign-units", "foreign-settlements", "diplomacy", "notifications",
    "yields", "map-tiles", "hidden-tiles", "game-seed", "other-players",
]
DELETE = object()


class InvalidObservation(Exception):
    code = "INVALID_OBSERVATION"


class PayloadRefused(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _fail(path: str, why: str) -> None:
    raise InvalidObservation(f"{path}: {why}")


def _int(v: Any, path: str, *, minimum: int | None = None) -> int:
    if isinstance(v, bool) or not isinstance(v, int):
        if isinstance(v, float) and v.is_integer() and math.isfinite(v):
            v = int(v)
        else:
            _fail(path, "expected integer")
    if abs(v) > MAX_SAFE_INT:
        _fail(path, "integer outside the safe range")
    if minimum is not None and v < minimum:
        _fail(path, f"must be >= {minimum}")
    return v


def _bool(v: Any, path: str) -> bool:
    if not isinstance(v, bool):
        _fail(path, "expected boolean")
    return v


def _str(v: Any, path: str) -> str:
    if not isinstance(v, str):
        _fail(path, "expected string")
    if len(v) > MAX_STRING:
        _fail(path, f"string longer than {MAX_STRING}")
    return v


def _opt(fn, v: Any, path: str, **kw):
    return None if v is None else fn(v, path, **kw)


def _obj(v: Any, path: str, keys: tuple[str, ...]) -> dict[str, Any]:
    if not isinstance(v, dict):
        _fail(path, "expected object")
    got = set(v)
    if got != set(keys):
        _fail(path, f"keys mismatch (missing={sorted(set(keys) - got)}, extra={sorted(got - set(keys))})")
    return v


def _component_id(v: Any, path: str) -> dict[str, int]:
    o = _obj(v, path, ("owner", "id", "type"))
    return {"owner": _int(o["owner"], path + ".owner"), "id": _int(o["id"], path + ".id"), "type": _int(o["type"], path + ".type")}


def _location(v: Any, path: str) -> dict[str, int]:
    o = _obj(v, path, ("x", "y"))
    return {"x": _int(o["x"], path + ".x", minimum=0), "y": _int(o["y"], path + ".y", minimum=0)}


def _context(v: Any, path: str, bound: int | None) -> dict[str, Any]:
    o = _obj(v, path, ("turn", "age", "ageType", "playerId", "localPlayerId", "localObserverId", "mode", "isTurnActive"))
    ctx = {
        "turn": _int(o["turn"], path + ".turn", minimum=0),
        "age": _opt(_int, o["age"], path + ".age"),
        "ageType": _opt(_str, o["ageType"], path + ".ageType"),
        "playerId": _int(o["playerId"], path + ".playerId", minimum=0),
        "localPlayerId": _int(o["localPlayerId"], path + ".localPlayerId", minimum=0),
        "localObserverId": _int(o["localObserverId"], path + ".localObserverId", minimum=0),
        "mode": _str(o["mode"], path + ".mode"),
        "isTurnActive": _bool(o["isTurnActive"], path + ".isTurnActive"),
    }
    if ctx["mode"] not in MODES:
        _fail(path + ".mode", f"must be one of {MODES}")
    if ctx["playerId"] != ctx["localPlayerId"] or ctx["playerId"] != ctx["localObserverId"]:
        _fail(path, "playerId must equal localPlayerId and localObserverId")
    if bound is not None and ctx["playerId"] != bound:
        _fail(path + ".playerId", f"expected bound player {bound}")
    if ctx["isTurnActive"] is not True:
        _fail(path + ".isTurnActive", "must be true")
    return ctx


def _production(v: Any, path: str) -> dict[str, Any]:
    if not isinstance(v, dict) or "status" not in v:
        _fail(path, "expected production status object")
    if v["status"] == "unsupported":
        o = _obj(v, path, ("status", "reason"))
        return {"status": "unsupported", "reason": _str(o["reason"], path + ".reason")}
    if v["status"] != "supported":
        _fail(path + ".status", "must be 'supported' or 'unsupported'")
    o = _obj(v, path, ("status", "isEmpty", "currentType", "currentTypeKey", "currentKind"))
    p = {
        "status": "supported",
        "isEmpty": _bool(o["isEmpty"], path + ".isEmpty"),
        "currentType": _opt(_int, o["currentType"], path + ".currentType"),
        "currentTypeKey": _opt(_str, o["currentTypeKey"], path + ".currentTypeKey"),
        "currentKind": _opt(_str, o["currentKind"], path + ".currentKind"),
    }
    if p["currentKind"] is not None and p["currentKind"] not in PRODUCTION_KINDS:
        _fail(path + ".currentKind", f"must be one of {PRODUCTION_KINDS}")
    if p["isEmpty"] and p["currentType"] is not None:
        _fail(path, "empty queue cannot carry a current type")
    return p


def _settlement(v: Any, path: str, bound: int) -> dict[str, Any]:
    o = _obj(v, path, ("id", "owner", "nameKey", "displayName", "location", "isTown", "isCapital", "population", "production"))
    pop = _obj(o["population"], path + ".population", ("total", "rural", "urban"))
    rec = {
        "id": _component_id(o["id"], path + ".id"),
        "owner": _int(o["owner"], path + ".owner", minimum=0),
        "nameKey": _opt(_str, o["nameKey"], path + ".nameKey"),
        "displayName": _opt(_str, o["displayName"], path + ".displayName"),
        "location": _opt(_location, o["location"], path + ".location"),
        "isTown": _bool(o["isTown"], path + ".isTown"),
        "isCapital": _bool(o["isCapital"], path + ".isCapital"),
        "population": {k: _int(pop[k], f"{path}.population.{k}", minimum=0) for k in ("total", "rural", "urban")},
        "production": _production(o["production"], path + ".production"),
    }
    if rec["owner"] != bound or rec["id"]["owner"] != bound:
        _fail(path, "settlement not owned by the bound player")
    return rec


def _unit(v: Any, path: str, bound: int) -> dict[str, Any]:
    o = _obj(v, path, ("id", "owner", "type", "typeKey", "displayName", "locationStatus", "location", "isEmbarked", "movement", "health", "isCommander", "armyId"))
    rec = {
        "id": _component_id(o["id"], path + ".id"),
        "owner": _int(o["owner"], path + ".owner", minimum=0),
        "type": _int(o["type"], path + ".type"),
        "typeKey": _opt(_str, o["typeKey"], path + ".typeKey"),
        "displayName": _opt(_str, o["displayName"], path + ".displayName"),
        "locationStatus": _str(o["locationStatus"], path + ".locationStatus"),
        "location": _opt(_location, o["location"], path + ".location"),
        "isEmbarked": _bool(o["isEmbarked"], path + ".isEmbarked"),
        "movement": None,
        "health": None,
        "isCommander": _bool(o["isCommander"], path + ".isCommander"),
        "armyId": _opt(_component_id, o["armyId"], path + ".armyId"),
    }
    if rec["locationStatus"] not in LOCATION_STATUSES:
        _fail(path + ".locationStatus", f"must be one of {LOCATION_STATUSES}")
    if (rec["locationStatus"] == "tile") != (rec["location"] is not None):
        _fail(path, "location must be present exactly when locationStatus is 'tile'")
    if o["movement"] is not None:
        m = _obj(o["movement"], path + ".movement", ("remaining", "max"))
        rec["movement"] = {"remaining": _int(m["remaining"], path + ".movement.remaining", minimum=0), "max": _int(m["max"], path + ".movement.max", minimum=0)}
    if o["health"] is not None:
        h = _obj(o["health"], path + ".health", ("damage", "maxDamage"))
        rec["health"] = {"damage": _int(h["damage"], path + ".health.damage", minimum=0), "maxDamage": _int(h["maxDamage"], path + ".health.maxDamage", minimum=0)}
    if rec["owner"] != bound or rec["id"]["owner"] != bound:
        _fail(path, "unit not owned by the bound player")
    return rec


def _warning(v: Any, path: str) -> dict[str, Any]:
    if not isinstance(v, dict) or "code" not in v or "message" not in v:
        _fail(path, "warning needs code and message")
    allowed = {"code", "message", "count"}
    if set(v) - allowed:
        _fail(path, "unexpected warning keys")
    w = {"code": _str(v["code"], path + ".code"), "message": _str(v["message"], path + ".message")}
    if "count" in v:
        w["count"] = _int(v["count"], path + ".count", minimum=0)
    return w


def _tree_ref(v: Any, path: str) -> dict[str, Any]:
    o = _obj(v, path, ("type", "typeKey"))
    return {"type": _int(o["type"], path + ".type"), "typeKey": _opt(_str, o["typeKey"], path + ".typeKey")}


def _node_state(state: Any, name: Any, path: str) -> tuple[int, str]:
    st = _int(state, path + ".state")
    if st not in NODE_STATES:
        _fail(path + ".state", f"unknown node state {st}")
    nm = _str(name, path + ".stateName")
    if nm != NODE_STATES[st]:
        _fail(path + ".stateName", f"does not match state {st}")
    return st, nm


def _node_common(o: dict[str, Any], path: str) -> dict[str, Any]:
    rec = {
        "type": _int(o["type"], path + ".type"),
        "typeKey": _opt(_str, o["typeKey"], path + ".typeKey"),
        "displayName": _opt(_str, o["displayName"], path + ".displayName"),
        "tree": _opt(_str, o["tree"], path + ".tree"),
        "depthUnlocked": _int(o["depthUnlocked"], path + ".depthUnlocked", minimum=0),
        "maxDepth": _int(o["maxDepth"], path + ".maxDepth", minimum=0),
    }
    rec["state"], rec["stateName"] = _node_state(o["state"], o["stateName"], path)
    if rec["depthUnlocked"] > rec["maxDepth"]:
        _fail(path, "depthUnlocked exceeds maxDepth")
    return rec


def _current_node(v: Any, path: str) -> dict[str, Any]:
    o = _obj(v, path, ("type", "typeKey", "displayName", "tree", "state", "stateName", "progress", "cost", "turnsLeft", "depthUnlocked", "maxDepth"))
    rec = _node_common(o, path)
    rec["progress"] = _int(o["progress"], path + ".progress", minimum=0)
    rec["cost"] = _int(o["cost"], path + ".cost", minimum=0)
    rec["turnsLeft"] = _opt(_int, o["turnsLeft"], path + ".turnsLeft", minimum=0)
    return rec


def _completed_node(v: Any, path: str) -> dict[str, Any]:
    o = _obj(v, path, ("type", "typeKey", "displayName", "tree", "state", "stateName", "depthUnlocked", "maxDepth"))
    rec = _node_common(o, path)
    if rec["state"] not in COMPLETED_STATES:
        _fail(path + ".state", "completed nodes must be UNLOCKED or FULLY_UNLOCKED")
    return rec


def _progression(v: Any, path: str, *, civics: bool) -> dict[str, Any]:
    keys = ("status", "current", "queuedTarget", "completed") + (("trees",) if civics else ("tree",))
    o = _obj(v, path, keys)
    if o["status"] != "supported":
        _fail(path + ".status", "core progression must be supported")
    if not isinstance(o["completed"], list) or len(o["completed"]) > MAX_NODES:
        _fail(path + ".completed", f"expected a list of at most {MAX_NODES}")
    out = {
        "status": "supported",
        "current": _opt(_current_node, o["current"], path + ".current"),
        "queuedTarget": _opt(_tree_ref, o["queuedTarget"], path + ".queuedTarget"),
        "completed": [_completed_node(n, f"{path}.completed[{i}]") for i, n in enumerate(o["completed"])],
    }
    if civics:
        t = _obj(o["trees"], path + ".trees", ("active", "available"))
        if not isinstance(t["available"], list) or not t["available"] or len(t["available"]) > MAX_TREES:
            _fail(path + ".trees.available", f"expected 1..{MAX_TREES} trees")
        out["trees"] = {"active": _opt(_tree_ref, t["active"], path + ".trees.active"),
                        "available": [_tree_ref(x, f"{path}.trees.available[{i}]") for i, x in enumerate(t["available"])]}
    else:
        out["tree"] = _opt(_tree_ref, o["tree"], path + ".tree")
    return out


def validate_payload(data: Any, *, bound_player_id: int | None = None) -> dict[str, Any]:
    """Validate the raw observe.js result. Raises PayloadRefused for typed refusals."""
    if not isinstance(data, dict):
        _fail("payload", "expected object")
    if data.get("payloadVersion") != PAYLOAD_VERSION:
        _fail("payload.payloadVersion", f"expected {PAYLOAD_VERSION}")
    if data.get("refused") is not None:
        r = _obj(data["refused"], "payload.refused", ("code", "message"))
        raise PayloadRefused(_str(r["code"], "payload.refused.code"), _str(r["message"], "payload.refused.message"))
    o = _obj(data, "payload", ("payloadVersion", "refused", "context", "settlements", "units", "technology", "civics", "warnings"))
    ctx = _context(o["context"], "payload.context", bound_player_id)
    bound = ctx["playerId"]
    for name, limit in (("settlements", MAX_SETTLEMENTS), ("units", MAX_UNITS), ("warnings", MAX_WARNINGS)):
        if not isinstance(o[name], list):
            _fail(f"payload.{name}", "expected list")
        if len(o[name]) > limit:
            _fail(f"payload.{name}", f"more than {limit} entries")
    settlements = [_settlement(s, f"payload.settlements[{i}]", bound) for i, s in enumerate(o["settlements"])]
    units = [_unit(u, f"payload.units[{i}]", bound) for i, u in enumerate(o["units"])]
    warnings = [_warning(w, f"payload.warnings[{i}]") for i, w in enumerate(o["warnings"])]
    technology = _progression(o["technology"], "payload.technology", civics=False)
    civics = _progression(o["civics"], "payload.civics", civics=True)
    return {"context": ctx, "settlements": settlements, "units": units, "technology": technology, "civics": civics, "warnings": warnings}


def build_observation(validated: dict[str, Any], *, session_id: str, observation_id: str, captured_at: str) -> dict[str, Any]:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "sessionId": session_id,
        "observationId": observation_id,
        "capturedAt": captured_at,
        "context": validated["context"],
        "settlements": validated["settlements"],
        "units": validated["units"],
        "technology": validated["technology"],
        "civics": validated["civics"],
        "map": {"status": "unsupported", "reason": "not implemented until Change 5"},
        "omittedFeatures": list(OMITTED_FEATURES),
        "warnings": validated["warnings"],
    }
