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
  let turnBefore, localPlayerId, localObserverId, age, flags;
  try {
    turnBefore = Game.turn;
    localPlayerId = GameContext.localPlayerID;
    localObserverId = GameContext.localObserverID;
    age = Game.age;
    flags = Configuration.getGame();
  } catch (e) {
    return refuse("NOT_IN_GAME", "game context unavailable: " + String(e).slice(0, 120));
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
  const settlementRecord = (c) => {
    const rec = {
      id: c.id,
      owner: c.owner,
      nameKey: typeof c.name === "string" ? c.name : null,
      displayName: compose(c.name),
      location: isLoc(c.location) ? { x: c.location.x, y: c.location.y } : null,
      isTown: c.isTown === true,
      isCapital: c.isCapital === true,
      population: { total: c.population, rural: c.ruralPopulation, urban: c.urbanPopulation },
      production: null
    };
    try {
      const q = c.BuildQueue;
      const hash = q.currentProductionTypeHash;
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
    return refuse("API_CONTRACT_MISMATCH", "settlement roster read failed: " + String(e).slice(0, 120));
  }

  // ---- 3. units
  const unitRecord = (u) => {
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
    const mv = u.Movement;
    const movement = mv && isInt(mv.movementMovesRemaining) && isInt(mv.maxMoves)
      ? { remaining: mv.movementMovesRemaining, max: mv.maxMoves } : null;
    const hp = u.Health;
    const health = hp && isInt(hp.damage) && isInt(hp.maxDamage) ? { damage: hp.damage, maxDamage: hp.maxDamage } : null;
    return {
      id: u.id,
      owner: u.owner,
      type: u.type,
      typeKey: lookupKey(GameInfo.Units, u.type, "UnitType"),
      displayName: compose(u.name),
      locationStatus: locationStatus,
      location: location,
      isEmbarked: u.isEmbarked === true,
      movement: movement,
      health: health,
      isCommander: u.isCommanderUnit === true,
      armyId: isComponentId(u.armyId) && !noneComponentId(u.armyId) ? u.armyId : null
    };
  };
  try {
    const units = player.Units.getUnits();
    if (!Array.isArray(units)) throw new Error("getUnits() did not return an array");
    const live = units.filter((u) => u && u.isDead !== true && u.isValid !== false);
    if (live.length !== units.length) warnings.push({ code: "UNITS_SKIPPED", message: "dead or invalid unit objects omitted", count: units.length - live.length });
    result.units = live.map(unitRecord);
  } catch (e) {
    return refuse("API_CONTRACT_MISMATCH", "unit roster read failed: " + String(e).slice(0, 120));
  }

  // ---- 4. context after
  let turnAfter, lpAfter, loAfter;
  try { turnAfter = Game.turn; lpAfter = GameContext.localPlayerID; loAfter = GameContext.localObserverID; } catch (e) { return refuse("CONTEXT_CHANGED", "context unreadable after extraction"); }
  if (turnAfter !== turnBefore || lpAfter !== localPlayerId || loAfter !== localObserverId) {
    return refuse("CONTEXT_CHANGED", "turn or seat changed during extraction");
  }
  return JSON.stringify(result);
})()
