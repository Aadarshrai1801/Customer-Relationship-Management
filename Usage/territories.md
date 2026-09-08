# Territories – Comprehensive Testing Guide

## 1. Overview

This guide covers rule-based Territory matching: field/operator/value conditions including `email_domain`, owner suggestion (not auto-assign), priority, and UI hints.
Scope includes territory CRUD, condition builder (field, operator, value, AND/OR), email_domain extraction, match preview/dry-run, owner suggestion banner on Lead detail, accept/dismiss suggestion, assignment vs suggestion precedence with routing, bulk re-evaluation, logs, permissions.
Base URLs:

- API: `http://localhost:3001`
- Web: `http://localhost:3000`
  Example: Territory `West Enterprise` where `region == West AND email_domain == acme.com` suggests Owner Rep A. Lead `john@acme.com` + region West matches.
  Success criteria: matching is deterministic, email_domain parsed case-insensitive after `@`, suggestion shown <2s, accept updates owner + logs, dismiss hides without changing owner, no auto-overwrite without confirm.

## 2. Prerequisites & Test Data Setup

- Admin token (manage territories), Rep tokens.
- Backup existing territories: `GET /api/territories` save JSON.
- Create test territories:

```json
{
  "name": "Test West Acme",
  "isActive": true,
  "priority": 1,
  "ownerId": "repA_id",
  "rules": [
    { "field": "region", "operator": "equals", "value": "West" },
    { "field": "email_domain", "operator": "equals", "value": "acme.com" }
  ],
  "matchType": "all"
}
```

```json
{
  "name": "Test India SMB",
  "isActive": true,
  "priority": 2,
  "ownerId": "repB_id",
  "rules": [
    { "field": "country", "operator": "equals", "value": "India" },
    { "field": "companySize", "operator": "in", "value": ["SMB", "Mid-Market"] }
  ],
  "matchType": "all"
}
```

```json
{
  "name": "Test Any Referral",
  "isActive": true,
  "priority": 10,
  "ownerId": "repC_id",
  "rules": [{ "field": "source", "operator": "equals", "value": "Referral" }],
  "matchType": "any"
}
```

- Test leads:

```json
{ "firstName": "Terr", "lastName": "MatchWest", "email": "boss@acme.com", "company": "Acme", "region": "West", "country": "USA" }
{ "firstName": "Terr", "lastName": "IndiaSMB", "email": "founder@startup.in", "company": "Startup", "country": "India", "companySize": "SMB" }
{ "firstName": "Terr", "lastName": "NoMatch", "email": "nomatch@other.org", "company": "Other", "region": "East", "country": "USA" }
```

- Know operator set under test: `equals, not_equals, contains, starts_with, ends_with, in, not_in, exists, regex` – adjust to actual API.
- Cleanup: delete `Test *` territories + `Terr *` leads.

## 3. Test Environment Matrix

| Dimension          | Variants                                                                   |
| ------------------ | -------------------------------------------------------------------------- |
| API                | `http://localhost:3001`                                                    |
| Web                | `http://localhost:3000`                                                    |
| Browsers           | Chrome, Firefox                                                            |
| Roles              | Admin (CRUD), Rep (view suggestion, accept if owner/admin), Viewer (read)  |
| MatchType          | all (AND), any (OR)                                                        |
| Fields             | region, country, companySize, source, email_domain, company, title, rating |
| Operators          | equals, contains, in, etc.                                                 |
| Priority           | Overlapping territories, tie, no match                                     |
| Evaluation Trigger | On create, on edit, manual Re-evaluate, bulk                               |

- Isolate: use unique email domains `acme-test-<ts>.com` to avoid matching prod territories; pause overlapping prod rules or set test priority 0.

## 4. Detailed Step-by-Step Test Cases

### TC01 – Create Territory Happy Path (UI)

