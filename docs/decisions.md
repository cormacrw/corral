# Decisions

How Corral works now, and why. **Where this conflicts with [prd.md](prd.md), this wins.**

Each decision has an ID so code comments, commits and PRs can refer to it (e.g. "per D2"). IDs never change and are never reused. The decisions are grouped by area, so they aren't in number order. Original wordings, the dated amendments, removed mechanisms and migrations are in [decisions-history.md](decisions-history.md), which isn't binding.

**Vocabulary (D31).** People see tasks and subtasks. A task's subtasks deliver through its **delivery record**, a row in `epics`; `epic`, `epics`, the `parent` status and related tool and argument names are internal identifiers. "The task's branch" and "the task's PR" mean the delivery record's branch and PR.

## 1. Scope and hosting

### D1 — The POC is local-only; hosting comes right after the MVP

**Decision:** The proof of concept runs on the user's own machine: web UI, control plane, database, scheduler and runner. That machine is the user's home server, running Docker containers (D12). There's no hosted control plane, internet runner pairing or multi-tenant auth.

- Keep the control plane a **separate process** from the runner, talking over the protocol a hosted deployment would use, and keep storage behind interfaces. Hosting should change where things run and how they authenticate, not the architecture.
- The PRD's runner pairing, hosted user auth and revocable runner credentials (§7.4, §8.1, §8.2, §9.1) are **deferred**, not deleted. Don't assume one user forever: actor attribution records who did what.

**Why:** For one user, a hosted control plane adds auth, pairing, revocable credentials, tunnels and multi-tenant security without proving the core loop. Hosting still matters for remote access and teamwork, so it's the next step after the MVP.

### D12 — Corral is deployed as Docker containers on the user's own server

**Decision:** Development happens on the laptop with `pnpm dev`. The deployment target is Docker Compose on the user's home server: `web`, `server`, `runner` and `postgres` (D14), on a private Docker network. It is still a single-user, self-hosted deployment.

- **Exposure:** only `web` is reachable from outside, through the user's Cloudflare Tunnel, with **Cloudflare Access** as the login. Corral has no login of its own. The server API and Postgres are never published; the runner listener is covered by D25.
- **Runner container:** has `git`, `gh`, the agent CLIs (D18), a headless Chromium for evidence (D4) and the target projects' toolchains. Agents run inside it, so it is "the user's machine" for D2.
- **Credentials:** the user logs in to `claude`, `codex` and `gh` inside the runner container (`docker exec -it`), and their config directories live on volumes. Corral never reads, stores or relays them, and they never go through Compose files, `.env` files or Corral config.
- **State:** the server's blob directory, the Postgres data directory and the runner's data directory (clone, worktrees, spool) are volumes.
- **No Docker socket** is mounted into any container. A container per task would be a later `RunnerProvider`.

**Consequences for the build:** nothing may only work on macOS (the runner runs on Linux: no keychain, `open` or BSD-only flags). Data directories, the server URL, bind address and port come from env vars, never hard-coded paths such as `~/.corral` or `localhost`. SSE and WebSocket connections send heartbeats, because Cloudflare drops proxied connections idle for about 100 seconds. `web` builds to static files (`ssr: false`), and one origin serves them and proxies `/api/**` to `server`, so the browser and Cloudflare Access see one hostname.

**Why:** Corral is a personal software factory on always-on hardware the user already runs. Containers also limit what an agent can reach to the runner container.

### D13 — One Corral, many projects; agents and planning are global

**Decision:** One Corral instance manages several projects, each one Git repository. Everything is either global or belongs to one project:

| Global | Per project |
|---|---|
| Plan sessions (global or tied to a project, D30), Inbox, agents, runners, user settings | Overview, Board, Backlog, project settings (name, thumbnail, repo, default branch, merge method, required checks, task ID prefix, review mode default, human review default, pause, limits) |

- **Agents are global.** Juno (PM), Atlas (developer), a designer and Vera (reviewer) are seeded on a fresh install and serve every project. More developers, designers and reviewers can be added (`POST /api/agents`), each with one runtime the runner has; there is only ever one PM. An agent's runtime can change only while it has no queued or running run.
- **Concurrency** applies to developers, designers and reviewers, across all projects. Juno has none: PM turns are limited only to one per Plan session (D9), and `PATCH /api/agents/:id` refuses `concurrency` for the PM with 400 `concurrency_not_applicable`. The `agents.concurrency` column is ignored for `role = 'pm'`.
- **Role instructions** stay in each repo, `.corral/agents/<role>.md` on the default branch, falling back to Corral's built-in defaults, so the same agent can follow different project rules.
- **Plan sessions:** a project session's project is picked in the composer and locked once it has messages; a global session has none (D30).
- **Task IDs are `PREFIX-NUMBER`**, e.g. `COR-29`. Each project has a unique 2–5 letter prefix and its own counter. PRs keep `#41` and runs `#128`.
- **Pause is per project:** it stops new runs for that project only, and the scheduler skips its tasks.
- Every task, plan, run, Inbox item and project session has a `projectId`; Board and Backlog queries are scoped to one project. Two projects can't point at the same repository (PRD §7.1).
- Still open: whether changing a prefix renames existing task IDs ([design/project-settings.md](design/project-settings.md)).

**Why:** A personal software factory runs more than one codebase. Planning, review and agent capacity are shared, while task state belongs to one repo.

### D14 — Postgres in Docker for the deployed instance; PGlite for development and tests

**Decision:** `packages/db` has one Drizzle schema (Postgres dialect) and two drivers, chosen by configuration:

| Where | Database | How it's chosen |
|---|---|---|
| Deployed instance (D12) | **Postgres**, its own container and volume | `CORRAL_DATABASE_URL` is set |
| `pnpm dev`, one per checkout or worktree | **PGlite**, in `.corral/server/pgdata/` | `CORRAL_DATABASE_URL` is unset |
| Unit tests | **PGlite**, in memory, one database per test file | Test helper |
| CI database tests | **Postgres**, a service container | `CORRAL_DATABASE_URL` is set |

- The server is still the only process that opens the database (D8). Migrations are the same files for both drivers and run when the server starts.
- **Anything that depends on concurrency is proven against Postgres.** PGlite has one connection, so its transactions run one after another and a concurrent-claim test passes whether or not the claim is safe. Those tests skip when `CORRAL_DATABASE_URL` is unset, and CI sets it.
- Use only Postgres features PGlite also supports. The Postgres password is a Corral setting in the Compose `.env`, not a model-provider credential. Backups cover Postgres (`pg_dump`) and the server's blob folder.

**Why:** PGlite needs no setup, isolates each worktree and runs inside the runner container, where agents can't start Postgres (no Docker socket). The deployed instance holds real state, where Postgres's crash safety and backups matter, and it's what hosting needs anyway.

### D25 — Private-network runners and shared authentication

**Decision:** Runners can run on several machines over a private tailnet. The server has an optional runner-only listener, separate from the HTTP API; only that listener may be published on the tailnet. The API stays on localhost or the Docker network behind `web` and Cloudflare Access. The internal `/runner` endpoint stays available for the Compose runner.

- All runners share `CORRAL_RUNNER_TOKEN`. When it's set, both runner endpoints require it: the runner sends it in the WebSocket Authorization header and the server compares it in constant time before registering the runner. It's never logged. Without a token only the internal endpoint is available, and configuring the external listener fails at startup.
- Shared authentication is separate from runner identity: a newer authenticated connection replaces only the one with the same runner identity.
- Remote runners run under WSL2 or Linux and update by pulling from GitHub (D16), never by receiving executables from the server ([runner-wsl2.md](runner-wsl2.md)). Per-runner pairing and revocation come with hosting.

### D16 — The home server redeploys itself when main moves, without interrupting runs

**Decision:** A systemd timer runs `scripts/deploy/auto-deploy.sh` every 20 minutes, so merges close together share one deploy. When `main` has moved, it builds the new images and redeploys with Docker Compose. A deploy never cuts off an agent run: if anything other than `web` would restart, the server first goes on an **update hold** and the deploy waits until nothing is running.

- **Pull, not push:** the server polls GitHub. Nothing new is exposed, GitHub holds no credentials for the server, and no self-hosted Actions runner runs on it (the repo is public).
- **No CI gate (COR-514):** the deploy doesn't wait for CI, and CI doesn't run on pushes to `main`. Every PR runs CI and Corral checks it before merging. A commit pushed straight to `main` deploys untested; that is accepted.
- **The update hold** (`POST /api/update-hold`, lifted with `DELETE`) has two phases, both reported as `updating` by `GET /api/status` and shown in the app banner. **Draining:** no new developer, designer or reviewer runs or merges start; PM turns still start. **Finishing:** once no non-PM runs or merges are in flight, new PM turns are saved as `queued` runs holding their job, and running ones finish. `POST` returns the count of active runs and merges, excluding queued PM turns, and the deploy polls until it's zero.
- **In memory only:** `DELETE` or a server restart clears both phases and starts the queued turns, so a deploy can't leave Corral stuck. A failed deploy lifts the hold. The banner offers **Lift**, even after finishing has latched. The PM's `set_update_hold` needs a confirm card (COR-323, D30). The hold covers server restarts too, because a run that ends while the server is down would be marked interrupted.
- **Order:** build first (old containers keep serving), then hold and wait, then `docker compose up -d`. A `web`-only change deploys without a hold. If the server can't be reached, the deploy goes ahead, so a broken server never blocks its fix.
- **Remote runners** update by pulling from GitHub after draining. Runners report their build commit; an update request drains only that runner and lets its runs finish before the host updater replaces it.
- **Recording the deploy (COR-127):** after `docker compose up -d` succeeds, the script waits for the new server and posts `POST /api/deployments` with the repository and the commits deployed. Posting the same commit again returns the existing record. A failed report is a warning and never fails the deploy. The PM's release notes for it are informational (D33).

