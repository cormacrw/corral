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
`set null` and migration 0036 has it by hand. Any later migration that recreates
`tasks_epic_same_project_fk` must keep it.

Migration 0036 lists any cross-project rows in its error and stops. It changes
nothing, so the server won't start until a human has fixed those rows.
