# Project overview

**Canvas frames:** `App shell · Corral overview`, `Project overview (component)`
**Route:** `/projects/:slug`, reached by clicking a project's name in the sidebar.

## Purpose

A one-screen summary of a project: what's moving, what's waiting on you, who's working, and how the epics are progressing. It's the jumping-off point to that project's Board, Backlog, Plan and Inbox.

## Layout

The page scrolls, in a column up to 1200px wide with 24px padding.

1. **Header:**
   - a 44px thumbnail with the project's colour and initial, or an image
   - the name (`text-2xl` semibold) and a **Paused** (`warning`) badge only while paused
   - a meta line with the GitHub remote (mono), "Branch main" and "Task IDs COR-123"
   - actions: **Plan with Juno** (outline; opens Plan with this project selected) and **Open board** (solid primary)
2. **Stat tiles:** an auto-fit grid with a 160px minimum. Each tile is a `dl` with a status-colour dot and label, a big number (24px, tabular) and a sub-line.
   - Ready, e.g. "1 waiting on a dependency"
   - In progress, e.g. "Atlas working"
   - Agent review, e.g. "Vera reviewing"
   - Needs you, e.g. "1 review · 2 blocked"
   - Merged this week, e.g. "first-pass approval 56%"
3. **Two columns**, auto-fit with a 340px minimum. They stack when narrow.
   - **Left:**
     - **Needs you:** a bordered card with its header, a count badge and an **Open Inbox** link. Rows show a type badge, the task ref and title, and the time. Clicking a row opens that item in the Inbox. Empty state: "Nothing is waiting on you."
     - **Active now:** cards for agents working on this project, with the working pulse. Each shows the avatar with a ping dot, "Atlas is building COR-35 Settings page skeleton" and "Run #128 · 18m · In progress". Clicking one opens the agent's live run. Empty state: "No agent is working on this project right now."
   - **Right:**
     - **Epics:** an **Open Backlog** link, then each epic's name, "2 of 6 merged" and a progress meter. The meter is a 6px bar split into a `primary` "merged" segment and a `bg-accented` "remaining" segment, with a 2px gap, `role="meter"` and an `aria-label` like "Billing: 2 of 6 tasks merged".
     - **Recent activity:** a timeline of dot, actor, action, task ref and time.

The Ready tile’s waiting-on-dependency count includes each Ready task with an unmet task dependency or an unfinished prerequisite epic, counting a task only once.

## Data

- **Project:** name, slug, prefix, thumbnail, remote, default branch, paused.
- **Counts:** by status, merged this week, first-pass approval rate.
- **Needs you:** this project's open Inbox items.
- **Active runs:** agent, task, run id, elapsed time, status.
- **Epics:** name, merged count, total.
- **Recent activity:** the last N events.
- Live over SSE.

## Charts

The Flow section follows the stat tiles on desktop and mobile. It offers 7d / 30d / 90d windows (30d default), median and p90 lead/cycle times, median status bars with p90 labels, run duration and queue wait by role, and linked slowest tasks. Human review uses warning and the label “Human wait”; agent work uses primary and “Agent time”; other statuses use neutral and “Other wait”. Bars share a median scale and numbers use text tokens. An empty cohort shows “No tasks merged” for the selected window.

## States

- **New project with no tasks:** the tiles show 0, and an empty-state card reads "Plan your first epic with Juno" with a button.
- **Paused:** the paused banner shows, and the badge reads Paused.

## Open questions

- Should first-pass approval and merge throughput get a small trend (a sparkline over 4 weeks)?
- Is "Merged this week" the right window for a single user, or should it be the last 7 days?
