# Actionable Inbox policy (COR-399)

D11 in `docs/decisions.md` is the binding classification and escalation contract; `docs/flows.md` describes the default feature loop and recovery boundary. Needs you means unresolved human decisions, not unread conversation or internal progress. Exhausted recovery stays visible until resolved; automatic recovery and caps are retained.

`HUMAN_DECISIONS_NOTE` in `packages/core/src/human-decisions.ts` is the one copy of the escalation contract: questions explain the blocker, decision and recommendation when available. The server prompts that can reach a human (PM, developer, spike, designer, rebase, epic rebase, rebase review) and the built-in role instructions (`apps/runner/src/role-defaults.ts`, D13) interpolate it, so projects with no role files get it too. `.corral/agents/{developer,reviewer,designer}.md` can't import it, so `role-defaults.test.ts` asserts they contain it verbatim; change them together. Ordinary implementation choices are resolved internally.

This is a policy and instruction change, not Inbox query/UI implementation or a review-mode migration. Existing review routing, sensitive flags, D20/D27/D28 obligations, approvals and recovery machinery are unchanged. Follow D11 when changing Inbox classification rather than the historical unread-reply or release-note placement described in older wiki pages.
