# HTTP endpoints

Every endpoint under `/api` is one entry in `endpoints` in `packages/contracts/src/endpoints.ts`, keyed `METHOD /path` with Hono parameter names. An entry gives the JSON body schema (or `raw<Blob | FormData>()` for an image or form), the query schema, the response type, the status when it isn't 200, `web: true` when the web client calls it, and either the PM tools that do the same thing (`pm`) or why the PM has none (`noPm`, D30).

Three things are keyed by it:

- **Server.** `apps/server/src/app.ts` passes one handler per key to `registerEndpoints` (`endpoint-routes.ts`), which registers them in table order, validates the body and query with the entry's schemas, and sends the handler's value as JSON with the entry's status. A handler can still return a whole `Response` (files, SSE, redirects). A missing or unknown key doesn't typecheck, and the handler's params, body, query and return value are typed from the entry.
- **Web client.** `apps/web/app/queries/api.ts` calls `call('GET /projects/:slug/tasks', { params, query })`; only `web: true` keys are allowed, and the result type is the entry's response.
- **Prototype.** `apps/web/app/prototype/mock-api.ts` has one handler per `web: true` key, so marking an endpoint `web` without a mock doesn't typecheck. Writes send the events the server publishes for them.

To add an endpoint: add the entry, then the server handler, then (if web calls it) the `api` method and the mock handler.

## PM coverage (D30, COR-247)

`apps/server/src/pm-route-coverage.ts` turns the table into `pmRouteTools` and `pmRouteExclusions`, adding the three listener-level routes that aren't API endpoints: the runner WebSocket, its version probe and the raw-path design-file middleware (`ALL /api/*`). `pm-route-coverage.test.ts` builds the real listener through `createServerApp`, without a database or socket, and checks Hono's registered routes against them: every route mapped or excluded with a reason, no stale entries, no overlaps, and every tool name in `PM_TOOL_NAMES`.
