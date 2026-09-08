# Reports – Comprehensive Testing Guide

Base URLs: API `http://localhost:3001`, Web `http://localhost:3000`.

## 1. Overview

This guide covers manual and API testing for Reports in the CRM.
Reports include Forecast, Pipeline, Activity, Conversion, and Cohort reports, plus CSV export and commit / best-case / pipeline forecast categories.
The purpose of this guide is to give QA, developers, and UAT testers a repeatable, exhaustive checklist to validate correctness, permissions, performance, and export integrity.
Scope includes report builder UI, filters, date ranges, grouping, drill-down, saved views, scheduled exports, and CSV download behavior.
Out of scope is underlying ETL correctness beyond API contracts, but data consistency checks are included.
Key user roles: Admin (all reports + org-wide), Manager (team reports), Rep (own pipeline/forecast), Viewer (read-only where allowed).
Critical business rules: forecast categories are Commit, Best-Case, and Pipeline (plus Omitted/Closed); amounts roll up by close-date and owner; CSV export must match on-screen totals.
Success criteria: all 18+ test cases pass, CSV totals reconcile to UI within rounding, and API responses return correct aggregations with auth enforcement.

## 2. Prerequisites & Test Data Setup

- Environment running: Web on `http://localhost:3000`, API on `http://localhost:3001`, database seeded.
- Test accounts: `admin@test.com / Admin123!` (Admin), `manager@test.com / Manager123!` (Manager), `rep1@test.com / Rep123!` and `rep2@test.com / Rep123!` (Reps).
- Seed data requirements:
  - At least 3 pipelines (e.g., Sales, Renewals, Partnerships) with 4+ stages each.
  - At least 40 deals spread across stages, owners (rep1/rep2), close dates (past, current month, next quarter), and forecast categories (Commit, Best-Case, Pipeline, Omitted).
  - At least 20 contacts and 10 companies linked to deals.
  - At least 50 activities (calls, emails, meetings, tasks completed) over last 90 days for activity/cohort reports.
  - At least 15 won/lost deals in last 2 quarters for conversion reports.
- Date setup: set system test date to mid-quarter (e.g., 2026-02-15) so current-quarter forecast is meaningful; document timezone as UTC for API assertions.
- Permissions: ensure rep1 cannot see rep2 private deals if org uses private visibility; manager sees team.
- CSV prerequisites: clean `Downloads` folder, LibreOffice/Excel available, UTF-8 handling verified.
- API token: obtain JWT via `POST /api/auth/login` for each role; store as `$ADMIN_TOKEN`, `$MGR_TOKEN`, `$REP_TOKEN`.
- Reset strategy: snapshot DB before run; re-seed if totals drift; record seed commit hash in test run notes.
- Browser: Chrome latest + Firefox for cross-browser; clear cache before report caching tests.
- Network: throttle optional for export large-file test; disable ad-blockers that intercept downloads.

## 3. Test Environment Matrix

| Dimension   | Variants to Cover                                                     |
| ----------- | --------------------------------------------------------------------- |
| Browser     | Chrome 130+, Firefox 132+, Edge 130+, Safari 17+ (if available)       |
| Viewport    | Desktop 1440px, Laptop 1280px, Tablet 768px                           |
| Role        | Admin, Manager, Rep (own), Viewer/Read-only                           |
| Data volume | Small (40 deals), Medium (500 deals via script), Large (5k deals)     |
| Date range  | Today, This Week, This Month, This Quarter, Last Quarter, Custom, YTD |
| Export size | <100 rows, ~1k rows, ~10k rows                                        |
| API client  | curl, Postman, automated Jest/Supertest                               |
| Timezone    | UTC, America/New_York, Asia/Kolkata                                   |

- Record environment in test run: OS, browser version, screen size, seed ID, tester, date.
- For performance tests, use Medium/Large datasets and measure TTFB and render time.
- Verify caching behavior does not leak data across roles (log in as rep1 then rep2 without hard refresh).
- Mobile is best-effort for reports; tables may scroll horizontally – verify no data loss.
- All API tests must run against `http://localhost:3001` with valid JWT; also test 401 without token.

