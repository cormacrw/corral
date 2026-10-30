# Agent activity

`get_agent_activity` is the PM's read-only view of the team (`apps/server/src/agent-activity.ts`). It spans every project, unlike the PM's other tools, because agents are shared: scoping it to the session's project would show a busy agent as idle.

It has to fit in one tool response, so active runs are capped per agent (`activeRunCount` keeps the true total), recent runs are capped lower without `agent`, and summaries and errors are cut. Keep it small when adding fields.

The PM's own turn is always one of its active runs; the prompt tells it not to report that as work.
