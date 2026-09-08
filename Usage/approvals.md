# Approvals – Comprehensive Testing Guide

## 1. Overview

This guide covers Generic Approval Requests with approve/reject flows, exemplified by high-discount Quote approval.
Scope includes approval CRUD (requestor, type, entity link e.g., quoteId/dealId, reason, discount %, status), thresholds (e.g., discount >20% requires approval), submit/for-review, approve/reject with comments, cancellation, escalation/reassign, status gating (blocked Send/close until Approved), notifications, permissions (requestor vs approver Admin/Manager), audit timeline, bulk queue.
Base URLs:

- API: `http://localhost:3001`
- Web: `http://localhost:3000`
  Example approval:

```json
{
  "type": "quote_discount",
  "entityType": "quote",
  "entityId": "QUOTE_ID",
  "requestedBy": "repA_id",
  "discountPct": 30,
  "reason": "Strategic logo, commit 3yr",
  "status": "Pending"
}
```

Lifecycle: Draft -> Pending -> Approved | Rejected | Cancelled (+ Expired if stale). Approved unlocks Send/close; Rejected blocks with reason.
Success criteria: threshold enforced, double-approve idempotent, rejected blocks gated action with clear message, every transition logged + notified <60s, non-approver cannot approve.

## 2. Prerequisites & Test Data Setup

- Roles: Rep A (requestor), Manager/Admin (approver), Rep B (non-approver), Viewer.
- Get ids: `GET /api/users` record manager/admin id.
- Deals + Quotes: `E2EDeal_Appr` with lines; quotes:
  - `Q-High30` discount 30% (requires approval)
  - `Q-Low10` discount 10% (no approval)
  - `Q-Edge20` discount exactly 20% (boundary)
- Threshold assumption: `>20%` requires approval – confirm via `GET /api/approvals/config` or UI `Settings -> Approvals`; adjust TCs if 15% or 25%.
- Approval endpoints discovery: `POST /api/approvals`, `GET /api/approvals?status=Pending`, `POST /api/approvals/:id/approve`, `.../reject`, `.../cancel`. If nested `POST /api/quotes/:id/approval-request`, note both.
- Clean slate: `GET /api/approvals?entityId=Q-High30` should be 0; cancel stale Pendings as Admin.
- Notification check: `GET /api/notifications?userId=manager` + bell.
- Cleanup: approve/reject all test Pendings, delete test quotes/deals.

## 3. Test Environment Matrix

| Dimension    | Variants                                                                            |
| ------------ | ----------------------------------------------------------------------------------- |
| API          | `http://localhost:3001`                                                             |
| Web          | `http://localhost:3000`                                                             |
| Browsers     | Chrome, Firefox                                                                     |
| Roles        | Requestor Rep, Approver Manager/Admin, Non-approver Rep, Viewer, Anon               |
| Discount     | 10% (no gate), 20% (boundary), 21%/30% (gate), 100% (extreme)                       |
| Entity       | Quote discount (primary), Deal close w/o lines (if supported), Generic (other type) |
| Status       | Pending, Approved, Rejected, Cancelled, Expired                                     |
| Notification | In-app + email stub, <60s SLA                                                       |

- Record threshold value used; if configurable, test changing 20%->15% and revert.

## 4. Detailed Step-by-Step Test Cases

### TC01 – High-Discount Quote Auto-Requires Approval (UI)

- Steps as Rep A: Create quote `Q-High30` with line discount 30%, Save, click Send.
- Expected: Blocked modal `Approval required (discount 30% > 20%) [Request Approval]` + banner `Pending Approval` on quote. `GET /api/quotes/:id` shows `approvalStatus: Required/Pending` (not Sent). No email sent yet.

### TC02 – Low-Discount No Approval Needed

- Steps: Create `Q-Low10` 10%, Send.
- Expected: Sends immediately to Sent, no approval record created (`GET /api/approvals?entityId=` 0), token shareable. No banner.

### TC03 – Boundary 20% Exactly

- Steps: Create `Q-Edge20` 20% exactly, try Send.
- Expected: Per spec `>20%` => 20% allowed without approval (or `>=20%` => requires – document which). Verify and lock expectation after first run. No ambiguity left.

