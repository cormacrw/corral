# Flows

Step-by-step walkthroughs of Corral's main flows. Uses the statuses and transitions from D10 and the PM design from D9 ([decisions.md](decisions.md)); storage and process roles are in [architecture.md](architecture.md).

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

The PM can also call `attach_evidence` to attach a scratch file to the conversation, or pass `taskRef` to attach it to a task in this project. It shares the developer upload checks: the resolved path must stay inside scratch and the file must be at most 25 MB.

| Tool | Purpose |
|---|---|
| `list_tasks`, `get_task`, `get_run_outcomes` | Live board state, so answers reflect current state, not only chat history (PRD §7.2) |
| `add_comment` | Leave a comment on any task in the project by ref, e.g. that a follow-up task changes its behaviour. Attributed to the PM agent; a ref outside the project is rejected. Developers and reviewers have it too, for their own task |
| `get_attachment` | An image pasted into task text (`attachment:<id>`), returned as image content with its file name and mime type. Only attachments in the run's own project; developers, designers and reviewers have it too |
| `ask_question` | A structured question, shown in the Plan conversation, and in the Inbox while it's pending (as its Plan thread, D11). Optionally with a `recommendation` (the PM's suggested answer) and `options` (2–5 short choices, each at most 120 characters). Both are stored on the message and shown, options numbered, in the history the PM sees on later turns |
| `propose_plan` | Create or revise a draft plan: epics, tasks, acceptance criteria, dependencies, priority, task type (`task`, `bug`, `spike` or `design`, D19, D20), human-review flag, and for build tasks the design version and screens they pin (D20) |
| `approve_plan` | Approve the current plan (to the board or the Backlog) when the human asks in chat. Recorded as the human's approval; refused unless the human has written since the plan was proposed |
| `flag_stale_docs` | Create a documentation task (PRD §7.10) |
| `get_design` | A design version's `design.md` spec, screen ids, screenshots, branch and commit, and its sandboxed preview URL (D20). Takes a design task's ref (its latest version by default, or a given `version`) or a build task's ref (its pinned version and screens). The runner saves the spec and screenshots in the agent's scratch folder and extracts the bundle (a tar) there, and returns the paths. Developers, designers and reviewers have it too |

### Design tools (D20, D23)

| Tool | Who | Purpose |
|---|---|---|
| `submit_design` | Designer, design tasks only | Submit the static bundle folder, `design.md` and screenshots. The runner pushes the `design/<ref>` branch and uploads the files; the server records a new immutable version at that commit. The run then ends with `report_outcome('design_submitted')` |
| `get_design` | Designer, developer, reviewer, PM | Read a design version (above). The designer uses it to read existing versions; the reviewer uses it to check a submission; a build task's developer uses it to read its pinned screens |

Agents are told about images so they look at them: a PM turn whose message references `attachment:<id>` lists the ids and asks the PM to fetch them first; developer, designer and reviewer prompts have an "Attached images" section (id, file name, and whether each is in the description or which comment); and `get_task` returns an `attachments` list of the same, for every role.