- Steps as Admin: `http://localhost:3000/settings/territories` -> New -> Name `E2E West Acme`, Owner Rep A, Add rule `region equals West` + `email_domain equals acme.com`, matchType all, priority 1, Save.
- Expected: Appears in list with Active badge, rules rendered human-readable, toast success. `GET` contains it.

### TC02 – Create Territory (API)

- Steps: `POST /api/territories` with Test India SMB payload.
- Expected: `201` with id, rules persisted exactly, ownerId resolved. List sorted by priority.

### TC03 – Exact Match Suggests Owner (Core)

- Steps: Create lead `boss@acme.com` region West. Open detail as Admin.
- Expected: Banner `Suggested owner: Rep A via Test West Acme (region=West + email_domain=acme.com)` within 2s. API `GET /api/leads/:id/territory-match` or embedded `suggestedOwner` returns same. No auto owner change yet.

### TC04 – Email Domain Parsing Edge Cases

- Steps: Create leads with emails `BOSS@ACME.COM` (upper), `boss@mail.acme.com` (subdomain), `boss@acme.com ` (trailing space), `invalid-email`, `boss@acme.co` (similar).
- Expected: Upper + trimmed matches (case-insensitive, trimmed). Subdomain does NOT match `acme.com` unless operator is `ends_with` – document. Invalid email -> no match, no 500. Similar domain no match.

### TC05 – MatchType ALL vs ANY

- Steps: Territory ALL requires region West + domain acme.com; Territory ANY requires source Referral OR region West. Test lead West + other.com, lead East + Referral, lead East + Web.
- Expected: ALL matches only when both true; ANY matches when either true. UI shows which rules passed/failed in preview (`✓ region`, `✗ email_domain`).

### TC06 – Operator Coverage (contains/in/starts_with)

- Steps: Create territories: `company contains Labs`, `country in [India, USA]`, `title starts_with VP`, `email_domain ends_with .in`.
- Expected: Each matches correctly. `in` with array works, `contains` case-insensitive, `starts_with` anchored. Invalid operator returns `400`.

### TC07 – Priority – Overlapping Territories First Wins

- Steps: Two territories both match same lead (West Acme priority1 RepA, Any Referral priority10 RepC). Create lead matching both.
- Expected: Suggestion is priority1 RepA. UI lists `Also matched: Test Any Referral` secondary. Changing priority order flips suggestion.

### TC08 – No Match State

- Steps: Create `nomatch@other.org` East USA Web.
- Expected: No banner, API returns `{ matched: false, suggestions: [] }`, owner stays as created/routed. Dry-run preview shows `No territories matched`.

### TC09 – Accept Suggestion Updates Owner

- Steps: On matched lead click `Apply / Accept suggestion`.
- Expected: Confirm modal -> owner becomes RepA, toast, timeline `Owner changed via territory Test West Acme by <user>`, suggestion banner dismissed, routing log notes manual override if routing had assigned different.

### TC10 – Dismiss Suggestion Keeps Owner

- Steps: On another matched lead click `Dismiss` with reason (optional).
- Expected: Banner hides, owner unchanged, `dismissedSuggestions: [territoryId]` persisted so refresh does not reshow (or reshow after field change – document). Audit entry `suggestion dismissed`.

### TC11 – Edit Lead Re-triggers Matching

- Steps: Create non-matching lead East + other.org (no suggestion), edit region to West + email to @acme.com.
- Expected: Suggestion appears within 2s without refresh (or after save + poll). Changing back to non-match hides banner. `updatedAt` triggers re-eval.

### TC12 – Dry-Run / Preview Before Save

- Steps: In territory editor click `Preview / Test` with sample lead JSON or leadId.
- Expected: Shows matched sample leads count + 5 examples with pass/fail per rule. No side effects (no owner changes). Preview <2s for 1000 leads or shows progress.

### TC13 – Bulk Re-evaluate All Leads

- Steps: Create territory, then click `Re-evaluate all` or `POST /api/territories/:id/reevaluate`.
- Expected: Progress `Evaluating 250 leads...`, summary `42 matched, 0 owners auto-changed (suggestions only)`. No timeout for 500 leads. Log `bulk_reevaluate by admin`.

