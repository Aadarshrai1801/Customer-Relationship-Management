# Billing & Subscriptions – Comprehensive Testing Guide

Base URLs: API `http://localhost:3001`, Web `http://localhost:3000`.

## 1. Overview

This guide covers Self-serve Plans/Seats (prorated), Invoices (immutable), and subscription lifecycle.
Scope includes plan listing/comparison, checkout/upgrade/downgrade, seat add/remove with proration preview, payment method update, billing portal, invoice list/PDF/download, immutability (no edit/delete, only void/refund via credit note), trial handling, cancellation (end-of-period vs immediate), failed-payment dunning, and RBAC (billing admin only).
Out of scope is real PSP settlement beyond test-mode (use Stripe test clocks/cards if integrated – document provider).
Key roles: Billing Admin/Owner (manage), Admin non-billing (read or blocked per spec), Member (no access).
Critical rules: seat changes prorate to the day/second with preview before confirm; invoices immutable once finalized (no PATCH/DELETE – only void/credit); downgrade takes effect per policy without data loss beyond plan limits; failed payments trigger dunning, not silent cancel.
Success criteria: proration math reconciles, invoices never mutate, lifecycle transitions correct, and non-billing roles blocked.

## 2. Prerequisites & Test Data Setup

- Stack: Web `:3000`, API `:3001`, billing provider test-mode (e.g., Stripe `sk_test_…`) + webhook forwarding (`stripe listen`) if integrated; else mock billing service – record which.
- Users: `billing-admin@test.com` (Owner/Billing), `admin-nobill@test.com`, `member@test.com`; tokens saved.
- Plans: e.g., Free, Starter ($15/seat/mo), Pro ($29/seat/mo), Annual variants; note IDs/prices in run notes.
- Payment: test card `4242 4242 4242 4242`, exp future, CVC any; 3DS/`4000…0002` decline card for failure tests.
- Baseline: current subscription (`GET /api/billing/subscription`), seat count, `currentPeriodEnd`, invoice list snapshot.
- Clocks: use test clock / short trial (e.g., 7-day trial) to test renewal without waiting; note time-travel method.
- Cleanup: revert to baseline plan/seats after run on shared staging; void test invoices only via supported flow (never DB edit).
- Evidence: save proration previews, invoice PDFs, webhook event IDs.

## 3. Test Environment Matrix

| Dimension | Variants                                                           |
| --------- | ------------------------------------------------------------------ |
| Role      | Billing Admin, Admin non-billing, Member, Anonymous                |
| Plan move | Free→Starter, Starter→Pro, Pro→Starter (downgrade), Monthly↔Annual |
| Seats     | +1, +5, −1 to min, Exceed plan max                                 |
| Payment   | Valid, Declined, Expired, 3DS, Missing                             |
| Period    | Trial, Active, Past-due, Canceled (end-of-period), Expired         |
| Invoice   | Draft, Finalized, Voided, Refunded/credited                        |
| Client    | Billing UI, Portal redirect, curl API, PSP webhook                 |
| Currency  | USD default; multi-currency if supported                           |

- Record: subscription IDs, invoice IDs/numbers, proration amounts, period dates, webhook IDs.
- Never use live cards; confirm test-mode banner visible.
- Verify tax/coupon handling if present (or N/A).

## 4. Detailed Step-by-Step Test Cases (at least 18 numbered TC cases)

### TC-01 – View Plans & Current Subscription

- **Objective:** Verify plans page shows correct current + options.
- **Preconditions:** Logged in as billing admin.
- **Steps:**
  1. Go to `http://localhost:3000/settings/billing`.
  2. Verify current plan badge, seat count, renewal date, payment method last4.
  3. Verify plan cards with per-seat prices + feature deltas.
  4. As member open same URL → expect 403/no-access or read-only per spec.
- **Expected:** Accurate current; member blocked or read-only.

### TC-02 – Upgrade Plan (Starter→Pro) Pro-Rated

