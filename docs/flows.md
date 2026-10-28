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
 │               │ send pm.turn job ─────────────▶│ fetch, update read-only   │
 │               │                                │ checkout of default branch│
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
| `ask_question` | A structured question, shown in the Plan conversation only, never in the Inbox (D11) |
| `propose_plan` | Create or revise a draft plan: epics, tasks, acceptance criteria, dependencies, priority, task type, human-review flag |
| `approve_plan` | Approve the current plan (to the board or the Backlog) when the human asks in chat. Recorded as the human's approval; refused unless the human has written since the plan was proposed |
| `flag_stale_docs` | Create a documentation task (PRD §7.10) |

The PM has **no** tools to merge, edit docs or change status. This is enforced by which tools it's given, not by its instructions.

### Editing and approving a plan

- **Direct edits:** the human edits a task card inline. The change is saved through the API and recorded in the audit log with the human as actor.
- **Edits through chat:** e.g. "split task 3, drop the dark-mode bit". The PM calls `propose_plan` again, producing plan v2, and the UI shows the differences from v1.
- **Drafts:** the plan's tasks are created as **Drafts**. They appear only in the plan card and its flyout, never on the board or in the Backlog, and a revision can still change or remove them.
- **Approval:** two buttons call an endpoint that only accepts a human actor. **Add to board** moves each Draft → Ready, onto the board; tasks with unmerged dependencies are still Ready and their cards show "waiting on #N". **Add to backlog** moves each Draft → Backlog, to be scheduled later or refined further. The flyout offers the same two choices for a single task.

### Sessions and cost

- The `claude` session ID is stored with the conversation in the database. If the session is lost (e.g. the runner's disk was wiped), the next turn starts a fresh session seeded with a summary built from the database messages. The database is the source of truth; `~/.claude` is only a cache.
- A PM turn runs only when the human sends a message. Nothing goes back to the PM when tasks or epics merge.

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
2. `git worktree add worktrees/<taskId> -b corral/<taskId>-<slug> origin/main` (or reuse the existing worktree on a revision)
3. `pnpm install`
4. Write the per-run MCP config.
5. Spawn `claude` in its own process group, with no `GH_TOKEN` in its environment.

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
