# Parent PR history in the Inbox

Code and branch names still say epic: see [Parent tasks](parent-tasks.md). The `epics` row is a parent's delivery record.

`loadInbox` reads existing `epic.pr` audit rows as `EpicActivityItem`
(`type: epic_activity`), with the stored `event`, `epicId`, and null `taskId`
and `taskRef`. It never looks up a representative task: history remains visible
for empty parents and parents whose tasks have been deleted. Unknown event names
remain readable using the event name as the label. No audit rows are rewritten.

Human-authored events go to Resolved with their action and summary in
`resolution`; other parent events go to Activity. Both lists still mix task and
parent history (and dismissed releases in Resolved), sorted newest first before
the existing limit. A live conflict remains an `epic_conflict` in Needs you.

The selected history item opens read-only in `InboxEpicPanel`, on desktop and on
a phone, with no task load and no actions.

Coverage: `apps/server/src/inbox-history.test.ts` checks existing raw audit
shapes, every parent event, mixed ordering, empty/deleted tasks, human resolutions,
and the separate live conflict item using PGlite HTTP requests.
`apps/web/app/features/inbox/components/InboxTaskLoad.test.ts` opens the history route on
both layouts and checks the parent link, closed flyout, absent task requests,
and absent task panel/composer.