## 4. Detailed Step-by-Step Test Cases (at least 18 numbered TC cases)

### TC-01 – View Forecast Report Default (Current Quarter)

- **Objective:** Verify forecast report loads with current-quarter defaults and correct category totals.
- **Preconditions:** Logged in as Manager; seeded forecast deals.
- **Steps:**
  1. Navigate to `http://localhost:3000/reports` → select Forecast tab.
  2. Verify default date range shows current quarter.
  3. Note Commit, Best-Case, Pipeline totals on screen.
  4. Expand each category to list constituent deals.
  5. Cross-check count matches deal list filtered by `forecastCategory`.
- **Expected:** Totals render <3s; categories sum correctly; drill-down lists correct deals.

### TC-02 – Forecast Category Assignment (Commit / Best-Case / Pipeline)

- **Objective:** Verify changing a deal's forecast category reflects in forecast report.
- **Preconditions:** Logged in as rep1; deal `DEAL-001` in Pipeline category.
- **Steps:**
  1. Open `DEAL-001` detail → change Forecast Category to Commit.
  2. Save and navigate to Reports → Forecast.
  3. Filter Owner = rep1.
  4. Verify Commit total increased by deal amount; Pipeline decreased.
  5. Revert change and re-verify.
- **Expected:** Category totals update immediately after refresh; no stale cache.

### TC-03 – Pipeline Report by Stage

- **Objective:** Validate pipeline funnel/stage breakdown matches deal stages.
- **Preconditions:** Sales pipeline with stages Qualification → Proposal → Negotiation → Closed Won/Lost.
- **Steps:**
  1. Open Reports → Pipeline.
  2. Select Pipeline = Sales.
  3. Record amount/count per stage.
  4. Go to Deals list filtered per stage and compare counts.
  5. Move a deal to next stage; refresh report.
- **Expected:** Stage totals match Deals list; movement reflected on refresh.

### TC-04 – Activity Report (Calls / Emails / Meetings)

- **Objective:** Verify activity volume by type, owner, and date.
- **Preconditions:** 50+ activities seeded across 2 reps, 30 days.
- **Steps:**
  1. Open Reports → Activity.
  2. Set range Last 30 days; Group by Type.
  3. Verify counts per type.
  4. Switch Group by Owner; verify rep1 vs rep2 split.
  5. Click a bar/row to drill to activity list.
- **Expected:** Groupings correct; drill-down shows underlying activities.

### TC-05 – Conversion Report (Stage-to-Stage / Win Rate)

- **Objective:** Validate conversion % and win-rate calculations.
- **Preconditions:** Historical won/lost deals present.
- **Steps:**
  1. Open Reports → Conversion.
  2. Select This Quarter + Last Quarter.
  3. Record Win Rate = Won / (Won+Lost).
  4. Manually compute from Deals export and compare.
  5. Check stage conversion (e.g., Proposal→Negotiation %).
- **Expected:** Percentages match manual calc within 0.1%; zero-division shows `—` not `NaN`.

### TC-06 – Cohort Report (Deals by Created Month)

- **Objective:** Verify cohort grouping by created month and won % over time.
- **Preconditions:** Deals created across last 6 months.
- **Steps:**
  1. Open Reports → Cohorts.
  2. Verify X-axis months last 6 months.
  3. Hover/click a cohort cell for detail.
  4. Filter to Segment = SMB vs Enterprise if available.
  5. Verify totals per cohort.
- **Expected:** Cohorts complete with no missing months; empty months show 0.

### TC-07 – Date Range & Custom Range

- **Objective:** Verify all presets and custom range filter correctly.
- **Preconditions:** Deals with close dates spanning 12 months.
- **Steps:**
  1. Cycle through Today, This Week, This Month, This Quarter, YTD.
  2. For each, note total and verify plausible (narrower range ≤ wider).
  3. Set Custom 2026-01-01 to 2026-01-31; verify only Jan deals.
  4. Set invalid range (end < start); verify validation error.
  5. Clear filter restores default.
