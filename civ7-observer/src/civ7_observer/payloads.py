"""Loads packaged, reviewed JavaScript payloads independent of the working directory."""

from __future__ import annotations

from functools import lru_cache
from importlib import resources

from civ7_observer.cdp import CdpError


class PayloadMissing(CdpError):
    code = "PAYLOAD_MISSING"


@lru_cache(maxsize=None)
def load_payload(name: str) -> str:
    resource = resources.files(__package__).joinpath("payloads").joinpath(name)
    try:
        return resource.read_text(encoding="utf-8")
    except (FileNotFoundError, OSError) as exc:
        raise PayloadMissing(f"packaged payload {name!r} not found") from exc
