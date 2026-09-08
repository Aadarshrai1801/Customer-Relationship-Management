# Workflows & Automation – Comprehensive Testing Guide

Base URLs: API `http://localhost:3001`, Web `http://localhost:3000`.

## 1. Overview

This guide covers Visual Workflows: trigger → condition → action builder, execution log, and loop protection (`maxRuns: 5`).
Scope includes workflow CRUD, trigger types (record created/updated, stage changed, activity due, inbound webhook, schedule), condition logic (AND/OR, field operators), actions (update field, assign owner, create task, send email/notification, webhook out, add tag), test-run/dry-run, enable/disable, versioning, execution history with input/output, retry, and loop guard.
Out of scope is external integration correctness beyond webhook delivery, but payload shape is checked.
Key roles: Admin (all workflows), Manager (team-scoped where enforced), Rep (own workflows or read-only per policy).
Critical rules: visual graph must match saved JSON (`trigger→condition→action`); each run logged with status; runaway recursion stopped after 5 runs per chain (`maxRuns 5`); disabled workflows never fire.
Success criteria: builder saves valid JSON, triggers fire exactly once per event, conditions filter correctly, actions execute, log shows evidence, and loops halt at 5.

## 2. Prerequisites & Test Data Setup

- Stack: Web `:3000`, API `:3001`, worker/queue for workflow execution running; mail catcher for email actions.
- Users/tokens: admin, manager, rep1; save JWTs.
- Baseline data: pipeline with stages for `deal.stageChanged` tests; task statuses; tag list.
- Test workflows (prefix `QA-`):
  - `QA-Stage→Task`: trigger deal stage → Negotiation, no condition, action create task.
  - `QA-Amount-Guard`: trigger deal updated, condition `amount > 10000`, action assign manager + notify.
  - `QA-Loop`: trigger deal updated, action update same deal (to test maxRuns 5) – keep DISABLED except loop test on isolated record.
  - `QA-Webhook-Out`: trigger contact created, action POST to `https://webhook.site` or local catcher.
- Tools: webhook catcher URL (webhook.site / local `nc -l` / Beeceptor) to assert outbound calls.
- Time: note execution latency budget (<10s for sync actions, <60s for queued).
- Cleanup: disable/delete QA workflows after run; archive execution logs IDs for evidence.
- Safety: never enable `QA-Loop` on production org; use dedicated test deal `DEAL-LOOP`.

## 3. Test Environment Matrix

| Dimension      | Variants                                                                                      |
| -------------- | --------------------------------------------------------------------------------------------- |
| Browser        | Chrome 130+, Firefox 132+                                                                     |
| Trigger        | Deal created/updated, Stage changed, Task created, Contact created, Schedule, Inbound webhook |
| Condition      | None, Single, AND, OR, Nested, Invalid                                                        |
| Action         | Update field, Create task, Assign, Send email, Notify, Webhook, Add tag                       |
| State          | Enabled, Disabled, Draft                                                                      |
| Load           | Single event, Bulk 50 events, Recursive loop                                                  |
| Client         | Visual builder, curl API                                                                      |
| Theme/viewport | Light/Dark, 1440px/768px (canvas usable)                                                      |

- Record workflow IDs, run IDs, event IDs, catcher request IDs.
- Test both builder-saved and API-created workflows for parity.
- Verify execution log pagination with 100+ runs.

## 4. Detailed Step-by-Step Test Cases (at least 18 numbered TC cases)

### TC-01 – Create Workflow via Visual Builder (Trigger→Condition→Action)

- **Objective:** Verify builder saves correct JSON.
- **Preconditions:** Logged in as admin; Workflows page open.
- **Steps:**
  1. Go to `http://localhost:3000/workflows` → New.
  2. Name `QA-Stage→Task`; Trigger = Deal Stage Changed → Negotiation.
  3. Add Condition none (or Amount exists); Action = Create Task `Follow up [QA]`.
  4. Save; verify toast + appears in list as Disabled/Draft.
  5. Open JSON view (if present) or `GET /api/workflows/:id`; verify `trigger, conditions, actions` shape.
