# Tasks – Comprehensive Testing Guide

## 1. Overview

This guide covers manual and API testing for the Tasks feature in the CRM.
Tasks support open / completed / cancelled lifecycle, priority levels (low, medium, high, urgent), due dates, reminder times, overdue detection, overdue digest batching (grouped notifications), and recurrence with this-only vs future-series semantics.
Scope includes CRUD, status transitions, filtering, sorting, assignment, linkage to leads/deals/contacts, notifications, digest jobs, and recurrence expansion.
Out of scope: calendar-sync provider sync (see calendar-sync.md), but task due-date appearance on calendar is in scope for regression.
Key business rules:

- Only `open` tasks can be completed or cancelled; completed/cancelled are terminal but allow reopen.
- `overdue` is derived: `status=open AND dueAt < now`.
- Digest batching groups overdue + due-soon tasks per assignee, sent once per window, not per task.
- Recurrence creates a series; editing can apply to this-only occurrence vs future occurrences.
- Priorities affect sort order and digest highlighting but not status logic.
  Base URLs:
- API: `http://localhost:3001`
- Web: `http://localhost:3000`

## 2. Prerequisites & Test Data Setup

- API running on `http://localhost:3001`, Web on `http://localhost:3000`.
- Test users: `admin@test.com / Admin123!`, `rep1@test.com / Rep123!`, `rep2@test.com / Rep123!`.
- Seed leads: `LEAD-001 (Acme)`, `LEAD-002 (Globex)`; deals: `DEAL-101`, `DEAL-102`; contacts: `alice@example.com`, `bob@example.com`.
- Clean tasks collection before run: `DELETE /api/test/reset?scope=tasks` if available, or manually delete via UI.
- Time control: set system or use `X-Test-Now` header if supported; otherwise create due dates relative to now (`-2d`, `-1h`, `+1h`, `+1d`).
- Notification inbox: use Mailhog / Ethereal or check `GET /api/notifications` for digest verification.
- Required fields for task creation: `title`, `status=open` default, `priority`, `dueAt`, `assigneeId`, optional `leadId/dealId/contactId`, `remindAt`, `recurrence`.
- Create baseline tasks:
  - `TASK-OPEN-HIGH` due tomorrow, assignee rep1, linked to LEAD-001.
  - `TASK-OVERDUE-1` due yesterday, assignee rep1.
  - `TASK-OVERDUE-2` due 2 days ago, assignee rep1 (for digest batching).
  - `TASK-OPEN-REP2` due today, assignee rep2.
  - `TASK-RECURRING` weekly recurrence, 5 occurrences.
- Verify auth token: `POST /api/auth/login` returns JWT; store as `$TOKEN`.

## 3. Test Environment Matrix

| Env                                                                                                                                                          | API URL                             | Web URL                               | DB                        | Purpose                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- | ------------------------------------- | ------------------------- | ------------------------------ |
| Local Dev                                                                                                                                                    | http://localhost:3001               | http://localhost:3000                 | Mongo local `crm_dev`     | Primary manual + curl testing  |
| Test / CI                                                                                                                                                    | http://localhost:3001               | http://localhost:3000                 | Mongo memory / `crm_test` | Automated regression           |
| Staging                                                                                                                                                      | https://staging-api.example.com     | https://staging.example.com           | Staging snapshot          | Digest cron + timezone checks  |
| Prod Clone                                                                                                                                                   | N/A (read-only)                     | N/A                                   | Anonymized dump           | Load test digest batching      |
| Browsers                                                                                                                                                     | Chrome 126, Firefox 128, Edge 126   | 1280x720 + 1920x1080 + mobile 390x844 | -                         | UI verification                |
| Timezones                                                                                                                                                    | UTC, America/New_York, Asia/Kolkata | -                                     | -                         | Due/remind/overdue correctness |
| Notes: run overdue/digest tests in UTC first, then repeat in IST/EST to catch off-by-one day bugs. Digest job interval in local is 5 min; in staging 15 min. |

## 4. Detailed Step-by-Step Test Cases

### TC01 – Create open task with mandatory fields

Steps:

1. POST `/api/tasks` with title, priority medium, dueAt tomorrow, assignee rep1.
2. Assert 201 + `id` + `status=open`.
3. GET `/api/tasks/:id` and verify fields.
   Expected: Task persisted, appears in Open list.

### TC02 – Create task validation – missing title

Steps:

1. POST `/api/tasks` without `title`.
2. Assert 400 + error `title is required`.
3. Verify no task created via list count unchanged.
   Expected: Validation blocks creation.

