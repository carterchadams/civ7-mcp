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
  // a name the seat gives something: JSON-encoded by the host, passed through as data, never evaluated
  const TEXT = OP_TEXT;
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
    const blocksNow = (nid, n) => { try { if (typeof Game.Notifications.getBlocksTurnAdvancement === "function") { const b = Game.Notifications.getBlocksTurnAdvancement(nid); if (typeof b === "boolean") return b; } } catch (e) { /* fall back */ } return !!(n && n.BlocksTurnAdvancement === true); };
    const blockerName = (v) => { for (const k of Object.keys(EndTurnBlockingTypes)) if (EndTurnBlockingTypes[k] === v) return k; try { for (const nid of Game.Notifications.getIdsForPlayer(BOUND_PLAYER_ID)) { const n = Game.Notifications.find(nid); if (blocksNow(nid, n)) { const name = Game.Notifications.getTypeName(n.Type); if (typeof name === "string" && name) return name; } } } catch (e) { /* fall through to the raw value */ } return String(v); };
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
    const state = GameplayMap.getRevealedState(BOUND_PLAYER_ID, ARG2, ARG3);
    if (!isInt(state) || state !== RevealedStates.VISIBLE) return refuse("ACTION_NOT_STARTABLE", "target plot is not currently visible to the bound player");
    const unitId = unit.id;
    const path = Units.getPathTo(unitId, { x: ARG2, y: ARG3 });
    const pplots = path && Array.isArray(path.plots) ? path.plots : [];
    const pturns = path && Array.isArray(path.turns) ? path.turns : [];
    // a longer path is allowed only toward one of the seat's own settlements (a standing move)
    let ownSettlement = false; try { for (const c of player.Cities.getCities()) { if (c && c.location && c.location.x === ARG2 && c.location.y === ARG3) ownSettlement = true; } } catch (e) { ownSettlement = false; }
    if (pplots.length === 0 || pturns.length === 0 || (pturns[pturns.length - 1] !== 1 && !ownSettlement)) return refuse("ACTION_NOT_STARTABLE", "no native one-turn path to the target plot");
    const moveArgs = { X: ARG2, Y: ARG3, Modifiers: 0 };
    const mcheck = Game.UnitOperations.canStart(unitId, UnitOperationTypes.MOVE_TO, moveArgs, false);
    if (!mcheck || mcheck.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused the move");
    Game.UnitOperations.sendRequest(unitId, UnitOperationTypes.MOVE_TO, moveArgs);
    result.outcome = "sent";
    const loc = unit.location && isInt(unit.location.x) ? { x: unit.location.x, y: unit.location.y } : null;
    result.readback = { kind: KIND, arg: ARG, target: { x: ARG2, y: ARG3 }, location: loc, matches: !!(loc && loc.x === ARG2 && loc.y === ARG3) };
    return JSON.stringify(result);
  }
  if (KIND === "UNIT_ORDER") {
    if (!isInt(ARG) || !isInt(ARG2)) return refuse("UNKNOWN_ACTION", "order arguments are not integers");
    if (typeof UnitOperationTypes === "undefined" || !GameInfo.UnitOperations) return refuse("API_CONTRACT_MISMATCH", "unit operations unavailable");
    // the payload itself restricts which operations a standing order may be: anything needing a target
    // is not reachable through this kind
    const STANDING = ["UNITOPERATION_FORTIFY", "UNITOPERATION_ALERT", "UNITOPERATION_SLEEP", "UNITOPERATION_REST_UNTIL_HEALED"];
    const orow = GameInfo.UnitOperations.lookup(ARG2);
    if (!orow || typeof orow.OperationType !== "string" || STANDING.indexOf(orow.OperationType) === -1) return refuse("UNKNOWN_ACTION", "that is not a standing unit order");
    let unit = null;
    try { for (const u of player.Units.getUnits()) { if (u && u.id && u.id.id === ARG && u.id.owner === BOUND_PLAYER_ID) { unit = u; break; } } } catch (e) { unit = null; }
    if (!unit) return refuse("UNKNOWN_ACTION", "unit is not in the bound player's roster");
    if (!unit.Movement || unit.Movement.movementMovesRemaining !== PRE) return refuse("ACTION_EXPIRED", "unit movement changed since the order was offered");
    const unitId = unit.id;
    const orderType = orow.$hash;
    const orderArgs = { X: -9999, Y: -9999, UnitAbilityType: -1 };
    const ocheck = Game.UnitOperations.canStart(unitId, orderType, orderArgs, false);
    if (!ocheck || ocheck.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused the order");
    Game.UnitOperations.sendRequest(unitId, orderType, orderArgs);
    result.outcome = "sent";
    const ready = unit.isReadyToMove === true;
    result.readback = { kind: KIND, arg: ARG, order: orow.OperationType, isReadyToMove: ready, matches: !ready };
    return JSON.stringify(result);
  }
  if (KIND === "MAKE_TRADE_ROUTE") {
    if (!isInt(ARG) || !isInt(ARG2) || !isInt(ARG3)) return refuse("UNKNOWN_ACTION", "trade route arguments are not integers");
    if (typeof UnitCommandTypes === "undefined" || !isInt(UnitCommandTypes.MAKE_TRADE_ROUTE) || !player.Trade || typeof TradeRouteStatus === "undefined") return refuse("API_CONTRACT_MISMATCH", "trade route contract unavailable");
    let unit = null;
    try { for (const u of player.Units.getUnits()) { if (u && u.id && u.id.id === ARG && u.id.owner === BOUND_PLAYER_ID) { unit = u; break; } } } catch (e) { unit = null; }
    if (!unit) return refuse("UNKNOWN_ACTION", "unit is not in the bound player's roster");
    if (unit.isOnMap !== true || !unit.location || !isInt(unit.location.x)) return refuse("ACTION_NOT_STARTABLE", "unit is not on the map");
    if (GameplayMap.getIndexFromXY(unit.location.x, unit.location.y) !== PRE) return refuse("ACTION_EXPIRED", "unit is no longer where it was when the route was offered");
    // the destination must still be one the seat's own component projects as a successful route
    let ok = false;
    try {
      for (const r of (player.Trade.projectPossibleTradeRoutes() || [])) {
        if (!r || !r.targetCityId) continue;
        const status = Array.isArray(r.status) ? r.status[0] : r.status;
        if (status !== TradeRouteStatus.SUCCESS) continue;
        const c = Cities.get(r.targetCityId);
        if (c && c.location && c.location.x === ARG2 && c.location.y === ARG3) { ok = true; break; }
      }
    } catch (e) { ok = false; }
    if (!ok) return refuse("ACTION_EXPIRED", "that trade route is no longer projected for this seat");
    const unitId = unit.id;
    const tradeArgs = { X: ARG2, Y: ARG3 };
    const tcheck = Game.UnitCommands.canStart(unitId, UnitCommandTypes.MAKE_TRADE_ROUTE, tradeArgs, false);
    if (!tcheck || tcheck.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused the trade route");
    Game.UnitCommands.sendRequest(unitId, UnitCommandTypes.MAKE_TRADE_ROUTE, tradeArgs);
    result.outcome = "sent";
    let active = null; try { active = player.Trade.countPlayerTradeRoutes(); } catch (e) { active = null; }
    result.readback = { kind: KIND, arg: ARG, to: { x: ARG2, y: ARG3 }, activeRoutes: active, matches: false };
    return JSON.stringify(result);
  }
  if (KIND === "PROMOTE_UNIT") {
    if (!isInt(ARG) || !isInt(ARG2) || !isInt(ARG3)) return refuse("UNKNOWN_ACTION", "promotion arguments are not integers");
    if (typeof UnitCommandTypes === "undefined" || !isInt(UnitCommandTypes.PROMOTE)) return refuse("API_CONTRACT_MISMATCH", "UnitCommandTypes.PROMOTE unavailable");
    let unit = null;
    try { for (const u of player.Units.getUnits()) { if (u && u.id && u.id.id === ARG && u.id.owner === BOUND_PLAYER_ID) { unit = u; break; } } } catch (e) { unit = null; }
    if (!unit) return refuse("UNKNOWN_ACTION", "unit is not in the bound player's roster");
    const xp = unit.Experience;
    if (!xp || xp.canPromote !== true) return refuse("ACTION_NOT_STARTABLE", "unit cannot be promoted");
    if ((isInt(xp.getTotalPromotionsEarned) ? xp.getTotalPromotionsEarned : 0) !== PRE) return refuse("ACTION_EXPIRED", "the unit's promotions changed since the offer was made");
    const prow = GameInfo.UnitPromotions.lookup(ARG2);
    const drow = GameInfo.UnitPromotionDisciplines.lookup(ARG3);
    if (!prow || !drow || typeof prow.UnitPromotionType !== "string" || typeof drow.UnitPromotionDisciplineType !== "string") return refuse("UNKNOWN_ACTION", "promotion or discipline is not a definition");
    let paired = false;
    for (const det of GameInfo.UnitPromotionDisciplineDetails) { if (det && det.UnitPromotionType === prow.UnitPromotionType && det.UnitPromotionDisciplineType === drow.UnitPromotionDisciplineType) { paired = true; break; } }
    if (!paired) return refuse("UNKNOWN_ACTION", "that promotion does not belong to that discipline");
    let earnable = false;
    try { earnable = xp.canEarnPromotion(drow.UnitPromotionDisciplineType, prow.UnitPromotionType, false) === true; } catch (e) { earnable = false; }
    if (!earnable) return refuse("ACTION_NOT_STARTABLE", "the unit can no longer earn that promotion");
    const unitId = unit.id;
    const promoArgs = { PromotionType: ARG2, PromotionDisciplineType: ARG3 };
    const pcheck = Game.UnitCommands.canStart(unitId, UnitCommandTypes.PROMOTE, promoArgs, false);
    if (!pcheck || pcheck.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused the promotion");
    Game.UnitCommands.sendRequest(unitId, UnitCommandTypes.PROMOTE, promoArgs);
    result.outcome = "sent";
    let has = null; try { has = xp.hasPromotion(drow.UnitPromotionDisciplineType, prow.UnitPromotionType) === true; } catch (e) { has = null; }
    result.readback = { kind: KIND, arg: ARG, promotion: ARG2, discipline: ARG3, earned: isInt(xp.getTotalPromotionsEarned) ? xp.getTotalPromotionsEarned : null, hasPromotion: has, matches: has === true };
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
  if (KIND === "CHOOSE_TOWN_PROJECT") {
    if (!isInt(ARG) || !isInt(ARG2)) return refuse("UNKNOWN_ACTION", "town project arguments are not integers");
    if (typeof CityCommandTypes === "undefined" || !isInt(CityCommandTypes.CHANGE_GROWTH_MODE) || typeof GrowthTypes === "undefined" || !isInt(GrowthTypes.PROJECT)) return refuse("API_CONTRACT_MISMATCH", "town project contract unavailable");
    let town = null;
    try { for (const c of player.Cities.getCities()) { if (c && c.id && c.id.id === ARG && c.id.owner === BOUND_PLAYER_ID) { town = c; break; } } } catch (e) { town = null; }
    if (!town) return refuse("UNKNOWN_ACTION", "settlement is not in the bound player's roster");
    if (town.isTown !== true) return refuse("ACTION_NOT_STARTABLE", "that settlement is not a town");
    const prow = GameInfo.Projects.lookup(ARG2);
    if (!prow || typeof prow.ProjectType !== "string") return refuse("UNKNOWN_ACTION", "type is not a project definition");
    const curp = town.Growth && isInt(town.Growth.projectType) ? town.Growth.projectType : -1;
    if (curp !== PRE) return refuse("ACTION_EXPIRED", "the town's project changed since the offer was made");
    const townId = town.id;
    // The shipped chooser sends CONSIDER_TOWN_PROJECT the moment the focus panel opens, before any
    // choice; a choice sent without it was dropped by the engine (live, Fukui, turn 61, twice).
    if (typeof CityOperationTypes !== "undefined" && isInt(CityOperationTypes.CONSIDER_TOWN_PROJECT)) {
      Game.CityOperations.sendRequest(townId, CityOperationTypes.CONSIDER_TOWN_PROJECT, {});
    }
    const growthArgs = { Type: GrowthTypes.PROJECT, ProjectType: ARG2, City: ARG };
    const gcheck = Game.CityCommands.canStart(townId, CityCommandTypes.CHANGE_GROWTH_MODE, growthArgs, false);
    if (!gcheck || gcheck.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused that town project");
    Game.CityCommands.sendRequest(townId, CityCommandTypes.CHANGE_GROWTH_MODE, growthArgs);
    result.outcome = "sent";
    let after = null; try { after = town.Growth.projectType; } catch (e) { after = null; }
    result.readback = { kind: KIND, arg: ARG, project: ARG2, observed: isInt(after) ? after : null, matches: after === ARG2 };
    return JSON.stringify(result);
  }
  if (KIND === "CONSIDER_TOWN_PROJECT") {
    if (!isInt(ARG)) return refuse("UNKNOWN_ACTION", "town argument is not an integer");
    if (typeof CityOperationTypes === "undefined" || !isInt(CityOperationTypes.CONSIDER_TOWN_PROJECT)) return refuse("API_CONTRACT_MISMATCH", "CONSIDER_TOWN_PROJECT unavailable");
    let ctown = null;
    try { for (const c of player.Cities.getCities()) { if (c && c.id && c.id.id === ARG && c.id.owner === BOUND_PLAYER_ID) { ctown = c; break; } } } catch (e) { ctown = null; }
    if (!ctown) return refuse("UNKNOWN_ACTION", "settlement is not in the bound player's roster");
    const townId = ctown.id;
    Game.CityOperations.sendRequest(townId, CityOperationTypes.CONSIDER_TOWN_PROJECT, {});
    result.outcome = "sent";
    // this town's own notification, not any town's: several may be pending at once
    let still = null; try { still = Game.Notifications.getIdsForPlayer(BOUND_PLAYER_ID).some((nid) => { const n = Game.Notifications.find(nid); if (!n || Game.Notifications.getTypeName(n.Type) !== "NOTIFICATION_CHOOSE_TOWN_PROJECT" || !n.Target || n.Target.id !== ARG) return false; let b = null; try { b = Game.Notifications.getBlocksTurnAdvancement(nid); } catch (e) { b = null; } return b === true || (b !== false && n.BlocksTurnAdvancement === true); }); } catch (e) { still = null; }
    result.readback = { kind: KIND, arg: ARG, stillBlocking: still, matches: still === false };
    return JSON.stringify(result);
  }
  if (KIND === "EXPAND_CITY") {
    if (!isInt(ARG) || !isInt(ARG2) || !isInt(ARG3)) return refuse("UNKNOWN_ACTION", "expand arguments are not integers");
    if (typeof CityCommandTypes === "undefined" || !isInt(CityCommandTypes.EXPAND)) return refuse("API_CONTRACT_MISMATCH", "CityCommandTypes.EXPAND unavailable");
    let city = null;
    try { for (const c of player.Cities.getCities()) { if (c && c.id && c.id.id === ARG && c.id.owner === BOUND_PLAYER_ID) { city = c; break; } } } catch (e) { city = null; }
    if (!city) return refuse("UNKNOWN_ACTION", "city is not in the bound player's roster");
    if (GameplayMap.getIndexFromXY(ARG2, ARG3) !== PRE) return refuse("ACTION_EXPIRED", "plot identity differs from the offer");
    const cityId = city.id;
    const listing = Game.CityCommands.canStart(cityId, CityCommandTypes.EXPAND, {}, false);
    const eplots = listing && Array.isArray(listing.Plots) ? listing.Plots : [];
    if (eplots.indexOf(PRE) === -1) return refuse("ACTION_EXPIRED", "the plot is no longer offered for this city's growth");
    const expandArgs = { X: ARG2, Y: ARG3 };
    const echeck = Game.CityCommands.canStart(cityId, CityCommandTypes.EXPAND, expandArgs, false);
    if (!echeck || echeck.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused placing population on that plot");
    Game.CityCommands.sendRequest(cityId, CityCommandTypes.EXPAND, expandArgs);
    result.outcome = "sent";
    let still = null;
    try { const after = Game.CityCommands.canStart(cityId, CityCommandTypes.EXPAND, {}, false); still = after && Array.isArray(after.Plots) ? after.Plots.indexOf(PRE) !== -1 : null; } catch (e) { still = null; }
    result.readback = { kind: KIND, arg: ARG, plot: { x: ARG2, y: ARG3, index: PRE }, stillOffered: still, matches: still === false };
    return JSON.stringify(result);
  }
  if (KIND === "PRODUCE_CONSTRUCTIBLE") {
    if (!isInt(ARG) || !isInt(ARG2) || !isInt(ARG3)) return refuse("UNKNOWN_ACTION", "production arguments are not integers");
    if (typeof CityOperationTypes === "undefined" || !isInt(CityOperationTypes.BUILD)) return refuse("API_CONTRACT_MISMATCH", "CityOperationTypes.BUILD unavailable");
    let city = null;
    try { for (const c of player.Cities.getCities()) { if (c && c.id && c.id.id === ARG && c.id.owner === BOUND_PLAYER_ID) { city = c; break; } } } catch (e) { city = null; }
    if (!city) return refuse("UNKNOWN_ACTION", "city is not in the bound player's roster");
    const crow = GameInfo.Constructibles.lookup(ARG2);
    if (!crow || typeof crow.ConstructibleType !== "string") return refuse("UNKNOWN_ACTION", "type is not a constructible definition");
    const queueBefore = city.BuildQueue && typeof city.BuildQueue.getQueue === "function" ? city.BuildQueue.getQueue() : null;
    if (!Array.isArray(queueBefore) || queueBefore.length !== PRE) return refuse("ACTION_EXPIRED", "the city's build queue changed since the build was offered");
    const ploc = GameplayMap.getLocationFromIndex(ARG3);
    if (!ploc || !isInt(ploc.x) || !isInt(ploc.y) || ploc.x < 0 || GameplayMap.getIndexFromXY(ploc.x, ploc.y) !== ARG3) return refuse("ACTION_NOT_STARTABLE", "placement plot is not a valid map plot");
    const cityId = city.id;
    const buildArgs = { ConstructibleType: ARG2, X: ploc.x, Y: ploc.y };
    const bcheck = Game.CityOperations.canStart(cityId, CityOperationTypes.BUILD, buildArgs, false);
    if (!bcheck || bcheck.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused the build on that plot");
    Game.CityOperations.sendRequest(cityId, CityOperationTypes.BUILD, buildArgs);
    result.outcome = "sent";
    let after = null; try { after = city.BuildQueue.getQueue(); } catch (e) { after = null; }
    const queuedC = Array.isArray(after) && after.length > PRE && after[PRE] && after[PRE].type === ARG2;
    result.readback = { kind: KIND, arg: ARG, constructibleType: ARG2, plot: { x: ploc.x, y: ploc.y, index: ARG3 }, queuedAt: PRE, queueLength: Array.isArray(after) ? after.length : null, matches: queuedC };
    return JSON.stringify(result);
  }
  // The six generic unit commands. The kind IS the engine's command name, validated host-side against
  // the catalog, so nothing a caller says ever reaches UnitCommandTypes as text.
  if (KIND === "UPGRADE" || KIND === "PACK_ARMY" || KIND === "ADD_TO_ARMY" || KIND === "REMOVE_FROM_ARMY" ||
      KIND === "UNPACK_ARMY" || KIND === "ACTIVATE_GREAT_PERSON" || KIND === "WAKE" || KIND === "CANCEL" || KIND === "PLUNDER_TRADE_ROUTE" || KIND === "RESETTLE") {
    if (!isInt(ARG)) return refuse("UNKNOWN_ACTION", "unit command argument is not an integer");
    if (typeof UnitCommandTypes === "undefined" || !isInt(UnitCommandTypes[OP_KIND])) return refuse("API_CONTRACT_MISMATCH", "unit command type unavailable");
    const needsPlot = KIND === "ADD_TO_ARMY" || KIND === "REMOVE_FROM_ARMY" || KIND === "UNPACK_ARMY" || KIND === "ACTIVATE_GREAT_PERSON" || KIND === "RESETTLE";
    const expect = (KIND === "UPGRADE") ? "type"
                 : (KIND === "PACK_ARMY" || KIND === "UNPACK_ARMY") ? "armySize"
                 : (KIND === "ACTIVATE_GREAT_PERSON" || KIND === "RESETTLE") ? "gone"
                 : (KIND === "WAKE" || KIND === "CANCEL") ? "awake"
                 : (KIND === "PLUNDER_TRADE_ROUTE") ? "spent" : "army";
    let actor = null;
    try { for (const u of player.Units.getUnits()) { if (u && u.id && u.id.id === ARG && u.id.owner === BOUND_PLAYER_ID) { actor = u; break; } } } catch (e) { actor = null; }
    if (!actor) return refuse("UNKNOWN_ACTION", "unit is not in the bound player's roster");
    const sizeOf = (u) => { try { if (!u.armyId || !isInt(u.armyId.id) || u.armyId.id < 0) return -1; const a = Armies.get(u.armyId); return a && isInt(a.unitCount) ? a.unitCount : -1; } catch (e) { return -1; } };
    const stateOf = (u) => expect === "type" ? (isInt(u.type) ? u.type : -1)
                         : expect === "army" ? (u.armyId && isInt(u.armyId.id) ? u.armyId.id : -1)
                         : expect === "armySize" ? sizeOf(u)
                         : expect === "spent" ? (u.Movement && isInt(u.Movement.movementMovesRemaining) ? u.Movement.movementMovesRemaining : 0)
                         : expect === "awake" ? (u.isReadyToMove === true ? 1 : 0) : 1;
    const before = stateOf(actor);
    if (before !== PRE) return refuse("ACTION_EXPIRED", "the unit's state changed since the command was offered");
    const cUnitId = actor.id;
    let cmdArgs = { X: -9999, Y: -9999, UnitAbilityType: -1 };
    if (needsPlot) {
      if (!isInt(ARG2) || !isInt(ARG3) || ARG2 < 0 || ARG3 < 0) return refuse("UNKNOWN_ACTION", "this command needs a target plot");
      // resettling sends the plot alone, as the shipped acquire-tile mode does
      cmdArgs = KIND === "RESETTLE" ? { X: ARG2, Y: ARG3 } : { X: ARG2, Y: ARG3, UnitAbilityType: -1 };
    }
    const commandType = UnitCommandTypes[OP_KIND];
    const ccheck = Game.UnitCommands.canStart(cUnitId, commandType, cmdArgs, false);
    if (!ccheck || ccheck.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused the command");
    Game.UnitCommands.sendRequest(cUnitId, commandType, cmdArgs);
    result.outcome = "sent";
    let still = null;
    try { for (const u of player.Units.getUnits()) { if (u && u.id && u.id.id === ARG) { still = u; break; } } } catch (e) { still = null; }
    const after = still ? stateOf(still) : null;
    result.readback = { kind: KIND, arg: ARG, expect: expect, before: PRE, after: after, present: still !== null,
      matches: expect === "gone" ? still === null : (after !== null && after !== PRE) };
    return JSON.stringify(result);
  }
  if (KIND === "SEND_MERCHANT") {
    if (!isInt(ARG) || !isInt(ARG2) || !isInt(ARG3)) return refuse("UNKNOWN_ACTION", "send arguments are not integers");
    if (typeof UnitOperationTypes === "undefined" || !isInt(UnitOperationTypes.MOVE_TO)) return refuse("API_CONTRACT_MISMATCH", "UnitOperationTypes.MOVE_TO unavailable");
    if (typeof UnitOperationMoveModifiers === "undefined" || !isInt(UnitOperationMoveModifiers.MOVE_IGNORE_UNEXPLORED_DESTINATION)) return refuse("API_CONTRACT_MISMATCH", "the move modifier is unavailable");
    let merchant = null;
    try { for (const u of player.Units.getUnits()) { if (u && u.id && u.id.id === ARG && u.id.owner === BOUND_PLAYER_ID) { merchant = u; break; } } } catch (e) { merchant = null; }
    if (!merchant) return refuse("UNKNOWN_ACTION", "unit is not in the bound player's roster");
    const mrow = GameInfo.Units.lookup(merchant.type);
    if (!mrow || mrow.MakeTradeRoute !== true) return refuse("UNKNOWN_ACTION", "unit cannot make trade routes");
    if (merchant.isOnMap !== true || !merchant.location || !isInt(merchant.location.x)) return refuse("ACTION_NOT_STARTABLE", "unit is not on the map");
    if (GameplayMap.getIndexFromXY(merchant.location.x, merchant.location.y) !== PRE) return refuse("ACTION_EXPIRED", "unit is no longer where it was when the send was offered");
    const mUnitId = merchant.id;
    const mpath = Units.getPathTo(mUnitId, { x: ARG2, y: ARG3 });
    if (!mpath || !Array.isArray(mpath.plots) || mpath.plots.length === 0) return refuse("ACTION_NOT_STARTABLE", "no native path to the target plot");
    // Sent the way the shipped chooser sends it: a plain move to the city's plot, allowed to end in
    // unexplored ground, which the engine carries on over following turns.
    const sendArgs = { X: ARG2, Y: ARG3, Modifiers: UnitOperationMoveModifiers.MOVE_IGNORE_UNEXPLORED_DESTINATION };
    const scheck = Game.UnitOperations.canStart(mUnitId, UnitOperationTypes.MOVE_TO, sendArgs, false);
    if (!scheck || scheck.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused the move");
    Game.UnitOperations.sendRequest(mUnitId, UnitOperationTypes.MOVE_TO, sendArgs);
    result.outcome = "sent";
    const now = merchant.location && isInt(merchant.location.x) ? GameplayMap.getIndexFromXY(merchant.location.x, merchant.location.y) : null;
    result.readback = { kind: KIND, arg: ARG, target: { x: ARG2, y: ARG3 }, from: PRE, at: now, matches: isInt(now) && now !== PRE };
    return JSON.stringify(result);
  }
  if (KIND === "REINFORCE_ARMY" || KIND === "REBASE" || KIND === "TELEPORT_TO_CITY" || KIND === "ESTABLISH_BASE" || KIND === "DISPERSE_INDEPENDENT" || KIND === "CONVERT_ADJACENT_INDEPENDENT_TO_CITYSTATE" || KIND === "REPAIR" || KIND === "REMOVE_FEATURE" || KIND === "REMOVE_IMPROVEMENT" || KIND === "PLANT_FOREST" || KIND === "HARVEST_RESOURCE" || KIND === "BUILD_IMPROVEMENT" || KIND === "EMBED_LOOKOUT" || KIND === "SEARCH" || KIND === "AERIAL_RECON" || KIND === "CALL_REINFORCEMENTS" || KIND === "EXCAVATE" || KIND === "RESEARCH_ARTIFACTS" || KIND === "AIR_ATTACK" || KIND === "NAVAL_ATTACK" || KIND === "CARGO_DROP" || KIND === "UNIT_AIR_DROP" || KIND === "AUTOMATE_EXPLORE" || KIND === "WMD_STRIKE") {
    // Table-driven unit operation: the kind IS the engine's name, validated host-side against the catalog.
    // A plot bound on the offer (arg2/arg3 >= 0) is sent as {X, Y}; otherwise the no-target sentinel.
    if (!isInt(ARG) || !isInt(ARG2) || !isInt(ARG3)) return refuse("UNKNOWN_ACTION", "unit operation arguments are not integers");
    if (typeof UnitOperationTypes === "undefined" || !isInt(UnitOperationTypes[OP_KIND])) return refuse("API_CONTRACT_MISMATCH", "unit operation type unavailable");
    const expect = (KIND === "REINFORCE_ARMY") ? "offmap"
                 : (KIND === "REBASE" || KIND === "TELEPORT_TO_CITY") ? "moved"
                 : (KIND === "AUTOMATE_EXPLORE") ? "asleep"
                 : "used";
    let actor = null;
    try { for (const u of player.Units.getUnits()) { if (u && u.id && u.id.id === ARG && u.id.owner === BOUND_PLAYER_ID) { actor = u; break; } } } catch (e) { actor = null; }
    if (!actor) return refuse("UNKNOWN_ACTION", "unit is not in the bound player's roster");
    const stateOf = (u) => expect === "asleep" ? (u.isReadyToMove === true ? 1 : 0)
                         : expect === "moved" ? (u.location && isInt(u.location.x) && u.location.x >= 0 ? GameplayMap.getIndexFromXY(u.location.x, u.location.y) : -1)
                         : expect === "offmap" ? (u.isOnMap === true ? 1 : 0)
                         : expect === "gold" ? (player.Treasury && typeof player.Treasury.goldBalance === "number" ? Math.floor(player.Treasury.goldBalance) : 0)
                         : (u.Movement && isInt(u.Movement.movementMovesRemaining) ? u.Movement.movementMovesRemaining : 0);
    if (stateOf(actor) !== PRE) return refuse("ACTION_EXPIRED", "the unit's state changed since the offer was made");
    const lUnitId = actor.id;
    const lArgs = (ARG2 >= 0 && ARG3 >= 0) ? { X: ARG2, Y: ARG3 } : { X: -9999, Y: -9999, UnitAbilityType: -1 };
    // the shipped strike mode hard-codes the one weapon on every probe and the send
    if (KIND === "WMD_STRIKE") lArgs.Type = Database.makeHash("WMD_NUCLEAR_DEVICE");
    const lType = UnitOperationTypes[OP_KIND];
    const check = Game.UnitOperations.canStart(lUnitId, lType, lArgs, false);
    if (!check || check.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused the unit operation");
    Game.UnitOperations.sendRequest(lUnitId, lType, lArgs);
    result.outcome = "sent";
    let still = null;
    try { for (const u of player.Units.getUnits()) { if (u && u.id && u.id.id === ARG) { still = u; break; } } } catch (e) { still = null; }
    const after = still ? stateOf(still) : (expect === "gold" ? stateOf(actor) : null);
    const matches = expect === "asleep" ? (still !== null && after === 0 && PRE === 1)
                  : expect === "used" ? (still === null || (isInt(after) && after < PRE))
                  : expect === "offmap" ? (still === null || after === 0)
                  : expect === "moved" ? (still !== null && isInt(after) && after !== PRE)
                  : (isInt(after) && after < PRE);
    result.readback = { kind: KIND, arg: ARG, expect: expect, before: PRE, after: after, present: still !== null, matches: matches };
    return JSON.stringify(result);
  }
  if (KIND === "CONNECT_WITH_ROAD" || KIND === "MOVE_BY_RAIL" || KIND === "UPGRADE_ARMY" || KIND === "FOCUSED_ATTACK_LAND_MELEE" || KIND === "FOCUSED_ATTACK_LAND_RANGED" || KIND === "FOCUSED_ATTACK_SEA_MELEE" || KIND === "FOCUSED_ATTACK_SEA_RANGED" || KIND === "FOCUSED_ATTACK_AIR_TO_AIR" || KIND === "FOCUSED_ATTACK_AIR_TO_LAND" || KIND === "FOCUSED_ATTACK_AIR_BOMB" || KIND === "ARMY_OVERRUN" || KIND === "COMMANDER_ATTACK" || KIND === "STONE_TRAP" || KIND === "TREAT_SICK" || KIND === "CLAIM_RESOURCE" || KIND === "SCORCHED_EARTH" || KIND === "DISPERSE_CLAN") {
    // Table-driven unit command: the kind IS the engine's name, validated host-side against the catalog.
    // A plot bound on the offer (arg2/arg3 >= 0) is sent as {X, Y}; otherwise the no-target sentinel.
    if (!isInt(ARG) || !isInt(ARG2) || !isInt(ARG3)) return refuse("UNKNOWN_ACTION", "unit command arguments are not integers");
    if (typeof UnitCommandTypes === "undefined" || !isInt(UnitCommandTypes[OP_KIND])) return refuse("API_CONTRACT_MISMATCH", "unit command type unavailable");
    const expect = (KIND === "MOVE_BY_RAIL") ? "moved"
                 : (KIND === "UPGRADE_ARMY") ? "gold"
                 : "used";
    let actor = null;
    try { for (const u of player.Units.getUnits()) { if (u && u.id && u.id.id === ARG && u.id.owner === BOUND_PLAYER_ID) { actor = u; break; } } } catch (e) { actor = null; }
    if (!actor) return refuse("UNKNOWN_ACTION", "unit is not in the bound player's roster");
    const stateOf = (u) => expect === "moved" ? (u.location && isInt(u.location.x) && u.location.x >= 0 ? GameplayMap.getIndexFromXY(u.location.x, u.location.y) : -1)
                         : expect === "offmap" ? (u.isOnMap === true ? 1 : 0)
                         : expect === "gold" ? (player.Treasury && typeof player.Treasury.goldBalance === "number" ? Math.floor(player.Treasury.goldBalance) : 0)
                         : (u.Movement && isInt(u.Movement.movementMovesRemaining) ? u.Movement.movementMovesRemaining : 0);
    if (stateOf(actor) !== PRE) return refuse("ACTION_EXPIRED", "the unit's state changed since the offer was made");
    const aUnitId2 = actor.id;
    const aArgs = (ARG2 >= 0 && ARG3 >= 0) ? { X: ARG2, Y: ARG3 } : { X: -9999, Y: -9999, UnitAbilityType: -1 };
    const aType = UnitCommandTypes[OP_KIND];
    const check = Game.UnitCommands.canStart(aUnitId2, aType, aArgs, false);
    if (!check || check.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused the unit command");
    Game.UnitCommands.sendRequest(aUnitId2, aType, aArgs);
    result.outcome = "sent";
    let still = null;
    try { for (const u of player.Units.getUnits()) { if (u && u.id && u.id.id === ARG) { still = u; break; } } } catch (e) { still = null; }
    const after = still ? stateOf(still) : (expect === "gold" ? stateOf(actor) : null);
    const matches = expect === "used" ? (still === null || (isInt(after) && after < PRE))
                  : expect === "offmap" ? (still === null || after === 0)
                  : expect === "moved" ? (still !== null && isInt(after) && after !== PRE)
                  : (isInt(after) && after < PRE);
    result.readback = { kind: KIND, arg: ARG, expect: expect, before: PRE, after: after, present: still !== null, matches: matches };
    return JSON.stringify(result);
  }
  if (KIND === "PILLAGE" || KIND === "COASTAL_RAID" || KIND === "PILLAGE_ROUTE" || KIND === "SPREAD_RELIGION") {
    if (!isInt(ARG) || !isInt(ARG2) || !isInt(ARG3)) return refuse("UNKNOWN_ACTION", "operation arguments are not integers");
    if (typeof UnitOperationTypes === "undefined" || !isInt(UnitOperationTypes[OP_KIND])) return refuse("API_CONTRACT_MISMATCH", "unit operation type unavailable");
    let actor2 = null;
    try { for (const u of player.Units.getUnits()) { if (u && u.id && u.id.id === ARG && u.id.owner === BOUND_PLAYER_ID) { actor2 = u; break; } } } catch (e) { actor2 = null; }
    if (!actor2) return refuse("UNKNOWN_ACTION", "unit is not in the bound player's roster");
    const opType2 = UnitOperationTypes[OP_KIND];
    const spread = KIND === "SPREAD_RELIGION";
    const probeArgs = spread ? { X: -9999, Y: -9999, UnitAbilityType: -1 } : {};
    const before2 = spread ? (() => { const r = Game.UnitOperations.canStart(actor2.id, opType2, probeArgs, false); return r && isInt(r.ChargesRemaining) ? r.ChargesRemaining : -1; })()
                           : (actor2.Movement && isInt(actor2.Movement.movementMovesRemaining) ? actor2.Movement.movementMovesRemaining : 0);
    if (before2 !== PRE) return refuse("ACTION_EXPIRED", spread ? "the unit's charges changed since the offer was made" : "the unit's moves changed since the offer was made");
    const opUnitId = actor2.id;
    const opArgs = spread ? { X: ARG2, Y: ARG3, UnitAbilityType: -1 } : { X: ARG2, Y: ARG3 };
    const ocheck = Game.UnitOperations.canStart(opUnitId, opType2, opArgs, false);
    if (!ocheck || ocheck.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused the operation at that plot");
    Game.UnitOperations.sendRequest(opUnitId, opType2, opArgs);
    result.outcome = "sent";
    const after2 = spread ? (() => { const r = Game.UnitOperations.canStart(actor2.id, opType2, probeArgs, false); return r && isInt(r.ChargesRemaining) ? r.ChargesRemaining : -1; })()
                          : (actor2.Movement && isInt(actor2.Movement.movementMovesRemaining) ? actor2.Movement.movementMovesRemaining : null);
    result.readback = { kind: KIND, arg: ARG, target: { x: ARG2, y: ARG3 }, before: PRE, after: after2, matches: isInt(after2) && after2 < PRE };
    return JSON.stringify(result);
  }
  if (KIND === "TOWN_GROWTH_MODE") {
    if (!isInt(ARG)) return refuse("UNKNOWN_ACTION", "town argument is not an integer");
    if (typeof CityCommandTypes === "undefined" || !isInt(CityCommandTypes.CHANGE_GROWTH_MODE) || typeof GrowthTypes === "undefined" || !isInt(GrowthTypes.EXPAND) || typeof ProjectTypes === "undefined" || !isInt(ProjectTypes.NO_PROJECT)) return refuse("API_CONTRACT_MISMATCH", "growth mode contract unavailable");
    let town = null;
    try { for (const c of player.Cities.getCities()) { if (c && c.id && c.id.id === ARG && c.id.owner === BOUND_PLAYER_ID) { town = c; break; } } } catch (e) { town = null; }
    if (!town || town.isTown !== true) return refuse("UNKNOWN_ACTION", "settlement is not one of the bound player's towns");
    const curProj = town.Growth && isInt(town.Growth.projectType) ? town.Growth.projectType : -1;
    if (curProj !== PRE) return refuse("ACTION_EXPIRED", "the town's project changed since the offer was made");
    if (curProj === -1) return refuse("ACTION_EXPIRED", "the town is already growing");
    const townId = town.id;
    const growthArgs = { Type: GrowthTypes.EXPAND, ProjectType: ProjectTypes.NO_PROJECT, City: ARG };
    const gcheck = Game.CityCommands.canStart(townId, CityCommandTypes.CHANGE_GROWTH_MODE, growthArgs, false);
    if (!gcheck || gcheck.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused returning to growth");
    Game.CityCommands.sendRequest(townId, CityCommandTypes.CHANGE_GROWTH_MODE, growthArgs);
    result.outcome = "sent";
    const now = town.Growth && isInt(town.Growth.projectType) ? town.Growth.projectType : -1;
    result.readback = { kind: KIND, arg: ARG, projectBefore: PRE, projectAfter: now, matches: now === -1 };
    return JSON.stringify(result);
  }
  if (KIND === "QUEUE_REMOVE" || KIND === "QUEUE_MOVE_UP" || KIND === "QUEUE_MOVE_DOWN") {
    if (!isInt(ARG) || !isInt(ARG2) || !isInt(ARG3)) return refuse("UNKNOWN_ACTION", "queue arguments are not integers");
    if (typeof CityOperationTypes === "undefined" || !isInt(CityOperationTypes.BUILD) || typeof CityOperationsParametersValues === "undefined") return refuse("API_CONTRACT_MISMATCH", "queue edit contract unavailable");
    let qcity = null;
    try { for (const c of player.Cities.getCities()) { if (c && c.id && c.id.id === ARG && c.id.owner === BOUND_PLAYER_ID) { qcity = c; break; } } } catch (e) { qcity = null; }
    if (!qcity || !qcity.BuildQueue) return refuse("UNKNOWN_ACTION", "city is not in the bound player's roster");
    const qbefore = qcity.BuildQueue.getQueue();
    if (!Array.isArray(qbefore) || qbefore.length !== PRE) return refuse("ACTION_EXPIRED", "the city's build queue changed since the offer was made");
    if (ARG2 < 0 || ARG2 >= qbefore.length || !qbefore[ARG2] || qbefore[ARG2].type !== ARG3) return refuse("ACTION_EXPIRED", "the item is no longer at that position in the queue");
    const dest = KIND === "QUEUE_MOVE_UP" ? ARG2 - 1 : ARG2 + 1;
    if (KIND !== "QUEUE_REMOVE" && (dest < 0 || dest >= qbefore.length)) return refuse("ACTION_NOT_STARTABLE", "nowhere to move the item");
    const qCityId = qcity.id;
    const queueArgs = KIND === "QUEUE_REMOVE" ? { InsertMode: CityOperationsParametersValues.RemoveAt, QueueLocation: ARG2 }
                                              : { InsertMode: CityOperationsParametersValues.Swap, QueueSourceLocation: ARG2, QueueDestinationLocation: dest };
    const qcheck = Game.CityOperations.canStart(qCityId, CityOperationTypes.BUILD, queueArgs, false);
    if (!qcheck || qcheck.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused the queue edit");
    Game.CityOperations.sendRequest(qCityId, CityOperationTypes.BUILD, queueArgs);
    result.outcome = "sent";
    let qafter = null; try { qafter = qcity.BuildQueue.getQueue().map((it) => it.type); } catch (e) { qafter = null; }
    const ok = Array.isArray(qafter) && (KIND === "QUEUE_REMOVE" ? qafter.length === PRE - 1 : qafter[dest] === ARG3);
    result.readback = { kind: KIND, arg: ARG, position: ARG2, item: ARG3, queueAfter: qafter, matches: ok };
    return JSON.stringify(result);
  }
  if (KIND === "DEACTIVATE_TRADITION") {
    if (!isInt(ARG)) return refuse("UNKNOWN_ACTION", "tradition argument is not an integer");
    const traditionOp = PlayerOperationTypes["CHANGE_TRADITION"];
    if (!isInt(traditionOp) || typeof PlayerOperationParameters === "undefined" || !isInt(PlayerOperationParameters.Deactivate)) return refuse("API_CONTRACT_MISMATCH", "tradition contract unavailable");
    const trow = GameInfo.Traditions.lookup(ARG);
    if (!trow) return refuse("UNKNOWN_ACTION", "not a tradition definition");
    let isActive = null; try { isActive = player.Culture.isTraditionActive(ARG) === true; } catch (e) { isActive = null; }
    if (isActive !== true) return refuse("ACTION_EXPIRED", "that tradition is not in a slot");
    const deactArgs = { TraditionType: ARG, Action: PlayerOperationParameters.Deactivate };
    const tcheck2 = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, traditionOp, deactArgs, false);
    if (!tcheck2 || tcheck2.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused taking the card out");
    Game.PlayerOperations.sendRequest(BOUND_PLAYER_ID, traditionOp, deactArgs);
    result.outcome = "sent";
    let stillActive = null; try { stillActive = player.Culture.isTraditionActive(ARG) === true; } catch (e) { stillActive = null; }
    result.readback = { kind: KIND, arg: ARG, active: stillActive, matches: stillActive === false };
    return JSON.stringify(result);
  }
  if (KIND === "UNASSIGN_RESOURCE" || KIND === "SWAP_RESOURCES") {
    if (!isInt(ARG) || !isInt(ARG2)) return refuse("UNKNOWN_ACTION", "resource arguments are not integers");
    const resourceOp = KIND === "UNASSIGN_RESOURCE" ? PlayerOperationTypes["ASSIGN_RESOURCE"] : PlayerOperationTypes[OP_KIND];
    if (!isInt(resourceOp) || typeof PlayerOperationParameters === "undefined") return refuse("API_CONTRACT_MISMATCH", "resource contract unavailable");
    const where = (value) => { const m = {}; for (const c of player.Cities.getCities()) { if (!c || !c.id || !c.Resources) continue; try { for (const ar of c.Resources.getAssignedResources()) { if (ar && isInt(ar.value)) m[ar.value] = c.id.id; } } catch (e) { /* none */ } } return m[value] === undefined ? null : m[value]; };
    const homeBefore = where(ARG);
    if (homeBefore !== PRE) return refuse("ACTION_EXPIRED", "the resource is no longer where it was when the offer was made");
    const l1 = GameplayMap.getLocationFromIndex(ARG);
    const resArgs = KIND === "UNASSIGN_RESOURCE" ? { Location: l1, City: ARG2, Action: PlayerOperationParameters.Deactivate } : { Location: l1, Location2: GameplayMap.getLocationFromIndex(ARG2) };
    const rcheck2 = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, resourceOp, resArgs, false);
    if (!rcheck2 || rcheck2.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused the resource change");
    Game.PlayerOperations.sendRequest(BOUND_PLAYER_ID, resourceOp, resArgs);
    result.outcome = "sent";
    const homeAfter = where(ARG);
    result.readback = { kind: KIND, arg: ARG, homeBefore: PRE, homeAfter: homeAfter, matches: KIND === "UNASSIGN_RESOURCE" ? homeAfter === null : (homeAfter !== null && homeAfter !== PRE) };
    return JSON.stringify(result);
  }
  if (KIND === "ATTACK") {
    if (!isInt(ARG) || !isInt(ARG2) || !isInt(ARG3)) return refuse("UNKNOWN_ACTION", "attack arguments are not integers");
    if (!isInt(UnitOperationTypes.MOVE_TO) || !isInt(UnitOperationTypes.RANGE_ATTACK)) return refuse("API_CONTRACT_MISMATCH", "the attack operations are unavailable");
    if (typeof UnitOperationMoveModifiers === "undefined" || !isInt(UnitOperationMoveModifiers.ATTACK) || !isInt(UnitOperationMoveModifiers.MOVE_IGNORE_UNEXPLORED_DESTINATION)) return refuse("API_CONTRACT_MISMATCH", "the attack move modifiers are unavailable");
    if (typeof Game.Combat === "undefined" || typeof Game.Combat.testAttackInto !== "function") return refuse("API_CONTRACT_MISMATCH", "the combat classifier is unavailable");
    let attacker = null;
    try { for (const u of player.Units.getUnits()) { if (u && u.id && u.id.id === ARG && u.id.owner === BOUND_PLAYER_ID) { attacker = u; break; } } } catch (e) { attacker = null; }
    if (!attacker) return refuse("UNKNOWN_ACTION", "unit is not in the bound player's roster");
    const acombat = attacker.Combat;
    if (!acombat || acombat.isCombat !== true) return refuse("ACTION_NOT_STARTABLE", "unit cannot fight");
    if (!isInt(acombat.attacksRemaining) || acombat.attacksRemaining !== PRE) return refuse("ACTION_EXPIRED", "the unit's remaining attacks changed since the offer was made");
    if (acombat.attacksRemaining < 1) return refuse("ACTION_NOT_STARTABLE", "unit has no attack left this turn");
    if (GameplayMap.getRevealedState(BOUND_PLAYER_ID, ARG2, ARG3) !== RevealedStates.VISIBLE) return refuse("ACTION_NOT_STARTABLE", "the target plot is not currently visible to the bound player");
    const aUnitId = attacker.id;
    let isRanged = false;
    try { isRanged = Game.Combat.testAttackInto(aUnitId, { X: ARG2, Y: ARG3 }) === CombatTypes.COMBAT_RANGED; } catch (e) { isRanged = false; }
    const rangedArgs = { X: ARG2, Y: ARG3 };
    const meleeArgs = { X: ARG2, Y: ARG3, Modifiers: UnitOperationMoveModifiers.ATTACK + UnitOperationMoveModifiers.MOVE_IGNORE_UNEXPLORED_DESTINATION };
    let sent = false;
    if (isRanged) {
      const rcheck = Game.UnitOperations.canStart(aUnitId, UnitOperationTypes.RANGE_ATTACK, rangedArgs, false);
      if (!rcheck || rcheck.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused the ranged attack");
      Game.UnitOperations.sendRequest(aUnitId, UnitOperationTypes.RANGE_ATTACK, rangedArgs);
      sent = true;
    } else {
      const mcheck = Game.UnitOperations.canStart(aUnitId, UnitOperationTypes.MOVE_TO, meleeArgs, false);
      if (!mcheck || mcheck.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused the attack");
      Game.UnitOperations.sendRequest(aUnitId, UnitOperationTypes.MOVE_TO, meleeArgs);
      sent = true;
    }
    if (!sent) return refuse("ACTION_NOT_STARTABLE", "no attack was dispatched");
    result.outcome = "sent";
    let left = null; try { left = attacker.Combat.attacksRemaining; } catch (e) { left = null; }
    result.readback = { kind: KIND, arg: ARG, target: { x: ARG2, y: ARG3 }, ranged: isRanged, attacksBefore: PRE,
      attacksRemaining: isInt(left) ? left : null, matches: isInt(left) && left < PRE };
    return JSON.stringify(result);
  }
  if (KIND === "ASSIGN_WORKER") {
    if (!isInt(ARG) || !isInt(ARG2)) return refuse("UNKNOWN_ACTION", "specialist arguments are not integers");
    if (!isInt(PlayerOperationTypes[OP_KIND])) return refuse("API_CONTRACT_MISMATCH", "operation type unavailable");
    let wcity = null;
    try { for (const c of player.Cities.getCities()) { if (c && c.id && c.id.id === ARG && c.id.owner === BOUND_PLAYER_ID) { wcity = c; break; } } } catch (e) { wcity = null; }
    if (!wcity || !wcity.Workers) return refuse("UNKNOWN_ACTION", "settlement is not in the bound player's roster");
    if (!(wcity.Growth && wcity.Growth.isReadyToPlacePopulation === true)) return refuse("ACTION_EXPIRED", "the settlement has no population point to place");
    let placements = null; try { placements = wcity.Workers.GetAllPlacementInfo(); } catch (e) { placements = null; }
    if (!Array.isArray(placements)) return refuse("API_CONTRACT_MISMATCH", "the settlement's worker placement info is unavailable");
    let slot = null;
    for (const q of placements) { if (q && q.PlotIndex === ARG2) { slot = q; break; } }
    if (!slot) return refuse("UNKNOWN_ACTION", "the plot is not one this settlement can work");
    if (slot.IsBlocked === true) return refuse("ACTION_NOT_STARTABLE", "the plot is blocked for this settlement");
    if (slot.NumWorkers !== PRE) return refuse("ACTION_EXPIRED", "the plot's specialists changed since the offer was made");
    const workerArgs = { Location: ARG2, Amount: 1 };
    const wcheck = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND], workerArgs, false);
    if (!wcheck || wcheck.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused the assignment");
    Game.PlayerOperations.sendRequest(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND], workerArgs);
    result.outcome = "sent";
    let after = null;
    try { for (const q of wcity.Workers.GetAllPlacementInfo()) { if (q && q.PlotIndex === ARG2) { after = q.NumWorkers; break; } } } catch (e) { after = null; }
    result.readback = { kind: KIND, arg: ARG, plotIndex: ARG2, workersBefore: PRE, workers: isInt(after) ? after : null, matches: isInt(after) && after > PRE };
    return JSON.stringify(result);
  }
  if (KIND === "DISBAND_UNIT") {
    if (!isInt(ARG)) return refuse("UNKNOWN_ACTION", "disband argument is not an integer");
    if (typeof UnitCommandTypes === "undefined" || !isInt(UnitCommandTypes.DELETE)) return refuse("API_CONTRACT_MISMATCH", "UnitCommandTypes.DELETE unavailable");
    let doomed = null;
    try { for (const u of player.Units.getUnits()) { if (u && u.id && u.id.id === ARG && u.id.owner === BOUND_PLAYER_ID) { doomed = u; break; } } } catch (e) { doomed = null; }
    if (!doomed) return refuse("UNKNOWN_ACTION", "unit is not in the bound player's roster");
    let rosterBefore = null; try { rosterBefore = player.Units.getUnits().length; } catch (e) { rosterBefore = null; }
    if (rosterBefore !== PRE) return refuse("ACTION_EXPIRED", "the seat's units changed since the disband was offered");
    const unitId = doomed.id;
    const delArgs = { X: -9999, Y: -9999, UnitAbilityType: -1 };
    const dcheck = Game.UnitCommands.canStart(unitId, UnitCommandTypes.DELETE, delArgs, false);
    if (!dcheck || dcheck.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused the disband");
    Game.UnitCommands.sendRequest(unitId, UnitCommandTypes.DELETE, delArgs);
    result.outcome = "sent";
    let gone = null;
    try { gone = player.Units.getUnits().every((u) => !u || !u.id || u.id.id !== ARG); } catch (e) { gone = null; }
    result.readback = { kind: KIND, arg: ARG, unitsBefore: PRE, gone: gone, matches: gone === true };
    return JSON.stringify(result);
  }
  if (KIND === "FOUND_RELIGION") {
    if (!isInt(ARG)) return refuse("UNKNOWN_ACTION", "religion argument is not an integer");
    if (!isInt(PlayerOperationTypes[OP_KIND])) return refuse("API_CONTRACT_MISMATCH", "operation type unavailable");
    const rrow = GameInfo.Religions.lookup(ARG);
    if (!rrow || typeof rrow.ReligionType !== "string") return refuse("UNKNOWN_ACTION", "not a religion definition");
    let heldBefore = null; try { heldBefore = player.Religion.getReligionType(); } catch (e) { heldBefore = null; }
    if (heldBefore !== PRE) return refuse("ACTION_EXPIRED", "this seat's religion changed since the offer was made");
    const relArgs = { ReligionType: ARG };
    // the shipped belief picker sends the custom name alongside the type, at founding only
    if (typeof TEXT === "string" && TEXT.length > 0) relArgs.ReligionCustomName = TEXT;
    const rcheck = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND], relArgs, false);
    if (!rcheck || rcheck.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused founding that religion");
    Game.PlayerOperations.sendRequest(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND], relArgs);
    result.outcome = "sent";
    let heldAfter = null; try { heldAfter = player.Religion.getReligionType(); } catch (e) { heldAfter = null; }
    result.readback = { kind: KIND, arg: ARG, religion: isInt(heldAfter) ? heldAfter : null, matches: heldAfter === ARG };
    return JSON.stringify(result);
  }
  if (KIND === "ADD_BELIEF") {
    if (!isInt(ARG)) return refuse("UNKNOWN_ACTION", "belief argument is not an integer");
    if (!isInt(PlayerOperationTypes[OP_KIND])) return refuse("API_CONTRACT_MISMATCH", "operation type unavailable");
    const brow = GameInfo.Beliefs.lookup(ARG);
    if (!brow || typeof brow.BeliefType !== "string") return refuse("UNKNOWN_ACTION", "not a belief definition");
    let heldBefore = null; try { const v = player.Religion.getBeliefs(); heldBefore = Array.isArray(v) ? v.length : null; } catch (e) { heldBefore = null; }
    if (heldBefore !== PRE) return refuse("ACTION_EXPIRED", "this seat's beliefs changed since the offer was made");
    const belArgs = { BeliefType: ARG };
    const bcheck2 = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND], belArgs, false);
    if (!bcheck2 || bcheck2.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused that belief");
    Game.PlayerOperations.sendRequest(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND], belArgs);
    result.outcome = "sent";
    let heldNow = null; try { const v = player.Religion.getBeliefs(); heldNow = Array.isArray(v) ? v : null; } catch (e) { heldNow = null; }
    result.readback = { kind: KIND, arg: ARG, beliefsBefore: PRE, held: heldNow, matches: Array.isArray(heldNow) && heldNow.indexOf(ARG) !== -1 };
    return JSON.stringify(result);
  }
  if (KIND === "KEEP_CITY" || KIND === "RAZE_CITY" || KIND === "LIBERATE_CITY") {
    if (!isInt(ARG)) return refuse("UNKNOWN_ACTION", "settlement argument is not an integer");
    if (typeof CityCommandTypes === "undefined" || !isInt(CityCommandTypes.DESTROY)) return refuse("API_CONTRACT_MISMATCH", "CityCommandTypes.DESTROY unavailable");
    let captured = null;
    try { for (const c of player.Cities.getCities()) { if (c && c.id && c.id.id === ARG && c.id.owner === BOUND_PLAYER_ID) { captured = c; break; } } } catch (e) { captured = null; }
    if (!captured) return refuse("UNKNOWN_ACTION", "settlement is not in the bound player's roster");
    if (!captured.isJustConqueredFrom) return refuse("ACTION_EXPIRED", "the settlement's capture has already been decided");
    const capturedId = captured.id;
    const dispArgs = { Directive: KIND === "KEEP_CITY" ? 2 : (KIND === "RAZE_CITY" ? 3 : 0) };
    const dcheck = Game.CityCommands.canStart(capturedId, CityCommandTypes.DESTROY, dispArgs, false);
    if (!dcheck || dcheck.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused that disposition");
    Game.CityCommands.sendRequest(capturedId, CityCommandTypes.DESTROY, dispArgs);
    result.outcome = "sent";
    let stillPending = null, razing = null, stillOwned = null;
    try { stillOwned = player.Cities.getCities().some((c) => c && c.id && c.id.id === ARG); stillPending = stillOwned ? !!captured.isJustConqueredFrom : null; razing = stillOwned ? captured.isBeingRazed === true : null; } catch (e) { /* unknown */ }
    result.readback = { kind: KIND, arg: ARG, directive: dispArgs.Directive, stillPending: stillPending, razing: razing, stillOwned: stillOwned,
      matches: KIND === "KEEP_CITY" ? stillPending === false && razing === false : (KIND === "RAZE_CITY" ? razing === true : stillOwned === false) };
    return JSON.stringify(result);
  }
  if (KIND === "CHOOSE_CITY_STATE_BONUS") {
    if (!isInt(ARG) || !isInt(ARG2)) return refuse("UNKNOWN_ACTION", "bonus arguments are not integers");
    if (!isInt(PlayerOperationTypes[OP_KIND])) return refuse("API_CONTRACT_MISMATCH", "operation type unavailable");
    if (typeof Game.CityStates === "undefined") return refuse("API_CONTRACT_MISMATCH", "Game.CityStates unavailable");
    let pendingCs = null; try { pendingCs = Game.CityStates.getCityStateBonusToSelect(BOUND_PLAYER_ID); } catch (e) { pendingCs = null; }
    if (pendingCs !== PRE || pendingCs !== ARG2) return refuse("ACTION_EXPIRED", "that city-state's bonus is no longer the one pending");
    const brow = GameInfo.CityStateBonuses.lookup(ARG);
    if (!brow || typeof brow.CityStateBonusType !== "string") return refuse("UNKNOWN_ACTION", "not a city-state bonus definition");
    const bonusArgs = { OtherPlayer: ARG2, CityStateBonusType: ARG };
    const bcheck = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND], bonusArgs, false);
    if (!bcheck || bcheck.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused that bonus");
    Game.PlayerOperations.sendRequest(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND], bonusArgs);
    result.outcome = "sent";
    let after = null; try { after = Game.CityStates.getCityStateBonusToSelect(BOUND_PLAYER_ID); } catch (e) { after = null; }
    result.readback = { kind: KIND, arg: ARG, cityState: ARG2, pendingAfter: isInt(after) ? after : null, matches: isInt(after) && after !== ARG2 };
    return JSON.stringify(result);
  }
  if (KIND === "SUPPORT_DIPLOMATIC_ACTION") {
    if (!isInt(ARG) || !isInt(ARG2)) return refuse("UNKNOWN_ACTION", "support arguments are not integers");
    if (!isInt(PlayerOperationTypes[OP_KIND])) return refuse("API_CONTRACT_MISMATCH", "operation type unavailable");
    if (typeof DiplomacyTokenTypes === "undefined" || !isInt(DiplomacyTokenTypes.DIPLOMACY_TOKEN_GLOBAL)) return refuse("API_CONTRACT_MISMATCH", "diplomacy token types unavailable");
    let sInfluenceBefore = null; try { const v = player.DiplomacyTreasury.diplomacyBalance; sInfluenceBefore = typeof v === "number" ? Math.floor(v) : null; } catch (e) { sInfluenceBefore = null; }
    if (sInfluenceBefore !== PRE) return refuse("ACTION_EXPIRED", "the seat's influence changed since the offer was made");
    let sEvent = null; try { for (const ev of Game.Diplomacy.getPlayerEvents(BOUND_PLAYER_ID)) { if (ev && ev.uniqueID === ARG) { sEvent = ev; break; } } } catch (e) { sEvent = null; }
    if (!sEvent) return refuse("ACTION_EXPIRED", "that diplomatic action is no longer among this seat's events");
    const supportArgs = { ID: ARG, Type: DiplomacyTokenTypes.DIPLOMACY_TOKEN_GLOBAL, Amount: 1, SubType: ARG2 === 1 };
    const scheck2 = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND], supportArgs, false);
    if (!scheck2 || scheck2.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused the support");
    Game.PlayerOperations.sendRequest(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND], supportArgs);
    result.outcome = "sent";
    let sInfluenceAfter = null; try { const v = player.DiplomacyTreasury.diplomacyBalance; sInfluenceAfter = typeof v === "number" ? Math.floor(v) : null; } catch (e) { sInfluenceAfter = null; }
    result.readback = { kind: KIND, arg: ARG, side: ARG2 === 1 ? "initiator" : "target", influenceBefore: PRE, influence: sInfluenceAfter, matches: isInt(sInfluenceAfter) && sInfluenceAfter < PRE };
    return JSON.stringify(result);
  }
  if (KIND === "VIEWED_ADVISOR_WARNING") {
    if (!isInt(ARG) || !isInt(ARG2)) return refuse("UNKNOWN_ACTION", "notification arguments are not integers");
    if (!isInt(PlayerOperationTypes[OP_KIND])) return refuse("API_CONTRACT_MISMATCH", "operation type unavailable");
    let warning = null;
    try { for (const nid of Game.Notifications.getIdsForPlayer(BOUND_PLAYER_ID)) { if (nid && nid.id === ARG && nid.type === ARG2) { warning = nid; break; } } } catch (e) { warning = null; }
    if (!warning) return refuse("ACTION_EXPIRED", "that warning is no longer pending");
    const ackArgs = { Target: warning };
    const acheck = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND], ackArgs, false);
    if (!acheck || acheck.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused the acknowledgement");
    Game.PlayerOperations.sendRequest(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND], ackArgs);
    result.outcome = "sent";
    let gone = null; try { gone = !Game.Notifications.getIdsForPlayer(BOUND_PLAYER_ID).some((nid) => nid && nid.id === ARG && nid.type === ARG2); } catch (e) { gone = null; }
    result.readback = { kind: KIND, arg: ARG, gone: gone, matches: gone === true };
    return JSON.stringify(result);
  }
  if (KIND === "START_DIPLOMATIC_ACTION") {
    if (!isInt(ARG) || !isInt(ARG2)) return refuse("UNKNOWN_ACTION", "diplomacy arguments are not integers");
    if (ARG === BOUND_PLAYER_ID) return refuse("UNKNOWN_ACTION", "a seat cannot target itself");
    if (typeof Game.Diplomacy === "undefined" || typeof Game.Diplomacy.getProjectDataForUI !== "function" ||
        typeof DiplomacyProjectStatus === "undefined" || typeof DiplomacyActionTargetTypes === "undefined" || typeof DiplomacyActionGroups === "undefined") {
      return refuse("API_CONTRACT_MISMATCH", "the diplomacy project listing is unavailable");
    }
    let hasMet = null; try { hasMet = player.Diplomacy.hasMet(ARG); } catch (e) { hasMet = null; }
    if (hasMet !== true) return refuse("UNKNOWN_ACTION", "the target is not a civilization this seat has met");
    let influenceBefore = null; try { const v = player.DiplomacyTreasury.diplomacyBalance; influenceBefore = typeof v === "number" ? Math.floor(v) : null; } catch (e) { influenceBefore = null; }
    if (influenceBefore !== PRE) return refuse("ACTION_EXPIRED", "the seat's influence changed since the action was offered");
    let wasAtWar = null, wasAllied = null;
    try { wasAtWar = player.Diplomacy.isAtWarWith(ARG) === true; wasAllied = player.Diplomacy.hasAllied(ARG) === true; } catch (e) { wasAtWar = null; wasAllied = null; }
    // The operation is never named by the caller: it is read back out of the engine's own current
    // listing for this target, and only for a project the engine still reports as available.
    let listing = null;
    try { listing = Game.Diplomacy.getProjectDataForUI(BOUND_PLAYER_ID, ARG, DiplomacyActionTargetTypes.NO_DIPLOMACY_TARGET, DiplomacyActionGroups.NO_DIPLOMACY_ACTION_GROUP, -1, DiplomacyActionTargetTypes.NO_DIPLOMACY_TARGET); } catch (e) { listing = null; }
    if (!Array.isArray(listing)) return refuse("API_CONTRACT_MISMATCH", "the diplomacy project listing did not return an array");
    let project = null;
    for (const d of listing) { if (d && d.actionType === ARG2 && d.projectStatus === DiplomacyProjectStatus.PROJECT_AVAILABLE) { project = d; break; } }
    if (!project) return refuse("ACTION_EXPIRED", "the action is no longer available against this target");
    const dTarget = Array.isArray(project.targetList1) ? project.targetList1.find((t) => t && t.targetID === ARG) : null;
    if (!dTarget || typeof dTarget.costYieldD !== "number") return refuse("ACTION_EXPIRED", "the action no longer has a price against this target");
    let second = null;
    if (isInt(ARG3) && ARG3 !== 0) {
      const list2 = Array.isArray(project.targetList2) ? project.targetList2 : [];
      for (const t2 of list2) { if (t2 && t2.targetID === ARG3 && typeof t2.parameterName === "string") { second = t2; break; } }
      if (!second) return refuse("ACTION_EXPIRED", "the secondary target is no longer offered for this action");
    }
    const withSecond = (shape) => {
      if (!second) return shape;
      const out = Object.assign({}, shape);
      out[["Player3", "Amount2", "Unit", "City"].indexOf(second.parameterName) !== -1 ? second.parameterName : "ID2"] = ARG3;
      return out;
    };
    let diploArgs = null;
    for (const shape of [withSecond({ Amount: 1, Player1: BOUND_PLAYER_ID, Type: ARG2, Player2: ARG }), withSecond({ Amount: 1, Player1: BOUND_PLAYER_ID, Type: ARG2, ID: ARG })]) {
      const probe = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, project.operationType, shape, false);
      if (probe && probe.Success === true) { diploArgs = shape; break; }
    }
    if (!diploArgs) return refuse("ACTION_NOT_STARTABLE", "native canStart refused the diplomatic action");
    Game.PlayerOperations.sendRequest(BOUND_PLAYER_ID, project.operationType, diploArgs);
    result.outcome = "sent";
    let influenceAfter = null; try { const v = player.DiplomacyTreasury.diplomacyBalance; influenceAfter = typeof v === "number" ? Math.floor(v) : null; } catch (e) { influenceAfter = null; }
    let nowAtWar = null, nowAllied = null;
    try { nowAtWar = player.Diplomacy.isAtWarWith(ARG) === true; nowAllied = player.Diplomacy.hasAllied(ARG) === true; } catch (e) { nowAtWar = null; nowAllied = null; }
    // the action's own event among this seat's actions against them: the identity a free project leaves
    let eventsNow = null; try { eventsNow = 0; for (const ev of Game.Diplomacy.getPlayerEvents(ARG)) { if (ev && ev.initialPlayer === BOUND_PLAYER_ID && ev.actionType === ARG2) eventsNow++; } } catch (e) { eventsNow = null; }
    result.readback = { kind: KIND, arg: ARG, actionType: ARG2, secondary: second ? { parameter: second.parameterName, id: ARG3 } : null, influenceBefore: PRE, influence: influenceAfter,
      wasAtWar: wasAtWar, atWar: nowAtWar, wasAllied: wasAllied, allied: nowAllied, events: eventsNow,
      matches: (isInt(influenceAfter) && influenceAfter < PRE) || (wasAtWar === false && nowAtWar === true) || (wasAllied === false && nowAllied === true) || (isInt(eventsNow) && eventsNow > 0) };
    return JSON.stringify(result);
  }
  if (KIND === "RESPOND_DIPLOMATIC_ACTION") {
    if (!isInt(ARG) || !isInt(ARG2)) return refuse("UNKNOWN_ACTION", "response arguments are not integers");
    if (!isInt(PlayerOperationTypes[OP_KIND])) return refuse("API_CONTRACT_MISMATCH", "operation type unavailable");
    if (typeof DiplomaticResponseTypes === "undefined" || (ARG2 !== DiplomaticResponseTypes.DIPLOMACY_RESPONSE_ACCEPT && ARG2 !== DiplomaticResponseTypes.DIPLOMACY_RESPONSE_REJECT)) return refuse("UNKNOWN_ACTION", "response is neither accept nor reject");
    let pending = null;
    try { for (const ev of Game.Diplomacy.getPlayerEvents(BOUND_PLAYER_ID)) { if (ev && ev.uniqueID === ARG && ev.targetPlayer === BOUND_PLAYER_ID) { pending = ev; break; } } } catch (e) { pending = null; }
    if (!pending) return refuse("ACTION_EXPIRED", "no proposal with that id is pending for this seat");
    if (pending.responseType !== DiplomaticResponseTypes.INVALID_RESPONSE) return refuse("ACTION_EXPIRED", "that proposal has already been answered");
    const respArgs = { ID: ARG, Type: ARG2 };
    const rcheck = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND], respArgs, false);
    if (!rcheck || rcheck.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused the response");
    Game.PlayerOperations.sendRequest(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND], respArgs);
    result.outcome = "sent";
    let recorded = null;
    try { for (const ev of Game.Diplomacy.getPlayerEvents(BOUND_PLAYER_ID)) { if (ev && ev.uniqueID === ARG) { recorded = isInt(ev.responseType) ? ev.responseType : null; break; } } } catch (e) { recorded = null; }
    result.readback = { kind: KIND, arg: ARG, response: ARG2, recordedResponse: recorded, matches: recorded === ARG2 };
    return JSON.stringify(result);
  }
  if (KIND === "DECLARE_WAR") {
    if (!isInt(ARG) || !isInt(ARG2)) return refuse("UNKNOWN_ACTION", "call-to-arms arguments are not integers");
    if (ARG === BOUND_PLAYER_ID) return refuse("UNKNOWN_ACTION", "a seat cannot declare war on itself");
    if (!isInt(PlayerOperationTypes[OP_KIND])) return refuse("API_CONTRACT_MISMATCH", "operation type unavailable");
    if (typeof DiplomacyActionTypes === "undefined" || !isInt(DiplomacyActionTypes.DIPLOMACY_ACTION_DECLARE_WAR)) return refuse("API_CONTRACT_MISMATCH", "the war action type is unavailable");
    let callNow = -1; try { callNow = Game.Diplomacy.getNextCallToArms(BOUND_PLAYER_ID); } catch (e) { callNow = -1; }
    if (callNow !== PRE || callNow !== ARG2) return refuse("ACTION_EXPIRED", "that call to arms is no longer pending");
    let metEnemy = null; try { metEnemy = player.Diplomacy.hasMet(ARG); } catch (e) { metEnemy = null; }
    if (metEnemy !== true) return refuse("UNKNOWN_ACTION", "the enemy is not a civilization this seat has met");
    let atWarBefore = null; try { atWarBefore = player.Diplomacy.isAtWarWith(ARG) === true; } catch (e) { atWarBefore = null; }
    if (atWarBefore === true) return refuse("ACTION_EXPIRED", "this seat is already at war with them");
    const warArgs = { Player1: BOUND_PLAYER_ID, Player2: ARG, Type: DiplomacyActionTypes.DIPLOMACY_ACTION_DECLARE_WAR };
    const wcheck2 = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND], warArgs, false);
    if (!wcheck2 || wcheck2.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused joining the war");
    Game.PlayerOperations.sendRequest(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND], warArgs);
    result.outcome = "sent";
    let atWarAfter = null; try { atWarAfter = player.Diplomacy.isAtWarWith(ARG) === true; } catch (e) { atWarAfter = null; }
    result.readback = { kind: KIND, arg: ARG, callToArms: ARG2, wasAtWar: false, atWar: atWarAfter, matches: atWarAfter === true };
    return JSON.stringify(result);
  }
  if (KIND === "PROPOSE_PEACE" || KIND === "ACCEPT_PEACE" || KIND === "REJECT_PEACE") {
    if (!isInt(ARG)) return refuse("UNKNOWN_ACTION", "peace argument is not an integer");
    if (ARG === BOUND_PLAYER_ID) return refuse("UNKNOWN_ACTION", "a seat cannot make peace with itself");
    if (typeof Game.DiplomacyDeals === "undefined" || typeof DiplomacyDealDirection === "undefined" || typeof DiplomacyDealProposalActions === "undefined" ||
        typeof DiplomacyDealItemTypes === "undefined" || typeof DiplomacyDealItemAgreementTypes === "undefined") return refuse("API_CONTRACT_MISMATCH", "the deal interfaces are unavailable");
    let metOther = null; try { metOther = player.Diplomacy.hasMet(ARG); } catch (e) { metOther = null; }
    if (metOther !== true) return refuse("UNKNOWN_ACTION", "the target is not a civilization this seat has met");
    let warNow = null; try { warNow = player.Diplomacy.isAtWarWith(ARG) === true; } catch (e) { warNow = null; }
    if (warNow !== true) return refuse("ACTION_EXPIRED", "this seat is not at war with them");
    let pendingNow = null; try { pendingNow = Game.DiplomacyDeals.hasPendingDeal(BOUND_PLAYER_ID, ARG) === true; } catch (e) { pendingNow = null; }
    if (KIND === "PROPOSE_PEACE") {
      if (pendingNow !== false) return refuse("ACTION_EXPIRED", "a deal with them is already on the table");
      let canPeace = null; try { const r = player.Diplomacy.canMakePeaceWith(ARG); canPeace = r && typeof r === "object" ? r.Success === true : r === true; } catch (e) { canPeace = null; }
      if (canPeace !== true) return refuse("ACTION_NOT_STARTABLE", "the game does not allow peace with them yet");
      // The bounded workflow the shipped screen runs for a plain peace, step by step, checked between steps.
      const outgoing = { direction: DiplomacyDealDirection.OUTGOING, player1: BOUND_PLAYER_ID, player2: ARG };
      Game.DiplomacyDeals.clearWorkingDeal(outgoing);
      const peaceItem = { type: DiplomacyDealItemTypes.AGREEMENTS, agreementType: DiplomacyDealItemAgreementTypes.MAKE_PEACE };
      Game.DiplomacyDeals.addItemToWorkingDeal(outgoing, peaceItem);
      let draft = null; try { draft = Game.DiplomacyDeals.getWorkingDeal(outgoing); } catch (e) { draft = null; }
      const drafted = draft && Array.isArray(draft.itemIds) ? draft.itemIds.length : 0;
      if (drafted !== 1) return refuse("ACTION_NOT_STARTABLE", "the peace agreement could not be placed in the working deal (" + drafted + " items)");
      Game.DiplomacyDeals.sendWorkingDeal(outgoing, DiplomacyDealProposalActions.PROPOSED);
      result.outcome = "sent";
      let pendingAfter = null; try { pendingAfter = Game.DiplomacyDeals.hasPendingDeal(BOUND_PLAYER_ID, ARG) === true; } catch (e) { pendingAfter = null; }
      result.readback = { kind: KIND, arg: ARG, proposed: true, pending: pendingAfter, matches: pendingAfter === true };
      return JSON.stringify(result);
    }
    if (pendingNow !== true) return refuse("ACTION_EXPIRED", "no deal with them is on the table");
    // the deal is answered on the working-deal shape that held it when offered (arg2: 0 incoming, 1 outgoing)
    const incoming = ARG2 === 1 ? { direction: DiplomacyDealDirection.OUTGOING, player1: BOUND_PLAYER_ID, player2: ARG }
                                : { direction: DiplomacyDealDirection.INCOMING, player1: ARG, player2: BOUND_PLAYER_ID };
    let onTable = null, theirs = false;
    try { const d = Game.DiplomacyDeals.getWorkingDeal(incoming); onTable = d && Array.isArray(d.itemIds) ? d.itemIds.length : null;
      if (d && Array.isArray(d.itemIds)) for (const itemId of d.itemIds) { const it = Game.DiplomacyDeals.getWorkingDealItem(incoming, itemId); if (it && it.from === ARG) theirs = true; } } catch (e) { onTable = null; }
    if (!isInt(onTable) || onTable < 1) return refuse("ACTION_EXPIRED", "the incoming deal has no terms to answer");
    if (!theirs) return refuse("ACTION_EXPIRED", "the deal on the table is this seat's own proposal, not theirs to answer");
    const answer = KIND === "ACCEPT_PEACE" ? DiplomacyDealProposalActions.ACCEPTED : DiplomacyDealProposalActions.REJECTED;
    Game.DiplomacyDeals.sendWorkingDeal(incoming, answer);
    result.outcome = "sent";
    let pendingAfter = null, warAfter = null;
    try { pendingAfter = Game.DiplomacyDeals.hasPendingDeal(BOUND_PLAYER_ID, ARG) === true; } catch (e) { pendingAfter = null; }
    try { warAfter = player.Diplomacy.isAtWarWith(ARG) === true; } catch (e) { warAfter = null; }
    result.readback = { kind: KIND, arg: ARG, pending: pendingAfter, atWar: warAfter, matches: KIND === "ACCEPT_PEACE" ? warAfter === false : pendingAfter === false };
    return JSON.stringify(result);
  }
  if (KIND === "CANCEL_ALLIANCE") {
    if (!isInt(ARG)) return refuse("UNKNOWN_ACTION", "alliance argument is not an integer");
    if (ARG === BOUND_PLAYER_ID) return refuse("UNKNOWN_ACTION", "a seat cannot target itself");
    if (!isInt(PlayerOperationTypes[OP_KIND])) return refuse("API_CONTRACT_MISMATCH", "operation type unavailable");
    if (typeof DiplomacyActionTypes === "undefined" || !isInt(DiplomacyActionTypes.DIPLOMACY_ACTION_FORM_ALLIANCE)) return refuse("API_CONTRACT_MISMATCH", "the alliance action type is unavailable");
    let metTarget = null; try { metTarget = player.Diplomacy.hasMet(ARG); } catch (e) { metTarget = null; }
    if (metTarget !== true) return refuse("UNKNOWN_ACTION", "the target is not a civilization this seat has met");
    let alliedBefore = null; try { alliedBefore = player.Diplomacy.hasAllied(ARG) === true; } catch (e) { alliedBefore = null; }
    if (alliedBefore !== true) return refuse("ACTION_EXPIRED", "this seat is not allied with that civilization");
    const cancelArgs = { Player1: BOUND_PLAYER_ID, Player2: ARG, Type: DiplomacyActionTypes.DIPLOMACY_ACTION_FORM_ALLIANCE };
    const ccheck = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND], cancelArgs, false);
    if (!ccheck || ccheck.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused ending the alliance");
    Game.PlayerOperations.sendRequest(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND], cancelArgs);
    result.outcome = "sent";
    let alliedAfter = null; try { alliedAfter = player.Diplomacy.hasAllied(ARG) === true; } catch (e) { alliedAfter = null; }
    result.readback = { kind: KIND, arg: ARG, wasAllied: true, allied: alliedAfter, matches: alliedAfter === false };
    return JSON.stringify(result);
  }
  if (KIND === "PURCHASE_CONSTRUCTIBLE") {
    if (!isInt(ARG) || !isInt(ARG2) || !isInt(ARG3)) return refuse("UNKNOWN_ACTION", "purchase arguments are not integers");
    if (typeof CityCommandTypes === "undefined" || !isInt(CityCommandTypes.PURCHASE)) return refuse("API_CONTRACT_MISMATCH", "CityCommandTypes.PURCHASE unavailable");
    let bcity = null;
    try { for (const c of player.Cities.getCities()) { if (c && c.id && c.id.id === ARG && c.id.owner === BOUND_PLAYER_ID) { bcity = c; break; } } } catch (e) { bcity = null; }
    if (!bcity) return refuse("UNKNOWN_ACTION", "city is not in the bound player's roster");
    const crow = GameInfo.Constructibles.lookup(ARG2);
    if (!crow || typeof crow.ConstructibleType !== "string") return refuse("UNKNOWN_ACTION", "constructible type is not a constructible definition");
    const cloc = GameplayMap.getLocationFromIndex(ARG3);
    if (!cloc || !isInt(cloc.x) || !isInt(cloc.y) || cloc.x < 0) return refuse("UNKNOWN_ACTION", "plot index does not resolve to a plot");
    // Gold is the precondition here: a purchase that went through is one the treasury paid for, and
    // the treasury only moves on a mutation, so an unchanged balance means nothing happened.
    let goldBefore = null; try { const g = player.Treasury.goldBalance; goldBefore = typeof g === "number" ? Math.floor(g) : null; } catch (e) { goldBefore = null; }
    if (goldBefore !== PRE) return refuse("ACTION_EXPIRED", "the seat's treasury changed since the purchase was offered");
    const bCityId = bcity.id;
    const cbuyArgs = { ConstructibleType: ARG2, X: cloc.x, Y: cloc.y };
    const cbcheck = Game.CityCommands.canStart(bCityId, CityCommandTypes.PURCHASE, cbuyArgs, false);
    if (!cbcheck || cbcheck.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused the purchase");
    Game.CityCommands.sendRequest(bCityId, CityCommandTypes.PURCHASE, cbuyArgs);
    result.outcome = "sent";
    let goldAfter = null; try { const g = player.Treasury.goldBalance; goldAfter = typeof g === "number" ? Math.floor(g) : null; } catch (e) { goldAfter = null; }
    // the building standing in the settlement is the identity proof; the treasury alone is not
    let placed = null; try { if (bcity.Constructibles && typeof bcity.Constructibles.getIds === "function") { placed = false; for (const cid of bcity.Constructibles.getIds()) { const inst = typeof Constructibles.getByComponentID === "function" ? Constructibles.getByComponentID(cid) : Constructibles.get(cid); if (inst && inst.type === ARG2) placed = true; } } } catch (e) { placed = null; }
    result.readback = { kind: KIND, arg: ARG, constructibleType: ARG2, plotIndex: ARG3, goldBefore: PRE, gold: goldAfter, placed: placed, matches: isInt(goldAfter) && goldAfter < PRE && placed === true };
    return JSON.stringify(result);
  }
  if (KIND === "UPGRADE_TOWN") {
    if (!isInt(ARG)) return refuse("UNKNOWN_ACTION", "upgrade argument is not an integer");
    if (typeof CityCommandTypes === "undefined" || !isInt(CityCommandTypes.PURCHASE)) return refuse("API_CONTRACT_MISMATCH", "CityCommandTypes.PURCHASE unavailable");
    if (typeof OrderTypes === "undefined" || !isInt(OrderTypes.ORDER_TOWN_UPGRADE)) return refuse("API_CONTRACT_MISMATCH", "OrderTypes.ORDER_TOWN_UPGRADE unavailable");
    let town = null;
    try { for (const c of player.Cities.getCities()) { if (c && c.id && c.id.id === ARG && c.id.owner === BOUND_PLAYER_ID) { town = c; break; } } } catch (e) { town = null; }
    if (!town) return refuse("UNKNOWN_ACTION", "settlement is not in the bound player's roster");
    if (town.isTown !== true) return refuse("ACTION_EXPIRED", "the settlement is already a city");
    let upGoldBefore = null; try { const g = player.Treasury.goldBalance; upGoldBefore = typeof g === "number" ? Math.floor(g) : null; } catch (e) { upGoldBefore = null; }
    if (upGoldBefore !== PRE) return refuse("ACTION_EXPIRED", "the seat's treasury changed since the upgrade was offered");
    const townId = town.id;
    const upArgs = { Directive: OrderTypes.ORDER_TOWN_UPGRADE };
    const upcheck = Game.CityCommands.canStart(townId, CityCommandTypes.PURCHASE, upArgs, false);
    if (!upcheck || upcheck.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused the upgrade");
    Game.CityCommands.sendRequest(townId, CityCommandTypes.PURCHASE, upArgs);
    result.outcome = "sent";
    let stillTown = null; try { stillTown = town.isTown === true; } catch (e) { stillTown = null; }
    result.readback = { kind: KIND, arg: ARG, wasTown: true, isTown: stillTown, matches: stillTown === false };
    return JSON.stringify(result);
  }
  if (KIND === "PURCHASE_UNIT") {
    if (!isInt(ARG) || !isInt(ARG2)) return refuse("UNKNOWN_ACTION", "purchase arguments are not integers");
    if (typeof CityCommandTypes === "undefined" || !isInt(CityCommandTypes.PURCHASE)) return refuse("API_CONTRACT_MISMATCH", "CityCommandTypes.PURCHASE unavailable");
    let city = null;
    try { for (const c of player.Cities.getCities()) { if (c && c.id && c.id.id === ARG && c.id.owner === BOUND_PLAYER_ID) { city = c; break; } } } catch (e) { city = null; }
    if (!city) return refuse("UNKNOWN_ACTION", "city is not in the bound player's roster");
    const urow = GameInfo.Units.lookup(ARG2);
    if (!urow || typeof urow.UnitType !== "string") return refuse("UNKNOWN_ACTION", "unit type is not a unit definition");
    let before = null; try { before = player.Units.getUnits().length; } catch (e) { before = null; }
    if (before !== PRE) return refuse("ACTION_EXPIRED", "the seat's units changed since the purchase was offered");
    const cityId = city.id;
    const buyArgs = { UnitType: ARG2 };
    const pcheck = Game.CityCommands.canStart(cityId, CityCommandTypes.PURCHASE, buyArgs, false);
    if (!pcheck || pcheck.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused the purchase");
    Game.CityCommands.sendRequest(cityId, CityCommandTypes.PURCHASE, buyArgs);
    result.outcome = "sent";
    let after = null, ofType = null; try { const all = player.Units.getUnits(); after = all.length; ofType = all.filter((u) => u && u.type === ARG2).length; } catch (e) { after = null; ofType = null; }
    // the roster growing is not proof of this purchase; one more unit of the bought type is
    result.readback = { kind: KIND, arg: ARG, unitType: ARG2, unitsBefore: PRE, units: after, ofType: ofType, matches: isInt(after) && after > PRE && isInt(ofType) && ofType > 0 };
    return JSON.stringify(result);
  }
  if (KIND === "PRODUCE_PROJECT") {
    if (!isInt(ARG) || !isInt(ARG2)) return refuse("UNKNOWN_ACTION", "project arguments are not integers");
    if (typeof CityOperationTypes === "undefined" || !isInt(CityOperationTypes.BUILD)) return refuse("API_CONTRACT_MISMATCH", "CityOperationTypes.BUILD unavailable");
    let pcity = null;
    try { for (const c of player.Cities.getCities()) { if (c && c.id && c.id.id === ARG && c.id.owner === BOUND_PLAYER_ID) { pcity = c; break; } } } catch (e) { pcity = null; }
    if (!pcity) return refuse("UNKNOWN_ACTION", "city is not in the bound player's roster");
    const projRow = GameInfo.Projects.lookup(ARG2);
    if (!projRow || typeof projRow.ProjectType !== "string") return refuse("UNKNOWN_ACTION", "project type is not a project definition");
    const pqueue = pcity.BuildQueue && typeof pcity.BuildQueue.getQueue === "function" ? pcity.BuildQueue.getQueue() : null;
    if (!Array.isArray(pqueue) || pqueue.length !== PRE) return refuse("ACTION_EXPIRED", "the city's build queue changed since the project was offered");
    const pCityId = pcity.id;
    const buildArgs = { ProjectType: ARG2 };
    const pcheck = Game.CityOperations.canStart(pCityId, CityOperationTypes.BUILD, buildArgs, false);
    if (!pcheck || pcheck.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused the project");
    Game.CityOperations.sendRequest(pCityId, CityOperationTypes.BUILD, buildArgs);
    result.outcome = "sent";
    let pafter = null; try { pafter = pcity.BuildQueue.getQueue(); } catch (e) { pafter = null; }
    const queuedP = Array.isArray(pafter) && pafter.length > PRE && pafter[PRE] && pafter[PRE].type === ARG2;
    result.readback = { kind: KIND, arg: ARG, projectType: ARG2, queuedAt: PRE, queueLength: Array.isArray(pafter) ? pafter.length : null, matches: queuedP };
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
    const uqueue = city.BuildQueue && typeof city.BuildQueue.getQueue === "function" ? city.BuildQueue.getQueue() : null;
    if (!Array.isArray(uqueue) || uqueue.length !== PRE) return refuse("ACTION_EXPIRED", "the city's build queue changed since the build was offered");
    const cityId = city.id;
    const buildArgs = { UnitType: ARG2 };
    const bcheck = Game.CityOperations.canStart(cityId, CityOperationTypes.BUILD, buildArgs, false);
    if (!bcheck || bcheck.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused the build");
    Game.CityOperations.sendRequest(cityId, CityOperationTypes.BUILD, buildArgs);
    result.outcome = "sent";
    let uafter = null; try { uafter = city.BuildQueue.getQueue(); } catch (e) { uafter = null; }
    const queuedU = Array.isArray(uafter) && uafter.length > PRE && uafter[PRE] && uafter[PRE].type === ARG2;
    result.readback = { kind: KIND, arg: ARG, unitType: ARG2, queuedAt: PRE, queueLength: Array.isArray(uafter) ? uafter.length : null, matches: queuedU };
    return JSON.stringify(result);
  }
  if (KIND === "CHANGE_TRADITION") {
    if (!isInt(ARG) || !isInt(ARG2)) return refuse("UNKNOWN_ACTION", "tradition arguments are not integers");
    if (!isInt(PlayerOperationTypes[OP_KIND]) || typeof CultureSlotTypes === "undefined" || typeof PlayerOperationParameters === "undefined" || !isInt(PlayerOperationParameters.Activate)) return refuse("API_CONTRACT_MISMATCH", "tradition operation contract unavailable");
    const trow = GameInfo.Traditions.lookup(ARG2);
    if (!trow || trow.$index !== ARG) return refuse("UNKNOWN_ACTION", "tradition identity does not match the offer");
    const cu = player.Culture;
    const st = CultureSlotTypes[trow.CultureSlotType];
    if (!isInt(st)) return refuse("API_CONTRACT_MISMATCH", "tradition slot type unavailable");
    let activeCount = null; try { activeCount = cu.getActiveTraditions(st).length; } catch (e) { activeCount = null; }
    if (activeCount !== PRE) return refuse("ACTION_EXPIRED", "the slots of that type changed since the offer was made");
    if (cu.isTraditionActive(ARG2) === true) return refuse("ACTION_EXPIRED", "that tradition is already active");
    const args = { TraditionType: ARG, Action: PlayerOperationParameters.Activate };
    const check = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND], args, false);
    if (!check || check.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused activating the tradition");
    Game.PlayerOperations.sendRequest(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND], args);
    result.outcome = "sent";
    let nowActive = null; try { nowActive = cu.isTraditionActive(ARG2) === true; } catch (e) { nowActive = null; }
    result.readback = { kind: KIND, arg: ARG, tradition: ARG2, active: nowActive, matches: nowActive === true };
    return JSON.stringify(result);
  }
  if (KIND === "CONSIDER_ASSIGN_TRADITIONS") {
    if (!isInt(PlayerOperationTypes[OP_KIND])) return refuse("API_CONTRACT_MISMATCH", "operation type unavailable");
    const args = {};
    const check = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND], args, false);
    if (!check || check.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused confirming traditions");
    Game.PlayerOperations.sendRequest(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND], args);
    result.outcome = "sent";
    let bt = null; try { bt = Game.Notifications.getEndTurnBlockingType(BOUND_PLAYER_ID); } catch (e) { bt = null; }
    const bname = (v) => { try { for (const k of Object.keys(EndTurnBlockingTypes)) if (EndTurnBlockingTypes[k] === v) return k; } catch (e) { /* fall through */ } return null; };
    result.readback = { kind: KIND, arg: 0, blocking: isInt(bt) ? bname(bt) : null, matches: isInt(bt) && bname(bt) !== "TRADITIONS" };
    return JSON.stringify(result);
  }
  if (KIND === "ASSIGN_RESOURCE") {
    if (!isInt(ARG) || !isInt(ARG2)) return refuse("UNKNOWN_ACTION", "resource arguments are not integers");
    if (!isInt(PlayerOperationTypes[OP_KIND]) || !player.Resources || typeof player.Resources.getResources !== "function") return refuse("API_CONTRACT_MISMATCH", "resource operation contract unavailable");
    let own = false; try { for (const r of player.Resources.getResources()) { if (r && r.value === ARG) { own = true; break; } } } catch (e) { own = false; }
    if (!own) return refuse("UNKNOWN_ACTION", "resource is not among the bound player's resources");
    let rcity = null; try { for (const c of player.Cities.getCities()) { if (c && c.id && c.id.id === ARG2 && c.id.owner === BOUND_PLAYER_ID) { rcity = c; break; } } } catch (e) { rcity = null; }
    if (!rcity) return refuse("UNKNOWN_ACTION", "city is not in the bound player's roster");
    let toAssign = null; try { toAssign = player.Resources.getCountResourcesToAssign(); } catch (e) { toAssign = null; }
    if ((isInt(toAssign) ? toAssign : 0) !== PRE) return refuse("ACTION_EXPIRED", "the number of resources to assign changed since the offer was made");
    const rloc = GameplayMap.getLocationFromIndex(ARG);
    if (!rloc || !isInt(rloc.x) || !isInt(rloc.y) || rloc.x < 0) return refuse("ACTION_NOT_STARTABLE", "resource plot is not a valid map plot");
    const args = { Location: { x: rloc.x, y: rloc.y }, City: ARG2 };
    const check = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND], args, false);
    if (!check || check.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused assigning that resource there");
    Game.PlayerOperations.sendRequest(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND], args);
    result.outcome = "sent";
    let now = -1; try { for (const ar of rcity.Resources.getAssignedResources()) { if (ar && ar.value === ARG) { now = ARG2; break; } } } catch (e) { now = -1; }
    result.readback = { kind: KIND, arg: ARG, city: ARG2, assignedTo: now, matches: now === ARG2 };
    return JSON.stringify(result);
  }
  if (KIND === "CONSIDER_ASSIGN_RESOURCE") {
    if (!isInt(PlayerOperationTypes[OP_KIND])) return refuse("API_CONTRACT_MISMATCH", "operation type unavailable");
    const args = {};
    const check = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND], args, false);
    if (!check || check.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused considering resources");
    Game.PlayerOperations.sendRequest(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND], args);
    result.outcome = "sent";
    result.readback = { kind: KIND, arg: 0, matches: false };
    return JSON.stringify(result);
  }
  if (KIND === "ADVANCED_START_MODIFY_DECK" || KIND === "ADVANCED_START_MARK_COMPLETED" || KIND === "ADVANCED_START_REMOVE_CARD" || KIND === "ADVANCED_START_PLACE_SETTLEMENT") {
    // Adding and putting back are both the one MODIFY_DECK operation, told apart by Type, so the deck
    // operation is reached by its literal name; the finish and a placement are their own operations.
    const deckOp = PlayerOperationTypes["ADVANCED_START_MODIFY_DECK"];
    if (!isInt(deckOp) || !isInt(PlayerOperationTypes.ADVANCED_START_USE_EFFECT) || !player.AdvancedStart) return refuse("API_CONTRACT_MISMATCH", "advanced start contract unavailable");
    if ((KIND === "ADVANCED_START_MARK_COMPLETED" || KIND === "ADVANCED_START_PLACE_SETTLEMENT") && !isInt(PlayerOperationTypes[OP_KIND])) return refuse("API_CONTRACT_MISMATCH", "advanced start operation unavailable");
    const A = player.AdvancedStart;
    // a deck entry wraps the card under `info`; an available card is the card itself
    const cardOf = (c) => (c && c.info ? c.info : c);
    let deck = null; try { deck = A.getCards(); } catch (e) { deck = null; }
    if (!Array.isArray(deck)) return refuse("API_CONTRACT_MISMATCH", "advanced start deck unavailable");
    const deckIds = deck.map((c) => cardOf(c) && cardOf(c).id).filter((x) => typeof x === "string");
    const deckNow = () => { try { return A.getCards().map((c) => cardOf(c) && cardOf(c).id); } catch (e) { return null; } };
    if (KIND === "ADVANCED_START_PLACE_SETTLEMENT") {
      if (!isInt(ARG) || !isInt(ARG2) || !isInt(ARG3)) return refuse("UNKNOWN_ACTION", "placement arguments are not integers");
      let effect = null;
      for (const d of deck) { const c = cardOf(d); if (!c || !Array.isArray(c.effects)) continue; for (const e of c.effects) { if (e && typeof e.id === "string" && e.isPlacementEffect === true && Database.makeHash(e.id) === ARG) effect = e; } }
      if (!effect) return refuse("UNKNOWN_ACTION", "effect is not a placement effect of a card in the deck");
      if (!isInt(effect.amount) || effect.amount !== PRE || PRE <= 0) return refuse("ACTION_EXPIRED", "the effect's remaining placements changed since the offer was made");
      const placeArgs = { ID: effect.id, X: ARG2, Y: ARG3 };
      const pcheck = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND], placeArgs, false);
      if (!pcheck || pcheck.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused placing the settlement there");
      Game.PlayerOperations.sendRequest(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND], placeArgs);
      result.outcome = "sent";
      let left = null; try { for (const d of A.getCards()) { const c = cardOf(d); for (const e of ((c && c.effects) || [])) { if (e && e.id === effect.id && isInt(e.amount)) left = e.amount; } } } catch (e) { left = null; }
      result.readback = { kind: KIND, arg: ARG, effect: effect.id, at: { x: ARG2, y: ARG3 }, remaining: left, matches: isInt(left) && left < PRE };
      return JSON.stringify(result);
    }
    if (deckIds.length !== PRE) return refuse("ACTION_EXPIRED", "the legacy deck changed since the offer was made");
    if (KIND === "ADVANCED_START_MODIFY_DECK") {
      if (!isInt(ARG)) return refuse("UNKNOWN_ACTION", "card argument is not an integer");
      let card = null; try { for (const c of A.getAvailableCards()) { if (c && typeof c.id === "string" && Database.makeHash(c.id) === ARG) { card = c; break; } } } catch (e) { card = null; }
      if (!card) return refuse("UNKNOWN_ACTION", "card is not among the seat's available legacy cards");
      if (deckIds.indexOf(card.id) !== -1) return refuse("ACTION_EXPIRED", "that card is already in the deck");
      const addArgs = { Type: "ADD", ID: card.id };
      const addCheck = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, deckOp, addArgs, false);
      if (!addCheck || addCheck.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused adding the card");
      Game.PlayerOperations.sendRequest(BOUND_PLAYER_ID, deckOp, addArgs);
      // The card's rewards are applied when the deck is finished, as the shipped screen does, so a card
      // can be put back for its points in the meantime without its reward having landed.
      result.outcome = "sent";
      const now = deckNow();
      result.readback = { kind: KIND, arg: ARG, card: card.id, deck: now, matches: Array.isArray(now) && now.indexOf(card.id) !== -1 };
      return JSON.stringify(result);
    }
    if (KIND === "ADVANCED_START_REMOVE_CARD") {
      if (!isInt(ARG)) return refuse("UNKNOWN_ACTION", "card argument is not an integer");
      let card = null; for (const d of deck) { const c = cardOf(d); if (c && typeof c.id === "string" && Database.makeHash(c.id) === ARG) { card = c; break; } }
      if (!card) return refuse("UNKNOWN_ACTION", "card is not in the deck");
      const removeArgs = { Type: "REMOVE", ID: card.id };
      const removeCheck = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, deckOp, removeArgs, false);
      if (!removeCheck || removeCheck.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused putting the card back");
      Game.PlayerOperations.sendRequest(BOUND_PLAYER_ID, deckOp, removeArgs);
      result.outcome = "sent";
      const now = deckNow();
      result.readback = { kind: KIND, arg: ARG, card: card.id, deck: now, matches: Array.isArray(now) && now.indexOf(card.id) === -1 };
      return JSON.stringify(result);
    }
    const markArgs = {};
    const markCheck = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND], markArgs, false);
    if (!markCheck || markCheck.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused finishing the deck");
    // Finishing takes every picked card's reward, as the shipped confirm does: ADVANCED_START_USE_EFFECT
    // once per effect per amount. The engine keeps reporting an applied effect as startable (live: an
    // applied effect still read true), so applying here, once, right before the mark that ends the
    // deck, is the only way each lands exactly once. Placement effects are not rewards to apply: an
    // unplaced one becomes a plain settler when the deck is marked complete.
    let applied = 0;
    for (const d of deck) {
      const c = cardOf(d);
      for (const e of ((c && c.effects) || [])) {
        if (!e || typeof e.id !== "string" || e.isPlacementEffect === true) continue;
        const times = isInt(e.amount) && e.amount > 0 ? e.amount : 1;
        for (let i = 0; i < times; i++) {
          const u = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes.ADVANCED_START_USE_EFFECT, { ID: e.id }, false);
          if (!u || u.Success !== true) break;
          Game.PlayerOperations.sendRequest(BOUND_PLAYER_ID, PlayerOperationTypes.ADVANCED_START_USE_EFFECT, { ID: e.id });
          applied += 1;
        }
      }
    }
    Game.PlayerOperations.sendRequest(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND], markArgs);
    result.outcome = "sent";
    result.readback = { kind: KIND, arg: 0, effectsApplied: applied, matches: false };
    return JSON.stringify(result);
  }
  if (KIND === "MOVE_GREAT_WORK") {
    if (!isInt(ARG) || !isInt(ARG2) || !isInt(ARG3)) return refuse("UNKNOWN_ACTION", "great work arguments are not integers");
    if (!isInt(PlayerOperationTypes[OP_KIND]) || !player.Culture) return refuse("API_CONTRACT_MISMATCH", "great works unavailable");
    const idOf = (v) => (isInt(v) ? v : (v && isInt(v.id) ? v.id : null));
    const slotsOf = () => { const m = {}; try { for (const c of player.Cities.getCities()) { if (!c || !c.id || !c.Constructibles || typeof c.Constructibles.getGreatWorkBuildings !== "function") continue; const list = []; for (const b of (c.Constructibles.getGreatWorkBuildings() || [])) { for (const sl of ((b && b.slots) || [])) { if (sl && isInt(sl.greatWorkIndex) && sl.greatWorkIndex >= 0) list.push(sl.greatWorkIndex); } } m[String(c.id.id)] = list; } } catch (e) { /* partial */ } return m; };
    let source = null; const before = slotsOf();
    for (const cid of Object.keys(before)) { if (before[cid].indexOf(ARG) !== -1) source = parseInt(cid, 10); }
    if (source === null) { try { const n = player.Culture.getNumWorksInArchive(); for (let i = 0; i < n; i++) { if (player.Culture.getArchivedGreatWork(i) === ARG) source = -1; } } catch (e) { /* none */ } }
    if (source === null) return refuse("UNKNOWN_ACTION", "great work is not held by this seat");
    if (source !== PRE) return refuse("ACTION_EXPIRED", "the great work moved since the offer was made");
    // ARG3 is the destination building's constructible TYPE, as the shipped screen sends it
    const typeOf = (cid) => { try { const inst = typeof Constructibles.getByComponentID === "function" ? Constructibles.getByComponentID(cid) : Constructibles.get(cid); return inst && isInt(inst.type) ? inst.type : null; } catch (e) { return null; } };
    let dest = false; try { for (const c of player.Cities.getCities()) { if (!c || !c.id || c.id.id !== ARG2 || !c.Constructibles) continue; for (const b of (c.Constructibles.getGreatWorkBuildings() || [])) { const btype = typeOf(b.constructibleID !== undefined ? b.constructibleID : b.id); if (btype === ARG3 && (b.slots || []).some((sl) => !sl || !isInt(sl.greatWorkIndex) || sl.greatWorkIndex < 0)) dest = true; } } } catch (e) { dest = false; }
    if (!dest) return refuse("ACTION_NOT_STARTABLE", "no building of that type with an empty slot in that settlement");
    const gwArgs = { Player1: BOUND_PLAYER_ID, GreatWorkIndex: ARG, DestinationCity: ARG2, DestinationBuilding: ARG3 };
    if (PRE >= 0) gwArgs.SourceCity = PRE;
    const gwCheck = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND], gwArgs, false);
    if (!gwCheck || gwCheck.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused moving the great work");
    Game.PlayerOperations.sendRequest(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND], gwArgs);
    result.outcome = "sent";
    const after = slotsOf();
    result.readback = { kind: KIND, arg: ARG, destinationCity: ARG2, matches: Array.isArray(after[String(ARG2)]) && after[String(ARG2)].indexOf(ARG) !== -1 };
    return JSON.stringify(result);
  }
  if (KIND === "NAME_UNIT") {
    if (!isInt(ARG)) return refuse("UNKNOWN_ACTION", "unit argument is not an integer");
    if (typeof TEXT !== "string" || TEXT.length === 0) return refuse("UNKNOWN_ACTION", "a name is required");
    if (typeof UnitCommandTypes === "undefined" || !isInt(UnitCommandTypes[OP_KIND])) return refuse("API_CONTRACT_MISMATCH", "unit naming unavailable");
    let named = null;
    try { for (const u of player.Units.getUnits()) { if (u && u.id && u.id.id === ARG && u.id.owner === BOUND_PLAYER_ID) { named = u; break; } } } catch (e) { named = null; }
    if (!named) return refuse("UNKNOWN_ACTION", "unit is not in the bound player's roster");
    const nUnitId = named.id;
    const nameArgs = { Name: TEXT };
    const ncheck = Game.UnitCommands.canStart(nUnitId, UnitCommandTypes[OP_KIND], nameArgs, false);
    if (!ncheck || ncheck.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused naming the unit");
    Game.UnitCommands.sendRequest(nUnitId, UnitCommandTypes[OP_KIND], nameArgs);
    result.outcome = "sent";
    let now = null; try { now = typeof named.name === "string" ? named.name : null; } catch (e) { now = null; }
    result.readback = { kind: KIND, arg: ARG, name: now, matches: typeof now === "string" && now.indexOf(TEXT) !== -1 };
    return JSON.stringify(result);
  }
  if (KIND === "NAME_CITY") {
    if (!isInt(ARG)) return refuse("UNKNOWN_ACTION", "settlement argument is not an integer");
    if (typeof TEXT !== "string" || TEXT.length === 0) return refuse("UNKNOWN_ACTION", "a name is required");
    if (typeof CityCommandTypes === "undefined" || !isInt(CityCommandTypes[OP_KIND])) return refuse("API_CONTRACT_MISMATCH", "settlement naming unavailable");
    let settlement = null;
    try { for (const c of player.Cities.getCities()) { if (c && c.id && c.id.id === ARG && c.id.owner === BOUND_PLAYER_ID) { settlement = c; break; } } } catch (e) { settlement = null; }
    if (!settlement) return refuse("UNKNOWN_ACTION", "settlement is not in the bound player's roster");
    const nCityId = settlement.id;
    // the shipped header upper-cases the name before sending it
    const upper = (typeof Locale !== "undefined" && typeof Locale.toUpper === "function") ? Locale.toUpper(TEXT) : TEXT.toUpperCase();
    const cityNameArgs = { Name: upper };
    const ccheck = Game.CityCommands.canStart(nCityId, CityCommandTypes[OP_KIND], cityNameArgs, false);
    if (!ccheck || ccheck.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused naming the settlement");
    Game.CityCommands.sendRequest(nCityId, CityCommandTypes[OP_KIND], cityNameArgs);
    result.outcome = "sent";
    let now = null; try { now = typeof settlement.name === "string" ? settlement.name : null; } catch (e) { now = null; }
    result.readback = { kind: KIND, arg: ARG, name: now, matches: typeof now === "string" && now.toUpperCase().indexOf(upper.toUpperCase()) !== -1 };
    return JSON.stringify(result);
  }
  if (KIND === "SELECT_CAPITAL") {
    if (!isInt(ARG) || !isInt(ARG2)) return refuse("UNKNOWN_ACTION", "capital arguments are not integers");
    if (!isInt(PlayerOperationTypes[OP_KIND]) || !player.Cities || typeof player.Cities.getPotentialSwitchCapitalCityIds !== "function") return refuse("API_CONTRACT_MISMATCH", "capital selection unavailable");
    let capId = -1; try { const cap = player.Cities.getCapital(); capId = cap && cap.id && isInt(cap.id.id) ? cap.id.id : -1; } catch (e) { capId = -1; }
    if (capId !== PRE) return refuse("ACTION_EXPIRED", "the capital changed since the offer was made");
    let legal = false; try { for (const cid of player.Cities.getPotentialSwitchCapitalCityIds()) { if (cid && cid.id === ARG && cid.owner === BOUND_PLAYER_ID) legal = true; } } catch (e) { legal = false; }
    if (!legal) return refuse("ACTION_NOT_STARTABLE", "city is not among the legal new capitals");
    const swap = player.previousAgeCivilizationType !== player.civilizationType;
    if ((swap ? 1 : 0) !== ARG2) return refuse("ACTION_EXPIRED", "the capital's naming changed since the offer was made");
    const capArgs = { Player1: BOUND_PLAYER_ID, City: ARG, Swap: swap };
    const capCheck = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND], capArgs, false);
    if (!capCheck || capCheck.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused moving the capital");
    Game.PlayerOperations.sendRequest(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND], capArgs);
    result.outcome = "sent";
    let now = null; try { const cap = player.Cities.getCapital(); now = cap && cap.id && isInt(cap.id.id) ? cap.id.id : null; } catch (e) { now = null; }
    result.readback = { kind: KIND, arg: ARG, capitalCityId: now, matches: now === ARG };
    return JSON.stringify(result);
  }
  if (KIND === "CHOOSE_SYNCRETISM_UNITS" || KIND === "CHOOSE_SYNCRETISM_INFRASTRUCTURE" || KIND === "CHOOSE_SYNCRETISM_SELF") {
    if (!isInt(ARG)) return refuse("UNKNOWN_ACTION", "civilization argument is not an integer");
    if (!isInt(PlayerOperationTypes[OP_KIND]) || typeof SyncreticChoiceTypes === "undefined" || !Game.Unlocks || !player.Identity) return refuse("API_CONTRACT_MISMATCH", "syncretism unavailable");
    let chosen = -1; try { const ct = player.Identity.getSyncreticCivType(); chosen = isInt(ct) && GameInfo.Civilizations.lookup(ct) ? ct : -1; } catch (e) { chosen = -1; }
    if (chosen !== -1) return refuse("ACTION_EXPIRED", "a syncretic civilization is already chosen");
    const flagName = KIND === "CHOOSE_SYNCRETISM_UNITS" ? "SYNCRETIC_CHOICE_UNITS" : KIND === "CHOOSE_SYNCRETISM_INFRASTRUCTURE" ? "SYNCRETIC_CHOICE_INFRASTRUCTURE" : "SYNCRETIC_CHOICE_SELF";
    let civs = null; try { civs = Game.Unlocks.getSyncreticCivUnlocksForChoice(BOUND_PLAYER_ID, SyncreticChoiceTypes[flagName]); } catch (e) { civs = null; }
    if (!Array.isArray(civs) || civs.indexOf(ARG) === -1) return refuse("ACTION_NOT_STARTABLE", "civilization is not among this seat's choices for that kind of syncretism");
    const syncArgs = { CivilizationType: ARG };
    const syncCheck = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND], syncArgs, false);
    if (!syncCheck || syncCheck.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused the syncretism choice");
    Game.PlayerOperations.sendRequest(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND], syncArgs);
    result.outcome = "sent";
    let now = null; try { const ct = player.Identity.getSyncreticCivType(); now = isInt(ct) ? ct : null; } catch (e) { now = null; }
    result.readback = { kind: KIND, arg: ARG, syncreticCiv: now, matches: now === ARG };
    return JSON.stringify(result);
  }
  if (KIND === "CHOOSE_AGE_CIVILIZATION") {
    if (!isInt(ARG)) return refuse("UNKNOWN_ACTION", "civilization argument is not an integer");
    if (typeof GameSetup === "undefined" || typeof GameSetup.findPlayerParameter !== "function" || typeof GameSetup.setPlayerParameterValue !== "function") return refuse("API_CONTRACT_MISMATCH", "game setup parameters unavailable");
    const crow = GameInfo.Civilizations.lookup(ARG);
    if (!crow || typeof crow.CivilizationType !== "string") return refuse("UNKNOWN_ACTION", "hash is not a civilization definition");
    let param = null; try { param = GameSetup.findPlayerParameter(BOUND_PLAYER_ID, "AgeTransitionPlayerCivilization"); } catch (e) { param = null; }
    const domain = param && param.domain && Array.isArray(param.domain.possibleValues) ? param.domain.possibleValues : null;
    if (!param || !domain) return refuse("API_CONTRACT_MISMATCH", "age transition civilization parameter unavailable");
    const current = param.value && typeof param.value.value === "string" ? param.value.value : null;
    const currentRow = current ? GameInfo.Civilizations.lookup(current) : null;
    if ((currentRow && isInt(currentRow.$hash) ? currentRow.$hash : -1) !== PRE) return refuse("ACTION_EXPIRED", "the selected civilization changed since the offer was made");
    let entry = null; for (const v of domain) { if (v && v.value === crow.CivilizationType) { entry = v; break; } }
    if (!entry) return refuse("ACTION_NOT_STARTABLE", "that civilization is not in this seat's choices");
    if (entry.invalidReason !== 0) return refuse("ACTION_NOT_STARTABLE", "the game marks that civilization unavailable for this seat", { invalidReason: entry.invalidReason });
    const civKey = crow.CivilizationType;
    GameSetup.setPlayerParameterValue(BOUND_PLAYER_ID, "AgeTransitionPlayerCivilization", civKey);
    result.outcome = "sent";
    let after = null; try { const p2 = GameSetup.findPlayerParameter(BOUND_PLAYER_ID, "AgeTransitionPlayerCivilization"); after = p2 && p2.value ? p2.value.value : null; } catch (e) { after = null; }
    result.readback = { kind: KIND, arg: ARG, civilization: civKey, selected: after, matches: after === civKey };
    return JSON.stringify(result);
  }
  if (KIND === "SET_AGE_TRANSITION_DATA") {
    if (!isInt(PlayerOperationTypes[OP_KIND]) || typeof GameSetup === "undefined") return refuse("API_CONTRACT_MISMATCH", "age transition contract unavailable");
    let current = null; try { const p3 = GameSetup.findPlayerParameter(BOUND_PLAYER_ID, "AgeTransitionPlayerCivilization"); current = p3 && p3.value ? p3.value.value : null; } catch (e) { current = null; }
    const currentRow = current ? GameInfo.Civilizations.lookup(current) : null;
    if ((currentRow && isInt(currentRow.$hash) ? currentRow.$hash : -1) !== PRE) return refuse("ACTION_EXPIRED", "the selected civilization changed since the offer was made");
    if (current === null || current === "RANDOM") return refuse("ACTION_NOT_STARTABLE", "choose a civilization before finishing the age transition");
    const args = { Finished: true };
    const check = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND], args, false);
    if (!check || check.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused finishing the age transition");
    Game.PlayerOperations.sendRequest(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND], args);
    result.outcome = "sent";
    result.readback = { kind: KIND, arg: 0, civilization: current, matches: false };
    return JSON.stringify(result);
  }
  if (KIND === "CHOOSE_GOLDEN_AGE") {
    if (!isInt(ARG)) return refuse("UNKNOWN_ACTION", "celebration argument is not an integer");
    if (!isInt(PlayerOperationTypes[OP_KIND]) || typeof player.Culture.getGoldenAgeChoices !== "function") return refuse("API_CONTRACT_MISMATCH", "celebration operation contract unavailable");
    const garow = GameInfo.GoldenAges.lookup(ARG);
    if (!garow || typeof garow.GoldenAgeType !== "string") return refuse("UNKNOWN_ACTION", "type is not a celebration definition");
    let gachoices = null; try { gachoices = player.Culture.getGoldenAgeChoices(); } catch (e) { gachoices = null; }
    if (!Array.isArray(gachoices) || gachoices.length !== PRE || (gachoices.indexOf(garow.GoldenAgeType) === -1 && gachoices.indexOf(ARG) === -1)) return refuse("ACTION_EXPIRED", "that celebration is no longer among the offered choices");
    const args = { GoldenAgeType: ARG };
    const check = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND], args, false);
    if (!check || check.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused that celebration choice");
    Game.PlayerOperations.sendRequest(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND], args);
    result.outcome = "sent";
    let left = null; try { const l = player.Culture.getGoldenAgeChoices(); left = Array.isArray(l) ? l.length : null; } catch (e) { left = null; }
    result.readback = { kind: KIND, arg: ARG, choicesLeft: left, matches: left === 0 };
    return JSON.stringify(result);
  }
  if (KIND === "BUY_ATTRIBUTE_TREE_NODE") {
    if (!isInt(ARG)) return refuse("UNKNOWN_ACTION", "attribute node argument is not an integer");
    if (!isInt(PlayerOperationTypes[OP_KIND])) return refuse("API_CONTRACT_MISMATCH", "attribute operation contract unavailable");
    const nrow = GameInfo.ProgressionTreeNodes.lookup(ARG);
    if (!nrow || typeof nrow.ProgressionTree !== "string" || nrow.ProgressionTree.indexOf("TREE_ATTRIBUTE") !== 0) return refuse("UNKNOWN_ACTION", "node is not an attribute tree node");
    let nstate = null; try { const ns = Game.ProgressionTrees.getNode(BOUND_PLAYER_ID, ARG); nstate = ns && isInt(ns.state) ? ns.state : -1; } catch (e) { nstate = -1; }
    if (nstate !== PRE) return refuse("ACTION_EXPIRED", "the node's state changed since the offer was made");
    const args = { ProgressionTreeNodeType: ARG };
    const check = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND], args, false);
    if (!check || check.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused buying that attribute node");
    Game.PlayerOperations.sendRequest(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND], args);
    result.outcome = "sent";
    let after = null; try { const ns = Game.ProgressionTrees.getNode(BOUND_PLAYER_ID, ARG); after = ns && isInt(ns.state) ? ns.state : null; } catch (e) { after = null; }
    result.readback = { kind: KIND, arg: ARG, stateBefore: PRE, state: after, matches: isInt(after) && after !== PRE && after >= 4 };
    return JSON.stringify(result);
  }
  if (KIND === "CONSIDER_ASSIGN_ATTRIBUTE") {
    if (!isInt(PlayerOperationTypes[OP_KIND])) return refuse("API_CONTRACT_MISMATCH", "operation type unavailable");
    const args = {};
    const check = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND], args, false);
    if (!check || check.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused considering attributes");
    Game.PlayerOperations.sendRequest(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND], args);
    result.outcome = "sent";
    result.readback = { kind: KIND, arg: 0, matches: false };
    return JSON.stringify(result);
  }
  if (KIND === "CHANGE_GOVERNMENT") {
    if (!isInt(ARG) || !isInt(ARG2)) return refuse("UNKNOWN_ACTION", "government arguments are not integers");
    if (!isInt(PlayerOperationTypes[OP_KIND]) || typeof PlayerOperationParameters === "undefined" || !isInt(PlayerOperationParameters.Activate)) return refuse("API_CONTRACT_MISMATCH", "government operation contract unavailable");
    const grow = GameInfo.Governments.lookup(ARG2);
    if (!grow || grow.$index !== ARG) return refuse("UNKNOWN_ACTION", "government identity does not match the offer");
    let gcur = null; try { gcur = player.Culture.getGovernmentType(); } catch (e) { gcur = null; }
    if ((isInt(gcur) ? gcur : -1) !== PRE) return refuse("ACTION_EXPIRED", "the government changed since the offer was made");
    const args = { GovernmentType: ARG, Action: PlayerOperationParameters.Activate };
    const check = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND], args, false);
    if (!check || check.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused that government");
    Game.PlayerOperations.sendRequest(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND], args);
    result.outcome = "sent";
    let gafter = null; try { gafter = player.Culture.getGovernmentType(); } catch (e) { gafter = null; }
    result.readback = { kind: KIND, arg: ARG, government: ARG2, observed: isInt(gafter) ? gafter : null, matches: gafter === ARG2 || gafter === ARG };
    return JSON.stringify(result);
  }
  if (KIND === "RESPOND_DIPLOMATIC_FIRST_MEET") {
    if (!isInt(ARG) || !isInt(ARG2) || !isInt(ARG3)) return refuse("UNKNOWN_ACTION", "first meet arguments are not integers");
    if (!isInt(PlayerOperationTypes[OP_KIND]) || typeof DiplomacyPlayerFirstMeets === "undefined") return refuse("API_CONTRACT_MISMATCH", "first meet contract unavailable");
    let known = false; for (const k of Object.keys(DiplomacyPlayerFirstMeets)) { if (DiplomacyPlayerFirstMeets[k] === ARG && k !== "PLAYER_REALATIONSHIP_FIRSTMEET_UNKNOWN") { known = true; break; } }
    if (!known) return refuse("UNKNOWN_ACTION", "greeting is not a first meet relationship type");
    if (ARG2 === BOUND_PLAYER_ID || ARG2 < 0) return refuse("UNKNOWN_ACTION", "the other player is not valid");
    // re-derive the player from the seat's own still-blocking notification rather than trusting the offer
    let match = false;
    try {
      for (const nid of Game.Notifications.getIdsForPlayer(BOUND_PLAYER_ID)) {
        if (nid.id !== ARG3) continue;
        const n = Game.Notifications.find(nid);
        if (!n || Game.Notifications.getTypeName(n.Type) !== "NOTIFICATION_PLAYER_MET" || Game.Notifications.getBlocksTurnAdvancement(nid) !== true) break;
        const s = Game.Notifications.getSummary(nid);
        const m = typeof s === "string" ? s.match(/\[PlayerName:(\d+)\]/) : null;
        if (m && parseInt(m[1], 10) === ARG2) match = true;
        break;
      }
    } catch (e) { match = false; }
    if (!match) return refuse("ACTION_EXPIRED", "that first meet is no longer pending for this seat");
    const args = { Player1: BOUND_PLAYER_ID, Player2: ARG2, Type: ARG };
    const check = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND], args, false);
    if (!check || check.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused that greeting");
    Game.PlayerOperations.sendRequest(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND], args);
    result.outcome = "sent";
    result.readback = { kind: KIND, arg: ARG, otherPlayer: ARG2, matches: false };
    return JSON.stringify(result);
  }
  if (KIND === "FOUND_PANTHEON") {
    if (!isInt(ARG)) return refuse("UNKNOWN_ACTION", "belief argument is not an integer");
    if (!isInt(PlayerOperationTypes[OP_KIND]) || !player.Religion || typeof player.Religion.getNumPantheons !== "function") return refuse("API_CONTRACT_MISMATCH", "pantheon operation contract unavailable");
    const brow = GameInfo.Beliefs.lookup(ARG);
    if (!brow || brow.BeliefClassType !== "BELIEF_CLASS_PANTHEON") return refuse("UNKNOWN_ACTION", "belief is not a pantheon belief");
    if (player.Religion.getNumPantheons() !== PRE) return refuse("ACTION_EXPIRED", "the number of pantheons changed since the offer was made");
    const args = { BeliefType: ARG };
    const check = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND], args, false);
    if (!check || check.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused founding that pantheon");
    Game.PlayerOperations.sendRequest(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND], args);
    result.outcome = "sent";
    let has = null; try { const list = player.Religion.getPantheons(); has = Array.isArray(list) ? list.indexOf(ARG) !== -1 : null; } catch (e) { has = null; }
    result.readback = { kind: KIND, arg: ARG, founded: has, matches: has === true };
    return JSON.stringify(result);
  }
  if (KIND === "CHOOSE_NARRATIVE_STORY_DIRECTION") {
    if (!isInt(ARG) || !isInt(ARG2)) return refuse("UNKNOWN_ACTION", "narrative arguments are not integers");
    if (!isInt(PlayerOperationTypes[OP_KIND]) || !player.Stories || typeof PlayerOperationParameters === "undefined" || !isInt(PlayerOperationParameters.Activate)) return refuse("API_CONTRACT_MISMATCH", "narrative operation contract unavailable");
    const st = player.Stories;
    let sid = null;
    try { const first = st.getFirstPendingDiscoveryLastMetID(); if (first && first.id === ARG) sid = first; if (!sid) { const met = st.getPendingMetIds(); if (Array.isArray(met)) for (const m of met) if (m && m.id === ARG) { sid = m; break; } } } catch (e) { sid = null; }
    if (!sid) return refuse("ACTION_EXPIRED", "that story is no longer pending");
    const story = st.find(sid);
    if (!story || story.type !== PRE) return refuse("ACTION_EXPIRED", "the pending story changed since the offer was made");
    let key = null;
    if (ARG2 === -1) key = "CLOSE";
    else { const ld = GameInfo.NarrativeStories.lookup(ARG2); if (ld && typeof ld.NarrativeStoryType === "string") key = ld.NarrativeStoryType; }
    if (key === null) return refuse("UNKNOWN_ACTION", "answer is not a narrative story link");
    const args = { TargetType: key, Target: sid, Action: PlayerOperationParameters.Activate };
    const check = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND], args, false);
    if (!check || check.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused that story direction");
    Game.PlayerOperations.sendRequest(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND], args);
    result.outcome = "sent";
    let stillPending = null; try { const first = st.getFirstPendingDiscoveryLastMetID(); stillPending = !!(first && first.id === ARG); } catch (e) { stillPending = null; }
    result.readback = { kind: KIND, arg: ARG, answerKey: key, stillPending: stillPending, matches: stillPending === false };
    return JSON.stringify(result);
  }
  // A tree target is a standing goal: the game researches its way there on its own, so the seat is
  // not asked to pick again every few turns. It takes the same node argument as the immediate choice.
  if (KIND === "SET_TECH_TREE_TARGET_NODE" || KIND === "SET_CULTURE_TREE_TARGET_NODE") {
    if (!isInt(ARG)) return refuse("UNKNOWN_ACTION", "operation argument is not an integer");
    if (!isInt(PlayerOperationTypes[OP_KIND])) return refuse("API_CONTRACT_MISMATCH", "operation type unavailable");
    const tcomp = KIND === "SET_TECH_TREE_TARGET_NODE" ? player.Techs : player.Culture;
    let held = null; try { held = tcomp.getTargetNode(); } catch (e) { held = null; }
    if (held !== PRE) return refuse("ACTION_EXPIRED", "the standing goal changed since the offer was made");
    const targs = { ProgressionTreeNodeType: ARG };
    const tcheck = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND], targs, false);
    if (!tcheck || tcheck.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused the operation");
    Game.PlayerOperations.sendRequest(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND], targs);
    result.outcome = "sent";
    let after = null; try { after = tcomp.getTargetNode(); } catch (e) { after = null; }
    result.readback = { kind: KIND, arg: ARG, targetNode: isInt(after) ? after : null, matches: after === ARG };
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
