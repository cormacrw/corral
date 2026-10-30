# Review round eligibility

Reviewer claims require no verdict matching all three of task ID, current head
SHA and current `reviewRounds`. A changes-requested verdict advances the task's
round before the developer attaches replacement evidence. Resubmitting that same
commit is valid: the next scheduling pass can claim the new round even though an
earlier round reviewed that head. Persisted tasks stranded by the old head-only
check recover through the same query, with no migration or manual transition.

The reviewer prompt includes evidence from the current round; `get_evidence`
continues to expose the evidence history with each item's round. Mechanical
base-branch updates in `merge.ts` copy the approval's round to the new head and
leave the task's round unchanged, so that approval still suppresses review.

Regression coverage lives in `claim.test.ts` (persisted states and current-round
verdicts), `orchestrator.test.ts` (same-head resubmission and new evidence), and
`merge.test.ts` (carried approval and unchanged round).
