# Actionable Inbox policy (COR-399)

D11 in `docs/decisions.md` is the binding classification and escalation contract; `docs/flows.md` describes the default feature loop and recovery boundary. Needs you means unresolved human decisions, not unread conversation or internal progress. Exhausted recovery stays visible until resolved; automatic recovery and caps are retained.

`HUMAN_DECISIONS_NOTE` in `packages/core/src/human-decisions.ts` is the one copy of the escalation contract: questions explain the blocker, decision and recommendation when available. The server prompts that can reach a human (PM, developer, spike, designer, rebase, epic rebase, rebase review) and the built-in role instructions (`apps/runner/src/role-defaults.ts`, D13) interpolate it, so projects with no role files get it too. `.corral/agents/{developer,reviewer,designer}.md` can't import it, so `role-defaults.test.ts` asserts they contain it verbatim; change them together. Ordinary implementation choices are resolved internally.

Existing review routing, sensitive flags, D20/D27/D28 obligations, approvals and recovery machinery are unchanged, and nothing historical is rewritten.

## The quiet default (COR-401)

`inboxTabs` in `useInboxView.ts` maps the server's lists to the tabs, and anything reading a list for position or next item uses the decisions: `moveToNext`, the phone's "n of m". Deleting a thread away from the default tab goes to `/inbox`, because moving on would open an update and mark it read.

A row can leave Needs you while open, when a question is answered. `openThread` keeps the pane, and the tab only follows an item on arrival, so the list doesn't jump. `InboxEmpty` handles links that outlive their item on both layouts. Its id can be a session, task or epic, and activity rows carry `taskId`/`epicId`, which is how it finds the source.

## Derivation (COR-400)

`Inbox.needsYou` is `ActionableInboxItem[]`: release notes can't be put there, and `count` is its length, so there's no separate count query or filter to drift. Project counts are `projectNeedsYou`, its share of the same list. Reading never changes what's listed, so `markedRead` is a flag, not a new count.

Tasks are listed by status alone. `blocked` and `failed` are only reached once existing recovery has stopped: a run failing below the cap keeps the status, CI failures and conflicts return to the developer, and epic review failures stay `in_review` until the cap. So the wording of a reason never decides membership.

Unread replies used to carry failed PM turns too: a failed turn is a `pm`/`error` message with `unread` set. Nothing retries a turn, so a session whose last message is an error is `failed` and stays in Needs you, read or not, until the human messages it or deletes the thread. That covers usage limits and runner shutdowns, which also end a turn this way. A turn the human stops doesn't: `HumanActions.stopRun` ends the run first, so the later `run.ended` isn't live, no error message is written and the session stays `none`. Sessions that already ended that way surface once, with no data change.

Undismissed release notes are in `activity`, so anything acting on the Activity tab must allow `ReleaseNotesItem`.
