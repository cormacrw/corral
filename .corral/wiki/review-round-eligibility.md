# Review round eligibility

Reviewer claims require no verdict matching the task ID, current head SHA and
current `reviewRounds` **since the latest submission**. A matching verdict counts
only when no later `task.transition` audit entry from `in_progress` to `agent_review` exists.
These persisted transitions cover PR, rebase, spike and design submissions;
their event labels record the specific outcome (for example `pr_updated`).
The audit entry's `createdAt` is compared with the review's `createdAt`; equal
timestamps count as reviewed. With no submission history, matching verdicts
continue to suppress duplicate reviews.

Changes requested advances the round before the developer attaches replacement
evidence. Resolving Blocked resets `reviewRounds` to 0 (D10), restarting the
round cap. The round is therefore not a submission identity: resubmitting the
same commit after resolution must ignore verdicts predating that submission,
even when their round is also 0. Persisted tasks already stranded in this state
recover on the next eligible scheduling pass through the same history check,
with no migration or manual transition. Task updates and claims do not count as
submissions.

The reviewer prompt includes evidence from the current round; `get_evidence`
continues to expose the evidence history with each item's round. Mechanical
base-branch updates in `merge.ts` copy the approval's round to the new head and
leave the task's round unchanged. The copied approval is recorded after the
latest submission, so it still suppresses review.

Regression coverage lives in `claim.test.ts` (persisted round-zero states,
submission timing, duplicate verdicts and carried approvals),
`orchestrator.test.ts` (same-head resubmission, human resolution and the reset
round cap), and `merge.test.ts` (carried approval and unchanged round).


Approved task PR conflicts now persist `rebaseOnly` and `approvedHeadSha`.
The developer receives the same narrow rebase prompt in a fresh or resumed
session, targeting the task's actual base (including epic bases).
Only `pr_rebased` submits this round; ordinary PR rounds reject that outcome.
The runner pushes the rewritten head with its usual force-with-lease path.
Conflict and resubmission leave `reviewRounds` unchanged and retain the
approved head for rebase review. Changes requested clears rebase-only mode
and starts a normal counted revision, reported with `pr_updated`.
Run history displays the outcome as “PR rebased”.

Rebase review approval clears `rebaseOnly` before Ready to merge or Human
review, while retaining `approvedHeadSha`. Later merge failures resolved to
In progress therefore start ordinary developer rounds. Blocking an unfinished
rebase and resolving it to In progress preserves rebase-only mode. The Inbox
activity feed records `pr_rebased` as a rebase handed to the reviewer.
