# Home

**Route:** `/home`, from the sidebar's **Home** item. Phones show the same Home in its mobile layout ([mobile.md](mobile.md#home)): same sections, same order, one column.

A snapshot of the whole workspace: what's moving, what's merged and who's working, across every project. Project colours are each project's own (`projectColor`), as in the sidebar.

## Layout

A title, then a three-column grid (one column below `lg`):

1. **Stat tiles**, five across on wide screens, all the same height. Each tile's label and icon sit at the top and its number and hint line at the bottom, so the numbers and hints line up across the row; the hint runs the full width, under any sparkline:
   - **Needs you:** the Inbox count, with how many tasks are blocked or failed. Links to the Inbox.
   - **In flight:** tasks In progress, Agent review, Human review or Ready to merge, with how many agents are working.
   - **Merged this week:** tasks merged (and designs approved) in the last 7 days, the change against the 7 before, and a 14-day sparkline.
   - **Median cycle time:** Ready → Merged for tasks merged in the last 7 days, pooled across projects by the server (`GET /api/metrics/flow?window=7d`, same rules as the project overview's flow metrics), and the change against the 7 days before. A dash when nothing merged.
   - **Runs today:** runs queued today, with today's tokens and how many failed.
2. **Throughput** (two columns): tasks merged per day for 30 days, stacked by project, with a hover tooltip and a legend when there's more than one project.
3. **Tasks with subtasks** (third column, two rows tall): the six tasks with subtasks touched most recently across projects, each with its project, ref, when it changed and `EpicProgressRow`.
4. **Open work by project:** one bar per project split by stage (Ready, In progress, Agent review, Human review, Ready to merge), Backlog left out. Each row opens the project's Board.
5. **Agents:** agents with live runs and what each run is on (task link, title, elapsed), plus paused agents and those waiting on a usage limit. **All agents** opens the Agents page.

## Data

Tasks and tasks with subtasks come from the per-project lists the shell already loads, so the numbers match each Board. Runs come from the 14-day history shared with the Agents page (`GET /api/runs?since=`). Events keep everything current without a reload; task changes mark the workspace cycle time stale.
