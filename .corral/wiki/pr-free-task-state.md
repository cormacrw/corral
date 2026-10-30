# PR-free epic task state (COR-286)

Binding rules: D5, D24, D27, D28 in `docs/decisions.md`; section 4 of
`docs/flows.md`. COR-286 added persistence and negotiation; COR-287 added commit
submission and review. The integration executor is still to come.

`tasks.integrationProtocol = 0` preserves all existing paths. The additive
0051 migration changes no branches, PR links, review/evidence rows or epic
modes. `recordTaskSubmission` in `apps/server/src/task-submissions.ts` selects
protocol 1 only for ordinary epic-mode build tasks without PRs, recording a
versioned submission and its base/target atomically. It rejects direct,
standalone, each_task, spike, design and epic conflict submissions.

`task_submissions` records submitted, agent-approved and integrated commits
without a PR FK. Approval must match the submitted head. Integration needs
approval plus a commit and timestamp. `task_integration_operations` journals
expected target SHA, runner, lease epoch and result/error; only one operation
per submission can be active. The executor must write intent before git,
fence the target ref and reconcile unknown results before retrying. Database
constraints protect shape; they do not replace executor authorization, lease
checks or remote confirmation.

Hello's optional `taskIntegrationProtocols` is independent of envelope version
3. Missing means legacy only. Welcome and runner status explain how to update;
claim placement and dispatch both reject unsupported requirements. Existing PR
work stays available.

## Submitting and reviewing (COR-287)

`#authorJob` calls `selectPrFreeProtocol` for a developer run placed on a runner
advertising protocol 1, so the prompt, job and report agree from the first run.
Selection is skipped when GitHub shows, or can't rule out, an open PR on a branch
that already existed (a PR whose number was lost in a crash), or when the epic PR
has merged. A legacy runner's run stays on the PR path. Once selected the task
can't change epic or type (409), because the database check and its submissions
depend on them.

The outcome is `commit_submitted`, for first submissions, revisions and
rebase-only rounds alike. The server rejects it on PR-path tasks and rejects
`pr_*` on selected ones. The runner pushes the task branch (never the epic
branch), then sends `headSha` and `baseSha`, the merge base with the epic branch.
`#submitCommit` applies the usual branch and evidence checks, refuses a head equal
to its base, and records the transition, submission, note and run end in one
transaction. No GitHub PR call is made.

The reviewer job gets the latest submission's commit, base and target plus earlier
submissions. The runner reports the reviewer checkout's real HEAD as `headSha`,
replacing anything the agent passed. `#review` rejects a verdict whose head differs
from the task head (on every path, when present). On the PR-free path it also
requires that head, requires the live branch and the latest submission to match,
and records `agentApprovedHeadSha` with the approval. A rejected verdict leaves the
task in Agent review with the lease held; the reviewer reports failed if the head
won't come back. D26 applies unchanged: the gates section follows the project's
`requiredChecks`. With checks set, its wording says CI runs on the push and the
epic PR's CI is the merge gate, since no merge gate covers the task commit itself.

Revisions add a submission on the same branch. Comments, reviews and evidence
rows are never rewritten; `get_task` returns all of them with `submissions`, and
the reviewer prompt lists earlier submissions. Stopped-run recovery is unchanged.

`merge.ts` skips a Ready to merge task with no PR, so approved work waits there
until the integration executor lands. Nothing marks it Merged.

Merged on the PR-free path means confirmed integration into the epic branch;
same-epic dependents can then start. Other dependents wait for the epic PR to
merge. Approval or pending integration never means done. Human review flags
and checked-by-human criteria retain D5/D28 routing before integration.
