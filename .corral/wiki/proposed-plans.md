# Proposed-plan boundary

`packages/contracts/src/plan.ts` owns `proposedPlanInput`, the Zod wire
schema used by the server and by the runner's `propose_plan` MCP input shape.
Field descriptions live on that schema and appear in MCP tool discovery.
Add wire fields there so both boundaries accept and validate them together.

`normalizeProposedPlan` converts validated input to core's `ProposedPlan`:
trimmed/defaulted content, uppercase refs (while preserving dependency keys),
mandatory human review for design tasks, and empty task membership removed.
The legacy single `epic: { title, summary }` maps to the key `main`; omitted
`epics` otherwise means no tasks with subtasks. Nonempty task arrays take precedence.

Core remains independent of contracts. Its `PlanTaskContent` is shared by
`ProposedTask` and db's `PlanRevision`; revisions retain their database task
and design-version IDs and numeric task dependencies. Semantic checks such
as nonempty criteria, design approval and dependency validity still run in
core/server before storage; the wire schema checks structure.

## PM task boundaries

The PM splits a feature into tasks only for parallel work on different code.
Sequential work or work changing the same files stays in one task. A big
feature always gets one task, even with one task, so it appears in task views;
independent fixes stay standalone. There is no task-size target.

This guidance lives in the server's opening PM prompt (`apps/server/src/prompts.ts`)
and the `propose_plan` tool description (`packages/contracts/src/tool-definitions.ts`).
The server sends its opening prompt for every new session, regardless of project
role overrides, and includes it again when reconstructing a lost session.
Existing sessions retain their conversation and are not sent a new opening
prompt on each turn.

## Human review on plan tasks

`normalizeProposedPlan` reads a missing `humanReview` as `false`, so the
server's `propose_plan` handler records which keys left it out and `propose`
in `apps/server/src/plan-proposals.ts` resolves them before checking the plan: a new
top-level task (no `ref`, no parent) takes `project.humanReviewDefault`, a new
sub-task stays off, and a task with a `ref` keeps the existing task's flag.
Where the project reviews by default, an explicit `humanReview: false` on a new
top-level task is refused, pointing the PM at `update_task` after approval,
which takes a confirm card (D11). The Draft is created with the resolved flag,
so the plan panel and the approved task agree.
