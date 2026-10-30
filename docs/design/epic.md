# Epic flyout and epic page

An epic groups related tasks of a plan (D9); one plan can propose several epics. It has a title, a markdown description and a canvas showing its tasks as a dependency tree. Like a task, it opens in two modes: docked in the flyout (`?epic=<id>` on the current page) or as a page (`/epics/<id>`). The flyout shows one thing at a time, so opening an epic replaces an open task and the other way round. On mobile it's always the page, and its tasks open as pages ([mobile.md](mobile.md#task-and-epic)).

## Where it opens

- **Board:** with exactly one epic selected in the epic filter dropdown, **Epic details** opens it in the flyout.
- **Backlog:** **Epic details** in each epic's group header.
- **Project overview:** each epic's name in the Epics list links to the epic page.
- **Task:** the **Epic** property links to the task's epic (flyout in the task flyout, page on the task page).
- **Plan:** each epic's title in the plan flyout.

Epic names replace the old "Epic 1", "Epic 2" labels everywhere.

## Contents

1. **Header.** Flyout: a back arrow when the epic was opened from a task's Epic property, an "Epic" badge, the project name, "✓ Saved", copy link, open full page, close. Page: a breadcrumb (project › epic).
2. **Title.** Inline-editable, saved on change.
3. **Description.** Markdown, rendered. Click anywhere on it to edit in a textarea; **Save** / **Cancel**, Esc cancels.
4. **Review (D27).** The review mode in a select, saved on change. It can change until a task of the epic opens a PR (or merges without one, as a spike does); after that the select is disabled, with "Locked because a task in this epic has opened a PR." The epic PR link and a badge for its review state follow; before the PR exists an `epic` or `each_task` epic says it opens once every task is complete (Merged, or Approved for designs).
5. **Progress.** "N of M done" (Drafts aren't counted; they're noted as "· 2 drafts"), a progress bar, a status badge with a count for each status present, and the review status, such as "All tasks complete, awaiting your review".
6. **Tabs: Tasks and Graph.** The last tab used is remembered.
   - **Tasks:** every task in the epic as a list: ref, title, "after TES-3" for its dependencies, priority when High or Urgent, and its status. Clicking a row opens the task.
   - **Graph:** the dependency tree below.
7. **Dependency tree.** Every task in the epic, Drafts included (dashed border). A task sits one step after the last task it depends on; siblings are ordered to keep edges from crossing. Nodes are compact (180×64) and the view never zooms past 85% when fitting, so a small tree doesn't fill the frame with oversized cards. Each node shows the ref, status and title, plus priority when High or Urgent. Edges are green once the dependency is merged, and animated while it's being worked on. A dependency in another epic shows as a dashed placeholder with its ref. Pan and zoom with the controls (and a minimap on the page). Clicking a node opens that task in the flyout.
   - **Flyout:** the tree runs top to bottom in a 420px-tall frame, to suit the narrow column.
   - **Page:** the details sit in a 360px left column and the tree fills the rest, running left to right.

The tree is read-only: dependencies are edited on the tasks themselves. It follows task changes live.

## Data

- `GET /api/projects/:slug/epics`: the project's epics with task and merged counts (Drafts excluded), `prUrl` and `reviewModeLocked`.
- `GET /api/epics/:id`: the epic and all its tasks, Drafts included.
- `PATCH /api/epics/:id`: title, description and/or review mode. Changing the mode once `reviewModeLocked` is true answers 409. Publishes `epic.updated`.

## Epic prerequisites (D22)

The details show **Depends on** and **Blocks** lists, each linking to the epic with its board-only merged/total count (Draft and Backlog tasks excluded). A **Waiting on …** note names unfinished prerequisites at the top. Pick another project epic and **Add**, or remove a prerequisite with its labelled remove button. Changes apply immediately; cycle/deadlock errors name the involved epics and preserve the saved graph.

- Epic responses include `dependsOn` and `blocks` as epic ID arrays.
- `PUT /api/epics/:id/dependencies` replaces `{ dependsOn: string[] }`, validates the complete project graph with the core helper, and records `epic.updated`. It publishes updated project epics and wakes the edited epic's tasks.
