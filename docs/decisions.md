# Decisions

Decisions made while reviewing the PRD on 2026-10-26. **Where these conflict with [prd.md](prd.md), these win.**

Each decision has an ID so code comments, commits and PRs can refer to it (e.g. "per D2").

---

## D1 — The POC is local-only; hosting comes right after the MVP

**Status:** Accepted

**Decision:** The proof of concept runs entirely on the user's machine: web UI, control plane, database, scheduler and runner. That machine starts as the laptop and becomes the user's home server, as Docker containers (D12). There's no hosted control plane, runner pairing over the internet, or multi-tenant auth in the POC.

**Why:** For a single user, a hosted control plane adds authentication, runner pairing, revocable credentials, outbound tunnels, hosted Postgres/S3 and multi-tenant security without proving the core loop. Hosting still matters for **remote access and teamwork**, so it's the next step after the MVP, not a dropped goal.

**Consequences for the build:**

- Keep the control plane a **separate process** from the runner. They talk over the same protocol a hosted deployment would use, even when both run on localhost. Moving to hosting should change where the control plane runs and how the two authenticate, not the architecture.
- Keep storage behind interfaces (database, evidence/artifact store), so local implementations (e.g. SQLite, local filesystem) can later be swapped for Postgres and S3-compatible storage.
- The PRD's sections on runner pairing, hosted user auth and revocable runner credentials (7.4, 8.1, 8.2, 9.1) are **deferred**, not deleted. Design so they can be added.
- Don't add anything that assumes exactly one user forever (e.g. hard-code "the user" into the data model). Actor attribution should still record who did what.

---

## D2 — Agents run through the user's own locally installed, authenticated CLI

**Status:** Accepted (expected to change if Corral is sold)

**Decision:** Corral starts the agent CLI the user has installed (Claude Code, `claude`) on their own machine, authenticated with their own login. For the POC that's Cormac's personal Claude subscription. Corral **never** sees, stores or relays model-provider credentials.

**Why:** It's the simplest setup for one user, and it avoids Corral "offering" a Claude login. Background and terms are in [agent-runtime-and-auth.md](agent-runtime-and-auth.md).

**Amended by D15:** the server holds one key, for Jev, TypeSafe AI's decision model, which picks the agent, model and thinking level for each task. It's an environment variable on the server container and is never stored. The coding agents are unaffected.

**This may change.** If Corral is packaged and sold, we'll likely need user-supplied API keys, Bedrock/Vertex, or explicit approval from Anthropic. The rules in `agent-runtime-and-auth.md` exist so that switch means writing a new adapter, not a rewrite.

**Extended by D18:** OpenAI's Codex CLI (`codex`) is a second runtime, run the same way through the user's own login.

---

## D3 — Hitting a usage limit is a pausable state, not a failure

**Status:** Accepted

**Decision:** When the agent runtime reports that a usage or rate limit was hit:

- The run ends with its own outcome (e.g. `rate_limited`, with a reset time when one is known). It is **not** `failed`.
- It does **not** count toward the failed-run cap (default 3).
- The scheduler pauses the affected agent group until the reset time (or a configured backoff when no time is known), then resumes.
- The UI shows the reason clearly, e.g. "Waiting on usage limit until 3:00pm", not a silent stall.

**Why:** Subscription plans have usage windows and weekly caps, and Corral is built to keep agents running autonomously, so it will hit them. Treating that as failure would block tasks for no real reason.

---

## D4 — Evidence comes from the agent running the app and capturing it with the agent browser

**Status:** Accepted

**Decision:** For tasks where it applies (anything with a visible change), the developer agent runs the app locally, captures **screenshots and/or videos** with an agent browser, and attaches them to the PR or evidence packet against the acceptance criteria.

**Amended by D19:** evidence is chosen per acceptance criterion, not by task type. PRD §7.7's evidence kinds remain the guidance.

**Amended by D21:** checks are gates, never criterion evidence; human evidence may be note-only. D21 overrides the test-results guidance in PRD §7.7.

Open gaps to consider are in [open-recommendations.md](open-recommendations.md) (R3).

---

## D5 — The human-review flag decides whether a task auto-merges

**Status:** Accepted

**Decision:** Tasks can be flagged as requiring human review.

- **Flagged:** when the reviewer approves, the task waits in *Human review* until the human approves or requests changes.
- **Not flagged:** the reviewer's approval moves it straight to *Ready to merge*.

For ordinary tasks without the exceptions below, only the task flag sends a task to a human. A project with no required checks doesn't force human review: its unflagged tasks merge on the reviewer's approval alone (amended 2026-10-28; previously every task in such a project needed a human). Either way the task then sits in *Ready to merge* until it's merged, and all other merge gates in PRD §7.9 still apply.

**Amended by D20:** Design tasks always go to *Human review*, whatever their flag, and never to *Ready to merge*.

**Amended by D27:** in an `each_task` epic every task goes to *Human review*, whatever its flag; in an `epic` epic the flag works as above but tasks merge into the epic branch; and every epic PR goes to the human.

**Amended by D28 (COR-249):** any criterion marked **Checked by a human** sends an approved task to *Human review*, whatever the task flag or epic mode. Adding a human check while *Ready to merge* returns it to *Human review*.

---

## D6 — CI starts basic (lint)

**Status:** Accepted

**Decision:** Each project starts with basic CI, at minimum linting, configured as a required check. More checks can be added later.

See R4 in [open-recommendations.md](open-recommendations.md) on whether lint alone is enough of a gate for auto-merge.

---

## D7 — Three processes in a Turborepo: Nuxt web, Hono control plane, Node runner

**Status:** Accepted

**Decision:** Corral is a Turborepo + pnpm monorepo with three apps: `web` (Nuxt + Nuxt UI, UI only), `server` (Hono control plane, sole owner of the database, scheduler and orchestrator, single instance) and `runner` (Node/TS local daemon that dials out to the server over WebSocket and spawns agents). Shared code lives in `packages/contracts`, `packages/core` (pure domain logic) and `packages/db`. The database is PGlite + Drizzle, moving to Postgres when hosted. *(Amended by D14: the deployed instance uses Postgres now; PGlite stays for development and tests.)*

**Why:** The runner is the piece that stays on the user's machine once the server is hosted, so it's separate even locally. The control plane's long-running loops shouldn't live in the request-driven web layer. TypeScript throughout lets every app share one contract package; the runner is I/O-bound, so TypeScript costs nothing in performance.

Full details, runner rules and resource estimates are in [architecture.md](architecture.md). This resolves the PRD §8.2 "Rust or Node" choice (Node) and replaces SvelteKit with Nuxt.

---

## D8 — Storage: one source of truth per kind of data; only the server touches shared stores

**Status:** Accepted

**Decision:**

- The **server** is the only process that reads or writes the database and the blob store, and the only one that talks to the GitHub PR/CI API.
- The **runner** owns its local disk (clone, worktrees, spool) and is the only thing that pushes, and only to branches it holds a lease for.
- **Agents** reach Corral only through per-run MCP tools.
- **web** only talks to the server API.
- Evidence and transcripts are immutable, content-addressed blobs; the database stores pointers.
- PRs link to Corral's evidence page instead of embedding images.

