# Accounts – Comprehensive Testing Guide

Base URLs: API `http://localhost:3001`, Web `http://localhost:3000`, Mailpit `http://localhost:8025`.

## 1. Overview

This guide covers **Accounts (Companies)** testing: Account CRUD, parent-child hierarchy, domains/industry/owner/tags, hierarchy cycle prevention, related contacts/deals rollups, search/filter, permissions, and persistence.

Scope:

- CRUD via UI (`/accounts`, `/accounts/:id`, account-detail) and API (`/accounts` or `/api/accounts` – verify prefix).
- Fields: `name` (required), `domains[]` (e.g. `acme.com`), `industry` (enum: SaaS, Fintech, Healthcare, Retail, Manufacturing, Other), `ownerId`, `tags[]`, `parentAccountId`, `website`, `phone`, `address`, `annualRevenue`, `employeeCount`, `description`.
- Hierarchy: `parentAccountId` forms tree (HQ → subsidiaries). Must prevent cycles (A parent of B, B parent of A, self-parent).
- Rules: `name` required; `domains` must be valid hostnames, unique-ish with warning; `industry` must be enum; deleting parent with children must block or reparent (verify spec).
- Success: all hierarchy rules enforced both UI + API, no orphan cycles, rollups correct, search fast.

## 2. Prerequisites & Test Data Setup

### 2.1 Environment

- API `GET http://localhost:3001/health` 200; Web `http://localhost:3000/accounts` renders within 3s.
- Test org `qa-accounts-org`. Users: `admin@qa.local (admin)`, `sales@qa.local (sales)`, `viewer@qa.local (viewer)`.
- Clear `localStorage`, open Network tab. Have 2 contacts ready for relation tests.
- Mailpit check only if account notifications enabled.

### 2.2 Seed accounts

HQ + child + standalone:

```json
{
  "name": "QA HQ Acme Holdings",
  "domains": ["acme-holdings.example.com"],
  "industry": "SaaS",
  "tags": ["hq", "enterprise"],
  "website": "https://acme-holdings.example.com",
  "annualRevenue": 50000000,
  "employeeCount": 1200
}
```

```json
{
  "name": "QA Child Acme EMEA",
  "domains": ["emea.acme-holdings.example.com"],
  "industry": "SaaS",
  "parentAccountId": "<HQ_ID>",
  "tags": ["subsidiary"]
}
```

```json
{
  "name": "QA Standalone Globex",
  "domains": ["globex-qa.example.com"],
  "industry": "Fintech",
  "tags": ["smb"]
}
```

Bulk seed for search (loop 100x):

```json
{
  "name": "Perf Account {{index}}",
  "domains": ["perf{{index}}.example.com"],
  "industry": "Retail"
}
```

Link contacts:

```json
{ "contactId": "<C1>", "accountId": "<HQ_ID>" }
```

### 2.3 Cleanup

- Prefix `QA HQ`, `QA Child`, `qa-acct-`. Delete children before parents (or test block). Verify `GET /accounts?search=QA HQ` empty post-cleanup.

## 3. Test Environment Matrix

| Dimension       | Variants                                                  |
| --------------- | --------------------------------------------------------- |
| Browser         | Chrome (primary), Firefox, Edge, Mobile 390px             |
| Viewport        | 1440px, 1280px, 768px, 390px                              |
| Role            | Admin full, Sales scoped (no delete), Viewer read-only    |
| Hierarchy depth | 1 (flat), 2 (parent-child), 4+ deep chain, cycle attempts |
| Data volume     | 0, 15, 1000+ (perf search)                                |
| Network         | Normal, Fast 3G (skeleton), Offline (error + retry)       |
| Client          | UI + curl                                                 |
| Persistence     | Refresh, relogin, second user, API re-fetch               |

Minimum: Chrome Admin+Sales, Firefox Admin, depth 1-3 + cycle cases.

## 4. Detailed Step-by-Step Test Cases

### TC-01 – UI create happy

1. Login Admin → `http://localhost:3000/accounts` → `New Account`.
2. Fill Name=`QA TC01 Stark Industries`, Domains=`stark-tc01.example.com`, Industry=`Manufacturing`, Owner=`sales@qa.local`, Tags=`enterprise,vip`, Website, Revenue, Employees.
3. Save.
   Expect: Toast `Account created`, detail `/accounts/:id` shows all fields, appears in list top.

### TC-02 – API create happy

```json
{
  "name": "QA TC02 API Account",
  "domains": ["tc02-api.example.com"],
  "industry": "SaaS",
  "tags": ["api"],
  "website": "https://tc02-api.example.com"
}
```

