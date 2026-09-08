# Competitors – Comprehensive Testing Guide

## 1. Overview

This guide covers Competitor catalog linked to Deals for win/loss analysis.
Scope includes competitor CRUD (name, website, strengths/weaknesses, tier), linking to deals (primary competitor + beaten/lost-to), win/loss reason integration, win-rate reports per competitor, de-duplication, archive vs delete with linked deals, permissions, audit.
Base URLs:

- API: `http://localhost:3001`
- Web: `http://localhost:3000`
  Example competitor:

```json
{
  "name": "Acme Rival",
  "website": "https://acmerival.com",
  "tier": "Tier 1",
  "strengths": "Cheaper",
  "weaknesses": "Poor support"
}
```

Link on deal close: `PATCH /api/deals/:id { stageId: LOST, lossReason: "Competitor", competitorId: "COMP_ID" }`.
Success criteria: catalog searchable, deal links persist + show on both sides (deal detail + competitor profile with W/L record), reports accurate, delete blocked when linked (or migrates to null with history).

## 2. Prerequisites & Test Data Setup

- Admin (catalog CRUD), Rep (link on owned deals), Viewer (read).
- Backup `GET /api/competitors` if exists.
- Seed competitors:

```json
{ "name": "E2E Rival Alpha", "website": "https://rival-alpha.test", "tier": "Tier 1", "strengths": "Low price", "weaknesses": "Weak support" }
{ "name": "E2E Rival Beta", "website": "https://rival-beta.test", "tier": "Tier 2", "strengths": "Brand", "weaknesses": "Slow delivery" }
{ "name": "E2E Rival Gamma Duplicate", "website": "https://rival-alpha.test" }
```

- Seed deals: 3 open deals `E2EDeal_Comp1/2/3` in Proposal/Negotiation for linking; 1 already Lost to Alpha, 1 Won vs Beta for report baseline.
- Pipeline Won/Lost stage ids needed (see `pipelines.md`).
- Loss reasons requiring competitor: `Competitor` (see deals-pipeline TC12).
- Cleanup: delete `E2E Rival*` + `E2EDeal_Comp*` after unlinking.

## 3. Test Environment Matrix

| Dimension   | Variants                                                               |
| ----------- | ---------------------------------------------------------------------- |
| API         | `http://localhost:3001`                                                |
| Web         | `http://localhost:3000`                                                |
| Browsers    | Chrome, Firefox                                                        |
| Roles       | Admin (CRUD), Rep owner/non-owner (link owned only), Viewer (read)     |
| Competitors | 0 (empty), 3 seeded, 100 perf                                          |
| Link Points | On Lost, On Won (beaten), Multiple competitors per deal (if supported) |
| Reports     | Per-competitor W/L, overall win-rate, filter by pipeline/date          |

- Record competitor ids + deal ids used for traceability.

## 4. Detailed Step-by-Step Test Cases

### TC01 – Create Competitor Happy Path (UI)

- Steps as Admin: `http://localhost:3000/competitors` (or Settings) -> New -> Name `E2E Rival Alpha`, Website `https://rival-alpha.test`, Tier Tier 1, Strengths/Weaknesses, Save.
- Expected: Appears in catalog with avatar initials, toast, `GET /api/competitors/:id` matches. Website link clickable.

### TC02 – Create Competitor (API)

- Steps: `POST /api/competitors` with Beta JSON.
- Expected: `201` with id, fields exact. Duplicate name check per TC05.

### TC03 – Required Validation (Name Unique, Website Format)

- Steps: Try empty name, whitespace, 200-char name, invalid website `not-url`, duplicate `E2E Rival Alpha` case-variant `e2e rival alpha`.
- Expected: Inline + `400` (`name required`, `invalid website`, `duplicate`), no record. Valid `https://` + bare `rival.test` handling documented.

### TC04 – Edit Competitor (Strengths/Tier)

- Steps: Edit Alpha tier Tier1->Tier2, strengths text, Save via UI + `PATCH /api/competitors/:id`.
- Expected: Updates everywhere incl. deal detail competitor chip, audit diff, no duplicate created.

### TC05 – Duplicate Detection (Name + Website)

- Steps: Create `E2E Rival Alpha` again + Gamma with same website as Alpha.
- Expected: Warn `Possible duplicate (name/website)` with View link, block or allow with `Create anyway` + audit. API `409` or `200 with warning` – document. No silent duplicate.

### TC06 – Search / Filter / Sort Catalog

- Steps: Seed 15 competitors, search `rival`, filter Tier1, sort Name asc, paginate.
- Expected: Case-insensitive partial, filter AND, sort stable, pagination `total` correct, no dups.

### TC07 – Link Competitor on Lost Deal (Core UI)