- **Objective:** Verify upgrade charges proration immediately.
- **Preconditions:** On Starter monthly, 3 seats, mid-period.
- **Steps:**
  1. Click Upgrade to Pro → verify preview modal shows `Proration today: $X, Next invoice: $Y`.
  2. Confirm; verify success toast + plan badge Pro.
  3. Verify invoice/charge for proration created; seats unchanged.
  4. Verify API subscription `plan=pro`, `prorationAmount=X`.
- **Expected:** Immediate upgrade; preview matches charge ±$0.01.

### TC-03 – Downgrade Plan (Pro→Starter)

- **Objective:** Verify downgrade timing + no data loss.
- **Preconditions:** On Pro.
- **Steps:**
  1. Click Downgrade → verify messaging `Takes effect <end of period | immediately>` per spec – record.
  2. Confirm; verify badge shows `Pro (downgrades to Starter on DATE)` or immediate.
  3. Verify features gate accordingly only after effective date.
  4. Verify proration credit preview if immediate.
- **Expected:** Policy honored; no surprise lockout mid-period.

### TC-04 – Add Seats (+2) Prorated Preview

- **Objective:** Verify seat add math.
- **Preconditions:** Pro, 3 seats.
- **Steps:**
  1. Seats → +2 (total 5) → verify preview `2 × $29 × daysLeft/daysInPeriod`.
  2. Manually compute and compare.
  3. Confirm; verify active seats 5 + charge.
  4. Invite 2 users; verify they activate within seat count.
- **Expected:** Math exact; activation allowed.

### TC-05 – Remove Seats (−1) Credit

- **Objective:** Verify seat removal credits.
- **Preconditions:** 5 seats, 4 occupied.
- **Steps:**
  1. Remove 1 seat (5→4) → verify credit preview (or `no refund, effective next period` per spec).
  2. Confirm; verify seats 4.
  3. Attempt 4→2 while 4 occupied → expect blocked `Remove members first`.
- **Expected:** Cannot go below occupied; credit per policy.

### TC-06 – Payment Method Update

- **Objective:** Verify card swap without plan change.
- **Preconditions:** Billing admin.
- **Steps:**
  1. Update card to `5555…` test Mastercard.
  2. Verify last4 updates + success toast.
  3. Trigger $0 verification or $1 auth per provider (document).
  4. As non-billing admin attempt → 403.
- **Expected:** Swap clean; no duplicate subscription.

### TC-07 – Invoice List + PDF Download

- **Objective:** Verify invoices listed with immutable PDFs.
- **Preconditions:** At least 2 finalized invoices.
- **Steps:**
  1. Open Invoices; verify columns Number/Date/Amount/Status/Download.
  2. Download PDF; verify totals, plan/seats lines, tax, invoice number.
  3. Verify PDF hash stable across downloads.
- **Expected:** PDFs byte-stable; numbers sequential.

### TC-08 – Invoice Immutability (No Edit/Delete)

- **Objective:** Prove finalized invoices cannot mutate.
- **Preconditions:** Finalized invoice ID.
- **Steps:**
  1. UI: verify no Edit/Delete buttons (only Download/Void/Refund where allowed).
  2. API `PATCH /api/billing/invoices/:id` → 405/403/400 `immutable`.
  3. `DELETE` → same.
  4. Void flow (if supported) creates credit note, original stays with `status:void`, not edited.
- **Expected:** 4xx on mutate; original preserved.

### TC-09 – Failed Payment → Past-Due Dunning

- **Objective:** Verify decline handling.
- **Preconditions:** Card `4000 0000 0000 0002` (decline) or invoice void to trigger retry.
- **Steps:**
  1. Set declining card; trigger renewal (test clock advance or manual `pay`).
  2. Verify status Past-due + banner + email `Payment failed – update card`.
  3. Verify retries scheduled (log/webhook `invoice.payment_failed`).
  4. Swap to valid card; Pay now; verify Active.
- **Expected:** Dunning, not instant cancel; recovery works.

### TC-10 – Cancel (End-of-Period) + Reactivate

- **Objective:** Verify cancel timing.
- **Preconditions:** Active monthly.
- **Steps:**
  1. Click Cancel → select `End of period` → confirm with reason.
  2. Verify badge `Cancels on DATE`, features remain until then.
  3. Reactivate before date; verify Active restored, no new invoice (or prorated per spec).
