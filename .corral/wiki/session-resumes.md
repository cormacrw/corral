# Session resumes and cache costs

Fresh fix rounds aren't cheaper by default, so warm resumes stay. The decision is
in `#authorJob` (`apps/server/src/run-jobs.ts`):

- A developer revision resumes only when the previous session's run ended under
  55 minutes ago, inside the hour a prompt cache lives. CI-fix rounds count as
  developer revisions.
- Otherwise it starts fresh with the full prompt, the feedback since that run and
  the branch diff from `cappedBranchDiff` (30,000 characters of whole files, then
  file names). If GitHub can't give the diff, the prompt says to compare the
  branches. The run stays on its runner, because the worktree there is still useful.
- Rebase-only rounds, epic rebase rounds and designer revisions keep their session
  at any age.
- The first transcript line says which happened and why.

`runs.session_start` records `fresh`, `resumed_warm` or `resumed_cold`, set on
author runs and epic fix runs. A resume that fails falls back to the full prompt,
and the runner sends `resumeFailed` on `run.started`, which turns the row into
`fresh`. PM and reviewer runs and older runs leave it null.

Claude reports cache writes, stored in `runs.cache_write_tokens`. Codex doesn't,
so its column stays null and its `cacheWriteTokens` is absent from `usage` events.
Runs from before this column have their writes inside `inputTokens`, so the run
page says input may include cache writes.

`weightedRunCost` (`@corral/contracts/client`) uses $0.20 per million cache reads,
$8 per million 1-hour cache writes and $20 per million output. Fresh input has no
agreed weight, so the cost leaves it out and says so, with input shown beside it.
The cost is null when cache writes weren't reported apart, because reads and output
alone wouldn't compare.

The run page shows all of this per run. The project Flow page compares developer
runs in the window by session start, with the average weighted cost over the runs
that have one.
