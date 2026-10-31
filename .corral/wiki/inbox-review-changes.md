# Inbox review changes

Needs-you task and epic items carry `since` and `newArtifacts`, derived on read in `taskChanges` (`apps/server/src/inbox.ts`) and `epicChanges` (`apps/server/src/epic-prs.ts`), with shared filters in `apps/server/src/inbox-changes.ts`.

The last action is the latest human `human_request_changes` or `resolve` transition (a clarify is a resolve with a pinned comment), or the epic's `human_changes_requested`. Everything compares `createdAt`, never rounds: resolving Blocked resets `reviewRounds`, so rounds repeat.

A resolve stores no text, so its words are the human's pinned comment written after the transition before it. That bound keeps an older answer off a wordless Retry.

Work notes have no marker of their own: they're single-line, unpinned comments by a developer or designer. A one-line `add_comment` from those roles also counts. Fix tasks are matched by `FIX_TITLE_PREFIX`, so rebase tasks and unrelated tasks added to the epic aren't listed; their `createdAt` can equal the action's because they share its transaction.

Activity and Resolved task items leave both fields out.
