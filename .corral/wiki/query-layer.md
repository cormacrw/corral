# Query layer

Server data in `apps/web` lives in TanStack Query, in `app/queries/`. `app/plugins/query.client.ts` installs the client (`client.ts`) and connects it to `useLive`'s stream, real or mock, so the prototype works the same way. `useLive` holds only the SSE connection and its status.

Only `app/queries/` talks to the server. Lint fails on any other import of `useApi`, and of `subscribeLive` or `subscribeReconnect`, in `apps/web/app` (tests aside); `nuxt.config.ts` drops them from auto-imports, which lint can't see. Pages tell failures apart with `ApiError` from `~/queries/client`. A request with no query or mutation shape, such as `checkRepo` or the page-exit `closePlanThreadOnExit`, is a small function there too.

## Shell data

`shell.ts` holds one long-lived observer each for projects, agents, runner, status, profile, Plan sessions and the inbox count. `app.vue` starts it after the first navigation. Because those observers never unmount, navigating refetches none of them, whatever `staleTime` says; they refetch on events, window focus and reconnect. Pages read them through `useShell()`, a reactive object (`shell.projects`, `shell.loaded`, ...) that is empty until the shell starts. It's read-only: change this data with a mutation, or `setQueryData` for an optimistic edit as `ConcurrencyStepper` does.

The setup middleware runs before the shell starts and makes a single `api.projects.list()`, caching the list only if it is an array. It doesn't use the query's retries, so an unreachable server doesn't hold up a cold launch, and the shell then finds the list fresh and doesn't ask again.

`reloadShell()` refetches all of it, for a human pressing Retry or Reconnect. `connectQueries` marks a `plan.session` for the open thread read before writing it, so the cache gets the read session. `usePendingPlan` gets every event there too, with or without a conversation mounted; the client plugin passes both in.

## Run transcripts

`run.events` carries `offset`, where its first line sits in the transcript (`Transcripts.append` returns it, serialized per run and counted from the spool after a restart). The server appends before it publishes, so a fetch can return lines whose event is still on its way. `addLines` in `dependencies.ts` therefore skips lines the cache holds, appends the rest, and leaves the cache alone when an offset is past the end; that case refetches, as does an event for a transcript with no data, such as one whose first fetch failed. Appending without the check would also mark a stale transcript fresh, because `setQueryData` clears `isInvalidated`.

Events reach the query with or without an observer, so a run you switch away from keeps growing and shows at once when you come back. `useAgentRuns` and `PlanConversation` read the same `runTranscriptQuery`.

## Polling

Pull requests have no event for CI or base branch changes, so `pullRequestsQuery` sets `refetchInterval` to 30 s. TanStack skips the tick while the tab is hidden (`document.visibilityState`, through `focusManager`), and coming back refetches if the data is older than `staleTime`. Other data shouldn't poll.

## Project lists

`useProjectLists(slug)` observes the shared task and epic lists in `tasks.ts` and `epics.ts`. The desktop and mobile shells use `useAllProjectLists` to load every project's lists up front for counts, Home and palette search. Board, Backlog, Overview, Plan and task/epic properties read these same entries; `useLive` no longer stores tasks or epics or loads lists. Lists have the query client's 30-minute cache lifetime, so route changes keep content visible while a stale entry refreshes. Only cold-load errors surface as list errors; failed background refetches preserve cached content, including cached empty lists, on Board, Backlog and Overview.

Task events update loaded lists immediately. EpicDetail derives prerequisite and blocked-epic progress from the shared tasks with `epicWithLiveCounts`, so task creation, moves and deletion update the counts and waiting alert without needing an `epic.updated` event. Drafts are excluded both on fetch and on event writes, since they live only in their plan. Deleting a project empties its cached lists and removes its observers/search entries by deriving those from the current project list.

Board/Backlog and their task/epic flyouts use `defineMutation` for task creation, patching, transitions and deletion, epic patching and epic dependencies. Desktop drag moves and task Status actions (including mobile) use `moveTask` on top of the transition mutation: cancel an older list fetch, optimistically move the single card, then invalidate on success or restore just that card on rejection. A newer event for the card wins over rollback; other cards' live changes are preserved. Drag targets follow D10's existing human actions, and Board filters remain in the URL.

## Task and epic details

