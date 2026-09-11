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
    assert b["endTurn"] == {"canStart": True, "blocking": None, "blockingNotifications": [], "supported": True, "actionId": b["endTurn"]["actionId"]}
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
    b, _, _ = build(tmp_path, offers_with(RESEARCH, end_can_start=False, blocking="RELIGION"))
    assert b["pause"] == {"reason": "UNSUPPORTED_DECISION", "blocking": "RELIGION",
                          "message": "the game requires a RELIGION decision, which this catalog cannot make; a human must take the seat and resolve it"}
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
    assert len(encoded) < 5200, f"brief grew to {len(encoded)} bytes"
    assert sum(len(d["options"]) for d in b["decisions"]) <= brief.DEFAULT_MAX_OPTIONS * len(b["decisions"])
    unit = next(d for d in b["decisions"] if d["kind"] == "unit")
    # every unit is worth listing even when its options are not: entities are one short record each
    assert unit["entityCount"] == 30 and len(unit["entities"]) == brief.DEFAULT_MAX_ENTITIES and unit["entitiesOmitted"] == 14
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


def test_new_population_blocker_makes_the_population_decision_required_with_plot_detail(tmp_path):
    expand = [{"kind": "EXPAND_CITY", "arg": 65536, "x": 16, "y": 28, "pre": 2816, "cityId": 65536, "cityName": "Pārsa", "plotIndex": 2816, "growthReady": True, "improvementKey": "IMPROVEMENT_FARM", "terrainKey": "TERRAIN_FLAT", "featureKey": None, "river": True, "yields": {"food": 2}, "canStart": True}]
    b, _, _ = build(tmp_path, offers_with(RESEARCH + expand, end_can_start=False, blocking="NEW_POPULATION"))
    assert b["pause"] is None and b["endTurn"]["supported"] is True
    required = [d for d in b["decisions"] if d["required"]]
    assert [d["kind"] for d in required] == ["population"]
    option = required[0]["options"][0]
    assert option["kind"] == "expand_city" and option["to"] == {"x": 16, "y": 28} and option["improvementKey"] == "IMPROVEMENT_FARM"
    assert option["yields"] == {"food": 2} and option["river"] is True and option["cityName"] == "Pārsa"


def test_a_settler_that_cannot_found_here_is_shown_as_an_entity_with_a_note_not_an_option(tmp_path):
    blocked = [{"kind": "FOUND_CITY", "arg": 5, "x": 49, "y": 5, "pre": 549, "unitId": 5, "from": {"x": 49, "y": 5}, "unitTypeKey": "UNIT_FOUNDER", "terrainKey": "TERRAIN_NAVIGABLE_RIVER", "movesRemaining": 2, "canStart": False, "reason": "the game refuses founding on this unit's current plot"}]
    b, _, _ = build(tmp_path, offers_with(UNITS + blocked, end_can_start=False, blocking="UNITS"))
    settle = next(d for d in b["decisions"] if d["kind"] == "settle")
    assert settle["options"] == [] and settle["optionCount"] == 0 and settle["required"] is False
    assert settle["entities"] == [{"unitId": 5, "typeKey": "UNIT_FOUNDER", "at": {"x": 49, "y": 5}, "movesRemaining": 2, "canFoundHere": False, "terrainKey": "TERRAIN_NAVIGABLE_RIVER", "tooCloseToSettle": None}]
    assert "refused" in settle["note"] and "Move it" in settle["note"]