- **Expected:** Validation blocks invalid range; custom filtering exact inclusive.

### TC-08 – Owner / Team Filter & Permissions

- **Objective:** Verify role-based visibility in reports.
- **Preconditions:** rep1 and rep2 own distinct deals.
- **Steps:**
  1. As rep1, open Forecast; verify only own + shared visible.
  2. As manager, filter Owner=rep1 vs rep2 vs All.
  3. As admin, verify All matches sum of reps.
  4. Attempt to access rep2-only report URL as rep1 (if deep-linkable).
- **Expected:** 403 or filtered view for unauthorized; no leakage via API either.

### TC-09 – CSV Export – Forecast

- **Objective:** Verify CSV export matches on-screen forecast.
- **Preconditions:** Forecast with at least 20 rows.
- **Steps:**
  1. Apply filter Owner=All, Quarter=Current.
  2. Click Export CSV.
  3. Verify file downloads as `forecast-*.csv`.
  4. Open CSV; sum Amount column per Category.
  5. Compare to UI totals.
- **Expected:** Row count matches; sums match; headers correct; UTF-8 BOM if needed.

### TC-10 – CSV Export – Special Characters & Large Values

- **Objective:** Verify CSV escaping and formatting.
- **Preconditions:** Deal names with commas, quotes, newlines, unicode (e.g., `Acme, "Big" Co\nß`).
- **Steps:**
  1. Create deal with tricky name and amount 1000000.50.
  2. Export containing report.
  3. Open in Excel/Sheets and in text editor.
  4. Verify quoting preserves single row; amount not truncated.
  5. Verify date format ISO `YYYY-MM-DD`.
- **Expected:** No broken rows; quotes doubled per RFC4180.

### TC-11 – Saved Views / Report Persistence

- **Objective:** Verify saving and reloading report filter sets.
- **Preconditions:** Logged in as manager.
- **Steps:**
  1. Configure Pipeline report: Pipeline=Sales, Owner=Team A, Range=Quarter.
  2. Save as `Q1 Team A Review`.
  3. Reload page; apply saved view.
  4. Share URL (copy link) and open in new tab.
  5. Delete saved view.
- **Expected:** Saved view restores filters; deep link works; delete removes.

### TC-12 – Drill-Down Navigation

- **Objective:** Verify clicking report segments navigates to filtered record list.
- **Preconditions:** Any report with clickable segments.
- **Steps:**
  1. In Pipeline report, click Negotiation stage count.
  2. Verify navigation to Deals list pre-filtered.
  3. Verify breadcrumb/back returns to report with filters intact.
  4. Repeat for Forecast Commit and Activity bar.
- **Expected:** Filters carry over; back preserves report state.

### TC-13 – Empty State & Zero Data

- **Objective:** Verify graceful empty states.
- **Preconditions:** Filter to future quarter with no deals or new test org.
- **Steps:**
  1. Set Close Date to far future (e.g., 2030-Q1).
  2. Verify each report shows empty illustration + `No data for this filter`.
  3. Verify Export still produces header-only CSV (not error).
  4. Reset filter recovers data.
- **Expected:** No blank crash, no console errors, export header-only.

### TC-14 – Refresh / Caching & Data Freshness

- **Objective:** Verify report refresh picks up new deals.
- **Preconditions:** Reports page open.
- **Steps:**
  1. Note Pipeline total.
  2. In second tab, create new deal in Qualification $5000.
  3. Back in Reports tab, click Refresh.
  4. Verify total increased.
  5. Verify timestamp `Updated just now / xm ago` updates.
- **Expected:** Refresh invalidates cache; no manual hard-reload needed.

### TC-15 – Performance with Large Dataset

