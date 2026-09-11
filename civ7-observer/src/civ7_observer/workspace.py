"""The agent's own per-seat workspace: its plan and its friction reports.

The host does not write strategy here. The agent supplies bounded plan operations and the host
applies them atomically under a revision, so two edits cannot silently overwrite each other. The
friction log is the record of what the agent could not do: it is how the action catalog gets its
next item, so entries are structured rather than prose.

One directory per seat, never shared: `<root>/seat<N>/{plan.json,PLAN.md,friction.jsonl}`.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from civ7_observer.probe import write_atomic

SCHEMA_VERSION = 1
DEFAULT_MAX_COMMITMENTS = 3          # the guide's starter attention budget, tunable, not a game rule
FRICTION_KINDS = ("missing_action", "missing_information", "unclear_option", "blocked")
OPERATIONS = ("add_commitment", "revise_commitment", "cancel_commitment", "set_next_intent")
COMMITMENT_FIELDS = ("id", "objective", "entities", "next_intent", "review", "reservation", "assumptions")
MAX_TEXT = 400


class PlanConflict(Exception):
    """The plan moved under the caller, or the game did."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _text(value: object, field: str, *, required: bool = False) -> str:
    if value is None and not required:
        return ""
    if not isinstance(value, str) or (required and not value.strip()):
        raise ValueError(f"{field} must be a non-empty string")
    if len(value) > MAX_TEXT:
        raise ValueError(f"{field} is longer than {MAX_TEXT} characters")
    return value.strip()


