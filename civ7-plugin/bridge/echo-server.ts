#!/usr/bin/env node
// Experiment A2 helper: a loopback-only WebSocket peer for the mod. No game semantics, no code, no
// URLs travel over it; the mod initiates the connection and the helper only echoes and records.
//
//   node bridge/echo-server.ts [--port 7788] [--log build/bridge.log]
//
// Protocol (version 1), JSON text frames only:
//   mod  → { type: "hello", protocol, buildId, incarnation, nonce }
//   peer → { type: "welcome", protocol, serverNonce, peer: "echo-server", pid }
//   mod  → { type: "ping", id, t }                 peer → { type: "pong", id, t }
//   mod  → { type: "report", ... }                  logged verbatim (the mod's own measurements)
//   any malformed frame → { type: "error", reason } then close 1003; a frame over 64 KiB → close 1009.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";

const PROTOCOL = 1;
const MAX_FRAME = 64 * 1024;
const argv = process.argv.slice(2);
const opt = (name: string, fallback: string) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };
const port = Number(opt("--port", "7788"));
const logPath = resolve(opt("--log", "build/bridge.log"));
mkdirSync(dirname(logPath), { recursive: true });

function log(event: Record<string, unknown>): void {
  const line = JSON.stringify({ at: new Date().toISOString(), ...event });
  appendFileSync(logPath, line + "\n");
  console.log(line);
}

const wss = new WebSocketServer({ host: "127.0.0.1", port, maxPayload: MAX_FRAME });
let connections = 0;

wss.on("connection", (ws: WebSocket, req) => {
  const id = ++connections;
  let hello: Record<string, unknown> | null = null;
  log({ event: "open", conn: id, from: req.socket.remoteAddress, path: req.url });
  ws.on("message", (data, isBinary) => {
    if (isBinary) { ws.send(JSON.stringify({ type: "error", reason: "binary frames are not accepted" })); ws.close(1003, "binary"); return; }
    let msg: any;
    try { msg = JSON.parse(data.toString()); } catch { log({ event: "malformed", conn: id }); ws.send(JSON.stringify({ type: "error", reason: "not JSON" })); ws.close(1003, "malformed"); return; }
    switch (msg?.type) {
      case "hello":
        hello = msg;
        log({ event: "hello", conn: id, protocol: msg.protocol, buildId: msg.buildId, incarnation: msg.incarnation });
        if (msg.protocol !== PROTOCOL) { ws.send(JSON.stringify({ type: "error", reason: `protocol ${msg.protocol} unsupported; this peer speaks ${PROTOCOL}` })); ws.close(1002, "protocol"); return; }
        ws.send(JSON.stringify({ type: "welcome", protocol: PROTOCOL, serverNonce: Math.random().toString(36).slice(2), peer: "echo-server", pid: process.pid, clientNonce: msg.nonce }));
        return;
      case "ping":
        ws.send(JSON.stringify({ type: "pong", id: msg.id, t: msg.t }));
        return;
      case "report":
        log({ event: "report", conn: id, ...msg });
        return;
      default:
        log({ event: "unknown", conn: id, type: msg?.type });
        ws.send(JSON.stringify({ type: "error", reason: `unknown type ${String(msg?.type)}` }));
    }
  });
  ws.on("close", (code, reason) => log({ event: "close", conn: id, code, reason: reason.toString(), hadHello: hello !== null }));
  ws.on("error", (e) => log({ event: "socket-error", conn: id, error: String(e) }));
});
wss.on("error", (e) => { log({ event: "server-error", error: String(e) }); process.exit(1); });
wss.on("listening", () => log({ event: "listening", host: "127.0.0.1", port, pid: process.pid, log: logPath }));
process.on("SIGINT", () => { log({ event: "shutdown" }); wss.close(); process.exit(0); });
process.on("SIGTERM", () => { log({ event: "shutdown" }); wss.close(); process.exit(0); });
