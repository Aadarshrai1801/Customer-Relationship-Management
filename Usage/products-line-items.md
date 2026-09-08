# Products & Line Items – Comprehensive Testing Guide

## 1. Overview

This guide covers Product catalog (sku, unitPrice, tax) and Deal line items (qty, discount, tax) with totals math.
Scope includes product CRUD (name, sku unique, unitPrice >=0, taxRate %, currency, active), deal line-item CRUD (add product, qty>0, discount 0-100% or amount, tax override, remove), line total = qty*unitPrice*(1-discount)*(1+tax), deal amount rollup vs manual amount mismatch warning, multi-currency (line currency must match deal or converted), Closed Won prompt interaction, permissions, audit.
Base URLs:

- API: `http://localhost:3001`
- Web: `http://localhost:3000`
  Formulas:
- `lineSubtotal = qty * unitPrice`
- `lineAfterDiscount = lineSubtotal * (1 - discountPct/100) - discountAmt (if both, document precedence)`
- `lineTotal = lineAfterDiscount * (1 + taxPct/100)`
- `dealLineTotal = sum(lineTotal)`
  Success criteria: math exact to 2 decimals, sku unique case-insensitive, qty/discount/tax validations block bad input, deal totals reconcile or warn, currency consistent.

## 2. Prerequisites & Test Data Setup

- Admin (catalog CRUD), Rep (line items on owned deals).
- Backup `GET /api/products`.
- Seed products:

```json
{ "name": "E2E Pro Seat", "sku": "E2E-PRO-SEAT", "unitPrice": 1000, "currency": "USD", "taxRate": 18, "isActive": true }
{ "name": "E2E Onboarding", "sku": "E2E-ONB", "unitPrice": 5000, "currency": "USD", "taxRate": 0, "isActive": true }
{ "name": "E2E Seat INR", "sku": "E2E-SEAT-INR", "unitPrice": 80000, "currency": "INR", "taxRate": 18, "isActive": true }
{ "name": "E2E Seat EUR", "sku": "E2E-SEAT-EUR", "unitPrice": 900, "currency": "EUR", "taxRate": 20, "isActive": true }
```

- Seed deals: `E2EDeal_LI_USD` (USD, no items), `E2EDeal_LI_INR` (INR), `E2EDeal_LI_Mismatch` for rollup warn.
- Line-item example:

```json
{
  "productId": "PROD_ID",
  "quantity": 10,
  "unitPrice": 1000,
  "discountPct": 10,
  "taxPct": 18,
  "currency": "USD"
}
```

- Expected math check: 10*1000=10000, -10% =>9000, +18% =>10620.00.
- Second: qty 2, price 5000, discount 0, tax 0 =>10000.
- Total deal with both =>20620.00.
- Cleanup: delete `E2E-*` products (only if no linked deals, else archive) + `E2EDeal_LI_*`.

## 3. Test Environment Matrix

| Dimension        | Variants                                                                              |
| ---------------- | ------------------------------------------------------------------------------------- |
| API              | `http://localhost:3001`                                                               |
| Web              | `http://localhost:3000`                                                               |
| Browsers         | Chrome, Firefox                                                                       |
| Roles            | Admin (catalog+lines), Rep owned (lines only), Rep non-owner (blocked), Viewer (read) |
| Currencies       | USD, EUR, INR, mixed (blocked)                                                        |
| Qty/Discount/Tax | Normal, 0, boundary, invalid, decimal                                                 |
| Deal State       | Open, Won (locked?), Lost (locked?)                                                   |

- Record product ids + deal ids; note tax inclusive vs exclusive semantics (assume exclusive – document if inclusive).

## 4. Detailed Step-by-Step Test Cases

### TC01 – Create Product Happy Path (UI)

- Steps as Admin: `http://localhost:3000/products` -> New -> Name `E2E Pro Seat`, SKU `E2E-PRO-SEAT`, Price 1000 USD, Tax 18%, Save.
- Expected: Appears with `SKU` chip + `$1,000.00 +18%`, toast. `GET /api/products/:id` matches.

### TC02 – Create Product (API) Trio Currencies

- Steps: POST USD/INR/EUR seeds above.
- Expected: Each `201` with sku preserved case, currency exact. `GET /api/products?search=E2E` finds all 3.

