# Epic rebases

Epics are parent tasks' delivery records now ([D31](parent-tasks.md)). This page uses the code's word.

`EpicSynchronizer` (`apps/server/src/epic-sync.ts`) keeps an epic branch on its
target (D27, COR-290). It runs inside `TaskIntegrator`'s per-epic pass, so a
checkpoint is the moment between two integrations. Don't start a rebase from
anywhere else: `EpicMerger` and `EpicPullRequests.reconcile` only wait, and the
integrator's `due()` list brings a finished epic to the checkpoint.

A rebase is a `task_integration_operations` row of kind `rebase`, with no
submission. The one-active-per-epic index is the writer lock, so anything that
writes the epic branch or relies on its head checks `activeRebase` or takes a
row in that table. That covers review claims, human actions, task PR merges and
the epic merge.

A conflict before the final checkpoint isn't resolved at all (COR-445). `#defer`
ends the operation as `failed` with `CONFLICT_DEFERRED`, so the lock goes and
nothing runs. Resolving one earlier costs a run each time the target moves, and
the target usually moves again before the epic lands.

Pending has no column: `deferredConflicts` reads the epic's newest `rebase` row, so
any later rebase or fix ends it by being newer. A deferred row isn't a failure
(`NOT_FAILURES`). `begin` skips a retry on the same head and target unless the
epic has reached `finalCheckpoint`, since those commits would conflict the same
way. Approval is refused during an active rebase, so the state `#prepare` reads
can't go stale in the unsafe direction: an approval just after `#defer` is seen by
the next `begin`.

`startReview` normally waits for a head on top of the target. It lets a deferred
head through when the row is for that head and the current target, or review
would wait on a rebase that waits on review. A moved target goes back to a
checkpoint first, since it may have removed the conflict. `finalCheckpoint` also
needs the approved head, because any other head is about to lose approval.

A hand rebase or GitHub's update branch leaves no row of ours, so `begin` marks
the deferred row `CONFLICT_GONE` when the head is no longer behind.

`EpicMerger` is what stops a conflicted epic merging: it checks the head isn't
behind in `#advance`, and again in `#merge` just before asking GitHub, because the
target can move in between. Being behind there isn't a refused merge, so it costs
no attempt. A checkpoint needs a waiting task or a complete epic, and
`due()` goes through the `Backoff`, so a test expecting one uses `t.mergePass()`.

While a conflict is being resolved the operation stays `running` with `fix` set
to `conflict` and a developer run on the epic (D29, [epic fixes](epic-fix-tasks.md)).

A resolution task from before D29 keeps its old path: `resolutionTaskId` is set,
and nothing creates one any more. The task's branch prefix (`corral/epic-rebase/`) is how
the rest of the server recognises it: `isEpicResolution`, which keeps it off the
PR-free path and out of the merge pass. `MergeOrchestrator` must not settle it,
because only the synchronizer's publish makes it Merged.

A resolution task never outlives its operation. `#fail` deletes it and its
candidate branch, ending any run on it, because a Ready to merge resolution with
no operation would hold the board with nothing to publish it.

A resolution that hits the failed-run cap stays on Failed for a human, whose
**Retry** resumes it, and it keeps the writer lock. Nobody retries an old problem
for ever, though, so once the target has moved past its `ontoSha`,
`#outdateFailed` ends the operation and the next checkpoint rebases onto the
current target with a new task and a fresh run count. Failures are counted per
commits, so each target only pays for itself. The Failed task and its candidate go,
as with any `#fail`.

The clock for pause is the moment of the write, not the start of the step:
preparing can take minutes, so `#publish` and the conflict path read the project
again. A conflict found while stopped goes back to `pending` and prepares again.

A closed PR sits at `reviewState` `open`, the same as an open one that lost its
approval, so only GitHub can tell them apart. `begin` reads the PR, after the
behind check so an up-to-date epic pays nothing, and `#publish` reads it again
because a resolution can take hours. Nothing is recorded: `closedPoll` keeps
watching for a reopen in `EpicPullRequests.reconcile`, and the next look finds
the PR open and carries on. A plain integration is still allowed, since a
fast-forward doesn't stop a reopen.
A resolution run already going when the PR closes is left to finish: its result
just can't be pushed until the PR reopens.

`begin` reads GitHub three times, so the `due()` list goes through a `Backoff`
per epic, doubling from 30 seconds to 2 minutes. Only `due()` obeys it: a task
waiting to integrate still gets a checkpoint on every pass, and the wait starts
over after each rebase. It's kept in memory like the merge pass's, so a restart
just looks sooner.

`targetChanges` compares with `--no-renames` but reads the target's renames
separately with `-M`. Without that, a rebase that correctly followed a rename
looks like an edit of a target-only file, and it fails the same way on every
retry.

