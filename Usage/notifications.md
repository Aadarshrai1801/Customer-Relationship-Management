# Notifications – Comprehensive Testing Guide

Base URLs: API `http://localhost:3001`, Web `http://localhost:3000`.

## 1. Overview

This guide covers In-app, Email, and Push routing, Preference Center per-type channels, Digests (skip-if-empty), and Devices.
Scope includes notification triggers (mentions, assignments, due dates, workflow sends, inbound events), bell inbox (unread/read/archive), email delivery + templates, push registration (web/device), per-type per-channel prefs, global mute/DND, digest batching with skip-if-empty, device add/remove, and deep links.
Out of scope is SMS unless present; note if push provider is stubbed in dev.
Key roles: Recipient (own inbox/prefs/devices), Admin (templates/global settings), System/Workflow actor (sender).
Critical rules: prefs route exactly (muted type never sends on that channel); digests never send when empty; marking read syncs bell + API; device tokens scoped per user; links auth-gated.
Success criteria: each trigger produces correct channels per prefs, digests batch correctly and skip empty, devices manage cleanly, and bell/email/push stay consistent.

## 2. Prerequisites & Test Data Setup

- Stack: Web `:3000`, API `:3001`, worker/queue + mail catcher (Mailhog) + push stub/log running.
- Users: admin, rep1 (actor), rep2 (recipient), manager; tokens for each.
- Recipient baseline: rep2 prefs reset to defaults (document defaults), bell cleared (`mark all read`), inbox empty, devices listed.
- Triggers ready: deal assignable to rep2, task due tomorrow assigned rep2, mentionable record, workflow that notifies.
- Devices: Chrome web-push subscription (or stub token `web:qa-001`), plus second fake device to test multi-device fan-out; record endpoints.
- Time: schedule digest test near digest cron (or trigger manually via API `POST /api/notifications/digest/run` if provided); note timezone.
- Cleanup: prefix subjects/bodies `[QA]`; clear catcher between cases; remove test devices after.

## 3. Test Environment Matrix

| Dimension | Variants                                                            |
| --------- | ------------------------------------------------------------------- |
| Channel   | In-app bell, Email, Push (web), All, None (muted)                   |
| Type      | Mention, Assignment, Due/overdue, Comment, Workflow, System/billing |
| Prefs     | Default, In-app only, Email only, Muted per-type, Global DND        |
| Device    | 0 devices, 1 web, 2 devices, Revoked/expired token                  |
| Digest    | Immediate, Hourly/daily digest, Empty (skip), Non-empty batch       |
| Client    | UI bell, curl API, Email client/Mailhog, Push log                   |
| Role      | Recipient, Non-recipient, Admin template editor                     |

- Record: notification IDs, `type`, `channel`, `recipient`, timestamps, digest batch IDs.
- Test both UI-triggered (assign via UI) and API-triggered paths.
- Verify dark-mode email + bell parity (basic).

## 4. Detailed Step-by-Step Test Cases (at least 18 numbered TC cases)

### TC-01 – Bell Receives Mention (In-App Path)

- **Objective:** Verify in-app delivery + badge + deep link.
- **Preconditions:** rep2 bell 0 unread; prefs allow in-app mentions.
- **Steps:**
  1. As rep1 mention `@rep2` on `DEAL-01`.
  2. As rep2 verify bell badge +1 within 30s (poll/websocket).
  3. Open bell; verify excerpt, actor avatar, relative time, unread dot.
  4. Click; verify lands on record + highlights comment.
  5. Mark read; verify badge decrements.
- **Expected:** Timely, link correct, read syncs.

### TC-02 – Email Receives Mention (Email Path)

- **Objective:** Verify email template + link + headers.
- **Preconditions:** rep2 prefs email on for mentions; catcher open.
- **Steps:**
  1. Mention rep2 again with `[QA email-1]`.
  2. Verify Mailhog message to rep2 within 60s with subject containing actor/record.
  3. Verify body has excerpt + CTA link with `?notif=` or deep anchor.
  4. Verify `List-Unsubscribe` / prefs link present if required.