Expect: 201 with `id`, GET by id 200 matches.

### TC-03 – Required name validation

UI blank name + Save; API `{"domains":["x.example.com"]}`.
Expect: UI `Name is required`; API 400 `name is required`. No record.

### TC-04 – Invalid domain format

Try `not a domain`, `http://foo`, `-bad-.com`, `a`. Also `["good.example.com","bad_domain"]`.
Expect: UI inline `Enter valid domain (e.g. acme.com)`; API 400 `invalid domain: bad_domain`. No 500. Valid entry still allows save after fixing.

### TC-05 – Duplicate domain warning

1. Create A domains `["dup-acct.example.com"]`.
2. Create B same domain different name.
   Expect: UI amber warning `Domain already used by QA A (View)` with `Save anyway / Cancel`; API 409 `DUPLICATE_DOMAIN` or 201+warning. No silent merge. Document actual.

### TC-06 – Industry enum validation

UI: pick each enum, save; API: `"industry":"SaaS"` valid, `"industry":"foobar"` invalid.
Expect: All enums persist; invalid returns 400 `invalid industry`. UI select prevents free-text (or shows error if combobox).

### TC-07 – Tags + owner round-trip

UI add `q4-target`, remove `smb`; reassign owner Sales→Admin.
API PATCH `{"tags":["vip"],"ownerId":"<ADMIN_ID>"}` then GET.
Expect: Pills + avatar update, refresh persists, empty tags allowed, deduped.

### TC-08 – Parent-child create via UI

1. Open child `QA Child Acme EMEA` → Edit → Parent picker → search `Acme Holdings` → select → Save.
2. Open HQ detail → Children/Related tab.
   Expect: Child shows `Parent: QA HQ Acme Holdings (link)`, HQ shows child in children list with count `Subsidiaries (1)`. Breadcrumb `HQ / EMEA` if supported.

### TC-09 – Parent-child via API

```json
{ "parentAccountId": "<HQ_ID>" }
```

PATCH child, then `GET /accounts/<HQ_ID>?include=children` and `GET /accounts/<CHILD_ID>`.
Expect: 200, child `parentAccountId` equals HQ, HQ `children` contains child id. Null to unlink: `{"parentAccountId":null}` clears.

### TC-10 – Self-parent prevention

UI: Edit HQ → Parent picker → try select itself. API: `PATCH /accounts/<HQ_ID> {"parentAccountId":"<HQ_ID>"}`.
Expect: UI picker excludes self + shows `An account cannot be its own parent` if forced; API 400 `cannot set self as parent`. No save.

### TC-11 – Direct cycle prevention (A↔B)

Setup A parent=null, B parent=A. Attempt `PATCH A {"parentAccountId": B}`.
Expect: API 400 `hierarchy cycle detected` (or 422). UI shows red error `This would create a cycle`, parent unchanged after refresh. Verify both A,B intact.

### TC-12 – Indirect / deep cycle prevention

Chain HQ→Child→Grandchild (`G parent=Child`). Attempt `PATCH HQ {"parentAccountId": G}` (3-level cycle).
Expect: 400 cycle error. Also try moving Child under Grandchild (2-level). UI tree selector disables descendants (greyed). Verify server-side too (bypass UI via curl still 400 – critical).

### TC-13 – Valid move / reparent (non-cycle)

Move Grandchild from Child to standalone Globex: `PATCH G {"parentAccountId": Globex}`.
Expect: 200, old parent children count -1, new parent +1, breadcrumb updates, timeline logs `parent changed`.

### TC-14 – Hierarchy depth & tree rendering

Create 4-chain: L1→L2→L3→L4. Open L1 detail → Hierarchy/Tree tab.
Expect: Tree renders nested without overlap, expand/collapse works, each node link navigates, 390px stacks vertically. API `GET /accounts/<L1>?depth=4` returns nested or flat with `level`.

### TC-15 – Delete leaf (no children) happy

Delete standalone Globex via `... → Delete → Confirm`.
Expect: Redirect `/accounts`, toast, GET 404, search gone. If soft-delete, trash shows with Restore.

### TC-16 – Delete parent with children (block or cascade choice)

Attempt delete HQ with 2 children.
Expect: One of (document): (a) Block modal `Cannot delete – has 2 subsidiaries. Reassign or delete children first.` + API 400/409; (b) Choice modal `Reparent children to [select] / Delete all`. Verify no orphan `parentAccountId` pointing to deleted id (GET children shows null or new parent, never 500).

### TC-17 – Update + concurrent edit

Edit revenue/employees/website, Save. Two-tab concurrent save.
Expect: Toast `Account updated`, 200, refresh persists. Concurrent last-win or 409 version conflict – document.

