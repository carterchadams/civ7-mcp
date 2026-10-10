// The mod's outbound link to the local companion (Experiment A2).
//
// The mod initiates; the endpoint is a fixed loopback constant, never configurable through gameplay
// messages. Exactly one socket per service instance; reconnects use bounded backoff and never carry a
// queue of pending commands across a reconnect. Frames are small JSON text; anything else from the
// peer is counted as a protocol error and the socket is closed by us.

const ENDPOINT = "ws://127.0.0.1:7788/civ7-agent";
const PROTOCOL = 1;
const ECHOES = 100;
const MAX_FRAME = 64 * 1024;
const HEARTBEAT_MS = 5000;
const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 10000];

export interface LinkIdentity { buildId: string; incarnation: string }

export class Link {
  private ws: WebSocket | null = null;
  private timers = new Set<number>();
  private disposed = false;
  private attempts = 0;
  private opens = 0;
  private closes = 0;
  private lastClose: { code: number; reason: string } | null = null;
  private lastError: string | null = null;
  private welcome: Record<string, unknown> | null = null;
  private echo = { sent: 0, received: 0, lost: 0, outOfOrder: 0, latencies: [] as number[], startedAt: 0, finishedAt: 0 };
  private pending = new Map<number, number>();   // ping id -> sent at
  private heartbeat = { sent: 0, received: 0 };
  private protocolErrors = 0;

  private readonly identity: LinkIdentity;

  constructor(identity: LinkIdentity) {
    this.identity = identity;
  }

  start(): void {
    this.connect();
  }

  status(): Record<string, unknown> {
    const l = [...this.echo.latencies].sort((a, b) => a - b);
    const q = (p: number) => (l.length ? l[Math.min(l.length - 1, Math.floor(p * l.length))] : null);
    return {
      endpoint: ENDPOINT, protocol: PROTOCOL,
      state: this.ws ? ["connecting", "open", "closing", "closed"][this.ws.readyState] : "no-socket",
      attempts: this.attempts, opens: this.opens, closes: this.closes, lastClose: this.lastClose, lastError: this.lastError,
      welcome: this.welcome,
      echo: { sent: this.echo.sent, received: this.echo.received, lost: this.echo.lost, outOfOrder: this.echo.outOfOrder, pending: this.pending.size,
              p50Ms: q(0.5), p90Ms: q(0.9), maxMs: l.length ? l[l.length - 1] : null, durationMs: this.echo.finishedAt ? this.echo.finishedAt - this.echo.startedAt : null },
      heartbeat: { ...this.heartbeat }, protocolErrors: this.protocolErrors, timers: this.timers.size,
    };
  }

  dispose(): void {
    this.disposed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    const ws = this.ws;
    this.ws = null;
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) ws.close(1000, "service disposed");
  }

  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => { this.timers.delete(t); if (!this.disposed) fn(); }, ms) as unknown as number;
    this.timers.add(t);
  }

  private connect(): void {
    if (this.disposed || this.ws) return;
    this.attempts += 1;
    let ws: WebSocket;
    try {
      ws = new WebSocket(ENDPOINT);
    } catch (e) {
      this.lastError = `constructor: ${String(e)}`;
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.opens += 1;
      this.send({ type: "hello", protocol: PROTOCOL, buildId: this.identity.buildId, incarnation: this.identity.incarnation, nonce: Math.random().toString(36).slice(2) });
    };
    ws.onmessage = (ev: MessageEvent) => { if (this.ws === ws) this.receive(ev.data); };
    ws.onerror = () => { if (this.ws === ws) this.lastError = `socket error (attempt ${this.attempts})`; };
    ws.onclose = (ev: CloseEvent) => {
      if (this.ws !== ws) return;
      this.closes += 1;
      this.lastClose = { code: ev.code, reason: ev.reason };
      this.ws = null;
      this.welcome = null;
      this.pending.clear();   // nothing is replayed after a reconnect
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    const delay = BACKOFF_MS[Math.min(this.attempts - 1, BACKOFF_MS.length - 1)];
    this.later(delay, () => this.connect());
  }

  private send(msg: Record<string, unknown>): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return false;
    const text = JSON.stringify(msg);
    if (text.length > MAX_FRAME) { this.protocolErrors += 1; return false; }
    ws.send(text);
    return true;
  }

  private receive(data: unknown): void {
    if (typeof data !== "string" || data.length > MAX_FRAME) { this.protocolErrors += 1; this.ws?.close(1003, "unexpected frame"); return; }
    let msg: any;
    try { msg = JSON.parse(data); } catch { this.protocolErrors += 1; this.ws?.close(1003, "malformed"); return; }
    switch (msg?.type) {
      case "welcome":
        if (msg.protocol !== PROTOCOL) { this.protocolErrors += 1; this.lastError = `peer protocol ${msg.protocol}`; this.ws?.close(1002, "protocol"); return; }
        this.welcome = { peer: msg.peer, pid: msg.pid, serverNonce: msg.serverNonce };
        this.attempts = 0;   // a completed handshake resets the backoff ladder
        this.beginEchoes();
        this.later(HEARTBEAT_MS, () => this.tick());
        return;
      case "pong": {
        const sentAt = this.pending.get(msg.id);
        if (sentAt === undefined) { this.echo.outOfOrder += 1; return; }
        this.pending.delete(msg.id);
        if (msg.id < 0) { this.heartbeat.received += 1; return; }
        this.echo.received += 1;
        this.echo.latencies.push(performance.now() - sentAt);
        if (this.echo.sent < ECHOES) this.sendEcho();
        else this.finishEchoes();
        return;
      }
      case "error":
        this.protocolErrors += 1;
        this.lastError = `peer error: ${msg.reason}`;
        return;
      default:
        this.protocolErrors += 1;
    }
  }

  private beginEchoes(): void {
    if (this.echo.finishedAt) return;   // measured once per service instance
    this.echo.startedAt = performance.now();
    this.sendEcho();
  }

  private sendEcho(): void {
    const id = this.echo.sent + 1;
    this.echo.sent = id;
    this.pending.set(id, performance.now());
    if (!this.send({ type: "ping", id, t: Date.now() })) { this.pending.delete(id); this.echo.lost += 1; }
    // a reply that never comes is a loss, not a hang
    this.later(2000, () => { if (this.pending.delete(id)) { this.echo.lost += 1; if (this.echo.sent < ECHOES) this.sendEcho(); else this.finishEchoes(); } });
  }

  private finishEchoes(): void {
    if (this.echo.finishedAt) return;
    this.echo.finishedAt = performance.now();
    this.send({ type: "report", ...this.identity, echo: this.status().echo, documentHidden: document.hidden, visibility: document.visibilityState });
  }

  private tick(): void {
    if (!this.ws || this.ws.readyState !== 1) return;
    const id = -(this.heartbeat.sent + 1);
    this.heartbeat.sent += 1;
    this.pending.set(id, performance.now());
    this.send({ type: "ping", id, t: Date.now() });
    this.later(HEARTBEAT_MS, () => this.tick());
  }
}
