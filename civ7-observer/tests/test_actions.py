import json

import pytest

from civ7_observer import actions, service
from test_targets import GAME, Factory, reply, target

CTX = {"turn": 12, "age": 4242, "playerId": 1, "localPlayerId": 1, "localObserverId": 1, "mode": "singleplayer", "isTurnActive": True, "curtainDisplayed": False}
OFFERS = {"payloadVersion": 1, "refused": None, "context": CTX, "offers": [
    {"kind": "SET_TECH_TREE_NODE", "arg": 701, "typeKey": "NODE_TECH_AQ_POTTERY", "displayName": "Pottery", "tree": "TREE_TECHS_AQ", "cost": 60, "turns": 4, "canStart": True},
    {"kind": "SET_TECH_TREE_NODE", "arg": 702, "typeKey": "NODE_TECH_AQ_WRITING", "displayName": "Writing", "tree": "TREE_TECHS_AQ", "cost": 100, "turns": 7, "canStart": False},
    {"kind": "END_TURN", "arg": 0, "canStart": True, "blockingType": None, "alreadySent": False},
]}
PERFORMED = {"payloadVersion": 1, "refused": None, "context": CTX, "outcome": "sent", "readback": {"kind": "SET_TECH_TREE_NODE", "arg": 701, "observedType": 701, "matches": True}}


def open_session(scripts):
    tl = [target("a")]
    f = Factory(scripts)
    return service.open_game_session(port=9444, timeout=1, discover=lambda p, t: tl, session_factory=f), f


def ctx_reply(i):
    return reply(i, json.dumps(GAME))


def test_list_offers_assigns_opaque_ids_bound_to_seat_turn_and_session(tmp_path):
    reg = actions.ActionRegistry(journal_path=tmp_path / "journal.jsonl")
    gs, _ = open_session({"a": [ctx_reply(1), ctx_reply(1), reply(2, json.dumps(OFFERS)), ctx_reply(3)]})
    with gs:
        out = reg.list_offers(gs, player=1, mode="singleplayer")
    assert out["context"]["turn"] == 12
    ids = [o["actionId"] for o in out["offers"]]
    assert len(set(ids)) == 3 and all(len(i) >= 16 for i in ids)
    assert all("arg" not in o for o in out["offers"]), "raw engine arguments are not exposed"
    pottery = next(o for o in out["offers"] if o.get("typeKey") == "NODE_TECH_AQ_POTTERY")
    assert pottery["canStart"] is True and pottery["kind"] == "research"
    end = next(o for o in out["offers"] if o["kind"] == "end_turn")
    assert end["canStart"] is True


def test_perform_resolves_id_and_journals_pending_then_confirmed(tmp_path):
    reg = actions.ActionRegistry(journal_path=tmp_path / "journal.jsonl")
    gs, f = open_session({"a": [ctx_reply(1), ctx_reply(1), reply(2, json.dumps(OFFERS)), ctx_reply(3), reply(4, json.dumps(PERFORMED)), ctx_reply(5)]})
    with gs:
        offers = reg.list_offers(gs, player=1, mode="singleplayer")
        pottery = next(o for o in offers["offers"] if o.get("typeKey") == "NODE_TECH_AQ_POTTERY")
        res = reg.perform(gs, action_id=pottery["actionId"], request_id="req-1", player=1, mode="singleplayer")
    assert res["status"] == "confirmed" and res["requestId"] == "req-1"
    sent = json.loads(f.all_sockets[1].sent[3])["params"]["expression"]
    assert '"SET_TECH_TREE_NODE"' in sent and "701" in sent and "OP_KIND" not in sent and "OP_ARG" not in sent
    lines = [json.loads(l) for l in (tmp_path / "journal.jsonl").read_text().splitlines()]
    assert [l["status"] for l in lines] == ["pending", "confirmed"]
    assert lines[0]["requestId"] == "req-1" and lines[0]["kind"] == "SET_TECH_TREE_NODE"


