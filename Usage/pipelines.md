# Pipelines – Comprehensive Testing Guide

## 1. Overview

This guide covers Multiple Pipelines and Stage configuration: ordered stages with probability, closedWon/closedLost flags, stage removal with deal migration, default pipeline, and permissions.
Scope includes pipeline CRUD, stage CRUD/order, probability 0-100, exactly-one closedWon + closedLost per pipeline (or per spec), deal counts per stage, drag-drop ordering persistence, stage deletion migration dialog (move deals to another stage), pipeline deletion guard, default pipeline selection, audit.
Base URLs:

- API: `http://localhost:3001`
- Web: `http://localhost:3000`
  Example pipeline `Sales (INR)` stages: Qualification 10% -> Needs Analysis 25% -> Proposal 60% -> Negotiation 80% -> Closed Won 100% (closedWon) -> Closed Lost 0% (closedLost).
  Success criteria: stage order persists, probabilities drive weighted value, closed flags exclusive, removal migrates deals without loss, default pipeline used for new deals/converted leads.

## 2. Prerequisites & Test Data Setup

- Admin token (pipeline config), Rep token (view/use).
- Backup: `GET /api/pipelines` full JSON save.
- Create test pipeline:

```json
{
  "name": "E2E Test Pipeline",
  "isActive": true,
  "isDefault": false,
  "stages": [
    {
      "name": "Qualification",
      "order": 1,
      "probability": 10,
      "closedWon": false,
      "closedLost": false
    },
    { "name": "Proposal", "order": 2, "probability": 60, "closedWon": false, "closedLost": false },
    {
      "name": "Negotiation",
      "order": 3,
      "probability": 80,
      "closedWon": false,
      "closedLost": false
    },
    {
      "name": "Closed Won",
      "order": 4,
      "probability": 100,
      "closedWon": true,
      "closedLost": false
    },
    { "name": "Closed Lost", "order": 5, "probability": 0, "closedWon": false, "closedLost": true }
  ]
}
```

- Seed deals in each stage for migration tests: 2 in Qualification, 1 in Proposal, 1 in Negotiation via `POST /api/deals`.
- Note pipelineId + stageIds: `PIPELINE_ID, STAGE_QUAL, STAGE_PROP, STAGE_NEG, STAGE_WON, STAGE_LOST`.
- Test currencies: amounts in USD/EUR/INR to verify pipeline totals handle multi-currency (baseAmount rollup).
- Cleanup: delete test pipeline only after migrating/deleting its deals; restore default flag if changed.

## 3. Test Environment Matrix

| Dimension  | Variants                                                               |
| ---------- | ---------------------------------------------------------------------- |
| API        | `http://localhost:3001`                                                |
| Web        | `http://localhost:3000`                                                |
| Browsers   | Chrome, Firefox                                                        |
| Roles      | Admin (CRUD), Rep (view + use in deals, no config), Viewer (read)      |
| Pipelines  | 1 default, 3 parallel (Sales, Enterprise, SMB)                         |
| Stages     | 3 minimal, 7 rich, 1 single (edge)                                     |
| Operations | Create, reorder, edit prob, delete w/ migrate, set default, deactivate |
| Data       | Empty pipeline, 50 deals distribution, 1000 deals perf                 |

- Record default pipeline id before tests; restore after.

## 4. Detailed Step-by-Step Test Cases

### TC01 – Create Pipeline Happy Path (UI)

- Steps as Admin: `http://localhost:3000/settings/pipelines` -> New Pipeline -> Name `E2E Test Pipeline` -> Add 5 stages with names/probabilities/flags above -> Save.
- Expected: Appears in list with stage chips in order, default badge if set, toast. `GET /api/pipelines` contains it with stages ordered 1..5.

### TC02 – Create Pipeline (API)

- Steps: `POST /api/pipelines` with JSON from Section 2.
- Expected: `201` with ids for pipeline + each stage, probabilities exact, closed flags exclusive. `GET /api/pipelines/:id` returns same order.

