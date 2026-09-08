# Lead Routing – Comprehensive Testing Guide

## 1. Overview

This guide covers Lead Routing / Assignment automation: round-robin and manual rules, member order, availability / OOO handling, fallback queue, assignment log, and 60-second notification SLA.
Scope includes rule CRUD, rule priority/order, round-robin pointer advancement, manual (condition-based) routing, member availability toggles, OOO dates, fallback/unassigned queue, reassignment, audit log, notifications (in-app/email stub), permissions (admin config vs rep view).
Base URLs:

- API: `http://localhost:3001`
- Web: `http://localhost:3000`
  Mental model: Incoming Lead -> Evaluate rules top-down -> Find eligible members (available, not OOO, capacity) -> Round-robin pick next -> Assign owner -> Log entry -> Notify within 60s -> Fallback queue if none eligible.
  Success criteria: deterministic round-robin order, OOO members skipped, fallback used when all unavailable, every auto-assignment logged with rule + actor `system`, notification delivered <60s.

## 2. Prerequisites & Test Data Setup

- Services: API `http://localhost:3001/health`, Web `http://localhost:3000`.
- Users: Admin (manage rules), Rep A, Rep B, Rep C (routing pool), Viewer.
- Get user ids: `GET /api/users` as Admin, record `repA_id, repB_id, repC_id`.
- Baseline routing config backup: `GET /api/routing/rules` and `GET /api/routing/log?limit=5` – save JSON to restore after tests.
- Create test rule payload (round-robin):

```json
{
  "name": "Test Round Robin - West",
  "type": "round_robin",
  "isActive": true,
  "priority": 1,
  "conditions": { "region": "West" },
  "members": [
    { "userId": "repA_id", "order": 1, "isAvailable": true },
    { "userId": "repB_id", "order": 2, "isAvailable": true },
    { "userId": "repC_id", "order": 3, "isAvailable": true }
  ],
  "fallbackUserId": "admin_id",
  "fallbackQueue": true
}
```

- Manual rule example:

```json
{
  "name": "Test Manual - Enterprise",
  "type": "manual",
  "isActive": true,
  "priority": 0,
  "conditions": { "companySize": "Enterprise", "source": "Referral" },
  "members": [{ "userId": "repA_id", "order": 1, "isAvailable": true }],
  "fallbackQueue": false
}
```

- OOO setup: set Rep B OOO via `PATCH /api/users/repB_id { "ooo": { "enabled": true, "from": "2026-09-08", "to": "2026-09-15" } }` or UI profile toggle.
- Notification check: have access to notification endpoint `GET /api/notifications?userId=` or in-app bell + email stub log file.
- Stopwatch for 60s SLA: use phone timer or `time curl` + notification `createdAt` diff.
- Cleanup: delete test rules `DELETE /api/routing/rules/:id`, reset OOO off, reassign test leads.

## 3. Test Environment Matrix

| Dimension    | Variants                                                     |
| ------------ | ------------------------------------------------------------ |
| API          | `http://localhost:3001`                                      |
| Web          | `http://localhost:3000`                                      |
| Browsers     | Chrome, Firefox                                              |
| Roles        | Admin (config), Rep (view own assignments), Viewer (no view) |
| Rule Types   | Round-robin, Manual/conditional, Inactive, No rules          |
| Pool Size    | 1 member, 3 members, 10 members                              |
| Availability | All available, one OOO, all OOO, one disabled                |
| Lead Volume  | Single, burst 10 in 30s, 100 bulk import                     |
| Notification | In-app bell, email stub, both, none (fallback)               |

- Isolate tests: pause other active rules or use unique condition (e.g., `source: RoutingTest`) to avoid interference.
- Record rule ids and pointer state before/after each TC.

## 4. Detailed Step-by-Step Test Cases

### TC01 – Create Round-Robin Rule Happy Path (UI)

- Steps as Admin:
  1. Go `http://localhost:3000/settings/routing` (or `/admin/routing`).
  2. Click `New Rule`, name `E2E RR West`, type Round-robin, priority 1, add members Rep A order1, Rep B order2, Rep C order3, all Available, fallback Admin, Save.