### TC14 – Inactive Territory Ignored

- Steps: Deactivate Test West Acme, create matching lead.
- Expected: No suggestion, preview excludes it, list shows gray Inactive. Reactivate restores matching.

### TC15 – Territory vs Routing Precedence

- Steps: Setup routing RR to RepB + territory suggests RepA for same lead. Create lead.
- Expected: Owner = routing assignment (auto), suggestion = territory RepA banner still shows `Suggested RepA differs from current RepB`. Accepting suggestion overrides routing with both logs preserved. Document precedence – neither silently wins.

### TC16 – Permissions – Rep Cannot Manage Territories

- Steps: As Rep open settings/territories, try create/edit/delete; API with Rep token.
- Expected: UI hidden or read-only with `Admin only`, API `403`. Rep CAN accept/dismiss suggestion on owned lead (or only Admin – document).

### TC17 – Validation – Bad Field/Operator/Value

- Steps: POST territory with `field: hackerField`, `operator: ~=`, `value: ""`, empty rules array, missing ownerId.
- Expected: `400` with per-rule errors, no persist. UI inline errors, Save disabled. Existing territories untouched.

### TC18 – Delete Territory Cleanup

- Steps: Delete Test West Acme while suggestions pending.
- Expected: Confirm `N leads have pending suggestions`, delete succeeds, existing owners kept, pending banners removed, history retains `territoryName (deleted)` snapshot not null id crash.

### TC19 – Large Value / Regex Safety

- Steps: Create rule with 500-char value, regex `.*@acme\.com$`, invalid regex `[`.
- Expected: Long value stored or `400 too long` with limit; valid regex matches; invalid regex `400 invalid regex` without ReDoS hang (<1s response).

### TC20 – Performance – 1000 Leads Match Query

- Steps: Seed 1000 leads, time `GET /api/territories/:id/preview` and lead-create suggestion latency.
- Expected: Preview p95 <3s, create suggestion <500ms added latency. No full table scan timeout. Pagination for preview.

### TC21 – Audit Log for Territory Changes (Bonus)

- Steps: Create -> edit rules -> change owner -> deactivate as Admin, check `GET /api/territories/:id/audit` or Activity.
- Expected: All changes logged with actor, timestamp, diff. Lead suggestions reference territory version or name snapshot.

### TC22 – Email Domain with Plus/International (Bonus)

- Steps: Emails `user+tag@acme.com`, `user@xn--p1ai.ru` (punycode), `user@startup.in`.
- Expected: Plus address domain still `acme.com` matches; international handled or documented; `.in` ends_with works.

## 5. API Testing Section

| Method & Endpoint                                                       | Purpose                   | Expected                                         |
| ----------------------------------------------------------------------- | ------------------------- | ------------------------------------------------ |
| `POST /api/territories`                                                 | Create                    | 201                                              |
| `GET /api/territories`                                                  | List by priority          | 200 sorted                                       |
| `GET /api/territories/:id`                                              | Detail                    | 200                                              |
| `PATCH /api/territories/:id`                                            | Update rules/owner/active | 200, 400 validation                              |
| `DELETE /api/territories/:id`                                           | Delete                    | 204                                              |
| `GET /api/leads/:id/territory-match` (or `POST /api/territories/match`) | Evaluate single lead      | 200 `{ matched, territoryId, suggestedOwnerId }` |
| `POST /api/territories/:id/preview` or `GET .../preview`                | Dry-run                   | 200 `{ matchedCount, samples }`                  |
| `POST /api/territories/:id/reevaluate`                                  | Bulk                      | 202 + job id or 200 summary                      |

