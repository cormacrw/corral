# Epic fix tasks

Requesting changes on an epic PR, by the reviewer agent or the human, creates a
Ready task in the epic and sets the epic's `reviewState` to `changes_requested`
in one transaction. `feedbackPoints` and `feedbackFixTitle` in
`packages/core/src/review-feedback.ts` derive the criteria and title: list items
are the points, or paragraphs when the feedback has no list.

`changes_requested` is sticky. `invalidateEpicReview` leaves it alone, so the
fix task's own creation and other board changes can't downgrade it to `open`.
Only `EpicPullRequests.reconcile` leaves it, moving to `in_review` once every
board task has merged. That also covers a deleted fix task, at the same head, so
the epic can't get stuck.

Human approval requires `human_review`, so it returns 409 while changes are
outstanding. Corral has no epic PR merge path yet; when one is added it must
only accept `ready_to_merge`.

Tasks expose a persisted `kind` (`normal`, `fix`, `conflict`), independent of
`type`. Migration 0055 defaults both existing rows and ordinary new tasks to
`normal`; it does not infer kinds from historical titles. `createEpicFixTask`
sets `fix` for reviewer, human and CI feedback; the rebase hand-off sets
`conflict`. These are server-owned classifications, not editable task inputs.

The human's `epic.pr` / `human_changes_requested` audit record stores their
feedback in `summary`, the reviewed `headSha`, its `createdAt`, and a `fixTasks`
snapshot of the created tasks' IDs, refs and titles, in the same transaction as
the tasks and review-state change. Each request keeps its own record. Inbox
round-two context reads the latest record's links rather than matching titles
or creation times. Renaming or removing a task does not erase that link; older
audit records without links read as an empty list.
