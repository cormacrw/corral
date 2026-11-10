# Open recommendations

Review feedback on the PRD (2026-10-26) and questions raised while building that **haven't been accepted or rejected yet**. None of this is binding. Before building on any of it, raise it with Cormac. Once decided, move the item into [decisions.md](decisions.md) or drop it.

Settled items have been removed. Each line below says where an item went, so old references to its number still resolve:

- **R1, R2:** became D2 and D1.
- **R4** (lint alone is a weak gate): settled by D5 and D26. A project with no required checks still auto-merges on the reviewer's approval, but its reviewer runs every gate without the cache.
- **R5** (human review for risky areas): built. Projects have a human review default (`humanReviewDefault`), and the PM's prompt tells it to set `humanReview` for auth, data migrations, payments, deletions and security work.
- **R6** (reviewer shouldn't rebase): settled by D24, D27 and D29. The server does clean rebases, a developer resolves conflicts, and the reviewer stays read-only.
- **R7** (approval invalidation): built and recorded in D24 and D27. A clean rebase keeps approval and reruns CI; any other new head needs review.
- **R8** (wiki conflict hotspots): done. The wiki is many small per-area pages.
- **R11** (runner contract and job spec): built (`packages/contracts/src/runner.ts`).
- **R12** (walking skeleton): obsolete.
- **R15** (GitHub calls through the runner's `gh`): built and folded into D8.
- **R16** (typed fetch wrappers instead of `hc`): built and recorded in architecture.md.

---

## Safety and gates

### R3 — Agents need to know how to start the app (follows D4)

Evidence rules are settled (D19, D21, D28), and CI output reaches developers from CI itself (D29). What's left: every repo starts differently (env vars, seed data, ports). Make a "how to run the app" section in `CORRAL.md` required, and have project setup check that it works.

---

## Review workflow

### R9 — The planner should consider file overlap

Two "independent" tasks touching the same module will conflict. The PM's prompt asks it to plan around overlap, but there's no field for it. Even a rough "expected areas touched" field on tasks would let the PM and scheduler avoid running them in parallel.

---

## Reliability

### R10 — Scoped GitHub tokens at hosting time

Lease epochs and fencing tokens are built (see [stale-runners-and-fencing.md](stale-runners-and-fencing.md)). Still open: short-lived, branch-scoped GitHub tokens, as a requirement for the hosted version.

### R17 — A deleted task's branch is only removed when a PR had been opened (raised while building, 2026-10-28)

D10 says to delete the Corral branch "when safe". The server closes the PR and deletes the branch on GitHub only when a PR exists, because the closed PR keeps the pushed commits reachable. A branch pushed without a PR, such as a PR-free subtask's branch (D27), is left alone. The runner keeps any worktree with uncommitted changes and says so in a comment.

### R18 — `.corral/` initialisation and the permission mode are deferred (2026-10-28)

Not built: writing `.corral/` into a target repository during setup (agents read `.corral/agents/<role>.md` when it exists and fall back to built-in instructions). Agents run with `--permission-mode bypassPermissions`, which is safe inside the runner container but has wide reach on a laptop. Human change requests don't count toward the review-round cap. Runner pairing is deferred by D25, and mid-run messages are built (`message_run`).

### R19 — Limits on PM threads (raised reviewing the D30 task, 2026-10-31)

Gate-lowering PM edits now need a confirm card (D30). Still open: `start_thread` has no depth cap and `message_thread` no ping-pong limit.

---

## Phasing and metrics

### R13 — Add a quality metric next to autonomous completion rate

"Autonomous completion rate" (PRD §15) rewards rubber-stamping. Flow metrics (`.corral/wiki/flow-metrics.md`) cover re-review and reviews per task. Still missing: PRs reverted or followed by bug-fix tasks, and **human minutes per merged task**, which is what the qualitative goal is really about.