**Why:** An interrupted run doesn't count as a failure, but its work in flight is lost. Every run has a time limit, so the wait is bounded.

## 2. Agents and runtimes

### D2 — Agents run through the user's own locally installed, authenticated CLI

**Decision:** Corral starts the agent CLI the user installed (`claude`, or `codex` per D18) in the runner container, authenticated with the user's own login. For the POC that's Cormac's personal subscriptions. Corral **never** sees, stores or relays model-provider credentials. The one planned exception is the Jev key (D15), which isn't built.

**Why:** It's the simplest setup for one user, and it avoids Corral "offering" a model login. Background and terms are in [agent-runtime-and-auth.md](agent-runtime-and-auth.md).

**This may change** if Corral is sold: user-supplied API keys, Bedrock/Vertex or explicit approval from Anthropic. The rules in `agent-runtime-and-auth.md` exist so that means a new adapter, not a rewrite.

### D18 — Codex is a second agent runtime

**Decision:** Besides `claude`, the runner can run agents through OpenAI's Codex CLI (`codex`) through a second `AgentRuntime` adapter. Everything D2 says applies to both.

- **The user's own login:** `docker exec -it <runner> codex login --device-auth`, stored on the `codex-config` volume. Corral **never sets `OPENAI_API_KEY`**, anywhere.
- **One runtime per agent:** each developer, designer and reviewer has exactly one runtime. A Codex developer is a separate agent from Atlas, with its own concurrency, pause and usage limits (D3). A task keeps its developer across retries, so a session never moves between vendors.
- **The PM is the exception:** the runtime is picked per Plan session and **locked once it has messages**, because a session ID only works with the vendor that made it. A turn on a session whose runtime isn't available fails clearly instead of starting fresh on the other vendor.
- **Same rules for both adapters** ([agent-runtime-and-auth.md](agent-runtime-and-auth.md)): structured output, neutral `rate_limited` outcomes, optional cost data, the same per-run MCP tools, and nothing vendor-specific in the task model, `RunJob` or the API beyond the neutral `runtime` field.
- The runner detects which CLIs are installed and signed in and reports them; the UI only offers detected runtimes.
- **Terms still open:** whether OpenAI's terms allow scripting `codex` with a user's ChatGPT login is unchecked. Fine for the POC; check before any hosted or paid launch. Handing work to the other vendor at a usage limit is future work.

**Why:** A second vendor adds capacity under subscription limits and a second opinion in review. One runtime per agent keeps sessions, limits and pausing per agent.

### D15 — Jev routes each task to an agent, model and thinking level

**Status:** Accepted 2026-10-28. **Not started:** there is no Jev code. Until there is, any free agent of the right role (D23) claims a task, with its configured model.

**Decision:** When a role has more than one agent, **Jev**, TypeSafe AI's decision model, will pick the agent for a task and the model and thinking level within its runtime.

- One chooser module on the server calls TypeSafe's API directly, with endpoint, model id and key as configuration. Neither the runner nor the PM calls it.
- It's asked when a task becomes Ready (developer or designer), enters Agent review (reviewer), or starts a retry or new round (model and thinking level only, so the agent keeps its session).
- Its input is the task (type, priority, description, criteria, human-review flag, rounds, failed runs, earlier outcomes), the diff size for reviews, and a menu of eligible agents (right role, not paused or rate-limited) with their configured models and thinking levels. Its answer must come from the menu.
- After about 2 s, an error or low confidence, the agent's configured default is used, so an outage never blocks a run. A human's choice is never replaced, and each run records its model, thinking level, Jev's reason and whether the fallback was used.
- The key will be `TYPESAFE_API_KEY` on the server container: never stored, logged or shown, and the only model-provider credential Corral holds (an exception to D2).

**Why:** A fixed menu in and a typed answer out is what Jev is for, at well under $0.001 per task. One runtime per agent keeps usage-limit pausing per agent (D3).

### D3 — Hitting a usage limit is a pausable state, not a failure

**Decision:** When the runtime reports a usage or rate limit, the run ends `rate_limited`, with a reset time when known. It is **not** `failed` and doesn't count toward the failed-run cap. The scheduler pauses that agent until the reset (or a configured backoff), and the UI says why, e.g. "Waiting on usage limit until 3:00pm".

**Why:** Subscription plans have usage windows, and Corral keeps agents busy, so it will hit them. Treating that as failure would block tasks for no reason.

### D23 — Designers own design tasks

**Decision:** There are four agent roles:

| Role | Work it claims |
|---|---|
| `pm` | Plan turns (D9), never task execution or review |
| `developer` | Implementation runs for `task`, `bug` and `spike`, and fixes on a task's PR (D29) |
| `designer` | Creation and revision runs for `design` only |
| `reviewer` | Agent review for every type, integration review (D27) and rebase review (D24) |

- Designers are global agents with concurrency, pause, runtime and usage-limit controls like the others. Their instructions come from `.corral/agents/designer.md`, falling back to built-in defaults.
- Design authoring guidance (building the prototype, `design.md`, `submit_design`, `design/<ref>` branches) goes only to designers. Developers never get it or `submit_design`.
- A designer resumes its own session on the task across revisions (D20).

**Why:** Prototype authoring and implementation need different instructions and tools; separate roles keep each run's context focused.

## 3. Architecture and storage

### D7 — Three processes in a Turborepo: Nuxt web, Hono control plane, Node runner

**Decision:** Corral is a Turborepo + pnpm monorepo with three apps:

- `web`: Nuxt, UI only, built on shadcn-nuxt (D32).
- `server`: Hono control plane, sole owner of the database, scheduler and orchestrator, single instance.
- `runner`: Node/TypeScript daemon that dials out to the server over WebSocket and spawns agents.

Shared code lives in `packages/contracts`, `packages/core` (pure domain logic) and `packages/db` (Drizzle; Postgres deployed, PGlite in development and tests, D14). Node 26 runs the TypeScript directly.

Details, runner rules and resource estimates are in [architecture.md](architecture.md).

**Why:** The runner stays on the user's machine once the server is hosted, so it's separate even locally. Long-running control loops don't belong in the request-driven web layer. TypeScript everywhere lets every app share one contract package, and the runner is I/O-bound.

### D32 — The web app uses shadcn-nuxt, not Nuxt UI

**Decision:** `apps/web` is built on shadcn-vue through the `shadcn-nuxt` module, with shadcn preset `a31Y6GXo`. The server and runner are unaffected.

- **The look:** component style `reka-nova` (`components.json`), neutral base, emerald primary, Geist and Hugeicons. The dark palette picker defaults to `neutral`; a palette a device already saved is kept.
- **Layers:** `components/ui` is stock shadcn-vue and is never edited, so `shadcn-vue diff` keeps working. `components/app` holds the `App*` composites, the only layer features build on for common controls. `features/<name>` owns each product area. `app/queries` is the only code that talks to the server.
- **No network at runtime:** Geist is bundled with `@fontsource-variable/geist`, and icons are bundled by `@nuxt/icon`.
- **Icons:** the app names icons `i-hugeicons-*` through `@nuxt/icon` (`@iconify-json/hugeicons`). `components/ui` uses `HugeiconsIcon` from `@hugeicons/vue` with `@hugeicons/core-free-icons`, as shadcn-vue writes them for `iconLibrary: hugeicons`.

**Why:** Owning the component code gives Corral control of every control's markup and drops a large dependency that also brought fonts, icons, colour mode and an editor. The composites keep one typed API for tone, icons and loading.

### D8 — Storage: one source of truth per kind of data; only the server touches shared stores

**Decision:**

- The **server** is the only process that reads or writes the database and the blob store, and the only one that decides GitHub actions.
- **GitHub calls go through the runner's `gh`.** The server sends each REST or GraphQL call to a runner as a `github` setup job, which runs `gh api`, so the GitHub login never leaves the runner container (D2, D12). GitHub actions therefore need a runner online. This includes reading CI logs for developers (D29).
- The **runner** owns its local disk (clone, worktrees, spool) and is the only thing that pushes, and only to branches it holds a lease for. **Exception:** task integration and rebase operations (D27) hold no task lease. They push candidates to `corral/candidates/<operation>` or `corral/epic-rebase/<operation>` and advance the task's branch under the operation journal, with a compare-and-swap on the expected head.
- **Agents** reach Corral only through per-run MCP tools, and never run `gh`. **web** only talks to the server API.
- Evidence and transcripts are immutable, content-addressed blobs; the database stores pointers. PRs link to Corral's evidence page instead of embedding images.

