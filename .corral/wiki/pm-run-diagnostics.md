# PM run diagnostics

`list_runs` and `get_run` (`apps/server/src/pm-tools.ts`, definitions in `packages/contracts/src/pm-tools.ts`) and `get_agent_activity` let the PM look into any run. The number shown in the app is `runs.number`, unique across projects, so `get_run` takes it with no task or project. Epic reviews have an `epicId` and no `taskId`, so `get_run_outcomes` never finds them; `list_runs` with role `reviewer` and status `failed` does.

Runs are global, like agents (D13): these reads span every project, whichever project the session belongs to, and only PM runs have them. The role lists are in `ROLE_TOOLS` on the runner and `allowed` in the orchestrator's `#tool`, and both must include a new tool, along with `agentToolSchema`, or the runner won't advertise it or the server will refuse it.

`agentRuntime` is the agent's runtime now: runs don't record their own, so a run from before a runtime change shows the new one, and a PM turn shows Juno's, not its session's override.

## Getting a new tool to a PM session

A tool reaches the PM only once it's on `main`, because `main` is what deploys. A task merged into an epic branch shows as Merged but stays off `main` until the epic PR merges (D27). That is why these tools were missing though COR-241 and COR-269 were done.

The server and the runner both have to run the new commit: the server's list decides what may be called and the runner's decides what's advertised. Check each runner's commit in Settings or `/runner/version`.

An existing session needs no restart and keeps its conversation; **it needs one new turn after the runner has updated**. An agent CLI reads the tool list when its process starts. Updating the runner ends its warm PM processes (D9), so the next message cold-starts with `--resume`, which connects to MCP again and gets the new list. A turn answered by a warm process on the old runner, or one in progress during the deploy, doesn't see the tools. The session's opening prompt isn't resent, so an existing session learns these tools from their MCP descriptions.

Claude Code may list a session's MCP tools as deferred, so the PM's first use of one in a resumed session can go through its own ToolSearch. That is the CLI loading the tool, not a Corral failure.
