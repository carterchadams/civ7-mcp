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
| `list_actions` | the full offer listing, when the bounded options are not enough |
| `get_unit_options` | one unit's own legal actions, by the unitId a brief shows; far smaller than the full listing |
| `perform_action` | one offered action id plus a caller-chosen `request_id` (idempotent) |

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

`<workspace>/seat<N>/` holds `plan.json` and `PLAN.md` (the agent's own commitments, at most three
open), `friction.jsonl`, and `transcript.jsonl`. Default root is the host state directory. Plan
edits are applied atomically under a revision, so a stale edit is refused rather than silently
overwriting. A plan written for a different match or attachment generation is marked
`needs_review` rather than carried over.

## Friction is the backlog

When the model lacks an action or a fact, it calls `report_friction` instead of guessing. Each
entry records the kind (`missing_action`, `missing_information`, `unclear_option`, `blocked`), what
it was trying to do, what specifically would have let it decide, and the seat, match, turn and the
decision the game was blocking on. `python -m civ7_observer friction --player N` prints that
backlog; it is the input to the next round of action implementation.

## Playing through the MCP server instead of the direct API

`demo/agent-game.py` plays a whole hotseat game with no API key: for each seat turn it launches an
isolated `claude -p` session (`--tools ""`, `--strict-mcp-config`) whose only tools belong to one
MCP server bound to that seat with `--allow-actions`. The server exposes the same six tools the
in-process runner hands its model, under the same names (`get_turn_brief`, `list_actions`,
`perform_action`, `load_skill`, `update_plan`, `report_friction`), plus `get_plan`,
`get_action_result` and `get_observation`. The session's system prompt is assembled by the same
function (`runner.assemble_system_prompt`) from a read-only brief the driver takes first, so the
routed cards and the seat's plan are identical to the direct-API path.

The driver never acts on the game. After each seat it reads the seat's journal (did an `END_TURN`
confirm on this turn?), the seat's friction backlog and the seat context, prints one line per seat
turn, and stops at the first pause, error, unknown outcome or turn that did not end, so a human can
look. Runs go to `runs/agent-game/` (`log.jsonl`, and per seat turn the system prompt, the
stream-json transcript and the closing report).

```
python demo/agent-game.py --seats 0 1 2 3 --rounds 5 --model sonnet [--raise-curtain]
```

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
