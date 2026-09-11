"""Loads packaged, reviewed JavaScript payloads independent of the working directory."""

from __future__ import annotations

import json
from functools import lru_cache
from importlib import resources

from civ7_observer.cdp import CdpError

BOUND_TOKEN = "BOUND_PLAYER_ID"
MODE_TOKEN = "ALLOWED_MODE"
GUARDS_TOKEN = "GUARDS_ONLY"
ACTION_KINDS = ("SET_TECH_TREE_NODE", "SET_CULTURE_TREE_NODE", "END_TURN", "SKIP_UNIT", "MOVE_UNIT")
ALLOWED_MODES = ("singleplayer", "local-hotseat")


class PayloadMissing(CdpError):
    code = "PAYLOAD_MISSING"


@lru_cache(maxsize=None)
def load_payload(name: str) -> str:
    resource = resources.files(__package__).joinpath("payloads").joinpath(name)
    try:
        return resource.read_text(encoding="utf-8")
    except (FileNotFoundError, OSError) as exc:
        raise PayloadMissing(f"packaged payload {name!r} not found") from exc


def _int_token(value: object, what: str) -> str:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{what} must be an integer, got {value!r}")
    return str(value)


def render_action_payload(*, bound_player_id: int, allowed_mode: str, kind: str, arg: int, expected_turn: int, expected_age: int, arg2: int = 0, arg3: int = 0) -> str:
    """Render perform.js. Every token is validated here; no caller-supplied text reaches the game."""
    if kind not in ACTION_KINDS:
        raise ValueError(f"kind must be one of {ACTION_KINDS}, got {kind!r}")
    text = render_payload("perform.js", bound_player_id=bound_player_id, allowed_mode=allowed_mode)
    text = text.replace("OP_KIND", json.dumps(kind)).replace("OP_ARG2", _int_token(arg2, "arg2")).replace("OP_ARG3", _int_token(arg3, "arg3")).replace("OP_ARG", _int_token(arg, "arg"))
    text = text.replace("EXPECTED_TURN", _int_token(expected_turn, "expected_turn")).replace("EXPECTED_AGE", _int_token(expected_age, "expected_age"))
    return text


def render_payload(name: str, *, bound_player_id: int, allowed_mode: str | None = None, guards_only: bool = False) -> str:
    """Substitute the bound engine player id (and optional allowed mode) into a payload."""
    if isinstance(bound_player_id, bool) or not isinstance(bound_player_id, int) or bound_player_id < 0:
        raise ValueError(f"bound player id must be a non-negative integer, got {bound_player_id!r}")
    text = load_payload(name).replace(BOUND_TOKEN, str(bound_player_id))
    if MODE_TOKEN in text:
        if allowed_mode not in ALLOWED_MODES:
            raise ValueError(f"allowed_mode must be one of {ALLOWED_MODES}, got {allowed_mode!r}")
        text = text.replace(MODE_TOKEN, json.dumps(allowed_mode))
    if GUARDS_TOKEN in text:
        text = text.replace(GUARDS_TOKEN, "true" if guards_only else "false")
    return text
