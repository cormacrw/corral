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
CLI-reported errors, signals, timeouts and exits restored after a connection
loss still respect the failed-run cap but cannot establish repetition. The
runner preserves CLI error results as `error` exits, including connection cuts
that would otherwise look like an ordinary exit code 1. Ordinary process exits
without an outcome can establish repetition when both heads are known. Nothing raises a
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
Failed, Blocked or stopped item is suppressed while triage is active or its open
recovery conversation has a pending question or plan. Comment-only or failed
triage restores the original task decision to Needs you, including any D27 alternatives, with PM
findings and recovery guidance. A failed or closed recovery conversation cannot
hide the task permanently. The task
comment links the conversation and names the triage run.

A no-progress stop has no Failed or Blocked status: the task stays In progress
or Agent review with no lease, so `openTaskFilter` selects it through
`retryStop.sessionId` under the same suppression rule, as a `stopped` item dated
by the stopping run's end. D10's `resolve` transition does not apply to those
statuses, so `releaseStop` uses the `release_stop` event, which is hidden from
the status menu and absent from the transition API. The Inbox's `resolve` action
routes there too. Retry and Give direction keep the status, and Send back moves
to Backlog; none resets the failed-run counter, and
the audited human action starts a fresh streak. Findings are taken only from PM
comments after this stop's queued-triage comment.

Fresh human task input or a changed target releases a repetition stop. A human
choice in a pending recovery question resumes work only if the PM explicitly
listed that exact choice in `ask_question.retryOptions`. The selected retry
choice is copied to a pinned task comment and resolves Failed/Blocked through
D10, with the usual counter reset. Refusal, clarification, stale answers and
unmarked free text never resume work or reset caps. Epic rebase
answers also go through D27's decision journal: exact alternative labels keep
the recorded choice's semantics, and other free text conservatively counts as
a behaviour change. Routine comments and target changes cannot bypass
an exhausted failed-run cap or resolve a requirements block. Explicit task
resolution remains available. A later stop creates a new episode, never a
second automatic triage turn for the previous episode.

The existing `outcome-retries.md` covers the runner's separate one-time resume
to obtain a missing outcome; it is unchanged by this policy.

Only new stops create recovery episodes. The scheduler never scans historical
Failed tasks to enqueue triage; reconnect replay records a new cap at the point
its failed-run counter reaches the limit. Target polling uses the scheduler's
per-task backoff: 60 seconds initially, doubling to five minutes on unchanged
or unavailable targets. Human input is checked on every pass without waiting
for GitHub. A server restart may perform one fresh target check.

Post-triage Inbox summaries use the recovery episode in their cache key and
include PM findings in their message facts, so a pre-triage summary cannot
claim that no findings exist after the PM has supplied them.