### TC03 – Stage Order Persistence (Drag-Drop)

- Steps: In pipeline editor drag `Proposal` above `Qualification` (or use up arrow), Save, refresh page, re-GET API.
- Expected: New order persists UI + API (`order` renumbered 1..N contiguous). Deals Kanban columns reorder same way. No duplicate order numbers.

### TC04 – Edit Stage Name / Probability

- Steps: Rename `Proposal` -> `Proposal Sent`, change prob 60->65, Save.
- Expected: Updated everywhere (Kanban header `Proposal Sent 65%`), weighted values recalc (`amount * 0.65`), audit diff `probability 60->65`. Prob input clamps 0-100.

### TC05 – Probability Validation 0-100

- Steps: Try prob `-5`, `150`, `abc`, empty, `62.5` decimal.
- Expected: Inline error + API `400 probability 0-100`. No save. Decimal allowed only if spec permits (else rounded or 400 – document).

### TC06 – ClosedWon / ClosedLost Exclusivity

- Steps: Try marking two stages closedWon, try stage both closedWon+closedLost, try pipeline with zero closedWon.
- Expected: Validation `Exactly one Closed Won and one Closed Lost required` (or at most one – document). Save blocked + API `400`. UI radio behavior (selecting new Won unselects old with confirm).

### TC07 – Closed Stage Probability Enforcement

- Steps: Set Closed Won prob to 80, Closed Lost to 20.
- Expected: Warning or auto-correct to 100/0, or blocked with `Closed Won must be 100, Lost must be 0`. Document enforced vs advisory. Existing deals weighted recalc accordingly.

### TC08 – Set Default Pipeline

- Steps: Set E2E pipeline as Default via star button, create new Deal without choosing pipeline (or Convert lead with deal).
- Expected: New deal lands in default pipeline first stage. Previous default unmarked (single default). List shows `Default` badge. API `isDefault:true` exclusive.

### TC09 – Deal Counts per Stage Accuracy

- Steps: Seed 2 Qual +1 Prop +1 Neg, open pipeline Kanban + `GET /api/pipelines/:id/stats`.
- Expected: Column headers show `Qualification (2)`, etc., totals match API, sum equals pipeline total. Archive/closed excluded per filter – document.

### TC10 – Stage Removal with Migration Dialog (Core)

- Steps: Delete `Proposal` stage containing 1 deal. Dialog must offer `Move deals to: [Negotiation dropdown]` + shows count `1 deal will be moved`.
- Expected: After confirm, deal `stageId` = Negotiation, no data loss, stage removed, order renumbered, audit `stage deleted, 1 deal migrated Proposal->Negotiation`. Cancel leaves everything untouched (no API call).

### TC11 – Stage Removal Empty Stage (No Migration Prompt)

- Steps: Create empty stage `Temp`, delete it.
- Expected: Immediate delete with simple confirm (no migration dropdown since 0 deals), succeeds, no orphan.

### TC12 – Stage Removal Last / Closed Stage Guard

- Steps: Try deleting Closed Won with 2 won deals, try deleting only remaining stage.
- Expected: Blocked or requires explicit target + warning `Closed stage deletion affects reporting`. Last stage deletion blocked `Pipeline must have at least one stage`. API `400/422`.

### TC13 – Pipeline Deletion Guard with Deals

- Steps: Try deleting E2E pipeline with 4 deals inside.
- Expected: Blocked with `Pipeline has 4 deals. Move or delete deals first` + list of deals, or offers `Move all deals to [Other pipeline]` migration. No silent cascade delete. Empty pipeline deletes with confirm.

### TC14 – Pipeline Deactivate / Hide

- Steps: Toggle `isActive:false`, check deal creation dropdown + Kanban selector.
- Expected: Inactive hidden from new-deal dropdown but existing deals still viewable via direct link + historical reports. Reactivate restores. API filters `?active=true` vs all.

### TC15 – Permissions – Rep Cannot Configure

