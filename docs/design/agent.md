# Agent

**Canvas frames:** `App shell · Agent (Atlas)`, `Agent view (component)`
**Route:** `/agents/:name` (current run, or the latest run) and `/agents/:name/runs/:runId`
**Scope:** global. An agent works across every project. This replaces the old Runs page.

## Purpose

See what an agent is doing right now, attach to its live run, and look back at previous runs. PRD §12 Agents view: active runs, role, task, elapsed time, usage, live output, and attach, interrupt and stop controls.

## Layout

### Header (bottom border)

- the avatar, with a ping dot while working
- the name and a status badge: **Working** (`success`), **Interrupted** (neutral) or **Idle** (neutral)
- "{Role} · Claude Code · {summary}", e.g. "6 runs today"
- **Agent settings** (outline; goes to Settings › Agents)

### Info and stats (bottom border)

- **Stat tiles:** an auto-fit grid with a 150px minimum. Each tile has a label, a big tabular number and a sub-line. They depend on the role:

  | Role | Tiles |
  |---|---|
  | Developer | Runs this week · PRs merged · First-pass approval · Avg run · Usage today |
  | Reviewer | Reviews this week · Approved · Changes requested (avg rounds per task) · Avg review · Usage today |
  | PM | Turns this week · Plans approved · Tasks proposed · Avg turn · Usage today |

- **Facts line:** group and concurrency, where it runs (one worktree per task, a read-only task worktree, or a read-only checkout of main), its instructions file (mono, e.g. `.corral/agents/developer.md`), and its caps or limits.
- Usage is in tokens, with no dollar cost on a subscription. Show it where available (agent-runtime-and-auth.md, rule 6).

### Body: two panes

1. **Runs list** (320px):
   - **Current run:** pinned at the top, with the working pulse.
   - **Previous runs:** each row shows the task ref, an outcome badge, when it ran, the title, and "{project dot} {project} · Run #128 · 18m".
   - **Outcome badges:** Live (`primary`), PR opened / PR updated / Plan proposed (`primary`), Approved / Answered (`success`), Changes requested (`warning`), Stuck / Failed (`error`), Rate limited / Stopped / Interrupted (neutral).
2. **Run transcript:**
   - **Run header:** "{ref} {title}", the outcome badge, and "Run #128 · branch · 18:42 elapsed · 142k tokens". On the right: **Open task** (opens the flyout) and, for live runs only, **Interrupt / Resume** (outline) and **Stop run** (`error` subtle).
   - **Log** (`role="log"`, `aria-live="polite"`), up to 880px wide. Each entry is one of:
     - a **system divider**, e.g. "Run started in worktree …"
     - an **agent message** (highlighted text)
     - a **tool call card**: a `bg-muted` header with the tool name pill (Read, Edit, Write, Bash, Browser, `attach_evidence`, `get_task`…) and the target in mono, plus `+42 −0` for edits; an optional output block in mono
     - **your mid-run message**: a right-aligned bubble labelled "You, mid-run"
     - an **outcome card**, tinted with the outcome colour, e.g. "Stuck. Asked you a question. The task is Blocked until you answer in the Inbox."
     - a **"{Agent} is working…"** line with a ping dot while the run is live
   - **Footer:**
     - **Live run:** the composer, "Message Atlas mid-run…" with "Atlas reads this at its next step". When interrupted it reads "Tell Atlas what to do next…" and "Atlas is waiting for you".
     - **Previous run:** a lock icon and "Read-only. This run finished 2h ago. To change the work, comment on the task."
3. **Task flyout:** docked on the right when you press Open task.

## Interactions

- **Attaching:** opening the page while a run is live streams its events (SSE) and ticks the timer.
- **Interrupt:** pauses the agent at its next step. Resume continues it.
- **Stop:** ends the run. The task stays in its status with no lease, and the scheduler retries under D10.
- **Mid-run messages:** go to the agent through the runner's MCP channel.

## The PM (Juno)

Juno only runs when you message it in Plan (D9). With no live run, the transcript pane shows "Juno isn't running. Juno only runs when you send a message in Plan." Its previous runs are Plan turns, and each links to its session.

## Data

- **Agent:** name, role, runtime, group, concurrency, instructions path, caps, status.
- **Stats:** the per-role aggregates listed above.
- **Runs:** id, project, task, outcome, started, duration, tokens, branch, events.
- **Live:** an SSE stream of events for the active run.

## Accessibility

- Runs are buttons with `aria-current` on the selected one.
- The transcript is a live region; tool output is `<pre>`.
- Stop has a visible text label, not just an icon.

## Open questions

- How long are run transcripts kept? Finished runs open read-only (PRD §12), but storage isn't sized yet.
- Should the developer group allow more than one Atlas (concurrency above 1), shown as several live runs?
