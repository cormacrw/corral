# Board

**Canvas frames:** `App shell · Board`, `App shell · Marketing site board`, `Board (component)`
**Route:** `/projects/:slug/board`

## Purpose

A simple kanban of a project's **approved** work, grouped by status (D10). Backlog tasks are never shown here; they have their own page.

## Layout

1. **Toolbar** (bottom border):
   - a search input (240px, "Search tasks")
   - epic filter chips: a `radiogroup` with "All epics" plus each epic in the project; the selected chip uses a `primary` subtle style
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

   - **Cards:** buttons with a `bg-default` background, a 1px border and `rounded-md`.
     - **Line 1:** the ref, the priority (Urgent in `error`, High in `warning`, others muted) and the PR number with an icon.
     - **Line 2:** the title (medium, highlighted).
     - **Optional note:** "Waiting on COR-31", "Review round 1 of 5", "Waiting for you", or "Review-round limit reached" (in `error` for blocked).
     - **Line 3:** the epic tag, plus the agent avatar on the right when assigned. While the agent is working, the avatar has a status dot and the agent's name is shown.
     - **Working cards pulse** (shared working indicator): the outline breathes in `primary` and the avatar dot pings.
     - The selected card has a 2px `primary` outline.
   - **Empty column:** "Nothing here".
3. **Task flyout:** docked on the right when a card is open. The columns area narrows and scrolls sideways.

## Interactions

- Clicking a card opens it in the flyout; clicking it again closes the flyout.
- Search and the epic filter combine.
- There's **no drag and drop.** Agents and the scheduler move tasks. Human moves (unblocking, sending back to Backlog) happen in the flyout's Status menu or the Inbox, limited to what D10 allows.

## Rules

- The Merged column only shows tasks merged in the last 3 days (`MERGED_WINDOW_DAYS` in `apps/web/app/utils/board.ts`). Older merged tasks stay on the Backlog, epic and task pages.
- Ready tasks with unmerged dependencies stay in Ready, with the note "Waiting on {ref}" (D10).
- "Working" comes from an active lease, not from the status. A task in In progress waiting for a retry doesn't pulse.

## Data

- **Tasks** (status other than Backlog, and merged within the last 3 days): ref, title, status, priority, epic, PR, review round, assigned agent, working (lease), note.
- **Epics** for the filter.
- Live updates over SSE. Cards move between columns without a reload.

## Responsive

- Columns scroll sideways at every width.
- On phones, consider one column at a time with swipe. Not designed yet.

## Accessibility

- Each column is a `section` labelled with its name and count.
- Cards are buttons with `aria-pressed` when open.
- The pulse is decorative; the agent's name and status are in the text.

## Open questions

- Should columns be collapsible for wide boards?
