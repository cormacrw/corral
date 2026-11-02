# Board Parents view

The Board's Tasks / Parents toggle lives in `?view=` and `localStorage` (`corral.board.view`). The URL wins, and a view opened from a URL counts as last used. `board.vue` holds the view in a ref next to the filters and writes both in one watcher, so a quick filter change and toggle can't drop one another from the query. Desktop and mobile share the view. Mobile reuses `BoardEpicCard` in its one-column layout, with stage pill tabs and the same swipe handling as tasks. `?column=` resolves against the active view; an unknown or other-view-only key falls back to its first visible column. Parent cards open the parent page on mobile, preserving the Board query for Back.

`epicStage` in `utils/board.ts` is ordered and must get parents from `epicWithLiveCounts`, because the server only resends a parent when the parent itself changes. Passing live counts and the task cache is what moves cards without a reload. `direct` parents ignore `reviewState`.

`epicOnBoard` is the visibility rule for the Parents view. There is no parent merge timestamp: a finished parent stays while a done task is still in Complete under `onBoard`, so an approved design holds it for the same window as a merge, or from the parent's `updatedAt` once its parent PR has merged. `unfinishedPrerequisites` mirrors the server's `holdsEpicOpen`.

Task mutations that reset a parent's integration review pass an `InvalidatedEpics` collector to `invalidateEpicReview`, which records each parent and the runs it interrupted. The HTTP mutation, Plan approval and the parent rebase hand-off call `publishInvalidatedEpics` only after the enclosing transaction commits: `epic.updated` for each parent and `run.updated` for each interrupted run, so the active-runs query drops the reviewer's avatar and glow without waiting for a runner. Moving a board task between parents collects both. This refreshes the parent list's review state as well as the live task counts, so a Human review or Ready to merge card moves back to In progress when new work reaches its board. Never publish from the mutation transaction or a nested savepoint: a later failure must leave both the database and clients unchanged.

Parent cards derive working agents with `epicWorkingAgents`: the union of task lease holders and active runs matching `epicId`, deduplicated by agent ID in shell order. Board observes the existing `runsQuery({ active: true })`; `run.updated` writes run lists with `placeRun`, which removes a run from the active list once it stops being active, and reconnect refetches them. No new API fields are needed. The active-runs snapshot is complete rather than subject to the default 50-run history limit; explicit tool limits still apply. Cards use `AgentAvatar`, a three-avatar overlapping stack with +N overflow, name tooltips and an accessible group listing every worker. `BorderGlow` is active only while that union is nonempty.

Lease expiry for taskless parent runs must publish `run.updated` after interrupting the run, even when no runner can acknowledge `run.stop`. `sweepLeases` in `lease-reconcile.ts` ends it through `ending.stop`, which publishes on the same path as task runs, so the active-runs query drops expired reviewers and the card clears their avatar and glow without a reload.

The former `BoardEpics` carousel and `boardEpics` prop are removed from both layouts. `EpicProgressRow` and `EpicReviewLine` remain for other screens. The Tasks view retains its Parent filter and Parent details action (in the expanded Filters row on mobile). Active runs are queried for the Parents view in both layouts so taskless parent reviewers appear in the same avatar stack.

The project overview uses `matchesOverviewEpicFilter` beside `epicStage` for its
Open / In Progress / Closed filters. It takes live counts and all sub-tasks;
In Progress is based on a task leaving Draft, Backlog or Ready, rather than a
single board column. `ProjectOverviewTabs` shares URL state (`tab`, `epicFilter`)
and cards across desktop and mobile. `OverviewEpicCard` keeps its own collapsed
state, with an expand button separate from the parent title link. Empty parents are
included in overview groups; the No parent group is excluded from this tab.

On mobile, the overview tabs provide the content's 16px inset. Needs you and
Activity slots must not add another inset; the Needs you list extends back
through the tabs' margin so row borders span the viewport, while each row keeps
16px padding for its text.