- Steps: Open `E2EDeal_Comp1`, Move to Closed Lost, select Loss Reason `Competitor`, pick `E2E Rival Alpha`, add notes, Confirm.
- Expected: Deal shows Lost + `Lost to E2E Rival Alpha` link, competitor profile `Losses +1` + deal in `Deals Lost` list, timeline `Lost to Alpha (Price)`. Without competitor when reason=Competitor -> blocked (see TC12).

### TC08 – Link Competitor on Won Deal (Beaten)

- Steps: Close `E2EDeal_Comp2` as Won with `Competitor Beaten: Beta`.
- Expected: Deal shows `Beat Beta`, Beta profile `Wins-against +1` (or `losses` from competitor view), report reflects. Field optional for Won (no block if empty).

### TC09 – Link via API Parity

- Steps: `PATCH /api/deals/:id { stageId: LOST, lossReason: Competitor, competitorId: ALPHA }` and `GET /api/competitors/:id/deals`.
- Expected: `200`, both sides linked, `GET /api/deals/:id` includes `competitor: { id, name }`. Invalid `competitorId` -> `404`.

### TC10 – Change / Remove Linked Competitor

- Steps: On lost deal change Alpha->Beta, then clear competitor (keep Lost with reason Price).
- Expected: Counters decrement/increment correctly (Alpha -1, Beta +1), timeline logs each change, clearing allowed only if reason != Competitor (else blocked `Competitor required when reason=Competitor`).

### TC11 – Multiple Competitors per Deal (If Supported)

- Steps: Try linking 2 competitors to one deal via UI multi-select + API array `competitorIds: [A,B]`.
- Expected: If supported, both shown + reports split; if single-only, second replaces first with confirm + `400 array not supported` via API – document which.

### TC12 – Loss Reason Required + Competitor Conditional Required

- Steps: Lost without reason -> blocked; Lost reason Competitor without competitor -> blocked; Lost reason Price without competitor -> allowed.
- Expected: UI disables Confirm + inline `Competitor required`, API `400 competitorId required when lossReason=Competitor`. Verify exact error key.

### TC13 – Competitor Profile Win/Loss Record

- Steps: Open Alpha profile after 1 Lost-to + 1 Beaten (lost deal vs won deal).
- Expected: Header `W 1 / L 1 (50%)` + lists with links + filter by date/pipeline. Counts match `GET /api/competitors/:id/stats`. No double-count on edit (changing deal stage updates, not appends).

### TC14 – Win-Rate Report Accuracy

- Steps: With known fixtures (2 Lost to Alpha, 1 Won vs Alpha, 1 open vs Alpha ignored), open Reports `Win/Loss by Competitor`.
- Expected: Alpha shows 1-2 (33% win), open excluded, drill-down links correct, export CSV matches UI. Date filter narrows correctly.

### TC15 – Reopen Linked Deal Updates Counters

- Steps: Reopen Lost-to-Alpha deal to Negotiation.
- Expected: Alpha `Losses -1` (back to prior), report updates, deal competitor link retained as `Last competitor` history or cleared – document. Timeline logs reopen.

### TC16 – Archive vs Delete Competitor with Links

- Steps: Archive Alpha (if supported) -> check catalog filter + linked deals still show name (grayed). Try Delete Alpha with 2 linked deals.
- Expected: Archive hides from picker for new deals but history kept. Delete blocked `Has N linked deals` with list + options `Reassign to [Beta]` or `Archive instead`. No silent null FK. Force delete (if admin override) sets `competitor: null` + history `Alpha (deleted)` snapshot.

### TC17 – Permissions – Rep Cannot CRUD Catalog

- Steps: As Rep try New/Edit/Delete competitor UI + API; as Rep link competitor on owned vs unowned deal.
- Expected: Catalog CRUD `403` + hidden buttons, link on owned `200`, on unowned `403` + UI picker disabled. Viewer read-only both.

### TC18 – Unauthenticated Block

- Steps: `GET /api/competitors` without token, open `/competitors` logged out.
- Expected: `401` + login redirect, no data leak.

### TC19 – XSS / Long Text in Competitor Fields

- Steps: Name `<script>alert(1)</script>`, strengths 5000 chars + emoji, website `javascript:alert(1)`.
- Expected: Escaped rendering (no alert), website validated to http(s) only (`400` for javascript:), long text truncated with `Show more` + `400` if over limit.

### TC20 – Bulk Import Competitors (If Supported)

- Steps: Import CSV 10 with 1 dup + 1 bad URL.
- Expected: 8 created, 1 skipped dup, 1 failed with row errors. Report downloadable. No partial corrupt.

### TC21 – Competitor Picker UX on Deal (Bonus)

