# Audit Logs – Comprehensive Testing Guide

## 1. Overview (what feature does, where in UI/API, related files)

Nexus CRM Audit Logs records who did what, when, from where: actor, action, entity/id, old/new diff, IP, user-agent, timestamp. Retention 12 months with nightly purge job; admin-only view/export.

**What it does:**

- Emits on: auth (login/logout/failed), users (create/role/suspend), roles, org/security/sso changes, deals/contacts CRUD, files, 2FA, GDPR export/redact.
- Stores immutable append-only rows; no edit/delete via API (only purge job deletes >12mo).
- Provides `GET /audit-logs` with filters (actor, action, entity, date range), pagination, export CSV.
- Shows diff old/new JSON for updates.

**Where in UI:**

- Web `http://localhost:3000/settings/audit` or `/admin/audit` – table (time, actor, action, entity, IP), filters, detail drawer (old/new JSON), Export button.
- Web detail: click row -> drawer with UA, IP, diff highlight.

**Where in API:**

- `GET /audit-logs?actor=&action=&entity=&entityId=&from=&to=&page=&limit=`
- `GET /audit-logs/:id`
- `GET /audit-logs/export?format=csv` (admin)
- Internal `audit.service.log()` called by services; `POST` not exposed (403).

**Related files:**

- `api/src/audit/audit.controller.ts`, `audit.service.ts`, `audit.entity.ts`, `audit.interceptor.ts`
- `api/src/jobs/purge-audit.job.ts` (12mo retention cron)
- `web/src/app/settings/audit/page.tsx`, `components/AuditDrawer.tsx`
- PRD: Audit, Retention.

## 2. Prerequisites & Test Data Setup (infra:up, db:migrate, users/roles, .env keys)

**Infra:**

```bash
docker compose -f infra/docker-compose.yml up -d postgres redis mailpit
npm run db:migrate
npm run dev:api
npm run dev:web
```

**.env:**

- `AUDIT_ENABLED=true`, `AUDIT_RETENTION_MONTHS=12`, `AUDIT_PURGE_CRON=0 2 * * *`
- `TRUST_PROXY=true` (to capture real IP behind proxy)

**Users:**

- Admin `admin@example.com / Password123!` – can view/export.
- Member `member@example.com / Password123!` – cannot view (403).
- Actor test: perform actions as `test@example.com / Password123!` to verify attribution.

**Seed actions to generate logs:**

- Login/logout as member, create deal `AuditDeal`, update it, delete it, change role, update org name.
- Old log for purge test: `INSERT INTO audit_logs (actor_id,action,created_at) VALUES (...,'test.old', NOW() - INTERVAL '13 months')`.

**DB:**

```sql
SELECT id,actor_id,action,entity,entity_id,ip,ua,created_at FROM audit_logs ORDER BY created_at DESC LIMIT 20;
```

## 3. Test Environment Matrix (roles x browsers, API via curl, mailpit, DB checks)

| Role         | Chrome             | Firefox | API curl               | DB                       | Export     |
| ------------ | ------------------ | ------- | ---------------------- | ------------------------ | ---------- |
| Admin view   | Yes filters+drawer | Smoke   | 200 list/detail/export | rows                     | CSV ok     |
| Member       | Hidden, 403 page   | –       | 403 list               | –                        | 403 export |
| Anonymous    | Redirect login     | –       | 401                    | –                        | 401        |
| System/purge | –                  | –       | –                      | old deleted, recent kept | –          |

**API:** admin vs member jars, with `X-Forwarded-For` test. **Mailpit:** n/a. **DB:** retention check.

## 4. Detailed Step-by-Step Test Cases (numbered TC-01, TC-02... at least 20 cases covering: happy path, validation, edge cases, negative, permissions/RBAC, persistence/reload, concurrency, audit side-effects)

**TC-01 – List happy path:**

- As admin `GET /audit-logs?page=1&limit=20` or open audit page.
- Expected: 200 paged, table shows recent first, actor email, action, time.

**TC-02 – Filter by actor:**

- `?actor=<memberId>` or UI actor search `member@example.com`.
- Expected: Only that actor’s rows.

