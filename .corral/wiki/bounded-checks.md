# Bounded checks

Run `pnpm run check` for workspace lint, typecheck and tests plus root script
lint and typecheck. `CORRAL_CHECK_CPUS` is the single positive integer setting
(default 2). It limits simultaneous Turbo tasks and each Vitest process's
workers, including direct package test commands. Do not add concurrency, worker
or timeout flags. Existing database hook timeouts remain in the configs.

Reviewers still follow D26: required CI owns the gates when configured. Without
required CI, use `pnpm run check --review` and run the build without the cache.
The first review check forces Turbo execution. Once every check succeeds on a
clean tracked/untracked tree, it saves a versioned receipt with the exact HEAD,
check-run UUID and timestamp under the review worktree's ignored `.corral/checks/`.
Reviewer worktrees are retained between runs; the receipt does not enter a commit.
Moving the review to a different runner or deleting its worktree requires a fresh check.

A subsequent review check of that same clean HEAD prints which earlier check
run it reused and starts no checks. Cite that run and commit in the review
summary. A different commit, dirty tree, failed check or developer check cannot
supply a reusable review result. This is an explicit successful review-check
receipt, not a Turbo cache hit. Continue reviewing the diff and criteria;
criterion verdicts and review eligibility are unchanged. The build is separate
and is not covered by the receipt. Delete a receipt to deliberately recheck a
head (for example after a toolchain or external service change).

`scripts/check.ts` owns orchestration and receipts; `scripts/check-cpus.ts` is
shared by all six Vitest configs. `apps/runner/src/check-command.test.ts` covers
orchestration failure propagation and receipt eligibility using real subprocesses
and temporary git repositories with a recording pnpm stand-in.
