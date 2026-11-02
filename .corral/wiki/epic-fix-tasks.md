# Epic fixes and fix tasks

D29 splits epic fixes in two. A human's Request changes is new work, so it's a
task. Conflicts, CI failures and integration review changes are developer runs on
the epic, with no task.

## Developer runs on the epic

Each fix is a `rebase` row in `task_integration_operations` with `fix` set to
`conflict`, `ci` or `review`, so it's on the same writer lock, and everything that
checks `activeRebase` waits for it. `EpicSynchronizer` drives it like a rebase. A
new kind of operation would have meant teaching every lock check about it.

The run has `epicId` and `operationId` and no task. Code that sees `ctx.run.epicId`
must also look at the role: a developer run isn't an integration review. The
candidate is `corral/epic-rebase/<operation>`. For `ci` and `review`, `ontoSha` is
the epic head, so the publish check holds the fix to the head it's fixing.

A CI fix with `behaviourChanged: false` keeps approval while the PR's head can read
stale just after the push. The merge pass must not take that as an unknown head,
so `startReview` compares with the branch before it drops approval.

A fix has no reviewer before it publishes, so the push guard's target-only rule
(`epic-rebases.md`) lets an edit through only on a review fix or one reported with
`behaviourChanged: true`: those send the epic back to integration review.

`fixAttempts` counts refused publishes, failed developer runs and non-human
interruptions (including lease expiry, runner shutdown and reconnect loss). The
run's conditional terminal write counts each interruption once, so a replayed
exit cannot count it twice. A human Stop instead sets `syncError` immediately,
holding the operation until Retry; its saving-work heartbeats keep push permission
until a newer run starts or the operation ends. Three set `syncError`. Completed CI fixes (three) and review fixes
(`reviewRoundCap`) since the last Retry are bounded too, and the next one's
operation opens stopped. Retry resets all of them.

A review fix ends with the epic back in integration review, like any behaviour
change. An integration review can't report while an operation is active: its
verdict is stale, and the review runs again.

## Fix tasks

A human's Request changes creates a Ready task in the epic and sets `reviewState`
to `changes_requested` in one transaction. `feedbackPoints` and `feedbackFixTitle`
in `packages/core/src/review-feedback.ts` derive the criteria and title: list items
are the points, or paragraphs when the feedback has no list.

`changes_requested` is sticky. `invalidateEpicReview` leaves it alone, so the fix
task's own creation and other board changes can't downgrade it to `open`. Only
`EpicPullRequests.reconcile` leaves it, moving to `in_review` once every board task
has merged. That also covers a deleted fix task, at the same head, so the epic
can't get stuck.

Human approval requires `human_review`, so it returns 409 while changes are
outstanding.

A stopped epic is a Needs you item (D11): `waitingEpics` selects on `syncError`, so the Inbox and its count agree with the epic, and `sync_failed` is its arrival. It's an `epic_conflict` item with `stopped` set, and its Retry is the same `rebase` action as the epic page's.

## CI output

`githubLog` (`apps/runner/src/jobs.ts`) streams the job log through `CiLogScanner` (`apps/runner/src/ci-log.ts`) rather than holding it: `exec`'s `onStdout` skips `MAX_OUTPUT_CHARS`, so only the last `tailChars`, the bounded `failureLines` and a tail per package stay in memory. CI logs run past 30M characters.

In CI, turbo groups passing packages under `##[group]pkg:task`, but a failing package can start with a bare `pkg:task` line and run ungrouped until the next group. Its failure can sit far ahead of the log's end. The scanner recognises both section starts, and preserves the lines before `[ELIFECYCLE]` as well as the section's end. A failing package can print `[ELIFECYCLE]` twice, the first right after turbo's `ERROR run failed` and the second hundreds of thousands of lines later at its true exit, so the last one is what counts. `FAIL` blocks have a separate budget from progress verdicts such as `×`; only `FAIL` gets context, excluding passing test lines. `Failed:    pkg#task` near the end names which section to keep; locally turbo prefixes lines with `pkg:task: ` instead, and the scanner reads both. `--allow-escape-sequences` goes on this request only, with one retry without it for a `gh` too old to know the flag. `ciExcerpt` strips the colours on the server.