**TC-03 – Filter by action/entity:**

- `?action=auth.login_success&entity=user` or `deals` entity.
- Expected: Correct subset; unknown action returns empty, not 400.

**TC-04 – Date range filter:**

- `?from=2026-09-01&to=2026-09-08` and UI date pickers.
- Expected: Rows within inclusive range, timezone UTC consistent.

**TC-05 – Detail shows who/what/old/new/IP/UA:**

- Click most recent deal update row, `GET /audit-logs/:id`.
- Expected: actor id/email, action, entity/id, old `{title:Old}` new `{title:New}`, ip `127.0.0.1`/`::1`, ua contains `Mozilla`, timestamp ISO.

**TC-06 – Login/logout captured:**

- Login as `test@example.com`, logout, check logs.
- Expected: `auth.login_success` + `auth.logout` with same actor, IP/UA present.

**TC-07 – Failed login captured (no password leak):**

- Wrong pw `member@example.com / WrongPass999!`.
- Expected: `auth.login_failed` with actor email (or id null + metadata email), no password/hash in old/new.

**TC-08 – User role change diff:**

- As admin change member role member->manager.
- Expected: `users.role_updated` old `{role:member}` new `{role:manager}`.

**TC-09 – Org/security change diff:**

- Change org currency USD->EUR.
- Expected: `org.updated` diff, actor admin.

**TC-10 – Deal CRUD logged:**

- Create/update/delete `AuditDeal`.
- Expected: Three rows `deals.created/updated/deleted` with entityId = deal id.

**TC-11 – RBAC – member cannot list:**

- As member `GET /audit-logs`.
- Expected: 403, UI hidden/403 page. No data leak via `/:id` guessing (also 403).

**TC-12 – Immutability – no edit/delete via API:**

- Try `PATCH /audit-logs/:id`, `DELETE /audit-logs/:id`, `POST /audit-logs`.
- Expected: 404/405/403 for all. DB row unchanged.

**TC-13 – Pagination:**

- With >20 rows, `?page=2&limit=10`.
- Expected: No duplicates across pages, total correct, UI next/prev works.

**TC-14 – Export CSV:**

- As admin `GET /audit-logs/export?format=csv&from=...`.
- Expected: 200 CSV with header `timestamp,actor,action,entity,entityId,ip,ua`, rows match filters. Member export 403.

**TC-15 – IP/UA accuracy:**

- Login via curl with `-A "TestUA/1.0"` and `-H "X-Forwarded-For: 203.0.113.5"` (if trusted).
- Expected: Stored ip `203.0.113.5` (or at least `127.0.0.1` locally), ua `TestUA/1.0`.

**TC-16 – Retention – old purged, recent kept:**

- Insert 13-mo row, run purge job manually (`npm run job:purge-audit` or `POST /jobs/purge-audit` admin).
- Expected: 13-mo deleted, 11-mo kept, recent kept. `SELECT COUNT(*) WHERE created_at < NOW()-INTERVAL '12 months'` =0 after.

**TC-17 – Purge does not delete boundary (12mo exactly):**

- Insert row exactly 12mo -1day (should keep) and 12mo +1day (should delete), run purge.
- Expected: Correct boundary per `>12mo` (document inclusive/exclusive).

**TC-18 – High-volume logging (concurrency):**

- Fire 20 parallel deal updates, check all 20 logs present, no missing/dup, ordering by timestamp.
- Expected: All present, no crash, total +20.

**TC-19 – No PII leak (passwords/tokens/secrets):**

- After signup/reset/SSO secret create, inspect old/new/metadata.
- Expected: No `password`, `password_hash`, `clientSecret`, `token`, `secret` plaintext. Masked or omitted.

**TC-20 – Persistence/reload:**

- Reload audit page, change filter then back, logout/login – filters/pagination consistent with DB.
- Expected: No phantom rows, counts stable.

**TC-21 – Empty state:**

- Filter `action=nonexistent` or future date range.
- Expected: Empty illustration “No logs match”, not error. Export empty gives header only.

**TC-22 – Performance – large range:**

- Query full year with limit 100.
- Expected: <2s, paged, no timeout. UI shows skeleton then rows.

