# Home & Overview – Comprehensive Testing Guide

Base URLs: API `http://localhost:3001`, Web `http://localhost:3000`.

## 1. Overview

This guide covers Home: greeting, pipeline snapshot, Today's focus, fresh deals/activity/people, and quick actions.
Home is the post-login landing that answers “What needs me today?” in <3s.
Scope includes personalized greeting (name/time-of-day), pipeline snapshot widget (totals by stage), Today's focus (due/overdue tasks, meetings), fresh lists (recent deals, latest activity, new people), quick actions (New Deal/Contact/Task/Activity), empty states, refresh, and deep links.
Out of scope is dashboard customization (see `dashboards.md`) – Home is opinionated/curated, not fully customizable (document if configurable).
Key roles: Rep (own scope), Manager (team scope), Admin (org scope); greeting/pickers respect scope.
Critical rules: all sections scope to viewer permissions; counts link to filtered lists; Today's focus prioritizes overdue → due-today → upcoming; quick actions create real records that appear in lists/reports.
Success criteria: Home loads <3s warm, sections accurate vs source lists, quick actions work, and empty states guide.

## 2. Prerequisites & Test Data Setup

- Stack: Web `:3000`, API `:3001`, seeded org with pipeline + deals + tasks + activities.
- Users: rep1 (owns 5 deals, 3 tasks due today, 1 overdue), rep2 (separate data), manager (team view); tokens.
- Time: set tasks: `overdue-yesterday`, `due-today-2`, `due-tomorrow-1`, `no-due-1`; activities in last 7 days; deals created in last 7 days + older.
- Baseline: record expected counts per section for rep1 (e.g., snapshot $X across Y deals, focus 4 items, fresh 5/5/5).
- Browser: Chrome + Firefox; 1440px + 768px + 375px; clear cache once for cold-load timing.
- Cleanup: prefix QA quick-action creates `[QA-Home]` for deletion.

## 3. Test Environment Matrix

| Dimension  | Variants                                                  |
| ---------- | --------------------------------------------------------- |
| Role/scope | Rep own, Manager team, Admin org, New user empty          |
| Time       | Morning/afternoon/evening greeting, Timezone UTC vs local |
| Data       | Rich (full), Sparse (1 deal), Empty (fresh org)           |
| Viewport   | 1440px, 768px, 375px                                      |
| Load       | Cold (cleared), Warm (cached), Throttled 3G               |
| Action     | New Deal/Contact/Task/Log activity (each)                 |
| Theme      | Light/Dark                                                |

- Record: greeting text, section counts, timestamps, load ms (DevTools).
- Verify date rendering honors profile timezone (see `profile-settings.md`).

## 4. Detailed Step-by-Step Test Cases (at least 18 numbered TC cases)

### TC-01 – Greeting Personalizes (Name + Time-of-Day)

- **Objective:** Verify greeting uses first name + daypart.
- **Preconditions:** rep1 firstName `Aarav`; morning local.
- **Steps:**
  1. Login as rep1 → land `/` or `/home`.
  2. Verify `Good morning, Aarav` (or afternoon/evening per clock).
  3. Change profile firstName; reload; verify greeting updates.
  4. Check subtitle date `Tuesday, Sep 8` matches locale.
- **Expected:** Correct name/daypart/date; no `undefined`.

### TC-02 – Pipeline Snapshot Totals Match Deals

- **Objective:** Verify snapshot reconciles to Deals + Reports.
- **Preconditions:** rep1 owns known deals.
- **Steps:**
  1. Note snapshot: Open value, count, by-stage mini-bars.
  2. Open Deals filtered Mine + Reports → Pipeline same scope; compare.
  3. Create $7000 deal; Refresh Home; verify +$7000/+1.
- **Expected:** Match within rounding; refresh picks up.

### TC-03 – Today's Focus Prioritizes Overdue → Due-Today

- **Objective:** Verify ordering + counts.
- **Preconditions:** 1 overdue, 2 due-today, 1 tomorrow.
- **Steps:**
  1. Verify Focus lists overdue first with red `Overdue` pill, then due-today.
  2. Verify tomorrow NOT in Today (or in Upcoming subsection – document).
  3. Complete overdue; verify it leaves Focus and count decrements.
- **Expected:** Correct priority; completion updates immediately.

### TC-04 – Focus Item Actions (Complete/Snooze/Open)

