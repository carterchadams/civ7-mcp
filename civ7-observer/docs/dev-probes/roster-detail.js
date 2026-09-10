// Developer-only. Read-only. Not a packaged payload. Keyed by the active seat only.
(() => {
  const pid = GameContext.localPlayerID; const p = Players.get(pid);
  const t = (f) => { try { const v = f(); return v === undefined ? "undefined" : v; } catch (e) { return "THROWS:" + String(e).slice(0, 120); } };
  const units = p.Units.getUnits().map(u => ({ id: u.id, type: GameInfo.Units.lookup(u.type)?.UnitType, name: u.name, loc: u.location, isOnMap: u.isOnMap, isEmbarked: u.isEmbarked, embarkationType: t(() => u.embarkationType), isDead: u.isDead, isValid: u.isValid, hasMovement: !!u.Movement, moves: u.Movement ? [u.Movement.movementMovesRemaining, u.Movement.maxMoves] : null, health: u.Health ? [u.Health.damage, u.Health.maxDamage] : null, isCommanderUnit: u.isCommanderUnit, armyId: u.armyId, isBusy: t(() => u.isBusy), sightRange: t(() => u.sightRange) }));
  const cities = p.Cities.getCities().map(c => ({ id: c.id, name: Locale.compose(c.name), loc: c.location, isTown: c.isTown, isCapital: c.isCapital, pop: c.population, rural: c.ruralPopulation, urban: c.urbanPopulation, pending: c.pendingPopulation, producing: t(() => c.BuildQueue.currentProductionTypeHash), isEmpty: t(() => c.BuildQueue.isEmpty), queue: t(() => c.BuildQueue.getQueue()), percent: t(() => c.BuildQueue.getPercentComplete()), foodNet: t(() => c.Yields.getNetYield(0)) }));
  const nodeInfo = (n) => { const d = GameInfo.ProgressionTreeNodes.lookup(n.type); return { type: d?.ProgressionTreeNodeType ?? n.type, tree: d?.ProgressionTree ?? null, cost: d?.Cost ?? null, record: n, node: t(() => Game.ProgressionTrees.getNode(pid, n.type)) }; };
  return JSON.stringify({
    turn: Game.turn, seat: [pid, GameContext.localObserverID, p.isTurnActive],
    units, cities, capitalId: t(() => p.Cities.getCapital()?.id),
    techs: { researching: nodeInfo(p.Techs.getResearching()), researched: p.Techs.getResearched().map(nodeInfo), target: p.Techs.getTargetNode(), turnsLeft: p.Techs.getTurnsLeft(), tree: GameInfo.ProgressionTrees.lookup(p.Techs.getTreeType())?.ProgressionTreeType },
    civics: { researching: nodeInfo(p.Culture.getResearching()), researched: p.Culture.getResearched().map(nodeInfo), target: p.Culture.getTargetNode(), turnsLeft: p.Culture.getTurnsLeft(), activeTree: GameInfo.ProgressionTrees.lookup(p.Culture.getActiveTree())?.ProgressionTreeType, availableTrees: p.Culture.getAvailableTrees().map(h => GameInfo.ProgressionTrees.lookup(h)?.ProgressionTreeType ?? h) },
    yieldTypes: (() => { const r = []; for (const y of GameInfo.Yields) r.push(y.YieldType); return r; })()
  });
})()
