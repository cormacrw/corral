# Board Epics view

The desktop Board's Tasks / Epics toggle lives in `?view=` and `localStorage` (`corral.board.view`). The URL wins, and a view opened from a URL counts as last used. `board.vue` holds the view in a ref next to the filters and writes both in one watcher, so a quick filter change and toggle can't drop one another from the query. Mobile ignores the view.

`epicStage` in `utils/board.ts` is ordered and must get epics from `epicWithLiveCounts`, because the server only resends an epic when the epic itself changes. Passing live counts and the task cache is what moves cards without a reload. `direct` epics ignore `reviewState`.

`epicOnBoard` is the visibility rule for both the Epics view and the Epics row. There is no epic merge timestamp: a finished epic stays for the merge window from a task's `mergedAt`, or from `updatedAt` once its epic PR has merged. Approved designs don't count, since they never leave the Board and would hold a finished epic in Done forever. `unfinishedPrerequisites` mirrors the server's `holdsEpicOpen`.