- **Objective:** Verify inline actions work without leaving Home.
- **Preconditions:** Focus with tasks.
- **Steps:**
  1. Complete a task via checkbox; verify toast + strikethrough/removal.
  2. Snooze (if present) to tomorrow; verify leaves Today, appears tomorrow (adjust date or document).
  3. Click title; verify navigates to task detail with back to Home.
- **Expected:** Actions persist; no full reload needed.

### TC-05 – Fresh Deals List (Last 7d, Links)

- **Objective:** Verify recency + links.
- **Preconditions:** Deals created recent + old.
- **Steps:**
  1. Verify Fresh Deals shows newest first (max e.g., 5) with amount/stage/age.
  2. Click one; verify deal detail.
  3. Create new deal; verify tops list after refresh.
- **Expected:** Sorted desc; old excluded beyond window (document N).

### TC-06 – Recent Activity Feed

- **Objective:** Verify latest calls/emails/notes/comments appear.
- **Preconditions:** Activities + a comment from `comments-mentions.md`.
- **Steps:**
  1. Verify feed shows actor + verb + record link + time (`2h ago`).
  2. Log a call; verify tops feed.
  3. Verify icons per type.
- **Expected:** Chronological; links work.

### TC-07 – New People (Contacts)

- **Objective:** Verify fresh contacts list.
- **Preconditions:** Contacts added recent.
- **Steps:**
  1. Verify avatars/names/company + `Added 3d ago`.
  2. Click → contact detail.
  3. Add contact via quick action; verify appears.
- **Expected:** Correct recency; navigation works.

### TC-08 – Quick Action: New Deal

- **Objective:** Verify fastest path to value.
- **Preconditions:** Home quick-action bar visible.
- **Steps:**
  1. Click New Deal → modal/drawer (name, amount, pipeline/stage, contact).
  2. Save; verify toast + appears in Fresh Deals + Deals list + snapshot.
  3. Time the flow; expect <60s.
- **Expected:** Creates + surfaces everywhere.

### TC-09 – Quick Action: New Contact / Task / Log Activity

- **Objective:** Verify remaining quick actions parity.
- **Preconditions:** Same bar.
- **Steps:**
  1. New Contact (name+email) → appears in People + Contacts.
  2. New Task (title+due today) → appears in Focus.
  3. Log Activity (call note on deal) → appears in Activity feed.
- **Expected:** All three work; appear in respective sections.

### TC-10 – Search from Home (if present) / Navigation

- **Objective:** Verify Home search or Cmd+K entry.
- **Preconditions:** Home focused.
- **Steps:**
  1. Use Home search (or press Cmd+K) → search `Acme`.
  2. Verify results + Enter navigates.
- **Expected:** Navigates; see also `command-palette.md`.

### TC-11 – Empty States (Fresh User)

- **Objective:** Verify new user guided, not blank.
- **Preconditions:** Fresh user with 0 deals/tasks.
- **Steps:**
  1. Login; verify snapshot shows `No deals yet – Create deal` CTA.
  2. Focus shows `Nothing due – enjoy` + `Create task`.
  3. Fresh lists show illustrations + CTAs.
  4. Click each CTA; verify correct modal.
- **Expected:** Helpful CTAs; no zeros-confusion.

### TC-12 – Scope: Rep vs Manager vs Admin

- **Objective:** Verify scoping per role.
- **Preconditions:** rep1/rep2 distinct; manager team.
- **Steps:**
  1. As rep1 note snapshot $X (own only).
  2. As manager verify $X+Y (team) with scope label `Team` + switcher to `Mine` if present.
  3. As rep2 verify excludes rep1 private.
- **Expected:** Labels make scope explicit; no leakage.

### TC-13 – Refresh & Staleness

- **Objective:** Verify manual refresh + timestamp.
- **Preconditions:** Home open; second tab creates deal.
- **Steps:**
  1. Note `Updated xm ago`.
  2. Create deal in tab B.
  3. Home Refresh → verify new totals + timestamp `just now`.
- **Expected:** Fresh on demand; auto-refresh policy documented (poll vs manual).

### TC-14 – Deep Links Preserve Filters

- **Objective:** Verify section View-all links carry filters.
- **Preconditions:** Home with data.
- **Steps:**
  1. Click `View all` on Fresh Deals → Deals list pre-filtered (e.g., `created:7d`, `owner:me`).
  2. Back → Home filters intact.
  3. Repeat for Focus → Tasks `due:today`.
- **Expected:** Filters propagate; back preserves.

### TC-15 – Performance <3s Warm, Skeletons Cold

- **Objective:** Verify perceived speed.
- **Preconditions:** Throttle optional.
- **Steps:**
  1. Cold load (incognito): verify skeletons per section immediately.
  2. Warm reload: measure to interactive <3s.
  3. Verify sections stream independently (snapshot first, feed later OK).