`TaskDetail` reads the task, comments, history, evidence, reviews and runs as separate queries, and `DesignReview` reads the designs; `EpicDetail` reads `epicQuery`. Until a task's own entry loads, `listedTask` shows its copy from a project list as placeholder data, so opening a task from the Board shows no skeleton. Reopening within the 30-minute cache lifetime shows the cached entries at once. Past `staleTime` they refetch behind that, and only a cold-load failure shows the error, with Retry refetching what failed.

A `comment.created` event is written into the comments and invalidates nothing, since a comment adds no audit entry. Don't add its history or evidence back: only comments on a task that isn't cached (so no ref to find) fall back to `keys.tasks.details()`. `run.updated` refreshes the run's task, because a run's end changes its history and can add evidence, reviews or a design version. `keys.tasks.detail(ref)` covers the task's side queries, so invalidate it only for something that changes them.

`commentOnTask` shows a `pending-` entry straight away. `withComment` replaces it, whichever of the response and the event comes first, and a failure removes it. `TaskDetail` empties the box when sending and puts the text back on failure; a failure after moving to another task is held until you return to that task, for as long as the component stays mounted.

`writeTask` also writes the task into its cached epic details, so an open epic's list and graph follow status changes at once. It finds them through `task.epicId` and `cache.epicsWith`, the second because a task that left an epic no longer names it. The epic then refetches through the queue, for the fields only the server derives, such as `reviewModeLocked`.

Task patches, transitions, resume and design approval write their response into the task's detail entry before invalidating `changed`, so the open task doesn't wait for the refetch. `actOnInboxItem` does the same when it returns a task, and `reviewEpic` covers the Inbox's epic actions.

`uploadAttachment` is the only way images upload, from `PromptComposer` and the description editor.

## Settings, Setup and removal

`queries/setup.ts` holds the CLI scan and repository list. `clisQuery` has `staleTime: 0`: a login changes on the runner with no event, so each visit shows the last scan and rescans behind it. Refresh on the repository step is the `refreshRepos` mutation, which asks past the server's cache and writes the result to the one `keys.setup.repos()` entry.

Removing a project goes through `clearProject`, from both `removeProject` and the `project.deleted` event, in either order. It removes the project's own queries, by slug and by the `projectId` in cached tasks, epics, runs and sessions, and filters the lists that span projects. A query still on screen is reset instead, since a removed query stays with its observer, so the page refetches to its 404. The repository list refetches too: its rows name the project using them, on creation as well as removal. Add a query holding project data and it needs to be covered there.

`pages/projects/[slug].vue` wraps every project route and shows `ProjectNotFound` once the list lacks the slug. `useRemovingProject` holds that back while Settings removes the project and moves on. It's a parent route because leaving `<NuxtPage />` out of `app.vue` stalls the first navigation, and because it holds what the tabs share. `provideProject` keeps the observers for the project, its lists and the default flow window for as long as the parent lives, and tabs read them with `useProject()`. A tab mounting its own observer would refetch anything past `staleTime`, so moving between tabs would request data events already keep current. `useProjectOverview` reads the Inbox, active runs and the five most recent tasks' history and runs as queries, from the parent. It preloads them once so the first Overview visit makes no requests and never briefly shows empty activity. While another tab is open its observers are disabled, so an event only marks them stale, and `staleTime: Infinity` means opening Overview fetches only what an event marked. The parent prefetches Pull requests once when the project is known, without an observer. Its page observes that cache with `refetchOnMount: false`: entering the tab makes no request, and only that mounted page polls every 30 seconds or refetches on task/run events. While on Board or another tab, those events mark the inactive entry stale without fetching; the first poll after opening Pull requests corrects it within 30 seconds. Project queries wait until the shell list resolves a real project; Overview waits for its lists too.

## Rules

- Skeletons depend on `isPending` only. It stays false for a query with data, so background refetches show no loading state. Never use `isFetching` for a skeleton.
- Events carrying a full entity write it into the cache. Derived data (inbox, counts, metrics) is invalidated.
- Nothing reloads by hand: events go through `eventDependencies`, mutations through `defineMutation`. No page or component listens to the stream.
- Keys come from `keys.ts`, never literals. Invalidating a key covers everything under it.

## Add a query

1. Add the key to `keys.ts`, under its domain.
2. Add `queryOptions` to `app/queries/<domain>.ts`, built on `api`.
3. Add the key to the events that change it in `dependencies.ts`.
4. Call `useQuery(xQuery(...))`. If it's a new prototype endpoint, add a `route(...)` to `mock-api.ts`.

