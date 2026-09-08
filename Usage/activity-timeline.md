# Activity Timeline – Comprehensive Testing Guide

Base URLs: API `http://localhost:3001`, Web `http://localhost:3000`, Mailpit `http://localhost:8025`.

## 1. Overview

Covers the **merged reverse-chronological activity timeline** for contacts (and accounts if shared component): event types `create`, `update`, `note`, `activity`, `comment`, plus `lifecycleStage change`, `owner change`, `tag change` where emitted. Includes pagination, filter-by-type, UI rendering on contact-detail Timeline tab, and API contract.

Scope:

- UI: contact-detail → Timeline tab/section at `/contacts/:id` (`?tab=timeline`), filter chips/dropdown by type, infinite scroll or pager, relative timestamps, actor avatars, expandable diffs.
- API: likely `GET /contacts/:contactId/timeline` or `GET /contacts/:contactId/activities` or `GET /timeline?contactId=` – verify via Network/OpenAPI. This guide standardizes on `GET /contacts/:contactId/timeline` with `?type=&page=&limit=`; substitute actual after discovery (record deviation).
- Event shape: `{id, contactId, type, title/summary, detail/diff, actorId/actorName, createdAt}`.
- Rules: newest-first, filters narrow server-side (not client-only), pagination stable, all writes (create/update/notes/activities/comments) emit exactly one event, no duplicates, deleted-contact timeline 404 (not 500).
- Success: full event coverage, filter + pagination correct, <1s load for 100 events, permissions respected.

## 2. Prerequisites & Test Data Setup

### 2.1 Environment

- API + Web healthy, test org `qa-timeline-org`, users Admin/Sales/Viewer with tokens.
- Create 2 contacts:

```json
{
  "name": "Timeline Parent A",
  "email": "timeline-a@example.com",
  "lifecycleStage": "lead",
  "tags": ["t0"]
}
```

```json
{ "name": "Timeline Parent B", "email": "timeline-b@example.com", "lifecycleStage": "lead" }
```

- Save `CONTACT_A`, `CONTACT_B`. Ensure timeline starts empty or with single `create` event (record baseline `GET timeline`).
- Have Mailpit open if comment mentions trigger emails.
- DevTools Network filter `timeline|activit` to capture real endpoint + params.

### 2.2 Generate diverse events (run in order, 2s gaps)

1. Create CONTACT_A → expect `create` / `contact.created`.
2. PATCH `{"title":"VP Sales"}` → `update` with diff `title: null → VP Sales`.
3. PATCH `{"lifecycleStage":"mql"}` → `update` or dedicated `lifecycle.change`.
4. POST note `Timeline note 1` → `note` event.
5. POST activity (call/meeting/email – see activities guide) linked to CONTACT_A → `activity` event.
6. POST comment on activity or contact (if supported) → `comment` event.
7. PATCH `{"tags":["t0","vip"]}` → `update` tags diff.
8. PATCH owner → `owner change`.
   Example payloads:

```json
{ "title": "VP Sales", "phone": "+1-415-555-0142" }
```

```json
{ "lifecycleStage": "sql" }
```

```json
{ "body": "Timeline seed note – discovery call done" }
```

```json
{
  "type": "call",
  "subject": "Discovery call",
  "contactId": "<CONTACT_A>",
  "occurredAt": "2026-09-08T10:00:00.000Z"
}
```

### 2.3 Bulk for pagination (30+ events)

Loop 25x: alternate note + small update (e.g. `description: "bulk {{i}}"`). This yields 25+ events for 3-page test with `limit=10`.

### 2.4 Cleanup

- Delete bulk notes/activities if deletable, or delete parent contacts (cascade). Verify timeline 404 after parent delete (or empty if soft-delete). Prefix all seed text `QA-TL-`.

## 3. Test Environment Matrix

| Dimension    | Variants                                                           |
| ------------ | ------------------------------------------------------------------ |
| Browser      | Chrome (primary), Firefox, Mobile 390px                            |
| Role         | Admin (all), Sales owner (own + team?), Viewer (read timeline?)    |
| Event volume | 0 (only create), 8 mixed, 50+ (pagination/perf)                    |
| Filter       | All, create, update, note, activity, comment (each singly + multi) |
| Pagination   | Page 1/2/3, infinite scroll, limit 5/10/20                         |
| Network      | Normal, Fast 3G (skeleton), Offline (retry)                        |
| Client       | UI Timeline tab + curl                                             |
| Persistence  | Refresh, relogin, second user, API re-fetch                        |

