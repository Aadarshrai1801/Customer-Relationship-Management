# API Platform – Comprehensive Testing Guide

Base URLs: API `http://localhost:3001`, Web `http://localhost:3000`.

## 1. Overview

This guide covers Versioned REST, Rate-limit headers + client interceptor, Health endpoint, Queue workers (imports/AI/email), and Multi-tenant isolation.
It is the platform contract all features rely on: URL versioning (`/api/v1` vs `/api` – pin actual), consistent envelope (`{data, meta, error}`), JWT auth, pagination/sorting/filtering conventions, rate limiting (`429 + Retry-After + X-RateLimit-*` + frontend interceptor with backoff/queue), health/readiness (`/api/health`), background jobs (imports, AI enrichment, email sends with retries/DLQ), and tenant scoping (`orgId` on every row + cross-org 403/404).
Out of scope is feature logic (per-guide), but platform behaviors cutting across (auth, limits, isolation) are proven here with curl + worker log evidence.
Key roles: anonymous (health + auth only), member (own org), billing-admin (billing scope), org-admin (all in org), cross-org user (must be isolated).
Critical rules: breaking changes versioned (old version still works or sunset header); limits return headers + JSON `code=rate_limited` and UI backs off (no tight retry loop); health reflects DB/queue depth; workers exactly-once-ish with idempotency keys + visible states; no query without tenant filter ever returns foreign rows.
Success criteria: version matrix green, limiter + interceptor proven, health truthful under fault injection, workers drain with retries, and cross-org access always 403/404 with no leak.

## 2. Prerequisites & Test Data Setup

- Services: API `:3001`, Web `:3000`, DB (Postgres/Mongo – record engine + version), queue (BullMQ/Bee/PG – record + dashboard URL), Redis if used, mail catcher, storage backend.
- Orgs/users: `ORG-A` (admin-a, member-a) + `ORG-B` (admin-b); cross tokens `$TOKEN_A`, `$TOKEN_B`; record `orgId`s + a shared-shape record ID from each org (deal-a, deal-b).
- Tooling: `curl`, `python3`, `k6` or `node --test` for burst (or bash loop), `gh` not needed; clocks synced.
- Baseline: `GET /api/health` green, queue empty (`GET /api/admin/queue/stats` if exposed, else worker logs), rate-limit config values from env (`RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX` – record).
- Fault kit: ability to stop DB / fill queue / revoke JWT / use expired token; webhook catcher for worker side-effects.
- Cleanup: purge QA burst records/jobs; reset limiter (restart or wait window); never leave DLQ full on shared env.

## 3. Test Environment Matrix

| Dimension  | Variants                                                                        |
| ---------- | ------------------------------------------------------------------------------- |
| Version    | `/api` (default) vs `/api/v1` (pin supported) + `Accept-Version` header if used |
| Auth       | None, Valid JWT, Expired, Malformed, Cross-org, Revoked                         |
| Pagination | `page/limit` vs `cursor` (pin), limit 1/20/100/1000 (cap)                       |
| Rate       | Under limit, Burst 2×, Sustained, Retry-After honored                           |
| Health     | Healthy, DB down, Queue deep, Degraded                                          |
| Worker job | Import CSV, AI enrich, Email send (each success/fail/retry)                     |
| Tenant     | Same-org, Cross-org read/write/list, No-org header (if required)                |
| Client     | curl, Web interceptor (throttled Network), Automated suite                      |

- Record: API version string (`X-API-Version`), `requestId`s, limit headers, job IDs, org IDs.
- Run limiter tests on isolated route/user to avoid locking shared testers.

## 4. Detailed Step-by-Step Test Cases (at least 18 numbered TC cases)

### TC-01 – Version Discovery + Default Stability

- **Objective:** Pin version contract.
- **Preconditions:** Anonymous + authed.
- **Steps:**
  1. `GET http://localhost:3001/api/health` → 200 with `{version, apiVersion}` – record.
  2. `GET /api/v1/health` (if versioned) → same or documented redirect.
  3. Send `Accept: application/json; version=1` (if supported) → honored or ignored-documented.
  4. Request unknown `/api/v99/deals` → 404 `unknown_version` (not 500).
- **Expected:** Documented version(s); unknown → 404.

### TC-02 – Envelope Consistency (data/meta/error)

