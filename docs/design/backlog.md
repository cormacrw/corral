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
     - **Move all to board** (outline, kanban icon; "Move to board" when the epic has one Backlog task), which asks to confirm and then moves every Backlog task in the epic to Ready
   - **Rows**, each a full-width button with a top divider:
     - the ref (40px column)
     - a type badge for Bug, Spike and Design, none for Task (D19, D20)
     - the title, plus an **In plan v2** badge (`primary` subtle) when the task belongs to a plan waiting for approval
     - the criteria count, e.g. "3 criteria" or "No criteria"
     - the priority (Urgent `error`, High `warning`, others muted)
     - the age
     - **Move to board** (ghost, kanban icon), shown on hover or focus from 768px up and always below that
   - The selected row uses `bg-elevated`.
3. **Task flyout:** docked on the right. A Backlog task shows a banner above its properties, "In the Backlog, so never scheduled until you move it.", with **Move to board** (solid primary). The Status menu also offers Ready as the only other option.

## Interactions

- Clicking a row opens the flyout; clicking it again closes it.
- Collapsing a group hides its rows. The state is remembered per user.
- **New task** creates a Backlog task in this project and opens it in the flyout. A "Refine with Juno" next step is still to be designed.
- Search filters the rows and hides groups with no matches.

## Rules

- Backlog → Ready is a human action. It needs a title, a description and verifiable acceptance criteria (D10). If any are missing, the task stays in the Backlog and a warning toast says what each one needs. Moving an epic moves the tasks that are ready and lists the rest.
- Deleting a Backlog task deletes it outright (D10).

## Data

- **Backlog tasks:** ref, title, type, epic, priority, created, criteria count, plan id and plan status.
- **Epics:** name, plus merged and total counts across statuses.

## Responsive

- **Below 768px:** the criteria and age columns hide.
- **Mobile layout** (D17, `components/BacklogMobile.vue`, the `Backlog` frame): the search input fills the width with the count under it, and **New task** is a **+** in the header. Each epic card puts **Plan with Juno** and **Move all to board** side by side under its header (hidden while collapsed). Rows show the ref and title, then the In plan badge, priority and type badge (Bug, Spike and Design only), with an icon-only **Move to board** on the right. Tapping a row, or creating a task, opens the task's page instead of the flyout. There's no Collapse all / Expand all.

## Open questions

- Should rows be sortable or reorderable by priority within an epic?
- Should tasks without an epic be shown in an "No epic" group at the end?
