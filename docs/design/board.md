# Board

**Canvas frames:** `App shell · Board`, `App shell · Marketing site board`, `Board (component)`
**Route:** `/projects/:slug/board`

## Purpose

A simple kanban of a project's **approved** work, grouped by status (D10). Backlog tasks are never shown here; they have their own page. On desktop, a **Tasks / Epics** toggle swaps the task cards for one card per epic.

## Layout

1. **Toolbar** (bottom border):
   - the **Tasks / Epics** toggle (desktop only; see [Epics view](#epics-view))
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
     - **Optional note:** "Paused" (in `warning`, ahead of any other note, after a human stopped the task's run), "Waiting on COR-31", "Review round 1 of 5", "Waiting for you", or "Review-round limit reached" (in `error` for blocked).
     - **Line 3:** the epic tag, plus the agent avatar on the right when assigned. While the agent is working, the avatar has a status dot and the agent's name is shown.
     - **Working cards pulse** (shared working indicator): the outline breathes in `primary` and the avatar dot pings.
     - The selected card has a 2px `primary` outline.
   - **Empty column:** "Nothing here".
3. **Epics** (`components/BoardEpics.vue`): a row above the columns, scrolling sideways, with a 272px card for each epic that has tasks on the Board or work left, including an epic PR still to merge (D27). The Epic filter narrows it. A card shows the epic's name (linking to it), "N of M merged", the meter, "Review: <mode>", the **Epic PR #N** link, and the review status, such as "All tasks merged, awaiting your review". On mobile the same row sits above the column tabs.
4. **Task flyout:** docked on the right when a card is open. The columns area narrows and scrolls sideways.

## Epics view

The toggle's view lives in `?view=` (`tasks` or `epics`) and the last one used is remembered in `localStorage` (`corral.board.view`). A URL value wins over the remembered one; Tasks is the first-time default. Mobile has no toggle and always shows tasks.

Each card is an epic, and no task cards or the Epics row are shown. Tasks with no epic don't appear.

**Columns.** `epicStage` in `apps/web/app/utils/board.ts` puts each epic in exactly one column, from the first row that matches:

| Column | When | Hint |
|---|---|---|
| Blocked | `reviewState` is `conflict`, or any task is Blocked or Failed | You |
| Done | Tasks past Backlog and nothing left in progress (`epicInProgress`) | Last 3 days |
| Ready to merge | `reviewState` is `ready_to_merge` | Corral |
| Human review | `reviewState` is `human_review` | You |
| Agent review | All tasks merged, `reviewState` is null, `open` or `in_review` | Reviewer |
| Ready | No task has started | Scheduled next |
| In progress | Everything else, including `changes_requested` | Developer |

The columns are shown in the order Ready, In progress, Agent review, Human review, Ready to merge, Blocked, Done. `direct` epics have no epic PR, so they go from In progress to Done.

An epic is shown under `epicOnBoard`: it has work left, or it finished within `MERGED_WINDOW_DAYS`, counted from its latest task merge or, for an epic PR, the PR's merge. An epic waiting on its PR stays however old its tasks are. Approved designs alone don't keep a finished epic on the Board.

**Card** (`components/BoardEpicCard.vue`): the title and the meter with "N of M merged". Tags, review mode and the PR link stay in the epic flyout. An unfinished epic held by unfinished prerequisite epics shows the amber `i-lucide-ban` icon beside the title. It opens a "Waiting on" popover listing each prerequisite with its progress, and clicking a row opens that epic. Clicking the icon doesn't open the card's own flyout.

**Working agents.** The card shows overlapping `AgentAvatar` pictures (initials as fallback), with no visible names: distinct task lease holders plus agents with active runs whose `epicId` matches the epic, including taskless epic reviews. Each agent appears once, in stable agent order. Show at most three avatars, then "+N" for the rest. Hover or keyboard focus shows the agent name in a tooltip; each avatar has an accessible name and the group announces all working agents, including those behind "+N". While any agent is working, wrap the card in the shared `BorderGlow` treatment. With none, show neither avatars nor glow. Task and run SSE updates refresh this without a reload.

Clicking a card opens the epic in the flyout; clicking it again closes it. The title is the card's keyboard button, and the selected card has the `primary` outline.

**Toolbar.** The search reads "Search epics" and matches epic titles, and the Epic filter applies. Status, Priority and Agent are hidden, stay in the URL and return on switching back; Clear filters resets only the search and Epic filter here. The count reads "N epics".

## Interactions

- Clicking a card opens it in the flyout; clicking it again closes the flyout.
- Each filter shows tasks matching any of its selected items; with nothing selected it doesn't filter. Search and the filters combine with AND (`matchesFilter` in `apps/web/app/utils/board.ts`).
  - **Status** hides the columns that aren't selected (and their tabs on mobile).
  - **Agent** matches the agent holding the task's lease, or the agent it's assigned to. Tasks aren't assigned ahead of time (D15), so a task belongs to the agent of its latest run of the role whose turn it is (`task.developer` / `task.reviewer`): the developer in Ready and In progress, the reviewer in Agent review (`taskAgentIds`). A task no agent of that role has claimed matches no agent.
- The search and filters live in the URL query, so a filtered Board reloads and can be shared: `?q=`, and comma-separated `?epics=` (epic ids), `?status=` (column keys), `?priority=` and `?agent=` (agent ids). `?epic=` is taken by the epic flyout, and `?view=` by the Tasks / Epics toggle.
- On desktop, cards with a permitted human move to another Board column can be dragged there. Valid target columns are highlighted. The move appears immediately; a rejected request restores the card and shows an error toast. These use the same D10 actions as the flyout's Status menu: for example, resolving Blocked to Ready or requesting changes from Human review. Agent and scheduler transitions remain server-owned. Sending work to Backlog stays in the Status menu or Inbox.

## Rules

- The Merged column only shows tasks merged in the last 3 days (`MERGED_WINDOW_DAYS` in `apps/web/app/utils/board.ts`). Older merged tasks stay on the Backlog, epic and task pages.
- The Merged column lists the most recently merged task first (`sortColumn` in `apps/web/app/utils/board.ts`), on desktop and mobile; ties fall back to ref. Other columns keep the order the task list gives them.
- Ready tasks with unmerged dependencies stay in Ready, with the note "Waiting on {ref}" (D10).
- "Working" comes from an active lease, not from the status. A task in In progress waiting for a retry doesn't pulse.

Ready tasks held by epic dependencies use the same neutral waiting note as task dependencies: **Waiting on epic: <title>**. Tasks without unfinished epic prerequisites keep their existing card notes.

## Data

- **Tasks** (status other than Backlog, and merged within the last 3 days): ref, title, type, status, priority, epic, PR, review round, assigned agent, working (lease), note.
- **Epics** and **agents** for the filters. The Epics view also observes the complete active-runs snapshot (including `epicId`) for epic-level workers.
- Live updates over SSE. Cards move between columns without a reload. Task mutations that reopen epic review publish the updated epic after committing, including both epics when a board task moves between them; the card's review state and progress both refresh.

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