- **Expected:** No blank page; progressive.

### TC-16 – Responsive 768px / 375px

- **Objective:** Verify stacking.
- **Preconditions:** Full Home.
- **Steps:**
  1. 768px: verify 2-col → 1-col, quick actions wrap, snapshot bars legible.
  2. 375px: verify single column, no horizontal scroll, CTAs thumb-reachable.
- **Expected:** No clipping; order logical (Focus before Fresh on mobile ideally).

### TC-17 – Dark Mode + Accessibility

- **Objective:** Verify parity + keyboard.
- **Preconditions:** Dark toggle; keyboard only.
- **Steps:**
  1. Dark: verify greeting, pills (Overdue red legible), charts, skeletons contrast.
  2. Tab through quick actions → sections → View-alls; Enter activates.
  3. Axe: no critical.
- **Expected:** AA contrast; full keyboard.

### TC-18 – Error in One Section Isolates

- **Objective:** Verify resilience (block API for activity feed).
- **Preconditions:** Ability to 500 one section (proxy block or invalid filter).
- **Steps:**
  1. Force activity endpoint 500 (or offline).
  2. Reload Home; verify activity card shows `Couldn't load – Retry`, others render.
  3. Retry after unblock; verify recovers.
- **Expected:** Isolated error; board usable.

### TC-19 – Negative: Unauthorized Quick-Create Blocked

- **Objective:** Verify RBAC on quick actions.
- **Preconditions:** Viewer read-only token.
- **Steps:**
  1. As viewer open Home; verify New buttons hidden/disabled with tooltip.
  2. `POST /api/deals` as viewer → 403.
- **Expected:** Hidden + API 403.

## 5. API Testing Section

| Method & Endpoint                               | Purpose               | Auth   | Notes                                  |
| ----------------------------------------------- | --------------------- | ------ | -------------------------------------- |
| `GET /api/home/summary` or per-widget endpoints | Home aggregate        | Bearer | Greeting meta + counts (adapt to impl) |
| `GET /api/deals?owner=me&created=7d&limit=5`    | Fresh deals source    | Bearer | Compare to Home                        |
| `GET /api/tasks?assignee=me&due=today`          | Focus source          | Bearer | Overdue + today                        |
| `GET /api/activities?limit=5&sort=desc`         | Feed source           | Bearer | Recency                                |
| `GET /api/contacts?sort=createdAt_desc&limit=5` | People source         | Bearer | New people                             |
| `POST /api/deals` / `/contacts` / `/tasks`      | Quick actions backing | Bearer | Verify creation                        |

```bash
# Login rep1
curl -s -X POST http://localhost:3001/api/auth/login -H "Content-Type: application/json" \
  -d '{"email":"rep1@test.com","password":"Rep123!"}'
# -> $REP1_TOKEN

# 1) Home aggregate (adapt path; fallback to per-source)
curl -s http://localhost:3001/api/home/summary -H "Authorization: Bearer $REP1_TOKEN" | python3 -m json.tool

# 2) Fresh deals vs Home
curl -s "http://localhost:3001/api/deals?limit=5&sort=createdAt_desc" \
  -H "Authorization: Bearer $REP1_TOKEN" | python3 -m json.tool

# 3) Today's focus (due today + overdue)
curl -s "http://localhost:3001/api/tasks?assignee=me&due=today" \
  -H "Authorization: Bearer $REP1_TOKEN" | python3 -m json.tool
curl -s "http://localhost:3001/api/tasks?assignee=me&overdue=true" \
  -H "Authorization: Bearer $REP1_TOKEN" | python3 -m json.tool

# 4) Quick-create deal (Home New Deal)
curl -s -X POST http://localhost:3001/api/deals \
  -H "Authorization: Bearer $REP1_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"[QA-Home] Quick deal","amount":7000,"stage":"Qualification"}' | python3 -m json.tool

# 5) Health pre-check
curl -s http://localhost:3001/api/health | python3 -m json.tool
```

- If `/api/home/summary` absent, assert per-source endpoints reconcile to Home counts; document actual aggregation routes found.
- Assert: greeting name equals `GET /api/me.firstName`; focus order overdue-first; fresh sorted desc.

## 6. UI Testing Section