### TC03 – Priority levels accepted

Steps:

1. Create 4 tasks with low/medium/high/urgent.
2. GET `/api/tasks?sort=priority:desc`.
3. Verify order urgent > high > medium > low.
   Expected: Priority sorting works.

### TC04 – Complete open task

Steps:

1. Create open task, note id.
2. PATCH `/api/tasks/:id` with `{"status":"completed"}`.
3. GET and verify `completedAt` set, `status=completed`.
   Expected: Task moves to Completed filter, not in Open.

### TC05 – Cancel open task with reason

Steps:

1. Create open task.
2. PATCH with `{"status":"cancelled","cancelReason":"duplicate"}`.
3. Verify `cancelledAt` + reason stored.
   Expected: Task in Cancelled list with reason visible.

### TC06 – Invalid transition – complete already cancelled

Steps:

1. Take cancelled task from TC05.
2. PATCH `status=completed`.
3. Assert 422 or UI blocks with message.
   Expected: Terminal-state guard; or allow only via reopen first.

### TC07 – Reopen completed task

Steps:

1. PATCH completed task with `{"status":"open"}`.
2. Verify `completedAt` cleared or retained as history + `reopenedAt` set per spec.
3. Check Open list count +1.
   Expected: Reopen works, audit log entry.

### TC08 – Reopen cancelled task

Steps:

1. PATCH cancelled task to `open`.
2. Verify status flips, cancelReason preserved or cleared per spec.
   Expected: Consistent with TC07 behavior.

### TC09 – Due date in past allowed but flagged overdue

Steps:

1. Create task with `dueAt` yesterday.
2. GET `/api/tasks?filter=overdue`.
3. Verify task appears with `isOverdue=true`, `overdueBy` computed.
   Expected: Overdue derived correctly.

### TC10 – RemindAt before dueAt

Steps:

1. Create task due tomorrow 10:00, remindAt today 09:00.
2. Verify `remindAt` saved, reminder job picks it up.
3. Check `GET /api/notifications?user=rep1` after trigger.
   Expected: Reminder fires once.

### TC11 – RemindAt after dueAt rejected

Steps:

1. POST task where `remindAt > dueAt`.
2. Assert 400 `remindAt must be before dueAt`.
   Expected: Validation prevents nonsense reminder.

### TC12 – Overdue digest batching – multiple overdue grouped

Steps:

1. Ensure rep1 has 2+ overdue tasks (from setup).
2. Trigger digest: `POST /api/tasks/digest/run` or wait for cron.
3. Check notifications: expect 1 digest email/notification listing both tasks, not 2 separate.
4. Verify payload contains `taskIds=[id1,id2]`, `count=2`.
   Expected: Batching works, single digest per assignee per window.

### TC13 – Digest does not duplicate within window

Steps:

1. Run digest twice within 10 min without new overdue.
2. Second run should return `skipped: already_sent` or 0 new.
3. Verify inbox has only 1 digest.
   Expected: Idempotent digest window.

### TC14 – Digest includes due-soon (24h) alongside overdue

Steps:

1. Create task due in 2 hours for rep1.
2. Run digest.
3. Verify digest has sections `overdue:2, dueSoon:1`.
   Expected: Digest template separates sections.

### TC15 – Digest per-assignee isolation

Steps:

1. rep1 has overdue, rep2 has overdue.
2. Run digest.
3. Verify rep1 digest contains only rep1 tasks, rep2 only rep2.
   Expected: No cross-user leak.

### TC16 – Recurrence creation – weekly series

Steps:

1. POST task with `recurrence: {"freq":"weekly","interval":1,"count":5,"byDay":["MO"]}`.
2. Verify response `seriesId` + 5 occurrences with distinct `dueAt` weekly apart.
3. GET `/api/tasks?seriesId=xxx` returns 5.
   Expected: Expansion correct.

### TC17 – Recurrence edit this-only

Steps:

1. Take occurrence #3 from TC16.
2. PATCH `/api/tasks/:id` with `{"title":"Updated single","recurrenceMode":"this-only"}`.
3. Verify only that occurrence title changes; others unchanged; `isException=true`.
   Expected: Single-instance fork.

### TC18 – Recurrence edit future (this + future)

Steps:

1. Take occurrence #2, PATCH with `{"dueAt":"+2h shift","recurrenceMode":"future"}`.
2. Verify occurrences 2,3,4,5 shifted; occurrence 1 unchanged.
3. Verify `series Split` or `recurrenceUpdatedFrom` recorded.
   Expected: Future semantics correct.

### TC19 – Delete recurrence – this-only vs series

