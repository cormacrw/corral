# Task PR bases

Tasks in `epic` and `each_task` parents branch from and open PRs against the
stored parent branch (`corral/epic-<id>-<slug>`). The server creates that branch
from the project's configured target tip before assigning the first developer.
Concurrent claims tolerate an already-created GitHub ref without resetting it.
If preparing the branch fails (GitHub error, missing target branch), the run
fails at once with `Could not prepare epic branch <branch>: <cause>`, releasing
its lease and counting towards the failed-run cap. The scheduling pass skips that
task for the rest of the pass and keeps assigning other work.

`RunJob.baseBranch` carries this base separately from `defaultBranch`, which
continues to mean the project's target. Fresh developer worktrees start at the
base; revisions keep their existing branch. Reviewer prompts and merge conflict
instructions use the same base. GitHub's PR rebase and squash merge therefore
operate on the parent's branch. Merging still marks the task Merged and wakes its
dependants through the existing task flow.

Every task in `each_task` mode requires human review, regardless of its own flag.
In `epic` and `direct` modes the flag applies normally. Tasks without a parent and
`direct` task PRs use the target branch. Designs and spikes retain their separate
non-merge workflows.

The focused server scenarios in `apps/server/src/task-base.test.ts` use `develop`
as the target and exercise assignment, PR submission, approval, merge, dependency
claims and conflicts. Runner workspace tests use real local git commits to check
that a new task starts at the parent tip. These tests use a simulated GitHub; they
do not create remote branches or PRs.

## Changing the review mode

`PATCH /api/epics/:id` takes `reviewMode` until `reviewModeLocked`: the parent has a
PR, or any of its tasks, deleted ones included, has a PR or is Merged. It's a 409
after that. Plan revisions set `reviewMode` directly and aren't checked here.
Because `taskBase` resolves at every boundary, a task already running follows the
new mode when it opens its PR; `#submit` prepares the parent's branch if there's none,
and a parent branch left by moving to `direct` stays on GitHub, unused.

## Parent PR integration review

Once every non-deleted board task is Merged, the scheduler opens (or recovers)
the parent's branch's PR into the configured target. Drafts and Backlog tasks don't
hold it back. The PR body links each board task's PR and evidence page.

Parent integration reviews are reviewer runs with `runs.epicId` and no task ID,
placed like any other run on a runner that takes the reviewer role and has a
free slot; without one the parent stays `in_review` for the next pass.
Their detached checkout is the parent PR head, their diff base is the project's
target, and their prompt includes the parent goal plus every board task's criteria
and evidence. They rerun lint, typecheck, tests and build without cached results,
checking how the tasks fit together rather than re-judging individual evidence.
`get_task` returns the whole parent; `get_evidence` can fetch any of its task items.
Run leases, runner ownership, concurrency, usage cooldowns and update holds apply.

The parent's `in_review` state means agent integration review. Approval at the
current head moves it to `human_review`, which alone produces an Parent PR Needs
you item. The Inbox displays all board tasks and their evidence together. Human
Approve records `ready_to_merge`; merging is a separate step. Agent or human
Request changes creates a Ready fix task with the feedback as description and
criterion, and returns the parent PR to `open`. When fixes merge the same PR gets
a new integration review.

Moving a Draft or Backlog task onto the board, or moving a board task between
parents, resets pending parent approval to `open` inside the same transaction and
interrupts any active integration run. Merely adding Backlog work doesn't.
Reporting a verdict checks board completion and the live GitHub head again;
human actions also carry the head shown in the Inbox, so stale approvals fail.
A changed parent PR head likewise starts fresh integration review.

## Merging an approved parent PR

`EpicMerger` (`apps/server/src/epic-merge.ts`) runs in the merge pass. It reads
every open parent PR, so a PR merged by hand still counts, and advances only
`ready_to_merge` ones. It compares the head with the target through the compare
API first: `mergeable_state` says `behind` only under branch protection that
requires it, and CI doesn't run on a conflicting PR, so this can't wait for CI.

A moved target waits for the synchronizer, which runs earlier in the same pass
([epic-rebases.md](epic-rebases.md)); `EpicMerger` never rebases.

