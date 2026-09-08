# Custom Fields – Comprehensive Testing Guide

Base URLs: API `http://localhost:3001`, Web `http://localhost:3000`.

## 1. Overview

This guide covers Custom Fields, Picklists, Formulas, Validation Rules, and Layouts per object (Contact / Account / Lead / Deal). Admins can create fields of types `text`, `number`, `date`, `picklist`, `multi-select`, `checkbox`, `currency`, `formula`; define picklist values, default values, required/unique flags, validation regex/min-max, formula expressions (including cross-object with limits), and arrange them in layouts (sections) rendered by the `custom-fields-renderer` UI component on record detail / create / edit / list / filters.

Scope:

- CRUD for field definitions per object: `/settings/objects/:object/fields`.
- Types + constraints: text (maxLength), number (min/max/decimals), date (min/max, no future?), picklist single, multi-select, checkbox boolean, currency (code + precision), formula (read-only, expression engine).
- Picklist lifecycle: add/rename/deactivate/reorder values, replace value across records.
- Validation: required, unique, regex, range, picklist membership.
- Formulas: arithmetic, string concat, date diff, conditionals (`IF`), cross-object refs (`account.annualRevenue * 0.1`) with depth/limits.
- Impact analysis on type change / deletion: record count affected, preview, migrate/replace, block if formula depends on it.
- Layouts: sections + ordering + visibility per role/profile, required-in-layout vs required-globally.
- Renderer: `custom-fields-renderer` displays correct input/view per type, inline errors, respects perms.

Out of scope: workflow-triggered field updates (covered in workflows guide) except formula recalc triggers.

## 2. Prerequisites & Test Data Setup

### 2.1 Environment

- API + Web up; login as `admin@test.com / Admin123!` (can manage fields) and `rep@test.com / Rep123!` (cannot manage, but can fill).
- Objects seeded: at least 20 Contacts, 10 Accounts, 10 Leads, 10 Deals.
- Flags: `custom_fields_enabled=true`, `formula_engine=v2`.
- Note baseline schema: `GET http://localhost:3001/api/custom-fields?object=contact`.

### 2.2 Seed custom fields (via UI at http://localhost:3000/settings/objects/contact/fields or API)

Create for Contact:

| Key                 | Label          | Type                 | Config                                                                     |
| ------------------- | -------------- | -------------------- | -------------------------------------------------------------------------- |
| `cf_industry`       | Industry       | picklist             | values `[SaaS, Fintech, Healthcare, Retail]`, default SaaS, required=false |
| `cf_tags`           | Tags           | multi-select         | values `[VIP, Beta, Churn-risk, Partner]`                                  |
| `cf_is_vip`         | VIP?           | checkbox             | default false                                                              |
| `cf_score`          | Lead Score     | number               | min 0 max 100 decimals 0                                                   |
| `cf_renewal`        | Renewal Date   | date                 | no past? false                                                             |
| `cf_mrr`            | MRR            | currency             | code USD, precision 2, min 0                                               |
| `cf_nickname`       | Nickname       | text                 | maxLength 50                                                               |
| `cf_full_label`     | Full Label     | formula              | `firstName + " " + lastName + " (" + cf_industry + ")"`                    |
| `cf_health`         | Health         | formula              | `IF(cf_score >= 80, "Healthy", IF(cf_score >= 50, "Watch", "Risk"))`       |
| `cf_acct_rev_share` | Acct Rev Share | formula cross-object | `account.annualRevenue * 0.1` (limit test)                                 |

For Deal: `cf_close_confidence` number, `cf_stage_pick` picklist; for Lead: `cf_source_detail` text + regex validation `^[A-Z]{3}-[0-9]{4}$`.

### 2.3 Layout seed

- Contact layout `Default Contact Layout`: Section `Basics` (firstName,lastName,email), Section `Custom` (industry, tags, VIP, score, MRR, formulas read-only), Section `Admin only` (nickname, visible Admin only).
- Keep `Layout Draft` unpublished for TC tests.

### 2.4 API seed snippet

```bash
TOKEN=$(curl -s -X POST http://localhost:3001/api/auth/login -H "Content-Type: application/json" -d '{"email":"admin@test.com","password":"Admin123!"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
# list
curl -s "http://localhost:3001/api/custom-fields?object=contact" -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
```

## 3. Test Environment Matrix

