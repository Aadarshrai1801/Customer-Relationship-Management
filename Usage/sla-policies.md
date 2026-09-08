# SLA Policies – Comprehensive Testing Guide

## 1. Overview

This guide covers First-Response and Resolution SLA policies evaluated on-demand per lead/deal/task. Policies define `targetMinutes` (e.g., first-response 60m, resolution 1440m), `businessHours` (e.g., Mon-Fri 09-17 UTC, holidays excluded), `appliesTo` (lead/deal/task + priority/channel filters), and `breachActions` (notify, escalate, tag). Evaluation is on-demand via `GET /api/sla/evaluate?entityType=&entityId=` or `POST /api/sla/evaluate-bulk`, returning `status=within|at-risk|breached`, `elapsedMin`, `remainingMin`, `deadline`, `paused` if waiting on customer? No auto-cron – caller triggers (UI polls, worker optionally).
Business rules:

- Clock starts at `createdAt`; first-response stops at first human outbound (call/email/meeting, not sequence auto-send); resolution stops at `status=closed/converted/completed`.
- Business-hours mode counts only in-hours minutes; 24x7 mode counts wall-clock.
- Pause when `onHold=true` or `awaitingCustomer`? Document per spec.
- Multiple policies: most-specific match wins (e.g., urgent task 30m overrides default 4h).
  Base URLs:
- API: `http://localhost:3001`
- Web: `http://localhost:3000`

## 2. Prerequisites & Test Data Setup

- Users admin (manage policies), rep1 (evaluate).
- Seed policies:
  - `POL-FR-LEAD`: first-response 60m, appliesTo lead, all priorities, businessHours Mon-Fri 09-17 UTC.
  - `POL-RES-DEAL`: resolution 1440m (24h), deal, 24x7.
  - `POL-TASK-URGENT`: first-response 30m + resolution 240m, task priority urgent only.
  - `POL-DEFAULT`: fallback 480m.
- Seed entities:
  - `SLA-LEAD-01` created 30m ago, no response yet (within).
  - `SLA-LEAD-02` created 90m ago, no response (breached in 24x7, maybe within in business-hours – craft for both).
  - `SLA-DEAL-01` closed after 2h (breached if target 1h, within if 24h).
  - `SLA-TASK-URGENT-01` open urgent.
- Business-hours calendar: US holidays list; test Fri 16:30 -> Mon 09:30 edge.
- Auth tokens admin + rep1.
- Clean: `DELETE /api/test/reset?scope=sla` preserves entities but clears evaluations cache if any.

## 3. Test Environment Matrix

| Env                                                                                       | Eval Endpoint                          | Clock                       | Notes                        |
| ----------------------------------------------------------------------------------------- | -------------------------------------- | --------------------------- | ---------------------------- |
| Local                                                                                     | http://localhost:3001/api/sla/evaluate | Real now + `?now=` override | Deterministic with now param |
| CI                                                                                        | Same + fixtures                        | Frozen 2026-09-08T12:00Z    | Snapshot deadlines           |
| Staging                                                                                   | staging-api                            | Real                        | Holiday + TZ                 |
| Browsers                                                                                  | Chrome/Firefox                         | -                           | SLA badges, countdown        |
| TZ                                                                                        | UTC, EST, IST                          | -                           | Business-hours conversion    |
| Modes                                                                                     | businessHours vs 24x7                  | -                           | Compare same entity          |
| Note: `?now=` override is test-only – disabled in prod. All deadline asserts use ISO UTC. |

## 4. Detailed Step-by-Step Test Cases

### TC01 – Create first-response policy

Steps:

1. POST `/api/sla/policies {name, type:first-response, targetMin:60, appliesTo:lead, businessHours:{...}}`.
2. Assert 201, `id`, `isActive=true`.
   Expected: Created.

### TC02 – Create resolution policy

Steps:

1. POST resolution 1440m for deal 24x7.
2. Verify listed via GET `/api/sla/policies`.
   Expected: Created.

### TC03 – Validation – negative target / unknown entity

Steps:

1. POST targetMin -5 -> 400.
2. POST appliesTo `invoice` -> 400.
   Expected: Blocked.

### TC04 – Evaluate lead within SLA (no response yet, time left)

Steps:

