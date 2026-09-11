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
# Entities are one short record each, so a seat can see its whole roster even when the option list is
# bounded (live friction: a seat with nine units was shown six and could not command the rest).
DEFAULT_MAX_ENTITIES = 16

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
    "CRISIS": "crisis",
    "NOTIFICATION_CRISIS": "crisis",
    "PANTHEON": "pantheon",
    "CONSIDER_GOVERNMENT_CHANGE": "government",
    "NOTIFICATION_CHOOSE_GOVERNMENT": "government",
    "NOTIFICATION_CAN_BUY_ATTRIBUTE_SKILL": "attributes",
    "UNIT_PROMOTION": "promotion",
    "NOTIFICATION_UNIT_PROMOTION_AVAILABLE": "promotion",
    "CHOOSE_GOLDEN_AGE": "celebration",
    "ASSIGN_NEW_RESOURCES": "resources",
    "PLAYER_MET": "first_meet",
    "NOTIFICATION_PLAYER_MET": "first_meet",
    "ADVANCED_START": "legacies",
    "NOTIFICATION_AGE_TRANSITION": "legacies",
    "CHOOSE_CIVILIZATION": "age_transition",
    "NOTIFICATION_CHOOSE_CIVILIZATION": "age_transition",
    "CHOOSE_TOWN_PROJECT": "town_project",
    "NOTIFICATION_CHOOSE_TOWN_PROJECT": "town_project",
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
# Options whose whole job is to clear a turn blocker rather than to choose anything. They must never
# be the ones dropped when a group is bounded: live on turn 45 a seat had six resource assignments and
# this single confirm, the confirm was the option omitted, and the seat could not end its turn at all.
RESOLVING_KINDS = frozenset({
    "consider_resources", "confirm_traditions", "consider_attributes",
    "finish_legacy_deck", "finish_age_transition",
})

DECISION_OF_KIND = {
    "research": "research",
    "civic": "civic",
    # The goal sits with the choice it steers, so a seat sees both in one place.
    "research_goal": "research",
    "civic_goal": "civic",
    "produce_unit": "production",
    "produce_project": "production",
    "produce_constructible": "production",
    "purchase_unit": "production",
    "purchase_constructible": "production",
    # Promoting a town is a settlement-wide decision, not one more thing to build, so it reads under
    # the population group next to expansion rather than competing with the build queue.
    "promote_town_to_city": "population",
    "skip_unit": "unit",
    "move_unit": "unit",
    "make_trade_route": "unit",
    "unit_order": "unit",
    # An attack is a unit order too, but it is the one that starts wars, so it reads with the others.
    "attack": "unit",
    "upgrade_unit": "unit",
    "pack_army": "unit",
    "join_army": "unit",
    "leave_army": "unit",
    "unpack_army": "unit",
    "activate_great_person": "unit",
    "disband_unit": "unit",
    # Founding is a unit's order too (it resolves the UNITS blocker for that unit), but it is the
    # decision a settler actually faces, so it gets its own group and its own skill card.
    "found_city": "settle",
    "expand_city": "population",
    # Working a tile with a specialist is the same settlement-growth decision as expanding onto one.
    "assign_specialist": "population",
    "activate_tradition": "policies",
    "confirm_traditions": "policies",
    "narrative_choice": "narrative",
    "found_pantheon": "pantheon",
    "change_government": "government",
    "buy_attribute": "attributes",
    "consider_attributes": "attributes",
    "choose_celebration": "celebration",
    "promote_unit": "promotion",
    "greet_new_civilization": "first_meet",
    "pick_legacy_card": "legacies",
    "finish_legacy_deck": "legacies",
    "choose_age_civilization": "age_transition",
    "finish_age_transition": "age_transition",
    "town_project": "town_project",
    "assign_resource": "resources",
    "consider_resources": "resources",
    "start_diplomatic_action": "diplomacy",
    "cancel_alliance": "diplomacy",
    "end_turn": "end_turn",
}

