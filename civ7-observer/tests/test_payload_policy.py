"""Static leak policy for every packaged JavaScript payload.

Live finding (docs/runtime-contract.md, hotseat): the debug API is omniscient across
seats. Seat binding is therefore enforced here, in code, not by the game. Any payload
that names another player, enumerates the player roster, or reads tile detail without
a visibility check must fail before it can ship. The single mutation payload is held to
an explicit allowlist of engine calls instead.
"""

import re
from importlib import resources

import pytest

PAYLOAD_DIR = resources.files("civ7_observer").joinpath("payloads")

# Reads that touch players other than the bound one, or that enumerate the roster.
FORBIDDEN_PATTERNS = {
    "roster enumeration": r"\b(humanPlayerIDs|aiPlayerIDs|participatingPlayerIDs|possibleParticipatingPlayerIDs|inUsePlayerIDs|availablePlayerIDs|multiplayerPlayerIDs|hiddenPlayerIDs|observerIDs)\b",
    "player lookup with anything but the bound constant": r"Players\.get\s*\(\s*(?!BOUND_PLAYER_ID\s*\))",
    "player collection walk": r"Players\.(getAlive|getAll|getEverAlive|getAliveMajor|getAliveIds|getIds)\b",
    "visibility for a non-bound player": r"getRevealedState\s*\(\s*(?!BOUND_PLAYER_ID\s*,)",
    "raw visibility dump": r"\bgetRevealedStates\s*\(",
    "seed or hidden setup data": r"\b(gameSeed|mapSeed|getRandom|Game\.Random)\b",
    "resources (excluded in v0.1)": r"\bgetResourceType\s*\(",
    # anchored on Game.* : the GameInfo.* tables of the same name are read-only definition lookups
    "mutating or revealing calls": r"\b(revealTree|revealAll|unlockTradition|sendRequest|sendTurnComplete|Game\.DiplomacyDeals\.(?!hasPendingDeal\b|getWorkingDeal\b|getWorkingDealItem\b|getPossibleWorkingDealItems\b)\w+|Game\.PlayerOperations\.(?!canStart\b)\w+|Game\.UnitOperations\.(?!canStart\b)\w+|Game\.CityOperations\.(?!canStart\b)\w+|Game\.CityCommands\.(?!canStart\b)\w+|Game\.UnitCommands\.(?!canStart\b)\w+|setResearch|purchasePlot|destroy)\b",
    "game setup writes": r"\bGameSetup\.(set\w+|loadCreateGameSettings|resetSavedCreateGameSettings)\s*\(",
    "network / storage / timing": r"\b(fetch|XMLHttpRequest|WebSocket|localStorage|sessionStorage|indexedDB|setTimeout|setInterval|requestAnimationFrame)\b",
    "imports / eval": r"\b(import|require|eval|Function)\s*\(|^\s*import\s",
}

