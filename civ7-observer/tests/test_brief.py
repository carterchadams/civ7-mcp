"""The compact turn brief: what needs deciding now, with bounded options and honest gaps."""
import json

import pytest

from civ7_observer import actions, brief, service
from test_actions import CTX, OFFERS, ctx_reply, open_session
from test_targets import GAME, Factory, reply, target


def offers_with(entries, *, end_can_start=True, blocking=None):
    end = {"kind": "END_TURN", "arg": 0, "pre": 0, "canStart": end_can_start, "blockingType": blocking, "alreadySent": False}
    return {"payloadVersion": 1, "refused": None, "context": CTX, "offers": entries + [end]}


RESEARCH = [
    {"kind": "SET_TECH_TREE_NODE", "arg": 701, "pre": -1, "typeKey": "NODE_TECH_AQ_POTTERY", "displayName": "Pottery", "tree": "TREE_TECHS_AQ", "cost": 60, "turns": 4, "canStart": True},
    {"kind": "SET_TECH_TREE_NODE", "arg": 702, "pre": -1, "typeKey": "NODE_TECH_AQ_WRITING", "displayName": "Writing", "tree": "TREE_TECHS_AQ", "cost": 100, "turns": 7, "canStart": True},
]
UNITS = [
    {"kind": "SKIP_UNIT", "arg": 5, "pre": 2, "unitId": 5, "from": {"x": 10, "y": 10}, "unitTypeKey": "UNIT_SCOUT", "movesRemaining": 2, "canStart": True},
    {"kind": "MOVE_UNIT", "arg": 5, "arg2": 11, "arg3": 10, "pre": 1010, "unitId": 5, "from": {"x": 10, "y": 10}, "x": 11, "y": 10, "direction": 1, "unitTypeKey": "UNIT_SCOUT", "terrainKey": "TERRAIN_FLAT", "pathTurns": 1, "movesRemaining": 2, "canStart": True},
]


def build(tmp_path, payload, **kw):
    reg = actions.ActionRegistry(journal_path=tmp_path / "journal.jsonl")
    gs, f = open_session({"a": [ctx_reply(1), ctx_reply(1), reply(2, json.dumps(payload)), ctx_reply(3)]})
    with gs:
        return brief.build_brief(gs, reg, player=1, mode="singleplayer", **kw), reg, f


def test_brief_reports_context_attachment_and_turn_readiness(tmp_path):
    b, _, _ = build(tmp_path, offers_with(RESEARCH))
    assert b["context"]["turn"] == 12 and b["context"]["seat"] == 1 and b["context"]["mode"] == "singleplayer"
    assert b["attachment"]["match"] == "ABCDEF0123456789" and b["attachment"]["generation"] >= 1
    assert b["endTurn"] == {"canStart": True, "blocking": None, "supported": True, "actionId": b["endTurn"]["actionId"]}
    assert b["reconciliationRequired"] == []


def test_brief_groups_offers_into_decisions_with_bounded_options(tmp_path):
    b, _, _ = build(tmp_path, offers_with(RESEARCH + UNITS), max_options=1)
    kinds = {d["kind"]: d for d in b["decisions"]}
    assert set(kinds) == {"research", "unit", "end_turn"}
    research = kinds["research"]
    assert research["optionCount"] == 2 and len(research["options"]) == 1 and research["omitted"] == 1
    assert research["options"][0]["displayName"] in ("Pottery", "Writing")
    assert all("actionId" in o for d in b["decisions"] for o in d["options"])
    unit = kinds["unit"]
    assert unit["entities"] == [{"unitId": 5, "typeKey": "UNIT_SCOUT", "at": {"x": 10, "y": 10}, "movesRemaining": 2}]
    assert unit["entityCount"] == 1 and unit["entitiesOmitted"] == 0


def test_brief_marks_the_required_decision_from_the_native_blocker(tmp_path):
    b, _, _ = build(tmp_path, offers_with(RESEARCH, end_can_start=False, blocking="RESEARCH"))
    assert b["endTurn"]["canStart"] is False and b["endTurn"]["blocking"] == "RESEARCH"
    required = [d for d in b["decisions"] if d["required"]]
    assert [d["kind"] for d in required] == ["research"]
    assert b["pause"] is None