- **Expected:** Saved; JSON has trigger→condition→action chain.

### TC-02 – Enable / Disable Workflow

- **Objective:** Verify only enabled fire.
- **Preconditions:** `QA-Stage→Task` disabled.
- **Steps:**
  1. Move test deal to Negotiation; verify NO task created and NO run logged.
  2. Enable workflow.
  3. Move another deal to Negotiation; verify task created + run logged Success.
  4. Disable again; verify next stage change does not fire.
- **Expected:** Disabled never fires; enable immediate (or <30s propagation – document).

### TC-03 – Condition Filtering (Amount > 10000)

- **Objective:** Verify conditions gate actions.
- **Preconditions:** `QA-Amount-Guard` enabled.
- **Steps:**
  1. Update deal amount to 5000; verify run logged as `Skipped/Condition false`, no assign.
  2. Update to 15000; verify run Success + owner assigned + notification.
  3. Check run detail shows evaluated `amount=15000 > 10000 true`.
- **Expected:** True/false paths logged distinctly.

### TC-04 – AND / OR Logic

- **Objective:** Verify compound conditions.
- **Preconditions:** Builder supports AND/OR.
- **Steps:**
  1. Set `(Stage=Proposal AND Amount>5000) OR Tag=VIP`.
  2. Fire case A (both true) → expect action.
  3. Fire case B (only Tag VIP) → expect action (OR).
  4. Fire case C (none) → expect skip.
- **Expected:** Truth table correct; log shows branch evaluation.

### TC-05 – Update-Field Action

- **Objective:** Verify field-write actions.
- **Preconditions:** Workflow `on Deal Created → set Priority=High`.
- **Steps:**
  1. Create deal with Priority Low.
  2. Wait; reload deal; verify Priority High.
  3. Verify run log input/output shows before/after.
- **Expected:** Write applied; logged.

### TC-06 – Create-Task Action Payload

- **Objective:** Verify dynamic task creation.
- **Preconditions:** `QA-Stage→Task` enabled.
- **Steps:**
  1. Move deal to Negotiation.
  2. Verify task created with `relatedDealId` correct, assignee per mapping, due date templated (e.g., +2d).
  3. Verify task links back to deal.
- **Expected:** Correct linkage; templating resolved (no `{{deal.id}}` literal).

### TC-07 – Send Email / Notify Action

- **Objective:** Verify comms actions respect prefs.
- **Preconditions:** Mail catcher; rep2 prefs allow.
- **Steps:**
  1. Trigger workflow with Send Email to Owner.
  2. Verify email in catcher with subject/body templated (deal name resolved).
  3. Verify in-app notification for Notify action.
- **Expected:** One email + one bell; templates resolved.

### TC-08 – Outbound Webhook Action

- **Objective:** Verify POST with signed JSON.
- **Preconditions:** Catcher URL in action.
- **Steps:**
  1. Trigger contact-created workflow.
  2. Verify catcher receives POST within 30s with `event, record` JSON.
  3. Verify headers include signature/content-type if spec'd.
  4. Verify run log records HTTP status.
- **Expected:** Delivered; 2xx logged; retries on 5xx per policy.

### TC-09 – Test-Run / Dry-Run

- **Objective:** Verify dry-run previews without side effects.
- **Preconditions:** Workflow draft.
- **Steps:**
  1. Click Test/Dry-run with sample record.
  2. Verify preview shows `would create task / would send email` without actually creating.
  3. Verify no run counted as live (or marked `test:true`).
- **Expected:** No side effects; preview accurate. If unsupported, record N/A.

### TC-10 – Execution Log Completeness

- **Objective:** Verify every trigger attempt logged.
- **Preconditions:** Several fires + one skip + one failure.
- **Steps:**
  1. Open workflow → Runs/History.
  2. Verify columns: time, event, status (Success/Skipped/Failed), duration, actor.
  3. Open run detail; verify trigger payload, condition eval, action request/response.
  4. Verify pagination/filter by status works.