MUTATION_PAYLOADS = {"perform.js", "curtain.js"}   # curtain.js mutates the UI only and may contain no engine call at all
# The only engine calls a mutation payload may contain, as exact substrings.
MUTATION_ALLOWLIST = (
    "Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND]",
    "Game.PlayerOperations.sendRequest(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND]",
    "GameContext.sendTurnComplete()",
    'Game.UnitOperations.canStart(unitId, UnitOperationTypes.SKIP_TURN, {}, false)',
    'Game.UnitOperations.sendRequest(unitId, UnitOperationTypes.SKIP_TURN, {})',
    'Game.UnitOperations.canStart(unitId, UnitOperationTypes.MOVE_TO, moveArgs, false)',
    'Game.UnitOperations.sendRequest(unitId, UnitOperationTypes.MOVE_TO, moveArgs)',
    'Game.CityOperations.canStart(cityId, CityOperationTypes.BUILD, buildArgs, false)',
    'Game.CityOperations.sendRequest(cityId, CityOperationTypes.BUILD, buildArgs)',
    # a city project: the same BUILD, with a project instead of a unit or a constructible
    'Game.CityOperations.canStart(pCityId, CityOperationTypes.BUILD, buildArgs, false)',
    'Game.CityOperations.sendRequest(pCityId, CityOperationTypes.BUILD, buildArgs)',
    'Game.UnitOperations.canStart(unitId, UnitOperationTypes.FOUND_CITY, foundArgs, false)',
    'Game.UnitOperations.sendRequest(unitId, UnitOperationTypes.FOUND_CITY, foundArgs)',
    # standing orders: the operation is a table hash the payload restricts to a fixed no-target set
    'Game.UnitOperations.canStart(unitId, orderType, orderArgs, false)',
    'Game.UnitOperations.sendRequest(unitId, orderType, orderArgs)',
    'Game.CityCommands.canStart(cityId, CityCommandTypes.EXPAND, {}, false)',
    'Game.CityCommands.canStart(cityId, CityCommandTypes.EXPAND, expandArgs, false)',
    'Game.CityCommands.sendRequest(cityId, CityCommandTypes.EXPAND, expandArgs)',
    'Game.CityCommands.canStart(cityId, CityCommandTypes.CHANGE_GROWTH_MODE, gargs, false)',
    'Game.CityCommands.canStart(townId, CityCommandTypes.CHANGE_GROWTH_MODE, growthArgs, false)',
    'Game.CityCommands.sendRequest(townId, CityCommandTypes.CHANGE_GROWTH_MODE, growthArgs)',
    'Game.CityCommands.canStart(cityId, CityCommandTypes.PURCHASE, buyArgs, false)',
    'Game.CityCommands.sendRequest(cityId, CityCommandTypes.PURCHASE, buyArgs)',
    # buying a building: same command, but the placement plot rides along with the constructible
    'Game.CityCommands.canStart(bCityId, CityCommandTypes.PURCHASE, cbuyArgs, false)',
    'Game.CityCommands.sendRequest(bCityId, CityCommandTypes.PURCHASE, cbuyArgs)',
    # promoting a town to a city: the same command carries the upgrade directive instead of a thing to buy
    'Game.CityCommands.canStart(townId, CityCommandTypes.PURCHASE, upArgs, false)',
    'Game.CityCommands.sendRequest(townId, CityCommandTypes.PURCHASE, upArgs)',
    # a just-captured settlement's fate: DESTROY with a directive that keeps, razes or liberates
    'Game.CityCommands.canStart(capturedId, CityCommandTypes.DESTROY, dispArgs, false)',
    'Game.CityCommands.sendRequest(capturedId, CityCommandTypes.DESTROY, dispArgs)',
    # peace: the shipped screen's bounded workflow for a plain peace, and the answer to an incoming one
    'Game.DiplomacyDeals.clearWorkingDeal(outgoing)',
    'Game.DiplomacyDeals.addItemToWorkingDeal(outgoing, peaceItem)',
    'Game.DiplomacyDeals.sendWorkingDeal(outgoing, DiplomacyDealProposalActions.PROPOSED)',
    'Game.DiplomacyDeals.sendWorkingDeal(incoming, answer)',
    # diplomacy: the operation is not named by the payload at all, it is taken from the engine's own
    # current listing for a project the engine still reports as available against that target
    'Game.PlayerOperations.canStart(BOUND_PLAYER_ID, project.operationType, shape, false)',
    'Game.PlayerOperations.sendRequest(BOUND_PLAYER_ID, project.operationType, diploArgs)',
    'GameSetup.setPlayerParameterValue(BOUND_PLAYER_ID, "AgeTransitionPlayerCivilization", civKey)',
    # taking a legacy card takes its reward in the same action: the engine never reports an effect as spent
    'Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes.ADVANCED_START_USE_EFFECT, { ID: e.id }, false)',
    'Game.PlayerOperations.sendRequest(BOUND_PLAYER_ID, PlayerOperationTypes.ADVANCED_START_USE_EFFECT, { ID: e.id })',
    'Game.UnitCommands.canStart(unitId, UnitCommandTypes.PROMOTE, promoArgs, false)',
    'Game.UnitCommands.sendRequest(unitId, UnitCommandTypes.PROMOTE, promoArgs)',
    'Game.UnitCommands.canStart(unitId, UnitCommandTypes.MAKE_TRADE_ROUTE, tradeArgs, false)',
    'Game.UnitCommands.sendRequest(unitId, UnitCommandTypes.MAKE_TRADE_ROUTE, tradeArgs)',
    # disbanding: destructive, gated behind an explicit confirmation before it ever reaches here
    'Game.UnitCommands.canStart(unitId, UnitCommandTypes.DELETE, delArgs, false)',
    'Game.UnitCommands.sendRequest(unitId, UnitCommandTypes.DELETE, delArgs)',
    # attacking: the engine's own classifier picks which of the two, and both are sent for a plot the
    # native check accepts for THIS unit
    'Game.UnitOperations.canStart(aUnitId, UnitOperationTypes.RANGE_ATTACK, rangedArgs, false)',
    'Game.UnitOperations.sendRequest(aUnitId, UnitOperationTypes.RANGE_ATTACK, rangedArgs)',
    'Game.UnitOperations.canStart(aUnitId, UnitOperationTypes.MOVE_TO, meleeArgs, false)',
    'Game.UnitOperations.sendRequest(aUnitId, UnitOperationTypes.MOVE_TO, meleeArgs)',
    # sending a merchant: the shipped chooser's own fallback, a plain move to the target city's plot
    'Game.UnitOperations.canStart(mUnitId, UnitOperationTypes.MOVE_TO, sendArgs, false)',
    'Game.UnitOperations.sendRequest(mUnitId, UnitOperationTypes.MOVE_TO, sendArgs)',
    # pillage, coastal raid, pillage route, spread religion: plot-target operations, the kind being the engine's name
    'Game.UnitOperations.canStart(actor2.id, opType2, probeArgs, false)',
    'Game.UnitOperations.canStart(opUnitId, opType2, opArgs, false)',
    'Game.UnitOperations.sendRequest(opUnitId, opType2, opArgs)',
    # a town back to growth: the same growth-mode command, Type EXPAND
    'Game.CityCommands.canStart(townId, CityCommandTypes.CHANGE_GROWTH_MODE, growthArgs, false)',
    'Game.CityCommands.sendRequest(townId, CityCommandTypes.CHANGE_GROWTH_MODE, growthArgs)',
    # queue edits: BUILD with an insert mode, as the shipped build-queue panel sends them
    'Game.CityOperations.canStart(qCityId, CityOperationTypes.BUILD, queueArgs, false)',
    'Game.CityOperations.sendRequest(qCityId, CityOperationTypes.BUILD, queueArgs)',
    # taking a tradition out, and moving resources: two named player operations reached by name
    'Game.PlayerOperations.canStart(BOUND_PLAYER_ID, traditionOp, deactArgs, false)',
    'Game.PlayerOperations.sendRequest(BOUND_PLAYER_ID, traditionOp, deactArgs)',
    'Game.PlayerOperations.canStart(BOUND_PLAYER_ID, resourceOp, resArgs, false)',
    'Game.PlayerOperations.sendRequest(BOUND_PLAYER_ID, resourceOp, resArgs)',
    # the six generic unit commands: the kind IS the engine's command name, validated host-side
    # against the catalog, so no caller text ever reaches UnitCommandTypes
    'Game.UnitCommands.canStart(cUnitId, commandType, cmdArgs, false)',
    'Game.UnitCommands.sendRequest(cUnitId, commandType, cmdArgs)',
)
MUTATION_FORBIDDEN = r"\b(PlayerOperationTypes\.(?!ADVANCED_START_USE_EFFECT\b)[A-Z_]+|UnitOperationTypes\.(?!SKIP_TURN\b|MOVE_TO\b|FOUND_CITY\b|RANGE_ATTACK\b)[A-Z_]+|CityOperationTypes\.(?!BUILD\b)[A-Z_]+|CityCommandTypes\.(?!EXPAND\b|CHANGE_GROWTH_MODE\b|PURCHASE\b|DESTROY\b)[A-Z_]+|UnitCommandTypes\.(?!PROMOTE\b|MAKE_TRADE_ROUTE\b|DELETE\b)[A-Z_]+|sendUnreadyTurn|sendRetireRequest|sendPauseRequest|sendGameQuery|revealTree|unlockTradition|purchasePlot|destroy|Network\.)\b"
ENGINE_CALL = re.compile(r"(Game\.(?:PlayerOperations|UnitOperations|CityOperations|CityCommands|UnitCommands)\.(?:canStart|sendRequest)\([^)]*\)?|Game\.DiplomacyDeals\.(?:clearWorkingDeal|addItemToWorkingDeal|removeItemFromWorkingDeal|sendWorkingDeal)\([^)]*\)|GameContext\.sendTurnComplete\(\)|GameSetup\.set\w+\([^)]*\))")