- Expected: Rule appears top of list, Active badge green, members in order, toast `Rule created`. `GET /api/routing/rules` contains it.

### TC02 – Create Manual Rule with Conditions (API)

- Steps: `POST /api/routing/rules` with manual payload above (companySize Enterprise).
- Expected: `201` with id, conditions persisted exactly, members single. Rule list sorted by priority.

### TC03 – Round-Robin Order Determinism (Core)

- Precondition: Fresh RR rule A->B->C, pointer reset (note `lastAssignedIndex` or create new rule).
- Steps: Create 6 leads matching rule via `POST /api/leads` with `region: West` or trigger condition, record `ownerId` each.
- Expected: Owners cycle A,B,C,A,B,C exactly in member order. 7th goes to A. No skip, no random. Log shows `ruleId` + `memberIndex`.

### TC04 – Pointer Persistence Across Restarts / Concurrent

- Steps: Create 3 leads, note pointer at C, create 2 more rapidly in parallel.
- Expected: 4th -> A, 5th -> B even under concurrency (atomic increment, no double-assign same member). No two leads assigned to same member when should alternate.

### TC05 – Manual Rule Priority Over Round-Robin

- Steps: Have Manual priority 0 (Enterprise) + RR priority 1 (West). Create lead matching both (Enterprise + West).
- Expected: Manual wins, assigned to Rep A (manual member), log `matchedRule: manual_id` with reason `priority 0`. Non-Enterprise West lead goes RR.

### TC06 – No Matching Rule -> Default / Unassigned

- Steps: Create lead matching no rule (e.g., region Antarctica, source Other).
- Expected: Assigned to default owner (creator or default queue) or left unassigned in fallback queue per spec. Log entry `no_rule_matched`. UI shows `Unassigned` badge.

### TC07 – Member Availability Toggle Skips Unavailable

- Steps: Set Rep B `isAvailable: false` via `PATCH /api/routing/rules/:id/members/repB`. Create 3 leads.
- Expected: Sequence A,C,A (B skipped). Member row shows gray `Unavailable`. Re-enable B resumes A,B,C order without resetting pointer incorrectly.

### TC08 – OOO Handling (Date-Bound Skip)

- Steps: Set Rep B OOO 2026-09-08 to 2026-09-15, create lead on 2026-09-08 (today).
- Expected: B skipped as unavailable with reason `OOO`. Log shows `skipped: ooo`. After OOO expiry (set past date), B eligible again. UI profile shows ✈️ OOO badge.

### TC09 – All Members Unavailable -> Fallback Queue

- Steps: Set all 3 members unavailable/OOO, create lead.
- Expected: Lead goes to fallbackUser (Admin) or `Fallback Queue` (unassigned + `fallback: true`). Banner `No available reps, queued`. Log `fallback_triggered`. No 500, no null owner crash.

### TC10 – Fallback Queue Claim / Reassign

- Steps: As Admin open fallback queue `http://localhost:3000/leads?queue=fallback`, claim lead to Rep A via `Assign` dropdown.
- Expected: Owner updates, queue count -1, log second entry `manual_reassign by admin`, notification to new owner <60s.

### TC11 – Member Order Reordering Effect

- Steps: Change order to C(1),A(2),B(3) via drag or number edit, reset pointer, create 3 leads.
- Expected: New order C,A,B respected. UI drag-drop persists after refresh. API `members[].order` updated.

### TC12 – Add / Remove Member Mid-Cycle

- Steps: Mid-cycle (pointer at B), remove B from rule, create 2 leads; then add Rep D, create 2 more.
- Expected: After removal sequence A,C,A (no hole, no error referencing deleted member). After add, D inserted per order and included within 1 cycle. Log never references removed member for new leads.

### TC13 – Rule Deactivate / Activate

- Steps: Deactivate RR rule (`isActive:false`), create lead matching it.
- Expected: Rule ignored, falls to next rule or fallback. Reactivate resumes pointer where left (or reset – document). List shows gray `Inactive`.