- **Objective:** Verify every endpoint shares shape.
- **Preconditions:** Valid token.
- **Steps:**
  1. `GET /api/deals?limit=1` → `{data:[], meta:{total,page,limit}}`.
  2. `GET /api/deals/NOPE` → `404 {error:{code,message,requestId}}`.
  3. `POST /api/deals` invalid → `400 {error:{code, fields[]}}`.
  4. Verify `requestId` present on success + error (header `X-Request-Id` matches body).
- **Expected:** Uniform envelope; requestId everywhere.

### TC-03 – Auth: Missing/Expired/Malformed JWT

- **Objective:** Verify 401 matrix.
- **Preconditions:** Expired token crafted (or wait) + garbage.
- **Steps:**
  1. No header → 401 `missing_token`.
  2. `Bearer garbage` → 401 `invalid_token`.
  3. Expired → 401 `expired` with `WWW-Authenticate: Bearer`.
  4. Valid → 200.
- **Expected:** Distinct codes; no 500; no data on 401.

### TC-04 – Pagination Cap + Stable Sort

- **Objective:** Verify `limit` capped and paging deterministic.
- **Preconditions:** 50 deals.
- **Steps:**
  1. `?limit=1000` → capped (e.g., 100) with `meta.truncated=true` or `limit=100` echo – document.
  2. Page 1+2 (`limit=10`) → no overlap/gap (IDs disjoint, total consistent).
  3. `?sort=-createdAt` stable across pages (record sort param name).
- **Expected:** Capped; disjoint pages; documented params.

### TC-05 – Rate-Limit Headers Present

- **Objective:** Verify limiter advertises quota.
- **Preconditions:** Authed burst route (e.g., `GET /api/deals?limit=1`).
- **Steps:**
  1. Single call; inspect `X-RateLimit-Limit`, `-Remaining`, `-Reset` (or `RateLimit-*` – document actual).
  2. Verify `Reset` is future epoch/seconds and `Remaining` decrements across 3 rapid calls.
- **Expected:** Headers present + decrementing.

### TC-06 – Burst Over Limit → 429 + Retry-After (curl)

- **Objective:** Prove throttling with backoff signal.
- **Preconditions:** Known limit (e.g., 60/min on test route/user).
- **Steps:**
  1. Loop 2× limit rapidly (bash `for i in $(seq 1 120)`).
  2. Verify tail returns `429 {error:{code:rate_limited}}` + `Retry-After: <s>` + limit headers `Remaining: 0`.
  3. Wait window; verify 200 again.
- **Expected:** 429 with JSON code + header; recovery after window.

### TC-07 – Frontend Interceptor Backs Off (No Tight Loop)

- **Objective:** Verify Web client respects 429.
- **Preconditions:** Web throttled to trigger 429 (or mock 429 via proxy for `/api/deals`).
- **Steps:**
  1. Force next `GET /api/deals` → 429 `Retry-After: 2`.
  2. In UI open Deals; verify banner `Too many requests – retrying in 2s` + spinner (not error crash).
  3. Verify Network shows ONE retry after ~2s (not 10 rapid), then success.
- **Expected:** Single delayed retry; user informed. Inspect `src/api/interceptor` for logic – cite file:line.

### TC-08 – Health Healthy Shape

- **Objective:** Verify green payload.
- **Preconditions:** All up.
- **Steps:**
  1. `GET /api/health` → 200 `{status:ok, version, uptime, checks:{db:up, queue:up, storage:up}}`.
  2. Verify `<200ms` locally and `Content-Type: application/json`.
- **Expected:** Structured green.

### TC-09 – Health Degraded When DB Down

- **Objective:** Verify truthful degraded (not false-green).
- **Preconditions:** Ability to pause DB (or block host via firewall rule on staging).
- **Steps:**
  1. Stop DB; `GET /api/health` → `503 {status:degraded, checks:{db:down}}` within 5s.
  2. Verify Web shows banner `Service degraded – retrying` (not blank).
  3. Restart DB; verify green again.
- **Expected:** 503 + banner; auto-recover. Skip on shared prod – use staging only.

### TC-10 – Import Worker (CSV 500 rows) Success Path

- **Objective:** Verify async import job lifecycle.
- **Preconditions:** `contacts-500.csv` fixture; queue empty.
- **Steps:**
  1. `POST /api/imports` with file → `202 {jobId, status:queued}`.
  2. Poll `GET /api/imports/:jobId` → `queued → running → succeeded` with `imported:500, failed:0`.
  3. Verify 500 contacts listed + report counts +1 batch.
- **Expected:** Async with progress; exactly 500.

### TC-11 – Import Worker Partial Failure + Error CSV

