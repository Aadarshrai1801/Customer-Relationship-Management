# Contacts – Comprehensive Testing Guide

Base URLs: API `http://localhost:3001`, Web `http://localhost:3000`, Mailpit `http://localhost:8025`.

## 1. Overview

This guide covers end-to-end testing for **Contacts** in the CRM: Contact CRUD, lifecycleStage/tags/customFields, duplicate-email warning, required name+email validation, search <500ms, pagination, filtering, detail view, delete/archival behavior, and cross-linking to accounts, deals, activities, notes and timeline.

Scope:

- Create / Read / Update / Delete contacts via UI (`/contacts`, `/contacts/:id`, contact-detail drawer/modal) and API (`/api/contacts` or `/contacts` depending on version – verify via OpenAPI).
- Fields: `firstName`, `lastName` or `name`, `email` (required, unique-with-warning), `phone`, `title`, `accountId`/`company`, `ownerId`, `lifecycleStage` (lead, mql, sql, opportunity, customer, evangelist, other), `tags[]`, `customFields{}`, `source`, `address`, `description/notes`.
- Business rules: `name` + `email` required; invalid email rejected; duplicate email shows inline warning but allows save with confirmation (or blocks per config – confirm expected); search must return <500ms for 10k records; list pagination preserves filters.
- Out of scope: bulk import CSV (covered in imports guide if exists), auth itself, email sending verification except Mailpit check for contact welcome email if enabled.

Success criteria:

- All 25 test cases below pass on Chrome + Firefox.
- No 500s on validation paths; all validation returns 400 with structured error.
- Search p95 <500ms locally with seeded 5000 contacts.
- Persistence verified after refresh + API re-fetch.

## 2. Prerequisites & Test Data Setup

### 2.1 Environment prerequisites

- API running on `http://localhost:3001` – check `GET http://localhost:3001/health` returns 200.
- Web running on `http://localhost:3000` – login succeeds, `/contacts` renders table within 3s.
- DB reset or isolated test workspace/org. Use dedicated test org `qa-contacts-org`.
- Mailpit at `http://localhost:8025` accessible if welcome-email flow enabled.
- Test users:
  - `admin@qa.local / Admin123!` – Admin role (full CRUD).
  - `sales@qa.local / Sales123!` – Sales role (create/edit own + team, no delete).
  - `viewer@qa.local / Viewer123!` – Read-only.
- Browser: Chrome 120+, cleared localStorage. DevTools Network tab open for timing.
- Tools: curl / Postman, `jq`, timer for search latency.

### 2.2 Seed data script (API)

```json
{
  "orgId": "qa-contacts-org",
  "users": [
    { "email": "admin@qa.local", "role": "admin" },
    { "email": "sales@qa.local", "role": "sales" }
  ],
  "accounts": [
    { "name": "Acme Corp", "domain": "acme.com", "industry": "SaaS" },
    { "name": "Globex", "domain": "globex.io", "industry": "Fintech" }
  ]
}
```

Create baseline contacts:

```json
{
  "firstName": "Aarav",
  "lastName": "Sharma",
  "name": "Aarav Sharma",
  "email": "aarav.sharma+tc01@example.com",
  "phone": "+91-9876543210",
  "title": "VP Sales",
  "lifecycleStage": "sql",
  "tags": ["inbound", "enterprise"],
  "customFields": { "linkedin": "https://linkedin.com/in/aarav", "employeeCount": 250 },
  "accountId": "<ACME_ID>",
  "ownerId": "<SALES_USER_ID>",
  "source": "web-to-lead"
}
```

Second contact for duplicate tests:

```json
{
  "name": "Priya Nair",
  "email": "priya.duplicate@example.com",
  "phone": "+1-415-555-0101",
  "lifecycleStage": "lead",
  "tags": ["smb"]
}
```

Bulk seed for performance (run 50x loop or script to reach 2000+):

```json
{
  "name": "Perf Test {{index}}",
  "email": "perf.{{index}}@example.com",
  "lifecycleStage": "lead",
  "tags": ["perf"]
}
```

