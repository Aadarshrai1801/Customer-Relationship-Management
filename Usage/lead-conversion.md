# Lead Conversion – Comprehensive Testing Guide

## 1. Overview

This guide covers Lead-to-Customer conversion: converting a Lead into Contact + Account (+ optional Deal) via the conversion modal.
Scope includes modal UX, field mapping preview, duplicate matching, account/contact creation rules, optional deal creation (pipeline/stage/amount), post-conversion lead state (Converted, read-only), timeline entries, permissions, and rollback on partial failure.
Base URLs:

- API: `http://localhost:3001`
- Web: `http://localhost:3000`
  Typical flow: Lead (Qualified) -> Click Convert -> Modal shows mapped Account (company), Contact (name/email), optional Deal toggle -> Confirm -> Creates 2-3 records atomically -> Lead status=Converted -> Redirect to new Account/Contact/Deal.
  Out of scope: raw Lead CRUD (see `leads.md`), pipeline config (see `pipelines.md`), deal Kanban (see `deals-pipeline.md`).
  Success criteria: conversion is atomic (no orphan Contact without Account), idempotent (double-click creates one set), duplicate detection warns, Convert disabled unless Qualified (or per spec).

## 2. Prerequisites & Test Data Setup

- API `http://localhost:3001/health` 200, Web `http://localhost:3000` login works.
- Roles: Admin (convert any), Rep A (convert owned), Rep B (non-owner), Viewer (cannot convert).
- Pre-create leads in each status:

```json
{
  "firstName": "Qualified",
  "lastName": "ReadyToConvert",
  "email": "qualified.convert@test.com",
  "company": "ConvertCo Pvt Ltd",
  "status": "Qualified",
  "source": "Web",
  "ownerId": "rep_a_id"
}
```

```json
{
  "firstName": "New",
  "lastName": "NotReady",
  "email": "new.notready@test.com",
  "company": "NotReady Inc",
  "status": "New",
  "source": "Cold Call"
}
```

```json
{
  "firstName": "Already",
  "lastName": "Converted",
  "email": "already.converted@test.com",
  "company": "Done Corp",
  "status": "Converted"
}
```

- Pre-create existing Account `ConvertCo Pvt Ltd` and Contact `qualified.convert@test.com` to test duplicate matching.
- Ensure at least one Pipeline with stages exists: get `GET /api/pipelines` and note `pipelineId` + first stage `stageId`.
- Test deal payload for conversion with deal:

```json
{
  "createDeal": true,
  "dealTitle": "ConvertCo - Initial Opportunity",
  "pipelineId": "pipeline_id_here",
  "stageId": "stage_id_here",
  "amount": 50000,
  "currency": "INR",
  "closeDate": "2026-10-15"
}
```

- Clean up: prefix test companies with `ConvTest_` for easy deletion. Record ids of created Account/Contact/Deal for teardown `DELETE /api/accounts/:id` etc.
- Browser: Chrome with Network tab to verify single `POST /api/leads/:id/convert` on double-click.

## 3. Test Environment Matrix

| Dimension   | Variants                                               |
| ----------- | ------------------------------------------------------ |
| API         | `http://localhost:3001` local                          |
| Web         | `http://localhost:3000` local                          |
| Browsers    | Chrome, Firefox                                        |
| Viewports   | 1920x1080, 1366x768, 768x1024                          |
| Roles       | Admin, Owner Rep, Non-owner Rep, Viewer, Anonymous     |
| Lead Status | New, Working, Nurturing, Qualified, Converted, Junk    |
| Deal Toggle | With deal, Without deal                                |
| Duplicates  | No duplicate, Existing Account, Existing Contact, Both |
| Network     | Normal, slow 3G (modal spinner), offline               |

- Record pipelineId/stageId used, as conversion depends on pipeline config.
- Run conversion tests isolated – parallel conversion of same lead must be serialized.

## 4. Detailed Step-by-Step Test Cases

### TC01 – Happy Path Convert with Deal (UI)