The full table, disk layout and the known push limitation are in [architecture.md § Storage](architecture.md#storage-d8).

## 4. Tasks: types, statuses and transitions

### D19 — Task types are Task, Bug and Spike

**Decision:** A task's type says what kind of work it is, not which part of the stack it touches:

| Type | What it is | Deliverable |
|---|---|---|
| **Task** (`task`) | Normal PR work: features, chores, refactors, docs | Code on the target branch |
| **Bug** (`bug`) | A fix for wrong behaviour | Code that fixes it |
| **Spike** (`spike`) | An investigation | Written findings |
| **Design** (`design`) | A UI or flow to agree before it's built (D20) | An approved design version |

- **Evidence follows the acceptance criteria**, not the type (D21). PRD §7.7's kinds are guidance.
- **The PM picks the type** in `propose_plan`; `flag_stale_docs` creates a `task`. `TASK_TYPES` in `packages/core` is the single list the database enum, contracts and plan schema are built from.
- **Board cards** (COR-154) show a muted icon for Bug, Spike and Design and nothing for Task, so colour on a card belongs to priority. Backlog rows show a badge for Bug, Spike and Design. The flyout and task page show the type, ref, status reason, review round, design-changed badge, PR link and Paused banner ([design/board.md](design/board.md)).
- **Type lock (COR-298):** a task can't enter or leave `spike` or `design` once it has left Draft or Backlog, and can't switch between `task` and `bug` once it's approved or awaiting merge (`409 task_type_locked`).

#### Spikes deliver findings instead of a PR

A spike goes through the same columns and review as any task, minus the branch, PR and merge:

- **Developer:** works in a detached checkout of the default branch, changes no code, attaches evidence per criterion and reports `findings_reported` with its findings (answer, evidence, recommendation, suggested follow-ups). Nothing is pushed. `pr_opened` and `pr_updated` are refused for a spike, and `findings_reported` for anything else. The findings are posted as a `## Findings` comment and the task moves to Agent review.
- **Reviewer:** gets the latest findings in its prompt and a detached checkout, with no diff, and checks them against every criterion. Changes requested works as for any task.
- **Approved:** always stops in **Human review**, then goes to **Merged** on the human's approval, with `mergedAt` set and worktrees cleaned up. It never enters Ready to merge.
- **Reviews per submission:** each `findings_reported` sets `headSha` to `findings-<runId>`, and reviews are kept per marker as they are per commit. The PM reads a finished spike's findings with `get_task` and can plan from them.

**Why:** Most changes cross the frontend/backend line, so stack-based types were a guess and changed nothing. Whether work is a fix or an investigation is what a reader of the board wants to see.

### D10 — Task statuses and transitions

**Status:** Replaces PRD §5.1 and §5.2.

#### Statuses

| Status | Meaning |
|---|---|
| **Draft** | Proposed by the PM in a plan and not yet confirmed. Belongs to the Plan session of the latest proposed plan that includes it, listed on the Plan tab under that session, never on the board or in the Backlog. The PM's revisions can change or remove it. |
| **Backlog** | Created by the human, or a Draft kept for later, or sent back for rethinking. Never scheduled, and not on the board. |
| **Ready** | Approved and fully specified, possibly with unfinished dependencies. The scheduler starts it once they're done; until then its card shows an amber blocked icon whose **Waiting on** popover lists them, including unfinished prerequisite tasks with subtasks (D22). |
| **In progress** | The developer's (or designer's) turn. |
| **Agent review** | The reviewer's turn. |
| **Human review** | Approved by the reviewer and waiting on the human (D5). |
| **Ready to merge** | Approved. Corral waits for CI and the base, re-checks the gates and merges, or integrates a PR-free subtask (D27). Nobody's turn but Corral's. |
| **Merged** | Final and immutable; follow-up work is a new task. A subtask in `epic` mode is Merged once it's on the task's branch (D27). A finished spike is Merged too. This is what "Done" means in the PRD. |
| **Approved** | A design approved by the human; nothing to merge (D20). |
| **Blocked** | An agent needs a **human decision**. |
| **Failed** | **The system broke** and can't continue on its own. |

A task with subtasks has the internal status `parent`, which never goes through these transitions (D31). There is no Testing, Cancelled or Archived status; see Deleting below.

**Backlog vs the board:** the Backlog has its own view in the main navigation. The board shows only approved work, Ready through Failed. Backlog → Ready moves a task onto the board; Ready → Backlog takes it off.

#### Status = whose turn; lease = whether someone is working

A status says whose turn it is. Whether a run is active is shown by the lease. The scheduler starts a run for any task in **Ready**, **In progress** or **Agent review** that has no lease and whose agent has capacity, so:

- A failed run under the cap, an interrupted, stopped or `rate_limited` run leaves the task in its status with no lease, and the scheduler retries.
- Changes requested puts the task back in **In progress**, and the next developer run continues on the same branch and worktree.

#### Transitions

| From | To | Trigger | Actor |
|---|---|---|---|
| (new) | Draft | PM `propose_plan` | PM |
| (new) | Backlog | The human creates a task, or the PM's `create_task` or `flag_stale_docs` (D30) | Human / PM |
| Draft | Backlog | Human adds the plan to the Backlog | **Human only** |
| Draft, Backlog | Ready | Plan or task added to the board; title, description and verifiable criteria present | **Human only** |
| Ready | Backlog | Sent back for rethinking | Human |
| Ready | In progress | Scheduler claims it; all dependencies done | Scheduler |
| In progress | Agent review | Valid `pr_opened`, `pr_updated`, `commit_submitted` (D27), `findings_reported` (D19) or `design_submitted` (D20): pushed at the expected commit, with evidence for every agent-checkable criterion (D28) | Server |
| Agent review | In progress | Reviewer requests changes | Server |
| Agent review | Human review | Reviewer approved and D5 routes it to the human | Server |
| Agent review | Ready to merge | Reviewer approved and no human review required (D5) | Server |
| Human review | Ready to merge | Human approves | Human |
| Human review | Merged | Human approves a spike | Human |
| Human review | Approved | Human approves a design | **Human only** |
| Approved | In progress | Human reopens a design with feedback | **Human only** |
| Human review, Ready to merge | In progress | Human requests changes | Human |
| Ready to merge | Human review | Human adds a human check (`require_human_check`, D28), except on a PR-free subtask | Server |
| Ready to merge | In progress | CI fails (D29); base conflict (D24) | Server |
| Ready to merge | Agent review | A new commit other than a mechanical base update; it needs a fresh review | Server |
| Ready to merge | Merged | All gates pass on live GitHub data and GitHub confirms the merge, or the integrated commit is recorded (D27) | Server |
| Agent review, Human review, Ready to merge | Merged | GitHub shows the PR merged outside Corral | Server |
| Ready … Ready to merge | Blocked | See causes below | Server |
| In progress, Agent review, Ready to merge | Failed | See causes below | Server |
| Blocked | In progress | The PM answers a developer's own `stuck` question (`answer`, D30) | PM |
| Blocked, Failed | Backlog, Ready or In progress | Human resolves it (In progress keeps the branch and PR) | **Human only** |

All transitions go through `packages/core` and are enforced by the server; anything not in this table is rejected. The PM can propose any human transition on a confirm card, and it runs on the human's click with the human as actor (D30). Merged work can't be edited, by the PM or the human (`409 task_merged`, COR-240).

#### Blocked vs Failed

| Blocked: an agent needs a decision | Failed: the system broke |
|---|---|
| Review-round cap reached (default 5), or the reviewer asks for the same changes twice | Failed-run cap reached (default 3) |
| The developer reports `stuck` | Unrecoverable error (repo not accessible, bad config) |
| A rebase review finds a substantial change (D24) | GitHub merge failed and retrying isn't safe |
| A dependency was deleted | CI still fails after three CI fixes in a row (D29) |

Both reach the Inbox with their reason, after one PM triage turn (D11). Resolving a Failed task resets its failed-run counter; resolving a Blocked task resets its review-round counter.

#### Deleting (instead of Cancelled)

- **Draft, Backlog:** deleted outright. Drafts the PM drops from a revised plan, or of a plan the human discards, are deleted the same way (a Draft the discarded plan only revised goes back to its own session).
- **Ready through Failed, and Approved:** stop any active run, close the PR, delete the Corral branch when safe (never discarding uncommitted work), then **soft-delete**: hidden from the board, with the task and its audit history kept. An Approved design keeps its versions' blobs.
- **Merged:** can't be deleted. **Dependents:** deleting a task others depend on moves them to Blocked with "dependency deleted", unless the human removes the dependency first.
- **Subtasks:** deleting the last board subtask of a task whose PR is open leaves the task's PR to the human, who can close it. Task deletion rules are in D31.