**Grilling.** A message that asks to be grilled ("grill me", `/grill-me`, or the Grill me button's message) gets the grill-me skill's instructions, adapted to Corral, put before it: work through the decisions in dependency order, one `ask_question` per decision, always with a `recommendation` and with `options` where the answer is one of a few; look up anything the code or board can answer instead of asking; and once the decisions are settled, or the human says to stop, call `propose_plan` straight away with the agreed decisions in its summary. Other messages don't get these instructions, so the PM never grills unless asked. A session rebuilt after it was lost keeps grilling if an earlier human message asked for it.

The PM has **no** tools to merge, edit docs or change status. This is enforced by which tools it's given, not by its instructions.

### Editing and approving a plan

- **Direct edits:** the human edits a task card inline. The change is saved through the API and recorded in the audit log with the human as actor.
- **Edits through chat:** e.g. "split task 3, drop the dark-mode bit". The PM calls `propose_plan` again, producing plan v2, and the UI shows the differences from v1.
- **Epics:** a plan can span several epics, one per multi-task feature. A task names its epic with `epic`; a task without one has no epic, and a plan without `epics` creates none (a lone small fix needs no epic). A revision keeps every epic it still names (by key); an epic it drops is deleted once it has no tasks left.
- **Drafts:** the plan's tasks are created as **Drafts**. They appear only in the plan flyout, never on the board or in the Backlog, and a revision can still change or remove them.
- **Design pins (D20):** a plan task's `design: { taskRef, version, screens }` pins it to a design version and the screen ids from its `design.md`. `propose_plan` rejects a pin to a version that isn't approved, to an unknown version or a task that isn't a design, and a pin without screens. A Draft gets its pin at once; a revised task's pin is staged with its other edits. The pin is shown in the task's properties.
- **Refining existing tasks:** a plan task with a `ref` (e.g. `COR-4`) revises that existing task instead of creating a Draft, so refining doesn't leave a duplicate. Only Backlog tasks, Ready tasks with no lease and no runs yet, or Drafts can be referenced; `propose_plan` rejects a ref that's unknown, deleted, in another project or in any other status, and a Ready task that's already been picked up, and says why. The edits (title, description, type, priority, human review, criteria, epic, dependencies) are staged on the plan, and the task is unchanged until approval. `dependsOn` may name refs of existing tasks too. Dropping a referenced task from a later version only un-stages it; it's never deleted.
- **Approval:** two buttons call an endpoint that only accepts a human actor. **Add to board** moves each Draft → Ready, onto the board; tasks with unmerged dependencies are still Ready and their cards show "waiting on #N". **Add to backlog** moves each Draft → Backlog, to be scheduled later or refined further. A revised Backlog task first gets the plan's edits (criterion IDs are kept where the text is unchanged, and a `task.revised` audit entry is written), then goes to Ready with **Add to board** or stays in Backlog with **Add to backlog**. A revised Ready task gets the same edits and stays in Ready with either button. If a revised task has been claimed, has left Backlog and Ready, or was deleted since the plan was proposed, approval is refused with a problem naming it, nothing is written, and the plan stays proposed. A single Draft can't be placed on its own; the task flyout offers no buttons for it.

### Closing a Plan thread

`POST /api/plan/sessions/:id/close` stops any active PM turn first. In one transaction it soft-deletes only the session's owned Drafts (ownership follows `draftSessions`), with reason "Discarded with the Plan thread", discards its proposed, unapproved plan and sets `closedAt`. Ready, Backlog and later tasks are preserved. Closing an already closed session changes nothing. The server publishes `plan.session` and `plan.drafts` so the Inbox, open thread tabs and Drafts update live; the discarded plan cannot be approved. Sending another message reopens the conversation with no Drafts or pending plan.

### Sessions and cost

- The agent session ID (from `claude` or `codex`; the session's runtime is locked once it has messages, D18) is stored with the conversation in the database. If the session is lost (e.g. the runner's disk was wiped), the next turn starts a fresh session seeded with a summary built from the database messages. The database is the source of truth; `~/.claude` and `~/.codex` are only caches.
- A PM turn runs only when the human sends a message, or approves a design version, which opens a Plan session for the build with the human's message (D20). Nothing goes back to the PM when tasks or epics merge.
- **One checkout and one turn per session.** Each Plan session gets its own read-only checkout of the default branch, kept between turns so the agent CLI can resume the session. A session runs one turn at a time: a second message while its turn is active gets 409 `pm_turn_in_progress`, and the session's `activeRunId` is that turn. Other sessions, in the same project or another, can talk to Juno meanwhile.
- **Warm process between turns** (D9). After a turn, its agent CLI process stays alive for `CORRAL_PM_WARM_SECONDS` (default 5 minutes). A message within that time goes to the same process over stdin, after the checkout is reset to fresh code, so the reply skips CLI startup. After the timeout, or if the model or session changed, the next turn cold-starts with `--resume`.
- **Juno has no concurrency** (D13): one turn per session is the only limit, so a message to any other session starts its turn right away. A turn waits as `queued` while Juno is paused, the runner can't take it, or an update hold is finishing (D16), and is sent, oldest first, once that clears. During the draining phase of an update, PM turns still start normally; once workers and merges finish, new messages are saved with their jobs held until the hold is lifted or the server restarts.

---

## 2. A task from Ready to Merged

Remember the D10 rule: **status = whose turn it is; the lease = whether a run is active.** The scheduler starts a run for a task in Ready, In progress or Agent review that has no lease, if its group has capacity.

### Step 1 — Approve → Ready

Approval writes the status change and an audit entry, then triggers an immediate scheduler check.

### Step 2 — Claim (server, no model call)

The scheduler checks: project and group not paused, the task not paused, developer group under its concurrency limit, runner online, and the task is Ready or unleased In progress with all dependencies Merged. An agent with a wake interval starts at most one task of its own choosing per interval, counted from when its last run started. Only the task an event is about skips that wait: a task the human approved or acted on, the tasks of an approved plan, and a task handed on by a pushed PR or a review verdict. Other passes, such as a run ending, a runner reconnecting, a settings change or the kill switch's Resume everything, leave the agent's waiting work for the interval. Resuming a paused task counts as acting on that task, so it skips the wait.

Developer claims sort by priority (urgent first), then In progress before Ready within that priority, then oldest creation time and id. Placement skips tasks no runner can take and continues through this same stable order across candidate pages. Reviewer claims remain priority, creation time, then id. Then it claims in one statement:

```sql
UPDATE tasks SET status = 'in_progress', lease_epoch = lease_epoch + 1, ...
WHERE id = (SELECT id FROM tasks WHERE <eligible> ORDER BY priority,
            CASE WHEN status = 'in_progress' THEN 0 ELSE 1 END, created_at, id
            LIMIT 1 FOR UPDATE SKIP LOCKED)
RETURNING id, lease_epoch;
```

It creates a run (Queued) and a 15-minute lease, then sends `job.assign` (RunJob + lease epoch) to the runner.

### Step 3 — Set up the workspace (runner)

1. `git fetch`
2. `git worktree add worktrees/<taskId> -b corral/<taskId>-<slug> origin/<base>` (or reuse the existing worktree on a revision). The base is the project's target branch (`defaultBranch`), or the epic branch for a task in an `epic` or `each_task` epic (D27; see section 4). A design task's branch is `design/<ref>` instead, pushed but never merged (D20)
3. `pnpm install`
4. Write the per-run MCP config.
5. Spawn the agent's CLI (`claude` or `codex`, D18) in its own process group, with no `GH_TOKEN` in its environment, and with `GIT_AUTHOR_*`/`GIT_COMMITTER_*` set from `CORRAL_GIT_AUTHOR_NAME`/`CORRAL_GIT_AUTHOR_EMAIL` when both are configured (the runner warns at startup when they aren't).