def test_perform_is_idempotent_on_request_id_and_rejects_reuse_with_different_action(tmp_path):
    reg = actions.ActionRegistry(journal_path=tmp_path / "journal.jsonl")
    gs, f = open_session({"a": [ctx_reply(1), ctx_reply(1), reply(2, json.dumps(OFFERS)), ctx_reply(3), reply(4, json.dumps(PERFORMED)), ctx_reply(5)]})
    with gs:
        offers = reg.list_offers(gs, player=1, mode="singleplayer")
        ids = {o.get("typeKey", o["kind"]): o["actionId"] for o in offers["offers"]}
        first = reg.perform(gs, action_id=ids["NODE_TECH_AQ_POTTERY"], request_id="req-1", player=1, mode="singleplayer")
        again = reg.perform(gs, action_id=ids["NODE_TECH_AQ_POTTERY"], request_id="req-1", player=1, mode="singleplayer")
        with pytest.raises(service.ObserverError) as ei:
            reg.perform(gs, action_id=ids["end_turn"], request_id="req-1", player=1, mode="singleplayer")
    assert again == first
    assert ei.value.code == "REQUEST_ID_REUSED"
    assert sum(1 for s in f.all_sockets[1].sent if "sendRequest" in s or "sendTurnComplete" in s) == 1, "the mutation payload was sent exactly once"


def test_perform_rejects_unknown_expired_or_unstartable_offers(tmp_path):
    reg = actions.ActionRegistry(journal_path=tmp_path / "journal.jsonl")
    gs, _ = open_session({"a": [ctx_reply(1), ctx_reply(1), reply(2, json.dumps(OFFERS)), ctx_reply(3)]})
    with gs:
        offers = reg.list_offers(gs, player=1, mode="singleplayer")
        writing = next(o for o in offers["offers"] if o.get("typeKey") == "NODE_TECH_AQ_WRITING")
        with pytest.raises(service.ObserverError) as e1:
            reg.perform(gs, action_id="not-an-id", request_id="r", player=1, mode="singleplayer")
        with pytest.raises(service.ObserverError) as e2:
            reg.perform(gs, action_id=writing["actionId"], request_id="r2", player=1, mode="singleplayer")
    assert e1.value.code == "UNKNOWN_ACTION"
    assert e2.value.code == "ACTION_NOT_STARTABLE"
    # a new session on a later turn must not accept the old id
    later = {**GAME, "turn": 13}
    gs2, _ = open_session({"a": [reply(1, json.dumps(later)), reply(1, json.dumps(later))]})
    with gs2, pytest.raises(service.ObserverError) as e3:
        reg.perform(gs2, action_id=offers["offers"][0]["actionId"], request_id="r3", player=1, mode="singleplayer")
    assert e3.value.code == "ACTION_EXPIRED"


def test_perform_refuses_offer_from_another_seat(tmp_path):
    reg = actions.ActionRegistry(journal_path=tmp_path / "journal.jsonl")
    gs, _ = open_session({"a": [ctx_reply(1), ctx_reply(1), reply(2, json.dumps(OFFERS)), ctx_reply(3)]})
    with gs:
        offers = reg.list_offers(gs, player=1, mode="singleplayer")
        with pytest.raises(service.ObserverError) as ei:
            reg.perform(gs, action_id=offers["offers"][0]["actionId"], request_id="r", player=0, mode="singleplayer")
    assert ei.value.code == "WRONG_PLAYER"


def test_payload_refusal_during_perform_is_journaled_as_rejected(tmp_path):
    reg = actions.ActionRegistry(journal_path=tmp_path / "journal.jsonl")
    refused = {"payloadVersion": 1, "refused": {"code": "ACTION_BLOCKED", "message": "no", "blockingType": "X"}, "context": None, "outcome": None, "readback": None}
    gs, _ = open_session({"a": [ctx_reply(1), ctx_reply(1), reply(2, json.dumps(OFFERS)), ctx_reply(3), reply(4, json.dumps(refused))]})
    with gs:
        offers = reg.list_offers(gs, player=1, mode="singleplayer")
        end = next(o for o in offers["offers"] if o["kind"] == "end_turn")
        res = reg.perform(gs, action_id=end["actionId"], request_id="r", player=1, mode="singleplayer")
    assert res["status"] == "rejected" and res["error"]["code"] == "ACTION_BLOCKED"
    lines = [json.loads(l) for l in (tmp_path / "journal.jsonl").read_text().splitlines()]
    assert [l["status"] for l in lines] == ["pending", "rejected"]


