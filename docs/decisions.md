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

**This may change.** If Corral is packaged and sold, we'll likely need user-supplied API keys, Bedrock/Vertex, or explicit approval from Anthropic. The rules in `agent-runtime-and-auth.md` exist so that switch means writing a new adapter, not a rewrite.

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

**Decision:** For tasks where it applies (frontend and full-stack especially), the developer agent runs the app locally, captures **screenshots and/or videos** with an agent browser, and attaches them to the PR or evidence packet against the acceptance criteria. The evidence types per task type in PRD §7.7 still apply.

Open gaps to consider are in [open-recommendations.md](open-recommendations.md) (R3).

---

## D5 — The human-review flag decides whether a task auto-merges

**Status:** Accepted

**Decision:** Tasks can be flagged as requiring human review.

- **Flagged:** after agent gates pass, the task waits in *Human review* until the human approves or requests changes.
- **Not flagged:** once the reviewer approves and required checks pass, the orchestrator merges it straight away.

All other merge gates in PRD §7.9 still apply in both cases.

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

**Decision:** Each PM chat turn is a runner job with role `pm`. The runner fetches the repo, updates a **read-only checkout of the default branch**, and runs `claude -p --resume <sessionId>` there. The PM gets its context from local files (code, `CORRAL.md`, wiki) and live board state through MCP tools (`list_tasks`, `get_task`, `get_run_outcomes`, `ask_question`, `propose_plan`, `flag_stale_docs`). It has **no** tools to approve, merge, edit docs or change task status.

- The server stores the conversation and the `claude` session ID in the database. If the session is lost, the next turn starts fresh, seeded with a summary built from the database messages.
- `propose_plan` results are validated by `core` (dependencies form a DAG, every task has acceptance criteria) and saved as versioned draft plans. Only a human actor can approve one.
- A PM turn runs only when the user sends a message, plus one delivery summary when an epic finishes.

**Why:** D2 means the model is only reachable through the user's local CLI, so the server can't run the PM. Running it on the runner also gives it direct, fast access to the code and wiki.

**Consequence:** PM chat requires the runner to be online. When hosted, that means the user's runner must be connected to chat.

---

## D10 — Task statuses and transitions

**Status:** Accepted. Replaces PRD §5.1 and §5.2.

### Statuses

| Status | Meaning |
|---|---|
| **Backlog** | Proposed (by the PM or the human) and not yet approved, or sent back for rethinking. Replaces "Needs refinement" (and the earlier name "Draft"). Never scheduled. **Not shown on the board** (see below). |
| **Ready** | Approved and fully specified. **Can still have unmerged dependencies.** The scheduler only starts it once all dependencies are Merged; until then the card shows "waiting on #12". |
| **In progress** | The developer's turn. |
| **Agent review** | The reviewer's turn, then CI and merge gates. Replaces "In review". |
| **Human review** | Agent gates passed; the task is flagged for human review and waiting on the human. |
| **Merged** | PR merged. Final and immutable; follow-up work is a new task. This is what "Done" means everywhere in the PRD. |
| **Blocked** | An agent needs a **human decision**. |
| **Failed** | **The system broke** and can't continue on its own. |

There is no Testing status (add it when a tester agent exists), and no Cancelled or Archived status (see Deleting below).

### Backlog vs the board

Backlog tasks have their own **Backlog** view with its own place in the main navigation. The board shows only approved work: Ready, In progress, Agent review, Human review, Merged, Blocked and Failed. Approving a task (Backlog → Ready) moves it onto the board; sending it back (Ready → Backlog) takes it off.

### Status = whose turn; lease = whether someone is working

A status says whose turn it is. Whether a run is actually active is shown by the lease, not the status. The scheduler starts a run for any task in **Ready**, **In progress** or **Agent review** that has no lease and whose group has capacity. So:

- A failed run under the retry cap, an interrupted run, a stopped run or a `rate_limited` run leaves the task in its current status with no lease. The scheduler simply retries later.
- "Changes requested" puts the task back in **In progress** with no lease, and the next developer run picks it up on the same branch and worktree.

### Transitions

| From | To | Trigger | Actor |
|---|---|---|---|
| (new) | Backlog | PM `propose_plan`, or the human creates a task | PM / human |
| Backlog | Ready | Plan or task approved; title, description and verifiable acceptance criteria present | **Human only** |
| Ready | Backlog | Sent back for rethinking | Human |
| Ready | In progress | Scheduler claims it; all dependencies Merged | Scheduler |
| In progress | Agent review | Valid `pr_opened` / `pr_updated` outcome (branch pushed at the expected commit, evidence for every criterion) | Server |
| Agent review | In progress | Reviewer requests changes; CI fails; base-branch conflict | Server |
| Agent review | Human review | Reviewer approved, all gates pass, task flagged for human review | Server |
| Agent review | Merged | Reviewer approved, all gates pass, not flagged, merge confirmed by GitHub | Server |
| Human review | Merged | Human approves, gates re-checked, merge confirmed by GitHub | Human → server |
| Human review | In progress | Human requests changes | Human |
| Ready, In progress, Agent review, Human review | Blocked | See causes below | Server |
| In progress, Agent review | Failed | See causes below | Server |
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

- **Backlog:** deleted outright.
- **Ready, In progress, Agent review, Human review, Blocked, Failed:** stop any active run, close the PR, delete the Corral branch when safe (never discarding uncommitted work), then **soft-delete**. The task is hidden from the board, but it and its audit history are kept.
- **Merged:** can't be deleted.
- **Dependents:** deleting a task that others depend on moves those dependents to Blocked with the reason "dependency deleted", unless the human removes the dependency first.

---

## D11 — The Inbox holds developer and reviewer items only; the PM stays in Plan

**Status:** Accepted. Replaces the PRD's "Human queue" (§7.11, §12.2) and its separate notifications.

**Decision:** The PRD's Human queue is called the **Inbox**. It only holds items raised by developer and reviewer runs, which happen in the background while the human is elsewhere:

- **Needs you:** tasks in **Human review**, **Blocked** tasks (including an agent asking a question, which reports `stuck` and blocks the task with the question as its reason) and **Failed** tasks. Each item can be resolved from the Inbox itself, following the D10 transitions. An item stays until it's resolved; reading it doesn't clear it.
- **Activity:** informational events from those runs (PR opened, changes requested, approved and merged). Nothing to act on.

Nothing from the PM goes in the Inbox. PM questions (`ask_question`), proposed plans and plan approval live in the **Plan** conversation. A PM turn only runs when the human sends a message (D9), so the human is already there. The one PM turn the human didn't start, the epic delivery summary, shows as an unread dot on the Plan nav item. `flag_stale_docs` creates a task in Backlog.

There is no separate notifications feed or bell. System events (usage limits, runner disconnects) are shown on Runs and in the runner status, not in the Inbox. OS or desktop notifications can be added later and would point into the Inbox or Plan.

**Why:** Copying PM questions into a queue duplicates a conversation the human is already reading. Keeping the Inbox to agent work that's waiting on the human makes its count mean one thing: how many agents are stuck on you.

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

- **Agents are global.** Juno (PM), Atlas (developer) and Vera (reviewer) are set up once, in Settings, and serve every project. Concurrency applies across all projects, not per project. Role instructions stay in each repo (`.corral/agents/<role>.md` on the default branch), so the same agent can follow different project rules.
- **Plan sessions belong to one project.** The project is picked in the composer and locked once the session has messages. Juno works in that project's read-only checkout (D9).
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