- Steps: As Rep open settings/pipelines, try New/Edit/Delete/reorder; API with Rep token `POST /api/pipelines`.
- Expected: UI hidden or read-only `Admin only`, API `403`. Rep CAN select pipelines when creating deals.

### TC16 – Validation – Duplicate Stage Names, Empty Pipeline Name

- Steps: Create stages `Proposal` + `proposal` (case dup), pipeline name empty/whitespace/200 chars.
- Expected: Duplicate blocked or warned (case-insensitive check) + API `400 duplicate stage name`. Empty name blocked, long name `400 max length`. No partial persist.

### TC17 – Concurrent Edit Conflict

- Steps: Open same pipeline editor in two tabs, rename in Tab1 save, reorder in Tab2 save.
- Expected: Second save either `409 conflict` with reload prompt or last-write-wins with warning. No corrupted order (duplicate/gap). Verify final `order` contiguous.

### TC18 – Multi-Currency Totals in Pipeline View

- Steps: Deals: $10,000 USD, €8,000 EUR, ₹5,00,000 INR in same pipeline. Check Kanban totals + stats.
- Expected: Per-currency subtotals + converted `baseAmount` total (e.g., USD base) using daily FX snapshot. Symbol formatting correct ($, €, ₹ with en-IN lakh commas for INR). No NaN.

### TC19 – Pipeline Selector Switching Preserves Context

- Steps: With 3 pipelines, switch dropdown on Deals page, apply search filter, switch again.
- Expected: Filter/search preserved or clearly reset (document), stage columns swap <1s, URL updates `?pipeline=:id` deep-linkable, refresh retains selection.

### TC20 – Audit Trail for Pipeline/Stage Changes

- Steps: Create -> reorder -> edit prob -> delete stage with migrate -> set default. Check `GET /api/pipelines/:id/audit` or Activity.
- Expected: Each with actor/timestamp/diff. Migration entry includes deal ids moved. No missing entries.

### TC21 – Bulk Stage Probability Update (Bonus)

- Steps: If UI supports inline prob edit, update 3 stages rapidly without full save each.
- Expected: Debounced saves, all persist after refresh, weighted recalcs once. No race losing one edit.

### TC22 – Performance – 500 Deals Kanban Load (Bonus)

- Steps: Seed 500 deals in E2E pipeline, open Kanban, measure load.
- Expected: Initial render <3s with virtualization/pagination (`limit=50` per column + `Load more`), no browser freeze, counts correct.

## 5. API Testing Section

| Method & Endpoint                                      | Purpose                     | Expected                                         |
| ------------------------------------------------------ | --------------------------- | ------------------------------------------------ |
| `POST /api/pipelines`                                  | Create with stages          | 201 + stage ids                                  |
| `GET /api/pipelines`                                   | List + default flag         | 200 sorted, single default                       |
| `GET /api/pipelines/:id`                               | Detail ordered stages       | 200 order 1..N                                   |
| `PATCH /api/pipelines/:id`                             | Rename/reorder/prob/default | 200, 400 validation                              |
| `POST /api/pipelines/:id/stages`                       | Add stage                   | 201                                              |
| `PATCH /api/pipelines/:id/stages/:stageId`             | Edit stage                  | 200                                              |
| `DELETE /api/pipelines/:id/stages/:stageId?migrateTo=` | Delete + migrate            | 200 `{ migrated: N }`, 400 no target when needed |
| `DELETE /api/pipelines/:id`                            | Delete pipeline             | 204 empty, 400 has deals                         |
| `GET /api/pipelines/:id/stats`                         | Counts/totals               | 200 per-stage                                    |