**TC-23 – Clock/timezone:**

- Verify `created_at` UTC ISO, UI converts to org timezone (e.g., America/New_York) correctly.
- Expected: Same instant, different display per timezone setting.

## 5. API Testing Section (endpoint table + at least 5 curl examples with expected status/body)

| Method       | Path               | Auth  | Success         | Errors               |
| ------------ | ------------------ | ----- | --------------- | -------------------- |
| GET          | /audit-logs        | admin | 200 paged       | 403 member, 401 anon |
| GET          | /audit-logs/:id    | admin | 200 detail      | 403/404              |
| GET          | /audit-logs/export | admin | 200 csv         | 403                  |
| PATCH/DELETE | /audit-logs/:id    | –     | never – 404/403 | –                    |

**Curl 1 – List + Filters:**

```bash
curl -i -b admin_cookies.txt "http://localhost:3001/audit-logs?page=1&limit=5"
# Expected: 200 {"data":[{"action":"auth.login_success","actor":"..."}],"total":...}
curl -i -b admin_cookies.txt "http://localhost:3001/audit-logs?action=auth.login_success&entity=user"
# Expected: 200 filtered
curl -i -b member_cookies.txt http://localhost:3001/audit-logs
# Expected: 403
```

**Curl 2 – Detail:**

```bash
curl -i -b admin_cookies.txt http://localhost:3001/audit-logs/<ID>
# Expected: 200 {"id":"...","actor":{"email":"member@example.com"},"action":"deals.updated","old":{"title":"Old"},"new":{"title":"New"},"ip":"127.0.0.1","ua":"...","createdAt":"..."}
```

**Curl 3 – Generate then verify:**

```bash
curl -i -b admin_cookies.txt -X PATCH http://localhost:3001/org/settings -H "Content-Type: application/json" -d '{"currency":"EUR"}'
curl -i -b admin_cookies.txt "http://localhost:3001/audit-logs?action=org.updated&limit=1"
# Expected: latest shows old USD new EUR
```

**Curl 4 – Export:**

```bash
curl -i -b admin_cookies.txt "http://localhost:3001/audit-logs/export?format=csv&limit=100" -o audit.csv
# Expected: 200 CSV header + rows
curl -i -b member_cookies.txt "http://localhost:3001/audit-logs/export?format=csv"
# Expected: 403
```

**Curl 5 – Immutability:**

```bash
curl -i -b admin_cookies.txt -X DELETE http://localhost:3001/audit-logs/<ID>
# Expected: 404 or 403/405 (not 204)
curl -i -b admin_cookies.txt -X PATCH http://localhost:3001/audit-logs/<ID> -H "Content-Type: application/json" -d '{"action":"hack"}'
# Expected: 404/405, row unchanged
```

**Curl 6 – UA/IP:**

```bash
curl -i -A "TestUA/1.0" -c tmp.txt -X POST http://localhost:3001/auth/login -H "Content-Type: application/json" -d '{"email":"member@example.com","password":"Password123!"}'
# Then as admin check latest auth log contains TestUA/1.0
```

## 6. UI Testing Section (navigation path, assertions, empty/loading/error states, responsive, dark mode, keyboard/a11y)

**Navigation:** `/settings/audit` -> filters (actor search, action dropdown, entity, date from/to, Search/Reset), table sortable by time, pagination, row click drawer with JSON diff (green/red), Export button downloads CSV.
**Assertions:** Times sorted desc, actor shows email not just id, IP/UA in drawer, diff highlights changed keys, total count matches API.
**Empty:** No match shows empty + Clear filters; initial no logs (fresh DB) shows “No activity yet”.
**Loading:** Skeleton rows Slow 3G, Export spinner, drawer skeleton.
**Error:** API down error + Retry, invalid date range inline (“From after To”).
**Responsive:** 375px table -> cards, filters collapse, drawer full-screen, CSV still works.
**Dark mode:** Diff green/red still contrast, JSON readable, badges ok.
**Keyboard/a11y:** Filters labelled, table headers sortable via keyboard, drawer focus trap + Esc, Export focusable, Live announces result count.

