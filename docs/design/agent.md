# Agent

**Canvas frames:** `App shell · Agent (Atlas)`, `Agent view (component)`
**Route:** `/agents/:name` (current run, or the latest run) and `/agents/:name/runs/:runId`
**Scope:** global. An agent works across every project. This replaces the old Runs page.

## Purpose

See what an agent is doing right now, attach to its live run, and look back at previous runs. PRD §12 Agents view: active runs, role, task, elapsed time, usage, live output, and attach, interrupt and stop controls.

## Layout

### Header (bottom border)

- the avatar, with a ping dot while working
- the name and a status badge only for **Working** (`success`), **Paused** (neutral) or **Waiting on usage limit** (neutral). Idle agents have no marker. Explicit `paused` means Paused; only a future `pausedUntil` means Waiting on usage limit. Expired cooldowns are idle. All agent screens use `agentStatus` in `utils/labels.ts`
- "{Role} · {runtime} · {summary}" (Claude Code or Codex, D18), e.g. "6 runs today"
- **Agent settings** (outline; goes to Settings › Agents)

### Info and stats (bottom border)

- **Stat tiles:** an auto-fit grid with a 150px minimum. Each tile has a label, a big tabular number and a sub-line. They depend on the role:

  | Role | Tiles |
  |---|---|
  | Developer | Runs this week · PRs merged · First-pass approval · Avg run · Usage today |
  | Reviewer | Reviews this week · Approved · Changes requested (avg rounds per task) · Avg review · Usage today |
  | PM | Turns this week · Plans approved · Tasks proposed · Avg turn · Usage today |

- **Facts line:** group and concurrency (for the PM, "One turn per session" instead: it has no concurrency limit beyond one turn per Plan session; D13), where it runs (one worktree per task, a read-only task worktree, or a read-only checkout of main), its instructions file (mono, e.g. `.corral/agents/developer.md`), and its caps or limits.
- Usage is in tokens, with no dollar cost on a subscription. Show it where available (agent-runtime-and-auth.md, rule 6).

### Body: two panes

1. **Runs list** (320px):
   - **Current run:** pinned at the top, with the working pulse.
   - **Previous runs:** each row shows the task ref, an outcome badge, when it ran, the title, and "{project dot} {project} · Run #128 · 18m".
   - **Outcome badges:** Live (`primary`), PR opened / PR updated / Plan proposed (`primary`), Approved / Answered (`success`), Changes requested (`warning`), Stuck / Failed (`error`), Rate limited / Stopped / Interrupted (neutral).
2. **Run transcript:**
   - **Run header:** "{ref} {title}", the outcome badge, and "Run #128 · branch · 18:42 elapsed · 12k in · 1.3M cache read · 4k out" (cache reads are shown apart from fresh input, which includes cache writes, because they cost about a tenth as much). On the right: **Open task** (opens the flyout) and, for live runs only, **Interrupt / Resume** (outline) and **Stop run** (`error` subtle).
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
- **Live:** an SSE stream of events for the active run.

## Accessibility

- Runs are buttons with `aria-current` on the selected one.
- The transcript is a live region; tool output is `<pre>`.
- Stop has a visible text label, not just an icon.

## Open questions

- How long are run transcripts kept? Finished runs open read-only (PRD §12), but storage isn't sized yet.
- Should the developer group allow more than one Atlas (concurrency above 1), shown as several live runs?