- **Expected:** Full evidence; no missing runs.

### TC-11 – Failure Handling & Retry

- **Objective:** Verify failed actions retry or surface.
- **Preconditions:** Webhook URL set to `http://localhost:9/invalid` (refused).
- **Steps:**
  1. Trigger; verify run Failed with error `ECONNREFUSED`.
  2. Click Retry; verify second attempt logged.
  3. Fix URL to valid catcher; Retry again; verify Success.
- **Expected:** Error visible; manual retry works; auto-retry per policy documented.

### TC-12 – Loop Protection maxRuns 5

- **Objective:** Verify recursion halts after 5 runs.
- **Preconditions:** `QA-Loop` (on deal updated → update same deal +1 counter) on isolated `DEAL-LOOP`, enabled only for test.
- **Steps:**
  1. Enable loop workflow.
  2. Update `DEAL-LOOP` once (e.g., description `loop-start`).
  3. Wait 60s; inspect runs for chain: count runs with same `chainId/rootEvent`.
  4. Verify ≤5 runs total, last marked `Stopped: maxRuns 5 / loop detected`.
  5. Disable immediately.
- **Expected:** Halts at 5; no infinite queue; deal not corrupted.

### TC-13 – Bulk Events (50 Rapid Fires)

- **Objective:** Verify no drops/duplicates under bulk.
- **Preconditions:** Script to create 50 contacts quickly.
- **Steps:**
  1. Enable `QA-Webhook-Out` (contact created).
  2. Bulk-create 50 contacts via API loop.
  3. Verify 50 runs logged (or 50 minus deduped per spec) and catcher got 50 POSTs.
  4. Check queue lag <2min.
- **Expected:** Exactly-once per event (or documented at-least-once with idempotency keys).

### TC-14 – Disabled Mid-Queue & Versioning

- **Objective:** Verify disable stops pending and edits version safely.
- **Preconditions:** Workflow with queued delayed action (if delay supported).
- **Steps:**
  1. Trigger then immediately Disable before worker picks up.
  2. Verify pending run cancelled or marked `Cancelled` (document).
  3. Edit actions; save; verify version increments and old runs still show old definition snapshot.
- **Expected:** No surprise fires after disable; history immutable.

### TC-15 – Permissions: Non-Admin Cannot Create Org-Wide

- **Objective:** Verify RBAC on builder + API.
- **Preconditions:** rep1 token.
- **Steps:**
  1. As rep1 open `/workflows`; verify Create hidden or scoped to Own only per spec.
  2. `POST /api/workflows` as rep1 with org-wide trigger → expect 403 if restricted.
  3. As admin same payload → 201.
- **Expected:** 403 for unauthorized; UI hides accordingly.

### TC-16 – Invalid Graph Validation

- **Objective:** Verify builder/API reject bad graphs.
- **Preconditions:** Valid token.
- **Steps:**
  1. Save workflow with no trigger → expect inline `Trigger required`.
  2. Action with missing required field (e.g., email to empty) → 400.
  3. Condition referencing unknown field `foo.bar` → 400 with `unknownField`.
- **Expected:** Clear field-level errors; no 500.

### TC-17 – Schedule Trigger (if supported)

- **Objective:** Verify cron/schedule fires.
- **Preconditions:** Schedule every 5 min or manual trigger button.
- **Steps:**
  1. Create schedule workflow (e.g., daily open-task digest).
  2. Trigger manually / wait window.
  3. Verify run at expected time ±2min with correct scoped data.
- **Expected:** On-time; timezone documented (UTC vs org TZ). If unsupported, N/A.

### TC-18 – Builder UX: Canvas, Zoom, Responsive

- **Objective:** Verify canvas usable.
- **Preconditions:** Workflow with 5+ nodes.
- **Steps:**
  1. Drag nodes; verify snap + edge reconnect.
  2. Zoom in/out + minimap (if present); verify labels legible.
  3. At 768px verify canvas scrolls, properties panel docks.
  4. Dark mode: edges/nodes contrast OK.
