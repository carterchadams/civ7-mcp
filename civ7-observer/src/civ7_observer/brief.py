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
    "PANTHEON": "pantheon",
    "CONSIDER_GOVERNMENT_CHANGE": "government",
    "NOTIFICATION_CHOOSE_GOVERNMENT": "government",
    "NOTIFICATION_CAN_BUY_ATTRIBUTE_SKILL": "attributes",
    "CHOOSE_GOLDEN_AGE": "celebration",
    "ASSIGN_NEW_RESOURCES": "resources",
    "NOTIFICATION_ASSIGN_NEW_RESOURCES": "resources",
    "NOTIFICATION_CHOOSE_GOLDEN_AGE": "celebration",
    # Blockers whose value is missing from EndTurnBlockingTypes are named after the blocking
    # notification's type (live: the civic blocker on turn 8 came back as a raw value), so every
    # supported decision is reachable under its notification name too.
    "NOTIFICATION_CHOOSE_TECH": "research",
    "NOTIFICATION_CHOOSE_CULTURE_NODE": "civic",
    "NOTIFICATION_CHOOSE_CITY_PRODUCTION": "production",
    "NOTIFICATION_COMMAND_UNITS": "unit",
    "NOTIFICATION_NEW_POPULATION": "population",
    "NOTIFICATION_TRADITIONS_AVAILABLE": "policies",
    "NOTIFICATION_CHOOSE_PANTHEON": "pantheon",
    "NOTIFICATION_CHOOSE_DISCOVERY_STORY_DIRECTION": "narrative",
    "NOTIFICATION_CHOOSE_NARRATIVE_STORY_DIRECTION": "narrative",
    "NOTIFICATION_CHOOSE_AUTO_STORY_DIRECTION": "narrative",
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
    "narrative_choice": "narrative",
    "found_pantheon": "pantheon",
    "change_government": "government",
    "buy_attribute": "attributes",
    "consider_attributes": "attributes",
    "choose_celebration": "celebration",
    "assign_resource": "resources",
    "consider_resources": "resources",
    "end_turn": "end_turn",
}

OPTION_FIELDS = ("actionId", "kind", "typeKey", "displayName", "tree", "cost", "turns",
                 "unitTypeKey", "unitId", "from", "to", "terrainKey", "pathTurns",
                 "cityId", "cityName", "improvementKey", "featureKey", "river", "yields",
                 "constructibleKey", "constructibleClass", "placement", "plotIndex", "queue", "queueLength",
                 "slot", "slotsTotal", "slotsFree", "slotsFreeAny", "activatable", "description",
                 "storyId", "title", "body", "answerKey", "option", "reward", "action", "costYield", "affordable",
                 "celebration", "effects", "unlocksTraditions", "resourceKey", "resourceClass", "assignedCityId", "originCityName", "cityIsTown", "cityCap", "cityAssigned", "toAssign", "assignable", "attribute", "attributeName", "availablePoints", "wildcardPoints")

POLICIES_NOTE = ("activate a card into a free slot first (`slotsFreeAny` counts every slot; the engine's canStart, not the "
                 "card's slot type, decides what fits), then confirm_traditions; confirming alone does not clear the blocker "
                 "while a card can still be activated")

ATTRIBUTES_NOTE = ("buy a node whose attribute has a point available (wildcard points count for any attribute), then "
                   "consider_attributes to close the decision; nodes cost one point each")

RESOURCES_NOTE = ("assign each new resource to a settlement with spare capacity (`cityCap` minus `cityAssigned`; `description` is "
                  "the resource's effect), then consider_resources; it is not startable while a resource can still be assigned")

PRODUCTION_NOTE = ("each production action APPENDS to the city's build queue (`queue` shows what is already queued, in "
                   "order); a city with a non-empty queue needs no production action this turn")

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
    # The blocker value can be a category (live: CULTURE while government and traditions were what
    # blocked), so the notifications that block the turn name required decisions too.
    notifications = [n for n in (ctx.get("blockingNotifications") or []) if isinstance(n, str)]
    required: list[str] = []
    for name in ([blocking] if blocking else []) + notifications:
        decision = BLOCKER_DECISION.get(name)
        if decision and decision not in required:
            required.append(decision)
    unmapped = [n for n in notifications if n not in BLOCKER_DECISION]
    required_decision = required[0] if required else None
    end_turn = {
        "canStart": bool(end_offer and end_offer["canStart"]),
        "blocking": blocking,
        "blockingNotifications": notifications,
        "supported": blocking is None or (bool(required) and not unmapped),
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

    if blocking is not None and (not required or unmapped):
        what = ", ".join(unmapped) if unmapped else blocking
        return {**base, "decisions": [], "pause": {
            "reason": "UNSUPPORTED_DECISION", "blocking": blocking,
            "message": f"the game requires a {what} decision, which this catalog cannot make; a human must take the seat and resolve it"}}

    groups: dict[str, dict[str, Any]] = {}

    def group_for(decision: str) -> dict[str, Any]:
        return groups.setdefault(decision, {"kind": decision, "required": decision in required,
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
        if decision == "production":
            group["note"] = PRODUCTION_NOTE
        if decision == "policies":
            group["note"] = POLICIES_NOTE
        if decision == "attributes":
            group["note"] = ATTRIBUTES_NOTE
        if decision == "resources":
            group["note"] = RESOURCES_NOTE
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
    decisions.sort(key=lambda d: (not d["required"], required.index(d["kind"]) if d["kind"] in required else 0, d["kind"]))
    return {**base, "decisions": decisions, "pause": None}
