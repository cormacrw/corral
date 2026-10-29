# Architecture

How the Corral POC is structured. Implements D7 in [decisions.md](decisions.md), and builds on D1 (local-only POC, hosting next), D2 and D18 (the user's own `claude` and `codex` CLIs) and D12 (deployed as Docker containers on the user's server).

## Processes

Three processes. In development they're all started together by `turbo dev`; when deployed, each runs in its own container (see [Deployment](#deployment-d12)).

```
┌─────────────┐  HTTP + SSE   ┌──────────────────────┐  WebSocket (runner dials out)  ┌──────────────────────┐
│  apps/web   │ ────────────▶ │     apps/server      │ ◀────────────────────────────── │     apps/runner      │
│ Nuxt + UI   │               │    control plane     │                                 │    local daemon      │
└─────────────┘               │ API · scheduler ·    │                                 │ worktrees · git ·    │
                              │ locks · orchestrator │                                 │ spawns agent CLIs ·  │
                              │ · GitHub · DB        │                                 │ agent tool proxy     │
                              └──────────────────────┘                                 └──────────────────────┘
                               moves to hosting later                                   always on hardware the user controls
```

### `apps/web`: Nuxt + Nuxt UI

- UI only. **No business logic in Nuxt server routes.**
- `ssr: false` for now; everything shown is live data from the server.
- Nuxt `routeRules` proxy `/api/**` to `apps/server` (no CORS).
- Live updates arrive over SSE from the server.
- The one exception is `pnpm --filter web prototype` (D20): a static build of the same app on fixtures from `app/prototype/`, with no server, API or SSE. How to use it is in `CLAUDE.md`.
- Types come from the Hono typed client (`hc`) and `packages/contracts`.
- Theme: `app/app.config.ts` (colors) and `app/assets/css/main.css` (tokens, fonts). After `pnpm install`, `.nuxt/ui/<component>.ts` contains the exact Tailwind classes for every Nuxt UI component, slot and variant. Use these as the reference when designing or matching components.

### `apps/server`: control plane

- Hono on Node.
- Owns task state, locks/leases, role permissions, merge eligibility, the scheduler, the merge orchestrator, and the GitHub API client.
- **The only process that opens the database.** The web app and runner never touch it directly.
- **Exactly one instance.** The scheduler and orchestrator are long-running loops inside this process. That's the reason it isn't folded into Nuxt's Nitro server: the web layer should be free to scale or redeploy on its own.
- Serves the HTTP API (for web), SSE (to web), and the runner WebSocket endpoint.

### `apps/runner`: runner daemon

