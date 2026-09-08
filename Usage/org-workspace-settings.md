# Org & Workspace Settings – Comprehensive Testing Guide

## 1. Overview (what feature does, where in UI/API, related files)

Nexus CRM Org/Workspace Settings controls org identity and defaults: name/slug/plan, timezone/locale/currency, attachment caps, stale-deal threshold, logo, and related enforcement across deals/files/reports.

**What it does:**

- `GET /org/settings` returns current org; `PATCH /org/settings` updates (admin only) with validation.
- Fields: `name`, `slug` (unique, url-safe), `plan` (free/pro/enterprise), `timezone` (IANA), `locale` (en-US...), `currency` (USD/EUR/INR...), `attachmentMaxMB`, `attachmentAllowedTypes`, `staleDealDays` (e.g., 30), `logoUrl`.
- Affects: deal stale badges (`updatedAt > staleDealDays`), file upload caps, currency formatting in deals/reports, dates in timezone, slug in URLs/invites.

**Where in UI:**

- Web `http://localhost:3000/settings/workspace` or `/settings/org` – form sections General, Localization, Limits, Deals. Save + Reset, logo upload.
- Web surfaced: deals list stale highlight, upload component cap hint, currency symbols, dates.

**Where in API:**

- `GET /org/settings`, `PATCH /org/settings`, `GET /org/plan-limits`
- `POST /org/logo` (if separate), `GET /deals?stale=true` (uses threshold)

**Related files:**

- `api/src/org/org.controller.ts`, `org.service.ts`, `org.entity.ts`, `dto/update-org.dto.ts`
- `api/src/deals/stale.service.ts`, `api/src/files/files.service.ts` (cap check)
- `web/src/app/settings/workspace/page.tsx`, `components/Currency.tsx`, `TimezoneSelect.tsx`
- PRD: Workspace, Limits, Stale.

## 2. Prerequisites & Test Data Setup (infra:up, db:migrate, users/roles, .env keys)

**Infra:**

```bash
docker compose -f infra/docker-compose.yml up -d postgres redis mailpit
npm run db:migrate
npm run dev:api
npm run dev:web
```

**.env:**

- `DEFAULT_CURRENCY=USD`, `DEFAULT_TIMEZONE=UTC`, `DEFAULT_LOCALE=en-US`
- `ATTACHMENT_MAX_MB=10`, `STALE_DEAL_DAYS=30`

**Users/roles:**

- Admin `admin@example.com / Password123!` – can edit.
- Member `member@example.com / Password123!` – read-only (verify 403 on PATCH).
- Org baseline: Name=`Nexus Test Org`, Slug=`nexus-test`, Plan=`pro`, Timezone=`UTC`, Locale=`en-US`, Currency=`USD`, Cap=`10MB`, Stale=`30`.

**Data:**

- Deals: one updated 40 days ago (should be stale when threshold 30), one updated today (fresh).
- File 9MB ok, 11MB over cap for threshold test.
- Record baseline: `GET /org/settings` save JSON before edits to restore.

## 3. Test Environment Matrix (roles x browsers, API via curl, mailpit, DB checks)

| Role        | Chrome          | Firefox | API curl           | DB              | UI surface    |
| ----------- | --------------- | ------- | ------------------ | --------------- | ------------- |
| Admin edit  | Yes             | Smoke   | 200 PATCH          | org row updated | form editable |
| Member view | Yes – read-only | –       | 403 PATCH, 200 GET | –               | disabled      |
| Viewer      | Yes – hidden?   | –       | 403                | –               | –             |
| Anonymous   | Redirect        | –       | 401                | –               | –             |

**API:** admin vs member jars. **Mailpit:** n/a (except notify if enabled). **DB:** `SELECT name,slug,plan,timezone,locale,currency,attachment_max_mb,stale_deal_days FROM orgs`.