- Precondition: Lead `qualified.convert@test.com` status Qualified, logged as Rep A owner.
- Steps:
  1. Open `http://localhost:3000/leads/:id`.
  2. Click `Convert` top-right.
  3. Verify modal shows Account name prefilled `ConvertCo Pvt Ltd`, Contact name/email prefilled, Deal toggle ON with Title, Pipeline, Stage, Amount, Close Date.
  4. Keep defaults, click `Confirm Convert`.
- Expected: Spinner <2s, success toast `Lead converted`, redirect to new Deal or Account, Lead status becomes Converted, Timeline logs conversion with links.

### TC02 – Happy Path Convert without Deal (UI)

- Steps: Open another Qualified lead, Convert modal, toggle `Create Deal` OFF, Confirm.
- Expected: Only Account + Contact created, no Deal. Lead Converted. Modal clearly indicates deal will not be created.

### TC03 – Happy Path Convert (API)

- Steps: `POST /api/leads/:id/convert` with `{ createDeal: true, dealTitle, pipelineId, stageId, amount }`.
- Expected: `201` with `{ account, contact, deal }` ids. `GET /api/leads/:id` shows `status: Converted`, `convertedAt`, `convertedAccountId`, etc.

### TC04 – Convert Button Visibility / Enablement by Status

- Steps: Open leads in New, Working, Nurturing, Qualified, Converted, Junk as owner.
- Expected: Convert enabled only for Qualified (or Working+Qualified per spec). For Converted show `Already converted` disabled + link to created records. For New/Junk show tooltip `Qualify lead before converting`.

### TC05 – Validation – Missing Company / Name

- Steps: Create Qualified lead with empty company (if allowed via import) then try Convert.
- Expected: Modal shows inline error `Account name required`, Confirm disabled until fixed. API returns `400 accountName required`.

### TC06 – Validation – Missing Pipeline/Stage When Deal Toggled ON

- Steps: In modal toggle deal ON but clear Pipeline or Stage or Amount.
- Expected: Inline errors, Confirm blocked. API `400 pipelineId, stageId required when createDeal=true`.

### TC07 – Duplicate Account Detection

- Steps: Convert lead whose company `ConvertCo Pvt Ltd` already exists as Account.
- Expected: Modal shows warning `Matching account found (1)` with link + radio `Use existing` vs `Create new`. Default to Use existing to avoid duplicate. API returns `409` or `200 with matchSuggested` – document behavior. Verify no duplicate Account when choosing Use existing.

### TC08 – Duplicate Contact Detection (Email Match)

- Steps: Convert lead email already exists as Contact.
- Expected: Warning `Contact with this email already exists`, options to link vs create. If linked, verify no second Contact with same email (case-insensitive).

### TC09 – Double-Click / Double Submit Idempotency

- Steps:
  1. Open Convert modal, double-click Confirm rapidly.
  2. API: send two `POST /convert` in parallel for same lead.
- Expected: Only one Account/Contact/Deal set created. UI disables button + spinner. Second API returns `409 Already converted` or idempotent same ids, not duplicate records. Verify via `GET /api/accounts?search=ConvTest`.

### TC10 – Already Converted Lead Re-Convert Block

- Steps: Try converting lead with status Converted again via UI and API.
- Expected: UI button disabled with message, API `409 Lead already converted`. No new records. Response includes existing `accountId/contactId`.

### TC11 – Conversion Modal Field Mapping Preview

- Steps: Open modal for lead with all fields (phone, title, address, UTM, notes).
- Expected: Preview shows mapping: Lead.Company -> Account.Name, Lead.Name/Email/Phone -> Contact, Lead.Notes -> Account/Contact timeline, UTM -> Account attribution. Editable Account/Contact names before confirm. Cancel discards edits without side effects.

### TC12 – Notes / Timeline Carryover

- Steps: Add 2 notes to lead, then Convert.
- Expected: Notes copied or linked to new Account/Contact (or visible via `Converted from Lead` link). Original lead notes retained. New records show `Created via lead conversion` entry.

### TC13 – Owner Mapping to New Records

- Steps: Convert lead owned by Rep A while logged as Admin.
- Expected: New Account/Contact/Deal owner = lead owner (Rep A) or converter (Admin) per spec – verify and document. Owner column consistent across all three.

### TC14 – Permissions – Non-Owner Cannot Convert

