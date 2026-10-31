# Trustworthy test exit status

The root test command remains Turbo → package Vitest. Importing embedded-postgres
registers async-exit-hook@2.0.1, and its beforeExit handler used a hardcoded zero,
which masks a failure status. No Vitest config imports it now: only the explicit
`startTestPostgres` helper does (see `postgres-tests.md`). The pnpm dependency
patch stays for that path; it preserves the beforeExit event's status while
retaining signal handling and asynchronous cleanup.

Test caching is disabled in turbo.json so old false-success cache entries cannot
pass the gate. --passWithNoTests in core/contracts only permits an empty suite;
it does not suppress assertion failures.

Run pnpm run test:exit-codes to inject temporary assertion failures in all six
test packages, kill workers in server/db, time out a server hook, and run a
passing control. Each probe invokes the root test command with a package filter,
checks its status and intended diagnostic, and removes its fixture in finally.
CI runs these probes before its ordinary unguarded pnpm run test step.

Throwaway Postgres databases are dropped without FORCE after the pool ends.
pg.Pool.end can resolve before its client sockets finish disconnecting; forcing
the drop in that gap can emit an uncaught 57P01 after every assertion passed.
Normal DROP lets Postgres wait for those disconnects. testing.test.ts covers a
client disconnecting during cleanup and fails with the old forced drop.
