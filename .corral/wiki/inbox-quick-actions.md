# Inbox quick actions

Task Inbox quick actions always select the first action on item identity/type changes, including auto-advance: approve for human review, clarify for blocked/question, resolve (Retry) for failed. Clicking a selected chip preserves it. Both layouts use roving tabindex and wrapping arrow-key selection via `app/utils/radio.ts`.

The page owns default selection; mobile questions hide the chips and keep the Clarify composer answer flow. Activity and Plan threads retain their existing reply flows. Live refreshes of the same item must preserve a user's chosen action.

Approval's optional note is sent as trimmed `text` in the shared desktop/mobile Inbox action. Nonblank notes become unpinned human comments inside the task, bug, spike or design approval transaction; blank notes add nothing. Design notes also reach the PM build session. Request changes keeps the existing single pinned feedback comment. Epic PR reviews use their separate action contract.
