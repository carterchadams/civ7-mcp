// Fixed realm and game-context probe. Executed by `doctor` on each CDP
// target. Read-only: no operation requests, no reveals, no writes.
// Every field is probed defensively so a non-game realm returns a
// well-formed result instead of throwing.
(() => {
  const has = (name) => {
    try {
      return typeof globalThis[name] !== "undefined";
    } catch (e) {
      return false;
    }
  };
  let inGame = null;
  try {
    inGame = has("UI") && typeof UI.isInGame === "function" ? UI.isInGame() : null;
  } catch (e) {
    inGame = null;
  }
  let localPlayerId = null;
  let localObserverId = null;
  if (has("GameContext")) {
    try {
      localPlayerId = GameContext.localPlayerID;
    } catch (e) {
      localPlayerId = null;
    }
    try {
      localObserverId = GameContext.localObserverID;
    } catch (e) {
      localObserverId = null;
    }
  }
  let turn = null;
  if (has("Game")) {
    try {
      turn = Game.turn;
    } catch (e) {
      turn = null;
    }
  }
  return JSON.stringify({
    probeVersion: 1,
    hasUI: has("UI"),
    hasGameContext: has("GameContext"),
    hasGame: has("Game"),
    inGame: inGame,
    hasPlayers: has("Players"),
    hasMap: has("GameplayMap"),
    localPlayerId: localPlayerId === undefined ? null : localPlayerId,
    localObserverId: localObserverId === undefined ? null : localObserverId,
    turn: turn === undefined ? null : turn,
    href: (typeof location !== "undefined" && location && location.href) ? String(location.href) : null
  });
})()