### TC14 – Assignment Log Completeness

- Steps: After TC03–TC09, open `GET /api/routing/log?leadId=` and UI `Lead detail -> Activity` + `Routing -> History`.
- Expected: Each auto-assignment has timestamp, leadId, ruleId/ruleName, assignedTo, skippedMembers with reasons, actor `system`, latency ms. Manual reassigns show human actor. Log immutable (no edit/delete).

### TC15 – 60-Second Notification SLA

- Steps: Create lead triggering RR, start timer, poll `GET /api/notifications?userId=assignedRep` and check bell icon + email stub.
- Expected: Notification appears <60s (typically <5s local). Contains lead name/company/link. `createdAt - leadCreatedAt < 60s`. Late = fail. Retry 3 leads to average.

### TC16 – Notification Content & Link

- Steps: Click bell notification for assigned lead.
- Expected: Deep-links to `http://localhost:3000/leads/:id`, marks read, shows correct owner name + rule name. Email stub (if enabled) has same link, no broken URL (`localhost:3001` vs `3000` confusion).

### TC17 – Bulk Import Routing Performance

- Steps: Import 20 leads matching RR via CSV/API bulk.
- Expected: All 20 assigned within 60s each, distribution ~7/7/6 for 3 members, no timeout, log has 20 entries, no duplicate pointer increment loss.

### TC18 – Permissions – Rep Cannot Edit Rules

- Steps: As Rep A open routing settings, try create/edit/deactivate rule; via API `POST /api/routing/rules` with Rep token.
- Expected: UI hides New/Edit or shows `Admin only`, API `403`. Rep can view own assignment log only, not full pointer state.

### TC19 – Validation – Empty Members, Duplicate Members, Bad Priority

- Steps: Try save rule with 0 members, duplicate Rep A twice, priority -1 or 9999, missing name.
- Expected: Inline errors + API `400` (`members min 1`, `duplicate member`, `priority 0-100`). No rule persisted. Existing rule untouched.

### TC20 – Race – Two Leads Same Millisecond

- Steps: Fire 2 `POST /api/leads` simultaneously (script with Promise.all) matching same RR.
- Expected: Different owners (A then B), not both A. Log indices distinct. No 500 deadlock.

### TC21 – Rule Deletion Cleanup (Bonus)

- Steps: Delete test RR rule while leads assigned via it exist.
- Expected: Existing leads keep owner, new leads fall through, log history retained (ruleName snapshotted, not null). Confirm dialog warns `N leads assigned via this rule`.

### TC22 – Audit & Timeline on Lead Detail (Bonus)

- Steps: Open lead assigned via routing, check Timeline.
- Expected: Entry `Auto-assigned to Rep B via E2E RR West (round-robin)` with timestamp + `View rule` link. Manual override adds second entry preserving first.

## 5. API Testing Section

| Method & Endpoint                              | Purpose                       | Expected                |
| ---------------------------------------------- | ----------------------------- | ----------------------- |
| `POST /api/routing/rules`                      | Create rule                   | 201 + rule JSON         |
| `GET /api/routing/rules`                       | List rules sorted             | 200 array by priority   |
| `PATCH /api/routing/rules/:id`                 | Update (members/order/active) | 200                     |
| `DELETE /api/routing/rules/:id`                | Delete                        | 204                     |
| `POST /api/leads` (trigger)                    | Trigger routing               | 201 with auto `ownerId` |
| `GET /api/routing/log?leadId=&limit=`          | Assignment log                | 200 entries             |
| `GET /api/notifications?userId=`               | Verify 60s notify             | 200 with recent         |
| `PATCH /api/routing/rules/:id/members/:userId` | Toggle availability           | 200                     |

