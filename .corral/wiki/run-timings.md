# Run timings

The runner times every run with a `RunTimer` (`apps/runner/src/run-timings.ts`)
and sends the result on `run.ended` as `timings`. The server stores it in the
nullable `runs.timings` jsonb column and returns it on the run API. It is stored
even when the run has already ended, because an accepted `report_outcome` ends
the run before the runner's `run.ended` arrives.

The run is always in exactly one phase, so `phases` add up to `totalMs`. A phase
entered during another pauses it: a push inside `report_outcome`, or a design
pack or save inside a tool call, comes out of the agent's time. An `agent_*`
phase is keyed by how the process began: `agent_cold_start` for a fresh session,
`agent_resume` for `--resume`, `agent_warm_turn` for a warm PM process. Anything
unnamed counts as `other`.

`totalMs` runs from assignment to `run.ended`. It does not equal
`endedAt - startedAt`: `startedAt` comes after the worktree is prepared, and
`endedAt` is set when the server accepts the outcome, while the agent may take
up to `OUTCOME_EXIT_GRACE_MS` more to exit.

`tools` pairs the neutral `tool_call` and `tool_result` events by id and keeps
count, total and max per tool, so Claude Code and Codex are timed the same way.
A call with no result by the end of the run counts up to the end. Overlapping
calls each count in full, so tool totals can exceed the agent's phase time.

`timings` is null for runs that haven't ended, runs from older runners, and runs
whose `run.ended` never arrived. Nothing depends on it being present.

The desktop and mobile run pages share `RunTimingBreakdown.vue`. When timings
are present it shows a stacked phase bar, phases sorted by duration with the
largest marked, and tools sorted by total time with count and max. The panel
scrolls with the transcript, so long lists remain reachable on phones. Runs
without timings keep the transcript alone. Prototype Victor run `r-3` includes
phase/tool timings; Rita run `r-5` is a finished run without them.

Queue wait is displayed separately as queued-to-started, explicitly including
preparation. The API exposes no assignment timestamp, and `startedAt` follows
preparation, so this interval overlaps preparation phases and must not be added
to the runner's phase bar or total.