### TC03 – SKU Unique + Validation

- Steps: Try duplicate `e2e-pro-seat` (lowercase), empty sku, sku with spaces `my sku`, price -5, price `abc`, tax -1/150, empty name.
- Expected: Duplicate `409` or `400` case-insensitive + inline `SKU already exists`; other invalid `400` with field errors. No record. Valid sku `E2E-PRO-2` with dash/underscore allowed.

### TC04 – Edit / Archive Product

- Steps: Edit price 1000->1200, tax 18->20, archive `E2E Onboarding` (`isActive:false`).
- Expected: Edits propagate to picker for new lines but existing line items snapshot old price (or live – document). Archived hidden from picker but history kept. Audit diff.

### TC05 – Add Line Item Happy Path (UI)

- Steps: Open `E2EDeal_LI_USD` -> Line Items tab -> Add -> Pick `E2E Pro Seat`, qty 10, discount 10%, tax 18% (prefilled from product, editable), Save.
- Expected: Row shows `10 x $1,000 = $10,000 -10% +18% = $10,620.00`, deal `lineTotal $10,620` + `amount` mismatch warning if deal amount differs (see TC10). `GET /api/deals/:id/line-items` contains it.

### TC06 – Add Line Item (API)

- Steps: `POST /api/deals/:id/line-items` with example JSON (qty10/10%/18%).
- Expected: `201` with computed `lineTotal: 10620.00`, `subtotal`, `discountAmt`, `taxAmt` breakdown. Math exact.

### TC07 – Quantity Validation (Zero/Negative/Decimal/Large)

- Steps: Try qty 0, -2, 1.5, 1000000, `abc`, empty.
- Expected: 0/negative/abc/empty blocked `400 qty >0`; decimal allowed only if spec permits (else 400 – document); large allowed with total formatting (no overflow). UI spinner min 1.

### TC08 – Discount Validation (Pct 0-100, Amt, Both)

- Steps: Try discountPct -5, 150, 100 (free), 12.5 decimal; discountAmt > subtotal; both pct+amt together.
- Expected: Out-of-range `400`; 100% => lineTotal = tax on 0 = 0; decimal allowed to 2 places; amt>subtotal blocked or floored to 0 (document); both together precedence documented (e.g., pct first then amt) or blocked `only one discount type`.

### TC09 – Tax Validation & Override

- Steps: Product tax 18% prefilled, override to 0, 28, 150, -5.
- Expected: 0 allowed (exempt), 28 allowed, >100 blocked or allowed with warn (document – 150% unusual but mathematically valid; spec likely 0-100). Override affects only this line, not product. Breakdown shows `taxAmt`.

### TC10 – Deal Amount vs LineTotal Rollup & Mismatch Warning

- Steps: Deal amount $15,000 with lineTotal $10,620.
- Expected: Banner `Line total $10,620 differs from Deal amount $15,000 [Sync amount to $10,620] [Keep manual]`. Sync updates deal amount + baseAmount + weighted. Keep retains manual with `Custom amount` badge. Quote snapshot uses lineTotal (see quotes.md).

### TC11 – Edit Line Item (Qty/Price/Discount)

- Steps: Change qty 10->12, unitPrice override 1000->900 (custom price), discount 10->15.
- Expected: Totals recalc instantly (<300ms) UI + persisted API, audit `qty 10->12`, deal lineTotal + weighted update. Custom price flagged `Price overridden` with reset to catalog.

### TC12 – Remove Line Item + Undo

- Steps: Remove one of two lines, confirm dialog shows impact `Total $20,620 -> $10,000`, confirm, then Undo (if supported).
- Expected: Row removed, totals update, timeline logged. Undo restores within 10s or via audit. Last line removal triggers Won-prompt relevance (0 items).

### TC13 – Currency Consistency (USD/EUR/INR)

- Steps: On USD deal try adding INR product; on INR deal add INR + EUR mix; create EUR deal with EUR product qty5 @900 +20% tax.
- Expected: Mismatched currency blocked `400 line currency must match deal` with clear message + picker filters to deal currency only. EUR math: 5*900=4500 +20%=5400.00 `€5,400.00`. INR: 2*80000=160000 +18%=188800 `₹1,88,800`.

