# Leads – Comprehensive Testing Guide

## 1. Overview

This guide covers comprehensive manual and API testing for Lead Management in the CRM.
Leads represent unqualified prospects before conversion to Contact + Account (+ optional Deal).
Scope includes Lead CRUD, status lifecycle, source tracking, UTM attribution capture, notes/timeline, list views, filters, search, pagination, bulk actions, permissions, and audit logging.
Out of scope: Lead conversion (see `lead-conversion.md`), routing automation (see `lead-routing.md`), Web-to-Lead capture (see `web-to-lead.md`), territory matching (see `territories.md`).
Base URLs for all tests:

- API: `http://localhost:3001`
- Web: `http://localhost:3000`
  Key entities:
- Lead: `id, firstName, lastName, email, phone, company, title, status, source, rating, ownerId, utmSource, utmMedium, utmCampaign, utmTerm, utmContent, createdAt, updatedAt`
- Lead Note: `id, leadId, body, createdBy, createdAt`
- Lead Status values: `New, Working, Nurturing, Qualified, Unqualified, Junk`
- Lead Source values: `Web, Web-to-Lead, Referral, Cold Call, Email, Event, Partner, Import, Other`
  Success criteria: all CRUD operations persist correctly, validations block bad data, UTM fields auto-captured and immutable via UI except admin edit, notes append correctly, permissions enforced.

## 2. Prerequisites & Test Data Setup

- Services running: API on `http://localhost:3001/health` returns 200, Web on `http://localhost:3000` loads login.
- Test accounts:
  - Admin: `admin@test.com / Admin123!` (full CRUD, delete, import)
  - Sales Rep A: `rep.a@test.com / Rep123!` (create, edit owned, no delete)
  - Sales Rep B: `rep.b@test.com / Rep123!` (for ownership checks)
  - Read-only: `viewer@test.com / Viewer123!` (read only)
- Database seeded clean or isolated test org. Record baseline lead count: `GET /api/leads/count`.
- Test data to pre-create via API:
  - Lead 1: John Doe, `john.doe@example.com`, company Acme, status New, source Web
  - Lead 2: Priya Sharma, `priya.sharma@example.in`, company Infosys-like test co, status Working, source Referral, with UTM
  - Lead 3: Junk lead for negative tests
- Tools: Postman or curl, browser (Chrome + Firefox), devtools Network tab, DB client for verification.
- Capture auth tokens: login via `POST /api/auth/login` and store `accessToken` for each role.
- Setup JSON payload for baseline lead:

```json
{
  "firstName": "John",
  "lastName": "Doe",
  "email": "john.doe@example.com",
  "phone": "+1-415-555-0100",
  "company": "Acme Corp",
  "title": "VP Sales",
  "status": "New",
  "source": "Web",
  "rating": "Warm",
  "ownerId": "user_rep_a_id",
  "utmSource": "google",
  "utmMedium": "cpc",
  "utmCampaign": "q3_launch",
  "utmTerm": "crm software",
  "utmContent": "ad_variant_a"
}
```

- Second seed with Indian context:

```json
{
  "firstName": "Priya",
  "lastName": "Sharma",
  "email": "priya.sharma@example.in",
  "phone": "+91-98765-43210",
  "company": "Mumbai FinTech Pvt Ltd",
  "title": "Founder",
  "status": "Working",
  "source": "Referral",
  "utmSource": "linkedin",
  "utmMedium": "social",
  "utmCampaign": "founder_outreach"
}
```

- Clean up strategy: delete leads created with `test_` prefix or `autotest-` email domain after run.
- Note attachment test file: small `.txt` 2KB and large 6MB file for limit test.

## 3. Test Environment Matrix

| Dimension   | Variants to Cover                                          |
| ----------- | ---------------------------------------------------------- |
| API Base    | `http://localhost:3001` (local), staging if available      |
| Web Base    | `http://localhost:3000` (local)                            |
| Browsers    | Chrome 126+, Firefox 128+, Edge (smoke)                    |
| Viewports   | Desktop 1920x1080, Laptop 1366x768, Tablet 768x1024        |
| Roles       | Admin, Sales Rep (owner/non-owner), Viewer, No-auth        |
| Data Volume | Single lead, 50 leads pagination, 1000+ import performance |
| Network     | Normal, throttled 3G (loading states), offline retry       |
| Timezone    | UTC, IST (Asia/Kolkata), PST (for createdAt display)       |

- Record environment in test run header: OS, browser version, API commit hash, DB snapshot id.
- Run full matrix at least once per release; smoke (Chrome + Admin + Rep) on every PR.
- Mobile is best-effort; verify list stacks and create form scrolls without overlap.