- **Expected:** Grace period honored; reactivate clean.

### TC-11 – Immediate Cancel / Trial Cancel

- **Objective:** Verify trial cancel leaves no charge.
- **Preconditions:** Trial org (7-day).
- **Steps:**
  1. Cancel during trial.
  2. Verify no invoice charged; access downgrades to Free per spec.
  3. Verify data retained (read-only or limited) not deleted.
- **Expected:** Zero charge; graceful downgrade.

### TC-12 – Trial Conversion to Paid

- **Objective:** Verify trial→paid charges correctly.
- **Preconditions:** Trial with 2 seats.
- **Steps:**
  1. Upgrade mid-trial to Pro.
  2. Verify preview shows trial credit / first charge date.
  3. Confirm; verify subscription Active, trial ended.
- **Expected:** No double charge; dates correct.

### TC-13 – Coupon / Tax (if supported)

- **Objective:** Verify discounts/tax on invoice.
- **Preconditions:** Coupon `QA20` (20% off) if available.
- **Steps:**
  1. Apply coupon at checkout; verify preview −20%.
  2. Finalize; verify invoice line `Discount (QA20) −$X`.
  3. Remove coupon; verify next preview full price.
- **Expected:** Math exact. If unsupported, N/A with screenshot of no-coupon UI.

### TC-14 – Seat Max / Plan Limits

- **Objective:** Verify caps enforced with upgrade nudge.
- **Preconditions:** Starter max e.g., 10 seats.
- **Steps:**
  1. Attempt 11th seat → expect blocked `Limit 10 – upgrade to Pro`.
  2. Upgrade; retry → success.
- **Expected:** Clear nudge; no silent overage (or metered overage invoiced per spec – document).

### TC-15 – Webhook Event Handling (Idempotent)

- **Objective:** Verify PSP webhooks applied once.
- **Preconditions:** `stripe listen` or mock; recent invoice event.
- **Steps:**
  1. Capture `invoice.finalized` event ID.
  2. Replay same event; verify no duplicate invoice (dedupe by event ID).
  3. Verify out-of-order `payment_succeeded` before `finalized` reconciles (or queues – document).
- **Expected:** Idempotent; no dupes.

### TC-16 – Billing Portal (if redirect-based)

- **Objective:** Verify portal deep-links work.
- **Preconditions:** Billing admin.
- **Steps:**
  1. Click Manage in portal → verify redirect to provider with return URL.
  2. Update card in portal; return; verify reflected.
  3. Copy portal URL to member → verify blocked (short-lived, user-scoped).
- **Expected:** Scoped links. If no portal, N/A.

### TC-17 – Currency / Annual Switch

- **Objective:** Verify monthly↔annual proration.
- **Preconditions:** Monthly Pro.
- **Steps:**
  1. Switch to Annual → verify preview (charge annual minus unused monthly credit).
  2. Confirm; verify `billingInterval=annual`, next renewal +12m.
- **Expected:** Credit applied; dates correct.

### TC-18 – RBAC: Non-Billing Blocked (UI + API)

- **Objective:** Verify least privilege.
- **Preconditions:** Member + admin-non-billing tokens.
- **Steps:**
  1. As member open billing URL → 403 page.
  2. `GET /api/billing/subscription` as member → 403.
  3. `POST /api/billing/seats` as admin-non-billing → 403 if policy.
- **Expected:** 403s; no data (amounts, last4) leaked.

### TC-19 – Audit & Receipts

- **Objective:** Verify billing audit trail.
- **Preconditions:** Changes from above.
- **Steps:**
  1. Open audit/billing history; verify entries `plan.changed, seats.+2, card.updated, invoice.finalized` with actor + time.
  2. Verify receipt emails in catcher for each charge.
- **Expected:** Complete trail; emails match invoices.

## 5. API Testing Section