Steps:

1. DELETE `/api/tasks/:id?mode=this-only` for one occurrence; verify count 5->4.
2. DELETE `/api/tasks/series/:seriesId`; verify all gone.
   Expected: Scoped deletion.

### TC20 – Filter open/completed/cancelled + priority + overdue

Steps:

1. GET `/api/tasks?status=open`, `?status=completed`, `?status=cancelled`.
2. GET `?priority=high`, `?overdue=true`, `?assignee=rep1&status=open&sort=dueAt:asc`.
3. Verify counts match UI filter badges.
   Expected: All filters accurate, combined filters AND logic.

### TC21 – Linkage to lead/deal/contact

Steps:

1. Create task with `leadId=LEAD-001`.
2. Open lead detail page, verify task appears in related list.
3. Delete/unlink and verify removal.
   Expected: Relational integrity.

### TC22 – Assignment change triggers notification

Steps:

1. Create task assigned rep1, reassign to rep2 via PATCH.
2. Verify rep2 gets assignment notification, rep1 gets unassigned note if spec.
   Expected: Assignment side effects correct.

## 5. API Testing Section

| Method | Endpoint                              | Purpose                                                        | Auth   |
| ------ | ------------------------------------- | -------------------------------------------------------------- | ------ |
| POST   | /api/tasks                            | Create task                                                    | Bearer |
| GET    | /api/tasks                            | List + filters (status, priority, overdue, assignee, seriesId) | Bearer |
| GET    | /api/tasks/:id                        | Get single                                                     | Bearer |
| PATCH  | /api/tasks/:id                        | Update status/priority/due/recurrenceMode                      | Bearer |
| DELETE | /api/tasks/:id?mode=this-only\|series | Delete                                                         | Bearer |
| DELETE | /api/tasks/series/:seriesId           | Delete series                                                  | Bearer |
| POST   | /api/tasks/digest/run                 | Manually trigger overdue digest                                | Admin  |
| GET    | /api/notifications?userId=xxx         | Verify digest/reminder sent                                    | Bearer |
| GET    | /api/tasks/overdue?assignee=xxx       | Overdue query                                                  | Bearer |
| POST   | /api/auth/login                       | Get token                                                      | Public |

Example 1 – Create open high-priority task:

```bash
curl -X POST http://localhost:3001/api/tasks \
 -H "Content-Type: application/json" \
 -H "Authorization: Bearer $TOKEN" \
 -d '{"title":"Follow up Acme","priority":"high","dueAt":"2026-09-10T10:00:00Z","assigneeId":"rep1-id","leadId":"LEAD-001","remindAt":"2026-09-09T09:00:00Z"}'
```

Example 2 – Complete task:

```bash
curl -X PATCH http://localhost:3001/api/tasks/TASK_ID \
 -H "Content-Type: application/json" \
 -H "Authorization: Bearer $TOKEN" \
 -d '{"status":"completed"}'
```

Example 3 – Overdue filter + digest trigger:

```bash
curl "http://localhost:3001/api/tasks?status=open&overdue=true&assignee=rep1-id" \
 -H "Authorization: Bearer $TOKEN"
curl -X POST http://localhost:3001/api/tasks/digest/run \
 -H "Authorization: Bearer $ADMIN_TOKEN" \
 -H "Content-Type: application/json" -d '{"window":"15m"}'
```

Example 4 – Recurring weekly series:

```bash
curl -X POST http://localhost:3001/api/tasks \
 -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
 -d '{"title":"Weekly check-in","priority":"medium","dueAt":"2026-09-09T10:00:00Z","assigneeId":"rep1-id","recurrence":{"freq":"weekly","interval":1,"count":5}}'
```

Example 5 – Edit this-only vs future:

```bash
curl -X PATCH http://localhost:3001/api/tasks/OCC3_ID \
 -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
 -d '{"title":"Single fix","recurrenceMode":"this-only"}'
curl -X PATCH http://localhost:3001/api/tasks/OCC2_ID \
 -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
 -d '{"dueAt":"2026-09-16T12:00:00Z","recurrenceMode":"future"}'
```

Example 6 – Cancel + reopen:

```bash
curl -X PATCH http://localhost:3001/api/tasks/TASK_ID \
 -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
 -d '{"status":"cancelled","cancelReason":"no longer needed"}'
curl -X PATCH http://localhost:3001/api/tasks/TASK_ID \
 -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
 -d '{"status":"open"}'
```

## 6. UI Testing Section