- **Objective:** Verify reports remain usable with 5k deals.
- **Preconditions:** Seed script generates 5k deals (use staging clone).
- **Steps:**
  1. Load Forecast report; measure load time.
  2. Switch to Conversion; measure.
  3. Export CSV (~5k rows); verify completes <30s.
  4. Check pagination or virtualization if applied.
- **Expected:** Load <5s for UI, export <30s; no browser freeze.

### TC-16 – Currency & Rounding Consistency

- **Objective:** Verify currency formatting and rounding matches everywhere.
- **Preconditions:** Deals with cents (e.g., $1234.567) and multi-currency if supported.
- **Steps:**
  1. View Pipeline totals; note formatting ($, commas, 2 decimals).
  2. Export CSV; check raw values.
  3. Compare to Deal detail and API `amount`.
  4. Sum CSV raw vs UI rounded; document rounding rule.
- **Expected:** UI rounds half-up to 2 decimals; CSV preserves raw or 2-dec consistent; documented.

### TC-17 – Scheduled / Shared Reports (if supported)

- **Objective:** Verify schedule email or share link behavior.
- **Preconditions:** Email catcher (Mailhog) configured.
- **Steps:**
  1. Schedule Weekly Forecast email to manager.
  2. Trigger manually / wait for cron.
  3. Verify email received with CSV or link.
  4. Revoke schedule; verify no further emails.
- **Expected:** Email contains correct totals; unsubscribe/revoke works. If feature absent, record N/A.

### TC-18 – Accessibility & Responsive Reports

- **Objective:** Verify reports usable via keyboard and on small screens.
- **Preconditions:** Chrome + keyboard only.
- **Steps:**
  1. Tab through filters, date pickers, export button; verify focus visible.
  2. Activate Export via Enter; verify download.
  3. Resize to 768px; verify tables scroll, charts legible.
  4. Run axe check; verify no critical violations.
- **Expected:** All controls keyboard reachable; charts have text alternative/table view.

### TC-19 – Negative: Unauthorized Export & Tampered Filters

- **Objective:** Verify API rejects unauthorized report access.
- **Preconditions:** Valid rep token + invalid token.
- **Steps:**
  1. Call forecast API without token → expect 401.
  2. As rep1, request `owner=rep2` restricted data → expect filtered or 403 per spec.
  3. Inject `?limit=9999999` → expect capped/paginated.
  4. Request CSV with SQL injection in filter `'; DROP TABLE deals;--` → expect sanitized.
- **Expected:** Proper 4xx, no data leak, no 500.

## 5. API Testing Section

Base: `http://localhost:3001`. Auth: `Authorization: Bearer <JWT>`.

| Method & Endpoint                                                      | Purpose                              | Auth   | Notes                          |
| ---------------------------------------------------------------------- | ------------------------------------ | ------ | ------------------------------ |
| `GET /api/reports/forecast?range=this_quarter&groupBy=category`        | Forecast rollup Commit/Best/Pipeline | Bearer | Returns totals + breakdown     |
| `GET /api/reports/pipeline?pipelineId=:id`                             | Stage breakdown                      | Bearer | Amount + count per stage       |
| `GET /api/reports/activity?from=2026-01-01&to=2026-03-31&groupBy=type` | Activity aggregates                  | Bearer | Validates UI activity chart    |
| `GET /api/reports/conversion?from=2025-10-01&to=2026-03-31`            | Win rate + stage conversion          | Bearer | Check won/lost math            |
| `GET /api/reports/cohorts?period=month&limit=6`                        | Cohort buckets                       | Bearer | Created-month grouping         |
| `GET /api/reports/forecast/export?format=csv&range=this_quarter`       | CSV export                           | Bearer | `text/csv` content-disposition |
| `GET /api/health`                                                      | Service health                       | None   | Pre-flight check               |