| Method & Endpoint                        | Purpose             | Auth             | Notes                         |
| ---------------------------------------- | ------------------- | ---------------- | ----------------------------- |
| `GET /api/billing/plans`                 | List plans          | Bearer           | Prices + limits               |
| `GET /api/billing/subscription`          | Current sub         | Bearer (billing) | `plan,seats,periodEnd,status` |
| `POST /api/billing/subscription/preview` | Proration preview   | Bearer (billing) | `{plan,seats}` → amounts      |
| `POST /api/billing/subscription`         | Change plan/seats   | Bearer (billing) | Confirm after preview         |
| `GET /api/billing/invoices`              | List                | Bearer (billing) | Finalized only (+drafts?)     |
| `GET /api/billing/invoices/:id/pdf`      | PDF bytes           | Bearer (billing) | Hash stable                   |
| `PATCH/DELETE /api/billing/invoices/:id` | Must fail immutable | Bearer           | Expect 4xx                    |
| `POST /api/billing/payment-method`       | Update card         | Bearer (billing) | Test tokens only              |

```bash
# Login billing admin
curl -s -X POST http://localhost:3001/api/auth/login -H "Content-Type: application/json" \
  -d '{"email":"billing-admin@test.com","password":"Billing123!"}'
# -> $BILL_TOKEN

# 1) Current + plans
curl -s http://localhost:3001/api/billing/subscription -H "Authorization: Bearer $BILL_TOKEN" | python3 -m json.tool
curl -s http://localhost:3001/api/billing/plans -H "Authorization: Bearer $BILL_TOKEN" | python3 -m json.tool

# 2) Preview upgrade +2 seats to Pro
curl -s -X POST http://localhost:3001/api/billing/subscription/preview \
  -H "Authorization: Bearer $BILL_TOKEN" -H "Content-Type: application/json" \
  -d '{"plan":"pro","seats":5}' | python3 -m json.tool

# 3) Confirm (after verifying preview)
curl -s -X POST http://localhost:3001/api/billing/subscription \
  -H "Authorization: Bearer $BILL_TOKEN" -H "Content-Type: application/json" \
  -d '{"plan":"pro","seats":5}' | python3 -m json.tool

# 4) Invoices + PDF hash stability
curl -s http://localhost:3001/api/billing/invoices -H "Authorization: Bearer $BILL_TOKEN" | python3 -m json.tool
curl -s http://localhost:3001/api/billing/invoices/INV_ID/pdf -H "Authorization: Bearer $BILL_TOKEN" -o /tmp/inv1.pdf
sha256sum /tmp/inv1.pdf
curl -s http://localhost:3001/api/billing/invoices/INV_ID/pdf -H "Authorization: Bearer $BILL_TOKEN" -o /tmp/inv2.pdf
sha256sum /tmp/inv2.pdf

# 5) Immutability must fail
curl -i -X PATCH http://localhost:3001/api/billing/invoices/INV_ID \
  -H "Authorization: Bearer $BILL_TOKEN" -H "Content-Type: application/json" -d '{"amount":1}'
curl -i -X DELETE http://localhost:3001/api/billing/invoices/INV_ID -H "Authorization: Bearer $BILL_TOKEN"
```

- Assert: preview `prorationToday` equals later charge; PDF hashes equal; PATCH/DELETE 4xx with `immutable`.
- Negative: member token → 403 on all; anon → 401.

## 6. UI Testing Section

- Billing page: current badge, renewal countdown, seats stepper with preview, plan cards with Compare, payment card row (brand/last4/exp + Update), invoices table with Download, cancel/reactivate with confirm + reason.
- Preview modal: itemized proration (unit × qty × daysLeft/total), tax, total due today vs next invoice, Confirm/Cancel; loading spinner prevents double-submit.
- Errors: decline shows `Card declined – try another` inline, not generic; past-due banner with Pay-now CTA persists across pages.
- PDFs: open in new tab with correct filename `INV-2026-001.pdf`.
- Responsive: cards stack at 768px; stepper usable on touch; dark parity for amounts (red past-due legible).
- A11y: stepper buttons labeled, preview table has headers, focus trapped in modal, toasts announced.

## 7. Regression & Cross-Feature Impact