def test_production_blocker_groups_units_and_buildings_into_one_required_production_decision(tmp_path):
    production = [
        {"kind": "PRODUCE_UNIT", "arg": 65536, "arg2": 100, "pre": -1, "cityId": 65536, "cityName": "Pārsa", "unitTypeKey": "UNIT_WARRIOR", "displayName": "Warrior", "cost": 40, "turns": 5, "canStart": True},
        {"kind": "PRODUCE_CONSTRUCTIBLE", "arg": 65536, "arg2": 501, "arg3": 404, "x": 4, "y": 4, "pre": -1, "cityId": 65536, "cityName": "Pārsa", "constructibleKey": "BUILDING_GRANARY", "displayName": "Granary", "cost": 36, "turns": 8, "plotIndex": 404, "placement": "newUrban", "terrainKey": "TERRAIN_FLAT", "yields": {"food": 3}, "canStart": True},
    ]
    b, _, _ = build(tmp_path, offers_with(production, end_can_start=False, blocking="PRODUCTION"))
    required = [d for d in b["decisions"] if d["required"]]
    assert [d["kind"] for d in required] == ["production"] and b["pause"] is None
    kinds = [(o["kind"], o.get("displayName"), o.get("cost"), o.get("turns"), o.get("placement"), o.get("to")) for o in required[0]["options"]]
    assert kinds == [("produce_unit", "Warrior", 40, 5, None, None), ("produce_constructible", "Granary", 36, 8, "newUrban", {"x": 4, "y": 4})]


def test_traditions_blocker_is_a_supported_policies_decision_with_activation_and_confirm_options(tmp_path):
    policies = [
        {"kind": "CHANGE_TRADITION", "arg": 11, "arg2": 9001, "pre": 0, "slot": "TRADITION_CULTURE_SLOT", "slotsTotal": 1, "slotsFree": 1, "typeKey": "TRADITION_A", "displayName": "Trial of Time", "description": "+1 culture", "canStart": True},
        {"kind": "CONSIDER_ASSIGN_TRADITIONS", "arg": 0, "pre": 0, "canStart": True}]
    b, _, _ = build(tmp_path, offers_with(policies, end_can_start=False, blocking="TRADITIONS"))
    assert b["pause"] is None and b["endTurn"]["supported"] is True
    required = [d for d in b["decisions"] if d["required"]]
    assert [d["kind"] for d in required] == ["policies"]
    kinds = [(o["kind"], o.get("displayName"), o.get("slot"), o.get("slotsFree"), o.get("description")) for o in required[0]["options"]]
    assert kinds == [("activate_tradition", "Trial of Time", "TRADITION_CULTURE_SLOT", 1, "+1 culture"), ("confirm_traditions", None, None, None, None)]
    assert "activate a card into a free slot first" in required[0]["note"]


def test_a_notification_named_blocker_for_a_discovery_story_is_a_supported_narrative_decision(tmp_path):
    story = [{"kind": "CHOOSE_NARRATIVE_STORY_DIRECTION", "arg": 28, "arg2": 7001, "pre": -1089908522, "storyId": 28, "storyKey": "DISCOVERY_X", "title": "Merciless Mercenaries", "body": "Mercenaries...", "answerKey": "DISCOVERY_X_A", "option": "Hire them", "reward": "+50 gold", "action": None, "cost": 0, "costYield": None, "affordable": True, "canStart": True}]
    b, _, _ = build(tmp_path, offers_with(story, end_can_start=False, blocking="NOTIFICATION_CHOOSE_DISCOVERY_STORY_DIRECTION"))
    assert b["pause"] is None and b["endTurn"]["supported"] is True
    required = [d for d in b["decisions"] if d["required"]]
    assert [d["kind"] for d in required] == ["narrative"]
    o = required[0]["options"][0]
    assert (o["kind"], o["title"], o["option"], o["reward"], o["answerKey"], o["affordable"]) == ("narrative_choice", "Merciless Mercenaries", "Hire them", "+50 gold", "DISCOVERY_X_A", True)


def test_pantheon_blocker_is_a_supported_decision(tmp_path):
    pantheon = [{"kind": "FOUND_PANTHEON", "arg": 3001, "pre": 0, "typeKey": "PANTHEON_BONUS_1", "displayName": "City Patron Goddess", "description": "+2 Influence", "canStart": True}]
    b, _, _ = build(tmp_path, offers_with(pantheon, end_can_start=False, blocking="PANTHEON"))
    required = [d for d in b["decisions"] if d["required"]]
    assert [d["kind"] for d in required] == ["pantheon"] and b["pause"] is None
    assert required[0]["options"][0]["description"] == "+2 Influence"


