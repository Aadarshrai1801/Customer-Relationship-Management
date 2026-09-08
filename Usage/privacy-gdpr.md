# Privacy & GDPR – Comprehensive Testing Guide

## 1. Overview (what feature does, where in UI/API, related files)

Nexus CRM Privacy/GDPR covers export request/ready/download (user data portability), redaction/deletion (right to erasure), consent tracking, and 72h SLA for export readiness with Mailpit notification.

**What it does:**

- User requests export via `POST /privacy/export` -> job queues -> status `pending` -> `ready` within 72h (typically minutes) -> `GET /privacy/export/:id/download` ZIP/JSON with profile, deals, contacts, files manifest, audit subset.
- Admin manages all requests `GET /privacy/exports`, approves/denies, triggers redaction `POST /privacy/redact/:userId {reason}` which anonymizes PII (name->Redacted, email->redacted+id@deleted.local).
- Tracks consent `POST /privacy/consent {marketing:true}` with timestamp.
- Enforces 72h SLA badge + overdue alert; notifies via Mailpit when ready.

**Where in UI:**

- Web `http://localhost:3000/settings/privacy` or `/profile/privacy` – Request Export button, status list (pending/ready/expired), Download, Delete/Redact request, Consent toggles.
- Web `http://localhost:3000/admin/privacy` – admin queue, Approve/Download-as-admin, Redact button with confirm + reason.
- Mailpit ready mail with download link.

**Where in API:**

- `POST /privacy/export`, `GET /privacy/exports`, `GET /privacy/export/:id`, `GET /privacy/export/:id/download`
- `POST /privacy/redact/:userId`, `POST /privacy/consent`, `GET /privacy/consent`
- `GET /privacy/sla` (overdue list, admin)

**Related files:**

- `api/src/privacy/privacy.controller.ts`, `privacy.service.ts`, `export.job.ts`, `redact.service.ts`
- `api/src/users/users.service.ts` (anonymize), `api/src/mail/*` (ready mail)
- `web/src/app/settings/privacy/page.tsx`, `components/ExportStatus.tsx`
- PRD: GDPR, Export, Redaction, 72h SLA.

## 2. Prerequisites & Test Data Setup (infra:up, db:migrate, users/roles, .env keys)

**Infra:**

```bash
docker compose -f infra/docker-compose.yml up -d postgres redis mailpit queue
npm run db:migrate
npm run dev:api
npm run dev:worker  # export job processor must run!
npm run dev:web
```

Without worker, exports stay pending – verify `docker ps` worker/redis.

**.env:**

- `EXPORT_SLA_HOURS=72`, `EXPORT_TTL_DAYS=7`, `EXPORT_STORAGE=local|s3`, `EXPORT_MAX_SIZE_MB=100`
- `SMTP_HOST=localhost SMTP_PORT=1025`, `WEB_URL=http://localhost:3000`
- `REDACTED_EMAIL_DOMAIN=deleted.local`

**Users:**

- Requester `gdpr.user@example.com / Password123!` with deals/contacts/files + audit history.
- Admin `admin@example.com / Password123!`.
- Member `member@example.com` control (cannot see others’ exports).
- Clean: `DELETE FROM privacy_exports WHERE user_id='<gdprId>'`; ensure Mailpit empty.

**Data:**

- Create 2 deals, 2 contacts, 1 note/file owned by gdpr.user so export non-empty.
- Record `created_at` of request to verify SLA `readyAt - requestedAt <=72h`.

## 3. Test Environment Matrix (roles x browsers, API via curl, mailpit, DB checks)

| Role          | Chrome               | Firefox | API curl     | Mailpit ready | DB            |
| ------------- | -------------------- | ------- | ------------ | ------------- | ------------- |
| Requester own | Yes request/download | Yes     | 200 own only | Ready mail    | exports row   |
| Admin all     | Yes queue + redact   | Smoke   | 200 all      | –             | redacted user |
| Other member  | No access others     | –       | 403 others   | –             | –             |
| Anonymous     | Redirect             | –       | 401          | –             | –             |
| Expired link  | Error page           | –       | 410          | –             | expired       |

**API:** separate jars. **Mailpit:** `http://localhost:8025` to gdpr.user. **DB:** `SELECT * FROM privacy_exports`; `SELECT name,email FROM users`.

## 4. Detailed Step-by-Step Test Cases (numbered TC-01, TC-02... at least 20 cases covering: happy path, validation, edge cases, negative, permissions/RBAC, persistence/reload, concurrency, audit side-effects)

