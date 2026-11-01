# Epic integration review rounds

Epic reviewers may pass `findings` to `report_outcome`. Each finding has
`level: blocking | non_blocking`, non-empty `text`, and `taskRefs` naming
the concerned tasks. The integration prompt asks reviewers to report cross-task
problems this way and distinguish suggestions from blockers. Omitted findings
are accepted as an empty list for older runners and clean reviews.

Every accepted report appends an immutable `epic_review_rounds` row, containing
the epic, run, reviewer agent, one-based round number, reviewed head SHA,
verdict, summary, findings, and report time. Allocation happens under the epic
row lock in the same transaction as completing the run and changing epic state.
Stale and duplicate reports cannot append rounds. Failed/interrupted runs do
not consume a round.

Epic Inbox review items expose chronological `reviewRounds` and the latest
round's `findings`. Existing approved runs without round rows keep their
summary and reviewer in the Inbox, with empty findings and round history.
No historical data is rewritten. The additive migration creates the new table.
A mechanical rebase may retain approval, so the item's current head can differ
from the reviewed head retained on a round.

Coverage: `apps/server/src/epic-prs.test.ts` exercises runner WebSocket reports,
round history across changed heads, empty reports, duplicate rejection, and
legacy Inbox HTTP responses. These transaction tests use opt-in Postgres.