@pytest.mark.parametrize("blocking, decision", [
    ("NOTIFICATION_CHOOSE_CULTURE_NODE", "civic"), ("NOTIFICATION_CHOOSE_TECH", "research"),
    ("NOTIFICATION_CHOOSE_CITY_PRODUCTION", "production"), ("NOTIFICATION_COMMAND_UNITS", "unit"),
])
def test_notification_named_blockers_map_to_the_same_decisions_as_the_enum(tmp_path, blocking, decision):
    civic = [{"kind": "SET_CULTURE_TREE_NODE", "arg": 801, "pre": -1, "typeKey": "NODE_CIVIC_AQ_MAIN_MYSTICISM", "displayName": "Mysticism", "tree": "TREE_CIVICS_AQ_MAIN", "cost": 125, "turns": 6, "canStart": True}]
    production = [{"kind": "PRODUCE_UNIT", "arg": 65536, "arg2": 100, "pre": 0, "cityId": 65536, "cityName": "Pārsa", "queue": [], "queueLength": 0, "unitTypeKey": "UNIT_WARRIOR", "displayName": "Warrior", "canStart": True}]
    b, _, _ = build(tmp_path, offers_with(RESEARCH + civic + UNITS + production, end_can_start=False, blocking=blocking))
    assert b["pause"] is None and b["endTurn"]["supported"] is True
    assert [d["kind"] for d in b["decisions"] if d["required"]] == [decision]


def test_blocking_notifications_add_required_decisions_beyond_the_single_blocker_value(tmp_path):
    """Live (turn 8): blocker CULTURE while CHOOSE_GOVERNMENT and TRADITIONS_AVAILABLE were what blocked."""
    civic = [{"kind": "SET_CULTURE_TREE_NODE", "arg": 801, "pre": 1301158071, "typeKey": "NODE_CIVIC_AQ_MAIN_DISCIPLINE", "displayName": "Discipline", "tree": "TREE_CIVICS_AQ_MAIN", "cost": 125, "turns": 6, "canStart": True}]
    gov = [{"kind": "CHANGE_GOVERNMENT", "arg": 1, "arg2": -87192893, "pre": -1, "typeKey": "GOVERNMENT_DESPOTISM", "displayName": "Despotism", "description": "d", "celebration": "c", "canStart": True}]
    policies = [{"kind": "CONSIDER_ASSIGN_TRADITIONS", "arg": 0, "pre": 0, "canStart": True}]
    payload = offers_with(civic + gov + policies + UNITS, end_can_start=False, blocking="CULTURE")
    payload["context"] = {**payload["context"], "blockingNotifications": ["NOTIFICATION_CHOOSE_GOVERNMENT", "NOTIFICATION_COMMAND_UNITS", "NOTIFICATION_TRADITIONS_AVAILABLE"]}
    b, _, _ = build(tmp_path, payload)
    assert b["pause"] is None and b["endTurn"]["supported"] is True
    assert b["endTurn"]["blockingNotifications"] == ["NOTIFICATION_CHOOSE_GOVERNMENT", "NOTIFICATION_COMMAND_UNITS", "NOTIFICATION_TRADITIONS_AVAILABLE"]
    assert [d["kind"] for d in b["decisions"] if d["required"]] == ["civic", "government", "unit", "policies"]
    assert b["decisions"][1]["options"][0]["celebration"] == "c"


def test_an_unmapped_blocking_notification_pauses_even_when_the_blocker_value_is_supported(tmp_path):
    payload = offers_with(RESEARCH, end_can_start=False, blocking="RESEARCH")
    payload["context"] = {**payload["context"], "blockingNotifications": ["NOTIFICATION_WORLD_CONGRESS_VOTE"]}
    b, _, _ = build(tmp_path, payload)
    assert b["pause"]["reason"] == "UNSUPPORTED_DECISION" and "NOTIFICATION_WORLD_CONGRESS_VOTE" in b["pause"]["message"]


