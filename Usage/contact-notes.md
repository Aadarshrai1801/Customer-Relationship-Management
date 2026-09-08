# Contact Notes – Comprehensive Testing Guide

Base URLs: API `http://localhost:3001`, Web `http://localhost:3000`, Mailpit `http://localhost:8025`.

## 1. Overview

Covers **per-contact notes CRUD**: `POST /contacts/:contactId/notes`, `GET /contacts/:contactId/notes`, `PATCH /contacts/:contactId/notes/:noteId`, `DELETE /contacts/:contactId/notes/:noteId` (verify exact prefix – may be `/api/...`; check OpenAPI). Also UI on contact-detail Notes tab/section.

Scope:

- Fields: `id`, `contactId`, `body/content` (required, rich-text or markdown), `authorId/createdBy`, `createdAt/updatedAt`, `pinned?`, `attachments?` (if supported – else out of scope).
- Rules: body required, non-empty, max length (e.g. 10k chars – verify); notes scoped to parent contact (cannot fetch via wrong contactId); contact must exist; auth required; author or admin can edit/delete (verify policy); list sorted newest-first with pagination.
- Success: full CRUD via UI + API, scoping enforced, validation 400, permissions 403, persistence + timeline reflection.

## 2. Prerequisites & Test Data Setup

### 2.1 Environment

- API health 200, Web `/contacts` loads, login as Admin + Sales + Viewer.
- Create 2 parent contacts:

```json
{ "name": "Notes Parent A", "email": "notes-parent-a@example.com", "lifecycleStage": "sql" }
```

```json
{ "name": "Notes Parent B", "email": "notes-parent-b@example.com", "lifecycleStage": "lead" }
```

- Save `CONTACT_A_ID`, `CONTACT_B_ID`, tokens `ADMIN_TOKEN`, `SALES_TOKEN`, `VIEWER_TOKEN`.
- If rich-text: note supported formatting (bold, lists, links, mentions). If mentions trigger notifications, have Mailpit open.
- Clear notes: `GET /contacts/:id/notes` should start empty or with known 1 seed.

### 2.2 Seed notes (via API)

```json
{
  "body": "Seed note 1 – called prospect, interested in Q4 pilot. Follow up next week.",
  "pinned": false
}
```

Alternate field name if `content`:

```json
{ "content": "Seed note with *markdown* and https://example.com link" }
```

Create 3 notes on CONTACT_A for pagination tests, 1 on CONTACT_B for scoping tests. Record `NOTE_1_ID`, etc.

### 2.3 Cleanup

- Prefix bodies `QA-NOTE-<ts>`. Delete created notes individually, then verify list empty. Delete parent contacts last. No bulk delete expected – loop deletes.

## 3. Test Environment Matrix

| Dimension    | Variants                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------ |
| Browser      | Chrome (primary), Firefox, Mobile 390px                                                          |
| Role         | Admin (all), Sales owner (own edit/delete), Sales non-owner (read?/forbidden?), Viewer read-only |
| Parent state | Contact exists, contact deleted, invalid contactId, contact with 0/1/25 notes                    |
| Body types   | Plain, markdown/rich, emoji/unicode, very long, XSS payload                                      |
| Network      | Normal, Fast 3G (optimistic UI?), Offline (queued error)                                         |
| Client       | UI Notes tab + curl                                                                              |
| Persistence  | Refresh, relogin, API re-fetch, timeline check                                                   |

Minimum: Chrome Admin + Sales-owner + Viewer, scoping + pagination + XSS.

## 4. Detailed Step-by-Step Test Cases

### TC-01 – UI create happy

1. Admin → `/contacts/:CONTACT_A_ID` (contact-detail) → Notes tab/section → `Add note` textarea.
2. Type `QA TC01 – Met at SaaSConf, wants demo Friday. @sales please prep.` → Save.
   Expect: Note appears at top (newest first) with author avatar + `just now`, toast `Note added`, count `Notes (n+1)` increments.

### TC-02 – API create happy

POST to `/contacts/:CONTACT_A_ID/notes`:

