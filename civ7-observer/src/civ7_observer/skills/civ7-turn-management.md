# Turn management and commitment execution
<!-- Runtime-maintained: edit this card directly; build_skills.py preserves it. -->

**Use when:** Use at every playable turn and after a major state change to resolve blockers, preserve priorities and verify completed actions.

Needs to read: context, decisions, economy, memory, military, victory. Needs to execute (only if enabled): actions.end_turn, actions.resolve_decision. Rules: R-VICTORY.

## Required situation

Read alerts, mandatory choices, changes, deadlines and commitments. Available actions are not all mandatory; a new observation ID is not an action receipt.

## Procedure

1. Triage imminent loss and genuine deadlines. A visible attack arriving now or a near-complete rival victory outranks a routine economic improvement.
2. Review each existing commitment: completed, still useful, blocked, superseded or invalid. Advance it or explicitly cancel it. Do not keep writing the same intended research, settlement or reinforcement into successive plans without executing it.
3. Choose up to three primary commitments for the present planning horizon. Record concrete next steps and reserve only the resources those steps need. This is an attention-management heuristic, not a limit imposed by Civ.
4. Inspect the real dependency graph. Resolve forced choices at the point required. Reconsider subsequent options when an unlock, conversion, scouting move, policy or resource change affects them.
5. Execute a bounded action, obtain its outcome and update the plan. On a stale-choice rejection refresh the relevant context; on an ambiguous submission ask for reconciliation rather than resubmitting.
6. At the close of the turn, inspect remaining production/research/growth and response blockers, vulnerable assets, available promotions, relevant idle units and unassigned economic assets. Idling is allowed when intentional: guarding a passage is different from forgetting an army.
7. Recheck the victory/deadline envelope and turn readiness. End through the authorized host operation, then stop until the same assigned seat becomes playable again.

## Decision discipline

Prefer explicit “do X until Y, unless Z” commitments. Examples: defend the northern pass until two reinforcements arrive; fund a city conversion after an emergency purchase reserve is met; investigate one coastline until a viable port connection is established. Avoid unrelated micro-actions that spend the funds reserved for these plans.

Change city roles only when threats, prerequisites, payoff or deadlines change; record the trigger.

## Failure and degraded mode

If mandatory choices cannot be enumerated, use the native end-turn readiness result only as a final guard, not as a complete strategic checklist. An unsupported mandatory screen requires human/host resolution. In observer mode, return the triage and intended sequence without claiming any progress.

## Opportunities before end turn

Check scouting/rewards, Independent threats and useful Influence projects once before ending. Skip with a reason; do not churn queues. Keep a concrete exploration, Independent or resource-route objective among useful commitments, with a target, next step and review trigger. Reassess Influence after contact, raids or project completion. Verify rewards and progress; issued orders are not completed objectives.
