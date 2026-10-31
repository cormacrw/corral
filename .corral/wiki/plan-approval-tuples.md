# Plan approval and staged task writes

`apps/server/src/plan.ts` writes approvals through `recordApproval` with an `ApprovePlanCommand`: a human approver and a timestamp are required together. The `plans_approval_tuple` SQL check requires both fields for approved plans and keeps them paired for every status. Superseding a plan changes only its status, preserving its approval history; superseded versions may also never have been approved.

`PlanTaskWrite` separates removed items (no staged revision) from active version diffs with a live task ID. `added`, `changed` and `unchanged` can all carry a revision: change compares plan versions, while revision means edits to a referenced existing task. An unchanged proposal can still be awaiting its first approval. Drafts owned by the session are edited directly; edits to referenced tasks are staged and applied transactionally only on approval.

The `plan_tasks_revision_change` check forbids revisions on removed items. It deliberately does not require task or epic IDs: foreign keys clear those on deletion, and historical plans must still load. Read rows remain separate from the stricter new-write payloads.

Migration 0049 adds both checks NOT VALID, enforcing new inserts/updates after scanning history and warning with every offending plan/session and plan-task/plan ID. `openDatabase` forwards them to the server's output as `Database warning: ...` lines, so operators find them with `docker compose logs server`. Historical rows stay readable and are not repaired or attributed to an invented approver.
