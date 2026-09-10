"""Static leak policy for every packaged JavaScript payload.

Live finding (docs/runtime-contract.md, hotseat): the debug API is omniscient across
seats. Seat binding is therefore enforced here, in code, not by the game. Any payload
that names another player, enumerates the player roster, or reads tile detail without
a visibility check must fail before it can ship.
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
    "mutating or revealing calls": r"\b(revealTree|revealAll|unlockTradition|sendRequest|PlayerOperations|UnitOperations|setResearch|purchasePlot|destroy)\b",
    "network / storage / timing": r"\b(fetch|XMLHttpRequest|WebSocket|localStorage|sessionStorage|indexedDB|setTimeout|setInterval|requestAnimationFrame)\b",
    "imports / eval": r"\b(import|require|eval|Function)\s*\(|^\s*import\s",
}


def violations(source: str) -> list[str]:
    found = []
    for label, pattern in FORBIDDEN_PATTERNS.items():
        for m in re.finditer(pattern, source, flags=re.MULTILINE):
            line = source.count("\n", 0, m.start()) + 1
            found.append(f"{label} at line {line}: {m.group(0)!r}")
    return found


def packaged_payloads():
    return sorted(p for p in PAYLOAD_DIR.iterdir() if p.name.endswith(".js"))


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
