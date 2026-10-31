# Inbox review changes

Needs-you task and epic items carry `since` and `newArtifacts`, derived on read in `taskChanges` (`apps/server/src/inbox.ts`) and `epicChanges` (`apps/server/src/epic-prs.ts`), with shared filters in `apps/server/src/inbox-changes.ts`.

The last action is the latest human `human_request_changes` or `resolve` transition (a clarify is a resolve with a pinned comment), or the epic's `human_changes_requested`. Everything compares `createdAt`, never rounds: resolving Blocked resets `reviewRounds`, so rounds repeat.

A resolve stores no text, so its words are the human's pinned comment written after the transition before it. That bound keeps an older answer off a wordless Retry.

Work notes have no marker of their own: they're single-line, unpinned comments by a developer or designer. A one-line `add_comment` from those roles also counts. Fix tasks are matched by `FIX_TITLE_PREFIX`, so rebase tasks and unrelated tasks added to the epic aren't listed; their `createdAt` can equal the action's because they share its transaction.

Activity and Resolved task items leave both fields out.

## Conversational messages

Needs-you task and epic items now also carry `message`; `preview` is its first
200 characters. `body` still contains the complete existing text (including
spike findings). Plan threads, releases, Activity and Resolved keep their own
existing text.

`InboxMessages` subscribes to task/epic updates and scans open items at startup.
It inserts a fallback in `inbox_messages` before asking the runner for an
`inbox_message` setup job. The job shares the title generator's configured
small model, no tools, isolated working directory, and 30-second timeout. It
uses only titles/descriptions, verdict/summary, reason/findings, `since` and
`newArtifacts`; the prompt forbids listing artifacts or inventing progress.
Messages are plain prose, at most 80 words. Empty, markdown and overlong model
responses leave the fallback intact, as do offline runners and failed jobs.

The durable key is entity ID + item type + arrival audit ID (or arrival time
for legacy items without an audit entry). Tasks use their latest
transition into the current status; epics use the approved/merge-refused or
conflict audit event, so editing a waiting epic does not create another message.
A new arrival gets a new key, and a delayed result only updates its own key.
The insert also claims the job: updates and restarts never retry that arrival.
Inbox reads only select stored prose or derive a readable fallback from the same
facts, never dispatch a model. Successful jobs publish an entity update so the
Inbox refreshes through its existing event dependencies.
