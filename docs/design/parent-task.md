# Task with subtasks page

A task's page (`/tasks/:ref`) combines its delivery page and task page (D31): subtasks, its PR, review, sync state, history and comments, with Add subtask. Old `/epics/:id` links open the task, or the task itself for a collapsed single-subtask delivery record. A subtask's page links its task.

A task groups related subtasks of a plan (D9); one plan can propose several tasks with subtasks. It has a title, a markdown description and a canvas showing its subtasks as a dependency tree. Like a task, it opens in two modes: docked in the flyout (`?parent=<id>` on the current page) or as a page (`/epics/<id>`). The flyout shows one thing at a time, so opening a subtask replaces its task in the flyout and vice versa. On mobile it's always the page, and its subtasks open as pages ([mobile.md](mobile.md#task-and-subtask)).

## Where it opens

- **Board:** cards in the **tasks with subtasks** view open the task in the flyout on desktop or its page on mobile. Mobile Back returns to the same stage. In the **Tasks** view, with exactly one task selected in the task filter, **task details** opens it in the flyout on desktop or its page on mobile. There is no task carousel.
- **Backlog:** **task details** in each task's group header.
- **Project overview:** each task's name in the tasks with subtasks list links to the task page.
- **Task:** the **task** property links to the subtask's task (flyout in the task flyout, page on the task page).
- **Plan:** each task's title in the plan flyout.

Task names replace the old "Task 1", "Task 2" labels everywhere.

## Contents

1. **Header.** Flyout: a back arrow when the task was opened from a task's Task property, a "Task" badge, the project name, "✓ Saved", copy link, open full page, close. Page: a breadcrumb (project › task).
2. **Title.** Inline-editable, saved on change.
3. **Description.** Markdown, rendered. Click anywhere on it to edit in a textarea; **Save** / **Cancel**, Esc cancels.
4. **Review (D27).** The review mode in a select, saved on change. It can change until a subtask of the task submits a commit, opens a PR or merges without one, as a spike does; after that the select is disabled, with "Locked because a subtask in this task has submitted work." Before the PR exists an `epic` task says it opens once every subtask is complete (Merged, or Approved for designs), and that human checks are confirmed there. Once it exists, the **Task PR** block (`EpicPrBlock`) replaces the select: the PR's link, a badge for its state and the review mode, with **Review in the Inbox** opening its item while it waits on the human. A task with no PR, or a `direct` task, has no block. The task list links each PR-free task's integrated and approved commits under its row.
5. **Progress.** "N of M done" (Drafts aren't counted; they're noted as "· 2 drafts"), a progress bar, a status badge with a count for each status present, and the review status, such as "All tasks complete, awaiting your review".
6. **Tabs: Tasks, Graph and Activity.** The last tab used is remembered.
   - **Tasks:** every subtask in the task as a list: ref, title, "after TES-3" for its dependencies, priority when High or Urgent, and its status. Clicking a row opens the task.
   - **Graph:** the dependency tree below.
   - **Activity:** task audit history, including title, summary, review-mode and dependency edits, task's PR events and merge refusals, with actor and time. It uses the same remembered tab selection as Tasks and Graph.
7. **Dependency tree.** Every subtask in the task, Drafts included (dashed border). A task sits one step after the last task it depends on; siblings are ordered to keep edges from crossing. Nodes are compact (180×64) and the view never zooms past 85% when fitting, so a small tree doesn't fill the frame with oversized cards. Each node shows the ref, status and title, plus priority when High or Urgent. Edges are green once the dependency is merged, and animated while it's being worked on. A dependency in another task shows as a dashed placeholder with its ref. Pan and zoom with the controls (and a minimap on the page). Clicking a node opens that task in the flyout.
   - **Flyout:** the tree runs top to bottom in a 420px-tall frame, to suit the narrow column.
   - **Page:** the details sit in a 360px left column and the tree fills the rest, running left to right.

The tree is read-only: dependencies are edited on the tasks themselves. It follows task changes live.

## Data

- `GET /api/projects/:slug/epics`: the project's tasks with subtasks with task and merged counts (Drafts excluded), `prUrl` and `reviewModeLocked`.
- `GET /api/epics/:id`: the task and all its tasks, Drafts included.
- `GET /api/epics/:id/review`: the `EpicReview` the human approves from, read live from GitHub: goal, state, PR, required checks, commits the target has moved, integration rounds, one row per board task and the last feedback. Unknown is 404; a `direct` task is 409, because it has no task review. Actions stay on `POST /api/epics/:id/review`.
- `PATCH /api/epics/:id`: title, description and/or review mode. Changing the mode once `reviewModeLocked` is true answers 409. Publishes `epic.updated`.

## Task prerequisites (D22)

The details show **Depends on** and **Blocks** lists, each linking to the task with its board-only merged/total count (Draft and Backlog tasks excluded). A **Waiting on …** note names unfinished prerequisites at the top. Pick another project task and **Add**, or remove a prerequisite with its labelled remove button. Changes apply immediately; cycle/deadlock errors name the involved tasks with subtasks and preserve the saved graph.

- Task responses include `dependsOn` and `blocks` as task ID arrays.
- `PUT /api/epics/:id/dependencies` replaces `{ dependsOn: string[] }`, validates the complete project graph with the core helper, and records `epic.updated`. It publishes updated project tasks with subtasks and wakes the edited task's subtasks.
