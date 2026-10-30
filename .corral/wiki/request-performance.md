# Request performance samples

The API timing middleware in `apps/server/src/performance.ts` measures handler time with the monotonic clock and sets `Server-Timing: total;dur=<milliseconds>` on all API responses, including errors, health and SSE handshakes. This measures response preparation, not body transfer or the lifetime of a stream.

Ordinary requests enqueue one `api` sample with the same duration, HTTP status and registered route pattern. Unknown routes use `/api/*`; raw paths and query strings are never persisted or logged by this middleware. Health, SSE responses and WebSocket upgrades are excluded from samples and slow warnings. The runner WebSocket lives outside `/api`.

`CORRAL_SLOW_REQUEST_MS` sets the slow-warning threshold (default 500 ms; nonnegative finite numbers accepted, invalid values fall back to 500). A request strictly above the threshold emits one warning containing method, pattern, status and duration.

One service-owned recorder flushes asynchronously every second, inserting batches of at most 1,000 samples. Requests never await database writes. Failed batches are logged and discarded so diagnostics do not retry indefinitely during an outage. Shutdown stops the timers and flushes pending samples before closing the database. A separate timer runs every minute and deletes all sample kinds older than seven days. The additive `perf_samples` migration includes an index on `(kind, created_at)` for later metrics queries.