Keep criterion evidence separate from agent artifacts (D21): logs, test output and other raw files are retained for review and debugging, collapsed in the UI.

Run: Starting → Running. A heartbeat every 2 minutes renews the lease, and every heartbeat carries the lease epoch.

### Step 4 — Developer works (agent)

1. Reads `CORRAL.md`, relevant wiki pages, and pinned comments.
2. Implements the task; runs lint, typecheck, tests and build as gates (D21). Checks are never attached as criterion evidence.
3. Skips checks and evidence for criteria marked **Checked by a human** (D28). Produces human evidence for every other criterion: screenshots/video of the running app with the agent browser, real requests and responses, or before/after metrics. Calls `attach_evidence` for files. A criterion with nothing visual to show can instead use a written explanation without a file (`attach_evidence` with `kind: "note"` and no path) (for example, a refactor with no behaviour change); the reviewer judges it and its verdict note is the proof (D21).
4. Updates the wiki; commits.
5. Calls `report_outcome('pr_opened', summary, note)`, or `pr_updated` on a revision. Every developer or designer outcome (`pr_opened`, `pr_updated`, `findings_reported`, `design_submitted`, `stuck`, `failed`) carries a required `note`: one line of at most 200 characters saying what the run did, e.g. "Addressed review: dropped idle-thread fixture". The server posts it as a comment by the developer agent in the same transaction as the outcome, so the task's comments read developer → reviewer → system in the order things happened. An outcome without a note, or with one over the limit or on several lines, is rejected with what to fix.

