"""Constrained action protocol: opaque offers, native legality at execution, read-back, idempotent
request ids, and a persisted journal with explicit reconciliation for unknown outcomes."""

from __future__ import annotations

import json
import re
import secrets
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from civ7_observer import cdp
from civ7_observer.attachment import SharedState, state_dir
from civ7_observer.payloads import load_payload, render_action_payload, render_payload
from civ7_observer.probe import write_atomic
from civ7_observer.service import GameSession, ObserverError

# Shown on every offer that asks for a confirmation, and repeated in the refusal when one is missing.
# Each says what the action costs and when it is nonetheless the right call, because a seat weighing
# the option needs the trade, not a scolding.
CONFIRMATION_GUIDANCE = {
    "disband_unit": (
        "Disbanding destroys this unit permanently. It is almost never the right move: the unit's "
        "production and any promotions it earned are gone for nothing, and a unit with no use this "
        "turn can simply be told to fortify, sleep or heal instead. Disband only to escape a gold or "
        "happiness upkeep the seat genuinely cannot pay, or to clear a unit that can never act again."
    ),
    "activate_great_person": (
        "Activating a great person spends them: the unit is consumed and its one effect is taken "
        "where it stands. That is what they are for, but the effect depends on the plot, so place "
        "them deliberately rather than activating on the first tile that allows it."
    ),
    "raze_captured_city": (
        "Razing destroys the settlement over the coming turns: its population, buildings and any wonders are "
        "lost for good, and the world remembers it. Keep it unless you truly cannot hold or feed it."
    ),
    "liberate_captured_city": (
        "Liberating hands the settlement back to its founder for nothing. It buys goodwill and costs you the "
        "city; take it only when holding the city would cost more than it is worth."
    ),
    "join_ally_war": (
        "Joining an ally's war declares war on their enemy, with everything a war costs: the relationship, "
        "shared endeavors and trade routes with that civilization end, and their armies may come for you. "
        "Staying out instead ends the alliance (end alliance with the ally). Join when the ally matters "
        "more than peace with the enemy and your army can carry it."
    ),
    "attack": (
        "This attack would start a war with a civilization this seat is not yet fighting. Peace then "
        "needs the other side to agree, and the relationship, any shared endeavors and any trade "
        "routes between you end with it. Striking a lone scout on your border is rarely worth that."
    ),
    "start_diplomatic_action": (
        "Declaring war cannot be taken back by this seat alone: peace needs the other civilization to "
        "agree to it. Expect the relationship, any shared endeavors and any trade routes between you "
        "to end, and expect to be attacked. It is a real strategic option, not a mistake, but take it "
        "with a military that can hold what it takes, not on the strength of one good matchup."
    ),
}
DISBAND_GUIDANCE = CONFIRMATION_GUIDANCE["disband_unit"]

# The six generic unit commands, and whether each needs a target plot.
UNIT_COMMAND_KINDS = {"UPGRADE": False, "PACK_ARMY": False, "ADD_TO_ARMY": True,
                      "REMOVE_FROM_ARMY": True, "UNPACK_ARMY": True, "ACTIVATE_GREAT_PERSON": True,
                      "WAKE": False, "CANCEL": False, "PLUNDER_TRADE_ROUTE": False}

