# Task state and metadata (COR-209)

Core's `TaskState` is discriminated by status: Blocked and Failed have a
nonblank reason; every other status has `reason: null`.
`normalizeTaskState` validates flat storage rows, trims intervention reasons
and clears irrelevant reasons. The transition boundary rejects blank block/fail
reasons, and resolving clears the reason in the same database update.

Task DTOs (HTTP and SSE) expose `pr: { number, url } | null`, replacing the
independent `prNumber` and `prUrl` properties. They expose
`draftSession: { id, title } | null`, replacing `planSessionId` and
`planSessionTitle`. Only Draft can carry that object; Blocked/Failed require
`statusReason: string`, and other statuses require null. Draft ownership is
derived from Plan history, never stored on a task. Historical Plan links stay
intact after approval, but are not exposed as a non-Draft task's session.

Migration 0045 checks every existing task (including deleted tasks) before
adding reason/status and PR-pair checks. It stops with offending task IDs if
old rows are inconsistent; it does not invent reasons or discard data.
An operator must repair those rows before retrying the migration. No existing
migration is changed.

There is no status-to-lease constraint: an In progress task can wait for a
retry without a lease (D10). Merged tasks need no PR: spikes, designs and
epic conflict work can finish without one. Board links and task properties
read the grouped PR object. Task detail displays the current Blocked/Failed
reason, and the board uses its existing error note.

The reason check uses `U&` escapes, so these migrations need a UTF8 database.
`postgres:17` and CI are UTF8 by default, and test-setup.ts passes UTF8 to initdb
because embedded-postgres can otherwise fall back to SQL_ASCII.