```bash
# 1. Login admin
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@test.com","password":"Admin123!"}'

# 2. Create pipeline with stages
curl -X POST http://localhost:3001/api/pipelines \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{
    "name":"E2E Test Pipeline",
    "isDefault": false,
    "stages":[
      {"name":"Qualification","order":1,"probability":10},
      {"name":"Proposal","order":2,"probability":60},
      {"name":"Negotiation","order":3,"probability":80},
      {"name":"Closed Won","order":4,"probability":100,"closedWon":true},
      {"name":"Closed Lost","order":5,"probability":0,"closedLost":true}
    ]
  }'

# 3. List pipelines
curl http://localhost:3001/api/pipelines -H "Authorization: Bearer $ADMIN_TOKEN"

# 4. Update stage probability
curl -X PATCH http://localhost:3001/api/pipelines/PIPELINE_ID/stages/STAGE_PROP_ID \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"probability":65}'

# 5. Delete stage with migration (move deals to Negotiation)
curl -X DELETE "http://localhost:3001/api/pipelines/PIPELINE_ID/stages/STAGE_PROP_ID?migrateTo=STAGE_NEG_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# 6. Invalid probability (expect 400)
curl -X PATCH http://localhost:3001/api/pipelines/PIPELINE_ID/stages/STAGE_QUAL_ID \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"probability":150}'

# 7. Set default
curl -X PATCH http://localhost:3001/api/pipelines/PIPELINE_ID \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"isDefault": true}'
```

- Verify `order` contiguous after each reorder/delete via `GET /api/pipelines/:id`.
- Negative Rep token on POST expect `403`.

## 6. UI Testing Section

- Pipelines settings: cards/table with name, Default star, Active toggle, stage chips in order with prob%, deal counts, Edit/Delete.
- Editor modal/page: pipeline name input, default star, stages list with drag handle, name input, probability slider+number (0-100), Won/Lost radio badges (green/red), Add stage, Remove X with migration dialog (dropdown + count), Save/Cancel with dirty guard.
- Kanban impact: column headers update immediately after save (name + prob + count), colors for Won (green) / Lost (gray).
- Validation visuals: red border + message under prob, Save disabled, duplicate name highlighted.
- Migration dialog: title `Delete stage Proposal`, body `1 deal will be moved`, target dropdown excludes deleted, Confirm destructive red, Cancel no call.
- Responsive: stages stack on tablet, drag falls back to up/down arrows, Kanban horizontal scroll with sticky headers.
- A11y: drag keyboard movable, sliders labelled with value announced, dialogs focus-trapped, Esc cancels.

## 7. Regression & Cross-Feature Impact

- Deals: existing deals retain stageId; deleted stage deals migrated – verify Kanban + detail stage + weighted value update.
- Conversion: new converted deals use default pipeline – change default and reconvert to verify.
- Quotes/Products: line items unaffected by stage change; Closed Won prompt still fires (see deals-pipeline.md).
- Forecast: probability change shifts forecastCategory/weighted totals – verify dashboard updates.
- Search/filter: `pipeline:` filter lists new pipeline; global search finds its deals.
- Permissions: Rep sees new pipeline in dropdown immediately without relogin (or after refresh – document).

## 8. Expected Results Summary Table

| TC   | Title                 | Expected             | Pass Criteria       |
| ---- | --------------------- | -------------------- | ------------------- |
| TC01 | Create UI             | Chips ordered        | GET same            |
| TC02 | Create API            | 201 ids              | Flags exclusive     |
| TC03 | Reorder persist       | 1..N contiguous      | Kanban matches      |
| TC04 | Edit name/prob        | Everywhere + audit   | Weighted recalc     |
| TC05 | Prob 0-100            | Inline+400           | No save             |
| TC06 | Won/Lost exclusive    | Block multi          | Single each         |
| TC07 | Closed 100/0          | Enforced/advisory    | Documented          |
| TC08 | Default               | New deals there      | Single default      |
| TC09 | Counts                | Headers=API          | Sum correct         |
| TC10 | Delete+migrate        | No loss              | Audit migrated N    |
| TC11 | Empty delete          | Simple confirm       | Succeeds            |
| TC12 | Closed/last guard     | Blocked              | 400/422             |
| TC13 | Pipeline delete guard | Blocked w/ deals     | No cascade          |
| TC14 | Deactivate hide       | Dropdown hides       | History kept        |
| TC15 | Rep 403               | Read-only            | Can use in deals    |
| TC16 | Dup/empty 400         | Inline               | No partial          |
| TC17 | Concurrent            | 409 or warn          | No corrupt order    |
| TC18 | Multi-currency        | Base total + symbols | No NaN              |
| TC19 | Switcher              | <1s + deep-link      | Filter handling doc |
| TC20 | Audit                 | All diffs            | Migrated ids        |
| TC21 | Bulk prob             | All persist          | Single recalc       |
| TC22 | 500 load              | <3s virtualized      | Counts ok           |

