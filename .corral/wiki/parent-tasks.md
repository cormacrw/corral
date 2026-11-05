# Tasks with subtasks (D31)

People see tasks and subtasks. `epic`, `epics`, the `parent` status and names
such as `parentHolds`, `parentId` and `update_parent` are internal identifiers
or compatibility contracts, not names for another kind of work item.
“Parent” is appropriate only when a subtask refers to the task it belongs to.
Prompts and delivery messages say “the task's PR” and “the task's branch”.

A task with subtasks is a `tasks` row with status `parent`;
`epics.task_id` points at it and each subtask's `tasks.epicId` points at that
delivery record. `apps/server/src/parents.ts` owns the rollup and synchronises
the title and description between the two rows.

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
- `COMPATIBLE_TOOL_CONTRACTS` keeps runners on the previous build taking runs.
  PM arguments keep `update_parent`, `parentId`, `parents` and
  `defaultReviewMode`; `neutralPmCall` translates older calls and saved cards.
- Stored operation errors are compared by text. `epic-sync.ts` and
  `task-integration.ts` accept legacy errors using both older vocabularies,
  while newly generated messages use task/subtask wording (COR-520).
