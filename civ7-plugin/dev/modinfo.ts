// The mod manifest, generated from the staged file list so a build can never ship a file the
// manifest does not declare (or declare one it does not ship).

export interface ModinfoInput {
  id: string;
  version: string;
  buildId: string;
  /** Files relative to the mod root, forward slashes. */
  files: string[];
  /** Scripts the game itself executes at realm start (module scripts). Everything else is imported
   *  as an asset and reachable by URL only. */
  uiScripts: string[];
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// The Mod element's `version` is the integer the game stores in Mods.Version and echoes in a game's
// enabled-mod list; every shipped mod uses "1". A semantic version like "0.0.1" parsed to 0 and the
// mod, though enabled, was left out of the game's applied actions (2026-09-18). The semantic version
// lives in Properties/Version only.
export function modinfo(input: ModinfoInput): string {
  const scripts = new Set(input.uiScripts);
  for (const s of scripts) {
    if (!input.files.includes(s)) throw new Error(`UIScripts entry not in staged files: ${s}`);
  }
  const imports = input.files.filter((f) => !scripts.has(f) && !f.endsWith(".modinfo") && f !== "build.json");
  const items = (xs: string[]) => xs.map((f) => `\t\t\t\t\t<Item>${esc(f)}</Item>`).join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<Mod id="${esc(input.id)}" version="1" xmlns="ModInfo">
\t<Properties>
\t\t<Name>Civ7 Agent (development)</Name>
\t\t<Description>Development build ${esc(input.buildId)}. Diagnostic bootstrap and reloadable service; no gameplay changes.</Description>
\t\t<Authors>civ7-plugin</Authors>
\t\t<Package>Mod</Package>
\t\t<AffectsSavedGames>0</AffectsSavedGames>
\t\t<Version>${esc(input.version)}</Version>
\t</Properties>
\t<Dependencies>
\t\t<Mod id="base-standard" title="LOC_MODULE_BASE_STANDARD_NAME" />
\t</Dependencies>
\t<ActionCriteria>
\t\t<Criteria id="always">
\t\t\t<AlwaysMet></AlwaysMet>
\t\t</Criteria>
\t</ActionCriteria>
\t<ActionGroups>
\t\t<ActionGroup id="game-${esc(input.id)}" scope="game" criteria="always">
\t\t\t<Actions>
\t\t\t\t<UIScripts>
${items([...scripts])}
\t\t\t\t</UIScripts>
\t\t\t\t<ImportFiles>
${items(imports)}
\t\t\t\t</ImportFiles>
\t\t\t</Actions>
\t\t</ActionGroup>
\t</ActionGroups>
</Mod>
`;
}
