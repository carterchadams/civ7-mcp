// Read-only enumeration of the bound player's legal choices for the supported action kinds.
// Uses the native canStart query exactly as the shipped choosers do (hover path). Never mutates.
(() => {
  const ALLOWED = ALLOWED_MODE;
  const result = { payloadVersion: 1, refused: null, context: null, offers: null };
  const refuse = (code, message) => { result.refused = { code: code, message: message }; return JSON.stringify(result); };
  const isInt = (v) => typeof v === "number" && Number.isInteger(v);
  const MOVE_RADIUS_CAP = 4;     // how far out to look for this turn's destinations
  const MOVE_OFFER_CAP = 18;     // per unit, so one fast unit cannot fill the listing
  const isBool = (v) => typeof v === "boolean";
  const lookupKey = (table, hash, field) => {
    if (!isInt(hash) || hash === -1) return null;
    const row = table && typeof table.lookup === "function" ? table.lookup(hash) : null;
    return row && typeof row[field] === "string" ? row[field] : null;
  };
  const compose = (key) => { if (typeof key !== "string") return null; try { const s = Locale.compose(key); return typeof s === "string" ? s : key; } catch (e) { return key; } };
  const yieldRows = []; try { for (const y of (GameInfo.Yields || [])) { if (y && isInt(y.$hash) && typeof y.YieldType === "string") yieldRows.push(y); } } catch (e) { /* no yield table in this realm */ }
  const plotYields = (x, y) => { const out = {}; try { for (const row of yieldRows) { const v = GameplayMap.getYield(x, y, row.$hash, BOUND_PLAYER_ID); if (typeof v === "number") out[row.YieldType.replace("YIELD_", "").toLowerCase()] = v; } } catch (e) { /* decorative: a realm without yields still gets offers */ } return out; };
  // Worker placement yields arrive as a bare array positional over the yield table; without names a
  // seat cannot tell food from production in it.
  const namedYields = (arr) => { const out = {}; if (!Array.isArray(arr)) return out; for (let i = 0; i < yieldRows.length && i < arr.length; i++) { const v = arr[i]; if (typeof v === "number" && v !== 0) out[yieldRows[i].YieldType.replace("YIELD_", "").toLowerCase()] = v; } return out; };
  const plotYieldsNonZero = (x, y) => { const all = plotYields(x, y); const out = {}; for (const k of Object.keys(all)) { if (all[k] !== 0) out[k] = all[k]; } return out; };
  const plotIsRiver = (x, y) => { try { return GameplayMap.isRiver(x, y) === true; } catch (e) { return null; } };
  // The game's own minimum-settlement-distance rule for a plot. A plain boolean with no identity,
  // owner or position attached: it says only what the game would say if this seat tried to found here.
  const tooCloseToSettlement = (x, y) => { try { const v = GameplayMap.isCityWithinMinimumDistance(x, y); return typeof v === "boolean" ? v : null; } catch (e) { return null; } };
  // True when a visible plot holds a unit belonging to someone else. Used only to withhold a move that
  // the engine would silently drop; the defender's identity is never read out of this function.
  const occupiedByOther = (unitId, x, y) => {
    try {
      const d = Game.Combat.getBestDefender({ x: x, y: y }, unitId);
      const owner = d && typeof d.owner === "number" ? d.owner : -1;
      return Number.isInteger(owner) && owner >= 0 && owner !== BOUND_PLAYER_ID;
    } catch (e) { return false; }
  };
  // How many units a unit's army holds, or -1 when it is in none. Packing and unpacking move that
  // number, and nothing a seat does in the same breath moves it too.
  const armySizeOf = (u) => { try { if (!u.armyId || !Number.isInteger(u.armyId.id) || u.armyId.id < 0) return -1; const army = Armies.get(u.armyId); const n = army && Number.isInteger(army.unitCount) ? army.unitCount : -1; return n; } catch (e) { return -1; } };
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
    const blocksNow = (nid, n) => { try { if (typeof Game.Notifications.getBlocksTurnAdvancement === "function") { const b = Game.Notifications.getBlocksTurnAdvancement(nid); if (typeof b === "boolean") return b; } } catch (e) { /* fall back */ } return !!(n && n.BlocksTurnAdvancement === true); };
    const blockerName = (v) => { for (const k of Object.keys(EndTurnBlockingTypes)) if (EndTurnBlockingTypes[k] === v) return k; try { for (const nid of Game.Notifications.getIdsForPlayer(BOUND_PLAYER_ID)) { const n = Game.Notifications.find(nid); if (blocksNow(nid, n)) { const name = Game.Notifications.getTypeName(n.Type); if (typeof name === "string" && name) return name; } } } catch (e) { /* fall through to the raw value */ } return String(v); };
    if (!isInt(blockingType) || !isInt(none)) throw new Error("end-turn blocking contract unavailable");
    const blocked = blockingType !== none;
    // The single blocker value can be a category (live: CULTURE while government and traditions were
    // what actually blocked), so the notifications that block the turn are reported alongside it.
    const blockingNotifications = [];
    // Live (turn 93): after finishing the age transition the blocker was NONE while the choose-civilization
    // notification object lingered with BlocksTurnAdvancement still true, so the list is only consulted
    // while the engine itself says the turn is blocked.
    // A notification's own BlocksTurnAdvancement field goes stale (live: the choose-civilization one kept
    // it after the choice was finished); Game.Notifications.getBlocksTurnAdvancement(id) is the live verdict.
    if (blocked) { try { for (const nid of Game.Notifications.getIdsForPlayer(BOUND_PLAYER_ID)) { const n = Game.Notifications.find(nid); if (blocksNow(nid, n)) { const name = Game.Notifications.getTypeName(n.Type); if (typeof name === "string" && blockingNotifications.indexOf(name) === -1) blockingNotifications.push(name); } } } catch (e) { /* reported empty */ } }
    result.context.blockingNotifications = blockingNotifications;
    try { result.context.unitIds = player.Units.getUnits().filter((u) => u && u.id && isInt(u.id.id)).map((u) => u.id.id); } catch (e) { result.context.unitIds = null; }
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
          damage: u.Health && isInt(u.Health.damage) ? u.Health.damage : null,
          from: u.location && isInt(u.location.x) && isInt(u.location.y) && u.location.x >= 0 ? { x: u.location.x, y: u.location.y } : null,
          unitTypeKey: lookupKey(GameInfo.Units, u.type, "UnitType"),
          movesRemaining: smoves,
          location: u.location && isInt(u.location.x) && isInt(u.location.y) && u.location.x >= 0 ? { x: u.location.x, y: u.location.y } : null,
          canStart: !!(check && check.Success === true) });
      }
    }
    // Which units could found a settlement at all (the shipped panel's own button test). Only those
    // get the settling hint on their move options: it confused seats moving merchants and soldiers.
    const canFoundUnits = {};
    if (typeof UnitOperationTypes !== "undefined" && isInt(UnitOperationTypes.FOUND_CITY)) {
      try {
        for (const u of player.Units.getUnits()) {
          if (!u || !u.id || !isInt(u.id.id) || u.id.owner !== BOUND_PLAYER_ID) continue;
          const ex = Game.UnitOperations.canStart(u.id, UnitOperationTypes.FOUND_CITY, { X: -9999, Y: -9999, UnitAbilityType: -1 }, true);
          if (ex && ex.Success === true) canFoundUnits[u.id.id] = true;
        }
      } catch (e) { /* no settler information available */ }
    }
    if (typeof UnitOperationTypes !== "undefined" && GameInfo.UnitOperations) {
      // Standing orders a unit can be given any turn without a target: the shipped panel lists them from
      // GameInfo.UnitOperations gated by canStart. Only this fixed set is offered; anything needing a plot
      // (attacks, pillage, teleport) is a separate kind with its own legality.
      const STANDING = ["UNITOPERATION_FORTIFY", "UNITOPERATION_ALERT", "UNITOPERATION_SLEEP", "UNITOPERATION_REST_UNTIL_HEALED"];
      const orderArgs = { X: -9999, Y: -9999, UnitAbilityType: -1 };
      for (const u of player.Units.getUnits()) {
        if (!u || !u.id || !isInt(u.id.id) || u.id.owner !== BOUND_PLAYER_ID) continue;
        const unitId = u.id;
        const moves = u.Movement && isInt(u.Movement.movementMovesRemaining) ? u.Movement.movementMovesRemaining : -1;
        const damage = u.Health && isInt(u.Health.damage) ? u.Health.damage : null;
        for (const name of STANDING) {
          const row = GameInfo.UnitOperations.lookup(name);
          if (!row || !isInt(row.$hash) || row.VisibleInUI !== true) continue;
          const check = Game.UnitOperations.canStart(unitId, row.$hash, orderArgs, false);
          if (!check || check.Success !== true) continue;
          offers.push({ kind: "UNIT_ORDER", arg: u.id.id, arg2: row.$hash, pre: moves, unitId: u.id.id,
            from: u.location && isInt(u.location.x) && u.location.x >= 0 ? { x: u.location.x, y: u.location.y } : null,
            unitTypeKey: lookupKey(GameInfo.Units, u.type, "UnitType"), movesRemaining: moves === -1 ? null : moves,
            damage: damage, maxDamage: u.Health && isInt(u.Health.maxDamage) ? u.Health.maxDamage : null,
            orderKey: name, displayName: compose(row.Name), description: compose(row.Description), canStart: true });
        }
      }
    }
    if (typeof UnitOperationTypes !== "undefined" && isInt(UnitOperationTypes.MOVE_TO) && typeof RevealedStates !== "undefined" && isInt(RevealedStates.HIDDEN)) {
      for (const u of player.Units.getUnits()) {
        if (!u || !u.id || !isInt(u.id.id) || u.id.owner !== BOUND_PLAYER_ID) continue;
        if (u.isOnMap !== true || !u.location || !isInt(u.location.x) || u.location.x < 0) continue;
        if (!u.Movement || !isInt(u.Movement.movementMovesRemaining) || u.Movement.movementMovesRemaining <= 0) continue;
        const unitId = u.id;
        // Everywhere the unit can actually reach this turn, not just its six neighbours: a scout with
        // four movement had to be moved one tile per action. Breadth-first over adjacency out to the
        // unit's remaining movement, bounded, with the same one-turn native path test as before.
        const radius = Math.min(u.Movement.movementMovesRemaining, MOVE_RADIUS_CAP);
        const seen = {}; const frontier = [u.location]; const candidates = [];
        seen[GameplayMap.getIndexFromXY(u.location.x, u.location.y)] = true;
        for (let step = 0; step < radius && candidates.length < MOVE_OFFER_CAP * 3; step++) {
          const next = [];
          for (const from of frontier) {
            for (let d = 0; d < 6; d++) {
              const loc = GameplayMap.getAdjacentPlotLocation(from, d);
              if (!loc || !isInt(loc.x) || !isInt(loc.y) || loc.x < 0 || loc.y < 0) continue;
              const key = GameplayMap.getIndexFromXY(loc.x, loc.y);
              if (seen[key]) continue;
              seen[key] = true;
              next.push(loc); candidates.push({ loc: loc, steps: step + 1, dir: step === 0 ? d : -1 });
            }
          }
          frontier.length = 0; for (const n of next) frontier.push(n);
        }
        let offered = 0;
        for (const cand of candidates) {
          if (offered >= MOVE_OFFER_CAP) break;
          const loc = cand.loc;
          const d = cand.dir;
          const state = GameplayMap.getRevealedState(BOUND_PLAYER_ID, loc.x, loc.y);
          if (!isInt(state) || state !== RevealedStates.VISIBLE) continue;   // currently visible plots only (fogged plots could leak via the native path preview)
          // canStart(MOVE_TO) does not validate the destination (live: it accepted an impassable
          // mountain that the engine then silently dropped). The shipped path preview does.
          const path = Units.getPathTo(unitId, { x: loc.x, y: loc.y });
          const plots = path && Array.isArray(path.plots) ? path.plots : [];
          const turns = path && Array.isArray(path.turns) ? path.turns : [];
          if (plots.length === 0 || turns.length === 0 || turns[turns.length - 1] !== 1) continue;   // unreachable this turn
          // A plot held by another player is silently dropped by a Modifiers:NONE move (live: a warrior
          // "moved" into an independent's tile and nothing happened, outcome unknown). Only the boolean
          // is used and nothing about the occupant is ever exposed.
          if (occupiedByOther(unitId, loc.x, loc.y)) continue;
          const moveArgs = { X: loc.x, Y: loc.y, Modifiers: 0 };
          const check = Game.UnitOperations.canStart(unitId, UnitOperationTypes.MOVE_TO, moveArgs, false);
          offers.push({ kind: "MOVE_UNIT", arg: u.id.id, x: loc.x, y: loc.y, pre: GameplayMap.getIndexFromXY(u.location.x, u.location.y), unitId: u.id.id, from: { x: u.location.x, y: u.location.y }, direction: d,
            pendingOps: (typeof u.hasPendingOperations === "function" ? u.hasPendingOperations() : u.hasPendingOperations) === true, unitTypeKey: lookupKey(GameInfo.Units, u.type, "UnitType"),
            terrainKey: lookupKey(GameInfo.Terrains, GameplayMap.getTerrainType(loc.x, loc.y), "TerrainType"), pathTurns: turns[turns.length - 1], steps: cand.steps,
            featureKey: lookupKey(GameInfo.Features, GameplayMap.getFeatureType(loc.x, loc.y), "FeatureType"), river: plotIsRiver(loc.x, loc.y), yields: plotYieldsNonZero(loc.x, loc.y),
            tooCloseToSettle: canFoundUnits[u.id.id] === true ? tooCloseToSettlement(loc.x, loc.y) : undefined,
            movesRemaining: u.Movement.movementMovesRemaining, canStart: !!(check && check.Success === true) });
          offered += 1;
        }
      }
    }
    if (typeof UnitCommandTypes !== "undefined" && isInt(UnitCommandTypes.PROMOTE) && GameInfo.UnitPromotionDisciplineDetails) {
      // Promotions: the shipped panel pairs a discipline with one of its promotions, gates on
      // Experience.canEarnPromotion(disciplineType, promotionType, false), and sends PROMOTE with the
      // hashes of both type strings (row.$hash equals Database.makeHash(type) on this build).
      for (const u of player.Units.getUnits()) {
        if (!u || !u.id || !isInt(u.id.id) || u.id.owner !== BOUND_PLAYER_ID) continue;
        const e = u.Experience;
        if (!e || e.canPromote !== true) continue;
        // getNumPromotions does not count taken promotions (live: it stayed at 10 across one), so the
        // earned total is both the precondition and the signal.
        const held = isInt(e.getTotalPromotionsEarned) ? e.getTotalPromotionsEarned : 0;
        const unitId = u.id;
        for (const det of GameInfo.UnitPromotionDisciplineDetails) {
          if (!det || typeof det.UnitPromotionDisciplineType !== "string" || typeof det.UnitPromotionType !== "string") continue;
          const drow = GameInfo.UnitPromotionDisciplines.lookup(det.UnitPromotionDisciplineType);
          const prow = GameInfo.UnitPromotions.lookup(det.UnitPromotionType);
          if (!drow || !prow || !isInt(drow.$hash) || !isInt(prow.$hash)) continue;
          let earnable = false;
          try { earnable = e.canEarnPromotion(drow.UnitPromotionDisciplineType, prow.UnitPromotionType, false) === true; } catch (ex) { earnable = false; }
          if (!earnable) continue;
          const promoArgs = { PromotionType: prow.$hash, PromotionDisciplineType: drow.$hash };
          const check = Game.UnitCommands.canStart(unitId, UnitCommandTypes.PROMOTE, promoArgs, false);
          if (!check || check.Success !== true) continue;
          offers.push({ kind: "PROMOTE_UNIT", arg: u.id.id, arg2: prow.$hash, arg3: drow.$hash, pre: held, unitId: u.id.id,
            from: u.location && isInt(u.location.x) && u.location.x >= 0 ? { x: u.location.x, y: u.location.y } : null,
            unitTypeKey: lookupKey(GameInfo.Units, u.type, "UnitType"), discipline: drow.UnitPromotionDisciplineType, disciplineName: compose(drow.Name),
            typeKey: prow.UnitPromotionType, displayName: compose(prow.Name), description: compose(prow.Description),
            commendation: prow.Commendation === true, promotionsEarned: held, promotionPoints: isInt(e.getStoredPromotionPoints) ? e.getStoredPromotionPoints : null,
            commendationPoints: isInt(e.getStoredCommendations) ? e.getStoredCommendations : null, unitLevel: isInt(e.getLevel) ? e.getLevel : null, canStart: true });
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
        if (canFoundUnits[u.id.id] !== true) continue;
        const check = Game.UnitOperations.canStart(unitId, UnitOperationTypes.FOUND_CITY, foundArgs, false);
        const ok = !!(check && check.Success === true);
        const close = tooCloseToSettlement(u.location.x, u.location.y);
        offers.push({ kind: "FOUND_CITY", arg: u.id.id, x: u.location.x, y: u.location.y, pre: GameplayMap.getIndexFromXY(u.location.x, u.location.y), unitId: u.id.id, from: { x: u.location.x, y: u.location.y },
          unitTypeKey: lookupKey(GameInfo.Units, u.type, "UnitType"), terrainKey: lookupKey(GameInfo.Terrains, GameplayMap.getTerrainType(u.location.x, u.location.y), "TerrainType"),
          featureKey: lookupKey(GameInfo.Features, GameplayMap.getFeatureType(u.location.x, u.location.y), "FeatureType"), river: plotIsRiver(u.location.x, u.location.y), yields: plotYieldsNonZero(u.location.x, u.location.y),
          movesRemaining: u.Movement && isInt(u.Movement.movementMovesRemaining) ? u.Movement.movementMovesRemaining : null, canStart: ok,
          tooCloseToSettle: close,
          reason: ok ? null : (close === true
            ? "this plot is inside the game's minimum distance from an existing settlement; the move options carry tooCloseToSettle, so walk to a plot where it is false"
            : "the game refuses founding here and it is not the minimum-settlement-distance rule (typical remaining causes are water or navigable-river tiles); move the unit first") });
      }
    }
    if (typeof CityCommandTypes !== "undefined" && isInt(CityCommandTypes.CHANGE_GROWTH_MODE) && typeof GrowthTypes !== "undefined" && isInt(GrowthTypes.PROJECT) && GameInfo.Projects) {
      // A town specialises through CHANGE_GROWTH_MODE {Type: PROJECT, ProjectType, City}, not the build
      // queue (live: every BUILD of a project was refused for a town and accepted for a city).
      for (const c of player.Cities.getCities()) {
        if (!c || !c.id || !isInt(c.id.id) || c.id.owner !== BOUND_PLAYER_ID || c.isTown !== true) continue;
        const cityId = c.id;
        const cur = c.Growth && isInt(c.Growth.projectType) ? c.Growth.projectType : -1;
        // A town already running a project keeps it: the engine's check accepts a second choice and
        // then drops it (live, twice on turn 56, both unknown). Only a town with no project is offered.
        if (cur !== -1) continue;
        // (A town running a project can instead be returned to growth: see TOWN_GROWTH_MODE below.)
        for (const pr of GameInfo.Projects) {
          if (!pr || !isInt(pr.$hash) || typeof pr.ProjectType !== "string") continue;
          const gargs = { Type: GrowthTypes.PROJECT, ProjectType: pr.$hash, City: c.id.id };
          const check = Game.CityCommands.canStart(cityId, CityCommandTypes.CHANGE_GROWTH_MODE, gargs, false);
          if (!check || check.Success !== true) continue;
          offers.push({ kind: "CHOOSE_TOWN_PROJECT", arg: c.id.id, arg2: pr.$hash, pre: cur, cityId: c.id.id, cityName: compose(c.name),
            typeKey: pr.ProjectType, displayName: compose(pr.Name), description: compose(pr.Description),
            cost: isInt(pr.Cost) ? pr.Cost : null, townDefault: pr.TownDefault === true, upgradeToCity: pr.UpgradeToCity === true, canStart: true });
        }
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
    // ---- trade routes
    // The route list says which routes are legal in principle; the command itself succeeds only once
    // the merchant stands in range of the target city (live: four routes marked SUCCESS, every check
    // false, so nothing was ever offered). The shipped chooser then sends the merchant walking to the
    // nearest plot of that city, an ordinary multi-turn move, and the player confirms on arrival. Both
    // halves are offered: make the route when in range, otherwise send the merchant.
    // A seat cannot aim at a city it cannot see. This block may read, for each city the engine itself
    // names as a route target for this seat, only its name, location and plots. Nothing else about it.
    // BEGIN VETTED TRADE TARGET SCOPE
    const tradeTargets = () => {
      const out = [];
      try {
        for (const rt of player.Trade.projectPossibleTradeRoutes()) {
          if (!rt || !rt.targetCityId || !Array.isArray(rt.status) || rt.status.indexOf(TradeRouteStatus.SUCCESS) === -1) continue;
          const city = Cities.get(rt.targetCityId);
          if (!city || !city.location || !isInt(city.location.x)) continue;
          let plots = []; try { const v = city.getPurchasedPlots(); if (Array.isArray(v)) plots = v.filter(isInt); } catch (e) { plots = []; }
          out.push({ cityId: rt.targetCityId.id, owner: rt.targetCityId.owner, name: compose(city.name), x: city.location.x, y: city.location.y,
                     plots: plots, domain: isInt(rt.domain) ? rt.domain : null, pathLength: Array.isArray(rt.pathPlots) ? rt.pathPlots.length : null });
        }
      } catch (e) { return []; }
      return out;
    };
    // END VETTED TRADE TARGET SCOPE
    if (typeof UnitCommandTypes !== "undefined" && isInt(UnitCommandTypes.MAKE_TRADE_ROUTE) && player.Trade && typeof player.Trade.projectPossibleTradeRoutes === "function" &&
        typeof TradeRouteStatus !== "undefined" && typeof Cities !== "undefined" && typeof Units !== "undefined" &&
        typeof UnitOperationTypes !== "undefined" && isInt(UnitOperationTypes.MOVE_TO) &&
        typeof UnitOperationMoveModifiers !== "undefined" && isInt(UnitOperationMoveModifiers.MOVE_IGNORE_UNEXPLORED_DESTINATION)) {
      const targets = tradeTargets();
      let activeRoutes = null; try { const v = player.Trade.countPlayerTradeRoutes(); activeRoutes = isInt(v) ? v : null; } catch (e) { activeRoutes = null; }
      let merchants = 0; try { for (const u of player.Units.getUnits()) { const r = u && GameInfo.Units.lookup(u.type); if (r && r.MakeTradeRoute === true) merchants++; } } catch (e) { merchants = 0; }
      result.context.tradeRoutes = { possible: targets.length, merchants: merchants, active: activeRoutes };
      if (targets.length) for (const u of player.Units.getUnits()) {
        if (!u || !u.id || !isInt(u.id.id) || u.id.owner !== BOUND_PLAYER_ID) continue;
        const urow = GameInfo.Units.lookup(u.type);
        if (!urow || urow.MakeTradeRoute !== true) continue;
        if (u.isOnMap !== true || !u.location || !isInt(u.location.x) || u.location.x < 0) continue;
        const unitId = u.id;
        const here = GameplayMap.getIndexFromXY(u.location.x, u.location.y);
        const moves = u.Movement && isInt(u.Movement.movementMovesRemaining) ? u.Movement.movementMovesRemaining : 0;
        for (const t of targets) {
          const common = { unitId: u.id.id, from: { x: u.location.x, y: u.location.y }, unitTypeKey: typeof urow.UnitType === "string" ? urow.UnitType : null,
            to: { x: t.x, y: t.y }, cityName: t.name, targetPlayerId: t.owner, domain: t.domain === 0 ? "land" : (t.domain === 2 ? "sea" : t.domain),
            routeLength: t.pathLength, activeRoutes: activeRoutes };
          const tradeArgs = { X: t.x, Y: t.y };
          const check = Game.UnitCommands.canStart(unitId, UnitCommandTypes.MAKE_TRADE_ROUTE, tradeArgs, false);
          if (check && check.Success === true) { offers.push({ kind: "MAKE_TRADE_ROUTE", arg: u.id.id, arg2: t.x, arg3: t.y, pre: here, ...common, inRange: true, canStart: true }); continue; }
          if (moves < 1) continue;
          // Out of range: the nearest plot of that city a path reaches, as the shipped chooser picks it.
          const ranked = t.plots.map((pi) => { const loc = GameplayMap.getLocationFromIndex(pi); return loc && isInt(loc.x) && loc.x >= 0 ? { pi: pi, loc: loc, d: GameplayMap.getPlotDistance(u.location.x, u.location.y, loc.x, loc.y) } : null; }).filter((r) => r && isInt(r.d)).sort((a, b) => a.d - b.d);
          let dest = null, turns = null;
          for (const r of ranked) {
            const path = Units.getPathTo(unitId, { x: r.loc.x, y: r.loc.y });
            if (path && Array.isArray(path.plots) && path.plots.length > 0) { dest = r; turns = Array.isArray(path.turns) && path.turns.length ? path.turns[path.turns.length - 1] : null; break; }
          }
          if (!dest) continue;
          const sendArgs = { X: dest.loc.x, Y: dest.loc.y, Modifiers: UnitOperationMoveModifiers.MOVE_IGNORE_UNEXPLORED_DESTINATION };
          const scheck = Game.UnitOperations.canStart(unitId, UnitOperationTypes.MOVE_TO, sendArgs, false);
          if (!scheck || scheck.Success !== true) continue;
          offers.push({ kind: "SEND_MERCHANT", arg: u.id.id, arg2: dest.loc.x, arg3: dest.loc.y, pre: here, ...common, inRange: false, pathTurns: turns, canStart: true });
        }
      }
    }
    // A standing research or civic goal: any unfinished node in the seat's active tree, however far
    // off, that the engine accepts as a target. The game then researches its way there by itself,
    // instead of blocking the turn for a fresh choice every time one node finishes.
    for (const [targetKind, comp, treeType] of [["SET_TECH_TREE_TARGET_NODE", player.Techs, (() => { try { return player.Techs.getTreeType(); } catch (e) { return null; } })()],
                                                ["SET_CULTURE_TREE_TARGET_NODE", player.Culture, (() => { try { return player.Culture.getActiveTree(); } catch (e) { return null; } })()]]) {
      if (!isInt(PlayerOperationTypes[targetKind]) || !comp || typeof comp.getTargetNode !== "function" || !isInt(treeType)) continue;
      if (!GameInfo.ProgressionTreeNodes || typeof GameInfo.ProgressionTreeNodes[Symbol.iterator] !== "function") continue;
      const treeRow = GameInfo.ProgressionTrees && typeof GameInfo.ProgressionTrees.lookup === "function" ? GameInfo.ProgressionTrees.lookup(treeType) : null;
      const treeKey = treeRow && typeof treeRow.ProgressionTreeType === "string" ? treeRow.ProgressionTreeType : null;
      if (!treeKey) continue;
      let held = null; try { held = comp.getTargetNode(); } catch (e) { held = null; }
      if (!isInt(held)) continue;
      for (const nd of GameInfo.ProgressionTreeNodes) {
        if (!nd || !isInt(nd.$hash) || nd.ProgressionTree !== treeKey) continue;
        if (nd.$hash === held) continue;   // already the standing goal
        const check = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes[targetKind], { ProgressionTreeNodeType: nd.$hash }, false);
        if (!check || check.Success !== true) continue;
        let cost = null, turns = null;
        try { const c = comp.getNodeCost(nd.$hash); cost = isInt(c) ? c : null; } catch (e) { cost = null; }
        try { const t = comp.getTurnsForNode(nd.$hash); turns = isInt(t) ? t : null; } catch (e) { turns = null; }
        offers.push({ kind: targetKind, arg: nd.$hash, pre: held, typeKey: nd.ProgressionTreeNodeType,
          displayName: typeof nd.Name === "string" ? compose(nd.Name) : null, tree: treeKey,
          cost: cost, turns: turns, currentTarget: held, canStart: true });
      }
    }
    // Disbanding a unit destroys it outright. The engine flags the command as needing confirmation and
    // supplies its own warning text, both of which ride along so the seat cannot take it by accident.
    if (typeof UnitCommandTypes !== "undefined" && isInt(UnitCommandTypes.DELETE)) {
      for (const u of player.Units.getUnits()) {
        if (!u || !u.id || !isInt(u.id.id) || u.id.owner !== BOUND_PLAYER_ID) continue;
        const check = Game.UnitCommands.canStart(u.id, UnitCommandTypes.DELETE, { X: -9999, Y: -9999, UnitAbilityType: -1 }, false);
        if (!check || check.Success !== true) continue;
        const warning = Array.isArray(check.ConfirmDialogBody) ? check.ConfirmDialogBody.filter((b) => typeof b === "string") : [];
        offers.push({ kind: "DISBAND_UNIT", arg: u.id.id, pre: player.Units.getUnits().length, unitId: u.id.id,
          unitTypeKey: lookupKey(GameInfo.Units, u.type, "UnitType"),
          from: u.location && isInt(u.location.x) && u.location.x >= 0 ? { x: u.location.x, y: u.location.y } : null,
          destructive: true, requiresConfirmation: check.RequiresConfirmation === true, warning: warning, canStart: true });
      }
    }
    // Specialists: a settlement's population worked onto a specific tile. The shipped tile-picker
    // reads the city's own placement info, skips the blocked plots and sends ASSIGN_WORKER for the
    // PLOT INDEX (not x/y) as a PLAYER operation, not a city one.
    if (isInt(PlayerOperationTypes.ASSIGN_WORKER)) {
      for (const c of player.Cities.getCities()) {
        if (!c || !c.id || !isInt(c.id.id) || c.id.owner !== BOUND_PLAYER_ID || !c.Workers) continue;
        // A specialist is a population point being placed. Without one pending the engine's check
        // still says yes and then drops the request (live: nothing landed, outcome unknown), so the
        // offer follows the same readiness flag the population placement itself does.
        if (!(c.Growth && c.Growth.isReadyToPlacePopulation === true)) continue;
        let info = null; try { info = c.Workers.GetAllPlacementInfo(); } catch (e) { info = null; }
        if (!Array.isArray(info)) continue;
        let cityCap = null, cityWorkers = null;
        try { const v = c.Workers.getCityWorkerCap(); cityCap = isInt(v) ? v : null; } catch (e) { cityCap = null; }
        try { const v = c.Workers.getNumWorkers(false); cityWorkers = isInt(v) ? v : null; } catch (e) { cityWorkers = null; }
        for (const slot of info) {
          if (!slot || slot.IsBlocked === true || !isInt(slot.PlotIndex) || !isInt(slot.NumWorkers)) continue;
          const workerArgs = { Location: slot.PlotIndex, Amount: 1 };
          const check = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes.ASSIGN_WORKER, workerArgs, false);
          if (!check || check.Success !== true) continue;
          const loc = GameplayMap.getLocationFromIndex(slot.PlotIndex);
          offers.push({ kind: "ASSIGN_WORKER", arg: c.id.id, arg2: slot.PlotIndex, pre: slot.NumWorkers,
            cityId: c.id.id, cityName: compose(c.name), plotIndex: slot.PlotIndex,
            x: loc && isInt(loc.x) ? loc.x : null, y: loc && isInt(loc.y) ? loc.y : null,
            workers: slot.NumWorkers, maxWorkers: isInt(slot.MaxWorkers) ? slot.MaxWorkers : null,
            cityWorkers: cityWorkers, cityWorkerCap: cityCap,
            // The engine gives the yields this plot makes now and what it would make with one more
            // specialist on it, plus the upkeep each way: that difference is the whole decision.
            yields: namedYields(slot.CurrentYields), yieldsNext: namedYields(slot.NextYields),
            upkeep: namedYields(slot.CurrentMaintenance), upkeepNext: namedYields(slot.NextMaintenance),
            terrainKey: loc ? lookupKey(GameInfo.Terrains, GameplayMap.getTerrainType(loc.x, loc.y), "TerrainType") : null,
            canStart: true });
        }
      }
    }
    // Unit commands that are neither a move nor an order: joining and leaving an army, packing and
    // unpacking one, spending a great person, and paying gold to upgrade. All six go through the one
    // generic path the shipped unit-action list uses, with its no-target argument shape; the ones
    // that need a plot take it from the engine's own Plots list for that command.
    if (typeof UnitCommandTypes !== "undefined") {
      const NO_TARGET = { X: -9999, Y: -9999, UnitAbilityType: -1 };
      const COMMANDS = [
        // [command, whether it needs a plot, what would prove it happened]
        ["UPGRADE", false, "type"],
        ["PACK_ARMY", false, "armySize"],
        ["ADD_TO_ARMY", true, "army"],
        ["REMOVE_FROM_ARMY", true, "army"],
        ["UNPACK_ARMY", true, "armySize"],
        ["ACTIVATE_GREAT_PERSON", true, "gone"],
        ["WAKE", false, "awake"],
        ["CANCEL", false, "awake"],
        ["PLUNDER_TRADE_ROUTE", false, "spent"],
        // A migrant settles into a settlement's plot, growing it by one; the plot list is the engine's,
        // and the shipped acquire-tile mode lists with an empty argument and sends the plot alone.
        ["RESETTLE", true, "gone"],
      ];
      for (const u of player.Units.getUnits()) {
        if (!u || !u.id || !isInt(u.id.id) || u.id.owner !== BOUND_PLAYER_ID) continue;
        const unitId = u.id;
        const unitKey = lookupKey(GameInfo.Units, u.type, "UnitType");
        for (const [command, needsPlot, expect] of COMMANDS) {
          const commandType = UnitCommandTypes[command];
          if (!isInt(commandType)) continue;
          const check = Game.UnitCommands.canStart(unitId, commandType, command === "RESETTLE" ? {} : NO_TARGET, false);
          if (!check || check.Success !== true) continue;
          // The engine returns the gold price and what the unit becomes as one composed line, which
          // is what the shipped tooltip shows; there is no separate accessor for either.
          const detail = typeof check.AdditionalDescription === "string" ? compose(check.AdditionalDescription) : null;
          const common = { kind: command, arg: u.id.id, unitId: u.id.id, unitTypeKey: unitKey, expect: expect,
            from: u.location && isInt(u.location.x) && u.location.x >= 0 ? { x: u.location.x, y: u.location.y } : null,
            description: detail, armyId: u.armyId && isInt(u.armyId.id) ? u.armyId.id : null,
            isCommander: u.isCommanderUnit === true, canStart: true };
          const pre = expect === "type" ? (isInt(u.type) ? u.type : -1)
                    : expect === "army" ? (u.armyId && isInt(u.armyId.id) ? u.armyId.id : -1)
                    : expect === "armySize" ? armySizeOf(u)
                    : expect === "spent" ? (u.Movement && isInt(u.Movement.movementMovesRemaining) ? u.Movement.movementMovesRemaining : 0)
                    : expect === "awake" ? (u.isReadyToMove === true ? 1 : 0)
                    : 1;
          if (!needsPlot) { offers.push({ ...common, pre: pre }); continue; }
          let plots = Array.isArray(check.Plots) ? check.Plots : [];
          if (plots.length === 0 && command === "ACTIVATE_GREAT_PERSON") {
            try { if (u.shouldShowActivationPlots(command === "ACTIVATE_GREAT_PERSON" ? "UNITCOMMAND_ACTIVATE_GREAT_PERSON" : command)) { const p = u.getActivationPlots("UNITCOMMAND_ACTIVATE_GREAT_PERSON", false); if (Array.isArray(p)) plots = p; } } catch (e) { /* none */ }
          }
          let offeredHere = 0;
          for (let k = 0; k < plots.length; k++) {
            const pi = plots[k];
            if (offeredHere >= (command === "RESETTLE" ? 10 : 6)) break;
            if (!isInt(pi)) continue;
            const loc = GameplayMap.getLocationFromIndex(pi);
            if (!loc || !isInt(loc.x) || loc.x < 0) continue;
            const cmdArgs = command === "RESETTLE" ? { X: loc.x, Y: loc.y } : { X: loc.x, Y: loc.y, UnitAbilityType: -1 };
            const at = Game.UnitCommands.canStart(unitId, commandType, cmdArgs, false);
            if (!at || at.Success !== true) continue;
            const offer = { ...common, arg2: loc.x, arg3: loc.y, pre: pre, to: { x: loc.x, y: loc.y }, plotIndex: pi,
              terrainKey: lookupKey(GameInfo.Terrains, GameplayMap.getTerrainType(loc.x, loc.y), "TerrainType") };
            // the engine names, per plot, what the settling migrant would build there
            if (command === "RESETTLE") offer.constructibleKey = Array.isArray(check.ConstructibleTypes) && isInt(check.ConstructibleTypes[k]) ? lookupKey(GameInfo.Constructibles, check.ConstructibleTypes[k], "ConstructibleType") : null;
            offers.push(offer);
            offeredHere++;
          }
        }
      }
    }
    // ---- logistics, commanders, unique abilities and tile work (A19-A22). Every one of these goes
    // through the shipped unit-action loop's two shapes: a no-target send with the
    // {X:-9999, Y:-9999, UnitAbilityType:-1} sentinel, or a plot picked from the engine's own Plots
    // list and sent as {X, Y}. Which shape applies is read off the engine, not assumed: a listing that
    // hands back plots is a plot action, one that merely succeeds is a no-target one (arg2/arg3 -1).
    // Each row says what would prove it happened: the unit spent moves or was consumed ("used"),
    // moved ("moved"), left the map to travel ("offmap"), or gold was paid ("gold").
    {
      const NO_TARGET = { X: -9999, Y: -9999, UnitAbilityType: -1 };
      const OPERATIONS = [
        // [operation, what would prove it, whether it needs an explicit confirmation]
        ["REINFORCE_ARMY", "offmap", false],
        ["REBASE", "moved", false],
        ["TELEPORT_TO_CITY", "moved", false],
        ["ESTABLISH_BASE", "used", false],
        ["DISPERSE_INDEPENDENT", "used", true],
        ["CONVERT_ADJACENT_INDEPENDENT_TO_CITYSTATE", "used", true],
        ["REPAIR", "used", false],
        ["REMOVE_FEATURE", "used", false],
        ["REMOVE_IMPROVEMENT", "used", false],
        ["PLANT_FOREST", "used", false],
        ["HARVEST_RESOURCE", "used", false],
        ["BUILD_IMPROVEMENT", "used", false],
        ["EMBED_LOOKOUT", "used", false],
        ["SEARCH", "used", false],
        ["AERIAL_RECON", "used", false],
        ["CALL_REINFORCEMENTS", "used", false]
      ];
      const ABILITY_COMMANDS = [
        ["CONNECT_WITH_ROAD", "used", false],
        ["MOVE_BY_RAIL", "moved", false],
        ["UPGRADE_ARMY", "gold", false],
        ["FOCUSED_ATTACK_LAND_MELEE", "used", false],
        ["FOCUSED_ATTACK_LAND_RANGED", "used", false],
        ["FOCUSED_ATTACK_SEA_MELEE", "used", false],
        ["FOCUSED_ATTACK_SEA_RANGED", "used", false],
        ["FOCUSED_ATTACK_AIR_TO_AIR", "used", false],
        ["FOCUSED_ATTACK_AIR_TO_LAND", "used", false],
        ["FOCUSED_ATTACK_AIR_BOMB", "used", false],
        ["ARMY_OVERRUN", "used", false],
        ["COMMANDER_ATTACK", "used", false],
        ["STONE_TRAP", "used", false],
        ["TREAT_SICK", "used", false],
        ["CLAIM_RESOURCE", "used", false],
        ["SCORCHED_EARTH", "used", true],
        ["DISPERSE_CLAN", "used", true]
      ];
      const stateFor = (u, expect) => expect === "moved" ? (u.location && isInt(u.location.x) && u.location.x >= 0 ? GameplayMap.getIndexFromXY(u.location.x, u.location.y) : -1)
                                   : expect === "offmap" ? (u.isOnMap === true ? 1 : 0)
                                   : expect === "gold" ? (player.Treasury && typeof player.Treasury.goldBalance === "number" ? Math.floor(player.Treasury.goldBalance) : 0)
                                   : (u.Movement && isInt(u.Movement.movementMovesRemaining) ? u.Movement.movementMovesRemaining : 0);
      const enumerate = (rows, types, api, kindOf) => {
        if (typeof types === "undefined" || !api) return;
        for (const [name, expect, confirm] of rows) {
          const type = types[name];
          if (!isInt(type)) continue;
          for (const u of player.Units.getUnits()) {
            if (!u || !u.id || !isInt(u.id.id) || u.id.owner !== BOUND_PLAYER_ID) continue;
            const probe = api.canStart(u.id, type, NO_TARGET, false);
            if (!probe || probe.Success !== true) continue;
            let plots = Array.isArray(probe.Plots) ? probe.Plots : [];
            if (plots.length === 0) { const listing = api.canStart(u.id, type, {}, false); if (listing && Array.isArray(listing.Plots)) plots = listing.Plots; }
            const detail = typeof probe.AdditionalDescription === "string" ? compose(probe.AdditionalDescription) : null;
            const common = { kind: kindOf(name), arg: u.id.id, pre: stateFor(u, expect), unitId: u.id.id, unitTypeKey: lookupKey(GameInfo.Units, u.type, "UnitType"), expect: expect,
              from: u.location && isInt(u.location.x) && u.location.x >= 0 ? { x: u.location.x, y: u.location.y } : null,
              movesLeft: u.Movement && isInt(u.Movement.movementMovesRemaining) ? u.Movement.movementMovesRemaining : null,
              isCommander: u.isCommanderUnit === true, description: detail, canStart: true };
            if (confirm) { common.requiresConfirmation = true; common.destructive = true; }
            if (plots.length === 0) { offers.push({ ...common, arg2: -1, arg3: -1 }); continue; }
            let offeredHere = 0;
            for (const pi of plots) {
              if (offeredHere >= 8 || !isInt(pi)) continue;
              const loc = GameplayMap.getLocationFromIndex(pi);
              if (!loc || !isInt(loc.x) || loc.x < 0) continue;
              const at = api.canStart(u.id, type, { X: loc.x, Y: loc.y }, false);
              if (!at || at.Success !== true) continue;
              offers.push({ ...common, arg2: loc.x, arg3: loc.y, to: { x: loc.x, y: loc.y }, plotIndex: pi,
                terrainKey: lookupKey(GameInfo.Terrains, GameplayMap.getTerrainType(loc.x, loc.y), "TerrainType") });
              offeredHere++;
            }
          }
        }
      };
      enumerate(OPERATIONS, typeof UnitOperationTypes === "undefined" ? undefined : UnitOperationTypes, Game.UnitOperations, (n) => n);
      enumerate(ABILITY_COMMANDS, typeof UnitCommandTypes === "undefined" ? undefined : UnitCommandTypes, Game.UnitCommands, (n) => n);
    }
    // ---- pillage, coastal raid, pillage a route (A08). The shipped pillage modes ask canStart with
    // an empty argument for the legal plot set and send the chosen plot; the attack is spent either
    // way, so the unit's own remaining moves and attacks are the proof.
    if (typeof UnitOperationTypes !== "undefined") {
      for (const opName of ["PILLAGE", "COASTAL_RAID", "PILLAGE_ROUTE"]) {
        const opType = UnitOperationTypes[opName];
        if (!isInt(opType)) continue;
        for (const u of player.Units.getUnits()) {
          if (!u || !u.id || !isInt(u.id.id) || u.id.owner !== BOUND_PLAYER_ID || u.isOnMap !== true || !u.location) continue;
          const listing = Game.UnitOperations.canStart(u.id, opType, {}, false);
          if (!listing || listing.Success !== true || !Array.isArray(listing.Plots) || listing.Plots.length === 0) continue;
          const moves = u.Movement && isInt(u.Movement.movementMovesRemaining) ? u.Movement.movementMovesRemaining : 0;
          let offeredHere = 0;
          for (const pi of listing.Plots) {
            if (offeredHere >= 6 || !isInt(pi)) continue;
            const loc = GameplayMap.getLocationFromIndex(pi);
            if (!loc || !isInt(loc.x) || loc.x < 0) continue;
            const check = Game.UnitOperations.canStart(u.id, opType, { X: loc.x, Y: loc.y }, false);
            if (!check || check.Success !== true) continue;
            offers.push({ kind: opName, arg: u.id.id, arg2: loc.x, arg3: loc.y, pre: moves, unitId: u.id.id, unitTypeKey: lookupKey(GameInfo.Units, u.type, "UnitType"),
              from: { x: u.location.x, y: u.location.y }, to: { x: loc.x, y: loc.y }, plotIndex: pi, movesLeft: moves,
              terrainKey: lookupKey(GameInfo.Terrains, GameplayMap.getTerrainType(loc.x, loc.y), "TerrainType"), canStart: true });
            offeredHere++;
          }
        }
      }
      // Spreading religion (A09): a plot-target operation whose legal plots come from the unit's own
      // activation plots, as the shipped button highlights them. Charges are read off the check.
      const spreadType = UnitOperationTypes.SPREAD_RELIGION;
      if (isInt(spreadType)) for (const u of player.Units.getUnits()) {
        if (!u || !u.id || !isInt(u.id.id) || u.id.owner !== BOUND_PLAYER_ID || u.isOnMap !== true || !u.location) continue;
        const probe = Game.UnitOperations.canStart(u.id, spreadType, { X: -9999, Y: -9999, UnitAbilityType: -1 }, false);
        if (!probe || probe.Success !== true) continue;
        const charges = isInt(probe.ChargesRemaining) ? probe.ChargesRemaining : null;
        let plots = []; try { const v = u.getActivationOperationPlots("UNITOPERATION_SPREAD_RELIGION", false); if (Array.isArray(v)) plots = v; } catch (e) { plots = []; }
        let offeredHere = 0;
        for (const pi of plots) {
          if (offeredHere >= 6 || !isInt(pi)) continue;
          const loc = GameplayMap.getLocationFromIndex(pi);
          if (!loc || !isInt(loc.x) || loc.x < 0) continue;
          const check = Game.UnitOperations.canStart(u.id, spreadType, { X: loc.x, Y: loc.y, UnitAbilityType: -1 }, false);
          if (!check || check.Success !== true) continue;
          offers.push({ kind: "SPREAD_RELIGION", arg: u.id.id, arg2: loc.x, arg3: loc.y, pre: isInt(charges) ? charges : -1, unitId: u.id.id, unitTypeKey: lookupKey(GameInfo.Units, u.type, "UnitType"),
            from: { x: u.location.x, y: u.location.y }, to: { x: loc.x, y: loc.y }, plotIndex: pi, charges: charges, canStart: true });
          offeredHere++;
        }
      }
    }
    // ---- attacking
    // A seat cannot choose a target it cannot see. This block may read the defender standing on a
    // plot THIS unit can legally attack right now, and of it only the unit's type name and how hurt
    // it is: exactly the two things the shipped combat preview puts in front of a human before the
    // same click. No owner, no position beyond the plot already named, nothing off that plot.
    // BEGIN VETTED DEFENDER SCOPE
    const defenderOn = (unitId, x, y) => {
      try {
        const d = Game.Combat.getBestDefender({ x: x, y: y }, unitId);
        if (!d || !isInt(d.id)) return null;
        const target = Units.get(d);
        if (!target) return null;
        const health = target.Health;
        return { typeKey: lookupKey(GameInfo.Units, target.type, "UnitType"),
                 damage: health && isInt(health.damage) ? health.damage : null,
                 maxDamage: health && isInt(health.maxDamage) ? health.maxDamage : null };
      } catch (e) { return null; }
    };
    // END VETTED DEFENDER SCOPE
    if (typeof UnitOperationTypes !== "undefined" && isInt(UnitOperationTypes.MOVE_TO) && isInt(UnitOperationTypes.RANGE_ATTACK) &&
        typeof UnitOperationMoveModifiers !== "undefined" && isInt(UnitOperationMoveModifiers.ATTACK) &&
        isInt(UnitOperationMoveModifiers.MOVE_IGNORE_UNEXPLORED_DESTINATION) &&
        typeof RevealedStates !== "undefined" && typeof CombatTypes !== "undefined" &&
        typeof Units !== "undefined" && typeof Game.Combat !== "undefined") {
      const ATTACK_MODS = UnitOperationMoveModifiers.ATTACK + UnitOperationMoveModifiers.MOVE_IGNORE_UNEXPLORED_DESTINATION;
      for (const u of player.Units.getUnits()) {
        if (!u || !u.id || !isInt(u.id.id) || u.id.owner !== BOUND_PLAYER_ID) continue;
        const combat = u.Combat;
        if (!combat || combat.isCombat !== true || combat.canAttack !== true) continue;
        const attacks = isInt(combat.attacksRemaining) ? combat.attacksRemaining : 0;
        if (attacks < 1) continue;
        const unitId = u.id;
        // The shipped picker's own reach: every plot this unit could strike, ranged or not.
        const targets = {};
        try { const reach = Units.getReachableTargets(unitId); if (Array.isArray(reach)) for (const pi of reach) if (isInt(pi)) targets[pi] = true; } catch (e) { /* fall back to adjacency */ }
        if (Object.keys(targets).length === 0) {
          for (let d = 0; d < 6; d++) { const loc = GameplayMap.getAdjacentPlotLocation(u.location, d); if (loc && isInt(loc.x) && loc.x >= 0) targets[GameplayMap.getIndexFromXY(loc.x, loc.y)] = true; }
        }
        let offered = 0;
        for (const key of Object.keys(targets)) {
          if (offered >= 6) break;
          const pi = Number(key);
          const loc = GameplayMap.getLocationFromIndex(pi);
          if (!loc || !isInt(loc.x) || loc.x < 0) continue;
          if (GameplayMap.getRevealedState(BOUND_PLAYER_ID, loc.x, loc.y) !== RevealedStates.VISIBLE) continue;
          const defender = defenderOn(unitId, loc.x, loc.y);
          if (!defender) continue;
          // The engine's own classifier decides which kind of attack this is, exactly as the shipped
          // dispatcher does; the payload never guesses from the unit's strengths.
          let ranged = false;
          try { ranged = Game.Combat.testAttackInto(unitId, { X: loc.x, Y: loc.y }) === CombatTypes.COMBAT_RANGED; } catch (e) { ranged = false; }
          const attackArgs = ranged ? { X: loc.x, Y: loc.y } : { X: loc.x, Y: loc.y, Modifiers: ATTACK_MODS };
          const opType = ranged ? UnitOperationTypes.RANGE_ATTACK : UnitOperationTypes.MOVE_TO;
          const check = Game.UnitOperations.canStart(unitId, opType, attackArgs, false);
          if (!check || check.Success !== true) continue;
          // Striking someone this seat is not yet at war with starts that war.
          let startsWar = null;
          try { const w = player.Diplomacy.willMoveStartWar(unitId, { x: loc.x, y: loc.y }); startsWar = w && typeof w.Success === "boolean" ? w.Success : null; } catch (e) { startsWar = null; }
          offers.push({ kind: "ATTACK", arg: u.id.id, arg2: loc.x, arg3: loc.y, pre: attacks, unitId: u.id.id,
            unitTypeKey: lookupKey(GameInfo.Units, u.type, "UnitType"), from: { x: u.location.x, y: u.location.y },
            to: { x: loc.x, y: loc.y }, plotIndex: pi, ranged: ranged, attacksRemaining: attacks,
            strength: isInt(combat.getMeleeStrength) ? combat.getMeleeStrength : (typeof combat.getMeleeStrength === "function" ? combat.getMeleeStrength(false) : null),
            rangedStrength: isInt(combat.rangedStrength) ? combat.rangedStrength : null,
            damage: u.Health && isInt(u.Health.damage) ? u.Health.damage : null,
            maxDamage: u.Health && isInt(u.Health.maxDamage) ? u.Health.maxDamage : null,
            defender: defender, startsWar: startsWar,
            destructive: startsWar === true || undefined, requiresConfirmation: startsWar === true || undefined,
            terrainKey: lookupKey(GameInfo.Terrains, GameplayMap.getTerrainType(loc.x, loc.y), "TerrainType"),
            canStart: true });
          offered++;
        }
      }
    }
    // Founding a religion and adding its beliefs. The shipped belief picker sends FOUND_RELIGION with
    // the religion's hash and then ADD_BELIEF once per chosen belief; the notification blocks the turn
    // until the religion exists. A religion another civilization already holds is refused by the
    // engine's own check, so only the ones still open are offered.
    if (isInt(PlayerOperationTypes.FOUND_RELIGION) && player.Religion && GameInfo.Religions && typeof GameInfo.Religions[Symbol.iterator] === "function") {
      let held = null; try { held = player.Religion.getReligionType(); } catch (e) { held = null; }
      if (isInt(held) && held === -1) {
        for (const row of GameInfo.Religions) {
          if (!row || !isInt(row.$hash) || typeof row.ReligionType !== "string") continue;
          if (row.RequiresCustomName === true) continue;   // a custom religion needs a name typed in; the named ones are enough
          const check = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes.FOUND_RELIGION, { ReligionType: row.$hash }, false);
          if (!check || check.Success !== true) continue;
          offers.push({ kind: "FOUND_RELIGION", arg: row.$hash, pre: -1, typeKey: row.ReligionType,
            displayName: typeof row.Name === "string" ? compose(row.Name) : null, canStart: true });
        }
      }
    }
    if (isInt(PlayerOperationTypes.ADD_BELIEF) && player.Religion && GameInfo.Beliefs && typeof GameInfo.Beliefs[Symbol.iterator] === "function") {
      let heldBeliefs = null; try { const v = player.Religion.getBeliefs(); heldBeliefs = Array.isArray(v) ? v.length : null; } catch (e) { heldBeliefs = null; }
      let religion = null; try { religion = player.Religion.getReligionType(); } catch (e) { religion = null; }
      if (isInt(heldBeliefs) && isInt(religion) && religion !== -1) {
        for (const row of GameInfo.Beliefs) {
          if (!row || !isInt(row.$hash) || typeof row.BeliefType !== "string") continue;
          const check = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes.ADD_BELIEF, { BeliefType: row.$hash }, false);
          if (!check || check.Success !== true) continue;
          offers.push({ kind: "ADD_BELIEF", arg: row.$hash, pre: heldBeliefs, typeKey: row.BeliefType,
            beliefClass: typeof row.BeliefClassType === "string" ? row.BeliefClassType.replace("BELIEF_CLASS_", "") : null,
            displayName: typeof row.Name === "string" ? compose(row.Name) : null,
            description: typeof row.Description === "string" ? compose(row.Description) : null, canStart: true });
        }
      }
    }
    // ---- keep a town's current focus: clears the town-project blocker without changing anything,
    // which is what the shipped chooser does the moment it opens.
    if (typeof CityOperationTypes !== "undefined" && isInt(CityOperationTypes.CONSIDER_TOWN_PROJECT)) {
      let pendingFocus = false;
      try { for (const nid of Game.Notifications.getIdsForPlayer(BOUND_PLAYER_ID)) { const n = Game.Notifications.find(nid); if (n && Game.Notifications.getTypeName(n.Type) === "NOTIFICATION_CHOOSE_TOWN_PROJECT" && blocksNow(nid, n)) pendingFocus = true; } } catch (e) { pendingFocus = false; }
      if (pendingFocus) for (const c of player.Cities.getCities()) {
        if (!c || !c.id || !isInt(c.id.id) || c.id.owner !== BOUND_PLAYER_ID || c.isTown !== true) continue;
        offers.push({ kind: "CONSIDER_TOWN_PROJECT", arg: c.id.id, pre: 0, cityId: c.id.id, cityName: compose(c.name), canStart: true });
      }
    }
    // ---- a town back to growth (A13): the shipped focus list's "growth" entry is CHANGE_GROWTH_MODE
    // with Type EXPAND and no project, and it is the one way to leave a running project.
    if (typeof CityCommandTypes !== "undefined" && isInt(CityCommandTypes.CHANGE_GROWTH_MODE) && typeof GrowthTypes !== "undefined" && isInt(GrowthTypes.EXPAND) &&
        typeof ProjectTypes !== "undefined" && isInt(ProjectTypes.NO_PROJECT)) {
      for (const c of player.Cities.getCities()) {
        if (!c || !c.id || !isInt(c.id.id) || c.id.owner !== BOUND_PLAYER_ID || c.isTown !== true) continue;
        const cur = c.Growth && isInt(c.Growth.projectType) ? c.Growth.projectType : -1;
        if (cur === -1) continue;
        const growthArgs = { Type: GrowthTypes.EXPAND, ProjectType: ProjectTypes.NO_PROJECT, City: c.id.id };
        const check = Game.CityCommands.canStart(c.id, CityCommandTypes.CHANGE_GROWTH_MODE, growthArgs, false);
        if (!check || check.Success !== true) continue;
        offers.push({ kind: "TOWN_GROWTH_MODE", arg: c.id.id, pre: cur, cityId: c.id.id, cityName: compose(c.name), currentProject: cur,
          currentProjectKey: lookupKey(GameInfo.Projects, cur, "ProjectType"), canStart: true });
      }
    }
    // ---- production queue edits (A10): remove an item, or move one up or down. Every edit is the
    // same BUILD with an InsertMode, exactly as the shipped build-queue panel sends it.
    if (typeof CityOperationTypes !== "undefined" && isInt(CityOperationTypes.BUILD) && typeof CityOperationsParametersValues !== "undefined" &&
        isInt(CityOperationsParametersValues.RemoveAt) && isInt(CityOperationsParametersValues.Swap)) {
      for (const c of player.Cities.getCities()) {
        if (!c || !c.id || !isInt(c.id.id) || c.id.owner !== BOUND_PLAYER_ID || !c.BuildQueue) continue;
        let q = null; try { q = c.BuildQueue.getQueue(); } catch (e) { q = null; }
        if (!Array.isArray(q) || q.length < 1) continue;
        const keys = q.map((it) => it && isInt(it.type) ? (lookupKey(GameInfo.Constructibles, it.type, "ConstructibleType") || lookupKey(GameInfo.Units, it.type, "UnitType") || lookupKey(GameInfo.Projects, it.type, "ProjectType") || String(it.type)) : null);
        for (let i = 0; i < q.length && i < 8; i++) {
          const item = q[i]; if (!item || !isInt(item.type)) continue;
          const rem = Game.CityOperations.canStart(c.id, CityOperationTypes.BUILD, { InsertMode: CityOperationsParametersValues.RemoveAt, QueueLocation: i }, false);
          if (rem && rem.Success === true) offers.push({ kind: "QUEUE_REMOVE", arg: c.id.id, arg2: i, arg3: item.type, pre: q.length, cityId: c.id.id, cityName: compose(c.name), position: i, itemKey: keys[i], queue: keys, canStart: true });
          for (const [kind, to] of [["QUEUE_MOVE_UP", i - 1], ["QUEUE_MOVE_DOWN", i + 1]]) {
            if (to < 0 || to >= q.length) continue;
            const mv = Game.CityOperations.canStart(c.id, CityOperationTypes.BUILD, { InsertMode: CityOperationsParametersValues.Swap, QueueSourceLocation: i, QueueDestinationLocation: to }, false);
            if (mv && mv.Success === true) offers.push({ kind: kind, arg: c.id.id, arg2: i, arg3: item.type, pre: q.length, cityId: c.id.id, cityName: compose(c.name), position: i, toPosition: to, itemKey: keys[i], queue: keys, canStart: true });
          }
        }
      }
    }
    // ---- a just-captured settlement: keep, raze or liberate
    // The shipped capture chooser sends CityCommands.DESTROY with a Directive: 0 liberates to the
    // founder, 2 keeps, 3 razes. The city reports isJustConqueredFrom while the choice is pending and
    // isBeingRazed once razing was chosen; the notification blocks the turn until one is made.
    if (typeof CityCommandTypes !== "undefined" && isInt(CityCommandTypes.DESTROY)) {
      for (const c of player.Cities.getCities()) {
        if (!c || !c.id || !isInt(c.id.id) || c.id.owner !== BOUND_PLAYER_ID || !c.isJustConqueredFrom) continue;
        let wonders = null; try { const v = c.Constructibles && typeof c.Constructibles.getNumWonders === "function" ? c.Constructibles.getNumWonders() : null; wonders = isInt(v) ? v : null; } catch (e) { wonders = null; }
        for (const [kind, directive] of [["KEEP_CITY", 2], ["RAZE_CITY", 3], ["LIBERATE_CITY", 0]]) {
          const check = Game.CityCommands.canStart(c.id, CityCommandTypes.DESTROY, { Directive: directive }, false);
          if (!check || check.Success !== true) continue;
          offers.push({ kind: kind, arg: c.id.id, pre: 1, cityId: c.id.id, cityName: compose(c.name), population: isInt(c.population) ? c.population : null,
            wonders: wonders, isTown: c.isTown === true, destructive: kind !== "KEEP_CITY" || undefined, requiresConfirmation: kind !== "KEEP_CITY" || undefined, canStart: true });
        }
      }
    }
    // ---- a city-state bonus to choose
    if (isInt(PlayerOperationTypes.CHOOSE_CITY_STATE_BONUS) && typeof Game.CityStates !== "undefined" && GameInfo.CityStateBonuses && typeof GameInfo.CityStateBonuses[Symbol.iterator] === "function") {
      let pendingCs = null; try { pendingCs = Game.CityStates.getCityStateBonusToSelect(BOUND_PLAYER_ID); } catch (e) { pendingCs = null; }
      if (isInt(pendingCs) && pendingCs >= 0) {
        for (const row of GameInfo.CityStateBonuses) {
          if (!row || !isInt(row.$hash) || typeof row.CityStateBonusType !== "string") continue;
          let can = false; try { can = Game.CityStates.canHaveBonus(BOUND_PLAYER_ID, pendingCs, row.CityStateBonusType) === true; } catch (e) { can = false; }
          if (!can) continue;
          const check = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes.CHOOSE_CITY_STATE_BONUS, { OtherPlayer: pendingCs, CityStateBonusType: row.$hash }, false);
          if (!check || check.Success !== true) continue;
          offers.push({ kind: "CHOOSE_CITY_STATE_BONUS", arg: row.$hash, arg2: pendingCs, pre: pendingCs, typeKey: row.CityStateBonusType,
            displayName: typeof row.Name === "string" ? compose(row.Name) : null, description: typeof row.Description === "string" ? compose(row.Description) : null,
            cityStatePlayerId: pendingCs, canStart: true });
        }
      }
    }
    // ---- supporting one side of an ongoing diplomatic action with an influence token
    // The shipped details screen sends SUPPORT_DIPLOMATIC_ACTION with one global token; SubType true
    // backs the initiator, false the target. Opposing is supporting the other side; there is no
    // shipped operation to withdraw support. Only the seat's own events are read here.
    if (isInt(PlayerOperationTypes.SUPPORT_DIPLOMATIC_ACTION) && typeof DiplomacyTokenTypes !== "undefined" && isInt(DiplomacyTokenTypes.DIPLOMACY_TOKEN_GLOBAL) &&
        typeof Game.Diplomacy !== "undefined" && typeof Game.Diplomacy.getPlayerEvents === "function") {
      let influenceNow = null; try { const v = player.DiplomacyTreasury.diplomacyBalance; influenceNow = typeof v === "number" ? Math.floor(v) : null; } catch (e) { influenceNow = null; }
      let events = null; try { events = Game.Diplomacy.getPlayerEvents(BOUND_PLAYER_ID); } catch (e) { events = null; }
      if (isInt(influenceNow) && Array.isArray(events)) for (const ev of events) {
        if (!ev || !isInt(ev.uniqueID)) continue;
        for (const [side, label] of [[true, "initiator"], [false, "target"]]) {
          const supportArgs = { ID: ev.uniqueID, Type: DiplomacyTokenTypes.DIPLOMACY_TOKEN_GLOBAL, Amount: 1, SubType: side };
          const check = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes.SUPPORT_DIPLOMATIC_ACTION, supportArgs, false);
          if (!check || check.Success !== true) continue;
          let cost = null; try { const v = Game.Diplomacy.getInfluenceForNextSupport(ev.uniqueID, BOUND_PLAYER_ID, side); cost = typeof v === "number" ? Math.floor(v) : null; } catch (e) { cost = null; }
          offers.push({ kind: "SUPPORT_DIPLOMATIC_ACTION", arg: ev.uniqueID, arg2: side ? 1 : 0, pre: influenceNow, eventId: ev.uniqueID, side: label,
            typeKey: typeof ev.actionTypeName === "string" ? ev.actionTypeName : null, displayName: typeof ev.name === "string" ? compose(ev.name) : null,
            initiatorPlayerId: isInt(ev.initialPlayer) ? ev.initialPlayer : null, targetPlayerId: isInt(ev.targetPlayer) ? ev.targetPlayer : null,
            support: isInt(ev.support) ? ev.support : null, cost: cost, costYield: "influence", influenceBalance: influenceNow,
            affordable: isInt(cost) ? influenceNow >= cost : null, canStart: true });
        }
      }
    }
    // ---- acknowledging an advisor warning (it expires at end of turn on its own; acknowledging it
    // records the warning as seen and clears it now)
    if (isInt(PlayerOperationTypes.VIEWED_ADVISOR_WARNING)) {
      for (const nid of Game.Notifications.getIdsForPlayer(BOUND_PLAYER_ID)) {
        const n = Game.Notifications.find(nid);
        const name = n ? Game.Notifications.getTypeName(n.Type) : null;
        if (typeof name !== "string" || name.indexOf("NOTIFICATION_ADVISOR_WARNING") !== 0 || !nid || !isInt(nid.id) || !isInt(nid.type)) continue;
        const check = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes.VIEWED_ADVISOR_WARNING, { Target: nid }, false);
        if (!check || check.Success !== true) continue;
        offers.push({ kind: "VIEWED_ADVISOR_WARNING", arg: nid.id, arg2: nid.type, pre: 1, typeKey: name, notificationId: nid.id, canStart: true });
      }
    }
    // ---- taking a tradition or policy out of its slot (A11). The shipped policies screen sends
    // CHANGE_TRADITION with Action Deactivate; a swap is a deactivation followed by an activation.
    if (isInt(PlayerOperationTypes.CHANGE_TRADITION) && typeof PlayerOperationParameters !== "undefined" && isInt(PlayerOperationParameters.Deactivate) && typeof CultureSlotTypes !== "undefined") {
      for (const slotKey of ["TRADITION_CULTURE_SLOT", "POLICY_CULTURE_SLOT", "CRISIS_CULTURE_SLOT"]) {
        const slotType = CultureSlotTypes[slotKey]; if (!isInt(slotType)) continue;
        let active = null; try { active = player.Culture.getActiveTraditions(slotType); } catch (e) { active = null; }
        if (!Array.isArray(active)) continue;
        for (const th of active) {
          const row = GameInfo.Traditions.lookup(th); if (!row || !isInt(row.$hash)) continue;
          const check = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes.CHANGE_TRADITION, { TraditionType: row.$hash, Action: PlayerOperationParameters.Deactivate }, false);
          if (!check || check.Success !== true) continue;
          offers.push({ kind: "DEACTIVATE_TRADITION", arg: row.$hash, pre: active.length, typeKey: row.TraditionType, slot: slotKey, displayName: typeof row.Name === "string" ? compose(row.Name) : null,
            description: typeof row.Description === "string" ? compose(row.Description) : null, canStart: true });
        }
      }
    }
    // ---- resources out of a settlement, or two swapped (A12), as the commerce screen sends them
    if (isInt(PlayerOperationTypes.ASSIGN_RESOURCE) && typeof PlayerOperationParameters !== "undefined" && isInt(PlayerOperationParameters.Deactivate)) {
      const assigned = [];
      const resourceNames = {};
      try { for (const r of player.Resources.getResources()) { if (r && isInt(r.value) && r.uniqueResource && isInt(r.uniqueResource.resource)) resourceNames[r.value] = lookupKey(GameInfo.Resources, r.uniqueResource.resource, "ResourceType"); } } catch (e) { /* unnamed */ }
      for (const c of player.Cities.getCities()) { if (!c || !c.id || !c.Resources) continue; try { for (const ar of c.Resources.getAssignedResources()) { if (ar && isInt(ar.value)) assigned.push({ value: ar.value, cityId: c.id.id, cityName: compose(c.name), resourceKey: resourceNames[ar.value] || null }); } } catch (e) { /* none */ } }
      for (const a of assigned) {
        const loc = GameplayMap.getLocationFromIndex(a.value);
        const check = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes.ASSIGN_RESOURCE, { Location: loc, City: a.cityId, Action: PlayerOperationParameters.Deactivate }, false);
        if (!check || check.Success !== true) continue;
        offers.push({ kind: "UNASSIGN_RESOURCE", arg: a.value, arg2: a.cityId, pre: a.cityId, plotIndex: a.value, cityId: a.cityId, cityName: a.cityName, resourceKey: a.resourceKey, canStart: true });
      }
      if (isInt(PlayerOperationTypes.SWAP_RESOURCES)) {
        let pairs = 0;
        for (let i = 0; i < assigned.length && pairs < 12; i++) for (let j = i + 1; j < assigned.length && pairs < 12; j++) {
          if (assigned[i].cityId === assigned[j].cityId) continue;
          const l1 = GameplayMap.getLocationFromIndex(assigned[i].value), l2 = GameplayMap.getLocationFromIndex(assigned[j].value);
          const check = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes.SWAP_RESOURCES, { Location: l1, Location2: l2 }, false);
          if (!check || check.Success !== true) continue;
          offers.push({ kind: "SWAP_RESOURCES", arg: assigned[i].value, arg2: assigned[j].value, pre: assigned[i].cityId, resourceKey: assigned[i].resourceKey, cityName: assigned[i].cityName,
            otherResourceKey: assigned[j].resourceKey, otherCityName: assigned[j].cityName, otherCityId: assigned[j].cityId, canStart: true });
          pairs++;
        }
      }
    }
    // ---- diplomacy
    // A seat cannot choose whom to denounce or trade maps with without knowing who it has met, so
    // this is the one place the payload looks past the bound player. The scope is exactly the shipped
    // diplomacy ribbon's and no wider: players this seat has MET, and of each only the id, the
    // civilization's display name and whether it is a major power. No units, no cities, no yields, no
    // visibility, no map position. The policy test pins this block byte-for-byte.
    // BEGIN VETTED MET-PLAYER SCOPE
    const metPlayers = () => {
      const out = [];
      try {
        for (const other of Players.getEverAlive()) {
          if (!other || !isInt(other.id) || other.id === BOUND_PLAYER_ID) continue;
          if (player.Diplomacy.hasMet(other.id) !== true) continue;
          out.push({ id: other.id, name: compose(other.civilizationName), major: other.isMajor === true });
        }
      } catch (e) { return []; }
      return out;
    };
    // END VETTED MET-PLAYER SCOPE
    if (typeof Game.Diplomacy !== "undefined" && typeof Game.Diplomacy.getProjectDataForUI === "function" &&
        typeof DiplomacyProjectStatus !== "undefined" && typeof DiplomacyActionTargetTypes !== "undefined" && typeof DiplomacyActionGroups !== "undefined") {
      let influence = null;
      try { const v = player.DiplomacyTreasury.diplomacyBalance; influence = typeof v === "number" ? Math.floor(v) : null; } catch (e) { influence = null; }
      const groupName = (v) => { try { for (const k of Object.keys(DiplomacyActionGroups)) if (DiplomacyActionGroups[k] === v) return k.replace("DIPLOMACY_ACTION_GROUP_", ""); } catch (e) {} return null; };
      if (isInt(influence)) {
        for (const other of metPlayers()) {
          let data = null;
          try { data = Game.Diplomacy.getProjectDataForUI(BOUND_PLAYER_ID, other.id, DiplomacyActionTargetTypes.NO_DIPLOMACY_TARGET, DiplomacyActionGroups.NO_DIPLOMACY_ACTION_GROUP, -1, DiplomacyActionTargetTypes.NO_DIPLOMACY_TARGET); } catch (e) { data = null; }
          if (!Array.isArray(data)) continue;
          for (const d of data) {
            if (!d || !isInt(d.actionType) || d.projectStatus !== DiplomacyProjectStatus.PROJECT_AVAILABLE) continue;
            const t1 = Array.isArray(d.targetList1) ? d.targetList1.find((t) => t && t.targetID === other.id) : null;
            if (!t1 || typeof t1.costYieldD !== "number") continue;
            // What would prove this happened. Influence-priced actions are confirmed by the treasury
            // moving; the free ones are confirmed by the relationship itself changing. An action that
            // is free and changes no relationship has no signal at all, so it is withheld.
            const name = typeof d.actionTypeName === "string" ? d.actionTypeName : "";
            const expect = (name === "DIPLOMACY_ACTION_DECLARE_WAR" || name === "DIPLOMACY_ACTION_DECLARE_FORMAL_WAR") ? "war"
                         : (name === "DIPLOMACY_ACTION_FORM_ALLIANCE") ? "alliance"
                         : (t1.costYieldD > 0) ? "influence" : null;
            if (expect === null) continue;
            // The engine's own listing supplies the operation; the seat only ever names the pair.
            const diploArgs = { Amount: 1, Player1: BOUND_PLAYER_ID, Type: d.actionType };
            if (other.major) diploArgs.Player2 = other.id; else diploArgs.ID = other.id;
            const check = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, d.operationType, diploArgs, false);
            if (!check || check.Success !== true) continue;
            const cost = Math.floor(t1.costYieldD);
            // A project that names a second target (another player, a settlement, a unit type, an
            // amount or an independent) is offered once per target the engine accepts, exactly as
            // the shipped target-select screen builds it: the parameter name the engine attaches to
            // the entry decides which argument carries it.
            const seconds = Array.isArray(d.targetList2) ? d.targetList2 : [];
            if (seconds.length > 0) {
              let offeredSeconds = 0;
              for (const t2 of seconds) {
                if (!t2 || !isInt(t2.targetID) || typeof t2.parameterName !== "string" || offeredSeconds >= 8) continue;
                const argsWith = Object.assign({}, diploArgs);
                argsWith[["Player3", "Amount2", "Unit", "City"].indexOf(t2.parameterName) !== -1 ? t2.parameterName : "ID2"] = t2.targetID;
                const c2 = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, d.operationType, argsWith, false);
                if (!c2 || c2.Success !== true) continue;
                const cost2 = typeof t2.costYieldD === "number" ? Math.floor(t2.costYieldD) : cost;
                const plot = isInt(t2.targetPlot) && t2.targetPlot >= 0 ? GameplayMap.getLocationFromIndex(t2.targetPlot) : null;
                offers.push({ kind: "START_DIPLOMATIC_ACTION", arg: other.id, arg2: d.actionType, arg3: t2.targetID, pre: influence, expect: expect,
                  destructive: expect === "war" || undefined, requiresConfirmation: expect === "war" || undefined,
                  typeKey: typeof d.actionTypeName === "string" ? d.actionTypeName : null,
                  displayName: typeof d.actionDisplayName === "string" ? compose(d.actionDisplayName) : null,
                  targetPlayerId: other.id, targetName: other.name, targetIsMajor: other.major,
                  secondary: { parameter: t2.parameterName, id: t2.targetID, name: typeof t2.targetName === "string" ? compose(t2.targetName) : null,
                               at: plot && isInt(plot.x) && plot.x >= 0 ? { x: plot.x, y: plot.y } : null },
                  group: groupName(d.actionGroup), cost: cost2, costYield: "influence", influenceBalance: influence,
                  affordable: influence >= cost2, canStart: true });
                offeredSeconds++;
              }
              continue;
            }
            offers.push({ kind: "START_DIPLOMATIC_ACTION", arg: other.id, arg2: d.actionType, pre: influence, expect: expect,
              // War is not undone. The shipped map puts a confirmation in front of it too.
              destructive: expect === "war" || undefined, requiresConfirmation: expect === "war" || undefined,
              typeKey: typeof d.actionTypeName === "string" ? d.actionTypeName : null,
              displayName: typeof d.actionDisplayName === "string" ? compose(d.actionDisplayName) : null,
              targetPlayerId: other.id, targetName: other.name, targetIsMajor: other.major,
              group: groupName(d.actionGroup), cost: cost, costYield: "influence", influenceBalance: influence,
              affordable: influence >= cost, canStart: true });
          }
        }
      }
    }
    // Answering another civilization's proposal. The pending ones are this seat's own diplomatic
    // events where it is the target; the shipped reaction panel sends RESPOND_DIPLOMATIC_ACTION with
    // the event's id and an accept or reject response type. The game will not end the turn until each
    // is answered, so both answers are always offered when the engine allows them.
    if (isInt(PlayerOperationTypes.RESPOND_DIPLOMATIC_ACTION) && typeof DiplomaticResponseTypes !== "undefined" &&
        typeof Game.Diplomacy !== "undefined" && typeof Game.Diplomacy.getPlayerEvents === "function") {
      let events = null; try { events = Game.Diplomacy.getPlayerEvents(BOUND_PLAYER_ID); } catch (e) { events = null; }
      const names = {}; for (const other of metPlayers()) names[other.id] = other.name;
      if (Array.isArray(events)) for (const ev of events) {
        if (!ev || !isInt(ev.uniqueID) || ev.targetPlayer !== BOUND_PLAYER_ID) continue;
        // An answered event stays in the list and the engine's check keeps accepting a second answer
        // (live: it did, and the confirm built on it read as unknown); the event's own responseType
        // is what says whether it has been answered.
        if (ev.responseType !== DiplomaticResponseTypes.INVALID_RESPONSE) continue;
        for (const [answer, key] of [["accept", "DIPLOMACY_RESPONSE_ACCEPT"], ["reject", "DIPLOMACY_RESPONSE_REJECT"]]) {
          const responseType = DiplomaticResponseTypes[key];
          if (!isInt(responseType)) continue;
          const check = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes.RESPOND_DIPLOMATIC_ACTION, { ID: ev.uniqueID, Type: responseType }, false);
          if (!check || check.Success !== true) continue;
          offers.push({ kind: "RESPOND_DIPLOMATIC_ACTION", arg: ev.uniqueID, arg2: responseType, pre: 1, eventId: ev.uniqueID,
            answer: answer, typeKey: typeof ev.actionTypeName === "string" ? ev.actionTypeName : null,
            displayName: typeof ev.name === "string" ? compose(ev.name) : null,
            description: typeof ev.description === "string" ? compose(ev.description) : null,
            proposerPlayerId: isInt(ev.initialPlayer) ? ev.initialPlayer : null,
            proposerName: isInt(ev.initialPlayer) ? (names[ev.initialPlayer] || null) : null, canStart: true });
        }
      }
    }
    // A call to arms: an ally at war asks this seat to join. The shipped screen answers "join" by
    // declaring war on the ally's enemy and "stay out" by ending the alliance; both operations already
    // exist here, so the offer names the enemy and the ally and the seat picks either.
    if (isInt(PlayerOperationTypes.DECLARE_WAR) && typeof DiplomacyActionTypes !== "undefined" && isInt(DiplomacyActionTypes.DIPLOMACY_ACTION_DECLARE_WAR) &&
        typeof Game.Diplomacy !== "undefined" && typeof Game.Diplomacy.getNextCallToArms === "function") {
      let callId = -1; try { callId = Game.Diplomacy.getNextCallToArms(BOUND_PLAYER_ID); } catch (e) { callId = -1; }
      if (isInt(callId) && callId !== -1) {
        let war = null; try { war = Game.Diplomacy.getDiplomaticEventData(callId); } catch (e) { war = null; }
        if (war && isInt(war.initialPlayer) && isInt(war.targetPlayer)) {
          const names = {}; for (const other of metPlayers()) names[other.id] = other.name;
          for (const [ally, enemy] of [[war.initialPlayer, war.targetPlayer], [war.targetPlayer, war.initialPlayer]]) {
            let allied = null; try { allied = player.Diplomacy.hasAllied(ally); } catch (e) { allied = null; }
            if (allied !== true) continue;
            const warArgs = { Player1: BOUND_PLAYER_ID, Player2: enemy, Type: DiplomacyActionTypes.DIPLOMACY_ACTION_DECLARE_WAR };
            const check = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes.DECLARE_WAR, warArgs, false);
            if (!check || check.Success !== true) continue;
            offers.push({ kind: "DECLARE_WAR", arg: enemy, arg2: callId, pre: callId, callToArms: callId, allyPlayerId: ally, allyName: names[ally] || null,
              targetPlayerId: enemy, targetName: names[enemy] || null, destructive: true, requiresConfirmation: true, canStart: true });
          }
        }
      }
    }
    // Peace. The shipped peace screen builds a working deal, {direction, player1, player2}, clears it,
    // adds the MAKE_PEACE agreement and sends it PROPOSED; the other side answers ACCEPTED or REJECTED
    // on the incoming deal. Offered here in its bounded form: a plain peace with no further terms.
    if (typeof Game.DiplomacyDeals !== "undefined" && typeof DiplomacyDealDirection !== "undefined" && typeof DiplomacyDealProposalActions !== "undefined") {
      for (const other of metPlayers()) {
        let atWar = null; try { atWar = player.Diplomacy.isAtWarWith(other.id) === true; } catch (e) { atWar = null; }
        if (atWar !== true) continue;
        let pending = null; try { pending = Game.DiplomacyDeals.hasPendingDeal(BOUND_PLAYER_ID, other.id) === true; } catch (e) { pending = null; }
        if (pending === true) {
          // Something is on the table already: the incoming deal can be answered.
          const incoming = { direction: DiplomacyDealDirection.INCOMING, player1: other.id, player2: BOUND_PLAYER_ID };
          let items = null; try { const d = Game.DiplomacyDeals.getWorkingDeal(incoming); items = d && Array.isArray(d.itemIds) ? d.itemIds.length : null; } catch (e) { items = null; }
          if (isInt(items) && items > 0) {
            for (const kind of ["ACCEPT_PEACE", "REJECT_PEACE"]) {
              offers.push({ kind: kind, arg: other.id, pre: 1, targetPlayerId: other.id, targetName: other.name, targetIsMajor: other.major, dealItems: items, canStart: true });
            }
          }
          continue;
        }
        let can = null; try { const r = player.Diplomacy.canMakePeaceWith(other.id); can = r && typeof r === "object" ? r.Success === true : r === true; } catch (e) { can = null; }
        if (can !== true) continue;
        offers.push({ kind: "PROPOSE_PEACE", arg: other.id, pre: 0, targetPlayerId: other.id, targetName: other.name, targetIsMajor: other.major, canStart: true });
      }
    }
    // Ending an alliance has no project row of its own: the shipped diplomacy panel sends the cancel
    // operation carrying the alliance action type, once the seat is already allied.
    if (isInt(PlayerOperationTypes.CANCEL_ALLIANCE) && typeof DiplomacyActionTypes !== "undefined" && isInt(DiplomacyActionTypes.DIPLOMACY_ACTION_FORM_ALLIANCE)) {
      for (const other of metPlayers()) {
        let allied = null; try { allied = player.Diplomacy.hasAllied(other.id); } catch (e) { allied = null; }
        if (allied !== true) continue;
        const cancelArgs = { Player1: BOUND_PLAYER_ID, Player2: other.id, Type: DiplomacyActionTypes.DIPLOMACY_ACTION_FORM_ALLIANCE };
        const check = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes.CANCEL_ALLIANCE, cancelArgs, false);
        if (!check || check.Success !== true) continue;
        offers.push({ kind: "CANCEL_ALLIANCE", arg: other.id, pre: 1, targetPlayerId: other.id, targetName: other.name,
          targetIsMajor: other.major, displayName: "End alliance", canStart: true });
      }
    }
    if (typeof CityOperationTypes !== "undefined" && isInt(CityOperationTypes.BUILD)) {
      const cities = player.Cities.getCities();
      if (!Array.isArray(cities)) throw new Error("getCities() is not an array");
      const unitCount = player.Units.getUnits().length;
      let goldBalance = null; try { const g = player.Treasury.goldBalance; goldBalance = typeof g === "number" ? Math.floor(g) : null; } catch (e) { goldBalance = null; }
      for (const c of cities) {
        if (!c || !c.id || !isInt(c.id.id) || c.id.owner !== BOUND_PLAYER_ID) continue;
        const cityId = c.id;
        // BUILD appends to the city's queue (live: three Warriors stacked up before this was
        // understood), so the offer is an enqueue: precondition = queue length, and the queue is shown.
        const queueItems = c.BuildQueue && typeof c.BuildQueue.getQueue === "function" ? c.BuildQueue.getQueue() : null;
        if (!Array.isArray(queueItems)) throw new Error("BuildQueue.getQueue() is not an array");
        const ppre = queueItems.length;
        const typeKeyOf = (h) => lookupKey(GameInfo.Units, h, "UnitType") || lookupKey(GameInfo.Constructibles, h, "ConstructibleType") || (GameInfo.Projects ? lookupKey(GameInfo.Projects, h, "ProjectType") : null) || (isInt(h) ? String(h) : null);
        const queueKeys = queueItems.map((it) => (it && isInt(it.type) ? typeKeyOf(it.type) : null));
        const cost = (fn, hash) => { try { const v = c.Production && typeof c.Production[fn] === "function" ? c.Production[fn](hash) : null; return isInt(v) ? v : null; } catch (e) { return null; } };
        const turnsFor = (hash) => { try { const v = c.BuildQueue && typeof c.BuildQueue.getTurnsLeft === "function" ? c.BuildQueue.getTurnsLeft(hash) : null; return isInt(v) ? v : null; } catch (e) { return null; } };
        for (const row of GameInfo.Units) {
          if (!row || !isInt(row.$hash) || typeof row.UnitType !== "string") continue;
          const buildArgs = { UnitType: row.$hash };
          const check = Game.CityOperations.canStart(cityId, CityOperationTypes.BUILD, buildArgs, false);
          if (!check || check.Success !== true) continue;   // only buildable units are offered
          offers.push({ kind: "PRODUCE_UNIT", arg: c.id.id, arg2: row.$hash, pre: ppre, cityId: c.id.id, cityName: compose(c.name), queue: queueKeys, queueLength: ppre,
            unitTypeKey: row.UnitType, displayName: typeof row.Name === "string" ? compose(row.Name) : null,
            cost: cost("getUnitProductionCost", row.$hash), turns: turnsFor(row.$hash), canStart: true });
        }
        // Purchasing spends the treasury instead of production and delivers the unit at once. The
        // native check returns the gold cost in its own result, which is what the shipped chooser shows.
        if (typeof CityCommandTypes !== "undefined" && isInt(CityCommandTypes.PURCHASE)) {
          for (const row of GameInfo.Units) {
            if (!row || !isInt(row.$hash) || typeof row.UnitType !== "string") continue;
            const buyArgs = { UnitType: row.$hash };
            const check = Game.CityCommands.canStart(cityId, CityCommandTypes.PURCHASE, buyArgs, false);
            if (!check || check.Success !== true) continue;
            offers.push({ kind: "PURCHASE_UNIT", arg: c.id.id, arg2: row.$hash, pre: unitCount, cityId: c.id.id, cityName: compose(c.name),
              unitTypeKey: row.UnitType, displayName: typeof row.Name === "string" ? compose(row.Name) : null,
              cost: isInt(check.Cost) ? check.Cost : null, goldBalance: goldBalance, canStart: true });
          }
        }
        // A town becomes a city for gold. The shipped production chooser gates the button on
        // canStart(PURCHASE, {Directive: OrderTypes.ORDER_TOWN_UPGRADE}) and reads the price from the
        // settlement's own Gold component; the native check reports no Cost of its own.
        if (c.isTown === true && typeof OrderTypes !== "undefined" && isInt(OrderTypes.ORDER_TOWN_UPGRADE) &&
            typeof CityCommandTypes !== "undefined" && isInt(CityCommandTypes.PURCHASE)) {
          const upArgs = { Directive: OrderTypes.ORDER_TOWN_UPGRADE };
          const upCheck = Game.CityCommands.canStart(cityId, CityCommandTypes.PURCHASE, upArgs, false);
          if (upCheck && upCheck.Success === true && isInt(goldBalance)) {
            let upCost = null;
            try { const v = c.Gold && typeof c.Gold.getTownUpgradeCost === "function" ? c.Gold.getTownUpgradeCost() : null; upCost = typeof v === "number" && v >= 0 ? Math.floor(v) : null; } catch (e) { upCost = null; }
            offers.push({ kind: "UPGRADE_TOWN", arg: c.id.id, pre: goldBalance, cityId: c.id.id, cityName: compose(c.name),
              cost: upCost, goldBalance: goldBalance, affordable: isInt(upCost) ? goldBalance >= upCost : null, canStart: true });
          }
        }
        // City projects are the third thing a queue can hold. They take no plot and no gold, so the
        // offer is the plain enqueue: precondition = queue length, confirmed by the item landing there.
        if (GameInfo.Projects && typeof GameInfo.Projects[Symbol.iterator] === "function") {
          for (const row of GameInfo.Projects) {
            if (!row || !isInt(row.$hash) || typeof row.ProjectType !== "string") continue;
            const projArgs = { ProjectType: row.$hash };
            const check = Game.CityOperations.canStart(cityId, CityOperationTypes.BUILD, projArgs, false);
            if (!check || check.Success !== true) continue;
            offers.push({ kind: "PRODUCE_PROJECT", arg: c.id.id, arg2: row.$hash, pre: ppre, cityId: c.id.id, cityName: compose(c.name),
              queue: queueKeys, queueLength: ppre, typeKey: row.ProjectType,
              displayName: typeof row.Name === "string" ? compose(row.Name) : null,
              description: typeof row.Description === "string" ? compose(row.Description) : null,
              turns: turnsFor(row.$hash), canStart: true });
          }
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
            const buyCheck = (typeof CityCommandTypes !== "undefined" && isInt(CityCommandTypes.PURCHASE))
              ? Game.CityCommands.canStart(cityId, CityCommandTypes.PURCHASE, { ConstructibleType: row.$hash }, false) : null;
            for (const [placement, plots] of groups) {
              for (const pi of plots) {
                if (!isInt(pi)) continue;
                const loc = GameplayMap.getLocationFromIndex(pi);
                if (!loc || !isInt(loc.x) || !isInt(loc.y) || loc.x < 0) continue;
                const buildArgs = { ConstructibleType: row.$hash, X: loc.x, Y: loc.y };
                const check = Game.CityOperations.canStart(cityId, CityOperationTypes.BUILD, buildArgs, false);
                if (!check || check.Success !== true) continue;
                offers.push({ kind: "PRODUCE_CONSTRUCTIBLE", arg: c.id.id, arg2: row.$hash, arg3: pi, pre: ppre, cityId: c.id.id, cityName: compose(c.name), queue: queueKeys, queueLength: ppre,
                  constructibleKey: row.ConstructibleType, constructibleClass: typeof row.ConstructibleClass === "string" ? row.ConstructibleClass : null,
                  displayName: typeof row.Name === "string" ? compose(row.Name) : null, cost: cost("getConstructibleProductionCost", row.$hash), turns: turnsFor(row.$hash),
                  x: loc.x, y: loc.y, plotIndex: pi, placement: placement, terrainKey: lookupKey(GameInfo.Terrains, GameplayMap.getTerrainType(loc.x, loc.y), "TerrainType"),
                  featureKey: lookupKey(GameInfo.Features, GameplayMap.getFeatureType(loc.x, loc.y), "FeatureType"), river: GameplayMap.isRiver(loc.x, loc.y) === true, yields: plotYields(loc.x, loc.y), canStart: true });
                // Gold builds the same constructible at once instead of queueing it. The native
                // purchase check carries its own Cost, which is the price the shipped chooser shows.
                if (buyCheck && buyCheck.Success === true && isInt(goldBalance)) {
                  const buyPlotArgs = { ConstructibleType: row.$hash, X: loc.x, Y: loc.y };
                  const pchk = Game.CityCommands.canStart(cityId, CityCommandTypes.PURCHASE, buyPlotArgs, false);
                  if (pchk && pchk.Success === true) {
                    const bcost = isInt(pchk.Cost) ? pchk.Cost : (isInt(buyCheck.Cost) ? buyCheck.Cost : null);
                    offers.push({ kind: "PURCHASE_CONSTRUCTIBLE", arg: c.id.id, arg2: row.$hash, arg3: pi, pre: goldBalance, cityId: c.id.id, cityName: compose(c.name),
                      constructibleKey: row.ConstructibleType, constructibleClass: typeof row.ConstructibleClass === "string" ? row.ConstructibleClass : null,
                      displayName: typeof row.Name === "string" ? compose(row.Name) : null, cost: bcost, goldBalance: goldBalance,
                      affordable: isInt(bcost) ? goldBalance >= bcost : null,
                      x: loc.x, y: loc.y, plotIndex: pi, placement: placement, terrainKey: lookupKey(GameInfo.Terrains, GameplayMap.getTerrainType(loc.x, loc.y), "TerrainType"),
                      featureKey: lookupKey(GameInfo.Features, GameplayMap.getFeatureType(loc.x, loc.y), "FeatureType"), river: GameplayMap.isRiver(loc.x, loc.y) === true, yields: plotYields(loc.x, loc.y), canStart: true });
                  }
                }
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
      // Live: a card typed POLICY_CULTURE_SLOT was activatable (canStart true) with zero policy slots
      // and one tradition slot, so slot types are not the whole story; the overall free count is given too.
      let allSlots = null, allActive = 0; try { allSlots = cu.getNumAllCultureSlots(); for (const k of ["TRADITION_CULTURE_SLOT", "POLICY_CULTURE_SLOT", "CRISIS_CULTURE_SLOT"]) { const st0 = CultureSlotTypes[k]; if (isInt(st0)) allActive += cu.getActiveTraditions(st0).length; } } catch (e) { allSlots = null; }
      const slotsFreeAny = isInt(allSlots) ? allSlots - allActive : null;
      let activatable = 0;
      // Per slot type: a free crisis slot with an activatable crisis card is what keeps the crisis
      // notification up, and the same for ordinary policies. A global count would gate the confirm
      // forever once any slot anywhere is free (live: 14 free slots with only crisis cards pending).
      const pending = {};
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
          if (check && check.Success === true) { activatable += 1; pending[slotName] = (pending[slotName] || 0) + 1; }
          offers.push({ kind: "CHANGE_TRADITION", arg: row.$index, arg2: hash, pre: active.length, slot: slotName, slotsTotal: total, slotsFree: total - active.length, slotsFreeAny: slotsFreeAny,
            typeKey: typeof row.TraditionType === "string" ? row.TraditionType : null, displayName: compose(row.Name), description: compose(row.Description),
            isCrisis: row.IsCrisis === true, canStart: !!(check && check.Success === true) });
        }
      }
      const traditionsBlocking = blocked && (blockerName(blockingType) === "TRADITIONS" || blockingNotifications.indexOf("NOTIFICATION_TRADITIONS_AVAILABLE") !== -1 || blockingNotifications.indexOf("NOTIFICATION_CRISIS") !== -1);
      if (traditionsBlocking && isInt(PlayerOperationTypes.CONSIDER_ASSIGN_TRADITIONS)) {
        const check = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes.CONSIDER_ASSIGN_TRADITIONS, {}, false);
        // live (twice): confirming with a free slot and an activatable card leaves the notification in place,
        // so the confirm is only startable once no card can be slotted
        let slotToFill = false;
        for (const slotName of Object.keys(pending)) {
          const st1 = CultureSlotTypes[slotName];
          if (!isInt(st1)) continue;
          const free = cu.getNumCultureSlots(st1) - cu.getActiveTraditions(st1).length;
          if (free > 0 && pending[slotName] > 0) { slotToFill = true; break; }
        }
        offers.push({ kind: "CONSIDER_ASSIGN_TRADITIONS", arg: 0, pre: 0, canStart: !!(check && check.Success === true) && !slotToFill, slotsFreeAny: slotsFreeAny, activatable: activatable, pendingBySlot: pending });
      }
    }
    if (isInt(PlayerOperationTypes.BUY_ATTRIBUTE_TREE_NODE) && player.Identity && typeof player.Identity.getAvailableAttributePoints === "function" && GameInfo.Attributes && typeof GameInfo.Attributes[Symbol.iterator] === "function") {
      // Attribute points: the shipped attribute-tree screen buys nodes with BUY_ATTRIBUTE_TREE_NODE
      // {ProgressionTreeNodeType} after canStart and sends CONSIDER_ASSIGN_ATTRIBUTE {} on close.
      const attrByTree = {}; let wildcard = null;
      try { wildcard = player.Identity.getWildcardPoints(); } catch (e) { wildcard = null; }
      for (const a of GameInfo.Attributes) { if (a && typeof a.AttributeType === "string" && typeof a.ProgressionTreeType === "string") attrByTree[a.ProgressionTreeType] = a; }
      for (const nd of GameInfo.ProgressionTreeNodes) {
        if (!nd || !isInt(nd.$hash) || typeof nd.ProgressionTree !== "string" || !attrByTree[nd.ProgressionTree]) continue;
        const check = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes.BUY_ATTRIBUTE_TREE_NODE, { ProgressionTreeNodeType: nd.$hash }, false);
        if (!check || check.Success !== true) continue;
        const attr = attrByTree[nd.ProgressionTree];
        let state = null; try { const ns = Game.ProgressionTrees.getNode(BOUND_PLAYER_ID, nd.$hash); state = ns && isInt(ns.state) ? ns.state : null; } catch (e) { state = null; }
        let points = null; try { points = player.Identity.getAvailableAttributePoints(attr.AttributeType); } catch (e) { points = null; }
        offers.push({ kind: "BUY_ATTRIBUTE_TREE_NODE", arg: nd.$hash, pre: isInt(state) ? state : -1, typeKey: typeof nd.ProgressionTreeNodeType === "string" ? nd.ProgressionTreeNodeType : null, tree: nd.ProgressionTree,
          attribute: attr.AttributeType, attributeName: compose(attr.Name), displayName: compose(nd.Name) || compose(attr.Name), description: compose(nd.Description), cost: isInt(nd.Cost) ? nd.Cost : null,
          availablePoints: isInt(points) ? points : null, wildcardPoints: isInt(wildcard) ? wildcard : null, canStart: true });
      }
      if (blocked && blockingNotifications.indexOf("NOTIFICATION_CAN_BUY_ATTRIBUTE_SKILL") !== -1 && isInt(PlayerOperationTypes.CONSIDER_ASSIGN_ATTRIBUTE)) {
        const check = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes.CONSIDER_ASSIGN_ATTRIBUTE, {}, false);
        offers.push({ kind: "CONSIDER_ASSIGN_ATTRIBUTE", arg: 0, pre: 0, canStart: !!(check && check.Success === true) });
      }
    }
    if (isInt(PlayerOperationTypes.ASSIGN_RESOURCE) && player.Resources && typeof player.Resources.getResources === "function") {
      // Resources: the shipped allocation screen sends ASSIGN_RESOURCE {Location: {x, y}, City: cityId}
      // per drop after canStart, and CONSIDER_ASSIGN_RESOURCE {} on close.
      const R = player.Resources;
      let toAssign = null; try { toAssign = R.getCountResourcesToAssign(); } catch (e) { toAssign = null; }
      const rpre = isInt(toAssign) ? toAssign : 0;
      const cities = player.Cities.getCities();
      const cityInfo = cities.filter((c) => c && c.id && isInt(c.id.id) && c.id.owner === BOUND_PLAYER_ID).map((c) => { let cap = null, cnt = null; try { cap = c.Resources.getAssignedResourcesCap(); cnt = c.Resources.getTotalCountAssignedResources(); } catch (e) { /* unknown */ } return { c: c, cap: isInt(cap) ? cap : null, cnt: isInt(cnt) ? cnt : null }; });
      const cityName = (cid) => { for (const ci of cityInfo) if (ci.c.id.id === cid) return compose(ci.c.name); return null; };
      // live: Resources.getCityIDAssigned returns nothing usable; each city's own assigned list is the truth
      const assignedMap = {}; for (const ci of cityInfo) { try { for (const ar of ci.c.Resources.getAssignedResources()) { if (ar && isInt(ar.value)) assignedMap[ar.value] = ci.c.id.id; } } catch (e) { /* none */ } }
      let assignable = 0;
      const all = R.getResources();
      if (Array.isArray(all)) for (const r of all) {
        if (!r || !isInt(r.value) || !r.uniqueResource || !isInt(r.uniqueResource.resource)) continue;
        const def = GameInfo.Resources.lookup(r.uniqueResource.resource);
        const loc = GameplayMap.getLocationFromIndex(r.value);
        if (!loc || !isInt(loc.x) || !isInt(loc.y) || loc.x < 0) continue;
        const assignedTo = isInt(assignedMap[r.value]) ? assignedMap[r.value] : -1;
        let originName = null; try { const o = Game.Resources.getOriginCity(r.value); originName = o && isInt(o.id) ? cityName(o.id) : null; } catch (e) { originName = null; }
        for (const ci of cityInfo) {
          if (assignedTo === ci.c.id.id) continue;
          const rargs = { Location: { x: loc.x, y: loc.y }, City: ci.c.id.id };
          const check = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes.ASSIGN_RESOURCE, rargs, false);
          if (!check || check.Success !== true) continue;
          assignable += 1;
          offers.push({ kind: "ASSIGN_RESOURCE", arg: r.value, arg2: ci.c.id.id, pre: rpre, plotIndex: r.value, from: { x: loc.x, y: loc.y }, resourceKey: def && typeof def.ResourceType === "string" ? def.ResourceType : null,
            displayName: def ? compose(def.Name) : null, resourceClass: def && typeof def.ResourceClassType === "string" ? def.ResourceClassType : null, description: def ? compose(def.Tooltip) : null,
            assignedCityId: assignedTo === -1 ? null : assignedTo, originCityName: originName, cityId: ci.c.id.id, cityName: compose(ci.c.name), cityIsTown: ci.c.isTown === true, cityCap: ci.cap, cityAssigned: ci.cnt, toAssign: rpre, canStart: true });
        }
      }
      if (blocked && blockingNotifications.indexOf("NOTIFICATION_ASSIGN_NEW_RESOURCES") !== -1 && isInt(PlayerOperationTypes.CONSIDER_ASSIGN_RESOURCE)) {
        const check = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes.CONSIDER_ASSIGN_RESOURCE, {}, false);
        offers.push({ kind: "CONSIDER_ASSIGN_RESOURCE", arg: 0, pre: 0, canStart: !!(check && check.Success === true) && !(rpre > 0 && assignable > 0), toAssign: rpre, assignable: assignable });
      }
    }
    if (isInt(PlayerOperationTypes.ADVANCED_START_MODIFY_DECK) && isInt(PlayerOperationTypes.ADVANCED_START_USE_EFFECT) && isInt(PlayerOperationTypes.ADVANCED_START_MARK_COMPLETED) && player.AdvancedStart && blocked && blockingNotifications.indexOf("NOTIFICATION_AGE_TRANSITION") !== -1) {
      // New age: the shipped legacies screen adds cards to the deck (ADVANCED_START_MODIFY_DECK ADD), then on
      // confirm uses every selected card's effects (ADVANCED_START_USE_EFFECT per effect) and marks the deck
      // completed. Card and effect ids are strings; their Database.makeHash is the integer handle here.
      // A deck entry wraps the card: {id: <instance>, info: {<the card>}}, while an available card is the
      // card itself (live: the pick registered but read back as missing because the instance id was compared).
      const cardOf = (c) => (c && c.info ? c.info : c);
      const A = player.AdvancedStart;
      const available = A.getAvailableCards(); const deck = A.getCards();
      if (!Array.isArray(available) || !Array.isArray(deck)) throw new Error("advanced start card contract unavailable");
      const deckIds = deck.map((c) => cardOf(c) && cardOf(c).id).filter((x) => typeof x === "string");
      let points = null; try { const lp = A.getLegacyPoints(); points = Array.isArray(lp) ? lp.reduce((s, x) => s + (x && isInt(x.value) ? x.value : 0), 0) : null; } catch (e) { points = null; }
      const costOf = (c) => Array.isArray(c.cost) ? c.cost.reduce((s, x) => s + (x && isInt(x.value) ? x.value : 0), 0) : null;
      for (const c of available) {
        if (!c || typeof c.id !== "string" || deckIds.indexOf(c.id) !== -1) continue;
        const placement = Array.isArray(c.effects) && c.effects.some((e) => e && e.isPlacementEffect === true);
        const check = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes.ADVANCED_START_MODIFY_DECK, { Type: "ADD", ID: c.id }, false);
        offers.push({ kind: "ADVANCED_START_MODIFY_DECK", arg: Database.makeHash(c.id), pre: deckIds.length, cardId: c.id, displayName: compose(c.name), description: compose(c.description),
          cost: costOf(c), pointsAvailable: points, needsPlacement: placement, effectCount: Array.isArray(c.effects) ? c.effects.length : 0,
          canStart: !!(check && check.Success === true) });
      }
      // A picked card can be put back (Type REMOVE) and its points return; rewards are only applied when
      // the deck is finished, as the shipped screen does, so putting a card back costs nothing.
      for (const d of deck) {
        const c = cardOf(d);
        if (!c || typeof c.id !== "string") continue;
        const rcheck = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes.ADVANCED_START_MODIFY_DECK, { Type: "REMOVE", ID: c.id }, false);
        offers.push({ kind: "ADVANCED_START_REMOVE_CARD", arg: Database.makeHash(c.id), pre: deckIds.length, cardId: c.id, displayName: compose(c.name), cost: costOf(c), deck: deckIds, canStart: !!(rcheck && rcheck.Success === true) });
      }
      // A placement effect (a free city or town) takes a plot: ADVANCED_START_PLACE_SETTLEMENT {ID, X, Y}.
      // The shipped screen validates only at the click and keeps no plot list, so candidates are probed
      // within six plots of the seat's own settlements unless the engine hands back a Plots list.
      let pendingPlacements = 0;
      if (isInt(PlayerOperationTypes.ADVANCED_START_PLACE_SETTLEMENT)) {
        for (const d of deck) {
          const c = cardOf(d);
          if (!c || typeof c.id !== "string" || !Array.isArray(c.effects)) continue;
          for (const e of c.effects) {
            if (!e || typeof e.id !== "string" || e.isPlacementEffect !== true || !isInt(e.amount) || e.amount <= 0) continue;
            pendingPlacements += e.amount;
            const listing = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes.ADVANCED_START_PLACE_SETTLEMENT, { ID: e.id }, false);
            const candidates = [];
            if (listing && Array.isArray(listing.Plots) && listing.Plots.length > 0) {
              for (const pi of listing.Plots) { if (!isInt(pi)) continue; const loc = GameplayMap.getLocationFromIndex(pi); if (loc && isInt(loc.x) && loc.x >= 0) candidates.push({ x: loc.x, y: loc.y }); }
            } else {
              const w = GameplayMap.getGridWidth(), h = GameplayMap.getGridHeight();
              const mark = {};
              for (const city of player.Cities.getCities()) {
                if (!city || !city.location || !isInt(city.location.x)) continue;
                for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) {
                  const x = city.location.x + dx, y = city.location.y + dy;
                  if (x < 0 || y < 0 || x >= w || y >= h || mark[x + "," + y]) continue;
                  mark[x + "," + y] = true; candidates.push({ x: x, y: y });
                }
              }
            }
            let offeredHere = 0;
            for (const p of candidates) {
              if (offeredHere >= 24) break;
              const pc = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes.ADVANCED_START_PLACE_SETTLEMENT, { ID: e.id, X: p.x, Y: p.y }, false);
              if (!pc || pc.Success !== true) continue;
              offers.push({ kind: "ADVANCED_START_PLACE_SETTLEMENT", arg: Database.makeHash(e.id), arg2: p.x, arg3: p.y, pre: e.amount, effectId: e.id, cardId: c.id,
                displayName: compose(e.name), description: compose(e.description), to: { x: p.x, y: p.y }, plotIndex: GameplayMap.getIndexFromXY(p.x, p.y),
                terrainKey: lookupKey(GameInfo.Terrains, GameplayMap.getTerrainType(p.x, p.y), "TerrainType"), remaining: e.amount, canStart: true });
              offeredHere++;
            }
          }
        }
      }
      const mcheck = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes.ADVANCED_START_MARK_COMPLETED, {}, false);
      offers.push({ kind: "ADVANCED_START_MARK_COMPLETED", arg: 0, pre: deckIds.length, deck: deckIds, pointsAvailable: points, pendingPlacements: pendingPlacements, canStart: !!(mcheck && mcheck.Success === true) });
      // The same screen lets the capital move to another settlement (SELECT_CAPITAL {Player1, City, Swap});
      // the legal set is the engine's, the current capital stays unless a choice is sent, and Swap (rename
      // the capital) is true only when the civilization changed with the age, as the shipped confirm sends it.
      if (isInt(PlayerOperationTypes.SELECT_CAPITAL) && typeof player.Cities.getPotentialSwitchCapitalCityIds === "function") {
        const capital = player.Cities.getCapital();
        const capId = capital && capital.id && isInt(capital.id.id) ? capital.id.id : -1;
        const swap = player.previousAgeCivilizationType !== player.civilizationType;
        let potential = null; try { potential = player.Cities.getPotentialSwitchCapitalCityIds(); } catch (e) { potential = null; }
        for (const cid of (Array.isArray(potential) ? potential : [])) {
          if (!cid || !isInt(cid.id) || cid.owner !== BOUND_PLAYER_ID || cid.id === capId) continue;
          let city = null; for (const c of player.Cities.getCities()) { if (c && c.id && c.id.id === cid.id) { city = c; break; } }
          if (!city) continue;
          const sc = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes.SELECT_CAPITAL, { Player1: BOUND_PLAYER_ID, City: cid.id, Swap: swap }, false);
          offers.push({ kind: "SELECT_CAPITAL", arg: cid.id, arg2: swap ? 1 : 0, pre: capId, cityId: cid.id, cityName: compose(city.name), population: isInt(city.population) ? city.population : null,
            isTown: city.isTown === true, currentCapitalName: capital ? compose(capital.name) : null, swap: swap, canStart: !!(sc && sc.Success === true) });
        }
      }
    }
    // ---- syncretism (A16): one of three ways to take on a related civilization's inheritance. The shipped
    // screen lists the civilizations per choice type from Game.Unlocks and sends the matching operation with
    // {CivilizationType}; it treats the choice as made once Identity names a syncretic civilization.
    if (typeof SyncreticChoiceTypes !== "undefined" && Game.Unlocks && player.Identity && typeof Game.Unlocks.getSyncreticCivUnlocksForChoice === "function") {
      let chosen = -1; try { const ct = player.Identity.getSyncreticCivType(); chosen = isInt(ct) && GameInfo.Civilizations.lookup(ct) ? ct : -1; } catch (e) { chosen = -1; }
      const unlockKey = (item) => {
        const k = item.kind, h = item.typeHash;
        if (k === "KIND_UNIT") return lookupKey(GameInfo.Units, h, "UnitType");
        if (k === "KIND_CONSTRUCTIBLE") return lookupKey(GameInfo.Constructibles, h, "ConstructibleType");
        if (k === "KIND_TRADITION") return lookupKey(GameInfo.Traditions, h, "TraditionType");
        return String(h);
      };
      const CHOICES = [["CHOOSE_SYNCRETISM_UNITS", "SYNCRETIC_CHOICE_UNITS", "getUnitChoiceSyncreticUnlocks"],
                       ["CHOOSE_SYNCRETISM_INFRASTRUCTURE", "SYNCRETIC_CHOICE_INFRASTRUCTURE", "getInfrastructureChoiceSyncreticUnlocks"],
                       ["CHOOSE_SYNCRETISM_SELF", "SYNCRETIC_CHOICE_SELF", "getSelfChoiceSyncreticUnlocks"]];
      for (const [op, flagName, listFn] of (chosen === -1 ? CHOICES : [])) {
        if (!isInt(PlayerOperationTypes[op]) || !isInt(SyncreticChoiceTypes[flagName])) continue;
        let civs = null; try { civs = Game.Unlocks.getSyncreticCivUnlocksForChoice(BOUND_PLAYER_ID, SyncreticChoiceTypes[flagName]); } catch (e) { civs = null; }
        if (!Array.isArray(civs)) continue;
        for (const civ of civs) {
          if (!isInt(civ)) continue;
          const trait = GameInfo.LegacyCivilizationTraits ? GameInfo.LegacyCivilizationTraits.lookup(civ) : null;
          const civKey = trait && typeof trait.CivilizationType === "string" ? trait.CivilizationType : null;
          const row = civKey ? GameInfo.Civilizations.lookup(civKey) : GameInfo.Civilizations.lookup(civ);
          const check = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes[op], { CivilizationType: civ }, false);
          const unlocks = [];
          try { if (civKey && typeof Game.Unlocks[listFn] === "function") for (const item of Game.Unlocks[listFn](civKey)) { if (item && isInt(item.typeHash)) unlocks.push({ kind: typeof item.kind === "string" ? item.kind : null, key: unlockKey(item) }); } } catch (e) { /* names are a nicety */ }
          const extra = check && check.AdditionalDescription;
          const description = typeof extra === "string" ? compose(extra) : Array.isArray(extra) ? extra.filter((x) => typeof x === "string").map(compose).join("; ") : null;
          offers.push({ kind: op, arg: civ, pre: -1, civKey: civKey || (row && typeof row.CivilizationType === "string" ? row.CivilizationType : null), displayName: row ? compose(row.Name) : null,
            choice: flagName, unlocks: unlocks, description: description, canStart: !!(check && check.Success === true) });
        }
      }
    }
    if (isInt(PlayerOperationTypes.SET_AGE_TRANSITION_DATA) && typeof GameSetup !== "undefined" && typeof GameSetup.findPlayerParameter === "function" && blockingNotifications.indexOf("NOTIFICATION_CHOOSE_CIVILIZATION") !== -1) {
      // Age transition: the shipped in-game screen sets the bound player's AgeTransitionPlayerCivilization
      // setup parameter (its domain carries a validity reason per civilization) and then sends
      // SET_AGE_TRANSITION_DATA {Finished: true}. The choice is reversible until the finish is sent.
      let param = null; try { param = GameSetup.findPlayerParameter(BOUND_PLAYER_ID, "AgeTransitionPlayerCivilization"); } catch (e) { param = null; }
      const domain = param && param.domain && Array.isArray(param.domain.possibleValues) ? param.domain.possibleValues : null;
      if (!param || !domain) throw new Error("age transition civilization parameter unavailable");
      const current = param.value && typeof param.value.value === "string" ? param.value.value : null;
      const currentRow = current ? GameInfo.Civilizations.lookup(current) : null;
      const cpre = currentRow && isInt(currentRow.$hash) ? currentRow.$hash : -1;
      let unlocks = null; try { unlocks = Database.query("config", "select CivilizationType, Type, Name, Description from CivilizationUnlocks where Kind='KIND_CIVILIZATION'"); } catch (e) { unlocks = null; }
      let mine = null; try { const pc = GameSetup.findPlayerParameter(BOUND_PLAYER_ID, "PlayerCivilization"); mine = pc && pc.value ? pc.value.value : null; } catch (e) { mine = null; }
      const chosenOne = current !== null && current !== "RANDOM";
      for (const v of domain) {
        if (!v || typeof v.value !== "string" || v.value === "RANDOM") continue;
        const row = GameInfo.Civilizations.lookup(v.value);
        if (!row || !isInt(row.$hash)) continue;
        const valid = v.invalidReason === 0;
        let historical = false; try { if (Array.isArray(unlocks)) for (const u of unlocks) { if (u && u.Type === v.value && u.CivilizationType === mine) { historical = true; break; } } } catch (e) { historical = false; }
        offers.push({ kind: "CHOOSE_AGE_CIVILIZATION", arg: row.$hash, pre: cpre, typeKey: v.value, displayName: compose(row.Name), fullName: compose(row.FullName), description: compose(row.Description),
          historical: historical, selected: current === v.value, invalidReason: isInt(v.invalidReason) ? v.invalidReason : null, canStart: valid && current !== v.value });
      }
      const fcheck = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes.SET_AGE_TRANSITION_DATA, { Finished: true }, false);
      offers.push({ kind: "SET_AGE_TRANSITION_DATA", arg: 0, pre: cpre, selectedCivilization: current, canStart: !!(fcheck && fcheck.Success === true) && chosenOne });
    }
    if (isInt(PlayerOperationTypes.CHOOSE_GOLDEN_AGE) && typeof player.Culture.getGoldenAgeChoices === "function" && GameInfo.GoldenAges) {
      // Celebration: the shipped chooser lists Culture.getGoldenAgeChoices() (type strings) and sends
      // CHOOSE_GOLDEN_AGE {GoldenAgeType: hash} after canStart.
      let choices = null; try { choices = player.Culture.getGoldenAgeChoices(); } catch (e) { choices = null; }
      if (Array.isArray(choices)) {
        for (const c of choices) {
          const row = typeof c === "string" || isInt(c) ? GameInfo.GoldenAges.lookup(c) : null;
          if (!row || !isInt(row.$hash)) continue;
          const check = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes.CHOOSE_GOLDEN_AGE, { GoldenAgeType: row.$hash }, false);
          offers.push({ kind: "CHOOSE_GOLDEN_AGE", arg: row.$hash, pre: choices.length, typeKey: typeof row.GoldenAgeType === "string" ? row.GoldenAgeType : null, displayName: compose(row.Name), description: compose(row.Description), canStart: !!(check && check.Success === true) });
        }
      }
    }
    if (isInt(PlayerOperationTypes.CHANGE_GOVERNMENT) && typeof PlayerOperationParameters !== "undefined" && isInt(PlayerOperationParameters.Activate) && GameInfo.Governments && typeof GameInfo.Governments[Symbol.iterator] === "function") {
      // Government: the shipped chooser lists StartingGovernments while none is held and sends
      // CHANGE_GOVERNMENT {GovernmentType: $index, Action: Activate} after canStart.
      let current = null; try { current = player.Culture.getGovernmentType(); } catch (e) { current = null; }
      const gpre = isInt(current) ? current : -1;
      let candidates = null;
      if (gpre === -1 && GameInfo.StartingGovernments && typeof GameInfo.StartingGovernments[Symbol.iterator] === "function") { candidates = []; for (const sg of GameInfo.StartingGovernments) { if (sg && typeof sg.GovernmentType === "string") candidates.push(sg.GovernmentType); } if (candidates.length === 0) candidates = null; }
      for (const g of GameInfo.Governments) {
        if (!g || !isInt(g.$index) || !isInt(g.$hash) || typeof g.GovernmentType !== "string") continue;
        if (candidates !== null && candidates.indexOf(g.GovernmentType) === -1) continue;
        const gargs = { GovernmentType: g.$index, Action: PlayerOperationParameters.Activate };
        const check = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes.CHANGE_GOVERNMENT, gargs, false);
        if (!check || check.Success !== true) continue;
        // the Description column is boilerplate (live friction); the real effects are the government's
        // modifier strings and the traditions it unlocks, exactly what the shipped chooser shows
        const effects = []; const unlocks = [];
        try { const mods = GameInfo.GovernmentModifiers.filter((m) => m && m.GovernmentType === g.GovernmentType).map((m) => m.ModifierId);
          for (const ms of GameInfo.ModifierStrings) { if (ms && mods.indexOf(ms.ModifierId) !== -1 && typeof ms.Text === "string") { const txt = compose(ms.Text); if (txt && effects.indexOf(txt) === -1) effects.push(txt); } } } catch (e) { /* no effect text available */ }
        try { for (const o of GameInfo.ProgressionTreeNodeUnlocks) { if (o && o.RequiredGovernmentType === g.GovernmentType) { const tr = GameInfo.Traditions.lookup(o.TargetType); const nm = tr ? compose(tr.Name) : null; if (nm && unlocks.indexOf(nm) === -1) unlocks.push(nm); } } } catch (e) { /* none */ }
        offers.push({ kind: "CHANGE_GOVERNMENT", arg: g.$index, arg2: g.$hash, pre: gpre, typeKey: g.GovernmentType, displayName: compose(g.Name), description: compose(g.Description), celebration: compose(g.CelebrationName), effects: effects, unlocksTraditions: unlocks, canStart: true });
      }
    }
    if (isInt(PlayerOperationTypes.RESPOND_DIPLOMATIC_FIRST_MEET) && typeof DiplomacyPlayerFirstMeets !== "undefined" && blocked) {
      // First contact: the seat's own NOTIFICATION_PLAYER_MET names the other player in its summary
      // ("You have met [PlayerName:N] of ..."), which is the only place the id is offered to this seat;
      // it cannot be dismissed, so a greeting is required. No roster is read and no other player object
      // is looked up: the id travels from the notification into the operation and back out again.
      for (const nid of Game.Notifications.getIdsForPlayer(BOUND_PLAYER_ID)) {
        const n = Game.Notifications.find(nid);
        if (!n || Game.Notifications.getTypeName(n.Type) !== "NOTIFICATION_PLAYER_MET" || !blocksNow(nid, n)) continue;
        let summary = null; try { summary = Game.Notifications.getSummary(nid); } catch (e) { summary = null; }
        const m = typeof summary === "string" ? summary.match(/\[PlayerName:(\d+)\]/) : null;
        if (!m) continue;
        const other = parseInt(m[1], 10);
        if (!isInt(other) || other < 0 || other === BOUND_PLAYER_ID) continue;
        let influence = null; try { influence = Math.floor(player.DiplomacyTreasury.diplomacyBalance); } catch (e) { influence = null; }
        let reveal = null; try { reveal = compose(Game.Diplomacy.getFM_RevealCapitalsString(BOUND_PLAYER_ID, other)); } catch (e) { reveal = null; }
        for (const key of ["PLAYER_REALATIONSHIP_FIRSTMEET_FRIENDLY", "PLAYER_REALATIONSHIP_FIRSTMEET_NEUTRAL", "PLAYER_REALATIONSHIP_FIRSTMEET_UNFRIENDLY"]) {
          const t = DiplomacyPlayerFirstMeets[key];
          if (!isInt(t)) continue;
          let cost = null; try { const cd = Game.Diplomacy.getFirstMeetResponseCostAndRelDelta(BOUND_PLAYER_ID, other, t); if (Array.isArray(cd) && isInt(cd[0])) cost = cd[0]; } catch (e) { cost = null; }
          const check = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes.RESPOND_DIPLOMATIC_FIRST_MEET, { Player1: BOUND_PLAYER_ID, Player2: other, Type: t }, false);
          offers.push({ kind: "RESPOND_DIPLOMATIC_FIRST_MEET", arg: t, arg2: other, arg3: nid.id, pre: nid.id, greeting: key.replace("PLAYER_REALATIONSHIP_FIRSTMEET_", ""),
            otherPlayer: other, influenceCost: cost, influenceBalance: influence, note: reveal, canStart: !!(check && check.Success === true) });
        }
      }
    }
    if (isInt(PlayerOperationTypes.FOUND_PANTHEON) && player.Religion && typeof player.Religion.getNumPantheons === "function" && GameInfo.Beliefs && typeof GameInfo.Beliefs[Symbol.iterator] === "function") {
      // Pantheon: the shipped chooser lists every BELIEF_CLASS_PANTHEON belief and gates each on
      // canStart(FOUND_PANTHEON, {BeliefType}); only the ones the game accepts are offered.
      const npre = player.Religion.getNumPantheons();
      for (const b of GameInfo.Beliefs) {
        if (!b || !isInt(b.$hash) || b.BeliefClassType !== "BELIEF_CLASS_PANTHEON") continue;
        const check = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes.FOUND_PANTHEON, { BeliefType: b.$hash }, false);
        if (!check || check.Success !== true) continue;
        offers.push({ kind: "FOUND_PANTHEON", arg: b.$hash, pre: isInt(npre) ? npre : 0, typeKey: typeof b.BeliefType === "string" ? b.BeliefType : null, displayName: compose(b.Name), description: compose(b.Description), canStart: true });
      }
    }
    if (isInt(PlayerOperationTypes.CHOOSE_NARRATIVE_STORY_DIRECTION) && player.Stories && typeof StoryTextTypes !== "undefined" && typeof PlayerOperationParameters !== "undefined" && isInt(PlayerOperationParameters.Activate)) {
      // Narrative events: the shipped screen shows the first pending story, one button per eligible
      // link (or a single CLOSE when the story has none), and sends CHOOSE_NARRATIVE_STORY_DIRECTION
      // {TargetType: linkKey, Target: storyId, Action: Activate}. Text comes from the stories component.
      const st = player.Stories;
      const sid = st.getFirstPendingDiscoveryLastMetID();
      const story = sid && isInt(sid.id) ? st.find(sid) : null;
      const def = story && isInt(story.type) ? GameInfo.NarrativeStories.lookup(story.type) : null;
      if (sid && story && def && typeof def.NarrativeStoryType === "string") {
        const inject = (hash, textType) => { try { const s = st.determineNarrativeInjection(sid, hash, textType); return typeof s === "string" ? compose(s) : null; } catch (e) { return null; } };
        const title = compose(def.StoryTitle || def.Name); const body = compose(def.Completion || def.Description);
        let linkKeys = [];
        if (def.VariableLinks) { const ol = st.getOrderedLinks(sid); if (Array.isArray(ol)) linkKeys = ol.map((l) => (l && typeof l === "object" ? l.ToNarrativeStoryType : l)); }
        else { for (const row of GameInfo.NarrativeStory_Links) { if (row && row.FromNarrativeStoryType === def.NarrativeStoryType) linkKeys.push(row.ToNarrativeStoryType); } }
        const answers = [];
        for (const key of linkKeys) {
          if (typeof key !== "string") continue;
          const ld = GameInfo.NarrativeStories.lookup(key);
          if (!ld || !isInt(ld.$hash) || typeof ld.Activation !== "string") continue;
          const act = ld.Activation.toUpperCase();
          const eligible = act === "LINKED" || ((act === "LINKED_REQUISITE" || act === "LINKED_SUBJECT_REQUISITE") && st.determineRequisiteLink(ld.NarrativeStoryType, sid) === true);
          if (!eligible) continue;
          const affordable = ld.Cost === 0 || !isInt(ld.Cost) || st.canAfford(ld.NarrativeStoryType) === true;
          answers.push({ key: ld.NarrativeStoryType, hash: ld.$hash, option: inject(ld.$hash, StoryTextTypes.OPTION), reward: inject(ld.$hash, StoryTextTypes.REWARD), action: inject(ld.$hash, StoryTextTypes.IMPERATIVE), cost: isInt(ld.Cost) ? ld.Cost : 0, costYield: typeof ld.CostYield === "string" ? ld.CostYield : null, affordable: affordable });
        }
        if (answers.length === 0) answers.push({ key: "CLOSE", hash: -1, option: compose("LOC_NARRATIVE_STORY_END_STORY_NAME"), reward: (() => { try { const s = st.determineNarrativeInjectionComponentId(sid, StoryTextTypes.REWARD); return typeof s === "string" ? compose(s) : null; } catch (e) { return null; } })(), action: null, cost: 0, costYield: null, affordable: true });
        for (const a of answers) {
          const nargs = { TargetType: a.key, Target: sid, Action: PlayerOperationParameters.Activate };
          const check = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes.CHOOSE_NARRATIVE_STORY_DIRECTION, nargs, false);
          offers.push({ kind: "CHOOSE_NARRATIVE_STORY_DIRECTION", arg: sid.id, arg2: a.hash, pre: story.type, storyId: sid.id, storyKey: def.NarrativeStoryType, title: title, body: body,
            answerKey: a.key, option: a.option, reward: a.reward, action: a.action, cost: a.cost, costYield: a.costYield, affordable: a.affordable, canStart: !!(check && check.Success === true) && a.affordable });
        }
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
