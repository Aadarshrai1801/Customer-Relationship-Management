# Sequences – Comprehensive Testing Guide

## 1. Overview

Sequences (Cadences) automate multi-step outreach: `wait` delays + `send` email steps (using templates), with enrollment per lead/contact, pause/resume/cancel controls, reply auto-pause (inbound reply stops future sends), and a daily worker (cron) that advances due enrollments. Steps example: Day0 send TPL-1 -> Wait 3d -> Send TPL-2 -> Wait 7d -> Send TPL-3.
Business rules:

- Enrollment is per `(sequenceId, leadId)` unique; re-enroll after cancel/completed creates new enrollment.
- Statuses: `active|paused|cancelled|completed|bounced`; only active advanced by worker.
- Reply auto-pause triggers on inbound email match (see emails.md) with `autoPausedReason=reply_detected`.
- Daily worker runs `00:00 UTC` (configurable `SEQUENCE_CRON`), processes `nextStepDueAt <= now`, sends atomically (claim-then-send to avoid double-send).
- Wait steps computed in calendar days respecting timezone `enrollment.tz`?
  Base URLs:
- API: `http://localhost:3001`
- Web: `http://localhost:3000`

## 2. Prerequisites & Test Data Setup

- Templates: `TPL-SEQ-1/2/3` simple bodies with `{{firstName}}`.
- Leads: `SEQ-LEAD-01..05` with distinct emails `seq01@test.com` etc.; one with `bounce@test.com` for bounce test.
- Sequence seed: `SEQ-TEST` steps: Send1 immediate, Wait 1d (use short waits `1h` or `1m` for test via `waitMin` override if supported, else manipulate `nextStepDueAt`).
- Worker: locally trigger via `POST /api/sequences/worker/run` (admin) instead of waiting 24h; note cron in staging.
- SMTP stubbed; tracking on for sequence sends.
- Tokens: admin (worker), rep1 (enroll).
- Clean: `DELETE /api/test/reset?scope=sequences`.
- Time: record `now` before each worker run; use `X-Test-Now` if available.

## 3. Test Environment Matrix

| Env                                                                                                                                   | Worker Trigger          | Waits                 | Notes                        |
| ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | --------------------- | ---------------------------- |
| Local                                                                                                                                 | Manual POST /worker/run | Short 1m/1h overrides | Fast iteration               |
| CI                                                                                                                                    | Manual + fake timers    | 1m                    | Assert step progression      |
| Staging                                                                                                                               | Real cron 00:00 UTC     | Real 1d/3d            | Digest + timezone            |
| Browsers                                                                                                                              | Chrome/Firefox          | -                     | Enrollment UI, pause buttons |
| Roles                                                                                                                                 | admin, rep1 owner, rep2 | -                     | Enroll/pause perms           |
| Load                                                                                                                                  | 500 enrollments bulk    | -                     | Worker idempotency           |
| Note: production waits are days; local uses minutes to avoid flakiness – document mapping. Timezone test uses IST lead vs UTC worker. |

## 4. Detailed Step-by-Step Test Cases

### TC01 – Create sequence with wait/send steps

Steps:

1. POST `/api/sequences` name, steps `[{type:send,templateId:TPL1},{type:wait,days:3},{type:send,templateId:TPL2}]`.
2. Assert 201, `stepCount=3`, order preserved.
3. GET single verify.
   Expected: Created.

### TC02 – Validation – send without template rejected

Steps:

1. POST step send missing templateId -> 400.
2. POST wait negative days -> 400.
   Expected: Blocked.

### TC03 – Enroll lead – immediate first send?

Steps:

1. POST `/api/sequences/SEQ-TEST/enroll {leadId:SEQ-LEAD-01}`.
2. Verify enrollment `status=active`, `currentStep=0`, `nextStepDueAt=now` (immediate).
3. Run worker, verify email1 sent + activity logged with `sequenceId`.
   Expected: Enrolled + first send on worker.

### TC04 – Worker advances wait then second send (enrollment flow)

Steps:

1. After TC03 email1 sent, enrollment should be at wait step, `nextStepDueAt=+3d` (or +1h test).
2. Fast-forward: PATCH `nextStepDueAt=now` as admin (test helper) or wait.
3. Run worker twice: first completes wait, second sends email2.
4. Verify 2 emails, `currentStep=2`.
   Expected: Wait/send progression.