Full table, disk layout, flows and the known POC push limitation are in [architecture.md § Storage](architecture.md#storage-d8).

---

## D9 — The PM runs on the runner, not the server

**Status:** Accepted

**Decision:** Each PM chat turn is a runner job with role `pm`. The runner fetches the repo, updates a **read-only checkout of the default branch**, and runs `claude -p --resume <sessionId>` there. The PM gets its context from local files (code, `CORRAL.md`, wiki) and live board state through MCP tools (`list_tasks`, `get_task`, `add_comment`, `attach_evidence`, `get_run_outcomes`, `ask_question`, `propose_plan`, `approve_plan`, `flag_stale_docs`). It has **no** tools to merge, edit docs or change task status, and it approves plans only on the human's say-so (below).

- The server stores the conversation and the `claude` session ID in the database. If the session is lost, the next turn starts fresh, seeded with a summary built from the database messages.
- `propose_plan` results are validated by `core` (dependencies form a DAG, every task has acceptance criteria) and saved as versioned draft plans. Only the human approves one: with the plan flyout's buttons, or by asking Juno in chat ("looks good, add it to the board"), which then calls `approve_plan`. That approval is recorded as the human's, with the PM run that carried it out, and the server only accepts it when the human has written since the plan was proposed, so Juno can't approve a plan the human hasn't seen (amended 2026-10-28).
- A PM turn runs only when the user sends a message. There's no delivery-summary turn when an epic finishes: merged work isn't handed back to the PM (amended 2026-10-28).
- **Per session (amended 2026-10-29):** each Plan session has its own read-only checkout, at a path that stays put between turns so `--resume` finds the session, and runs one turn at a time. A second message to a session whose turn is still active is refused (409 `pm_turn_in_progress`); other sessions, in the same project or another, aren't blocked by it. That is the only limit on PM turns: Juno has no concurrency (D13), so every session with a message gets its turn right away, in any project. A turn waits as `queued`, keeping its job in the database so it survives a restart, only while Juno is paused (or `pausedUntil` a usage reset), the runner is offline, the kill switch is on or Corral is updating; it starts on the next pass after that clears, oldest first.
- **Warm sessions (amended 2026-10-29):** a turn's `claude` process outlives its run. The runner starts PM processes in stream-json input mode and sends each message over stdin; a turn's run ends when its `result` line arrives, and the process then waits, idle, for the session's next message. That message reuses it if it's still alive and idle, holds the same `claude` session ID as the job, and runs the same model; the runner still fetches and resets the checkout to `origin/<defaultBranch>` first, and points the MCP tools at the new run and lease. Otherwise the runner kills it and cold-starts with `--resume` as before. An idle process is killed (its whole process group) after `CORRAL_PM_WARM_SECONDS` (runner config `pmWarmSeconds`, default 300; `0` turns warm sessions off and starts a process per turn). Stopping a turn, its time limit and runner shutdown kill it too. A warm process uses a scratch dir per session, since its system prompt is fixed when it starts. Each turn is still one run with its own `run.started` and `run.ended`, so the server doesn't know about warm processes, and an idle one holds no slot (PM turns have no concurrency; D13).

**Why:** D2 means the model is only reachable through the user's local CLI, so the server can't run the PM. Running it on the runner also gives it direct, fast access to the code and wiki.

**Amended by D20:** approving a design version also starts a PM turn, in a new Plan session opened with the human's message.

**Amended by D18:** a Plan session can run on Codex instead of `claude`, picked per session and locked once it has messages. What this decision says about `claude` sessions and `--resume` applies to the session's runtime.

**Consequence:** PM chat requires the runner to be online. When hosted, that means the user's runner must be connected to chat.

---

## D10 — Task statuses and transitions

**Status:** Accepted. Replaces PRD §5.1 and §5.2.

### Statuses

| Status | Meaning |
|---|---|
| **Draft** | Proposed by the PM in a plan and not yet confirmed. Belongs to the Plan session that proposed it, and is listed on the Plan tab under that session; never on the board or in the Backlog. A plan in another session that revises it by ref takes it over: it belongs to the session of the latest proposed plan that includes it. The PM's revisions can change or remove it (added 2026-10-28; owning session added 2026-10-29). |
| **Backlog** | Created by the human, or a Draft the human kept for later or for refining, or sent back for rethinking. Replaces "Needs refinement" (and the earlier name "Draft"). Never scheduled. **Not shown on the board** (see below). |
| **Ready** | Approved and fully specified. **Can still have unmerged dependencies.** The scheduler only starts it once all dependencies are Merged; until then the card shows "waiting on #12". |
| **In progress** | The developer's turn. |
| **Agent review** | The reviewer's turn. Replaces "In review". |
| **Human review** | The reviewer approved; the task is flagged for human review and waiting on the human. |
| **Ready to merge** | Approved by the reviewer, and by the human when flagged. Corral waits for CI and the base branch, re-checks the gates and merges. Nobody's turn but Corral's (added 2026-10-28). |
| **Merged** | PR merged. Final and immutable; follow-up work is a new task. This is what "Done" means everywhere in the PRD. |
| **Blocked** | An agent needs a **human decision**. |
| **Failed** | **The system broke** and can't continue on its own. |

**Amended by D20:** design tasks end in a new **Approved** status instead of Merged, with their own transitions (see D20).

**Amended by D27:** for a task in an `epic` or `each_task` epic, Ready to merge waits on the epic branch and Merged means merged into the epic branch; a task in another epic, or without one, that depends on it waits until that epic is done (see D27).

There is no Testing status (add it when a tester agent exists), and no Cancelled or Archived status (see Deleting below).

### Backlog vs the board

Backlog tasks have their own **Backlog** view with its own place in the main navigation. The board shows only approved work: Ready, In progress, Agent review, Human review, Ready to merge, Merged, Blocked and Failed. Approving a task (Backlog → Ready) moves it onto the board; sending it back (Ready → Backlog) takes it off.

### Status = whose turn; lease = whether someone is working

A status says whose turn it is. Whether a run is actually active is shown by the lease, not the status. The scheduler starts a run for any task in **Ready**, **In progress** or **Agent review** that has no lease and whose group has capacity. So:

- A failed run under the retry cap, an interrupted run, a stopped run or a `rate_limited` run leaves the task in its current status with no lease. The scheduler simply retries later.
- "Changes requested" puts the task back in **In progress** with no lease, and the next developer run picks it up on the same branch and worktree.

### Transitions

| From | To | Trigger | Actor |
|---|---|---|---|
| (new) | Draft | PM `propose_plan` | PM |
| (new) | Backlog | The human creates a task, or the PM creates a documentation task | Human / PM |
| Draft | Backlog | Human adds the plan (or one task) to the Backlog | **Human only** |
| Draft, Backlog | Ready | Plan or task added to the board; title, description and verifiable acceptance criteria present | **Human only** |
| Ready | Backlog | Sent back for rethinking | Human |
| Ready | In progress | Scheduler claims it; all dependencies Merged | Scheduler |
| In progress | Agent review | Valid `pr_opened` / `pr_updated` outcome (branch pushed at the expected commit, evidence for every agent-checkable criterion; D28) | Server |
| Agent review | In progress | Reviewer requests changes | Server |
| Agent review | Human review | Reviewer approved; task flagged for human review or any criterion checked by a human (D28) | Server |
| Agent review | Ready to merge | Reviewer approved; no human review required (D5, D20, D27, D28) | Server |
| Human review | Ready to merge | Human approves | Human |
| Human review, Ready to merge | In progress | Human requests changes | Human |
| Ready to merge | Human review | Human adds a new human-check criterion (`require_human_check`, D28) | Server |
| Ready to merge | In progress | CI fails; base-branch conflict | Server |
| Ready to merge | Agent review | A new commit other than a clean base-branch update; it needs a fresh review | Server |
| Ready to merge | Merged | All gates pass against live GitHub data; merge confirmed by GitHub | Server |
| Agent review, Human review, Ready to merge | Merged | GitHub shows the PR merged outside Corral | Server |
| Ready, In progress, Agent review, Human review, Ready to merge | Blocked | See causes below | Server |
| In progress, Agent review, Ready to merge | Failed | See causes below | Server |
| Blocked, Failed | Backlog, Ready or In progress | Human resolves it (In progress keeps the branch and PR) | **Human only** |

**Amended by D28:** criteria reserved for a human require neither agent evidence nor an agent met/unmet verdict. Their recorded verdict is **Needs human check**. Reviewer approval and a newly added human check use the Human review routes above; human approval then follows the usual merge gates.

All transitions go through `packages/core` and are enforced by the server. Anything not in this table is rejected.

### Blocked vs Failed

| Blocked: an agent needs a decision | Failed: the system broke |
|---|---|
| Review-round cap reached (default 5) | Failed-run cap reached (default 3) |
| Agent reports `stuck` / escalates | Unrecoverable error (e.g. repo not accessible, bad config) |
| Ambiguous or contradictory requirements | GitHub merge failed and retrying isn't safe |
| Non-trivial merge conflict the developer can't resolve | |
| A dependency was deleted | |

Both appear in the Inbox (D11) with their reason. When a human resolves a Failed task, its failed-run counter resets; when they resolve a Blocked task, its review-round counter resets.

### Deleting (instead of Cancelled)

- **Draft, Backlog:** deleted outright. A Draft the PM drops from a revised plan is deleted the same way, and so are the Drafts of a plan the human discards (a Draft the discarded plan only revised goes back to its own session).
- **Ready, In progress, Agent review, Human review, Ready to merge, Blocked, Failed:** stop any active run, close the PR, delete the Corral branch when safe (never discarding uncommitted work), then **soft-delete**. The task is hidden from the board, but it and its audit history are kept.
- **Merged:** can't be deleted.
- **Dependents:** deleting a task that others depend on moves those dependents to Blocked with the reason "dependency deleted", unless the human removes the dependency first.

---

## D11 — The Inbox holds developer and reviewer items only; the PM stays in Plan

**Status:** Accepted. Replaces the PRD's "Human queue" (§7.11, §12.2) and its separate notifications. Amended 2026-10-29 (COR-103, COR-118, COR-130): Plan sessions with a question, a plan needing approval or an unread reply now appear in the Inbox too (see the amendment below). Amended 2026-10-29 (COR-127): so do the PM's release notes for each deploy (see the second amendment).

**Decision:** The PRD's Human queue is called the **Inbox**. It only holds items raised by developer and reviewer runs, which happen in the background while the human is elsewhere:

- **Needs you:** tasks in **Human review**, **Blocked** tasks (including an agent asking a question, which reports `stuck` and blocks the task with the question as its reason) and **Failed** tasks. Each item can be resolved from the Inbox itself, following the D10 transitions. An item stays until it's resolved; reading it doesn't clear it.
- **Activity:** informational events from those runs (PR opened, changes requested, approved and merged). Nothing to act on.

A design in Human review is a Needs-you item like any other (D20). An epic PR waiting on the human is a Needs-you item too, and epic PR events are Activity (D27).

Nothing from the PM goes in the Inbox. *(Amended 2026-10-29, see below: Plan sessions with a question, a plan needing approval or an unread reply do.)* PM questions (`ask_question`), proposed plans and plan approval live in the **Plan** conversation. A PM turn only runs when the human sends a message or approves a design (D9, D20), so the human is already there. `flag_stale_docs` creates a task in Backlog.

There is no separate notifications feed or bell. System events (usage limits, runner disconnects) are shown on Runs and in the runner status, not in the Inbox. OS or desktop notifications can be added later and would point into the Inbox or Plan.

**Why:** Copying PM questions into a queue duplicates a conversation the human is already reading. Keeping the Inbox to agent work that's waiting on the human makes its count mean one thing: how many agents are stuck on you.

**Amended 2026-10-29 (COR-103, revised by COR-118 and COR-130): Plan sessions that need the human appear in the Inbox.** An open Plan session that is waiting on the human is a **Plan thread** item in the Inbox, alongside the developer and reviewer items above.

- **Which sessions are listed:** an open session is an Inbox item when it's waiting on the human in one of three ways: a pending **question** from Juno, a plan **needing approval**, or an **unread reply** (a finished Juno turn the human hasn't seen; the item carries that reply's text). Reading an unread-only thread takes it out of the Inbox. Idle open sessions, with none of the three, are not listed: they stay in Plan and its side nav threads. There is no "Open in Plan" group of other open sessions.
- **Open and closed:** a session is open until its plan is approved, to the board or the Backlog, or the human closes it with **Close thread**; either marks it `closed` (COR-38). It opens again when the human sends it a message from Plan. A closed session leaves the Inbox and the side nav and isn't listed under Resolved.
- **Needs you:** Plan threads are under **Needs you** in one list with the task items, **newest first** by when each item arrived, with no grouping. A task arrives when it enters Human review, Blocked or Failed (its latest transition into that status), so updates that keep its status, such as its PR head moving, don't move it. A thread arrives when it started waiting: when the question was asked, the plan proposed or the unread reply received.
- **Count:** the Needs you count (the Inbox badge and tab) is exactly the number of listed items: the task items and the Plan threads with a question, a plan needing approval or an unread reply. A session that's merely open doesn't add to it.
- **What a thread shows:** the selected thread shows only what needs the human, not the conversation. For a question: the question with Juno's recommendation, the one-tap answers and a reply box. For a plan: its title, summary and counts, with **View plan**, **Approve to board**, **Approve to Backlog** and **Open in Plan**. The full conversation stays in Plan.
- **Where to act:** PM questions and plan approval can be handled from the Inbox *or* from Plan. Both use the same endpoints and the same rules (D9: only the human approves a plan), so answering or approving in one place updates the other live (`plan.session` events). Replying from the Inbox sends a message to the session and starts a PM turn, exactly as sending it in Plan does.
- **Closing a thread:** **Close thread**, in the Inbox and in Plan, asks for confirmation first. Closing discards the session's Draft tasks and its unapproved plan (revised Backlog tasks are only un-staged and stay as they were), stops a running PM turn, and marks the session `closed`. The thread leaves the Inbox and the side nav at once and isn't listed under Resolved. Sending it a message from Plan reopens it, as after an approval; the discarded drafts and plan don't come back.
- **Unchanged:** `ask_question`, `propose_plan` and `approve_plan` still belong to the Plan session; the Inbox shows the same session's question or plan rather than a copy. System events stay out of the Inbox, and Activity still only holds developer and reviewer events.

**Why the amendment:** with several Plan sessions open across projects, the Inbox was the one place that didn't show what Juno was waiting on, and the human had to check Plan separately. Showing the open sessions themselves (not copies of their questions) keeps one conversation per session while making the Inbox the single list of everything waiting on the human. Plan's own Recent sessions list is dropped, because the Inbox and the side nav threads cover it. Listing only questions, plans needing approval and unread replies, and showing just that instead of the conversation, keeps every Inbox thread something to act on and its count meaning what's waiting on the human; **Close thread** gives the human a way to abandon a session they don't want without approving it (COR-118).

**Amended 2026-10-29 (COR-127): the PM's release notes are an Inbox item.** After each deploy (D16) the server records a **deployment**: the commits it shipped since the last one. The PM writes release notes for it in markdown, and those notes appear in the Inbox as a **Release notes** item for the deployment's project.

- **Not Needs you:** release notes are something to read, not something an agent is waiting on, so they don't count toward the Needs you count (badge and tab). They are listed below the attention items in the Inbox's `needsYou` list (COR-129), newest first, and remain unread until the human opens them (the deployment's `readAt`). Reading keeps them in the Inbox; Dismiss moves them to Resolved.
- **Unchanged:** nothing else from the PM goes in the Inbox; system events (including a deploy that failed, which records no deployment) stay out.

**Why:** the notes are written in the background after a deploy the human didn't trigger, which is the kind of thing the Inbox is for. Keeping them out of the Needs you count keeps that count meaning what's waiting on the human.

---

## D12 — Corral is deployed as Docker containers on the user's own server

**Status:** Accepted

**Decision:** Development and the first runs of the POC happen on the laptop with `turbo dev`. The deployment target is Docker containers on the user's home server, run with Docker Compose: one container each for `web`, `server` and `runner`, on a private Docker network. This is still a **single-user, self-hosted** deployment. The multi-user hosting that D1 defers (runner pairing, hosted user auth, revocable runner credentials) is a separate later step.

- **Exposure:** only `web` is reachable from outside, through the existing Cloudflare Tunnel, with **Cloudflare Access** in front of it as the login. Corral has no login of its own in this phase. The server API and the runner WebSocket stay on the Docker network and are never published.
- **Runner container:** contains `git`, `gh`, the `claude` CLI, a headless Chromium for D4 evidence, and the toolchains the target projects need. Agents run inside it, so the runner container (not the laptop) is "the user's machine" for D2.
- **Credentials (D2 still holds):** The user logs in to `claude` and `gh` inside the runner container (`docker exec -it`), and their config directories live on volumes. Corral never reads, stores or relays them. Don't pass model-provider tokens through Compose files, `.env` files or Corral config.
- **State:** the server's data directory (blobs), the Postgres data directory (D14) and the runner's data directory (clone, worktrees, spool) are Docker volumes. Backing up the server and Postgres volumes backs up all of Corral's state.
- **No Docker socket** is mounted into any container. Running each task in its own container is a later `RunnerProvider`, not part of this decision.

**Why:** Corral is meant to be a personal software factory running on always-on hardware the user already operates (Docker, Cloudflare Tunnels), not on a laptop. Containers also limit what an agent can reach to the runner container instead of the user's whole account.

**Consequences for the build:**

- Nothing may only work on macOS. The runner must run on Linux (no keychain, `open` or BSD-only tool flags).
- Data directories, the server URL, bind address and port come from configuration (env vars), not hard-coded paths such as `~/.corral` or `localhost`.
- SSE and WebSocket connections send heartbeats, because Cloudflare drops proxied connections that are idle for about 100 seconds.
- `web` builds to static files (`ssr: false`). One origin serves them and proxies `/api/**` to `server` inside the Docker network, so the browser and Cloudflare Access see a single hostname.
- Each app gets a Dockerfile, and the repo gets a `docker-compose.yml`. These can wait until the core loop works locally, but the code must not assume it runs outside a container.

---

## D13 — One Corral, many projects; agents and planning are global

**Status:** Accepted

**Decision:** One Corral instance manages **several projects**. Each project is still one Git repository (PRD §4.1). Everything is either **global** or **belongs to one project**:

| Global | Per project |
|---|---|
| Plan (PM sessions), Inbox, agents, the runner, user settings | Overview, Board, Backlog, project settings (name, thumbnail, repo, default branch, merge method, required checks, task ID prefix, pause, limits) |

- **Agents are global.** Juno (PM), Atlas (developer) and Vera (reviewer) are set up once, in Settings, and serve every project. Concurrency applies only to developer and reviewer agents, across all projects, not per project. Juno has none (amended 2026-10-29): PM turns are limited only to one per Plan session (D9), and `PATCH /api/agents/:id` refuses `concurrency` for the PM with 400 `concurrency_not_applicable`. The `agents.concurrency` column is kept and ignored for `role = 'pm'`. Role instructions stay in each repo (`.corral/agents/<role>.md` on the default branch), so the same agent can follow different project rules. More developers and reviewers can be added (`POST /api/agents`), each with one runtime whose CLI the runner has; there is only ever one PM. An agent's runtime can only change while it has no queued or running run.
- **Plan sessions belong to one project.** The project is picked in the composer and locked once the session has messages. Juno works in a read-only checkout of that project, one per session (D9).
- **The Inbox is global**, and every item carries its project (D11). The same goes for runs on the agent pages.
- **Task IDs are `PREFIX-NUMBER`**, e.g. `COR-29`. Each project has a 2–5 letter prefix that is unique across projects, and numbers count up per project. PRs keep `#41` and runs keep `#128`.
- **Pause is per project.** Pausing stops new runs for that project only.

**Amended by D23:** adds the designer role, its instructions fallback and fresh-install seed, and includes designers in global agent capacity and configuration.

**Why:** A personal software factory (D12) runs more than one codebase. Planning, review and agent capacity are shared across all of them, while task state belongs to one repo.

**Consequences for the build:**

- Every task, plan, epic, run, Inbox item and PM session has a `projectId`. Board, Backlog and their queries are always scoped to one project.
- The scheduler checks group capacity across all projects and skips tasks in paused projects.
- Task numbers come from a per-project counter. The prefix lives on the project and is unique.
- The repository ownership lock (PRD §7.1) is per repository, so two projects can't point at the same repo.
- Still open: whether changing a prefix renames existing task IDs. See `design/project-settings.md`.

The UI specs are in [design/](design/README.md).

---

## D14 — Postgres in Docker for the deployed instance; PGlite for development and tests

**Status:** Accepted. Amends D7 ("PGlite + Drizzle, moving to Postgres when hosted") and the State bullet of D12.

**Decision:** `packages/db` has one Drizzle schema (Postgres dialect) and two drivers, chosen by configuration:

| Where | Database | How it's chosen |
|---|---|---|
| Deployed instance on the home server (D12) | **Postgres**, its own container in the Compose stack, data on its own volume | `CORRAL_DATABASE_URL` is set |
| `pnpm dev`, one per checkout or worktree | **PGlite**, in that checkout's `.corral/server/pgdata/` | `CORRAL_DATABASE_URL` is unset |
| Unit tests | **PGlite**, in memory, one database per test file | Test helper |
| CI database tests | **Postgres**, a service container in GitHub Actions | `CORRAL_DATABASE_URL` is set |

- The server is still the only process that opens the database (D8), whichever driver is used.
- Migrations are the same files for both drivers and run when the server starts.
- **Anything that depends on concurrency is proven against Postgres, not PGlite.** PGlite has a single connection, so every transaction runs one after another. The concurrent-claim test (PRD Phase 1 exit criterion) passes on PGlite whether or not the claim is safe; it only means something in CI against Postgres. Such tests are skipped when `CORRAL_DATABASE_URL` is unset, and CI must set it.
- Only Postgres features that PGlite also supports may be used, so both drivers stay interchangeable. CI running the database tests on Postgres catches differences.
- The Postgres password for the deployed instance is a Corral setting in the Compose `.env` file. It isn't a model-provider credential, so D2 doesn't apply to it.

**Why:** PGlite suits development: no setup, an isolated database per worktree, and it runs inside the runner container, where agents have no Docker socket (D12) and so can't start a Postgres container. But the deployed instance holds real state on always-on hardware, where Postgres's long record on crash safety and backups (`pg_dump`, point-in-time recovery) matters, and a single-connection database can't prove that atomic claims are safe. Postgres in the Compose stack costs one service on a server that already runs Docker, and it's what hosting needs anyway (D1), so moving to hosting is no longer a database migration.

**Consequences for the build:**

- Backups of the deployed instance cover two volumes: Postgres (`pg_dump`) and the server's blob folder.
- The deployed `server` container no longer holds `pgdata/`; its volume holds only `blobs/`.
- The Compose stack has four services: `web`, `server`, `runner` and `postgres`. `postgres` is on the private Docker network only, like `server`.

---

## D15 — Jev routes each task to an agent, model and thinking level

**Status:** Accepted 2026-10-28. **Not started:** comes after the Codex and Muse support and the work that has to come first. Amends D2 and rule 1 of [agent-runtime-and-auth.md](agent-runtime-and-auth.md) (see below).

**Decision:** Each agent has exactly one provider: Atlas is always Claude Code, and Codex and Muse get developers (and reviewers) of their own. When there is more than one agent for a role, **Jev**, TypeSafe AI's decision model, picks which agent takes a task, and the model and thinking level within that agent's provider.

- **Called directly:** the server calls TypeSafe's API itself, not through Cloudflare, Vercel AI Gateway or OpenRouter. The endpoint, model id (e.g. `jev-latest`) and key are configuration, so switching provider later needs no code change.
- **Where:** one chooser module on the server that the orchestrator calls. Neither the runner nor the PM calls Jev.
- **When:**
  - The task becomes Ready: Jev picks the developer agent, plus its model and thinking level.
  - The task enters Agent review: Jev picks the reviewer agent, plus its model and thinking level.
  - A retry or a new review round: Jev picks the model and thinking level again, but the agent stays the same, so the developer keeps its session and branch context.
- **Input:** the task (type, which is `task`, `bug`, `spike` or `design` per D19 and D20; priority, description, acceptance criteria, human-review flag, review rounds, failed runs, how earlier runs ended), the diff size and the developer agent for reviews, and a menu of options. Jev's answers can only be options from that menu.
- **Corral's own rules, not Jev's:** the menu only lists agents of the right role that aren't paused or rate-limited (D3), each with the models and thinking levels configured for it (rule 4).
- **Fallback:** a short timeout (about 2 s). On a timeout, an error or low confidence, the agent's configured default is used, so a Jev outage never blocks a run.
- **Recorded and overridable:**
  - The choice fills the task's Developer and Reviewer.
  - A human can override either, and a human choice is never replaced.
  - Each run records its model, thinking level, Jev's reason and probabilities, and whether the fallback was used.
- **Scheduling:** a free agent only claims tasks assigned to it, or unassigned tasks when routing is off. If the assigned agent stays paused, the chooser can re-route the task.

**Amended by D23:** design authoring is routed only to designers; existing developer-authored design tasks switch agents and start a new session on their next authoring run.

**D2 amendment:**
- The Jev key is a `TYPESAFE_API_KEY` environment variable on the server container.
- It's never stored in the database and never appears in logs, prompts, worktrees or the UI.
- It's the only model-provider credential Corral holds. The coding agents still use their own CLI logins.

**Why:**
- The choice is a fixed menu in and a typed answer out, which is what Jev is built for.
- It costs about $0.042 per million input tokens with output free (early-access pricing, which may change). That's under $0.001 per task, so price doesn't decide the provider. Going direct is the simplest route: one account and one key, and new Jev versions arrive there first.
- One provider per agent keeps usage-limit pausing per agent, as D3 already works.

**Consequences for the build:**
- The runner reports the providers, models and thinking levels it has.
- `RunJob` gains neutral `runtime` and `effort` fields, alongside `model`.
- Build the chooser with the agent's configured default first, and add Jev behind the same interface. The runs recorded with the default give a baseline to judge Jev against.


---

## D16 — The home server redeploys itself when main moves, without interrupting runs

**Status:** Accepted 2026-10-28

**Decision:** A systemd timer on the home server runs `scripts/deploy/auto-deploy.sh` every 20 minutes, so merges close together share one deploy and one hold. When `main` has moved and the `ci` check on the new commit has passed, it builds the new images and redeploys with Docker Compose. A deploy never cuts off an agent run: if anything other than `web` would restart, the server first goes on an **update hold** and the deploy waits until nothing is running.

- **Remote runners:** update by pulling from GitHub, after draining. Runners report their build commit and compare it with the server; an update request drains only that runner, letting its runs finish before the host updater replaces it.
- **Pull, not push:** the server polls GitHub. Nothing new is exposed through the Cloudflare Tunnel, GitHub holds no credentials for the server, and no self-hosted GitHub Actions runner runs on it (the repo is public, so that would let fork PRs run code there).
- **The update hold** (`POST /api/update-hold`, lifted with `DELETE`): two phases, both reported as `updating` by `GET /api/status` and shown in the app banner. **Draining:** no new developer, reviewer or design runs or merges start; PM turns still start as usual, including Inbox replies. **Finishing:** once no non-PM runs or merges are in flight, new PM turns are accepted and saved as `queued` runs holding their `pmJob`. Running PM turns finish. `POST` counts all active runs (including PM) and merges, excluding queued PM turns still holding their job; the deploy polls until zero. `DELETE` or a server restart clears both phases and starts queued turns.
- **In memory only:** the redeployed server starts without the hold, so a deploy can't leave Corral stuck on hold. If the deploy fails, the script lifts it.
- **Why the server restart counts too:** while the server is down, the runner drops what it sends, so a run that ends during a server restart would be marked interrupted.
- **Order:** build first (the old containers keep serving), then hold and wait, then `docker compose up -d`. A change that only rebuilds `web` deploys without a hold. If the server can't be reached, the deploy goes ahead, so a broken server never blocks its fix.

**Why:** Interrupted runs don't count as failures, but the agent's work in flight is lost and has to be redone. Every run has a time limit, so the wait is bounded.

**Consequences for the build:**
- New worker runs and merges must respect both hold phases. PM dispatch must respect the finishing phase while accepting messages in Plan and Inbox throughout. Count dispatched PM turns in `busy`, but exclude held jobs so the deploy can finish. The existing auto-deploy polling loop needs no change.
- The hold endpoint sits on the same API as the rest of the app, behind Cloudflare Access. It needs proper auth when hosting arrives (D1).
- **Recording the deploy (COR-127):** once `docker compose up -d` succeeds and `.corral/deploy/deployed` is written, the script waits for the new server to answer (bounded retries) and posts `POST /api/deployments` with the repository, the previous and new commit and the commits between them (`git log deployed..new`, or just the new commit on a first deploy). The project is found by its repository, and posting the same new commit again returns the existing record. Failing to report is logged as a warning and never fails or rolls back the deploy. A deploy that stops earlier (CI, build or backup failed) records nothing. The PM's release notes for it are an Inbox item (D11), not part of Needs you.

---

## D17 — A mobile PWA layout, served by the same app

**Status:** Accepted 2026-10-29. Brings into scope part of what PRD §3.2 lists as a non-goal ("Mobile applications").

**Decision:** Corral gets a mobile UI for phones, as a layout of the existing web app (`apps/web`), not a separate app. The PRD's "Mobile applications or remote phone control" stays out of scope in every other sense.

- **Same app, same server, same URLs:** the root (`app.vue`) decides whether the device is mobile or web and renders `layouts/mobile.vue` instead of the default layout. `/tasks/COR-1` is the same page in both. There is no separate mobile route tree, API or build.
- **No native app:** it's installable as a PWA at most. No App Store or Play Store builds, and no push notifications in this decision.
- **No new auth:** the phone reaches Corral the same way a laptop does, through Cloudflare Access (D12). Nothing is added for phones.
- **Per device, not per user:** Auto / Desktop / Mobile is a browser preference in `localStorage`, like the sidebar state. It isn't stored on the server.

**Why:** Most of what needs the human (Inbox items, approvals, Plan replies) is quick and happens away from the laptop. A layout of the same app keeps one codebase and one set of live state, and gets that without a second client to maintain.

**Consequences for the build:**
- Pages must work under both layouts. Use `useDevice()` to choose a mobile component; never fork a route.
- The mobile screens arrive one group at a time (see [design/mobile.md](design/mobile.md)). Until then, a page reflows inside the mobile layout as well as it can.

---

## D18 — Codex is a second agent runtime

**Status:** Accepted 2026-10-29. Extends D2 to a second CLI and fills in the "one provider per agent" part of D15. (Numbered D18 because D17 was already taken by the mobile layout.)

**Decision:** Besides Claude Code (`claude`), the runner can run agents through OpenAI's Codex CLI (`codex`), through a second `AgentRuntime` adapter. Everything D2 says about `claude` applies to `codex` too.

- **The user's own login:** the human signs in once with `docker exec -it <runner> codex login --device-auth` in the runner container (D12), and the login lives on the `codex-config` volume. Corral never sees, stores or relays OpenAI credentials, and **never sets `OPENAI_API_KEY`**, in the agent's environment, Compose files, `.env` files or its own config.
- **One runtime per agent:** each developer and reviewer agent has exactly one runtime (D15). A Codex developer is a separate agent from Atlas, with its own concurrency, pause state and usage limits (D3). A task keeps the same developer across retries, so a session never moves between vendors.
- **The PM is the exception:** Juno can run on either runtime. The runtime is picked per Plan session, in the composer next to the project, and **locked once the session has messages**, because an agent session ID (used by `--resume`, D9) only works with the vendor that made it. A new session can pick the other runtime.
- **Same rules for both adapters:** the rules in [agent-runtime-and-auth.md](agent-runtime-and-auth.md) apply to each adapter: structured output, neutral `rate_limited` outcomes, optional cost data, the same per-run MCP tools, and nothing Claude- or OpenAI-specific in the task model, `RunJob` or the API beyond the neutral `runtime` field.
- **Terms still open:** whether OpenAI's terms allow a product to script the Codex CLI with a user's ChatGPT login is unchecked. It's fine for the POC (one user, their own login), and must be checked before any hosted or paid launch, as for Anthropic.

**Out of scope (future work):**
- Handing a task, or a PM session, off to the other vendor when one hits a usage limit. Until then, a rate-limited agent pauses as in D3.
- A rule that a task's reviewer must use a different vendor from its developer. Jev (D15) or a human may choose that, but Corral doesn't require it.

**Why:** A second vendor gives more capacity under subscription limits and a second opinion in review. Keeping one runtime per agent keeps sessions, limits and pausing per agent, as they already work. The PM gets a choice because a Plan session is a conversation the human starts, not a task the scheduler assigns.

**Consequences for the build:**
- The runner detects which CLIs are installed and signed in, and reports them (D15). The UI only offers detected runtimes.
- A PM session stores its runtime next to its agent session ID. A turn on a session whose runtime isn't available fails clearly instead of starting a fresh session on the other vendor.

---

## D19 — Task types are Task, Bug and Spike

**Status:** Accepted 2026-10-29. Replaces the task types in PRD §4.3 and overrides the evidence-by-type table in PRD §7.7. (Numbered D19 because D18 was already taken by Codex.)

**Amended by D20:** a fourth type, **Design** (`design`), delivers an approved design version instead of a PR.

**Amended by D21:** checks are gates, never criterion evidence. Human evidence is chosen per criterion and may be note-only; logs and test output are agent artifacts.

**Decision:** A task's type says what kind of work it is, not which part of the stack it touches. There are three:

| Type | What it is | Deliverable |
|---|---|---|
| **Task** (`task`) | Normal PR work: features, chores, refactors, docs | A PR |
| **Bug** (`bug`) | A fix for wrong behaviour | A PR that fixes it |
| **Spike** (`spike`) | An investigation | Written findings |

- **Evidence comes from the acceptance criteria**, not the type. The kinds in PRD §7.7 are guidance for picking it: screenshots or video for anything visible, real requests and responses for API changes, and test and CI results, metrics and risk notes otherwise. A task often needs more than one kind.
- **The PM picks the type** in `propose_plan`: `bug` for fixes, `spike` for investigations, `task` for everything else. `flag_stale_docs` creates a `task`.
- **A spike delivers findings instead of a PR** (amended 2026-10-29, COR-65). It goes through the same columns and review as any task, minus the branch, PR and merge:
  - **Developer:** works in a detached checkout of the default branch, with no branch. It investigates without changing code, attaches evidence for every criterion as usual, and reports `findings_reported` with its findings as the summary (answer, evidence, recommendation, suggested follow-up tasks). Nothing is pushed and no PR is opened; `pr_opened` and `pr_updated` are refused for a spike, and `findings_reported` for anything else. The findings are posted on the task as a `## Findings` comment, and the task moves to Agent review.
  - **Reviewer:** gets the latest findings in its prompt and a detached checkout of the default branch, with no diff. It checks that the findings answer every criterion and are backed by evidence, with the usual per-criterion verdicts. Changes requested sends the spike back to the developer exactly like a failed review (round cap included).
  - **Approved:** the spike always stops in **Human review**, whatever its human-review flag says, then goes to **Merged**, the final column, on the human's approval. It never enters Ready to merge, `mergedAt` records when it finished, and its worktrees are cleaned up. Tasks that depend on it unblock as for any merged task.
  - **Reviews per submission:** a spike has no commits, so each `findings_reported` sets the task's `headSha` to a marker, `findings-<runId>`, in place of a commit. Reviews are kept per marker exactly as they are per commit.
  - **The PM** is told it can read a finished spike's findings with `get_task` and turn them into a plan.
- **D15 (Jev)** still gets the task's `type` in its input, with these values.
- **Existing tasks** of the old types (frontend, backend, full-stack, infrastructure) all became `task` in migration `0015_task_bug_spike`.

**Why:** Most changes cross the frontend/backend line, so the old types were usually a guess and didn't change how the task ran. Whether something is a fix or an investigation is what a reader of the board wants to see.

**Consequences for the build:**
- `TASK_TYPES` in `packages/core` is the single list; the database enum, API contracts, plan schema and the runner's `propose_plan` schema are built from it.
- Board and Backlog cards show a badge for Bug and Spike only; Task cards show none.

---

## D20 — Design tasks: faithful prototypes, versioned and approved by the human

**Status:** Accepted 2026-10-29. Adds a fourth task type to D19 and amends D5, D9, D10 and D11 (below). (Numbered D20 because D18 is Codex and D19 is the task types.)

**Decision:** **Design** (`design`) is a fourth task type, alongside Task, Bug and Spike. Its deliverable is a **design**, an approved prototype and spec, not a merged PR.

| Type | What it is | Deliverable |
|---|---|---|
| **Design** (`design`) | A UI or flow to be agreed before it's built | An approved design version |

### Faithful prototypes

- The designer builds the prototype (D23) in the project's own repo, **from its real components and styles**, so what the human approves is what the build will look like. No separate mockup tool, no restyled copies.
- It's built on a **`design/<ref>` branch** (e.g. `design/COR-70`) off the default branch. The runner pushes it, as it pushes any leased branch (D8), but Corral **never opens a PR for it and never merges it**. The build happens in separate tasks (below).
- The prototype uses **mock data and no live API**: no calls to the project's backend or any other service. It has to work as static files on their own.

### How a project builds a prototype

The project's `.corral/agents/designer.md` (D23), `CLAUDE.md` or `CORRAL.md` says how to produce a **static bundle** of the prototype: the command to run and the folder it writes (an `index.html` and its assets, with relative paths). Corral doesn't guess. If a project doesn't say, the designer reports `stuck` and asks.

### Design versions

Each submission is a new, **immutable** design version, numbered per task (v1, v2, …). A version holds:

- the **static bundle**, as one archive;
- a **`design.md` spec**: the screens (each with a stable id), their states, the components used, the interactions and the mock data's shape;
- **screenshots**, one or more per screen;
- the **branch and commit SHA** it was built from.

The bundle, spec and screenshots are content-addressed blobs and the database stores pointers (D8), so a version survives force-pushes, branch deletion and worktree cleanup. A version's state is *submitted*, *approved* or *superseded*.

### Tools

- **`submit_design`** (designer, design tasks only; D23): takes the bundle folder, the `design.md` path and the screenshot paths. The runner pushes the branch and uploads the files, and the server records a new version at the pushed commit. The run then ends with `report_outcome('design_submitted', summary)`, which the server accepts only when a version exists for the branch's current commit and every acceptance criterion has evidence (D19; the screenshots can be attached as that evidence).
- **`get_design`** (designer, developer, reviewer and PM; D23): returns a version's spec, screen ids, screenshots, branch and commit, and the URL of its sandboxed preview. With no version given it returns the one that applies: a design task's latest version, or a build task's pinned version.

### Review

- **Design tasks always need human review**, whatever their human-review flag says. Valid `design_submitted` → **Agent review**: the reviewer checks the version with `get_design` against the criteria and the project's real components. Reviewer requests changes → In progress, as for any task. Reviewer approves → **Human review**, never Ready to merge.
- **Request changes:** the human's feedback goes back to the designer (D23) (Human review → In progress), and the next submission is a **new version**. Earlier versions are kept unchanged.
- **Approve:** marks that version **approved** and **supersedes** every earlier version. The task moves to **Approved** (a new status, below). There's nothing to merge, so no CI wait and no merge gates.

### Auto-planning

- **Approving a version starts a Plan session** for the build, in the task's project. The server opens it with a message that links the design task and the approved version. The message is the human's: the approval is what triggers it.
- The PM reads the version with `get_design` and proposes the build with `propose_plan` as usual. It **may split the build across several epics**. Each build task **pins the design version and the screens it covers** (screen ids from `design.md`), and its developer reads them with `get_design`.
- **Build tasks get the pinned version as files.** Before a pinned task's developer or reviewer starts, the runner fetches the version with `get_design` and saves its `design.md`, screenshots and extracted bundle **read-only in the run's scratch folder, outside the worktree**. The prompt names the design branch for reference only: it's never checked out or merged. The developer attaches, per screen it builds, a screenshot of the build **side by side with the matching prototype screenshot** as evidence, and the reviewer compares them.
- The plan is approved by the human as any other plan (D9). Build tasks are normal `task`s, open PRs and merge.

### Changes after planning

- The human can reopen an Approved design (Approved → In progress, with feedback). The approved version stays approved until a newer one is.
- **Approving a newer version flags the pinned build tasks that haven't started** (Draft, Backlog or Ready with no run yet): each shows "design changed: v2 → v3" until the human or the PM repins or revises it. The approval opens a Plan session as above, listing the flagged tasks, so Juno can propose revisions (a plan task with a `ref`, see [flows.md](flows.md)).
- Tasks that have started keep the version they pinned. Catching them up is a new task.

### Security

- **Prototype HTML is untrusted**: it's code an agent wrote, from a repo Corral doesn't control (PRD §9).
- The server serves a version's bundle from the blob store under its own path with a `Content-Security-Policy: sandbox allow-scripts` header (an opaque origin, so no cookies, storage or same-origin access to Corral) and a CSP that allows only the bundle's own files (`connect-src 'none'`, so no network calls). The web app shows it in an `<iframe sandbox="allow-scripts">` without `allow-same-origin`. Never serve it from Corral's origin unsandboxed, and never inline it into a Corral page.

### Amendments to earlier decisions

- **D19:** there are four task types. The PM picks `design` in `propose_plan` for work whose look or flow should be agreed before it's built. Board and Backlog cards show a badge for Design too. Jev (D15) gets `design` as a type value.
- **D10:** a new status, **Approved**: "Design approved by the human; nothing to merge." It's on the board after Merged. New transitions: In progress → Agent review on a valid `design_submitted` (Server); Agent review → Human review for a design task, whatever its flag (Server); Human review → Approved when the human approves a design (**Human only**); Approved → In progress when the human reopens it (**Human only**). Design tasks never enter Ready to merge or Merged. A dependency on a design task counts as satisfied once it's Approved. Deleting an Approved task soft-deletes it like the others in Ready…Failed, deletes its `design/<ref>` branch when safe and keeps its versions' blobs.
- **D5:** the human-review flag doesn't apply to design tasks; they always go to Human review.
- **D9:** a PM turn runs when the human sends a message **or approves a design version**, which posts the human's message above. Nothing else starts one.
- **D11:** a design in Human review is a Needs-you item, with the version's screenshots and preview link; "design submitted" and "design approved" are Activity.
- **PRD §4.3** ("the unit of work that becomes one PR"): a design task becomes an approved design version, not a PR.

**Why:** Agreeing on a UI before it's built is cheaper than reviewing it in a PR, and a prototype built from the real components shows what will actually ship. Immutable versions let build tasks point at exactly what was approved, and pinning screens lets one design feed several epics. Keeping the branch unmerged keeps mock data and prototype shortcuts out of main.

**Consequences for the build:**
- `TASK_TYPES` gains `design`, with a new migration for the enum. `packages/core` gains the Approved status and its transitions.
- New tables for design versions (task, number, state, branch, commit, blob pointers) and for build tasks' pins (version, screen ids).
- The runner creates `design/<ref>` branches for design tasks instead of `corral/<taskId>-<slug>`, and exposes `submit_design` only on design-task runs.
- The server's preview route sets the sandbox headers above; the web app gets a design view (versions, screenshots, sandboxed preview, approve and request changes).

---

## D21 — Evidence is for judging criteria; checks are gates

**Status:** Accepted 2026-10-29. Amends D4 and D19 and overrides PRD §7.7's "test results" evidence.

**Amended by D26:** reviewers rerun the gates only when the project has no required checks.

**Decision:**

- **Checks aren't evidence.** Lint, typecheck, tests and build are gates: the developer runs them and the project's required CI checks gate merge. The reviewer runs them without the cache only when the project has no required checks (D26). They are never attached as evidence for a criterion.
- **Human evidence** is what a person would look at to judge a criterion: screenshots and video, real requests and responses, before/after metrics, and the reviewer's per-criterion note.
- **Agent artifacts** are logs, test output and other raw files. They are kept for the reviewer and for debugging, and are collapsed in the UI.
- **Note-only evidence:** a criterion with nothing visual to show (a refactor with no behaviour change, for example) can be covered by a written explanation without a file. The reviewer judges the explanation, and its verdict note is the proof.
- **Criteria describe behaviour.** The PM writes observable behaviour, not criteria that only restate lint, typecheck, tests or build passing, such as "tests pass", "build succeeds" or "lint is clean".
- **Agent instructions:** developers use a note only when there is nothing to show, explaining concretely what changed and how it was checked with file and line references. Reviewers explain why each criterion is met or not in its verdict note, which the human reads next to the evidence; they request changes for visibly testable criteria proven only by a note, or criteria proven only by test output. Spike findings may cite command output as a note with the relevant excerpt rather than a full log where possible.

**Why:** Passing checks is necessary for delivery but doesn't show a person whether the requested behaviour meets a criterion. Separating gates and raw artifacts from human evidence keeps review focused on the result, while note-only evidence avoids meaningless file attachments for work best explained in writing.

---

## D22 — Epic dependencies gate developer work

**Status:** Accepted 2026-10-29 (COR-133).

An epic may depend on other epics. Developers can claim its tasks only when every prerequisite epic is done, in addition to satisfying task dependencies. Tasks without an epic are unaffected. An epic is done when its **epic PR has merged** (D27). In `direct` mode, which has no epic PR, it's done when all its non-deleted tasks outside Draft and Backlog are Merged, as before. An epic with no such tasks is done. *(Amended 2026-10-29 by D27; previously every epic was done once all those tasks were Merged.)* Progress counts the epic's Merged board tasks in every mode. In `direct` mode, completing the last board task wakes tasks in dependent epics immediately, bypassing agent wake intervals; in `epic` and `each_task` modes, merging the epic PR does. Deleting either epic cascades its dependency edges.

The core helper validates epic dependency cycles and cycles in the combined task/epic wait graph, reporting the epics involved. Callers supply the complete proposed graph when validating dependency changes.

---

## D23 — Designers own design tasks

**Status:** Accepted 2026-10-29 (COR-155). Amends D13, D15 and D20 as listed below.

**Decision:** There are four agent roles: `pm`, `developer`, `designer` and `reviewer`.

| Role | Work it claims |
|---|---|
| `pm` | Plan turns (D9), not task execution or review |
| `developer` | Implementation runs for `task`, `bug` and `spike` only |
| `designer` | Creation and revision runs for `design` only |
| `reviewer` | Agent review for `task`, `bug`, `spike` and `design`, including design versions as in D20 |

Design-only authoring guidance goes only to designers: how to build the prototype, authoring `design.md`, using `submit_design` and working on `design/<ref>` branches. Developers do not receive that guidance or `submit_design`. D20's pinned build context is unchanged: developers and reviewers building or reviewing a pinned design still receive its `design.md`, screenshots and extracted bundle as read-only files outside the worktree, with the branch named for reference only. Reviewers still use `get_design` to review design versions; the PM still uses it to plan the build.

### Amendments to earlier decisions

- **D13 — global agents, instructions and seeding:** designers are global agents with concurrency, pause, runtime and usage-limit controls like developers and reviewers. More designers may be added in Settings. A fresh install seeds one Claude designer alongside Juno (PM), Atlas (developer) and Vera (reviewer). Designer instructions come from `.corral/agents/designer.md` on the project's default branch, falling back to Corral's built-in designer defaults when absent, following D13's per-role instructions convention. There is still only one PM.
- **D15 — Jev's menu and session continuity:** for a design task's creation or revision run, the menu lists designers only; for `task`, `bug` and `spike` implementation runs it lists developers only. Agent review still lists reviewers for every task type. These role constraints also apply when routing is off and to human assignments. Eligible agents still follow D15's pause, usage-limit, model and thinking-level rules.
- **D20 — Faithful prototypes, How a project builds a prototype, Tools and Review:** the designer replaces the developer as the prototype author, `submit_design` caller and recipient of design revision feedback. A project may document its prototype build command and output folder in `.corral/agents/designer.md` instead of `CLAUDE.md` or `CORRAL.md`. If no build instructions are supplied, the designer reports `stuck` and asks. Versioning, reviewer review, human approval, design branches and pinned build tasks otherwise work as D20 specifies.

### In-flight design tasks

A design task whose earlier authoring runs used a developer moves to an eligible designer from its **next authoring run**, including retries, requested changes and reopened tasks. Start a **new session** for that designer; never resume the developer's session. Keep the task, existing design branch, versions and feedback so the designer can continue the work. An active run is not interrupted by this change. This is an exception to D15's usual rule that retries retain the same agent and session.

**Why:** Prototype authoring and implementation need different instructions and tools. A separate role keeps each run's context focused while preserving the approved design as the contract for the build.

---

## D24 — Rebase-only rounds preserve approved work

**Status:** Accepted 2026-10-29 (COR-151). Amends D10's task-PR conflict path and review-round accounting.

**Amended by D26:** rebase review leaves the gates to required CI, and runs them without the cache only when the project has no required checks.

**Decision:** When an approved task PR conflicts with its moved base (`base_conflict`), **Ready to merge → In progress** starts a **rebase-only round**. This round, including its rebase review, does not count against `reviewRoundCap`.

### Developer mode

The developer's prompt for this round is limited to fetching and rebasing onto `origin/<default>` (the project's configured `defaultBranch`), resolving conflicts while preserving **both sides' intent**, and re-running the project's gates (lint, typecheck, tests and build, D21). Never revert what main just merged to make the old task pass. Feature changes are not allowed. For a task PR based on an epic branch, use `origin/<base branch>` instead (D27); “main” here means the PR's actual base, not a hard-coded branch name. D27's separate epic-PR conflict-task flow is unchanged.

The developer reports the new **`pr_rebased`** outcome, describing the conflicts and their resolutions. The runner pushes the rebased branch with `--force-with-lease`; the server moves **In progress → Agent review** in rebase-review mode. It retains the approved head, its previous criteria verdicts and the old and new base commits so the reviewer can compare the work before and after the rebase.

### Rebase review

The reviewer:

- Compares the approved head with the new head using `git range-diff` over the old and new commit ranges, so rewritten commits can be checked against the approved work.
- Checks each conflicted hunk against main's change, verifying that the resolution preserves both sides' intent and introduces no feature changes.
- Checks the branch against any binding documentation main changed, and follows D26 for the gates.

If the resolution is clean, the reviewer approves the new head. The **previous criteria verdicts and approval carry over** to that head; a rebase review does not re-judge the feature or require a fresh human approval solely because of the rebase. The task returns to **Ready to merge**, where CI and the live merge gates must pass for the new head.

If the resolution needs changes, the reviewer requests changes: **Agent review → In progress** starts a **normal developer round**, with normal review and `reviewRoundCap` accounting. The developer is no longer restricted to rebase-only work and reports `pr_updated` as usual.

If main changed a **binding decision that the task's criteria rely on**, the reviewer instead **blocks the task for the human**, explaining the changed decision and the affected criteria. It must not pick a side or silently rewrite the criteria, even if the textual conflicts are easy to resolve. COR-118 changing the binding decision under COR-106 is the motivating example.

**Why existing roles:** This is a mode of the existing developer and reviewer roles, not a third agent role. The developer still changes the branch and the reviewer independently judges those changes; only their scope and the review's accounting differ. A third role would duplicate those responsibilities without adding an independent check. Explicit modes keep a mechanical conflict repair from consuming feature-review rounds or becoming an excuse to undo newly merged work.

---

## D25 — Private-network runners and shared authentication

**Status:** Accepted 2026-10-29 (COR-182). Amends D1 and D12.

Corral supports runners on multiple machines over a private tailnet. The server has an optional runner-only listener, separate from the HTTP API. Only that listener may be published on the tailnet; the API stays on localhost or the internal Docker network behind web and Cloudflare Access. The existing internal `/runner` endpoint remains available during the Compose transition.

For the POC, all runners share `CORRAL_RUNNER_TOKEN`. Both runner endpoints require it when configured; the runner sends it in the WebSocket Authorization header, and the server compares it in constant time before registering the runner. The token is never logged. Without a token, only the existing internal endpoint is available; configuring the external listener fails at startup. Shared authentication is separate from runner identity and job scheduling: connections for distinct runner identities remain independent, and a newer authenticated connection replaces only the connection with the same runner identity.

Per-runner pairing and revocation come later with hosting. Remote runners run under WSL2 or Linux and update themselves by pulling from GitHub (see the runner updater task), rather than receiving executable updates from the control plane.

---

## D26 — Reviewers review the code; required CI runs the gates

**Status:** Accepted 2026-10-30 (COR-254). Amends D21 and D24's requirement that the reviewer reruns the gates without the cache, and the same requirement in D27's integration review.

**Decision:**

- **With required checks,** the reviewer doesn't rerun lint, typecheck, tests or build. The project's required checks run them on every push, and the merge gate won't merge without them. Corral's own `ci` workflow gained a build step for this: before it, `nuxt build` only ran at deploy, after merge.
- **Without required checks,** nothing else verifies the gates, so the reviewer still runs all of them itself, without the cache. If a check can't be run without the cache, it explains which and why in its outcome. `requiredChecks` defaults to empty, so this is the default for a new project.
- **The reviewer's prompt says which case applies**, naming the required checks or stating that there are none. The server builds this from the project's `requiredChecks`. Role instructions, including a repo's override (D13), defer to it.
- **The review looks at the code.** The reviewer reads the diff for security, efficiency and logic problems and raises them as specific, actionable feedback. It may run a targeted test or the app when that's the best way to check a criterion or a suspected bug. A cached result never counts as verification.
- **The same rule covers every review of a diff:** agent review, epic integration review (D27) and rebase review (D24). Spike and design reviews have no diff and no gates to run.
- **Unchanged:** a verdict and concrete note for every criterion, and D21's evidence rules. Developers still run the gates before reporting.

**Why:** The rerun duplicated CI and was slow: on COR-59 a reviewer's third full test run hit the background time limit. The reviewer's value is the judgement CI can't give, so its time goes on the diff.

---

## D27 — Epic review modes and epic branches

**Status:** Accepted 2026-10-29 (COR-163). Amends D5, D10, D11 and D22.

This decision was first numbered D23. Migration `0027_epic_review_modes.sql` still cites it by that number, and can't be edited (it has already run).

**Amended by D26:** integration review leaves the gates to required CI, and runs them without the cache only when the project has no required checks.

**Amended by COR-166:** a rebase conflict blocks the epic PR with a Needs-you item naming the conflicting files, and the conflict task exists only once the human hands the rebase over from that item. Epic PRs always squash, whatever the project's merge method.

**Principle:** the project's **target branch**, `defaultBranch` in project settings, only receives approved work. Corral assumes nothing about the target branch's name or how the project releases from it. Docs, prompts and code say "target branch" and read it from the project, never a hard-coded name.

**Decision:**

### Review modes

Each epic has a **review mode**. The PM can set it per epic in `propose_plan`; when the plan doesn't, the epic takes the project's **default review mode** (a project setting). The setting starts at `direct` for every project, so nothing changes until the human picks another mode.

| Mode | Where task PRs merge | When a task goes to Human review |
|---|---|---|
| `epic` | The epic branch | Only when the task's own `humanReview` flag is set. Otherwise it merges on the reviewer's approval. |
| `each_task` | The epic branch | Always, whatever the flag. |
| `direct` | The target branch | Only when flagged (D5, today's behaviour). No epic branch and no epic PR. |

Tasks without an epic are unchanged: they merge straight into the target branch, by D5. Changing an epic's mode is only allowed before any of its tasks has opened a PR or merged *(narrowed by COR-169; previously before any had merged)*.

### The epic branch

- In `epic` and `each_task` modes, Corral creates the epic branch in its own branch namespace, `corral/epic-<epicId>-<slug>`, from the tip of the target branch when the epic's first task is claimed.
- The epic's task branches are created from the epic branch, and their PRs use it as their base. Task PRs merge into it with the project's merge method (squash), so each task is one commit on the epic branch.
- When the epic branch moves under an open task PR, Corral rebases the task PR onto it, exactly as it does for the target branch (D10, `flows.md` step 7c).
- The target branch is **never merged into** the epic branch. Corral doesn't keep the epic branch up to date while the epic is in progress; the epic branch only meets newer target-branch work when it's rebased just before the epic PR merges (below).

### The epic PR

- When every board task of the epic has merged (non-deleted tasks outside Draft and Backlog; spikes and approved designs count as done, as in D22), Corral opens the **epic PR** from the epic branch into the target branch.
- **Integration review:** the reviewer agent reviews the epic PR as an integration check. It judges the combined diff against the epic's goal and its tasks' criteria, looks for problems between tasks that each passed review alone, and follows D26 for the gates. It doesn't re-judge each task's evidence.
- **Human review:** after the reviewer approves, the epic PR always goes to the human, whatever the mode or the tasks' flags.
- **Fix-task loop:** if the reviewer or the human requests changes, Corral creates a **fix task** in the epic, in Ready, titled from the feedback, with the feedback as its description and its points as criteria, and the epic PR's review state becomes changes requested. It goes through the epic's review mode like any other task and merges into the epic branch. When it has merged, and every other board task of the epic has too, the epic PR goes back to integration review and then to the human.
- **Rebase before merge:** once the human approves, the epic PR waits for CI. Just before it merges, if the target branch has moved, Corral rebases the epic branch onto the target branch (GraphQL `updatePullRequestBranch` with `updateMethod: REBASE`, as for task PRs). A clean rebase keeps the approval and CI runs again on the new head.
- **Rebase conflict:** a conflict leaves the target branch unchanged and blocks the epic PR (review state `conflict`) with a **Needs you** item naming the epic and the conflicting files. From that item the human can hand the rebase to a developer, which creates a **conflict task** in the epic, in Ready, whose branch is the epic branch itself rather than a new task branch. Its developer rebases the epic branch onto `origin/<target branch>`, resolves the conflicts, runs the gates and reports `pr_updated`; the runner force-pushes the epic branch with `--force-with-lease`, and no separate task PR is opened. A conflict task goes to Agent review and, in `each_task` mode, Human review, like any task in the epic. Once it's approved, the epic PR goes back to integration review and then to the human, because a resolved conflict isn't a mechanical update.
- **Merge:** the epic PR squash-merges into the target branch, after the final gate check against live GitHub data (`flows.md` step 8). Corral then deletes the epic branch.
- **New tasks while the epic PR is open:** a task added to the epic's board holds the epic PR back. The epic PR can't merge until that task has merged into the epic branch, and then it goes back to integration review.

Epic PR review state is kept on the epic (open, agent review, human review, changes requested, ready to merge, conflict, merged), not as a task status. While the state is changes requested the epic PR can't be approved or merged.

### Amendments to earlier decisions

- **D5:** in `epic` mode the human-review flag works as before, but "merges" means merging into the epic branch. In `each_task` mode every task goes to Human review, whatever its flag. Every epic PR goes to Human review. Tasks without an epic and tasks in `direct` epics are unchanged.
- **D10:** the statuses are unchanged. For a task in an `epic` or `each_task` epic, **Ready to merge** waits for CI and its base, the epic branch, and **Merged** means merged into the epic branch. A dependency on such a task is satisfied when it's Merged if the dependent task is in the same epic; otherwise only once that epic is done (D22), since the work isn't on the target branch until the epic PR merges. Agent review → Human review also fires on the reviewer's approval for every task in an `each_task` epic. The deletion rules gain one case: deleting the last board task of an epic whose PR is open leaves the epic PR to the human, who can close it.
- **D11:** an epic PR in human review is a **Needs you** item, with the integration review's verdict and the combined diff, and approve and request-changes actions. A rebase conflict is a **Needs you** item too. "Epic PR opened", "epic PR approved", "epic PR conflict" and "epic PR merged" are Activity. Fix and conflict tasks reach the Inbox like any other task.
- **D22:** an epic is done only when its epic PR has merged, except in `direct` mode (amended in place, see D22).

**Why:** Merging each reviewed task straight into the target branch lands half-built features there, which the project may release from at any time. Collecting an epic's tasks on its own branch keeps unfinished work off the target branch while still letting the reviewer approve tasks one by one. The human then reviews the feature as a whole, once, at the epic PR. Squash merges at both levels keep the target branch's history to one commit per epic, and rebasing instead of merging the target branch in keeps the epic branch's history linear and its PR diff to the epic's own work. `direct` keeps today's behaviour for projects or epics that don't need any of this.

**Consequences for the build:**
- Projects gain a default review mode; epics gain a nullable review mode, an epic branch name and the epic PR's number and review state.
- The runner creates task branches from `origin/<epic branch>` (or `origin/<target branch>` for tasks without an epic and in `direct` mode), and conflict-task runs check out the epic branch itself.
- The server opens, reviews, rebases and merges epic PRs, creates fix and conflict tasks, and computes epic done-ness and cross-epic dependencies with the rules above.

---

## D28 — Criteria checked by a human

**Status:** Accepted 2026-10-30 (COR-249). Amends D5, D10 and the per-criterion evidence and verdict requirements in D21 and D26.

- Each acceptance criterion has a **Checked by a human** flag, false by default. The PM can set it in `propose_plan`, and the human can toggle it on the task page. Re-proposing matching text without an explicit flag preserves the existing choice; only an explicit `checkedByHuman` changes it.
- Developers skip attempting these checks and producing evidence for them. Reviewers must not request changes over them or their missing evidence, and omit their verdicts. Corral records **Needs human check** (`met: null`), rather than met or unmet. Other criteria keep the usual evidence and verdict requirements.
- **D5:** reviewer approval with any such criterion always goes to **Human review**, even with `humanReview: false` and in any epic review mode. The task's own flag is unchanged. Tasks with no human-check criteria keep their existing routing.
- **D10:** reviewer approval takes **Agent review → Human review** when any criterion needs a human check. Adding a new human check after approval takes **Ready to merge → Human review** (`require_human_check`). Rebase-only approval carryover remains as in D24.
- The Inbox lists the criteria with **Needs human check** and a checkbox per criterion. The human ticks each before approving; ticks are local to the selected item. Approval resolves the Inbox item and follows the existing human approval and merge gates, excluding these criteria from the agent-evidence gate. Requesting changes remains available.

**Why:** checks requiring a person or a real device must reach the human, rather than trapping developers and reviewers in a loop over evidence no runner can produce.
