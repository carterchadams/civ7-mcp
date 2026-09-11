"""Minimal fake Cohtml debugger: serves GET /json and RFC 6455 upgrades on one port.

Scriptable per WebSocket connection via a list of actions:
  Send(text)      send a text frame
  SendRaw(bytes)  send raw bytes (e.g. a binary frame)
  Reply(fn)       fn(request_dict) -> text to send (reads the client's request first)
  Sleep(seconds)  block
  Close()         close the TCP socket
"""

from __future__ import annotations

import base64
import hashlib
import json
import socket
import struct
from collections import deque
import threading
import time
from dataclasses import dataclass, field
from typing import Callable

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


@dataclass
class Send:
    text: str


@dataclass
class SendRaw:
    data: bytes


@dataclass
class Reply:
    fn: Callable[[dict], str]


@dataclass
class Sleep:
    seconds: float


@dataclass
class Close:
    pass


def text_frame(text: str) -> bytes:
    data = text.encode("utf-8")
    n = len(data)
    if n < 126:
        header = struct.pack("!BB", 0x81, n)
    elif n < 65536:
        header = struct.pack("!BBH", 0x81, 126, n)
    else:
        header = struct.pack("!BBQ", 0x81, 127, n)
    return header + data


def binary_frame(data: bytes) -> bytes:
    return struct.pack("!BB", 0x82, len(data)) + data


def _recv_exact(conn: socket.socket, n: int) -> bytes:
    buf = b""
    while len(buf) < n:
        chunk = conn.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("client closed")
        buf += chunk
    return buf


def read_client_frame(conn: socket.socket) -> tuple[int, bytes]:
    b0, b1 = _recv_exact(conn, 2)
    opcode = b0 & 0x0F
    masked = b1 & 0x80
    length = b1 & 0x7F
    if length == 126:
        (length,) = struct.unpack("!H", _recv_exact(conn, 2))
    elif length == 127:
        (length,) = struct.unpack("!Q", _recv_exact(conn, 8))
    mask = _recv_exact(conn, 4) if masked else b""
    payload = _recv_exact(conn, length)
    if masked:
        payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    return opcode, payload


