"""The model provider: one HTTP call per model turn against the Anthropic Messages API.

Deliberately not the SDK. The runner needs exactly one request shape, and this package is meant to
install with two dependencies; a hand-rolled call keeps the wire format visible and the transport
injectable, which is what the offline tests need.

The system prompt (contract, cards, plan) is identical across every call of a turn, so it carries a
prompt-cache breakpoint. Overload and rate-limit responses are retried with bounded backoff; a
request error is not retried, because it will fail the same way again.
"""

from __future__ import annotations

import json
import logging
import os
import time
import urllib.error
import urllib.request
from typing import Any, Callable

from civ7_observer.runner import ProviderResponse, ToolCall

log = logging.getLogger(__name__)

API_URL = "https://api.anthropic.com/v1/messages"
API_VERSION = "2023-06-01"
DEFAULT_MODEL = "claude-sonnet-5"
DEFAULT_MAX_TOKENS = 4096
DEFAULT_MAX_ATTEMPTS = 4
RETRY_STATUS = (408, 409, 429, 500, 502, 503, 504, 529)


class ProviderError(RuntimeError):
    """The model could not be reached or refused the request."""


class AnthropicProvider:
    def __init__(self, *, api_key: str | None = None, model: str = DEFAULT_MODEL,
                 max_tokens: int = DEFAULT_MAX_TOKENS, timeout: float = 120.0,
                 url: str = API_URL, max_attempts: int = DEFAULT_MAX_ATTEMPTS,
                 http: Callable[..., Any] = urllib.request.urlopen,
                 sleep: Callable[[float], None] = time.sleep) -> None:
        key = api_key if api_key is not None else os.environ.get("ANTHROPIC_API_KEY", "")
        if not key:
            raise ProviderError("no API key: set ANTHROPIC_API_KEY or pass --api-key")
        self.api_key, self.model, self.max_tokens = key, model, max_tokens
        self.timeout, self.url, self.max_attempts = timeout, url, max_attempts
        self.http, self.sleep = http, sleep
        self.usage: dict[str, int] = {"input_tokens": 0, "output_tokens": 0, "calls": 0}

    def complete(self, *, system: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> ProviderResponse:
        body: dict[str, Any] = {
            "model": self.model,
            "max_tokens": self.max_tokens,
            # One breakpoint at the end of the invariant prefix: the whole prompt is reused each call.
            "system": [{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
            "messages": messages,
        }
        if tools:
            body["tools"] = tools
        payload = self._post(body)
        self.usage["calls"] += 1
        for field in ("input_tokens", "output_tokens"):
            self.usage[field] += int((payload.get("usage") or {}).get(field) or 0)
        return self._parse(payload)

    # ---- transport
    def _post(self, body: dict[str, Any]) -> dict[str, Any]:
        request = urllib.request.Request(
            self.url, data=json.dumps(body).encode("utf-8"), method="POST",
            headers={"content-type": "application/json", "x-api-key": self.api_key,
                     "anthropic-version": API_VERSION})
        last = ""
        for attempt in range(1, self.max_attempts + 1):
            try:
                with self.http(request, timeout=self.timeout) as response:
                    return json.loads(response.read().decode("utf-8"))
            except urllib.error.HTTPError as exc:
                last = f"HTTP {exc.code}"
                detail = _detail(exc)
                if exc.code not in RETRY_STATUS:
                    raise ProviderError(f"{last}: {detail}") from exc
                log.warning("model call failed (%s), attempt %d/%d", last, attempt, self.max_attempts)
            except urllib.error.URLError as exc:
                last = f"connection failed: {exc.reason}"
                log.warning("%s, attempt %d/%d", last, attempt, self.max_attempts)
            if attempt < self.max_attempts:
                self.sleep(min(2 ** (attempt - 1), 8))
        raise ProviderError(f"gave up after {self.max_attempts} attempts: {last}")

    @staticmethod
    def _parse(payload: dict[str, Any]) -> ProviderResponse:
        if payload.get("type") == "error":
            raise ProviderError(str(payload.get("error")))
        texts, calls = [], []
        for block in payload.get("content") or []:
            if block.get("type") == "text":
                texts.append(block.get("text") or "")
            elif block.get("type") == "tool_use":
                calls.append(ToolCall(id=block.get("id") or "", name=block.get("name") or "",
                                      arguments=block.get("input") or {}))
        return ProviderResponse(text="\n".join(t for t in texts if t).strip(), tool_calls=calls)


def _detail(exc: urllib.error.HTTPError) -> str:
    try:
        return (exc.read() or b"").decode("utf-8", "replace")[:400]
    except Exception:  # noqa: BLE001 - the status is the useful part
        return exc.reason or ""
