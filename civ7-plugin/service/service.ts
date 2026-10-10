// The reloadable service: the part of the mod that is edited on every development cycle.
//
// Step 0 scope only: a lifecycle (start / status / dispose), owned resources that dispose must
// release, a build marker, and one verified own-player read. No actions, no bridge yet.

import { MARKER } from "./marker.ts";
import { Link } from "./link.ts";

declare const GameContext: { localPlayerID: number; localObserverID: number };
declare const Game: { turn: number };
declare const Players: { get(id: number): any };
declare const UI: { isInGame(): boolean; isMultiplayer(): boolean };

const BUILD_ID = "__BUILD_ID__";           // stamped by `dev build`

export interface StartContext {
  bootstrapBuildId: string;
  incarnation: string;
  url: string;
}

export interface Service {
  status(): Record<string, unknown>;
  dispose(): Promise<void>;
}

/** One verified own-seat fact: the bound seat is the local player and the local observer. */
function ownFact(): Record<string, unknown> {
  try {
    const seat = GameContext.localPlayerID;
    const observer = GameContext.localObserverID;
    if (seat !== observer) return { seat, observer, note: "seat and observer differ; no read" };
    const player = Players.get(seat);
    return {
      seat,
      turn: Game.turn,
      gold: player?.Treasury?.goldBalance ?? null,
      inGame: UI.isInGame(),
      multiplayer: UI.isMultiplayer(),
    };
  } catch (e) {
    return { error: String(e) };
  }
}

export async function start(ctx: StartContext): Promise<Service> {
  const startedAt = Date.now();
  let ticks = 0;
  let visibilityChanges = 0;
  let disposed = false;
  // Every owned resource has a cleanup below; dispose() must leave counts at zero (DEV-04).
  const timer = setInterval(() => { ticks += 1; }, 1000);
  const onVisibility = () => { visibilityChanges += 1; };
  document.addEventListener("visibilitychange", onVisibility);
  // a small owned presentation element and its owned stylesheet, so a CSS/component edit is a
  // measurable change class (DEV-09); colour derives from the marker so a build flips it
  const style = document.createElement("style");
  style.id = "civ7-agent-style";
  style.textContent = `.civ7-agent-badge{position:absolute;right:6px;bottom:6px;z-index:9999;font:11px/1.2 monospace;padding:2px 6px;color:#fff;background:${MARKER === "A" ? "rgb(0, 96, 160)" : "rgb(160, 64, 0)"};opacity:.8;pointer-events:none}`;
  document.head.appendChild(style);
  const badge = document.createElement("div");
  badge.className = "civ7-agent-badge";
  badge.textContent = `civ7-agent ${MARKER} ${BUILD_ID}`;
  document.body.appendChild(badge);
  const owned = { timers: 1, listeners: 1, elements: 2 };
  // The outbound link to the local companion (Experiment A2). NOT started automatically: on this
  // build the realm's WebSocket is a host stub ("implementation is not provided ... ViewListener::
  // OpenWebSocket") and opening sockets crashed the game on 2026-09-18. Connectivity experiments run
  // only through an explicit developer call (Civ7Agent.status().link stays "no-socket" otherwise).
  const link = new Link({ buildId: BUILD_ID, incarnation: ctx.incarnation });

  return {
    status() {
      return {
        marker: MARKER,
        serviceBuildId: BUILD_ID,
        bootstrapBuildId: ctx.bootstrapBuildId,
        incarnation: ctx.incarnation,
        url: ctx.url,
        startedAt: new Date(startedAt).toISOString(),
        uptimeMs: Date.now() - startedAt,
        ticks,
        visibilityChanges,
        disposed,
        owned: { ...owned },
        badge: { count: document.querySelectorAll(".civ7-agent-badge").length, styles: document.querySelectorAll("#civ7-agent-style").length,
                 background: (() => { const b = document.querySelector(".civ7-agent-badge"); return b ? getComputedStyle(b).backgroundColor : null; })() },
        own: ownFact(),
        link: link.status(),
      };
    },
    async dispose() {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      link.dispose();
      style.remove();
      badge.remove();
      owned.timers = 0;
      owned.listeners = 0;
      owned.elements = 0;
      disposed = true;
    },
  };
}
