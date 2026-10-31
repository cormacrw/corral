# Board Epics view

The desktop Board's Tasks / Epics toggle lives in `?view=` and `localStorage` (`corral.board.view`). The URL wins, and a view opened from a URL counts as last used. `board.vue` holds the view in a ref next to the filters and writes both in one watcher, so a quick filter change and toggle can't drop one another from the query. Mobile ignores the view.

`epicStage` in `utils/board.ts` is ordered and must get epics from `epicWithLiveCounts`, because the server only resends an epic when the epic itself changes. Passing live counts and the task cache is what moves cards without a reload. `direct` epics ignore `reviewState`.

`epicOnBoard` is the visibility rule for both the Epics view and the Epics row. There is no epic merge timestamp: a finished epic stays for the merge window from a task's `mergedAt`, or from `updatedAt` once its epic PR has merged. Approved designs don't count, since they never leave the Board and would hold a finished epic in Done forever. `unfinishedPrerequisites` mirrors the server's `holdsEpicOpen`.

Task mutations that reset an epic's integration review collect the IDs returned by `invalidateEpicReview`. The HTTP mutation and Plan approval publish `epic.updated` for those IDs only after the enclosing transaction commits. Moving a board task between epics collects both IDs. This refreshes the epic list's review state as well as the live task counts, so a Human review or Ready to merge card moves back to In progress when new work reaches its board. Never publish from the mutation transaction or a nested savepoint: a later failure must leave both the database and clients unchanged.

Epic cards derive working agents with `epicWorkingAgents`: the union of task lease holders and active runs matching `epicId`, deduplicated by agent ID in shell order. Board observes the existing `runsQuery({ active: true })`; `run.updated` invalidates run lists and reconnect refetches them. No new API fields are needed. The active-runs snapshot is complete rather than subject to the default 50-run history limit; explicit tool limits still apply. Cards use `AgentAvatar`, a three-avatar overlapping stack with +N overflow, name tooltips and an accessible group listing every worker. `BorderGlow` is active only while that union is nonempty.

Lease expiry for taskless epic runs must publish `run.updated` after interrupting the run, even when no runner can acknowledge `run.stop`. `sweepLeases` uses the same `#publish` path as task runs, so the active-runs query drops expired reviewers and the card clears their avatar and glow without a reload.