```json
{ "body": "QA TC02 API note – pricing sent, awaiting reply." }
```

Expect: 201 `{id, contactId==A, body, authorId, createdAt}`. Subsequent GET list contains it first.

### TC-03 – Required body validation (empty/whitespace)

UI: Save with empty, with spaces only. API: `{}`, `{"body":""}`, `{"body":"   "}`.
Expect: UI inline `Note cannot be empty`, Save disabled; API 400 `body is required`. No record, count unchanged.

### TC-04 – Max length enforcement

UI paste 15k chars; API send 15k-char string.
Expect: UI counter `9,842 / 10,000` then red + block or truncate with message (document limit); API 400 `body too long (max 10000)` or 413. No 500, no silent truncation without notice.

### TC-05 – List + order newest-first

Create 3 notes with 2s gaps (or control timestamps), GET list + UI check.
Expect: Order descending `createdAt`, UI matches API order, each shows relative time (`2m ago`) + absolute on hover, author name correct.

### TC-06 – Pagination

Seed 25 notes on CONTACT_A (script loop). UI scroll or pager; API `?page=1&limit=10`, `?page=2&limit=10`, `?page=3`.
Expect: Page1 10 newest, page2 next 10, page3 5, `total:25`, UI `Showing 1-10 of 25` + Load more/Next works, no duplicates across pages, refresh preserves page if URL-param else resets to 1 (document).

### TC-07 – Get single note (if endpoint exists) or filter

If `GET /contacts/:id/notes/:noteId` exists: fetch valid + invalid. Else verify list contains by id.
Expect: 200 for valid, 404 for bogus noteId. UI click timestamp → permalink/deep-link if supported (else note N/A).

### TC-08 – UI edit happy (author)

As author (Admin who created TC-01 note): `... → Edit` → change body → Save.
Expect: Inline editor opens with original text, Save shows updated body + `Edited` badge + `updatedAt` newer, toast `Note updated`, refresh persists.

### TC-09 – API edit happy (PATCH)

```json
{ "body": "QA TC09 edited body – updated next step to Tuesday." }
```

`PATCH /contacts/:CONTACT_A_ID/notes/:NOTE_ID`.
Expect: 200 with new body, same id/contactId, `updatedAt > createdAt`. GET confirms.

### TC-10 – Edit validation: empty + too long

PATCH `{"body":""}` and 15k chars; UI clear field + Save.
Expect: 400 both, UI blocks, original body unchanged after refresh (no data loss).

### TC-11 – UI delete happy with confirm

`... → Delete` → confirm modal `Delete this note? This cannot be undone.` → Confirm.
Expect: Note removed with toast `Note deleted` + Undo (if supported, test Undo restores), count decrements, refresh stays deleted, API GET no longer contains id.

### TC-12 – API delete happy + idempotency

`DELETE /contacts/:CONTACT_A_ID/notes/:NOTE_ID` → 200/204, then GET list, then DELETE again.
Expect: First 200/204, list excludes, second DELETE 404 `note not found` (not 500). Direct GET single (if exists) 404.

### TC-13 – Scoping: note not accessible via wrong contact

Take NOTE from CONTACT_A, try `GET /contacts/:CONTACT_B_ID/notes/:NOTE_ID`, `PATCH` and `DELETE` with B prefix.
Expect: All 404 (not 200, not leak body). List B never contains A notes. UI on B detail never shows A notes. Critical: must not return 200 with cross-contact data.

### TC-14 – Parent not found / malformed contactId

`POST /contacts/00000000-0000-0000-0000-000000000000/notes`, `POST /contacts/!!!/notes`, `GET` same.
Expect: 404 for well-formed missing (`contact not found`), 400 for malformed (`invalid contact id`). UI visiting deleted contact's notes shows `Contact not found`, not notes crash.

### TC-15 – Permissions: viewer read-only

Login Viewer: verify textarea + Edit/Delete hidden/disabled; attempt curl POST/PATCH/DELETE with VIEWER_TOKEN.
Expect: UI read-only, API 403 `forbidden` for all writes, GET 200 allowed (or 403 if private – document). No bypass.