Minimum: Chrome Admin, 8-mixed + 30-bulk, each filter singly, pages 1-3.

## 4. Detailed Step-by-Step Test Cases

### TC-01 – Baseline create event present

- Steps: Create fresh contact `qa-tl-create@example.com`, immediately `GET timeline` + open UI Timeline tab.
- Expect: Exactly one `create` event at top (newest) with actor = creator, `createdAt ≈ contact.createdAt` (±5s), title like `Contact created` with link to contact. No duplicate creates.

### TC-02 – Update emits diff event

- Steps: PATCH `{"title":"Director","phone":"+1-415-555-0100"}` on CONTACT_A, check timeline.
- Expect: New `update` event on top, detail shows changed fields only (`title`, `phone` old→new), unchanged fields omitted. UI shows inline diff chips, actor + relative time.

### TC-03 – lifecycleStage change event

- Steps: `lead → mql → sql`, checking timeline after each.
- Expect: Each transition emits event (either `update` with stage diff or dedicated `lifecycle` type – document). Message `Stage changed from Lead to MQL`. No missing steps, no combined squash (unless debounced – note window).

### TC-04 – Note appears in timeline

- Steps: POST note `QA-TL note for timeline`, check timeline top + filter `type=note`.
- Expect: `note` event with excerpt (first 140 chars + `...`), click navigates to note (anchor/scroll), author matches note author, delete note either removes event or marks `Note deleted` (document).

### TC-05 – Activity appears (call/meeting/email)

- Steps: Create activity linked to CONTACT_A (call + meeting), check timeline.
- Expect: Two `activity` events with icons per type (📞/📅/✉️), subject + date, link to activity detail. Unlinked activity (other contact) never appears.

### TC-06 – Comment appears

- Steps: Add comment on CONTACT_A (or on its activity/note if comments live there – verify surface), check timeline.
- Expect: `comment` event with excerpt + parent link (`on Discovery call`). If comments only on activities, verify activity-comment still surfaces in contact timeline (or document as out-of-scope with evidence).

### TC-07 – Merged order reverse-chron across types

- Steps: With 2s gaps do update → note → activity → comment, record `createdAt` each, fetch `limit=50`.
- Expect: Timeline order exactly descending `createdAt` (tie-break `id` desc), interleaved types (not grouped by type). UI order matches API order id-for-id. No future timestamps.

### TC-08 – Filter: single type (each)

- UI: Click chip `Notes` (or dropdown `Type=note`), then `Updates`, `Activities`, `Comments`, `All`.
- API: `GET /contacts/:id/timeline?type=note`, `?type=update`, `?type=activity`, `?type=comment`, no param.
- Expect: Each filter returns only that type, counts in chips match API totals (`Notes (3)` = `total` for `type=note`), `All` = sum. URL reflects filter (`?tab=timeline&type=note`), refresh preserves.

### TC-09 – Filter: multi-type + invalid type

- API: `?type=note,activity` or `?type[]=note&type[]=activity` (try both, document supported syntax), `?type=foobar`.
- UI: Check 2 chips simultaneously if supported.
- Expect: Multi returns union newest-first; invalid returns 400 `invalid type` or empty with message (never 500). Document syntax.

### TC-10 – Pagination page 1/2/3 no overlap

- Seed 30+ events, `GET ?limit=10&page=1`, `page=2`, `page=3`.
- Expect: Each 10 (last may be partial), `total` same all pages, ids disjoint across pages, concatenation equals `limit=50` first 30 in same order. UI `Load more` appends without duplicates, footer `Showing 1-10 of 32`.

### TC-11 – Pagination limit variants + bounds

- `?limit=5`, `?limit=20`, `?page=999`, `?limit=1000`, `?limit=0`, `?limit=-1`, `?page=abc`.
- Expect: Limits respected (capped at max e.g. 50 with note), out-of-range page returns `data:[]` + same total (not 500), invalid returns 400. UI handles empty page with `No more activity`.

### TC-12 – Polling / live update without refresh (if supported)

- Steps: Open Timeline tab, in second tab/curl create new note, watch first tab 10s.
- Expect: Either auto-prepends (websocket/poll) with `New activity` pill, or requires manual Refresh (document). No duplicate on manual refresh after auto-prepend.

