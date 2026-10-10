# Step 0 results: development loop experiments

Experiment ledger for [plans/v2-step-0-development-loop.md] (local, untracked). Every row is
UNTESTED until an experiment with a recorded command and observation says otherwise. "Observed"
means read from the running game or the filesystem; nothing here is inferred from documentation.

## Environment (recorded 2026-09-18)

| item | value |
|---|---|
| game | Civilization VII, Steam app 1295660, buildid 24661151, native Linux (snap Steam), Cohtml 2.2.3.0 |
| install | `~/snap/steam/common/.local/share/Steam/steamapps/common/Sid Meier's Civilization VII/` |
| user data | `~/snap/steam/common/My Games/Sid Meier's Civilization VII/` (AppOptions.txt, Mods/, Saves/, Logs/) |
| local mods folder | `…/My Games/…/Mods/` exists, empty, scanned at startup (Modding.log) |
| enabled user mods | none (six Workshop UI mods installed, disabled) |
| debugger | CDP on 127.0.0.1:9444 with `UIDebugger` at its default (commented out), so it is on by default on this build |
| `UIFileWatcher` | AppOptions key "Watch UI-loaded files for changes and automatically reload"; default 0; set to 1 on 2026-09-18 (backup `AppOptions.txt.bak-2026-09-18`) |
| toolchain | Node 22.22.2 (runs `.ts` directly), npm 10.9.7; registry reachable (`@modelcontextprotocol/sdk` 1.30.0, `ws` 8.21.3, `typescript` 7.0.2) |
| v1 driver | stopped at a seat boundary after turn 132 on 2026-09-18; no mutation process running |
| saves | hotseat autosaves to turn 133 (`Saves/Hotseat/auto/AutoSave_01_0133`) plus the named checkpoint the operator saved; disposable single-player games (tiny map) started 2026-09-18 for the experiments |

## Read-only probes of the running game (2026-09-18, via the debugger)

Hotseat match loaded, seat 0 active:

| probe | observed |
|---|---|
| `UI.isInGame()` / `UI.isMultiplayer()` | `true` / **`true`** in hotseat. The options screen only calls `UI.reloadUI()` when `!UI.isMultiplayer()`, so the game's own reload path is closed in hotseat; `UI.reloadUI` itself exists as a native function |
| `Configuration.getGame()` | `isHotseat: true`, `isLocalMultiplayer: true`, `isNetworkMultiplayer: false`, `isInternetMultiplayer: false` |
| `UI.supportsHotseat()` | `true` |
| realm root | `fs://game/root-game.html`; 102 scripts in `<head>`, 95 of them `type="module"` |
| mod script loading | `Modding.getInitialScripts(InitialScriptType.Default)` returns `{url, isModule}` rows (9 in this match, e.g. `/core/ui/module.js`); `Controls.loadSource(url, isModule)` appends a `<script type="module">`; a native `InitialScriptAdded` event loads scripts added after UI load |
| dynamic import | `import("fs://game/core/ui/utilities/ordered-min-heap.js")` works; the same URL with `?v=2` returns a **different module instance**, and `?v=2` twice returns the **same** one. The module cache is URL-keyed and the query string is honoured |
| missing module | `import()` of a missing `fs://` path rejects (`undefined` reason) |
| storage | `localStorage` object present, empty; `sessionStorage`, `indexedDB` undefined |
| transport | `WebSocket`, `XMLHttpRequest`, `setTimeout`, `requestAnimationFrame` present; `fetch`, `Worker` undefined |
| engine | `engine.on/off/trigger/call/whenReady/createJSModel` present; no reload function on `engine` |
| loading state | `UI.getGameLoadingState()` = 8 (`GameStarted`) |

Consequences: Decision A (own-service replacement through a versioned entry URL) is mechanically
possible; the bootstrap loads `./service/service.js?b=<buildId>` and the build pins every relative
import to the same build id so transitive modules are fresh too. Whether a staged file's new bytes are
read for a new URL, and whether `ImportFiles` assets are importable, are the next experiments.

## Experiment A1: ordinary mod loading (2026-09-18)