def test_unsupported_blocker_becomes_a_named_pause_with_no_invented_options(tmp_path):
    b, _, _ = build(tmp_path, offers_with(RESEARCH, end_can_start=False, blocking="TRADITIONS"))
    assert b["pause"] == {"reason": "UNSUPPORTED_DECISION", "blocking": "TRADITIONS",
                          "message": "the game requires a TRADITIONS decision, which this catalog cannot make; a human must take the seat and resolve it"}
    assert all(not d["required"] for d in b["decisions"])
    assert b["endTurn"]["supported"] is False


def test_unresolved_write_pauses_the_brief_and_offers_nothing(tmp_path):
    import websocket
    reg = actions.ActionRegistry(journal_path=tmp_path / "journal.jsonl")
    gs, _ = open_session({"a": [ctx_reply(1), ctx_reply(1), reply(2, json.dumps(offers_with(RESEARCH))), ctx_reply(3), websocket.WebSocketConnectionClosedException()]})
    with gs:
        o = reg.list_offers(gs, player=1, mode="singleplayer")
        with pytest.raises(service.ObserverError):
            reg.perform(gs, action_id=o["offers"][0]["actionId"], request_id="x", player=1, mode="singleplayer")
    gs2, _ = open_session({"a": [ctx_reply(1), ctx_reply(1), reply(2, json.dumps(offers_with(RESEARCH))), ctx_reply(3)]})
    with gs2:
        b = brief.build_brief(gs2, reg, player=1, mode="singleplayer")
    assert b["pause"]["reason"] == "RECONCILIATION_REQUIRED" and b["reconciliationRequired"] == ["x"]
    assert b["decisions"] == []


def test_brief_is_small(tmp_path):
    many = [{**RESEARCH[0], "arg": 700 + i, "typeKey": f"NODE_{i}", "displayName": f"Tech {i}"} for i in range(40)]
    many += [{**UNITS[0], "arg": 100 + i, "unitId": 100 + i} for i in range(30)]
    b, _, _ = build(tmp_path, offers_with(many))
    encoded = json.dumps(b)
    assert len(encoded) < 4000, f"brief grew to {len(encoded)} bytes"
    assert sum(len(d["options"]) for d in b["decisions"]) <= brief.DEFAULT_MAX_OPTIONS * len(b["decisions"])
    unit = next(d for d in b["decisions"] if d["kind"] == "unit")
    assert unit["entityCount"] == 30 and len(unit["entities"]) == brief.DEFAULT_MAX_OPTIONS and unit["entitiesOmitted"] == 24
    research = next(d for d in b["decisions"] if d["kind"] == "research")
    assert research["optionCount"] == 40 and research["omitted"] == 34


def test_found_city_offers_form_their_own_settle_decision_alongside_the_required_unit_orders(tmp_path):
    found = [{"kind": "FOUND_CITY", "arg": 5, "x": 10, "y": 10, "pre": 1010, "unitId": 5, "from": {"x": 10, "y": 10}, "unitTypeKey": "UNIT_FOUNDER", "terrainKey": "TERRAIN_FLAT", "movesRemaining": 3, "canStart": True}]
    b, _, _ = build(tmp_path, offers_with(UNITS + found, end_can_start=False, blocking="UNITS"))
    kinds = {d["kind"]: d for d in b["decisions"]}
    assert set(kinds) == {"unit", "settle"}
    assert kinds["unit"]["required"] is True and kinds["settle"]["required"] is False
    settle = kinds["settle"]
    assert settle["options"] == [{"actionId": settle["options"][0]["actionId"], "kind": "found_city", "unitTypeKey": "UNIT_FOUNDER", "unitId": 5, "from": {"x": 10, "y": 10}, "terrainKey": "TERRAIN_FLAT"}]
    assert settle["entities"] == [{"unitId": 5, "typeKey": "UNIT_FOUNDER", "at": {"x": 10, "y": 10}, "movesRemaining": 3}]
    assert b["pause"] is None
