# Epic review endpoint

`GET /epics/:id/review` (`apps/server/src/epic-review.ts`) returns `EpicReview`,
what the human needs to judge an epic as a whole. Nothing is stored: the PR,
checks, target movement and diff are read live from GitHub on each request, so
an offline runner is 503, as it is for `readPullRequest`. Actions stay on
`POST /epics/:id/review`, and `headSha` here is what that needs. Unknown epics
are 404. `direct` epics are 409 `invalid_input` with a readable message.

`pr` is `readPullRequest`, with its cap, or null before the epic has a PR, which
also leaves every `gateChecks` entry `missing`. `gateChecks` is the project's
required checks on the epic head. `targetMovedBy` is `behindBy(target, head)`,
and 0 once merged, when a squash leaves the old head behind for good.

A row's `reviewedBy` is `human` when the task has a `task.transition` audit entry
for `human_approve`, because that's all a human approval writes: `reviews` only
holds agent verdicts. It's `reviewer` for an approved review, else null.
`seenByHuman` counts the `human` rows, so a PR-free task never counts: its human
checks wait for the epic's approval and show in `humanReview` and `humanChecks`.
`humanChecks` holds criterion IDs, with their text in the row's `criteria`.
`criteriaMet` counts a human-checked criterion as met once the human approved the
task, since such a criterion has no verdict.

`lastFeedback` reads the latest `human_changes_requested` record. Its `files` are
capped like a PR's. Two heads are compared directly while the reviewed head is
an ancestor of the current one. After a rebase, a direct compare would list
everything back to their merge base, including the target's changes, so each
head's own change against the target is compared with `changeOf` from
`rebase-review.ts`. A patch in that case is the file's whole change on the epic,
not the change since the review. When GitHub can't give the diff, `files` is
empty, `truncated` is true, and `diffUrl` points to the comparison.

The prototype serves the same shape from `epicReview` in its fixtures.