### TC04 – Submit Approval Request Happy Path (UI + API)

- Steps: On `Q-High30` click `Request Approval`, fill Reason `Strategic logo`, confirm. API alt `POST /api/approvals { type: quote_discount, entityId, discountPct:30, reason }`.
- Expected: `201` Pending with id, quote `approvalStatus: Pending`, toast, timeline `Approval requested by RepA`, approver notified <60s. Duplicate Request while Pending blocked (see TC09).

### TC05 – Approval Queue Visibility (Approver vs Requestor)

- Steps: As Manager open `http://localhost:3000/approvals?status=Pending`; as Rep A open same; as Rep B open.
- Expected: Manager sees all Pendings with Approve/Reject buttons; Rep A sees own requests (status only, no action buttons); Rep B sees none (or read-only without actions); Viewer none. API `GET /api/approvals` filters by role (403 for cross-team if scoped).

### TC06 – Approve Happy Path (UI)

- Steps as Manager: Open `Q-High30` approval, review discount/lines/reason, add Comment `Approved for 3yr commit`, click Approve.
- Expected: Status Approved + `decidedBy/decidedAt/comment`, quote `approvalStatus: Approved` unlocks Send (banner green `Approved – ready to send`), requestor notified <60s, timeline both sides. `POST .../approve` second time `409` (see TC10).

### TC07 – Approve via API + Send Unlock

- Steps: `POST /api/approvals/:id/approve { comment }` as Manager, then as Rep `POST /api/quotes/:id/send`.
- Expected: Approve `200`, Send now `200 Sent` (previously `422 approval required`). Public share works post-approval. Verify order matters – Send before Approve still `422`.

### TC08 – Reject with Reason Required (UI + API)

- Steps: Create second high quote `Q-High25` 25%, request, as Manager Reject without comment -> blocked, then with `Too high, cap 20%` -> succeeds.
- Expected: Empty comment blocked inline + API `400 comment required for reject`. With comment `200 Rejected`, quote stays `Rejected` blocks Send (`422 approval rejected`), requestor notified with reason, timeline shows rejection.

### TC09 – Duplicate Request While Pending Blocked

- Steps: On Pending `Q-High30` click Request again; API double POST.
- Expected: Button hidden/disabled `Already pending`, API `409 already pending` with existing id, no second record. List shows single Pending per entity (unless versioned – document).

### TC10 – Double Approve / Race Idempotency

- Steps: Double-click Approve, or two parallel `POST .../approve` different managers.
- Expected: First `200`, second `409 already decided`, single timeline entry, single notification to requestor (no duplicate Send unlock). Button disables + spinner.

### TC11 – Cancel Pending by Requestor

- Steps: As Rep A Cancel `Q-High25` Pending with confirm.
- Expected: Status Cancelled, quote `approvalStatus: Cancelled/Required` (Send still blocked until new request), approver notified `Withdrawn`, Manager queue removes it. Non-requestor Cancel `403`.

### TC12 – Re-request After Reject/Cancel

- Steps: On Rejected `Q-High25` reduce discount to 18% OR keep 25% with better reason, Request again.
- Expected: New Pending (v2) created linked to same quote (history shows v1 Rejected + v2 Pending), Send still blocked until v2 Approved. Version chain auditable.

### TC13 – Gated Action Error Messages (Send/Accept/Close)

- Steps: Try Send Pending quote, Share token for Pending, Accept public link for Pending, Close deal Won with Pending quote.
- Expected: Each blocked with specific `403/422 approval pending` + UI banner + `View approval` link (not generic 500). After Approve all succeed. Document which actions gate (Send only vs Share+Accept).

### TC14 – Permissions – Non-Approver Cannot Decide

- Steps: As Rep B (non-approver) `POST .../approve` + click Approve (if visible via URL hack); as Viewer try; anon try.
- Expected: UI hides buttons, API `403 approver only`. No status change, audit logs denied attempt if instrumented. Requestor cannot self-approve own request (`403 cannot approve own` or allowed if Manager+requestor same – document).

### TC15 – Self-Approval Guard

- Steps: As Manager create high quote own + request + try approve own.
- Expected: Blocked `Cannot approve own request` + requires second approver (or allowed with warn – document). Enforces SoD. Verify with two managers if available.