An epic can force an edit to a file only the target changed: main adds a test
reading `i.project.id`, the epic makes `project` nullable, and no candidate can
pass the gates without `i.project?.id` (COR-431). So `candidateProblem` refuses
such a change outright only when `reviewed` isn't set on the push. `#awaitResolution`
sets it when `resolutionReview` is on this exact commit, so clean candidates
and anything no reviewer approved stay refused, as do merge commits, a wrong base
and an undone rename, whatever the review said. Git never touches these
files by itself, so a clean candidate refused here is a Corral bug.

What makes `reviewed` mean something is that the reviewer saw the changes.
`reviewerJob` asks the runner with `epic_rebase_inspect`, which runs the same
`targetChanges` as the guard, so the prompt lists exactly what the guard would
refuse, with diffs cut at 20,000 characters. It can't come from GitHub's compare,
which gives up at 300 files and detects renames its own way. A runner that can't
answer raises a transient `EpicBranchError`, so the review waits instead of
failing a run; no review means no approval, so nothing is skipped.

The prompt says approving such a change means `preservesApproval: false`. If a
reviewer says true anyway, `approvalFate` still drops approval, since the file is
outside the conflicts.
The mixed-workflow case "drops approval for a target-only edit even when the
reviewer says it preserves approval" exercises that safety check through publish
and asserts the recorded outside-conflicts reason.

`step` works from the journal alone after a restart. `running` with a result and
its runner online pushes again; `running` with neither was cut off, and that
retries at once; `reconciling` reads the branch.

A clean candidate exists only in the runner's bare clone, so its push goes to
`operation.runnerId`. A resolution's is on the remote, so any runner will do.

Rebasing takes a task's recorded `baseSha` out of the epic's history. Integration
copes by merging against a synthetic commit parented on that base
(`buildCandidate`). A task branch cut before a rebase but submitted after gets
the old fork point as its base, so its diff includes the epic's old commits, and
it may come back with `base_conflict` when a resolved file differs.

## Approval

`approvalFate` (`epic-rebase-approval.ts`) is the one place that decides what a
published head inherits. It runs in `#complete`, on the journal row returned by
the state change, so a stale copy can't decide. Everything starts from
`prHeadSha === expectedTargetSha`: a head that reached the branch any other way
fails there, and `EpicPullRequests.reconcile` drops approval when it sees a head
it didn't record. That comes after the behind check, because a PR read just after
Corral's push can show the old head, and that must not cost the approval.

`approvedHeadSha` stays on the commit approval was given on, so the history can
name it after several rebases; `prHeadSha` is what approval is on now. Every
path out of an approved state must clear the snapshot.

A fix's verdict is `behaviourChanged` on the operation's report, bound to the
reported commit like `resolutionReview`. `approvalFate` reads it for an operation
with `fix` set; the review path below is for old resolution tasks.

A resolution task doesn't invalidate review (`keepEpicReview`). Any other new
board task does, and it would otherwise wipe the approval the rebase protects.

The server's compare runs in `#checkResolution`, before the push, because the
old head may not be reachable afterwards. It goes onto `resolutionReview`, which
is bound to the reviewed commit, so a later revision can't reuse it.

`approvalFate` fails closed: a review with no compare on record doesn't carry.
`#checkResolution` reads the operation itself, because the pass's copy can
predate the review that made the task Ready to merge.

Decisions live on `operations.decisions`. An epic fix has no task to block, so its
question is an `epic_conflict` Inbox item. For a resolution task `waitingOn` is the
only reading of "open": the newest, unanswered, and what the task is Blocked on now. A resolution's `stuck` or `blocked`
is refused without one. `waitingDecision` makes it a `question` in the Inbox,
and `clarify` on one becomes a written decision. An answer that isn't an
alternative keeping behaviour, or a question closed from the board, never
carries approval.

`rebaseRequested` is dead: it stays only because dropping a column needs a human.

## Testing the whole workflow

`apps/server/src/mixed-workflow.test.ts` drives agents over the WebSocket against
real git, with GitHub's merges and branch updates as real git operations. Each test
gets its own app and repository. The operator guide
(`docs/operations/epic-rollout.md`) describes what it proves, and the suite runs
its journal query, so change them together.

`TestApp.restart()` is a crash, not a shutdown. The old process's database view
is dead from that moment, so the `#fail` a dropped job would trigger can't write,
and a test sees the journal as a real crash leaves it. Kill the process before
closing the runner's socket: the disconnect is what wakes the old pass.

Code in a transaction must read through `tx`. On Postgres a stray `db` read just
takes a second connection; on PGlite it hangs for good, because there's only one.