## 4. Detailed Step-by-Step Test Cases

### TC01 – Create Lead Happy Path (UI)

- Precondition: Logged in as Rep A.
- Steps:
  1. Navigate to `http://localhost:3000/leads`.
  2. Click `New Lead`.
  3. Fill First Name `Aarav`, Last Name `Mehta`, Email `aarav.mehta.test@example.com`, Company `Mehta Labs`, Status `New`, Source `Web`, Phone `+91-98200-12345`.
  4. Click Save.
- Expected: Toast `Lead created`, redirected to `/leads/:id`, record appears in list within 2s, `createdAt` is now, owner = Rep A.

### TC02 – Create Lead Happy Path (API)

- Steps: `POST /api/leads` with valid JSON (see Section 2).
- Expected: `201 Created`, body contains `id`, `status: New`, `ownerId` set, `GET /api/leads/:id` returns same.

### TC03 – Required Field Validation (LastName + Company)

- Steps:
  1. UI: Try save with empty Last Name and empty Company.
  2. API: POST with `{ "firstName": "NoLast", "email": "nolast@test.com" }`.
- Expected: UI inline errors `Last name is required`, `Company is required`, Save disabled or blocked. API `400` with `errors: [{ field: "lastName" }, { field: "company" }]`.

### TC04 – Email Format Validation

- Steps: Create lead with email `not-an-email`, `test@`, `test@@example.com`, and valid `test+alias@example.co.in`.
- Expected: First three rejected (UI inline + API 400 `invalid email`), last accepted. No record persisted for invalid.

### TC05 – Duplicate Email Handling

- Steps:
  1. Create lead `dup@test.com`.
  2. Create second lead same email different case `DUP@test.com`.
- Expected: System either blocks with `409 Conflict - Lead with email already exists` or warns with `Possible duplicate` banner linking to existing. Verify defined behavior and document. No silent duplicate.

### TC06 – Phone Validation Edge Cases

- Steps: Try phone `123`, `+1-abc-1234`, very long 30 digits, valid `+91-98765-43210`, empty (optional).
- Expected: Invalid formats rejected or normalized per spec; empty allowed if field optional. Consistent UI + API.

### TC07 – Status Lifecycle Transitions

- Steps: Move lead New -> Working -> Nurturing -> Qualified -> (Converted). Try invalid jump New -> Qualified directly, and Qualified -> New backwards.
- Expected: Valid forward transitions allowed, invalid jumps either allowed with confirmation or blocked with message. Status history/timeline logs each change with timestamp + actor.

### TC08 – Junk / Unqualified with Reason

- Steps: Set status to `Junk` and `Unqualified`. Check if reason required.
- Expected: Prompt for reason dropdown/text. If skipped, validation error. Reason stored and visible in timeline.

### TC09 – Source Dropdown Integrity

- Steps: Verify all sources render: Web, Web-to-Lead, Referral, Cold Call, Email, Event, Partner, Import, Other. Create one lead per source via API.
- Expected: All persist and filter correctly. `Web-to-Lead` auto-set only via capture endpoint cannot be manually spoofed without permission (or can, document).

### TC10 – UTM Attribution Capture & Immutability

- Steps:
  1. Create lead via API with full UTM set (google/cpc/q3_launch/...).
  2. Open detail UI, verify UTM section shows all five fields.
  3. Try editing UTM via UI as Rep; try PATCH via API.
- Expected: UTM persisted exactly. UI shows read-only or admin-editable. API PATCH preserves UTM unless explicitly allowed. No truncation of utmTerm/content.

### TC11 – Lead Notes Add / Edit / Delete

- Steps:
  1. Open lead detail, add note `Called, asked for demo next Tue`.
  2. Add second note with 2000 chars.
  3. Edit first note, delete second (as owner vs non-owner).
- Expected: Notes appear newest-first, show author + timestamp, edit retains history or updates timestamp, delete requires confirm, non-owner cannot edit/delete (403).

### TC12 – Lead Detail Edit & Optimistic Concurrency

- Steps:
  1. Open same lead in two tabs, edit Company in Tab1 save, then edit Title in Tab2 save.
  2. API: PATCH with stale `updatedAt`/`version` if supported.
- Expected: Last write wins with warning or 409 conflict with merge prompt. No silent data loss. Verify final state matches expectation.

### TC13 – Lead Delete & Permissions

- Steps:
  1. As Admin delete test lead, confirm dialog, verify 204 + list removal + `GET` returns 404.
  2. As Rep try delete owned and unowned; as Viewer try delete.
