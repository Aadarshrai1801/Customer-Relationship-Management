# Dashboards – Comprehensive Testing Guide

Base URLs: API `http://localhost:3001`, Web `http://localhost:3000`.

## 1. Overview

This guide covers manual and API testing for Customizable Dashboards: layout, widgets, drag-drop arrange, refresh/caching (5-minute cache), and per-user persistence.
Dashboards aggregate pipeline, forecast, activity, and custom widgets into a single glanceable view.
Scope includes default dashboard seeding, add/remove/resize/reorder widgets, widget-type configs, manual refresh, auto-refresh, 5-minute server cache semantics, sharing/visibility, and empty states.
Out of scope is report calculation correctness itself (see `reports.md`), but dashboard-vs-report consistency is in scope.
Key roles: Admin (manage shared/org defaults), Manager (team dashboards), Rep (personal dashboard).
Critical rules: layout persists per user; widget data cached 5 minutes server-side with `X-Cache: HIT/MISS` or `cachedAt`; manual Refresh bypasses cache; widgets fail independently (one error must not blank the whole board).
Success criteria: layout survives reload, cache honors 5-min TTL, refresh fetches fresh data, and widget errors degrade gracefully.

## 2. Prerequisites & Test Data Setup

- Services up: Web `http://localhost:3000`, API `http://localhost:3001`, DB seeded, cache (Redis/memory) enabled.
- Users: admin, manager, rep1, rep2 with distinct deal ownership for personalized widgets.
- Seed: at least 30 deals across stages/owners, 30 activities, 1 pipeline; ensures widgets show non-zero data.
- Widget catalog to test: Pipeline Snapshot, Forecast Summary, Today's Focus/Tasks, Recent Activity, Fresh Deals, Top People, Activity Chart, Conversion Mini, Custom Number/Goal.
- Browser: Chrome + Firefox; viewport 1440px and 768px; clear localStorage once to test first-run default.
- Tokens: JWTs for each role via `POST /api/auth/login`; save as env vars.
- Time control: note wall-clock time before cache tests; use stopwatch for 5-min TTL (or shorten TTL via env `DASHBOARD_CACHE_TTL_MS` if supported for test).
- Network: DevTools open to inspect `Cache-Control`, `X-Cache`, `cachedAt`; throttling profile for skeleton tests.
- Baseline: screenshot default dashboard for rep1 before customization; export layout JSON via API for diffing.
- Cleanup: dedicated test dashboard named `QA - <date>` to avoid clobbering personal boards; delete after run if needed.

## 3. Test Environment Matrix

| Dimension    | Variants                                                                |
| ------------ | ----------------------------------------------------------------------- |
| Browser      | Chrome 130+, Firefox 132+, Edge 130+                                    |
| Viewport     | 1440px desktop, 1280px laptop, 768px tablet, 375px mobile (best-effort) |
| Role         | Admin, Manager, Rep, Viewer                                             |
| Layout state | Default seeded, Customized, Empty (all removed), Shared                 |
| Cache state  | Cold (MISS), Warm (HIT), Expired (>5min), Bypass (manual refresh)       |
| Data volume  | Small (30 deals), Medium (500), Large (5k for perf)                     |
| API client   | curl, Postman, frontend                                                 |
| Theme        | Light, Dark (widget parity)                                             |

- Record OS, browser, viewport, user, `cachedAt` values, and layout JSON hash per run.
- Test both cold load (incognito) and warm reload; compare timings.
- Verify no cross-user leakage: rep1 layout must not appear for rep2.
- Dark-mode check per widget (charts, numbers, empty states legible).

## 4. Detailed Step-by-Step Test Cases (at least 18 numbered TC cases)

### TC-01 – First-Run Default Dashboard Seeds

