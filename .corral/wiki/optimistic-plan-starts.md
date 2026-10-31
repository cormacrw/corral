# Starting a Plan thread

The new-session page generates a UUID and seeds `usePendingPlan` before navigating to `/plan/<id>`. The POST runs after navigation; both Send and Grill me pass through `PromptComposer.send`, including uploaded images. The pending entry supplies the conversation and the open-thread list until server data arrives.

`useLive` forwards Plan events into the pending store, even if the conversation has unmounted. Server human messages replace the temporary message; response reconciliation preserves newer live messages and run metadata. Starts reuse their UUID on retry, using the server's existing idempotency contract. The store is memory-only; reloading an accepted session reads the durable server thread at the same URL.

A failed start stays in its thread, labelled Not sent, with Retry and Back to prompt. Back to prompt restores the submitted text, uploaded image references as removable thumbnails, project, runtime and attached task. Images are not uploaded again. Pending/failed starts cannot send follow-up messages or close a server thread that does not yet exist.

Browser checks should delay POST `/api/plan/sessions` and inspect the URL, human bubble, working indicator and navigation thread before releasing the response. Also test a rejected POST, retry with the same UUID, image/task restoration, Grill me and a phone viewport. Use only a local `pnpm dev` instance with `cormacrw/test-app`.

The query cache is seeded alongside the pending entry. The client plugin connects pending starts to that cache, so POST reconciliation is independent of the mounted page. Starting and failed entries still supply the thread; once accepted, the conversation reads the query. Reconciliation keeps both live messages and live plan revisions that beat the POST response. The UUID and restoration payload remain owned by `usePendingPlan`.