### TC16 – Escalation / Reassign Approver

- Steps: As Manager Reassign Pending to Admin (or Escalate after 24h stale).
- Expected: `assignee` updates, new assignee notified <60s, old loses action buttons, timeline `Reassigned Manager->Admin by …`. API `PATCH /api/approvals/:id { assigneeId }` or `.../reassign`.

### TC17 – Expiry / SLA Breach Flag

- Steps: Create Pending with `dueAt: yesterday` (or backdate `createdAt` 7d ago if allowed).
- Expected: Queue shows `Overdue 6d` red, digest/email to approver, auto-escalate if configured (or stays Pending – document). Metrics `avg decision time` excludes cancelled.

### TC18 – Bulk Approve / Filter Queue

- Steps: Create 5 Pendings, filter `type=quote_discount + requestor=RepA`, sort oldest first, bulk Approve 3 (if supported).
- Expected: Filters AND, bulk shows count + progress + per-item errors, timelines for each, notifications batched. No partial silent fail.

### TC19 – Generic Approval Type (Non-Quote)

- Steps: If generic supported, `POST /api/approvals { type: deal_exception, entityType: deal, entityId, reason: Close without lines }`.
- Expected: `201` Pending, appears in same queue with type badge, approve/reject same flow, gated deal action unblocked. If quote-only, document `400 unsupported type`.

### TC20 – Audit Timeline Completeness

- Steps: Request -> Reassign -> Approve -> Send on `Q-High30`. Check `GET /api/approvals/:id/timeline` + quote timeline + deal timeline.
- Expected: All steps with actor/timestamp/comment/diff, immutable, public quote page does NOT leak approver internal comments marked `internal:true` (only `shared` notes visible).

### TC21 – Notification SLA <60s (Bonus)

- Steps: Time Request->Manager bell, Approve->Rep bell, Reject->Rep bell.
- Expected: Each <60s (local <5s), content has entity link `http://localhost:3000/quotes/:id`, mark-read works. Email stub same link, no `localhost:3001` confusion.

### TC22 – Threshold Config Change (Bonus)

- Steps as Admin: Change threshold 20%->15% in `Settings -> Approvals`, try Send 18% quote (now requires), revert to 20%.
- Expected: New threshold enforced immediately for new Sends (existing Approved unaffected), audit `threshold 20->15 by Admin`, revert restores. No retroactive block of already-Sent.

## 5. API Testing Section

| Method & Endpoint                             | Purpose                                              | Expected                                         |
| --------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------ |
| `POST /api/approvals`                         | Request (or `POST /api/quotes/:id/approval-request`) | 201 Pending, 409 already pending, 400 validation |
| `GET /api/approvals?status=Pending&entityId=` | Queue/filter                                         | 200 role-scoped                                  |
| `GET /api/approvals/:id`                      | Detail + timeline                                    | 200                                              |
| `POST /api/approvals/:id/approve`             | Approve                                              | 200 Approved, 403 non-approver, 409 decided      |
| `POST /api/approvals/:id/reject`              | Reject (comment req)                                 | 200, 400 no comment                              |
| `POST /api/approvals/:id/cancel`              | Cancel by requestor                                  | 200 Cancelled, 403 others                        |
| `POST /api/quotes/:id/send`                   | Gated Send                                           | 422 pending/rejected, 200 after approved         |
| `GET /api/approvals/config`                   | Threshold                                            | 200 `{ discountThresholdPct: 20 }`               |