- **Objective:** Verify new user gets sensible default layout + widgets.
- **Preconditions:** Fresh user `qanew@test.com` or cleared storage.
- **Steps:**
  1. Log in as fresh user.
  2. Navigate to `http://localhost:3000/` or `/dashboards`.
  3. Verify widgets present (e.g., Pipeline Snapshot, Today's Focus, Recent Activity).
  4. Verify no console errors and skeletons resolve <3s.
  5. Reload; verify same layout persists.
- **Expected:** Default board renders quickly with non-broken widgets.

### TC-02 – Add Widget from Catalog

- **Objective:** Verify adding each widget type works.
- **Preconditions:** Logged in as rep1; dashboard in edit/customize mode if required.
- **Steps:**
  1. Click Customize/Add Widget.
  2. Add Forecast Summary; configure Quarter=Current.
  3. Save; verify widget appears with data.
  4. Repeat for Activity Chart and Top People.
  5. Reload page; verify all persist.
- **Expected:** Added widgets render and survive reload.

### TC-03 – Remove Widget

- **Objective:** Verify removal persists and is reversible via re-add.
- **Preconditions:** Dashboard with at least 4 widgets.
- **Steps:**
  1. Remove Recent Activity widget (confirm if prompted).
  2. Verify it disappears and layout reflows without gap.
  3. Reload; verify still absent.
  4. Re-add it; verify data returns.
- **Expected:** Removal persists; re-add restores.

### TC-04 – Drag-Drop Reorder Layout

- **Objective:** Verify drag-drop reorder persists per user.
- **Preconditions:** At least 3 widgets; desktop viewport.
- **Steps:**
  1. Drag Forecast widget from bottom to top.
  2. Verify drop indicator and reorder animation.
  3. Save if explicit Save required; reload.
  4. Verify order retained.
  5. Log in as rep2; verify rep1 order not applied.
- **Expected:** Order persists per user; no cross-user bleed.

### TC-05 – Resize Widget (if supported)

- **Objective:** Verify resize (small/medium/large or drag handle) persists.
- **Preconditions:** Resizable widget (e.g., chart).
- **Steps:**
  1. Resize Activity Chart to Large/Wide.
  2. Verify content reflows (chart expands, no clipping).
  3. Reload; verify size retained.
  4. Shrink to Small; verify numbers still legible.
- **Expected:** Sizes persist; content responsive. If unsupported, record N/A.

### TC-06 – Widget Configuration (Filters / Date / Owner)

- **Objective:** Verify per-widget settings affect only that widget.
- **Preconditions:** Two widgets showing pipeline data.
- **Steps:**
  1. Configure Widget A: Owner=Me; Widget B: Owner=Team.
  2. Verify A total ≤ B total (for rep).
  3. Reload; verify configs retained.
  4. Reset Widget A to default; verify B unchanged.
- **Expected:** Independent configs; persistence correct.

### TC-07 – Manual Refresh Bypasses Cache

- **Objective:** Verify Refresh button forces fresh fetch.
- **Preconditions:** Dashboard loaded (warm cache).
- **Steps:**
  1. Note widget `Updated xm ago` / `cachedAt`.
  2. In second tab create new deal $9000.
  3. Back on dashboard, click Refresh (per-widget if available + global).
  4. Verify totals increase and timestamp resets to `just now`.
  5. Inspect Network: request has `?refresh=true` or `Cache-Control: no-cache`.
- **Expected:** Fresh data; network shows MISS/bypass.

### TC-08 – 5-Minute Cache HIT Behavior

- **Objective:** Verify second load within 5 min serves cache.
- **Preconditions:** Cold cache (restart cache or wait expiry).
- **Steps:**
  1. Hard reload; record `X-Cache: MISS` + `cachedAt=T0`.
  2. Reload within 1 min; verify `X-Cache: HIT` and same `cachedAt`.
  3. Verify UI shows `Updated 1m ago` not `just now`.
  4. Create deal; reload without manual refresh; verify total unchanged (stale but expected).
- **Expected:** HIT within TTL; staleness documented and expected.

### TC-09 – Cache Expiry After 5 Minutes

- **Objective:** Verify cache expires and refetches after TTL.
- **Preconditions:** Warm cache with known `cachedAt`.
- **Steps:**
  1. Wait 5+ min (or stub TTL short for test).
  2. Reload dashboard.
  3. Verify `X-Cache: MISS` and new `cachedAt`.
  4. Verify new deal from TC-08 now appears without manual refresh.
- **Expected:** Auto-fresh after expiry; no stuck stale data.

### TC-10 – Widget Independent Failure

- **Objective:** Verify one failing widget does not break board.
- **Preconditions:** Ability to force failure (invalid widget config, blocked endpoint, or API down for one route).
- **Steps:**
  1. Configure a widget with invalid pipelineId (via API tamper if needed).
  2. Reload dashboard.
  3. Verify failing widget shows inline error + Retry, others render.
  4. Fix config; click Retry; verify recovery.
- **Expected:** Isolated error card; board usable.

### TC-11 – Empty Dashboard State

- **Objective:** Verify removing all widgets shows helpful empty state.
- **Preconditions:** Test dashboard.
- **Steps:**
  1. Remove all widgets.
  2. Verify illustration + `Your dashboard is empty – Add widgets` + CTA.
  3. Reload; verify empty persists (not revert to default).
  4. Add one widget; verify empty clears.
- **Expected:** Graceful empty; CTA works.

### TC-12 – Dashboard vs Reports Consistency

- **Objective:** Verify widget totals match Reports page for same filters.
- **Preconditions:** Same quarter/team filters.
- **Steps:**
  1. Note Forecast widget Commit total.
  2. Open Reports → Forecast same range; compare.
  3. Note Pipeline Snapshot stage totals vs Reports → Pipeline.
  4. Force refresh both; compare again.
- **Expected:** Match within rounding; mismatches filed with timestamps (cache skew noted).

### TC-13 – Permissions & Personalization

- **Objective:** Verify widgets respect role visibility.
- **Preconditions:** rep1/rep2 distinct deals.
- **Steps:**
  1. As rep1, verify My Pipeline widget excludes rep2 private deals.
  2. As manager, verify Team widget includes both.
  3. Attempt to fetch another user's dashboard layout via API (`GET /api/dashboards?userId=rep2`) as rep1 → expect 403 or own only.
- **Expected:** No leakage via UI or API.

### TC-14 – Responsive Layout (Tablet/Mobile)

- **Objective:** Verify dashboard stacks legibly on small screens.
- **Preconditions:** Dashboard with 6 widgets.
- **Steps:**
  1. Resize to 768px; verify 2-col → 1-col stack, no overlap.
  2. Resize to 375px; verify cards full-width, charts scroll/condense.
  3. Verify drag-drop degrades to move-up/down buttons or disabled gracefully.
  4. Verify refresh still reachable.
- **Expected:** No clipped content, no horizontal page scroll (widget-internal scroll OK).

### TC-15 – Dark-Mode Parity

- **Objective:** Verify widgets legible in dark mode.
- **Preconditions:** Theme toggle available.
- **Steps:**
  1. Switch to Dark Mode.
  2. Verify each widget: text contrast, chart colors, empty states, skeletons.
  3. Toggle back to Light; verify no stuck dark styles.
  4. Reload in Dark; verify persists if setting persisted.
- **Expected:** WCAG AA contrast; charts readable.

### TC-16 – Performance & Skeleton States

- **Objective:** Verify perceived performance with skeletons.
- **Preconditions:** Throttle to Fast 3G.
- **Steps:**
  1. Hard reload; verify skeleton shimmer per widget immediately.
  2. Measure full render <5s on broadband, <10s throttled.
  3. Verify widgets stream in independently (not all-or-nothing).
  4. Test with 5k deals for jank.
- **Expected:** Progressive load; no layout shift that misclicks.

### TC-17 – Multi-Dashboard / Shared Boards (if supported)

- **Objective:** Verify multiple boards and sharing.
- **Preconditions:** Feature flag check.
- **Steps:**
  1. Create second dashboard `Team Review`.
  2. Add widgets; switch between boards; verify independent layouts.
  3. Share read-only link (if supported); open incognito with link.
  4. Delete second board; verify primary intact.
- **Expected:** Independent persistence. If unsupported, verify single-board only and record N/A.

### TC-18 – Keyboard & Accessibility

- **Objective:** Verify dashboard operable via keyboard + screen reader.
- **Preconditions:** Keyboard only.
- **Steps:**
  1. Tab to Add Widget, open catalog via Enter, add via keyboard.
  2. Tab to Refresh; activate.
  3. Verify focus visible, widgets have headings/aria-labels.
  4. Run axe; verify no critical issues.
- **Expected:** Full keyboard path; charts have table/text alternative.

### TC-19 – Negative: Tampered Layout / API Abuse

- **Objective:** Verify API validates layout payloads.
- **Preconditions:** Valid token.
- **Steps:**
  1. `PUT` layout with unknown widget type → expect 400.
  2. `PUT` huge layout (100 widgets) → expect 400/limit.
  3. Request dashboard without token → 401.
  4. XSS payload in widget title `<script>alert(1)</script>` → stored escaped, not executed.
- **Expected:** Validation errors, no script execution, no 500.

## 5. API Testing Section

| Method & Endpoint                                      | Purpose                                  | Auth   | Notes                       |
| ------------------------------------------------------ | ---------------------------------------- | ------ | --------------------------- |
| `GET /api/dashboards`                                  | Get current user layout + widget configs | Bearer | Includes widget array       |
| `PUT /api/dashboards`                                  | Save layout/order/sizes                  | Bearer | Body `{widgets:[...]}`      |
| `GET /api/dashboards/widgets/:type?range=this_quarter` | Widget data (pipeline/forecast/activity) | Bearer | Check `cachedAt`, `X-Cache` |
| `POST /api/dashboards/refresh` or `?refresh=true`      | Bypass cache                             | Bearer | Forces MISS                 |
| `GET /api/health`                                      | Health                                   | None   | Pre-check                   |

```bash
# 1) Login
curl -s -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"rep1@test.com","password":"Rep123!"}'
# save token as $REP_TOKEN

# 2) Get layout
curl -s http://localhost:3001/api/dashboards \
  -H "Authorization: Bearer $REP_TOKEN" | python3 -m json.tool

# 3) Widget data (observe cache headers)
curl -i "http://localhost:3001/api/dashboards/widgets/forecast?range=this_quarter" \
  -H "Authorization: Bearer $REP_TOKEN" | head -n 40

# 4) Repeat to see HIT (same cachedAt)
curl -s "http://localhost:3001/api/dashboards/widgets/forecast?range=this_quarter" \
  -H "Authorization: Bearer $REP_TOKEN" | python3 -m json.tool

# 5) Save new layout order
curl -s -X PUT http://localhost:3001/api/dashboards \
  -H "Authorization: Bearer $REP_TOKEN" -H "Content-Type: application/json" \
  -d '{"widgets":[{"type":"forecast","size":"large"},{"type":"pipeline","size":"medium"}]}' | python3 -m json.tool

# 6) Force refresh bypass
curl -s "http://localhost:3001/api/dashboards/widgets/forecast?range=this_quarter&refresh=true" \
  -H "Authorization: Bearer $REP_TOKEN" | python3 -m json.tool
```

- Assert: first fetch `X-Cache: MISS`, second `HIT` with identical `cachedAt` within 5 min; `refresh=true` yields new `cachedAt`.
- Negative: no token → 401; bad widget type → 400; layout for other user → 403.

## 6. UI Testing Section

- Entry: `/`, `/dashboards`; header shows board title, `Updated xm ago`, global Refresh, Customize toggle.
- Catalog: modal/drawer lists widget types with descriptions + previews; search filters catalog.
- Layout: grid 12-col desktop; drag handle visible on hover; drop placeholder; resize handle bottom-right where supported.
- Widgets: each card has title, config (⋯) menu, refresh icon, timestamp, error/empty/loading states; numbers formatted consistently.
- Skeletons: shimmer blocks matching card shapes; no content jump >0.1 CLS ideally.
- Toasts: `Dashboard saved`, `Widget added/removed` confirmations; undo for remove if supported.
- Theme/responsive: verify dark parity, 768px stacking, 375px single column, sticky header intact.
- Persistence: reload, logout/login, different browser (same user) – layout follows user if server-persisted, else document localStorage-only.

## 7. Regression & Cross-Feature Impact

- Reports: widget totals must track Reports after cache expiry/refresh; filter logic shared.
- Deals/Tasks/Activity: CRUD must surface on dashboard after refresh/expiry; deletions must not leave ghost rows.
- Auth/Roles: role change must alter widget data scope immediately (after refresh).
- Theming/App Shell: sidebar collapse, dark mode, toasts must not break grid.
- Notifications: task due widgets vs notification counts should align directionally.
- Imports: bulk import must not permanently stale cache; next TTL or refresh picks it up.
- Performance: dashboard polling must not hammer API (verify Network: no tight loop, respects 5-min cache).

## 8. Expected Results Summary Table

| TC    | Title                 | Expected              | Severity |
| ----- | --------------------- | --------------------- | -------- |
| TC-01 | Default seeds         | Usable default <3s    | Major    |
| TC-02 | Add widget            | Renders + persists    | Major    |
| TC-03 | Remove                | Reflows + persists    | Minor    |
| TC-04 | Reorder               | Per-user persistence  | Major    |
| TC-05 | Resize                | Responsive + persists | Minor    |
| TC-06 | Per-widget config     | Independent           | Major    |
| TC-07 | Manual refresh bypass | Fresh + timestamp     | Critical |
| TC-08 | 5-min HIT             | Same cachedAt         | Major    |
| TC-09 | Expiry                | Auto-fresh after 5m   | Major    |
| TC-10 | Isolated failure      | Others render         | Major    |
| TC-11 | Empty state           | Helpful CTA           | Minor    |
| TC-12 | Reports consistency   | Match rounding        | Major    |
| TC-13 | Permissions           | No leakage            | Critical |
| TC-14 | Responsive            | Stacks cleanly        | Minor    |
| TC-15 | Dark parity           | Contrast OK           | Minor    |
| TC-16 | Skeletons/perf        | Progressive <5s       | Major    |
| TC-17 | Multi/share           | Independent or N/A    | Minor    |
| TC-18 | A11y keyboard         | Full path + axe clean | Minor    |
| TC-19 | Negative API          | 400/401, XSS escaped  | Critical |

## 9. Troubleshooting & Common Failures

| Symptom                        | Cause                                         | Fix                                                                |
| ------------------------------ | --------------------------------------------- | ------------------------------------------------------------------ |
| Dashboard blank                | JS error from one widget; layout JSON corrupt | Check console; `GET /api/dashboards` to inspect JSON; reset layout |
| Stale totals after deal create | Within 5-min cache window                     | Click Refresh or wait TTL; verify `cachedAt`                       |
| Refresh still stale            | Refresh not bypassing cache (bug)             | Inspect query param; file bug with HAR                             |
| Layout not persisting          | PUT failing (400/401) or localStorage-only    | Check Network PUT status; verify token; check storage quota        |
| Widgets overlap                | Grid lib breakpoint bug at 768px              | Screenshot viewport; test resize handler                           |
| HIT never occurs               | Cache disabled / TTL=0 in dev                 | Check env `DASHBOARD_CACHE_TTL_MS`; Redis running?                 |
| MISS every time                | Query string varies (timestamp param)         | Normalize cache key; inspect server logs                           |
| Dark chart unreadable          | Hardcoded light colors                        | File theming bug with screenshot                                   |

- Debug: DevTools Network filter `dashboards/widgets`, compare `cachedAt`; Application → LocalStorage for layout fallback; API logs for aggregation errors.
- Reset: `PUT /api/dashboards` with default JSON or Clear Site Data to restore seed.

## 10. Pass/Fail Checklist

- [ ] Default dashboard seeds and loads <3s with skeletons.
- [ ] Add/remove/reorder/resize persist across reload and per user.
- [ ] Per-widget configs independent and retained.
- [ ] Manual refresh bypasses cache with fresh `cachedAt`.
- [ ] HIT within 5 min (same `cachedAt`), MISS after expiry with fresh data.
- [ ] Isolated widget failure shows Retry without breaking board.
- [ ] Empty state helpful; consistency with Reports verified.
- [ ] Permissions: no cross-user data or layout leakage via UI/API.
- [ ] Responsive 768px/375px stacks; dark-mode parity; keyboard operable.
- [ ] API curls all behave (200 + cache headers; 401/400 negatives).
- [ ] Evidence: layout JSON before/after, cache header captures, screenshots light/dark/mobile.
- [ ] Defects filed with repro, `cachedAt` values, and viewport info.
