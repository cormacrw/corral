# Architecture

How the Corral POC is structured. Implements D7 in [decisions.md](decisions.md), and builds on D1 (local-only POC, hosting next) and D2 (the user's own `claude` CLI).

## Processes

Three processes, all started together by `turbo dev`:

```
┌─────────────┐  HTTP + SSE   ┌──────────────────────┐  WebSocket (runner dials out)  ┌──────────────────────┐
│  apps/web   │ ────────────▶ │     apps/server      │ ◀────────────────────────────── │     apps/runner      │
│ Nuxt + UI   │               │    control plane     │                                 │    local daemon      │
└─────────────┘               │ API · scheduler ·    │                                 │ worktrees · git ·    │
                              │ locks · orchestrator │                                 │ spawns `claude` ·    │
                              │ · GitHub · DB        │                                 │ agent tool proxy     │
                              └──────────────────────┘                                 └──────────────────────┘
                               moves to hosting later                                   always on the user's machine
```

### `apps/web`: Nuxt + Nuxt UI

- UI only. **No business logic in Nuxt server routes.**
- `ssr: false` for now; everything shown is live data from the server.
- Nuxt `routeRules` proxy `/api/**` to `apps/server` (no CORS).
- Live updates arrive over SSE from the server.
- Types come from the Hono typed client (`hc`) and `packages/contracts`.

### `apps/server`: control plane

- Hono on Node.
- Owns task state, locks/leases, role permissions, merge eligibility, the scheduler, the merge orchestrator, and the GitHub API client.
- **The only process that opens the database.** The web app and runner never touch it directly.
- **Exactly one instance.** The scheduler and orchestrator are long-running loops inside this process. That's the reason it isn't folded into Nuxt's Nitro server: the web layer should be free to scale or redeploy on its own.
- Serves the HTTP API (for web), SSE (to web), and the runner WebSocket endpoint.

### `apps/runner`: local daemon

- Node/TypeScript.
- The only process that touches the filesystem, git and the agent CLI.
- **Connects outbound** to the server over WebSocket, even on localhost, exactly as it will when the server is hosted behind NAT. Moving to hosting should be a URL and auth change only (D1).
- Creates worktrees, spawns agents through `AgentRuntime` adapters (Claude Code first), streams events, sends heartbeats, reports outcomes.
- **Per-run MCP server for agent tools.** Each spawned agent gets an MCP server from the runner, exposing tools such as reading the task, posting a comment, attaching evidence and reporting an outcome. The runner forwards each call to the server with that run's lease/fencing token attached. Agents never hold server credentials, every call is fenced automatically, and the tools are the same whatever agent CLI is used. See [stale-runners-and-fencing.md](stale-runners-and-fencing.md).

## Repo layout (Turborepo + pnpm workspaces)

```
apps/
  web/         Nuxt + Nuxt UI
  server/      Hono API, scheduler, orchestrator, GitHub client, SSE, runner WS
  runner/      daemon: worktrees, AgentRuntime adapters (claude), per-run MCP
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
| Database | PGlite (embedded Postgres) + Drizzle → Postgres when hosted | Drizzle schemas are tied to one SQL dialect; using Postgres from day one avoids a schema rewrite. Supports atomic `UPDATE … WHERE status = 'ready' RETURNING` claims. PGlite is single-connection and in-process, which is why only the server opens it. |
| Runner | Node/TypeScript | Resolves PRD §8.2 "Rust or Node". Shares `contracts`. |
| Evidence / blobs | Local filesystem behind a `BlobStore` interface → S3-compatible later | |
| GitHub | Server uses the GitHub API (open PR, CI status, merge); runner does `git push` | Merge gates stay server-side. POC auth: the user's `gh` token. Later: GitHub App, plus per-run scoped tokens (R10). |

## Storage (D8)

Each kind of data has exactly one source of truth.

| Store | What lives there | web | server | runner | agent (`claude`) |
|---|---|---|---|---|---|
| **Database** (PGlite → Postgres) | Projects, epics, tasks, criteria, dependencies, status, leases (with fencing epoch), runs, comments, reviews, evidence *records*, PM conversation, plans, settings, audit log | — | **R/W** (sole opener) | — | — |
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
- **No credentials in any Corral store.** Claude's login stays in Claude's own config; the GitHub token stays with `gh` in the keychain (D2).

### Layout on disk (POC)

```
~/.corral/
  server/
    pgdata/                     PGlite data
    blobs/sha256/ab/cd…         content-addressed files
  runner/
    config.json                 server URL, runner ID
    repos/<repoId>.git          bare clone, fetched before each job
    worktrees/<taskId>/         one per task, removed after merge
    spool/<runId>.jsonl         transcript being written, uploaded at run end
```

Backing up `~/.corral/server/` backs up all of Corral's state.

### Flows

- **Evidence:** the agent saves a file to a scratch folder outside the repo → calls MCP `attach_evidence(criterionId, path)` → the runner uploads it to the server → the server hashes it, stores the blob, and records task, review round, criterion, type and hash in the database. Immutable blobs mean evidence survives force-pushes and worktree cleanup (PRD §7.7).
- **PR evidence:** the PR body contains the plain-English summary, per-criterion pass/fail, and a **link to Corral's evidence page**. No images are committed to the repo or uploaded to GitHub. Images show for others once Corral is hosted. (This is how D4's "attached to the PR" is implemented.)
- **Transcripts:** the runner writes events to `spool/` as they arrive and forwards them live (server → SSE → web). At run end it uploads the full JSONL to the blob store; the database stores only run metadata and the blob pointer. Transcripts never go in Postgres.
- **GitHub state:** the server keeps a copy of PR number, head SHA, CI status and mergeability, updated from webhooks or polling.

### Moving to hosting

`pg_dump`/restore the database into Postgres, copy `blobs/` to S3 under the same keys, point the runner at the new server URL. No schema, blob-key or contract changes.

### Known POC limitation

The agent runs as the user's OS user, so it *could* run `git push` / `gh` with the user's own GitHub login and bypass the runner. In the POC only the agent's instructions prevent this. Partial mitigation: spawn agents with no `GH_TOKEN` in their environment and a git config whose push URL fails. Real enforcement comes with hosting: per-run, branch-scoped tokens (R10).

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
| web | 300–600 MB | ~0 extra (static files served by server) |
| server (incl. PGlite) | 150–300 MB | 150–250 MB |
| runner | 80–150 MB | 50–100 MB |
| Turbo daemon / watchers | 50–100 MB | — |
| **Idle total** | **~0.6–1.1 GB** | **~250–400 MB** |

**Per active run**

| Run | Estimate |
|---|---|
| Developer (`claude` + target dev server + headless browser + test spikes) | ~1–3 GB |
| Reviewer | ~0.3–1.5 GB |

At the PRD defaults (1 developer + 1 reviewer): **~2–5 GB peak**. Comfortable on 16 GB; tight on 8 GB above concurrency 1.

**Disk:** each worktree needs its own dependency install (often 0.5–1 GB for `node_modules`). Use pnpm's shared store, install when the worktree is created, and remove worktrees promptly after merge (never discarding uncommitted work; PRD §7.4).

**Possible later addition:** the runner checks free memory before claiming work. Not needed for the POC.