```bash
# 1. Login rep + manager
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"rep.a@test.com","password":"Rep123!"}'
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"manager@test.com","password":"Manager123!"}'

# 2. Request approval for high-discount quote (30%)
curl -X POST http://localhost:3001/api/approvals \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $REP_TOKEN" \
  -d '{
    "type": "quote_discount",
    "entityType": "quote",
    "entityId": "QUOTE_HIGH_ID",
    "discountPct": 30,
    "reason": "Strategic logo, 3yr commit"
  }'

# 3. Try Send while Pending (expect 422 approval required)
curl -X POST http://localhost:3001/api/quotes/QUOTE_HIGH_ID/send \
  -H "Authorization: Bearer $REP_TOKEN"

# 4. Approve as manager
curl -X POST http://localhost:3001/api/approvals/APPROVAL_ID/approve \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $MGR_TOKEN" \
  -d '{"comment":"Approved for 3yr commit"}'

# 5. Send after approve (expect 200)
curl -X POST http://localhost:3001/api/quotes/QUOTE_HIGH_ID/send \
  -H "Authorization: Bearer $REP_TOKEN"

# 6. Reject example (fresh quote, expect 400 without comment then 200)
curl -X POST http://localhost:3001/api/approvals/APPROVAL_ID2/reject \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $MGR_TOKEN" \
  -d '{}'
curl -X POST http://localhost:3001/api/approvals/APPROVAL_ID2/reject \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $MGR_TOKEN" \
  -d '{"comment":"Too high, cap at 20%"}'

# 7. Non-approver approve (expect 403)
curl -X POST http://localhost:3001/api/approvals/APPROVAL_ID/approve \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $REP_B_TOKEN" \
  -d '{"comment":"Hijack"}'

# 8. Queue + config
curl "http://localhost:3001/api/approvals?status=Pending" -H "Authorization: Bearer $MGR_TOKEN"
curl http://localhost:3001/api/approvals/config -H "Authorization: Bearer $MGR_TOKEN"
```

- Verify gating: Send returns `422 { code: approval_required }` with `approvalId` link.
- Verify idempotency: second approve `409`.

## 6. UI Testing Section

- Quote detail: discount badge (`30%` red if >threshold), approval banner states (Required amber `Request`, Pending blue `Awaiting Manager`, Approved green `Ready to send`, Rejected red with reason + `Edit & re-request`), Request modal (reason textarea required, discount readout), Send disabled with tooltip when gated.
- Approvals queue (`/approvals`): table Requestor/Type/Entity link/Discount/Reason/Age/Status/Actions, filters status/type/requestor, sort Age, bulk select, empty `All caught up 🎉`, loading skeleton, error Retry.
- Detail modal/page: entity preview (quote lines mini), discount highlight, comment box (required for Reject, optional Approve), Approve green + Reject red outline + Cancel ghost + Reassign, confirm for each, focus trap.
- Notifications: bell +1 <60s, dropdown deep-links to `/approvals/:id`, mark-read.
- Responsive: queue table -> cards mobile, modals full-sheet, banners wrap without covering Send.
- A11y: buttons labelled, disabled Send `aria-disabled` + tooltip announced, modals trap + Esc, status `role=status`.

## 7. Regression & Cross-Feature Impact

- Quotes: low-discount unaffected; high blocked until Approved; public token disabled until Approved (or shows Pending page – verify); version regenerate preserves approval chain (v1 Approved does not auto-approve v2).
- Deals: Won close with Pending quote warns but does not bypass; line discount edits after request mark approval `Stale – re-review` (or keep – document).
- Products: discount source (line vs header) consistent – which pct triggers threshold (max line vs total – document).
- Pipeline/Forecast: Pending approval deals still forecast per stage (not zeroed); Rejected does not move stage.
- Search: `approval:Pending` filter finds quotes; global search finds approval by entity number.
- Config change does not retro-block Sent/Accepted quotes.

## 8. Expected Results Summary Table

| TC   | Title                | Expected           | Pass Criteria      |
| ---- | -------------------- | ------------------ | ------------------ |
| TC01 | High gates Send      | Modal + banner     | No email, not Sent |
| TC02 | Low sends            | Sent + 0 approvals | Shareable          |
| TC03 | Boundary 20%         | Documented > vs >= | Locked             |
| TC04 | Request 201          | Pending + notify   | Timeline           |
| TC05 | Queue roles          | Mgr all, Rep own   | 403 cross          |
| TC06 | Approve UI           | Approved + notify  | Unlocks Send       |
| TC07 | API approve+send     | 422->200           | Order matters      |
| TC08 | Reject needs comment | 400->200           | Blocks Send        |
| TC09 | Dup 409              | Single Pending     | Button hidden      |
| TC10 | Double 409           | Single entry       | Disables           |
| TC11 | Cancel               | Notifies, removes  | 403 non-req        |
| TC12 | Re-request v2        | Chain kept         | Still blocked      |
| TC13 | Gated errors         | 422 + link         | All gated doc      |
| TC14 | Non-approver 403     | Hidden +403        | No change          |
| TC15 | Self 403/warn        | SoD enforced       | Documented         |
| TC16 | Reassign             | Notify new         | Old loses btn      |
| TC17 | Overdue flag         | Red + digest       | Metrics ok         |
| TC18 | Bulk/filter          | Progress           | No silent fail     |
| TC19 | Generic type         | Same flow or 400   | Documented         |
| TC20 | Audit full           | Immutable          | Internal hidden    |
| TC21 | Notify <60s          | Links correct      | Mark-read          |
| TC22 | Threshold edit       | Immediate new only | Audit + revert     |