VETTED_MARKERS = (("    // BEGIN VETTED MET-PLAYER SCOPE\n", "    // END VETTED MET-PLAYER SCOPE\n"),
                  ("    // BEGIN VETTED DEFENDER SCOPE\n", "    // END VETTED DEFENDER SCOPE\n"),
                  ("    // BEGIN VETTED TRADE TARGET SCOPE\n", "    // END VETTED TRADE TARGET SCOPE\n"))

VETTED_MET_PLAYER_SCOPE_OFFERS = """    const metPlayers = () => {
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
"""


# The read-back's own vetted block. It is narrower still: for each met player it reads two booleans
# about this seat's relationship with them, which is what confirms a war declared or an alliance
# formed. No name, no units, no cities, nothing about their state.
VETTED_MET_PLAYER_SCOPE_READBACK = """    diplomaticRelations: player ? t(() => { const m = {}; for (const other of Players.getEverAlive()) { if (!other || !Number.isInteger(other.id) || other.id === BOUND_PLAYER_ID) continue; if (player.Diplomacy.hasMet(other.id) !== true) continue; m[String(other.id)] = { atWar: player.Diplomacy.isAtWarWith(other.id) === true, allied: player.Diplomacy.hasAllied(other.id) === true, pendingDeal: (() => { try { return Game.DiplomacyDeals.hasPendingDeal(BOUND_PLAYER_ID, other.id) === true; } catch (e) { return null; } })() }; } return m; }) : null,
"""