@dataclass
class FakeCdpServer:
    targets: object = field(default_factory=list)   # list, or callable -> (status, body_bytes)
    ws_scripts: dict[str, list] = field(default_factory=dict)  # path -> actions
    ws_reject_status: int | None = None
    redirect_to: str | None = None   # if set, /json and ws upgrades answer 302 Location: redirect_to
    ws_redirect_to: str | None = None  # if set, only ws upgrades answer 302
    discovery_delay: float = 0.0
    port: int = 0
    _sock: socket.socket | None = None
    _thread: threading.Thread | None = None
    _stop: threading.Event = field(default_factory=threading.Event)
    connections: list[str] = field(default_factory=list)
    received: list[dict] = field(default_factory=list)

    def ws_url(self, path: str) -> str:
        return f"ws://127.0.0.1:{self.port}{path}"

    def target(self, id_: str, path: str | None = None, **extra) -> dict:
        entry = {"id": id_, "title": extra.pop("title", id_), "type": extra.pop("type", "page"), "url": extra.pop("url", f"coui://ui/{id_}.html")}
        if path is not None:
            entry["webSocketDebuggerUrl"] = self.ws_url(path)
        entry.update(extra)
        return entry

    def start(self) -> "FakeCdpServer":
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._sock.bind(("127.0.0.1", self.port))
        self._sock.listen(8)
        self._sock.settimeout(0.2)
        self.port = self._sock.getsockname()[1]
        self._thread = threading.Thread(target=self._serve, daemon=True)
        self._thread.start()
        return self

    def stop(self) -> None:
        self._stop.set()
        if self._sock:
            self._sock.close()
        if self._thread:
            self._thread.join(timeout=2)

    def _serve(self) -> None:
        while not self._stop.is_set():
            try:
                conn, _ = self._sock.accept()
            except (socket.timeout, OSError):
                continue
            threading.Thread(target=self._handle, args=(conn,), daemon=True).start()

    def _handle(self, conn: socket.socket) -> None:
        try:
            conn.settimeout(5)
            raw = b""
            while b"\r\n\r\n" not in raw:
                chunk = conn.recv(4096)
                if not chunk:
                    return
                raw += chunk
            head = raw.split(b"\r\n\r\n", 1)[0].decode("latin-1")
            lines = head.split("\r\n")
            _method, path, _ = lines[0].split(" ", 2)
            headers = {k.strip().lower(): v.strip() for k, v in (l.split(":", 1) for l in lines[1:] if ":" in l)}
            if "upgrade" in headers.get("connection", "").lower() and "sec-websocket-key" in headers:
                self._handle_ws(conn, path, headers)
            else:
                self._handle_http(conn, path)
        except (ConnectionError, OSError):
            pass
        finally:
            try:
                conn.close()
            except OSError:
                pass

    def _handle_http(self, conn: socket.socket, path: str) -> None:
        if self.discovery_delay:
            time.sleep(self.discovery_delay)
        if self.redirect_to is not None:
            conn.sendall(f"HTTP/1.1 302 Found\r\nLocation: {self.redirect_to}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".encode())
            return
        if path != "/json":
            status, body = 404, b"not found"
        elif callable(self.targets):
            status, body = self.targets()
        else:
            status, body = 200, json.dumps(self.targets).encode()
        reason = {200: "OK", 404: "Not Found", 500: "Server Error"}.get(status, "X")
        conn.sendall(f"HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode() + body)

    def _handle_ws(self, conn: socket.socket, path: str, headers: dict[str, str]) -> None:
        self.connections.append(path)
        target = self.ws_redirect_to or self.redirect_to
        if target is not None:
            conn.sendall(f"HTTP/1.1 302 Found\r\nLocation: {target}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".encode())
            return
        if self.ws_reject_status is not None or path not in self.ws_scripts:
            status = self.ws_reject_status or 404
            conn.sendall(f"HTTP/1.1 {status} Rejected\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".encode())
            return
        accept = base64.b64encode(hashlib.sha1((headers["sec-websocket-key"] + GUID).encode()).digest()).decode()
        conn.sendall(
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Accept: {accept}\r\n\r\n".encode()
        )
        script = self.ws_scripts[path]
        for action in script:
            if isinstance(action, Send):
                conn.sendall(text_frame(action.text))
            elif isinstance(action, SendRaw):
                conn.sendall(action.data)
            elif isinstance(action, Reply):
                try:
                    opcode, payload = read_client_frame(conn)
                except (ConnectionError, OSError):
                    # the client went away before using this reply: leave it for the next connection
                    if hasattr(script, "pushback"):
                        script.pushback(action)
                    return
                if opcode == 0x8:
                    if hasattr(script, "pushback"):
                        script.pushback(action)
                    return
                req = json.loads(payload.decode("utf-8"))
                self.received.append(req)
                conn.sendall(text_frame(action.fn(req)))
            elif isinstance(action, Sleep):
                time.sleep(action.seconds)
            elif isinstance(action, Close):
                return
        # keep the socket open until the client goes away, so tests decide when to end
        try:
            while True:
                opcode, _ = read_client_frame(conn)
                if opcode == 0x8:
                    return
        except (ConnectionError, OSError):
            return


class SharedScript:
    """A ws script consumed across connections instead of replayed from the start on each one.

    The default behaviour (a plain list) replays for every connection, which suits one-shot tests.
    A multi-call flow (brief, then act) opens several connections in sequence and wants each to
    continue where the last left off. An action the server pulled but could not use, because the
    client had already disconnected, is pushed back so the next connection sees it.
    """

    def __init__(self, actions):
        self._pending = deque(actions)

    def __iter__(self):
        while self._pending:
            yield self._pending.popleft()

    def pushback(self, action) -> None:
        self._pending.appendleft(action)


def echo_value(value: object) -> Reply:
    """Reply to any Runtime.evaluate with the given JSON value (as a string)."""
    return Reply(lambda req: json.dumps({"id": req["id"], "result": {"result": {"type": "string", "value": value}}}))