| Dimension          | Variants                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| Browser            | Chrome 126, Firefox 128, Safari 17                                                             |
| Viewport           | Desktop 1440, tablet 768, mobile 375 (renderer stacks)                                         |
| Role               | Admin (manage), Manager (view admin section? no), Rep (fill, no manage), Read-only (view only) |
| Object             | Contact, Account, Lead, Deal (each layout + types)                                             |
| Formula complexity | Simple concat, arithmetic, IF nesting (3 deep), cross-object 1 hop vs 2 hops (blocked)         |
| Data volume        | 0 records with field, 1k records (migration timing), 50k formula recalc                        |
| API vs UI          | Create field via UI + via API; set values via both; verify parity                              |
| Locale             | en-US (currency $1,234.00, date MM/DD/YYYY) vs de-DE (€, DD.MM.YYYY) + timezone UTC/PST        |
| Network            | Normal + offline draft (create form retains custom values on reload)                           |

SLOs: field save <1s; record save with 20 customs <1.5s; formula recalc p95 <500ms per record, bulk 1k <30s; layout publish <2s.

## 4. Detailed Step-by-Step Test Cases (at least 20 numbered TC cases)

### TC-01: Create text field with maxLength + required

Steps:

1. As Admin go to `/settings/objects/contact/fields` → New → Type Text, Label Nickname, Key auto `cf_nickname`, Max 50, Help “Short name”.
2. Save → verify appears in list with type badge.
3. New Contact → verify Nickname input, maxlength enforced (counter 50), save with 60 chars → blocked client + server 422.
   Expected: 422 `cf_nickname maxLength 50`; list shows field; audit `custom_field.created`.

### TC-02: Number field min/max/decimals

Steps:

1. Create `Lead Score` number min 0 max 100 decimals 0.
2. Contact edit: enter -5 → error “Min 0”; 101 → “Max 100”; 75.5 → rounds or rejects per spec (expect reject “No decimals”); 75 → saves.
3. API `PATCH /contacts/:id {cf_score: 200}` → 422.
   Expected: Client + server agree; error messages field-specific.

### TC-03: Date field validation

Steps:

1. Create `Renewal Date` date.
2. Pick past date → allowed (unless configured no-past – toggle on, verify blocks future? test both).
3. Enter `2026-13-40` → invalid date error; API `{"cf_renewal":"not-a-date"}` → 422.
4. Verify locale render: en-US `09/08/2026` vs API ISO `2026-09-08`.
   Expected: Date picker + manual entry both validated.

### TC-04: Picklist create + default + membership enforcement

Steps:

1. Create Industry picklist `[SaaS, Fintech, Healthcare, Retail]`, default SaaS.
2. New contact without choosing → defaults SaaS (verify in detail + API).
3. API set `cf_industry: "Oil"` → 422 `must be one of`.
4. UI dropdown forbids free-text (combobox disabled).
   Expected: Default applied server-side too (direct API create without field still gets SaaS).

### TC-05: Multi-select behavior

Steps:

1. Create Tags multi-select.
2. Contact edit: select VIP + Beta, save, verify pills in detail, API array `["VIP","Beta"]`.
3. Deselect all → saves `[]` (not null) if not required; if required → blocked.
4. API send string `"VIP"` (not array) → 422.
5. Filter list `Tags contains VIP` → returns contact.
   Expected: Array semantics, filter works, renderer shows checkboxes/pills.

### TC-06: Checkbox + currency

Steps:

1. VIP checkbox default false → toggle true, save, verify detail badge “VIP” + list icon.
2. MRR currency: enter `1234.5` → renders `$1,234.50`, API stores `1234.5` + code USD; enter `-10` → Min error; change code to EUR (if allowed per field) → symbol €.
3. API `cf_mrr: "abc"` → 422.
   Expected: Precision 2, locale formatting, server numeric.

### TC-07: Formula – simple concat + arithmetic (renderer read-only)

Steps:

1. Create `Full Label` formula `firstName + " " + lastName + " (" + cf_industry + ")"`.
2. Create contact Ada Lovelace Industry Fintech → detail shows `Ada Lovelace (Fintech)` in read-only styled field (grey, no input, copy button).
3. Edit firstName → formula updates on save (or live if client-evaluated – verify per spec, at least on reload).
4. Attempt API write `cf_full_label: "hack"` → ignored or 422 `read_only` (verify spec – must not persist).
   Expected: Correct eval, read-only enforced, `custom-fields-renderer` shows formula icon + expression tooltip.

