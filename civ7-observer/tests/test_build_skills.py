"""The strategy guide is translated into runtime cards by a tool, never by hand.

These tests pin the translation: it is idempotent, it copies text verbatim rather than
paraphrasing, and the committed cards match the current guide.
"""
import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
BUILDER = ROOT / "tools" / "build_skills.py"
GUIDE = ROOT.parent / "plans" / "CIV7-AGENT-STRATEGY-GUIDE.md"
SKILLS = ROOT / "src" / "civ7_observer" / "skills"

pytestmark = pytest.mark.skipif(not GUIDE.exists(), reason="strategy guide is local, untracked material")


def build_to(tmp: Path):
    sys.path.insert(0, str(ROOT / "tools"))
    import build_skills
    return build_skills.build(GUIDE, tmp)


def test_translation_is_idempotent(tmp_path):
    first = build_to(tmp_path)
    second = build_to(tmp_path)
    assert first == second


def test_committed_cards_match_the_guide():
    proc = subprocess.run([sys.executable, str(BUILDER), "--check"], capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr


def test_check_fails_when_a_card_drifts(tmp_path):
    scratch = tmp_path / "skills"
    subprocess.run([sys.executable, str(BUILDER), "--out", str(scratch)], check=True, capture_output=True)
    card = next(scratch.glob("civ7-*.md"))
    card.write_text(card.read_text() + "\nhand-edited\n")
    proc = subprocess.run([sys.executable, str(BUILDER), "--out", str(scratch), "--check"], capture_output=True, text=True)
    assert proc.returncode == 1 and "out of date" in proc.stderr


def test_runtime_maintained_card_survives_check_and_regeneration(tmp_path):
    scratch = tmp_path / "skills"
    command = [sys.executable, str(BUILDER), "--out", str(scratch)]
    subprocess.run(command, check=True, capture_output=True)
    card = scratch / "civ7-reconnaissance-and-memory.md"
    curated = "<!-- Runtime-maintained: direct strategy edit -->\n# Curated exploration\n"
    card.write_text(curated)
    subprocess.run(command + ["--check"], check=True, capture_output=True)
    subprocess.run(command, check=True, capture_output=True)
    assert card.read_text() == curated


def test_every_skill_in_the_guide_becomes_a_card(tmp_path):
    files = build_to(tmp_path)
    cards = [n for n in files if n.startswith("civ7-") and n.endswith(".md")]
    anchors = [line for line in GUIDE.read_text(encoding="utf-8").splitlines() if line.startswith('<a id="civ7-')]
    assert len(cards) == len(anchors) == 25
    index = json.loads(files["index.json"])
    assert set(index["skills"]) == {c[:-3] for c in cards}


def test_card_text_is_copied_verbatim_not_paraphrased(tmp_path):
    """Every prose line of every card must appear in the guide, character for character."""
    guide_lines = {line.strip() for line in GUIDE.read_text(encoding="utf-8").splitlines() if line.strip()}
    files = build_to(tmp_path)
    for name, content in files.items():
        if not name.endswith(".md"):
            continue
        for line in content.splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or stripped.startswith("**Use when:**") or stripped.startswith("Needs to "):
                continue          # headings and the generated metadata line are the tool's own labels
            assert stripped in guide_lines or _delinked(stripped, guide_lines), f"{name}: {stripped[:80]!r} is not in the guide"


def _delinked(line: str, guide_lines: set[str]) -> bool:
    """Cards strip markdown anchors, so compare against the de-linked guide line too."""
    import re
    pattern = re.compile(r"\[([^\]]+)\]\(#[^)]+\)")
    return any(pattern.sub(r"\1", g) == line for g in guide_lines)


def test_reader_only_sections_are_dropped(tmp_path):
    files = build_to(tmp_path)
    for name, content in files.items():
        if name.startswith("civ7-"):
            assert "## Example and test" not in content and "## Decision record" not in content


def test_index_and_rules_are_consistent(tmp_path):
    files = build_to(tmp_path)
    index = json.loads(files["index.json"])
    rules = json.loads(files["rules.json"])
    assert set(index["rules"]) == set(rules)
    for skill_id, entry in index["skills"].items():
        assert entry["purpose"] and entry["file"] == f"{skill_id}.md"
        assert set(entry["rules"]) <= set(rules), f"{skill_id} references an unknown rule"
        assert entry["read"], f"{skill_id} lists no read capabilities"
    assert all(r["title"] and r["text"] for r in rules.values())


def test_missing_guide_exits_cleanly(tmp_path):
    proc = subprocess.run([sys.executable, str(BUILDER), "--guide", str(tmp_path / "nope.md")], capture_output=True, text=True)
    assert proc.returncode == 2 and "not found" in proc.stderr