```bash
# 1) Login and save token
curl -s -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"manager@test.com","password":"Manager123!"}'
# -> copy .token as $MGR_TOKEN

# 2) Forecast report (current quarter)
curl -s http://localhost:3001/api/reports/forecast?range=this_quarter \
  -H "Authorization: Bearer $MGR_TOKEN" | python3 -m json.tool

# 3) Pipeline breakdown for a pipeline
curl -s "http://localhost:3001/api/reports/pipeline?pipelineId=SALES_ID" \
  -H "Authorization: Bearer $MGR_TOKEN" | python3 -m json.tool

# 4) Activity grouped by type
curl -s "http://localhost:3001/api/reports/activity?from=2026-01-01&to=2026-03-31&groupBy=type" \
  -H "Authorization: Bearer $MGR_TOKEN" | python3 -m json.tool

# 5) Conversion + CSV export check
curl -s "http://localhost:3001/api/reports/conversion?from=2025-10-01&to=2026-03-31" \
  -H "Authorization: Bearer $MGR_TOKEN" | python3 -m json.tool

curl -i "http://localhost:3001/api/reports/forecast/export?format=csv&range=this_quarter" \
  -H "Authorization: Bearer $MGR_TOKEN" -o /tmp/forecast.csv
head -n 20 /tmp/forecast.csv
wc -l /tmp/forecast.csv
```

- Assertions: `forecast.totals.commit + bestCase + pipeline` equals sum of rows; `pipeline.stages[].count` sums to total; CSV line count = JSON row count +1 header.
- Negative: omit header → `401`; tamper `range=invalid` → `400` with error code; `limit=999999` → capped at e.g., 1000 with `meta.truncated=true`.
- Compare API totals to UI totals for same filters; log mismatches with screenshots + JSON snapshots.

## 6. UI Testing Section

- Navigation: Sidebar → Reports; tabs Forecast | Pipeline | Activity | Conversion | Cohorts; URL reflects `?tab=forecast&range=this_quarter` for shareability.
- Filters: date presets, custom date picker (keyboard input + calendar), Owner/Team multi-select, Pipeline selector; Apply/Clear behave correctly.
- Visuals: bar/line/funnel charts render with legend, tooltips on hover show exact amounts, y-axis formatted with currency, no overlapping labels at 1280px.
- Tables: sortable Amount/Close Date/Owner columns, pagination, row click → deal drawer, sticky header on scroll.
- Export button: visible per tab, disabled with spinner while generating, toast `Export ready – forecast-2026-Q1.csv` on success.
- Loading/empty/error: skeleton shimmer on load, empty illustration on no data, inline error with Retry on 500.
- Cross-browser: verify number formatting (`$12,345.00`) consistent Chrome/Firefox; print stylesheet does not truncate tables.
- Responsiveness: at 768px filters collapse into drawer; charts stack vertically; horizontal scroll for tables with sticky first column.

## 7. Regression & Cross-Feature Impact

- Deals: stage change, amount edit, close-date shift, owner reassignment, forecast category edit must reflect in reports after refresh.
- Contacts/Companies: deletion or merge must not orphan report drill-down links (should show `Deleted` or exclude cleanly).
- Permissions/Roles: role change (rep→manager) must immediately widen report visibility; revocation must narrow.
- Imports: bulk import of 500 deals must appear in next refresh; failed rows must not inflate totals.
- Currency/settings: org currency or fiscal-quarter start change must recalc ranges (document expected shift).
- Dashboards: widgets that embed report data must stay in sync with Reports page.
- Audit log: report exports (especially CSV) should log actor + filters if compliance required.
- Performance: deal CRUD latency should not be degraded by report aggregation indexes.

## 8. Expected Results Summary Table