# Only these two payloads may carry a vetted block, and only with exactly this text.

# Choosing a target means seeing what stands on it. This block may read the defender on a plot the
# engine says THIS unit can attack right now, and of it only the unit's type name and how hurt it is:
# the two things the shipped combat preview puts in front of a human before the same click. No owner,
# no position beyond the plot already named, nothing off that plot.
VETTED_DEFENDER_SCOPE = """    const defenderOn = (unitId, x, y) => {
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
"""

# A merchant cannot be aimed at a city the seat cannot see. This block may read, for each city the
# engine itself names as a trade-route target for this seat, only its name, location and plots.
VETTED_TRADE_TARGET_SCOPE = """    const tradeTargets = () => {
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
"""

# Only these payloads may carry a vetted block, and only with exactly this text. The key is the
# payload and which marker pair the block sits between.
VETTED_SCOPES = {
    ("offers.js", 0): VETTED_MET_PLAYER_SCOPE_OFFERS,
    ("readback.js", 0): VETTED_MET_PLAYER_SCOPE_READBACK,
    ("offers.js", 1): VETTED_DEFENDER_SCOPE,
    ("offers.js", 2): VETTED_TRADE_TARGET_SCOPE,
}
VETTED_PAYLOADS = {name for name, _ in VETTED_SCOPES}