### TC-13 – Actor attribution correct

- Create note as Admin, update as Sales, comment as Sales.
- Expect: Each event shows correct avatar/name per actor, system events (workflow) show `System`/`Automation` actor, not blank. API `actorId` matches token user.

### TC-14 – Timestamps relative + absolute + timezone

- Check `just now`, `5m ago`, `Yesterday`, hover tooltip absolute `Sep 8, 2026 10:42 AM IST/local`.
- Expect: Relative updates without refresh within minute, absolute respects local TZ (not hardcoded UTC display), future times never shown, API ISO UTC `2026-09-08T05:12:00.000Z`.

### TC-15 – Long bodies truncated with expand

- Note/activity with 2000-char body → timeline excerpt.
- Expect: Excerpt ~140-200 chars + `Show more` expands inline (not navigation), `Show less` collapses, expanded state does not break order, XSS in excerpt still sanitized.

### TC-16 – Empty timeline state

- Fresh contact with only `create` filtered to `type=comment` (zero matches).
- Expect: Illustration + `No comments yet` + `Clear filter` button (not blank, not spinner forever). `All` still shows create.

### TC-17 – Permissions: viewer can read? sales scoped?

- Viewer: open Timeline tab, direct `GET timeline` with VIEWER_TOKEN.
- Sales non-owner: same with SALES_TOKEN on CONTACT_A owned by Admin.
- Expect: Document policy – typically viewer read allowed (200), sales team read allowed. If private, 403 + UI `No access` (not crash). Writes already covered in notes/activities guides – timeline itself is read-only (POST to timeline directly should 404/405, test it).

### TC-18 – Unauthenticated + bad parent

- No token `GET timeline` → 401. `GET /contacts/!!!/timeline` → 400. `GET /contacts/<random-uuid>/timeline` → 404.
- UI logged-out `/contacts/:id` → login redirect; UI `/contacts/<bad>/timeline` → not-found page.
- Expect: No 500, no data leak, messages structured.

### TC-19 – Deleted parent timeline behavior

- Create temp contact + 3 events, DELETE contact, then `GET timeline`.
- Expect: 404 `contact not found` (or 410) consistently, UI navigates to `/contacts` with `Contact deleted` toast if open when deleted elsewhere. No 500 on join to deleted notes/activities.

### TC-20 – No duplicates / idempotency on retry

- Create note, immediately double-click Save (UI) or retry POST on timeout; update same field twice same value.
- Expect: Single timeline event per logical action (dedupe by idempotency key or debounce – document). Same-value update either emits no event (smart diff – preferred, document) or one event (acceptable) – but never two identical events.

### TC-21 – Search within timeline (if supported)

- If `?search=` exists: `?search=pricing`, `?search=QA-TL`, gibberish.
- UI search box within Timeline tab if present.
- Expect: Filters to matching excerpt/title, highlights match, empty shows `No matches` + Clear. If unsupported, mark N/A with screenshot (do not fail).

### TC-22 – Performance with 100+ events

- Seed 100 notes/updates rapidly, measure `GET ?limit=20` wall time + UI initial paint (Network + Lighthouse-ish manual).
- Expect: API <1000ms (target <500ms), UI first 20 render <2s, scroll smooth, Load more <1s each. Note N+1 risk (100 actor lookups) – flag if slow.

### TC-23 – Cross-contact isolation

- Events on CONTACT_A must never appear on CONTACT_B timeline and vice versa.
- Steps: Create distinctive `QA-TL-ISOLATION-A` note on A, fetch B timeline `limit=50` + UI B tab.
- Expect: Zero leak, totals independent. Critical – any leak = P0.

### TC-24 – Regression: contact-detail tabs + global search

- Verify Timeline tab count badge equals `All` total, switching Notes↔Timeline preserves contact id, global palette finds contact (not individual events – document).
- Delete a note → timeline updates (removes/marks) without full page reload corrupting order.
- Expect: No stale counts, no tab cross-talk.

### TC-25 – Responsive + a11y smoke

- Keyboard: Tab through filters, Enter toggles, Tab to `Show more`, Esc collapses. Screen-reader: events as list with time semantics.
- 390px: filters wrap/scroll horizontally, cards stack, timestamps truncate gracefully.
- Expect: All operable, focus visible, zero console errors, no horizontal page scroll.