### 2.3 Cleanup strategy

- Prefix all test emails with `qa-ctc-<timestamp>-` or `+tcNN` to allow bulk delete by search.
- After suite, `DELETE /contacts?email_like=qa-ctc-` or UI bulk delete if available; otherwise delete individually and verify 404.
- Reset lifecycleStage enums if test adds new values (should not).

## 3. Test Environment Matrix

| Dimension    | Variants to Cover                                                                          |
| ------------ | ------------------------------------------------------------------------------------------ |
| Browser      | Chrome 120+ (primary), Firefox 121+, Edge Chromium, Mobile viewport 390px                  |
| Viewport     | Desktop 1440px, Laptop 1280px, Tablet 768px, Mobile 390px                                  |
| Role         | Admin (full), Sales (scoped), Viewer (read-only)                                           |
| Data volume  | 0 contacts (empty), 10 contacts, 2000+ contacts (perf)                                     |
| Network      | Normal, Throttled Fast 3G (search still <2000ms, shows skeleton), Offline (graceful error) |
| API client   | UI, curl, Postman / automated suite                                                        |
| Persistence  | Refresh, logout/login, second browser, direct API GET after UI create                      |
| Search index | Cold (first search after seed), Warm (repeated search)                                     |

Minimum pass matrix: Chrome Desktop Admin + Sales, Firefox Desktop Admin, 10-record + 2000-record datasets.

## 4. Detailed Step-by-Step Test Cases

> Conventions: `UI:` web steps. `API:` curl steps. `Expect:` assertion. Each TC is independent – create its own data unless noted.

### TC-01 – Happy path create via UI

- Steps:
  1. Login as Admin, go to `http://localhost:3000/contacts`.
  2. Click `New Contact` / `+ Add Contact`.
  3. Fill Name=`QA TC01 Arjun Mehta`, Email=`qa-ctc-tc01@example.com`, Phone, Title=`CTO`, Account=`Acme Corp`, lifecycleStage=`SQL`, Tags=`enterprise,inbound`, customField linkedin.
  4. Click Save.
- Expect: Toast `Contact created`, redirect to `/contacts/:id` or contact-detail drawer opens, record appears at top of list, API GET shows same payload.

### TC-02 – Happy path create via API

- Steps: POST JSON below, then GET by id.
- Expect: 201, body contains `id`, `createdAt`, echo of email/name. GET returns 200 identical.

```json
{
  "name": "QA TC02 API Create",
  "email": "qa-ctc-tc02@example.com",
  "lifecycleStage": "mql",
  "tags": ["api"],
  "customFields": { "region": "APAC" }
}
```

### TC-03 – Required validation: missing name

- UI: Leave Name blank, fill valid email, Save.
- API: POST `{"email":"noname@example.com"}`.
- Expect: UI inline error `Name is required` under field, Save disabled or shake; API 400 `{ "error": "name is required", "field": "name" }`, no record created.

### TC-04 – Required validation: missing email

- UI: Fill Name only, Save.
- API: POST `{"name":"No Email Person"}`.
- Expect: UI `Email is required`; API 400 `email is required`. List count unchanged.

### TC-05 – Invalid email format

- Try `not-an-email`, `a@`, `a@b`, `test@@example.com`, `test@example`.
- Expect: UI instant validation on blur `Enter a valid email`; API 400 `invalid email format` for each. No 500.

### TC-06 – Duplicate email warning (core)

- Steps:
  1. Create contact A email `priya.duplicate@example.com` (from setup).
  2. Attempt create contact B same email different name `Priya Clone`.
- Expect: UI shows amber warning banner `A contact with this email already exists: Priya Nair (View)` with options `Cancel / Save anyway / Merge`. If policy is block, shows red error and blocks save – document actual. API: second POST returns either 409 `{code:"DUPLICATE_EMAIL", existingId:"..."}` or 201 with `warning: "duplicate_email"` – assert consistent with spec. Verify no silent overwrite.

### TC-07 – Duplicate email case-insensitivity