- Layout: greeting header + date, snapshot banner, 2-col grid (Focus + Snapshot left, Fresh right) collapsing to 1-col mobile; quick-action bar sticky/floating.
- Cards: titles, counts, View-all links, timestamps (`Updated xm ago`), per-row avatar/amount/pill/time.
- Interactions: hover states, row click → detail, checkbox completes with undo toast, Refresh spins then updates.
- Skeletons: shimmer per card; empty illustrations with CTA; error cards with Retry.
- Search/Cmd+K affordance visible (🔍 `Search or command… ⌘K`).
- Theme/responsive: dark parity, 768/375 stacking, no overlap, charts legible.

## 7. Regression & Cross-Feature Impact

- Deals/Tasks/Contacts/Activity: CRUD anywhere reflects on Home after refresh (source of truth lists).
- Reports/Dashboards: snapshot aligns directionally (cache windows noted).
- Command palette: quick actions duplicated there – both paths same API.
- Inline editing: edits from Home rows (if present) optimistic + rollback (see `inline-editing.md`).
- Notifications: Focus due items vs bell reminders consistent.
- Onboarding: new-user Home shows checklist widget + empties, not zeros.
- Profile/timezone: greeting name + dates follow profile; change propagates.

## 8. Expected Results Summary Table

| TC    | Title            | Expected          | Severity |
| ----- | ---------------- | ----------------- | -------- |
| TC-01 | Greeting         | Name/daypart/date | Minor    |
| TC-02 | Snapshot match   | Reconciles        | Critical |
| TC-03 | Focus order      | Overdue first     | Major    |
| TC-04 | Focus actions    | Persist inline    | Major    |
| TC-05 | Fresh deals      | Newest + links    | Major    |
| TC-06 | Activity feed    | Chrono + links    | Major    |
| TC-07 | People           | Recency + nav     | Minor    |
| TC-08 | Quick deal       | <60s + surfaces   | Critical |
| TC-09 | Quick others     | Parity            | Major    |
| TC-10 | Search/CmdK      | Navigates         | Minor    |
| TC-11 | Empty CTAs       | Guided            | Major    |
| TC-12 | Scope labels     | No leak           | Critical |
| TC-13 | Refresh          | Fresh + stamp     | Major    |
| TC-14 | View-all filters | Carry over        | Minor    |
| TC-15 | Perf/skeletons   | <3s warm          | Major    |
| TC-16 | Responsive       | Stacks            | Minor    |
| TC-17 | Dark/a11y        | AA + keyboard     | Minor    |
| TC-18 | Isolated error   | Others render     | Major    |
| TC-19 | Viewer blocked   | Hidden + 403      | Major    |

## 9. Troubleshooting & Common Failures

| Symptom                        | Cause                                       | Fix                                                          |
| ------------------------------ | ------------------------------------------- | ------------------------------------------------------------ |
| Snapshot 0 but Deals show data | Scope mismatch (Mine vs Team) / cache stale | Check scope label; Refresh; compare API `owner=me` vs `team` |
| Focus missing overdue          | Due-date timezone parse; completed filter   | Check task `dueAt` UTC vs profile TZ; verify status          |
| Fresh list stale               | Cache; sort by updated not created          | Refresh; verify sort param `createdAt_desc`                  |
| Quick-create 403               | Viewer role                                 | Use rep; check RBAC matrix                                   |
| Greeting `undefined`           | Missing firstName                           | Fallback to email prefix; file polish bug                    |
| Home blank                     | One widget 500 blocks all                   | Isolate per-section try/catch; check console                 |
| Slow >5s                       | N+1 aggregates; no cache                    | Check Network waterfall; add summary endpoint/cache          |
| Dates off by day               | TZ mismatch                                 | Align profile TZ + API UTC; document rendering rule          |

- Debug: per-section Network calls, `GET /api/me` for name/TZ, source-list comparison screenshots.
- Reset: delete `[QA-Home]` records; re-baseline counts.

## 10. Pass/Fail Checklist

- [ ] Greeting + date correct; snapshot reconciles to Deals/Reports.
- [ ] Focus ordered overdue→today with working complete/open; fresh/activity/people correct + linked.
- [ ] All quick actions create + surface in <60s each.
- [ ] Empty states guide with CTAs; scopes labeled with no leakage.
- [ ] Refresh updates + timestamp; View-alls carry filters.
- [ ] <3s warm with skeletons; responsive 768/375; dark + keyboard + axe pass.
- [ ] Isolated section failure + viewer 403 verified.
- [ ] API curls reconcile Home to sources.
- [ ] Evidence: Home screenshots (scopes, empty, dark, mobile), timing captures, API JSON.
- [ ] QA records cleaned; defects filed with counts + IDs.
