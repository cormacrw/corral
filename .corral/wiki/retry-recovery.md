# No-progress stops and PM recovery (COR-436)

`retry-recovery.ts` records dispatch inputs on `runs.retryContext`: the branch
head (the target for a new branch or a spike), resolved target head, and the
latest human comment/audit input. The runner refines the initial head from its
prepared checkout in `run.started.initialHeadSha`, so kept local commits count
as progress even before they are pushed (older runners use the remote snapshot).
A substantive failure records its actual
local head, supplied by the runner, without pushing. Two adjacent non-PM runs
must both fail at that unchanged head with the same inputs to stop claims.
Unknown heads never establish repetition. Input or target changes during a run
also break the streak.

Usage limits, stops, shutdowns and lost leases retain their existing recovery.
Runs without an accepted outcome (including CLI errors, signals, timeouts
and exits restored after a connection loss) still respect the failed-run cap
but cannot establish repetition: a dropped CLI connection can also exit with
code 1, which does not prove a substantive attempt completed. Nothing raises a
retry cap or carries approval across new work.

A stop is durable in `tasks.retryStop`. The scheduler reconciles it before
claiming workers, and queues one PM run and one fresh Plan session under the
task lock. PM runs may now link to a task for its run history, but remain
fenced and leased by the run, independently of the worker lease. Paused PMs
and offline runners keep the durable queued job. An interrupted triage is a
Plan-session recovery error, never a new automatic triage loop.

The PM reads the task, run diagnostics and code, and comments with actionable
findings or proposes work for human plan approval. Only requirements,
authority and recovery decisions become `ask_question` items in Needs you,
with the block, attempted recovery, decision and recommendation. The original
Failed/Blocked item is suppressed once its recovery conversation exists, so
implementation diagnosis does not demand a duplicate human decision. The task
comment links the conversation and names the triage run.

Fresh human task input or a changed target releases a repetition stop. A human
answer in its recovery conversation is copied to a pinned task comment and
resolves Failed/Blocked through D10, with the usual counter reset. Epic rebase
answers also go through D27's decision journal: exact alternative labels keep
the recorded choice's semantics, and other free text conservatively counts as
a behaviour change. Routine comments and target changes cannot bypass
an exhausted failed-run cap or resolve a requirements block. Explicit task
resolution remains available. A later stop creates a new episode, never a
second automatic triage turn for the previous episode.

The existing `outcome-retries.md` covers the runner's separate one-time resume
to obtain a missing outcome; it is unchanged by this policy.
