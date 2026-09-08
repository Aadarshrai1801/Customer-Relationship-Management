# Comments & Mentions – Comprehensive Testing Guide

Base URLs: API `http://localhost:3001`, Web `http://localhost:3000`.

## 1. Overview

This guide covers Internal Comments on Contact, Deal, and Task records with @mentions and notifications.
Scope includes creating/editing/deleting comments, @mention autocomplete, mention notifications (in-app/email per preferences), threading/replies, permissions (internal-only visibility), activity timeline integration, and audit.
Out of scope is customer-facing portal comments; all comments here are internal.
Key roles: Admin/Manager/Rep can comment on visible records; Viewer may be read-only; mentioned user must have record access to view (or gets gated notice).
Critical rules: @mention triggers notification to mentioned user(s); editing shows `Edited` badge with history where supported; deleting is soft or hard per spec with audit; HTML/script must be escaped.
Success criteria: comments CRUD works on all three entities, mentions notify exactly once per mention, and unauthorized users cannot read or post.

## 2. Prerequisites & Test Data Setup

- Stack up: Web `:3000`, API `:3001`, DB seeded, notification worker/mail catcher running.
- Users: admin, manager, rep1, rep2, viewer; know each user's handle (e.g., `@rep1`, `@Rep One` display name).
- Records: at least 2 contacts (`CONTACT-A/B`), 2 deals (`DEAL-01/02` owned by rep1), 2 tasks (one assigned rep2).
- Mention test: rep1 and rep2 both have access to `DEAL-01`; create private deal visible only to rep1 to test gated mention.
- Tokens: JWTs for all roles; save as `$ADMIN_TOKEN`, `$MGR_TOKEN`, `$REP1_TOKEN`, `$REP2_TOKEN`.
- Notification capture: open in-app bell for rep2 + Mailhog/inbox for email; set rep2 preferences to allow both channels initially.
- Browser: Chrome + Firefox; test autocomplete with keyboard and mouse.
- Baseline: record existing comment counts per record; snapshot notification tables.
- Cleanup: prefix test comments with `[QA 2026-09-08]` for easy deletion; document IDs created.

## 3. Test Environment Matrix

| Dimension      | Variants                                                                      |
| -------------- | ----------------------------------------------------------------------------- |
| Entity         | Contact, Deal, Task                                                           |
| Browser        | Chrome 130+, Firefox 132+, Edge 130+                                          |
| Viewport       | 1440px, 768px                                                                 |
| Role           | Admin, Manager, Rep (owner/non-owner), Viewer                                 |
| Mention target | Self, Teammate with access, Teammate without access, Multiple, Invalid handle |
| Channel        | In-app bell, Email (per preferences), Both, Muted                             |
| Client         | UI composer, curl API                                                         |
| Content        | Plain, markdown/bold, emoji, long (2000 chars), XSS payload                   |

- Record entity IDs, user IDs, timestamps, and channel outcomes per run.
- Test both UI and API creation paths; verify timeline ordering consistent.
- Check timezone rendering of `createdAt` (UTC stored, local displayed).

## 4. Detailed Step-by-Step Test Cases (at least 18 numbered TC cases)

### TC-01 – Post Comment on Deal (UI)

- **Objective:** Verify basic comment creation on a deal.
- **Preconditions:** Logged in as rep1; `DEAL-01` open.
- **Steps:**
  1. Navigate to `http://localhost:3000/deals/DEAL-01` → Comments tab/timeline.
  2. Type `[QA] Checking discount approval` and Submit.
  3. Verify comment appears at top/bottom per sort with author + timestamp.
  4. Reload; verify persists.
  5. Verify activity timeline also logs `rep1 commented`.
- **Expected:** Appears <2s, persists, timeline entry present.

### TC-02 – Post Comment on Contact

- **Objective:** Verify comments work on contacts.
- **Preconditions:** `CONTACT-A` visible to rep1.
- **Steps:**
  1. Open contact detail → Comments.
  2. Post `[QA] Called, asked for callback Friday`.
  3. Verify appears with avatar/initials.
  4. Edit (TC-07) and delete (TC-08) smoke.
  5. Verify contact `updatedAt` or timeline reflects comment.
