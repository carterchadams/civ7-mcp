import json

import pytest

from civ7_observer.workspace import PlanConflict, Workspace

ATTACH = {"match": "M1", "generation": 1, "seat": 1, "turn": 12, "age": 4242}


def ws(tmp_path, **kw):
    return Workspace(root=tmp_path, seat=1, **kw)


def test_new_workspace_starts_with_an_empty_plan(tmp_path):
    w = ws(tmp_path)
    plan = w.plan()
    assert plan["revision"] == 0 and plan["commitments"] == [] and plan["seat"] == 1
    assert (tmp_path / "seat1").is_dir()


def test_commitments_are_added_revised_and_cancelled_under_a_revision(tmp_path):
    w = ws(tmp_path)
    p1 = w.apply(ATTACH, expected_revision=0, operations=[
        {"op": "add_commitment", "id": "c1", "objective": "Explore north", "entities": ["unit:131072"],
         "next_intent": "move the northern scout", "review": "when it meets a rival or a coast"}])
    assert p1["revision"] == 1 and len(p1["commitments"]) == 1
    p2 = w.apply(ATTACH, expected_revision=1, operations=[
        {"op": "set_next_intent", "id": "c1", "next_intent": "keep moving north-east"}])
    assert p2["commitments"][0]["next_intent"] == "keep moving north-east" and p2["revision"] == 2
    p3 = w.apply(ATTACH, expected_revision=2, operations=[{"op": "cancel_commitment", "id": "c1", "reason": "coast reached"}])
    assert p3["commitments"] == [] and p3["closed"][0]["reason"] == "coast reached"


def test_a_stale_revision_is_rejected_so_edits_cannot_be_lost(tmp_path):
    w = ws(tmp_path)
    w.apply(ATTACH, expected_revision=0, operations=[{"op": "add_commitment", "id": "c1", "objective": "x"}])
    with pytest.raises(PlanConflict):
        w.apply(ATTACH, expected_revision=0, operations=[{"op": "add_commitment", "id": "c2", "objective": "y"}])


def test_unknown_operations_and_targets_are_refused(tmp_path):
    w = ws(tmp_path)
    with pytest.raises(ValueError):
        w.apply(ATTACH, expected_revision=0, operations=[{"op": "delete_everything"}])
    with pytest.raises(ValueError):
        w.apply(ATTACH, expected_revision=0, operations=[{"op": "set_next_intent", "id": "missing", "next_intent": "x"}])


def test_the_attention_budget_is_capped(tmp_path):
    w = ws(tmp_path, max_commitments=2)
    w.apply(ATTACH, expected_revision=0, operations=[
        {"op": "add_commitment", "id": "a", "objective": "1"}, {"op": "add_commitment", "id": "b", "objective": "2"}])
    with pytest.raises(ValueError, match="at most 2"):
        w.apply(ATTACH, expected_revision=1, operations=[{"op": "add_commitment", "id": "c", "objective": "3"}])


def test_a_readable_plan_is_generated_next_to_the_structured_one(tmp_path):
    w = ws(tmp_path)
    w.apply(ATTACH, expected_revision=0, operations=[
        {"op": "add_commitment", "id": "c1", "objective": "Explore north", "next_intent": "move the scout"}])
    text = (tmp_path / "seat1" / "PLAN.md").read_text()
    assert "Explore north" in text and "move the scout" in text and "revision 1" in text
    assert json.loads((tmp_path / "seat1" / "plan.json").read_text())["revision"] == 1


def test_a_new_attachment_requires_reattachment_instead_of_silently_applying(tmp_path):
    w = ws(tmp_path)
    w.apply(ATTACH, expected_revision=0, operations=[{"op": "add_commitment", "id": "c1", "objective": "x"}])
    later = {**ATTACH, "generation": 2}
    assert w.needs_reattachment(later) is True
    with pytest.raises(PlanConflict, match="reattach"):
        w.apply(later, expected_revision=1, operations=[{"op": "add_commitment", "id": "c2", "objective": "y"}])
    plan = w.reattach(later, note="new save generation")
    assert plan["attachment"]["generation"] == 2 and plan["reattachedNote"] == "new save generation"
    assert [c["status"] for c in plan["commitments"]] == ["needs_review"]
    assert w.needs_reattachment(later) is False


def test_friction_entries_are_appended_with_host_context(tmp_path):
    w = ws(tmp_path)
    w.record_friction(ATTACH, kind="missing_action", goal="found a settlement", needed="a found_settlement action",
                      note="settler idle at (12,9)", blocking="UNITS", decision="unit")
    w.record_friction(ATTACH, kind="missing_information", goal="choose production", needed="unit cost and build time")
    rows = [json.loads(l) for l in (tmp_path / "seat1" / "friction.jsonl").read_text().splitlines()]
    assert [r["kind"] for r in rows] == ["missing_action", "missing_information"]
    assert rows[0]["match"] == "M1" and rows[0]["turn"] == 12 and rows[0]["seat"] == 1 and rows[0]["blocking"] == "UNITS"
    assert rows[0]["at"].endswith("Z") and rows[0]["needed"] == "a found_settlement action"


def test_friction_rejects_an_unknown_kind_and_empty_fields(tmp_path):
    w = ws(tmp_path)
    with pytest.raises(ValueError):
        w.record_friction(ATTACH, kind="vibes", goal="g", needed="n")
    with pytest.raises(ValueError):
        w.record_friction(ATTACH, kind="blocked", goal="", needed="n")


def test_plan_excerpt_is_short_and_mentions_due_commitments(tmp_path):
    w = ws(tmp_path)
    w.apply(ATTACH, expected_revision=0, operations=[
        {"op": "add_commitment", "id": "c1", "objective": "Explore north", "next_intent": "move the scout",
         "review": "on contact"}])
    excerpt = w.excerpt()
    assert "Explore north" in excerpt and "move the scout" in excerpt and len(excerpt) < 800
    assert w.excerpt() == excerpt
