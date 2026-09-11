# Rules, identity and capability calibration

**Use when:** Use on attachment, save load, Age transition, game update or unfamiliar choice to establish which rules and tools actually apply.

Needs to read: context, decisions, rules. Rules: R-CIV, R-TRANSITION, R-VICTORY.

## Required situation

Obtain the session/save identity, assigned player, active seat, build/rules fingerprint, Age, speed, gameplay mods, enabled victory conditions, Triumph set, civilization variant, leader abilities and exposed capability list. A missing field must have an availability status, not an invented default. The initially selected leader is insufficient to determine every active ability.

## Procedure

1. Match the current observation to the host-assigned player. A wrong seat is a stop condition for private observation and actions; do not follow whoever is now local.
2. Classify the rules family. This pack’s default is Test of Time. An older save/build, altered victory rules or an unknown mod requires a scoped rules refresh. Do not pretend that selecting Classic Triumphs proves the old game is restored.
3. Build a short mechanical profile: economic bonuses, terrain dependencies, military advantages, special settlement constraints, available unique civics/infrastructure, relevant government effects and any enabled meta-progression. Only include mementos or unlocks actually present; a fresh installation may not expose a veteran setup.
4. Map semantic requirements in the selected skill to advertised tools. Distinguish a readable domain from a controllable one and a legal candidate catalog from a static definition list.
5. For an unfamiliar term, consult the player-safe definition catalog. Read effect, prerequisites, scope, costs and duration together. Never treat an evocative name such as “Scientific” as a complete effect specification.
6. Store the validated fingerprint and a compact profile. Invalidate affected caches on rules changes and all action/choice IDs at session boundaries. Re-read relevant abilities when continuing a civilization into another Age.

## Strategy consequence

Exploit a bonus only when the actual position can use it. A coastal advantage is not a reason to abandon an excellent inland start indefinitely; an unlocked unique unit is not an army until it can be funded and delivered. Prefer a setup-independent economy while evidence for a specialized plan is incomplete.

## Failure and degraded mode

When `rules` is unsupported, describe visible state and identify questions; do not issue an irreversible choice whose consequence depends on the missing definition. When only an optional subsystem is unavailable, continue other verified analysis. Unknown rules are not a reason to access raw JavaScript or another player’s state.