def test_transport_loss_after_send_is_journaled_unknown_and_blocks_further_actions(tmp_path):
    import websocket
    reg = actions.ActionRegistry(journal_path=tmp_path / "journal.jsonl")
    gs, _ = open_session({"a": [ctx_reply(1), ctx_reply(1), reply(2, json.dumps(OFFERS)), ctx_reply(3), websocket.WebSocketConnectionClosedException()]})
    with gs:
        offers = reg.list_offers(gs, player=1, mode="singleplayer")
        end = next(o for o in offers["offers"] if o["kind"] == "end_turn")
        with pytest.raises(service.ObserverError) as ei:
            reg.perform(gs, action_id=end["actionId"], request_id="r", player=1, mode="singleplayer")
    assert ei.value.code == "ACTION_OUTCOME_UNKNOWN"
    lines = [json.loads(l) for l in (tmp_path / "journal.jsonl").read_text().splitlines()]
    assert [l["status"] for l in lines] == ["pending", "unknown"]
    reg2 = actions.ActionRegistry(journal_path=tmp_path / "journal.jsonl")
    assert reg2.needs_reconciliation() == ["r"]
    gs2, _ = open_session({"a": [ctx_reply(1), ctx_reply(1), reply(2, json.dumps(OFFERS)), ctx_reply(3)]})
    with gs2:
        offers2 = reg2.list_offers(gs2, player=1, mode="singleplayer")
        with pytest.raises(service.ObserverError) as e2:
            reg2.perform(gs2, action_id=offers2["offers"][0]["actionId"], request_id="r9", player=1, mode="singleplayer")
    assert e2.value.code == "RECONCILIATION_REQUIRED"
    reg2.reconcile("r", "confirmed", note="human verified")
    assert reg2.needs_reconciliation() == []


def test_get_result_returns_journaled_outcome(tmp_path):
    reg = actions.ActionRegistry(journal_path=tmp_path / "journal.jsonl")
    assert reg.get_result("nope") is None
    gs, _ = open_session({"a": [ctx_reply(1), ctx_reply(1), reply(2, json.dumps(OFFERS)), ctx_reply(3), reply(4, json.dumps(PERFORMED)), ctx_reply(5)]})
    with gs:
        offers = reg.list_offers(gs, player=1, mode="singleplayer")
        pottery = next(o for o in offers["offers"] if o.get("typeKey") == "NODE_TECH_AQ_POTTERY")
        reg.perform(gs, action_id=pottery["actionId"], request_id="req-1", player=1, mode="singleplayer")
    assert reg.get_result("req-1")["status"] == "confirmed"


def test_offers_persist_across_registry_instances_on_the_same_turn(tmp_path):
    reg = actions.ActionRegistry(journal_path=tmp_path / "journal.jsonl")
    gs, _ = open_session({"a": [ctx_reply(1), ctx_reply(1), reply(2, json.dumps(OFFERS)), ctx_reply(3)]})
    with gs:
        offers = reg.list_offers(gs, player=1, mode="singleplayer")
    pottery = next(o for o in offers["offers"] if o.get("typeKey") == "NODE_TECH_AQ_POTTERY")
    reg2 = actions.ActionRegistry(journal_path=tmp_path / "journal.jsonl")
    gs2, _ = open_session({"a": [ctx_reply(1), ctx_reply(1), reply(2, json.dumps(PERFORMED)), ctx_reply(3)]})
    with gs2:
        res = reg2.perform(gs2, action_id=pottery["actionId"], request_id="r-persist", player=1, mode="singleplayer")
    assert res["status"] == "confirmed"
    assert not list(tmp_path.glob("*.tmp"))