class Workspace:
    def __init__(self, root: Path, seat: int, max_commitments: int = DEFAULT_MAX_COMMITMENTS) -> None:
        self.seat = seat
        self.dir = Path(root) / f"seat{seat}"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.plan_path = self.dir / "plan.json"
        self.readable_path = self.dir / "PLAN.md"
        self.friction_path = self.dir / "friction.jsonl"
        self.max_commitments = max_commitments

    # ---- plan
    def plan(self) -> dict[str, Any]:
        if not self.plan_path.exists():
            return {"schemaVersion": SCHEMA_VERSION, "seat": self.seat, "revision": 0,
                    "attachment": None, "commitments": [], "closed": []}
        return json.loads(self.plan_path.read_text(encoding="utf-8"))

    def needs_reattachment(self, attachment: dict[str, Any]) -> bool:
        """A plan written for one match/generation must not be applied to another without review."""
        current = self.plan().get("attachment")
        if current is None:
            return False
        return (current.get("match"), current.get("generation")) != (attachment.get("match"), attachment.get("generation"))

    def reattach(self, attachment: dict[str, Any], *, note: str) -> dict[str, Any]:
        plan = self.plan()
        plan["attachment"] = dict(attachment)
        plan["reattachedNote"] = _text(note, "note", required=True)
        plan["revision"] += 1
        for commitment in plan["commitments"]:
            commitment["status"] = "needs_review"
        self._save(plan)
        return plan

    def apply(self, attachment: dict[str, Any], *, expected_revision: int, operations: list[dict[str, Any]]) -> dict[str, Any]:
        plan = self.plan()
        if self.needs_reattachment(attachment):
            raise PlanConflict("the plan belongs to a different match or attachment generation; reattach it first")
        if expected_revision != plan["revision"]:
            raise PlanConflict(f"plan revision is {plan['revision']}, not {expected_revision}; re-read the plan")
        if not isinstance(operations, list) or not operations:
            raise ValueError("operations must be a non-empty list")
        for operation in operations:
            self._apply_one(plan, operation)
        plan["attachment"] = dict(attachment)
        plan["revision"] += 1
        self._save(plan)
        return plan

    def _find(self, plan: dict[str, Any], commitment_id: str) -> dict[str, Any]:
        for commitment in plan["commitments"]:
            if commitment["id"] == commitment_id:
                return commitment
        raise ValueError(f"no open commitment with id {commitment_id!r}")

    def _apply_one(self, plan: dict[str, Any], operation: dict[str, Any]) -> None:
        if not isinstance(operation, dict) or operation.get("op") not in OPERATIONS:
            raise ValueError(f"operation must be one of {OPERATIONS}")
        op = operation["op"]
        commitment_id = _text(operation.get("id"), "id", required=True)
        if op == "add_commitment":
            if any(c["id"] == commitment_id for c in plan["commitments"]):
                raise ValueError(f"commitment {commitment_id!r} already exists")
            if len(plan["commitments"]) >= self.max_commitments:
                raise ValueError(f"a plan holds at most {self.max_commitments} open commitments; cancel one first")
            entities = operation.get("entities") or []
            if not isinstance(entities, list) or any(not isinstance(e, str) for e in entities):
                raise ValueError("entities must be a list of strings")
            plan["commitments"].append({
                "id": commitment_id, "objective": _text(operation.get("objective"), "objective", required=True),
                "entities": entities[:8], "next_intent": _text(operation.get("next_intent"), "next_intent"),
                "review": _text(operation.get("review"), "review"), "reservation": _text(operation.get("reservation"), "reservation"),
                "assumptions": _text(operation.get("assumptions"), "assumptions"), "status": "active", "opened": _now(),
            })
        elif op == "revise_commitment":
            commitment = self._find(plan, commitment_id)
            for field in ("objective", "next_intent", "review", "reservation", "assumptions"):
                if field in operation:
                    commitment[field] = _text(operation[field], field, required=(field == "objective"))
            commitment["status"] = "active"
        elif op == "set_next_intent":
            self._find(plan, commitment_id)["next_intent"] = _text(operation.get("next_intent"), "next_intent", required=True)
        elif op == "cancel_commitment":
            commitment = self._find(plan, commitment_id)
            plan["commitments"].remove(commitment)
            plan.setdefault("closed", []).append({**commitment, "status": "closed", "closed": _now(),
                                                  "reason": _text(operation.get("reason"), "reason", required=True)})
            plan["closed"] = plan["closed"][-10:]

    def _save(self, plan: dict[str, Any]) -> None:
        write_atomic(self.plan_path, json.dumps(plan, indent=2, ensure_ascii=False))
        write_atomic(self.readable_path, self._render(plan))

    def _render(self, plan: dict[str, Any]) -> str:
        attachment = plan.get("attachment") or {}
        lines = [f"# Plan for seat {self.seat} (revision {plan['revision']})", ""]
        if attachment:
            lines.append(f"Match {attachment.get('match')} generation {attachment.get('generation')}, "
                         f"last edited on turn {attachment.get('turn')}.")
            lines.append("")
        if not plan["commitments"]:
            lines.append("No open commitments.")
        for commitment in plan["commitments"]:
            lines.append(f"## {commitment['objective']} ({commitment['id']}, {commitment['status']})")
            for label, key in (("Next", "next_intent"), ("Review", "review"), ("Reserved", "reservation"),
                               ("Assumes", "assumptions")):
                if commitment.get(key):
                    lines.append(f"- {label}: {commitment[key]}")
            if commitment.get("entities"):
                lines.append(f"- Entities: {', '.join(commitment['entities'])}")
            lines.append("")
        return "\n".join(lines).rstrip() + "\n"

    def excerpt(self) -> str:
        """The short plan reminder that goes into the prompt each turn."""
        plan = self.plan()
        if not plan["commitments"]:
            return "No open commitments."
        parts = []
        for commitment in plan["commitments"]:
            bits = [f"{commitment['id']}: {commitment['objective']}"]
            if commitment.get("next_intent"):
                bits.append(f"next: {commitment['next_intent']}")
            if commitment.get("review"):
                bits.append(f"review: {commitment['review']}")
            if commitment["status"] != "active":
                bits.append(f"status: {commitment['status']}")
            parts.append(" | ".join(bits))
        return f"Plan revision {plan['revision']}\n" + "\n".join(parts)

    # ---- friction
    def record_friction(self, attachment: dict[str, Any], *, kind: str, goal: str, needed: str,
                        note: str = "", blocking: str | None = None, decision: str | None = None) -> dict[str, Any]:
        if kind not in FRICTION_KINDS:
            raise ValueError(f"kind must be one of {FRICTION_KINDS}")
        entry = {
            "at": _now(), "kind": kind, "goal": _text(goal, "goal", required=True),
            "needed": _text(needed, "needed", required=True), "note": _text(note, "note"),
            "blocking": blocking, "decision": decision, "seat": self.seat,
            "match": attachment.get("match"), "generation": attachment.get("generation"),
            "turn": attachment.get("turn"), "age": attachment.get("age"),
        }
        with open(self.friction_path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
        return entry

    def friction(self) -> list[dict[str, Any]]:
        if not self.friction_path.exists():
            return []
        return [json.loads(line) for line in self.friction_path.read_text(encoding="utf-8").splitlines() if line.strip()]
