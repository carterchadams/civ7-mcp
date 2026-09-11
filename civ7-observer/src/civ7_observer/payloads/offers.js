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
  const yieldRows = []; try { for (const y of (GameInfo.Yields || [])) { if (y && isInt(y.$hash) && typeof y.YieldType === "string") yieldRows.push(y); } } catch (e) { /* no yield table in this realm */ }
  const plotYields = (x, y) => { const out = {}; for (const row of yieldRows) { const v = GameplayMap.getYield(x, y, row.$hash, BOUND_PLAYER_ID); if (typeof v === "number") out[row.YieldType.replace("YIELD_", "").toLowerCase()] = v; } return out; };
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
  const matchId = (typeof flags.campaignSetupGUID === "string" && flags.campaignSetupGUID) ? flags.campaignSetupGUID : ((typeof flags.gameGUIDHexString === "string" && flags.gameGUIDHexString) ? flags.gameGUIDHexString : null);
  if (matchId === null) return refuse("NOT_IN_GAME", "no match identity available");
  result.context = { turn: turn, age: age, ageType: lookupKey(GameInfo.Ages, age, "AgeType"), playerId: BOUND_PLAYER_ID, localPlayerId: lp, localObserverId: lo, mode: mode, isTurnActive: true, curtainDisplayed: curtain(), gameGuid: matchId };

  // ---- offers
  const offers = [];
  try {
    const blockingType = Game.Notifications.getEndTurnBlockingType(BOUND_PLAYER_ID);
    const none = typeof EndTurnBlockingTypes !== "undefined" ? EndTurnBlockingTypes.NONE : null;
    const blockerName = (v) => { for (const k of Object.keys(EndTurnBlockingTypes)) if (EndTurnBlockingTypes[k] === v) return k; return String(v); };
    if (!isInt(blockingType) || !isInt(none)) throw new Error("end-turn blocking contract unavailable");
    const blocked = blockingType !== none;
    const kinds = [["SET_TECH_TREE_NODE", player.Techs], ["SET_CULTURE_TREE_NODE", player.Culture]];
    for (const [kind, comp] of kinds) {
      if (!comp || typeof comp.getAllAvailableNodeTypes !== "function") throw new Error(kind + " component unavailable");
      const opType = PlayerOperationTypes[kind];
      if (!isInt(opType)) throw new Error("PlayerOperationTypes." + kind + " missing");
      const avail = comp.getAllAvailableNodeTypes();
      if (!Array.isArray(avail)) throw new Error(kind + " getAllAvailableNodeTypes() is not an array");
      const currentRec = comp.getResearching();
      const pre = currentRec && isInt(currentRec.type) ? currentRec.type : -1;
      for (const hash of avail) {
        if (!isInt(hash)) throw new Error(kind + " node hash is not an integer");
        const row = GameInfo.ProgressionTreeNodes.lookup(hash);
        const check = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, opType, { ProgressionTreeNodeType: hash }, false);
        offers.push({
          kind: kind, arg: hash, pre: pre,
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
        const smoves = u.Movement && isInt(u.Movement.movementMovesRemaining) ? u.Movement.movementMovesRemaining : null;
        offers.push({ kind: "SKIP_UNIT", arg: u.id.id, pre: smoves === null ? -1 : smoves, unitId: u.id.id,
          from: u.location && isInt(u.location.x) && isInt(u.location.y) && u.location.x >= 0 ? { x: u.location.x, y: u.location.y } : null,
          unitTypeKey: lookupKey(GameInfo.Units, u.type, "UnitType"),
          movesRemaining: smoves,
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
          if (!isInt(state) || state !== RevealedStates.VISIBLE) continue;   // currently visible plots only (fogged plots could leak via the native path preview)
          // canStart(MOVE_TO) does not validate the destination (live: it accepted an impassable
          // mountain that the engine then silently dropped). The shipped path preview does.
          const path = Units.getPathTo(unitId, { x: loc.x, y: loc.y });
          const plots = path && Array.isArray(path.plots) ? path.plots : [];
          const turns = path && Array.isArray(path.turns) ? path.turns : [];
          if (plots.length === 0 || turns.length === 0 || turns[turns.length - 1] !== 1) continue;   // unreachable this turn
          const moveArgs = { X: loc.x, Y: loc.y, Modifiers: 0 };
          const check = Game.UnitOperations.canStart(unitId, UnitOperationTypes.MOVE_TO, moveArgs, false);
          offers.push({ kind: "MOVE_UNIT", arg: u.id.id, x: loc.x, y: loc.y, pre: GameplayMap.getIndexFromXY(u.location.x, u.location.y), unitId: u.id.id, from: { x: u.location.x, y: u.location.y }, direction: d, unitTypeKey: lookupKey(GameInfo.Units, u.type, "UnitType"),
            terrainKey: lookupKey(GameInfo.Terrains, GameplayMap.getTerrainType(loc.x, loc.y), "TerrainType"), pathTurns: turns[turns.length - 1],
            movesRemaining: u.Movement.movementMovesRemaining, canStart: !!(check && check.Success === true) });
        }
      }
    }
    if (typeof UnitOperationTypes !== "undefined" && isInt(UnitOperationTypes.FOUND_CITY)) {
      // Founding happens where the unit stands: the shipped panel sends no target plot for
      // FOUND_CITY (X/Y stay -9999), so the offer is bound to the unit's current plot instead.
      for (const u of player.Units.getUnits()) {
        if (!u || !u.id || !isInt(u.id.id) || u.id.owner !== BOUND_PLAYER_ID) continue;
        if (u.isOnMap !== true || !u.location || !isInt(u.location.x) || !isInt(u.location.y) || u.location.x < 0) continue;
        const unitId = u.id;
        const foundArgs = { X: -9999, Y: -9999, UnitAbilityType: -1 };
        // Same two-step query as the shipped unit panel: `true` asks whether the button exists at all
        // for this unit (settler-class), `false` whether founding is legal on its current plot. A
        // settler that cannot found here is still listed, canStart false, so the seat learns to move it.
        const exists = Game.UnitOperations.canStart(unitId, UnitOperationTypes.FOUND_CITY, foundArgs, true);
        if (!exists || exists.Success !== true) continue;
        const check = Game.UnitOperations.canStart(unitId, UnitOperationTypes.FOUND_CITY, foundArgs, false);
        const ok = !!(check && check.Success === true);
        offers.push({ kind: "FOUND_CITY", arg: u.id.id, x: u.location.x, y: u.location.y, pre: GameplayMap.getIndexFromXY(u.location.x, u.location.y), unitId: u.id.id, from: { x: u.location.x, y: u.location.y },
          unitTypeKey: lookupKey(GameInfo.Units, u.type, "UnitType"), terrainKey: lookupKey(GameInfo.Terrains, GameplayMap.getTerrainType(u.location.x, u.location.y), "TerrainType"),
          movesRemaining: u.Movement && isInt(u.Movement.movementMovesRemaining) ? u.Movement.movementMovesRemaining : null, canStart: ok,
          reason: ok ? null : "the game refuses founding on this unit's current plot (the engine gives no detail; typical causes are water or navigable-river tiles, and plots too close to another settlement); move the unit first" });
      }
    }
    if (typeof CityCommandTypes !== "undefined" && isInt(CityCommandTypes.EXPAND)) {
      // New population placement: the shipped acquire-tile mode asks canStart(EXPAND, {}) for the
      // claimable plots and the improvement each would receive, then sends EXPAND {X, Y}.
      for (const c of player.Cities.getCities()) {
        if (!c || !c.id || !isInt(c.id.id) || c.id.owner !== BOUND_PLAYER_ID) continue;
        const cityId = c.id;
        const ready = !!(c.Growth && c.Growth.isReadyToPlacePopulation === true);
        const res = Game.CityCommands.canStart(cityId, CityCommandTypes.EXPAND, {}, false);
        const plots = res && Array.isArray(res.Plots) ? res.Plots : [];
        const types = res && Array.isArray(res.ConstructibleTypes) ? res.ConstructibleTypes : [];
        for (let i = 0; i < plots.length; i++) {
          const pi = plots[i];
          if (!isInt(pi)) continue;
          const loc = GameplayMap.getLocationFromIndex(pi);
          if (!loc || !isInt(loc.x) || !isInt(loc.y) || loc.x < 0) continue;
          const expandArgs = { X: loc.x, Y: loc.y };
          const check = Game.CityCommands.canStart(cityId, CityCommandTypes.EXPAND, expandArgs, false);
          const yields = plotYields(loc.x, loc.y);
          offers.push({ kind: "EXPAND_CITY", arg: c.id.id, x: loc.x, y: loc.y, pre: pi, cityId: c.id.id, cityName: compose(c.name), plotIndex: pi, growthReady: ready,
            improvementKey: isInt(types[i]) ? lookupKey(GameInfo.Constructibles, types[i], "ConstructibleType") : null,
            terrainKey: lookupKey(GameInfo.Terrains, GameplayMap.getTerrainType(loc.x, loc.y), "TerrainType"), featureKey: lookupKey(GameInfo.Features, GameplayMap.getFeatureType(loc.x, loc.y), "FeatureType"),
            river: GameplayMap.isRiver(loc.x, loc.y) === true, yields: yields, canStart: !!(check && check.Success === true) });
        }
      }
    }
    if (typeof CityOperationTypes !== "undefined" && isInt(CityOperationTypes.BUILD)) {
      const cities = player.Cities.getCities();
      if (!Array.isArray(cities)) throw new Error("getCities() is not an array");
      for (const c of cities) {
        if (!c || !c.id || !isInt(c.id.id) || c.id.owner !== BOUND_PLAYER_ID) continue;
        const cityId = c.id;
        const ppre = c.BuildQueue && isInt(c.BuildQueue.currentProductionTypeHash) ? c.BuildQueue.currentProductionTypeHash : -1;
        const cost = (fn, hash) => { try { const v = c.Production && typeof c.Production[fn] === "function" ? c.Production[fn](hash) : null; return isInt(v) ? v : null; } catch (e) { return null; } };
        const turnsFor = (hash) => { try { const v = c.BuildQueue && typeof c.BuildQueue.getTurnsLeft === "function" ? c.BuildQueue.getTurnsLeft(hash) : null; return isInt(v) ? v : null; } catch (e) { return null; } };
        for (const row of GameInfo.Units) {
          if (!row || !isInt(row.$hash) || typeof row.UnitType !== "string") continue;
          const buildArgs = { UnitType: row.$hash };
          const check = Game.CityOperations.canStart(cityId, CityOperationTypes.BUILD, buildArgs, false);
          if (!check || check.Success !== true) continue;   // only buildable units are offered
          offers.push({ kind: "PRODUCE_UNIT", arg: c.id.id, arg2: row.$hash, pre: ppre, cityId: c.id.id, cityName: compose(c.name),
            unitTypeKey: row.UnitType, displayName: typeof row.Name === "string" ? compose(row.Name) : null,
            cost: cost("getUnitProductionCost", row.$hash), turns: turnsFor(row.$hash), canStart: true });
        }
        // Buildings need a plot: the shipped chooser asks canStart(BUILD, {ConstructibleType}) and the
        // placement mode then offers `Plots` (existing urban plots) and `ExpandUrbanPlots` (rural plots
        // that would become urban). One offer per (constructible, plot); the plot index rides as arg3.
        if (GameInfo.Constructibles && typeof GameInfo.Constructibles[Symbol.iterator] === "function") {
          for (const row of GameInfo.Constructibles) {
            if (!row || !isInt(row.$hash) || typeof row.ConstructibleType !== "string") continue;
            const probe = Game.CityOperations.canStart(cityId, CityOperationTypes.BUILD, { ConstructibleType: row.$hash }, false);
            if (!probe || probe.Success !== true) continue;
            const groups = [["urban", Array.isArray(probe.Plots) ? probe.Plots : []], ["newUrban", Array.isArray(probe.ExpandUrbanPlots) ? probe.ExpandUrbanPlots : []]];
            for (const [placement, plots] of groups) {
              for (const pi of plots) {
                if (!isInt(pi)) continue;
                const loc = GameplayMap.getLocationFromIndex(pi);
                if (!loc || !isInt(loc.x) || !isInt(loc.y) || loc.x < 0) continue;
                const buildArgs = { ConstructibleType: row.$hash, X: loc.x, Y: loc.y };
                const check = Game.CityOperations.canStart(cityId, CityOperationTypes.BUILD, buildArgs, false);
                if (!check || check.Success !== true) continue;
                offers.push({ kind: "PRODUCE_CONSTRUCTIBLE", arg: c.id.id, arg2: row.$hash, arg3: pi, pre: ppre, cityId: c.id.id, cityName: compose(c.name),
                  constructibleKey: row.ConstructibleType, constructibleClass: typeof row.ConstructibleClass === "string" ? row.ConstructibleClass : null,
                  displayName: typeof row.Name === "string" ? compose(row.Name) : null, cost: cost("getConstructibleProductionCost", row.$hash), turns: turnsFor(row.$hash),
                  x: loc.x, y: loc.y, plotIndex: pi, placement: placement, terrainKey: lookupKey(GameInfo.Terrains, GameplayMap.getTerrainType(loc.x, loc.y), "TerrainType"),
                  featureKey: lookupKey(GameInfo.Features, GameplayMap.getFeatureType(loc.x, loc.y), "FeatureType"), river: GameplayMap.isRiver(loc.x, loc.y) === true, yields: plotYields(loc.x, loc.y), canStart: true });
              }
            }
          }
        }
      }
    }
    if (isInt(PlayerOperationTypes.CHANGE_TRADITION) && typeof CultureSlotTypes !== "undefined" && typeof PlayerOperationParameters !== "undefined" && isInt(PlayerOperationParameters.Activate)) {
      // Policies: the shipped policies screen lists unlocked traditions per slot type and sends
      // CHANGE_TRADITION {TraditionType: $index, Action: Activate} per card, then
      // CONSIDER_ASSIGN_TRADITIONS {} on confirm, which is what clears the TRADITIONS blocker.
      const cu = player.Culture;
      for (const slotName of ["TRADITION_CULTURE_SLOT", "POLICY_CULTURE_SLOT", "CRISIS_CULTURE_SLOT"]) {
        const st = CultureSlotTypes[slotName];
        if (!isInt(st)) continue;
        const total = cu.getNumCultureSlots(st); const active = cu.getActiveTraditions(st); const unlocked = cu.getUnlockedTraditions(st);
        if (!isInt(total) || !Array.isArray(active) || !Array.isArray(unlocked)) throw new Error("culture slot contract unavailable");
        for (const hash of unlocked) {
          if (!isInt(hash)) continue;
          const row = GameInfo.Traditions.lookup(hash);
          if (!row || !isInt(row.$index) || cu.isTraditionActive(hash) === true) continue;
          const targs = { TraditionType: row.$index, Action: PlayerOperationParameters.Activate };
          const check = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes.CHANGE_TRADITION, targs, false);
          offers.push({ kind: "CHANGE_TRADITION", arg: row.$index, arg2: hash, pre: active.length, slot: slotName, slotsTotal: total, slotsFree: total - active.length,
            typeKey: typeof row.TraditionType === "string" ? row.TraditionType : null, displayName: compose(row.Name), description: compose(row.Description), canStart: !!(check && check.Success === true) });
        }
      }
      if (blocked && blockerName(blockingType) === "TRADITIONS" && isInt(PlayerOperationTypes.CONSIDER_ASSIGN_TRADITIONS)) {
        const check = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes.CONSIDER_ASSIGN_TRADITIONS, {}, false);
        offers.push({ kind: "CONSIDER_ASSIGN_TRADITIONS", arg: 0, pre: 0, canStart: !!(check && check.Success === true) });
      }
    }
    const alreadySent = GameContext.hasSentTurnComplete() === true;
    offers.push({ kind: "END_TURN", arg: 0, pre: 0, canStart: !blocked && !alreadySent, blockingType: blocked ? blockerName(blockingType) : null, alreadySent: alreadySent });
  } catch (e) {
    return refuse("API_CONTRACT_MISMATCH", "offer enumeration failed: " + String(e && e.message ? e.message : e).slice(0, 160));
  }
  result.offers = offers;
  return JSON.stringify(result);
})()
