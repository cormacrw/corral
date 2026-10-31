# Query layer

Server data in `apps/web` is moving to TanStack Query, in `app/queries/`. `app/plugins/query.client.ts` installs the client (`client.ts`) and connects it to `useLive`'s stream, real or mock, so the prototype works the same way. Pages not yet migrated still use `useLive` state; the two run side by side.

## Shell data

`shell.ts` holds one long-lived observer each for projects, agents, runner, status, profile, Plan sessions and the inbox count. `app.vue` starts it after the first navigation. Because those observers never unmount, navigating refetches none of them, whatever `staleTime` says; they refetch on events, window focus and reconnect. Pages read them through temporary getters on `useLive().state` (`projects`, `agents`, `loaded`, ...), which the final migration task removes. The getters are read-only: change this data with a mutation, or `setQueryData` for an optimistic edit as `ConcurrencyStepper` does.

The setup middleware runs before the shell starts and makes a single `api.projects.list()`, caching the list only if it is an array. It doesn't use the query's retries, so an unreachable server doesn't hold up a cold launch, and the shell then finds the list fresh and doesn't ask again.

`reloadShell()` refetches all of it, for a human pressing Retry or Reconnect. `plan.session` is marked read in `useLive.apply` before listeners run, so the cache gets the read session. `usePendingPlan` gets every event there too, with or without a conversation mounted.

## Run transcripts

`run.events` carries `offset`, where its first line sits in the transcript (`Transcripts.append` returns it, serialized per run and counted from the spool after a restart). The server appends before it publishes, so a fetch can return lines whose event is still on its way. `addLines` in `dependencies.ts` therefore skips lines the cache holds, appends the rest, and leaves the cache alone when an offset is past the end; that case refetches, as does an event for a transcript with no data, such as one whose first fetch failed. Appending without the check would also mark a stale transcript fresh, because `setQueryData` clears `isInvalidated`.

Events reach the query with or without an observer, so a run you switch away from keeps growing and shows at once when you come back. `useAgentRuns` and `PlanConversation` read the same `runTranscriptQuery`.

## Polling

Pull requests have no event for CI or base branch changes, so `pullRequestsQuery` sets `refetchInterval` to 30 s. TanStack skips the tick while the tab is hidden (`document.visibilityState`, through `focusManager`), and coming back refetches if the data is older than `staleTime`. Other data shouldn't poll.

## Project lists

`useProjectLists(slug)` observes the shared task and epic lists in `tasks.ts` and `epics.ts`. The desktop and mobile shells use `useAllProjectLists` to load every project's lists up front for counts, Home and palette search. Board, Backlog, Overview, Plan and task/epic properties read these same entries; `useLive` no longer stores tasks or epics or loads lists. Lists have the query client's 30-minute cache lifetime, so route changes keep content visible while a stale entry refreshes.

Task events update loaded lists immediately. Drafts are excluded both on fetch and on event writes, since they live only in their plan. Deleting a project empties its cached lists and removes its observers/search entries by deriving those from the current project list.

Board/Backlog and their task/epic flyouts use `defineMutation` for task creation, patching, transitions and deletion, epic patching and epic dependencies. Desktop drag moves use `moveTask` on top of the transition mutation: cancel an older list fetch, optimistically move the single card, then invalidate on success or restore just that card on rejection. A newer event for the card wins over rollback; other cards' live changes are preserved. Drag targets follow D10's existing human actions, and Board filters remain in the URL.

## Rules

- Skeletons depend on `isPending` only. It stays false for a query with data, so background refetches show no loading state. Never use `isFetching` for a skeleton.
- Events carrying a full entity write it into the cache. Derived data (inbox, counts, metrics) is invalidated.
- Nothing reloads by hand: events go through `eventDependencies`, mutations through `defineMutation`.
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

`invalidates` is a list of keys, or a function of the result and variables. It runs only on success, at once rather than through the event queue, and `isPending` lasts until the refetch ends. On failure nothing is invalidated, `mutateAsync` rejects and `error` is set.

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

`markPlanRead` patches unread flags in place and sends a fire-and-forget acknowledgement, without invalidating queries. A `plan.session` echo with the same `updatedAt` keeps the session's list position. Approvals and thread closes use mutations to invalidate Plan and Inbox queries; approval also invalidates task lists. The Inbox page still owns its legacy refresh callbacks until its own migration.
