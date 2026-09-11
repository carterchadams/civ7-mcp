# Report friction

**Use when:** you cannot make a good choice, or cannot advance the game, because a tool or a fact
is missing. Report it instead of guessing, stalling, or picking something arbitrary.

This card is not from the strategy guide. It exists because the action catalog and the observation
are deliberately incomplete and are being extended from real play: your reports are the list of
what to build next.

## When to report

- **missing_action**: the game needs a decision you have no tool for, or you can see a move worth
  making that no offered action expresses. Example: the turn is blocked on a decision the brief
  marks unsupported, or a settler is standing on a good site with no found-settlement action.
- **missing_information**: an option is offered but you cannot judge it. Example: choosing between
  two units to produce with no cost, no completion time, and no view of the city's needs; or
  moving a unit with no way to see whether the destination is dangerous.
- **unclear_option**: an option's label or fields do not say what it would do.
- **blocked**: you are stopped for any other reason a human should know about.

## How to report

Append one entry per distinct problem to `FRICTION.md` in your session directory, in this shape:

    ## <kind>: <what you were trying to achieve, in one line>
    needed: <the specific action, field or fact that would have let you decide>
    <optional detail, including what you did instead>

`kind` is one of the four above. Be concrete in `needed`: name the missing field or the action you
wanted, not "more information". Append; never rewrite earlier entries, which have already been read.

Then continue if you can, choosing the least committal legal option, and say in your report that
you did so. If you cannot continue, stop and say so.

## Rules

Report once per problem per turn, not once per option. Do not report a decision you simply find
hard: friction means missing capability, not difficulty. Never invent an action id or call a tool
that was not offered to you as a way around the gap.
