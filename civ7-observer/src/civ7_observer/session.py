"""One seat's own working directory, and nothing else on the machine.

The game server is a pure game interface: it observes and acts, and it keeps no notion of what the
agent playing the seat intends. Whatever an agent wants to remember across turns lives here instead,
in files it reads and writes itself with ordinary file tools. The driver confines those tools to this
directory and injects `PLAN.md` into every prompt, so the plan is the agent's, kept where the agent
keeps it, and the harness only carries it forward.

Layout, one directory per seat and never shared, because a seat that could read another seat's
directory could read its mind:

    <root>/seat<N>/
        README.md       what this directory is and the two files the harness looks at (rewritten each turn)
        PLAN.md         the seat's canonical plan; injected into every prompt; the agent keeps it current
        FRICTION.md     what the seat could not do, one entry per problem; the harness reads new entries
        skills/*.md     the skill cards, copied in so the agent can read any of them without leaving

Nothing here is ever read for another seat, and nothing here touches the game.

One file sits above the seat directories and belongs to the operator, not to any seat:

    <root>/DIRECTIVES.md    testing goals every seat is given at the top of every prompt

Seats cannot reach it (it is outside their directory) and the driver injects its text verbatim,
so an operator can steer what gets exercised, such as "open a trade route as soon as one is
available", without touching a seat's own plan.
"""

from __future__ import annotations

import re
from pathlib import Path

from civ7_observer import skills

DIRECTIVES_FILE = "DIRECTIVES.md"
PLAN_FILE = "PLAN.md"
FRICTION_FILE = "FRICTION.md"
SKILLS_DIR = "skills"
README_FILE = "README.md"

EMPTY_PLAN = "(no plan yet: write PLAN.md in your session directory and it will be here next turn)"
FRICTION_KINDS = ("missing_action", "missing_information", "unclear_option", "blocked")
# One friction entry: a level-two heading "## <kind>: <goal>" followed by a "needed:" line. Kept as
# plain Markdown so an agent writes it with the same tool it writes everything else with.
_ENTRY = re.compile(r"^## +(?P<kind>[a-z_]+) *: *(?P<goal>.+?) *$", re.MULTILINE)
_NEEDED = re.compile(r"^needed *: *(?P<needed>.+?) *$", re.MULTILINE | re.IGNORECASE)

README = """# Seat {seat}: your session directory

This directory is yours. Read and write anything in it; nothing outside it is reachable, by design,
and nothing in it touches the game. The game is reached only through the civ7 tools.

Two files are read by the harness:

- `PLAN.md`: your canonical plan. Its contents are placed in your instructions at the start of every
  turn, so keep it current and short: the commitments you are pursuing, what each needs next, and
  what would make you drop it. You are the only writer.
- `FRICTION.md`: what you could not do. Append one entry per distinct problem, as

      ## <kind>: <what you were trying to achieve>
      needed: <the specific action, field or fact that would have let you decide>
      <optional detail, including what you did instead>

  where kind is one of {kinds}. New entries are collected after each turn; they are the list of
  what gets built next.

`skills/` holds every skill card. The ones for this turn's decisions are already in your
instructions; read another from here when a decision is outside them.
"""


class SeatSession:
    def __init__(self, root: Path, seat: int) -> None:
        if isinstance(seat, bool) or not isinstance(seat, int) or seat < 0:
            raise ValueError(f"seat must be a non-negative integer, got {seat!r}")
        self.seat = seat
        self.dir = Path(root).resolve() / f"seat{seat}"
        self.plan_path = self.dir / PLAN_FILE
        self.friction_path = self.dir / FRICTION_FILE
        self.skills_dir = self.dir / SKILLS_DIR
        self.readme_path = self.dir / README_FILE

    def prepare(self) -> Path:
        """Make the directory ready for a turn: the README and a fresh copy of every skill card.
        The agent's own files are never touched."""
        self.skills_dir.mkdir(parents=True, exist_ok=True)
        self.readme_path.write_text(README.format(seat=self.seat, kinds=", ".join(FRICTION_KINDS)), encoding="utf-8")
        for skill_id in list(skills.index()["skills"]) + ["friction"]:
            (self.skills_dir / f"{skill_id}.md").write_text(skills.card(skill_id), encoding="utf-8")
        return self.dir

    # ---- what the harness reads
    def plan_text(self) -> str:
        """The plan as the agent last left it, for injection into the prompt."""
        if not self.plan_path.exists():
            return EMPTY_PLAN
        text = self.plan_path.read_text(encoding="utf-8").strip()
        return text or EMPTY_PLAN

    def friction_entries(self) -> list[dict[str, str]]:
        """Every entry in FRICTION.md, in order, as {kind, goal, needed, note}."""
        if not self.friction_path.exists():
            return []
        text = self.friction_path.read_text(encoding="utf-8")
        heads = list(_ENTRY.finditer(text))
        entries = []
        for i, head in enumerate(heads):
            body = text[head.end():heads[i + 1].start() if i + 1 < len(heads) else len(text)]
            needed = _NEEDED.search(body)
            note_lines = [line for line in body.strip().splitlines() if not _NEEDED.match(line)]
            entries.append({"kind": head.group("kind"), "goal": head.group("goal").strip(),
                            "needed": needed.group("needed").strip() if needed else "",
                            "note": "\n".join(note_lines).strip()})
        return entries

    # ---- what the harness grants
    def permission_rules(self) -> list[str]:
        """The client's path-scoped rules for this directory and no other. The double slash is the
        client's absolute-path form; a single leading slash is taken relative to the project and
        silently grants nothing (verified against this client)."""
        return [f"{tool}(//{self.dir}/**)" for tool in ("Read", "Write", "Edit", "Glob", "Grep")]


def operator_directives(root: Path) -> str | None:
    """The operator's standing directives for every seat, or None when the file is absent or empty.
    Read fresh each turn, so an edit takes effect at the next seat turn without a restart."""
    path = Path(root) / DIRECTIVES_FILE
    if not path.exists():
        return None
    text = path.read_text(encoding="utf-8").strip()
    return text or None