- Create `Case.Test@Example.com`, then try `case.test@example.com`.
- Expect: Treated as duplicate (same warning/409). Search for lowercased finds both/one canonical.

### TC-08 – lifecycleStage transitions

- Steps: Create as `lead`, edit to `mql` → `sql` → `opportunity` → `customer`, save each.
- Expect: Each transition persists, timeline/activity logs `lifecycleStage changed from X to Y`, dropdown shows all 6+ stages, invalid value via API (`lifecycleStage: "foobar"`) returns 400 `invalid lifecycleStage`.

### TC-09 – Tags add / remove / persistence

- UI: On detail, add tags `vip`, `q4-target` via tag input (Enter/comma), remove `smb` via x, Save, refresh.
- API: PATCH `{"tags":["vip","enterprise"]}` then GET.
- Expect: Tags render as pills, refresh persists, API returns exact array, empty array allowed, duplicate tags deduped, >20 tags either allowed or capped with message (note behavior).

### TC-10 – customFields round-trip

- UI: Fill custom fields (text, number, date, dropdown, URL) if custom-field builder exists; Save; refresh.
- API: PATCH `{"customFields":{"linkedin":"https://linkedin.com/in/x","employeeCount":500,"renewalDate":"2026-12-01"}}`.
- Expect: Values persist, types preserved (number stays number), unknown keys either stored or rejected with 400 – document. UI shows custom section on contact-detail.

### TC-11 – Search happy path <500ms

- Steps: Seed 2000 contacts, go to `/contacts`, type `aarav` in search box, measure Network timing for `GET /contacts?search=aarav`.
- Expect: Results filter to matching rows, highlighted match, response time <500ms warm (<1000ms cold acceptable, note). Clear search restores full list.

### TC-12 – Search edge: partial, case-insensitive, phone, tag

- Queries: `AARAV` (case), `aar` (prefix), `98765` (phone fragment), `enterprise` (tag), `acme.com` (email domain).
- Expect: All return expected hits; no case sensitivity; phone normalized (dashes ignored); empty query returns paginated all; gibberish `zzz-no-match-123` shows empty state `No contacts found` with `Clear search` button.

### TC-13 – Filter + sort combination

- Steps: Filter `lifecycleStage=customer`, Tag=`enterprise`, Owner=`sales@qa.local`, Sort `Created Newest`, `Name A-Z`.
- Expect: URL query params update (`?lifecycleStage=customer&tag=enterprise&sort=-createdAt`), refresh preserves filters, API with same params returns same order, count badge correct.

### TC-14 – Pagination persistence

- Steps: Set page size 20, go to page 3, open contact, Back, refresh page 3.
- Expect: Page 3 persists via URL (`?page=3&limit=20`), total count shown `Showing 41-60 of 2,341`, next/prev disabled correctly at bounds, API `?page=3&limit=20` returns `total`, `page`, `data[20]`.

### TC-15 – Update contact (happy + concurrent)

- UI: Edit `phone` + `title`, Save, verify toast `Contact updated`.
- API: PATCH new title, GET verifies.
- Concurrency: Open same contact in two tabs, save Tab1 then Tab2 – expect last-write-wins with toast or 409 version conflict if ETag/versioning enabled (document).

### TC-16 – Delete / archive flow

- Steps: As Admin, open contact-detail → `...` → Delete, confirm modal `Type DELETE or click Confirm`, verify redirect to `/contacts` + toast.
- Expect: Record removed from list, direct GET by id returns 404, search no longer finds it. If soft-delete, verify `?includeDeleted=true` or admin trash shows it with Restore.

### TC-17 – Permissions: Sales cannot delete, Viewer read-only

- Login as Sales: Verify Delete button hidden/disabled; direct API DELETE returns 403.
- Login as Viewer: `New Contact` hidden, inputs disabled, PATCH returns 403 `forbidden`.
- Expect: No privilege escalation via API; UI hides affordances; 403 body structured.

### TC-18 – Negative: malformed id, non-existent id