```bash
# 1. Login as admin
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@test.com","password":"Admin123!"}'

# 2. List users to get ids
curl http://localhost:3001/api/users -H "Authorization: Bearer $ADMIN_TOKEN"

# 3. Create round-robin rule
curl -X POST http://localhost:3001/api/routing/rules \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{
    "name": "E2E RR West",
    "type": "round_robin",
    "isActive": true,
    "priority": 1,
    "conditions": {"region":"West"},
    "members": [
      {"userId":"REP_A_ID","order":1,"isAvailable":true},
      {"userId":"REP_B_ID","order":2,"isAvailable":true},
      {"userId":"REP_C_ID","order":3,"isAvailable":true}
    ],
    "fallbackUserId":"ADMIN_ID",
    "fallbackQueue": true
  }'

# 4. Trigger routing - create lead (repeat 6x, check ownerId cycles)
curl -X POST http://localhost:3001/api/leads \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"firstName":"Route","lastName":"Test1","email":"route.test1@test.com","company":"RouteCo","region":"West","source":"Web"}'

# 5. Check assignment log for lead
curl "http://localhost:3001/api/routing/log?leadId=LEAD_ID&limit=5" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# 6. Set Rep B unavailable
curl -X PATCH http://localhost:3001/api/routing/rules/RULE_ID/members/REP_B_ID \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"isAvailable": false}'

# 7. Check notifications for assigned rep (verify <60s)
curl "http://localhost:3001/api/notifications?userId=REP_A_ID&limit=5" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

- Measure SLA: compare `lead.createdAt` vs `notification.createdAt` diff <60s.
- Negative: `POST /api/routing/rules` with Rep token expect `403`.

## 6. UI Testing Section

- Routing settings page: table Name | Type badge (RR blue, Manual amber) | Priority | Members avatars in order | Active toggle | Actions. Search + filter Active/All.
- Rule editor modal: name input, type radio, priority number stepper, conditions builder (field/operator/value rows + Add), members list with order drag handle + availability switch + OOO badge, fallback selector, Save/Cancel.
- Leads list: Owner column updates within 3s of create without refresh (poll or socket); fallback queue view `?queue=fallback` shows Queued badge.
- Lead detail: Activity shows auto-assign entry with rule link; Owner field shows `Auto (RR)` tooltip.
- Bell: badge count +1 within 60s, dropdown shows lead link, mark-read works, empty state `No new assignments`.
- Toggles: availability switch immediate + toast, OOO datepicker blocks past From, shows return date.
- Responsive: members list stacks on tablet, drag still works via up/down buttons as fallback.
- A11y: switches labelled, drag handles keyboard movable (arrow keys), log table headers announced.

## 7. Regression & Cross-Feature Impact

- Lead CRUD: manual owner selection overridden by routing – verify documented precedence (routing wins on create, manual wins on edit).
- Conversion: converted lead owner propagates to Account/Contact/Deal, routing not re-fired on conversion.
- Web-to-Lead: public captures also route – verify spam-blocked leads do not route or notify.
- Territories: territory owner suggestion vs routing assignment – which wins? Verify precedence logged (e.g., territory suggests, routing assigns, mismatch flagged).
- Dashboard: assignment distribution chart matches log counts; fallback queue count widget updates.
- Permissions: demoting assigned rep does not unassign existing leads, only future routing skips them.
- Delete user: removing Rep B from system removes from all rules or marks `Deactivated user` – no dangling ownerId.

## 8. Expected Results Summary Table

| TC   | Title                | Expected             | Pass Criteria          |
| ---- | -------------------- | -------------------- | ---------------------- |
| TC01 | Create RR UI         | 201 + list           | Members ordered        |
| TC02 | Manual API           | 201                  | Conditions exact       |
| TC03 | RR order A,B,C x2    | Cycle exact          | Log indices sequential |
| TC04 | Pointer persist      | A,B after C          | No double-assign       |
| TC05 | Priority manual wins | Rep A                | Logged priority        |
| TC06 | No match fallback    | Queued/default       | Log no_match           |
| TC07 | Skip unavailable     | A,C,A                | Gray badge             |
| TC08 | OOO skip             | Skipped ooo          | Badge ✈️               |
| TC09 | All OOO fallback     | Admin/queue          | Banner + log           |
| TC10 | Claim fallback       | Owner updates        | 2nd log entry          |
| TC11 | Reorder              | C,A,B                | Persists refresh       |
| TC12 | Add/remove mid       | No hole              | No dangling ref        |
| TC13 | Deactivate           | Ignored              | Gray badge             |
| TC14 | Log complete         | All fields           | Immutable              |
| TC15 | 60s notify           | <60s                 | Link works             |
| TC16 | Notify link          | Deep-link            | Mark read              |
| TC17 | Bulk 20              | ~7/7/6               | No timeout             |
| TC18 | Rep 403              | Hidden/disabled      | Own log only           |
| TC19 | Validation           | Inline +400          | No persist             |
| TC20 | Race distinct        | A then B             | No deadlock            |
| TC21 | Delete cleanup       | History kept         | Warn dialog            |
| TC22 | Timeline entry       | Auto-assigned + link | Both entries kept      |

## 9. Troubleshooting & Common Failures

- Routing not firing (owner = creator): rule `isActive:false` or condition mismatch (case `West` vs `west`) – check `GET /api/routing/rules` active + conditions exact; verify lead field `region` actually saved.
- Always assigns to same member: pointer not incrementing (DB update failed) – check `lastAssignedIndex` after each create; look for transaction error; reset rule by recreating.
- OOO member still assigned: OOO dates in future/past wrong timezone (UTC vs IST) – verify `ooo.from/to` ISO dates include timezone; server uses UTC.
- Fallback never triggers: `fallbackQueue:false` and `fallbackUserId` null – set both; check all members truly unavailable (one left available).
- Notification >60s or never: worker/queue down – check API logs for `notification job`, verify `GET /api/notifications` has entry but bell not polling (websocket vs 30s poll); email stub file permissions.
- Log empty: query wrong `leadId` (uses `_id` vs `id`) – copy id from create response; try `?limit=50` without filter.
- `403` as Admin on rules: token is Rep token – re-login admin; check `Authorization: Bearer` spacing.
- Bulk import only first N routed: rate limiter (e.g., 10/min) – check `429` responses, add delay 500ms between creates in script.
- Member order not saved after drag: frontend sends `order` 0-indexed but backend expects 1-indexed – inspect PATCH payload, verify refresh shows same order.
- Deleted user still in rule: cascade missing – manually `PATCH` remove member, report as bug with rule id.

## 10. Pass/Fail Checklist

- [ ] TC01–TC02 RR + manual rules created via UI + API with correct members/conditions
- [ ] TC03–TC04 round-robin cycles A,B,C deterministically including parallel creates
- [ ] TC05 manual priority overrides RR and is logged
- [ ] TC06 no-match goes to fallback/default with log entry
- [ ] TC07–TC08 unavailable/OOO members skipped with reason
- [ ] TC09 all-unavailable triggers fallback queue + banner, no 500
- [ ] TC10 fallback claim reassigns + logs + notifies
- [ ] TC11 reorder persists and takes effect within one cycle
- [ ] TC12 add/remove mid-cycle causes no holes or dangling refs
- [ ] TC13 deactivate ignores rule, reactivate resumes correctly
- [ ] TC14 log has timestamp/rule/member/skipped/actor/latency and is immutable
- [ ] TC15–TC16 notifications arrive <60s with working deep-link (bell + email stub)
- [ ] TC17 bulk 20 distributes evenly without timeout
- [ ] TC18 Rep/Viewer blocked from rule config (403 + hidden UI)
- [ ] TC19 validations block 0 members/duplicates/bad priority (400)
- [ ] TC20 race creates distinct owners without deadlock
- [ ] TC21 delete retains history + warns, existing owners kept
- [ ] TC22 lead timeline shows auto-assign + override entries
- [ ] All 7 curl groups executed, SLA diffs recorded
- [ ] Regression: CRUD precedence, conversion, web-to-lead, territories, dashboard intact
- [ ] Cleanup: test rules deleted, OOO reset, config restored
- Tester: _______________ Date: _______________ Rule IDs: _______________ Result: PASS / FAIL
