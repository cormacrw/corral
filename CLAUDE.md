# Corral

Before planning or building anything, read [docs/README.md](docs/README.md). It indexes the PRD, the decisions that override it, and the precedence order between them.

Current phase: local-only POC, single user, agents run through the user's own locally authenticated `claude` or `codex` CLI (`docs/decisions.md` D18). Deployed as Docker containers on the user's home server, so nothing may assume macOS or hard-coded local paths (`docs/decisions.md` D12). Never handle model-provider credentials in Corral (see `docs/decisions.md` D1–D2).

## Commands

No local Docker or Postgres is needed. Node 26 runs the TypeScript directly.

- `pnpm dev`: web, server and runner for this checkout, on free ports written to `.corral/dev.json`
- `pnpm run check`: the full gate (lint, typecheck, build, tests); run it before you finish. `CORRAL_CHECK_CPUS` sets its parallelism (default 2)
- One test file: `pnpm --filter @corral/server exec vitest run src/x.test.ts`
- Postgres cases are skipped unless `CORRAL_DATABASE_URL` is set, and concurrency is only proven there (D14). To run them, point it at any Postgres where the user can create databases, for example `CORRAL_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres pnpm --filter @corral/server test`, or start one with `startTestPostgres` (`.corral/wiki/postgres-tests.md`)
- `pnpm --filter @corral/server perf`: seeded API benchmark of query counts, latency and payload size, about 3 minutes. `CORRAL_PERF_OUT=<file>` writes the JSON; set `CORRAL_DATABASE_URL` for Postgres numbers
- `pnpm --filter @corral/db generate`: a new migration from `schema.ts`. Never edit an existing one

Implementation notes by topic are in [.corral/wiki/](.corral/wiki/README.md).

Prototype build notes for design tasks (D20) are in [.corral/agents/designer.md](.corral/agents/designer.md).
