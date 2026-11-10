# Tasks with subtasks (D31)

People see tasks and subtasks. `epic`, `epics`, the `parent` status and names
such as `parentHolds`, `parentId` and `update_parent` are internal identifiers
or compatibility contracts, not names for another kind of work item.
“Parent” is appropriate only when a subtask refers to the task it belongs to.
Prompts and delivery messages say “the task's PR” and “the task's branch”.

A task with subtasks is a `tasks` row with status `parent`;
`epics.task_id` points at it and each subtask's `tasks.epicId` points at that
delivery record. `apps/server/src/parents.ts` is the only module that reads
that encoding: promotion, creating and deleting delivery records, the rollup,
syncing title and description between the two rows, and the dependency-cycle
check. Deleting either row keeps it while it has comments. The delivery rules
themselves are core's (`hasPrToLand`, `holdsDeliveryOpen`, `parentHolds`,
`boardComplete` in `packages/core/src/parent.ts`); `delivery-sql.ts` has their
SQL forms, held to them by `delivery-sql.test.ts`.

- `ensureParent` runs whenever a task joins a delivery record. Its second
  subtask creates the task row, including when Corral adds an internal fix.
- `listTasks` hides a task whose subtasks are all Drafts, and shows it in
  Backlog until one leaves Backlog. Rollups are on the API; the Board recomputes
  the task's stage from live subtasks.
- `useProjectLists().tasks` leaves tasks with subtasks out. Use `parents`, or
  `searchable` from `useAllProjectLists`, to include them.
- A plan's promotion sets `epics.task_id` before approval changes the task's
  status. Deleting that delivery record must not delete an ordinary task:
  every delete checks `status = 'parent'`.
- The migration rebuilds `task_status`: a value added with `ALTER TYPE`
  cannot be used in the transaction that adds it.
- PM arguments are `update_parent`, `parentId`, `parents` and
  `defaultReviewMode`. Only the wire names are accepted; `wire-compat.ts`
  maps them to the stored ones.
- Stored operation errors are compared by text. `ENDINGS` in `operations.ts`
  names each ending once with its stored text and the legacy wordings of both
  older vocabularies; newly generated messages use task/subtask wording
  (COR-520).
