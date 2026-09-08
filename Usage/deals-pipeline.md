# Deals Pipeline – Comprehensive Testing Guide

## 1. Overview

This guide covers Deal CRUD, Kanban drag-drop with optimistic UI, probability / weighted value, forecastCategory, win/loss reason (loss-reason required), stalled/rot 14-day flag, multi-currency baseAmount with daily snapshot, and Closed Won line-item prompt.
Scope includes deal list/Kanban/table, create/edit/close, stage moves (drag + dropdown + API), probability sync from stage vs manual override, weighted = amount * probability, forecast categories (Pipeline, Best Case, Commit, Closed), win/loss reason required validation, stalled if no activity 14 days, currencies USD/EUR/INR with base conversion + snapshot history, Closed Won prompt to add line items if none, permissions, audit.
Base URLs:

- API: `http://localhost:3001`
- Web: `http://localhost:3000`
  Example deal:

```json
{
  "title": "Acme - 50 Seats",
  "accountId": "acc_id",
  "contactId": "con_id",
  "pipelineId": "pipe_id",
  "stageId": "stage_id",
  "amount": 50000,
  "currency": "INR",
  "probability": 60,
  "forecastCategory": "Best Case",
  "closeDate": "2026-10-15",
  "ownerId": "repA_id"
}
```

Success criteria: drag-drop updates stage optimistically and persists, weighted math exact, loss without reason blocked, stalled flag appears at 14 days inactivity, currency baseAmount uses daily snapshot rate, Won without line items prompts.

## 2. Prerequisites & Test Data Setup

- Admin + Rep A/B tokens. Pipeline with 5 stages (Qual 10%, Proposal 60%, Negotiation 80%, Won 100%, Lost 0%) – record ids. See `pipelines.md` for setup.
- Accounts/Contacts for linking: `Acme Corp`, `Mumbai FinTech`, contacts therein.
- Competitors + Products seeded (see `competitors.md`, `products-line-items.md`) for win/loss + line-item prompts.
- FX snapshot: `GET /api/fx/latest?base=USD` note USD->INR, USD->EUR rates + date. If job daily, force refresh `POST /api/fx/refresh` as Admin if available.
- Seed deals:

```json
{ "title": "Deal USD Commit", "amount": 10000, "currency": "USD", "pipelineId": "PIPE", "stageId": "STAGE_NEG", "probability": 80, "forecastCategory": "Commit", "closeDate": "2026-09-30" }
{ "title": "Deal EUR Proposal", "amount": 8000, "currency": "EUR", "pipelineId": "PIPE", "stageId": "STAGE_PROP", "probability": 60, "forecastCategory": "Best Case", "closeDate": "2026-10-10" }
{ "title": "Deal INR Qual", "amount": 500000, "currency": "INR", "pipelineId": "PIPE", "stageId": "STAGE_QUAL", "probability": 10, "forecastCategory": "Pipeline", "closeDate": "2026-11-01" }
{ "title": "Deal Stalled Old", "amount": 20000, "currency": "USD", "stageId": "STAGE_PROP", "updatedAt": "2026-08-01" }
```

- For stalled test: need deal with `lastActivityAt < 14 days ago` – create then manually set via DB or API `PATCH { lastActivityAt: 2026-08-20 }` if allowed, else wait/mock clock.
- Clean prefix `E2EDeal_` for teardown.
- Browser with Network throttling to test optimistic UI rollback.

## 3. Test Environment Matrix

| Dimension    | Variants                                                 |
| ------------ | -------------------------------------------------------- |
| API          | `http://localhost:3001`                                  |
| Web          | `http://localhost:3000`                                  |
| Browsers     | Chrome (drag), Firefox (drag)                            |
| Viewports    | 1920 (Kanban 5 cols), 1366 (scroll), 768 (list fallback) |
| Roles        | Admin, Owner Rep, Non-owner Rep, Viewer                  |
| Currencies   | USD, EUR, INR, invalid XXX                               |
| Stages       | Each of 5 + cross-pipeline move                          |
| Close Types  | Won with/without line items, Lost with/without reason    |
| Activity Age | Fresh, 13 days (not stalled), 14 days (stalled), 30 days |
| Network      | Normal, slow (optimistic), offline (rollback)            |

