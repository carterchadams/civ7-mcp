"""The Anthropic provider: one HTTP call per model turn, no SDK, injectable transport."""
import json
import urllib.error

import pytest

from civ7_observer.provider import AnthropicProvider, ProviderError
from civ7_observer.runner import TOOLS


class FakeHttp:
    """Records requests and replays scripted responses (status, body)."""

    def __init__(self, script):
        self.script = list(script)
        self.requests = []

    def __call__(self, request, timeout=None):
        self.requests.append({"url": request.full_url, "headers": dict(request.headers),
                              "body": json.loads(request.data.decode("utf-8"))})
        status, body = self.script.pop(0)
        if status >= 400:
            raise urllib.error.HTTPError(request.full_url, status, "err", {}, None)
        return _Response(body)


class _Response:
    def __init__(self, body):
        self._body = json.dumps(body).encode("utf-8")

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def message(*content, stop_reason="end_turn"):
    return {"id": "msg_1", "type": "message", "role": "assistant", "model": "m",
            "content": list(content), "stop_reason": stop_reason,
            "usage": {"input_tokens": 10, "output_tokens": 5}}


def make(script, **kw):
    http = FakeHttp(script)
    return AnthropicProvider(api_key="k", model="test-model", http=http, sleep=lambda s: None, **kw), http


def test_text_and_tool_calls_are_parsed():
    provider, http = make([(200, message(
        {"type": "text", "text": "Choosing Pottery."},
        {"type": "tool_use", "id": "tu_1", "name": "perform_action", "input": {"action_id": "abc", "request_id": "r1"}},
    ))])
    response = provider.complete(system="S", messages=[{"role": "user", "content": "go"}], tools=TOOLS)
    assert response.text == "Choosing Pottery."
    assert [(c.id, c.name, c.arguments) for c in response.tool_calls] == [
        ("tu_1", "perform_action", {"action_id": "abc", "request_id": "r1"})]


def test_the_request_carries_the_seat_prompt_and_the_tools():
    provider, http = make([(200, message({"type": "text", "text": "ok"}))])
    provider.complete(system="the contract", messages=[{"role": "user", "content": "go"}], tools=TOOLS)
    body, headers = http.requests[0]["body"], http.requests[0]["headers"]
    assert body["model"] == "test-model"
    assert body["system"][0]["text"] == "the contract"
    assert [t["name"] for t in body["tools"]] == [t["name"] for t in TOOLS]
    assert headers["X-api-key"] == "k" and headers["Anthropic-version"]


def test_a_prompt_cache_breakpoint_is_set_on_the_system_prompt():
    """The contract and cards are identical every call of a turn; only the tail changes."""
    provider, http = make([(200, message({"type": "text", "text": "ok"}))])
    provider.complete(system="the contract", messages=[{"role": "user", "content": "go"}], tools=TOOLS)
    system = http.requests[0]["body"]["system"]
    assert isinstance(system, str) or system[-1].get("cache_control") == {"type": "ephemeral"}


def test_an_overloaded_response_is_retried_then_succeeds():
    provider, http = make([(529, None), (200, message({"type": "text", "text": "second try"}))])
    assert provider.complete(system="s", messages=[], tools=[]).text == "second try"
    assert len(http.requests) == 2


def test_retries_are_bounded_and_then_raise():
    provider, http = make([(503, None)] * 6, max_attempts=3)
    with pytest.raises(ProviderError) as exc:
        provider.complete(system="s", messages=[], tools=[])
    assert "503" in str(exc.value)
    assert len(http.requests) == 3


def test_a_client_error_is_not_retried():
    provider, http = make([(400, None), (200, message({"type": "text", "text": "never"}))])
    with pytest.raises(ProviderError):
        provider.complete(system="s", messages=[], tools=[])
    assert len(http.requests) == 1


def test_usage_is_accumulated_for_the_turn_report():
    provider, http = make([(200, message({"type": "text", "text": "a"})), (200, message({"type": "text", "text": "b"}))])
    provider.complete(system="s", messages=[], tools=[])
    provider.complete(system="s", messages=[], tools=[])
    assert provider.usage == {"input_tokens": 20, "output_tokens": 10, "calls": 2}


def test_a_missing_api_key_is_refused_before_any_request():
    with pytest.raises(ProviderError):
        AnthropicProvider(api_key="", model="m")