- API: `GET /contacts/invalid-id-!!!`, `GET /contacts/00000000-0000-0000-0000-000000000000`, `PATCH` same, `DELETE` same.
- Expect: 400 for malformed (`invalid id`), 404 for well-formed non-existent (`contact not found`). UI visiting `/contacts/<bad-id>` shows `Contact not found` page with `Back to contacts`, not blank crash.

### TC-19 – Edge: extremely long values, XSS, unicode

- Payload: name 300 chars, email 254 chars, tags with emoji, name `<script>alert(1)</script>`, phone `+1 (415) 555-0101 ext. 99`.
- Expect: Long name either truncated with message or 400 `maxLength`; XSS rendered as plain text (no execution, check DOM escaped); unicode/emoji preserved; phone stored normalized but displayed formatted.

### TC-20 – Persistence across refresh / logout / second session

- Steps: Create `qa-ctc-persist@example.com` via UI, refresh, logout/login as same user, fetch via API, login as different admin and view.
- Expect: Record visible in all sessions, fields identical, `createdAt/updatedAt` sensible (UTC ISO), owner preserved.

### TC-21 – Account linking / unlinking

- Steps: Create contact without account, then link to `Globex` via account picker, Save, then unlink.
- Expect: Contact-detail shows account name with link to `/accounts/:id`, account-detail shows contact in related list, unlink clears `accountId` (API null), no orphan error.

### TC-22 – Owner assignment & reassignment

- Steps: Create with Owner=Sales, reassign to Admin, filter `Owner=Admin` finds it.
- Expect: Owner avatar/initials update, API `ownerId` changes, activity log `owner changed`, unassigned (`ownerId:null`) allowed if spec permits.

### TC-23 – Bulk operations (if supported) + validation soak

- Steps: Select 5 checkboxes → Bulk tag `bulk-qa`, Bulk change lifecycleStage, Bulk delete 2.
- API soak: POST 10 rapid creates with unique emails – all 201, no race duplicate false positive.
- Expect: Bulk toast `5 contacts updated`, list refreshes, failures reported per-row if any.

### TC-24 – Export / list count consistency (regression)

- Steps: Note list total, export CSV if button exists, compare API `GET /contacts?limit=1` total vs UI count vs export row count.
- Expect: Counts match; export contains name,email,stage,tags; no deleted contacts in export.

### TC-25 – Accessibility & responsive smoke

- Steps: Keyboard-only: Tab to `New Contact`, fill via keyboard, Enter to save. Check focus trap in modal. Resize to 390px.
- Expect: All fields reachable, focus visible, modal Esc closes, mobile table becomes cards or horizontal scroll without overlap, no console errors.

## 5. API Testing Section

### 5.1 Endpoint table

| Method | Endpoint                                                                | Auth           | Purpose                            | Expected success                   |
| ------ | ----------------------------------------------------------------------- | -------------- | ---------------------------------- | ---------------------------------- |
| GET    | `http://localhost:3001/contacts`                                        | Bearer         | List with search/filter/pagination | 200 `{data[], total, page, limit}` |
| GET    | `http://localhost:3001/contacts?search=aarav&page=1&limit=20`           | Bearer         | Search                             | 200 filtered, <500ms               |
| GET    | `http://localhost:3001/contacts/:id`                                    | Bearer         | Get one                            | 200 or 404                         |
| POST   | `http://localhost:3001/contacts`                                        | Bearer         | Create                             | 201 `{id,...}` or 400/409          |
| PATCH  | `http://localhost:3001/contacts/:id`                                    | Bearer         | Update                             | 200 or 400/404/403                 |
| PUT    | `http://localhost:3001/contacts/:id`                                    | Bearer         | Full replace (if supported)        | 200 or 405                         |
| DELETE | `http://localhost:3001/contacts/:id`                                    | Bearer (admin) | Delete                             | 200/204 or 403/404                 |
| GET    | `http://localhost:3001/contacts?lifecycleStage=customer&tag=enterprise` | Bearer         | Filter                             | 200 filtered                       |
| GET    | `http://localhost:3001/contacts?accountId=<id>`                         | Bearer         | By account                         | 200                                |