## 4. Detailed Step-by-Step Test Cases (numbered TC-01, TC-02... at least 20 cases covering: happy path, validation, edge cases, negative, permissions/RBAC, persistence/reload, concurrency, audit side-effects)

**TC-01 – Get settings happy path:**

- As admin `GET /org/settings` or open workspace page.
- Expected: 200 with all fields, form prefilled correctly.

**TC-02 – Update name/slug happy path:**

- `PATCH {name:Nexus Renamed, slug:nexus-renamed}`.
- Expected: 200, UI toast, header/slug reflected, old slug redirects or 404 documented.

**TC-03 – Update localization (timezone/locale/currency):**

- Set `timezone:America/New_York`, `locale:en-US`, `currency:EUR`.
- Expected: 200, deals dates shift, currency €, reload persists.

**TC-04 – Update attachment caps:**

- Set `attachmentMaxMB:5`, `allowedTypes:[pdf,png]`.
- Expected: Upload 6MB now 413/400, .exe rejected. Hint text updates to “Max 5MB”.

**TC-05 – Update stale threshold:**

- Set `staleDealDays:7`. Check deals list: 10-day-old now stale badge, 2-day fresh.
- Expected: `GET /deals?stale=true` count increases, UI highlight.

**TC-06 – Plan change effect:**

- Change `plan:free` vs `pro` (if limits differ, e.g., users cap).
- Expected: Limits endpoint reflects, UI banner if over limit. Document if plan read-only (then 400 on edit).

**TC-07 – Validation – slug format/duplicate:**

- Try `slug:Bad Slug!`, `slug:` empty, duplicate of another org.
- Expected: 400 invalid, 409 duplicate. UI inline.

**TC-08 – Validation – bad timezone/locale/currency:**

- `timezone:Mars/Olympus`, `locale:xx`, `currency:XXX`.
- Expected: 400 with allowed list. No save.

**TC-09 – Validation – caps out of range:**

- `attachmentMaxMB:0`, `-5`, `10000`, `staleDealDays:0`, `3650`.
- Expected: 400 range (e.g., 1-100MB, 1-365 days). Boundary 1 and 100 pass.

**TC-10 – Validation – allowedTypes empty/invalid:**

- `allowedTypes:[]` or `[exe,bat]` dangerous.
- Expected: 400 or sanitized per spec – document.

**TC-11 – RBAC – member PATCH blocked:**

- As member `PATCH /org/settings {name:Hack}`.
- Expected: 403, DB unchanged, UI fields disabled.

**TC-12 – RBAC – viewer settings hidden:**

- As viewer visit `/settings/workspace`.
- Expected: 403 page or redirect, API 403.

**TC-13 – Edge – slug case/trim:**

- Input `  Nexus-Test  ` uppercase/spaces.
- Expected: Normalized to `nexus-test` (lower, trim, dash) or 400 – document actual.

**TC-14 – Edge – currency formatting with decimals:**

- Set currency INR/JPY (0 decimals) vs USD (2). Check deal value 1000 displays ₹1,000 vs ¥1,000.
- Expected: Correct symbols/decimals, reports CSV raw value unchanged.

**TC-15 – Edge – timezone DST:**

- Set `America/New_York`, create deal at DST boundary, verify displayed date correct (not off 1h).
- Expected: Uses IANA with DST, not fixed offset.

**TC-16 – Persistence/reload:**

- Edit, Save, reload page, logout/login, check still saved. Hard refresh deals still stale correctly.
- Expected: DB persisted, no revert.

**TC-17 – Concurrency – two admins edit simultaneously:**

- Admin A sets currency EUR, Admin B sets GBP at same time.
- Expected: Last-write-wins or 409 with etag – no partial merge corruption. Verify single row consistent.

**TC-18 – Audit – settings changes logged:**

- After edits, `GET /audit-logs?entity=org`.
- Expected: old/new diff (e.g., currency USD->EUR) with actor.

**TC-19 – Logo upload (if present):**

