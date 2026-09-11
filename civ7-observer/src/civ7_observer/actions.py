"""Constrained action protocol: opaque offers, native legality at execution, read-back, idempotent
request ids, and a persisted journal with explicit reconciliation for unknown outcomes."""

from __future__ import annotations

import fcntl
import json
import re
import secrets
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from civ7_observer import cdp
from civ7_observer.payloads import load_payload, render_action_payload, render_payload
from civ7_observer.probe import write_atomic
from civ7_observer.service import GameSession, ObserverError

PUBLIC_KIND = {"SET_TECH_TREE_NODE": "research", "SET_CULTURE_TREE_NODE": "civic", "END_TURN": "end_turn", "SKIP_UNIT": "skip_unit", "MOVE_UNIT": "move_unit", "PRODUCE_UNIT": "produce_unit"}
REQUEST_ID = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
ACTION_ID = re.compile(r"^[A-Za-z0-9_-]{16,64}$")
FINAL = ("confirmed", "rejected", "unknown")
READBACK_ATTEMPTS = 10
READBACK_DELAY = 0.2


class _Malformed(Exception):
    pass


def _parse(value: object) -> dict[str, Any]:
    """Parse a payload result. Raises _Malformed when the shape is unusable."""
    if not isinstance(value, str):
        raise _Malformed("payload returned a non-string")
    try:
        data = json.loads(value)
    except ValueError as exc:
        raise _Malformed(f"payload returned non-JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise _Malformed("payload returned a non-object")
    return data


def _load(gs: GameSession, expression: str) -> dict[str, Any]:
    """Read-only payloads: transport and shape failures are typed errors; refusals are typed errors."""
    try:
        value = gs.session.evaluate_readonly(expression)
    except cdp.CdpError as exc:
        raise ObserverError(exc.code, exc.message) from exc
    try:
        data = _parse(value)
    except _Malformed as exc:
        raise ObserverError("API_CONTRACT_MISMATCH", str(exc)) from exc
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
        self.lock_path = self.journal_path.with_name(self.journal_path.stem + ".lock")
        self._load_journal()
        self._load_offers()

    @contextmanager
    def _locked(self):
        """Interprocess lock: every registry sharing this journal serializes its reads and writes."""
        self.lock_path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.lock_path, "a+") as fh:
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
            try:
                self._reload()
                yield
            finally:
                fcntl.flock(fh.fileno(), fcntl.LOCK_UN)

    def _reload(self) -> None:
        self._offers = {}
        self._results = {}
        self._pending = set()
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
        self._pending_rows: dict[str, dict[str, Any]] = {}
        if not self.journal_path.exists():
            return
        for line in self.journal_path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            entry = json.loads(line)
            rid = entry["requestId"]
            if entry["status"] == "pending":
                self._pending.add(rid)
                self._pending_rows[rid] = entry
            else:
                self._pending.discard(rid)
                self._results[rid] = entry
        # a pending entry with no final record means the process died mid-action: outcome unknown.
        # Keep the complete pending record so the action identity and parameters survive.
        for rid in list(self._pending):
            self._results[rid] = {**self._pending_rows[rid], "status": "unknown", "note": "process ended before the outcome was recorded"}
            self._pending.discard(rid)

    def _journal(self, entry: dict[str, Any]) -> None:
        self.journal_path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.journal_path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry) + "\n")

    def needs_reconciliation(self) -> list[str]:
        return sorted(rid for rid, r in self._results.items() if r["status"] == "unknown")

    def reconcile(self, request_id: str, status: str, *, note: str) -> None:
        with self._locked():
            self._reconcile(request_id, status, note=note)

    def _reconcile(self, request_id: str, status: str, *, note: str) -> None:
        if status not in ("confirmed", "rejected"):
            raise ValueError("reconcile status must be confirmed or rejected")
        prior = self._results.get(request_id)
        if prior is None or prior["status"] != "unknown":
            raise ValueError(f"request {request_id!r} is not awaiting reconciliation")
        entry = {**prior, "status": status, "reconciled": True, "note": note, "at": _now()}
        self._results[request_id] = entry
        self._journal(entry)

    def get_result(self, request_id: str) -> dict[str, Any] | None:
        with self._locked():
            return self._results.get(request_id)

    # ---- offers
    def list_offers(self, gs: GameSession, *, player: int, mode: str) -> dict[str, Any]:
        with self._locked():
            return self._list_offers(gs, player=player, mode=mode)

    def _list_offers(self, gs: GameSession, *, player: int, mode: str) -> dict[str, Any]:
        _bind_ok(gs, player)
        data = _load(gs, render_payload("offers.js", bound_player_id=player, allowed_mode=mode))
        after = gs.read_context()
        if not gs.context_is_live(after):
            raise ObserverError("CONTEXT_CHANGED", "game context changed while enumerating offers")
        ctx = data.get("context")
        offers = data.get("offers")
        if not isinstance(ctx, dict) or not isinstance(offers, list):
            raise ObserverError("API_CONTRACT_MISMATCH", "offers payload malformed")
        if ctx.get("turn") != gs.context.turn or ctx.get("age") != gs.context.age or ctx.get("gameGuid") != gs.context.game_guid:
            raise ObserverError("CONTEXT_CHANGED", "offers were enumerated for a different turn or match")
        public = []
        for o in offers:
            kind = o.get("kind")
            if kind not in PUBLIC_KIND or not isinstance(o.get("arg"), int) or not isinstance(o.get("canStart"), bool) or not isinstance(o.get("pre"), int):
                raise ObserverError("API_CONTRACT_MISMATCH", "offer entry malformed")
            action_id = secrets.token_urlsafe(18)
            rec = {"kind": kind, "arg": o["arg"], "pre": o["pre"], "seat": player, "turn": gs.context.turn, "age": gs.context.age,
                   "match": gs.context.game_guid, "target": gs.doctor.selected["id"], "canStart": o["canStart"]}
            entry = {"actionId": action_id, "kind": PUBLIC_KIND[kind], "canStart": o["canStart"]}
            if kind in ("MOVE_UNIT", "SKIP_UNIT"):
                if isinstance(o.get("unitId"), int):
                    entry["unitId"] = o["unitId"]
                if isinstance(o.get("from"), dict):
                    entry["from"] = o["from"]
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
            if kind == "PRODUCE_UNIT":
                if not isinstance(o.get("arg2"), int):
                    raise ObserverError("API_CONTRACT_MISMATCH", "produce offer without a unit type")
                rec["arg2"] = o["arg2"]
                for k in ("cityId", "cityName", "unitTypeKey", "displayName", "turns"):
                    if k in o:
                        entry[k] = o[k]
            self._offers[action_id] = rec
            for k in ("typeKey", "displayName", "tree", "cost", "turns", "blockingType", "alreadySent", "unitTypeKey", "movesRemaining", "location"):
                if k in o:
                    entry[k] = o[k]
            public.append(entry)
        # offers from earlier turns or other matches can never be performed; drop them so the file stays small
        self._offers = {k: v for k, v in self._offers.items() if (v.get("turn"), v.get("age"), v.get("match")) == (gs.context.turn, gs.context.age, gs.context.game_guid)}
        self._save_offers()
        return {"context": ctx, "offers": public, "reconciliationRequired": self.needs_reconciliation()}

    # ---- perform
    def perform(self, gs: GameSession, *, action_id: str, request_id: str, player: int, mode: str) -> dict[str, Any]:
        with self._locked():
            return self._perform(gs, action_id=action_id, request_id=request_id, player=player, mode=mode)

    def _perform(self, gs: GameSession, *, action_id: str, request_id: str, player: int, mode: str) -> dict[str, Any]:
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
        if (offer.get("turn"), offer.get("age"), offer.get("match")) != (gs.context.turn, gs.context.age, gs.context.game_guid) or not gs.context.game_guid:
            raise ObserverError("ACTION_EXPIRED", "the offer was made on a different turn or match; request fresh offers")
        if not offer["canStart"]:
            raise ObserverError("ACTION_NOT_STARTABLE", "the offer was not startable when enumerated; request fresh offers")
        base = {"requestId": request_id, "actionId": action_id, "kind": offer["kind"], "arg": offer["arg"], "arg2": offer.get("arg2", 0), "arg3": offer.get("arg3", 0),
                "pre": offer["pre"], "seat": player, "turn": offer["turn"], "age": offer["age"], "match": offer["match"]}
        self._journal({**base, "status": "pending", "at": _now()})
        self._pending.add(request_id)
        expression = render_action_payload(bound_player_id=player, allowed_mode=mode, kind=offer["kind"], arg=offer["arg"], expected_turn=offer["turn"], expected_age=offer["age"],
                                           expected_match=offer["match"], pre=offer["pre"], arg2=offer.get("arg2", 0), arg3=offer.get("arg3", 0))
        # From here on the request may have reached the engine: only an explicit, well-formed refusal
        # from the payload proves nothing was sent. Everything else ambiguous is unknown.
        try:
            value = gs.session.evaluate_readonly(expression)
        except cdp.CdpError as exc:
            return self._finish(base, "unknown", error=exc.to_dict(), raise_code="ACTION_OUTCOME_UNKNOWN")
        try:
            data = _parse(value)
        except _Malformed as exc:
            return self._finish(base, "unknown", error={"code": "MALFORMED_RESPONSE", "message": str(exc)}, raise_code="ACTION_OUTCOME_UNKNOWN")
        refused = data.get("refused")
        if isinstance(refused, dict) and isinstance(refused.get("code"), str) and data.get("outcome") is None:
            return self._finish(base, "rejected", error={k: v for k, v in refused.items()})
        if data.get("outcome") != "sent":
            return self._finish(base, "unknown", error={"code": "MALFORMED_RESPONSE", "message": "payload reported neither a refusal nor a send"}, raise_code="ACTION_OUTCOME_UNKNOWN")
        readback = data.get("readback") if isinstance(data.get("readback"), dict) else {}
        confirmed_by = self._confirm(gs, offer, readback, player)
        return self._finish(base, "confirmed" if confirmed_by is not None else "unknown", readback=readback, confirmed_by=confirmed_by,
                            raise_code=None if confirmed_by is not None else "ACTION_OUTCOME_UNKNOWN")

    def _confirm(self, gs: GameSession, offer: dict[str, Any], readback: dict[str, Any], player: int) -> dict[str, Any] | None:
        """Return the read-back that positively established the effect, or None (unknown).

        The in-payload read-back is only a hint; the engine applies operations asynchronously.
        A poll counts only if it identifies the same match and carries integer turn/age/seat.
        """
        kind = offer["kind"]
        immediate = None
        if kind == "END_TURN" and readback.get("sentComplete") is True:
            immediate = {"source": "payload", "hasSentTurnComplete": True, "gameGuid": offer["match"], "turn": offer["turn"], "localPlayerId": player}
        elif kind != "END_TURN" and readback.get("matches") is True:
            immediate = {"source": "payload", **readback, "gameGuid": offer["match"], "turn": offer["turn"], "localPlayerId": player}
        if immediate is not None:
            return immediate
        expr = render_payload("readback.js", bound_player_id=player)
        for _ in range(READBACK_ATTEMPTS):
            time.sleep(READBACK_DELAY)
            try:
                rb = _load(gs, expr)
            except ObserverError:
                return None
            if rb.get("gameGuid") != offer["match"]:
                continue
            turn, age, seat = rb.get("turn"), rb.get("age"), rb.get("localPlayerId")
            if not all(isinstance(v, int) and not isinstance(v, bool) for v in (turn, age, seat)):
                continue
            hit = False
            if kind == "END_TURN":
                # positively identified progression only: completion flagged on the same seat/turn,
                # the turn counter advanced, or the seat handed off to another integer seat
                if (rb.get("hasSentTurnComplete") is True and seat == player and turn == offer["turn"]) \
                        or (turn > offer["turn"]) or (seat != player and turn >= offer["turn"]):
                    hit = True
            elif turn == offer["turn"] and seat == player:
                if kind == "SET_TECH_TREE_NODE" and rb.get("techResearching") == offer["arg"]:
                    hit = True
                elif kind == "SET_CULTURE_TREE_NODE" and rb.get("civicResearching") == offer["arg"]:
                    hit = True
                elif kind == "SKIP_UNIT":
                    ready = rb.get("unitsReadyToMove")
                    hit = isinstance(ready, list) and offer["arg"] not in ready
                elif kind == "MOVE_UNIT":
                    locs = rb.get("unitLocations")
                    hit = isinstance(locs, dict) and locs.get(str(offer["arg"])) == [offer["arg2"], offer["arg3"]]
                elif kind == "PRODUCE_UNIT":
                    prod = rb.get("cityProduction")
                    hit = isinstance(prod, dict) and prod.get(str(offer["arg"])) == offer["arg2"]
            if hit:
                return {"source": "poll", "gameGuid": rb.get("gameGuid"), "turn": turn, "age": age, "localPlayerId": seat, "hasSentTurnComplete": rb.get("hasSentTurnComplete")}
        return None

    def _finish(self, base: dict[str, Any], status: str, *, error: dict[str, Any] | None = None, readback: dict[str, Any] | None = None,
                confirmed_by: dict[str, Any] | None = None, raise_code: str | None = None) -> dict[str, Any]:
        entry = {**base, "status": status, "at": _now()}
        if error is not None:
            entry["error"] = error
        if readback is not None:
            entry["readback"] = readback
        if confirmed_by is not None:
            entry["confirmedBy"] = confirmed_by
        self._journal(entry)
        self._pending.discard(base["requestId"])
        self._results[base["requestId"]] = entry
        if raise_code:
            raise ObserverError(raise_code, f"action {base['requestId']} outcome is {status}; reconcile before acting again", result=entry)
        return entry


def _now() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
