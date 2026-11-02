# Criteria checked by a human

Acceptance criteria have a `checkedByHuman` flag (false by default). `propose_plan` accepts legacy strings and `{ text, checkedByHuman: true }` objects in `acceptanceCriteria`; plan revisions preserve the flag and criterion IDs when the text matches. Strings and objects without an explicit flag retain the existing choice; an explicit `checkedByHuman: false` clears it. See binding decision D28 in `docs/decisions.md`. Humans can toggle it in the task's criteria list. Other task edits preserve it. Adding a human check while Ready to merge returns the task to Human review.

Developers still implement the task, but skip checking and attaching evidence for flagged criteria. Reviewers must not request changes over those criteria or missing evidence. They omit those verdicts: the server records `met: null`, with the note **Needs human check**, regardless of any submitted boolean. Other criteria still require verdicts and evidence. The merge evidence gate excludes human checks.

Reviewer approval routes any task with a flagged criterion to Human review, even with `humanReview: false` (and in any epic review mode). This is computed from the current criteria without changing the task's own human-review preference. Existing rebase-only approval carryover remains unchanged. The Inbox displays these criteria with **Needs human check** and a checklist. The human ticks each one before using Approve and merge; requesting changes remains available. Checklist ticks are local to the selected item; approval follows the existing human approval and merge gates. The reviewer's verdict remains a human check rather than claiming agent verification.

PR-free epic build tasks (`task` and `bug`) are the exception: their checks skip task Human review and are confirmed on the epic review (`pr-free-task-state.md`). Those ticks clear whenever the epic's head or the owed checks change, even though the Inbox item keeps the epic's ID. Spike and design tasks keep task-level Human review, even in an epic-review epic; the task-page hint and PM guidance reflect that boundary.

The additive migration gives existing criteria `false`, so tasks with no flagged criteria keep their existing routing, evidence and review requirements.

Task-page criterion text wraps in an expanding editor, with the human-check toggle on a separate line so mobile users can read the complete criterion. Inbox approval notes name the human checks as the reason for review, independently of the task-level flag.

PM approval cards (`approve_task`, `act_on_inbox` approve and `approve_design`) use `humanApprovalSummary` in `apps/server/src/pm-approval-summary.ts` to load and name every current human check. **Confirming says you checked: …** makes Confirm an explicit attestation to each named check. Confirm re-prepares the summary, refusing stale cards after checks are added or reworded. Tasks without human checks keep the existing summary.
