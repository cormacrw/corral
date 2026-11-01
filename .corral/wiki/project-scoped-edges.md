# Project-scoped edges

Task↔epic membership and task and epic dependency edges can't cross projects,
and the database enforces it. `epics` and `tasks` are unique on
`(project_id, id)`. `tasks.epic_id` and both ends of `task_dependencies` and
`epic_dependencies` reference those pairs, so the edge tables carry a required
`project_id`. Write edges through `replaceEpicDependencies` or the task write
commands, which pass the project; don't insert a project taken from the request.
Edges across epics in one project are legal. Cycles are still core's job.

Deleting an epic nulls only `tasks.epic_id`. The key is
`ON DELETE SET NULL ("epic_id")`, because a bare `SET NULL` would also null the
required `project_id`. Drizzle can't express the column list, so the schema says
`set null` and migration 0045 has it by hand. Any later migration that recreates
`tasks_epic_same_project_fk` must keep it.

Migration 0045 lists any cross-project rows in its error and stops. It changes
nothing, so the server won't start until a human has fixed those rows.

Runs use the same paired-key pattern: `runs(project_id, task_id)` references
tasks, keeping its cascade-on-delete behavior. PM runs in a global session have
a null project (D29). Plans can't use a pair, because a global session has a
null project and can plan for any project. Migration 0055 replaces the pair with
a plain cascading `session_id` key and two triggers that report violations as
`plans_session_same_project_fk`, so a project's session still holds only that
project's plans, including when the session's project changes. PM runs may still have a
null task; deleting a session still nulls its PM runs' `plan_session_id`.
Evidence pairs `(task_id, criterion_id)` with acceptance criteria, including
criteria on different tasks in the same project. A non-null criterion requires a task owner; task-less PM evidence remains valid when both references are null. The preflight includes null task owners. Deleting a criterion clears
only `criterion_id`, preserving task-wide evidence. Migration 0050 manually
uses `SET NULL ("criterion_id")`; preserve that column list if recreating the
constraint (Drizzle cannot express it). Task deletion still cascades runs and
evidence, and session deletion cascades plans.

Migration 0050 reports all violating run, plan and evidence IDs together with
their owners and referenced IDs, then stops before any DDL. It never rewrites
ownership; a human must decide how to repair existing violations and retry.
