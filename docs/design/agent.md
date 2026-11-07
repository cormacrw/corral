# Agent

**Canvas frames:** `App shell · Agent (Atlas)`, `Agent view (component)`
**Route:** `/agents/:name` (the Activity dashboard; it never opens a run on its own, even a live one) and `/agents/:name/:runId` (the run view)
**Scope:** global. An agent works across every project. This replaces the old Runs page.

## Purpose

See what an agent is doing right now, attach to its live run, and look back at previous runs. PRD §12 Agents view: active runs, role, task, elapsed time, usage, live output, and attach, interrupt and stop controls.

## Layout

### Header (bottom border)

- the avatar, with a ping dot while working
- the name and a status badge only for **Paused** (neutral) or **Waiting on usage limit** (neutral). Idle agents have no marker. Explicit `paused` means Paused; only a future `pausedUntil` means Waiting on usage limit. Expired cooldowns are idle. All agent screens use `agentStatus` in `utils/labels.ts`
- "{Role} · {runtime} · {summary}" (Claude Code or Codex, D18), e.g. "6 runs today". The run count is left out while the runs load or when they fail to load
- **Resume now** (outline), only while Waiting on usage limit: clears the wait so the agent can run again. If the limit is real, its next run pauses it again
- **Agent settings** (outline; goes to Settings › Agents)

### Info and stats (bottom border)

- **Stat tiles:** `StatTile`s in the Agents dashboard's grid (2 / 3 / 5 columns), each with an icon, a label, a big tabular number and a sub-line. They show on the Activity dashboard only. When the runs fail to load each reads "—" with "Couldn't load runs". They depend on the role:

  | Role | Tiles |
  |---|---|
  | Developer | Runs this week · PRs opened (incl. revisions and commits) · Stuck · Avg run · Usage today |
  | Reviewer | Reviews this week · Approved · Changes requested · Avg review · Usage today |
  | Designer | Runs this week · Design versions submitted · Designs approved · Avg run · Usage today (version counts are "—" if the design data fails) |
  | PM | Turns this week · Avg turn · Usage today |

- Avg run / review / turn has a sparkline of the median run length per day over 14 days, shown only when 2 or more days have finished runs. Its data, and the page's charts, come from `GET /api/runs?agentId=&since=<local midnight 13 days ago>` (`useAgentActivity`), so other agents' run volume can't push this agent's oldest days past the history cap. The tiles keep the latest 50 runs (`GET /api/runs?agentId=`).
- Designer tiles count authoring runs, submitted versions and design tasks whose version the human approved; they do not count PRs. The facts line shows a task worktree on `design/<ref>` and `.corral/agents/designer.md` (built-in defaults when absent; D23).
- **Facts line:** group and concurrency (for the PM, "One turn per session" instead: it has no concurrency limit beyond one turn per Plan session; D13), where it runs (one worktree per task, a read-only task worktree, or a read-only checkout of main), its instructions file (mono, e.g. `.corral/agents/developer.md`), and its caps or limits.
- Usage is in tokens, with no dollar cost on a subscription. Show it where available (agent-runtime-and-auth.md, rule 6).

### Activity (desktop, no run in the URL)

Under the tiles and facts line, a `lg:grid-cols-3` grid (`AgentDashboard`):

- Left, two columns: **Runs** (`AgentsRunTimeline`, last 7 days, one lane per day that has runs, x 00:00–24:00; a live run is a live bar in Today; empty: "No runs in the last 7 days."), then **Outcomes** (`AgentOutcomeChart`, 14 days) and **Tokens** (`AgentsTokenChart` with `only=<role>`, 14 days, no legend).
- Right: **Recent runs** (`AgentRecentRuns`), up to 42rem tall and scrolling inside the card. A live run is pinned first with a primary edge, a **Live** badge and its elapsed time. Rows are the run rows below, with errors up to two lines. Selecting one opens `/agents/:name/:runId`. Empty: "No runs yet. Runs show here once {name} picks up its first task."
- Loading: skeleton tiles, a skeleton in each chart card and skeleton rows. Load error: a "Couldn't load {name}'s activity" alert with Retry (it refetches the runs and the history), chart cards read "Unavailable", Recent runs shows `AppLoadError` with Retry, and no zero or empty-state copy shows.

### Run view (desktop, a run in the URL): two panes