### TC-16 – Permissions: non-owner sales edit/delete policy

Create note as Admin on CONTACT_A; login as Sales (non-author, non-owner?) attempt Edit/Delete via UI + API.
Expect: Either (a) 403 + buttons hidden (author-only policy) or (b) allowed if team-shared (document actual). Be explicit – test both UI hiding and API enforcement match (no UI-hide-but-API-allow gap).

### TC-17 – Unauthenticated rejected

Curl without token: POST/GET/PATCH/DELETE.
Expect: 401 `unauthorized` all four. UI logged-out visiting `/contacts/:id` redirects to `/login?next=/contacts/:id`.

### TC-18 – XSS / HTML injection escaped

Create note body `<script>alert('xss')</script> <img src=x onerror=alert(2)> <a href="javascript:alert(3)">click</a>`.
Expect: Rendered as escaped text or sanitized (script stripped, no execution, no alert on view/refresh). Inspect DOM – no `<script>` tag. API stores raw but UI sanitizes (or API sanitizes – document). Check both list + timeline rendering.

### TC-19 – Unicode / markdown / links rendering

Body with emoji `🎉 Q4 pilot – café Münchën`, markdown `**bold** *italic* - list`, URL `https://example.com/pricing`, mention `@sales`.
Expect: Emoji preserved, markdown rendered (or shown raw if plain-text mode – document), URL auto-linked clickable new-tab, mention highlighted (notification check Mailpit/activity if enabled).

### TC-20 – Persistence + timeline reflection

Create note, refresh, logout/login, fetch API, check Timeline tab.
Expect: Note survives all, identical body/author/timestamps, timeline shows `Note added by X` entry linking to note (see activity-timeline guide). Edit reflects in timeline `Note edited`? (document).

### TC-21 – Concurrent edit last-write

Open same note edit in two tabs, save Tab1 `v1`, save Tab2 `v2`.
Expect: Final body `v2` (last-win) with toast, or 409 conflict with `Refresh` prompt if versioning (document). No lost-update silent merge corruption, no duplicate notes.

### TC-22 – Delete parent contact cascades / blocks notes

Create temp contact + 2 notes, delete contact, then `GET /contacts/:deletedId/notes`.
Expect: Either 404 contact (cascade deleted notes, no orphans) or 410 with message. Verify timeline for deleted contact does not 500. Document cascade vs block (if block, delete warns `has 2 notes`).

### TC-23 – Rate / bulk soak (stability)

Rapid POST 10 notes sequentially (unique bodies), then list `limit=50`.
Expect: All 201, total +10, order correct, no 429 unless rate-limited (if 429, verify Retry-After + UI friendly message). No duplicate ids.

### TC-24 – Pin / unpin (if supported, else author filter)

If `pinned` exists: pin one note, verify pinned section on top regardless of date, unpin restores date order. API `PATCH {"pinned":true}`.
If not supported: verify author filter/search within notes (`search=pricing` or `?authorId=`) if exists, else mark N/A with screenshot of no such UI.
Expect: Document supported vs N/A – do not fail N/A, just record.

### TC-25 – Responsive + keyboard a11y

Keyboard: Tab to Add note, type, Ctrl+Enter to save (if shortcut) or Tab to Save. Esc cancels edit. 390px: notes stack, `...` menu reachable, textarea full width.
Expect: Fully keyboard operable, focus visible, no overlap, zero console errors.

## 5. API Testing Section

### 5.1 Endpoint table

