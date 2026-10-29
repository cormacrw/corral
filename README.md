# corral

Start with [docs/README.md](docs/README.md).

## Development

Requires Node 26+ and pnpm.

```sh
pnpm install
pnpm dev        # web, server and runner for this checkout
pnpm lint
pnpm typecheck
pnpm test
```

`pnpm dev` can run in several checkouts or worktrees at once. Each instance keeps its data in its own `.corral/` folder and uses ports 3000 (web) and 4100 (server) when free, or free ports otherwise. It writes the URLs it chose to `.corral/dev.json`:

```sh
curl "$(jq -r .serverUrl .corral/dev.json)/api/health"
kill "$(jq -r .pid .corral/dev.json)"   # stops this instance's web, server and runner
```

Settings come from environment variables; see [.env.example](.env.example).

`apps/server`, `apps/runner` and `packages/*` have no build step. Node runs their TypeScript directly (type stripping), so:

- relative imports use the `.ts` extension (`import { loadConfig } from './config.ts'`)
- only erasable TypeScript is allowed: no `enum`, `namespace` or constructor parameter properties (`erasableSyntaxOnly` enforces this)

## Deployment (Docker)

Corral runs as four containers on your own server (`docs/decisions.md` D12, D14): `web`, `server`, `runner` and `postgres`, on a private Docker network. Only `web` is published; point your Cloudflare Tunnel at it and put Cloudflare Access in front.

```sh
cp .env.docker.example .env        # set POSTGRES_PASSWORD and CORRAL_PUBLIC_URL
docker compose up -d --build
docker exec -it corral-runner claude            # sign in to Claude once
docker exec -it corral-runner codex login --device-auth   # sign in to Codex once, for agents whose runtime is codex
docker exec -it corral-runner gh auth login     # sign in to GitHub once
```

The logins live on volumes that only the runner container mounts. Corral never reads, stores or relays them (D2).

- **State:** `server-data` (evidence and transcripts) and `postgres-data` hold everything worth backing up (`pg_dump` plus the blob folder). `runner-data` is a cache of clones, worktrees and spools.
- **Config:** everything environment-specific is an environment variable; see `docker-compose.yml` and `.env.example`.
- **Auto-deploy:** a systemd timer can redeploy whenever `main` moves and CI passes, waiting for agent runs to finish first; see `scripts/deploy/README.md`.
- **Agents** run inside the runner container, which has `git`, `gh`, `claude`, `codex`, a headless Chromium and Node/pnpm. Give it a memory limit sized for the concurrency you configure (`CORRAL_RUNNER_MEMORY`).

Stopping the stack sends `SIGTERM`: the runner gives agents a few seconds, reports their runs as interrupted, and the server closes its connections.