### TC-08: Formula conditionals + number/date functions

Steps:

1. Health formula `IF(cf_score>=80,"Healthy",IF(cf_score>=50,"Watch","Risk"))`.
2. Set score 90→Healthy, 60→Watch, 10→Risk, null→? (expect `Risk` or `—` per spec – record actual).
3. Date formula `DAYS_BETWEEN(TODAY(), cf_renewal)` on test record.
4. Division by zero `cf_mrr / 0` → `null` + `formula_error` flag, not 500.
   Expected: All branches correct, null-safe, errors surfaced as `⚠ formula error` not crash.

### TC-09: Cross-object formula limits (CRITICAL)

Steps:

1. Create `Acct Rev Share` = `account.annualRevenue * 0.1` (1-hop allowed).
2. Link contact to Acme (revenue $1M) → expect $100k.
3. Attempt 2-hop `account.owner.manager.name` or `account.deals[0].amount` → builder blocks with “Cross-object depth max 1” + API 422 `formula_depth_exceeded`.
4. Attempt aggregate `SUM(account.contacts.cf_mrr)` → blocked “Aggregates not supported” (or allowed if spec says – verify and record).
5. Change account revenue → contact formula recalculates (verify trigger: on account save + async recalc job <60s).
   Expected: Limits enforced with clear messages; 1-hop works + recalc.

### TC-10: Validation rules – regex + required + unique

Steps:

1. On Lead `cf_source_detail` add regex `^[A-Z]{3}-[0-9]{4}$` + required + help “e.g., WEB-1234”.
2. Try `web-123` → regex error; `WEB-1234` → passes; empty → required error.
3. Mark `cf_nickname` unique → create two contacts same nickname → second 409 `unique_violation`; UI shows “Already in use”.
   Expected: Regex/required/unique all server-enforced (bypass UI via API still blocked).

### TC-11: Layouts – sections, ordering, visibility per role

Steps:

1. Edit Default Contact Layout: drag `Lead Score` above `Industry`, create Section `Risk` with Health + Tags.
2. Set Section `Admin only` visible Admin only.
3. As Rep open contact → verify order + Admin section hidden (not just collapsed – absent in DOM); as Admin → visible.
4. Publish → version increments; verify audit `layout.published`.
   Expected: Drag persists, visibility enforced server-side (API as Rep `GET /contacts/:id` omits or redacts admin-only? verify per spec – at least UI hidden + direct field write 403).

### TC-12: Renderer – create/edit/detail/list/filter parity (`custom-fields-renderer` UI)

Steps:

1. On `/contacts/new`, verify each type renders correct control: text input, number stepper, date picker, picklist dropdown, multi pills, checkbox switch, currency with $ prefix, formula hidden on create (or placeholder `—`).
2. Save, open detail: verify view mode (formatted) + inline edit pencil per field.
3. List: add columns Industry/Score via column picker, verify sorting by Score numeric (not lexicographic: 100 > 90 > 9).
4. Filter: `Score >= 50 AND Industry = SaaS`, save view.
   Expected: No type renders as plain text input incorrectly; sort/filter type-aware.

### TC-13: Impact analysis on type change (CRITICAL)

Steps:

1. Pick `cf_score` (number, 200 records filled) → Change type to Text.
2. Verify impact modal appears: “200 records affected, values will be cast to string; 0 formula dependents; 1 filter + 1 report use this field”.
3. Confirm → verify values `"75"` strings, filters still work (string compare?), formulas referencing it show warning `type_changed`.
4. Attempt change `cf_industry` (picklist) → Number → expect hard block “Cannot convert picklist to number – export + recreate” or allow with value mapping? Record actual + require explicit typed confirm.
   Expected: Modal always shows counts + dependents; destructive conversions blocked or require `confirmText`.

### TC-14: Deletion with dependents – blocked + replace flow

Steps:

1. Try delete `cf_score` (referenced by Health formula + 1 report + layout).
2. Verify blocker modal: lists dependents (formula Health, view “High scores”, layout section), offers `Replace with…` dropdown + `Export values` button.
3. Choose Replace Health’s ref with constant? or delete Health first, then delete score → succeeds, records lose key (API omits), audit `custom_field.deleted` with snapshot.
4. Verify deleted key query `?fields=cf_score` → ignored, no 500.
   Expected: No silent breakage; formulas referencing deleted show `⚠ missing field`.

