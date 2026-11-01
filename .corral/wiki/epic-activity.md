# Epic PR history in the Inbox

`loadInbox` reads existing `epic.pr` audit rows as `EpicActivityItem`
(`type: epic_activity`), with the stored `event`, `epicId`, and null `taskId`
and `taskRef`. It never looks up a representative task: history remains visible
for empty epics and epics whose tasks have been deleted. Unknown event names
remain readable using the event name as the label. No audit rows are rewritten.

Human-authored events go to Resolved with their action and summary in
`resolution`; other epic events go to Activity. Both lists still mix task and
epic history (and dismissed releases in Resolved), sorted newest first before
the existing limit. A live conflict remains an `epic_conflict` in Needs you.

The selected history item uses a small read-only `InboxEpicActivity` fallback
on desktop and mobile, showing its message, resolution, and Open epic link
(and Open PR when available). It has no task query, task flyout or composer.
The distinct type lets the full epic panel replace this fallback later.

Coverage: `apps/server/src/inbox-history.test.ts` checks existing raw audit
shapes, every epic event, mixed ordering, empty/deleted tasks, human resolutions,
and the separate live conflict item using PGlite HTTP requests.
`apps/web/app/components/InboxTaskLoad.test.ts` opens the history route on
both layouts and checks the epic link, closed flyout, absent task requests,
and absent task panel/composer.