- **Expected:** Same behavior as deals; no entity-specific crash.

### TC-03 – Post Comment on Task

- **Objective:** Verify comments on tasks including assigned/non-assigned.
- **Preconditions:** Task assigned to rep2, visible to rep1.
- **Steps:**
  1. Open task → Comments.
  2. As rep1 (non-assignee) post `[QA] Can you attach quote?`.
  3. Log in as rep2; verify visible.
  4. Reply as rep2.
  5. Verify threading or chronological order.
- **Expected:** Cross-user visibility correct; replies ordered.

### TC-04 – @Mention Autocomplete

- **Objective:** Verify typing @ suggests users.
- **Preconditions:** Deal with team access.
- **Steps:**
  1. In composer type `@re`.
  2. Verify dropdown shows rep1/rep2 with avatar + role.
  3. Keyboard: ArrowDown + Enter selects; Mouse: click selects.
  4. Verify tokenized pill inserted (not plain text).
  5. Press Esc; verify dropdown closes without insert.
- **Expected:** Fast (<500ms), keyboard operable, Esc safe.

### TC-05 – @Mention Single User Notifies

- **Objective:** Verify mentioned user gets notified exactly once.
- **Preconditions:** rep2 notification prefs allow in-app + email; bell cleared.
- **Steps:**
  1. As rep1 post `Hey @rep2 please review [QA]`.
  2. Log in as rep2; verify bell badge +1 with excerpt + deep link.
  3. Click notification; verify lands on correct record + highlights comment.
  4. Check email inbox; verify one email with link.
  5. Verify rep1 (author) gets no self-notification.
- **Expected:** One in-app + one email; deep link correct.

### TC-06 – @Mention Multiple Users

- **Objective:** Verify multi-mention notifies each.
- **Preconditions:** manager + rep2 accessible.
- **Steps:**
  1. Post `Looping @manager + @rep2 [QA multi]`.
  2. Verify both receive notifications.
  3. Verify comment renders both pills.
  4. Verify API `mentions:[ids]` contains both.
- **Expected:** All mentioned notified; no duplicates.

### TC-07 – Edit Own Comment

- **Objective:** Verify author can edit with Edited badge.
- **Preconditions:** rep1 owns comment from TC-01.
- **Steps:**
  1. Click Edit → change text + add mention.
  2. Save; verify `Edited` badge + new timestamp.
  3. Verify new mention notifies (if added).
  4. Reload; verify edit persists.
- **Expected:** Edit persists; badge shown; history if supported.

### TC-08 – Delete Own Comment

- **Objective:** Verify delete flow with confirm.
- **Preconditions:** Own test comment exists.
- **Steps:**
  1. Click Delete → confirm modal.
  2. Cancel once; verify retained.
  3. Delete again → Confirm; verify removed + toast.
  4. Reload; verify gone.
  5. Verify timeline/audit notes deletion if required.
- **Expected:** Two-step confirm; no accidental delete.

### TC-09 – Cannot Edit/Delete Others' Comments

- **Objective:** Verify authorization on edit/delete.
- **Preconditions:** rep2 comment visible to rep1.
- **Steps:**
  1. As rep1 hover rep2 comment; verify no Edit/Delete buttons.
  2. Attempt API `PATCH /api/comments/:id` as rep1 → expect 403.
  3. As admin, verify can moderate (edit/delete) if policy allows.
- **Expected:** 403 via API; buttons hidden in UI.

### TC-10 – Mention User Without Record Access (Gated)

- **Objective:** Verify mentioning unauthorized user does not leak data.
- **Preconditions:** Private deal visible only rep1; rep2 no access.
- **Steps:**
  1. As rep1 post `@rep2 see this [QA gated]` on private deal.
  2. Verify UI warns `rep2 cannot see this record` or blocks.
  3. As rep2 check bell: either no notification or gated notice without excerpt.
  4. Verify rep2 clicking link gets 403/no-access page, not data.