### TC-15: Picklist value rename / deactivate / replace across records

Steps:

1. Rename `Fintech`→`FinTech` → verify existing records updated (or aliased) + history.
2. Deactivate `Retail` (not delete) → existing Retail records keep value with `deprecated` badge, new creates cannot pick it.
3. Replace `Retail`→`SaaS` via “Replace value” bulk → verify 1k bulk <30s + audit.
   Expected: No orphan pick values; API old value after rename → 422 (must use new).

### TC-16: Permissions – who can manage vs fill

Steps:

1. As Rep visit `/settings/objects/contact/fields` → 403 + hidden nav; direct API `POST /custom-fields` as Rep → 403.
2. As Rep edit contact custom values → allowed except Admin-only (403 on `cf_nickname` if admin-only).
3. Read-only: all custom inputs disabled.
   Expected: Manage vs fill split enforced.

### TC-17: Bulk + import/export with customs

Steps:

1. Import CSV with `Industry,Lead Score` columns → auto-mapped to customs, dry-run catches bad pick `Oil`.
2. Bulk edit Industry SaaS→FinTech for 100 contacts.
3. Export includes custom headers `cf_industry` + labels; re-import round-trips.
   Expected: Import/export parity; bulk respects validation (bad value fails per-row).

### TC-18: Formula recalc triggers + performance

Steps:

1. Update `firstName` on 1k contacts via bulk → verify formulas recalculated (poll `GET /contacts?filter=...`).
2. Update Account revenue → linked contacts’ cross-object formulas recalc within 60s (job `formula:recalc`).
3. Measure: single save recalc <500ms; bulk 1k <30s.
   Expected: No stale formulas; job log sane.

### TC-19: Required-in-layout vs required-globally + conditional visibility

Steps:

1. Set `Industry` required-globally → API create without it 422 even if layout hides it.
2. Set `MRR` required-only-in-layout `Deal` (not globally) → Contact create without MRR passes, Deal create without fails.
3. Add show-if rule `Show MRR only if Industry=Fintech` → verify renderer hides/shows live.
   Expected: Both required scopes work; show-if client + server (server ignores hidden-but-sent? record actual).

### TC-20: Sorting / filtering / reporting on customs

Steps:

1. List sort by MRR desc, Score asc; filter `MRR > 1000`, `Renewal < 2026-12-31`, `Tags contains VIP`, `VIP = true`.
2. Build report grouped by Industry with avg Score.
3. Verify API `GET /api/contacts?sort=cf_score:desc&cf_industry=SaaS` works + pagination stable.
   Expected: Type-aware operators; no string-sort bug.

### TC-21: Edge – long labels, emoji, special keys

Steps:

1. Create field label with emoji + 100-char name, key auto-slug `cf_...` unique.
2. Attempt duplicate key `cf_score` → 409; attempt reserved key `email` → 422 `reserved`.
3. Value with `<script>` in text custom → rendered escaped (no XSS), export escaped.
   Expected: Slug/unique/reserved enforced; XSS escaped.

### TC-22: Versioning / audit + rollback

Steps:

1. Change picklist values 3 times, check field history timeline (`/settings/.../fields/:key/history`) shows diffs + actor.
2. Delete field, restore from snapshot within retention (if supported) → values restored? Record actual.
   Expected: History immutable; restore path documented.

## 5. API Testing Section