## 5. API Testing Section

### 5.1 Endpoint table (confirm actual – record deviation)

| Method | Endpoint                                                                       | Auth   | Purpose                      | Success                 |
| ------ | ------------------------------------------------------------------------------ | ------ | ---------------------------- | ----------------------- |
| GET    | `http://localhost:3001/contacts/:contactId/timeline`                           | Bearer | Merged feed newest-first     | 200 `{data,total,page}` |
| GET    | `http://localhost:3001/contacts/:contactId/timeline?type=note&page=1&limit=10` | Bearer | Filter + paginate            | 200 filtered            |
| GET    | `http://localhost:3001/contacts/:contactId/timeline?type=update`               | Bearer | Updates only                 | 200                     |
| GET    | `http://localhost:3001/contacts/:contactId/timeline?type=activity`             | Bearer | Activities only              | 200                     |
| GET    | `http://localhost:3001/contacts/:contactId/timeline?type=comment`              | Bearer | Comments only                | 200                     |
| GET    | `http://localhost:3001/contacts/:contactId/activities`                         | Bearer | Raw activities (if separate) | 200                     |
| GET    | `http://localhost:3001/contacts/:contactId/notes`                              | Bearer | Raw notes (cross-check)      | 200                     |
| POST   | `http://localhost:3001/contacts/:contactId/timeline`                           | Bearer | Direct write (should fail)   | 404/405                 |

> Discovery: open contact-detail Timeline tab, inspect Network for `timeline|activit|feed`. If actual is `GET /timeline?contactId=<id>&type=`, substitute in all curls and note here. Do not invent – capture real URL.

### 5.2 curl examples

```bash
API=http://localhost:3001
TOKEN=<ADMIN_JWT>
HDR="Authorization: Bearer $TOKEN"
CONTACT_A=<CONTACT_A_ID>
CONTACT_B=<CONTACT_B_ID>
# If endpoint differs, set TL="/timeline?contactId=$CONTACT_A" style and adapt.
```

**1. All newest-first (200):**

```bash
curl -s "$API/contacts/$CONTACT_A/timeline?limit=10&page=1" -H "$HDR" | jq '{total, types: [.data[].type], first: .data[0]}'
# Expected 200, data sorted desc createdAt. Verify: jq -r '.data[].createdAt' | sort -c -r && echo SORT_OK
```

**2. Filter note only (200):**

```bash
curl -s "$API/contacts/$CONTACT_A/timeline?type=note&limit=10" -H "$HDR" | jq '{total, types: ([.data[].type]|unique)}'
# Expected types==["note"] only. Repeat for type=update, activity, comment.
```

**3. Pagination no-overlap proof (200):**

```bash
curl -s "$API/contacts/$CONTACT_A/timeline?limit=10&page=1" -H "$HDR" | jq -r '.data[].id' | sort > /tmp/tl1.txt
curl -s "$API/contacts/$CONTACT_A/timeline?limit=10&page=2" -H "$HDR" | jq -r '.data[].id' | sort > /tmp/tl2.txt
comm -12 /tmp/tl1.txt /tmp/tl2.txt | wc -l
# Expected 0 (no overlap). Also compare total both calls equal.
```

**4. Invalid type + bad parent (400/404, never 500):**

```bash
curl -s -w "\nHTTP:%{http_code}\n" "$API/contacts/$CONTACT_A/timeline?type=foobar" -H "$HDR"
curl -s -w "\nHTTP:%{http_code}\n" "$API/contacts/00000000-0000-0000-0000-000000000000/timeline" -H "$HDR"
curl -s -w "\nHTTP:%{http_code}\n" "$API/contacts/!!!/timeline" -H "$HDR"
# Expected 400 or empty-200 for bad type (document), 404 for missing, 400 for malformed.
```

**5. Emit-then-appear (causality):**

```bash
curl -s -X PATCH "$API/contacts/$CONTACT_A" -H "$HDR" -H "Content-Type: application/json" -d '{"title":"QA-TL-Causality-Check"}' | jq '{title}'
sleep 2
curl -s "$API/contacts/$CONTACT_A/timeline?limit=3" -H "$HDR" | jq '.data[0]'
# Expected newest event type=update mentioning title QA-TL-Causality-Check, createdAt within seconds.
```

