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
  if (KIND === "PROMOTE_UNIT") {
    if (!isInt(ARG) || !isInt(ARG2) || !isInt(ARG3)) return refuse("UNKNOWN_ACTION", "promotion arguments are not integers");
    if (typeof UnitCommandTypes === "undefined" || !isInt(UnitCommandTypes.PROMOTE)) return refuse("API_CONTRACT_MISMATCH", "UnitCommandTypes.PROMOTE unavailable");
    let unit = null;
    try { for (const u of player.Units.getUnits()) { if (u && u.id && u.id.id === ARG && u.id.owner === BOUND_PLAYER_ID) { unit = u; break; } } } catch (e) { unit = null; }
    if (!unit) return refuse("UNKNOWN_ACTION", "unit is not in the bound player's roster");
    const xp = unit.Experience;
    if (!xp || xp.canPromote !== true) return refuse("ACTION_NOT_STARTABLE", "unit cannot be promoted");
    if ((isInt(xp.getNumPromotions) ? xp.getNumPromotions : 0) !== PRE) return refuse("ACTION_EXPIRED", "the unit's promotions changed since the offer was made");
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
    result.readback = { kind: KIND, arg: ARG, promotion: ARG2, discipline: ARG3, held: isInt(xp.getNumPromotions) ? xp.getNumPromotions : null, hasPromotion: has, matches: has === true };
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
    const growthArgs = { Type: GrowthTypes.PROJECT, ProjectType: ARG2, City: ARG };
    const gcheck = Game.CityCommands.canStart(townId, CityCommandTypes.CHANGE_GROWTH_MODE, growthArgs, false);
    if (!gcheck || gcheck.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused that town project");
    Game.CityCommands.sendRequest(townId, CityCommandTypes.CHANGE_GROWTH_MODE, growthArgs);
    result.outcome = "sent";
    let after = null; try { after = town.Growth.projectType; } catch (e) { after = null; }
    result.readback = { kind: KIND, arg: ARG, project: ARG2, observed: isInt(after) ? after : null, matches: after === ARG2 };
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
    let after = null; try { after = player.Units.getUnits().length; } catch (e) { after = null; }
    result.readback = { kind: KIND, arg: ARG, unitType: ARG2, unitsBefore: PRE, units: after, matches: isInt(after) && after > PRE };
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
  if (KIND === "ADVANCED_START_MODIFY_DECK" || KIND === "ADVANCED_START_USE_EFFECT" || KIND === "ADVANCED_START_MARK_COMPLETED") {
    if (!isInt(PlayerOperationTypes[OP_KIND]) || !player.AdvancedStart) return refuse("API_CONTRACT_MISMATCH", "advanced start contract unavailable");
    const A = player.AdvancedStart;
    // a deck entry wraps the card under `info`; an available card is the card itself
    const cardOf = (c) => (c && c.info ? c.info : c);
    let deck = null; try { deck = A.getCards(); } catch (e) { deck = null; }
    if (!Array.isArray(deck)) return refuse("API_CONTRACT_MISMATCH", "advanced start deck unavailable");
    const deckIds = deck.map((c) => cardOf(c) && cardOf(c).id).filter((x) => typeof x === "string");
    if (deckIds.length !== PRE) return refuse("ACTION_EXPIRED", "the legacy deck changed since the offer was made");
    let args = null;
    if (KIND === "ADVANCED_START_MODIFY_DECK") {
      if (!isInt(ARG)) return refuse("UNKNOWN_ACTION", "card argument is not an integer");
      let card = null; try { for (const c of A.getAvailableCards()) { if (c && typeof c.id === "string" && Database.makeHash(c.id) === ARG) { card = c; break; } } } catch (e) { card = null; }
      if (!card) return refuse("UNKNOWN_ACTION", "card is not among the seat's available legacy cards");
      if (deckIds.indexOf(card.id) !== -1) return refuse("ACTION_EXPIRED", "that card is already in the deck");
      if (Array.isArray(card.effects) && card.effects.some((e) => e && e.isPlacementEffect === true)) return refuse("ACTION_NOT_STARTABLE", "cards with a placement effect are not supported yet");
      args = { Type: "ADD", ID: card.id };
    } else if (KIND === "ADVANCED_START_USE_EFFECT") {
      if (!isInt(ARG) || !isInt(ARG2)) return refuse("UNKNOWN_ACTION", "effect arguments are not integers");
      let effect = null;
      for (const entry of deck) { const c = cardOf(entry); if (!c || typeof c.id !== "string" || Database.makeHash(c.id) !== ARG2 || !Array.isArray(c.effects)) continue; for (const e of c.effects) { if (e && typeof e.id === "string" && Database.makeHash(e.id) === ARG) { effect = e; break; } } }
      if (!effect) return refuse("UNKNOWN_ACTION", "effect is not on a card in the deck");
      if (effect.isPlacementEffect === true) return refuse("ACTION_NOT_STARTABLE", "placement effects are not supported yet");
      args = { ID: effect.id };
    } else {
      let pending = 0;
      try { for (const entry of deck) { const c = cardOf(entry); if (!c || !Array.isArray(c.effects)) continue; for (const e of c.effects) { if (!e || typeof e.id !== "string" || e.isPlacementEffect === true) continue; const u = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes.ADVANCED_START_USE_EFFECT, { ID: e.id }, false); if (u && u.Success === true) pending += 1; } } } catch (e) { pending = 0; }
      if (pending > 0) return refuse("ACTION_NOT_STARTABLE", "apply every selected card's effect before finishing", { unappliedEffects: pending });
      args = {};
    }
    const check = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND], args, false);
    if (!check || check.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused the advanced start operation");
    Game.PlayerOperations.sendRequest(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND], args);
    result.outcome = "sent";
    let after = null; try { after = A.getCards().map((c) => cardOf(c) && cardOf(c).id); } catch (e) { after = null; }
    result.readback = { kind: KIND, arg: ARG, deck: after, matches: KIND === "ADVANCED_START_MODIFY_DECK" ? (Array.isArray(after) && after.indexOf(args.ID) !== -1) : false };
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