OPTION_FIELDS = ("actionId", "kind", "typeKey", "displayName", "tree", "cost", "turns",
                 "unitTypeKey", "unitId", "from", "to", "terrainKey", "pathTurns", "steps",
                 "cityId", "cityName", "improvementKey", "featureKey", "river", "yields",
                 "constructibleKey", "constructibleClass", "placement", "plotIndex", "queue", "queueLength",
                 "slot", "slotsTotal", "slotsFree", "slotsFreeAny", "activatable", "description", "isCrisis",
                 "storyId", "title", "body", "answerKey", "option", "reward", "action", "costYield", "affordable",
                 "destructive", "requiresConfirmation", "warning", "guidance", "celebration", "effects", "unlocksTraditions", "townDefault", "upgradeToCity", "tooCloseToSettle", "goldBalance",
                 "armyId", "isCommander", "ranged", "attacksRemaining", "strength", "rangedStrength", "damage", "maxDamage", "defender", "startsWar",
                 "yieldsNext", "upkeep", "upkeepNext", "workers", "maxWorkers", "cityWorkers", "cityWorkerCap",
                 "targetPlayerId", "targetName", "targetIsMajor", "group", "influenceBalance", "currentTarget", "expect",
                 "fullName", "historical", "selected", "invalidReason", "selectedCivilization",
                 "cardId", "pointsAvailable", "needsPlacement", "effectCount", "deck",
                 "greeting", "otherPlayer", "influenceCost", "influenceBalance", "note", "activeRoutes",
                 "orderKey", "damage", "maxDamage", "discipline", "disciplineName", "commendation", "promotionsEarned", "promotionPoints", "commendationPoints", "unitLevel", "resourceKey", "resourceClass", "assignedCityId", "originCityName", "cityIsTown", "cityCap", "cityAssigned", "toAssign", "assignable", "attribute", "attributeName", "availablePoints", "wildcardPoints")

POLICIES_NOTE = ("activate a card into a free slot first (`slotsFreeAny` counts every slot; the engine's canStart, not the "
                 "card's slot type, decides what fits), then confirm_traditions; confirming alone does not clear the blocker "
                 "while a card can still be activated")

ATTRIBUTES_NOTE = ("buy a node whose attribute has a point available (wildcard points count for any attribute), then "
                   "consider_attributes to close the decision; nodes cost one point each")

RESOURCES_NOTE = ("assign each new resource to a settlement with spare capacity (`cityCap` minus `cityAssigned`; `description` is "
                  "the resource's effect), then consider_resources; it is not startable while a resource can still be assigned")

AGE_TRANSITION_NOTE = ("the age is over: choose the civilization this seat becomes in the next age (each option's `description` is its "
                       "unique ability; `historical: true` marks the choices the game considers this civilization's natural successors), "
                       "then finish_age_transition. Choosing is reversible; finishing is one-way and starts the new age once every seat "
                       "has finished. Mementos are left as they are")

FIRST_MEET_NOTE = ("a civilization has been met and the game will not let the turn end until this seat greets it: friendly, "
                   "neutral or unfriendly, each costing `influenceCost` against `influenceBalance`. The greeting sets the "
                   "starting relationship; nothing else about that civilization is visible to this seat")

LEGACIES_NOTE = ("the new age's legacy cards: spend `pointsAvailable` on cards (`cost` each) with pick_legacy_card, which also "
                 "takes that card's reward, then finish_legacy_deck once. Finishing forfeits any unspent points, so pick first")

MOVE_HINT_NOTE = ("a move option's `yields` describe the destination plot itself; `tooCloseToSettle` appears only on units "
                  "that could found a settlement, and is the game's own minimum-distance rule for that plot. A unit_order is a "
                  "standing order that also ends the unit's turn: Heal rests a damaged unit until full, Fortify and Alert hold "
                  "ground, Sleep waits. A unit carrying `damage` is wounded. A move option's `steps` is how far away the "
                  "destination is: every one listed is reachable this turn, so a fast unit can cross several tiles at once")

PRODUCTION_NOTE = ("each production action APPENDS to the city's build queue (`queue` shows what is already queued, in "
                   "order); a city with a non-empty queue needs no production action this turn. Only a few options per "
                   "settlement are shown: call get_city_options with a cityId for everything it can build. A purchase_unit "
                   "option spends gold (`cost` against `goldBalance`) and delivers the unit at once, rather than queueing it")

DIPLOMACY_NOTE = ("influence buys these; `cost` is in influence and `influenceBalance` is what the seat holds. Each "
                  "option names the civilization it is aimed at (`targetName`) and its kind (`group`): TREATY and "
                  "ENDEAVOR help both sides, SANCTION and ESPIONAGE work against the target. Influence otherwise "
                  "accumulates unspent. Declaring war and forming alliances are not offered here.")
BLOCKED_SETTLER_NOTE = ("founding is refused at this unit's current plot; the engine gives no reason (typical causes: water or "
                        "navigable-river tiles, or too close to another settlement). Move it to a plot where a found_city option "
                        "appears; call get_unit_options with its unitId to see where it can go. Each move option carries "
                        "tooCloseToSettle: head for plots where it is false.")