- A local mod at `My Games/…/Mods/civ7-agent-dev/` is discovered at launch only (Modding.log "Discovered 1 mods"); edits to the manifest need a game restart.
- Two false starts, both recorded in code comments: the Mod element's `version` must be an integer (`"0.0.1"` was stored as 0 and the enabled mod's actions were skipped), and nothing but the mod directory may sit under `Mods/` (a kept `.prev` copy appeared as a second mod).
- **An existing save adopts a UI-only mod.** The first attempt to load a save with the mod enabled did not apply it, but that run carried the version-0 manifest, which also blocked a new game. With the corrected manifest, the v1 hotseat checkpoint (turn 133, saved before the mod existed) loaded with `game-civ7-agent-dev` in "Target in-game actions" and the bootstrap ran (seat 0, turn 133, `UI.isMultiplayer()` true). So `AffectsSavedGames 0` mods apply to old saves, and the v1 match can host v2.
- With the mod applied: the bootstrap ran once from `fs://game/civ7-agent-dev/ui/bootstrap.js` (UIScripts item, module script), imported `./service/service.js?b=<buildId>` from the `ImportFiles` set, read the transitive marker, and read one own-seat fact (seat 0, turn 1, gold 200) with `UI.isInGame()` true and `UI.isMultiplayer()` false. Second-init refusal is implemented but not yet provoked.

## Experiment B: reload methods (2026-09-18, single-player, turn 1)

| method | observed |
|---|---|
| file update only (`UIFileWatcher 1`) | staged build B over A on disk, waited 8 s: nothing changed (marker A, loads 1, same incarnation). The watcher did not reload our module scripts |
| own-service replacement | `Civ7Agent.load(<B id>)`: marker B (transitive module re-read), new service identity, old service disposed (`disposals` +1), same realm incarnation, badge and stylesheet swapped, owned counts back to one each. First activation 383 ms wall including two debugger round trips |
| 20 alternating A/B cycles | 20/20 pass (`docs/traces/experiment-b-cycles.json`): median build 310 ms, stage 269 ms, activate 723 ms (max 761); one incarnation throughout; exactly one badge and one style element after every cycle; no errors |
| full UI reload (`UI.reloadUI()` direct call) | single-player: bootstrap back after 994 ms with a fresh incarnation, the bootstrap re-read from disk (new build id), `loads` 1, game turn and treasury unchanged, no content reconfiguration in Modding.log, same CDP target URL. **Hotseat (turn 133, seat 0 active):** back after 977 ms; seat, observer, turn, treasury unchanged; turn still active; loading state `GameStarted`; no popup or curtain element present afterwards. The options screen's `isMultiplayer` guard is the caller's choice, not a native refusal. The operator saw the screen flash and the badge change colour in both cases |
| own-service replacement in hotseat | 2 more cycles at turn 133: pass, same behaviour as single-player |
| save reload | untested |
| game restart | works (used three times today); discovery reruns; cost is the full launch plus load |

Change classes so far (DEV-09): service logic, transitive service modules and service-owned CSS/DOM reload by own-service replacement; the bootstrap and the manifest need a UI reload (bootstrap) or a restart (manifest); localization and database actions untested.

## Experiment A2: outbound WebSocket (2026-09-18) — FAILED, game crash

- A build whose service opened `new WebSocket("ws://127.0.0.1:7788/civ7-agent")` to a loopback Node
  peer (`bridge/echo-server.ts`) stayed in `CONNECTING` for over 20 s: no `open`, `error` or `close`
  event, no TCP connection reached the peer (`ss` showed only the listener).
- UI.log at the moment of the constructor call: `Trying to use Websockets, but implementation is not
  provided. Please implement ViewListner::OpenWebSocket correctly.` The constructor exists in the
  realm, but the host (the game) does not implement Cohtml's socket callback. **WebSocket is a stub on
  this build.**
- A follow-up probe that created four sockets at once (two loopback URLs, `localhost`, a closed port)
  logged the same line four times and the game process exited within seconds (no crash log under
  `Logs/`; Steam relaunched the process). Whether one socket or several triggers the exit is unknown;
  the first single socket had been alive for 36 s without a crash.
- Mitigation applied immediately: the staged build rolled back to the socket-free one, the echo peer
  stopped, and the service no longer starts its link at load.