- Steps: As Rep B try converting Rep A lead via UI + API. As Viewer try convert.
- Expected: Button hidden/disabled with `No permission`, API `403 Forbidden`. No records created. Audit log shows denied attempt if logged.

### TC15 – Unauthenticated Convert Block

- Steps: `POST /api/leads/:id/convert` without token, open `/leads/:id` without login then click Convert.
- Expected: `401` API, Web redirect to login. No conversion.

### TC16 – Invalid Pipeline/Stage IDs

- Steps: API convert with `pipelineId: 000000000000`, `stageId: invalid`, or stage not in pipeline.
- Expected: `400` or `404 Pipeline/Stage not found` or `422 Stage does not belong to pipeline`. No partial creation (no orphan Account).

### TC17 – Atomicity – Failure Mid-Conversion

- Steps: Simulate failure: use amount `-999999999` or closeDate invalid to trigger deal validation failure after account creation would have succeeded.
- Expected: Entire transaction rolled back – no Account/Contact left orphaned, lead remains Qualified (not Converted). Error message indicates which step failed. Verify via search that `ConvTest_` count unchanged.

### TC18 – Cancel Modal No Side Effects

- Steps: Open Convert modal, change Account name, toggle deal, then click Cancel/X/Esc/outside.
- Expected: No API call fired (Network tab), lead unchanged, no Account/Contact/Deal created. Reopen modal shows original defaults.

### TC19 – Post-Conversion Lead Read-Only

- Steps: After conversion, try editing lead company, adding note, changing status, deleting.
- Expected: Lead detail shows `Converted` banner with links to Account/Contact/Deal, fields read-only or edits blocked with `Converted leads cannot be edited`. API PATCH returns `409` or `422`.

### TC20 – Converted Lead in List / Search / Reports

- Steps: After conversion, check Leads list filter, global search, dashboard counts.
- Expected: Lead either hidden by default `Hide converted` filter or shown with Converted badge grayed. Counts: Open leads -1, Customers/Accounts +1, Deals +1 if deal created. No duplicate counting.

### TC21 – Currency & Amount Edge in Convert-Deal (Bonus)

- Steps: Convert with deal amount `0`, `999999999`, currency `USD`, `EUR`, `INR`.
- Expected: 0 allowed only if spec permits (else 400), large amount accepted, currency persisted, baseAmount computed per FX snapshot (see deals-pipeline.md). Symbol renders correctly on Deal detail.

### TC22 – Accessibility & Responsive Modal (Bonus)

- Steps: Tab through modal fields, Esc to close, test at 768px width.
- Expected: Focus trapped, all inputs labelled, error announcements via aria-live, modal scrolls without cutting Confirm button, no horizontal overflow.

## 5. API Testing Section

| Method & Endpoint             | Purpose                       | Expected                                                                            |
| ----------------------------- | ----------------------------- | ----------------------------------------------------------------------------------- |
| `POST /api/leads/:id/convert` | Convert lead                  | 201 `{account,contact,deal?}`, 400 validation, 409 already converted, 403 forbidden |
| `GET /api/leads/:id`          | Verify Converted status       | 200 `status: Converted` + `convertedAccountId` etc.                                 |
| `GET /api/accounts?search=`   | Verify account created/linked | 200 contains expected                                                               |
| `GET /api/contacts?search=`   | Verify contact                | 200                                                                                 |
| `GET /api/deals?search=`      | Verify deal if requested      | 200                                                                                 |
| `POST /api/leads`             | Setup qualified lead          | 201                                                                                 |