### TC-18 – Search / filter / sort

Search `acme`, `globex-qa.example.com` (domain), `Manufacturing` (industry filter), tag `enterprise`, sort Name A-Z / Newest.
Expect: <500ms warm, URL params persist (`?search=acme&industry=SaaS`), empty `zzz-no-hit` shows empty state with Clear.

### TC-19 – Pagination + count consistency

Page size 20, page 2, open detail, Back, refresh.
Expect: URL `?page=2&limit=20`, `Showing 21-40 of N`, API total matches UI count, export row count matches if export exists.

### TC-20 – Permissions

Sales: New/Edit allowed, Delete hidden; direct DELETE 403. Viewer: inputs disabled, PATCH 403.
Expect: No bypass via curl; UI hides affordances.

### TC-21 – Bad IDs

`GET /accounts/!!!`, `GET /accounts/00000000-0000-0000-0000-000000000000`, PATCH/DELETE same. UI `/accounts/<bad>` .
Expect: 400 malformed, 404 missing; UI not-found page with Back link, not crash.

### TC-22 – Edge: long name, many domains, XSS, unicode

Name 300 chars, 10 domains, name `<img src=x onerror=alert(1)>`, industry case `saas` vs `SaaS`.
Expect: Length capped or 400; XSS escaped (no exec); unicode preserved; industry case-insensitive or 400 with allowed list (document). Domains lowercased/normalized (`WWW.ACME.COM` → `acme.com`? note).

### TC-23 – Related contacts & deals rollup

Link 2 contacts + 1 deal to HQ, open HQ detail.
Expect: Related tabs show 2 contacts, 1 deal, header counts `Contacts (2) Deals (1)`, clicking navigates to contact-detail/deal. Unlink contact → count decrements. Deleting account with contacts either blocks or nulls (check no orphan 500 on contact GET).

### TC-24 – Persistence & cross-session

Create `qa-acct-persist`, refresh, relogin, second admin views, API GET.
Expect: Identical fields, hierarchy intact, `createdAt/updatedAt` ISO UTC.

### TC-25 – Responsive + a11y smoke

Keyboard-only create, Esc closes modal, focus visible. 390px cards.
Expect: All reachable, no overlap, tree usable on mobile, zero console errors.

## 5. API Testing Section

### 5.1 Endpoint table

| Method | Endpoint                                                       | Auth         | Purpose              | Success                          |
| ------ | -------------------------------------------------------------- | ------------ | -------------------- | -------------------------------- |
| GET    | `http://localhost:3001/accounts`                               | Bearer       | List                 | 200 `{data,total}`               |
| GET    | `http://localhost:3001/accounts?search=acme&industry=SaaS`     | Bearer       | Search/filter        | 200 filtered                     |
| GET    | `http://localhost:3001/accounts/:id`                           | Bearer       | Get one (+children?) | 200 / 404                        |
| GET    | `http://localhost:3001/accounts/:id?include=children,contacts` | Bearer       | With relations       | 200 nested                       |
| POST   | `http://localhost:3001/accounts`                               | Bearer       | Create               | 201 / 400                        |
| PATCH  | `http://localhost:3001/accounts/:id`                           | Bearer       | Update incl. parent  | 200 / 400 cycle / 403            |
| DELETE | `http://localhost:3001/accounts/:id`                           | Bearer admin | Delete               | 200/204 / 409 has-children / 403 |
| GET    | `http://localhost:3001/accounts?parentAccountId=<id>`          | Bearer       | Children list        | 200                              |
| GET    | `http://localhost:3001/accounts?domain=acme.com`               | Bearer       | By domain            | 200                              |

### 5.2 curl examples

```bash
API=http://localhost:3001
TOKEN=<JWT>
HDR="Authorization: Bearer $TOKEN"
```

**1. Create HQ (201):**

```bash
curl -s -X POST "$API/accounts" -H "$HDR" -H "Content-Type: application/json" -d '{"name":"Curl HQ","domains":["curl-hq.example.com"],"industry":"SaaS","tags":["curl"]}' | jq .
# Expected 201 {"id":"...","name":"Curl HQ"}
```

**2. Create child linked (201):**

```bash
HQ=<HQ_ID>
curl -s -X POST "$API/accounts" -H "$HDR" -H "Content-Type: application/json" -d "{\"name\":\"Curl Child\",\"domains\":[\"child-curl.example.com\"],\"industry\":\"SaaS\",\"parentAccountId\":\"$HQ\"}" | jq .
# Expected 201 with parentAccountId==HQ
```

**3. Self-parent blocked (400):**