| Method & Endpoint                                    | Purpose                                      | Auth               | Expected                                     |
| ---------------------------------------------------- | -------------------------------------------- | ------------------ | -------------------------------------------- |
| `GET /api/custom-fields?object=contact`              | List defs                                    | Bearer             | 200 `[{key,label,type,config,order}]`        |
| `POST /api/custom-fields`                            | Create field                                 | Admin              | 201 `{key}` or 409/422                       |
| `PATCH /api/custom-fields/:key`                      | Update (incl. type change with `confirm`)    | Admin              | 200 + `impact:{affectedRecords, dependents}` |
| `DELETE /api/custom-fields/:key`                     | Delete (blocked if dependents w/o `replace`) | Admin              | 204 or 422 `has_dependents`                  |
| `GET /api/custom-fields/:key/impact`                 | Impact preview                               | Admin              | 200 `{records, formulas, views, reports}`    |
| `POST /api/custom-fields/:key/picklist/replace`      | Bulk replace pick value                      | Admin              | 202 job                                      |
| `PATCH /api/contacts/:id` with `cf_*`                | Set values                                   | Bearer (fill perm) | 200 or 422 validation                        |
| `GET /api/contacts?cf_score_gte=50&sort=cf_mrr:desc` | Filter/sort by custom                        | Bearer             | 200 type-aware                               |
| `GET /api/layouts?object=contact` / `PUT`            | Layout CRUD                                  | Admin              | 200                                          |
| `POST /api/formulas/validate`                        | Dry-run expression                           | Admin              | 200 `{valid, errors}` or 422                 |

### curl examples (API http://localhost:3001)

```bash
TOKEN=$(curl -s -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@test.com","password":"Admin123!"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")

# 1) List contact customs
curl -s "http://localhost:3001/api/custom-fields?object=contact" \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool

# 2) Create picklist field
curl -s -X POST http://localhost:3001/api/custom-fields \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"object":"contact","label":"Industry","key":"cf_industry","type":"picklist","config":{"values":["SaaS","Fintech","Healthcare"],"default":"SaaS"}}' | python3 -m json.tool

# 3) Create formula (cross-object 1-hop ok)
curl -s -X POST http://localhost:3001/api/custom-fields \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"object":"contact","label":"Acct Rev Share","key":"cf_acct_rev_share","type":"formula","config":{"expression":"account.annualRevenue * 0.1","returnType":"currency"}}' | python3 -m json.tool

# 4) Validate bad formula (2-hop should fail)
curl -s -X POST http://localhost:3001/api/formulas/validate \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"object":"contact","expression":"account.owner.manager.name"}' | python3 -m json.tool
# expect 422 depth_exceeded

# 5) Set custom values (good + bad)
curl -s -X PATCH http://localhost:3001/api/contacts/c_001 \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"cf_industry":"Fintech","cf_score":85,"cf_tags":["VIP","Beta"],"cf_mrr":1234.5}' | python3 -m json.tool
curl -s -X PATCH http://localhost:3001/api/contacts/c_001 \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"cf_industry":"Oil"}' | python3 -m json.tool
# expect 422 must be one of

# 6) Impact preview before type change/deletion
curl -s "http://localhost:3001/api/custom-fields/cf_score/impact" \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool

# 7) Filter/sort by customs
curl -s "http://localhost:3001/api/contacts?cf_industry=SaaS&cf_score_gte=50&sort=cf_score:desc&limit=5" \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool

# 8) Attempt write to formula (must fail or ignore)
curl -s -X PATCH http://localhost:3001/api/contacts/c_001 \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"cf_full_label":"hacked"}' | python3 -m json.tool
```

Negative: duplicate key → 409; reserved `email` → 422; Rep `POST /custom-fields` → 403; delete with dependents w/o replace → 422; formula syntax error → 422 with line/col.

## 6. UI Testing Section

Component: `custom-fields-renderer` used in create (`/contacts/new`), detail (`/contacts/:id`), edit modal, list columns, filters.

Checklist:

