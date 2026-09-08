# Activities – Comprehensive Testing Guide

## 1. Overview

Activities provide a unified timeline log for calls, meetings, emails, and tasks linked to leads, deals, and contacts. Features include manual logging, auto-logging from email/task completion, reply threading (email replies attach to same thread), and call duration tracking (start/end, duration seconds, billable flag).
Scope: activity CRUD, type-specific fields, timeline ordering, filtering by type/date/owner, threading, duration computation, permissions, and cross-object visibility.
Business rules:

- Every activity has `type` in `call|meeting|email|task|note`, `subject`, `occurredAt`, `ownerId`, link to at least one `leadId|dealId|contactId`.
- Calls require `durationSec` derived from `startedAt/endedAt` if provided.
- Email replies share `threadId`; first email creates thread, replies append.
- Timeline sorted `occurredAt:desc`; future meetings show in Upcoming section.
  Base URLs:
- API: `http://localhost:3001`
- Web: `http://localhost:3000`

## 2. Prerequisites & Test Data Setup

- Users: admin, rep1, rep2 as in tasks guide; ensure rep1 owns LEAD-001.
- Seed: LEAD-001 with contact alice@example.com; DEAL-101 linked to LEAD-001.
- Auth: login as rep1, export `$TOKEN`; also admin `$ADMIN_TOKEN`.
- Clean: `DELETE /api/test/reset?scope=activities` or delete via UI timeline.
- Time: use fixed `occurredAt` values: `2026-09-01T10:00:00Z` etc. for deterministic ordering.
- Email config: SMTP stubbed; auto-logging enabled via `EMAIL_AUTOLOG=true`.
- Call setup: allow manual `durationSec` or `startedAt/endedAt`; test both.
- Create baseline:
  - Call 5 min with LEAD-001.
  - Meeting tomorrow with DEAL-101.
  - Email thread with 2 replies.
  - Task-completion auto activity.
- Verify timeline endpoint: `GET /api/activities?leadId=LEAD-001` returns baseline.

## 3. Test Environment Matrix

| Env                                                                                                        | API                               | Web                         | Notes                                |
| ---------------------------------------------------------------------------------------------------------- | --------------------------------- | --------------------------- | ------------------------------------ |
| Local Dev                                                                                                  | http://localhost:3001             | http://localhost:3000       | Full manual + curl                   |
| CI                                                                                                         | http://localhost:3001             | http://localhost:3000       | Seed isolated DB                     |
| Staging                                                                                                    | https://staging-api.example.com   | https://staging.example.com | Email autolog with real SMTP sandbox |
| Browsers                                                                                                   | Chrome/Firefox/Edge               | Desktop + mobile            | Timeline scroll, threading indent    |
| Timezones                                                                                                  | UTC, EST, IST                     | -                           | occurredAt rendering                 |
| Roles                                                                                                      | admin, owner rep1, non-owner rep2 | -                           | Visibility checks                    |
| Note: call duration rounding tested with 61s, 3599s, 3600s edge values. Thread depth tested to 10 replies. |

## 4. Detailed Step-by-Step Test Cases

### TC01 – Log a call with durationSec

Steps:

1. POST `/api/activities` type call, subject, leadId, durationSec 300.
2. Assert 201, durationSec 300, `durationDisplay=5m`.
3. GET timeline, verify appears.
   Expected: Call logged.

### TC02 – Log call with startedAt/endedAt auto-compute

Steps:

1. POST call with startedAt 10:00, endedAt 10:07:30.
2. Verify server computes 450s (7m30s).
3. Check UI shows `7m 30s`.
   Expected: Auto duration.

### TC03 – Call duration validation – end before start

Steps:

1. POST call endedAt < startedAt.
2. Assert 400 `endedAt must be after startedAt`.
   Expected: Blocked.

### TC04 – Log meeting future + past

Steps:

1. Create meeting yesterday + meeting tomorrow same lead.
2. Verify timeline: past in History, future in Upcoming.
3. Check calendar-link badge on future.
   Expected: Split correctly.

### TC05 – Log email manual + auto-logging

Steps:

1. Manually POST email activity with to alice@example.com.
2. Send real email via `POST /api/emails/send` to alice; verify auto activity created with `source=auto`.
3. Ensure no duplicate if manual + auto same messageId.
   Expected: Auto-log works, dedup by messageId.

### TC06 – Reply threading – same threadId

Steps:

1. Create email activity Thread A (subject Hello).
2. POST reply with `threadId=A`, subject Re: Hello.
3. GET `/api/activities?threadId=A` returns 2 ordered asc.
   Expected: Thread groups.

### TC07 – Reply creates new thread if threadId missing

Steps:

1. POST email with same subject but no threadId.
2. Verify new threadId generated, not merged.
   Expected: Explicit threading only.

### TC08 – Thread depth 10 replies ordering

Steps:

1. Add 10 replies to thread.
2. GET thread, verify order 1..11, UI indents or collapses after 5 with Expand.
   Expected: Handles depth.

