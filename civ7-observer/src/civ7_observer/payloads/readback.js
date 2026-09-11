// Read-only post-action read-back for the bound player.
(() => {
  const t = (f) => { try { const v = f(); return v === undefined ? null : v; } catch (e) { return null; } };
  const player = t(() => Players.get(BOUND_PLAYER_ID));
  return JSON.stringify({
    turn: t(() => Game.turn), age: t(() => Game.age),
    gameGuid: t(() => { const g = Configuration.getGame(); return (typeof g.campaignSetupGUID === "string" && g.campaignSetupGUID) ? g.campaignSetupGUID : ((typeof g.gameGUIDHexString === "string" && g.gameGUIDHexString) ? g.gameGUIDHexString : null); }),
    localPlayerId: t(() => GameContext.localPlayerID), localObserverId: t(() => GameContext.localObserverID),
    isTurnActive: player ? t(() => player.isTurnActive) : null,
    techResearching: player ? t(() => player.Techs.getResearching().type) : null,
    civicResearching: player ? t(() => player.Culture.getResearching().type) : null,
    hasSentTurnComplete: t(() => GameContext.hasSentTurnComplete()),
    endTurnBlocking: t(() => { const v = Game.Notifications.getEndTurnBlockingType(BOUND_PLAYER_ID); for (const k of Object.keys(EndTurnBlockingTypes)) if (EndTurnBlockingTypes[k] === v) return k; return String(v); }),
    activeTraditions: player ? t(() => { const out = []; for (const k of ["TRADITION_CULTURE_SLOT", "POLICY_CULTURE_SLOT", "CRISIS_CULTURE_SLOT"]) { const st = CultureSlotTypes[k]; if (Number.isInteger(st)) for (const h of player.Culture.getActiveTraditions(st)) out.push(h); } return out; }) : null,
    unitsReadyToMove: player ? t(() => player.Units.getUnits().filter((u) => u.isReadyToMove === true).map((u) => u.id.id)) : null,
    cityProduction: player ? t(() => { const m = {}; for (const c of player.Cities.getCities()) { if (c && c.id && c.BuildQueue) m[String(c.id.id)] = c.BuildQueue.currentProductionTypeHash; } return m; }) : null,
    expandPlots: player ? t(() => { const m = {}; for (const c of player.Cities.getCities()) { if (c && c.id) { const r = Game.CityCommands.canStart(c.id, CityCommandTypes.EXPAND, {}, false); m[String(c.id.id)] = r && Array.isArray(r.Plots) ? r.Plots : []; } } return m; }) : null,
    cityLocations: player ? t(() => { const m = {}; for (const c of player.Cities.getCities()) { if (c && c.id && c.location) m[String(c.id.id)] = [c.location.x, c.location.y]; } return m; }) : null,
    unitLocations: player ? t(() => { const m = {}; for (const u of player.Units.getUnits()) { if (u && u.id && u.location) m[String(u.id.id)] = [u.location.x, u.location.y]; } return m; }) : null,
    curtainDisplayed: t(() => typeof document !== "undefined" ? document.getElementById("hotseat-screen-curtain") !== null : null)
  });
})()