### TC05 – Full completion – all steps done

Steps:

1. Continue worker until steps exhausted.
2. Verify enrollment `status=completed`, `completedAt` set, no further sends on extra worker runs.
   Expected: Completed terminal.

### TC06 – Pause enrollment – worker skips

Steps:

1. Enroll SEQ-LEAD-02, POST `/enrollments/:id/pause {reason:"on holiday"}`.
2. Verify status paused.
3. Run worker – no send, `skipped:paused`.
   Expected: Paused excluded.

### TC07 – Resume – continues from same step

Steps:

1. POST `/enrollments/:id/resume`.
2. Verify status active, `nextStepDueAt=now` (or original + pauseDuration per spec – record).
3. Run worker – sends next step, not restart from 0.
   Expected: Resume mid-cadence.

### TC08 – Cancel – terminal, no further sends

Steps:

1. Enroll SEQ-LEAD-03, POST `/enrollments/:id/cancel`.
2. Verify cancelled, worker skips, UI shows Cancelled badge.
3. Re-enroll same lead – new enrollment id allowed.
   Expected: Cancel + re-enroll.

### TC09 – Reply auto-pause – inbound stops cadence

Steps:

1. Enroll SEQ-LEAD-04, run worker to send email1.
2. Simulate inbound reply via `POST /api/emails/inbound From seq04@test.com In-Reply-To <seq-email>`.
3. Verify enrollment auto-paused `autoPaused=true, reason=reply_detected`, worker skips next send.
4. Check owner notified `Lead replied – sequence paused`.
   Expected: Auto-pause.

### TC10 – Non-reply inbound (new thread) – does it pause?

Steps:

1. Enroll new lead, send inbound with different subject, no In-Reply-To.
2. Document whether any inbound from lead pauses (broad) vs only threaded replies (narrow) – assert actual.
   Expected: Defined matching.

### TC11 – MPP open does NOT pause

Steps:

1. Fire MPP open pixel for sequence email.
2. Run worker – verify still active, next send proceeds.
3. Fire real click – verify still active (clicks don’t pause, only replies per spec – confirm).
   Expected: Opens/clicks don’t pause.

### TC12 – Bounce – auto-cancel or pause?

Steps:

1. Enroll bounce@test.com (suppression/bounce).
2. Run worker – send fails bounce.
3. Verify enrollment `status=bounced` or `cancelled reason=bounced` per spec, no retry loop.
   Expected: Bounce handling.

### TC13 – Unsubscribe – auto-cancel

Steps:

1. Enroll lead, send email1 with unsubscribe link.
2. Click unsubscribe via tracking.
3. Verify enrollment cancelled `reason=unsubscribed`, future worker skips.
   Expected: Respect opt-out.

### TC14 – Daily worker idempotent – double run no double-send

Steps:

1. Enroll lead due now.
2. Run worker twice concurrently (`POST` x2 parallel).
3. Verify only 1 email sent (claim-then-send, unique `stepExecutionId`).
   Expected: Exactly-once.

### TC15 – Worker batch – 500 enrollments

Steps:

1. Bulk enroll 50 (or 500 staging) leads due now.
2. Run worker, measure <60s, verify all sent once, `processed=50, sent=50`.
3. Check no OOM, logs paginated.
   Expected: Scales.

### TC16 – Edit sequence – live enrollments pinned vs updated?

Steps:

1. Enroll lead, then PATCH sequence add step.
2. Verify existing enrollment keeps old step snapshot (`pinnedVersion`) OR picks up new per spec – record.
3. New enrollments use new version.
   Expected: Version pinning defined.

### TC17 – Remove lead mid-sequence (lead deleted) – graceful

Steps:

1. Enroll, then DELETE lead.
2. Run worker – verify enrollment cancelled `reason=lead_deleted`, no crash, no send to orphan email.
   Expected: Graceful.

### TC18 – Timezone – wait due at lead local midnight?

Steps:

1. Enroll IST lead with wait 1d.
2. Verify `nextStepDueAt` respects enrollment tz vs UTC midnight – document actual.
3. Check worker at UTC midnight doesn’t send 5h early for IST.
   Expected: TZ correct or documented gap.

### TC19 – Permissions – rep cannot enroll other’s lead?

Steps:

1. As rep2 enroll rep1’s lead -> 403 unless admin.
2. As admin succeeds.
   Expected: RBAC.

### TC20 – Analytics – per-step open/reply rates

Steps:

1. After several enrollments with opens/replies, GET `/api/sequences/:id/stats`.
2. Verify `step1 sent/open/reply counts`, funnel `step1->step2 dropoff`.
3. UI funnel chart matches.
   Expected: Stats.

### TC21 – Manual step skip / retry failed send

Steps:

1. Force send failure (SMTP down) – enrollment `status=active, lastError`.
2. POST `/enrollments/:id/retry` after SMTP up – verify resends same step, not skip.
3. POST `/enrollments/:id/skip` – moves past failed step.
   Expected: Recovery controls.

### TC22 – Duplicate enroll blocked while active

Steps:

1. Enroll same lead twice without cancel – second returns 409 `already enrolled`.
2. After completed/cancelled, re-enroll succeeds.
   Expected: Uniqueness guard.

## 5. API Testing Section

| Method | Endpoint                               | Purpose              | Auth        |
| ------ | -------------------------------------- | -------------------- | ----------- |
| POST   | /api/sequences                         | Create cadence       | Admin/Rep   |
| GET    | /api/sequences                         | List                 | Bearer      |
| POST   | /api/sequences/:id/enroll              | Enroll lead          | Bearer      |
| GET    | /api/sequences/:id/enrollments         | List enrollments     | Bearer      |
| POST   | /api/sequences/enrollments/:eid/pause  | Pause                | Owner/Admin |
| POST   | /api/sequences/enrollments/:eid/resume | Resume               | Owner/Admin |
| POST   | /api/sequences/enrollments/:eid/cancel | Cancel               | Owner/Admin |
| POST   | /api/sequences/enrollments/:eid/retry  | Retry failed         | Owner/Admin |
| POST   | /api/sequences/enrollments/:eid/skip   | Skip step            | Owner/Admin |
| POST   | /api/sequences/worker/run              | Trigger daily worker | Admin       |
| GET    | /api/sequences/:id/stats               | Funnel stats         | Bearer      |

Example 1 – Create + enroll:

```bash
curl -X POST http://localhost:3001/api/sequences \
 -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
 -d '{"name":"Intro 3-step","steps":[{"type":"send","templateId":"TPL-SEQ-1"},{"type":"wait","days":3},{"type":"send","templateId":"TPL-SEQ-2"}]}'
curl -X POST http://localhost:3001/api/sequences/SEQ_ID/enroll \
 -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
 -d '{"leadId":"SEQ-LEAD-01"}'
```

Example 2 – Daily worker (twice for idempotency):

```bash
curl -X POST http://localhost:3001/api/sequences/worker/run -H "Authorization: Bearer $ADMIN_TOKEN"
curl -X POST http://localhost:3001/api/sequences/worker/run -H "Authorization: Bearer $ADMIN_TOKEN"
curl "http://localhost:3001/api/sequences/SEQ_ID/enrollments?status=active" -H "Authorization: Bearer $TOKEN"
```

Example 3 – Pause/resume/cancel:

```bash
curl -X POST http://localhost:3001/api/sequences/enrollments/ENROLL_ID/pause \
 -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" -d '{"reason":"holiday"}'
curl -X POST http://localhost:3001/api/sequences/enrollments/ENROLL_ID/resume -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{}'
curl -X POST http://localhost:3001/api/sequences/enrollments/ENROLL_ID/cancel \
 -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" -d '{"reason":"not interested"}'
```

Example 4 – Reply auto-pause simulation:

```bash
curl -X POST http://localhost:3001/api/emails/inbound \
 -H "Content-Type: application/json" -H "X-Webhook-Secret: $INBOUND_SECRET" \
 -d '{"from":"seq04@test.com","to":["rep1@test.com"],"subject":"Re: Intro","body":"Interested!","inReplyTo":"SEQ-MSG-ID-1"}'
curl http://localhost:3001/api/sequences/enrollments/ENROLL_ID -H "Authorization: Bearer $TOKEN"
```

Example 5 – Retry/skip + stats:

```bash
curl -X POST http://localhost:3001/api/sequences/enrollments/ENROLL_ID/retry -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{}'
curl http://localhost:3001/api/sequences/SEQ_ID/stats -H "Authorization: Bearer $TOKEN"
```

