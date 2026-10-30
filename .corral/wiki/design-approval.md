# Design completion (D20)

Design tasks finish at `approved`, after human approval of a submitted version. Other types finish at `merged`; spikes have no PR. `packages/core/src/completion.ts` defines the type-aware completion and immutability rules, and `apps/server/src/completion.ts` derives the database completion predicate from that mapping. Task and epic dependencies use these rules. An Approved design remains soft-deletable, retaining its versions and blobs.

Approval updates the version and task together through core. Reopening uses `human_request_changes` with required feedback, keeps a pinned task comment and audit detail, and preserves the approved version until another is approved. The board has Approved after Merged; the design panel offers Reopen design.

## Existing designs: review before repair

Migration `0030_boring_magus.sql` only adds the enum value. It does not repair any task or version. Run the read-only inventory in `docs/operations/design-approval-inventory.sql` against the intended database and retain its complete output for human review. It lists every design task, including deleted tasks, its approved version/commit if any, and the policy applied to that row.

- Already Approved: leave unchanged.
- No approved version: leave unchanged.
- Deleted: leave deleted and retain versions.
- Approved version with In progress: inspect the history for an intentional reopening; never automatically mark done.
- Approved version with any other legacy status (including Human review, Ready to merge or Merged): review individually. Version approval alone is not permission to rewrite task history.

Any repair must be a separate, explicitly reviewed migration with the inventory, chosen task IDs, expected old statuses/version IDs, and the human's decision attached. No repair is included here. The deployed database must be inventoried by its operator; development data cannot establish which production rows need repair.