def test_attribute_notification_is_a_supported_attributes_decision(tmp_path):
    attrs = [{"kind": "BUY_ATTRIBUTE_TREE_NODE", "arg": 4001, "pre": 2, "typeKey": "NODE_ATTRIBUTE_CULTURAL_01", "tree": "TREE_ATTRIBUTE_CULTURAL", "attribute": "ATTRIBUTE_CULTURAL", "attributeName": "Cultural", "displayName": "Cultural", "description": "d", "cost": 1, "availablePoints": 0, "wildcardPoints": 2, "canStart": True},
             {"kind": "CONSIDER_ASSIGN_ATTRIBUTE", "arg": 0, "pre": 0, "canStart": True}]
    payload = offers_with(attrs, end_can_start=False, blocking="TRADITIONS")
    payload["context"] = {**payload["context"], "blockingNotifications": ["NOTIFICATION_CAN_BUY_ATTRIBUTE_SKILL"]}
    b, _, _ = build(tmp_path, payload)
    assert b["pause"] is None
    kinds = [d["kind"] for d in b["decisions"] if d["required"]]
    assert kinds == ["policies", "attributes"] or kinds == ["attributes"]
    attributes = next(d for d in b["decisions"] if d["kind"] == "attributes")
    assert attributes["options"][0]["wildcardPoints"] == 2 and "wildcard" in attributes["note"]


def test_golden_age_notification_is_a_supported_celebration_decision(tmp_path):
    ga = [{"kind": "CHOOSE_GOLDEN_AGE", "arg": 5001, "pre": 2, "typeKey": "GOLDEN_AGE_CR_1", "displayName": "Classical Republic", "description": "+100 Influence", "canStart": True}]
    payload = offers_with(ga, end_can_start=False, blocking="CULTURE")
    payload["context"] = {**payload["context"], "blockingNotifications": ["NOTIFICATION_CHOOSE_GOLDEN_AGE"]}
    b, _, _ = build(tmp_path, payload)
    assert b["pause"] is None and [d["kind"] for d in b["decisions"] if d["required"]] == ["celebration"]


def test_new_resources_notification_is_a_supported_resources_decision(tmp_path):
    res = [{"kind": "ASSIGN_RESOURCE", "arg": 1637, "arg2": 131073, "pre": 1, "plotIndex": 1637, "from": {"x": 17, "y": 27}, "resourceKey": "RESOURCE_RUBIES", "displayName": "Rubies", "resourceClass": "RESOURCECLASS_BONUS", "description": "+4 Gold", "assignedCityId": None, "originCityName": "Pārsa", "cityId": 131073, "cityName": "Bactria", "cityIsTown": True, "cityCap": 1, "cityAssigned": 0, "toAssign": 1, "canStart": True}]
    payload = offers_with(res, end_can_start=False, blocking="NEW_POPULATION")
    payload["context"] = {**payload["context"], "blockingNotifications": ["NOTIFICATION_ASSIGN_NEW_RESOURCES"]}
    b, _, _ = build(tmp_path, payload)
    assert b["pause"] is None
    d = next(d for d in b["decisions"] if d["kind"] == "resources")
    assert d["required"] is True and d["options"][0]["cityCap"] == 1 and "capacity" in d["note"]