- Node/TypeScript.
- The only process that touches the filesystem, git and the agent CLIs.
- **Connects outbound** to the server over WebSocket, whether on localhost, over the Docker network (D12), or to a hosted server behind NAT. Moving between these should be a URL and auth change only (D1).
- Creates worktrees, spawns agents through `AgentRuntime` adapters picked by the job's `runtime` id (`apps/runner/src/agent-runtime.ts`; Claude Code `claude-code` and Codex `codex`, D18, see [agent-runtime-and-auth.md](agent-runtime-and-auth.md); an unknown id ends the run with an `error` exit), streams events, sends heartbeats, reports outcomes.
- **Per-run MCP server for agent tools.** Each spawned agent gets an MCP server from the runner, exposing tools such as reading the task, posting a comment, attaching evidence and reporting an outcome. The runner forwards each call to the server with that run's lease/fencing token attached. Agents never hold server credentials, every call is fenced automatically, and the tools are the same whatever agent CLI is used. See [stale-runners-and-fencing.md](stale-runners-and-fencing.md).
- **Codex runtime.** The `codex` adapter (`apps/runner/src/codex.ts`) runs `codex exec --json --dangerously-bypass-approvals-and-sandbox` in the worktree (`codex exec resume … <session>` to resume), with the run's MCP servers passed as `-c mcp_servers.<name>.*`, `--model` when the job has one, and the role instructions and runner notes as `-c developer_instructions=…`. Codex reads `AGENTS.md` itself; when a repo has none, the contents of its `CLAUDE.md`, `CORRAL.md` and `.corral/CORRAL.md` are added to those instructions. `codex-json.ts` turns its JSONL into the same `RunEvent`s as Claude's stream-json, and a usage-limit error into `rate_limited` with the reset time Codex prints (D3). It uses the same agent environment and the login in `~/.codex`; Corral never touches an OpenAI key (D2). Codex has no streaming session, so its PM turns are never kept warm: each follow-up is a one-shot resume.
- **Messages to live runs.** Developer and reviewer runs get a fresh agent CLI process each. With Claude Code it starts in stream-json input mode with `--replay-user-messages` (like a warm PM session), so the server can send `run.message` (`runId`, `leaseEpoch`, `text`) to a live run: the runner writes it to stdin as a user message and records it as a `message` run event in the transcript. Claude Code takes it into the turn under way, or as the next turn. Once the CLI has replayed every message and ended its turn with a `result` line, the runner closes stdin and the CLI exits as `-p` would; the run then ends if the agent reported its outcome, or gets its one resume to report as before. A message with a stale lease epoch is ignored (fencing). One the run can't take (a Codex run, a PM run, or a run that has reported, stopped or ended) gets a `run.message.rejected` reply with the reason and, while the run is live, a note in its transcript; messages are never dropped silently. The API is `POST /api/projects/:slug/runs/:runId/messages` (`{ text, attachments? }`, attachments being project image IDs referenced at the end of the text): the message is kept as the human's comment on the task with a `run.message_sent` audit entry, forwarded as `run.message`, and answered 202. A run that isn't live (queued, ended or stopping, no longer holding the task's lease, a PM run, or no runner connected) gets 409 `run_not_live` with a readable `reason`, and nothing is recorded.
- **Warm PM sessions (D9).** A PM turn's process stays alive after its run ends, keyed by Plan session, so the session's next message skips CLI startup: the runner sends it over stdin to the same process, whose `result` line ends that turn's run. It's reused only when it's idle and alive with the same agent session ID and model; otherwise it's killed and the turn cold-starts with `--resume`. The process group is killed after `CORRAL_PM_WARM_SECONDS` idle (default 300, `0` for one process per turn), on stop or timeout of its turn, and on runner shutdown. The server sees only runs, so an idle process holds nothing (PM turns have no concurrency; D13).
- **Setup jobs, not only agent runs.** The server can send the runner short jobs that return data and touch nothing. The first is `list_repos`: it runs `gh` inside the runner and returns the repositories its GitHub login can see, so the UI can offer a picker when adding a project. It returns `nameWithOwner`, `description`, `isPrivate`, `updatedAt`, `defaultBranchRef` and `viewerPermission`, using `gh api --paginate "/user/repos?affiliation=owner,collaborator,organization_member&sort=updated&per_page=100"` (or `gh repo list <owner> --json …`). The GitHub token never leaves the runner (as with `claude` under D2). The server caches the result for a few minutes. Repos where `viewerPermission` is below WRITE, and repos already used by a project (D13), are shown but can't be picked. If `gh` isn't signed in, the job returns that state, and the UI shows the `docker exec` login step (D12). A pasted GitHub URL is checked with the same job.

## Repo layout (Turborepo + pnpm workspaces)

```
apps/
  web/         Nuxt + Nuxt UI
  server/      Hono API, scheduler, orchestrator, GitHub client, SSE, runner WS
  runner/      daemon: worktrees, AgentRuntime adapters (claude, codex), per-run MCP
packages/
  contracts/   zod schemas + types: HTTP API, runner protocol, RunJob, outcomes, events
  core/        pure domain logic: task state machine, transitions, merge gates
  db/          Drizzle schema + migrations
  tsconfig/    shared TS configs
```

- **`packages/core` has no I/O.** The state machine, transition rules and gate checks are the most important code in Corral. Keep them pure and heavily unit-tested. The web app can reuse them to explain why a task is blocked or waiting.
- **`packages/contracts` is the boundary between apps.** All three apps import from it, so a protocol change is a type error everywhere at once.

## Stack