- Navigate `http://localhost:3000/tasks`: verify tabs Open / Completed / Cancelled with counts.
- Create via `+ New Task` modal: required-field asterisks, date picker, priority dropdown colors, assignee search.
- Overdue rows highlighted red + `Overdue by 2d` label; priority badges; sort by Due and Priority.
- Digest preview: bell icon shows grouped digest, clicking expands task list; mark-all-read.
- Recurrence UI: `Repeat` toggle, freq picker, occurrence list preview; edit dialog offers radio `Only this task / This and following tasks / Entire series`.
- Responsive: table collapses to cards on mobile; filters in drawer.
- Accessibility: keyboard nav, aria-labels on status buttons, contrast on overdue red.
- Negative UI: try saving without title -> inline error; try remind after due -> inline error.

## 7. Regression & Cross-Feature Impact

- Activities: completing a task may auto-log an activity entry; verify no duplicate log on reopen.
- Calendar: tasks with dueAt appear as all-day/block on calendar; completing removes highlight but keeps entry.
- SLA: task resolution SLA clock stops on completed/cancelled; reopen restarts per policy (see sla-policies.md).
- Notifications: assignment + reminder + digest must not triple-notify for same task.
- Leads/Deals: deleting lead should nullify `leadId` or block if open tasks exist per spec.
- Search: task titles indexed; verify search returns open + completed.

## 8. Expected Results Summary Table

| TC   | Action         | Expected Status      | Visible In              | Notification          |
| ---- | -------------- | -------------------- | ----------------------- | --------------------- |
| TC01 | Create open    | 201 open             | Open list               | Assignment to rep1    |
| TC04 | Complete       | 200 completed        | Completed               | Optional done note    |
| TC05 | Cancel         | 200 cancelled        | Cancelled               | Optional              |
| TC09 | Overdue        | isOverdue true       | Overdue filter + red UI | Digest includes       |
| TC12 | Digest batch   | 1 digest for N tasks | Bell + email            | Grouped               |
| TC13 | Re-run digest  | Skipped              | No new                  | None                  |
| TC16 | Recurrence 5x  | 5 docs same seriesId | Series view             | 5 assignments batched |
| TC17 | This-only edit | 1 changed            | Exception badge         | None                  |
| TC18 | Future edit    | N-1 changed          | Updated dues            | Reschedule note       |
| TC20 | Filters        | Correct counts       | Badges match API        | -                     |
| TC22 | Reassign       | 200                  | New assignee list       | Notify new assignee   |

## 9. Troubleshooting & Common Failures

- `400 dueAt invalid`: ensure ISO8601 UTC `YYYY-MM-DDTHH:mm:ssZ`; browser locale may send local time – check payload.
- Digest not arriving: cron not running locally – manually POST `/digest/run`; check `notifications` table, spam, Mailhog at `http://localhost:8025`.
- Overdue off by one day: timezone mismatch – DB stores UTC, UI renders local; test with explicit timezone header.
- Recurrence creates 1 instead of 5: `count` vs `until` confusion; ensure backend expansion job ran; check `seriesId` present.
- This-only edits all: missing `recurrenceMode` defaults to `series` – always send explicit mode.
- Completed tasks still in Open: frontend cache – hard refresh, check `status` query param.
- 401 on curl: token expired (1h) – re-login and export `$TOKEN`.

## 10. Pass/Fail Checklist

- [ ] Create open task returns 201 and appears in Open list (TC01)
- [ ] Validation blocks missing title (TC02)
- [ ] Priority sorting urgent-first verified (TC03)
- [ ] Complete and cancel transitions work with timestamps (TC04-TC05)
- [ ] Invalid terminal transition blocked (TC06)
- [ ] Reopen works for both completed and cancelled (TC07-TC08)
- [ ] Overdue derived correctly (TC09)
- [ ] Reminder fires once before due (TC10) and validation blocks remind>due (TC11)
- [ ] Digest batches multiple overdue into single notification (TC12)
- [ ] Digest idempotent within window (TC13)
- [ ] Digest includes due-soon section (TC14)
- [ ] Digest isolated per assignee (TC15)
- [ ] Recurrence expands to N occurrences (TC16)
- [ ] This-only edits single occurrence (TC17)
- [ ] Future edits this+future only (TC18)
- [ ] Scoped deletion works (TC19)
- [ ] All filters + combined query correct (TC20)
- [ ] Lead/deal linkage visible (TC21)
- [ ] Reassignment notifies correctly (TC22)
- [ ] All curl examples in Section 5 executed with 2xx
- [ ] UI verified on Chrome + mobile viewport
- [ ] Regression with activities/calendar/SLA checked
