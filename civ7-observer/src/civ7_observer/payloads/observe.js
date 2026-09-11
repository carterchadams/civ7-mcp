// Production read-only extraction payload (Change 3: settlements + units).
// BOUND_PLAYER_ID and ALLOWED_MODE are substituted by the Python side.
// Self-contained, synchronous, no imports, timers, DOM, operations, reveals,
// configuration or storage writes. Every player-scoped read is keyed by the
// bound id. Returns one JSON string; `refused` is set instead of partial data.
(() => {
  const ALLOWED = ALLOWED_MODE;
  const ONLY_GUARDS = GUARDS_ONLY;
  const warnings = [];
  const result = { payloadVersion: 1, guardsOnly: ONLY_GUARDS, refused: null, context: null, settlements: null, units: null, technology: null, civics: null, map: null, warnings: warnings };
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
  if (!isInt(turnBefore) || !isInt(localPlayerId) || !isInt(localObserverId) || !isInt(age)) {
    return refuse("NOT_IN_GAME", "turn, age or seat identity missing");
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
    age: age,
    ageType: lookupKey(GameInfo.Ages, age, "AgeType"),
    playerId: BOUND_PLAYER_ID,
    localPlayerId: localPlayerId,
    localObserverId: localObserverId,
    mode: mode,
    isTurnActive: true
  };

  if (ONLY_GUARDS) {
    // Eligibility probe for get_status: the same guards, no roster/progression/map reads.
    return JSON.stringify(result);
  }

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

  // ---- 4. technology and civics
  // Node state is read from Game.ProgressionTrees.getNode (the shipped dock/tree-grid path),
  // never from the getResearching() record, whose state field is unreliable.
  let nodeDefMissing = 0;
  const ENUM_MEMBERS = ["NODE_STATE_INVALID", "NODE_STATE_CLOSED", "NODE_STATE_OPEN", "NODE_STATE_IN_PROGRESS", "NODE_STATE_UNLOCKED", "NODE_STATE_FULLY_UNLOCKED"];
  const progression = (label, comp, extraTrees) => {
    need(comp !== undefined && comp !== null, label + " component is missing");
    need(typeof ProgressionTreeNodeState !== "undefined" && ProgressionTreeNodeState, "ProgressionTreeNodeState enum unavailable");
    const S = ProgressionTreeNodeState;
    const seen = new Set();
    for (const m of ENUM_MEMBERS) {
      need(isInt(S[m]), "ProgressionTreeNodeState." + m + " is not an integer");
      need(!seen.has(S[m]), "ProgressionTreeNodeState has duplicate values");
      seen.add(S[m]);
    }
    const stateName = (v) => { for (const m of ENUM_MEMBERS) if (S[m] === v) return m; return null; };
    const treeRef = (hash) => {
      if (hash === undefined || hash === null || hash === -1 || hash === 0) return null;
      need(isInt(hash), label + " tree hash is not an integer");
      return { type: hash, typeKey: lookupKey(GameInfo.ProgressionTrees, hash, "ProgressionTreeType") };
    };
    const nodeDef = (hash) => {
      const row = GameInfo.ProgressionTreeNodes && typeof GameInfo.ProgressionTreeNodes.lookup === "function" ? GameInfo.ProgressionTreeNodes.lookup(hash) : null;
      if (!row) { nodeDefMissing++; return { typeKey: null, displayName: null, tree: null }; }
      return {
        typeKey: typeof row.ProgressionTreeNodeType === "string" ? row.ProgressionTreeNodeType : null,
        displayName: typeof row.Name === "string" ? compose(row.Name) : null,
        tree: typeof row.ProgressionTree === "string" ? row.ProgressionTree : null
      };
    };
    // Every live node must carry a known state and a depth/state pair that is consistent
    // with the shipped tree-grid semantics (earned depth is independent of current research).
    const liveNode = (hash) => {
      const n = Game.ProgressionTrees.getNode(BOUND_PLAYER_ID, hash);
      need(n && isInt(n.state) && isInt(n.depthUnlocked) && isInt(n.maxDepth) && isInt(n.progress), label + " getNode(" + hash + ") returned an unusable node");
      const rd = isInt(n.repeatedDepth) ? n.repeatedDepth : 0;
      need(stateName(n.state) !== null, label + " node " + hash + " has unknown state " + n.state);
      need(n.depthUnlocked >= 0 && n.depthUnlocked <= n.maxDepth, label + " node " + hash + " depthUnlocked out of range");
      const earned = n.depthUnlocked > 0 || rd > 0;
      if (n.state === S.NODE_STATE_FULLY_UNLOCKED) need(n.depthUnlocked === n.maxDepth || rd > 0, label + " node " + hash + " FULLY_UNLOCKED below max depth");
      else if (n.state === S.NODE_STATE_UNLOCKED) need(n.depthUnlocked > 0 && n.depthUnlocked < n.maxDepth, label + " node " + hash + " UNLOCKED with inconsistent depth");
      else if (n.state !== S.NODE_STATE_IN_PROGRESS) need(!earned, label + " node " + hash + " has earned depth but state " + stateName(n.state));
      return { node: n, repeatedDepth: rd, earned: earned };
    };
    const rec = comp.getResearching();
    need(rec && typeof rec === "object" && isInt(rec.type), label + ".getResearching() returned no record");
    let current = null;
    if (rec.type !== -1) {
      const ln = liveNode(rec.type), n = ln.node;
      const d = nodeDef(rec.type);
      const cost = comp.getNodeCost(rec.type);
      const turns = comp.getTurnsLeft();
      need(isInt(cost) && isInt(turns), label + " cost/turns are not integers");
      current = { type: rec.type, typeKey: d.typeKey, displayName: d.displayName, tree: d.tree, state: n.state, stateName: stateName(n.state),
        progress: n.progress, cost: cost, turnsLeft: turns < 0 ? null : turns, depthUnlocked: n.depthUnlocked, maxDepth: n.maxDepth, repeatedDepth: ln.repeatedDepth };
    }
    const researched = comp.getResearched();
    need(Array.isArray(researched), label + ".getResearched() did not return an array");
    const completed = [];
    const inProgress = [];
    for (const r of researched) {
      need(r && isInt(r.type), label + ".getResearched() entry is malformed");
      const ln = liveNode(r.type), n = ln.node;
      if (ln.earned) {
        const d = nodeDef(r.type);
        completed.push({ type: r.type, typeKey: d.typeKey, displayName: d.displayName, tree: d.tree, state: n.state, stateName: stateName(n.state), depthUnlocked: n.depthUnlocked, maxDepth: n.maxDepth, repeatedDepth: ln.repeatedDepth });
      } else if (n.state === S.NODE_STATE_IN_PROGRESS && r.type !== rec.type) {
        // banked points on a node that is neither current nor earned (the game keeps them)
        const d = nodeDef(r.type);
        const cost = comp.getNodeCost(r.type);
        need(isInt(cost), label + " cost is not an integer for node " + r.type);
        inProgress.push({ type: r.type, typeKey: d.typeKey, displayName: d.displayName, tree: d.tree, progress: n.progress, cost: cost, depthUnlocked: n.depthUnlocked, maxDepth: n.maxDepth });
      }
      // known OPEN / CLOSED / INVALID nodes with nothing earned and nothing banked are excluded
    }
    const target = comp.getTargetNode();
    need(isInt(target), label + ".getTargetNode() is not an integer");
    let queuedTarget = null;
    if (target !== -1) {
      const d = nodeDef(target);
      queuedTarget = { type: target, typeKey: d.typeKey, displayName: d.displayName, tree: d.tree };
    }
    const out = { status: "supported", current: current, queuedTarget: queuedTarget, inProgress: inProgress, completed: completed };
    Object.assign(out, extraTrees(treeRef));
    return out;
  };
  try {
    result.technology = progression("Techs", player.Techs, (treeRef) => ({ tree: treeRef(player.Techs.getTreeType()) }));
  } catch (e) {
    return refuse("API_CONTRACT_MISMATCH", "technology read failed: " + String(e && e.message ? e.message : e).slice(0, 160));
  }
  try {
    result.civics = progression("Culture", player.Culture, (treeRef) => {
      const avail = player.Culture.getAvailableTrees();
      need(Array.isArray(avail), "Culture.getAvailableTrees() did not return an array");
      return { trees: { active: treeRef(player.Culture.getActiveTree()), available: avail.map(treeRef).filter((t) => t !== null) } };
    });
  } catch (e) {
    return refuse("API_CONTRACT_MISMATCH", "civics read failed: " + String(e && e.message ? e.message : e).slice(0, 160));
  }
  if (nodeDefMissing) warnings.push({ code: "NODE_DEFINITION_MISSING", message: "some progression nodes have no GameInfo definition; hash kept, keys null", count: nodeDefMissing });

  // ---- 5. currently visible map. Visibility is read FIRST for every plot, keyed by the
  // bound player; tile details are read only for plots whose state is exactly VISIBLE.
  // No resources, yields, units, cities, or bulk visibility reads (v0.1 policy).
  try {
    need(typeof RevealedStates !== "undefined" && RevealedStates && Number.isInteger(RevealedStates.VISIBLE) && Number.isInteger(RevealedStates.REVEALED) && Number.isInteger(RevealedStates.HIDDEN), "RevealedStates enum unavailable");
    const VISIBLE = RevealedStates.VISIBLE, REVEALED = RevealedStates.REVEALED, HIDDEN = RevealedStates.HIDDEN;
    const width = GameplayMap.getGridWidth();
    const height = GameplayMap.getGridHeight();
    need(isInt(width) && isInt(height) && width > 0 && height > 0, "map dimensions are not positive integers");
    if (width > 512 || height > 512) {
      return refuse("PAYLOAD_TOO_LARGE", "map " + width + "x" + height + " exceeds the supported 512x512; not scanned");
    }
    let tileDefMissing = 0;
    const key = (table, hash, field) => {
      if (hash === -1) return null;
      const k = lookupKey(table, hash, field);
      if (k === null) tileDefMissing++;
      return k;
    };
    const counts = { visible: 0, revealed: 0, hidden: 0 };
    const tiles = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const state = GameplayMap.getRevealedState(BOUND_PLAYER_ID, x, y);
        need(isInt(state), "getRevealedState returned a non-integer at " + x + "," + y);
        if (state === VISIBLE) counts.visible++;
        else if (state === REVEALED) counts.revealed++;
        else if (state === HIDDEN) counts.hidden++;
        else need(false, "getRevealedState returned an unknown state " + state);
        if (state !== VISIBLE) continue;
        const terrain = GameplayMap.getTerrainType(x, y);
        const biome = GameplayMap.getBiomeType(x, y);
        const feature = GameplayMap.getFeatureType(x, y);
        const elevation = GameplayMap.getElevation(x, y);
        const isRiver = GameplayMap.isRiver(x, y);
        const riverType = GameplayMap.getRiverType(x, y);
        const index = GameplayMap.getIndexFromXY(x, y);
        need(isInt(terrain) && isInt(biome) && isInt(feature) && isInt(elevation) && isBool(isRiver) && isInt(riverType) && isInt(index), "tile detail contract broken at " + x + "," + y);
        tiles.push({
          x: x, y: y, index: index,
          terrain: terrain, terrainKey: key(GameInfo.Terrains, terrain, "TerrainType"),
          biome: biome, biomeKey: key(GameInfo.Biomes, biome, "BiomeType"),
          feature: feature === -1 ? null : feature, featureKey: key(GameInfo.Features, feature, "FeatureType"),
          elevation: elevation, isRiver: isRiver, riverType: riverType === -1 ? null : riverType
        });
      }
    }
    result.map = { status: "supported", width: width, height: height, coverage: "currently-visible-only", counts: counts, tiles: tiles };
    if (tileDefMissing) warnings.push({ code: "TILE_DEFINITION_MISSING", message: "some tile type hashes have no GameInfo definition; hash kept, key null", count: tileDefMissing });
  } catch (e) {
    return refuse("API_CONTRACT_MISMATCH", "map read failed: " + String(e && e.message ? e.message : e).slice(0, 160));
  }

  // ---- 6. context after
  let turnAfter, ageAfter, lpAfter, loAfter;
  try { turnAfter = Game.turn; ageAfter = Game.age; lpAfter = GameContext.localPlayerID; loAfter = GameContext.localObserverID; } catch (e) { return refuse("CONTEXT_CHANGED", "context unreadable after extraction"); }
  if (turnAfter !== turnBefore || ageAfter !== age || lpAfter !== localPlayerId || loAfter !== localObserverId) {
    return refuse("CONTEXT_CHANGED", "turn, age or seat changed during extraction");
  }
  return JSON.stringify(result);
})()
