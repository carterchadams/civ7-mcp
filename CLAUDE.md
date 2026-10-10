# CLAUDE.md

Instructions for Claude Code in this repository. Claude is the **author**: it plans, designs and
writes the code. Codex is the **adversarial reviewer** (see [CODEX.md](CODEX.md)): it reviews
Claude's plans and code and does not write either. A human operator owns the game, the decisions
and the merges.

## What this repository is

MCP servers that let AI agents play Civilization VII as ordinary players, one seat each, through
the game's own rules.

| path | what | state |
|---|---|---|
| `civ7-observer/` | v1, Python. Talks to the game through its Cohtml UI debugger (CDP). Seat-bound observation, a constrained catalog of native actions, a stdio MCP server, an agent-vs-agent hotseat driver | working; development stopped 2026-09-17 |
| `civ7-plugin/` | v2, Node/TypeScript. A game-owned mod plus a thin local MCP bridge, so play does not need the debugger | Step 0 (development-loop experiments); transport is the open decision |

`civ7-observer/STATUS.md` is the authoritative capability list and must change in the same commit
as the code it describes. In v2, `civ7-plugin/docs/step-0-results.md` is the experiment ledger.

`plans/` and `review/` are local and gitignored. Plans and reviews are working material between
Claude, Codex and the operator, and they are never committed. Anything a fresh clone needs belongs in
`STATUS.md` or `docs/`.

## The workflow: plan, adversarial review, then build

Every non-trivial change goes through the same loop. Skip it only for a typo or a one-line fix with
an obvious test.

1. **Investigate before planning.** Read the code, the contract docs and the dated lessons in
   `civ7-observer/docs/action-contract.md`. When a native behaviour is unknown, plan a read-only
   probe of the running game. Never assume a behaviour from community docs or the API's shape.
2. **Write the plan** in `plans/`. A plan states:
   - the outcome, and what is explicitly out of scope;
   - the design, component boundaries and the invariants it must keep (see *Invariants*);
   - work packages small enough to review one at a time, each with acceptance criteria;
   - for each criterion, the evidence that will close it: an offline test, a live receipt, or a
     recorded observation. Say which, because they prove different things;
   - risks, open questions, and what would make the plan wrong.
3. **Ask Codex to review the plan, and wait for the review.** Treat every finding as a claim to
   check. Fix it in the plan, or answer it in writing with evidence. Disagreeing is fine; ignoring a
   finding is not. Re-review when the design changes materially.
4. **Implement in slices.** One work package per commit, or a short series. Each commit leaves the
   tests green and says in its subject what the system now does. Name the work package it closes
   (`... (Change 3)`, `... (work package A)`).
5. **Ask Codex to review the code** against the plan and baseline commit. Findings come back
   numbered and prioritised (R1… with P1/P2). Fix them in commits that cite the findings
   (`Review R1-R4: ...`). Don't fold unrelated work into a review-fix commit.
6. **Verify live, then record it.** Offline green is not done. Run the change against the real game
   (see *Testing*) and update `STATUS.md`, the coverage docs and the dated evidence. If something was
   not verified live, say so where a reader will see it.

Claude does not mark its own work accepted. Acceptance is the operator's call, informed by Codex's
review and the evidence.

## Invariants (v1, enforced by tests; keep them in v2)

- **One bound seat per server.** The bound id must equal both `localPlayerID` and
  `localObserverID` before any read or write; otherwise the call is refused. The game's debug API is
  omniscient, so this package is the only thing that keeps one seat from seeing another's state.
- **Packaged payloads only.** JavaScript sent to the game comes from `payloads/*.js` with
  host-validated, typed substitutions. Never evaluate text from a model or the command line.
  `tests/test_payload_policy.py` scans every payload. Extend the policy; don't weaken it.
- **Visibility first.** Map data is exported only for tiles the bound seat can currently see.
- **Agents act only through offered ids.** A model names an opaque action id the host offered
  this turn. The host checks `canStart` immediately before sending, reserves the action durably
  before dispatch, and confirms it by reading the game back. An ambiguous outcome is `unknown` and
  is never retried automatically.
- **Seat sessions are isolated.** The driver gives each `claude -p` seat only its own MCP server and
  file tools confined to its session directory: no shell, no network, no subagents. A seat that
  could run a command could read another seat's state.
- **Corrupt state stops; it never reads as empty.**

## Testing

There are two tiers, and they prove different things.

### Offline: fast, deterministic, proves the host

```bash
python3 -m venv .venv && .venv/bin/pip install -e 'civ7-observer[test]'
civ7-observer/run-tests.sh          # pytest + Node payload tests
cd civ7-plugin && npm ci && npm run typecheck && npm test
```

The Python suite runs a fake Cohtml debugger (HTTP `/json` plus a minimal WebSocket server) and
scripted sockets. The Node tests run the real payloads against mocked game globals. These tests
prove the host's own logic: binding, validation, locking, recovery, pagination and the payload
policy. **They cannot prove native game semantics**, because the mocks encode our beliefs about the
engine. Run them before every commit; CI runs them on every push.

### Live: slow, agent-driven, the only source of truth for the game

This project deliberately does not try to build a fast automated integration suite against the
game. The game has no headless mode and no API to stage a scenario. Most action kinds are reachable
only from game states that take dozens of turns of real play to arise: a war with a major civ, an
Age transition, a captured settlement. Instead, **agents play the game and the harness grades what
they did**:

- `civ7-observer/demo/agent-game.py` runs a hotseat match in which every seat is an isolated
  Claude Code session (about 60 s and $0.50 per seat-turn).
- The live-test ledger (`docs/action-live-test-todo.json`, `src/civ7_observer/testing.py`) picks a
  bounded number of not-yet-verified action kinds the seat is being offered right now and adds a
  "testing opportunities" note to its prompt. High-consequence kinds are never suggested.
- Grading uses **receipts only**. An action kind is live-verified only by a confirmed receipt,
  read back from the game and stamped with the current contract digest of the source that implements
  it. Changing that source turns earlier passes into `retest`. What an agent says it did is never
  evidence.
- Seats report missing tools or facts in `FRICTION.md`. That is the product backlog
  (`docs/friction-triage.md`).
- `<state>/sessions/DIRECTIVES.md` lets the operator steer every seat toward the scenario under
  test without a restart.

How to work with it:

- Live sessions mutate a real game. Save a named checkpoint first, and use a disposable
  single-player game for risky experiments.
- Make one controlled change at a time and probe once before calling anything repeatedly. In v2, one
  experiment opening several WebSockets crashed the game.
- Stop the driver with `<state>/driver.stop`, which it honours at the next seat boundary. Never kill
  it mid-action.
- The tradeoff is real. Live coverage is slow, costs money, depends on what the game state offers,
  and is not reproducible turn for turn. So keep host logic covered offline, keep live status
  separate from implementation status in every doc, and report each kind as live-verified,
  offline-only or `not_seen`.

## Conventions

- Python 3.12 in v1; Node 22.18+ running `.ts` directly in v2 (no Python in `civ7-plugin/`).
- Match the surrounding code: dense, typed and commented where the reason is not obvious. Typed
  error codes (`WRONG_PLAYER`, `CONTEXT_CHANGED`, `REFRESH_REQUIRED`, …) rather than free text.
- Commit subjects say what the system now does, in the present tense. End commits with the
  `Co-Authored-By` trailer for the model that wrote them.
- Don't commit `runs/`, `plans/`, `review/`, host state or machine-specific paths.
- The debugger port listens on `0.0.0.0:9444` on this build. Never forward it.
