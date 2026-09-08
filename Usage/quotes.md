# Quotes – Comprehensive Testing Guide

## 1. Overview

This guide covers Quote snapshot totals, public token link, and accept/decline e-signature stub.
Scope includes quote CRUD from Deal (snapshot line items + totals at creation), quote status lifecycle (Draft, Sent, Accepted, Declined, Expired), versioning on regenerate, PDF/preview rendering with USD/EUR/INR formatting, public shareable token link (no auth) with expiry, accept/decline actions + e-signature stub (name/typed signature + timestamp + IP), permissions, audit, approval interaction for high-discount quotes.
Base URLs:

- API: `http://localhost:3001`
- Web: `http://localhost:3000`
- Public link: `http://localhost:3000/q/:token` (no login) backed by `GET /api/quotes/public/:token`.
  Example quote snapshot:

```json
{
  "dealId": "DEAL_ID",
  "currency": "INR",
  "lines": [
    {
      "productId": "...",
      "name": "E2E Pro Seat",
      "qty": 10,
      "unitPrice": 80000,
      "discountPct": 10,
      "taxPct": 18,
      "lineTotal": 849600
    }
  ],
  "subtotal": 800000,
  "discountTotal": 80000,
  "taxTotal": 129600,
  "grandTotal": 849600
}
```

Success criteria: snapshot immutable after deal edits, token link works without auth but expires/revocable, accept/decline recorded once with signature stub, totals math exact.

## 2. Prerequisites & Test Data Setup

- Admin + Rep A tokens; deal with line items: `E2EDeal_Quote_USD` (2 lines, total $20,620) + `E2EDeal_Quote_INR` (₹1,88,800) + `E2EDeal_Quote_EUR` (€5,400).
- Products seeded (see products-line-items.md).
- Quote statuses clean: delete `E2E Quote*` via `DELETE /api/quotes/:id` if Draft, else archive.
- Discover public route: check `POST /api/deals/:id/quotes` for create, `POST /api/quotes/:id/share` for token, `GET /api/quotes/public/:token`, `POST /api/quotes/public/:token/accept|decline`. Adjust if `…/sign`.
- Signature stub data: `signerName: Priya Sharma, signerEmail: priya@test.in, signature: typed "P. Sharma", ip: auto`.
- Expiry test: quote with `expiresAt: tomorrow` vs `yesterday` vs `+30d`.
- Cleanup: revoke tokens, delete draft quotes, keep one Accepted for regression.

## 3. Test Environment Matrix

| Dimension  | Variants                                                                               |
| ---------- | -------------------------------------------------------------------------------------- |
| API        | `http://localhost:3001`                                                                |
| Web        | `http://localhost:3000` + public `/q/:token`                                           |
| Browsers   | Chrome, Firefox, Safari (public link)                                                  |
| Viewports  | Desktop + Mobile 360px (public sign)                                                   |
| Roles      | Admin, Owner Rep (create/send), Non-owner (403), Viewer (read), Anonymous (token only) |
| Currencies | USD, EUR, INR quote each                                                               |
| Statuses   | Draft, Sent, Accepted, Declined, Expired, Revoked                                      |
| Signature  | Typed name, drawn (if any), missing (blocked)                                          |

- Record quoteId + token per test; tokens are secrets – do not commit to repo.

## 4. Detailed Step-by-Step Test Cases

### TC01 – Create Quote from Deal Happy Path (UI)

- Steps as Rep A: Open `E2EDeal_Quote_USD` -> Quotes tab -> New Quote -> Verify lines prefilled from deal (2 rows), totals $20,620, currency USD locked, expiry +30d default, Save as Draft.
- Expected: Draft appears with `Q-0001` number, snapshot lines match deal at that moment, toast, `GET /api/quotes/:id` shows `status: Draft` + breakdown.

### TC02 – Create Quote (API) with Snapshot

- Steps: `POST /api/deals/:id/quotes` or `POST /api/quotes { dealId }` for INR deal.
- Expected: `201` with `lines[]` copied (name/qty/price/discount/tax/lineTotal), `grandTotal: 188800` (verify), `currency: INR`, `version: 1`. Deal `quotesCount +1`.

### TC03 – Snapshot Immutability After Deal Edit (Core)

