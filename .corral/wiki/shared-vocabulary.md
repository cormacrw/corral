# Shared vocabulary

Statuses, roles, runtime ids, limits, tool names and the rules over them each
have one home. Import from there; don't re-type a list, a regex or a number.
A subset is derived from the full list (`z.enum(LIST)`, `.exclude`,
`.extract`, `sqlList(LIST)` in db), never written out again.

Dependencies run one way: `core` <- `contracts` <- apps, and `db` imports only
`core`. So anything db needs (a pgEnum, a SQL check, a `$type`) has to live in
core.

## `@corral/core` (packages/core/src)

| What | Where |
| --- | --- |
| Task statuses, board and "not started" sets | `status.ts`: `TASK_STATUSES`, `PRE_BOARD_STATUSES`/`isOnBoard`, `NOT_STARTED_STATUSES`/`isNotStarted` |
| Task types, priorities, refs | `task.ts`: `TASK_TYPES`, `deliversCode`, `isPrFree`, `taskRef`, `parseTaskRef`, `TASK_REF_PATTERN` |
| Done and delivery rules | `completion.ts` (`isTaskDone`, `deliveryCounts`), `parent.ts` (`deliveryInProgress`, `parentStage`) |
| Runs: states, outcomes, roles | `run.ts`: `ACTIVE_RUN_STATES`/`isActiveRun`, `*_RUN_OUTCOMES`, `COMMIT_OUTCOMES`, `AUTHORING_ROLES`/`isAuthoringRole`, `authorRoleFor`, `ROLES_TAKING_MESSAGES`, `EPIC_RUN_ROLES` |
| Runtimes and CLIs | `runtime.ts`: `AGENT_RUNTIMES`, `AGENT_RUNTIME_IDS`, `DEFAULT_AGENT_RUNTIME`, `CLI_IDS`, `runtimeOfCli` |
| Roles and actors | `actor.ts`: `AGENT_ROLES`, `SERVER_ACTOR`, `isAgentPaused`, `isViaPm` |
| Ids and error text | `ids.ts`: `isUuid`, `errorText`, `shortSha` |
| Project prefix, merge methods, review modes | `project.ts` |
| Plan approval targets and item changes | `plan.ts`: `PLAN_APPROVAL_TARGETS`, `PLAN_CHANGES` |
| When a design can be decided or approved | `design.ts`: `isDesignDecidable`, `isDesignApprovable` |
| Review verdicts, evidence kinds, finding levels | `review.ts` |
| Integration operations | `integration.ts`: `OPERATION_KINDS`, `ACTIVE_OPERATION_STATES` |
| Inbox actions per status | `inbox-actions.ts` |
| Merge gates, approval fate, leases | `merge-gates.ts`, `approval-fate.ts`, `lease.ts` |
| Task state machine | `task-machine.ts` |

## `@corral/contracts` (packages/contracts/src)

| What | Where |
| --- | --- |
| Limits both sides enforce (upload sizes, image types, tool-call and CLI job timeouts) | `limits.ts` |
| Runner socket: path, protocol, largest message | `runner.ts` (`RUNNER_MAX_MESSAGE_BYTES`) |
| The agents' MCP server name | `mcp.ts` (`CORRAL_MCP_SERVER`, `corralToolName`) |
| CI log excerpts and ANSI stripping | `ci-log.ts` (`ciExcerpt`, `stripAnsi`) |
| Agent tools: names, schemas, which role gets which, PM gating | `tool-definitions.ts` (`toolsForJob`, `PM_TOOL_NAMES`, `ROLE_TOOLS`, `toolRefusal`) |
| Text agents read in both prompts and runner instructions | `agent-instructions.ts` (`toolName`, `outcomeName`) |
| Wire names that differ from storage, and older-runner shims | `wire-compat.ts` |
| Audit actions and their detail | `audit.ts` |
| HTTP routes, inputs and responses | `endpoints.ts` |
| Runner status, roles and sign-in commands | `runner-status.ts` (`RUNNER_ROLES`, `runnerRoleFor`, `cliLoginCommand`, `GH_LOGIN_COMMAND`) |
| Run cost weights | `run-cost.ts` |

The web app imports the zod-free parts through `@corral/contracts/client`.

## Enforced

The root `eslint.config.mjs` (`sharedVocabulary`) rejects, outside core and
tests, the literal `'claude-code'` and a hand-written copy of the task-ref
regex. `apps/web/eslint.config.mjs` spreads it into its own rule. `apps/server/eslint.config.mjs` adds the append-only audit-log rule.
`scripts/check-cycles.ts`, run by the scripts package's lint, fails the gate
on any new import cycle.