def test_a_pending_proposal_is_a_supported_required_decision_not_a_pause(tmp_path):
    """Live, turn 50: another seat's Open Borders offer paused play as an unsupported decision."""
    rs = [{"kind": "RESPOND_DIPLOMATIC_ACTION", "arg": 16, "arg2": 926305338, "pre": 1, "eventId": 16, "answer": "accept", "typeKey": "DIPLOMACY_ACTION_OPEN_BORDERS", "displayName": "Open Borders", "description": "borders open", "proposerPlayerId": 1, "proposerName": "Abbasid", "canStart": True},
          {"kind": "RESPOND_DIPLOMATIC_ACTION", "arg": 16, "arg2": 567527351, "pre": 1, "eventId": 16, "answer": "reject", "typeKey": "DIPLOMACY_ACTION_OPEN_BORDERS", "displayName": "Open Borders", "description": "borders open", "proposerPlayerId": 1, "proposerName": "Abbasid", "canStart": True}]
    payload = offers_with(rs, end_can_start=False, blocking="DIPLOMATIC_RESPOSE_REQUIRED")
    payload["context"] = {**payload["context"], "blockingNotifications": ["NOTIFICATION_DIPLOMATIC_RESPONSE_REQUIRED"]}
    b, _, _ = build(tmp_path, payload)
    assert b["pause"] is None
    d = next(d for d in b["decisions"] if d["kind"] == "diplomatic_response")
    assert d["required"] is True
    assert [(o["answer"], o["proposerName"]) for o in d["options"]] == [("accept", "Abbasid"), ("reject", "Abbasid")]
    assert "proposed" in d["note"]


def test_choosing_a_religion_is_a_supported_required_decision_not_a_pause(tmp_path):
    """Live, turn 52: the religion notification paused play as an unsupported decision."""
    rel = [{"kind": "FOUND_RELIGION", "arg": 35560851, "pre": -1, "typeKey": "RELIGION_BUDDHISM", "displayName": "Buddhism", "canStart": True}]
    payload = offers_with(rel, end_can_start=False, blocking="NEW_POPULATION")
    payload["context"] = {**payload["context"], "blockingNotifications": ["NOTIFICATION_CHOOSE_RELIGION"]}
    b, _, _ = build(tmp_path, payload)
    assert b["pause"] is None
    d = next(d for d in b["decisions"] if d["kind"] == "religion")
    assert d["required"] is True and d["options"][0]["kind"] == "found_religion" and "found a religion" in d["note"]


def test_choosing_a_belief_is_the_same_religion_decision(tmp_path):
    """Live, turn 52: the religion was founded and the turn then blocked on a separate belief notification."""
    bel = [{"kind": "ADD_BELIEF", "arg": 777, "pre": 0, "typeKey": "BELIEF_BONUS_1", "beliefClass": "ENHANCER", "displayName": "Bonus", "canStart": True}]
    payload = offers_with(bel, end_can_start=False, blocking="NEW_POPULATION")
    payload["context"] = {**payload["context"], "blockingNotifications": ["NOTIFICATION_CHOOSE_BELIEF"]}
    b, _, _ = build(tmp_path, payload)
    assert b["pause"] is None
    d = next(d for d in b["decisions"] if d["kind"] == "religion")
    assert d["required"] is True and d["options"][0]["kind"] == "add_belief"


def test_a_captured_settlement_and_a_city_state_bonus_are_supported_required_decisions(tmp_path):
    caps = [{"kind": "KEEP_CITY", "arg": 65536, "pre": 1, "cityId": 65536, "cityName": "Ur", "population": 5, "wonders": 0, "isTown": False, "canStart": True},
            {"kind": "RAZE_CITY", "arg": 65536, "pre": 1, "cityId": 65536, "cityName": "Ur", "population": 5, "wonders": 0, "isTown": False, "destructive": True, "requiresConfirmation": True, "canStart": True}]
    payload = offers_with(caps, end_can_start=False, blocking="NEW_POPULATION")
    payload["context"] = {**payload["context"], "blockingNotifications": ["NOTIFICATION_CONSIDER_RAZE_CITY"]}
    b, _, _ = build(tmp_path, payload)
    assert b["pause"] is None
    d = next(d for d in b["decisions"] if d["kind"] == "capture")
    assert d["required"] is True and [o["kind"] for o in d["options"]] == ["keep_captured_city", "raze_captured_city"] and "raze" in d["note"]
    assert d["options"][1]["requiresConfirmation"] is True and "guidance" in d["options"][1]
    bonus = [{"kind": "CHOOSE_CITY_STATE_BONUS", "arg": 5000, "arg2": 12, "pre": 12, "typeKey": "CITY_STATE_BONUS_A", "displayName": "A", "cityStatePlayerId": 12, "canStart": True}]
    payload = offers_with(bonus, end_can_start=False, blocking="NEW_POPULATION")
    payload["context"] = {**payload["context"], "blockingNotifications": ["NOTIFICATION_CHOOSE_CITY_STATE_BONUS"]}
    b, _, _ = build(tmp_path, payload)
    assert b["pause"] is None and next(d for d in b["decisions"] if d["kind"] == "city_state_bonus")["required"] is True


