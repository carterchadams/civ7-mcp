# The agent runner

One model plays one bound seat's turn. The runner is a client of the same validated service the
CLI and the MCP server use: it holds no privileged shortcut, and every change it makes to the game
goes through the action registry with the same lock, reservation, `canStart` check and read-back
confirmation as `act perform`.

```
python -m civ7_observer play     --player N --mode MODE [--model ID] [--max-tool-calls K] [--sessions DIR]
python -m civ7_observer friction --player N [--kind KIND] [--sessions DIR]
```

`play` runs exactly one turn and exits: 0 if the turn was ended, 1 otherwise (paused, stopped,
budget exhausted, error). It needs `ANTHROPIC_API_KEY` (or `--api-key`) and fails before touching
the game if there is none.

## The loop

1. Build the turn brief for the bound seat.
2. Assemble the system prompt (below) and hand the model six tools.
3. Run the model's tool calls in order, recording each to the seat transcript.
4. Stop when an `END_TURN` receipt is confirmed, the brief sets `pause`, the model stops calling
   tools, the tool-call budget is spent, or the provider fails.
5. Ask once more, without tools, for the closing summary a human reads.

The brief is cached within a turn and invalidated by every performed action, so a second
`get_turn_brief` with nothing in between does not re-read the game.

### Tools the model has

| tool | effect |
|---|---|
| `get_turn_brief` | the required decision, bounded options, explicit pause |
| `list_actions` | without arguments a survey capped per kind and per settlement or unit; with `kind` every option of that kind seat-wide, in pages (`cursor`) |
| `get_unit_options(unit_id, kind?, cursor?)` | one unit's own legal actions, paged over the catalog captured on the first call |
| `get_city_options(city_id, kind?, cursor?)` | one settlement's own legal actions, paged the same way |
| `perform_action(action_id, request_id, confirm?, text?)` | one offered action id plus a caller-chosen `request_id` (idempotent); `confirm=true` for destructive offers; `text` for the naming kinds |
| `get_action_result(request_id)` | the recorded outcome of an earlier action |
| `get_observation(include_map?)` | the validated observation; the visible-tile list only when asked |

A cursor is bound to the seat, match, turn, age, attachment generation, entity and kind filter and
returns `REFRESH_REQUIRED` once any of those changed; every option is still re-checked at perform.

The model can only ever name an action id the host offered it this turn. An invented id is refused
by shape before any session is opened, and an id from another match or generation is refused by the
registry.

## The prompt

Assembled per turn, in this order: the operating instructions, the operating contract, the skill
cards routed for this turn's decisions, the friction card, the rules those cards reference, the
seat's own plan, and a one-line catalog of every other card it may load.

Cards initially come from `plans/CIV7-AGENT-STRATEGY-GUIDE.md` via `tools/build_skills.py`, which is
deterministic and idempotent: every line of card text is copied verbatim from the guide, and
`tools/build_skills.py --check` (run by `tests/test_build_skills.py`) fails if the committed cards
drift from the source. Cards with `<!-- Runtime-maintained:` in their first three lines are curated directly:
the builder preserves them and excludes them from source-equality checks. Their runtime text is
authoritative; edit these cards without updating the plans. This project's own cards,
which have no source in the guide, live in `skills/local/`.

Routing is explicit, in `skills/__init__.py`: the turn-management card always, then one card per
decision kind in the brief, with the required decision first.

## Per-seat workspace

`<state>/sessions/seat<N>/` is the seat's session directory (see below): `PLAN.md`, `FRICTION.md`,
`README.md` and a copy of the skill cards. The plan is injected into every prompt, bounded at
16 000 bytes with the overrun stated.

## Friction is the backlog

When the model lacks an action or a fact, it appends an entry to `FRICTION.md` (the format is in
the directory's README) instead of guessing: the kind (`missing_action`, `missing_information`,
`unclear_option`, `blocked`), what it was trying to do, and what specifically would have let it
decide. `python -m civ7_observer friction --player N` prints that backlog; the driver prints new
entries after each turn; `docs/friction-triage.md` records the host's answer to each one.

## Playing through the MCP server instead of the direct API

`demo/agent-game.py` plays a whole hotseat game with no API key: for each seat turn it launches an
isolated `claude -p` session whose only MCP tools belong to one server bound to that seat with
`--allow-actions` (the eight game tools above; nothing about plans, skills or friction is a tool),
plus the client's file tools confined to the seat's session directory. The session's system prompt
is assembled by the same function (`runner.assemble_system_prompt`) from a read-only brief the
driver takes first, so the routed cards and the seat's plan are identical to the direct-API path.

