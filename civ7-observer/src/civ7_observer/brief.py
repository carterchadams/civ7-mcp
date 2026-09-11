"""The compact turn brief: what the bound seat must decide now, with bounded options.

Everything here is derived from the same seat-bound offer listing the CLI and MCP use. The host
does no strategy: it groups the legal options the game already offered, says which decision the
game is actually blocking on, and names an explicit pause when the required decision is one this
catalog cannot make. No option is invented, and nothing another seat owns is read.
"""

from __future__ import annotations

from typing import Any

from civ7_observer.actions import ActionRegistry
from civ7_observer.service import GameSession

DEFAULT_MAX_OPTIONS = 6

# Which of our public action kinds resolves each native end-turn blocker. A blocker missing from
# this map is a decision the catalog cannot make: the brief pauses instead of guessing.
BLOCKER_DECISION = {
    "RESEARCH": "research",
    "CULTURE": "civic",
    "PRODUCTION": "production",
    "UNITS": "unit",
    "UNIT_NEEDS_ORDERS": "unit",
    "STACKED_UNITS": "unit",
    "NEW_POPULATION": "population",
    "TRADITIONS": "policies",
}

# Public action kinds grouped into the decision a player actually faces.
DECISION_OF_KIND = {
    "research": "research",
    "civic": "civic",
    "produce_unit": "production",
    "produce_constructible": "production",
    "skip_unit": "unit",
    "move_unit": "unit",
    # Founding is a unit's order too (it resolves the UNITS blocker for that unit), but it is the
    # decision a settler actually faces, so it gets its own group and its own skill card.
    "found_city": "settle",
    "expand_city": "population",
    "activate_tradition": "policies",
    "confirm_traditions": "policies",
    "end_turn": "end_turn",
}

OPTION_FIELDS = ("actionId", "kind", "typeKey", "displayName", "tree", "cost", "turns",
                 "unitTypeKey", "unitId", "from", "to", "terrainKey", "pathTurns",
                 "cityId", "cityName", "improvementKey", "featureKey", "river", "yields",
                 "constructibleKey", "constructibleClass", "placement", "plotIndex",
                 "slot", "slotsTotal", "slotsFree", "description")

BLOCKED_SETTLER_NOTE = ("founding is refused at this unit's current plot; the engine gives no reason (typical causes: water or "
                        "navigable-river tiles, or too close to another settlement). Move it to a plot where a found_city option appears.")


def _option(offer: dict[str, Any]) -> dict[str, Any]:
    return {k: offer[k] for k in OPTION_FIELDS if k in offer}


def _entity(offer: dict[str, Any]) -> dict[str, Any] | None:
    if "unitId" not in offer:
        return None
    return {"unitId": offer["unitId"], "typeKey": offer.get("unitTypeKey"),
            "at": offer.get("from"), "movesRemaining": offer.get("movesRemaining")}


def build_brief(gs: GameSession, registry: ActionRegistry, *, player: int, mode: str,
                max_options: int = DEFAULT_MAX_OPTIONS) -> dict[str, Any]:
    """One small, self-contained view of what this seat must decide."""
    listing = registry.list_offers(gs, player=player, mode=mode)
    unresolved = listing["reconciliationRequired"]
    offers = listing["offers"]
    ctx = listing["context"]

    end_offer = next((o for o in offers if o["kind"] == "end_turn"), None)
    blocking = end_offer.get("blockingType") if end_offer else None
    required_decision = BLOCKER_DECISION.get(blocking) if blocking else None
    end_turn = {
        "canStart": bool(end_offer and end_offer["canStart"]),
        "blocking": blocking,
        "supported": blocking is None or required_decision is not None,
        "actionId": end_offer["actionId"] if end_offer else None,
    }

    context = {"turn": ctx["turn"], "age": ctx.get("age"), "ageType": ctx.get("ageType"), "seat": player,
               "mode": ctx["mode"], "curtainDisplayed": ctx.get("curtainDisplayed")}
    base = {"context": context, "attachment": listing["attachment"], "endTurn": end_turn,
            "reconciliationRequired": unresolved}

    # An uncertain write blocks every action, so there is nothing useful to offer.
    if unresolved:
        return {**base, "decisions": [], "pause": {
            "reason": "RECONCILIATION_REQUIRED", "blocking": blocking,
            "message": f"an earlier action has an unknown outcome ({', '.join(unresolved)}); a human must verify it in the game and reconcile before this seat acts again"}}

    if blocking is not None and required_decision is None:
        return {**base, "decisions": [], "pause": {
            "reason": "UNSUPPORTED_DECISION", "blocking": blocking,
            "message": f"the game requires a {blocking} decision, which this catalog cannot make; a human must take the seat and resolve it"}}

    groups: dict[str, dict[str, Any]] = {}

    def group_for(decision: str) -> dict[str, Any]:
        return groups.setdefault(decision, {"kind": decision, "required": decision == required_decision,
                                            "optionCount": 0, "options": [], "entities": [], "_seen": set()})

    for offer in offers:
        if not offer.get("canStart"):
            # A settler the game will not let found where it stands is still a fact the seat needs:
            # it appears as an entity with no option, so the seat moves it instead of waiting.
            if offer["kind"] == "found_city" and "unitId" in offer:
                group = group_for("settle")
                if offer["unitId"] not in group["_seen"]:
                    group["_seen"].add(offer["unitId"])
                    group["entities"].append({**_entity(offer), "canFoundHere": False, "terrainKey": offer.get("terrainKey")})
                    group["note"] = BLOCKED_SETTLER_NOTE
            continue
        decision = DECISION_OF_KIND.get(offer["kind"])
        if decision is None:
            continue
        group = group_for(decision)
        group["optionCount"] += 1
        if len(group["options"]) < max_options:
            group["options"].append(_option(offer))
        entity = _entity(offer)
        if entity is not None and entity["unitId"] not in group["_seen"]:
            group["_seen"].add(entity["unitId"])
            if len(group["entities"]) < max_options:
                group["entities"].append(entity)

    decisions = []
    for group in groups.values():
        group["omitted"] = group["optionCount"] - len(group["options"])
        entity_count = len(group.pop("_seen"))
        if group["entities"]:
            group["entityCount"] = entity_count
            group["entitiesOmitted"] = entity_count - len(group["entities"])
        else:
            del group["entities"]
        decisions.append(group)
    decisions.sort(key=lambda d: (not d["required"], d["kind"]))
    return {**base, "decisions": decisions, "pause": None}