def test_the_option_that_clears_a_blocker_survives_a_crowded_group(tmp_path):
    """Live, turn 45: six resource assignments and one confirm; the confirm was the option dropped and
    the seat could not end its turn at all, with nothing left to assign."""
    res = [{"kind": "ASSIGN_RESOURCE", "arg": 1600 + i, "arg2": 131073 + i, "pre": 0, "plotIndex": 1600 + i,
            "resourceKey": f"RESOURCE_{i}", "displayName": f"Res {i}", "cityId": 131073 + i, "cityName": f"City {i}",
            "cityCap": 1, "cityAssigned": 0, "toAssign": 0, "canStart": True} for i in range(6)]
    confirm = [{"kind": "CONSIDER_ASSIGN_RESOURCE", "arg": 0, "pre": 0, "canStart": True}]
    payload = offers_with(res + confirm, end_can_start=False, blocking="NEW_POPULATION")
    payload["context"] = {**payload["context"], "blockingNotifications": ["NOTIFICATION_ASSIGN_NEW_RESOURCES"]}
    b, _, _ = build(tmp_path, payload)
    d = next(d for d in b["decisions"] if d["kind"] == "resources")
    kinds = [o["kind"] for o in d["options"]]
    assert "consider_resources" in kinds, "the only option that clears the blocker was dropped"
    assert kinds[-1] == "consider_resources", "it reads after the choices, not before them"
    assert len(d["options"]) <= 6 and d["omitted"] == d["optionCount"] - len(d["options"])


def test_unit_promotion_notification_is_a_supported_promotion_decision(tmp_path):
    promo = [{"kind": "PROMOTE_UNIT", "arg": 5, "arg2": 7101, "arg3": 8101, "pre": 0, "unitId": 5, "from": {"x": 10, "y": 10}, "unitTypeKey": "UNIT_ARMY_COMMANDER", "movesRemaining": 2, "discipline": "DISCIPLINE_ARMY_BASTION", "disciplineName": "Bastion", "typeKey": "PROMOTION_A", "displayName": "Fortify", "description": "+5 defence", "commendation": False, "promotionsEarned": 0, "promotionPoints": 1, "unitLevel": 2, "canStart": True}]
    payload = offers_with(promo, end_can_start=False, blocking="UNIT_PROMOTION")
    b, _, _ = build(tmp_path, payload)
    assert b["pause"] is None
    d = next(d for d in b["decisions"] if d["kind"] == "promotion")
    assert d["required"] is True and d["options"][0]["disciplineName"] == "Bastion" and d["options"][0]["promotionPoints"] == 1
    assert d["entities"] == [{"unitId": 5, "typeKey": "UNIT_ARMY_COMMANDER", "at": {"x": 10, "y": 10}, "movesRemaining": 2}]


def test_every_unit_is_represented_before_any_unit_gets_a_second_option(tmp_path):
    """Live friction (turn 33): a settler's own moves sat behind six other units' options, so the
    seat could not see where it could go and left it standing."""
    def move(uid, x, y):
        return {"kind": "MOVE_UNIT", "arg": uid, "arg2": x, "arg3": y, "pre": 1000 + uid, "unitId": uid,
                "from": {"x": 10, "y": 10}, "x": x, "y": y, "unitTypeKey": "UNIT_SCOUT", "terrainKey": "TERRAIN_FLAT",
                "pathTurns": 1, "movesRemaining": 2, "canStart": True}
    crowd = [move(1, 11, 10), move(1, 11, 11), move(1, 12, 10), move(1, 12, 11), move(1, 13, 10), move(1, 13, 11)]
    settler = [move(9, 9, 10), move(9, 9, 11)]
    b, _, _ = build(tmp_path, offers_with(crowd + settler, end_can_start=False, blocking="UNITS"), max_options=4)
    unit = next(d for d in b["decisions"] if d["kind"] == "unit")
    seen = [o["unitId"] for o in unit["options"]]
    assert 9 in seen, "the settler must get an option even though another unit had six"
    assert seen.count(1) <= 3 and len(unit["options"]) == 4 and unit["optionCount"] == 8 and unit["omitted"] == 4


