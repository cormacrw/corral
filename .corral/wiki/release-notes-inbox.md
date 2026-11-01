# Release notes in the Inbox

Each deployment becomes a `release_notes` Inbox item from the configured PM. `loadInbox` selects the latest 20 deployments globally, joins their projects, and merges undismissed notes into `activity`, sorted newest first by `at` (the deployment's time). They're informational under D11, so they're never in `needsYou`, add to no count and need no dismissing. Reading doesn't move a note.

Opening the shared `InboxReleaseNotes` component calls `POST /api/deployments/:id/read`. Read notes remain in Activity. Dismiss calls `POST /api/deployments/:id/dismiss`, records `dismissedAt` and moves the item to Resolved. The migration adds a nullable timestamp without rewriting existing records.

Creation, note completion, reading and dismissal publish `deployment.updated`. `inbox` is invalidated on this event, including while a pending item is open, except that an event marked `markedRead` only clears the row's unread flag. Opening clears the dot before the request; a failed read refetches. Pending items say “Writing release notes…”. Completed notes use the safe MarkdownText renderer with task-reference linking limited to the live projects' prefixes, so SHA-256 stays text; task links use the application's router on desktop, mobile and the hash-routed prototype.

The prototype has an unread release item from the fixture PM, sorted into its Activity the same way, and read/dismiss mock routes. `deployments.test.ts` covers the API lifecycle, ordering and count. `InboxReleaseNotes.test.ts` covers opening, pending-to-ready updates, markdown task links and dismissal. The API and migration suites cover PGlite and Postgres when available; the test harness can start throwaway Postgres.

The release-notes component test checks the cached Inbox row after opening and that a failed read isn't retried.
