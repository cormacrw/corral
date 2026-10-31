# Design completion (D20)

Design tasks finish at `approved`, after human approval of a submitted version. Other types finish at `merged`; spikes have no PR. `packages/core/src/completion.ts` defines the type-aware completion and immutability rules, and `apps/server/src/completion.ts` derives the database completion predicate from that mapping. Task and epic dependencies use these rules. An Approved design remains soft-deletable, retaining its versions and blobs.

Approval updates the version and task together through core. Reopening uses `human_request_changes` with required feedback, keeps a pinned task comment and audit detail, and preserves the approved version until another is approved. The board has Approved after Merged; the design panel offers Reopen design.

## Existing designs: review before repair

Migration `0040_late_colossus.sql` only adds the enum value. It does not repair any task or version. Run the read-only inventory in `docs/operations/design-approval-inventory.sql` against the intended database and retain its complete output for human review. It lists every design task, including deleted tasks, its approved version/commit if any, and the policy applied to that row.

- Already Approved: leave unchanged.
- No approved version: leave unchanged.
- Deleted: leave deleted and retain versions.
- Approved version with In progress: inspect the history for an intentional reopening; never automatically mark done.
- Approved version with any other legacy status (including Human review, Ready to merge or Merged): review individually. Version approval alone is not permission to rewrite task history.

Any bulk repair must be a separate, explicitly reviewed migration with the inventory, chosen task IDs, expected old statuses/version IDs, and the human's decision attached. No repair is included here. The deployed database must be inventoried by its operator; development data cannot establish which production rows need repair. A human can recover one task at a time; see below.

A legacy design already in `merged` counts as unfinished under the type-aware rule; its dependents wait until it is repaired through the reviewed migration policy above.

Type changes are locked in Approved, Ready to merge and Merged. Epic PR readiness and live epic progress count type-aware completion; Approved designs leave open-work counts.

## Approving from the Inbox (COR-320)

The Inbox's **Approve design** action (desktop and mobile) approves the latest submitted version under the task lock, through the same path as the version endpoint: approve the version, supersede earlier versions, move the task to Approved, and open a Plan session with the human's message. The PM gets a turn to propose the build with pins to that version. **Review design** still links to the task's design panel. The Inbox holds the `selected` watcher's flyout close while the action runs and advances to the next Needs-you item through `itemRoute`, so a live refresh cannot cancel that navigation. Approval preflights runner and PM availability (including pause and stop controls) before changing the version.

`human_approve` on a design only comes from `approveDesign`; the generic approve path refuses designs, because it can't approve a version. The merge pass skips designs even if they have PR metadata.

## Recovering one task by hand, including COR-190 v5

These never run on their own: each is a human's explicit approval of one task, recorded in the audit log with the task transition and the version.

- **Ready to merge** (left by the old Inbox path): open the task page, select the submitted version (v5 for COR-190) and click its approve button. The version endpoint accepts this status. A `human_approve` audit entry alone doesn't identify today's latest version, which may have been submitted later.
- **Human review whose latest version is already approved** (a task-page approval from before the Approved status): if no version is submitted, the Inbox action, the version endpoint and the task page finish the task in Approved, reusing its build Plan session or starting one if absent. A newer submitted version always takes priority.

Approval needs an online runner to start the PM's build session.

## Approval notes (COR-347)

A nonblank approval note from the design review panel or Inbox is trimmed and saved as a normal, unpinned comment by the human in the same transaction as the design approval. The note also stays in the PM build session's opening message, including Inbox approvals. Rejected approvals do not leave comments; retrying an already approved version does not append another approval comment. Requested changes still produce exactly one pinned feedback comment through the task transition.