| Method | Endpoint                                                                         | Auth                | Purpose                        | Success            |
| ------ | -------------------------------------------------------------------------------- | ------------------- | ------------------------------ | ------------------ |
| POST   | `http://localhost:3001/contacts/:contactId/notes`                                | Bearer              | Create note                    | 201                |
| GET    | `http://localhost:3001/contacts/:contactId/notes`                                | Bearer              | List (paginated, newest-first) | 200 `{data,total}` |
| GET    | `http://localhost:3001/contacts/:contactId/notes?search=pricing&page=1&limit=10` | Bearer              | Search/paginate (if supported) | 200 filtered       |
| GET    | `http://localhost:3001/contacts/:contactId/notes/:noteId`                        | Bearer              | Get one (if exists)            | 200 / 404          |
| PATCH  | `http://localhost:3001/contacts/:contactId/notes/:noteId`                        | Bearer author/admin | Edit                           | 200 / 400/403/404  |
| DELETE | `http://localhost:3001/contacts/:contactId/notes/:noteId`                        | Bearer author/admin | Delete                         | 200/204 / 403/404  |
| POST   | `http://localhost:3001/contacts/:badId/notes`                                    | Bearer              | Parent validation              | 400/404            |

Body field may be `body` or `content` – try `body` first, fallback `content`. Record actual.

### 5.2 curl examples

```bash
API=http://localhost:3001
TOKEN=<ADMIN_JWT>
HDR="Authorization: Bearer $TOKEN"
CONTACT_A=<CONTACT_A_ID>
CONTACT_B=<CONTACT_B_ID>
```

**1. Create (201):**

```bash
curl -s -X POST "$API/contacts/$CONTACT_A/notes" -H "$HDR" -H "Content-Type: application/json" -d '{"body":"QA curl note – demo scheduled Friday 2pm"}' | jq .
# Expected 201 {"id":"...","contactId":"<A>","body":"...","createdAt":"..."}
# If 400 missing body, retry with {"content":"..."} and note field name.
```

**2. List + pagination (200):**

```bash
curl -s "$API/contacts/$CONTACT_A/notes?limit=10&page=1" -H "$HDR" | jq '{total, n:(.data|length), first: .data[0].body}'
curl -s "$API/contacts/$CONTACT_A/notes?limit=5&page=2" -H "$HDR" | jq .
# Expected 200, newest-first, total matches, page2 no overlap with page1 ids.
```

**3. Validation empty (400):**

```bash
curl -s -w "\nHTTP:%{http_code}\n" -X POST "$API/contacts/$CONTACT_A/notes" -H "$HDR" -H "Content-Type: application/json" -d '{"body":""}'
curl -s -w "\nHTTP:%{http_code}\n" -X POST "$API/contacts/$CONTACT_A/notes" -H "$HDR" -H "Content-Type: application/json" -d '{}'
# Expected both 400 {"error":"body is required"}.
```

**4. Edit (200) + verify:**

```bash
NOTE=<NOTE_ID>
curl -s -X PATCH "$API/contacts/$CONTACT_A/notes/$NOTE" -H "$HDR" -H "Content-Type: application/json" -d '{"body":"Edited via curl – moved to Tuesday"}' | jq .
curl -s "$API/contacts/$CONTACT_A/notes?limit=50" -H "$HDR" | jq --arg id "$NOTE" '.data[] | select(.id==$id)'
# Expected 200 edited, second shows new body.
```

**5. Cross-contact scoping (404):**

```bash
curl -s -w "\nHTTP:%{http_code}\n" "$API/contacts/$CONTACT_B/notes/$NOTE" -H "$HDR"
curl -s -w "\nHTTP:%{http_code}\n" -X PATCH "$API/contacts/$CONTACT_B/notes/$NOTE" -H "$HDR" -H "Content-Type: application/json" -d '{"body":"hijack"}'
# Expected both 404, body must NOT leak. Any 200 = critical security bug.
```

**6. Delete + idempotency (204 then 404):**

```bash
DEL=<NOTE_ID_TO_DELETE>
curl -s -w "\nHTTP:%{http_code}\n" -X DELETE "$API/contacts/$CONTACT_A/notes/$DEL" -H "$HDR"
curl -s "$API/contacts/$CONTACT_A/notes?limit=50" -H "$HDR" | jq --arg id "$DEL" '[.data[] | select(.id==$id)] | length'
curl -s -w "\nHTTP:%{http_code}\n" -X DELETE "$API/contacts/$CONTACT_A/notes/$DEL" -H "$HDR"
# Expected 200/204, 0 matches, then 404.
```

