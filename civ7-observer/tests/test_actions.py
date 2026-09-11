import json

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