**TC-01 – Request export happy path:**

- Login `gdpr.user@example.com`, go `/settings/privacy`, click Request Export, confirm.
- Expected: 202/201 `{id,status:pending}`, UI row pending with requested time, DB row created.

**TC-02 – Export becomes ready (SLA):**

- Wait worker (seconds-minutes), poll `GET /privacy/export/:id` or reload page.
- Expected: Status ready, Mailpit mail “Your export is ready” with link `.../privacy/export/:id/download`, `readyAt - requestedAt` <<72h.

**TC-03 – Download happy path:**

- Click Download or `GET /privacy/export/:id/download`.
- Expected: 200 ZIP/JSON (per spec), contains `profile.json` (name/email), `deals.json` (2 deals), `contacts.json`, `files-manifest`, `audit.json`. File opens, JSON valid.

**TC-04 – Download content accuracy:**

- Compare export JSON to `GET /users/me`, `GET /deals?owner=me`.
- Expected: All owned records present, no others’ records, sensitive hashes (password) absent.

**TC-05 – Second request while pending:**

- Click Request again before first ready.
- Expected: 409 “Already pending” or returns existing id (document). Single pending row, no duplicate job.

**TC-06 – Redaction happy path (admin):**

- As admin `POST /privacy/redact/<gdprUserId> {reason:GDPR erasure verified}` with confirm modal.
- Expected: 200 `{redacted:true}`, DB user `name=Redacted`, `email=redacted_<id>@deleted.local`, deals reassigned/anonymized per rule, login now fails (email changed). UI shows Redacted badge.

**TC-07 – Redacted user cannot login with old email:**

- Try `POST /auth/login {gdpr.user@example.com/Password123!}`.
- Expected: 401. Verify new redacted email also cannot login if account deactivated (per spec – document).

**TC-08 – Export after redaction:**

- Request export for redacted user (or admin download prior export).
- Expected: PII already redacted in new export; old export file (if TTL) still contains pre-redaction? Document retention – old file should expire/purge.

**TC-09 – Consent update:**

- `POST /privacy/consent {marketing:false, analytics:true}` then `GET /privacy/consent`.
- Expected: 200 stored with timestamp, UI toggles reflect, reload persists.

**TC-10 – Validation – double redact:**

- Redact already redacted user.
- Expected: 410/400 “Already redacted”. No further change.

**TC-11 – Validation – redact reason required:**

- `POST /privacy/redact/:id {}` no reason.
- Expected: 400 “reason required”. No redact.

**TC-12 – RBAC – member cannot download others’ export:**

- As `member@example.com`, `GET /privacy/export/<gdprId>` / download.
- Expected: 403. UI list shows only own.

**TC-13 – RBAC – member cannot redact:**

- As member `POST /privacy/redact/<id>`.
- Expected: 403, DB unchanged. UI no Redact button.

**TC-14 – RBAC – admin can list all but requester cannot list all:**

- As admin `GET /privacy/exports` sees all; as gdpr.user sees only own.
- Expected: Scoped correctly.

**TC-15 – SLA – overdue detection:**

- Manipulate one export `requested_at = NOW()-80h, status=pending`, then `GET /privacy/sla` as admin.
- Expected: Flagged overdue, UI red badge + alert, audit `export.sla_breach` if implemented.

**TC-16 – Expiry – download after TTL:**

- Set export `expires_at` past (or wait TTL 7d simulated), try download.
- Expected: 410 “Expired, request new”, UI shows Expired with Re-request button.

**TC-17 – Persistence/reload:**

- Request, reload page, logout/login – status persists and updates pending->ready without duplicate request.
- Expected: Stable.

**TC-18 – Concurrency – double request race:**

- Two parallel `POST /privacy/export` same user.
- Expected: One 201 one 409/200 same id, single pending job, no duplicate files.

**TC-19 – Audit – export/redact/consent logged:**

- After request/ready/download/redact, `GET /audit-logs?entity=privacy`.
- Expected: `privacy.export_requested/ready/downloaded`, `privacy.redacted`, `privacy.consent_updated` with actor/IP.

**TC-20 – No secret leak in export:**

- Inspect export for `password_hash`, `twoFactorSecret`, `sso clientSecret`, tokens.
- Expected: Absent/masked. Only safe PII + owned business data.

**TC-21 – Large export (many deals/files):**

