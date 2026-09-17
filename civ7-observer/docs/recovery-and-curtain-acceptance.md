# Recovery, controller and curtain acceptance

What the harness guarantees when a seat turn goes wrong, how each guarantee is proven, and what is
only observed or still open. Offline tests run with scripted sockets and stub processes; they prove
the host's behaviour, not native semantics. Live rows cite the logs they come from. Written for
work package E of `plans/complete-outstanding.md`; revision as of the commit that adds this file.

## Recovery of a single action

| Requirement (smaller Phase 2, amendment 3) | Proof | Notes |
|---|---|---|
| A reply dropped after the engine acted is unknown, journaled, and blocks further actions | `tests/test_actions.py::test_transport_loss_after_send_is_journaled_unknown_and_blocks_further_actions` | The reconciliation barrier is game-wide; `act reconcile` is the only way through it |
| A crash between execution and the journal write keeps the full intent and allows an identical retry only after reconciliation | `test_crash_recovery_keeps_full_identity_and_allows_identical_retry_after_reconcile`, `test_inflight_reservation_is_written_before_dispatch_and_cleared_after`, `test_crash_after_dispatch_is_visible_to_another_seat_without_reopening_the_first_journal` | The durable reservation is written before dispatch |
| A malformed or ambiguous mutation response is unknown, never rejected | `test_malformed_mutation_response_is_unknown_not_rejected` | Only an explicit, well-formed refusal proves nothing was sent |
| No duplicate mutation: a request id repeats its first outcome | `test_perform_rejects_unknown_expired_or_unstartable_offers` and the `REQUEST_ID_REUSED` path in `actions.py` | Request ids are chosen by the caller and idempotent |
| Stale or cross-seat handles are refused before dispatch | `test_perform_rejects_unknown_expired_or_unstartable_offers` (`WRONG_PLAYER` at line ~102), offer expiry on turn/age/match/generation in `_perform` | Ownership is rechecked on every dispatch through `_bind_ok`; a model answering after the seat was taken over gets `WRONG_PLAYER` and nothing is sent |
| Two independent controllers cannot both dispatch the same request; dispatch is serialized by the game lock | `test_concurrent_registries_cannot_both_dispatch_the_same_request`, `test_dispatch_is_serialized_across_journals_by_the_game_lock`, `test_recovery_writes_happen_only_under_the_game_lock` | The game-action lock is short-lived and per write |
| Corrupt shared state pauses rather than clearing the barrier | `test_corrupt_shared_state_pauses_instead_of_clearing_the_barrier` | |
| Save reload: turn regression bumps the generation and expires offers; a same-turn reload needs an explicit rebind, which invalidates old handles and refuses unresolved writes | `test_turn_regression_bumps_generation_and_expires_offers`, `test_explicit_rebind_bumps_generation_and_expires_offers`, `test_unknown_outcome_in_one_journal_blocks_actions_from_another_journal_on_the_same_game` | Automatic detection of a same-turn reload is **not** claimed; `act rebind` is the documented step. Verified live on 2026-09-17: a forward reload (turn 106 save after turn 105) needed no rebind and the generation record stayed consistent |
| An action that goes unknown twice for the same target is quarantined | `test_an_action_that_goes_unknown_twice_for_the_same_target_is_quarantined_and_withheld` | Lifted by the operator only |

## Runner and driver limits

| Requirement | Proof | Notes |
|---|---|---|
| Finite tool-call budget with a named stop | `tests/test_runner.py::test_the_tool_call_budget_stops_the_turn` | In-process runner |
| A provider failure stops the turn without acting | `test_runner.py::test_a_provider_failure_stops_the_turn_without_acting` | |
| A pause stops the turn without acting | `test_runner.py::test_a_pause_stops_the_turn_without_acting` | |
| Per-seat wall-clock cap: a hung client is killed and the turn is named `timeout` | `tests/test_agent_game_driver.py::test_the_child_runner_reports_exit_codes_and_kills_a_hung_client`, `test_outcomes_are_named_and_an_unknown_receipt_outranks_everything` | Stub child process |
| Spend cap: a client stopped at its budget is named `budget_exhausted`, a turn cap `turn_cap`, a crash `error`; an unknown receipt outranks all of them | `test_outcomes_are_named_and_an_unknown_receipt_outranks_everything` | Live: turn 85 (2026-09-11) was cut at $1.50 mid-action and replayed cleanly after a restart because request ids made the replay idempotent |
| Plan storage is bounded before injection | `tests/test_session.py::test_the_plan_injection_is_bounded_and_says_how_far_it_overran` | 16 000 bytes; the head is kept and the overrun is stated |
| One controller at a time; a dead holder is taken over; an unreadable lock is never cleared | `test_only_one_controller_owns_the_seats_and_a_dead_holder_is_taken_over` | `<state>/driver.lock`, separate from the game-action lock |
| Stop at a safe boundary on request | `test_a_stop_file_is_honoured_once_at_a_boundary`, `test_the_main_loop_stops_cleanly_when_the_game_is_gone_or_a_stop_is_requested` | `<state>/driver.stop`; before this the operator killed the driver between turns with a watcher script |
| A game that has gone away is a named stop, not a crash | same | Live: on 2026-09-11 17:23 the game was closed after round 105 and the driver died with a traceback (`batch-67.out`); with this change it exits 2 with `game_unavailable` |
| Run settings are recorded per turn | `run` on every `log.jsonl` row from this revision on (model, effort, budget, timeout, curtain mode, opportunities, prompt bytes, revision) | Earlier rows carry none of these; their settings are recovered in the Stage 1 report only where the command is known |

## The stock curtain

Observed, not certified. All rows from `docs/phase-2-live-test-results.md` unless stated.

| Case | Observed | Status |
|---|---|---|
| Native operations execute under the curtain; the turn and the curtain advance | Gate stages 1a–1c (2026-09-11): research, skip, move, production, end turn under the curtain; the human saw only the curtain | passed live |
| Movement under the curtain shows no camera or map to the human | Gate stage 2 | passed live |
| Human input during automation | Gate stage 2: clicks and keys had no visible effect; music audible | passed live (one session) |
| Human takeover of a paused decision | Gate stage 2: the human dismissed the curtain, chose production, ended the turn | passed live (manual; no companion code involved) |
| Double curtain after an agent turn ends under its own curtain | Gate stage 1c quirk: the human's first click dismisses the agent's spent curtain, the second the human's own | known limitation, harmless for concealment |
| A blocking popup during an agent turn | The advisor popup is confirmed by the curtain tidy-up (`curtain.js`, `advisorPopup` in every driver row) | handled for the one popup seen; other popups open |
| A diplomacy event during an agent turn | First contact (`greet_new_civilization`) and incoming proposals (`respond_to_proposal`) are decisions the seat answers; whether their screens render above the curtain has not been watched | open |
| Disconnect and reconnect mid-turn | Not exercised deliberately. Observed: the game closing at a round boundary killed the driver (2026-09-11); the debugger going away mid-action would surface as an unknown outcome and the barrier | open (deliberate test still owed) |
| Concealment envelope of the testing runs of 2026-09-11/17 | Every batch since Stage 1 ran with `--raise-curtain`, which removes the curtain so play can be watched: **these runs exercise no concealment at all** | stated limitation |

Supported envelope, as observed: consecutive agent seats behind the stock curtain with the human
never clicking through, for the action categories exercised in the gate (research, civic, orders,
movement, production, end turn). The click-through leak is accepted under the trusted-host model.
Popups other than the advisor's, diplomacy screens and mid-action disconnects are unverified and are
not claimed.
