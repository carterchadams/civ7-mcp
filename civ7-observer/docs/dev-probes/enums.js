// Developer-only. Read-only. Not a packaged payload.
JSON.stringify({
  ProgressionTreeNodeState: typeof ProgressionTreeNodeState === "undefined" ? null : ProgressionTreeNodeState,
  RevealedStates: typeof RevealedStates === "undefined" ? null : RevealedStates,
  DirectionTypes: typeof DirectionTypes === "undefined" ? null : DirectionTypes,
  PlayerIds: typeof PlayerIds === "undefined" ? null : PlayerIds,
  turn: Game.turn, localPlayerID: GameContext.localPlayerID, localObserverID: GameContext.localObserverID
})
