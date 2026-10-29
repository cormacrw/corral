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

Only the flag sends a task to a human. A project with no required checks doesn't force human review: its unflagged tasks merge on the reviewer's approval alone (amended 2026-10-28; previously every task in such a project needed a human). Either way the task then sits in *Ready to merge* until it's merged, and all other merge gates in PRD §7.9 still apply.

**Amended by D20:** Design tasks always go to *Human review*, whatever their flag, and never to *Ready to merge*.

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

**Decision:** Each PM chat turn is a runner job with role `pm`. The runner fetches the repo, updates a **read-only checkout of the default branch**, and runs `claude -p --resume <sessionId>` there. The PM gets its context from local files (code, `CORRAL.md`, wiki) and live board state through MCP tools (`list_tasks`, `get_task`, `get_run_outcomes`, `ask_question`, `propose_plan`, `approve_plan`, `flag_stale_docs`). It has **no** tools to merge, edit docs or change task status, and it approves plans only on the human's say-so (below).

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
| In progress | Agent review | Valid `pr_opened` / `pr_updated` outcome (branch pushed at the expected commit, evidence for every criterion) | Server |
| Agent review | In progress | Reviewer requests changes | Server |
| Agent review | Human review | Reviewer approved; task flagged for human review | Server |
| Agent review | Ready to merge | Reviewer approved; not flagged | Server |
| Human review | Ready to merge | Human approves | Human |
| Human review, Ready to merge | In progress | Human requests changes | Human |
| Ready to merge | In progress | CI fails; base-branch conflict | Server |
| Ready to merge | Agent review | A new commit other than a clean base-branch update; it needs a fresh review | Server |
| Ready to merge | Merged | All gates pass against live GitHub data; merge confirmed by GitHub | Server |
| Agent review, Human review, Ready to merge | Merged | GitHub shows the PR merged outside Corral | Server |
| Ready, In progress, Agent review, Human review, Ready to merge | Blocked | See causes below | Server |
| In progress, Agent review, Ready to merge | Failed | See causes below | Server |
| Blocked, Failed | Backlog, Ready or In progress | Human resolves it (In progress keeps the branch and PR) | **Human only** |

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

**Status:** Accepted. Replaces the PRD's "Human queue" (§7.11, §12.2) and its separate notifications. Amended 2026-10-29 (COR-103): open Plan sessions now appear in the Inbox too (see the amendment below).

**Decision:** The PRD's Human queue is called the **Inbox**. It only holds items raised by developer and reviewer runs, which happen in the background while the human is elsewhere:

- **Needs you:** tasks in **Human review**, **Blocked** tasks (including an agent asking a question, which reports `stuck` and blocks the task with the question as its reason) and **Failed** tasks. Each item can be resolved from the Inbox itself, following the D10 transitions. An item stays until it's resolved; reading it doesn't clear it.
- **Activity:** informational events from those runs (PR opened, changes requested, approved and merged). Nothing to act on.

A design in Human review is a Needs-you item like any other (D20).

Nothing from the PM goes in the Inbox. *(Amended 2026-10-29, see below: open Plan sessions do.)* PM questions (`ask_question`), proposed plans and plan approval live in the **Plan** conversation. A PM turn only runs when the human sends a message or approves a design (D9, D20), so the human is already there. `flag_stale_docs` creates a task in Backlog.

There is no separate notifications feed or bell. System events (usage limits, runner disconnects) are shown on Runs and in the runner status, not in the Inbox. OS or desktop notifications can be added later and would point into the Inbox or Plan.

**Why:** Copying PM questions into a queue duplicates a conversation the human is already reading. Keeping the Inbox to agent work that's waiting on the human makes its count mean one thing: how many agents are stuck on you.

**Amended 2026-10-29 (COR-103): open Plan sessions appear in the Inbox.** Each open Plan session is a **Plan thread** item in the Inbox, alongside the developer and reviewer items above.