```bash
# 1. Login
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"rep.a@test.com","password":"Rep123!"}'

# 2. Create qualified lead for conversion
curl -X POST http://localhost:3001/api/leads \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"firstName":"Qualified","lastName":"ReadyToConvert","email":"qualified.convert@test.com","company":"ConvTest_Co Pvt Ltd","status":"Qualified","source":"Web"}'

# 3. Get pipelines to pick pipeline/stage
curl http://localhost:3001/api/pipelines -H "Authorization: Bearer $TOKEN"

# 4. Convert with deal (INR example)
curl -X POST http://localhost:3001/api/leads/LEAD_ID/convert \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "createDeal": true,
    "accountName": "ConvTest_Co Pvt Ltd",
    "contactFirstName": "Qualified",
    "contactLastName": "ReadyToConvert",
    "dealTitle": "ConvTest_Co - Initial Opportunity",
    "pipelineId": "PIPELINE_ID",
    "stageId": "STAGE_ID",
    "amount": 50000,
    "currency": "INR",
    "closeDate": "2026-10-15"
  }'

# 5. Convert without deal
curl -X POST http://localhost:3001/api/leads/LEAD_ID2/convert \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"createDeal": false, "accountName": "ConvTest_NoDeal Inc"}'

# 6. Re-convert same lead (expect 409)
curl -X POST http://localhost:3001/api/leads/LEAD_ID/convert \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"createDeal": false}'

# 7. Convert with invalid stage (expect 400/404/422, no partial creation)
curl -X POST http://localhost:3001/api/leads/LEAD_ID3/convert \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"createDeal": true, "dealTitle":"Bad stage","pipelineId":"PIPELINE_ID","stageId":"000000000000","amount":1000,"currency":"USD"}'
```

- Verify atomicity: after #7, `GET /api/accounts?search=Bad` returns 0.
- Verify idempotency header if supported: send `Idempotency-Key: conv-<leadId>` and retry.

## 6. UI Testing Section

- Convert button: top-right on detail, primary color, icon `arrow-right-circle`, tooltip explains qualification requirement when disabled.
- Modal specifics:
  - Title `Convert Lead: <Name>`, sections `Account`, `Contact`, `Deal (optional toggle)`.
  - Prefilled values editable inline; duplicate warning banners amber with `View` link.
  - Deal toggle switch animates, reveals Pipeline dropdown (ordered), Stage dropdown (filtered to pipeline), Amount with currency selector (USD/EUR/INR), Close Date datepicker (no past date without warning).
  - Confirm button `Convert` with spinner, Cancel secondary, X + Esc + backdrop click all cancel without API call.
  - Success: toast + auto-redirect (to Deal if created else Account), Converted banner on lead with 3 links.
- Validation visuals: red borders + messages under fields, Confirm disabled until valid, no silent close.
- Loading: modal shows skeleton if pipeline fetch slow; double-click does not fire second request (verify Network tab single POST).
- Responsive: modal max-width 640px desktop, full-screen sheet on tablet/mobile, Confirm sticky footer visible without scroll.
- Accessibility: `role=dialog aria-modal=true`, focus starts on Account name, Tab cycles, Esc closes, screen reader announces duplicate warnings.

## 7. Regression & Cross-Feature Impact

- Leads list: converted lead badge/count, default filter excludes converted – verify toggle `Include converted` works.
- Accounts/Contacts: new records appear in respective lists with `Source: Lead conversion`, owner correct, timeline linked.
- Deals pipeline: new deal appears in correct pipeline/stage column with amount/currency; Kanban counts +1; forecast includes it.
- Routing/Territories: conversion should not re-trigger routing; owner already set propagates, territory suggestion not re-applied post-conversion.
- Quotes/Approvals: deal from conversion can immediately create quote/line items – smoke create quote for converted deal.
- Dashboard: funnel `Leads -> Qualified -> Converted -> Deals` increments; conversion rate recalculated.
- Notifications: owner of new records notified if enabled; assignment log not duplicated.
- Delete guard: deleting Account created via conversion should warn `Linked to converted lead` or block if policy.

## 8. Expected Results Summary Table

