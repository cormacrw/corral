# Corral

Before planning or building anything, read [docs/README.md](docs/README.md). It indexes the PRD, the decisions that override it, and the precedence order between them.

Current phase: local-only POC, single user, agents run through the user's own locally authenticated `claude` or `codex` CLI (`docs/decisions.md` D18). Deployed as Docker containers on the user's home server, so nothing may assume macOS or hard-coded local paths (`docs/decisions.md` D12). Never handle model-provider credentials in Corral (see `docs/decisions.md` D1–D2).

## Building a prototype (design tasks, D20)

`apps/web` has a static prototype build: the real app shell, pages and components on fixture data, with no server.

- **Build:** `pnpm --filter web prototype`. It writes **`apps/web/prototype-dist/`**: an `index.html` and its assets, all with relative paths. That folder is the bundle to submit. It runs from any sub-path, including Corral's sandboxed design preview, and makes no network calls.
- **Routes** are hash routes in the bundle: `index.html#/projects/corral/board`, `#/tasks/COR-3`, `#/inbox`, and so on.
- **Fixtures:** `apps/web/app/prototype/fixtures.ts` holds the data, typed with the `@corral/contracts` API types. Edit or add records there to show the states a screen needs. Use `task(project, number, { … })` for tasks and `ago(minutes)` for times.
- **Mock API:** `apps/web/app/prototype/mock-api.ts` answers the paths in `app/composables/useApi.ts` from the fixtures. When a page calls an endpoint it doesn't handle yet, add a `route(...)` for it, or the page gets a 404 and shows its error state. Writes change the fixtures in memory until reload.
- **New pages and components** go in `app/pages` and `app/components` as usual, so the build picks up the same code. Don't fork components for the prototype. Only `pnpm prototype` sets `import.meta.prototype`, so dev and production builds never include the fixtures.
- **Check it** by serving `prototype-dist` from a sub-path, e.g. `npx serve apps/web` and opening `/prototype-dist/`, with no Corral server running.
