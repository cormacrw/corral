# Runner protocol boundaries

The WebSocket entry points use the exported Zod schemas in
`packages/contracts/src/runner.ts`. Invalid JSON and invalid message shapes are
logged with the direction, message type (or unknown/invalid JSON), and decoding
reason, then dropped before dispatch. The connection remains usable. Payloads
are not included in diagnostic messages.

Jobs are a role union inferred from the runtime schemas. PM turns require a Plan
session and null task/branch/commit fields; task context such as baseBranch,
epicId, designPinned and non-null taskType is rejected. Developers and task
reviewers require taskId/taskRef. D23 integration reviewers instead require
epicId, branch and headSha with null task fields. A reviewer with neither target
is invalid. D20 designers have role=designer and taskType=design, on their own
named schema, and report through `DESIGNER_RUN_OUTCOMES`.

taskType, designPinned and baseBranch remain optional for older servers.
Older hello metadata remains decodable so protocol-version mismatches still
close with 4000 and the server's protocol/commit details. Schema validation does
not replace the existing run ownership and lease fencing checks.

## Outcome reports

`report_outcome` has one flat MCP input (`reportOutcomeInput`), because Claude's
API refuses a tool whose input is a top-level union. It rejects unknown outcome
strings before the runner forwards anything, and it hides `rate_limited`, which
only comes from a run's exit.

The server parses the report again with the schema for the kind of run. Task
reviews use `outcomeReportSchema`, where every verdict in `REVIEW_VERDICTS` needs
`criteria`. Rebase reviews use `rebaseReviewReportSchema`, where approved needs
none because the earlier verdicts carry over (D24) and every other verdict still
does. A task whose criteria are all human checks needs none either: they take no
verdict. Integration reviews use
`epicReviewReportSchema`, which takes verdicts only and no criteria (D23). A
failed parse comes back as `Not reported. <field>: <problem>`. Whether the
role and task type may report that outcome is still checked after parsing.

## Run lifecycle

Every run ending goes through `RunEnd` and `runEndValues` in
`apps/server/src/run-lifecycle.ts`. `runLifecycleSchema` in contracts is the
shape of a serialised run, and `toRun` parses each row with it, so it must allow
everything the checks on `runs` allow, or a stored row fails the read.

The checks are `runs_ended_at_matches_state`, `runs_outcome_only_when_ended`,
`runs_outcome_matches_role` and `runs_role_context`. Finished PM turns and
interrupted runs have no outcome, `rateLimitResetAt` may be null, and
`planSessionId` goes null when its session is deleted. Tests that write a
finished run directly must set `endedAt`.


## Task integration negotiation (COR-286)

Envelope protocol stays 3. Optional hello `taskIntegrationProtocols` advertises
exact supported integration versions; missing means legacy only. Task jobs
carry optional `integrationProtocol` (missing/0 is legacy). Placement and the
last dispatch check refuse unsupported requirements; welcome and runner status
provide `integrationCompatibilityReason` with an update instruction. Runners
must not advertise execution they don't implement. See
[PR-free task state](pr-free-task-state.md) for the staged rollout.
