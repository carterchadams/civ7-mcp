# Runtime strategy update — exploration and Influence

The operating, turn-management, opening, reconnaissance, diplomacy, naval and Age
transition cards now emphasize active exploration, collectible discoveries and
productive tiles, explicit responses to hostile Independent Powers, and purposeful
Influence spending. The runner's top-level instruction permits a bounded review
of optional opportunities before ending the turn. Runtime-maintained markers keep
these direct edits from being overwritten by guide regeneration.

Advice uses observed connectivity and native Homeland/Distant Lands classification,
not assumptions about continents or ocean crossings. Exploration priorities are
route access, useful footholds, renewed Independent relations, eligible resource
generation/delivery, homeland protection and the actual enabled Age objectives.
Pangaea with islands motivates checking both land corridors and islands, but is not
a prerequisite or hard-coded strategy.

Mechanics were cross-checked against the official [diplomacy design diary](https://civilization.2k.com/civ-vii/archive/dev-diary/diplomacy-influence-trade/)
and [June 23, 2025 patch notes](https://support.civilization.com/hc/en-us/articles/42392187418643-Civilization-VII-Patch-Notes-June-23-2025).
The diary is archived and explicitly warns that mechanics have changed. The patch
notes changed Treasure generation requirements, so the cards ask for current native
eligibility instead of prescribing old coastal/Quay/Shipbuilding requirements.
No fixed Influence costs, treaty durations or Independent hostility radii are assumed.

The next Exploration capability checks are: disclosed region classification and
resource eligibility; treasure generation and delivery receipts; safe travel/access
previews; Independent attitude/project timing and Influence stock/flow; optional
decision discovery; and refreshed religion/science/military objectives after transition.
Skill text does not implement these queries or actions. If absent, the agent should
report the specific missing capability and continue only with supported choices.