def test_a_blocked_settler_is_pointed_at_the_per_unit_options_tool(tmp_path):
    blocked = [{"kind": "FOUND_CITY", "arg": 5, "x": 49, "y": 5, "pre": 549, "unitId": 5, "from": {"x": 49, "y": 5},
                "unitTypeKey": "UNIT_FOUNDER", "terrainKey": "TERRAIN_NAVIGABLE_RIVER", "movesRemaining": 2, "canStart": False}]
    b, _, _ = build(tmp_path, offers_with(UNITS + blocked, end_can_start=False, blocking="UNITS"))
    settle = next(d for d in b["decisions"] if d["kind"] == "settle")
    assert "get_unit_options" in settle["note"]


def test_town_project_notification_is_a_supported_decision(tmp_path):
    tp = [{"kind": "CHOOSE_TOWN_PROJECT", "arg": 131073, "arg2": 9301, "pre": -1, "cityId": 131073, "cityName": "Sendai", "typeKey": "PROJECT_TOWN_FORT", "displayName": "Fort Town", "description": "+5 healing", "cost": 120, "townDefault": False, "upgradeToCity": False, "canStart": True}]
    payload = offers_with(tp, end_can_start=False, blocking="NEW_POPULATION")
    payload["context"] = {**payload["context"], "blockingNotifications": ["NOTIFICATION_CHOOSE_TOWN_PROJECT"]}
    b, _, _ = build(tmp_path, payload)
    assert b["pause"] is None
    d = next(d for d in b["decisions"] if d["kind"] == "town_project")
    assert d["required"] is True and d["options"][0]["displayName"] == "Fort Town"


def test_crisis_cards_answer_the_crisis_blocker_and_ordinary_cards_stay_in_policies(tmp_path):
    """Live (turn 66): NOTIFICATION_CRISIS blocked with three activatable crisis cards already offered."""
    cards = [
        {"kind": "CHANGE_TRADITION", "arg": 11, "arg2": 9001, "pre": 0, "slot": "CRISIS_CULTURE_SLOT", "slotsTotal": 2, "slotsFree": 2, "slotsFreeAny": 14, "typeKey": "TRADITION_INCOMPETENT_MINISTERS", "displayName": "Incompetent Ministers", "description": "d", "isCrisis": True, "canStart": True},
        {"kind": "CHANGE_TRADITION", "arg": 12, "arg2": 9002, "pre": 0, "slot": "POLICY_CULTURE_SLOT", "slotsTotal": 17, "slotsFree": 12, "slotsFreeAny": 14, "typeKey": "TRADITION_HONOR", "displayName": "Honor", "description": "d", "isCrisis": False, "canStart": True},
        {"kind": "CONSIDER_ASSIGN_TRADITIONS", "arg": 0, "pre": 0, "slotsFreeAny": 14, "activatable": 2, "canStart": False},
    ]
    payload = offers_with(cards, end_can_start=False, blocking="CRISIS")
    b, _, _ = build(tmp_path, payload)
    assert b["pause"] is None
    kinds = {d["kind"]: d for d in b["decisions"]}
    assert kinds["crisis"]["required"] is True
    assert [o["displayName"] for o in kinds["crisis"]["options"]] == ["Incompetent Ministers"]
    assert [o["displayName"] for o in kinds["policies"]["options"]] == ["Honor"]
    assert kinds["crisis"]["options"][0]["isCrisis"] is True