- Steps: In Lost modal type `alp` in competitor autocomplete.
- Expected: Debounced search <300ms, shows Alpha with tier, keyboard navigable, Create-new inline `+ Add E2E Rival Delta` works without leaving modal.

### TC22 – Performance – 200 Competitors + 1000 Deals Report (Bonus)

- Steps: Seed scale, open report + picker search.
- Expected: Report <3s, picker search <500ms with server pagination, no freeze.

## 5. API Testing Section

| Method & Endpoint                            | Purpose        | Expected                                |
| -------------------------------------------- | -------------- | --------------------------------------- |
| `POST /api/competitors`                      | Create         | 201                                     |
| `GET /api/competitors?search=&tier=&page=`   | List/search    | 200 paginated                           |
| `GET /api/competitors/:id`                   | Detail + stats | 200                                     |
| `PATCH /api/competitors/:id`                 | Edit           | 200, 400 validation, 403 rep            |
| `DELETE /api/competitors/:id`                | Delete (guard) | 204 empty, 400 has links                |
| `PATCH /api/deals/:id` with competitorId     | Link on close  | 200, 400 missing competitor, 404 bad id |
| `GET /api/competitors/:id/deals` or `/stats` | Linked + W/L   | 200                                     |

```bash
# 1. Login admin
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@test.com","password":"Admin123!"}'

# 2. Create competitor
curl -X POST http://localhost:3001/api/competitors \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"name":"E2E Rival Alpha","website":"https://rival-alpha.test","tier":"Tier 1","strengths":"Low price","weaknesses":"Weak support"}'

# 3. List/search
curl "http://localhost:3001/api/competitors?search=rival&tier=Tier%201&page=1&limit=10" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# 4. Link on Lost (core)
curl -X PATCH http://localhost:3001/api/deals/DEAL_ID \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"stageId":"STAGE_LOST_ID","lossReason":"Competitor","lossNotes":"Chose Alpha on price","competitorId":"COMP_ALPHA_ID"}'

# 5. Lost reason Competitor WITHOUT competitor (expect 400)
curl -X PATCH http://localhost:3001/api/deals/DEAL_ID2 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"stageId":"STAGE_LOST_ID","lossReason":"Competitor"}'

# 6. Won vs competitor (beaten)
curl -X PATCH http://localhost:3001/api/deals/DEAL_ID3 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"stageId":"STAGE_WON_ID","winReason":"Strong PoC","competitorId":"COMP_BETA_ID"}'

# 7. Competitor stats/linked deals
curl http://localhost:3001/api/competitors/COMP_ALPHA_ID/stats \
  -H "Authorization: Bearer $ADMIN_TOKEN"
curl "http://localhost:3001/api/deals?competitorId=COMP_ALPHA_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

- Verify counters: stats `wins/losses` change ±1 on link/change/reopen.

## 6. UI Testing Section

- Catalog page: table/cards Name+logo/initials, Website link, Tier badge, W/L record pill, Linked deals count, Actions. Search + Tier filter + sort. Empty `No competitors` CTA. Loading skeleton, error Retry.
- Detail/profile: header + strengths/weaknesses, tabs `Overview | Deals Won vs | Deals Lost to | Activity`, W/L bar chart, deal links deep-link to `/deals/:id`.
- Deal Lost modal: reason dropdown (_), competitor autocomplete (_) when reason=Competitor (debounced, Create-new inline), notes, Confirm disabled until valid, error mapping from 400.
- Deal detail: competitor chip with logo + link to `/competitors/:id`, edit/change/remove actions per permission.
- Reports: `Win/Loss by Competitor` bar/table, filters pipeline/date, drill-down, export.
- Responsive: catalog grids collapse, modal full-sheet mobile, report table horizontal scroll.
- A11y: picker `combobox` labelled, errors `aria-live`, W/L stats announced, focus trap modals.

## 7. Regression & Cross-Feature Impact

- Deals pipeline: Won/Lost stage moves require reason+competitor per rules – verify drag to Lost triggers same modal as dropdown.
- Pipelines: deleting Lost stage with competitor-linked deals migrates without losing competitorId.
- Products/Quotes: line items retained when linking competitor; quote snapshot unaffected.
- Dashboard: win-rate widgets update on link/change/reopen within 5s or refresh.
- Search: `competitor:Alpha` filter finds linked deals; global search finds competitor by name.
- Approvals: competitor-linked high-discount loss still requires approval flow if configured – verify no bypass.

## 8. Expected Results Summary Table

| TC   | Title           | Expected           | Pass Criteria     |
| ---- | --------------- | ------------------ | ----------------- |
| TC01 | Create UI       | Catalog + toast    | GET matches       |
| TC02 | Create API      | 201                | Exact fields      |
| TC03 | Validation      | Inline+400         | No record         |
| TC04 | Edit            | Everywhere + audit | No dup            |
| TC05 | Dup warn        | 409/warn           | No silent dup     |
| TC06 | Search/filter   | Correct page       | No dups           |
| TC07 | Lost link UI    | Both sides +1      | Timeline          |
| TC08 | Won beaten      | Counter            | Optional ok       |
| TC09 | API parity      | 200 both sides     | 404 bad id        |
| TC10 | Change/remove   | Counters ∓         | Conditional block |
| TC11 | Multi           | Doc single/multi   | No silent replace |
| TC12 | Conditional req | Block +400         | Exact key         |
| TC13 | Profile W/L     | 50% + lists        | No double-count   |
| TC14 | Report          | 33% drill-down     | CSV matches       |
| TC15 | Reopen          | Counters -1        | History kept      |
| TC16 | Archive/delete  | Block w/ list      | No null crash     |
| TC17 | Rep 403 catalog | Owned link ok      | Picker disabled   |
| TC18 | Anon 401        | Redirect           | No leak           |
| TC19 | XSS safe        | Escaped +400 js:   | Show more         |
| TC20 | Import 8/1/1    | Row errors         | Downloadable      |
| TC21 | Picker UX       | <300ms + create    | Keyboard ok       |
| TC22 | Perf            | Report <3s         | Picker <500ms     |

## 9. Troubleshooting & Common Failures

- `400 competitorId required` even with id: key is `competitor` not `competitorId` or expects object `{ competitor: { id } }` – copy Network payload from UI success; check enum `lossReason: Competitor` exact case.
- Picker shows 0 results for existing: search filters `isArchived=false` but seed archived – unarchive; check `tier` filter stuck; verify `GET /api/competitors?search=alp` returns it.
- Counters double-increment on edit: PATCH fires twice (optimistic + confirm) – check Network double POST; backend should be idempotent on same stage+competitor; report if +2.
- Delete 500 with links: missing guard – manually unlink (`PATCH deals competitorId:null` + reason Price) then delete; attach logs as P0.
- Report stale after link: cached aggregation (hourly job) – hard refresh + `?refresh=true` if supported; verify `stats` endpoint live vs report cached – document lag.
- `404 competitor not found` on valid id: id from wrong env (staging vs local) – re-list on `localhost:3001`; check trailing spaces in copied id.
- `403` linking as owner: deal owner changed – re-GET `ownerId`; link requires `deals:write` + `competitors:read` scopes.
- Website `400 invalid` for valid: validator requires `https://` prefix – add scheme; bare `rival.test` rejected – document.
- Lost modal Confirm spins: competitor autocomplete pending blocks submit – wait 500ms after select; check console for `competitorId undefined`.
- W/L bar shows 0/0 after links: stats endpoint path is `/api/competitors/:id/deals` not `/stats` – try both; verify `stageId` is actually Won/Lost (not open with competitor set).

