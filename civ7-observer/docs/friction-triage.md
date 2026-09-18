# Friction triage

The seats' own `FRICTION.md` files are theirs and are not rewritten. This is the host's answer to
each entry: what landed, where the evidence is, or what stays open. Entries are quoted by their
heading; seat files live under `<state>/sessions/seat<N>/FRICTION.md`.

| seat | entry | disposition | host-side reference |
|---|---|---|---|
| 0 | locate a foreign settlement for the trade-route directive | resolved | `send_merchant` toward the nearest purchased plot (contract row) and two confirmed routes on 2026-09-11; the directive was withdrawn |
| 0 | turn 106, debugger unavailable, no tool access | resolved (named stop) | the game had been closed after round 105; the driver now stops with `game_unavailable` instead of a traceback (`docs/recovery-and-curtain-acceptance.md`) |
| 1 | turn 109 NOTIFICATION_COMMAND_UNITS loop never clears for 6 units | resolved | the six were already under orders; `unit_order` is offered only to units awaiting orders (contract lesson, turn 109; `67ae6e0`) |
| 1 | ASSIGN_NEW_RESOURCES blocker on turn 85 / loop reproduced / infinite loop turn 82 / clearing for a single ivory | resolved | only an unplaced resource counts toward the blocker, reassignments are marked and rank last, unplaced options lead each settlement (`3ce094c`, `6e9c951`, `3aac983`; contract lessons turns 82 and 85) |
| 1 | settler 1769479 has zero move options (turns 83, 85; again; stuck at (13,9)) | resolved after the loss | a standing order also reads as a pending operation, so the turn-66 travelling guard withheld its moves; narrowed to units mid-move (`75c2abd`, lesson turn 99). The settler was disbanded on turn 99 before the fix |
| 1 | found city with Settler 786439 at (13,7), turn 56 | resolved (quarantined) | founding there hung the script thread five times; the (kind, args) pair is quarantined after two unknowns and withheld (`quarantine.json`) |
| 1 | open a trade route per operator directive, turns 56 and 61 | resolved | as seat 0's first entry |
| 3 | open a trade route for merchant 196610 | resolved | as above |
| 3 | T58 mid-turn loss of seat binding (WRONG_PLAYER) | expected behaviour | the seat's turn had ended under it (a seat may not act once the game has moved on); ownership is rechecked on every dispatch and the runner stops. No host change |
| 3 | settler 1179656 has offered zero move options for 13+ turns | resolved after the loss | same cause as seat 1's settler; the standing-order guard was narrowed on turn 99 |

Open: none of the entries above describes a still-standing host defect. New entries are collected
by the driver after every seat turn and printed under the turn's line.