## 9. Troubleshooting & Common Failures

- `400 closedWon must be unique`: payload sends `closedWon:true` on two stages – unset old before setting new, or use dedicated `PATCH .../set-closed` endpoint if exists.
- Order gaps/duplicates after drag: frontend sends 0-indexed, backend expects 1-indexed – inspect PATCH body, ensure `order` 1..N; re-save fixes.
- Migration dialog shows 0 deals but stage has 1: count query filters `active` vs archived – check deal `isArchived`; verify `GET /api/deals?stageId=` count.
- Deleted stage deals become null stage (Kanban `No stage` column): `migrateTo` query param name wrong (`migrateToStageId` vs `migrateTo`) – check API docs/Network tab; re-migrate via bulk edit.
- Default not changing: two defaults allowed (bug) – verify `GET /api/pipelines` shows single `isDefault:true`; unset old explicitly.
- Prob change not updating weighted: frontend cache – hard refresh Kanban, verify `GET /api/deals/:id` `probability` snapshot vs live pipeline prob (snapshot vs live semantics – document).
- `403` as Admin: token expired – re-login; check role `admin` not `rep`.
- Kanban columns wrong order after reorder: Kanban sorts by `order` but API returned unsorted – frontend must sort; verify API `order` correct, report UI sort bug.
- Pipeline delete 500 with deals: missing guard – capture logs, manually move deals then delete; report P0 (data loss risk).
- Multi-currency total NaN: missing FX rate for INR – check `GET /api/fx/latest?base=USD`, verify snapshot job ran; fallback rate documented.

## 10. Pass/Fail Checklist

- [ ] TC01–TC02 pipeline created UI+API with 5 ordered stages + exclusive Won/Lost
- [ ] TC03 drag reorder persists UI+API contiguous
- [ ] TC04 edit name/prob updates Kanban + weighted + audit
- [ ] TC05 prob -5/150/abc blocked (400 + inline)
- [ ] TC06 multi-Won / both-flags / zero-closed blocked
- [ ] TC07 Closed 100/0 enforced or documented advisory
- [ ] TC08 default exclusive, new/converted deals land there
- [ ] TC09 per-stage counts match API, sum correct
- [ ] TC10 delete with deals migrates without loss + audit, Cancel no-op
- [ ] TC11 empty delete simple confirm succeeds
- [ ] TC12 closed/last deletion guarded (400/422)
- [ ] TC13 pipeline with deals blocked, no cascade
- [ ] TC14 inactive hidden from dropdown, history retained
- [ ] TC15 Rep 403 + read-only, can still use in deals
- [ ] TC16 dup/empty/long 400, no partial
- [ ] TC17 concurrent edit no corrupt order
- [ ] TC18 USD/EUR/INR totals + base + symbols correct
- [ ] TC19 switcher <1s, deep-link, filter behavior documented
- [ ] TC20 audit complete with migration ids
- [ ] TC21 bulk prob all persist (if supported)
- [ ] TC22 500-deal Kanban <3s virtualized
- [ ] All curls executed, order verified after each mutation
- [ ] Regression: deals, conversion default, forecast, search intact
- [ ] Cleanup: test pipeline removed/deals cleaned, default restored
- Tester: _______________ Date: _______________ Pipeline ID: _______________ Result: PASS / FAIL