- Create 50 deals for user, request export.
- Expected: Still ready within SLA, size < cap, download works (or paged/multiple files). No timeout.

**TC-22 – Empty data export:**

- Fresh user with no deals, request export.
- Expected: Ready with empty arrays, not error, download valid JSON.

**TC-23 – Worker down handling:**

- Stop worker, request export, verify stays pending with “Processing, check back” UI, restart worker -> becomes ready.
- Expected: No lost job, retry works.

**TC-24 – Empty/loading/error UI:**

- Request button spinner, Slow 3G status skeleton, API down banner with Retry.
- Expected: Proper states, no double request.

## 5. API Testing Section (endpoint table + at least 5 curl examples with expected status/body)

| Method | Path                         | Auth        | Success           | Errors                          |
| ------ | ---------------------------- | ----------- | ----------------- | ------------------------------- |
| POST   | /privacy/export              | user        | 201 pending       | 409 already pending             |
| GET    | /privacy/exports             | scoped      | 200 own/admin all | 401                             |
| GET    | /privacy/export/:id          | owner/admin | 200 status        | 403 other, 404                  |
| GET    | /privacy/export/:id/download | owner/admin | 200 file          | 403, 410 expired, 409 not ready |
| POST   | /privacy/redact/:userId      | admin       | 200 redacted      | 400 no reason, 403 member       |
| POST   | /privacy/consent             | user        | 200               | 400 bad                         |
| GET    | /privacy/sla                 | admin       | 200 overdue       | 403                             |

**Curl 1 – Request + Status:**

```bash
curl -i -b gdpr_cookies.txt -X POST http://localhost:3001/privacy/export
# Expected: 201 {"id":"...","status":"pending","requestedAt":"..."}
curl -i -b gdpr_cookies.txt http://localhost:3001/privacy/export/<ID>
# Expected pending then after worker: 200 {"status":"ready","readyAt":"...","expiresAt":"..."}
```

**Curl 2 – Download:**

```bash
curl -i -b gdpr_cookies.txt http://localhost:3001/privacy/export/<ID>/download -o export.zip
# Expected when ready: 200 Content-Type application/zip; when pending: 409 {"message":"Not ready"}
# When expired: 410
curl -i -b member_cookies.txt http://localhost:3001/privacy/export/<ID>/download
# Expected: 403
```

**Curl 3 – Redact:**

```bash
curl -i -b admin_cookies.txt -X POST http://localhost:3001/privacy/redact/<GDPR_USER_ID> \
 -H "Content-Type: application/json" -d '{"reason":"GDPR erasure verified ticket #123"}'
# Expected: 200 {"redacted":true,"email":"redacted_...@deleted.local"}
curl -i -b member_cookies.txt -X POST http://localhost:3001/privacy/redact/<ID> -H "Content-Type: application/json" -d '{"reason":"x"}'
# Expected: 403
```

**Curl 4 – Consent:**

```bash
curl -i -b gdpr_cookies.txt -X POST http://localhost:3001/privacy/consent \
 -H "Content-Type: application/json" -d '{"marketing":false,"analytics":true}'
# Expected: 200 {"marketing":false,"updatedAt":"..."}
curl -i -b gdpr_cookies.txt http://localhost:3001/privacy/consent
# Expected: 200 same
```

**Curl 5 – SLA (admin):**

```bash
curl -i -b admin_cookies.txt http://localhost:3001/privacy/sla
# Expected: 200 {"overdue":[],"slaHours":72}
```

## 6. UI Testing Section (navigation path, assertions, empty/loading/error states, responsive, dark mode, keyboard/a11y)

**Navigation:** `/settings/privacy` -> Request Export -> pending row (spinner, requested time, SLA “Ready within 72h”) -> ready (Download button, expiry date) -> Download saves file. Consent toggles save instantly with toast. Admin `/admin/privacy` -> queue table + Redact (confirm + reason) -> badge Redacted.
**Assertions:** Status badges colors (amber pending, green ready, grey expired), Mailpit link matches download, expiry countdown, redact confirm requires reason + typed confirm if destructive.
**Empty:** No exports shows “No exports yet, request one” + button. No overdue shows “All within SLA”.
**Loading:** Button spinner prevents double, status polls (no manual refresh needed) or Refresh button.
**Error:** Pending too long (>72h) shows overdue warning + support link; expired shows Re-request; API down banner.
**Responsive:** 375px table->cards, Download full-width, toggles reachable.
**Dark mode:** Badges/status readable, modal contrast.
**Keyboard/a11y:** Request/Download focusable, status aria-live (“Export ready”), redact modal focus trap + Esc, consent switches labelled with state.