```bash
# 1. Login admin
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@test.com","password":"Admin123!"}'

# 2. Create territory with email_domain rule
curl -X POST http://localhost:3001/api/territories \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{
    "name": "Test West Acme",
    "isActive": true,
    "priority": 1,
    "ownerId": "REP_A_ID",
    "matchType": "all",
    "rules": [
      {"field":"region","operator":"equals","value":"West"},
      {"field":"email_domain","operator":"equals","value":"acme.com"}
    ]
  }'

# 3. Create matching lead
curl -X POST http://localhost:3001/api/leads \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"firstName":"Terr","lastName":"MatchWest","email":"boss@acme.com","company":"Acme","region":"West"}'

# 4. Evaluate match (adjust path to actual API)
curl http://localhost:3001/api/leads/LEAD_ID/territory-match \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Alt: POST match endpoint
curl -X POST http://localhost:3001/api/territories/match \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"leadId":"LEAD_ID"}'

# 5. Preview territory against samples
curl -X POST http://localhost:3001/api/territories/TERR_ID/preview \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"limit":5}'

# 6. Accept suggestion (assign owner) - via lead patch
curl -X PATCH http://localhost:3001/api/leads/LEAD_ID \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"ownerId":"REP_A_ID"}'

# 7. Invalid rule (expect 400)
curl -X POST http://localhost:3001/api/territories \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"name":"Bad","priority":1,"ownerId":"REP_A_ID","matchType":"all","rules":[{"field":"hacker","operator":"~=","value":""}]}'
```

- If match endpoint differs, discover via Network tab when opening lead detail (look for `territory` XHR) and update doc.

## 6. UI Testing Section

- Territories list: Name, Owner avatar, Rules summary chips (`region=West`, `email_domain=acme.com`), Priority number, Active toggle, Matched count, Actions. Sort by priority drag or number.
- Editor: field dropdown (includes email_domain with hint `part after @`), operator dropdown filtered per field type, value input (text vs multiselect for `in`), Add/Remove rule rows, matchType radio `All/Any`, priority stepper, owner selector, Preview button + results panel with ✓/✗ per rule.
- Lead detail: suggestion banner blue with owner avatar, territory name link, `Apply` primary + `Dismiss` ghost, `Why?` expander showing rule breakdown. No auto-change without click.
- Empty states: `No territories yet` with Create CTA; `No match` hidden banner (not error).
- Responsive: rule rows stack on tablet, banner wraps without covering Convert button.
- A11y: all selects labelled, banner `role=status`, Apply/Dismiss keyboard reachable, focus returns to banner after dismiss.

## 7. Regression & Cross-Feature Impact

- Lead CRUD: edit region/email re-evaluates; create triggers both routing + territory – verify both logs coexist.
- Routing: precedence documented; accepting territory suggestion logs override; routing pointer not rewound.
- Web-to-Lead: public leads with email_domain match show suggestion same as manual.
- Conversion: suggested but unapplied owner – conversion propagates current owner, not suggested; warn `Pending suggestion` before Convert.
- Dashboard: territory coverage report (leads per territory) matches preview counts.
- Search: filter `territory:Test West Acme` if supported returns matched leads.

## 8. Expected Results Summary Table

| TC   | Title            | Expected        | Pass Criteria        |
| ---- | ---------------- | --------------- | -------------------- |
| TC01 | Create UI        | List + toast    | Rules readable       |
| TC02 | Create API       | 201             | Sorted priority      |
| TC03 | Exact match      | Banner <2s      | API same             |
| TC04 | Domain edges     | Case/trim match | Subdomain documented |
| TC05 | ALL vs ANY       | ✓/✗ preview     | Logic correct        |
| TC06 | Operators        | All match       | 400 bad op           |
| TC07 | Priority wins    | P1 suggested    | Also-matched listed  |
| TC08 | No match         | Hidden banner   | `matched:false`      |
| TC09 | Accept           | Owner updates   | Both logs            |
| TC10 | Dismiss          | Owner kept      | No reshow            |
| TC11 | Edit retrigger   | Banner <2s      | Hide on unmatch      |
| TC12 | Preview          | Count+samples   | No side effects      |
| TC13 | Bulk reeval      | Summary         | No timeout           |
| TC14 | Inactive ignored | No banner       | Gray badge           |
| TC15 | Vs routing       | Both logs       | Documented win       |
| TC16 | Rep 403          | Read-only       | Own accept per spec  |
| TC17 | Validation 400   | Inline          | No persist           |
| TC18 | Delete cleanup   | Owners kept     | History snapshot     |
| TC19 | Regex safe       | <1s             | 400 bad regex        |
| TC20 | Perf 1000        | Preview <3s     | Create +<500ms       |
| TC21 | Audit            | Diff logged     | Version ref          |
| TC22 | Plus/i18n        | Domain correct  | Documented           |