The driver never acts on the game. After each seat it reads the seat's journal (did an `END_TURN`
confirm on this turn?), the seat's friction backlog and the seat context, prints one line per seat
turn, and stops at the first pause, error, unknown outcome or turn that did not end, so a human can
look. Runs go to `runs/agent-game/` (`log.jsonl`, and per seat turn the system prompt, the
stream-json transcript and the closing report).

```
python demo/agent-game.py --seats 0 1 2 3 --rounds 5 --model sonnet [--raise-curtain] [--effort low|medium|high|default]
                          [--budget-usd 2.0] [--timeout 1200] [--test-opportunities 2] [--directives PATH]
```

One driver at a time owns the seats: it holds `<state>/driver.lock` for its whole run (a second
driver is refused naming the holder; a dead holder is taken over; an unreadable lock is never
cleared). To stop it cleanly, create `<state>/driver.stop`; it is honoured at the next seat boundary
and consumed. Every turn's `log.jsonl` row names its outcome (`turn_ended`, `unknown_outcome`,
`timeout`, `budget_exhausted`, `turn_cap`, `error`, `not_ended`) with a `stopReason`, and records the
settings it ran under in `run` (model, effort, budget, timeout, curtain mode, opportunities, prompt
bytes, revision). A game that has gone away at a boundary is a `game_unavailable` stop with exit
code 2. The evidence for these guarantees is in `docs/recovery-and-curtain-acceptance.md`.

Before every seat turn the driver tidies the hotseat UI (`curtain.tidy`, a UI-only payload that
sends no engine operation): the stock curtain component mounts one instance per turn activation and
only a human click removes it, so stale instances are pruned to the newest one, and with
`--raise-curtain` every instance is removed so the seat's play can be watched on screen. The advisor
council popup, when present, is confirmed with nothing followed, the way its Confirm button would be.

Production offers are enqueue requests: the game's BUILD operation appends to the city's build queue
(live: three Warriors stacked before this was understood), so each offer carries the city's current
`queue`, its precondition is the queue length, and the brief says so on the production decision.

## What this does not do

Nothing inside the game watches for a seat's turn or drives the hotseat curtain: agent seats play
under it, and the driver above sequences seats from outside by reading the seat context.

## The seat's session directory

The game server is a pure game interface: it observes and acts, and keeps no notion of what the
agent intends. Everything an agent wants to remember across turns lives in its own session
directory, `<state>/sessions/seat<N>/`, which the agent-game driver grants the client's file tools
over and nothing else on the machine (path-scoped rules in the client's absolute form,
`Read(//dir/**)`; reads and writes outside it are refused, verified live). The agent keeps its
canonical `PLAN.md` there, and the driver injects that file into every prompt. Friction goes into
`FRICTION.md` as Markdown entries, which the driver collects after each turn. Every skill card is
copied into `skills/` so the agent can read one without leaving the directory.

## Operator directives

`<state>/sessions/DIRECTIVES.md` belongs to whoever is running the game, sits outside every seat's
directory so no seat can edit it, and is injected verbatim at the top of every seat's prompt, above
the contract, the cards and the plan, framed as goals that outrank the seat's own. It is read fresh
each turn, so an edit takes effect at the next seat without a restart; delete or empty the file to
withdraw it. Use it to steer what gets exercised, such as opening a trade route the moment one is
available and checking every turn until then. `--directives PATH` points the driver elsewhere.

## The live-test ledger

`docs/action-live-test-todo.json` is the repository's list of live-test cases: one per implemented
action kind, variant cases where one receipt shape is not enough (a queued move is not an arrival;
a war is not an influence project), and the plan's families as variants with a disposition
(implemented, partial, already covered, native dormant, excluded) and the evidence behind it.
`tools/build_test_ledger.py` regenerates it (keeping recorded evidence), along with the checklist
`docs/action-live-test-checklist.md` and the coverage report `docs/action-coverage.md`, and seeds live
status from the seat journals on this host. Each kind case carries a fingerprint of the source lines
naming it: a pass earned under an older implementation reads `retest` and is offered again.
Implementation status and live status are kept apart: an action is live-verified only by a confirmed
receipt, under the current contract, in a real game.

Each seat turn, the driver picks a bounded number of open cases (two by default,
`--test-opportunities` raises it) whose kinds that seat is being offered right now and puts a short
"testing opportunities" note in its prompt; a high-consequence case (a war, a razing, a strike, a
disbanding) is never suggested. After the turn it correlates the seat's receipts with the cases: a
confirmed receipt whose effect matches the case's variant passes it; an unknown leaves it
`inconclusive`, a rejection `rejected`; each request counts once, and failures are kept even after a
later pass. Results live per match and per seat under `<state>/testing/<match>/`, with a
`status.json` of statuses and counts only. The agent's own `TESTED:` line is a courtesy for the
reader, not the evidence.
