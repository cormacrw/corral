# Epic rebases

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

While a conflict is being resolved the operation stays `running` with
`resolutionTaskId` set. The task's branch prefix (`corral/epic-rebase/`) is how
the rest of the server recognises it: `isEpicResolution`, which keeps it off the
PR-free path and out of the merge pass. `MergeOrchestrator` must not settle it,
because only the synchronizer's publish makes it Merged.

A resolution task never outlives its operation. `#fail` deletes it and its
candidate branch, ending any run on it, because a Ready to merge resolution with
no operation would hold the board with nothing to publish it.

The clock for pause is the moment of the write, not the start of the step:
preparing can take minutes, so `#publish` and the conflict path read the project
again. A conflict found while stopped goes back to `pending` and prepares again.

`candidateProblem` compares with `--no-renames` but reads the target's renames
separately with `-M`. Without that, a rebase that correctly followed a rename
looks like an edit of a target-only file, and it fails the same way on every
retry.

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

A resolution task doesn't invalidate review (`keepEpicReview`). Any other new
board task does, and it would otherwise wipe the approval the rebase protects.

The server's compare runs in `#checkResolution`, before the push, because the
old head may not be reachable afterwards. It goes onto `resolutionReview`, which
is bound to the reviewed commit, so a later revision can't reuse it.

Decisions live on `operations.decisions`. A resolution's `stuck` or `blocked`
is refused without one. `waitingDecision` makes it a `question` in the Inbox,
and `clarify` on one becomes a written decision. An answer that isn't an
alternative keeping behaviour, or a question closed from the board, never
carries approval.

`rebaseRequested` is dead: it stays only because dropping a column needs a human.
