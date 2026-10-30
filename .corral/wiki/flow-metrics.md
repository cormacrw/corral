# Flow metrics

`GET /api/projects/:slug/metrics/flow?window=7d|30d|90d` defaults to `30d`.
Invalid windows return 400; an unknown project returns 404. The cohort is
non-deleted tasks currently Merged with `mergedAt` in the inclusive interval
`[now - window, now]`. Spikes completed as Merged count; Approved designs do not.
Every metric uses this cohort's lifetime up to merge, including history before
the selected window. No schema changes are needed.

All durations are milliseconds. `leadTime` and `cycleTime` contain `medianMs`
and `p90Ms`, using continuous linear interpolation on sorted samples (like
`percentile_cont`). Empty samples return zero. `mergedTaskCount` is the cohort
size. With no merged tasks, the scalar metrics are zero and lists are empty.

`leadTime` measures creation to merge. `cycleTime` starts at the first recorded
transition out of Draft/Backlog/Ready into a working status, and never resets on
rework. A task initially in a working status starts at creation. A direct merge
without a recorded start contributes zero cycle time.

`timeInStatus` contains `{ status, medianMs, p90Ms }` per visited status. Each
sample is a task's total time in that status, summed across repeated visits;
tasks that never visited it aren't samples. Human review (`human_review`) is
separate from agent review and development. Self-transitions do not reset or
lose time. Initial status comes from the first transition's `from`; absent
history defaults to Backlog. Time after `mergedAt` is excluded.

`runsByRole` contains `{ role, queueWait, duration }`. Queue wait uses
`startedAt - queuedAt` for started runs. Duration uses `endedAt - startedAt`
for ended runs, rather than the runner's phase timings (see `run-timings.md`).
Missing or inverted timestamps are omitted from the corresponding sample.
Only runs of cohort tasks queued by merge count; queue samples require a start
by merge. Completed run durations include runs ending just after merge (for
example the reviewer that finishes a spike). Roles with no timing samples are omitted.
`averageDeveloperRuns` counts all developer run records queued by merge,
including failed/interrupted/unstarted runs, divided by merged task count.

`slowestTasks` contains up to ten `{ ref, leadTimeMs, dominantStatus }` rows,
sorted by descending lead time, then ref. Dominant status is the largest summed
status duration; ties use first visited status. Refs use the current project
prefix, as the rest of the API does.

## Project overview

Desktop and mobile share `ProjectFlow.vue`, defaulting to 30d with 7d/30d/90d
buttons. Changing project or window clears the previous figures while loading;
stale responses cannot overwrite the latest selection. Task/run live events
refresh the cohort. Errors offer retry; zero merged tasks show an empty state.

Status bars compare median durations on a shared scale. Human review is labelled
Human wait (warning), development and agent review Agent time (primary), and
remaining statuses Other wait (neutral). These are status residence times, not
measured active execution. Run duration and queue wait have separate percentiles.
Slowest task refs link to task pages. Prototype fixtures vary all figures by
window; Marketing site's 7d window demonstrates no merges.
