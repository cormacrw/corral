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