1. GET `/api/sla/evaluate?entityType=lead&entityId=SLA-LEAD-01`.
2. Verify `firstResponse={status:within, elapsed:30, remaining:30, deadline}`.
   Expected: Within.

### TC05 – Evaluate breached (elapsed > target)

Steps:

1. GET for SLA-LEAD-02 (90m, target 60, 24x7).
2. Verify `status:breached, elapsed:90, overdueBy:30`.
3. UI shows red `Breached by 30m`.
   Expected: Breached.

### TC06 – First response stops on human reply

Steps:

1. Take SLA-LEAD-01, POST outbound call activity now.
2. Re-evaluate – `firstResponse.status=met, respondedAt=now, elapsedAtResponse:35`.
3. Verify remaining frozen, not growing.
   Expected: Clock stops.

### TC07 – Sequence auto-send does NOT stop first-response

Steps:

1. New lead, enroll sequence, worker sends auto email.
2. Evaluate – still `within/unmet`, `respondedAt=null`.
3. Manual rep email then stops (contrast TC06).
   Expected: Auto excluded.

### TC08 – Resolution stops on close/complete

Steps:

1. Create deal, evaluate resolution within.
2. PATCH deal `status=closed-won`.
3. Re-evaluate – `resolution.status=met, resolvedAt`.
   Expected: Stops.

### TC09 – Reopen restarts resolution?

Steps:

1. Reopen deal from TC08.
2. Evaluate – verify `status=within (restarted)` with new `startedAt=reopenedAt` OR `breached (original)` per spec – record actual.
   Expected: Defined restart.

### TC10 – Business-hours counting – after-hours pause

Steps:

1. Lead created Fri 16:30 UTC, target 60m business-hours (closes 17:00).
2. Evaluate Mon 09:10 – elapsed should be ~40m (30 Fri +10 Mon), not weekend wall 3000m.
3. Verify deadline Mon 10:00.
   Expected: Hours-aware.

### TC11 – 24x7 counting – wall-clock

Steps:

1. Same lead evaluated under 24x7 policy – elapsed = full wall minutes, breached.
2. Compare side-by-side with TC10.
   Expected: Mode difference.

### TC12 – At-risk threshold (e.g., 80% elapsed)

Steps:

1. Lead at 50/60m (83%).
2. Verify `status=at-risk` (not within), UI amber `Due in 10m`.
3. Check `atRiskThresholdPct=80` config.
   Expected: Early warning.

### TC13 – Priority-specific policy wins over default

Steps:

1. Urgent task evaluated – matches POL-TASK-URGENT 30m, not POL-DEFAULT 480m.
2. Verify `matchedPolicyId=POL-TASK-URGENT`.
3. Normal task matches DEFAULT.
   Expected: Specificity.

### TC14 – Channel filter (email vs call)?

Steps:

1. If policy `channels=[email]` – lead responded via call only – verify still unmet (call doesn’t count) per spec.
2. Document actual channel handling.
   Expected: Channel-aware or documented as ignored.

### TC15 – On-hold pauses clock

Steps:

1. PATCH lead `onHold=true` for 2h, then false.
2. Evaluate – elapsed excludes hold duration (or `paused:true` while held – record).
   Expected: Pause.

### TC16 – Bulk evaluate 50 entities

Steps:

1. POST `/api/sla/evaluate-bulk {entities:[...50]}`.
2. Verify 50 results, breached count correct, <2s.
3. Check dashboard aggregates match.
   Expected: Bulk scales.

### TC17 – No matching policy – default or null?

Steps:

1. Evaluate entityType with no policy (e.g., contact if none).
2. Verify `matchedPolicyId=null, status=no-policy` OR fallback DEFAULT – record.
   Expected: Defined.

### TC18 – Disabled policy ignored

Steps:

1. PATCH POL-FR-LEAD `isActive=false`.
2. Re-evaluate SLA-LEAD-01 – should match DEFAULT or no-policy, not disabled.
3. Re-enable after.
   Expected: Active filter.

### TC19 – Deadline display + countdown UI

Steps:

1. Open lead detail – SLA widget shows `First response due in 25m (by 13:00 UTC)` live countdown.
2. Breached shows `Breached 30m ago – Escalate` button.
3. Refresh after response – flips to `Met in 35m ✓`.
   Expected: UI live.