**7. Permissions (403 viewer, 401 anon):**

```bash
VIEWER=<VIEWER_JWT>
curl -s -w "\nHTTP:%{http_code}\n" -X POST "$API/contacts/$CONTACT_A/notes" -H "Authorization: Bearer $VIEWER" -H "Content-Type: application/json" -d '{"body":"viewer try"}'
curl -s -w "\nHTTP:%{http_code}\n" -X POST "$API/contacts/$CONTACT_A/notes" -H "Content-Type: application/json" -d '{"body":"anon try"}'
# Expected 403 then 401.
```

## 6. UI Testing Section

### 6.1 Routes & layout

- contact-detail at `/contacts/:id` – Notes tab/section below header, textarea `Write a note...` + Save, list newest-first, each card: author avatar/name, timestamp (relative + absolute tooltip), body (markdown rendered), `Edited` badge, `...` (Edit/Delete/Pin/Copy link).
- Count in tab `Notes (3)` updates live without refresh after add/delete.
- Deep link to contact preserves Notes tab if `?tab=notes` supported – test refresh keeps tab.
- Back to `/contacts` preserves list filters.

### 6.2 Form interactions

- Empty Save disabled, whitespace blocked, Enter vs Ctrl+Enter behavior (document), auto-resize textarea, char counter if max, Cancel discards with confirm if dirty.
- Optimistic insert (appears instantly) vs spinner – verify rollback on API failure (stop API, try save → error banner `Failed to save note. Retry` + draft preserved).
- Edit inline preserves scroll, Esc cancels without loss.

### 6.3 List interactions

- Load more / pagination footer, no duplicate keys (React key warning check console), long bodies truncated with `Show more`, links open new tab, mentions highlighted.
- Empty state `No notes yet – add the first note` with CTA focuses textarea.
- Error state on 500 (kill API briefly) shows `Could not load notes. Retry` button.

### 6.4 Visual / responsive

- Desktop: two-column (main notes + sidebar contact info) or single; cards aligned, timestamps right.
- 390px: full-width textarea, cards stack, `...` tappable 44px, no horizontal scroll.
- Dark/light: code/links contrastive. Zero console errors on happy path.

## 7. Regression & Cross-Feature Impact

- **Activity timeline:** Each create/edit/delete emits timeline event (create shows, edit may show `edited`, delete may show `deleted` or remove). Verify timeline pagination still correct after note ops.
- **Comments/mentions:** If `@user` in note triggers notification + email, check bell + Mailpit `http://localhost:8025`. No duplicate notifications on edit (only on create or explicit re-mention – document).
- **Search:** Global search should find note bodies? – verify if scoped to contacts only (document). Contact search `<500ms` unaffected by 25 notes.
- **Contacts delete:** Parent delete cascades/blocks (TC-22) – ensure no orphan notes query 500 on reports.
- **Audit logs:** Note CRUD appears in audit log with actor + timestamp if feature enabled.
- **Workflows:** `note contains "demo"` trigger? – verify automation fires once, not on every edit.

## 8. Expected Results Summary Table

