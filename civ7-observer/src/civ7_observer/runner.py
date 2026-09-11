"""The agent runner: one model plays one bound seat's turn through the offered actions.

The runner is a client of the same validated service the CLI and the MCP server use. It holds no
privileged shortcut: it builds a prompt (operating contract, the skill cards routed for this
turn's decisions, the agent's own plan), hands the model a small tool set, and applies whatever
the model chooses through the action registry.

The model can only ever choose among action ids the host offered. When it cannot decide because a
tool or a fact is missing, it reports friction, and that log is the backlog for the next action.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Protocol

from civ7_observer import cdp, skills
from civ7_observer.actions import ACTION_ID, REQUEST_ID, ActionRegistry
from civ7_observer.attachment import state_dir
from civ7_observer.brief import build_brief
from civ7_observer.service import ObserverError, open_game_session
from civ7_observer.workspace import PlanConflict, Workspace

log = logging.getLogger(__name__)

DEFAULT_MAX_TOOL_CALLS = 40
DEFAULT_MODEL = "claude-sonnet-5"


@dataclass(frozen=True)
class ToolCall:
    id: str
    name: str
    arguments: dict[str, Any]


@dataclass(frozen=True)
class ProviderResponse:
    text: str
    tool_calls: list[ToolCall]


class Provider(Protocol):
    def complete(self, *, system: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> ProviderResponse: ...


@dataclass
class TurnResult:
    status: str                      # turn_ended | paused | stopped | budget_exhausted | error
    report: str = ""
    actions: list[dict[str, Any]] = field(default_factory=list)
    friction: list[dict[str, Any]] = field(default_factory=list)
    pause: dict[str, Any] | None = None
    plan_revision: int = 0
    tool_calls: int = 0
    error: str = ""
    transcript_path: Path | None = None


TOOLS = [
    {
        "name": "get_turn_brief",
        "description": "What this seat must decide now: context, whether the turn can be ended and what the game is "
                       "blocking on, and the pending decisions with a few legal options each. Every option carries an "
                       "actionId. If `pause` is set, stop and report it. Start here and call it again after each action.",
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "list_actions",
        "description": "Every legal action for this seat, when the brief's bounded options are not enough. Long.",
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "perform_action",
        "description": "Perform one offered action. action_id must come from a brief or list_actions in this turn; "
                       "request_id is a short id you choose, which makes the call idempotent. Returns a receipt.",
        "input_schema": {"type": "object", "properties": {
            "action_id": {"type": "string", "description": "an actionId the host offered you"},
            "request_id": {"type": "string", "description": "your own short id, 1-64 chars of A-Za-z0-9._-"},
        }, "required": ["action_id", "request_id"]},
    },
    {
        "name": "load_skill",
        "description": "Load another skill card by id when the current decision is outside the cards already loaded. "
                       "Ids are listed in the operating contract.",
        "input_schema": {"type": "object", "properties": {"skill_id": {"type": "string"}}, "required": ["skill_id"]},
    },
    {
        "name": "update_plan",
        "description": "Edit your own multi-turn plan. Operations: add_commitment, revise_commitment, set_next_intent, "
                       "cancel_commitment. expected_revision must match the revision you were shown.",
        "input_schema": {"type": "object", "properties": {
            "expected_revision": {"type": "integer"},
            "operations": {"type": "array", "items": {"type": "object"}},
        }, "required": ["expected_revision", "operations"]},
    },
    {
        "name": "report_friction",
        "description": "Report that a tool or a fact you needed is missing, instead of guessing. See the friction "
                       "skill card for when and how.",
        "input_schema": {"type": "object", "properties": {
            "kind": {"type": "string", "enum": ["missing_action", "missing_information", "unclear_option", "blocked"]},
            "goal": {"type": "string", "description": "what you were trying to achieve"},
            "needed": {"type": "string", "description": "the specific tool, field or fact that would have let you decide"},
            "note": {"type": "string", "description": "optional detail, including what you did instead"},
        }, "required": ["kind", "goal", "needed"]},
    },
]

INSTRUCTIONS = """You are playing one seat of a Civilization VII game. You control only that seat; \
nothing else is reachable, and every fact you have belongs to it.

Play this turn: read the brief, resolve the decision it marks required, read the brief again, and \
repeat until the turn can be ended, then end it. Stop immediately if the brief sets `pause`.

Choose only action ids the host has offered you in this turn. Never invent one, and never repeat an \
action whose receipt was an error or unknown. If a tool or a fact you need is missing, call \
report_friction rather than guessing.

