# Developer probe expressions

These are the exact read-only expressions used to gather the rows in
`../runtime-contract.md` that `probe` (capabilities.js) does not sample itself.
They are **not packaged payloads**: they are never shipped, never exposed to a
model, and are excluded from the payload policy scan. Run one with:

```bash
.venv/bin/python - <<'PY'
import json, pathlib
from civ7_observer import cdp
expr = pathlib.Path("civ7-observer/docs/dev-probes/roster-detail.js").read_text()
with cdp.CdpSession("ws://127.0.0.1:9444/json/devtools/page/0", timeout=15) as s:
    print(json.dumps(json.loads(s.evaluate_readonly(expr)), indent=1))
PY
```

All of them key player reads by `GameContext.localPlayerID` (the active seat).
The cross-seat omniscience check recorded in the contract was a one-off
`GameplayMap.getRevealedState(<other id>, x, y)` count from the non-active seat;
it is deliberately not kept as a file.

| file | contract rows it produced |
|---|---|
| `roster-detail.js` | every unit (embarkation, damage, army), node→tree mapping, mastery depth, build-queue entry shape, city yields |
| `progression-and-tiles.js` | `getNode`/`getNodeState` shapes, `getNodeCost`, `getTurnsLeft`, available trees, tile readers, adjacency, index round-trip, city component method names |
| `enums.js` | live enum values (`ProgressionTreeNodeState`, `RevealedStates`, `DirectionTypes`, `PlayerIds`) |
