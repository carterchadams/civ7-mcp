"""Loading and routing for the runner's skill cards.

`skills/*.md` start from the strategy guide. Cards marked Runtime-maintained are edited directly
and preserved by `tools/build_skills.py`; other cards remain generated. `skills/local/*.md` are this project's own cards (currently the friction card),
which have no source in the guide.
"""

from __future__ import annotations

import json
from functools import lru_cache
from importlib import resources

GENERATED = "civ7_observer.skills"
LOCAL = "civ7_observer.skills.local"

# Which card answers which decision. Explicit and reviewed, not inferred at runtime: each entry is
# the guide skill whose stated purpose covers that decision.
DECISION_SKILL = {
    "research": "civ7-research-and-civics",
    "civic": "civ7-research-and-civics",
    "production": "civ7-production-and-placement",
    # The unit catalog is currently move and skip only, so the reconnaissance card (spending
    # movement, map memory, information value) is the one that applies. Add the combat card here
    # when attack actions exist.
    "unit": "civ7-reconnaissance-and-memory",
    "settle": "civ7-settlement-sites",
    "population": "civ7-growth-and-specialists",
    "policies": "civ7-happiness-and-government",
    "crisis": "civ7-ages-and-crises",
    "age_transition": "civ7-ages-and-crises",
    "legacies": "civ7-triumphs-and-dedications",
    # Narrative events have no card in the guide; the turn-management card (always loaded) is the
    # procedure: take the reward that serves the current commitments, never stall the turn on it.
    "narrative": "civ7-turn-management",
    "pantheon": "civ7-religion-and-great-works",
    "government": "civ7-happiness-and-government",
    "attributes": "civ7-research-and-civics",
    "celebration": "civ7-happiness-and-government",
    "resources": "civ7-treasury-and-resources",
    "town_project": "civ7-towns-and-cities",
    "promotion": "civ7-commanders-and-logistics",
    "end_turn": "civ7-turn-management",
}
ALWAYS = "civ7-turn-management"


@lru_cache(maxsize=1)
def index() -> dict:
    return json.loads(resources.files(GENERATED).joinpath("index.json").read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def _rules() -> dict:
    return json.loads(resources.files(GENERATED).joinpath("rules.json").read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def operating() -> str:
    return resources.files(GENERATED).joinpath("operating.md").read_text(encoding="utf-8")


@lru_cache(maxsize=64)
def card(skill_id: str) -> str:
    """One skill card by id. Generated cards first, then this project's local cards."""
    entry = index()["skills"].get(skill_id)
    if entry is not None:
        return resources.files(GENERATED).joinpath(entry["file"]).read_text(encoding="utf-8")
    local = resources.files(LOCAL).joinpath(f"{skill_id}.md")
    if local.is_file():
        return local.read_text(encoding="utf-8")
    raise KeyError(f"no such skill card: {skill_id}")


def rules(rule_ids: list[str]) -> str:
    """The named rule cards, in the order given. Unknown ids raise rather than silently vanish."""
    table = _rules()
    parts = []
    for rule_id in rule_ids:
        rule = table[rule_id]
        parts.append(f"{rule_id} — {rule['title']}: {rule['text']}")
    return "\n\n".join(parts)


def route(decision_kinds: list[str], required: str | None = None) -> list[str]:
    """The cards to load for this turn: the turn-management card always, then one per decision,
    with the decision the game requires first."""
    ordered = sorted(set(decision_kinds), key=lambda k: (k != required, k))
    routed = [ALWAYS]
    for kind in ordered:
        skill_id = DECISION_SKILL.get(kind)
        if skill_id and skill_id not in routed:
            routed.append(skill_id)
    return routed


def catalog() -> str:
    """One line per available card, for the model to request another with load_skill."""
    lines = [f"{skill_id} — {entry['title']}" for skill_id, entry in sorted(index()["skills"].items())]
    lines.append("friction — Report friction: a tool or fact you need is missing")
    return "\n".join(lines)
