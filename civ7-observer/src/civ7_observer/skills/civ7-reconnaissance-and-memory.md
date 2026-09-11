# Reconnaissance, uncertainty and map memory

**Use when:** Use when exploring, updating enemy sightings, choosing safe routes or deciding which missing information is worth obtaining.

Needs to read: context, map, memory, military, rules. Needs to execute (only if enabled): units.move, units.scout_action. Rules: R-GEOGRAPHY.

## Required situation

Read visible tiles and entities with coverage flags, known terrain from previous legitimate observations, unit movement options, discovered points of interest and known borders. Keep `last_seen_turn` and confidence separate from location. A foreign unit can disappear from vision without being destroyed.

## Procedure

1. Give each scout an information objective: reveal a nearby settlement corridor, locate a defensible approach, check a suspected coast, establish safe merchant access, or watch a threatened border. A random wandering path is not a plan.
2. Prefer routes that answer a useful near-term question while leaving the unit a defensible endpoint. Consider movement cost, visible enemies, retreat choices and the value of another turn of vision. A high-visibility position is helpful only when the scout can survive there.
3. Explore around the home economy before committing every scout to distant travel. Settlers need nearby site information and the empire needs warning of approaches. Broader exploration becomes more valuable when local decisions are already well informed.
4. For a path through fog, separate known traversable segments from uncertain segments. Advance in shorter steps when a newly exposed enemy could change the plan. A pathfinder route is not a safety guarantee.
5. Update memory only with allowed observations. Preserve old facts as dated records, invalidate contradicted sightings, and avoid treating a stale enemy position as a current attack target.
6. Maintain deliberate observation on a dangerous front. Revisit a previously safe route before sending a valuable civilian if enough time has passed for the situation to change.

## Valuing information

Choose scouting that can change a pending decision. Revealing the second ring around a candidate settlement can be more useful than discovering an unrelated coastline. Conversely, once good settlement sites are known, search for new contacts, trade access or victory-relevant geography rather than endlessly polishing the same local map.

Count safe opportunities as well as danger. Do not make a civilian wait forever for proof that every unknown tile is enemy-free; use escort, staged movement and a bounded risk judgment. Label that judgment rather than presenting it as certainty.

## Failure and degraded mode

If foreign entities are omitted, do not recommend attacks or call a route safe. Explain that tactical reconnaissance is incomplete. If persistent map memory is unavailable, limit the report to fresh vision and explicitly lose historical detail rather than silently reconstructing hidden terrain. Do not query hidden tiles as an oracle.