- Record FX rates/date used; re-run currency TCs if rates change mid-run.

## 4. Detailed Step-by-Step Test Cases

### TC01 – Create Deal Happy Path (UI)

- Steps as Rep A: `http://localhost:3000/deals` -> New Deal -> Title `E2EDeal_Acme 50 Seats`, Account Acme, Contact John, Pipeline Sales, Stage Qualification, Amount 50000 Currency INR, Close Date 2026-10-15, Save.
- Expected: Toast + appears in Qualification column with `₹5,00,000` (en-IN format) + probability 10% + weighted `₹50,000`, detail shows forecast Pipeline auto. `GET /api/deals/:id` matches.

### TC02 – Create Deal (API) Multi-Currency Trio

- Steps: POST trio USD/EUR/INR from Section 2.
- Expected: Each `201` with `baseAmount` computed (e.g., INR 500000 / rate -> USD base), `fxRate` + `fxDate` snapshot stored. `GET` returns same snapshot even after rate changes (immutability).

### TC03 – Required Validation (Title, Account, Pipeline/Stage, Amount, CloseDate)

- Steps: UI try save missing title, missing account, missing stage, amount empty/negative, closeDate past without warning.
- Expected: Inline errors + API `400` per field. No record. Past closeDate either warns `Date in past` but allows with confirm, or blocks – document.

### TC04 – Kanban Drag-Drop Happy Path (Optimistic UI)

- Steps:
  1. Open `http://localhost:3000/deals?pipeline=PIPE` Kanban.
  2. Drag card `E2EDeal_Acme` from Qualification to Proposal.
  3. Observe immediate column jump (<100ms) before Network completes, then toast `Moved to Proposal`.
- Expected: Card moves instantly (optimistic), `PATCH /api/deals/:id { stageId }` fires, column counts update, probability 10%->60%, weighted recalc, timeline `Stage Qualification -> Proposal by RepA`. Refresh persists.

### TC05 – Drag-Drop Rollback on Failure

- Steps: Throttle Network to Offline or mock 500 (devtools Block `PATCH /api/deals/*`), drag card to Negotiation.
- Expected: Card jumps optimistically then snaps back with error toast `Move failed, reverted` + Retry button. No stuck duplicate in both columns. Click Retry succeeds when online.

### TC06 – Stage Move via Dropdown + API Parity

- Steps: Open deal detail, change Stage dropdown Qual->Neg, Save. API `PATCH /api/deals/:id { stageId: STAGE_NEG }` for another deal.
- Expected: Both update probability/forecast suggestion, timeline logged, Kanban reflects on next visit. Dropdown and drag produce identical API payload shape.

### TC07 – Probability Sync from Stage vs Manual Override

- Steps:
  1. Move deal to Proposal (60%) – verify probability auto 60.
  2. Manually set probability 75% custom, Save.
  3. Move to Negotiation – check if overwritten to 80 or kept 75 with `Custom` badge.
- Expected: Document behavior – either always syncs (manual lost with warning) or preserves override with `Overridden` indicator + `Reset to stage default` button. Weighted uses effective probability. API `probabilitySource: stage|manual`.

### TC08 – Weighted Value Math

- Steps: Deals: 10000 USD @80% => 8000, 8000 EUR @60% => 4800 EUR (+ base), 500000 INR @10% => 50000 INR. Check card, detail, pipeline totals.
- Expected: Exact math, rounding to 2 decimals, currency symbol per deal, base totals sum converted bases. No float `7999.999` display – formatted.

### TC09 – ForecastCategory Mapping & Validation

- Steps: Verify mapping Qual->Pipeline, Proposal->Best Case, Negotiation->Commit, Won/Lost->Closed (or manual select). Try invalid `forecastCategory: Dream`.
- Expected: Auto-suggests on stage change but editable; invalid `400`; Closed required when stage Won/Lost (or auto-forced). Filter `forecastCategory=Commit` returns correct subset.

### TC10 – Close as Won Happy Path + Line-Item Prompt (Core)

