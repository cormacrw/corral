# Board

**Canvas frames:** `App shell · Board`, `App shell · Marketing site board`, `Board (component)`
**Route:** `/projects/:slug/board`

## Purpose

A simple kanban of a project's **approved** work, grouped by status (D10). Backlog tasks are never shown here; they have their own page. On desktop and mobile, a **Tasks / Tasks with subtasks** toggle swaps the task cards for one card per task.

## Layout

1. **Toolbar** (bottom border):
   - the **Top-level / All subtasks** toggle (see [Views](#views-d31))
   - **Task details**, only when exactly one task is selected: opens it in the flyout
   - on the right, a **search** icon button (`features/board/components/BoardSearch.vue`) that opens the search bar (240px, "Search tasks") beside it and turns into a close button. Closing it, or Escape, clears the search. A search from the URL starts it open
   - a **Filters** button (`features/board/components/BoardFiltersMenu.vue`), with a badge counting the filters set, opening a dropdown with every filter's options as checkboxes, a long list scrolling inside it. Nothing ticked in a filter means all:
     - **Apply** commits the selections and closes it. Closing it any other way discards them
     - **Reset** clears the filters at once and leaves it open. It doesn't touch the search
   - the four **filters**:
     - **Task:** every task on the Board
     - **Status:** the columns
     - **Priority:** Urgent, High, Medium, Low
     - **Agent:** the developer and reviewer agents
2. **Columns:** a horizontally scrolling row (`overflow: auto`, `role="region"`, focusable). Each column is 272px wide with a `bg-muted` background, a border and `rounded-lg`.
   - **Column header:** a status-colour dot, the name, a count pill, and a hint of whose turn it is on the right.

     | Column | Statuses | Hint |
     |---|---|---|
     | Ready | Ready | Scheduled next |
     | In progress | In progress | Developer |
     | Agent review | Agent review | Reviewer |
     | Human review | Human review | You |
     | Ready to merge | Ready to merge | Corral |
     | Blocked & failed | Blocked, Failed | You |
     | Complete | Merged tasks and spikes, approved designs | Last 3 days |

   - **Cards** (`features/tasks/components/TaskCard.vue`, shared with the mobile layout): a `div` with a `bg-background` background, a 1px border and `rounded-md`, stacked top to bottom:
     - **Title:** medium, highlighted, wrapping as far as it needs. It's the card's keyboard control.
     - **Task:** one line, truncated, muted. Omitted when the task has none.
     - **Detail line** (`features/tasks/components/TaskCardMeta.vue`): the ref, the PR number when there is one, and on the right when the task last changed. Muted, and shared with task cards.
     - **Footer:** the priority on the left (Urgent in `error`, High in `warning`, others muted), and on the right the blocked icon, type icon and assignee.
     - **Type icon:** muted, so colour on the card belongs to the priority. Bug `i-hugeicons-bug-01`, Design `i-hugeicons-paint-brush-02`, Spike `i-hugeicons-test-tube`, and none for Task.
     - **Assignee** (`features/tasks/components/TaskCardAssignee.vue`): the avatar only, with the full name on hover. Agent review shows `task.reviewer` and every other status shows `task.developer`, never falling back to the other role. With no agent it's a dashed circle (hover: Unassigned). The green dot shows only when the displayed agent holds the lease.
     - **Not on the card, in any status:** notes (status reasons, review round, "Waiting for you", "Merges when checks pass", "Paused"), type badge, design-changed badge and a link to the PR. They're in the flyout.
     - **Working cards glow** (shared working indicator), with a `primary` border.
     - The selected card has a `primary` border and ring.
   - **Empty column:** "Nothing here".
3. **Task flyout:** docked on the right when a card is open. The columns area narrows and scrolls sideways.

## Tasks with subtasks view

The toggle's view lives in `?view=` (`top` or `all`; old links say `epics` or `tasks`) and the last one used is remembered in `localStorage` (`corral.board.scope`). A URL value wins over the remembered one; Tasks is the first-time default. Both layouts share this preference and URL behaviour.

Each card is a task with subtasks; individual subtask cards are hidden. Tasks with no subtasks do not appear.

**Columns.** `epicStage` in `apps/web/app/features/board/utils/board.ts` puts each task in exactly one column, from the first row that matches:

| Column | When | Hint |
|---|---|---|
| Blocked | `reviewState` is `conflict`, or any task is Blocked or Failed | You |
| Done | Tasks past Backlog and nothing left in progress (`epicInProgress`) | Last 3 days |
| Ready to merge | `reviewState` is `ready_to_merge` | Corral |
| Human review | `reviewState` is `human_review` | You |
| Agent review | All tasks merged, `reviewState` is null, `open` or `in_review` | Reviewer |
| Ready | No task has started | Scheduled next |
| In progress | Everything else, including `changes_requested` | Developer |

The columns are shown in the order Ready, In progress, Agent review, Human review, Ready to merge, Blocked, Done. `direct` tasks with subtasks have no task's PR, so they go from In progress to Done.

A task is shown under `epicOnBoard`: it has work left, or it finished within `COMPLETE_WINDOW_DAYS`, counted from its latest task completion (a merge or a design approval, the same rule as the Complete column) or, for a task's PR, the PR's merge. A task waiting on its PR stays however old its tasks are.

**Card** (`features/board/components/BoardEpicCard.vue`): the title, up to two lines of its description as plain text, the detail line (ref, PR number, last changed), and the meter with "N of M merged". Tags, review mode and a link to the PR stay in the task flyout. An unfinished task held by unfinished prerequisite tasks with subtasks shows the amber `i-hugeicons-unavailable` icon beside the title. It opens a "Waiting on" popover listing each prerequisite with its progress, and clicking a row opens that task. Clicking the icon doesn't open the card's own flyout.

**Working agents.** The card shows overlapping `AgentAvatar` pictures (initials as fallback), with no visible names: distinct task lease holders plus agents with active runs whose `epicId` matches the task, including taskless task reviews. Each agent appears once, in stable agent order. Show at most three avatars, then "+N" for the rest. Hover or keyboard focus shows the agent name in a tooltip; each avatar has an accessible name and the group announces all working agents, including those behind "+N". While any agent is working, wrap the card in the shared `BorderGlow` treatment. With none, show neither avatars nor glow. Task and run SSE updates refresh this without a reload.

On desktop, clicking a card opens the task in the flyout; clicking it again closes it. On mobile it opens `/epics/<id>`; Back returns to the same stage. The title is the card's keyboard button, and the selected card has the `primary` outline.

**Toolbar.** The search reads "Search tasks with subtasks" and matches task titles, and the task filter applies. Status, Priority and Agent are hidden, stay in the URL and return on switching back.

## Interactions

- Clicking anywhere on a card opens it in the flyout; clicking it again closes the flyout. The title is a button: Tab reaches it, Enter or Space does the same, and the focus ring shows round the whole card.
- The PR link is in the flyout's properties and opens in a new tab.
- Each filter shows tasks matching any of its selected items; with nothing selected it doesn't filter. Search and the filters combine with AND (`matchesFilter` in `apps/web/app/features/board/utils/board.ts`).
  - **Status** hides the columns that aren't selected (and their tabs on mobile).
  - **Agent** matches the agent holding the task's lease, or the agent it's assigned to. Tasks aren't assigned ahead of time (D15), so a task belongs to the agent of its latest run of the role whose turn it is (`task.developer` / `task.reviewer`): the developer in Ready and In progress, the reviewer in Agent review (`taskAgentIds`). A task no agent of that role has claimed matches no agent.
- The search and filters live in the URL query, so a filtered Board reloads and can be shared: `?q=`, and comma-separated `?parents=` (task ids), `?status=` (column keys), `?priority=` and `?agent=` (agent ids). `?parent=` is taken by the task flyout, and `?view=` by the Tasks / Tasks with subtasks toggle.
- On desktop, cards with a permitted human move to another Board column can be dragged there. Valid target columns are highlighted. The move appears immediately; a rejected request restores the card and shows an error toast. These use the same D10 actions as the flyout's Status menu: for example, resolving Blocked to Ready or requesting changes from Human review. Agent and scheduler transitions remain server-owned. Sending work to Backlog stays in the Status menu or Inbox.

## Rules

- The Complete column only shows work finished in the last 3 days (`COMPLETE_WINDOW_DAYS` in `apps/web/app/features/board/utils/board.ts`). Older completed tasks stay on the Backlog, task pages.
- The Complete column lists the most recently finished task first (`sortColumn` in `apps/web/app/features/board/utils/board.ts`), on desktop and mobile; ties fall back to ref. Other columns keep the order the task list gives them.
- Ready tasks with unfinished dependencies stay in Ready (D10). An amber `i-hugeicons-unavailable` button sits to the left of the type icon when `dependsOn` contains a task not done by `isTaskDone`, or `waitingOnEpics` is nonempty (task dependencies, or a Merged dependency in another task that isn't done). Approved designs count as done. Resolve dependencies against the full project task list, before filters and the completion window. A dependency missing from that list, such as a Draft, counts as not done. Other statuses, including Blocked and Failed, never get the icon.
- The blocked button opens a `UPopover` headed **Waiting on**, listing every blocking task’s title, ref and status, plus each waiting task. A dependency missing from the task list shows its ref alone. Task rows open the flyout on desktop and the task page on phones. Task rows link to `/epics/<id>`, like Board tasks with subtasks. The button and rows stop clicks from opening the task card. Escape and outside clicks dismiss the popover. It fits within the phone viewport and updates from live task data without a reload.
- "Working" comes from an active lease, not from the status. A task in In progress waiting for a retry doesn't glow.

## Data

- **Tasks** (status other than Backlog, and completed within the last 3 days): title, type, status, priority, task, developer, reviewer, working (lease).
- **Tasks with subtasks** and **agents** for the filters. The Tasks with subtasks view also observes the complete active-runs snapshot (including `epicId`) for task-level workers.
- Live updates over SSE. Cards move between columns without a reload. Task mutations that reopen task review publish the updated task after committing, including both tasks with subtasks when a board task moves between them; the card's review state and progress both refresh.

## Responsive

- On the web layout, columns scroll sideways at every width.
- On the mobile layout (D17, `features/board/components/BoardMobile.vue`), the Board shows **one column at a time**, from the `Board · one column at a time` frame:
  - the header's Search button shows the search input. The **Filters** icon button (`list-filter`) beside it toggles the filter row, **collapsed by default**, with an accessible label and pressed/expanded state
  - in Tasks, the expanded row contains the same Task, Status, Priority and Agent filters as the web Board, two to a row, each a multi-select dropdown (`features/board/components/BoardFilters.vue`), plus Clear filters while anything (search included) is filtered and "N tasks". They take effect at once, without the web Board's Apply. Collapsing it keeps the selections and URL query unchanged
  - the Filters button shows a dot while any of the four filters is set, open or closed (search alone does not add a dot). Filters from the URL apply immediately without expanding the row
  - the Top-level / All subtasks toggle stays visible above the column tabs. Search and filters apply to both views; task-only filters stay saved for returning to Tasks
  - there is no task carousel in either view or layout
  - a row of pill tabs (`role="tablist"`), one per column, each with its status dot, name and count. The open tab is `primary` subtle and scrolls into view. Left and right arrow keys move between tabs
  - the open column: its name, "Whose turn: {hint}", and the same cards at full width. "Nothing here" when empty
  - **swiping** left or right on the column moves to the next or previous column (at least 50px sideways, and more sideways than vertical)
  - the open column is kept in `?column=` (`ready`, `in_progress`, `agent_review`, `human_review`, `ready_to_merge`, `blocked`, `complete`) in Tasks, or a task stage key (`ready`, `in_progress`, `agent_review`, `human_review`, `ready_to_merge`, `blocked`, `done`) in Tasks with subtasks, so Back from a detail page returns to it. A key missing from the active view falls back to its first visible column, including when switching views. Legacy `merged` and `approved` links open Complete in Tasks. It defaults to Ready
  - tapping anywhere on a task card opens the task's page, `/tasks/<ref>`; tapping a task card opens `/epics/<id>`, instead of the flyout. A task card's title is a link rather than a button. Task cards reuse `BoardEpicCard`, full width, including the stacked working-agent avatars and prerequisite popover
  - with exactly one task selected, **Task details** in the expanded filter row opens its page

## Accessibility

- Each column is a `section` labelled with its name and count.
- A card is a `div`, so it can hold other buttons. Its title is the keyboard control: a button with `aria-pressed` when open, or a link on the mobile layout. The focus ring shows round the whole card.
- Tab reaches the blocked button after the title. Enter opens its popover; its accessible name says what the task is waiting on.
- The type icon is labelled with the type.
- The assignee is labelled with the agent's name and, when the dot shows, "working", or "Unassigned". Sighted users get the name by hovering, so phones don't show it.
- The glow is decorative.

## Open questions

- Should columns be collapsible for wide boards?

Completion time uses `mergedAt`, falling back to `updatedAt` for an approved design. Stored statuses and transitions are unchanged.

## Views (D31)

The Board lists top-level tasks by default: tasks on their own, and each task as a card with its subtask progress, in the column its rolled-up stage names (Done is Complete). All subtasks lists every task with work, without the tasks with subtasks. Links that say `?view=epics` open Top-level, and `?view=tasks` All subtasks. A task can't be dragged: its column follows its subtasks and delivery.