- Steps:
  1. Note quote grandTotal $20,620.
  2. Edit deal: change line qty 10->20 (lineTotal doubles).
  3. Reopen quote, check totals.
- Expected: Quote still $20,620 (immutable snapshot), banner `Deal changed since quote (Regenerate to update)`. Regenerate creates version 2 with new total (see TC04). No silent mutation.

### TC04 – Regenerate / Versioning

- Steps: On stale quote click `Regenerate from Deal` (or `POST /api/quotes/:id/regenerate`).
- Expected: Confirm modal -> version 1->2, totals updated, version history `v1 $20,620 -> v2 $31,240` retained with diff + actor, public token either stays (points to latest) or new token (old invalid – document).

### TC05 – Quote Totals Math (Discount + Tax)

- Steps: Quote with lines: L1 10x1000-10%+18%=10620, L2 2x5000+0%=10000. Verify subtotal 20000, discount 1000, tax 1620 (1296+324? compute: L1 tax 1620? 9000*0.18=1620, L2 0 => total tax 1620), grand 20620.
- Expected: Breakdown exact 2-dec, footer matches API raw, rounding half-up. INR/EUR equivalents formatted correctly.

### TC06 – Required Validation (Deal, Lines, Expiry, Currency)

- Steps: Try create quote with no dealId, empty lines array, expiry past, currency mismatch (deal USD quote INR), grandTotal manual override.
- Expected: `400` per case + inline errors. Currency must match deal (or converted with FX – document). Past expiry blocked or warns. No draft created.

### TC07 – Send Quote (Draft -> Sent)

- Steps: On Draft click `Send` (or `POST /api/quotes/:id/send`), confirm.
- Expected: Status Sent + `sentAt` + `sentBy`, timeline, public token auto-generated if not exists, email stub sent to contact (verify log), Edit locked (or version bump – document). Resend updates `sentAt` without duplicating token.

### TC08 – Public Token Link No-Auth View (Core)

- Steps: As Rep click `Share -> Copy Link` (`http://localhost:3000/q/TOKEN`), open incognito without login.
- Expected: Public page renders quote number, deal/company, lines table, totals with correct $/€/₹, expiry, status Sent, Accept/Decline buttons, no login prompt, no internal nav leakage (no sidebar, no other deals). `GET /api/quotes/public/:token` 200 without Authorization.

### TC09 – Public Link Formatting Multi-Currency Trio

- Steps: Open USD/EUR/INR public links on desktop + mobile 360px.
- Expected: `$20,620.00`, `€5,400.00`, `₹1,88,800` correctly grouped, lines readable, totals sticky footer mobile, no overflow, print/PDF button works.

### TC10 – Accept with E-Signature Stub (Core)

- Steps: On Sent USD public link, click Accept -> modal requires Signer Name `Priya Sharma`, Email `priya@test.in`, typed signature `P. Sharma`, checkbox `I agree`, Confirm.
- Expected: Success `Quote accepted`, status Accepted + `acceptedAt/signer/ip`, deal optionally auto-moves toward Won (or suggests – document), token single-use (second Accept `409 already decided`). Missing name/signature blocks inline + API `400 signature required`. Audit includes IP + user-agent.

### TC11 – Decline with Reason

- Steps: On Sent INR link click Decline -> requires reason dropdown (Price, Competitor, Timing, Other) + notes, Confirm.
- Expected: Status Declined + reason stored, deal stays open (or suggests Lost – document), second Decline `409`. Empty reason blocked `400`.

### TC12 – Double Accept / Race Idempotency

- Steps: Double-click Accept, or two parallel `POST .../accept` same token.
- Expected: Single Accepted transition, second `409 Quote already decided`, no duplicate timeline entries, deal moved once. Button disables + spinner.

### TC13 – Expired Quote Blocks Accept

- Steps: Create quote `expiresAt: yesterday` (or manipulate), try Accept via public link + API.
- Expected: Banner `Expired on …`, Accept/Decline disabled with `Request new quote` hint, API `410 Gone` or `422 expired`. Sent->Expired auto-job (or on-view check – document). Admin can extend expiry (new date enables Accept).

### TC14 – Revoke Token (Unshare)

- Steps: As Rep click `Revoke link` (or `DELETE /api/quotes/:id/share`), try opening old token incognito.
- Expected: Old token `401/404 Invalid or revoked`, no quote data leaked, new Share generates fresh token (old stays dead). Timeline `Link revoked by …`.