| Concern | Choice | Notes |
|---|---|---|
| Monorepo | Turborepo + pnpm workspaces | |
| Frontend | Nuxt + Nuxt UI | |
| Server framework | Hono on Node | WebSocket + SSE helpers; typed client for Nuxt |
| Database | Drizzle (Postgres dialect). Postgres in Docker when deployed; PGlite (embedded Postgres) in development and tests (D14) | One schema, two drivers, picked by `CORRAL_DATABASE_URL`. Supports atomic `UPDATE … WHERE status = 'ready' RETURNING` claims. PGlite is single-connection, so concurrency is only proven against Postgres in CI. Only the server opens the database, whichever driver. |
| Runner | Node/TypeScript | Resolves PRD §8.2 "Rust or Node". Shares `contracts`. |
| Evidence / blobs | Local filesystem behind a `BlobStore` interface → S3-compatible later | |
| GitHub | Server uses the GitHub API (open PR, CI status, merge); runner does `git push` | Merge gates stay server-side. POC auth: the user's `gh` token. Later: GitHub App, plus per-run scoped tokens (R10). |

## Storage (D8)

Each kind of data has exactly one source of truth.

| Store | What lives there | web | server | runner | agent (`claude` / `codex`) |
|---|---|---|---|---|---|
| **Database** (Postgres deployed, PGlite in dev; D14) | Projects, epics, tasks, criteria, dependencies, status, leases (with fencing epoch), runs, comments, reviews, evidence *records*, PM conversation, plans, settings, audit log | — | **R/W** (sole opener) | — | — |
| **Blob store** (local folder → S3) | Screenshots, videos, test/CI logs, run transcripts. Immutable, content-addressed (sha256). | — | **R/W** (stores uploads, serves files) | — | — |
| **Target repo: default branch** (GitHub) | Merged code, `CORRAL.md`, wiki, agent role instructions. Canonical docs = default branch. | — | — | **R** (`git fetch`) | **R**, PM only, through a read-only checkout (D9) |
| **Target repo: task branches** (GitHub) | Work in progress per task | — | **R** (diffs for PR/gate checks) | **R/W** (`git push`, only to the branch it holds a lease for) | — |
| **GitHub PRs / CI** | PR state, CI results, mergeability, merges | — | **R/W** (open/update PR, read CI, merge) | — | — |
| **Runner disk** | Bare clone, worktrees, dependency store, transcript spool. **Not** a source of truth; losing it costs at most uncommitted work. | — | — | **R/W** | **R/W**, own worktree + scratch only |

### Access rules

- **web** touches no storage directly. Everything goes through the server's HTTP API and SSE, including images (the server serves blobs).
- **runner** never opens the database or blob store. Events, outcomes and uploads go to the server over the WebSocket.
- **agents** reach Corral only through per-run MCP tools, which the runner forwards with the run's lease token.
- **The runner pushes, not the agent.** The agent commits in its worktree; the runner pushes when the agent reports `pr_opened` / `pr_updated` (or through an MCP `push` tool), keeping the push path fenced.
- **Before merging,** the server re-checks GitHub directly. It never relies only on its cached copy of PR/CI state.
- **No credentials in any Corral store.** Each agent CLI's login stays in its own config (`claude`'s and `codex`'s); the GitHub token stays in `gh`'s own config (the keychain on macOS, a volume in the runner container) (D2, D12).

### Layout on disk (POC)

The root is configurable (env vars). `pnpm dev` puts it in the checkout's own `.corral/` folder, so several checkouts (e.g. agents in separate worktrees) can run at once without sharing a database; it picks free ports too and writes them to `.corral/dev.json`. An app started on its own without those env vars falls back to `~/.corral/`. In the containers, `server/` and `runner/` are separate volumes, each mounted only into its own container (D12).

```
~/.corral/
  server/
    pgdata/                     PGlite data (dev only; deployed uses Postgres, D14)
    blobs/sha256/ab/cd…         content-addressed files
  runner/
    config.json                 server URL, runner ID
    repos/<repoId>.git          bare clone, fetched before each job; fetches
                                and worktree changes run one at a time per clone
    worktrees/<taskId>/         one per task, removed after merge
    worktrees/pm-<projectId>-<planSessionId>/
                                read-only default-branch checkout, one per Plan
                                session; stable so the agent CLI can resume
    scratch/<runId>/            evidence and other agent scratch output
    scratch/pm-<projectId>-<planSessionId>/
                                the same, one per Plan session when PM
                                processes stay warm (D9)
    spool/<runId>.jsonl         transcript being written, uploaded at run end
```