| TC    | Title               | Expected Result             | Severity if Fails |
| ----- | ------------------- | --------------------------- | ----------------- |
| TC-01 | Forecast default    | Correct quarter totals, <3s | Critical          |
| TC-02 | Category assignment | Totals shift correctly      | Critical          |
| TC-03 | Pipeline by stage   | Matches Deals list          | Critical          |
| TC-04 | Activity report     | Correct groupings + drill   | Major             |
| TC-05 | Conversion          | Win-rate math exact         | Major             |
| TC-06 | Cohort              | Complete months, correct %  | Major             |
| TC-07 | Date ranges         | Presets + custom exact      | Major             |
| TC-08 | Owner/permissions   | No leakage                  | Critical          |
| TC-09 | CSV forecast        | Matches UI                  | Critical          |
| TC-10 | CSV escaping        | RFC4180 compliant           | Major             |
| TC-11 | Saved views         | Persist + share             | Minor             |
| TC-12 | Drill-down          | Filtered navigation         | Major             |
| TC-13 | Empty state         | Graceful + header CSV       | Minor             |
| TC-14 | Refresh/caching     | Fresh data on demand        | Major             |
| TC-15 | Performance large   | <5s UI, <30s export         | Major             |
| TC-16 | Currency/rounding   | Consistent formatting       | Minor             |
| TC-17 | Scheduled/share     | Email/link correct          | Minor             |
| TC-18 | A11y/responsive     | Keyboard + mobile OK        | Minor             |
| TC-19 | Negative auth       | 401/403, sanitized          | Critical          |

## 9. Troubleshooting & Common Failures

| Symptom                      | Likely Cause                                   | Fix / Check                                                      |
| ---------------------------- | ---------------------------------------------- | ---------------------------------------------------------------- |
| Forecast totals 0            | Wrong quarter / timezone; seed close dates off | Verify `range` param + DB `closeDate` values; check UTC vs local |
| Pipeline stage mismatch      | Cache stale; deal pipelineId wrong             | Click Refresh; query `GET /api/deals?stage=X` to compare         |
| CSV totals differ by cents   | Rounding UI vs raw                             | Sum raw CSV; confirm rounding rule half-up 2-dec                 |
| Export downloads HTML        | 401 redirect to login                          | Include `Authorization` header; check token expiry               |
| Broken CSV rows              | Unescaped commas/quotes                        | Inspect raw CSV; file bug if not RFC4180                         |
| Slow report >10s             | Missing index on `closeDate,stage`             | Check DB indexes; test with `EXPLAIN`; paginate                  |
| 500 on conversion            | Division by zero; null stage                   | Check server logs; verify empty-period handling                  |
| Drill-down shows wrong deals | Filter param not propagated                    | Inspect URL query; compare API `filter` echo                     |

- Logs: API `logs/combined.log` for 500 stack; browser DevTools Network for `reports/*` payloads; compare `meta.total` vs UI.
- Data repair: re-run seed `npm run seed:reports`; vacuum/analyze if Postgres; clear Redis `reports:*` if caching enabled.
- Flaky: date-dependent tests fail at quarter boundary – pin test date via env `TEST_NOW=2026-02-15`.

## 10. Pass/Fail Checklist

- [ ] TC-01–TC-06 core reports (forecast/pipeline/activity/conversion/cohort) pass with seeded data.
- [ ] TC-07 date presets + custom range validated including invalid-range error.
- [ ] TC-08 permission isolation verified (rep cannot see restricted owner data via UI or API).
- [ ] TC-09 CSV export row count and sums reconcile to UI for forecast.
- [ ] TC-10 special-character CSV opens cleanly in Excel/Sheets and text editor.
- [ ] TC-11 saved views persist, deep-link, and delete correctly.
- [ ] TC-12 drill-down navigates with filters intact and back preserves state.
- [ ] TC-13 empty-state illustration + header-only CSV verified.
- [ ] TC-14 refresh updates totals after new deal without hard reload.
- [ ] TC-15 large-dataset performance within budget (<5s UI, <30s export).
- [ ] TC-16 currency/rounding consistent across UI, CSV, API.
- [ ] API section: all curl examples return 200 with expected schema; 401 without token.
- [ ] No console errors, no critical axe violations, responsive at 768px.
- [ ] Test evidence attached: screenshots of each tab, CSV samples, API JSON snapshots.
- [ ] Tester, date, seed hash, browser version recorded; defects filed with repro steps.