```bash
ID=<ACCOUNT_ID>
curl -s -w "\nHTTP:%{http_code}\n" -X PATCH "$API/accounts/$ID" -H "$HDR" -H "Content-Type: application/json" -d "{\"parentAccountId\":\"$ID\"}"
# Expected 400 {"error":"cannot set self as parent"}
```

**4. Cycle blocked (400):**

```bash
A=<A_ID>; B=<B_ID>
# Assume B parent=A already
curl -s -w "\nHTTP:%{http_code}\n" -X PATCH "$API/accounts/$A" -H "$HDR" -H "Content-Type: application/json" -d "{\"parentAccountId\":\"$B\"}"
# Expected 400 {"error":"hierarchy cycle detected"} – never 200
```

**5. Invalid industry + bad domain (400 each):**

```bash
curl -s -w "\nHTTP:%{http_code}\n" -X POST "$API/accounts" -H "$HDR" -H "Content-Type: application/json" -d '{"name":"Bad Ind","domains":["ok.example.com"],"industry":"foobar"}'
curl -s -w "\nHTTP:%{http_code}\n" -X POST "$API/accounts" -H "$HDR" -H "Content-Type: application/json" -d '{"name":"Bad Dom","domains":["not a domain"],"industry":"SaaS"}'
# Expected both 400, no record created (verify GET search empty)
```

**6. Search timing + filter (200):**

```bash
time curl -s "$API/accounts?search=acme&limit=5" -H "$HDR" | jq '{total, n:(.data|length)}'
curl -s "$API/accounts?industry=SaaS&limit=3" -H "$HDR" | jq .
# Expected 200, <0.5s warm
```

**7. Delete parent with children (409/400) then leaf (204):**

```bash
curl -s -w "\nHTTP:%{http_code}\n" -X DELETE "$API/accounts/$HQ" -H "$HDR"
# Expected 400/409 {"error":"account has children"} if block-policy
CHILD=<CHILD_ID>
curl -s -w "\nHTTP:%{http_code}\n" -X DELETE "$API/accounts/$CHILD" -H "$HDR"
curl -s -w "\nHTTP:%{http_code}\n" "$API/accounts/$CHILD" -H "$HDR"
# Expected 200/204 then 404
```

## 6. UI Testing Section

### 6.1 Routes

- `/accounts` – table (Name, Domains, Industry badge, Owner avatar, Tags, Updated), search top, filters Industry/Owner/Tag, New Account top-right, pagination footer.
- `/accounts/:id` – header (logo/initials, name, domains as links, industry badge), tabs: Overview / Contacts / Deals / Hierarchy / Timeline / Notes, Edit + `... Delete`, breadcrumb for child `HQ / Child`.
- Parent picker: searchable dropdown, shows hierarchy indent, excludes self, disables descendants (grey + tooltip `Cannot select descendant`).
- Deep link `/accounts/<id>` in new tab loads; Back returns to prior page/filters.

### 6.2 Forms

- Name required asterisk, Domains tag-input (Enter/comma, validates each chip green/red), Industry select, Owner autocomplete, Tags autocomplete, Website URL validation, Revenue/Employees numeric (no negatives – shows error).
- Dirty confirm on Cancel/Esc, duplicate-domain amber warning on blur, cycle red error on parent select (Save disabled until fixed).

### 6.3 List/tree

- Sort Name/Created/Revenue, column filters, row click → detail, checkbox bulk bar if supported.
- Hierarchy view (if exists): tree expand/collapse, counts, drag-to-reparent? – verify + cycle block on drag.
- Empty/skeleton/error states same as contacts; search debounce 300ms.

### 6.4 Visual

- 1440px full table, domains truncated with tooltip, badges contrastive in dark/light.
- 390px cards, hierarchy indented but not overflowing, New button sticky.
- Zero console errors on happy path.

## 7. Regression & Cross-Feature Impact

- **Contacts:** Account link/unlink updates contact `accountId` + account `contactsCount`; deleting account nulls or blocks (no orphan 500 on `GET /contacts?accountId=<deleted>`).
- **Deals:** Account deals rollup sum must update after reparent? – verify if rollup is per-account or subtree (document). Deleting account with open deals warns.
- **Timeline:** Create/update/reparent/tag changes emit entries (see activity-timeline guide).
- **Search global:** New account indexed in global palette within 5s.
- **Workflows:** `on account created` automation (e.g. assign owner by territory) – check no double-assign, Mailpit if email step.
- **Reports:** Accounts-by-industry chart increments; hierarchy depth does not break report grouping.
- **Permissions:** Demote admin→sales mid-session hides Delete after refresh.

## 8. Expected Results Summary Table