Backing up `server/` backs up all of a dev instance's state. For the deployed instance, back up the Postgres database (`pg_dump`) and the server volume (blobs) (D14).

### Flows

- **Evidence:** the agent saves a file to a scratch folder outside the repo → calls MCP `attach_evidence(criterionId, path)` → the runner uploads it to the server → the server hashes it, stores the blob, and records task, review round, criterion, type and hash in the database. Immutable blobs mean evidence survives force-pushes and worktree cleanup (PRD §7.7).
- **PR evidence:** the PR body contains the plain-English summary, per-criterion pass/fail, and a **link to Corral's evidence page**. No images are committed to the repo or uploaded to GitHub. Images show for others once Corral is hosted. (This is how D4's "attached to the PR" is implemented.)
- **Transcripts:** the runner writes events to `spool/` as they arrive and forwards them live (server → SSE → web). At run end it uploads the full JSONL to the blob store; the database stores only run metadata and the blob pointer. Transcripts never go in Postgres.
- **Design bundles (D20):** a version's static bundle is one **tar archive** (ustar, as `tar -cf` writes it; `packBundle`/`unpackBundle` in `packages/core`) stored as a blob. The server serves its files at `GET /api/designs/:versionId/files/<path>` (a bare `files` redirects to `files/`, which is `index.html`) with `Content-Security-Policy: sandbox allow-scripts; … connect-src 'none'; …` and `X-Content-Type-Options: nosniff`, and a content type from the file's extension. The path is checked as sent, before routing: `..`, `.`, empty segments, absolute paths, drive letters, backslashes and their percent-encoded forms get a 400. The web app shows the bundle only in `<iframe sandbox="allow-scripts">` (`DesignPreview`, and the full-size page `/designs/:versionId`).
- **GitHub state:** the server keeps a copy of PR number, head SHA, CI status and mergeability, updated from webhooks or polling.

### Moving to hosting

Point `CORRAL_DATABASE_URL` at the hosted Postgres (`pg_dump`/restore from the home-server Postgres, D14), copy `blobs/` to S3 under the same keys, point the runner at the new server URL. No schema, blob-key or contract changes.

### Known POC limitation

The agent runs as the same OS user as the runner, so it *could* run `git push` / `gh` with the user's own GitHub login and bypass the runner. In Docker (D12) the reach is limited to the runner container, but within it the problem is the same. In the POC only the agent's instructions prevent this. Partial mitigation: spawn agents with no `GH_TOKEN` in their environment and a git config whose push URL fails. Real enforcement comes with hosting: per-run, branch-scoped tokens (R10).

## Deployment (D12)

Develop and first run on the laptop with `turbo dev`. Deploy as Docker containers with Docker Compose on the user's home server.

```
Internet ──▶ Cloudflare Tunnel ──▶ Cloudflare Access (login)
                                          │
                     ┌────────────────────┼──── private Docker network ─────────────────────┐
                     │                    ▼                                                 │
                     │   ┌─────────────────────────┐  /api/** + SSE  ┌──────────────────┐   │
                     │   │ web: static Nuxt build  │ ──────────────▶ │      server      │   │
                     │   └─────────────────────────┘                 │  volume: server/ │   │
                     │   ┌─────────────────────────┐       SQL       │                  │   │
                     │   │ postgres (D14)          │ ◀────────────── │                  │   │
                     │   │ volume: postgres data   │                 └────────▲─────────┘   │
                     │   └─────────────────────────┘                          │ WebSocket   │
                     │                                               ┌────────┴─────────┐   │
                     │                                               │      runner      │   │
                     │                                               │ claude, codex,   │   │
                     │                                               │ gh, git, chromium│   │
                     │                                               │ volumes: runner/,│   │
                     │                                               │ agent + gh confs │   │
                     │                                               └──────────────────┘   │
                     └──────────────────────────────────────────────────────────────────────┘
```

