# Commanders, deployment and reinforcement

**Use when:** Use when transporting an army, assigning promotions, deploying packed units, coordinating reinforcements or protecting a Commander.

Needs to read: commanders, context, decisions, economy, map, military, rules. Needs to execute (only if enabled): commanders.deploy, commanders.pack, commanders.promote, commanders.reinforce, units.move. Rules: R-COMBAT, R-COMMAND.

## Required situation

Read each Commander’s position, health, guard/protection, capacity, packed roster, eligible packing/deployment targets, movement/action state, promotions and command effects. List reinforcements in transit separately from units available now. Use actual arrival information where exposed; do not turn an estimated route length into a guaranteed arrival turn.

## Procedure

1. Give the Commander an operational role: defend a frontier, lead an offensive group, transport reinforcements, support a City or organize a fleet. Select promotions that help this role now or remove a credible near-term constraint.
2. Before packing, account for what becomes unavailable on the map: defenders, vision, blocking positions and civilians. Do not pack away the only frontline unit protecting the Commander or a settlement unless a safe substitute exists.
3. Check capacity and the actual eligible roster. Preserve unit IDs and parent relationships; a packed child remains owned but cannot automatically act as an independent map unit.
4. Plan the destination and deployment before moving into danger. Inspect legal tiles, terrain, friendly occupancy, roles and movement consumption. Never assume deployment permits immediate attacks; query the actual post-deployment action state.
5. Deploy with protection and useful roles. Keep fragile damage/support assets out of the first threatened line, provide legal access for units that must capture, and keep an escape/reorganization option.
6. Use reinforcements as a scheduled pipeline. Record the intended recipient and arrival status. Do not budget a unit for two fronts or order repeated reinforcements because it disappeared from the map while travelling.
7. After deployment, combat or a Commander loss, refresh parent/child state before issuing another order. Do not infer that every packed unit survived, died, deployed or retained movement without reading the result.

## Promotion discipline

Read the real promotion effect and prerequisites. A mobility or deployment improvement may be more important for a transport role than another local combat modifier. A defensive/support choice may have significant economic value when the Commander is deliberately staying near an important settlement. Do not force every Commander into the same tree or assume the name of a promotion establishes its current effect.

This baseline deliberately does not teach movement-reset tricks or repeated packing loops. Even where an interaction is legal, first establish a reliable conventional deployment policy before adding complex optimization that is sensitive to game versions and timing.