### TC14 – Closed Won Prompt Integration

- Steps: Deal with 0 items -> drag to Won -> prompt `Add Products?` (see deals TC10). Deal with items -> no prompt.
- Expected: Prompt only when `line-items count==0` (or total==0). Add path opens line editor pre-close; close succeeds after add. Audit notes `closed with N items`.

### TC15 – Closed Deal Line Lock

- Steps: After Won, try add/edit/remove line item.
- Expected: Blocked `Closed deals are read-only` with `Reopen to edit` link + API `409/422`. Or allowed with warning + audit (document). No silent edit.

### TC16 – Search / Picker Performance

- Steps: Seed 100 products, type `pro` in line Add picker.
- Expected: Debounced server search <400ms, paginated top 10 + `Show more`, keyboard navigable, Create-new `+` works. No full 100 render freeze.

### TC17 – Permissions – Catalog vs Lines

- Steps: As Rep try `POST /api/products` (expect 403) but `POST /api/deals/:ownedId/line-items` succeeds; on unowned deal expect 403. Viewer both 403.
- Expected: UI hides New Product for Rep but shows Add Line on owned. Unowned Add disabled with tooltip. Exact 403 messages, no 500.

### TC18 – Tax-Inclusive vs Exclusive Semantics

- Steps: Check docs/labels: does `unitPrice` include tax? Test: price 118 with 18% – is total 118 or 139.04?
- Expected: Documented as exclusive (total = price*(1+tax)) – verify with fixture. UI label `+18% tax` vs `incl. tax` matches math. No hidden double-tax.

### TC19 – Rounding & Float Precision

- Steps: qty3 x $19.99 -12.5% +7.5% tax; qty1 x ₹99.99 +18%.
- Expected: Each step rounded half-up 2-dec, final displayed 2-dec, sum of lines = deal total (no 1-cent drift). Verify via API raw numbers, not just formatted.

### TC20 – Bulk Add / Import Line Items

- Steps: If supported, add 5 lines rapidly or import CSV.
- Expected: All persist, totals correct, no race losing one (verify count 5). Progress indicator. Partial failure reports row errors.

### TC21 – Delete Product with Linked Lines (Bonus)

- Steps: Delete/Archive `E2E Pro Seat` used in 2 deals.
- Expected: Delete blocked `Used in N deals` with list + Archive suggested. Archive succeeds, existing lines keep snapshot name/price (show `Archived` badge), new deals cannot pick it. Force delete (if any) retains lines with `product (deleted)` snapshot, no null crash.

### TC22 – Line Items in Reports & Export (Bonus)

- Steps: Export deal with lines to CSV/PDF (if supported), check forecast report includes lineTotal.
- Expected: Export rows per line with sku/qty/price/discount/tax/total, totals match UI, currency symbols preserved (UTF-8 ₹).

## 5. API Testing Section

| Method & Endpoint                             | Purpose               | Expected                         |
| --------------------------------------------- | --------------------- | -------------------------------- |
| `POST /api/products`                          | Create product        | 201, 400 validation, 409 dup sku |
| `GET /api/products?search=&currency=&active=` | List/search           | 200 paginated                    |
| `PATCH /api/products/:id`                     | Edit price/tax        | 200                              |
| `DELETE /api/products/:id`                    | Delete guard          | 204 empty, 400 linked            |
| `POST /api/deals/:id/line-items`              | Add line              | 201 + computed totals            |
| `GET /api/deals/:id/line-items`               | List lines            | 200 + deal lineTotal             |
| `PATCH /api/deals/:id/line-items/:lineId`     | Edit qty/discount/tax | 200 recalc                       |
| `DELETE /api/deals/:id/line-items/:lineId`    | Remove                | 204 + totals update              |