- **Objective:** Verify row-level errors don't abort all.
- **Preconditions:** CSV with 5 bad rows (missing email).
- **Steps:**
  1. Upload; verify `succeeded with failed:5`, `errorCsvUrl` present.
  2. Download error CSV; verify 5 rows + `error` column.
  3. Retry after fix; verify success.
- **Expected:** Partial success + actionable errors.

### TC-12 – AI Worker (Enrichment) Queued + Retry

- **Objective:** Verify AI jobs async with backoff.
- **Preconditions:** Deal/contact eligible for enrich (per spec) + AI stub/key configured.
- **Steps:**
  1. Trigger enrich → `202 {jobId:ai-…}`.
  2. Verify `running → succeeded` with `enrichedFields` (or `failed` with `willRetry:true` if provider down – document).
  3. Force provider 500 (bad key); verify 3 retries with backoff then `failed` + DLQ entry, no crash.
- **Expected:** Visible retries; DLQ inspectable. If no AI, N/A with code pointer.

### TC-13 – Email Worker ( Mention Digest) Delivers + Retries

- **Objective:** Verify email jobs durable.
- **Preconditions:** Mail catcher; mention trigger.
- **Steps:**
  1. Trigger mention email; verify job `queued → sent` + Mailhog message.
  2. Stop SMTP; trigger again; verify `retrying` with attempts count.
  3. Restart SMTP; verify flush + delivered (or manual retry – document).
- **Expected:** No silent loss; attempts logged.

### TC-14 – Job Idempotency (Double-Submit Same Key)

- **Objective:** Verify duplicate POST doesn't double-import/double-email.
- **Preconditions:** Idempotency-Key support (check docs; if absent file gap).
- **Steps:**
  1. `POST /api/imports` twice with same `Idempotency-Key: qa-123` → second returns same `jobId` (not new).
  2. Verify single job ran, single side-effect batch.
- **Expected:** Same key → same job. Document if unsupported.

### TC-15 – Tenant Isolation: Cross-Org Read 404/403

- **Objective:** Verify A cannot read B's deal.
- **Preconditions:** `deal-b` ID from ORG-B, token A.
- **Steps:**
  1. `GET /api/deals/DEAL_B_ID` with `$TOKEN_A` → 403 or 404 per spec (record – 404 preferred to avoid ID oracle).
  2. Verify body has no B fields (no `amount` leak in error).
- **Expected:** No data; consistent code.

### TC-16 – Tenant Isolation: Cross-Org Write Blocked + List Scoped

- **Objective:** Verify writes + lists scoped.
- **Preconditions:** Same IDs/tokens.
- **Steps:**
  1. `PATCH /api/deals/DEAL_B_ID` as A → 403/404, verify B unchanged (`GET` as B same).
  2. `GET /api/deals?limit=100` as A → zero IDs equal B's (programmatic diff).
  3. `GET /api/contacts` same check.
- **Expected:** Writes blocked; lists disjoint.

### TC-17 – Tenant Isolation: Search/Webhook/Export Scoped

- **Objective:** Verify secondary paths scoped.
- **Preconditions:** Tokens A/B.
- **Steps:**
  1. `GET /api/search?q=<B-only name>` as A → no B hits.
  2. `GET /api/reports/forecast` as A lacks B amounts (sum check).
  3. Inbound webhook URL-A with B record ID → 404, no cross-write.
- **Expected:** All scoped; sums reconcile per-org.

### TC-18 – CORS + Security Headers

- **Objective:** Verify browser-safe headers.
- **Preconditions:** Anonymous curl with `Origin`.
- **Steps:**
  1. `curl -H "Origin: http://localhost:3000" -I /api/health` → `Access-Control-Allow-Origin: http://localhost:3000` (not `*` with credentials – document).
  2. Verify `Helmet` headers: `X-Content-Type-Options: nosniff`, `X-Frame-Options`, `Content-Security-Policy` present on Web at least.
- **Expected:** Scoped CORS; hardening headers.

### TC-19 – Graceful Shutdown / Backpressure Note (Docs)

- **Objective:** Verify overload sheds gracefully.
- **Preconditions:** Burst 200 rapid + queue deep.
- **Steps:**
  1. Burst; verify API stays responsive (p95 <1s for health) with `429` on hot routes, never `502`/crash.
  2. Verify queue dashboard shows depth + workers drain after burst.
  3. Documentconcurrency (`WORKER_CONCURRENCY`) + DLQ policy found.
- **Expected:** Shed via 429/queue, not collapse.

## 5. API Testing Section

