# Tactical combat, retreat and settlement capture

**Use when:** Use for visible engagements, defensive repositioning, attack selection, healing, pillaging or capturing fortified settlements.

Needs to read: commanders, context, diplomacy, economy, map, military, rules. Needs to execute (only if enabled): settlements.capture_decision, units.attack, units.fortify, units.heal, units.move, units.pillage. Rules: R-COMBAT, R-COMMAND.

## Required situation

Read currently visible enemy entities, own health/action budgets, legal reachable destinations, attack targets, player-visible combat previews, terrain modifiers, command effects and relevant settlement defenses. Last-observed enemy units are risks, not current legal targets. Exact undisclosed enemies are not available for counterfactual simulation.

## Procedure

1. Identify the tactical objective: survive, remove a dangerous attacker, hold a corridor, open a path, reduce defenses, capture a settlement or disengage. A favorable damage trade that abandons the real objective can be a bad action.
2. Inspect threats at the intended **end position**, not only damage delivered. Include visible ranged reach, known movement restrictions, supporting units, retreat space and the risk from adjacent fog. Treat a combat preview as local information, not a prediction of the whole enemy turn.
3. Preserve fragile and valuable assets. Move a threatened civilian or Commander to safety before using other units in ways that block its route. Withdraw a badly damaged unit when retaining it is better than a low-value attack; query healing eligibility rather than assuming it can heal anywhere after moving.
4. Concentrate useful damage against a target that can actually be removed or neutralized. Spread attacks only for an explicit reason, such as preventing multiple imminent captures or improving a later legal sequence.
5. Re-read after every consequential attack or reveal. Health, target occupancy, access and legal next actions may change. Do not execute a long stale attack chain just because every attack was legal at the start.
6. During a siege, identify the remaining districts/fortifications and actual capture prerequisites. Use appropriate defense-damage roles while protecting the eventual capture capability. Do not sacrifice units repeatedly attacking a central tile that is not yet capturable.
7. After capture or a major breach, reconsider the operation. Protect the gain, resolve required settlement choices and account for stability/diplomacy before continuing.

## Sensible defaults

Prefer killing a dangerous exposed unit over inefficiently scratching a protected target, unless the objective requires the latter. Use terrain and limited approaches to concentrate defensive strength. Avoid pursuing a retreating unit through unknown terrain when doing so exposes the army or abandons a timed objective. Pillage only when the benefit and diplomatic/legal context justify it; do not destroy the economy of a settlement you intend to keep without considering the repair cost.

These are tactical heuristics, not a replacement combat simulator. Never assume a fixed damage formula, universal move-after-attack rule or guaranteed enemy behavior.