- Steps:
  1. Create deal without line items.
  2. Drag to Closed Won (or Set Stage Won + Save).
  3. Observe prompt `No line items. Add products before closing? [Add Products] [Close Anyway]`.
  4. Click Add Products -> line-item editor opens; add 1 product; Confirm close.
- Expected: Prompt appears only when 0 line items, both paths work, timeline `Won` with amount, forecast Closed, probability forced 100. If `Close Anyway`, allowed with audit `closed without line items`.

### TC11 – Close as Won with Line Items (No Prompt)

- Steps: Deal with 2 line items -> Move to Won.
- Expected: No prompt, closes immediately, totals from line items reconcile with deal amount (or warn if mismatch `Line total ₹60k vs Deal ₹50k`). Audit shows `lineTotal`.

### TC12 – Close as Lost Requires Reason (Core Validation)

- Steps:
  1. Drag deal to Closed Lost without reason -> expect blocked modal `Loss reason required` with dropdown (Price, Competitor, Timing, No Budget, Other) + notes.
  2. Select `Competitor` + competitor `Acme Rival` + notes, Confirm.
- Expected: First attempt blocked inline + API `PATCH { stageId: LOST }` without `lossReason` returns `400 lossReason required`. Second succeeds, deal shows Lost badge + reason + competitor link, probability 0, forecast Closed, weighted 0.

### TC13 – Win Reason Optional + Competitor Link

- Steps: Close Won with winReason `Strong PoC` + competitor beaten.
- Expected: Stored, displayed, filterable `winReason`. Competitor catalog link increments competitor `losses` counter (see competitors.md).

### TC14 – Reopen Closed Deal (Won->Open, Lost->Open)

- Steps: Move Won deal back to Negotiation, Lost back to Proposal.
- Expected: Requires confirm `Reopening will reset forecast`, probability restores stage default, won/loss reason retained in history but not active, timeline logs reopen. Permissions: only Admin/owner can reopen (403 others).

### TC15 – Stalled / Rot 14-Day Flag (Core)

- Steps: Open deal with `lastActivityAt` 15 days ago (seeded Old) vs fresh deal.
- Expected: Old shows 🔥/⏰ `Stalled 15d` red badge on card + detail banner `No activity for 15 days` + filter `stalled=true` finds it. Fresh (2d) and 13d show none. Boundary 14d exactly flags (>=14). Any new note/edit/activity resets clock (verify flag clears).

### TC16 – Stalled Reset on Activity

- Steps: On stalled deal add note / move stage / edit amount.
- Expected: `lastActivityAt=now`, flag clears immediately (or <5s), timeline `Activity reset stalled`. Verify via `GET` timestamp updated.

### TC17 – Multi-Currency BaseAmount + Daily Snapshot (Core)

- Steps:
  1. Note FX assumption: e.g., 1 USD = 83.5 INR, 1 EUR = 1.08 USD on 2026-09-08.
  2. Create 10000 USD -> base 10000 USD; 8000 EUR -> base ~8640 USD; 500000 INR -> base ~5988 USD.
  3. Change FX rate next day (or mock), verify old deals keep old `fxRate/fxDate`, new deals use new rate.
- Expected: Snapshot immutable per deal, totals use per-deal base, history `fxSnapshots: [{date, rate}]` if exposed. Display both `₹5,00,000 (≈ $5,988)` dual. Invalid currency `XXX` -> `400`.

### TC18 – Currency Formatting (USD/EUR/INR)

- Steps: Check list/Kanban/detail for `$10,000.00`, `€8,000.00`, `₹5,00,000` (lakh grouping).
- Expected: Correct symbols, grouping (INR `5,00,000` not `500,000`), decimals per currency (INR 0 or 2 consistently), no `NaN` or `undefined`. Sorting by baseAmount works cross-currency.

### TC19 – Delete & Permissions

- Steps: Admin delete `E2EDeal_` succeeds (confirm + 204 + removed + audit). Rep delete owned vs unowned (403?), Viewer create/move (403), anon `GET /api/deals` 401.
- Expected: Delete restricted per spec (Admin or owner), non-owner move blocked with `403` + card snaps back, Viewer read-only hides New/drag (cards not draggable).

### TC20 – Search / Filter / Sort + Cross-Pipeline Move

