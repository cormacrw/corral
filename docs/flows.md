# Flows

Step-by-step walkthroughs of Corral's two main flows. Uses the statuses and transitions from D10 and the PM design from D9 ([decisions.md](decisions.md)); storage and process roles are in [architecture.md](architecture.md).

---

## 1. Talking to the PM

The PM is a runner job with role `pm` (D9). It never runs on the server.

### One message, end to end

```
web            server                          runner                     claude (pm)
 │ POST message  │                                │                           │
 │──────────────▶│ save message to DB             │                           │
 │               │ send pm.turn job ─────────────▶│ fetch, update session's   │
 │               │                                │ read-only checkout        │
 │               │                                │ claude -p --resume <sid> ─▶│
 │               │                                │                           │ reads CORRAL.md, wiki, code
 │               │◀──── MCP: list_tasks ──────────│◀──────────────────────────│ checks current board state
 │               │◀──── streamed tokens ──────────│◀──────────────────────────│
 │◀── SSE ───────│                                │                           │
 │               │◀──── MCP: propose_plan(...) ───│◀──────────────────────────│
 │               │ validate (core): DAG, criteria,│                           │
 │               │ sizes → save plan v1 (Drafts)  │                           │
 │◀── SSE: plan cards                             │                           │
```

### PM tools

