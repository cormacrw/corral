# Orchestrator structure

`Orchestrator` (`apps/server/src/orchestrator.ts`) is a thin facade: the runner
hub's handlers and the API's way in, plus the kill switch, update hold and tick.
Its parts share a `RunCore` (`run-context.ts`), built by its constructor, and
call each other through it: `this.#c.ending.endRun(...)`.

| Module | Holds |
|---|---|
| `run-context.ts` | `RunCore`, loading a run, fencing, `lockHeld` |
| `run-ending.ts` | Every way the server ends a run, and publishing it |
| `run-exits.ts` | `run.started`, `run.events`, `run.ended`, including replays |
| `run-jobs.ts` | Job and prompt building; reads only |
| `run-outcomes.ts` | Reviews, submissions, findings, designs, stuck |
| `agent-tools.ts` | Tool dispatch, evidence, attachments |
| `human-actions.ts` | Stop, resume, message, edit notice, delete, Inbox actions, design approval |
| `pm-dispatch.ts` | The PM queue and the update hold's final phase |
| `pm-calls.ts` | What confirm cards propose and do, and the PM's direct task and epic edits |
| `lease-reconcile.ts` | Lease sweep, connect, heartbeat, spool sweep |
| `scheduler.ts` | Passes, placement, `dispatch` |

Every assignment goes through `Scheduler.dispatch`, and every stop ends the run
before it sends `run.stop`. Keep both: a `run.assign` sent after its stop can
never be stopped, because the runner ignores a stop for a run it doesn't know.

`merge()` holds the task's row lock across the last check, the GitHub merge and
recording the result, so a human's veto can't land in between. Use `tx`, never
`db`, inside that transaction: PGlite has one connection.

Failures from GitHub or the runner are transient unless GitHub really answered
(`isTransient` in `github.ts`). Only real answers count against a task.