- **Expected:** One email; links absolute (`http://localhost:3000/...`).

### TC-03 – Preference Center Per-Type Channels

- **Objective:** Verify matrix of type×channel routing.
- **Preconditions:** rep2 prefs page `/settings/notifications`.
- **Steps:**
  1. Set Mentions: In-app ON, Email OFF; trigger mention → bell only, no email.
  2. Set Assignments: Email ON, In-app OFF; assign deal to rep2 → email only.
  3. Set Comments: Both ON; comment (no mention) on watched record → both if subscribed.
  4. Restore defaults.
- **Expected:** Routing exact per cell; no cross-talk.

### TC-04 – Mute Per-Type Suppresses That Channel/All

- **Objective:** Verify mute semantics.
- **Preconditions:** Document whether mute = no channels or per-channel off.
- **Steps:**
  1. Mute `Task Due` type entirely.
  2. Trigger due notification (due date passes or manual run).
  3. Verify neither bell nor email for that type.
  4. Trigger different type (mention) → still delivered.
- **Expected:** Selective suppression; other types unaffected.

### TC-05 – Global DND / Mute-All

- **Objective:** Verify global switch pauses non-critical.
- **Preconditions:** DND toggle if present.
- **Steps:**
  1. Enable DND/Mute-all for rep2.
  2. Trigger mention + assignment.
  3. Verify none delivered (or queued for later per spec – document).
  4. Disable; verify queued flush or new triggers deliver (document).
- **Expected:** Documented pause/flush behavior. If absent, N/A.

### TC-06 – Assignment Notification (Deal/Task)

- **Objective:** Verify assignee notified on both channels per prefs.
- **Preconditions:** Both channels ON for assignments.
- **Steps:**
  1. As manager assign `DEAL-02` to rep2.
  2. Verify bell + email with deal link + assigner name.
  3. Reassign to rep1; verify rep2 gets no second (or `unassigned` notice per spec).
- **Expected:** Single notify on assign; correct links.

### TC-07 – Due / Overdue Reminders

- **Objective:** Verify time-based triggers.
- **Preconditions:** Task due in 5 min or overdue; scheduler running.
- **Steps:**
  1. Create task assigned rep2 due now+5m.
  2. Wait/manual-run scheduler; verify reminder bell/email.
  3. Mark complete; verify no further nag.
- **Expected:** On-time; no spam after complete. Document cron cadence.

### TC-08 – Digest Batches (Non-Empty)