### Step 5 — Submit (runner → server)

1. The runner pushes the branch.
2. The server validates the outcome: branch at the expected commit, human evidence for every agent-checkable criterion (excluding human checks, D28), including note-only explanations where appropriate (D21). Check output is an agent artifact, not criterion evidence. If anything is missing, the outcome is rejected and the agent is told what's missing while it's still running.
3. If valid, the server opens or updates the PR (summary, per-criterion checklist, link to the evidence page) and moves **In progress → Agent review**.
4. The run ends Completed and the lease is released. The runner kills the agent's process tree but **keeps the worktree** for possible revisions.

### Step 6 — Agent review

1. The scheduler sees an Agent review task with no lease and no verdict for the current commit and review round since the latest submission, and claims a reviewer lease.
2. The runner creates a separate review worktree at the PR commit (`worktrees/<taskId>-review`).
3. The reviewer reads the criteria and the evidence (`get_evidence`), and reviews the diff for security, efficiency and logic problems, raising each as specific, actionable feedback. Its prompt says whether the project has required CI checks (D26). With required checks, CI verifies lint, typecheck, tests and build (D21) and the merge gate enforces them, so the reviewer doesn't rerun them; it may run a targeted test or the app when that's the best way to check a criterion or a suspected bug. With none, nothing else verifies the gates, so it runs all four itself without the cache. For Turbo projects that means `TURBO_FORCE=1 pnpm run lint`, `TURBO_FORCE=1 pnpm run typecheck`, `TURBO_FORCE=1 pnpm run test` and `TURBO_FORCE=1 pnpm run build`; if a check cannot be run without the cache, the reviewer explains which check and why in its outcome. A cached result never counts as verification.
4. It calls `report_outcome('approved' | 'changes_requested')` with a verdict and reasoning for every agent-checkable criterion. It omits criteria marked **Checked by a human** and must not request changes over those checks or missing evidence; the server records **Needs human check** (`met: null`) for them (D28). It judges note-only explanations as well as files; its per-criterion verdict note is the proof for note-only evidence (D21). The server records review round N, tied to that commit.

### Step 7a — Changes requested

- **Agent review → In progress** (no lease), with the feedback posted as a comment.
- The next developer run works in the **same worktree and branch**, reports `pr_updated`, and the flow returns to step 5.
- If this would be round 6 (past the cap of 5): **→ Blocked**, and the human is notified.
- If the previous round also requested changes and this feedback repeats it (normalised token similarity of the summary and unmet-criterion notes at or above 0.8, `REPEATED_FEEDBACK_THRESHOLD` in `packages/core`): **→ Blocked** with "The reviewer asked for the same changes twice", and it reaches the Inbox like any Blocked task. The score is kept in the `review.recorded` and `task.transition` audit entries. The round cap still applies on its own.

### Step 7b — Approved

- **Flagged for human review:** → **Human review**. It appears in the Inbox (D11) as a short note with each criterion next to its evidence, and approve and request-changes actions. Human approves → **Ready to merge** (the Inbox item resolves at once), or requests changes → In progress.
- **Any criterion checked by a human (D28):** → **Human review**, even with `humanReview: false`. The Inbox lists these criteria as **Needs human check**; the human ticks each before approving. Approval resolves the Inbox item and follows the normal merge gates, which do not require agent evidence for these checks.
- **Not flagged and no criteria checked by a human:** → **Ready to merge**, unless an existing task-type or epic rule requires Human review.
- **In an `each_task` epic (D27):** always → **Human review**, whatever the flag.

### Step 7c — Ready to merge: wait for CI and the base branch

Adding a new human check while Ready to merge returns the task to **Human review** (`require_human_check`, D28). Otherwise the task waits in Ready to merge. Its base branch is the project's target branch, or the epic branch for a task in an `epic` or `each_task` epic (D27). Waiting is a webhook or a cheap polling check, never an agent.

