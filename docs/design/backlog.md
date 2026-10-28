# Backlog

**Canvas frames:** `App shell · Backlog`, `Backlog (component)`
**Route:** `/projects/:slug/backlog`

## Purpose

All of a project's tasks in **Backlog** status, grouped by epic. Backlog tasks are proposed or sent back, never scheduled, and not on the board (D10). This is where you browse what's coming and pick something to refine with Juno.

## Layout

The page spans the full content width.

1. **Toolbar** (bottom border):
   - a search input ("Search Backlog")
   - "N tasks · never scheduled until approved"
   - on the right: **Collapse all / Expand all** (outline) and **New task** (solid primary, plus icon)
2. **Epic groups:** one bordered card per epic.
   - **Header** (`bg-muted`):
     - a chevron toggle with the epic name (`aria-expanded`), which rotates 90° when open
     - a count pill
     - progress, e.g. "2 of 6 merged", counting the epic's tasks in every status
     - **Plan with Juno** on the right, which opens Plan with this project and epic
   - **Rows**, each a full-width button with a top divider:
     - the ref (40px column)
     - the title, plus an **In plan v2** badge (`primary` subtle) when the task belongs to a plan waiting for approval
     - the criteria count, e.g. "3 criteria" or "No criteria"
     - the priority (Urgent `error`, High `warning`, others muted)
     - the age
   - The selected row uses `bg-elevated`.
3. **Task flyout:** docked on the right. The flyout shows status Backlog, with Ready as the only other status option.

## Interactions

- Clicking a row opens the flyout; clicking it again closes it.
- Collapsing a group hides its rows. The state is remembered per user.
- **New task** creates a Backlog task in this project and opens it in the flyout. A "Refine with Juno" next step is still to be designed.
- Search filters the rows and hides groups with no matches.

## Rules

- Backlog → Ready is a human action. It needs a title, a description and verifiable acceptance criteria (D10). If any are missing, the Status menu in the flyout shows what's needed.
- Deleting a Backlog task deletes it outright (D10).

## Data

- **Backlog tasks:** ref, title, epic, priority, created, criteria count, plan id and plan status.
- **Epics:** name, plus merged and total counts across statuses.

## Responsive

- **Below 768px:** the criteria and age columns hide.

## Open questions

- Should rows be sortable or reorderable by priority within an epic?
- Should tasks without an epic be shown in an "No epic" group at the end?