| Tool | Purpose |
|---|---|
| `list_tasks`, `get_task`, `get_run_outcomes` | Live board state, so answers reflect current state, not only chat history (PRD §7.2) |
| `get_attachment` | An image pasted into task text (`attachment:<id>`), returned as image content with its file name and mime type. Only attachments in the run's own project; developers and reviewers have it too |
| `ask_question` | A structured question, shown in the Plan conversation only, never in the Inbox (D11). Optionally with a `recommendation` (the PM's suggested answer) and `options` (2–5 short choices, each at most 120 characters). Both are stored on the message and shown, options numbered, in the history the PM sees on later turns |
| `propose_plan` | Create or revise a draft plan: epics, tasks, acceptance criteria, dependencies, priority, task type (`task`, `bug`, `spike` or `design`, D19, D20), human-review flag, and for build tasks the design version and screens they pin (D20) |
| `approve_plan` | Approve the current plan (to the board or the Backlog) when the human asks in chat. Recorded as the human's approval; refused unless the human has written since the plan was proposed |
| `flag_stale_docs` | Create a documentation task (PRD §7.10) |
| `get_design` | A design version's `design.md` spec, screen ids, screenshots, branch and commit, and its sandboxed preview URL (D20). Developers and reviewers have it too: a design task's latest version by default, or a build task's pinned one |

### Developer and reviewer design tools (D20)

| Tool | Who | Purpose |
|---|---|---|
| `submit_design` | Developer, design tasks only | Submit the static bundle folder, `design.md` and screenshots. The runner pushes the `design/<ref>` branch and uploads the files; the server records a new immutable version at that commit. The run then ends with `report_outcome('design_submitted')` |
| `get_design` | Developer, reviewer, PM | Read a design version (above). The reviewer uses it to check a submission; a build task's developer uses it to read its pinned screens |

Agents are told about images so they look at them: a PM turn whose message references `attachment:<id>` lists the ids and asks the PM to fetch them first; developer and reviewer prompts have an "Attached images" section (id, file name, and whether each is in the description or which comment); and `get_task` returns an `attachments` list of the same, for every role.

**Grilling.** A message that asks to be grilled ("grill me", `/grill-me`, or the Grill me button's message) gets the grill-me skill's instructions, adapted to Corral, put before it: work through the decisions in dependency order, one `ask_question` per decision, always with a `recommendation` and with `options` where the answer is one of a few; look up anything the code or board can answer instead of asking; and once the decisions are settled, or the human says to stop, call `propose_plan` straight away with the agreed decisions in its summary. Other messages don't get these instructions, so the PM never grills unless asked. A session rebuilt after it was lost keeps grilling if an earlier human message asked for it.

The PM has **no** tools to merge, edit docs or change status. This is enforced by which tools it's given, not by its instructions.

### Editing and approving a plan

- **Direct edits:** the human edits a task card inline. The change is saved through the API and recorded in the audit log with the human as actor.
- **Edits through chat:** e.g. "split task 3, drop the dark-mode bit". The PM calls `propose_plan` again, producing plan v2, and the UI shows the differences from v1.
- **Epics:** a plan can span several epics, one per multi-task feature. A task names its epic with `epic`; a task without one has no epic, and a plan without `epics` creates none (a lone small fix needs no epic). A revision keeps every epic it still names (by key); an epic it drops is deleted once it has no tasks left.
- **Drafts:** the plan's tasks are created as **Drafts**. They appear only in the plan flyout, never on the board or in the Backlog, and a revision can still change or remove them.
- **Refining Backlog tasks:** a plan task with a `ref` (e.g. `COR-4`) revises that existing task instead of creating a Draft, so refining doesn't leave a duplicate. Only Backlog tasks (or Drafts) can be referenced; `propose_plan` rejects a ref that's unknown, deleted, in another project or in any other status, and says why. The edits (title, description, type, priority, human review, criteria, epic, dependencies) are staged on the plan, and the task is unchanged until approval. `dependsOn` may name refs of existing tasks too. Dropping a referenced task from a later version only un-stages it; it's never deleted.
- **Approval:** two buttons call an endpoint that only accepts a human actor. **Add to board** moves each Draft → Ready, onto the board; tasks with unmerged dependencies are still Ready and their cards show "waiting on #N". **Add to backlog** moves each Draft → Backlog, to be scheduled later or refined further. A revised Backlog task first gets the plan's edits (criterion IDs are kept where the text is unchanged, and a `task.revised` audit entry is written), then goes to Ready with **Add to board** or stays in Backlog with **Add to backlog**. If it has left the Backlog since the plan was proposed, approval is refused and nothing is written. A single Draft can't be placed on its own; the task flyout offers no buttons for it.

### Sessions and cost

- The agent session ID (from `claude` or `codex`; the session's runtime is locked once it has messages, D18) is stored with the conversation in the database. If the session is lost (e.g. the runner's disk was wiped), the next turn starts a fresh session seeded with a summary built from the database messages. The database is the source of truth; `~/.claude` and `~/.codex` are only caches.
- A PM turn runs only when the human sends a message, or approves a design version, which opens a Plan session for the build with the human's message (D20). Nothing goes back to the PM when tasks or epics merge.
- **One checkout and one turn per session.** Each Plan session gets its own read-only checkout of the default branch, kept between turns so the agent CLI can resume the session. A session runs one turn at a time: a second message while its turn is active gets 409 `pm_turn_in_progress`, and the session's `activeRunId` is that turn. Other sessions, in the same project or another, can talk to Juno meanwhile.
- **Warm process between turns** (D9). After a turn, its agent CLI process stays alive for `CORRAL_PM_WARM_SECONDS` (default 5 minutes). A message within that time goes to the same process over stdin, after the checkout is reset to fresh code, so the reply skips CLI startup. After the timeout, or if the model or session changed, the next turn cold-starts with `--resume`.
- **Juno's concurrency still applies** (D13, global across projects). A turn over the limit is accepted and waits as `queued`; it's sent to the runner, oldest first, when another PM turn ends.

---

## 2. A task from Ready to Merged

Remember the D10 rule: **status = whose turn it is; the lease = whether a run is active.** The scheduler starts a run for a task in Ready, In progress or Agent review that has no lease, if its group has capacity.

### Step 1 — Approve → Ready

Approval writes the status change and an audit entry, then triggers an immediate scheduler check.

### Step 2 — Claim (server, no model call)

The scheduler checks: project and group not paused, the task not paused, developer group under its concurrency limit, runner online, and the task is Ready with all dependencies Merged. Then it claims in one statement:

```sql
UPDATE tasks SET status = 'in_progress', lease_epoch = lease_epoch + 1, ...
WHERE id = (SELECT id FROM tasks WHERE <eligible> ORDER BY priority
            LIMIT 1 FOR UPDATE SKIP LOCKED)
RETURNING id, lease_epoch;
```

It creates a run (Queued) and a 15-minute lease, then sends `job.assign` (RunJob + lease epoch) to the runner.

### Step 3 — Set up the workspace (runner)

1. `git fetch`
2. `git worktree add worktrees/<taskId> -b corral/<taskId>-<slug> origin/main` (or reuse the existing worktree on a revision). A design task's branch is `design/<ref>` instead, pushed but never merged (D20)
3. `pnpm install`
4. Write the per-run MCP config.
5. Spawn the agent's CLI (`claude` or `codex`, D18) in its own process group, with no `GH_TOKEN` in its environment, and with `GIT_AUTHOR_*`/`GIT_COMMITTER_*` set from `CORRAL_GIT_AUTHOR_NAME`/`CORRAL_GIT_AUTHOR_EMAIL` when both are configured (the runner warns at startup when they aren't).

Run: Starting → Running. A heartbeat every 2 minutes renews the lease, and every heartbeat carries the lease epoch.

### Step 4 — Developer works (agent)

1. Reads `CORRAL.md`, relevant wiki pages, and pinned comments.
2. Implements the task; runs lint, typecheck and tests.
3. Starts the app, captures screenshots/video with the agent browser, and calls `attach_evidence` per criterion.
4. Updates the wiki; commits.
5. Calls `report_outcome('pr_opened', summary)`, or `pr_updated` on a revision.

### Step 5 — Submit (runner → server)

1. The runner pushes the branch.
2. The server validates the outcome: branch at the expected commit, evidence for every criterion. If anything is missing, the outcome is rejected and the agent is told what's missing while it's still running.
3. If valid, the server opens or updates the PR (summary, per-criterion checklist, link to the evidence page) and moves **In progress → Agent review**.
4. The run ends Completed and the lease is released. The runner kills the agent's process tree but **keeps the worktree** for possible revisions.

### Step 6 — Agent review

1. The scheduler sees an Agent review task with no lease and no verdict for the current commit, and claims a reviewer lease.
2. The runner creates a separate review worktree at the PR commit (`worktrees/<taskId>-review`).
3. The reviewer reads the diff, the criteria and the evidence (`get_evidence`), and may run tests.
4. It calls `report_outcome('approved' | 'changes_requested')` with a verdict per criterion and its reasoning. The server records review round N, tied to that commit.

### Step 7a — Changes requested

- **Agent review → In progress** (no lease), with the feedback posted as a comment.
- The next developer run works in the **same worktree and branch**, reports `pr_updated`, and the flow returns to step 5.
- If this would be round 6 (past the cap of 5): **→ Blocked**, and the human is notified.

### Step 7b — Approved

- **Flagged for human review:** → **Human review**. It appears in the Inbox (D11) as a short note with each criterion next to its evidence, and approve and request-changes actions. Human approves → **Ready to merge** (the Inbox item resolves at once), or requests changes → In progress.
- **Not flagged:** → **Ready to merge**.

### Step 7c — Ready to merge: wait for CI and the base branch

The task waits in Ready to merge. Waiting is a webhook or a cheap polling check, never an agent.

- **CI fails:** → In progress with the logs attached.
- **The base branch has moved:** the server calls GitHub's "update branch" API (no local git needed). A conflict → In progress for the developer. A clean update keeps the approval (R7 default).
- **Any other new commit:** → Agent review for a fresh review.

### Step 8 — Final gate check

A pure function in `packages/core`, run against live GitHub data:

- The approval is for the current commit.
- Required CI checks passed.
- Evidence is complete.
- The task isn't Blocked or Failed.
- The PR is mergeable.

When every gate passes → step 9.

### Step 9 — Merge (server)

1. Merge through the GitHub API with the configured method; record the merge commit.
2. If the result is ambiguous (e.g. a timeout), re-read the PR state before deciding. Never mark Merged without seeing a merged state.
3. **→ Merged**, with an audit entry.

### Step 10 — Cleanup and what follows

- The runner removes the worktrees. If one somehow has uncommitted changes, it's kept and flagged.
- Tasks that depended on this one become eligible; the scheduler checks again.

---

### Design tasks (D20)

A design task follows steps 1–7 with these differences: the developer builds a prototype from the project's real components with mock data, produces the static bundle the way the project's `CLAUDE.md`/`CORRAL.md` says, calls `submit_design` and reports `design_submitted`. No PR is opened. After Agent review it always goes to **Human review**. Request changes → In progress, and the next submission is a new version. Approve → **Approved**: the version is approved, earlier ones are superseded, and a Plan session for the build starts. Steps 7c–10 don't apply.

---

## 3. When things go wrong

| Event | Result |
|---|---|
| Agent crashes | Run → Failed (after reconciliation), lease released; task stays in its status and is retried. 3 failed runs → task **Failed** |
| Laptop sleeps / runner disconnects | Heartbeat stops → lease expires → stale writes rejected by epoch → reconcile, then retry |
| Usage limit hit | Run outcome `rate_limited`; group paused until reset; not counted as a failure (D3) |
| Human stops a run | Process tree killed, run → Interrupted; the task is **paused** so the scheduler doesn't restart it until the human resumes it |
| Agent reports `stuck` | Task → **Blocked** |
| Review cap reached | Task → **Blocked** |
| Unrecoverable error / unsafe merge failure | Task → **Failed** |
| Human deletes the task | Run stopped, PR closed, branch removed when safe, task soft-deleted; dependents → Blocked (D10) |