### D31 — Everything is a task: subtasks, top-level views and the migration

**Decision:** A task is the only work item a human sees. A task can have subtasks, one level deep.

- **Tasks with subtasks.** A task with subtasks is a row in `tasks` with status `parent` and a null `epicId`. It has a ref, comments, attachments, audit history and links like any task. Its delivery record is a row in `epics`, linked by `epics.task_id`. There is no `parent_task_id`: a subtask is a task whose `epicId` points at a delivery record with a `task_id`.
- **The engine ignores the parent row.** Claims, the scheduler, the Inbox, merge and promotion filter on working statuses, and delivery logic joins on `tasks.epicId`, so a `parent` row matches neither. It never goes through `transition()`, takes no run or lease and has no PR of its own. Its stage and progress are computed on read from its subtasks and delivery state.
- **Single units stay single.** A top-level task with no subtasks runs standalone. A delivery record gains a task row when its second subtask is added, and plans never create a task with just one subtask. A delivery record left with one subtask keeps `epics.task_id` null, and that subtask stays top-level with its `epicId`.
- **Refused on a task with subtasks:** status changes, runs, leases, PR actions, criteria, task dependencies, and type, human review or membership changes. A task with live subtasks can't be deleted, nor can one that opened a PR. A delivered task takes no new subtasks. A task with comments outlives a discarded plan, empty, for a human to delete. A subtask's membership is fixed for PM edits once it has a PR (`409 task_epic_locked`).
- **Promotion.** A Draft, or a Backlog or unclaimed Ready task with no runs, can gain subtasks. It keeps its ref and comments; its criteria, dependencies, human review and pause move to its first subtask, so promotion lowers no gate (D30). A Ready task's first subtask inherits its description, and a Draft's subtasks stay Drafts in its plan. A task with any run, lease, PR or submission, a design pin or a subtask is refused with a reason. In a plan, promotion happens on approval, and discarding the plan leaves the task as it was.
- **Plans.** `propose_plan` takes `parents` and a task's `parent`, a key or an existing task's ref. The PM plans a feature with parallel parts as a task with subtasks, and a single unit of work as one task.
- **Names.** The UI, Inbox text, PM prompts and tool descriptions say task, subtask, "the task's PR" and "the task's branch", including Corral-created task titles. Developer and reviewer prompts quote literal branch names as they are. The PM sees and sends `update_parent`, `parentId`, `parents`, `defaultReviewMode` and review mode `parent`; the stored value stays `epic`, the project's HTTP field stays `epicReviewModeDefault`, and internal `epic*` identifiers, the runner protocol and branch names don't change (COR-520).

**Why:** Two kinds of work item meant two of every list, page and rule, for one difference: some work has parts.

### D22 — Task dependencies gate developer work

**Decision:** Task dependencies, dependencies between tasks with subtasks and subtask membership are one graph, and every write checks it for cycles (the core helper reports the tasks involved; callers pass the complete proposed graph).

- **A task depends on tasks.** It can't be claimed until each is Merged, or Approved for a design. A subtask in `epic` mode counts as Merged once it's on the task's branch, which satisfies a dependent in the same task only. Anything outside waits until that task is done.
- **A task with subtasks is done** when its task's PR has merged (D27). In `direct` mode, which has no task's PR, it's done when all its non-deleted subtasks outside Draft and Backlog are Merged. A task with no such subtasks is done.
- **Depending on a task with subtasks.** A task that depends on one stays unclaimed until every live subtask is done, Backlog and Draft ones included, and its work is on the target branch (`holdsEpicOpen`). One with no live subtasks holds nothing.
- **Tasks with subtasks depend on each other** through `epic_dependencies`: a subtask can't be claimed until every prerequisite task is done. A task with subtasks takes no task dependencies: when a task gains subtasks, its dependencies move to its first subtask (D31).
- Merging the task's PR, or in `direct` mode merging the last board subtask, wakes the dependent work at once, bypassing agent wake intervals. Deleting either side cascades its edges. Progress counts a task's Merged board subtasks in every mode.

## 5. Review and merge routing

### D5 — The human-review flag decides whether a task auto-merges

**Decision:** Tasks can be flagged `humanReview`. A new top-level task takes the project's human review default unless the plan or human sets it; a new subtask starts without it (D30). Where reviewer approval goes:

| Work | After the reviewer approves |
|---|---|
| Standalone task, or a subtask in `direct` mode | **Human review** if flagged or any criterion is checked by a human (D28); otherwise **Ready to merge**, then merge into the target branch |
| PR-free subtask in `epic` mode (D27) | **Ready to merge** always, then integration into the task's branch. Its flag and human checks become obligations of the task's final human approval |
| Subtask on a task PR into the task's branch (protocol 0, D27) | **Human review** if flagged or any human check; otherwise **Ready to merge**, then merge into the task's branch |
| The task's PR, after integration review | **Human review**, always |
| Spike | **Human review**, always, then Merged (D19) |
| Design | **Human review**, always, then Approved (D20) |

A project with no required checks doesn't force human review: its unflagged tasks merge on the reviewer's approval, and its reviewer runs the gates itself (D26). Every other merge gate in PRD §7.9 applies. Agent approval alone never completes a PR-free subtask's task: the task's PR always reaches the human.

### D6 — CI starts basic (lint)

**Decision:** Each project should start with basic CI, at least linting, as a required check, with more added later. A project with no required checks still auto-merges on the reviewer's approval (D5), and its reviewer runs every gate itself without the cache (D26).

### D28 — Criteria checked by a human

**Decision:**

- Each acceptance criterion has a **Checked by a human** flag (`checkedByHuman`), false by default. The PM can set it in `propose_plan`, and the human can toggle it on the task page. Re-proposing matching text without an explicit flag keeps the existing choice.
- Developers skip these checks and their evidence. Reviewers don't request changes over them or their missing evidence, and omit their verdicts. Corral records **Needs human check** (`met: null`). Other criteria keep the usual evidence and verdict requirements.
- **Routing:** reviewer approval with any such criterion goes to **Human review**, even with `humanReview: false` and in any review mode, except a PR-free subtask, whose checks wait for the task's final approval (D27). Adding a human check in Ready to merge takes the task back to **Human review** (`require_human_check`); on a PR-free subtask the check joins the task review instead. A criterion checked by a human stays open across a rebase (D24).
- The Inbox lists these criteria as **Needs human check** with a checkbox each, local to the item. The human ticks each before approving. Approval excludes them from the agent-evidence gate and follows the usual merge gates.
- On the PR-free path, human-check flags and criterion IDs survive submission and integration, and the agent-approved head can't stand in for them. The task's approval is refused (`human_checks_unconfirmed`) unless every one is confirmed. PM approval cards name every current human check, and adding or rewording one invalidates the old card (D30).

**Why:** checks that need a person or a real device must reach the human, rather than trapping developers and reviewers in a loop over evidence no runner can produce.

### D21 — Evidence is for judging criteria; checks are gates

**Decision:**

- **Checks aren't evidence.** Lint, typecheck, tests and build are gates: the developer runs them and the project's required checks gate the merge (D26). They are never attached as evidence for a criterion.
- **Human evidence** is what a person would look at to judge a criterion: screenshots and video, real requests and responses, before/after metrics, and the reviewer's per-criterion note. **Agent artifacts** (logs, test output and other raw files) are kept for the reviewer and debugging, collapsed in the UI.
- **Note-only evidence:** a criterion with nothing visual to show (a refactor with no behaviour change, say) can be covered by a written explanation without a file. The reviewer judges it, and its verdict note is the proof.
- **Criteria describe behaviour.** The PM writes observable behaviour, never criteria like "tests pass", "build succeeds" or "lint is clean".
- **Agent instructions:** developers use a note only when there's nothing to show, explaining what changed and how it was checked with file and line references. Reviewers explain each verdict in its note, and request changes for visibly testable criteria proven only by a note or only by test output. Spike findings may cite command output with the relevant excerpt.

**Why:** Passing checks is necessary for delivery but doesn't show a person whether the behaviour meets a criterion.

### D4 — Evidence comes from the agent running the app and capturing it with the agent browser

**Decision:** For a criterion with a visible change, the developer runs the app locally, captures **screenshots and/or video** with the agent browser, and attaches them against that criterion. What evidence a criterion needs follows D19 and D21. Open gaps are in [open-recommendations.md](open-recommendations.md) (R3).

### D26 — Reviewers review the code; required CI runs the gates

**Decision:**

