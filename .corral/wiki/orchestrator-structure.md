# Orchestrator structure

`Orchestrator` (`apps/server/src/orchestrator.ts`) is the composition root: it
builds every part with only what that part calls (each part's `*Deps`
interface), implements the runner hub's handlers and runs the tick. Routes call
the part that owns the action (`orchestrator.human.stopRun`,
`orchestrator.controls.stopAll`, `orchestrator.scheduler.poke`). No domain module
imports the orchestrator.

| Module | Holds |
|---|---|
| `run-gate.ts` | `RunGate`: kill switch, update hold and its final phase, read by scheduler, PM dispatch and merges |
| `controls.ts` | Kill switch and update hold: the only writers of the gate |
| `run-context.ts` | Loading a run with its `kind` (task, epic review, epic fix, PM), fencing, `lockHeld` |
| `run-lease.ts` | Where a run's lease lives per kind: renew, lapsed, expired, expiry stop text |
| `run-stops.ts` | Stop reasons and `stoppedBy`/`keepsWork`/`neverStarted`; never compare the strings |
| `run-lifecycle.ts` | `endRunIn`, the only write of a run's end (audit, lease release), `endActiveRuns`, `restoreRunEnd` |
| `run-ending.ts` | `RunEnding`: every way the server ends or stops a run, `failAttempt`, publishing |
| `run-exits.ts` | `run.started`, `run.events`, `run.ended`, including replays, one rate-limit path |
| `run-job.ts` | `workerJob` and `pmJob` envelopes, run and PM time limits |
| `run-jobs.ts` | Job and prompt building |
| `run-outcomes.ts` | Reviews, submissions, findings, designs, stuck |
| `epic-fix-runs.ts` | `EpicFixes`: developer runs on an epic (D29) |
| `epic-review-runs.ts` | `EpicReviewRuns`: integration review runs on a task's PR (claim, CI, verdict, giving up) |
| `epic-prs.ts` | `EpicPullRequests`: opening a task's PR, starting its review, the human's approval |
| `merge.ts` | `MergeOrchestrator`: task PRs; `settled` publishes a task the other passes changed |
| `task-integration.ts` | `TaskIntegrator`: PR-free subtasks onto their task's branch |
| `epic-sync.ts` | `EpicSynchronizer`: keeps a task's branch on its target, between integrations |
| `epic-merge.ts` | `EpicMerger`: tasks' own PRs |
| `agent-tools.ts` | Tool dispatch for worker runs; a PM run's calls go to `pm-tools.ts` |
| `agent-files.ts` | Evidence, attachments and designs through agent tools, for every role |
| `commands.ts` | `Commands`: project, agent, task, comment and parent changes. Each commits, publishes its events (with invalidated epics) and wakes the scheduler; routes and PM tools both call them |
| `human-actions.ts` | Stop, resume, message, edit notice, delete, Inbox actions and clarify (the PM's too), design approval |
| `placement.ts` | Picking a runner, one at a time, and `dispatch` |
| `pm-dispatch.ts` | The PM queue (`queueIn` creates every PM run) and the update hold's final phase |
| `recovery-pass.ts` | Releasing stops and queueing their PM triage turn |
| `pm-tools.ts` | `PmTools`: the PM tool registry. Reads each call with its contract schema, scopes its project, and acts, proposes a card or audits by the tool's policy |
| `pm-board-tools.ts`, `pm-direct-tools.ts`, `pm-calls.ts`, `pm-decisions.ts` | The registry's handlers: the board and plans; direct audited tools; task, project, run and factory cards and the gated edits; Inbox and design decisions |
| `pm-actions.ts` | `PmActions`: a confirm card's lifecycle |
| `pm-agent.ts` | Which agent is the PM |
| `lease-reconcile.ts` | Lease sweep, connect, heartbeat, spool sweep |
| `scheduler.ts` | Passes |

The merge passes are peers, run in that order by `Orchestrator.mergePass`
(tests call it too). `TaskIntegrator` gets the synchronizer, and both report
tasks they changed to `merges.settled`. Both step journaled operations through
`operations.ts` (writer lock, epochs, compare-and-set moves, decisions, stored
endings); a task becomes Merged only through `recordTaskMerged` (`tasks.ts`),
and a pass's change to a task it read earlier through `settleTask`
(`task-settle.ts`).

Plan is split by reason to change: `plan-sessions.ts` (message store, what
each session shows, and `PlanSessions`, the one place a session change is
published), `plan.ts` (`PlanService`: the conversation and its turns),
`plan-proposals.ts` (`PlanProposals`: propose, approve, discard) and
`pm-board-tools.ts`. `PlanService` is built by the orchestrator too; it starts
and stops PM runs through callbacks, so it is never missing.

Every assignment goes through `Placement.dispatch`, and every stop goes through
`RunEnding.stop`, which ends the run before it sends `run.stop`. Keep both: a
`run.assign` sent after its stop can never be stopped, because the runner
ignores a stop for a run it doesn't know.

`merge()` holds the task's row lock across the last check, the GitHub merge and
recording the result, so a human's veto can't land in between. Use `tx`, never
`db`, inside that transaction: PGlite has one connection.

Failures from GitHub or the runner are transient unless GitHub really answered
(`isTransient` in `github.ts`; the runner-backed client is `runner-github.ts`, check policy `checks.ts`). Only real answers count against a task.