- Steps: Filter `pipeline=PIPE + stage=Proposal + stalled=true + forecast=Commit`, search `Acme`, sort `amount desc, closeDate asc`, paginate. Move deal to different pipeline's stage via detail pipeline+stage change.
- Expected: Filters AND correctly, search partial case-insensitive, sort stable, pagination no dups. Cross-pipeline move updates pipelineId+stageId atomically, probability maps to new pipeline stage, timeline notes `Moved pipeline Sales->Enterprise`.

### TC21 – Bulk Edit & Archive (Bonus)

- Steps: Select 3 deals bulk change owner/forecast/closeDate, bulk archive.
- Expected: Progress + per-item errors, timelines updated, archived hidden by default `?archived=false` but retrievable.

### TC22 – Performance & Concurrency (Bonus)

- Steps: 200 deals Kanban load <3s, parallel PATCH same deal stage (two users drag different targets).
- Expected: Virtualized columns + `Load more`, last-write-wins or 409 with reload, no duplicate card, counts consistent.

## 5. API Testing Section

| Method & Endpoint                                                        | Purpose                                                      | Expected                                    |
| ------------------------------------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------- |
| `POST /api/deals`                                                        | Create (USD/EUR/INR)                                         | 201 + baseAmount/fx snapshot                |
| `GET /api/deals?pipeline=&stage=&stalled=&forecast=&search=&sort=&page=` | List/filter                                                  | 200 `{data,total}`                          |
| `GET /api/deals/:id`                                                     | Detail with lineTotal, stalled, base                         | 200                                         |
| `PATCH /api/deals/:id`                                                   | Edit/move/close (stageId, probability, forecast, lossReason) | 200, 400 lossReason required, 403 forbidden |
| `DELETE /api/deals/:id`                                                  | Delete                                                       | 204 / 403                                   |
| `GET /api/deals/:id/timeline`                                            | Stage history                                                | 200 entries                                 |
| `GET /api/fx/latest?base=USD`                                            | FX snapshot verify                                           | 200 rates+date                              |

```bash
# 1. Login
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"rep.a@test.com","password":"Rep123!"}'

# 2. Create INR deal
curl -X POST http://localhost:3001/api/deals \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "title":"E2EDeal_Acme 50 Seats",
    "accountId":"ACC_ID",
    "pipelineId":"PIPE_ID",
    "stageId":"STAGE_QUAL_ID",
    "amount":500000,"currency":"INR",
    "probability":10,"forecastCategory":"Pipeline",
    "closeDate":"2026-11-01"
  }'

# 3. Create USD + EUR pair
curl -X POST http://localhost:3001/api/deals \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"title":"E2EDeal_USD","accountId":"ACC_ID","pipelineId":"PIPE_ID","stageId":"STAGE_NEG_ID","amount":10000,"currency":"USD","closeDate":"2026-09-30"}'
curl -X POST http://localhost:3001/api/deals \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"title":"E2EDeal_EUR","accountId":"ACC_ID","pipelineId":"PIPE_ID","stageId":"STAGE_PROP_ID","amount":8000,"currency":"EUR","closeDate":"2026-10-10"}'

# 4. Move stage (drag-drop equivalent)
curl -X PATCH http://localhost:3001/api/deals/DEAL_ID \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"stageId":"STAGE_PROP_ID"}'

# 5. Close Lost WITHOUT reason (expect 400 lossReason required)
curl -X PATCH http://localhost:3001/api/deals/DEAL_ID \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"stageId":"STAGE_LOST_ID"}'

# 6. Close Lost WITH reason + competitor
curl -X PATCH http://localhost:3001/api/deals/DEAL_ID \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"stageId":"STAGE_LOST_ID","lossReason":"Price","lossNotes":"Chose cheaper rival","competitorId":"COMP_ID"}'

# 7. Close Won (check line-item prompt behavior via UI; API just closes)
curl -X PATCH http://localhost:3001/api/deals/DEAL_ID2 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"stageId":"STAGE_WON_ID","winReason":"Strong PoC"}'

# 8. Stalled filter + FX snapshot
curl "http://localhost:3001/api/deals?stalled=true&pipelineId=PIPE_ID" -H "Authorization: Bearer $TOKEN"
curl "http://localhost:3001/api/fx/latest?base=USD" -H "Authorization: Bearer $TOKEN"
```