Keep your visible output short: a line per decision saying what you chose and why, and a closing \
summary. The skill cards below are your procedures; the rest of the catalog can be loaded on demand."""


class Runner:
    def __init__(self, *, port: int, timeout: float, player: int, mode: str, provider: Provider,
                 journal_path: Path | None = None, workspace_root: Path | None = None,
                 target_id: str | None = None, max_tool_calls: int = DEFAULT_MAX_TOOL_CALLS,
                 discover: Callable[[int, float], list[cdp.CdpTarget]] = cdp.discover_targets,
                 session_factory: Callable[..., cdp.CdpSession] = cdp.CdpSession) -> None:
        self.port, self.timeout, self.player, self.mode = port, timeout, player, mode
        self.provider = provider
        self.target_id = target_id
        self.max_tool_calls = max_tool_calls
        self.discover, self.session_factory = discover, session_factory
        self.registry = ActionRegistry(journal_path=journal_path or state_dir() / "journals" / f"seat{player}.jsonl")
        self.workspace = Workspace(root=workspace_root or state_dir() / "workspace", seat=player)
        self.transcript_path = self.workspace.dir / "transcript.jsonl"

    # ---- host-side helpers
    def _session(self, fn):
        with open_game_session(port=self.port, timeout=self.timeout, target_id=self.target_id,
                               discover=self.discover, session_factory=self.session_factory) as gs:
            return fn(gs)

    def _record(self, entry: dict[str, Any]) -> None:
        entry = {"at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"), **entry}
        with open(self.transcript_path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, ensure_ascii=False) + "\n")

    def _brief(self) -> dict[str, Any]:
        return self._session(lambda gs: build_brief(gs, self.registry, player=self.player, mode=self.mode))

    # ---- the tools the model may call
    def _call_tool(self, call: ToolCall, state: dict[str, Any]) -> dict[str, Any]:
        name, args = call.name, call.arguments or {}
        try:
            if name == "get_turn_brief":
                # The seat is the only one acting during its own turn, so a brief taken since the
                # last action is still true: serve it rather than re-reading the game.
                if state.get("brief_fresh") and state.get("brief"):
                    return state["brief"]
                brief = self._brief()
                state["brief"], state["brief_fresh"] = brief, True
                state["attachment"] = brief.get("attachment") or state.get("attachment")
                return brief
            if name == "list_actions":
                return self._session(lambda gs: self.registry.list_offers(gs, player=self.player, mode=self.mode))
            if name == "perform_action":
                action_id, request_id = args.get("action_id"), args.get("request_id")
                if not isinstance(action_id, str) or not ACTION_ID.match(action_id):
                    return {"error": {"code": "UNKNOWN_ACTION", "message": "action_id must be one the host offered you this turn"}}
                if not isinstance(request_id, str) or not REQUEST_ID.match(request_id):
                    return {"error": {"code": "INVALID_REQUEST_ID", "message": "request_id must be 1-64 chars of [A-Za-z0-9._-]"}}
                receipt = self._session(lambda gs: self.registry.perform(
                    gs, action_id=action_id, request_id=request_id, player=self.player, mode=self.mode))
                state["actions"].append(receipt)
                state["brief_fresh"] = False
                if receipt.get("kind") == "END_TURN" and receipt.get("status") == "confirmed":
                    state["turn_ended"] = True
                return receipt
            if name == "load_skill":
                skill_id = args.get("skill_id")
                try:
                    return {"skillId": skill_id, "card": skills.card(skill_id)}
                except KeyError:
                    return {"error": {"code": "UNKNOWN_SKILL", "message": f"no such skill card: {skill_id}"}}
            if name == "update_plan":
                plan = self.workspace.apply(state.get("attachment") or {}, expected_revision=args.get("expected_revision"),
                                            operations=args.get("operations") or [])
                return {"revision": plan["revision"], "commitments": plan["commitments"]}
            if name == "report_friction":
                brief = state.get("brief") or {}
                entry = self.workspace.record_friction(
                    state.get("attachment") or {}, kind=args.get("kind"), goal=args.get("goal"),
                    needed=args.get("needed"), note=args.get("note") or "",
                    blocking=(brief.get("endTurn") or {}).get("blocking"),
                    decision=next((d["kind"] for d in brief.get("decisions", []) if d.get("required")), None))
                state["friction"].append(entry)
                return {"recorded": True, "kind": entry["kind"]}
        except (ObserverError, cdp.CdpError) as exc:
            return {"error": exc.to_dict()}
        except (PlanConflict, ValueError, TypeError) as exc:
            return {"error": {"code": "INVALID_ARGUMENT", "message": str(exc)}}
        return {"error": {"code": "UNKNOWN_TOOL", "message": f"{name} is not a tool you have"}}

    # ---- prompt
    def _system_prompt(self, brief: dict[str, Any]) -> str:
        decisions = [d["kind"] for d in brief.get("decisions", [])]
        required = next((d["kind"] for d in brief.get("decisions", []) if d.get("required")), None)
        routed = skills.route(decisions, required=required)
        rule_ids: list[str] = []
        for skill_id in routed:
            for rule_id in skills.index()["skills"].get(skill_id, {}).get("rules", []):
                if rule_id not in rule_ids:
                    rule_ids.append(rule_id)
        parts = [INSTRUCTIONS, "", skills.operating()]
        for skill_id in routed:
            parts.append(skills.card(skill_id))
        parts.append(skills.card("friction"))
        if rule_ids:
            parts.append("# Rules referenced by these skills\n\n" + skills.rules(rule_ids))
        parts.append("# Your plan\n\n" + self.workspace.excerpt())
        parts.append("# Other skill cards you can load\n\n" + skills.catalog())
        return "\n\n".join(parts)

    # ---- the loop
    def play_turn(self) -> TurnResult:
        state: dict[str, Any] = {"actions": [], "friction": [], "turn_ended": False, "brief": None,
                                 "brief_fresh": False, "attachment": None}
        try:
            brief = self._brief()
        except (ObserverError, cdp.CdpError) as exc:
            return TurnResult(status="error", error=f"{exc.code}: {exc.message}", transcript_path=self.transcript_path)
        state["brief"], state["brief_fresh"] = brief, True
        state["attachment"] = brief.get("attachment")
        self._record({"type": "turn_start", "brief": brief})

        if self.workspace.needs_reattachment(state["attachment"] or {}):
            self.workspace.reattach(state["attachment"] or {}, note="the game's attachment generation changed")

        system = self._system_prompt(brief)
        messages: list[dict[str, Any]] = [{"role": "user", "content": [
            {"type": "text", "text": "Play this turn. Current brief:\n\n" + json.dumps(brief, ensure_ascii=False)}]}]
        calls = 0
        report = ""
        while True:
            try:
                response = self.provider.complete(system=system, messages=messages, tools=TOOLS)
            except Exception as exc:  # noqa: BLE001 - any provider failure ends the turn without acting
                log.warning("provider failed: %r", exc)
                self._record({"type": "provider_error", "error": repr(exc)})
                return self._finish(state, "error", report, calls, error=str(exc))
            report = response.text or report
            if response.text:
                self._record({"type": "model_text", "text": response.text})
            if not response.tool_calls:
                break
            assistant: list[dict[str, Any]] = []
            if response.text:
                assistant.append({"type": "text", "text": response.text})
            for call in response.tool_calls:
                assistant.append({"type": "tool_use", "id": call.id, "name": call.name, "input": call.arguments})
            messages.append({"role": "assistant", "content": assistant})

            results: list[dict[str, Any]] = []
            for call in response.tool_calls:
                if calls >= self.max_tool_calls:
                    break
                calls += 1
                result = self._call_tool(call, state)
                self._record({"type": "tool_result", "tool": call.name, "arguments": call.arguments, "result": result})
                results.append({"type": "tool_result", "tool_use_id": call.id,
                                "content": json.dumps(result, ensure_ascii=False)})
            messages.append({"role": "user", "content": results})

            if state["turn_ended"]:
                report = self._closing_report(system, messages, report)
                break
            pause = (state["brief"] or {}).get("pause")
            if pause:
                return self._finish(state, "paused", report, calls, pause=pause)
            if calls >= self.max_tool_calls:
                return self._finish(state, "budget_exhausted", report, calls)

        pause = (state["brief"] or {}).get("pause")
        if pause and not state["turn_ended"]:
            return self._finish(state, "paused", report, calls, pause=pause)
        return self._finish(state, "turn_ended" if state["turn_ended"] else "stopped", report, calls)

    def _closing_report(self, system: str, messages: list[dict[str, Any]], report: str) -> str:
        """One last, tool-free call for the turn summary the human reads. Never acts on the game."""
        messages = messages + [{"role": "user", "content": [{"type": "text", "text":
            "The turn is over. Reply with the closing summary only: what you decided this turn and why. No tools."}]}]
        try:
            response = self.provider.complete(system=system, messages=messages, tools=[])
        except Exception as exc:  # noqa: BLE001 - a missing summary must not lose a completed turn
            log.warning("closing summary failed: %r", exc)
            return report
        if response.text:
            self._record({"type": "model_text", "text": response.text})
            return response.text
        return report

    def _finish(self, state: dict[str, Any], status: str, report: str, calls: int,
                pause: dict[str, Any] | None = None, error: str = "") -> TurnResult:
        self._record({"type": "turn_end", "status": status, "actions": len(state["actions"]),
                      "friction": len(state["friction"]), "toolCalls": calls})
        return TurnResult(status=status, report=report.strip(), actions=state["actions"], friction=state["friction"],
                          pause=pause, plan_revision=self.workspace.plan()["revision"], tool_calls=calls,
                          error=error, transcript_path=self.transcript_path)