## 9. Troubleshooting & Common Failures

- No suggestion for obvious match: territory `isActive:false` or priority shadowed by higher rule – check list active + priority; verify lead field names (`region` vs `state`) and `email_domain` lowercased.
- `email_domain` always null: backend parses `email` only on create, not edit – re-create lead instead of patch; check invalid email format yields null domain without 500.
- Suggestion shows but Accept 403 as Rep: only Admin/owner can apply – re-login as owner or Admin; check `ownerId` vs current user.
- Preview 0 matches but detail shows match: preview queries stale index or different `matchType` – hard refresh, verify territory id same, check `isActive` filter in preview.
- Priority change no effect: frontend sort cached – refresh list, verify `GET /api/territories` order changed; suggestion caches 30s – wait or re-edit lead to force re-eval.
- `400 invalid operator` for valid: operator list case-sensitive (`Equals` vs `equals`) – use lowercase; check docs for `eq` vs `equals` alias.
- Bulk reevaluate timeout 504: too many leads synchronous – expect `202` job + poll `GET /api/jobs/:id`; if sync, reduce batch or run off-peak.
- Deleted territory banner still shows: frontend cache – clear, verify `GET .../territory-match` returns `matched:false`; check history snapshot vs live lookup confusion.
- Subdomain `mail.acme.com` matched unexpectedly: operator `contains acme.com` matches subdomain – switch to `equals` for exact; document contains vs equals semantics.
- CORS/404 on `/territory-match`: path is `/api/territories/match` POST – inspect Network tab on lead open, update curls.

## 10. Pass/Fail Checklist

- [ ] TC01–TC02 territories created via UI + API with email_domain rules
- [ ] TC03 exact match suggests owner <2s via banner + API
- [ ] TC04 domain case/trim/subdomain/invalid handled without 500
- [ ] TC05 ALL/ANY logic correct with per-rule ✓/✗ preview
- [ ] TC06 operator coverage passes, bad operator 400s
- [ ] TC07 priority first-wins, also-matched listed
- [ ] TC08 no-match hides banner, API matched:false
- [ ] TC09 Accept updates owner + logs + dismisses banner
- [ ] TC10 Dismiss keeps owner, persists hidden
- [ ] TC11 edit re-triggers match <2s both directions
- [ ] TC12 preview shows count+samples with zero side effects
- [ ] TC13 bulk re-evaluate summarizes without timeout
- [ ] TC14 inactive ignored, reactivate restores
- [ ] TC15 routing vs territory precedence documented, both logs kept
- [ ] TC16 Rep blocked from CRUD (403), accept per spec
- [ ] TC17 bad field/operator/value 400s, no persist
- [ ] TC18 delete keeps owners, clears banners, history snapshot
- [ ] TC19 long/regex safe, bad regex 400 <1s
- [ ] TC20 perf: preview <3s, create +<500ms for 1000 leads
- [ ] TC21 audit diff logged
- [ ] TC22 plus/i18n domains handled/documented
- [ ] All curls executed, actual match path confirmed
- [ ] Regression: routing, web-to-lead, conversion, dashboard intact
- [ ] Cleanup: Test territories + Terr leads deleted
- Tester: _______________ Date: _______________ Territory IDs: _______________ Result: PASS / FAIL
