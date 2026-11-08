# Worktree sweep

The `sweep_worktrees` setup job (`sweepWorktrees` in
`apps/runner/src/sweep.ts`) removes folders under `<dataDir>/worktrees/`
outside the job's keep list. Only `<uuid>`, `<uuid>-review`, `epic-<uuid>`,
`epic-<uuid>-review` and `pm-<uuid>-<uuid>` names are candidates; a looser
pattern can't tell a task folder from anything else. Each folder kind's path
builder and the pattern the sweep matches it by sit side by side in
`apps/runner/src/layout.ts`, with `discardsChanges`, which says whose
uncommitted changes go: review and PM checkouts', never a developer's (task or
epic). `cleanup_worktrees` uses it too. `keepEpicIds` is optional for older servers, and
without it epic checkouts are left alone. A global Plan session's folder,
`sessions/<uuid>`, goes once its session is off the keep list and has no turn
running.

The job also clears `scratch/` and `spool/`, which it doesn't report: a Plan
session's scratch folder (`pm-<projectId|global>-<uuid>`, and `pm-null-<uuid>`
from older runners) goes with its session, and a `<uuid>` run's files go when
`LocalRuns.hasRun` says the runner no longer has that run. Runs normally delete
their own once `run.ended` has gone out, so these are what a crash left. Design
copies are read-only, so `removeScratch` (`designs.ts`) runs `chmod -R u+w` first.

Clones are found with `git worktree list` in each bare clone rather than from a
worktree's `.git` file, and each is opened as a `Repo` by its repository name
(`openRepo` in `repos.ts`), so `removeWorktree` takes the lock the runs use. If a clone can't answer, the job fails and removes
nothing, because its worktrees would otherwise look like orphans.

An orphan's status is only read when it has a `.git` that git accepts. Under a
dev data dir, `git status` in a plain folder answers for the checkout above it.
An orphan with a dangling `.git` file can't report changes, so it is deleted.

The running-turn check happens synchronously before `removeWorktree` joins the
repo queue, so a turn that starts later checks out after the removal and
recreates its worktree.

The server sends the job from `WorktreeSweep` (`apps/server/src/worktree-sweep.ts`)
when a runner connects and hourly. The keep list filters on `deletedAt`: a
deleted task that had started is only soft-deleted, so it's still in the table.
A pm worktree that outlives `PM_WORKTREE_TTL` is recreated at the same path by
the next turn, so `claude --resume` still finds its session.

A sweep asked for while one is running runs afterwards rather than being
dropped, because the runner that just connected may have missed the keep list
of the one in flight. If one runner fails, the audit entry still records what
the others removed; only an error is logged for it.