- **Expected:** No data leak; warning or gated notification.

### TC-11 – Mention Notification Preferences (Mute/Per-Type)

- **Objective:** Verify preference center controls mention channels.
- **Preconditions:** rep2 prefs editable at `/settings/notifications`.
- **Steps:**
  1. Set Mentions → In-app only (email off).
  2. Mention rep2; verify bell only, no email.
  3. Set Mentions → Muted.
  4. Mention again; verify neither (or digest only per spec).
  5. Restore Both.
- **Expected:** Routing honors prefs; mute suppresses.

### TC-12 – Threaded Replies

- **Objective:** Verify reply threading if supported.
- **Preconditions:** Parent comment exists.
- **Steps:**
  1. Click Reply → type `[QA reply]` → Send.
  2. Verify nested under parent with indent/count.
  3. Mention in reply; verify notify.
  4. Delete parent; verify replies handle (cascade or orphan with notice).
- **Expected:** Thread intact; counts correct. If flat, verify chronological + quote.

### TC-13 – Long / Rich Content & Emoji

- **Objective:** Verify composer handles edge content.
- **Preconditions:** Composer open.
- **Steps:**
  1. Paste 2000-char text; verify counter/limit + scroll.
  2. Exceed limit (e.g., 5000 chars); verify blocked with message.
  3. Add emoji 😀 + line breaks + `**bold**` if markdown.
  4. Submit; verify rendering preserves breaks/emoji.
- **Expected:** Limits enforced; rendering safe.

### TC-14 – XSS & HTML Injection

- **Objective:** Verify script payloads are escaped.
- **Preconditions:** Any record.
- **Steps:**
  1. Post `<script>alert(1)</script> <img src=x onerror=alert(2)> [QA xss]`.
  2. Verify rendered as text, no alert.
  3. Inspect DOM; verify escaped (`&lt;script&gt;`).
  4. Verify API stores raw but UI escapes (or sanitizes on save – document).
- **Expected:** No execution; stored safely.

### TC-15 – Concurrent Comments & Ordering

- **Objective:** Verify ordering under concurrent posts.
- **Preconditions:** Two sessions (rep1 + rep2) on same record.
- **Steps:**
  1. Both post within seconds.
  2. Verify both appear after refresh in `createdAt` order.
  3. Verify no overwrite/loss.
  4. Check API `GET` returns stable sort.
- **Expected:** No lost updates; deterministic order.

### TC-16 – Comment Pagination / Lazy Load

- **Objective:** Verify many comments paginate.
- **Preconditions:** Record with 50+ comments (script-seed).
- **Steps:**
  1. Open record; verify first page (e.g., 20) + `Load more`.
  2. Click Load more; verify next page appends, no dupes.
  3. Post new comment; verify appears without full reload.
- **Expected:** Pagination correct; new comment visible.

### TC-17 – Deep Links & Email Link Auth

- **Objective:** Verify notification links land correctly incl. logged-out.
- **Preconditions:** Mention notification with link ` /deals/:id#comment-:cid`.
- **Steps:**
  1. Click bell link as rep2; verify scrolls/highlights comment.
  2. Copy email link; open incognito (logged out); verify redirect to login then back to comment.
  3. As unauthorized user, verify 403 page.
- **Expected:** Auth-gated deep links; highlight works.

### TC-18 – Delete Record Cleans Comments

- **Objective:** Verify deleting parent record handles comments.
- **Preconditions:** Test deal with comments.
- **Steps:**
  1. Delete test deal (or archive per spec).
  2. Verify API `GET /api/comments?dealId=X` returns 404/empty per spec.
  3. Verify no orphan notifications crash bell.
- **Expected:** Clean cascade or scoped archive; bell resilient.

### TC-19 – API Negative & Validation

- **Objective:** Verify API validation/auth.
- **Preconditions:** Valid + invalid tokens.
- **Steps:**
  1. POST without token → 401.
  2. POST empty body → 400.
  3. POST with invalid `entityId` → 404.
  4. POST mention of nonexistent user → 400 or ignored with warning.