**6. Isolation (0 leak):**

```bash
curl -s -X POST "$API/contacts/$CONTACT_A/notes" -H "$HDR" -H "Content-Type: application/json" -d '{"body":"QA-TL-ISOLATION-A"}' | jq '{id}'
sleep 2
curl -s "$API/contacts/$CONTACT_B/timeline?limit=50" -H "$HDR" | jq --arg q "QA-TL-ISOLATION-A" '[.data[] | select((.title//""|contains($q)) or (.body//""|contains($q)) or (.summary//""|contains($q)))] | length'
# Expected 0. Any >=1 = P0 leak.
```

**7. Auth (401/403):**

```bash
curl -s -w "\nHTTP:%{http_code}\n" "$API/contacts/$CONTACT_A/timeline?limit=5"
VIEWER=<VIEWER_JWT>
curl -s -w "\nHTTP:%{http_code}\n" "$API/contacts/$CONTACT_A/timeline?limit=5" -H "Authorization: Bearer $VIEWER"
# Expected 401 anon; viewer 200 (or documented 403 if private).
```

## 6. UI Testing Section

### 6.1 Routes & layout

- `/contacts/:id` → Timeline tab (`?tab=timeline`) – filter bar (All / Updates / Notes / Activities / Comments chips or Type dropdown), feed newest-first, each item: icon by type, title/summary, excerpt/diff, actor avatar+name, relative time + absolute tooltip, link to source (note/activity).
- `?tab=timeline&type=note` deep link preserves filter on refresh/share.
- Back to `/contacts` preserves list filters; switching contacts resets timeline to page 1 + `All`.

### 6.2 Interactions

- Filter click updates list + URL without full reload, counts in chips, `Clear` resets to All.
- `Load more` / infinite scroll appends, no jump, no duplicates, preserves scroll on prepend (live).
- `Show more` expands long excerpt inline; source link navigates (note anchor) and Back returns to same scroll/filter.
- Empty (`No activity yet` / `No comments yet`), loading skeleton (5 placeholder rows on Fast 3G), error (`Could not load timeline. Retry`) with Retry refires same params.

### 6.3 Visual / responsive

- Desktop: centered feed with left rail icons + connecting line, diff chips green/red, icons distinct per type.
- 390px: single column, filters horizontal scroll, cards full width, no page-level horizontal scroll.
- Dark/light: diff contrastive, links visible. Zero console errors (check React key warnings, moment deprecation).

## 7. Regression & Cross-Feature Impact

- **Contacts CRUD:** Every create/update/stage/tag/owner change must emit exactly one event – verify no missing (silent service) or double (controller+hook both emit).
- **Notes:** Create/edit/delete reflection policy (TC-04) – ensure delete does not leave dangling `noteId` link that 500s on click.
- **Activities/Comments:** Activity lifecycle (complete/cancel) may emit second event – document; comment edit should not spam new events.
- **Accounts:** If account timeline shares component, verify same filters/pagination work with `accountId` (spot-check 3 cases).
- **Notifications/Email:** Comment mention triggers bell + Mailpit `http://localhost:8025` – edit should not retrigger (or document if it does).
- **Audit logs:** Timeline is user-facing mirror, audit is canonical – spot-check 2 events exist in both with same actor/time.
- **Reports:** Timeline volume does not affect contacts list search `<500ms` (join not leaking into list query).

## 8. Expected Results Summary Table

