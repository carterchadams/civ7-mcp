// Read-only enumeration of the bound player's legal choices for the supported action kinds.
// Uses the native canStart query exactly as the shipped choosers do (hover path). Never mutates.
(() => {
  const ALLOWED = ALLOWED_MODE;
  const result = { payloadVersion: 1, refused: null, context: null, offers: null };
  const refuse = (code, message) => { result.refused = { code: code, message: message }; return JSON.stringify(result); };
  const isInt = (v) => typeof v === "number" && Number.isInteger(v);
  const isBool = (v) => typeof v === "boolean";
  const lookupKey = (table, hash, field) => {
    if (!isInt(hash) || hash === -1) return null;
    const row = table && typeof table.lookup === "function" ? table.lookup(hash) : null;
    return row && typeof row[field] === "string" ? row[field] : null;
  };
  const compose = (key) => { if (typeof key !== "string") return null; try { const s = Locale.compose(key); return typeof s === "string" ? s : key; } catch (e) { return key; } };
  const curtain = () => { try { return typeof document !== "undefined" ? document.getElementById("hotseat-screen-curtain") !== null : null; } catch (e) { return null; } };

  // ---- guards (same as observe.js)
  let turn, age, lp, lo, flags, inGame;
  try { inGame = typeof UI !== "undefined" && typeof UI.isInGame === "function" ? UI.isInGame() : undefined; turn = Game.turn; age = Game.age; lp = GameContext.localPlayerID; lo = GameContext.localObserverID; flags = Configuration.getGame(); }
  catch (e) { return refuse("NOT_IN_GAME", "game context unavailable"); }
  if (inGame !== true) return refuse("NOT_IN_GAME", "UI.isInGame() is not true");
  if (!isInt(turn) || !isInt(age) || !isInt(lp) || !isInt(lo)) return refuse("NOT_IN_GAME", "turn, age or seat identity missing");
  if (lp !== BOUND_PLAYER_ID || lo !== BOUND_PLAYER_ID) return refuse("WRONG_PLAYER", "bound player " + BOUND_PLAYER_ID + " is not the local seat (localPlayerId=" + lp + ", localObserverId=" + lo + ")");
  for (const k of ["isHotseat", "isLocalMultiplayer", "isNetworkMultiplayer", "isInternetMultiplayer", "isLANMultiplayer", "isAnyMultiplayer", "isPlayByCloud"]) {
    if (!isBool(flags[k])) return refuse("UNSUPPORTED_GAME_MODE", "game mode flag " + k + " is not a boolean");
  }
  const networked = flags.isNetworkMultiplayer || flags.isInternetMultiplayer || flags.isLANMultiplayer || flags.isPlayByCloud;
  const mode = (!flags.isAnyMultiplayer && !networked) ? "singleplayer" : (flags.isHotseat && flags.isLocalMultiplayer && !networked) ? "local-hotseat" : "unsupported";
  if (mode !== ALLOWED) return refuse("UNSUPPORTED_GAME_MODE", "game is " + mode + " but the service allows only " + ALLOWED);
  let player; try { player = Players.get(BOUND_PLAYER_ID); } catch (e) { player = null; }
  if (!player || player.isValid === false) return refuse("WRONG_PLAYER", "bound player object is invalid");
  if (player.isTurnActive !== true) return refuse("TURN_NOT_READY", "bound player's turn is not active");
  result.context = { turn: turn, age: age, playerId: BOUND_PLAYER_ID, localPlayerId: lp, localObserverId: lo, mode: mode, isTurnActive: true, curtainDisplayed: curtain() };

  // ---- offers
  const offers = [];
  try {
    const kinds = [["SET_TECH_TREE_NODE", player.Techs], ["SET_CULTURE_TREE_NODE", player.Culture]];
    for (const [kind, comp] of kinds) {
      if (!comp || typeof comp.getAllAvailableNodeTypes !== "function") throw new Error(kind + " component unavailable");
      const opType = PlayerOperationTypes[kind];
      if (!isInt(opType)) throw new Error("PlayerOperationTypes." + kind + " missing");
      const avail = comp.getAllAvailableNodeTypes();
      if (!Array.isArray(avail)) throw new Error(kind + " getAllAvailableNodeTypes() is not an array");
      for (const hash of avail) {
        if (!isInt(hash)) throw new Error(kind + " node hash is not an integer");
        const row = GameInfo.ProgressionTreeNodes.lookup(hash);
        const check = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, opType, { ProgressionTreeNodeType: hash }, false);
        offers.push({
          kind: kind, arg: hash,
          typeKey: row && typeof row.ProgressionTreeNodeType === "string" ? row.ProgressionTreeNodeType : null,
          displayName: row && typeof row.Name === "string" ? compose(row.Name) : null,
          tree: row && typeof row.ProgressionTree === "string" ? row.ProgressionTree : null,
          cost: comp.getNodeCost(hash), turns: comp.getTurnsForNode(hash),
          canStart: !!(check && check.Success === true)
        });
      }
    }
    if (typeof UnitOperationTypes !== "undefined" && isInt(UnitOperationTypes.SKIP_TURN)) {
      const units = player.Units.getUnits();
      if (!Array.isArray(units)) throw new Error("getUnits() is not an array");
      for (const u of units) {
        if (!u || !u.id || !isInt(u.id.id) || u.id.owner !== BOUND_PLAYER_ID) continue;
        const unitId = u.id;
        const check = Game.UnitOperations.canStart(unitId, UnitOperationTypes.SKIP_TURN, {}, false);
        offers.push({ kind: "SKIP_UNIT", arg: u.id.id, unitTypeKey: lookupKey(GameInfo.Units, u.type, "UnitType"),
          movesRemaining: u.Movement && isInt(u.Movement.movementMovesRemaining) ? u.Movement.movementMovesRemaining : null,
          location: u.location && isInt(u.location.x) && isInt(u.location.y) && u.location.x >= 0 ? { x: u.location.x, y: u.location.y } : null,
          canStart: !!(check && check.Success === true) });
      }
    }
    if (typeof UnitOperationTypes !== "undefined" && isInt(UnitOperationTypes.MOVE_TO) && typeof RevealedStates !== "undefined" && isInt(RevealedStates.HIDDEN)) {
      for (const u of player.Units.getUnits()) {
        if (!u || !u.id || !isInt(u.id.id) || u.id.owner !== BOUND_PLAYER_ID) continue;
        if (u.isOnMap !== true || !u.location || !isInt(u.location.x) || u.location.x < 0) continue;
        if (!u.Movement || !isInt(u.Movement.movementMovesRemaining) || u.Movement.movementMovesRemaining <= 0) continue;
        const unitId = u.id;
        for (let d = 0; d < 6; d++) {
          const loc = GameplayMap.getAdjacentPlotLocation(u.location, d);
          if (!loc || !isInt(loc.x) || !isInt(loc.y) || loc.x < 0 || loc.y < 0) continue;
          const state = GameplayMap.getRevealedState(BOUND_PLAYER_ID, loc.x, loc.y);
          if (!isInt(state) || state === RevealedStates.HIDDEN) continue;   // never offer unknown land
          // canStart(MOVE_TO) does not validate the destination (live: it accepted an impassable
          // mountain that the engine then silently dropped). The shipped path preview does.
          const path = Units.getPathTo(unitId, { x: loc.x, y: loc.y });
          const plots = path && Array.isArray(path.plots) ? path.plots : [];
          const turns = path && Array.isArray(path.turns) ? path.turns : [];
          if (plots.length === 0 || turns.length === 0 || turns[turns.length - 1] !== 1) continue;   // unreachable this turn
          const moveArgs = { X: loc.x, Y: loc.y, Modifiers: 0 };
          const check = Game.UnitOperations.canStart(unitId, UnitOperationTypes.MOVE_TO, moveArgs, false);
          offers.push({ kind: "MOVE_UNIT", arg: u.id.id, x: loc.x, y: loc.y, direction: d, unitTypeKey: lookupKey(GameInfo.Units, u.type, "UnitType"),
            terrainKey: lookupKey(GameInfo.Terrains, GameplayMap.getTerrainType(loc.x, loc.y), "TerrainType"), pathTurns: turns[turns.length - 1],
            movesRemaining: u.Movement.movementMovesRemaining, canStart: !!(check && check.Success === true) });
        }
      }
    }
    if (typeof CityOperationTypes !== "undefined" && isInt(CityOperationTypes.BUILD)) {
      const cities = player.Cities.getCities();
      if (!Array.isArray(cities)) throw new Error("getCities() is not an array");
      for (const c of cities) {
        if (!c || !c.id || !isInt(c.id.id) || c.id.owner !== BOUND_PLAYER_ID) continue;
        const cityId = c.id;
        for (const row of GameInfo.Units) {
          if (!row || !isInt(row.$hash) || typeof row.UnitType !== "string") continue;
          const buildArgs = { UnitType: row.$hash };
          const check = Game.CityOperations.canStart(cityId, CityOperationTypes.BUILD, buildArgs, false);
          if (!check || check.Success !== true) continue;   // only buildable units are offered
          offers.push({ kind: "PRODUCE_UNIT", arg: c.id.id, arg2: row.$hash, cityId: c.id.id, cityName: typeof c.name === "string" ? c.name : null,
            unitTypeKey: row.UnitType, displayName: typeof row.Name === "string" ? compose(row.Name) : null, canStart: true });
        }
      }
    }
    const blockingType = Game.Notifications.getEndTurnBlockingType(BOUND_PLAYER_ID);
    const none = typeof EndTurnBlockingTypes !== "undefined" ? EndTurnBlockingTypes.NONE : null;
    const blockerName = (v) => { for (const k of Object.keys(EndTurnBlockingTypes)) if (EndTurnBlockingTypes[k] === v) return k; return String(v); };
    if (!isInt(blockingType) || !isInt(none)) throw new Error("end-turn blocking contract unavailable");
    const blocked = blockingType !== none;
    const alreadySent = GameContext.hasSentTurnComplete() === true;
    offers.push({ kind: "END_TURN", arg: 0, canStart: !blocked && !alreadySent, blockingType: blocked ? blockerName(blockingType) : null, alreadySent: alreadySent });
  } catch (e) {
    return refuse("API_CONTRACT_MISMATCH", "offer enumeration failed: " + String(e && e.message ? e.message : e).slice(0, 160));
  }
  result.offers = offers;
  return JSON.stringify(result);
})()