- **Objective:** Verify digest groups multiple events into one email.
- **Preconditions:** Digest enabled (e.g., hourly activity digest) for rep2.
- **Steps:**
  1. Generate 3 events (2 mentions + 1 assignment) within digest window.
  2. Trigger digest run.
  3. Verify ONE email listing all 3 with links + counts.
  4. Verify bell still has 3 individual entries (digest does not collapse bell unless spec'd).
- **Expected:** Single batched email; items complete.

### TC-09 – Digest Skip-If-Empty

- **Objective:** Verify no email when zero events.
- **Preconditions:** Fresh window with no events for rep2; catcher cleared.
- **Steps:**
  1. Ensure no triggers in window.
  2. Run digest.
  3. Verify ZERO emails to rep2.
  4. Verify log shows `skipped: empty`.
- **Expected:** No empty digest spam.

### TC-10 – Device Registration (Web Push)

- **Objective:** Verify adding a device enables push.
- **Preconditions:** rep2 with 0 devices; push stub.
- **Steps:**
  1. As rep2 enable Push (browser prompt allow / stub).
  2. Verify `GET /api/notifications/devices` shows 1 device with endpoint + createdAt.
  3. Trigger mention; verify push log/entry for that endpoint.
  4. Disable; verify device removed and no further push.
- **Expected:** Register → push; remove → stop.

### TC-11 – Multi-Device Fan-Out & Revoke One

- **Objective:** Verify all devices notified, revoke isolates.
- **Preconditions:** rep2 with 2 devices (web + stub mobile).
- **Steps:**
  1. Trigger mention; verify BOTH endpoints logged.
  2. Revoke device B.
  3. Trigger again; verify only A logged.
- **Expected:** Fan-out then single after revoke.

### TC-12 – Expired / Invalid Token Handling

- **Objective:** Verify bad tokens pruned without breaking others.
- **Preconditions:** Device with fake expired token (push provider returns 410).
- **Steps:**
  1. Trigger; verify provider 410 → device marked `expired/removed` in log.
  2. Verify valid device still got push.
  3. Verify next trigger sends only to valid.
- **Expected:** Auto-prune; no crash.

### TC-13 – Mark Read / Archive Sync (Bell ↔ API)

- **Objective:** Verify state sync.
- **Preconditions:** 3 unread.
- **Steps:**
  1. Mark one read via bell; verify `GET /api/notifications?unread=true` drops by 1.
  2. `POST /api/notifications/:id/read` via curl; verify bell decrements without reload (or after reload max).
  3. Mark all read; verify 0 + empty illustration.
  4. Archive one; verify separate tab/filter.
- **Expected:** Consistent counts; no phantom badge.

### TC-14 – Deep Links Auth-Gated

- **Objective:** Verify links require auth and scope.
- **Preconditions:** Notification link for private record.
- **Steps:**
  1. As recipient click → lands + highlights.
  2. Copy link incognito → login → lands (post-login redirect).
  3. As non-recipient/non-access user open link → 403, not data.
- **Expected:** Gated; post-login return works.

### TC-15 – Unsubscribe / Prefs Link in Email

- **Objective:** Verify compliance footer.
- **Preconditions:** Email from TC-02.
- **Steps:**
  1. Click Unsubscribe/Manage prefs in email.
  2. Verify lands on prefs with correct type highlighted.
  3. Toggle off; trigger again; verify suppressed.
- **Expected:** One-click prefs; honored.

### TC-16 – Bulk / Storm (20 Rapid) No Loss/Dupe

- **Objective:** Verify 20 rapid notifies all arrive once.
- **Preconditions:** Script assigns/comments 20× to rep2.
- **Steps:**
  1. Fire 20 events quickly.
  2. Verify bell +20 (or digest-batched email per prefs – document).
  3. Verify no duplicates (unique IDs).
- **Expected:** Exactly-once per event; badge correct.

### TC-17 – Template Rendering (Variables, Emoji, Long)

- **Objective:** Verify templates resolve, escape, truncate.
- **Preconditions:** Record names with emoji + long text + HTML attempt.
- **Steps:**
  1. Trigger with name `Acme 😀 <b>Bold</b> + 200-char desc`.
  2. Verify bell/email shows emoji, escapes `<b>` (no bold injection), truncates with `…`.
- **Expected:** Safe, legible templates.

### TC-18 – Non-Recipient Gets Nothing

- **Objective:** Verify scoping (no broadcast leak).
- **Preconditions:** rep1 not involved in rep2 assignment.
- **Steps:**
  1. Assign deal to rep2.
  2. Verify rep1 bell/email empty for that event.
  3. Verify API `GET /notifications` as rep1 lacks it.
- **Expected:** Strict recipient scoping.

### TC-19 – Negative: Forge / Cross-User State Change

- **Objective:** Verify users cannot mark/read others' notifications.
- **Preconditions:** rep2 notif ID known.
- **Steps:**
  1. As rep1 `POST /api/notifications/NOTIF_ID/read` → 403/404.
  2. `GET /api/notifications/devices` as rep1 lacks rep2 devices.
  3. POST device token for another userId → 403.
- **Expected:** 403/404; isolation.

## 5. API Testing Section

| Method & Endpoint                             | Purpose      | Auth               | Notes                         |
| --------------------------------------------- | ------------ | ------------------ | ----------------------------- |
| `GET /api/notifications?unread=true&limit=20` | Bell inbox   | Bearer (recipient) | `id,type,read,createdAt,link` |
| `POST /api/notifications/:id/read`            | Mark read    | Bearer (owner)     | Idempotent                    |
| `POST /api/notifications/read-all`            | Mark all     | Bearer             | Clears badge                  |
| `GET /api/notifications/preferences`          | Get prefs    | Bearer             | Per-type channels             |
| `PUT /api/notifications/preferences`          | Set prefs    | Bearer             | `{type:{inApp,email,push}}`   |
| `GET /api/notifications/devices`              | List devices | Bearer             | Endpoints                     |
| `POST /api/notifications/devices`             | Register     | Bearer             | `{endpoint, keys}`            |
| `DELETE /api/notifications/devices/:id`       | Remove       | Bearer             | Stops push                    |

```bash
# Login as recipient
curl -s -X POST http://localhost:3001/api/auth/login -H "Content-Type: application/json" \
  -d '{"email":"rep2@test.com","password":"Rep123!"}'
# -> $REP2_TOKEN

# 1) Inbox unread
curl -s "http://localhost:3001/api/notifications?unread=true&limit=20" \
  -H "Authorization: Bearer $REP2_TOKEN" | python3 -m json.tool

# 2) Prefs get + set (mentions in-app only)
curl -s http://localhost:3001/api/notifications/preferences \
  -H "Authorization: Bearer $REP2_TOKEN" | python3 -m json.tool

curl -s -X PUT http://localhost:3001/api/notifications/preferences \
  -H "Authorization: Bearer $REP2_TOKEN" -H "Content-Type: application/json" \
  -d '{"mention":{"inApp":true,"email":false,"push":true}}' | python3 -m json.tool

# 3) Mark one read
curl -s -X POST http://localhost:3001/api/notifications/NOTIF_ID/read \
  -H "Authorization: Bearer $REP2_TOKEN" | python3 -m json.tool

# 4) Devices list + register stub
curl -s http://localhost:3001/api/notifications/devices \
  -H "Authorization: Bearer $REP2_TOKEN" | python3 -m json.tool

curl -s -X POST http://localhost:3001/api/notifications/devices \
  -H "Authorization: Bearer $REP2_TOKEN" -H "Content-Type: application/json" \
  -d '{"endpoint":"https://push.test/qa-001","keys":{"p256dh":"x","auth":"y"},"platform":"web"}' | python3 -m json.tool

# 5) Trigger digest manually if supported
curl -s -X POST http://localhost:3001/api/notifications/digest/run \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"userId":"REP2_ID"}' | python3 -m json.tool
```

- Assert: prefs write echoes; inbox counts track; device appears; digest with no events sends nothing (check Mailhog 0 new).
- Negative: other user's notif ID → 403/404; anon → 401.

## 6. UI Testing Section

- Bell: header icon with count badge (99+ cap), dropdown with tabs All/Unread, rows (icon by type, excerpt, time, dot), Mark-all-read, View-all page with filters per type.
- Prefs center: `/settings/notifications` grouped by type with In-app/Email/Push toggles + Mute + DND + Digest schedule picker; Save toast + immediate effect.
- Email: responsive template, preheader, CTA button, footer prefs/unsubscribe, plain-text alternative.
- Devices: list with platform/browser/last-seen/Remove; Enable-push CTA handles denied permission gracefully.
- Empty/loading: shimmer on bell open; `You're all caught up` illustration at 0.
- Responsive: bell dropdown fits 375px; prefs stack; dark parity.
- A11y: bell `aria-live` announces new; toggles labeled; focus returns after dropdown close.

## 7. Regression & Cross-Feature Impact

- Mentions/Comments: mention prefs gate exactly; comment-without-mention follows watch rules.
- Workflows: workflow notifies honor prefs + DND; failures surface as system notifs to owner (or not – document).
- Tasks/Deals: assignment/due triggers consistent with list views; completing cancels pending nag.
- Email platform: bounces/suppressions must not crash bell; retry with backoff.
- Push: service-worker update must not orphan subscriptions; version note.
- Billing: plan-gated channels (e.g., no push on free) show upgrade nudge not silent drop.
- Audit: notification sends logged with channel + template version.

## 8. Expected Results Summary Table

| TC    | Title            | Expected                 | Severity |
| ----- | ---------------- | ------------------------ | -------- |
| TC-01 | Bell mention     | +1, link, read sync      | Critical |
| TC-02 | Email mention    | 1 templated email        | Critical |
| TC-03 | Per-type routing | Exact matrix             | Critical |
| TC-04 | Mute type        | Suppressed selectively   | Major    |
| TC-05 | DND              | Pauses per spec          | Minor    |
| TC-06 | Assignment       | Bell+email correct       | Major    |
| TC-07 | Due reminders    | On-time, no spam         | Major    |
| TC-08 | Digest batch     | 1 email many items       | Major    |
| TC-09 | Skip-if-empty    | 0 emails                 | Major    |
| TC-10 | Device register  | Push enabled             | Major    |
| TC-11 | Multi-device     | Fan-out, revoke isolates | Major    |
| TC-12 | Expired prune    | Auto-remove              | Minor    |
| TC-13 | Read sync        | Counts consistent        | Major    |
| TC-14 | Deep-link gate   | Auth + scope             | Major    |
| TC-15 | Unsubscribe      | Prefs honored            | Major    |
| TC-16 | Storm 20         | Exactly-once             | Major    |
| TC-17 | Templates safe   | Escaped + emoji          | Minor    |
| TC-18 | No leak          | Recipient-only           | Critical |
| TC-19 | Forge blocked    | 403/404                  | Critical |

## 9. Troubleshooting & Common Failures

| Symptom                     | Cause                                   | Fix                                                              |
| --------------------------- | --------------------------------------- | ---------------------------------------------------------------- |
| No bell                     | Prefs off; socket down; wrong recipient | Check prefs, `GET /notifications`, socket/refresh, actor mapping |
| No email                    | Prefs off; queue down; catcher full     | Check prefs, worker logs, Mailhog space, SMTP env                |
| Duplicate emails            | Immediate + digest both on              | Set prefs to one path; check template triggers                   |
| Empty digest sent           | skip-if-empty flag off                  | Enable flag; check digest query `count==0 → skip`                |
| Push to revoked still tried | Prune job not running                   | Run prune; check 410 handling                                    |
| Badge stuck                 | Cache/optimistic mismatch               | Hard reload; compare API unread count vs UI                      |
| Link 403 for recipient      | Record permission revoked after send    | Show `No longer has access` gracefully                           |
| Delayed >2min               | Queue backlog                           | Check queue depth, worker concurrency, retry storms              |

- Debug: notification ID → prefs snapshot → worker/send log → Mailhog ID → push provider response.
- Evidence: bell screenshots, `.eml` exports, push log lines, prefs JSON.

## 10. Pass/Fail Checklist

- [ ] Bell + email + push each proven per prefs matrix (TC-01–03).
- [ ] Mute/DND suppress correctly without affecting other types.
- [ ] Assignment + due + digest (batch + skip-empty) verified with catcher.
- [ ] Devices: register, fan-out, revoke, expired-prune all pass.
- [ ] Read/archive sync bell↔API; deep links gated; unsubscribe honored.
- [ ] Storm 20 exactly-once; templates safe; no cross-user leak/forge.
- [ ] API curls pass; negatives 401/403 correct.
- [ ] Evidence: inbox captures, email files, device lists, digest logs.
- [ ] Defects filed with notif IDs, prefs JSON, timestamps.
