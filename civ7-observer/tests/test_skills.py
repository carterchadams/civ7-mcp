import json

import pytest

from civ7_observer import skills


def test_index_lists_every_generated_card():
    index = skills.index()
    assert len(index["skills"]) == 25
    for skill_id, entry in index["skills"].items():
        assert skills.card(skill_id).startswith(f"# {entry['title']}")


def test_operating_contract_and_rules_load():
    operating = skills.operating()
    assert "## The turn loop" in operating and "## Output contract" in operating
    text = skills.rules(["R-PREVIEW", "R-TOWN"])
    assert "R-PREVIEW" in text and "R-TOWN" in text and "marginal value" in text
    assert skills.rules([]) == ""
    with pytest.raises(KeyError):
        skills.rules(["R-NOPE"])


def test_local_friction_card_is_available_and_not_generated():
    card = skills.card("friction")
    assert card.startswith("# Report friction") and "report_friction" in card
    assert "friction" not in skills.index()["skills"], "the local card must not pretend to come from the guide"


@pytest.mark.parametrize("kinds, expected", [
    (["research"], ["civ7-turn-management", "civ7-research-and-civics"]),
    (["civic"], ["civ7-turn-management", "civ7-research-and-civics"]),
    (["production"], ["civ7-turn-management", "civ7-production-and-placement"]),
    (["unit"], ["civ7-turn-management", "civ7-reconnaissance-and-memory"]),
    (["settle"], ["civ7-turn-management", "civ7-settlement-sites"]),
    (["population"], ["civ7-turn-management", "civ7-growth-and-specialists"]),
    (["policies"], ["civ7-turn-management", "civ7-happiness-and-government"]),
    (["crisis"], ["civ7-turn-management", "civ7-ages-and-crises"]),
    (["age_transition"], ["civ7-turn-management", "civ7-ages-and-crises"]),
    (["narrative"], ["civ7-turn-management"]),
    (["pantheon"], ["civ7-turn-management", "civ7-religion-and-great-works"]),
    (["government"], ["civ7-turn-management", "civ7-happiness-and-government"]),
    (["attributes"], ["civ7-turn-management", "civ7-research-and-civics"]),
    (["celebration"], ["civ7-turn-management", "civ7-happiness-and-government"]),
    (["resources"], ["civ7-turn-management", "civ7-treasury-and-resources"]),
    (["town_project"], ["civ7-turn-management", "civ7-towns-and-cities"]),
    (["promotion"], ["civ7-turn-management", "civ7-commanders-and-logistics"]),
    (["end_turn"], ["civ7-turn-management"]),
    ([], ["civ7-turn-management"]),
    (["research", "unit"], ["civ7-turn-management", "civ7-research-and-civics", "civ7-reconnaissance-and-memory"]),
])
def test_routing_is_explicit_and_bounded(kinds, expected):
    assert skills.route(kinds) == expected


def test_routing_puts_the_required_decision_first():
    assert skills.route(["unit", "research"], required="research")[1] == "civ7-research-and-civics"
    assert skills.route(["unit", "research"], required="unit")[1] == "civ7-reconnaissance-and-memory"


def test_every_routed_skill_exists_and_every_decision_kind_routes():
    from civ7_observer.brief import DECISION_OF_KIND
    for decision in set(DECISION_OF_KIND.values()):
        routed = skills.route([decision])
        assert routed, f"{decision} routes nowhere"
        for skill_id in routed:
            assert skills.card(skill_id)


def test_catalog_is_a_short_line_per_skill():
    catalog = skills.catalog()
    assert len(catalog.splitlines()) == 26          # 25 guide skills plus the local friction card
    assert all(" — " in line for line in catalog.splitlines())
    assert len(catalog) < 3000


def test_every_card_directory_ships_with_the_package():
    """The runner reads these at runtime, so an install that drops them is a silent failure."""
    import tomllib
    from pathlib import Path

    root = Path(__file__).resolve().parent.parent
    data = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))
    declared = data["tool"]["setuptools"]["package-data"]
    assert "*.md" in declared["civ7_observer.skills"] and "*.json" in declared["civ7_observer.skills"]
    assert "*.md" in declared["civ7_observer.skills.local"]
    for package in ("civ7_observer.skills", "civ7_observer.skills.local"):
        directory = root / "src" / package.replace(".", "/")
        assert (directory / "__init__.py").exists(), f"{package} must be a real package to be installed"