| TC    | Title             | Expected                    | Must |
| ----- | ----------------- | --------------------------- | ---- |
| TC-01 | Create event      | Single create on top        | Yes  |
| TC-02 | Update diff       | Changed-fields only         | Yes  |
| TC-03 | Stage change      | Event per transition        | Yes  |
| TC-04 | Note surfaces     | Excerpt + link              | Yes  |
| TC-05 | Activity surfaces | Icons + link, no leak       | Yes  |
| TC-06 | Comment surfaces  | Excerpt + parent            | Yes  |
| TC-07 | Merged order      | Desc createdAt, UI==API     | Yes  |
| TC-08 | Single filter     | Only type, counts match     | Yes  |
| TC-09 | Multi/invalid     | Union / 400-or-empty        | No   |
| TC-10 | Pagination        | Disjoint, total stable      | Yes  |
| TC-11 | Limits/bounds     | Capped, [] not 500          | Yes  |
| TC-12 | Live update       | Auto or documented manual   | No   |
| TC-13 | Actor             | Correct per action          | Yes  |
| TC-14 | Timestamps        | Relative+absolute, local TZ | No   |
| TC-15 | Truncate/expand   | Inline, sanitized           | No   |
| TC-16 | Empty state       | Illustration + Clear        | Yes  |
| TC-17 | Permissions       | Read per policy, write 405  | Yes  |
| TC-18 | Auth/bad id       | 401/400/404                 | Yes  |
| TC-19 | Deleted parent    | 404, no 500                 | Yes  |
| TC-20 | No dupes          | Single per action           | Yes  |
| TC-21 | Search            | Or N/A documented           | No   |
| TC-22 | Perf 100+         | <1s API, <2s UI             | No   |
| TC-23 | Isolation         | 0 leak (P0)                 | Yes  |
| TC-24 | Tabs/regression   | Counts live                 | No   |
| TC-25 | Responsive/a11y   | Keyboard+mobile             | No   |

## 9. Troubleshooting & Common Failures

- **Wrong endpoint assumed:** `GET /contacts/:id/timeline` 404 for all – actual may be `/activities?contactId=` or `/feed`. Open Network on Timeline tab, copy real URL, update all curls + table. Do not mark suite fail – record deviation at top of §5.
- **Client-side only filtering:** `type=note` still returns all types (backend ignores param) and UI filters locally – breaks pagination totals (page2 mixed). Fix: server `where: {type}` + test TC-08 totals vs chips.
- **Ascending order:** Oldest first (looks like log not feed) – check `order: {createdAt: "DESC"}` + secondary `id DESC` for ties. Verify with `sort -c -r` proof.
- **Missing events:** Update/note creates no timeline row – often service writes contact but forgets event emission (or transaction rollback swallows). Check hooks/subscribers, retry TC-02/04 with logs.
- **Duplicate events:** Two rows per action – controller emits + TypeORM subscriber emits. Dedupe to one path, add unique guard, verify TC-20.
- **N+1 slowness:** 100-event feed does 100 actor queries → >2s. Eager-load actors, paginate `limit<=20`, add index `(contactId, createdAt DESC)`. Attach timing before/after.
- **Leak across contacts:** `where: {}` missing contactId – B shows A events. Add `where: {contactId}` + FK check + TC-23. P0 security.
- **Stale counts:** Tab `Timeline (12)` vs API total 15 – cached count or filter mismatch (All vs default type). Invalidate on every emit.
- **Timezone future:** Events show `in 3 hours` – server local vs UTC mix. Store UTC ISO, render `utc().local()`, test TC-14 hover.
- **Dangling links:** Clicking deleted note's timeline entry 500s – either cascade-delete event or render `Note deleted` tombstone (no link). Verify TC-19 + note-delete path.

## 10. Pass/Fail Checklist

- [ ] TC-01–TC-07 event coverage (create/update/stage/note/activity/comment) + merged desc order (UI==API id order).
- [ ] TC-08 single-type filters each return only that type, chips==API totals, URL persists.
- [ ] TC-10 pagination 3 pages disjoint (attach `comm` 0-overlap proof), totals stable.
- [ ] TC-11 bounds: `page=999` → `[]`, invalid → 400, no 500.
- [ ] TC-13 actors correct per action, System labeled.
- [ ] TC-17–TC-18 viewer/anon/bad-id 200-or-403-documented / 401 / 400/404.
- [ ] TC-19 deleted parent 404, no 500.
- [ ] TC-20 no duplicates on double-save/retry.
- [ ] TC-23 isolation 0 leak (attach query-length proof – P0).
- [ ] Perf spot: 100-event feed <1s API (attach `time curl`).
- [ ] All 7 curl groups executed, real endpoint recorded if different.
- [ ] UI: deep link `?tab=timeline&type=`, Load more, Show more, empty/error/skeleton, 390px, zero console errors.
- [ ] Regression: notes/activities/comments emission parity, Mailpit mention if enabled.
- [ ] Cleanup: `QA-TL-*` removed, temp contacts deleted, timelines 404.
- [ ] Evidence: feed screenshot, filter screenshots, sort-proof log, pagination overlap log, matrix.

> Sign-off: Tester __________ Date __________ Commit __________ PASS / FAIL defects __________.