- **Expected:** Proper 4xx with error codes; no 500.

## 5. API Testing Section

| Method & Endpoint                                                     | Purpose                | Auth                    | Notes                             |
| --------------------------------------------------------------------- | ---------------------- | ----------------------- | --------------------------------- |
| `GET /api/deals/:id/comments` (or `/api/comments?entity=deal&id=:id`) | List comments          | Bearer                  | Check sort + pagination           |
| `POST /api/deals/:id/comments`                                        | Create (with mentions) | Bearer                  | Body `{body, mentions:[userIds]}` |
| `PATCH /api/comments/:id`                                             | Edit own               | Bearer                  | Expect `edited:true`              |
| `DELETE /api/comments/:id`                                            | Delete own/moderate    | Bearer                  | Confirm semantics                 |
| `GET /api/notifications?relatedId=:commentId`                         | Verify mention notif   | Bearer (mentioned user) | Bell backing                      |
| Equivalent for `/contacts/:id/comments`, `/tasks/:id/comments`        | Entity parity          | Bearer                  | Same contract                     |

```bash
# 1) Login as rep1 and rep2
curl -s -X POST http://localhost:3001/api/auth/login -H "Content-Type: application/json" \
  -d '{"email":"rep1@test.com","password":"Rep123!"}'
# save as $REP1_TOKEN ; repeat for rep2 -> $REP2_TOKEN

# 2) List deal comments
curl -s http://localhost:3001/api/deals/DEAL_ID/comments \
  -H "Authorization: Bearer $REP1_TOKEN" | python3 -m json.tool

# 3) Create comment with mention (replace USER_ID_REP2)
curl -s -X POST http://localhost:3001/api/deals/DEAL_ID/comments \
  -H "Authorization: Bearer $REP1_TOKEN" -H "Content-Type: application/json" \
  -d '{"body":"Hey @rep2 please review [QA api]","mentions":["USER_ID_REP2"]}' | python3 -m json.tool

# 4) Edit comment
curl -s -X PATCH http://localhost:3001/api/comments/COMMENT_ID \
  -H "Authorization: Bearer $REP1_TOKEN" -H "Content-Type: application/json" \
  -d '{"body":"Updated text [QA edited]"}' | python3 -m json.tool

# 5) Verify notification as rep2
curl -s "http://localhost:3001/api/notifications?unread=true" \
  -H "Authorization: Bearer $REP2_TOKEN" | python3 -m json.tool

# 6) Unauthorized edit attempt (should 403)
curl -i -X PATCH http://localhost:3001/api/comments/COMMENT_ID \
  -H "Authorization: Bearer $REP2_TOKEN" -H "Content-Type: application/json" \
  -d '{"body":"hijack"}'
```

- If routes differ (`/api/comments?entityType=deal&entityId=X`), adapt and document actual routes found.
- Assert: creation returns `id, body, authorId, mentions[], createdAt`; bell entry references `commentId`; email queued in catcher.
- Negative asserts: 401 no token, 403 editing others, 404 bad entity, 400 empty body.

## 6. UI Testing Section

- Composer: visible on Contact/Deal/Task detail; placeholder `Write a comment… @ to mention`; Submit disabled when empty; `Ctrl+Enter` submits.
- Autocomplete: `@` opens list; filters as you type; shows avatar/name/role; Arrow keys + Enter, click, Esc behaviors.
- Rendering: pills for mentions (clickable to user card if permitted), line breaks preserved, emoji rendered, `Edited` badge, timestamps relative (`2m ago` with title absolute).
- Actions: hover reveals Edit/Delete (own) / Report (others); delete asks confirm; toasts on success/failure.
- Timeline: comments interleaved with system events (stage change, assignment) in chronological order; filter `Comments only` if present.
- Bell: badge increments, dropdown lists mention with excerpt + time + unread dot; Mark read / View all work.
- Responsive: composer full-width on 768px; autocomplete dropdown not clipped by modal overflow.
- A11y: composer labeled, autocomplete `listbox` roles, focus trapped appropriately, screen-reader announces mention insertion.

