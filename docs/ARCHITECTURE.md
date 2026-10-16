# Architecture

Small interfaces, everything tricky behind them.

## Core (`packages/core`, zero dependencies)

| Module | What you call | What it hides |
|---|---|---|
| `crypto.js` | `generateValue`, `encrypt`, `decrypt`, `makeLocalName`, `importKey` | Date-derived AES key, fixed IV, CBC/padding/base64. WebCrypto only, so browsers and Node share it |
| `errors.js` | `PortalError`, `SessionExpiredError`, `CaptchaError`, `toPortalError` | The portal's `{status:{responseStatus,errors}}` shape |
| `session.js` | `createStore`, `memoryAdapter`, `browserLocalAdapter`, `isExpired` | JWT expiry checks, `juet.portal.*` key names |
| `client.js` | `createClient` gives `{post, postRaw, getPublic}` | AES bodies, `Authorization` + `LocalName` headers, 401 mapping. `postRaw`/`getPublic` exist because some endpoints take plain JSON or no auth headers |
| `auth.js` | `fetchCaptcha`, `login` | The two-step login, single-use `random`, parent `P` prefix |
| `features.js` | `getAttendance*` (+`fetchSubjectAttendance`/`getSubjectAttendanceAll`), `getMarks*`, `getExam*`, `getGrade*`, `getSgpa*`, `getChoice*`, `getFacultyRegistrations`/`getFaculties` | Endpoint paths and payload shapes (read-only views, no payments) |

Tests inject the clock, random source, storage, and fetch, so nothing touches the network.

### Session recovery

`client.js`: `authenticated → recovering → authenticated|expired`. Concurrent 401s
share one refresh attempt; a late 401 reuses a token that attempt already renewed.
A 90-second guard aborts stuck refresh/captcha/login work before publishing
`expired`. The portal's HTTP 200 `Failure` session-expired payload follows the
same path as HTTP 401.

## Web (`packages/web`)

Wiring only. No crypto, no endpoint strings, no storage wiping.

```
lib/portal.ts       # client + store singletons
lib/installPrompt.js # browser install-event lifecycle + 14-day dismissal policy
hooks/useInstallPrompt.ts # React subscription to the shared install controller
components/InstallBanner.tsx # floating card + inline browser-specific guidance
hooks/useSession.ts # restore session on boot, logout
hooks/useFeature.ts # fetch + error + retry + 401 handling for sections
hooks/useSemester.ts # persisted semester pick (defaults to first row)
components/DataViews.tsx # tables, key/value lists, shared error line
sections/           # one file per dashboard section + index.ts registry
pages/LoginPage.tsx # captcha, login once, save session
pages/DashboardPage.tsx # header, anchor nav, registry render (skips enabled:false)
```

Grades/CGPA ship disabled (`enabled: false` in `sections/index.ts`: the new portal
returns 500/empty even officially). New reads: check `main.*.js` for the
`dataService.post("/xxx",…)` call and whether the call site encrypts — one
function in `features.js` with a mocked-client test, then a section file plus one
registry line. UI never imports `crypto`.

## Proxy (`api/`)

| Module | What you call | What it hides |
|---|---|---|
| `proxy.js` | Vercel handler for `/api/:path*` | Origin/Referer spoofing, StudentPortalAPI path confinement, GET/HEAD/POST method allow-list, hop-by-hop header stripping, `rejectUnauthorized:false` scoped to the portal host, cookie relay, backpressure-aware response streaming, shared HTTPS idle pool, disconnect cancellation, timeout/502 mapping |
| `shared/cors.js` | `corsHeaders`, `preflightHeaders` | The only origin allowed cross-origin: the Capacitor shell's origin (`WEBVIEW_ORIGIN` ↔ `server.url`, a test asserts the sync). Browser builds are same-origin and need none of it |

Performance design and Fluid validation: [PERFORMANCE.md](PERFORMANCE.md).

## Native shell (`android/`)

Capacitor wraps the same web bundle; `lib/apiBase.js` is the only place that
knows the shell must call the hosted proxy by absolute URL instead of `/api`.
Details in `docs/ANDROID.md`.

## Portal bundle

To read an endpoint: open `https://studentportal.juet.ac.in/studentportal/`, find
the `main.*.js` script URL in page source, download it, and grep. The class
timetable does not exist there, only the exam-schedule endpoint.
