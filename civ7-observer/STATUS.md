# civ7-observer — capability and status

Authoritative, tracked summary of what this package does today. Updated with the code, not with
plans. Planning documents and reviews are deliberately untracked local material; everything a
fresh clone needs to understand and reproduce the current capability is here or in `docs/`.

Last updated: 2026-09-17. Tested build: Civilization VII, Steam app 1295660, buildid 24661151,
native Linux (snap Steam), Cohtml 2.2.3.0 / CDP 1.3. Enabled content and campaign settings:
`docs/tested-build.md` (no user mods enabled).

## What it is

A local companion that reads one Civilization VII player's state through the game's Cohtml UI
debugger, and can perform a small set of that player's own native actions. It is **not**
observation-only any more: `act perform` mutates the running game.

| capability | state |
|---|---|
| read-only observation of one bound seat (settlements, units, technology, civics, visible map) | working, live-verified |
| stdio MCP server exposing `get_observation` / `get_status` | working, live-verified |
| constrained native actions: 125 public kinds across research, civics, production and purchase, settlement growth, units and armies, orders, movement, diplomacy, peace, religion, traditions, resources, towns, age transition and legacies, artifacts and great works, air and naval actions, tile work, naming (see `docs/action-coverage.md` for every kind) | working; 51 kinds have at least one confirmed receipt in a real game, all earned before receipts were stamped with a contract digest and so `passed_historical`; 74 are offline-verified only (`docs/action-coverage.md`); destructive kinds are confirmation-gated |
| compact turn brief (`get_turn_brief`): the required decision, bounded options, every unit listed, explicit pause | working, live-verified (~4-5 KB) |
| actions exposed over MCP (`--allow-actions`) | working, live-verified end to end with a real MCP client |
| agent runner: a model plays one turn of one bound seat (`play`, direct API) | offline-tested only; the active path is the subscription driver above |
| seat sessions over MCP: `demo/agent-game.py` plays every seat of a hotseat game with one isolated `claude -p` session per seat turn | working, live (3 surviving agent seats, 112+ turns; the testing runs remove the curtain to watch, see limits) |
| skill cards generated from the strategy guide, routed per decision, copied into each seat's session directory | working, live |
| per-seat session directory (`PLAN.md` injected every prompt, bounded; `FRICTION.md` collected each turn); operator directives above every seat | working, live |
| live-test ledger: kinds, variants and plan families kept apart, whole-region contract digests stamped on receipts at execution, one evaluator for generator and play, receipts-only grading, bounded prompt opportunities | working, live (`docs/action-coverage.md`, `docs/action-live-test-checklist.md`); every pass before 2026-09-18 is `passed_historical` until re-earned under a stamped receipt |
| driver controller lock, boundary stop file, named outcomes, run metadata per turn | working, offline-tested with stub processes (`docs/recovery-and-curtain-acceptance.md`) |
| scheduler inside the game (watching for a seat's turn) | **not implemented**; the driver sequences seats from outside by reading the seat context |
| hotseat curtain handling (`curtain prune` / `curtain raise`, `agent-game.py --raise-curtain`): UI-only removal of stale curtain instances or all of them, and confirming the advisor popup with nothing followed | working, live (17 stale instances removed after five all-agent turns) |
| in-game mod, remote seats, containers | **not implemented, deferred** (see release scope) |

## Commands

```
python -m civ7_observer doctor   [--json] [--port] [--timeout] [--target-id]
python -m civ7_observer probe    --out FILE [--player N] [--json]         # developer diagnostics
python -m civ7_observer snapshot --mode MODE [--player N] --out FILE [--json]
python -m civ7_observer serve    --player N --mode MODE [--allow-actions] [--journal FILE]
python -m civ7_observer act      {list|perform|result|reconcile|rebind} --player N --mode MODE [...]
python -m civ7_observer play     --player N --mode MODE [--model ID] [--max-tool-calls K] [--sessions DIR]
python -m civ7_observer friction --player N [--kind KIND] [--sessions DIR]
python -m civ7_observer curtain  {prune|raise} [--json]                      # hotseat UI tidy-up, sends no engine operation
```

`play` runs one turn of the bound seat with a model and exits 0 only if the turn was ended. It
needs `ANTHROPIC_API_KEY`. See `docs/agent-runner.md`. The hotseat driver is
`python demo/agent-game.py --seats ... [--rounds N] [--effort E] [--budget-usd D] [--timeout S] [--test-opportunities K] [--directives PATH] [--raise-curtain]`;
it holds `<state>/driver.lock` while running and stops at the next seat boundary when `<state>/driver.stop` exists.

`MODE` is `singleplayer` or `local-hotseat` and must match the running game. `--player` is an
engine player id and must equal both `localPlayerID` and `localObserverID` at the time of the call.

### MCP tools

Read-only by default: `get_observation(include_map=false)`, `get_status`. With `--allow-actions`
the seat's action catalog is added: `get_turn_brief` (start here each turn), `list_actions(kind?, cursor?)`
(a capped survey, or every option of one kind seat-wide in pages), `get_unit_options(unit_id, kind?, cursor?)`
and `get_city_options(city_id, kind?, cursor?)` (one unit's or one settlement's own choices, paged over
the catalog captured on the first call; a cursor bound to seat, turn, generation, entity and filter
returns `REFRESH_REQUIRED` when any changed), `perform_action(action_id, request_id, confirm?, text?)`
(`request_id` makes it idempotent; `confirm=true` is required for destructive offers; `text` is the
validated name for the naming kinds) and `get_action_result`, plus nothing else: the server is a
pure game interface. The agent's plan, notes and friction live in its
own session directory, which the driver confines its file tools to and whose `PLAN.md` it injects
into every prompt (see `docs/agent-runner.md`).
A client only ever sees opaque action ids; engine operation names and arguments stay host-side.

## Host state (persistent, outside the repo)

`$CIV7_OBSERVER_STATE_DIR` or `~/.local/state/civ7-observer/`:

| file | purpose |
|---|---|
| `game.lock` | one interprocess lock for the whole game instance; every capture, offer listing and dispatch is serialized through it |
| `generations.json` | per-match attachment generation and highest turn seen |
| `inflight.json` | durable reservation written **before** any mutation is dispatched |
| `unresolved.json` | game-wide barrier of uncertain outcomes |
| `quarantine.json` | (kind, arguments) pairs withheld after two unknown outcomes on the same target; lifted by the operator |
| `testing/<match>/seat<N>.json`, `status.json` | live-test results per seat, and statuses and counts only |
| `sessions/DIRECTIVES.md` | operator directives, injected above every seat's prompt |
| `driver.lock`, `driver.stop` | the hotseat driver's controller lock and boundary stop request |

Plus `sessions/seat<N>/` (the agent's own `PLAN.md`, `FRICTION.md`, notes and a copy of the skill cards) and a
per-seat journal wherever `--journal` points (default `runs/actions.jsonl`) with its
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

1. One invocation plays one seat turn. `demo/agent-game.py` sequences seats from outside the game by
   reading the seat context and stops at the first pause or failed turn; nothing inside the game
   watches for a seat's turn or drives the hotseat curtain (agent seats play under it).
2. Observations omit economy, resources, foreign entities, diplomacy and notifications, so the
   current offers are not sufficient decision context for good play.
3. The action catalog has 125 public kinds; 51 have a confirmed receipt in a real game (all
   `passed_historical`, none yet re-earned under a stamped receipt) and 74 are offline-verified only
   (`docs/action-coverage.md`). Of the remaining-actions plan's 28 families,
   26 are implemented and 2 are explicitly partial: sending peace **terms** or a counteroffer (the
   working-deal item API is known and inspected, sending awaits a war with a major), and unit swap
   (`UNITOPERATION_SWAP_UNITS`, not implemented). Native-dormant and already-covered variants are
   listed with their evidence in the coverage report.
4. Concealment behind the stock hotseat curtain is verified for consecutive agent seats and the gate
   categories (`docs/recovery-and-curtain-acceptance.md`); popups other than the advisor's, diplomacy
   screens and mid-action disconnects are not. **The testing runs of 2026-09-11/17 use `--raise-curtain`
   and exercise no concealment.**
5. Performance: `docs/stage-1-performance-report.md`, regenerated by `tools/stage1_report.py`. Cohorts
   are split into *recorded* (settings written into each log row) and *inferred* (date periods whose
   settings come from history); rounds are counted against evidenced seat membership by match, age and
   turn; the reading is computed from the cohorts shown and names representative turns; every unknown
   outcome is listed with its journal kind and the lesson its repair was recorded under. Descriptive, not
   controlled: nothing is attributed to the prompt or the effort setting alone.
6. The debugger listens on `0.0.0.0:9444` on this build. Firewall it on a shared network.
7. Peace-deal identity shapes, resettling, syncretism, capital selection, legacy placement, most
   army/logistics/tile operations, air and naval actions, naming and the strike have no live receipt
   yet; they are offered only where the engine's own check allows them and stay `not_seen` until a
   natural opportunity confirms them.

## Evidence

`docs/runtime-contract.md` (per-field native API contract), `docs/action-contract.md` (action
semantics, binding rules and dated lessons), `docs/agent-runner.md` (the runner, the driver, their
prompt and tools), `docs/action-coverage.md`, `docs/action-live-test-checklist.md` and
`docs/action-live-test-todo.json` (the ledger), `docs/recovery-and-curtain-acceptance.md`
(recovery, controller and curtain evidence), `docs/stage-1-performance-report.md`,
`docs/friction-triage.md`, `docs/tested-build.md`, `docs/live-test-results.md` and
`docs/phase-2-live-test-results.md` (what was actually run against the game, with results),
`docs/hotseat-matrix.jsonl` and `docs/hotseat-mcp-matrix.jsonl` (raw robustness rows).

## Tests

```
civ7-observer/run-tests.sh        # pytest + node --test
```

564 Python tests and 216 JavaScript tests at the time of writing. Offline tests use a fake Cohtml
debugger and mocked game globals; **passing them does not establish native engine semantics**, only
that our code behaves as intended against our understanding of it.
