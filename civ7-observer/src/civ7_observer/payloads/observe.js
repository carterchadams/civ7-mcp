// Production read-only extraction payload (Change 3: settlements + units).
// BOUND_PLAYER_ID and ALLOWED_MODE are substituted by the Python side.
// Self-contained, synchronous, no imports, timers, DOM, operations, reveals,
// configuration or storage writes. Every player-scoped read is keyed by the
// bound id. Returns one JSON string; `refused` is set instead of partial data.
(() => {
  const ALLOWED = ALLOWED_MODE;
  const warnings = [];
  const result = { payloadVersion: 1, refused: null, context: null, settlements: null, units: null, warnings: warnings };
  const refuse = (code, message) => {
    result.refused = { code: code, message: message };
    return JSON.stringify(result);
  };
  const isInt = (v) => typeof v === "number" && Number.isInteger(v);
  const isBool = (v) => typeof v === "boolean";
  class Contract extends Error {}
  const need = (ok, what) => { if (!ok) throw new Contract(what); };
  const isLoc = (l) => l !== null && typeof l === "object" && isInt(l.x) && isInt(l.y);
  const isComponentId = (c) => c !== null && typeof c === "object" && isInt(c.owner) && isInt(c.id) && isInt(c.type);
  const noneComponentId = (c) => isComponentId(c) && c.owner === -1 && c.id === -1;
  const lookupKey = (table, hash, field) => {
    if (!isInt(hash) || hash === -1) return null;
    const row = table && typeof table.lookup === "function" ? table.lookup(hash) : null;
    return row && typeof row[field] === "string" ? row[field] : null;
  };
  const compose = (key) => {
    if (typeof key !== "string") return null;
    try { const s = Locale.compose(key); return typeof s === "string" ? s : key; } catch (e) { return key; }
  };

  // ---- 1. context and guards, before any roster read
  let turnBefore, localPlayerId, localObserverId, age, flags, inGame;
  try {
    inGame = typeof UI !== "undefined" && typeof UI.isInGame === "function" ? UI.isInGame() : undefined;
    turnBefore = Game.turn;
    localPlayerId = GameContext.localPlayerID;
    localObserverId = GameContext.localObserverID;
    age = Game.age;
    flags = Configuration.getGame();
  } catch (e) {
    return refuse("NOT_IN_GAME", "game context unavailable: " + String(e).slice(0, 120));
  }
  if (inGame !== true) {
    return refuse("NOT_IN_GAME", "UI.isInGame() is not true");
  }
  if (!isInt(turnBefore) || !isInt(localPlayerId) || !isInt(localObserverId)) {
    return refuse("NOT_IN_GAME", "turn or seat identity missing");
  }
  if (localPlayerId !== BOUND_PLAYER_ID || localObserverId !== BOUND_PLAYER_ID) {
    return refuse("WRONG_PLAYER", "bound player " + BOUND_PLAYER_ID + " is not the local seat (localPlayerId=" + localPlayerId + ", localObserverId=" + localObserverId + ")");
  }
  const flag = (k) => (flags ? flags[k] : undefined);
  const required = ["isHotseat", "isLocalMultiplayer", "isNetworkMultiplayer", "isInternetMultiplayer", "isLANMultiplayer", "isAnyMultiplayer", "isPlayByCloud"];
  for (const k of required) {
    if (typeof flag(k) !== "boolean") return refuse("UNSUPPORTED_GAME_MODE", "game mode flag " + k + " is not a boolean");
  }
  const networked = flag("isNetworkMultiplayer") || flag("isInternetMultiplayer") || flag("isLANMultiplayer") || flag("isPlayByCloud");
  let mode;
  if (!flag("isAnyMultiplayer") && !networked) mode = "singleplayer";
  else if (flag("isHotseat") && flag("isLocalMultiplayer") && !networked) mode = "local-hotseat";
  else mode = "unsupported";
  if (mode !== ALLOWED) {
    return refuse("UNSUPPORTED_GAME_MODE", "game is " + mode + " but the service allows only " + ALLOWED);
  }
  let player;
  try { player = Players.get(BOUND_PLAYER_ID); } catch (e) { player = null; }
  if (!player || player.isValid === false) return refuse("WRONG_PLAYER", "bound player object is invalid");
  if (player.isTurnActive !== true) return refuse("TURN_NOT_READY", "bound player's turn is not active");

  result.context = {
    turn: turnBefore,
    age: isInt(age) ? age : null,
    ageType: lookupKey(GameInfo.Ages, age, "AgeType"),
    playerId: BOUND_PLAYER_ID,
    localPlayerId: localPlayerId,
    localObserverId: localObserverId,
    mode: mode,
    isTurnActive: true
  };

  // ---- 2. settlements
  const settlementRecord = (c, i) => {
    const at = "settlement[" + i + "]";
    need(isComponentId(c.id), at + ".id is not a ComponentID");
    need(isInt(c.owner), at + ".owner is not an integer");
    need(isBool(c.isTown), at + ".isTown is not a boolean");
    need(isBool(c.isCapital), at + ".isCapital is not a boolean");
    need(isInt(c.population) && isInt(c.ruralPopulation) && isInt(c.urbanPopulation), at + " population fields are not integers");
    need(c.location === undefined || c.location === null || isLoc(c.location), at + ".location is malformed");
    need(typeof c.name === "string" || c.name === undefined || c.name === null, at + ".name is not a string");
    const rec = {
      id: { owner: c.id.owner, id: c.id.id, type: c.id.type },
      owner: c.owner,
      nameKey: typeof c.name === "string" ? c.name : null,
      displayName: compose(c.name),
      location: isLoc(c.location) ? { x: c.location.x, y: c.location.y } : null,
      isTown: c.isTown,
      isCapital: c.isCapital,
      population: { total: c.population, rural: c.ruralPopulation, urban: c.urbanPopulation },
      production: null
    };
    try {
      const q = c.BuildQueue;
      const hash = q.currentProductionTypeHash;
      need(isInt(hash), "BuildQueue.currentProductionTypeHash is not an integer");
      const empty = q.isEmpty === true || hash === -1;
      let key = null, kind = null;
      if (!empty) {
        key = lookupKey(GameInfo.Units, hash, "UnitType"); if (key) kind = "unit";
        if (!key) { key = lookupKey(GameInfo.Constructibles, hash, "ConstructibleType"); if (key) kind = "constructible"; }
        if (!key) { key = lookupKey(GameInfo.Projects, hash, "ProjectType"); if (key) kind = "project"; }
      }
      rec.production = { status: "supported", isEmpty: empty, currentType: empty ? null : hash, currentTypeKey: key, currentKind: kind };
    } catch (e) {
      rec.production = { status: "unsupported", reason: "BuildQueue read failed: " + String(e).slice(0, 100) };
    }
    return rec;
  };
  try {
    const cities = player.Cities.getCities();
    if (!Array.isArray(cities)) throw new Error("getCities() did not return an array");
    result.settlements = cities.map(settlementRecord);
  } catch (e) {
    return refuse("API_CONTRACT_MISMATCH", "settlement roster read failed: " + String(e && e.message ? e.message : e).slice(0, 160));
  }

  // ---- 3. units
  let movementAbsent = 0, healthAbsent = 0;
  const unitRecord = (u, i) => {
    const at = "unit[" + i + "]";
    need(isComponentId(u.id), at + ".id is not a ComponentID");
    need(isInt(u.owner), at + ".owner is not an integer");
    need(isInt(u.type), at + ".type is not an integer");
    need(isBool(u.isOnMap), at + ".isOnMap is not a boolean");
    need(isBool(u.isEmbarked), at + ".isEmbarked is not a boolean");
    need(isBool(u.isCommanderUnit), at + ".isCommanderUnit is not a boolean");
    need(u.armyId === undefined || u.armyId === null || isComponentId(u.armyId), at + ".armyId is malformed");
    const loc = u.location;
    let locationStatus, location = null;
    if (u.isOnMap === false) {
      locationStatus = "off-map";
    } else if (isLoc(loc) && loc.x >= 0 && loc.y >= 0) {
      locationStatus = "tile";
      location = { x: loc.x, y: loc.y };
    } else {
      locationStatus = "invalid";
    }
    let movement = null;
    const mv = u.Movement;
    if (mv === undefined || mv === null) {
      movementAbsent++;
    } else {
      need(isInt(mv.movementMovesRemaining) && isInt(mv.maxMoves), at + ".Movement fields are not integers");
      movement = { remaining: mv.movementMovesRemaining, max: mv.maxMoves };
    }
    let health = null;
    const hp = u.Health;
    if (hp === undefined || hp === null) {
      healthAbsent++;
    } else {
      need(isInt(hp.damage) && isInt(hp.maxDamage), at + ".Health fields are not integers");
      health = { damage: hp.damage, maxDamage: hp.maxDamage };
    }
    return {
      id: { owner: u.id.owner, id: u.id.id, type: u.id.type },
      owner: u.owner,
      type: u.type,
      typeKey: lookupKey(GameInfo.Units, u.type, "UnitType"),
      displayName: compose(u.name),
      locationStatus: locationStatus,
      location: location,
      isEmbarked: u.isEmbarked,
      movement: movement,
      health: health,
      isCommander: u.isCommanderUnit,
      armyId: isComponentId(u.armyId) && !noneComponentId(u.armyId) ? { owner: u.armyId.owner, id: u.armyId.id, type: u.armyId.type } : null
    };
  };
  try {
    const units = player.Units.getUnits();
    if (!Array.isArray(units)) throw new Error("getUnits() did not return an array");
    const live = units.filter((u) => u && u.isDead !== true && u.isValid !== false);
    if (live.length !== units.length) warnings.push({ code: "UNITS_SKIPPED", message: "dead or invalid unit objects omitted", count: units.length - live.length });
    result.units = live.map(unitRecord);
    if (movementAbsent) warnings.push({ code: "MOVEMENT_ABSENT", message: "Movement component absent on some units; movement reported as null", count: movementAbsent });
    if (healthAbsent) warnings.push({ code: "HEALTH_ABSENT", message: "Health component absent on some units; health reported as null", count: healthAbsent });
  } catch (e) {
    return refuse("API_CONTRACT_MISMATCH", "unit roster read failed: " + String(e && e.message ? e.message : e).slice(0, 160));
  }

  // ---- 4. context after
  let turnAfter, lpAfter, loAfter;
  try { turnAfter = Game.turn; lpAfter = GameContext.localPlayerID; loAfter = GameContext.localObserverID; } catch (e) { return refuse("CONTEXT_CHANGED", "context unreadable after extraction"); }
  if (turnAfter !== turnBefore || lpAfter !== localPlayerId || loAfter !== localObserverId) {
    return refuse("CONTEXT_CHANGED", "turn or seat changed during extraction");
  }
  return JSON.stringify(result);
})()