- Expected: Admin succeeds, Rep blocked (403) or only admin can delete, Viewer blocked. Deleted lead not visible in search; audit log records deletion.

### TC14 – List View Search, Filter, Sort, Pagination

- Steps:
  1. Seed 55 leads.
  2. Search `aarav`, filter Status=Working + Source=Referral, sort by CreatedAt desc, paginate page 1/2/3, change page size 10/25/50.
- Expected: Search case-insensitive partial match on name/email/company, filters combine with AND, sort stable, pagination `total`, `page`, `limit` correct, no duplicates across pages.

### TC15 – Bulk Actions (Assign, Status Change, Delete)

- Steps: Select 5 leads via checkboxes, bulk change status to Working, bulk assign to Rep B, bulk delete (admin).
- Expected: Confirmation modal shows count, progress indicator, partial failure reported, timeline updated for each, ownership changes reflected.

### TC16 – Lead Owner Assignment & Transfer

- Steps:
  1. Create unassigned lead (if allowed) or assigned to Rep A.
  2. Transfer to Rep B via UI dropdown and via `PATCH /api/leads/:id { ownerId }`.
  3. Verify Rep A loses edit, Rep B gains edit.
- Expected: Owner change logged, notification sent if feature enabled, list `Owner` column updates.

### TC17 – Permissions – Non-Owner Access

- Steps: As Rep B open Rep A owned lead, attempt edit, add note, convert.
- Expected: Per spec – either read-only with `Request Access` or editable but logged. Verify no 500, proper 403 message if denied. Viewer cannot create/edit at all.

### TC18 – Unauthenticated & Expired Token

- Steps: `GET /api/leads` without token, with malformed `Bearer xxx`, with expired token. Open `/leads` without login.
- Expected: API `401 Unauthorized` with `WWW-Authenticate` or JSON error, Web redirects to `/login?next=/leads`. No data leaked.

### TC19 – Large Payload, XSS & Special Characters

- Steps:
  1. Create lead with name `O'Neil-Test <script>alert(1)</script>`, company `A & Co. "Quotes"`, note with emoji 🚀 and 5000 chars.
  2. Verify list/detail rendering.
- Expected: Stored safely, rendered escaped (no script execution), no broken layout, API accepts UTF-8, DB collation preserves emoji.

### TC20 – Performance & Concurrency Smoke

- Steps:
  1. Measure `GET /api/leads?limit=50` p95 < 800ms local.
  2. Create 10 leads in parallel via script.
  3. Rapid double-click Save on UI.
- Expected: No duplicate creation on double-click (button disabled + idempotency), parallel creates all succeed with unique ids, list still paginates correctly.

### TC21 – Audit Trail & Timeline Completeness (Bonus)

- Steps: Create -> edit company -> change status -> add note -> transfer owner. Open Timeline/Activity tab.
- Expected: All 5 events present in order with actor, timestamp, old->new diff. Refresh persists.

### TC22 – Import Path Interaction (Bonus)

- Steps: Import CSV with 10 leads including 1 duplicate + 1 invalid email.
- Expected: 8 created, 1 skipped duplicate, 1 failed validation with row-level error report. Source set to `Import`.

## 5. API Testing Section

Base: `http://localhost:3001`. Auth: `Authorization: Bearer <TOKEN>`. Content-Type `application/json`.

| Method & Endpoint                                           | Purpose                     | Auth        | Expected Success                            |
| ----------------------------------------------------------- | --------------------------- | ----------- | ------------------------------------------- |
| `POST /api/leads`                                           | Create lead                 | Rep+        | 201 + lead JSON                             |
| `GET /api/leads?search=&status=&source=&page=&limit=&sort=` | List/search/filter          | Any auth    | 200 + `{ data, total, page, limit }`        |
| `GET /api/leads/:id`                                        | Get detail                  | Owner/Admin | 200, 404 if missing, 403 if forbidden       |
| `PATCH /api/leads/:id`                                      | Partial update              | Owner/Admin | 200 + updated, 400 validation, 409 conflict |
| `DELETE /api/leads/:id`                                     | Delete                      | Admin       | 204, 404 if missing                         |
| `GET /api/leads/:id/notes`                                  | List notes                  | Owner/Admin | 200 array                                   |
| `POST /api/leads/:id/notes`                                 | Add note                    | Owner/Admin | 201                                         |
| `PATCH /api/leads/:id/status`                               | Change status (if separate) | Owner/Admin | 200                                         |
| `GET /api/leads/count`                                      | Count for setup             | Admin       | 200 `{ count }`                             |

Curl examples (copy-paste, replace TOKEN and IDs):

