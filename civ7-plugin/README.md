# civ7-plugin (v2, Step 0: in progress)

The next architecture: an ordinary Civilization VII mod that owns native reads, legal choices,
action execution and the hotseat agent curtain, plus a thin local Node bridge that exposes standard
MCP to external clients. Gameplay should work with the game's debugger disabled, which
`civ7-observer` (v1) depends on. Everything here is Node/TypeScript; v1 is a reference for native
contracts and lessons only, never called at runtime.

**Status:** Step 0 proves the development loop before any gameplay is ported. The results so far,
each with its recorded command and observation, are in [docs/step-0-results.md](docs/step-0-results.md):

- An ordinary local UI mod loads, and it is adopted by an existing save.
- Hot replacement of the mod's own service works without a UI reload: 20/20 alternating build
  cycles, about 0.7 s per activation, with exactly one copy of everything the service owns after
  every cycle.
- A full `UI.reloadUI()` takes about 1 s and preserves seat and turn, in hotseat too.
- **The planned transport failed.** `WebSocket` exists in the game's UI realm but is a host stub:
  sockets never connect, and opening several at once crashed the game. Loopback HTTP is not
  implemented either. The channels that do cross the process boundary are file-based (inbound
  `fs://` reads of files the companion writes, outbound `Automation.log`/`localStorage`), and choosing
  a replacement transport is the open decision before Step 1.

## Layout

| path | contents |
|---|---|
| `mod/ui/bootstrap.js` | the mod's entry script: loads a versioned service build and swaps it on request |
| `service/` | the in-game service (TypeScript, transpiled per build) |
| `bridge/` | loopback peers used by the transport experiments |
| `dev/` | host-only developer commands: build, stage, status, probe, activate, rollback |
| `tests/` | offline checks (`node --test`) |
| `docs/` | the development loop and the Step 0 experiment ledger, with traces |

## Commands

```sh
npm install
npm test             # offline checks
npm run typecheck    # tsc --noEmit
node dev/cli.ts status
```

See [docs/development-loop.md](docs/development-loop.md) for the full build, stage and activate loop.
Node 22.18 or newer runs the `.ts` files directly.