## Add a mutation

```ts
export const patchEpic = defineMutation<Epic, { id: string, input: PatchEpicInput }>({
  mutationFn: ({ id, input }) => api.epics.patch(id, input),
  invalidates: (_, { id }) => [keys.epics.lists(), keys.epics.detail(id)]
})
const patch = useMutation(patchEpic)
```

`invalidates` is a list of keys, or a function of the result and variables. An optional `write(client, data, variables)` runs first, for what a refetch can't do, such as dropping a removed project. It runs only on success, at once rather than through the event queue, and `isPending` lasts until the refetch ends. On failure nothing is invalidated, `mutateAsync` rejects and `error` is set.

## Add a dependency

A new `ServerEvent` type doesn't compile until it has an entry in `eventDependencies`; the entry also subscribes the SSE stream to it. Each entry has `invalidates` and, for events with an entity, `write`.

- `cache.set` writes only to loaded entries: a list built from one event would look complete.
- Events carry a project ID and a task ID; keys use a slug and a ref. `cache.slug` and `cache.taskRef` look those up in the cache. When they miss, invalidate the wider key, as `taskStale` does.
- A write that lands during a fetch is requeued, because that fetch started before the change and would overwrite it.

## Coalescing

`live.ts` queues event invalidations and flushes after `QUIET_MS` (1 s) without an event, or `MAX_WAIT_MS` (2 s) after the first queued event under constant traffic. Each flush fetches a query once, however many keys cover it. Any burst inside one second is therefore one refetch, whatever its pauses, unless earlier events had already started the 2 s clock: traffic that never pauses for a second refetches every 2 s, and that bound can fall inside a burst.

Derived data lags events by 1 to 2 s. Entity writes and mutation invalidations don't go through the queue, so they apply at once.

On SSE reconnect, everything is invalidated and active queries refetch. Inactive ones refetch when next shown.

## Tests

`mountWithQuery` in `mount-with-query.ts` mounts a component with a `QueryClient`.

## Plan conversations

Plan, Inbox Plan panes, session navigation, drafts and finished turn steps now read queries. `plan.message` and `plan.updated` update the shared session detail even while its thread is unmounted. Session snapshots preserve messages, plan revisions and metadata that arrived during the request, so an older response cannot briefly hide a live reply. Conversation scrolling watches the session ID and message/transcript counts individually; read echoes and metadata updates do not move the log.

`usePendingPlan` keeps its retry/restoration state and seeds the query cache before navigation. The client plugin connects it to the cache so the reconciled POST result is written even after navigation away. Only starting/failed entries override the query; accepted threads use the shared session cache. Server human messages remove the temporary bubble, including when an event beats the POST response. See [optimistic-plan-starts.md](optimistic-plan-starts.md).

`markPlanRead` patches unread flags in place and sends a fire-and-forget acknowledgement, without invalidating queries. A `plan.session` echo with the same `updatedAt` keeps the session's list position. Approvals and thread closes use mutations to invalidate Plan and Inbox queries; approval also invalidates task lists.

## Inbox

`pages/inbox.vue` reads `useHeldInbox()` once and shares it through `useInboxView`, so the list and the selected item hold and release together. The item page reads the selected task, evidence and reviews through queries keyed by the selection, so a revisit shows cached data and no response can land on the wrong item. `TaskDetail` shows a task already in the cache while it loads its own copy.

A mutation that resolves the selected item spreads `holdsInbox` into `useMutation`, on the page or in a child. While one runs, the list stays as it was when it started: events still update the cache, but a removed row can't move the selection. A failure lets go. On success the page takes the same position from the fresh list with `moveToNext`, then releases, so nothing shows between the two. It prefetches the next task first, for at most a second, and does nothing if the selection changed meanwhile. Changing selection also releases. The `holdsInbox` key lives on the Inbox's `useMutation` calls, not on the shared definitions, so approving from Plan holds nothing.

Reading patches the cached Inbox with `inboxWithRead`: `markPlanRead` and `readDeployment` before their requests, and the `markedRead` events on every tab. `inboxQuery` reapplies reads made during its fetch. A fetch that starts after the patch but reaches the server before the read can briefly restore the row, until the `markedRead` event removes it. A failed release-note read refetches to bring the dot back; the component reads once per deployment, so that can't loop.

A failed task load shows Retry until a fetch settles it, and only then. Retry is `resetQueries`, which puts the query back to pending so the tray shows it loading.
