"""Loads packaged, reviewed JavaScript payloads independent of the working directory."""

from __future__ import annotations

from functools import lru_cache
from importlib import resources

from civ7_observer.cdp import CdpError

BOUND_TOKEN = "BOUND_PLAYER_ID"


class PayloadMissing(CdpError):
    code = "PAYLOAD_MISSING"


@lru_cache(maxsize=None)
def load_payload(name: str) -> str:
    resource = resources.files(__package__).joinpath("payloads").joinpath(name)
    try:
        return resource.read_text(encoding="utf-8")
    except (FileNotFoundError, OSError) as exc:
        raise PayloadMissing(f"packaged payload {name!r} not found") from exc


def render_payload(name: str, *, bound_player_id: int) -> str:
    """Substitute the bound engine player id into a payload. Ids are non-negative ints only."""
    if isinstance(bound_player_id, bool) or not isinstance(bound_player_id, int) or bound_player_id < 0:
        raise ValueError(f"bound player id must be a non-negative integer, got {bound_player_id!r}")
    return load_payload(name).replace(BOUND_TOKEN, str(bound_player_id))