PUBLIC_KIND = {"SET_TECH_TREE_NODE": "research", "SET_CULTURE_TREE_NODE": "civic", "SET_TECH_TREE_TARGET_NODE": "research_goal", "SET_CULTURE_TREE_TARGET_NODE": "civic_goal", "END_TURN": "end_turn", "SKIP_UNIT": "skip_unit", "MOVE_UNIT": "move_unit", "PRODUCE_UNIT": "produce_unit", "PRODUCE_PROJECT": "produce_project", "FOUND_CITY": "found_city", "EXPAND_CITY": "expand_city", "PRODUCE_CONSTRUCTIBLE": "produce_constructible", "CHANGE_TRADITION": "activate_tradition", "CONSIDER_ASSIGN_TRADITIONS": "confirm_traditions", "CHOOSE_NARRATIVE_STORY_DIRECTION": "narrative_choice", "FOUND_PANTHEON": "found_pantheon", "CHANGE_GOVERNMENT": "change_government", "BUY_ATTRIBUTE_TREE_NODE": "buy_attribute", "CONSIDER_ASSIGN_ATTRIBUTE": "consider_attributes", "CHOOSE_GOLDEN_AGE": "choose_celebration", "ASSIGN_RESOURCE": "assign_resource", "CONSIDER_ASSIGN_RESOURCE": "consider_resources", "PROMOTE_UNIT": "promote_unit", "CHOOSE_TOWN_PROJECT": "town_project", "PURCHASE_UNIT": "purchase_unit", "PURCHASE_CONSTRUCTIBLE": "purchase_constructible", "UPGRADE_TOWN": "promote_town_to_city", "CHOOSE_AGE_CIVILIZATION": "choose_age_civilization", "SET_AGE_TRANSITION_DATA": "finish_age_transition", "ADVANCED_START_MODIFY_DECK": "pick_legacy_card", "ADVANCED_START_MARK_COMPLETED": "finish_legacy_deck", "RESPOND_DIPLOMATIC_FIRST_MEET": "greet_new_civilization", "MAKE_TRADE_ROUTE": "make_trade_route", "SEND_MERCHANT": "send_merchant", "KEEP_CITY": "keep_captured_city", "RAZE_CITY": "raze_captured_city", "LIBERATE_CITY": "liberate_captured_city",
               "CHOOSE_CITY_STATE_BONUS": "choose_city_state_bonus", "SUPPORT_DIPLOMATIC_ACTION": "support_diplomatic_action", "VIEWED_ADVISOR_WARNING": "acknowledge_advisor_warning", "DECLARE_WAR": "join_ally_war", "PROPOSE_PEACE": "propose_peace", "ACCEPT_PEACE": "accept_peace", "REJECT_PEACE": "reject_peace", "PILLAGE": "pillage", "COASTAL_RAID": "coastal_raid", "PILLAGE_ROUTE": "pillage_route", "PLUNDER_TRADE_ROUTE": "plunder_trade_route",
               "SPREAD_RELIGION": "spread_religion", "TOWN_GROWTH_MODE": "town_growth_mode", "QUEUE_REMOVE": "queue_remove", "QUEUE_MOVE_UP": "queue_move_up", "QUEUE_MOVE_DOWN": "queue_move_down",
               "DEACTIVATE_TRADITION": "deactivate_tradition", "UNASSIGN_RESOURCE": "unassign_resource", "SWAP_RESOURCES": "swap_resources", "WAKE": "wake_unit", "CANCEL": "cancel_order", "UNIT_ORDER": "unit_order", "DISBAND_UNIT": "disband_unit", "ASSIGN_WORKER": "assign_specialist", "CANCEL_ALLIANCE": "cancel_alliance", "ATTACK": "attack", "UPGRADE": "upgrade_unit", "PACK_ARMY": "pack_army", "ADD_TO_ARMY": "join_army",
               "REMOVE_FROM_ARMY": "leave_army", "UNPACK_ARMY": "unpack_army", "ACTIVATE_GREAT_PERSON": "activate_great_person", "RESPOND_DIPLOMATIC_ACTION": "respond_to_proposal", "FOUND_RELIGION": "found_religion", "ADD_BELIEF": "add_belief", "START_DIPLOMATIC_ACTION": "start_diplomatic_action"}
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
        self.shared = SharedState()
        self.state_dir = self.shared.dir
        self.lock_path = self.shared.lock_path
        self.unresolved_path = self.shared.unresolved_path
        self.inflight_path = self.shared.inflight_path
        self.quarantine_path = self.shared.dir / "quarantine.json"
        self.generations_path = self.shared.generations_path
        self._recovered: dict[str, dict[str, Any]] = {}
        # constructor: read-only; shared state is only written under the game lock
        self._load_journal()
        self._load_offers()

    @contextmanager
    def _locked(self):
        """One interprocess lock for the whole game: every registry, whatever journal it uses,
        serializes reload + check + reserve + dispatch + outcome against the shared instance."""
        with self.shared.locked():
            self._reload()
            yield

    def _reload(self) -> None:
        # read every shared file first: corruption must pause before the game is touched
        for path in (self.inflight_path, self.unresolved_path, self.generations_path):
            self._read_shared(path)
        self._offers = {}
        self._results = {}
        self._pending = set()
        self._load_journal()
        self._load_offers()
        # rows recovered as unknown become visible game-wide now that we hold the lock
        for rid, entry in list(self._recovered.items()):
            self._mark_unresolved(rid, entry)
            self._release_inflight(rid)
        self._recovered = {}

    # ---- shared, game-wide state (read/written only under the lock)
    def _read_shared(self, path: Path) -> dict[str, Any]:
        """Shared recovery state. Corruption must pause, never silently clear a barrier."""
        if not path.exists():
            return {}
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except ValueError as exc:
            raise ObserverError("STATE_CORRUPT", f"{path.name} is not valid JSON; repair or remove it deliberately before acting: {exc}") from exc
        if not isinstance(data, dict):
            raise ObserverError("STATE_CORRUPT", f"{path.name} does not hold an object")
        return data

    def _stale_inflight(self) -> dict[str, dict[str, Any]]:
        """Reservations with no recorded outcome. We hold the game lock, so every entry here
        belongs to a caller that died between reserving and journaling its result."""
        return {rid: rec for rid, rec in self._read_shared(self.inflight_path).items()
                if rid not in self._results or self._results[rid]["status"] == "unknown"}

    def _reserve_inflight(self, entry: dict[str, Any]) -> None:
        """Durable game-wide reservation written BEFORE anything is sent to the engine."""
        shared = self._read_shared(self.inflight_path)
        shared[entry["requestId"]] = {k: entry.get(k) for k in ("actionId", "kind", "arg", "arg2", "arg3", "pre", "seat", "match", "generation", "journal", "turn", "age")}
        shared[entry["requestId"]]["at"] = _now()
        self._write_shared(self.inflight_path, shared)

    def _reserve_and_journal(self, base: dict[str, Any]) -> None:
        """The two durable records that must exist before dispatch: the game-wide reservation
        and this seat's pending row. A crash after this point is visible to every other caller."""
        self._reserve_inflight({**base, "journal": str(self.journal_path)})
        self._journal({**base, "status": "pending", "at": _now()})
        self._pending.add(base["requestId"])

    def _release_inflight(self, request_id: str) -> None:
        shared = self._read_shared(self.inflight_path)
        if request_id in shared:
            del shared[request_id]
            self._write_shared(self.inflight_path, shared)

    def _write_shared(self, path: Path, data: dict[str, Any]) -> None:
        write_atomic(path, json.dumps(data))

    # An action whose outcome came back unknown twice for the same target is not tried a third time by a
    # seat on its own: live, a founding at one plot hung the script thread three times running while
    # the engine stayed responsive, and each retry cost a reconciliation. The record is per match and
    # per exact target, so the same kind elsewhere is unaffected, and a human lifts it deliberately.
    QUARANTINE_AFTER = 2

    def _quarantine_key(self, entry: dict[str, Any]) -> str:
        return ":".join(str(entry.get(k)) for k in ("match", "kind", "arg", "arg2", "arg3"))

    def _record_unknown(self, entry: dict[str, Any]) -> None:
        table = self._read_shared(self.quarantine_path)
        key = self._quarantine_key(entry)
        rec = table.get(key) or {"match": entry.get("match"), "kind": entry.get("kind"), "arg": entry.get("arg"),
                                 "arg2": entry.get("arg2"), "arg3": entry.get("arg3"), "seat": entry.get("seat"), "unknowns": 0, "requests": []}
        rec["unknowns"] += 1
        rec["requests"] = (rec["requests"] + [entry.get("requestId")])[-5:]
        rec["lastTurn"] = entry.get("turn")
        table[key] = rec
        self._write_shared(self.quarantine_path, table)

    def quarantined(self, match: str) -> dict[str, dict[str, Any]]:
        """Targets in this match that have gone unknown often enough to be withheld from seats."""
        table = self._read_shared(self.quarantine_path)
        return {k: v for k, v in table.items() if v.get("match") == match and v.get("unknowns", 0) >= self.QUARANTINE_AFTER}

    def lift_quarantine(self, match: str, kind: str, arg: int, arg2: int = 0, arg3: int = 0) -> bool:
        """A human decision: let seats try this exact action again."""
        with self._locked():
            table = self._read_shared(self.quarantine_path)
            key = ":".join(str(v) for v in (match, kind, arg, arg2, arg3))
            if key not in table:
                return False
            del table[key]
            self._write_shared(self.quarantine_path, table)
            return True

    def _mark_unresolved(self, request_id: str, entry: dict[str, Any]) -> None:
        shared = self._read_shared(self.unresolved_path)
        shared[request_id] = {"journal": str(self.journal_path), "match": entry.get("match"), "seat": entry.get("seat"), "kind": entry.get("kind"),
                              "generation": entry.get("generation"), "actionId": entry.get("actionId")}
        self._write_shared(self.unresolved_path, shared)

    def _clear_unresolved(self, request_id: str) -> None:
        shared = self._read_shared(self.unresolved_path)
        if request_id in shared:
            del shared[request_id]
            self._write_shared(self.unresolved_path, shared)

    def _base(self, action_id: str, request_id: str, player: int) -> dict[str, Any]:
        """The complete, resolved intent of one action: everything needed to recover it."""
        offer = self._offers[action_id]
        return {"requestId": request_id, "actionId": action_id, "kind": offer["kind"], "arg": offer["arg"],
                "arg2": offer.get("arg2", 0), "arg3": offer.get("arg3", 0), "pre": offer["pre"], "seat": player,
                "turn": offer["turn"], "age": offer["age"], "match": offer["match"], "generation": offer["generation"]}

    def _generation(self, gs: GameSession, *, advance: bool) -> tuple[int, bool]:
        return self.shared.generation(gs, advance=advance)

    def rebind(self, *, match: str, note: str) -> int:
        """Explicit host rebind (e.g. a same-turn reload the game cannot signal). Bumps the
        generation so every outstanding offer for the match is refused."""
        with self._locked():
            gen = self.shared.rebind(match, note=note)
            self._offers = {k: v for k, v in self._offers.items() if v.get("match") != match}
            self._save_offers()
            return gen

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
            self._recovered[rid] = self._results[rid]   # written to shared state under the lock, in _reload

    def _journal(self, entry: dict[str, Any]) -> None:
        self.journal_path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.journal_path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry) + "\n")

    def needs_reconciliation(self) -> list[str]:
        """Every uncertain write on this host: local unknowns, game-wide unknowns, and any
        in-flight reservation whose owner never recorded an outcome (crash after dispatch)."""
        local = {rid for rid, r in self._results.items() if r["status"] == "unknown"}
        shared = set(self._read_shared(self.unresolved_path))
        inflight = {rid for rid in self._read_shared(self.inflight_path) if rid not in self._results or self._results[rid]["status"] == "unknown"}
        return sorted(local | shared | inflight)

    def reconcile(self, request_id: str, status: str, *, note: str) -> None:
        with self._locked():
            self._reconcile(request_id, status, note=note)

    def _reconcile(self, request_id: str, status: str, *, note: str) -> None:
        if status not in ("confirmed", "rejected"):
            raise ValueError("reconcile status must be confirmed or rejected")
        prior = self._results.get(request_id)
        if prior is None:
            shared = self._read_shared(self.inflight_path).get(request_id) or self._read_shared(self.unresolved_path).get(request_id)
            if shared is None:
                raise ValueError(f"request {request_id!r} is not awaiting reconciliation")
            prior = {"requestId": request_id, **shared, "status": "unknown", "note": "recovered from game-wide state; owner journal not available"}
        if prior["status"] != "unknown":
            raise ValueError(f"request {request_id!r} is not awaiting reconciliation")
        entry = {k: v for k, v in prior.items() if k != "journal"}
        entry = {**entry, "status": status, "reconciled": True, "note": note, "at": _now()}
        self._results[request_id] = entry
        # The outcome belongs to the seat that made the request: write it to that seat's journal,
        # so its own view stops reporting an unknown outcome after someone else reconciles.
        owner = (self._read_shared(self.inflight_path).get(request_id) or self._read_shared(self.unresolved_path).get(request_id) or {}).get("journal")
        self._journal(entry)
        if owner and Path(owner) != self.journal_path:
            Path(owner).parent.mkdir(parents=True, exist_ok=True)
            with open(owner, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(entry) + "\n")
        self._clear_unresolved(request_id)
        self._release_inflight(request_id)

    def get_result(self, request_id: str) -> dict[str, Any] | None:
        with self._locked():
            return self._result_unlocked(request_id)

    def _result_unlocked(self, request_id: str) -> dict[str, Any] | None:
        rec = self._results.get(request_id)
        if rec is not None:
            return rec
        stale = self._stale_inflight().get(request_id)
        if stale is not None:
            return {**stale, "status": "unknown", "note": "reservation found without an outcome (process ended mid-action)"}
        shared = self._read_shared(self.unresolved_path).get(request_id)
        if shared is not None:
            return {**shared, "requestId": request_id, "status": "unknown"}
        return None

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
        generation, reattached = self._generation(gs, advance=True)
        public = []
        quarantined = self.quarantined(gs.context.game_guid)
        for o in offers:
            kind = o.get("kind")
            if kind not in PUBLIC_KIND or not isinstance(o.get("arg"), int) or not isinstance(o.get("canStart"), bool) or not isinstance(o.get("pre"), int):
                raise ObserverError("API_CONTRACT_MISMATCH", "offer entry malformed")
            action_id = secrets.token_urlsafe(18)
            rec = {"kind": kind, "arg": o["arg"], "pre": o["pre"], "seat": player, "turn": gs.context.turn, "age": gs.context.age,
                   "match": gs.context.game_guid, "generation": generation, "target": gs.doctor.selected["id"], "canStart": o["canStart"]}
            if kind == "MAKE_TRADE_ROUTE" and isinstance(o.get("activeRoutes"), int):
                rec["activeRoutes"] = o["activeRoutes"]
            entry = {"actionId": action_id, "kind": PUBLIC_KIND[kind], "canStart": o["canStart"]}
            if kind in ("MOVE_UNIT", "SKIP_UNIT", "FOUND_CITY", "PROMOTE_UNIT", "MAKE_TRADE_ROUTE", "UNIT_ORDER"):
                if isinstance(o.get("unitId"), int):
                    entry["unitId"] = o["unitId"]
                if "damage" in o:
                    entry["damage"] = o["damage"]
                if isinstance(o.get("from"), dict):
                    entry["from"] = o["from"]
            if kind == "MOVE_UNIT":
                if not isinstance(o.get("x"), int) or not isinstance(o.get("y"), int):
                    raise ObserverError("API_CONTRACT_MISMATCH", "move offer without coordinates")
                rec["arg2"], rec["arg3"] = o["x"], o["y"]
                entry["to"] = {"x": o["x"], "y": o["y"]}
                if isinstance(o.get("direction"), int):
                    entry["direction"] = o["direction"]
                for k in ("terrainKey", "pathTurns", "steps", "featureKey", "river", "yields", "tooCloseToSettle"):
                    if k in o:
                        entry[k] = o[k]
            if kind == "FOUND_CITY":
                if not isinstance(o.get("x"), int) or not isinstance(o.get("y"), int):
                    raise ObserverError("API_CONTRACT_MISMATCH", "found-city offer without coordinates")
                rec["arg2"], rec["arg3"] = o["x"], o["y"]
                for k in ("terrainKey", "reason", "featureKey", "river", "yields", "tooCloseToSettle"):
                    if k in o:
                        entry[k] = o[k]
            if kind == "EXPAND_CITY":
                if not isinstance(o.get("x"), int) or not isinstance(o.get("y"), int):
                    raise ObserverError("API_CONTRACT_MISMATCH", "expand offer without coordinates")
                rec["arg2"], rec["arg3"] = o["x"], o["y"]
                entry["to"] = {"x": o["x"], "y": o["y"]}
                for k in ("cityId", "cityName", "plotIndex", "growthReady", "improvementKey", "terrainKey", "featureKey", "river", "yields"):
                    if k in o:
                        entry[k] = o[k]
            if kind == "PRODUCE_CONSTRUCTIBLE":
                if not isinstance(o.get("arg2"), int) or not isinstance(o.get("arg3"), int) or not isinstance(o.get("x"), int) or not isinstance(o.get("y"), int):
                    raise ObserverError("API_CONTRACT_MISMATCH", "constructible offer without a type and placement plot")
                rec["arg2"], rec["arg3"] = o["arg2"], o["arg3"]
                entry["to"] = {"x": o["x"], "y": o["y"]}
                for k in ("cityId", "cityName", "constructibleKey", "constructibleClass", "plotIndex", "placement", "terrainKey", "featureKey", "river", "yields", "queue", "queueLength"):
                    if k in o:
                        entry[k] = o[k]
            if kind == "BUY_ATTRIBUTE_TREE_NODE":
                for k in ("attribute", "attributeName", "description", "availablePoints", "wildcardPoints"):
                    if k in o:
                        entry[k] = o[k]
            if kind == "CHANGE_GOVERNMENT":
                if not isinstance(o.get("arg2"), int):
                    raise ObserverError("API_CONTRACT_MISMATCH", "government offer without a type hash")
                rec["arg2"] = o["arg2"]
                for k in ("description", "celebration", "effects", "unlocksTraditions"):
                    if k in o:
                        entry[k] = o[k]
            if kind in ("FOUND_PANTHEON", "CHOOSE_GOLDEN_AGE") and "description" in o:
                entry["description"] = o["description"]
            if kind == "CHOOSE_NARRATIVE_STORY_DIRECTION":
                if not isinstance(o.get("arg2"), int):
                    raise ObserverError("API_CONTRACT_MISMATCH", "narrative offer without an answer hash")
                rec["arg2"] = o["arg2"]
                for k in ("storyId", "storyKey", "title", "body", "answerKey", "option", "reward", "action", "costYield", "affordable"):
                    if k in o:
                        entry[k] = o[k]
            if kind == "UNIT_ORDER":
                if not isinstance(o.get("arg2"), int):
                    raise ObserverError("API_CONTRACT_MISMATCH", "unit order offer without an operation")
                rec["arg2"] = o["arg2"]
                for k in ("orderKey", "description", "damage", "maxDamage"):
                    if k in o:
                        entry[k] = o[k]
            if kind in ("MAKE_TRADE_ROUTE", "SEND_MERCHANT"):
                if not isinstance(o.get("arg2"), int) or not isinstance(o.get("arg3"), int):
                    raise ObserverError("API_CONTRACT_MISMATCH", "trade offer without a target plot")
                rec["arg2"], rec["arg3"] = o["arg2"], o["arg3"]
                if isinstance(o.get("from"), dict):
                    rec["fromXY"] = [o["from"].get("x"), o["from"].get("y")]
                for k in ("unitId", "from", "to", "unitTypeKey", "cityName", "targetPlayerId", "domain",
                          "routeLength", "activeRoutes", "inRange", "pathTurns"):
                    if o.get(k) is not None:
                        entry[k] = o[k]
            if kind == "RESPOND_DIPLOMATIC_FIRST_MEET":
                if not isinstance(o.get("arg2"), int) or not isinstance(o.get("arg3"), int):
                    raise ObserverError("API_CONTRACT_MISMATCH", "first meet offer without its player and notification")
                rec["arg2"], rec["arg3"] = o["arg2"], o["arg3"]
                for k in ("greeting", "otherPlayer", "influenceCost", "influenceBalance", "note"):
                    if k in o:
                        entry[k] = o[k]
            if kind in ("ADVANCED_START_MODIFY_DECK", "ADVANCED_START_MARK_COMPLETED"):
                for k in ("cardId", "description", "cost", "pointsAvailable", "needsPlacement", "effectCount", "deck"):
                    if k in o:
                        entry[k] = o[k]
            if kind == "CHOOSE_AGE_CIVILIZATION":
                for k in ("fullName", "description", "historical", "selected", "invalidReason"):
                    if k in o:
                        entry[k] = o[k]
            if kind == "SET_AGE_TRANSITION_DATA" and "selectedCivilization" in o:
                entry["selectedCivilization"] = o["selectedCivilization"]
            if kind in ("SET_TECH_TREE_TARGET_NODE", "SET_CULTURE_TREE_TARGET_NODE"):
                for k in ("typeKey", "displayName", "tree", "cost", "turns", "currentTarget"):
                    if k in o:
                        entry[k] = o[k]
            if kind in UNIT_COMMAND_KINDS:
                if UNIT_COMMAND_KINDS[kind]:
                    if not isinstance(o.get("arg2"), int) or not isinstance(o.get("arg3"), int):
                        raise ObserverError("API_CONTRACT_MISMATCH", f"{kind} offer without a target plot")
                    rec["arg2"], rec["arg3"] = o["arg2"], o["arg3"]
                rec["expect"] = o.get("expect")
                for k in ("unitId", "unitTypeKey", "from", "to", "plotIndex", "description", "armyId",
                          "isCommander", "expect", "terrainKey"):
                    if o.get(k) is not None:
                        entry[k] = o[k]
                if kind == "ACTIVATE_GREAT_PERSON":
                    rec["requiresConfirmation"] = True
                    entry["destructive"] = True
                    entry["requiresConfirmation"] = True
                    entry["guidance"] = CONFIRMATION_GUIDANCE["activate_great_person"]
            if kind in ("KEEP_CITY", "RAZE_CITY", "LIBERATE_CITY"):
                for k in ("cityId", "cityName", "population", "wonders", "isTown", "destructive", "requiresConfirmation"):
                    if o.get(k) is not None:
                        entry[k] = o[k]
                if kind != "KEEP_CITY":
                    rec["requiresConfirmation"] = True
                    entry["guidance"] = CONFIRMATION_GUIDANCE[PUBLIC_KIND[kind]]
            if kind == "CHOOSE_CITY_STATE_BONUS":
                if not isinstance(o.get("arg2"), int):
                    raise ObserverError("API_CONTRACT_MISMATCH", "bonus offer without its city-state")
                rec["arg2"] = o["arg2"]
                for k in ("typeKey", "displayName", "description", "cityStatePlayerId"):
                    if o.get(k) is not None:
                        entry[k] = o[k]
            if kind == "SUPPORT_DIPLOMATIC_ACTION":
                if not isinstance(o.get("arg2"), int):
                    raise ObserverError("API_CONTRACT_MISMATCH", "support offer without a side")
                rec["arg2"] = o["arg2"]
                for k in ("eventId", "side", "typeKey", "displayName", "initiatorPlayerId", "targetPlayerId", "support",
                          "cost", "costYield", "influenceBalance", "affordable"):
                    if o.get(k) is not None:
                        entry[k] = o[k]
            if kind == "VIEWED_ADVISOR_WARNING":
                if not isinstance(o.get("arg2"), int):
                    raise ObserverError("API_CONTRACT_MISMATCH", "warning offer without its notification type")
                rec["arg2"] = o["arg2"]
                for k in ("typeKey", "notificationId"):
                    if o.get(k) is not None:
                        entry[k] = o[k]
            if kind in ("PILLAGE", "COASTAL_RAID", "PILLAGE_ROUTE", "SPREAD_RELIGION"):
                if not isinstance(o.get("arg2"), int) or not isinstance(o.get("arg3"), int):
                    raise ObserverError("API_CONTRACT_MISMATCH", f"{kind} offer without a target plot")
                rec["arg2"], rec["arg3"] = o["arg2"], o["arg3"]
                for k in ("unitId", "unitTypeKey", "from", "to", "plotIndex", "movesLeft", "charges", "terrainKey"):
                    if o.get(k) is not None:
                        entry[k] = o[k]
            if kind == "TOWN_GROWTH_MODE":
                for k in ("cityId", "cityName", "currentProject", "currentProjectKey"):
                    if o.get(k) is not None:
                        entry[k] = o[k]
            if kind in ("QUEUE_REMOVE", "QUEUE_MOVE_UP", "QUEUE_MOVE_DOWN"):
                if not isinstance(o.get("arg2"), int) or not isinstance(o.get("arg3"), int):
                    raise ObserverError("API_CONTRACT_MISMATCH", "queue offer without a position and item")
                rec["arg2"], rec["arg3"] = o["arg2"], o["arg3"]
                for k in ("cityId", "cityName", "position", "toPosition", "itemKey", "queue"):
                    if o.get(k) is not None:
                        entry[k] = o[k]
            if kind == "DEACTIVATE_TRADITION":
                for k in ("typeKey", "slot", "displayName", "description"):
                    if o.get(k) is not None:
                        entry[k] = o[k]
            if kind in ("UNASSIGN_RESOURCE", "SWAP_RESOURCES"):
                if not isinstance(o.get("arg2"), int):
                    raise ObserverError("API_CONTRACT_MISMATCH", "resource offer without its counterpart")
                rec["arg2"] = o["arg2"]
                for k in ("plotIndex", "cityId", "cityName", "resourceKey", "otherResourceKey", "otherCityName", "otherCityId"):
                    if o.get(k) is not None:
                        entry[k] = o[k]
            if kind == "ATTACK":
                if not isinstance(o.get("arg2"), int) or not isinstance(o.get("arg3"), int):
                    raise ObserverError("API_CONTRACT_MISMATCH", "attack offer without a target plot")
                rec["arg2"], rec["arg3"] = o["arg2"], o["arg3"]
                for k in ("unitId", "unitTypeKey", "from", "to", "plotIndex", "ranged", "attacksRemaining",
                          "strength", "rangedStrength", "damage", "maxDamage", "defender", "startsWar",
                          "destructive", "requiresConfirmation", "terrainKey"):
                    if o.get(k) is not None:
                        entry[k] = o[k]
                if o.get("requiresConfirmation"):
                    rec["requiresConfirmation"] = True
                    entry["guidance"] = CONFIRMATION_GUIDANCE["attack"]
            if kind == "ASSIGN_WORKER":
                if not isinstance(o.get("arg2"), int):
                    raise ObserverError("API_CONTRACT_MISMATCH", "specialist offer without a plot")
                rec["arg2"] = o["arg2"]
                for k in ("cityId", "cityName", "plotIndex", "x", "y", "workers", "maxWorkers",
                          "cityWorkers", "cityWorkerCap", "yields", "yieldsNext", "upkeep", "upkeepNext", "terrainKey"):
                    if k in o:
                        entry[k] = o[k]
            if kind == "DISBAND_UNIT":
                rec["requiresConfirmation"] = True
                for k in ("unitId", "unitTypeKey", "from", "destructive", "requiresConfirmation", "warning"):
                    if k in o:
                        entry[k] = o[k]
                entry["guidance"] = CONFIRMATION_GUIDANCE["disband_unit"]
            if kind == "START_DIPLOMATIC_ACTION":
                if not isinstance(o.get("arg2"), int):
                    raise ObserverError("API_CONTRACT_MISMATCH", "diplomatic offer without an action type")
                rec["arg2"] = o["arg2"]
                if isinstance(o.get("arg3"), int):
                    rec["arg3"] = o["arg3"]
                rec["expect"] = o.get("expect")
                for k in ("typeKey", "displayName", "targetPlayerId", "targetName", "targetIsMajor", "secondary",
                          "group", "cost", "costYield", "influenceBalance", "affordable", "expect",
                          "destructive", "requiresConfirmation"):
                    if o.get(k) is not None:
                        entry[k] = o[k]
                if o.get("requiresConfirmation"):
                    rec["requiresConfirmation"] = True
                    entry["guidance"] = CONFIRMATION_GUIDANCE["start_diplomatic_action"]
            if kind in ("FOUND_RELIGION", "ADD_BELIEF"):
                for k in ("typeKey", "displayName", "description", "beliefClass"):
                    if o.get(k) is not None:
                        entry[k] = o[k]
            if kind == "RESPOND_DIPLOMATIC_ACTION":
                if not isinstance(o.get("arg2"), int):
                    raise ObserverError("API_CONTRACT_MISMATCH", "proposal response without a response type")
                rec["arg2"] = o["arg2"]
                for k in ("eventId", "answer", "typeKey", "displayName", "description", "proposerPlayerId", "proposerName"):
                    if o.get(k) is not None:
                        entry[k] = o[k]
            if kind in ("PROPOSE_PEACE", "ACCEPT_PEACE", "REJECT_PEACE"):
                for k in ("targetPlayerId", "targetName", "targetIsMajor", "dealItems"):
                    if o.get(k) is not None:
                        entry[k] = o[k]
            if kind == "DECLARE_WAR":
                if not isinstance(o.get("arg2"), int):
                    raise ObserverError("API_CONTRACT_MISMATCH", "call-to-arms offer without its event")
                rec["arg2"] = o["arg2"]
                rec["requiresConfirmation"] = True
                for k in ("callToArms", "allyPlayerId", "allyName", "targetPlayerId", "targetName", "destructive", "requiresConfirmation"):
                    if o.get(k) is not None:
                        entry[k] = o[k]
                entry["guidance"] = CONFIRMATION_GUIDANCE["join_ally_war"]
            if kind == "CANCEL_ALLIANCE":
                for k in ("targetPlayerId", "targetName", "targetIsMajor", "displayName"):
                    if k in o:
                        entry[k] = o[k]
            if kind == "PRODUCE_PROJECT":
                if not isinstance(o.get("arg2"), int):
                    raise ObserverError("API_CONTRACT_MISMATCH", "project offer without a project type")
                rec["arg2"] = o["arg2"]
                for k in ("cityId", "cityName", "typeKey", "displayName", "description", "turns", "queue", "queueLength"):
                    if k in o:
                        entry[k] = o[k]
            if kind == "PURCHASE_CONSTRUCTIBLE":
                if not isinstance(o.get("arg2"), int) or not isinstance(o.get("arg3"), int):
                    raise ObserverError("API_CONTRACT_MISMATCH", "purchase offer without a constructible and plot")
                rec["arg2"] = o["arg2"]
                rec["arg3"] = o["arg3"]
                for k in ("cityId", "cityName", "constructibleKey", "constructibleClass", "displayName",
                          "cost", "goldBalance", "affordable", "plotIndex", "placement", "x", "y"):
                    if k in o:
                        entry[k] = o[k]
            if kind == "UPGRADE_TOWN":
                for k in ("cityId", "cityName", "cost", "goldBalance", "affordable"):
                    if k in o:
                        entry[k] = o[k]
            if kind == "PURCHASE_UNIT":
                if not isinstance(o.get("arg2"), int):
                    raise ObserverError("API_CONTRACT_MISMATCH", "purchase offer without a unit type")
                rec["arg2"] = o["arg2"]
                for k in ("cityId", "cityName", "unitTypeKey", "displayName", "cost", "goldBalance"):
                    if k in o:
                        entry[k] = o[k]
            if kind == "CHOOSE_TOWN_PROJECT":
                if not isinstance(o.get("arg2"), int):
                    raise ObserverError("API_CONTRACT_MISMATCH", "town project offer without a project")
                rec["arg2"] = o["arg2"]
                for k in ("cityId", "cityName", "description", "townDefault", "upgradeToCity"):
                    if k in o:
                        entry[k] = o[k]
            if kind == "PROMOTE_UNIT":
                if not isinstance(o.get("arg2"), int) or not isinstance(o.get("arg3"), int):
                    raise ObserverError("API_CONTRACT_MISMATCH", "promotion offer without a promotion and discipline")
                rec["arg2"], rec["arg3"] = o["arg2"], o["arg3"]
                for k in ("discipline", "disciplineName", "description", "commendation", "promotionsEarned", "promotionPoints", "commendationPoints", "unitLevel"):
                    if k in o:
                        entry[k] = o[k]
            if kind == "ASSIGN_RESOURCE":
                if not isinstance(o.get("arg2"), int):
                    raise ObserverError("API_CONTRACT_MISMATCH", "resource offer without a city")
                rec["arg2"] = o["arg2"]
                for k in ("plotIndex", "from", "resourceKey", "resourceClass", "description", "assignedCityId", "originCityName", "cityId", "cityName", "cityIsTown", "cityCap", "cityAssigned", "toAssign"):
                    if k in o:
                        entry[k] = o[k]
            if kind == "CONSIDER_ASSIGN_RESOURCE":
                for k in ("toAssign", "assignable"):
                    if k in o:
                        entry[k] = o[k]
            if kind == "CONSIDER_ASSIGN_TRADITIONS":
                for k in ("slotsFreeAny", "activatable", "pendingBySlot"):
                    if k in o:
                        entry[k] = o[k]
            if kind == "CHANGE_TRADITION":
                if not isinstance(o.get("arg2"), int):
                    raise ObserverError("API_CONTRACT_MISMATCH", "tradition offer without a type hash")
                rec["arg2"] = o["arg2"]
                for k in ("slot", "slotsTotal", "slotsFree", "slotsFreeAny", "description", "isCrisis"):
                    if k in o:
                        entry[k] = o[k]
            if kind == "PRODUCE_UNIT":
                if not isinstance(o.get("arg2"), int):
                    raise ObserverError("API_CONTRACT_MISMATCH", "produce offer without a unit type")
                rec["arg2"] = o["arg2"]
                for k in ("cityId", "cityName", "unitTypeKey", "displayName", "turns", "queue", "queueLength"):
                    if k in o:
                        entry[k] = o[k]
            # Keyed on the arguments as bound, not as offered: a founding carries its plot as x/y until here
            # (live: the first quarantine keyed on the raw offer and let the hung plot through a fifth time).
            qkey = ":".join(str(v) for v in (gs.context.game_guid, kind, rec.get("arg"), rec.get("arg2", 0), rec.get("arg3", 0)))
            if qkey in quarantined:
                rec["canStart"] = entry["canStart"] = False
                entry["quarantined"] = True
                entry["reason"] = (f"withheld: this exact action came back unknown {quarantined[qkey]['unknowns']} times in this match "
                                   f"(a human can lift the quarantine); choose another target")

            self._offers[action_id] = rec
            for k in ("typeKey", "displayName", "tree", "cost", "turns", "blockingType", "alreadySent", "unitTypeKey", "movesRemaining", "location"):
                if k in o:
                    entry[k] = o[k]
            public.append(entry)
        # offers from earlier turns or other matches can never be performed; drop them so the file stays small
        self._offers = {k: v for k, v in self._offers.items() if (v.get("turn"), v.get("age"), v.get("match"), v.get("generation")) == (gs.context.turn, gs.context.age, gs.context.game_guid, generation)}
        self._save_offers()
        unit_ids = ctx.get("unitIds")
        attachment = {"match": gs.context.game_guid, "generation": generation, "seat": player, "turn": gs.context.turn, "age": gs.context.age}
        return {"context": ctx, "offers": public, "generation": generation, "reattached": reattached, "attachment": attachment,
                "unitIds": unit_ids if isinstance(unit_ids, list) else None, "reconciliationRequired": self.needs_reconciliation()}

    # ---- perform
    def perform(self, gs: GameSession, *, action_id: str, request_id: str, player: int, mode: str, confirm: bool = False) -> dict[str, Any]:
        with self._locked():
            return self._perform(gs, action_id=action_id, request_id=request_id, player=player, mode=mode, confirm=confirm)

    def _perform(self, gs: GameSession, *, action_id: str, request_id: str, player: int, mode: str, confirm: bool = False) -> dict[str, Any]:
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
        generation, _ = self._generation(gs, advance=True)
        if (offer.get("turn"), offer.get("age"), offer.get("match"), offer.get("generation")) != (gs.context.turn, gs.context.age, gs.context.game_guid, generation) or not gs.context.game_guid:
            raise ObserverError("ACTION_EXPIRED", "the offer was made on a different turn, match or attachment generation; request fresh offers")
        if not offer["canStart"]:
            raise ObserverError("ACTION_NOT_STARTABLE", "the offer was not startable when enumerated; request fresh offers")
        # Destroying something the seat owns is not an ordinary move, so it is refused unless the
        # caller asks for it in as many words. The engine raises the same flag on its own command.
        if offer.get("requiresConfirmation") and confirm is not True:
            raise ObserverError("CONFIRMATION_REQUIRED", DISBAND_GUIDANCE + " Pass confirm=true to this call if that is really what you want.")
        base = self._base(action_id, request_id, player)
        self._reserve_and_journal(base)
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
            turn, age, seat, observer = rb.get("turn"), rb.get("age"), rb.get("localPlayerId"), rb.get("localObserverId")
            if not all(isinstance(v, int) and not isinstance(v, bool) for v in (turn, age, seat, observer)):
                continue
            effect: dict[str, Any] | None = None
            if kind == "SET_AGE_TRANSITION_DATA":
                # finishing the transition can hand the seat over or change the age itself
                notes = rb.get("blockingNotifications")
                if (turn, age, seat, observer) == (offer["turn"], offer["age"], player, player) and (
                        rb.get("endTurnBlocking") == "NONE" or (isinstance(notes, list) and "NOTIFICATION_CHOOSE_CIVILIZATION" not in notes)):
                    effect = {"civilizationChoiceClosed": True, "endTurnBlocking": rb.get("endTurnBlocking")}
                elif age != offer["age"]:
                    effect = {"ageAdvancedTo": age}
                elif seat != player and turn >= offer["turn"]:
                    effect = {"seatHandedOffTo": seat}
                elif turn > offer["turn"]:
                    effect = {"turnAdvancedTo": turn}
            elif kind == "END_TURN":
                # positively identified progression only: completion flagged on the same seat/turn,
                # the turn counter advanced, or the seat handed off to another integer seat
                if rb.get("hasSentTurnComplete") is True and seat == player and turn == offer["turn"]:
                    effect = {"hasSentTurnComplete": True}
                elif turn > offer["turn"]:
                    effect = {"turnAdvancedTo": turn}
                elif seat != player and turn >= offer["turn"]:
                    effect = {"seatHandedOffTo": seat}
            elif (turn, age, seat, observer) == (offer["turn"], offer["age"], player, player):
                # ordinary actions: the complete originating context must still hold
                if kind == "SET_TECH_TREE_NODE" and rb.get("techResearching") == offer["arg"]:
                    effect = {"techResearching": offer["arg"]}
                elif kind == "SET_CULTURE_TREE_NODE" and rb.get("civicResearching") == offer["arg"]:
                    effect = {"civicResearching": offer["arg"]}
                elif kind in ("SKIP_UNIT", "UNIT_ORDER"):
                    ready = rb.get("unitsReadyToMove")
                    if isinstance(ready, list) and offer["arg"] not in ready:
                        effect = {"unitNoLongerReady": offer["arg"]}
                elif kind == "MOVE_UNIT":
                    locs = rb.get("unitLocations")
                    if isinstance(locs, dict) and locs.get(str(offer["arg"])) == [offer["arg2"], offer["arg3"]]:
                        effect = {"unitLocation": {"unitId": offer["arg"], "x": offer["arg2"], "y": offer["arg3"]}}
                elif kind == "FOUND_CITY":
                    cities = rb.get("cityLocations")
                    if isinstance(cities, dict) and [offer["arg2"], offer["arg3"]] in cities.values():
                        effect = {"settlementFounded": {"unitId": offer["arg"], "x": offer["arg2"], "y": offer["arg3"]}}
                elif kind == "EXPAND_CITY":
                    plots = rb.get("expandPlots")
                    if isinstance(plots, dict) and isinstance(plots.get(str(offer["arg"])), list) and offer["pre"] not in plots[str(offer["arg"])]:
                        effect = {"populationPlaced": {"cityId": offer["arg"], "x": offer["arg2"], "y": offer["arg3"], "plotIndex": offer["pre"]}}
                elif kind == "ADVANCED_START_MODIFY_DECK":
                    deck = rb.get("legacyDeck")
                    if isinstance(deck, list) and offer["arg"] in deck:
                        effect = {"legacyCardAdded": offer["arg"]}
                elif kind == "MAKE_TRADE_ROUTE":
                    active = rb.get("tradeRoutes")
                    before = offer.get("activeRoutes")
                    if isinstance(active, int) and not isinstance(active, bool) and isinstance(before, int) and active > before:
                        effect = {"tradeRouteStarted": {"unitId": offer["arg"], "x": offer["arg2"], "y": offer["arg3"], "routes": active}}
                elif kind == "RESPOND_DIPLOMATIC_FIRST_MEET":
                    notes = rb.get("blockingNotifications")
                    if isinstance(notes, list) and "NOTIFICATION_PLAYER_MET" not in notes:
                        effect = {"firstMeetAnswered": offer["arg2"]}
                elif kind == "ADVANCED_START_MARK_COMPLETED":
                    notes = rb.get("blockingNotifications")
                    if isinstance(notes, list) and "NOTIFICATION_AGE_TRANSITION" not in notes:
                        effect = {"legacyDeckCompleted": True}
                elif kind == "CHOOSE_AGE_CIVILIZATION":
                    chosen = rb.get("ageTransitionCivilization")
                    if isinstance(chosen, str) and chosen == (readback.get("civilization") if isinstance(readback, dict) else None):
                        effect = {"ageTransitionCivilization": chosen}
                elif kind in ("SET_TECH_TREE_TARGET_NODE", "SET_CULTURE_TREE_TARGET_NODE"):
                    held = rb.get("techTargetNode" if kind == "SET_TECH_TREE_TARGET_NODE" else "civicTargetNode")
                    if isinstance(held, int) and not isinstance(held, bool) and held == offer["arg"]:
                        effect = {"treeGoal": {"kind": PUBLIC_KIND[kind], "node": offer["arg"]}}
                elif kind in UNIT_COMMAND_KINDS:
                    # Each command moves a different thing; the offer said which, so the confirmation
                    # looks at that one and nothing else.
                    want = offer.get("expect")
                    unit_key = str(offer["arg"])
                    if want == "gone":
                        locs = rb.get("unitLocations")
                        if isinstance(locs, dict) and unit_key not in locs:
                            effect = {"greatPersonActivated": {"unitId": offer["arg"]}}
                    else:
                        field = {"type": "unitTypes", "army": "unitArmies", "armySize": "armySizes"}.get(want)
                        table = rb.get(field) if field else None
                        now = table.get(unit_key) if isinstance(table, dict) else None
                        if isinstance(now, int) and not isinstance(now, bool) and now != offer["pre"]:
                            effect = {"unitCommand": {"unitId": offer["arg"], "command": PUBLIC_KIND[kind],
                                                      "was": offer["pre"], "now": now}}
                elif kind == "SEND_MERCHANT":
                    # The merchant set off: it is somewhere other than where it stood. Arrival is a
                    # later turn's business; the route itself is made on arrival by make_trade_route.
                    locs = rb.get("unitLocations")
                    now = locs.get(str(offer["arg"])) if isinstance(locs, dict) else None
                    if isinstance(now, list) and now != offer.get("fromXY"):
                        effect = {"merchantSent": {"unitId": offer["arg"], "toward": [offer["arg2"], offer["arg3"]], "now": now}}
                elif kind in ("KEEP_CITY", "RAZE_CITY", "LIBERATE_CITY"):
                    pending, razing, ids = rb.get("capturedPending"), rb.get("razing"), rb.get("cityIds")
                    cid = offer["arg"]
                    if kind == "KEEP_CITY" and isinstance(pending, list) and isinstance(ids, list) and cid in ids and cid not in pending and cid not in (razing or []):
                        effect = {"cityKept": {"cityId": cid}}
                    elif kind == "RAZE_CITY" and isinstance(razing, list) and cid in razing:
                        effect = {"cityRazing": {"cityId": cid}}
                    elif kind == "LIBERATE_CITY" and isinstance(ids, list) and cid not in ids:
                        effect = {"cityLiberated": {"cityId": cid}}
                elif kind == "CHOOSE_CITY_STATE_BONUS":
                    pending = rb.get("cityStateBonusPending")
                    if isinstance(pending, int) and not isinstance(pending, bool) and pending != offer["arg2"]:
                        effect = {"cityStateBonusChosen": {"cityStatePlayerId": offer["arg2"], "bonus": offer["arg"]}}
                elif kind == "SUPPORT_DIPLOMATIC_ACTION":
                    inf = rb.get("influenceBalance")
                    if isinstance(inf, int) and not isinstance(inf, bool) and inf < offer["pre"]:
                        effect = {"diplomaticActionSupported": {"eventId": offer["arg"], "side": "initiator" if offer["arg2"] == 1 else "target", "influenceSpent": offer["pre"] - inf}}
                elif kind == "VIEWED_ADVISOR_WARNING":
                    warnings = rb.get("advisorWarnings")
                    if isinstance(warnings, list) and offer["arg"] not in warnings:
                        effect = {"advisorWarningAcknowledged": {"notificationId": offer["arg"]}}
                elif kind in ("PILLAGE", "COASTAL_RAID", "PILLAGE_ROUTE"):
                    moves = rb.get("unitMoves")
                    now = moves.get(str(offer["arg"])) if isinstance(moves, dict) else None
                    if isinstance(now, int) and not isinstance(now, bool) and now < offer["pre"]:
                        effect = {"pillaged": {"unitId": offer["arg"], "x": offer["arg2"], "y": offer["arg3"], "kind": PUBLIC_KIND[kind]}}
                elif kind == "SPREAD_RELIGION":
                    charges = rb.get("unitCharges")
                    now = charges.get(str(offer["arg"])) if isinstance(charges, dict) else None
                    if isinstance(now, int) and not isinstance(now, bool) and now < offer["pre"]:
                        effect = {"religionSpread": {"unitId": offer["arg"], "x": offer["arg2"], "y": offer["arg3"], "chargesLeft": now}}
                elif kind == "TOWN_GROWTH_MODE":
                    projects = rb.get("townProjects")
                    if isinstance(projects, dict) and projects.get(str(offer["arg"])) == -1:
                        effect = {"townGrowing": {"cityId": offer["arg"]}}
                elif kind in ("QUEUE_REMOVE", "QUEUE_MOVE_UP", "QUEUE_MOVE_DOWN"):
                    queues = rb.get("cityQueues")
                    q = queues.get(str(offer["arg"])) if isinstance(queues, dict) else None
                    if isinstance(q, list):
                        if kind == "QUEUE_REMOVE" and len(q) == offer["pre"] - 1:
                            effect = {"queueEdited": {"cityId": offer["arg"], "removedAt": offer["arg2"]}}
                        elif kind != "QUEUE_REMOVE":
                            dest = offer["arg2"] - 1 if kind == "QUEUE_MOVE_UP" else offer["arg2"] + 1
                            if 0 <= dest < len(q) and q[dest] == offer["arg3"]:
                                effect = {"queueEdited": {"cityId": offer["arg"], "movedTo": dest}}
                elif kind == "DEACTIVATE_TRADITION":
                    active = rb.get("activeTraditions")
                    if isinstance(active, list) and offer["arg"] not in active:
                        effect = {"traditionDeactivated": {"tradition": offer["arg"]}}
                elif kind in ("UNASSIGN_RESOURCE", "SWAP_RESOURCES"):
                    homes = rb.get("resourceAssignments")
                    home = homes.get(str(offer["arg"])) if isinstance(homes, dict) else None
                    if kind == "UNASSIGN_RESOURCE" and isinstance(homes, dict) and str(offer["arg"]) not in homes:
                        effect = {"resourceUnassigned": {"plotIndex": offer["arg"], "fromCityId": offer["pre"]}}
                    elif kind == "SWAP_RESOURCES" and isinstance(home, int) and home != offer["pre"]:
                        effect = {"resourcesSwapped": {"plotIndex": offer["arg"], "otherPlotIndex": offer["arg2"], "nowInCityId": home}}
                elif kind == "ATTACK":
                    # A strike spends the unit's attack for the turn whatever the outcome, and nothing
                    # else spends it, so the counter falling is the proof the blow was actually thrown.
                    attacks = rb.get("unitAttacks")
                    left = attacks.get(str(offer["arg"])) if isinstance(attacks, dict) else None
                    if isinstance(left, int) and not isinstance(left, bool) and left < offer["pre"]:
                        effect = {"attacked": {"unitId": offer["arg"], "x": offer["arg2"], "y": offer["arg3"],
                                               "attacksRemaining": left}}
                elif kind == "ASSIGN_WORKER":
                    plots = rb.get("specialistPlots")
                    now = plots.get(str(offer["arg2"])) if isinstance(plots, dict) else None
                    if isinstance(now, int) and not isinstance(now, bool) and now > offer["pre"]:
                        effect = {"specialistAssigned": {"cityId": offer["arg"], "plotIndex": offer["arg2"], "workers": now}}
                elif kind == "DISBAND_UNIT":
                    locs = rb.get("unitLocations")
                    if isinstance(locs, dict) and str(offer["arg"]) not in locs:
                        effect = {"unitDisbanded": {"unitId": offer["arg"]}}
                elif kind == "START_DIPLOMATIC_ACTION":
                    # What proves it happened depends on what it does. Influence-priced actions move
                    # the treasury, which nothing else does within a turn; war and alliance move the
                    # relationship itself, which is the only signal a free action leaves.
                    expect = offer.get("expect")
                    rel = rb.get("diplomaticRelations")
                    state = rel.get(str(offer["arg"])) if isinstance(rel, dict) else None
                    inf = rb.get("influenceBalance")
                    if expect == "war":
                        if isinstance(state, dict) and state.get("atWar") is True:
                            effect = {"warDeclared": {"targetPlayerId": offer["arg"], "actionType": offer["arg2"]}}
                    elif expect == "alliance":
                        if isinstance(state, dict) and state.get("allied") is True:
                            effect = {"allianceFormed": {"targetPlayerId": offer["arg"]}}
                    elif isinstance(inf, int) and not isinstance(inf, bool) and inf < offer["pre"]:
                        effect = {"diplomaticActionStarted": {"targetPlayerId": offer["arg"], "actionType": offer["arg2"],
                                                             "influenceSpent": offer["pre"] - inf}}
                elif kind == "FOUND_RELIGION":
                    held = rb.get("religionType")
                    if isinstance(held, int) and not isinstance(held, bool) and held == offer["arg"]:
                        effect = {"religionFounded": {"religion": offer["arg"]}}
                elif kind == "ADD_BELIEF":
                    # The earned count is slots, not beliefs, and never moves (live); the belief itself
                    # appearing in the held list is the proof.
                    held = rb.get("beliefsHeld")
                    if isinstance(held, list) and offer["arg"] in held:
                        effect = {"beliefAdded": {"belief": offer["arg"], "beliefs": len(held)}}
                elif kind == "RESPOND_DIPLOMATIC_ACTION":
                    # The engine keeps accepting a second answer after the first (live: the check
                    # stayed true and the accept read as unknown); the event's own recorded response
                    # is the signal, and it must be the very answer that was sent.
                    responses = rb.get("proposalResponses")
                    recorded = responses.get(str(offer["arg"])) if isinstance(responses, dict) else None
                    if isinstance(recorded, int) and not isinstance(recorded, bool) and recorded == offer["arg2"]:
                        effect = {"proposalAnswered": {"eventId": offer["arg"], "response": offer["arg2"]}}
                elif kind in ("PROPOSE_PEACE", "ACCEPT_PEACE", "REJECT_PEACE"):
                    rel = rb.get("diplomaticRelations")
                    state = rel.get(str(offer["arg"])) if isinstance(rel, dict) else None
                    if isinstance(state, dict):
                        if kind == "PROPOSE_PEACE" and state.get("pendingDeal") is True:
                            effect = {"peaceProposed": {"targetPlayerId": offer["arg"]}}
                        elif kind == "ACCEPT_PEACE" and state.get("atWar") is False:
                            effect = {"peaceMade": {"targetPlayerId": offer["arg"]}}
                        elif kind == "REJECT_PEACE" and state.get("pendingDeal") is False and state.get("atWar") is True:
                            effect = {"peaceRejected": {"targetPlayerId": offer["arg"]}}
                elif kind == "DECLARE_WAR":
                    rel = rb.get("diplomaticRelations")
                    state = rel.get(str(offer["arg"])) if isinstance(rel, dict) else None
                    if isinstance(state, dict) and state.get("atWar") is True:
                        effect = {"joinedAllyWar": {"enemyPlayerId": offer["arg"], "callToArms": offer["arg2"]}}
                elif kind == "CANCEL_ALLIANCE":
                    rel = rb.get("diplomaticRelations")
                    state = rel.get(str(offer["arg"])) if isinstance(rel, dict) else None
                    if isinstance(state, dict) and state.get("allied") is False:
                        effect = {"allianceEnded": {"targetPlayerId": offer["arg"]}}
                elif kind == "PRODUCE_PROJECT":
                    queues = rb.get("cityQueues")
                    q = queues.get(str(offer["arg"])) if isinstance(queues, dict) else None
                    if isinstance(q, list) and len(q) > offer["pre"] and q[offer["pre"]] == offer["arg2"]:
                        effect = {"projectQueued": {"cityId": offer["arg"], "projectType": offer["arg2"], "position": offer["pre"]}}
                elif kind == "PURCHASE_CONSTRUCTIBLE":
                    # Only a mutation moves the treasury within a turn, so a lighter balance is the
                    # specific effect; the building itself lands on the plot the offer named.
                    gold = rb.get("goldBalance")
                    if isinstance(gold, int) and not isinstance(gold, bool) and gold < offer["pre"]:
                        effect = {"constructiblePurchased": {"cityId": offer["arg"], "constructibleType": offer["arg2"],
                                                            "plotIndex": offer["arg3"], "goldSpent": offer["pre"] - gold}}
                elif kind == "UPGRADE_TOWN":
                    flags = rb.get("townFlags")
                    if isinstance(flags, dict) and flags.get(str(offer["arg"])) is False:
                        effect = {"townUpgraded": {"cityId": offer["arg"]}}
                elif kind == "PURCHASE_UNIT":
                    count = rb.get("unitCount")
                    if isinstance(count, int) and not isinstance(count, bool) and count > offer["pre"]:
                        effect = {"unitPurchased": {"cityId": offer["arg"], "unitType": offer["arg2"], "units": count}}
                elif kind == "CHOOSE_TOWN_PROJECT":
                    projects = rb.get("townProjects")
                    if isinstance(projects, dict) and projects.get(str(offer["arg"])) == offer["arg2"]:
                        effect = {"townProject": {"cityId": offer["arg"], "projectType": offer["arg2"]}}
                elif kind == "PROMOTE_UNIT":
                    # The counters do not move, so the confirmation is the promotion itself appearing
                    # in the unit's held set (live: a Defilade that had really applied read as unknown
                    # while this matched on getTotalPromotionsEarned, which stayed at four).
                    promos = rb.get("unitPromotions")
                    held = promos.get(str(offer["arg"])) if isinstance(promos, dict) else None
                    if isinstance(held, list) and offer["arg2"] in held:
                        effect = {"unitPromoted": {"unitId": offer["arg"], "promotion": offer["arg2"]}}
                elif kind == "ASSIGN_RESOURCE":
                    assigned = rb.get("resourceAssignments")
                    if isinstance(assigned, dict) and assigned.get(str(offer["arg"])) == offer["arg2"]:
                        effect = {"resourceAssigned": {"plotIndex": offer["arg"], "cityId": offer["arg2"]}}
                elif kind == "CONSIDER_ASSIGN_RESOURCE":
                    notes = rb.get("blockingNotifications")
                    if isinstance(notes, list) and "NOTIFICATION_ASSIGN_NEW_RESOURCES" not in notes:
                        effect = {"resourceNotificationCleared": True}
                elif kind == "CHOOSE_GOLDEN_AGE":
                    left = rb.get("goldenAgeChoices")
                    notes = rb.get("blockingNotifications")
                    if left == 0 or (isinstance(notes, list) and "NOTIFICATION_CHOOSE_GOLDEN_AGE" not in notes):
                        effect = {"celebrationChosen": offer["arg"]}
                elif kind == "BUY_ATTRIBUTE_TREE_NODE":
                    nodes = rb.get("attributeNodes")
                    st = nodes.get(str(offer["arg"])) if isinstance(nodes, dict) else None
                    if isinstance(st, int) and not isinstance(st, bool) and st != offer["pre"] and st >= 4:
                        effect = {"attributeNodeState": {"node": offer["arg"], "state": st}}
                elif kind == "CONSIDER_ASSIGN_ATTRIBUTE":
                    notes = rb.get("blockingNotifications")
                    if isinstance(notes, list) and "NOTIFICATION_CAN_BUY_ATTRIBUTE_SKILL" not in notes:
                        effect = {"attributeNotificationCleared": True}
                elif kind == "CHANGE_GOVERNMENT":
                    gov = rb.get("governmentType")
                    if isinstance(gov, int) and not isinstance(gov, bool) and gov in (offer["arg2"], offer["arg"]):
                        effect = {"governmentType": gov}
                elif kind == "FOUND_PANTHEON":
                    pantheons = rb.get("pantheons")
                    if isinstance(pantheons, list) and offer["arg"] in pantheons:
                        effect = {"pantheonFounded": offer["arg"]}
                elif kind == "CHOOSE_NARRATIVE_STORY_DIRECTION":
                    pending = rb.get("pendingStories")
                    if isinstance(pending, list) and offer["arg"] not in pending:
                        effect = {"storyResolved": offer["arg"]}
                elif kind == "CHANGE_TRADITION":
                    active = rb.get("activeTraditions")
                    if isinstance(active, list) and offer["arg2"] in active:
                        effect = {"traditionActive": offer["arg2"]}
                elif kind == "CONSIDER_ASSIGN_TRADITIONS":
                    # live: the operation is accepted but the notification stays while a card can still be
                    # activated, so the blocker value alone (a category) is not enough evidence
                    notes = rb.get("blockingNotifications")
                    if (isinstance(rb.get("endTurnBlocking"), str) and rb["endTurnBlocking"] != "TRADITIONS"
                            and isinstance(notes, list) and "NOTIFICATION_TRADITIONS_AVAILABLE" not in notes):
                        effect = {"endTurnBlocking": rb["endTurnBlocking"], "traditionsNotificationCleared": True}
                elif kind in ("PRODUCE_UNIT", "PRODUCE_CONSTRUCTIBLE"):
                    # BUILD enqueues: the item must now sit at the queue position the offer was made for
                    queues = rb.get("cityQueues")
                    q = queues.get(str(offer["arg"])) if isinstance(queues, dict) else None
                    if isinstance(q, list) and len(q) > offer["pre"] and q[offer["pre"]] == offer["arg2"]:
                        effect = {"queued": {"cityId": offer["arg"], ("unitType" if kind == "PRODUCE_UNIT" else "constructibleType"): offer["arg2"], "position": offer["pre"]}}
            if effect is not None:
                return {"source": "poll", "gameGuid": rb.get("gameGuid"), "turn": turn, "age": age, "localPlayerId": seat, "localObserverId": observer, "effect": effect}
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
        if status == "unknown":
            self._record_unknown(entry)
            self._mark_unresolved(base["requestId"], entry)
        else:
            self._clear_unresolved(base["requestId"])
        self._release_inflight(base["requestId"])
        self._release_inflight(base["requestId"])
        if raise_code:
            raise ObserverError(raise_code, f"action {base['requestId']} outcome is {status}; reconcile before acting again", result=entry)
        return entry


def _now() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
