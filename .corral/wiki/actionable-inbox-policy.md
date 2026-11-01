# Actionable Inbox policy (COR-399)

D11 in `docs/decisions.md` is the binding classification and escalation contract; `docs/flows.md` describes the default feature loop and recovery boundary. Needs you means unresolved human decisions, not unread conversation or internal progress. Exhausted recovery stays visible until resolved; automatic recovery and caps are retained.

The PM prompt and task authoring/rebase guidance in `apps/server/src/prompts.ts`, plus `.corral/agents/{developer,reviewer,designer}.md`, require questions to explain the blocker, decision and recommendation when available. Ordinary implementation choices are resolved internally.

This is a policy and instruction change, not Inbox query/UI implementation or a review-mode migration. Existing review routing, sensitive flags, D20/D27/D28 obligations, approvals and recovery machinery are unchanged. Follow D11 when changing Inbox classification rather than the historical unread-reply or release-note placement described in older wiki pages.