## 7. Regression & Cross-Feature Impact

- Users: redacted user hidden/anonymized in team list, deals reassigned – verify team + deals suites still pass (no orphan crash).
- Auth: redacted cannot login – verify; export download requires auth (no public link).
- Audit: export/redact events logged; redaction itself may create audit (actor admin) – verify not redacted away.
- Files: export includes manifest but not necessarily binary – verify per spec (links vs embedded).
- SSO/2FA secrets never in export – verify.
- Restoring test user after redact (recreate `gdpr.user@example.com`) to avoid polluting other suites.

## 8. Expected Results Summary Table

| TC    | Desc               | Expected           |
| ----- | ------------------ | ------------------ |
| TC-01 | Request            | 201 pending        |
| TC-02 | Ready SLA          | ready + mail <72h  |
| TC-03 | Download           | 200 valid ZIP/JSON |
| TC-04 | Content            | own only, complete |
| TC-05 | Double pending     | 409/single         |
| TC-06 | Redact             | anonymized         |
| TC-07 | Old login fail     | 401                |
| TC-08 | Post-redact export | redacted           |
| TC-09 | Consent            | persisted          |
| TC-10 | Double redact      | 410/400            |
| TC-11 | No reason          | 400                |
| TC-12 | Other download     | 403                |
| TC-13 | Member redact      | 403                |
| TC-14 | Scoped list        | own vs all         |
| TC-15 | Overdue flag       | red badge          |
| TC-16 | Expired 410        | re-request         |
| TC-17 | Persist            | stable             |
| TC-18 | Race               | single             |
| TC-19 | Audit              | logged             |
| TC-20 | No secrets         | absent             |
| TC-21 | Large              | within SLA         |
| TC-22 | Empty data         | empty arrays       |
| TC-23 | Worker retry       | recovers           |
| TC-24 | Loading            | proper             |

## 9. Troubleshooting & Common Failures

- **Stuck pending:** Worker not running / Redis down – `docker ps`, `npm run dev:worker`, check queue `bull` dashboard, retry job.
- **No Mailpit ready mail:** SMTP misconfig, worker sent but template fails – check worker logs, Mailpit search correct address.
- **Download 409 not ready:** Poll, don’t assume instant – wait 30-60s, check `status` endpoint.
- **Download 403 as owner:** Wrong jar (member vs gdpr), id typo – use owner cookies, verify `user_id` matches.
- **Redact 400 no reason:** UI allows empty – require reason input, trim whitespace.
- **Redact bricks tests:** Recreate user after: `POST /users {email:gdpr.user@example.com...}` + deals.
- **Export leaks others’ deals:** Query missing `where owner_id` – fix, retest TC-04.
- **Secrets in export:** Serializer includes all columns – explicitly pick allowlist, retest TC-20.
- **SLA false overdue:** Timezone `requested_at` local vs UTC – store UTC, compute `EXTRACT EPOCH`.
- **ZIP corrupt:** Streaming interrupted / size cap – check `EXPORT_MAX_SIZE_MB`, download via curl `-o` binary not text.

## 10. Pass/Fail Checklist (checkbox list)

- [ ] Request 201 pending (TC-01)
- [ ] Ready <72h + Mailpit (TC-02)
- [ ] Download valid contains owned (TC-03/04)
- [ ] Double pending 409/single (TC-05)
- [ ] Redact anonymizes (TC-06)
- [ ] Old login 401 (TC-07)
- [ ] Post-redact export redacted (TC-08)
- [ ] Consent persisted (TC-09)
- [ ] Double redact blocked (TC-10)
- [ ] Reason required (TC-11)
- [ ] Other download 403 (TC-12)
- [ ] Member redact 403 (TC-13)
- [ ] Scoped list (TC-14)
- [ ] Overdue flagged (TC-15)
- [ ] Expired 410 + re-request (TC-16)
- [ ] Persist reload (TC-17)
- [ ] Race single (TC-18)
- [ ] Audit logged (TC-19)
- [ ] No secrets (TC-20)
- [ ] Large within SLA (TC-21)
- [ ] Empty data ok (TC-22)
- [ ] Worker retry (TC-23)
- [ ] Loading states (TC-24)
- [ ] Curls pass, responsive/dark/a11y pass
- [ ] Test user restored after redact
