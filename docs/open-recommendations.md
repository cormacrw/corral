# Open recommendations

Review feedback on the PRD (2026-10-26) that **hasn't been accepted or rejected yet**. None of this is binding. Before building on any of it, raise it with Cormac. Once decided, move the item into [decisions.md](decisions.md) or drop it.

Numbering starts at R3 because R1 (Claude Code auth) and R2 (local-first) were resolved as D2 and D1.

---

## Safety and gates

### R3 — Close the gaps in agent-captured evidence (follows D4)

- **The agent chooses what to screenshot**, and will naturally capture the happy path. The reviewer should check that every acceptance criterion has its own evidence, and ideally reproduce at least one criterion itself.
- **Test and CI results should come from CI or from runner-captured output** (exit codes, logs), not the agent's own summary. This fits PRD principle "never assume an agent's reported success is sufficient proof."
- **The agent needs to know how to start the app.** Every repo differs (env vars, seed data, ports). Make a "how to run the app" section in `CORRAL.md` required, and have project setup verify that it actually works.

### R4 — Lint alone is a weak gate for auto-merge (follows D6)

Lint doesn't catch broken behavior. Suggestion: before auto-merge is allowed, require at least **lint, typecheck and test**. If a repo has no tests, treat its tasks as human-review-required until tests exist. Never allow auto-merge with zero required checks configured.

### R5 — Default the human-review flag for risky areas (follows D5)

Unflagged tasks merge on a model review alone, so the flag is the main safety control. Have the PM propose it during planning, with the human confirming it as part of plan approval. Default it **on** for auth, database migrations, payments, deletions and security-sensitive code.

---

## Review workflow

### R6 — The reviewer shouldn't rebase or resolve conflicts

PRD §7.6 lets the reviewer rebase and resolve trivial conflicts. That gives it write access, contradicts "reviewer cannot implement feature changes," and invalidates its own approval with new commits. Suggestion: the **orchestrator** does mechanical rebases; **any** conflict goes to the developer. The reviewer stays read-only.

### R7 — Define the approval-invalidation policy

PRD §7.6 says new commits invalidate approvals "when required by the configured review policy," but doesn't set a default. That decides what happens with serialized merges: after task A merges, does task B need a rebase, a CI re-run and a fresh review? Pick a default (suggestion: a clean mechanical rebase keeps approval but re-runs CI; any non-rebase commit needs a fresh review).

### R8 — Wiki files will become conflict hotspots

If every PR updates shared pages like `architecture.md`, parallel tasks will conflict there constantly. Consider small per-area pages, or doc updates that only append.

### R9 — The planner should consider file overlap

Two "independent" tasks touching the same module will conflict. Even a rough "expected areas touched" field on tasks would let the PM and scheduler avoid running them in parallel.

---

## Reliability

### R10 — Fencing tokens now, scoped GitHub tokens at hosting time

See [stale-runners-and-fencing.md](stale-runners-and-fencing.md). Suggestion: lease epochs and fencing tokens on every control-plane write from the start; the runner kills its agents when it can't heartbeat; short-lived, branch-scoped GitHub tokens become a requirement for the hosted version.

### R11 — Fill out the runner contract and job spec

- `RunJob` (PRD §8.5) is missing: run ID, lease/fencing token, task description, pinned comments, previous review feedback, and the PR ref (for reviewer jobs).
- `RunnerProvider` (PRD §8.4) has no event/log stream and no heartbeat method.

---

## Phasing and metrics

### R12 — Build a walking skeleton first

The phases in PRD §13 are less vertical than they claim: Phase 1 is CRUD plus locks and proves nothing about the risky part. The riskiest assumption is whether agents reliably produce mergeable PRs that pass review with real evidence. Suggestion: first build hand-written task → runner → PR → reviewer verdict end to end, then add the PM, board and wiki.

### R13 — Add a quality metric next to autonomous completion rate

"Autonomous completion rate" (PRD §15) rewards rubber-stamping. Pair it with a counter-metric: PRs reverted or followed by bug-fix tasks, and the human's rejection rate in Human review. Also track **human minutes per merged task**, which is what the qualitative goal is really about.

---

## Inconsistencies in the PRD

These look like mistakes rather than decisions. Fix them in the PRD once confirmed.

- ~~Done vs Merged, Draft missing from the table, Cancelled/archived, no way out of Blocked, the unused Testing status, the status of approved tasks waiting on dependencies.~~ **Resolved by D10.**
- **Duplicate views:** §7.11 and §12.2 list the required views almost word for word. Keep one.
- **§7.9 acceptance criterion** says "Eligible Ready tasks can be merged without manual intervention." It should mean approved tasks in review, not Ready tasks.
