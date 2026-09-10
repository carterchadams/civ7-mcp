"""A scripted stand-in for the websocket.WebSocket subset CdpSession uses."""

from __future__ import annotations

import threading
from collections import deque


class ScriptedSocket:
    """Replays a queue of frames (str/bytes) or exceptions on recv()."""

    def __init__(self, script: list[object] | None = None) -> None:
        self.script: deque[object] = script if isinstance(script, deque) else deque(script or [])
        self.sent: list[str] = []
        self.timeouts: list[float | None] = []
        self.closed = 0
        self.connected = True
        self._lock = threading.Lock()
        self._in_flight = 0
        self.overlap_detected = False

    def send(self, data: str) -> None:
        with self._lock:
            if self._in_flight:
                self.overlap_detected = True
            self._in_flight += 1
        self.sent.append(data)

    def recv(self) -> object:
        if not self.script:
            raise AssertionError("ScriptedSocket script exhausted")
        item = self.script.popleft()
        if isinstance(item, BaseException):
            raise item
        with self._lock:
            self._in_flight = max(0, self._in_flight - 1)
        return item

    def settimeout(self, value: float | None) -> None:
        self.timeouts.append(value)

    def close(self, timeout: float | None = None) -> None:
        self.close_timeouts = getattr(self, "close_timeouts", []) + [timeout]
        self.closed += 1
        self.connected = False
