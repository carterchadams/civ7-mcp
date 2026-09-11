# The agent runner

One model plays one bound seat's turn. The runner is a client of the same validated service the
CLI and the MCP server use: it holds no privileged shortcut, and every change it makes to the game
goes through the action registry with the same lock, reservation, `canStart` check and read-back
confirmation as `act perform`.

```
python -m civ7_observer play     --player N --mode MODE [--model ID] [--max-tool-calls K] [--workspace DIR]
python -m civ7_observer friction --player N [--kind KIND] [--workspace DIR]
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
| `perform_action` | one offered action id plus a caller-chosen `request_id` (idempotent) |
| `load_skill` | another skill card by id |
| `update_plan` | bounded edits to this seat's own multi-turn plan |
| `report_friction` | record that a tool or a fact it needed is missing |

The model can only ever name an action id the host offered it this turn. An invented id is refused
by shape before any session is opened, and an id from another match or generation is refused by the
registry.

## The prompt

Assembled per turn, in this order: the operating instructions, the operating contract, the skill
cards routed for this turn's decisions, the friction card, the rules those cards reference, the
seat's own plan, and a one-line catalog of every other card it may load.

Cards are generated from `plans/CIV7-AGENT-STRATEGY-GUIDE.md` by `tools/build_skills.py`, which is
deterministic and idempotent: every line of card text is copied verbatim from the guide, and
`tools/build_skills.py --check` (run by `tests/test_build_skills.py`) fails if the committed cards
drift from the source. Do not hand-edit `src/civ7_observer/skills/*.md`. This project's own cards,
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

## What this does not do

No scheduler: one invocation plays one turn of one seat. Nothing here watches for the seat's turn
to come up, swaps seats, or drives the hotseat curtain.
