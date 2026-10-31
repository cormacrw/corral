# Postgres test opt-in (D14)

Ordinary `pnpm test` uses PGlite. Postgres cases in both `packages/db` and
`apps/server` are reported as skipped unless `CORRAL_DATABASE_URL` is set.
CI sets it to its Postgres service; the user needs permission to create/drop
throwaway databases. A configured but unreachable database fails the suites.
Neither Vitest config starts Postgres or changes the environment.

`packages/db/src/testing.ts` provides the runtime fixture: `databaseFixture`
for once-per-suite setup, and `requireDatabase` for per-test setup and migration
cases. Both check the environment during execution, never at import time.
Keep cleanup hooks safe when setup was skipped. Parameterized migration tests
use `it.for` so their second argument is the Vitest test context.

Test databases aren't migrated one by one. `createTestDatabase('postgres')` clones
`corral_template_<key>`, built once under an advisory lock and only ever connected
to while it's built. `pglite` loads a snapshot of a migrated instance, kept in
`packages/db/node_modules/.cache/corral/`. The key hashes every migration file (and,
for PGlite, the installed build), so a new migration can't reuse an old copy.
`openDatabase` still runs on each copy, and `migrations.test.ts` doesn't use either.
Delete old `corral_template_*` databases by hand if a shared server collects them.

For an explicit local Postgres check, import `startTestPostgres` from
`@corral/db/test-setup`. It returns `{ url, close }`; pass that URL as
`CORRAL_DATABASE_URL` to the test subprocess and call `close` in `finally`.
This helper is not a Vitest global setup and never sets the environment itself.
It binds to loopback only, retains the last 16,384 characters of startup output, and includes
that output in startup errors. Failed setup stops/reaps its child (including
already-exited children), then removes its generated temporary directory.
Shutdown escalates from SIGINT to SIGKILL after five seconds.

The embedded-postgres version is pinned. Its public `stop()` waits for a new exit
event even for an already-exited child, so the helper reads its internal child
handle to reap safely. Review that access when upgrading the dependency.
