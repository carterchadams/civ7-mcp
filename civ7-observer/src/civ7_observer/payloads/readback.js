// Read-only post-action read-back for the bound player.
(() => {
  const t = (f) => { try { const v = f(); return v === undefined ? null : v; } catch (e) { return null; } };
  const player = t(() => Players.get(BOUND_PLAYER_ID));
  return JSON.stringify({
    turn: t(() => Game.turn), age: t(() => Game.age),
    localPlayerId: t(() => GameContext.localPlayerID), localObserverId: t(() => GameContext.localObserverID),
    isTurnActive: player ? t(() => player.isTurnActive) : null,
    techResearching: player ? t(() => player.Techs.getResearching().type) : null,
    civicResearching: player ? t(() => player.Culture.getResearching().type) : null,
    hasSentTurnComplete: t(() => GameContext.hasSentTurnComplete()),
    unitsReadyToMove: player ? t(() => player.Units.getUnits().filter((u) => u.isReadyToMove === true).map((u) => u.id.id)) : null,
    cityProduction: player ? t(() => { const m = {}; for (const c of player.Cities.getCities()) { if (c && c.id && c.BuildQueue) m[String(c.id.id)] = c.BuildQueue.currentProductionTypeHash; } return m; }) : null,
    unitLocations: player ? t(() => { const m = {}; for (const u of player.Units.getUnits()) { if (u && u.id && u.location) m[String(u.id.id)] = [u.location.x, u.location.y]; } return m; }) : null,
    curtainDisplayed: t(() => typeof document !== "undefined" ? document.getElementById("hotseat-screen-curtain") !== null : null)
  });
})()
