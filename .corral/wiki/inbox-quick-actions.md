# Inbox quick actions

Task Inbox quick actions always select the first action on item identity/type changes, including auto-advance: approve for human review, clarify for blocked/question, resolve (Retry) for failed. Clicking a selected chip preserves it. Both layouts use roving tabindex and wrapping arrow-key selection via `app/utils/radio.ts`.

The page owns default selection; mobile questions hide the chips and keep the Clarify composer answer flow. Activity and Plan threads retain their existing reply flows. Live refreshes of the same item must preserve a user's chosen action.