- Verify weighted: `amount * probability/100` equals `weightedValue` in response.
- Verify snapshot immutability: re-GET after FX refresh shows old `fxRate`.

## 6. UI Testing Section

- Deals page: toggle Kanban/Table, pipeline selector dropdown, search, filters (stage, forecast, stalled toggle, owner, currency), sort, counts.
- Kanban: columns per stage in order with `Name prob% (count) total`, cards show Title, Account, `Amount symbol + base hint`, probability bar, stalled 🔥 badge, owner avatar, closeDate (red if overdue). Drag handle whole card, drop highlight column, auto-scroll at edges, touch fallback ( … menu Move to).
- Detail: header Title + stage pill dropdown + forecast badge + stalled banner, fields Amount+currency selector + CloseDate datepicker + Probability slider/number + Weighted read-only + Win/Loss reason section (conditional) + Line items tab + Timeline tab + Competitor picker.
- Won prompt modal: `No line items` warning + Add Products vs Close Anyway buttons, focus-trapped.
- Lost modal: reason dropdown required (*), competitor autocomplete, notes textarea, Confirm disabled until reason, error if API 400.
- Currency: selector USD/EUR/INR with symbols, input grouping live, dual display `₹5,00,000 (≈ $5,988 @ 83.5 on 2026-09-08)`.
- Responsive: Kanban horizontal scroll desktop, list fallback tablet (no drag, Move menu), detail stacks.
- A11y: cards `draggable` + keyboard Move menu, columns `role=list`, modals focus-trapped, stalled badge `aria-label`, contrast AA.

## 7. Regression & Cross-Feature Impact

- Pipelines: stage rename/prob/delete-migrate reflects in Kanban immediately; default pipeline used for new deals.
- Products/Line items: lineTotal vs amount mismatch warns; Won prompt fires only when 0 items.
- Competitors: Lost with competitor increments rival stats; Won vs competitor decrements.
- Quotes: deal amount change after quote snapshot does NOT mutate quote (snapshot); new quote uses current amount.
- Approvals: high-discount quote approval state visible on deal (badge `Approval Pending` blocks Won? – verify per spec).
- Conversion: converted deals land correct pipeline/stage with currency.
- Dashboard/Forecast: weighted/commit totals update on move/prob/currency change; stalled count widget matches filter.
- Notifications: owner notified on assignment + stage mention + stalled digest (if enabled).

## 8. Expected Results Summary Table

| TC   | Title              | Expected              | Pass Criteria           |
| ---- | ------------------ | --------------------- | ----------------------- |
| TC01 | Create UI INR      | Card ₹ +10%           | GET matches             |
| TC02 | Trio API           | 201 + base snapshot   | Immutable FX            |
| TC03 | Required 400       | Inline                | No record               |
| TC04 | Drag optimistic    | <100ms + persist      | Timeline logged         |
| TC05 | Offline rollback   | Snap back + Retry     | No dup columns          |
| TC06 | Dropdown parity    | Same payload          | Kanban reflects         |
| TC07 | Prob sync/override | Documented + badge    | Weighted uses effective |
| TC08 | Weighted math      | Exact 2-dec           | Base sums ok            |
| TC09 | Forecast map       | Auto + editable       | 400 invalid             |
| TC10 | Won prompt         | Modal 2 paths         | Audit line flag         |
| TC11 | Won with items     | No prompt             | Totals reconcile        |
| TC12 | Lost needs reason  | Block then 400->200   | Badge + link            |
| TC13 | Win reason         | Stored + counter      | Filterable              |
| TC14 | Reopen             | Confirm + reset       | 403 non-owner           |
| TC15 | Stalled 14d        | Badge + filter        | Boundary >=14           |
| TC16 | Reset on activity  | Flag clears           | Timestamp now           |
| TC17 | FX snapshot        | Old immutable         | Dual display            |
| TC18 | Formatting         | $ € ₹ correct         | Sort by base            |
| TC19 | Delete/perms       | 204 admin, 403 others | 401 anon                |
| TC20 | Search/filter/move | AND + stable          | Cross-pipe atomic       |
| TC21 | Bulk/archive       | Progress              | Hidden default          |
| TC22 | Perf/race          | <3s, no dup           | Counts consistent       |

