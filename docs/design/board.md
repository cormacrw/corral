# Board

**Canvas frames:** `App shell · Board`, `App shell · Marketing site board`, `Board (component)`
**Route:** `/projects/:slug/board`

## Purpose

A simple kanban of a project's **approved** work, grouped by status (D10). Backlog tasks are never shown here; they have their own page.

## Layout

1. **Toolbar** (bottom border):
   - a search input (240px, "Search tasks")
   - four **filters** (`components/BoardFilters.vue`), each a multi-select dropdown (`components/BoardFilter.vue`, `USelectMenu` with `multiple`) with a tick by each selected item. "All …" at the top of the menu clears the selection. The trigger reads "All epics" when nothing is selected, the item's name when one is, and "N epics" when several are:
     - **Epic:** every epic on the Board
     - **Status:** the columns
     - **Priority:** Urgent, High, Medium, Low
     - **Agent:** the developer and reviewer agents
   - **Clear filters**, while any filter or the search is set: resets them all
   - **Epic details**, only when exactly one epic is selected: opens it in the flyout
   - "N tasks" on the right
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
     | Merged | Merged | Last 3 days |
     | Approved | Approved | Designs with an approved prototype (D20) |

   - **Cards:** buttons with a `bg-default` background, a 1px border and `rounded-md`.
     - **Line 1:** the ref, the priority (Urgent in `error`, High in `warning`, others muted), a type badge for Bug (`error`, bug icon), Spike (`info`, flask icon) and Design (D20) but not Task (D19), and the PR number with an icon.
     - **Line 2:** the title (medium, highlighted).
     - **Optional note:** "Waiting on COR-31", "Review round 1 of 5", "Waiting for you", or "Review-round limit reached" (in `error` for blocked).
     - **Line 3:** the epic tag, plus the agent avatar on the right when assigned. While the agent is working, the avatar has a status dot and the agent's name is shown.
     - **Working cards pulse** (shared working indicator): the outline breathes in `primary` and the avatar dot pings.
     - The selected card has a 2px `primary` outline.
   - **Empty column:** "Nothing here".
3. **Task flyout:** docked on the right when a card is open. The columns area narrows and scrolls sideways.

## Interactions

- Clicking a card opens it in the flyout; clicking it again closes the flyout.
- Each filter shows tasks matching any of its selected items; with nothing selected it doesn't filter. Search and the filters combine with AND (`matchesFilter` in `apps/web/app/utils/board.ts`).
  - **Status** hides the columns that aren't selected (and their tabs on mobile).
  - **Agent** matches the agent holding the task's lease, or the agent it's assigned to. Tasks aren't assigned ahead of time (D15), so a task belongs to the agent of its latest run of the role whose turn it is (`task.developer` / `task.reviewer`): the developer in Ready and In progress, the reviewer in Agent review (`taskAgentIds`). A task no agent of that role has claimed matches no agent.
- The search and filters live in the URL query, so a filtered Board reloads and can be shared: `?q=`, and comma-separated `?epics=` (epic ids), `?status=` (column keys), `?priority=` and `?agent=` (agent ids). `?epic=` is taken by the epic flyout.
- There's **no drag and drop.** Agents and the scheduler move tasks. Human moves (unblocking, sending back to Backlog) happen in the flyout's Status menu or the Inbox, limited to what D10 allows.

## Rules

- The Merged column only shows tasks merged in the last 3 days (`MERGED_WINDOW_DAYS` in `apps/web/app/utils/board.ts`). Older merged tasks stay on the Backlog, epic and task pages.
- The Merged column lists the most recently merged task first (`sortColumn` in `apps/web/app/utils/board.ts`), on desktop and mobile; ties fall back to ref. Other columns keep the order the task list gives them.
- Ready tasks with unmerged dependencies stay in Ready, with the note "Waiting on {ref}" (D10).
- "Working" comes from an active lease, not from the status. A task in In progress waiting for a retry doesn't pulse.

Ready tasks held by epic dependencies use the same neutral waiting note as task dependencies: **Waiting on epic: <title>**. Tasks without unfinished epic prerequisites keep their existing card notes.

## Data

- **Tasks** (status other than Backlog, and merged within the last 3 days): ref, title, type, status, priority, epic, PR, review round, assigned agent, working (lease), note.
- **Epics** and **agents** for the filters.
- Live updates over SSE. Cards move between columns without a reload.

## Responsive

- On the web layout, columns scroll sideways at every width.
- On the mobile layout (D17, `components/BoardMobile.vue`), the Board shows **one column at a time**, from the `Board · one column at a time` frame:
  - the header's Search button shows the search input. The **Filters** icon button (`list-filter`) beside it toggles the filter row, **collapsed by default**, with an accessible label and pressed/expanded state
  - the expanded row contains the same Epic, Status, Priority and Agent filters as the web Board, two to a row, plus Clear filters while anything is filtered and "N tasks". Collapsing it keeps the selections and URL query unchanged
  - the Filters button shows a dot while any of the four filters is set, open or closed (search alone does not add a dot). Filters from the URL apply immediately without expanding the row
  - column tabs sit directly under the header, or the search input when open, while filters are collapsed
  - a row of pill tabs (`role="tablist"`), one per column, each with its status dot, name and count. The open tab is `primary` subtle and scrolls into view. Left and right arrow keys move between tabs
  - the open column: its name, "Whose turn: {hint}", and its cards, full width. "Nothing here" when empty
  - **swiping** left or right on the column moves to the next or previous column (at least 50px sideways, and more sideways than vertical)
  - the open column is kept in `?column=` (`ready`, `in_progress`, `agent_review`, `human_review`, `ready_to_merge`, `blocked`, `merged`), so Back from a task returns to it. It defaults to Ready
  - tapping a card opens the task's page, `/tasks/<ref>`, instead of the flyout. The PR number is shown but isn't a link

## Accessibility

- Each column is a `section` labelled with its name and count.
- Cards are buttons with `aria-pressed` when open.
- The pulse is decorative; the agent's name and status are in the text.

## Open questions

- Should columns be collapsible for wide boards?