### TC15 – Token Guessing / Tampering Resistance

- Steps: Open `/q/invalid-token-123`, `/q/<valid-token>X` (one char changed), try `GET /api/quotes/:id` (internal id) without auth.
- Expected: `404` without revealing whether id exists, no enumeration (`Invalid link` same for both), internal id without token `401`. Token entropy >=128-bit (length ~32+ chars, not sequential `Q-1`).

### TC16 – Edit / Delete Permissions by Status

- Steps: Try editing Sent/Accepted quote (add line), deleting Draft vs Sent; as non-owner Rep try all; Viewer try create.
- Expected: Draft editable/deletable by owner/Admin; Sent locked (edit creates new version or 409); Accepted/Declined immutable (`409 closed`); non-owner `403`; Viewer `403` + hidden buttons. Delete Sent requires Admin + confirm + audit.

### TC17 – High-Discount Quote Triggers Approval

- Steps: Create quote with line discount 30% (above threshold, e.g., >20%) – check `approvals.md` threshold.
- Expected: Banner `Requires approval before Send`, Send blocked until `Approved` (or sends as `Pending Approval` – document). Approval approve unblocks, reject blocks with reason. Public link disabled until approved (404 or `Pending approval` page).

### TC18 – Quote PDF / Print Snapshot

- Steps: Click `Download PDF` / Print on internal + public pages.
- Expected: PDF contains same snapshot totals + signature block if Accepted (name/date/IP), filename `Quote-Q-0001.pdf`, INR ₹ renders (font supports), no internal URLs leaked.

### TC19 – Audit Trail & Timeline

- Steps: Create -> Send -> View (public hit) -> Accept. Check `GET /api/quotes/:id/timeline` + deal timeline.
- Expected: Entries for each with actor (owner vs anonymous signer with IP), timestamps, version diffs. Public views logged (count) without PII leak.

### TC20 – Search / List Quotes by Deal/Status

- Steps: Filter `dealId=…`, `status=Sent`, search `Q-000`, sort `createdAt desc`, paginate.
- Expected: Correct subsets, counts match, deep-link `http://localhost:3000/deals/:id/quotes` tab shows all versions.

### TC21 – XSS via Quote Fields (Bonus)

- Steps: Product name `<script>alert(1)</script>`, signer name `<img onerror=alert(1)>`, notes 5000 chars.
- Expected: Escaped on internal + public pages (no execution), PDF safe, `400` if over length. Public page especially hardened (no reflected XSS via `?token=`).

### TC22 – Performance – 50 Quotes + Public Load (Bonus)

- Steps: Create 50 quotes on one deal, open list, hit public link 20x parallel.
- Expected: List paginated <2s, public p95 <600ms, no token collision, counts correct.

## 5. API Testing Section

| Method & Endpoint                                    | Purpose                | Expected                                                |
| ---------------------------------------------------- | ---------------------- | ------------------------------------------------------- |
| `POST /api/deals/:id/quotes` (or `POST /api/quotes`) | Create snapshot        | 201 + lines + totals                                    |
| `GET /api/quotes/:id`                                | Internal detail (auth) | 200                                                     |
| `GET /api/deals/:id/quotes`                          | List by deal           | 200                                                     |
| `POST /api/quotes/:id/send`                          | Draft->Sent            | 200 Sent + sentAt                                       |
| `POST /api/quotes/:id/share`                         | Generate token         | 201 `{ token, url }`                                    |
| `GET /api/quotes/public/:token`                      | Public view (no auth)  | 200, 404 revoked/expired                                |
| `POST /api/quotes/public/:token/accept`              | Accept + signature     | 200 Accepted, 400 missing sig, 409 decided, 410 expired |
| `POST /api/quotes/public/:token/decline`             | Decline + reason       | 200, 400 missing reason                                 |
| `DELETE /api/quotes/:id/share`                       | Revoke                 | 204, old token 404                                      |