| TC   | Title                  | Expected               | Pass Criteria              |
| ---- | ---------------------- | ---------------------- | -------------------------- |
| TC01 | With deal UI           | Redirect + Converted   | Account+Contact+Deal exist |
| TC02 | Without deal UI        | 2 records only         | No deal in DB              |
| TC03 | API happy              | 201 ids                | GET Converted              |
| TC04 | Button by status       | Only Qualified enabled | Others disabled w/ tooltip |
| TC05 | Missing company        | Inline + 400           | Blocked                    |
| TC06 | Missing pipeline/stage | Inline + 400           | Blocked                    |
| TC07 | Dup account            | Warning + use/link     | No duplicate               |
| TC08 | Dup contact            | Warning                | No duplicate email         |
| TC09 | Double-click           | Single set             | Second 409                 |
| TC10 | Re-convert             | 409 disabled           | No new records             |
| TC11 | Mapping preview        | Correct mapping        | Cancel no side effect      |
| TC12 | Notes carryover        | Copied/linked          | Both sides visible         |
| TC13 | Owner mapping          | Consistent owner       | Documented rule            |
| TC14 | Non-owner 403          | Hidden/disabled        | No creation                |
| TC15 | No auth 401            | Redirect               | No leak                    |
| TC16 | Bad pipeline/stage     | 400/404/422            | No orphan                  |
| TC17 | Atomic rollback        | Lead stays Qualified   | 0 orphans                  |
| TC18 | Cancel                 | No API call            | Unchanged                  |
| TC19 | Read-only after        | Banner + 409 on edit   | Links work                 |
| TC20 | List/reports           | Counts updated         | Filter correct             |
| TC21 | Currency edges         | Persist + FX           | Symbol correct             |
| TC22 | A11y/responsive        | Trap + scroll          | No overflow                |

## 9. Troubleshooting & Common Failures

- `400 pipelineId required` even with toggle OFF: payload still sends `pipelineId: ""` – omit deal fields entirely when `createDeal:false`.
- `404 Pipeline not found`: copied id from wrong env (prod vs local) – re-fetch `GET /api/pipelines` on `localhost:3001`.
- `422 Stage does not belong to pipeline`: stage from different pipeline – list `GET /api/pipelines/:id/stages` to pick correct.
- Modal Convert button spins forever: API hung on duplicate check – check Network timing, backend logs for unique index deadlock; retry after 10s.
- Duplicate Account created despite warning: tester clicked `Create new` – verify default radio is `Use existing`; check case-insensitive match (`convtest_co` vs `ConvTest_Co`).
- Lead stuck Qualified after 201: frontend cache – hard refresh `GET /api/leads/:id` directly; verify `status` field.
- `403` as owner: ownership changed by routing rule between create and convert – re-GET lead to confirm `ownerId`, re-login as current owner.
- Orphan Account after failed deal: backend not transactional – report as P0, manually clean `DELETE /api/accounts/:id`, attach logs.
- Redirect goes to 404 after convert: frontend uses wrong id key (`deal.id` vs `deal._id`) – inspect response JSON, navigate manually to `/deals/:id`.
- CORS on convert POST: ensure `Content-Type: application/json` triggers preflight – API must allow `POST` + `Authorization` header.

## 10. Pass/Fail Checklist

- [ ] TC01–TC03 happy paths with/without deal via UI + API create correct 2-3 records atomically
- [ ] TC04 Convert enabled only for Qualified, disabled with tooltip otherwise
- [ ] TC05–TC06 validations block missing account/deal fields (inline + 400)
- [ ] TC07–TC08 duplicate account/contact warnings prevent silent duplicates
- [ ] TC09 double-click/parallel creates single set (second 409)
- [ ] TC10 re-convert blocked (409 + disabled button)
- [ ] TC11 mapping preview correct, Cancel fires no API call
- [ ] TC12 notes carry over, timeline linked both sides
- [ ] TC13 owner mapping consistent and documented
- [ ] TC14–TC15 non-owner/Viewer/anonymous blocked (403/401)
- [ ] TC16–TC17 invalid stage and mid-failure rollback with zero orphans
- [ ] TC18 Cancel/Esc/backdrop have zero side effects
- [ ] TC19 converted lead read-only with banner + links, edits blocked
- [ ] TC20 list/search/dashboard counts updated correctly
- [ ] TC21 currency edges (USD/EUR/INR, zero, large) handled
- [ ] TC22 modal accessible, focus-trapped, responsive without overflow
- [ ] All 7 curl examples executed, atomicity verified via search
- [ ] Regression: accounts/contacts/deals lists, funnel, notifications intact
- [ ] Tester, date, pipeline/stage ids, env recorded
- Tester: _______________ Date: _______________ Pipeline/Stage: _______________ Result: PASS / FAIL
