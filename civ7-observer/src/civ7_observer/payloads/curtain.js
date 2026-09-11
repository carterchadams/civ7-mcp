// UI-ONLY tidy-up for hotseat play. Sends no engine operation. Token substituted by the host:
// CURTAIN_MODE, a JSON string: "prune" removes every stale hotseat curtain instance but the newest
// (the stock component mounts one per turn activation and only a human click ever removes them);
// "raise" removes them all so the seat's play is visible. Both confirm the advisor council popup
// with nothing followed, the way the human would press its Confirm button.
(() => {
  const MODE = CURTAIN_MODE;
  const result = { payloadVersion: 1, refused: null, mode: MODE, curtainsBefore: 0, curtainsRemoved: 0, curtainsAfter: null, advisorPopup: { present: false, confirmed: false } };
  const refuse = (code, message) => { result.refused = { code: code, message: message }; return JSON.stringify(result); };
  let inGame, flags;
  try { inGame = typeof UI !== "undefined" && typeof UI.isInGame === "function" ? UI.isInGame() : undefined; flags = Configuration.getGame(); }
  catch (e) { return refuse("NOT_IN_GAME", "game context unavailable"); }
  if (inGame !== true) return refuse("NOT_IN_GAME", "UI.isInGame() is not true");
  if (!flags || flags.isHotseat !== true) return refuse("UNSUPPORTED_GAME_MODE", "curtain handling applies to hotseat sessions only");
  if (MODE !== "prune" && MODE !== "raise") return refuse("INVALID_ARGUMENT", "mode must be prune or raise");
  if (typeof document === "undefined") return refuse("API_CONTRACT_MISMATCH", "no document in this realm");
  const curtains = Array.from(document.querySelectorAll("hotseat-curtain"));
  result.curtainsBefore = curtains.length;
  const keep = MODE === "raise" ? 0 : 1;
  for (let i = 0; i < curtains.length - keep; i++) {
    try { curtains[i].remove(); result.curtainsRemoved += 1; } catch (e) { /* leave it; the count below tells the truth */ }
  }
  result.curtainsAfter = document.querySelectorAll("hotseat-curtain").length;
  const popup = document.querySelector("advisor-council-popup");
  if (popup) {
    result.advisorPopup.present = true;
    let label = "LOC_ADVISOR_COUNCIL_CONFIRM";
    try { const s = Locale.compose(label); if (typeof s === "string" && s) label = s; } catch (e) { /* keep the key */ }
    let button = null;
    for (const e of popup.querySelectorAll("[role=button]")) { if ((e.textContent || "").trim() === label) { button = e; break; } }
    if (button && typeof InputActionStatuses !== "undefined") {
      // the ui-next activatable fires onActivate on a finished keyboard-enter engine input
      button.dispatchEvent(new CustomEvent("engine-input", { bubbles: true, cancelable: true, detail: { name: "keyboard-enter", status: InputActionStatuses.FINISH } }));
      result.advisorPopup.confirmed = true;
    }
  }
  return JSON.stringify(result);
})()
