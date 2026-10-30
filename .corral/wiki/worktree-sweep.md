# Worktree sweep

The `sweep_worktrees` setup job (`sweepWorktrees` in
`apps/runner/src/workspace.ts`) removes folders under `<dataDir>/worktrees/`
outside the job's keep list. Only `<uuid>`, `<uuid>-review` and
`pm-<uuid>-<uuid>` names are candidates; a looser pattern can't tell a task
folder from anything else.

Clones are found with `git worktree list` in each bare clone rather than from a
worktree's `.git` file, so the clone path matches `barePath` and `removeWorktree`
takes the lock the runs use. If a clone can't answer, the job fails and removes
nothing, because its worktrees would otherwise look like orphans.

An orphan's status is only read when it has a `.git` that git accepts. Under a
dev data dir, `git status` in a plain folder answers for the checkout above it.
An orphan with a dangling `.git` file can't report changes, so it is deleted.

The running-turn check happens synchronously before `removeWorktree` joins the
repo queue, so a turn that starts later checks out after the removal and
recreates its worktree.
