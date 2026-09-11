// THE ONLY MUTATION PAYLOAD. Executes one pre-validated operation for the bound player.
// Tokens substituted by the trusted host: BOUND_PLAYER_ID, ALLOWED_MODE, OP_KIND (a JSON string
// from a fixed enum), OP_ARG (an integer), EXPECTED_TURN, EXPECTED_AGE. No other input reaches it.
// Guards run first; the native canStart query runs immediately before sendRequest; nothing is
// retried here. tests/test_payload_policy.py holds this file to an exact engine-call allowlist.
(() => {
  const ALLOWED = ALLOWED_MODE;
  const KIND = OP_KIND;
  const ARG = OP_ARG;
  const ARG2 = OP_ARG2;
  const ARG3 = OP_ARG3;
  const EXPECTED_MATCH = EXPECTED_GUID;
  const PRE = OP_PRE;
  const result = { payloadVersion: 1, refused: null, context: null, outcome: null, readback: null };
  const refuse = (code, message, extra) => { result.refused = Object.assign({ code: code, message: message }, extra || {}); return JSON.stringify(result); };
  const isInt = (v) => typeof v === "number" && Number.isInteger(v);
  const isBool = (v) => typeof v === "boolean";
  const curtain = () => { try { return typeof document !== "undefined" ? document.getElementById("hotseat-screen-curtain") !== null : null; } catch (e) { return null; } };

  // ---- guards (same as observe.js) plus the expected-context check
  let turn, age, lp, lo, flags, inGame;
  try { inGame = typeof UI !== "undefined" && typeof UI.isInGame === "function" ? UI.isInGame() : undefined; turn = Game.turn; age = Game.age; lp = GameContext.localPlayerID; lo = GameContext.localObserverID; flags = Configuration.getGame(); }
  catch (e) { return refuse("NOT_IN_GAME", "game context unavailable"); }
  if (inGame !== true) return refuse("NOT_IN_GAME", "UI.isInGame() is not true");
  if (!isInt(turn) || !isInt(age) || !isInt(lp) || !isInt(lo)) return refuse("NOT_IN_GAME", "turn, age or seat identity missing");
  if (lp !== BOUND_PLAYER_ID || lo !== BOUND_PLAYER_ID) return refuse("WRONG_PLAYER", "bound player " + BOUND_PLAYER_ID + " is not the local seat (localPlayerId=" + lp + ", localObserverId=" + lo + ")");
  if (turn !== EXPECTED_TURN || age !== EXPECTED_AGE) return refuse("ACTION_EXPIRED", "game turn/age differ from the offer's (turn " + turn + ", expected " + EXPECTED_TURN + ")");
  const matchId = (typeof flags.campaignSetupGUID === "string" && flags.campaignSetupGUID) ? flags.campaignSetupGUID : ((typeof flags.gameGUIDHexString === "string" && flags.gameGUIDHexString) ? flags.gameGUIDHexString : null);
  if (matchId === null || matchId !== EXPECTED_MATCH) return refuse("ACTION_EXPIRED", "the offer belongs to a different match");
  for (const k of ["isHotseat", "isLocalMultiplayer", "isNetworkMultiplayer", "isInternetMultiplayer", "isLANMultiplayer", "isAnyMultiplayer", "isPlayByCloud"]) {
    if (!isBool(flags[k])) return refuse("UNSUPPORTED_GAME_MODE", "game mode flag " + k + " is not a boolean");
  }
  const networked = flags.isNetworkMultiplayer || flags.isInternetMultiplayer || flags.isLANMultiplayer || flags.isPlayByCloud;
  const mode = (!flags.isAnyMultiplayer && !networked) ? "singleplayer" : (flags.isHotseat && flags.isLocalMultiplayer && !networked) ? "local-hotseat" : "unsupported";
  if (mode !== ALLOWED) return refuse("UNSUPPORTED_GAME_MODE", "game is " + mode + " but the service allows only " + ALLOWED);
  let player; try { player = Players.get(BOUND_PLAYER_ID); } catch (e) { player = null; }
  if (!player || player.isValid === false) return refuse("WRONG_PLAYER", "bound player object is invalid");
  if (player.isTurnActive !== true) return refuse("TURN_NOT_READY", "bound player's turn is not active");
  result.context = { turn: turn, age: age, playerId: BOUND_PLAYER_ID, localPlayerId: lp, localObserverId: lo, mode: mode, isTurnActive: true, curtainDisplayed: curtain(), gameGuid: matchId };

  // ---- execute exactly one operation; every kind re-checks the state the offer was made against
  if (KIND === "END_TURN") {
    const blockingType = Game.Notifications.getEndTurnBlockingType(BOUND_PLAYER_ID);
    const none = typeof EndTurnBlockingTypes !== "undefined" ? EndTurnBlockingTypes.NONE : null;
    const blockerName = (v) => { for (const k of Object.keys(EndTurnBlockingTypes)) if (EndTurnBlockingTypes[k] === v) return k; return String(v); };
    if (!isInt(blockingType) || !isInt(none)) return refuse("API_CONTRACT_MISMATCH", "end-turn blocking contract unavailable");
    if (blockingType !== none) return refuse("ACTION_BLOCKED", "a notification blocks ending the turn", { blockingType: blockerName(blockingType) });
    if (GameContext.hasSentTurnComplete() === true) return refuse("ACTION_BLOCKED", "turn completion was already sent", { blockingType: null });
    GameContext.sendTurnComplete();
    result.outcome = "sent";
    result.readback = { kind: KIND, arg: 0, sentComplete: GameContext.hasSentTurnComplete() === true };
    return JSON.stringify(result);
  }
  if (KIND === "SKIP_UNIT") {
    if (!isInt(ARG)) return refuse("UNKNOWN_ACTION", "unit id is not an integer");
    if (typeof UnitOperationTypes === "undefined" || !isInt(UnitOperationTypes.SKIP_TURN)) return refuse("API_CONTRACT_MISMATCH", "UnitOperationTypes.SKIP_TURN unavailable");
    let unit = null;
    try { for (const u of player.Units.getUnits()) { if (u && u.id && u.id.id === ARG && u.id.owner === BOUND_PLAYER_ID) { unit = u; break; } } } catch (e) { unit = null; }
    if (!unit) return refuse("UNKNOWN_ACTION", "unit is not in the bound player's roster");
    if (!unit.Movement || unit.Movement.movementMovesRemaining !== PRE) return refuse("ACTION_EXPIRED", "unit movement changed since the skip was offered");
    const unitId = unit.id;
    const ucheck = Game.UnitOperations.canStart(unitId, UnitOperationTypes.SKIP_TURN, {}, false);
    if (!ucheck || ucheck.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused the skip");
    Game.UnitOperations.sendRequest(unitId, UnitOperationTypes.SKIP_TURN, {});
    result.outcome = "sent";
    const ready = unit.isReadyToMove === true;
    result.readback = { kind: KIND, arg: ARG, isReadyToMove: ready, matches: !ready };
    return JSON.stringify(result);
  }
  if (KIND === "MOVE_UNIT") {
    if (!isInt(ARG) || !isInt(ARG2) || !isInt(ARG3)) return refuse("UNKNOWN_ACTION", "move arguments are not integers");
    if (typeof UnitOperationTypes === "undefined" || !isInt(UnitOperationTypes.MOVE_TO)) return refuse("API_CONTRACT_MISMATCH", "UnitOperationTypes.MOVE_TO unavailable");
    if (typeof RevealedStates === "undefined" || !isInt(RevealedStates.VISIBLE)) return refuse("API_CONTRACT_MISMATCH", "RevealedStates unavailable");
    let unit = null;
    try { for (const u of player.Units.getUnits()) { if (u && u.id && u.id.id === ARG && u.id.owner === BOUND_PLAYER_ID) { unit = u; break; } } } catch (e) { unit = null; }
    if (!unit) return refuse("UNKNOWN_ACTION", "unit is not in the bound player's roster");
    if (unit.isOnMap !== true || !unit.location || !isInt(unit.location.x)) return refuse("ACTION_NOT_STARTABLE", "unit is not on the map");
    if (GameplayMap.getIndexFromXY(unit.location.x, unit.location.y) !== PRE) return refuse("ACTION_EXPIRED", "unit is no longer where it was when the move was offered");
    let adjacent = false;
    for (let d = 0; d < 6; d++) { const loc = GameplayMap.getAdjacentPlotLocation(unit.location, d); if (loc && loc.x === ARG2 && loc.y === ARG3) { adjacent = true; break; } }
    if (!adjacent) return refuse("ACTION_NOT_STARTABLE", "target plot is not adjacent to the unit");
    const state = GameplayMap.getRevealedState(BOUND_PLAYER_ID, ARG2, ARG3);
    if (!isInt(state) || state !== RevealedStates.VISIBLE) return refuse("ACTION_NOT_STARTABLE", "target plot is not currently visible to the bound player");
    const unitId = unit.id;
    const path = Units.getPathTo(unitId, { x: ARG2, y: ARG3 });
    const pplots = path && Array.isArray(path.plots) ? path.plots : [];
    const pturns = path && Array.isArray(path.turns) ? path.turns : [];
    if (pplots.length === 0 || pturns.length === 0 || pturns[pturns.length - 1] !== 1) return refuse("ACTION_NOT_STARTABLE", "no native one-turn path to the target plot");
    const moveArgs = { X: ARG2, Y: ARG3, Modifiers: 0 };
    const mcheck = Game.UnitOperations.canStart(unitId, UnitOperationTypes.MOVE_TO, moveArgs, false);
    if (!mcheck || mcheck.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused the move");
    Game.UnitOperations.sendRequest(unitId, UnitOperationTypes.MOVE_TO, moveArgs);
    result.outcome = "sent";
    const loc = unit.location && isInt(unit.location.x) ? { x: unit.location.x, y: unit.location.y } : null;
    result.readback = { kind: KIND, arg: ARG, target: { x: ARG2, y: ARG3 }, location: loc, matches: !!(loc && loc.x === ARG2 && loc.y === ARG3) };
    return JSON.stringify(result);
  }
  if (KIND === "FOUND_CITY") {
    if (!isInt(ARG) || !isInt(ARG2) || !isInt(ARG3)) return refuse("UNKNOWN_ACTION", "found-city arguments are not integers");
    if (typeof UnitOperationTypes === "undefined" || !isInt(UnitOperationTypes.FOUND_CITY)) return refuse("API_CONTRACT_MISMATCH", "UnitOperationTypes.FOUND_CITY unavailable");
    let unit = null;
    try { for (const u of player.Units.getUnits()) { if (u && u.id && u.id.id === ARG && u.id.owner === BOUND_PLAYER_ID) { unit = u; break; } } } catch (e) { unit = null; }
    if (!unit) return refuse("UNKNOWN_ACTION", "unit is not in the bound player's roster");
    if (unit.isOnMap !== true || !unit.location || !isInt(unit.location.x)) return refuse("ACTION_NOT_STARTABLE", "unit is not on the map");
    if (unit.location.x !== ARG2 || unit.location.y !== ARG3 || GameplayMap.getIndexFromXY(unit.location.x, unit.location.y) !== PRE) return refuse("ACTION_EXPIRED", "unit is no longer where it was when founding was offered");
    const unitId = unit.id;
    const foundArgs = { X: -9999, Y: -9999, UnitAbilityType: -1 };
    const fcheck = Game.UnitOperations.canStart(unitId, UnitOperationTypes.FOUND_CITY, foundArgs, false);
    if (!fcheck || fcheck.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused founding a settlement here");
    Game.UnitOperations.sendRequest(unitId, UnitOperationTypes.FOUND_CITY, foundArgs);
    result.outcome = "sent";
    let founded = false;
    try { for (const c of player.Cities.getCities()) { if (c && c.location && c.location.x === ARG2 && c.location.y === ARG3) { founded = true; break; } } } catch (e) { founded = false; }
    result.readback = { kind: KIND, arg: ARG, at: { x: ARG2, y: ARG3 }, matches: founded };
    return JSON.stringify(result);
  }
  if (KIND === "PRODUCE_UNIT") {
    if (!isInt(ARG) || !isInt(ARG2)) return refuse("UNKNOWN_ACTION", "production arguments are not integers");
    if (typeof CityOperationTypes === "undefined" || !isInt(CityOperationTypes.BUILD)) return refuse("API_CONTRACT_MISMATCH", "CityOperationTypes.BUILD unavailable");
    let city = null;
    try { for (const c of player.Cities.getCities()) { if (c && c.id && c.id.id === ARG && c.id.owner === BOUND_PLAYER_ID) { city = c; break; } } } catch (e) { city = null; }
    if (!city) return refuse("UNKNOWN_ACTION", "city is not in the bound player's roster");
    const row = GameInfo.Units.lookup(ARG2);
    if (!row || typeof row.UnitType !== "string") return refuse("UNKNOWN_ACTION", "unit type is not a unit definition");
    if (!city.BuildQueue || city.BuildQueue.currentProductionTypeHash !== PRE) return refuse("ACTION_EXPIRED", "city production changed since the build was offered");
    const cityId = city.id;
    const buildArgs = { UnitType: ARG2 };
    const bcheck = Game.CityOperations.canStart(cityId, CityOperationTypes.BUILD, buildArgs, false);
    if (!bcheck || bcheck.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused the build");
    Game.CityOperations.sendRequest(cityId, CityOperationTypes.BUILD, buildArgs);
    result.outcome = "sent";
    let observed = null;
    try { observed = city.BuildQueue.currentProductionTypeHash; } catch (e) { observed = null; }
    result.readback = { kind: KIND, arg: ARG, unitType: ARG2, observedType: isInt(observed) ? observed : null, matches: observed === ARG2 };
    return JSON.stringify(result);
  }
  if (KIND !== "SET_TECH_TREE_NODE" && KIND !== "SET_CULTURE_TREE_NODE") return refuse("UNKNOWN_ACTION", "unsupported operation kind");
  if (!isInt(ARG)) return refuse("UNKNOWN_ACTION", "operation argument is not an integer");
  if (!isInt(PlayerOperationTypes[OP_KIND])) return refuse("API_CONTRACT_MISMATCH", "operation type unavailable");
  {
    const comp = KIND === "SET_TECH_TREE_NODE" ? player.Techs : player.Culture;
    let cur = null; try { cur = comp.getResearching().type; } catch (e) { cur = null; }
    if (cur !== PRE) return refuse("ACTION_EXPIRED", "current research changed since the offer was made");
  }
  const args = { ProgressionTreeNodeType: ARG };
  const check = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND], args, false);
  if (!check || check.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused the operation");
  Game.PlayerOperations.sendRequest(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND], args);
  result.outcome = "sent";
  let observed = null;
  try { observed = (KIND === "SET_TECH_TREE_NODE" ? player.Techs : player.Culture).getResearching().type; } catch (e) { observed = null; }
  result.readback = { kind: KIND, arg: ARG, observedType: isInt(observed) ? observed : null, matches: observed === ARG };
  return JSON.stringify(result);
})()
