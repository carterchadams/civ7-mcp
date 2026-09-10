"""Loopback-only Chrome DevTools Protocol adapter for the Cohtml UI debugger.

Transport only: knows nothing about the game. Every failure is a distinct
CdpError subclass with a stable machine-readable ``code``. An exception
string is never returned as a value.
"""

from __future__ import annotations

import itertools
import json
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable, ClassVar, Protocol
from urllib.parse import urlsplit

import websocket

MAX_DISCOVERY_BYTES = 1_048_576
MAX_TARGETS = 64
CLOSE_TIMEOUT = 0.5  # seconds to wait for the peer's close frame; peers past a deadline may never answer
LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})


# ---------------------------------------------------------------- errors

class CdpError(Exception):
    code: ClassVar[str] = "CDP_ERROR"

    def __init__(self, message: str, **extra: Any) -> None:
        super().__init__(message)
        self.message = message
        self.extra = extra

    def to_dict(self) -> dict[str, Any]:
        return {"code": self.code, "message": self.message, **self.extra}


class DiscoveryUnavailable(CdpError):
    code = "DEBUGGER_UNAVAILABLE"


class DiscoveryInvalid(CdpError):
    code = "DISCOVERY_INVALID"


class InvalidTargetUrl(CdpError):
    code = "INVALID_TARGET_URL"


class CdpConnectFailed(CdpError):
    code = "TARGET_CONNECT_FAILED"


class CdpDeadlineExceeded(CdpError):
    code = "CDP_DEADLINE"


class CdpConnectionClosed(CdpError):
    code = "CDP_CONNECTION_CLOSED"


class CdpMalformedResponse(CdpError):
    code = "CDP_MALFORMED"


class CdpProtocolError(CdpError):
    code = "CDP_PROTOCOL_ERROR"

    def __init__(self, protocol_code: int | None, protocol_message: str) -> None:
        super().__init__(
            f"CDP protocol error {protocol_code}: {protocol_message}",
            protocolCode=protocol_code,
            protocolMessage=protocol_message,
        )
        self.protocol_code = protocol_code
        self.protocol_message = protocol_message


class CdpEvaluateException(CdpError):
    code = "CDP_EVALUATE_EXCEPTION"

    def __init__(self, text: str, description: str | None, line: int | None, column: int | None) -> None:
        super().__init__(
            f"JavaScript exception: {description or text}",
            text=text, description=description, line=line, column=column,
        )
        self.text = text
        self.description = description
        self.line = line
        self.column = column


class CdpMissingValue(CdpError):
    code = "CDP_MISSING_VALUE"

    def __init__(self, remote_type: str | None, subtype: str | None) -> None:
        super().__init__(
            f"Runtime.evaluate returned no value (type={remote_type}, subtype={subtype})",
            remoteType=remote_type, subtype=subtype,
        )
        self.remote_type = remote_type
        self.subtype = subtype


# ------------------------------------------------------------- discovery

@dataclass(frozen=True)
class CdpTarget:
    index: int
    id: str | None
    title: str | None
    type: str | None
    url: str | None
    ws_url: str | None
    ws_url_error: str | None

    def identity(self) -> dict[str, Any]:
        return {"index": self.index, "id": self.id, "title": self.title, "type": self.type, "url": self.url}


def discovery_url(port: int) -> str:
    return f"http://127.0.0.1:{int(port)}/json"


def validate_ws_url(raw: object) -> str:
    if not isinstance(raw, str) or not raw:
        raise InvalidTargetUrl("webSocketDebuggerUrl missing or not a string")
    parts = urlsplit(raw)
    if parts.scheme != "ws":
        raise InvalidTargetUrl(f"webSocketDebuggerUrl scheme must be ws://, got {parts.scheme!r}")
    host = parts.hostname
    if host is None or host not in LOOPBACK_HOSTS:
        raise InvalidTargetUrl(f"webSocketDebuggerUrl host must be loopback, got {host!r}")
    try:
        port = parts.port
    except ValueError as exc:
        raise InvalidTargetUrl(f"webSocketDebuggerUrl port invalid: {exc}") from exc
    if port is None:
        raise InvalidTargetUrl("webSocketDebuggerUrl must include an explicit port")
    return raw


