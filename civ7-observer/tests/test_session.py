"""The seat's own session directory: what the harness prepares, reads and grants."""
from pathlib import Path

import pytest

from civ7_observer import skills
from civ7_observer.session import EMPTY_PLAN, SeatSession, operator_directives


def test_prepare_lays_out_the_directory_and_never_touches_the_agents_own_files(tmp_path):
    s = SeatSession(root=tmp_path, seat=2)
    s.dir.mkdir(parents=True)
    s.plan_path.write_text("# mine\n", encoding="utf-8")
    s.friction_path.write_text("## blocked: x\nneeded: y\n", encoding="utf-8")
    s.prepare()
    assert s.dir == (tmp_path / "seat2").resolve()
    assert s.readme_path.exists() and "PLAN.md" in s.readme_path.read_text() and "FRICTION.md" in s.readme_path.read_text()
    cards = {p.stem for p in s.skills_dir.glob("*.md")}
    assert "friction" in cards and set(skills.index()["skills"]) <= cards
    assert s.plan_path.read_text() == "# mine\n" and s.friction_path.read_text().startswith("## blocked")
    # a second prepare is idempotent
    s.prepare()
    assert s.plan_path.read_text() == "# mine\n"


def test_plan_text_is_the_file_verbatim_or_an_invitation_to_write_one(tmp_path):
    s = SeatSession(root=tmp_path, seat=0)
    assert s.plan_text() == EMPTY_PLAN
    s.dir.mkdir(parents=True)
    s.plan_path.write_text("   \n", encoding="utf-8")
    assert s.plan_text() == EMPTY_PLAN
    s.plan_path.write_text("# Plan\n\n- Settle the river site (next: move settler 5 east)\n", encoding="utf-8")
    assert s.plan_text() == "# Plan\n\n- Settle the river site (next: move settler 5 east)"


def test_friction_entries_parse_the_markdown_shape_the_readme_asks_for(tmp_path):
    s = SeatSession(root=tmp_path, seat=1)
    assert s.friction_entries() == []
    s.dir.mkdir(parents=True)
    s.friction_path.write_text(
        "# Friction\n\n"
        "## missing_action: attack the scout on my border\n"
        "needed: an attack action\n"
        "I fortified instead.\n\n"
        "## unclear_option: choose between two governments\n"
        "Needed: what each policy slot does\n",
        encoding="utf-8")
    entries = s.friction_entries()
    assert [e["kind"] for e in entries] == ["missing_action", "unclear_option"]
    assert entries[0] == {"kind": "missing_action", "goal": "attack the scout on my border",
                          "needed": "an attack action", "note": "I fortified instead."}
    assert entries[1]["needed"] == "what each policy slot does" and entries[1]["note"] == ""


def test_permission_rules_name_this_directory_only_in_the_clients_absolute_form(tmp_path):
    s = SeatSession(root=tmp_path, seat=3)
    rules = s.permission_rules()
    assert len(rules) == 5 and all(r.endswith(f"(//{s.dir}/**)") for r in rules)
    assert {r.split("(")[0] for r in rules} == {"Read", "Write", "Edit", "Glob", "Grep"}
    # the other seats' directories are not inside this one
    other = SeatSession(root=tmp_path, seat=4)
    assert not str(other.dir).startswith(str(s.dir))


@pytest.mark.parametrize("bad", [-1, True, "2", 1.5])
def test_a_session_needs_a_real_seat_number(tmp_path, bad):
    with pytest.raises(ValueError):
        SeatSession(root=tmp_path, seat=bad)


def test_operator_directives_live_above_every_seat_and_are_none_when_absent_or_empty(tmp_path):
    assert operator_directives(tmp_path) is None
    (tmp_path / "DIRECTIVES.md").write_text("  \n", encoding="utf-8")
    assert operator_directives(tmp_path) is None
    (tmp_path / "DIRECTIVES.md").write_text("- Open a trade route as soon as one is available.\n", encoding="utf-8")
    assert operator_directives(tmp_path) == "- Open a trade route as soon as one is available."
    # a seat's own directory never contains it, so a seat cannot edit what it is told
    s = SeatSession(root=tmp_path, seat=1); s.prepare()
    assert not (s.dir / "DIRECTIVES.md").exists()
    assert not str((tmp_path / "DIRECTIVES.md").resolve()).startswith(str(s.dir))
