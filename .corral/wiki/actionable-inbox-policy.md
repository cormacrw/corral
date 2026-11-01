# Actionable Inbox policy (COR-399)

D11 in `docs/decisions.md` is the binding classification and escalation contract; `docs/flows.md` describes the default feature loop and recovery boundary. Needs you means unresolved human decisions, not unread conversation or internal progress. Exhausted recovery stays visible until resolved; automatic recovery and caps are retained.

`HUMAN_DECISIONS_NOTE` in `packages/core/src/human-decisions.ts` is the one copy of the escalation contract: questions explain the blocker, decision and recommendation when available. The server prompts that can reach a human (PM, developer, spike, designer, rebase, epic rebase, rebase review) and the built-in role instructions (`apps/runner/src/role-defaults.ts`, D13) interpolate it, so projects with no role files get it too. `.corral/agents/{developer,reviewer,designer}.md` can't import it, so `role-defaults.test.ts` asserts they contain it verbatim; change them together. Ordinary implementation choices are resolved internally.

The policy itself (COR-399) wasn't a review-mode migration. Existing review routing, sensitive flags, D20/D27/D28 obligations, approvals and recovery machinery are unchanged. Follow D11 when changing Inbox classification rather than the historical unread-reply or release-note placement described in older wiki pages.

## The quiet default (COR-401)

`needsAttention` in `packages/contracts/src/client.ts` is the one classifier: everything except release notes and a thread with `status: 'none'`. `Inbox.count`, `inboxCount` (which `plan.session` read events carry), `projectNeedsYou` and the mobile tab count all follow it. `inboxTabs` in `useInboxView.ts` splits the server's `needsYou` into the default tab and Activity, so anything reading the list for position or next item uses the decisions: `moveToNext`, the phone's "n of m". A deleted informational thread goes to `/inbox`, because moving on would open an update and mark it read.

A row can go quiet while open, when a question is answered and only a reply remains. `openThread` keeps the pane, and the tab only follows an item on arrival, so the list doesn't jump. `InboxEmpty` handles links that outlive their item on both layouts. Its id can be a session, task or epic, and activity rows carry `taskId`/`epicId`, which is how it finds the source.

If the server stops sending informational items in `needsYou` and sends them elsewhere, `inboxTabs` and `inboxWithRead` are the two places to change.