## 9. Troubleshooting & Common Failures

- Drag does nothing: pipeline selector wrong (deal in different pipeline) – verify `pipelineId` via `GET /api/deals/:id`; check Viewer role (drag disabled); try dropdown Move as fallback.
- `400 lossReason required` even with reason: key name `lossReason` vs `loss_reason` vs `closeReason` – inspect Network payload of UI success to copy exact key; enum case `Price` vs `price`.
- Won prompt never shows: deal already has 0-qty line item (counts as item) – `GET /api/deals/:id/line-items` verify empty; prompt threshold may be `lineTotal==0` not count – test both.
- Weighted mismatch by 1 cent: float rounding – backend should round half-up 2-dec; compare `Math.round(amount*prob)/100`; report if `7999.99` vs `8000`.
- Stalled flag missing for 15d old: `lastActivityAt` updated by seed script (creation counts as activity) – set `lastActivityAt` explicitly via DB/API or backdate `updatedAt`; check timezone `14*24h` exact vs calendar days.
- BaseAmount null for INR: FX snapshot job never ran for INR – `GET /api/fx/latest` missing INR rate; trigger `POST /api/fx/refresh`; fallback uses previous day – document.
- Currency symbol `Rs.` vs `₹`: locale `en-US` vs `en-IN` – set browser `en-IN` or verify both accepted; grouping `5,00,000` requires `en-IN` formatter.
- `403` on move as owner: ownership changed by routing – re-GET `ownerId`; move requires `deals:write` scope – check token role.
- Kanban counts stale after move: optimistic count not reconciled – refresh, verify API `stats` correct (UI bug if mismatch); check duplicate PATCH fired twice (double drag).
- Close date past allowed silently: validation may be warn-only – look for amber `Overdue` badge instead of block; document warn vs block.
- Cross-pipeline move 500: target stage not in target pipeline – fetch `GET /api/pipelines/:newPipe` stages and use valid stageId.

## 10. Pass/Fail Checklist

- [ ] TC01–TC02 create UI + trio API with USD/EUR/INR + base snapshots
- [ ] TC03 validations block missing/invalid (400 + inline), no record
- [ ] TC04 drag optimistic <100ms persists + timeline + counts
- [ ] TC05 offline drag snaps back + Retry, no dup
- [ ] TC06 dropdown and API parity, same payload shape
- [ ] TC07 prob sync vs override documented with badge + reset
- [ ] TC08 weighted exact + base sums, no float display bug
- [ ] TC09 forecast auto + editable, invalid 400, Closed forced on Won/Lost
- [ ] TC10 Won without items prompts Add vs Close Anyway, audited
- [ ] TC11 Won with items no prompt, totals reconcile/warn
- [ ] TC12 Lost without reason blocked UI + 400 API, with reason+competitor succeeds
- [ ] TC13 win reason + competitor linked + counters
- [ ] TC14 reopen requires confirm, resets prob, 403 non-owner
- [ ] TC15 stalled >=14d badges + filter, 13d clean, boundary verified
- [ ] TC16 any activity clears stalled + updates timestamp
- [ ] TC17 FX snapshots immutable, dual display, invalid XXX 400
- [ ] TC18 $ € ₹ formatting + grouping + sort by base correct
- [ ] TC19 delete/perms: 204 admin, 403 non-owner/Viewer, 401 anon
- [ ] TC20 search/filter/sort/paginate + cross-pipeline atomic
- [ ] TC21 bulk/archive progress (if supported)
- [ ] TC22 200-load <3s, race no dup
- [ ] All 8 curl groups executed, weighted + FX verified
- [ ] Regression: pipelines, line items, competitors, quotes, approvals, forecast intact
- [ ] Cleanup: `E2EDeal_*` deleted, FX noted
- Tester: _______________ Date: _______________ Pipe/Stages: _______________ FX: _______________ Result: PASS / FAIL
