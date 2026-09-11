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
    "mutating or revealing calls": r"\b(revealTree|revealAll|unlockTradition|sendRequest|sendTurnComplete|PlayerOperations\.(?!canStart\b)\w+|UnitOperations\.(?!canStart\b)\w+|CityOperations\.(?!canStart\b)\w+|CityCommands\.(?!canStart\b)\w+|UnitCommands\.(?!canStart\b)\w+|setResearch|purchasePlot|destroy)\b",
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
    'Game.UnitOperations.canStart(unitId, UnitOperationTypes.FOUND_CITY, foundArgs, false)',
    'Game.UnitOperations.sendRequest(unitId, UnitOperationTypes.FOUND_CITY, foundArgs)',
    'Game.CityCommands.canStart(cityId, CityCommandTypes.EXPAND, {}, false)',
    'Game.CityCommands.canStart(cityId, CityCommandTypes.EXPAND, expandArgs, false)',
    'Game.CityCommands.sendRequest(cityId, CityCommandTypes.EXPAND, expandArgs)',
    'Game.CityCommands.canStart(cityId, CityCommandTypes.CHANGE_GROWTH_MODE, gargs, false)',
    'Game.CityCommands.canStart(townId, CityCommandTypes.CHANGE_GROWTH_MODE, growthArgs, false)',
    'Game.CityCommands.sendRequest(townId, CityCommandTypes.CHANGE_GROWTH_MODE, growthArgs)',
    'Game.CityCommands.canStart(cityId, CityCommandTypes.PURCHASE, buyArgs, false)',
    'Game.CityCommands.sendRequest(cityId, CityCommandTypes.PURCHASE, buyArgs)',
    'GameSetup.setPlayerParameterValue(BOUND_PLAYER_ID, "AgeTransitionPlayerCivilization", civKey)',
    'Game.UnitCommands.canStart(unitId, UnitCommandTypes.PROMOTE, promoArgs, false)',
    'Game.UnitCommands.sendRequest(unitId, UnitCommandTypes.PROMOTE, promoArgs)',
)
MUTATION_FORBIDDEN = r"\b(PlayerOperationTypes\.[A-Z_]+|UnitOperationTypes\.(?!SKIP_TURN\b|MOVE_TO\b|FOUND_CITY\b)[A-Z_]+|CityOperationTypes\.(?!BUILD\b)[A-Z_]+|CityCommandTypes\.(?!EXPAND\b|CHANGE_GROWTH_MODE\b|PURCHASE\b)[A-Z_]+|UnitCommandTypes\.(?!PROMOTE\b)[A-Z_]+|sendUnreadyTurn|sendRetireRequest|sendPauseRequest|sendGameQuery|revealTree|unlockTradition|purchasePlot|destroy|Network\.)\b"
ENGINE_CALL = re.compile(r"(Game\.(?:PlayerOperations|UnitOperations|CityOperations|CityCommands|UnitCommands)\.(?:canStart|sendRequest)\([^)]*\)?|GameContext\.sendTurnComplete\(\)|GameSetup\.set\w+\([^)]*\))")


def violations(source: str) -> list[str]:
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
    assert "PlayerOperationTypes[OP_KIND]" in src and "PlayerOperationTypes." not in src
    stripped = src
    for a in MUTATION_ALLOWLIST:
        stripped = stripped.replace(a, "")
    leftovers = [v for v in violations(stripped) if "mutating or revealing calls" not in v]
    assert leftovers == []


def test_move_payload_never_sets_attack_or_unexplored_modifiers():
    src = (PAYLOAD_DIR / "perform.js").read_text(encoding="utf-8")
    assert "Modifiers: 0" in src
    assert not re.search(r"UnitOperationMoveModifiers\.(ATTACK|DECLARE_WAR|MOVE_IGNORE_UNEXPLORED_DESTINATION|ROUTE_ALLOW_UNEXPLORED)", src)