- Field-settings page: table Key/Label/Type/Required/Default/Used-in (#records)/Actions; New dropdown shows 8 types with icons + descriptions; expression builder for formula with autocomplete (`firstName`, `cf_`, `account.`), live Validate button + sample output.
- Type badges colors; drag to reorder; inline required toggle; picklist editor (add via Enter, drag reorder, deactivate switch, replace flow).
- Impact modal: counts (records/formulas/views/reports), sample values before/after, typed confirm input, Export button.
- Renderer per type:
  - text: input + counter; number: stepper + min/max hint; date: picker + clear; picklist: searchable dropdown; multi-select: pills + select-all; checkbox: switch; currency: symbol prefix + thousand separators; formula: grey read-only + `ƒx` icon + tooltip expression + copy.
- Validation UX: red border + message under field, summary at top “3 fields need attention”, focus first error on submit, aria-describedby.
- Layout editor: sections accordion, drag fields between sections, visibility eye per role, required star, Publish/Discard, version label.
- List: column picker includes customs with `Custom` tag; sorting arrows numeric-aware; filters builder shows type-correct operators (`contains` for multi, `>=` for number, `before/after` for date).
- Detail: sections as cards, empty `—`, deprecated pick badge, formula error `⚠`.
- Responsive: 375px single column, sections stack, picklist full-screen sheet on mobile.
- A11y: labels associated, switch role, picker keyboard (arrows+Enter), formula tooltip focusable.
- Loading: skeletons for customs on detail; optimistic save with rollback on 422.

Visual: snapshot each type view+edit; dark-mode contrast for badges.

## 7. Regression & Cross-Feature Impact

| Area                               | Impact                                                              | Retest                                                                |
| ---------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Contacts/Accounts/Leads/Deals CRUD | New required customs block creates                                  | Create each object without required → 422; with → 200                 |
| Imports/Exports                    | Customs mapped + validated                                          | Import with customs incl. bad pick; export headers include customs    |
| Search                             | Text customs indexed?                                               | Search nickname value via global search (per spec)                    |
| Filters/Views/Reports              | Saved views referencing renamed/deleted field                       | Open old view → graceful `field missing` message, not 500             |
| Workflows                          | Trigger on custom change; formula changes should/shouldn’t trigger? | Edit cf_score → workflow fires once; formula-only change doesn’t loop |
| Permissions                        | Admin-only section leak                                             | Rep API `GET` omits/redacts; UI absent                                |
| Merge/Dedup                        | Merge picker must include customs per-field                         | Merge two contacts with diff customs → picker rows appear             |
| Mobile                             | Renderer stacks                                                     | Smoke on 375px                                                        |
| Audit                              | Field def changes + value changes logged                            | `custom_field.*` + `contact.updated cf_*` entries                     |
| Performance                        | 20 customs × list 50 rows                                           | List <2s, no N+1 (check Network count)                                |

Run `imports-exports`, `duplicates-merge`, `reports` smoke after custom-field changes.

## 8. Expected Results Summary Table

| TC    | Feature            | Input                      | Expected                           | Pass Criteria          |
| ----- | ------------------ | -------------------------- | ---------------------------------- | ---------------------- |
| TC-01 | Text               | 60 chars                   | Block 422                          | Counter + server agree |
| TC-02 | Number             | -5/101/75.5/75             | Only 75 passes                     | 422 others             |
| TC-03 | Date               | Invalid string             | 422                                | Picker + ISO           |
| TC-04 | Picklist           | Default + Oil              | Default SaaS; Oil 422              | Server default         |
| TC-05 | Multi              | VIP+Beta                   | Pills + filter                     | Array, `[]` allowed    |
| TC-06 | Checkbox/currency  | -10/abc                    | Errors; $ format                   | Precision 2            |
| TC-07 | Formula concat     | Ada/Fintech                | `Ada Lovelace (Fintech)` read-only | Write blocked          |
| TC-08 | IF/dates/div0      | Scores                     | Healthy/Watch/Risk; null-safe      | No 500                 |
| TC-09 | Cross-object       | 1-hop vs 2-hop             | $100k vs depth block + recalc      | Messages clear         |
| TC-10 | Regex/unique       | web-123/dup nick           | Errors + 409                       | Server enforced        |
| TC-11 | Layout vis         | Admin-only                 | Rep hidden (DOM absent)            | Server too             |
| TC-12 | Renderer parity    | All types                  | Correct controls + numeric sort    | No text fallback       |
| TC-13 | Type change        | number→text / pick→number  | Cast + modal / block               | Counts shown           |
| TC-14 | Delete             | With dependents            | Block + replace + snapshot         | No breakage            |
| TC-15 | Pick ops           | Rename/deactivate/replace  | Aliased + badge + bulk             | No orphans             |
| TC-16 | Perms              | Rep manage                 | 403 manage, fill ok                | Split                  |
| TC-17 | Import/bulk/export | Customs file               | Mapped + validated + round-trip    | Parity                 |
| TC-18 | Recalc             | Bulk 1k                    | <30s, no stale                     | Job log                |
| TC-19 | Required scopes    | Global vs layout + show-if | Scopes hold                        | Server honors          |
| TC-20 | Sort/filter/report | Type-aware                 | Numeric/date ops                   | No lexicographic bug   |
| TC-21 | Keys/XSS           | Dup/reserved/script        | 409/422 + escaped                  | Safe                   |
| TC-22 | History            | 3 edits + delete           | Diffs + restore path               | Immutable              |

## 9. Troubleshooting & Common Failures

| Symptom                          | Cause                                                                  | Fix                                                                                                   |
| -------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Field not appearing on form      | Added to defs but not to layout, or layout unpublished, or role hidden | Publish layout, add to section, check visibility; hard refresh; `GET /layouts?object=contact`         |
| 422 on valid picklist            | Case/space mismatch (`fintech` vs `Fintech`) or deactivated value      | Use exact value from `GET /custom-fields`; reactivate or replace                                      |
| Formula shows `⚠` / blank        | Syntax error, missing field (deleted), div0, null ref, depth exceeded  | `POST /formulas/validate`, check impact/history, null-guard with `IFNULL`, check worker `formula.log` |
| Cross-object stale               | Recalc job pending / account link changed but job delayed              | Wait 60s, run `POST /jobs/formula/recalc`, check `accountId` link, verify revenue saved               |
| Type change blocked unexpectedly | Hidden dependents (view/report/formula)                                | `GET /custom-fields/:key/impact`, remove dependents or use Replace, include `confirmText`             |
| Delete 422 has_dependents        | Formula/view/report still refs                                         | List dependents, delete/replace them first, export snapshot                                           |
| Number sorts as 100<20           | Frontend string sort                                                   | Verify API `sort=cf_score:desc` raw order; fix renderer sortType numeric; file bug with evidence      |
| Currency shows wrong symbol      | Field code USD but locale de-DE, or code changed mid-data              | Check field `currencyCode`, locale setting, stored raw value via API                                  |
| Rep sees admin-only field in API | Visibility only client-side (bug)                                      | Confirm `GET /contacts/:id` as Rep omits/redacts; if present → security bug, escalate                 |
| Import custom column unmapped    | Header mismatch or type unsupported in mapper                          | Manual map, save template, check `dry-run` errors for type messages                                   |
| List slow with many customs      | N+1 fetch or unindexed `cf_*` JSONB                                    | Check Network waterfall, DB `GIN` index on customs JSONB, paginate 25                                 |
| Draft lost on reload             | localStorage cleared / object changed                                  | Save draft indicator, re-check layout version, use API autosave if available                          |
| `custom-fields-renderer` blank   | JS error on unknown type after downgrade                               | Console error, check `type` in defs, fallback renders `Unsupported` message not blank                 |

Logs: API `logs/custom-fields.log`, formula worker, browser console for renderer. Always capture `key`, `object`, `requestId`.

## 10. Pass/Fail Checklist

- [ ] TC-01 Text maxLength client+server
- [ ] TC-02 Number min/max/decimals
- [ ] TC-03 Date invalid → 422, ISO vs locale correct
- [ ] TC-04 Picklist default + Oil → 422
- [ ] TC-05 Multi array + `contains` filter
- [ ] TC-06 Checkbox + currency format/precision
- [ ] TC-07 Formula concat read-only + write blocked
- [ ] TC-08 IF branches + null-safe + div0 no 500
- [ ] TC-09 Cross-object 1-hop works + recalc; 2-hop/aggregate blocked with messages
- [ ] TC-10 Regex/required/unique server-enforced
- [ ] TC-11 Layout order + Admin-only hidden (DOM + API)
- [ ] TC-12 Renderer correct controls + numeric sort + saved view
- [ ] TC-13 Type-change impact modal + cast/block
- [ ] TC-14 Delete blocked with dependents + replace + snapshot
- [ ] TC-15 Pick rename/deactivate/replace bulk
- [ ] TC-16 Rep 403 manage, fill allowed, read-only disabled
- [ ] TC-17 Import/bulk/export customs parity
- [ ] TC-18 Recalc <500ms single, 1k <30s, no stale
- [ ] TC-19 Required scopes + show-if
- [ ] TC-20 Type-aware sort/filter/report
- [ ] TC-21 Key unique/reserved + XSS escaped
- [ ] TC-22 History + restore documented
- [ ] curl 1–8 expected codes
- [ ] Regression: CRUD, imports, merge picker customs, views no 500
- [ ] `custom-fields-renderer` no console errors on all objects × roles

Sign-off: Tester __________ Date __________ Objects covered (C/A/L/D) __________ Build __________