```bash
# 1. Login rep
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"rep.a@test.com","password":"Rep123!"}'

# 2. Create quote from deal (snapshot)
curl -X POST http://localhost:3001/api/deals/DEAL_ID/quotes \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"expiresAt":"2026-10-08","notes":"E2E test quote"}'

# Alt if POST /api/quotes
curl -X POST http://localhost:3001/api/quotes \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"dealId":"DEAL_ID","expiresAt":"2026-10-08"}'

# 3. Send (Draft->Sent)
curl -X POST http://localhost:3001/api/quotes/QUOTE_ID/send \
  -H "Authorization: Bearer $TOKEN"

# 4. Share - generate token
curl -X POST http://localhost:3001/api/quotes/QUOTE_ID/share \
  -H "Authorization: Bearer $TOKEN"

# 5. Public view NO AUTH (replace TOKEN_VALUE)
curl http://localhost:3001/api/quotes/public/TOKEN_VALUE

# 6. Public accept with e-signature stub NO AUTH
curl -X POST http://localhost:3001/api/quotes/public/TOKEN_VALUE/accept \
  -H "Content-Type: application/json" \
  -d '{"signerName":"Priya Sharma","signerEmail":"priya@test.in","signature":"P. Sharma","agreed":true}'

# 7. Public decline (use fresh quote token)
curl -X POST http://localhost:3001/api/quotes/public/TOKEN_VALUE2/decline \
  -H "Content-Type: application/json" \
  -d '{"reason":"Price","notes":"Budget cut"}'

# 8. Accept without signature (expect 400)
curl -X POST http://localhost:3001/api/quotes/public/TOKEN_VALUE3/accept \
  -H "Content-Type: application/json" \
  -d '{"signerName":""}'
```

- Verify snapshot: compare `quote.lines[].lineTotal` sum == `grandTotal`.
- Verify single-decision: second accept `409`.

## 6. UI Testing Section

- Deal Quotes tab: list Number/Version/Status badge (Draft gray, Sent blue, Accepted green, Declined red, Expired amber)/Total+currency/Expiry/Actions (View, Send, Share, Regenerate, Delete). New Quote button.
- Quote detail (internal): header `Q-0001 v2` + status pill + expiry countdown (`Expires in 12d` red if <3d), lines table (Product/Qty/Unit/Discount/Tax/Total), breakdown footer, stale banner if deal changed, Send/Share/Regenerate buttons per status, timeline.
- Share modal: link input readonly + Copy + QR (if any) + Expiry date + Revoke, warning `Anyone with link can view`.
- Public page (`/q/:token`): minimal header (company logo, no nav), quote card, lines + totals, expiry/status banner, Accept (green) / Decline (red outline) buttons, signature modal (name/email/typed sig/agree checkbox, validation), success confetti/check, expired/revoked error pages with `Contact sales` hint.
- Formatting: trio currencies correct, mobile stacks lines as cards, Print/PDF button.
- A11y: public page labelled, modals focus-trapped, errors announced, buttons 44px touch, contrast AA.

## 7. Regression & Cross-Feature Impact

- Deals/Line items: deal edits do not mutate quote; Regenerate pulls latest; Won prompt counts deal lines, not quote lines.
- Approvals: high-discount quote Send blocked until Approved – verify approve/reject flows (see approvals.md).
- Competitors: quote accept does not auto-close deal as Won unless spec says – verify deal stage unchanged or moved per spec + competitor untouched.
- Pipeline/Forecast: Accepted quote does not double-count forecast; dashboard `Quoted value` vs `Weighted` distinct.
- Notifications: owner notified on public view/accept/decline (if enabled) with signer + IP.
- Search: `quote:Q-0001` finds deal; global search finds quote by number.

## 8. Expected Results Summary Table