> If API is namespaced under `/api/contacts`, substitute prefix. Verify via `GET http://localhost:3001/openapi.json` or `/docs`.

### 5.2 curl examples

Set base + token:

```bash
API=http://localhost:3001
TOKEN=<PASTE_JWT>
HDR="Authorization: Bearer $TOKEN"
```

**1. Create – happy (expect 201):**

```bash
curl -s -X POST "$API/contacts" -H "$HDR" -H "Content-Type: application/json" -d '{"name":"QA Curl Create","email":"qa-ctc-curl01@example.com","lifecycleStage":"lead","tags":["curl"],"phone":"+1-415-555-0199"}' | jq .
# Expected: 201 {"id":"...","name":"QA Curl Create","email":"qa-ctc-curl01@example.com","createdAt":"..."}
```

**2. Create – missing email (expect 400):**

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$API/contacts" -H "$HDR" -H "Content-Type: application/json" -d '{"name":"No Email"}'
# Expected: 400 {"error":"email is required"} and body mentions field=email
```

**3. Duplicate email (expect 409 or 201+warning – confirm):**

```bash
curl -s -X POST "$API/contacts" -H "$HDR" -H "Content-Type: application/json" -d '{"name":"Dup A","email":"dup-check@example.com"}' | jq .
curl -s -w "\nHTTP:%{http_code}\n" -X POST "$API/contacts" -H "$HDR" -H "Content-Type: application/json" -d '{"name":"Dup B","email":"dup-check@example.com"}'
# Expected second: 409 {"code":"DUPLICATE_EMAIL","existingId":"..."} OR 201 with warning. No 500.
```

**4. Search + timing (expect 200 <500ms):**

```bash
time curl -s "$API/contacts?search=aarav&limit=5" -H "$HDR" | jq '{total, count: (.data|length)}'
curl -s "$API/contacts?search=AARAV&limit=2" -H "$HDR" | jq .
# Expected: 200, total>=1, case-insensitive. Wall time <0.5s warm.
```

**5. Update lifecycle + tags (expect 200 then GET match):**

```bash
ID=<CONTACT_ID>
curl -s -X PATCH "$API/contacts/$ID" -H "$HDR" -H "Content-Type: application/json" -d '{"lifecycleStage":"customer","tags":["vip","enterprise"],"customFields":{"renewalDate":"2026-12-01"}}' | jq .
curl -s "$API/contacts/$ID" -H "$HDR" | jq '{lifecycleStage, tags, customFields}'
# Expected: 200 both, second shows customer/vip persisted.
```

**6. Delete + verify 404 (expect 200/204 then 404):**

```bash
ID=<CONTACT_ID_TO_DELETE>
curl -s -w "\nHTTP:%{http_code}\n" -X DELETE "$API/contacts/$ID" -H "$HDR"
curl -s -w "\nHTTP:%{http_code}\n" "$API/contacts/$ID" -H "$HDR"
# Expected: first 200/204, second 404 {"error":"contact not found"}.
```

**7. Permission – viewer forbidden (expect 403):**

```bash
VIEWER_TOKEN=<VIEWER_JWT>
curl -s -w "\nHTTP:%{http_code}\n" -X POST "$API/contacts" -H "Authorization: Bearer $VIEWER_TOKEN" -H "Content-Type: application/json" -d '{"name":"X","email":"x-forbid@example.com"}'
# Expected: 403 {"error":"forbidden"}.
```

## 6. UI Testing Section

### 6.1 Routes & navigation

- `/contacts` – table/cards, search input at top, filters (Stage, Tag, Owner), `New Contact` button top-right, pagination footer, count `Showing X–Y of Z`.
- `/contacts/:id` or modal `contact-detail` – header with avatar, name, email (mailto: link), phone (tel: link), lifecycleStage badge color-coded, tags pills, account link, owner, timeline/notes/activities tabs, Edit/Delete in `...` menu.
- Deep link: paste `/contacts/<id>` in new tab – loads without first visiting list.
- Back button: detail → Back returns to prior list page/filters (not page 1 reset).

### 6.2 Form checks

- Required asterisks on Name, Email. Blur validation. Disabled Save until valid OR Save shows errors on click (note which).
- Email field `type=email`, duplicate warning appears on blur if email exists (debounced lookup). Confirm warning style (amber) vs error (red).
- Phone auto-format, Tags autocomplete from existing tags, lifecycleStage select with descriptions, customFields render per type (date picker, number stepper).
- Cancel discards with `Discard changes?` confirm if dirty; Esc same.

### 6.3 List checks

- Column sorting (Name, Created, Stage) toggles asc/desc, arrow indicator.
- Row click opens detail; checkbox selects without opening; bulk bar appears.
- Empty search shows illustration + `Create contact "xyz"` shortcut.
- Loading skeleton on throttle; error banner with Retry on API 500 simulation (stop API briefly).
- Search debounce ~300ms; typing fast does not fire 10 requests (check Network – 1-2 calls).

### 6.4 Visual / responsive

- Desktop 1440px: table full width, no truncation of email beyond ellipsis with tooltip.
- 390px: cards stack, search + New button remain visible, detail tabs scroll horizontally.
- Dark/light theme if supported – badges still contrastive.
- Console: zero errors on happy path; warnings only for deprecated props acceptable.

## 7. Regression & Cross-Feature Impact

- **Accounts:** Linking contact to account must update account's `contactsCount` and related list; deleting account must either null `accountId` or block if contacts exist (verify spec) – test both.
- **Deals/Pipeline:** Contact with open deals cannot be hard-deleted without warning `This contact has 2 open deals` – confirm modal lists deals.
- **Activities/Timeline:** Create/update/tag/owner changes emit timeline entries; verify in activity-timeline guide.
- **Notes/Comments:** Notes on contact-detail persist and appear in timeline; deleting contact cascades or orphans notes? – verify no orphan 500 on timeline fetch.
- **Search global:** Global command-palette search finds new contact within 5s (index lag noted).
- **Workflows/Automation:** If workflow `on contact created → send email`, check Mailpit `http://localhost:8025` receives email; lifecycle `→ customer` may trigger sequence enrollment – verify no duplicate enroll.
- **Permissions/Roles:** Role change mid-session (admin demotes sales) immediately hides Delete without refresh or after refresh – document.
- **Reports/Dashboards:** Contacts-by-stage report increments after TC-08 transitions; export counts match.