def test_skip_offers_map_to_public_kind_and_perform_confirms_on_readback(tmp_path):
    offers = {**OFFERS, "offers": OFFERS["offers"] + [{"kind": "SKIP_UNIT", "arg": 5, "unitTypeKey": "UNIT_SCOUT", "movesRemaining": 2, "canStart": True}]}
    performed = {"payloadVersion": 1, "refused": None, "context": CTX, "outcome": "sent", "readback": {"kind": "SKIP_UNIT", "arg": 5, "isReadyToMove": False, "matches": True}}
    reg = actions.ActionRegistry(journal_path=tmp_path / "journal.jsonl")
    gs, f = open_session({"a": [ctx_reply(1), ctx_reply(1), reply(2, json.dumps(offers)), ctx_reply(3), reply(4, json.dumps(performed)), ctx_reply(5)]})
    with gs:
        out = reg.list_offers(gs, player=1, mode="singleplayer")
        skip = next(o for o in out["offers"] if o["kind"] == "skip_unit")
        assert skip["unitTypeKey"] == "UNIT_SCOUT" and skip["movesRemaining"] == 2 and "arg" not in skip
        res = reg.perform(gs, action_id=skip["actionId"], request_id="skip-1", player=1, mode="singleplayer")
    assert res["status"] == "confirmed"
    sent = json.loads(f.all_sockets[1].sent[3])["params"]["expression"]
    assert '"SKIP_UNIT"' in sent and "OP_ARG" not in sent


def test_move_offers_expose_target_and_perform_passes_coordinates(tmp_path):
    offers = {**OFFERS, "offers": OFFERS["offers"] + [{"kind": "MOVE_UNIT", "arg": 5, "x": 11, "y": 10, "direction": 1, "unitTypeKey": "UNIT_SCOUT", "terrainKey": "TERRAIN_FLAT", "movesRemaining": 2, "canStart": True}]}
    performed = {"payloadVersion": 1, "refused": None, "context": CTX, "outcome": "sent", "readback": {"kind": "MOVE_UNIT", "arg": 5, "target": {"x": 11, "y": 10}, "location": {"x": 11, "y": 10}, "matches": True}}
    reg = actions.ActionRegistry(journal_path=tmp_path / "journal.jsonl")
    gs, f = open_session({"a": [ctx_reply(1), ctx_reply(1), reply(2, json.dumps(offers)), ctx_reply(3), reply(4, json.dumps(performed)), ctx_reply(5)]})
    with gs:
        out = reg.list_offers(gs, player=1, mode="singleplayer")
        mv = next(o for o in out["offers"] if o["kind"] == "move_unit")
        assert mv["to"] == {"x": 11, "y": 10} and mv["direction"] == 1 and mv["terrainKey"] == "TERRAIN_FLAT" and "arg" not in mv and "x" not in mv
        res = reg.perform(gs, action_id=mv["actionId"], request_id="mv-1", player=1, mode="singleplayer")
    assert res["status"] == "confirmed"
    sent = json.loads(f.all_sockets[1].sent[3])["params"]["expression"]
    assert '"MOVE_UNIT"' in sent and "const ARG2 = 11;" in sent and "const ARG3 = 10;" in sent and "OP_ARG" not in sent


def test_produce_offers_expose_city_and_unit_and_perform_passes_both(tmp_path):
    offers = {**OFFERS, "offers": OFFERS["offers"] + [{"kind": "PRODUCE_UNIT", "arg": 65536, "arg2": 100, "cityId": 65536, "cityName": "Athênai", "unitTypeKey": "UNIT_WARRIOR", "displayName": "Warrior", "canStart": True}]}
    performed = {"payloadVersion": 1, "refused": None, "context": CTX, "outcome": "sent", "readback": {"kind": "PRODUCE_UNIT", "arg": 65536, "unitType": 100, "observedType": 100, "matches": True}}
    reg = actions.ActionRegistry(journal_path=tmp_path / "journal.jsonl")
    gs, f = open_session({"a": [ctx_reply(1), ctx_reply(1), reply(2, json.dumps(offers)), ctx_reply(3), reply(4, json.dumps(performed)), ctx_reply(5)]})
    with gs:
        out = reg.list_offers(gs, player=1, mode="singleplayer")
        pr = next(o for o in out["offers"] if o["kind"] == "produce_unit")
        assert pr["cityName"] == "Athênai" and pr["unitTypeKey"] == "UNIT_WARRIOR" and "arg" not in pr and "arg2" not in pr
        res = reg.perform(gs, action_id=pr["actionId"], request_id="pr-1", player=1, mode="singleplayer")
    assert res["status"] == "confirmed"
    sent = json.loads(f.all_sockets[1].sent[3])["params"]["expression"]
    assert '"PRODUCE_UNIT"' in sent and "const ARG = 65536;" in sent and "const ARG2 = 100;" in sent
