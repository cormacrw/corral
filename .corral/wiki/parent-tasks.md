# Parent tasks (D31)

A parent is a `tasks` row with status `parent`; `epics.task_id` points at it and
`tasks.epicId` points its sub-tasks at the same epic. Code keeps saying epic:
only people see the word parent. `apps/server/src/parents.ts` has the rollup,
`parentHolds` and the title and description sync between the two rows.

- `ensureParent` runs whenever a task joins an epic. A second task creates the
  parent, so a Corral fix task on a one-task epic creates one too.
- `listTasks` hides a parent whose sub-tasks are all Drafts, and shows it in
  Backlog until one leaves Backlog. Rollups are on the API; the Board recomputes
  a parent's stage from live tasks, as it did for epics.
- `useProjectLists().tasks` leaves parents out, so every list of work stays as
  it was. Use `parents`, or `searchable` from `useAllProjectLists`, to see them.
- A plan's promotion sets `epics.task_id` on a task that isn't a parent yet. Only
  approval changes its status, so deleting that epic must not delete the task:
  every delete checks `status = 'parent'`.
- The migration rebuilds the `task_status` type, because a value added with
  `ALTER TYPE` can't be used in the transaction that adds it.
- `COMPATIBLE_TOOL_CONTRACTS` keeps runners on the previous build taking runs.
