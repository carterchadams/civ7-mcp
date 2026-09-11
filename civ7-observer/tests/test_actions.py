import json
from pathlib import Path

import pytest

from civ7_observer import actions, service

from test_targets import GAME, Factory, reply, target

CTX = {"turn": 12, "age": 4242, "playerId": 1, "localPlayerId": 1, "localObserverId": 1, "mode": "singleplayer", "isTurnActive": True, "curtainDisplayed": False, "gameGuid": "ABCDEF0123456789"}
RB = {"turn": 12, "age": 4242, "gameGuid": "ABCDEF0123456789", "localPlayerId": 1, "localObserverId": 1, "isTurnActive": True, "techResearching": 701, "civicResearching": -1, "hasSentTurnComplete": False, "unitsReadyToMove": [], "unitLocations": {}, "cityProduction": {}, "curtainDisplayed": False}
OFFERS = {"payloadVersion": 1, "refused": None, "context": CTX, "offers": [
    {"kind": "SET_TECH_TREE_NODE", "arg": 701, "pre": -1, "typeKey": "NODE_TECH_AQ_POTTERY", "displayName": "Pottery", "tree": "TREE_TECHS_AQ", "cost": 60, "turns": 4, "canStart": True},
    {"kind": "SET_TECH_TREE_NODE", "arg": 702, "pre": -1, "typeKey": "NODE_TECH_AQ_WRITING", "displayName": "Writing", "tree": "TREE_TECHS_AQ", "cost": 100, "turns": 7, "canStart": False},
    {"kind": "END_TURN", "arg": 0, "pre": 0, "canStart": True, "blockingType": None, "alreadySent": False},
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
    offers = {**OFFERS, "offers": OFFERS["offers"] + [{"kind": "SKIP_UNIT", "arg": 5, "pre": 2, "unitId": 5, "unitTypeKey": "UNIT_SCOUT", "movesRemaining": 2, "canStart": True}]}
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
    offers = {**OFFERS, "offers": OFFERS["offers"] + [{"kind": "MOVE_UNIT", "arg": 5, "x": 11, "y": 10, "pre": 1010, "unitId": 5, "from": {"x": 10, "y": 10}, "direction": 1, "unitTypeKey": "UNIT_SCOUT", "terrainKey": "TERRAIN_FLAT", "movesRemaining": 2, "canStart": True}]}
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
    offers = {**OFFERS, "offers": OFFERS["offers"] + [{"kind": "PRODUCE_UNIT", "arg": 65536, "arg2": 100, "pre": -1, "cityId": 65536, "cityName": "Athênai", "unitTypeKey": "UNIT_WARRIOR", "displayName": "Warrior", "canStart": True}]}
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


# ---- preliminary action-layer review

def test_offers_from_another_match_are_refused_even_with_same_seat_turn_age(tmp_path):
    reg = actions.ActionRegistry(journal_path=tmp_path / "journal.jsonl")
    gs, _ = open_session({"a": [ctx_reply(1), ctx_reply(1), reply(2, json.dumps(OFFERS)), ctx_reply(3)]})
    with gs:
        offers = reg.list_offers(gs, player=1, mode="singleplayer")
    other = {**GAME, "gameGuid": "FFFF000011112222"}
    gs2, f2 = open_session({"a": [reply(1, json.dumps(other)), reply(1, json.dumps(other))]})
    with gs2, pytest.raises(service.ObserverError) as ei:
        reg.perform(gs2, action_id=offers["offers"][0]["actionId"], request_id="x-match", player=1, mode="singleplayer")
    assert ei.value.code == "ACTION_EXPIRED"
    assert not any("sendRequest" in m for sock in f2.all_sockets for m in sock.sent)


def test_rendered_perform_carries_match_guid_and_precondition(tmp_path):
    reg = actions.ActionRegistry(journal_path=tmp_path / "journal.jsonl")
    gs, f = open_session({"a": [ctx_reply(1), ctx_reply(1), reply(2, json.dumps(OFFERS)), ctx_reply(3), reply(4, json.dumps(PERFORMED)), ctx_reply(5)]})
    with gs:
        offers = reg.list_offers(gs, player=1, mode="singleplayer")
        pottery = next(o for o in offers["offers"] if o.get("typeKey") == "NODE_TECH_AQ_POTTERY")
        reg.perform(gs, action_id=pottery["actionId"], request_id="pre-1", player=1, mode="singleplayer")
    sent = json.loads(f.all_sockets[1].sent[3])["params"]["expression"]
    assert 'const EXPECTED_MATCH = "ABCDEF0123456789";' in sent and "const PRE = -1;" in sent
    assert "EXPECTED_GUID" not in sent and "OP_PRE" not in sent


def test_end_turn_readback_with_nulls_is_not_confirmation(tmp_path):
    reg = actions.ActionRegistry(journal_path=tmp_path / "journal.jsonl")
    sent_no_progress = {"payloadVersion": 1, "refused": None, "context": CTX, "outcome": "sent", "readback": {"kind": "END_TURN", "arg": 0, "sentComplete": False}}
    nulls = {**RB, "turn": None, "localPlayerId": None, "hasSentTurnComplete": None, "gameGuid": None}
    scripts = {"a": [ctx_reply(1), ctx_reply(1), reply(2, json.dumps(OFFERS)), ctx_reply(3), reply(4, json.dumps(sent_no_progress))] + [reply(5 + i, json.dumps(nulls)) for i in range(actions.READBACK_ATTEMPTS)]}
    gs, _ = open_session(scripts)
    with gs:
        offers = reg.list_offers(gs, player=1, mode="singleplayer")
        end = next(o for o in offers["offers"] if o["kind"] == "end_turn")
        with pytest.raises(service.ObserverError) as ei:
            reg.perform(gs, action_id=end["actionId"], request_id="et-null", player=1, mode="singleplayer")
    assert ei.value.code == "ACTION_OUTCOME_UNKNOWN"


def test_end_turn_confirms_only_on_positively_identified_progression(tmp_path):
    reg = actions.ActionRegistry(journal_path=tmp_path / "journal.jsonl")
    sent_no_progress = {"payloadVersion": 1, "refused": None, "context": CTX, "outcome": "sent", "readback": {"kind": "END_TURN", "arg": 0, "sentComplete": False}}
    other_seat = {**RB, "localPlayerId": 0, "localObserverId": 0, "isTurnActive": False}
    scripts = {"a": [ctx_reply(1), ctx_reply(1), reply(2, json.dumps(OFFERS)), ctx_reply(3), reply(4, json.dumps(sent_no_progress)), reply(5, json.dumps(other_seat))]}
    gs, _ = open_session(scripts)
    with gs:
        offers = reg.list_offers(gs, player=1, mode="singleplayer")
        end = next(o for o in offers["offers"] if o["kind"] == "end_turn")
        res = reg.perform(gs, action_id=end["actionId"], request_id="et-ok", player=1, mode="singleplayer")
    assert res["status"] == "confirmed"
    assert res["confirmedBy"]["localPlayerId"] == 0 and res["confirmedBy"]["gameGuid"] == "ABCDEF0123456789"


def test_readback_from_a_different_match_never_confirms(tmp_path):
    reg = actions.ActionRegistry(journal_path=tmp_path / "journal.jsonl")
    sent_no_match = {"payloadVersion": 1, "refused": None, "context": CTX, "outcome": "sent", "readback": {"kind": "SET_TECH_TREE_NODE", "arg": 701, "observedType": -1, "matches": False}}
    wrong_match = {**RB, "gameGuid": "FFFF000011112222", "techResearching": 701}
    scripts = {"a": [ctx_reply(1), ctx_reply(1), reply(2, json.dumps(OFFERS)), ctx_reply(3), reply(4, json.dumps(sent_no_match))] + [reply(5 + i, json.dumps(wrong_match)) for i in range(actions.READBACK_ATTEMPTS)]}
    gs, _ = open_session(scripts)
    with gs:
        offers = reg.list_offers(gs, player=1, mode="singleplayer")
        pottery = next(o for o in offers["offers"] if o.get("typeKey") == "NODE_TECH_AQ_POTTERY")
        with pytest.raises(service.ObserverError) as ei:
            reg.perform(gs, action_id=pottery["actionId"], request_id="rb-match", player=1, mode="singleplayer")
    assert ei.value.code == "ACTION_OUTCOME_UNKNOWN"


@pytest.mark.parametrize("bad", ["not-json", json.dumps({"payloadVersion": 1, "refused": None, "context": None, "outcome": None, "readback": None}), json.dumps([1, 2])])
def test_malformed_mutation_response_is_unknown_not_rejected(tmp_path, bad):
    reg = actions.ActionRegistry(journal_path=tmp_path / "journal.jsonl")
    gs, _ = open_session({"a": [ctx_reply(1), ctx_reply(1), reply(2, json.dumps(OFFERS)), ctx_reply(3), reply(4, bad)]})
    with gs:
        offers = reg.list_offers(gs, player=1, mode="singleplayer")
        pottery = next(o for o in offers["offers"] if o.get("typeKey") == "NODE_TECH_AQ_POTTERY")
        with pytest.raises(service.ObserverError) as ei:
            reg.perform(gs, action_id=pottery["actionId"], request_id="bad-1", player=1, mode="singleplayer")
    assert ei.value.code == "ACTION_OUTCOME_UNKNOWN"
    assert reg.needs_reconciliation() == ["bad-1"]


def test_crash_recovery_keeps_full_identity_and_allows_identical_retry_after_reconcile(tmp_path):
    reg = actions.ActionRegistry(journal_path=tmp_path / "journal.jsonl")
    gs, _ = open_session({"a": [ctx_reply(1), ctx_reply(1), reply(2, json.dumps(OFFERS)), ctx_reply(3)]})
    with gs:
        offers = reg.list_offers(gs, player=1, mode="singleplayer")
    pottery = next(o for o in offers["offers"] if o.get("typeKey") == "NODE_TECH_AQ_POTTERY")
    # simulate a crash after the pending row was written
    with open(tmp_path / "journal.jsonl", "a") as fh:
        fh.write(json.dumps({"requestId": "crash-1", "actionId": pottery["actionId"], "kind": "SET_TECH_TREE_NODE", "arg": 701, "arg2": 0, "arg3": 0, "pre": -1, "seat": 1, "turn": 12, "age": 4242, "match": "ABCDEF0123456789", "status": "pending", "at": "t"}) + "\n")
    reg2 = actions.ActionRegistry(journal_path=tmp_path / "journal.jsonl")
    rec = reg2.get_result("crash-1")
    assert rec["status"] == "unknown" and rec["actionId"] == pottery["actionId"] and rec["kind"] == "SET_TECH_TREE_NODE" and rec["arg"] == 701 and rec["match"] == "ABCDEF0123456789"
    reg2.reconcile("crash-1", "confirmed", note="human checked the research panel")
    gs2, f2 = open_session({"a": [ctx_reply(1), ctx_reply(1)]})
    with gs2:
        again = reg2.perform(gs2, action_id=pottery["actionId"], request_id="crash-1", player=1, mode="singleplayer")
    assert again["status"] == "confirmed" and again["reconciled"] is True
    assert not any("sendRequest" in m for sock in f2.all_sockets for m in sock.sent)


def test_concurrent_registries_cannot_both_dispatch_the_same_request(tmp_path):
    import threading
    reg_a = actions.ActionRegistry(journal_path=tmp_path / "journal.jsonl")
    gs, _ = open_session({"a": [ctx_reply(1), ctx_reply(1), reply(2, json.dumps(OFFERS)), ctx_reply(3)]})
    with gs:
        offers = reg_a.list_offers(gs, player=1, mode="singleplayer")
    pottery = next(o for o in offers["offers"] if o.get("typeKey") == "NODE_TECH_AQ_POTTERY")
    reg_b = actions.ActionRegistry(journal_path=tmp_path / "journal.jsonl")
    results, sends = {}, []

    def run(name, reg):
        s, f = open_session({"a": [ctx_reply(1), ctx_reply(1), reply(2, json.dumps(PERFORMED)), ctx_reply(3)]})
        with s:
            try:
                results[name] = reg.perform(s, action_id=pottery["actionId"], request_id="dup-1", player=1, mode="singleplayer")
            except service.ObserverError as exc:
                results[name] = {"error": exc.code}
        sends.extend(m for sock in f.all_sockets for m in sock.sent if "sendRequest" in m)

    ta, tb = threading.Thread(target=run, args=("a", reg_a)), threading.Thread(target=run, args=("b", reg_b))
    ta.start(); tb.start(); ta.join(); tb.join()
    assert len(sends) == 1, "the mutation payload must be dispatched exactly once"
    assert all(r.get("status") == "confirmed" for r in results.values()), results
    lines = [json.loads(l) for l in (tmp_path / "journal.jsonl").read_text().splitlines()]
    assert sum(1 for l in lines if l["status"] == "pending") == 1


def test_unit_offers_carry_unit_identity_and_source_location(tmp_path):
    offers = {**OFFERS, "offers": OFFERS["offers"] + [
        {"kind": "MOVE_UNIT", "arg": 5, "arg2": 11, "arg3": 10, "pre": 1010, "unitId": 5, "from": {"x": 10, "y": 10}, "x": 11, "y": 10, "direction": 1, "unitTypeKey": "UNIT_SCOUT", "terrainKey": "TERRAIN_FLAT", "pathTurns": 1, "movesRemaining": 2, "canStart": True},
        {"kind": "SKIP_UNIT", "arg": 6, "pre": 2, "unitId": 6, "from": {"x": 10, "y": 10}, "unitTypeKey": "UNIT_SCOUT", "movesRemaining": 2, "canStart": True},
    ]}
    reg = actions.ActionRegistry(journal_path=tmp_path / "journal.jsonl")
    gs, _ = open_session({"a": [ctx_reply(1), ctx_reply(1), reply(2, json.dumps(offers)), ctx_reply(3)]})
    with gs:
        out = reg.list_offers(gs, player=1, mode="singleplayer")
    mv = next(o for o in out["offers"] if o["kind"] == "move_unit")
    sk = next(o for o in out["offers"] if o["kind"] == "skip_unit")
    assert mv["unitId"] == 5 and mv["from"] == {"x": 10, "y": 10} and mv["to"] == {"x": 11, "y": 10}
    assert sk["unitId"] == 6 and sk["from"] == {"x": 10, "y": 10}
    assert "arg" not in mv and "pre" not in mv


# ---- action-layer fix review

def test_unknown_outcome_in_one_journal_blocks_actions_from_another_journal_on_the_same_game(tmp_path):
    import websocket
    reg_a = actions.ActionRegistry(journal_path=tmp_path / "seat1.jsonl")
    gs, _ = open_session({"a": [ctx_reply(1), ctx_reply(1), reply(2, json.dumps(OFFERS)), ctx_reply(3), websocket.WebSocketConnectionClosedException()]})
    with gs:
        offers = reg_a.list_offers(gs, player=1, mode="singleplayer")
        end = next(o for o in offers["offers"] if o["kind"] == "end_turn")
        with pytest.raises(service.ObserverError):
            reg_a.perform(gs, action_id=end["actionId"], request_id="a-unknown", player=1, mode="singleplayer")
    reg_b = actions.ActionRegistry(journal_path=tmp_path / "seat0.jsonl")
    gs2, f2 = open_session({"a": [ctx_reply(1), ctx_reply(1), reply(2, json.dumps(OFFERS)), ctx_reply(3)]})
    with gs2:
        out = reg_b.list_offers(gs2, player=1, mode="singleplayer")
        assert out["reconciliationRequired"] == ["a-unknown"]
        with pytest.raises(service.ObserverError) as ei:
            reg_b.perform(gs2, action_id=out["offers"][0]["actionId"], request_id="b-1", player=1, mode="singleplayer")
    assert ei.value.code == "RECONCILIATION_REQUIRED"
    assert not any("sendRequest" in m for sock in f2.all_sockets for m in sock.sent)
    reg_a.reconcile("a-unknown", "rejected", note="verified")
    assert reg_b.needs_reconciliation() == []


def test_dispatch_is_serialized_across_journals_by_the_game_lock(tmp_path):
    import threading, time
    order, errors = [], []
    reg_a = actions.ActionRegistry(journal_path=tmp_path / "seat1.jsonl")
    reg_b = actions.ActionRegistry(journal_path=tmp_path / "seat0.jsonl")

    END_PERFORMED = {"payloadVersion": 1, "refused": None, "context": CTX, "outcome": "sent", "readback": {"kind": "END_TURN", "arg": 0, "sentComplete": True}}

    def run(tag, reg, kind_key, rid):
        try:
            done = END_PERFORMED if kind_key == "end_turn" else PERFORMED
            s, f = open_session({"a": [ctx_reply(1), ctx_reply(1), reply(2, json.dumps(OFFERS)), ctx_reply(3), reply(4, json.dumps(done)), ctx_reply(5)]})
            with s:
                offers = reg.list_offers(s, player=1, mode="singleplayer")
                action_id = next(o["actionId"] for o in offers["offers"] if o.get("typeKey", o["kind"]) == kind_key)
                sock = f.all_sockets[-1]
                original = sock.recv

                def recv():
                    item = original()
                    if isinstance(item, str) and "outcome" in item and "sent" in item and "readback" in item:
                        order.append(f"{tag}-dispatch"); time.sleep(0.3); order.append(f"{tag}-done")
                    return item
                sock.recv = recv
                reg.perform(s, action_id=action_id, request_id=rid, player=1, mode="singleplayer")
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{tag}: {exc!r}")

    ta = threading.Thread(target=run, args=("a", reg_a, "NODE_TECH_AQ_POTTERY", "a-1"))
    tb = threading.Thread(target=run, args=("b", reg_b, "end_turn", "b-1"))
    ta.start(); time.sleep(0.05); tb.start(); ta.join(); tb.join()
    assert errors == [], errors
    assert order in (["a-dispatch", "a-done", "b-dispatch", "b-done"], ["b-dispatch", "b-done", "a-dispatch", "a-done"]), order


def test_turn_regression_bumps_generation_and_expires_offers(tmp_path):
    reg = actions.ActionRegistry(journal_path=tmp_path / "journal.jsonl")
    gs, _ = open_session({"a": [ctx_reply(1), ctx_reply(1), reply(2, json.dumps(OFFERS)), ctx_reply(3)]})
    with gs:
        offers = reg.list_offers(gs, player=1, mode="singleplayer")
    gen0 = offers["generation"]
    earlier = {**GAME, "turn": 11}
    gs2, _ = open_session({"a": [reply(1, json.dumps(earlier)), reply(1, json.dumps(earlier)), reply(2, json.dumps({**OFFERS, "context": {**CTX, "turn": 11}})), reply(3, json.dumps(earlier))]})
    with gs2:
        offers2 = reg.list_offers(gs2, player=1, mode="singleplayer")
    assert offers2["generation"] == gen0 + 1
    assert offers2["reattached"] is True
    # back at turn 12 (same as the original offers): the old offers must still be dead
    gs3, f3 = open_session({"a": [ctx_reply(1), ctx_reply(1)]})
    with gs3, pytest.raises(service.ObserverError) as ei:
        reg.perform(gs3, action_id=offers["offers"][0]["actionId"], request_id="gen-1", player=1, mode="singleplayer")
    assert ei.value.code in ("ACTION_EXPIRED", "UNKNOWN_ACTION")   # pruned or generation-mismatched: never dispatched
    assert not any("sendRequest" in m for sock in f3.all_sockets for m in sock.sent)


def test_generation_is_recorded_in_journal_rows(tmp_path):
    reg = actions.ActionRegistry(journal_path=tmp_path / "journal.jsonl")
    gs, _ = open_session({"a": [ctx_reply(1), ctx_reply(1), reply(2, json.dumps(OFFERS)), ctx_reply(3), reply(4, json.dumps(PERFORMED)), ctx_reply(5)]})
    with gs:
        offers = reg.list_offers(gs, player=1, mode="singleplayer")
        pottery = next(o for o in offers["offers"] if o.get("typeKey") == "NODE_TECH_AQ_POTTERY")
        res = reg.perform(gs, action_id=pottery["actionId"], request_id="g-1", player=1, mode="singleplayer")
    assert res["generation"] == offers["generation"]


@pytest.mark.parametrize("field, value", [("age", 999), ("localObserverId", 0)])
def test_poll_confirmation_requires_the_originating_age_and_observer(tmp_path, field, value):
    reg = actions.ActionRegistry(journal_path=tmp_path / "journal.jsonl")
    sent_no_match = {"payloadVersion": 1, "refused": None, "context": CTX, "outcome": "sent", "readback": {"kind": "SET_TECH_TREE_NODE", "arg": 701, "observedType": -1, "matches": False}}
    rb = {**RB, "techResearching": 701, field: value}
    scripts = {"a": [ctx_reply(1), ctx_reply(1), reply(2, json.dumps(OFFERS)), ctx_reply(3), reply(4, json.dumps(sent_no_match))] + [reply(5 + i, json.dumps(rb)) for i in range(actions.READBACK_ATTEMPTS)]}
    gs, _ = open_session(scripts)
    with gs:
        offers = reg.list_offers(gs, player=1, mode="singleplayer")
        pottery = next(o for o in offers["offers"] if o.get("typeKey") == "NODE_TECH_AQ_POTTERY")
        with pytest.raises(service.ObserverError) as ei:
            reg.perform(gs, action_id=pottery["actionId"], request_id=f"ctx-{field}", player=1, mode="singleplayer")
    assert ei.value.code == "ACTION_OUTCOME_UNKNOWN"


def test_confirming_poll_records_the_relevant_effect(tmp_path):
    reg = actions.ActionRegistry(journal_path=tmp_path / "journal.jsonl")
    sent_no_match = {"payloadVersion": 1, "refused": None, "context": CTX, "outcome": "sent", "readback": {"kind": "SET_TECH_TREE_NODE", "arg": 701, "observedType": -1, "matches": False}}
    rb = {**RB, "techResearching": 701, "unitLocations": {"5": [1, 1]}, "cityProduction": {"65536": 9}}
    scripts = {"a": [ctx_reply(1), ctx_reply(1), reply(2, json.dumps(OFFERS)), ctx_reply(3), reply(4, json.dumps(sent_no_match)), reply(5, json.dumps(rb))]}
    gs, _ = open_session(scripts)
    with gs:
        offers = reg.list_offers(gs, player=1, mode="singleplayer")
        pottery = next(o for o in offers["offers"] if o.get("typeKey") == "NODE_TECH_AQ_POTTERY")
        res = reg.perform(gs, action_id=pottery["actionId"], request_id="eff-1", player=1, mode="singleplayer")
    cb = res["confirmedBy"]
    assert cb["source"] == "poll" and cb["effect"] == {"techResearching": 701}
    assert "unitLocations" not in cb and "cityProduction" not in cb


# ---- project-wide review: durable game-wide in-flight reservation before dispatch

def test_crash_after_dispatch_is_visible_to_another_seat_without_reopening_the_first_journal(tmp_path):
    """Journal A holds a pending row (process died after sending). Registry B, on another journal,
    must see an unresolved write before it ever reloads A."""
    reg_a = actions.ActionRegistry(journal_path=tmp_path / "seat1.jsonl")
    gs, _ = open_session({"a": [ctx_reply(1), ctx_reply(1), reply(2, json.dumps(OFFERS)), ctx_reply(3)]})
    with gs:
        offers = reg_a.list_offers(gs, player=1, mode="singleplayer")
    pottery = next(o for o in offers["offers"] if o.get("typeKey") == "NODE_TECH_AQ_POTTERY")
    # simulate: reservation + pending row written, then the process dies before any outcome
    with open(tmp_path / "seat1.jsonl", "a") as fh:
        fh.write(json.dumps({"requestId": "crash-a", "actionId": pottery["actionId"], "kind": "SET_TECH_TREE_NODE", "arg": 701, "arg2": 0, "arg3": 0, "pre": -1, "seat": 1, "turn": 12, "age": 4242, "match": "ABCDEF0123456789", "generation": 1, "status": "pending", "at": "t"}) + "\n")
    reg_a._reserve_inflight({"requestId": "crash-a", "actionId": pottery["actionId"], "kind": "SET_TECH_TREE_NODE", "seat": 1, "match": "ABCDEF0123456789", "generation": 1, "journal": str(tmp_path / "seat1.jsonl")})
    reg_b = actions.ActionRegistry(journal_path=tmp_path / "seat0.jsonl")
    gs2, f2 = open_session({"a": [ctx_reply(1), ctx_reply(1), reply(2, json.dumps(OFFERS)), ctx_reply(3)]})
    with gs2:
        out = reg_b.list_offers(gs2, player=1, mode="singleplayer")
        assert out["reconciliationRequired"] == ["crash-a"]
        with pytest.raises(service.ObserverError) as ei:
            reg_b.perform(gs2, action_id=out["offers"][0]["actionId"], request_id="b-1", player=1, mode="singleplayer")
    assert ei.value.code == "RECONCILIATION_REQUIRED"
    assert not any("sendRequest" in m for sock in f2.all_sockets for m in sock.sent)


def test_inflight_reservation_is_written_before_dispatch_and_cleared_after(tmp_path):
    reg = actions.ActionRegistry(journal_path=tmp_path / "journal.jsonl")
    seen = {}
    gs, f = open_session({"a": [ctx_reply(1), ctx_reply(1), reply(2, json.dumps(OFFERS)), ctx_reply(3), reply(4, json.dumps(PERFORMED)), ctx_reply(5)]})
    with gs:
        offers = reg.list_offers(gs, player=1, mode="singleplayer")
        pottery = next(o for o in offers["offers"] if o.get("typeKey") == "NODE_TECH_AQ_POTTERY")
        sock = f.all_sockets[-1]
        original = sock.send

        def send(data):
            if "sendRequest" in data:
                seen["inflight_at_dispatch"] = json.loads(reg.inflight_path.read_text()) if reg.inflight_path.exists() else {}
            return original(data)
        sock.send = send
        reg.perform(gs, action_id=pottery["actionId"], request_id="res-1", player=1, mode="singleplayer")
    assert "res-1" in seen["inflight_at_dispatch"], "the game-wide reservation must exist on disk before the mutation is sent"
    assert seen["inflight_at_dispatch"]["res-1"]["seat"] == 1 and seen["inflight_at_dispatch"]["res-1"]["match"] == "ABCDEF0123456789"
    after = json.loads(reg.inflight_path.read_text()) if reg.inflight_path.exists() else {}
    assert "res-1" not in after


def test_corrupt_shared_state_pauses_instead_of_clearing_the_barrier(tmp_path):
    reg = actions.ActionRegistry(journal_path=tmp_path / "journal.jsonl")
    gs, _ = open_session({"a": [ctx_reply(1), ctx_reply(1), reply(2, json.dumps(OFFERS)), ctx_reply(3)]})
    with gs:
        offers = reg.list_offers(gs, player=1, mode="singleplayer")
    reg.inflight_path.write_text("{not json")
    gs2, f2 = open_session({"a": [ctx_reply(1), ctx_reply(1)]})
    with gs2, pytest.raises(service.ObserverError) as ei:
        reg.perform(gs2, action_id=offers["offers"][0]["actionId"], request_id="c-1", player=1, mode="singleplayer")
    assert ei.value.code == "STATE_CORRUPT"
    assert not any("sendRequest" in m for sock in f2.all_sockets for m in sock.sent)


def test_recovery_writes_happen_only_under_the_game_lock(tmp_path, monkeypatch):
    """Constructing a registry over a journal with a pending row must not write shared state
    outside the lock; the conversion to unknown happens on the next locked operation."""
    (tmp_path / "journal.jsonl").write_text(json.dumps({"requestId": "p-1", "actionId": "x" * 24, "kind": "END_TURN", "arg": 0, "arg2": 0, "arg3": 0, "pre": 0, "seat": 1, "turn": 12, "age": 4242, "match": "ABCDEF0123456789", "generation": 1, "status": "pending", "at": "t"}) + "\n")
    writes = []
    original = actions.write_atomic

    def spy(path, text):
        writes.append(str(path))
        return original(path, text)
    monkeypatch.setattr(actions, "write_atomic", spy)
    reg = actions.ActionRegistry(journal_path=tmp_path / "journal.jsonl")
    assert writes == [], f"constructor wrote shared state outside the lock: {writes}"
    assert reg.needs_reconciliation() == ["p-1"]


# ---- project-wide review: durable in-flight reservation, corrupt state, rebind

def test_pending_write_in_one_journal_blocks_another_journal_without_reopening_the_first(tmp_path):
    """Crash window: registry A died after reserving/sending; B must see the uncertain write immediately."""
    reg_a = actions.ActionRegistry(journal_path=tmp_path / "seat1.jsonl")
    gs, _ = open_session({"a": [ctx_reply(1), ctx_reply(1), reply(2, json.dumps(OFFERS)), ctx_reply(3)]})
    with gs:
        offers = reg_a.list_offers(gs, player=1, mode="singleplayer")
    pottery = next(o for o in offers["offers"] if o.get("typeKey") == "NODE_TECH_AQ_POTTERY")
    # simulate A dying right after the reservation + pending row (before any outcome row)
    with reg_a._locked():
        reg_a._reserve_and_journal(reg_a._base(pottery["actionId"], "a-dead", 1))
    reg_b = actions.ActionRegistry(journal_path=tmp_path / "seat0.jsonl")
    gs2, f2 = open_session({"a": [ctx_reply(1), ctx_reply(1), reply(2, json.dumps(OFFERS)), ctx_reply(3)]})
    with gs2:
        out = reg_b.list_offers(gs2, player=1, mode="singleplayer")
        assert out["reconciliationRequired"] == ["a-dead"]
        with pytest.raises(service.ObserverError) as ei:
            reg_b.perform(gs2, action_id=out["offers"][0]["actionId"], request_id="b-1", player=1, mode="singleplayer")
    assert ei.value.code == "RECONCILIATION_REQUIRED"
    assert not any("sendRequest" in m for sock in f2.all_sockets for m in sock.sent)
    rec = reg_b.get_result("a-dead")
    assert rec is not None and rec["status"] == "unknown" and rec["actionId"] == pottery["actionId"] and rec["seat"] == 1


def test_corrupt_shared_state_pauses_instead_of_clearing_the_barrier(tmp_path):
    reg = actions.ActionRegistry(journal_path=tmp_path / "journal.jsonl")
    gs, _ = open_session({"a": [ctx_reply(1), ctx_reply(1), reply(2, json.dumps(OFFERS)), ctx_reply(3)]})
    with gs:
        offers = reg.list_offers(gs, player=1, mode="singleplayer")
    reg.inflight_path.write_text("{not json")
    gs2, f2 = open_session({"a": [ctx_reply(1), ctx_reply(1)]})
    with gs2, pytest.raises(service.ObserverError) as ei:
        reg.perform(gs2, action_id=offers["offers"][0]["actionId"], request_id="c-1", player=1, mode="singleplayer")
    assert ei.value.code == "STATE_CORRUPT"
    assert not any("sendRequest" in m for sock in f2.all_sockets for m in sock.sent)


def test_recovery_writes_happen_only_under_the_game_lock(tmp_path, monkeypatch):
    """Constructing a registry over a journal with a pending row must not write shared state
    outside the lock; the conversion to unknown happens on the next locked operation."""
    (tmp_path / "journal.jsonl").write_text(json.dumps({"requestId": "p-1", "actionId": "x" * 24, "kind": "END_TURN", "arg": 0, "arg2": 0, "arg3": 0, "pre": 0, "seat": 1, "turn": 12, "age": 4242, "match": "ABCDEF0123456789", "generation": 1, "status": "pending", "at": "t"}) + "\n")
    writes = []
    original = actions.write_atomic

    def spy(path, text):
        writes.append(str(path))
        return original(path, text)
    monkeypatch.setattr(actions, "write_atomic", spy)
    reg = actions.ActionRegistry(journal_path=tmp_path / "journal.jsonl")
    assert writes == [], f"constructor wrote shared state outside the lock: {writes}"
    assert reg.needs_reconciliation() == ["p-1"]


# ---- project-wide review: durable in-flight reservation, corrupt state, rebind

def test_pending_write_in_one_journal_blocks_another_journal_without_reopening_the_first(tmp_path):
    """Crash window: registry A died after reserving/sending; B must see the uncertain write immediately."""
    reg_a = actions.ActionRegistry(journal_path=tmp_path / "seat1.jsonl")
    gs, _ = open_session({"a": [ctx_reply(1), ctx_reply(1), reply(2, json.dumps(OFFERS)), ctx_reply(3)]})
    with gs:
        offers = reg_a.list_offers(gs, player=1, mode="singleplayer")
    pottery = next(o for o in offers["offers"] if o.get("typeKey") == "NODE_TECH_AQ_POTTERY")
    # simulate A dying right after the reservation + pending row (before any outcome row)
    with reg_a._locked():
        reg_a._reserve_and_journal(reg_a._base(pottery["actionId"], "a-dead", 1))
    reg_b = actions.ActionRegistry(journal_path=tmp_path / "seat0.jsonl")
    gs2, f2 = open_session({"a": [ctx_reply(1), ctx_reply(1), reply(2, json.dumps(OFFERS)), ctx_reply(3)]})
    with gs2:
        out = reg_b.list_offers(gs2, player=1, mode="singleplayer")
        assert out["reconciliationRequired"] == ["a-dead"]
        with pytest.raises(service.ObserverError) as ei:
            reg_b.perform(gs2, action_id=out["offers"][0]["actionId"], request_id="b-1", player=1, mode="singleplayer")
    assert ei.value.code == "RECONCILIATION_REQUIRED"
    assert not any("sendRequest" in m for sock in f2.all_sockets for m in sock.sent)
    rec = reg_b.get_result("a-dead")
    assert rec is not None and rec["status"] == "unknown" and rec["actionId"] == pottery["actionId"] and rec["seat"] == 1


def test_reservation_is_written_before_dispatch_and_cleared_after(tmp_path):
    reg = actions.ActionRegistry(journal_path=tmp_path / "journal.jsonl")
    seen = {}
    gs, f = open_session({"a": [ctx_reply(1), ctx_reply(1), reply(2, json.dumps(OFFERS)), ctx_reply(3), reply(4, json.dumps(PERFORMED)), ctx_reply(5)]})
    with gs:
        offers = reg.list_offers(gs, player=1, mode="singleplayer")
        pottery = next(o for o in offers["offers"] if o.get("typeKey") == "NODE_TECH_AQ_POTTERY")
        sock = f.all_sockets[-1]
        original_send = sock.send

        def send(data):
            if "sendRequest" in data or "sendTurnComplete" in data:
                seen["inflight_at_send"] = json.loads(reg.inflight_path.read_text()) if reg.inflight_path.exists() else {}
            original_send(data)
        sock.send = send
        reg.perform(gs, action_id=pottery["actionId"], request_id="res-1", player=1, mode="singleplayer")
    assert "res-1" in seen["inflight_at_send"], "the reservation must be durable before the mutation is dispatched"
    assert seen["inflight_at_send"]["res-1"]["kind"] == "SET_TECH_TREE_NODE" and seen["inflight_at_send"]["res-1"]["seat"] == 1
    after = json.loads(reg.inflight_path.read_text()) if reg.inflight_path.exists() else {}
    assert "res-1" not in after


def test_corrupt_shared_state_pauses_instead_of_clearing_the_barrier(tmp_path):
    reg = actions.ActionRegistry(journal_path=tmp_path / "journal.jsonl")
    reg.state_dir.mkdir(parents=True, exist_ok=True)
    reg.unresolved_path.write_text("{not json")
    gs, f = open_session({"a": [ctx_reply(1), ctx_reply(1)]})
    with gs, pytest.raises(service.ObserverError) as ei:
        reg.list_offers(gs, player=1, mode="singleplayer")
    assert ei.value.code == "STATE_CORRUPT"
    assert not any("sendRequest" in m for sock in f.all_sockets for m in sock.sent)


def test_explicit_rebind_bumps_generation_and_expires_offers(tmp_path):
    reg = actions.ActionRegistry(journal_path=tmp_path / "journal.jsonl")
    gs, _ = open_session({"a": [ctx_reply(1), ctx_reply(1), reply(2, json.dumps(OFFERS)), ctx_reply(3)]})
    with gs:
        offers = reg.list_offers(gs, player=1, mode="singleplayer")
    gen0 = offers["generation"]
    new_gen = reg.rebind(match="ABCDEF0123456789", note="human loaded a save at the same turn")
    assert new_gen == gen0 + 1
    gs2, f2 = open_session({"a": [ctx_reply(1), ctx_reply(1)]})
    with gs2, pytest.raises(service.ObserverError) as ei:
        reg.perform(gs2, action_id=offers["offers"][0]["actionId"], request_id="rb-1", player=1, mode="singleplayer")
    assert ei.value.code in ("ACTION_EXPIRED", "UNKNOWN_ACTION")
    assert not any("sendRequest" in m for sock in f2.all_sockets for m in sock.sent)


def test_attachment_is_reported_with_offers(tmp_path):
    reg = actions.ActionRegistry(journal_path=tmp_path / "journal.jsonl")
    gs, _ = open_session({"a": [ctx_reply(1), ctx_reply(1), reply(2, json.dumps(OFFERS)), ctx_reply(3)]})
    with gs:
        offers = reg.list_offers(gs, player=1, mode="singleplayer")
    assert offers["attachment"] == {"match": "ABCDEF0123456789", "generation": offers["generation"], "seat": 1, "turn": 12, "age": 4242}


# ---- scenario test: the whole lifecycle in one sequence, asserting the invariants

def test_scenario_observe_offer_act_crash_other_seat_recover(tmp_path):
    """observe -> offer -> dispatch -> crash -> another seat blocked -> reconcile -> resume.

    Invariants asserted throughout: no dispatch while any write is unresolved; no
    stale-generation mutation; a duplicate request never repeats a write.
    """
    import websocket
    seat1 = actions.ActionRegistry(journal_path=tmp_path / "seat1.jsonl")
    seat0 = actions.ActionRegistry(journal_path=tmp_path / "seat0.jsonl")

    def dispatched(factory):
        return [m for sock in factory.all_sockets for m in sock.sent if "sendRequest" in m or "sendTurnComplete" in m]

    # 1. seat 1 lists offers and dispatches; the connection dies before an outcome is known
    gs, f1 = open_session({"a": [ctx_reply(1), ctx_reply(1), reply(2, json.dumps(OFFERS)), ctx_reply(3), websocket.WebSocketConnectionClosedException()]})
    with gs:
        offers = seat1.list_offers(gs, player=1, mode="singleplayer")
        assert offers["reconciliationRequired"] == []
        pottery = next(o for o in offers["offers"] if o.get("typeKey") == "NODE_TECH_AQ_POTTERY")
        with pytest.raises(service.ObserverError) as ei:
            seat1.perform(gs, action_id=pottery["actionId"], request_id="s-1", player=1, mode="singleplayer")
    assert ei.value.code == "ACTION_OUTCOME_UNKNOWN"

    # 2. a different seat's registry, never having opened seat 1's journal, is blocked
    fresh = actions.ActionRegistry(journal_path=tmp_path / "seat0.jsonl")
    gs2, f2 = open_session({"a": [ctx_reply(1), ctx_reply(1), reply(2, json.dumps(OFFERS)), ctx_reply(3)]})
    with gs2:
        out = fresh.list_offers(gs2, player=1, mode="singleplayer")
        assert "s-1" in out["reconciliationRequired"]
        with pytest.raises(service.ObserverError) as e2:
            fresh.perform(gs2, action_id=out["offers"][0]["actionId"], request_id="s-2", player=1, mode="singleplayer")
    assert e2.value.code == "RECONCILIATION_REQUIRED"
    assert dispatched(f2) == [], "no dispatch while any write is unresolved"

    # 3. the human verifies and reconciles; the barrier clears for every seat
    fresh.reconcile("s-1", "rejected", note="human checked the research panel: unchanged")
    assert fresh.needs_reconciliation() == [] and seat0.needs_reconciliation() == []

    # 4. a save is loaded that the game cannot signal: explicit rebind kills old offers
    seat1.rebind(match="ABCDEF0123456789", note="loaded an alternate save at the same turn")
    gs3, f3 = open_session({"a": [ctx_reply(1), ctx_reply(1)]})
    with gs3, pytest.raises(service.ObserverError) as e3:
        seat1.perform(gs3, action_id=pottery["actionId"], request_id="s-3", player=1, mode="singleplayer")
    assert e3.value.code in ("ACTION_EXPIRED", "UNKNOWN_ACTION")
    assert dispatched(f3) == [], "no stale-generation mutation"

    # 5. fresh offers under the new generation work, and a duplicate request never repeats the write
    gs4, f4 = open_session({"a": [ctx_reply(1), ctx_reply(1), reply(2, json.dumps(OFFERS)), ctx_reply(3), reply(4, json.dumps(PERFORMED)), ctx_reply(5)]})
    with gs4:
        offers4 = seat1.list_offers(gs4, player=1, mode="singleplayer")
        pottery4 = next(o for o in offers4["offers"] if o.get("typeKey") == "NODE_TECH_AQ_POTTERY")
        first = seat1.perform(gs4, action_id=pottery4["actionId"], request_id="s-4", player=1, mode="singleplayer")
        again = seat1.perform(gs4, action_id=pottery4["actionId"], request_id="s-4", player=1, mode="singleplayer")
    assert first["status"] == "confirmed" and again == first
    assert len(dispatched(f4)) == 1, "a duplicate request must never repeat the write"
    assert json.loads(seat1.inflight_path.read_text()) == {}, "no reservation may outlive a recorded outcome"


def test_reconciling_from_another_seat_clears_the_owning_seat_view(tmp_path):
    import websocket
    owner = actions.ActionRegistry(journal_path=tmp_path / "seat1.jsonl")
    gs, _ = open_session({"a": [ctx_reply(1), ctx_reply(1), reply(2, json.dumps(OFFERS)), ctx_reply(3), websocket.WebSocketConnectionClosedException()]})
    with gs:
        offers = owner.list_offers(gs, player=1, mode="singleplayer")
        pottery = next(o for o in offers["offers"] if o.get("typeKey") == "NODE_TECH_AQ_POTTERY")
        with pytest.raises(service.ObserverError):
            owner.perform(gs, action_id=pottery["actionId"], request_id="own-1", player=1, mode="singleplayer")
    other = actions.ActionRegistry(journal_path=tmp_path / "seat0.jsonl")
    other.reconcile("own-1", "rejected", note="human verified from the other seat")
    assert other.needs_reconciliation() == []
    reopened = actions.ActionRegistry(journal_path=tmp_path / "seat1.jsonl")
    assert reopened.needs_reconciliation() == [], "the owning seat must not still report an unknown outcome"
    assert reopened.get_result("own-1")["status"] == "rejected"


def test_tests_never_use_the_real_host_state_directory():
    """Guard for the conftest isolation: a stray write here could block the user's live game."""
    from civ7_observer.attachment import state_dir
    assert str(state_dir()) != str(Path.home() / ".local" / "state" / "civ7-observer")


def test_found_city_offers_expose_the_unit_and_plot_and_perform_confirms_on_a_settlement_there(tmp_path):
    offers = {**OFFERS, "offers": OFFERS["offers"] + [{"kind": "FOUND_CITY", "arg": 65536, "x": 15, "y": 27, "pre": 2715, "unitId": 65536, "from": {"x": 15, "y": 27}, "unitTypeKey": "UNIT_FOUNDER", "terrainKey": "TERRAIN_FLAT", "movesRemaining": 3, "canStart": True}]}
    performed = {"payloadVersion": 1, "refused": None, "context": CTX, "outcome": "sent", "readback": {"kind": "FOUND_CITY", "arg": 65536, "at": {"x": 15, "y": 27}, "matches": False}}
    rb = {**RB, "cityLocations": {"65536": [15, 27]}}
    reg = actions.ActionRegistry(journal_path=tmp_path / "journal.jsonl")
    gs, f = open_session({"a": [ctx_reply(1), ctx_reply(1), reply(2, json.dumps(offers)), ctx_reply(3), reply(4, json.dumps(performed)), reply(5, json.dumps(rb))]})
    with gs:
        out = reg.list_offers(gs, player=1, mode="singleplayer")
        fc = next(o for o in out["offers"] if o["kind"] == "found_city")
        assert fc["unitId"] == 65536 and fc["from"] == {"x": 15, "y": 27} and fc["terrainKey"] == "TERRAIN_FLAT" and fc["unitTypeKey"] == "UNIT_FOUNDER"
        assert "arg" not in fc and "x" not in fc and "pre" not in fc
        res = reg.perform(gs, action_id=fc["actionId"], request_id="fc-1", player=1, mode="singleplayer")
    assert res["status"] == "confirmed"
    assert res["confirmedBy"]["source"] == "poll" and res["confirmedBy"]["effect"] == {"settlementFounded": {"unitId": 65536, "x": 15, "y": 27}}
    sent = json.loads(f.all_sockets[1].sent[3])["params"]["expression"]
    assert '"FOUND_CITY"' in sent and "const ARG = 65536;" in sent and "const ARG2 = 15;" in sent and "const ARG3 = 27;" in sent and "const PRE = 2715;" in sent


def test_found_city_poll_needs_a_settlement_on_the_offered_plot(tmp_path):
    offers = {**OFFERS, "offers": OFFERS["offers"] + [{"kind": "FOUND_CITY", "arg": 65536, "x": 15, "y": 27, "pre": 2715, "unitId": 65536, "from": {"x": 15, "y": 27}, "canStart": True}]}
    performed = {"payloadVersion": 1, "refused": None, "context": CTX, "outcome": "sent", "readback": {"kind": "FOUND_CITY", "arg": 65536, "at": {"x": 15, "y": 27}, "matches": False}}
    rb = {**RB, "cityLocations": {"65536": [16, 27]}}
    reg = actions.ActionRegistry(journal_path=tmp_path / "journal.jsonl")
    gs, f = open_session({"a": [ctx_reply(1), ctx_reply(1), reply(2, json.dumps(offers)), ctx_reply(3), reply(4, json.dumps(performed))] + [reply(5 + i, json.dumps(rb)) for i in range(actions.READBACK_ATTEMPTS)]})
    with gs:
        out = reg.list_offers(gs, player=1, mode="singleplayer")
        fc = next(o for o in out["offers"] if o["kind"] == "found_city")
        with pytest.raises(service.ObserverError) as info:
            reg.perform(gs, action_id=fc["actionId"], request_id="fc-2", player=1, mode="singleplayer")
    assert info.value.code == "ACTION_OUTCOME_UNKNOWN"


def test_expand_offers_expose_plot_detail_and_perform_confirms_when_the_plot_leaves_the_native_listing(tmp_path):
    offers = {**OFFERS, "offers": OFFERS["offers"] + [{"kind": "EXPAND_CITY", "arg": 65536, "x": 16, "y": 28, "pre": 2816, "cityId": 65536, "cityName": "Pārsa", "plotIndex": 2816, "growthReady": True, "improvementKey": "IMPROVEMENT_FARM", "terrainKey": "TERRAIN_FLAT", "featureKey": None, "river": False, "yields": {"food": 2, "production": 1}, "canStart": True}]}
    performed = {"payloadVersion": 1, "refused": None, "context": CTX, "outcome": "sent", "readback": {"kind": "EXPAND_CITY", "arg": 65536, "plot": {"x": 16, "y": 28, "index": 2816}, "stillOffered": True, "matches": False}}
    rb = {**RB, "expandPlots": {"65536": [2716]}}
    reg = actions.ActionRegistry(journal_path=tmp_path / "journal.jsonl")
    gs, f = open_session({"a": [ctx_reply(1), ctx_reply(1), reply(2, json.dumps(offers)), ctx_reply(3), reply(4, json.dumps(performed)), reply(5, json.dumps(rb))]})
    with gs:
        out = reg.list_offers(gs, player=1, mode="singleplayer")
        ex = next(o for o in out["offers"] if o["kind"] == "expand_city")
        assert ex["to"] == {"x": 16, "y": 28} and ex["cityName"] == "Pārsa" and ex["improvementKey"] == "IMPROVEMENT_FARM" and ex["yields"] == {"food": 2, "production": 1}
        assert "arg" not in ex and "x" not in ex and "pre" not in ex
        res = reg.perform(gs, action_id=ex["actionId"], request_id="ex-1", player=1, mode="singleplayer")
    assert res["status"] == "confirmed"
    assert res["confirmedBy"]["effect"] == {"populationPlaced": {"cityId": 65536, "x": 16, "y": 28, "plotIndex": 2816}}
    sent = json.loads(f.all_sockets[1].sent[3])["params"]["expression"]
    assert '"EXPAND_CITY"' in sent and "const ARG = 65536;" in sent and "const ARG2 = 16;" in sent and "const ARG3 = 28;" in sent and "const PRE = 2816;" in sent


def test_expand_poll_does_not_confirm_while_the_plot_is_still_offered(tmp_path):
    offers = {**OFFERS, "offers": OFFERS["offers"] + [{"kind": "EXPAND_CITY", "arg": 65536, "x": 16, "y": 28, "pre": 2816, "cityId": 65536, "canStart": True}]}
    performed = {"payloadVersion": 1, "refused": None, "context": CTX, "outcome": "sent", "readback": {"kind": "EXPAND_CITY", "arg": 65536, "plot": {"x": 16, "y": 28, "index": 2816}, "stillOffered": True, "matches": False}}
    rb = {**RB, "expandPlots": {"65536": [2816, 2716]}}
    reg = actions.ActionRegistry(journal_path=tmp_path / "journal.jsonl")
    gs, f = open_session({"a": [ctx_reply(1), ctx_reply(1), reply(2, json.dumps(offers)), ctx_reply(3), reply(4, json.dumps(performed))] + [reply(5 + i, json.dumps(rb)) for i in range(actions.READBACK_ATTEMPTS)]})
    with gs:
        out = reg.list_offers(gs, player=1, mode="singleplayer")
        ex = next(o for o in out["offers"] if o["kind"] == "expand_city")
        with pytest.raises(service.ObserverError) as info:
            reg.perform(gs, action_id=ex["actionId"], request_id="ex-2", player=1, mode="singleplayer")
    assert info.value.code == "ACTION_OUTCOME_UNKNOWN"


def test_constructible_offers_expose_placement_and_perform_confirms_on_city_production(tmp_path):
    offers = {**OFFERS, "offers": OFFERS["offers"] + [{"kind": "PRODUCE_CONSTRUCTIBLE", "arg": 65536, "arg2": 501, "arg3": 404, "x": 4, "y": 4, "pre": -1, "cityId": 65536, "cityName": "Pārsa", "constructibleKey": "BUILDING_GRANARY", "constructibleClass": "BUILDING", "displayName": "Granary", "cost": 36, "turns": 8, "plotIndex": 404, "placement": "newUrban", "terrainKey": "TERRAIN_FLAT", "featureKey": None, "river": False, "yields": {"food": 3}, "canStart": True}]}
    performed = {"payloadVersion": 1, "refused": None, "context": CTX, "outcome": "sent", "readback": {"kind": "PRODUCE_CONSTRUCTIBLE", "arg": 65536, "constructibleType": 501, "plot": {"x": 4, "y": 4, "index": 404}, "observedType": -1, "matches": False}}
    rb = {**RB, "cityProduction": {"65536": 501}}
    reg = actions.ActionRegistry(journal_path=tmp_path / "journal.jsonl")
    gs, f = open_session({"a": [ctx_reply(1), ctx_reply(1), reply(2, json.dumps(offers)), ctx_reply(3), reply(4, json.dumps(performed)), reply(5, json.dumps(rb))]})
    with gs:
        out = reg.list_offers(gs, player=1, mode="singleplayer")
        pc = next(o for o in out["offers"] if o["kind"] == "produce_constructible")
        assert pc["to"] == {"x": 4, "y": 4} and pc["placement"] == "newUrban" and pc["constructibleKey"] == "BUILDING_GRANARY" and pc["cost"] == 36 and pc["turns"] == 8
        assert "arg" not in pc and "arg2" not in pc and "arg3" not in pc and "x" not in pc
        res = reg.perform(gs, action_id=pc["actionId"], request_id="pc-1", player=1, mode="singleplayer")
    assert res["status"] == "confirmed"
    assert res["confirmedBy"]["effect"] == {"cityProduction": {"cityId": 65536, "constructibleType": 501}}
    sent = json.loads(f.all_sockets[1].sent[3])["params"]["expression"]
    assert '"PRODUCE_CONSTRUCTIBLE"' in sent and "const ARG = 65536;" in sent and "const ARG2 = 501;" in sent and "const ARG3 = 404;" in sent
