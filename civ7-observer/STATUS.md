# civ7-observer — capability and status

Authoritative, tracked summary of what this package does today. Updated with the code, not with
plans. Planning documents and reviews are deliberately untracked local material; everything a
fresh clone needs to understand and reproduce the current capability is here or in `docs/`.

Last updated: 2026-09-11. Tested build: Civilization VII, Steam app 1295660, buildid 24661151,
native Linux (snap Steam), Cohtml 2.2.3.0 / CDP 1.3. DLC and mod list not yet recorded (gap).

## What it is

A local companion that reads one Civilization VII player's state through the game's Cohtml UI
debugger, and can perform a small set of that player's own native actions. It is **not**
observation-only any more: `act perform` mutates the running game.

| capability | state |
|---|---|
| read-only observation of one bound seat (settlements, units, technology, civics, visible map) | working, live-verified |
| stdio MCP server exposing `get_observation` / `get_status` | working, live-verified |
| constrained native actions (research, civic, skip unit, move unit, produce unit, end turn) | working, live-verified via CLI only |
| actions exposed over MCP | **not implemented** (CLI only) |
| agent runner / scheduler | **not implemented** |
| in-game mod, remote seats, containers | **not implemented, deferred** (see release scope) |

## Commands

```
python -m civ7_observer doctor   [--json] [--port] [--timeout] [--target-id]
python -m civ7_observer probe    --out FILE [--player N] [--json]         # developer diagnostics
python -m civ7_observer snapshot --mode MODE [--player N] --out FILE [--json]
python -m civ7_observer serve    --player N --mode MODE                   # stdio MCP, read-only tools
python -m civ7_observer act      {list|perform|result|reconcile|rebind} --player N --mode MODE [...]
```

`MODE` is `singleplayer` or `local-hotseat` and must match the running game. `--player` is an
engine player id and must equal both `localPlayerID` and `localObserverID` at the time of the call.

## Host state (persistent, outside the repo)

`$CIV7_OBSERVER_STATE_DIR` or `~/.local/state/civ7-observer/`:

| file | purpose |
|---|---|
| `game.lock` | one interprocess lock for the whole game instance; every capture, offer listing and dispatch is serialized through it |
| `generations.json` | per-match attachment generation and highest turn seen |
| `inflight.json` | durable reservation written **before** any mutation is dispatched |
| `unresolved.json` | game-wide barrier of uncertain outcomes |

Plus a per-seat journal wherever `--journal` points (default `runs/actions.jsonl`) with its
`.offers.json` sidecar. Corrupt shared state raises `STATE_CORRUPT` and stops; it never reads as
empty. A reservation with no recorded outcome makes every seat refuse `RECONCILIATION_REQUIRED`
until a human resolves it with `act reconcile`.

## Attachment identity

Match identity is `Configuration.getGame().campaignSetupGUID` (the `gameGUIDHexString` field is
empty on this build). It is **stable across reloads of the same campaign**, so the host keeps an
attachment generation per match that bumps when the observed turn goes backwards, and can be
bumped explicitly with `act rebind --note "..."` for a reload the game cannot signal (same
campaign, same turn, or a later save). Offers, journal rows and observations all carry
`{match, generation, seat, turn, age}`.

**Limitation:** turn regression is the only automatic reload signal available. A same-turn or
forward reload is not detected; after any load the host must be rebound explicitly.

## Safety properties actually enforced

- One bound seat per service instance; the payload refuses inside the game if the bound id is not
  both the local player and the local observer.
- Visibility-first map extraction; only currently visible tiles are exported, enforced at
  enumeration and again at execution for moves.
- Every packaged payload is scanned by `tests/test_payload_policy.py`; the single mutation payload
  is held to an exact engine-call allowlist with host-substituted enum kinds and integer arguments.
- Native `canStart` immediately before every mutation, plus a per-kind state precondition checked
  inside the game.
- Read-back confirmation requires the originating match, turn, age, seat and observer; the
  confirming effect is recorded in the receipt. Ambiguous outcomes are `unknown`, never retried.

## Known gaps and non-claims

1. Actions are CLI-only; an agent cannot take them through MCP yet.
2. Observations omit economy, resources, foreign entities, diplomacy and notifications, so the
   current offers are not sufficient decision context for good play.
3. The action catalog covers 6 of the game's decision kinds; see `../plans/civ7-player-actions.md`
   (untracked) for the full inventory and `docs/action-contract.md` for what is implemented.
4. Concealment behind the stock hotseat curtain is verified for one agent turn; consecutive agent
   seats, blocking popups, diplomacy and disconnect are not.
5. No end-to-end token/latency measurement for a model decision loop.
6. The debugger listens on `0.0.0.0:9444` on this build. Firewall it on a shared network.
7. DLC and mod list for the tested build are not recorded.

## Evidence

`docs/runtime-contract.md` (per-field native API contract), `docs/action-contract.md` (action
semantics and binding rules), `docs/live-test-results.md` and `docs/phase-2-live-test-results.md`
(what was actually run against the game, with results), `docs/hotseat-matrix.jsonl` and
`docs/hotseat-mcp-matrix.jsonl` (raw robustness rows).

## Tests

```
civ7-observer/run-tests.sh        # pytest + node --test
```

337 Python tests and 78 JavaScript tests at the time of writing. Offline tests use a fake Cohtml
debugger and mocked game globals; **passing them does not establish native engine semantics**, only
that our code behaves as intended against our understanding of it.
