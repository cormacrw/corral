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
```

Settings come from environment variables; see [.env.example](.env.example).

`apps/server`, `apps/runner` and `packages/*` have no build step. Node runs their TypeScript directly (type stripping), so:

- relative imports use the `.ts` extension (`import { loadConfig } from './config.ts'`)
- only erasable TypeScript is allowed: no `enum`, `namespace` or constructor parameter properties (`erasableSyntaxOnly` enforces this)