```bash
# 1. Login admin
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@test.com","password":"Admin123!"}'

# 2. Create USD product
curl -X POST http://localhost:3001/api/products \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"name":"E2E Pro Seat","sku":"E2E-PRO-SEAT","unitPrice":1000,"currency":"USD","taxRate":18}'

# 3. Create INR + EUR products
curl -X POST http://localhost:3001/api/products \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"name":"E2E Seat INR","sku":"E2E-SEAT-INR","unitPrice":80000,"currency":"INR","taxRate":18}'
curl -X POST http://localhost:3001/api/products \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"name":"E2E Seat EUR","sku":"E2E-SEAT-EUR","unitPrice":900,"currency":"EUR","taxRate":20}'

# 4. Add line: 10 x 1000 -10% +18% => 10620.00
curl -X POST http://localhost:3001/api/deals/DEAL_ID/line-items \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"productId":"PROD_ID","quantity":10,"unitPrice":1000,"discountPct":10,"taxPct":18,"currency":"USD"}'

# 5. Invalid qty 0 (expect 400)
curl -X POST http://localhost:3001/api/deals/DEAL_ID/line-items \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"productId":"PROD_ID","quantity":0,"unitPrice":1000,"currency":"USD"}'

# 6. Mismatched currency INR on USD deal (expect 400)
curl -X POST http://localhost:3001/api/deals/DEAL_USD_ID/line-items \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"productId":"PROD_INR_ID","quantity":1,"unitPrice":80000,"currency":"INR"}'

# 7. List lines + verify totals
curl http://localhost:3001/api/deals/DEAL_ID/line-items -H "Authorization: Bearer $TOKEN"

# 8. Duplicate SKU (expect 409/400)
curl -X POST http://localhost:3001/api/products \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"name":"Dup","sku":"e2e-pro-seat","unitPrice":10,"currency":"USD"}'
```

- Verify math: `10620.00` exact; EUR `5400.00`; INR `188800`.
- Check breakdown keys: `subtotal, discountAmt, taxAmt, lineTotal`.

## 6. UI Testing Section

- Products page: table Name/SKU/Price+currency/Tax/Active, search + currency filter, New/Edit/Archive, empty/loading/error states.
- Deal Line Items tab: table Product/Qty/Unit/Discount/Tax/Total + footer Subtotal/Discount/Tax/Grand, Add/Edit/Remove, mismatch banner with Sync/Keep, currency badge, archived badge.
- Add modal: product autocomplete (filtered to deal currency, shows price+tax), qty stepper, unitPrice editable with Override badge + Reset, discount pct+amt (one or both per spec), tax editable, live total preview updating <200ms, Save disabled until valid.
- Validation visuals: red borders + messages, Save disabled, no silent close.
- Formatting: `$10,620.00`, `€5,400.00`, `₹1,88,800` with en-IN grouping, 2-dec consistent.
- Responsive: table horizontal scroll mobile, modal full-sheet, totals sticky footer.
- A11y: all inputs labelled, live total `aria-live`, modals focus-trapped, stepper keyboard operable.

## 7. Regression & Cross-Feature Impact

- Deals: lineTotal drives mismatch banner, weighted uses deal amount (or lineTotal after Sync – document), Won prompt fires on 0 items.
- Quotes: quote snapshot copies lines at creation – later line edits do NOT mutate quote (verify).
- Approvals: high discountPct (>=20%?) triggers approval on quote – verify line discount flows to quote discount check.
- Competitors/Forecast: line totals feed forecast baseAmount after Sync; competitor unaffected.
- Search: product search in picker vs catalog consistent; deal search by product name if supported.
- Currency FX: Sync amount updates baseAmount with current FX snapshot (see deals-pipeline).

## 8. Expected Results Summary Table

| TC   | Title             | Expected        | Pass Criteria    |
| ---- | ----------------- | --------------- | ---------------- |
| TC01 | Product UI        | Catalog + toast | GET matches      |
| TC02 | Trio API          | 3x201           | Search finds     |
| TC03 | SKU/price/tax 400 | Inline          | No record        |
| TC04 | Edit/archive      | Picker hides    | Snapshot kept    |
| TC05 | Add UI 10620      | Row + total     | API same         |
| TC06 | Add API           | 201 breakdown   | Math exact       |
| TC07 | Qty edges         | 400 0/neg       | Large ok         |
| TC08 | Discount          | 400 range       | 100% =>0         |
| TC09 | Tax override      | Line-only       | Breakdown        |
| TC10 | Mismatch banner   | Sync/Keep       | Weighted updates |
| TC11 | Edit recalc       | <300ms + audit  | Flag override    |
| TC12 | Remove+Undo       | Totals update   | Logged           |
| TC13 | Currency block    | 400 mismatch    | Picker filters   |
| TC14 | Won prompt        | Only 0 items    | Audit N          |
| TC15 | Closed lock       | 409/422         | Reopen link      |
| TC16 | Picker <400ms     | Paginated       | Keyboard ok      |
| TC17 | Rep 403 catalog   | Owned lines ok  | Unowned 403      |
| TC18 | Tax semantics     | Documented      | Label matches    |
| TC19 | Rounding          | Half-up 2-dec   | Sum exact        |
| TC20 | Bulk 5            | All persist     | No race loss     |
| TC21 | Delete guard      | Block + Archive | Snapshot kept    |
| TC22 | Export            | Rows + totals   | UTF-8 ₹          |

