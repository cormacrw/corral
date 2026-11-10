# Task PR bases

Tasks in `epic` and `each_task` tasks with subtasks branch from and open PRs against the
stored task's branch (`corral/epic-<id>-<slug>`). The server creates that branch
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
operate on the task's branch. Merging still marks the task Merged and wakes its
dependants through the existing task flow.

Every task in `each_task` mode requires human review, regardless of its own flag.
In `epic` and `direct` modes the flag applies normally. Standalone tasks and
`direct` task PRs use the target branch. Designs and spikes retain their separate
non-merge workflows.

The focused server scenarios in `apps/server/src/task-base.test.ts` use `develop`
as the target and exercise assignment, PR submission, approval, merge, dependency
claims and conflicts. Runner workspace tests use real local git commits to check
that a new task starts at the task tip. These tests use a simulated GitHub; they
do not create remote branches or PRs.

## Changing the review mode

`PATCH /api/epics/:id` takes `reviewMode` until `reviewModeLocked`: the task has a
PR, or any of its tasks, deleted ones included, has a PR or is Merged. It's a 409
after that. Plan revisions set `reviewMode` directly and aren't checked here.
Because `taskBase` resolves at every boundary, a task already running follows the
new mode when it opens its PR; `#submit` prepares the task's branch if there's none,
and a task's branch left by moving to `direct` stays on GitHub, unused.

## The task's PR integration review

Once every non-deleted board task is Merged, the scheduler opens (or recovers)
the task's PR into the configured target. Drafts and Backlog tasks don't
hold it back. The PR body links each board task's PR and evidence page.

Task integration reviews are reviewer runs with `runs.epicId` and no task ID,
placed like any other run on a runner that takes the reviewer role and has a
free slot; without one the task stays `in_review` for the next pass.
Their detached checkout is the task's PR head, their diff base is the project's
target, and their prompt includes the task goal plus every board task's criteria
and evidence. They rerun lint, typecheck, tests and build without cached results,
checking how the tasks fit together rather than re-judging individual evidence.
`get_task` returns the whole task; `get_evidence` can fetch any of its task items.
Run leases, runner ownership, concurrency, usage cooldowns and update holds apply.

The task's `in_review` state means agent integration review. Approval at the
current head moves it to `human_review`, which alone produces an The task's PR Needs
you item. The Inbox displays all board tasks and their evidence together. Human
Approve records `ready_to_merge`; merging is a separate step. Agent or human
Request changes creates a Ready fix task with the feedback as description and
criterion, and returns the task's PR to `open`. When fixes merge the same PR gets
a new integration review.

Moving a Draft or Backlog task onto the board, or moving a board task between
tasks with subtasks, resets pending task approval to `open` inside the same transaction and
interrupts any active integration run. Merely adding Backlog work doesn't.
Reporting a verdict checks board completion and the live GitHub head again;
human actions also carry the head shown in the Inbox, so stale approvals fail.
A changed task's PR head likewise starts fresh integration review.

## Merging an approved task's PR

`EpicMerger` (`apps/server/src/epic-merge.ts`) runs in the merge pass. It reads
every open task's PR, so a PR merged by hand still counts, and advances only
`ready_to_merge` ones. It compares the head with the target through the compare
API first: `mergeable_state` says `behind` only under branch protection that
requires it, and CI doesn't run on a conflicting PR, so this can't wait for CI.

A moved target waits for the synchronizer, which runs earlier in the same pass
([task-rebases.md](epic-rebases.md)); `EpicMerger` never rebases.

Task PRs always squash, so `project.mergeMethod` applies only to task PRs. An
task is done for D22 once its PR merges (`holdsEpicOpen`); an `epic`-mode task
with no branch, such as one holding only spikes, is done when its tasks are.
A task's dependency on a build task in another task, or from outside any task,
waits until that task is done; the same-task case only checks Merged.
Tasks added after the task's PR merged go straight to the target branch.

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
[task's PR #17](https://github.com/cormacrw/test-app/pull/17) into `main` and
assigned integration review. Its body contains both task PRs and their evidence
page links. These evidence links use the isolated dev web origin; the attached
HTTP evidence responses preserve their contents after the stack stops.

The task's attached `real-github-epic-selected.json` contains the relevant
requests and responses, including the automatic `POST /pulls` and its 201
response with head, base and body. `real-github-epic.json` preserves complete
response objects. This checks automatic PR creation and real merge gates;
scripted review verdicts do not prove agent reasoning or gate execution.
The project was paused at the end; task's PR #17 remains open and was not merged
into `main`.

For repeat smoke tests, use unique task refs/titles to avoid remote task-branch
collisions across fresh dev databases. An earlier PGlite attempt merged task PR
[#14](https://github.com/cormacrw/test-app/pull/14) into
`corral/epic-b607baf6-70fc-46c0-8d90-24452f0410d0-automatic-epic-pr-live-smoke`
but stalled recording the merge. Another setup created only the empty task
branch `corral/epic-f2f84f1c-99df-4d89-8d15-cc85ea8e9cb6-automatic-epic-pr-live-smoke`.
The task branches created were `corral/ta-1-live-epic-smoke-document-1`,
`corral/ev-1-live-epic-smoke-document-1` and
`corral/ev-2-live-epic-smoke-document-2`. None of these smoke runs merged into
the repository's target branch.

## Task review context in the Inbox

`InboxPanelEpicContext` loads the subtask's task through the shared task detail
query. Human-review items in `epic` and `each_task` modes show **Part of
[task title]. You'll review it all together at the task's PR.** in the top block,
including when actions and evidence are present. The title opens the task using
the shared flyout navigation (the task page on a phone). Active task PR reviews
also say **Approve and merge PR #N into the task's branch, or request changes.**
Spikes and designs show only the context line, retaining their own approval
labels. Direct tasks with subtasks and standalone tasks have no additional context. The PR
description tab continues to show GitHub's actual base and head branches.
