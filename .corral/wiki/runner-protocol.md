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
is invalid. D20 designers retain role=developer and taskType=design; they have a
named designer schema, not a new wire role.

taskType, designPinned and baseBranch remain optional for older servers.
Older hello metadata remains decodable so protocol-version mismatches still
close with 4000 and the server's protocol/commit details. Schema validation does
not replace the existing run ownership and lease fencing checks.