## 8. Expected Results Summary Table

| TC    | Title                      | Expected status / UI                          | Must-pass |
| ----- | -------------------------- | --------------------------------------------- | --------- |
| TC-01 | UI create happy            | Toast + detail + list top                     | Yes       |
| TC-02 | API create happy           | 201 + GET 200                                 | Yes       |
| TC-03 | Missing name               | Inline + 400                                  | Yes       |
| TC-04 | Missing email              | Inline + 400                                  | Yes       |
| TC-05 | Invalid email              | Inline + 400, no 500                          | Yes       |
| TC-06 | Duplicate warning          | Warning or 409, no silent overwrite           | Yes       |
| TC-07 | Duplicate case-insensitive | Same as TC-06                                 | Yes       |
| TC-08 | lifecycleStage             | All transitions persist, invalid 400          | Yes       |
| TC-09 | Tags                       | Pills persist, deduped                        | Yes       |
| TC-10 | customFields               | Round-trip typed                              | Yes       |
| TC-11 | Search <500ms              | Filtered <500ms warm                          | Yes       |
| TC-12 | Search edges               | Case/phone/tag/domain                         | Yes       |
| TC-13 | Filter+sort                | URL persists, order correct                   | No        |
| TC-14 | Pagination                 | URL page, counts correct                      | Yes       |
| TC-15 | Update + concurrent        | Toast + 200, last-win or 409                  | No        |
| TC-16 | Delete/archive             | Redirect + 404 on GET                         | Yes       |
| TC-17 | Permissions                | Delete hidden, 403 via API                    | Yes       |
| TC-18 | Bad IDs                    | 400 malformed, 404 missing; UI not-found page | Yes       |
| TC-19 | Long/XSS/unicode           | Escaped, no exec, length handled              | Yes       |
| TC-20 | Persistence                | Visible after refresh/relogin/API             | Yes       |
| TC-21 | Account link               | Bidirectional linkage                         | Yes       |
| TC-22 | Owner                      | Reassign + filter                             | No        |
| TC-23 | Bulk + soak                | Bulk toast, 10 rapid 201s                     | No        |
| TC-24 | Export/count               | Counts match                                  | No        |
| TC-25 | A11y/responsive            | Keyboard + mobile pass                        | No        |