- **Expected:** No lost edges on save; pan/zoom smooth.

### TC-19 – Audit & Deletion

- **Objective:** Verify audit and safe delete.
- **Preconditions:** QA workflow with runs.
- **Steps:**
  1. Delete/disable QA workflow (confirm modal).
  2. Verify list removes, runs retained read-only (or purged per retention – document).
  3. Verify audit log entry `workflow.deleted by admin at T`.
- **Expected:** No orphan active triggers after delete.

## 5. API Testing Section

| Method & Endpoint                           | Purpose             | Auth           | Notes                           |
| ------------------------------------------- | ------------------- | -------------- | ------------------------------- |
| `GET /api/workflows`                        | List                | Bearer         | Filter `enabled=true`           |
| `POST /api/workflows`                       | Create graph        | Bearer (admin) | Body trigger/conditions/actions |
| `GET /api/workflows/:id`                    | Get definition      | Bearer         | Verify JSON                     |
| `PATCH /api/workflows/:id`                  | Enable/disable/edit | Bearer         | `{enabled:false}`               |
| `GET /api/workflows/:id/runs?status=failed` | Execution log       | Bearer         | Assert maxRuns chain            |
| `POST /api/workflows/:id/test`              | Dry-run             | Bearer         | No side effects                 |
| `DELETE /api/workflows/:id`                 | Delete              | Bearer         | Confirm cascade                 |

```bash
# 1) Login admin
curl -s -X POST http://localhost:3001/api/auth/login -H "Content-Type: application/json" \
  -d '{"email":"admin@test.com","password":"Admin123!"}'
# -> $ADMIN_TOKEN

# 2) List
curl -s http://localhost:3001/api/workflows -H "Authorization: Bearer $ADMIN_TOKEN" | python3 -m json.tool

# 3) Create stage->task workflow
curl -s -X POST http://localhost:3001/api/workflows \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"QA-API-StageTask","enabled":true,"trigger":{"type":"deal.stageChanged","to":"Negotiation"},"conditions":[],"actions":[{"type":"createTask","title":"Follow up [QA api]","assignee":"{{deal.ownerId}}"}]}' | python3 -m json.tool

# 4) Get runs (check loop chain)
curl -s "http://localhost:3001/api/workflows/WF_ID/runs?limit=20" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | python3 -m json.tool

# 5) Disable loop workflow immediately after test
curl -s -X PATCH http://localhost:3001/api/workflows/WF_ID \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"enabled":false}' | python3 -m json.tool

# 6) Dry-run
curl -s -X POST http://localhost:3001/api/workflows/WF_ID/test \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"sampleRecordId":"DEAL_ID"}' | python3 -m json.tool
```

- Assert: creation echoes graph; trigger fires within SLA; loop chain `count<=5` and final `reason=maxRuns`; dry-run creates nothing (verify via list before/after).
- Negative: no trigger → 400; rep create org-wide → 403; bad action → 400.

## 6. UI Testing Section

- List: table/cards with Name, Trigger summary, Last run status/time, Enabled toggle, Run count; search + filter by status.
- Builder: left palette (triggers/conditions/actions), canvas with nodes/edges, right properties panel with field pickers + templating hints (`{{deal.amount}}`), validation inline.
- Toggle: immediate with toast `Workflow enabled`; disabled greys canvas.
- Runs: timeline with status pills (green Success, amber Skipped, red Failed), duration, expandable JSON (copy button), Retry button on failures.
- Skeletons/empty: `No workflows yet – Create` illustration; loading shimmer.
- Responsive/a11y: keyboard can add nodes (palette buttons), edges labeled, focus visible, axe clean; canvas keyboard alternative (list view) if DnD inaccessible.

## 7. Regression & Cross-Feature Impact