Consequence for the plan: the v2 architecture's transport gate ("outbound WebSocket from the mod")
fails as specified. Candidates to evaluate next, in order: `XMLHttpRequest` to a loopback HTTP server
(present in the realm; the game's own loader has an http dev-server branch, so the host may implement
http resource requests), then native engine bindings that reach the OS, then the debugger protocol
itself (rejected by the plan for gameplay, still a development aid). Each is tested with one request in
a disposable single-player game after a save, watching UI.log for a stub message before any second call.

## Experiment A2b: what does cross the process boundary (2026-09-18, single-player, no crash)

One request each, UI.log watched between steps:

| channel | direction | observed |
|---|---|---|
| `XMLHttpRequest` to `http://127.0.0.1:7789/` | out | 404 in under 1 ms, no TCP traffic; UI.log: "Unable to resolve URL to local file". The host's resource handler serves files only; **HTTP is not implemented** |
| `XMLHttpRequest` to `fs://game/civ7-agent-dev/inbox/ping.json` | in | 200 in 8–15 ms for a file created after load; a changed file is re-read on the next request with or without a cache-busting query; a missing file is a clean 404. **A file written by another process into the mod folder is readable at once** |
| `console.warn` / `console.error` | out | appended to `Logs/UI.log` within the same second (`console.log` is dropped at `UILogLevel 1`) |
| `Automation.log(text)` | out | appended to `Logs/Automation.log` immediately, verbatim, no noise from the game |
| `localStorage.setItem` | out | persisted to `LocalStorage.sqlite` (`Values` table, id `fs://game`) within a second |
| `Automation.loadJSON(path)` | in | returns `null` for relative, `fs://` and absolute paths of an existing file; not usable as tried |
| debugger: `Runtime.consoleAPICalled` | out (push) | `console.debug(json)` arrives at a CDP client as an event with the text, within the same round trip; `Runtime.evaluate` remains the inbound call. Requires `UIDebugger` on |
| `UI.setClipboardText` | out | `isClipboardAvailable()` is false on this build |

So two transports exist without the debugger, both file-based: **inbound** by the companion writing files into the mod folder and the mod polling them over `fs://` (about 9 ms per read, so a 100 ms poll is cheap); **outbound** by `Automation.log` (a dedicated, otherwise silent file) or `localStorage`. And one transport exists with the debugger: CDP evaluate inbound, console events outbound, both pushed. Neither is the WebSocket the plan specified.

## DEV matrix

| ID | question | status | evidence |
|---|---|---|---|
| DEV-01 | ordinary mod init, dispose, native bindings | PASS (init, bindings); dispose on realm teardown untested | Experiment A1 |
| DEV-02 | loopback WebSocket with debugger disabled | **FAIL** | WebSocket is a host stub; opening sockets crashed the game. Experiment A2 |
| DEV-03 | when edits become visible; fresh module identity | PASS for service modules | staged bytes are read for a new `?b=` URL, transitive included (20 cycles); file watcher does nothing for us |
| DEV-04 | disposal removes every owned resource | PARTIAL | owned timer, listener, badge and style are released each cycle (counts observed); late-callback test not yet written |
| DEV-05 | native UI reload in single-player / hotseat | PASS both | ~1 s, seat/turn preserved, bootstrap re-read; presentation flashes |
| DEV-06 | what survives reloads; durable store | UNTESTED | `localStorage` exists (0 keys) |
| DEV-07 | resume under fresh identity without replay | UNTESTED | |
| DEV-08 | unfocused / minimized / menu behaviour | UNTESTED | |
| DEV-09 | change classes vs reload level | PARTIAL | see Experiment B; manifest/localization/database untested |
| DEV-10 | clean package, no debugger, no dev loader | UNTESTED | |

## Decision (provisional, 2026-09-18)

Transport: **blocked as specified** (WebSocket stub, see A2); an alternative transport must be found
before Step 1. Reload loop: **A: own-service replacement works** for the service, its transitive modules and its owned
presentation, in the same loaded game, without a UI reload, at well under a second per cycle. Full UI
reload (B) is the fallback for bootstrap changes and works in single-player and hotseat. Manifest
changes need a restart. Still owed before the decision is final: a late-callback
test for DEV-04, the outbound WebSocket echo (A2) and one MCP read (A3) with the debugger disabled.
