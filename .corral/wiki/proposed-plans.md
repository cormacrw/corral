# Proposed-plan boundary

`packages/contracts/src/plan.ts` owns `proposedPlanInput`, the Zod wire
schema used by the server and by the runner's `propose_plan` MCP input shape.
Field descriptions live on that schema and appear in MCP tool discovery.
Add wire fields there so both boundaries accept and validate them together.

`normalizeProposedPlan` converts validated input to core's `ProposedPlan`:
trimmed/defaulted content, uppercase refs (while preserving dependency keys),
mandatory human review for design tasks, and empty epic membership removed.
The legacy single `epic: { title, summary }` maps to the key `main`; omitted
`epics` otherwise means no epics. Nonempty epic arrays take precedence.

Core remains independent of contracts. Its `PlanTaskContent` is shared by
`ProposedTask` and db's `PlanRevision`; revisions retain their database epic
and design-version IDs and numeric task dependencies. Semantic checks such
as nonempty criteria, design approval and dependency validity still run in
core/server before storage; the wire schema checks structure.
