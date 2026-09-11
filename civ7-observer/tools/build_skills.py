#!/usr/bin/env python3
"""Translate the strategy guide into runtime skill cards for the runner.

The guide (`plans/CIV7-AGENT-STRATEGY-GUIDE.md`) is a single reading document. The runner needs
small cards it can load one or two of per decision. This is a deterministic, idempotent
translation: it parses the guide's structure and writes one card per skill, a rule index and a
compact operating card. Re-running it on an unchanged guide rewrites identical bytes, so the
generated tree can be committed and reviewed as a diff.

Nothing here paraphrases the guide. Every line of card text is copied verbatim from the source
section it came from; the tool only selects, orders and labels.

    python tools/build_skills.py [--guide PATH] [--out DIR] [--check]

`--check` verifies that the committed cards match what the current guide produces (exit 1 if not).
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
DEFAULT_GUIDE = HERE.parent.parent / "plans" / "CIV7-AGENT-STRATEGY-GUIDE.md"
DEFAULT_OUT = HERE.parent / "src" / "civ7_observer" / "skills"

ANCHOR = re.compile(r'^<a id="([^"]+)"></a>$')
H2 = re.compile(r"^## (.+)$")
H3 = re.compile(r"^### (.+)$")
META = re.compile(r"^\*\*([^*]+):\*\*\s*(.*)$")
RULE_HEADING = re.compile(r"^R-([A-Z]+)\s+—\s+(.+)$")
LINK = re.compile(r"\[([^\]]+)\]\(#([^)]+)\)")
CODE_TERM = re.compile(r"`([^`]+)`")

# Sections that exist for a human reader, not for a runtime decision: acceptance fixtures and a
# pointer to the shared output contract. Dropped from every card.
DROPPED_SECTIONS = ("Example and test", "Failure and example", "Decision record")
# Playbook subsections the runner always needs, in this order.
OPERATING_SECTIONS = ("The turn loop", "Priority ladder", "Economic literacy", "Output contract",
                      "Fair-play and execution boundaries")
SKILL_ID = re.compile(r"^civ7-[a-z0-9-]+$")
# Only these names are owned by this tool. The output directory is a real package: it also holds the
# hand-written loader and the local/ cards, and neither is ever rewritten, reported or deleted here.
GENERATED_NAME = re.compile(r"^(civ7-[a-z0-9-]+\.md|operating\.md|rules\.json|index\.json)$")


def _strip_links(text: str) -> str:
    """Markdown anchors are meaningless outside the guide; keep the visible words."""
    return LINK.sub(r"\1", text)


def _split_sections(lines: list[str]) -> list[tuple[str, list[str]]]:
    """Split a block of guide lines into (### heading, body) pairs, preserving order."""
    sections: list[tuple[str, list[str]]] = []
    current: tuple[str, list[str]] | None = None
    for line in lines:
        h3 = H3.match(line)
        if h3:
            if current:
                sections.append(current)
            current = (h3.group(1).strip(), [])
        elif current:
            current[1].append(line)
    if current:
        sections.append(current)
    return sections


def _trim(body: list[str]) -> list[str]:
    while body and not body[0].strip():
        body.pop(0)
    while body and not body[-1].strip():
        body.pop()
    return body


def parse_guide(text: str) -> dict[str, Any]:
    """Structure the guide: top-level blocks keyed by their anchor id."""
    lines = text.splitlines()
    blocks: dict[str, dict[str, Any]] = {}
    anchor: str | None = None
    current: dict[str, Any] | None = None
    for i, line in enumerate(lines):
        a = ANCHOR.match(line.strip())
        if a:
            anchor = a.group(1)
            continue
        h2 = H2.match(line)
        if h2:
            current = {"id": anchor, "title": h2.group(1).strip(), "lines": []}
            blocks[anchor or h2.group(1).strip()] = current
            anchor = None
            continue
        if current is not None:
            current["lines"].append(line)
    return blocks


def parse_skill(block: dict[str, Any]) -> dict[str, Any]:
    """One skill section into a card: metadata plus the decision-relevant sections."""
    meta: dict[str, str] = {}
    for line in block["lines"]:
        m = META.match(line.strip())
        if m and m.group(1) in ("Purpose", "Conceptual read capabilities",
                                "Execution capabilities, only when enabled", "Mechanics orientation"):
            meta[m.group(1)] = m.group(2).strip()
    sections = [(name, _trim(body)) for name, body in _split_sections(block["lines"])
                if name not in DROPPED_SECTIONS]
    orientation = meta.get("Mechanics orientation", "")
    rules = sorted({label for label, _ in LINK.findall(orientation) if label.startswith("R-")})
    return {
        "id": block["id"],
        "title": block["title"],
        "purpose": _strip_links(meta.get("Purpose", "")),
        "read": sorted(CODE_TERM.findall(meta.get("Conceptual read capabilities", ""))),
        "execute": sorted(CODE_TERM.findall(meta.get("Execution capabilities, only when enabled", ""))),
        "rules": rules,
        "sections": [(name, [_strip_links(x) for x in body]) for name, body in sections],
    }


def parse_rules(block: dict[str, Any]) -> list[dict[str, str]]:
    rules = []
    for name, body in _split_sections(block["lines"]):
        m = RULE_HEADING.match(name)
        if not m:
            continue
        rules.append({"id": f"R-{m.group(1)}", "title": m.group(2).strip(),
                      "text": "\n".join(_strip_links(x) for x in _trim(body)).strip()})
    return rules


def render_card(skill: dict[str, Any]) -> str:
    head = [f"# {skill['title']}", ""]
    if skill["purpose"]:
        head += [f"**Use when:** {skill['purpose']}", ""]
    facts = []
    if skill["read"]:
        facts.append(f"Needs to read: {', '.join(skill['read'])}.")
    if skill["execute"]:
        facts.append(f"Needs to execute (only if enabled): {', '.join(skill['execute'])}.")
    if skill["rules"]:
        facts.append(f"Rules: {', '.join(skill['rules'])}.")
    if facts:
        head += [" ".join(facts), ""]
    parts = ["\n".join(head).rstrip()]
    for name, body in skill["sections"]:
        parts.append(f"## {name}\n\n" + "\n".join(body).strip())
    return "\n\n".join(p for p in parts if p.strip()) + "\n"


def render_operating(block: dict[str, Any]) -> str:
    wanted = {name: body for name, body in _split_sections(block["lines"])}
    parts = ["# Operating contract", ""]
    for name in OPERATING_SECTIONS:
        if name in wanted:
            parts.append(f"## {name}\n\n" + "\n".join(_strip_links(x) for x in _trim(wanted[name])).strip())
    return "\n\n".join(p for p in parts if p.strip()) + "\n"


def build(guide_path: Path, out_dir: Path) -> dict[str, str]:
    """Return the complete generated tree as {relative path: content}."""
    blocks = parse_guide(guide_path.read_text(encoding="utf-8"))
    files: dict[str, str] = {}

    playbook = blocks.get("operating-playbook")
    if playbook is None:
        raise SystemExit("guide has no operating-playbook section")
    files["operating.md"] = render_operating(playbook)

    rules_block = blocks.get("rules-baseline")
    rules = parse_rules(rules_block) if rules_block else []
    files["rules.json"] = json.dumps({r["id"]: {"title": r["title"], "text": r["text"]} for r in rules},
                                     indent=2, sort_keys=True, ensure_ascii=False) + "\n"

    index: dict[str, Any] = {"source": guide_path.name, "skills": {}, "rules": sorted(r["id"] for r in rules)}
    for key, block in blocks.items():
        if not (block["id"] and SKILL_ID.match(block["id"])):
            continue
        skill = parse_skill(block)
        name = f"{skill['id']}.md"
        files[name] = render_card(skill)
        index["skills"][skill["id"]] = {
            "title": skill["title"], "purpose": skill["purpose"], "file": name,
            "read": skill["read"], "execute": skill["execute"], "rules": skill["rules"],
        }
    files["index.json"] = json.dumps(index, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    return files


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--guide", type=Path, default=DEFAULT_GUIDE)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--check", action="store_true", help="verify the committed cards match the guide")
    args = ap.parse_args(argv)
    if not args.guide.exists():
        print(f"guide not found: {args.guide}", file=sys.stderr)
        return 2
    files = build(args.guide, args.out)
    if args.check:
        stale = [name for name, content in files.items()
                 if not (args.out / name).exists() or (args.out / name).read_text(encoding="utf-8") != content]
        extra = [p.name for p in args.out.glob("*")
                 if p.is_file() and GENERATED_NAME.match(p.name) and p.name not in files]
        if stale or extra:
            print(f"skill cards are out of date (stale: {stale}, unexpected: {extra}); run tools/build_skills.py", file=sys.stderr)
            return 1
        print(f"{len(files)} generated files match the guide")
        return 0
    args.out.mkdir(parents=True, exist_ok=True)
    for name, content in files.items():
        (args.out / name).write_text(content, encoding="utf-8")
    for path in args.out.glob("*"):
        if path.is_file() and GENERATED_NAME.match(path.name) and path.name not in files:
            path.unlink()
    print(f"wrote {len(files)} files to {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
