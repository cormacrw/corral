# corral

Start with [docs/README.md](docs/README.md).

## Development

Requires Node 26+ and pnpm.

```sh
pnpm install
pnpm dev        # web on :3000, server on :4100, runner
pnpm lint
pnpm typecheck
pnpm test
```

Settings come from environment variables; see [.env.example](.env.example).

`apps/server`, `apps/runner` and `packages/*` have no build step. Node runs their TypeScript directly (type stripping), so:

- relative imports use the `.ts` extension (`import { loadConfig } from './config.ts'`)
- only erasable TypeScript is allowed: no `enum`, `namespace` or constructor parameter properties (`erasableSyntaxOnly` enforces this)
