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
2. **Active now:** always visible directly under the header, on desktop and mobile. Cards show the working agent, task or epic, run number, elapsed time and state, and link to the live run. Empty state: "No agent is working on this project right now."
3. **Stat tiles:** Ready, In progress, Agent review, Needs you and Completed this week, in an auto-fit grid.
4. **Tabs:** `UTabs`, in order **Needs you** (default), **Epics**, **Flow**, **Activity**. Only the selected tab's content is shown. The selected tab lives in `?tab=needs-you|epics|flow|activity`; the epic filter lives in `?epicFilter=open|in-progress|closed`. Reload and browser Back restore both, on desktop and mobile.
   - **Needs you:** existing inbox rows, count badge and **Open Inbox** link. Empty state: "Nothing is waiting on you."
   - **Epics:** **Open**, **In Progress**, **Closed** quick filters (Open by default), and **Open Backlog**. Each epic is a bordered card, initially collapsed, with a linked title, "N of M done", progress meter and review line. A separate labelled expand button lists every task with linked ref/title and status. Multiple cards may be expanded. There is no "No epic" group. An empty filter reads "No epics match this filter."
     - Open includes every unfinished epic. In Progress includes unfinished epics with at least one task outside Draft, Backlog and Ready, including blocked and reviewing work. Closed uses the Board's `epicStage === 'done'` rule. Open and In Progress deliberately overlap; Closed and Open never do. Live task counts update both filters and expanded task statuses without reload.
   - **Flow:** the existing flow metrics and window selector.
   - **Activity:** the existing Recent activity timeline of actor, action, task ref and time.

The Ready tile’s waiting-on-dependency count includes each Ready task with an unmet task dependency or an unfinished prerequisite epic, counting a task only once.

## Data

- **Project:** name, slug, prefix, thumbnail, remote, default branch, paused.
- **Counts:** by status, completed this week, first-pass approval rate.
- **Needs you:** this project's open Inbox items.
- **Active runs:** agent, task, run id, elapsed time, status.
- **Epics:** name, merged count, total.
- **Recent activity:** the last N events.
- Live over SSE.

## Charts

The Flow section lives inside the Flow tab on desktop and mobile. It offers 7d / 30d / 90d windows (30d default), median and p90 lead/cycle times, median status bars with p90 labels, run duration and queue wait by role, and linked slowest tasks. Queue wait is labelled “Queue wait (queued to started, including preparation)”, the same wording as the run timing breakdown ([agent.md](agent.md)). Live task and run events for this project refresh the figures in place, without the loading skeleton; other projects' events are ignored. Changing project or window clears the figures while loading. Human review uses warning and the label “Human wait”; agent work uses primary and “Agent time”; other statuses use neutral and “Other wait”. Bars share a median scale and numbers use text tokens. An empty cohort shows “No tasks merged” for the selected window.

## States

- **New project with no tasks:** the tiles show 0, and an empty-state card reads "Plan your first epic with Juno" with a button.
- **Paused:** the paused banner shows, and the badge reads Paused.

## Open questions

- Should first-pass approval and merge throughput get a small trend (a sparkline over 4 weeks)?
- Is "Completed this week" the right window for a single user, or should it be the last 7 days?