### TC09 – Task completion auto-creates activity

Steps:

1. Complete a task linked to LEAD-001.
2. Verify activity type task auto-created with `taskId` ref.
3. Reopen task – verify no second activity or marks superseded.
   Expected: One-to-one linkage.

### TC10 – Unified log filter by type

Steps:

1. Seed one of each type.
2. GET `?type=call`, `?type=meeting`, `?type=email`, `?type=task`.
3. Verify each returns only that type.
   Expected: Filter works.

### TC11 – Filter by date range

Steps:

1. GET `?from=2026-09-01&to=2026-09-05`.
2. Verify only in-range returned.
3. Test invalid range from>to -> 400.
   Expected: Date filter.

### TC12 – Filter by owner

Steps:

1. Create activities by rep1 and rep2 on same lead.
2. GET `?ownerId=rep1` returns only rep1.
   Expected: Owner filter.

### TC13 – Timeline sorting occurredAt desc

Steps:

1. Create 3 activities out of order (old, new, middle).
2. GET timeline, verify desc order.
3. UI timeline shows newest top.
   Expected: Sort stable.

### TC14 – Link to multiple objects (lead+deal+contact)

Steps:

1. POST activity with leadId+dealId+contactId all set.
2. Verify visible in all three detail timelines.
3. Remove deal link, verify disappears from deal but stays on lead.
   Expected: Multi-link.

### TC15 – Edit activity (subject/notes)

Steps:

1. PATCH subject + notes.
2. Verify `updatedAt` changes, `edited=true` flag.
3. Check audit shows editor.
   Expected: Edit tracked.

### TC16 – Delete activity with permission

Steps:

1. As owner delete -> 200.
2. As non-owner rep2 delete rep1 activity -> 403.
3. As admin delete any -> 200.
   Expected: RBAC enforced.

### TC17 – Call duration display edge cases

Steps:

1. Create calls: 0s, 45s, 61s, 3600s, 7325s.
2. Verify displays `0s, 45s, 1m 1s, 1h, 2h 2m 5s`.
   Expected: Formatting correct.

### TC18 – Empty timeline state

Steps:

1. Use new lead with no activities.
2. Open detail page, verify empty illustration + `Log activity` CTA.
3. API returns `[]` not 404.
   Expected: Graceful empty.

### TC19 – Search within activities

Steps:

1. Create activity with unique keyword `ZebraSync123`.
2. Search via `?q=ZebraSync123` and via UI search box.
3. Verify found.
   Expected: Search indexes subject+notes.

### TC20 – Pagination large timeline

Steps:

1. Seed 55 activities.
2. GET `?page=1&limit=20`, page 2, page 3.
3. Verify no duplicates, total 55.
   Expected: Pagination correct.

### TC21 – Attachment on activity

Steps:

1. POST activity with attachment URL or multipart.
2. Verify file badge, download works.
3. Delete activity removes or orphans per spec.
   Expected: Attachment handling.

### TC22 – Permission – non-owner cannot see private?

Steps:

1. Create private activity `visibility=private` by rep1.
2. Login rep2, GET lead timeline – private hidden.
3. Login admin – visible.
   Expected: Visibility respected.

## 5. API Testing Section

| Method | Endpoint                         | Purpose                                                | Auth        |
| ------ | -------------------------------- | ------------------------------------------------------ | ----------- |
| POST   | /api/activities                  | Log activity                                           | Bearer      |
| GET    | /api/activities                  | List + filters type/lead/deal/thread/date/owner/q/page | Bearer      |
| GET    | /api/activities/:id              | Get single                                             | Bearer      |
| PATCH  | /api/activities/:id              | Edit                                                   | Owner/Admin |
| DELETE | /api/activities/:id              | Delete                                                 | Owner/Admin |
| GET    | /api/activities/thread/:threadId | Thread view                                            | Bearer      |
| POST   | /api/emails/send                 | Trigger auto-log                                       | Bearer      |
| PATCH  | /api/tasks/:id                   | Trigger task auto-log                                  | Bearer      |

Example 1 – Log call 5 min:

```bash
curl -X POST http://localhost:3001/api/activities \
 -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
 -d '{"type":"call","subject":"Discovery call","leadId":"LEAD-001","durationSec":300,"outcome":"connected","notes":"Interested in pilot"}'
```

Example 2 – Call auto duration from start/end:

```bash
curl -X POST http://localhost:3001/api/activities \
 -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
 -d '{"type":"call","subject":"Follow-up","leadId":"LEAD-001","startedAt":"2026-09-08T10:00:00Z","endedAt":"2026-09-08T10:07:30Z"}'
```

Example 3 – Email + reply threading:

```bash
curl -X POST http://localhost:3001/api/activities \
 -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
 -d '{"type":"email","subject":"Hello Acme","leadId":"LEAD-001","to":["alice@example.com"],"body":"Hi Alice"}'
# reply – use threadId from response
curl -X POST http://localhost:3001/api/activities \
 -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
 -d '{"type":"email","subject":"Re: Hello Acme","leadId":"LEAD-001","threadId":"THREAD_ID","to":["alice@example.com"],"body":"Following up"}'
```