## 9. Troubleshooting & Common Failures

- **409 vs 201 on duplicate:** Spec ambiguity. Check backend `contacts.service` – if unique index, expect 409; if warning-only, expect 201 + `duplicateWarning:true`. Record actual and update TC-06 expectation. Do not treat either as fail if documented.
- **Search >500ms:** Likely missing index on `email/name` or cold DB. Check API logs, add `EXPLAIN`, warm with repeat query, test with `limit=20` not `limit=1000`. If using LIKE `%term%` without trigram index, note as perf bug.
- **400 returns 500:** Validation not caught – check DTO (`IsEmail()`, `IsNotEmpty()`), global exception filter. Repro with curl TC-03/04, attach stack trace.
- **Tags not persisting:** Often PATCH overwrites vs merges. Check if API expects full array (must send full) vs `addTags`. UI may send stale array – inspect Network payload.
- **lifecycleStage invalid passes:** Enum not validated – API returns 201 with garbage stage, UI badge breaks (grey). File bug, expect 400.
- **Contact-detail blank on direct URL:** Missing `useEffect` dep on `id` or auth guard redirect. Check console `Cannot read properties of undefined`, verify `GET /contacts/:id` actually fired.
- **Delete still searchable:** Soft-delete not filtered in search query. Check `where: {deletedAt: IsNull()}` missing. Verify trash/restore behavior.
- **Mailpit no email:** Workflow disabled in test org or queue not running (Redis). Check `http://localhost:8025` API `GET http://localhost:8025/api/v1/messages`, check worker logs.
- **Flaky pagination total:** Count query ignores filters – UI shows `of 2000` while filtered to 5. Compare `total` with/without filters.
- **CORS on localhost:3000 → :3001:** If curl works but UI 403/CORS, check `CORS origin http://localhost:3000` in API config.

## 10. Pass/Fail Checklist

- [ ] TC-01–TC-07 (CRUD + validation + duplicate) pass on Admin/Chrome.
- [ ] TC-08–TC-10 (stage/tags/customFields) persist after refresh + API GET.
- [ ] TC-11 search p95 <500ms warm (attach Network screenshot + `time curl` output).
- [ ] TC-12–TC-14 filters/sort/pagination URL-persist and API totals match.
- [ ] TC-15–TC-16 update/delete show toasts, GET after delete = 404.
- [ ] TC-17 viewer/sales 403 verified via UI + direct curl (no bypass).
- [ ] TC-18 bad IDs return 400/404, UI shows not-found (not crash).
- [ ] TC-19 XSS payload rendered escaped, long input handled, unicode preserved.
- [ ] TC-20 record visible after refresh, relogin, second user, API.
- [ ] TC-21–TC-22 account link + owner reassign bidirectional.
- [ ] API section: all 7 curl groups executed, status codes logged.
- [ ] UI section: routes, form, list, responsive 390px, zero console errors.
- [ ] Regression: account counts, deals warning, timeline entries, Mailpit (if enabled) checked.
- [ ] Cleanup: `qa-ctc-*` test contacts deleted, counts restored, no leftover `dup-check@example.com`.
- [ ] Evidence attached: screenshots (create toast, duplicate warning, search timing), HAR or curl logs, browser matrix table.

> Sign-off: Tester __________ Date __________ Build/commit __________ Result PASS / FAIL (circle) with linked defects __________.