```bash
# 1. Login and capture token
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"rep.a@test.com","password":"Rep123!"}'

# 2. Create lead with UTM attribution
curl -X POST http://localhost:3001/api/leads \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "firstName": "Aarav",
    "lastName": "Mehta",
    "email": "aarav.mehta.test@example.com",
    "company": "Mehta Labs",
    "title": "CTO",
    "status": "New",
    "source": "Web",
    "phone": "+91-98200-12345",
    "utmSource": "google",
    "utmMedium": "cpc",
    "utmCampaign": "q3_launch",
    "utmTerm": "crm software",
    "utmContent": "ad_variant_a"
  }'

# 3. List with search + filter + pagination
curl "http://localhost:3001/api/leads?search=aarav&status=New&source=Web&page=1&limit=10&sort=-createdAt" \
  -H "Authorization: Bearer $TOKEN"

# 4. Partial update (company + status)
curl -X PATCH http://localhost:3001/api/leads/LEAD_ID \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"company":"Mehta Labs Pvt Ltd","status":"Working"}'

# 5. Add note to lead
curl -X POST http://localhost:3001/api/leads/LEAD_ID/notes \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"body":"Called, requested demo next Tuesday 11am IST. Sent deck."}'

# 6. Negative - invalid email (expect 400)
curl -X POST http://localhost:3001/api/leads \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"firstName":"Bad","lastName":"Email","email":"not-an-email","company":"Test Co"}'

# 7. Delete lead (admin only, expect 204 or 403)
curl -X DELETE http://localhost:3001/api/leads/LEAD_ID \
  -H "Authorization: Bearer $ADMIN_TOKEN" -i
```

- Verify error shape: `{ "message": "...", "errors": [{ "field": "email", "message": "Invalid email" }] }`.
- Check headers: `Content-Type: application/json`, no stack trace in production.
- Test idempotency: retry POST with `Idempotency-Key` header if supported.

## 6. UI Testing Section

- Navigation: Sidebar `Leads` highlights, URL `/leads` and `/leads/:id` deep-linkable, back button preserves filters.
- List page checks:
  - Columns: Name, Company, Email, Status badge color, Source, Owner avatar, Created date, Actions.
  - Status badges: New (blue), Working (amber), Nurturing (purple), Qualified (green), Unqualified/Junk (gray/red).
  - Empty state: `No leads found. Create your first lead` with CTA when filter yields 0.
  - Loading skeleton shown for >300ms fetch; error banner with Retry on 500.
- Create/Edit form checks:
  - Required asterisks on Last Name, Company; inline validation on blur; Save disabled until valid or shows errors on submit.
  - Email field uses `type=email`, phone uses tel mask hint.
  - UTM fields collapsed under `Attribution` accordion, read-only for Rep, editable for Admin.
  - Double-click Save does not duplicate (button spinner + disabled).
- Detail page checks:
  - Header shows name, company, status pill editable inline, owner avatar with transfer dropdown.
  - Tabs: Overview, Notes, Activity/Timeline, (Convert button top-right).
  - Notes composer: placeholder `Add a note...`, Enter to save (Ctrl+Enter for newline), shows author + relative time `2h ago`.
  - Responsive: at 1366px no horizontal scroll; at 768px tabs collapse to dropdown.
- Accessibility: all inputs labelled, focus trap in modals, Esc closes, keyboard navigable list, contrast AA.
- Cross-browser: verify date format `DD MMM YYYY` consistent, avatar initials correct for `Priya Sharma -> PS`.

## 7. Regression & Cross-Feature Impact

- Lead conversion: status Qualified required before Convert enabled; after conversion lead marked Converted and read-only.
- Routing: newly created lead via UI should trigger routing rule (round-robin) – verify owner auto-assigned overrides manual owner if rule active; check assignment log.
- Web-to-Lead: leads with source `Web-to-Lead` appear same list but UTM prefilled; duplicate 5-min rule suppresses second create.
- Territories: changing company/country/email domain may re-suggest owner; verify suggestion banner does not auto-overwrite without confirm.
- Deals: converted leads create deal in default pipeline – verify pipeline stage `Qualification`.
- Search global: new lead appears in global search within 5s (if indexed).
- Dashboard: lead counts by status/source widgets increment correctly.
- Permissions change: demoting Rep to Viewer immediately hides New/Edit buttons without refresh (or after refresh, document).

## 8. Expected Results Summary Table