- **CI fails:** → In progress with the logs attached.
- **The base branch has moved:** the server asks GitHub to rebase the branch onto the base (GraphQL `updatePullRequestBranch` with `updateMethod: REBASE`, so no local git is needed and the base is never merged in). A clean rebase keeps the approval and CI runs again on the new head: the server recorded that it asked for the update, so the new head counts as mechanical. A conflict (`base_conflict`) → **In progress** for a **rebase-only round**, excluded from `reviewRoundCap` ([D24](decisions.md#d24--rebase-only-rounds-preserve-approved-work)). The developer only rebases onto `origin/<default>` (or `origin/<base branch>` for an epic-based task PR), resolves conflicts preserving both sides' intent without reverting newly merged work, and re-runs the gates; no feature changes. It reports `pr_rebased` → **Agent review** for a **rebase review**: compare approved and new heads with `git range-diff`, check every conflicted hunk against the base's change, and check any binding docs the base changed. The gates follow the same rule as any review: left to required CI, or run without the cache when the project has none (D26). A clean resolution carries over approval and previous criteria verdicts → **Ready to merge**, with CI and merge gates on the new head. Changes requested start a normal round; a changed binding decision that the criteria rely on instead → **Blocked** for the human, never an agent picking a side.
- **Any other new commit:** → Agent review for a fresh review.

### Spikes: findings instead of a PR (D19)

A `spike` follows steps 1–7 with these differences, and never reaches step 7c:

- **Step 3:** the job has no branch. The developer's worktree is a detached checkout of the default branch (kept between revisions); the reviewer's is too.
- **Steps 4–5:** the developer investigates without changing code, attaches evidence per criterion, and reports `findings_reported` with its findings (answer, evidence, recommendation, suggested follow-up tasks). The server checks the evidence, posts the findings on the task as a `## Findings` comment, and moves **In progress → Agent review**. Nothing is pushed and no PR is opened.
- **Step 6:** the reviewer judges the latest findings, which are in its prompt, against every agent-checkable criterion and its evidence (human checks are reserved as in D28). There is no diff.
- **Step 7a:** changes requested works exactly as for any task.
- **Step 7b:** approved → **Human review**, whatever the flag. The Inbox shows the latest findings. Human approval → **Merged** with `mergedAt` set, and dependent tasks unblock; requesting changes → In progress with the feedback for the developer. The worktrees are cleaned up after completion as in step 10.

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

### Design tasks (D20, D23)

A design task follows steps 1–7 with these differences: the designer builds a prototype from the project's real components with mock data, produces the static bundle using the build command and output folder documented in `.corral/agents/designer.md` or the project's `CLAUDE.md`/`CORRAL.md`, calls `submit_design` and reports `design_submitted`. No PR is opened. After Agent review it always goes to **Human review**. Request changes → In progress, and the next submission is a new version. Approve → **Approved**: the version is approved, earlier ones are superseded, and a Plan session for the build starts. Steps 7c–10 don't apply.

- **Step 2:** only designers may claim design authoring runs; developers claim only `task`, `bug` and `spike` implementation runs (D23).
- **Step 3:** the branch is `design/<ref>`, and only a designer's MCP server offers `submit_design`.
- **Steps 4–5:** design-only authoring guidance goes only to the designer, whose instructions come from `.corral/agents/designer.md` with built-in defaults when absent (D13, D23). If no prototype build instructions are supplied, the designer reports `stuck` and asks. Developers still receive pinned design files when building them (D20). The designer commits the prototype, writes `design.md` and takes desktop and mobile screenshots with agent-browser, then calls `submit_design`. The runner checks the bundle folder has an `index.html` at its root (and no symlinks), packs it as a tar, pushes the branch and sends the files; the server checks the tar again, checks the branch is at the pushed commit and records the next version. `report_outcome('design_submitted')` is accepted only when a version exists at the branch's current commit and every agent-checkable criterion has evidence (D28); it moves **In progress → Agent review**.
- **Step 6:** the reviewer checks out the version's commit and reads it with `get_design`. It judges the spec and screenshots against the criteria; there is no diff.
- **Step 7a, rework:** changes requested by the reviewer or the human mark the version *changes requested* (with the human's feedback). The next designer run **resumes the same designer session** on the same branch with the feedback given since that version; if the session can't be resumed, it starts fresh with the full prompt. If earlier authoring runs used a developer, the next authoring run (including retries, requested changes and reopened tasks) goes to an eligible designer in a **new session**, never resuming the developer session. The task, branch, versions and feedback are retained, and an active run is not interrupted (D23). Its submission is the next version.

---

## 3. When things go wrong

| Event | Result |
|---|---|
| Agent crashes | Run → Failed (after reconciliation), lease released; task stays in its status and is retried. 3 failed runs → task **Failed** |
| Laptop sleeps / runner disconnects | Heartbeat stops → lease expires → stale writes rejected by epoch → reconcile, then retry |
| Usage limit hit | Run outcome `rate_limited`; group paused until reset; not counted as a failure (D3) |
| Human stops a run | Process tree killed, run → Interrupted; the task is **paused** so the scheduler doesn't restart it until the human presses **Resume** on the task (`POST /projects/:slug/tasks/:number/resume`, human only). That clears the pause and asks for a scheduling pass for the task right away, and the run that starts depends on its status: a developer run in In progress, a reviewer run in Agent review |
| A developer run stops before reporting | The runner commits uncommitted changes as a WIP commit and pushes the task branch. The next developer run starts from that commit, and its prompt says it continues a stopped run and gives the stop reason and the commit |
| Agent reports `stuck` | Task → **Blocked** |
| Review cap reached | Task → **Blocked** |
| Unrecoverable error / unsafe merge failure | Task → **Failed** |
| Human deletes the task | Run stopped, PR closed, branch removed when safe, task soft-deleted; dependents → Blocked (D10) |

---

## 4. An epic from its first task to its epic PR merging (D27)

How an epic in `epic` or `each_task` mode gets its work onto the target branch. A `direct` epic, and a task without an epic, follow section 2 alone and merge straight into the target branch. The example project's target branch is whatever its settings name (`defaultBranch`); Corral never assumes its name.

The example: epic **E7 "Saved searches"** in `epic` mode, with three board tasks: **#41** (API), **#42** (UI, depends on #41) and **#43** (docs). #42 has `humanReview` set.

### Step 1 — First claim creates the epic branch

The plan is approved and the scheduler claims #41 (section 2, step 2). E7 has no epic branch yet, so the server creates `corral/epic-<epicId>-saved-searches` from the tip of the target branch. The runner then creates #41's branch from `origin/corral/epic-…` instead of the target branch (section 2, step 3), and the server opens #41's PR with the epic branch as its base.

### Step 2 — Task PRs merge into the epic branch

Each task follows section 2, steps 4–10, against the epic branch:

- **#41:** the reviewer approves; it isn't flagged, so in `epic` mode it goes straight to Ready to merge, and once CI passes it squash-merges into the epic branch. #41 is **Merged**, meaning merged into the epic branch. #42 depends on it in the same epic, so it becomes eligible.
- **#43** was opened before #41 merged. The epic branch moved under it, so Corral rebases #43's PR onto the epic branch (section 2, step 7c, with the epic branch as the base). It's clean; the approval stands, CI reruns, and #43 squash-merges.
- **#42** is flagged, so after the reviewer approves it waits in **Human review**. The human approves and it squash-merges. (In `each_task` mode, #41 and #43 would have gone to Human review too.)

Meanwhile the target branch has moved on with other work. Corral doesn't touch the epic branch for that: the target branch is never merged into it. A task in another epic, or without one, that depends on #41 is still waiting, because #41 isn't on the target branch yet.

### Step 3 — Corral opens the epic PR

#42 was the last board task of E7 still unmerged. With all three Merged, the server opens the **epic PR** from the epic branch into the target branch. Its description lists the epic's tasks with links to their PRs and evidence. In the Inbox it's Activity: "Epic PR opened". E7 isn't done yet, so epics that depend on it (D22) are still waiting.

### Step 4 — Integration review

The scheduler claims a reviewer run for the epic PR. The reviewer checks out the epic branch, reads the combined diff, the epic's goal and its tasks' criteria. The gates follow the same rule as any review: left to required CI, or run without the cache when the project has none (D26). It's looking for what each task's review couldn't see: the UI calling the API with the wrong field name, docs describing behaviour neither task built, duplicated helpers. It reports `approved` or `changes_requested` with its reasoning.

### Step 5 — Human review and a fix task

The reviewer approves, and the epic PR becomes a **Needs you** item in the Inbox (D11, D27), with the reviewer's verdict and the combined diff. The human tries it and requests changes: "Deleting a saved search doesn't ask for confirmation."

The server creates fix task **#44** in E7, in **Ready**, titled from the feedback, with the feedback as its description and each of its points (list items, or paragraphs) as a criterion. The epic PR's review state becomes `changes_requested`, which keeps it from being approved or merged, and the Inbox item is resolved. #44 runs through section 2 like any task in E7: its branch is cut from the epic branch, it's reviewed in `epic` mode, and it squash-merges into the epic branch. (A reviewer's `changes_requested` on the epic PR in step 4 creates a fix task the same way.)

With #44 merged, every board task is Merged again, and the same epic PR goes back to **integration review** (step 4) and then returns to the Inbox for the human. This time the human approves, and the epic PR is **ready to merge**.

### Step 6 — Rebase before merge, and a conflict

Before anything else, the server compares the epic branch with the target branch through GitHub's compare API, because `mergeable_state` only says `behind` when branch protection requires it. The target branch has moved since E7's branch was created, so the server asks GitHub to rebase the epic PR onto it (`updatePullRequestBranch` with `updateMethod: REBASE`).

- **Clean rebase:** the approval stands, as for task PRs. CI runs again on the new head, and when it passes the epic PR goes to step 7.
- **Conflict (this example):** another task changed the same route file on the target branch, so GitHub reports a conflict. The epic PR leaves ready to merge for `conflict`, the target branch is unchanged, and "Epic PR conflict" is posted to Activity. The Inbox shows a **Needs you** item naming E7 and the conflicting files, which a runner works out with `git merge-tree`. The human picks **Hand the rebase to a developer**, and the server creates conflict task **#45** in E7, in Ready, naming the files.

#45's job carries the epic branch itself as its branch, not a new task branch. The developer:

1. Checks out the epic branch and rebases it onto `origin/<target branch>`.
2. Resolves the conflict in the route file, keeping both changes, and runs lint, typecheck, tests and build.
3. Reports `pr_updated` with what it resolved and how it checked it. The runner force-pushes the epic branch with `--force-with-lease`; no task PR is opened.

#45 goes to Agent review like any task in E7; the reviewer checks the rebased epic branch against the target branch and approves. #45 is Merged, since its work is already on the epic branch. Because a resolved conflict isn't a mechanical update, the epic PR goes back to **integration review** and then to the **human**, who approves it again. On this second pass the epic branch is already on top of the target branch, so nothing needs rebasing; if the target branch had moved again, step 6 would repeat.

### Step 7 — The epic PR merges

The final gate check (section 2, step 8) runs against live GitHub data for the epic PR: approved by the human at the current commit, or carried over a clean rebase, required CI checks passed, mergeable. A failed required check creates a fix task in E7, as in step 5. The server squash-merges the epic PR into the target branch, whatever the project's merge method, so E7 lands as one commit, and records the merge commit. Never marked merged without seeing a merged state (section 2, step 9). After three failed attempts the epic PR goes back to **Human review**, where approving retries the merge. A PR merged by hand on GitHub counts as merged; one closed without merging goes back to `open`, and reopening it restarts integration review.

Then:

- E7 is **done** (D22 as amended by D27). Epics that depend on it wake at once, as do tasks elsewhere that depended on #41–#45.
- "Epic PR merged" is posted to Activity.
- The server deletes the epic branch, and the runner removes any worktrees left for it.