1. **Runs list** (320px):
   - **← Activity** at the top goes back to the dashboard.
   - **Current run:** pinned at the top, with the working pulse.
   - **Previous runs:** each row shows the task ref ("task" for a task's integration review, "Plan" for a PM turn), when it ran, the title (the task's, or the task's for an integration review), and "{project dot} {project} · Run #128 · 18m". A run that ended with an error shows it on a line below (`error` text, up to three lines).
   - Run rows have no tags. Finished runs show their outcome only in the selected run header: PR opened / PR updated / Plan proposed (`primary`), Approved / Answered (`success`), Changes requested (`warning`), Stuck / Failed (`error`), Rate limited / Stopped / Interrupted (neutral).
2. **Run transcript:**
   - **Run header:** "{ref} {title}", the outcome badge for finished runs only, and "Run #128 · branch · 18:42 elapsed · 12k in · 3k cache write · 1.3M cache read · 4k out · $0.42 weighted, excluding input · resumed warm · on {runner name}" (the runner the run was placed on, kept with the run) (cache writes and reads are shown apart from fresh input because they cost differently; a Claude run from before cache writes were stored reads "12k in (includes cache writes)" with no cost; the weighted cost leaves out fresh input; a Codex run has no cache writes and its cost covers reads and output). On the right: **Open task** (opens the flyout) and, for live runs only, **Interrupt / Resume** (outline) and **Stop run** (`error` subtle).
   - **Run timing breakdown:** under the run header, for runs with recorded timings; older runs have none and show nothing. "Queue wait (queued to started, including preparation)", the same wording as the Flow section ([project-overview.md](project-overview.md#charts)), or Unavailable before the run starts. Then the total, a stacked bar and a table of run phases, slowest first with the largest highlighted, and a table of tools (count, total, max), slowest total first. Tool calls can overlap, so their totals are separate from run phases.
   - **Log** (`role="log"`, `aria-live="polite"`), up to 880px wide. Each entry is one of:
     - a **system divider**, e.g. "Run started in worktree …"
     - an **agent message** (highlighted text)
     - a **step group**: consecutive tool calls collapse into one row, a chevron and a plain-English summary ("Read 2 files, ran a command, attached evidence") with a pill: "{n} steps" (neutral), "Running" (`primary`, spinner) or "{n} failed" (`error`). Groups start closed and open on their own when a step failed. Open, each step is one line under a hairline: a verb ("Read", "Edited", "Ran", "Looked up the task"), the target (worktree-relative paths and commands in mono, notes in plain text) and `+42 −0` for edits. A step opens to its output's last 12 lines ("All {n} lines" shows the rest) and a "Raw input" link for the JSON; failed steps start open. CLI bookkeeping (`ToolSearch`) isn't shown.
     - a **thinking step**: the agent's reasoning, a muted italic "Thinking" row. When the reasoning has text it starts closed and a chevron opens it; when the CLI only marks that it thought, it's just the label, and consecutive empty ones show as one. An empty one right after a step group is dropped, so it never splits the group (the CLI emits one before most turns' tool calls); thinking with text ends the group and shows as its own step.
     - **your mid-run message**: a right-aligned bubble labelled "You, mid-run"
     - an **outcome card**, tinted with the outcome colour, e.g. "Stuck. Asked you a question. The task is Blocked until you answer in the Inbox."
     - a **"{Agent} is working…"** line with a ping dot while the run is live
   - **Footer:**
     - **Live run:** the composer, "Message Atlas mid-run…" with "Atlas reads this at its next step". When interrupted it reads "Tell Atlas what to do next…" and "Atlas is waiting for you". Sending posts to `POST /projects/:slug/runs/:runId/messages`; the message is kept as your comment on the task and shows in the transcript as your bubble once the runner delivers it.
     - **Live run that can't take messages:** the composer is disabled, with the reason under it. A Codex run reads "Codex can't take messages mid-run. Comment on the task and Atlas reads it on its next run." A queued or stopping run, or the runner being offline, says so the same way.
     - **Live PM turn:** no composer; the PM is messaged in Plan.
     - **Previous run:** a lock icon and "Read-only. This run finished 2h ago. To change the work, comment on the task."
3. **Task flyout:** docked on the right when you press Open task.

## Interactions

- **Attaching:** opening the page while a run is live streams its events (SSE) and ticks the timer.
- **Interrupt:** pauses the agent at its next step. Resume continues it.
- **Stop:** ends the run. The task stays in its status with no lease, and the scheduler retries under D10.
- **Mid-run messages:** go to the agent through the runner, which writes them to a Claude Code run's input. Codex runs one prompt to the end, so it can't take them.

## The PM (Juno)

Juno only runs when you message it in Plan (D9). With no live run, the transcript pane shows "Juno isn't running. Juno only runs when you send a message in Plan." Its previous runs are Plan turns, and each links to its session.

## Data

- **Agent:** name, role, runtime, group, concurrency, instructions path, caps, status.
- **Stats:** the per-role aggregates listed above.
- **Runs:** id, project, task, outcome, started, duration, tokens, branch, events.
- **Timings:** per-run phase and tool durations, delivered with `run.updated`.
- **Live:** an SSE stream of events for the active run.

## Accessibility

- Runs are buttons with `aria-current` on the selected one.
- The transcript is a live region; tool output is `<pre>`.
- Stop has a visible text label, not just an icon.

## Open questions

- How long are run transcripts kept? Finished runs open read-only (PRD §12), but storage isn't sized yet.
- Should the developer group allow more than one Atlas (concurrency above 1), shown as several live runs?

## Agents page

**Route:** `/agents`, from the sidebar's **Agents** item and Home's **All agents**. Every agent at once; the sections above are one agent's page.

- **Header:** "Agents" and **Add agent** (outline), which opens Settings › Agents.
- **Stat tiles:** Runs today (with how many failed), Tokens today (input, cache writes and output, against the daily average of the rest of the 14 days), Working (working of total, with how many are paused), Usage limits (agents waiting out a usage limit, D3) and Runner (online or offline, with `runnerSummary`). Corral has no plan-usage percentage to show: it never handles provider credentials (D1–D2), so there are no usage gauges.
- **Runs:** a swimlane timeline of the last 12 hours, one lane per agent in the shell's order, with now at the right. Each run is a bar from start to end, or to now while live; runs that never started aren't shown. Colour says how it ended: Live, Finished, Changes requested, Failed or stuck, and Interrupted or rate limited (muted, since neither is a failure). Hovering a bar names the agent, the task ref (or Task, or Plan), the outcome and the duration.
- **Tokens by role:** a stacked area chart of tokens per day over 14 days for developers, reviewers, the PM and the designer, with a crosshair tooltip.
- **Agents:** one row per agent linking to its page: avatar with the working dot, name, role and runtime, a status label for Paused or Waiting on usage limit, a bar for the share of the last 12 hours spent running (out of its concurrency; the PM counts as one slot), and today's run count.
- **Data:** `GET /api/runs?since=<local midnight 13 days ago>` returns every run queued since then (up to 2000), shared with Home; `run.updated` events keep it current.

