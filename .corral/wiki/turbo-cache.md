# Shared Turbo cache

Turbo's local cache would otherwise live in each worktree's `.turbo/cache`, so
every new task started cold and ran lint, typecheck and build again for
packages it never touched. The runner instead gives every agent process
`TURBO_CACHE_DIR=<dataDir>/turbo-cache/<projectId>` (`agentEnv` in
`apps/runner/src/agent.ts`, path from `turboCachePath` in `workspace.ts`).

- **Where it lives.** One folder per project under the runner's data dir, which
  is the runner's Docker volume, so it survives container rebuilds. Keyed by
  project id, so one project's entries never replay in another, even two
  projects on the same repository. Global PM sessions have no project and get
  no variable. A project that doesn't use Turbo ignores it.
- **Operator override.** If the runner's own environment sets
  `TURBO_CACHE_DIR`, agents get that value unchanged, and every project shares
  it. The sweep only prunes `<dataDir>/turbo-cache/`, never an operator's folder.
- **Reviews.** `pnpm run check --review` sets `TURBO_FORCE=1`, so a review runs
  every task and reads nothing from the cache (D26). It still writes entries.
- **Tests** are `cache: false` in `turbo.json` and stay uncached
  ([test-exit-status.md](test-exit-status.md)).

## Pruning

Turbo never evicts local entries. Every `sweep_worktrees` job also runs
`pruneTurboCaches` (`workspace.ts`). An entry is a task hash's files
(`<hash>.tar.zst` and `<hash>-meta.json`); its last use is the newest atime or
mtime of those files. Per project folder:

1. Entries unused for more than 7 days (`TURBO_CACHE_MAX_AGE_MS`) are deleted.
2. Then the oldest entries go until the folder is under 5 GiB
   (`TURBO_CACHE_MAX_BYTES`).

A project with any run on this runner (assigned and not yet forgotten) is
skipped entirely, since its agent may be reading or writing entries; the next
sweep catches up. A runner too old to pass which projects are running prunes
nothing. On a volume mounted `noatime`, cache hits don't refresh atime, so
"last used" falls back to when the entry was written.

## Clearing it

Delete the folder: `rm -rf <dataDir>/turbo-cache/<projectId>` for one project,
or `<dataDir>/turbo-cache` for all of them. Turbo recreates it on the next run.
Do it while the project has no runs, or a running check just misses the cache.
