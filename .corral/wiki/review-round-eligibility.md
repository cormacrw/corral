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

Rebase review approval clears `rebaseOnly` before Ready to merge, while
retaining `approvedHeadSha`. Later merge failures resolved to
In progress therefore start ordinary developer rounds. Blocking an unfinished
rebase and resolving it to In progress preserves rebase-only mode. The Inbox
activity feed records `pr_rebased` as a rebase handed to the reviewer.

Rebase reviewer assignments use a dedicated conflict-check prompt with the approved
and submitted head SHAs, range-diff instructions, and checks against the base
commits and changed binding docs. Approval copies the approval at
`approvedHeadSha`, including its criterion notes, onto the submitted head; missing
or no-longer-applicable criteria reject carry-over. The recorded review summary
identifies the reviewed rebase. The task always returns to Ready to merge, even
with `humanReview` set or in an `each_task` epic (D24): the `approval_carried`
event skips D5/D23's routing. `carryOverApproval` in `rebase-review.ts` is the one
place that records the carried review and applies that event, for the server
check as well as the reviewer; it works from In progress too, and writes nothing
when the approval can't carry over.
Rebase comments contain only the verdict and the reviewer's conflict summary.
Changes requested still supplies normal criterion verdicts and consumes one round.
`checkFailures` (`{ condition, files }`) on the latest `pr_rebased`
`task.transition` audit entry adds a prompt section naming what the server check
failed.
The rebase-only reviewer outcome `blocked` preserves the round count and posts
the substantial change or changed binding decision as the task reason for the
human. It is a run outcome,
not a criterion review verdict. `rebase-review.test.ts` exercises all three paths
through runner WebSocket reports and task HTTP responses.

Rebase submissions now require `review: trivial | needs_review` and a non-empty
`conflictedFiles` list (non-blank file paths). Trivial means combining both sides
with no new logic, renames or behaviour changes; every other resolution needs
review. `needs_review` goes to Agent review without any check.
The run stores both fields; the reviewer assignment includes them and the task
History entry shows the choice and complete file list. Historical runs remain
readable without these fields. The additive migration leaves existing data intact.

`trivial` runs `checkTrivialRebase` (`rebase-review.ts`) before the submission's
transaction, using GitHub's three-dot compare. Old and new base are the merge
bases of the approved and new heads with the base branch's current head; nothing
stores them. File changes are compared without hunk headers, so a change that
only moved down the file doesn't count as different, and a file with no patch
falls back to its blob SHA. A base-side rename counts both paths as changed.
Passing carries the approval over as the `server` actor with the developer's run
id, writes a `rebase.verified` audit entry and posts a Corral comment, which is
what the task's Activity tab shows; no `pr_rebased` transition is written, so the
Inbox shows the `rebase.verified` line instead. Failing records `checkFailures`
on the `pr_rebased` transition. A GitHub error, a comparison of 300 or more
files (GitHub silently truncates) or an approval that can't carry over records
`checkError` there instead and goes to Agent review with no failed conditions.