## 9. Troubleshooting & Common Failures

- Send succeeds despite 30% (no gate): threshold config is 50% not 20% – `GET /api/approvals/config` to confirm; discount measured is header total not max line (lines 30% but header 12% after blending) – check `discountPct` basis; feature flag off in local.
- Request `409 already pending` for new quote version: approval tied to `dealId` not `quoteId+version` – include `version:2` or regenerate creates new entityId; check existing `GET /api/approvals?entityId=`; cancel stale first.
- Approve `403` as Manager: role is `rep` not `manager/approver` – verify `GET /api/users/me` role; approval `assigneeId` is Admin only – reassign or login Admin.
- `400 comment required` on Approve with comment: key is `reason`/`note` not `comment` – copy UI Network payload; empty whitespace counts as missing – trim.
- Gated Send returns `403` not `422`: version expects 403 – accept either but document; check body `code: approval_required` to distinguish from auth 403 (no token).
- Notifications never arrive: queue worker down – check API logs `approval.notify`; bell polls 30s – wait 60s + hard refresh; email stub path unwritable.
- Re-request creates duplicate Pending (2 rows): versioning missing – report as bug (should be single active); workaround cancel old before new.
- Threshold change no effect: cached config – restart API or `POST /api/approvals/config/clear-cache`; verify `GET .../config` returns new value.
- Public Accept works while Pending (bypass): gate only on Send, not Accept – report P0 if spec requires block; verify `GET /public/:token` shows `Pending approval` banner (should).
- Self-approve allowed (SoD fail): single-manager setup – create second manager user for test; if spec allows self-approve with warn, capture warning screenshot as pass.

## 10. Pass/Fail Checklist

- [ ] TC01 high 30% blocks Send with modal+banner, no email, not Sent
- [ ] TC02 low 10% sends immediately, zero approvals
- [ ] TC03 boundary 20% behavior locked as > vs >= with evidence
- [ ] TC04 request UI+API 201 Pending, notifies <60s, timeline logged
- [ ] TC05 queue role-scoped (Mgr all, Req own, others none) with filters
- [ ] TC06–TC07 approve UI+API unlocks Send (422->200), notifies
- [ ] TC08 reject requires comment (400->200), blocks Send with reason
- [ ] TC09 duplicate while Pending 409s, single record, button hidden
- [ ] TC10 double/race single entry, second 409, button disables
- [ ] TC11 cancel by requestor notifies + removes, others 403
- [ ] TC12 re-request versions chained, still blocked until approved
- [ ] TC13 all gated actions (Send/Share/Accept/Close) return specific 422/403 + link
- [ ] TC14 non-approver/Viewer/anon 403s, buttons hidden, no change
- [ ] TC15 self-approve guarded or documented with evidence
- [ ] TC16 reassign notifies new, old loses actions, timeline logged
- [ ] TC17 overdue flagged + digest, metrics correct
- [ ] TC18 filters/bulk progress without silent fail
- [ ] TC19 generic type same flow or documented 400
- [ ] TC20 audit immutable full chain, internal comments hidden public
- [ ] TC21 all notifies <60s with correct deep-links
- [ ] TC22 threshold edit immediate for new, audit + revert, no retro-block
- [ ] All 8 curls executed, gating 422 + idempotency 409 verified
- [ ] Regression: quotes low/high, public gate, deals Won, forecast intact
- [ ] Cleanup: Pendings decided, test quotes/deals removed, threshold restored
- Tester: _______________ Date: _______________ Threshold: _______________ Approval IDs: _______________ Result: PASS / FAIL