## 7. Regression & Cross-Feature Impact

- Every feature’s actions must still emit – after any refactor re-run auth/users/roles/org/deals/GDPR spot checks and verify logs appear.
- Retention purge must not break FKs – verify deals/users still load after old logs deleted.
- Timezone change affects display but not stored UTC – verify.
- Export respects same RBAC/filters as list – no bypass.
- Performance: logging must not slow main request >100ms – spot check Network timings.

## 8. Expected Results Summary Table

| TC    | Desc           | Expected            |
| ----- | -------------- | ------------------- |
| TC-01 | List           | 200 desc paged      |
| TC-02 | Actor filter   | only actor          |
| TC-03 | Action/entity  | subset              |
| TC-04 | Date range     | inclusive           |
| TC-05 | Detail full    | who/what/diff/IP/UA |
| TC-06 | Login/logout   | captured            |
| TC-07 | Failed no leak | captured, no pw     |
| TC-08 | Role diff      | old/new             |
| TC-09 | Org diff       | logged              |
| TC-10 | Deal CRUD      | 3 rows              |
| TC-11 | Member 403     | hidden              |
| TC-12 | Immutable      | 404/403             |
| TC-13 | Pagination     | no dup              |
| TC-14 | Export CSV     | header+rows         |
| TC-15 | IP/UA          | accurate            |
| TC-16 | Purge 13mo     | deleted             |
| TC-17 | Boundary       | documented          |
| TC-18 | 20 parallel    | all present         |
| TC-19 | No secret leak | masked              |
| TC-20 | Persist        | stable              |
| TC-21 | Empty          | illustration        |
| TC-22 | Perf           | <2s                 |
| TC-23 | TZ display     | correct             |

## 9. Troubleshooting & Common Failures

- **No logs after action:** `AUDIT_ENABLED=false` or interceptor not on controller – enable, check `audit.service.log` call, verify DB write.
- **Member can view:** Guard missing `@Roles('admin')` – add, retest 403.
- **IP always 127.0.0.1 behind proxy:** `TRUST_PROXY` false – set true + `X-Forwarded-For`, or accept localhost in dev.
- **UA empty:** Curl without `-A` sends `curl/...` – assert contains, not exact; frontend sends real UA.
- **Old/new null for update:** Service passed no diff – fix to pass `{old,new}`, retest TC-08/09.
- **Purge deletes nothing:** Cron not run locally – trigger manually via script/endpoint, check `created_at` timezone (UTC vs local).
- **Purge deletes too much:** Interval `12 months` vs `365 days` – verify SQL `NOW() - INTERVAL '12 months'`, test boundary.
- **Export empty but list has rows:** Export ignores filters/pagination bug – pass same query params, check limit default.
- **Password in logs:** Serializer logging body – scrub `password`, `newPassword`, `secret`, `token` before log.
- **Performance timeout:** Missing index on `(created_at, action, actor_id)` – add migration, retest.

## 10. Pass/Fail Checklist (checkbox list)

- [ ] List desc paged (TC-01)
- [ ] Actor filter (TC-02)
- [ ] Action/entity filter (TC-03)
- [ ] Date range (TC-04)
- [ ] Detail who/what/diff/IP/UA (TC-05)
- [ ] Login/logout captured (TC-06)
- [ ] Failed no pw leak (TC-07)
- [ ] Role diff (TC-08)
- [ ] Org diff (TC-09)
- [ ] Deal CRUD 3 rows (TC-10)
- [ ] Member 403 (TC-11)
- [ ] Immutable (TC-12)
- [ ] Pagination no dup (TC-13)
- [ ] Export CSV + 403 member (TC-14)
- [ ] IP/UA accurate (TC-15)
- [ ] Purge old deleted recent kept (TC-16)
- [ ] Boundary documented (TC-17)
- [ ] 20 parallel all present (TC-18)
- [ ] No secret leak (TC-19)
- [ ] Persist reload (TC-20)
- [ ] Empty state (TC-21)
- [ ] Perf <2s (TC-22)
- [ ] TZ display (TC-23)
- [ ] Curls pass, responsive/dark/a11y pass