### TC20 – Breach actions – notify/escalate/tag

Steps:

1. Configure breachActions `notify:manager, tag:breached`.
2. Force breach (TC05), trigger evaluate with `?applyActions=true` or worker.
3. Verify notification to manager + tag added + audit `breachActionFired`.
4. Ensure actions fire once (not on every evaluate).
   Expected: Once-only actions.

### TC21 – Holiday excluded

Steps:

1. Set holiday 2026-09-07 (Mon).
2. Lead created Fri before holiday, evaluate Tue – elapsed excludes holiday 8h.
   Expected: Holiday-aware.

### TC22 – Audit history – evaluations logged?

Steps:

1. GET `/api/sla/history?entityType=lead&entityId=SLA-LEAD-01`.
2. Verify entries: created, responded, breached, with timestamps + policy snapshot.
   Expected: Traceable.

## 5. API Testing Section

| Method | Endpoint                                     | Purpose                   | Auth   |
| ------ | -------------------------------------------- | ------------------------- | ------ |
| POST   | /api/sla/policies                            | Create policy             | Admin  |
| GET    | /api/sla/policies                            | List                      | Bearer |
| PATCH  | /api/sla/policies/:id                        | Edit/disable              | Admin  |
| GET    | /api/sla/evaluate?entityType=&entityId=&now= | On-demand single          | Bearer |
| POST   | /api/sla/evaluate-bulk                       | Bulk                      | Bearer |
| GET    | /api/sla/history?entityType=&entityId=       | Audit                     | Bearer |
| POST   | /api/activities                              | Stop first-response clock | Bearer |
| PATCH  | /api/deals/:id etc.                          | Stop resolution clock     | Bearer |

Example 1 – Create policies:

```bash
curl -X POST http://localhost:3001/api/sla/policies \
 -H "Content-Type: application/json" -H "Authorization: Bearer $ADMIN_TOKEN" \
 -d '{"name":"Lead FR 60m","type":"first-response","targetMin":60,"appliesTo":"lead","mode":"business-hours","businessHours":{"days":["mon","tue","wed","thu","fri"],"start":"09:00","end":"17:00","tz":"UTC"}}'
curl -X POST http://localhost:3001/api/sla/policies \
 -H "Content-Type: application/json" -H "Authorization: Bearer $ADMIN_TOKEN" \
 -d '{"name":"Deal RES 24h","type":"resolution","targetMin":1440,"appliesTo":"deal","mode":"24x7"}'
```

Example 2 – Evaluate single + with now override:

```bash
curl "http://localhost:3001/api/sla/evaluate?entityType=lead&entityId=SLA-LEAD-01" -H "Authorization: Bearer $TOKEN"
curl "http://localhost:3001/api/sla/evaluate?entityType=lead&entityId=SLA-LEAD-02&now=2026-09-08T12:00:00Z" -H "Authorization: Bearer $TOKEN"
curl "http://localhost:3001/api/sla/evaluate?entityType=task&entityId=SLA-TASK-URGENT-01" -H "Authorization: Bearer $TOKEN"
```

Example 3 – Stop first-response with human activity:

```bash
curl -X POST http://localhost:3001/api/activities \
 -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
 -d '{"type":"call","subject":"First response","leadId":"SLA-LEAD-01","durationSec":120}'
curl "http://localhost:3001/api/sla/evaluate?entityType=lead&entityId=SLA-LEAD-01" -H "Authorization: Bearer $TOKEN"
```

Example 4 – Bulk:

```bash
curl -X POST http://localhost:3001/api/sla/evaluate-bulk \
 -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
 -d '{"entities":[{"entityType":"lead","entityId":"SLA-LEAD-01"},{"entityType":"deal","entityId":"SLA-DEAL-01"}]}'
```

Example 5 – Disable + history:

```bash
curl -X PATCH http://localhost:3001/api/sla/policies/POL_ID \
 -H "Content-Type: application/json" -H "Authorization: Bearer $ADMIN_TOKEN" \
 -d '{"isActive":false}'
curl "http://localhost:3001/api/sla/history?entityType=lead&entityId=SLA-LEAD-01" -H "Authorization: Bearer $TOKEN"
```

