"""The UI-only hotseat tidy-up: rendering, typed refusals, and the driver-facing result shape."""
import json

import pytest

from civ7_observer import curtain, service
from test_actions import ctx_reply, open_session
from test_targets import reply


def test_render_validates_the_mode_and_substitutes_it_as_json():
    src = curtain.render_curtain_payload("raise")
    assert 'const MODE = "raise";' in src and curtain.TOKEN not in src
    with pytest.raises(ValueError):
        curtain.render_curtain_payload("dismiss")


def test_tidy_returns_the_payload_result_and_never_touches_the_registry(tmp_path):
    result = {"payloadVersion": 1, "refused": None, "mode": "prune", "curtainsBefore": 17, "curtainsRemoved": 16, "curtainsAfter": 1, "advisorPopup": {"present": True, "confirmed": True}}
    gs, f = open_session({"a": [ctx_reply(1), ctx_reply(1), reply(2, json.dumps(result))]})
    with gs:
        out = curtain.tidy(gs, mode="prune")
    assert out["curtainsBefore"] == 17 and out["curtainsAfter"] == 1 and out["advisorPopup"]["confirmed"] is True
    sent = json.loads(f.all_sockets[1].sent[1])["params"]["expression"]
    assert 'const MODE = "prune";' in sent and "sendRequest" not in sent


def test_tidy_refusal_is_a_typed_error(tmp_path):
    refused = {"payloadVersion": 1, "refused": {"code": "UNSUPPORTED_GAME_MODE", "message": "curtain handling applies to hotseat sessions only"}}
    gs, _ = open_session({"a": [ctx_reply(1), ctx_reply(1), reply(2, json.dumps(refused))]})
    with gs, pytest.raises(service.ObserverError) as info:
        curtain.tidy(gs, mode="raise")
    assert info.value.code == "UNSUPPORTED_GAME_MODE"