- **Open and closed:** a session is open until its plan is approved, to the board or the Backlog, which marks it `closed` (COR-38). It opens again when the human sends it a message. Only open sessions are Inbox items; a closed one leaves the Inbox and isn't listed under Resolved.
- **Needs you:** every open session is under **Needs you**. Sessions that need something from the human come first: a plan **needing approval**, a **question** from Juno, or an **unread reply** (a finished Juno turn the human hasn't seen). The other open sessions are sorted below those. Within each group the newest activity comes first.
- **Count:** the Needs you count (the Inbox badge and tab) only counts the sessions in the first group: needing approval, a question or an unread reply. A session that's merely open doesn't add to it.
- **Where to act:** PM questions and plan approval can be handled from the Inbox *or* from Plan. Both use the same endpoints and the same rules (D9: only the human approves a plan), so answering or approving in one place updates the other live (`plan.session` events). Replying from the Inbox sends a message to the session and starts a PM turn, exactly as sending it in Plan does.
- **Unchanged:** `ask_question`, `propose_plan` and `approve_plan` still belong to the Plan session; the Inbox shows the same conversation rather than a copy. System events stay out of the Inbox, and Activity still only holds developer and reviewer events.

**Why the amendment:** with several Plan sessions open across projects, the Inbox was the one place that didn't show what Juno was waiting on, and the human had to check Plan separately. Showing the open sessions themselves (not copies of their questions) keeps one conversation per session while making the Inbox the single list of everything waiting on the human. Plan's own Recent sessions list is dropped, because the Inbox and the side nav threads cover it.

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

- **Pull, not push:** the server polls GitHub. Nothing new is exposed through the Cloudflare Tunnel, GitHub holds no credentials for the server, and no self-hosted GitHub Actions runner runs on it (the repo is public, so that would let fork PRs run code there).
- **The update hold** (`POST /api/update-hold`, lifted with `DELETE`): two phases, both reported as `updating` by `GET /api/status` and shown in the app banner. **Draining:** no new developer, reviewer or design runs or merges start; PM turns still start as usual, including Inbox replies. **Finishing:** once no non-PM runs or merges are in flight, new PM turns are accepted and saved as `queued` runs holding their `pmJob`. Running PM turns finish. `POST` counts all active runs (including PM) and merges, excluding queued PM turns still holding their job; the deploy polls until zero. `DELETE` or a server restart clears both phases and starts queued turns.
- **In memory only:** the redeployed server starts without the hold, so a deploy can't leave Corral stuck on hold. If the deploy fails, the script lifts it.
- **Why the server restart counts too:** while the server is down, the runner drops what it sends, so a run that ends during a server restart would be marked interrupted.
- **Order:** build first (the old containers keep serving), then hold and wait, then `docker compose up -d`. A change that only rebuilds `web` deploys without a hold. If the server can't be reached, the deploy goes ahead, so a broken server never blocks its fix.

**Why:** Interrupted runs don't count as failures, but the agent's work in flight is lost and has to be redone. Every run has a time limit, so the wait is bounded.

**Consequences for the build:**
- New worker runs and merges must respect both hold phases. PM dispatch must respect the finishing phase while accepting messages in Plan and Inbox throughout. Count dispatched PM turns in `busy`, but exclude held jobs so the deploy can finish. The existing auto-deploy polling loop needs no change.
- The hold endpoint sits on the same API as the rest of the app, behind Cloudflare Access. It needs proper auth when hosting arrives (D1).

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
  - **Approved:** the spike goes straight to **Merged**, the final column (or to Human review first when flagged, then Merged on the human's approval). It never enters Ready to merge, `mergedAt` records when it finished, and its worktrees are cleaned up. Tasks that depend on it unblock as for any merged task.
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

- The developer builds the prototype in the project's own repo, **from its real components and styles**, so what the human approves is what the build will look like. No separate mockup tool, no restyled copies.
- It's built on a **`design/<ref>` branch** (e.g. `design/COR-70`) off the default branch. The runner pushes it, as it pushes any leased branch (D8), but Corral **never opens a PR for it and never merges it**. The build happens in separate tasks (below).
- The prototype uses **mock data and no live API**: no calls to the project's backend or any other service. It has to work as static files on their own.

### How a project builds a prototype

The project's `CLAUDE.md` or `CORRAL.md` says how to produce a **static bundle** of the prototype: the command to run and the folder it writes (an `index.html` and its assets, with relative paths). Corral doesn't guess. If a project doesn't say, the developer reports `stuck` and asks.

### Design versions

Each submission is a new, **immutable** design version, numbered per task (v1, v2, …). A version holds:

- the **static bundle**, as one archive;
- a **`design.md` spec**: the screens (each with a stable id), their states, the components used, the interactions and the mock data's shape;
- **screenshots**, one or more per screen;
- the **branch and commit SHA** it was built from.

The bundle, spec and screenshots are content-addressed blobs and the database stores pointers (D8), so a version survives force-pushes, branch deletion and worktree cleanup. A version's state is *submitted*, *approved* or *superseded*.

### Tools

- **`submit_design`** (developer, design tasks only): takes the bundle folder, the `design.md` path and the screenshot paths. The runner pushes the branch and uploads the files, and the server records a new version at the pushed commit. The run then ends with `report_outcome('design_submitted', summary)`, which the server accepts only when a version exists for the branch's current commit and every acceptance criterion has evidence (D19; the screenshots can be attached as that evidence).
- **`get_design`** (developer, reviewer and PM): returns a version's spec, screen ids, screenshots, branch and commit, and the URL of its sandboxed preview. With no version given it returns the one that applies: a design task's latest version, or a build task's pinned version.

### Review

- **Design tasks always need human review**, whatever their human-review flag says. Valid `design_submitted` → **Agent review**: the reviewer checks the version with `get_design` against the criteria and the project's real components. Reviewer requests changes → In progress, as for any task. Reviewer approves → **Human review**, never Ready to merge.
- **Request changes:** the human's feedback goes back to the developer (Human review → In progress), and the next submission is a **new version**. Earlier versions are kept unchanged.
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

**Decision:**

- **Checks aren't evidence.** Lint, typecheck, tests and build are gates: the developer runs them, the reviewer reruns them without the cache, and the project's required CI checks gate merge. They are never attached as evidence for a criterion.
- **Human evidence** is what a person would look at to judge a criterion: screenshots and video, real requests and responses, before/after metrics, and the reviewer's per-criterion note.
- **Agent artifacts** are logs, test output and other raw files. They are kept for the reviewer and for debugging, and are collapsed in the UI.
- **Note-only evidence:** a criterion with nothing visual to show (a refactor with no behaviour change, for example) can be covered by a written explanation without a file. The reviewer judges the explanation, and its verdict note is the proof.
- **Criteria describe behaviour.** The PM doesn't write criteria like "tests pass" or "build succeeds".

**Why:** Passing checks is necessary for delivery but doesn't show a person whether the requested behaviour meets a criterion. Separating gates and raw artifacts from human evidence keeps review focused on the result, while note-only evidence avoids meaningless file attachments for work best explained in writing.