def test_choose_civilization_is_a_supported_age_transition_decision(tmp_path):
    at = [{"kind": "CHOOSE_AGE_CIVILIZATION", "arg": 125352635, "pre": -1, "typeKey": "CIVILIZATION_ABBASID", "displayName": "Abbasid", "fullName": "Abbasid Empire", "description": "d", "historical": True, "selected": False, "invalidReason": 0, "canStart": True},
          {"kind": "SET_AGE_TRANSITION_DATA", "arg": 0, "pre": -1, "selectedCivilization": "RANDOM", "canStart": False}]
    payload = offers_with(at, end_can_start=False, blocking="-2084516792")
    payload["context"] = {**payload["context"], "blockingNotifications": ["NOTIFICATION_CHOOSE_CIVILIZATION"]}
    b, _, _ = build(tmp_path, payload)
    assert b["pause"] is None
    d = next(d for d in b["decisions"] if d["kind"] == "age_transition")
    assert d["required"] is True and d["options"][0]["historical"] is True and "one-way" in d["note"]


def test_age_transition_notification_in_the_new_age_is_the_legacies_decision(tmp_path):
    lg = [{"kind": "ADVANCED_START_MODIFY_DECK", "arg": 1875644328, "pre": 0, "cardId": "CARD_AT_EX_DEFAULT_1", "displayName": "Umm al-belad", "description": "2 merchants", "cost": 1, "pointsAvailable": 3, "needsPlacement": False, "canStart": True},
          {"kind": "ADVANCED_START_MARK_COMPLETED", "arg": 0, "pre": 0, "deck": [], "pointsAvailable": 3, "canStart": True}]
    payload = offers_with(lg, end_can_start=False, blocking="NOTIFICATION_CHOOSE_CITY_PRODUCTION")
    payload["context"] = {**payload["context"], "blockingNotifications": ["NOTIFICATION_AGE_TRANSITION"]}
    b, _, _ = build(tmp_path, payload)
    assert b["pause"] is None
    d = next(d for d in b["decisions"] if d["kind"] == "legacies")
    assert d["required"] is True and d["options"][0]["pointsAvailable"] == 3 and "forfeits any unspent" in d["note"]


def test_player_met_notification_is_a_supported_first_meet_decision(tmp_path):
    fm = [{"kind": "RESPOND_DIPLOMATIC_FIRST_MEET", "arg": 2135616342, "arg2": 1, "arg3": 108, "pre": 108, "greeting": "FRIENDLY", "otherPlayer": 1, "influenceCost": 13, "influenceBalance": 796, "note": "Your capital will be revealed.", "canStart": True}]
    payload = offers_with(fm, end_can_start=False, blocking="NOTIFICATION_PLAYER_MET")
    payload["context"] = {**payload["context"], "blockingNotifications": ["NOTIFICATION_PLAYER_MET"]}
    b, _, _ = build(tmp_path, payload)
    assert b["pause"] is None
    d = next(d for d in b["decisions"] if d["kind"] == "first_meet")
    assert d["required"] is True and d["options"][0]["greeting"] == "FRIENDLY" and "greets it" in d["note"]


def test_a_wounded_unit_shows_its_damage_and_the_heal_order(tmp_path):
    orders = [{"kind": "UNIT_ORDER", "arg": 5, "arg2": 1576905647, "pre": 2, "unitId": 5, "from": {"x": 10, "y": 10}, "unitTypeKey": "UNIT_SWORDSMAN", "movesRemaining": 2, "damage": 84, "maxDamage": 100, "orderKey": "UNITOPERATION_REST_UNTIL_HEALED", "displayName": "Heal", "description": "Rest until fully healed.", "canStart": True}]
    b, _, _ = build(tmp_path, offers_with(orders, end_can_start=False, blocking="UNITS"))
    unit = next(d for d in b["decisions"] if d["kind"] == "unit")
    assert unit["options"][0]["displayName"] == "Heal" and unit["options"][0]["damage"] == 84
    assert unit["entities"][0]["damage"] == 84
    assert "Heal rests a damaged unit" in unit["note"]
