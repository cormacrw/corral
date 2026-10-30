# Task PR bases

Tasks in `epic` and `each_task` epics branch from and open PRs against the
stored epic branch (`corral/epic-<id>-<slug>`). The server creates that branch
from the project's configured target tip before assigning the first developer.
Concurrent claims tolerate an already-created GitHub ref without resetting it.

`RunJob.baseBranch` carries this base separately from `defaultBranch`, which
continues to mean the project's target. Fresh developer worktrees start at the
base; revisions keep their existing branch. Reviewer prompts and merge conflict
instructions use the same base. GitHub's PR rebase and squash merge therefore
operate on the epic branch. Merging still marks the task Merged and wakes its
dependants through the existing task flow.

Every task in `each_task` mode requires human review, regardless of its own flag.
In `epic` and `direct` modes the flag applies normally. Tasks without an epic and
`direct` task PRs use the target branch. Designs and spikes retain their separate
non-merge workflows.

The focused server scenarios in `apps/server/src/task-base.test.ts` use `develop`
as the target and exercise assignment, PR submission, approval, merge, dependency
claims and conflicts. Runner workspace tests use real local git commits to check
that a new task starts at the epic tip. These tests use a simulated GitHub; they
do not create remote branches or PRs.
