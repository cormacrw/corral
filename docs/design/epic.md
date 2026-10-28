# Epic flyout and epic page

An epic groups the tasks of one plan (D9). It has a title, a markdown description and a canvas showing its tasks as a dependency tree. Like a task, it opens in two modes: docked in the flyout (`?epic=<id>` on the current page) or as a page (`/epics/<id>`). The flyout shows one thing at a time, so opening an epic replaces an open task and the other way round.

## Where it opens

- **Board:** with an epic chosen in the epic filter, **Epic details** opens it in the flyout.
- **Backlog:** **Epic details** in each epic's group header.
- **Project overview:** each epic's name in the Epics list links to the epic page.
- **Task:** the **Epic** property links to the task's epic (flyout in the task flyout, page on the task page).
- **Plan:** the epic title in a plan card's header.

Epic names replace the old "Epic 1", "Epic 2" labels everywhere.

## Contents

1. **Header.** Flyout: a back arrow when the epic was opened from a task's Epic property, an "Epic" badge, the project name, "✓ Saved", copy link, open full page, close. Page: a breadcrumb (project › epic).
2. **Title.** Inline-editable, saved on change.
3. **Description.** Markdown, rendered. Click anywhere on it to edit in a textarea; **Save** / **Cancel**, Esc cancels.
4. **Progress.** "N of M merged" (Drafts aren't counted; they're noted as "· 2 drafts"), a progress bar, and a status badge with a count for each status present.
5. **Tabs: Tasks and Graph.** The last tab used is remembered.
   - **Tasks:** every task in the epic as a list: ref, title, "after TES-3" for its dependencies, priority when High or Urgent, and its status. Clicking a row opens the task.
   - **Graph:** the dependency tree below.
6. **Dependency tree.** Every task in the epic, Drafts included (dashed border). A task sits one step after the last task it depends on; siblings are ordered to keep edges from crossing. Nodes are compact (180×64) and the view never zooms past 85% when fitting, so a small tree doesn't fill the frame with oversized cards. Each node shows the ref, status and title, plus priority when High or Urgent. Edges are green once the dependency is merged, and animated while it's being worked on. A dependency in another epic shows as a dashed placeholder with its ref. Pan and zoom with the controls (and a minimap on the page). Clicking a node opens that task in the flyout.
   - **Flyout:** the tree runs top to bottom in a 420px-tall frame, to suit the narrow column.
   - **Page:** the details sit in a 360px left column and the tree fills the rest, running left to right.

The tree is read-only: dependencies are edited on the tasks themselves. It follows task changes live.

## Data

- `GET /api/projects/:slug/epics`: the project's epics with task and merged counts (Drafts excluded).
- `GET /api/epics/:id`: the epic and all its tasks, Drafts included.
- `PATCH /api/epics/:id`: title and/or description. Publishes `epic.updated`.
