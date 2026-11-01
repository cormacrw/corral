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

`rebaseRequested` is dead: it stays only because dropping a column needs a human.