| Method & Endpoint                           | Purpose                          | Auth            | Notes                                 |
| ------------------------------------------- | -------------------------------- | --------------- | ------------------------------------- |
| `GET /api/health`                           | Liveness + deps                  | None            | 200 vs 503 cases                      |
| `GET /api/deals?limit=1`                    | Envelope + limiter headers probe | Bearer          | Check `X-RateLimit-*`, `X-Request-Id` |
| `GET /api/deals/:id`                        | Tenant read gate                 | Bearer (A vs B) | 403/404 cross-org                     |
| `POST /api/imports`                         | Enqueue import worker            | Bearer          | `202 {jobId}` + poll                  |
| `GET /api/imports/:jobId`                   | Job state                        | Bearer          | `queued/running/succeeded/failed`     |
| `POST /api/ai/enrich` or per-record trigger | Enqueue AI                       | Bearer          | `202 + retries` (or N/A)              |
| `GET /api/notifications?limit=1`            | Email worker evidence source     | Bearer          | Correlate job→mail                    |

```bash
# 0) Health (anon) + version pin
curl -i http://localhost:3001/api/health | head -n 30
curl -s http://localhost:3001/api/health | python3 -m json.tool

# 1) Envelope + limiter headers (authed single)
curl -i "http://localhost:3001/api/deals?limit=1" -H "Authorization: Bearer $TOKEN_A" | head -n 30

# 2) Pagination cap probe
curl -s "http://localhost:3001/api/deals?limit=1000" -H "Authorization: Bearer $TOKEN_A" | python3 -c "import json,sys; d=json.load(sys.stdin); print((d.get('meta') or d.get('data') or d))"

# 3) Burst to 429 (isolated route/user; careful on shared env)
for i in $(seq 1 120); do curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:3001/api/deals?limit=1" -H "Authorization: Bearer $TOKEN_A"; done | sort | uniq -c
# Expect mostly 200 then 429s with Retry-After:
curl -i "http://localhost:3001/api/deals?limit=1" -H "Authorization: Bearer $TOKEN_A" | grep -i -E "HTTP|ratelimit|retry-after"

# 4) Cross-org read must not leak (expect 403/404, no amount)
curl -i http://localhost:3001/api/deals/DEAL_B_ID -H "Authorization: Bearer $TOKEN_A" | head -n 30

# 5) Import worker enqueue + poll
curl -s -X POST http://localhost:3001/api/imports -H "Authorization: Bearer $TOKEN_A" -F "file=@/tmp/contacts-500.csv" | python3 -m json.tool
# -> save .jobId as $JOB
curl -s http://localhost:3001/api/imports/$JOB -H "Authorization: Bearer $TOKEN_A" | python3 -m json.tool

# 6) Auth negatives
curl -i http://localhost:3001/api/deals?limit=1 | head -n 5
curl -i "http://localhost:3001/api/deals?limit=1" -H "Authorization: Bearer garbage" | head -n 5
```

- Adapt paths (`/api/v1/...`, `/api/jobs/:id`) to implementation; update file with actuals + cite server source `file:line` for limiter/worker config.
- Assert: `requestId` echo, `limit` cap, `429 code=rate_limited`, cross-org no-leak, job `queued→succeeded` with counts.

## 6. UI Testing Section

- Health banner: header shows `Degraded` (amber) / `Offline` (red) with Retry when `/health` non-OK; recovers green silently.
- Rate UI: list shows `Too many requests – retrying in Ns` inline (not modal), auto-retries once, then offers manual Retry.
- Jobs UI: Imports page shows job rows (file, progress bar %, counts, error-CSV download, Cancel/Retry); AI enrich shows spinner → enriched badge; email status in notification detail (`Sent via worker <jobId>`).
- Tenant UI: org switcher lists only member orgs; direct URL with foreign ID shows `Not found` (not foreign title).
- Responsive/dark: banners/cards legible both themes at 768px; progress bars AA contrast.
- A11y: banners `role=alert`, progress `role=progressbar aria-valuenow`, jobs table headers, axe clean.

## 7. Regression & Cross-Feature Impact

- All features inherit envelope/auth/pagination – a platform break fails every guide; run this file first in CI gate.
- Imports feed Reports/Dashboards/Home counts after worker success (eventual – document lag SLA).
- AI writes must fire Workflows + appear in timelines/audit as `actor: ai-worker`.
- Email worker underpins Notifications digests + Billing receipts + Invite/welcome – single outage fans out (monitor one dashboard).
- Limiter must exempt `health` + login-brute-force uses stricter auth-limiter (document both).
- Tenant filter must be in ORM middleware (not per-route) – new routes auto-scoped (verify via code review pointer).