Example 6 – Bulk enroll (load):

```bash
curl -X POST http://localhost:3001/api/sequences/SEQ_ID/enroll-bulk \
 -H "Content-Type: application/json" -H "Authorization: Bearer $ADMIN_TOKEN" \
 -d '{"leadIds":["SEQ-LEAD-01","SEQ-LEAD-02","SEQ-LEAD-03"]}'
```

## 6. UI Testing Section

- `http://localhost:3000/sequences`: cards with step preview `Send -> Wait 3d -> Send`, enrollment counts Active/Paused/Done.
- Builder: drag steps, template picker with render preview, wait duration stepper (days/hours test mode).
- Enrollment drawer: timeline `Sent Day0 ✓, Waiting until Sep 11, Paused (reply)`, buttons Pause/Resume/Cancel/Retry/Skip with confirm modals.
- Worker banner: `Last run 2m ago – 12 sent, 1 paused (reply)`.
- Mobile: steps vertical, enrollment actions bottom sheet.

## 7. Regression & Cross-Feature Impact

- Emails: sequence sends use same pipeline (autolog, BCC dedup, tracking); reply detection depends on email match.
- Templates: sequence pins template version; template delete blocked if used (see email-templates.md).
- Tracking: MPP opens must not pause; clicks must not pause – only replies.
- Activities: each send logs email activity with `sequenceId+stepIndex`; reply logs inbound + pauses.
- SLA: sequence first send may satisfy first-response? Document – usually manual only, sequence auto-send excluded.

## 8. Expected Results Summary Table

| TC   | Action     | Enrollment After | Emails         | Worker Next |
| ---- | ---------- | ---------------- | -------------- | ----------- |
| TC03 | Enroll     | active step0     | 0 until worker | due now     |
| TC04 | Worker x2  | wait -> send2    | 2              | future due  |
| TC05 | Exhaust    | completed        | 3              | skipped     |
| TC06 | Pause      | paused           | 0 new          | skipped     |
| TC07 | Resume     | active same step | +1             | due now     |
| TC08 | Cancel     | cancelled        | 0 new          | skipped     |
| TC09 | Reply      | auto-paused      | stopped        | skipped     |
| TC14 | Double run | 1 send           | 1              | idempotent  |
| TC22 | Dup enroll | 409              | -              | -           |

## 9. Troubleshooting & Common Failures

- Worker sends nothing: `nextStepDueAt` in future (days) – use test helper to set due now or short waits; check `status=active` not paused.
- Double-send: missing atomic claim – check `stepExecutionId` unique + worker `findOneAndUpdate(status=processing)`; run parallel test to repro.
- Reply didn’t pause: inbound From didn’t match lead email (case/plus) – check normalization; `In-Reply-To` missing and broad-match disabled.
- MPP paused incorrectly: worker checks `openCount>0` – must check `replyCount>0` only; fix logic, verify TC11.
- Enrollment stuck in wait: cron TZ vs enrollment TZ – inspect `nextStepDueAt` UTC value; manually trigger worker with `?force=true` for test.
- Template v2 unexpectedly used: live enrollment not pinned – check `templateVersion` snapshot on enroll.
- 403 enroll: lead owned by other rep – use owner token or admin.

## 10. Pass/Fail Checklist

- [ ] Create + validation (TC01-TC02)
- [ ] Enroll immediate + first send (TC03)
- [ ] Wait/send progression (TC04) + completion (TC05)
- [ ] Pause skips (TC06), resume same step (TC07)
- [ ] Cancel terminal + re-enroll (TC08)
- [ ] Reply auto-pauses + notifies (TC09)
- [ ] Non-thread inbound documented (TC10)
- [ ] MPP/click don’t pause (TC11)
- [ ] Bounce handling (TC12), unsubscribe cancels (TC13)
- [ ] Double worker no double-send (TC14)
- [ ] Bulk 50 <60s (TC15)
- [ ] Version pinning (TC16)
- [ ] Deleted lead graceful (TC17)
- [ ] Timezone documented (TC18)
- [ ] RBAC (TC19)
- [ ] Stats funnel (TC20)
- [ ] Retry/skip (TC21), dup guard (TC22)
- [ ] All curl examples executed
- [ ] UI builder + enrollment timeline verified
