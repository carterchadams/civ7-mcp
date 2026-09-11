"""Constrained action protocol: opaque offers, native legality at execution, read-back, idempotent
request ids, and a persisted journal with explicit reconciliation for unknown outcomes."""

from __future__ import annotations

import json
import re
import secrets
import time
from pathlib import Path
from typing import Any

from civ7_observer import cdp
from civ7_observer.payloads import load_payload, render_action_payload, render_payload
from civ7_observer.probe import write_atomic
from civ7_observer.service import GameSession, ObserverError

PUBLIC_KIND = {"SET_TECH_TREE_NODE": "research", "SET_CULTURE_TREE_NODE": "civic", "END_TURN": "end_turn", "SKIP_UNIT": "skip_unit", "MOVE_UNIT": "move_unit"}
REQUEST_ID = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
ACTION_ID = re.compile(r"^[A-Za-z0-9_-]{16,64}$")
FINAL = ("confirmed", "rejected", "unknown")
READBACK_ATTEMPTS = 10
READBACK_DELAY = 0.2


def _load(gs: GameSession, expression: str) -> dict[str, Any]:
    try:
        value = gs.session.evaluate_readonly(expression)
    except cdp.CdpError as exc:
        raise ObserverError(exc.code, exc.message) from exc
    if not isinstance(value, str):
        raise ObserverError("API_CONTRACT_MISMATCH", "payload returned a non-string")
    try:
        data = json.loads(value)
    except ValueError as exc:
        raise ObserverError("API_CONTRACT_MISMATCH", f"payload returned non-JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise ObserverError("API_CONTRACT_MISMATCH", "payload returned a non-object")
    if data.get("refused") is not None:
        r = data["refused"]
        raise ObserverError(str(r.get("code", "REFUSED")), str(r.get("message", "")), **{k: v for k, v in r.items() if k not in ("code", "message")})
    return data


def _bind_ok(gs: GameSession, player: int) -> None:
    local = gs.context.local_player_id
    if player != local or gs.context.local_observer_id != local:
        raise ObserverError("WRONG_PLAYER", f"bound player {player} is not the local seat (localPlayerId={local}, localObserverId={gs.context.local_observer_id})")


class ActionRegistry:
    """Per-process registry of offered actions and the persisted journal of performed ones."""

    def __init__(self, journal_path: Path) -> None:
        self.journal_path = Path(journal_path)
        self.offers_path = self.journal_path.with_name(self.journal_path.stem + ".offers.json")
        self._offers: dict[str, dict[str, Any]] = {}
        self._results: dict[str, dict[str, Any]] = {}
        self._pending: set[str] = set()
        self._load_journal()
        self._load_offers()

    def _load_offers(self) -> None:
        if self.offers_path.exists():
            try:
                data = json.loads(self.offers_path.read_text(encoding="utf-8"))
            except ValueError:
                data = {}
            if isinstance(data, dict):
                self._offers = {k: v for k, v in data.items() if isinstance(v, dict)}

    def _save_offers(self) -> None:
        write_atomic(self.offers_path, json.dumps(self._offers))

    # ---- journal
    def _load_journal(self) -> None:
        if not self.journal_path.exists():
            return
        for line in self.journal_path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            entry = json.loads(line)
            rid = entry["requestId"]
            if entry["status"] == "pending":
                self._pending.add(rid)
            else:
                self._pending.discard(rid)
                self._results[rid] = entry
        # a pending entry with no final record means the process died mid-action: outcome unknown
        for rid in list(self._pending):
            self._results[rid] = {"requestId": rid, "status": "unknown", "note": "process ended before the outcome was recorded"}
            self._pending.discard(rid)

    def _journal(self, entry: dict[str, Any]) -> None:
        self.journal_path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.journal_path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry) + "\n")

    def needs_reconciliation(self) -> list[str]:
        return sorted(rid for rid, r in self._results.items() if r["status"] == "unknown")

    def reconcile(self, request_id: str, status: str, *, note: str) -> None:
        if status not in ("confirmed", "rejected"):
            raise ValueError("reconcile status must be confirmed or rejected")
        prior = self._results.get(request_id)
        if prior is None or prior["status"] != "unknown":
            raise ValueError(f"request {request_id!r} is not awaiting reconciliation")
        entry = {**prior, "status": status, "reconciled": True, "note": note, "at": _now()}
        self._results[request_id] = entry
        self._journal(entry)

    def get_result(self, request_id: str) -> dict[str, Any] | None:
        return self._results.get(request_id)

    # ---- offers
    def list_offers(self, gs: GameSession, *, player: int, mode: str) -> dict[str, Any]:
        _bind_ok(gs, player)
        data = _load(gs, render_payload("offers.js", bound_player_id=player, allowed_mode=mode))
        after = gs.read_context()
        if not gs.context_is_live(after):
            raise ObserverError("CONTEXT_CHANGED", "game context changed while enumerating offers")
        ctx = data.get("context")
        offers = data.get("offers")
        if not isinstance(ctx, dict) or not isinstance(offers, list):
            raise ObserverError("API_CONTRACT_MISMATCH", "offers payload malformed")
        if ctx.get("turn") != gs.context.turn or ctx.get("age") != gs.context.age:
            raise ObserverError("CONTEXT_CHANGED", "offers were enumerated for a different turn")
        public = []
        for o in offers:
            kind = o.get("kind")
            if kind not in PUBLIC_KIND or not isinstance(o.get("arg"), int) or not isinstance(o.get("canStart"), bool):
                raise ObserverError("API_CONTRACT_MISMATCH", "offer entry malformed")
            action_id = secrets.token_urlsafe(18)
            rec = {"kind": kind, "arg": o["arg"], "seat": player, "turn": gs.context.turn, "age": gs.context.age,
                   "target": gs.doctor.selected["id"], "canStart": o["canStart"]}
            entry = {"actionId": action_id, "kind": PUBLIC_KIND[kind], "canStart": o["canStart"]}
            if kind == "MOVE_UNIT":
                if not isinstance(o.get("x"), int) or not isinstance(o.get("y"), int):
                    raise ObserverError("API_CONTRACT_MISMATCH", "move offer without coordinates")
                rec["arg2"], rec["arg3"] = o["x"], o["y"]
                entry["to"] = {"x": o["x"], "y": o["y"]}
                if isinstance(o.get("direction"), int):
                    entry["direction"] = o["direction"]
                for k in ("terrainKey", "pathTurns"):
                    if k in o:
                        entry[k] = o[k]
            self._offers[action_id] = rec
            for k in ("typeKey", "displayName", "tree", "cost", "turns", "blockingType", "alreadySent", "unitTypeKey", "movesRemaining", "location"):
                if k in o:
                    entry[k] = o[k]
            public.append(entry)
        # offers from earlier turns can never be performed; drop them so the file stays small
        self._offers = {k: v for k, v in self._offers.items() if (v["turn"], v["age"]) == (gs.context.turn, gs.context.age)}
        self._save_offers()
        return {"context": ctx, "offers": public, "reconciliationRequired": self.needs_reconciliation()}

    # ---- perform
    def perform(self, gs: GameSession, *, action_id: str, request_id: str, player: int, mode: str) -> dict[str, Any]:
        _bind_ok(gs, player)
        if not isinstance(request_id, str) or not REQUEST_ID.match(request_id):
            raise ObserverError("INVALID_REQUEST_ID", "request id must be 1-64 chars of [A-Za-z0-9._-]")
        prior = self._results.get(request_id)
        if prior is not None:
            if prior.get("actionId") != action_id:
                raise ObserverError("REQUEST_ID_REUSED", "this request id was already used for a different action")
            return prior
        if self.needs_reconciliation():
            raise ObserverError("RECONCILIATION_REQUIRED", f"unknown outcomes must be reconciled first: {self.needs_reconciliation()}")
        if not isinstance(action_id, str) or not ACTION_ID.match(action_id):
            raise ObserverError("UNKNOWN_ACTION", "malformed action id")
        offer = self._offers.get(action_id)
        if offer is None:
            raise ObserverError("UNKNOWN_ACTION", "no such offered action")
        if offer["seat"] != player:
            raise ObserverError("WRONG_PLAYER", "offer belongs to another seat")
        if (offer["turn"], offer["age"]) != (gs.context.turn, gs.context.age):
            raise ObserverError("ACTION_EXPIRED", "the offer was made on a different turn; request fresh offers")
        if not offer["canStart"]:
            raise ObserverError("ACTION_NOT_STARTABLE", "the offer was not startable when enumerated; request fresh offers")
        base = {"requestId": request_id, "actionId": action_id, "kind": offer["kind"], "arg": offer["arg"], "seat": player, "turn": offer["turn"], "age": offer["age"]}
        self._journal({**base, "status": "pending", "at": _now()})
        self._pending.add(request_id)
        expression = render_action_payload(bound_player_id=player, allowed_mode=mode, kind=offer["kind"], arg=offer["arg"], expected_turn=offer["turn"], expected_age=offer["age"], arg2=offer.get("arg2", 0), arg3=offer.get("arg3", 0))
        try:
            data = _load(gs, expression)
        except ObserverError as exc:
            if exc.code.startswith("CDP") or exc.code in ("TARGET_CONNECT_FAILED", "DEBUGGER_UNAVAILABLE"):
                # the request may or may not have reached the engine: never assume either way
                return self._finish(base, "unknown", error=exc.to_dict(), raise_code="ACTION_OUTCOME_UNKNOWN")
            # a typed refusal from the payload: nothing was sent
            return self._finish(base, "rejected", error=exc.to_dict())
        if data.get("outcome") != "sent":
            return self._finish(base, "rejected", error={"code": "NOT_SENT", "message": "payload did not report sending"})
        readback = data.get("readback") if isinstance(data.get("readback"), dict) else {}
        confirmed = self._confirm(gs, offer, readback, player)
        return self._finish(base, "confirmed" if confirmed else "unknown", readback=readback,
                            raise_code=None if confirmed else "ACTION_OUTCOME_UNKNOWN")

    def _confirm(self, gs: GameSession, offer: dict[str, Any], readback: dict[str, Any], player: int) -> bool:
        if offer["kind"] == "END_TURN":
            if readback.get("sentComplete") is True:
                return True
        elif readback.get("matches") is True:
            return True
        elif offer["kind"] == "SKIP_UNIT":
            pass
        # poll the read-only read-back for a short, bounded time
        expr = render_payload("readback.js", bound_player_id=player)
        for _ in range(READBACK_ATTEMPTS):
            time.sleep(READBACK_DELAY)
            try:
                rb = _load(gs, expr)
            except ObserverError:
                return False
            if offer["kind"] == "END_TURN":
                if rb.get("hasSentTurnComplete") is True or rb.get("localPlayerId") != player or rb.get("turn") != offer["turn"]:
                    return True   # the turn moved on
            elif offer["kind"] == "SKIP_UNIT":
                ready = rb.get("unitsReadyToMove")
                if isinstance(ready, list) and offer["arg"] not in ready:
                    return True
            elif offer["kind"] == "MOVE_UNIT":
                locs = rb.get("unitLocations")
                if isinstance(locs, dict) and locs.get(str(offer["arg"])) == [offer["arg2"], offer["arg3"]]:
                    return True
            else:
                key = "techResearching" if offer["kind"] == "SET_TECH_TREE_NODE" else "civicResearching"
                if rb.get(key) == offer["arg"]:
                    return True
        return False

    def _finish(self, base: dict[str, Any], status: str, *, error: dict[str, Any] | None = None, readback: dict[str, Any] | None = None, raise_code: str | None = None) -> dict[str, Any]:
        entry = {**base, "status": status, "at": _now()}
        if error is not None:
            entry["error"] = error
        if readback is not None:
            entry["readback"] = readback
        self._journal(entry)
        self._pending.discard(base["requestId"])
        self._results[base["requestId"]] = entry
        if raise_code:
            raise ObserverError(raise_code, f"action {base['requestId']} outcome is {status}; reconcile before acting again", result=entry)
        return entry


def _now() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