| TC   | Title           | Expected            | Pass Criteria     |
| ---- | --------------- | ------------------- | ----------------- |
| TC01 | Create UI Draft | Q-number + snapshot | GET Draft         |
| TC02 | Create API      | 201 totals          | Count +1          |
| TC03 | Immutable       | Stays 20620         | Stale banner      |
| TC04 | Version 2       | History diff        | Token policy doc  |
| TC05 | Math 20620      | Exact breakdown     | Half-up           |
| TC06 | Validation 400  | Inline              | No draft          |
| TC07 | Send Sent       | sentAt + stub       | Edit locked       |
| TC08 | Token no-auth   | Renders, no nav     | API 200 no-auth   |
| TC09 | Trio format     | $ € ₹               | Mobile ok         |
| TC10 | Accept stub     | Accepted + IP       | Second 409        |
| TC11 | Decline reason  | Stored              | Second 409        |
| TC12 | Double race     | Single              | Button disables   |
| TC13 | Expired 410     | Disabled            | Extend re-enables |
| TC14 | Revoke 404      | No leak             | New token works   |
| TC15 | Tamper 404      | No enum             | Entropy ok        |
| TC16 | Perms by status | 403/409             | Buttons hidden    |
| TC17 | Approval gate   | Blocked until ok    | Link gated        |
| TC18 | PDF snapshot    | ₹ renders           | Sig block         |
| TC19 | Audit           | All actors          | Views logged      |
| TC20 | Filter/search   | Correct subsets     | Deep-link ok      |
| TC21 | XSS escaped     | No exec             | 400 long          |
| TC22 | Scale <2s       | Public <600ms       | No collision      |

## 9. Troubleshooting & Common Failures

- `404 POST /api/deals/:id/quotes`: route is `POST /api/quotes { dealId }` – try alt; inspect Network on New Quote click for actual path.
- Snapshot totals mismatch by tax: quote uses product `taxRate` at snapshot vs deal line override – verify which source; regenerate after aligning; check inclusive vs exclusive (see products TC18).
- Public `401` with valid token: sent as `Authorization` instead of path – use `/public/:token` no header; check token trailing spaces from Copy; verify not revoked.
- Accept `400 signature required` even with body: keys are `signedBy`/`signer_name` not `signerName` – copy UI Network payload keys; `agreed:true` boolean required.
- Second Accept `200` not 409 (duplicate timeline): idempotency missing – report as bug (double Won risk); verify deal moved only once.
- Expired still Acceptable: expiry checked only on view, not on POST – test API directly; report P0 (contract risk); workaround extend check both layers.
- Revoked token still 200 (cache): CDN/browser cache – hard refresh incognito + `Cache-Control: no-store` expected; verify API directly with curl (bypass cache).
- `403` Send as owner: high-discount approval gate – check `approvalStatus: Pending` in GET; approve first (see approvals.md).
- INR ₹ boxes in PDF: font missing Devanagari/symbol – verify with `₹` + `₹1,88,800`; switch PDF font to Noto Sans; attach sample.
- CORS on public POST: public route must allow `*` – check OPTIONS; ensure no `Authorization` required in preflight.
- Token in URL logged: server logs full URL with token – redact in docs; prefer `POST` body token if privacy-sensitive (document).

## 10. Pass/Fail Checklist

- [ ] TC01–TC02 create UI+API snapshots with correct lines/totals/currency/version
- [ ] TC03 snapshot immutable after deal edit + stale banner, no silent mutation
- [ ] TC04 regenerate versions with diff history, token policy documented
- [ ] TC05 math subtotal/discount/tax/grand exact trio currencies
- [ ] TC06 validations block missing/mismatch/past (400+inline)
- [ ] TC07 Send locks edit, stamps sentAt/By, email stub logged
- [ ] TC08 token link renders no-auth without nav leak (API 200 no-auth)
- [ ] TC09 $ € ₹ formatting + mobile + print correct
- [ ] TC10 Accept requires name/email/sig/agree, stamps IP, second 409s
- [ ] TC11 Decline requires reason, stores, second 409s
- [ ] TC12 double/race single transition, button disables
- [ ] TC13 expired blocks UI+API (410/422), extend re-enables
- [ ] TC14 revoke 404s old without leak, new works
- [ ] TC15 tampered 404s identically, internal id 401s, entropy ok
- [ ] TC16 status-based edit/delete + role 403s enforced
- [ ] TC17 high-discount gated by approval, link gated
- [ ] TC18 PDF snapshot + sig block, ₹ renders
- [ ] TC19 audit covers create/send/view/accept with IPs
- [ ] TC20 filters/search/sort/paginate + deep-link correct
- [ ] TC21 XSS escaped both surfaces, length 400s
- [ ] TC22 scale list <2s public <600ms
- [ ] All 8 curls executed, snapshot sum verified
- [ ] Regression: deals immutable, approvals gate, forecast, notifications intact
- [ ] Cleanup: tokens revoked, drafts removed, secrets not committed
- Tester: _______________ Date: _______________ Quote IDs/Tokens: _______________ Result: PASS / FAIL
