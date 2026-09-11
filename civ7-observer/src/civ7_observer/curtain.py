"""UI-only hotseat tidy-up: stale curtain instances and the advisor council popup.

The stock hotseat curtain mounts one component per turn activation and only a human click removes
it, so a game whose seats are all played under the curtain accumulates one instance per seat turn
(17 were found in the DOM after five turns of a four-seat game). `prune` removes every instance but
the newest; `raise` removes them all so the seat's play can be watched. Both confirm the advisor
council popup with nothing followed. No engine operation is sent by this module.
"""

from __future__ import annotations

import json
from typing import Any

from civ7_observer import cdp
from civ7_observer.payloads import load_payload
from civ7_observer.service import GameSession, ObserverError

MODES = ("prune", "raise")
TOKEN = "CURTAIN_MODE"


def render_curtain_payload(mode: str) -> str:
    if mode not in MODES:
        raise ValueError(f"mode must be one of {MODES}, got {mode!r}")
    return load_payload("curtain.js").replace(TOKEN, json.dumps(mode))


def tidy(gs: GameSession, *, mode: str) -> dict[str, Any]:
    """Run the tidy-up in the game UI. Refusals and transport failures are typed errors."""
    expression = render_curtain_payload(mode)
    try:
        value = gs.session.evaluate_readonly(expression)
    except cdp.CdpError as exc:
        raise ObserverError(exc.code, exc.message) from exc
    if not isinstance(value, str):
        raise ObserverError("API_CONTRACT_MISMATCH", "curtain payload returned a non-string")
    try:
        data = json.loads(value)
    except ValueError as exc:
        raise ObserverError("API_CONTRACT_MISMATCH", f"curtain payload returned non-JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise ObserverError("API_CONTRACT_MISMATCH", "curtain payload returned a non-object")
    if data.get("refused") is not None:
        r = data["refused"]
        raise ObserverError(str(r.get("code", "REFUSED")), str(r.get("message", "")))
    return data
