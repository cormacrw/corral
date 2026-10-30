# Release notes in the Inbox

Each deployment becomes a `release_notes` Inbox item from the configured PM. `loadInbox` selects the latest 20 deployments globally, joins their projects, and lists undismissed notes below all attention items, newest first. `needsAttention` excludes release notes from `Inbox.count`; both desktop and mobile tab counts use this rule.

Opening the shared `InboxReleaseNotes` component calls `POST /api/deployments/:id/read`. Read notes remain in the Inbox. Dismiss calls `POST /api/deployments/:id/dismiss`, records `dismissedAt` and moves the item to Resolved. The migration adds a nullable timestamp without rewriting existing records.

Creation, note completion, reading and dismissal publish `deployment.updated`. The Inbox refreshes on this event, including while a pending item is open. Pending items say “Writing release notes…”. Completed notes use the safe MarkdownText renderer with task-reference linking enabled; task links use the application's router on desktop, mobile and the hash-routed prototype.

The prototype has an unread Juno release item and read/dismiss mock routes. `deployments.test.ts` covers the API lifecycle, ordering and count. `InboxReleaseNotes.test.ts` covers opening, pending-to-ready updates, markdown task links and dismissal. The API and migration suites cover PGlite and Postgres when available; the test harness can start throwaway Postgres.