## 10. Pass/Fail Checklist

- [ ] TC01–TC02 create UI+API with tier/strengths, website clickable
- [ ] TC03 validations block empty/dup/bad URL (400+inline)
- [ ] TC04 edit propagates + audit, no dup
- [ ] TC05 dup name/website warns/409s, no silent dup
- [ ] TC06 search/filter/sort/paginate correct
- [ ] TC07 Lost+Competitor links both sides + timeline, missing blocked
- [ ] TC08 Won beaten optional, counter correct
- [ ] TC09 API parity both sides, bad id 404
- [ ] TC10 change/remove updates counters, conditional block enforced
- [ ] TC11 single vs multi documented, no silent replace
- [ ] TC12 reason/competitor conditional 400 exact key
- [ ] TC13 profile W/L + lists accurate, no double-count
- [ ] TC14 report % + drill-down + CSV match, open excluded
- [ ] TC15 reopen decrements, history kept
- [ ] TC16 archive hides picker keeps history, delete blocked with reassign option
- [ ] TC17 Rep 403 catalog, owned link ok, Viewer read-only
- [ ] TC18 anon 401 + redirect
- [ ] TC19 XSS escaped, js: blocked, long Show more
- [ ] TC20 import 8/1/1 with row errors (or N/A)
- [ ] TC21 picker <300ms keyboard + inline create
- [ ] TC22 scale report <3s picker <500ms
- [ ] All 7 curls executed, counters ±1 verified
- [ ] Regression: deals modals, pipelines migrate, quotes, dashboard intact
- [ ] Cleanup: `E2E Rival*` + `E2EDeal_Comp*` removed
- Tester: _______________ Date: _______________ Comp IDs: _______________ Result: PASS / FAIL
