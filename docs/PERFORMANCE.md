# Portal compute performance / Vercel Fluid Compute

Portal calls invoke `api/proxy.js` — the server-side CPU/memory hot path. The web
build is static; client scheduling in `lib/portalSchedule.ts` keeps request volume down.

## Design

- Responses relay with `pipeline` + backpressure, so memory is bounded by stream
  buffers rather than response size. `config.supportsResponseStreaming: true`
  stops the Vercel Node adapter from buffering the streamed response again.
- POST bodies stay Buffers with an exact `Content-Length` (the portal rejects
  chunked requests); single-chunk bodies need no extra copy. Inbound bodies are
  capped at 512 KiB → HTTP 413 (`PayloadTooLargeError`), excess bytes drained
  without destroying the socket.
- One keep-alive HTTPS agent shared across warm/concurrent invocations: ≤8 idle
  sockets per origin, ≤5s idle retention (the upstream's keep-alive hint may
  shorten it). Active connections are uncapped, so no request queue is created.
- A browser disconnect aborts the upstream work; the handler's cancellation
  listeners are removed on completion. The header-filter Set and portal hostname
  live at module scope.
- Portal day cuts over at 02:00 AM IST; tab resume after rollover dispatches
  `juet:refresh-attendance`. The daily manual refresh quota is not consumed when
  attendance comes back unchanged; 20s refresh throttles are per-screen; subject
  sheet deep-fetches are skipped when row checksums (`doesSubjectNeedDeepFetch`)
  say the cached detail is still complete (including across day rollovers and pure-lab rows).
- Skip per-component attendance detail POST requests when held count is 0 (`L`/`T`/`P`).
- Isolate `att.subject` hooks from global `juet:refresh-attendance` broadcasts and
  multiplex `subscribePortalDayRollover` across a single shared timer.
- In-memory read-through cache for `getCached`/`setCached` and `session.store.load()`,
  plus per-minute memoization for IST date formatting in `@juet/core` crypto.
- Deliberately unchanged: API paths/methods, auth headers, Origin/Referer
  spoofing, cookie relay, CORS, 45s upstream inactivity timeout, 60s function
  limit, login retries. In-flight dedup in core is transient only (`.finally`)
  — no shared cache of student responses across requests or sessions.

Failure semantics: portal fails before headers → the existing bounded 502 JSON;
fails mid-stream → terminate the response, never append error JSON to partial data.

## Benchmark

```sh
mkdir -p scratch
git show 44fc3a386c3bb0b4fe69e2cd33ab9bc1ab27f9f7:api/proxy.js > scratch/proxy-before.mjs
npm run bench:proxy                          # current handler, mocked HTTPS
npm run bench:proxy -- scratch/proxy-before.mjs # original handler
```

No network, credentials, or real student data. Mocks emit fresh 16 KiB chunks,
requests overlap, downstream bytes are discarded. Defaults: 16 concurrent 2 MiB
responses, eight rounds, 256 MiB transferred after warm-up; `PROXY_BENCH_CONCURRENCY`,
`PROXY_BENCH_BYTES`, `PROXY_BENCH_ROUNDS` override. Use separate processes and
several runs; timings and memory peaks vary with GC and host. `npm test` covers
backpressure, byte preservation, headers/cookies, pool config, failures, timeout,
and disconnect/upload cancellation with real Node streams.

2026-10-09, Node 22.22.3, medians of three runs per handler:

| Measurement | Original | Streaming |
|---|---:|---:|
| Process CPU time | 717.09 ms | 211.10 ms |
| Elapsed relay time | 582.34 ms | 155.86 ms |
| Sampled peak RSS | 209.86 MiB | 95.04 MiB |
| Sampled peak JS heap | 37.06 MiB | 8.27 MiB |

This stress test isolates relay work: not portal latency, TLS handshakes,
Vercel adapter/ETag overhead, typical payload sizes, or bill savings. For small
responses, stream setup can offset the CPU savings — benchmark representative
sizes too.

## Fluid validation

Provisioned memory depends on configured memory and instance lifetime, not the
Node RSS above; a smaller heap alone does not imply proportional GB-h savings.
Function memory allocation is unchanged on purpose — don't lower it without
production measurements. After deploying, compare similar traffic windows for:
1. Fluid active CPU per request, provisioned memory usage, invocation count.
2. Latency and 502/connection-error rate, especially during portal outages.
3. Actual peak memory under realistic concurrency before shrinking the allocation.

Request-volume reductions are product decisions first, compute metrics second.
