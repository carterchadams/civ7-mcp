# Town focus and City conversion

**Use when:** Use when a Town can specialize or convert, or when rebalancing which settlements supply the empire and which operate production centers.

Needs to read: context, decisions, economy, growth, production, resources, rules, trade. Needs to execute (only if enabled): production.purchase, settlements.choose_focus, settlements.convert. Rules: R-PREVIEW, R-SPECIALIST, R-TOWN.

## Required situation

Read the Town’s population, legal focus choices, purchase catalog, current exports and recipients, net output, conversion cost and projected effects. Include any civilization-specific City limitation separately from the general Settlement Limit. Obtain effects on other settlements when a supplier or connection changes.

## Focus decision

Choose whether the Town should keep developing itself or supply a network now. Compare remaining useful growth opportunities with the benefit to connected recipients. A focus unlocked at a population threshold is an option, not an obligation to stop development immediately.

Select a focus by demonstrated use: agricultural support for Cities that can exploit the Food, mining/production conversion for an economic role, a defensive role on a threatened approach, a trading role that establishes a useful route, or another specialization with an actual effect in the current position. Check the real purchase unlocks and conditions. Labels alone are insufficient, and multiple focuses can support more than their name suggests.

## Conversion decision

Name the capability conversion buys: a needed production queue, an appropriate Wonder/project site, productive urban staffing, an otherwise unavailable purchase or another verified advantage. Then compare:

- Up-front Gold and the emergency reserve remaining afterward.
- Local yield changes and lost focus benefits.
- Changed Food or resource support to other settlements.
- Maintenance, capacity and any empire-wide economic side effects.
- Time to construct and use the new City’s intended infrastructure.

Convert the best candidate for the required job, not every Town or automatically the oldest Town. A mature support Town may be more valuable left in place than converted, even when its sticker price is low. Another Town with strong suitable land but no useful current role may be the better City.

## Role stability

After choosing, record the role and the next development step. Do not convert and then spend the new City’s first dozen decisions behaving exactly as though it remained a Town. Revisit the decision at an Age boundary or when the network changes; do not assume yesterday’s role survives intact.

## Failure and degraded mode

If the adapter exposes only `isTown` and population, it is not enough to recommend a confident focus or conversion. Request costs, connected recipients, purchase permissions and actual effects. In a supervised trial, flag conversion as irreversible until the live rules say otherwise.