- Upload png 200KB ok, 10MB fail, .svg handling per spec.
- Expected: 201 url, UI preview, old replaced.

**TC-20 – Reset to defaults:**

- Click Reset/Discard – unsaved changes revert to last saved, not defaults. If Reset-to-defaults button exists, verify confirm modal.
- Expected: No accidental wipe.

**TC-21 – Cross-feature – upload cap enforced in deals/files:**

- After cap 5MB, try attach 6MB to deal via `POST /files` and UI.
- Expected: Both 413 with “Max 5MB” message.

**TC-22 – Cross-feature – stale affects reports:**

- `GET /reports/stale-deals` count matches threshold 7 vs 30.
- Expected: Report respects current setting without restart.

**TC-23 – Empty/loading/error:**

- Clear name empty submit, Slow 3G save skeleton, API down save error with Retry.
- Expected: Required error, spinner, banner.

## 5. API Testing Section (endpoint table + at least 5 curl examples with expected status/body)

| Method | Path              | Auth         | Success      | Errors                               |
| ------ | ----------------- | ------------ | ------------ | ------------------------------------ |
| GET    | /org/settings     | admin/member | 200          | 401 anon                             |
| PATCH  | /org/settings     | admin        | 200          | 400 validation, 403 member, 409 slug |
| GET    | /org/plan-limits  | admin        | 200 limits   | 401                                  |
| GET    | /deals?stale=true | auth         | 200 filtered | –                                    |

**Curl 1 – Get:**

```bash
curl -i -b admin_cookies.txt http://localhost:3001/org/settings
# Expected: 200 {"name":"Nexus Test Org","slug":"nexus-test","currency":"USD","staleDealDays":30}
```

**Curl 2 – Update happy:**

```bash
curl -i -b admin_cookies.txt -X PATCH http://localhost:3001/org/settings \
 -H "Content-Type: application/json" -d '{"name":"Nexus Renamed","currency":"EUR","timezone":"America/New_York","staleDealDays":7,"attachmentMaxMB":5}'
# Expected: 200 updated JSON
```

**Curl 3 – Validation fail:**

```bash
curl -i -b admin_cookies.txt -X PATCH http://localhost:3001/org/settings \
 -H "Content-Type: application/json" -d '{"slug":"Bad Slug!","currency":"XXX","attachmentMaxMB":0}'
# Expected: 400 {"message":...}
```

**Curl 4 – RBAC:**

```bash
curl -i -b member_cookies.txt -X PATCH http://localhost:3001/org/settings \
 -H "Content-Type: application/json" -d '{"name":"Hack"}'
# Expected: 403
```

**Curl 5 – Stale check:**

```bash
curl -i -b admin_cookies.txt "http://localhost:3001/deals?stale=true"
# Expected: 200 list where updatedAt older than staleDealDays
```

**Curl 6 – Plan limits:**

```bash
curl -i -b admin_cookies.txt http://localhost:3001/org/plan-limits
# Expected: 200 {"plan":"pro","maxUsers":50,"maxStorageMB":...}
```

## 6. UI Testing Section (navigation path, assertions, empty/loading/error states, responsive, dark mode, keyboard/a11y)

**Navigation:** `/settings/workspace` -> sections General (name/slug/plan/logo), Localization (timezone dropdown, locale, currency), Limits (maxMB, types), Deals (stale days). Edit -> Save -> toast “Saved” -> header updates.
**Assertions:** Timezone select searchable, currency preview (e.g., €1,234.00), cap hint under upload, stale badge on deals (amber dot + “Stale 12d”).
**Empty:** Name empty -> required; slug empty -> slug required; types empty -> warning.
**Loading:** Save spinner, disabled while pending, skeleton on first load Slow 3G.
**Error:** API down -> banner + Retry, validation inline red, duplicate slug banner.
**Responsive:** 375px sections stack, dropdowns full-width, Save sticky bottom.
**Dark mode:** Inputs, dropdowns, badges readable.
**Keyboard/a11y:** All inputs labelled, selects keyboard searchable, Save via Enter, errors aria-describedby, focus to first error.