- **With required checks,** the reviewer doesn't rerun lint, typecheck, tests or build: the project's required checks run on every push and the merge gate won't merge without them.
- **Without required checks,** the reviewer runs all of them itself, without the cache, and explains any it couldn't run that way. `requiredChecks` defaults to empty, so this is a new project's default. **The prompt says which case applies,** naming the required checks or stating there are none, from the project's `requiredChecks`. Role instructions, including a repo's override, defer to it.
- **The review looks at the code** for security, efficiency and logic problems, raised as specific, actionable feedback. A targeted test or running the app is fine when it's the best way to check a criterion or a suspected bug. A cached result never counts as verification.
- **The same rule covers every review of a diff:** agent review, integration review (D27, D29) and rebase review (D24). Spike and design reviews have no diff and no gates.
- **Developers (COR-444, COR-447):** with required checks, first attempts, review rounds, CI fixes and task rebases run fast checks and the tests relevant to the change, and a CI fix starts from what failed. Task conflict fixes run no checks. Without required checks, every developer run keeps the full local check. Spikes run none. The runner sets `CORRAL_CHECK_SCOPE` to `targeted` or `none`, unset for the full check, so any project's check script can honour it.

**Why:** The rerun duplicated CI and was slow. The reviewer's value is the judgement CI can't give, so its time goes on the diff.

## 6. Task integration and repair

These three decisions cover how work reaches the target branch and how a PR is kept healthy until it merges. [flows.md](flows.md) sections 2 and 4 walk through them.

### D27 — Task review modes and task branches

**Principle:** the project's **target branch**, `defaultBranch` in its settings, only receives approved work. Corral assumes nothing about its name or how the project releases from it; docs, prompts and code read it from the project.

#### Review modes

Each task with subtasks has a **review mode**. The PM can set it in `propose_plan`; otherwise the task takes the project's default review mode, which starts at `epic`.

| Mode | Where subtask work lands | Human review |
|---|---|---|
| `epic` (default) | The task's branch, then one task's PR into the target branch | Once, on the task's PR, which confirms every subtask's flag and human checks |
| `direct` | The target branch, one PR per subtask | Per subtask, by D5. No task's branch and no task's PR |

`each_task`, which also sent every subtask to Human review, is retired: nothing offers or accepts it, and the stored value names only merged history. A mode can change only before any subtask has submitted a commit, opened a PR or merged. Existing `direct` tasks are never converted. Standalone tasks merge straight into the target branch.

#### The task's branch

In `epic` mode Corral creates `corral/epic-<epicId>-<slug>` from the target branch's tip when the first subtask is claimed, and cuts subtask branches from it. The target branch is **never merged into** it; Corral rebases it onto the target at checkpoints (below).

#### Subtasks integrate without a PR (COR-286)

