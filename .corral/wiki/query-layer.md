# Query layer

Server data in `apps/web` is moving to TanStack Query, in `app/queries/`. `app/plugins/query.client.ts` installs the client (`client.ts`) and connects it to `useLive`'s stream, real or mock, so the prototype works the same way. Pages not yet migrated still use `useLive` state; the two run side by side.

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

`live.ts` queues event invalidations and flushes once events pause for `QUIET_MS` (300 ms), or after `MAX_WAIT_MS` (2 s) of constant traffic. Each flush fetches a query once, however many keys cover it. So a burst with no pause over 300 ms is one refetch; a pause longer than that starts a second. Derived data can lag events by up to `QUIET_MS` when idle.

On SSE reconnect, everything is invalidated and active queries refetch. Inactive ones refetch when next shown.

## Tests

`mountWithQuery` in `mount-with-query.ts` mounts a component with a `QueryClient`.