Example 6 – Apply breach actions once:

```bash
curl "http://localhost:3001/api/sla/evaluate?entityType=lead&entityId=SLA-LEAD-02&applyActions=true" -H "Authorization: Bearer $ADMIN_TOKEN"
curl "http://localhost:3001/api/sla/evaluate?entityType=lead&entityId=SLA-LEAD-02&applyActions=true" -H "Authorization: Bearer $ADMIN_TOKEN"
```

## 6. UI Testing Section

- `http://localhost:3000/settings/sla`: policy table (Name/Type/Target/AppliesTo/Mode/Active toggle), New Policy modal with business-hours picker + holiday list.
- Detail widgets (lead/deal/task): pill `Within 25m / At-risk 10m / Breached 30m / Met ✓`, tooltip with deadline + matched policy + mode.
- List views: SLA column sortable, filter `Breached`, bulk `Evaluate` button.
- Mobile: pills wrap, countdown abbreviates `25m left`.
- Accessibility: color + text (not color-only), aria-live for countdown? Document.

## 7. Regression & Cross-Feature Impact

- Activities: first human activity stops FR; sequence auto-send must not (see sequences.md).
- Tasks: completion stops resolution; reopen restarts per TC09 – verify digest + SLA not double-notify.
- Calendar: meeting activity counts as response; synced meetings count same as manual.
- Notifications: breach notify + task digest + assignment must not spam same owner thrice – dedup by entity.
- Email-tracking: opens/clicks never satisfy SLA – only replies/outbound.

## 8. Expected Results Summary Table

| TC   | Entity         | Elapsed vs Target | Expected Status         | Clock       |
| ---- | -------------- | ----------------- | ----------------------- | ----------- |
| TC04 | LEAD-01 30/60  | 50%               | within                  | running     |
| TC05 | LEAD-02 90/60  | 150%              | breached                | running     |
| TC06 | After call     | stopped 35        | met                     | frozen      |
| TC07 | Auto-send only | unmet             | within/breached by time | running     |
| TC10 | Fri-Mon BH     | 40/60             | within                  | hours-aware |
| TC11 | Same 24x7      | 3000/60           | breached                | wall        |
| TC12 | 50/60 83%      | at-risk           | amber                   | running     |
| TC13 | Urgent task    | 30m policy        | matched urgent          | -           |

## 9. Troubleshooting & Common Failures

- Always breached: `mode` defaults 24x7 but expected business-hours – check matchedPolicy `mode`; pass `?now=` in UTC, not local.
- First-response met by sequence: auto-send flagged `isHuman=false`? Verify activity `source=sequence` excluded; check filter `isHuman=true`.
- Deadline off by hours: businessHours tz vs entity tz – store all UTC, convert window correctly; DST week shifts 1h.
- Bulk slow: N+1 queries – should batch activities lookup; check `evaluate-bulk` timing, index on `(entityType, entityId, occurredAt)`.
- Actions fire every poll: missing `breachNotifiedAt` guard – second `applyActions` should return `already_notified`.
- No-policy confusion: fallback DEFAULT vs null – check `matchedPolicyId`; create explicit DEFAULT to avoid null.
- `now` override works in prod: must be test-only – verify 403 without `ALLOW_NOW_OVERRIDE`.

## 10. Pass/Fail Checklist

- [ ] Create FR + RES + validation (TC01-TC03)
- [ ] Within evaluated (TC04), breached (TC05)
- [ ] Human reply stops (TC06), auto does not (TC07)
- [ ] Close stops resolution (TC08), reopen defined (TC09)
- [ ] Business-hours excludes nights/weekends (TC10) vs 24x7 wall (TC11)
- [ ] At-risk at 80% (TC12)
- [ ] Priority specificity (TC13)
- [ ] Channel handling documented (TC14)
- [ ] On-hold pauses (TC15)
- [ ] Bulk 50 <2s (TC16)
- [ ] No-policy defined (TC17), disabled ignored (TC18)
- [ ] Countdown UI live (TC19)
- [ ] Breach actions once-only (TC20)
- [ ] Holiday excluded (TC21)
- [ ] History audited (TC22)
- [ ] All curl examples executed
- [ ] UI pills + settings verified
- [ ] Regression with activities/tasks checked
