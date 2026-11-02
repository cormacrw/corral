# Parent review in the Inbox

Code and branch names still say epic: see [Parent tasks](parent-tasks.md). The `epics` row is a parent's delivery record.

`InboxEpicPanel` renders every parent item: `epic_review`, `epic_conflict` and `epic_activity`. It reads `GET /api/epics/:id/review` (`apps/server/src/epic-review.ts`), which is live from GitHub, so it answers 503 with the runner offline. The item alone still carries the tasks and human checks owed, so approval works when the review can't load; the Tasks tab falls back to the item's tasks.

The panel builds its own `InboxPanelContext` so `InboxPanelTray` and `InboxPanelThumbBar` work unchanged. Only the fields those two read are real.

Parent history has its own `epic_activity` type with no task, so a parent with no tasks left still has a history. `ActionableInboxItem` excludes it, so it never counts in Needs you.

`getEpicReview` reports `conflictPending` from the deferred rebase row (D27); it isn't a Needs you item. `conflictTaskRef` is only ever set by a task from before D29, since conflicts now run with no task.

Review rounds live in `epic_review_rounds`, one per reporting run, with structured findings. A review from before that table has a summary in the item and no rounds, so its Review tab is absent.