def _decision_of(offer: dict[str, Any], required: list[str]) -> str | None:
    """Which decision an offer belongs to. Crisis policy cards are the same engine operation as
    ordinary ones but answer a different blocker, so they are routed by their own flag."""
    kind = offer["kind"]
    if kind == "activate_tradition":
        return "crisis" if offer.get("isCrisis") else "policies"
    if kind == "confirm_traditions":
        return "crisis" if "crisis" in required else "policies"
    return DECISION_OF_KIND.get(kind)


def _option(offer: dict[str, Any]) -> dict[str, Any]:
    return {k: offer[k] for k in OPTION_FIELDS if k in offer}


def _entity(offer: dict[str, Any]) -> dict[str, Any] | None:
    if "unitId" not in offer:
        return None
    entity = {"unitId": offer["unitId"], "typeKey": offer.get("unitTypeKey"),
              "at": offer.get("from"), "movesRemaining": offer.get("movesRemaining")}
    if offer.get("damage"):
        entity["damage"] = offer["damage"]
    return entity


def build_brief(gs: GameSession, registry: ActionRegistry, *, player: int, mode: str,
                max_options: int = DEFAULT_MAX_OPTIONS, max_entities: int = DEFAULT_MAX_ENTITIES) -> dict[str, Any]:
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

    def bucket_of(offer: dict[str, Any]) -> Any:
        """Which entity an option belongs to, so no single unit or city can crowd the others out."""
        for key in ("unitId", "cityId"):
            if key in offer:
                return (key, offer[key])
        return None

    for offer in offers:
        if not offer.get("canStart"):
            # A settler the game will not let found where it stands is still a fact the seat needs:
            # it appears as an entity with no option, so the seat moves it instead of waiting.
            if offer["kind"] == "found_city" and "unitId" in offer:
                group = group_for("settle")
                if offer["unitId"] not in group["_seen"]:
                    group["_seen"].add(offer["unitId"])
                    group["entities"].append({**_entity(offer), "canFoundHere": False, "terrainKey": offer.get("terrainKey"),
                                              "tooCloseToSettle": offer.get("tooCloseToSettle")})
                    group["note"] = BLOCKED_SETTLER_NOTE
            continue
        decision = _decision_of(offer, required)
        if decision is None:
            continue
        group = group_for(decision)
        group.setdefault("_buckets", {}).setdefault(bucket_of(offer), []).append(offer)
        if decision == "unit":
            group["note"] = MOVE_HINT_NOTE
        if decision == "age_transition":
            group["note"] = AGE_TRANSITION_NOTE
        if decision == "legacies":
            group["note"] = LEGACIES_NOTE
        if decision == "first_meet":
            group["note"] = FIRST_MEET_NOTE
        if decision == "production":
            group["note"] = PRODUCTION_NOTE
        if decision in ("policies", "crisis"):
            group["note"] = POLICIES_NOTE
        if decision == "attributes":
            group["note"] = ATTRIBUTES_NOTE
        if decision == "diplomacy":
            group["note"] = DIPLOMACY_NOTE
        if decision == "resources":
            group["note"] = RESOURCES_NOTE
        group["optionCount"] += 1
        entity = _entity(offer)
        if entity is not None and entity["unitId"] not in group["_seen"]:
            group["_seen"].add(entity["unitId"])
            if len(group["entities"]) < max_entities:
                group["entities"].append(entity)

    decisions = []
    for group in groups.values():
        # Round-robin across entities: a settler whose own moves sat behind six other units' options
        # was invisible to the seat (live friction, turn 33), so every entity is represented first.
        buckets = [list(v) for v in group.pop("_buckets", {}).values()]
        # A blocker-clearing option keeps a reserved slot: it is taken out of the competition for room
        # and put back at the end, so it is never the one dropped and still reads after the choices.
        resolvers: list[dict[str, Any]] = []
        for b in list(buckets):
            for offer in [o for o in b if o["kind"] in RESOLVING_KINDS]:
                b.remove(offer)
                resolvers.append(offer)
            if not b:
                buckets.remove(b)
        room = max(max_options - len(resolvers), 0)
        chosen: list[dict[str, Any]] = []
        while buckets and len(chosen) < room:
            for b in list(buckets):
                if len(chosen) >= room:
                    break
                chosen.append(b.pop(0))
                if not b:
                    buckets.remove(b)
        group["options"] = [_option(o) for o in chosen + resolvers]
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