## 7. Regression & Cross-Feature Impact

- Notifications: prefs, digest, email templates must include mention excerpt + link; mute must suppress.
- Permissions: record sharing changes must immediately affect comment visibility and mention eligibility.
- Search: comments may be indexed – verify new comments searchable (or explicitly not).
- Activity/Audit: comment create/edit/delete should audit actor + timestamp.
- Workflows: `comment added` or `mention` triggers (if supported) must fire; check execution log.
- Mobile/push: mention push (if enabled) mirrors in-app; deep link same.
- Deletion: user deactivation must render `Former user` not crash pills.

## 8. Expected Results Summary Table

| TC    | Title                 | Expected            | Severity |
| ----- | --------------------- | ------------------- | -------- |
| TC-01 | Deal comment          | Creates + persists  | Critical |
| TC-02 | Contact comment       | Parity              | Major    |
| TC-03 | Task comment          | Cross-user visible  | Major    |
| TC-04 | Autocomplete          | Fast + keyboard     | Major    |
| TC-05 | Single mention notify | 1 bell + 1 email    | Critical |
| TC-06 | Multi-mention         | All notified        | Major    |
| TC-07 | Edit own              | Badge + persists    | Major    |
| TC-08 | Delete own            | Confirm + gone      | Major    |
| TC-09 | Others edit blocked   | 403 + hidden btns   | Critical |
| TC-10 | Gated mention         | No leak             | Critical |
| TC-11 | Prefs routing         | Honors mute/channel | Major    |
| TC-12 | Replies               | Thread correct      | Minor    |
| TC-13 | Long/rich             | Limits + render     | Minor    |
| TC-14 | XSS                   | Escaped             | Critical |
| TC-15 | Concurrent order      | Stable sort         | Minor    |
| TC-16 | Pagination            | No dupes            | Minor    |
| TC-17 | Deep links            | Highlight + auth    | Major    |
| TC-18 | Record delete         | Clean cascade       | Major    |
| TC-19 | API negatives         | 4xx correct         | Major    |

## 9. Troubleshooting & Common Failures

| Symptom                      | Cause                                   | Fix                                              |
| ---------------------------- | --------------------------------------- | ------------------------------------------------ |
| Mention no bell              | Prefs muted; worker down; wrong userId  | Check prefs, worker logs, `mentions[]` payload   |
| Mention no email             | Email disabled / catcher down           | Check Mailhog, SMTP env, queue                   |
| Autocomplete empty           | Search endpoint 500 / permission filter | Inspect Network `users?search=re`; check logs    |
| Comment disappears on reload | POST 500 or wrong entityId              | Check Network POST status; verify ID             |
| 403 on own edit              | Token user mismatch                     | Re-login; decode JWT `sub`                       |
| Duplicate notifications      | Double POST (double-click)              | Disable btn while pending; dedupe by idempotency |
| XSS executes                 | Missing escape/sanitize                 | File critical; verify React escaping / DOMPurify |
| Bell link 404                | Comment deleted or ID wrong             | Handle gracefully with `Comment removed`         |

- Logs: API comments/notifications routes; worker outbox; browser console for autocomplete errors.
- Repro: include entity URL, comment ID, mention payload, bell screenshot, Mailhog message ID.

## 10. Pass/Fail Checklist

- [ ] Comments CRUD works on Contact, Deal, Task via UI and API.
- [ ] Autocomplete keyboard + mouse + Esc verified.
- [ ] Single + multi mentions notify exactly once per channel per prefs.
- [ ] Edit shows Edited; delete confirms; others' edit blocked (UI+API 403).
- [ ] Gated mention does not leak private record data.
- [ ] Prefs (in-app/email/mute) honored.
- [ ] XSS escaped; limits enforced; emoji/breaks render.
- [ ] Pagination, ordering, deep links, logged-out redirect verified.
- [ ] API curls return expected schemas; negatives 401/403/404/400.
- [ ] Evidence: screenshots, bell + email captures, API JSON snapshots.
- [ ] Defects filed with entity IDs, user IDs, payloads.
