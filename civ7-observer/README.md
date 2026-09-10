# civ7-observer

Read-only local observer for **one** Civilization VII player, reached through the
game's Cohtml UI debugger (Chrome DevTools Protocol on `127.0.0.1:9444`).

This is Change 1 of `plans/civ7-local-observer-poc-plan.md`: the **connection
doctor** only. `probe`, `snapshot` and `serve` are registered but not implemented.

## Install (Linux, this repo)

```bash
python3 -m venv .venv
.venv/bin/pip install -e 'civ7-observer[test]'
```

No `uv`, `pipx`, Node packages, or model API keys are required. Node 22 is used only
to run the JavaScript payload tests.

## Enable the game's UI debugger (once, game closed)

The game reads `AppOptions.txt` from its data directory, which is only created after
the first launch. On this machine (snap Steam, native Linux build) find it with:

```bash
find ~/snap/steam -type f -name AppOptions.txt
```

Back the file up, then set:

```text
UIDebugger 1
```

`EnableTuner` is not needed. Disable the option again when you are done experimenting.
Keep the port on loopback; never forward it.

## Run the doctor

```bash
.venv/bin/python -m civ7_observer doctor          # human-readable
.venv/bin/python -m civ7_observer doctor --json   # machine-readable, exit 0 only when IN_GAME
```

| status | meaning |
|---|---|
| `IN_GAME` | exactly one realm reports `UI.isInGame()` true with `Players`/`GameplayMap`; turn and local player ids are printed |
| `NOT_IN_GAME` | game UI reachable but at the main menu / loading |
| `AMBIGUOUS_GAME_TARGET` | two or more in-game realms answered; re-run with `--target-id <id>` |
| `NO_GAME_TARGET` | debugger answered but nothing is a game UI realm |
| `DEBUGGER_UNAVAILABLE` | nothing listening on `127.0.0.1:9444` (game closed, or `UIDebugger` not enabled) |
| `DISCOVERY_INVALID` | port answered but not with a CDP target list |
| `TARGET_PROBE_FAILED` | targets exist but every connection failed (another debugger client attached?) |
| `API_CONTRACT_MISMATCH` | a realm answered but the context probe's contract did not hold |

`doctor` sends one fixed, packaged, read-only expression (`payloads/context.js`) to
each target and classifies the realm by what it exposes. It never accepts JavaScript
from the command line or from a model.

## Tests

```bash
civ7-observer/run-tests.sh      # runs pytest and the Node payload tests together
```

Or separately: `.venv/bin/python -m pytest civ7-observer/tests -q` and
`node --test civ7-observer/tests/test_payload.mjs`.

The Python suite runs a fake Cohtml debugger (HTTP `/json` plus a minimal RFC 6455
server) on an ephemeral port; no game installation is needed.

## Seat-binding rule (enforced by tests)

Live hotseat testing showed the game's debug API is omniscient: from one seat it will
report any other player's fog, units, and turn state on request. The game does not
protect the other seat; this package must.

- Every packaged payload may only reference the bound player through the literal
  `BOUND_PLAYER_ID`, which the Python side substitutes before evaluation.
- `tests/test_payload_policy.py` scans every file in `payloads/` and fails on any
  `Players.get(...)` with another argument, any roster list such as `humanPlayerIDs`,
  any `getRevealedState` not keyed by `BOUND_PLAYER_ID`, seeds, resources, mutators,
  timers, imports, or network calls.
- Before any capture, the bound id must equal both `GameContext.localPlayerID` and
  `GameContext.localObserverID`; otherwise the capture is refused.

Keep the debugger port on this machine. On this build it listens on `0.0.0.0:9444`, so
block inbound access from other hosts, for example with `ufw deny 9444/tcp`, before
playing on a shared network.