def strip_vetted(source: str, name: str | None = None) -> str:
    """Blank out every vetted block, keeping line numbers intact, after checking each is unchanged."""
    for kind, (begin, end) in enumerate(VETTED_MARKERS):
        start = source.find(begin)
        if start == -1:
            continue
        body = start + len(begin)
        stop = source.index(end, body)
        expected = VETTED_SCOPES.get((name, kind)) if name else next(
            (v for v in VETTED_SCOPES.values() if v == source[body:stop]), None)
        assert expected is not None and source[body:stop] == expected, (
            f"a vetted scope in {name or 'this payload'} has been edited; review it against the "
            "policy it was written for before updating VETTED_SCOPES"
        )
        source = source[:body] + "\n" * source.count("\n", body, stop) + source[stop:]
    return source


@pytest.mark.parametrize(("name", "kind"), sorted(VETTED_SCOPES))
def test_each_vetted_scope_is_present_and_unchanged(name, kind):
    source = (PAYLOAD_DIR / name).read_text(encoding="utf-8")
    assert VETTED_MARKERS[kind][0] in source, f"{name} must delimit vetted scope {kind}"
    strip_vetted(source, name)   # asserts every block in it matches character for character


def test_no_other_payload_may_carry_a_vetted_scope():
    for payload in PAYLOAD_DIR.iterdir():
        if payload.name.endswith(".js") and payload.name not in VETTED_PAYLOADS:
            text = payload.read_text(encoding="utf-8")
            for begin, _ in VETTED_MARKERS:
                assert begin not in text, f"{payload.name} may not exempt itself"


def violations(source: str) -> list[str]:
    source = strip_vetted(source)
    found = []
    for label, pattern in FORBIDDEN_PATTERNS.items():
        for m in re.finditer(pattern, source, flags=re.MULTILINE):
            line = source.count("\n", 0, m.start()) + 1
            found.append(f"{label} at line {line}: {m.group(0)!r}")
    return found


def packaged_payloads():
    return sorted(p for p in PAYLOAD_DIR.iterdir() if p.name.endswith(".js") and p.name not in MUTATION_PAYLOADS)


def mutation_payloads():
    return sorted(p for p in PAYLOAD_DIR.iterdir() if p.name in MUTATION_PAYLOADS)


def test_at_least_one_payload_is_packaged():
    assert packaged_payloads(), "no payloads found; package data misconfigured"


@pytest.mark.parametrize("payload", packaged_payloads(), ids=lambda p: p.name)
def test_packaged_payload_has_no_leak_patterns(payload):
    assert violations(payload.read_text(encoding="utf-8")) == []


BAD_SAMPLES = {
    "other player lookup": "const p = Players.get(GameContext.localPlayerID);",
    "hard-coded player": "Players.get(0).Units.getUnits()",
    "roster": "Configuration.getGame().humanPlayerIDs.map(id => id)",
    "foreign fog": "GameplayMap.getRevealedState(otherId, x, y)",
    "seed": "const s = Configuration.getGame().gameSeed;",
    "reveal": "Game.ProgressionTrees.revealTree(1)",
    "resource": "GameplayMap.getResourceType(x, y)",
    "timer": "setTimeout(() => {}, 0)",
    "operation in a read-only payload": "Game.PlayerOperations.sendRequest(BOUND_PLAYER_ID, 1, {})",
}


@pytest.mark.parametrize("sample", BAD_SAMPLES.values(), ids=list(BAD_SAMPLES))
def test_policy_catches_known_bad_samples(sample):
    assert violations(sample), f"policy failed to flag: {sample}"


GOOD_SAMPLES = [
    "const p = Players.get(BOUND_PLAYER_ID);",
    "GameplayMap.getRevealedState(BOUND_PLAYER_ID, x, y) === RevealedStates.VISIBLE",
    "typeof Players !== 'undefined'",
]


@pytest.mark.parametrize("sample", GOOD_SAMPLES)
def test_policy_allows_bound_player_reads(sample):
    assert violations(sample) == []


def test_mutation_payload_exists_and_is_not_scanned_as_read_only():
    assert [p.name for p in mutation_payloads()] == ["curtain.js", "perform.js"]
    assert "perform.js" not in [p.name for p in packaged_payloads()]


