// Developer-only. Read-only. Not a packaged payload. Keyed by the active seat only.
(() => {
  const pid = GameContext.localPlayerID, p = Players.get(pid);
  const t = (f) => { try { const v = f(); return v === undefined ? "undefined" : v; } catch (e) { return "THROWS:" + String(e).slice(0, 100); } };
  const names = (o) => Object.getOwnPropertyNames(Object.getPrototypeOf(o)).filter(k => k !== "constructor");
  const cur = p.Techs.getResearching();
  const u = p.Units.getUnits()[0];
  const c = p.Cities.getCities()[0];
  return JSON.stringify({
    techCurrent: cur,
    techCurrentNode: t(() => cur.type === -1 ? null : Game.ProgressionTrees.getNode(pid, cur.type)),
    techCurrentState: t(() => Game.ProgressionTrees.getNodeState(pid, cur.type)),
    techCurrentCost: t(() => p.Techs.getNodeCost(cur.type)),
    techTurnsLeft: t(() => p.Techs.getTurnsLeft()),
    techDepthsRemaining: t(() => cur.type === -1 ? null : p.Techs.getNodeUnlockDepthsRemaining(cur.type)),
    civicCurrent: p.Culture.getResearching(),
    civicCurrentNode: t(() => Game.ProgressionTrees.getNode(pid, p.Culture.getResearching().type)),
    civicCost: t(() => p.Culture.getNodeCost(p.Culture.getResearching().type)),
    civicTurnsLeft: t(() => p.Culture.getTurnsLeft()),
    civicAvailableTrees: t(() => p.Culture.getAvailableTrees().map(h => GameInfo.ProgressionTrees.lookup(h)?.ProgressionTreeType ?? h)),
    progressionTreeMethods: names(Game.ProgressionTrees),
    unitHealth: t(() => ({ damage: u.Health.damage, maxDamage: u.Health.maxDamage })),
    unitCombatMethods: t(() => names(u.Combat)),
    adjacency: t(() => [0, 1, 2, 3, 4, 5].map(d => GameplayMap.getAdjacentPlotLocation(u.location, d))),
    adjacencyByXY: t(() => GameplayMap.getAdjacentPlotLocation(u.location.x, u.location.y, 0)),
    plotIndex: t(() => ({ idx: GameplayMap.getIndexFromXY(u.location.x, u.location.y), back: GameplayMap.getLocationFromIndex(GameplayMap.getIndexFromXY(u.location.x, u.location.y)) })),
    tileSample: t(() => { const { x, y } = u.location; if (GameplayMap.getRevealedState(pid, x, y) !== RevealedStates.VISIBLE) return "not visible"; return { terrain: GameInfo.Terrains.lookup(GameplayMap.getTerrainType(x, y))?.TerrainType, biome: GameInfo.Biomes.lookup(GameplayMap.getBiomeType(x, y))?.BiomeType, feature: GameplayMap.getFeatureType(x, y), elevation: GameplayMap.getElevation(x, y), isRiver: GameplayMap.isRiver(x, y), riverType: GameplayMap.getRiverType(x, y), navigable: GameplayMap.isNavigableRiver(x, y) }; }),
    cityBuildQueueMethods: t(() => names(c.BuildQueue)),
    cityGrowthMethods: t(() => names(c.Growth)),
    cityYieldMethods: t(() => names(c.Yields))
  });
})()