Example 4 – Filter timeline:

```bash
curl "http://localhost:3001/api/activities?leadId=LEAD-001&type=call&sort=occurredAt:desc" -H "Authorization: Bearer $TOKEN"
curl "http://localhost:3001/api/activities?threadId=THREAD_ID&sort=occurredAt:asc" -H "Authorization: Bearer $TOKEN"
```

Example 5 – Edit + delete:

```bash
curl -X PATCH http://localhost:3001/api/activities/ACT_ID \
 -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
 -d '{"subject":"Updated subject","notes":"Added notes"}'
curl -X DELETE http://localhost:3001/api/activities/ACT_ID -H "Authorization: Bearer $TOKEN"
```

Example 6 – Meeting with multiple links:

```bash
curl -X POST http://localhost:3001/api/activities \
 -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
 -d '{"type":"meeting","subject":"Demo","leadId":"LEAD-001","dealId":"DEAL-101","contactId":"CONTACT-01","occurredAt":"2026-09-09T14:00:00Z","location":"Zoom"}'
```

## 6. UI Testing Section

- Open `http://localhost:3000/leads/LEAD-001`: timeline tab shows icons per type (phone, calendar, envelope, check).
- Log buttons: `Log Call` opens duration picker (mm:ss) + outcome dropdown; `Log Meeting` date/time; `Log Email` rich text.
- Thread view: replies nested/indented, `Show 5 more replies` expander, avatars.
- Call badge shows duration chip `5m`, hover shows start-end.
- Filters: type pills, date picker, owner dropdown; combined filters show active count.
- Upcoming vs History sections for meetings; overdue meetings red.
- Mobile: timeline vertical line, cards full width.

## 7. Regression & Cross-Feature Impact

- Emails: auto-log must not duplicate manual log; BCC dedup interacts.
- Tasks: completion creates task-type activity; ensure idempotent (see tasks.md).
- Calendar-sync: meetings synced from Google appear as meeting activities; cancelled-not-deleted shows greyed.
- Sequences: sequence send steps auto-log email activities with `sequenceId`.
- SLA: first-response SLA satisfied by first call/email activity timestamp.

## 8. Expected Results Summary Table

| TC   | Action         | Expected               | UI                          |
| ---- | -------------- | ---------------------- | --------------------------- |
| TC01 | Call 300s      | 201 duration 300       | Phone icon + 5m             |
| TC02 | Start/end      | Computed 450s          | 7m 30s                      |
| TC05 | Auto-log email | source=auto, 1 doc     | Envelope auto badge         |
| TC06 | Reply          | Same threadId, count 2 | Nested reply                |
| TC09 | Task done      | Task activity auto     | Check icon                  |
| TC10 | Type filter    | Only requested type    | Pills filter                |
| TC13 | Sorting        | occurredAt desc        | Newest top                  |
| TC16 | Delete perm    | Owner 200, other 403   | Delete hidden for non-owner |
| TC17 | Duration fmt   | Correct strings        | Chips                       |
| TC20 | Pagination     | 20+20+15, no dup       | Infinite scroll             |

## 9. Troubleshooting & Common Failures

- `400 type invalid`: must be lowercase `call|meeting|email|task|note`; `Call` fails.
- Duration 0: forgot `durationSec` and no start/end – UI defaults 0, API should require one.
- Thread not grouping: `threadId` typo or different case; check exact id from first response.
- Auto-log missing: `EMAIL_AUTOLOG` false or SMTP stub down; check server logs for `autolog skipped`.
- Timeline empty but API has data: wrong `leadId` vs `dealId` filter; clear UI filters.
- Timezone shift: `occurredAt` stored UTC, UI local – verify with `?tz=UTC` param.
- 403 on edit: only owner/admin – login as correct user.

## 10. Pass/Fail Checklist

- [ ] Call with durationSec logged (TC01)
- [ ] Start/end auto-computes (TC02) and invalid rejected (TC03)
- [ ] Future/past meetings split (TC04)
- [ ] Manual + auto email logging deduped (TC05)
- [ ] Reply threading groups correctly (TC06-TC08)
- [ ] Task completion auto-logs once (TC09)
- [ ] Type/date/owner filters work (TC10-TC12)
- [ ] Sorting desc (TC13)
- [ ] Multi-link visibility (TC14)
- [ ] Edit tracked (TC15)
- [ ] RBAC on delete (TC16)
- [ ] Duration formatting edges (TC17)
- [ ] Empty state graceful (TC18)
- [ ] Search finds keyword (TC19)
- [ ] Pagination 55 items correct (TC20)
- [ ] Attachment badge (TC21)
- [ ] Private visibility (TC22)
- [ ] All curl examples 2xx
- [ ] UI timeline + thread expander verified
- [ ] Regression with email/task/calendar checked
