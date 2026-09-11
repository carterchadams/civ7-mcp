// THE ONLY MUTATION PAYLOAD. Executes one pre-validated operation for the bound player.
// Tokens substituted by the trusted host: BOUND_PLAYER_ID, ALLOWED_MODE, OP_KIND (a JSON string
// from a fixed enum), OP_ARG (an integer), EXPECTED_TURN, EXPECTED_AGE. No other input reaches it.
// Guards run first; the native canStart query runs immediately before sendRequest; nothing is
// retried here. tests/test_payload_policy.py holds this file to an exact engine-call allowlist.
(() => {
  const ALLOWED = ALLOWED_MODE;
  const KIND = OP_KIND;
  const ARG = OP_ARG;
  const result = { payloadVersion: 1, refused: null, context: null, outcome: null, readback: null };
  const refuse = (code, message, extra) => { result.refused = Object.assign({ code: code, message: message }, extra || {}); return JSON.stringify(result); };
  const isInt = (v) => typeof v === "number" && Number.isInteger(v);
  const isBool = (v) => typeof v === "boolean";
  const curtain = () => { try { return typeof document !== "undefined" ? document.getElementById("hotseat-screen-curtain") !== null : null; } catch (e) { return null; } };

  // ---- guards (same as observe.js) plus the expected-context check
  let turn, age, lp, lo, flags, inGame;
  try { inGame = typeof UI !== "undefined" && typeof UI.isInGame === "function" ? UI.isInGame() : undefined; turn = Game.turn; age = Game.age; lp = GameContext.localPlayerID; lo = GameContext.localObserverID; flags = Configuration.getGame(); }
  catch (e) { return refuse("NOT_IN_GAME", "game context unavailable"); }
  if (inGame !== true) return refuse("NOT_IN_GAME", "UI.isInGame() is not true");
  if (!isInt(turn) || !isInt(age) || !isInt(lp) || !isInt(lo)) return refuse("NOT_IN_GAME", "turn, age or seat identity missing");
  if (lp !== BOUND_PLAYER_ID || lo !== BOUND_PLAYER_ID) return refuse("WRONG_PLAYER", "bound player " + BOUND_PLAYER_ID + " is not the local seat (localPlayerId=" + lp + ", localObserverId=" + lo + ")");
  if (turn !== EXPECTED_TURN || age !== EXPECTED_AGE) return refuse("ACTION_EXPIRED", "game turn/age differ from the offer's (turn " + turn + ", expected " + EXPECTED_TURN + ")");
  for (const k of ["isHotseat", "isLocalMultiplayer", "isNetworkMultiplayer", "isInternetMultiplayer", "isLANMultiplayer", "isAnyMultiplayer", "isPlayByCloud"]) {
    if (!isBool(flags[k])) return refuse("UNSUPPORTED_GAME_MODE", "game mode flag " + k + " is not a boolean");
  }
  const networked = flags.isNetworkMultiplayer || flags.isInternetMultiplayer || flags.isLANMultiplayer || flags.isPlayByCloud;
  const mode = (!flags.isAnyMultiplayer && !networked) ? "singleplayer" : (flags.isHotseat && flags.isLocalMultiplayer && !networked) ? "local-hotseat" : "unsupported";
  if (mode !== ALLOWED) return refuse("UNSUPPORTED_GAME_MODE", "game is " + mode + " but the service allows only " + ALLOWED);
  let player; try { player = Players.get(BOUND_PLAYER_ID); } catch (e) { player = null; }
  if (!player || player.isValid === false) return refuse("WRONG_PLAYER", "bound player object is invalid");
  if (player.isTurnActive !== true) return refuse("TURN_NOT_READY", "bound player's turn is not active");
  result.context = { turn: turn, age: age, playerId: BOUND_PLAYER_ID, localPlayerId: lp, localObserverId: lo, mode: mode, isTurnActive: true, curtainDisplayed: curtain() };

  // ---- execute exactly one operation
  if (KIND === "END_TURN") {
    const blockingType = Game.Notifications.getEndTurnBlockingType(BOUND_PLAYER_ID);
    const none = typeof EndTurnBlockingTypes !== "undefined" ? EndTurnBlockingTypes.NONE : null;
    const blockerName = (v) => { for (const k of Object.keys(EndTurnBlockingTypes)) if (EndTurnBlockingTypes[k] === v) return k; return String(v); };
    if (!isInt(blockingType) || !isInt(none)) return refuse("API_CONTRACT_MISMATCH", "end-turn blocking contract unavailable");
    if (blockingType !== none) return refuse("ACTION_BLOCKED", "a notification blocks ending the turn", { blockingType: blockerName(blockingType) });
    if (GameContext.hasSentTurnComplete() === true) return refuse("ACTION_BLOCKED", "turn completion was already sent", { blockingType: null });
    GameContext.sendTurnComplete();
    result.outcome = "sent";
    result.readback = { kind: KIND, arg: 0, sentComplete: GameContext.hasSentTurnComplete() === true };
    return JSON.stringify(result);
  }
  if (KIND !== "SET_TECH_TREE_NODE" && KIND !== "SET_CULTURE_TREE_NODE") return refuse("UNKNOWN_ACTION", "unsupported operation kind");
  if (!isInt(ARG)) return refuse("UNKNOWN_ACTION", "operation argument is not an integer");
  if (!isInt(PlayerOperationTypes[OP_KIND])) return refuse("API_CONTRACT_MISMATCH", "operation type unavailable");
  const args = { ProgressionTreeNodeType: ARG };
  const check = Game.PlayerOperations.canStart(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND], args, false);
  if (!check || check.Success !== true) return refuse("ACTION_NOT_STARTABLE", "native canStart refused the operation");
  Game.PlayerOperations.sendRequest(BOUND_PLAYER_ID, PlayerOperationTypes[OP_KIND], args);
  result.outcome = "sent";
  let observed = null;
  try { observed = (KIND === "SET_TECH_TREE_NODE" ? player.Techs : player.Culture).getResearching().type; } catch (e) { observed = null; }
  result.readback = { kind: KIND, arg: ARG, observedType: isInt(observed) ? observed : null, matches: observed === ARG };
  return JSON.stringify(result);
})()