| TC    | Title             | Expected                 | Must |
| ----- | ----------------- | ------------------------ | ---- |
| TC-01 | UI create         | Toast + detail           | Yes  |
| TC-02 | API create        | 201                      | Yes  |
| TC-03 | Name required     | Inline + 400             | Yes  |
| TC-04 | Domain invalid    | Inline + 400             | Yes  |
| TC-05 | Dup domain        | Warning/409              | Yes  |
| TC-06 | Industry enum     | Persist, invalid 400     | Yes  |
| TC-07 | Tags/owner        | Persist                  | Yes  |
| TC-08 | UI parent-child   | Bidirectional            | Yes  |
| TC-09 | API parent        | 200 + children include   | Yes  |
| TC-10 | Self-parent       | Blocked 400              | Yes  |
| TC-11 | Direct cycle      | 400, unchanged           | Yes  |
| TC-12 | Deep cycle        | 400 server-side          | Yes  |
| TC-13 | Valid reparent    | Counts update            | Yes  |
| TC-14 | Depth/tree        | Renders 4-deep           | No   |
| TC-15 | Delete leaf       | 404 after                | Yes  |
| TC-16 | Delete parent     | Block/choice, no orphans | Yes  |
| TC-17 | Update/concurrent | 200                      | No   |
| TC-18 | Search/filter     | <500ms, URL persist      | Yes  |
| TC-19 | Pagination        | Totals match             | Yes  |
| TC-20 | Permissions       | 403, hidden              | Yes  |
| TC-21 | Bad IDs           | 400/404 + not-found page | Yes  |
| TC-22 | Edge XSS/long     | Escaped/handled          | Yes  |
| TC-23 | Rollups           | Counts correct           | Yes  |
| TC-24 | Persistence       | Cross-session identical  | Yes  |
| TC-25 | Responsive/a11y   | Keyboard+mobile          | No   |

## 9. Troubleshooting & Common Failures

- **Cycle passes via API but blocked in UI:** Frontend-only check – critical bug. Verify backend validates full ancestry walk (recursive CTE or loop with visited set). Attach curl TC-11/12 proof.
- **Self-parent allowed:** Picker excludes self but API missing check – same fix, add `if parent==id → 400`.
- **Orphan parentId after delete:** Delete does not null children – `GET /accounts/<child>` returns `parentAccountId` pointing to 404, UI breadcrumb crashes (`Cannot read name of undefined`). Fix: block or null/cascade + test TC-16.
- **Infinite loop rendering tree:** Cycle in DB (legacy data) causes frontend stack overflow. Backend must reject + migration to clean existing cycles; frontend should guard with visited set + `Cycle detected` fallback.
- **Domain case duplicates:** `Acme.com` vs `acme.com` treated distinct – normalize to lowercase + trim, unique index on normalized.
- **Industry free-text saved:** Select allows typing new value and API accepts – should be 400 unless custom industries enabled. Check enum validator.
- **Children count stale:** Cached count not invalidated on reparent – refresh shows old counts, API `children.length` vs `childrenCount` mismatch. Invalidate or compute live.
- **Search slow:** Missing GIN/trigram index on name/domains. Warm test, limit 20, check EXPLAIN.
- **CORS/403 UI-only:** Curl 200 but UI fails – check CORS origin `http://localhost:3000` and Bearer forwarding.

## 10. Pass/Fail Checklist

- [ ] TC-01–TC-07 CRUD + validation pass (Admin/Chrome).
- [ ] TC-08–TC-09 parent-child bidirectional + unlink nulls.
- [ ] TC-10–TC-12 self/direct/deep cycles blocked via UI **and** curl (attach 400 logs).
- [ ] TC-13 valid reparent updates counts + breadcrumb.
- [ ] TC-14 4-deep tree renders desktop + mobile.
- [ ] TC-15–TC-16 leaf delete 404, parent block/choice with no orphans.
- [ ] TC-18 search <500ms warm, filters URL-persist.
- [ ] TC-20 403 for sales-delete + viewer-write via UI + curl.
- [ ] TC-21 bad IDs 400/404 + UI not-found.
- [ ] TC-22 XSS escaped, long/domains handled.
- [ ] TC-23 rollups correct after link/unlink/reparent.
- [ ] API curls 1-7 executed with statuses logged.
- [ ] Responsive 390px + keyboard smoke, zero console errors.
- [ ] Cleanup: `QA HQ/Child` + `curl-*` deleted (children first), search empty.
- [ ] Evidence: tree screenshot, cycle error screenshot, curl logs, matrix table.

> Sign-off: Tester __________ Date __________ Commit __________ PASS / FAIL with defects __________.