| TC    | Title            | Expected                  | Must |
| ----- | ---------------- | ------------------------- | ---- |
| TC-01 | UI create        | Top + toast + count       | Yes  |
| TC-02 | API create       | 201                       | Yes  |
| TC-03 | Empty body       | Inline + 400              | Yes  |
| TC-04 | Max length       | Counter/400, no 500       | Yes  |
| TC-05 | Order newest     | API+UI match              | Yes  |
| TC-06 | Pagination       | Pages no overlap, total   | Yes  |
| TC-07 | Get one          | 200/404                   | No   |
| TC-08 | UI edit          | Edited badge persists     | Yes  |
| TC-09 | API edit         | 200 + GET match           | Yes  |
| TC-10 | Edit validation  | 400, no loss              | Yes  |
| TC-11 | UI delete        | Confirm + toast + gone    | Yes  |
| TC-12 | API delete       | 204 then 404              | Yes  |
| TC-13 | Cross-contact    | 404 all, no leak          | Yes  |
| TC-14 | Bad parent       | 400/404                   | Yes  |
| TC-15 | Viewer           | Hidden + 403              | Yes  |
| TC-16 | Non-owner        | 403 or documented allow   | Yes  |
| TC-17 | Anon             | 401 + login redirect      | Yes  |
| TC-18 | XSS              | Sanitized, no exec        | Yes  |
| TC-19 | Unicode/md/links | Preserved/rendered        | No   |
| TC-20 | Persist+timeline | Survives + timeline entry | Yes  |
| TC-21 | Concurrent       | Last-win or 409           | No   |
| TC-22 | Parent delete    | Cascade/block, no 500     | No   |
| TC-23 | Soak 10 rapid    | All 201                   | No   |
| TC-24 | Pin/filter       | Or N/A documented         | No   |
| TC-25 | Responsive/a11y  | Keyboard+mobile           | No   |

## 9. Troubleshooting & Common Failures

- **Field name `body` vs `content`:** 400 `body is required` even when sending `content` (or vice versa). Inspect Network payload from UI save – use that key. Check DTO + OpenAPI; update guide if alias needed.
- **Scope leak (critical):** `GET /contacts/B/notes/<A-note>` returns 200 – backend queries note by id only, ignoring contactId. Fix: `where: {id, contactId}` + test TC-13. Treat as P0 security bug.
- **Notes appear under wrong contact (UI):** Frontend caches notes by generic key `notes` not `notes-<contactId>` (React Query key bug). Switch contact A→B shows A notes briefly. Fix query key + refetch on id change.
- **Edit loses data on 400:** UI clears editor before server confirms – on validation fail original lost. Fix: keep draft until 200, show error inline.
- **Pagination duplicates:** `skip/take` without stable `orderBy createdAt,id` causes duplicates when same timestamp. Add secondary sort by id, test TC-06 with rapid creates.
- **XSS executes:** `dangerouslySetInnerHTML` without DOMPurify. Add sanitizer, verify TC-18 DOM has no script. Check both notes list and timeline (timeline may render unsanitized copy).
- **Count mismatch:** Tab `Notes (5)` vs list 3 – count query ignores pagination vs list limit, or stale cache. Invalidate count on add/delete.
- **401 vs 403 confusion:** Anon returns 403 instead of 401 (or viewer gets 401). Check auth guard order: authentication (401) before authorization (403).
- **Timestamps timezone:** `just now` vs `in 5 hours` – server UTC vs client local mismatch. Ensure ISO UTC + client `dayjs.utc(...).local()`.
- **Delete parent orphans:** Notes remain with dangling contactId, timeline 500 on join. Add FK cascade or block + migration.

## 10. Pass/Fail Checklist

- [ ] TC-01–TC-04 create + validation pass (Admin/Chrome) with 201/400 logs.
- [ ] TC-05–TC-06 order + pagination verified (25-seed, no overlap, totals).
- [ ] TC-08–TC-12 edit/delete via UI + API, second delete 404.
- [ ] TC-13 cross-contact 404 for GET/PATCH/DELETE (attach logs – critical).
- [ ] TC-14 bad parent 400/404 + UI not-found.
- [ ] TC-15–TC-17 viewer 403, anon 401, non-owner policy documented.
- [ ] TC-18 XSS sanitized (DOM screenshot, no alert).
- [ ] TC-20 persistence + timeline entry after refresh/relogin.
- [ ] All 7 curl groups executed, statuses recorded.
- [ ] UI: tab counts live, empty/error states, 390px, zero console errors.
- [ ] Regression: timeline, mentions/Mailpit, audit checked.
- [ ] Cleanup: `QA-NOTE-*` deleted, parents deleted, lists empty.
- [ ] Evidence: screenshots (create, edit badge, delete confirm, scoping 404), HAR/curl logs, matrix.

> Sign-off: Tester __________ Date __________ Commit __________ PASS / FAIL defects __________.