def _opt_str(value: object) -> str | None:
    return value if isinstance(value, str) else None


def parse_target_list(body: bytes) -> list[CdpTarget]:
    try:
        data = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise DiscoveryInvalid(f"discovery body is not JSON: {exc}") from exc
    if not isinstance(data, list):
        raise DiscoveryInvalid("discovery body is not a JSON list")
    if len(data) > MAX_TARGETS:
        raise DiscoveryInvalid(f"discovery listed {len(data)} targets (max {MAX_TARGETS})")
    targets: list[CdpTarget] = []
    for index, entry in enumerate(data):
        if not isinstance(entry, dict):
            raise DiscoveryInvalid(f"discovery entry {index} is not an object")
        ws_url: str | None
        ws_err: str | None
        try:
            ws_url, ws_err = validate_ws_url(entry.get("webSocketDebuggerUrl")), None
        except InvalidTargetUrl as exc:
            ws_url, ws_err = None, exc.message
        targets.append(CdpTarget(
            index=index,
            id=_opt_str(entry.get("id")),
            title=_opt_str(entry.get("title")),
            type=_opt_str(entry.get("type")),
            url=_opt_str(entry.get("url")),
            ws_url=ws_url,
            ws_url_error=ws_err,
        ))
    return targets


def discover_targets(port: int, timeout: float) -> list[CdpTarget]:
    url = discovery_url(port)
    req = urllib.request.Request(url, headers={"Accept": "application/json"}, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 (loopback only)
            status = getattr(resp, "status", 200)
            if status != 200:
                raise DiscoveryInvalid(f"discovery returned HTTP {status}")
            body = resp.read(MAX_DISCOVERY_BYTES + 1)
    except urllib.error.HTTPError as exc:
        raise DiscoveryInvalid(f"discovery returned HTTP {exc.code}") from exc
    except (urllib.error.URLError, OSError, TimeoutError) as exc:
        raise DiscoveryUnavailable(f"no UI debugger answering at {url}: {getattr(exc, 'reason', exc)}") from exc
    if len(body) > MAX_DISCOVERY_BYTES:
        raise DiscoveryInvalid(f"discovery body exceeds {MAX_DISCOVERY_BYTES} bytes")
    return parse_target_list(body)


# --------------------------------------------------------------- session

class WebSocketLike(Protocol):
    def send(self, data: str) -> Any: ...
    def recv(self) -> Any: ...
    def settimeout(self, value: float | None) -> Any: ...
    def close(self, timeout: float | None = None) -> Any: ...


ConnectFn = Callable[[str, float], WebSocketLike]


def _default_connect(url: str, timeout: float) -> WebSocketLike:
    return websocket.create_connection(url, timeout=timeout, suppress_origin=True)


class CdpSession:
    """One WebSocket to one target. Calls are serialized through a mutex."""

    def __init__(
        self,
        ws_url: str,
        *,
        timeout: float,
        connect: ConnectFn = _default_connect,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.ws_url = validate_ws_url(ws_url)
        self.timeout = float(timeout)
        self._connect = connect
        self._clock = clock
        self._ws: WebSocketLike | None = None
        self._lock = threading.Lock()
        self._ids = itertools.count(1)
        self._poisoned: str | None = None
        self.events_ignored = 0
        self.stale_responses_ignored = 0

    # -- lifecycle
    def __enter__(self) -> "CdpSession":
        self.connect()
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()

    def connect(self) -> None:
        try:
            self._ws = self._connect(self.ws_url, self.timeout)
        except (OSError, websocket.WebSocketException, ValueError) as exc:
            raise CdpConnectFailed(f"could not open debugger target: {exc!r}") from exc

    def close(self) -> None:
        ws, self._ws = self._ws, None
        if ws is not None:
            try:
                ws.close(timeout=CLOSE_TIMEOUT)
            except Exception:  # noqa: BLE001 - closing is best-effort
                pass

    def _poison(self, reason: str) -> None:
        self._poisoned = reason
        self.close()

    # -- evaluate
    def evaluate_readonly(self, expression: str) -> Any:
        """Evaluate a packaged, reviewed expression and return its JSON value."""
        deadline = self._clock() + self.timeout  # budget starts before the mutex wait
        with self._lock:
            if self._poisoned is not None:
                raise CdpConnectionClosed(f"session unusable: {self._poisoned}")
            ws = self._ws
            if ws is None:
                raise CdpConnectionClosed("session is not connected")
            if self._clock() >= deadline:
                raise CdpDeadlineExceeded(f"deadline of {self.timeout}s elapsed while waiting for the session mutex")
            request_id = next(self._ids)
            payload = json.dumps({
                "id": request_id,
                "method": "Runtime.evaluate",
                "params": {"expression": expression, "returnByValue": True, "awaitPromise": False},
            })
            try:
                ws.send(payload)
            except (OSError, websocket.WebSocketException) as exc:
                self._poison("send failed")
                raise CdpConnectionClosed(f"send failed: {exc!r}") from exc
            try:
                return self._await_response(ws, request_id, deadline)
            except CdpDeadlineExceeded:
                self._poison("deadline exceeded; late replies cannot be trusted")
                raise
            except CdpConnectionClosed as exc:
                self._poison(exc.message)
                raise

    def _await_response(self, ws: WebSocketLike, request_id: int, deadline: float) -> Any:
        while True:
            remaining = deadline - self._clock()
            if remaining <= 0:
                raise CdpDeadlineExceeded(f"no response to request {request_id} within {self.timeout}s")
            ws.settimeout(remaining)
            try:
                frame = ws.recv()
            except websocket.WebSocketTimeoutException as exc:
                raise CdpDeadlineExceeded(f"no response to request {request_id} within {self.timeout}s") from exc
            except (websocket.WebSocketConnectionClosedException, OSError) as exc:
                raise CdpConnectionClosed(f"connection closed while waiting: {exc!r}") from exc
            if frame == "" or frame is None:
                raise CdpConnectionClosed("connection closed by peer")
            if not isinstance(frame, str):
                raise CdpMalformedResponse("received a non-text frame")
            try:
                msg = json.loads(frame)
            except ValueError as exc:
                raise CdpMalformedResponse(f"response is not JSON: {exc}") from exc
            if not isinstance(msg, dict):
                raise CdpMalformedResponse("response is not a JSON object")
            if "id" not in msg:
                self.events_ignored += 1
                continue
            if msg["id"] != request_id:
                self.stale_responses_ignored += 1
                continue
            return self._unpack(msg)

    @staticmethod
    def _unpack(msg: dict[str, Any]) -> Any:
        error = msg.get("error")
        if error is not None:
            if isinstance(error, dict):
                raise CdpProtocolError(error.get("code"), str(error.get("message", "")))
            raise CdpProtocolError(None, str(error))
        result = msg.get("result")
        if not isinstance(result, dict):
            raise CdpMalformedResponse("response has no result object")
        details = result.get("exceptionDetails")
        if details is not None:
            details = details if isinstance(details, dict) else {}
            exception = details.get("exception")
            description = exception.get("description") if isinstance(exception, dict) else None
            raise CdpEvaluateException(
                text=str(details.get("text", "")),
                description=description if isinstance(description, str) else None,
                line=details.get("lineNumber") if isinstance(details.get("lineNumber"), int) else None,
                column=details.get("columnNumber") if isinstance(details.get("columnNumber"), int) else None,
            )
        remote = result.get("result")
        if not isinstance(remote, dict):
            raise CdpMalformedResponse("response result.result is not an object")
        if "value" not in remote:
            raise CdpMissingValue(_opt_str(remote.get("type")), _opt_str(remote.get("subtype")))
        return remote["value"]
