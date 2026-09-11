// Read-only post-action read-back for the bound player.
(() => {
  const t = (f) => { try { const v = f(); return v === undefined ? null : v; } catch (e) { return null; } };
  const player = t(() => Players.get(BOUND_PLAYER_ID));
  return JSON.stringify({
    turn: t(() => Game.turn), age: t(() => Game.age),
    gameGuid: t(() => { const g = Configuration.getGame(); return (typeof g.campaignSetupGUID === "string" && g.campaignSetupGUID) ? g.campaignSetupGUID : ((typeof g.gameGUIDHexString === "string" && g.gameGUIDHexString) ? g.gameGUIDHexString : null); }),
    localPlayerId: t(() => GameContext.localPlayerID), localObserverId: t(() => GameContext.localObserverID),
    isTurnActive: player ? t(() => player.isTurnActive) : null,
    techResearching: player ? t(() => player.Techs.getResearching().type) : null,
    civicResearching: player ? t(() => player.Culture.getResearching().type) : null,
    techTargetNode: player ? t(() => player.Techs.getTargetNode()) : null,
    civicTargetNode: player ? t(() => player.Culture.getTargetNode()) : null,
    hasSentTurnComplete: t(() => GameContext.hasSentTurnComplete()),
    blockingNotifications: t(() => { const out = []; if (Game.Notifications.getEndTurnBlockingType(BOUND_PLAYER_ID) === EndTurnBlockingTypes.NONE) return out; for (const nid of Game.Notifications.getIdsForPlayer(BOUND_PLAYER_ID)) { const n = Game.Notifications.find(nid); let b = null; try { b = typeof Game.Notifications.getBlocksTurnAdvancement === "function" ? Game.Notifications.getBlocksTurnAdvancement(nid) : null; } catch (e) { b = null; } if (b === true || (b !== false && n && n.BlocksTurnAdvancement === true)) out.push(Game.Notifications.getTypeName(n.Type)); } return out; }),
    endTurnBlocking: t(() => { const v = Game.Notifications.getEndTurnBlockingType(BOUND_PLAYER_ID); for (const k of Object.keys(EndTurnBlockingTypes)) if (EndTurnBlockingTypes[k] === v) return k; for (const nid of Game.Notifications.getIdsForPlayer(BOUND_PLAYER_ID)) { const n = Game.Notifications.find(nid); if (n && n.BlocksTurnAdvancement === true) return Game.Notifications.getTypeName(n.Type); } return String(v); }),
    pendingStories: player ? t(() => { const out = []; const st = player.Stories; const first = st.getFirstPendingDiscoveryLastMetID(); if (first && Number.isInteger(first.id)) out.push(first.id); const met = st.getPendingMetIds(); if (Array.isArray(met)) for (const m of met) if (m && Number.isInteger(m.id) && out.indexOf(m.id) === -1) out.push(m.id); return out; }) : null,
    attributeNodes: player ? t(() => { const m = {}; for (const nd of GameInfo.ProgressionTreeNodes) { if (nd && typeof nd.ProgressionTree === "string" && nd.ProgressionTree.indexOf("TREE_ATTRIBUTE") === 0) { const ns = Game.ProgressionTrees.getNode(BOUND_PLAYER_ID, nd.$hash); m[String(nd.$hash)] = ns && Number.isInteger(ns.state) ? ns.state : null; } } return m; }) : null,
    resourceAssignments: player ? t(() => { const m = {}; for (const c of player.Cities.getCities()) { if (c && c.id && c.Resources) for (const ar of c.Resources.getAssignedResources()) { if (ar && Number.isInteger(ar.value)) m[String(ar.value)] = c.id.id; } } return m; }) : null,
    legacyDeck: player ? t(() => player.AdvancedStart.getCards().map((c) => Database.makeHash((c.info || c).id))) : null,
    // remaining placements per placement effect of a card in the deck, keyed by the effect's hash
    legacyPlacements: player ? t(() => { const m = {}; for (const d of player.AdvancedStart.getCards()) { const c = d && d.info ? d.info : d; for (const e of ((c && c.effects) || [])) { if (e && e.isPlacementEffect === true && typeof e.id === "string") m[String(Database.makeHash(e.id))] = e.amount; } } return m; }) : null,
    capitalCityId: player ? t(() => player.Cities.getCapital().id.id) : null,
    syncreticCiv: player ? t(() => { const c = player.Identity.getSyncreticCivType(); return Number.isInteger(c) ? c : null; }) : null,
    syncreticChoice: player ? t(() => player.Identity.getSyncreticChoiceType()) : null,
    ageTransitionCivilization: t(() => { const p = GameSetup.findPlayerParameter(BOUND_PLAYER_ID, "AgeTransitionPlayerCivilization"); return p && p.value ? p.value.value : null; }),
    goldenAgeChoices: player ? t(() => player.Culture.getGoldenAgeChoices().length) : null,
    governmentType: player ? t(() => player.Culture.getGovernmentType()) : null,
    religionType: player ? t(() => player.Religion.getReligionType()) : null,
    beliefsHeld: player ? t(() => player.Religion.getBeliefs()) : null,
    pantheons: player ? t(() => player.Religion.getPantheons()) : null,
    activeTraditions: player ? t(() => { const out = []; for (const k of ["TRADITION_CULTURE_SLOT", "POLICY_CULTURE_SLOT", "CRISIS_CULTURE_SLOT"]) { const st = CultureSlotTypes[k]; if (Number.isInteger(st)) for (const h of player.Culture.getActiveTraditions(st)) out.push(h); } return out; }) : null,
    tradeRoutes: player ? t(() => player.Trade.countPlayerTradeRoutes()) : null,
    unitCount: player ? t(() => player.Units.getUnits().length) : null,
    // BEGIN VETTED MET-PLAYER SCOPE
    diplomaticRelations: player ? t(() => { const m = {}; for (const other of Players.getEverAlive()) { if (!other || !Number.isInteger(other.id) || other.id === BOUND_PLAYER_ID) continue; if (player.Diplomacy.hasMet(other.id) !== true) continue; m[String(other.id)] = { atWar: player.Diplomacy.isAtWarWith(other.id) === true, allied: player.Diplomacy.hasAllied(other.id) === true, pendingDeal: (() => { try { return Game.DiplomacyDeals.hasPendingDeal(BOUND_PLAYER_ID, other.id) === true; } catch (e) { return null; } })() }; } return m; }) : null,
    // END VETTED MET-PLAYER SCOPE
    // The answer recorded on each proposal aimed at this seat (-1 while unanswered).
    proposalResponses: player ? t(() => { const m = {}; for (const ev of Game.Diplomacy.getPlayerEvents(BOUND_PLAYER_ID)) { if (ev && Number.isInteger(ev.uniqueID) && ev.targetPlayer === BOUND_PLAYER_ID && Number.isInteger(ev.responseType)) m[String(ev.uniqueID)] = ev.responseType; } return m; }) : null,
    callToArms: t(() => Game.Diplomacy.getNextCallToArms(BOUND_PLAYER_ID)),
    influenceBalance: player ? t(() => Math.floor(player.DiplomacyTreasury.diplomacyBalance)) : null,
    goldBalance: player ? t(() => Math.floor(player.Treasury.goldBalance)) : null,
    // Neither getNumPromotions nor getTotalPromotionsEarned moves when a promotion is taken (both were
    // tried live and stayed put), so the held set is the only positive signal. hasPromotion takes the
    // discipline and promotion TYPE STRINGS, not hashes: a hash argument silently answers false.
    unitPromotions: player ? t(() => { const m = {}; for (const u of player.Units.getUnits()) { if (!u || !u.id || !u.Experience || typeof u.Experience.hasPromotion !== "function") continue; const held = []; for (const det of GameInfo.UnitPromotionDisciplineDetails) { if (!det || typeof det.UnitPromotionDisciplineType !== "string" || typeof det.UnitPromotionType !== "string") continue; try { if (u.Experience.hasPromotion(det.UnitPromotionDisciplineType, det.UnitPromotionType) === true) { const h = Database.makeHash(det.UnitPromotionType); if (held.indexOf(h) === -1) held.push(h); } } catch (e) {} } m[String(u.id.id)] = held; } return m; }) : null,
    unitTypes: player ? t(() => { const m = {}; for (const u of player.Units.getUnits()) { if (u && u.id && Number.isInteger(u.type)) m[String(u.id.id)] = u.type; } return m; }) : null,
    unitArmies: player ? t(() => { const m = {}; for (const u of player.Units.getUnits()) { if (u && u.id) m[String(u.id.id)] = u.armyId && Number.isInteger(u.armyId.id) ? u.armyId.id : -1; } return m; }) : null,
    armySizes: player ? t(() => { const m = {}; for (const u of player.Units.getUnits()) { if (!u || !u.id || !u.armyId || !Number.isInteger(u.armyId.id) || u.armyId.id < 0) continue; const a = Armies.get(u.armyId); m[String(u.id.id)] = a && Number.isInteger(a.unitCount) ? a.unitCount : -1; } return m; }) : null,
    // whether each unit is ready to move, the same reading the wake and cancel offers take as their precondition
    unitAwake: player ? t(() => { const m = {}; for (const u of player.Units.getUnits()) { if (u && u.id && Number.isInteger(u.id.id)) m[String(u.id.id)] = u.isReadyToMove === true ? 1 : 0; } return m; }) : null,
    unitMoves: player ? t(() => { const m = {}; for (const u of player.Units.getUnits()) { if (u && u.id && u.Movement && Number.isInteger(u.Movement.movementMovesRemaining)) m[String(u.id.id)] = u.Movement.movementMovesRemaining; } return m; }) : null,
    unitCharges: player ? t(() => { const m = {}; if (typeof UnitOperationTypes === "undefined" || !Number.isInteger(UnitOperationTypes.SPREAD_RELIGION)) return m; for (const u of player.Units.getUnits()) { if (!u || !u.id) continue; const r = Game.UnitOperations.canStart(u.id, UnitOperationTypes.SPREAD_RELIGION, { X: -9999, Y: -9999, UnitAbilityType: -1 }, false); if (r && Number.isInteger(r.ChargesRemaining)) m[String(u.id.id)] = r.ChargesRemaining; } return m; }) : null,
    unitAttacks: player ? t(() => { const m = {}; for (const u of player.Units.getUnits()) { if (u && u.id && u.Combat && Number.isInteger(u.Combat.attacksRemaining)) m[String(u.id.id)] = u.Combat.attacksRemaining; } return m; }) : null,
    unitsReadyToMove: player ? t(() => player.Units.getUnits().filter((u) => u.isReadyToMove === true).map((u) => u.id.id)) : null,
    specialistPlots: player ? t(() => { const m = {}; for (const c of player.Cities.getCities()) { if (!c || !c.Workers) continue; const info = c.Workers.GetAllPlacementInfo(); if (!Array.isArray(info)) continue; for (const q of info) { if (q && Number.isInteger(q.PlotIndex) && Number.isInteger(q.NumWorkers)) m[String(q.PlotIndex)] = q.NumWorkers; } } return m; }) : null,
    cityQueues: player ? t(() => { const m = {}; for (const c of player.Cities.getCities()) { if (c && c.id && c.BuildQueue) m[String(c.id.id)] = c.BuildQueue.getQueue().map((it) => it.type); } return m; }) : null,
    cityProduction: player ? t(() => { const m = {}; for (const c of player.Cities.getCities()) { if (c && c.id && c.BuildQueue) m[String(c.id.id)] = c.BuildQueue.currentProductionTypeHash; } return m; }) : null,
    townProjects: player ? t(() => { const m = {}; for (const c of player.Cities.getCities()) { if (c && c.id && c.Growth) m[String(c.id.id)] = Number.isInteger(c.Growth.projectType) ? c.Growth.projectType : -1; } return m; }) : null,
    expandPlots: player ? t(() => { const m = {}; for (const c of player.Cities.getCities()) { if (c && c.id) { const r = Game.CityCommands.canStart(c.id, CityCommandTypes.EXPAND, {}, false); m[String(c.id.id)] = r && Array.isArray(r.Plots) ? r.Plots : []; } } return m; }) : null,
    townFlags: player ? t(() => { const m = {}; for (const c of player.Cities.getCities()) { if (c && c.id) m[String(c.id.id)] = c.isTown === true; } return m; }) : null,
    capturedPending: player ? t(() => player.Cities.getCities().filter((c) => c && c.id && c.isJustConqueredFrom).map((c) => c.id.id)) : null,
    razing: player ? t(() => player.Cities.getCities().filter((c) => c && c.id && c.isBeingRazed === true).map((c) => c.id.id)) : null,
    cityIds: player ? t(() => player.Cities.getCities().filter((c) => c && c.id).map((c) => c.id.id)) : null,
    cityStateBonusPending: t(() => Game.CityStates.getCityStateBonusToSelect(BOUND_PLAYER_ID)),
    advisorWarnings: t(() => { const out = []; for (const nid of Game.Notifications.getIdsForPlayer(BOUND_PLAYER_ID)) { const n = Game.Notifications.find(nid); const name = n ? Game.Notifications.getTypeName(n.Type) : ""; if (typeof name === "string" && name.indexOf("NOTIFICATION_ADVISOR_WARNING") === 0 && nid && Number.isInteger(nid.id)) out.push(nid.id); } return out; }),
    cityLocations: player ? t(() => { const m = {}; for (const c of player.Cities.getCities()) { if (c && c.id && c.location) m[String(c.id.id)] = [c.location.x, c.location.y]; } return m; }) : null,
    unitLocations: player ? t(() => { const m = {}; for (const u of player.Units.getUnits()) { if (u && u.id && u.location) m[String(u.id.id)] = [u.location.x, u.location.y]; } return m; }) : null,
    curtainDisplayed: t(() => typeof document !== "undefined" ? document.getElementById("hotseat-screen-curtain") !== null : null)
  });
})()