A conflict task handed off before rebases were automatic has the parent's branch
as its `branch`, and `isEpicRebaseTask`
is how the rest of the code recognises it: `taskBase` answers the target branch,
`#submit` opens no PR, and once approved the merge pass marks it Merged, since
the push already put the work on the parent's branch. The moved head then restarts
integration review.

With required CI checks, the task text and `epicRebaseDeveloperPrompt` have the
developer squash the parent's branch into one commit on its merge base with the
target, rebase that, resolve the conflicts and report. The squash means each
conflict is resolved once, and parent PRs squash on merge anyway. The squashed
message carries every commit's message, because `findIntegrated` greps the parent
branch for `Corral-Submission:` trailers to keep integration exactly-once. It
squashes commits, not migration files, so the rule against squashing migrations
still holds.

That prompt forbids the gates and any second fetch, overruling the role
instructions. CI failures after the push come back through the parent CI failure
path, and a moved target is the parent merge pass's job. With no required checks
the task gets the ordinary developer prompt and text, which run the gates. The
two are chosen separately, from `requiredChecks` when the task is created and
when each run is assigned.

Parent PRs always squash, so `project.mergeMethod` applies only to task PRs. An
parent is done for D22 once its PR merges (`holdsEpicOpen`); an `epic`-mode parent
with no branch, such as one holding only spikes, is done when its tasks are.
A task's dependency on a build task in another parent, or from outside any parent,
waits until that parent is done; the same-epic case only checks Merged.
Tasks added after the parent PR merged go straight to the target branch.

### Live GitHub verification

COR-167 also has a real GitHub capture from an isolated `pnpm dev` stack with
local Postgres and a project for `cormacrw/test-app`, paused before its plan and
tasks were created. Scripted PM, developer and reviewer reports drove the real
HTTP/WebSocket handlers; GitHub was not simulated. Fixture commits were made
through GitHub's contents API. Corral opened and squash-merged task PRs
[#15](https://github.com/cormacrw/test-app/pull/15) and
[#16](https://github.com/cormacrw/test-app/pull/16) into
`corral/epic-c0505a00-01a0-4c0a-9112-45ee5eebb12e-automatic-epic-pr-live-smoke`.
After the final task merged, the scheduler automatically opened
[parent PR #17](https://github.com/cormacrw/test-app/pull/17) into `main` and
assigned integration review. Its body contains both task PRs and their evidence
page links. These evidence links use the isolated dev web origin; the attached
HTTP evidence responses preserve their contents after the stack stops.

The task's attached `real-github-epic-selected.json` contains the relevant
requests and responses, including the automatic `POST /pulls` and its 201
response with head, base and body. `real-github-epic.json` preserves complete
response objects. This checks automatic PR creation and real merge gates;
scripted review verdicts do not prove agent reasoning or gate execution.
The project was paused at the end; parent PR #17 remains open and was not merged
into `main`.

For repeat smoke tests, use unique task refs/titles to avoid remote task-branch
collisions across fresh dev databases. An earlier PGlite attempt merged task PR
[#14](https://github.com/cormacrw/test-app/pull/14) into
`corral/epic-b607baf6-70fc-46c0-8d90-24452f0410d0-automatic-epic-pr-live-smoke`
but stalled recording the merge. Another setup created only the empty parent
branch `corral/epic-f2f84f1c-99df-4d89-8d15-cc85ea8e9cb6-automatic-epic-pr-live-smoke`.
The task branches created were `corral/ta-1-live-epic-smoke-document-1`,
`corral/ev-1-live-epic-smoke-document-1` and
`corral/ev-2-live-epic-smoke-document-2`. None of these smoke runs merged into
the repository's target branch.

## Task review context in the Inbox

`InboxPanelEpicContext` loads the task's parent through the shared parent detail
query. Human-review items in `epic` and `each_task` modes show **Part of
[parent title]. You'll review it all together at the parent PR.** in the top block,
including when actions and evidence are present. The title opens the parent using
the shared flyout navigation (the parent page on a phone). Active task PR reviews
also say **Approve and merge PR #N into the parent's branch, or request changes.**
Spikes and designs show only the context line, retaining their own approval
labels. Direct parents and standalone tasks have no additional context. The PR
description tab continues to show GitHub's actual base and head branches.
