# Development loop (Step 0 draft)

All Node/TypeScript. Run from `civ7-plugin/`. Nothing here is reachable by an agent; these are
host-only developer commands. `probe` and `activate` use the game's debugger as an investigation
aid and are not part of the accepted gameplay path.

```sh
npm install                      # once
npm test                         # offline checks (node --test)
npm run typecheck                # tsc --noEmit

node dev/cli.ts build [--marker X]   # transpile service/ → build/<buildId>/, stamp ids, generate the manifest
node dev/cli.ts stage [buildId]      # install a complete inactive build at My Games/…/Mods/civ7-agent-dev (previous kept as .prev)
node dev/cli.ts status               # builds, staged/previous, AppOptions flags, CDP reachability
node dev/cli.ts probe                # Civ7Agent.status() from the running game realm
node dev/cli.ts activate [buildId]   # ask the running bootstrap to dispose its service and load the staged one under a new module identity
node dev/cli.ts rollback             # stage the previous build again (code only; never game state)
```

Build ids are `<UTC stamp>-<git rev>-<marker>`. A build directory is complete and self-describing
(`build.json` lists every file with a digest); `stage` copies it whole, verifies the digests, and
swaps directories, so a loaded module graph never sees a half-copied build.

## First activation

The first time the mod exists, it has to be enabled in the game's Additional Content screen and a
game loaded; that is a save reload by nature. Same-match updates start from the second build.

## Manual steps that stay manual

- Enabling or disabling the mod (main menu → Additional Content → Mods).
- Restarting the game after an `AppOptions.txt` change (`UIFileWatcher`, `UIDebugger`).
- Saving a named checkpoint before an experiment that could disturb the match.

Change classes and the reload level each needs are recorded in `step-0-results.md` (DEV-09) as
they are measured.
