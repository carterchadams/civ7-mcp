// Developer-only, read-only capability probe (plan Milestone B).
// BOUND_PLAYER_ID is substituted by the Python side with the engine player id
// that the operator selected. Every player-scoped read is keyed by it.
// Known reads only: no roster lists, no seeds, no resources, no mutators,
// no function is invoked unless its shape was confirmed in docs/runtime-contract.md.
(() => {
  const errors = [];
  const read = (path, fn) => {
    try {
      const v = fn();
      return v === undefined ? null : v;
    } catch (e) {
      errors.push({ path: path, error: String(e).slice(0, 200) });
      return null;
    }
  };
  const has = (name) => {
    try { return typeof globalThis[name] !== "undefined"; } catch (e) { return false; }
  };
  const methodNames = (obj) => {
    const names = new Set();
    let p = obj;
    let depth = 0;
    while (p && p !== Object.prototype && depth < 4) {
      for (const k of Object.getOwnPropertyNames(p)) {
        if (k !== "constructor") names.add(k);
      }
      p = Object.getPrototypeOf(p);
      depth++;
    }
    return [...names].sort();
  };
  const lookupName = (table, hash, field) => {
    if (hash === null || hash === undefined || hash === -1) return null;
    const row = table && typeof table.lookup === "function" ? table.lookup(hash) : null;
    return row && row[field] !== undefined ? row[field] : null;
  };
  const nodeStateName = (state) => {
    if (!has("ProgressionTreeNodeState")) return null;
    for (const k of Object.keys(ProgressionTreeNodeState)) {
      if (ProgressionTreeNodeState[k] === state) return k;
    }
    return null;
  };
  const enumCopy = (name) => (has(name) ? read("enums." + name, () => Object.assign({}, globalThis[name])) : null);

  const out = { probeVersion: 1, boundPlayerId: BOUND_PLAYER_ID, seatMismatch: false };

  out.context = {
    turn: read("context.turn", () => Game.turn),
    age: read("context.age", () => Game.age),
    ageType: read("context.ageType", () => lookupName(GameInfo.Ages, Game.age, "AgeType")),
    localPlayerId: read("context.localPlayerId", () => GameContext.localPlayerID),
    localObserverId: read("context.localObserverId", () => GameContext.localObserverID),
    isInGame: read("context.isInGame", () => UI.isInGame()),
    isMultiplayer: read("context.isMultiplayer", () => UI.isMultiplayer())
  };

  out.mode = read("mode", () => {
    const g = Configuration.getGame();
    const flags = {};
    for (const k of ["isHotseat", "isLocalMultiplayer", "isNetworkMultiplayer", "isInternetMultiplayer", "isLANMultiplayer", "isAnyMultiplayer", "isPlayByCloud", "isMatchMaking", "isGameStarted", "isGameReady", "isPaused", "isSavedGame"]) {
      flags[k] = read("mode." + k, () => g[k]);
    }
    return flags;
  });

  out.enums = {
    ProgressionTreeNodeState: enumCopy("ProgressionTreeNodeState"),
    RevealedStates: enumCopy("RevealedStates"),
    DirectionTypes: enumCopy("DirectionTypes"),
    PlayerIds: enumCopy("PlayerIds")
  };

  // Seat guard: refuse to touch player data unless the bound id is the local seat.
  if (out.context.localPlayerId !== BOUND_PLAYER_ID || out.context.localObserverId !== BOUND_PLAYER_ID) {
    out.seatMismatch = true;
    out.player = null;
    out.settlements = null;
    out.units = null;
    out.techs = null;
    out.civics = null;
    out.map = null;
    out.staticTables = null;
    out.progressionTrees = null;
    out.errors = errors;
    return JSON.stringify(out);
  }

  const player = read("player.get", () => Players.get(BOUND_PLAYER_ID));

  out.player = player === null ? null : {
    id: read("player.id", () => player.id),
    isTurnActive: read("player.isTurnActive", () => player.isTurnActive),
    isAlive: read("player.isAlive", () => player.isAlive),
    isHuman: read("player.isHuman", () => player.isHuman),
    isAI: read("player.isAI", () => player.isAI),
    civilizationType: read("player.civilizationType", () => player.civilizationType),
    civilizationTypeName: read("player.civilizationTypeName", () => lookupName(GameInfo.Civilizations, player.civilizationType, "CivilizationType")),
    leaderType: read("player.leaderType", () => player.leaderType),
    leaderTypeName: read("player.leaderTypeName", () => lookupName(GameInfo.Leaders, player.leaderType, "LeaderType")),
    memberNames: read("player.memberNames", () => methodNames(player))
  };

  const cityRecord = (c) => ({
    id: read("settlements.sample.id", () => c.id),
    localId: read("settlements.sample.localId", () => c.localId),
    owner: read("settlements.sample.owner", () => c.owner),
    name: read("settlements.sample.name", () => c.name),
    displayName: read("settlements.sample.displayName", () => Locale.compose(c.name)),
    location: read("settlements.sample.location", () => c.location),
    isTown: read("settlements.sample.isTown", () => c.isTown),
    isCapital: read("settlements.sample.isCapital", () => c.isCapital),
    population: read("settlements.sample.population", () => c.population),
    ruralPopulation: read("settlements.sample.ruralPopulation", () => c.ruralPopulation),
    urbanPopulation: read("settlements.sample.urbanPopulation", () => c.urbanPopulation),
    production: read("settlements.sample.production", () => ({
      currentProductionTypeHash: c.BuildQueue.currentProductionTypeHash,
      isEmpty: c.BuildQueue.isEmpty,
      turnsLeft: c.BuildQueue.getTurnsLeft()
    })),
    memberNames: read("settlements.sample.memberNames", () => methodNames(c))
  });
  out.settlements = player === null ? null : read("settlements", () => {
    const cities = player.Cities.getCities();
    return {
      count: cities.length,
      methodNames: methodNames(player.Cities),
      sample: cities.length ? cityRecord(cities[0]) : null,
      townCount: cities.filter((c) => c.isTown === true).length
    };
  });

  const unitRecord = (u) => ({
    id: read("units.sample.id", () => u.id),
    localId: read("units.sample.localId", () => u.localId),
    owner: read("units.sample.owner", () => u.owner),
    type: read("units.sample.type", () => u.type),
    typeName: read("units.sample.typeName", () => lookupName(GameInfo.Units, u.type, "UnitType")),
    name: read("units.sample.name", () => u.name),
    location: read("units.sample.location", () => u.location),
    isOnMap: read("units.sample.isOnMap", () => u.isOnMap),
    isDead: read("units.sample.isDead", () => u.isDead),
    isCommanderUnit: read("units.sample.isCommanderUnit", () => u.isCommanderUnit),
    armyId: read("units.sample.armyId", () => u.armyId),
    movement: read("units.sample.movement", () => ({ remaining: u.Movement.movementMovesRemaining, max: u.Movement.maxMoves })),
    health: read("units.sample.health", () => ({ damage: u.Health.damage, maxDamage: u.Health.maxDamage })),
    memberNames: read("units.sample.memberNames", () => methodNames(u))
  });
  out.units = player === null ? null : read("units", () => {
    const units = player.Units.getUnits();
    return {
      count: units.length,
      methodNames: methodNames(player.Units),
      sample: units.length ? unitRecord(units[0]) : null,
      offMapCount: units.filter((u) => u.isOnMap === false).length
    };
  });

  const nodeRecord = (path, n) => ({
    type: n.type,
    name: read(path + ".name", () => lookupName(GameInfo.ProgressionTreeNodes, n.type, "ProgressionTreeNodeType")),
    state: n.state,
    stateName: nodeStateName(n.state),
    progress: n.progress,
    depth: n.depth,
    maxDepth: n.maxDepth,
    node: read(path + ".node", () => (n.type === -1 ? null : Game.ProgressionTrees.getNode(BOUND_PLAYER_ID, n.type)))
  });
  const progression = (path, comp) => ({
    methodNames: methodNames(comp),
    researching: read(path + ".researching", () => nodeRecord(path + ".researching", comp.getResearching())),
    researched: read(path + ".researched", () => comp.getResearched().map((n) => nodeRecord(path + ".researched[]", n))),
    target: read(path + ".target", () => comp.getTargetNode()),
    turnsLeft: read(path + ".turnsLeft", () => comp.getTurnsLeft())
  });
  out.techs = player === null ? null : read("techs", () => {
    const t = player.Techs;
    const base = progression("techs", t);
    base.treeType = read("techs.treeType", () => t.getTreeType());
    base.treeTypeName = read("techs.treeTypeName", () => lookupName(GameInfo.ProgressionTrees, t.getTreeType(), "ProgressionTreeType"));
    base.numUnlocked = read("techs.numUnlocked", () => t.getNumTechsUnlocked());
    return base;
  });
  out.civics = player === null ? null : (read("civics", () => {
    const c = player.Culture;
    if (!c) throw new Error("player.Culture is missing");
    const base = progression("civics", c);
    base.activeTree = read("civics.activeTree", () => c.getActiveTree());
    base.activeTreeName = read("civics.activeTreeName", () => lookupName(GameInfo.ProgressionTrees, c.getActiveTree(), "ProgressionTreeType"));
    base.availableTrees = read("civics.availableTrees", () => c.getAvailableTrees());
    base.availableTreeNames = read("civics.availableTreeNames", () => c.getAvailableTrees().map((h) => lookupName(GameInfo.ProgressionTrees, h, "ProgressionTreeType")));
    base.numUnlocked = read("civics.numUnlocked", () => c.getNumCivicsUnlocked());
    return base;
  }) || { researching: null, researched: null, target: null, turnsLeft: null, activeTree: null, availableTrees: null, methodNames: null });

  out.map = read("map", () => {
    const width = GameplayMap.getGridWidth();
    const height = GameplayMap.getGridHeight();
    const sampleLoc = read("map.sampleLoc", () => {
      const units = player ? player.Units.getUnits() : [];
      const cities = player ? player.Cities.getCities() : [];
      if (units.length && units[0].isOnMap) return units[0].location;
      if (cities.length) return cities[0].location;
      return null;
    });
    const sampleTile = sampleLoc === null ? null : read("map.sampleTile", () => {
      const x = sampleLoc.x, y = sampleLoc.y;
      const revealed = GameplayMap.getRevealedState(BOUND_PLAYER_ID, x, y);
      const tile = { x: x, y: y, revealedState: revealed === undefined ? null : revealed };
      const visibleEnum = has("RevealedStates") && RevealedStates && Number.isInteger(RevealedStates.VISIBLE) ? RevealedStates.VISIBLE : null;
      if (visibleEnum === null) throw new Error("RevealedStates.VISIBLE is not an integer; no tile details read");
      if (!Number.isInteger(revealed)) throw new Error("getRevealedState returned a non-integer; no tile details read");
      if (revealed !== visibleEnum) return tile;
      tile.terrain = read("map.sampleTile.terrain", () => GameplayMap.getTerrainType(x, y));
      tile.terrainName = read("map.sampleTile.terrainName", () => lookupName(GameInfo.Terrains, tile.terrain, "TerrainType"));
      tile.biome = read("map.sampleTile.biome", () => GameplayMap.getBiomeType(x, y));
      tile.biomeName = read("map.sampleTile.biomeName", () => lookupName(GameInfo.Biomes, tile.biome, "BiomeType"));
      tile.feature = read("map.sampleTile.feature", () => GameplayMap.getFeatureType(x, y));
      tile.featureName = read("map.sampleTile.featureName", () => lookupName(GameInfo.Features, tile.feature, "FeatureType"));
      tile.elevation = read("map.sampleTile.elevation", () => GameplayMap.getElevation(x, y));
      tile.isRiver = read("map.sampleTile.isRiver", () => GameplayMap.isRiver(x, y));
      tile.riverType = read("map.sampleTile.riverType", () => GameplayMap.getRiverType(x, y));
      tile.index = read("map.sampleTile.index", () => GameplayMap.getIndexFromXY(x, y));
      tile.indexRoundTrip = read("map.sampleTile.indexRoundTrip", () => GameplayMap.getLocationFromIndex(GameplayMap.getIndexFromXY(x, y)));
      tile.neighbors = read("map.sampleTile.neighbors", () => [0, 1, 2, 3, 4, 5].map((d) => GameplayMap.getAdjacentPlotLocation(sampleLoc, d)));
      return tile;
    });
    return {
      width: width,
      height: height,
      plotCount: read("map.plotCount", () => GameplayMap.getPlotCount()),
      methodNames: read("map.methodNames", () => methodNames(GameplayMap).filter((k) => /Reveal|Terrain|Biome|Feature|Grid|Plot|Index|Location|Elev|River|Adjacent|Direction|Yield|Width|Height|Distance|Navigable/.test(k))),
      sampleTile: sampleTile
    };
  });

  out.staticTables = read("staticTables", () => {
    const sizes = {};
    for (const k of ["Units", "ProgressionTreeNodes", "ProgressionTrees", "Terrains", "Biomes", "Features", "Ages", "Civilizations", "Leaders", "Yields"]) {
      sizes[k] = read("staticTables." + k, () => GameInfo[k].length);
    }
    return sizes;
  });
  out.progressionTrees = read("progressionTrees", () => ({ methodNames: methodNames(Game.ProgressionTrees) }));
  out.errors = errors;
  return JSON.stringify(out);
})()