| TC   | Title              | Expected HTTP / UI    | Pass Criteria          |
| ---- | ------------------ | --------------------- | ---------------------- |
| TC01 | Create happy UI    | Toast + detail        | Record in DB + list    |
| TC02 | Create happy API   | 201                   | GET returns same       |
| TC03 | Required fields    | UI error + 400        | No record created      |
| TC04 | Email format       | UI error + 400        | Only valid accepted    |
| TC05 | Duplicate email    | 409 / warning         | No silent duplicate    |
| TC06 | Phone edges        | 400 or normalized     | Consistent UI/API      |
| TC07 | Status lifecycle   | Timeline logged       | Valid transitions only |
| TC08 | Junk reason        | Prompt required       | Reason stored          |
| TC09 | Source integrity   | 201 each              | Filter works           |
| TC10 | UTM capture        | Read-only display     | Values exact           |
| TC11 | Notes CRUD         | Newest-first          | Perms enforced         |
| TC12 | Concurrency        | 409 or merge          | No silent loss         |
| TC13 | Delete perms       | 204 admin, 403 others | Audit logged           |
| TC14 | Search/filter/sort | 200 correct page      | No dup across pages    |
| TC15 | Bulk actions       | Progress + confirm    | All timelines updated  |
| TC16 | Owner transfer     | 200 + log             | Old loses edit         |
| TC17 | Non-owner          | 403 or read-only      | No 500                 |
| TC18 | No auth            | 401 + redirect        | No leak                |
| TC19 | XSS/special        | Escaped render        | No script exec         |
| TC20 | Perf/double-click  | p95 <800ms, no dup    | Unique ids             |
| TC21 | Audit trail        | 5 events ordered      | Diff shown             |
| TC22 | Import             | 8/1/1 report          | Source=Import          |

## 9. Troubleshooting & Common Failures

- `400 company is required` on valid payload: check field name is `company` not `companyName`; trim whitespace-only strings.
- `409 duplicate` even for new email: case-insensitive unique index – search existing with `?search=` before create; clean test data.
- UTM fields missing in response: backend may strip unknown keys – verify casing `utmSource` camelCase, not `utm_source`.
- Notes not appearing: verify `leadId` path correct, pagination default `limit=10` may hide older; check sort `?sort=-createdAt`.
- Owner transfer 403 as Admin: token expired (1h TTL) – re-login; ensure `ownerId` is valid user id not email.
- List pagination duplicates: sort not stable without secondary `id` sort – add `&sort=-createdAt,-id`.
- CORS error on `localhost:3000` -> `localhost:3001`: ensure API `CORS_ORIGIN=http://localhost:3000`, preflight OPTIONS returns 204.
- Date shows `Invalid Date`: API returns ISO, UI expects locale – check timezone handling, verify `new Date(createdAt)` valid.
- Toast success but list not updated: optimistic cache not invalidated – hard refresh, check Network `GET /api/leads` fired.
- Delete succeeds but GET still 200: soft-delete flag – query includes `?includeDeleted=false`, verify `deletedAt` set.

## 10. Pass/Fail Checklist

- [ ] TC01–TC02 happy path create works via UI and API (201 + detail redirect)
- [ ] TC03–TC06 validations block missing/invalid lastName, company, email, phone (400 + inline)
- [ ] TC05 duplicate email handled without silent duplicate (409 or warning banner)
- [ ] TC07–TC08 status transitions logged, Junk/Unqualified reason captured
- [ ] TC09 all sources persist and filter correctly
- [ ] TC10 UTM five fields captured exactly and displayed read-only
- [ ] TC11 notes add/edit/delete with author/timestamp and permission checks
- [ ] TC12 concurrent edits do not silently lose data
- [ ] TC13 delete restricted to Admin, audit logged, GET after = 404
- [ ] TC14 search/filter/sort/pagination correct with 50+ records, no cross-page dups
- [ ] TC15 bulk assign/status/delete shows count + progress
- [ ] TC16 owner transfer updates permissions and logs event
- [ ] TC17 non-owner and Viewer restrictions enforced (no 500)
- [ ] TC18 unauthenticated returns 401 API + login redirect Web
- [ ] TC19 XSS payload escaped, emoji/UTF-8 preserved
- [ ] TC20 p95 <800ms, double-click Save creates single record
- [ ] TC21 timeline shows all lifecycle events with diff
- [ ] TC22 import summary 8/1/1 with row errors if applicable
- [ ] API section: all 7 curl groups executed, error shape verified
- [ ] UI section: badges, empty/loading/error states, responsive, a11y verified
- [ ] Regression: conversion, routing, web-to-lead, territories, dashboard counts intact
- [ ] Tester name, date, env (browser + commit hash) recorded below
- Tester: _______________ Date: _______________ Env: _______________ Result: PASS / FAIL