## 8. Expected Results Summary Table

| TC    | Title                     | Expected                     | Severity |
| ----- | ------------------------- | ---------------------------- | -------- |
| TC-01 | Version pin               | Documented, unknown 404      | Major    |
| TC-02 | Envelope                  | data/meta/error + requestId  | Major    |
| TC-03 | Auth 401s                 | Distinct codes               | Critical |
| TC-04 | Paginate cap              | Capped, disjoint             | Major    |
| TC-05 | Limit headers             | Present + decrement          | Major    |
| TC-06 | 429 burst                 | Code + Retry-After, recovers | Critical |
| TC-07 | Interceptor backoff       | One delayed retry + banner   | Major    |
| TC-08 | Health green              | Structured <200ms            | Major    |
| TC-09 | Health degraded           | 503 + banner, recovers       | Major    |
| TC-10 | Import success            | 500/500 via queue            | Critical |
| TC-11 | Import partial            | failed count + error CSV     | Major    |
| TC-12 | AI queued/retry           | Backoff + DLQ or N/A         | Major    |
| TC-13 | Email durable             | Sent/ retry/ flush           | Major    |
| TC-14 | Idempotency               | Same key same job            | Minor    |
| TC-15 | X-org read                | 403/404 no leak              | Critical |
| TC-16 | X-org write/list          | Blocked + disjoint           | Critical |
| TC-17 | Search/report/hook scoped | Sums/lists per-org           | Critical |
| TC-18 | CORS/headers              | Scoped + hardened            | Major    |
| TC-19 | Backpressure              | 429/queue, no 502            | Major    |

## 9. Troubleshooting & Common Failures

| Symptom                   | Cause                                                   | Fix                                                                     |
| ------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------- |
| No limit headers          | Limiter disabled in dev / wrong route                   | Enable env; check middleware order (limiter before routes); cite config |
| 429 never triggers        | Limit high (e.g., 1000/min) or keyed by IP behind proxy | Lower for test user/route; check `trust proxy`; use authed key          |
| UI tight-loops on 429     | Interceptor retries without delay/jitter                | Add `Retry-After` + exp backoff + max 1 auto-retry; file bug with HAR   |
| Health green with DB down | Shallow check (no SELECT 1)                             | Deepen check (`SELECT 1`, queue ping); expect 503                       |
| Import stuck queued       | Worker offline / Redis down / concurrency 0             | Start worker; check Redis; queue dashboard depth; logs                  |
| Duplicate import on retry | No idempotency key                                      | Add key on filename+hash; dedupe jobId                                  |
| Cross-org 500             | Missing tenant filter throws instead of 404             | Add `where:{id, orgId}`; expect 404; file sec bug if 500 leaks          |
| CORS `*` with creds       | Misconfig                                               | Scope to `http://localhost:3000` (dev) + prod allowlist; no `*`         |
| Version drift             | Web calls `/api` while docs say `/v1`                   | Pin baseURL in one client module; add contract test                     |

- Debug: `X-Request-Id` → API logs → worker/job logs → Mailhog/queue dashboard; `EXPLAIN` for pagination slowness.
- Config pointers: record files for limiter (`middleware/rateLimit`), envelope (`middleware/response`), health (`routes/health`), workers (`workers/*`), tenant scope (`prisma/middleware` or `orgId` guard) with `file:line`.

## 10. Pass/Fail Checklist

- [ ] Version(s) pinned; envelope + requestId uniform; unknown version 404.
- [ ] Auth 401 matrix distinct; pagination capped + disjoint + stable sort.
- [ ] Limiter headers present; burst → 429 + Retry-After + recovery; interceptor single delayed retry with banner (no loop).
- [ ] Health green structured; degraded 503 + banner under DB fault; recovers.
- [ ] Workers: import 500 success, partial + error CSV, AI queued/retry/DLQ (or N/A with pointer), email durable with flush.
- [ ] Idempotency same-key same-job (or gap filed).
- [ ] Tenant: cross-org read/write/list/search/report/hook all scoped with no field leak (diff evidence).
- [ ] CORS scoped; hardening headers present.
- [ ] API curls all captured; UI banners/jobs verified light/dark/768px + axe.
- [ ] Evidence: header dumps, 429 sample, health JSON green/red, job IDs + counts, cross-org diffs, queue depth shots.
- [ ] Env cleaned (queues drained, limiter reset, QA records purged); defects filed with requestIds + org/job IDs.
