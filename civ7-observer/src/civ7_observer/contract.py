"""The identity of an action kind's implementation: a digest of every source region that decides
how the kind is offered, checked, sent and confirmed.

A receipt proves the variant it exercised under the implementation that produced it, so each
receipt is stamped with this digest at execution time and a recorded pass is current only while the
digest is unchanged. The regions are conservative: the whole perform branch (or table row), the
whole offer block, the host's bind and confirm blocks, and the read-back signals those blocks
consult. Changing a guard or a read-back body changes the digest even when no line names the kind.
"""

from __future__ import annotations

import hashlib
import re
from functools import lru_cache
from pathlib import Path

PAYLOADS = Path(__file__).resolve().parent / "payloads"
DEFAULT_SOURCES = (PAYLOADS / "offers.js", PAYLOADS / "perform.js", PAYLOADS / "readback.js", Path(__file__).resolve().parent / "actions.py")


def _blocks(lines: list[str], hits: list[int], is_boundary, *, is_start=None) -> list[str]:
    """For each hit line, the region from the nearest boundary line at or before it to the line
    before the next boundary after it. A hit that reaches no boundary (or one whose region does not
    open on a line `is_start` accepts) contributes only its own line: a table entry, not a branch."""
    out, seen = [], set()
    for h in hits:
        start = h
        while start > 0 and not is_boundary(lines[start]):
            start -= 1
        if not is_boundary(lines[start]) or (is_start and not is_start(lines[start])):
            start, end = h, h + 1
        else:
            end = h + 1
            while end < len(lines) and not is_boundary(lines[end]):
                end += 1
        if (start, end) in seen:
            continue
        seen.add((start, end))
        out.append("\n".join(lines[start:end]))
    return out


def _offer_regions(lines: list[str], hits: list[int]) -> list[str]:
    """offers.js is nested loops over cities and units, so a kind's region is the stretch between the
    previous offer statement (or section header) and the end of the statement that names it: the
    guards and computations that decide whether and how the kind is offered."""
    out, seen = [], set()
    def closes(i: int) -> bool:
        return lines[i].rstrip().endswith("});") or lines[i].strip().startswith("// ----")
    for h in hits:
        start = h - 1
        while start >= 0 and not closes(start):
            start -= 1
        start += 1
        end = h
        while end < len(lines) - 1 and not lines[end].rstrip().endswith("});"):
            end += 1
        end += 1
        if (start, end) in seen:
            continue
        seen.add((start, end))
        out.append("\n".join(lines[start:end]))
    return out


def regions(kind: str, sources: tuple[Path, ...] | list[Path] = DEFAULT_SOURCES) -> list[str]:
    needle = f'"{kind}"'
    found: list[str] = []
    signals: set[str] = set()
    for path in sources:
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8")
        lines = text.splitlines()
        hits = [i for i, line in enumerate(lines) if needle in line]
        if not hits:
            continue
        name = path.name
        if name == "perform.js":
            # a branch runs from its `if (KIND ===` to the next branch or section at the same indent
            blocks = _blocks(lines, hits, lambda l: l.startswith("  if (KIND ===") or l.startswith("  // ----") or l.startswith("  const ") or l.startswith("  return "),
                             is_start=lambda l: l.startswith("  if (KIND ==="))
        elif name == "offers.js":
            blocks = _offer_regions(lines, hits)
        elif name == "actions.py":
            # a kind listed in a module-level table is handled by every branch that tests that table
            for h in list(hits):
                i = h
                while i > 0 and not re.match(r"^[A-Z_]+ = ", lines[i]) and lines[i][:1].isspace():
                    i -= 1
                m = re.match(r"^([A-Z_]+) = ", lines[i])
                if m and m.group(1) != "PUBLIC_KIND":
                    table = m.group(1)
                    hits.extend(j for j, line in enumerate(lines) if j not in hits and re.search(rf"\bkind in {table}\b|\b{table}\[kind\]|\b{table}\.get\(kind", line))
            hits.sort()
            branch = re.compile(r"^\s{8,20}(el)?if kind\b")
            blocks = _blocks(lines, hits, lambda l: branch.match(l) is not None or re.match(r"^\s{0,8}def ", l) is not None,
                             is_start=lambda l: branch.match(l) is not None)
            for b in blocks:
                signals.update(re.findall(r'rb\.get\("([A-Za-z]+)"\)', b))
                signals.update(re.findall(r'readback\.get\("([A-Za-z]+)"\)', b))
        else:
            # any other source: the top-level statement the line belongs to (a branch at column 0 runs to
            # the next column-0 line), so a body change inside it still moves the digest
            blocks = _blocks(lines, hits, lambda l: bool(l) and not l[0].isspace())
        found.extend(f"{name}:{b}" for b in blocks)
    if signals:
        for path in sources:
            if path.name == "readback.js" and path.exists():
                for line in path.read_text(encoding="utf-8").splitlines():
                    m = re.match(r"^\s*([A-Za-z]+):", line)
                    if m and m.group(1) in signals:
                        found.append(f"readback.js:{line.strip()}")
    return found


def compute_fingerprint(kind: str, sources: tuple[Path, ...] | list[Path] = DEFAULT_SOURCES) -> str:
    return hashlib.sha1("\n".join(regions(kind, sources)).encode("utf-8")).hexdigest()[:12]


@lru_cache(maxsize=None)
def fingerprint(kind: str) -> str:
    """The current digest for a kind, from the package's own sources; cached for the process."""
    return compute_fingerprint(kind, DEFAULT_SOURCES)