| Container | Contents | Volumes | Exposed |
|---|---|---|---|
| `web` | Static Nuxt build and a server that proxies `/api/**` to `server` | — | Through the tunnel only, behind Cloudflare Access |
| `server` | Hono control plane | `server/` data dir (blobs) | No. Docker network only |
| `postgres` | Postgres (D14) | Postgres data dir | No. Docker network only |
| `runner` | Runner daemon, `claude`, `codex`, `gh`, `git`, headless Chromium, target-project toolchains (Node/pnpm etc.) | `runner/` data dir, `claude` config, `codex` config, `gh` config | No. Dials out to `server` |

Rules:

- **Only `web` is exposed.** The server API and runner WebSocket are never published to the host or the tunnel.
- **Credentials are set up by the user, by hand.** After the first `docker compose up`, the user runs `docker exec -it <runner> claude`, `docker exec -it <runner> codex login --device-auth` and `gh auth login` once. The configs persist on volumes. No model-provider token goes in a Compose file, `.env` file or Corral config (D2).
- **Linux, not just macOS.** The runner image is Linux. No keychain, `open` or BSD-only flags anywhere in runner code.
- **Everything environment-specific is config:** data dirs, server URL, bind address, ports.
- **Heartbeats on long-lived connections.** Cloudflare drops proxied connections idle for about 100 seconds, so SSE streams send a heartbeat comment well inside that, and the runner WebSocket pings regardless.
- **No Docker socket in any container.** Agents have broad permissions inside the runner; they must not be able to start containers on the host. One container per task is a later `RunnerProvider`.
- **Resources:** the [estimates below](#resource-expectations) apply to the home server. The runner container should get a memory limit sized for the configured concurrency.

## Runner implementation rules

TypeScript is fine for performance: the runner is I/O-bound (model latency, git, tests, network), and concurrency is a handful of agents. These rules matter more than the language:

1. **Never block the event loop.** No `execSync`, `spawnSync`, or synchronous reads/parses of large files. A stalled loop delays heartbeats, and a late heartbeat can expire a healthy run's lease. Keep the heartbeat timer independent of agent work.
2. **Kill whole process trees.** Agents start dev servers, headless browsers and test watchers. Spawn each agent in its own process group (`detached: true`) and stop it with `process.kill(-pid, signal)`: graceful signal first, then `SIGKILL` after the grace period (PRD §9.3). Stopped runs must not leave orphaned processes holding RAM or ports.
3. **Stream, don't buffer.** Read agent `stream-json` output line by line, write transcripts to disk as they arrive, and send events to the server in batches. Never hold a whole transcript in memory.
4. **Distribution later:** if Corral is sold, compile the runner to a single executable (`bun build --compile` or Node single-executable apps). Not needed for the POC.

## Resource expectations

Rough estimates, to be checked against real measurements once built.

**Corral itself**

| Process | Dev (`turbo dev`) | Built |
|---|---|---|
| web | 300–600 MB | ~20–50 MB (static files + `/api` proxy) |
| server (incl. PGlite in dev) | 150–300 MB | 150–250 MB, plus Postgres ~50–150 MB |
| runner | 80–150 MB | 50–100 MB |
| Turbo daemon / watchers | 50–100 MB | — |
| **Idle total** | **~0.6–1.1 GB** | **~250–400 MB** |

**Per active run**

| Run | Estimate |
|---|---|
| Developer (agent CLI + target dev server + headless browser + test spikes) | ~1–3 GB |
| Reviewer | ~0.3–1.5 GB |

At the PRD defaults (1 developer + 1 reviewer): **~2–5 GB peak**. Comfortable on 16 GB; tight on 8 GB above concurrency 1.

**Disk:** each worktree needs its own dependency install (often 0.5–1 GB for `node_modules`). Use pnpm's shared store, install when the worktree is created, and remove worktrees promptly after merge (never discarding uncommitted work; PRD §7.4).

**Possible later addition:** the runner checks free memory before claiming work. Not needed for the POC.