- Seats: deactivating user should free seat or block per policy; inviting beyond seats blocked with billing nudge.
- Features: plan gate changes (e.g., workflows/AI) enforce immediately on effective date; downgrade must not delete data, only gate.
- Auth: role billing-admin separate from org-admin – verify matrix.
- Notifications: invoice/failed-payment emails sent; prefs must not suppress critical billing emails (or explicit override documented).
- Audit: all billing writes attributed; invoice finalization webhook idempotent.
- API platform: rate limits must not block checkout; health stays green during PSP outage (graceful banner).

## 8. Expected Results Summary Table

| TC    | Title              | Expected                      | Severity |
| ----- | ------------------ | ----------------------------- | -------- |
| TC-01 | View plans         | Correct current, member gated | Major    |
| TC-02 | Upgrade prorated   | Preview=charge                | Critical |
| TC-03 | Downgrade timing   | Policy honored                | Major    |
| TC-04 | Add seats          | Math exact                    | Critical |
| TC-05 | Remove seats       | Credit/block occupied         | Major    |
| TC-06 | Card update        | last4 swaps                   | Major    |
| TC-07 | Invoice PDF        | Stable hash                   | Major    |
| TC-08 | Immutable          | PATCH/DELETE 4xx              | Critical |
| TC-09 | Past-due dunning   | Banner+email+recover          | Critical |
| TC-10 | Cancel EOP         | Grace + reactivate            | Major    |
| TC-11 | Trial cancel       | $0, graceful                  | Major    |
| TC-12 | Trial convert      | No double charge              | Major    |
| TC-13 | Coupon/tax         | Exact or N/A                  | Minor    |
| TC-14 | Seat caps          | Block + nudge                 | Major    |
| TC-15 | Webhook idempotent | No dupes                      | Major    |
| TC-16 | Portal scoped      | Or N/A                        | Minor    |
| TC-17 | Annual switch      | Credit correct                | Major    |
| TC-18 | RBAC 403           | No leak                       | Critical |
| TC-19 | Audit+receipts     | Complete                      | Minor    |

## 9. Troubleshooting & Common Failures

| Symptom                      | Cause                              | Fix                                                             |
| ---------------------------- | ---------------------------------- | --------------------------------------------------------------- |
| Preview ≠ charge $0.01       | Rounding/tax timing; seconds drift | Compare line items; allow $0.01; check tax inclusive/exclusive  |
| Upgrade not immediate        | Webhook delay                      | Wait + check `subscription.status`; replay/forward webhooks     |
| Invoice missing              | Still draft / webhook not received | Check drafts filter; `stripe events`; finalize manually in test |
| PATCH invoice 500            | Missing immutable guard            | File bug; expect 4xx not 500                                    |
| Seats allow over occupied    | Check missing                      | Enforce `seats>=activeUsers`; file bug                          |
| Card update 402              | Test card requires 3DS             | Use 3DS test flow or different card                             |
| Portal link works for member | Unsigned/long-lived URL            | Scope to user + expiry; file sec bug                            |
| Past-due never recovers      | Pay-now hits wrong invoice         | Pay open invoice ID explicitly; check logs                      |

- Debug: subscription JSON (`status, periodEnd`), invoice lines, PSP dashboard test events, webhook delivery log.
- Safety: stay in test-mode; never log full PAN; mask to last4 in evidence.

## 10. Pass/Fail Checklist

- [ ] Plans/current correct; member/non-billing gated (UI+API 403).
- [ ] Upgrade/downgrade/seats previews match charges/credits.
- [ ] Cannot go below occupied seats; caps nudge upgrade.
- [ ] Card update swaps last4; decline → past-due → recover.
- [ ] Invoices list + PDFs stable; PATCH/DELETE blocked (immutable).
- [ ] Cancel EOP + trial paths leave no stray charges; audit + receipts complete.
- [ ] Webhooks idempotent; portal scoped (or N/A).
- [ ] API curls pass; negatives 401/403/4xx.
- [ ] Evidence: previews, PDFs + hashes, subscription JSON, webhook IDs.
- [ ] Staging reverted to baseline plan/seats; defects filed with IDs/amounts.
