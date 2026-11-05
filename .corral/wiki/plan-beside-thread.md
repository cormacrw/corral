# The plan beside the thread

On desktop, `PlanConversation.vue` floats the session's latest plan as a card
to the right of the thread, so the conversation and the plan read together.
Phones keep `PlanPill` and `PlanSheets`; the Inbox's plan threads are unchanged.

**Layout.** The card is absolutely positioned over the log's wrapper, not
inside the scrolling log, so it stays put while the thread scrolls and never
changes the content `usePlanThreadScroll` measures. It is 340px wide with a
max height of the log, and `PlanDetail`'s body scrolls inside it when the plan
is taller. `PlanDetail` takes `card`, which drops its close and flyout back
buttons. The thread stays centred while the card fits to its right
(`margin-inline: auto max(364px, (100% - 768px) / 2)`), and moves left as
the column narrows.

**Narrow fallback.** The column's measured width (`useElementSize`) decides:
below 876px (a 480px thread, the card and margins) there is no card, and the
plan opens in the flyout as before, including on arrival for a proposed plan.
A task flyout opened beside a 1600px window still leaves room for the card.

**Links.** `?plan` is dropped once the card shows (the flyout closes it), so
an old link opens the page with the card. With the card shown, the chat's
"Open plan" link focuses the card instead of the flyout. Task rows open
`flyout.open(ref)` and parent headers `flyout.openEpic`. A plan's new tasks
are Draft tasks with refs from the moment it is proposed, so they open in the
normal task flyout with their criteria, dependencies and implementation plan;
no separate plan-task view is needed. The flyout has no plan to go back to.