- Deals/Tasks/Contacts: workflow writes must appear in record timelines and reports after refresh.
- Notifications/Email: workflow-sent messages honor preference center and include unsubscribe where required.
- Webhooks: outbound must not leak PII beyond mapping; secrets redacted in logs.
- Imports: bulk import must trigger per-record workflows without OOM; verify throttling.
- Permissions: sharing change must alter which records workflows can touch (no privilege escalation via workflow).
- Billing: workflow run quotas (if plan-gated) enforced with `quota exceeded` status.
- Audit: all auto-writes attributed to `workflow:<id>` actor, not impersonating user silently.

## 8. Expected Results Summary Table

| TC    | Title            | Expected             | Severity |
| ----- | ---------------- | -------------------- | -------- |
| TC-01 | Builder create   | Valid JSON saved     | Critical |
| TC-02 | Enable/disable   | Only enabled fires   | Critical |
| TC-03 | Condition gate   | True→act, false→skip | Critical |
| TC-04 | AND/OR           | Truth table          | Major    |
| TC-05 | Update field     | Applied + logged     | Major    |
| TC-06 | Create task      | Linked + templated   | Major    |
| TC-07 | Email/notify     | 1 each, templated    | Major    |
| TC-08 | Webhook out      | POST + 2xx logged    | Major    |
| TC-09 | Dry-run          | No side effects      | Minor    |
| TC-10 | Log completeness | Full evidence        | Major    |
| TC-11 | Retry            | Recovers             | Major    |
| TC-12 | maxRuns 5        | Halts at 5           | Critical |
| TC-13 | Bulk 50          | Exactly-once         | Major    |
| TC-14 | Disable/version  | No surprise fires    | Major    |
| TC-15 | RBAC             | 403 non-admin        | Major    |
| TC-16 | Invalid graph    | 400 inline           | Minor    |
| TC-17 | Schedule         | On-time or N/A       | Minor    |
| TC-18 | Canvas UX        | Usable + responsive  | Minor    |
| TC-19 | Audit/delete     | Safe, logged         | Minor    |

## 9. Troubleshooting & Common Failures

| Symptom                    | Cause                                                     | Fix                                                          |
| -------------------------- | --------------------------------------------------------- | ------------------------------------------------------------ |
| Workflow never fires       | Disabled; trigger mismatch (stage name case); worker down | Check enabled, trigger payload case, worker logs/queue depth |
| Fires twice                | Double registration; retry + non-idempotent action        | Check runs for duplicate eventId; add idempotency key        |
| Condition always false     | Type mismatch (`"10000"` vs `10000`); null field          | Inspect run eval; coerce types; handle null                  |
| Template literal in output | `{{deal.id}}` not resolved (wrong path)                   | Check field picker paths; view run input echo                |
| Loop never stops           | maxRuns not enforced / chainId missing                    | Kill/disable; check `chainId` propagation; file critical     |
| Webhook 401/404            | Wrong URL/secret                                          | Verify catcher URL; check run response body                  |
| Bulk OOM/slow              | No batching; N+1                                          | Throttle import; check worker memory; paginate               |
| Dry-run side effects       | Test flag ignored                                         | File bug; verify `test:true` filtering in worker             |

- Debug: `GET /runs?eventId=X`, worker logs, catcher request inspector, record timeline cross-check.
- Safety: keep `QA-Loop` disabled; have kill-switch (disable all QA via script) ready.

## 10. Pass/Fail Checklist

- [ ] Builder creates valid trigger→condition→action; JSON verified.
- [ ] Enable/disable semantics proven (disabled never fires).
- [ ] Conditions (single + AND/OR) gate correctly with logged eval.
- [ ] All action types (update/create/notify/email/webhook) executed with templating.
- [ ] Dry-run has no side effects (or N/A documented).
- [ ] Execution log complete with input/output + retry working.
- [ ] Loop halts at maxRuns 5 with explicit reason; disabled right after.
- [ ] Bulk 50 exactly-once; schedule on-time (or N/A).
- [ ] RBAC + validation negatives return 403/400.
- [ ] API curls all pass; evidence (run IDs, catcher payloads, screenshots) attached.
- [ ] QA workflows cleaned up; audit entries verified.