## 9. Troubleshooting & Common Failures

- `400 currency mismatch` on correct currency: deal currency `USD` vs line `usd` case – use uppercase; picker should filter – check `deal.currency` via GET; product currency differs from line override.
- Math off by 1 cent: order is discount-then-tax vs tax-then-discount – verify spec (discount first); frontend rounds per-line vs backend total – compare raw API `lineTotal` vs UI; report rounding rule.
- Duplicate SKU 201 (no 409): unique index case-sensitive – `E2E-PRO-SEAT` vs `e2e-pro-seat` both created – search both, report as bug (should be case-insensitive); cleanup both.
- Line add 404 product: id from wrong env – re-list products on `localhost:3001`; check `isActive:false` hidden from picker but API still allows (or 400 – document).
- Totals not updating after edit: frontend cache – refresh + re-GET `/line-items`; check PATCH actually sent (Network) vs local-only edit without Save.
- `403` adding line as owner: deal owner changed – re-GET owner; line write requires `deals:write` on that deal.
- Archived product still in picker: filter `active=true` missing – verify `GET /api/products?active=true` excludes; report UI filter bug.
- Tax 150% rejected but valid: backend clamps 0-100 – use 28% for tests; document max; if business needs >100, request spec change.
- Delete product 500 with links: missing guard – unlink lines first (delete lines), then delete; attach logs P0.
- INR grouping `188,800` vs `1,88,800`: formatter `en-US` not `en-IN` – check `toLocaleString('en-IN')`; report i18n bug with screenshot.

## 10. Pass/Fail Checklist

- [ ] TC01–TC02 products created UI+API USD/EUR/INR with sku/tax
- [ ] TC03 dup/empty/bad price/tax blocked (400/409+inline)
- [ ] TC04 edit/archive: picker hides archived, snapshots kept, audit logged
- [ ] TC05–TC06 add UI+API 10x1000-10%+18%=10620.00 exact with breakdown
- [ ] TC07 qty 0/neg/abc blocked, decimal/large per spec
- [ ] TC08 discount range enforced, 100%=>0, pct+amt precedence documented
- [ ] TC09 tax override line-only with taxAmt
- [ ] TC10 mismatch banner Sync/Keep works, weighted updates
- [ ] TC11 edit recalcs <300ms + audit + override flag
- [ ] TC12 remove updates totals + logged, Undo if supported
- [ ] TC13 currency mismatch 400s, picker filters, EUR/INR math verified
- [ ] TC14 Won prompt only on 0 items, both paths audited
- [ ] TC15 closed lock 409/422 with reopen link (or documented editable)
- [ ] TC16 picker <400ms paginated keyboard + inline create
- [ ] TC17 Rep 403 catalog, owned lines ok, unowned 403, Viewer read-only
- [ ] TC18 tax exclusive semantics documented, label matches math
- [ ] TC19 rounding half-up, sums exact, no drift
- [ ] TC20 bulk 5 all persist, no race loss
- [ ] TC21 delete blocked with list, archive keeps snapshots
- [ ] TC22 export rows match UI with ₹ preserved (or N/A)
- [ ] All 8 curls executed, trio math verified
- [ ] Regression: deals mismatch/Won, quotes snapshot, approvals discount intact
- [ ] Cleanup: `E2E-*` products/lines/deals removed or archived
- Tester: _______________ Date: _______________ Prod/Deal IDs: _______________ Result: PASS / FAIL
