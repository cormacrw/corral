# PR-free epic task state (COR-286)

Binding rules: D5, D24, D27, D28 in `docs/decisions.md`; section 4 of
`docs/flows.md`. COR-286 added persistence and negotiation; COR-287 added commit
submission and review; COR-288 added integration into the epic branch.

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

Merged on the PR-free path means confirmed integration into the epic branch;
same-epic dependents can then start. Other dependents wait for the epic PR to
merge. Approval or pending integration never means done.

## Human review at the epic (COR-289)

`applyTransition` clears the in-memory flag for `integrationProtocol > 0`, so
`review_approved` always lands in Ready to merge; the row keeps `humanReview`
and the criteria keep `checkedByHuman`. `humanObligations` in `epic-prs.ts` turns
those into the epic approval's obligations, for PR-free tasks only. The Inbox gets
them as `humanReview` and `humanChecks` on each `EpicReviewTask`. Approve must send
`confirmedCriteria` and `confirmedTasks` covering the board read under the epic
lock, or it's a 409 `human_checks_unconfirmed`, and the audit entry records them.
`met` stays null: confirming is the human's approval, not a verdict.

`Task.submission` carries the latest submission's commits with GitHub URLs, shown by
`TaskCommitLinks`. An integrated SHA is as recorded; a later epic rebase rewrites the
branch but GitHub still serves the commit.

## Integrating (COR-288)

`TaskIntegrator` (`apps/server/src/task-integration.ts`) runs in the merge pass.
The server decides and the runner does the git, in the bare clone
(`apps/runner/src/integration.ts`), so the reviewed task branch and worktree are
never touched. Only a runner saying `taskIntegrationExecutor` in its hello gets
these jobs, so a build that only submits and reviews is never asked.

Each epic has at most one active operation, enforced by the partial unique index
`task_integration_one_active_per_epic`, and tasks go oldest first. Each tick
rebuilds the position from the journal and the remote, so a restart loses nothing:

1. `pending`: the operation is written with the epic head it expects and a new
   `leaseEpoch`, before any git.
2. `running`: `integration_prepare` builds one commit on the expected head, a
   three-way merge of the task's own change, carrying the trailer
   `Corral-Submission: <submission id>`. Nothing shared moves. It answers `moved`,
   `conflict`, `empty` or `integrated` instead when that's what it finds.
3. The gate re-checks the task is still approved and in Ready to merge, then
   looks at required checks for that exact candidate. With required checks set,
   the candidate is on `corral/candidates/<operation id>` so push-triggered CI
   sees it. A failure goes to the developer (`ci_failed`). Pending waits, for up to
   an hour, then blocks. A check that hasn't appeared after three minutes doesn't run
   on such a commit (a PR-only workflow), so it's recorded as `checks_deferred` and
   left to the epic PR's merge gate. That's how task-only CI needs no task PR.
4. `reconciling` is written **before** `integration_push`: the result is unknown
   until read. The push is `--force-with-lease=<ref>:<expected>`, which GitHub
   evaluates, so a stale runner or stale clone can't overwrite anything.
5. `integration_inspect` fetches and searches the remote for the trailer. Only
   that puts the operation, the submission's `integratedCommitSha` and the task's
   `integrated` transition (with `mergeCommitSha`) in one transaction. What a push
   reported doesn't matter: a push that claimed success but left no commit fails
   the operation.

The trailer is what makes this exactly once. Prepare and inspect both look for it
first, so a retry after a lost answer, or a stale push landing behind a newer
operation, records the commit that's there instead of adding another. It survives
the epic branch being rebased, which a SHA wouldn't.

A moved branch ends the operation (`The epic branch moved`) and the next takes a
fresh head, up to five per pass. A conflict ends it and starts a D24 rebase-only
round: the developer reports `commit_submitted`, which is a new submission, and the
rebase review carries approval over. A clean three-way onto a moved epic is a
mechanical update and keeps its approval; the epic's integration review and CI
still see the result.

Failures are sorted by whose they are. A moved branch, an interrupted or cancelled
operation retries at once. A job the runner couldn't finish (a rejected prepare or
push: offline, timed out, fetch failed) doesn't count and retries on a later pass,
so an outage can't fail a task. Prepare only throws for that; a candidate it can't
build comes back as `failed`. Anything else counts, one per pass, and three fail
the task. A push git itself refused looks the same as any other refusal and counts.

Pausing the task or project stops `#prepare` and the gate before the push, leaving
the operation where it is to carry on later. Reconcile still runs: it only reads,
and a commit already on the branch is a fact. A task sent back during its push lands
anyway: the commit stands, the task stays open and gets a comment.

The kill switch and update hold (`stopped`) are held the same way, but read again
at each wait, because a tick's own check can be minutes old: at the start of
`#prepare` and the gate, after the CI lookup (so a verdict read during a stop waits
too), and right before `integration_push`. A stop that lands after the `reconciling`
journal write restores `running` and the original `updatedAt`, since nothing was
sent. An operation left `running` resumes through reconcile on the next pass, which
re-enters the gate with the same candidate.

Dependents: `claim.ts` treats a dependency on a build task in another epic as met
only when that epic is done, and `publishEpicDependents` wakes those tasks when the
epic PR merges. Same-epic dependents wake on Merged through `publishDependents`.