An eligible subtask (a `task` or `bug` in `epic` mode, with its own branch and no PR, in a task whose PR hasn't merged) uses integration protocol 1, persisted on the task (`integration_protocol`):

- **Submit (COR-287):** the developer reports `commit_submitted`. The runner pushes the subtask branch and Corral records an immutable submission: sequence, branch, submitted head, base commit and target task branch. No PR is opened. A revision is a new submission; old heads and verdicts stay as history.
- **Review** is bound to the submitted head, never the branch tip. A verdict for a different head is rejected.
- **Approval** records the exact agent-approved head, separate from the integrated commit. Agent approval goes to Ready to merge whatever the flag (D5).
- **Integrate (COR-288):** `TaskIntegrator` journals an operation in `task_integration_operations` before running it, with a durable ID, the submission, the expected task head, runner identity and lease epoch, in states `pending`, `running`, `reconciling`, `succeeded` and `failed`. One operation per task is active at a time: that unique row is the task's **writer lock**. The runner builds one commit on `corral/candidates/<operation>`, carrying a `Corral-Submission` trailer, and Corral reads required checks there first: a failure returns the subtask to its developer, and a check that never appears on such a commit is left to the task's PR. It then pushes to the task's branch with a compare-and-swap on the expected head. An unknown push result is reconciled by reading the remote before any retry.
- **Merged** means the integrated commit is recorded on the task's branch. Only then can same-task dependents start (D22). A submission, approval, queued operation or failed push unblocks nothing. Approved subtasks wait in Ready to merge while no runner is online.

#### Human review moves to the task (COR-289)

A PR-free subtask's `humanReview` flag and **Checked by a human** criteria become obligations of the task's final human approval. Agents skip the checks (no evidence, `met: null`), and integration review doesn't judge them. The task review lists each subtask's criteria, evidence, human checks and recorded commits, and approval is refused (`human_checks_unconfirmed`) unless the request confirms every obligation on the board at that moment. The audit entry records them.

#### Subtask PRs into the task's branch (protocol 0)

An `epic`-mode subtask whose branch already has an open PR (for example one whose number wasn't recorded after a crash), or whose PR GitHub can't confirm either way, stays on integration protocol 0. Its developer opens a PR into the task's branch, it follows [flows.md](flows.md) section 2 with the task's branch as its base (Human review by D5, rebase rounds by D24), and it merges with the project's merge method. Its merge waits while a rebase of the task's branch is active and holds the delivery record's row, so a rebase can't start under it. Retiring this path is an open decision (simplification report G7).

#### The task's PR

- When every board subtask is done (non-deleted subtasks outside Draft and Backlog; spikes and approved designs count), Corral opens the **task's PR** from the task's branch into the target branch. Its description lists the subtasks with their commits and evidence.
- **Integration review:** a reviewer judges the combined diff against the task's goal and its subtasks' criteria, looking for problems between subtasks that each passed alone. It follows D26 for the gates and doesn't re-judge each subtask's evidence. A repeat review covers what changed (D29).
- **Human review:** after integration review approves, the task's PR always goes to the human.
- **Changes:** reviewer changes go to a developer run on the task (D29). A human's Request changes creates a **fix subtask** in Ready, titled from the feedback, with its points as criteria. While it's open the task's PR review state is `changes_requested` and can't be approved or merged. Once it's integrated, the task's PR goes back to integration review and the human. Any new subtask added while the PR is open holds it back the same way.
- **Merge:** the task's PR always squash-merges, whatever the project's merge method, after the final gate check on live GitHub data. Corral then deletes the task's branch. After three failed merge attempts it goes back to Human review, where approving retries. A PR merged by hand counts as merged; one closed without merging goes back to `open`, and Corral doesn't rebase while it's closed.
- The review state lives on the delivery record: `open`, `in_review`, `human_review`, `changes_requested`, `ready_to_merge`, `merged`.

**What invalidates the task's approval:** a new board subtask, a Backlog subtask reaching the board, or a new task head that the journal doesn't carry (below) sends the task's PR back to integration review and then the human.

#### Automatic task synchronization (COR-290, COR-445)

- **Checkpoints:** a rebase starts when the target has moved and the task reaches a checkpoint: between integrations (a subtask is waiting and no operation is active), before integration review, while the task waits for the human, and before merge. Nothing rebases while an integration review run is live. Corral never merges the target in, and no longer uses GitHub's `updatePullRequestBranch` for tasks with subtasks, because it can't take the lock.
- **Operation:** a rebase is a `rebase` row in `task_integration_operations` with the expected head and target commit (`ontoSha`), holding the writer lock. Polls, reconnects and repeated reports find the active row. Review, approval, subtask merges and the task merge wait while it's active.
- **Clean rebase:** runs on a throwaway candidate on the runner, then publishes with a compare-and-swap. It's mechanical, so it keeps approval, in Human review as well as Ready to merge; CI runs again on the new head.
- **Deferred conflicts:** a conflict is resolved only at the **final checkpoint**, when the human has approved the head now in `ready_to_merge`. Earlier, the operation ends with `Conflict left for the final checkpoint`, frees the lock and starts no run; integration and review carry on on a head behind the target, and the next checkpoint with a moved head or target tries again. It's progress on the task, never a Needs-you item or a failure. At the final checkpoint the conflict becomes a developer run on the task (D29). The merge gate still refuses a head behind the target.
- **Publish check:** the runner refuses a candidate that isn't on `ontoSha` or later, has merge commits, or differs from the target in a path only the target changed since the fork, counting both sides of a rename (a renamed path the task edited may differ but must exist). A fix reported with `behaviourChanged: true`, or an integration review fix, may edit such a target-only file, because the task then returns to integration review, whose prompt lists each with its diff (COR-434). A refused candidate leaves the task's branch untouched.
- **Pause:** nothing starts or pushes while the project is paused, the kill switch is on or an update is held; an active operation resumes afterwards, and settling an unknown push result (a read) may finish.
- **Bounded retries:** failures on the same commits wait 1, then 2 minutes, and the third stops synchronizing (`syncError`): **Rebase stopped** with **Retry**, an `epic_conflict` Needs-you item (D11). A moved task branch or a restart mid-candidate retries at once. A finished candidate that can't be pushed keeps its operation and is pushed again on Retry.

#### Approval across rebases (COR-291)

- **Snapshot:** approval records `approvedHeadSha` and `approvedBaseSha`. Agent and human approval set them; losing approval clears them; a carried approval moves the head and base and keeps the snapshot's commit.
- **Only the journal carries approval:** an operation inherits approval only if it started on the approved head. Any other new head, including a hand-made rebase, loses it and goes back through integration review and the human.
- **Conflict fixes** carry approval only as D29 sets out: `behaviourChanged: false`, the server's compare finds differences only in the conflicted files, and every decision was answered with an alternative that keeps behaviour.
- **Decisions:** when both sides' behaviours can't hold, or the target changed a binding decision the task relies on, the developer reports `stuck` with a `decision`: one question, two to five alternatives each marked with whether it changes approved behaviour, and the affected changes. It's a Needs-you question on the task; the operation keeps its lock and candidate. Choosing an alternative or writing an answer resumes the same operation with a developer run. A written answer, or a question closed another way, counts as a behaviour change.
- **Known gap:** a clean rebase isn't checked against docs the target changed, unlike D24's trivial check, because target work usually touches docs. A binding decision that changes with no textual conflict isn't raised automatically.
- **History:** `GET /api/epics/:id/history`, shown on the task, records `approval_retained` or `approval_invalidated` with the approved commit, the commits before and after, the operation, the fix run and the reason, plus each decision asked and answered.

#### Runner compatibility

Every runner on runner protocol 5 supports integration protocol 1 and takes integration, rebase and fix jobs, so hello advertises no capabilities. A runner on an older protocol is refused at hello and shown as needing an update (`runner_update` Inbox item). A runner whose agent tool contract differs from the server's takes no runs and no setup jobs (COR-435).

**Why:** Merging each reviewed subtask straight into the target branch lands half-built features there, which the project may release from at any time. Collecting a task's subtasks on its own branch keeps unfinished work off the target while agents still review subtasks one by one, and the human reviews the feature once, as a whole. Squashing keeps the target's history to one commit per task, and rebasing instead of merging keeps the task's PR diff to the task's own work.

### D24 — Rebase-only rounds preserve approved work

**Scope:** a PR into the target branch (standalone and `direct` subtasks) or into the task's branch (protocol-0 subtasks). A task's branch is rebased by D27 instead.

When an approved PR's base moves, Corral asks GitHub to rebase it (GraphQL `updatePullRequestBranch` with `updateMethod: REBASE`) and records that it asked, so a clean result is mechanical: approval stands and CI runs again. A conflict (`base_conflict`) moves **Ready to merge → In progress** for a **rebase-only round**, which doesn't count against `reviewRoundCap`.

#### Developer mode

The developer only fetches and rebases onto `origin/<base>` (the PR's actual base), resolves conflicts preserving **both sides' intent**, never reverting what the base just merged, and re-runs the gates (D26). No feature changes. It reports **`pr_rebased`** with `behaviourChanged`, **`review: trivial | needs_review`**, the files it resolved conflicts in and a description. The runner pushes with `--force-with-lease`, and the server keeps the approved head, its verdicts and the old and new base commits.

- **`behaviourChanged: true`** goes to **Agent review**, whatever `review` says, and so does **`needs_review`**.
- **`trivial`:** the server, not an agent, checks two conditions:
  1. Every file whose change differs between the approved diff (**old base → approved head**) and the new diff (**new base → new head**) is in the conflicted-file list.
  2. No project doc (`CORRAL.md`, `CLAUDE.md`, `docs/**`, `.corral/wiki/**`) changed on the base between the old and new base commits.

  If both pass, approval and verdicts carry over and the task returns to **Ready to merge**. Otherwise it goes to **Agent review**, and the reviewer is told which condition failed.

#### Rebase review

The reviewer compares the approved and new heads with `git range-diff`, checks each conflicted hunk against the base's change for both sides' intent and no feature changes, checks the branch against any binding docs the base changed, and follows D26 for the gates.

- **Clean:** approval and verdicts carry over to the new head, which returns to **Ready to merge** even with `humanReview` set, because the human approved before the conflict. A task with an open human check goes to **Human review** instead (D28). CI and the merge gates still run on the new head.
- **Needs changes:** a normal developer round, with normal review and round accounting, reporting `pr_updated`.
- **Substantial change**, including the base changing a binding decision the task's criteria rely on: the reviewer reports `blocked` and the task goes to **Blocked** for the human, explaining the change and the affected criteria. It never picks a side or rewrites the criteria.

**Why:** The developer knows how big its resolution was, and the server check stops it waving through a change outside the conflicted files or under a moved decision. Explicit modes keep a mechanical repair from spending feature-review rounds or undoing newly merged work, without a third agent role.

### D29 — Developers keep a PR healthy until it merges

**Ownership:** a developer keeps a PR healthy until it merges. Clean rebases stay with the server: they need no judgement, so they never start a run.

| Problem | Where it's fixed | Reviewed again? |
|---|---|---|
| Conflict or CI failure on a subtask or standalone PR, or on a PR-free subtask | The same task, by its developer | Only if behaviour changed; unchanged work keeps its approval, subject to the checks below |
| Conflict on the task's branch's rebase (final checkpoint) | A developer run on the task, with no subtask | Only if behaviour changed, or the server's compare fails or finds differences outside the conflicted files |
| CI failure on the task's PR | A developer run on the task | Only if behaviour changed |
| Changes requested by integration review | A developer run on the task | Always |
| A human's Request changes on the task's PR | A new fix subtask, because it's new work with its own criteria (D27) | Always, then integration review and the human |

**`behaviourChanged`** ends every fix and means one thing everywhere: whether approved behaviour now works differently. Not changed: the work keeps its approval, still checked by the server's compare where a conflict was resolved, the publish check on a task candidate, required CI on the new head and the merge gates; an open human check still goes to Human review (D28). Changed: a subtask goes to **Agent review**; a task goes to integration review, then the human.

#### Rounds on a single task

- **CI:** a round started by a real CI failure must report `behaviourChanged` and must move the head (reporting the failed commit is refused). With `false`, approval and verdicts carry over, the task returns to **Ready to merge** and merges only once CI passes on the new head; a PR-free subtask records approval on the new head. With `true`, it goes to **Agent review**. CI failing again after three CI fixes in a row sends it to **Failed**, and a human's Retry starts the count again.
- **Rebase-only rounds** follow D24, with the same `behaviourChanged`. The developer's report is posted as a comment on the task.

#### Fixes on the task's PR

- **Journal:** each fix is a `rebase` operation with `fix` set to `conflict`, `ci` or `review`, holding D27's writer lock throughout. Repeated polls on the same commits find the active row, so they start one run.
- **Run:** a developer run with `epicId` and `operationId` and no task. It counts against developer concurrency, honours pause, the kill switch and an update hold, and appears in the developer's history. It waits while no runner can take it.
- **Branch:** the candidate `corral/epic-rebase/<operation>`, cut from the task's head, with no PR. Corral publishes it with the same compare-and-swap and publish check as a rebase (D27). For a conflict `ontoSha` is the target commit; for a CI or review fix it's the task's head, so the fix must sit on top of it.
- **Brief:** the conflicted files, the CI failure with its output, or the reviewer's feedback, plus decisions already answered.
- **Report:** `pr_updated` with `behaviourChanged`, plus `conflictedFiles` for a conflict.

| Fix | Report | Result |
|---|---|---|
| `conflict` | `false`, and the server's compare finds differences only in the conflicted files | Publish and carry approval, with no review |
| `conflict` | `true`, or the compare fails or finds differences elsewhere | Publish, then integration review and the human |
| `ci` | `false` | Publish; the task stays approved and CI runs again |
| `ci` | `true` | Publish, then integration review and the human |
| `review` | Either | Publish, then integration review and the human |

- **Target-only files:** a fix may not change a file the task never touched that already existed, unless it reports `behaviourChanged: true` or is a `review` fix (COR-434). The integration review lists each such edit with its diff until a review approves.
- **Refused publish:** the branch doesn't move and the operation goes back to a developer run with the reason. Refusals, failed runs and unexpected interruptions (lease expiry, runner shutdown, reconnect loss) count once per run in `fixAttempts`; three set `syncError` and the task shows **Rebase stopped** with **Retry**.
- **Bounded attempts:** three completed CI fixes, or `reviewRoundCap` review fixes, since the last Retry stop the task the same way; the next fix's operation opens stopped.
- **Human Stop** holds the operation in the stopped state until Retry without spending an attempt; saving-work heartbeats keep the stopped run's push permission until a newer run starts. The kill switch pauses scheduling without spending one.
- **Stopped is a Needs-you item:** every `syncError` is an `epic_conflict` Inbox item with the failure, what was tried and Retry, until Retry or the merge. That includes a developer's `stuck` with no `decision`. It asks for no approval.
- **Escalation:** a conflict that needs a product decision goes to the human as COR-291 says (D27), as an `epic_conflict` item carrying the decision.

#### CI output

Developers never run `gh` (D8). The server reads the failed job's step name and log through `GitHubClient.ciFailure`, via the runner's `gh`, and puts them in the prompt of every round started by a CI failure, on a subtask or a task. The runner streams the log with `--allow-escape-sequences` (on this request only, because `gh` otherwise refuses a log with terminal colours) and picks failure lines from the whole log (`FAIL`, `×`, compiler and lint errors, and the end of each package turbo names under `Failed:`). The excerpt is at most 8,000 characters: those lines first, then the end of the log, cut after its last `##[error]` line, marked as untrusted output. If the log can't be fetched, the prompt says so and gives the CI run's URL, and the round still starts.

#### Integration review scope

Gates follow D26, from the same prompt section: with required CI it runs none and gets the CI result for its head, and a failed required check is read from CI, not reproduced. A repeat review's prompt names the last reviewed commit and its summary, and the reviewer covers the diff since then plus anything the fix could affect. A first review covers the whole task.

#### Visibility

The task's page, flyout and board card show the current fix, its developer and reason, and past fix runs with whether behaviour changed. `runs` carry `fixKind`, `behaviourChanged`, `reReviewed` and `operationId`. Flow metrics count these runs as developer work on the task, and compare fixes that needed re-review with those that didn't.

**Why:** A fix subtask made a reviewer and a fresh set of criteria out of mechanical repairs: subtask reviews were 21 of 88 runs measured, with 29% of context tokens. The developer knows whether behaviour changed, and the server, CI and merge gates check everything that doesn't rest on its word. Review is kept for changed work, where it finds something.

## 7. Design tasks

### D20 — Design tasks: faithful prototypes, versioned and approved by the human

**Decision:** A `design` task's deliverable is an approved prototype and spec, not a merged PR. Designers author them (D23).

#### Faithful prototypes

- The designer builds the prototype in the project's own repo **from its real components and styles**, so what the human approves is what the build will look like.
- It's built on a **`design/<ref>` branch** off the default branch, with **mock data and no live API**, and works as static files on their own. The runner pushes the branch like any leased branch (D8), but Corral **never opens a PR for it or merges it**.
- The project's `.corral/agents/designer.md`, `CLAUDE.md` or `CORRAL.md` says how to produce a **static bundle**: the command and the folder it writes (an `index.html` and assets, with relative paths). Corral doesn't guess: without it, the designer reports `stuck` and asks.

#### Design versions

Each submission is a new, **immutable** version, numbered per task (v1, v2, …), holding the bundle as one archive, a **`design.md` spec** (screens with stable ids, states, components, interactions, mock data shape), one or more **screenshots** per screen, and the **branch and commit** it was built from. The files are content-addressed blobs (D8), so a version survives force-pushes and branch deletion. A version is *submitted*, *changes requested*, *approved* or *superseded*.

#### Tools

- **`submit_design`** (designer, design tasks only): takes the bundle folder, `design.md` and screenshots. The runner checks the folder has a root `index.html` and no symlinks, packs it, pushes the branch and uploads the files; the server re-checks the archive and records a version at the pushed commit. The run ends with `report_outcome('design_submitted')`, accepted only when a version exists for the branch's current commit and every agent-checkable criterion has evidence.
- **`get_design`** (designer, developer, reviewer, PM): a version's spec, screen ids, screenshots, branch, commit and sandboxed preview URL. With no version given, a design task's latest or a build task's pinned version.

#### Review and approval

- Valid `design_submitted` → **Agent review**: the reviewer checks the version with `get_design` against the criteria and the real components. Approval → **Human review**, always.
- **Request changes** (reviewer or human) sends feedback to the designer, who resumes its session on the same branch; the next submission is a new version.
- **Approve** (human only; the PM can propose it on a card, D30) marks the version approved, supersedes earlier ones and moves the task to **Approved**. Nothing merges, so no CI wait or merge gates. A dependency on a design is satisfied once it's Approved. The human can reopen an Approved design (Approved → In progress, with feedback); the approved version stays approved until a newer one is.

#### Building the design

- **Approving a version starts a Plan session** for the build in the task's project, opened with a message from the human linking the design task and version.
- The PM reads it with `get_design` and proposes the build with `propose_plan`, possibly across several tasks. Each build task **pins the version and the screens it covers**.
- Before a pinned task's developer or reviewer starts, the runner saves the version's `design.md`, screenshots and extracted bundle **read-only in the run's scratch folder, outside the worktree**. The design branch is named for reference only, never checked out or merged. The developer attaches, per screen, the build **side by side with the prototype screenshot**, and the reviewer compares them.
- **Approving a newer version** flags pinned build tasks that haven't started (Draft, Backlog, or Ready with no run): each shows "design changed: v2 → v3" until it's repinned or revised, and the new Plan session lists them. Started tasks keep their pin; catching up is a new task.

#### Security

Prototype HTML is **untrusted**: agent-written code from a repo Corral doesn't control. The server serves a bundle from the blob store under its own path with `Content-Security-Policy: sandbox allow-scripts` (an opaque origin: no cookies, storage or same-origin access) and a CSP allowing only the bundle's own files (`connect-src 'none'`). The web app shows it in an `<iframe sandbox="allow-scripts">` without `allow-same-origin`. Never serve it from Corral's origin unsandboxed or inline it into a page.

**Why:** Agreeing on a UI before it's built is cheaper than reviewing it in a PR, and a prototype from the real components shows what will ship. Immutable versions let build tasks point at exactly what was approved, and keeping the branch unmerged keeps mock data out of main.

## 8. The PM

### D9 — The PM runs on the runner, not the server

**Decision:** Each PM chat turn is a runner job with role `pm`, running the session's runtime (D18) with `--resume <sessionId>`. Its tools are in D30 and [flows.md](flows.md#pm-tools).

- **Checkout:** a session tied to a project gets its own **read-only checkout of the default branch**, at a path that stays put between turns, fetched and reset before each turn. It reads code, `CORRAL.md` and the wiki from there. A global session has no checkout (D30).
- **Sessions:** the server stores the conversation and the agent session ID. If the session is lost, the next turn starts fresh, seeded with a summary of the stored messages. PM chat needs a runner online.
- **When a turn runs:** when the human sends a message, when the human approves a design version (D20), or when another PM thread messages it (D30). Merged work isn't handed back to the PM; a child thread's completion is saved for its parent's next turn without starting one.
- **One turn per session:** a second message while a turn is active is refused (409 `pm_turn_in_progress`). Other sessions aren't blocked: Juno has no concurrency (D13). A turn waits as `queued`, keeping its job in the database, only while Juno is paused or rate-limited, the runner is offline, the kill switch is on or an update hold is finishing (D16), and starts oldest first once that clears.
- **Warm sessions:** a turn's process outlives its run. The runner starts PM processes in stream-json input mode and sends each message over stdin; a run ends at its `result` line, and the idle process waits for the session's next message. That message reuses it if it's alive, idle, on the same session ID and model, after the checkout is reset and the MCP tools are pointed at the new run and lease. Otherwise the runner kills it and cold-starts with `--resume`. Idle processes die after `CORRAL_PM_WARM_SECONDS` (default 300; `0` disables warm sessions), and on Stop, time limit and runner shutdown. Each turn is still one run, and an idle process holds no slot.
- **Plans:** `propose_plan` results are validated by `core` (dependencies form a DAG, every task has criteria) and saved as versioned drafts. Only the human approves a plan: with the plan flyout's buttons, or by asking Juno in chat, which calls `approve_plan`. That's recorded as the human's approval with the PM run that carried it out, and accepted only when the human has written since the plan was proposed.

**Why:** The model is only reachable through the user's local CLI (D2), so the server can't run the PM. On the runner it also reads the code and wiki directly.

### D30 — The PM is the human's point of contact, through deliberate tools

**Decision:** The PM chat is the human's point of contact for everything in Corral, and planning is one of its jobs. The PM can do anything the human can, through **specific, typed tools for each area**, not one general API tool. [flows.md](flows.md#pm-tools) lists them.

| Area | Covers |
|---|---|
| Tasks and tasks with subtasks | Reading, creating, editing and moving them |
| Projects | Reading them, changing settings, pausing them |
| Runs | Reading them, stopping them, messaging live runs |
| Inbox | Reading items and acting on them |
| Designs | Reading versions, approving them, requesting changes |
| Agents | Reading them, changing settings, adding them |
| Threads | Listing, reading, starting, messaging and closing Plan sessions |

Each tool does one thing with a typed input. The server validates it and applies the human's rules, so a tool never gets around D10's transitions or a project's gates. The PM proposes all new work with `propose_plan`; `create_task` creates a Backlog task directly, and it uses it only when the human asks.

**Why specific tools:** an injected instruction can only reach the actions the tools expose, in the shape they accept; a typed tool is harder to misuse; each tool can have its own confirmation rule; and "Stopped run #128" is a readable audit where "POST to a URL" isn't.

#### Limits and attribution

The PM can't merge PRs, edit docs or its read-only checkout, or approve its own plan (D9). It raises no Needs-you items of its own. Every agent action is attributed to the agent and session that made it, in the task's activity and the audit log, as an informational item (D33). A confirmed action records both the human who confirmed it and the agent and session that proposed it.

#### Confirm-required tools

Destructive or decision-making tools don't act directly: they post a **confirm card** saying what will happen, and the action runs only when the human clicks **Confirm**, through the same endpoint and rules as the app's own button, refused the same way if the state has moved on. They cover:

- **Deleting** a project or task.
- **Stopping** a run, `stop_all` (the kill switch, which also ends PM turns) and `resume_all`.
- **Setting an update hold** (`set_update_hold`, COR-323). `clear_update_hold` is direct, but can't run from a queued turn.
- **Approving** tasks or designs.
- **Moving a task** through a human board transition (`move_task`).
- **Inbox decisions** (`act_on_inbox` `retry`, `resolve`, `send_back`, `delete`). `clarify` is direct: it answers a developer's own `stuck` question through the PM's `answer` transition (Blocked → In progress), which keeps the counters and clears the triage stop the question raised. It's refused on a block from a cap, repeated feedback or a human decision, and on a Stopped item, so it can't lift a cap (COR-246).
- **Lowering a gate:** turning off a task's human review, creating a task without it where the project reviews by default, moving a task somewhere with less review, rewording, removing or clearing a human check, resuming a paused task or project, a review mode with less human review, removing a required check, turning off a project's human review default, or raising its review-round or failed-run cap. The card names exactly what's lowered and shows the other values the call changes. Raising a gate is direct. A delete card names the human gates the task loses, and a `resolve` card says what counter it resets.

This isn't a role restriction: the PM can propose any of these at any time. Task approval cards name every current human check (D28).

**Plans can't lower a gate on existing work.** `propose_plan` refuses a lower review mode on a task with live work, and a revision that turns off human review, moves a task to less review or drops a human check, at proposal and again at approval, pointing at `update_parent` or `update_task`. A revision that leaves `humanReview` out keeps the task's setting. A new top-level task that leaves it out takes the project's default, and a new subtask starts without it. Where the project reviews by default, a plan that sets `humanReview: false` on a new top-level task isn't saved (COR-524). Rewording a human check keeps it a human check. `approve_plan` isn't a confirm card: it keeps D9's rule.

#### API coverage

Every server API route has a PM tool or an **explicit, reasoned exclusion**. Each endpoint's entry in [`packages/contracts/src/endpoints.ts`](../packages/contracts/src/endpoints.ts) names its PM tools (`pm`) or its reason (`noPm`), such as a route only the deploy script calls; [`apps/server/src/pm-route-coverage.ts`](../apps/server/src/pm-route-coverage.ts) derives `pmRouteTools` and `pmRouteExclusions` from it. Keys are exact methods and paths. `pm-route-coverage.test.ts` assembles the real listener through `createServerApp` and checks Hono's route table, with the normal server tests in CI, and checks tool names against `PM_TOOL_NAMES` in `packages/contracts/src/tool-definitions.ts`. A new route needs a mapping or a reasoned exclusion. A mapping records the operation, not an identical transport.

#### Threads and global sessions

Sessions can be **global** as well as tied to a project. A global session has no `projectId` and no checkout; to read code it starts a thread in a project. The PM delegates with `start_thread` and manages threads with `list_threads`, `read_thread`, `message_thread` and `close_thread` (COR-243). A child's completion is saved for its parent's next turn. Messages from another thread are agent input, never the human's approval. `close_thread` refuses a thread with a proposed plan or owned Drafts; only the human's Close thread discards them.

## 9. Inbox

### D11 — The Inbox makes human decisions actionable

**Status:** Replaces the PRD's Human queue (§7.11, §12.2) and separate notifications. The policy is COR-399's.

**Decision:** The Inbox is global, with the project on each item. **Needs you** and its badge count only unresolved decisions that need a human:

- Questions about requirements, authority or recovery an agent can't resolve. A task question reports `stuck` and blocks the task; a PM question uses `ask_question` in its Plan session.
- Plans awaiting approval (D9).
- Completed features: the task's PR after integration review, with the combined diff, evidence and outstanding human obligations (D27).
- Required task-level approvals: standalone, `direct` and protocol-0 subtask reviews required by their flags (D5), designs (D20), spikes (D19) and human checks (D28).
- Exhausted or unsafe recovery: retry and review caps, unresolved requirements, a conflict that needs a product decision, and a task fix stopped at its bound (`epic_conflict`, D29).
- Runners that can't update (`runner_update`, D27).

An item stays until its decision is resolved. Reading it, marking a conversation read or acknowledging an error never clears a question, approval or exhausted-recovery decision. Each shows the reason, the decision needed and a recommendation when available. Items are listed newest first by when they began waiting; updates that keep the same wait don't reorder them.

**Informational:** unread replies, release notes, internal agent reviews, handoffs, progress, the PM's actions and recoverable failures need no acknowledgement to advance work, and the web app doesn't list them (D33). A Plan session with only an unread reply is informational; with a pending question or plan it's actionable even once read. Usage limits and runner disconnects stay on Runs and runner status unless recovery needs a human.

**Default feature loop:** the human agrees requirements and approves a plan for a feature as a task with subtasks in `epic` mode. Agents implement, review, revise and integrate the subtasks, then present the finished feature for one approval or request for changes. Requested changes become a fix subtask, and the result goes through integration review before returning to the human (D27). Internal reviews and handoffs are informational, not checkpoints. Sensitive flags and human checks on PR-free subtasks are confirmed at that final approval; agents neither judge nor auto-confirm them. Approval invalidation, CI and merge gates are unchanged.

**Recovery contract (COR-436):** a new no-progress stop and every cap (failed runs, review rounds and repeated feedback, CI fixes in a row, integration attempts, merge attempts) get one PM triage turn, as do a developer's `stuck` and a rebase review's `blocked` before they escalate. The task's item is hidden only while a triage run is dispatched, or its recovery conversation has a pending question or plan. Triage that's queued, or can't be created because there's no PM, hides nothing. When triage ends with neither, including when it fails, the task decision returns to Needs you with the PM's findings (or that there are none) and guidance. A no-progress stop keeps its In progress or Agent review status and shows as a Stopped item with Retry, Give direction, Send back and Delete, which release the stop without resetting the failed-run counter. Only an explicitly marked retry option on a pending recovery question authorizes a retry.

A failed run isn't necessarily a Failed task. While reconciliation, retry, conflict resolution or a CI fix is still within its limits, the failure is informational and recovery continues. Keep the caps (D10: three failed runs, five review rounds; D27: three failed merge attempts on a task's PR). When recovery is exhausted, unsafe or needs authority the agents lack, show a persistent decision with what was tried and why progress stopped. Never hide it, retry past the cap or auto-approve it. Human resolution resets counters only as D10 says.

**Agent escalation contract:** resolve implementation details from the repository, board, evidence and agent review. Ask the human only for requirements, authority or recovery choices that can't be resolved there, explaining what is blocked, the decision needed and a recommendation when available (or why none is safe), with attempted recovery and remaining options where relevant. `HUMAN_DECISIONS_NOTE` in `packages/core` is the one copy the server's prompts and built-in role instructions use.

**PM sessions in the Inbox:** PM questions and plan approvals stay in their Plan session, actionable from Inbox or Plan through the same endpoints. Only open sessions with unresolved decisions count. Approving or closing a session removes its thread; messaging it reopens it. **Close thread** needs confirmation, discards Drafts and the unapproved plan (only unstaging revised Backlog tasks) and stops its PM turn. The PM can read and act on the Inbox (D30). There is no notification bell.

### D33 — The Inbox has no Activity tab

**Decision:** The web app's Inbox has two tabs, **Inbox** (Needs you) and **Resolved**.

- **Server unchanged:** `GET /api/inbox` still returns `activity`, and the server keeps recording agent progress, PM actions and release notes (COR-129). The web app doesn't list them anywhere for now.
- **Links:** a link to an informational item shows "This isn't waiting on you any more", with the task link when known. Resolved items, including dismissed release notes, open as before.
- **Open:** whether this feed gets a home of its own (a page, or a place in Plan), or stops being produced.

**Why:** The Inbox is for decisions, and the feed wasn't something to read there.

## 10. Mobile

### D17 — A mobile PWA layout, served by the same app

**Status:** Brings into scope part of what PRD §3.2 lists as a non-goal.

**Decision:** Corral has a mobile UI for phones, as a layout of `apps/web`, not a separate app.

- **Same app, same server, same URLs:** `app.vue` decides whether the device is mobile and renders `layouts/mobile.vue` instead of the default layout. `/tasks/COR-1` is the same page in both. There's no separate route tree, API or build.
- **No native app and no new auth:** installable as a PWA at most, with no store builds or push notifications, and reached through Cloudflare Access like a laptop (D12). Auto / Desktop / Mobile is a per-device preference in `localStorage`.
- Pages must work under both layouts: use `useDevice()` to choose a mobile component, and never fork a route. Screens arrive one group at a time ([design/mobile.md](design/mobile.md)); until then a page reflows as well as it can.

**Why:** Most of what needs the human is quick and happens away from the laptop. A layout of the same app keeps one codebase and one live state.