## 7. Regression & Cross-Feature Impact

- Deals: stale logic, currency display, dates timezone – re-run deals suite with new threshold.
- Files: cap/types enforced – re-run file attach tests.
- Reports: currency/timezone/stale reflected – re-run reports.
- Invites: slug change may break invite links with old slug – verify redirect or update WEB_URL.
- Audit: settings edits logged – verify.
- Restoring baseline after tests to avoid polluting other suites (reset to USD/UTC/30/10MB).

## 8. Expected Results Summary Table

| TC    | Desc           | Expected             |
| ----- | -------------- | -------------------- |
| TC-01 | Get            | 200 prefilled        |
| TC-02 | Name/slug      | 200 reflected        |
| TC-03 | Localization   | dates/currency shift |
| TC-04 | Caps           | enforced             |
| TC-05 | Stale          | badges/count change  |
| TC-06 | Plan           | limits reflect       |
| TC-07 | Slug bad/dup   | 400/409              |
| TC-08 | Bad locale     | 400                  |
| TC-09 | Range          | 400, boundaries pass |
| TC-10 | Types          | 400/sanitized        |
| TC-11 | Member 403     | unchanged            |
| TC-12 | Viewer hidden  | 403 page             |
| TC-13 | Normalize      | documented           |
| TC-14 | Decimals       | correct              |
| TC-15 | DST            | correct              |
| TC-16 | Persist        | survives reload      |
| TC-17 | Race           | consistent           |
| TC-18 | Audit diff     | logged               |
| TC-19 | Logo           | preview              |
| TC-20 | Reset          | no wipe              |
| TC-21 | Upload enforce | 413                  |
| TC-22 | Report stale   | matches              |
| TC-23 | Empty/loading  | proper               |

## 9. Troubleshooting & Common Failures

- **PATCH 403 as admin:** Wrong jar, role not admin – check `SELECT role`.
- **Slug duplicate 409 on same value:** Backend treats unchanged as duplicate – send only changed or allow same; workaround restore.
- **Currency not reflected:** Frontend cached – hard reload, check `Intl.NumberFormat` locale param.
- **Stale not updating:** Cron/cache – trigger recompute or reload, check `updatedAt` timezone UTC vs local.
- **Upload still allows over cap:** Frontend-only check – verify backend `files.service` reads fresh org setting, restart if cached.
- **Timezone off 1h:** Using offset not IANA – ensure `America/New_York` not `-05:00`, test DST.
- **Plan change 400 read-only:** Plan via billing only – document, don’t PATCH plan in tests.
- **Settings revert after reload:** PATCH not persisted (missing save) – check Network 200 + DB row.

## 10. Pass/Fail Checklist (checkbox list)

- [ ] Get prefilled (TC-01)
- [ ] Name/slug update (TC-02)
- [ ] Localization reflected (TC-03)
- [ ] Caps enforced (TC-04)
- [ ] Stale badges update (TC-05)
- [ ] Plan limits (TC-06)
- [ ] Slug validation (TC-07)
- [ ] Locale validation (TC-08)
- [ ] Range boundaries (TC-09)
- [ ] Types handling (TC-10)
- [ ] Member 403 (TC-11)
- [ ] Viewer hidden (TC-12)
- [ ] Normalize documented (TC-13)
- [ ] Decimals correct (TC-14)
- [ ] DST correct (TC-15)
- [ ] Persist reload (TC-16)
- [ ] Race consistent (TC-17)
- [ ] Audit diff (TC-18)
- [ ] Logo ok (TC-19)
- [ ] Reset safe (TC-20)
- [ ] Upload cross-check (TC-21)
- [ ] Report stale (TC-22)
- [ ] Empty/loading (TC-23)
- [ ] Curls pass, responsive/dark/a11y pass
- [ ] Baseline restored after tests