def test_curtain_payload_touches_the_ui_only():
    src = (PAYLOAD_DIR / "curtain.js").read_text(encoding="utf-8")
    assert not ENGINE_CALL.search(src), "the curtain payload must send no engine operation"
    assert not re.search(MUTATION_FORBIDDEN, src)
    assert "sendRequest" not in src and "sendTurnComplete" not in src
    assert [v for v in violations(src) if "mutating or revealing calls" not in v] == []


@pytest.mark.parametrize("payload", mutation_payloads(), ids=lambda p: p.name)
def test_mutation_payload_uses_only_the_allowlisted_engine_calls(payload):
    src = payload.read_text(encoding="utf-8")
    if payload.name == "curtain.js":
        return   # covered by test_curtain_payload_touches_the_ui_only
    calls = [m.group(0) for m in ENGINE_CALL.finditer(src)]
    assert calls, "mutation payload must contain the allowlisted calls"
    for call in calls:
        assert any(call.startswith(a) for a in MUTATION_ALLOWLIST), f"non-allowlisted engine call: {call!r}"
    assert not re.search(MUTATION_FORBIDDEN, src), "mutation payload references a forbidden surface"
    assert "PlayerOperationTypes[OP_KIND]" in src
    # every operation is sent through the host-substituted kind; the one literal type name is a read-only check
    # every other operation is sent through the host-substituted kind; the one literal type name is the
    # legacy effect applied alongside its card, which the engine cannot report as already spent
    assert src.count("PlayerOperationTypes.") == src.count("PlayerOperationTypes.ADVANCED_START_USE_EFFECT")
    # two operations are reached by a literal name because their kind is not the operation (a
    # deactivation is CHANGE_TRADITION; an unassignment is ASSIGN_RESOURCE); nothing else may be
    assert sorted(set(re.findall(r'PlayerOperationTypes\["([A-Z_]+)"\]', src))) == ["ASSIGN_RESOURCE", "CHANGE_TRADITION"]
    stripped = src
    for a in MUTATION_ALLOWLIST:
        stripped = stripped.replace(a, "")
    leftovers = [v for v in violations(stripped) if "mutating or revealing calls" not in v]
    assert leftovers == []


def _perform_branch(kind: str) -> str:
    """The body of one KIND branch of perform.js, up to the next one."""
    src = (PAYLOAD_DIR / "perform.js").read_text(encoding="utf-8")
    start = src.index(f'if (KIND === "{kind}")')
    rest = src.index('if (KIND ===', start + 10)
    return src[start:rest]


def test_an_ordinary_move_never_sets_an_attack_or_unexplored_modifier():
    """Moving and attacking are different actions with different offers. A move that quietly carried
    the attack modifier would turn "walk here" into "kill whatever is here"."""
    move = _perform_branch("MOVE_UNIT")
    assert "Modifiers: 0" in move
    assert "UnitOperationMoveModifiers" not in move


def test_the_attack_modifiers_appear_only_in_the_attack_branch_and_never_declare_war_by_flag():
    src = (PAYLOAD_DIR / "perform.js").read_text(encoding="utf-8")
    attack = _perform_branch("ATTACK")
    # the attack modifier lives only in the attack branch (a guard and the argument); the ignore-
    # unexplored modifier also serves the merchant send, the shipped chooser's own fallback
    send = _perform_branch("SEND_MERCHANT")
    assert src.count("UnitOperationMoveModifiers.ATTACK") == attack.count("UnitOperationMoveModifiers.ATTACK") == 2
    flag = "UnitOperationMoveModifiers.MOVE_IGNORE_UNEXPLORED_DESTINATION"
    assert src.count(flag) == attack.count(flag) + send.count(flag) and attack.count(flag) == 2 and send.count(flag) == 2
    assert "UnitOperationMoveModifiers.ATTACK" not in send
    # and exactly one set of arguments is ever built from them
    assert attack.count("const meleeArgs") == 1
    assert not re.search(r"UnitOperationMoveModifiers\.(DECLARE_WAR|ROUTE_ALLOW_UNEXPLORED)", src)
