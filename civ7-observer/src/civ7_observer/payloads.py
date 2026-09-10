"""Loads packaged, reviewed JavaScript payloads independent of the working directory."""

from __future__ import annotations

import json
from functools import lru_cache
from importlib import resources

from civ7_observer.cdp import CdpError

BOUND_TOKEN = "BOUND_PLAYER_ID"
MODE_TOKEN = "ALLOWED_MODE"
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


def render_payload(name: str, *, bound_player_id: int, allowed_mode: str | None = None) -> str:
    """Substitute the bound engine player id (and optional allowed mode) into a payload."""
    if isinstance(bound_player_id, bool) or not isinstance(bound_player_id, int) or bound_player_id < 0:
        raise ValueError(f"bound player id must be a non-negative integer, got {bound_player_id!r}")
    text = load_payload(name).replace(BOUND_TOKEN, str(bound_player_id))
    if MODE_TOKEN in text:
        if allowed_mode not in ALLOWED_MODES:
            raise ValueError(f"allowed_mode must be one of {ALLOWED_MODES}, got {allowed_mode!r}")
        text = text.replace(MODE_TOKEN, json.dumps(allowed_mode))
    return text
